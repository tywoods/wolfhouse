'use strict';
/** Offline cooked /staff/ui email draft→approve via createStaffQueryApiHttpServer + fortress session. Intercepts only email draft/approve. */
const fs = require('fs');
const http = require('http');
const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..');
const STAFF = path.join(ROOT, 'scripts/staff-query-api.js');
const EMAIL_CONV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WA_CONV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AP1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const AP2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const STAFF_UID = '55555555-5555-4555-8555-555555555555';
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION = 'email-inbox-ui-offline-session-token';
const MAX = 8000;
let pass = 0, fail = 0;
function ok(n, c, d) {
  if (c) { pass += 1; console.log('  PASS  ' + n); }
  else { fail += 1; console.error('  FAIL  ' + n + (d ? ' — ' + d : '')); }
}
try { require.resolve('dotenv'); } catch {
  const c = ['/opt/data/wolfhouse-agent/node_modules', '/opt/data/cursor-workspace/WH/node_modules', path.join(ROOT, 'node_modules')]
    .find((x) => fs.existsSync(path.join(x, 'dotenv')));
  if (c) { process.env.NODE_PATH = c + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : ''); Module._initPaths(); }
}
(function resolveBrowsers() {
  for (const c of [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/data/home/.cache/ms-playwright', path.join(process.env.HOME || '', '.cache', 'ms-playwright')].filter(Boolean)) {
    if (fs.existsSync(path.join(c, 'chromium-1228')) || fs.existsSync(path.join(c, 'chromium_headless_shell-1228'))) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = c; return;
    }
  }
})();
function pw() {
  for (const p of ['playwright', '/opt/data/cursor-workspace/WH/node_modules/playwright', '/opt/data/email-slice-1b/node_modules/playwright']) {
    try { return require(p); } catch (_) { /* */ }
  }
  throw new Error('playwright module unavailable');
}
const listen = (s) => new Promise((r, j) => { s.once('error', j); s.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + s.address().port)); });
const closeS = (s) => new Promise((r) => s.close(() => r()));
function clearStaffCache() {
  for (const k of Object.keys(require.cache)) {
    if (/staff-query-api\.js$|staff-auth-config|staff-portal-clients|pg-connect|staff-email-inbox-routes|sunset-admin-verify-ui-html/.test(k)) {
      delete require.cache[k];
    }
  }
}
function buildHtmlArtifact(drafts, outbound) {
  if (drafts) process.env.EMAIL_STAFF_EMAIL_DRAFTS_ENABLED = 'true'; else delete process.env.EMAIL_STAFF_EMAIL_DRAFTS_ENABLED;
  if (outbound) process.env.EMAIL_STAFF_OUTBOUND_ENABLED = 'true'; else delete process.env.EMAIL_STAFF_OUTBOUND_ENABLED;
  Object.assign(process.env, {
    NODE_ENV: 'test', STAFF_UI_BUILDER_TEST_SEAM: '1',
    STAFF_AUTH_REQUIRED: 'false', STAFF_AUTH_ALLOW_OPEN: 'true',
    STAFF_RUNTIME_PROFILE: 'test', DEFAULT_CLIENT_SLUG: process.env.DEFAULT_CLIENT_SLUG || 'sunset',
  });
  delete process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER;
  clearStaffCache();
  return require('./lib/sunset-admin-verify-ui-html').buildVerifyStaffUiHtml();
}

