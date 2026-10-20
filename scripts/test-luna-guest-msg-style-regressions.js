'use strict';

const assert = require('node:assert/strict');
const composer = require('./lib/luna-guest-reply-composer');
const surf = require('./lib/luna-guest-surf-report');
const forecast = require('./lib/staff-stormglass-forecast');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const fields = {
  check_in: '2026-11-16',
  check_out: '2026-11-23',
  guest_count: 2,
  guest_name: 'Alex',
  package_interest: 'malibu',
  room_type: 'private',
  room_preference: 'couple_private',
  add_ons: [],
};

function composeInput(quote, extra = {}) {
  return {
    client_slug: 'wolfhouse-somo',
    mode: 'dry_run',
    message_text: 'That sounds good',
    payload: {
      result: {
        message_lane: 'new_booking_inquiry',
        extracted_fields: fields,
        booking_intake_policy: {
          add_ons_status: 'collected',
          transfer_info_status: 'declined',
          required_fields: [],
        },
      },
      availability: { availability_status: 'available' },
      quote: { quote_status: 'ready', payment_choice_needed: true, ...quote },
      ...extra,
    },
  };
}

function stateCtx(overrides = {}) {
  return {
    lang: 'en',
    fields,
    quote: {
      quote_status: 'ready',
      quote_total_cents: 80000,
      deposit_options: { deposit_required_cents: 20000 },
    },
    plan: {},
    pc: {},
    result: {},
    availability: { availability_status: 'available' },
    stripe: {},
    facts: {},
    client_slug: null,
    messageText: '',
    ...overrides,
  };
}

test('unknown money stays unknown while numeric zero remains valid', () => {
  assert.equal(composer.formatEur(null), null);
  assert.equal(composer.formatEur(undefined), null);
  assert.equal(composer.formatEur(0), '€0');
});

test('public quote boundary refuses a quote with no grounded total', () => {
  const result = composer.composeLunaGuestReply(composeInput({
    quote_total_cents: null,
    deposit_options: { deposit_required_cents: 20000 },
  }));
  assert.equal(result.covered, false);
  assert.doesNotMatch(String(result.reply || ''), /€0/);
});

test('missing deposit never becomes a zero deposit offer', () => {
  const result = composer.composeLunaGuestReply(composeInput({ quote_total_cents: 80000 }));
  assert.doesNotMatch(String(result.reply || ''), /€0 deposit/);
});

test('receipt with unknown balance omits a paid-off balance claim', () => {
  const reply = composer.buildReplyForState('payment_received_preview_ready', stateCtx({
    facts: { amount_paid_cents: 20000, balance_due_cents: null },
  }));
  assert.doesNotMatch(reply, /remaining balance is €0/);
  assert.doesNotMatch(reply, /remaining balance is/);
});

test('package quote preserves package and guests without inventing requested room detail', () => {
  const reply = composer.buildReplyForState('package_quote_ready', stateCtx());
  assert.match(reply, /Malibu/);
  assert.match(reply, /2 guests/);
  assert.doesNotMatch(reply, /shared room|private room/i);
});

test('authoritative quote room type is rendered for package and accommodation variants', () => {
  const packageShared = composer.buildReplyForState('package_quote_ready', stateCtx({
    quote: { quote_status: 'ready', quote_total_cents: 80000, room_type: 'shared', deposit_options: { deposit_required_cents: 20000 } },
  }));
  const packagePrivate = composer.buildReplyForState('package_quote_ready', stateCtx({
    quote: { quote_status: 'ready', quote_total_cents: 80000, room_type: 'private', deposit_options: { deposit_required_cents: 20000 } },
  }));
  const accommodation = composer.buildReplyForState('accommodation_quote_ready', stateCtx({
    fields: { ...fields, package_interest: 'accommodation_only' },
    quote: { quote_status: 'ready', quote_total_cents: 50000, room_type: 'shared', deposit_options: { deposit_required_cents: 20000 } },
  }));
  assert.match(packageShared, /shared room/i);
  assert.match(packagePrivate, /private room/i);
  assert.match(accommodation, /Accommodation/);
  assert.match(accommodation, /2 guests/);
  assert.match(accommodation, /shared room/i);
});

test('payment-choice fallback uses real line breaks only', () => {
  const reply = composer.buildReplyForState('ask_payment_choice', stateCtx());
  assert.match(reply, /\n\n/);
  assert.doesNotMatch(reply, /\\n/);
});

test('weekly surf is deferred without a fetch or invented summary', async () => {
  process.env.STORMGLASS_API_KEY = 'offline-synthetic-key';
  let calls = 0;
  forecast.setStormglassFetchForTests(async () => {
    calls += 1;
    return { status: 200, body: JSON.stringify({ hours: [] }) };
  });
  const data = await surf.fetchGuestSurfReportData({ clientSlug: 'wolfhouse-somo', day: 'week' });
  assert.equal(data.unavailable, true);
  assert.equal(calls, 0);
  const reply = surf.buildGuestSurfReportReply({
    client_slug: 'wolfhouse-somo',
    day: 'week',
    lang: 'es',
    message_text: 'olas esta semana',
    surf_data: data,
    preserve_booking_context: false,
  });
  assert.equal(reply.language, 'es');
  assert.doesNotMatch(reply.reply, /This week|mix of small and fun|multi-day summary/i);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`PASS ${name}`);
    } catch (err) {
      console.error(`FAIL ${name}`);
      throw err;
    }
  }
  console.log(`PASS ${passed}/${tests.length}`);
})().catch((err) => {
  console.error(err.stack || err);
  process.exitCode = 1;
});
