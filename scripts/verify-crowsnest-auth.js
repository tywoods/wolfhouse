'use strict';

/**
 * Runtime verifier for Crowsnest login portal — spawns local server, no DB/network deps.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API_SCRIPT = path.join(ROOT, 'scripts', 'crowsnest-api.js');
const AUTH_MODULE_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-auth.js');
const LOGO_PATH = path.join(ROOT, 'public', 'crowsnest', 'logo.png');
const EXPECTED_LOGO_SHA256 = '7ace8b7e584e0848da3ca248d90988ab71c288f895961f03ec4aa6ee6367ad24';
const REMOVED_LOGIN_COPY = 'This private portal is for Monshies and Earthling. Use your operator credentials to continue.';
const auth = require(AUTH_MODULE_PATH);
const BASE_PORT = Number(process.env.CROWSNEST_VERIFY_PORT) || 13040;

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function loginLogoCssLooksCentered(html) {
  const styleMatch = /<style\b[^>]*>([\s\S]*?)<\/style>/i.exec(String(html || ''));
  const css = styleMatch ? styleMatch[1] : '';
  const ruleMatch = /\.login-logo\s*\{([^}]*)\}/.exec(css);
  const rule = ruleMatch ? ruleMatch[1] : '';
  const hasDisplayBlock = /display\s*:\s*block\b/.test(rule);
  const hasMarginInlineAuto = /margin-inline\s*:\s*auto\b/.test(rule);
  const hasResponsiveWidth = /width\s*:\s*min\s*\(/.test(rule) || /width\s*:\s*100%\b/.test(rule);
  const hasHeightAuto = /height\s*:\s*auto\b/.test(rule);
  const hasOpaqueBlackBg = /background(?:-color)?\s*:\s*(?:#000(?:000)?|black|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))\b/i.test(rule);
  return hasDisplayBlock && hasMarginInlineAuto && hasResponsiveWidth && hasHeightAuto && !hasOpaqueBlackBg;
}

let pass = 0;
let fail = 0;
let child = null;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail ? `— ${detail}` : '');
  }
}

function request(port, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(options.headers || {}) };
    if (options.username != null && options.password != null) {
      const token = Buffer.from(`${options.username}:${options.password}`).toString('base64');
      headers.Authorization = `Basic ${token}`;
    }
    let body = options.body;
    if (body != null && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      body = String(body);
    }
    if (body != null && headers['Content-Length'] == null && headers['content-length'] == null) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: options.method || 'GET',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: buffer.toString('utf8'),
            buffer,
          });
        });
      },
    );
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function extractCookiePair(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  return list.map((entry) => String(entry).split(';')[0]).join('; ');
}

function flattenSetCookieHeader(setCookie) {
  return Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie || '');
}

function getCspNonce(csp) {
  const match = /style-src[^;]*'nonce-([^']+)'/.exec(String(csp || ''));
  return match ? match[1] : '';
}

function getStyleNonces(html) {
  return Array.from(String(html || '').matchAll(/<style\b[^>]*nonce="([^"]+)"/gi)).map((m) => m[1]);
}

function getTimingSafeEqualStringSource() {
  const src = require('fs').readFileSync(AUTH_MODULE_PATH, 'utf8');
  const match = /function timingSafeEqualString\(a, b\) \{[\s\S]*?\n\}/.exec(src);
  return match ? match[0] : '';
}

/**
 * Each timingSafeEqualString invocation performs exactly one crypto.timingSafeEqual.
 * Instrument that call to prove both username and password comparisons always run.
 */
function withTimingSafeEqualStringCallCount(run) {
  const crypto = require('crypto');
  const original = crypto.timingSafeEqual;
  let calls = 0;
  crypto.timingSafeEqual = (...args) => {
    calls += 1;
    return original.apply(crypto, args);
  };
  try {
    return { result: run(), calls };
  } finally {
    crypto.timingSafeEqual = original;
  }
}

function basicAuthRequest(username, password) {
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  return { headers: { authorization: `Basic ${token}` } };
}

const MULTI_AUTH_ENV_KEYS = [
  'CROWSNEST_AUTH_EARTHLING_USERNAME',
  'CROWSNEST_AUTH_EARTHLING_PASSWORD',
  'CROWSNEST_AUTH_MONSHIES_USERNAME',
  'CROWSNEST_AUTH_MONSHIES_PASSWORD',
];

const LEGACY_AUTH_ENV_KEYS = [
  'CROWSNEST_AUTH_USERNAME',
  'CROWSNEST_AUTH_PASSWORD',
];

function snapshotAuthEnv() {
  const keys = [
    'CROWSNEST_AUTH_REQUIRED',
    'NODE_ENV',
    ...MULTI_AUTH_ENV_KEYS,
    ...LEGACY_AUTH_ENV_KEYS,
  ];
  const snap = {};
  for (const key of keys) snap[key] = process.env[key];
  return snap;
}

