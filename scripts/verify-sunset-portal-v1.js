'use strict';

/**
 * verify:sunset-portal-v1
 *
 * Offline checks for Sunset Staff Portal v1:
 * surf-school labels, demo home, hidden drawer tabs, lodging copy gating,
 * Wolfhouse preservation, no Wolfhouse first-load flash.
 *
 * Run:
 *   node scripts/verify-sunset-portal-v1.js
 *   npm run verify:sunset-portal-v1
 */

const fs = require('fs');
const path = require('path');

const {
  loadClientPortalProfile,
} = require('./lib/staff-portal-clients');

const ROOT = path.join(__dirname, '..');
const STAFF_API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const I18N_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js');

const WOLFHOUSE_LODGING = /\b(bed|room|hostel|move-bed|wolfhouse)\b/i;

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

console.log('\nverify:sunset-portal-v1 — Sunset portal v1 offline checks\n');

// ── 1. Sunset profile — drawer gating + default tab ─────────────────────────

console.log('[1] Sunset portal profile — surf labels + drawer gating');

const ss = loadClientPortalProfile('sunset');
assert('sunset default_tab is portal-home', ss.default_tab === 'portal-home', ss.default_tab);
assert('sunset hidden_drawer_tabs includes transfers', Array.isArray(ss.hidden_drawer_tabs)
  && ss.hidden_drawer_tabs.includes('transfers'), JSON.stringify(ss.hidden_drawer_tabs));
assert('sunset is_surf_vertical is true', ss.is_surf_vertical === true);
assert('sunset lesson_slots_demo has 3 slots', Array.isArray(ss.lesson_slots_demo)
  && ss.lesson_slots_demo.length >= 3, String(ss.lesson_slots_demo && ss.lesson_slots_demo.length));

// ── 2. Wolfhouse preservation ───────────────────────────────────────────────

console.log('\n[2] Wolfhouse portal profile — legacy defaults preserved');

const wh = loadClientPortalProfile('wolfhouse-somo');
assert('wolfhouse default_tab is bed-calendar', wh.default_tab === 'bed-calendar', wh.default_tab);
assert('wolfhouse hidden_drawer_tabs is empty', Array.isArray(wh.hidden_drawer_tabs)
  && wh.hidden_drawer_tabs.length === 0, JSON.stringify(wh.hidden_drawer_tabs));
assert('wolfhouse hidden_tabs is empty', Array.isArray(wh.hidden_tabs) && wh.hidden_tabs.length === 0);
assert('wolfhouse is_surf_vertical is false', wh.is_surf_vertical === false);

// ── 3. i18n — Inbox + surf empty states + demo home ─────────────────────────

console.log('\n[3] staff-portal-i18n.js — Inbox + surf + demo home copy');

if (fs.existsSync(I18N_PATH)) {
  const i18n = fs.readFileSync(I18N_PATH, 'utf8');
  assert('nav.tab.inbox key present', i18n.includes("'nav.tab.inbox': 'Inbox'"));
  assert('nav.tab.portalHome key present', i18n.includes("'nav.tab.portalHome'"));
  assert('nav.tab.whatsapp preserved for Wolfhouse', i18n.includes("'nav.tab.whatsapp': 'WhatsApp'"));
  assert('demoHome.schoolName key', i18n.includes("'demoHome.schoolName': 'Sunset Surf School'"));
  assert('demoHome.brand key', i18n.includes("'demoHome.brand': 'Luna Front Desk'"));
  assert('inbox.empty.main.surf key', i18n.includes("'inbox.empty.main.surf'"));
  assert('inbox.empty.sub.surf key', i18n.includes("'inbox.empty.sub.surf'"));
  assert('inbox.empty.list.surf key', i18n.includes("'inbox.empty.list.surf'"));
  assert('daySchedule.empty.surf key', i18n.includes("'daySchedule.empty.surf'"));
  assert('daySchedule.sub.surf key', i18n.includes("'daySchedule.sub.surf'"));
  assert('daySchedule.demoSlots.surf key', i18n.includes("'daySchedule.demoSlots.surf'"));
} else {
  assert('staff-portal-i18n.js exists', false);
}

