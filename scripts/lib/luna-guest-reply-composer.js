'use strict';

/**
 * Stage 28j.6 — Luna Reply Composer MVP (booking conversations).
 *
 * Owns guest-facing copy for the main new-booking flow. Business modules supply
 * structured state; this module returns one clean reply.
 */

const { collectPriorExtractedFields } = require('./luna-guest-context-merge');
const { computeStayNights, isAccommodationOnlyIntent } = require('./wolfhouse-package-night-rules');
const { detectPackageExplainerIntent } = require('./luna-guest-package-explainer');
const {
  detectServiceSideQuestionIntent,
  detectTransferSideQuestionIntent,
} = require('./luna-guest-service-transfer-explainer');
const {
  buildBookingIntakePolicySnapshot,
  mapPolicyQuestionToComposerState,
  inferRoomPreferenceNeed,
} = require('./luna-booking-intake-policy');

const COMPOSER_STATES = Object.freeze([
  'greeting',
  'ask_dates',
  'ask_guests',
  'ask_guest_name',
  'ask_room_preference_girls_mixed',
  'ask_room_preference_private_shared',
  'ask_room_preference_neutral',
  'ask_transfer_info_casual',
  'accommodation_quote_ready',
  'package_quote_ready',
  'ask_addons_after_quote',
  'addons_none_confirmed',
  'ask_payment_choice',
  'payment_choice_ack',
  'payment_choice_received_hold_created',
  'stripe_test_link_created',
  'payment_link_sent',
  'payment_pending_no_link',
  'clarify_missing_info',
  'contextual_pending_answer',
  'safe_handoff',
]);

const FORBIDDEN_GUEST_COPY_RE = new RegExp(
  [
    'dry run',
    'automation gate',
    'quote_status',
    'payment_choice',
    'hold writer',
    '\\bstaging\\b',
    '\\bgate\\b',
    '\\breview\\b',
    'I am not confirming the booking',
    'I am not creating a hold',
    'not sending a payment link yet',
    "didn't catch that",
    "didn't quite catch",
  ].join('|'),
  'i',
);

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
  const s = trimStr(text);
  if (!s || FORBIDDEN_GUEST_COPY_RE.test(s)) return null;
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

function isUncoveredSideQuestion(messageText, result) {
  const t = trimStr(messageText);
  if (!t) return false;
  if (detectPackageExplainerIntent(t)) return true;
  if (detectTransferSideQuestionIntent(t) || result.message_lane === 'transfer_request') return true;
  if (detectServiceSideQuestionIntent(t) || result.message_lane === 'add_service_request') return true;
  return false;
}

