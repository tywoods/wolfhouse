#!/usr/bin/env node
'use strict';

// Production portal HTML and ordinary list-row handlers; synthetic, intercepted
// HTTP only. No server, live API, sends, booking actions or other mutations.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
const ROOT = path.resolve(__dirname, '..');
const phase = process.argv[2] || 'latest';
assert.match(phase, /^[a-z0-9-]+$/, 'optional evidence label must be a simple filename');
const OUT = path.join(ROOT, 'tmp/phone-inbox-open-at-newest/evidence-owner', phase);
fs.mkdirSync(OUT, { recursive: true });
const ORIGIN = 'http://staff.test';
const conversations = ['A', 'B'].map((letter, i) => ({
  conversation_id: `${i + 1}1111111-1111-4111-8111-111111111111`,
  phone: `+3499900010${i}`, guest_name: `Synthetic Thread ${letter}`,
  channel: 'whatsapp', conversation_status: 'active',
  last_message_preview: `Thread ${letter} newest`, last_message_at: '2026-09-24T08:59:00Z',
}));
function messages(conv, extra = 0) {
  return Array.from({ length: 60 + extra }, (_, i) => ({
    message_id: `${conv.conversation_id}-${i}`, direction: i % 2 ? 'outbound' : 'inbound',
    source: i % 2 ? 'staff_inbox_reply' : 'whatsapp',
    message_text: `${conv.guest_name} message ${i + 1}: Synthetic transcript text for ordinary Inbox scrolling.`,
    created_at: new Date(Date.UTC(2026, 8, 24, 8, i)).toISOString(),
  }));
}
function fixture(client, url, extras) {
  const p = url.pathname;
  if (p === '/staff/auth/session') return { success: true, auth_required: true, role: 'admin', db_role: 'admin', active_client: client, clients: [{ slug: client, name: client }], client_profiles: { [client]: loadClientPortalProfile(client) } };
  if (p === '/staff/inbox/views') return { success: true, groups: [{ id: 'inbox', label: 'INBOX' }], views: [{ id: 'all', label: 'All', group: 'inbox', count: 2 }] };
  if (p === '/staff/inbox/list') return { success: true, rows: conversations.map(c => ({ ...c, key: c.conversation_id, source: 'conversations' })), has_more: false };
  if (p === '/staff/conversations') return { success: true, conversations };
  for (const c of conversations) {
    const msgs = { success: true, messages: messages(c, extras[c.conversation_id] || 0) };
    if (p === '/staff/inbox/thread/' + c.conversation_id) return { success: true, conversation_id: c.conversation_id, detail: { success: true, conversation: c }, context: { success: true, context: { guest_name: c.guest_name }, bookings: [] }, messages: msgs, draft: { success: false }, pause_state: { success: true, paused: false } };
    if (p === '/staff/conversations/' + c.conversation_id + '/messages') return msgs;
  }
  return { success: true, rows: [], bookings: [], conversations: [] };
}
async function settle(page) {
  // Beyond the portal's folder/chrome scheduling and the helper's two RAFs.
  await page.waitForTimeout(750);
}
async function measure(page) {
  return page.evaluate(() => {
    const thread = document.getElementById('thread-container');
    function dimensions(el) {
      const r = el.getBoundingClientRect();
      return { tagName: el.tagName, id: el.id, className: el.className, scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight, scrollTop: el.scrollTop,
        remaining: el.scrollHeight - el.clientHeight - el.scrollTop,
        overflowY: getComputedStyle(el).overflowY, top: r.top, bottom: r.bottom };
    }
    const ancestors = [];
    let owner = null;
    for (let el = thread; el; el = el.parentElement) {
      ancestors.push(dimensions(el));
      if (!owner && /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1) owner = el;
    }
    owner = owner || document.scrollingElement;
    owner.setAttribute('data-newest-test-scroll-owner', 'true');
    const newest = Array.from(thread.querySelectorAll('.msg')).pop();
    const oldest = thread.querySelector('.msg');
    function visible(el) {
      if (!el || !el.getClientRects().length) return false;
      const rect = el.getBoundingClientRect();
      let top = 0, bottom = innerHeight;
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (getComputedStyle(p).display !== 'contents' && /(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowY)) {
          const r = p.getBoundingClientRect(); top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom);
        }
      }
      return rect.top >= top - 2 && rect.bottom <= bottom + 2;
    }
    return { viewport: { width: innerWidth, height: innerHeight }, owner: dimensions(owner), thread: dimensions(thread), ancestors,
      newestText: newest?.textContent, newestVisible: visible(newest), oldestVisible: visible(oldest),
      count: thread.querySelectorAll('.msg').length };
  });
}
async function run(browser, client, size, html) {
  const name = `${client}-${size.width}`;
  const context = await browser.newContext({ viewport: size, serviceWorkers: 'block', isMobile: size.width < 769, hasTouch: size.width < 769 });
  const page = await context.newPage();
  const evidence = { client, viewport: size, requests: [], writes: [], external: [], errors: [], measurements: [], failures: [] };
  const extras = {};
  page.on('pageerror', error => evidence.errors.push(error.message));
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    evidence.requests.push({ method: req.method(), path: url.pathname + url.search });
    if (req.method() !== 'GET') {
      evidence.writes.push(req.method() + ' ' + url.pathname);
      return route.fulfill({ status: 405, contentType: 'application/json', body: '{}' });
    }
    if (url.origin !== ORIGIN) { evidence.external.push(url.origin + url.pathname); return route.abort(); }
    if (url.pathname === '/staff/ui') return route.fulfill({ contentType: 'text/html', body: html });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixture(client, url, extras)) });
  });
  await page.addInitScript(() => localStorage.setItem('wh_staff_portal_locale', 'en'));
  function check(label, fn) {
    try { fn(); console.log(`PASS ${name}: ${label}`); }
    catch (error) { evidence.failures.push(label + ': ' + error.message); console.error(`FAIL ${name}: ${label}: ${error.message}`); }
  }
  async function snapshot(label, newestExpected) {
    const m = await measure(page);
    evidence.measurements.push({ label, ...m });
    console.log(`MEASURE ${name} ${label}: ${JSON.stringify({ owner: m.owner, newestVisible: m.newestVisible, oldestVisible: m.oldestVisible })}`);
    check(label + ' is a long overflowing transcript', () => {
      assert(m.owner.clientHeight > 0); assert(m.owner.scrollHeight > size.height); assert(m.owner.remaining + m.owner.scrollTop > 500);
    });
    if (newestExpected) check(label + ' opens at newest', () => {
      assert(m.owner.remaining <= 2, `remaining=${m.owner.remaining}, scrollTop=${m.owner.scrollTop}`);
      assert(m.newestVisible, 'newest message must be visible inside transcript and viewport');
      assert(!m.oldestVisible, 'oldest must not be visible');
    });
    await page.screenshot({ path: path.join(OUT, name + '-' + label + '.png') });
    return m;
  }
  async function open(index) {
    await page.locator('#conv-list .conv-card').filter({ hasText: conversations[index].guest_name }).click();
    await page.waitForFunction(name => document.querySelector('#thread-container')?.textContent.includes(name), conversations[index].guest_name);
    await settle(page);
  }
  try {
    await page.goto(ORIGIN + '/staff/ui');
    await page.waitForFunction(() => !document.body.classList.contains('portal-profile-pending'));
    await page.evaluate(() => window.switchToTab('conversations'));
    await page.locator('#conv-list .conv-card').first().waitFor();
    await settle(page);
    await open(0);
    await snapshot('initial-A', true);
    if (size.width < 769) await page.locator('#inbox-mobile-back').click();
    await open(1);
    await snapshot('switch-B', true);
    // Exercise production polling while reading history. An unchanged refresh
    // must not rerun initial positioning on either viewport.
    await page.evaluate(() => { document.querySelector('[data-newest-test-scroll-owner]').scrollTop = 400; });
    const before = await snapshot('reading-older', false);
    await page.waitForResponse(r => new URL(r.url()).pathname === '/staff/conversations/' + conversations[1].conversation_id + '/messages');
    await settle(page);
    const unchanged = await snapshot('refresh-unchanged', false);
    check('unchanged refresh preserves reading position', () => assert(Math.abs(unchanged.owner.scrollTop - before.owner.scrollTop) <= 2));
    extras[conversations[1].conversation_id] = 1;
    // The intercepted non-SSE response activates the production polling fallback.
    // Let its timer refresh the transcript; no test-only runtime hooks.
    await page.waitForFunction(() => document.querySelectorAll('#thread-container .msg').length === 61);
    await settle(page);
    const after = await snapshot('refresh-older', false);
    if (size.width < 769) check('append refresh does not yank phone reader to newest', () => {
      assert(Math.abs(after.owner.scrollTop - before.owner.scrollTop) <= 2, `before=${before.owner.scrollTop}, after=${after.owner.scrollTop}`);
      assert(!after.newestVisible);
    });
    else console.log(`OBSERVATION ${name}: desktop append refresh before=${before.owner.scrollTop}, after=${after.owner.scrollTop}; baseline append-yank is outside this initial-open fix`);
    check('no browser JS errors', () => assert.deepEqual(evidence.errors, []));
    check('no mutation attempts', () => assert.deepEqual(evidence.writes, []));
  } catch (error) { evidence.failures.push(error.stack); console.error('FAIL ' + name + ': ' + error.stack); }
  finally {
    fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(evidence, null, 2) + '\n');
    await context.close();
  }
  return evidence.failures.length;
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  let failures = 0;
  try {
    for (const client of ['wolfhouse-somo', 'sunset']) {
      const dest = path.join(OUT, client + '.html');
      const build = spawnSync(process.execPath, ['scripts/verify-inbox-ui-parity.js', '--emit', client, dest], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(build.status, 0, build.stderr);
      const html = fs.readFileSync(dest, 'utf8');
      for (const size of [{ width: 390, height: 844 }, { width: 1500, height: 1000 }]) failures += await run(browser, client, size, html);
    }
  } finally { await browser.close(); }
  console.log(`verify-phone-inbox-open-at-newest-001: ${failures ? 'FAIL' : 'PASS'} (${failures} failures); evidence: ${path.relative(ROOT, OUT)}`);
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
