#!/usr/bin/env node
'use strict';

// Real production /staff/ui HTML, real browser and click handlers; only HTTP data
// is fixture-backed. No remote access, booking writes, conversation creation or sends.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tmp', 'staff-open-customer-deeplink');
const CONV = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const PHONE = '+34999000111';
const NAME = 'Deeplink Fixture Guest';
const message = 'DEEPLINK TARGET THREAD';
fs.mkdirSync(OUT, { recursive: true });

function fixtures(client, url, scenario) {
  const phone = scenario === 'no-conversation' ? '+34999000555' : PHONE;
  const customer = scenario === 'no-conversation' ? '55555555-5555-4555-8555-555555555555' : CUSTOMER;
  const name = scenario === 'no-conversation' ? 'Unlinked Fixture Guest' : NAME;
  const profile = loadClientPortalProfile(client);
  const conversation = { conversation_id: CONV, phone: PHONE, guest_name: NAME, channel: 'whatsapp', conversation_status: 'active', last_message_preview: message, last_message_at: '2026-09-24T08:00:00Z' };
  const identity = { customer_id: customer, conversation_id: CONV, phone: phone, display_name: name, language: 'en' };
  if (scenario === 'no-conversation') identity.conversation_id = null;
  if (scenario === 'context-conflict') identity.customer_id = '44444444-4444-4444-8444-444444444444';
  const context = { success: true, phone: phone, identity, bookings: [], service_records: [], messages: [], notes: {}, conversation_summary: { conversation_id: scenario === 'no-conversation' ? null : CONV } };
  if (url.pathname === '/staff/auth/session') return { success: true, auth_required: true, role: 'admin', db_role: 'admin', active_client: client, clients: [{ slug: client, name: client }], client_profiles: { [client]: profile } };
  if (url.pathname === '/staff/inbox/views') return { success: true, groups: [{ id: 'inbox', label: 'INBOX' }, { id: 'people', label: 'PEOPLE' }], views: [{ id: 'all', label: 'All', group: 'inbox', count: 1 }, { id: 'all_people', label: 'All people', group: 'people', count: 1 }] };
  if (url.pathname === '/staff/inbox/list') {
    const guest = url.searchParams.get('view') === 'all_people';
    const target = { ...conversation, phone: phone, guest_name: name, customer_id: customer, display_name: name, key: 'customer:' + customer, source: 'customers' };
    const other = { ...conversation, conversation_id: '33333333-3333-4333-8333-333333333333', customer_id: '44444444-4444-4444-8444-444444444444', phone: '+346****0444', guest_name: 'Other Fixture Guest', display_name: 'Other Fixture Guest', key: '33333333-3333-4333-8333-333333333333', source: 'conversations' };
    if (scenario === 'id-conflict') other.phone = phone;
    if (scenario === 'no-conversation') target.conversation_id = null;
    // Target is NOT the first People result and is outside the current thread
    // page. Navigation must resolve identity rather than accidentally auto-open.
    return { success: true, rows: guest && scenario !== 'fuzzy-only' ? [other, target] : [other], has_more: !guest };
  }
  if (url.pathname === '/staff/conversations') return { success: true, conversations: [conversation] };
  if (url.pathname === '/staff/conversations/' + CONV + '/messages') return { success: true, messages: [{ message_id: 'fixture-message', direction: 'inbound', message_text: message, created_at: '2026-09-24T08:00:00Z' }] };
  if (url.pathname.endsWith('/context') && url.pathname.startsWith('/staff/customers/')) {
    return url.pathname === '/staff/customers/' + encodeURIComponent(phone) + '/context'
      ? context : { success: false, error: 'fixture_customer_not_found' };
  }
  if (url.pathname === '/staff/inbox/thread/' + CONV) return { success: true, conversation_id: CONV, detail: { success: true, conversation }, context: { success: true, context: { guest_name: NAME }, bookings: [] }, messages: { success: true, messages: [{ message_id: 'fixture-message', direction: 'inbound', message_text: message, created_at: '2026-09-24T08:00:00Z' }] }, draft: { success: false }, pause_state: { success: true, paused: false } };
  const booking = { booking_id: 'fixture-booking', booking_code: 'FIXTURE-BOOKING', phone: phone, guest_phone: phone, guest_name: name, check_in: '2026-09-24', check_out: '2026-09-25', booking_status: 'confirmed', payment_status: 'unpaid' };
  if (url.pathname === '/staff/schedule/bookings/detail') return { success: true, ...booking, editable: false, items: [] };
  if (url.pathname === '/staff/bookings/FIXTURE-BOOKING/context') return { success: true, booking, conversation: scenario === 'no-conversation' ? null : conversation, assignments: [], payments: [], services: [], guest: { name: name, phone: phone } };
  if (url.pathname === '/staff/admin/bookings') return { success: true, rows: [{ booking_id: 'fixture-booking', booking_code: 'FIXTURE-BOOKING', guest_name: name, phone: phone, customer_id: scenario === 'fuzzy-only' ? null : customer, booking_status: 'confirmed', booking_payment_status: 'unpaid', total_cents: 10000 }], summary: { total: 1 }, total: 1 };
  return { success: true, rows: [], bookings: [], conversations: [] };
}

