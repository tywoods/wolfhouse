/**
 * Stage 6.5a — Static verifier for staff-action-runner.js.
 *
 * Reads the runner source as text and checks structural/safety patterns.
 * Does NOT connect to any DB. Does NOT execute actions.
 *
 * Checks:
 *   1.  Script file exists and passes node --check
 *   2.  ACTION_ALLOWLIST present and includes handoff.resolve
 *   3.  --confirm flag hard-fails (confirmed write not implemented)
 *   4.  No unguarded UPDATE execution (UPDATE only in string/preview)
 *   5.  No unguarded INSERT/DELETE execution
 *   6.  SQL preview is a string only — not passed to client.query
 *   7.  resolveHandoffSql imported but only used for reference (not executed)
 *   8.  Proposal output path present (printProposal or equivalent)
 *   9.  No-op path for already-resolved or missing handoff
 *   10. Read-only DB fetch present (SELECT query for handoff lookup)
 *   11. No eval / no shell-out
 *   12. No workflow activation / no webhook POST
 *   13. No Airtable write / no Stripe calls
 *   14. Audit log written to logs/staff-query-log.jsonl
 *   15. Audit intent uses action:handoff.resolve:proposal
 *   16. staff_handoffs not mutated (only read via SELECT)
 *   17. Protected tables not referenced in mutation context
 *   18. package.json scripts present
 *
 * Exit code: 0 on PASS, 1 on FAIL.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RUNNER_PATH = path.join(__dirname, 'staff-action-runner.js');
const PKG_PATH    = path.join(__dirname, '..', 'package.json');

let passes   = 0;
let failures = 0;

function pass(msg) { console.log(`  ✓ ${msg}`); passes++; }
function fail(msg) { console.error(`  ✗ ${msg}`); failures++; }
function section(title) { console.log(`\n── ${title} ──`); }

function has(src, re)   { return re.test(src); }
function lacks(src, re) { return !re.test(src); }

// ─────────────────────────────────────────────────────────────────────────────
section('1. File exists and valid syntax');

if (!fs.existsSync(RUNNER_PATH)) {
  fail('staff-action-runner.js does not exist');
  process.exit(1);
}
pass('staff-action-runner.js exists');

let src = '';
try {
  src = fs.readFileSync(RUNNER_PATH, 'utf8');
  pass(`file readable (${src.length} chars)`);
} catch (e) {
  fail(`cannot read: ${e.message}`); process.exit(1);
}

try {
  execSync(`node --check "${RUNNER_PATH}"`, { stdio: 'pipe' });
  pass('passes node --check (no syntax errors)');
} catch (e) {
  fail(`syntax error: ${e.stderr ? e.stderr.toString().trim() : e.message}`); process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
section('2. Action allowlist');

if (has(src, /ACTION_ALLOWLIST/))                   { pass('ACTION_ALLOWLIST defined'); }        else { fail('ACTION_ALLOWLIST not found'); }
if (has(src, /'handoff\.resolve'/))                  { pass("ACTION_ALLOWLIST includes 'handoff.resolve'"); } else { fail("ACTION_ALLOWLIST missing 'handoff.resolve'"); }
if (has(src, /ACTION_ALLOWLIST\.includes\(action\)/)) { pass('action validated against allowlist'); } else { fail('action not validated against allowlist'); }

// ─────────────────────────────────────────────────────────────────────────────
section('3. --confirm hard-fails (no writes in 6.5a)');

if (has(src, /--confirm/))                               { pass('--confirm flag is handled'); }          else { fail('--confirm flag not handled'); }
if (has(src, /confirmed.*writes.*not.*implemented|NOT implemented in Stage 6\.5a/i)) {
  pass('--confirm path prints "not implemented" message');
} else {
  fail('--confirm path does not print clear "not implemented" message');
}
if (has(src, /process\.exit\(1\)/) && has(src, /--confirm/)) { pass('--confirm path exits non-zero'); } else { fail('--confirm path does not exit non-zero'); }

// ─────────────────────────────────────────────────────────────────────────────
section('4. No unguarded UPDATE execution');

// The only UPDATE in the file should be inside a string/comment, never as a raw
// client.query(UPDATE...) call.
// Check that client.query is never called with an UPDATE statement directly.
if (lacks(src, /client\.query\s*\(\s*[`'"][\s\S]*?UPDATE/i)) {
  pass('client.query not called with UPDATE statement');
} else {
  fail('client.query may be called with UPDATE — verify it is only a string preview');
}

// Verify the UPDATE string is clearly labelled as preview
if (has(src, /SQL PREVIEW.*NOT executed|proposal only.*NOT executed/i)) {
  pass('UPDATE SQL clearly labelled as preview/not executed');
} else {
  fail('UPDATE SQL not clearly labelled as preview');
}

// ─────────────────────────────────────────────────────────────────────────────
section('5. No unguarded INSERT/DELETE execution');

if (lacks(src, /client\.query\s*\(\s*[`'"][\s\S]*?INSERT\b/i)) { pass('client.query not called with INSERT'); } else { fail('client.query may be called with INSERT'); }
if (lacks(src, /client\.query\s*\(\s*[`'"][\s\S]*?DELETE\b/i)) { pass('client.query not called with DELETE'); } else { fail('client.query may be called with DELETE'); }

// ─────────────────────────────────────────────────────────────────────────────
section('6. SQL preview is a string only, not executed');

// The resolveHandoffSql() return value should not be passed to client.query
if (lacks(src, /client\.query\s*\(\s*resolveHandoffSql\s*\(\s*\)/)) {
  pass('resolveHandoffSql() not passed to client.query');
} else {
  fail('resolveHandoffSql() passed to client.query — this would execute the write');
}

// ─────────────────────────────────────────────────────────────────────────────
section('7. resolveHandoffSql imported (not executed)');

if (has(src, /require.*staff-handoff-write-sql/))      { pass('requires staff-handoff-write-sql'); } else { fail('does not require staff-handoff-write-sql'); }
if (has(src, /resolveHandoffSql/))                      { pass('resolveHandoffSql referenced'); }     else { fail('resolveHandoffSql not referenced'); }

// ─────────────────────────────────────────────────────────────────────────────
section('8. Proposal output path present');

if (has(src, /printProposal|STAFF ACTION PROPOSAL/))   { pass('proposal print path present'); }  else { fail('proposal print path not found'); }
if (has(src, /SQL preview|SQL PREVIEW/i))               { pass('SQL preview section present'); }  else { fail('SQL preview section not found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('9. No-op paths (already resolved or not found)');

if (has(src, /handoff.*not.*found|not.*found.*handoff|handoff_not_found/i)) { pass('handles handoff not found'); } else { fail('missing not-found handling'); }
if (has(src, /already.*resolved|already_resolved|status.*resolved.*cancelled/i))  { pass('handles already-resolved handoff'); } else { fail('missing already-resolved handling'); }

// ─────────────────────────────────────────────────────────────────────────────
section('10. Read-only SELECT lookup present');

if (has(src, /HANDOFF_BY_ID_SQL|SELECT.*FROM\s+staff_handoffs/i)) { pass('read-only SELECT for handoff lookup present'); } else { fail('no SELECT lookup for handoff row'); }
if (has(src, /client\.query\s*\(\s*HANDOFF_BY_ID_SQL|client\.query\s*\(\s*HANDOFF_BY_ID_SQL/)) { pass('lookup query is executed via client.query'); } else { fail('lookup query does not appear to be executed'); }

// ─────────────────────────────────────────────────────────────────────────────
section('11. No eval / no shell-out');

if (lacks(src, /eval\s*\(/))                          { pass('no eval()'); }                  else { fail('uses eval()'); }
if (lacks(src, /execSync|exec\s*\(|spawn\s*\(/))      { pass('no shell execution'); }          else { fail('uses execSync/exec/spawn'); }

// ─────────────────────────────────────────────────────────────────────────────
section('12. No workflow activation / no webhook POST');

if (lacks(src, /workflow\.active\s*=\s*true|workflows\/activate/i)) { pass('no workflow activation'); }   else { fail('workflow activation logic found'); }
if (lacks(src, /\.post\s*\(|fetch\s*\(.*POST|axios\.post/i))         { pass('no HTTP POST calls'); }       else { fail('HTTP POST call found'); }
if (lacks(src, /n8n.*activate|activate.*workflow/i))                  { pass('no n8n activation'); }       else { fail('n8n activation found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('13. No Airtable writes / no Stripe calls');

if (lacks(src, /airtable|airtableClient|base\s*\(\s*['"]rec/i)) { pass('no Airtable references'); }  else { fail('Airtable reference found'); }
if (lacks(src, /stripe|checkout\.session|payment_intent/i))      { pass('no Stripe references'); }    else { fail('Stripe reference found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('14. Audit log written to logs/staff-query-log.jsonl');

if (has(src, /staff-query-log\.jsonl/)) { pass('references staff-query-log.jsonl'); } else { fail('no audit log reference'); }
if (has(src, /appendFileSync/))          { pass('uses appendFileSync for audit'); }    else { fail('does not use appendFileSync'); }

// ─────────────────────────────────────────────────────────────────────────────
section('15. Audit intent uses action:handoff.resolve:proposal');

if (has(src, /action:handoff\.resolve:proposal/)) { pass('audit intent is "action:handoff.resolve:proposal"'); } else { fail('audit intent not found'); }
if (has(src, /category.*staff_action|'staff_action'|"staff_action"/)) { pass('audit category set to staff_action'); } else { fail('audit category not set to staff_action'); }

// ─────────────────────────────────────────────────────────────────────────────
section('16. staff_handoffs not mutated (only read)');

// Any UPDATE of staff_handoffs must be inside a string only.
// The SQL preview uses UPDATE but it is never executed.
if (lacks(src, /client\.query\s*\(\s*[`'"][\s\S]{0,200}UPDATE\s+staff_handoffs/i)) {
  pass('no client.query(UPDATE staff_handoffs) present');
} else {
  fail('client.query appears to execute UPDATE staff_handoffs directly');
}

// ─────────────────────────────────────────────────────────────────────────────
section('17. Protected tables not mutated');

const protectedMutationRe = /client\.query\s*\(\s*[`'"][\s\S]{0,200}(INSERT INTO|UPDATE|DELETE FROM)\s+(bookings|payments|payment_events|booking_beds)\b/i;
if (lacks(src, protectedMutationRe)) { pass('no mutations to protected tables'); } else { fail('mutation to protected table found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('18. package.json scripts present');

try {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const s = pkg.scripts || {};
  if (s['staff:action'])               { pass('package.json has "staff:action"'); }               else { fail('package.json missing "staff:action"'); }
  if (s['verify:staff-action-runner']) { pass('package.json has "verify:staff-action-runner"'); } else { fail('package.json missing "verify:staff-action-runner"'); }
} catch (e) {
  fail(`cannot read package.json: ${e.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
const result = failures === 0 ? 'PASS' : 'FAIL';
console.log(`Result: ${result} — ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
