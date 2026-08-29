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
ok('Guest CSS also hides Sunset recency time/subject (surf cards omit preview)',
  rowsSrc.includes('body:has([data-inbox-preset="guest"][aria-pressed="true"]) .conv-card-time{display:none!important}')
  && rowsSrc.includes('body:has([data-inbox-preset="guest"][aria-pressed="true"]) .conv-card-subject{display:none!important}'));
ok('preset wrap latches guestView before re-render (leftover #804)',
  rowsSrc.includes('inboxRowsRuntime.guestView = nowGuest')
  && rowsSrc.includes('inboxRowsEnterGuestDirectory')
  && rowsSrc.includes("selectInboxSavedView('all_people')")
  && rowsSrc.includes('wasGuest = inboxRowsGuestViewActive()'));
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
ok('Guest list blanks last_activity_label (Sunset recency stand-in)',
  guestList.every((row) => !row.last_activity_label));
ok('Guest list does not mutate the incoming All/WhatsApp/Email array',
  mixed[0].last_message_preview === 'yo from zed'
  && mixed[1].phone === 'emailv1:orphan'
  && mixed.length === 4);

console.log('\n── Full list wrap is a no-op ──');
{
  const wrappedSandbox = loadFns();
  wrappedSandbox.inboxRowsRuntime.guestView = false;
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
    + '<div class="conv-card-preview">is the 10am free</div>'
    + '<div class="conv-card-time">2h</div>'
    + '<div class="conv-card-subject">Re: beds</div></div>';
  sandbox.inboxRowsRuntime.guestView = false;
  ok('Full wrap keeps preview HTML (All/WhatsApp/Email unchanged)',
    fns.stripGuestPreviewHtml(html).includes('conv-card-preview')
    && fns.stripGuestPreviewHtml(html).includes('is the 10am free')
    && fns.stripGuestPreviewHtml(html).includes('conv-card-time'));
  sandbox.inboxRowsRuntime.guestView = true;
  ok('Guest wrap strips last-message preview HTML',
    !fns.stripGuestPreviewHtml(html).includes('conv-card-preview')
    && !fns.stripGuestPreviewHtml(html).includes('is the 10am free'));
  ok('Guest wrap strips Sunset time/subject HTML',
    !fns.stripGuestPreviewHtml(html).includes('conv-card-time')
    && !fns.stripGuestPreviewHtml(html).includes('conv-card-subject'));
  sandbox.inboxRowsRuntime.guestView = false;
}

console.log('\n── Seadog leftover #804: all_people order is not Guest ──');
function countInversions(names) {
  let n = 0;
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      if (names[i].toLocaleLowerCase().localeCompare(names[j].toLocaleLowerCase()) > 0) n += 1;
    }
  }
  return n;
}

