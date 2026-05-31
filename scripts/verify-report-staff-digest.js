/**
 * Stage 6.4d — Static verifier for report-staff-digest.js.
 *
 * Reads the report source as text and checks structural/safety patterns.
 * Does NOT connect to any DB, does NOT execute queries.
 *
 * Checks:
 *   1.  Report file exists and is valid JS syntax
 *   2.  Report imports staff-query-registry.js
 *   3.  Report uses pg-connect (withPgClient)
 *   4.  Report references all four categories: handoffs, payments, rooming, addons
 *   5.  Report resolves SQL from helperRef() only — no embedded raw SQL
 *   6.  Report contains no write SQL keywords
 *   7.  Report does not accept arbitrary SQL (no eval)
 *   8.  Report does not shell out to other report scripts
 *   9.  Report appends only to logs/staff-query-log.jsonl
 *   10. Report handles missing required params with skip output
 *   11. Report handles missingHelper entries gracefully (skip)
 *   12. Report handles non-readOnly / non-clientSlugged entries (skip)
 *   13. Report supports --client, --date, --start, --end, --booking flags
 *   14. Report has no workflow JSON modification or activation logic
 *   15. Report uses parameterised binding (params array)
 *   16. Report writes single audit entry with intent "batch:digest"
 *   17. Report exits non-zero if any intent fails
 *   18. package.json scripts present
 *
 * Exit code: 0 on PASS, 1 on FAIL.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPORT_PATH = path.join(__dirname, 'report-staff-digest.js');
const PKG_PATH    = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function pass(msg) { console.log(`  ✓ ${msg}`); passes++; }
function fail(msg) { console.error(`  ✗ ${msg}`); failures++; }
function section(title) { console.log(`\n── ${title} ──`); }

function has(src, re)   { return re.test(src); }
function lacks(src, re) { return !re.test(src); }

// ─────────────────────────────────────────────────────────────────────────────
section('1. File exists and valid syntax');

if (!fs.existsSync(REPORT_PATH)) {
  fail('report-staff-digest.js does not exist');
  process.exit(1);
}
pass('report-staff-digest.js exists');

let src = '';
try {
  src = fs.readFileSync(REPORT_PATH, 'utf8');
  pass(`file readable (${src.length} chars)`);
} catch (e) {
  fail(`cannot read: ${e.message}`); process.exit(1);
}

try {
  execSync(`node --check "${REPORT_PATH}"`, { stdio: 'pipe' });
  pass('passes node --check (no syntax errors)');
} catch (e) {
  fail(`syntax error: ${e.stderr ? e.stderr.toString().trim() : e.message}`); process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
section('2. Imports staff-query-registry');

if (has(src, /require.*staff-query-registry/)) {
  pass("requires './lib/staff-query-registry'");
} else {
  fail('does not require staff-query-registry');
}

// ─────────────────────────────────────────────────────────────────────────────
section('3. Uses pg-connect (withPgClient)');

if (has(src, /require.*pg-connect/))  { pass("requires './lib/pg-connect'"); } else { fail('does not require pg-connect'); }
if (has(src, /withPgClient/))          { pass('uses withPgClient'); }           else { fail('does not use withPgClient'); }
if (lacks(src, /new\s+Client\s*\(/))   { pass('does not directly instantiate pg.Client'); } else { fail('directly instantiates pg.Client'); }

// ─────────────────────────────────────────────────────────────────────────────
section('4. References all four categories');

const categories = ['handoffs', 'payments', 'rooming', 'addons'];
for (const cat of categories) {
  if (has(src, new RegExp(`['"]${cat}['"]`))) {
    pass(`references category '${cat}'`);
  } else {
    fail(`missing category '${cat}'`);
  }
}
if (has(src, /CATEGORIES\s*=\s*\[|getEntriesByCategory/)) {
  pass('iterates categories via getEntriesByCategory or CATEGORIES array');
} else {
  fail('category iteration not clearly present');
}

// ─────────────────────────────────────────────────────────────────────────────
section('5. SQL from helperRef() only');

if (has(src, /helperRef\s*\(\s*\)/))           { pass('SQL from entry.helperRef()'); }      else { fail('helperRef() call not found'); }
if (lacks(src, /`[^`]*\bSELECT\b[^`]*`/i))    { pass('no embedded raw SELECT'); }          else { fail('embedded raw SQL in template literal'); }

// ─────────────────────────────────────────────────────────────────────────────
section('6. No write SQL keywords');

const WRITE_SQL_RE = /\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|TRUNCATE\s+TABLE|CREATE\s+TABLE|MERGE\s+INTO)\b/i;
if (lacks(src, WRITE_SQL_RE)) { pass('no write SQL keywords'); } else { fail('write SQL keyword found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('7. No eval / arbitrary SQL');

if (lacks(src, /eval\s*\(/))                           { pass('no eval()'); }                                           else { fail('uses eval()'); }
if (lacks(src, /client\.query\s*\(\s*`[^`]*\$\{/))    { pass('no template-literal injection in client.query'); }       else { fail('template-literal injection risk'); }

// ─────────────────────────────────────────────────────────────────────────────
section('8. Does not shell out to other report scripts');

if (lacks(src, /require\s*\(\s*['"].*report-staff-/))  { pass('no require() of other report scripts'); }  else { fail('requires another report script'); }
if (lacks(src, /execSync|exec\s*\(|spawn\s*\(/))        { pass('no shell execution'); }                    else { fail('uses execSync/exec/spawn'); }

// ─────────────────────────────────────────────────────────────────────────────
section('9. Audit log to logs/staff-query-log.jsonl');

if (has(src, /staff-query-log\.jsonl/))                 { pass('references staff-query-log.jsonl'); }                            else { fail('no reference to staff-query-log.jsonl'); }
if (has(src, /appendFileSync|appendFile/))              { pass('uses appendFile for audit log'); }                               else { fail('does not use appendFile'); }
if (lacks(src, /writeFileSync|createWriteStream/))      { pass('no writeFileSync/createWriteStream'); }                          else { fail('may overwrite log'); }

// ─────────────────────────────────────────────────────────────────────────────
section('10. Handles missing required params (skip)');

if (has(src, /missingRequired/) && has(src, /\[skip\]/)) { pass('checks missingRequired and prints [skip]'); } else { fail('missing required param handling not found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('11. Handles missingHelper entries (skip)');

if (has(src, /missingHelper/)) { pass('checks missingHelper flag'); } else { fail('does not check missingHelper'); }

// ─────────────────────────────────────────────────────────────────────────────
section('12. Handles non-readOnly / non-clientSlugged (skip)');

if (has(src, /readOnly\s*!==\s*true|clientSlugged\s*!==\s*true/)) { pass('guards unsafe entries'); } else { fail('does not guard unsafe entries'); }

// ─────────────────────────────────────────────────────────────────────────────
section('13. Supports --client, --date, --start, --end, --booking flags');

const requiredFlags = ['--client', '--date', '--start', '--end', '--booking'];
for (const flag of requiredFlags) {
  if (has(src, new RegExp(flag.replace('--', '--')))) {
    pass(`supports ${flag}`);
  } else {
    fail(`does not support ${flag}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section('14. No workflow modification or activation');

if (lacks(src, /workflow\.active\s*=\s*true|workflows\/activate|n8n.*activate.*workflow/i)) { pass('no activation logic'); }             else { fail('activation logic found'); }
if (lacks(src, /build-main-local-stripe|workflow.*\.json/i))                                 { pass('no reference to workflow JSON files'); } else { fail('references workflow JSON'); }

// ─────────────────────────────────────────────────────────────────────────────
section('15. Parameterised binding');

if (has(src, /client\.query\s*\(\s*sql\s*,\s*params\s*\)/)) { pass('client.query(sql, params) pattern used'); } else { fail('parameterised pattern not found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('16. Single audit entry with intent "batch:digest"');

if (has(src, /batch:digest/))                               { pass('audit entry uses "batch:digest"'); }       else { fail('"batch:digest" not found'); }
if (has(src, /category.*digest|'digest'|"digest"/))        { pass('audit category set to "digest"'); }         else { fail('audit category not set to "digest"'); }
if (has(src, /row_count.*grandTotal|grandTotal.*row_count/)) { pass('audit entry includes grandTotal row_count'); } else { fail('audit entry missing grandTotal'); }

// ─────────────────────────────────────────────────────────────────────────────
section('17. Exits non-zero on failure');

if (has(src, /anyFailed/) && has(src, /process\.exit\(1\)/)) { pass('tracks anyFailed and exits non-zero'); } else { fail('failure tracking not found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('18. package.json scripts present');

try {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const s = pkg.scripts || {};
  if (s['report:digest'])              { pass('package.json has "report:digest"'); }              else { fail('package.json missing "report:digest"'); }
  if (s['verify:report-staff-digest']) { pass('package.json has "verify:report-staff-digest"'); } else { fail('package.json missing "verify:report-staff-digest"'); }
} catch (e) {
  fail(`cannot read package.json: ${e.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
const result = failures === 0 ? 'PASS' : 'FAIL';
console.log(`Result: ${result} — ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
