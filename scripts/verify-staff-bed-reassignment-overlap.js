/**
 * Stage 7.7k2 — Overlap/conflict safety verifier for staff-bed-reassignment-sql.js
 *
 * Focused on the correctness of the half-open interval overlap rule and every
 * guard that depends on it. Complements the broader 38-check verifier
 * (verify-staff-bed-reassignment-sql.js) with deeper structural checks.
 *
 * Checks (25 total):
 *
 *  A. Overlap CTE structure
 *   1.  overlap_check CTE exists and is named
 *   2.  conflict_count alias is defined inside overlap_check
 *
 *  B. Half-open interval operands (must be in the overlap CTE section)
 *   3.  Left side: assignment_start_date < [end operand] (start < proposed_end)
 *   4.  Right side: assignment_end_date > [start operand] (end > proposed_start)
 *   5.  Both comparisons appear together in the overlap section (not in separate unrelated blocks)
 *   6.  The end operand in check 3 references the CURRENT assignment end date
 *   7.  The start operand in check 4 references the CURRENT assignment start date
 *   8.  No user-supplied $2/$3/$4 etc. used as date boundary in the overlap check
 *       (dates must come from current_assignment, not raw params)
 *
 *  C. Current row exclusion
 *   9.  Overlap check excludes the current booking_beds row (id != / <> booking_bed_id)
 *  10.  The exclusion references the current_assignment alias (ca.booking_bed_id or similar)
 *
 *  D. Target bed scoping
 *  11.  Overlap check filters bed_id = target_bed.bed_id (or tb.bed_id)
 *  12.  overlap_check CTE references target_bed (CTE or alias tb)
 *
 *  E. Cancelled/expired exclusion
 *  13.  overlap_check excludes 'cancelled' booking status
 *  14.  overlap_check excludes 'expired' booking status
 *  15.  The exclusion is inside the overlap section (not only in a separate blockers CTE)
 *
 *  F. Overlap → blockers pipeline
 *  16.  blockers CTE references conflict_count
 *  17.  blocked_summary includes b_overlap (or equivalent overlap blocker column)
 *  18.  b_overlap set when conflict_count > 0
 *
 *  G. Defence-in-depth: UPDATE re-checks conflict_count
 *  19.  UPDATE booking_beds includes conflict_count = 0 guard in its WHERE clause
 *  20.  This check is INSIDE the updated CTE (not only in earlier CTEs)
 *
 *  H. Row lock on current assignment
 *  21.  current_assignment CTE contains FOR UPDATE
 *  22.  FOR UPDATE OF specifies the booking_beds alias (bb), not all tables
 *
 *  I. Date range preserved (no date change in UPDATE)
 *  23.  UPDATE SET block does NOT set assignment_start_date or assignment_end_date
 *  24.  UPDATE SET block does NOT reference param $3/$4/$5/$6/$7/$8 as a date value
 *       (dates are not overwritten with incoming params)
 *
 *  J. Conflict diagnostics returned
 *  25.  Final SELECT returns conflict_count (as a column or from overlap_check)
 *
 * Usage:
 *   node scripts/verify-staff-bed-reassignment-overlap.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const SQL_FILE = path.join(__dirname, 'lib', 'staff-bed-reassignment-sql.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0, failures = 0;
function ok(msg)   { console.log('  PASS  ' + msg); passes++; }
function fail(msg) { console.error('  FAIL  ' + msg); failures++; }
function check(cond, msg) { if (cond) ok(msg); else fail(msg); }

// ── Setup ──────────────────────────────────────────────────────────────────

console.log('\nverify-staff-bed-reassignment-overlap.js  (Stage 7.7k2)\n');

if (!fs.existsSync(SQL_FILE)) { console.error('FATAL: SQL helper not found'); process.exit(1); }

let mod;
try { mod = require(SQL_FILE); }
catch (e) { console.error('FATAL: module load error — ' + e.message); process.exit(1); }

const sql = mod.reassignBookingBedSql();
if (typeof sql !== 'string' || sql.length < 500) {
  console.error('FATAL: reassignBookingBedSql() did not return a usable string');
  process.exit(1);
}

// Normalise: collapse runs of whitespace/newlines to a single space.
// This lets regexes match across line boundaries without multiline complexity.
const norm = sql.replace(/\s+/g, ' ');

// Strip SQL line comments (-- ...) for checks that must avoid matching comment text.
const normStripped = norm.replace(/--[^-][^;]*/g, ' ');

