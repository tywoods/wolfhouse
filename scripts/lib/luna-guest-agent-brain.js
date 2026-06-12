'use strict';

/**
 * Stage 49b — Luna guest Agent Brain v1 (front-of-house reply planner).
 *
 * Sits AFTER the deterministic chain (brain classifier → router → availability →
 * quote → payment choice → composer) and BEFORE final reply selection. It reads
 * the whole conversation + chain truth, builds a tool plan, and either:
 *   - authors the final guest reply in Cami voice (final_reply_source: agent_brain), or
 *   - endorses the existing composer/router reply (fallback_used: true).
 *
 * Hard rules:
 *   - Never invents prices, availability, payment state, or bed assignment —
 *     all facts come from existing chain results/config.
 *   - Never executes writes; booking/payment/send gates stay where they are.
 *   - Authored copy must pass the existing guest copy style contract.
 */

const { resolvePackageExplainerIntent } = require('./luna-guest-package-explainer');
const { buildExplainPackagesReply, FORBIDDEN_GUEST_COPY_RE } = require('./luna-guest-reply-composer');
const { collectPriorExtractedFields } = require('./luna-guest-context-merge');
const { planGuestAgentToolSteps } = require('./luna-guest-agent-tool-plan');
const { isCamiReplyAuthorEnabled } = require('./luna-guest-cami-reply-author');
const { composerOwnedState } = require('./luna-guest-composer-ownership');

const AGENT_FLAG = 'LUNA_GUEST_AGENT_BRAIN_ENABLED';
const AGENT_FLAG_PROD = 'LUNA_GUEST_AGENT_BRAIN_ENABLED_PROD';

