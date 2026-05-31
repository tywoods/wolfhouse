'use strict';
/**
 * Stage 7.2c — Staff auth middleware static verifier (NO DB connection).
 *
 * Reads scripts/staff-query-api.js and verifies:
 *   0.  File exists and passes node --check.
 *   1.  crypto require present.
 *   2.  Auth config constants present (STAFF_AUTH_REQUIRED, COOKIE_NAME, SESSION_TTL_HOURS, STAFF_AUTH_HTTPS).
 *   3.  Cookie parsing helper present.
 *   4.  Session token hash helper present (hashToken).
 *   5.  Session token generator present (generateSessionToken).
 *   6.  HttpOnly cookie setter present (setSessionCookie).
 *   7.  Cookie clear on logout present (clearSessionCookie).
 *   8.  Session loader present (loadAuthSession) with auth_sessions + staff_users JOIN.
 *   9.  role CHECK: viewer / operator / admin in role hierarchy (ROLE_RANK).
 *  10.  requireAuth middleware present with STAFF_AUTH_REQUIRED bypass.
 *  11.  Login route present (handleLogin / /staff/auth/login).
 *  12.  Logout route present (handleLogout / /staff/auth/logout).
 *  13.  HttpOnly present in cookie setter.
 *  14.  SameSite=Lax present in cookie setter.
 *  15.  Session revocation present in logout (UPDATE auth_sessions SET revoked_at).
 *  16.  STAFF_AUTH_REQUIRED gate present in requireAuth.
 *  17.  Role check: handoff.resolve requires operator/admin when STAFF_AUTH_REQUIRED=true.
 *  18.  No plain-text token stored in DB (hashToken used before INSERT).
 *  19.  No real password / secret seeded.
 *  20.  No eval / no execSync / no shell-out.
 *  21.  No workflow activation / no n8n webhook logic.
 *  22.  Existing STAFF_ACTIONS_ENABLED gate still present.
 *  23.  Existing STAFF_OPERATOR_TOKEN token gate still present (backward compat).
 *  24.  timingSafeEqual present (constant-time password comparison).
 *  25.  scrypt password verifier present (verifyPassword).
 *  26.  Router has /staff/auth/login route.
 *  27.  Router has /staff/auth/logout route.
 *  28.  requireAuth called for /staff/query route.
 *  29.  requireAuth called for /staff/ui route.
 *  30.  requireAuth called for /staff/intents route.
 *
 * Usage:
 *   node scripts/verify-staff-auth-api.js
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

// ── 1. crypto require ────────────────────────────────────────────────────────
console.log('\n── 1. crypto require ──');
check(/require\s*\(\s*['"]crypto['"]\s*\)/.test(src), "require('crypto') present");

// ── 2. Auth config constants ─────────────────────────────────────────────────
console.log('\n── 2. Auth config constants ──');
check(/STAFF_AUTH_REQUIRED/.test(src),  'STAFF_AUTH_REQUIRED defined');
check(/COOKIE_NAME/.test(src),          'COOKIE_NAME defined');
check(/SESSION_TTL_HOURS/.test(src),    'SESSION_TTL_HOURS defined');
check(/STAFF_AUTH_HTTPS/.test(src),     'STAFF_AUTH_HTTPS defined');
check(/luna_staff_session/.test(src),   'default cookie name luna_staff_session');

// ── 3. Cookie parsing ────────────────────────────────────────────────────────
console.log('\n── 3. Cookie parsing ──');
check(/parseCookies/.test(src),                       'parseCookies function present');
check(/req\.headers\.cookie/.test(src),               'reads req.headers.cookie');
check(/split\s*\(\s*['"]\s*;\s*['"]\s*\)/.test(src), 'splits on semicolon');

// ── 4. hashToken ─────────────────────────────────────────────────────────────
console.log('\n── 4. hashToken (session token hash) ──');
check(/function hashToken/.test(src),        'hashToken function present');
check(/createHash\s*\(\s*['"]sha256/.test(src), "uses SHA-256 for token hashing");

// ── 5. generateSessionToken ──────────────────────────────────────────────────
console.log('\n── 5. generateSessionToken ──');
check(/function generateSessionToken/.test(src), 'generateSessionToken function present');
check(/randomBytes\s*\(\s*32\s*\)/.test(src),   'generates 32 bytes of randomness');

// ── 6. setSessionCookie ──────────────────────────────────────────────────────
console.log('\n── 6. setSessionCookie ──');
check(/function setSessionCookie/.test(src),    'setSessionCookie function present');
check(/Set-Cookie/.test(src),                   'Set-Cookie header set');

// ── 7. clearSessionCookie ────────────────────────────────────────────────────
console.log('\n── 7. clearSessionCookie ──');
check(/function clearSessionCookie/.test(src),  'clearSessionCookie function present');
check(/Max-Age=0/.test(src),                    'Max-Age=0 on clear');

// ── 8. loadAuthSession ───────────────────────────────────────────────────────
console.log('\n── 8. loadAuthSession (DB lookup) ──');
check(/async function loadAuthSession/.test(src),          'loadAuthSession async function present');
check(/FROM auth_sessions/.test(src),                      'queries auth_sessions table');
check(/JOIN staff_users/.test(src),                        'joins staff_users table');
check(/revoked_at IS NULL/.test(src),                      'filters revoked_at IS NULL');
check(/expires_at > NOW\(\)/.test(src),                    'filters expires_at > NOW()');
check(/su\.status\s*=\s*['"']active['"']/i.test(src),     "filters status = 'active'");
check(/session_token_hash/.test(src),                      'matches on session_token_hash');

// ── 9. Role hierarchy ────────────────────────────────────────────────────────
console.log('\n── 9. Role hierarchy (ROLE_RANK) ──');
check(/ROLE_RANK/.test(src),                    'ROLE_RANK object defined');
check(/['"]?viewer['"]?\s*:\s*1/.test(src),    "viewer: 1 in ROLE_RANK");
check(/['"]?operator['"]?\s*:\s*2/.test(src),  "operator: 2 in ROLE_RANK");
check(/['"]?admin['"]?\s*:\s*3/.test(src),     "admin: 3 in ROLE_RANK");
check(/function hasRole/.test(src),            'hasRole function present');

// ── 10. requireAuth middleware ───────────────────────────────────────────────
console.log('\n── 10. requireAuth middleware ──');
check(/async function requireAuth/.test(src),            'requireAuth async function present');
check(/if\s*\(\s*!\s*STAFF_AUTH_REQUIRED\s*\)/.test(src), 'STAFF_AUTH_REQUIRED bypass present');
check(/sendJSON\s*\(\s*res\s*,\s*401/.test(src),         '401 returned when not authenticated');
check(/sendJSON\s*\(\s*res\s*,\s*403/.test(src),         '403 returned when wrong role');

// ── 11. Login route ──────────────────────────────────────────────────────────
console.log('\n── 11. Login route ──');
check(/async function handleLogin/.test(src),              'handleLogin async function present');
check(/\/staff\/auth\/login/.test(src),                    '/staff/auth/login route present');
check(/client.*email.*password/.test(src),                 'client + email + password required');
check(/lower\s*\(\s*su\.email\s*\)/.test(src),            'case-insensitive email lookup');

// ── 12. Logout route ─────────────────────────────────────────────────────────
console.log('\n── 12. Logout route ──');
check(/async function handleLogout/.test(src),             'handleLogout async function present');
check(/\/staff\/auth\/logout/.test(src),                   '/staff/auth/logout route present');

// ── 13. HttpOnly cookie ──────────────────────────────────────────────────────
console.log('\n── 13. HttpOnly cookie ──');
check(/HttpOnly/.test(src), "HttpOnly set in cookie");

// ── 14. SameSite=Lax ────────────────────────────────────────────────────────
console.log('\n── 14. SameSite=Lax ──');
check(/SameSite=Lax/.test(src), "SameSite=Lax set in cookie");

// ── 15. Session revocation ───────────────────────────────────────────────────
console.log('\n── 15. Session revocation (logout) ──');
check(
  /UPDATE auth_sessions SET revoked_at/.test(src),
  'UPDATE auth_sessions SET revoked_at on logout'
);

// ── 16. STAFF_AUTH_REQUIRED gate ────────────────────────────────────────────
console.log('\n── 16. STAFF_AUTH_REQUIRED gate ──');
check(/STAFF_AUTH_REQUIRED/.test(src), 'STAFF_AUTH_REQUIRED referenced');
check(
  /if\s*\(\s*STAFF_AUTH_REQUIRED\s*\)/.test(src),
  'if (STAFF_AUTH_REQUIRED) branch present'
);

// ── 17. handoff.resolve role check ──────────────────────────────────────────
console.log('\n── 17. handoff.resolve requires operator/admin when auth on ──');
check(
  /hasRole\s*\(\s*sessionUser\.role\s*,\s*['"]operator['"]\s*\)/.test(src),
  "hasRole check for 'operator' on handoff.resolve"
);
check(
  /insufficient_role/.test(src),
  'insufficient_role audit label present for role failure'
);

// ── 18. No plain-text token in DB ────────────────────────────────────────────
console.log('\n── 18. No plain-text token stored in DB ──');
check(
  /session_token_hash[\s\S]{1,400}hashToken/i.test(src) ||
  /hashToken[\s\S]{1,400}session_token_hash/i.test(src),
  'hashToken called before INSERT into session_token_hash'
);

// ── 19. No real secrets seeded ───────────────────────────────────────────────
console.log('\n── 19. No real secrets / no seed rows ──');
check(!/INSERT INTO staff_users/.test(src), 'no INSERT INTO staff_users in API file');
check(!/password\s*=\s*['"'][^'"]{4,}['"']/.test(src), 'no plain-text password literal');

// ── 20. No eval / no shell-out ───────────────────────────────────────────────
console.log('\n── 20. No eval / no shell-out ──');
check(!/\beval\s*\(/.test(src),      'no eval()');
check(!/execSync|spawnSync/.test(src), 'no execSync/spawnSync');

// ── 21. No workflow activation ───────────────────────────────────────────────
console.log('\n── 21. No workflow activation ──');
check(!/activate.*workflow|workflow.*activate/i.test(src), 'no workflow activation');

// ── 22. STAFF_ACTIONS_ENABLED still present ──────────────────────────────────
console.log('\n── 22. STAFF_ACTIONS_ENABLED gate still present ──');
check(/STAFF_ACTIONS_ENABLED/.test(src), 'STAFF_ACTIONS_ENABLED still referenced');

// ── 23. STAFF_OPERATOR_TOKEN still present ───────────────────────────────────
console.log('\n── 23. STAFF_OPERATOR_TOKEN still present (backward compat) ──');
check(/STAFF_OPERATOR_TOKEN/.test(src),        'STAFF_OPERATOR_TOKEN referenced');
check(/x-staff-operator-token/.test(src),      'x-staff-operator-token header check present');

// ── 24. timingSafeEqual ──────────────────────────────────────────────────────
console.log('\n── 24. timingSafeEqual (constant-time comparison) ──');
check(/timingSafeEqual/.test(src), 'crypto.timingSafeEqual used for password comparison');

// ── 25. scrypt verifyPassword ────────────────────────────────────────────────
console.log('\n── 25. verifyPassword (scrypt) ──');
check(/function verifyPassword/.test(src),   'verifyPassword function present');
check(/scryptSync/.test(src),                'scryptSync used for verification');

// ── 26. Router: /staff/auth/login ────────────────────────────────────────────
console.log('\n── 26. Router: /staff/auth/login route ──');
check(
  /pathname\s*===\s*['"]\/staff\/auth\/login['"]/i.test(src),
  "router handles '/staff/auth/login'"
);

// ── 27. Router: /staff/auth/logout ───────────────────────────────────────────
console.log('\n── 27. Router: /staff/auth/logout route ──');
check(
  /pathname\s*===\s*['"]\/staff\/auth\/logout['"]/i.test(src),
  "router handles '/staff/auth/logout'"
);

// ── 28–30. requireAuth called for read routes ─────────────────────────────────
console.log('\n── 28-30. requireAuth called for read routes ──');
check(
  /requireAuth\s*\(\s*req\s*,\s*res/.test(src),
  'requireAuth called with (req, res, …)'
);
check(
  /\/staff\/query[\s\S]{1,300}requireAuth|requireAuth[\s\S]{1,300}\/staff\/query/i.test(src),
  'requireAuth applied near /staff/query route'
);
check(
  /\/staff\/ui[\s\S]{1,300}requireAuth|requireAuth[\s\S]{1,300}\/staff\/ui/i.test(src),
  'requireAuth applied near /staff/ui route'
);
check(
  /\/staff\/intents[\s\S]{1,300}requireAuth|requireAuth[\s\S]{1,300}\/staff\/intents/i.test(src),
  'requireAuth applied near /staff/intents route'
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
