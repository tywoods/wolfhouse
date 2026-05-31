/**
 * Stage 6.3 — Static verifier for report-staff-handoff-queue.js.
 *
 * Reads the report source as text and checks structural/safety patterns.
 * Does NOT connect to any DB, does NOT execute queries.
 *
 * Checks:
 *   1.  Report file exists and is valid JS syntax
 *   2.  Report imports staff-query-registry.js
 *   3.  Report uses pg-connect (withPgClient) — not raw pg.Client
 *   4.  Report uses getEntriesByCategory to load handoff entries
 *   5.  Report resolves SQL only from helperRef() — no embedded raw SQL
 *   6.  Report does not contain write SQL keywords
 *   7.  Report does not accept arbitrary SQL (no eval)
 *   8.  Report does not shell out to staff-query-runner.js
 *   9.  Report appends only to logs/staff-query-log.jsonl
 *   10. Report handles missing required params with skip output
 *   11. Report handles missingHelper entries gracefully (skip)
 *   12. Report handles non-readOnly/non-clientSlugged entries (skip)
 *   13. Report handles migration_required entries with advisory note
 *   14. Report defaults handoffs.stale hours to 24
 *   15. Report has no workflow JSON modification or activation logic
 *   16. Report uses parameterised binding (params array)
 *   17. Report appends a batch audit entry (intent: "batch:handoffs")
 *   18. Report exits non-zero if any runnable intent fails
 *
 * Exit code: 0 on PASS, 1 on FAIL.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPORT_PATH = path.join(__dirname, 'report-staff-handoff-queue.js');

// ─────────────────────────────────────────────────────────────────────────────

let passes = 0;
let failures = 0;

function pass(msg) { console.log(`  ✓ ${msg}`); passes++; }
function fail(msg) { console.error(`  ✗ ${msg}`); failures++; }
function section(title) { console.log(`\n── ${title} ──`); }

function has(src, re)  { return re.test(src); }
function lacks(src, re){ return !re.test(src); }

// ─────────────────────────────────────────────────────────────────────────────
// 1. File exists + syntax
// ─────────────────────────────────────────────────────────────────────────────
section('1. File exists and valid syntax');

if (!fs.existsSync(REPORT_PATH)) {
  fail('report-staff-handoff-queue.js does not exist');
  process.exit(1);
}
pass('report-staff-handoff-queue.js exists');

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
  pass('uses withPgClient for DB connection');
} else {
  fail('does not use withPgClient');
}
if (lacks(src, /new\s+Client\s*\(/)) {
  pass('does not directly instantiate pg.Client');
} else {
  fail('directly instantiates pg.Client — use withPgClient instead');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Uses getEntriesByCategory to load handoff entries
// ─────────────────────────────────────────────────────────────────────────────
section('4. Uses getEntriesByCategory for handoff entries');

if (has(src, /getEntriesByCategory/)) {
  pass('calls getEntriesByCategory');
} else {
  fail('does not call getEntriesByCategory');
}
if (has(src, /getEntriesByCategory\s*\(\s*['"]handoffs['"]\s*\)/)) {
  pass("getEntriesByCategory('handoffs') — category scoped");
} else {
  fail("getEntriesByCategory call not clearly scoped to 'handoffs'");
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. SQL from helperRef only — no embedded raw SQL
// ─────────────────────────────────────────────────────────────────────────────
section('5. SQL from helperRef() only — no embedded raw SQL');

if (has(src, /helperRef\s*\(\s*\)/)) {
  pass('SQL obtained only from entry.helperRef()');
} else {
  fail('helperRef() call not found — SQL source unclear');
}
// Raw SQL would mean a SELECT/INSERT/UPDATE inside a template literal or string
if (lacks(src, /`[^`]*\bSELECT\b[^`]*`/i)) {
  pass('no embedded raw SELECT in template literals');
} else {
  fail('embedded raw SQL found in template literal — use helperRef() only');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. No write SQL keywords
// ─────────────────────────────────────────────────────────────────────────────
section('6. No write SQL keywords in report body');

const WRITE_SQL_RE = /\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|TRUNCATE\s+TABLE|CREATE\s+TABLE|MERGE\s+INTO)\b/i;
if (lacks(src, WRITE_SQL_RE)) {
  pass('no write SQL keywords (INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE/MERGE)');
} else {
  fail('write SQL keyword found in report — must be read-only');
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. No eval / arbitrary SQL
// ─────────────────────────────────────────────────────────────────────────────
section('7. No eval / arbitrary SQL injection');

if (lacks(src, /eval\s*\(/)) {
  pass('no eval() calls');
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
  pass('no reference to staff-query-runner.js');
} else {
  fail('shells out or requires staff-query-runner.js — must use helpers directly');
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
  pass('uses appendFile for audit log (append, not overwrite)');
} else {
  fail('does not use appendFile for audit log');
}
if (lacks(src, /writeFileSync|createWriteStream/)) {
  pass('no writeFileSync/createWriteStream — will not overwrite log');
} else {
  fail('uses writeFileSync or createWriteStream — may overwrite audit log');
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Handles missing required params (skip output)
// ─────────────────────────────────────────────────────────────────────────────
section('10. Handles missing required params with skip');

if (has(src, /missingRequired/) && has(src, /\[skip\]/)) {
  pass('checks missingRequired and prints [skip]');
} else {
  fail('does not clearly handle missing required params with [skip] output');
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Handles missingHelper entries
// ─────────────────────────────────────────────────────────────────────────────
section('11. Handles missingHelper entries (skip)');

if (has(src, /missingHelper/)) {
  pass('checks missingHelper flag');
} else {
  fail('does not check missingHelper flag');
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. Handles non-readOnly / non-clientSlugged entries
// ─────────────────────────────────────────────────────────────────────────────
section('12. Handles non-readOnly / non-clientSlugged entries (skip)');

if (has(src, /readOnly\s*!==\s*true|clientSlugged\s*!==\s*true/)) {
  pass('checks readOnly !== true || clientSlugged !== true');
} else {
  fail('does not guard against non-readOnly or non-clientSlugged entries');
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. Handles migration_required with advisory note
// ─────────────────────────────────────────────────────────────────────────────
section('13. Handles migration_required with advisory note');

if (has(src, /migrationRequired/) && has(src, /\[requires/)) {
  pass('checks migrationRequired and prints [requires ...] advisory');
} else {
  fail('does not print migration advisory for migrationRequired entries');
}
// Must NOT hard-crash on migration entries — it should continue
if (has(src, /migrationRequired/) && lacks(src, /process\.exit.*migrationRequired|throw.*migrationRequired/i)) {
  pass('does not hard-crash on migrationRequired — continues with advisory');
} else {
  fail('may hard-crash on migrationRequired entries instead of continuing');
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. Defaults handoffs.stale hours to 24
// ─────────────────────────────────────────────────────────────────────────────
section("14. Defaults handoffs.stale hours to 24");

if (has(src, /DEFAULT_STALE_HOURS\s*=\s*['"]24['"]|stale.*hours.*24|hours.*default.*24/i)) {
  pass("default stale hours constant '24' present");
} else {
  fail("default stale hours not clearly set to '24'");
}
if (has(src, /flags\[.--hours.\].*DEFAULT_STALE_HOURS|flags\[.--hours.\].*'24'|flags\[.--hours.\].*"24"/)) {
  pass("--hours flag falls back to default when not supplied");
} else {
  fail("--hours fallback to default not clearly implemented");
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
// 17. Batch audit entry (intent: "batch:handoffs")
// ─────────────────────────────────────────────────────────────────────────────
section('17. Batch audit entry with intent "batch:handoffs"');

if (has(src, /batch:handoffs/)) {
  pass('audit entry uses intent "batch:handoffs"');
} else {
  fail('audit entry does not set intent to "batch:handoffs"');
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
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
const result = failures === 0 ? 'PASS' : 'FAIL';
console.log(`Result: ${result} — ${passes} passed, ${failures} failed`);

if (failures > 0) process.exit(1);
