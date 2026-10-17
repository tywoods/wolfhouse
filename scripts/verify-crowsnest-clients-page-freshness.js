'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const CASES = Object.freeze([
  { name: 'still fresh', finalTimeMs: 59999, seedLatencyMs: 0, expectedLive: 4 },
  { name: 'exact expiry', finalTimeMs: 60000, seedLatencyMs: 0, expectedLive: 0 },
  { name: 'expired mid-join', finalTimeMs: 61000, seedLatencyMs: 0, expectedLive: 0 },
  { name: 'clock rollback', finalTimeMs: -1, seedLatencyMs: 0, expectedLive: 0 },
  { name: 'slow first health response', finalTimeMs: 61000, seedLatencyMs: 2000, expectedLive: 0 },
]);

async function runCase(testCase) {
  const start = Date.parse('2026-01-01T00:00:00Z');
  let time = start;
  let phase = 'seed';
  Date.now = () => time;
  Object.assign(process.env, {
    CROWSNEST_AUTH_REQUIRED: 'false',
    NODE_ENV: 'test',
    CROWSNEST_WOLFHOUSE_STAGING_STAFF_ORIGIN: 'https://staff-staging.lunafrontdesk.com',
    CROWSNEST_WOLFHOUSE_STAGING_STATUS_TOKEN: 'offline-wolfhouse-staging-token-0001',
    CROWSNEST_WOLFHOUSE_LIVE_STAFF_ORIGIN: 'https://wolfhouse.lunafrontdesk.com',
    CROWSNEST_WOLFHOUSE_LIVE_STATUS_TOKEN: 'offline-wolfhouse-live-token-000001',
    CROWSNEST_SUNSET_STAGING_STAFF_ORIGIN: 'https://sunset-staging.lunafrontdesk.com',
    CROWSNEST_SUNSET_STAGING_STATUS_TOKEN: 'offline-sunset-staging-token-000001',
  });
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/healthz') {
      if (phase === 'seed') {
        await Promise.resolve();
        time = start + testCase.seedLatencyMs;
      }
      return new Response(JSON.stringify({ status: 'ok', service: 'staff-api' }), {
        status: phase === 'seed' ? 200 : 503,
      });
    }
    assert.ok(parsed.pathname.startsWith('/staff/admin/'), `unrecognized fixture path ${parsed.pathname}`);
    if (phase === 'seed') return new Response('{}', { status: 200 });
    await new Promise((resolve) => setImmediate(resolve));
    time = start + testCase.finalTimeMs;
    throw new Error('offline timed-out status origin');
  };

  const { router } = require('./crowsnest-api');
  async function page() {
    const response = {
      statusCode: 0,
      headers: {},
      body: '',
      setHeader(key, value) { this.headers[key] = value; },
      writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); return this; },
      end(body) { this.body = String(body || ''); },
    };
    await router({ method: 'GET', url: '/clients', headers: { host: 'localhost' } }, response);
    assert.equal(response.statusCode, 200);
    const rows = [...response.body.matchAll(/<li class="env-row[^]*?<\/li>/g)]
      .map((match) => match[0])
      .filter((row) => row.includes('class="env-link"'));
    assert.equal(rows.length, 4);
    return rows.filter((row) => />\s*Live\s*</.test(row)).length;
  }

  assert.equal(await page(), 4, `${testCase.name}: seed must be Live`);
  phase = 'cached-near-expiry';
  time = start + 59999;
  const finalLive = await page();
  assert.equal(time, start + testCase.finalTimeMs, `${testCase.name}: fixture must reach final handoff time`);
  assert.equal(finalLive, testCase.expectedLive, `${testCase.name}: wrong Live count`);
  process.stdout.write(`PASS ${testCase.name}\n`);
}

const caseIndex = process.argv.indexOf('--case');
if (caseIndex !== -1) {
  const selected = CASES[Number(process.argv[caseIndex + 1])];
  if (!selected) throw new Error('invalid case');
  runCase(selected).catch((error) => { console.error(error); process.exit(1); });
} else {
  for (let index = 0; index < CASES.length; index += 1) {
    const child = spawnSync(process.execPath, [__filename, '--case', String(index)], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
    });
    process.stdout.write(child.stdout);
    process.stderr.write(child.stderr);
    if (child.status !== 0) process.exit(child.status || 1);
  }
}
