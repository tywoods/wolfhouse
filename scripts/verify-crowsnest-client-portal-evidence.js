'use strict';

// Offline only. Health responses below are synthetic, not live observations.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { getCrowsnestClients } = require('./lib/crowsnest/crowsnest-clients');
const MODULE = path.join(__dirname, 'lib/crowsnest/crowsnest-client-portal-evidence.js');
const HEALTH = JSON.stringify({ status: 'ok', service: 'staff-api' });
const URLS = [
  'https://staff-staging.lunafrontdesk.com/healthz',
  'https://sunset-staging.lunafrontdesk.com/healthz',
  'https://wolfhouse.lunafrontdesk.com/healthz',
  'https://sunset.lunafrontdesk.com/healthz',
];
function clientsFor(environment) {
  const admitted = URLS.slice(environment === 'staging' ? 0 : 2, environment === 'staging' ? 2 : 4);
  return getCrowsnestClients().map((client) => ({ ...client,
    environments: client.environments.filter((row) => admitted.includes(`${row.url}/healthz`)),
  }));
}
function admittedEvidence(result) {
  return ['wolfhouse-somo', 'sunset-somo'].flatMap((id) => ['staging', 'production'].map((env) => result[id][env]));
}
let passed = 0;
// Used explicitly by the auth verifier's child process: no live probes.
function installOfflineHealthTransport() {
  global.fetch = async (url, options) => {
    assert.ok(URLS.includes(url), `unexpected offline-gate network target: ${url}`);
    assert.equal(options.method, 'GET');
    assert.deepEqual(options.headers, { accept: 'application/json' });
    return new Response(HEALTH);
  };
}
async function test(name, run) {
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}

