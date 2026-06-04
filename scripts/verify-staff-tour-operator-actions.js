/**
 * Phase 10.7a — Tour Operator block create + room release verifier.
 *
 * Usage:
 *   npm run verify:staff-tour-operator-actions
 */

'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg) { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

function extractTourOperatorTab(source) {
  const start = source.indexOf('id="tab-tour-operator"');
  const end = source.indexOf('</div><!-- /tab-tour-operator -->', start);
  return start >= 0 && end > start ? source.slice(start, end) : '';
}

function extractTourOperatorJs(source) {
  const start = source.indexOf('/* ── Tour Operator forms (Phase 10.7a');
  if (start < 0) return '';
  const end = source.indexOf('\nfunction loadBedCalendar', start);
  return end > start ? source.slice(start, end) : '';
}

console.log('\nverify-staff-tour-operator-actions.js  (Phase 10.7a)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');
const tabHtml = extractTourOperatorTab(src);
const toJs = extractTourOperatorJs(src);

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

console.log('\nA. Stale disabled / shadow copy removed');

check(tabHtml.length > 200, 'Tour Operator tab HTML present');
check(!/READ-ONLY.*writes disabled|shadow mode|Preview only.*coming soon|write gated|approval gates before they can be enabled|no operator block will be created|no dates will be released|Dynamic operator block list.*coming soon|dynamic list later/i.test(tabHtml),
  'Tour Operator tab has no disabled/shadow/read-only stale copy');
check(!/disabled[^>]*id="to-op-create-btn"|id="to-op-create-btn"[^>]*disabled/.test(tabHtml),
  'Create Operator Block button not hard-disabled in HTML');
check(!/disabled[^>]*id="to-rr-release-btn"|id="to-rr-release-btn"[^>]*disabled/.test(tabHtml),
  'Release Dates button not hard-disabled in HTML');

console.log('\nB. UI enablement + field wiring');

check(/function toOpFormReady/.test(toJs) && /function toUpdateOpButtons/.test(toJs),
  'create form readiness enables/disables buttons');
check(/function toRrFormReady/.test(toJs) && /function toUpdateRrButtons/.test(toJs),
  'release form readiness enables/disables buttons');
check(/prev\.disabled = !ready/.test(toJs) && /create\.disabled = !ready/.test(toJs),
  'create buttons disabled only when form incomplete or busy');
check(/rel\.disabled = !ready/.test(toJs),
  'release button disabled only when form incomplete or busy');
check(/toOpPreview/.test(toJs) && /toOpCreate/.test(toJs),
  'create preview and create handlers wired');
check(/toRrPreview/.test(toJs) && /toRrRelease/.test(toJs),
  'release preview and release handlers wired');

console.log('\nC. Rooms load from rooms table source');

check(/handleTourOperatorRooms/.test(src) && /getBedCalendarRoomsQuery/.test(src),
  'GET /staff/tour-operator/rooms uses bed calendar rooms query (rooms table)');
check(/function toLoadRooms/.test(toJs) && /\/staff\/tour-operator\/rooms/.test(toJs),
  'UI loads rooms from tour-operator rooms API');
check(/function toRenderRoomSelects/.test(toJs) && /to-op-room/.test(toJs) && /to-rr-room/.test(toJs),
  'room dropdowns populated from API/cache');
check(!/hardcoded room list|DEMO-R1 only/i.test(tabHtml + toJs),
  'no hardcoded-only room list in Tour Operator slice');

console.log('\nD. Operator blocks load for release form');

check(/TO_OPERATOR_BLOCKS_LIST_SQL/.test(src) && /booking_source = 'operator'/.test(src),
  'operator blocks list query filters operator whole_room bookings');
check(/function toLoadBlocks/.test(toJs) && /\/staff\/tour-operator\/blocks/.test(toJs),
  'UI loads operator blocks from API');
check(/function toRenderBlockSelect/.test(toJs) && /data-cin/.test(toJs) && /data-room/.test(toJs),
  'release dropdown shows readable labels with dates and room');
check(/toOnBlockSelectChange/.test(toJs),
  'selecting operator block fills block dates and room');

console.log('\nE. Backend endpoints + validation');

check(/async function handleTourOperatorBlockPreview/.test(src),
  'POST /staff/tour-operator/blocks/preview handler exists');
check(/async function handleTourOperatorBlockCreate/.test(src),
  'POST /staff/tour-operator/blocks/create handler exists');
check(/async function handleTourOperatorReleasePreview/.test(src),
  'POST /staff/tour-operator/release/preview handler exists');
check(/async function handleTourOperatorRelease/.test(src),
  'POST /staff/tour-operator/release handler exists');
check(/pathname === '\/staff\/tour-operator\/blocks\/create'/.test(src),
  'router registers blocks/create');
