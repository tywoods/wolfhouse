/**
 * Stage 6.6 — Static verifier for staff-query-api.js.
 *
 * Reads the API source as text and checks structural/safety patterns.
 * Does NOT start the server. Does NOT connect to any DB.
 *
 * Checks:
 *   1.  API file exists and passes node --check
 *   2.  /staff/query route present
 *   3.  /staff/intents route present
 *   4.  staff-query-registry imported and getEntry / REGISTRY used
 *   5.  Unknown intent rejected (400)
 *   6.  Missing required param rejected (400)
 *   7.  No arbitrary SQL parameter (no client.query with raw user input)
 *   8.  No POST/PUT/PATCH/DELETE write routes
 *   9.  Only GET is accepted (405 for other methods)
 *   10. No staff-action-runner import
 *   11. No unguarded UPDATE/INSERT/DELETE in client.query
 *   12. No eval / no shell-out
 *   13. No workflow activation / no webhook POST
 *   14. No Airtable writes / no Stripe calls
 *   15. Audit log written to logs/staff-query-log.jsonl
 *   16. Audit intent uses api:<intent> prefix
 *   17. SQL from helperRef() only (no template-literal SQL)
 *   18. package.json scripts present
 *
 * Exit code: 0 on PASS, 1 on FAIL.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_PATH = path.join(__dirname, 'staff-query-api.js');
const PKG_PATH = path.join(__dirname, '..', 'package.json');

let passes   = 0;
let failures = 0;

function pass(msg) { console.log(`  ✓ ${msg}`); passes++; }
function fail(msg) { console.error(`  ✗ ${msg}`); failures++; }
function section(title) { console.log(`\n── ${title} ──`); }

function has(src, re)   { return re.test(src); }
function lacks(src, re) { return !re.test(src); }

// ─────────────────────────────────────────────────────────────────────────────
section('1. File exists and valid syntax');

if (!fs.existsSync(API_PATH)) {
  fail('staff-query-api.js does not exist');
  process.exit(1);
}
pass('staff-query-api.js exists');

let src = '';
try {
  src = fs.readFileSync(API_PATH, 'utf8');
  pass(`file readable (${src.length} chars)`);
} catch (e) {
  fail(`cannot read: ${e.message}`); process.exit(1);
}

try {
  execSync(`node --check "${API_PATH}"`, { stdio: 'pipe' });
  pass('passes node --check (no syntax errors)');
} catch (e) {
  fail(`syntax error: ${e.stderr ? e.stderr.toString().trim() : e.message}`); process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
section('2. /staff/query route present');

if (has(src, /\/staff\/query/)) { pass('/staff/query route present'); } else { fail('/staff/query route missing'); }
if (has(src, /handleQuery/))    { pass('handleQuery handler present'); } else { fail('handleQuery handler missing'); }

// ─────────────────────────────────────────────────────────────────────────────
section('3. /staff/intents route present');

if (has(src, /\/staff\/intents/)) { pass('/staff/intents route present'); } else { fail('/staff/intents route missing'); }
if (has(src, /handleIntents/))    { pass('handleIntents handler present'); } else { fail('handleIntents handler missing'); }

// ─────────────────────────────────────────────────────────────────────────────
section('4. Registry imported and used');

if (has(src, /require.*staff-query-registry/))   { pass('requires staff-query-registry'); }    else { fail('does not require staff-query-registry'); }
if (has(src, /getEntry\s*\(/))                    { pass('uses getEntry() for lookup'); }       else { fail('getEntry() not used'); }
if (has(src, /REGISTRY/))                         { pass('REGISTRY imported/used'); }           else { fail('REGISTRY not referenced'); }

// ─────────────────────────────────────────────────────────────────────────────
section('5. Unknown intent rejected with 400');

if (has(src, /unknown intent|getEntry\s*\([\s\S]{0,100}if\s*\(\s*!entry|!entry\s*\)/i)) {
  pass('unknown intent check present');
} else if (has(src, /send400.*unknown intent|!entry/)) {
  pass('unknown intent check present (send400)');
} else {
  fail('unknown intent rejection not found');
}
if (has(src, /send400\s*\([\s\S]{0,200}unknown intent/i) || has(src, /!entry[\s\S]{0,100}send400/)) {
  pass('unknown intent returns 400');
} else {
  fail('unknown intent 400 response not found');
}

// ─────────────────────────────────────────────────────────────────────────────
section('6. Missing required param rejected with 400');

if (has(src, /missing.{0,30}required|missing\.length/i)) { pass('missing param check present'); } else { fail('missing param check not found'); }
if (has(src, /send400[\s\S]{0,100}missing/i))             { pass('missing param returns 400'); }   else { fail('missing param 400 not found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('7. No arbitrary SQL from query params');

// client.query must only receive sql from helperRef(), not from query params directly
if (lacks(src, /client\.query\s*\(\s*query\./))         { pass('no client.query(query.xxx) — no raw param SQL'); } else { fail('client.query called with raw query param'); }
if (lacks(src, /client\.query\s*\(\s*req\./))           { pass('no client.query(req.xxx)'); }                      else { fail('client.query called with raw request data'); }

// ─────────────────────────────────────────────────────────────────────────────
section('8. No general POST/PUT/PATCH/DELETE query routes (write endpoint is separate)');

// The API now has one intentional POST route (POST /staff/handoff/:id/resolve)
// covered and verified by verify-staff-write-api.js.
// Check there are no Express-style general POST route handlers.
if (lacks(src, /app\.post\s*\(|router\.post\s*\(/i))  { pass('no Express app.post/router.post routes'); } else { fail('Express-style post route found'); }
if (lacks(src, /app\.put|app\.patch|app\.delete/i))    { pass('no PUT/PATCH/DELETE routes'); }              else { fail('PUT/PATCH/DELETE route found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('9. Only GET accepted (405 for others)');

if (has(src, /send405|405|Method not allowed/i)) { pass('405 response for non-GET present'); } else { fail('405 response not found'); }
if (has(src, /method.*GET|GET.*method/i))         { pass('GET method check present'); }         else { fail('GET method check not found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('10. No staff-action-runner import');

if (lacks(src, /require\s*\(\s*['"][./]*staff-action-runner/)) { pass('no staff-action-runner import'); } else { fail('staff-action-runner is imported'); }

// ─────────────────────────────────────────────────────────────────────────────
section('11. No unguarded UPDATE/INSERT/DELETE in handleQuery handler');

// Stage 7.2c adds auth routes (handleLogin, handleLogout, loadAuthSession) that
// legitimately write to auth_sessions / staff_users. Checks are now scoped to
// the handleQuery function body only (read-only query handler must not write).
const queryFnMatch = src.match(/async function handleQuery[\s\S]{0,12000}?(?=\n\/\/ ─────|^\/\/ ─────)/m);
const queryFnSrc = queryFnMatch ? queryFnMatch[0] : src;
if (lacks(queryFnSrc, /client\.query\s*\(\s*[`'"][\s\S]*?UPDATE\b/i)) { pass('no UPDATE in handleQuery'); }  else { fail('UPDATE in handleQuery found'); }
if (lacks(queryFnSrc, /client\.query\s*\(\s*[`'"][\s\S]*?INSERT\b/i)) { pass('no INSERT in handleQuery'); }  else { fail('INSERT in handleQuery found'); }
if (lacks(queryFnSrc, /client\.query\s*\(\s*[`'"][\s\S]*?DELETE\b/i)) { pass('no DELETE in handleQuery'); }  else { fail('DELETE in handleQuery found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('12. No eval / no shell-out');

if (lacks(src, /\beval\s*\(/))                          { pass('no eval()'); }           else { fail('eval() found'); }
if (lacks(src, /\bexecSync\s*\(|\bspawn\s*\(/))         { pass('no execSync/spawn'); }   else { fail('execSync or spawn found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('13. No workflow activation / no external POST');

if (lacks(src, /workflow\.active\s*=\s*true|workflows\/activate/i)) { pass('no workflow activation'); }          else { fail('workflow activation found'); }
if (lacks(src, /n8n.*activate|activate.*workflow/i))                  { pass('no n8n activation refs'); }         else { fail('n8n activation found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('14. No Airtable / no Stripe (require/instantiation only)');

// Check for actual require/instantiation — not comment mentions
if (lacks(src, /require\s*\(\s*['"]airtable['"]/i))         { pass('no Airtable require'); }         else { fail('Airtable is required'); }
if (lacks(src, /require\s*\(\s*['"]stripe['"]/i))            { pass('no Stripe require'); }           else { fail('Stripe is required'); }
if (lacks(src, /new\s+Stripe\s*\(|stripe\.checkout/i))       { pass('no Stripe instantiation'); }    else { fail('Stripe instantiation found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('15. Audit log written to logs/staff-query-log.jsonl');

if (has(src, /staff-query-log\.jsonl/)) { pass('references staff-query-log.jsonl'); } else { fail('no audit log reference'); }
if (has(src, /appendFileSync/))          { pass('uses appendFileSync for audit'); }    else { fail('does not use appendFileSync'); }

// ─────────────────────────────────────────────────────────────────────────────
section('16. Audit intent uses api:<intent> prefix');

if (has(src, /`api:\$\{intentKey\}`|'api:' \+ intent|api:\$\{/)) {
  pass('audit intent prefixed with api:');
} else {
  fail('audit intent does not use api: prefix');
}
if (has(src, /category.*staff_api|'staff_api'|"staff_api"/)) { pass('audit category is staff_api'); } else { fail('audit category not staff_api'); }

// ─────────────────────────────────────────────────────────────────────────────
section('17. SQL from helperRef() only');

section('17. SQL from helperRef() only (in query handler)');

if (has(src, /helperRef\s*\(\s*\)/))                         { pass('SQL from entry.helperRef()'); }        else { fail('helperRef() call not found'); }
// Check only the handleQuery section — the write handler may have a lookup SELECT (legitimate, parameterized)
const queryHandlerStart = src.indexOf('async function handleQuery');
const queryHandlerEnd   = src.indexOf('\nasync function handleResolveHandoff');
const queryHandlerSrc   = (queryHandlerStart >= 0 && queryHandlerEnd > queryHandlerStart)
  ? src.slice(queryHandlerStart, queryHandlerEnd)
  : (queryHandlerStart >= 0 ? src.slice(queryHandlerStart, queryHandlerStart + 2000) : '');
if (lacks(queryHandlerSrc, /client\.query\s*\(\s*`[^`]*SELECT\b/i)) { pass('no embedded SELECT in query handler'); } else { fail('embedded SELECT in query handler template literal'); }

// ─────────────────────────────────────────────────────────────────────────────
section('18. package.json scripts present');

try {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const s = pkg.scripts || {};
  if (s['staff:api'])             { pass('package.json has "staff:api"'); }             else { fail('package.json missing "staff:api"'); }
  if (s['verify:staff-query-api'])  { pass('package.json has "verify:staff-query-api"'); } else { fail('package.json missing "verify:staff-query-api"'); }
} catch (e) {
  fail(`cannot read package.json: ${e.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
const result = failures === 0 ? 'PASS' : 'FAIL';
console.log(`Result: ${result} — ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
