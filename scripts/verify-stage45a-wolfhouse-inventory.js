/**
 * Stage 45a — Wolfhouse real inventory (Airtable CSV) wired into Staff Portal + Ask Luna.
 *
 * Usage:
 *   npm run verify:stage45a-wolfhouse-inventory
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const INV = path.join(__dirname, 'lib', 'wolfhouse-inventory-source.js');
const BCQ = path.join(__dirname, 'lib', 'staff-bed-calendar-queries.js');
const ASK = path.join(__dirname, 'lib', 'staff-ask-luna-free-beds.js');
const PKG = path.join(ROOT, 'package.json');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage45a-wolfhouse-inventory.js  (Stage 45a)\n');

section('A. Source files + syntax');
for (const f of [API, INV, BCQ, ASK, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('A0', `${path.basename(f)} passes node --check`);
  } catch {
    fail('A0', `${path.basename(f)} syntax error`);
  }
}

const invSrc = fs.readFileSync(INV, 'utf8');
const bcqSrc = fs.readFileSync(BCQ, 'utf8');
const askSrc = fs.readFileSync(ASK, 'utf8');
const apiSrc = fs.readFileSync(API, 'utf8');

section('B. Airtable CSV import source');
check('B1', fs.existsSync(path.join(ROOT, 'database', 'Rooms-Grid view.csv')),
  'Rooms-Grid view.csv present');
check('B2', fs.existsSync(path.join(ROOT, 'database', 'Beds-Grid view.csv')),
  'Beds-Grid view.csv present');
check('B3', invSrc.includes('loadWolfhouseInventoryFromCsv'),
  'shared CSV loader exported');

const {
  loadWolfhouseInventoryFromCsv,
  resolveBedCalendarRoomRows,
  filterDemoCalendarBlocks,
  isDemoRoomCode,
  isDemoCalendarBlock,
  WOLFHOUSE_CLIENT_SLUG,
} = require('./lib/wolfhouse-inventory-source');

const inv = loadWolfhouseInventoryFromCsv();
check('B4', inv.source === 'csv_export', 'inventory loads from CSV export');
check('B5', inv.rooms.length >= 10, `room count >= 10 (got ${inv.rooms.length})`);
check('B6', inv.beds.length >= 50, `bed count >= 50 (got ${inv.beds.length})`);
check('B7', !inv.rooms.some((r) => isDemoRoomCode(r.room_code)),
  'CSV rooms have no DEMO-R* codes');

section('C. Room metadata preserved');
check('C1', inv.rooms.every((r) => Number.isFinite(r.fill_priority)),
  'fill_priority on all rooms');
check('C2', inv.rooms.some((r) => /female/i.test(r.gender_strategy)),
  'female room gender_strategy present');
check('C3', inv.rooms.some((r) => /male/i.test(r.gender_strategy)),
  'male room gender_strategy present');
check('C4', inv.rooms.some((r) => /private/i.test(r.gender_strategy)),
  'private room gender_strategy present');
check('C5', inv.rooms.some((r) => /flexible|mixed/i.test(r.gender_strategy)),
  'mixed/flexible room gender_strategy present');

const priorities = inv.rooms.map((r) => r.fill_priority);
const sortedByPriority = [...inv.rooms].sort((a, b) => a.fill_priority - b.fill_priority);
check('C6', sortedByPriority[0].room_code === 'R3',
  'lowest fill_priority room is R3 (Fill Priority 1 in CSV)');

section('D. Staff Portal wiring');
check('D1', apiSrc.includes('resolveBedCalendarRoomRows'),
  'staff-query-api resolves Wolfhouse inventory');
check('D2', apiSrc.includes('filterDemoCalendarBlocks'),
  'staff-query-api filters demo calendar blocks');
check('D3', bcqSrc.includes('fill_priority'),
  'bed calendar rooms query selects fill_priority');
check('D4', bcqSrc.includes('wolfhouseExcludeDemoRoomsSql'),
  'bed calendar query excludes DEMO rooms for wolfhouse-somo');
check('D5', bcqSrc.includes('wolfhouseExcludeDemoBookingsSql'),
  'bed calendar blocks exclude stage8 demo bookings');
check('D6', apiSrc.includes('gender_strategy') && apiSrc.includes('bc-room-hdr'),
  'calendar room headers can show gender metadata');
check('D7', !/DEMO-R1|Demo Dorm Room/.test(
  apiSrc.match(/function renderBedCalendar[\s\S]*?^function /m)?.[0] || ''),
  'renderBedCalendar has no hardcoded DEMO inventory');

section('E. Staff Ask Luna inventory');
check('E1', askSrc.includes('wolfhouse-inventory-source'),
  'Ask Luna free-beds uses shared inventory excludes');
check('E2', askSrc.includes('wolfhouseExcludeDemoRoomsSql'),
  'Ask Luna free-beds excludes DEMO rooms for wolfhouse-somo');

section('F. CSV fallback when PG has demo-only inventory');
const demoPg = [
  { room_code: 'DEMO-R1', bed_code: 'DEMO-R1-B1', room_sort_order: 1 },
  { room_code: 'DEMO-R2', bed_code: 'DEMO-R2-B1', room_sort_order: 2 },
];
const resolved = resolveBedCalendarRoomRows(WOLFHOUSE_CLIENT_SLUG, demoPg);
check('F1', !resolved.some((r) => isDemoRoomCode(r.room_code)),
  'resolve drops DEMO-R* rows');
check('F2', resolved.filter((r) => r.bed_code).length >= 50,
  'CSV fallback provides 50+ bed rows');
check('F3', resolved.some((r) => r.room_code === 'R1' && r.bed_code === 'R1-B1'),
  'fallback includes real R1-B1 bed');

section('G. Demo booking filter');
check('G1', isDemoCalendarBlock({ booking_code: 'DEMO-2603', bed_code: 'DEMO-R1-B1' }),
  'filters DEMO-* booking codes');
check('G2', isDemoCalendarBlock({ booking_code: 'MB-WOLFHO-20260920-4f62e2', bed_code: 'R1-B1' }) === false,
  'does not filter real manual booking codes');
check('G3', filterDemoCalendarBlocks([
  { booking_code: 'DEMO-2601' },
  { booking_code: 'WH-G27-3888294D42', bed_code: 'R1-B1' },
]).length === 1, 'filterDemoCalendarBlocks keeps real bookings only');

section('H. Safety — no live send paths touched');
check('H1', !invSrc.includes('sendWhatsApp') && !invSrc.includes('api.stripe.com'),
  'inventory source has no Stripe/WhatsApp');
check('H2', !bcqSrc.includes('INSERT INTO') && !bcqSrc.includes('UPDATE bookings'),
  'bed calendar queries remain SELECT-only');

section('I. npm script');
const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
check('I1', pkg.scripts && pkg.scripts['verify:stage45a-wolfhouse-inventory'],
  'npm script verify:stage45a-wolfhouse-inventory registered');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
