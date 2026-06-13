/**
 * Stage 57c — Hermes Luna end-to-end dry-run rehearsal.
 *
 * Simulates the guest-facing happy path without live WhatsApp or real Staff API writes.
 * Uses the Hermes Staff API tool wrapper with mocked fetch so we verify the actual
 * /staff/bot/* contract, Cami-style copy, deposits, transfers, and payment truth.
 */

'use strict';

const {
  runHermesLunaE2ERehearsal,
} = require('./lib/luna-hermes-e2e-rehearsal');
const { buildHermesLunaToolset } = require('./lib/luna-hermes-staff-api-tools');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

function makeMockFetch() {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse((opts && opts.body) || '{}');
    calls.push({ url: String(url), opts: opts || {}, body });
    const path = String(url).replace('https://staff-staging.lunafrontdesk.com', '');
    let payload;
    if (path === '/staff/bot/availability-check') {
      payload = { success: true, availability_status: 'available', selected_bed_codes: ['R3-B1', 'R3-B2', 'R3-B3'] };
    } else if (path === '/staff/bot/booking-preview') {
      payload = { success: true, quote_status: 'ready', quote_total_cents: 225000, deposit_required_cents: 20000, currency: 'EUR' };
    } else if (path === '/staff/bot/booking-create-from-plan') {
      payload = { success: true, write_performed: true, booking_id: 'book_123', booking_code: 'WH-G57C', payment_id: 'pay_123' };
    } else if (path === '/staff/bot/payments/pay_123/create-stripe-link') {
      payload = { success: true, payment_id: 'pay_123', checkout_url: 'https://checkout.stripe.test/pay_123', payment_status: 'checkout_created' };
    } else if (path === '/staff/bot/transfers/save') {
      payload = { success: true, write_performed: true, booking_id: 'book_123', transfer: { direction: 'arrival', airport_code: 'santander', flight_number: 'FR1234' } };
    } else if (path === '/staff/bot/payments/status') {
      payload = { success: true, payment_truth_known: true, latest_payment: { payment_id: 'pay_123', payment_status: 'paid' }, booking_id: 'book_123' };
    } else {
      payload = { success: false, error: `unexpected path ${path}` };
    }
    return {
      ok: payload.success !== false,
      status: payload.success === false ? 404 : 200,
      async text() { return JSON.stringify(payload); },
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

(async () => {
  console.log('\nverify-stage57c-hermes-luna-e2e-rehearsal.js  (Stage 57c)\n');

  const mockFetch = makeMockFetch();
  const tools = buildHermesLunaToolset({
    baseUrl: 'https://staff-staging.lunafrontdesk.com',
    botToken: 'stage57c-token',
    fetchImpl: mockFetch,
  });

  const out = await runHermesLunaE2ERehearsal({
    client_slug: 'wolfhouse-somo',
    guest_phone: '+346****5757',
    contact_name: 'Jimmy',
    reference_date: '2026-06-01',
    staffApiTools: tools,
    turns: [
      'hello',
      'I want to book June 11 to 20 for 3 people',
      'Waimea please',
      'deposit is fine',
      'my flight lands in Santander at 11:20 FR1234',
      'I paid',
    ],
  });

  section('A. Conversation shape');
  check('A1', out.turns.length === 6, 'six turns processed');
  check('A2', /welcome|wolfhouse|book|info/i.test(out.turns[0].reply), 'warm welcome asks book/info');
  check('A3', /Malibu/i.test(out.turns[1].reply) && /Uluwatu/i.test(out.turns[1].reply) && /Waimea/i.test(out.turns[1].reply), 'packages explained after dates/count');
  check('A4', /€200/.test(out.turns[2].reply) && /€2250/.test(out.turns[2].reply), 'Waimea quote uses €200 package deposit');
  check('A5', /checkout\.stripe\.test\/pay_123/.test(out.turns[3].reply), 'deposit link returned');
  check('A6', /Santander|FR1234/i.test(out.turns[4].reply), 'transfer details acknowledged');
  check('A7', /confirmed|payment received|paid/i.test(out.turns[5].reply), 'payment truth drives confirmation');

  section('B. Staff API tool calls');
  const paths = mockFetch.calls.map((c) => c.url.replace('https://staff-staging.lunafrontdesk.com', ''));
  check('B1', paths.includes('/staff/bot/availability-check'), 'availability checked');
  check('B2', paths.includes('/staff/bot/booking-preview'), 'quote requested');
  check('B3', paths.includes('/staff/bot/booking-create-from-plan'), 'booking create-from-plan called');
  check('B4', paths.includes('/staff/bot/payments/pay_123/create-stripe-link'), 'payment link called');
  check('B5', paths.includes('/staff/bot/transfers/save'), 'transfer save called');
  check('B6', paths.includes('/staff/bot/payments/status'), 'payment status checked');
  check('B7', mockFetch.calls.every((c) => c.opts.headers['X-Luna-Bot-Token'] === 'stage57c-token'), 'bot token on every Staff API call');

  section('C. Final state');
  check('C1', out.state.booking_code === 'WH-G57C', 'booking code stored');
  check('C2', out.state.payment_status === 'paid', 'payment state paid');
  check('C3', out.state.transfer && out.state.transfer.flight_number === 'FR1234', 'transfer state stored');
  check('C4', out.safety.no_live_whatsapp === true && out.safety.mocked_staff_api === true, 'dry-run safety flags');

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
