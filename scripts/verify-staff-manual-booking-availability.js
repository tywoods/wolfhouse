/**
 * Stage 8.3g — Static verifier for staff-manual-booking-availability.js
 *
 * Checks (50 total):
 *   Static file checks (1–25):
 *    1:  Helper file exists
 *    2:  Helper file readable and non-trivial (>2000 chars)
 *    3:  node --check passes on helper (syntax clean)
 *    4:  Module loads without throwing
 *    5:  previewManualBookingAvailability exported and is a function
 *    6:  NON_BLOCKING_STATUSES exported
 *    7:  No pg-connect / pg / Pool require() import
 *    8:  No fetch() call
 *    9:  No fs.writeFile / fs.appendFile / fs.writeFileSync
 *   10:  No SQL string (no INSERT/SELECT/UPDATE/DELETE outside comments)
 *   11:  Half-open interval: existing_start < proposed_check_out operand present
 *   12:  Half-open interval: existing_end   > proposed_check_in  operand present
 *   13:  cancelled exclusion present (NON_BLOCKING_STATUSES)
 *   14:  expired exclusion present (NON_BLOCKING_STATUSES)
 *   15:  invalid_dates blocker present
 *   16:  no_selected_beds blocker present
 *   17:  bed_not_found blocker present
 *   18:  bed_inactive_or_unsellable blocker present
 *   19:  overlap_conflict blocker present
 *   20:  guest_count_exceeds_selected_beds blocker present
 *   21:  same_day_arrival warning present
 *   22:  next_day_arrival warning present
 *   23:  long_stay warning present
 *   24:  protected_room_selected warning present
 *   25:  operator_room_selected warning present
 *
 *   Output shape checks (26–35):
 *   26:  is_valid field in output
 *   27:  has_conflict field in output
 *   28:  blockers field in output
 *   29:  warnings field in output
 *   30:  proposed_nights field in output
 *   31:  selected_bed_count field in output
 *   32:  selected_beds field in output
 *   33:  conflict_beds field in output
 *   34:  conflict_assignments field in output
 *   35:  availability_by_bed field in output
 *
 *   No side-effect checks (36–38):
 *   36:  No STAFF_ACTIONS_ENABLED=true
 *   37:  No API route wiring (app.post / router.post etc.)
 *   38:  node --check passes on verifier itself
 *
 *   Functional fixture tests (39–50):
 *   39:  A. Valid: 1 bed, 3 nights, no assignments → is_valid true, no conflict
 *   40:  A. Valid: proposed_nights === 3
 *   41:  B. Invalid dates: checkout <= checkin → blocker invalid_dates
 *   42:  B. Invalid dates: is_valid false
 *   43:  C. Overlap: conflicting assignment → has_conflict true
 *   44:  C. Overlap: blockers includes overlap_conflict
 *   45:  D. Edge touch: existing_end === proposed_check_in → no conflict
 *   46:  D. Edge touch: existing_start === proposed_check_out → no conflict
 *   47:  E. Cancelled assignment overlap → does NOT block (is_valid true)
 *   48:  F. Bed inactive → blocker bed_inactive_or_unsellable
 *   49:  G. guest_count > beds → blocker guest_count_exceeds_selected_beds
 *   50:  H. Same-day arrival → warning same_day_arrival (no blocker)
 *
 * Usage:
 *   node scripts/verify-staff-manual-booking-availability.js
 */

'use strict';

const path       = require('path');
const fs         = require('fs');
const { execSync } = require('child_process');

const HELPER_FILE   = path.join(__dirname, 'lib', 'staff-manual-booking-availability.js');
const VERIFIER_FILE = path.join(__filename);
const PKG_FILE      = path.join(__dirname, '..', 'package.json');

let passes   = 0;
let failures = 0;

function ok(msg)   { console.log('  PASS  ' + msg); passes++; }
function fail(msg) { console.error('  FAIL  ' + msg); failures++; }
function check(cond, msg) { if (cond) ok(msg); else fail(msg); }

