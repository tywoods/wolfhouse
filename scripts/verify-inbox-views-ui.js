'use strict';

/**
 * verify:inbox-views-ui
 *
 * Offline wiring gate for the Inbox saved-view rail (Phase 1 UI slice).
 *
 * Proves:
 *   - scripts/browser/inbox-views.js is injected at INJECT:inbox-views
 *   - the rail fetches GET /staff/inbox/views via inboxClientQuery()
 *   - the list fetch is GET /staff/inbox/list and includes view=
 *   - counts are rendered from the views API payload, not a client-side dump
 *   - the new module does not fan out to /staff-state or /staff/conversations
 *   - conversation click still calls loadConvDetail (owned by inbox-thread.js)
 *   - Customers tab remains; inbox-thread.js and inbox-luna-mode.js are untouched
 *
 * No database, no network, no browser.
 *
 * Run:
 *   node scripts/verify-inbox-views-ui.js
 */

const fs = require('fs');
const path = require('path');

const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');
const {
  VIEWS_MODULE,
  INBOX_VIEWS_INJECT_MARKER,
  injectInboxBrowserModules,
} = require('./lib/inbox-browser-source');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const THREAD_MODULE = path.join(ROOT, 'scripts', 'browser', 'inbox-thread.js');
const LUNA_MODE_MODULE = path.join(ROOT, 'scripts', 'browser', 'inbox-luna-mode.js');
const LAYOUT_MODULE = path.join(ROOT, 'scripts', 'browser', 'inbox-shell.js');

const viewsSrc = fs.readFileSync(VIEWS_MODULE, 'utf8');
const threadSrc = fs.readFileSync(THREAD_MODULE, 'utf8');
const injectorSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'inbox-browser-source.js'), 'utf8');
const apiSrc = fs.readFileSync(API_PATH, 'utf8');
const uiSrc = readStaffPortalUiSource();

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

console.log('\nverify:inbox-views-ui — saved-view rail wiring\n');

console.log('── injection ──');
ok('inbox-views.js exists', fs.existsSync(VIEWS_MODULE));
ok('inject marker is in the portal template', apiSrc.includes(INBOX_VIEWS_INJECT_MARKER));
ok('injector maps the views module onto the marker',
  /INBOX_VIEWS_INJECT_MARKER/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'inbox-browser-source.js'), 'utf8'))
  && /getInboxViewsBrowserSource/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'inbox-browser-source.js'), 'utf8')));
ok('rail mount exists in the Conversations column',
  /id="inbox-views-rail"/.test(apiSrc) && /class="inbox-views-rail"/.test(apiSrc));
ok('rail is owned by column 1 and remains adjacent to the conversation-list column',
  /id="inbox-col1"[\s\S]{0,1000}id="inbox-views-rail"[\s\S]{0,1000}id="inbox-card"/.test(apiSrc));

{
  const injected = injectInboxBrowserModules(`before\n${INBOX_VIEWS_INJECT_MARKER}\nafter\n`);
  ok('injector splices the views module over the marker',
    injected.includes('function inboxSavedViewsUrl(')
    && injected.includes('function inboxSavedViewListUrl(')
    && !injected.includes(INBOX_VIEWS_INJECT_MARKER));
}

console.log('\n── fetches ──');
ok('views fetch URL is GET /staff/inbox/views + inboxClientQuery()',
  viewsSrc.includes("return '/staff/inbox/views' + inboxClientQuery();")
  || viewsSrc.includes("'/staff/inbox/views' + inboxClientQuery()"));
ok('list fetch URL is GET /staff/inbox/list',
  viewsSrc.includes("'/staff/inbox/list' + inboxClientQuery()"));
ok('list fetch includes view=',
  viewsSrc.includes("'&view=' + encodeURIComponent("));
