'use strict';

/**
 * Deterministic verifier for the Crowsnest client-metrics reporter (Pupil slice 3).
 * Pure offline — mock pg pool + mock fetch, no network/DB.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const reporter = require(path.join(ROOT, 'scripts', 'crowsnest-client-metrics-reporter.js'));
const { validateCrowsnestClientMetricsEvent } = require(path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-client-metrics-contract.js'));

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name); }
}

const identity = { clientSlug: 'wolfhouse-somo', tenantId: 'tenant_wh', sourceService: 'staff-api' };
const counts = {
  conversations_total: 128, conversations_active: 34, conversations_needing_human: 5,
  messages_last_24h: 342, messages_7d: 2100, last_activity_at: '2026-07-23T03:38:00.000Z',
};

(async () => {
  // buildSnapshot -> contract-valid event with correct derived fields
  const ev = reporter.buildSnapshot(counts, identity, { snapshotId: 'snap_test', capturedAt: '2026-07-23T03:40:00.000Z' });
  ok('buildSnapshot produces a contract-valid event', validateCrowsnestClientMetricsEvent(ev).ok === true);
  ok('messages_per_day_avg = 7d/7 (rounded)', ev.metrics.messages_per_day_avg === 300);
  ok('carries trusted identity + measured availability', ev.client_slug === 'wolfhouse-somo' && ev.tenant_id === 'tenant_wh' && ev.metrics.availability === 'measured');
  ok('last_activity_at normalized to ISO Z', ev.metrics.last_activity_at === '2026-07-23T03:38:00.000Z');

  // null last-activity (client with no activity) still valid
  const evNull = reporter.buildSnapshot({ ...counts, last_activity_at: null, messages_7d: 0 }, identity);
  ok('null last_activity_at is accepted', validateCrowsnestClientMetricsEvent(evNull).ok === true && evNull.metrics.last_activity_at === null);

  // counts query is parameterized + column is validated
  const q = reporter.buildCountsQuery('client_id');
  ok('counts query filters by $1 (parameterized, injectable null)', /\$1::uuid IS NULL OR c\.client_id = \$1/.test(q));
  let threw = false;
  try { reporter.buildCountsQuery('client_id; DROP TABLE x'); } catch { threw = true; }
  ok('unsafe id column rejected', threw === true);

  // readConfig fails closed on missing env
  let cfgThrew = false;
  try { reporter.readConfig({}); } catch (e) { cfgThrew = e.code === 'reporter_misconfigured'; }
  ok('readConfig throws when misconfigured', cfgThrew === true);

  // run() end-to-end with mock pool + mock fetch
  const captured = {};
  const mockPool = { query: async (sql, params) => { captured.sql = String(sql); captured.params = params; return { rows: [counts] }; } };
  const mockFetch = async (url, opts) => { captured.url = url; captured.opts = opts; return { status: 200, json: async () => ({ ok: true }) }; };
  const env = {
    CROWSNEST_REPORTER_DATABASE_URL: 'postgres://x',
    CROWSNEST_METRICS_INGEST_URL: 'https://crowsnest.example/api/client-metrics',
    CROWSNEST_METRICS_INGEST_TOKEN: 'tok',
    CROWSNEST_REPORTER_CLIENT_SLUG: 'wolfhouse-somo',
    CROWSNEST_REPORTER_TENANT_ID: 'tenant_wh',
    CROWSNEST_REPORTER_CLIENT_ID: '00000000-0000-0000-0000-000000000001',
  };
  const result = await reporter.run(env, { pool: mockPool, fetchImpl: mockFetch, snapshotId: 'snap_run', capturedAt: '2026-07-23T03:40:00.000Z' });
  ok('run() reports ok on HTTP 200', result.ok === true && result.status === 200);
  ok('run() POSTs to the configured ingest URL', captured.url === env.CROWSNEST_METRICS_INGEST_URL && captured.opts.method === 'POST');
  ok('run() sends the bearer token', captured.opts.headers.authorization === 'Bearer tok');
  ok('run() posts a contract-valid event body', validateCrowsnestClientMetricsEvent(JSON.parse(captured.opts.body)).ok === true);
  ok('run() passed the client_id filter to the query', captured.params && captured.params[0] === env.CROWSNEST_REPORTER_CLIENT_ID);

  console.log(`\n── verify:crowsnest-client-metrics-reporter: ${pass} passed, ${fail} failed ──`);
  if (fail > 0) { console.error('verify:crowsnest-client-metrics-reporter — FAILURES'); process.exit(1); }
  console.log('verify:crowsnest-client-metrics-reporter — ALL CHECKS PASSED');
})().catch((err) => { console.error(err); process.exit(1); });
