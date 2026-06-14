'use strict';

/**
 * Stage 56 Milestone C — Frontdesk reply builder (composer bypass for ask_* states).
 *
 * Guest `reply` is always send-safe. Internal `cami_author_brief` guides Cami rewrite only.
 */

const { collectPriorExtractedFields } = require('./luna-guest-context-merge');
const { buildTransferIntakeQuestion } = require('./luna-guest-package-explainer');
const {
  composerOwnedState,
  COMPOSER_OWNED_STATES,
  isComposerBypassEnabled,
} = require('./luna-guest-composer-ownership');
const { composeLunaGuestReply } = require('./luna-guest-reply-composer');

const AUTHORING_BRIEF_LEAK_RE = /\b(?:Acknowledge what they just said|One warm WhatsApp reply|Next: ask|not a form, no bullet list|Do not ask for dates)\b/i;

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function formatEur(cents) {
  if (cents == null || !Number.isFinite(Number(cents))) return null;
  return `€${(Number(cents) / 100).toFixed(0)}`;
}

function isFrontdeskAuthoringBriefLeak(text) {
  return AUTHORING_BRIEF_LEAK_RE.test(trimStr(text));
}

function pickGuestReply(truthComposed, guestFallback) {
  const fromComposer = truthComposed && trimStr(truthComposed.reply);
  if (fromComposer && !isFrontdeskAuthoringBriefLeak(fromComposer)) return fromComposer;
  return trimStr(guestFallback) || fromComposer || null;
}

function buildMissingFieldHint(missingFields, nextField) {
  const m = Array.isArray(missingFields) ? missingFields : [];
  const primary = trimStr(nextField) || m[0] || null;
  const map = {
    dates: 'ask which dates they want to stay',
    check_in: 'ask which dates they want to stay',
    check_out: 'ask which dates they want to stay',
    guest_count: 'ask how many guests',
    package_or_accommodation: 'ask whether they want a surf package or accommodation only',
    package_interest: 'help them pick Malibu, Uluwatu, or Waimea — or accommodation only',
    package_choice: 'help them pick Malibu, Uluwatu, or Waimea — or accommodation only',
    payment_choice: 'ask if they prefer deposit or full payment',
    guest_name: 'ask their name for the booking',
    room_preference: 'ask private or shared room preference',
    addons: 'ask if they want meals, yoga, or surf add-ons',
    transfer_info: 'ask if they need Santander airport pickup — included with their package',
  };
  if (primary && map[primary]) return map[primary];
  if (m.includes('dates')) return map.dates;
  if (m.includes('guest_count')) return map.guest_count;
  return 'continue the booking conversation naturally with one clear question';
}

function resolvePrimaryMissingField(missingFields, nextField) {
  const m = Array.isArray(missingFields) ? missingFields : [];
  return trimStr(nextField) || m[0] || (m.includes('dates') ? 'dates' : null) || 'dates';
}

function buildFrontdeskIntakeGuestFallback(replyPlan, payload) {
  const plan = replyPlan || {};
  const field = resolvePrimaryMissingField(plan.missing_fields, plan.next_required_field);
  const map = {
    dates: 'Nice — what dates are you thinking for check-in and check-out?',
    check_in: 'Nice — what dates are you thinking for check-in and check-out?',
    check_out: 'Nice — what dates are you thinking for check-in and check-out?',
    guest_count: 'How many guests will be staying?',
    package_or_accommodation: 'Are you looking for a surf package or accommodation only?',
    package_interest: 'Malibu, Uluwatu, or Waimea — or accommodation only?',
    package_choice: 'Malibu, Uluwatu, or Waimea — or accommodation only?',
    payment_choice: 'Would you prefer to pay a deposit or the full amount?',
    guest_name: 'What name should I put the booking under?',
    room_preference: 'Do you prefer a private or shared room?',
    addons: 'Any add-ons you want — meals, yoga, or extra surf?',
    transfer_info: () => {
      const fields = collectPriorExtractedFields(payload && payload.result ? { result: payload.result } : {});
      return buildTransferIntakeQuestion('en', fields);
    },
  };
  const entry = map[field];
  if (typeof entry === 'function') return entry();
  return entry || 'What dates are you thinking for your stay?';
}

