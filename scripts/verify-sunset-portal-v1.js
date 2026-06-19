'use strict';

/**
 * verify:sunset-portal-v1
 *
 * Offline checks for Sunset Staff Portal v1 Slice 2A:
 * surf-school labels, hidden drawer tabs, lodging copy gating, Wolfhouse preservation.
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

console.log('\nverify:sunset-portal-v1 — Sunset portal v1 Slice 2A offline checks\n');

// ── 1. Sunset profile — drawer gating + default tab ─────────────────────────

console.log('[1] Sunset portal profile — surf labels + drawer gating');

const ss = loadClientPortalProfile('sunset');
assert('sunset default_tab is conversations', ss.default_tab === 'conversations', ss.default_tab);
assert('sunset hidden_drawer_tabs includes transfers', Array.isArray(ss.hidden_drawer_tabs)
  && ss.hidden_drawer_tabs.includes('transfers'), JSON.stringify(ss.hidden_drawer_tabs));
assert('sunset is_surf_vertical is true', ss.is_surf_vertical === true);

// ── 2. Wolfhouse preservation ───────────────────────────────────────────────

console.log('\n[2] Wolfhouse portal profile — legacy defaults preserved');

const wh = loadClientPortalProfile('wolfhouse-somo');
assert('wolfhouse default_tab is bed-calendar', wh.default_tab === 'bed-calendar', wh.default_tab);
assert('wolfhouse hidden_drawer_tabs is empty', Array.isArray(wh.hidden_drawer_tabs)
  && wh.hidden_drawer_tabs.length === 0, JSON.stringify(wh.hidden_drawer_tabs));
assert('wolfhouse hidden_tabs is empty', Array.isArray(wh.hidden_tabs) && wh.hidden_tabs.length === 0);
assert('wolfhouse is_surf_vertical is false', wh.is_surf_vertical === false);

// ── 3. i18n — Inbox + surf empty states ─────────────────────────────────────

console.log('\n[3] staff-portal-i18n.js — Inbox + surf copy');

if (fs.existsSync(I18N_PATH)) {
  const i18n = fs.readFileSync(I18N_PATH, 'utf8');
  assert('nav.tab.inbox key present', i18n.includes("'nav.tab.inbox': 'Inbox'"));
  assert('nav.tab.whatsapp preserved for Wolfhouse', i18n.includes("'nav.tab.whatsapp': 'WhatsApp'"));
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

// ── Summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-portal-v1 — FAILED');
  process.exit(1);
}
console.log('verify:sunset-portal-v1 — ALL CHECKS PASSED');
