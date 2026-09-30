'use strict';

// INVOICE-PEBBLES-PERGUEST-DEPOSIT-001
// Offline. Node proof of the locked deposit rule and link amount.
// Browser proof uses emitted portal HTML and a synthetic Tim booking.
// Usage: node scripts/verify-invoice-pebbles-perguest-deposit.js <evidence-dir>

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { wolfhouseStayDepositCents, wolfhouseBookingDepositCents } = require('./lib/wolfhouse-stay-deposit');
const { bookingDepositLinkAmount } = require('./lib/booking-deposit-payment-link');
const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'tmp/invoice-pebbles-perguest-deposit'));
fs.mkdirSync(OUT, { recursive: true });

function check(name, ok, detail) {
  assert.equal(ok, true, name + (detail ? ': ' + detail : ''));
  console.log('ok', name);
}

async function money() {
  check('7n x 3 = 60000', wolfhouseStayDepositCents(7, 3) === 60000);
  check('6n x 1 = 20000', wolfhouseStayDepositCents(6, 1) === 20000);
  check('5n x 3 = 30000', wolfhouseStayDepositCents(5, 3) === 30000);
  check('5n x 2 = 20000', wolfhouseStayDepositCents(5, 2) === 20000);
  check('missing nights falls through', wolfhouseStayDepositCents(0, 3) == null);
  const adminRates = { long_stay_cents: 25000, short_stay_cents: 15000 };
  check('admin long rate 6n x 3', wolfhouseStayDepositCents(6, 3, adminRates) === 75000);
  check('admin short rate 5n x 2', wolfhouseStayDepositCents(5, 2, adminRates) === 30000);
  check('booking rates win over stored flat', wolfhouseBookingDepositCents({
    check_in: '2026-09-26', check_out: '2026-10-03', guest_count: 3,
    deposit_required_cents: 20000, stay_deposit_rates: adminRates,
  }) === 75000);
  check('null stored stays unknown', wolfhouseBookingDepositCents({ deposit_required_cents: null }) == null);
  check('explicit zero stored stays zero', wolfhouseBookingDepositCents({ deposit_required_cents: 0 }) === 0);

  const tim = {
    check_in: '2026-09-26',
    check_out: '2026-10-03',
    guest_count: 3,
    deposit_required_cents: 20000,
    total_amount_cents: 119700,
  };
  check('stored flat 200 does not win', wolfhouseBookingDepositCents(tim) === 60000, String(wolfhouseBookingDepositCents(tim)));

  const amount = await bookingDepositLinkAmount(null, tim, [], {
    loadBookingPaymentLedger: async () => ({ invoice_total_cents: 119700 }),
  }, 'deposit');
  check('deposit link is 60000', amount.ok === true && amount.amountDueCents === 60000, JSON.stringify(amount));

  const quote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-09-26',
    check_out: '2026-10-03',
    guest_count: 3,
    package_code: 'uluwatu',
    payment_choice: 'deposit',
  });
  check('quote deposit is 60000', quote && quote.deposit_required_cents === 60000, JSON.stringify({
    success: quote && quote.success,
    deposit: quote && quote.deposit_required_cents,
    link: quote && quote.payment_link_amount_cents,
  }));
  const adminQuote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-09-26',
    check_out: '2026-10-03',
    guest_count: 3,
    package_code: 'uluwatu',
    payment_choice: 'deposit',
    stay_deposit_rates: { long_stay_cents: 25000, short_stay_cents: 15000 },
  });
  check('quote uses admin long rate', adminQuote && adminQuote.deposit_required_cents === 75000, JSON.stringify({
    deposit: adminQuote && adminQuote.deposit_required_cents,
  }));
  const shortQuote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-09-01',
    check_out: '2026-09-06',
    guest_count: 2,
    // Deposit arithmetic fixture: explicitly choose accommodation, not a now-ineligible package.
    package_code: 'package_none',
    payment_choice: 'deposit',
    stay_deposit_rates: { long_stay_cents: 25000, short_stay_cents: 15000 },
  });
  check('quote uses admin short rate', shortQuote && shortQuote.deposit_required_cents === 30000, JSON.stringify({
    nights: shortQuote && shortQuote.nights,
    deposit: shortQuote && shortQuote.deposit_required_cents,
  }));
}