// ── 4. staff-query-api.js — Slice 2A wiring markers ─────────────────────────

console.log('\n[4] staff-query-api.js — Slice 2A wiring markers');

let apiSrc = '';
if (fs.existsSync(STAFF_API_PATH)) {
  apiSrc = fs.readFileSync(STAFF_API_PATH, 'utf8');
  assert('portalT helper present', apiSrc.includes('function portalT('));
  assert('isDrawerTabHiddenForClient present', apiSrc.includes('function isDrawerTabHiddenForClient('));
  assert('inboxEmptyDetailHtml present', apiSrc.includes('function inboxEmptyDetailHtml('));
  assert('applySurfNavLabels present', apiSrc.includes('function applySurfNavLabels('));
  assert('nav.tab.inbox referenced', apiSrc.includes("'nav.tab.inbox'") || apiSrc.includes('"nav.tab.inbox"'));
  assert('hidden_drawer_tabs wired in drawer render', apiSrc.includes('isDrawerTabHiddenForClient(\'transfers\''));
  assert('move-bed gated for surf vertical', apiSrc.includes('if (!isSurf) {') && apiSrc.includes('ctx-move-bed'));
  assert('transfers tab conditional render', apiSrc.includes('if (!hideTransfers)'));
  assert('Wolfhouse transfers tab markup preserved', apiSrc.includes("bcDrawerTabBtn('transfers'"));
  assert('Wolfhouse whatsapp tab key preserved', apiSrc.includes('nav.tab.whatsapp'));
} else {
  assert('staff-query-api.js exists', false, STAFF_API_PATH);
}

// ── 5. No surf-only unconditional lodging removal for Wolfhouse ─────────────

console.log('\n[5] Wolfhouse drawer/transfers code paths preserved');

if (apiSrc) {
  assert('drawer.moveBed i18n key still referenced', apiSrc.includes('drawer.moveBed'));
  assert('drawer.tab.transfers i18n still referenced', apiSrc.includes('drawer.tab.transfers'));
  assert('bed-calendar tab still in markup', apiSrc.includes('data-tab="bed-calendar"'));
  assert('tour-operator tab still in markup', apiSrc.includes('data-tab="tour-operator"'));
}

// ── 6. Slice 2B — no Wolfhouse first-load flash ─────────────────────────────

console.log('\n[6] staff-query-api.js — profile-pending gate (no Wolfhouse flash)');

if (apiSrc) {
  assert('body starts with portal-profile-pending class', apiSrc.includes('class="portal-profile-pending"')
    || apiSrc.includes("class='portal-profile-pending'")
    || apiSrc.includes('body class="portal-profile-pending"'));
  assert('portal-profile-gate markup present', apiSrc.includes('id="portal-profile-gate"'));
  assert('setPortalProfilePending helper present', apiSrc.includes('function setPortalProfilePending('));
  assert('finishPortalProfileStartup helper present', apiSrc.includes('function finishPortalProfileStartup('));
  assert('CSS hides tabs/panels while pending', apiSrc.includes('body.portal-profile-pending #tabs')
    && apiSrc.includes('body.portal-profile-pending .tab-panel'));
  assert('bed-calendar tab not initially active in HTML', !reBedCalActive());
  assert('bed-calendar panel not initially active in HTML', !reBedCalPanelActive());
  assert('finishPortalProfileStartup called after startup', apiSrc.includes('finishPortalProfileStartup();'));
  assert('portalStartupAfterSession selects profile default_tab', apiSrc.includes('profile.default_tab || \'bed-calendar\''));
  assert('surf fallback tab is portal-home', apiSrc.includes("profile.is_surf_vertical ? 'portal-home' : 'bed-calendar'"));
  assert('no unconditional bcOnBedCalendarTabOpen on first paint', !reUnconditionalBcOpen());
  assert('no hardcoded sunset-staging URL checks', !apiSrc.includes('sunset-staging.lunafrontdesk.com'));
  assert('Wolfhouse bed-calendar path preserved after profile', apiSrc.includes('if (tab === \'bed-calendar\') bcOnBedCalendarTabOpen()')
    || apiSrc.includes("tab === 'bed-calendar') bcOnBedCalendarTabOpen()"));
}

