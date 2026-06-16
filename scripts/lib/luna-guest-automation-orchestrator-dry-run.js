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
const { applyHandoffPolicyToResult } = require('./luna-guest-handoff-policy');
const { runGuestAvailabilityDryRun, buildGuestAvailabilitySkippedResponse, shouldAttemptGuestAvailability } = require('./luna-guest-availability-dry-run');
const { runGuestQuoteProposalDryRun } = require('./luna-guest-quote-proposal-dry-run');
const { quoteNeedsPaymentChoice } = require('./luna-quote-payment-choice');
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
  isActiveBookingSideQuestion,
} = require('./luna-guest-context-merge');
const { hydrateGuestContextPaymentTruth } = require('./luna-guest-payment-truth-hydrate');
const { attachActiveThreadToGuestContext } = require('./luna-guest-thread-state');
const {
  loadActiveGuestBookings,
  needsBookingDisambiguation,
  buildBookingChoiceReply,
  parseBookingSelectionFromMessage,
  detectServiceTypeFromText,
} = require('./luna-guest-booking-disambiguation');
const {
  evaluateQuoteStaleInvalidation,
  applyQuoteStaleInvalidation,
  priorQuoteWasReady,
} = require('./luna-booking-state-transitions');
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
const { composeFrontdeskGuestReply } = require('./luna-guest-frontdesk-reply');
const { resolveGuestThreadTranscript } = require('./luna-guest-thread-transcript-loader');
const {
  isGuestFrontdeskPlannerEnabled,
  isGuestFrontdeskPlannerActive,
  runGuestFrontdeskPlannerPreChain,
  buildFrontdeskReplyPlan,
  buildFrontdeskObservability,
  applyPlannerFieldSeed: applyFrontdeskFieldSeed,
} = require('./luna-guest-frontdesk-planner');
const {
  runLunaGuestAgentBrain,
  buildGuestAgentBrainObservability,
} = require('./luna-guest-agent-brain');
const { applyCamiReplyAuthorStage } = require('./luna-guest-cami-reply-author');
const {
  runGuestGptToolPlanner,
  isGptToolPlannerEnabled,
  isGptToolPlannerActive,
  applyPlannerFieldSeed,
  buildGptToolPlannerObservability,
} = require('./luna-guest-gpt-tool-planner');
const {
  runGuestGptWriteToolPlanner,
  isGptWriteToolPlannerEnabled,
  buildGptWriteToolPlannerObservability,
} = require('./luna-guest-gpt-write-tool-planner');
const { applyGuestReplyPipeline } = require('./luna-guest-reply-pipeline');
const { applyUnifiedPlannerEnv, isUnifiedPlannerActive } = require('./luna-guest-unified-planner');
const {
  detectGuestSurfReportIntent,
  shouldPrioritizeSurfReportOverService,
  fetchGuestSurfReportData,
} = require('./luna-guest-surf-report');
const { buildQuoteFactsObservability } = require('./luna-quote-facts');
const { buildBookingIntakePolicySnapshot } = require('./luna-booking-intake-policy');
const {
  addonsAnsweredThisTurn,
  addonsResolvedFromFields,
  quoteAwaitingAddonsDecision,
  buildAddonsObservability,
  extractAddOnSelections,
  isExplicitAddonSelectionMessage,
  guestDeclinedAddons,
} = require('./luna-booking-addons-policy');
const { buildReactiveServicesObservability } = require('./luna-booking-reactive-services-policy');
const { runGuestWritePipeline } = require('./luna-guest-write-pipeline');

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
    return out.split('\n').map((line) => line.replace(/[ \t]{2,}/g, ' ').trim()).join('\n').trim();
  }
  // Mid-flow: strip every intro fragment.
  out = out.replace(LUNA_INTRO_RE, '');
  return out.split('\n').map((line) => line.replace(/[ \t]{2,}/g, ' ').trim()).join('\n').trim();
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

function shortStayAddonsAnswered(messageText, brainDecision, mergedFields) {
  return addonsAnsweredThisTurn(messageText, brainDecision, mergedFields);
}

