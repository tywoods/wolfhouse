'use strict';

/**
 * Stage 27w.2 — Deterministic guest_context / extracted_fields merge for multi-turn dry-run.
 */

const { shouldAttemptGuestPaymentChoiceWire, detectPaymentChoiceFromMessage } = require('./luna-guest-payment-choice-dry-run');
const { detectPackageExplainerIntent } = require('./luna-guest-package-explainer');
const {
  detectServiceSideQuestionIntent,
  detectTransferSideQuestionIntent,
} = require('./luna-guest-service-transfer-explainer');
const {
  detectGuestKnowledgeIntent,
  shouldPrioritizeKnowledgeOverService,
} = require('./luna-guest-knowledge-config');
const {
  detectGuestSurfReportIntent,
  shouldPrioritizeSurfReportOverService,
} = require('./luna-guest-surf-report');
const { quoteAwaitingAddonsDecision } = require('./luna-booking-addons-policy');

const EXTRACTED_FIELD_KEYS = [
  'check_in',
  'check_out',
  'guest_count',
  'guest_name',
  'deferred_guest_count',
  'package_interest',
  'room_preference',
  'transfer_info',
  'addons_skipped',
  'transfer_interest',
  'service_interest',
  'meals_request',
  'yoga_request',
  'payment_preference',
];

