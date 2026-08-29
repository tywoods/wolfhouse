#!/usr/bin/env node
'use strict';

/**
 * verify-inbox-empty-contact
 *
 * PACK-FIX-INBOX-EMPTY-CONTACT-729 leftover of PR #729.
 *
 * Live miss: empty / no-contact Inbox still POSTs
 * /staff/customers/:phone/create-conversation instead of showing the
 * empty-thread copy (same “No message history yet” as a conversation
 * with zero messages). Opening a people row with no conversation, a
 * contact with no phone, or loadConvDetail('') must not create a thread.
 *
 * Owner: scripts/browser/inbox-views.js (the #729 wrap).
 * Stay OFF inbox-thread.js, email-settings, inbound/poller/Graph, package.json.
 *
 * Run:
 *   node scripts/verify-inbox-empty-contact.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { VIEWS_MODULE, THREAD_MODULE, ROWS_MODULE, CONTEXT_MODULE } = require('./lib/inbox-browser-source');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PKG_PATH = path.join(ROOT, 'package.json');

const viewsSrc = fs.readFileSync(VIEWS_MODULE, 'utf8');
const threadSrc = fs.readFileSync(THREAD_MODULE, 'utf8');
const rowsSrc = fs.readFileSync(ROWS_MODULE, 'utf8');
const contextSrc = fs.readFileSync(CONTEXT_MODULE, 'utf8');
const apiSrc = fs.readFileSync(API_PATH, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

const EMPTY_THREAD = 'No message history yet — messages appear here once the guest chats.';
const EMPTY_MAIN = 'No conversations yet.';
const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

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

function makeNode(id) {
  const classSet = new Set();
  return {
    id,
    innerHTML: '',
    textContent: '',
    dataset: {},
    style: { display: 'block' },
    classList: {
      add(c) { classSet.add(c); },
      remove(c) { classSet.delete(c); },
      contains(c) { return classSet.has(c); },
      toggle(c, on) { if (on) classSet.add(c); else classSet.delete(c); },
    },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function loadViews(cacheRows) {
  const nodes = {
    'inbox-views-rail': makeNode('inbox-views-rail'),
    'detail-content': makeNode('detail-content'),
    'conv-list': makeNode('conv-list'),
    'inbox-state': makeNode('inbox-state'),
    'conv-detail': makeNode('conv-detail'),
    'hq-badge': makeNode('hq-badge'),
  };
  const fetches = [];
  const legacyDetail = [];
  const sandbox = {
    window: {},
    console,
    Object,
    Array,
    String,
    Date,
    Promise,
    JSON,
    selectedConvId: null,
    inboxFilter: 'all',
    inboxConversationsCache: cacheRows || [],
    inboxLivePollActive: false,
    inboxListPollInFlight: false,
    fetches,
    legacyDetail,
    nodes,
    el: function (id) { return nodes[id] || null; },
    getClient: function () { return 'sunset'; },
    inboxClientQuery: function () { return '?client=sunset'; },
    getPortalProfile: function () { return { is_surf_vertical: true }; },
    mergeSurfInboxConversations: function (rows) { return rows; },
    applyInboxFilter: function () {},
    renderInboxSchoolContext: function () {},
    hideInboxMobileThread: function () {},
    setInboxLiveStatus: function () {},
    isInboxTabVisible: function () { return false; },
    updateInboxFilterUI: function () {},
    fmtTs: function () { return ''; },
    escHtml: function (s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
    t: function (key) {
      if (key === 'inbox.detail.thread.empty') return EMPTY_THREAD;
      if (key === 'inbox.empty.main') return 'Select a conversation to review.';
      if (key === 'inbox.empty.main.surf') return EMPTY_MAIN;
      if (key === 'inbox.empty.sub') return 'Luna drafts and booking context will appear here.';
      return key;
    },
    portalT: function (key) { return sandbox.t(key); },
    inboxEmptyDetailHtml: function () {
      return '<div class="inbox-empty-right"><p class="main-msg">' + EMPTY_MAIN + '</p></div>';
    },
    loadInbox: function () {},
    pollInboxConversationListLive: function () {},
    loadConvDetail: function (convId, targetEl) {
      legacyDetail.push({ convId: convId, targetEl: targetEl });
    },
    fetch: function (url, opts) {
      fetches.push({ url: String(url || ''), opts: opts || {} });
      return Promise.resolve({
        ok: true,
        json: function () {
          return Promise.resolve({ success: true, conversation_id: UUID });
        },
      });
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(viewsSrc, sandbox);
  return sandbox;
}

function createPosts(sandbox) {
  return (sandbox.fetches || []).filter(function (f) {
    return /create-conversation/i.test(f.url) && String((f.opts && f.opts.method) || '').toUpperCase() === 'POST';
  });
}

console.log('\nverify-inbox-empty-contact — leftover #729 empty/no-contact, no create POST\n');

console.log('── owner / stay-off ──');
ok('inbox-views.js owns empty-contact leftover helpers',
  viewsSrc.includes('INBOX-EMPTY-CONTACT-729')
  && viewsSrc.includes('function inboxViewsPaintEmptyPersonDetail(')
  && viewsSrc.includes('function inboxViewsEmptyThreadCopy('));
ok('people-without-conversation path does not POST create-conversation',
  viewsSrc.includes('function inboxViewsOpenPersonWithoutConversation(')
  && !/function inboxViewsOpenPersonWithoutConversation\([\s\S]*inboxViewsCreateCustomerConversation/.test(viewsSrc)
  && !/function inboxViewsOpenPersonWithoutConversation\([\s\S]*create-conversation/.test(viewsSrc));
ok('create-conversation helper is not called from the loadConvDetail wrap',
  !viewsSrc.includes('inboxViewsCreateCustomerConversation(')
  && !viewsSrc.includes("reason: 'Opened from Inbox people view'"));
ok('stay off inbox-thread.js',
  !threadSrc.includes('INBOX-EMPTY-CONTACT-729')
  && !threadSrc.includes('inboxViewsPaintEmptyPersonDetail')
  && threadSrc.includes('function loadConvDetail(convId, targetEl)'));
ok('stay off inbox-rows.js body for this leftover (views owns the wrap)',
  !rowsSrc.includes('INBOX-EMPTY-CONTACT-729')
  && !rowsSrc.includes('inboxViewsPaintEmptyPersonDetail'));
ok('stay off inbox-context.js',
  !contextSrc.includes('INBOX-EMPTY-CONTACT-729')
  && !contextSrc.includes('inboxViewsPaintEmptyPersonDetail'));
ok('stay off package.json (do not register this leftover gate)',
  !(pkg.scripts && pkg.scripts['verify:inbox-empty-contact'])
  && !JSON.stringify(pkg).includes('verify-inbox-empty-contact'));
ok('no Graph / inbound poller / email-settings / Auto from this module',
  !/sendMail/.test(viewsSrc)
  && !/graph\.microsoft/.test(viewsSrc)
  && !/inbound-capture/.test(viewsSrc)
  && !/email-settings/.test(viewsSrc)
  && !/graphClient/.test(viewsSrc)
  && !/LUNA_AUTO_SEND_ENABLED/.test(viewsSrc)
  && !/generate-luna-draft/.test(viewsSrc));
ok('staff-query-api.js is not the owner',
  !apiSrc.includes('INBOX-EMPTY-CONTACT-729')
  && !apiSrc.includes('inboxViewsPaintEmptyPersonDetail'));

const personNoConv = {
  conversation_id: '',
  guest_name: 'No Thread',
  phone: '+34600111222',
  _inbox_view_key: 'customers:+34600111222',
  _inbox_view_source: 'customers',
};
const personNoContact = {
  conversation_id: '',
  guest_name: 'No Contact',
  phone: '',
  _inbox_view_key: 'customers:anon-1',
  _inbox_view_source: 'customers',
};

console.log('\n── people row with phone, no conversation ──');
const withPhone = loadViews([personNoConv]);
withPhone.loadConvDetail(personNoConv._inbox_view_key, withPhone.nodes['detail-content']);
const withPhonePosts = createPosts(withPhone);
ok('does not POST create-conversation for a no-conversation person',
  withPhonePosts.length === 0,
  'posts=' + JSON.stringify(withPhonePosts.map(function (p) { return p.url; })));
ok('does not fall through to legacy loadConvDetail (that 404s on the people key)',
  withPhone.legacyDetail.length === 0,
  'legacy=' + JSON.stringify(withPhone.legacyDetail));
const withPhoneHtml = String(withPhone.nodes['detail-content'].innerHTML || '');
ok('paints empty-thread copy, not Error: Not found',
  withPhoneHtml.indexOf('thread-empty') >= 0
  && withPhoneHtml.indexOf(EMPTY_THREAD) >= 0
  && withPhoneHtml.indexOf('Error:') < 0,
  withPhoneHtml.slice(0, 240));

console.log('\n── people row with no contact (no phone) ──');
const noContact = loadViews([personNoContact]);
noContact.loadConvDetail(personNoContact._inbox_view_key, noContact.nodes['detail-content']);
ok('does not POST create-conversation when the person has no phone',
  createPosts(noContact).length === 0);
ok('no-contact person paints empty-thread copy',
  String(noContact.nodes['detail-content'].innerHTML || '').indexOf(EMPTY_THREAD) >= 0
  && String(noContact.nodes['detail-content'].innerHTML || '').indexOf('thread-empty') >= 0);
ok('no-contact person does not call legacy loadConvDetail(\'\')',
  noContact.legacyDetail.length === 0,
  'legacy=' + JSON.stringify(noContact.legacyDetail));

console.log('\n── empty Inbox / empty convId ──');
const emptyInbox = loadViews([personNoConv]);
emptyInbox.nodes['conv-list'].querySelector = function () {
  return { getAttribute: function () { return personNoConv._inbox_view_key; } };
};
emptyInbox.loadConvDetail('', emptyInbox.nodes['detail-content']);
ok('empty convId does not POST create-conversation (no selected-card create)',
  createPosts(emptyInbox).length === 0,
  'posts=' + JSON.stringify(createPosts(emptyInbox).map(function (p) { return p.url; })));
ok('empty convId does not fetch /staff/inbox/thread/ (legacy 404)',
  emptyInbox.legacyDetail.length === 0
  && emptyInbox.fetches.every(function (f) { return !/\/staff\/inbox\/thread\//.test(f.url); }));
const emptyHtml = String(emptyInbox.nodes['detail-content'].innerHTML || '');
ok('empty convId paints empty copy',
  emptyHtml.indexOf('inbox-empty-right') >= 0 || emptyHtml.indexOf('thread-empty') >= 0,
  emptyHtml.slice(0, 240));

console.log('\n── existing conversation still pass-through ──');
const existing = loadViews([{
  conversation_id: UUID,
  guest_name: 'Gary',
  phone: '+34600999000',
  _inbox_view_key: 'customers:+34600999000',
  _inbox_view_source: 'customers',
}]);
existing.loadConvDetail(UUID, existing.nodes['detail-content']);
ok('UUID conversation still calls legacy loadConvDetail',
  existing.legacyDetail.length === 1 && existing.legacyDetail[0].convId === UUID);
ok('UUID conversation does not POST create-conversation',
  createPosts(existing).length === 0);

console.log('\n' + '─'.repeat(48));
if (fail) {
  console.error(`FAILED ${fail}  passed ${pass}`);
  process.exit(1);
}
console.log(`All ${pass} checks passed.`);
process.exit(0);