async function run(client, browser) {
  const dest = path.join(OUT, client + '.html');
  const build = spawnSync(process.execPath, ['scripts/verify-inbox-ui-parity.js', '--emit', client, dest], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const html = fs.readFileSync(dest, 'utf8');
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  const errors = [], requests = [], writes = [];
  let scenario = 'normal';
  let contextGate = null;
  const reviewFailures = [];
  function reviewCheck(label, check) {
    try { check(); console.log('PASS ' + client + ': ' + label); }
    catch (error) { reviewFailures.push(label + ': ' + error.message); console.error('FAIL ' + client + ': ' + label + ': ' + error.message); }
  }
  page.on('pageerror', e => errors.push(e.message));
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // Never allow this regression harness to contact a live service.
    if (url.origin !== 'http://staff.test') return route.abort();
    requests.push(url.pathname + url.search);
    if (request.method() !== 'GET') { writes.push(request.method() + ' ' + url.pathname); return route.fulfill({ status: 405, body: '{}' }); }
    if (url.pathname === '/staff/ui') return route.fulfill({ contentType: 'text/html', body: html });
    if (contextGate && url.pathname === '/staff/customers/' + encodeURIComponent(PHONE) + '/context') {
      const gate = contextGate;
      await gate.released;
      if (scenario === 'context-network-error') return route.abort('failed');
      if (scenario === 'context-http-error') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'offline fixture failure' }) });
      if (scenario === 'context-unsuccessful') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: false }) });
    }
    // A slow People list exposes the real preset/request generation race.
    if (url.pathname === '/staff/inbox/list' && url.searchParams.get('view') === 'all_people') {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixtures(client, url, scenario)) });
  });
  await page.addInitScript(() => localStorage.setItem('wh_staff_portal_locale', 'en'));
  try {
    const fixture = endpoint => fixtures(client, new URL(endpoint, 'http://staff.test'), 'no-conversation');
    const unlinked = fixture('/staff/inbox/list?view=all_people').rows.find(row => row.source === 'customers');
    reviewCheck('unlinked fixture keeps existing conversation and thread owned by A', () => {
      const conversation = fixture('/staff/conversations').conversations[0];
      assert.equal(conversation.conversation_id, CONV);
      assert.equal(conversation.phone, PHONE);
      assert.equal(conversation.guest_name, NAME);
      const thread = fixture('/staff/inbox/thread/' + CONV);
      assert.deepEqual(thread.detail.conversation, conversation);
      assert.equal(thread.context.context.guest_name, NAME);
    });
    reviewCheck('unlinked People B and phone context B have no conversation', () => {
      assert.notEqual(unlinked.phone, PHONE);
      assert.notEqual(unlinked.display_name, NAME);
      assert.equal(unlinked.guest_name, unlinked.display_name);
      assert.equal(unlinked.conversation_id, null);
      const data = fixture('/staff/customers/' + encodeURIComponent(unlinked.phone) + '/context');
      assert.equal(data.phone, unlinked.phone);
      assert.equal(data.identity.customer_id, unlinked.customer_id);
      assert.equal(data.identity.conversation_id, null);
      assert.equal(data.conversation_summary.conversation_id, null);
    });
    reviewCheck('unlinked booking B has no conversation', () => {
      const data = fixture('/staff/bookings/FIXTURE-BOOKING/context');
      assert.equal(data.booking.phone, unlinked.phone);
      assert.equal(data.guest.phone, unlinked.phone);
      assert.equal(data.conversation, null);
    });
    reviewCheck('customer context is scoped to the requested fixture phone', () => {
      for (const phone of [PHONE, '+34000000000']) {
        const data = fixture('/staff/customers/' + encodeURIComponent(phone) + '/context');
        assert.equal(data.success, false, 'non-target phone must not receive B context');
        assert.equal(data.identity, undefined);
      }
    });
    const actionable = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [role="button"], [contenteditable="true"]';
    for (const outcome of ['context-conflict', 'context-http-error', 'context-unsuccessful', 'context-network-error']) {
      scenario = outcome;
      let release;
      contextGate = { released: new Promise(resolve => { release = resolve; }) };
      await page.goto('http://staff.test/staff/ui');
      await page.waitForFunction(() => !document.body.classList.contains('portal-profile-pending'));
      await page.locator('.tab-btn[data-tab="bookings"]').click();
      const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/staff/customers/' + encodeURIComponent(PHONE) + '/context');
      await page.locator('[data-bookings-guest-phone]').first().click();
      const request = await requested;
      try {
        await page.waitForFunction(name => document.querySelector('#detail-content .detail-name')?.textContent === name, NAME);
        const controls = await page.locator('#inbox-detail-sidebar').locator(actionable).count();
        reviewCheck(outcome + ': pending context exposes no identity-dependent controls', () => assert.equal(controls, 0));
      } finally { release(); }
      // Wait for delivery (or the deliberately rejected network request), then
      // let the production fetch/json/catch handlers render their terminal state.
      const response = await request.response();
      if (response) await response.finished();
      await page.waitForFunction(() => {
        const sidebar = document.querySelector('#inbox-detail-sidebar');
        return sidebar?.querySelector('.state-msg.error, #cust-conversation-btn');
      });
      const controls = await page.locator('#inbox-detail-sidebar').locator(actionable).count();
      reviewCheck(outcome + ': failed/mismatched context exposes no identity-dependent controls', () => assert.equal(controls, 0));
      reviewCheck(outcome + ': navigation dispatches no writes', () => assert.deepEqual(writes, []));
      contextGate = null;
    }
    assert.deepEqual(reviewFailures, [], 'review regressions must pass');
    scenario = 'normal';
    await page.goto('http://staff.test/staff/ui');
    await page.waitForFunction(() => !document.body.classList.contains('portal-profile-pending'));
    await page.locator('.tab-btn[data-tab="bookings"]').click();
    await page.locator('[data-bookings-guest-phone]').first().click();
    await page.waitForFunction(name => document.querySelector('#detail-content')?.textContent.includes(name) && document.querySelector('#cust-conversation-btn')?.textContent === 'Open conversation', NAME);
    console.log('PASS ' + client + ': Bookings guest link opens exact customer card');
    // Let the existing Guest transition finish before testing the distinct
    // Guest → Full navigation (the production folder stall limit is 500ms).
    await page.waitForTimeout(650);
    requests.length = 0;
    await page.locator('#cust-conversation-btn').click();
    try {
      await page.waitForFunction(text => document.querySelector('#detail-content .thread-messages')?.textContent.includes(text), message, { timeout: 4000 });
    } catch (error) {
      throw new Error(client + ': Open conversation lost target. Detail=' + await page.locator('#detail-content').innerText() + '; requests=' + JSON.stringify(requests));
    }
    assert(requests.some(u => u.startsWith('/staff/inbox/thread/' + CONV)), 'exact thread endpoint requested');
    assert.deepEqual(writes, [], 'navigation never creates or sends');
    assert.deepEqual(errors, [], 'no browser JS errors');
    console.log('PASS ' + client + ': Guest card Open conversation opens exact thread');
    // The URL bootstrap must also override a persisted Guest preset.
    await page.evaluate(() => window.__inboxColumns.setPreset('guest'));
    await page.waitForTimeout(650);
    await page.goto('http://staff.test/staff/ui?client=' + client + '&conversation=' + CONV);
    await page.waitForFunction(text => document.querySelector('#detail-content .thread-messages')?.textContent.includes(text), message, { timeout: 5000 });
    console.log('PASS ' + client + ': URL conversation survives saved Guest preset');
    // A folder click queued just before explicit navigation must not run later
    // and revert the destination. Both calls use the production preset wrapper.
    await page.evaluate(() => {
      window.__inboxColumns.setPreset('guest');
      window.__inboxColumns.setPreset('all4', { immediate: true });
    });
    await page.waitForTimeout(650);
    assert.equal(await page.locator('[data-inbox-preset="all4"]').first().getAttribute('aria-pressed'), 'true', 'pending folder transition cannot overwrite explicit navigation');
    console.log('PASS ' + client + ': latest navigation wins over pending folder transition');
    // Exercise actual link handlers in both rapid transition directions and
    // assert the destination identity, not only the preset button state.
    await page.locator('.tab-btn[data-tab="bookings"]').click();
    await page.locator('[data-bookings-guest-phone]').first().waitFor();
    await page.evaluate(() => {
      window.__inboxColumns.setPreset('guest');
      document.querySelector('[data-bookings-guest-phone]').click();
    });
    await page.waitForFunction(name => document.querySelector('#detail-content .detail-name')?.textContent === name && document.querySelector('#cust-conversation-btn')?.textContent === 'Open conversation', NAME);
    await page.waitForTimeout(650);
    assert.equal(await page.locator('#detail-content .detail-name').innerText(), NAME, 'rapid Guest navigation retains requested identity');
    await page.evaluate(() => {
      const open = document.querySelector('#cust-conversation-btn');
      window.__inboxColumns.setPreset('all4');
      open.click();
    });
    await page.waitForFunction(text => document.querySelector('#detail-content .thread-messages')?.textContent.includes(text), message);
    await page.waitForTimeout(650);
    assert((await page.locator('#detail-content .thread-messages').innerText()).includes(message), 'rapid Full navigation retains requested thread');
    console.log('PASS ' + client + ': rapid navigation in both directions retains exact guest/thread');
    await page.locator('.tab-btn[data-tab="bookings"]').click();
    await page.locator('[data-bookings-open-schedule]').first().click();
    if (client === 'sunset') {
      await page.locator('#ps-drawer-open-customer').click();
      await page.waitForFunction(name => document.querySelector('#detail-content')?.textContent.includes(name) && document.querySelector('#cust-conversation-btn')?.textContent === 'Open conversation', NAME);
      console.log('PASS sunset: Bookings detail/shared Schedule drawer opens exact guest card');
    } else {
      // Wolfhouse's current shared drawer exposes Open conversation in its
      // footer (the older Open customer toolbar is not mounted here).
      await page.locator('#bc-open-conv-btn').click();
      await page.waitForFunction(text => document.querySelector('#detail-content .thread-messages')?.textContent.includes(text), message);
      console.log('PASS wolfhouse-somo: Bookings detail/shared Schedule drawer opens exact thread');
    }
    scenario = 'id-conflict';
    await page.locator('.tab-btn[data-tab="bookings"]').click();
    await page.locator('[data-bookings-guest-phone]').first().click();
    await page.waitForTimeout(750);
    assert.equal(await page.locator('#detail-content .detail-name').innerText(), NAME, 'explicit customer ID beats an earlier phone match');
    console.log('PASS ' + client + ': explicit customer ID wins over conflicting phone match');
    scenario = 'context-conflict';
    await page.locator('.tab-btn[data-tab="bookings"]').click();
    await page.locator('[data-bookings-guest-phone]').first().click();
    await page.waitForTimeout(750);
    assert.equal(await page.locator('#cust-conversation-btn').count(), 0, 'phone context cannot replace requested customer with a conflicting ID');
    console.log('PASS ' + client + ': conflicting phone context fails closed');
    scenario = 'fuzzy-only';
    await page.goto('http://staff.test/staff/ui');
    await page.waitForFunction(() => !document.body.classList.contains('portal-profile-pending'));
    await page.locator('.tab-btn[data-tab="bookings"]').click();
    await page.locator('[data-bookings-guest-phone]').first().click();
    await page.waitForTimeout(750);
    const fuzzyDetail = await page.locator('#inbox-state').innerText();
    assert.equal(await page.locator('#conv-list .conv-card.selected').count(), 0, 'no fuzzy result selected');
    assert.equal(await page.locator('#cust-conversation-btn').count(), 0, 'no fuzzy guest actions painted');
    assert.match(fuzzyDetail, /Guest not found in People/, 'single fuzzy hit must not select another person: ' + fuzzyDetail);
    console.log('PASS ' + client + ': singleton fuzzy hit fails closed');
    assert.deepEqual(writes, [], 'all navigation is read-only');
    scenario = 'normal';
    await page.goto('http://staff.test/staff/ui?client=' + client + '&conversation=' + CONV);
    await page.waitForFunction(text => document.querySelector('#detail-content .thread-messages')?.textContent.includes(text), message);
    await page.waitForTimeout(500);
    scenario = 'no-conversation';
    await page.locator('.tab-btn[data-tab="bookings"]').click();
    await page.locator('[data-bookings-guest-phone]').first().click();
    await page.waitForFunction(() => document.querySelector('#cust-conversation-btn')?.textContent === 'Start conversation');
    await page.waitForTimeout(500);
    requests.length = 0;
    // This action is confined to the offline interceptor: reject its POST and
    // verify it targets this guest, not the previously selected thread.
    await page.locator('#cust-conversation-btn').click();
    await page.waitForTimeout(500);
    assert(!requests.some(u => u.startsWith('/staff/inbox/thread/')), 'unlinked guest must not reopen the previous thread');
    assert.equal(writes.length, 1, 'unlinked guest attempts only its own start action, blocked offline');
    assert.equal(writes[0], 'POST /staff/customers/%2B34999000555/create-conversation');
    console.log('PASS ' + client + ': unlinked guest never inherits previous conversation');
    assert.deepEqual(errors, [], 'all entrypoints have no browser JS errors');
  } finally {
    fs.writeFileSync(path.join(OUT, client + '-requests.json'), JSON.stringify({ requests, errors, writes }, null, 2));
    await page.screenshot({ path: path.join(OUT, client + '.png') });
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  let failures = 0;
  try {
    for (const client of ['sunset', 'wolfhouse-somo']) {
      try { await run(client, browser); } catch (error) { failures++; console.error('FAIL', error.message); }
    }
  } finally { await browser.close(); }
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
