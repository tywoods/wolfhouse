#!/usr/bin/env node
'use strict';

/**
 * INBOX-WOLFHOUSE-PARITY-001
 *
 * Bring Sunset Inbox folder tabs + 1520 wrap + 14px Guests gap + hold/readiness
 * to Wolfhouse lodging (no data-portal-client). Cap: deploying master is not
 * enough while polish stays Sunset-gated.
 *
 * Out of slice: Admin Email, Crow's Nest, production, email-authority.
 * Preserve #1068 Checked in.
 *
 * Run: node scripts/verify-inbox-wolfhouse-parity-001.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');
const { ROWS_MODULE, THREAD_MODULE } = require('./lib/inbox-browser-source');
const {
  WOLFHOUSE_GUEST_SURFACE_ORDER,
  guestSurfaceOrderForClient,
} = require('./lib/staff-inbox-saved-views');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const COLUMNS_PATH = path.join(ROOT, 'scripts', 'browser', 'inbox-columns.js');
const VIEWS_PATH = path.join(ROOT, 'scripts', 'browser', 'inbox-views.js');
const SHELL_PATH = path.join(ROOT, 'scripts', 'browser', 'inbox-shell.js');
const FIXTURE_PATH = path.join(ROOT, 'scripts', 'fixtures', 'inbox-wolfhouse-parity-001.html');
const PACKAGE_PATH = path.join(ROOT, 'package.json');

const apiSrc = fs.readFileSync(API_PATH, 'utf8');
const rowsSrc = fs.readFileSync(ROWS_MODULE, 'utf8');
const threadSrc = fs.readFileSync(THREAD_MODULE, 'utf8');
const columnsSrc = fs.readFileSync(COLUMNS_PATH, 'utf8');
const viewsSrc = fs.readFileSync(VIEWS_PATH, 'utf8');
const shellSrc = fs.readFileSync(SHELL_PATH, 'utf8');
const fixture = fs.existsSync(FIXTURE_PATH) ? fs.readFileSync(FIXTURE_PATH, 'utf8') : '';

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
function sliceRule(src, selector) {
  const needle = selector + '{';
  const i = src.indexOf(needle);
  if (i < 0) return '';
  const start = i + needle.length;
  const end = src.indexOf('}', start);
  return end < 0 ? '' : src.slice(start, end);
}
function gitDiff(rel) {
  try {
    return execSync(`git diff HEAD -- ${rel}`, { cwd: ROOT, encoding: 'utf8' });
  } catch (_e) {
    return 'git-error';
  }
}
function fn(name, source) {
  const a = source.indexOf(`function ${name}(`);
  const b = source.indexOf('\nfunction ', a + 1);
  return a < 0 ? '' : source.slice(a, b < 0 ? source.length : b);
}

const WH = 'html:not([data-portal-client])';
const SUNSET = 'html[data-portal-client="sunset"]';

console.log('\nverify INBOX-WOLFHOUSE-PARITY-001\n');

console.log('── admission / tenant stamp ──');
ok('data-portal-client attribute stays Sunset-only',
  /portalDefaultClient === 'sunset' \? ' data-portal-client="sunset"' : ''/.test(apiSrc)
  && !/data-portal-client="\$\{portalDefaultClient\}"/.test(apiSrc));
ok('Wolfhouse html is not stamped with a portal-client value',
  !/data-portal-client="wolfhouse"/.test(apiSrc));
ok('Sunset folder-tab selectors remain for live Sunset',
  /html\[data-portal-client="sunset"\] \.inbox-col1 > \.inbox-folder-tabs\{/.test(apiSrc)
  && /display:flex/.test(sliceRule(apiSrc, `${SUNSET} .inbox-col1 > .inbox-folder-tabs`)));
ok('default hide remains (Sunset gates still see display:none)',
  /\.inbox-folder-tabs\{display:none\}/.test(apiSrc));

console.log('\n── folder tabs + flush + active green ──');
const tabsRule = sliceRule(apiSrc, `${WH} .inbox-col1 > .inbox-folder-tabs`);
const mb = /margin:[^;]*0\s+0\s+(-?\d+)px/.exec(tabsRule)
  || /margin-bottom:(-?\d+)px/.exec(tabsRule);
const marginBottom = mb ? Number(mb[1]) : null;
ok('Wolfhouse shows folder tabs on the left rail',
  /display:flex/.test(tabsRule), tabsRule);
ok('Wolfhouse tabs cancel the 10px col1 gap (margin-bottom <= -10px)',
  marginBottom != null && marginBottom <= -10,
  `mb=${marginBottom} rule=${tabsRule.replace(/\s+/g, ' ').slice(0, 160)}`);
ok('Wolfhouse tabs stack above the rail',
  /z-index:2/.test(tabsRule) && /position:relative/.test(tabsRule));
ok('Wolfhouse views-rail top corners flatten',
  /border-top-left-radius:0/.test(sliceRule(apiSrc, `${WH} #inbox-shell.inbox-two-col.inbox-shell-cols .inbox-col1 > .inbox-views-rail`))
  && /border-top-right-radius:0/.test(sliceRule(apiSrc, `${WH} #inbox-shell.inbox-two-col.inbox-shell-cols .inbox-col1 > .inbox-views-rail`)));
const lightActive = sliceRule(apiSrc, `${WH} .inbox-col1 > .inbox-folder-tabs .inbox-folder-tab[aria-pressed="true"]`);
const darkActive = sliceRule(apiSrc, `${WH}[data-theme="dark"] .inbox-col1 > .inbox-folder-tabs .inbox-folder-tab[aria-pressed="true"]`);
ok('Wolfhouse light active tab is forest green, not gray surface',
  /background:var\(--inbox-forest/.test(lightActive) && !/background:var\(--surface\)/.test(lightActive),
  lightActive);
ok('Wolfhouse dark active tab is forest / staff-green text (not cream charcoal)',
  /background:var\(--inbox-forest/.test(darkActive)
  && /color:var\(--staff-green-text/.test(darkActive)
  && !/color:var\(--cream/.test(darkActive),
  darkActive);
ok('Wolfhouse hides leftover #tabs Full/Guest chips',
  /html:not\(\[data-portal-client\]\) #tabs \.inbox-layout-presets\{display:none!important\}/.test(apiSrc));
ok('unprefixed .inbox-col1 gap:10px stays (Autonomy spacing)',
  /\.inbox-col1\{[\s\S]{0,180}gap:10px/.test(apiSrc));
ok('active rules are not a bare .inbox-folder-tab.is-active{ (Sunset chrome-003)',
  !/\n\.inbox-folder-tab\.is-active\{/.test(apiSrc));

console.log('\n── #1098 wrap / gap geometry ──');
ok('unprefixed Full wrap still documents 1800 (Sunset gate)',
  /#tab-conversations\.active #wrap\.inbox-shell-wrap\{[\s\S]{0,80}max-width:1800px!important/.test(apiSrc));
ok('unprefixed Guest wrap still documents 1240 (Sunset gate)',
  /data-inbox-preset="guest"\]\[aria-pressed="true"\]\) #wrap\.inbox-shell-wrap\{[\s\S]{0,40}max-width:1240px!important/.test(apiSrc));
ok('Wolfhouse Inbox wrap is 1520 (menus stay put)',
  sliceRule(apiSrc, `${WH} #tab-conversations.active #wrap.inbox-shell-wrap`).includes('max-width:1520px!important'));
ok('Wolfhouse Guest wrap is the same 1520',
  sliceRule(apiSrc, `${WH} body:has(#tab-conversations.active):has([data-inbox-preset="guest"][aria-pressed="true"]) #wrap.inbox-shell-wrap`).includes('max-width:1520px!important'));
ok('Wolfhouse Chat-preset wrap is the same 1520',
  sliceRule(apiSrc, `${WH} body:has(#tab-conversations.active):has([data-inbox-preset="chat"][aria-pressed="true"]) #wrap.inbox-shell-wrap`).includes('max-width:1520px!important'));
ok('rail/list WIDTHS stay 240 / 252',
  sliceRule(apiSrc, '.inbox-two-col.inbox-shell-cols[data-col1="full"]') === '--inbox-col1-w:240px'
  && sliceRule(apiSrc, '.inbox-two-col.inbox-shell-cols[data-col2="comfortable"]') === '--inbox-col2-w:252px'
  && /col1:\s*\{\s*full:\s*'240px'/.test(columnsSrc)
  && /col2:\s*\{\s*comfortable:\s*'252px'/.test(columnsSrc));
ok('unprefixed Wolfhouse Guest still documents the 0px chat track',
  /(?:^|\n)\s*\.inbox-two-col\.inbox-shell-cols\[data-col4="wide"\]\{\s*grid-template-columns:[^}]*0px minmax\(0,1fr\)/.test(apiSrc));
ok('Wolfhouse Guest overlay is 3-col (rail | list | card) so list→card is 14px',
  /grid-template-columns:var\(--inbox-col1-w\) minmax\(0,var\(--inbox-col2-w\)\) minmax\(0,1fr\)/.test(
    sliceRule(apiSrc, `${WH} body:has([data-inbox-preset="guest"][aria-pressed="true"]) .inbox-two-col.inbox-shell-cols`)
  )
  && /grid-column:3/.test(
    sliceRule(apiSrc, `${WH} body:has([data-inbox-preset="guest"][aria-pressed="true"]) .inbox-two-col.inbox-shell-cols .detail-sidebar`)
  ));
ok('desktop gap stays 14px',
  /--inbox-col-gap:14px/.test(apiSrc));

console.log('\n── hold / readiness (reuse #1103 + #1111) ──');
ok('crossing line still uses inboxRowsIsSunsetPortal (Sunset gate)',
  /crossing = wasGuest !== nowGuest && inboxRowsIsSunsetPortal\(\)/.test(rowsSrc));
ok('lodging without data-portal-client is a hold portal',
  /client === 'sunset' \|\| !client/.test(rowsSrc)
  && /INBOX-WOLFHOUSE-PARITY-001/.test(rowsSrc));
ok('conversation hold is on for missing portal-client',
  /holdPortal = portalClient === 'sunset' \|\| portalClient === null \|\| portalClient === ''/.test(threadSrc));
ok('folder switch still snapshots via startViewTransition (no hide/reveal CSS)',
  rowsSrc.includes('document.startViewTransition(function()')
  && !new RegExp(`${WH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} #inbox-shell\\.inbox-folder-switching\\{[\\s\\S]{0,120}(visibility:hidden|opacity:0)`).test(apiSrc));
ok('Wolfhouse disables default view-transition cross-fade',
  apiSrc.includes(`${WH}::view-transition-old(root)`)
  && apiSrc.includes(`${WH}::view-transition-new(root)`));
ok('500ms remains the stall net only',
  /setTimeout\(function\(\) \{\s*inboxRowsEndFolderSwitch\(gen\);\s*\}, 500\)/.test(rowsSrc));

console.log('\n── #1068 Checked in preserved ──');
ok('Wolfhouse Guest rail still starts All people, Checked in',
  WOLFHOUSE_GUEST_SURFACE_ORDER[0] === 'all_people'
  && WOLFHOUSE_GUEST_SURFACE_ORDER[1] === 'checked_in'
  && WOLFHOUSE_GUEST_SURFACE_ORDER.indexOf('equipment_out') < 0);
ok('guestSurfaceOrderForClient(wolfhouse-somo) is lodging order',
  guestSurfaceOrderForClient('wolfhouse-somo') === WOLFHOUSE_GUEST_SURFACE_ORDER);
ok('browser still picks lodging order when html is not sunset',
  viewsSrc.includes('INBOX_SURFACE_ORDER_GUEST_WOLFHOUSE')
  && viewsSrc.includes('inboxViewsIsSunsetTenant'));

console.log('\n── Guest tab teal stays Sunset-only ──');
ok('Guest restore teal remains sunset-prefixed',
  /html\[data-portal-client="sunset"\][\s\S]{0,280}background:var\(--teal\)/.test(apiSrc)
  && shellSrc.includes('html[data-portal-client="sunset"]')
  && !new RegExp(`${WH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]{0,280}background:var\\(--teal\\)`).test(apiSrc));

console.log('\n── fixture ──');
ok('fixture exists and has no data-portal-client',
  !!fixture
  && !/data-portal-client=/.test(fixture)
  && /INBOX-WOLFHOUSE-PARITY-001/.test(fixture));
ok('fixture uses Wolfhouse folder-tab selectors + competing gap:10px',
  fixture.includes(`${WH} .inbox-col1 > .inbox-folder-tabs{`)
  && /gap:10px/.test(fixture)
  && /WOLFHOUSE-PARITY-001-OK/.test(fixture));

console.log('\n── folder tab click path ──');
(function folderClick() {
  function makeBtn(attrs) {
    const classSet = new Set(String(attrs.className || '').split(/\s+/).filter(Boolean));
    return {
      attrs: Object.assign({}, attrs),
      classList: {
        toggle(name, on) { if (on) classSet.add(name); else classSet.delete(name); },
        contains(name) { return classSet.has(name); },
      },
      getAttribute(k) { return this.attrs[k] == null ? null : String(this.attrs[k]); },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      closest(sel) {
        if (sel === '[data-inbox-preset]' && this.attrs['data-inbox-preset']) return this;
        if (sel === '.inbox-view-btn' || sel === '.inbox-folder-tab') return this;
        return null;
      },
    };
  }
  const chatsBtn = makeBtn({
    className: 'inbox-folder-tab inbox-view-btn is-active',
    'data-view': 'full',
    'data-inbox-preset': 'all4',
    'aria-pressed': 'true',
  });
  const guestsBtn = makeBtn({
    className: 'inbox-folder-tab inbox-view-btn',
    'data-view': 'guest',
    'data-inbox-preset': 'guest',
    'aria-pressed': 'false',
  });
  const tabsFull = makeBtn({
    className: 'inbox-layout-preset-btn is-active',
    'data-inbox-preset': 'all4',
    'aria-pressed': 'true',
  });
  const ctx = {
    INBOX_COLUMNS_SHELL_ID: 'inbox-shell',
    document: {
      documentElement: { getAttribute() { return null; } },
      querySelectorAll(sel) {
        if (sel === '[data-inbox-preset]') return [tabsFull, chatsBtn, guestsBtn];
        if (sel.indexOf('.inbox-view-btn[data-view="full"]') >= 0) return [chatsBtn, guestsBtn];
        if (sel === '[data-inbox-col-toggle]') return [];
        return [];
      },
      querySelector() { return null; },
      getElementById(id) {
        return id === 'inbox-shell'
          ? { setAttribute() {}, getAttribute() { return ''; }, removeAttribute() {} }
          : null;
      },
      addEventListener() {},
    },
    window: { addEventListener() {}, innerWidth: 1440, matchMedia() { return { matches: false, addListener() {}, addEventListener() {} }; } },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    console,
  };
  ctx.window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(columnsSrc, ctx);
  const presets = [];
  const origSet = ctx.inboxColumnsSetPreset;
  ctx.inboxColumnsSetPreset = function (preset) {
    presets.push(preset);
    return origSet.apply(this, arguments);
  };
  ctx.inboxColumnsHandleControlClick({ target: guestsBtn });
  ok('Wolfhouse Guests folder tab click sets guest preset', presets[0] === 'guest');
  ctx.inboxColumnsHandleControlClick({ target: chatsBtn });
  ok('Wolfhouse Chats folder tab click sets all4', presets[1] === 'all4');
}());

console.log('\n── folder switch hold (no data-portal-client) ──');
(function folderHold() {
  function classList() {
    const values = new Set();
    return { add(x) { values.add(x); }, remove(x) { values.delete(x); }, contains(x) { return values.has(x); } };
  }
  function element(id) {
    return {
      id, classList: classList(), attrs: {}, style: {}, children: [], parentNode: null,
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
      getBoundingClientRect() { return { left: 20, top: 64, width: 1480, height: 760 }; },
      cloneNode() { const n = element(''); n.isClone = true; return n; },
      appendChild(n) { n.parentNode = this; this.children.push(n); return n; },
      insertBefore(n) { return this.appendChild(n); },
      removeChild(n) { this.children = this.children.filter((x) => x !== n); n.parentNode = null; },
      querySelector(sel) {
        if (/conv-card|inbox-row/.test(String(sel)) && /conv-card|inbox-row/.test(String(this.innerHTML || ''))) return {};
        return null;
      },
    };
  }
  function harness() {
    const html = element('html');
    html.getAttribute = () => null;
    const body = element('body');
    const wrap = element('wrap'); wrap.classList.add('inbox-shell-wrap'); body.appendChild(wrap);
    const shell = element('inbox-shell'); wrap.appendChild(shell);
    const list = element('conv-list'); list.innerHTML = '<div class="conv-card">Ada</div>';
    const guest = element('guest'); guest.attrs['aria-pressed'] = 'false';
    const events = [];
    const raf = [];
    const timers = [];
    const document = {
      documentElement: html,
      body,
      startViewTransition(update) {
        events.push({ type: 'snapshot' });
        const ready = update();
        return { ready, finished: ready };
      },
      getElementById(id) { return ({ wrap, 'inbox-shell': shell, 'conv-list': list })[id] || null; },
      querySelector(sel) {
        if (sel === '[data-inbox-preset="guest"][aria-pressed="true"]') {
          return guest.attrs['aria-pressed'] === 'true' ? guest : null;
        }
        return null;
      },
      createElement() { return element(''); },
      head: { appendChild() {} },
      getElementsByTagName() { return [this.head]; },
    };
    function preset(name) {
      guest.attrs['aria-pressed'] = name === 'guest' ? 'true' : 'false';
      events.push({ type: 'preset' });
    }
    const s = {
      window: {}, document, console, Object, Array, String, Set,
      requestAnimationFrame(cb) { raf.push(cb); },
      setTimeout(cb, ms) { timers.push({ cb, ms }); return timers.length; },
      clearTimeout() {},
      inboxColumnsSetPreset: preset,
      inboxColumnsRuntime: { record: { preset: 'all4' } },
      inboxContextIsGuestMode() { return guest.attrs['aria-pressed'] === 'true'; },
      inboxCustomerPaint() {}, inboxViewsSwitchSurface() {}, renderInbox() {}, renderInboxViewsRail() {},
      getComputedStyle() { return { marginLeft: '0px', marginRight: '0px' }; },
    };
    s.window = s;
    vm.createContext(s);
    vm.runInContext(`${rowsSrc}\nthis.__rows = window.__inboxRows;`, s);
    return { s, events, timers };
  }
  const h = harness();
  h.s.__rows.wrapGuestViewPreset();
  h.s.inboxColumnsSetPreset('guest');
  ok('Wolfhouse snapshots CURRENT before destination preset mutates',
    h.events[0] && h.events[0].type === 'snapshot' && h.events[1] && h.events[1].type === 'preset');
  const gen = h.s.inboxRowsRuntime.folderSwitching;
  h.s.__rows.noteFolderSwitchPart('list', gen);
  h.s.__rows.noteFolderSwitchPart('rail');
  ok('Wolfhouse stays pending until the guest card is ready', h.s.inboxRowsRuntime.folderSwitching > 0);
  h.s.__rows.noteFolderSwitchPart('card');
  ok('Wolfhouse commits when list+rail+card are ready (no hide/reveal)', h.s.inboxRowsRuntime.folderSwitching === 0);
  const stuck = harness();
  stuck.s.__rows.wrapGuestViewPreset();
  stuck.s.inboxColumnsSetPreset('guest');
  const net = stuck.timers.find((x) => x.ms === 500);
  net.cb();
  ok('Wolfhouse 500ms stall net still releases a stuck switch', stuck.s.inboxRowsRuntime.folderSwitching === 0);
}());

console.log('\n── conversation hold: rapid / delayed / empty / identity ──');
(async function convoHold() {
  function classList() {
    const values = new Set();
    return {
      add: (x) => values.add(x),
      remove: (x) => values.delete(x),
      contains: (x) => values.has(x),
      toggle: (x, yes) => (yes ? values.add(x) : values.delete(x)),
    };
  }
  function element() {
    return {
      innerHTML: '', classList: classList(), style: {}, dataset: {},
      querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
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
          dataset: { id: m[1] }, classList: classList(), querySelector: () => null, addEventListener: () => {},
        }));
      },
    });
    list.querySelectorAll = (selector) => (selector === '.conv-card' ? cards : []);
    list.querySelector = (selector) => {
      const m = selector.match(/data-id="([^"]+)"/);
      return m ? cards.find((c) => c.dataset.id === m[1]) || null : null;
    };
    list.cards = () => cards;
    return list;
  }
  function deferred() {
    let resolve; let reject;
    const promise = new Promise((r, j) => { resolve = r; reject = j; });
    return { promise, resolve, reject };
  }
  function response(id) {
    return {
      success: true,
      detail: { success: true, conversation: { conversation_id: id, guest_name: `Guest ${id}`, phone: `+${id}`, channel: 'whatsapp' } },
      messages: { success: true, messages: [{ message_text: `message ${id}` }] },
      context: { success: true, context: { guest_name: `Guest ${id}` } },
      draft: { success: true, draft: { draft_text: `draft ${id}` } },
      pause_state: { success: true },
    };
  }
  async function flush() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
  function loadRuntime() {
    const detail = element(); const sidebar = element(); detail.sidebar = sidebar;
    detail.querySelector = (selector) => (selector === '#inbox-detail-sidebar' ? sidebar : null);
    const list = listElement(); const pending = {}; const transitions = [];
    const sandbox = {
      selectedConvId: null, inboxSelectionGeneration: 0, inboxContextLastComposite: null,
      activeTab: 'conversations', locale: 'es', console,
      el: (id) => (id === 'detail-content' ? detail : (id === 'conv-list' ? list : element())),
      fetch: (url) => {
        const id = decodeURIComponent(String(url).split('/').pop().split('?')[0]);
        pending[id] = deferred();
        const json = () => pending[id].promise;
        return Promise.resolve({ json, clone: () => ({ json }) });
      },
      showInboxMobileThread: () => {}, hideInboxMobileThread: () => {},
      inboxEmptyDetailHtml: () => '<div>select a conversation</div>',
      inboxTeardownClearThreadDialog: () => {}, inboxParkRefreshBtn: () => {}, inboxParkMobileBackBtn: () => {}, inboxAdoptRefreshToHeader: () => {},
      convDetailHasLayout: () => false, inboxReleaseMobileThreadHeight: () => {}, inboxStickThreadToLatest: () => {},
      beginConvDetailLoad: (target) => { target.innerHTML = '<div>Loading…</div>'; target.classList.add('is-loading-detail'); },
      isSurfInboxDemoThread: () => false, loadSurfInboxDemoDetail: () => false, inboxClientQuery: () => '',
      threadMessagesFingerprint: () => 'sig', sanitizeConversationContextForInbox: (x) => x, filterActiveInboxBookings: (x) => x,
      isLunaGuestAutomationPaused: () => false, inboxComposerChannelFor: (c) => c.channel, inboxGuestEmailOf: () => '', inboxIsChatPreset: () => false,
      escHtml: (x) => String(x == null ? '' : x), inboxPersonDisplayName: (c) => c.guest_name || 'Guest',
      conversationHasOpenHandoff: () => false, handoffLabel: () => '', t: (x) => x, portalT: (x) => x,
      inboxComposerChannelSwitchHtml: () => '', inboxWhatsAppDraftMountHtml: () => '', inboxClearThreadButtonHtml: () => '',
      inboxDeleteConversationButtonHtml: () => '', inboxClearThreadDialogHtml: () => '', staffEmailDraftsUiEnabled: () => false,
      inboxEmailDraftBodyOf: (d) => (d && d.draft_text) || '', inboxEmailDraftIsPending: () => false,
      inboxEmailOpenDraftSubject: () => '', inboxEmailComposerChromeHtml: () => '', inboxT: (_k, fallback) => fallback,
      emailReplyState: () => null, inboxFindGuestConversation: () => null,
      renderInboxThreadMessagesHtml: (msgs) => msgs.map((m) => m.message_text).join(','),
      inboxFilterMessagesByChannel: (x) => x, inboxNoEmailThreadHtml: () => '', inboxChatHideGuest: () => {},
      inboxPaintChatChromeSlot: () => {}, wireInboxComposerChannelSwitch: () => {}, inboxFillComposerThread: () => {},
      wireInboxEmailReply: () => {}, wireInboxSendReply: () => {}, wireInboxWhatsAppDraft: () => {},
      openCustomerCardForPhone: () => {}, openCreateBookingFromContact: () => {},
      wireInboxSidebarToggle: (target) => { target.guest = sandbox.inboxContextLastComposite.detail.conversation.guest_name; },
      wireNeedsHumanToggle: () => {}, wireInboxNeedsHumanRaise: () => {}, wireLunaPauseSwitch: () => {},
      wireInboxLunaModeControl: () => {}, wireInboxClearThread: () => {}, wireInboxConversationDeleteButton: () => {},
      wireFreshStart: () => {}, wireAgentSessionReset: () => {}, inboxInitThreadResize: () => {}, inboxScrollThreadToBottom: () => {},
      normalizeCustomerPhoneClient: (x) => x, openBookingInCalendar: () => {}, getPortalProfile: () => ({}),
      getClient: () => 'wolfhouse-somo', updateInboxPreviewBanner: () => {}, inboxEmptyListMessage: () => 'empty',
      renderInboxConvCardHtml: (c) => `<div class="conv-card" data-id="${c.conversation_id}"></div>`,
      isPortalMobile: () => false,
      document: {
        createElement: () => element(),
        documentElement: { getAttribute: () => null },
        startViewTransition: (update) => {
          const transition = { snapshot: detail.innerHTML, settled: false };
          transitions.push(transition);
          transition.ready = Promise.resolve().then(update).then(() => { transition.settled = true; });
          return transition;
        },
      },
      inboxContextRuntime: { fetchHooked: false },
      inboxContextSidebarEl: (target) => target && target.sidebar,
      inboxContextModelFromComposite: (composite) => ({ conversation: composite.detail.conversation }),
      inboxContextEnsureStyles: () => {},
      inboxCustomerLoad: (target, conv) => { target.guest = conv.guest_name; },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    const contextSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'inbox-context.js'), 'utf8');
    vm.runInContext(
      `var inboxSelectionGeneration = 0;\nvar inboxConversationSwitchGeneration = 0;\nvar inboxConversationSwitchRelease = null;\nvar inboxConversationSwitchTransition = null;\n${fn('inboxSelectionIsCurrent', threadSrc)}\n${fn('clearInboxSelection', threadSrc)}\n${fn('renderInbox', threadSrc)}\n${fn('inboxRunConversationSwitch', threadSrc)}\n${fn('loadConvDetail', threadSrc)}\n${fn('inboxContextInstallFetchHook', contextSrc)}\n${fn('inboxContextFill', contextSrc)}\ninboxContextInstallFetchHook(); this.loadConvDetail = loadConvDetail; this.renderInbox = renderInbox; this.inboxRunConversationSwitch = inboxRunConversationSwitch; this.inboxContextFill = inboxContextFill;`,
      sandbox
    );
    return { sandbox, detail, sidebar, list, pending, transitions };
  }

  {
    const r = loadRuntime();
    r.sandbox.selectedConvId = 'A';
    r.detail.innerHTML = '<div>Guest A</div><div>message A</div><aside>Guest A context</aside>';
    r.sandbox.inboxRunConversationSwitch('B');
    await flush();
    ok('Wolfhouse conversation switch snapshots the previous deck',
      r.transitions.length === 1 && r.transitions[0].snapshot.includes('Guest A context'));
    ok('Wolfhouse keeps CURRENT painted while B is pending',
      r.transitions[0] && r.transitions[0].settled === false);
    r.pending.B.resolve(response('B')); await flush();
    ok('Wolfhouse commits thread + guest identity together when B is ready',
      r.transitions[0].settled === true && r.detail.innerHTML.includes('Guest B') && r.detail.guest === 'Guest B',
      r.detail.innerHTML);
  }
  {
    const r = loadRuntime();
    r.sandbox.selectedConvId = 'A';
    r.detail.innerHTML = '<div>Guest A</div><div>message A</div><aside>Guest A context</aside>';
    r.sandbox.inboxRunConversationSwitch('B'); await flush();
    r.sandbox.inboxRunConversationSwitch('C'); await flush();
    ok('rapid A→B→C reuses the A snapshot (does not paint B loading)',
      r.transitions.length === 1 && r.transitions[0].snapshot.includes('Guest A context'));
    r.pending.C.resolve(response('C')); await flush();
    ok('rapid switch commits only C as one complete deck',
      r.transitions[0].settled === true && r.sandbox.selectedConvId === 'C'
      && r.detail.innerHTML.includes('Guest C') && r.detail.guest === 'Guest C');
    r.pending.B.resolve(response('B')); await flush();
    ok('late B cannot steal selected-person identity after C',
      r.sandbox.selectedConvId === 'C' && r.detail.innerHTML.includes('Guest C') && r.detail.guest === 'Guest C');
  }
  {
    const r = loadRuntime();
    r.sandbox.loadConvDetail('A'); r.sandbox.loadConvDetail('B');
    r.pending.B.resolve(response('B')); await flush();
    r.pending.A.resolve(response('A')); await flush();
    ok('delayed A cannot replace B thread or guest card',
      r.detail.innerHTML.includes('Guest B') && r.detail.guest === 'Guest B' && !r.detail.innerHTML.includes('Guest A'));
  }
  {
    const r = loadRuntime();
    r.sandbox.loadConvDetail('A'); r.sandbox.loadConvDetail('B');
    r.pending.B.resolve(response('B')); await flush();
    r.pending.A.reject(new Error('A failed')); await flush();
    ok('stale A error cannot replace B or paint an error over identity',
      r.detail.innerHTML.includes('Guest B') && !r.detail.innerHTML.includes('A failed'));
  }
  {
    const r = loadRuntime();
    r.sandbox.selectedConvId = 'A'; r.detail.innerHTML = 'Guest A';
    let loads = 0; r.sandbox.loadConvDetail = () => { loads += 1; };
    r.sandbox.renderInbox([{ conversation_id: 'B' }]);
    ok('empty/filter removal clears the selected person',
      r.sandbox.selectedConvId === null && r.detail.innerHTML.includes('select a conversation') && !r.detail.guest);
    ok('empty filter does not auto-open the first leftover row', loads === 0);
  }

  console.log('\n── stay off ──');
  ok('package.json not modified / not registered',
    gitDiff('package.json') === ''
    && !fs.readFileSync(PACKAGE_PATH, 'utf8').includes('verify-inbox-wolfhouse-parity-001'));
  ok("Crow's Nest page not modified", gitDiff('scripts/lib/crowsnest/crowsnest-page.js') === '');
  ok('Admin Email settings UI not modified', gitDiff('scripts/browser/sunset-admin-email-settings-ui.js') === '');
  ok('inbox-columns.js WIDTHS not modified', gitDiff('scripts/browser/inbox-columns.js') === '');
  ok('old hide/reveal CSS stays gone',
    !/#inbox-shell\.inbox-folder-switching\{[\s\S]{0,80}visibility:hidden/.test(apiSrc));

  if (fail) {
    console.error(`\nFAILED ${fail}  passed ${pass}`);
    process.exit(1);
  }
  console.log(`\nOK ${pass} checks`);
})().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
