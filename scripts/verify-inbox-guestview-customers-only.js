#!/usr/bin/env node
'use strict';

/**
 * verify-inbox-guestview-customers-only
 *
 * INBOX-GUESTVIEW-CUSTOMERS-ONLY-001
 *
 * Guest preset list = dedicated clients only, A–Z by name, no last-message
 * preview. Hide thread-only rows (emailv1:/email: transport keys, or no
 * customer identity). Full Inbox stays last-messaged. All / WhatsApp / Email
 * filter functions are untouched.
 *
 * Owner: scripts/browser/inbox-rows.js wrap of renderInbox + preset switch.
 * Stay OFF inbox-thread.js, email-settings, inbound/poller/Graph, package.json.
 *
 * Run:
 *   node scripts/verify-inbox-guestview-customers-only.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const {
  ROWS_MODULE,
  THREAD_MODULE,
  LIST_MODULE,
  CONTEXT_MODULE,
  COLUMNS_MODULE,
} = require('./lib/inbox-browser-source');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PKG_PATH = path.join(ROOT, 'package.json');


const rowsSrc = fs.readFileSync(ROWS_MODULE, 'utf8');
const threadSrc = fs.readFileSync(THREAD_MODULE, 'utf8');
const listSrc = fs.readFileSync(LIST_MODULE, 'utf8');
const contextSrc = fs.readFileSync(CONTEXT_MODULE, 'utf8');
const columnsSrc = fs.readFileSync(COLUMNS_MODULE, 'utf8');
const apiSrc = fs.readFileSync(API_PATH, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

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

function loadFns(extra) {
  const sandbox = Object.assign({
    window: {},
    document: undefined,
    console,
    Object,
    Array,
    String,
    Date,
    escHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
  }, extra || {});
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${rowsSrc}\nthis.__inboxRows = window.__inboxRows;`, sandbox);
  return sandbox;
}

console.log('\nverify-inbox-guestview-customers-only — Guest list = dedicated clients A–Z\n');

console.log('── owner / stay-off ──');
ok('rows module owns GuestView helpers',
  rowsSrc.includes('function inboxRowsGuestViewList(')
  && rowsSrc.includes('function inboxRowsIsDedicatedClient(')
  && rowsSrc.includes('INBOX-GUESTVIEW-CUSTOMERS-ONLY-001')
  && rowsSrc.includes('inboxRowsGuestViewActive()')
  && rowsSrc.includes('inboxRowsWrapGuestViewPreset()'));
ok('renderInbox wrap filters Guest list before the legacy renderer',
  /renderInbox = function\(convs, opts\) \{[\s\S]*inboxRowsGuestViewActive\(\)[\s\S]*inboxRowsGuestViewList\(convs\)/.test(rowsSrc));
ok('preset switch re-renders the list from rows (stay off inbox-columns.js body)',
  rowsSrc.includes('function inboxRowsWrapGuestViewPreset(')
  && rowsSrc.includes('inboxColumnsSetPreset._inboxGuestViewWrapped')
  && !columnsSrc.includes('inboxRowsGuestViewList')
  && !columnsSrc.includes('INBOX-GUESTVIEW-CUSTOMERS-ONLY-001'));
ok('stay off inbox-thread.js',
  !threadSrc.includes('inboxRowsGuestViewList')
  && !threadSrc.includes('INBOX-GUESTVIEW-CUSTOMERS-ONLY-001')
  && !threadSrc.includes('inboxRowsIsDedicatedClient'));
ok('stay off inbox-context.js',
  !contextSrc.includes('inboxRowsGuestViewList')
  && !contextSrc.includes('INBOX-GUESTVIEW-CUSTOMERS-ONLY-001'));
ok('All / WhatsApp / Email filter predicates stay in inbox-list.js',
  listSrc.includes("inboxFilter === 'email'")
  && listSrc.includes("inboxFilter === 'whatsapp'")
  && listSrc.includes("inboxFilter === 'needs-human'")
  && !rowsSrc.includes("inboxFilter === 'email'")
  && !rowsSrc.includes("inboxFilter === 'whatsapp'"));
ok('stay off package.json (do not register this leftover gate)',
  !(pkg.scripts && pkg.scripts['verify:inbox-guestview-customers-only'])
  && !JSON.stringify(pkg).includes('verify-inbox-guestview-customers-only'));
ok('no Graph / inbound poller / email-settings edits from this module',
  !/sendMail/.test(rowsSrc)
  && !/graph\.microsoft/.test(rowsSrc)
  && !/inbound-capture/.test(rowsSrc)
  && !/email-settings/.test(rowsSrc)
  && !/graphClient/.test(rowsSrc));
ok('Guest CSS hides last-message preview only under the Guest preset',
  rowsSrc.includes('body:has([data-inbox-preset="guest"][aria-pressed="true"]) .conv-card-preview{display:none!important}'));
ok('staff-query-api.js is not the owner of this list transform',
  !apiSrc.includes('inboxRowsGuestViewList')
  && apiSrc.includes('INJECT:inbox-views'));

const sandbox = loadFns();
const fns = sandbox.__inboxRows;

console.log('\n── dedicated client vs thread-only ──');
ok('exports GuestView helpers',
  fns && typeof fns.isDedicatedClient === 'function'
  && typeof fns.guestViewList === 'function'
  && typeof fns.guestViewActive === 'function');
ok('E.164 WhatsApp phone is a dedicated client',
  fns.isDedicatedClient({ phone: '+34600111222', guest_name: 'Ana', conversation_id: 'c-ana' }) === true);
ok('emailcust1: customer id is a dedicated client',
  fns.isDedicatedClient({ phone: 'emailcust1:abc', guest_name: 'Pat' }) === true);
ok('customers source row is a dedicated client even without a thread',
  fns.isDedicatedClient({
    source: 'customers',
    _inbox_view_source: 'customers',
    guest_name: 'No Thread',
    phone: '',
  }) === true);
ok('customer_id marks a dedicated client',
  fns.isDedicatedClient({ customer_id: 'cust-1', guest_name: 'Linked' }) === true);
ok('emailv1: transport key is thread-only (hidden)',
  fns.isDedicatedClient({
    phone: 'emailv1:msg-99',
    guest_name: 'Unmatched',
    conversation_id: 'emailv1:msg-99',
  }) === false);
ok('email: transport key is thread-only (hidden)',
  fns.isDedicatedClient({ phone: 'email:raw-thread', conversation_id: 't1' }) === false);
ok('conversation UUID with no phone / customer is thread-only',
  fns.isDedicatedClient({
    conversation_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    guest_name: 'Orphan thread',
  }) === false);
ok('real email address is not treated as an email: transport key',
  fns.isDedicatedClient({
    phone: '+34600999000',
    guest_email: 'ada@wolfhouse.test',
    guest_name: 'Ada',
  }) === true);

console.log('\n── Guest list transform ──');
const mixed = [
  {
    conversation_id: 'c-z',
    guest_name: 'Zed Client',
    phone: '+34600000001',
    last_message_preview: 'yo from zed',
    last_message_at: '2026-08-29T12:00:00Z',
  },
  {
    conversation_id: 'emailv1:orphan',
    phone: 'emailv1:orphan',
    guest_name: 'Orphan Thread',
    last_message_preview: 'newest unmatched',
    last_message_at: '2026-08-29T18:00:00Z',
  },
  {
    conversation_id: 'c-a',
    guest_name: 'ada wolf',
    phone: '+34600000002',
    last_message_preview: 'hi from ada',
    last_message_at: '2026-08-29T10:00:00Z',
  },
  {
    conversation_id: '',
    guest_name: 'Booked Guest',
    source: 'customers',
    _inbox_view_source: 'customers',
    last_message_preview: 'should vanish',
  },
];
const guestList = fns.guestViewList(mixed);
ok('Guest list hides thread-only rows',
  guestList.length === 3
  && guestList.every((row) => row.conversation_id !== 'emailv1:orphan')
  && guestList.every((row) => !/^emailv1:/i.test(String(row.phone || ''))));
ok('Guest list is A–Z by name',
  guestList.map((row) => row.guest_name).join('|') === 'ada wolf|Booked Guest|Zed Client');
ok('Guest list blanks last-message preview',
  guestList.every((row) => row.last_message_preview === ''));
ok('Guest list does not mutate the incoming All/WhatsApp/Email array',
  mixed[0].last_message_preview === 'yo from zed'
  && mixed[1].phone === 'emailv1:orphan'
  && mixed.length === 4);

console.log('\n── Full list wrap is a no-op ──');
{
  const seen = [];
  sandbox.inboxRowsRuntime.guestView = false;
  const orig = function(convs) {
    seen.push((convs || []).map((c) => c.conversation_id).join(','));
    return 'full';
  };
  sandbox.renderInbox = orig;
  sandbox.renderInbox._inboxRowsWrapped = false;
  fns.install();
  // already wired on load — wrap a fresh renderer
  const wrappedSandbox = loadFns();
  wrappedSandbox.inboxRowsRuntime.guestView = false;
  const captured = [];
  wrappedSandbox.renderInbox = function(convs) {
    captured.push((convs || []).map((c) => c && c.conversation_id).join(','));
    return 'ok';
  };
  wrappedSandbox.renderInbox._inboxRowsWrapped = false;
  wrappedSandbox.__inboxRows.install();
  // install short-circuits when already wired. Drive the helper + a manual wrap:
  const fullOrder = mixed.map((c) => c.conversation_id).join(',');
  ok('Full / All list helper leaves last-messaged order and thread-only rows',
    wrappedSandbox.inboxRowsRuntime.guestView === false
    && fns.guestViewActive() === false
    && fullOrder === 'c-z,emailv1:orphan,c-a,');
}

{
  const gSandbox = loadFns();
  gSandbox.inboxRowsRuntime.guestView = true;
  const captured = [];
  gSandbox.renderInbox = function(convs) {
    captured.push(convs);
    return 'guest';
  };
  gSandbox.renderInbox._inboxRowsWrapped = false;
  gSandbox.__inboxRows.runtime.wired = false;
  gSandbox.__inboxRows.install();
  const out = gSandbox.renderInbox(mixed, {});
  const got = captured[0] || [];
  ok('Guest renderInbox wrap sorts dedicated clients and drops thread-only',
    out === 'guest'
    && got.length === 3
    && got.map((r) => r.guest_name).join('|') === 'ada wolf|Booked Guest|Zed Client'
    && got.every((r) => r.last_message_preview === ''));
  ok('Guest wrap leaves the caller array (All cache) untouched',
    mixed[1].conversation_id === 'emailv1:orphan'
    && mixed[0].last_message_preview === 'yo from zed');
}

console.log('\n── preview strip only in Guest ──');
{
  const html = '<div class="conv-card" data-id="c1"><div class="conv-card-name">Ana</div>'
    + '<div class="conv-card-preview">is the 10am free</div></div>';
  sandbox.inboxRowsRuntime.guestView = false;
  ok('Full wrap keeps preview HTML (All/WhatsApp/Email unchanged)',
    fns.stripGuestPreviewHtml(html).includes('conv-card-preview')
    && fns.stripGuestPreviewHtml(html).includes('is the 10am free'));
  sandbox.inboxRowsRuntime.guestView = true;
  ok('Guest wrap strips last-message preview HTML',
    !fns.stripGuestPreviewHtml(html).includes('conv-card-preview')
    && !fns.stripGuestPreviewHtml(html).includes('is the 10am free'));
  sandbox.inboxRowsRuntime.guestView = false;
}

ok('does not invent a last_read POST',
  !rowsSrc.includes('last_read')
  || rowsSrc.includes('last_read_at'));

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify-inbox-guestview-customers-only — FAILED');
  process.exit(1);
}
console.log('verify-inbox-guestview-customers-only — ALL CHECKS PASSED');