{
  /* BOOKED_THEN_RECENT-shaped all_people payload: 3 thread-only rows first,
   * then dedicated clients out of A–Z. Seadog: first client at position 4,
   * 15 ordering inversions on live leftover. */
  const clients = [
    'Zeta Last', 'Yuki', 'Sofia', 'Pedro', 'Nora', 'Mia', 'Luis', 'Kai',
    'Julia', 'Ines', 'Hugo', 'Gala', 'Felix', 'Elena', 'Diego', 'Carla',
    'Bruno', 'Ada First', 'Tomas', 'Rosa', 'Quim', 'Pilar', 'Oscar',
    'Nerea', 'Marcos', 'Lucia', 'Ivan',
  ];
  const bookedThenRecent = [
    {
      guest_name: 'Orphan Newest',
      phone: 'emailv1:orphan',
      conversation_id: 'emailv1:orphan',
      last_message_preview: 'unmatched',
      last_activity_label: '1m',
    },
    {
      guest_name: 'Bare Thread',
      conversation_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      last_message_preview: 'uuid thread',
      last_activity_label: '2m',
    },
    {
      guest_name: 'Mail Transport',
      phone: 'email:raw',
      conversation_id: 'email:raw',
      last_message_preview: 'transport',
      last_activity_label: '3m',
    },
  ];
  clients.forEach((name, i) => {
    bookedThenRecent.push({
      guest_name: name,
      display_name: name,
      phone: `+34600${String(100000 + i).slice(-6)}`,
      conversation_id: `cust-${i}`,
      source: 'customers',
      _inbox_view_source: 'customers',
      _inbox_view_key: `customers:${i}`,
      last_message_preview: `msg from ${name}`,
      last_activity_label: `${i}h`,
    });
  });

  const dedicatedBefore = bookedThenRecent.filter((r) => fns.isDedicatedClient(r));
  const firstAlpha = dedicatedBefore
    .map((r) => r.guest_name)
    .slice()
    .sort((a, b) => a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase()))[0];
  const firstClientPosBefore = bookedThenRecent.findIndex((r) => r.guest_name === firstAlpha);
  const inversionsBefore = countInversions(dedicatedBefore.map((r) => r.guest_name));
  ok('Seadog baseline: alphabetically-first client is not at list head (all_people order)',
    firstAlpha === 'Ada First'
    && firstClientPosBefore > 0
    && inversionsBefore > 0
    && dedicatedBefore.length === 27);

  const seaGuest = fns.guestViewList(bookedThenRecent);
  const seaNames = seaGuest.map((r) => r.guest_name);
  const inversionsAfter = countInversions(seaNames);
  ok('Guest list is dedicated clients only (hides 3 thread-only rows)',
    seaGuest.length === clients.length
    && seaGuest.every((r) => fns.isDedicatedClient(r))
    && !seaNames.includes('Orphan Newest')
    && !seaNames.includes('Bare Thread')
    && !seaNames.includes('Mail Transport'));
  ok('Guest list is A–Z with zero ordering inversions',
    inversionsAfter === 0
    && seaNames[0] === 'Ada First'
    && seaNames[seaNames.length - 1] === 'Zeta Last');
  ok('Guest blanks previews and activity labels on all_people-shaped rows',
    seaGuest.every((r) => r.last_message_preview === '' && !r.last_activity_label));

  /* Preset switch must latch guestView and re-render A–Z even when detection
   * previously relied only on aria-pressed / columns record after the write. */
  const presetSandbox = loadFns();
  let selectedView = 'whatsapp';
  let rendered = null;
  presetSandbox.inboxSavedViewId = selectedView;
  presetSandbox.inboxRowsActiveView = { id: 'whatsapp', source: 'conversations' };
  presetSandbox.inboxColumnsRuntime = { record: { preset: 'all4' } };
  presetSandbox.inboxRowsRuntime.guestView = false;
  presetSandbox.inboxConversationsCache = bookedThenRecent.slice();
  presetSandbox.selectInboxSavedView = function(viewId) {
    selectedView = viewId;
    presetSandbox.inboxSavedViewId = viewId;
    presetSandbox.inboxRowsActiveView = {
      id: viewId,
      source: viewId === 'all_people' ? 'customers' : 'conversations',
    };
    if (viewId === 'all_people') {
      presetSandbox.inboxConversationsCache = bookedThenRecent.filter((r) => r._inbox_view_source === 'customers'
        || r.source === 'customers'
        || (r.phone && !/^email/i.test(r.phone) && String(r.conversation_id || '').indexOf('email') !== 0));
      /* Keep thread-only rows out of the customers payload; Guest still A–Z. */
      presetSandbox.inboxConversationsCache = bookedThenRecent.filter((r) => r._inbox_view_source === 'customers');
    }
    presetSandbox.renderInbox(presetSandbox.inboxConversationsCache, {});
  };
  presetSandbox.applyInboxFilter = function() {
    presetSandbox.renderInbox(presetSandbox.inboxConversationsCache || [], {});
  };
  presetSandbox.renderInbox = function(convs) {
    if (presetSandbox.__inboxRows.guestViewActive()) {
      rendered = presetSandbox.__inboxRows.guestViewList(convs);
    } else {
      rendered = convs;
    }
    return 'ok';
  };
  presetSandbox.inboxColumnsSetPreset = function(name) {
    presetSandbox.inboxColumnsRuntime.record = { preset: name };
    return { preset: name };
  };
  presetSandbox.__inboxRows.runtime.wired = false;
  presetSandbox.renderInbox._inboxRowsWrapped = false;
  presetSandbox.inboxColumnsSetPreset._inboxGuestViewWrapped = false;
  presetSandbox.__inboxRows.install();

  presetSandbox.inboxColumnsSetPreset('guest');
  const afterGuest = (rendered || []).map((r) => r.guest_name);
  ok('Guest preset latches guestView=true',
    presetSandbox.inboxRowsRuntime.guestView === true
    && presetSandbox.__inboxRows.guestViewActive() === true);
  ok('Guest preset pins all_people customers directory (not WhatsApp last-messaged)',
    selectedView === 'all_people'
    && presetSandbox.inboxRowsActiveView.source === 'customers');
  ok('Guest preset render is A–Z dedicated clients (Seadog first client at position 1)',
    afterGuest[0] === 'Ada First'
    && countInversions(afterGuest) === 0
    && afterGuest.length === clients.length);

  presetSandbox.inboxColumnsSetPreset('all4');
  ok('Leaving Guest clears guestView latch (Full Inbox)',
    presetSandbox.inboxRowsRuntime.guestView === false
    && presetSandbox.__inboxRows.guestViewActive() === false);
  ok('Leaving Guest restores prior All/WhatsApp/Email view id',
    selectedView === 'whatsapp');
}

ok('sort prefers guest_name over inboxPersonDisplayName Guest fallback',
  rowsSrc.includes('row.guest_name || row.display_name')
  && rowsSrc.includes('/^guest$/i.test(name)'));

ok('does not invent a last_read POST',
  !rowsSrc.includes('last_read')
  || rowsSrc.includes('last_read_at'));

ok('stay off inbox-thread.js / email-settings / Auto-send surface',
  !threadSrc.includes('inboxRowsEnterGuestDirectory')
  && !threadSrc.includes('inboxRowsOnGuestPresetChange')
  && !/LUNA_AUTO_SEND|email-settings|graph\.microsoft/i.test(rowsSrc));

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify-inbox-guestview-customers-only — FAILED');
  process.exit(1);
}
console.log('verify-inbox-guestview-customers-only — ALL CHECKS PASSED');
