'use strict';
// Ordinary emitted portal -> calendar block -> guest name -> Booking Details pencil.
// Browser/payload proof only: synthetic HTTP fixtures, never a server or SQL proof.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'tmp/per-guest-dates-browser'));
const ORIGIN = 'http://staff.test';
const CODE = 'WH-GUEST-DATES-TEST';
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
const GIDS = ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'];
const clone = value => JSON.parse(JSON.stringify(value));
const nights = (start, end) => (Date.parse(end) - Date.parse(start)) / 86400000;
function fixture() {
  const booking = { booking_id: ID, booking_code: CODE, guest_name: 'Lead synthetic guest', guest_count: 3,
    total_amount_cents: 90000, accommodation_total_cents: 90000, deposit_required_cents: 27000,
    amount_paid_cents: 0, balance_due_cents: 90000, status: 'confirmed', check_in: '2026-09-24', check_out: '2026-09-29', nights: 5 };
  const stays = [['2026-09-24', '2026-09-29'], ['2026-09-25', '2026-09-29'], ['2026-09-26', '2026-09-29']];
  const booking_guests = GIDS.map((id, i) => ({ booking_guest_id: id, guest_number: i + 1,
    guest_name: ['Lead synthetic guest', 'Second synthetic guest', 'Third synthetic guest'][i],
    assigned_bed_code: 'R1-B' + (i + 1), check_in: stays[i][0], check_out: stays[i][1],
    nights: nights(...stays[i]), metadata: { subtotal_cents: nights(...stays[i]) * 7500 },
    deposit_amount_cents: 9000, amount_paid_cents: 0, payment_status: 'not_requested' }));
  return { success: true, booking, rooming: { assignments: [] }, booking_guests,
    guest_accommodation_lines: booking_guests.map(g => ({ booking_guest_id: g.booking_guest_id,
      guest_number: g.guest_number, accommodation_cents: g.metadata.subtotal_cents, nights: g.nights })),
    per_person: [], service_records: [], transfers: [], payments: { paid_total_cents: 0, rows: [] },
    pending_manual_services: [], conversation: null };
}
function otherFixture() {
  const data = fixture();
  data.booking = { ...data.booking, booking_id: OTHER_ID, booking_code: 'WH-OTHER', guest_name: 'Other booking', guest_count: 1 };
  data.booking_guests = [{ ...data.booking_guests[0], booking_guest_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', guest_name: 'Other booking' }];
  data.guest_accommodation_lines = [{ ...data.guest_accommodation_lines[0], booking_guest_id: data.booking_guests[0].booking_guest_id }];
  return data;
}
function calendarFixture(state, other) {
  return { success: true, days: Array.from({ length: 14 }, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 24 + i)).toISOString().slice(0, 10) })),
    rooms: [{ room_code: 'R1', room_name: 'Room 1', beds: [1, 2, 3, 4].map(i => ({ bed_code: 'R1-B' + i, bed_label: 'Bed ' + i })) }],
    blocks: [...state.booking_guests.map((g, i) => ({ ...state.booking, room_code: 'R1', bed_code: 'R1-B' + (i + 1),
      start_date: state.booking.check_in, end_date: state.booking.check_out, source: 'staff', start_offset: 0, span: 5,
      calendar_group_size: 3, calendar_guest_number: i + 1, calendar_guest_share_cents: g.metadata.subtotal_cents,
      calendar_guest_deposit_cents: 9000, calendar_guest_paid_cents: 0 })),
    { ...other.booking, room_code: 'R1', bed_code: 'R1-B4', start_date: other.booking.check_in, end_date: other.booking.check_out,
      source: 'staff', start_offset: 0, span: 5, calendar_group_size: 1, calendar_guest_number: 1 }], warnings: [] };
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const emitted = path.join(OUT, 'wolfhouse-somo.html');
  // Optional third argument replays retained, unmodified production HTML for RED
  // even when another owner is concurrently implementing the product change.
  const retained = process.argv[3] && path.resolve(process.argv[3]);
  if (retained) {
    if (retained !== emitted) fs.copyFileSync(retained, emitted);
  } else {
    const emit = spawnSync(process.execPath, [path.join(ROOT, 'scripts/verify-inbox-ui-parity.js'), '--emit', 'wolfhouse-somo', emitted],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, STAFF_ACTIONS_ENABLED: 'true', STRIPE_LINKS_ENABLED: 'true' } });
    assert.equal(emit.status, 0, emit.stderr || emit.stdout);
  }
  const html = fs.readFileSync(emitted, 'utf8');
  const ledger = [], errors = [], dialogs = [], cases = [], observations = [];
  let state = fixture(), other = otherFixture(), writeControl = null, activeCase = '';
  const controls = new Set();
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await ctx.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    const e = { case: activeCase, method: req.method(), url: req.url() }; ledger.push(e);
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    // This is the sole allowed write. No continue/fetch/forwarding anywhere.
    if (req.url() === ORIGIN + '/staff/bookings/edit' && req.method() === 'POST') {
      e.syntheticWrite = true; e.raw = req.postData(); e.body = req.postDataJSON();
      const b = e.body;
      const target = b.booking_id === ID && b.booking_code === CODE ? state :
        b.booking_id === OTHER_ID && b.booking_code === 'WH-OTHER' ? other : null;
      if (!target || b.client_slug !== 'wolfhouse-somo') { e.invalidIdentity = true; return json({ success: false, error: 'Wrong synthetic booking identity' }, 422); }
      const control = writeControl; writeControl = null;
      if (control?.hold) {
        e.held = true; controls.add(control);
        await new Promise(resolve => { control.release = resolve; });
        controls.delete(control); e.released = true;
      }
      if (control?.network) { e.outcome = 'network'; return route.abort('failed'); }
      if (control?.fail) { e.outcome = 'http'; return json({ success: false, error: 'Synthetic guest date save failed' }, 503); }
      const guest = target.booking_guests.find(g => g.booking_guest_id && g.booking_guest_id === b.booking_guest_id);
      // Record legacy dates requests, but do NOT simulate a group mutation as a guest save.
      if (b.edit_type !== 'guest_dates' || !guest) { e.outcome = 'invalid-contract'; return json({ success: false, error: 'Guest-scoped dates and stable identity required' }, 422); }
      if (b.expected_check_in !== guest.check_in || b.expected_check_out !== guest.check_out) {
        e.outcome = 'conflict'; return json({ success: false, error: 'Synthetic stale guest dates' }, 409);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.check_in) || !/^\d{4}-\d{2}-\d{2}$/.test(b.check_out) || !(nights(b.check_in, b.check_out) > 0)) {
        e.outcome = 'invalid-dates'; return json({ success: false, error: 'Invalid guest date range' }, 422);
      }
      guest.check_in = b.check_in; guest.check_out = b.check_out; guest.nights = nights(b.check_in, b.check_out);
      guest.metadata.subtotal_cents = guest.nights * 7500;
      const line = target.guest_accommodation_lines.find(g => g.booking_guest_id === guest.booking_guest_id);
      line.nights = guest.nights; line.accommodation_cents = guest.metadata.subtotal_cents;
      // Invoice aggregates change with authoritative fixture lines; group dates and siblings do not.
      const total = target.guest_accommodation_lines.reduce((sum, row) => sum + row.accommodation_cents, 0);
      Object.assign(target.booking, { accommodation_total_cents: total, total_amount_cents: total, balance_due_cents: total });
      e.outcome = 'saved'; e.savedGuest = clone(guest);
      return json({ success: true, updated: true });
    }
    if (u.origin !== ORIGIN || req.method() !== 'GET') {
      e.blocked = true;
      e.expectedOfflineFontBlock = req.method() === 'GET' && u.origin === 'https://fonts.googleapis.com' && u.pathname === '/css2';
      return route.abort();
    }
    const p = u.pathname; let data;
    if (p === '/staff/ui') return route.fulfill({ contentType: 'text/html', body: html });
    if (p === '/staff/bed-calendar') data = calendarFixture(state, other);
    else if (p === `/staff/bookings/${CODE}/context`) data = state;
    else if (p === '/staff/bookings/WH-OTHER/context') data = other;
    else if (p === '/staff/auth/session') data = { success: true, auth_required: false, role: 'admin', clients: [{ slug: 'wolfhouse-somo', name: 'Wolfhouse' }], client_profiles: { 'wolfhouse-somo': loadClientPortalProfile('wolfhouse-somo') } };
    else if (p.startsWith('/staff/assets/')) {
      const asset = path.join(ROOT, 'config/staff-portal', path.basename(p));
      if (fs.existsSync(asset)) return route.fulfill({ path: asset });
      e.unknown = true; return route.abort();
    }
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
    // Unrelated admin panel is unavailable in this synthetic booking-only session.
    else if (p === '/staff/luna-intelligence/room-fill') return json({ success: false, error: 'Offline booking-only fixture' }, 403);
    else if ([ID, OTHER_ID].some(id => p === `/staff/bookings/${id}/services`)) data = { success: true, paid_requested_services: [], unscheduled_services: [], services_by_date: [] };
    else if ([ID, OTHER_ID].some(id => p === `/staff/bookings/${id}/transfers`)) data = { success: true, client_slug: 'wolfhouse-somo', booking_id: p.split('/')[3], transfers: [], airports: [], defaults: {} };
    else if (p === '/staff/clients') data = { success: true, clients: [{ slug: 'wolfhouse-somo', name: 'Wolfhouse' }] };
    else { e.unknown = true; return route.abort(); }
    return json(data);
  });
  await ctx.addInitScript(() => {
    localStorage.setItem('wh_staff_portal_locale', 'en');
    window.WebSocket = function() { throw new Error('Offline WebSocket denied'); };
    window.EventSource = function() { throw new Error('Offline EventSource denied'); };
  });
  const page = await ctx.newPage(); page.setDefaultTimeout(8000);
  page.on('pageerror', e => errors.push({ case: activeCase, error: String(e) }));
  page.on('dialog', async d => { dialogs.push({ case: activeCase, message: d.message() }); await d.accept(); });
  const writes = () => ledger.filter(e => e.syntheticWrite);
  const reads = () => ledger.filter(e => new URL(e.url).pathname.endsWith('/context')).length;
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const inputIn = () => page.locator('#bc-field-dates-check-in');
  const inputOut = () => page.locator('#bc-field-dates-check-out');
  const pen = () => page.locator('#bc-field-group-guests .btn-bc-field-edit').click();
  const save = () => page.locator('#bc-inline-save');
  const cancel = () => page.locator('#bc-inline-cancel');
  async function open(width) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(ORIGIN + '/staff/ui');
    await page.waitForFunction(() => typeof window.switchToTab === 'function' && document.getElementById('c-client').value === 'wolfhouse-somo');
    await page.evaluate(() => window.switchToTab('bed-calendar'));
    await page.locator('.bc-block').first().click(); await page.mouse.move(10, 500);
    await page.locator('#bc-inv-totals').waitFor();
    assert(await page.locator(width <= 768 ? '#bc-detail #bc-drawer-card-booking' : '#bc-side-drawer #bc-drawer-card-booking').isVisible(), 'ordinary calendar click opens active native drawer');
  }
  async function edit(index = 1) {
    const line = page.locator('#bc-guest-names .bc-guest-name-line').nth(index);
    // Native row clicks toggle selection; do not deselect the restored row after Cancel.
    if (!(await line.evaluate(node => node.classList.contains('is-active')))) await line.click();
    await pen(); assert(await inputIn().isVisible()); assert(await inputOut().isVisible());
  }
  async function dates() { return { check_in: await inputIn().inputValue(), check_out: await inputOut().inputValue() }; }
  async function fill(start, end) { await inputIn().fill(start); await inputOut().fill(end); }
  async function saved() { await page.waitForFunction(() => document.querySelector('#bc-inline-edit-bar')?.hidden === true); await settle(); }
  async function postSave() {
    const requested = page.waitForRequest(r => r.url() === ORIGIN + '/staff/bookings/edit' && r.method() === 'POST');
    await save().click(); return (await requested).postDataJSON();
  }
  function assertPayload(body, guest, start, end, booking = state.booking) {
    // Deliberately assert the real legacy symptom BEFORE any new selector or input assertion.
    assert.equal(body.edit_type, 'guest_dates', 'selected non-lead guest Save must be guest-scoped, never booking-wide dates');
    assert.equal(body.booking_guest_id, guest.booking_guest_id, 'stable selected guest identity, not array index/name');
    for (const [key, value] of Object.entries({ client_slug: 'wolfhouse-somo', booking_id: booking.booking_id,
      booking_code: booking.booking_code, check_in: start, check_out: end,
      expected_check_in: guest.check_in, expected_check_out: guest.check_out })) assert.equal(body[key], value, key);
  }
  async function run(name, fn) {
    activeCase = name; state = fixture(); other = otherFixture(); writeControl = null;
    const start = ledger.length;
    try { await fn(); cases.push({ name, passed: true }); console.log('PASS ' + name); }
    catch (e) {
      cases.push({ name, passed: false, failure: e.stack }); console.error('FAIL ' + name + ': ' + e.message);
      await page.screenshot({ path: path.join(OUT, name + '-red.png'), fullPage: true }).catch(() => {});
    } finally {
      for (const control of controls) control.release();
      fs.writeFileSync(path.join(OUT, name + '-requests.json'), JSON.stringify(ledger.slice(start), null, 2));
    }
  }
  try {
    // Primary RED probes must run first on desktop AND phone, not stop at absent new UI.
    for (const width of [1440, 390]) for (const mode of ['extend', 'shorten']) {
      await run(`${width}-${mode}-selected-guest`, async () => {
        await open(width); await edit();
        const before = clone(state), guest = before.booking_guests[1], initial = await dates();
        const start = mode === 'extend' ? '2026-09-24' : '2026-09-26';
        const end = mode === 'extend' ? '2026-10-01' : '2026-09-28';
        await fill(start, end);
        await page.locator('#bc-drawer-card-booking').screenshot({ path: path.join(OUT, activeCase + '-before-save.png') });
        const count = writes().length, body = await postSave();
        observations.push({ case: activeCase, initial, expectedInitial: { check_in: guest.check_in, check_out: guest.check_out }, body });
        fs.writeFileSync(path.join(OUT, activeCase + '-payload.json'), JSON.stringify(body, null, 2));
        assertPayload(body, guest, start, end);
        assert.deepEqual(initial, { check_in: guest.check_in, check_out: guest.check_out }, 'editor initializes from selected guest, not booking envelope');
        await saved(); assert.equal(writes().length, count + 1, 'one date write only');
        assert.deepEqual(state.booking_guests.filter(g => g.booking_guest_id !== guest.booking_guest_id), before.booking_guests.filter(g => g.booking_guest_id !== guest.booking_guest_id), 'siblings preserved');
        assert.deepEqual(state.guest_accommodation_lines.filter(g => g.booking_guest_id !== guest.booking_guest_id), before.guest_accommodation_lines.filter(g => g.booking_guest_id !== guest.booking_guest_id), 'sibling accommodation lines preserved');
        assert.equal(state.booking.check_in, before.booking.check_in); assert.equal(state.booking.check_out, before.booking.check_out);
        const updated = state.booking_guests[1];
        assert.equal(updated.nights, nights(start, end)); assert.equal(updated.metadata.subtotal_cents, nights(start, end) * 7500);
        assert.equal(state.guest_accommodation_lines[1].accommodation_cents, updated.metadata.subtotal_cents);
        await open(width); await edit(); assert.deepEqual(await dates(), { check_in: start, check_out: end }, 'ordinary reopen reflects saved selected-guest dates');
        await page.locator('#bc-drawer-card-booking').screenshot({ path: path.join(OUT, activeCase + '-reopened.png') });
      });
    }
    for (const width of [1440, 390]) {
      await run(`${width}-cancel`, async () => {
        await open(width); await edit(); const before = clone(state), count = writes().length;
        await fill('2026-09-24', '2026-10-02'); await cancel().click();
        assert.equal(writes().length, count, 'Cancel never posts'); assert.deepEqual(state, before);
        await edit(); assert.deepEqual(await dates(), { check_in: before.booking_guests[1].check_in, check_out: before.booking_guests[1].check_out }, 'Cancel restores selected guest dates');
      });
      for (const outcome of ['http', 'network']) await run(`${width}-${outcome}-failure-retains-editor`, async () => {
        await open(width); await edit(); const before = clone(state);
        await fill('2026-09-24', '2026-10-02'); writeControl = outcome === 'http' ? { fail: true } : { network: true };
        const body = await postSave();
        await page.waitForFunction(() => document.getElementById('bc-inline-save')?.disabled === false);
        assert(await inputOut().isVisible(), 'failed Save does not close editor');
        assert.deepEqual(await dates(), { check_in: '2026-09-24', check_out: '2026-10-02' });
        assert(await cancel().isEnabled()); assert.deepEqual(state, before, 'failed save leaves fixture untouched');
        assertPayload(body, before.booking_guests[1], '2026-09-24', '2026-10-02');
        await postSave(); await saved(); assert.equal(state.booking_guests[1].check_out, '2026-10-02', 'retry succeeds');
      });
      await run(`${width}-switch-guest-inputs`, async () => {
        // Reordered context and duplicate names must not turn display order/name into identity.
        state.booking_guests[1].guest_name = state.booking_guests[2].guest_name = 'Same synthetic name';
        state.booking_guests.reverse(); await open(width); await edit();
        const select = page.locator('#bc-field-dates-guest');
        assert(await select.isVisible(), 'date editor offers explicit guest selection');
        assert.equal(await select.inputValue(), GIDS[1]);
        await fill('2026-09-24', '2026-10-03'); await select.selectOption(GIDS[2]);
        const guest = clone(state.booking_guests.find(g => g.booking_guest_id === GIDS[2]));
        assert.deepEqual(await dates(), { check_in: guest.check_in, check_out: guest.check_out }, 'switch replaces inputs, not only identity');
        await fill('2026-09-27', '2026-09-30'); const body = await postSave();
        assertPayload(body, guest, '2026-09-27', '2026-09-30'); await saved();
        assert.equal(state.booking_guests.find(g => g.booking_guest_id === GIDS[1]).check_out, '2026-09-29', 'abandoned guest draft never saves');
      });
      await run(`${width}-no-active-guest-deliberate-choice`, async () => {
        await open(width); await pen(); const select = page.locator('#bc-field-dates-guest');
        assert(await select.isVisible(), 'no active row exposes guest chooser');
        assert.equal(await select.inputValue(), '', 'no implicit lead or group date edit');
        const count = writes().length;
        if (await inputIn().isEnabled() && await inputOut().isEnabled()) await fill('2026-09-24', '2026-10-02');
        if (await save().isEnabled()) await save().click();
        await settle(); assert.equal(writes().length, count, 'unselected dates cannot write');
        // Reopen if unchanged Save closed the editor, then make a deliberate selection.
        if (!(await select.isVisible())) await pen();
        await select.selectOption(GIDS[2]);
        assert.deepEqual(await dates(), { check_in: state.booking_guests[2].check_in, check_out: state.booking_guests[2].check_out });
      });
      await run(`${width}-missing-identity-cannot-save`, async () => {
        delete state.booking_guests[1].booking_guest_id;
        await open(width); await edit(); const count = writes().length, before = clone(state);
        if (await inputIn().isEnabled() && await inputOut().isEnabled()) await fill('2026-09-24', '2026-10-02');
        if (await save().isEnabled()) await save().click();
        await settle(); assert.equal(writes().length, count, 'missing durable guest ID must not dispatch booking-wide dates or invented identity');
        assert.deepEqual(state, before);
      });
      for (const outcome of ['success', 'http', 'network']) await run(`${width}-stale-${outcome}-preserves-new-booking`, async () => {
        await open(width); await edit(); await fill('2026-09-24', '2026-10-02');
        const control = { hold: true, fail: outcome === 'http', network: outcome === 'network' }; writeControl = control;
        const body = await postSave();
        await page.locator('.bc-block').nth(3).click(); await page.mouse.move(10, 500);
        await page.waitForFunction(() => document.getElementById('bc-field-contact-name')?.value === 'Other booking');
        await edit(0); await fill('2026-09-25', '2026-10-03');
        const node = await inputOut().elementHandle(), count = reads(), ds = dialogs.length;
        const done = outcome === 'network' ? page.waitForEvent('requestfailed', { predicate: r => r.method() === 'POST' }) :
          page.waitForResponse(r => r.request().method() === 'POST');
        control.release(); await done; await settle();
        assert(await node.evaluate(e => e.isConnected && e.value === '2026-10-03'), 'stale completion cannot replace/close the new booking editor');
        assert(await save().isEnabled()); assert(await cancel().isEnabled());
        assert.equal(reads(), count, 'obsolete completion cannot refresh either editor'); assert.equal(dialogs.length, ds, 'obsolete failure cannot alert');
        assertPayload(body, fixture().booking_guests[1], '2026-09-24', '2026-10-02', fixture().booking);
        assert.equal(other.booking_guests[0].check_out, '2026-09-29', 'new booking unsaved draft stays unsaved');
      });
    }
  } finally {
    for (const control of controls) control.release();
    const unexpected = ledger.filter(e => e.unknown || (e.blocked && !e.expectedOfflineFontBlock) || e.invalidIdentity);
    const passed = cases.every(c => c.passed) && !errors.length && !unexpected.length;
    const result = { passed, proof: 'offline emitted-production-HTML browser/payload only; not persistence',
      emittedHtml: emitted, replayedHtml: retained || null,
      emittedSha256: createHash('sha256').update(html).digest('hex'),
      verifierSha256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
      cases, observations, ledger, errors, dialogs, unexpected,
      failure: cases.find(c => !c.passed)?.failure || (errors.length || unexpected.length ? 'Unexpected browser error or blocked request' : null) };
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
    await browser.close();
    console.log(`${passed ? 'PASS' : 'RED'} ${cases.filter(c => c.passed).length}/${cases.length} cases; ${OUT}`);
    if (!passed) process.exitCode = 1;
  }
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
