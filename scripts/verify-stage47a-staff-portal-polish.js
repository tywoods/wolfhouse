/**
 * Stage 47a — Staff Portal polish: calendar resize, handoff markers,
 * cancelled booking sidebar filter, room order R1–R10.
 *
 * Usage:
 *   npm run verify:stage47a-staff-portal-polish
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API = path.join(__dirname, 'staff-query-api.js');
const CONV_Q = path.join(__dirname, 'lib', 'staff-conversation-queries.js');
const BC_Q = path.join(__dirname, 'lib', 'staff-bed-calendar-queries.js');
const PKG = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage47a-staff-portal-polish.js  (Stage 47a)\n');

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'staff-query-api.js passes node --check');
} catch {
  fail('0', 'staff-query-api.js syntax error');
  process.exit(1);
}

const api = fs.readFileSync(API, 'utf8');
const convQ = fs.readFileSync(CONV_Q, 'utf8');
const bcQ = fs.readFileSync(BC_Q, 'utf8');

section('A. Calendar vertical resize');
check('A1', /id="bc-grid-resize-handle"/.test(api), 'resize handle element');
check('A2', /function bcInitCalendarResize/.test(api), 'bcInitCalendarResize helper');
check('A3', /staff_bc_grid_height/.test(api), 'localStorage height key');
check('A4', /BC_GRID_HEIGHT_MIN/.test(api) && /BC_GRID_HEIGHT_MAX/.test(api), 'min/max height guards');
check('A4b', /function bcGetGridHeightMax/.test(api) && /bcMeasureGridContentHeight/.test(api),
  'content-aware max height for full room list');
check('A4c', /BC_GRID_HEIGHT_MAX\s*=\s*4000/.test(api), 'absolute max allows all 10 rooms');
check('A4d', /Math\.min\(BC_GRID_HEIGHT_MAX/.test(api) && !/Math\.min\(bcGetGridHeightMax\(\)/.test(api),
  'drag clamp uses absolute max (not content cap that can freeze resize)');
check('A5', /function bcApplyGridHeight/.test(api) && /wrap\.style\.height/.test(api), 'dynamic calendar height');
check('A6', /addEventListener\('mousedown'/.test(api) && /mousemove/.test(api), 'pointer drag handlers');

section('B. Human handoff in WhatsApp inbox');
check('B1', /function conversationHasOpenHandoff/.test(api), 'handoff detector');
check('B2', /Human handoff/.test(api) && /conv-list-handoff-pill/.test(api), 'inbox row handoff marker');
check('B3', /conv-card-handoff/.test(api) && /handoffLabel\(c\.handoff_reason\)/.test(api), 'handoff reason on card');
check('B4', /OPEN HANDOFF/.test(api) && /ss\.handoff_reason/.test(api), 'thread context handoff panel');
check('B5', /handoff_reason/.test(convQ) && /handoff_status/.test(convQ), 'inbox query exposes handoff fields');

section('C. Cancelled bookings hidden from active sidebar');
check('C1', /function filterActiveInboxBookings/.test(api), 'active booking filter helper');
check('C2', /cancelled.*expired|expired.*cancelled/.test(convQ), 'bookings query excludes cancelled/expired');
check('C3', /sanitizeConversationContextForInbox/.test(api), 'context sanitizes cancelled linked booking');
check('C4', /bookings:\s*activeBookings/.test(api), 'context API returns active bookings only');
check('C5', /inbox-no-bookings/.test(api), 'empty sidebar state when no active bookings');

section('D. Calendar room order R1–R10');
check('D1', /function bcSortRoomsForDisplay/.test(api), 'display room sort helper');
check('D2', /localeCompare[\s\S]{0,80}numeric:\s*true/.test(api), 'natural numeric sort');
check('D3', /function bcSortBedsForDisplay/.test(api), 'bed sort helper');
check('D4', /fill_priority supports Luna assignment|fill_priority.*Luna/i.test(bcQ), 'assignment priority documented separate');
check('D5', /fill_priority:/.test(api) && /bcSortRoomsForDisplay\(rooms\)/.test(api),
  'UI display sort uses room_code not fill_priority');

section('E. npm script');
const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
check('E1', pkg.scripts && pkg.scripts['verify:stage47a-staff-portal-polish'],
  'verify:stage47a-staff-portal-polish registered');

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
