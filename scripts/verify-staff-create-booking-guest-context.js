#!/usr/bin/env node
'use strict';

// Production portal HTML and actual click handlers. Synthetic HTTP fixtures only;
// every request is intercepted, and no booking submission or send is exercised.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.GUEST_CONTEXT_TEST_OUT || path.join(ROOT, 'tmp', 'staff-create-booking-guest-context');
const CONV = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const NAME = 'Fixture Guest <Context>';
const PHONE = '+34900000111';
const EMAIL = 'guest-context@example.invalid';
fs.mkdirSync(OUT, { recursive: true });

const SECOND_CONV = '33333333-3333-4333-8333-333333333333';
const SECOND_CUSTOMER = '44444444-4444-4444-8444-444444444444';
const SECOND_PHONE = '+34' + '900000444';
const SECOND_NAME = 'Second Fixture Guest';

function fixture(client, url, scenario) {
  const first = { conversation_id: CONV, customer_id: CUSTOMER, phone: PHONE,
    guest_name: '', channel: 'whatsapp', conversation_status: 'active',
    last_message_preview: 'Guest context fixture', last_message_at: '2026-09-24T08:00:00Z' };
  if (scenario === 'email') Object.assign(first, { channel: 'email', phone: 'email:fixture@example.invalid', customer_phone: PHONE, guest_email: EMAIL });
  if (scenario === 'no-context') first.guest_name = 'Thread-only Fixture Guest';
  const second = { ...first, conversation_id: SECOND_CONV, customer_id: SECOND_CUSTOMER,
    channel: 'whatsapp', phone: SECOND_PHONE, customer_phone: SECOND_PHONE,
    guest_name: SECOND_NAME, guest_email: '', email: '' };
  const isSecond = url.pathname.includes(SECOND_CONV) || url.pathname.includes(encodeURIComponent(SECOND_PHONE));
  const conversation = isSecond ? second : first;
  const customer = { success: true, phone: isSecond ? SECOND_PHONE : PHONE,
    identity: { customer_id: isSecond ? SECOND_CUSTOMER : CUSTOMER,
      display_name: isSecond ? SECOND_NAME : NAME, email: isSecond ? '' : EMAIL, language: 'en' },
    bookings: [], service_records: [], messages: [], notes: {} };
  if (url.pathname === '/staff/auth/session') return { success: true, auth_required: true, role: 'admin', db_role: 'admin', active_client: client, clients: [{ slug: client, name: client }], client_profiles: { [client]: loadClientPortalProfile(client) } };
  if (url.pathname === '/staff/inbox/views') return { success: true, groups: [{ id: 'inbox', label: 'INBOX' }, { id: 'people', label: 'PEOPLE' }], views: [{ id: 'all', label: 'All', group: 'inbox', count: 1 }, { id: 'all_people', label: 'All people', group: 'people', count: 1 }] };
  if (url.pathname === '/staff/inbox/list') return { success: true, rows: [first, second], has_more: false };
  if (url.pathname === '/staff/conversations') return { success: true, conversations: [first, second] };
  if (url.pathname === '/staff/inbox/thread/' + conversation.conversation_id) return { success: true, conversation_id: conversation.conversation_id, detail: { success: true, conversation }, context: { success: true, context: {}, bookings: [] }, messages: { success: true, messages: [{ message_id: 'fixture-message', direction: 'inbound', message_text: 'Guest context fixture', created_at: '2026-09-24T08:00:00Z' }] }, draft: { success: false }, pause_state: { success: true, paused: false } };
  if (url.pathname === '/staff/customers/' + encodeURIComponent(customer.phone) + '/context') {
    return scenario === 'no-context' ? { success: false } : customer;
  }
  return { success: true, rows: [], bookings: [], conversations: [], rooms: [], beds: [], courses: [] };
}

