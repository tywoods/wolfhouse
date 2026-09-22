#!/usr/bin/env node
'use strict';

// Real HTTP router, cookie hashing, auth SQL and pool-release owner. Only the
// Postgres transport is fake; no session/ACL resolver bypass and no live services.
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

for (const key of Object.keys(process.env)) {
  if (/^(STAFF_|LUNA_|STRIPE_|BOT_|META_|WOLFHOUSE_|DATABASE_URL)/.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  NODE_ENV: 'test', STAFF_RUNTIME_PROFILE: 'test', STAFF_AUTH_REQUIRED: 'true',
  STAFF_AUTH_HTTPS: 'false', STAFF_QUERY_API_HOST: '127.0.0.1',
  STAFF_API_FORTRESS_OFFLINE_LISTENER: '1', DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
});
require('dotenv').config = () => ({ parsed: {} });
const pg = require('./lib/pg-connect');
const api = require('./staff-query-api');
const TOKEN = 'offline-session-recovery-fixture';
const HASH = crypto.createHash('sha256').update(TOKEN).digest('hex');
const USER = {
  staff_user_id: '00000000-0000-4000-8000-000000000001',
  session_id: '00000000-0000-4000-8000-000000000002',
  client_id: '00000000-0000-4000-8000-000000000003',
  client_slug: 'wolfhouse-somo', email: 'operator.stage72c@example.test',
  role: 'viewer', status: 'active', metadata: {},
};
const CALENDAR = '/staff/bed-calendar?client=wolfhouse-somo&start=2026-09-22&end=2026-10-22';

function installPool({ readErrors = [], connectErrors = [], user = USER, touchError = null, businessError = null } = {}) {
  const state = { checkouts: 0, reads: 0, touches: 0, businessQueries: 0, releases: [] };
  pg._setPoolForTests({
    async connect() {
      const checkout = ++state.checkouts;
      const connectError = connectErrors.shift();
      if (connectError) throw connectError;
      return {
        async query(sql, params) {
          if (sql.includes('FROM auth_sessions s')) {
            state.reads++;
            assert.deepEqual(params, [HASH], 'session token must be hashed');
            assert.match(sql, /s\.revoked_at IS NULL/);
            assert.match(sql, /s\.expires_at > NOW\(\)/);
            assert.match(sql, /su\.status\s*= 'active'/);
            const error = readErrors.shift();
            if (error) throw error;
            return { rows: user ? [user] : [] };
          }
          if (sql.startsWith('UPDATE auth_sessions SET last_seen_at')) {
            state.touches++;
            assert.deepEqual(params, [USER.session_id]);
            if (touchError) throw touchError;
            return { rows: [] };
          }
          // Calendar uses SELECT-only SQL against explicitly empty fixture data.
          assert.match(sql.trim(), /^(SELECT|WITH)\b/i);
          state.businessQueries++;
          if (businessError) throw businessError;
          return { rows: [] };
        },
        release(discard) { state.releases.push({ checkout, discard: discard === true }); },
      };
    },
  });
  return state;
}

function request({ path = CALENDAR, cookie = `${api.COOKIE_NAME}=${TOKEN}`, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: api.server.address().port,
      path, method, headers: cookie ? { Cookie: cookie } : {},
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw), headers: res.headers }));
    });
    req.setTimeout(3000, () => req.destroy(new Error('offline request timeout')));
    req.on('error', reject);
    req.end();
  });
}

function dbError(code, message = 'private-dsn-and-token') {
  return Object.assign(new Error(message), code ? { code } : {});
}

