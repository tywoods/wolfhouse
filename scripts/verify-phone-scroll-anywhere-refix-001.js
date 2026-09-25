#!/usr/bin/env node
'use strict';

// Real emitted Staff UI, ordinary navigation, intercepted synthetic HTTP only.
// CDP touch gestures exercise native browser panning, not dispatched DOM events
// or assigned scrollTop. Mouse dragging is checked separately at phone widths.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
const ROOT = path.resolve(__dirname, '..');
const label = process.argv[2] || 'latest';
assert.match(label, /^[a-z0-9-]+$/);
const OUT = path.join(ROOT, 'tmp/phone-scroll-refix-evidence', label);
fs.mkdirSync(OUT, { recursive: true });
const ORIGIN = 'http://staff.test';
const rows = Array.from({ length: 45 }, (_, i) => ({
  conversation_id: `${String(i + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
  customer_id: `${String(i + 1).padStart(8, '0')}-2222-4222-8222-222222222222`,
  phone: `+3490000${String(i).padStart(4, '0')}`,
  guest_name: `Synthetic Guest ${String(i).padStart(2, '0')}`, display_name: `Synthetic Guest ${String(i).padStart(2, '0')}`,
  channel: 'whatsapp', conversation_status: 'active', language: 'en',
  last_message_preview: 'Synthetic scroll regression row', last_message_at: '2026-09-25T08:00:00Z',
}));
function messages(c) {
  return Array.from({ length: 60 }, (_, i) => ({ message_id: `${c.conversation_id}-${i}`,
    direction: i % 2 ? 'outbound' : 'inbound', source: i % 2 ? 'staff_inbox_reply' : 'whatsapp',
    message_text: `Message ${i + 1}. Synthetic text for scrolling inside the conversation card.`,
    created_at: new Date(Date.UTC(2026, 8, 25, 7, i)).toISOString() }));
}
function fixture(client, url) {
  const p = url.pathname;
  if (p === '/staff/auth/session') return { success: true, auth_required: true, role: 'admin', db_role: 'admin', active_client: client, clients: [{ slug: client, name: client }], client_profiles: { [client]: loadClientPortalProfile(client) } };
  if (p === '/staff/inbox/views') return { success: true, groups: [{ id: 'inbox', label: 'INBOX' }, { id: 'people', label: 'PEOPLE' }], views: [{ id: 'all', label: 'All', group: 'inbox', count: rows.length }, { id: 'all_people', label: 'All people', group: 'people', count: rows.length }] };
  if (p === '/staff/inbox/list') return { success: true, rows: rows.map(c => ({ ...c, key: c.conversation_id, source: url.searchParams.get('view') === 'all_people' ? 'customers' : 'conversations' })), has_more: false };
  if (p === '/staff/conversations') return { success: true, conversations: rows };
  if (p === '/staff/customers') return { success: true, customers: rows, rows };
  for (const c of rows) {
    if (p === '/staff/inbox/thread/' + c.conversation_id) return { success: true, conversation_id: c.conversation_id, detail: { success: true, conversation: c }, context: { success: true, context: { guest_name: c.guest_name }, bookings: [] }, messages: { success: true, messages: messages(c) }, draft: { success: false }, pause_state: { success: true, paused: false } };
    if (p === '/staff/conversations/' + c.conversation_id + '/messages') return { success: true, messages: messages(c) };
    if (p === '/staff/customers/' + encodeURIComponent(c.phone) + '/context') return { success: true, phone: c.phone, identity: { customer_id: c.customer_id, display_name: c.guest_name, email: 'fixture@example.invalid', language: 'en' }, bookings: [], service_records: [], messages: [], notes: { internal_staff_notes: 'Synthetic guest notes. '.repeat(100) } };
  }
  // Explicit non-critical startup fixtures. Unknown requests fail closed.
  if (['/staff/bot/pause-state', '/staff/locations', '/staff/inbox/stream', '/staff/email/settings', '/staff/email/status', '/staff/customers/filter-options', '/staff/conversations/filter-options', '/staff/portal-settings', '/staff/me', '/staff/admin/house-notes', '/staff/automated-notifications', '/staff/bed-calendar', '/staff/bot/global-pause-state', '/staff/inbox/luna-mode', '/staff/inbox/whatsapp/draft', '/staff/intents', '/staff/whatsapp-numbers', '/staff/schedule/bookings/catalog', '/staff/admin/config/rental-offerings', '/staff/admin/config', '/staff/schedule/day'].includes(p)) return { success: true, rows: [], locations: [], paused: false };
  return null;
}
async function settle(page) { await page.waitForTimeout(750); }
async function surface(page, selector) {
  return page.evaluate(selector => {
    const root = document.querySelector(selector);
    if (!root) throw new Error('Missing surface ' + selector);
    const r = root.getBoundingClientRect();
    const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
    const point = { x: Math.min(innerWidth - 20, Math.max(20, r.left + r.width * 0.55)), y: top + (bottom - top) * 0.55 };
    const hit = document.elementFromPoint(point.x, point.y);
    const chain = [];
    for (let n = hit; n; n = n.parentElement) {
      const s = getComputedStyle(n), rect = n.getBoundingClientRect();
      chain.push({ id: n.id, tag: n.tagName, cls: n.className, height: n.clientHeight, total: n.scrollHeight, scroll: n.scrollTop, overflow: s.overflowY, touch: s.touchAction, overscroll: s.overscrollBehaviorY, top: rect.top, bottom: rect.bottom });
    }
    return { selector, point, hitInside: !!hit && root.contains(hit), hit: hit && hit.outerHTML.slice(0, 240), chain };
  }, selector);
}
async function positions(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('*')).filter(n => n.scrollHeight > n.clientHeight + 2 && n.clientHeight > 0).map(n => ({ key: n.id || n.className || n.tagName, top: n.scrollTop })));
}
async function gesture(page, cdp, point, input, dy) {
  if (input === 'touch') {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y + dy * i / 12, id: 1 }] });
      await page.waitForTimeout(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    await page.mouse.move(point.x, point.y + dy, { steps: 12 }); await page.mouse.up();
  }
  await settle(page);
}
async function run(browser, client, width, html) {
  const name = `${client}-${width}`;
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const cdp = await context.newCDPSession(page);
  const evidence = { browser: browser.version(), client, width, height: 844, requests: [], unknown: [], writes: [], external: [], errors: [], cases: [], failures: [] };
  page.on('pageerror', e => evidence.errors.push(e.message));
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    evidence.requests.push(req.method() + ' ' + url.pathname + url.search);
    if (req.method() !== 'GET') { evidence.writes.push(req.method() + ' ' + url.pathname); return route.abort(); }
    if (url.origin !== ORIGIN) {
      evidence.external.push(url.origin + url.pathname);
      if (url.origin !== 'https://fonts.googleapis.com' || url.pathname !== '/css2') evidence.unknown.push('external: ' + url.origin + url.pathname);
      return route.abort();
    }
    if (url.pathname === '/staff/ui') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname.startsWith('/staff/assets/')) return route.fulfill({ status: 204, body: '' });
    const body = fixture(client, url);
    if (!body) { evidence.unknown.push(url.pathname); return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }); }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('wh_staff_portal_locale', 'en'); history.scrollRestoration = 'manual'; });
  async function checkDrag(kind, selector, input, dy) {
    await page.waitForFunction(selector => {
      const n = document.querySelector(selector); if (!n) return false;
      const r = n.getBoundingClientRect(), y = (Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2;
      return n.contains(document.elementFromPoint(r.left + r.width * 0.55, y));
    }, selector);
    const beforeSurface = await surface(page, selector), before = await positions(page);
    assert(beforeSurface.hitInside, kind + ': gesture must start inside surface: ' + JSON.stringify(beforeSurface));
    await gesture(page, cdp, beforeSurface.point, input, dy);
    const after = await positions(page);
    const ancestorKeys = beforeSurface.chain.map(n => n.id || n.cls || n.tag);
    const moved = after.filter(n => { const prev = before.find(p => p.key === n.key); return ancestorKeys.includes(n.key) && prev && (n.top - prev.top) * -Math.sign(dy) > 20; });
    const record = { kind, input, dy, beforeSurface, before, after, moved };
    evidence.cases.push(record);
    if (!moved.length) { evidence.failures.push(`${kind} ${input} dy=${dy}: no scrolling`); console.error('FAIL', name, kind, input, dy, 'no scrolling'); }
    else console.log('PASS', name, kind, input, dy, JSON.stringify(moved));
    await page.screenshot({ path: path.join(OUT, `${name}-${kind}-${input}-${dy}.png`) });
  }
  try {
    for (const input of ['touch', 'mouse']) for (const kind of ['chats', 'thread', 'guests', 'guest-card']) {
      await page.goto(ORIGIN + '/staff/ui');
      await page.waitForFunction(() => !document.body.classList.contains('portal-profile-pending'));
      await page.evaluate(() => window.switchToTab('conversations'));
      await page.locator('.inbox-folder-tab[data-view="full"]').click();
      await page.locator('#conv-list .conv-card').first().waitFor(); await settle(page);
      if (kind === 'guests' || kind === 'guest-card') {
        await page.locator('.inbox-folder-tab[data-view="guest"]').click(); await settle(page);
        await page.locator('#conv-list .conv-card').first().waitFor();
      }
      if (kind === 'thread' || kind === 'guest-card') {
        await page.locator('#conv-list .conv-card').first().click();
        await page.locator(kind === 'thread' ? '#thread-container .msg' : '#inbox-detail-sidebar .inbox-customer-card').first().waitFor({ state: 'attached' });
        await settle(page);
      }
      // Drag card body text, not the Notes action button (mouse controls stay
      // native). The button is exercised separately below as an ordinary click.
      const selector = kind === 'thread' ? '#thread-container' : kind === 'guest-card' ? '#inbox-guest-notes-text-display' : '.inbox-left-rows';
      await checkDrag(kind, selector, input, kind === 'thread' ? 140 : -140);
      // On the broken base a mouse drag can activate a row. Preserve that
      // failure and continue with the next independently opened surface.
      if ((kind === 'chats' || kind === 'guests') && await page.locator('#inbox-shell').evaluate(n => n.classList.contains('show-thread'))) {
        evidence.failures.push(kind + ' ' + input + ': drag activated a row');
        continue;
      }
      await checkDrag(kind, selector, input, kind === 'thread' ? -100 : 100);
      assert.equal(await page.locator('.is-pointer-dragging').count(), 0, 'pointer release clears drag state');
      if (kind === 'chats' || kind === 'guests') {
        assert.equal(await page.locator('#inbox-shell').evaluate(n => n.classList.contains('show-thread')), false, 'neither drag activates a row');
        await page.locator('#conv-list .conv-card').first().click();
        await page.waitForFunction(() => document.querySelector('#inbox-shell').classList.contains('show-thread'));
        evidence.cases.push({ kind, input, control: 'ordinary row click still opens detail', pass: true });
      } else if (kind === 'thread') {
        const composer = page.locator('#draft-textarea');
        await composer.click();
        assert(await composer.evaluate(n => n === document.activeElement), 'composer remains focusable');
        await composer.fill('Unsent synthetic test');
        assert.equal(await composer.inputValue(), 'Unsent synthetic test');
        evidence.cases.push({ kind, input, control: 'composer focus and typing; no send', pass: true });
      } else {
        assert.equal(await page.locator('#inbox-guest-notes-text').isVisible(), false, 'drag on notes does not edit');
        await page.locator('[data-inbox-inline="notes"] .inbox-guest-inline-title').click();
        await page.locator('#inbox-guest-notes-text').waitFor({ state: 'visible' });
        evidence.cases.push({ kind, input, control: 'ordinary Notes button opens editor; no save', pass: true });
      }
    }
  } catch (e) { evidence.failures.push(e.stack); console.error(name, e.stack); }
  finally {
    if (evidence.cases.filter(c => c.dy).length !== 16) evidence.failures.push('incomplete directional gesture coverage');
    if (evidence.cases.filter(c => c.control).length !== 8) evidence.failures.push('incomplete ordinary control coverage');
    await page.screenshot({ path: path.join(OUT, `${name}-last.png`) });
    fs.writeFileSync(path.join(OUT, `${name}-last.txt`), await page.locator('body').innerText());
    for (const key of ['errors', 'writes', 'unknown']) if (evidence[key].length) evidence.failures.push(`${key}: ${JSON.stringify(evidence[key])}`);
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(evidence, null, 2));
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
      for (const width of (process.env.SCROLL_WIDTHS || '360,390,430').split(',').map(Number)) failures += await run(browser, client, width, fs.readFileSync(dest, 'utf8'));
    }
  } finally { await browser.close(); }
  console.log(`phone-scroll-anywhere-refix: ${failures ? 'FAIL' : 'PASS'} (${failures} failures); ${OUT}`);
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
