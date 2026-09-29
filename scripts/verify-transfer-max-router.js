'use strict';
// Invoke the actual authenticated Staff API router with request streams, never a
// listener or runtime service. PGlite owns all test data; no real credentials.
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./verify-transfer-admin-price-custom');

async function main() {
  const oldEnv = { ...process.env };
  const queries = [], results = [];
  let h, api, failDb = false, sessionUser = null;
  let phase = 'init';
  const timeout = setTimeout(() => { console.error('Router gate stalled at: ' + phase); process.exit(1); }, 30000);
  const token = 'local-transfer-read-contract-fixture';
  try {
    for (const k of Object.keys(process.env)) {
      if (/^(STAFF_|LUNA_|STRIPE_|BOT_|META_|WHATSAPP_|PG|DATABASE_)/.test(k)) delete process.env[k];
    }
    Object.assign(process.env, {
      NODE_ENV: 'test', STAFF_RUNTIME_PROFILE: 'test',
      STAFF_API_FORTRESS_OFFLINE_LISTENER: '1', STAFF_AUTH_REQUIRED: 'true',
      STAFF_AUTH_HTTPS: 'false', DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
      LUNA_BOT_CLIENT_SLUG: 'wolfhouse-somo', LUNA_BOT_INTERNAL_TOKEN: token,
      STAFF_ACTIONS_ENABLED: 'false', BOT_BOOKING_ENABLED: 'false',
      STRIPE_LINKS_ENABLED: 'false', WHATSAPP_SEND_ENABLED: 'false',
    });
    phase = 'createHarness';
    h = await createHarness();
    phase = 'fare';
    await h.adminFare('SDR', 1950, 'per_person', 'GBP');
    await h.db.query(`INSERT INTO wh_pricing_transfer_rules
      (client_slug,airport_code,label,requires_package,included_when_package,min_guest_count,max_guest_count)
      VALUES ('wolfhouse-somo','SDR','Santander',false,false,2,6)`);
    phase = 'require-api';
    api = require('./staff-query-api');
    api.setFortress15j3OfflineSeams({
      withPgClient: fn => {
        if (failDb) throw new Error('offline injected outage');
        return fn({ query: (sql, args) => {
          assert.match(sql.trim(), /^SELECT\b/i, 'Luna price read must never perform DDL/DML');
          queries.push({ sql, args });
          return h.db.query(sql, args);
        } });
      },
      resolveSessionUser: () => sessionUser,
    });
    assert.equal(api.server.listening, false, 'router proof opens no port');
    async function call(name, { body = {}, query = '', credential = token, method = 'POST' } = {}) {
      const before = queries.length;
      const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
      req.method = method;
      req.url = '/staff/bot/transfers/prices' + query;
      req.headers = { 'content-type': 'application/json' };
      if (credential !== null) req.headers['x-luna-bot-token'] = credential;
      let resolveResponse;
      const responseEnded = new Promise(resolve => { resolveResponse = resolve; });
      const res = { statusCode: 200, headers: {},
        setHeader(k, v) { this.headers[k] = v; },
        getHeader(k) { return this.headers[k]; },
        writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); },
        end(raw) { this.body = JSON.parse(raw.toString()); this.writableEnded = true; resolveResponse(); },
      };
      phase = name;
      await api.router(req, res);
      await responseEnded;
      results.push({ name, status: res.statusCode, body: res.body, query_count: queries.length - before });
      return results[results.length - 1];
    }
    const good = await call('authenticated principal omission');
    assert.equal(good.status, 200, JSON.stringify(good));
    assert.equal(good.body.client_slug, 'wolfhouse-somo');
    assert.equal(good.body.read_only, true);
    assert.equal(good.body.availability_checked, false);
    const row = good.body.transfers.find(x => x.airport_code === 'SDR');
    assert.equal(row.eligibility.max_guest_count, 6);
    assert.equal(row.eligibility.min_guest_count, 2);
    assert.equal(row.price.unit, 'per_person');
    assert.equal(row.price.amount_cents, 1950);
    assert.equal(row.price.currency, 'GBP');
    assert(good.query_count > 0);
    for (const [name, opts, status] of [
      ['matching aliases', { body: { client_slug: 'wolfhouse-somo' }, query: '?client=wolfhouse-somo' }, 200],
      ['missing auth', { credential: null }, 401],
      ['wrong auth', { credential: 'wrong-fixture' }, 401],
      ['body cross-tenant', { body: { client_slug: 'sunset' } }, 403],
      ['query cross-tenant', { query: '?client=sunset' }, 403],
      ['empty tenant', { body: { client_slug: null } }, 403],
      ['malformed JSON', { body: '{broken' }, 400],
      ['wrong method', { method: 'GET' }, 405],
    ]) {
      const r = await call(name, opts);
      assert.equal(r.status, status, JSON.stringify(r));
      if (status !== 200) {
        assert.equal(r.query_count, 0, name + ' must not query pricing');
        assert.equal(r.body.transfers, undefined, name + ' must not leak pricing');
      }
    }
    sessionUser = { id: 'offline-sunset-staff', role: 'staff', client_slug: 'sunset', client_slugs: ['sunset'] };
    for (const [name, opts] of [
      ['Sunset session body override', { body: { client_slug: 'wolfhouse-somo' } }],
      ['Sunset session query override', { query: '?client=wolfhouse-somo' }],
      ['Sunset session query slug override', { query: '?client_slug=wolfhouse-somo' }],
      ['Sunset session default tenant', {}],
    ]) {
      const r = await call(name, { ...opts, credential: null });
      assert.equal(r.status, 403, JSON.stringify(r));
      assert.equal(r.query_count, 0, name + ' must be denied before pricing SQL');
      assert.equal(r.body.transfers, undefined);
    }
    sessionUser = { id: 'offline-wh-staff', role: 'staff', client_slug: 'wolfhouse-somo', client_slugs: ['wolfhouse-somo'] };
    for (const [name, opts] of [
      ['Wolfhouse session default', {}],
      ['Wolfhouse session matching body', { body: { client_slug: 'wolfhouse-somo' } }],
      ['Wolfhouse session matching query', { query: '?client=wolfhouse-somo' }],
    ]) {
      const r = await call(name, { ...opts, credential: null });
      assert.equal(r.status, 403, JSON.stringify(r));
      assert.equal(r.body.error, 'bot_token_required');
      assert.equal(r.query_count, 0);
      assert.equal(r.body.transfers, undefined);
    }
    sessionUser = null;
    process.env.LUNA_BOT_CLIENT_SLUG = process.env.DEFAULT_CLIENT_SLUG = 'sunset';
    const sunset = await call('Sunset principal stays isolated');
    assert.equal(sunset.status, 403, JSON.stringify(sunset));
    assert.equal(sunset.query_count, 0);
    assert.equal(sunset.body.transfers, undefined);
    process.env.LUNA_BOT_CLIENT_SLUG = process.env.DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';
    failDb = true;
    const outage = await call('DB outage fails closed');
    assert.equal(outage.status, 503);
    assert.equal(outage.body.transfers, undefined);
    assert.equal((await h.saved()).length, 0, 'reader creates no booking transfer');
    const out = process.env.TRANSFER_ROUTER_OUT || oldEnv.TRANSFER_ROUTER_OUT;
    if (out) {
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ passed: true, results, queries, listening: api.server.listening }, null, 2) + '\n');
    }
    console.log(`PASS: actual Staff API router/auth/tenant binding: ${results.length} cases, SQL read-only, persisted max=6 reaches Luna, Sunset isolated; no listener.`);
  } finally {
    clearTimeout(timeout);
    if (api) api.setFortress15j3OfflineSeams(null);
    if (h) await h.close();
    for (const k of Object.keys(process.env)) if (!(k in oldEnv)) delete process.env[k];
    Object.assign(process.env, oldEnv);
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