console.log('\nverify-staff-manual-booking-availability.js  (Stage 8.3g)\n');

// ── 1. File exists ─────────────────────────────────────────────────────────
check(fs.existsSync(HELPER_FILE), 'staff-manual-booking-availability.js exists');
if (!fs.existsSync(HELPER_FILE)) {
  console.error('\nFATAL: helper file missing — cannot continue.\n');
  process.exit(1);
}

// ── 2. Readable and non-trivial ────────────────────────────────────────────
const src = fs.readFileSync(HELPER_FILE, 'utf8');
check(src.length > 2000, 'File is readable and non-trivial (>2000 chars)');

// ── 3. Syntax clean ────────────────────────────────────────────────────────
let syntaxOk = false;
try {
  execSync('node --check "' + HELPER_FILE + '"', { stdio: 'pipe' });
  syntaxOk = true;
} catch (_) { /* falls through */ }
check(syntaxOk, 'node --check passes on helper (syntax clean)');

// ── 4. Module loads ────────────────────────────────────────────────────────
let mod = null;
try { mod = require(HELPER_FILE); } catch (_) { /* falls through */ }
check(mod !== null, 'Module loads without throwing');

// ── 5. previewManualBookingAvailability export ─────────────────────────────
const hasExport = mod && typeof mod.previewManualBookingAvailability === 'function';
check(hasExport, 'previewManualBookingAvailability exported and is a function');

// ── 6. NON_BLOCKING_STATUSES export ───────────────────────────────────────
check(
  mod && Array.isArray(mod.NON_BLOCKING_STATUSES),
  'NON_BLOCKING_STATUSES exported and is an array'
);