check(/pathname === '\/staff\/tour-operator\/release'/.test(src),
  'router registers release');
const createFn = src.match(/async function handleTourOperatorBlockCreate[\s\S]*?\nasync function handleTourOperatorReleasePreview/)?.[0] || '';
check(/operator_name is required/.test(createFn) && /room_code is required/.test(createFn)
  && /check_out must be after check_in/.test(createFn) && /confirm: true is required/.test(createFn),
  'create validates client/operator/room/dates/confirm');
const releaseSlice = src.match(/async function handleTourOperatorReleasePreview[\s\S]*?\/\/ Stage 7\.7k3 — Bed reassignment preview/)?.[0] || '';
check(/booking_id must be a valid UUID/.test(releaseSlice) && /release_end must be after release_start/.test(releaseSlice),
  'release validates booking_id and date range');
check(/TO_OPERATOR_BOOKING_BY_ID_SQL/.test(src) && /booking_source !== 'operator'/.test(releaseSlice),
  'release verifies selected block belongs to client and is operator booking');
check(/TO_BED_CONFLICTS_SQL/.test(src),
  'create/release path includes bed conflict checks');

console.log('\nF. Calendar reload after mutations');

check(/function toAfterMutation/.test(toJs) && /loadBedCalendar/.test(toJs) && /toLoadBlocks/.test(toJs),
  'success path reloads bed calendar and operator block list');

console.log('\nG. Embedded script parse guard');

const buildStart = src.indexOf('function buildUiHtml');
const scriptTag = src.indexOf('<script>', buildStart);
const fnStart = src.indexOf('(function(){', scriptTag);
const endTag = src.indexOf('</script>', fnStart);
const beforeClose = src.slice(fnStart, endTag);
const relEnd = beforeClose.lastIndexOf('})();');
const rawJs = relEnd >= 0 ? beforeClose.slice(0, relEnd + '})();'.length) : '';
const js = rawJs
  ? rawJs
      .replace(/\$\{STAFF_ACTIONS_ENABLED\}/g, 'false')
      .replace(/\$\{MANUAL_BOOKING_ENABLED\}/g, 'false')
      .replace(/\$\{STRIPE_LINKS_ENABLED\}/g, 'false')
      .replace(/\$\{BOOKING_MOVE_WRITE_ENABLED\}/g, 'false')
  : '';
if (!rawJs) {
  fail('embedded UI script not found');
} else {
  try {
    new vm.Script(js);
    ok('embedded UI script parses without SyntaxError');
  } catch (e) {
    fail('embedded UI script SyntaxError: ' + (e.message || e));
  }
  check(/function toOnTourOperatorTabOpen/.test(js),
    'embedded script defines toOnTourOperatorTabOpen');
}

console.log('\nH. Safety boundaries');

const slice = tabHtml + toJs + createFn + releaseSlice;
check(!/api\.stripe\.com/.test(slice), 'no Stripe API URL in tour operator slice');
check(!/graph\.facebook\.com/.test(slice), 'no WhatsApp URL in tour operator slice');
check(!/n8n\.cloud|activate.*workflow/i.test(slice), 'no n8n activation in tour operator slice');
check(!/INSERT INTO payments|UPDATE payments|INSERT INTO booking_service_records|UPDATE booking_service_records/.test(createFn + releaseSlice),
  'handlers do not mutate payments or booking_service_records');
check(/no_whatsapp:\s*true/.test(createFn) || /no_whatsapp:\s*true/.test(src.match(/handleTourOperatorBlockCreate[\s\S]{0,2500}/)?.[0] || ''),
  'create response flags no_whatsapp');
check(/loadOperatorRoomReleaseImpactPlan/.test(src) && /executeOperatorRoomRelease/.test(src),
  'release reuses operator room release plan/execute helpers (no n8n)');

console.log('\nI. Package script');

try {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(pkg.scripts && pkg.scripts['verify:staff-tour-operator-actions'],
    'package.json has verify:staff-tour-operator-actions script');
} catch (_) {
  fail('package.json readable for script check');
}

console.log('\nJ. No docs / migration changes');

let docsChanged = false;
let migChanged = false;
try {
  docsChanged = execSync('git diff --name-only -- docs', { encoding: 'utf8', cwd: path.join(__dirname, '..') }).trim().length > 0;
  migChanged = execSync('git diff --name-only -- database/migrations', { encoding: 'utf8', cwd: path.join(__dirname, '..') }).trim().length > 0;
} catch (_) { /* ok */ }
check(!docsChanged, 'no docs changes in working tree');
check(!migChanged, 'no database/migrations changes in working tree');

console.log('\nResult: ' + passes + ' passed, ' + failures + ' failed\n');
if (failures > 0) process.exit(1);
