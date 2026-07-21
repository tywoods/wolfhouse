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

function assertBothCredentialComparisonsAlwaysRun() {
  const prev = {
    required: process.env.CROWSNEST_AUTH_REQUIRED,
    username: process.env.CROWSNEST_AUTH_USERNAME,
    password: process.env.CROWSNEST_AUTH_PASSWORD,
  };
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
    if (prev.required === undefined) delete process.env.CROWSNEST_AUTH_REQUIRED;
    else process.env.CROWSNEST_AUTH_REQUIRED = prev.required;
    if (prev.username === undefined) delete process.env.CROWSNEST_AUTH_USERNAME;
    else process.env.CROWSNEST_AUTH_USERNAME = prev.username;
    if (prev.password === undefined) delete process.env.CROWSNEST_AUTH_PASSWORD;
    else process.env.CROWSNEST_AUTH_PASSWORD = prev.password;
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
      ok('login page includes logo', login.body.includes('/crowsnest/assets/logo.png'));
      ok('login page keeps operator badge', /Private operator portal/i.test(login.body));
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
