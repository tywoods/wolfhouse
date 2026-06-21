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
  assert('Schedule wetsuits summary card', apiSrc.includes('schedule.card.wetsuitsToday') && apiSrc.includes('id="ps-wetsuits-today"'));
  assert('Schedule surfboards summary card', apiSrc.includes('schedule.card.surfboardsToday') && apiSrc.includes('id="ps-surfboards-today"'));
  assert('Schedule lesson groups summary card', apiSrc.includes('schedule.card.lessonGroups') && apiSrc.includes('portal-schedule-lesson-times') && apiSrc.includes('id="ps-lessons-slot-sub"'));
  assert('Schedule need reply ops metric', apiSrc.includes('schedule.card.needReply') && apiSrc.includes('id="ps-need-reply-today"') && apiSrc.includes('id="ps-need-reply-sub"'));
  assert('old seats-left summary card removed', !apiSrc.includes('id="ps-seats-left"'));
  assert('old lessons-week summary card removed', !apiSrc.includes('id="ps-lessons-week"'));
  assert('old unpaid summary card removed', !apiSrc.includes('id="ps-unpaid"'));
  assert('Schedule week grid markup', apiSrc.includes('id="ps-week-grid"'));
  assert('ops board replaces booking table', apiSrc.includes('id="ps-ops-board"') && !apiSrc.includes('id="ps-booking-table"'));

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

console.log('\n[10] Sunset Schedule page — day ops view + lesson capacity');