async function main() {
  await test('all four admitted staging and production health mocks project Live independently', async () => {
    assert.ok(fs.existsSync(MODULE), 'portal evidence collector must exist');
    const { createCrowsnestClientPortalEvidenceCollector } = require(MODULE);
    const calls = [];
    const collect = createCrowsnestClientPortalEvidenceCollector({
      now: () => Date.parse('2026-01-01T00:00:00Z'),
      transport: async (url, options) => {
        calls.push(url);
        assert.ok(URLS.includes(url), 'no unapproved/provider/write request');
        assert.equal(options.method, 'GET');
        assert.equal(options.redirect, 'error');
        assert.equal(options.credentials, 'omit');
        assert.deepEqual(options.headers, { accept: 'application/json' });
        assert.ok(options.signal instanceof AbortSignal);
        return new Response(HEALTH);
      },
    });
    const result = await collect(getCrowsnestClients());
    assert.deepEqual(calls.sort(), [...URLS].sort());
    for (const id of ['wolfhouse-somo', 'sunset-somo']) {
      assert.deepEqual(result[id].staging, {
        availability: 'live', checked_at: '2026-01-01T00:00:00.000Z',
        source_kind: 'staff_healthz', reason: 'canonical_healthz_ok',
      });
      assert.deepEqual(result[id].production, result[id].staging);
    }
    assert.equal(result['sunset-sardinero'].staging.availability, 'unknown');
    assert.equal(result['sunset-sardinero'].staging.checked_at, null);
  });
  const { createCrowsnestClientPortalEvidenceCollector } = require(MODULE);
  await test('only exact canonical 200 JSON is Live; errors/redirects/oversized streams stay Unknown', async () => {
    const cases = [
      ...[201, 301, 302, 401, 403, 404, 500, 503].map((status) => () => new Response(HEALTH, { status })),
      () => new Response('<html>unavailable</html>'),
      () => new Response('{'),
      ...[null, [], { status: 'ok', service: 'other' }, { status: 'bad', service: 'staff-api' },
        { status: 'ok', service: 'staff-api', tenant: 'sunset' }].map((body) => () => new Response(JSON.stringify(body))),
      () => new Response(` ${HEALTH}${' '.repeat(4096)}`),
      () => new Response(new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode(HEALTH));
        c.enqueue(new TextEncoder().encode(' '.repeat(4096)));
        c.close();
      } })),
      () => ({ status: 200, redirected: true, body: new Response(HEALTH).body }),
      () => { throw new Error('TLS/DNS failure with sensitive diagnostics'); },
    ];
    for (const response of cases) {
      const collect = createCrowsnestClientPortalEvidenceCollector({ transport: async () => response() });
      for (const evidence of admittedEvidence(await collect(getCrowsnestClients()))) {
        assert.equal(evidence.availability, 'unknown');
        assert.ok(evidence.checked_at);
        assert.equal(evidence.source_kind, 'staff_healthz');
        assert.ok(!JSON.stringify(evidence).includes('sensitive'));
      }
    }
    const exactLimit = createCrowsnestClientPortalEvidenceCollector({
      transport: async () => new Response(HEALTH.padEnd(4096, ' ')),
    });
    assert.ok(admittedEvidence(await exactLimit(getCrowsnestClients())).every((e) => e.availability === 'live'));
  });
  await test('three-second ceiling bounds headers AND stalled body; timeout aborts and has no retry', async () => {
    for (const stallBody of [false, true]) {
      let calls = 0;
      const signals = [];
      const collect = createCrowsnestClientPortalEvidenceCollector({ timeoutMs: 15,
        transport: async (_url, options) => {
          calls += 1;
          signals.push(options.signal);
          return stallBody ? new Response(new ReadableStream({ start() {} })) : new Promise(() => {});
        },
      });
      const result = await collect(getCrowsnestClients());
      assert.equal(calls, 4);
      assert.ok(signals.every((signal) => signal.aborted));
      for (const evidence of admittedEvidence(result)) {
        assert.equal(evidence.reason, 'timeout');
        assert.equal(evidence.availability, 'unknown');
      }
    }
  });
  await test('60s exact-source cache coalesces parallel reads, expires Live, and never serves stale on failure', async () => {
    let time = Date.parse('2026-01-01T00:00:00Z');
    let failWolfhouse = false;
    const calls = [];
    const collect = createCrowsnestClientPortalEvidenceCollector({ now: () => time,
      transport: async (url) => { calls.push(url); return new Response(HEALTH, { status: failWolfhouse && url === URLS[0] ? 503 : 200 }); },
    });
    const [first, second] = await Promise.all([collect(getCrowsnestClients()), collect(getCrowsnestClients())]);
    assert.equal(calls.length, 4, 'at most one in-flight request per admitted source');
    assert.deepEqual(first, second);
    time += 59999;
    assert.deepEqual(await collect(getCrowsnestClients()), first);
    assert.equal(calls.length, 4);
    time += 1;
    failWolfhouse = true;
    const refreshed = await collect(getCrowsnestClients());
    assert.equal(calls.length, 8);
    assert.equal(refreshed['wolfhouse-somo'].staging.availability, 'unknown');
    assert.equal(refreshed['sunset-somo'].staging.availability, 'live');
    assert.notEqual(refreshed['wolfhouse-somo'].staging.checked_at, first['wolfhouse-somo'].staging.checked_at);
    time -= 1;
    await collect(getCrowsnestClients());
    assert.equal(calls.length, 12, 'clock rollback invalidates cache');
  });
  await test('request-start expiry survives health latency and clock rollback at page handoff in both environments', async () => {
    const startedAt = Date.parse('2026-01-01T00:00:00Z');
    for (const environment of ['staging', 'production']) {
      const clients = clientsFor(environment);
      const urls = clients.slice(0, 2).map((client) => `${client.environments[0].url}/healthz`);
      for (const handedOffAt of [startedAt + 61999, startedAt + 60000, startedAt - 1]) {
        let time = startedAt;
        const calls = [];
        const collect = createCrowsnestClientPortalEvidenceCollector({ now: () => time,
          transport: async (url) => {
            calls.push(url);
            if (url === urls[0]) time += 2000; // Initial health response latency.
            if (url === urls[1]) time = handedOffAt;
            return new Response(HEALTH);
          },
        });
        const first = await collect([clients[0]]);
        const initial = first['wolfhouse-somo'][environment];
        assert.equal(initial.availability, 'live');
        assert.equal(initial.checked_at, new Date(startedAt + 2000).toISOString());
        time = startedAt + 59999;
        assert.deepEqual((await collect([clients[0]]))['wolfhouse-somo'][environment], initial);
        const evidence = await collect(clients);
        assert.deepEqual(calls, urls, 'the first source is cached; only the second source loads');
        assert.deepEqual(evidence['wolfhouse-somo'][environment], {
          availability: 'unknown', checked_at: initial.checked_at,
          source_kind: 'staff_healthz', reason: 'evidence_expired',
        });
        assert.equal(evidence['sunset-somo'][environment].availability, handedOffAt < startedAt ? 'unknown' : 'live');
        for (const id of ['wolfhouse-somo', 'sunset-somo']) {
          assert.deepEqual(Reflect.ownKeys(evidence[id][environment]).sort(), ['availability', 'checked_at', 'reason', 'source_kind']);
          assert.equal(evidence[id][environment === 'staging' ? 'production' : 'staging'].availability, 'unknown');
        }
      }
    }
  });
  await test('each production source loses cached Live on failed refresh without borrowing staging or sibling Live', async () => {
    const failures = [
      () => new Response('<html>404 Azure Unavailable</html>', { status: 404 }),
      () => new Response(HEALTH, { status: 503 }),
      () => { throw new Error('fixture transport failure'); },
      () => new Promise(() => {}),
    ];
    for (const [index, id] of ['wolfhouse-somo', 'sunset-somo'].entries()) {
      for (const failure of failures) {
        let time = Date.parse('2026-01-01T00:00:00Z');
        let failing = false;
        const calls = [];
        const collect = createCrowsnestClientPortalEvidenceCollector({ now: () => time, timeoutMs: 15,
          transport: async (url) => {
            calls.push(url);
            return failing && url === URLS[index + 2] ? failure() : new Response(HEALTH);
          },
        });
        assert.ok(admittedEvidence(await collect(getCrowsnestClients())).every((e) => e.availability === 'live'));
        failing = true;
        time += 60000;
        const result = await collect(getCrowsnestClients());
        assert.equal(result[id].production.availability, 'unknown');
        assert.equal(result[id].staging.availability, 'live');
        assert.equal(result[id === 'wolfhouse-somo' ? 'sunset-somo' : 'wolfhouse-somo'].production.availability, 'live');
        assert.equal(calls.length, 8, 'exactly one read per source per expiry; no retries');
        assert.equal((await collect(getCrowsnestClients()))[id].production.availability, 'unknown');
        assert.equal(calls.length, 8, 'failed refresh replaces old cached Live');
        time -= 1;
        assert.equal((await collect(getCrowsnestClients()))[id].production.availability, 'unknown');
        assert.equal(calls.length, 12, 'clock rollback cannot resurrect old Live');
      }
    }
  });
  await test('unapproved origin/client/environment or Planned/absent source cannot borrow a cached Live', async () => {
    let calls = 0;
    const collect = createCrowsnestClientPortalEvidenceCollector({ transport: async () => { calls += 1; return new Response(HEALTH); } });
    await collect(getCrowsnestClients());
    for (const environment of ['staging', 'production']) {
      for (const mutate of [
        (client) => { client.environments[0].url = 'https://evil.example'; },
        (client) => { client.environments[0].url = client.environments[0].url.replace('https:', 'http:'); },
        (client) => { client.environments[0].url += '/other'; },
        (client) => { client.environments[0].environment = environment === 'staging' ? 'production' : 'staging'; },
        (client) => { client.client_slug = 'sunset'; },
        (client) => { client.id = 'unknown-client'; },
        (client) => { client.status = 'Planned'; },
        (client) => { client.environments = []; },
      ]) {
        const client = clientsFor(environment)[0];
        mutate(client);
        const result = await collect([client]);
        for (const env of ['staging', 'production']) {
          assert.equal(result[client.id][env].availability, 'unknown');
          assert.equal(result[client.id][env].checked_at, null);
        }
      }
    }
    assert.equal(calls, 4, 'no disallowed reads even after warming the cache');
    assert.deepEqual(await collect([]), {});
  });
  await test('ordinary authenticated /clients passes admitted evidence to the real renderer; denial/HEAD/other pages do not probe', async () => {
    const http = require('http');
    const page = require('./lib/crowsnest/crowsnest-page');
    const originalRender = page.renderCrowsnestPage;
    const originalFetch = global.fetch;
    const savedEnv = { ...process.env };
    const rendered = [];
    const calls = [];
    const originalNow = Date.now;
    let time = originalNow();
    let wolfhouseDown = true;
    let sunsetDown = false;
    Date.now = () => time;
    let server;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('CROWSNEST_') || key.includes('DATABASE_URL')) delete process.env[key];
    }
    Object.assign(process.env, {
      NODE_ENV: 'test', CROWSNEST_AUTH_REQUIRED: 'true',
      CROWSNEST_AUTH_USERNAME: 'offline-operator', CROWSNEST_AUTH_PASSWORD: 'offline-fixture-password',
    });
    global.fetch = async (url, options) => {
      calls.push(url);
      assert.ok(URLS.includes(url), 'provider/model/write/unapproved network sentinel');
      assert.equal(options.method, 'GET');
      assert.deepEqual(options.headers, { accept: 'application/json' });
      if (wolfhouseDown && url === URLS[2]) return new Response('<html>404 Azure Unavailable</html>', { status: 404 });
      if (sunsetDown && url === URLS[3]) return new Response(HEALTH, { status: 503 });
      return new Response(HEALTH);
    };
    page.renderCrowsnestPage = (options) => { rendered.push(options); return originalRender(options); };
    const apiPath = require.resolve('./crowsnest-api');
    delete require.cache[apiPath];
    try {
      ({ server } = require(apiPath));
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const request = (route, { authorized = true, method = 'GET' } = {}) => new Promise((resolve, reject) => {
        const headers = authorized ? { authorization: `Basic ${Buffer.from('offline-operator:offline-fixture-password').toString('base64')}` } : {};
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: route, method, headers }, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal((await request('/clients', { authorized: false })).status, 302);
      assert.equal((await request('/clients', { method: 'HEAD' })).status, 200);
      assert.equal((await request('/billing')).status, 200);
      assert.equal(calls.length, 0);
      const response = await request('/clients?origin=https://evil.example&availability=live&environment=production');
      assert.equal(response.status, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      const options = rendered.at(-1);
      assert.ok(options.portalEvidence, 'ordinary Clients route must pass portalEvidence');
      assert.equal(options.portalEvidence['wolfhouse-somo'].staging.availability, 'live');
      assert.equal(options.portalEvidence['sunset-somo'].staging.availability, 'live');
      assert.equal(options.portalEvidence['wolfhouse-somo']['https://staff-staging.lunafrontdesk.com'], 'live', 'Slice A URL-keyed compatibility seam');
      assert.equal(options.portalEvidence['sunset-somo']['https://sunset-staging.lunafrontdesk.com'], 'live');
      assert.equal(options.portalEvidence['wolfhouse-somo']['https://wolfhouse.lunafrontdesk.com'], 'unknown', '404 never yields a Live alias');
      assert.equal(options.portalEvidence['wolfhouse-somo'].production.availability, 'unknown');
      assert.equal(options.portalEvidence['sunset-somo'].production.availability, 'live');
      const portalRows = response.body.match(/<li class="env-row\b[\s\S]*?<\/li>/g) || [];
      for (const origin of [URLS[0], URLS[1], URLS[3]].map((url) => url.replace('/healthz', ''))) {
        const row = portalRows.find((html) => html.includes(`href="${origin}"`));
        assert.ok(row && row.includes('</span>Live</span>'), 'real renderer shows staging and Sunset production Live from mocks');
      }
      for (const origin of ['https://wolfhouse.lunafrontdesk.com']) {
        const row = portalRows.find((html) => html.includes(`href="${origin}"`));
        assert.ok(row && row.includes('</span>Unknown</span>') && !row.includes('</span>Live</span>'), 'Wolfhouse 404 renders Unknown, never Live');
      }
      assert.equal(options.clientStatuses['wolfhouse-somo'].staging.Email, 'Unknown', 'portal Live is not integration evidence');
      assert.deepEqual(calls.sort(), [...URLS].sort());
      await request('/clients');
      assert.equal(calls.length, 4, 'ordinary route uses the shared bounded cache');
      time += 60000;
      sunsetDown = true;
      const failed = await request('/clients');
      const failedRows = failed.body.match(/<li class="env-row\b[\s\S]*?<\/li>/g) || [];
      for (const origin of URLS.slice(2).map((url) => url.replace('/healthz', ''))) {
        const row = failedRows.find((html) => html.includes(`href="${origin}"`));
        assert.ok(row && row.includes('</span>Unknown</span>') && !row.includes('</span>Live</span>'), 'failed production cannot retain rendered Live');
      }
      assert.equal(calls.length, 8);
      time += 60000;
      wolfhouseDown = false;
      sunsetDown = false;
      const recovered = await request('/clients');
      const recoveredRows = recovered.body.match(/<li class="env-row\b[\s\S]*?<\/li>/g) || [];
      for (const origin of URLS.slice(2).map((url) => url.replace('/healthz', ''))) {
        const row = recoveredRows.find((html) => html.includes(`href="${origin}"`));
        assert.ok(row && row.includes('</span>Live</span>'), 'both production rows can recover from successful probes');
      }
      assert.equal(calls.length, 12);
    } finally {
      if (server && server.listening) await new Promise((resolve) => server.close(resolve));
      Date.now = originalNow;
      global.fetch = originalFetch;
      page.renderCrowsnestPage = originalRender;
      delete require.cache[apiPath];
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
      Object.assign(process.env, savedEnv);
    }
  });
  await test('directory build validation rejects absent, malformed, normalized-overflow and future metadata', async () => {
    const { validateCrowsnestDirectoryBuild } = require('./crowsnest-api');
    assert.equal(typeof validateCrowsnestDirectoryBuild, 'function', 'server must validate immutable directory metadata');
    const now = Date.parse('2026-01-02T00:00:00Z');
    const valid = { sha: 'a'.repeat(40), built_at: '2026-01-01T00:00:00Z' };
    assert.deepEqual(validateCrowsnestDirectoryBuild(valid, now), { sha: valid.sha, built_at: '2026-01-01T00:00:00.000Z' });
    for (const value of [null, {}, [], { ...valid, sha: 'a'.repeat(7) },
      { ...valid, sha: '<script>alert(1)</script>' }, { ...valid, sha: 'a'.repeat(40) + '\n' },
      { ...valid, built_at: 'now' }, { ...valid, built_at: '2026-01-01' },
      { ...valid, built_at: '2026-01-01T00:00:00+00:00' },
      { ...valid, built_at: '2025-02-30T00:00:00Z' },
      { ...valid, built_at: '2099-01-01T00:00:00Z' },
      { sha: valid.sha }, { built_at: valid.built_at },
    ]) assert.equal(validateCrowsnestDirectoryBuild(value, now), null);
    assert.ok(Object.isFrozen(validateCrowsnestDirectoryBuild(valid, now)));
  });
  await test('Docker build args write an artifact stamp, not runtime env or current-time fallback', async () => {
    const { execFileSync } = require('child_process');
    const os = require('os');
    const dockerfile = fs.readFileSync(path.join(__dirname, '../Dockerfile.crowsnest'), 'utf8');
    for (const key of ['CROWSNEST_BUILD_SHA', 'CROWSNEST_BUILT_AT']) assert.match(dockerfile, new RegExp(`^ARG ${key}$`, 'm'));
    const command = dockerfile.match(/^RUN node -e "(.+)"$/m);
    assert.ok(command, 'Dockerfile must persist build inputs in the artifact');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crowsnest-build-gate-'));
    try {
      execFileSync(process.execPath, ['-e', command[1]], { cwd: dir, env: {
        ...process.env, CROWSNEST_BUILD_SHA: 'b'.repeat(40), CROWSNEST_BUILT_AT: '2026-01-01T00:00:00Z',
      } });
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'crowsnest-build.json'), 'utf8')), {
        sha: 'b'.repeat(40), built_at: '2026-01-01T00:00:00Z',
      });
      assert.equal(fs.statSync(path.join(dir, 'crowsnest-build.json')).mode & 0o777, 0o444);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  await test('artifact stamp reaches Clients unchanged on reload/restart; newer image/rollback/missing are honest', async () => {
    const page = require('./lib/crowsnest/crowsnest-page');
    const originalRender = page.renderCrowsnestPage;
    const originalRead = fs.readFileSync;
    const originalFetch = global.fetch;
    const savedEnv = { ...process.env };
    const apiPath = require.resolve('./crowsnest-api');
    const stampPath = path.join(__dirname, '../crowsnest-build.json');
    const old = { sha: 'a'.repeat(40), built_at: '2025-01-01T00:00:00.000Z' };
    const newer = { sha: 'b'.repeat(40), built_at: '2025-02-01T00:00:00.000Z' };
    let raw;
    let captured;
    fs.readFileSync = (file, ...args) => {
      if (String(file) !== stampPath) return originalRead(file, ...args);
      if (raw === undefined) throw new Error('fixture ENOENT');
      return raw;
    };
    page.renderCrowsnestPage = (options) => { captured = options; return originalRender(options); };
    global.fetch = async (url) => { assert.ok(URLS.includes(url)); return new Response(HEALTH); };
    for (const key of Object.keys(process.env)) if (key.startsWith('CROWSNEST_') || key.includes('DATABASE_URL')) delete process.env[key];
    Object.assign(process.env, { NODE_ENV: 'test', CROWSNEST_AUTH_REQUIRED: 'true',
      CROWSNEST_AUTH_USERNAME: 'offline-operator', CROWSNEST_AUTH_PASSWORD: 'offline-fixture-password',
      CROWSNEST_BUILD_SHA: newer.sha, CROWSNEST_BUILT_AT: newer.built_at,
    });
    const request = async (api) => {
      let status;
      const req = { method: 'GET', url: '/clients?built_at=2099-01-01&sha=evil', headers: {
        host: 'localhost', authorization: `Basic ${Buffer.from('offline-operator:offline-fixture-password').toString('base64')}`,
      } };
      await api.router(req, { writeHead(code) { status = code; }, end() {} });
      assert.equal(status, 200);
      return captured.directoryBuild;
    };
    try {
      for (const fixture of [old, old, newer, old, undefined, 'malformed', { sha: old.sha, built_at: '2099-01-01T00:00:00Z' }]) {
        raw = fixture === undefined ? undefined : fixture === 'malformed' ? '{' : JSON.stringify(fixture);
        delete require.cache[apiPath];
        const api = require(apiPath); // process-start equivalent: re-read the artifact, no listener
        const expected = fixture === old || fixture === newer ? fixture : null;
        assert.deepEqual(await request(api), expected, 'validated build stamp is a Clients page option');
        raw = JSON.stringify(newer); // request-time file/env changes are not a new artifact
        process.env.CROWSNEST_BUILT_AT = '2099-01-01T00:00:00Z';
        assert.deepEqual(await request(api), expected);
      }
    } finally {
      fs.readFileSync = originalRead;
      page.renderCrowsnestPage = originalRender;
      global.fetch = originalFetch;
      delete require.cache[apiPath];
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
      Object.assign(process.env, savedEnv);
    }
  });
  console.log(`portal-evidence: ${passed} passed, 0 failed (offline health mocks)`);
}

if (require.main === module) main().catch((err) => { console.error(err); process.exitCode = 1; });
module.exports = { installOfflineHealthTransport };
