'use strict';
/**
 * Stage 7.3e — Staff login page static verifier (NO DB connection).
 *
 * Reads scripts/staff-query-api.js and verifies the login page implementation:
 *   0.  File exists and passes node --check.
 *   1.  GET /staff/login route present.
 *   2.  buildLoginHtml function present.
 *   3.  handleLoginPage function present.
 *   4.  Login page contains Luna Front Desk branding.
 *   5.  Form includes client field.
 *   6.  Form includes email field.
 *   7.  Form includes password field.
 *   8.  JavaScript posts to /staff/auth/login.
 *   9.  credentials: 'include' present in fetch call.
 *  10.  Success redirects to /staff/ui.
 *  11.  Failure message area present (msg element).
 *  12.  No password logged to console.
 *  13.  No external CDN (no src="http).
 *  14.  No OAuth references.
 *  15.  No live WhatsApp/Stripe references in login page.
 *  16.  No STAFF_ACTIONS_ENABLED=true in login page.
 *  17.  Existing /staff/ui route still present.
 *  18.  Existing /staff/auth/login route still present.
 *  19.  Existing /staff/auth/logout route still present.
 *  20.  browserLoginRedirect helper present.
 *  21.  browserLoginRedirect called for /staff/ui route.
 *  22.  Logout button present in UI (doLogout).
 *  23.  Logout JS calls POST /staff/auth/logout.
 *  24.  Staging / shadow mode badge removed from login page.
 *  25.  Staff actions disabled badge removed from login page.
 *  26.  STAFF_AUTH_REQUIRED gate in browserLoginRedirect.
 *  27.  Login page has no eval / no execSync.
 *  28.  Login page is self-contained (no external scripts).
 *  29.  Password field type is password.
 *  30.  Existing requireAuth still applied near /staff/ui.
 *
 * Usage:
 *   node scripts/verify-staff-login-ui.js
 *
 * Exit 0 = all checks pass. Exit 1 = at least one failure.
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');

let failures = 0;
function ok(label)           { console.log(`  ✓ ${label}`); }
function fail(label, detail) { console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`); failures++; }
function check(cond, pass, fail2, detail) {
  if (cond) ok(pass); else fail(fail2 || pass, detail);
}

// ── 0. File exists + syntax ──────────────────────────────────────────────────
console.log('\n── 0. File exists + syntax ──');
check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
let src;
try {
  src = fs.readFileSync(API_FILE, 'utf8');
  ok(`readable (${src.length} chars)`);
} catch (e) {
  fail('readable', e.message);
  process.exit(1);
}
try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'pipe' });
  ok('passes node --check (no syntax errors)');
} catch (e) {
  fail('passes node --check', e.stderr ? e.stderr.toString().trim() : 'syntax error');
}

// ── 1. GET /staff/login route ─────────────────────────────────────────────────
console.log('\n── 1. GET /staff/login route ──');
check(
  /pathname\s*===\s*['"]\/staff\/login['"]/i.test(src),
  "router handles '/staff/login'"
);

// ── 2. buildLoginHtml ────────────────────────────────────────────────────────
console.log('\n── 2. buildLoginHtml function ──');
check(/function buildLoginHtml/.test(src), 'buildLoginHtml function present');

// ── 3. handleLoginPage ───────────────────────────────────────────────────────
console.log('\n── 3. handleLoginPage function ──');
check(/function handleLoginPage/.test(src), 'handleLoginPage function present');

// Extract login HTML section for targeted checks
const loginFnStart = src.indexOf('function buildLoginHtml');
const loginFnEnd   = src.indexOf('\nfunction handleLoginPage', loginFnStart) +
                     src.slice(src.indexOf('\nfunction handleLoginPage', loginFnStart)).indexOf('\n}\n') + 3;
const loginSection = loginFnStart > -1 ? src.slice(loginFnStart, loginFnEnd) : '';

// ── 4. Luna Front Desk branding ──────────────────────────────────────────────
console.log('\n── 4. Luna Front Desk branding in login page ──');
check(/Luna Front Desk/.test(loginSection), 'login page contains "Luna Front Desk"');

// ── 5. client field ──────────────────────────────────────────────────────────
console.log('\n── 5. Client/Company field ──');
check(/id\s*=\s*['"]client['"]/.test(loginSection), 'client field id present');
check(/wolfhouse-somo/.test(loginSection), 'client field defaults to wolfhouse-somo');
check(/[Cc]ompany/.test(loginSection), 'login page label says Company (not Client)');

// ── 6. email field ───────────────────────────────────────────────────────────
console.log('\n── 6. Email field ──');
check(/id\s*=\s*['"]email['"]/.test(loginSection), 'email field present');
check(/type\s*=\s*['"]email['"]/.test(loginSection), 'email field type=email');

// ── 7. password field ────────────────────────────────────────────────────────
console.log('\n── 7. Password field ──');
check(/id\s*=\s*['"]password['"]/.test(loginSection), 'password field present');
check(/type\s*=\s*['"]password['"]/.test(loginSection), 'password field type=password');

// ── 8. JS posts to /staff/auth/login ─────────────────────────────────────────
console.log('\n── 8. JS posts to /staff/auth/login ──');
check(
  /\/staff\/auth\/login/.test(loginSection) &&
  (/open\s*\(\s*['"]POST['"]\s*,\s*['"]\/staff\/auth\/login['"]/i.test(loginSection) ||
   /fetch\s*\(\s*['"]\/staff\/auth\/login['"]/.test(loginSection)),
  "POST to /staff/auth/login in login page JS"
);
check(
  /open\s*\(\s*['"]POST['"]/i.test(loginSection) ||
  /method\s*:\s*['"]POST['"]/.test(loginSection),
  "POST method used in login form submission"
);

// ── 9. credentials: include or withCredentials ────────────────────────────────
console.log('\n── 9. credentials / withCredentials ──');
check(
  /credentials\s*:\s*['"]include['"]/.test(loginSection) ||
  /withCredentials\s*=\s*true/.test(loginSection),
  "credentials:include or withCredentials=true present"
);

// ── 10. Success redirect to /staff/ui ─────────────────────────────────────────
console.log('\n── 10. Success redirect to /staff/ui ──');
check(/\/staff\/ui/.test(loginSection), 'redirect to /staff/ui present on success');
check(/window\.location/.test(loginSection), 'window.location used for redirect');

// ── 11. Failure message area ─────────────────────────────────────────────────
console.log('\n── 11. Failure message area ──');
check(/id\s*=\s*['"]msg['"]/.test(loginSection), 'message element with id=msg present');
check(/showMsg\s*\(/.test(loginSection) || /error/.test(loginSection), 'error display logic present');

// ── 12. No password logged ───────────────────────────────────────────────────
console.log('\n── 12. No password logged to console ──');
check(!/console\.log.*password|console\.warn.*password/i.test(loginSection), 'no console.log(password) in login JS');

// ── 13. No external CDN ──────────────────────────────────────────────────────
console.log('\n── 13. No external CDN ──');
check(!/src\s*=\s*['"]https?:\/\//.test(loginSection), 'no external script src in login page');
check(!/href\s*=\s*['"]https?:\/\//.test(loginSection), 'no external stylesheet href in login page');

// ── 14. No OAuth ─────────────────────────────────────────────────────────────
console.log('\n── 14. No OAuth ──');
check(!/oauth|google-signin|microsoft\.com\/auth|auth0/i.test(loginSection), 'no OAuth references in login page');

// ── 15. No live WhatsApp/Stripe in login page ─────────────────────────────────
console.log('\n── 15. No live WhatsApp/Stripe refs in login page ──');
check(!/WHATSAPP_DRY_RUN\s*=\s*false|sk_live_/i.test(loginSection), 'no live WhatsApp/Stripe in login page');

// ── 16. No STAFF_ACTIONS_ENABLED=true in login page ──────────────────────────
console.log('\n── 16. No STAFF_ACTIONS_ENABLED=true in login page ──');
check(!/STAFF_ACTIONS_ENABLED\s*=\s*['"]?true/i.test(loginSection), 'no STAFF_ACTIONS_ENABLED=true in login page');

// ── 17. /staff/ui route still present ────────────────────────────────────────
console.log('\n── 17. /staff/ui route still present ──');
check(/pathname\s*===\s*['"]\/staff\/ui['"]/i.test(src), "'/staff/ui' route still present");

// ── 18. /staff/auth/login route still present ────────────────────────────────
console.log('\n── 18. /staff/auth/login route still present ──');
check(/pathname\s*===\s*['"]\/staff\/auth\/login['"]/i.test(src), "'/staff/auth/login' route still present");

// ── 19. /staff/auth/logout route still present ───────────────────────────────
console.log('\n── 19. /staff/auth/logout route still present ──');
check(/pathname\s*===\s*['"]\/staff\/auth\/logout['"]/i.test(src), "'/staff/auth/logout' route still present");

// ── 20. browserLoginRedirect helper ─────────────────────────────────────────
console.log('\n── 20. browserLoginRedirect helper ──');
check(/async function browserLoginRedirect/.test(src), 'browserLoginRedirect async function present');

// ── 21. browserLoginRedirect called for /staff/ui ────────────────────────────
console.log('\n── 21. browserLoginRedirect called near /staff/ui route ──');
check(
  /\/staff\/ui[\s\S]{1,400}browserLoginRedirect|browserLoginRedirect[\s\S]{1,400}\/staff\/ui/i.test(src),
  'browserLoginRedirect called near /staff/ui'
);

// ── 22. Logout button (doLogout) in UI ───────────────────────────────────────
console.log('\n── 22. Logout button in UI ──');
check(/btn-logout/.test(src),              'btn-logout class present in UI');
check(/doLogout/.test(src),                'doLogout function referenced in UI');
check(/window\.doLogout\s*=/.test(src),    'doLogout exposed on window (global scope for onclick)');

// ── 23. Logout JS calls POST /staff/auth/logout ──────────────────────────────
console.log('\n── 23. Logout JS posts to /staff/auth/logout ──');
check(
  /\/staff\/auth\/logout/.test(src) &&
  (/open\s*\(\s*['"]POST['"]\s*,\s*['"]\/staff\/auth\/logout['"]/i.test(src) ||
   /fetch\s*\(\s*['"]\/staff\/auth\/logout['"][\s\S]{1,200}method\s*:\s*['"]POST['"]/i.test(src) ||
   /method\s*:\s*['"]POST['"][\s\S]{1,200}\/staff\/auth\/logout/i.test(src)),
  "doLogout() uses POST to /staff/auth/logout"
);

// ── 24. Staging badge removed from login ─────────────────────────────────────
console.log('\n── 24. Staging / shadow mode badge removed ──');
check(!/[Ss]taging.*shadow|shadow.*[Ss]taging/i.test(loginSection), 'no staging/shadow mode badge on login page');

// ── 25. Staff actions disabled badge removed ─────────────────────────────────
console.log('\n── 25. Staff actions disabled badge removed ──');
check(!/[Ss]taff\s+actions\s+disabled/i.test(loginSection), 'no staff actions disabled badge on login page');

// ── 26. STAFF_AUTH_REQUIRED gate in browserLoginRedirect ─────────────────────
console.log('\n── 26. STAFF_AUTH_REQUIRED gate in browserLoginRedirect ──');
const redirectFn = src.slice(src.indexOf('async function browserLoginRedirect'));
check(
  /STAFF_AUTH_REQUIRED/.test(redirectFn.slice(0, 500)),
  'STAFF_AUTH_REQUIRED guard in browserLoginRedirect'
);

// ── 27. No eval/execSync in login page ───────────────────────────────────────
console.log('\n── 27. No eval / execSync in login page ──');
check(!/\beval\s*\(/.test(loginSection),       'no eval() in login page');
check(!/execSync|spawnSync/.test(loginSection), 'no execSync/spawnSync in login page');

// ── 28. Self-contained (no external scripts) ──────────────────────────────────
console.log('\n── 28. Login page is self-contained ──');
check(
  !/<script[^>]+src\s*=\s*['"]https?:\/\//i.test(loginSection),
  'no external script tags in login page'
);

// ── 29. Password field type ───────────────────────────────────────────────────
console.log('\n── 29. Password field type=password ──');
check(/type\s*=\s*['"]password['"]/.test(loginSection), "password input has type='password'");

// ── 30. requireAuth still applied near /staff/ui ─────────────────────────────
console.log('\n── 30. requireAuth still applied near /staff/ui ──');
check(
  /\/staff\/ui[\s\S]{1,400}requireAuth|requireAuth[\s\S]{1,400}\/staff\/ui/i.test(src),
  'requireAuth still referenced near /staff/ui'
);

// ── Result ───────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
if (failures === 0) {
  console.log('Result: PASS — all checks green (0 failures)');
  process.exit(0);
} else {
  console.error(`Result: FAIL — ${failures} check(s) failed`);
  process.exit(1);
}