function buildFrontdeskIntakeCamiBrief(replyPlan, payload, messageText) {
  const plan = replyPlan || {};
  const facts = plan.facts_for_cami || {};
  const fields = collectPriorExtractedFields(payload && payload.result ? { result: payload.result } : {});
  const checkIn = facts.check_in || fields.check_in;
  const checkOut = facts.check_out || fields.check_out;
  const guests = facts.guest_count != null ? facts.guest_count : fields.guest_count;
  const pkg = facts.package_interest || fields.package_interest;
  const hint = buildMissingFieldHint(plan.missing_fields, plan.next_required_field);

  const parts = [];
  if (checkIn && checkOut) parts.push(`Dates noted: ${checkIn} to ${checkOut}.`);
  if (guests != null) parts.push(`Guests: ${guests}.`);
  if (pkg) parts.push(`Package interest: ${pkg}.`);

  const ack = trimStr(messageText).length < 80 ? 'Acknowledge what they just said briefly.' : 'Respond to their message naturally.';
  return [
    parts.join(' '),
    ack,
    `Next: ${hint}.`,
    'One warm WhatsApp reply — not a form, no bullet list, no re-greeting mid-thread.',
  ].filter(Boolean).join(' ');
}

/** @deprecated Use buildFrontdeskIntakeGuestFallback — kept for tests; never guest-facing instructions. */
function buildFrontdeskIntakeDraft(replyPlan) {
  return buildFrontdeskIntakeGuestFallback(replyPlan);
}

function buildFrontdeskQuoteGuestFallback(replyPlan, payload) {
  const quote = (payload && payload.quote) || {};
  const total = formatEur(quote.quote_total_cents);
  const deposit = quote.deposit_options && formatEur(quote.deposit_options.deposit_required_cents);
  const parts = ['Good news — availability looks solid for your dates.'];
  if (total) parts.push(`Total for the stay is ${total}.`);
  if (deposit) parts.push(`Deposit option is ${deposit}.`);
  parts.push('Would you like to pay a deposit or the full amount?');
  return parts.join(' ');
}

function buildFrontdeskQuoteCamiBrief(replyPlan, payload) {
  const quote = (payload && payload.quote) || {};
  const total = formatEur(quote.quote_total_cents);
  const deposit = quote.deposit_options && formatEur(quote.deposit_options.deposit_required_cents);
  const parts = ['Availability looks good for their dates.'];
  if (total) parts.push(`Total stay: ${total}.`);
  if (deposit) parts.push(`Deposit option: ${deposit}.`);
  parts.push('Share the quote warmly and ask deposit vs full payment if not chosen yet.');
  return parts.join(' ');
}

function buildFrontdeskQuoteDraft(replyPlan, payload) {
  return buildFrontdeskQuoteGuestFallback(replyPlan, payload);
}

function buildFrontdeskPostBookingGuestFallback(replyPlan) {
  const plan = replyPlan || {};
  if (plan.handoff_required) {
    return 'Got you — I\'ll loop the team in to help with that.';
  }
  return 'Happy to help with your booking — what do you need?';
}

function buildFrontdeskPostBookingCamiBrief(replyPlan) {
  const plan = replyPlan || {};
  return [
    'They already have a booking on file.',
    plan.handoff_required
      ? 'Warm handoff — team will help with their request.'
      : 'Help with their request (services, info, changes) without restarting intake.',
    'Do not ask for dates or package from scratch.',
  ].join(' ');
}

function buildFrontdeskPostBookingDraft(replyPlan) {
  return buildFrontdeskPostBookingGuestFallback(replyPlan);
}

/**
 * Compose reply: payment truth via composer; intake via frontdesk draft for Cami.
 */