// ── 7. Demo home landing (Sunset surf dashboard) ─────────────────────────────

console.log('\n[7] staff-query-api.js — Sunset demo home landing');

if (apiSrc) {
  assert('portal-home tab button present', apiSrc.includes('data-tab="portal-home"'));
  assert('portal-home tab panel present', apiSrc.includes('id="tab-portal-home"'));
  assert('loadPortalHome helper present', apiSrc.includes('function loadPortalHome('));
  assert('portal-home gated for surf vertical', apiSrc.includes("tab === 'portal-home' && !profile.is_surf_vertical"));
  assert('Schedule page wrap present', apiSrc.includes('portal-schedule-wrap'));
  assert('Schedule week view toggle present', apiSrc.includes('data-ps-view="week"'));
  assert('Schedule unpaid summary card', apiSrc.includes('schedule.card.unpaid'));
  assert('Schedule lessons today summary card', apiSrc.includes('schedule.card.lessonsToday'));
  assert('Schedule seats left summary card', apiSrc.includes('schedule.card.seatsLeft'));
  assert('Schedule need reply summary card', apiSrc.includes('schedule.card.needReply'));
  assert('Schedule week grid markup', apiSrc.includes('id="ps-week-grid"'));
  assert('schedule booking table present', apiSrc.includes('id="ps-booking-table"'));

  const homePanel = extractPortalHomePanel(apiSrc);
  if (homePanel) {
    assert('demo home panel has no lodging keywords', !WOLFHOUSE_LODGING.test(homePanel));
  } else {
    assert('demo home panel extractable', false);
  }
}

// ── 8. Shared email + WhatsApp inbox copy (Sunset surf only) ─────────────────

console.log('\n[8] Sunset demo home — shared email + WhatsApp inbox copy');

let i18nSrc = '';
if (fs.existsSync(I18N_PATH)) {
  i18nSrc = fs.readFileSync(I18N_PATH, 'utf8');
  const demoCopy = collectDemoHomeCopy(i18nSrc);
  assert('demoHome subtitle mentions guest emails and WhatsApp',
    i18nSrc.includes("'demoHome.subtitle'") && /Guest emails and WhatsApp/i.test(demoCopy));
  assert('demoHome inbox helper mentions email and WhatsApp',
    i18nSrc.includes("'demoHome.card.inbox.helper'") && /email/i.test(demoCopy) && /WhatsApp/i.test(demoCopy));
  assert('demoHome inbox helper leads with email',
    emailBeforeWhatsApp(extractI18nValue(i18nSrc, 'demoHome.card.inbox.helper')));
  assert('demoHome sidebar draft email replies',
    i18nSrc.includes("'demoHome.luna.item2': 'Draft email replies'"));
  assert('demoHome sidebar keep WhatsApp organized',
    i18nSrc.includes('Keep WhatsApp threads organized'));
  assert('demoHome sidebar flag unclear requests',
    i18nSrc.includes('Flag unclear requests for staff'));
  assert('demoHome shared inbox framing',
    i18nSrc.includes('One place for guest conversations'));
  assert('demoHome email and chat threads copy',
    /Email and chat threads/i.test(demoCopy));
  assert('inbox.empty.sub.surf mentions email and WhatsApp',
    /Guest emails and WhatsApp/i.test(extractI18nValue(i18nSrc, 'inbox.empty.sub.surf')));
  assert('inbox.empty.sub.surf not WhatsApp-only',
    !i18nSrc.includes("'inbox.empty.sub.surf': 'Guest WhatsApp threads"));
  assert('demoHome copy not email-only channel', /WhatsApp/i.test(demoCopy));
  assert('demoHome copy not WhatsApp-only channel', /email/i.test(demoCopy));
  assert('Wolfhouse whatsapp tab label unchanged', i18nSrc.includes("'nav.tab.whatsapp': 'WhatsApp'"));
} else {
  assert('staff-portal-i18n.js exists for shared inbox copy', false);
}

