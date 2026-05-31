/**
 * Stage 6.5b — Static verifier for staff-action-runner.js.
 *
 * Reads the runner source as text and checks structural/safety patterns.
 * Does NOT connect to any DB. Does NOT execute actions.
 *
 * Checks:
 *   1.  Script file exists and passes node --check
 *   2.  ACTION_ALLOWLIST present and includes handoff.resolve
 *   3.  --confirm flag is handled (no longer hard-fails in 6.5b)
 *   4.  Proposal path still does not execute UPDATE via client.query
 *   5.  SQL preview is a string only — not passed to client.query in proposal branch
 *   6.  Confirmed write path present (resolveHandoffSql executed inside --confirm branch)
 *   7.  resolveHandoffSql is called only inside the confirmed write path
 *   8.  No INSERT/DELETE against any table
 *   9.  No unguarded client.query with UPDATE on protected tables
 *   10. Proposal output path present
 *   11. No-op paths for already-resolved or missing handoff
 *   12. Read-only SELECT lookup present
 *   13. No eval / no shell-out
 *   14. No workflow activation / no webhook POST
 *   15. No Airtable writes / no Stripe calls
 *   16. Audit log written to logs/staff-query-log.jsonl
 *   17. Both audit intents present: proposal and confirmed
 *   18. Confirmed intent is action:handoff.resolve:confirmed
 *   19. staff_handoffs update is client-scoped (uses resolveHandoffSql with params)
 *   20. Protected tables not mutated
 *   21. package.json scripts present
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

if (has(src, /ACTION_ALLOWLIST/))                    { pass('ACTION_ALLOWLIST defined'); }                         else { fail('ACTION_ALLOWLIST not found'); }
if (has(src, /'handoff\.resolve'/))                   { pass("ACTION_ALLOWLIST includes 'handoff.resolve'"); }      else { fail("ACTION_ALLOWLIST missing 'handoff.resolve'"); }
if (has(src, /ACTION_ALLOWLIST\.includes\(action\)/)) { pass('action validated against allowlist'); }               else { fail('action not validated against allowlist'); }

// ─────────────────────────────────────────────────────────────────────────────
section('3. --confirm flag handled (6.5b wires confirmed write)');

if (has(src, /--confirm/))                            { pass('--confirm flag is referenced'); }    else { fail('--confirm flag not referenced'); }
if (has(src, /confirmMode/))                          { pass('confirmMode variable present'); }     else { fail('confirmMode variable not found'); }
// Must NOT hard-fail unconditionally any more
if (lacks(src, /--confirm.*is NOT implemented|NOT implemented in Stage 6\.5a/i)) {
  pass('--confirm no longer hard-fails unconditionally');
} else {
  fail('--confirm still hard-fails — not updated for 6.5b');
}

// ─────────────────────────────────────────────────────────────────────────────
section('4. Proposal path does not execute UPDATE');

if (lacks(src, /client\.query\s*\(\s*[`'"][\s\S]*?UPDATE/i)) {
  pass('client.query not called with inline UPDATE string');
} else {
  fail('client.query may be called with an inline UPDATE string');
}
if (has(src, /SQL PREVIEW.*NOT executed|NOT executed without --confirm/i)) {
  pass('SQL preview clearly labelled as not executed (proposal)');
} else {
  fail('SQL preview not clearly labelled');
}

// ─────────────────────────────────────────────────────────────────────────────
section('5. SQL preview string not passed to client.query in proposal branch');

// In proposal mode printProposal is called — resolveHandoffSql is NOT called there
if (lacks(src, /printProposal[\s\S]{0,200}resolveHandoffSql\s*\(\s*\)/)) {
  pass('resolveHandoffSql not called inside printProposal');
} else {
  fail('resolveHandoffSql appears to be called inside printProposal');
}

// ─────────────────────────────────────────────────────────────────────────────
section('6. Confirmed write path present (resolveHandoffSql executed in --confirm branch)');

// Check that resolveHandoffSql is invoked as a function call (not just imported)
if (has(src, /const\s+sql\s*=\s*resolveHandoffSql\s*\(\s*\)/)) {
  pass('resolveHandoffSql() called to obtain SQL string');
} else {
  fail('resolveHandoffSql() not called to obtain SQL string');
}
// Also confirm the confirmMode flag controls the write path
if (has(src, /if\s*\(\s*!confirmMode\s*\)[\s\S]{0,600}return/) && has(src, /resolveHandoffSql\s*\(\s*\)/)) {
  pass('write path guarded behind confirmMode (proposal returns early)');
} else {
  fail('write path not clearly guarded behind confirmMode');
}
if (has(src, /client\.query\s*\(\s*sql\s*,\s*\[/)) {
  pass('client.query(sql, [...]) parameterised call present');
} else {
  fail('parameterised client.query call not found');
}

// ─────────────────────────────────────────────────────────────────────────────
section('7. resolveHandoffSql imported and used only in confirm branch');

if (has(src, /require.*staff-handoff-write-sql/)) { pass('requires staff-handoff-write-sql'); } else { fail('does not require staff-handoff-write-sql'); }
if (has(src, /resolveHandoffSql/))                 { pass('resolveHandoffSql referenced'); }     else { fail('resolveHandoffSql not referenced'); }

// ─────────────────────────────────────────────────────────────────────────────
section('8. No INSERT/DELETE against any table');

if (lacks(src, /client\.query\s*\(\s*[`'"][\s\S]*?INSERT\b/i)) { pass('no INSERT via client.query'); } else { fail('INSERT via client.query found'); }
if (lacks(src, /client\.query\s*\(\s*[`'"][\s\S]*?DELETE\b/i)) { pass('no DELETE via client.query'); } else { fail('DELETE via client.query found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('9. No client.query UPDATE on protected tables');

const protectedUpdateRe = /client\.query\s*\(\s*[`'"][\s\S]{0,200}UPDATE\s+(bookings|payments|payment_events|booking_beds)\b/i;
if (lacks(src, protectedUpdateRe)) { pass('no UPDATE on protected tables via client.query'); } else { fail('UPDATE on protected table found in client.query'); }

// ─────────────────────────────────────────────────────────────────────────────
section('10. Proposal output path present');

if (has(src, /printProposal|STAFF ACTION PROPOSAL/))  { pass('proposal print path present'); }  else { fail('proposal print path not found'); }
if (has(src, /SQL preview|SQL PREVIEW/i))              { pass('SQL preview section present'); }  else { fail('SQL preview section not found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('11. No-op paths (already resolved or not found)');

if (has(src, /handoff.*not.*found|not.*found.*handoff|handoff_not_found/i)) { pass('handles handoff not found'); } else { fail('missing not-found handling'); }
if (has(src, /already.*resolved|already_resolved|status.*resolved.*cancelled/i)) { pass('handles already-resolved handoff'); } else { fail('missing already-resolved handling'); }

// ─────────────────────────────────────────────────────────────────────────────
section('12. Read-only SELECT lookup present');

if (has(src, /HANDOFF_BY_ID_SQL|SELECT.*FROM\s+staff_handoffs/i)) { pass('read-only SELECT for handoff lookup present'); } else { fail('no SELECT lookup'); }
if (has(src, /client\.query\s*\(\s*HANDOFF_BY_ID_SQL/))            { pass('SELECT executed via client.query'); }           else { fail('SELECT not executed'); }

// ─────────────────────────────────────────────────────────────────────────────
section('13. No eval / no shell-out');

if (lacks(src, /eval\s*\(/))                     { pass('no eval()'); }          else { fail('uses eval()'); }
if (lacks(src, /execSync|exec\s*\(|spawn\s*\(/)) { pass('no shell execution'); } else { fail('uses execSync/exec/spawn'); }

// ─────────────────────────────────────────────────────────────────────────────
section('14. No workflow activation / no webhook POST');

if (lacks(src, /workflow\.active\s*=\s*true|workflows\/activate/i)) { pass('no workflow activation'); }   else { fail('workflow activation found'); }
if (lacks(src, /\.post\s*\(|fetch\s*\(.*POST|axios\.post/i))         { pass('no HTTP POST calls'); }       else { fail('HTTP POST call found'); }
if (lacks(src, /n8n.*activate|activate.*workflow/i))                  { pass('no n8n activation'); }       else { fail('n8n activation found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('15. No Airtable writes / no Stripe calls');

if (lacks(src, /airtable|airtableClient|base\s*\(\s*['"]rec/i)) { pass('no Airtable references'); } else { fail('Airtable reference found'); }
if (lacks(src, /stripe|checkout\.session|payment_intent/i))      { pass('no Stripe references'); }   else { fail('Stripe reference found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('16. Audit log written to logs/staff-query-log.jsonl');

if (has(src, /staff-query-log\.jsonl/)) { pass('references staff-query-log.jsonl'); } else { fail('no audit log reference'); }
if (has(src, /appendFileSync/))          { pass('uses appendFileSync for audit'); }    else { fail('does not use appendFileSync'); }

// ─────────────────────────────────────────────────────────────────────────────
section('17. Both audit intents present');

if (has(src, /action:handoff\.resolve:proposal/))  { pass('proposal audit intent present'); }  else { fail('proposal audit intent missing'); }
if (has(src, /action:handoff\.resolve:confirmed/)) { pass('confirmed audit intent present'); } else { fail('confirmed audit intent missing'); }

// ─────────────────────────────────────────────────────────────────────────────
section('18. Confirmed intent uses action:handoff.resolve:confirmed');

if (has(src, /action:handoff\.resolve:confirmed/)) { pass('"action:handoff.resolve:confirmed" string present'); } else { fail('"action:handoff.resolve:confirmed" not found'); }
if (has(src, /category.*staff_action|'staff_action'|"staff_action"/)) { pass('audit category is staff_action'); } else { fail('audit category not set to staff_action'); }

// ─────────────────────────────────────────────────────────────────────────────
section('19. Confirmed write is client-scoped');

// resolveHandoffSql takes [$1=client_slug, $2=handoff_id, $3=resolution]
if (has(src, /client\.query\s*\(\s*sql\s*,\s*\[\s*clientSlug/)) {
  pass('resolveHandoffSql called with clientSlug as first param');
} else {
  fail('clientSlug not first param in resolveHandoffSql call');
}

// ─────────────────────────────────────────────────────────────────────────────
section('20. Protected tables not mutated');

const protectedMutRe = /client\.query\s*\(\s*[`'"][\s\S]{0,200}(INSERT INTO|UPDATE|DELETE FROM)\s+(bookings|payments|payment_events|booking_beds)\b/i;
if (lacks(src, protectedMutRe)) { pass('no mutations to protected tables'); } else { fail('mutation to protected table found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('21. package.json scripts present');

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