ok('tenant client= query is preserved via inboxClientQuery()',
  /inboxSavedViewsUrl[\s\S]*inboxClientQuery\(/.test(viewsSrc)
  && /inboxSavedViewListUrl[\s\S]*inboxClientQuery\(/.test(viewsSrc));
ok('new module does not fetch /staff/conversations',
  !viewsSrc.includes('/staff/conversations'));
ok('new module does not fan out to /staff-state',
  !viewsSrc.includes('/staff-state') && !viewsSrc.includes('staff_state'));
ok('combined portal UI still has the views fetch',
  uiSrc.includes("'/staff/inbox/views' + inboxClientQuery()"));
ok('combined portal UI still has list?view=',
  uiSrc.includes("'/staff/inbox/list' + inboxClientQuery()")
  && uiSrc.includes("'&view=' + encodeURIComponent("));
ok('combined portal UI has no new /staff-state fan-out in the views module',
  !viewsSrc.includes('/staff-state') && !viewsSrc.includes('staff_state'));

console.log('\n── counts and mapping ──');
ok('rail counts render view.count from the API',
  viewsSrc.includes('view.count') && viewsSrc.includes('inbox-views-item-count'));
ok('hq-badge count comes from the views payload, not a filtered dump',
  viewsSrc.includes("list[i].id === 'needs_human'")
  && viewsSrc.includes('applyInboxViewCounts')
  && !/inboxConversationsCache\.filter\(conversationNeedsHuman\)/.test(viewsSrc));
ok('person-rows map onto the existing card shape',
  viewsSrc.includes('function mapInboxPersonRowToConv(')
  && viewsSrc.includes('guest_name: row.display_name')
  && viewsSrc.includes('conversation_id: row.conversation_id'));
ok('mapped rows go through renderInbox via applyInboxFilter',
  viewsSrc.includes('applyInboxFilter(opts')
  && viewsSrc.includes('applyInboxSavedViewRows'));
ok('clicking a view refetches the list for that view id',
  viewsSrc.includes('function selectInboxSavedView(')
  && viewsSrc.includes('inboxSavedViewId = viewId')
  && viewsSrc.includes('loadInboxFromSavedView'));

console.log('\n── stay off competing PRs ──');
ok('loadConvDetail is still defined only in inbox-thread.js',
  /function loadConvDetail\(/.test(threadSrc) && !/function loadConvDetail\(/.test(viewsSrc));
ok('views module calls loadConvDetail, does not rewrite it',
  viewsSrc.includes('loadConvDetail(selectConvIdAfterLoad)')
  && !/function\s+renderInbox\s*\(/.test(viewsSrc)
  && !/function\s+renderInboxConvCardHtml\s*\(/.test(viewsSrc));
ok('Luna mode composes ahead of thread while saved views keep their own marker',
  fs.existsSync(LUNA_MODE_MODULE)
  && injectorSrc.includes("return getInboxLunaModeBrowserSource() + '\\n' + readBrowserModule(THREAD_MODULE)")
  && injectorSrc.includes('getInboxViewsBrowserSource()'));
ok('no competing inbox-shell.js column-layout module', !fs.existsSync(LAYOUT_MODULE));
ok('Customers tab is still in the Conversations toolbar',
  /data-view="customers"/.test(apiSrc)
  && /onclick="switchToTab\('customers'\)"/.test(apiSrc)
  && /data-i18n="nav\.tab\.customers"/.test(apiSrc));
ok('Customers tab panel is still present',
  /id="tab-customers"/.test(apiSrc) || /id='tab-customers'/.test(apiSrc) || /tab-customers/.test(apiSrc));

console.log('\n── wrap existing list loaders ──');
ok('loadInbox is wrapped to the saved-view list when the rail is mounted',
  viewsSrc.includes('var _inboxViewsLegacyLoadInbox = loadInbox')
  && viewsSrc.includes("if (!el('inbox-views-rail')) return _inboxViewsLegacyLoadInbox"));
ok('list poll is wrapped off /staff/conversations when the rail is mounted',
  viewsSrc.includes('var _inboxViewsLegacyPollList = pollInboxConversationListLive')
  && viewsSrc.includes('pollInboxSavedViewListLive'));

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:inbox-views-ui — FAILED');
  process.exit(1);
}
console.log('verify:inbox-views-ui — ALL CHECKS PASSED');
process.exit(0);
