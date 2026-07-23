'use strict';

/**
 * Deterministic verifier for the Crowsnest client-metrics ingest endpoint
 * (Pupil slice: persistent store + push). Pure offline — mock req/res, memory store,
 * no network/DB. Doubles as the security check on the token-gated write surface.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const api = require(path.join(ROOT, 'scripts', 'crowsnest-api.js'));
const store = require(path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-client-metrics-store.js'));
const validEvent = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'crowsnest-client-metrics', 'valid-measured.json'), 'utf8'));
const TOKEN_ENV = api.METRICS_INGEST_TOKEN_ENV;
const TOKEN = 'secret-token-123';

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name); }
}

function mockReq({ method = 'POST', auth, body = '' }) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = auth ? { authorization: auth } : {};
  setImmediate(() => { if (body) req.emit('data', Buffer.from(body)); req.emit('end'); });
  return req;
}
function mockRes() {
  return {
    statusCode: 0, headers: {}, body: '',
    writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h || {}); return this; },
    setHeader(k, v) { this.headers[k] = v; },
    end(b) { this.body = b == null ? '' : String(b); },
  };
}
async function call(opts = {}) {
  const method = opts.method || 'POST';
  const res = mockRes();
  await api.handleClientMetricsIngest(mockReq({ ...opts, method }), res, method);
  let json = null; try { json = JSON.parse(res.body); } catch { /* non-json */ }
  return { status: res.statusCode, json, headers: res.headers };
}

(async () => {
  const saved = {
    token: process.env[TOKEN_ENV],
    node: process.env.NODE_ENV,
    dsn: process.env.CROWSNEST_METRICS_DATABASE_URL,
  };
  try {
    // Disabled/invisible when no token configured.
    delete process.env[TOKEN_ENV];
    ok('no token env => 404 (invisible surface)', (await call({})).status === 404);

    // Configure token; memory store (non-prod, no DSN).
    process.env[TOKEN_ENV] = TOKEN;
    process.env.NODE_ENV = 'development';
    delete process.env.CROWSNEST_METRICS_DATABASE_URL;
    store._resetRepositoryForTests();

    ok('configured + GET => 405', (await call({ method: 'GET' })).status === 405);
    ok('POST no auth => 401', (await call({})).status === 401);
    ok('POST wrong token => 401', (await call({ auth: 'Bearer nope' })).status === 401);
    ok('POST token wrong scheme => 401', (await call({ auth: TOKEN })).status === 401);

    let r = await call({ auth: `Bearer ${TOKEN}`, body: '{not json' });
    ok('good token + malformed JSON => 400 invalid_json', r.status === 400 && r.json && r.json.code === 'invalid_json');

    r = await call({ auth: `Bearer ${TOKEN}`, body: JSON.stringify({ schema_version: 'nope' }) });
    ok('good token + contract-invalid => 400 rejected', r.status === 400 && r.json && r.json.ok === false && Array.isArray(r.json.errors));

    r = await call({ auth: `Bearer ${TOKEN}`, body: JSON.stringify(validEvent) });
    ok('good token + valid event => 200 ok', r.status === 200 && r.json && r.json.ok === true);

    const map = await store.getSpyglassClientMetricsMap(process.env);
    ok('ingested snapshot is readable by the Spyglass reader', !!map[validEvent.client_slug]);

    // A snapshot carrying a forbidden key is rejected by the contract at ingest.
    const sensitive = JSON.parse(JSON.stringify(validEvent));
    sensitive.metrics.phone = '+34000';
    r = await call({ auth: `Bearer ${TOKEN}`, body: JSON.stringify(sensitive) });
    ok('sensitive-key snapshot rejected at ingest (privacy)', r.status === 400 && r.json && r.json.ok === false);

    // Fail-closed: prod + token but NO DSN => 503, never a silent success.
    process.env.NODE_ENV = 'production';
    delete process.env.CROWSNEST_METRICS_DATABASE_URL;
    store._resetRepositoryForTests();
    r = await call({ auth: `Bearer ${TOKEN}`, body: JSON.stringify(validEvent) });
    ok('prod + no DSN => 503 store misconfigured', r.status === 503 && r.json && r.json.code === 'client_metrics_store_misconfigured');
  } finally {
    for (const [k, v] of [[TOKEN_ENV, saved.token], ['NODE_ENV', saved.node], ['CROWSNEST_METRICS_DATABASE_URL', saved.dsn]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    store._resetRepositoryForTests();
  }
  console.log(`\n── verify:crowsnest-client-metrics-ingest: ${pass} passed, ${fail} failed ──`);
  if (fail > 0) { console.error('verify:crowsnest-client-metrics-ingest — FAILURES'); process.exit(1); }
  console.log('verify:crowsnest-client-metrics-ingest — ALL CHECKS PASSED');
})().catch((err) => { console.error(err); process.exit(1); });
