'use strict';

/**
 * verify:sunset-drawer-luna-canonical
 *
 * Regression: persisted Luna schedule rows must use the same canonical booking drawer
 * renderer as Staff-persisted rows (only creator attribution differs).
 *
 * RED evidence: Slice 10 baseline (6e74fc2) — monolithic portal + legacy server error codes.
 * GREEN evidence: HEAD — injected portal module + trusted attribution gate (Staff + Luna).
 *
 * Run: node scripts/verify-sunset-drawer-luna-canonical.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAFF_API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PORTAL_MODULE_PATH = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-portal-module.js');
const CTRL_MODULE_PATH = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-controller.js');
const DRAWER_PATH = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-booking-drawer.js');
const SLICE10_BASE = '6e74fc2f3ccf1e31713e616024b22dfd3416a332';

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

function gitShow(rev, filePath) {
  try {
    return execFileSync(
      'git',
      ['show', `${rev}:${filePath}`],
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
  } catch (err) {
    const detail = String((err && (err.stderr || err.stdout || err.message)) || '').trim();
    assert(`can load ${rev}:${filePath}`, false, detail || 'git show failed');
    return '';
  }
}

function extractFunctionSource(src, name) {
  const needle = `function ${name}(`;
  const start = src.indexOf(needle);
  if (start < 0) return null;
  const braceStart = src.indexOf('{', start);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function evalDrawerFns(label, src, fnNames, extraSrc) {
  const ctx = {
    console,
    __group: null,
    scheduleFindGroupForRow: function() { return ctx.__group; },
  };
  vm.createContext(ctx);

  if (extraSrc) {
    const rowRef = extractFunctionSource(extraSrc, 'scheduleRowBookingRef');
    if (rowRef) vm.runInContext(`${rowRef}\nthis.scheduleRowBookingRef=scheduleRowBookingRef;`, ctx);
  }

  fnNames.forEach((name) => {
    const fnSrc = extractFunctionSource(src, name);
    assert(`${label}: function ${name} exists`, !!fnSrc);
    if (fnSrc) vm.runInContext(`${fnSrc}\nthis.${name}=${name};`, ctx);
  });

  return ctx;
}

function mockGroup(records) {
  return { records: records || [] };
}

const STAFF_ROW = { _isDbManual: true, record_source: 'staff_manual', booking_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
const LUNA_ROW = { record_source: 'luna_guest', booking_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' };
const DEMO_LUNA_ROW = { _isDemo: true, record_source: 'luna_guest', booking_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' };
const UNKNOWN_ROW = { record_source: 'mystery', booking_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd' };

console.log('\nverify:sunset-drawer-luna-canonical\n');

// ── RED evidence: Slice 10 baseline (6e74fc2) ───────────────────────────────
console.log(`[RED] Slice 10 baseline (${SLICE10_BASE.slice(0, 7)}) monolithic portal`);
const baseApiSrc = gitShow(SLICE10_BASE, 'scripts/staff-query-api.js');
const baseDrawerSrc = gitShow(SLICE10_BASE, 'scripts/lib/sunset-schedule-booking-drawer.js');

if (baseApiSrc) {
  assert('baseline lacks portal module injection marker',
    !baseApiSrc.includes('/* INJECT:sunset-schedule-portal-module */'));
  assert('baseline has inline submitScheduleManualBooking',
    /function submitScheduleManualBooking\s*\(/.test(baseApiSrc));
  assert('baseline create uses client weekday eligibility helper',
    baseApiSrc.includes('scheduleCourseEligibleOnDates'));
  assert('baseline lacks schedulePortalFetchQuote',
    !baseApiSrc.includes('schedulePortalFetchQuote'));
}

if (baseDrawerSrc) {
  assert('baseline detail gate returns drawer_edits_limited error',
    baseDrawerSrc.includes('drawer_edits_limited_to_staff_manual_schedule'));
  assert('baseline lacks bundleHasTrustedScheduleDrawerAttribution name',
    !baseDrawerSrc.includes('function bundleHasTrustedScheduleDrawerAttribution'));
}