async function checkScenario(label, options, expected, reqOptions) {
  const state = installPool(options);
  const diagnostics = [];
  const originalWarn = console.warn;
  console.warn = line => diagnostics.push(JSON.parse(line));
  let res;
  try { res = await request(reqOptions); }
  finally { console.warn = originalWarn; }
  assert.equal(res.status, expected.status, `${label}: ${JSON.stringify(res.body)}`);
  assert.equal(state.reads, expected.reads, `${label}: reads`);
  assert.equal(state.checkouts, expected.checkouts, `${label}: checkouts`);
  assert.equal(state.touches, expected.touches, `${label}: touches`);
  assert.equal(state.releases.filter(r => r.discard).length, expected.discards || 0, `${label}: discards`);
  if (expected.businessFailure) assert.ok(state.businessQueries > 0, 'calendar query attempted');
  else if (res.status !== 200) assert.equal(state.businessQueries, 0, `${label}: unauthorized data access`);
  else {
    assert.equal(res.body.success, true);
    assert.equal(res.body.client_slug, 'wolfhouse-somo');
    assert.equal(res.body.days.length, 30);
    assert.ok(state.businessQueries > 0);
  }
  assert.equal(diagnostics.length, expected.errors || 0, `${label}: diagnostic count`);
  for (let i = 0; i < diagnostics.length; i++) {
    const record = diagnostics[i];
    assert.deepEqual(Object.keys(record).sort(), ['event', 'request_id', 'stage', 'error_code', 'attempt', 'retrying'].sort());
    assert.equal(record.event, 'staff_auth_session_lookup_error');
    assert.equal(record.request_id, res.headers['x-request-id']);
    assert.equal(record.attempt, i + 1);
    assert.equal(record.retrying, i === 0 && expected.retry === true);
    if (expected.stage) assert.equal(record.stage, expected.stage);
    if (expected.errorCode) assert.equal(record.error_code, expected.errorCode);
  }
  assert.ok(!JSON.stringify(diagnostics).includes('private-dsn-and-token'));
  assert.ok(!JSON.stringify(diagnostics).includes(TOKEN));
  assert.ok(!JSON.stringify(diagnostics).includes(HASH));
  assert.ok(!res.headers['set-cookie'], 'recovery must not change cookie or session lifetime');
  console.log(`PASS: ${label}`);
}