function isBookingFlowLane(result) {
  if (!result) return false;
  if (result.message_lane === 'new_booking_inquiry') return true;
  if (result.greeting_only === true) return true;
  return false;
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
  const fields = result.extracted_fields || collectPriorExtractedFields(inp.prior_guest_context || {});

  if (gate.gate_status && gate.gate_status !== 'allowed_dry_run') return null;

  if (result.greeting_only === true
    || (inp.brain_decision && inp.brain_decision.intent === 'greeting')) {
    return 'greeting';
  }

  if (!isBookingFlowLane(result)) return null;

  if (isUncoveredSideQuestion(messageText, result)) return null;

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

  if (quote.quote_status === 'ready' && quote.payment_choice_needed === true
    && pc.payment_choice_ready !== true
    && policy.add_ons_status !== 'pending'
    && !quote.short_stay_addons_pending) {
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

  if (pc.payment_choice_ready === true) {
    if (mode === 'live_staging') {
      const writeOk = bw.write_status === 'created' || bw.write_status === 'reused_existing';
      if (writeOk) {
        if (plSend.payment_link_sent === true) return 'payment_link_sent';
        if (stripe.stripe_link_created === true || stripe.stripe_link_reused === true) {
          return 'stripe_test_link_created';
        }
        return 'payment_pending_no_link';
      }
      if (plan.plan_status === 'ready') return 'payment_pending_no_link';
    }
    return 'payment_choice_ack';
  }

  if (quote.quote_status === 'ready' && quote.short_stay_addons_pending === true
    && isShortStayAccommodation(result, quote, fields)) {
    return 'accommodation_quote_ready';
  }

  if (quote.quote_status === 'ready' && !quote.short_stay_addons_pending
    && !isShortStayAccommodation(result, quote, fields)
    && availability.availability_status === 'available') {
    return 'package_quote_ready';
  }

  const missing = result.missing_required_fields || [];
  if ((!fields.check_in || !fields.check_out
    || missing.includes('check_in') || missing.includes('check_out'))
    && result.message_lane === 'new_booking_inquiry') {
    return 'ask_dates';
  }

  const guestName = trimStr(fields.guest_name) || channelGuestName;
  if (fields.check_in && fields.check_out
    && !guestName
    && (missing.includes('guest_name') || (result.readiness_missing_fields || []).includes('guest_name'))
    && result.message_lane === 'new_booking_inquiry'
    && quote.quote_status !== 'ready') {
    return 'ask_guest_name';
  }

  if (fields.check_in && fields.check_out
    && guestName
    && (fields.guest_count == null || missing.includes('guest_count'))
    && result.message_lane === 'new_booking_inquiry') {
    return 'ask_guests';
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

function buildReplyForState(state, ctx) {
  const {
    lang, fields, quote, plan, pc, result, availability, stripe, allowIntro, messageText,
  } = ctx;
  const range = formatDateRange(fields.check_in, fields.check_out);
  const guests = guestCountLabel(fields.guest_count, lang);
  const total = formatEur(quote && quote.quote_total_cents);
  const deposit = formatEur(depositCentsFromPayload(quote, plan, pc));
  const checkoutUrl = stripe && stripe.stripe_checkout_url ? trimStr(stripe.stripe_checkout_url) : '';

  const en = {
    greeting: "Hey! I'm Luna from Wolfhouse 🌊\nAre you looking to book a stay, or just checking some info?",
    ask_dates: 'Nice! What dates are you thinking for check-in and check-out?',
    ask_dates_mid: 'What dates are you thinking for check-in and check-out?',
    ask_guests: range
      ? `Perfect — ${range}. How many guests will be staying?`
      : 'How many guests will be staying?',
    ask_guest_name: range
      ? `Perfect — ${range}. Can I grab your name for the booking?`
      : 'Can I grab your name for the booking?',
    room_girls_mixed: 'Would you prefer a girls room if one is available, or is a mixed room okay?',
    room_girls_mixed_unavailable: 'We do not have a girls-only room free for those dates — a mixed shared room would be the option. Is that okay?',
    room_private_shared: 'We may have a private room available for €10 per night extra. Would you prefer that, or are you okay with shared beds?',
    room_neutral: 'Do you have any room preference, or is a mixed shared room okay?',
    transfer_casual: 'For the package transfer, you can send your airport and arrival/departure times whenever you have them.',
    accommodation_quote: () => {
      const parts = [];
      if (guests && range) {
        parts.push(`Great — I'll check accommodation for ${range} for ${guests}.`);
      }
      if (total) {
        const availOk = quote.quote_status === 'ready'
          || !availability.availability_status
          || availability.availability_status === 'available';
        if (availOk) {
          parts.push(`Good news — we have space for those dates. Accommodation comes to ${total}.`);
        } else {
          parts.push(`Accommodation comes to ${total}.`);
        }
      }
      parts.push('Are you going to need a wetsuit, surfboard, and/or lessons, or just the stay?');
      return parts.join('\n\n');
    },
    package_quote: () => {
      const parts = [];
      if (availability.availability_status === 'available' && total) {
        parts.push(`Good news — we have space for those dates. Your stay comes to ${total}.`);
      } else if (total) {
        parts.push(`Your stay comes to ${total}.`);
      }
      parts.push('Would you prefer to pay the deposit or the full amount?');
      return parts.join('\n\n');
    },
    ask_payment_choice: () => {
      const dep = deposit || '€100';
      const full = total || 'the full amount';
      return `Perfect — accommodation only then 😊\n\nTo hold the spot, would you prefer to pay the ${dep} deposit now, or pay the full ${full}?`;
    },
    deposit_ack: 'Thanks — deposit it is. I’ll line up secure payment next.',
    full_ack: 'Thanks — full payment it is. I’ll line up secure payment next.',
    hold_no_link: () => {
      const dep = deposit || '€100';
      return `Thanks! Your stay is held. Our team will send your secure payment link here shortly for your ${dep} deposit.`;
    },
    stripe_link: () => {
      const dep = deposit || '€100';
      if (checkoutUrl) {
        return `Perfect — I've held your stay. You can pay the ${dep} deposit here: ${checkoutUrl}\n\nOnce that's paid, your booking will be confirmed.`;
      }
      return `Perfect — I've held your stay. I'll send your secure test payment link for the ${dep} deposit shortly.`;
    },
    payment_link_sent: () => {
      const dep = deposit || '€100';
      return `Perfect — I've held your stay for the ${dep} deposit. Check the secure payment link I just sent.`;
    },
    clarify: 'Could you share your check-in and check-out dates, and how many guests?',
    contextual_when: 'Once you choose deposit or full payment, I’ll line up the next step for your stay.',
    handoff: 'Thanks for your patience — I’m looping in our team so they can help with the next step.',
  };

  const L = en;

  switch (state) {
    case 'greeting':
      return L.greeting;
    case 'ask_dates': {
      const bookingIntent = /\bbook(?:ing)?\s+(?:a\s+)?stay\b/i.test(messageText || '');
      return (allowIntro || bookingIntent) ? L.ask_dates : L.ask_dates_mid;
    }
    case 'ask_guests':
      return L.ask_guests;
    case 'ask_guest_name':
      return L.ask_guest_name;
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
    case 'accommodation_quote_ready':
    case 'ask_addons_after_quote':
      return L.accommodation_quote();
    case 'package_quote_ready':
      return L.package_quote();
    case 'addons_none_confirmed':
    case 'ask_payment_choice':
      return L.ask_payment_choice();
    case 'payment_choice_ack':
      return pc.payment_choice === 'full_payment' ? L.full_ack : L.deposit_ack;
    case 'payment_choice_received_hold_created':
      return L.hold_no_link();
    case 'payment_pending_no_link':
      return L.hold_no_link();
    case 'stripe_test_link_created':
      return L.stripe_link();
    case 'payment_link_sent':
      return L.payment_link_sent();
    case 'clarify_missing_info':
      return L.clarify;
    case 'contextual_pending_answer':
      return L.contextual_when;
    case 'safe_handoff':
      return L.handoff;
    default:
      return null;
  }
}

function nextGuestQuestionForState(state) {
  const map = {
    greeting: 'book_or_info',
    ask_dates: 'dates',
    ask_guests: 'guest_count',
    ask_guest_name: 'guest_name',
    ask_room_preference_girls_mixed: 'room_preference',
    ask_room_preference_private_shared: 'room_preference',
    ask_room_preference_neutral: 'room_preference',
    ask_transfer_info_casual: 'transfer_info',
    accommodation_quote_ready: 'addons',
    ask_addons_after_quote: 'addons',
    addons_none_confirmed: 'payment_choice',
    ask_payment_choice: 'payment_choice',
    package_quote_ready: 'payment_choice',
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
  const fields = result.extracted_fields || collectPriorExtractedFields(input && input.prior_guest_context);
  const stripe = (input && input.live_outcomes && input.live_outcomes.stripeLink) || {};

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
  });

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
  };
}

module.exports = {
  composeLunaGuestReply,
  resolveComposerState,
  COMPOSER_STATES,
  FORBIDDEN_GUEST_COPY_RE,
  COMPOSER_SAFETY,
  formatEur,
  formatDateRange,
};