async function chrome() {
  const { chromium } = require('playwright');
  const { emit } = require('./verify-booking-drawer-invoice-tab');
  const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
  const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
  const ROOT = path.resolve(__dirname, '..');
  const ORIGIN = 'http://staff.test';
  const CODE = 'WH-TIM-PEBBLES';
  const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const booking = {
    booking_id: ID, booking_code: CODE, guest_name: 'Tim', guest_count: 3,
    total_amount_cents: 119700, accommodation_total_cents: 110700,
    deposit_required_cents: 20000, amount_paid_cents: 119700, balance_due_cents: 0,
    status: 'confirmed', check_in: '2026-09-26', check_out: '2026-10-03', nights: 7,
    location_id: 'wolfhouse-somo',
  };
  const guests = ['Tom', 'Tim', 'Alexandria Verylongsurname (test)'].map((name, i) => ({
    booking_guest_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb' + i,
    guest_number: i + 1, guest_name: name, metadata: { subtotal_cents: 39900 },
    deposit_amount_cents: 20000, amount_paid_cents: i === 2 ? 20000 : 0, payment_status: i === 2 ? 'paid' : 'not_requested',
  }));
  const state = {
    success: true, booking, rooming: { assignments: [] }, booking_guests: guests, per_person: [],
    guest_accommodation_lines: guests.map((g) => ({ guest_number: g.guest_number, accommodation_cents: 36900, nights: 7 })),
    service_records: [{ service_record_id: 'surf', service_type: 'surf_lesson', quantity: 3, amount_due_cents: 9000, status: 'confirmed', metadata: {} }],
    transfers: [{ direction: 'arrival', status: 'confirmed', price_cents: 0, metadata: { label: 'Arrival + Departure' } }],
    payments: { paid_total_cents: 119700, rows: [{ payment_id: 'paid-all', payment_status: 'paid', amount_paid_cents: 119700, metadata: { payment_scope: 'booking', method: 'cash' } }] },
    pending_manual_services: [], conversation: null,
  };
  const calendar = {
    success: true,
    days: Array.from({ length: 14 }, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 26 + i)).toISOString().slice(0, 10) })),
    rooms: [{ room_code: 'R1', room_name: 'Room 1', beds: [{ bed_code: 'R1-B1', bed_label: 'Bed 1' }] }],
    blocks: [{ ...booking, room_code: 'R1', bed_code: 'R1-B1', start_date: booking.check_in, end_date: booking.check_out, source: 'staff', start_offset: 0, span: 7 }],
    warnings: [],
  };
  const html = emit('wolfhouse-somo', OUT);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() === 'GET' && u.origin === 'https://fonts.googleapis.com') return route.abort();
    if (u.origin !== ORIGIN || req.method() !== 'GET') return route.abort();
    const p = u.pathname;
    if (p === '/staff/ui') return route.fulfill({ contentType: 'text/html', body: html });
    let data;
    if (p === '/staff/bed-calendar') data = calendar;
    else if (p === `/staff/bookings/${CODE}/context`) data = state;
    else if (p === '/staff/auth/session') data = { success: true, auth_required: false, role: 'admin', clients: [{ slug: 'wolfhouse-somo', name: 'Wolfhouse' }], client_profiles: { 'wolfhouse-somo': loadClientPortalProfile('wolfhouse-somo') } };
    else if (p.startsWith('/staff/assets/')) {
      const asset = path.join(ROOT, 'config/staff-portal', path.basename(p));
      if (fs.existsSync(asset)) return route.fulfill({ path: asset });
      return route.abort();
    } else if (p === '/staff/intents') data = { success: true, intents: [] };
    else if (p === '/staff/inbox/luna-mode') data = { success: true, mode: 'off' };
    else if (p === '/staff/bot/global-pause-state') data = { success: true, paused: false };
    else if (p === '/staff/whatsapp-numbers') data = { success: true, numbers: [] };
    else if (p === '/staff/admin/house-notes') data = { success: true, notes: '' };
    else if (p === '/staff/automated-notifications') data = { success: true, notifications: [] };
    else if (p === '/staff/packages') data = { success: true, packages: [] };
    else if (p === '/staff/conversations') data = { success: true, conversations: [] };
    else if (p === '/staff/admin/config') data = { success: true, ...resolveTenantBusinessConfig('wolfhouse-somo', 'sunset-somo') };
    else if (p === '/staff/admin/config/rental-offerings') data = { success: true, offerings: [] };
    else if (p === `/staff/bookings/${ID}/services`) data = { success: true, paid_requested_services: [], unscheduled_services: [], services_by_date: [] };
    else if (p === `/staff/bookings/${ID}/transfers`) data = { success: true, transfers: state.transfers, airports: [], defaults: {} };
    else if (p === '/staff/clients') data = { success: true, clients: [{ slug: 'wolfhouse-somo', name: 'Wolfhouse' }] };
    else return route.abort();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await ctx.addInitScript(() => { localStorage.setItem('wh_staff_portal_locale', 'en'); });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(ORIGIN + '/staff/ui');
  await page.waitForFunction(() => typeof window.switchToTab === 'function' && document.getElementById('c-client').value === 'wolfhouse-somo');
  await page.evaluate(() => window.switchToTab('bed-calendar'));
  await page.locator('.bc-block').first().click();
  await page.locator('#bc-inv-totals').waitFor();
  await page.waitForFunction(() => {
    const d = document.getElementById('bc-side-drawer');
    return !!d && getComputedStyle(d).transform === 'none';
  });
  await page.waitForTimeout(50);

  const header = await page.locator('#bc-side-header-pebbles').innerText();
  check('paid pebble in header', /Paid/.test(header), header);
  check('no location pebble', !/wolfhouse-somo/.test(await page.locator('#bc-side-drawer .bc-side-head').innerText()));
  const titleBox = await page.locator('#bc-side-title').boundingBox();
  const pebbleBox = await page.locator('#bc-side-header-pebbles .pill, #bc-side-header-pebbles .transfer-pebble').first().boundingBox();
  const pinBox = await page.locator('#bc-side-pin').boundingBox();
  const layout = await page.locator('#bc-side-header-pebbles').evaluate((el) => {
    const row = el.parentElement;
    const cs = getComputedStyle(row);
    return { rowDisplay: cs.display, rowWidth: row.getBoundingClientRect().width, host: el.getBoundingClientRect().toJSON(), pill: el.querySelector('.pill').getBoundingClientRect().toJSON() };
  });
  fs.writeFileSync(path.join(OUT, 'header-boxes.json'), JSON.stringify({ titleBox, pebbleBox, pinBox, header, layout }, null, 2));
  const closeBox = await page.locator('#bc-side-close').boundingBox();
  check('pebble below pin, no overlap', pebbleBox.y >= pinBox.y + pinBox.height - 1, JSON.stringify({ pebbleBox, pinBox }));
  check('pebble right of arrow cluster', Math.abs((pebbleBox.x + pebbleBox.width) - (closeBox.x + closeBox.width)) <= 4, JSON.stringify({ pebbleBox, closeBox }));
  check('pebble not under booking code', pebbleBox.x > titleBox.x + 24, JSON.stringify({ pebbleBox, titleBox }));

  check('per guest collapsed', await page.locator('#bc-per-guest-toggle').getAttribute('aria-expanded') === 'false');
  check('per guest between transfers and totals', await page.locator('#bc-per-guest-card').evaluate((el) => el.parentElement.id === 'bc-overview-invoice' && el.previousElementSibling.id === 'bc-inv-transfers' && el.nextElementSibling.id === 'bc-inv-totals'));
  const order = await page.locator('#bc-overview-invoice, #bc-per-guest-card, #bc-payment-history-card').evaluateAll((els) => els.map((e) => e.id));
  check('per guest above history', order.indexOf('bc-per-guest-card') >= 0 && order.indexOf('bc-per-guest-card') < order.indexOf('bc-payment-history-card'), order.join(','));

  await page.locator('#bc-per-guest-toggle').click();
  const row = page.locator('.bc-guest-pay-row').last();
  const geo = await row.evaluate((e) => {
    const box = (s) => e.querySelector(s).getBoundingClientRect();
    const name = box('.bc-guest-pay-name');
    const paid = box('.bc-guest-pay-paid');
    const price = e.querySelector('.bc-guest-pay-price');
    const owed = e.querySelector('.bc-guest-pay-owed');
    const titles = [...e.querySelectorAll('.bc-guest-pay-title')].map((el) => el.textContent);
    return {
      moneyBelow: paid.top >= name.bottom - 1,
      noOverlap: name.bottom <= paid.top + 1,
      oweRight: owed.getBoundingClientRect().right >= e.getBoundingClientRect().right - 1,
      totalLeftOfPaid: price.getBoundingClientRect().right <= paid.left,
      titles,
      weight: getComputedStyle(price).fontWeight,
    };
  });
  check('guest money on next line', geo.moneyBelow === true && geo.noOverlap === true, JSON.stringify(geo));
  check('owe on the right', geo.oweRight === true && geo.totalLeftOfPaid === true, JSON.stringify(geo));
  check('titles Total Paid Owe', geo.titles.join(',') === 'Total,Paid,Owe', JSON.stringify(geo.titles));
  check('price unbold', Number(geo.weight) < 700, geo.weight);

  const deposit = await page.locator('.bc-invoice-deposit-amount').innerText();
  check('totals deposit 600', deposit === '€600.00', deposit);
  const align = await page.locator('#bc-inv-totals .ctx-inv-total-amount').evaluateAll((els) => {
    const rights = els.map((e) => e.getBoundingClientRect().right);
    const card = document.getElementById('bc-inv-totals').getBoundingClientRect().right;
    return { rights, card, textAlign: els.map((e) => getComputedStyle(e).textAlign) };
  });
  check('totals amounts right aligned', align.textAlign.every((a) => a === 'right') && Math.max(...align.rights) - Math.min(...align.rights) <= 1, JSON.stringify(align));
  await page.locator('#bc-per-guest-card').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'tim-invoice.png') });
  await browser.close();
}

(async () => {
  await money();
  await chrome();
  console.log('PASS verify-invoice-pebbles-perguest-deposit');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