// Exercise the unmodified production module with real browser DOM/renderers.
// The portal keeps these helpers closure-private, so use an isolated source
// harness; only the booking-open boundary is captured, and nothing submits.
async function runRepairRegressions(portalPage, client) {
  const page = await portalPage.context().newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addScriptTag({ path: path.join(ROOT, 'scripts/browser/inbox-context.js') });
  await page.evaluate(() => {
    window.customersCache = [];
    window.openCreateBookingFromContact = () => {};
  });
  let cases;
  try {
    cases = await page.evaluate(({ phone, email }) => {
      const results = [];
      let captured;
      openCreateBookingFromContact = contact => { captured = contact; };
      function card(data, conv, full) {
        const root = document.createElement('div');
        root.innerHTML = full ? inboxCustomerFullHtml(data, { conv }) : inboxCustomerCondensedHtml(data, { conv });
        inboxContextWireActions(root, { conversation: conv, customer: data });
        return root;
      }
      for (const notes of [{}, null, { internal_staff_notes: '' }, { internal_staff_notes: 'Customer-only note' }]) {
        customersCache = [];
        const conv = { internal_staff_notes: 'Conversation note retained' };
        const root = card({ phone, identity: { display_name: 'Notes Guest' }, notes }, conv, false);
        captured = null;
        root.querySelector('#inbox-create-booking-for-guest').click();
        results.push({ label: 'conversation notes with customer.notes=' + JSON.stringify(notes),
          actual: captured && captured.internal_staff_notes, expected: conv.internal_staff_notes });
      }
      for (const full of [false, true]) {
        for (const identityWins of [false, true]) {
          const cache = { phone, display_name: 'Cache Guest', email, language: 'es' };
          customersCache = [{ phone: '+34900000999', email: 'other@example.invalid', language: 'de' }, cache];
          const data = { phone, identity: identityWins
            ? { display_name: 'Identity Guest', email: 'identity@example.invalid', language: 'en' }
            : {}, bookings: [], service_records: [] };
          const expected = { display_name: identityWins ? 'Identity Guest' : 'Cache Guest', phone,
            email: identityWins ? 'identity@example.invalid' : email, language: identityWins ? 'en' : 'es' };
          const root = card(data, {}, full);
          const displayed = {
            display_name: root.querySelector(full ? '.customers-profile-name' : '.inbox-client-info-name').textContent,
            email: root.querySelector('[data-inbox-inline="email"] .inbox-guest-inline-display').textContent,
          };
          if (full) displayed.language = root.querySelector('[data-inbox-inline="language"] .inbox-guest-inline-display').textContent;
          results.push({ label: (full ? 'full' : 'condensed') + ' card render precedence (identity=' + identityWins + ')',
            actual: displayed, expected: { display_name: expected.display_name, email: expected.email,
              ...(full ? { language: expected.language } : {}) } });
          // Change cache, the model itself, and current selection AFTER wiring.
          // The old card must retain its displayed contact snapshot on click.
          Object.assign(cache, { display_name: 'Changed Cache', email: 'changed@example.invalid', language: 'fr' });
          customersCache = [{ phone, email: 'replacement@example.invalid', language: 'it' }];
          data.phone = '+34900000888';
          Object.assign(data.identity, { display_name: 'Changed Identity', email: 'changed-identity@example.invalid', language: 'pt' });
          inboxContextLastCustomer = { phone: '+34900000777', identity: { display_name: 'Other selection', email: 'selection@example.invalid' } };
          inboxContextLastConv = { guest_name: 'Other thread', phone: '+34900000777' };
          captured = null;
          root.querySelector('#inbox-create-booking-for-guest').click();
          results.push({ label: (full ? 'full' : 'condensed') + ' card click retains rendered contact (identity=' + identityWins + ')',
            actual: captured && { display_name: captured.display_name, phone: captured.phone, email: captured.email, language: captured.language }, expected });
        }
      }
      return results;
    }, { phone: PHONE, email: EMAIL });
  } finally { await page.close(); }
  assert.deepEqual(errors, [], 'source harness remains JS-error-free');
  const failures = [];
  for (const test of cases) {
    try {
      assert.deepEqual(test.actual, test.expected, client + ': ' + test.label);
      console.log('PASS ' + client + ': ' + test.label);
    } catch (error) {
      failures.push(error);
      console.error(error.stack);
    }
  }
  fs.writeFileSync(path.join(OUT, client + '-repair-regressions.json'), JSON.stringify(cases, null, 2));
  return failures;
}

