'use strict';

/**
 * INBOX-LINK-GUEST-001 — unmatched email thread → search / create / link guest.
 *
 * Offline gate. No database, no network, no browser.
 *
 * Proves:
 *   - email-only create uses emailcust1: identity (never fake +dddd)
 *   - conversation link writes customer_id only when unlinked (else 409)
 *   - conversation detail/inbox SQL returns customer_id + customer_phone
 *   - unmatched card offers Staff API search + create-from-email controls
 *   - stay off inbox-thread.js / email settings / inbound ingest paths
 *
 * Run:
 *   node scripts/verify-inbox-link-guest.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const contextSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-context.js'), 'utf8');
const threadSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'), 'utf8');
const custSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-customer-queries.js'), 'utf8');
const convSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-conversation-queries.js'), 'utf8');
const i18nSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const i18nEsSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const {
  normalizeCustomerPhone,
  parseManualCustomerCreateBody,
  buildEmailcustIdentityKey,
  isEmailcustIdentity,
  linkConversationCustomer,
  createOrMergeManualCustomer,
} = require('./lib/staff-customer-queries');
const {
  getConversationDetailQuery,
  getConversationInboxQuery,
} = require('./lib/staff-conversation-queries');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

console.log('\nverify:inbox-link-guest — INBOX-LINK-GUEST-001\n');

console.log('── identity + create parse ──');
{
  const email = 'tywoods@gmail.com';
  const key = buildEmailcustIdentityKey(email);
  ok('emailcust1 key prefix', /^emailcust1:[a-f0-9]{64}$/.test(key));
  ok('emailcust1 stable', buildEmailcustIdentityKey('TyWoods@Gmail.com') === key);
  ok('normalize preserves emailcust1', normalizeCustomerPhone(key) === key);
  ok('normalize does not invent +dddd from email local part',
    normalizeCustomerPhone('tywoods') === '' || !/^\+\d+$/.test(normalizeCustomerPhone('tywoods')));
  ok('isEmailcustIdentity', isEmailcustIdentity(key) && !isEmailcustIdentity('+34600111222'));

  const parsed = parseManualCustomerCreateBody({
    email,
    display_name: 'Tyler Woods',
    conversation_id: '11111111-1111-4111-8111-111111111111',
  });
  ok('email-only parse ok', parsed.ok === true);
  ok('email-only phone is emailcust1', parsed.ok && isEmailcustIdentity(parsed.value.phone));
  ok('email-only keeps conversation_id', parsed.ok && parsed.value.conversation_id);
  ok('email-only never uses +digits phone',
    parsed.ok && !/^\+\d+$/.test(parsed.value.phone));

  const wa = parseManualCustomerCreateBody({ display_name: 'Ada', phone: '+34600111222' });
  ok('whatsapp create still phone-anchored', wa.ok && wa.value.phone === '+34600111222' && !wa.value.email_only);
}

console.log('\n── conversation SQL ──');
{
  const detail = getConversationDetailQuery();
  const inbox = getConversationInboxQuery();
  ok('detail selects customer_id', /conv\.customer_id::text\s+AS customer_id/.test(detail));
  ok('detail selects customer_phone', /cust_link\.phone\s+AS customer_phone/.test(detail));
  ok('detail joins customers on customer_id',
    /LEFT JOIN customers cust_link[\s\S]*cust_link\.id = conv\.customer_id/.test(detail));
  ok('inbox selects customer_id + customer_phone',
    /AS customer_id/.test(inbox) && /AS customer_phone/.test(inbox));
}

console.log('\n── linkConversationCustomer ──');
(async () => {
  const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const CONV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const CUST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  function makePg(state) {
    return {
      async query(sql, params) {
        const s = String(sql);
        if (/FROM clients WHERE slug/.test(s)) {
          return { rows: [{ id: CLIENT }] };
        }
        if (/FROM customers/.test(s) && /id = \$2::uuid/.test(s)) {
          if (String(params[1]) !== CUST) return { rows: [] };
          return { rows: [{ customer_id: CUST, phone: 'emailcust1:abc', full_name: 'Tyler Woods', email: 'tywoods@gmail.com' }] };
        }
        if (/FROM conversations/.test(s) && /SELECT id::text AS conversation_id, customer_id/.test(s)) {
          return { rows: [{ conversation_id: CONV, customer_id: state.linked }] };
        }
        if (/UPDATE conversations/.test(s) && /customer_id IS NULL/.test(s)) {
          if (state.linked) return { rows: [] };
          state.linked = String(params[2]);
          return { rows: [{ conversation_id: CONV, customer_id: state.linked }] };
        }
        if (/SELECT customer_id::text AS customer_id/.test(s) && /FROM conversations/.test(s)) {
          return { rows: [{ customer_id: state.linked }] };
        }
        return { rows: [] };
      },
    };
  }

  const unlinked = { linked: null };
  const okLink = await linkConversationCustomer(makePg(unlinked), 'sunset', {
    conversation_id: CONV,
    customer_id: CUST,
  });
  ok('link unlinked conversation', okLink.ok && okLink.status === 200 && okLink.body.linked === true);
  ok('link wrote customer_id', unlinked.linked === CUST);

  const already = await linkConversationCustomer(makePg({ linked: OTHER }), 'sunset', {
    conversation_id: CONV,
    customer_id: CUST,
  });
  ok('already-linked different guest → 409', already.ok === false && already.status === 409);

  const same = await linkConversationCustomer(makePg({ linked: CUST }), 'sunset', {
    conversation_id: CONV,
    customer_id: CUST,
  });
  ok('already-linked same guest is idempotent', same.ok && same.status === 200);

  const created = [];
  const pgCreate = {
    async query(sql, params) {
      const s = String(sql);
      if (/FROM clients WHERE slug/.test(s)) return { rows: [{ id: CLIENT }] };
      if (/SELECT id::text AS customer_id, full_name, notes, email/.test(s)) return { rows: [] };
      if (/INSERT INTO customers/.test(s)) {
        created.push(params[1]);
        return {
          rows: [{
            customer_id: CUST,
            full_name: params[2],
            phone: params[1],
            email: params[3],
            notes: params[4],
          }],
        };
      }
      if (/FROM customers/.test(s) && /id = \$2::uuid/.test(s)) {
        return { rows: [{ customer_id: CUST, phone: created[0], full_name: 'Tyler Woods', email: 'tywoods@gmail.com' }] };
      }
      if (/FROM conversations/.test(s) && /customer_id/.test(s) && /SELECT id::text AS conversation_id/.test(s)) {
        return { rows: [{ conversation_id: CONV, customer_id: null }] };
      }
      if (/UPDATE conversations/.test(s)) {
        return { rows: [{ conversation_id: CONV, customer_id: CUST }] };
      }
      return { rows: [] };
    },
  };
  const merge = await createOrMergeManualCustomer(pgCreate, 'sunset', {
    email: 'tywoods@gmail.com',
    display_name: 'Tyler Woods',
    conversation_id: CONV,
  });
  ok('createOrMerge email-only + link', merge.ok && merge.body.linked === true);
  ok('createOrMerge seeded emailcust1 phone', isEmailcustIdentity(created[0]));

  console.log('\n── unmatched card UI ──');
  {
    const sandbox = {
      window: { addEventListener() {}, fetch() { return Promise.resolve({ ok: false, json: async () => null }); } },
      document: {
        documentElement: { dataset: {} },
        getElementById() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement() { return { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }; },
        head: { appendChild() {} },
        body: { addEventListener() {} },
        addEventListener() {},
      },
      console,
      localStorage: { getItem() { return null; }, setItem() {} },
      escHtml(s) { return String(s == null ? '' : s); },
      t: (k) => k,
      portalT: (k) => k,
      getClient: () => 'sunset',
      normalizeCustomerPhoneClient(phone) {
        const raw = String(phone || '').trim();
        if (!raw) return '';
        if (/^emailcust1:/i.test(raw)) return raw;
        if (raw.charAt(0) === '+') return raw.slice(0, 40);
        const digits = raw.replace(/[^\d]/g, '');
        return digits ? (`+${digits}`).slice(0, 40) : '';
      },
    };
    sandbox.window.document = sandbox.document;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(`${threadSrc}\n${contextSrc}\nthis.__inbox = {
      inboxCustomerUnmatchedHtml,
      inboxCustomerResolvePhone,
      inboxCustomerFromConv,
      inboxCustomerPaint,
      inboxCustomerHasBoundGuest,
    };`, sandbox);
    const chrome = sandbox.__inbox;
    const opaque = 'emailv1:sunset-somo:32cb2f9a0123456789abcdef0123456789abcdef0123456789abcdef01234567';
    const unmatched = chrome.inboxCustomerUnmatchedHtml({
      conversation_id: CONV,
      phone: opaque,
      guest_name: opaque,
      guest_email: 'tywoods@gmail.com',
    });
    ok('card says No guest yet', unmatched.includes('No guest yet'));
    ok('card has search input', unmatched.includes('id="inbox-guest-link-search"'));
    ok('card has create-from-email', unmatched.includes('id="inbox-guest-link-create"'));
    ok('card searches Staff customers', contextSrc.includes("/staff/customers'") || contextSrc.includes('/staff/customers'));
    ok('card posts create/link to /staff/customers', contextSrc.includes("'/staff/customers'") || contextSrc.includes('/staff/customers'));
    ok('resolvePhone prefers customer_phone emailcust1',
      chrome.inboxCustomerResolvePhone({ phone: opaque, customer_phone: 'emailcust1:deadbeef' }) === 'emailcust1:deadbeef');
    ok('bound customer_id keeps guest after refresh fields',
      chrome.inboxCustomerHasBoundGuest({ customer_id: CUST, phone: opaque }, null) === true);

    const leftover = {
      success: true,
      phone: '+34600111222',
      identity: { display_name: 'Wrong Guest', email: 'wrong@sunset.test' },
      bookings: [{ booking_code: 'SUNSET-WRONG' }],
    };
    const sidebar = { innerHTML: '', querySelector() { return null; }, querySelectorAll() { return []; } };
    chrome.inboxCustomerPaint(sidebar, {
      phone: opaque,
      guest_name: opaque,
      guest_email: 'tywoods@gmail.com',
    }, { bookings: [] }, leftover);
    ok('leftover WhatsApp guest does not paint on unmatched email',
      sidebar.innerHTML.includes('No guest yet') && !sidebar.innerHTML.includes('Wrong Guest'));
  }

  console.log('\n── stay off + wiring ──');
  ok('inbox-thread.js has no link-guest search UI',
    !threadSrc.includes('inbox-guest-link-search')
    && !threadSrc.includes('inbox-guest-link-create'));
  ok('context owns unmatched link UI',
    contextSrc.includes('function inboxGuestLinkWire(')
    && contextSrc.includes('data-inbox-guest-link'));
  ok('customer queries own emailcust1 + link',
    custSrc.includes('buildEmailcustIdentityKey')
    && custSrc.includes('linkConversationCustomer')
    && custSrc.includes('emailcust1:'));
  ok('conversation queries own customer_phone projection',
    convSrc.includes('customer_phone')
    && convSrc.includes('cust_link'));
  ok('i18n en keys',
    i18nSrc.includes("'inbox.guest.noGuestYet'")
    && i18nSrc.includes("'inbox.guest.createFromEmail'"));
  ok('i18n es-sunset keys',
    i18nEsSrc.includes("'inbox.guest.noGuestYet'")
    && i18nEsSrc.includes("'inbox.guest.createFromEmail'"));
  ok('package.json registers verify:inbox-link-guest',
    pkg.scripts && pkg.scripts['verify:inbox-link-guest'] === 'node scripts/verify-inbox-link-guest.js');
  ok('stay off email settings / inbound ingest files in this slice',
    !contextSrc.includes('email-inbound-inbox-bridge')
    && !contextSrc.includes('email-settings')
    && !custSrc.includes('graph')
    && !convSrc.includes('tenant_email_settings'));

  console.log(`\n${fail ? 'FAIL' : 'PASS'} verify:inbox-link-guest — ${pass} passed, ${fail} failed\n`);
  if (fail) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
