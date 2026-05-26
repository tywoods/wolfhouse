/**
 * Phase 2f — deterministic booking route resolver (pure logic for tests + n8n Code node).
 */

const RESOLVER_VERSION = '2f.4';

function safeJsonParse(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function detectMessageSignals(message) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();

  const emailMatches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  const hasGuestEmail = emailMatches.length > 0;

  const monthToken =
    '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)';
  const dateRange =
    /\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\s*[-–—to]+\s*(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/i.test(
      text
    ) ||
    new RegExp(
      `\\b(?:from\\s+)?${monthToken}[a-z]*\\s+\\d{1,2}(?:st|nd|rd|th)?\\s*[-–—to]+\\s*(?:${monthToken}[a-z]*\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\b`,
      'i'
    ).test(text) ||
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\s*[-–—to]+\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b/i.test(
      text
    );

  const hasGuestCount =
    /\b\d+\s*(people|guests|persons|pax|personas|personas|gäste|gästen|personnes)\b/i.test(text) ||
    /\b(we are|we're|somos|wir sind)\s+\d+\b/i.test(text) ||
    /\bfor\s+(\d+|two|three|four|five|six|seven|eight)\b/i.test(lower) ||
    /\b(2|two|3|three|4|four)\s+(people|guests|girls|guys|women|men)\b/i.test(lower);

  const hasRoomType =
    /\b(shared|private|dorm|double|family|own room|habitaci[oó]n privada|privada|compartida)\b/i.test(
      lower
    );

  const hasBookingIntent =
    /\b(book|reserve|reservation|booking|stay|bed|room|availability|disponib|buchen|reservar)\b/i.test(
      lower
    ) || dateRange;

  const hasPaymentClaim =
    /\b(i paid|payment done|paid already|already paid|sent (the )?payment|transfer|money sent|he pagado|ya pagu[eé])\b/i.test(
      lower
    ) || (hasGuestEmail && /\bpaid\b/i.test(lower));

  const hasAvailabilityQuestion =
    /\b(any beds|availability|available|disponible|frei|have room)\b/i.test(lower) && !dateRange;

  const hasGuestName =
    hasGuestEmail &&
    (/\bmy name is\b/i.test(lower) ||
      /\b(i am|i'm|soy|me llamo|ich bin)\s+[A-Z][a-z]+/i.test(text) ||
      /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:and\s+)?[a-z0-9._%+-]+@/i.test(text));

  const hasBookingCore = dateRange && hasGuestCount;

  return {
    has_check_in: dateRange,
    has_check_out: dateRange,
    has_guest_count: hasGuestCount,
    has_room_type: hasRoomType,
    has_guest_name: hasGuestName,
    has_guest_email: hasGuestEmail,
    has_payment_claim: hasPaymentClaim,
    has_availability_question: hasAvailabilityQuestion,
    has_booking_intent: hasBookingIntent,
    has_booking_core: hasBookingCore,
  };
}

function isHoldUsable(activeBooking) {
  if (!activeBooking?.active_booking_found) return false;
  const status = String(activeBooking.active_booking_status || activeBooking.active_booking?.status || '');
  return status === 'Hold' || status === 'Payment_Pending';
}

/** WH-* id on conversation or session — Pick Active Booking may still miss the hold. */
function getConversationHoldHint(input) {
  const conv = input.conversation || {};
  const session = input.session || safeJsonParse(conv['Session State'], {});
  const holdId =
    conv['Current Hold ID'] ||
    conv.current_hold_id ||
    session.current_hold_id ||
    session.hold_booking_id ||
    session.booking_id ||
    null;
  const id = String(holdId || '').trim();
  return id.startsWith('WH-');
}

/** Contact-only on an in-progress booking should run Search Hold even if Pick Active missed. */
function shouldAttemptHoldSearch(input, messageSignals, holdUsable) {
  if (holdUsable) return true;
  if (getConversationHoldHint(input)) return true;
  const stage = String(input.conversation_stage || '').trim();
  const hasContact = messageSignals.has_guest_email || messageSignals.has_guest_name;
  if (hasContact && (stage === 'payment_pending' || stage === 'booking_flow')) {
    return true;
  }
  return false;
}

function resolveBookingRoute(input) {
  const routerRoute = String(input.router_route || 'unknown').trim() || 'unknown';
  const routerReason = String(input.router_reason || '');
  const routerConfidence = Number(input.router_confidence || 0);
  const language = input.language || 'en';
  const guestMessage = String(input.guest_message || '').trim();
  const pendingAction = String(input.pending_action || 'none').trim() || 'none';
  const conversationStage = String(input.conversation_stage || '').trim();

  const activeBooking = input.active_booking || {};
  const holdUsable = isHoldUsable(activeBooking);
  const conversationHoldHint = getConversationHoldHint(input);
  const messageSignals = detectMessageSignals(guestMessage);

  let resolvedRoute = routerRoute;
  let routeOverridden = false;
  let overrideReason = '';
  let decisionCode = 'R2F_ROUTER_ACCEPTED';
  let resolvedSubRoute = null;
  let fallbackRoute = null;

  const existingBookingRoutes = new Set([
    'existing_booking',
    'existing_booking_modify',
    'existing_booking_cancel',
    'existing_booking_status',
  ]);

  const attemptHoldSearch = shouldAttemptHoldSearch(input, messageSignals, holdUsable);

  // Priority overrides (deterministic)
  if (routerRoute === 'payment_details_provided' && !holdUsable) {
    if (messageSignals.has_booking_core) {
      resolvedRoute = 'booking_flow';
      resolvedSubRoute = 'booking_full_capture_then_payment';
      routeOverridden = true;
      overrideReason = 'full_booking_signals_without_hold';
      decisionCode = 'R2F_FULL_BOOKING_NO_HOLD';
    } else if (
      (messageSignals.has_guest_email || messageSignals.has_guest_name) &&
      attemptHoldSearch
    ) {
      resolvedRoute = 'payment_details_provided';
      resolvedSubRoute = 'payment_details_on_existing_hold';
      routeOverridden = true;
      overrideReason = conversationHoldHint
        ? 'contact_with_conversation_hold_hint'
        : 'contact_with_in_progress_booking_stage';
      decisionCode = 'R2F_PAYMENT_DETAILS_ON_HOLD_LOOKUP';
    } else if (messageSignals.has_guest_email || messageSignals.has_guest_name) {
      resolvedRoute = 'booking_flow';
      resolvedSubRoute = 'booking_collect_missing';
      routeOverridden = true;
      overrideReason = 'contact_without_hold';
      decisionCode = 'R2F_CONTACT_NO_HOLD';
    } else {
      resolvedRoute = 'booking_flow';
      resolvedSubRoute = 'booking_collect_missing';
      routeOverridden = true;
      overrideReason = 'payment_details_without_hold';
      decisionCode = 'R2F_PAYMENT_DETAILS_NO_HOLD';
      fallbackRoute = 'booking_flow';
    }
  }

  if (
    routerRoute === 'payment_details_provided' &&
    holdUsable &&
    messageSignals.has_booking_core &&
    !routeOverridden
  ) {
    resolvedRoute = 'booking_flow';
    resolvedSubRoute = 'booking_full_capture_then_payment';
    routeOverridden = true;
    overrideReason = 'full_booking_in_one_message_with_hold';
    decisionCode = 'R2F_FULL_BOOKING_WITH_HOLD';
  }

  if (routerRoute === 'rooming_details_provided') {
    const roomingPending = pendingAction === 'rooming_info_needed';
    if (!holdUsable && !roomingPending) {
      if (messageSignals.has_booking_core) {
        resolvedRoute = 'booking_flow';
        resolvedSubRoute = 'booking_check_availability';
        routeOverridden = true;
        overrideReason = 'rooming_without_hold_but_booking_core';
        decisionCode = 'R2F_ROOMING_TO_BOOKING_CORE';
      } else {
        resolvedRoute = 'booking_flow';
        resolvedSubRoute = 'booking_collect_missing';
        routeOverridden = true;
        overrideReason = 'rooming_without_hold';
        decisionCode = 'R2F_ROOMING_NO_HOLD';
      }
    }
  }

  if (
    !routeOverridden &&
    messageSignals.has_booking_core &&
    !holdUsable &&
    (routerRoute === 'payment_details_provided' || routerRoute === 'unknown')
  ) {
    resolvedRoute = 'booking_flow';
    resolvedSubRoute = 'booking_full_capture_then_payment';
    routeOverridden = true;
    overrideReason = 'booking_core_without_hold';
    decisionCode = 'R2F_FULL_BOOKING_NO_HOLD';
  }

  if (!routeOverridden && routerRoute === 'payment_details_provided' && holdUsable) {
    resolvedSubRoute = 'payment_details_on_existing_hold';
    decisionCode = 'R2F_PAYMENT_DETAILS_ON_HOLD';
  }

  if (!routeOverridden && existingBookingRoutes.has(routerRoute)) {
    decisionCode = activeBooking.active_booking_found
      ? 'R2F_EXISTING_BOOKING_ROUTE'
      : 'R2F_EXISTING_BOOKING_LOOKUP';
  }

  if (!routeOverridden && routerRoute === 'payment_completed_claim') {
    decisionCode = 'R2F_PAYMENT_CLAIM';
  }

  if (!routeOverridden && routerRoute === 'general_question') {
    decisionCode = 'R2F_GENERAL_QUESTION';
  }

  if (!routeOverridden && routerRoute === 'booking_flow') {
    resolvedSubRoute = messageSignals.has_booking_core
      ? 'booking_check_availability'
      : 'booking_collect_missing';
    decisionCode = 'R2F_BOOKING_FLOW';
  }

  const shouldSearchHold =
    resolvedRoute === 'payment_details_provided' && attemptHoldSearch;

  const missingForAvailability = [];
  if (!messageSignals.has_check_in) missingForAvailability.push('check_in');
  if (!messageSignals.has_check_out) missingForAvailability.push('check_out');
  if (!messageSignals.has_guest_count) missingForAvailability.push('guest_count');

  const stagedContact = {
    guest_name: messageSignals.has_guest_name ? 'detected' : null,
    guest_email: messageSignals.has_guest_email
      ? (guestMessage.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0] || null
      : null,
    apply_after_hold: false,
  };

  const hasStagedGuestContact =
    messageSignals.has_guest_email ||
    messageSignals.has_guest_name ||
    !!(input.session?.name && input.session?.email);

  const hasFullCaptureSignals =
    messageSignals.has_booking_core ||
    (messageSignals.has_guest_count &&
      messageSignals.has_guest_email &&
      (messageSignals.has_check_in ||
        messageSignals.has_room_type ||
        messageSignals.has_booking_intent));

  if (
    resolvedRoute === 'booking_flow' &&
    hasStagedGuestContact &&
    (hasFullCaptureSignals || resolvedSubRoute === 'booking_full_capture_then_payment')
  ) {
    stagedContact.apply_after_hold = true;
  }

  return {
    resolver_version: RESOLVER_VERSION,
    route: routerRoute,
    resolved_route: resolvedRoute,
    resolved_sub_route: resolvedSubRoute,
    router_route: routerRoute,
    route_overridden: routeOverridden,
    override_reason: overrideReason,
    language,
    reason: routerReason,
    confidence: routerConfidence,
    guest_message: guestMessage,
    intent: resolvedRoute,
    session: input.session || {},

    booking_state: {
      phase: holdUsable || conversationHoldHint ? 'hold_active' : 'pre_hold',
      active_hold_found: holdUsable,
      active_hold_hint: conversationHoldHint,
      active_hold_id:
        activeBooking.active_booking_id ||
        (conversationHoldHint
          ? input.conversation?.['Current Hold ID'] ||
            input.conversation?.current_hold_id ||
            input.session?.current_hold_id ||
            input.session?.hold_booking_id ||
            null
          : null),
      active_booking_record_id: activeBooking.active_booking_record_id || null,
      active_booking_status: activeBooking.active_booking_status || null,
      pending_action: pendingAction,
      conversation_stage: conversationStage,
    },

    message_signals: messageSignals,
    missing_for_availability: missingForAvailability,
    missing_for_payment: shouldSearchHold ? [] : ['hold'],

    staged_contact: stagedContact,

    hold_lookup: {
      should_search_hold: shouldSearchHold,
      expected_hold_statuses: ['Hold', 'Payment_Pending'],
      search_phone: input.phone || null,
      search_current_hold_id:
        activeBooking.active_booking_id ||
        input.conversation?.['Current Hold ID'] ||
        input.conversation?.current_hold_id ||
        input.session?.current_hold_id ||
        input.session?.hold_booking_id ||
        null,
    },

    logging: {
      decision_code: decisionCode,
      fallback_route: fallbackRoute,
    },
  };
}

/** Build n8n Code node body (uses $() references). */
function buildN8nResolverJsCode() {
  return `const RESOLVER_VERSION = '${RESOLVER_VERSION}';

function safeJsonParse(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

${detectMessageSignals.toString()}

${isHoldUsable.toString()}

${getConversationHoldHint.toString()}

${shouldAttemptHoldSearch.toString()}

${resolveBookingRoute.toString()}

const parseRoute = $('Code - Parse Route').first().json;
const pickActive = $('Code - Pick Active Booking').first().json;
const conversation = $('Search Conversation').first().json.fields || {};

const result = resolveBookingRoute({
  router_route: parseRoute.route,
  router_reason: parseRoute.reason,
  router_confidence: parseRoute.confidence,
  language: parseRoute.language,
  guest_message: parseRoute.guest_message,
  pending_action: conversation['Pending Action'] || 'none',
  conversation_stage: conversation['Conversation Stage'] || '',
  phone: $('Normalize Incoming Message').first().json.phone || '',
  session: parseRoute.session || safeJsonParse(conversation['Session State'], {}),
  conversation,
  active_booking: pickActive,
});

const merged = {
  ...parseRoute,
  ...result,
  route: result.resolved_route,
};

const logWorkflowEvent = String($env.PHASE2F_LOG_WORKFLOW_EVENTS || 'false').toLowerCase() === 'true';
if (logWorkflowEvent) {
  try {
    await this.helpers.httpRequest({
      method: 'POST',
      url: 'http://localhost:5678/webhook/phase2f-resolver-log',
      body: merged,
      json: true,
      timeout: 2000,
    });
  } catch (_) {
    // never block booking flow
  }
}

return [{ json: merged }];`;
}

module.exports = {
  RESOLVER_VERSION,
  detectMessageSignals,
  isHoldUsable,
  getConversationHoldHint,
  shouldAttemptHoldSearch,
  resolveBookingRoute,
  buildN8nResolverJsCode,
};
