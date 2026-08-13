'use strict';

/**
 * verify:inbox-context
 *
 * Offline gate for Inbox mockup slice B — column 4 guest card.
 *
 * Proves:
 *   - scripts/browser/inbox-context.js is concatenated onto the views inject
 *     marker the same way inbox-whatsapp-draft.js rides the thread marker
 *   - the renderer dims zero-count sections, uses one scroll region, and never
 *     invents euro amounts when cents are missing
 *   - outstanding unpaid bookings default that section open
 *   - lessons / waivers / broadcasts are omitted when the thread payload lacks
 *     those arrays (no fake zeros)
 *   - stay-off paths are untouched: inbox-thread.js, staff-query-api.js,
 *     database/, infra/, inbox-approvals.js
 *
 * No database, no network, no browser.
 *
 * Run:
 *   node scripts/verify-inbox-context.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const {
  CONTEXT_MODULE,
  VIEWS_MODULE,
  INBOX_VIEWS_INJECT_MARKER,
  getInboxViewsBrowserSource,
  getInboxContextBrowserSource,
  injectInboxBrowserModules,
} = require('./lib/inbox-browser-source');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const THREAD_MODULE = path.join(ROOT, 'scripts', 'browser', 'inbox-thread.js');
const APPROVALS_MODULE = path.join(ROOT, 'scripts', 'browser', 'inbox-approvals.js');
const INJECTOR_PATH = path.join(ROOT, 'scripts', 'lib', 'inbox-browser-source.js');
const PKG_PATH = path.join(ROOT, 'package.json');
const LUNA_ALL_PATH = path.join(ROOT, 'scripts', 'verify-luna-all.js');

const contextSrc = fs.readFileSync(CONTEXT_MODULE, 'utf8');
const viewsSrc = fs.readFileSync(VIEWS_MODULE, 'utf8');
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
    portalT: (key) => ({
      'customers.tags.hot_lead': 'Hot lead',
      'customers.tags.surf_school': 'Courses',
      'customers.detail.createBooking': 'Create booking',
      'customers.editProfile': 'Edit profile',
      'inbox.detail.bookings.none': 'No bookings for this guest yet.',
      'inbox.detail.sidebar.hide': 'Hide bookings',
      'inbox.booking.openInCalendar': 'Open booking',
    }[key] || key),
    renderCollapsibleCustomerSection: (opts) => {
      opts = opts || {};
      return `<details class="customers-section customers-collapsible"${opts.open ? ' open' : ''}>` +
        `<summary class="customers-section-hdr customers-collapsible-summary">${opts.title || ''}</summary>` +
        `<div class="customers-section-body customers-collapsible-body">${opts.body || ''}</div>` +
        `</details>`;
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${contextSrc}\nthis.__inboxContext = window.__inboxContext;`, sandbox);
  return sandbox.window.__inboxContext;
}

console.log('\nverify:inbox-context — column 4 guest card\n');

console.log('── injection ──');
ok('inbox-context.js exists', fs.existsSync(CONTEXT_MODULE));
ok('no inbox-approvals.js in this slice', !fs.existsSync(APPROVALS_MODULE));
ok('injector maps context onto the views marker',
  injectorSrc.includes('CONTEXT_MODULE')
  && injectorSrc.includes('getInboxContextBrowserSource()')
  && injectorSrc.includes('readBrowserModule(VIEWS_MODULE) + \'\\n\' + getInboxContextBrowserSource()'));
ok('context rides the views inject the way whatsapp-draft rides thread',
  injectorSrc.includes('getInboxLunaModeBrowserSource() + \'\\n\' + getInboxWhatsAppDraftBrowserSource()')
  && injectorSrc.indexOf('getInboxViewsBrowserSource()') < injectorSrc.indexOf('getInboxBroadcastBrowserSource()'));
{
  const injected = injectInboxBrowserModules(`before\n${INBOX_VIEWS_INJECT_MARKER}\nafter\n`);
  ok('injector splices the guest-card renderer over the views marker',
    injected.includes('function inboxContextGuestCardHtml(')
    && injected.includes('id="inbox-guest-card"')
    && injected.includes('function inboxSavedViewsUrl(')
    && !injected.includes(INBOX_VIEWS_INJECT_MARKER));
}
ok('getInboxContextBrowserSource returns the module body',
  getInboxContextBrowserSource().includes('function inboxContextGuestCardHtml('));
ok('getInboxViewsBrowserSource concatenates context after views',
  getInboxViewsBrowserSource().indexOf('function mapInboxPersonRowToConv(') <
    getInboxViewsBrowserSource().indexOf('function inboxContextGuestCardHtml('));

console.log('\n── stay off ──');
ok('inbox-thread.js is not rewritten by this slice',
  threadSrc.includes('function loadConvDetail(')
  && threadSrc.includes('id="inbox-detail-sidebar"')
  && !threadSrc.includes('inbox-guest-card')
  && !threadSrc.includes('inboxContextGuestCardHtml'));
ok('staff-query-api.js has no new inject marker for context',
  !apiSrc.includes('INJECT:inbox-context')
  && apiSrc.includes('INJECT:inbox-views'));
ok('context module does not fetch /staff-state or invent a bookings API',
  !contextSrc.includes('/staff-state')
  && !contextSrc.includes('/staff/customers/')
  && contextSrc.includes('/staff/inbox/thread/'));
ok('context module does not open a booking form in the panel',
  !/openCreateBookingFromContact[\s\S]{0,80}sidebar/.test(contextSrc)
  && contextSrc.includes('openCreateBookingFromContact')
  && contextSrc.includes('openCustomerCardForPhone')
  && contextSrc.includes('inbox-open-booking-cal'));
ok('package.json and luna-all register this gate',
  pkg.scripts && pkg.scripts['verify:inbox-context'] === 'node scripts/verify-inbox-context.js'
  && /verify-inbox-context\.js/.test(lunaAllSrc));

console.log('\n── renderer ──');
const fns = loadFns();
ok('window.__inboxContext exports the renderer', !!(fns && typeof fns.guestCardHtml === 'function'));

{
  const html = fns.guestCardHtml({
    conversation: { guest_name: 'Marea Wolf', phone: '+34600000404' },
    bookings: [],
    tags: ['hot_lead', 'surf_school'],
  });
  ok('card shows name without a chevron in the stay zone',
    html.includes('Marea Wolf')
    && html.includes('inbox-guest-name')
    && html.includes('inbox-guest-stay') === false);
  ok('tag line uses existing CRM labels',
    html.includes('Hot lead') && html.includes('Courses') && html.includes('inbox-guest-tags'));
  ok('zero bookings is dimmed, not given a fake euro amount',
    html.includes('is-zero')
    && html.includes('0 bookings')
    && !html.includes('€'));
  ok('exactly one guest-card scroller root',
    (html.match(/id="inbox-guest-card"/g) || []).length === 1
    && html.includes('class="inbox-guest-card"')
    && !html.includes('inbox-booking-stack'));
  ok('create booking and edit profile are deep-links, not a form',
    html.includes('id="inbox-create-booking-for-guest"')
    && html.includes('id="inbox-edit-profile"')
    && !html.includes('<form')
    && !html.includes('cust-edit-name'));
}

{
  const html = fns.guestCardHtml({
    conversation: { guest_name: 'Ada', phone: '+34600111222' },
    bookings: [{
      booking_id: 'bk-1',
      booking_code: 'WH-1',
      booking_status: 'checked_in',
      booking_payment_status: 'paid',
      check_in: '2026-08-07',
      check_out: '2026-08-10',
      assigned_room_code: '4',
      payment_amount_paid_cents: 13000,
      payment_amount_due_cents: 0,
    }, {
      booking_id: 'bk-2',
      booking_code: 'WH-2',
      booking_status: 'confirmed',
      booking_payment_status: 'unpaid',
      check_in: '2026-09-01',
      check_out: '2026-09-05',
      payment_amount_due_cents: 22500,
    }],
  }, { nowIso: '2026-08-08T12:00:00Z', expanded: {} });
  ok('current stay is plain facts: checked in, room + dates, paid',
    html.includes('Checked in')
    && html.includes('Room 4')
    && html.includes('7–10 Aug')
    && html.includes('Paid €130'));
  ok('bookings summary leads with count and due from real cents',
    html.includes('2 bookings') && html.includes('€225 due'));
  ok('collapsed booking row has dates/amount/payment and no STATUS/DATES labels',
    html.includes('inbox-guest-booking-summary')
    && html.includes('1–5 Sep')
    && html.includes('€225')
    && !/<summary[^>]*>[\s\S]*STATUS[\s\S]*<\/summary>/.test(html));
  ok('STATUS/DATES labels live only inside the expanded booking body',
    html.includes('inbox-guest-booking-body')
    && html.includes('<span class="k">Status</span>')
    && html.includes('<span class="k">Dates</span>'));
  ok('booking rows deep-link to the Bookings tab',
    html.includes('inbox-open-booking-cal')
    && html.includes('data-booking-id="bk-1"'));
  ok('outstanding unpaid booking defaults Bookings open',
    /data-inbox-context-section="bookings"[\s\S]*?<details[^>]*\sopen/.test(html));
  ok('notes without text are dimmed; lessons/waivers/broadcasts omitted when missing',
    html.includes('data-inbox-context-section="notes"')
    && html.includes('is-zero')
    && !html.includes('data-inbox-context-section="lessons"')
    && !html.includes('data-inbox-context-section="waivers"')
    && !html.includes('data-inbox-context-section="broadcasts"'));
}

{
  const missingMoney = fns.guestCardHtml({
    conversation: { guest_name: 'NoCents' },
    bookings: [{
      booking_id: 'bk-x',
      booking_status: 'confirmed',
      check_in: '2026-08-07',
      check_out: '2026-08-10',
    }],
  });
  ok('missing cents never mint a euro amount',
    !missingMoney.includes('€')
    && missingMoney.includes('1 booking')
    && !missingMoney.includes('due'));
  ok('sumDueCents is null when no booking carries due cents (not 0)',
    fns.sumDueCents([{ booking_code: 'WH-1' }]) === null
    && fns.sumDueCents([{ payment_amount_due_cents: 10000 }, { booking_code: 'WH-2' }]) === 10000
    && fns.euroFromCents(null) === null
    && fns.euroFromCents('') === null
    && fns.euroFromCents(undefined) === null);
}

{
  const withWaivers = fns.guestCardHtml({
    conversation: { guest_name: 'Surf' },
    bookings: [],
    waivers: [],
    lessons: [{ service_type: 'group_lesson', service_date: '2026-08-08' }],
    broadcasts: [],
  });
  ok('empty waiver/broadcast arrays dim; present lessons are counted from payload',
    withWaivers.includes('data-inbox-context-section="waivers"')
    && withWaivers.includes('0 waivers')
    && withWaivers.includes('data-inbox-context-section="broadcasts"')
    && withWaivers.includes('0 broadcasts')
    && withWaivers.includes('1 lesson')
    && withWaivers.includes('group lesson'));
}

ok('one scroll region is the guest card; collections do not nest overflow-y',
  /#inbox-detail-sidebar > \.inbox-guest-card\{[^}]*overflow-y:auto/.test(fns.CSS)
  && !/\.inbox-guest-collections\{[^}]*overflow-y\s*:\s*auto/.test(fns.CSS)
  && fns.CSS.includes('.inbox-guest-card .inbox-guest-collections')
  && fns.CSS.includes('overflow:visible'));

ok('list person-rows keep display_tags for the tag line',
  viewsSrc.includes('display_tags: row.display_tags || []'));

ok('wraps wireInboxSidebarToggle rather than rewriting loadConvDetail',
  contextSrc.includes('var legacy = wireInboxSidebarToggle')
  && !/function loadConvDetail\(/.test(contextSrc));

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:inbox-context — FAILED');
  process.exit(1);
}
console.log('verify:inbox-context — ALL CHECKS PASSED');
process.exit(0);
