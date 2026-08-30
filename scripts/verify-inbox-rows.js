'use strict';

/**
 * verify:inbox-rows
 *
 * Offline gate for Inbox mockup slice D — column 2 list rows.
 *
 * Proves:
 *   - scripts/browser/inbox-rows.js exists
 *   - injector concatenates rows after context on the views marker
 *     (final order: shell, views, context, rows)
 *   - wrap of renderInboxConvCardHtml exists (string check)
 *   - avatar initials helper: "Marea Wolf" → MW, empty → ?
 *   - needs_human list chip rewrites "Needs staff reply" → Needs human
 *     (EN/ES via existing raise key; unflagged / other reasons left alone)
 *   - inbox-thread.js is not edited (no avatar class from this slice)
 *   - staff-query-api.js has no new list markup; old filter chips remain
 *   - filter chips are hidden via CSS/class when the views rail is present
 *   - no Graph sendMail / WhatsApp Cloud send from this module
 *   - package.json + luna-all register the gate
 *
 * No database, no network, no browser.
 *
 * Run:
 *   node scripts/verify-inbox-rows.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const {
  ROWS_MODULE,
  CONTEXT_MODULE,
  VIEWS_MODULE,
  SHELL_MODULE,
  INBOX_VIEWS_INJECT_MARKER,
  getInboxViewsBrowserSource,
  getInboxRowsBrowserSource,
  getInboxContextBrowserSource,
  injectInboxBrowserModules,
} = require('./lib/inbox-browser-source');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const THREAD_MODULE = path.join(ROOT, 'scripts', 'browser', 'inbox-thread.js');
const INJECTOR_PATH = path.join(ROOT, 'scripts', 'lib', 'inbox-browser-source.js');
const PKG_PATH = path.join(ROOT, 'package.json');
const LUNA_ALL_PATH = path.join(ROOT, 'scripts', 'verify-luna-all.js');

const rowsSrc = fs.readFileSync(ROWS_MODULE, 'utf8');
const injectorSrc = fs.readFileSync(INJECTOR_PATH, 'utf8');
const threadSrc = fs.readFileSync(THREAD_MODULE, 'utf8');
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

function loadFns() {
  const sandbox = {
    window: {},
    document: undefined,
    console,
    escHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    t: (key) => {
      if (key === 'inbox.detail.needsHuman.raise') return 'Needs human';
      if (key === 'inbox.detail.meta.needsStaffReply') return 'Needs staff reply';
      return key;
    },
    portalT: (key) => {
      if (key === 'inbox.detail.needsHuman.raise') return 'Needs human';
      if (key === 'inbox.detail.meta.needsStaffReply') return 'Needs staff reply';
      return key;
    },
    renderInboxConvCardHtml: (c) => {
      const channel = (c && c.channel) === 'email' ? 'email' : 'whatsapp';
      const badge = `<span class="inbox-channel-badge inbox-channel-badge-${channel}">${channel === 'email' ? 'EMAIL' : 'WHATSAPP'}</span>`;
      const handoff = (c && c.needs_human)
        ? '<div class="conv-card-handoff">Needs staff reply</div>'
        : '';
      return '<div class="conv-card" data-id="' + (c && c.conversation_id || '') + '">' +
        '<div class="conv-card-header-row">' +
          '<div class="conv-card-name">' + (c && c.guest_name || '—') + '</div>' +
          badge +
        '</div>' +
        (c && c.last_message_preview ? '<div class="conv-card-preview">' + c.last_message_preview + '</div>' : '') +
        (c && c.last_activity_label ? '<div class="conv-card-time">' + c.last_activity_label + '</div>' : '') +
        handoff +
      '</div>';
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${rowsSrc}\nthis.__inboxRows = window.__inboxRows;`, sandbox);
  return sandbox;
}

console.log('\nverify:inbox-rows — column 2 list avatars / chips / people select\n');

console.log('── injection ──');
ok('inbox-rows.js exists', fs.existsSync(ROWS_MODULE));
ok('injector maps rows onto the views marker after context',
  injectorSrc.includes('ROWS_MODULE')
  && injectorSrc.includes('getInboxRowsBrowserSource()')
  && injectorSrc.includes("getInboxContextBrowserSource() + '\\n' + getInboxRowsBrowserSource()"));
ok('shell prepend and context append are preserved',
  injectorSrc.includes("getInboxShellBrowserSource() + '\\n' + readBrowserModule(VIEWS_MODULE)")
  && injectorSrc.includes("readBrowserModule(VIEWS_MODULE) + '\\n' + getInboxContextBrowserSource()"));
{
  const views = getInboxViewsBrowserSource();
  ok('final views inject order is shell, views, context, rows',
    views.indexOf('function mountInboxShellChrome(') < views.indexOf('function mapInboxPersonRowToConv(')
    && views.indexOf('function mapInboxPersonRowToConv(') < views.indexOf('function inboxContextGuestCardHtml(')
    && views.indexOf('function inboxContextGuestCardHtml(') < views.indexOf('function inboxRowInitials('));
}
{
  const injected = injectInboxBrowserModules(`before\n${INBOX_VIEWS_INJECT_MARKER}\nafter\n`);
  ok('injector splices rows over the views marker',
    injected.includes('function inboxRowInitials(')
    && injected.includes('function inboxRowsWrapConvCardHtml(')
    && injected.includes('function inboxContextGuestCardHtml(')
    && injected.includes('function inboxSavedViewsUrl(')
    && !injected.includes(INBOX_VIEWS_INJECT_MARKER));
}
ok('getInboxRowsBrowserSource returns the module body',
  getInboxRowsBrowserSource().includes('function inboxRowInitials(')
  && getInboxContextBrowserSource().includes('function inboxContextGuestCardHtml('));

console.log('\n── wrap ──');
ok('wrap of renderInboxConvCardHtml exists',
  rowsSrc.includes('var _inboxRowsLegacyRenderConvCardHtml = renderInboxConvCardHtml')
  && rowsSrc.includes('renderInboxConvCardHtml = function(c, profile)')
  && rowsSrc.includes('inboxRowsWrapConvCardHtml(_inboxRowsLegacyRenderConvCardHtml(c, profile), c)'));

console.log('\n── stay off ──');
ok('inbox-thread.js source is not edited (no avatar class from this slice)',
  threadSrc.includes('function renderInboxConvCardHtml(')
  && threadSrc.includes('function loadConvDetail(')
  && !threadSrc.includes('inbox-row-avatar')
  && !threadSrc.includes('inboxRowInitials')
  && !threadSrc.includes('inbox-legacy-filters-hidden'));
ok('staff-query-api.js has no new list markup',
  !apiSrc.includes('inbox-row-avatar')
  && !apiSrc.includes('inbox-filter-this-view')
  && !apiSrc.includes('INJECT:inbox-rows')
  && apiSrc.includes('INJECT:inbox-views'));
ok('old Conversations filter chips remain in the API template',
  apiSrc.includes('class="inbox-filter-btn')
  && apiSrc.includes('data-inbox-filter="all"')
  && apiSrc.includes('data-inbox-filter="needs-human"')
  && /All Conversations/.test(apiSrc));
ok('Customers tab and Pause Luna stay in the API template',
  /data-view="customers"/.test(apiSrc)
  && /Global Pause/.test(apiSrc));
ok('Reset Luna session and Full Wipe stay in inbox-thread.js (untouched)',
  threadSrc.includes('Reset Luna session')
  && threadSrc.includes('Full Wipe (testing)')
  && threadSrc.includes('btn-agent-session-reset')
  && threadSrc.includes('btn-guest-context-reset'));
ok('no Graph sendMail or WhatsApp Cloud send from this module',
  !/sendMail/.test(rowsSrc)
  && !/graph\.microsoft/.test(rowsSrc)
  && !/whatsapp.*\/messages/.test(rowsSrc)
  && !/_patched_whatsapp_cloud_send/.test(rowsSrc)
  && !/graphClient/.test(rowsSrc));
ok('package.json and luna-all register this gate',
  pkg.scripts && pkg.scripts['verify:inbox-rows'] === 'node scripts/verify-inbox-rows.js'
  && /verify-inbox-rows\.js/.test(lunaAllSrc));

console.log('\n── chips hidden via class, not deleted ──');
ok('filter chips hide via CSS/class when #inbox-views-rail is present',
  rowsSrc.includes('inbox-legacy-filters-hidden')
  && rowsSrc.includes("inboxRowsEl('inbox-views-rail')")
  && rowsSrc.includes('.inbox-filter-btn')
  && /inbox-legacy-filters-hidden[\s\S]*inbox-filter-btn/.test(rowsSrc)
  && rowsSrc.includes('function inboxRowsHideLegacyFilterChips('));

console.log('\n── renderer ──');
const sandbox = loadFns();
const fns = sandbox.__inboxRows;
ok('__inboxRows exports initials and wrap helpers',
  fns && typeof fns.initials === 'function' && typeof fns.wrapConvCardHtml === 'function');
ok('avatar initials: "Marea Wolf" → MW', fns.initials('Marea Wolf') === 'MW');
ok('avatar initials: empty → ?', fns.initials('') === '?' && fns.initials(null) === '?' && fns.initials(undefined) === '?');
ok('avatar initials: whitespace → ?', fns.initials('   ') === '?');

{
  const wrapped = sandbox.renderInboxConvCardHtml({
    conversation_id: 'c1',
    guest_name: 'Marea Wolf',
    channel: 'whatsapp',
    last_message_preview: 'is the 10am free',
    last_activity_label: '2m',
  });
  ok('on-load wrap prepends initials avatar and keeps time + badge',
    wrapped.includes('class="inbox-row-avatar"')
    && wrapped.includes('>MW</div>')
    && wrapped.includes('inbox-channel-badge')
    && wrapped.includes('WHATSAPP')
    && wrapped.includes('conv-card-time')
    && wrapped.includes('2m')
    && wrapped.includes('inbox-row-body'));
  ok('wrap does not invent unread without a real unread/last_read field',
    !wrapped.includes('inbox-row-unread')
    && !wrapped.includes('inbox-row-unread-dot'));
}

{
  const unreadCard = fns.wrapConvCardHtml(
    '<div class="conv-card" data-id="c2"><div class="conv-card-name">Hernan</div></div>',
    { guest_name: 'Hernan', unread: true },
  );
  ok('unread class only when the row already has a real unread field',
    unreadCard.includes('inbox-row-unread')
    && unreadCard.includes('inbox-row-unread-dot'));
  ok('needs_human alone does not fake unread',
    !fns.hasUnread({ needs_human: true, guest_name: 'X' })
    && !fns.wrapConvCardHtml(
      '<div class="conv-card" data-id="c3"><div class="conv-card-name">X</div></div>',
      { guest_name: 'X', needs_human: true },
    ).includes('inbox-row-unread'));
}

console.log('\n── needs_human list chip ──');
ok('rows module owns the Needs human chip rewrite (inbox-thread untouched)',
  rowsSrc.includes('function inboxRowsRewriteNeedsHumanChip(')
  && rowsSrc.includes("inbox.detail.needsHuman.raise")
  && rowsSrc.includes('inboxRowsRewriteNeedsHumanChip(String(html || \'\'), row)')
  && !threadSrc.includes('function inboxRowsRewriteNeedsHumanChip('));
ok('needs_human rows color the channel icon with Luna attention orange',
  rowsSrc.includes('inbox-row-needs-human')
  && rowsSrc.includes('#E8893A')
  && /inbox-row-needs-human[^}]*inbox-channel-badge\{color:#E8893A\}/.test(rowsSrc.replace(/\s+/g, ''))
  && !threadSrc.includes('inbox-row-needs-human'));
ok('label uses existing Needs human raise key (not invented ES strings)',
  rowsSrc.includes("'inbox.detail.needsHuman.raise'")
  && rowsSrc.includes("'inbox.detail.meta.needsStaffReply'")
  && !rowsSrc.includes('Requiere personal')
  && !rowsSrc.includes('Requiere respuesta del staff'));
{
  const flagged = fns.wrapConvCardHtml(
    '<div class="conv-card" data-id="tw"><div class="conv-card-name">Tyler Woods</div>' +
      '<div class="conv-card-handoff">Needs staff reply</div></div>',
    { guest_name: 'Tyler Woods', needs_human: true, conversation_id: 'tw' },
  );
  ok('needs_human row chip becomes Needs human (same as header)',
    flagged.includes('<div class="conv-card-handoff">Needs human</div>')
    && !flagged.includes('Needs staff reply')
    && flagged.includes('inbox-row-avatar'));
  ok('needs_human row marks channel icon attention class',
    flagged.includes('inbox-row-needs-human')
    && /class="[^"]*inbox-row-needs-human/.test(flagged));
  const viaRender = sandbox.renderInboxConvCardHtml({
    conversation_id: 'tw2',
    guest_name: 'Tyler Woods',
    needs_human: true,
    channel: 'email',
  });
  ok('wrapped renderer rewrites staff-reply chip on needs_human rows',
    viaRender.includes('<div class="conv-card-handoff">Needs human</div>')
    && !viaRender.includes('Needs staff reply'));
  ok('wrapped renderer oranges channel icon via inbox-row-needs-human',
    viaRender.includes('inbox-row-needs-human')
    && viaRender.includes('inbox-channel-badge'));
}
{
  const plain = fns.wrapConvCardHtml(
    '<div class="conv-card" data-id="c4"><div class="conv-card-name">Hernan</div>' +
      '<div class="conv-card-handoff">Needs staff reply</div></div>',
    { guest_name: 'Hernan', needs_human: false },
  );
  ok('unflagged rows leave the staff-reply chip alone',
    plain.includes('<div class="conv-card-handoff">Needs staff reply</div>')
    && !plain.includes('>Needs human</div>'));
  ok('unflagged rows keep default channel icon (no needs-human attention class)',
    !plain.includes('inbox-row-needs-human'));
  const otherReason = fns.wrapConvCardHtml(
    '<div class="conv-card" data-id="c5"><div class="conv-card-name">Ana</div>' +
      '<div class="conv-card-handoff">Payment question</div></div>',
    { guest_name: 'Ana', needs_human: true },
  );
  ok('other handoff reasons are not rewritten even when needs_human',
    otherReason.includes('<div class="conv-card-handoff">Payment question</div>')
    && !otherReason.includes('Needs human'));
  ok('needs_human still oranges the channel icon when handoff reason is custom',
    otherReason.includes('inbox-row-needs-human'));
}
{
  const esSandbox = {
    window: {},
    document: undefined,
    console,
    escHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    t: (key) => {
      if (key === 'inbox.detail.needsHuman.raise') return 'Requiere personal';
      if (key === 'inbox.detail.meta.needsStaffReply') return 'Requiere respuesta del staff';
      return key;
    },
  };
  esSandbox.window = esSandbox;
  vm.createContext(esSandbox);
  vm.runInContext(`${rowsSrc}\nthis.__inboxRows = window.__inboxRows;`, esSandbox);
  const esWrapped = esSandbox.__inboxRows.wrapConvCardHtml(
    '<div class="conv-card" data-id="es1"><div class="conv-card-name">Tyler</div>' +
      '<div class="conv-card-handoff">Requiere respuesta del staff</div></div>',
    { guest_name: 'Tyler', needs_human: true },
  );
  ok('ES uses existing raise key (Requiere personal), not invented copy',
    esWrapped.includes('<div class="conv-card-handoff">Requiere personal</div>')
    && !esWrapped.includes('Requiere respuesta del staff'));
}

console.log('\n-- channel icon unread / read / needs_human --');
{
  const compact = rowsSrc.replace(/\s+/g, '');
  ok('unread WhatsApp icon is green when not needs_human',
    compact.includes('.conv-card.inbox-row-unread:not(.inbox-row-needs-human).inbox-channel-badge-whatsapp{color:#25D366}'));
  ok('unread Email icon is Luna blue when not needs_human',
    compact.includes('.conv-card.inbox-row-unread:not(.inbox-row-needs-human).inbox-channel-badge-email{color:#3B7FB0}'));
  ok('needs_human orange still beats unread channel color',
    /inbox-row-needs-human[^}]*inbox-channel-badge\{color:#E8893A\}/.test(compact)
    && compact.includes('inbox-row-unread:not(.inbox-row-needs-human)'));
  ok('rows wrap paints prior card read + needs_human in place (stay off inbox-thread.js)',
    rowsSrc.includes('function inboxRowsPaintCardRead(')
    && rowsSrc.includes('function inboxRowsPaintCardNeedsHuman(')
    && rowsSrc.includes('function inboxRowsWrapIconState(')
    && rowsSrc.includes('inboxRowsPaintCardRead(prev)')
    && rowsSrc.includes('inboxRowsWrapIconState()')
    && !threadSrc.includes('inboxRowsPaintCardRead')
    && !threadSrc.includes('#25D366')
    && !threadSrc.includes('#3B7FB0'));
}

{
  const unreadWa = sandbox.renderInboxConvCardHtml({
    conversation_id: 'wa-unread',
    guest_name: 'Kai',
    channel: 'whatsapp',
    unread: true,
  });
  ok('unread WhatsApp row keeps badge class for green icon CSS',
    unreadWa.includes('inbox-row-unread')
    && unreadWa.includes('inbox-channel-badge-whatsapp')
    && !unreadWa.includes('inbox-row-needs-human'));
  const unreadEm = sandbox.renderInboxConvCardHtml({
    conversation_id: 'em-unread',
    guest_name: 'Lia',
    channel: 'email',
    unread: true,
  });
  ok('unread Email row keeps badge class for blue icon CSS',
    unreadEm.includes('inbox-row-unread')
    && unreadEm.includes('inbox-channel-badge-email')
    && !unreadEm.includes('inbox-row-needs-human'));
  const unreadNh = sandbox.renderInboxConvCardHtml({
    conversation_id: 'nh-unread',
    guest_name: 'Tyler Woods',
    channel: 'email',
    unread: true,
    needs_human: true,
  });
  ok('unread + needs_human still marks orange class (CSS :not keeps orange)',
    unreadNh.includes('inbox-row-unread')
    && unreadNh.includes('inbox-row-needs-human')
    && unreadNh.includes('inbox-channel-badge-email'));
}

{
  const cardClasses = new Set(['conv-card', 'inbox-row', 'inbox-row-unread']);
  let dotRemoved = false;
  const prior = {
    classList: {
      add(c) { cardClasses.add(c); },
      remove(c) { cardClasses.delete(c); },
      contains(c) { return cardClasses.has(c); },
    },
    getAttribute(name) { return name === 'data-id' ? 'prior' : ''; },
    querySelector(sel) {
      if (String(sel).indexOf('inbox-row-unread-dot') >= 0 && !dotRemoved) {
        return { parentNode: { removeChild() { dotRemoved = true; } } };
      }
      return null;
    },
  };
  const listEl = {
    querySelectorAll() { return [prior]; },
  };
  sandbox.document = {
    getElementById(id) { return id === 'conv-list' ? listEl : null; },
  };
  sandbox.inboxConversationsCache = [
    { conversation_id: 'prior', unread: true, unread_count: 2 },
    { conversation_id: 'next', unread: true },
  ];
  fns.paintCardRead('prior');
  ok('clicking another customer greys the prior row icon without replacing the list',
    !cardClasses.has('inbox-row-unread')
    && dotRemoved === true
    && sandbox.inboxConversationsCache[0].unread === false
    && sandbox.inboxConversationsCache[0].unread_count === 0
    && sandbox.inboxConversationsCache[1].unread === true);
  fns.paintCardNeedsHuman('prior', true);
  ok('needs_human paints the live card orange class without a full reload',
    cardClasses.has('inbox-row-needs-human'));
  fns.paintCardNeedsHuman('prior', false);
  ok('clearing needs_human drops the orange class in place',
    !cardClasses.has('inbox-row-needs-human'));

  const opened = [];
  sandbox.selectedConvId = 'prior';
  sandbox.loadConvDetail = function(id) {
    opened.push(id);
    sandbox.selectedConvId = id;
    return 'ok';
  };
  sandbox.updateInboxConvCardNeedsHuman = function(id, flag) { return { id: id, flag: flag }; };
  fns.wrapIconState();
  const out = sandbox.loadConvDetail('next');
  ok('loadConvDetail wrap greys the prior row then opens the next thread',
    out === 'ok'
    && opened.join(',') === 'next'
    && sandbox.loadConvDetail._inboxRowsIconStateWrapped === true
    && !cardClasses.has('inbox-row-unread'));
  sandbox.updateInboxConvCardNeedsHuman('next', true);
  ok('updateInboxConvCardNeedsHuman wrap is installed from rows (thread file untouched)',
    sandbox.updateInboxConvCardNeedsHuman._inboxRowsIconStateWrapped === true);
}

ok('conversation views do not invent a silent no-op search',
  rowsSrc.includes("source === 'customers'")
  && rowsSrc.includes('inboxRowsSearchSupported()')
  && /if \(!supported\)/.test(rowsSrc)
  && rowsSrc.includes('inbox-filter-this-view'));
ok('people multi-select reuses inboxBroadcastOpen rather than a new composer',
  rowsSrc.includes('typeof inboxBroadcastOpen === \'function\'')
  && rowsSrc.includes('inboxBroadcastOpen()')
  && !rowsSrc.includes('function inboxBroadcastOpen(')
  && !/POST \/staff\/broadcasts/.test(rowsSrc));
ok('checkboxes are gated on the active view multiSelect flag',
  rowsSrc.includes('inboxRowsMultiSelectActive()')
  && rowsSrc.includes('multi_select === true')
  && rowsSrc.includes('inbox-row-checkbox')
  && rowsSrc.includes('N selected') === false
  && rowsSrc.includes(' selected'));

ok('shell and views modules still exist on disk for the concat order',
  fs.existsSync(SHELL_MODULE) && fs.existsSync(VIEWS_MODULE) && fs.existsSync(CONTEXT_MODULE));

console.log('\n── ~1024px list density ──');
ok('list names allow wrap (2-line clamp) instead of single-line Sim… ellipsis',
  rowsSrc.includes('-webkit-line-clamp:2')
  && rowsSrc.includes('white-space:normal')
  && rowsSrc.includes('.inbox-row-body .conv-card-name{white-space:normal'));
ok('list timestamps stay on one line',
  rowsSrc.includes('.inbox-row-body .conv-card-time{flex:0 0 auto;white-space:nowrap')
  && rowsSrc.includes('.inbox-row-body .conv-card-meta-row{flex-wrap:nowrap'));
ok('md/compact gutters shrink on list rows',
  rowsSrc.includes('#inbox-shell[data-col2="compact"] .conv-card.inbox-row')
  && rowsSrc.includes('@media(max-width:1279px)')
  && rowsSrc.includes('#inbox-shell .conv-card.inbox-row{gap:8px;padding:8px 10px}'));

console.log('\n── Guest keep-card (INBOX-GUEST-KEEP-CARD-001) ──');
ok('rows wrap beginConvDetailLoad so Guest keeps the existing card',
  rowsSrc.includes('function inboxRowsWrapGuestKeepCard(')
  && rowsSrc.includes('function inboxRowsShouldKeepGuestCard(')
  && rowsSrc.includes('inboxRowsWrapGuestKeepCard()')
  && !threadSrc.includes('inboxRowsWrapGuestKeepCard'));
ok('Guest loading CSS keeps the card click-disabled, not a new skeleton',
  rowsSrc.includes('#detail-content.is-loading-detail .inbox-customer-card{pointer-events:none}'));
{
  const SKELETON = '<div class="sidebar-card-skeleton">Loading…</div>';
  const CARD = '<article class="inbox-customer-card is-full">Rami</article>';
  function makeEl(html) {
    let inner = html;
    const classes = new Set();
    return {
      classList: {
        add(c) { classes.add(c); },
        contains(c) { return classes.has(c); },
      },
      querySelector(sel) {
        return String(sel).indexOf('inbox-customer-card') >= 0 && inner.indexOf('inbox-customer-card') >= 0
          ? { className: 'inbox-customer-card' }
          : null;
      },
      get innerHTML() { return inner; },
      set innerHTML(v) { inner = String(v); },
    };
  }
  sandbox.inboxRowsRuntime.guestView = true;
  sandbox.beginConvDetailLoad = function(targetEl) {
    targetEl.innerHTML = SKELETON;
    targetEl.classList.add('is-loading-detail');
  };
  fns.wrapGuestKeepCard();
  const kept = makeEl(CARD);
  sandbox.beginConvDetailLoad(kept);
  ok('Guest switch does not replace the right card with Loading…',
    kept.innerHTML === CARD
    && kept.classList.contains('is-loading-detail')
    && sandbox.beginConvDetailLoad._inboxRowsGuestKeepCardWrapped === true);
  sandbox.inboxRowsRuntime.guestView = false;
  const full = makeEl(CARD);
  sandbox.beginConvDetailLoad(full);
  ok('non-Guest still uses the skeleton',
    full.innerHTML === SKELETON);
}

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:inbox-rows — FAILED');
  process.exit(1);
}
console.log('verify:inbox-rows — ALL CHECKS PASSED');
process.exit(0);