async function main() {
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
  try {
    const state = installPool({ readErrors: [Object.assign(new Error('read reset'), { code: 'ECONNRESET' })] });
    const res = await request();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(state.reads, 2, 'one fresh session lookup retry');
    assert.equal(state.touches, 1, 'touch only after verified read');
    assert.ok(state.businessQueries > 0, 'real calendar handler executes');
    assert.deepEqual(state.releases.slice(0, 2), [
      { checkout: 1, discard: true }, { checkout: 2, discard: false },
    ], 'broken connection discarded before fresh checkout');
    console.log('PASS: reset during auth SELECT recovers inside one calendar HTTP request');

    const diagnostics = [];
    const originalWarn = console.warn;
    console.warn = line => diagnostics.push(JSON.parse(line));
    let failed;
    try {
      installPool({ connectErrors: [Object.assign(new Error('private-dsn-and-token'), { code: '42703' })] });
      failed = await request();
    } finally { console.warn = originalWarn; }
    assert.equal(failed.status, 500);
    assert.deepEqual(diagnostics, [{
      event: 'staff_auth_session_lookup_error', request_id: failed.headers['x-request-id'],
      stage: 'connect', error_code: '42703', attempt: 1, retrying: false,
    }], 'failure emits bounded, correlated diagnostics without raw error messages');
    assert.ok(!JSON.stringify(diagnostics).includes('private-dsn-and-token'));
    console.log('PASS: diagnostic code and request ID survive without secrets');

    await checkScenario('healthy lookup needs no retry', {},
      { status: 200, reads: 1, checkouts: 2, touches: 1 });
    await checkScenario('calendar query errors do not replay auth or the handler',
      { businessError: dbError('ECONNRESET', 'calendar query unavailable') },
      { status: 500, reads: 1, checkouts: 2, touches: 1, businessFailure: true });
    const transientErrors = [
      ...['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', '08000', '08003', '08006', '57P01', '57P02', '57P03'].map(code => dbError(code)),
      ...['Connection terminated unexpectedly', 'Connection terminated',
        'Connection terminated due to connection timeout', 'timeout exceeded when trying to connect'].map(message => dbError(null, message)),
    ];
    for (const error of transientErrors) {
      const errorCode = error.code || 'PG_CONNECTION_ERROR';
      await checkScenario(`read recovery: ${error.code || error.message}`, { readErrors: [error] },
        { status: 200, reads: 2, checkouts: 3, touches: 1, discards: 1, errors: 1, retry: true, stage: 'lookup', errorCode });
      await checkScenario(`checkout recovery: ${error.code || error.message}`, { connectErrors: [error] },
        { status: 200, reads: 1, checkouts: 3, touches: 1, errors: 1, retry: true, stage: 'connect', errorCode });
    }
    await checkScenario('persistent reset stops after two reads and discards both clients',
      { readErrors: [dbError('ECONNRESET'), dbError('ECONNRESET')] },
      { status: 500, reads: 2, checkouts: 2, touches: 0, discards: 2, errors: 2, retry: true });
    await checkScenario('persistent connect timeout stops after two checkouts',
      { connectErrors: [dbError('ETIMEDOUT'), dbError('ETIMEDOUT')] },
      { status: 500, reads: 0, checkouts: 2, touches: 0, errors: 2, retry: true });
    for (const code of ['42P01', '42703', '42501', '28P01', '53300', '57014', '40001', '40P01']) {
      await checkScenario(`no retry for non-connection code ${code}`, { readErrors: [dbError(code)] },
        { status: 500, reads: 1, checkouts: 1, touches: 0, errors: 1, errorCode: code });
    }
    await checkScenario('unknown code stays redacted and cannot match a connection message',
      { readErrors: [dbError('private-dsn-and-token', 'Connection terminated unexpectedly')] },
      { status: 500, reads: 1, checkouts: 1, touches: 0, errors: 1, errorCode: 'other' });
    await checkScenario('arbitrary error message is not retried or logged', { readErrors: [dbError()] },
      { status: 500, reads: 1, checkouts: 1, touches: 0, errors: 1, errorCode: 'other' });
    await checkScenario('missing cookie rejects before any DB access', {},
      { status: 401, reads: 0, checkouts: 0, touches: 0 }, { cookie: '' });
    await checkScenario('no matching active unexpired unrevoked session returns 401', { user: null },
      { status: 401, reads: 1, checkouts: 1, touches: 0 });
    await checkScenario('session revoked during retry returns 401 instead of cached identity',
      { readErrors: [dbError('ECONNRESET')], user: null },
      { status: 401, reads: 2, checkouts: 2, touches: 0, discards: 1, errors: 1, retry: true });
    await checkScenario('tenant outside existing ACL stays denied after recovery',
      { readErrors: [dbError('ECONNRESET')] },
      { status: 403, reads: 2, checkouts: 2, touches: 1, discards: 1, errors: 1, retry: true },
      { path: CALENDAR.replace('client=wolfhouse-somo', 'client=sunset') });
    await checkScenario('viewer cannot enter admin route after recovery',
      { readErrors: [dbError('ECONNRESET')] },
      { status: 403, reads: 2, checkouts: 2, touches: 1, discards: 1, errors: 1, retry: true },
      { path: '/staff/admin/finance/summary?client=wolfhouse-somo' });
    await checkScenario('malformed cookie is not disguised as a connection failure', {},
      { status: 500, reads: 0, checkouts: 0, touches: 0 },
      { cookie: `${api.COOKIE_NAME}=${TOKEN}; unrelated=100%` });
    await checkScenario('best-effort last-seen failure does not replay verified auth',
      { touchError: dbError('42501') }, { status: 200, reads: 1, checkouts: 2, touches: 1 });
    // New HTTP request must validate again, including after a preceding healthy one.
    await checkScenario('no positive auth cache on subsequent request', { user: null },
      { status: 401, reads: 1, checkouts: 1, touches: 0 });
    console.log('verify:staff-auth-session-recovery — ALL CHECKS PASSED');
  } finally {
    await new Promise(resolve => api.server.close(resolve));
    pg._setPoolForTests(null);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