async function run(client, browser) {
  const dest = path.join(OUT, client + '.html');
  const build = spawnSync(process.execPath, ['scripts/verify-inbox-ui-parity.js', '--emit', client, dest], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const html = fs.readFileSync(dest, 'utf8');
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [], requests = [], writes = [];
  let scenario = 'whatsapp';
  page.on('pageerror', e => errors.push(e.message));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://staff.test') return route.abort();
    requests.push(request.method() + ' ' + url.pathname + url.search);
    // Existing catalog lookup is read-only despite using POST. All other
    // non-GET traffic remains a failing, blocked mutation attempt.
    if (request.method() !== 'GET' && !(request.method() === 'POST' && url.pathname === '/staff/schedule/bookings/catalog')) {
      writes.push(request.method() + ' ' + url.pathname);
      return route.fulfill({ status: 405, body: '{}' });
    }
    if (url.pathname === '/staff/ui') return route.fulfill({ contentType: 'text/html', body: html });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixture(client, url, scenario)) });
  });
  await page.addInitScript(() => localStorage.setItem('wh_staff_portal_locale', 'en'));
  try {
    await page.goto('http://staff.test/staff/ui?client=' + client + '&conversation=' + CONV);
    await page.waitForFunction(name => document.querySelector('#inbox-detail-sidebar')?.textContent.includes(name), NAME);
    await page.locator('#inbox-detail-sidebar #inbox-create-booking-for-guest').click();
    const nameInput = page.locator(client === 'sunset' ? '#ps-create-guest' : '#bk-guest-name-1');
    const phoneInput = page.locator(client === 'sunset' ? '#ps-create-phone' : '#bk-phone');
    await nameInput.waitFor({ state: 'visible' });
    assert.equal(await nameInput.inputValue(), NAME, client + ': displayed customer name prefills booking');
    assert.equal(await phoneInput.inputValue(), PHONE, client + ': displayed phone prefills booking');
    if (client !== 'sunset') assert.equal(await page.locator('#bk-email').inputValue(), EMAIL, 'displayed email prefills booking');
    assert.deepEqual(writes, [], 'prefill never creates, quotes, pays or sends');
    assert.deepEqual(errors, [], 'no browser errors');
    console.log('PASS ' + client + ': Inbox thread Create booking prefills displayed guest identity');
    await page.screenshot({ path: path.join(OUT, client + '-prefill.png'), fullPage: false });
    await page.goto('http://staff.test/staff/ui?client=' + client + '&conversation=' + CONV);
    await page.waitForFunction(name => document.querySelector('#inbox-detail-sidebar')?.textContent.includes(name), NAME);
    // The legacy URL bootstrap is delayed; let it settle before keyboard navigation.
    await page.waitForTimeout(650);
    await page.keyboard.press('Alt+3');
    // Let the existing animated folder switch finish before
    // selecting the thread through its real list-row handler.
    await page.waitForTimeout(650);
    await page.locator('.conv-card[data-id="' + CONV + '"]').first().click();
    await page.waitForFunction(name => document.querySelector('#inbox-detail-sidebar')?.textContent.includes(name), NAME);
    await page.locator('#inbox-chat-guest-name').click();
    await page.locator('#inbox-chat-guest-host #inbox-create-booking-for-guest').click();
    await nameInput.waitFor({ state: 'visible' });
    assert.equal(await nameInput.inputValue(), NAME, client + ': Chat guest card uses displayed name');
    assert.equal(await phoneInput.inputValue(), PHONE, client + ': Chat guest card uses displayed phone');
    if (client !== 'sunset') assert.equal(await page.locator('#bk-email').inputValue(), EMAIL);
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
    console.log('PASS ' + client + ': Chat guest card Create booking prefills displayed identity');

    for (const variant of ['email', 'no-context']) {
      scenario = variant;
      const expectedName = variant === 'email' ? NAME : 'Thread-only Fixture Guest';
      await page.goto('http://staff.test/staff/ui?client=' + client + '&conversation=' + CONV);
      await page.waitForFunction(name => document.querySelector('#inbox-detail-sidebar')?.textContent.includes(name), expectedName);
      await page.waitForTimeout(650);
      await page.locator('#inbox-detail-sidebar #inbox-create-booking-for-guest').click();
      await nameInput.waitFor({ state: 'visible' });
      assert.equal(await nameInput.inputValue(), expectedName, variant + ': name');
      assert.equal(await phoneInput.inputValue(), PHONE, variant + ': real contact phone, never opaque email key');
      if (client !== 'sunset') assert.equal(await page.locator('#bk-email').inputValue(), variant === 'email' ? EMAIL : '', variant + ': email');
      console.log('PASS ' + client + ': ' + variant + ' contact prefill');
    }

    scenario = 'whatsapp';
    await page.goto('http://staff.test/staff/ui?client=' + client + '&conversation=' + CONV);
    await page.waitForFunction(name => document.querySelector('#inbox-detail-sidebar')?.textContent.includes(name), NAME);
    await page.waitForTimeout(650);
    await page.locator('.conv-card[data-id="' + SECOND_CONV + '"]').first().click();
    await page.waitForFunction(name => document.querySelector('#inbox-detail-sidebar')?.textContent.includes(name), SECOND_NAME);
    await page.locator('#inbox-detail-sidebar #inbox-create-booking-for-guest').click();
    await nameInput.waitFor({ state: 'visible' });
    assert.equal(await nameInput.inputValue(), SECOND_NAME, 'newly selected guest owns prefill');
    assert.equal(await phoneInput.inputValue(), SECOND_PHONE, 'newly selected phone owns prefill');
    if (client !== 'sunset') assert.equal(await page.locator('#bk-email').inputValue(), '', 'missing email never borrows previous guest');
    assert.deepEqual(writes, [], 'all cases remain no-write');
    assert.deepEqual(errors, [], 'all cases remain JS-error-free');
    console.log('PASS ' + client + ': A-to-B thread switch keeps identity isolated and missing contact blank');
    const repairFailures = await runRepairRegressions(page, client);
    assert.deepEqual(writes, [], 'repair regressions remain no-write');
    assert.deepEqual(errors, [], 'repair regressions remain JS-error-free');
    assert.equal(repairFailures.length, 0, client + ': bounded repair regressions must pass');
  } finally {
    await page.screenshot({ path: path.join(OUT, client + '-last-state.png'), fullPage: false });
    fs.writeFileSync(path.join(OUT, client + '-last-state.txt'), await page.locator('body').innerText());
    fs.writeFileSync(path.join(OUT, client + '-requests.json'), JSON.stringify({ requests, writes, errors }, null, 2));
    await context.close();
  }
}
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const failures = [];
  try {
    for (const client of ['sunset', 'wolfhouse-somo']) {
      try { await run(client, browser); } catch (error) { failures.push(error); console.error(error.stack); }
    }
  } finally { await browser.close(); }
  assert.equal(failures.length, 0, 'both tenant browser regressions must pass');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
