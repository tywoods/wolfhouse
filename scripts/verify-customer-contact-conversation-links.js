'use strict';

/**
 * Customer contact → channel conversation links (behavioral).
 *
 * Proves phone opens WhatsApp, email opens email, missing channel offers Start
 * conversation (no auto create/send), keyboard activation works.
 *
 * Usage: node scripts/verify-customer-contact-conversation-links.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts/staff-query-api.js');
const QUERIES = path.join(ROOT, 'scripts/lib/staff-customer-queries.js');
const ROUTES = path.join(ROOT, 'scripts/lib/staff-customers-routes.js');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(t) { console.log(`\n[cust-contact-conv] ${t}`); }

function testStatic() {
  section('1. Source ownership');
  const api = fs.readFileSync(API, 'utf8');
  const q = fs.readFileSync(QUERIES, 'utf8');
  const r = fs.readFileSync(ROUTES, 'utf8');

  ok('channel conversations SQL helper', /function getCustomerChannelConversationsQuery/.test(q));
  ok('location-aware lookup builder', /function buildCustomerChannelConversationsLookup/.test(q));
  ok('routes use location-aware lookup', /buildCustomerChannelConversationsLookup/.test(r));
  ok('routes expose channel_conversations', /channel_conversations/.test(r));
  ok('UI contact open control', /function customerContactOpenControlHtml/.test(api));
  ok('UI channel open handler', /function customerOpenChannelContact/.test(api));
  ok('phone field uses contact open control', /customerContactOpenControlHtml\('whatsapp'/.test(api));
  ok('email field uses contact open control', /customerContactOpenControlHtml\('email'/.test(api));
  ok('contact click never POSTs create-conversation', (() => {
    const fn = api.slice(api.indexOf('function customerOpenChannelContact'));
    const body = fn.slice(0, fn.indexOf('function customerOpenOrStartConversation'));
    return !/create-conversation/.test(body) && !/method:\s*'POST'/.test(body);
  })());
  ok('missing channel focuses Start conversation',
    /cust-conversation-btn/.test(api) && /noneWhatsapp|noneEmail/.test(api));
  ok('detail fetch sends Sunset location',
    /location=/.test(api) && /getSunsetLocation/.test(api));
}

function testLocationLookupBehavior() {
  section('1b. Sunset location-scoped lookup (handler/query behavioral)');
  const {
    getCustomerChannelConversationsQuery,
    buildCustomerChannelConversationsLookup,
  } = require(path.join(ROOT, 'scripts/lib/staff-customer-queries.js'));

  const unscoped = getCustomerChannelConversationsQuery({ locationScoped: false });
  const scoped = getCustomerChannelConversationsQuery({ locationScoped: true });
  ok('unscoped SQL has no location $4 match',
    !/metadata->>'location_id'/.test(unscoped) || !/\$4/.test(unscoped));
  ok('scoped SQL uses canonical conversation location match ($4)',
    /metadata->>'location_id'/.test(scoped) && /\$4/.test(scoped));

  const somo = buildCustomerChannelConversationsLookup(
    'sunset', '+34600111222', 'guest@example.com', 'sunset-somo',
  );
  const sardi = buildCustomerChannelConversationsLookup(
    'sunset', '+34600111222', 'guest@example.com', 'sunset-sardinero',
  );
  const wh = buildCustomerChannelConversationsLookup(
    'wolfhouse-somo', '+34600111222', 'guest@example.com', 'sunset-somo',
  );

  ok('Sunset Somo lookup is locationScoped + locationId somo',
    somo.locationScoped === true && somo.locationId === 'sunset-somo' && somo.params[3] === 'sunset-somo');
  ok('Sunset elSardi lookup params location sardinero',
    sardi.locationScoped === true && sardi.locationId === 'sunset-sardinero' && sardi.params[3] === 'sunset-sardinero');
  ok('non-Sunset ignores location (3 params only)',
    wh.locationScoped === false && wh.locationId === null && wh.params.length === 3);

  // Fake PG: same phone has different WA ids per school — lookup must pass location into SQL params
  const SOMO_WA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const SARDI_WA = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const SOMO_EM = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const SARDI_EM = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

  function fakePgForSchool(activeLocation) {
    return {
      query(sql, params) {
        const loc = params && params[3];
        // Fail closed if Sunset scoped query lacks location param
        if (/metadata->>'location_id'/.test(sql) && !loc) {
          return Promise.resolve({ rows: [{ whatsapp_conversation_id: null, email_conversation_id: null }] });
        }
        if (loc === 'sunset-somo') {
          return Promise.resolve({
            rows: [{ whatsapp_conversation_id: SOMO_WA, email_conversation_id: SOMO_EM }],
          });
        }
        if (loc === 'sunset-sardinero') {
          return Promise.resolve({
            rows: [{ whatsapp_conversation_id: SARDI_WA, email_conversation_id: SARDI_EM }],
          });
        }
        // non-sunset path
        return Promise.resolve({
          rows: [{ whatsapp_conversation_id: SOMO_WA, email_conversation_id: null }],
        });
      },
    };
  }

  async function runLookup(client, location) {
    const built = buildCustomerChannelConversationsLookup(
      client, '+34600111222', 'guest@example.com', location,
    );
    if (built.reject) {
      return { built, row: built.empty };
    }
    const pg = fakePgForSchool(location);
    const row = (await pg.query(built.sql, built.params)).rows[0];
    return { built, row };
  }

  return Promise.all([
    runLookup('sunset', 'sunset-somo'),
    runLookup('sunset', 'sunset-sardinero'),
    runLookup('sunset', 'not-a-school'), // fail-closed reject
    runLookup('sunset', null), // missing → fail-closed
    runLookup('sunset', ''), // empty → fail-closed
    runLookup('wolfhouse-somo', null),
  ]).then(([a, b, c, d, e, f]) => {
    ok('Somo active school returns Somo WA/email only',
      a.row.whatsapp_conversation_id === SOMO_WA && a.row.email_conversation_id === SOMO_EM);
    ok('elSardi active school returns elSardi WA/email only',
      b.row.whatsapp_conversation_id === SARDI_WA && b.row.email_conversation_id === SARDI_EM);
    ok('Somo ids differ from elSardi ids (no cross-school leak)',
      a.row.whatsapp_conversation_id !== b.row.whatsapp_conversation_id
      && a.row.email_conversation_id !== b.row.email_conversation_id);
    ok('invalid Sunset location fail-closed (reject, null ids, no query)',
      c.built.reject === true
      && c.built.sql === null
      && c.row.whatsapp_conversation_id == null
      && c.row.email_conversation_id == null);
    ok('missing Sunset location fail-closed (null ids)',
      d.built.reject === true
      && d.row.whatsapp_conversation_id == null
      && d.row.email_conversation_id == null);
    ok('empty Sunset location fail-closed (null ids)',
      e.built.reject === true
      && e.row.whatsapp_conversation_id == null
      && e.row.email_conversation_id == null);
    ok('non-Sunset lookup does not require location param',
      f.built.params && f.built.params.length === 3 && f.row.whatsapp_conversation_id === SOMO_WA);
  });
}

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`missing ${name}`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

function buildHtml() {
  const api = fs.readFileSync(API, 'utf8');
  // Minimal helpers used by contact open path
  const helpers = `
function escHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');}
function portalT(k){return k;}
function el(id){return document.getElementById(id);}
var customerDetailState = { data: null, phone: null };
var selectedConvId = null;
var openLog = [];
var createPostCount = 0;
function switchToTab(){ /* no-op in fixture */ }
function openInboxToConversation(convId){
  selectedConvId = convId;
  openLog.push({ type: 'open', convId: String(convId) });
  var d = document.getElementById('opened');
  if (d) d.textContent = String(convId);
}
function customerResolveConversationId(data) {
  if (!data) return null;
  var id = data.identity && data.identity.conversation_id;
  if (id) return id;
  var cs = data.conversation_summary;
  return cs && cs.conversation_id ? cs.conversation_id : null;
}
${extractFn(api, 'customerResolveChannelConversationId')}
${extractFn(api, 'customerContactOpenControlHtml')}
${extractFn(api, 'customerOpenChannelContact')}
function renderProfile(data){
  customerDetailState.data = data;
  customerDetailState.phone = data.phone;
  var id = data.identity || {};
  var root = document.getElementById('cust-profile-section');
  root.innerHTML =
    '<div class=\"customers-profile-fields\">' +
    '<div class=\"customers-profile-field\"><span>Phone</span>' +
      customerContactOpenControlHtml('whatsapp', data.phone || '', customerResolveChannelConversationId(data, 'whatsapp')) +
    '</div>' +
    '<div class=\"customers-profile-field\"><span>Email</span>' +
      customerContactOpenControlHtml('email', id.email || '', customerResolveChannelConversationId(data, 'email')) +
    '</div></div>' +
    '<button type=\"button\" id=\"cust-conversation-btn\">Start conversation</button>' +
    '<p id=\"cust-profile-msg\" class=\"state-msg\" style=\"display:none\"></p>';
  root.querySelectorAll('[data-cust-open-channel]').forEach(function(btn){
    btn.addEventListener('click', function(){
      customerOpenChannelContact(btn.getAttribute('data-cust-open-channel') || 'whatsapp', btn.getAttribute('data-conversation-id') || '');
    });
  });
  document.getElementById('cust-conversation-btn').addEventListener('click', function(){
    openLog.push({ type: 'start-clicked' });
  });
}
window.__render = renderProfile;
window.__openLog = function(){ return openLog.slice(); };
window.__resetLog = function(){ openLog = []; selectedConvId = null; createPostCount = 0; };
window.__createPosts = function(){ return createPostCount; };
// Guard: intercept fetch create-conversation
window.fetch = function(url, opts){
  if (String(url).indexOf('create-conversation') >= 0) {
    createPostCount += 1;
    return Promise.resolve({ ok: true, json: function(){ return Promise.resolve({ success: true, conversation_id: 'created' }); } });
  }
  return Promise.reject(new Error('unexpected fetch ' + url));
};
`;

  return `<!doctype html><html><body>