const ALREADY_PAID_RE = /\b(?:already paid|i (?:have |just )?paid|payment went through|charged (?:me|my card))\b/i;
const UNPAID_MISMATCH_RE = /\b(?:unpaid|not paid|pending|didn'?t go through|says? (?:i|it).{0,20}(?:unpaid|owe))\b/i;
const REFUND_RE = /\brefund(?:s|ed)?\b/i;
const PAID_BOOKING_RE = /\b(?:paid|payment|deposit)\b/i;
const WANT_ME_TO_EXPLAIN_RE = /\bwant me to (?:explain|go over|walk you through)\b.{0,30}\?/i;

function trimStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function isGuestAgentBrainEnabled(env) {
  const e = env || process.env;
  if (String(e.NODE_ENV || '').toLowerCase() === 'production' && String(e.APP_ENV || '').toLowerCase() !== 'staging') {
    return String(e[AGENT_FLAG_PROD] || '').toLowerCase() === 'true';
  }
  return String(e[AGENT_FLAG] || '').toLowerCase() === 'true';
}

function mergeKnownFields(priorGuestContext, result) {
  const fields = { ...collectPriorExtractedFields(priorGuestContext || {}) };
  const fresh = (result && result.extracted_fields) || {};
  for (const [k, v] of Object.entries(fresh)) {
    if (v !== null && v !== undefined && v !== '') fields[k] = v;
  }
  return fields;
}

function computeMissingFields(fields) {
  const missing = [];
  if (!fields.check_in || !fields.check_out) missing.push('dates');
  if (!fields.guest_count) missing.push('guest_count');
  if (!fields.package_interest && fields.accommodation_only !== true) missing.push('package_or_accommodation');
  return missing;
}

function detectedLanguage(result) {
  const lang = trimStr(result && result.detected_language).toLowerCase();
  return lang || 'en';
}

function resolvePaymentTruth(priorGuestContext, payload) {
  const prior = priorGuestContext || {};
  if (prior.confirmation_sent === true || prior.payment_received === true) {
    return { known: true, status: 'deposit_paid' };
  }
  const truth = prior.payment_truth || prior.live_payment_truth
    || (prior.result && prior.result.payment_truth) || null;
  const status = truth && trimStr(truth.payment_status).toLowerCase();
  if (status === 'paid' || status === 'deposit_paid' || status === 'fully_paid') {
    return { known: true, status };
  }
  const live = payload && payload.result && trimStr(payload.result.payment_status).toLowerCase();
  if (live === 'paid' || live === 'deposit_paid' || live === 'fully_paid') {
    return { known: true, status: live };
  }
  return { known: false, status: null };
}

function classifyAgentIntent(messageText, brainDecision, payload, priorGuestContext) {
  const msg = trimStr(messageText);
  const result = (payload && payload.result) || {};
  const lane = trimStr(result.message_lane);

  if (REFUND_RE.test(msg) && PAID_BOOKING_RE.test(msg)) return 'paid_booking_change';
  if (lane === 'cancel_or_change_request'
    && Array.isArray(result.handoff_reasons)
    && result.handoff_reasons.includes('paid_cancellation_or_reschedule')) {
    return 'paid_booking_change';
  }

  if (ALREADY_PAID_RE.test(msg)
    || (lane === 'payment_question' && ALREADY_PAID_RE.test(msg))) {
    return 'payment_status_question';
  }

  const paymentChoiceReady = payload && payload.payment_choice
    && payload.payment_choice.payment_choice_ready === true;
  const pkgIntent = resolvePackageExplainerIntent(msg, brainDecision);
  if (pkgIntent && !paymentChoiceReady) return 'package_info';

  if (result.greeting_only) return 'greeting';
  if (lane === 'new_booking_inquiry') return 'booking_progress';
  return 'general_question';
}

function buildPaymentStatusReply(paymentTruth) {
  if (paymentTruth.known) {
    return 'Good news — I can see your payment registered on the booking here 🙌 Your confirmation with check-in details is on its way to you in this chat.';
  }
  return 'Thanks for letting me know — I\'m checking the payment status now. If it\'s already gone through, your confirmation will land here shortly. If you have a booking code handy, send it and I\'ll match it up faster 👍';
}

function buildPaidBookingChangeReply() {
  return 'I\'m really sorry about that — refunds and changes on paid bookings are handled personally by our team, so I\'ve passed your message along with the details. Someone from Wolfhouse will get back to you shortly to sort it out 💛';
}

function authoredReplyIsSafe(reply) {
  const text = trimStr(reply);
  if (!text) return false;
  if (FORBIDDEN_GUEST_COPY_RE.test(text)) return false;
  return true;
}

/**
 * Run Agent Brain v1 against a fully-computed orchestrator turn.
 *
 * input: {
 *   client_slug, conversation_id, guest_phone, contact_name,
 *   message_text, prior_guest_context,
 *   brain_decision,          // luna-conversation-brain decision
 *   composed,                // composer integration output ({ reply, composer_state, reply_source }) or null
 *   candidate_reply,         // current proposed reply (composer/router/payment-choice)
 *   candidate_source,        // current final reply source classification
 *   payload,                 // { result, availability, quote, payment_choice, hold_payment_draft_plan, ... }
 *   channel_mode, env,
 * }
 */
function runLunaGuestAgentBrain(input) {
  const inp = input || {};
  const env = inp.env || process.env;
  const enabled = isGuestAgentBrainEnabled(env);
  const payload = inp.payload || {};
  const result = payload.result || {};
  const messageText = trimStr(inp.message_text);

  const base = {
    agent_brain_enabled: enabled,
    intent: null,
    action_plan: [],
    selected_tools: [],
    missing_fields: [],
    final_reply: null,
    final_reply_source: null,
    handoff_required: false,
    handoff_reason: null,
    booking_write_intent: false,
    payment_link_intent: false,
    confirmation_intent: false,
    safety_notes: [],
    fallback_used: true,
  };

  if (!enabled) {
    base.safety_notes.push('agent_brain_disabled');
    return base;
  }

  const fields = mergeKnownFields(inp.prior_guest_context, result);
  const missing = computeMissingFields(fields);
  const intent = classifyAgentIntent(messageText, inp.brain_decision, payload, inp.prior_guest_context);
  const lang = detectedLanguage(result);
  const paymentChoiceReady = payload.payment_choice && payload.payment_choice.payment_choice_ready === true;
  const holdPlanReady = payload.hold_payment_draft_plan
    && payload.hold_payment_draft_plan.plan_status === 'ready';

  base.intent = intent;
  base.missing_fields = missing;
  base.booking_write_intent = paymentChoiceReady === true && holdPlanReady === true;
  base.payment_link_intent = paymentChoiceReady === true;

  const plan = planGuestAgentToolSteps({ intent, payload, missing_fields: missing });
  base.action_plan = plan;
  base.selected_tools = plan.map((s) => s.tool_id);

  // --- Authoring ladder (deterministic v1) ---

  if (intent === 'paid_booking_change' && (lang === 'en' || !lang)) {
    const reply = buildPaidBookingChangeReply();
    if (authoredReplyIsSafe(reply)) {
      base.final_reply = reply;
      base.final_reply_source = 'agent_brain';
      base.handoff_required = true;
      base.handoff_reason = 'paid_booking_refund_or_change';
      base.fallback_used = false;
      return base;
    }
    base.safety_notes.push('authored_reply_failed_style_contract');
  }

  if (intent === 'payment_status_question' && (lang === 'en' || !lang)) {
    const paymentTruth = resolvePaymentTruth(inp.prior_guest_context, payload);
    const reply = buildPaymentStatusReply(paymentTruth);
    if (authoredReplyIsSafe(reply)) {
      base.final_reply = reply;
      base.final_reply_source = 'agent_brain';
      base.handoff_required = false;
      base.handoff_reason = null;
      base.confirmation_intent = true;
      base.fallback_used = false;
      base.safety_notes.push(paymentTruth.known
        ? 'payment_truth_from_context'
        : 'payment_status_check_auto_confirmation');
      return base;
    }
    base.safety_notes.push('authored_reply_failed_style_contract');
  }

  if (intent === 'package_info') {
    // Composer (+ optional Cami) owns package explain when enabled — avoid duplicate voices.
    if (isCamiReplyAuthorEnabled(env) || (inp.composed && inp.composed.covered)) {
      base.fallback_used = true;
      base.safety_notes.push('package_info_deferred_to_cami_pipeline');
      return base;
    }
    const pkgIntent = resolvePackageExplainerIntent(messageText, inp.brain_decision) || 'overview';
    const reply = buildExplainPackagesReply(lang, pkgIntent, fields);
    if (authoredReplyIsSafe(reply)) {
      base.final_reply = reply;
      base.final_reply_source = 'agent_brain';
      base.fallback_used = false;
      base.safety_notes.push('package_facts_from_config');
      return base;
    }
    base.safety_notes.push('authored_reply_failed_style_contract');
  }

  // Repair known-dumb candidate copy: never ask "want me to explain?" when the
  // guest already asked for an explanation.
  const candidate = trimStr(inp.candidate_reply);
  if (candidate && WANT_ME_TO_EXPLAIN_RE.test(candidate)) {
    const pkgIntent = resolvePackageExplainerIntent(messageText, inp.brain_decision);
    if (pkgIntent) {
      const reply = buildExplainPackagesReply(lang, pkgIntent, fields);
      if (authoredReplyIsSafe(reply)) {
        base.final_reply = reply;
        base.final_reply_source = 'agent_brain';
        base.fallback_used = false;
        base.safety_notes.push('repaired_redundant_explain_offer');
        return base;
      }
    }
  }

  // Endorse the existing composer/router/payment-choice reply: it carries
  // grounded quote/payment/link facts the agent must not re-author.
  base.fallback_used = true;
  base.safety_notes.push('endorsed_existing_reply');
  return base;
}

function buildGuestAgentBrainObservability(agentOutput) {
  const a = agentOutput || {};
  return {
    agent_brain_enabled: a.agent_brain_enabled === true,
    agent_intent: a.intent || null,
    agent_action_plan: Array.isArray(a.action_plan)
      ? a.action_plan.map((s) => ({ tool_id: s.tool_id, reason: s.reason, current_status: s.current_status }))
      : [],
    agent_final_reply_source: a.fallback_used === true ? null : (a.final_reply_source || null),
    agent_fallback_used: a.fallback_used === true,
    agent_tool_calls: Array.isArray(a.selected_tools) ? a.selected_tools : [],
    agent_safety_notes: Array.isArray(a.safety_notes) ? a.safety_notes : [],
    agent_handoff_required: a.handoff_required === true,
    agent_handoff_reason: a.handoff_reason || null,
    agent_booking_write_intent: a.booking_write_intent === true,
    agent_payment_link_intent: a.payment_link_intent === true,
    agent_confirmation_intent: a.confirmation_intent === true,
    agent_missing_fields: Array.isArray(a.missing_fields) ? a.missing_fields : [],
  };
}

module.exports = {
  isGuestAgentBrainEnabled,
  runLunaGuestAgentBrain,
  buildGuestAgentBrainObservability,
  AGENT_FLAG,
};
