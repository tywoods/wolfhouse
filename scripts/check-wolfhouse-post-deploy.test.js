'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ORIGINS,
  BOT_TOKEN_VAR,
  STAFF_SESSION_VAR,
  resolveTarget,
  createDefaultRequest,
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

function router(routes) {
  const calls = [];
  async function request(method, url, headers) {
    calls.push({ method, url, headers });
    assert.equal(method, 'GET');
    const parsed = new URL(url);
    assert.equal(parsed.origin, ORIGINS.staging);
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
    '/health': () => response(200, sha ? { ok: true, git_sha: sha } : { ok: true }),
    '/healthz/identity': () => response(200, {
      status: 'ok',
      service: 'staff-api',
      default_client_slug: 'wolfhouse-somo',
    }),
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
  assert.equal(result.rows.every((row) => row.result === 'PASS'), true);
  assert.match(result.output, new RegExp(`matches ${EXPECT}`));
  assert.match(result.output, /enabled \(LUNA_BOT_INTERNAL_TOKEN\)/);
  assert.match(result.output, /ON \(LUNA_STAFF_SESSION\)/);
  assert.match(result.output, /origin https:\/\/staff-staging\.lunafrontdesk\.com/);
  assertNoSecrets(result.output);
  assert.deepEqual(mock.calls.map((call) => new URL(call.url).pathname), [
    '/healthz',
    '/health',
    '/healthz/identity',
    '/staff/bot/luna-intelligence',
    '/staff/ui',
  ]);
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
  assert.equal(resolveTarget(['--env', 'prod', '--expect-sha', EXPECT]).origin, ORIGINS.prod);
  assert.equal(resolveTarget(['--env', 'production', '--expect-sha', EXPECT]).refused, true);
});

test('default transport rejects writes and foreign origins before any socket', async () => {
  let called = false;
  const fakeHttps = {
    request() {
      called = true;
      throw new Error('network');
    },
  };
  const request = createDefaultRequest(ORIGINS.prod, fakeHttps);
  await assert.rejects(() => request('POST', '/healthz', {}), /refused method/);
  await assert.rejects(() => request('PUT', '/health', {}), /refused method/);
  await assert.rejects(() => request('GET', 'https://evil.example/healthz', {}), /refused unknown origin/);
  await assert.rejects(() => request('GET', '//evil.example/healthz', {}), /refused unknown origin/);
  assert.equal(called, false);

  const head = createDefaultRequest(ORIGINS.staging, {
    request(options, onResponse) {
      assert.equal(options.method, 'HEAD');
      assert.equal(options.hostname, 'staff-staging.lunafrontdesk.com');
      assert.equal(options.path, '/health');
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
  const result = await head('HEAD', '/health', {});
  assert.equal(result.status, 200);
});
