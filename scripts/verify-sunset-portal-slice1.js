'use strict';

/**
 * verify:sunset-portal-slice1
 *
 * Offline checks for Sunset portal Slice 1 gating (read-only demo).
 * No Staff API, DB, network, or env dependency.
 *
 * Run:
 *   node scripts/verify-sunset-portal-slice1.js
 *   npm run verify:sunset-portal-slice1
 */

const fs = require('fs');
const path = require('path');

const {
  loadClientPortalProfile,
  isSurfVertical,
  SURF_VERTICALS,
} = require('./lib/staff-portal-clients');

const ROOT = path.join(__dirname, '..');
const STAFF_API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const I18N_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js');

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

console.log('\nverify:sunset-portal-slice1 — portal gating offline checks\n');

// ── 1. Wolfhouse defaults unchanged ─────────────────────────────────────────

console.log('[1] Wolfhouse portal profile preserves legacy defaults');

const wh = loadClientPortalProfile('wolfhouse-somo');
assert('wolfhouse vertical is lodging_surf_house', wh.vertical === 'lodging_surf_house', wh.vertical);
assert('wolfhouse default_tab is bed-calendar', wh.default_tab === 'bed-calendar', wh.default_tab);
assert('wolfhouse hidden_tabs is empty', Array.isArray(wh.hidden_tabs) && wh.hidden_tabs.length === 0,
  JSON.stringify(wh.hidden_tabs));
assert('wolfhouse is_surf_vertical is false', wh.is_surf_vertical === false);
assert('wolfhouse lesson_slots_demo is empty', Array.isArray(wh.lesson_slots_demo) && wh.lesson_slots_demo.length === 0);

console.log('\n[1b] Dev tabs hidden when NODE_ENV=production');
const prevNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
delete require.cache[require.resolve('./lib/staff-portal-clients')];
const prodClients = require('./lib/staff-portal-clients');
const whProd = prodClients.loadClientPortalProfile('wolfhouse-somo');
assert('production hides query-tools', whProd.hidden_tabs.includes('query-tools'));
assert('production hides luna-guest-simulator', whProd.hidden_tabs.includes('luna-guest-simulator'));
process.env.NODE_ENV = prevNodeEnv;
delete require.cache[require.resolve('./lib/staff-portal-clients')];

// ── 2. Sunset surf vertical gating ──────────────────────────────────────────

console.log('\n[2] Sunset portal profile — surf vertical gating');

const sunsetPath = path.join(ROOT, 'config', 'clients', 'sunset.baseline.json');
assert('sunset.baseline.json exists', fs.existsSync(sunsetPath));

if (fs.existsSync(sunsetPath)) {
  const ss = loadClientPortalProfile('sunset');
  assert('sunset vertical is surf_school_rentals', ss.vertical === 'surf_school_rentals', ss.vertical);
  assert('sunset is_surf_vertical is true', ss.is_surf_vertical === true);
  assert('sunset default_tab is portal-home', ss.default_tab === 'portal-home', ss.default_tab);
  assert('sunset hides bed-calendar', ss.hidden_tabs.includes('bed-calendar'));
  assert('sunset hides tour-operator', ss.hidden_tabs.includes('tour-operator'));
  assert('sunset lesson_slots_demo has entries', Array.isArray(ss.lesson_slots_demo) && ss.lesson_slots_demo.length >= 2,
    `count=${(ss.lesson_slots_demo || []).length}`);
  if (ss.lesson_slots_demo && ss.lesson_slots_demo[0]) {
    assert('demo slot has slot_time', !!ss.lesson_slots_demo[0].slot_time);
    assert('demo slot has capacity', ss.lesson_slots_demo[0].capacity != null);
  }
  assert('sunset demo_mode is true', ss.demo_mode === true);
}

// ── 3. Surf vertical set ─────────────────────────────────────────────────────

console.log('\n[3] Surf vertical registry');

assert('surf_school_rentals in SURF_VERTICALS', SURF_VERTICALS.has('surf_school_rentals'));
assert('lodging_surf_house not surf vertical', !isSurfVertical('lodging_surf_house'));

// ── 4. staff-query-api.js wiring markers ────────────────────────────────────

console.log('\n[4] staff-query-api.js portal slice markers');

let apiSrc = '';
if (fs.existsSync(STAFF_API_PATH)) {
  apiSrc = fs.readFileSync(STAFF_API_PATH, 'utf8');
  assert('imports buildClientProfilesMap', apiSrc.includes('buildClientProfilesMap'));
  assert('session includes client_profiles', apiSrc.includes('client_profiles'));
  assert('day-schedule tab markup present', apiSrc.includes('data-tab="day-schedule"'));
  assert('applyClientPortalProfile function present', apiSrc.includes('function applyClientPortalProfile'));
  assert('loadDaySchedule function present', apiSrc.includes('function loadDaySchedule'));
  assert('no unconditional bed-calendar hide', !apiSrc.includes("hidden_tabs: ['bed-calendar'"));
  assert('portal-no-dev-tabs CSS present', apiSrc.includes('portal-no-dev-tabs'));
  assert('STAFF_PORTAL_DEV_TABS bootstrap present', apiSrc.includes('__STAFF_PORTAL_DEV_TABS__'));
} else {
  assert('staff-query-api.js exists', false, STAFF_API_PATH);
}

// ── 5. i18n strings ─────────────────────────────────────────────────────────

console.log('\n[5] staff-portal-i18n.js day schedule strings');

if (fs.existsSync(I18N_PATH)) {
  const i18n = fs.readFileSync(I18N_PATH, 'utf8');
  assert('nav.tab.daySchedule key', i18n.includes("'nav.tab.daySchedule'"));
  assert('daySchedule.title key', i18n.includes("'daySchedule.title'"));
} else {
  assert('staff-portal-i18n.js exists', false);
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-portal-slice1 — FAILED');
  process.exit(1);
}
console.log('verify:sunset-portal-slice1 — ALL CHECKS PASSED');
