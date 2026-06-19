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
  assert('Sunset Surf School in demo home markup', apiSrc.includes('demoHome.schoolName'));
  assert('Luna Front Desk in demo home markup', apiSrc.includes('demoHome.brand'));
  assert('Inbox card on demo home', apiSrc.includes('demoHome.card.inbox.title'));
  assert('Lessons today card on demo home', apiSrc.includes('demoHome.card.lessons.title'));
  assert('Rentals today card on demo home', apiSrc.includes('demoHome.card.rentals.title'));
  assert('Needs attention card on demo home', apiSrc.includes('demoHome.card.attention.title'));
  assert('What Luna will help with section', apiSrc.includes('demoHome.luna.title'));
  assert('embedded schedule on demo home', apiSrc.includes('id="ph-ds-date"'));

  const homePanel = extractPortalHomePanel(apiSrc);
  if (homePanel) {
    assert('demo home panel has no lodging keywords', !WOLFHOUSE_LODGING.test(homePanel));
  } else {
    assert('demo home panel extractable', false);
  }
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

// ── Summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-portal-v1 — FAILED');
  process.exit(1);
}
console.log('verify:sunset-portal-v1 — ALL CHECKS PASSED');