function composeFrontdeskGuestReply(input) {
  const inp = input || {};
  const env = inp.env || process.env;
  const bypass = String(env.LUNA_GUEST_COMPOSER_BYPASS_ENABLED || '').toLowerCase() === 'true';

  const truthComposed = composeLunaGuestReply({
    payload: inp.payload,
    message_text: inp.message_text,
    prior_guest_context: inp.prior_guest_context,
    brain_decision: inp.brain_decision,
    mode: inp.mode || 'orchestrator',
    allow_leading_intro: inp.allow_leading_intro === true,
    live_outcomes: inp.live_outcomes,
    client_slug: inp.client_slug,
  });

  if (truthComposed && composerOwnedState(truthComposed)) {
    return truthComposed;
  }

  if (!bypass || !inp.frontdesk_reply_plan) {
    return truthComposed;
  }

  const plan = inp.frontdesk_reply_plan;

  let guestReply = null;
  let camiBrief = null;
  let state = plan.frontdesk_composer_state || 'frontdesk_general';

  if (!plan.composer_state_bypassed && plan.reply_mode === 'continue_conversation') {
    if (!truthComposed || !truthComposed.reply) return truthComposed;
    return {
      ...truthComposed,
      cami_author_brief: buildFrontdeskIntakeCamiBrief(plan, inp.payload, inp.message_text),
      cami_author_required: true,
    };
  }

  if (plan.reply_mode === 'ask_missing_naturally') {
    guestReply = pickGuestReply(
      truthComposed,
      buildFrontdeskIntakeGuestFallback(plan, inp.payload, inp.message_text),
    );
    camiBrief = buildFrontdeskIntakeCamiBrief(plan, inp.payload, inp.message_text);
    state = 'frontdesk_intake';
  } else if (plan.reply_mode === 'quote_ready_warmth') {
    guestReply = pickGuestReply(truthComposed, buildFrontdeskQuoteGuestFallback(plan, inp.payload));
    camiBrief = buildFrontdeskQuoteCamiBrief(plan, inp.payload);
    state = 'frontdesk_quote';
  } else if (plan.reply_mode === 'post_booking_playground') {
    guestReply = pickGuestReply(truthComposed, buildFrontdeskPostBookingGuestFallback(plan));
    camiBrief = buildFrontdeskPostBookingCamiBrief(plan);
    state = 'frontdesk_post_booking';
  } else if (plan.reply_mode === 'payment_warmth') {
    guestReply = pickGuestReply(truthComposed, buildFrontdeskQuoteGuestFallback(plan, inp.payload));
    camiBrief = [
      buildFrontdeskQuoteCamiBrief(plan, inp.payload),
      'Guest chose payment — acknowledge warmly; do not invent URLs (composer owns payment links).',
    ].join(' ');
    state = 'frontdesk_post_booking';
  } else if (truthComposed && truthComposed.reply) {
    return {
      ...truthComposed,
      cami_author_required: isComposerBypassEnabled(env) && !composerOwnedState(truthComposed),
    };
  } else {
    guestReply = pickGuestReply(
      truthComposed,
      buildFrontdeskIntakeGuestFallback(plan, inp.payload, inp.message_text),
    );
    camiBrief = buildFrontdeskIntakeCamiBrief(plan, inp.payload, inp.message_text);
    state = 'frontdesk_general';
  }

  if (!guestReply) return truthComposed;

  return {
    covered: true,
    reply: guestReply,
    cami_author_brief: camiBrief,
    composer_state: state,
    reply_source: 'frontdesk_planner',
    composer_bypassed: plan.composer_state_bypassed || null,
    cami_author_required: true,
  };
}

module.exports = {
  AUTHORING_BRIEF_LEAK_RE,
  isFrontdeskAuthoringBriefLeak,
  buildMissingFieldHint,
  buildFrontdeskIntakeGuestFallback,
  buildFrontdeskIntakeCamiBrief,
  buildFrontdeskIntakeDraft,
  buildFrontdeskQuoteGuestFallback,
  buildFrontdeskQuoteCamiBrief,
  buildFrontdeskQuoteDraft,
  buildFrontdeskPostBookingGuestFallback,
  buildFrontdeskPostBookingCamiBrief,
  buildFrontdeskPostBookingDraft,
  composeFrontdeskGuestReply,
  COMPOSER_OWNED_STATES,
};
