'use strict';

/**
 * Email inbound → customer card (behavioral).
 *
 * RED root cause (before fix): email conversations use opaque emailv1: phone keys;
 * Open customer card digit-normalized them to +dddd… garbage with no customer upsert.
 *
 * GREEN: email inbound upserts emailcust1 customer + links customer_id; open card
 * uses by-email/by-id and never displays placeholder phone.
 */

const assert = require('assert');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const {
  normalizeCustomerPhone,
  isOpaqueEmailIdentityPhone,
  buildEmailCustomerIdentityKey,
  upsertCustomerFromEmailInboundTouch,
  upsertCustomerFromInboundTouch,
} = require('./lib/staff-customer-queries');
const bridge = require('./lib/email-inbound-inbox-bridge');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', label); }
  else { fail += 1; console.log('  FAIL ', label, detail || ''); }
}

function section(t) { console.log('\n[email-cust-card]', t); }

function testNormalizeRegression() {
  section('1. Root-cause: emailv1 must not become +digits');
  const opaque = bridge.buildEmailConversationIdentityKey('sunset-somo', 'guest@example.com');
  ok('emailv1 key built', opaque && opaque.startsWith('emailv1:'));
  const mangled = (() => {
    // Reproduce OLD client bug
    const raw = opaque;
    const digits = raw.replace(/[^\d]/g, '');
    return digits ? ('+' + digits).slice(0, 40) : '';
  })();
  ok('OLD path produces non-empty +digits garbage from emailv1',
    /^\+\d+$/.test(mangled) && mangled.length >= 2, mangled);
  ok('NEW normalizeCustomerPhone rejects emailv1',
    normalizeCustomerPhone(opaque) === '');
  ok('NEW isOpaqueEmailIdentityPhone detects emailv1',
    isOpaqueEmailIdentityPhone(opaque));
  ok('emailcust1 is opaque but distinct from emailv1',
    buildEmailCustomerIdentityKey('sunset-somo', 'guest@example.com').startsWith('emailcust1:')
    && !buildEmailCustomerIdentityKey('sunset-somo', 'guest@example.com').startsWith('emailv1:'));
}

