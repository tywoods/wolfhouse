'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ORIGINS,
  STAGING_ORIGIN,
  PROD_PRIMARY_ORIGIN,
  PROD_FALLBACK_ORIGIN,
  BOT_TOKEN_VAR,
  STAFF_SESSION_VAR,
  resolveTarget,
  createDefaultRequest,
  createReadOnlyRequest,
  execute,
} = require('./check-wolfhouse-post-deploy');

const EXPECT = 'abc1234def567890';
const OTHER = 'fffffffffff00000';
const TOKEN = 'super-secret-token-value';
const SESSION = 'super-secret-session-value';

function envWithSecrets() {
  return {
    [BOT_TOKEN_VAR]: TOKEN,
    [STAFF_SESSION_VAR]: SESSION,
  };
}

function response(status, body) {
  return {
    status,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function router(routes, origin = STAGING_ORIGIN) {
  const calls = [];
  async function request(method, url, headers) {
    calls.push({ method, url, headers });
    assert.equal(method, 'GET');
    const parsed = new URL(url);
    if (parsed.origin !== origin) {
      const err = new Error(`getaddrinfo ENOTFOUND ${parsed.hostname}`);
      err.code = 'ENOTFOUND';
      throw err;
    }
    const hit = routes[parsed.pathname];
    if (!hit) return response(404, { error: 'not_found' });
    return hit(headers || {});
  }
  return { request, calls };
}

function healthyRoutes({ sha, staffStatus = 200, simulator = true, enabled = true } = {}) {
  return {
    '/healthz': () => response(staffStatus, staffStatus === 200
      ? { status: 'ok', service: 'staff-api' }
      : { error: 'boom' }),
    '/healthz/identity': () => response(200, Object.assign({
      status: 'ok',
      service: 'staff-api',
      default_client_slug: 'wolfhouse-somo',
    }, sha ? { git_sha: sha } : {})),
    '/staff/bot/luna-intelligence': (headers) => {
      assert.equal(headers['X-Luna-Bot-Token'], TOKEN);
      assert.equal(headers.Cookie, undefined);
      return response(200, { success: true, client_slug: 'wolfhouse-somo', enabled });
    },
    '/staff/ui': (headers) => {
      assert.equal(headers.Cookie, `luna_staff_session=${SESSION}`);
      assert.equal(headers['X-Luna-Bot-Token'], undefined);
      return response(200, `<html><script>window.__STAFF_PORTAL_DEV_TABS__=${simulator ? 'true' : 'false'};</script>`);
    },
  };
}

function assertNoSecrets(output) {
  assert.equal(output.includes(TOKEN), false);
  assert.equal(output.includes(SESSION), false);
}

test('pass: health, matching sha, web search, and simulator', async () => {
  const mock = router(healthyRoutes({ sha: EXPECT, enabled: true, simulator: true }));
  const result = await execute(
    ['--env', 'staging', '--expect-sha', EXPECT],
    { env: envWithSecrets(), request: mock.request },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.rows.some((row) => row.result === 'FAIL'), false);
  const luna = result.rows.find((row) => row.check === 'luna health');
  assert.equal(luna.result, 'SKIP');
  assert.equal(luna.detail, 'not publicly exposed');
  assert.match(result.output, new RegExp(`matches ${EXPECT}`));
  assert.match(result.output, /enabled \(LUNA_BOT_INTERNAL_TOKEN\)/);
  assert.match(result.output, /ON \(LUNA_STAFF_SESSION\)/);
  assert.match(result.output, /origin https:\/\/staff-staging\.lunafrontdesk\.com/);
  assertNoSecrets(result.output);
  assert.deepEqual(mock.calls.map((call) => new URL(call.url).pathname), [
    '/healthz',
    '/healthz/identity',
    '/staff/bot/luna-intelligence',
    '/staff/ui',
  ]);
  assert.equal(mock.calls.some((call) => new URL(call.url).pathname === '/health'), false);
});

test('wrong sha fails only the version row', async () => {
  const mock = router(healthyRoutes({ sha: OTHER }));
  const result = await execute(
    ['--env', 'staging', '--expect-sha', EXPECT],
    { env: envWithSecrets(), request: mock.request },
  );
  assert.equal(result.exitCode, 1);
  const version = result.rows.find((row) => row.check === 'version');
  assert.equal(version.result, 'FAIL');
  assert.match(version.detail, new RegExp(`running ${OTHER}`));
  assert.equal(result.rows.filter((row) => row.result === 'FAIL').map((row) => row.check).join(','), 'version');
  assertNoSecrets(result.output);
});

test('staff health 500 fails the run', async () => {
  const mock = router(healthyRoutes({ sha: EXPECT, staffStatus: 500 }));
  const result = await execute(
    ['--env', 'staging', '--expect-sha', EXPECT],
    { env: envWithSecrets(), request: mock.request },
  );
  assert.equal(result.exitCode, 1);
  const staff = result.rows.find((row) => row.check === 'staff health');
  assert.equal(staff.result, 'FAIL');
  assert.match(staff.detail, /HTTP 500/);
  assert.equal(result.output.includes('boom'), false);
  assertNoSecrets(result.output);
});

test('version not exposed is reported and does not fail by itself', async () => {
  const mock = router(healthyRoutes({}));
  const result = await execute(
    ['--env', 'staging', '--expect-sha', EXPECT],
    { env: envWithSecrets(), request: mock.request },
  );
  assert.equal(result.exitCode, 0);
  const version = result.rows.find((row) => row.check === 'version');
  assert.equal(version.result, 'PASS');
  assert.equal(version.detail, 'version not exposed');
});

test('refused unknown origin makes no request', async () => {
  let called = false;
  const request = async () => {
    called = true;
    throw new Error('network');
  };
  const explicit = await execute(
    ['--env', 'staging', '--origin', 'https://evil.example', '--expect-sha', EXPECT],
    { env: envWithSecrets(), request },
  );
  const named = await execute(
    ['--env', 'https://wh.lunafrontdesk.com', '--expect-sha', EXPECT],
    { env: envWithSecrets(), request },
  );
  const positional = await execute(
    ['--env', 'prod', '--expect-sha', EXPECT, 'https://staff-staging.lunafrontdesk.com'],
    { env: envWithSecrets(), request },
  );
  for (const result of [explicit, named, positional]) {
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /refused unknown origin/);
  }
  assert.equal(called, false);
  assert.deepEqual(resolveTarget(['--env', 'prod', '--expect-sha', EXPECT]).origins, [
    PROD_PRIMARY_ORIGIN,
    PROD_FALLBACK_ORIGIN,
  ]);
  assert.equal(resolveTarget(['--env', 'production', '--expect-sha', EXPECT]).refused, true);
  const fileUrl = await execute(
    ['--env', 'prod', '--expect-sha', EXPECT, '--luna-health-url', 'file:///etc/passwd'],
    { env: envWithSecrets(), request },
  );
  assert.equal(fileUrl.exitCode, 1);
  assert.match(fileUrl.output, /refused unknown origin/);
  assert.equal(called, false);
});

test('default transport rejects writes and foreign origins before any socket', async () => {
  let called = false;
  const fakeHttps = {
    request() {
      called = true;
      throw new Error('network');
    },
  };
  const request = createDefaultRequest(PROD_FALLBACK_ORIGIN, fakeHttps);
  await assert.rejects(() => request('POST', '/healthz', {}), /refused method/);
  await assert.rejects(() => request('PUT', '/health', {}), /refused method/);
  await assert.rejects(() => request('GET', 'https://evil.example/healthz', {}), /refused unknown origin/);
  await assert.rejects(() => request('GET', '//evil.example/healthz', {}), /refused unknown origin/);
  assert.equal(called, false);

  const head = createDefaultRequest(STAGING_ORIGIN, {
    request(options, onResponse) {
      assert.equal(options.method, 'HEAD');
      assert.equal(options.hostname, 'staff-staging.lunafrontdesk.com');
      assert.equal(options.path, '/healthz');
      const res = {
        statusCode: 200,
        on(event, fn) {
          if (event === 'end') fn();
          return res;
        },
      };
      onResponse(res);
      return { on() { return this; }, end() {}, destroy() {} };
    },
  });
  const result = await head('HEAD', '/healthz', {});
  assert.equal(result.status, 200);

  const prodTransport = createReadOnlyRequest(ORIGINS.prod, { httpsImpl: fakeHttps });
  await assert.rejects(() => prodTransport('GET', 'https://evil.example/healthz', {}), /refused unknown origin/);
  await assert.rejects(() => prodTransport('POST', `${PROD_PRIMARY_ORIGIN}/healthz`, {}), /refused method/);
  assert.equal(called, false);
});

function prodRoutes(primaryHealthz) {
  return async function request(method, url, headers) {
    assert.equal(method, 'GET');
    const parsed = new URL(url);
    if (parsed.origin !== PROD_PRIMARY_ORIGIN && parsed.origin !== PROD_FALLBACK_ORIGIN) {
      const err = new Error('refused unknown origin');
      err.code = 'REFUSED_ORIGIN';
      throw err;
    }
    if (parsed.origin === PROD_PRIMARY_ORIGIN && parsed.pathname === '/healthz') {
      return primaryHealthz(parsed, headers || {});
    }
    if (parsed.pathname === '/health') {
      return response(404, { status: 'error', service: 'staff-api' });
    }
    if (parsed.pathname === '/healthz') {
      return response(200, { status: 'ok', service: 'staff-api' });
    }
    if (parsed.pathname === '/healthz/identity') {
      return response(200, { status: 'ok', service: 'staff-api', default_client_slug: 'wolfhouse-somo' });
    }
    if (parsed.pathname === '/staff/bot/luna-intelligence') {
      assert.equal(headers['X-Luna-Bot-Token'], TOKEN);
      return response(200, { success: true, client_slug: 'wolfhouse-somo', enabled: false });
    }
    if (parsed.pathname === '/staff/ui') {
      assert.equal(headers.Cookie, `luna_staff_session=${SESSION}`);
      return response(200, '<script>window.__STAFF_PORTAL_DEV_TABS__=false;</script>');
    }
    return response(404, { error: 'not_found' });
  };
}

test('prod falls back when the primary does not answer and skips public Luna health', async () => {
  const calls = [];
  const request = async (method, url, headers) => {
    calls.push(url);
    if (new URL(url).origin === PROD_PRIMARY_ORIGIN) {
      const err = new Error('getaddrinfo ENOTFOUND admin.wolf-house.com');
      err.code = 'ENOTFOUND';
      throw err;
    }
    return prodRoutes(() => response(500, { error: 'primary' }))(method, url, headers);
  };
  const result = await execute(
    ['--env', 'prod', '--expect-sha', EXPECT],
    { env: envWithSecrets(), request },
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.output, new RegExp(`origin ${PROD_FALLBACK_ORIGIN.replace(/[.]/g, '\\.')}`));
  assert.match(result.output, /fallback; https:\/\/admin\.wolf-house\.com did not answer/);
  const luna = result.rows.find((row) => row.check === 'luna health');
  assert.equal(luna.result, 'SKIP');
  assert.equal(luna.detail, 'not publicly exposed');
  const version = result.rows.find((row) => row.check === 'version');
  assert.equal(version.result, 'PASS');
  assert.equal(version.detail, 'version not exposed');
  assert.equal(calls.some((url) => url === `${PROD_PRIMARY_ORIGIN}/healthz`), true);
  assert.equal(calls.some((url) => url === `${PROD_FALLBACK_ORIGIN}/healthz`), true);
  assert.equal(calls.some((url) => new URL(url).pathname === '/health'), false);
  assertNoSecrets(result.output);
});

test('prod stays on the primary when it answers', async () => {
  const calls = [];
  const request = async (method, url, headers) => {
    calls.push(url);
    return prodRoutes(() => response(200, { status: 'ok', service: 'staff-api' }))(method, url, headers);
  };
  const result = await execute(
    ['--env', 'prod', '--expect-sha', EXPECT],
    { env: envWithSecrets(), request },
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.output, new RegExp(`origin ${PROD_PRIMARY_ORIGIN.replace(/[.]/g, '\\.')}$`, 'm'));
  assert.equal(result.output.includes('fallback'), false);
  assert.equal(calls.some((url) => url.startsWith(PROD_FALLBACK_ORIGIN)), false);
  assert.equal(calls.some((url) => new URL(url).pathname === '/health'), false);
  const luna = result.rows.find((row) => row.check === 'luna health');
  assert.equal(luna.result, 'SKIP');
});

test('optional luna health URL is a GET and can fail on its own', async () => {
  const lunaUrl = 'http://127.0.0.1:8090/health';
  const calls = [];
  const request = async (method, url, headers) => {
    calls.push({ method, url, headers });
    assert.equal(method, 'GET');
    if (url === lunaUrl) {
      assert.equal(headers['X-Luna-Bot-Token'], undefined);
      assert.equal(headers.Cookie, undefined);
      return response(200, { ok: true });
    }
    const parsed = new URL(url);
    assert.equal(parsed.origin, STAGING_ORIGIN);
    const hit = healthyRoutes({ sha: EXPECT })[parsed.pathname];
    return hit(headers || {});
  };
  const ok = await execute(
    ['--env', 'staging', '--expect-sha', EXPECT, '--luna-health-url', lunaUrl],
    { env: envWithSecrets(), request },
  );
  assert.equal(ok.exitCode, 0);
  const luna = ok.rows.find((row) => row.check === 'luna health');
  assert.equal(luna.result, 'PASS');
  assert.match(luna.detail, /HTTP 200/);
  assert.equal(calls.some((call) => call.url === lunaUrl), true);
  assertNoSecrets(ok.output);

  const failing = await execute(
    ['--env', 'staging', '--expect-sha', EXPECT, '--luna-health-url', lunaUrl],
    {
      env: envWithSecrets(),
      request: async (method, url, headers) => {
        if (url === lunaUrl) return response(500, { error: TOKEN });
        return request(method, url, headers);
      },
    },
  );
  assert.equal(failing.exitCode, 1);
  assert.equal(failing.rows.find((row) => row.check === 'luna health').result, 'FAIL');
  assert.equal(failing.output.includes(TOKEN), false);
});
