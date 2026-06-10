'use strict';

/**
 * Stage 27u — Guest automation orchestrator (dry-run only).
 *
 * Applies Stage 27t automation gate, then routes through existing 27b–27m helpers.
 * No public inbound WhatsApp, no live send, no writes, Stripe, Meta, or n8n.
 *
 * Does NOT call: 27n write, 27o Stripe link, 27p payment truth, 27q preview, 27r/27s send.
 */

const {
  runLunaGuestMessageRouterDryRun,
  detectNewBookingResetIntent,
  buildNewBookingResetReply,
  hasSubstantiveNewBookingDetailsAfterReset,
  resolveActiveIntakeMissingField,
  conversationIntakeInProgress,
  buildAccommodationOnlyAck,
} = require('./luna-guest-message-router');
const { decideConversationActionAsync, detectAccommodationOnlyAnswer } = require('./luna-conversation-brain');
const { runGuestAvailabilityDryRun, buildGuestAvailabilitySkippedResponse, shouldAttemptGuestAvailability } = require('./luna-guest-availability-dry-run');
const { runGuestQuoteProposalDryRun } = require('./luna-guest-quote-proposal-dry-run');
const {
  runGuestPaymentChoiceDryRun,
  shouldAttemptGuestPaymentChoiceWire,
  buildPaymentChoiceWireContext,
  buildGuestPaymentChoiceSkippedResponse,
  sanitizeLunaGuestReply,
  buildPaymentChoiceNotReadyReply,
} = require('./luna-guest-payment-choice-dry-run');
const {
  runGuestHoldPaymentDraftPlannerDryRun,
} = require('./luna-guest-hold-payment-draft-planner');
const {
  normalizeGuestContextForChain,
  stripQuotePaymentStateForReset,
  buildHoldPaymentDraftPlannerChain,
  mergeActiveBookingChainOutput,
  collectPriorExtractedFields,
} = require('./luna-guest-context-merge');
const { detectPackageExplainerIntent } = require('./luna-guest-package-explainer');
const {
  computeStayNights,
  isAccommodationOnlyIntent,
  buildShortStayAccommodationConfirmReply,
  buildShortStayAccommodationPendingReply,
} = require('./wolfhouse-package-night-rules');
const {
  detectServiceSideQuestionIntent,
  detectTransferSideQuestionIntent,
  buildServiceSideQuestionReply,
  buildTransferSideQuestionReply,
} = require('./luna-guest-service-transfer-explainer');
const { composeLunaGuestReply } = require('./luna-guest-reply-composer');

const DEFAULT_CLIENT = 'wolfhouse-somo';

const SUPPORTED_CLIENT_SLUGS = new Set([DEFAULT_CLIENT]);
const SUPPORTED_CHANNELS = new Set(['whatsapp', 'dry_run', 'harness', 'staff_review']);

const REUSED_CHAIN_HELPERS = Object.freeze([
  'runLunaGuestMessageRouterDryRun (27b/27e)',
  'runGuestAvailabilityDryRun (27g)',
  'runGuestQuoteProposalDryRun (27i)',
  'runGuestPaymentChoiceDryRun (27k)',
  'runGuestHoldPaymentDraftPlannerDryRun (27m)',
]);

const VALID_PROPOSED_NEXT_ACTIONS = Object.freeze([
  'ask_missing_details',
  'show_availability_quote',
  'collect_payment_choice',
  'prepare_hold_payment_draft_plan',
  'await_staff_accommodation_confirmation',
  'await_guest_reply',
  'staff_handoff_required',
  'automation_blocked',
]);

const ORCHESTRATOR_SAFETY = Object.freeze({
  dry_run: true,
  preview_only: true,
  no_write_performed: true,
  sends_whatsapp: false,
  live_send_blocked: true,
  whatsapp_sent: false,
  calls_n8n: false,
  creates_booking: false,
  creates_payment: false,
  creates_stripe_link: false,
  payment_link_sent: false,
  creates_hold: false,
  confirmation_send_allowed: false,
});

const NON_BOOKING_LANES = new Set([
  'existing_booking_question',
  'add_service_request',
  'transfer_request',
  'payment_question',
  'checkin_house_info_question',
  'cancel_or_change_request',
  'general_question',
  'staff_handoff_required',
]);

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

