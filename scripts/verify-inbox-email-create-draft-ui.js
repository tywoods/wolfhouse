'use strict';

/**
 * MAIL-MVP-001 — cooked Inbox Create Draft placement and click behavior.
 *
 * Context field is left of Create Draft, which sits next to Approve & send.
 * Explicit click posts /staff/inbox/email/create-draft only. No send, no
 * approve, no generate-on-open auto trigger. Duplicate clicks are locked.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const THREAD = path.join(ROOT, 'scripts/browser/inbox-thread.js');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');

const EMAIL_CONV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let pass = 0;
let fail = 0;
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

function createDraftFn(source) {
  const start = source.indexOf('function performEmailCreateDraft');
  const end = source.indexOf('function performEmailLunaDraftGenerate');
  return start >= 0 && end > start ? source.slice(start, end) : '';
}
function assertSourcePlacement(source, label) {
  const contextAt = source.indexOf('id="inbox-email-create-draft-context"');
  const createAt = source.indexOf('id="btn-email-create-draft"');
  const approveAt = source.indexOf('id="btn-email-approve-send"');
  const barAt = source.lastIndexOf('inbox-email-create-draft-bar', contextAt);
  const areaAt = source.lastIndexOf('inbox-email-create-draft-context-area', contextAt);
  const windowSrc = contextAt >= 0 ? source.slice(Math.max(0, contextAt - 700), createAt + 400) : '';
  const fn = createDraftFn(source);
  const contextTag = source.slice(Math.max(0, contextAt - 180), contextAt + 160);
  ok(label + ': context left of Create Draft left of Approve & send',
    contextAt > 0 && createAt > contextAt && approveAt > createAt);
  ok(label + ': two-row textarea, not a squeezed text input or chip',
    /<textarea\b/.test(contextTag)
    && /rows="2"/.test(contextTag)
    && !/<input type="text" id="inbox-email-create-draft-context"/.test(source));
  ok(label + ': context lives in its own wider area, not the button row',
    barAt >= 0 && areaAt >= 0 && areaAt < contextAt && contextAt < createAt
    && /inbox-email-create-draft-context-area[\s\S]*id="inbox-email-create-draft-context"[\s\S]*draft-actions/.test(windowSrc)
    && !/draft-actions[\s\S]*id="inbox-email-create-draft-context"/.test(windowSrc));
  ok(label + ': Create Draft label present', source.includes('>Create Draft</button>'));
  ok(label + ': no booking chip substitution for the context field',
    !/ask them to create a new booking/i.test(windowSrc)
    && !/#inbox-email-create-draft-context\{[^}]*display:none/.test(source));
  ok(label + ': posts create-draft, not approve/send/generate',
    fn.includes("fetch('/staff/inbox/email/create-draft'")
    && !fn.includes("fetch('/staff/inbox/email/approve-send'")
    && !fn.includes("fetch('/staff/inbox/email/generate-luna-draft'")
    && !fn.includes("fetch('/staff/inbox/email/draft'"));
  ok(label + ': inFlight lock on Create Draft',
    fn.includes('st.locked || st.inFlight')
    && fn.includes('st.inFlight = true')
    && fn.includes('Creating draft'));
  ok(label + ': success DTO has no approval_id',
    source.includes("EMAIL_CREATE_DRAFT_OK_KEYS = ['success','conversation_id','message_text']")
    && source.includes('function acceptEmailCreateDraftSuccess')
    && fn.includes('st.approvalId = null'));
  ok(label + ': Approve & send owner unchanged',
    source.includes("fetch('/staff/inbox/email/approve-send'")
    && source.includes('function performEmailApproveSend')
    && source.includes('id="btn-email-approve-send"'));
  ok(label + ': generate-on-open button stays hidden',
    source.includes('id="btn-email-generate-luna-draft" hidden'));
}

function focusedPanelHtml() {
  const thread = fs.readFileSync(THREAD, 'utf8');
  const start = thread.indexOf('var EMAIL_DRAFT_MAX_UTF8_BYTES');
  const end = thread.indexOf('function wireInboxSendReply');
  if (start < 0 || end <= start) throw new Error('email reply owner slice missing');
  const slice = thread.slice(start, end);
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
.inbox-email-create-draft-bar{display:flex;align-items:flex-end;gap:12px;margin-top:10px;width:100%;box-sizing:border-box}
.inbox-email-create-draft-context-area{flex:1 1 320px;min-width:240px;max-width:none}
.inbox-email-create-draft-context{display:block;width:100%;min-height:calc(2em * 1.45 + 16px);line-height:1.45;box-sizing:border-box;padding:8px 10px;resize:vertical}
.draft-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex:0 0 auto;flex-wrap:nowrap;margin-top:0}
.btn-email-create-draft,.btn-email-approve-send{min-height:44px;padding:10px 16px}
#btn-email-save-draft{display:none!important}
</style></head><body>
<div class="draft-panel" id="panel">
<textarea id="draft-textarea"></textarea>
<div id="email-draft-byte-count"></div>
<div class="inbox-email-create-draft-bar">
<div class="inbox-email-create-draft-context-area">
<label class="inbox-email-create-draft-context-label" for="inbox-email-create-draft-context">Context</label>
<textarea id="inbox-email-create-draft-context" class="inbox-email-create-draft-context" rows="2" maxlength="500" placeholder="Context (optional)" aria-label="Draft context"></textarea>
</div>
<div class="draft-actions">
<button type="button" class="btn-email-save-draft" id="btn-email-save-draft" hidden>Save draft</button>
<button type="button" class="btn-email-create-draft" id="btn-email-create-draft">Create Draft</button>
<button type="button" class="btn-email-approve-send" id="btn-email-approve-send">Approve &amp; send</button>
</div>
</div>
<div id="draft-send-status" class="draft-send-status" role="status" aria-live="polite"></div>
</div>
<script>
var selectedConvId = ${JSON.stringify(EMAIL_CONV)};
function showDraftSendStatus(el, kind, message){
  if (!el) return;
  el.className = 'draft-send-status is-visible ' + (kind || '');
  el.textContent = message || '';
}
${slice}
wireInboxEmailReply(${JSON.stringify(EMAIL_CONV)}, document.getElementById('panel'));
</script></body></html>`;
}

async function main() {
  console.log('verify:inbox-email-create-draft-ui — cooked Create Draft placement/behavior\n');
  const thread = fs.readFileSync(THREAD, 'utf8');
  assertSourcePlacement(thread, 'inbox-thread.js');
  const cooked = readStaffPortalUiSource();
  assertSourcePlacement(cooked, 'cooked /staff/ui source');
  const htmlOn = buildHtmlArtifact(true, true);
  ok('cooked artifact includes Create Draft controls',
    htmlOn.includes('id="inbox-email-create-draft-context"')
    && htmlOn.includes('id="btn-email-create-draft"')
    && htmlOn.includes('Create Draft')
    && htmlOn.includes('/staff/inbox/email/create-draft'));
  ok('cooked CSS does not squeeze context into a chip-width input',
    !/\.inbox-email-create-draft-context\{[^}]*max-width:240px/.test(htmlOn)
    && htmlOn.includes('inbox-email-create-draft-context-area'));
  ok('Create Draft is not display:none',
    !htmlOn.includes('#btn-email-create-draft{display:none!important}'));

  const pageHtml = focusedPanelHtml();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pageHtml);
  });
  const base = await listen(server);
  let browser;
  try { browser = await launchBrowser(); }
  catch (e) {
    console.error('\nBROWSER BLOCKER:', e.message);
    try { await closeS(server); } catch (_) { /* */ }
    console.error(`\n── verify:inbox-email-create-draft-ui FAILED early (${pass} pass, browser unavailable) ──`);
    process.exit(2);
  }

  const createPosts = [];
  const draftPosts = [];
  const approvePosts = [];
  const generatePosts = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.route('**/staff/inbox/email/create-draft', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    createPosts.push({ body: { ...body } });
    await new Promise((r) => setTimeout(r, 80));
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        success: true, conversation_id: body.conversation_id,
        message_text: 'Standing draft regenerated from thread plus context.',
      }),
    });
  });
  await page.route('**/staff/inbox/email/draft', async (route) => {
    draftPosts.push(JSON.parse(route.request().postData() || '{}'));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });
  await page.route('**/staff/inbox/email/approve-send', async (route) => {
    approvePosts.push(JSON.parse(route.request().postData() || '{}'));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });
  await page.route('**/staff/inbox/email/generate-luna-draft', async (route) => {
    generatePosts.push(JSON.parse(route.request().postData() || '{}'));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });

  try {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#btn-email-create-draft', { timeout: 5000 });
    const order = await page.evaluate(() => {
      const contextEl = document.querySelector('#inbox-email-create-draft-context');
      const createEl = document.querySelector('#btn-email-create-draft');
      const approveEl = document.querySelector('#btn-email-approve-send');
      const area = document.querySelector('.inbox-email-create-draft-context-area');
      const actions = document.querySelector('.draft-actions');
      const bar = document.querySelector('.inbox-email-create-draft-bar');
      if (!contextEl || !createEl || !approveEl || !area || !actions || !bar) return null;
      const cr = contextEl.getBoundingClientRect();
      const createR = createEl.getBoundingClientRect();
      const ar = approveEl.getBoundingClientRect();
      const areaR = area.getBoundingClientRect();
      const actionsR = actions.getBoundingClientRect();
      const style = window.getComputedStyle(contextEl);
      const lineHeight = parseFloat(style.lineHeight) || 18;
      return {
        tag: contextEl.tagName,
        rows: contextEl.rows,
        type: contextEl.getAttribute('type'),
        parentIsActions: contextEl.parentElement === actions,
        areaContainsContext: area.contains(contextEl),
        actionsContainContext: actions.contains(contextEl),
        contextVisible: !!(contextEl.offsetWidth || contextEl.getClientRects().length),
        createVisible: !!(createEl.offsetWidth || createEl.getClientRects().length),
        approveVisible: !!(approveEl.offsetWidth || approveEl.getClientRects().length),
        contextLeftOfCreate: cr.left < createR.left,
        createNextToApprove: createR.left < ar.left && Math.abs(createR.top - ar.top) < 24,
        areaLeftOfActions: areaR.left < actionsR.left,
        areaWidth: areaR.width,
        contextWidth: cr.width,
        contextHeight: cr.height,
        minTwoRows: cr.height >= (lineHeight * 2) - 2,
        bookingChipInBar: !!bar.querySelector(
          'button:not(#btn-email-create-draft):not(#btn-email-approve-send):not(#btn-email-save-draft):not(#btn-email-generate-luna-draft)',
        ),
      };
    });
    ok('live failure: context is a usable two-row textarea, not a chip/button',
      order && order.tag === 'TEXTAREA' && order.rows === 2 && order.type !== 'text'
      && order.areaContainsContext && !order.parentIsActions && !order.actionsContainContext);
    ok('context area is wider than the old 240px chip and left of the actions',
      order && order.areaWidth > 240 && order.contextWidth > 240
      && order.areaLeftOfActions && order.minTwoRows);
    ok('context field and Create Draft visible next to Approve & send',
      order && order.contextVisible && order.createVisible && order.approveVisible
      && order.contextLeftOfCreate && order.createNextToApprove);
    ok('no booking chip substitutes for the context field',
      order && order.bookingChipInBar === false);
    await page.fill('#inbox-email-create-draft-context', 'Mention the loft.\nAsk about the beds.');
    const pendingClick = page.locator('#btn-email-create-draft').dispatchEvent('click');
    await page.waitForFunction(() => document.querySelector('#btn-email-create-draft')?.disabled === true, null, { timeout: 5000 });
    await page.locator('#btn-email-create-draft').dispatchEvent('click');
    await pendingClick;
    await page.waitForFunction(() => /Draft created/i.test(document.querySelector('#draft-send-status')?.textContent || ''), null, { timeout: 5000 });
    ok('one explicit click produces pending then success', createPosts.length === 1);
    ok('duplicate in-flight click does not post twice', createPosts.length === 1);
    ok('Create Draft does not approve, save-approval, or generate-luna',
      approvePosts.length === 0 && draftPosts.length === 0 && generatePosts.length === 0);
    ok('posted two-line context reaches the server',
      createPosts[0].body.conversation_id === EMAIL_CONV
      && createPosts[0].body.context === 'Mention the loft.\nAsk about the beds.');
    const body = await page.locator('#draft-textarea').inputValue();
    ok('standing draft textarea replaced from create-draft response',
      body === 'Standing draft regenerated from thread plus context.');
  } finally {
    await browser.close().catch(() => {});
    try { await closeS(server); } catch (_) { /* */ }
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok('npm script registered', pkg.scripts['verify:inbox-email-create-draft-ui'] === 'node scripts/verify-inbox-email-create-draft-ui.js');
  console.log(`\nverify-inbox-email-create-draft-ui: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
