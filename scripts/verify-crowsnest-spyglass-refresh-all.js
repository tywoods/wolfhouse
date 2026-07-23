'use strict';

/**
 * Focused verifier for Crowsnest Spyglass Refresh all (Slice A).
 * Offline — no Azure ARM, no managed-identity tokens, no tenant DB, no external APIs.
 */

const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API_SCRIPT = path.join(ROOT, 'scripts', 'crowsnest-api.js');
const API_PATH = API_SCRIPT;
const PAGE_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-page.js');
const CONTRACT_REL = 'scripts/lib/crowsnest/crowsnest-spyglass-refresh.js';
const CONTRACT_PATH = path.join(ROOT, CONTRACT_REL);
const DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'SPYGLASS-REFRESH-ALL.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const BASE_PORT = Number(process.env.CROWSNEST_VERIFY_SPYGLASS_REFRESH_PORT) || 13410;

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

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
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

function allowHeader(res) {
  return String(res.headers.allow || res.headers.Allow || '');
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
  return new Promise((resolve) => {
    if (!child) {
      resolve();
      return;
    }
    const current = child;
    child = null;
    current.once('exit', () => resolve());
    current.kill('SIGTERM');
    setTimeout(() => {
      try {
        current.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 2000);
  });
}

async function runScenario(name, port, env, steps) {
  console.log(`\n▸ ${name}`);
  await startServer(port, env);
  try {
    for (const step of steps) {
      await step(port);
    }
  } finally {
    await stopServer();
  }
}

function statusByClient(results) {
  const map = {};
  for (const row of results || []) map[row.client_id] = row.status;
  return map;
}

function structuralAndContractChecks() {
  console.log('\n▸ Structural + pure contract');
  const apiSrc = read(API_PATH) || '';
  const pageSrc = read(PAGE_PATH) || '';
  const contractSrc = read(CONTRACT_PATH) || '';
  const docSrc = read(DOC_PATH) || '';
  const pkg = JSON.parse(read(PKG_PATH) || '{}');

  ok('contract module exists', fs.existsSync(CONTRACT_PATH));
  ok('docs/crowsnest/SPYGLASS-REFRESH-ALL.md exists', fs.existsSync(DOC_PATH));
  ok(
    'package.json has verify:crowsnest-spyglass-refresh-all',
    pkg.scripts && pkg.scripts['verify:crowsnest-spyglass-refresh-all']
      === 'node scripts/verify-crowsnest-spyglass-refresh-all.js',
  );
  ok('api requires spyglass refresh module', /crowsnest-spyglass-refresh/.test(apiSrc));
  ok('router allowlists POST /spyglass/refresh-all', /\/spyglass\/refresh-all/.test(apiSrc));
  ok('page has Refresh all form action', /action=["']\/spyglass\/refresh-all["']/.test(pageSrc));
  ok('page Refresh all button copy', /Refresh all/.test(pageSrc));
  ok(
    'page explains configured-client report requests',
    /configured clients|configured client's reporter|configured client/i.test(pageSrc),
  );
  ok(
    'page does not claim every client refreshed / metrics refreshed',
    !/every client refreshed|all clients refreshed|metrics refreshed/i.test(pageSrc),
  );

  ok(
    'contract has no process.env reads',
    !/process\.env/.test(contractSrc),
  );
  ok(
    'contract has no global fetch / az CLI / pg',
    !/\bfetch\b/.test(contractSrc)
      && !/\baz\b/.test(contractSrc)
      && !/require\(['"]pg['"]\)/.test(contractSrc)
      && !/DefaultAzureCredential|ManagedIdentityCredential|@azure\//.test(contractSrc),
  );
  ok(
    'api Slice A wiring has no Azure SDK / ARM token code',
    !/DefaultAzureCredential|ManagedIdentityCredential|@azure\//.test(apiSrc)
      && !/management\.azure\.com/.test(apiSrc),
  );
  ok(
    'doc describes Slice B managed-identity Job-start + RBAC',
    /Slice B/i.test(docSrc)
      && /managed.?identity/i.test(docSrc)
      && /RBAC/i.test(docSrc)
      && /Job-?start|job start/i.test(docSrc),
  );
  ok(
    'doc keeps scheduled reporting separate',
    /scheduled/i.test(docSrc) && /separate/i.test(docSrc),
  );

  let contract;
  try {
    contract = require(CONTRACT_PATH);
  } catch (err) {
    ok('contract module loads', false, err && err.message);
    return;
  }
  ok('contract module loads', true);
  ok(
    'FIXED_CLIENT_ALLOWLIST is frozen trio',
    Array.isArray(contract.FIXED_CLIENT_ALLOWLIST)
      && contract.FIXED_CLIENT_ALLOWLIST.length === 3
      && contract.FIXED_CLIENT_ALLOWLIST.includes('wolfhouse-somo')
      && contract.FIXED_CLIENT_ALLOWLIST.includes('sunset-somo')
      && contract.FIXED_CLIENT_ALLOWLIST.includes('sunset-sardinero')
      && Object.isFrozen(contract.FIXED_CLIENT_ALLOWLIST),
  );
  ok(
    'SUNSET_SOMO_STAGING_TARGET names manual job',
    contract.SUNSET_SOMO_STAGING_TARGET
      && contract.SUNSET_SOMO_STAGING_TARGET.client_id === 'sunset-somo'
      && contract.SUNSET_SOMO_STAGING_TARGET.job_name === 'sunset-somo-stg-cn-metrics',
  );
  ok(
    'requestSpyglassRefreshAll exported',
    typeof contract.requestSpyglassRefreshAll === 'function',
  );
}

async function pureDomainBehavior() {
  console.log('\n▸ Pure domain: allowlist, injection, safe failures');
  const contract = require(CONTRACT_PATH);
  const sunset = contract.SUNSET_SOMO_STAGING_TARGET;

  const started = await contract.requestSpyglassRefreshAll({
    configuredTargets: [sunset],
    startJob: async (target) => {
      ok(
        'injected startJob receives Sunset staging target only',
        target && target.client_id === 'sunset-somo'
          && target.job_name === 'sunset-somo-stg-cn-metrics',
      );
      return { ok: true };
    },
  });
  ok('injected Sunset refresh ok', started && started.ok === true);
  const mapStarted = statusByClient(started.results);
  ok('Sunset injectable => started', mapStarted['sunset-somo'] === 'started');
  ok('unconfigured Sardinero => not_configured', mapStarted['sunset-sardinero'] === 'not_configured');
  ok(
    'Wolfhouse not auto-assumed configured',
    mapStarted['wolfhouse-somo'] === 'not_configured',
  );
  ok(
    'coverage never claims all refreshed',
    started.all_clients_refreshed !== true
      && started.all_refreshed !== true,
  );

  const failed = await contract.requestSpyglassRefreshAll({
    configuredTargets: [sunset],
    startJob: async () => {
      throw new Error('ARM boom subscription sk-secret DSN=postgres://x');
    },
  });
  const mapFail = statusByClient(failed.results);
  ok('transport throw => unavailable', mapFail['sunset-somo'] === 'unavailable');
  ok(
    'unavailable result has no raw error / secrets / job id leak fields',
    failed.results.every((row) => {
      const keys = Object.keys(row).sort();
      return keys.length === 2 && keys[0] === 'client_id' && keys[1] === 'status';
    }),
  );

  let startCalls = 0;
  const ignoredBrowser = await contract.requestSpyglassRefreshAll({
    configuredTargets: [sunset],
    startJob: async () => {
      startCalls += 1;
      return { ok: true };
    },
    // Browser-shaped extras must not expand the allowlist or add targets.
    browserBody: {
      client_id: 'sunset-sardinero',
      job_name: 'evil-job',
      resource_group: 'rg-x',
    },
  });
  const mapIgnore = statusByClient(ignoredBrowser.results);
  ok('browser body cannot configure Sardinero', mapIgnore['sunset-sardinero'] === 'not_configured');
  ok('only fixed configured targets invoked', startCalls === 1);

  const offAllowlist = await contract.requestSpyglassRefreshAll({
    configuredTargets: [
      sunset,
      { client_id: 'totally-other-client', job_name: 'other-job' },
    ],
    startJob: async (target) => {
      if (target.client_id !== 'sunset-somo') {
        throw new Error('off-allowlist invoked');
      }
      return { ok: true };
    },
  });
  ok(
    'off-allowlist configured target ignored',
    !statusByClient(offAllowlist.results)['totally-other-client']
      && offAllowlist.results.length === 3,
  );
}

async function main() {
  console.log('verify:crowsnest-spyglass-refresh-all — Spyglass Refresh all Slice A\n');

  structuralAndContractChecks();
  if (fs.existsSync(CONTRACT_PATH)) {
    await pureDomainBehavior();
  }

  const authEnv = {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_USERNAME: 'admin',
    CROWSNEST_AUTH_PASSWORD: 'admin',
    NODE_ENV: 'development',
    CROWSNEST_SPYGLASS_REFRESH_FIXTURE_TRANSPORT: '1',
  };

  await runScenario('Auth + method + no browser target', BASE_PORT, authEnv, [
    async (port) => {
      const unauthGet = await request(port, '/');
      ok(
        'unauthenticated Spyglass redirects to /login',
        unauthGet.statusCode === 302 && String(unauthGet.headers.location || '') === '/login',
        `status=${unauthGet.statusCode}`,
      );

      const unauthPost = await request(port, '/spyglass/refresh-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'client_id=sunset-somo&job_name=evil',
      });
      ok(
        'unauthenticated POST refresh redirects to /login',
        unauthPost.statusCode === 302 && String(unauthPost.headers.location || '') === '/login',
        `status=${unauthPost.statusCode}`,
      );

      const getRefresh = await request(port, '/spyglass/refresh-all', {
        method: 'GET',
        username: 'admin',
        password: 'admin',
      });
      ok('authenticated GET refresh => 405', getRefresh.statusCode === 405, `got ${getRefresh.statusCode}`);
      ok('GET refresh Allow: POST', allowHeader(getRefresh) === 'POST', allowHeader(getRefresh));
    },
  ]);

  await runScenario('Authenticated Refresh all coverage + safe page copy', BASE_PORT + 1, authEnv, [
    async (port) => {
      const login = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=admin&password=admin',
      });
      const cookie = extractCookiePair(login.headers['set-cookie']);
      ok('login sets session cookie', /crowsnest_session=/.test(cookie), cookie);

      const page = await request(port, '/', { headers: { Cookie: cookie } });
      ok('authenticated Spyglass 200', page.statusCode === 200);
      ok('Spyglass shows Refresh all button', /Refresh all/.test(page.body));
      ok(
        'Spyglass form posts to /spyglass/refresh-all',
        /<form\b[^>]*action=["']\/spyglass\/refresh-all["'][^>]*method=["']post["']/i.test(page.body)
          || /<form\b[^>]*method=["']post["'][^>]*action=["']\/spyglass\/refresh-all["']/i.test(page.body),
      );
      ok(
        'pre-POST copy does not claim metrics refreshed',
        !/metrics refreshed|every client refreshed/i.test(page.body),
      );

      const xssPayload = '<script>alert(1)</script>';
      const refresh = await request(port, '/spyglass/refresh-all', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `client_id=sunset-sardinero&job_name=${encodeURIComponent(xssPayload)}&resource_name=rg-leak`,
      });
      ok('authenticated POST refresh => 200 HTML', refresh.statusCode === 200 && /text\/html/i.test(String(refresh.headers['content-type'] || '')));
      ok('POST result shows started for Sunset', /Sunset Somo/i.test(refresh.body) && /started|Report requested/i.test(refresh.body));
      ok('POST result shows not_configured for Sardinero', /Sunset Sardinero/i.test(refresh.body) && /not[_ ]configured|Not configured/i.test(refresh.body));
      ok('POST result shows not_configured for Wolfhouse', /Wolfhouse/i.test(refresh.body) && /not[_ ]configured|Not configured/i.test(refresh.body));
      ok(
        'response does not echo browser job_name / XSS',
        !refresh.body.includes(xssPayload)
          && !refresh.body.includes('<script>alert(1)</script>')
          && !/evil|rg-leak|sunset-somo-stg-cn-metrics|postgres:\/\//i.test(refresh.body),
      );
      ok(
        'response does not claim every client refreshed',
        !/every client refreshed|all clients refreshed|metrics refreshed/i.test(refresh.body),
      );
      ok(
        'coverage panel is honest (partial)',
        /configured|coverage|partial|not configured|unavailable|report requested/i.test(refresh.body),
      );
    },
  ]);

  await runScenario('Safe unavailable when fixture transport off', BASE_PORT + 2, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_USERNAME: 'admin',
    CROWSNEST_AUTH_PASSWORD: 'admin',
    NODE_ENV: 'development',
    // No fixture transport — Slice A stub must map to unavailable, not invent success.
  }, [
    async (port) => {
      const login = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=admin&password=admin',
      });
      const cookie = extractCookiePair(login.headers['set-cookie']);
      const refresh = await request(port, '/spyglass/refresh-all', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: '',
      });
      ok('stub transport POST => 200', refresh.statusCode === 200);
      ok(
        'configured Sunset maps to unavailable without Azure adapter',
        /Sunset Somo/i.test(refresh.body) && /unavailable|Unavailable/i.test(refresh.body),
      );
      ok(
        'no raw ARM/token/DSN leak on unavailable',
        !/management\.azure\.com|Bearer |sk-|postgres:\/\/|DefaultAzureCredential|job id|execution/i.test(refresh.body),
      );
    },
  ]);

  console.log(`\n── verify:crowsnest-spyglass-refresh-all: ${pass} passed, ${fail} failed ──`);
  if (fail > 0) {
    console.error('verify:crowsnest-spyglass-refresh-all — FAILURES');
    process.exit(1);
  }
  console.log('verify:crowsnest-spyglass-refresh-all — ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