function fakePg() {
  const state = {
    clients: { sunset: '11111111-1111-1111-1111-111111111111' },
    customers: [],
    conversations: [],
  };
  return {
    state,
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ');
      if (/SELECT id FROM clients WHERE slug/.test(s)) {
        const slug = params[0];
        const id = state.clients[slug];
        return { rows: id ? [{ id }] : [] };
      }
      if (/SELECT cu\.id::text AS customer_id, cu\.phone/.test(s) && /lower\(btrim/.test(s)) {
        const [clientId, email, loc] = params;
        const row = state.customers.find((c) =>
          c.client_id === clientId && c.email === email && c.location_id === loc);
        return { rows: row ? [{ customer_id: row.id, phone: row.phone }] : [] };
      }
      if (/INSERT INTO customers/.test(s)) {
        const [clientId, phone, name, email, loc] = params;
        let row = state.customers.find((c) => c.client_id === clientId && c.phone === phone);
        if (!row) {
          row = {
            id: crypto.randomUUID(),
            client_id: clientId,
            phone,
            full_name: name,
            email,
            location_id: loc,
          };
          state.customers.push(row);
        } else {
          row.full_name = name || row.full_name;
          row.email = email || row.email;
        }
        return { rows: [{ customer_id: row.id, phone: row.phone }] };
      }
      if (/UPDATE customers/.test(s) && /full_name = COALESCE/.test(s)) {
        const [id, name, email] = params;
        const row = state.customers.find((c) => c.id === id);
        if (row) {
          if (name) row.full_name = name;
          if (email) row.email = email;
        }
        return { rows: [] };
      }
      if (/UPDATE conversations/.test(s) && /customer_id/.test(s)) {
        const [clientId, convId, custId] = params;
        let conv = state.conversations.find((c) => c.id === convId);
        if (!conv) {
          conv = { id: convId, client_id: clientId, customer_id: custId };
          state.conversations.push(conv);
        } else {
          conv.customer_id = custId;
        }
        return { rows: [] };
      }
      if (/INSERT INTO customers/.test(s) === false && /RETURNING id::text AS customer_id`/.test(sql)) {
        // phone upsert path
      }
      if (/ON CONFLICT \(client_id, phone\)/.test(s) && params.length >= 4 && !String(params[1]).startsWith('emailcust')) {
        // WA path insert
        const [clientId, phone, name, email, loc] = params;
        let row = state.customers.find((c) => c.client_id === clientId && c.phone === phone);
        if (!row) {
          row = { id: crypto.randomUUID(), client_id: clientId, phone, full_name: name, email, location_id: loc };
          state.customers.push(row);
        }
        return { rows: [{ customer_id: row.id }] };
      }
      throw new Error('unexpected SQL: ' + s.slice(0, 120));
    },
  };
}

async function testEmailUpsert() {
  section('2. Email customer upsert + link (no placeholder phone)');
  const pg = fakePg();
  const r1 = await upsertCustomerFromEmailInboundTouch(pg, {
    client_slug: 'sunset',
    email: 'Monshies.Guest@Example.COM',
    display_name: 'Monshies Guest',
    location_id: 'sunset-somo',
    conversation_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  });
  ok('email upsert ok', r1.ok === true, r1.reason);
  ok('customer phone is emailcust1 not emailv1',
    r1.phone && r1.phone.startsWith('emailcust1:') && !r1.phone.startsWith('emailv1:'));
  ok('email normalized lower', r1.email === 'monshies.guest@example.com');
  ok('customer_id set', !!r1.customer_id);
  ok('conversation linked',
    pg.state.conversations.some((c) => c.customer_id === r1.customer_id));

  const r2 = await upsertCustomerFromEmailInboundTouch(pg, {
    client_slug: 'sunset',
    email: 'monshies.guest@example.com',
    display_name: 'Monshies Guest',
    location_id: 'sunset-somo',
    conversation_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  });
  ok('repeat email idempotent same customer', r2.ok && r2.customer_id === r1.customer_id);
  ok('only one customer row for email+school',
    pg.state.customers.filter((c) => c.email === 'monshies.guest@example.com').length === 1);

  const otherSchool = await upsertCustomerFromEmailInboundTouch(pg, {
    client_slug: 'sunset',
    email: 'monshies.guest@example.com',
    display_name: 'Monshies Guest',
    location_id: 'sunset-sardinero',
    conversation_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  });
  ok('other school gets distinct customer identity',
    otherSchool.ok && otherSchool.customer_id !== r1.customer_id
    && otherSchool.phone !== r1.phone);

  // Reject missing email
  const bad = await upsertCustomerFromEmailInboundTouch(pg, {
    client_slug: 'sunset', location_id: 'sunset-somo', email: '',
  });
  ok('missing email rejected', bad.ok === false);

  // WhatsApp path still phone-based
  const wa = await upsertCustomerFromInboundTouch(pg, {
    client_slug: 'sunset',
    phone: '+34600111222',
    display_name: 'WA Guest',
    email: null,
    location_id: 'sunset-somo',
  });
  ok('WhatsApp phone upsert still works', wa.ok === true && wa.phone === '+34600111222');
  ok('WA customer not emailcust', !String(wa.phone).startsWith('emailcust1:'));
}

function testUiSourceGuards() {
  section('3. UI source guards');
  const api = require('fs').readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  ok('openCustomerCardFromConversation present', /function openCustomerCardFromConversation/.test(api));
  ok('inbox uses FromConversation not raw phone for email',
    /openCustomerCardFromConversation\(c\)/.test(api));
  ok('normalize rejects emailv1',
    /emailv1\|email/.test(api) && /emailcust1:/.test(api));
  ok('by-email and by-id routes wired',
    /CUSTOMERS_BY_EMAIL_CONTEXT_PATH/.test(api) && /CUSTOMER_BY_ID_CONTEXT_RE/.test(api));
  ok('by-id open card URL includes active location for sunset',
    /by-id\/' \+ encodeURIComponent\(customerId\) \+ '\/context\?client=/.test(api)
    && /getClient\(\) === 'sunset' \? \('&location=' \+ encodeURIComponent\(getSunsetLocation\(\)\)\)/.test(api));
  ok('by-email open card URL includes active location for sunset',
    /by-email\/context\?email=/.test(api)
    && /getSunsetLocation\(\)/.test(api));
  ok('inbox listener binds when button exists (not gated on convPhone)', (() => {
    const i = api.indexOf("var inboxCustBtn = targetEl.querySelector('#inbox-open-customer-card')");
    if (i < 0) return false;
    const snip = api.slice(i, i + 220);
    return /if \(inboxCustBtn\) \{/.test(snip)
      && !/if \(inboxCustBtn && convPhone\)/.test(snip)
      && /openCustomerCardFromConversation\(c\)/.test(snip);
  })());
  ok('bridge calls email customer upsert',
    require('fs').readFileSync(path.join(ROOT, 'scripts/lib/email-inbound-inbox-bridge.js'), 'utf8')
      .includes('upsertCustomerFromEmailInboundTouch'));
  ok('inbox SQL selects customer_id',
    require('fs').readFileSync(path.join(ROOT, 'scripts/lib/staff-conversation-queries.js'), 'utf8')
      .includes('customer_id'));
}

async function testByIdSchoolScope() {
  section('4. by-id school scope (Somo vs elSardi)');
  const {
    buildCustomerByIdPhoneLookup,
  } = require('./lib/staff-customer-queries');

  const SOMO_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const SARDI_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  const somo = buildCustomerByIdPhoneLookup('sunset', SOMO_ID, 'sunset-somo');
  ok('somo lookup accepted', somo.reject === false && somo.params[2] === 'sunset-somo');
  ok('somo SQL filters location_id', /location_id/.test(somo.sql));

  const sardi = buildCustomerByIdPhoneLookup('sunset', SARDI_ID, 'sunset-sardinero');
  ok('sardi lookup accepted', sardi.reject === false && sardi.params[2] === 'sunset-sardinero');

  ok('missing location rejects', buildCustomerByIdPhoneLookup('sunset', SOMO_ID, null).reject === true);
  ok('empty location rejects', buildCustomerByIdPhoneLookup('sunset', SOMO_ID, '').reject === true);
  ok('invalid location rejects', buildCustomerByIdPhoneLookup('sunset', SOMO_ID, 'not-a-school').reject === true);

  // Handler-level: same client, two school customers — wrong school returns no row.
  const customers = [
    { id: SOMO_ID, slug: 'sunset', location_id: 'sunset-somo', phone: 'emailcust1:somo:aaa' },
    { id: SARDI_ID, slug: 'sunset', location_id: 'sunset-sardinero', phone: 'emailcust1:sardi:bbb' },
  ];
  async function runLookup(activeLoc, targetId) {
    const built = buildCustomerByIdPhoneLookup('sunset', targetId, activeLoc);
    if (built.reject) return { status: 404, phone: null };
    // Simulate SQL filter
    const row = customers.find((c) =>
      c.id === built.params[1]
      && c.slug === built.params[0]
      && c.location_id === built.params[2]
    );
    return row ? { status: 200, phone: row.phone } : { status: 404, phone: null };
  }

  const a = await runLookup('sunset-somo', SOMO_ID);
  const b = await runLookup('sunset-somo', SARDI_ID);
  const c = await runLookup('sunset-sardinero', SARDI_ID);
  const d = await runLookup('sunset-sardinero', SOMO_ID);
  const e = await runLookup('not-a-school', SOMO_ID);
  ok('Somo can open Somo id', a.status === 200 && a.phone.includes('somo'));
  ok('Somo cannot open elSardi id', b.status === 404);
  ok('elSardi can open elSardi id', c.status === 200 && c.phone.includes('sardi'));
  ok('elSardi cannot open Somo id', d.status === 404);
  ok('invalid location cannot open any id', e.status === 404);

  // Non-sunset unchanged (no location required)
  const wh = buildCustomerByIdPhoneLookup('wolfhouse-somo', SOMO_ID, null);
  ok('non-sunset by-id does not require location', wh.reject === false && wh.params.length === 2);
}

async function main() {
  console.log('verify-email-customer-card-from-inbound');
  testNormalizeRegression();
  await testEmailUpsert();
  testUiSourceGuards();
  await testByIdSchoolScope();
  await testBrowserOpenCustomerCardClick();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/**
 * Execution-level: emailv1 conversation → Open customer card click fires
 * by-id context with active location and installs card; WhatsApp regression.
 */
async function testBrowserOpenCustomerCardClick() {
  section('5. Browser: Open customer card click (emailv1 + WhatsApp)');
  let playwright;
  try {
    playwright = require('playwright');
  } catch (e) {
    ok('playwright available', false, e.message);
    return;
  }

  const fs = require('fs');
  const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

  function extractFn(name) {
    const re = new RegExp(`function ${name}\\s*\\(`);
    const m = re.exec(api);
    if (!m) return null;
    const start = m.index;
    let i = api.indexOf('{', start);
    let depth = 0;
    for (; i < api.length; i++) {
      if (api[i] === '{') depth++;
      else if (api[i] === '}') {
        depth--;
        if (depth === 0) return api.slice(start, i + 1);
      }
    }
    return null;
  }

  const fns = [
    'normalizeCustomerPhoneClient',
    'isEmailChannelConversationClient',
    'openCustomerCardFromConversation',
    'openCustomerCardByCustomerId',
    'openCustomerCardByEmail',
    'openCustomerCardForPhone',
  ].map(extractFn);

  ok('extracted open-card helpers from staff-query-api', fns.every(Boolean));

  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (e) {
    ok('chromium launch', false, e.message);
    return;
  }

  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body>
      <div id="cust-detail"></div>
      <input id="cust-search" />
      <div id="inbox-detail"></div>
      <script>
        window.__fetches = [];
        window.getClient = function(){ return 'sunset'; };
        window.getSunsetLocation = function(){ return 'sunset-somo'; };
        window.getPortalProfile = function(){ return { customers: true }; };
        window.portalHasCustomersCrm = function(){ return true; };
        window.switchToTab = function(){};
        window.waitForCustomersDom = function(){ return Promise.resolve(); };
        window.el = function(id){ return document.getElementById(id); };
        window.escHtml = function(s){ return String(s||''); };
        window.portalT = function(k){ return k; };
        window.getCustomersVisibleRows = function(){ return []; };
        window.renderCustomersList = function(){};
        window.renderCustomerDetail = function(data){
          window.__cardInstalled = data;
          var box = document.getElementById('cust-detail');
          if (box) box.textContent = 'CARD:' + (data.identity && data.identity.email || data.phone || '');
        };
        window.loadCustomersList = function(){ return Promise.resolve(); };
        window.loadCustomerDetail = function(phone){
          return fetch('/staff/customers/' + encodeURIComponent(phone) + '/context?client=' + encodeURIComponent(getClient()) +
            (getClient() === 'sunset' ? ('&location=' + encodeURIComponent(getSunsetLocation())) : ''))
            .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('HTTP')); })
            .then(function(data){ renderCustomerDetail(data); return data; });
        };
        window.customerDetailState = {};
        window.selectedCustomerPhone = null;
        window.fetch = function(url){
          window.__fetches.push(String(url));
          var u = String(url);
          if (u.indexOf('/staff/customers/by-id/') >= 0) {
            return Promise.resolve({
              ok: true,
              json: function(){
                return Promise.resolve({
                  success: true,
                  phone: 'emailcust1:sunset-somo:abc',
                  identity: { email: 'guest@example.com', display_name: 'Guest', phone: 'emailcust1:sunset-somo:abc' }
                });
              }
            });
          }
          if (u.indexOf('/staff/customers/') >= 0 && u.indexOf('/context') >= 0) {
            return Promise.resolve({
              ok: true,
              json: function(){
                return Promise.resolve({
                  success: true,
                  phone: '+34600111222',
                  identity: { email: null, display_name: 'WA Guest', phone: '+34600111222' }
                });
              }
            });
          }
          return Promise.resolve({ ok: false, json: function(){ return Promise.resolve({}); } });
        };
        ${fns.join('\n')}

        // Mirror loadConvDetail button + listener contract (email path).
        window.__wireInboxDetail = function(c) {
          var detail = document.getElementById('inbox-detail');
          var convPhone = normalizeCustomerPhoneClient(c.phone);
          var canOpenCust = portalHasCustomersCrm(getPortalProfile(getClient())) && (
            convPhone || isEmailChannelConversationClient(c) || c.customer_id || c.guest_email || c.email
          );
          var html = '';
          if (canOpenCust) {
            html += '<button type="button" id="inbox-open-customer-card">Open customer card</button>';
          }
          detail.innerHTML = html;
          var inboxCustBtn = detail.querySelector('#inbox-open-customer-card');
          // FIXED contract: bind whenever button exists (not gated on convPhone).
          if (inboxCustBtn) {
            inboxCustBtn.addEventListener('click', function() { openCustomerCardFromConversation(c); });
          }
          return { convPhone: convPhone, bound: !!inboxCustBtn };
        };
      </script>
    </body></html>`);

    // --- emailv1 path ---
    const emailConv = {
      channel: 'email',
      phone: 'emailv1:sunset-somo:deadbeefcafebabe0123456789abcdef0123456789abcdef0123456789abcdef',
      customer_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      guest_email: 'guest@example.com',
      guest_name: 'Guest',
    };
    const wired = await page.evaluate((c) => window.__wireInboxDetail(c), emailConv);
    ok('emailv1 convPhone empty (no digit mangle path)', wired.convPhone === '');
    ok('emailv1 Open customer card button rendered+bound', wired.bound === true);

    await page.evaluate(() => { window.__fetches = []; window.__cardInstalled = null; });
    await page.click('#inbox-open-customer-card');
    await page.waitForFunction(() => window.__cardInstalled != null, null, { timeout: 3000 });

    const emailFetch = await page.evaluate(() => window.__fetches.slice());
    const emailUrl = emailFetch.find((u) => u.includes('/staff/customers/by-id/'));
    ok('email click fires by-id context', !!emailUrl, JSON.stringify(emailFetch));
    ok('email by-id URL includes customer_id',
      emailUrl && emailUrl.includes('cccccccc-cccc-cccc-cccc-cccccccccccc'));
    ok('email by-id URL includes active location',
      emailUrl && emailUrl.includes('location=sunset-somo'));
    ok('email by-id URL includes client=sunset',
      emailUrl && emailUrl.includes('client=sunset'));
    const cardEmail = await page.evaluate(() => window.__cardInstalled && window.__cardInstalled.identity
      && window.__cardInstalled.identity.email);
    ok('email click installs customer card with email', cardEmail === 'guest@example.com');
    const cardPhone = await page.evaluate(() => window.__cardInstalled && window.__cardInstalled.phone);
    ok('email card phone is emailcust1 not +digits',
      String(cardPhone || '').startsWith('emailcust1:') && !/^\+\d+$/.test(String(cardPhone || '')));

    // --- WhatsApp regression ---
    const waConv = {
      channel: 'whatsapp',
      phone: '+34600111222',
      guest_name: 'WA Guest',
    };
    const wiredWa = await page.evaluate((c) => window.__wireInboxDetail(c), waConv);
    ok('whatsapp button bound', wiredWa.bound === true && wiredWa.convPhone === '+34600111222');
    await page.evaluate(() => { window.__fetches = []; window.__cardInstalled = null; });
    await page.click('#inbox-open-customer-card');
    await page.waitForFunction(() => window.__cardInstalled != null, null, { timeout: 3000 });
    const waFetch = await page.evaluate(() => window.__fetches.slice());
    const waUrl = waFetch.find((u) => /\/staff\/customers\//.test(u) && u.includes('/context'));
    ok('whatsapp click fires phone context',
      waUrl && waUrl.includes(encodeURIComponent('+34600111222')), JSON.stringify(waFetch));
    ok('whatsapp context includes location',
      waUrl && waUrl.includes('location=sunset-somo'));
    const waCardPhone = await page.evaluate(() => window.__cardInstalled && window.__cardInstalled.phone);
    ok('whatsapp card phone preserved', waCardPhone === '+34600111222');
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
