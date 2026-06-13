/**
 * Stage 57a — Hermes Luna Staff API tool wrapper verifier.
 *
 * Proves the Hermes-facing Staff API client contract without live network:
 * - calls /staff/bot/* under WOLFHOUSE_STAFF_API_BASE_URL
 * - sends X-Luna-Bot-Token from LUNA_BOT_INTERNAL_TOKEN
 * - wraps availability, quote/preview, booking create, payment link, services, transfers
 * - computes expected deposit class: package €200, custom/shorter €100
 *
 * Usage:
 *   node scripts/verify-stage57a-hermes-staff-api-tools.js
 */

'use strict';

const {
  createHermesStaffApiClient,
  buildHermesLunaToolset,
  resolveLunaDepositCents,
} = require('./lib/luna-hermes-staff-api-tools');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

function makeMockFetch() {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      async json() { return { ok: true, url: String(url), method: opts && opts.method, body: JSON.parse(opts.body || '{}') }; },
      async text() { return JSON.stringify({ ok: true }); },
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

(async () => {
  console.log('\nverify-stage57a-hermes-staff-api-tools.js  (Stage 57a)\n');

  section('A. Deposit resolver');
  {
    check('A1', resolveLunaDepositCents({ package_code: 'malibu', nights: 7 }) === 20000, 'named package deposit €200');
    check('A2', resolveLunaDepositCents({ package_code: 'waimea', nights: 9 }) === 20000, 'all named packages deposit €200');
    check('A3', resolveLunaDepositCents({ package_code: null, nights: 4 }) === 10000, 'short/custom deposit €100');
    check('A4', resolveLunaDepositCents({ package_code: 'custom', nights: 9 }) === 10000, 'custom pack deposit €100');
  }

  section('B. Client headers + base URL');
  {
    const mockFetch = makeMockFetch();
    const client = createHermesStaffApiClient({
      baseUrl: 'https://staff-staging.lunafrontdesk.com/',
      botToken: 'test-token-123',
      fetchImpl: mockFetch,
    });
    const out = await client.postBot('/availability-check', { check_in: '2026-06-11' });
    const call = mockFetch.calls[0];
    check('B1', out.ok === true, 'returns parsed json');
    check('B2', call.url === 'https://staff-staging.lunafrontdesk.com/staff/bot/availability-check', 'normalizes /staff/bot path');
    check('B3', call.opts.method === 'POST', 'POST method');
    check('B4', call.opts.headers['X-Luna-Bot-Token'] === 'test-token-123', 'sends X-Luna-Bot-Token');
    check('B5', call.opts.headers['Content-Type'] === 'application/json', 'json content type');
  }

  section('C. Toolset maps to Staff API bot endpoints');
  {
    const mockFetch = makeMockFetch();
    const tools = buildHermesLunaToolset({
      baseUrl: 'https://staff-staging.lunafrontdesk.com',
      botToken: 'test-token-abc',
      fetchImpl: mockFetch,
    });
    await tools.checkAvailability({ check_in: '2026-06-11', check_out: '2026-06-20', guest_count: 3 });
    await tools.quoteBooking({ check_in: '2026-06-11', check_out: '2026-06-20', guest_count: 3, package_code: 'malibu' });
    await tools.createBookingFromPlan({ plan_id: 'plan_123', confirm: true });
    await tools.createPaymentLink({ payment_id: 'pay_123', payment_choice: 'deposit' });
    await tools.addServiceToBooking({ booking_id: 'book_123', service_type: 'meal', quantity: 3 });
    await tools.saveTransfer({ booking_id: 'book_123', direction: 'arrival', airport: 'Santander', flight_number: 'FR1234' });

    const urls = mockFetch.calls.map((c) => c.url.replace('https://staff-staging.lunafrontdesk.com', ''));
    check('C1', urls.includes('/staff/bot/availability-check'), 'availability endpoint');
    check('C2', urls.includes('/staff/bot/booking-preview'), 'quote/preview endpoint');
    check('C3', urls.includes('/staff/bot/booking-create-from-plan'), 'booking create from plan endpoint');
    check('C4', urls.includes('/staff/bot/payments/pay_123/create-stripe-link'), 'payment link endpoint');
    check('C5', urls.includes('/staff/bot/addon-request-preview'), 'service/addon preview endpoint');
    check('C6', urls.includes('/staff/bot/transfers/save'), 'transfer save endpoint');
    check('C7', mockFetch.calls.every((c) => c.opts.headers['X-Luna-Bot-Token'] === 'test-token-abc'), 'token on every tool call');
  }

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
