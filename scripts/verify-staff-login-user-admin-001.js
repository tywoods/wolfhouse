'use strict';

/**
 * STAFF-LOGIN-USER-ADMIN-001
 *
 * Login label EMAIL → User / Usuario.
 * Company Sunset + user Admin match case-insensitively.
 * Seed/create supports Admin without overwriting another email.
 *
 * Run: node scripts/verify-staff-login-user-admin-001.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLIENTS = require('./lib/staff-portal-clients');
const { buildStaffLoginHtml } = require('./lib/staff-portal-login-page');

const API_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
const LOGIN_PAGE_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staff-portal-login-page.js'), 'utf8');
const I18N_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js'), 'utf8');
const I18N_ES_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es.js'), 'utf8');
const SEED_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'sunset-staging-staff-user.js'), 'utf8');
const SUNSET_ACL = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'config', 'clients', 'staff-portal-access.sunset-staging.json'),
  'utf8',
));

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail ? `— ${detail}` : '');
  }
}

function extractHandleLogin() {
  const start = API_SRC.indexOf('async function handleLogin(req, res)');
  if (start < 0) return '';
  const rest = API_SRC.slice(start);
  const end = rest.search(/\nasync function handleLogout/);
  return end > 0 ? rest.slice(0, end) : rest.slice(0, 12000);
}

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const prev = {};
  for (const key of keys) {
    prev[key] = process.env[key];
    if (overrides[key] == null) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (prev[key] == null) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

const html = buildStaffLoginHtml('sunset', ['es', 'en'], '<button data-lang="es">ES</button>');
const handleLogin = extractHandleLogin();
const ADMIN_USER = { email: 'Admin', client_slug: 'sunset', role: 'owner' };
const OWNER = { email: 'tywoods@gmail.com', client_slug: 'sunset', role: 'owner' };

console.log('verify:staff-login-user-admin-001\n');

console.log('[1] Login chrome: User / Usuario, not Email');
ok('fallback label is User', /data-i18n="login.email">User</.test(html));
ok('EN login.email is User', /'login.email': 'User'/.test(I18N_SRC));
ok('ES login.email is Usuario', /"login.email": "Usuario"/.test(I18N_ES_SRC));
ok('user field is type=text', /id="email"[^>]*type="text"/.test(html));
ok('user field is not type=email', !/id="email"[^>]*type="email"/.test(html));
ok('no staff@example.com placeholder', !html.includes('staff@example.com') && !LOGIN_PAGE_SRC.includes('staff@example.com'));
ok('keeps id=email for POST back-compat', html.includes('id="email"') && LOGIN_PAGE_SRC.includes("getElementById('email')"));

console.log('\n[2] handleLogin matches Sunset + Admin case-insensitively');
ok('company slug compared with lower()', /lower\(c\.slug\)\s*=\s*lower\(\$1\)/.test(handleLogin));
ok('user identifier compared with lower(email)', /lower\(su\.email\)\s*=\s*\$2/.test(handleLogin));
ok('accepts body.user or body.username or body.email',
  /body\.user\s*\|\|\s*body\.username\s*\|\|\s*body\.email/.test(handleLogin));
ok('login identifier is lowercased', /toLowerCase\(\)\.trim\(\)/.test(handleLogin));

console.log('\n[3] ACL + mint: Admin on Sunset, typed Sunset');
ok('sunset ACL grants admin',
  Array.isArray(SUNSET_ACL.client_access.admin)
    && SUNSET_ACL.client_access.admin.length === 1
    && SUNSET_ACL.client_access.admin[0] === 'sunset');
ok('sunset ACL still grants owner email',
  Array.isArray(SUNSET_ACL.client_access['tywoods@gmail.com'])
    && SUNSET_ACL.client_access['tywoods@gmail.com'][0] === 'sunset');
ok('sunset ACL never grants wolfhouse-somo',
  !Object.values(SUNSET_ACL.client_access || {})
    .some((slugs) => (Array.isArray(slugs) ? slugs : []).includes('wolfhouse-somo')));

withEnv({ DEFAULT_CLIENT_SLUG: 'sunset', LUNA_DEPLOYMENT: undefined }, () => {
  ok('Admin can mint sunset session', CLIENTS.canMintStaffPortalSession(ADMIN_USER, 'sunset') === true);
  ok('typed Sunset still mints for Admin', CLIENTS.canMintStaffPortalSession(ADMIN_USER, 'Sunset') === true);
  ok('typed SUNSET still mints for Admin', CLIENTS.canMintStaffPortalSession(ADMIN_USER, 'SUNSET') === true);
  ok('typed Admin email case still mints',
    CLIENTS.canMintStaffPortalSession({ email: 'ADMIN', client_slug: 'sunset', role: 'owner' }, 'Sunset') === true);
  ok('owner email still mints', CLIENTS.canMintStaffPortalSession(OWNER, 'sunset') === true);
  ok('Admin cannot mint wolfhouse', CLIENTS.canMintStaffPortalSession(ADMIN_USER, 'wolfhouse-somo') === false);
});

console.log('\n[4] Seed supports Admin without email overwrite or password provision');
ok('seed accepts SUNSET_STAFF_USER', SEED_SRC.includes('SUNSET_STAFF_USER'));
ok('seed no longer requires @', !SEED_SRC.includes("email.includes('@')"));
ok('seed lowercases identifier', SEED_SRC.includes('normalizeStaffLogin'));
ok('seed update does not SET email', (() => {
  const start = SEED_SRC.indexOf('UPDATE staff_users');
  const end = SEED_SRC.indexOf('INSERT INTO staff_users', start);
  const block = start >= 0 && end > start ? SEED_SRC.slice(start, end) : '';
  return /SET password_hash/.test(block) && !/\bemail\s*=/.test(block);
})());
ok('seed does not hardcode Skipper password', !SEED_SRC.includes('SunsetLuna2026'));
ok('repo does not store Admin password', !API_SRC.includes('SunsetLuna2026') && !LOGIN_PAGE_SRC.includes('SunsetLuna2026'));

console.log('\n────────────────────────────────────────────────');
if (fail === 0) {
  console.log(`Results: ${pass} passed, ${fail} failed`);
  console.log('verify:staff-login-user-admin-001 — ALL CHECKS PASSED\n');
  process.exit(0);
}

console.error(`Results: ${pass} passed, ${fail} failed`);
console.error('verify:staff-login-user-admin-001 — FAILED\n');
process.exit(1);
