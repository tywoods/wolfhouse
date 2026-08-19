'use strict';

/**
 * SUNSET-LOGIN-LOOP-001 — Sunset staging staff login must not bounce to /staff/login.
 *
 * Root cause at dc3cc110: login mints a DB session for any active staff_users row,
 * then GET /staff/auth/session + portal JS fail-close to /staff/login when the
 * runtime ACL file still grants wolfhouse-somo only. Sunset deploy
 * (DEFAULT_CLIENT_SLUG=sunset / LUNA_DEPLOYMENT=sunset-staging) must load the
 * Sunset overlay ACL; login must refuse to mint a session the session endpoint
 * would reject. Host headers cannot select the ACL file.
 *
 * Review BLOCK at 4e0bc288: Dockerfile.luna-sunset-staff-api copies the overlay
 * over staff-portal-access.json, so conflict fail-closed-to-filename still loaded
 * Sunset ACL. Conflicting / invalid trusted identity must deny directly.
 *
 * Run: node scripts/verify-sunset-login-loop-001.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLIENTS = require('./lib/staff-portal-clients');
const API_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
const CLIENTS_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staff-portal-clients.js'), 'utf8');
const LOGIN_PAGE_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staff-portal-login-page.js'), 'utf8');
const SUNSET_ACCESS = path.join(ROOT, 'config', 'clients', 'staff-portal-access.sunset-staging.json');
const WOLF_ACCESS = path.join(ROOT, 'config', 'clients', 'staff-portal-access.json');

const OWNER = 'tywoods@gmail.com';
const SUNSET_USER = { email: OWNER, client_slug: 'sunset', role: 'owner' };
const WOLF_USER = { email: OWNER, client_slug: 'wolfhouse-somo', role: 'owner' };
const UNLISTED = { email: 'unlisted.random.access@example.invalid', client_slug: 'sunset', role: 'operator' };

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

function extractHandleLogin() {
  const start = API_SRC.indexOf('async function handleLogin(req, res)');
  if (start < 0) return '';
  const rest = API_SRC.slice(start);
  const end = rest.search(/\nasync function handleLogout/);
  return end > 0 ? rest.slice(0, end) : rest.slice(0, 12000);
}

function withAccessLayout(mode, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunset-login-acl-'));
  try {
    fs.copyFileSync(WOLF_ACCESS, path.join(dir, 'staff-portal-access.json'));
    fs.copyFileSync(SUNSET_ACCESS, path.join(dir, 'staff-portal-access.sunset-staging.json'));
    if (mode === 'sunset-image') {
      // Exact Dockerfile.luna-sunset-staff-api copy.
      fs.copyFileSync(
        path.join(dir, 'staff-portal-access.sunset-staging.json'),
        path.join(dir, 'staff-portal-access.json'),
      );
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function layoutOpts(accessDir, env) {
  return { accessDir, env };
}

console.log('verify:sunset-login-loop-001 — Sunset staff login bounce regression\n');

console.log('[1] RED: Sunset deploy ACL must grant sunset, not wolfhouse');
withEnv({ DEFAULT_CLIENT_SLUG: 'sunset', LUNA_DEPLOYMENT: undefined }, () => {
  ok('DEFAULT_CLIENT_SLUG=sunset grants owner sunset',
    CLIENTS.userCanAccessClient(SUNSET_USER, 'sunset'));
  ok('DEFAULT_CLIENT_SLUG=sunset denies owner wolfhouse-somo',
    !CLIENTS.userCanAccessClient(SUNSET_USER, 'wolfhouse-somo'));
  ok('DEFAULT_CLIENT_SLUG=sunset session clients are sunset only',
    CLIENTS.getSessionScopedClients(SUNSET_USER).length === 1
      && CLIENTS.getSessionScopedClients(SUNSET_USER)[0].slug === 'sunset');
  ok('DEFAULT_CLIENT_SLUG=sunset can mint sunset portal session',
    typeof CLIENTS.canMintStaffPortalSession === 'function'
      && CLIENTS.canMintStaffPortalSession(SUNSET_USER, 'sunset') === true);
  ok('DEFAULT_CLIENT_SLUG=sunset cannot mint wolfhouse session',
    typeof CLIENTS.canMintStaffPortalSession === 'function'
      && CLIENTS.canMintStaffPortalSession(WOLF_USER, 'wolfhouse-somo') === false);
});

withEnv({ DEFAULT_CLIENT_SLUG: undefined, LUNA_DEPLOYMENT: 'sunset-staging' }, () => {
  ok('LUNA_DEPLOYMENT=sunset-staging grants owner sunset',
    CLIENTS.userCanAccessClient(SUNSET_USER, 'sunset'));
  ok('LUNA_DEPLOYMENT=sunset-staging denies owner wolfhouse-somo',
    !CLIENTS.userCanAccessClient(WOLF_USER, 'wolfhouse-somo'));
});

console.log('\n[2] Adjacent: Wolfhouse deploy isolation unchanged');
withEnv({ DEFAULT_CLIENT_SLUG: undefined, LUNA_DEPLOYMENT: undefined }, () => {
  ok('no sunset deploy env grants owner wolfhouse-somo',
    CLIENTS.userCanAccessClient(WOLF_USER, 'wolfhouse-somo'));
  ok('no sunset deploy env denies owner sunset',
    !CLIENTS.userCanAccessClient(SUNSET_USER, 'sunset'));
  ok('wolfhouse session clients are wolfhouse-somo only',
    CLIENTS.getSessionScopedClients(WOLF_USER).length === 1
      && CLIENTS.getSessionScopedClients(WOLF_USER)[0].slug === 'wolfhouse-somo');
});

withEnv({ DEFAULT_CLIENT_SLUG: 'wolfhouse-somo', LUNA_DEPLOYMENT: undefined }, () => {
  ok('DEFAULT_CLIENT_SLUG=wolfhouse-somo does not load sunset overlay',
    CLIENTS.userCanAccessClient(WOLF_USER, 'wolfhouse-somo')
      && !CLIENTS.userCanAccessClient(SUNSET_USER, 'sunset'));
});

console.log('\n[3] Adjacent: fail closed on conflict, spoof, unlisted');
withEnv({ DEFAULT_CLIENT_SLUG: 'wolfhouse-somo', LUNA_DEPLOYMENT: 'sunset-staging' }, () => {
  ok('conflicting deploy env does not grant sunset',
    !CLIENTS.userCanAccessClient(SUNSET_USER, 'sunset'));
});
withEnv({ DEFAULT_CLIENT_SLUG: 'sunset', LUNA_DEPLOYMENT: 'production' }, () => {
  ok('production + sunset slug conflict denies sunset',
    !CLIENTS.userCanAccessClient(SUNSET_USER, 'sunset')
      && !CLIENTS.canMintStaffPortalSession(SUNSET_USER, 'sunset'));
});
ok('sunset+production identity is deny, not a filename fallback', (() => {
  const d = CLIENTS.resolveTrustedStaffPortalAccessDecision({
    DEFAULT_CLIENT_SLUG: 'sunset',
    LUNA_DEPLOYMENT: 'production',
  });
  return d.action === 'deny'
    && d.reason === 'conflicting_trusted_identity'
    && CLIENTS.resolveStaffPortalAccessFile({
      DEFAULT_CLIENT_SLUG: 'sunset',
      LUNA_DEPLOYMENT: 'production',
    }) === null;
})());
ok('sunset-staging+wolfhouse-somo identity is deny',
  CLIENTS.resolveTrustedStaffPortalAccessDecision({
    DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
    LUNA_DEPLOYMENT: 'sunset-staging',
  }).action === 'deny');
ok('conflict deny does not fall back to ACCESS_FILE in source',
  CLIENTS_SRC.includes("reason: 'conflicting_trusted_identity'")
    && /decision\.action === 'deny'/.test(CLIENTS_SRC)
    && !/fail closed to the Wolfhouse base file/.test(CLIENTS_SRC));
withEnv({ DEFAULT_CLIENT_SLUG: 'sunset' }, () => {
  ok('unlisted email denied on sunset deploy',
    !CLIENTS.userCanAccessClient(UNLISTED, 'sunset')
      && !CLIENTS.canMintStaffPortalSession(UNLISTED, 'sunset'));
  const aclStart = CLIENTS_SRC.indexOf('function resolveTrustedStaffPortalAccessDecision');
  const aclEnd = CLIENTS_SRC.indexOf('const SURF_VERTICALS');
  const aclBlock = aclStart >= 0 && aclEnd > aclStart
    ? CLIENTS_SRC.slice(aclStart, aclEnd)
    : '';
  ok('ACL resolver ignores request Host',
    aclBlock.includes('shouldUseSunsetStagingAccess')
      && aclBlock.includes('resolveStaffPortalAccessFile')
      && !/\bhost\b/i.test(aclBlock));
});
ok('no STAFF_PORTAL_ACCESS_FILE env override',
  !CLIENTS_SRC.includes('STAFF_PORTAL_ACCESS_FILE'));
ok('sunset overlay file exists', fs.existsSync(SUNSET_ACCESS));
ok('wolfhouse access file exists', fs.existsSync(WOLF_ACCESS));

const sunsetAcl = JSON.parse(fs.readFileSync(SUNSET_ACCESS, 'utf8'));
const wolfAcl = JSON.parse(fs.readFileSync(WOLF_ACCESS, 'utf8'));
ok('sunset overlay all_clients_emails empty',
  Array.isArray(sunsetAcl.all_clients_emails) && sunsetAcl.all_clients_emails.length === 0);
ok('sunset overlay owner is sunset only',
  Array.isArray(sunsetAcl.client_access[OWNER])
    && sunsetAcl.client_access[OWNER].length === 1
    && sunsetAcl.client_access[OWNER][0] === 'sunset');
ok('wolfhouse file owner is wolfhouse-somo only',
  Array.isArray(wolfAcl.client_access[OWNER])
    && wolfAcl.client_access[OWNER].length === 1
    && wolfAcl.client_access[OWNER][0] === 'wolfhouse-somo');

console.log('\n[4] Login must not mint a session the session endpoint would reject');
ok('canMintStaffPortalSession is exported', typeof CLIENTS.canMintStaffPortalSession === 'function');
ok('mismatch login client cannot mint',
  typeof CLIENTS.canMintStaffPortalSession === 'function'
    && CLIENTS.canMintStaffPortalSession(SUNSET_USER, 'wolfhouse-somo') === false);
ok('empty slug cannot mint',
  typeof CLIENTS.canMintStaffPortalSession === 'function'
    && CLIENTS.canMintStaffPortalSession(SUNSET_USER, '') === false);

const handleLogin = extractHandleLogin();
ok('handleLogin exists', handleLogin.includes('async function handleLogin'));
ok('handleLogin gates mint with canMintStaffPortalSession',
  /canMintStaffPortalSession\s*\(/.test(handleLogin));
ok('portal ACL gate runs before auth_sessions INSERT', (() => {
  const gateAt = handleLogin.search(/canMintStaffPortalSession\s*\(/);
  const insertAt = handleLogin.indexOf('INSERT INTO auth_sessions');
  return gateAt >= 0 && insertAt >= 0 && gateAt < insertAt;
})());
ok('ACL deny returns Invalid credentials (no oracle)',
  /canMintStaffPortalSession[\s\S]{0,900}?Invalid credentials/.test(handleLogin));
ok('ACL deny does not leak portal_access in HTTP body',
  !/canMintStaffPortalSession[\s\S]{0,900}?sendJSON\([\s\S]{0,200}?portal_access/.test(handleLogin));
ok('handleAuthSession still fail-closes without portal access',
  /session_client_access_denied/.test(API_SRC)
    && /userCanAccessClient\(user, activeClient\)/.test(API_SRC));
ok('portal JS still fail-closes missing session to /staff/login',
  API_SRC.includes("window.location.replace('/staff/login')")
    && API_SRC.includes('Fail closed: never render a tenant portal'));

console.log('\n[5] Adjacent: staff password login surface unchanged; no Gmail OAuth mix-in');
ok('login page posts /staff/auth/login', LOGIN_PAGE_SRC.includes("xhr.open('POST', '/staff/auth/login'"));
ok('login success navigates to /staff/ui', LOGIN_PAGE_SRC.includes("window.location.href = '/staff/ui'"));
ok('login page is not a Google OAuth start',
  !LOGIN_PAGE_SRC.includes('/staff/email/google/callback')
    && !LOGIN_PAGE_SRC.includes('accounts.google.com'));
ok('session cookie still HttpOnly SameSite=Lax Path=/staff',
  /function setSessionCookie[\s\S]{0,400}?HttpOnly[\s\S]{0,120}?SameSite=Lax[\s\S]{0,120}?Path=\/staff/.test(API_SRC));
ok('browserLoginRedirect still sends 302 /staff/login when no session',
  /async function browserLoginRedirect[\s\S]{0,500}?Location: '\/staff\/login'/.test(API_SRC));

console.log('\n[6] RED/GREEN: Dockerfile-built ACL layout + production/conflict identity');
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile.luna-sunset-staff-api'), 'utf8');
ok('Sunset Dockerfile copies overlay over staff-portal-access.json',
  /cp\s+config\/clients\/staff-portal-access\.sunset-staging\.json\s+config\/clients\/staff-portal-access\.json/.test(dockerfile));
ok('Sunset Dockerfile bakes DEFAULT_CLIENT_SLUG=sunset',
  /ENV\s+DEFAULT_CLIENT_SLUG=sunset\b/.test(dockerfile));

withAccessLayout('sunset-image', (imageDir) => {
  const imageBase = JSON.parse(fs.readFileSync(path.join(imageDir, 'staff-portal-access.json'), 'utf8'));
  const imageOverlay = JSON.parse(fs.readFileSync(
    path.join(imageDir, 'staff-portal-access.sunset-staging.json'),
    'utf8',
  ));
  ok('image layout base file is Sunset ACL (Dockerfile copy)',
    Array.isArray(imageBase.client_access[OWNER])
      && imageBase.client_access[OWNER][0] === 'sunset'
      && Array.isArray(imageOverlay.client_access[OWNER])
      && imageOverlay.client_access[OWNER][0] === 'sunset');

  const img = (env) => layoutOpts(imageDir, env);

  ok('image layout valid sunset slug grants sunset',
    CLIENTS.userCanAccessClient(SUNSET_USER, 'sunset', img({ DEFAULT_CLIENT_SLUG: 'sunset' }))
      && CLIENTS.canMintStaffPortalSession(SUNSET_USER, 'sunset', img({ DEFAULT_CLIENT_SLUG: 'sunset' })));
  ok('image layout valid sunset+sunset-staging grants sunset',
    CLIENTS.userCanAccessClient(SUNSET_USER, 'sunset', img({
      DEFAULT_CLIENT_SLUG: 'sunset',
      LUNA_DEPLOYMENT: 'sunset-staging',
    })));
  ok('image layout valid sunset still denies wolfhouse-somo',
    !CLIENTS.userCanAccessClient(SUNSET_USER, 'wolfhouse-somo', img({ DEFAULT_CLIENT_SLUG: 'sunset' }))
      && !CLIENTS.canMintStaffPortalSession(WOLF_USER, 'wolfhouse-somo', img({
        DEFAULT_CLIENT_SLUG: 'sunset',
      })));
  ok('image layout sunset+production conflict denies sunset',
    !CLIENTS.userCanAccessClient(SUNSET_USER, 'sunset', img({
      DEFAULT_CLIENT_SLUG: 'sunset',
      LUNA_DEPLOYMENT: 'production',
    }))
      && !CLIENTS.canMintStaffPortalSession(SUNSET_USER, 'sunset', img({
        DEFAULT_CLIENT_SLUG: 'sunset',
        LUNA_DEPLOYMENT: 'production',
      })));
  ok('image layout sunset+production does not mint via fallback filename',
    CLIENTS.resolveStaffPortalAccessFile({
      DEFAULT_CLIENT_SLUG: 'sunset',
      LUNA_DEPLOYMENT: 'production',
    }, img({
      DEFAULT_CLIENT_SLUG: 'sunset',
      LUNA_DEPLOYMENT: 'production',
    })) === null);
  ok('image layout sunset-staging+wolfhouse-somo conflict denies both tenants',
    !CLIENTS.userCanAccessClient(SUNSET_USER, 'sunset', img({
      DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
      LUNA_DEPLOYMENT: 'sunset-staging',
    }))
      && !CLIENTS.userCanAccessClient(WOLF_USER, 'wolfhouse-somo', img({
        DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
        LUNA_DEPLOYMENT: 'sunset-staging',
      })));
  ok('image layout production-only identity is base, not overlay',
    CLIENTS.resolveTrustedStaffPortalAccessDecision({ LUNA_DEPLOYMENT: 'production' }).file === 'base'
      && CLIENTS.resolveTrustedStaffPortalAccessDecision({ LUNA_DEPLOYMENT: 'production' }).action === 'read');
  ok('image layout Production (case) + sunset slug is deny',
    CLIENTS.resolveTrustedStaffPortalAccessDecision({
      DEFAULT_CLIENT_SLUG: 'sunset',
      LUNA_DEPLOYMENT: 'Production',
    }).action === 'deny'
      && !CLIENTS.userCanAccessClient(SUNSET_USER, 'sunset', img({
        DEFAULT_CLIENT_SLUG: 'sunset',
        LUNA_DEPLOYMENT: 'Production',
      })));
  ok('image layout unlisted email denied on valid sunset identity',
    !CLIENTS.userCanAccessClient(UNLISTED, 'sunset', img({ DEFAULT_CLIENT_SLUG: 'sunset' })));
});

withAccessLayout('wolfhouse-source', (wolfDir) => {
  const wolfBase = JSON.parse(fs.readFileSync(path.join(wolfDir, 'staff-portal-access.json'), 'utf8'));
  ok('wolfhouse layout base file remains wolfhouse-somo ACL',
    Array.isArray(wolfBase.client_access[OWNER])
      && wolfBase.client_access[OWNER][0] === 'wolfhouse-somo');

  const wolf = (env) => layoutOpts(wolfDir, env);

  ok('wolfhouse layout unset grants wolfhouse-somo',
    CLIENTS.userCanAccessClient(WOLF_USER, 'wolfhouse-somo', wolf({}))
      && !CLIENTS.userCanAccessClient(SUNSET_USER, 'sunset', wolf({})));
  ok('wolfhouse layout DEFAULT_CLIENT_SLUG=wolfhouse-somo unchanged',
    CLIENTS.userCanAccessClient(WOLF_USER, 'wolfhouse-somo', wolf({
      DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
    }))
      && !CLIENTS.userCanAccessClient(SUNSET_USER, 'sunset', wolf({
        DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
      })));
  ok('wolfhouse layout production+wolfhouse-somo still grants wolfhouse',
    CLIENTS.userCanAccessClient(WOLF_USER, 'wolfhouse-somo', wolf({
      DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
      LUNA_DEPLOYMENT: 'production',
    }))
      && CLIENTS.canMintStaffPortalSession(WOLF_USER, 'wolfhouse-somo', wolf({
        DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
        LUNA_DEPLOYMENT: 'production',
      })));
  ok('wolfhouse layout production+sunset denies both tenants',
    !CLIENTS.userCanAccessClient(SUNSET_USER, 'sunset', wolf({
      DEFAULT_CLIENT_SLUG: 'sunset',
      LUNA_DEPLOYMENT: 'production',
    }))
      && !CLIENTS.userCanAccessClient(WOLF_USER, 'wolfhouse-somo', wolf({
        DEFAULT_CLIENT_SLUG: 'sunset',
        LUNA_DEPLOYMENT: 'production',
      })));
});

console.log(`\n── verify:sunset-login-loop-001: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
console.log('verify:sunset-login-loop-001 — ALL CHECKS PASSED');
