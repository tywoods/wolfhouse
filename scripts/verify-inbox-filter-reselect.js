#!/usr/bin/env node
'use strict';

/**
 * verify:inbox-filter-reselect
 *
 * INBOX-FILTER-RESELECT-001 — leftover P3.
 *
 * Changing Inbox filter or search must not silently open the first remaining
 * thread (an unrelated guest under a filtered list). Keep the open guest when
 * they still match; otherwise drop to a neutral pane — never loadConvDetail
 * of convs[0] as a replacement.
 *
 * Owner: inbox-rows.js wrap of loadInbox / applyInboxFilter / renderInbox.
 * Stay off inbox-thread.js and inbox-context.js (INBOX-GUEST-CARD-BOOKINGS-001
 * unmerged on that file).
 *
 * Run:
 *   node scripts/verify-inbox-filter-reselect.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const {
  ROWS_MODULE,
  THREAD_MODULE,
  LIST_MODULE,
  CONTEXT_MODULE,
} = require('./lib/inbox-browser-source');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PKG_PATH = path.join(ROOT, 'package.json');
const LUNA_ALL_PATH = path.join(ROOT, 'scripts', 'verify-luna-all.js');

const rowsSrc = fs.readFileSync(ROWS_MODULE, 'utf8');
const threadSrc = fs.readFileSync(THREAD_MODULE, 'utf8');
const listSrc = fs.readFileSync(LIST_MODULE, 'utf8');
const contextSrc = fs.readFileSync(CONTEXT_MODULE, 'utf8');
const apiSrc = fs.readFileSync(API_PATH, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
const lunaAllSrc = fs.readFileSync(LUNA_ALL_PATH, 'utf8');

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

function extractFn(source, name) {
  const a = source.indexOf(`function ${name}(`);
  if (a < 0) return '';
  const b = source.indexOf('\nfunction ', a + 1);
  return source.slice(a, b < 0 ? source.length : b);
}

function classList() {
  const values = new Set();
  return {
    add: (x) => values.add(x),
    remove: (x) => values.delete(x),
    contains: (x) => values.has(x),
    toggle: (x, yes) => {
      if (yes === false) values.delete(x);
      else if (yes === true) values.add(x);
      else if (values.has(x)) values.delete(x);
      else values.add(x);
    },
  };
}

function element() {
  return {
    innerHTML: '',
    textContent: '',
    classList: classList(),
    style: {},
    dataset: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
}

function listElement() {
  const list = element();
  let cards = [];
  Object.defineProperty(list, 'innerHTML', {
    get: () => list._html || '',
    set: (html) => {
      list._html = html;
      cards = [...String(html).matchAll(/data-id="([^"]+)"/g)].map((m) => ({
        dataset: { id: m[1] },
        classList: classList(),
        querySelector: () => null,
        addEventListener: () => {},
      }));
    },
  });
  list.querySelectorAll = (selector) => (selector === '.conv-card' ? cards : []);
  list.querySelector = (selector) => {
    const m = String(selector).match(/data-id="([^"]+)"/);
    return m ? cards.find((c) => c.dataset.id === m[1]) || null : null;
  };
  list.cards = () => cards;
  return list;
}

const GUESTS = [
  { conversation_id: 'A', channel: 'whatsapp', guest_name: 'Alice', phone: '+111' },
  { conversation_id: 'B', channel: 'email', guest_name: 'Bob', guest_email: 'bob@x.test' },
  { conversation_id: 'C', channel: 'whatsapp', guest_name: 'Cara', phone: '+333' },
];

function loadRuntime(withWrap) {
  const detail = element();
  const list = listElement();
  const search = {
    value: '',
    dataset: {},
    addEventListener(type, fn) {
      if (type === 'input') this._onInput = fn;
    },
  };
  const loads = [];
  const sandbox = {
    selectedConvId: 'A',
    inboxSelectionGeneration: 0,
    inboxFilter: 'all',
    inboxConversationsCache: GUESTS.map((g) => Object.assign({}, g)),
    inboxSavedViewId: 'all',
    INBOX_DEFAULT_SAVED_VIEW: 'all',
    loads,
    el: (id) => {
      if (id === 'detail-content') return detail;
      if (id === 'conv-list') return list;
      if (id === 'inbox-conv-search') return search;
      if (id === 'inbox-state') return element();
      return element();
    },
    document: {
      querySelectorAll: () => [],
      getElementById: () => null,
      getElementsByTagName: () => [],
      head: { appendChild() {} },
      createElement: () => ({ id: '', textContent: '' }),
    },
    console,
    escHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    portalT: (k) => k,
    t: (k) => k,
    getPortalProfile: () => ({}),
    getClient: () => 'sunset',
    updateInboxPreviewBanner: () => {},
    inboxEmptyListMessage: () => 'empty list',
    inboxEmptyDetailHtml: () => '<div>select a conversation</div>',
    hideInboxMobileThread: () => {},
    inboxParkRefreshBtn: () => {},
    inboxTeardownClearThreadDialog: () => {},
    isPortalMobile: () => false,
    conversationNeedsHuman: (c) => !!(c && c.needs_human),
    renderInboxConvCardHtml: (c) => `<div class="conv-card" data-id="${c.conversation_id}"></div>`,
    wireDeleteConversation: () => {},
    loadConvDetail: (id) => {
      loads.push(id);
      sandbox.selectedConvId = id;
      detail.innerHTML = 'Guest ' + id;
    },
    isSurfInboxDemoThread: () => false,
    window: {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const threadFns = [
    extractFn(threadSrc, 'inboxSelectionIsCurrent'),
    extractFn(threadSrc, 'clearInboxSelection'),
    extractFn(threadSrc, 'renderInbox'),
  ].join('\n');
  const listFns = [
    extractFn(listSrc, 'filterInboxConversations'),
    extractFn(listSrc, 'updateInboxFilterUI'),
    extractFn(listSrc, 'setInboxFilter'),
    extractFn(listSrc, 'applyInboxFilter'),
    extractFn(listSrc, 'wireInboxConvSearch'),
  ].join('\n');

  sandbox.loadInbox = function loadInbox(selectConvIdAfterLoad, opts) {
    opts = opts || {};
    const silent = !!opts.silent;
    const preserveDetail = !!opts.preserveDetail;
    const keepConvId = selectConvIdAfterLoad || (preserveDetail ? sandbox.selectedConvId : null);
    if (!silent) {
      sandbox.selectedConvId = null;
      detail.innerHTML = '<div>select a conversation</div>';
    }
    if (selectConvIdAfterLoad) sandbox.selectedConvId = selectConvIdAfterLoad;
    else if (keepConvId) sandbox.selectedConvId = keepConvId;
    sandbox.applyInboxFilter({
      preserveDetail: !!(preserveDetail && !selectConvIdAfterLoad),
      selectedId: sandbox.selectedConvId,
    });
    if (selectConvIdAfterLoad) sandbox.loadConvDetail(selectConvIdAfterLoad);
  };

  sandbox.selectInboxSavedView = function selectInboxSavedView(viewId) {
    sandbox.inboxSavedViewId = viewId || 'all';
    sandbox.inboxFilter = 'all';
    if (viewId === 'email') {
      sandbox.inboxConversationsCache = GUESTS.filter((g) => g.channel === 'email').map((g) => Object.assign({}, g));
    } else if (viewId === 'whatsapp') {
      sandbox.inboxConversationsCache = GUESTS.filter((g) => (g.channel || 'whatsapp') === 'whatsapp').map((g) => Object.assign({}, g));
    } else {
      sandbox.inboxConversationsCache = GUESTS.map((g) => Object.assign({}, g));
    }
    sandbox.loadInbox(null, { silent: false, preserveDetail: false });
  };

  vm.runInContext(
    `var inboxSelectionGeneration = 0;\n${threadFns}\n${listFns}\n` +
      `this.renderInbox = renderInbox;\nthis.clearInboxSelection = clearInboxSelection;\n` +
      `this.setInboxFilter = setInboxFilter;\nthis.applyInboxFilter = applyInboxFilter;\n` +
      `this.filterInboxConversations = filterInboxConversations;\n` +
      `this.wireInboxConvSearch = wireInboxConvSearch;\n`,
    sandbox,
  );

  if (withWrap) {
    vm.runInContext(`${rowsSrc}\nthis.__inboxRows = window.__inboxRows;`, sandbox);
  }

  return { sandbox, detail, list, search, loads };
}

console.log('\nverify:inbox-filter-reselect — filter/search must not pick first thread\n');

console.log('── owner / stay-off ──');
ok('inbox-rows.js owns INBOX-FILTER-RESELECT-001 wrap',
  rowsSrc.includes('INBOX-FILTER-RESELECT-001')
  && rowsSrc.includes('function inboxRowsPreserveSelectionOpts(')
  && rowsSrc.includes('function inboxRowsWrapFilterReselect(')
  && rowsSrc.includes('loadInbox._inboxFilterReselectWrapped')
  && rowsSrc.includes('applyInboxFilter._inboxFilterReselectWrapped')
  && rowsSrc.includes('inboxRowsPreserveSelectionOpts(opts)'));
ok('wrap of renderInboxConvCardHtml still lives in inbox-rows',
  rowsSrc.includes('var _inboxRowsLegacyRenderConvCardHtml = renderInboxConvCardHtml')
  && rowsSrc.includes('inboxRowsWrapConvCardHtml(_inboxRowsLegacyRenderConvCardHtml(c, profile), c)'));
ok('inbox-thread.js is not edited',
  threadSrc.includes('function renderInbox(')
  && threadSrc.includes('pickId = convs[0].conversation_id')
  && !threadSrc.includes('INBOX-FILTER-RESELECT-001')
  && !threadSrc.includes('inboxRowsPreserveSelectionOpts')
  && !threadSrc.includes('inboxRowsWrapFilterReselect'));
ok('inbox-context.js is not edited (INBOX-GUEST-CARD-BOOKINGS-001 unmerged)',
  !contextSrc.includes('INBOX-FILTER-RESELECT-001')
  && !contextSrc.includes('inboxRowsPreserveSelectionOpts')
  && !contextSrc.includes('inboxRowsWrapFilterReselect')
  && !contextSrc.includes('inboxCustomerWithThreadBookings'));
ok('staff-query-api.js has no filter-reselect markup',
  !apiSrc.includes('INBOX-FILTER-RESELECT-001')
  && !apiSrc.includes('inboxRowsWrapFilterReselect'));
ok('no email-settings / Graph / Skipper inbound from this module',
  !/email-settings/.test(rowsSrc)
  && !/sendMail/.test(rowsSrc)
  && !/graph\.microsoft/.test(rowsSrc)
  && !/whatsapp.*\/messages/.test(rowsSrc)
  && !/graphClient/.test(rowsSrc));
ok('package.json and luna-all register this gate',
  pkg.scripts && pkg.scripts['verify:inbox-filter-reselect'] === 'node scripts/verify-inbox-filter-reselect.js'
  && /verify-inbox-filter-reselect\.js/.test(lunaAllSrc));

console.log('\n── unwrapped baseline (the leftover) ──');
{
  const r = loadRuntime(false);
  r.sandbox.selectInboxSavedView('email');
  ok('without wrap, rail filter silent-load picks first remaining guest',
    r.loads[0] === 'B' && r.sandbox.selectedConvId === 'B');
}

console.log('\n── wrapped filter / search ──');
{
  const r = loadRuntime(true);
  r.sandbox.selectInboxSavedView('email');
  ok('rail Email filter does not auto-select Bob',
    r.loads.length === 0,
    `loads=${JSON.stringify(r.loads)}`);
  ok('rail Email filter drops Alice instead of replacing her',
    r.sandbox.selectedConvId == null
    && r.list.cards().every((c) => !c.classList.contains('selected')));
  ok('rail Email filter leaves a neutral chat pane',
    String(r.detail.innerHTML).includes('select a conversation'));
}

{
  const r = loadRuntime(true);
  r.sandbox.setInboxFilter('email');
  ok('legacy Email chip does not auto-select Bob',
    r.loads.length === 0 && r.sandbox.selectedConvId == null,
    `loads=${JSON.stringify(r.loads)} selected=${r.sandbox.selectedConvId}`);
}

{
  const r = loadRuntime(true);
  r.sandbox.setInboxFilter('whatsapp');
  ok('WhatsApp filter keeps Alice selected without a replacement load',
    r.sandbox.selectedConvId === 'A'
    && r.loads.length === 0
    && r.list.cards().find((c) => c.dataset.id === 'A').classList.contains('selected'));
}

{
  const r = loadRuntime(true);
  r.sandbox.wireInboxConvSearch();
  r.search.value = 'bob';
  r.search._onInput({ target: r.search });
  ok('search for Bob does not silently open Bob',
    r.loads.length === 0,
    `loads=${JSON.stringify(r.loads)}`);
  ok('search that hides Alice drops her instead of picking first hit',
    r.sandbox.selectedConvId == null);
}

{
  const r = loadRuntime(true);
  r.sandbox.wireInboxConvSearch();
  r.search.value = 'alice';
  r.search._onInput({ target: r.search });
  ok('search that still matches Alice keeps Alice without reloading detail',
    r.sandbox.selectedConvId === 'A'
    && r.loads.length === 0
    && r.list.cards().find((c) => c.dataset.id === 'A').classList.contains('selected'));
}

{
  const r = loadRuntime(true);
  r.sandbox.selectedConvId = 'A';
  r.sandbox.loadInbox(null, { silent: false, preserveDetail: false });
  ok('loadInbox while a guest is open does not null-then-pick first',
    r.loads.length === 0 && r.sandbox.selectedConvId === 'A',
    `loads=${JSON.stringify(r.loads)} selected=${r.sandbox.selectedConvId}`);
}

{
  const r = loadRuntime(true);
  r.sandbox.selectedConvId = null;
  r.loads.length = 0;
  r.sandbox.renderInbox(GUESTS);
  ok('initial load with no selection may still pick the top row',
    r.loads[0] === 'A' && r.sandbox.selectedConvId === 'A');
}

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:inbox-filter-reselect — FAILED');
  process.exit(1);
}
console.log('verify:inbox-filter-reselect — ALL CHECKS PASSED');
process.exit(0);
