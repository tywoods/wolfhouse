'use strict';
// Offline synthetic fixtures, real emitted HTML, ordinary calendar entry; never starts a server.
// Usage: node scripts/verify-invoice-mobile-guest-row-one-line.js <evidence-dir>
// INVOICE_TEST_HTML optionally supplies preserved base HTML for a negative control.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { emit } = require('./verify-booking-drawer-invoice-tab');
const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
const ROOT = path.resolve(__dirname, '..'), OUT = path.resolve(process.argv[2]);
const ORIGIN = 'http://staff.test', CODE = 'WH-ONE-LINE', ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const hash = x => createHash('sha256').update(x).digest('hex');
const short = ['Tom', 'Tim', 'Tyler'];
const long = ['Zoë <img src="https://escape.invalid/x"> & "Family"', 'Alexandria Verylongsurname (test)', 'Alexandria Verylongsurname (test)'];
function fixture(kind) {
  const names = kind === 'long' ? long : kind === 'missing' ? ['Tom', 'Tim', ''] : kind === 'fallback' ? ['', '', ''] : short;
  const booking = { booking_id: ID, booking_code: CODE, guest_name: names[0], guest_count: 3, total_amount_cents: 90000, accommodation_total_cents: 90000, deposit_required_cents: 27000, amount_paid_cents: 9000, balance_due_cents: 81000, status: 'confirmed', check_in: '2026-09-24', check_out: '2026-09-29', nights: 5 };
  if (kind === 'fallback') booking.guest_name = 'Tom';
  return { success: true, booking, rooming: { assignments: [] }, booking_guests: names.map((name, i) => ({ booking_guest_id: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${i}`, guest_number: i + 1, guest_name: name, assigned_bed_code: kind === 'missing' && i === 1 ? '' : kind === 'mixed' ? ['R1-B1', 'R1-B12', 'R2-B14'][i] : 'R1-B' + (i + 1), metadata: { subtotal_cents: 30000 }, deposit_amount_cents: 9000, amount_paid_cents: i === 1 ? 9000 : 0, payment_status: i === 1 ? 'paid' : 'not_requested' })), per_person: [], guest_accommodation_lines: names.map((_, i) => ({ guest_number: i + 1, accommodation_cents: 30000, nights: 5 })), service_records: [], transfers: [], payments: { paid_total_cents: kind === 'paid' ? 90000 : 9000, rows: kind === 'paid' ? [{ payment_id: 'paid-all', payment_status: 'paid', amount_paid_cents: 90000, metadata: { payment_scope: 'booking', method: 'cash' } }] : [] }, pending_manual_services: [], conversation: null };
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const html = process.env.INVOICE_TEST_HTML ? fs.readFileSync(process.env.INVOICE_TEST_HTML, 'utf8') : emit('wolfhouse-somo', OUT);
  fs.writeFileSync(path.join(OUT, 'wolfhouse-somo.html'), html);
  const ledger = [], errors = [], cases = [], observations = [], failures = [];
  let state = fixture('short'), page;
  const other = fixture('short'); other.booking = { ...other.booking, booking_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', booking_code: 'WH-OTHER', guest_name: 'Other booking' };
  other.booking_guests[0].guest_name = 'Other booking';
  const calendar = { success: true, days: Array.from({ length: 14 }, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 24 + i)).toISOString().slice(0, 10) })), rooms: [{ room_code: 'R1', room_name: 'Room 1', beds: [1, 2, 3, 4].map(i => ({ bed_code: 'R1-B' + i, bed_label: 'Bed ' + i })) }], blocks: [state, other].map((s, i) => ({ ...s.booking, room_code: 'R1', bed_code: 'R1-B' + (i ? 4 : 1), start_date: s.booking.check_in, end_date: s.booking.check_out, source: 'staff', start_offset: 0, span: 5 })), warnings: [] };
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 320, height: 1000 }, serviceWorkers: 'block' });
  await ctx.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url()), e = { method: req.method(), url: req.url() }; ledger.push(e);
    if (req.method() === 'GET' && u.origin === 'https://fonts.googleapis.com' && u.pathname === '/css2') { e.optionalFontAborted = true; return route.abort(); }
    if (u.origin !== ORIGIN || req.method() !== 'GET') { e.blocked = true; return route.abort(); }
    const p = u.pathname; let data;
    if (p === '/staff/ui') return route.fulfill({ contentType: 'text/html', body: html });
    if (p === '/staff/bed-calendar') data = calendar;
    else if (p === `/staff/bookings/${CODE}/context`) data = state;
    else if (p === '/staff/bookings/WH-OTHER/context') data = other;
    else if (p === '/staff/auth/session') data = { success: true, auth_required: false, role: 'admin', clients: [{ slug: 'wolfhouse-somo', name: 'Wolfhouse' }], client_profiles: { 'wolfhouse-somo': loadClientPortalProfile('wolfhouse-somo') } };
    else if (p.startsWith('/staff/assets/')) { const asset = path.join(ROOT, 'config/staff-portal', path.basename(p)); if (fs.existsSync(asset)) return route.fulfill({ path: asset }); e.unknown = true; return route.abort(); }
    else if (p === '/staff/intents') data = { success: true, intents: [] };
    else if (p === '/staff/inbox/luna-mode') data = { success: true, mode: 'off' };
    else if (p === '/staff/bot/global-pause-state') data = { success: true, paused: false };
    else if (p === '/staff/whatsapp-numbers') data = { success: true, numbers: [] };
    else if (p === '/staff/admin/house-notes') data = { success: true, notes: '' };
    else if (p === '/staff/automated-notifications') data = { success: true, notifications: [] };
    else if (p === '/staff/packages') data = { success: true, packages: [] };
    else if (p === '/staff/conversations') data = { success: true, conversations: [] };
    else if (p === '/staff/admin/config') data = { success: true, ...resolveTenantBusinessConfig('wolfhouse-somo', 'sunset-somo') };
    else if (p === '/staff/admin/config/rental-offerings') data = { success: true, offerings: [] };
    else if ([ID, other.booking.booking_id].some(id => p === `/staff/bookings/${id}/services`)) data = { success: true, paid_requested_services: [], unscheduled_services: [], services_by_date: [] };
    else if ([ID, other.booking.booking_id].some(id => p === `/staff/bookings/${id}/transfers`)) data = { success: true, transfers: [], airports: [], defaults: {} };
    else if (p === '/staff/clients') data = { success: true, clients: [{ slug: 'wolfhouse-somo', name: 'Wolfhouse' }] };
    else { e.unknown = true; return route.abort(); }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await ctx.addInitScript(() => { localStorage.setItem('wh_staff_portal_locale', 'en'); window.WebSocket = function () { throw Error('Offline WebSocket denied'); }; window.EventSource = function () { throw Error('Offline EventSource denied'); }; });
  async function settle() { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); }
  async function select(index) {
    const code = index ? 'WH-OTHER' : CODE;
    const response = page.waitForResponse(r => new URL(r.url()).pathname === `/staff/bookings/${code}/context`);
    await page.locator('.bc-block').nth(index).click(); await page.mouse.move(10, 500); await response;
    await page.waitForFunction(name => document.getElementById('bc-field-contact-name')?.value === name, index ? 'Other booking' : state.booking.guest_name);
    await page.locator('#bc-inv-totals').waitFor(); await settle();
  }
  async function open(width, theme) {
    if (page) await page.close();
    page = await ctx.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(String(e)));
    await page.setViewportSize({ width, height: 1000 }); await page.goto(ORIGIN + '/staff/ui');
    await page.waitForFunction(() => typeof window.switchToTab === 'function' && document.getElementById('c-client').value === 'wolfhouse-somo');
    await page.evaluate(() => window.switchToTab('bed-calendar')); await select(0);
    await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
    assert(await page.locator(width <= 768 ? '#bc-detail #bc-drawer-card-booking' : '#bc-side-drawer #bc-drawer-card-booking').isVisible(), 'ordinary active mount');
  }
  async function measure(label, width, theme, kind, selected = state) {
    await page.locator('#bc-field-group-guests').scrollIntoViewIfNeeded(); await settle();
    const rows = await page.locator('#bc-guest-names .bc-guest-name-row').evaluateAll(es => es.map(e => {
      const rect = n => n ? n.getBoundingClientRect().toJSON() : null;
      const n = e.querySelector('.bc-guest-name-line'), b = e.querySelector('.bc-guest-bed'), s = e.querySelector('.bc-accom-pay-pebble');
      const text = el => { if (!el) return null; const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().toJSON(); };
      return { name: n.textContent, bed: b?.textContent || '', status: s?.textContent || '', row: rect(e), n: rect(n), b: rect(b), s: rect(s), nameText: text(n), bedText: text(b), statusText: text(s), nameStyle: { whiteSpace: getComputedStyle(n).whiteSpace, overflow: getComputedStyle(n).overflow, textOverflow: getComputedStyle(n).textOverflow }, nameOverflow: n.scrollWidth > n.clientWidth, rowOverflow: e.scrollWidth > e.clientWidth, children: n.children.length };
    }));
    const pen = await page.locator('#bc-field-group-guests .btn-bc-field-edit').evaluate(e => ({ box: e.getBoundingClientRect().toJSON(), fontSize: getComputedStyle(e).fontSize }));
    observations.push({ label, width, theme, kind, rows, pen });
    await page.locator('#bc-field-group-guests').screenshot({ path: path.join(OUT, label + '.png') });
    try {
      const expectedNames = kind === 'fallback' ? ['Tom'] : selected.booking_guests.map(g => g.guest_name).filter(Boolean);
      assert.equal(rows.length, expectedNames.length, 'native named rows; empty durable slots are not invented');
      assert.deepEqual(rows.map(r => r.name), expectedNames, 'full DOM names and native booking-name fallback');
      assert.deepEqual(rows.map(r => r.status), kind === 'fallback' ? [''] : kind === 'paid' ? ['Paid', 'Paid', 'Paid'] : kind === 'missing' ? ['Unpaid', 'Deposit Paid'] : ['Unpaid', 'Deposit Paid', 'Unpaid'], 'unchanged payment truth');
      if (kind === 'mixed') assert.deepEqual(rows.map(r => r.bed), ['R1-B1', 'R1-B12', 'R2-B14'], 'mixed-width bed codes remain complete');
      assert(pen.box.width >= 20 && pen.box.height >= 20 && parseFloat(pen.fontSize) >= 12, 'readable pencil');
      assert(pen.box.left >= 0 && pen.box.right <= width + 1, 'pencil contained');
      for (const r of rows) {
        assert.equal(r.children, 0, 'escaped names stay inert text');
        assert(!r.rowOverflow && r.row.left >= 0 && r.row.right <= width + 1, 'row contained');
        assert((r.s || r.n).right <= pen.box.left + 1 || r.row.top >= pen.box.bottom, 'pencil never overlaps row');
        if (width <= 768) {
          const center = b => (b.top + b.bottom) / 2;
          if (r.s) assert(Math.abs(center(r.n) - center(r.s)) <= 1, 'MOBILE_ONE_LINE name/status vertical centers: ' + JSON.stringify(r));
          if (r.b) { assert(Math.abs(center(r.n) - center(r.b)) <= 1, 'same bed center'); assert(r.n.right <= r.b.left + 1 && r.b.right <= r.s.left + 1, 'name/bed/status non-overlap'); }
          else if (r.s) assert(r.n.right <= r.s.left + 1, 'missing bed keeps status separate');
          assert(r.n.width >= 40, 'readable name allocation, not a single letter');
          assert.deepEqual(r.nameStyle, { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, 'mobile-only safe ellipsis');
          if (short.includes(r.name)) assert(!r.nameOverflow, 'basic short name remains completely readable: ' + r.name);
        } else { assert(r.n.width >= 100 && !r.nameOverflow, 'desktop full names retained'); }
        for (const [box, text] of [[r.b, r.bedText], [r.s, r.statusText]]) if (box) assert(text.width <= box.width + 1 && text.height <= box.height + 1, 'bed/status complete and untruncated');
      }
      if (width <= 768) {
        const beds = rows.filter(r => r.b), statuses = rows.filter(r => r.s);
        assert(beds.every(r => Math.abs(r.b.right - beds[0].b.right) <= 1), 'shared right-aligned bed column is stable across mixed bed and status lengths');
        assert(statuses.every(r => Math.abs(r.s.right - statuses[0].s.right) <= 1), 'shared status column, including absent bed');
      }
      cases.push(label);
    } catch (e) { failures.push({ label, message: e.message }); }
  }
  try {
    for (const width of [320, 390, 430, 768, 769, 1440]) for (const theme of ['light', 'dark']) {
      for (const kind of ['short', 'paid', 'long', 'missing', 'fallback', 'mixed']) {
        state = fixture(kind); await open(width, theme); await measure(`${width}-${theme}-${kind}`, width, theme, kind);
        if (kind === 'long') {
          await page.locator('#bc-field-group-guests .btn-bc-field-edit').click();
          assert.deepEqual(await page.locator('.bc-inline-guest-name').evaluateAll(es => es.map(e => e.value)), long, 'pencil opens full long, escaped and duplicate names');
          await page.locator('.bc-inline-guest-name').nth(1).fill('Cancelled edit'); await page.locator('#bc-inline-cancel').click();
          await measure(`${width}-${theme}-cancel`, width, theme, kind);
        }
      }
      state = fixture('short'); await open(width, theme);
      state = fixture('paid');
      const response = page.waitForResponse(r => new URL(r.url()).pathname === `/staff/bookings/${CODE}/context`);
      await page.locator('#bc-refresh-links-btn').click(); await response; await settle();
      await page.waitForFunction(() => [...document.querySelectorAll('#bc-guest-names .bc-accom-pay-pebble')].every(e => e.textContent === 'Paid'));
      await measure(`${width}-${theme}-refresh`, width, theme, 'paid');
      await select(1); await measure(`${width}-${theme}-switch`, width, theme, 'short', other);
      await select(0); await measure(`${width}-${theme}-switch-back`, width, theme, 'paid');
      if (width > 768) { await page.locator('#bc-side-close').click(); await select(0); }
      else await open(width, theme); // Native inline mobile detail has no close button.
      await measure(`${width}-${theme}-reopen`, width, theme, 'paid');
    }
    assert.equal(observations.length, 132, 'complete matrix');
    assert.deepEqual(errors, [], 'no page errors');
    assert.deepEqual(ledger.filter(e => e.blocked || e.unknown || e.method !== 'GET'), [], 'fail-closed isolation; no unknowns, unexpected external attempts or writes (optional font aborted)');
    assert.equal(failures.length, 0, JSON.stringify(failures));
    assert.equal(cases.length, 132);
  } catch (e) { failures.push({ label: 'suite', message: e.stack }); }
  finally {
    await browser.close();
    const sourceHashes = Object.fromEntries(['staff-query-api.js', 'verify-invoice-mobile-guest-names.js', 'verify-invoice-mobile-guest-row-one-line.js'].map(f => [f, hash(fs.readFileSync(path.join(ROOT, 'scripts', f)))]));
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ passed: failures.length === 0, cases, observations, failures, ledger, errors, htmlSha256: hash(html), sourceHashes }, null, 2));
  }
  if (failures.length) { console.error(`FAIL ${failures.length} failures; ${cases.length}/132 groups passed; ${OUT}`); process.exitCode = 1; }
  else console.log(`PASS ${cases.length} one-line groups; ${OUT}`);
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