// SLICE_4_5_LUNA_BEHAVIOR_GREEN: cooked behavior below owns this contract.
function emailListRow(id, ch, name, phone) {
  return { conversation_id: id, guest_name: name, phone, channel: ch, last_message_preview: ch === 'email' ? 'Hello from email' : 'Hello from wa', needs_human: true, guest_email: ch === 'email' ? 'guest@example.com' : null, location_id: 'sunset-somo', bot_mode: 'bot', conversation_status: 'active' };
}
function emailDetailRow(id, ch, name, phone) {
  return Object.assign(emailListRow(id, ch, name, phone), { email: ch === 'email' ? 'guest@example.com' : null, staff_reply_draft: '', human_notes: null, conversation_summary: null, handoff_reason: null });
}
function offlinePg() {
  const email = emailDetailRow(EMAIL_CONV, 'email', 'Email Guest', 'emailv1:opaque-key-1');
  const wa = emailDetailRow(WA_CONV, 'whatsapp', 'WhatsApp Guest', '+34600111222');
  return { async query(sql, params) {
    const n = String(sql).replace(/\s+/g, ' '), p = (params || []).map(String), hasE = p.includes(EMAIL_CONV), hasW = p.includes(WA_CONV);
    if (/FROM conversations conv/.test(n) && /last_message_preview/.test(n) && !hasE && !hasW && !/staff_reply_draft/.test(n) && !/FROM messages/.test(n))
      return { rows: [emailListRow(EMAIL_CONV, 'email', 'Email Guest', 'emailv1:opaque-key-1'), emailListRow(WA_CONV, 'whatsapp', 'WhatsApp Guest', '+34600111222')] };
    if (hasE || hasW) {
      const d = hasE ? email : wa;
      if (/FROM messages/.test(n)) return { rows: [] };
      if (/draft_text/.test(n)) return { rows: [{ conversation_id: d.conversation_id, draft_text: '', draft_available: false, reason: 'no_draft_stored' }] };
      if (/first_response_due_at|handoff_due_at/.test(n)) return { rows: [{ conversation_id: d.conversation_id, needs_human: true, bot_mode: 'bot' }] };
      return { rows: [d] };
    }
    return { rows: [] };
  } };
}
function loadProdApi(opts) {
  const drafts = opts && opts.drafts;
  const outbound = opts && opts.outbound;
  const luna = opts && opts.luna;
  if (drafts) process.env.EMAIL_STAFF_EMAIL_DRAFTS_ENABLED = 'true'; else delete process.env.EMAIL_STAFF_EMAIL_DRAFTS_ENABLED;
  if (outbound) process.env.EMAIL_STAFF_OUTBOUND_ENABLED = 'true'; else delete process.env.EMAIL_STAFF_OUTBOUND_ENABLED;
  if (luna) {
    process.env.EMAIL_STAFF_LUNA_DRAFT_ENABLED = 'true';
    process.env.EMAIL_LUNA_DRAFT_RUNTIME_ENABLED = 'true';
    process.env.LUNA_DEPLOYMENT = 'sunset-staging';
  } else {
    delete process.env.EMAIL_STAFF_LUNA_DRAFT_ENABLED;
    delete process.env.EMAIL_LUNA_DRAFT_RUNTIME_ENABLED;
    delete process.env.LUNA_DEPLOYMENT;
  }
  Object.assign(process.env, {
    NODE_ENV: 'test', STAFF_RUNTIME_PROFILE: 'test', STAFF_API_FORTRESS_OFFLINE_LISTENER: '1',
    STAFF_AUTH_REQUIRED: 'true', STAFF_AUTH_HTTPS: 'false', STAFF_QUERY_API_HOST: '127.0.0.1',
    DEFAULT_CLIENT_SLUG: 'sunset', STAFF_PORTAL_ORIGIN: 'http://127.0.0.1',
  });
  delete process.env.STAFF_AUTH_ALLOW_OPEN;
  delete process.env.STAFF_UI_BUILDER_TEST_SEAM;
  clearStaffCache();
  const api = require(STAFF);
  if (typeof api.createStaffQueryApiHttpServer !== 'function' || typeof api.setFortress15j3OfflineSeams !== 'function') {
    throw new Error('production_router_seams_unavailable');
  }
  api.setFortress15j3OfflineSeams({
    withPgClient: async (fn) => fn(offlinePg()),
    resolveSessionUser(req) {
      const raw = String((req.headers && req.headers.cookie) || '');
      if (raw.includes(SESSION)) {
        return {
          staff_user_id: STAFF_UID, email: null, role: 'operator', status: 'active',
          display_name: 'Op', client_id: CLIENT_ID, client_slug: 'sunset', session_id: 's1',
        };
      }
      return null;
    },
    canAccessClient(u, s) { return !!(u && u.client_slug === 'sunset' && s === 'sunset'); },
  });
  return api;
}
async function startProdServer(opts) {
  const api = loadProdApi(opts);
  const server = api.createStaffQueryApiHttpServer();
  const base = await listen(server);
  return { api, server, base };
}
function httpGet(base, p, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    http.get({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: cookie ? { cookie: 'luna_staff_session=' + cookie } : {},
    }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
    }).on('error', reject);
  });
}
async function launchBrowser() {
  const { chromium } = pw();
  const exes = [process.env.PLAYWRIGHT_BROWSERS_PATH && path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium-1228/chrome-linux64/chrome'),
    '/opt/data/home/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    '/opt/data/home/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell'].filter(Boolean);
  const executablePath = exes.find((p) => fs.existsSync(p));
  try { return await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true }); }
  catch (e1) {
    try { return await chromium.launch({ headless: true, channel: 'chrome' }); }
    catch (e2) { const err = new Error('BROWSER_UNAVAILABLE: ' + (e1 && e1.message) + ' | ' + (e2 && e2.message)); err.code = 'BROWSER_UNAVAILABLE'; throw err; }
  }
}
function multibytePad(n) {
  let out = '', b = 0;
  while (b + 2 <= n) { out += 'é'; b += 2; }
  while (b < n) { out += 'a'; b += 1; }
  return out;
}
function lunaUiMutationGuard(source) {
  if (!/if\s*\(panel\)\s*performEmailLunaDraftGenerate\(convId,\s*panel\)/.test(source)) throw new Error('luna_click_handler_missing');
  if (!/st\.locked\|\|st\.inFlight/.test(source)) throw new Error('luna_duplicate_lock_missing');
  if (!/ta\.value=accepted\.message_text/.test(source) || !/el\.textContent\s*=\s*message/.test(source)) throw new Error('luna_safe_dom_assignment_missing');
  if (/ta\.innerHTML=accepted\.message_text|el\.innerHTML\s*=\s*message/.test(source)) throw new Error('luna_unsafe_innerhtml');
  return true;
}
async function openInbox(page) {
  await page.waitForFunction(() => { const c = document.querySelector('#c-client'); return c && c.value === 'sunset' && !document.body.classList.contains('portal-profile-pending'); }, null, { timeout: 20000 });
  const tab = page.locator('.tab-btn[data-tab="conversations"]');
  if (await tab.count() < 1) throw new Error('Inbox tab/button missing — navigation hard fail');
  await tab.first().click();
  await page.waitForSelector('.conv-card', { timeout: 20000 });
}
async function bindSession(context, base) {
  const u = new URL(base);
  await context.addCookies([{ name: 'luna_staff_session', value: SESSION, domain: u.hostname, path: '/staff' }]);
  await context.addInitScript(() => { try { localStorage.setItem('staff_portal_client', 'sunset'); localStorage.setItem('staff_portal_sunset_location', 'sunset-somo'); localStorage.setItem('wh_staff_portal_locale', 'en'); } catch (_) {} });
}
async function assertActionA11y(page) {
  await page.waitForTimeout(40);
  return page.evaluate(() => {
    const panel = document.querySelector('.draft-panel') || document.querySelector('.draft-actions');
    const pr = panel ? panel.getBoundingClientRect() : null;
    return ['#btn-email-save-draft', '#btn-email-approve-send'].map((sel) => {
      const el = document.querySelector(sel);
      if (!el || el.offsetParent === null) return null;
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return { sel, h: r.height, focusable: el.tabIndex >= 0 || el.tagName === 'BUTTON', minH: parseFloat(cs.minHeight) || 0,
        clipped: pr ? (r.top < pr.top - 1 || r.bottom > pr.bottom + 1 || r.left < pr.left - 1 || r.right > pr.right + 1) : false,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
    }).filter(Boolean);
  });
}
async function main() {
  console.log('verify:staff-email-inbox-ui — cooked production /staff/ui email draft→approve\n');
  console.log('[1] Gate OFF cooked artifact');
  const htmlOff = buildHtmlArtifact(false, false);
  ok('gate-off flags false', htmlOff.includes('window.__EMAIL_STAFF_EMAIL_DRAFTS_ENABLED__=false') && htmlOff.includes('window.__EMAIL_STAFF_OUTBOUND_ENABLED__=false'));
  ok('gate-off retains WA send', htmlOff.includes('function wireInboxSendReply') && htmlOff.includes('id="btn-send-reply"') && htmlOff.includes('/staff/inbox/send-reply'));
  ok('gate-off no browser override hooks', !/localStorage\.setItem\(['"]EMAIL_STAFF/.test(htmlOff) && !/URLSearchParams.*EMAIL_STAFF/.test(htmlOff));
  console.log('\n[2] Gate ON cooked artifact + containment helpers');
  const htmlOn = buildHtmlArtifact(true, true);
  ok('gate-on flags true', htmlOn.includes('window.__EMAIL_STAFF_EMAIL_DRAFTS_ENABLED__=true') && htmlOn.includes('window.__EMAIL_STAFF_OUTBOUND_ENABLED__=true'));
  ok('gate-on helpers+paths', htmlOn.includes('function wireInboxEmailReply') && htmlOn.includes("c.channel === 'email'") && htmlOn.includes('/staff/inbox/email/draft') && htmlOn.includes('/staff/inbox/email/approve-send') && htmlOn.includes('function acceptEmailDraftSuccess') && htmlOn.includes('function acceptEmailApproveDisabled503') && htmlOn.includes('function acceptEmailApproveSuccess') && htmlOn.includes('function emailOwnData') && htmlOn.includes('min-height:44px'));
  ok('gate-on committed-send success acceptor keys', htmlOn.includes('EMAIL_APPROVE_OK_KEYS') && /success.*conversation_id.*approval_id.*approval_state/.test(htmlOn.replace(/\s+/g, ' ')));
  ok('no authority inputs in artifact', !/id="email-(recipient|sender|mailbox|thread|provider|operation|idempotency)/.test(htmlOn));
  const prodSource = fs.readFileSync(STAFF, 'utf8');
  ok('Luna production UI passes mutation guard', lunaUiMutationGuard(prodSource));
  for (const [name, mutant] of [
    ['click no-op', prodSource.replace('if (panel) performEmailLunaDraftGenerate(convId, panel);', 'if (panel) return;')],
    ['duplicate lock removed', prodSource.replace('if(!ta||st.locked||st.inFlight)return;', 'if(!ta||st.locked)return;')],
    ['value/textContent replaced by innerHTML', prodSource.replace('ta.value=accepted.message_text', 'ta.innerHTML=accepted.message_text').replace('el.textContent = message', 'el.innerHTML = message')],
  ]) {
    let killed = false;
    try { lunaUiMutationGuard(mutant); } catch (_) { killed = true; }
    ok('Luna mutation killed: ' + name, killed);
  }
  ok('verifier requires real Inbox tab click', fs.readFileSync(__filename, 'utf8').includes(".tab-btn[data-tab=\"conversations\"]") && !/else if \(typeof switchToTab === 'function'\) switchToTab\('conversations'/.test(fs.readFileSync(__filename, 'utf8')));
  console.log('\n[2b] Real production router + session seam');
  let prod = await startProdServer({ drafts: true, outbound: true, luna: true });
  const noAuth = await httpGet(prod.base, '/staff/ui?client=sunset');
  ok('router /staff/ui without session rejects', noAuth.status === 401 || noAuth.status === 403 || noAuth.status === 302);
  const withAuth = await httpGet(prod.base, '/staff/ui?client=sunset', SESSION);
  ok('router /staff/ui with session serves HTML', withAuth.status === 200 && /__EMAIL_STAFF_EMAIL_DRAFTS_ENABLED__=true/.test(withAuth.body) && /function acceptEmailDraftSuccess/.test(withAuth.body));
  const sess = await httpGet(prod.base, '/staff/auth/session', SESSION);
  ok('router session seam role operator', sess.status === 200 && /"role"\s*:\s*"operator"/.test(sess.body));
  let browser;
  try { browser = await launchBrowser(); }
  catch (e) {
    console.error('\nBROWSER BLOCKER:', e.message);
    try { await closeS(prod.server); prod.api.setFortress15j3OfflineSeams(null); } catch (_) { /* */ }
    console.error(`\n── verify:staff-email-inbox-ui FAILED early (${pass} pass, browser unavailable) ──`);
    process.exit(2);
  }
  const pageErrors = [], consoleErrors = [], draftPosts = [], approvePosts = [], lunaPosts = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await bindSession(context, prod.base);
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  const draftOk = (body) => ({ success: true, conversation_id: body.conversation_id, message_text: body.message_text, approval_id: body.approval_id || AP1 });
  await page.route('**/staff/inbox/email/draft', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    draftPosts.push({ method: route.request().method(), body: { ...body }, headers: route.request().headers() });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(draftOk(body)) });
  });
  await page.route('**/staff/inbox/email/approve-send', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    approvePosts.push({ body: { ...body } });
    return route.fulfill({
      status: 503, contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'email_send_disabled', conversation_id: body.conversation_id, approval_id: body.approval_id, approval_state: 'approved' }),
    });
  });
  await page.route('**/staff/inbox/email/generate-luna-draft', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    lunaPosts.push({ method: route.request().method(), body: { ...body }, headers: route.request().headers() });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      success: true, conversation_id: body.conversation_id,
      message_text: '<img src=x onerror="window.__lunaXss=1"> literal hostile text', approval_id: AP1,
    }) });
  });
  const emailCard = () => page.locator('.conv-card').filter({ hasText: 'Email Guest' }).first();
  const waCard = () => page.locator('.conv-card').filter({ hasText: 'WhatsApp Guest' }).first();
  const statusText = async () => page.locator('#draft-send-status').innerText();
  const waitStatus = (re, t = 5000) => page.waitForFunction((r) => new RegExp(r, 'i').test(document.querySelector('#draft-send-status')?.textContent || ''), re, { timeout: t });
  try {
    await page.goto(prod.base + '/staff/ui?client=sunset&location=sunset-somo', { waitUntil: 'domcontentloaded' });
    await openInbox(page);
    await emailCard().click();
    await page.waitForSelector('#draft-textarea', { timeout: 10000 });
    ok('Luna eligible email gate-on button visible', await page.locator('#btn-email-generate-luna-draft').count() === 1);
    ok('Luna makes zero generate requests before explicit click', lunaPosts.length === 0);
    ok('Luna does not auto-save, approve, or send', draftPosts.length === 0 && approvePosts.length === 0);
    await waCard().click();
    await page.waitForSelector('#btn-send-reply', { timeout: 10000 });
    ok('Luna button absent for WhatsApp', await page.locator('#btn-email-generate-luna-draft').count() === 0);
    await emailCard().click();
    await page.waitForSelector('#btn-email-generate-luna-draft', { timeout: 10000 });
    await page.click('#btn-email-generate-luna-draft');
    await waitStatus('Luna draft generated');
    ok('Luna click exact POST/body once', lunaPosts.length === 1 && lunaPosts[0].method === 'POST'
      && Object.keys(lunaPosts[0].body).join(',') === 'conversation_id' && lunaPosts[0].body.conversation_id === EMAIL_CONV
      && /application\/json/i.test(String(lunaPosts[0].headers['content-type'] || '')));
    const hostile = '<img src=x onerror="window.__lunaXss=1"> literal hostile text';
    ok('Luna hostile HTML remains literal editable textarea value', await page.inputValue('#draft-textarea') === hostile
      && await page.locator('#draft-textarea img').count() === 0 && !(await page.evaluate(() => window.__lunaXss)));
    ok('Luna success does not auto-approve/send', approvePosts.length === 0);

    await page.unroute('**/staff/inbox/email/generate-luna-draft');
    const heldLuna = [];
    await page.route('**/staff/inbox/email/generate-luna-draft', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      lunaPosts.push({ method: route.request().method(), body: { ...body } });
      await new Promise((resolve) => heldLuna.push(resolve));
      return route.fulfill({ status: 422, contentType: 'application/json', body: '{"success":false,"error":"luna_handoff_required"}' });
    });
    const beforeHeld = lunaPosts.length;
    const heldClick = page.click('#btn-email-generate-luna-draft');
    await page.waitForFunction(() => document.querySelector('#btn-email-generate-luna-draft')?.disabled === true);
    await page.locator('#btn-email-generate-luna-draft').dispatchEvent('click');
    await page.waitForTimeout(80);
    ok('Luna loading disables controls and suppresses rapid duplicate', lunaPosts.length === beforeHeld + 1
      && await page.locator('#draft-textarea').isDisabled() && await page.locator('#btn-email-save-draft').isDisabled());
    heldLuna.splice(0).forEach((resolve) => resolve());
    await heldClick.catch(() => {});
    await waitStatus('handoff required');
    ok('Luna handoff state is bounded textContent', /handoff required/i.test(await statusText())
      && await page.locator('#draft-send-status img').count() === 0);
    await page.unroute('**/staff/inbox/email/generate-luna-draft');
    await page.route('**/staff/inbox/email/generate-luna-draft', (route) => route.abort('failed'));
    const beforeError = lunaPosts.length;
    await page.click('#btn-email-generate-luna-draft');
    await waitStatus('Could not generate');
    ok('Luna network error is textContent and unlocks retry', /Could not generate/.test(await statusText())
      && await page.locator('#btn-email-generate-luna-draft').isEnabled());
    await page.unroute('**/staff/inbox/email/generate-luna-draft');
    await page.route('**/staff/inbox/email/generate-luna-draft', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}'); lunaPosts.push({ body });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(draftOk({ ...body, message_text: 'retry draft' })) });
    });
    await page.click('#btn-email-generate-luna-draft');
    await waitStatus('Luna draft generated');
    ok('Luna retry sends exactly one new request', lunaPosts.length === beforeError + 1 && await page.inputValue('#draft-textarea') === 'retry draft');
    ok('manual Save and Approve remain wired after Luna', await page.locator('#btn-email-save-draft').isEnabled()
      && await page.locator('#btn-email-approve-send').isEnabled());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openInbox(page);
    await emailCard().click();
    await page.waitForSelector('#draft-textarea', { timeout: 10000 });
    ok('email Save+Approve', await page.locator('#btn-email-save-draft').count() === 1 && await page.locator('#btn-email-approve-send').count() === 1);
    ok('email hides WA send', await page.locator('#btn-send-reply').count() === 0);
    ok('no forbidden authority inputs', await page.locator('input[id*="recipient"],input[id*="sender"],input[id*="mailbox"],input[id*="idempotency"],input[name*="provider"]').count() === 0);
    ok('label+aria-live', await page.locator('label[for="draft-textarea"]').count() === 1 && await page.locator('#draft-send-status[aria-live="polite"]').count() === 1);
    await waCard().click();
    await page.waitForSelector('#btn-send-reply', { timeout: 10000 });
    ok('WA send only', await page.locator('#btn-send-reply').count() === 1 && await page.locator('#btn-email-save-draft').count() === 0);
    await emailCard().click();
    await page.waitForSelector('#btn-email-save-draft', { timeout: 10000 });
    draftPosts.length = 0;
    await page.evaluate(() => {
      const button = document.querySelector('#btn-email-save-draft');
      const panel = button && button.closest('.draft-panel');
      const owner = panel && panel.parentElement;
      if (!owner) throw new Error('draft panel owner unavailable');
      const decoy = document.createElement('textarea');
      decoy.id = 'draft-textarea';
      decoy.className = 'gate3-duplicate-target-decoy';
      decoy.value = '';
      decoy.hidden = true;
      owner.insertBefore(decoy, panel);
    });
    await page.locator('.draft-panel #draft-textarea').fill('First email draft body');
    await page.click('#btn-email-save-draft');
    await waitStatus('Draft saved');
    ok('action binds to button-owned draft panel despite duplicate ancestor target', draftPosts.length === 1 && draftPosts[0].body.message_text === 'First email draft body');
    await page.evaluate(() => document.querySelector('.gate3-duplicate-target-decoy')?.remove());
    ok('first draft null id exact keys', draftPosts.length === 1 && draftPosts[0].method === 'POST' && Object.keys(draftPosts[0].body).sort().join(',') === 'approval_id,conversation_id,message_text' && draftPosts[0].body.conversation_id === EMAIL_CONV && draftPosts[0].body.message_text === 'First email draft body' && draftPosts[0].body.approval_id === null && /application\/json/i.test(String(draftPosts[0].headers['content-type'] || '')));
    await page.fill('#draft-textarea', 'Updated email draft body');
    await page.click('#btn-email-save-draft');
    await waitStatus('Draft saved');
    ok('second draft reuses approval id', draftPosts.length === 2 && draftPosts[1].body.approval_id === AP1 && draftPosts[1].body.message_text === 'Updated email draft body' && draftPosts[1].body.conversation_id === EMAIL_CONV);
    approvePosts.length = 0;
    await page.fill('#draft-textarea', 'Unsaved change');
    await page.click('#btn-email-approve-send');
    await waitStatus('Save the current text before approving', 3000);
    ok('approve blocked when dirty', approvePosts.length === 0);
    await page.fill('#draft-textarea', 'Updated email draft body');
    await page.click('#btn-email-approve-send');
    await waitStatus('Approved');
    ok('approve payload exact', approvePosts.length === 1 && Object.keys(approvePosts[0].body).sort().join(',') === 'approval_id,conversation_id,message_text' && approvePosts[0].body.approval_id === AP1 && approvePosts[0].body.conversation_id === EMAIL_CONV && approvePosts[0].body.message_text === 'Updated email draft body');
    const ac = await statusText();
    ok('approved disabled copy', /Approved/.test(ac) && /email sending is currently disabled/i.test(ac) && !/\bsent\b/i.test(ac));
    ok('locked after approval', await page.locator('#draft-textarea').isDisabled() && await page.locator('#btn-email-save-draft').isDisabled() && await page.locator('#btn-email-approve-send').isDisabled());
    await waCard().click();
    await page.waitForSelector('#btn-send-reply', { timeout: 8000 });
    ok('WA enabled after email lock', await page.locator('#btn-send-reply').isEnabled());
    await emailCard().click();
    await page.waitForSelector('#btn-email-save-draft', { timeout: 8000 });
    ok('email stays locked', await page.locator('#draft-textarea').isDisabled() && await page.locator('#btn-email-save-draft').isDisabled());
    draftPosts.length = 0; approvePosts.length = 0;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openInbox(page);
    await emailCard().click();
    await page.waitForSelector('#btn-email-save-draft', { timeout: 10000 });
    await page.fill('#draft-textarea', 'Isolation draft A');
    await page.click('#btn-email-save-draft');
    await waitStatus('Draft saved');
    ok('isolation first save null id', draftPosts[0] && draftPosts[0].body.approval_id === null);
    draftPosts.length = 0;
    await page.unroute('**/staff/inbox/email/draft').catch(() => {});
    let draftCall = 0;
    const pendingSlow = [];
    await page.route('**/staff/inbox/email/draft', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      draftPosts.push({ body: { ...body } });
      draftCall += 1;
      if (draftCall === 1) {
        await new Promise((r) => pendingSlow.push(r));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, conversation_id: body.conversation_id, message_text: 'STALE_TEXT_SHOULD_NOT_APPLY', approval_id: AP2 }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, conversation_id: body.conversation_id, message_text: body.message_text, approval_id: body.approval_id || AP1 }) });
    });
    await page.waitForFunction(() => !document.querySelector('#btn-email-save-draft')?.disabled, null, { timeout: 5000 });
    await page.fill('#draft-textarea', 'stale-src-text');
    const c1 = page.click('#btn-email-save-draft');
    await page.waitForFunction(() => document.querySelector('#btn-email-save-draft')?.disabled === true, null, { timeout: 3000 });
    ok('in-flight disables textarea', await page.locator('#draft-textarea').isDisabled());
    await waCard().click();
    await page.waitForSelector('#btn-send-reply', { timeout: 8000 });
    while (pendingSlow.length) pendingSlow.shift()();
    await c1.catch(() => {});
    await page.waitForTimeout(60);
    await emailCard().click();
    await page.waitForSelector('#btn-email-save-draft', { timeout: 8000 });
    await page.waitForFunction(() => !document.querySelector('#btn-email-save-draft')?.disabled, null, { timeout: 5000 });
    const taStale = await page.inputValue('#draft-textarea');
    ok('stale body not applied to textarea', taStale !== 'STALE_TEXT_SHOULD_NOT_APPLY' && !/STALE_TEXT/.test(taStale));
    draftPosts.length = 0;
    await page.fill('#draft-textarea', 'after-stale');
    await page.click('#btn-email-save-draft');
    await waitStatus('Draft saved');
    ok('post-stale save not using stale AP2', draftPosts.length === 1 && draftPosts[0].body.message_text === 'after-stale' && draftPosts[0].body.approval_id !== AP2);
    ok('stale path no pageerror', pageErrors.length === 0);
    await page.unroute('**/staff/inbox/email/draft').catch(() => {});
    await page.route('**/staff/inbox/email/draft', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      draftPosts.push({ body: { ...body }, headers: route.request().headers() });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(draftOk(body)) });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openInbox(page);
    await emailCard().click();
    await page.waitForSelector('#draft-textarea', { timeout: 10000 });
    const exact = multibytePad(MAX), over = exact + 'x';
    ok('fixture bytes', Buffer.byteLength(exact, 'utf8') === MAX && Buffer.byteLength(over, 'utf8') > MAX);
    await page.fill('#draft-textarea', exact);
    ok('counter at limit', /8000\s*\/\s*8000/.test(await page.locator('#email-draft-byte-count').innerText()));
    draftPosts.length = 0;
    await page.click('#btn-email-save-draft');
    await waitStatus('Draft saved|exceeds');
    ok('save at exactly 8000', draftPosts.length === 1 && Buffer.byteLength(draftPosts[0].body.message_text, 'utf8') === MAX);
    await page.fill('#draft-textarea', over);
    ok('over class', await page.locator('#email-draft-byte-count.is-over').count() === 1);
    draftPosts.length = 0;
    await page.click('#btn-email-save-draft');
    await waitStatus('exceeds 8,000', 3000);
    ok('client blocks over 8000', draftPosts.length === 0);
    draftPosts.length = 0; approvePosts.length = 0;
    await page.fill('#draft-textarea', 'Approve path body');
    await page.click('#btn-email-save-draft');
    await waitStatus('Draft saved');
    await page.unroute('**/staff/inbox/email/approve-send').catch(() => {});
    await page.route('**/staff/inbox/email/approve-send', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      approvePosts.push({ body: { ...body } });
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'email_send_disabled', conversation_id: body.conversation_id, approval_id: body.approval_id, approval_state: 'draft' }) });
    });
    await page.click('#btn-email-approve-send');
    await waitStatus('draft not approved');
    let copy = await statusText();
    ok('draft 503 copy', /Email sending is disabled; draft not approved/i.test(copy) && !/\bsent\b/i.test(copy));
    ok('draft 503 unlocked', await page.locator('#draft-textarea').isEnabled());
    await page.unroute('**/staff/inbox/email/approve-send').catch(() => {});
    await page.route('**/staff/inbox/email/approve-send', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      approvePosts.push({ body: { ...body } });
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'email_send_disabled', conversation_id: body.conversation_id, approval_id: body.approval_id, approval_state: 'approved' }) });
    });
    await page.click('#btn-email-approve-send');
    await waitStatus('Approved');
    copy = await statusText();
    ok('approved 503 copy', /Approved/.test(copy) && /email sending is currently disabled/i.test(copy) && !/\bsent\b/i.test(copy));
    ok('approved 503 locks', await page.locator('#draft-textarea').isDisabled());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openInbox(page);
    await emailCard().click();
    await page.waitForSelector('#btn-email-save-draft', { timeout: 10000 });
    await page.fill('#draft-textarea', 'need approve without save');
    approvePosts.length = 0;
    await page.click('#btn-email-approve-send');
    await waitStatus('Save a draft before approving', 3000);
    ok('approve requires draft', approvePosts.length === 0);
    await page.unroute('**/staff/inbox/email/draft').catch(() => {});
    await page.route('**/staff/inbox/email/draft', async (route) => {
      draftPosts.push({ body: JSON.parse(route.request().postData() || '{}') });
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'draft_failed' }) });
    });
    await page.click('#btn-email-save-draft');
    await waitStatus('^Save failed$');
    ok('error recovery re-enables', await page.locator('#btn-email-save-draft').isEnabled() && await page.locator('#draft-textarea').isEnabled());
    ok('500 ignores body error field', !/draft_failed|HTTP 500/i.test(await statusText()));
    await page.unroute('**/staff/inbox/email/draft').catch(() => {});
    await page.route('**/staff/inbox/email/draft', async (route) => {
      draftPosts.push({ body: JSON.parse(route.request().postData() || '{}') });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{not-json' });
    });
    await page.fill('#draft-textarea', 'parse fail body');
    await page.click('#btn-email-save-draft');
    await waitStatus('Invalid response', 4000);
    ok('JSON parse fail recovery', await page.locator('#btn-email-save-draft').isEnabled() && await page.locator('#draft-textarea').isEnabled());
    await page.unroute('**/staff/inbox/email/draft').catch(() => {});
    let rejectMode = 'array';
    await page.route('**/staff/inbox/email/draft', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      draftPosts.push({ body: { ...body } });
      const shapes = {
        array: [{ success: true, conversation_id: body.conversation_id, message_text: body.message_text, approval_id: AP1 }],
        extra: { success: true, conversation_id: body.conversation_id, message_text: body.message_text, approval_id: AP1, extra: 1 },
        wrong_conv: { success: true, conversation_id: WA_CONV, message_text: body.message_text, approval_id: AP1 },
        wrong_text: { success: true, conversation_id: body.conversation_id, message_text: 'OTHER', approval_id: AP1 },
        bad_uuid: { success: true, conversation_id: body.conversation_id, message_text: body.message_text, approval_id: 'not-a-uuid' },
        success_false: { success: false, conversation_id: body.conversation_id, message_text: body.message_text, approval_id: AP1 },
        proto: Object.assign(Object.create({ success: true }), { conversation_id: body.conversation_id, message_text: body.message_text, approval_id: AP1 }),
      };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(shapes[rejectMode] || shapes.array) });
    });
    for (const mode of ['array', 'extra', 'wrong_conv', 'wrong_text', 'bad_uuid', 'success_false']) {
      rejectMode = mode;
      draftPosts.length = 0;
      await page.fill('#draft-textarea', 'reject-' + mode);
      await page.click('#btn-email-save-draft');
      await waitStatus('Save failed', 4000).catch(() => {});
      await page.waitForTimeout(80);
      const unlocked = await page.locator('#btn-email-save-draft').isEnabled();
      ok('reject draft shape ' + mode, unlocked);
    }
    await page.unroute('**/staff/inbox/email/draft').catch(() => {});
    await page.route('**/staff/inbox/email/draft', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      draftPosts.push({ body: { ...body } });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(draftOk(body)) });
    });
    draftPosts.length = 0;
    await page.fill('#draft-textarea', 'recover-after-reject');
    await page.click('#btn-email-save-draft');
    await waitStatus('Draft saved');
    ok('after rejects still null approval_id', draftPosts[0] && draftPosts[0].body.approval_id === null);
    /* Hostile: planted body/err never enter DOM; fixed status map; no fabricated lock. */
    const PLANTED = 'SENT token=secret SQL provider';
    const noLeak = (c) => { c = String(c || ''); return !c.includes(PLANTED) && !/token=secret|atk-NEVER_LEAK|SELECT \* FROM|HTTP\s+\d{3}/i.test(c) && !/\bsent\b/i.test(c); };
    const ctrlsOk = async () => (await page.locator('#btn-email-save-draft').isEnabled()) && (await page.locator('#draft-textarea').isEnabled()) && (await page.locator('#btn-email-approve-send').isEnabled());
    const setDraftRoute = async (fn) => { await page.unroute('**/staff/inbox/email/draft').catch(() => {}); await page.route('**/staff/inbox/email/draft', fn); };
    const assertSafe = async (label, expectRe) => {
      await waitStatus(expectRe, 4000);
      const copy = await statusText(), dom = await page.locator('body').innerText();
      ok(label, noLeak(copy) && noLeak(dom) && await ctrlsOk(), copy);
    };
    const wrapFetch = async (needle) => page.evaluate(({ s, n }) => {
      window.__emailFetchOrig = window.fetch;
      window.fetch = function (u) { if (String(u).indexOf(n) >= 0) return Promise.reject(new Error(s + ' thrown fetch Error')); return window.__emailFetchOrig.apply(this, arguments); };
    }, { s: PLANTED, n: needle });
    const unwrapFetch = async () => page.evaluate(() => { if (window.__emailFetchOrig) window.fetch = window.__emailFetchOrig; });
    for (const [st, err, expect] of [
      [500, PLANTED + '...', 'Save failed'], [500, PLANTED + 'X'.repeat(4000), 'Save failed'],
      [500, "SELECT * FROM tokens WHERE secret='atk-NEVER_LEAK'", 'Save failed'], [418, PLANTED, 'Save failed'],
      [400, PLANTED, 'Request rejected'], [401, PLANTED, 'Unauthorized'], [403, PLANTED, 'Unauthorized'],
      [404, PLANTED, 'Conversation unavailable'], [409, PLANTED, 'Conflict'], [503, PLANTED, 'Temporarily unavailable'],
    ]) {
      await setDraftRoute(async (route) => { draftPosts.push({ body: JSON.parse(route.request().postData() || '{}') }); return route.fulfill({ status: st, contentType: 'application/json', body: JSON.stringify({ success: false, error: err }) }); });
      await page.fill('#draft-textarea', 'hostile-' + st); await page.click('#btn-email-save-draft');
      await assertSafe('hostile draft ' + st, expect);
    }
    await setDraftRoute(async (route) => { draftPosts.push({ body: JSON.parse(route.request().postData() || '{}') }); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ error: PLANTED, success: true }]) }); });
    await page.fill('#draft-textarea', 'hostile-malformed'); await page.click('#btn-email-save-draft');
    await assertSafe('hostile malformed payload', 'Save failed');
    await setDraftRoute(async (route) => { draftPosts.push({ body: JSON.parse(route.request().postData() || '{}') }); return route.fulfill({ status: 500, contentType: 'text/plain', body: PLANTED + ' raw HTTP body SQL' }); });
    await page.fill('#draft-textarea', 'hostile-raw'); await page.click('#btn-email-save-draft');
    await assertSafe('hostile raw body', 'Invalid response');
    await setDraftRoute(async (route) => { const body = JSON.parse(route.request().postData() || '{}'); draftPosts.push({ body: { ...body } }); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(draftOk(body)) }); });
    await wrapFetch('/staff/inbox/email/draft');
    await page.fill('#draft-textarea', 'throw-draft-body'); await page.click('#btn-email-save-draft');
    await assertSafe('thrown draft err.message ignored', '^Save failed$');
    await unwrapFetch();
    await page.fill('#draft-textarea', 'hostile-approve-body'); await page.click('#btn-email-save-draft'); await waitStatus('Draft saved');
    await wrapFetch('/staff/inbox/email/approve-send');
    await page.click('#btn-email-approve-send');
    await assertSafe('thrown approve err.message ignored', '^Approve failed$');
    await unwrapFetch();
    await page.unroute('**/staff/inbox/email/approve-send').catch(() => {});
    await page.route('**/staff/inbox/email/approve-send', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}'); approvePosts.push({ body: { ...body } });
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: PLANTED + ' approve SQL', approval_state: 'approved', conversation_id: body.conversation_id, approval_id: body.approval_id }) });
    });
    await page.click('#btn-email-approve-send');
    await assertSafe('hostile approve no leak/lock', '^Approve failed$');
    await page.unroute('**/staff/inbox/email/approve-send').catch(() => {});
    let apprMode = 'wrong_conv';
    await page.route('**/staff/inbox/email/approve-send', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      approvePosts.push({ body: { ...body } });
      const base = { success: false, error: 'email_send_disabled', conversation_id: body.conversation_id, approval_id: body.approval_id, approval_state: 'approved' };
      const shapes = {
        wrong_conv: Object.assign({}, base, { conversation_id: WA_CONV }),
        wrong_appr: Object.assign({}, base, { approval_id: AP2 }),
        missing_appr: { success: false, error: 'email_send_disabled', conversation_id: body.conversation_id, approval_state: 'approved' },
        invalid_appr: Object.assign({}, base, { approval_id: 'nope' }),
        extra: Object.assign({}, base, { extra: true }),
        contradictory: Object.assign({}, base, { success: true }),
        array: [base],
        nonobject: 'email_send_disabled',
      };
      const bodyOut = shapes[apprMode];
      return route.fulfill({ status: 503, contentType: 'application/json', body: typeof bodyOut === 'string' ? bodyOut : JSON.stringify(bodyOut) });
    });
    for (const mode of ['wrong_conv', 'wrong_appr', 'missing_appr', 'invalid_appr', 'extra', 'contradictory', 'array', 'nonobject']) {
      apprMode = mode;
      await page.click('#btn-email-approve-send');
      await page.waitForTimeout(120);
      ok('no lock on bad 503 ' + mode, await page.locator('#draft-textarea').isEnabled() && await page.locator('#btn-email-approve-send').isEnabled());
    }
    await page.unroute('**/staff/inbox/email/approve-send').catch(() => {});
    const held = [];
    await page.route('**/staff/inbox/email/approve-send', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      approvePosts.push({ body: { ...body } });
      await new Promise((r) => held.push(r));
      return route.fulfill({
        status: 503, contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'email_send_disabled', conversation_id: body.conversation_id, approval_id: body.approval_id, approval_state: 'approved' }),
      });
    });
    await page.fill('#draft-textarea', 'held-approve-snapshot');
    await page.click('#btn-email-save-draft');
    await waitStatus('Draft saved');
    const approveClick = page.click('#btn-email-approve-send');
    await page.waitForFunction(() => document.querySelector('#btn-email-approve-send')?.disabled === true, null, { timeout: 4000 });
    ok('approve in-flight freezes textarea', await page.locator('#draft-textarea').isDisabled());
    await page.evaluate(() => { const t = document.querySelector('#draft-textarea'); if (t) t.value = 'MUTATED_WHILE_DISABLED'; });
    while (held.length) held.shift()();
    await approveClick.catch(() => {});
    await waitStatus('Approved');
    ok('lock restores snapshot not mutation', (await page.inputValue('#draft-textarea')) === 'held-approve-snapshot' && await page.locator('#draft-textarea').isDisabled());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openInbox(page);
    await emailCard().click();
    await page.waitForSelector('#btn-email-save-draft', { timeout: 10000 });
    await page.unroute('**/staff/inbox/email/draft').catch(() => {});
    await page.route('**/staff/inbox/email/draft', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      draftPosts.push({ body: { ...body } });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(draftOk(body)) });
    });
    await page.unroute('**/staff/inbox/email/approve-send').catch(() => {});
    const held2 = [];
    await page.route('**/staff/inbox/email/approve-send', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      await new Promise((r) => held2.push(r));
      return route.fulfill({
        status: 503, contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'email_send_disabled', conversation_id: body.conversation_id, approval_id: body.approval_id, approval_state: 'approved' }),
      });
    });
    await page.fill('#draft-textarea', 'switch-during-approve');
    await page.click('#btn-email-save-draft');
    await waitStatus('Draft saved');
    const ap2 = page.click('#btn-email-approve-send');
    await page.waitForFunction(() => document.querySelector('#btn-email-approve-send')?.disabled === true, null, { timeout: 4000 });
    await waCard().click();
    await page.waitForSelector('#btn-send-reply', { timeout: 8000 });
    while (held2.length) held2.shift()();
    await ap2.catch(() => {});
    await page.waitForTimeout(80);
    await emailCard().click();
    await page.waitForSelector('#btn-email-save-draft', { timeout: 8000 });
    ok('stale approve after switch does not lock', await page.locator('#draft-textarea').isEnabled());
    /* B1: HTTP 200 committed-send success ownership — exact production DTO only. */
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openInbox(page);
    await emailCard().click();
    await page.waitForSelector('#btn-email-save-draft', { timeout: 10000 });
    await page.unroute('**/staff/inbox/email/draft').catch(() => {});
    await page.route('**/staff/inbox/email/draft', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      draftPosts.push({ body: { ...body } });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(draftOk(body)) });
    });
    await page.unroute('**/staff/inbox/email/approve-send').catch(() => {});
    await page.route('**/staff/inbox/email/approve-send', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      approvePosts.push({ body: { ...body } });
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          conversation_id: body.conversation_id,
          approval_id: body.approval_id,
          approval_state: 'approved',
        }),
      });
    });
    await page.fill('#draft-textarea', 'committed-send-body');
    await page.click('#btn-email-save-draft');
    await waitStatus('Draft saved');
    approvePosts.length = 0;
    await page.click('#btn-email-approve-send');
    await waitStatus('Email sent|sent|Sent|Reply sent', 5000);
    const sentCopy = await statusText();
    ok('200 committed success copy bounded', /Email sent|Reply sent|Sent/i.test(sentCopy) && !/token=|SELECT |approval_not|email_send_committed|AAMk|@/.test(sentCopy));
    ok('200 committed locks controls', await page.locator('#draft-textarea').isDisabled()
      && await page.locator('#btn-email-save-draft').isDisabled()
      && await page.locator('#btn-email-approve-send').isDisabled());
    const postCountAfterSent = approvePosts.length;
    await page.click('#btn-email-approve-send').catch(() => {});
    await page.waitForTimeout(120);
    ok('200 committed blocks re-click submit', approvePosts.length === postCountAfterSent);
    ok('200 committed preserves draft text', (await page.inputValue('#draft-textarea')) === 'committed-send-body');
    await waCard().click();
    await page.waitForSelector('#btn-send-reply', { timeout: 8000 });
    ok('WA send intact after email committed', await page.locator('#btn-send-reply').isEnabled());
    await emailCard().click();
    await page.waitForSelector('#btn-email-approve-send', { timeout: 8000 });
    ok('email stays terminal after WA switch', await page.locator('#draft-textarea').isDisabled()
      && await page.locator('#btn-email-approve-send').isDisabled());

    /* Hostile/malformed 200 must not lock. */
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openInbox(page);
    await emailCard().click();
    await page.waitForSelector('#btn-email-save-draft', { timeout: 10000 });
    await page.unroute('**/staff/inbox/email/draft').catch(() => {});
    await page.route('**/staff/inbox/email/draft', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(draftOk(body)) });
    });
    let commitMode = 'extra';
    await page.unroute('**/staff/inbox/email/approve-send').catch(() => {});
    await page.route('**/staff/inbox/email/approve-send', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      approvePosts.push({ body: { ...body } });
      const exact = {
        success: true,
        conversation_id: body.conversation_id,
        approval_id: body.approval_id,
        approval_state: 'approved',
      };
      const shapes = {
        extra: Object.assign({}, exact, { extra: true }),
        wrong_conv: Object.assign({}, exact, { conversation_id: WA_CONV }),
        wrong_appr: Object.assign({}, exact, { approval_id: AP2 }),
        wrong_state: Object.assign({}, exact, { approval_state: 'draft' }),
        success_false: Object.assign({}, exact, { success: false }),
        missing_state: { success: true, conversation_id: body.conversation_id, approval_id: body.approval_id },
        with_message: Object.assign({}, exact, { message_text: body.message_text }),
        array: [exact],
        accessor: (() => {
          const o = {};
          Object.defineProperty(o, 'success', { get() { return true; }, enumerable: true });
          o.conversation_id = body.conversation_id;
          o.approval_id = body.approval_id;
          o.approval_state = 'approved';
          return o;
        })(),
      };
      const out = shapes[commitMode];
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: typeof out === 'string' ? out : JSON.stringify(out),
      });
    });
    await page.fill('#draft-textarea', 'hostile-200-body');
    await page.click('#btn-email-save-draft');
    await waitStatus('Draft saved');
    for (const mode of ['extra', 'wrong_conv', 'wrong_appr', 'wrong_state', 'success_false', 'missing_state', 'with_message', 'array']) {
      commitMode = mode;
      await page.click('#btn-email-approve-send');
      await page.waitForTimeout(140);
      ok('no lock on bad 200 ' + mode, await page.locator('#draft-textarea').isEnabled()
        && await page.locator('#btn-email-approve-send').isEnabled());
      const badCopy = await statusText();
      ok('bad 200 copy safe ' + mode, !/token=|SELECT |AAMk|@evil|email_send_committed/i.test(badCopy));
    }

    /* Stale/reordered 200 after conversation switch must not lock. */
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openInbox(page);
    await emailCard().click();
    await page.waitForSelector('#btn-email-save-draft', { timeout: 10000 });
    await page.unroute('**/staff/inbox/email/draft').catch(() => {});
    await page.route('**/staff/inbox/email/draft', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(draftOk(body)) });
    });
    const held200 = [];
    await page.unroute('**/staff/inbox/email/approve-send').catch(() => {});
    await page.route('**/staff/inbox/email/approve-send', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      await new Promise((r) => held200.push(r));
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          conversation_id: body.conversation_id,
          approval_id: body.approval_id,
          approval_state: 'approved',
        }),
      });
    });
    await page.fill('#draft-textarea', 'stale-200-commit');
    await page.click('#btn-email-save-draft');
    await waitStatus('Draft saved');
    const staleCommitClick = page.click('#btn-email-approve-send');
    await page.waitForFunction(() => document.querySelector('#btn-email-approve-send')?.disabled === true, null, { timeout: 4000 });
    await waCard().click();
    await page.waitForSelector('#btn-send-reply', { timeout: 8000 });
    while (held200.length) held200.shift()();
    await staleCommitClick.catch(() => {});
    await page.waitForTimeout(100);
    await emailCard().click();
    await page.waitForSelector('#btn-email-save-draft', { timeout: 8000 });
    ok('stale 200 after switch does not lock', await page.locator('#draft-textarea').isEnabled()
      && await page.locator('#btn-email-approve-send').isEnabled());

    /* Preserve 503 email_send_disabled after 200 path work. */
    await page.unroute('**/staff/inbox/email/approve-send').catch(() => {});
    await page.route('**/staff/inbox/email/approve-send', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      return route.fulfill({
        status: 503, contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: 'email_send_disabled',
          conversation_id: body.conversation_id,
          approval_id: body.approval_id,
          approval_state: 'approved',
        }),
      });
    });
    await page.fill('#draft-textarea', 'still-503-after-b1');
    await page.click('#btn-email-save-draft');
    await waitStatus('Draft saved');
    await page.click('#btn-email-approve-send');
    await waitStatus('Approved');
    ok('503 disabled still locks after B1 path', await page.locator('#draft-textarea').isDisabled()
      && /email sending is currently disabled/i.test(await statusText()));

    await page.fill('#draft-textarea', 'a11y body').catch(() => {});
    // If locked from 503, unlock path for a11y by reload
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openInbox(page);
    await emailCard().click();
    await page.waitForSelector('#btn-email-save-draft', { timeout: 10000 });
    await page.unroute('**/staff/inbox/email/draft').catch(() => {});
    await page.route('**/staff/inbox/email/draft', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(draftOk(body)) });
    });
    await page.unroute('**/staff/inbox/email/approve-send').catch(() => {});
    await page.route('**/staff/inbox/email/approve-send', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      return route.fulfill({
        status: 503, contentType: 'application/json',
        body: JSON.stringify({
          success: false, error: 'email_send_disabled',
          conversation_id: body.conversation_id, approval_id: body.approval_id, approval_state: 'draft',
        }),
      });
    });
    await page.fill('#draft-textarea', 'a11y body');
    await page.click('#btn-email-save-draft');
    await waitStatus('Draft saved');
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await emailCard().click();
      await page.waitForSelector('#btn-email-save-draft', { state: 'visible', timeout: 10000 });
      await page.waitForSelector('#btn-email-approve-send', { state: 'visible', timeout: 10000 });
      await page.evaluate(() => { const a = document.querySelector('#btn-email-save-draft'); const b = document.querySelector('#btn-email-approve-send'); if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' }); if (b && b.scrollIntoView) b.scrollIntoView({ block: 'nearest' }); });
      const layout = await assertActionA11y(page);
      const tallOk = layout.length >= 2 && layout.every((x) => Math.round(x.h) >= 44 && (x.minH >= 44 || Math.round(x.h) >= 44));
      ok('actions height>=44 @' + width, tallOk, JSON.stringify(layout));
      ok('actions in container @' + width, layout.length >= 2 && layout.every((x) => !x.clipped), JSON.stringify(layout));
      ok('actions keyboard-focusable @' + width, layout.length >= 2 && layout.every((x) => x.focusable));
      ok('no h-overflow @' + width, layout.every((x) => !x.overflow) && await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    }
    ok('zero pageerror', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    const serious = consoleErrors.filter((t) => !/favicon|Failed to load resource/i.test(t));
    ok('zero console.error', serious.length === 0, serious.slice(0, 3).join(' | '));
    await closeS(prod.server);
    prod.api.setFortress15j3OfflineSeams(null);
    prod = await startProdServer({ drafts: false, outbound: false });
    const ctxOff = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    await bindSession(ctxOff, prod.base);
    const pageOff = await ctxOff.newPage();
    pageOff.on('pageerror', (e) => pageErrors.push('off:' + e.message));
    let emailHits = 0, genericSendHits = 0;
    await pageOff.route('**/staff/inbox/email/**', (r) => { emailHits += 1; return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' }); });
    await pageOff.route('**/staff/inbox/send-reply', (r) => { genericSendHits += 1; return r.fulfill({ status: 409, contentType: 'application/json', body: '{"success":false,"error":"email_channel_send_not_supported"}' }); });
    await pageOff.goto(prod.base + '/staff/ui?client=sunset&location=sunset-somo', { waitUntil: 'domcontentloaded' });
    await openInbox(pageOff);
    await pageOff.locator('.conv-card').filter({ hasText: 'Email Guest' }).first().click();
    await pageOff.waitForSelector('#email-drafting-disabled', { timeout: 10000 });
    ok('gate-off email is explicit read-only drafting-disabled state', await pageOff.locator('#email-drafting-disabled[role="status"]').count() === 1
      && /email drafting is currently disabled/i.test(await pageOff.locator('#email-drafting-disabled').innerText()));
    ok('gate-off email never renders generic, email, or Luna actions', await pageOff.locator('#btn-send-reply,#btn-email-save-draft,#btn-email-approve-send,#btn-email-generate-luna-draft').count() === 0);
    ok('gate-off email composer is read-only', await pageOff.locator('#draft-textarea').count() === 1 && await pageOff.locator('#draft-textarea').isDisabled());
    await pageOff.locator('#draft-textarea').press('Enter').catch(() => {});
    await pageOff.waitForTimeout(80);
    ok('gate-off email never posts generic send-reply', genericSendHits === 0);
    ok('gate-off zero email endpoint hits', emailHits === 0);
    await pageOff.close(); await ctxOff.close();
    await closeS(prod.server);
    prod.api.setFortress15j3OfflineSeams(null);
    prod = await startProdServer({ drafts: true, outbound: false });
    const ctxDraft = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    await bindSession(ctxDraft, prod.base);
    const pageDraft = await ctxDraft.newPage();
    await pageDraft.route('**/staff/inbox/email/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, conversation_id: EMAIL_CONV, message_text: 'x', approval_id: AP1 }) }));
    await pageDraft.goto(prod.base + '/staff/ui?client=sunset&location=sunset-somo', { waitUntil: 'domcontentloaded' });
    await openInbox(pageDraft);
    await pageDraft.locator('.conv-card').filter({ hasText: 'Email Guest' }).first().click();
    await pageDraft.waitForSelector('#btn-email-save-draft', { timeout: 10000 });
    ok('drafts-on Save', await pageDraft.locator('#btn-email-save-draft').count() === 1);
    ok('outbound-off hides Approve', await pageDraft.locator('#btn-email-approve-send').count() === 0);
    await pageDraft.close(); await ctxDraft.close();
    ok('channel===email only', htmlOn.includes("c.channel === 'email'") && htmlOn.includes('never infer'));
  } finally {
    try { await page.close(); } catch (_) { /* */ }
    try { await context.close(); } catch (_) { /* */ }
    try { await browser.close(); } catch (_) { /* */ }
    try { await closeS(prod.server); prod.api.setFortress15j3OfflineSeams(null); } catch (_) { /* */ }
    clearStaffCache();
  }
  console.log(`\n── verify:staff-email-inbox-ui ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(e && e.code === 'BROWSER_UNAVAILABLE' ? 2 : 1);
});
