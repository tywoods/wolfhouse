'use strict';

/**
 * Stage 28j.6 / 30a — Luna Reply Composer (booking conversations).
 *
 * Owns guest-facing copy for the main new-booking flow. Business modules supply
 * structured facts; this module returns natural Luna copy grounded in those facts.
 */

const { collectPriorExtractedFields, mergeGuestExtractedFields } = require('./luna-guest-context-merge');
const { computeStayNights, isAccommodationOnlyIntent } = require('./wolfhouse-package-night-rules');
const {
  detectPackageExplainerIntent,
  resolvePackageExplainerIntent,
  buildPackageExplainerReply,
} = require('./luna-guest-package-explainer');
const {
  detectServiceSideQuestionIntent,
  detectTransferSideQuestionIntent,
  buildServiceSideQuestionReply,
  buildTransferSideQuestionReply,
  isPackageBooking,
} = require('./luna-guest-service-transfer-explainer');
const {
  buildReactiveServiceComposerReply,
} = require('./luna-booking-reactive-services-policy');
const {
  buildBookingIntakePolicySnapshot,
  mapPolicyQuestionToComposerState,
  inferRoomPreferenceNeed,
} = require('./luna-booking-intake-policy');
const { extractQuoteFactsFromPayload } = require('./luna-quote-facts');
const { quoteChainIsStale } = require('./luna-booking-state-transitions');
const {
  isVagueMonthAvailabilityQuestion,
  isRelativeDatePhraseNeedingClarification,
  extractVagueMonthLabel,
} = require('./luna-guest-message-router');
const {
  quoteAwaitingAddonsDecision,
  buildMidFlowAddonsReturnTail,
  buildManualAddonsNote,
  classifyServiceInterestPricing,
  extractAddOnSelections,
  isExplicitAddonSelectionMessage,
} = require('./luna-booking-addons-policy');
const {
  FORBIDDEN_GUEST_COPY_RE,
  sanitizeGuestReply,
  validateComposerFacts,
  LUNA_IDENTITY,
} = require('./luna-guest-reply-style-contract');
const {
  buildPersonalityReplyLexicon,
  resolveActivePersonality,
  buildWelcomeReply,
} = require('./luna-guest-personality-config');
const {
  buildVariationContext,
  applyCamiReplyVariation,
  recordCamiPhraseUsage,
} = require('./luna-guest-cami-reply-variation');
const {
  buildPaymentShortLink,
  resolveGuestPaymentLinkUrl,
  buildPaymentLinkObservability,
} = require('./luna-payment-short-link');
const {
  buildAddonPaymentChoiceReply,
  buildAddonServiceObservability,
} = require('./luna-guest-addon-service-confirmation-policy');
const {
  detectGuestKnowledgeIntent,
  shouldPrioritizeKnowledgeOverService,
  buildGuestKnowledgeReply,
} = require('./luna-guest-knowledge-config');
const {
  detectGuestSurfReportIntent,
  shouldPrioritizeSurfReportOverService,
  buildGuestSurfReportReply,
} = require('./luna-guest-surf-report');

const COMPOSER_STATES = Object.freeze([
  'greeting',
  'ask_dates',
  'confirm_dates',
  'ask_guests',
  'ask_guest_name',
  'ask_package',
  'ask_room_preference_girls_mixed',
  'ask_room_preference_private_shared',
  'ask_room_preference_neutral',
  'ask_transfer_info_casual',
  'ask_package_choice',
  'explain_packages',
  'explain_service_addon',
  'explain_transfer',
  'explain_house_knowledge',
  'explain_surf_report',
  'accommodation_quote_ready',
  'package_quote_ready',
  'quote_refreshing',
  'ask_addons_after_quote',
  'addons_none_confirmed',
  'ask_payment_choice',
  'answer_arrival_payment_question',
  'payment_choice_ack',
  'payment_choice_received_hold_created',
  'stripe_test_link_created',
  'payment_link_sent',
  'payment_pending_no_link',
  'payment_link_failed',
  'payment_received_preview_ready',
  'confirmation_sent_ack',
  'clarify_missing_info',
  'contextual_pending_answer',
  'safe_handoff',
]);

const PACKAGE_NAMES_RE = /\b(?:Malibu|Uluwatu|Waimea)\b/i;

const COMPOSER_SAFETY = Object.freeze({
  dry_run: true,
  preview_only: true,
  no_write_performed: true,
  sends_whatsapp: false,
  creates_booking: false,
  creates_stripe_link: false,
  payment_link_sent: false,
  confirmation_sent: false,
  calls_n8n: false,
});

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function langOf(result) {
  return (result && result.detected_language) || 'en';
}

function formatEur(cents) {
  if (cents == null || !Number.isFinite(Number(cents))) return null;
  const n = Number(cents);
  const euros = n / 100;
  if (n % 100 === 0) return `€${euros}`;
  return `€${euros.toFixed(2)}`;
}

function formatDateShort(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const mi = Number(m[2]) - 1;
  return `${months[mi] || m[2]} ${Number(m[3])}`;
}

function formatDateRange(checkIn, checkOut) {
  const a = formatDateShort(checkIn);
  const b = formatDateShort(checkOut);
  if (a && b) return `${a} to ${b}`;
  if (a) return a;
  return '';
}

function guestCountLabel(count, lang) {
  const n = Number(count);
  if (!Number.isFinite(n) || n < 1) return null;
  if (n === 1) {
    return lang === 'de' ? '1 Gast' : lang === 'it' ? '1 ospite' : lang === 'es' ? '1 huésped' : '1 guest';
  }
  return `${n} guests`;
}

function depositCentsFromPayload(quote, plan, pc) {
  if (plan && plan.payment_amount_cents != null && (pc || {}).payment_choice === 'deposit') {
    return plan.payment_amount_cents;
  }
  const dep = quote && quote.deposit_options && quote.deposit_options.deposit_required_cents;
  if (dep != null) return dep;
  return null;
}

function sanitizeComposerReply(text) {
  return sanitizeGuestReply(text);
}

function isShortStayAccommodation(result, quote, fields) {
  if (result && result.package_night_rule === 'short_stay_accommodation') return true;
  const nights = computeStayNights(fields.check_in, fields.check_out);
  if (nights != null && nights < 7) {
    const pkg = fields.package_interest || fields.package_code;
    if (!pkg || pkg === 'accommodation_only' || pkg === 'package_none' || pkg === 'no_package') {
      return true;
    }
  }
  return isAccommodationOnlyIntent(fields.package_interest);
}

function hasWeeklyPackageSelected(fields) {
  const pkg = trimStr(fields.package_interest || fields.package_code).toLowerCase();
  return pkg && pkg !== 'no_package' && pkg !== 'package_none' && pkg !== 'accommodation_only';
}