if (apiSrc) {
  assert('nav Schedule tab label in i18n', i18nSrc.includes("'nav.tab.portalHome': 'Schedule'")
    || /nav\.tab\.portalHome['\"]:\s*['\"]Schedule/.test(i18nSrc));
  assert('SUNSET_SCHEDULE_LESSON_DAY_CAP constant', apiSrc.includes('SUNSET_SCHEDULE_LESSON_DAY_CAP = 24'));
  assert('loadSchedulePage helper present', apiSrc.includes('function loadSchedulePage('));
  assert('schedule week grid present', apiSrc.includes('id="ps-week-grid"'));
  assert('schedule summary cards present', apiSrc.includes('id="ps-wetsuits-today"')
    && apiSrc.includes('id="ps-surfboards-today"') && apiSrc.includes('id="ps-lessons-slot-sub"')
    && apiSrc.includes('id="ps-need-reply-today"') && apiSrc.includes('id="ps-unpaid-pending-today"'));
  assert('schedule view toggle today default', apiSrc.includes('data-ps-view="day"')
    && apiSrc.includes('portal-schedule-view-btn active'));
  assert('ops board layout markers', apiSrc.includes('portal-schedule-ops-board') && apiSrc.includes('portal-schedule-ops-lesson-group'));
  assert('schedule day seats cap helper', apiSrc.includes('function scheduleDayLessonCap('));
  assert('Wolfhouse portal-home still gated', apiSrc.includes("tab === 'portal-home' && !profile.is_surf_vertical"));
}

if (i18nSrc) {
  assert('schedule.card.lessonGroups i18n', i18nSrc.includes("'schedule.card.lessonGroups'"));
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
  assert('Admin writes gated by cfg.writes_enabled', apiSrc.includes('function adminCfgWritesEnabled('));
  assert('Admin edit controls hidden when writes off', apiSrc.includes('if (!adminCfgWritesEnabled(data)) adminEditTarget = null'));
  assert('Admin save message region', apiSrc.includes('id="admin-save-msg"'));
  assert('Admin legacy coming-soon buttons removed', !apiSrc.includes('admin.action.saveComingSoon'));
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




// ── 13. Sunset Admin write routes (flag-gated, default off) ───────────────────

console.log('\n[13] Sunset Admin write routes — flag-gated');

if (apiSrc) {
  assert('tenant-admin-writes import', apiSrc.includes("require('./lib/tenant-admin-writes')"));
  assert('PATCH admin price route', apiSrc.includes('adminPricePatchMatch') && apiSrc.includes("method === 'PATCH'"));
  assert('PUT admin lesson capacity route', apiSrc.includes("pathname === '/staff/admin/config/lesson-capacity'") && apiSrc.includes("method === 'PUT'"));
  assert('PATCH admin lesson time route', apiSrc.includes('adminLessonTimePatchMatch'));
  assert('write handlers present', apiSrc.includes('function handleAdminConfigPricePatch('));
  assert('writes flag check in GET config', apiSrc.includes('writes_enabled: isSunsetAdminWritesEnabled()'));
  assert('evaluateAdminWriteGate used', apiSrc.includes('evaluateAdminWriteGate'));
  assert('writes_disabled response path', require('fs').readFileSync('scripts/lib/tenant-admin-writes.js', 'utf8').includes("'writes_disabled'"));
  assert('admin write routes require admin role', apiSrc.includes("requireAuth(req, res, 'admin')") && apiSrc.includes('handleAdminConfigPricePatch'));
  assert('renderAdminWriteState helper', apiSrc.includes('function renderAdminWriteState('));
  assert('admin banner id for write state', apiSrc.includes('id="admin-write-banner"'));
}

try {
  const writes = require('./lib/tenant-admin-writes');
  const saved = process.env.SUNSET_ADMIN_WRITES_ENABLED;
  delete process.env.SUNSET_ADMIN_WRITES_ENABLED;
  assert('writes module default off', writes.isSunsetAdminWritesEnabled() === false);
  if (saved == null) delete process.env.SUNSET_ADMIN_WRITES_ENABLED;
  else process.env.SUNSET_ADMIN_WRITES_ENABLED = saved;
} catch (err) {
  assert('tenant-admin-writes module loads', false, err.message);
}



// ── 14. Sunset Admin edit UI (writes_enabled gated) ───────────────────────────

console.log('\n[14] Sunset Admin edit UI — writes_enabled gated');

if (apiSrc) {
  assert('wireAdminTab wired', apiSrc.includes('function wireAdminTab(') && apiSrc.includes("root.dataset.adminWired"));
  assert('admin PUT lesson-capacity client call', apiSrc.includes("'/staff/admin/config/lesson-capacity'") && apiSrc.includes('adminClientQuery()'));
  assert('admin PATCH price client call', apiSrc.includes("'/staff/admin/config/prices/'") && apiSrc.includes('save-price'));
  assert('admin PATCH lesson-time client call', apiSrc.includes("'/staff/admin/config/lesson-times/'") && apiSrc.includes('save-time'));
  assert('writes off skips write handlers', apiSrc.includes('if (!adminCfgWritesEnabled(cfg)) return'));
  assert('admin tab surf-gated no Wolfhouse exposure', apiSrc.includes("tab === 'admin' && !profile.is_surf_vertical"));
  assert('admin edit one target at a time', apiSrc.includes('var adminEditTarget'));
}

if (i18nSrc) {
  assert('admin.action.edit i18n', i18nSrc.includes("'admin.action.edit': 'Edit'"));
  assert('admin.banner.writesUiEnabled i18n', i18nSrc.includes("'admin.banner.writesUiEnabled'"));
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


// ── 15. Sunset Schedule cleanup — demo bookings, drawer, manual create ───────

console.log('\n[15] Sunset Schedule cleanup — demo bookings, drawer, manual create');

if (apiSrc) {
  assert('Day Schedule hidden from nav', apiSrc.includes("if (tab === 'day-schedule') return true;"));
  assert('schedule demo bookings helper', apiSrc.includes('function scheduleBuildDemoBookings('));
  assert('schedule manual bookings not in-memory', !apiSrc.includes('var scheduleManualBookings'));
  assert('week grid booking chips', apiSrc.includes('portal-schedule-item-card') && apiSrc.includes('data-ps-booking-id'));
  assert('bookings list rows', apiSrc.includes('ps-booking-row') && apiSrc.includes('data-ps-booking-id'));
  assert('schedule detail drawer', apiSrc.includes('function openScheduleDetailDrawer(') && apiSrc.includes('id="ps-detail-drawer"'));
  assert('manual create booking UI', apiSrc.includes('id="ps-create-booking"') && apiSrc.includes('function submitScheduleManualBooking('));
  assert('schedule create posts to API', apiSrc.includes("'/staff/schedule/bookings'") && apiSrc.includes('method: \'POST\''));
  assert('schedule create not local-only array', !apiSrc.includes('scheduleManualBookings.push'));
}

if (i18nSrc) {
  assert('schedule.card.wetsuitsToday i18n', i18nSrc.includes("'schedule.card.wetsuitsToday'"));
  assert('schedule.createBooking i18n', i18nSrc.includes("'schedule.createBooking'"));
  assert('schedule.badge.manualDraft i18n', i18nSrc.includes("'schedule.badge.manualDraft'"));
  assert('schedule.equipment.both i18n', i18nSrc.includes("'schedule.equipment.both': 'board + wetsuit'"));
}


// ── 17. Sunset Schedule operational layout ─────────────────────────────────────

console.log('\n[17] Sunset Schedule operational layout');

const opsPath = path.join(ROOT, 'scripts/lib/sunset-schedule-ops.js');
if (fs.existsSync(opsPath)) {
  const opsMod = require(opsPath);
  assert('ops module aggregateDayOps', typeof opsMod.aggregateDayOps === 'function');
  assert('ops module equipmentLabelForLessonRow', typeof opsMod.equipmentLabelForLessonRow === 'function');
  const sample = opsMod.aggregateDayOps([
    { service_date: '2026-07-10', service_type: 'lesson', slot_time: '11:00', quantity: 2, booking_code: 'T1', metadata: { include_board: true, include_wetsuit: true } },
    { service_date: '2026-07-10', service_type: 'board_rental', quantity: 1, booking_code: 'T2' },
  ], '2026-07-10', { lesson_slots_demo: [{ date: '2026-07-10', slot_time: '11:00' }, { date: '2026-07-10', slot_time: '16:00' }] });
  assert('ops sample 11:00 booked count', sample.slots[0].booked === 2);
  assert('ops sample 11:00 boards prep', sample.slots[0].boards === 2);
  assert('ops sample rental boards split', sample.boardsRental === 1);
  assert('ops equipment both label', opsMod.equipmentLabelForLessonRow(
    { booking_code: 'T1', metadata: { include_board: true, include_wetsuit: true }, quantity: 2 },
    sample.gearIndex,
  ) === 'board + wetsuit');
}

if (apiSrc) {
  assert('schedule Inter compact typography', apiSrc.includes(".portal-schedule-wrap{") && apiSrc.includes("font-family:'Inter'"));
  assert('schedule ops main container', apiSrc.includes('id="ps-ops-main"') && apiSrc.includes('portal-schedule-ops-main'));
  assert('schedule lesson group sections', apiSrc.includes('portal-schedule-lesson-group') && apiSrc.includes('function renderScheduleOpsDay('));
  assert('schedule rental pickups section', apiSrc.includes('schedule.rentalPickups') || apiSrc.includes('portal-schedule-rental-section'));
  assert('schedule top card lesson slot lines', apiSrc.includes('id="ps-lesson-slots"') && apiSrc.includes('portal-schedule-slot-lines'));
  assert('schedule boards needed card', apiSrc.includes('id="ps-boards-total"') && apiSrc.includes('schedule.card.boardsNeeded'));
  assert('schedule payment pending card', apiSrc.includes('id="ps-payment-pending"') && apiSrc.includes('schedule.card.paymentPending'));
  assert('schedule no total surfers headline ids', !apiSrc.includes('id="ps-lessons-today"') && !apiSrc.includes('id="ps-rentals-today"'));
  assert('schedule equipment label helpers', apiSrc.includes('function scheduleOpsEquipmentLabel(') && apiSrc.includes('schedule.equipment.both'));
  assert('schedule ops aggregate helper', apiSrc.includes('function scheduleOpsAggregateDay('));
  assert('schedule default day view', apiSrc.includes("var scheduleViewMode = 'day'") && apiSrc.includes('data-ps-view="day"') && apiSrc.includes('portal-schedule-view-btn active" data-ps-view="day"'));
  assert('schedule create add board wetsuit', apiSrc.includes('id="ps-create-add-board"') && apiSrc.includes('add_board'));
  assert('schedule create extra dates', apiSrc.includes('id="ps-create-extra-dates"') && apiSrc.includes('extra_dates'));
  assert('schedule drawer equipment field', apiSrc.includes('schedule.drawer.equipment'));
  assert('schedule week summary blocks', apiSrc.includes('renderScheduleSummaryDayBlock'));
  assert('schedule source rail labels', apiSrc.includes('portal-schedule-source-rail') && apiSrc.includes('schedule.source.luna'));
}

if (i18nSrc) {
  assert('schedule.card.boardsNeeded i18n', i18nSrc.includes("'schedule.card.boardsNeeded': 'Boards needed'"));
  assert('schedule.card.wetsuitsNeeded i18n', i18nSrc.includes("'schedule.card.wetsuitsNeeded': 'Wetsuits needed'"));
  assert('schedule.equipment.none i18n', i18nSrc.includes("'schedule.equipment.none': 'no equipment'"));
}


// ── 16. Sunset real manual bookings — DB persistence ───────────────────────────

console.log('\n[16] Sunset real manual bookings — DB persistence');

if (apiSrc) {
  assert('POST /staff/schedule/bookings route', apiSrc.includes("pathname === '/staff/schedule/bookings'") && apiSrc.includes('method === \'POST\''));
  assert('handleSunsetScheduleBookingCreate handler', apiSrc.includes('function handleSunsetScheduleBookingCreate('));
  assert('sunset-schedule-booking-writes import', apiSrc.includes('sunset-schedule-booking-writes'));
  assert('schedule normalize API rows', apiSrc.includes('function scheduleNormalizeApiRow('));
  assert('drawer ops redesign fields', apiSrc.includes('portal-schedule-drawer-hero') && apiSrc.includes('portal-schedule-drawer-prep'));
  assert('no stripe in schedule create handler', !apiSrc.includes('handleSunsetScheduleBookingCreate') || !apiSrc.slice(apiSrc.indexOf('handleSunsetScheduleBookingCreate'), apiSrc.indexOf('handleSunsetScheduleBookingCreate') + 1200).includes('stripe'));
}

const writesPath = path.join(ROOT, 'scripts/lib/sunset-schedule-booking-writes.js');
let writesSrc = '';
if (fs.existsSync(writesPath)) {
  writesSrc = fs.readFileSync(writesPath, 'utf8');
  assert('writes module validates body', writesSrc.includes('function validateScheduleBookingBody('));
  assert('writes module inserts booking_service_records', writesSrc.includes('INSERT INTO booking_service_records'));
  assert('writes sunset client only', writesSrc.includes("clientSlug !== SUNSET_CLIENT_SLUG"));
  assert('writes no stripe integration', !writesSrc.includes('stripe.') && !writesSrc.includes('STRIPE_'));
}


// ── 18. Sunset Schedule — lesson slots via ops aggregation ───────────────────

console.log('\n[18] Sunset Schedule — lesson slots via ops aggregation');

if (apiSrc) {
  assert('needs-reply checkbox in create form', apiSrc.includes('id="ps-create-needs-reply"'));
  assert('submit sends needs_reply from UI', apiSrc.includes('needs_reply: needsReply'));
  assert('ops aggregate inlined in API', apiSrc.includes('function scheduleOpsAggregateDay('));
  assert('lesson slot lines renderer', apiSrc.includes('function scheduleOpsRenderSlotLines('));
  assert('create time select for lessons', apiSrc.includes('id="ps-create-time"'));
  assert('no legacy day-body slot renderer', !apiSrc.includes('function scheduleRenderDayBodyHtml('));
  assert('no legacy lessons-today breakdown', !apiSrc.includes('function scheduleRenderLessonsTodayBreakdown('));
}

if (i18nSrc) {
  assert('schedule.slot.bookings i18n', i18nSrc.includes("'schedule.slot.bookings'"));
  assert('schedule.create.lessonSlot i18n', i18nSrc.includes("'schedule.create.lessonSlot'"));
}


// ── 18. Sunset Schedule booking shape — components, source, range ────────────

console.log('\n[18] Sunset Schedule booking shape — components, source, range');

if (apiSrc) {
  assert('wetsuits and surfboards summary cards', apiSrc.includes('id="ps-wetsuits-today"') && apiSrc.includes('id="ps-surfboards-today"'));
  assert('lessons time rows with counts', apiSrc.includes('portal-schedule-lesson-time-row') && apiSrc.includes('portal-schedule-lesson-time-count'));
  assert('need reply split email/whatsapp', apiSrc.includes('function scheduleNeedReplyEmailCount(') && apiSrc.includes('function scheduleNeedReplyWhatsAppCount('));
  assert('generic rentals card removed', !apiSrc.includes('id="ps-rentals-today"'));
  assert('next 30 days view', apiSrc.includes('data-ps-view="next30"') && apiSrc.includes('function scheduleFetchNext30('));
  assert('today-first forward range', apiSrc.includes('function scheduleRangeStartDate(') && apiSrc.includes('function scheduleFilterFutureWeekData('));
  assert('create booking component checkboxes', apiSrc.includes('id="ps-create-comp-lesson"') && apiSrc.includes('id="ps-create-comp-surfboard"'));
  assert('create booking multi-date fields', apiSrc.includes('id="ps-create-date-from"') && apiSrc.includes('id="ps-create-date-to"'));
  assert('Adult lesson category label', apiSrc.includes('schedule.create.lessonCategory'));
  assert('no adolescent group lesson label', !/Adolescent group surf lesson/i.test(apiSrc));
  assert('booking source helpers', apiSrc.includes('function scheduleRowSourceKind(') && apiSrc.includes('function scheduleServiceSummaryText('));
  assert('display groups for components', apiSrc.includes('function scheduleBuildDisplayGroups('));
  assert('drawer stripe placeholder disabled', apiSrc.includes('schedule.drawer.stripeLink') && apiSrc.includes('disabled'));
  assert('submit sends components payload', apiSrc.includes('components: payload.components'));
}

if (writesSrc) {
  assert('writes supports components object', writesSrc.includes('normalizeComponents'));
  assert('writes supports multi-date', writesSrc.includes('normalizeServiceDates'));
  assert('writes multiple service records', writesSrc.includes('for (const serviceDate of input.service_dates)'));
}

if (i18nSrc) {
  assert('schedule.source.staff i18n', i18nSrc.includes("'schedule.source.staff'"));
  assert('schedule.view.next30 i18n', i18nSrc.includes("'schedule.view.next30'"));
}


// ── Summary ─────────────────────────────────────────────────────────────────



// ── 19. Sunset Schedule visual refine — muted ops board ─────────────────────

console.log('\n[19] Sunset Schedule visual refine — muted ops board');

if (apiSrc) {
  assert('service summary helper', apiSrc.includes('function scheduleServiceSummaryText('));
  assert('status badge helper', apiSrc.includes('function scheduleRenderStatusBadgeHtml('));
  assert('drawer component list helper', apiSrc.includes('function scheduleRenderComponentListHtml('));
  assert('ops row equipment column', apiSrc.includes('portal-schedule-ops-row-equip'));
  assert('ops row status markup', apiSrc.includes('portal-schedule-ops-row-status'));
  assert('drawer component list markup', apiSrc.includes('portal-schedule-drawer-components'));
  assert('no component pebbles in ops rows', !apiSrc.includes('portal-schedule-ops-row-pebbles'));
  assert('no visible source tag in ops rows', !apiSrc.includes('portal-schedule-ops-row-source'));
  assert('component pebble css removed from rows', !apiSrc.includes('.portal-schedule-pebble.lesson{background:#fde68a'));
  assert('source row rail classes retained', apiSrc.includes('.portal-schedule-ops-row-rail.is-staff') && apiSrc.includes('.portal-schedule-ops-row-rail.is-luna'));
  assert('booking create still persists', apiSrc.includes('/staff/schedule/bookings') && apiSrc.includes('submitScheduleManualBooking'));
  assert('drawer still opens', apiSrc.includes('function openScheduleDetailDrawer('));
  assert('drawer stripe for non-editable only', apiSrc.includes("portalT('schedule.drawer.stripeSoon')"));
}



// ── 20. Sunset Schedule visual polish — density + clarity ───────────────────

console.log('\n[20] Sunset Schedule visual polish — density + clarity');

if (apiSrc) {
  assert('lesson group header booked label', apiSrc.includes('portal-schedule-ops-lesson-hdr-booked') && apiSrc.includes("portalT('schedule.slot.booked')"));
  assert('lesson group header meta', apiSrc.includes('scheduleLessonGroupHeaderMeta('));
  assert('row status hides paid', apiSrc.includes('function scheduleRenderRowStatusHtml(') && apiSrc.includes('opts.row'));
  assert('short pending label key', apiSrc.includes("'schedule.status.pending': 'Pending'") || /schedule\.status\.pending['"]:\s*['"]Pending['"]/.test(i18nSrc || ''));
  assert('no Pending payment in row renderer', !apiSrc.includes('schedule.status.pendingDetail') || apiSrc.includes("schedule.status.unpaid"));
  assert('Today range label helper', apiSrc.includes('function scheduleFormatRangeLabel(') && apiSrc.includes("portalT('schedule.view.today') + ' · '"));
  assert('metric card lesson rental subtext keys', apiSrc.includes("portalT('schedule.metric.lesson')") && apiSrc.includes("portalT('schedule.metric.rental')"));
  assert('lesson time row layout', apiSrc.includes('portal-schedule-lesson-time-row') && apiSrc.includes('scheduleNormalizeSlotTime(slot.slot_time)'));
  assert('component pebble css still absent', !apiSrc.includes('.portal-schedule-pebble.lesson{background:#fde68a'));
}



// ── 21. Sunset Schedule prep-sheet layout ───────────────────────────────────

console.log('\n[21] Sunset Schedule prep-sheet layout');

if (apiSrc) {
  assert('lesson group prepare header', apiSrc.includes('portal-schedule-ops-lesson-hdr-prep') && apiSrc.includes("portalT('schedule.ops.prepare')"));
  assert('ops column header row', apiSrc.includes('scheduleRenderOpsColumnHeader(') && apiSrc.includes('portal-schedule-ops-col-hdr'));
  assert('equipment prep label helper', apiSrc.includes('function scheduleEquipmentPrepLabel('));
  assert('equipment column on rows', apiSrc.includes('portal-schedule-ops-row-equip'));
  assert('rental pickups section', apiSrc.includes('portal-schedule-ops-rental-pickups') && apiSrc.includes('scheduleRenderRentalPickupBlock('));
  assert('short pending in rows', apiSrc.includes("'schedule.status.pending': 'Pending'") || /schedule\.status\.pending['"]:\s*['"]Pending['"]/.test(i18nSrc || ''));
  assert('no component pebble css', !apiSrc.includes('.portal-schedule-pebble.lesson{background:#fde68a'));
  assert('drawer still opens', apiSrc.includes('function openScheduleDetailDrawer('));
  assert('create booking still works', apiSrc.includes('submitScheduleManualBooking'));
}



// ── 22. Sunset Schedule source styling + rental pickup grouping ─────────────

console.log('\n[22] Sunset Schedule source styling + rental pickup grouping');

if (apiSrc) {
  assert('no Staff-created row tag markup', !apiSrc.includes('portal-schedule-ops-row-source'));
  assert('no demo badge in ops row renderer', !apiSrc.includes("scheduleRowSourceLabel(g)") || !apiSrc.includes('portal-schedule-ops-row-source'));
  assert('source aria label helper', apiSrc.includes('function scheduleRowSourceAriaLabel('));
  assert('row source class is-staff', apiSrc.includes("' is-staff'") && apiSrc.includes('.portal-schedule-ops-row.is-staff'));
  assert('row source class is-luna', apiSrc.includes('.portal-schedule-ops-row.is-luna'));
  assert('compact qty multiplier', apiSrc.includes("String(qty) + '×'") || apiSrc.includes('String(qty) + \'\u00d7\''));
  assert('rental both section key', apiSrc.includes("portalT('schedule.ops.rentalBoth')") || (i18nSrc && i18nSrc.includes("'schedule.ops.rentalBoth'")));
  assert('rental boards only section key', i18nSrc.includes("'schedule.ops.rentalBoardsOnly'") || apiSrc.includes("'schedule.ops.rentalBoardsOnly'"));
  assert('rental wetsuits only section key', i18nSrc.includes("'schedule.ops.rentalWetsuitsOnly'") || apiSrc.includes("'schedule.ops.rentalWetsuitsOnly'"));
  assert('rental pickup kind helper', apiSrc.includes('function scheduleRentalPickupKind('));
  assert('drawer plain source kv', apiSrc.includes('scheduleRowSourceDrawerLabel(group)') && apiSrc.includes("portalT('schedule.drawer.source')"));
  assert('next30 view button i18n', i18nSrc.includes("'schedule.view.next30': 'Next 30 days'") || apiSrc.includes('schedule.view.next30'));
  assert('month label not Month', !i18nSrc.includes("'schedule.view.month': 'Month'"));
  assert('drawer still opens', apiSrc.includes('function openScheduleDetailDrawer('));
  assert('create booking still works', apiSrc.includes('submitScheduleManualBooking'));
}



// ── 23. Sunset UI — ES default, lesson groups card, soft light theme ────────

console.log('\n[23] Sunset UI — ES default, lesson groups card, soft light theme');

if (apiSrc) {
  assert('ES default locale', i18nSrc.includes("return 'es';"));
  assert('no IT lang button', !apiSrc.includes('data-lang="it"'));
  assert('ES lang button before EN', apiSrc.indexOf('data-lang="es"') >= 0 && apiSrc.indexOf('data-lang="es"') < apiSrc.indexOf('data-lang="en"'));
  assert('spanish sunset supplement', i18nSrc.includes('staff-portal-i18n-es-sunset'));
  assert('lesson groups time rows', apiSrc.includes('portal-schedule-lesson-time-row'));
  assert('schedule calm surface scoped', apiSrc.includes('--sched-bg:#F4F5F7'));
  assert('schedule source rails retained', apiSrc.includes('.portal-schedule-ops-row-rail.is-staff'));
  assert('schedule calm light scoped only', apiSrc.includes(':root:not([data-theme="dark"]) #tab-portal-home{'));
  assert('schedule dark night mode restored', apiSrc.includes('[data-theme="dark"] #tab-portal-home{background:var(--cream)}'));
}

console.log('\n[24] Sunset Schedule — calm UI, live i18n, phone, conversation');

if (apiSrc) {
  assert('no pending payment option in create form', !apiSrc.includes('value="pending" data-i18n="schedule.payment.pending"'));
  assert('unpaid card label key', apiSrc.includes('data-i18n="schedule.card.unpaid">Unpaid</div>'));
  assert('create phone field', apiSrc.includes('id="ps-create-phone"'));
  assert('post guest_phone', apiSrc.includes('guest_phone: payload.guest_phone'));
  assert('schedule locale refresh hook', apiSrc.includes('scheduleRefreshOnLocaleChange'));
  assert('drawer conversation button', apiSrc.includes('ps-drawer-conversation-btn'));
  assert('open or start conversation', apiSrc.includes('scheduleOpenOrStartConversationFromBooking'));
  assert('light schedule rows no gradient wash', !apiSrc.includes(':root:not([data-theme="dark"]) #tab-portal-home .portal-schedule-ops-row.is-staff{background:linear-gradient'));
  assert('dark schedule row gradient restored', apiSrc.includes('[data-theme="dark"] #tab-portal-home .portal-schedule-ops-row.is-staff{background:linear-gradient'));
  assert('reuse create-conversation endpoint', apiSrc.includes('/staff/bookings/create-conversation'));
}

if (writesSrc) {
  assert('booking insert phone column', writesSrc.includes('guest_name, phone, status'));
  assert('validate guest_phone', writesSrc.includes('guest_phone'));
}

const calmLessonsSrc = fs.readFileSync(path.join(__dirname, 'lib/staff-ask-luna-lessons.js'), 'utf8');
if (calmLessonsSrc) {
  assert('lessons query returns phone', calmLessonsSrc.includes('AS phone'));
  assert('lessons query returns booking_id', calmLessonsSrc.includes('AS booking_id'));
}

console.log('\n[25] Sunset booking drawer — payments, edits, test Stripe');

if (apiSrc) {
  assert('drawer detail GET route', apiSrc.includes('/staff/schedule/bookings/detail'));
  assert('drawer PATCH route', apiSrc.includes("pathname === '/staff/schedule/bookings' && method === 'PATCH'"));
  assert('drawer update handler', apiSrc.includes('function handleSunsetScheduleBookingUpdate('));
  assert('drawer detail handler', apiSrc.includes('function handleSunsetScheduleBookingDetailGet('));
  assert('drawer payment section', apiSrc.includes('function scheduleRenderDrawerPaymentSectionHtml('));
  assert('drawer line item labels', apiSrc.includes('schedule.drawer.paymentSection'));
  assert('drawer totals paid remaining', apiSrc.includes('schedule.drawer.remaining') && apiSrc.includes('ps-drawer-paid'));
  assert('create test stripe link button', apiSrc.includes('ps-drawer-stripe-link') && apiSrc.includes('schedule.drawer.stripeLink'));
  assert('stripe no auto send message', apiSrc.includes('schedule.drawer.stripeCreated'));
  assert('drawer editable fields', apiSrc.includes('ps-drawer-guest') && apiSrc.includes('ps-drawer-board-qty'));
  assert('drawer save action', apiSrc.includes('function scheduleSaveDrawerBooking('));
  assert('drawer payment refresh helper', apiSrc.includes('function scheduleUpdateDrawerPaymentFromContext('));
  assert('stripe stale warning', apiSrc.includes('schedule.drawer.stripeStale'));
  assert('stripe unavailable disabled', apiSrc.includes('schedule.drawer.stripeUnavailable'));
  assert('drawer conversation action', apiSrc.includes('ps-drawer-conversation-btn'));
  assert('no whatsapp stripe send in drawer save', !apiSrc.includes('scheduleSaveDrawerBooking') || !apiSrc.slice(apiSrc.indexOf('scheduleCreateDrawerStripeLink'), apiSrc.indexOf('scheduleCreateDrawerStripeLink') + 800).match(/whatsapp|sendMessage|send_email/i));
}

const drawerModPath = path.join(ROOT, 'scripts/lib/sunset-schedule-booking-drawer.js');
if (fs.existsSync(drawerModPath)) {
  const drawerModSrc = fs.readFileSync(drawerModPath, 'utf8');
  assert('drawer module sunset only', drawerModSrc.includes("clientSlug !== SUNSET_CLIENT_SLUG"));
  assert('drawer marks stripe stale on update', drawerModSrc.includes('sunset_stripe_link_stale'));
  assert('drawer live pricing note', drawerModSrc.includes('live_pricing'));
}

const stripeModPath = path.join(ROOT, 'scripts/lib/sunset-stripe-payment-links.js');
if (fs.existsSync(stripeModPath)) {
  const stripeModSrc = fs.readFileSync(stripeModPath, 'utf8');
  assert('stripe module blocks live keys', stripeModSrc.includes('sk_live_'));
  assert('stripe module no whatsapp', !/whatsapp/i.test(stripeModSrc));
  assert('stripe respects stale metadata', stripeModSrc.includes('sunset_stripe_link_stale'));
}


console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-portal-v1 — FAILED');
  process.exit(1);
}
console.log('verify:sunset-portal-v1 — ALL CHECKS PASSED');
