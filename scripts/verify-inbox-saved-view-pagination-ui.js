'use strict';

/**
 * verify-inbox-saved-view-pagination-ui
 *
 * Offline gate for PEOPLE-LIST-PAGINATION-001. Proves the saved-view People
 * list honors has_more / next_cursor and appends a second page through the
 * existing list renderer instead of stopping at the first limit=50 page.
 *
 * Run:
 *   node scripts/verify-inbox-saved-view-pagination-ui.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const VIEWS_PATH = path.join(ROOT, 'scripts', 'browser', 'inbox-views.js');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const src = fs.readFileSync(VIEWS_PATH, 'utf8');
const apiSrc = fs.readFileSync(API_PATH, 'utf8');

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

class FakeElement {
  constructor(id) {
    this.id = id || '';
    this.dataset = {};
    this.children = [];
    this.parentNode = null;
    this.innerHTML = '';
    this.textContent = '';
    this.disabled = false;
    this.type = '';
    this.className = '';
    this.style = { display: '' };
    this.classList = {
      add() {},
      remove() {},
      toggle() {},
    };
    this._listeners = {};
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  addEventListener(type, fn) { this._listeners[type] = fn; }
  querySelector() { return null; }
  querySelectorAll(selector) {
    if (selector === '.inbox-views-load-more') {
      return this.children.filter((child) => child.className === 'inbox-views-load-more');
    }
    if (selector === '.conv-card') return [];
    return [];
  }
  closest() { return null; }
  setAttribute() {}
  removeAttribute() {}
}

function rows(prefix, count) {
  return Array.from({ length: count }, (_, i) => ({
    key: `${prefix}-${i + 1}`,
    conversation_id: `${prefix}-${i + 1}`,
    display_name: `${prefix} Person ${i + 1}`,
    source: 'customers',
  }));
}

async function runHarness() {
  const elements = {
    'inbox-views-rail': new FakeElement('inbox-views-rail'),
    'conv-list': new FakeElement('conv-list'),
    'inbox-state': new FakeElement('inbox-state'),
    'detail-content': new FakeElement('detail-content'),
  };
  const fetchUrls = [];
  const appliedLengths = [];
  const context = {
    console,
    Promise,
    setTimeout,
    selectedConvId: null,
    inboxFilter: 'all',
    inboxConversationsCache: null,
    inboxLivePollActive: false,
    inboxListPollInFlight: false,
    INBOX_DEFAULT_SAVED_VIEW: 'all',
    document: {
      createElement: () => new FakeElement(),
      querySelectorAll: () => [],
    },
    el: (id) => elements[id] || null,
    escHtml: (value) => String(value == null ? '' : value),
    portalT: (key) => key,
    fmtTs: () => '',
    inboxClientQuery: () => '?client=sunset',
    getClient: () => 'sunset',
    getPortalProfile: () => ({}),
    mergeSurfInboxConversations: (liveRows) => liveRows,
    updateInboxFilterUI: () => {},
    inboxEmptyDetailHtml: () => '<empty-detail>',
    hideInboxMobileThread: () => {},
    renderInboxSchoolContext: () => {},
    isInboxTabVisible: () => true,
    setInboxLiveStatus: () => {},
    applyInboxFilter: function applyInboxFilter() {
      appliedLengths.push((context.inboxConversationsCache || []).length);
    },
    loadConvDetail: () => {},
    loadInbox: () => {},
    pollInboxConversationListLive: () => {},
    fetch: async (url) => {
      fetchUrls.push(url);
      if (url.startsWith('/staff/inbox/views')) {
        return { ok: true, json: async () => ({ success: true, groups: [], views: [{ id: 'all_people', group: 'people', count: 288 }] }) };
      }
      if (url.includes('/staff/inbox/list') && !url.includes('cursor=')) {
        return { ok: true, status: 200, json: async () => ({ success: true, rows: rows('page1', 50), has_more: true, next_cursor: 'cursor-page-2' }) };
      }
      if (url.includes('/staff/inbox/list') && url.includes('cursor=cursor-page-2')) {
        return { ok: true, status: 200, json: async () => ({ success: true, rows: rows('page2', 12), has_more: false, next_cursor: null }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  };
  vm.createContext(context);
  vm.runInContext(src, context, { filename: VIEWS_PATH });
  context.inboxSavedViewId = 'all_people';

  await context.loadInboxFromSavedView(null, {});
  ok('first saved-view page renders the API limit page', appliedLengths[0] === 50, `lengths=${appliedLengths.join(',')}`);
  ok('first page records has_more and next_cursor', context.inboxSavedViewHasMore === true && context.inboxSavedViewNextCursor === 'cursor-page-2');
  ok('first page paints one Load more control', elements['conv-list'].querySelectorAll('.inbox-views-load-more').length === 1);

  await context.loadInboxSavedViewNextPage();
  ok('next page fetch includes the returned cursor', fetchUrls.some((url) => /cursor=cursor-page-2/.test(url)), fetchUrls.join('\n'));
  ok('second page appends instead of replacing', appliedLengths.includes(62), `lengths=${appliedLengths.join(',')}`);
  ok('pagination-expanded state is set after a Load more append', context.inboxSavedViewExpanded === true);
  const beforePollLength = appliedLengths[appliedLengths.length - 1];
  context.inboxLivePollActive = true;
  context.pollInboxSavedViewListLive();
  ok('live poll does not collapse an expanded People list back to page 1', appliedLengths[appliedLengths.length - 1] === beforePollLength);
  ok('final page clears pagination state', context.inboxSavedViewHasMore === false && context.inboxSavedViewNextCursor === null);
  ok('Load more control disappears after final page', elements['conv-list'].querySelectorAll('.inbox-views-load-more').length === 0);
}

(async () => {
  console.log('\nverify-inbox-saved-view-pagination-ui — People saved-view pagination\n');
  console.log('── static contract ──');
  ok('list URL can carry cursor=', /function inboxSavedViewListUrl\(viewId, cursor\)[\s\S]*cursor=/.test(src));
  ok('loadInboxFromSavedView consumes has_more / next_cursor', src.includes('updateInboxSavedViewPagination(data, false)'));
  ok('Load more fetch appends rows with cursor', src.includes('function loadInboxSavedViewNextPage(')
    && src.includes('updateInboxSavedViewPagination(data, true)'));
  ok('Load more styling is in the staff portal stylesheet', apiSrc.includes('.inbox-views-load-more-btn'));

  console.log('\n── dynamic harness ──');
  await runHarness();

  console.log('\n' + '─'.repeat(58));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error('verify-inbox-saved-view-pagination-ui — FAILED');
    process.exit(1);
  }
  console.log('verify-inbox-saved-view-pagination-ui — ALL CHECKS PASSED');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