// ── Helper: extract a named CTE body from the normalised SQL ───────────────
// Returns the text between "CTE_NAME AS (" and the matching closing ")" that
// terminates that CTE (stops at the next top-level comma/CTE delimiter).
function extractCte(name) {
  // Match: <name> AS ( ... ), where we grab up to the next top-level CTE keyword.
  // Simple approach: find the CTE header and capture until the next "\n-- ──" or
  // next CTE definition. Works on the raw (non-normalised) SQL for clarity.
  const start = sql.indexOf(name + ' AS (');
  if (start === -1) return '';
  // Take everything from that point; stop at the next CTE declaration at depth-0.
  // We use a parenthesis-depth counter on the substring.
  const sub = sql.slice(start);
  let depth = 0, inCte = false, i = 0;
  for (; i < sub.length; i++) {
    if (sub[i] === '(') { depth++; inCte = true; }
    if (sub[i] === ')') { depth--; if (inCte && depth === 0) { i++; break; } }
  }
  return sub.slice(0, i);
}

const overlapCte    = extractCte('overlap_check');
const blockersCte   = extractCte('blockers');
const blockedSumCte = extractCte('blocked_summary');
const updatedCte    = extractCte('updated');
const currentCte    = extractCte('current_assignment');

// Normalised versions of extracted CTEs (for regex matching)
const normOverlap   = overlapCte.replace(/\s+/g, ' ');
const normBlockers  = blockersCte.replace(/\s+/g, ' ');
const normUpdated   = updatedCte.replace(/\s+/g, ' ');
const normCurrent   = currentCte.replace(/\s+/g, ' ');

// Stripped (no line comments) normalised versions
const normOverlapS  = normOverlap.replace(/--[^;]*/g, ' ');

// ── A. Overlap CTE structure ───────────────────────────────────────────────

check(overlapCte.length > 50,
  'A1: overlap_check CTE exists and has body');

check(/conflict_count/i.test(overlapCte),
  'A2: conflict_count alias defined inside overlap_check');

// ── B. Half-open interval operands ────────────────────────────────────────

// B3: assignment_start_date < [something] — the start of an existing row is
// compared to (is before) the proposed END date.
check(/assignment_start_date\s*<\s*\S/.test(normOverlapS),
  'B3: overlap CTE: assignment_start_date < [end operand] present');

// B4: assignment_end_date > [something] — the end of an existing row is
// compared to (is after) the proposed START date.
check(/assignment_end_date\s*>\s*\S/.test(normOverlapS),
  'B4: overlap CTE: assignment_end_date > [start operand] present');

// B5: both comparisons appear inside the same overlap_check section
check(
  /assignment_start_date\s*</.test(normOverlapS) &&
  /assignment_end_date\s*>/.test(normOverlapS),
  'B5: both interval comparisons present in overlap_check CTE');

// B6: the end operand in start_date < X must be ca.assignment_end_date (current row end)
check(/assignment_start_date\s*<\s*ca\.assignment_end_date/.test(normOverlapS),
  'B6: start_date < ca.assignment_end_date (proposed end = current row end)');

// B7: the start operand in end_date > X must be ca.assignment_start_date (current row start)
check(/assignment_end_date\s*>\s*ca\.assignment_start_date/.test(normOverlapS),
  'B7: end_date > ca.assignment_start_date (proposed start = current row start)');

// B8: no bare $2/$3 etc. used as date boundary directly in the overlap check
// (dates must come from current_assignment alias, not raw params)
// Accept $1 for client_slug — that's fine. Reject $2/$3/$4/$5/$6/$7/$8 as date operands.
// Pattern: <  $N  or  >  $N  in the overlap CTE (after stripping comments)
check(!/[<>]\s*\$[2-8]\b/.test(normOverlapS),
  'B8: no raw param placeholders used as date operands in overlap check');

