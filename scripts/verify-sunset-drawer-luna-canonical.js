'use strict';

/**
 * verify:sunset-drawer-luna-canonical
 *
 * Regression: persisted Luna schedule rows must use the same canonical booking drawer
 * renderer as Staff-persisted rows (only creator attribution differs).
 *
 * This verifier proves RED against origin/master (legacy drawer gating) and GREEN on HEAD.
 *
 * Run: node scripts/verify-sunset-drawer-luna-canonical.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAFF_API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

function loadOriginMasterStaffApi() {
  try {
    return execFileSync(
      'git',
      ['show', 'origin/master:scripts/staff-query-api.js'],
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
  } catch (err) {
    const detail = String((err && (err.stderr || err.stdout || err.message)) || '').trim();
    assert('can load origin/master staff-query-api.js', false, detail || 'git show failed');
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

function evalDrawerFns(label, src, fnNames) {
  const ctx = {
    console,
    // injected per-test
    __group: null,
    scheduleFindGroupForRow: () => ctx.__group,
  };
  vm.createContext(ctx);

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

// ── RED evidence: origin/master routes persisted Luna rows to legacy drawer ──
console.log('[RED] origin/master legacy drawer gating');
const baseSrc = loadOriginMasterStaffApi();
if (baseSrc) {
  assert('origin/master uses scheduleDrawerEditableEnabled in openScheduleDetailDrawer',
    /var useDrawerApi = scheduleDrawerEditableEnabled\(row\)/.test(baseSrc));

  const base = evalDrawerFns('origin/master', baseSrc, [
    'scheduleRowBookingRef',
    'scheduleDrawerEditableEnabled',
  ]);

  base.__group = mockGroup([STAFF_ROW]);
  assert('origin/master Staff persisted row uses canonical drawer gate',
    base.scheduleDrawerEditableEnabled(STAFF_ROW) === true);

  base.__group = mockGroup([LUNA_ROW]);
  assert('origin/master Luna persisted row incorrectly fails canonical drawer gate (legacy drawer)',
    base.scheduleDrawerEditableEnabled(LUNA_ROW) === false);
}

// ── GREEN evidence: HEAD loads canonical drawer for Staff + Luna ─────────────
console.log('\n[GREEN] HEAD canonical drawer gating');
const headSrc = fs.readFileSync(STAFF_API_PATH, 'utf8');

assert('HEAD uses scheduleDrawerCanLoadCanonical in openScheduleDetailDrawer',
  /var useDrawerApi = scheduleDrawerCanLoadCanonical\(row\)/.test(headSrc));

const head = evalDrawerFns('HEAD', headSrc, [
  'scheduleRowBookingRef',
  'scheduleDrawerTrustedPersistedSource',
  'scheduleDrawerGroupHasTrustedPersistedSource',
  'scheduleDrawerCanLoadCanonical',
  'scheduleDrawerCanEdit',
]);

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
if (fail > 0) process.exit(1);