// ── GREEN evidence: HEAD ──────────────────────────────────────────────────────
console.log('\n[GREEN] HEAD canonical drawer gating + portal module');
const headSrc = fs.readFileSync(STAFF_API_PATH, 'utf8');
const portalModSrc = fs.existsSync(PORTAL_MODULE_PATH)
  ? fs.readFileSync(PORTAL_MODULE_PATH, 'utf8')
  : '';
const drawerSrc = fs.existsSync(DRAWER_PATH) ? fs.readFileSync(DRAWER_PATH, 'utf8') : '';
const ctrlSrc = fs.existsSync(CTRL_MODULE_PATH) ? fs.readFileSync(CTRL_MODULE_PATH, 'utf8') : '';

assert('HEAD injects schedule portal module', headSrc.includes('/* INJECT:sunset-schedule-portal-module */'));
assert('HEAD injects schedule drawer delete module', headSrc.includes('/* INJECT:sunset-schedule-drawer-delete-ui */'));
assert('HEAD injects schedule drawer controller module', headSrc.includes('/* INJECT:sunset-schedule-drawer-controller */'));
assert('HEAD injects schedule day ops board module', headSrc.includes('/* INJECT:sunset-schedule-day-ops-board-ui */'));
assert('HEAD injects schedule forecast cards module', headSrc.includes('/* INJECT:sunset-schedule-forecast-cards-ui */'));
assert('HEAD uses scheduleDrawerCanLoadCanonical in openScheduleDetailDrawer',
  /scheduleDrawerCanLoadCanonical\(row\)/.test(ctrlSrc));
assert('HEAD server trusted attribution gate', drawerSrc.includes('function bundleHasTrustedScheduleDrawerAttribution'));
assert('HEAD server detail uses drawer_untrusted_booking_source',
  drawerSrc.includes('drawer_untrusted_booking_source'));
assert('HEAD legacy drawer_edits error removed', !drawerSrc.includes('drawer_edits_limited_to_staff_manual_schedule'));

const head = evalDrawerFns('HEAD', portalModSrc, [
  'scheduleDrawerTrustedPersistedSource',
  'scheduleDrawerGroupHasTrustedPersistedSource',
  'scheduleDrawerCanLoadCanonical',
  'scheduleDrawerCanEdit',
], headSrc);

head.__group = mockGroup([STAFF_ROW]);
assert('HEAD Staff persisted row can load canonical drawer', head.scheduleDrawerCanLoadCanonical(STAFF_ROW) === true);
assert('HEAD Staff persisted row can edit in canonical drawer', head.scheduleDrawerCanEdit(STAFF_ROW) === true);

head.__group = mockGroup([LUNA_ROW]);
assert('HEAD Luna persisted row can load canonical drawer', head.scheduleDrawerCanLoadCanonical(LUNA_ROW) === true);
assert('HEAD Luna persisted row can edit in canonical drawer', head.scheduleDrawerCanEdit(LUNA_ROW) === true);

head.__group = mockGroup([{ record_source: 'luna_guest', booking_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' }]);
assert('HEAD resolves booking ref from grouped records',
  head.scheduleDrawerCanLoadCanonical({ record_source: 'luna_guest' }) === true);

head.__group = mockGroup([DEMO_LUNA_ROW]);
assert('HEAD demo rows remain read-only and do not load canonical drawer',
  head.scheduleDrawerCanLoadCanonical(DEMO_LUNA_ROW) === false);

head.__group = mockGroup([UNKNOWN_ROW]);
assert('HEAD unsupported source fails safely (no canonical drawer)',
  head.scheduleDrawerCanLoadCanonical(UNKNOWN_ROW) === false);

console.log(`\n── verify:sunset-drawer-luna-canonical ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
process.exitCode = fail > 0 ? 1 : 0;
