'use strict';

/**
 * verify:inbox-list-timestamp
 *
 * INBOX-LIST-TIMESTAMP-001 — leftover P2.
 *
 * List row `.conv-card-time` must match the newest in-thread message
 * (same source renderInboxThreadMessagesHtml uses: fmtTs(m.created_at)),
 * not a stale conversations.updated_at / last_activity_label cache field.
 *
 * Example: Simulate Guest row showed “Aug 5” while the newest bubble was
 * Jul 14 (or “Luna • Jul 14”).
 *
 * Proves:
 *   - inbox-rows.js owns the rewrite (wrap of renderInboxConvCardHtml)
 *   - Simulate Guest: list time = newest message, not last_activity Aug 5
 *   - remembering thread messages updates the list label for that conv
 *   - no newest-message source → keep last_activity_label
 *   - inbox-thread.js and inbox-context.js are not edited
 *   - no email-settings / Graph / Skipper inbound from this module
 *
 * No database, no network, no browser.
 *
 * Run:
 *   node scripts/verify-inbox-list-timestamp.js
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

function fmtTs(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now - d;
    if (diffMs < 60000) return 'just now';
    if (diffMs < 3600000) return Math.floor(diffMs / 60000) + 'm ago';
    if (diffMs < 86400000) return Math.floor(diffMs / 3600000) + 'h ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch (_) {
    return String(ts);
  }
}

function loadFns() {
  const sandbox = {
    window: {},
    document: undefined,
    console,
    fmtTs,
    selectedConvId: 'sim-guest-1',
    inboxConversationsCache: [
      {
        conversation_id: 'sim-guest-1',
        guest_name: 'Simulate Guest',
        last_activity: '2026-08-05T12:00:00.000Z',
        last_activity_label: 'Aug 5',
      },
    ],
    escHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    t: (key) => key,
    portalT: (key) => key,
    renderInboxConvCardHtml: (c) => {
      return '<div class="conv-card" data-id="' + (c && c.conversation_id || '') + '">' +
        '<div class="conv-card-header-row">' +
          '<div class="conv-card-name">' + (c && c.guest_name || '—') + '</div>' +
        '</div>' +
        '<div class="conv-card-meta-row">' +
          (c && c.last_activity_label ? '<div class="conv-card-time">' + c.last_activity_label + '</div>' : '') +
        '</div>' +
      '</div>';
    },
    renderInboxThreadMessagesHtml: (msgs) => {
      return (msgs || []).map((m) => {
        const who = m && m.direction === 'out' ? 'Luna' : 'Guest';
        return who + ' • ' + fmtTs(m && m.created_at);
      }).join('|');
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${rowsSrc}\nthis.__inboxRows = window.__inboxRows;`, sandbox);
  return sandbox;
}

console.log('\nverify:inbox-list-timestamp — list row time = newest thread message\n');

console.log('── owner / stay-off ──');
ok('inbox-rows.js owns newest-message time rewrite',
  rowsSrc.includes('function inboxRowsRewriteTime(')
  && rowsSrc.includes('function inboxRowsNewestMessageAt(')
  && rowsSrc.includes('INBOX-LIST-TIMESTAMP-001')
  && rowsSrc.includes('inboxRowsRewriteTime(html, row)')
  && rowsSrc.includes('inboxRowsRememberThreadMessages('));
ok('wrap of renderInboxConvCardHtml still lives in inbox-rows',
  rowsSrc.includes('var _inboxRowsLegacyRenderConvCardHtml = renderInboxConvCardHtml')
  && rowsSrc.includes('inboxRowsWrapConvCardHtml(_inboxRowsLegacyRenderConvCardHtml(c, profile), c)')
  && rowsSrc.includes('inboxRowsWithNewestMessageTime(row)'));
ok('wrap of renderInboxThreadMessagesHtml remembers newest created_at',
  rowsSrc.includes('renderInboxThreadMessagesHtml._inboxRowsTimeWrapped')
  && rowsSrc.includes('inboxRowsRememberThreadMessages(convId, msgs)'));
ok('inbox-thread.js is not edited (still paints last_activity_label)',
  threadSrc.includes('function renderInboxConvCardHtml(')
  && threadSrc.includes('c.last_activity_label')
  && threadSrc.includes('conv-card-time')
  && !threadSrc.includes('function inboxRowsRewriteTime(')
  && !threadSrc.includes('INBOX-LIST-TIMESTAMP-001')
  && !threadSrc.includes('inboxRowsNewestMessageAt'));
ok('inbox-context.js is not edited (INBOX-STALE-PANE-001 unmerged)',
  !contextSrc.includes('INBOX-LIST-TIMESTAMP-001')
  && !contextSrc.includes('inboxRowsRewriteTime')
  && !contextSrc.includes('inboxRowsNewestMessageAt')
  && !contextSrc.includes('inboxRowsRememberThreadMessages')
  && !contextSrc.includes('inboxRowsWithNewestMessageTime'));
ok('thread bubbles still use fmtTs(m.created_at) in inbox-list.js (source of truth)',
  listSrc.includes('function renderInboxThreadMessagesHtml(')
  && listSrc.includes('fmtTs(m.created_at)'));
ok('staff-query-api.js has no new list-timestamp markup',
  !apiSrc.includes('INBOX-LIST-TIMESTAMP-001')
  && !apiSrc.includes('inboxRowsRewriteTime')
  && apiSrc.includes('INJECT:inbox-views'));
ok('no Graph sendMail / WhatsApp Cloud / email-settings from this module',
  !rowsSrc.includes('sendMail')
  && !rowsSrc.includes('graph.microsoft')
  && !rowsSrc.includes('email-settings')
  && !rowsSrc.includes('graphClient')
  && !rowsSrc.includes('inbound/Graph'));
ok('package.json and luna-all register this gate',
  pkg.scripts && pkg.scripts['verify:inbox-list-timestamp'] === 'node scripts/verify-inbox-list-timestamp.js'
  && lunaAllSrc.includes('verify-inbox-list-timestamp.js'));

console.log('\n── Simulate Guest ──');
const sandbox = loadFns();
const fns = sandbox.__inboxRows;
ok('__inboxRows exports time helpers',
  fns
  && typeof fns.wrapConvCardHtml === 'function'
  && typeof fns.timeLabel === 'function'
  && typeof fns.newestMessageAt === 'function'
  && typeof fns.rememberThreadMessages === 'function');

const NEWEST = '2026-07-14T18:22:00.000Z';
const STALE_ACTIVITY = '2026-08-05T12:00:00.000Z';
const simRow = {
  conversation_id: 'sim-guest-1',
  guest_name: 'Simulate Guest',
  last_activity: STALE_ACTIVITY,
  last_activity_label: 'Aug 5',
  messages: [
    { created_at: '2026-07-10T09:00:00.000Z', message_text: 'earlier', direction: 'in' },
    { created_at: NEWEST, message_text: 'newest in-thread', direction: 'out' },
  ],
};
const expected = fmtTs(NEWEST);
const staleLabel = fmtTs(STALE_ACTIVITY);

ok('newest-message helper picks Jul 14 over Aug 5 last_activity',
  fns && typeof fns.newestMessageAt === 'function' && fns.newestMessageAt(simRow) === NEWEST);
ok('time label matches fmtTs(newest message) — same as thread bubbles',
  fns && typeof fns.timeLabel === 'function'
  && fns.timeLabel(simRow) === expected
  && expected !== ''
  && expected !== 'Aug 5'
  && expected !== staleLabel);

{
  const wrapped = fns && typeof fns.wrapConvCardHtml === 'function'
    ? fns.wrapConvCardHtml(
      '<div class="conv-card" data-id="sim-guest-1">' +
        '<div class="conv-card-name">Simulate Guest</div>' +
        '<div class="conv-card-meta-row">' +
          '<div class="conv-card-time">Aug 5</div>' +
        '</div>' +
      '</div>',
      simRow,
    )
    : '';
  ok('Simulate Guest list timestamp matches newest message, not Aug 5 cache',
    wrapped.includes('>Simulate Guest<')
    && wrapped.includes('conv-card-time')
    && wrapped.includes('>' + expected + '<')
    && !wrapped.includes('>Aug 5<'),
    `got ${wrapped}`);
}

{
  const viaRender = sandbox.renderInboxConvCardHtml({
    conversation_id: 'sim-guest-1',
    guest_name: 'Simulate Guest',
    last_activity: STALE_ACTIVITY,
    last_activity_label: 'Aug 5',
    messages: simRow.messages,
  });
  ok('wrapped renderer paints newest-message time for Simulate Guest',
    viaRender.includes('>Simulate Guest<')
    && viaRender.includes('>' + expected + '<')
    && !viaRender.includes('>Aug 5<'),
    `got ${viaRender}`);
}

{
  const noMsgs = fns && typeof fns.wrapConvCardHtml === 'function'
    ? fns.wrapConvCardHtml(
      '<div class="conv-card" data-id="other">' +
        '<div class="conv-card-name">Hernan</div>' +
        '<div class="conv-card-time">2m</div>' +
      '</div>',
      {
        conversation_id: 'other',
        guest_name: 'Hernan',
        last_activity_label: '2m',
      },
    )
    : '';
  ok('rows without thread messages keep last_activity_label',
    noMsgs.includes('>2m<') && !noMsgs.includes(expected));
}

{
  const rememberRow = {
    conversation_id: 'sim-guest-1',
    guest_name: 'Simulate Guest',
    last_activity: STALE_ACTIVITY,
    last_activity_label: 'Aug 5',
  };
  const remembered = fns && typeof fns.rememberThreadMessages === 'function'
    ? fns.rememberThreadMessages('sim-guest-1', simRow.messages)
    : '';
  ok('rememberThreadMessages stores newest created_at',
    remembered === NEWEST);
  const afterOpen = fns && typeof fns.wrapConvCardHtml === 'function'
    ? fns.wrapConvCardHtml(
      '<div class="conv-card" data-id="sim-guest-1">' +
        '<div class="conv-card-name">Simulate Guest</div>' +
        '<div class="conv-card-time">Aug 5</div>' +
      '</div>',
      rememberRow,
    )
    : '';
  ok('after thread open, Simulate Guest list time uses remembered newest message',
    afterOpen.includes('>' + expected + '<')
    && !afterOpen.includes('>Aug 5<'),
    `got ${afterOpen}`);
  ok('list cache last_activity_label is patched to newest-message fmtTs',
    sandbox.inboxConversationsCache[0].last_activity_label === expected
    && sandbox.inboxConversationsCache[0].last_message_at === NEWEST);
}

{
  const threadOut = sandbox.renderInboxThreadMessagesHtml(simRow.messages);
  const newestBubble = 'Luna • ' + fmtTs(NEWEST);
  ok('thread html wrap still renders Luna • Jul 14 and remembers (same fmtTs source)',
    String(threadOut).indexOf(newestBubble) >= 0
    && fns && typeof fns.timeLabel === 'function'
    && fns.timeLabel({ conversation_id: 'sim-guest-1', last_activity_label: 'Aug 5' }) === expected);
}

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:inbox-list-timestamp — FAILED');
  process.exit(1);
}
console.log('verify:inbox-list-timestamp — ALL CHECKS PASSED');
process.exit(0);
