'use strict';

// DEPOSIT-FROM-ADMIN-PRICING-001: actual Admin handlers + isolated PostgreSQL
// engine. No DSN, server, Stripe, guest sends, or live calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createWolfhousePricingRoutes } = require('./lib/wolfhouse-pricing-routes');
const { loadWolfhouseDepositRates } = require('./lib/wolfhouse-stay-deposit');
const SLUG = 'wolfhouse-somo';
const ACTOR = '00000000-0000-4000-8000-000000000001';

async function main() {
  const db = new PGlite();
  const previous = process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED;
  process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED = 'true';
  const queries = [];
  const pg = { async query(sql, params) {
    queries.push(String(sql));
    return params ? db.query(sql, params) : (await db.exec(sql)).at(-1);
  } };
  try {
    await db.exec(`CREATE TABLE staff_users (id UUID PRIMARY KEY);
      INSERT INTO staff_users VALUES ('${ACTOR}');
      CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;`);
    for (const file of ['076_wolfhouse_pricing_admin.sql', '106_wh_pricing_catalog_extra_types.sql']) {
      await db.exec(fs.readFileSync(path.join(__dirname, '../database/migrations', file), 'utf8'));
    }
    let response;
    const routes = createWolfhousePricingRoutes({
      sendJSON: (_res, status, body) => { response = { status, body }; },
      send400: (_res, error) => { response = { status: 400, body: { success: false, error } }; },
      readBody: async (req) => JSON.stringify(req.body),
      assertStaffClientAccess: (user, client) => user.client_slug === client,
      appendAuditLog: () => {}, withPgClient: async (fn) => fn(pg),
      DEFAULT_CLIENT: SLUG, SQL_INJECT_RE: /['";\\]|--/,
      STAFF_AUTH_REQUIRED: true, resolveStaffRole: (user) => user.role,
    });
    async function request(suffix, body, expectedStatus = 200) {
      const handler = routes.match('/staff/admin/wh/pricing' + suffix, body ? 'PUT' : 'GET');
      assert.equal(typeof handler, 'function');
      response = undefined;
      await handler({ client: SLUG }, { body }, {}, { role: 'admin', staff_user_id: ACTOR, client_slug: SLUG });
      assert.equal(response.status, expectedStatus, JSON.stringify(response));
      return response.body;
    }
    await request(''); // Normal catalog initialization/read, not a test-owned price overlay.
    const desired = { long_stay_cents: 25750, short_stay_cents: 13225, source: 'admin_pricing' };
    for (const [code, amount] of [['standard_package', '257.50'], ['custom_or_short_stay', '132.25']]) {
      await request('/prices', { item_type: 'deposit', item_code: code, unit: 'per_person', amount_eur: amount });
    }
    const view = await request('');
    assert.equal(view.extras.deposits.find((r) => r.code === 'standard_package').amount_cents, desired.long_stay_cents);
    assert.equal(view.extras.deposits.find((r) => r.code === 'custom_or_short_stay').amount_cents, desired.short_stay_cents);
    assert.deepEqual(await loadWolfhouseDepositRates(pg), desired);
    console.log('PASS Admin Save/read-back and writable loader use non-default rates');

    await db.exec('BEGIN READ ONLY');
    try {
      queries.length = 0;
      const actual = await loadWolfhouseDepositRates(pg);
      assert.deepEqual(actual, desired, 'read-only deposit lookup must not replace Admin Pricing with hard-coded defaults');
      assert(queries.length > 0 && queries.every((sql) => /^\s*SELECT\b/i.test(sql)), 'deposit read attempts SELECT only');
      assert.equal((await db.query('SELECT 1 AS alive')).rows[0].alive, 1, 'reader must not abort its transaction');
    } finally { await db.exec('ROLLBACK'); }
    console.log('PASS read-only PostgreSQL transaction retains saved rates and stays usable');
    await matrix(pg, desired);
    await browserProof(request, pg);
    // Admin's existing validation rejects zero, negative and malformed prices;
    // invalid edits must not replace the saved rates or weaken that contract.
    const savedRates = await loadWolfhouseDepositRates(pg);
    for (const amount of ['0', '-1', 'not-money']) {
      await request('/prices', { item_type: 'deposit', item_code: 'standard_package', unit: 'per_person', amount_eur: amount }, 400);
      assert.deepEqual(await loadWolfhouseDepositRates(pg), savedRates);
    }
    // Both legacy scopes still use the night-band rate × headcount.
    for (const [code, amount] of [['standard_package', '177.35'], ['custom_or_short_stay', '88.15']]) {
      await request('/prices', { item_type: 'deposit', item_code: code, unit: 'per_booking', amount_eur: amount });
    }
    await matrix(pg, { long_stay_cents: 17735, short_stay_cents: 8815, source: 'admin_pricing' });
    console.log('PASS invalid edits leave rates unchanged; fresh reads and per_booking legacy scope retain nights × guests');
  } finally {
    if (previous === undefined) delete process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED;
    else process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED = previous;
    await db.close();
  }
}

async function matrix(pg, expectedRates) {
  const t = require('./verify-package-minimum-transport');
  const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
  const { bookingDepositLinkAmount } = require('./lib/booking-deposit-payment-link');
  const rates = await loadWolfhouseDepositRates(pg);
  assert.deepEqual(rates, expectedRates);
  const config = await t.loader(pg)(); // Actual Staff API config loader + DB SELECTs.
  for (const nights of [1, 5, 6, 7, 10]) for (const guests of [1, 3]) {
    const rate = nights >= 6 ? rates.long_stay_cents : rates.short_stay_cents;
    const expected = rate * guests;
    const booking = {
      client_slug: SLUG, check_in: '2026-07-01', check_out: `2026-07-${String(nights + 1).padStart(2, '0')}`,
      guest_count: guests, package_code: 'package_none', payment_choice: 'deposit',
      deposit_required_cents: 20000, total_amount_cents: 900000,
    };
    const quote = calculateWolfhouseQuote(booking, config);
    assert.equal(quote.success, true);
    // Saved Admin rate remains authoritative, bounded by actual priced debt.
    const quotedExpected = Math.min(expected, quote.total_cents);
    const quotedPerGuest = quotedExpected / guests;
    assert.equal(quote.deposit_required_cents, quotedExpected);
    assert.equal(quote.payment_link_amount_cents, quotedExpected);
    assert.equal(quote.per_guest_deposits.length, guests);
    assert(quote.per_guest_deposits.every((g) => g.deposit_cents === quotedPerGuest));
    const preview = await t.bookingPreview(pg, t.bookingBody(booking));
    assert.equal(preview.status, 200);
    assert.equal(preview.body.quote.deposit_required_cents, quotedExpected, 'actual bot preview uses saved admin rate bounded by priced debt');
    const { buildWolfhouseBookingCreateCommand } = require('./lib/luna-front-desk-accommodation-booking-create-service');
    const created = await buildWolfhouseBookingCreateCommand({
      channel: 'manual_staff', trustedClientSlug: SLUG, quoteConfig: config,
      transportBody: t.bookingBody({ client_slug: SLUG, check_in: booking.check_in, check_out: booking.check_out,
        guest_count: guests, package_code: 'package_none', payment_choice: 'stripe_deposit_per_guest',
        selected_bed_codes: Array.from({ length: guests }, (_, i) => 'R1-B' + (i + 1)) }),
    }); // Command construction only; no execution, reservation or Stripe call.
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.command.depositCents, quotedExpected);
    assert.equal(created.command.paymentLinkAmountCents, quotedExpected);
    assert(created.command.quote.per_guest_deposits.every((g) => g.deposit_cents === quotedPerGuest));
    const opts = { loadBookingPaymentLedger: async () => ({ invoice_total_cents: 900000 }) };
    const result = await bookingDepositLinkAmount(pg, booking, [], opts);
    if (expected === 0) assert.equal(result.body.reason_code, 'no_deposit_due');
    else {
      assert.equal(result.amountDueCents, expected, 'link amount overrides stored flat deposit');
      const partial = await bookingDepositLinkAmount(pg, booking, [{ payment_status: 'paid', amount_paid_cents: 1234 }], opts);
      assert.equal(partial.amountDueCents, expected - 1234);
      const capped = await bookingDepositLinkAmount(pg, booking, [], { loadBookingPaymentLedger: async () => ({ invoice_total_cents: 1111 }) });
      assert.equal(capped.amountDueCents, 1111);
    }
    const balance = await bookingDepositLinkAmount(pg, booking, [{ payment_status: 'paid', amount_paid_cents: 1234 }], opts, 'balance');
    assert.equal(balance.amountDueCents, 898766);
  }
  console.log('PASS 10-case saved rates → actual preview / quote / per-guest amounts / capped deposit / balance matrix');
}