function isPresent(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

function mergeServiceInterest(prior, current) {
  const a = Array.isArray(prior) ? prior : [];
  const b = Array.isArray(current) ? current : [];
  if (!a.length && !b.length) return [];
  if (!a.length) return [...b];
  if (!b.length) return [...a];
  const out = [...a];
  for (const item of b) {
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function mergeTransferInterest(prior, current) {
  if (isPresent(current)) return current;
  if (isPresent(prior)) return prior;
  return null;
}

function mergeReactiveRequest(prior, current) {
  if (!prior && !current) return null;
  if (!prior) return current;
  if (!current) return prior;
  return { ...prior, ...current };
}

/**
 * Merge prior extracted booking fields with current-turn extraction.
 * New non-null/non-empty values win; null/empty current values do not erase prior.
 */
function mergeGuestExtractedFields(prior, current) {
  const p = prior || {};
  const c = current || {};
  const merged = {};

  for (const key of EXTRACTED_FIELD_KEYS) {
    if (key === 'service_interest') {
      merged.service_interest = mergeServiceInterest(p.service_interest, c.service_interest);
      continue;
    }
    if (key === 'transfer_interest') {
      merged.transfer_interest = mergeTransferInterest(p.transfer_interest, c.transfer_interest);
      continue;
    }
    if (key === 'meals_request') {
      merged.meals_request = mergeReactiveRequest(p.meals_request, c.meals_request);
      continue;
    }
    if (key === 'yoga_request') {
      merged.yoga_request = mergeReactiveRequest(p.yoga_request, c.yoga_request);
      continue;
    }
    if (isPresent(c[key])) merged[key] = c[key];
    else if (isPresent(p[key])) merged[key] = p[key];
    else merged[key] = c[key] != null ? c[key] : (p[key] != null ? p[key] : null);
  }

  return merged;
}

/**
 * Collect prior extracted fields from a guest_context object (simulator / orchestrator).
 */
function collectPriorExtractedFields(guestContext) {
  const ctx = guestContext || {};
  const fromCtx = ctx.extracted_fields && typeof ctx.extracted_fields === 'object'
    ? ctx.extracted_fields
    : {};
  const fromResult = ctx.result && ctx.result.extracted_fields && typeof ctx.result.extracted_fields === 'object'
    ? ctx.result.extracted_fields
    : {};
  const fromPriorFields = ctx.prior_fields && typeof ctx.prior_fields === 'object'
    ? ctx.prior_fields
    : {};
  return mergeGuestExtractedFields(
    mergeGuestExtractedFields(fromPriorFields, fromResult),
    fromCtx,
  );
}

/**
 * Normalize guest_context for chain helpers (router input + downstream wire).
 */
function normalizeGuestContextForChain(guestContext) {
  if (!guestContext || typeof guestContext !== 'object') return {};
  const priorExtracted = collectPriorExtractedFields(guestContext);
  const out = { ...guestContext };
  if (Object.keys(priorExtracted).some((k) => isPresent(priorExtracted[k]))) {
    out.extracted_fields = priorExtracted;
  }
  if (!out.message_lane && out.result && out.result.message_lane) {
    out.message_lane = out.result.message_lane;
  }
  if (out.readiness_state == null && out.result && out.result.readiness_state) {
    out.readiness_state = out.result.readiness_state;
  }
  if (out.booking_intake_ready == null && out.result && out.result.booking_intake_ready != null) {
    out.booking_intake_ready = out.result.booking_intake_ready;
  }
  if (out.intake_state == null && out.result && out.result.intake_state) {
    out.intake_state = out.result.intake_state;
  }
  if (out.payment_link_sent === true || out.stripe_link_created === true) {
    out.payment_choice_needed = false;
    if (out.quote && typeof out.quote === 'object') {
      out.quote = { ...out.quote, payment_choice_needed: false };
    }
  }
  return restoreBookingLaneForActiveQuote(out);
}

/**
 * Clear prior quote/payment-choice chain so guest can start a fresh booking intake.
 */
function stripQuotePaymentStateForReset(guestContext) {
  const prior = guestContext || {};
  const lang = prior.detected_language
    || (prior.result && prior.result.detected_language)
    || 'en';
  const freshResult = {
    message_lane: 'new_booking_inquiry',
    intake_state: 'inquiry_received',
    readiness_state: 'collecting_required_details',
    booking_intake_ready: false,
    extracted_fields: {},
    detected_language: lang,
    new_booking_reset: true,
  };
  return {
    detected_language: lang,
    message_lane: 'new_booking_inquiry',
    intake_state: 'inquiry_received',
    readiness_state: 'collecting_required_details',
    booking_intake_ready: false,
    extracted_fields: {},
    quote_status: 'not_ready',
    payment_choice_needed: false,
    result: freshResult,
  };
}

/**
 * When quote is ready and payment choice is pending, restore booking lane on guest_context
 * so side-question turns (package explainer, cash-on-arrival) do not break the chain.
 */
function restoreBookingLaneForActiveQuote(ctx) {
  const out = { ...(ctx || {}) };
  const quote = out.quote && typeof out.quote === 'object' ? out.quote : {};
  const paymentNeeded = quote.payment_choice_needed === true || out.payment_choice_needed === true;
  if (quote.quote_status !== 'ready' || !paymentNeeded) return out;

  out.message_lane = 'new_booking_inquiry';
  out.payment_choice_needed = true;
  out.quote_status = quote.quote_status;

  const mergedFields = collectPriorExtractedFields(out);
  if (Object.keys(mergedFields).some((k) => isPresent(mergedFields[k]))) {
    out.extracted_fields = mergedFields;
  }

  if (out.booking_intake_ready == null) {
    out.booking_intake_ready = out.result && out.result.booking_intake_ready;
  }
  if (out.readiness_state == null || out.readiness_state === 'collecting_required_details') {
    const priorReady = out.result && out.result.readiness_state === 'ready_for_availability_check';
    if (priorReady || out.booking_intake_ready === true) {
      out.readiness_state = 'ready_for_availability_check';
    }
  }

  if (out.result && typeof out.result === 'object') {
    out.result = {
      ...out.result,
      message_lane: 'new_booking_inquiry',
      extracted_fields: out.extracted_fields || out.result.extracted_fields,
      booking_intake_ready: out.booking_intake_ready !== false
        ? (out.booking_intake_ready ?? out.result.booking_intake_ready ?? true)
        : out.result.booking_intake_ready,
      readiness_state: out.readiness_state || out.result.readiness_state,
      readiness_reasons: Array.isArray(out.result.readiness_reasons)
        ? out.result.readiness_reasons.filter((r) => r !== 'not_booking_inquiry_lane')
        : out.result.readiness_reasons,
    };
  }

  return out;
}

function isActiveBookingSideQuestion(priorGuestContext, currentResult, messageText) {
  const prior = normalizeGuestContextForChain(priorGuestContext || {});
  const priorQuote = prior.quote || {};
  const priorFields = collectPriorExtractedFields(prior);
  const hasPaymentWire = shouldAttemptGuestPaymentChoiceWire(priorGuestContext, messageText);
  const hasAddonsPending = priorQuote.quote_status === 'ready' && quoteAwaitingAddonsDecision(priorQuote);
  const quoteReady = priorQuote.quote_status === 'ready';
  const hasBookingContext = !!(priorFields.check_in && priorFields.check_out && priorFields.guest_count != null);
  if (!hasPaymentWire && !hasAddonsPending && !quoteReady && !hasBookingContext) return false;
  if (!currentResult || currentResult.message_lane === 'new_booking_inquiry') return false;
  const text = String(messageText || '');
  if (detectPackageExplainerIntent(text)) return true;
  const pc = detectPaymentChoiceFromMessage(text);
  if (pc === 'arrival_payment_question' || pc === 'payment_link_request') return true;
  if (detectServiceSideQuestionIntent(text)) return true;
  if (detectTransferSideQuestionIntent(text)) return true;
  const knowledgeIntent = detectGuestKnowledgeIntent(text);
  if (knowledgeIntent && shouldPrioritizeKnowledgeOverService(text, knowledgeIntent, priorGuestContext)) return true;
  if (detectGuestSurfReportIntent(text)
    && shouldPrioritizeSurfReportOverService(text, priorGuestContext)) return true;
  if (currentResult.message_lane === 'add_service_request') return true;
  if (currentResult.message_lane === 'transfer_request') return true;
  return false;
}

/**
 * Preserve prior ready quote/availability/booking fields when guest asks a side question
 * during an active booking quote/payment-choice flow.
 */
function mergeActiveBookingChainOutput(priorGuestContext, parts, messageText) {
  if (!parts || !isActiveBookingSideQuestion(priorGuestContext, parts.result, messageText)) {
    return parts;
  }

  const prior = normalizeGuestContextForChain(priorGuestContext);
  const priorResult = prior.result || {};
  const priorQuote = prior.quote;
  const priorAvail = prior.availability;
  const mergedFields = collectPriorExtractedFields(prior);

  // Stage 56c — preserve reactive service requests from the current router result
  // so post-booking meal/yoga attaches survive the field merge.
  const currentTurnFields = (parts.result && parts.result.extracted_fields) || {};
  const mergedExtracted = {
    ...mergedFields,
    ...(currentTurnFields.meals_request != null ? { meals_request: currentTurnFields.meals_request } : {}),
    ...(currentTurnFields.yoga_request != null ? { yoga_request: currentTurnFields.yoga_request } : {}),
  };

  const mergedResult = {
    ...parts.result,
    booking_intake_ready: priorResult.booking_intake_ready ?? parts.result.booking_intake_ready,
    readiness_state: priorResult.readiness_state || parts.result.readiness_state,
    intake_state: priorResult.intake_state || parts.result.intake_state,
    extracted_fields: mergedExtracted,
    safe_handoff_required: parts.result.message_lane === 'staff_handoff_required'
      ? parts.result.safe_handoff_required
      : false,
    handoff_reasons: parts.result.message_lane === 'staff_handoff_required'
      ? (parts.result.handoff_reasons || [])
      : [],
  };

  return {
    ...parts,
    result: mergedResult,
    quote: (priorQuote && priorQuote.quote_status === 'ready' && !prior.previous_quote_invalidated
      && !priorQuote.quote_stale)
      ? priorQuote
      : parts.quote,
    availability: (priorAvail && priorAvail.availability_check_attempted === true)
      ? priorAvail
      : parts.availability,
  };
}

/**
 * Build chain for 27m hold/payment draft planner when payment choice is ready on a
 * continuation turn (e.g. "Deposit is fine" classified as general_question).
 * Uses prior booking result/availability/quote from guest_context; current payment_choice.
 */
function buildHoldPaymentDraftPlannerChain(guestContext, currentChain) {
  const chain = currentChain || {};
  const pc = chain.payment_choice;
  if (!pc || pc.payment_choice_ready !== true) return chain;
  if (pc.next_safe_step !== 'ready_for_hold_payment_draft') return chain;

  const prior = normalizeGuestContextForChain(guestContext);
  const priorResult = prior.result;
  const priorAvailability = prior.availability;
  const priorQuote = prior.quote;

  const priorBookingReady = priorResult
    && priorResult.message_lane === 'new_booking_inquiry'
    && priorResult.booking_intake_ready === true
    && priorResult.readiness_state === 'ready_for_availability_check';
  const priorAvailReady = priorAvailability
    && priorAvailability.availability_status === 'available';
  const priorQuoteReady = priorQuote && priorQuote.quote_status === 'ready'
    && !prior.previous_quote_invalidated
    && !priorQuote.quote_stale;

  if (!priorBookingReady || !priorAvailReady || !priorQuoteReady) return chain;

  const mergedFields = collectPriorExtractedFields(prior);
  return {
    result: {
      ...priorResult,
      message_lane: 'new_booking_inquiry',
      booking_intake_ready: true,
      readiness_state: 'ready_for_availability_check',
      extracted_fields: mergedFields,
    },
    availability: priorAvailability,
    quote: priorQuote,
    payment_choice: pc,
  };
}

function parseSimulatorChainFromBody(body) {
  const src = body || {};
  const chain = src.chain || {};
  const review = src.review || {};
  return {
    result: chain.result || review.result || null,
    availability: chain.availability || review.availability || null,
    quote: chain.quote || review.quote || null,
    payment_choice: chain.payment_choice || review.payment_choice || null,
  };
}

function resolveGuestContextFromSimulatorBody(body) {
  const src = body || {};
  if (src.guest_context && typeof src.guest_context === 'object') {
    return src.guest_context;
  }
  return null;
}

function resolveSimulatorPlannerFromBody(body) {
  const src = body || {};
  const plan = src.hold_payment_draft_plan
    || (src.review && src.review.hold_payment_draft_plan)
    || (src.chain && src.chain.hold_payment_draft_plan);
  if (plan && plan.plan_status === 'ready') return plan;
  return null;
}

/**
 * Normalize simulator hold/draft write input to planner-ready booking chain (27w.5).
 */
function buildGuestSimulatorWriteChain(body) {
  const rawChain = parseSimulatorChainFromBody(body);
  const guestContext = resolveGuestContextFromSimulatorBody(body);
  const chain = buildHoldPaymentDraftPlannerChain(guestContext, rawChain);
  const planner = resolveSimulatorPlannerFromBody(body);
  return { chain, planner, guestContext };
}

module.exports = {
  mergeGuestExtractedFields,
  collectPriorExtractedFields,
  normalizeGuestContextForChain,
  stripQuotePaymentStateForReset,
  restoreBookingLaneForActiveQuote,
  isActiveBookingSideQuestion,
  mergeActiveBookingChainOutput,
  buildHoldPaymentDraftPlannerChain,
  buildGuestSimulatorWriteChain,
  parseSimulatorChainFromBody,
  resolveGuestContextFromSimulatorBody,
  resolveSimulatorPlannerFromBody,
  mergeServiceInterest,
  EXTRACTED_FIELD_KEYS,
};