function restoreAuthEnv(snap) {
  for (const [key, value] of Object.entries(snap)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearAuthCredentialEnv() {
  for (const key of [...MULTI_AUTH_ENV_KEYS, ...LEGACY_AUTH_ENV_KEYS]) {
    delete process.env[key];
  }
}

function assertAuthAccountsConfigContract() {
  const prev = snapshotAuthEnv();
  try {
    clearAuthCredentialEnv();
    delete process.env.NODE_ENV;

    ok(
      'getCrowsnestAuthAccounts helper is exported',
      typeof auth.getCrowsnestAuthAccounts === 'function',
    );
    if (typeof auth.getCrowsnestAuthAccounts !== 'function') return;

    {
      const cfg = auth.getCrowsnestAuthAccounts();
      ok('non-production default is configured', cfg && cfg.configured === true);
      ok('non-production default mode is default', cfg && cfg.mode === 'default');
      ok(
        'non-production default is single admin/admin account',
        Array.isArray(cfg.accounts)
          && cfg.accounts.length === 1
          && cfg.accounts[0].username === 'admin'
          && cfg.accounts[0].password === 'admin',
      );
      const legacy = auth.getCrowsnestBasicAuthConfig();
      ok(
        'deprecated basic config mirrors default admin/admin',
        legacy.configured === true && legacy.username === 'admin' && legacy.password === 'admin',
      );
    }

    {
      process.env.NODE_ENV = 'production';
      const cfg = auth.getCrowsnestAuthAccounts();
      ok('production without credentials is misconfigured', cfg && cfg.configured === false);
      ok('production without credentials has empty accounts', Array.isArray(cfg.accounts) && cfg.accounts.length === 0);
      ok('deprecated basic config reports production misconfigured', auth.getCrowsnestBasicAuthConfig().configured === false);
      delete process.env.NODE_ENV;
    }

    {
      clearAuthCredentialEnv();
      process.env.CROWSNEST_AUTH_USERNAME = 'legacy-user';
      process.env.CROWSNEST_AUTH_PASSWORD = 'legacy-pass';
      const cfg = auth.getCrowsnestAuthAccounts();
      ok('legacy pair configures one account', cfg.configured === true && cfg.mode === 'legacy' && cfg.accounts.length === 1);
      ok(
        'legacy account uses username/password env',
        cfg.accounts[0].username === 'legacy-user' && cfg.accounts[0].password === 'legacy-pass',
      );
      const legacy = auth.getCrowsnestBasicAuthConfig();
      ok(
        'deprecated basic config mirrors legacy pair',
        legacy.configured === true && legacy.username === 'legacy-user' && legacy.password === 'legacy-pass',
      );
    }

    {
      clearAuthCredentialEnv();
      process.env.CROWSNEST_AUTH_EARTHLING_USERNAME = 'earthling';
      process.env.CROWSNEST_AUTH_EARTHLING_PASSWORD = 'earth-secret';
      process.env.CROWSNEST_AUTH_MONSHIES_USERNAME = 'monshies';
      process.env.CROWSNEST_AUTH_MONSHIES_PASSWORD = 'mon-secret';
      process.env.CROWSNEST_AUTH_USERNAME = 'ignored-legacy';
      process.env.CROWSNEST_AUTH_PASSWORD = 'ignored-legacy-pass';
      const cfg = auth.getCrowsnestAuthAccounts();
      ok('multi-account mode is configured when all four are set', cfg.configured === true && cfg.mode === 'multi');
      ok('multi-account mode exposes exactly two accounts', cfg.accounts.length === 2);
      ok(
        'multi-account mode never mixes legacy credentials',
        cfg.accounts.every((a) => a.username !== 'ignored-legacy' && a.password !== 'ignored-legacy-pass'),
      );
      ok(
        'multi-account mode includes Earthling pair',
        cfg.accounts.some((a) => a.id === 'earthling' && a.username === 'earthling' && a.password === 'earth-secret'),
      );
      ok(
        'multi-account mode includes Monshies pair',
        cfg.accounts.some((a) => a.id === 'monshies' && a.username === 'monshies' && a.password === 'mon-secret'),
      );
      ok(
        'deprecated basic config reports multi configured without claiming legacy user',
        auth.getCrowsnestBasicAuthConfig().configured === true
          && auth.getCrowsnestBasicAuthConfig().username !== 'ignored-legacy',
      );
    }

    {
      clearAuthCredentialEnv();
      process.env.CROWSNEST_AUTH_EARTHLING_USERNAME = 'earthling';
      process.env.CROWSNEST_AUTH_EARTHLING_PASSWORD = 'earth-secret';
      // Missing Monshies pair entirely → multi mode selected, misconfigured
      const cfg = auth.getCrowsnestAuthAccounts();
      ok('partial multi-account env is misconfigured', cfg.configured === false && cfg.mode === 'multi');
      ok('partial multi-account does not fall back to legacy/default', cfg.accounts.length === 0);
      ok('deprecated basic config reports partial multi as misconfigured', auth.getCrowsnestBasicAuthConfig().configured === false);
    }

    {
      clearAuthCredentialEnv();
      process.env.CROWSNEST_AUTH_EARTHLING_USERNAME = 'earthling';
      process.env.CROWSNEST_AUTH_EARTHLING_PASSWORD = 'earth-secret';
      process.env.CROWSNEST_AUTH_MONSHIES_USERNAME = 'monshies';
      process.env.CROWSNEST_AUTH_MONSHIES_PASSWORD = '';
      const cfg = auth.getCrowsnestAuthAccounts();
      ok('blank multi-account password is misconfigured', cfg.configured === false && cfg.mode === 'multi');
    }

    {
      clearAuthCredentialEnv();
      process.env.CROWSNEST_AUTH_EARTHLING_USERNAME = 'same-user';
      process.env.CROWSNEST_AUTH_EARTHLING_PASSWORD = 'earth-secret';
      process.env.CROWSNEST_AUTH_MONSHIES_USERNAME = 'same-user';
      process.env.CROWSNEST_AUTH_MONSHIES_PASSWORD = 'mon-secret';
      const cfg = auth.getCrowsnestAuthAccounts();
      ok('duplicate multi-account usernames are misconfigured', cfg.configured === false && cfg.mode === 'multi');
    }

    {
      clearAuthCredentialEnv();
      process.env.CROWSNEST_AUTH_EARTHLING_USERNAME = '';
      process.env.CROWSNEST_AUTH_EARTHLING_PASSWORD = 'earth-secret';
      process.env.CROWSNEST_AUTH_MONSHIES_USERNAME = 'monshies';
      process.env.CROWSNEST_AUTH_MONSHIES_PASSWORD = 'mon-secret';
      const cfg = auth.getCrowsnestAuthAccounts();
      ok('blank multi-account username is misconfigured', cfg.configured === false && cfg.mode === 'multi');
    }

    {
      clearAuthCredentialEnv();
      process.env.CROWSNEST_AUTH_USERNAME = '';
      process.env.CROWSNEST_AUTH_PASSWORD = 'x';
      const cfg = auth.getCrowsnestAuthAccounts();
      ok('blank legacy username is misconfigured', cfg.configured === false && cfg.mode === 'legacy');
    }
  } finally {
    restoreAuthEnv(prev);
  }
}

function assertMultiAccountLoginAndBasicAuth() {
  const prev = snapshotAuthEnv();
  try {
    clearAuthCredentialEnv();
    process.env.CROWSNEST_AUTH_REQUIRED = 'true';
    process.env.CROWSNEST_AUTH_EARTHLING_USERNAME = 'earthling';
    process.env.CROWSNEST_AUTH_EARTHLING_PASSWORD = 'earth-secret';
    process.env.CROWSNEST_AUTH_MONSHIES_USERNAME = 'monshies';
    process.env.CROWSNEST_AUTH_MONSHIES_PASSWORD = 'mon-secret';

    ok('Earthling form login accepted', auth.isCrowsnestLoginAccepted('earthling', 'earth-secret') === true);
    ok('Monshies form login accepted', auth.isCrowsnestLoginAccepted('monshies', 'mon-secret') === true);
    ok('wrong password form login rejected', auth.isCrowsnestLoginAccepted('earthling', 'mon-secret') === false);
    ok('wrong username form login rejected', auth.isCrowsnestLoginAccepted('nobody', 'earth-secret') === false);
    ok('cross-account password form login rejected', auth.isCrowsnestLoginAccepted('earthling', 'wrong') === false);

    ok(
      'Earthling Basic Auth accepted',
      auth.isCrowsnestRequestAuthorized(basicAuthRequest('earthling', 'earth-secret')) === true,
    );
    ok(
      'Monshies Basic Auth accepted',
      auth.isCrowsnestRequestAuthorized(basicAuthRequest('monshies', 'mon-secret')) === true,
    );
    ok(
      'wrong Basic Auth credentials rejected',
      auth.isCrowsnestRequestAuthorized(basicAuthRequest('earthling', 'nope')) === false,
    );
    ok(
      'unknown Basic Auth username rejected',
      auth.isCrowsnestRequestAuthorized(basicAuthRequest('admin', 'admin')) === false,
    );
  } finally {
    restoreAuthEnv(prev);
  }
}

function assertMultiAccountConstantComparisonCount() {
  const prev = snapshotAuthEnv();
  try {
    clearAuthCredentialEnv();
    process.env.CROWSNEST_AUTH_REQUIRED = 'true';
    process.env.CROWSNEST_AUTH_EARTHLING_USERNAME = 'earthling';
    process.env.CROWSNEST_AUTH_EARTHLING_PASSWORD = 'earth-secret';
    process.env.CROWSNEST_AUTH_MONSHIES_USERNAME = 'monshies';
    process.env.CROWSNEST_AUTH_MONSHIES_PASSWORD = 'mon-secret';

    const cases = [
      { label: 'valid-first-account', username: 'earthling', password: 'earth-secret', expect: true },
      { label: 'valid-second-account', username: 'monshies', password: 'mon-secret', expect: true },
      { label: 'wrong-username', username: 'nobody', password: 'earth-secret', expect: false },
      { label: 'wrong-password', username: 'earthling', password: 'wrong-pass', expect: false },
    ];

    for (const testCase of cases) {
      const form = withTimingSafeEqualStringCallCount(() => (
        auth.isCrowsnestLoginAccepted(testCase.username, testCase.password)
      ));
      ok(
        `multi form ${testCase.label} performs exactly four digest comparisons`,
        form.calls === 4,
        `calls=${form.calls}`,
      );
      ok(
        `multi form ${testCase.label} acceptance`,
        form.result === testCase.expect,
        `result=${form.result}`,
      );

      const basic = withTimingSafeEqualStringCallCount(() => (
        auth.isCrowsnestRequestAuthorized(basicAuthRequest(testCase.username, testCase.password))
      ));
      ok(
        `multi basic ${testCase.label} performs exactly four digest comparisons`,
        basic.calls === 4,
        `calls=${basic.calls}`,
      );
      ok(
        `multi basic ${testCase.label} acceptance`,
        basic.result === testCase.expect,
        `result=${basic.result}`,
      );
    }

    const authSrc = fs.readFileSync(AUTH_MODULE_PATH, 'utf8');
    const matchFn = /function credentialsMatchAnyConfiguredAccount[\s\S]*?\n\}/.exec(authSrc);
    const matchSrc = matchFn ? matchFn[0] : '';
    ok(
      'multi-account matcher does not short-circuit via Array.some',
      matchSrc.includes('credentialsMatchAnyConfiguredAccount') && !/\.some\s*\(/.test(matchSrc),
    );
    ok(
      'multi-account matcher does not short-circuit via Array.find',
      !/\.find\s*\(/.test(matchSrc),
    );
  } finally {
    restoreAuthEnv(prev);
  }
}

function assertBothCredentialComparisonsAlwaysRun() {
  const prev = snapshotAuthEnv();
  clearAuthCredentialEnv();
  process.env.CROWSNEST_AUTH_REQUIRED = 'true';
  process.env.CROWSNEST_AUTH_USERNAME = 'admin';
  process.env.CROWSNEST_AUTH_PASSWORD = 'secret';

  const attempts = [
    ['wrong-user', 'secret'],
    ['admin', 'wrong-pass'],
    ['wrong-user', 'wrong-pass'],
    ['admin', 'secret'],
  ];

  try {
    for (const [username, password] of attempts) {
      const label = `${username === 'admin' ? 'user-ok' : 'user-bad'}/${password === 'secret' ? 'pass-ok' : 'pass-bad'}`;
      const form = withTimingSafeEqualStringCallCount(() => auth.isCrowsnestLoginAccepted(username, password));
      ok(
        `form login ${label} calls timingSafeEqualString twice`,
        form.calls === 2,
        `calls=${form.calls}`,
      );
      ok(
        `form login ${label} acceptance matches credentials`,
        form.result === (username === 'admin' && password === 'secret'),
        `result=${form.result}`,
      );

      const basic = withTimingSafeEqualStringCallCount(() => (
        auth.isCrowsnestRequestAuthorized(basicAuthRequest(username, password))
      ));
      ok(
        `basic auth ${label} calls timingSafeEqualString twice`,
        basic.calls === 2,
        `calls=${basic.calls}`,
      );
      ok(
        `basic auth ${label} acceptance matches credentials`,
        basic.result === (username === 'admin' && password === 'secret'),
        `result=${basic.result}`,
      );
    }
  } finally {
    restoreAuthEnv(prev);
  }
}

function assertTimingSafeEqualStringCoverage() {
  ok('timingSafeEqualString accepts equal credentials', auth.timingSafeEqualString('admin', 'admin') === true);
  ok('timingSafeEqualString rejects mismatched credentials', auth.timingSafeEqualString('admin', 'adnin') === false);
  ok('timingSafeEqualString rejects different-length credentials', auth.timingSafeEqualString('admin', 'adm') === false);

  const fnSource = getTimingSafeEqualStringSource();
  ok('timingSafeEqualString hashes inputs before compare', /createHash\(['"]sha256['"]\)/.test(fnSource) && /digest\(\)/.test(fnSource));
  ok('timingSafeEqualString uses crypto.timingSafeEqual', /crypto\.timingSafeEqual/.test(fnSource));
  ok('timingSafeEqualString does not branch on raw lengths', !/length\s*!==\s*.*length/.test(fnSource));

  assertBothCredentialComparisonsAlwaysRun();
}

function assertBrowserSecurityHeaders(name, res, { expectCsp = false } = {}) {
  ok(`${name} sets nosniff`, String(res.headers['x-content-type-options'] || '').toLowerCase() === 'nosniff');
  ok(`${name} sets referrer-policy`, String(res.headers['referrer-policy'] || '').toLowerCase() === 'no-referrer');
  ok(`${name} sets x-frame-options`, String(res.headers['x-frame-options'] || '').toUpperCase() === 'DENY');
  if (expectCsp) {
    const csp = String(res.headers['content-security-policy'] || '');
    const nonce = getCspNonce(csp);
    ok(`${name} sets CSP`, csp.includes("default-src 'none'"));
    ok(`${name} CSP frames denied`, csp.includes("frame-ancestors 'none'"));
    ok(`${name} CSP base-uri denied`, csp.includes("base-uri 'none'"));
    ok(`${name} CSP object-src denied`, csp.includes("object-src 'none'"));
    ok(`${name} CSP form-action self`, csp.includes("form-action 'self'"));
    ok(`${name} CSP img-src self`, csp.includes("img-src 'self'"));
    ok(`${name} CSP script-src none`, csp.includes("script-src 'none'"));
    ok(`${name} CSP has style nonce`, Boolean(nonce));
    const styleNonces = getStyleNonces(res.body);
    ok(`${name} inline style nonce matches CSP`, styleNonces.length > 0 && styleNonces.every((value) => value === nonce));
  }
}

function allowHeader(res) {
  return String(res.headers.allow || res.headers.Allow || '');
}

async function assertMethodRejected(port, urlPath, method, headers, expectedAllow) {
  const res = await request(port, urlPath, { method, headers });
  ok(`${method} ${urlPath} => 405`, res.statusCode === 405);
  ok(`${method} ${urlPath} Allow header`, allowHeader(res) === expectedAllow);
  ok(`${method} ${urlPath} returns method-not-allowed body`, /method not allowed/i.test(res.body));
  ok(`${method} ${urlPath} does not set cookies`, !('set-cookie' in res.headers));
  ok(`${method} ${urlPath} does not redirect`, !('location' in res.headers));
  return res;
}

function waitForHealthz(port, timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      request(port, '/healthz')
        .then((res) => {
          if (res.statusCode === 200) resolve();
          else retry();
        })
        .catch(retry);
    };
    function retry() {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Crowsnest did not become ready on port ${port}`));
        return;
      }
      setTimeout(tick, 150);
    }
    tick();
  });
}

function startServer(port, env) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [API_SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, ...env, CROWSNEST_PORT: String(port), CROWSNEST_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    waitForHealthz(port)
      .then(() => resolve(stderr))
      .catch((err) => {
        stopServer();
        reject(new Error(`${err.message}\n${stderr}`));
      });
  });
}

function stopServer() {
  if (!child) return Promise.resolve();
  const proc = child;
  child = null;
  return new Promise((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, 2000);
  });
}

async function runScenario(name, port, env, tests) {
  console.log(`\n[${name}]`);
  await startServer(port, env);
  try {
    for (const test of tests) {
      await test(port);
    }
  } finally {
    await stopServer();
  }
}

async function main() {
  console.log('verify:crowsnest-auth — runtime login portal gate\n');

  console.log('[config] auth accounts parsing / legacy isolation');
  assertAuthAccountsConfigContract();

  console.log('[auth] dual operator login + Basic Auth');
  assertMultiAccountLoginAndBasicAuth();

  console.log('[auth] constant-work digest comparisons');
  assertMultiAccountConstantComparisonCount();

  assertTimingSafeEqualStringCoverage();

  await runScenario('A auth disabled', BASE_PORT, {
    CROWSNEST_AUTH_REQUIRED: 'false',
  }, [
    async (port) => {
      const ui = await request(port, '/');
      ok('GET / => 200 when auth disabled', ui.statusCode === 200);
      ok('UI body includes Crowsnest', ui.body.includes('Crowsnest'));
    },
    async (port) => {
      const hz = await request(port, '/healthz');
      ok('GET /healthz => 200 when auth disabled', hz.statusCode === 200);
      let body;
      try { body = JSON.parse(hz.body); } catch { body = null; }
      ok('healthz auth_enabled:false when auth disabled', body && body.auth_enabled === false);
    },
  ]);

  await runScenario('B browser login portal', BASE_PORT + 1, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_USERNAME: 'admin',
    CROWSNEST_AUTH_PASSWORD: 'admin',
  }, [
    async (port) => {
      const root = await request(port, '/');
      ok('GET / without browser auth redirects to /login', root.statusCode === 302 && String(root.headers.location || '') === '/login');
      ok('redirect response does not use Basic challenge', !String(root.headers['www-authenticate'] || '').includes('Basic'));
      assertBrowserSecurityHeaders('unauthenticated redirect', root);
    },
    async (port) => {
      const login = await request(port, '/login');
      ok('GET /login returns 200', login.statusCode === 200);
      ok('login page renders HTML', /text\/html/i.test(String(login.headers['content-type'] || '')) && login.body.includes('<form'));
      ok('login page includes Crowsnest logo', login.body.includes('/crowsnest/assets/logo.png'));
      ok('login page uses Sunset portal shell', login.body.includes('loginShell') && login.body.includes('loginStage') && login.body.includes('loginCard'));
      ok('login page uses shared Sunset background', login.body.includes('/images/luna-login-bg.jpg'));
      ok('login page removes company field', !/for="client"|name="client"|>Company</i.test(login.body));
      ok('login page changes email to username', /for="username"[^>]*>Username</i.test(login.body) && /name="username"[^>]*type="text"/i.test(login.body));
      ok('login page keeps password field', /for="password"[^>]*>Password</i.test(login.body) && /name="password"[^>]*type="password"/i.test(login.body));
      ok('login page mirrors Sunset sign-in button treatment', login.body.includes('signInButton') && login.body.includes('signInButtonIcon'));
      ok('login page mirrors Sunset footer branding', login.body.includes('loginFooterBrand') && login.body.includes('Guest care, always there.'));
      ok('login page omits removed Monshies/Earthling sentence', !login.body.includes(REMOVED_LOGIN_COPY));
      ok('login logo CSS is centered and responsive', loginLogoCssLooksCentered(login.body));
      ok('login markup keeps login-logo class', /class="login-logo"/.test(login.body));
      assertBrowserSecurityHeaders('GET /login', login, { expectCsp: true });
      ok('login page keeps no-store cache-control', /no-store/i.test(String(login.headers['cache-control'] || '')));
    },
    async (port) => {
      const logo = await request(port, '/crowsnest/assets/logo.png');
      ok('logo asset returns 200', logo.statusCode === 200);
      ok('logo asset content-type is PNG', String(logo.headers['content-type'] || '') === 'image/png');
      ok('logo asset cache-control is immutable', /immutable/.test(String(logo.headers['cache-control'] || '')));
      ok('logo asset is full PNG', logo.buffer.length > 1000);
      ok('bundled logo SHA-256 matches replacement asset', sha256File(LOGO_PATH) === EXPECTED_LOGO_SHA256);
      ok('served logo SHA-256 matches replacement asset', sha256Buffer(logo.buffer) === EXPECTED_LOGO_SHA256);
    },
    async (port) => {
      const badBody = 'username=wrong&password=creds';
      const login = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: badBody,
      });
      ok('bad login returns login page', login.statusCode === 200 && /text\/html/i.test(String(login.headers['content-type'] || '')));
      ok('bad login shows generic failure', /Invalid credentials/i.test(login.body));
      ok('bad login does not leak username', !login.body.includes('wrong'));
      ok('bad login does not leak password', !login.body.includes('creds'));
      ok('bad login does not set cookie', !('set-cookie' in login.headers));
    },
    async (port) => {
      const oversizedValue = 'a'.repeat(1100);
      const oversizedBody = `username=${oversizedValue}&password=creds`;
      const login = await request(port, '/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(oversizedBody),
        },
        body: oversizedBody,
      });
      ok('oversized login returns 413', login.statusCode === 413);
      ok('oversized login body is generic', /payload too large/i.test(login.body) && !login.body.includes(oversizedValue) && !login.body.includes('creds'));
      ok('oversized login does not set cookie', !('set-cookie' in login.headers));
      ok('oversized login does not redirect', !('location' in login.headers));
      ok('oversized login sets no-store', /no-store/i.test(String(login.headers['cache-control'] || '')));
      const hz = await request(port, '/healthz');
      ok('server stays healthy after oversized login', hz.statusCode === 200);
    },
    async (port) => {
      const login = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=admin&password=admin',
      });
      ok('good login redirects to /', login.statusCode === 302 && String(login.headers.location || '') === '/');
      const cookieText = flattenSetCookieHeader(login.headers['set-cookie']);
      const cookie = extractCookiePair(login.headers['set-cookie']);
      ok('good login sets session cookie', /crowsnest_session=/.test(cookie));
      ok('good login cookie is HttpOnly', /HttpOnly/i.test(cookieText));
      ok('good login cookie is SameSite=Strict', /SameSite=Strict/i.test(cookieText));
      ok('good login cookie has Path=/', /Path=\//i.test(cookieText));
      ok('good login cookie omits Secure in non-production', !/Secure/i.test(cookieText));
      assertBrowserSecurityHeaders('successful login redirect', login);
      const authed = await request(port, '/', { headers: { Cookie: cookie } });
      ok('session cookie opens protected page', authed.statusCode === 200 && authed.body.includes('Clients'));
      ok('authenticated page exposes logout form button', /<form[^>]+method=["']post["'][^>]+action=["']\/logout["'][\s\S]*?<button[^>]*>\s*Sign out\s*<\/button>/i.test(authed.body));
      assertBrowserSecurityHeaders('authenticated GET /', authed, { expectCsp: true });

      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        await assertMethodRejected(port, '/healthz', method, undefined, 'GET, HEAD');
      }
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        await assertMethodRejected(port, '/', method, { Cookie: cookie }, 'GET, HEAD');
        await assertMethodRejected(port, '/crowsnest/ui', method, { Cookie: cookie }, 'GET, HEAD');
        await assertMethodRejected(port, '/crowsnest/assets/logo.png', method, { Cookie: cookie }, 'GET, HEAD');
      }
      for (const method of ['PUT', 'PATCH', 'DELETE']) {
        await assertMethodRejected(port, '/login', method, undefined, 'GET, HEAD, POST');
        await assertMethodRejected(port, '/logout', method, { Cookie: cookie }, 'POST');
      }

      const afterRejections = await request(port, '/', { headers: { Cookie: cookie } });
      ok('rejected methods do not change protected UI session', afterRejections.statusCode === 200 && afterRejections.body.includes('Clients'));
      const afterHealthzRejections = await request(port, '/healthz');
      ok('rejected methods do not change public healthz', afterHealthzRejections.statusCode === 200);

      const logout = await request(port, '/logout', {
        method: 'POST',
        headers: { Cookie: cookie },
      });
      ok('POST /logout redirects to /login', logout.statusCode === 302 && String(logout.headers.location || '') === '/login');
      const cleared = flattenSetCookieHeader(logout.headers['set-cookie']);
      ok('logout clears cookie', /Max-Age=0/i.test(cleared));
      const afterLogout = await request(port, '/', { headers: { Cookie: cookie } });
      ok('logout invalidates session for protected UI', afterLogout.statusCode === 302 && String(afterLogout.headers.location || '') === '/login');
      assertBrowserSecurityHeaders('logout redirect', logout);
    },
    async (port) => {
      const legacy = await request(port, '/crowsnest/ui', { username: 'admin', password: 'admin' });
      ok('legacy Basic Auth still opens UI', legacy.statusCode === 200);
      ok('legacy Basic Auth response includes Clients', legacy.body.includes('Clients'));
    },
    async (port) => {
      const hz = await request(port, '/healthz');
      ok('GET /healthz => 200 when auth enabled', hz.statusCode === 200);
      let body;
      try { body = JSON.parse(hz.body); } catch { body = null; }
      ok('healthz auth_enabled:true when auth enabled', body && body.auth_enabled === true);
      ok('healthz body does not contain admin credential', !/admin/i.test(hz.body));
    },
  ]);

  await runScenario('C production secure cookie', BASE_PORT + 2, {
    NODE_ENV: 'production',
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_USERNAME: 'admin',
    CROWSNEST_AUTH_PASSWORD: 'admin',
  }, [
    async (port) => {
      const login = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=admin&password=admin',
      });
      const cookie = flattenSetCookieHeader(login.headers['set-cookie']);
      ok('production login sets Secure cookie', /Secure/i.test(cookie));
    },
  ]);

  await runScenario('D auth required misconfigured', BASE_PORT + 3, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_USERNAME: '',
    CROWSNEST_AUTH_PASSWORD: '',
  }, [
    async (port) => {
      const ui = await request(port, '/crowsnest/ui');
      ok('GET /crowsnest/ui => 503 when auth misconfigured', ui.statusCode === 503);
      ok('503 safe message', ui.body.includes('Crowsnest auth is not configured'));
      ok('503 does not return Crowsnest page HTML', !ui.body.includes('<!DOCTYPE html>'));
    },
  ]);

  await runScenario('E baseline JSON errors', BASE_PORT + 4, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_USERNAME: 'admin',
    CROWSNEST_AUTH_PASSWORD: 'admin',
  }, [
    async (port) => {
      const notFound = await request(port, '/nope');
      ok('GET /nope => 404 JSON', notFound.statusCode === 404 && /application\/json/i.test(String(notFound.headers['content-type'] || '')));
      assertBrowserSecurityHeaders('404 JSON', notFound);
      ok('404 JSON body is safe', /not found/i.test(notFound.body) && !notFound.body.includes('<!DOCTYPE html>'));
    },
    async (port) => {
      const method = await request(port, '/healthz', { method: 'POST' });
      ok('POST /healthz => 405 JSON', method.statusCode === 405 && /application\/json/i.test(String(method.headers['content-type'] || '')));
      assertBrowserSecurityHeaders('405 JSON', method);
      ok('405 JSON body is safe', /method not allowed/i.test(method.body) && !method.body.includes('<!DOCTYPE html>'));
      ok('405 JSON Allow header stays correct', String(method.headers.allow || '') === 'GET, HEAD');
    },
  ]);

  await runScenario('F multi-account Earthling + Monshies', BASE_PORT + 5, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_EARTHLING_USERNAME: 'earthling-op',
    CROWSNEST_AUTH_EARTHLING_PASSWORD: 'earth-pass',
    CROWSNEST_AUTH_MONSHIES_USERNAME: 'monshies-op',
    CROWSNEST_AUTH_MONSHIES_PASSWORD: 'mon-pass',
    // Legacy present must be ignored in multi mode
    CROWSNEST_AUTH_USERNAME: 'admin',
    CROWSNEST_AUTH_PASSWORD: 'admin',
  }, [
    async (port) => {
      const bad = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=admin&password=admin',
      });
      ok('multi mode rejects legacy shared credential', bad.statusCode === 200 && /Invalid credentials/i.test(bad.body));
      ok('multi mode bad login stays generic', !bad.body.includes('admin') && !bad.body.includes('earthling-op'));
      ok('multi mode bad login sets no cookie', !('set-cookie' in bad.headers));
    },
    async (port) => {
      const earthlingLogin = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=earthling-op&password=earth-pass',
      });
      ok('Earthling browser login redirects to /', earthlingLogin.statusCode === 302 && String(earthlingLogin.headers.location || '') === '/');
      const earthlingCookie = extractCookiePair(earthlingLogin.headers['set-cookie']);
      ok('Earthling login sets session cookie', /crowsnest_session=/.test(earthlingCookie));

      const monshiesLogin = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=monshies-op&password=mon-pass',
      });
      ok('Monshies browser login redirects to /', monshiesLogin.statusCode === 302 && String(monshiesLogin.headers.location || '') === '/');
      const monshiesCookie = extractCookiePair(monshiesLogin.headers['set-cookie']);
      ok('Monshies login sets session cookie', /crowsnest_session=/.test(monshiesCookie));
      ok('Earthling and Monshies sessions are distinct tokens', earthlingCookie !== monshiesCookie);

      const earthlingUi = await request(port, '/', { headers: { Cookie: earthlingCookie } });
      ok('Earthling session opens protected UI', earthlingUi.statusCode === 200 && earthlingUi.body.includes('Clients'));
      const monshiesUi = await request(port, '/', { headers: { Cookie: monshiesCookie } });
      ok('Monshies session opens protected UI', monshiesUi.statusCode === 200 && monshiesUi.body.includes('Clients'));

      const logoutEarthling = await request(port, '/logout', {
        method: 'POST',
        headers: { Cookie: earthlingCookie },
      });
      ok('Earthling logout redirects to /login', logoutEarthling.statusCode === 302 && String(logoutEarthling.headers.location || '') === '/login');
      const afterEarthlingLogout = await request(port, '/', { headers: { Cookie: earthlingCookie } });
      ok('Earthling logout invalidates only Earthling session', afterEarthlingLogout.statusCode === 302 && String(afterEarthlingLogout.headers.location || '') === '/login');
      const monshiesStillAuthed = await request(port, '/', { headers: { Cookie: monshiesCookie } });
      ok('Monshies session remains valid after Earthling logout', monshiesStillAuthed.statusCode === 200 && monshiesStillAuthed.body.includes('Clients'));
    },
    async (port) => {
      const earthlingBasic = await request(port, '/crowsnest/ui', {
        username: 'earthling-op',
        password: 'earth-pass',
      });
      ok('Earthling legacy Basic Auth opens UI', earthlingBasic.statusCode === 200 && earthlingBasic.body.includes('Clients'));
      const monshiesBasic = await request(port, '/crowsnest/ui', {
        username: 'monshies-op',
        password: 'mon-pass',
      });
      ok('Monshies legacy Basic Auth opens UI', monshiesBasic.statusCode === 200 && monshiesBasic.body.includes('Clients'));
      const legacyBasic = await request(port, '/crowsnest/ui', { username: 'admin', password: 'admin' });
      ok('multi mode rejects legacy Basic Auth shared credential', legacyBasic.statusCode === 302 && String(legacyBasic.headers.location || '') === '/login');
    },
    async (port) => {
      const hz = await request(port, '/healthz');
      ok('multi mode GET /healthz stays public 200', hz.statusCode === 200);
      let body;
      try { body = JSON.parse(hz.body); } catch { body = null; }
      ok('multi mode healthz auth_enabled:true', body && body.auth_enabled === true);
      ok('multi mode healthz omits passwords', !/earth-pass|mon-pass|admin/i.test(hz.body));
      ok('multi mode healthz omits credential env names', !/CROWSNEST_AUTH_.*PASSWORD/i.test(hz.body));
    },
  ]);

  await runScenario('G multi-account production Secure cookie', BASE_PORT + 6, {
    NODE_ENV: 'production',
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_EARTHLING_USERNAME: 'earthling-op',
    CROWSNEST_AUTH_EARTHLING_PASSWORD: 'earth-pass',
    CROWSNEST_AUTH_MONSHIES_USERNAME: 'monshies-op',
    CROWSNEST_AUTH_MONSHIES_PASSWORD: 'mon-pass',
  }, [
    async (port) => {
      const login = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=monshies-op&password=mon-pass',
      });
      const cookie = flattenSetCookieHeader(login.headers['set-cookie']);
      ok('multi-account production login sets Secure cookie', /Secure/i.test(cookie));
    },
  ]);

  await runScenario('H multi-account misconfigured duplicate usernames', BASE_PORT + 7, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_EARTHLING_USERNAME: 'same-op',
    CROWSNEST_AUTH_EARTHLING_PASSWORD: 'earth-pass',
    CROWSNEST_AUTH_MONSHIES_USERNAME: 'same-op',
    CROWSNEST_AUTH_MONSHIES_PASSWORD: 'mon-pass',
  }, [
    async (port) => {
      const ui = await request(port, '/crowsnest/ui');
      ok('duplicate usernames => 503 when auth required', ui.statusCode === 503);
      ok('duplicate usernames 503 message is safe', ui.body.includes('Crowsnest auth is not configured'));
      const hz = await request(port, '/healthz');
      ok('duplicate usernames still leave /healthz public', hz.statusCode === 200);
    },
  ]);

  await runScenario('I Slice 1 four-section protected routes', BASE_PORT + 8, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_USERNAME: 'admin',
    CROWSNEST_AUTH_PASSWORD: 'admin',
  }, [
    async (port) => {
      const protectedPaths = ['/', '/clients', '/billing', '/communications', '/sales', '/crowsnest', '/crowsnest/ui'];
      for (const urlPath of protectedPaths) {
        const unauth = await request(port, urlPath);
        ok(
          `unauthenticated GET ${urlPath} redirects to /login`,
          unauth.statusCode === 302 && String(unauth.headers.location || '') === '/login',
        );
        ok(
          `unauthenticated GET ${urlPath} has no Basic challenge`,
          !String(unauth.headers['www-authenticate'] || '').includes('Basic'),
        );
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
          await assertMethodRejected(port, urlPath, method, undefined, 'GET, HEAD');
        }
      }
    },
    async (port) => {
      const login = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=admin&password=admin',
      });
      const cookie = extractCookiePair(login.headers['set-cookie']);
      ok('Slice 1 login sets session cookie', /crowsnest_session=/.test(cookie));

      function countAriaCurrent(html) {
        return (String(html || '').match(/aria-current=["']page["']/gi) || []).length;
      }

      function hasInventedMetricNumber(html) {
        const text = String(html || '');
        if (/\$\s*\d|\d+\s*(?:USD|EUR|€)|€\s*\d/i.test(text)) return true;
        if (/\b(?:tokens?|requests?|messages?)\s*[:=]?\s*\d+/i.test(text)) return true;
        if (/\bAI\b[^<]{0,40}\b\d{2,}/i.test(text)) return true;
        if (/\b(?:cost|spend|invoice|balance)\b[^<]{0,40}\b\d+/i.test(text)) return true;
        return false;
      }

      const routeMatrix = [
        { path: '/', label: 'Spyglass', expectSpyglass: true, activeHref: '/' },
        { path: '/crowsnest', label: 'alias /crowsnest', expectSpyglass: true, activeHref: '/' },
        { path: '/crowsnest/ui', label: 'alias /crowsnest/ui', expectSpyglass: true, activeHref: '/' },
        { path: '/clients', label: 'Clients', expectClients: true, activeHref: '/clients' },
        { path: '/billing', label: 'Billing', expectBilling: true, activeHref: '/billing' },
        { path: '/communications', label: 'Communications', expectComms: true, activeHref: '/communications' },
        { path: '/sales', label: 'Sales', expectSales: true, activeHref: '/sales' },
      ];

      for (const route of routeMatrix) {
        const head = await request(port, route.path, { method: 'HEAD', headers: { Cookie: cookie } });
        ok(`HEAD ${route.path} => 200`, head.statusCode === 200);
        ok(`HEAD ${route.path} no-store`, /no-store/i.test(String(head.headers['cache-control'] || '')));

        const res = await request(port, route.path, { headers: { Cookie: cookie } });
        ok(`GET ${route.path} => 200`, res.statusCode === 200);
        ok(`GET ${route.path} no-store`, /no-store/i.test(String(res.headers['cache-control'] || '')));
        assertBrowserSecurityHeaders(`GET ${route.path}`, res, { expectCsp: true });
        ok(`GET ${route.path} nav Spyglass href`, /href=["']\/["']/.test(res.body));
        ok(`GET ${route.path} nav Clients href`, /href=["']\/clients["']/.test(res.body));
        ok(`GET ${route.path} nav Billing href`, /href=["']\/billing["']/.test(res.body));
        ok(`GET ${route.path} nav Communications href`, /href=["']\/communications["']/.test(res.body));
        ok(`GET ${route.path} nav Sales href`, /href=["']\/sales["']/.test(res.body));
        ok(`GET ${route.path} has exactly one aria-current`, countAriaCurrent(res.body) === 1);
        const activeRe = new RegExp(
          `<a\\b[^>]*\\bhref=["']${route.activeHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*aria-current=["']page["']|<a\\b[^>]*aria-current=["']page["'][^>]*\\bhref=["']${route.activeHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`,
          'i',
        );
        ok(`GET ${route.path} aria-current on ${route.activeHref}`, activeRe.test(res.body));
        ok(`GET ${route.path} keeps logout`, /action=["']\/logout["']/i.test(res.body));

        if (route.expectSpyglass) {
          // Pupil: Spyglass shows privacy-safe tenant metrics cards from the Crowsnest
          // metrics store. Empty store => "not reporting yet" (no fabricated counts);
          // AI usage numbers remain allowed only with explicit sample labeling.
          ok(`${route.label} renders Spyglass`, /Spyglass/i.test(res.body) && /<h1[^>]*>[\s\S]*Spyglass/i.test(res.body));
          ok(
            `${route.label} renders privacy-safe client metrics cards`,
            res.body.includes('client-row')
              && res.body.includes('Wolfhouse Somo')
              && res.body.includes('Sunset Somo')
              && res.body.includes('Sunset Sardinero'),
          );
          ok(`${route.label} omits onboarding`, !res.body.includes('New client onboarding'));
          ok(
            `${route.label} shows not reporting yet when empty`,
            /not reporting yet/i.test(res.body) && /0\/3 reporting|0 reporting/.test(res.body),
          );
          ok(
            `${route.label} reads own metrics store, not tenant DB`,
            /own metrics store/i.test(res.body) && /no direct access to tenant/i.test(res.body),
          );
          ok(
            `${route.label} numbers only with sample labeling`,
            !hasInventedMetricNumber(res.body) || /sample/i.test(res.body),
          );
          ok(`${route.label} read-only language`, /read-only|no live writes|no writes/i.test(res.body));
        }
        if (route.expectClients) {
          ok('Clients route keeps Wolfhouse card', res.body.includes('Wolfhouse Somo'));
          ok('Clients route keeps Sunset Somo card', res.body.includes('Sunset Somo'));
          ok('Clients route keeps Sunset Sardinero card', res.body.includes('Sunset Sardinero'));
          ok('Clients route keeps onboarding', res.body.includes('New client onboarding'));
          ok('Clients route keeps templates', /surf house template/i.test(res.body) && /surf school template/i.test(res.body));
          ok('Clients route keeps disabled create', res.body.includes('Create client') && /disabled|aria-disabled/.test(res.body));
        }
        if (route.expectBilling) {
          ok('Billing placeholder heading', /Billing/i.test(res.body));
          ok('Billing not connected copy', /not connected|not available|no data source|unavailable/i.test(res.body));
          ok('Billing invents no amounts', !hasInventedMetricNumber(res.body));
          ok('Billing has no mutation form', !/<form\b/i.test(res.body.replace(/<form[^>]+action=["']\/logout["'][\s\S]*?<\/form>/i, '')));
        }
        if (route.expectComms) {
          ok('Communications placeholder heading', /Communications/i.test(res.body));
          ok('Communications not connected copy', /not connected|not available|no data source|unavailable/i.test(res.body));
          ok('Communications invents no counts', !hasInventedMetricNumber(res.body));
          ok('Communications has no send controls', !/send message|recipient/i.test(res.body));
        }
        if (route.expectSales) {
          ok('Sales route heading', /<h1[^>]*>[\s\S]*Sales/i.test(res.body));
          ok('Sales route shows cockpit', /sales-cockpit|Sales cockpit/i.test(res.body));
          ok('Sales route has Add prospect', /href=["']\/sales\?mode=add["']/i.test(res.body) && /Add prospect/i.test(res.body));
          ok('Sales route default omits intake form', !/<form\b[^>]*action=["']\/sales\/prospects["']/i.test(res.body));
          ok('Sales route mentions fixture/manual research', /fixture|manual/i.test(res.body) && /research|intake|pipeline/i.test(res.body));
        }
      }

      // Hostile privacy checks via renderCrowsnestPage (accepts a raw clientMetrics map).
      // Even if a snapshot smuggled sensitive/arbitrary keys past ingest, Spyglass must
      // only surface the privacy-safe measured aggregates — never phone/email/secrets.
      let renderCrowsnestPage = null;
      try {
        ({ renderCrowsnestPage } = require(path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-page.js')));
      } catch {
        renderCrowsnestPage = null;
      }
      if (typeof renderCrowsnestPage === 'function') {
        const measuredBase = {
          schema_version: 'crowsnest.client_metrics.v1',
          snapshot_id: 'snap_hostile_auth_001',
          captured_at: '2026-07-22T15:00:00.000Z',
          client_slug: 'wolfhouse-somo',
          tenant_id: 'tenant_wolfhouse',
          source_service: 'hostile-auth-verifier',
          window: { kind: 'rolling_24h', days: 1 },
        };
        const hostileMeasured = {
          ...measuredBase,
          metrics: {
            availability: 'measured',
            conversations_total: 128,
            conversations_active: 34,
            conversations_needing_human: 5,
            messages_last_24h: 342,
            messages_per_day_avg: 318.5,
            last_activity_at: '2026-07-22T14:58:12.000Z',
            phone: '+34999888777',
            email: 'secret-guest@example.com',
            guest_name: 'Alice Secret',
            api_key: 'sk-hostile-must-never-render',
            password: 'hunter2-hostile',
            arbitrary_payload: { nested: 'should-not-leak' },
          },
        };
        const hostileHtml = renderCrowsnestPage({
          view: 'spyglass',
          clientMetrics: { 'wolfhouse-somo': hostileMeasured },
        });
        ok(
          'hostile: contract-valid measured counts render',
          /128\s*convs/i.test(hostileHtml)
            && /319\/day/.test(hostileHtml)
            && /5 need human/.test(hostileHtml)
            && /1\/3 reporting/.test(hostileHtml),
        );
        ok('hostile: sensitive phone cannot render', !hostileHtml.includes('+34999888777'));
        ok('hostile: sensitive email cannot render', !hostileHtml.includes('secret-guest@example.com'));
        ok('hostile: sensitive guest_name cannot render', !hostileHtml.includes('Alice Secret'));
        ok('hostile: api_key cannot render', !hostileHtml.includes('sk-hostile-must-never-render'));
        ok('hostile: password cannot render', !hostileHtml.includes('hunter2-hostile'));
        ok('hostile: arbitrary nested payload cannot render', !hostileHtml.includes('should-not-leak'));

        const unavailableHostile = {
          ...measuredBase,
          snapshot_id: 'snap_hostile_auth_unavailable',
          metrics: {
            availability: 'unavailable',
            conversations_total: 777001,
            conversations_active: 777002,
            conversations_needing_human: 777003,
            messages_last_24h: 777004,
            messages_per_day_avg: 777005,
            last_activity_at: '2026-07-22T14:58:12.000Z',
            phone: '+34111222333',
          },
        };
        const unavailableHtml = renderCrowsnestPage({
          view: 'spyglass',
          clientMetrics: { 'wolfhouse-somo': unavailableHostile },
        });
        ok(
          'hostile: unavailable metrics stay not-reporting (no invented counts)',
          /not reporting yet/i.test(unavailableHtml)
            && /0\/3 reporting|0 reporting/.test(unavailableHtml)
            && !unavailableHtml.includes('777001')
            && !unavailableHtml.includes('777003')
            && !unavailableHtml.includes('777005')
            && !unavailableHtml.includes('+34111222333'),
        );
      } else {
        ok('hostile: renderCrowsnestPage helper available', false);
      }

      const unknown = await request(port, '/nope-slice1', { headers: { Cookie: cookie } });
      ok('unknown route => 404 JSON', unknown.statusCode === 404 && /application\/json/i.test(String(unknown.headers['content-type'] || '')));
      ok('unknown route body is not found', /not found/i.test(unknown.body) && !unknown.body.includes('<!DOCTYPE html>'));
      assertBrowserSecurityHeaders('unknown route 404', unknown);
    },
  ]);

  console.log(`\n── verify:crowsnest-auth: ${pass} passed, ${fail} failed ──`);
  if (fail === 0) {
    console.log('verify:crowsnest-auth — ALL CHECKS PASSED');
  }
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  await stopServer();
  console.error(err);
  process.exit(1);
});