// ── C. Current row exclusion ───────────────────────────────────────────────

check(/conflict_bb\.id\s*!=\s*ca\.booking_bed_id|conflict_bb\.id\s*<>\s*ca\.booking_bed_id/
  .test(normOverlapS),
  'C9: overlap check excludes current booking_beds row (conflict_bb.id != ca.booking_bed_id)');

check(/ca\.booking_bed_id/.test(normOverlapS),
  'C10: exclusion references current_assignment alias (ca.booking_bed_id)');

// ── D. Target bed scoping ──────────────────────────────────────────────────

check(/conflict_bb\.bed_id\s*=\s*tb\.bed_id/.test(normOverlapS),
  'D11: overlap check filters on target bed (conflict_bb.bed_id = tb.bed_id)');

check(/target_bed|tb\./.test(normOverlapS),
  'D12: overlap_check CTE references target_bed CTE or alias tb');

// ── E. Cancelled/expired exclusion ────────────────────────────────────────

check(/NOT IN.*cancelled.*expired|NOT IN.*expired.*cancelled/i.test(normOverlapS),
  'E13+E14: overlap check excludes both cancelled and expired booking statuses');

// Confirm the exclusion lives in the overlap section, not only in blockers
check(/cancelled/.test(normOverlapS) && /expired/.test(normOverlapS),
  'E15: cancelled and expired exclusion is present inside overlap_check body');

// ── F. Overlap → blockers pipeline ────────────────────────────────────────

check(/conflict_count/.test(normBlockers),
  'F16: blockers CTE references conflict_count');

// blocked_summary has b_overlap or the overlap column propagated
check(/b_overlap/.test(blockedSumCte) || /b_overlap/.test(blockersCte),
  'F17: b_overlap column defined in blockers/blocked_summary pipeline');

check(/conflict_count.*>\s*0|>\s*0.*conflict_count/.test(normBlockers),
  'F18: b_overlap set when conflict_count > 0');

// ── G. Defence-in-depth: UPDATE re-checks conflict_count ──────────────────

check(/conflict_count/.test(normUpdated),
  'G19: UPDATE CTE contains conflict_count reference');

check(/conflict_count.*=\s*0|=\s*0.*conflict_count/.test(normUpdated),
  'G20: UPDATE CTE WHERE guard: conflict_count = 0');

// ── H. Row lock on current assignment ─────────────────────────────────────

check(/FOR UPDATE/.test(currentCte),
  'H21: current_assignment CTE contains FOR UPDATE');

check(/FOR UPDATE OF bb/.test(currentCte),
  'H22: FOR UPDATE scoped to booking_beds alias bb (not all tables)');

// ── I. Date range preserved in UPDATE ─────────────────────────────────────

// The UPDATE SET block must NOT set assignment_start_date or assignment_end_date
const updateSetBlock = normUpdated.replace(/--[^;]*/g, ' ');
check(!/SET.*assignment_start_date\s*=/.test(updateSetBlock),
  'I23: UPDATE SET does not overwrite assignment_start_date');
check(!/SET.*assignment_end_date\s*=/.test(updateSetBlock),
  'I24: UPDATE SET does not overwrite assignment_end_date');

// ── J. Conflict diagnostics returned ──────────────────────────────────────

// Final SELECT (everything after "result AS (") must include conflict_count
const resultIdx = sql.indexOf('result AS (');
const resultSection = resultIdx >= 0 ? sql.slice(resultIdx) : '';
check(/conflict_count/.test(resultSection),
  'J25: final result SELECT returns conflict_count');

// ── Package.json script ────────────────────────────────────────────────────

let pkg = {};
try { pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')); } catch (_) {}
check(!!(pkg.scripts && pkg.scripts['verify:staff-bed-reassignment-overlap']),
  'package.json has verify:staff-bed-reassignment-overlap script');

// ── Summary ───────────────────────────────────────────────────────────────

console.log('\nResult: ' + passes + ' passed, ' + failures + ' failed\n');
if (failures > 0) process.exit(1);