function hasPackageOrStayIntent(fields) {
  const pi = trimStr(fields && (fields.package_interest || fields.package_code)).toLowerCase();
  if (!pi) return false;
  return pi === 'no_package'
    || pi === 'accommodation_only'
    || pi === 'custom'
    || ['malibu', 'uluwatu', 'waimea'].includes(pi);
}

function needsPackageStayTypeChoice(fields, result) {
  if (!result || result.message_lane !== 'new_booking_inquiry') return false;
  if (!fields.check_in || !fields.check_out) return false;
  if (fields.guest_count == null || fields.guest_count < 1) return false;
  return !hasPackageOrStayIntent(fields);
}

function needsPackageChoice(fields, result, quote) {
  if (isShortStayAccommodation(result, quote, fields)) return false;
  const nights = computeStayNights(fields.check_in, fields.check_out);
  if (nights == null || nights < 7) return false;
  if (fields.guest_count == null || !fields.check_in || !fields.check_out) return false;
  if (hasWeeklyPackageSelected(fields)) return false;
  if (quote && quote.quote_status === 'ready') return false;
  return true;
}

function stripLegacyActionDisclaimers(text) {
  return trimStr(text)
    .replace(/\s*I am not (?:adding|confirming|creating|arranging|organizing)[^.]*\.?/gi, '')
    .replace(/\s*I(?:'m| am) not (?:adding|confirming|creating|arranging)[^.]*\.?/gi, '')
    .replace(/\s*Non (?:sto|aggiungo)[^.]*\.?/gi, '')
    .replace(/\s*Aún no [^.]*\.?/gi, '')
    .trim();
}

function buildStayContextPhrase(fields, lang) {
  const range = formatDateRange(fields.check_in, fields.check_out);
  const guests = guestCountLabel(fields.guest_count, lang);
  if (range && guests) return `${range} for ${guests}`;
  if (range) return range;
  return '';
}

function buildPackageChoiceReturnTail(fields, lang, pkgIntent) {
  const ctx = buildStayContextPhrase(fields, lang);
  if (pkgIntent === 'malibu') {
    return ctx ? `Want me to check Malibu for ${ctx}?` : 'Want me to check Malibu for you?';
  }
  if (!ctx) return 'Which one sounds best — Malibu, Uluwatu, or Waimea?';
  return `For ${ctx}, Malibu is probably the easiest one to start with. Want me to check Malibu for you?`;
}

function buildServiceReturnTail(fields, quote) {
  return buildMidFlowAddonsReturnTail(fields, 'en', quote);
}

function transferBodyHasReassurance(text) {
  return /\b(?:no stress|no worries|don(?:'|')?t worry|all good|no problem)\b/i.test(String(text || ''));
}

function stripReassuranceOpenerFromTail(tail) {
  let s = String(tail || '').trim();
  s = s.replace(/^No stress,\s*/i, '');
  s = s.replace(/^No worries,\s*/i, '');
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function finalizeTransferReturnTail(tail, bodyText) {
  if (!tail) return tail;
  return transferBodyHasReassurance(bodyText)
    ? stripReassuranceOpenerFromTail(tail)
    : tail;
}

function buildTransferReturnTail(fields, pc, messageText, bodyText) {
  if (isPackageBooking(fields.package_interest)) {
    if (pc && pc.payment_choice_ready === true) {
      return 'We can still hold your booking first.';
    }
    return 'We can still hold the booking first — just let me know when you have flight details.';
  }
  const t = String(messageText || '');
  let tail;
  if (/\b(?:bus\s+station|estaci[oó]n\s+de\s+autobuses|stazione\s+(?:dei|degli?\s+)?autobus)\b/i.test(t)) {
    tail = 'Then we can keep going with the booking 😊';
  } else if (/\b(?:flight\s+(?:is\s+)?(?:delayed|late)|delayed\s+flight|late\s+arrival|arriv(?:e|ing)\s+(?:late|around|after))\b/i.test(t)) {
    tail = 'No stress, we\'ll keep the booking moving from there.';
  } else if (/\b(?:Santander|Bilbao|SDR|BIO|airport|flight details|pickup|transfer)\b/i.test(t)) {
    tail = 'Send me your flight details and we\'ll keep going from there 👍';
  } else {
    const softTails = [
      'Then we can keep going with the booking 😊',
      'No stress, we\'ll keep the booking moving from there.',
      'Send your updated time and we\'ll sort it from there 👍',
    ];
    const seed = String((fields && fields.check_in) || '') + String((fields && fields.guest_count) || '');
    tail = softTails[seed.length % softTails.length];
  }
  return finalizeTransferReturnTail(tail, bodyText);
}

function buildExplainPackagesReply(lang, pkgIntent, fields) {
  const intent = pkgIntent || 'overview';
  const bookingInProgress = !!(fields && fields.check_in && fields.check_out);
  if (intent === 'overview' || intent === 'compare' || intent === 'recommend') {
    let body = buildPackageExplainerReply(lang, intent, { bookingInProgress: false });
    body = stripLegacyActionDisclaimers(body);
    const tail = hasWeeklyPackageSelected(fields)
      ? `For your ${buildStayContextPhrase(fields, lang)} stay, want to stick with your package or switch?`
      : buildPackageChoiceReturnTail(fields, lang, intent);
    return tail ? `${body}\n\n${tail}` : body;
  }
  let body = buildPackageExplainerReply(lang, intent, { bookingInProgress });
  body = stripLegacyActionDisclaimers(body);
  const tail = buildPackageChoiceReturnTail(fields, lang, intent);
  return tail ? `${body}\n\n${tail}` : body;
}

function buildComposerServiceReply(lang, intent, fields, quote) {
  if (intent === 'yoga' || intent === 'meals') {
    const reactive = buildReactiveServiceComposerReply(lang, intent, fields, quote);
    if (reactive) return reactive;
  }
  const raw = buildServiceSideQuestionReply(lang, intent, '');
  const facts = stripLegacyActionDisclaimers(raw);
  const tail = buildMidFlowAddonsReturnTail(fields, lang, quote);
  if (!facts) return null;
  return tail ? `${facts} ${tail}` : facts;
}

function buildComposerTransferReply(lang, messageText, fields, pc) {
  const raw = buildTransferSideQuestionReply(lang, messageText, {
    packageInterest: fields.package_interest,
    guestCount: fields.guest_count,
  });
  const facts = stripLegacyActionDisclaimers(raw);
  const tail = buildTransferReturnTail(fields, pc, messageText, facts);
  if (!facts) return null;
  return tail ? `${facts} ${tail}` : facts;
}

function isBookingFlowLane(result) {
  if (!result) return false;
  if (result.message_lane === 'new_booking_inquiry') return true;
  if (result.message_lane === 'general_question') return true;
  if (result.message_lane === 'checkin_house_info_question') return true;
  if (result.greeting_only === true) return true;
  return false;
}

function messageLooksLikeDates(text) {
  return /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}[/-]\d|\d{4})\b/i.test(trimStr(text));
}

function buildDateClarificationReply(messageText) {
  const t = trimStr(messageText);
  if (!t) return null;
  if (isVagueMonthAvailabilityQuestion(t)) {
    const month = extractVagueMonthLabel(t);
    if (month) return `Sure — what exact check-in and check-out dates in ${month}?`;
    return 'What dates are you looking at?';
  }
  if (isRelativeDatePhraseNeedingClarification(t)) {
    return 'Just to be sure, what exact check-in and check-out dates?';
  }
  return null;
}

function isGuestCountCorrection(result) {
  if (!result || result.previous_quote_invalidated !== true) return false;
  const fields = result.corrected_fields;
  return Array.isArray(fields) && fields.includes('guest_count');
}

function isDateCorrection(result) {
  if (!result || result.previous_quote_invalidated !== true) return false;
  const fields = result.corrected_fields;
  return Array.isArray(fields)
    && (fields.includes('check_in') || fields.includes('check_out'));
}

function isPackageCorrection(result) {
  if (!result || result.previous_quote_invalidated !== true) return false;
  const fields = result.corrected_fields;
  return Array.isArray(fields) && fields.includes('package_interest');
}

function buildDateCorrectionPaymentReply(fields, quote, plan, pc) {
  const range = formatDateRange(fields.check_in, fields.check_out);
  const total = formatEur(quote && quote.quote_total_cents);
  const deposit = formatEur(depositCentsFromPayload(quote, plan, pc));
  if (!total) return null;
  const datePhrase = range ? ` for ${range}` : '';
  if (!deposit) {
    return `Got it — updating those dates${datePhrase}. The stay comes to ${total}.`;
  }
  return `Got it — updating those dates${datePhrase}. The stay comes to ${total}. To hold the spot, would you prefer to pay the ${deposit} deposit now, or pay the full ${total}?`;
}

function buildDateCorrectionAddonsReply(fields, quote) {
  const range = formatDateRange(fields.check_in, fields.check_out);
  const total = formatEur(quote && quote.quote_total_cents);
  if (!total) return null;
  const datePhrase = range ? ` for ${range}` : '';
  return `Got it — updating those dates${datePhrase}. The accommodation comes to ${total}. Are you going to need a wetsuit, surfboard, and/or lessons, or just the stay?`;
}

function buildGuestCountCorrectionAddonsReply(fields, quote, plan, pc) {
  const range = formatDateRange(fields.check_in, fields.check_out);
  const guests = guestCountLabel(fields.guest_count, 'en');
  const total = formatEur(quote && quote.quote_total_cents);
  if (!total || !guests) return null;
  const datePhrase = range ? ` for ${range}` : '';
  return `Got it — updating that to ${guests}. The accommodation${datePhrase} comes to ${total}. Are you going to need a wetsuit, surfboard, and/or lessons, or just the stay?`;
}

function buildGuestCountCorrectionPaymentReply(fields, quote, plan, pc) {
  const guests = guestCountLabel(fields.guest_count, 'en');
  const total = formatEur(quote && quote.quote_total_cents);
  const deposit = formatEur(depositCentsFromPayload(quote, plan, pc));
  if (!total || !guests) return null;
  if (!deposit) {
    return `Got it — updating that to ${guests}. The stay comes to ${total}.`;
  }
  return `Got it — updating that to ${guests}. The stay comes to ${total}. To hold the spot, would you prefer to pay the ${deposit} deposit now, or pay the full ${total}?`;
}

function resolveComposerDisplayFields(input, payload, quote, result) {
  const fields = mergeGuestExtractedFields(
    collectPriorExtractedFields(input && input.prior_guest_context),
    result.extracted_fields || {},
  );
  if (quote && quote.quote_status === 'ready') {
    if (quote.package_code) fields.package_interest = quote.package_code;
    if (quote.check_in) fields.check_in = quote.check_in;
    if (quote.check_out) fields.check_out = quote.check_out;
    if (quote.guest_count != null) fields.guest_count = quote.guest_count;
  } else if (result.previous_quote_invalidated === true && quote && quote.prior_package_code) {
    // Never display stale package label after correction when fresh quote is pending.
    if (fields.package_interest && normalizePackage(fields.package_interest) === normalizePackage(quote.prior_package_code)) {
      fields.package_interest = null;
    }
  }
  return fields;
}

function normalizePackage(value) {
  const v = trimStr(value).toLowerCase();
  return v || null;
}

function quotePayloadIsStale(payload, result, quote) {
  // A fresh ready quote on this turn supersedes prior invalidation flags.
  if (quote.quote_status === 'ready' && quote.quote_stale !== true) return false;
  if (result.previous_quote_invalidated === true && quote.quote_status !== 'ready') return true;
  if (quote.quote_stale === true && quote.quote_status !== 'ready') return true;
  if (quoteChainIsStale({ quote, ...result }) && quote.quote_status !== 'ready') return true;
  return false;
}

function buildComposerFacts(quote, plan, pc, stripe, live, clientSlug) {
  const pt = (live && live.paymentTruth) || {};
  const cp = (live && live.confirmationPreview) || {};
  const cs = (live && live.confirmationSend) || {};
  const bookingCode = pt.booking_code
    || (stripe && stripe.booking_code)
    || (live && live.bookingWrite && live.bookingWrite.booking_code);
  const stripeCheckoutUrl = stripe && stripe.stripe_checkout_url;
  const paymentShortUrl = buildPaymentShortLink({
    booking_code: bookingCode,
    client_slug: clientSlug,
  });
  return {
    quote_total_cents: quote && quote.quote_total_cents,
    deposit_amount_cents: depositCentsFromPayload(quote, plan, pc),
    balance_due_cents: pt.balance_due_cents != null ? pt.balance_due_cents : quote && quote.balance_due_cents,
    amount_paid_cents: pt.amount_paid_cents,
    payment_status: pt.payment_status,
    payment_link_url: stripeCheckoutUrl,
    payment_short_url: paymentShortUrl,
    booking_code: bookingCode,
    room_label: pt.room_label || cp.room_label,
    confirmation_preview_ready: cp.confirmation_preview_ready === true,
    confirmation_sent: cs.confirmation_sent === true,
    hold_created: live && live.bookingWrite
      && (live.bookingWrite.write_status === 'created' || live.bookingWrite.write_status === 'reused_existing'),
  };
}

/**
 * Classify composer state from orchestrator/review payload.
 */
function resolveComposerState(input) {
  const inp = input || {};
  const payload = inp.payload || {};
  const result = payload.result || {};
  const quote = payload.quote || {};
  const availability = payload.availability || {};
  const pc = payload.payment_choice || {};
  const plan = payload.hold_payment_draft_plan || {};
  const gate = payload.gate || {};
  const messageText = trimStr(inp.message_text);
  const mode = inp.mode || 'orchestrator';
  const live = inp.live_outcomes || {};
  const bw = live.bookingWrite || {};
  const stripe = live.stripeLink || {};
  const plSend = live.paymentLinkSend || {};
  const pt = live.paymentTruth || {};
  const cp = live.confirmationPreview || {};
  const cs = live.confirmationSend || {};
  const fields = resolveComposerDisplayFields(inp, payload, quote, result);

  if (quotePayloadIsStale(payload, result, quote)
    && result.message_lane === 'new_booking_inquiry'
    && pc.payment_choice_ready !== true) {
    return 'quote_refreshing';
  }

  if (gate.gate_status && gate.gate_status !== 'allowed_dry_run') return null;

  if (result.greeting_only === true
    || (inp.brain_decision && inp.brain_decision.intent === 'greeting')) {
    return 'greeting';
  }

  const clientSlugForKnowledge = trimStr(inp.client_slug)
    || trimStr(inp.prior_guest_context && inp.prior_guest_context.client_slug)
    || 'wolfhouse-somo';
  if (detectGuestSurfReportIntent(messageText)
    && shouldPrioritizeSurfReportOverService(messageText, inp.prior_guest_context)) {
    return 'explain_surf_report';
  }

  const knowledgeIntent = detectGuestKnowledgeIntent(messageText);
  if (knowledgeIntent && shouldPrioritizeKnowledgeOverService(messageText, knowledgeIntent, inp.prior_guest_context)) {
    return 'explain_house_knowledge';
  }

  if (!isBookingFlowLane(result)) return null;

  function resolveServiceSideQuestionIntent() {
    if (isExplicitAddonSelectionMessage(messageText)) return null;
    if (quoteAwaitingAddonsDecision(quote) && extractAddOnSelections(messageText).length > 0) {
      return null;
    }
    return detectServiceSideQuestionIntent(messageText)
      || (result.message_lane === 'add_service_request' ? 'services_general' : null);
  }

  const serviceIntentEarly = resolveServiceSideQuestionIntent();
  if (serviceIntentEarly && fields.check_in && fields.check_out) {
    return 'explain_service_addon';
  }

  const transferIntentEarly = detectTransferSideQuestionIntent(messageText)
    || (result.message_lane === 'transfer_request' ? 'transfer_general' : null);
  if (transferIntentEarly && fields.check_in && fields.check_out) {
    return 'explain_transfer';
  }

  if (result.safe_handoff_required === true
    || payload.proposed_next_action === 'staff_handoff_required') {
    return 'safe_handoff';
  }

  const channelGuestName = trimStr(
    (inp.prior_guest_context && inp.prior_guest_context.contact_name)
    || (inp.prior_guest_context && inp.prior_guest_context.whatsapp_guest_name)
    || (inp.prior_guest_context && inp.prior_guest_context.channel_guest_name)
    || (inp.prior_guest_context && inp.prior_guest_context.guest_name),
  );
  const policy = result.booking_intake_policy || buildBookingIntakePolicySnapshot(
    { extracted_fields: fields, package_night_rule: result.package_night_rule },
    {
      channel_guest_name: channelGuestName,
      quote,
      payment_choice: pc,
      availability,
    },
  );

  const serviceIntent = serviceIntentEarly || resolveServiceSideQuestionIntent();
  if (serviceIntent && fields.check_in && fields.check_out) {
    return 'explain_service_addon';
  }

  const transferIntent = transferIntentEarly
    || detectTransferSideQuestionIntent(messageText)
    || (result.message_lane === 'transfer_request' ? 'transfer_general' : null);
  if (transferIntent && fields.check_in && fields.check_out) {
    return 'explain_transfer';
  }

  const pkgIntentEarly = resolvePackageExplainerIntent(messageText, inp.brain_decision);
  if (pkgIntentEarly) {
    const directPackageInfo = [
      'overview', 'malibu', 'uluwatu', 'waimea', 'compare', 'recommend',
      'choice_beginner', 'choice_experienced', 'what_to_bring',
    ].includes(pkgIntentEarly);
    if (fields.check_in && fields.check_out) return 'explain_packages';
    if (directPackageInfo) return 'explain_packages';
  }

  if (mode === 'live_staging') {
    if (cs.confirmation_sent === true) return 'confirmation_sent_ack';
    if (cp.confirmation_preview_ready === true
      && (pt.payment_status === 'deposit_paid' || pt.payment_status === 'paid')) {
      return 'payment_received_preview_ready';
    }
  }

  if (pc.payment_choice === 'arrival_payment_question' && pc.payment_choice_detected === true) {
    return 'answer_arrival_payment_question';
  }

  if (pc.payment_choice_ready === true) {
    if (mode === 'live_staging') {
      const writeOk = bw.write_status === 'created' || bw.write_status === 'reused_existing';
      if (writeOk) {
        if (plSend.payment_link_sent === true) return 'payment_link_sent';
        if (stripe.stripe_link_created === true || stripe.stripe_link_reused === true) {
          return 'stripe_test_link_created';
        }
        if (stripe.stripe_link_attempted === true && stripe.stripe_link_created !== true) {
          return 'payment_link_failed';
        }
        return 'payment_pending_no_link';
      }
      if (plan.plan_status === 'ready') return 'payment_pending_no_link';
    }
    return 'payment_choice_ack';
  }

  if (quote.quote_status === 'ready' && quoteAwaitingAddonsDecision(quote)) {
    if (hasWeeklyPackageSelected(fields)) return 'package_quote_ready';
    return 'accommodation_quote_ready';
  }

  if (quote.quote_status === 'ready' && !quoteAwaitingAddonsDecision(quote)
    && !isShortStayAccommodation(result, quote, fields)
    && availability.availability_status === 'available'
    && quote.payment_choice_needed === true
    && pc.payment_choice_ready !== true
    && !quote.quote_stale) {
    return 'package_quote_ready';
  }

  if (quote.quote_status === 'ready' && quote.payment_choice_needed === true
    && pc.payment_choice_ready !== true
    && policy.add_ons_status === 'collected'
    && !quoteAwaitingAddonsDecision(quote)
    && !isShortStayAccommodation(result, quote, fields)) {
    return 'ask_payment_choice';
  }

  if (quote.quote_status === 'ready' && quote.payment_choice_needed === true
    && pc.payment_choice_ready !== true
    && policy.add_ons_status !== 'pending'
    && !quoteAwaitingAddonsDecision(quote)
    && isShortStayAccommodation(result, quote, fields)) {
    if (policy.add_ons_status === 'declined') {
      return 'addons_none_confirmed';
    }
    if (policy.room_preference_needed && !trimStr(fields.room_preference)) {
      const roomNeed = inferRoomPreferenceNeed(
        { extracted_fields: fields, package_night_rule: result.package_night_rule },
        { availability },
      );
      let roomQuestion = null;
      if (roomNeed.question_type === 'private_or_shared') roomQuestion = 'ask_room_preference_private_shared';
      else if (roomNeed.question_type === 'girls_or_mixed' || roomNeed.question_type === 'mixed_only_female') {
        roomQuestion = 'ask_room_preference_girls_mixed';
      } else if (roomNeed.question_type === 'neutral_shared') roomQuestion = 'ask_room_preference_neutral';
      const roomState = mapPolicyQuestionToComposerState(roomQuestion);
      if (roomState) return roomState;
    }
    return 'ask_payment_choice';
  }

  const missing = result.missing_required_fields || [];
  if ((!fields.check_in || !fields.check_out
    || missing.includes('check_in') || missing.includes('check_out'))
    && result.message_lane === 'new_booking_inquiry') {
    return 'ask_dates';
  }

  if (fields.check_in && fields.check_out
    && (fields.guest_count == null || missing.includes('guest_count'))
    && messageLooksLikeDates(messageText)
    && result.message_lane === 'new_booking_inquiry') {
    return 'confirm_dates';
  }

  if (fields.check_in && fields.check_out
    && (fields.guest_count == null || missing.includes('guest_count'))
    && result.message_lane === 'new_booking_inquiry') {
    return 'ask_guests';
  }

  if (needsPackageStayTypeChoice(fields, result)) {
    return 'ask_package';
  }

  const guestName = trimStr(fields.guest_name) || channelGuestName;
  if (fields.check_in && fields.check_out
    && !guestName
    && (missing.includes('guest_name') || (result.readiness_missing_fields || []).includes('guest_name'))
    && result.message_lane === 'new_booking_inquiry'
    && quote.quote_status !== 'ready') {
    return 'ask_guest_name';
  }

  if (needsPackageChoice(fields, result, quote)) {
    return 'ask_package_choice';
  }

  if (result.readiness_state === 'collecting_required_details'
    && payload.proposed_next_action === 'ask_missing_details') {
    return 'clarify_missing_info';
  }

  if (/\bwhen\b/i.test(messageText) && fields.check_in && fields.check_out) {
    return 'contextual_pending_answer';
  }

  return null;
}

function buildPaymentChoicePersonalityCtx(fields, lang, total, deposit) {
  const cls = classifyServiceInterestPricing(fields.service_interest);
  const manualNote = cls.pending_manual.length
    ? `\n\n${buildManualAddonsNote(lang, cls.pending_manual)}`
    : '';
  const hasCollectedAddons = cls.priced.length + cls.pending_manual.length > 0;
  return { deposit, total, hasCollectedAddons, manualNote };
}

function buildReplyForState(state, ctx) {
  const {
    lang, fields, quote, plan, pc, result, availability, stripe, allowIntro, messageText, facts, pkgIntent,
    client_slug: clientSlug, prior_guest_context: priorGuestContext,
  } = ctx;
  const range = formatDateRange(fields.check_in, fields.check_out);
  const guests = guestCountLabel(fields.guest_count, lang);
  const total = formatEur(quote && quote.quote_total_cents);
  const deposit = formatEur(depositCentsFromPayload(quote, plan, pc));
  const stripeCheckoutUrl = stripe && stripe.stripe_checkout_url ? trimStr(stripe.stripe_checkout_url) : '';
  const bookingCode = facts && facts.booking_code
    ? trimStr(facts.booking_code)
    : (stripe && stripe.booking_code ? trimStr(stripe.booking_code) : '');
  const checkoutUrl = resolveGuestPaymentLinkUrl({
    booking_code: bookingCode,
    stripe_checkout_url: stripeCheckoutUrl,
    client_slug: clientSlug,
  }) || stripeCheckoutUrl;
  const packageName = trimStr(fields.package_interest || fields.package_code);
  const paid = formatEur(facts && facts.amount_paid_cents);
  const balance = formatEur(facts && facts.balance_due_cents);
  const variationInput = {
    prior_guest_context: priorGuestContext,
    variation_seed: priorGuestContext && priorGuestContext.guest_phone,
  };

  const en = {
    greeting: `${LUNA_IDENTITY.intro_short}\nAre you looking to book a stay, or just checking some info?`,
    ask_dates: 'Nice! What dates are you thinking for check-in and check-out?',
    ask_dates_mid: 'What dates are you thinking for check-in and check-out?',
    confirm_dates: range
      ? `Perfect — ${range}. How many guests will be staying?`
      : 'How many guests will be staying?',
    ask_guests: range
      ? `Perfect — ${range}. How many guests will be staying?`
      : 'How many guests will be staying?',
    ask_guest_name: range
      ? `Perfect — ${range}. What name should I put on the booking?`
      : 'What name should I put on the booking?',
    ask_package: 'Are you looking for a surf package like Malibu, or just accommodation?',
    room_girls_mixed: 'Would you prefer a girls room if one is available, or is a mixed room okay?',
    room_girls_mixed_unavailable: 'We do not have a girls-only room free for those dates — a mixed shared room would be the option. Is that okay?',
    room_private_shared: 'We may have a private room available for €10 per night extra. Would you prefer that, or are you okay with shared beds?',
    room_neutral: 'Do you have any room preference, or is a mixed shared room okay?',
    transfer_casual: 'For the package transfer, you can send your airport and arrival/departure times whenever you have them. We can still hold the booking first.',
    ask_package_choice: () => {
      const ctx = buildStayContextPhrase(fields, lang);
      if (!ctx) return null;
      return `Perfect — ${ctx} 😊 For 7-night stays, most guests choose one of the surf packages: Malibu, Uluwatu, or Waimea. Want me to explain them quickly, or do you already know which one you prefer?`;
    },
    accommodation_quote: () => {
      if (!total) return null;
      const parts = [];
      if (guests && range) {
        parts.push(`Great — I'll check accommodation for ${range} for ${guests}.`);
      }
      const availOk = quote.quote_status === 'ready'
        || !availability.availability_status
        || availability.availability_status === 'available';
      if (availOk) {
        parts.push(`Good news — we have space for those dates. Accommodation comes to ${total}.`);
      } else {
        parts.push(`Accommodation comes to ${total}.`);
      }
      parts.push('Are you going to need a wetsuit, surfboard, and/or lessons, or just the stay?');
      return parts.join('\n\n');
    },
    package_quote: () => {
      if (!total) return null;
      const parts = [];
      const pkgLabel = packageName && !/accommodation/i.test(packageName)
        ? `${packageName.charAt(0).toUpperCase()}${packageName.slice(1)}`
        : 'Your stay';
      const dateAvail = range ? `for ${range}` : 'for those dates';
      if (availability.availability_status === 'available') {
        parts.push(`Good news — we have space ${dateAvail}. ${pkgLabel} comes to ${total}.`);
      } else {
        parts.push(`${pkgLabel} comes to ${total}.`);
      }
      const dep = deposit || total;
      parts.push(`To reserve it, you can pay the ${dep} deposit or the full ${total}. We can always add lessons or rentals later if you want.`);
      return parts.join('\n\n');
    },
    quote_refreshing: (ctxFields) => {
      const range = formatDateRange(ctxFields.check_in, ctxFields.check_out);
      if (range) {
        return `Got it — I'll recheck availability and pricing for ${range} with your updated details. One moment 😊`;
      }
      return `Got it — I'll recheck availability and pricing with your updated details. One moment 😊`;
    },
    ask_payment_choice: () => {
      if (!deposit || !total) return null;
      const cls = classifyServiceInterestPricing(fields.service_interest);
      const manualNote = cls.pending_manual.length
        ? `\n\n${buildManualAddonsNote(lang, cls.pending_manual)}`
        : '';
      const hasCollectedAddons = cls.priced.length + cls.pending_manual.length > 0;
      if (hasCollectedAddons) {
        return `Got it — I've noted those extras.${manualNote}\n\nTo hold the spot, would you prefer to pay the ${deposit} deposit now, or pay the full ${total}?`;
      }
      return `Perfect — accommodation only then 😊${manualNote}\n\nTo hold the spot, would you prefer to pay the ${deposit} deposit now, or pay the full ${total}?`;
    },
    answer_arrival_payment_question: () => {
      if (!deposit || !total) {
        return 'Yep — the remaining balance can be paid on arrival by cash, bank transfer, or pay online. To hold the spot, we still need a deposit or full payment now.';
      }
      return `Yep — the remaining balance can be paid on arrival by cash, bank transfer, or pay online. To hold the spot, would you prefer to pay the ${deposit} deposit now, or pay the full ${total}?`;
    },
    addons_none: () => {
      if (!deposit || !total) return null;
      return `Perfect — accommodation only then 😊\n\nTo hold the spot, would you prefer to pay the ${deposit} deposit now, or pay the full ${total}?`;
    },
    deposit_ack: 'Perfect — deposit it is. I\'ll get your secure payment link ready.',
    full_ack: 'Perfect — full payment it is. I\'ll get your secure payment link ready.',
    hold_no_link: () => {
      if (!deposit) return null;
      return `Thanks! Your stay is held. Our team will send your secure payment link here shortly for your ${deposit} deposit.`;
    },
    stripe_link: () => {
      if (!deposit || !checkoutUrl) return null;
      return `Perfect — I've held your stay. You can pay the ${deposit} deposit here: ${checkoutUrl}\n\nOnce that's paid, your booking will be confirmed.`;
    },
    payment_link_sent: () => {
      if (!deposit) return null;
      return `Perfect — I've held your stay for the ${deposit} deposit. Check the secure payment link I just sent.`;
    },
    payment_link_failed: () => {
      if (!deposit) return null;
      return `Your stay is held — I'm having a quick hiccup generating the payment link. Our team will send your secure ${deposit} deposit link here shortly.`;
    },
    payment_received: () => {
      if (!paid) return null;
      let msg = `Got it — your ${paid} deposit is in 🙌 Your booking is held`;
      if (balance) msg += `, and the remaining balance is ${balance}`;
      msg += '. I\'ll send your full confirmation next.';
      return msg;
    },
    confirmation_sent: 'Perfect — your Wolfhouse booking is confirmed 😊 I\'ve sent the details with the address, gate code, and room info.',
    clarify: 'Could you share your check-in and check-out dates, and how many guests?',
    contextual_when: 'Once you choose deposit or full payment, I\'ll line up the next step for your stay.',
    handoff: 'Thanks for your patience — I\'m looping in our team so they can help with the next step.',
  };

  const personalityLex = clientSlug
    ? buildPersonalityReplyLexicon(clientSlug, lang, null, variationInput)
    : null;
  const welcomeCtx = ctx.welcomeCtx || {};
  const L = en;
  const P = personalityLex;

  switch (state) {
    case 'greeting': {
      const welcome = clientSlug
        ? buildWelcomeReply(clientSlug, lang, welcomeCtx, variationInput)
        : null;
      return welcome || (P && P.greeting) || L.greeting;
    }
    case 'ask_dates': {
      const dateClarify = buildDateClarificationReply(messageText);
      if (dateClarify) return dateClarify;
      const bookingIntent = /\bbook(?:ing)?\s+(?:a\s+)?stay\b/i.test(messageText || '');
      if (allowIntro || bookingIntent) {
        return (P && P.ask_dates) || L.ask_dates;
      }
      return (P && P.ask_dates_mid) || L.ask_dates_mid;
    }
    case 'confirm_dates':
      return (P && P.confirm_dates && P.confirm_dates(range)) || L.confirm_dates;
    case 'ask_guests':
      return (P && P.ask_guests && P.ask_guests(range)) || L.ask_guests;
    case 'ask_guest_name':
      return (P && P.ask_guest_name && P.ask_guest_name(range)) || L.ask_guest_name;
    case 'ask_package':
      return L.ask_package;
    case 'ask_room_preference_girls_mixed': {
      const girlsAvail = availability.girls_room_available !== false;
      return girlsAvail ? L.room_girls_mixed : L.room_girls_mixed_unavailable;
    }
    case 'ask_room_preference_private_shared':
      return L.room_private_shared;
    case 'ask_room_preference_neutral':
      return L.room_neutral;
    case 'ask_transfer_info_casual':
      return L.transfer_casual;
    case 'ask_package_choice':
      return L.ask_package_choice();
    case 'explain_packages':
      return buildExplainPackagesReply(lang, pkgIntent, fields);
    case 'explain_service_addon':
      return buildComposerServiceReply(lang, ctx.serviceIntent, fields, quote);
    case 'explain_transfer':
      return buildComposerTransferReply(lang, messageText, fields, pc);
    case 'explain_house_knowledge': {
      const built = buildGuestKnowledgeReply({
        client_slug: clientSlug,
        lang,
        message_text: messageText,
        guest_context: priorGuestContext,
        fields,
        quote,
        payment_choice: pc,
        preserve_booking_context: true,
      });
      return built.reply;
    }
    case 'explain_surf_report': {
      const surfIntent = detectGuestSurfReportIntent(messageText);
      const payload = (ctx && ctx.payload) || {};
      const built = buildGuestSurfReportReply({
        client_slug: clientSlug,
        lang,
        message_text: messageText,
        day: (payload.surf_report && payload.surf_report.day) || (surfIntent && surfIntent.day) || 'today',
        surf_data: payload.surf_report || { unavailable: true },
        fields,
        quote,
        payment_choice: pc,
        preserve_booking_context: true,
      });
      return built.reply;
    }
    case 'accommodation_quote_ready':
    case 'ask_addons_after_quote':
      if (isDateCorrection(result)) {
        return buildDateCorrectionAddonsReply(fields, quote)
          || (P && P.accommodation_quote && P.accommodation_quote({
            total,
            range,
            guests,
            availOk: quote.quote_status === 'ready'
              || !availability.availability_status
              || availability.availability_status === 'available',
          }))
          || L.accommodation_quote();
      }
      if (isGuestCountCorrection(result)) {
        return buildGuestCountCorrectionAddonsReply(fields, quote, plan, pc)
          || (P && P.accommodation_quote && P.accommodation_quote({ total, range, guests, availOk: true }))
          || L.accommodation_quote();
      }
      if (P && P.accommodation_quote) {
        const availOk = quote.quote_status === 'ready'
          || !availability.availability_status
          || availability.availability_status === 'available';
        return P.accommodation_quote({ total, range, guests, availOk });
      }
      return L.accommodation_quote();
    case 'package_quote_ready':
      if (isPackageCorrection(result)) {
        if (P && P.package_quote) {
          const pkgLabel = packageName && !/accommodation/i.test(packageName)
            ? `${packageName.charAt(0).toUpperCase()}${packageName.slice(1)}`
            : 'Your stay';
          const dateAvail = range ? `for ${range}` : 'for those dates';
          return P.package_quote({
            total,
            deposit,
            packageLabel: pkgLabel,
            dateAvail,
            awaitingAddons: quoteAwaitingAddonsDecision(quote),
          });
        }
        return L.package_quote();
      }
      if (P && P.package_quote) {
        const pkgLabel = packageName && !/accommodation/i.test(packageName)
          ? `${packageName.charAt(0).toUpperCase()}${packageName.slice(1)}`
          : 'Your stay';
        const dateAvail = range ? `for ${range}` : 'for those dates';
        return P.package_quote({
          total,
          deposit,
          packageLabel: pkgLabel,
          dateAvail,
          awaitingAddons: quoteAwaitingAddonsDecision(quote),
        });
      }
      return L.package_quote();
    case 'quote_refreshing':
      return L.quote_refreshing(fields);
    case 'addons_none_confirmed':
      if (isDateCorrection(result)) {
        return buildDateCorrectionPaymentReply(fields, quote, plan, pc)
          || (P && P.addons_none && P.addons_none({ deposit, total }))
          || L.addons_none();
      }
      if (isGuestCountCorrection(result)) {
        return buildGuestCountCorrectionPaymentReply(fields, quote, plan, pc)
          || (P && P.addons_none && P.addons_none({ deposit, total }))
          || L.addons_none();
      }
      if (P && P.addons_none) return P.addons_none({ deposit, total });
      return L.addons_none();
    case 'ask_payment_choice':
      {
        const addonReply = buildAddonPaymentChoiceReply({
          lang,
          fields,
          quote,
          client_slug: clientSlug,
          deposit,
          total,
        });
        if (addonReply) return addonReply;
      }
      if (isDateCorrection(result)) {
        return buildDateCorrectionPaymentReply(fields, quote, plan, pc)
          || (P && P.ask_payment_choice && P.ask_payment_choice(buildPaymentChoicePersonalityCtx(fields, lang, total, deposit)))
          || L.ask_payment_choice();
      }
      if (isGuestCountCorrection(result)) {
        return buildGuestCountCorrectionPaymentReply(fields, quote, plan, pc)
          || (P && P.ask_payment_choice && P.ask_payment_choice(buildPaymentChoicePersonalityCtx(fields, lang, total, deposit)))
          || L.ask_payment_choice();
      }
      if (P && P.ask_payment_choice) {
        return P.ask_payment_choice(buildPaymentChoicePersonalityCtx(fields, lang, total, deposit));
      }
      return L.ask_payment_choice();
    case 'answer_arrival_payment_question':
      if (P && P.answer_arrival_payment_question) {
        return P.answer_arrival_payment_question({ deposit, total });
      }
      return L.answer_arrival_payment_question();
    case 'payment_choice_ack':
      if (pc.payment_choice === 'full_payment') {
        return (P && P.full_ack && P.full_ack({ deposit, total })) || (P && P.full_ack) || L.full_ack;
      }
      return (P && P.deposit_ack && P.deposit_ack({ deposit, total })) || (P && P.deposit_ack) || L.deposit_ack;
    case 'payment_choice_received_hold_created':
      if (P && P.hold_no_link) return P.hold_no_link({ deposit });
      return L.hold_no_link();
    case 'payment_pending_no_link':
      if (P && P.hold_no_link) return P.hold_no_link({ deposit });
      return L.hold_no_link();
    case 'payment_link_failed':
      if (P && P.payment_link_failed) return P.payment_link_failed({ deposit });
      return L.payment_link_failed();
    case 'stripe_test_link_created':
      if (P && P.stripe_link) return P.stripe_link({ deposit, checkoutUrl });
      return L.stripe_link();
    case 'payment_link_sent':
      if (P && P.payment_link_sent) return P.payment_link_sent({ deposit });
      return L.payment_link_sent();
    case 'payment_received_preview_ready':
      if (P && P.payment_received) return P.payment_received({ paid, balance });
      return L.payment_received();
    case 'confirmation_sent_ack':
      return (P && P.confirmation_sent) || L.confirmation_sent;
    case 'clarify_missing_info': {
      if (fields.check_in && fields.check_out
        && (fields.guest_count == null || fields.guest_count < 1)) {
        return range
          ? `Perfect — ${range}. How many guests will be staying?`
          : L.ask_guests;
      }
      if (fields.check_in && fields.check_out && fields.guest_count >= 1
        && !hasPackageOrStayIntent(fields)) {
        return L.ask_package;
      }
      if (fields.check_in && fields.check_out) return L.ask_guests;
      const dateClarify = buildDateClarificationReply(messageText);
      if (dateClarify) return dateClarify;
      return L.clarify;
    }
    case 'contextual_pending_answer':
      return L.contextual_when;
    case 'safe_handoff':
      return (P && P.handoff) || L.handoff;
    default:
      return null;
  }
}

function nextGuestQuestionForState(state) {
  const map = {
    greeting: 'book_or_info',
    ask_dates: 'dates',
    confirm_dates: 'guest_count',
    ask_guests: 'guest_count',
    ask_guest_name: 'guest_name',
    ask_package: 'package_interest',
    ask_room_preference_girls_mixed: 'room_preference',
    ask_room_preference_private_shared: 'room_preference',
    ask_room_preference_neutral: 'room_preference',
    ask_transfer_info_casual: 'transfer_info',
    ask_package_choice: 'package_choice',
    explain_packages: 'package_choice',
    explain_service_addon: 'addons',
    explain_transfer: 'transfer_info',
    explain_house_knowledge: 'house_faq',
    explain_surf_report: 'surf_report',
    accommodation_quote_ready: 'addons',
    ask_addons_after_quote: 'addons',
    addons_none_confirmed: 'payment_choice',
    ask_payment_choice: 'payment_choice',
    answer_arrival_payment_question: 'payment_choice',
    package_quote_ready: 'payment_choice',
    quote_refreshing: 'quote_refresh',
    clarify_missing_info: 'dates_or_guests',
  };
  return map[state] || null;
}

/**
 * @param {object} input
 * @param {object} [input.payload] — orchestrator payload
 * @param {string} [input.message_text]
 * @param {object} [input.prior_guest_context]
 * @param {object} [input.brain_decision]
 * @param {'orchestrator'|'live_staging'} [input.mode]
 * @param {boolean} [input.allow_leading_intro]
 * @param {object} [input.live_outcomes]
 * @returns {{
 *   reply: string|null,
 *   reply_source: string,
 *   composer_state: string|null,
 *   covered: boolean,
 *   next_guest_question: string|null,
 *   safety_flags: object,
 * }}
 */
function composeLunaGuestReply(input) {
  const state = resolveComposerState(input);
  if (!state || !COMPOSER_STATES.includes(state)) {
    return {
      reply: null,
      reply_source: 'legacy',
      composer_state: null,
      covered: false,
      next_guest_question: null,
      safety_flags: { ...COMPOSER_SAFETY },
    };
  }

  const payload = (input && input.payload) || {};
  const result = payload.result || {};
  const quote = payload.quote || {};
  const availability = payload.availability || {};
  const pc = payload.payment_choice || {};
  const plan = payload.hold_payment_draft_plan || {};
  const fields = resolveComposerDisplayFields(input, payload, quote, result);
  const stripe = (input && input.live_outcomes && input.live_outcomes.stripeLink) || {};
  const live = (input && input.live_outcomes) || {};
  const clientSlug = trimStr(input && input.client_slug)
    || trimStr(input && input.prior_guest_context && input.prior_guest_context.client_slug)
    || null;
  const facts = buildComposerFacts(quote, plan, pc, stripe, live, clientSlug);
  const pkgIntent = resolvePackageExplainerIntent(
    trimStr(input && input.message_text),
    input && input.brain_decision,
  );

  const groundingErrors = validateComposerFacts(state, facts);
  if (groundingErrors.length && !['greeting', 'ask_dates', 'confirm_dates', 'ask_guests', 'ask_guest_name', 'ask_package',
    'explain_packages', 'explain_service_addon', 'explain_transfer', 'explain_house_knowledge', 'explain_surf_report', 'ask_package_choice',
    'clarify_missing_info', 'contextual_pending_answer', 'safe_handoff', 'quote_refreshing',
    'ask_room_preference_girls_mixed', 'ask_room_preference_private_shared', 'ask_room_preference_neutral',
    'ask_transfer_info_casual', 'payment_choice_ack'].includes(state)) {
    return {
      reply: null,
      reply_source: 'legacy',
      composer_state: state,
      covered: false,
      next_guest_question: null,
      safety_flags: { ...COMPOSER_SAFETY, grounding_refused: groundingErrors },
    };
  }

  let reply = buildReplyForState(state, {
    lang: langOf(result),
    fields,
    quote,
    plan,
    pc,
    result,
    availability,
    stripe,
    allowIntro: input && input.allow_leading_intro === true,
    messageText: trimStr(input && input.message_text),
    facts,
    pkgIntent,
    client_slug: clientSlug,
    welcomeCtx: {
      bookingIntent: /\bbook(?:ing)?\s+(?:a\s+)?(?:stay|room|bed)\b/i.test(trimStr(input && input.message_text)),
      infoOnlyIntent: /\b(?:info|information|packages?|how much|price|cost|surf|yoga|transfer)\b/i.test(trimStr(input && input.message_text))
        && !/\bbook\b/i.test(trimStr(input && input.message_text)),
      hasPriorContext: !!(input && input.prior_guest_context
        && (input.prior_guest_context.check_in || input.prior_guest_context.quote)),
      bookingInProgress: quote.quote_status === 'ready'
        || !!(fields.check_in && fields.check_out)
        || pc.payment_choice_ready === true,
    },
    serviceIntent: detectServiceSideQuestionIntent(trimStr(input && input.message_text)),
    prior_guest_context: input && input.prior_guest_context,
    payload,
  });

  const variationCtx = buildVariationContext({
    prior_guest_context: input && input.prior_guest_context,
    guest_phone: input && input.guest_phone,
  });
  reply = applyCamiReplyVariation(reply, {
    clientSlug,
    lang: langOf(result),
    composerState: state,
    variationCtx,
  });
  const camiVariationHistory = recordCamiPhraseUsage(
    (input && input.prior_guest_context && input.prior_guest_context.cami_variation_history) || {},
    reply,
    state,
  );

  reply = sanitizeComposerReply(reply);
  if (!reply) {
    return {
      reply: null,
      reply_source: 'legacy',
      composer_state: state,
      covered: false,
      next_guest_question: null,
      safety_flags: { ...COMPOSER_SAFETY },
    };
  }

  return {
    reply,
    reply_source: 'luna_reply_composer',
    composer_state: state,
    covered: true,
    next_guest_question: nextGuestQuestionForState(state),
    safety_flags: { ...COMPOSER_SAFETY },
    cami_variation_history: camiVariationHistory,
    quote_facts_used_by_composer: extractQuoteFactsFromPayload(payload),
    personality_id: (() => {
      if (!clientSlug) return 'luna_safe';
      const resolved = resolveActivePersonality(clientSlug);
      return resolved.active_personality_id || 'luna_safe';
    })(),
    ...buildPaymentLinkObservability({
      booking_code: facts.booking_code,
      client_slug: clientSlug,
      stripe_checkout_url: stripe && stripe.stripe_checkout_url,
      stripe_checkout_session_id: stripe && stripe.stripe_checkout_session_id,
    }),
    ...buildAddonServiceObservability(fields, quote, clientSlug),
  };
}

module.exports = {
  composeLunaGuestReply,
  resolveComposerState,
  buildReplyForState,
  buildComposerFacts,
  needsPackageChoice,
  buildExplainPackagesReply,
  buildComposerServiceReply,
  buildComposerTransferReply,
  resolveComposerDisplayFields,
  quotePayloadIsStale,
  COMPOSER_STATES,
  FORBIDDEN_GUEST_COPY_RE,
  COMPOSER_SAFETY,
  formatEur,
  formatDateRange,
  PACKAGE_NAMES_RE,
};