async function browserProof(request, pg) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    // Every request intercepted; no external network. Real UI saves dispatch to
    // production handlers on the isolated engine, not canned success responses.
    await page.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.origin !== 'http://pricing.invalid') return route.abort();
      if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<main id="wh-admin-pricing-body"></main><div id="invoice"></div>' });
      assert(u.pathname.startsWith('/staff/admin/wh/pricing'));
      const data = await request(u.pathname.slice('/staff/admin/wh/pricing'.length), route.request().postDataJSON());
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.goto('http://pricing.invalid/');
    await page.addScriptTag({ path: path.join(__dirname, 'browser/wolfhouse-admin-pricing-ui.js') });
    await page.addScriptTag({ path: path.join(__dirname, 'browser/booking-invoice.js') });
    await page.evaluate(() => {
      window.t = (s) => s;
      window.escHtml = (s) => String(s);
      window.bcBookingStatusIsCancelled = (s) => s === 'cancelled';
      return window.loadWolfhouseAdminPricing();
    });
    const desired = { long_stay_cents: 28675, short_stay_cents: 14350, source: 'admin_pricing' };
    for (const [code, amount, scope] of [['standard_package', '286.75', 'per_booking'], ['custom_or_short_stay', '143.50', 'per_person']]) {
      await page.locator('[data-wh-price-action="edit-extra"][data-wh-item-code="' + code + '"]').click();
      await page.locator('#wh-price-amount').fill(amount);
      await page.locator('input[name="wh-deposit-scope"][value="' + scope + '"]').check();
      await page.locator('[data-wh-price-action="save-extra"]').click();
      await page.waitForFunction(() => !window.__whPricingStateForTest.busy);
      assert.equal(await page.evaluate(() => window.__whPricingStateForTest.error), null);
    }
    const rates = await loadWolfhouseDepositRates(pg);
    assert.deepEqual(rates, desired);
    for (const nights of [5, 6]) {
      const total = (nights >= 6 ? rates.long_stay_cents : rates.short_stay_cents) * 3;
      await page.evaluate(({ rates, nights }) => {
        document.querySelector('#invoice').innerHTML = bcInvoiceDepositRowHtml({ nights, guest_count: 3, stay_deposit_rates: rates, deposit_required_cents: 20000 }, 0, 900000);
      }, { rates, nights });
      assert.equal(await page.locator('.bc-invoice-deposit-amount').innerText(), '€' + (total / 100).toFixed(2));
    }
    assert.deepEqual(errors, []);
    await matrix(pg, desired);
    console.log('PASS Chromium Admin rate edits → persisted DB → refreshed invoice row at 5/6-night boundary; no page errors');
  } finally { await browser.close(); }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