function collectDemoHomeCopy(src) {
  const keys = [
    'demoHome.subtitle',
    'demoHome.card.inbox.helper',
    'demoHome.luna.item1',
    'demoHome.luna.item2',
    'demoHome.luna.item3',
    'demoHome.luna.item4',
    'demoHome.luna.item5',
  ];
  return keys.map((k) => extractI18nValue(src, k)).join('\n');
}

function extractI18nValue(src, key) {
  const re = new RegExp("'" + key.replace(/\./g, '\\.') + "':\\s*'((?:\\\\'|[^'])*)'");
  const m = src.match(re);
  return m ? m[1] : '';
}

function emailBeforeWhatsApp(text) {
  const lower = String(text || '').toLowerCase();
  const emailIdx = lower.indexOf('email');
  const waIdx = lower.indexOf('whatsapp');
  return emailIdx >= 0 && waIdx >= 0 && emailIdx < waIdx;
}

function reBedCalActive() {
  if (!apiSrc) return false;
  const m = apiSrc.match(/<button class="tab-btn active" data-tab="bed-calendar"/);
  return !!m;
}

function reBedCalPanelActive() {
  if (!apiSrc) return false;
  const m = apiSrc.match(/<div id="tab-bed-calendar" class="tab-panel active"/);
  return !!m;
}

function reUnconditionalBcOpen() {
  if (!apiSrc) return false;
  return /\/\* Open Booking Calendar on first paint \*\/\s*\nbcOnBedCalendarTabOpen\(\);/.test(apiSrc);
}

function extractPortalHomePanel(src) {
  const start = src.indexOf('<div id="tab-portal-home"');
  if (start < 0) return '';
  const end = src.indexOf('<!-- /tab-portal-home -->', start);
  if (end < 0) return src.slice(start, start + 4000);
  return src.slice(start, end);
}


// ── 9. Customers tab (Sunset guest history v1) ────────────────────────────────

console.log('\n[9] staff-query-api.js — Customers tab (read-only v1)');

if (apiSrc) {
  assert('Customers tab button present', apiSrc.includes('data-tab="customers"'));
  assert('Customers tab panel present', apiSrc.includes('id="tab-customers"'));
  assert('customers tab surf-gated', apiSrc.includes("tab === 'customers' && !profile.is_surf_vertical"));
  assert('/staff/customers route present', apiSrc.includes("pathname === '/staff/customers'"));
  assert('nav.tab.customers in i18n usage', apiSrc.includes('nav.tab.customers') || apiSrc.includes('customers.title'));
}

if (fs.existsSync(I18N_PATH)) {
  const i18n = fs.readFileSync(I18N_PATH, 'utf8');
  assert('nav.tab.customers i18n key', i18n.includes("'nav.tab.customers': 'Customers'"));
}



// ── 10. Sunset Schedule page (Slice A) ──────────────────────────────────────

console.log('\n[10] Sunset Schedule page — week view + lesson capacity');