// ── 7. No pg-connect / pg / Pool require() ────────────────────────────────
const pgImport = /require\s*\(\s*['"][^'"]*(?:pg-connect|pg|pool)['"]/i;
check(!pgImport.test(src), 'No pg-connect / pg / Pool require() import');

// ── 8. No fetch() call ────────────────────────────────────────────────────
check(!/\bfetch\s*\(/.test(src), 'No fetch() call in helper');

// ── 9. No fs write calls ──────────────────────────────────────────────────
check(
  !/fs\.(writeFile|appendFile|writeFileSync|appendFileSync)\s*\(/i.test(src),
  'No fs.writeFile / fs.appendFile / writeFileSync in helper'
);

// ── 10. No raw SQL strings ────────────────────────────────────────────────
// Strip line comments first, then check for SQL keywords used as statements
const srcNoComments = src
  .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
  .replace(/\/\/[^\n]*/g, '');        // line comments
const sqlKeywords = /\b(INSERT INTO|UPDATE\s+\w|DELETE FROM|SELECT\s+\w.*FROM|CREATE TABLE|DROP TABLE)\b/i;
check(!sqlKeywords.test(srcNoComments), 'No raw SQL statement strings in helper');

// ── 11. Half-open: existing_start < proposed_check_out operand ────────────
check(
  /eStart\s*<\s*proposedCheckOut/.test(src) ||
  /assignment_start.*<.*check_out/i.test(src) ||
  /existing_start.*proposed_check_out/i.test(src),
  'Half-open interval: existing_start < proposed_check_out operand present'
);

// ── 12. Half-open: existing_end > proposed_check_in operand ──────────────
check(
  /eEnd\s*>\s*proposedCheckIn/.test(src) ||
  /assignment_end.*>.*check_in/i.test(src) ||
  /existing_end.*proposed_check_in/i.test(src),
  'Half-open interval: existing_end > proposed_check_in operand present'
);

// ── 13. cancelled exclusion ───────────────────────────────────────────────
check(
  /['"]cancelled['"]/.test(src),
  "cancelled exclusion present in NON_BLOCKING_STATUSES"
);

// ── 14. expired exclusion ─────────────────────────────────────────────────
check(
  /['"]expired['"]/.test(src),
  "expired exclusion present in NON_BLOCKING_STATUSES"
);

// ── 15. invalid_dates blocker ─────────────────────────────────────────────
check(/['"]invalid_dates['"]/.test(src), 'invalid_dates blocker present in source');

// ── 16. no_selected_beds blocker ──────────────────────────────────────────
check(/['"]no_selected_beds['"]/.test(src), 'no_selected_beds blocker present in source');

// ── 17. bed_not_found blocker ─────────────────────────────────────────────
check(/['"]bed_not_found['"]/.test(src), 'bed_not_found blocker present in source');

// ── 18. bed_inactive_or_unsellable blocker ────────────────────────────────
check(
  /['"]bed_inactive_or_unsellable['"]/.test(src),
  'bed_inactive_or_unsellable blocker present in source'
);

// ── 19. overlap_conflict blocker ──────────────────────────────────────────
check(/['"]overlap_conflict['"]/.test(src), 'overlap_conflict blocker present in source');

// ── 20. guest_count_exceeds_selected_beds blocker ─────────────────────────
check(
  /['"]guest_count_exceeds_selected_beds['"]/.test(src),
  'guest_count_exceeds_selected_beds blocker present in source'
);

// ── 21. same_day_arrival warning ──────────────────────────────────────────
check(/['"]same_day_arrival['"]/.test(src), 'same_day_arrival warning present in source');

// ── 22. next_day_arrival warning ──────────────────────────────────────────
check(/['"]next_day_arrival['"]/.test(src), 'next_day_arrival warning present in source');

// ── 23. long_stay warning ─────────────────────────────────────────────────
check(/['"]long_stay['"]/.test(src), 'long_stay warning present in source');

// ── 24. protected_room_selected warning ───────────────────────────────────
check(
  /['"]protected_room_selected['"]/.test(src),
  'protected_room_selected warning present in source'
);

// ── 25. operator_room_selected warning ────────────────────────────────────
check(
  /['"]operator_room_selected['"]/.test(src),
  'operator_room_selected warning present in source'
);

// ── Output shape checks (26–35) ───────────────────────────────────────────
// Obtain a sample output from a trivially valid call if module loaded
let sampleOutput = null;
if (hasExport) {
  try {
    sampleOutput = mod.previewManualBookingAvailability({
      check_in: '2026-07-01',
      check_out: '2026-07-04',
      selected_bed_codes: ['BED-01'],
      guest_count: 1,
      existing_assignments: [],
      beds: [{ bed_code: 'BED-01', room_code: 'ROOM-A', active: true, sellable: true }],
      options: {},
    });
  } catch (_) { /* skip */ }
}
const out = sampleOutput || {};
check('is_valid'           in out, 'Output has is_valid field');
check('has_conflict'       in out, 'Output has has_conflict field');
check('blockers'           in out, 'Output has blockers field');
check('warnings'           in out, 'Output has warnings field');
check('proposed_nights'    in out, 'Output has proposed_nights field');
check('selected_bed_count' in out, 'Output has selected_bed_count field');
check('selected_beds'      in out, 'Output has selected_beds field');
check('conflict_beds'      in out, 'Output has conflict_beds field');
check('conflict_assignments' in out, 'Output has conflict_assignments field');
check('availability_by_bed'  in out, 'Output has availability_by_bed field');

// ── 36. No STAFF_ACTIONS_ENABLED=true ─────────────────────────────────────
check(
  !/STAFF_ACTIONS_ENABLED\s*=\s*true/i.test(src),
  'No STAFF_ACTIONS_ENABLED=true in helper'
);

// ── 37. No API route wiring ────────────────────────────────────────────────
check(
  !/app\.(post|patch|put|delete)\s*\(/i.test(src) &&
  !/router\.(post|patch|put|delete)\s*\(/i.test(src),
  'No API route wiring in helper'
);

// ── 38. Verifier syntax clean ─────────────────────────────────────────────
let verifierSyntaxOk = false;
try {
  execSync('node --check "' + VERIFIER_FILE + '"', { stdio: 'pipe' });
  verifierSyntaxOk = true;
} catch (_) { /* falls through */ }
check(verifierSyntaxOk, 'node --check passes on verifier itself');

// ─────────────────────────────────────────────────────────────────────────────
// Functional fixture tests (39–50)
// All use static in-memory data only. No DB. No files. No network.
// ─────────────────────────────────────────────────────────────────────────────

if (!hasExport) {
  console.log('\n  [SKIP] Functional fixture tests skipped — helper not loaded.\n');
} else {
  const fn = mod.previewManualBookingAvailability;

  const BEDS = [
    { bed_code: 'BED-01', room_code: 'ROOM-A', active: true,  sellable: true  },
    { bed_code: 'BED-02', room_code: 'ROOM-A', active: false, sellable: true  },
    { bed_code: 'BED-03', room_code: 'ROOM-B', active: true,  sellable: false },
  ];

  // ── A. Valid booking: 1 bed, 3 nights, no existing assignments ─────────────
  const resultA = fn({
    check_in:  '2026-08-10',
    check_out: '2026-08-13',
    selected_bed_codes: ['BED-01'],
    guest_count: 1,
    existing_assignments: [],
    beds: BEDS,
    options: { today: '2026-08-01' },
  });
  check(resultA.is_valid === true,    'A: Valid booking → is_valid true');
  check(resultA.proposed_nights === 3, 'A: Valid booking → proposed_nights === 3');

  // ── B. Invalid dates: checkout <= checkin ──────────────────────────────────
  const resultB = fn({
    check_in:  '2026-08-10',
    check_out: '2026-08-09',  // before checkin
    selected_bed_codes: ['BED-01'],
    guest_count: 1,
    existing_assignments: [],
    beds: BEDS,
    options: {},
  });
  check(
    Array.isArray(resultB.blockers) && resultB.blockers.includes('invalid_dates'),
    'B: Invalid dates → blocker invalid_dates present'
  );
  check(resultB.is_valid === false, 'B: Invalid dates → is_valid false');

  // ── C. Overlap: conflicting active assignment on same bed ──────────────────
  const resultC = fn({
    check_in:  '2026-08-10',
    check_out: '2026-08-13',
    selected_bed_codes: ['BED-01'],
    guest_count: 1,
    existing_assignments: [{
      booking_code:         'BK-001',
      booking_status:       'confirmed',
      assignment_status:    'assigned',
      bed_code:             'BED-01',
      room_code:            'ROOM-A',
      assignment_start_date: '2026-08-12',
      assignment_end_date:   '2026-08-15',
      guest_name:            'Alice',
    }],
    beds: BEDS,
    options: {},
  });
  check(resultC.has_conflict === true, 'C: Overlap → has_conflict true');
  check(
    Array.isArray(resultC.blockers) && resultC.blockers.includes('overlap_conflict'),
    'C: Overlap → blockers includes overlap_conflict'
  );

  // ── D1. Edge touch: existing_end === proposed_check_in → no conflict ───────
  // existing ends on 2026-08-10, proposed starts on 2026-08-10 → no overlap
  const resultD1 = fn({
    check_in:  '2026-08-10',
    check_out: '2026-08-13',
    selected_bed_codes: ['BED-01'],
    guest_count: 1,
    existing_assignments: [{
      booking_code:         'BK-002',
      booking_status:       'confirmed',
      assignment_status:    'assigned',
      bed_code:             'BED-01',
      room_code:            'ROOM-A',
      assignment_start_date: '2026-08-07',
      assignment_end_date:   '2026-08-10', // ends exactly on proposed check-in
      guest_name:            'Bob',
    }],
    beds: BEDS,
    options: {},
  });
  check(resultD1.has_conflict === false, 'D1: existing_end === proposed_check_in → no conflict');

  // ── D2. Edge touch: existing_start === proposed_check_out → no conflict ────
  // existing starts on 2026-08-13, proposed ends on 2026-08-13 → no overlap
  const resultD2 = fn({
    check_in:  '2026-08-10',
    check_out: '2026-08-13',
    selected_bed_codes: ['BED-01'],
    guest_count: 1,
    existing_assignments: [{
      booking_code:         'BK-003',
      booking_status:       'confirmed',
      assignment_status:    'assigned',
      bed_code:             'BED-01',
      room_code:            'ROOM-A',
      assignment_start_date: '2026-08-13', // starts exactly on proposed check-out
      assignment_end_date:   '2026-08-16',
      guest_name:            'Carol',
    }],
    beds: BEDS,
    options: {},
  });
  check(resultD2.has_conflict === false, 'D2: existing_start === proposed_check_out → no conflict');

  // ── E. Cancelled overlapping assignment does not block ─────────────────────
  const resultE = fn({
    check_in:  '2026-08-10',
    check_out: '2026-08-13',
    selected_bed_codes: ['BED-01'],
    guest_count: 1,
    existing_assignments: [{
      booking_code:         'BK-004',
      booking_status:       'cancelled',   // non-blocking
      assignment_status:    'cancelled',
      bed_code:             'BED-01',
      room_code:            'ROOM-A',
      assignment_start_date: '2026-08-11',
      assignment_end_date:   '2026-08-14',
      guest_name:            'Dave',
    }],
    beds: BEDS,
    options: { today: '2026-08-01' },
  });
  check(resultE.is_valid === true, 'E: Cancelled overlap → does not block (is_valid true)');

  // ── F. Bed inactive → blocker ──────────────────────────────────────────────
  const resultF = fn({
    check_in:  '2026-08-10',
    check_out: '2026-08-13',
    selected_bed_codes: ['BED-02'],  // inactive
    guest_count: 1,
    existing_assignments: [],
    beds: BEDS,
    options: {},
  });
  check(
    Array.isArray(resultF.blockers) && resultF.blockers.includes('bed_inactive_or_unsellable'),
    'F: Inactive bed → blocker bed_inactive_or_unsellable'
  );

  // ── G. guest_count > selected beds → blocker ──────────────────────────────
  const resultG = fn({
    check_in:  '2026-08-10',
    check_out: '2026-08-13',
    selected_bed_codes: ['BED-01'],
    guest_count: 5,  // 5 > 1 bed
    existing_assignments: [],
    beds: BEDS,
    options: {},
  });
  check(
    Array.isArray(resultG.blockers) && resultG.blockers.includes('guest_count_exceeds_selected_beds'),
    'G: guest_count > beds → blocker guest_count_exceeds_selected_beds'
  );

  // ── H. Same-day arrival → warning only, no blocker ───────────────────────
  const resultH = fn({
    check_in:  '2026-08-01',
    check_out: '2026-08-04',
    selected_bed_codes: ['BED-01'],
    guest_count: 1,
    existing_assignments: [],
    beds: BEDS,
    options: { today: '2026-08-01' },  // today === check_in
  });
  check(
    Array.isArray(resultH.warnings) && resultH.warnings.includes('same_day_arrival'),
    'H: Same-day arrival → warning same_day_arrival present'
  );
  check(
    resultH.is_valid === true,
    'H: Same-day arrival → is_valid true (no blocker)'
  );
}

// ── package.json script check ──────────────────────────────────────────────
let pkgHasScript = false;
try {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  pkgHasScript = !!(
    pkg.scripts &&
    pkg.scripts['verify:staff-manual-booking-availability']
  );
} catch (_) { /* skip */ }
check(pkgHasScript, 'package.json has verify:staff-manual-booking-availability script');

// ── Summary ───────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log('  Total checks: ' + (passes + failures));
console.log('  PASS: '  + passes);
console.log('  FAIL: '  + failures);
console.log('─'.repeat(60));

if (failures === 0) {
  console.log('\n  ALL CHECKS PASSED — Stage 8.3g availability preview helper verified.\n');
} else {
  console.error('\n  ' + failures + ' CHECK(S) FAILED — review output above.\n');
  process.exit(1);
}