const LUNA_INTRO_RE = /(?:Hi|Hey|Hola|Ciao|Bonjour|Hallo)[!,.]?\s+(?:I'?m|Soy|Sono|Je suis|Ich bin)\s+Luna\s+from\s+Wolfhouse\s*🌊\s*(?:—\s*)?/gi;

/**
 * Stage 28j.2 — final reply cleanup. Mid-flow replies must never repeat the
 * "Hi/Hey, I'm Luna from Wolfhouse" intro. Only the first greeting/fresh turn keeps it.
 *
 * @param {string} reply
 * @param {boolean} allowLeadingIntro  true only for greeting / fresh-conversation turns
 */
function dedupeLunaIntro(reply, allowLeadingIntro) {
  if (!reply) return reply;
  let out = String(reply);
  if (allowLeadingIntro) {
    // Keep a single leading intro; strip any later/duplicate occurrences.
    const m = out.match(LUNA_INTRO_RE);
    if (m && m.length > 1) {
      let seenFirst = false;
      out = out.replace(LUNA_INTRO_RE, (frag) => {
        if (!seenFirst) { seenFirst = true; return frag; }
        return '';
      });
    }
    return out.replace(/\s{2,}/g, ' ').trim();
  }
  // Mid-flow: strip every intro fragment.
  out = out.replace(LUNA_INTRO_RE, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Stage 28j.2 — detect a persistent short-stay accommodation-only hold.
 * True when prior context shows accommodation-only intent for an under-7-night stay.
 */
function inShortStayAccommodationHold(guestContext) {
  const ctx = guestContext || {};
  const quote = ctx.quote || {};
  // Stage 28j.4 — once accommodation is quoted, normal quote/add-ons/payment flow applies.
  if (quote.quote_status === 'ready') return false;
  const prior = collectPriorExtractedFields(ctx);
  const nights = computeStayNights(prior.check_in, prior.check_out);
  const shortStayIntakeComplete = nights != null && nights < 7
    && prior.guest_count != null && prior.guest_count >= 1
    && prior.check_in && prior.check_out
    && isAccommodationOnlyIntent(prior.package_interest);
  // Complete short-stay intake quotes via Staff Portal pricing — no staff hold.
  if (shortStayIntakeComplete) return false;
  const rule = ctx.package_night_rule
    || (ctx.result && ctx.result.package_night_rule)
    || null;
  if (rule === 'short_stay_accommodation') {
    if (isAccommodationOnlyIntent(prior.package_interest)) return true;
  }
  return isAccommodationOnlyIntent(prior.package_interest) && nights != null && nights < 7;
}

function shortStayAddonsAnswered(messageText, brainDecision) {
  return (brainDecision && brainDecision.intent === 'accommodation_only_choice')
    || detectAccommodationOnlyAnswer(messageText);
}

/** Prior turn already declined add-ons / chose accommodation-only for a short stay. */
function shortStayAddonsAlreadyAnswered(guestContext, messageText, brainDecision) {
  const priorQuote = (guestContext || {}).quote || {};
  if (priorQuote.quote_status === 'ready' && priorQuote.short_stay_addons_pending === false) {
    return true;
  }
  const prior = collectPriorExtractedFields(guestContext);
  if (!isAccommodationOnlyIntent(prior.package_interest)) return false;
  const nights = computeStayNights(prior.check_in, prior.check_out);
  if (nights == null || nights >= 7 || prior.guest_count == null || prior.guest_count < 1) {
    return false;
  }
  return !shortStayAddonsAnswered(messageText, brainDecision);
}

/** Guest is pushing toward payment ("deposit"/"full"/"pay now"). */
function looksLikePaymentPush(text) {
  const t = trimStr(text).toLowerCase();
  if (!t) return false;
  return /\b(?:deposit|full amount|pay (?:the )?(?:deposit|full|now)|full payment|acconto|pago completo|anzahlung|acompte)\b/i.test(t)
    || /^(?:deposit|full)$/i.test(t);
}

/** Guest asks "when"/"how" about a pending next step. */
function looksLikeWhenQuestion(text) {
  const t = trimStr(text).toLowerCase();
  if (!t) return false;
  return /\b(?:when|how long|how soon|what.?s next|next step|wann|quand|cuándo|cuando|quando)\b/i.test(t);
}

/**
 * Stage 28j.2 — conversation-control reply types whose router reply is authoritative.
 * These must never be overridden by payment-choice/quote templates.
 */
const BRAIN_AUTHORITATIVE_REPLY_TYPES = new Set([
  'accommodation_only_ack', 'correction_ack', 'clarify', 'package_explainer',
  'package_recommendation', 'short_stay_guidance', 'reset_prompt',
]);
const BRAIN_AUTHORITATIVE_INTENTS = new Set([
  'accommodation_only_choice', 'guest_correction', 'side_question', 'package_undecided',
  'reset_new_booking', 'clarify',
]);

/**
 * Stage 28j.2 — Part C observability. Surfaces whether the smart brain was used,
 * which model, any error, and whether a downstream module overrode the brain reply.
 */
function buildBrainObservability(brainDecision, extra) {
  const b = brainDecision || {};
  const x = extra || {};
  return {
    intent: b.intent || null,
    reply_type: b.reply_type || null,
    source: b.source || null,
    brain_enabled: b.brain_enabled === true,
    llm_enabled: b.llm_enabled === true,
    model_requested: b.model_requested || null,
    model_used: b.model_used || null,
    llm_error: b.llm_error || null,
    brain_intent: b.intent || null,
    brain_reply_type: b.reply_type || null,
    guest_is_correcting_luna: b.guest_is_correcting_luna === true,
    accommodation_only_choice: b.intent === 'accommodation_only_choice',
    next_best_action: b.next_best_action || null,
    confidence: b.confidence != null ? b.confidence : null,
    final_reply_source: x.finalReplySource || null,
    final_reply_overrode_brain: x.overrodeBrain === true,
    composer_state: x.composer_state || null,
  };
}

function brainControlsReply(brainDecision, result, quote) {
  if (result && result.package_night_rule === 'short_stay_accommodation') {
    // Stage 28j.4 — once accommodation is quoted, payment/add-ons replies take over.
    if (quote && quote.quote_status === 'ready') return false;
    return true;
  }
  if (result && (result.package_night_rule === 'short_stay_guidance'
    || result.package_night_rule === 'weekly_package_blocked'
    || result.package_night_rule === 'weekly_explain_before_choice')) {
    return true;
  }
  if (!brainDecision) return false;
  return BRAIN_AUTHORITATIVE_REPLY_TYPES.has(brainDecision.reply_type)
    || BRAIN_AUTHORITATIVE_INTENTS.has(brainDecision.intent);
}

function mergeGateContext(input, context) {
  const inpGate = (input && input.automation_gate_context) || {};
  const ctxGate = (context && context.automation_gate_context) || {};
  return { ...ctxGate, ...inpGate };
}

function isDryRunEvaluationRequested(input, context) {
  if (input && input.dry_run === true) return true;
  if (context && context.dry_run === true) return true;
  return true;
}

/**
 * Stage 27t gate evaluation for orchestrator dry-run.
 */
function evaluateAutomationGate(input, context) {
  const gateCtx = mergeGateContext(input, context);
  const reasons = [];
  const clientSlug = trimStr(input && input.client_slug) || DEFAULT_CLIENT;
  const channel = trimStr(input && input.channel).toLowerCase() || 'whatsapp';
  const dryRunEval = isDryRunEvaluationRequested(input, context);
  const publicEnabled = gateCtx.public_guest_automation_enabled === true;
  const requestLiveSend = gateCtx.request_live_send === true
    || (input && input.request_live_send === true);

  if (!trimStr(input && input.client_slug)) {
    reasons.push('missing_client_slug');
  } else if (!SUPPORTED_CLIENT_SLUGS.has(clientSlug)) {
    reasons.push('unsupported_client_slug');
  }

  if (!SUPPORTED_CHANNELS.has(channel)) {
    reasons.push('unsupported_channel');
  }

  if (gateCtx.is_owner_or_staff === true) {
    reasons.push('owner_or_staff_route');
  }

  if (gateCtx.bot_paused === true) {
    reasons.push('bot_paused');
  }

  if (gateCtx.human_takeover === true) {
    reasons.push('human_takeover');
  }

  if (!publicEnabled && !dryRunEval) {
    reasons.push('public_guest_automation_disabled');
  }

  if (requestLiveSend && gateCtx.live_send_allowed !== true) {
    reasons.push('live_send_not_explicitly_allowed');
  }

  if (requestLiveSend && gateCtx.whatsapp_dry_run !== false && gateCtx.live_send_allowed === true) {
    if (gateCtx.allowlisted_phone == null || trimStr(gateCtx.allowlisted_phone) === '') {
      reasons.push('live_send_allowlist_missing');
    }
  }

  if (gateCtx.unsafe_gate_context === true) {
    reasons.push('unsafe_gate_context');
  }

  if (reasons.length === 0) {
    return {
      gate_status: 'allowed_dry_run',
      gate_reasons: [],
      dry_run_evaluation: dryRunEval,
      public_guest_automation_enabled: publicEnabled,
    };
  }

  const staffHandoff = reasons.some((r) => r === 'bot_paused' || r === 'human_takeover');
  return {
    gate_status: staffHandoff ? 'staff_handoff_required' : 'blocked',
    gate_reasons: reasons,
    dry_run_evaluation: dryRunEval,
    public_guest_automation_enabled: publicEnabled,
  };
}

function buildGateBlockedReply(gate) {
  if (gate.gate_status === 'staff_handoff_required') {
    return "Thanks for your message — Luna is paused or our team is helping on this thread. Someone from Wolfhouse will follow up soon.";
  }
  if (gate.gate_reasons.includes('owner_or_staff_route')) {
    return 'This number is routed to staff tools — guest automation is not applied here.';
  }
  return 'Guest automation is not available for this request right now. Our team can help if needed.';
}

function resolveProposedNextAction(payload) {
  const {
    gate,
    result,
    availability,
    quote,
    payment_choice: pc,
    hold_payment_draft_plan: plan,
  } = payload;

  if (result && result.greeting_only) {
    return 'await_guest_reply';
  }

  if (result && result.new_booking_reset) {
    return 'ask_missing_details';
  }

  if (gate && gate.gate_status !== 'allowed_dry_run') {
    return gate.gate_status === 'staff_handoff_required'
      ? 'staff_handoff_required'
      : 'automation_blocked';
  }

  if (!result) return 'automation_blocked';

  if (plan && plan.plan_status === 'ready') {
    return 'prepare_hold_payment_draft_plan';
  }

  if (pc && pc.payment_choice_ready) {
    return 'prepare_hold_payment_draft_plan';
  }

  if (quote && quote.quote_status === 'ready' && pc && !pc.payment_choice_ready) {
    return 'collect_payment_choice';
  }

  const chainProgress = (pc && pc.payment_choice_ready)
    || (quote && quote.quote_status === 'ready')
    || (plan && plan.plan_status === 'ready');

  const availHandoffBlocks = availability && availability.availability_handoff_required
    && !(result.package_night_rule === 'short_stay_accommodation'
      && quote && quote.quote_status === 'ready');
  if (!chainProgress && (
    result.safe_handoff_required
    || result.message_lane === 'staff_handoff_required'
    || availHandoffBlocks
    || (quote && quote.quote_handoff_required)
    || (plan && plan.plan_handoff_required)
  )) {
    return 'staff_handoff_required';
  }

  if (quote && quote.quote_proposal_attempted) {
    return 'show_availability_quote';
  }

  if (availability && availability.availability_check_attempted) {
    return 'show_availability_quote';
  }

  if (result.message_lane === 'new_booking_inquiry'
    && (result.readiness_state === 'collecting_required_details'
      || (result.missing_required_fields && result.missing_required_fields.length > 0))) {
    return 'ask_missing_details';
  }

  if (NON_BOOKING_LANES.has(result.message_lane)) {
    return result.safe_handoff_required ? 'staff_handoff_required' : 'ask_missing_details';
  }

  return 'ask_missing_details';
}

function sanitizeReply(text, fallbackCtx, detected) {
  const lang = (fallbackCtx && fallbackCtx.result && fallbackCtx.result.detected_language) || 'en';
  const fallback = buildPaymentChoiceNotReadyReply(lang, fallbackCtx || {}, detected ?? null);
  return sanitizeLunaGuestReply(text, fallback);
}

/** Stage 28j.6 — try centralized booking reply composer before legacy templates. */
function tryComposeBookingReply(payload, messageText, priorGuestContext, brainDecision, opts) {
  const o = opts || {};
  const composed = composeLunaGuestReply({
    payload,
    message_text: messageText,
    prior_guest_context: priorGuestContext,
    brain_decision: brainDecision,
    mode: o.mode || 'orchestrator',
    allow_leading_intro: o.allowLeadingIntro === true,
    live_outcomes: o.liveOutcomes,
  });
  if (composed && composed.covered && composed.reply) {
    return composed;
  }
  return null;
}

function shouldPreferRouterReply(result) {
  if (!result) return false;
  if (result.booking_intake_ready === false) return true;
  if (result.readiness_state === 'collecting_required_details') return true;
  return false;
}

function shouldUsePaymentChoiceReply(pc, quote) {
  if (!pc || !pc.proposed_luna_reply) return false;
  if (pc.payment_choice_capture_attempted === true) return true;
  if (pc.payment_choice_detected === true) return true;
  if (pc.payment_choice_ready === true) return true;
  const quoteReadyForChoice = quote
    && quote.quote_status === 'ready'
    && quote.payment_choice_needed === true;
  if (quoteReadyForChoice) {
    const relevantAfterQuote = new Set([
      'collect_payment_choice',
      'ready_for_hold_payment_draft',
      'answer_arrival_payment_question',
    ]);
    if (relevantAfterQuote.has(pc.next_safe_step)) return true;
  }
  return false;
}

function resolveProposedReply(payload, messageText, priorGuestContext, brainDecision) {
  const {
    hold_payment_draft_plan: plan,
    payment_choice: pc,
    quote,
    availability,
    result,
    gate,
  } = payload;

  if (gate && gate.gate_status !== 'allowed_dry_run') {
    return buildGateBlockedReply(gate);
  }

  if (result && result.greeting_only && result.proposed_luna_reply) {
    return sanitizeReply(result.proposed_luna_reply, { result, quote, availability }, null);
  }

  const fallbackCtx = { result, quote, availability };

  // Stage 28j.4 — short-stay accommodation quote (price + add-ons question) wins over
  // the router "checking" placeholder once pricing is ready.
  if (quote && quote.quote_status === 'ready' && quote.proposed_luna_reply && quote.short_stay_addons_pending) {
    return sanitizeReply(quote.proposed_luna_reply, fallbackCtx, pc && pc.payment_choice);
  }

  const sideQuestionText = messageText != null ? String(messageText).trim() : '';
  const priorFields = collectPriorExtractedFields(priorGuestContext);
  const sideQuestionLang = (result && result.detected_language) || 'en';
  const quoteReadyForSideQuestion = quote && quote.quote_status === 'ready';

  if (sideQuestionText && looksLikeWhenQuestion(sideQuestionText)
    && result && result.proposed_luna_reply && result.message_lane === 'new_booking_inquiry') {
    if (priorFields.check_in && priorFields.check_out && priorFields.guest_count != null) {
      return sanitizeReply(result.proposed_luna_reply, fallbackCtx, pc && pc.payment_choice);
    }
  }

  if (sideQuestionText && detectPackageExplainerIntent(sideQuestionText) && result && result.proposed_luna_reply) {
    return sanitizeReply(result.proposed_luna_reply, fallbackCtx, pc && pc.payment_choice);
  }

  if (sideQuestionText && quoteReadyForSideQuestion) {
    const transferIntent = detectTransferSideQuestionIntent(sideQuestionText)
      || (result && result.message_lane === 'transfer_request' ? 'transfer_general' : null);
    if (transferIntent) {
      return sanitizeReply(
        buildTransferSideQuestionReply(sideQuestionLang, sideQuestionText, {
          packageInterest: priorFields.package_interest,
          guestCount: priorFields.guest_count,
        }),
        fallbackCtx,
        pc && pc.payment_choice,
      );
    }

    const serviceIntent = detectServiceSideQuestionIntent(sideQuestionText)
      || (result && result.message_lane === 'add_service_request' ? 'services_general' : null);
    if (serviceIntent) {
      return sanitizeReply(
        buildServiceSideQuestionReply(sideQuestionLang, serviceIntent, sideQuestionText),
        fallbackCtx,
        pc && pc.payment_choice,
      );
    }
  }

  if (shouldUsePaymentChoiceReply(pc, quote)) {
    return sanitizeReply(pc.proposed_luna_reply, fallbackCtx, pc && pc.payment_choice);
  }

  // Stage 28j.2 — when the conversation brain has a clear conversation-control
  // decision (accommodation-only ack, correction, clarify, side question, short-stay
  // package rule), the router reply is authoritative. Old payment-choice / quote
  // templates must not override it.
  if (brainControlsReply(brainDecision, result, quote) && result && result.proposed_luna_reply) {
    return sanitizeReply(result.proposed_luna_reply, fallbackCtx, pc && pc.payment_choice);
  }

  if (plan && plan.plan_status === 'ready' && plan.proposed_luna_reply) {
    return sanitizeReply(plan.proposed_luna_reply, fallbackCtx, pc && pc.payment_choice);
  }

  if (shouldPreferRouterReply(result) && result.proposed_luna_reply) {
    return sanitizeReply(result.proposed_luna_reply, fallbackCtx, pc && pc.payment_choice);
  }

  if (availability && availability.availability_status === 'not_ready' && result && result.proposed_luna_reply) {
    return sanitizeReply(result.proposed_luna_reply, fallbackCtx, pc && pc.payment_choice);
  }

  if (quote && quote.quote_status === 'not_ready') {
    if (availability && availability.proposed_luna_reply) {
      return sanitizeReply(availability.proposed_luna_reply, fallbackCtx, pc && pc.payment_choice);
    }
    if (result && result.proposed_luna_reply) {
      return sanitizeReply(result.proposed_luna_reply, fallbackCtx, pc && pc.payment_choice);
    }
  }

  if (shouldUsePaymentChoiceReply(pc, quote)) {
    return sanitizeReply(pc.proposed_luna_reply, fallbackCtx, pc.payment_choice);
  }

  if (plan && plan.proposed_luna_reply) {
    return sanitizeReply(plan.proposed_luna_reply, fallbackCtx, pc && pc.payment_choice);
  }
  if (quote && quote.proposed_luna_reply) {
    return sanitizeReply(quote.proposed_luna_reply, fallbackCtx, pc && pc.payment_choice);
  }
  if (availability && availability.proposed_luna_reply) {
    return sanitizeReply(availability.proposed_luna_reply, fallbackCtx, pc && pc.payment_choice);
  }
  if (result && result.proposed_luna_reply) {
    return sanitizeReply(result.proposed_luna_reply, fallbackCtx, pc && pc.payment_choice);
  }
  return "Hi! I'm Luna from Wolfhouse 🌊 — thanks for your message.";
}

/** Stage 28j.2 — best-effort source label for the final reply (observability). */
function classifyFinalReplySource(finalReply, payload) {
  const norm = (v) => (v == null ? '' : String(v).trim());
  const f = norm(finalReply);
  if (!f) return 'fallback';
  const r = payload.result || {};
  const pc = payload.payment_choice || {};
  const q = payload.quote || {};
  const av = payload.availability || {};
  const plan = payload.hold_payment_draft_plan || {};
  if (r.proposed_luna_reply && f.includes(norm(r.proposed_luna_reply))) return 'router';
  if (pc.proposed_luna_reply && f === norm(pc.proposed_luna_reply)) return 'payment_choice';
  if (plan.proposed_luna_reply && f === norm(plan.proposed_luna_reply)) return 'plan';
  if (q.proposed_luna_reply && f === norm(q.proposed_luna_reply)) return 'quote';
  if (av.proposed_luna_reply && f === norm(av.proposed_luna_reply)) return 'availability';
  return 'composed';
}

function buildOrchestratorResponse(parts) {
  const gate = parts.automation_gate;
  const publicEnabled = gate.public_guest_automation_enabled === true;

  return {
    success: true,
    ...ORCHESTRATOR_SAFETY,
    dry_run: true,
    public_guest_automation_enabled: publicEnabled,
    automation_gate: {
      gate_status: gate.gate_status,
      gate_reasons: gate.gate_reasons,
    },
    result: parts.result ?? null,
    availability: parts.availability ?? null,
    quote: parts.quote ?? null,
    payment_choice: parts.payment_choice ?? null,
    hold_payment_draft_plan: parts.hold_payment_draft_plan ?? null,
    proposed_next_action: parts.proposed_next_action,
    proposed_luna_reply: parts.proposed_luna_reply,
    reused_chain_helpers: [...REUSED_CHAIN_HELPERS],
  };
}

function buildNonBookingLaneResponse(result, gate, messageText, brainDecision) {
  const payload = {
    gate,
    result,
    availability: null,
    quote: null,
    payment_choice: null,
    hold_payment_draft_plan: null,
    proposed_next_action: resolveProposedNextAction({ gate, result }),
  };
  const allowIntro = (brainDecision && brainDecision.intent === 'greeting')
    || (result && result.greeting_only === true);
  const composed = tryComposeBookingReply(
    payload,
    messageText,
    null,
    brainDecision,
    { allowLeadingIntro: allowIntro },
  );
  const proposedLunaReply = composed
    ? composed.reply
    : resolveProposedReply(payload, messageText, null, brainDecision);
  const finalReplySource = composed
    ? composed.reply_source
    : classifyFinalReplySource(proposedLunaReply, payload);
  const resultWithBrain = {
    ...result,
    conversation_brain: buildBrainObservability(brainDecision, {
      finalReplySource,
      overrodeBrain: false,
      composer_state: composed ? composed.composer_state : null,
    }),
  };
  return buildOrchestratorResponse({
    automation_gate: gate,
    result: resultWithBrain,
    availability: null,
    quote: null,
    payment_choice: null,
    hold_payment_draft_plan: null,
    proposed_next_action: payload.proposed_next_action,
    proposed_luna_reply: dedupeLunaIntro(proposedLunaReply, allowIntro === true),
  });
}

/**
 * Run guest automation orchestrator dry-run.
 *
 * @param {object} input
 * @param {object} [context]
 */
async function runGuestAutomationOrchestratorDryRun(input, context) {
  const inp = input || {};
  const ctx = context || {};
  const gate = evaluateAutomationGate(inp, ctx);

  if (gate.gate_status !== 'allowed_dry_run') {
    return buildOrchestratorResponse({
      automation_gate: gate,
      result: null,
      availability: null,
      quote: null,
      payment_choice: null,
      hold_payment_draft_plan: null,
      proposed_next_action: resolveProposedNextAction({ gate }),
      proposed_luna_reply: buildGateBlockedReply(gate),
    });
  }

  let chainGuestContext = normalizeGuestContextForChain(inp.guest_context);

  const routerContext = {
    reference_date: inp.reference_date || ctx.reference_date,
    language_hint: inp.language_hint,
    client_slug: trimStr(inp.client_slug) || DEFAULT_CLIENT,
  };

  const messageText = trimStr(inp.message_text);

  // Stage 28j — smart LLM conversation brain in the hot path. The async decision uses
  // the configured LLM only when LUNA_CONVERSATION_BRAIN_LLM_ENABLED=true outside
  // production; otherwise (or on failure/timeout) it is the deterministic decision.
  // The brain only classifies/plans — every action below stays deterministic + gated.
  const brainEnv = ctx.env || process.env;
  const priorPackageNightRule = chainGuestContext.package_night_rule
    || (chainGuestContext.result && chainGuestContext.result.package_night_rule)
    || null;
  const brainDecision = await decideConversationActionAsync(
    {
      message_text: messageText,
      guest_context: chainGuestContext,
      prior_extracted_fields: collectPriorExtractedFields(chainGuestContext),
      active_missing_field: resolveActiveIntakeMissingField(chainGuestContext),
      in_active_booking: conversationIntakeInProgress(chainGuestContext),
      in_short_stay_flow: priorPackageNightRule === 'short_stay_guidance'
        || priorPackageNightRule === 'short_stay_accommodation'
        || priorPackageNightRule === 'weekly_package_blocked',
      last_luna_reply: (chainGuestContext.result && chainGuestContext.result.proposed_luna_reply) || null,
      package_night_rule: priorPackageNightRule,
      env: brainEnv,
    },
    { llmClient: ctx.brain_llm_client },
  );

  let result = runLunaGuestMessageRouterDryRun(
    {
      message_text: messageText,
      language_hint: inp.language_hint,
      guest_context: chainGuestContext,
      brain_decision: brainDecision,
    },
    routerContext,
  );

  if (result.greeting_only) {
    return buildNonBookingLaneResponse(result, gate, messageText, brainDecision);
  }

  if (detectNewBookingResetIntent(messageText) && shouldAttemptGuestPaymentChoiceWire(chainGuestContext)) {
    chainGuestContext = stripQuotePaymentStateForReset(chainGuestContext);
    result = runLunaGuestMessageRouterDryRun(
      {
        message_text: messageText,
        language_hint: inp.language_hint,
        guest_context: chainGuestContext,
      },
      routerContext,
    );
    result = { ...result, new_booking_reset: true };

    if (!hasSubstantiveNewBookingDetailsAfterReset(result)) {
      const resetReply = buildNewBookingResetReply(result.detected_language || 'en');
      return buildOrchestratorResponse({
        automation_gate: gate,
        result: {
          ...result,
          message_lane: 'new_booking_inquiry',
          intake_state: 'inquiry_received',
          readiness_state: 'collecting_required_details',
          booking_intake_ready: false,
          extracted_fields: {},
          new_booking_reset: true,
        },
        availability: null,
        quote: { quote_status: 'not_ready', payment_choice_needed: false },
        payment_choice: {
          success: true,
          payment_choice_capture_attempted: false,
          payment_choice_detected: false,
          payment_choice: null,
          payment_choice_ready: false,
          payment_choice_reasons: ['new_booking_reset'],
          next_safe_step: 'not_ready',
          proposed_luna_reply: resetReply,
        },
        hold_payment_draft_plan: null,
        proposed_next_action: 'ask_missing_details',
        proposed_luna_reply: resetReply,
      });
    }
  }

  const bookingContinuation = shouldAttemptGuestPaymentChoiceWire(chainGuestContext);

  // Stage 28j.2 — short-stay accommodation-only hold: once the guest has chosen
  // accommodation-only for an under-7-night stay, no weekly package / quote / payment
  // path applies. Answer payment pushes and "when?" questions contextually instead of
  // re-asking deposit/full or handing off.
  if (inShortStayAccommodationHold(chainGuestContext)
    && brainDecision.reset_context !== true
    && !detectNewBookingResetIntent(messageText)) {
    const isPaymentPush = looksLikePaymentPush(messageText);
    const isWhen = looksLikeWhenQuestion(messageText);
    const stillShortStayThisTurn = result.package_night_rule === 'short_stay_accommodation'
      || result.message_lane !== 'new_booking_inquiry';
    if ((isPaymentPush || isWhen) && stillShortStayThisTurn) {
      const lang = result.detected_language || 'en';
      const pendingReply = buildShortStayAccommodationPendingReply(lang);
      const heldResult = {
        ...result,
        message_lane: 'new_booking_inquiry',
        intake_state: 'collecting_required_details',
        readiness_state: 'collecting_required_details',
        booking_intake_ready: false,
        safe_handoff_required: false,
        handoff_reasons: [],
        package_night_rule: 'short_stay_accommodation',
        extracted_fields: collectPriorExtractedFields(chainGuestContext),
        proposed_luna_reply: pendingReply,
        conversation_brain: buildBrainObservability(brainDecision, {
          finalReplySource: 'short_stay_accommodation_pending',
          overrodeBrain: false,
        }),
      };
      return buildOrchestratorResponse({
        automation_gate: gate,
        result: heldResult,
        availability: buildGuestAvailabilitySkippedResponse(heldResult),
        quote: { quote_status: 'not_ready', payment_choice_needed: false },
        payment_choice: buildGuestPaymentChoiceSkippedResponse({}),
        hold_payment_draft_plan: null,
        proposed_next_action: 'await_staff_accommodation_confirmation',
        proposed_luna_reply: dedupeLunaIntro(pendingReply, false),
      });
    }
  }

  if (result.message_lane !== 'new_booking_inquiry' && !bookingContinuation) {
    return buildNonBookingLaneResponse(result, gate, messageText, brainDecision);
  }

  const chainCtx = {
    client_slug: trimStr(inp.client_slug) || DEFAULT_CLIENT,
    pg: ctx.pg || null,
  };

  let availability;
  if (shouldAttemptGuestAvailability(result)) {
    availability = await runGuestAvailabilityDryRun(result, chainCtx);
  } else {
    availability = buildGuestAvailabilitySkippedResponse(result);
  }

  let quote = runGuestQuoteProposalDryRun(result, availability, chainCtx);

  const priorQuote = chainGuestContext.quote || {};
  if (shortStayAddonsAlreadyAnswered(chainGuestContext, messageText, brainDecision)) {
    quote = {
      ...quote,
      short_stay_addons_pending: false,
      payment_choice_needed: quote.quote_status === 'ready',
    };
  } else {
    const addonsPending = quote.short_stay_addons_pending === true
      || priorQuote.short_stay_addons_pending === true;
    if (addonsPending && shortStayAddonsAnswered(messageText, brainDecision)) {
      quote = {
        ...quote,
        short_stay_addons_pending: false,
        payment_choice_needed: quote.quote_status === 'ready',
      };
    }
  }

  const wireCtx = buildPaymentChoiceWireContext(
    chainGuestContext,
    result,
    availability,
    quote,
  );

  let payment_choice;
  if (shouldAttemptGuestPaymentChoiceWire(wireCtx)) {
    payment_choice = runGuestPaymentChoiceDryRun(
      { message_text: trimStr(inp.message_text), language_hint: inp.language_hint },
      wireCtx,
    );
  } else {
    payment_choice = buildGuestPaymentChoiceSkippedResponse(wireCtx);
  }

  let hold_payment_draft_plan = null;
  if (payment_choice && payment_choice.payment_choice_ready === true) {
    const plannerChain = buildHoldPaymentDraftPlannerChain(chainGuestContext, {
      result,
      availability,
      quote,
      payment_choice,
    });
    hold_payment_draft_plan = runGuestHoldPaymentDraftPlannerDryRun(
      plannerChain,
      {
        client_slug: chainCtx.client_slug,
        guest_phone: inp.guest_phone || null,
        conversation_id: inp.conversation_id || null,
      },
    );
  }

  const payload = mergeActiveBookingChainOutput(chainGuestContext, {
    gate,
    result,
    availability,
    quote,
    payment_choice,
    hold_payment_draft_plan,
  }, trimStr(inp.message_text));

  const allowLeadingIntro = (brainDecision && brainDecision.intent === 'greeting')
    || (payload.result && payload.result.greeting_only === true);
  const composed = tryComposeBookingReply(
    payload,
    trimStr(inp.message_text),
    chainGuestContext,
    brainDecision,
    { allowLeadingIntro: allowLeadingIntro === true },
  );
  let proposedLunaReply;
  let finalReplySource;
  let composerState = null;
  if (composed) {
    proposedLunaReply = composed.reply;
    finalReplySource = composed.reply_source;
    composerState = composed.composer_state;
  } else {
    proposedLunaReply = resolveProposedReply(
      payload, trimStr(inp.message_text), chainGuestContext, brainDecision,
    );
    if (brainDecision && brainDecision.intent === 'accommodation_only_choice' && proposedLunaReply) {
      const ack = buildAccommodationOnlyAck((result && result.detected_language) || 'en');
      if (!proposedLunaReply.includes(ack)) {
        proposedLunaReply = `${ack} ${proposedLunaReply}`;
      }
    }
    finalReplySource = classifyFinalReplySource(proposedLunaReply, payload);
  }
  const overrodeBrain = !composed
    && brainControlsReply(brainDecision, payload.result, payload.quote)
    && finalReplySource !== 'router';
  proposedLunaReply = dedupeLunaIntro(proposedLunaReply, allowLeadingIntro === true);

  const resultWithBrain = {
    ...payload.result,
    conversation_brain: buildBrainObservability(brainDecision, {
      finalReplySource,
      overrodeBrain,
      composer_state: composerState,
    }),
  };

  return buildOrchestratorResponse({
    automation_gate: gate,
    result: resultWithBrain,
    availability: payload.availability,
    quote: payload.quote,
    payment_choice: payload.payment_choice,
    hold_payment_draft_plan: payload.hold_payment_draft_plan,
    proposed_next_action: resolveProposedNextAction(payload),
    proposed_luna_reply: proposedLunaReply,
  });
}

module.exports = {
  runGuestAutomationOrchestratorDryRun,
  evaluateAutomationGate,
  resolveProposedNextAction,
  resolveProposedReply,
  shouldPreferRouterReply,
  shouldUsePaymentChoiceReply,
  SUPPORTED_CLIENT_SLUGS,
  SUPPORTED_CHANNELS,
  VALID_PROPOSED_NEXT_ACTIONS,
  REUSED_CHAIN_HELPERS,
  ORCHESTRATOR_SAFETY,
};