/** Prior turn already declined add-ons / chose accommodation-only for a short stay. */
function shortStayAddonsAlreadyAnswered(guestContext, messageText, brainDecision) {
  const priorQuote = (guestContext || {}).quote || {};
  if (priorQuote.quote_status === 'ready'
    && priorQuote.short_stay_addons_pending === false
    && priorQuote.addons_pending_after_quote === false) {
    return true;
  }
  const prior = collectPriorExtractedFields(guestContext);
  if (addonsResolvedFromFields(prior)) return true;
  if (!isAccommodationOnlyIntent(prior.package_interest)) return false;
  const nights = computeStayNights(prior.check_in, prior.check_out);
  if (nights == null || nights >= 7 || prior.guest_count == null || prior.guest_count < 1) {
    return false;
  }
  return addonsResolvedFromFields(prior);
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

// Stage 49b — run Agent Brain v1 after the deterministic chain has produced its
// candidate reply. The agent may take final reply authority (final_reply_source:
// agent_brain) or endorse the existing reply (fallback). Never touches gates.
function applyGuestAgentBrainStage(args) {
  const a = args || {};
  const agent = runLunaGuestAgentBrain({
    client_slug: a.client_slug,
    conversation_id: a.conversation_id || null,
    guest_phone: a.guest_phone || null,
    contact_name: a.contact_name || null,
    message_text: a.message_text,
    prior_guest_context: a.prior_guest_context,
    brain_decision: a.brain_decision,
    composed: a.composed || null,
    candidate_reply: a.candidate_reply,
    candidate_source: a.candidate_source,
    payload: a.payload,
    channel_mode: a.channel_mode || 'orchestrator_dry_run',
    env: a.env,
  });
  const agentTookReply = agent.agent_brain_enabled === true
    && agent.fallback_used !== true
    && trimStr(agent.final_reply) !== '';
  return {
    agent,
    reply: agentTookReply ? agent.final_reply : a.candidate_reply,
    reply_source: agentTookReply ? 'agent_brain' : a.candidate_source,
    observability: buildGuestAgentBrainObservability(agent),
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

/** Stage 43a — prefetch guest surf report (mock fixtures or Stormglass when configured). */
async function prefetchGuestSurfReportPayload(messageText, priorGuestContext, clientSlug) {
  const detected = detectGuestSurfReportIntent(messageText);
  if (!detected || !shouldPrioritizeSurfReportOverService(messageText, priorGuestContext)) {
    return null;
  }
  const mock = priorGuestContext && (priorGuestContext.surf_report_mock || priorGuestContext.surf_report_test_override);
  const data = await fetchGuestSurfReportData({
    clientSlug: clientSlug || DEFAULT_CLIENT,
    day: detected.day,
    mock,
  });
  return {
    day: data.day || detected.day,
    metrics: data.metrics || null,
    unavailable: data.unavailable === true,
    source: data.source || null,
  };
}

/** Stage 28j.6 — try centralized booking reply composer before legacy templates. */
function tryComposeBookingReply(payload, messageText, priorGuestContext, brainDecision, opts) {
  const o = opts || {};
  const clientSlug = trimStr(o.client_slug)
    || trimStr(priorGuestContext && priorGuestContext.client_slug)
    || DEFAULT_CLIENT;
  const env = o.env || process.env;
  const composed = composeFrontdeskGuestReply({
    payload,
    message_text: messageText,
    prior_guest_context: priorGuestContext,
    brain_decision: brainDecision,
    mode: o.mode || 'orchestrator',
    allow_leading_intro: o.allowLeadingIntro === true,
    live_outcomes: o.liveOutcomes,
    client_slug: clientSlug,
    frontdesk_reply_plan: o.frontdeskReplyPlan || null,
    env,
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

function quoteLegacyReplyIsStale(quote, result) {
  return !!(quote && (quote.quote_stale === true || quote.previous_quote_invalidated === true))
    || !!(result && result.previous_quote_invalidated === true);
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

    const explicitAddonSelection = isExplicitAddonSelectionMessage(sideQuestionText);
    const addonsStepSelection = quoteAwaitingAddonsDecision(quote)
      && extractAddOnSelections(sideQuestionText).length > 0;
    const serviceIntent = (!explicitAddonSelection && !addonsStepSelection)
      ? (detectServiceSideQuestionIntent(sideQuestionText)
        || (result && result.message_lane === 'add_service_request' ? 'services_general' : null))
      : null;
    if (serviceIntent) {
      return sanitizeReply(
        buildServiceSideQuestionReply(sideQuestionLang, serviceIntent, sideQuestionText),
        fallbackCtx,
        pc && pc.payment_choice,
      );
    }
  }

  // Stage 42b.2 — router payment side-questions (Cami pools) override payment-choice templates.
  if (result && result.message_lane === 'payment_question' && result.proposed_luna_reply) {
    return sanitizeReply(result.proposed_luna_reply, fallbackCtx, pc && pc.payment_choice);
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
  if (quote && quote.proposed_luna_reply && !quoteLegacyReplyIsStale(quote, result)
    && !quoteAwaitingAddonsDecision(quote)) {
    return sanitizeReply(quote.proposed_luna_reply, fallbackCtx, pc && pc.payment_choice);
  }
  if (availability && availability.proposed_luna_reply) {
    if (!(quote && quote.quote_status === 'ready' && quoteAwaitingAddonsDecision(quote))) {
      return sanitizeReply(availability.proposed_luna_reply, fallbackCtx, pc && pc.payment_choice);
    }
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

function buildGuestContextChainSnapshot(chainGuestContext) {
  const ctx = chainGuestContext || {};
  return {
    active_thread: ctx.active_thread || null,
    booking_code: ctx.booking_code || null,
    booking_id: ctx.booking_id || null,
    payment_link_sent: ctx.payment_link_sent === true,
    stripe_link_created: ctx.stripe_link_created === true,
    confirmation_sent: ctx.confirmation_sent === true,
    payment_received: ctx.payment_received === true,
    hold_created: ctx.hold_created === true,
    payment_truth: ctx.payment_truth || null,
    transcript_source: ctx.transcript_source || null,
    transcript_turns: Array.isArray(ctx.thread_transcript) ? ctx.thread_transcript.length : 0,
    // Stage 56c — preserve multi-booking disambiguation state across turns.
    pending_service_intent: ctx.pending_service_intent || null,
    pending_booking_choice: ctx.pending_booking_choice || null,
  };
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
    guest_context_chain: parts.guest_context_chain ?? null,
    proposed_next_action: parts.proposed_next_action,
    proposed_luna_reply: parts.proposed_luna_reply,
    reused_chain_helpers: [...REUSED_CHAIN_HELPERS],
  };
}

function buildNonBookingLaneResponse(result, gate, messageText, brainDecision, priorGuestContext) {
  const prior = priorGuestContext || {};
  const payload = {
    gate,
    result,
    availability: prior.availability || null,
    quote: prior.quote || null,
    payment_choice: prior.payment_choice || null,
    hold_payment_draft_plan: prior.hold_payment_draft_plan || null,
    proposed_next_action: resolveProposedNextAction({ gate, result, quote: prior.quote, availability: prior.availability }),
  };
  return { payload, prior, allowIntro: (brainDecision && brainDecision.intent === 'greeting')
    || (result && result.greeting_only === true) };
}

async function finalizeNonBookingLaneResponse(result, gate, messageText, brainDecision, priorGuestContext, env, orchestratorCtx) {
  const priorWithThread = attachActiveThreadToGuestContext(priorGuestContext || {});
  const { payload, prior, allowIntro } = buildNonBookingLaneResponse(result, gate, messageText, brainDecision, priorWithThread);
  const clientSlug = trimStr(prior.client_slug) || DEFAULT_CLIENT;
  const surfReport = await prefetchGuestSurfReportPayload(messageText, prior, clientSlug);
  if (surfReport) payload.surf_report = surfReport;
  const composed = tryComposeBookingReply(
    payload,
    messageText,
    prior,
    brainDecision,
    { allowLeadingIntro: allowIntro, client_slug: clientSlug },
  );
  const candidateReply = composed
    ? composed.reply
    : resolveProposedReply(payload, messageText, prior, brainDecision);
  const candidateSource = composed
    ? composed.reply_source
    : classifyFinalReplySource(candidateReply, payload);
  const replyPipeline = await applyGuestReplyPipeline({
    client_slug: clientSlug,
    message_text: messageText,
    prior_guest_context: prior,
    brain_decision: brainDecision,
    composed,
    candidate_reply: candidateReply,
    candidate_source: candidateSource,
    allowed_next_action: payload.proposed_next_action,
    payload,
    channel_mode: 'orchestrator_dry_run',
    env: env || process.env,
    authorCaller: (orchestratorCtx && orchestratorCtx.cami_reply_author_caller) || undefined,
  });
  let proposedLunaReply = replyPipeline.reply;
  let finalReplySource = replyPipeline.reply_source;
  const policySnapshot = buildBookingIntakePolicySnapshot(
    {
      extracted_fields: (result && result.extracted_fields) || collectPriorExtractedFields(prior),
      package_night_rule: result && result.package_night_rule,
    },
    {
      channel_guest_name: prior.contact_name || prior.channel_guest_name || null,
      quote: payload.quote,
      payment_choice: payload.payment_choice,
      availability: payload.availability,
    },
  );
  const quoteObs = buildQuoteFactsObservability(payload);
  const addonsObs = buildAddonsObservability(
    {
      extracted_fields: (result && result.extracted_fields) || collectPriorExtractedFields(prior),
      package_night_rule: result && result.package_night_rule,
    },
    { quote: payload.quote },
    payload.quote,
  );
  const reactiveObs = buildReactiveServicesObservability(
    (result && result.extracted_fields) || collectPriorExtractedFields(prior),
    prior.client_slug || DEFAULT_CLIENT,
  );
  const resultWithBrain = {
    ...result,
    active_thread: priorWithThread.active_thread || null,
    extracted_fields: (result && result.extracted_fields && Object.keys(result.extracted_fields).length)
      ? result.extracted_fields
      : collectPriorExtractedFields(prior),
    booking_intake_policy: policySnapshot,
    quote_facts_used_by_composer: quoteObs.quote_facts_used_by_composer,
    quote_facts_used_by_hold_writer: quoteObs.quote_facts_used_by_hold_writer,
    ...addonsObs,
    ...reactiveObs,
    conversation_brain: buildBrainObservability(brainDecision, {
      finalReplySource,
      overrodeBrain: false,
      composer_state: composed ? composed.composer_state : null,
      booking_flow_stage: policySnapshot.booking_flow_stage,
      next_required_field: policySnapshot.next_required_field,
    }),
    guest_agent_brain: replyPipeline.guest_agent_brain,
    cami_reply_author: replyPipeline.cami_reply_author,
    guest_reply_pipeline: replyPipeline.reply_pipeline,
    cami_variation_history: replyPipeline.cami_variation_history
      || (composed && composed.cami_variation_history)
      || prior.cami_variation_history
      || undefined,
  };
  return buildOrchestratorResponse({
    automation_gate: gate,
    result: resultWithBrain,
    availability: payload.availability,
    quote: payload.quote,
    payment_choice: payload.payment_choice,
    hold_payment_draft_plan: payload.hold_payment_draft_plan,
    guest_context_chain: buildGuestContextChainSnapshot(priorWithThread),
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
  if (ctx.pg) {
    chainGuestContext = await hydrateGuestContextPaymentTruth(ctx.pg, chainGuestContext);
  } else {
    chainGuestContext = attachActiveThreadToGuestContext(chainGuestContext);
  }

  const clientSlugEarly = trimStr(inp.client_slug) || DEFAULT_CLIENT;
  const threadBundle = await resolveGuestThreadTranscript(ctx.pg, {
    client_slug: clientSlugEarly,
    conversation_id: inp.conversation_id,
    prior_guest_context: chainGuestContext,
    message_text: trimStr(inp.message_text),
  });
  chainGuestContext = {
    ...chainGuestContext,
    thread_transcript: threadBundle.transcript || [],
    recent_history: threadBundle.recent_history || [],
    transcript_source: threadBundle.source || null,
  };

  const routerContext = {
    reference_date: inp.reference_date || ctx.reference_date,
    language_hint: inp.language_hint,
    client_slug: trimStr(inp.client_slug) || DEFAULT_CLIENT,
    guest_phone: trimStr(inp.guest_phone) || trimStr(ctx.guest_phone) || null,
    guest_name: trimStr(inp.guest_name) || trimStr(inp.contact_name) || null,
    contact_name: trimStr(inp.contact_name) || trimStr(inp.guest_name) || null,
  };

  const messageText = trimStr(inp.message_text);

  // Stage 28j — smart LLM conversation brain in the hot path. The async decision uses
  // the configured LLM only when LUNA_CONVERSATION_BRAIN_LLM_ENABLED=true outside
  // production; otherwise (or on failure/timeout) it is the deterministic decision.
  // The brain only classifies/plans — every action below stays deterministic + gated.
  const brainEnv = applyUnifiedPlannerEnv(ctx.env || process.env);
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
      last_luna_reply: threadBundle.last_assistant_reply
        || (chainGuestContext.result && chainGuestContext.result.proposed_luna_reply)
        || null,
      recent_history: threadBundle.recent_history || [],
      package_night_rule: priorPackageNightRule,
      env: brainEnv,
    },
    { llmClient: ctx.brain_llm_client },
  );

  let gptToolPlannerOutput = null;
  let frontdeskPrePlan = null;
  if (isGuestFrontdeskPlannerEnabled(brainEnv)) {
    frontdeskPrePlan = await runGuestFrontdeskPlannerPreChain({
      client_slug: routerContext.client_slug,
      message_text: messageText,
      prior_guest_context: chainGuestContext,
      reference_date: routerContext.reference_date,
      contact_name: routerContext.contact_name,
      guest_phone: routerContext.guest_phone,
      transcript: threadBundle.transcript || [],
      transcript_source: threadBundle.source || null,
    }, {
      env: brainEnv,
      plannerCaller: ctx.frontdesk_planner_caller,
    });
    if (isGuestFrontdeskPlannerActive(brainEnv) && frontdeskPrePlan && frontdeskPrePlan.field_patch) {
      chainGuestContext = applyFrontdeskFieldSeed(chainGuestContext, frontdeskPrePlan.field_patch);
    }
  } else if (isGptToolPlannerEnabled(brainEnv)) {
    gptToolPlannerOutput = await runGuestGptToolPlanner({
      client_slug: routerContext.client_slug,
      message_text: messageText,
      prior_guest_context: chainGuestContext,
      reference_date: routerContext.reference_date,
      contact_name: routerContext.contact_name,
      guest_phone: routerContext.guest_phone,
    }, {
      env: brainEnv,
      plannerCaller: ctx.gpt_tool_planner_caller,
    });
    if (isGptToolPlannerActive(brainEnv) && gptToolPlannerOutput && gptToolPlannerOutput.field_patch) {
      chainGuestContext = applyPlannerFieldSeed(chainGuestContext, gptToolPlannerOutput.field_patch);
    }
  }

  let result = applyHandoffPolicyToResult(
    runLunaGuestMessageRouterDryRun(
      {
        message_text: messageText,
        language_hint: inp.language_hint,
        guest_context: chainGuestContext,
        brain_decision: brainDecision,
      },
      routerContext,
    ),
    chainGuestContext,
    messageText,
  );

  if (result.greeting_only) {
    return finalizeNonBookingLaneResponse(result, gate, messageText, brainDecision, chainGuestContext, brainEnv, ctx);
  }

  if (detectNewBookingResetIntent(messageText)
    && (shouldAttemptGuestPaymentChoiceWire(chainGuestContext)
      || (chainGuestContext.quote && chainGuestContext.quote.quote_status === 'ready'))) {
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
      const resetReply = buildNewBookingResetReply(
        result.detected_language || 'en',
        routerContext.client_slug || DEFAULT_CLIENT,
      );
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

  // Stage 56c — multi-booking disambiguation for service requests.
  // Runs BEFORE bookingContinuation so it intercepts even when a prior booking_id is stored.
  let addServiceReadyForAttach = false;
  {
    const guestPhone = trimStr(inp.guest_phone) || trimStr(ctx.guest_phone) || '';

    // Case A: guest is replying to a disambiguation prompt (any message lane).
    // The reply message ("1", "the first one", "AAA111", etc.) won't be classified as
    // add_service_request by the router, so this check must run unconditionally.
    if (
      chainGuestContext.pending_booking_choice
      && Array.isArray(chainGuestContext.pending_booking_choice.bookings)
      && chainGuestContext.pending_booking_choice.bookings.length > 0
    ) {
      const pendingBookings = chainGuestContext.pending_booking_choice.bookings;
      const selected = parseBookingSelectionFromMessage(messageText, pendingBookings);
      if (selected) {
        const serviceIntent = chainGuestContext.pending_service_intent;
        chainGuestContext = {
          ...chainGuestContext,
          booking_id: selected.booking_id,
          booking_code: selected.booking_code,
          pending_booking_choice: null,
          pending_service_intent: null,
        };
        result = {
          ...result,
          message_lane: 'add_service_request',
          // The router may have set safe_handoff_required on this selection message
          // (e.g. "the first one" looks like a non-booking query). Clear it so the
          // service attach path runs instead of handing off to staff.
          safe_handoff_required: false,
          handoff_reasons: [],
          intake_state: 'post_booking_service_request',
          extracted_fields: {
            ...((result && result.extracted_fields) || {}),
            ...(serviceIntent && serviceIntent.type === 'meals'
              ? { meals_request: { status: 'requested', meal_type: 'unspecified' } }
              : {}),
            ...(serviceIntent && serviceIntent.type === 'yoga'
              ? { yoga_request: { status: 'requested' } }
              : {}),
          },
        };
        addServiceReadyForAttach = true;
      }
      // If selection not parsed: fall through — Cami will repeat the choice.
    }

    // Case B: fresh service intent — always query DB for active bookings so multiple-booking
    // guests see a choice list even when an old booking_id is stored in context.
    if (!addServiceReadyForAttach && result.message_lane === 'add_service_request' && ctx && ctx.pg) {
      const serviceType = detectServiceTypeFromText(messageText)
        || (chainGuestContext.pending_service_intent && chainGuestContext.pending_service_intent.type)
        || null;
      if (serviceType) {
        const activeBookings = await loadActiveGuestBookings(ctx.pg, { phone: guestPhone });
        if (activeBookings.length > 1) {
          const lang = trimStr(
            chainGuestContext.detected_language || (result && result.detected_language),
          ) || 'en';
          const disambigReply = buildBookingChoiceReply(lang, activeBookings, serviceType);
          const disambigChain = {
            ...chainGuestContext,
            pending_service_intent: { type: serviceType },
            pending_booking_choice: { bookings: activeBookings },
          };
          return buildOrchestratorResponse({
            automation_gate: gate,
            result: { ...result, active_thread: disambigChain.active_thread || 'post_booking' },
            availability: null,
            quote: chainGuestContext.quote || null,
            payment_choice: null,
            hold_payment_draft_plan: null,
            guest_context_chain: buildGuestContextChainSnapshot(disambigChain),
            proposed_next_action: 'await_booking_selection',
            proposed_luna_reply: disambigReply,
          });
        } else if (activeBookings.length === 1 && !trimStr(chainGuestContext.booking_id)) {
          chainGuestContext = {
            ...chainGuestContext,
            booking_id: activeBookings[0].booking_id,
            booking_code: activeBookings[0].booking_code,
          };
        }
      }
    }
  }

  let transferTimesContinuation = false;
  try {
    const { guestProvidedTransferTimes } = require('./luna-guest-transfer-times-update');
    transferTimesContinuation = priorQuoteWasReady(chainGuestContext)
      && guestProvidedTransferTimes(collectPriorExtractedFields(chainGuestContext), messageText);
  } catch (_) { /* noop */ }

  const bookingContinuation = shouldAttemptGuestPaymentChoiceWire(chainGuestContext, messageText)
    || (chainGuestContext.quote && chainGuestContext.quote.quote_status === 'ready'
      && quoteAwaitingAddonsDecision(chainGuestContext.quote))
    || isActiveBookingSideQuestion(chainGuestContext, result, messageText)
    || transferTimesContinuation
    || ((guestDeclinedAddons(messageText) || extractAddOnSelections(messageText).length > 0)
      && chainGuestContext.quote && chainGuestContext.quote.quote_status === 'ready')
    // After disambiguation resolves (user picked a booking), force the booking continuation
    // path so the write planner can run attach_post_booking_services.
    || addServiceReadyForAttach;

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
    return finalizeNonBookingLaneResponse(result, gate, messageText, brainDecision, chainGuestContext, brainEnv, ctx);
  }

  const staleInvalidation = evaluateQuoteStaleInvalidation(chainGuestContext, result, messageText);
  if (staleInvalidation) {
    chainGuestContext = applyQuoteStaleInvalidation(chainGuestContext, staleInvalidation);
    result = {
      ...result,
      previous_quote_invalidated: true,
      stale_quote_reason: staleInvalidation.stale_quote_reason,
      corrected_fields: staleInvalidation.corrected_fields,
      booking_intake_ready: result.booking_intake_ready !== false,
      readiness_state: result.booking_intake_ready !== false
        ? 'ready_for_availability_check'
        : result.readiness_state,
    };
  }

  if (result.extracted_fields && result.extracted_fields.booking_ready_to_proceed === true) {
    result = {
      ...result,
      safe_handoff_required: false,
      handoff_reasons: [],
    };
  }
  result = applyHandoffPolicyToResult(result, chainGuestContext, messageText);

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
  const mergedFields = collectPriorExtractedFields({
    ...chainGuestContext,
    result,
  });
  const addonsAlreadyResolved = addonsResolvedFromFields(mergedFields)
    || shortStayAddonsAlreadyAnswered(chainGuestContext, messageText, brainDecision);

  if (addonsAlreadyResolved) {
    quote = {
      ...quote,
      short_stay_addons_pending: false,
      addons_pending_after_quote: false,
      payment_choice_needed: quoteNeedsPaymentChoice(quote),
    };
  } else {
    const addonsPending = quoteAwaitingAddonsDecision(quote)
      || quoteAwaitingAddonsDecision(priorQuote);
    if (addonsPending && shortStayAddonsAnswered(trimStr(inp.message_text), brainDecision, mergedFields)) {
      quote = {
        ...quote,
        short_stay_addons_pending: false,
        addons_pending_after_quote: false,
        payment_choice_needed: quoteNeedsPaymentChoice(quote),
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
  if (shouldAttemptGuestPaymentChoiceWire(wireCtx, trimStr(inp.message_text))) {
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

  let gptWriteToolPlannerOutput = null;
  let writeLiveOutcomes = null;
  if (isGptWriteToolPlannerEnabled(brainEnv)) {
    // Stage 56c — propagate booking_id from context chain so post-booking service
    // attaches can run without a fresh hold write.
    const contextChainBookingId = trimStr(chainGuestContext.booking_id) || null;
    const writeExecCtx = {
      env: brainEnv,
      pg: ctx.pg || null,
      host_header: ctx.host_header || '',
      client_slug: chainCtx.client_slug,
      guest_phone: inp.guest_phone,
      contact_name: routerContext.contact_name,
      prior_guest_context: chainGuestContext,
      confirm_write: ctx.confirm_write === true || ctx.confirm_guest_write === true,
      confirm_stripe_test_link: ctx.confirm_stripe_test_link === true,
      confirm_service_payment_link: ctx.confirm_service_payment_link === true,
      // Post-booking service attaches are auto-confirmed when booking_id is known.
      confirm_service_attach: !!contextChainBookingId,
      booking_id: contextChainBookingId,
      staff_operator: ctx.staff_operator || 'luna-guest-orchestrator',
      source: ctx.write_source || 'luna_guest_gpt_write_tool_planner',
    };
    gptWriteToolPlannerOutput = await runGuestGptWriteToolPlanner({
      message_text: messageText,
      client_slug: chainCtx.client_slug,
      guest_phone: inp.guest_phone,
      contact_name: routerContext.contact_name,
      prior_guest_context: chainGuestContext,
      chain_snapshot: payload,
      // Expose existing booking_id so the GPT prompt correctly assesses readiness.
      booking_id: contextChainBookingId,
    }, {
      env: brainEnv,
      exec_ctx: writeExecCtx,
      writePlannerCaller: ctx.gpt_write_tool_planner_caller,
    });
    const wo = (gptWriteToolPlannerOutput && gptWriteToolPlannerOutput.write_outcomes) || {};
    if (Object.keys(wo).length) {
      writeLiveOutcomes = {
        bookingWrite: wo.create_booking_hold || null,
        stripeLink: wo.create_payment_link || null,
        balanceStripeLink: wo.create_balance_payment_link || null,
        serviceAttach: wo.attach_post_booking_services || null,
        serviceStripeLink: wo.create_service_payment_link || null,
      };
      payload.gpt_write_outcomes = wo;
    }
    if (contextChainBookingId && ctx.pg) {
      const maintOut = await runGuestWritePipeline({
        review: payload,
        inboundBody: {
          client_slug: chainCtx.client_slug,
          guest_phone: inp.guest_phone,
          contact_name: routerContext.contact_name,
          message_text: messageText,
        },
        rawBody: {},
        env: brainEnv,
        pg: ctx.pg,
        host_header: ctx.host_header || '',
        actorId: ctx.staff_operator || 'luna-guest-orchestrator',
        flags: {},
      });
      writeLiveOutcomes = writeLiveOutcomes || {};
      writeLiveOutcomes.serviceAttach = writeLiveOutcomes.serviceAttach || maintOut.serviceAttach;
      writeLiveOutcomes.serviceStripeLink = writeLiveOutcomes.serviceStripeLink || maintOut.serviceStripeLink;
      writeLiveOutcomes.transferTimesUpdate = maintOut.transferTimesUpdate;
      writeLiveOutcomes.serviceSchedule = maintOut.serviceSchedule;
      writeLiveOutcomes.lunaNotes = maintOut.lunaNotes;
    }
  }

  const clientSlugForSurf = chainCtx.client_slug || DEFAULT_CLIENT;
  const surfReport = await prefetchGuestSurfReportPayload(trimStr(inp.message_text), chainGuestContext, clientSlugForSurf);
  if (surfReport) payload.surf_report = surfReport;

  const allowLeadingIntro = (brainDecision && brainDecision.intent === 'greeting')
    || (payload.result && payload.result.greeting_only === true);
  const truthComposed = composeLunaGuestReply({
    payload,
    message_text: trimStr(inp.message_text),
    prior_guest_context: chainGuestContext,
    brain_decision: brainDecision,
    mode: writeLiveOutcomes ? 'live_staging' : 'orchestrator',
    allow_leading_intro: allowLeadingIntro === true,
    live_outcomes: writeLiveOutcomes,
    client_slug: chainCtx.client_slug || DEFAULT_CLIENT,
  });
  const frontdeskReplyPlan = buildFrontdeskReplyPlan({
    payload,
    prior_guest_context: chainGuestContext,
    frontdesk_pre_plan: frontdeskPrePlan,
    composed: truthComposed,
  });
  const composed = tryComposeBookingReply(
    payload,
    trimStr(inp.message_text),
    chainGuestContext,
    brainDecision,
    {
      allowLeadingIntro: allowLeadingIntro === true,
      client_slug: chainCtx.client_slug || DEFAULT_CLIENT,
      liveOutcomes: writeLiveOutcomes,
      mode: writeLiveOutcomes ? 'live_staging' : 'orchestrator',
      frontdeskReplyPlan,
      env: brainEnv,
    },
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
  const replyPipeline = await applyGuestReplyPipeline({
    client_slug: chainCtx.client_slug || DEFAULT_CLIENT,
    conversation_id: inp.conversation_id || null,
    guest_phone: inp.guest_phone || null,
    contact_name: routerContext.contact_name || null,
    message_text: trimStr(inp.message_text),
    prior_guest_context: chainGuestContext,
    brain_decision: brainDecision,
    composed,
    candidate_reply: proposedLunaReply,
    candidate_source: finalReplySource,
    allowed_next_action: resolveProposedNextAction(payload),
    payload,
    channel_mode: 'orchestrator_dry_run',
    env: brainEnv,
    authorCaller: ctx.cami_reply_author_caller,
  });
  proposedLunaReply = dedupeLunaIntro(replyPipeline.reply, allowLeadingIntro === true);
  finalReplySource = replyPipeline.reply_source;

  const policySnapshot = buildBookingIntakePolicySnapshot(
    {
      extracted_fields: payload.result && payload.result.extracted_fields,
      package_night_rule: payload.result && payload.result.package_night_rule,
    },
    {
      channel_guest_name: routerContext.guest_name || routerContext.contact_name || null,
      quote: payload.quote,
      payment_choice: payload.payment_choice,
      availability: payload.availability,
    },
  );

  const quoteObs = buildQuoteFactsObservability(payload);
  const addonsObs = buildAddonsObservability(
    { extracted_fields: payload.result && payload.result.extracted_fields, package_night_rule: payload.result && payload.result.package_night_rule },
    { client_slug: chainCtx.client_slug, quote: payload.quote },
    payload.quote,
    staleInvalidation,
  );
  const reactiveObs = buildReactiveServicesObservability(
    payload.result && payload.result.extracted_fields,
    chainCtx.client_slug || DEFAULT_CLIENT,
  );
  chainGuestContext = attachActiveThreadToGuestContext(chainGuestContext);

  const resultWithBrain = {
    ...payload.result,
    active_thread: chainGuestContext.active_thread || null,
    booking_intake_policy: policySnapshot,
    previous_quote_invalidated: payload.result && payload.result.previous_quote_invalidated,
    stale_quote_reason: payload.result && payload.result.stale_quote_reason,
    corrected_fields: payload.result && payload.result.corrected_fields,
    quote_stale: payload.quote && payload.quote.quote_stale,
    correction_applied: payload.result && payload.result.previous_quote_invalidated === true,
    quote_facts_used_by_composer: quoteObs.quote_facts_used_by_composer,
    quote_facts_used_by_hold_writer: quoteObs.quote_facts_used_by_hold_writer,
    ...addonsObs,
    ...reactiveObs,
    conversation_brain: buildBrainObservability(brainDecision, {
      finalReplySource,
      overrodeBrain,
      composer_state: composerState,
      booking_flow_stage: policySnapshot.booking_flow_stage,
      next_required_field: policySnapshot.next_required_field,
    }),
    guest_agent_brain: replyPipeline.guest_agent_brain,
    cami_reply_author: replyPipeline.cami_reply_author,
    guest_reply_pipeline: replyPipeline.reply_pipeline,
    guest_gpt_tool_planner: gptToolPlannerOutput
      ? buildGptToolPlannerObservability(gptToolPlannerOutput)
      : undefined,
    guest_gpt_write_tool_planner: gptWriteToolPlannerOutput
      ? buildGptWriteToolPlannerObservability(gptWriteToolPlannerOutput)
      : undefined,
    guest_frontdesk: buildFrontdeskObservability(frontdeskPrePlan, frontdeskReplyPlan),
    cami_variation_history: (replyPipeline && replyPipeline.cami_variation_history)
      || (composed && composed.cami_variation_history)
      || (chainGuestContext && chainGuestContext.cami_variation_history)
      || undefined,
  };

  return buildOrchestratorResponse({
    automation_gate: gate,
    result: resultWithBrain,
    availability: payload.availability,
    quote: payload.quote,
    payment_choice: payload.payment_choice,
    hold_payment_draft_plan: payload.hold_payment_draft_plan,
    guest_context_chain: buildGuestContextChainSnapshot(chainGuestContext),
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
