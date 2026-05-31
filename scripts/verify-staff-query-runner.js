/**
 * Stage 6.2 — Static verifier for staff-query-runner.js.
 *
 * Reads the runner source as text and checks structural/safety patterns.
 * Does NOT connect to any DB, does NOT execute queries.
 *
 * Checks:
 *   1.  Runner file exists and is valid JS syntax
 *   2.  Runner requires staff-query-registry.js
 *   3.  Runner uses pg-connect (withPgClient) — not raw pg.Client
 *   4.  Runner validates the first positional arg (intent key)
 *   5.  Runner supports --client flag for client_slug binding
 *   6.  Runner blocks unknown intents (getEntry + exit check)
 *   7.  Runner blocks missingHelper entries
 *   8.  Runner blocks non-readOnly entries
 *   9.  Runner blocks non-clientSlugged entries
 *   10. Runner does not accept arbitrary SQL (no eval, no raw SQL vars)
 *   11. Runner uses parameterised query binding (not string interpolation)
 *   12. Runner appends to logs/staff-query-log.jsonl
 *   13. Runner does not write to workflow JSON
 *   14. Runner does not activate guest workflows
 *   15. Runner has no write/action mode
 *
 * Exit code: 0 on PASS, 1 on FAIL.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RUNNER_PATH = path.join(__dirname, 'staff-query-runner.js');

// ─────────────────────────────────────────────────────────────────────────────

let passes = 0;
let failures = 0;

function pass(msg) { console.log(`  ✓ ${msg}`); passes++; }
function fail(msg) { console.error(`  ✗ ${msg}`); failures++; }
function section(title) { console.log(`\n── ${title} ──`); }

function hasPattern(src, re)   { return re.test(src); }
function lacksPattern(src, re) { return !re.test(src); }

// ─────────────────────────────────────────────────────────────────────────────
// 1. File exists + syntax
// ─────────────────────────────────────────────────────────────────────────────
section('1. File exists and valid syntax');

if (!fs.existsSync(RUNNER_PATH)) {
  fail('staff-query-runner.js does not exist');
  process.exit(1);
}
pass('staff-query-runner.js exists');

let src = '';
try {
  src = fs.readFileSync(RUNNER_PATH, 'utf8');
  pass(`file readable (${src.length} chars)`);
} catch (e) {
  fail(`cannot read file: ${e.message}`);
  process.exit(1);
}

try {
  execSync(`node --check "${RUNNER_PATH}"`, { stdio: 'pipe' });
  pass('passes node --check (no syntax errors)');
} catch (e) {
  fail(`syntax error: ${e.stderr ? e.stderr.toString().trim() : e.message}`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Requires staff-query-registry
// ─────────────────────────────────────────────────────────────────────────────
section('2. Requires staff-query-registry');

if (hasPattern(src, /require.*staff-query-registry/)) {
  pass("requires './lib/staff-query-registry'");
} else {
  fail('does not require staff-query-registry');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Uses pg-connect (not raw pg.Client)
// ─────────────────────────────────────────────────────────────────────────────
section('3. Uses pg-connect (withPgClient)');

if (hasPattern(src, /require.*pg-connect/)) {
  pass("requires './lib/pg-connect'");
} else {
  fail('does not require pg-connect');
}
if (hasPattern(src, /withPgClient/)) {
  pass('uses withPgClient for DB connection');
} else {
  fail('does not use withPgClient');
}
// Should not directly new-up pg.Client (bypass pg-connect safety)
if (lacksPattern(src, /new\s+Client\s*\(/)) {
  pass('does not directly instantiate pg.Client');
} else {
  fail('directly instantiates pg.Client — use withPgClient instead');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Validates first positional arg
// ─────────────────────────────────────────────────────────────────────────────
section('4. Validates intent key (first positional arg)');

if (hasPattern(src, /intentKey/) && hasPattern(src, /process\.argv/)) {
  pass('reads intentKey from process.argv');
} else {
  fail('does not read intentKey from process.argv');
}
if (hasPattern(src, /!intentKey|intentKey\s*==\s*null/)) {
  pass('checks for missing intentKey');
} else {
  fail('does not check for missing intentKey');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. --client flag
// ─────────────────────────────────────────────────────────────────────────────
section('5. --client flag for client_slug binding');

if (hasPattern(src, /--client/)) {
  pass("supports --client flag");
} else {
  fail("does not support --client flag");
}
if (hasPattern(src, /clientSlug|client_slug/)) {
  pass('uses clientSlug variable for binding');
} else {
  fail('clientSlug variable not found');
}
if (hasPattern(src, /wolfhouse-somo/)) {
  pass("default client slug 'wolfhouse-somo' present");
} else {
  fail("default client slug 'wolfhouse-somo' not found");
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Blocks unknown intents
// ─────────────────────────────────────────────────────────────────────────────
section('6. Blocks unknown intents');

if (hasPattern(src, /getEntry\s*\(/) && hasPattern(src, /!entry|entry\s*==\s*null|Unknown intent/i)) {
  pass('calls getEntry and handles null result');
} else {
  fail('does not clearly block unknown intents via getEntry');
}
if (hasPattern(src, /process\.exit\(1\)/)) {
  pass('exits non-zero on error');
} else {
  fail('does not exit non-zero — may swallow errors silently');
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Blocks missingHelper entries
// ─────────────────────────────────────────────────────────────────────────────
section('7. Blocks missingHelper entries');

if (hasPattern(src, /missingHelper/)) {
  pass('checks missingHelper flag');
} else {
  fail('does not check missingHelper flag');
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Blocks non-readOnly entries
// ─────────────────────────────────────────────────────────────────────────────
section('8. Blocks non-readOnly entries');

if (hasPattern(src, /readOnly\s*!==\s*true|not readOnly/i)) {
  pass('checks readOnly !== true');
} else {
  fail('does not check readOnly property');
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Blocks non-clientSlugged entries
// ─────────────────────────────────────────────────────────────────────────────
section('9. Blocks non-clientSlugged entries');

if (hasPattern(src, /clientSlugged\s*!==\s*true|not client-scoped/i)) {
  pass('checks clientSlugged !== true');
} else {
  fail('does not check clientSlugged property');
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. No arbitrary SQL
// ─────────────────────────────────────────────────────────────────────────────
section('10. No arbitrary SQL accepted or executed');

// Runner must not eval or construct raw SQL from user input
if (lacksPattern(src, /eval\s*\(/)) {
  pass('no eval() calls');
} else {
  fail('uses eval() — never acceptable');
}
// SQL only comes from helperRef() call, not from user input
if (hasPattern(src, /helperRef\s*\(\s*\)/)) {
  pass('SQL obtained only from entry.helperRef()');
} else {
  fail('SQL source not clearly from helperRef()');
}
// No template literal with ${ inside a query string from user input
if (lacksPattern(src, /client\.query\s*\(\s*`[^`]*\$\{/)) {
  pass('no template-literal SQL injection risk in client.query calls');
} else {
  fail('client.query appears to use template literal with interpolation');
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Parameterised binding ($1 not string concat)
// ─────────────────────────────────────────────────────────────────────────────
section('11. Parameterised binding (params array)');

if (hasPattern(src, /client\.query\s*\(\s*sql\s*,\s*params\s*\)/)) {
  pass('client.query(sql, params) pattern used');
} else {
  fail('parameterised client.query(sql, params) pattern not found');
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. Audit log to logs/staff-query-log.jsonl
// ─────────────────────────────────────────────────────────────────────────────
section('12. Audit log to logs/staff-query-log.jsonl');

if (hasPattern(src, /staff-query-log\.jsonl/)) {
  pass('references staff-query-log.jsonl');
} else {
  fail('does not reference staff-query-log.jsonl');
}
if (hasPattern(src, /appendFileSync|appendFile/)) {
  pass('uses appendFile for audit log (append, not overwrite)');
} else {
  fail('audit log does not use appendFile');
}
// Audit entry must include intent, success/failure, row_count
if (hasPattern(src, /row_count/) && hasPattern(src, /success/) && hasPattern(src, /intent/)) {
  pass('audit entry includes intent, success, row_count');
} else {
  fail('audit entry missing one or more of: intent, success, row_count');
}
// Audit log must NOT write to Postgres tables
if (lacksPattern(src, /INSERT INTO.*audit|INSERT INTO.*log/i)) {
  pass('audit log does not write to Postgres');
} else {
  fail('audit log writes to Postgres — must be file-only in Stage 6.2');
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. Does not modify workflow JSON
// ─────────────────────────────────────────────────────────────────────────────
section('13. Does not modify workflow JSON');

if (lacksPattern(src, /workflow.*\.json|build-main-local-stripe/i)) {
  pass('no reference to workflow JSON files');
} else {
  fail('references workflow JSON — runner must not modify n8n workflows');
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. Does not activate guest workflows
// ─────────────────────────────────────────────────────────────────────────────
section('14. Does not activate guest workflows');

if (lacksPattern(src, /workflow\.active\s*=\s*true|workflows\/activate|n8n.*activate.*workflow|update:workflow.*--active=true/i)) {
  pass('no workflow activation logic');
} else {
  fail('contains workflow activation — must not activate guest workflows');
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. No write/action mode
// ─────────────────────────────────────────────────────────────────────────────
section('15. No write/action mode');

if (lacksPattern(src, /--action|action.*mode|executeWrite|resolveHandoff/i)) {
  pass('no --action / write mode in runner');
} else {
  fail('runner contains write/action mode — must be read-only in Stage 6.2');
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
const result = failures === 0 ? 'PASS' : 'FAIL';
console.log(`Result: ${result} — ${passes} passed, ${failures} failed`);

if (failures > 0) process.exit(1);