<div id="cust-profile-section"></div>
<div id="opened"></div>
<script>${helpers}</script>
</body></html>`;
}

async function testBrowser() {
  section('2. Browser behavioral');
  let playwright;
  try { playwright = require('playwright'); } catch (e) {
    ok('playwright', false, e.message); return;
  }
  const html = buildHtml();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (e) {
    ok('chromium', false, e.message);
    await new Promise((r) => server.close(r));
    return;
  }

  const WA = '11111111-1111-1111-1111-111111111111';
  const EM = '22222222-2222-2222-2222-222222222222';
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ WA, EM }) => {
      window.__render({
        phone: '+34600111222',
        identity: { email: 'guest@example.com', display_name: 'Guest' },
        channel_conversations: {
          whatsapp_conversation_id: WA,
          email_conversation_id: EM,
        },
      });
    }, { WA, EM });

    await page.click('[data-cust-open-channel="whatsapp"]');
    let log = await page.evaluate(() => window.__openLog());
    ok('phone click opens WhatsApp conversation id',
      log.length === 1 && log[0].type === 'open' && log[0].convId === WA,
      JSON.stringify(log));
    ok('opened marker is WA id',
      (await page.textContent('#opened')) === WA);

    await page.evaluate(() => window.__resetLog());
    await page.click('[data-cust-open-channel="email"]');
    log = await page.evaluate(() => window.__openLog());
    ok('email click opens email conversation id',
      log.length === 1 && log[0].type === 'open' && log[0].convId === EM,
      JSON.stringify(log));

    // Keyboard activation
    await page.evaluate(() => window.__resetLog());
    await page.focus('[data-cust-open-channel="whatsapp"]');
    await page.keyboard.press('Enter');
    log = await page.evaluate(() => window.__openLog());
    ok('keyboard Enter on phone opens WA',
      log.some((x) => x.type === 'open' && x.convId === WA),
      JSON.stringify(log));

    // Missing email thread → Start offer, no create POST
    await page.evaluate(() => {
      window.__resetLog();
      window.__render({
        phone: '+34600111222',
        identity: { email: 'guest@example.com' },
        channel_conversations: {
          whatsapp_conversation_id: '11111111-1111-1111-1111-111111111111',
          email_conversation_id: null,
        },
      });
    });
    await page.click('[data-cust-open-channel="email"]');
    const missing = await page.evaluate(() => ({
      log: window.__openLog(),
      posts: window.__createPosts(),
      msg: (document.getElementById('cust-profile-msg') || {}).textContent || '',
      msgShown: (document.getElementById('cust-profile-msg') || {}).style.display !== 'none',
      focusId: document.activeElement && document.activeElement.id,
    }));
    ok('missing email does not open a conversation',
      !missing.log.some((x) => x.type === 'open'), JSON.stringify(missing.log));
    ok('missing email does not POST create-conversation', missing.posts === 0, String(missing.posts));
    ok('missing email shows offer/start status',
      missing.msgShown && /Start conversation|no email|noneEmail/i.test(missing.msg),
      missing.msg);
    ok('missing email focuses Start conversation button',
      missing.focusId === 'cust-conversation-btn', missing.focusId);

    // School-specific channel ids: Somo vs elSardi must not cross-open
    await page.evaluate(() => window.__resetLog());
    const SOMO_WA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const SARDI_WA = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    await page.evaluate((SOMO_WA) => {
      window.__render({
        phone: '+34600111222',
        identity: { email: 'guest@example.com' },
        channel_conversations: {
          whatsapp_conversation_id: SOMO_WA,
          email_conversation_id: null,
        },
        channel_location_id: 'sunset-somo',
      });
    }, SOMO_WA);
    await page.click('[data-cust-open-channel="whatsapp"]');
    log = await page.evaluate(() => window.__openLog());
    ok('UI Somo payload opens Somo WA id only',
      log.length === 1 && log[0].convId === SOMO_WA, JSON.stringify(log));

    await page.evaluate(() => window.__resetLog());
    await page.evaluate((SARDI_WA) => {
      window.__render({
        phone: '+34600111222',
        identity: { email: 'guest@example.com' },
        channel_conversations: {
          whatsapp_conversation_id: SARDI_WA,
          email_conversation_id: null,
        },
        channel_location_id: 'sunset-sardinero',
      });
    }, SARDI_WA);
    await page.click('[data-cust-open-channel="whatsapp"]');
    log = await page.evaluate(() => window.__openLog());
    ok('UI elSardi payload opens elSardi WA id only',
      log.length === 1 && log[0].convId === SARDI_WA, JSON.stringify(log));

    // Missing channel ids (e.g. fail-closed location) → Start offer, no open
    await page.evaluate(() => window.__resetLog());
    await page.evaluate(() => {
      window.__render({
        phone: '+34600111222',
        identity: { email: 'guest@example.com' },
        channel_conversations: {
          whatsapp_conversation_id: null,
          email_conversation_id: null,
        },
        channel_location_id: null,
      });
    });
    await page.click('[data-cust-open-channel="whatsapp"]');
    const failClosedUi = await page.evaluate(() => ({
      log: window.__openLog(),
      posts: window.__createPosts(),
      msgShown: (document.getElementById('cust-profile-msg') || {}).style.display !== 'none',
      focusId: document.activeElement && document.activeElement.id,
    }));
    ok('fail-closed empty ids: phone click does not open',
      !failClosedUi.log.some((x) => x.type === 'open'), JSON.stringify(failClosedUi.log));
    ok('fail-closed empty ids: no create-conversation POST', failClosedUi.posts === 0);
    ok('fail-closed empty ids: offers Start conversation',
      failClosedUi.msgShown && failClosedUi.focusId === 'cust-conversation-btn',
      failClosedUi.focusId);

    // Wrong-client safety is server-side (assertStaffClientAccess) — source gate:
    const routes = fs.readFileSync(ROUTES, 'utf8');
    const ctxStart = routes.indexOf('async function handleCustomerContext');
    const ctxChunk = ctxStart >= 0 ? routes.slice(ctxStart, ctxStart + 3500) : routes;
    ok('context handler asserts staff client access before channel lookup',
      /assertStaffClientAccess\(user, clientSlug/.test(ctxChunk)
      && ctxChunk.indexOf('assertStaffClientAccess') < ctxChunk.indexOf('buildCustomerChannelConversationsLookup'));
    ok('context handler threads query.location into channel lookup',
      /query\.location/.test(ctxChunk) && /buildCustomerChannelConversationsLookup/.test(ctxChunk));
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

async function main() {
  console.log('verify-customer-contact-conversation-links');
  testStatic();
  await testLocationLookupBehavior();
  await testBrowser();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