if (apiSrc) {
  assert('nav Schedule tab label in i18n', i18nSrc.includes("'nav.tab.portalHome': 'Schedule'")
    || /nav\.tab\.portalHome['\"]:\s*['\"]Schedule/.test(i18nSrc));
  assert('SUNSET_SCHEDULE_LESSON_DAY_CAP constant', apiSrc.includes('SUNSET_SCHEDULE_LESSON_DAY_CAP = 24'));
  assert('loadSchedulePage helper present', apiSrc.includes('function loadSchedulePage('));
  assert('schedule week grid present', apiSrc.includes('id="ps-week-grid"'));
  assert('schedule summary cards present', apiSrc.includes('id="ps-lessons-today"')
    && apiSrc.includes('id="ps-seats-left"'));
  assert('schedule view toggle week default', apiSrc.includes('data-ps-view="week"')
    && apiSrc.includes('portal-schedule-view-btn active'));
  assert('schedule booking filters present', apiSrc.includes('data-ps-filter="needs_reply"')
    && apiSrc.includes('data-ps-filter="unpaid"'));
  assert('schedule day seats cap helper', apiSrc.includes('function scheduleDayLessonCap('));
  assert('Wolfhouse portal-home still gated', apiSrc.includes("tab === 'portal-home' && !profile.is_surf_vertical"));
}

if (i18nSrc) {
  assert('schedule.card.lessonsToday i18n', i18nSrc.includes("'schedule.card.lessonsToday'"));
  assert('schedule.view.week i18n', i18nSrc.includes("'schedule.view.week': 'Week'"));
}


// ── 11. Sunset Admin tab (read-only skeleton) ────────────────────────────────

console.log('\n[11] Sunset Admin tab — read-only skeleton');

if (apiSrc) {
  assert('Admin tab button present', apiSrc.includes('data-tab="admin"'));
  assert('Admin tab panel present', apiSrc.includes('id="tab-admin"'));
  assert('admin tab surf-gated', apiSrc.includes("tab === 'admin' && !profile.is_surf_vertical"));
  assert('loadAdminTab helper present', apiSrc.includes('function loadAdminTab('));
  assert('Admin prices section', apiSrc.includes('admin.section.prices') || apiSrc.includes('admin-sec-prices'));
  assert('Admin capacity section', apiSrc.includes('admin.section.capacity') || apiSrc.includes('admin-sec-capacity'));
  assert('Admin lesson times section', apiSrc.includes('admin.section.lessonTimes') || apiSrc.includes('admin-sec-times'));
  assert('Admin business info section', apiSrc.includes('admin.section.businessInfo') || apiSrc.includes('admin-sec-business'));
  assert('Admin change history section', apiSrc.includes('admin.section.changeHistory') || apiSrc.includes('admin-sec-history'));
  assert('Admin read-only banner', apiSrc.includes('admin.banner.readOnly'));
  assert('Admin writes disabled copy', apiSrc.includes('admin.banner.writesDisabled'));
  assert('Admin save button disabled coming soon', apiSrc.includes('admin.action.saveComingSoon') && apiSrc.includes('disabled'));
  assert('Wolfhouse bed-calendar preserved', apiSrc.includes('data-tab="bed-calendar"'));
}

if (i18nSrc) {
  assert('nav.tab.admin i18n key', i18nSrc.includes("'nav.tab.admin': 'Admin'"));
  assert('admin.section.prices i18n', i18nSrc.includes("'admin.section.prices'"));
}


// ── 12. Sunset Admin config API (read-only read model) ───────────────────────

console.log('\n[12] Sunset Admin config API — read-only read model');

if (apiSrc) {
  assert('GET /staff/admin/config route', apiSrc.includes("pathname === '/staff/admin/config'"));
  assert('handleAdminConfig handler', apiSrc.includes('function handleAdminConfig('));
  assert('tenant-business-config import', apiSrc.includes("require('./lib/tenant-business-config')"));
  assert('Admin config read_only in audit', apiSrc.includes("intent: 'api:admin.config'") && apiSrc.includes('read_only: true'));
  assert('loadAdminTab fetches admin config', apiSrc.includes('/staff/admin/config?client='));
  assert('Admin fetch error fallback', apiSrc.includes('renderAdminFallback'));
  assert('unsupported_client 403 path', apiSrc.includes("'unsupported_client'"));
}

try {
  const tbc = require('./lib/tenant-business-config');
  assert('DEFAULT_DAILY_CAP export 24', tbc.DEFAULT_DAILY_CAP === 24);
  const sample = tbc.resolveTenantBusinessConfig('sunset');
  assert('resolver sunset read_only', sample.ok === true && sample.read_only === true);
  assert('resolver sunset cap 24', sample.lesson_capacity.default_daily_cap === 24);
  const wh = tbc.resolveTenantBusinessConfig('wolfhouse-somo');
  assert('resolver blocks wolfhouse', wh.ok === false && wh.reason === 'unsupported_client');
} catch (err) {
  assert('tenant-business-config module loads', false, err.message);
}


// ── Session-scoped client dropdown (Sunset-only staff) ─────────────────────

console.log('\n[9] Session-scoped client dropdown access');

const ACCESS_PATH_V1 = path.join(ROOT, 'config', 'clients', 'staff-portal-access.json');
const SUNSET_ACCESS_PATH_V1 = path.join(ROOT, 'config', 'clients', 'staff-portal-access.sunset-staging.json');

function slugsWithAccessFileV1(accessFile, email) {
  const bak = ACCESS_PATH_V1 + '.verify-bak';
  fs.copyFileSync(ACCESS_PATH_V1, bak);
  fs.copyFileSync(accessFile, ACCESS_PATH_V1);
  delete require.cache[require.resolve('./lib/staff-portal-clients')];
  const mod = require('./lib/staff-portal-clients');
  const slugs = mod.getAccessibleClientSlugs({ email, role: 'owner' });
  fs.copyFileSync(bak, ACCESS_PATH_V1);
  fs.unlinkSync(bak);
  delete require.cache[require.resolve('./lib/staff-portal-clients')];
  return slugs;
}

const whSlugsDefault = (() => {
  delete require.cache[require.resolve('./lib/staff-portal-clients')];
  const mod = require('./lib/staff-portal-clients');
  return mod.getAccessibleClientSlugs({ email: 'tywoods@gmail.com', role: 'owner' });
})();
assert('Default access config scopes tywoods@gmail.com to wolfhouse-somo only',
  whSlugsDefault.length === 1 && whSlugsDefault[0] === 'wolfhouse-somo',
  JSON.stringify(whSlugsDefault));

assert('Wolfhouse profile default_tab is bed-calendar',
  loadClientPortalProfile('wolfhouse-somo').default_tab === 'bed-calendar');
assert('Sunset profile default_tab is portal-home',
  loadClientPortalProfile('sunset').default_tab === 'portal-home');

if (fs.existsSync(SUNSET_ACCESS_PATH_V1)) {
  const sunsetSlugs = slugsWithAccessFileV1(SUNSET_ACCESS_PATH_V1, 'tywoods@gmail.com');
  assert('Sunset staff session clients is sunset only', sunsetSlugs.length === 1 && sunsetSlugs[0] === 'sunset',
    JSON.stringify(sunsetSlugs));
}

if (apiSrc) {
  assert('populateClientSelect wired to session clients', apiSrc.includes('staffPortalSession.clients'));
  assert('UI does not hardcode wolfhouse-somo dropdown fallback',
    !apiSrc.includes("{ slug: 'wolfhouse-somo', name: 'wolfhouse-somo' }"));
  assert('no hardcoded sunset-staging URL in dropdown logic', !apiSrc.includes('sunset-staging.lunafrontdesk.com'));
  assert('populateClientSelect ignores stale localStorage client slug',
    apiSrc.includes("localStorage.getItem('staff_portal_client')")
    && apiSrc.includes('!list.some(function(c){ return c.slug === pick; })'));

}



// ── Shared Inbox Slice 3A — channel badges + mock rows ───────────────────────

console.log('\n[10] Shared Inbox Slice 3A — Sunset email + WhatsApp inbox UI');

const ssInbox = loadClientPortalProfile('sunset');
assert('sunset profile has inbox_threads_demo', Array.isArray(ssInbox.inbox_threads_demo) && ssInbox.inbox_threads_demo.length >= 2,
  String(ssInbox.inbox_threads_demo && ssInbox.inbox_threads_demo.length));
assert('sunset inbox demo includes email channel',
  ssInbox.inbox_threads_demo.some((r) => r.channel === 'email'));
assert('sunset inbox demo includes whatsapp channel',
  ssInbox.inbox_threads_demo.some((r) => r.channel === 'whatsapp'));

if (fs.existsSync(I18N_PATH)) {
  const i18nSrc = fs.readFileSync(I18N_PATH, 'utf8');
  assert('inbox.badge.email i18n', i18nSrc.includes("'inbox.badge.email': 'Email'"));
  assert('inbox.badge.whatsapp i18n', i18nSrc.includes("'inbox.badge.whatsapp': 'WhatsApp'"));
  assert('inbox.filter.email i18n', i18nSrc.includes("'inbox.filter.email': 'Email'"));
  assert('inbox.filter.whatsapp i18n', i18nSrc.includes("'inbox.filter.whatsapp': 'WhatsApp'"));
  assert('inbox.preview.bannerTitle i18n', i18nSrc.includes("'inbox.preview.bannerTitle'"));
  assert('preview examples copy present', /Preview examples|preview examples/i.test(i18nSrc));
}

if (apiSrc) {
  assert('inbox channel badge markup', apiSrc.includes('inbox-channel-badge'));
  assert('inboxChannelBadgeHtml helper', apiSrc.includes('function inboxChannelBadgeHtml('));
  assert('surf inbox demo merge helper', apiSrc.includes('function mergeSurfInboxConversations('));
  assert('email subject row support', apiSrc.includes('conv-card-subject'));
  assert('preview banner markup', apiSrc.includes('inbox-preview-banner'));
  assert('applySurfInboxFilters surf-only filters', apiSrc.includes('function applySurfInboxFilters('));
  assert('demo preview detail loader', apiSrc.includes('function loadSurfInboxDemoDetail('));
  assert('no hardcoded sunset-staging URL in shared inbox', !apiSrc.includes('sunset-staging.lunafrontdesk.com'));
  assert('Wolfhouse whatsapp tab key preserved for shared inbox', i18nSrc.includes("'nav.tab.whatsapp': 'WhatsApp'"));
  assert('Wolfhouse inbox filter labels preserved in applySurfInboxFilters',
    apiSrc.includes("'inbox.filter.all': 'All Conversations'") || apiSrc.includes('inbox.filter.all'));
}

const whInbox = loadClientPortalProfile('wolfhouse-somo');
assert('Sunset staff Dockerfile sets DEFAULT_CLIENT_SLUG=sunset',
  fs.readFileSync(path.join(ROOT, 'Dockerfile.luna-sunset-staff-api'), 'utf8').includes('DEFAULT_CLIENT_SLUG=sunset'));
assert('Login page uses env-driven default company',
  apiSrc.includes('loginDefaultClient') && apiSrc.includes('DEFAULT_CLIENT_SLUG'));
assert('Inbox tab open loads conversation list',
  apiSrc.includes('ensureInboxLoadedForTab'));

assert('wolfhouse profile has no inbox_threads_demo rows', !whInbox.inbox_threads_demo || whInbox.inbox_threads_demo.length === 0,
  JSON.stringify(whInbox.inbox_threads_demo));


// ── Summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-portal-v1 — FAILED');
  process.exit(1);
}
console.log('verify:sunset-portal-v1 — ALL CHECKS PASSED');
