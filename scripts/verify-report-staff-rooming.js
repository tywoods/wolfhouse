/**
 * Stage 6.4b — Static verifier for report-staff-rooming.js.
 *
 * Reads the report source as text and checks structural/safety patterns.
 * Does NOT connect to any DB, does NOT execute queries.
 *
 * Checks:
 *   1.  Report file exists and is valid JS syntax
 *   2.  Report imports staff-query-registry.js
 *   3.  Report uses pg-connect (withPgClient)
 *   4.  Report uses getEntriesByCategory('rooming')
 *   5.  Report resolves SQL from helperRef() only — no embedded raw SQL
 *   6.  Report contains no write SQL keywords
 *   7.  Report does not accept arbitrary SQL (no eval)
 *   8.  Report does not shell out to staff-query-runner.js
 *   9.  Report appends only to logs/staff-query-log.jsonl
 *   10. Report handles missingHelper entries gracefully (skip)
 *   11. Report handles non-readOnly / non-clientSlugged entries (skip)
 *   12. Report handles migration_required entries with advisory note
 *   13. Report handles missing required params with skip output
 *   14. Report supports --date, --start, --end CLI flags for rooming params
 *   15. Report has no workflow JSON modification or activation logic
 *   16. Report uses parameterised binding (params array)
 *   17. Report appends batch audit entry with intent "batch:rooming"
 *   18. Report exits non-zero if any runnable intent fails
 *
 * Exit code: 0 on PASS, 1 on FAIL.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPORT_PATH  = path.join(__dirname, 'report-staff-rooming.js');
const PKG_PATH     = path.join(__dirname, '..', 'package.json');

// ─────────────────────────────────────────────────────────────────────────────

let passes = 0;
let failures = 0;

function pass(msg) { console.log(`  ✓ ${msg}`); passes++; }
function fail(msg) { console.error(`  ✗ ${msg}`); failures++; }
function section(title) { console.log(`\n── ${title} ──`); }

function has(src, re)   { return re.test(src); }
function lacks(src, re) { return !re.test(src); }

// ─────────────────────────────────────────────────────────────────────────────
// 1. File exists + syntax
// ─────────────────────────────────────────────────────────────────────────────
section('1. File exists and valid syntax');

if (!fs.existsSync(REPORT_PATH)) {
  fail('report-staff-rooming.js does not exist');
  process.exit(1);
}
pass('report-staff-rooming.js exists');

let src = '';
try {
  src = fs.readFileSync(REPORT_PATH, 'utf8');
  pass(`file readable (${src.length} chars)`);
} catch (e) {
  fail(`cannot read: ${e.message}`);
  process.exit(1);
}

try {
  execSync(`node --check "${REPORT_PATH}"`, { stdio: 'pipe' });
  pass('passes node --check (no syntax errors)');
} catch (e) {
  fail(`syntax error: ${e.stderr ? e.stderr.toString().trim() : e.message}`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Imports staff-query-registry
// ─────────────────────────────────────────────────────────────────────────────
section('2. Imports staff-query-registry');

if (has(src, /require.*staff-query-registry/)) {
  pass("requires './lib/staff-query-registry'");
} else {
  fail('does not require staff-query-registry');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Uses pg-connect
// ─────────────────────────────────────────────────────────────────────────────
section('3. Uses pg-connect (withPgClient)');

if (has(src, /require.*pg-connect/)) {
  pass("requires './lib/pg-connect'");
} else {
  fail('does not require pg-connect');
}
if (has(src, /withPgClient/)) {
  pass('uses withPgClient');
} else {
  fail('does not use withPgClient');
}
if (lacks(src, /new\s+Client\s*\(/)) {
  pass('does not directly instantiate pg.Client');
} else {
  fail('directly instantiates pg.Client — use withPgClient instead');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Uses getEntriesByCategory('rooming')
// ─────────────────────────────────────────────────────────────────────────────
section("4. Uses getEntriesByCategory('rooming')");

if (has(src, /getEntriesByCategory/)) {
  pass('calls getEntriesByCategory');
} else {
  fail('does not call getEntriesByCategory');
}
if (has(src, /getEntriesByCategory\s*\(\s*['"]rooming['"]\s*\)/)) {
  pass("getEntriesByCategory('rooming') — category scoped");
} else {
  fail("getEntriesByCategory not clearly scoped to 'rooming'");
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. SQL from helperRef() only
// ─────────────────────────────────────────────────────────────────────────────
section('5. SQL from helperRef() only — no embedded raw SQL');

if (has(src, /helperRef\s*\(\s*\)/)) {
  pass('SQL obtained from entry.helperRef()');
} else {
  fail('helperRef() call not found — SQL source unclear');
}
if (lacks(src, /`[^`]*\bSELECT\b[^`]*`/i)) {
  pass('no embedded raw SELECT in template literals');
} else {
  fail('embedded raw SQL found in template literal — use helperRef() only');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. No write SQL keywords
// ─────────────────────────────────────────────────────────────────────────────
section('6. No write SQL keywords');

const WRITE_SQL_RE = /\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|TRUNCATE\s+TABLE|CREATE\s+TABLE|MERGE\s+INTO)\b/i;
if (lacks(src, WRITE_SQL_RE)) {
  pass('no write SQL keywords');
} else {
  fail('write SQL keyword found — must be read-only');
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. No eval / arbitrary SQL
// ─────────────────────────────────────────────────────────────────────────────
section('7. No eval / arbitrary SQL injection');

if (lacks(src, /eval\s*\(/)) {
  pass('no eval()');
} else {
  fail('uses eval() — never acceptable');
}
if (lacks(src, /client\.query\s*\(\s*`[^`]*\$\{/)) {
  pass('no template-literal SQL injection risk in client.query calls');
} else {
  fail('client.query uses template literal with interpolation');
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Does not shell out to staff-query-runner.js
// ─────────────────────────────────────────────────────────────────────────────
section('8. Does not shell out to staff-query-runner');

if (lacks(src, /require\s*\(\s*['"].*staff-query-runner|execSync.*staff-query-runner|exec\s*\(.*staff-query-runner/)) {
  pass('no require/exec reference to staff-query-runner.js');
} else {
  fail('shells out or requires staff-query-runner.js');
}
if (lacks(src, /execSync|exec\s*\(|spawn\s*\(/)) {
  pass('no shell execution (execSync / exec / spawn)');
} else {
  fail('uses execSync/exec/spawn — report must not shell out');
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Appends only to logs/staff-query-log.jsonl
// ─────────────────────────────────────────────────────────────────────────────
section('9. Audit log appended to logs/staff-query-log.jsonl');

if (has(src, /staff-query-log\.jsonl/)) {
  pass('references staff-query-log.jsonl');
} else {
  fail('does not reference staff-query-log.jsonl');
}
if (has(src, /appendFileSync|appendFile/)) {
  pass('uses appendFile for audit log');
} else {
  fail('does not use appendFile for audit log');
}
if (lacks(src, /writeFileSync|createWriteStream/)) {
  pass('no writeFileSync/createWriteStream — will not overwrite log');
} else {
  fail('uses writeFileSync or createWriteStream');
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Handles missingHelper entries
// ─────────────────────────────────────────────────────────────────────────────
section('10. Handles missingHelper entries (skip)');

if (has(src, /missingHelper/)) {
  pass('checks missingHelper flag');
} else {
  fail('does not check missingHelper flag');
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Handles non-readOnly / non-clientSlugged (skip)
// ─────────────────────────────────────────────────────────────────────────────
section('11. Handles non-readOnly / non-clientSlugged entries (skip)');

if (has(src, /readOnly\s*!==\s*true|clientSlugged\s*!==\s*true/)) {
  pass('checks readOnly !== true || clientSlugged !== true');
} else {
  fail('does not guard non-readOnly or non-clientSlugged entries');
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. Handles migration_required with advisory note
// ─────────────────────────────────────────────────────────────────────────────
section('12. Handles migration_required with advisory note');

if (has(src, /migrationRequired/) && has(src, /\[requires/)) {
  pass('checks migrationRequired and prints [requires ...] advisory');
} else {
  fail('does not print migration advisory for migrationRequired entries');
}
if (lacks(src, /process\.exit.*migrationRequired|throw.*migrationRequired/i)) {
  pass('does not hard-crash on migrationRequired');
} else {
  fail('may hard-crash on migrationRequired entries');
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. Handles missing required params with skip
// ─────────────────────────────────────────────────────────────────────────────
section('13. Handles missing required params with skip');

if (has(src, /missingRequired/) && has(src, /\[skip\]/)) {
  pass('checks missingRequired and prints [skip]');
} else {
  fail('does not handle missing required params with [skip]');
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. Supports rooming CLI flags (--date, --start, --end)
// ─────────────────────────────────────────────────────────────────────────────
section('14. Supports --date, --start, --end flags');

if (has(src, /--date/)) {
  pass('supports --date flag (rooming.arrivals cutoff)');
} else {
  fail('does not support --date flag');
}
if (has(src, /--start/) && has(src, /--end/)) {
  pass('supports --start and --end flags (rooming.occupied_beds)');
} else {
  fail('does not support --start / --end flags');
}
if (has(src, /start_date/) && has(src, /end_date/)) {
  pass('PARAM_FLAG maps start_date and end_date');
} else {
  fail('PARAM_FLAG does not map start_date / end_date');
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. No workflow modification or activation
// ─────────────────────────────────────────────────────────────────────────────
section('15. No workflow modification or activation');

if (lacks(src, /workflow\.active\s*=\s*true|workflows\/activate|n8n.*activate.*workflow/i)) {
  pass('no workflow activation logic');
} else {
  fail('contains workflow activation code');
}
if (lacks(src, /build-main-local-stripe|workflow.*\.json/i)) {
  pass('no reference to workflow JSON files');
} else {
  fail('references workflow JSON files');
}

// ─────────────────────────────────────────────────────────────────────────────
// 16. Parameterised binding
// ─────────────────────────────────────────────────────────────────────────────
section('16. Parameterised binding (params array)');

if (has(src, /client\.query\s*\(\s*sql\s*,\s*params\s*\)/)) {
  pass('client.query(sql, params) pattern used');
} else {
  fail('parameterised client.query(sql, params) pattern not found');
}

// ─────────────────────────────────────────────────────────────────────────────
// 17. Batch audit entry with intent "batch:rooming"
// ─────────────────────────────────────────────────────────────────────────────
section('17. Batch audit entry with intent "batch:rooming"');

if (has(src, /batch:rooming/)) {
  pass('audit entry uses intent "batch:rooming"');
} else {
  fail('audit entry does not set intent to "batch:rooming"');
}
if (has(src, /row_count.*totalRows|totalRows.*row_count/)) {
  pass('audit entry includes total row_count');
} else {
  fail('audit entry does not include total row_count');
}

// ─────────────────────────────────────────────────────────────────────────────
// 18. Exits non-zero on failure
// ─────────────────────────────────────────────────────────────────────────────
section('18. Exits non-zero if any runnable intent fails');

if (has(src, /anyFailed/) && has(src, /process\.exit\(1\)/)) {
  pass('tracks anyFailed and exits non-zero on failure');
} else {
  fail('does not clearly track failures or exit non-zero');
}

// ─────────────────────────────────────────────────────────────────────────────
// 19. package.json has report:rooming and verify:report-staff-rooming
// ─────────────────────────────────────────────────────────────────────────────
section('19. package.json scripts present');

let pkgOk = false;
try {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const scripts = pkg.scripts || {};
  if (scripts['report:rooming']) {
    pass('package.json has "report:rooming" script');
  } else {
    fail('package.json missing "report:rooming" script');
  }
  if (scripts['verify:report-staff-rooming']) {
    pass('package.json has "verify:report-staff-rooming" script');
  } else {
    fail('package.json missing "verify:report-staff-rooming" script');
  }
  pkgOk = true;
} catch (e) {
  fail(`cannot read package.json: ${e.message}`);
}
void pkgOk;

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
const result = failures === 0 ? 'PASS' : 'FAIL';
console.log(`Result: ${result} — ${passes} passed, ${failures} failed`);

if (failures > 0) process.exit(1);
