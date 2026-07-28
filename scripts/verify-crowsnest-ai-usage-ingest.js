'use strict';

/**
 * Verifier for the Crowsnest AI-usage ingest endpoint + Spyglass aggregation store.
 * No live database, no Azure, no network beyond a loopback HTTP server.
 *
 * Proves: token-gated invisible ingest (404 until configured), bearer auth,
 * method + body guards, contract validation (incl. secret-free rejection),
 * memory-backend aggregation shape, and production fail-closed reads.
 */

const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const store = require(path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-ai-usage-spyglass-store.js'));
const { renderCrowsnestPage } = require(path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-page.js'));

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${extra ? `  (${extra})` : ''}`);
  }
}

function baseValidEvent(overrides = {}) {
  return {
    schema_version: 'crowsnest.ai_usage.v1',
    event_id: `evt-${Math.random().toString(36).slice(2)}`,
    occurred_at: new Date().toISOString(),
    client_slug: 'wolfhouse-somo',
    tenant_id: 'wolfhouse',
    source_service: 'hermes',
    operation: 'guest_reply',
    provider: 'openai',
    model: 'gpt-4o-mini',
    status: 'succeeded',
    tokens: { availability: 'measured', input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    latency_ms: 640,
    cost: { state: 'estimated', amount_micros: 1_200_000, currency: 'USD' },
    ...overrides,
  };
}

// ── Part A: store aggregation (pure) ────────────────────────────────────────
async function partA() {
  ok('empty window aggregates to null (fail-closed)', store.aggregateAiUsage([], { now: Date.now() }) === null);

  const now = Date.UTC(2026, 6, 28, 12, 0, 0);
  const day = 24 * 60 * 60 * 1000;
  const events = [
    baseValidEvent({ occurred_at: new Date(now - 1 * day).toISOString(), provider: 'openai', client_slug: 'wolfhouse-somo', status: 'succeeded', latency_ms: 600, tokens: { availability: 'measured', input_tokens: 100, output_tokens: 100, total_tokens: 200 }, cost: { state: 'estimated', amount_micros: 2_000_000, currency: 'USD' } }),
    baseValidEvent({ occurred_at: new Date(now - 2 * day).toISOString(), provider: 'anthropic', client_slug: 'sunset-somo', status: 'failed', error_code: 'timeout', latency_ms: 1000, tokens: { availability: 'unavailable' }, cost: { state: 'unavailable' } }),
    baseValidEvent({ occurred_at: new Date(now - 30 * day).toISOString() }), // out of 7-day window
  ];
  const agg = store.aggregateAiUsage(events, { now, windowDays: 7, nameFor: (s) => (s === 'wolfhouse-somo' ? 'Wolfhouse Somo' : s) });

  ok('aggregate is live, not sample', agg && agg.sample === false && agg.live === true);
  ok('window excludes out-of-range events (2 requests)', agg && agg.totals.requests === 2, agg && agg.totals.requests);
  ok('token sums count measured only', agg && agg.totals.total_tokens === 200 && agg.totals.input_tokens === 100);
  ok('cost sums known-only, dollars from micros', agg && agg.totals.cost_usd === 2, agg && agg.totals.cost_usd);
  ok('avg latency averages present latencies', agg && agg.totals.avg_latency_ms === 800, agg && agg.totals.avg_latency_ms);
  ok('success_rate = succeeded/requests', agg && Math.abs(agg.totals.success_rate - 0.5) < 1e-9);
  ok('by_provider has both providers with shares', agg && agg.by_provider.length === 2 && Math.abs(agg.by_provider.reduce((s, p) => s + p.share, 0) - 1) < 1e-9);
  ok('by_client resolves names', agg && agg.by_client.some((c) => c.id === 'wolfhouse-somo' && c.name === 'Wolfhouse Somo'));
  ok('daily_requests has windowDays buckets', agg && agg.daily_requests.length === 7);
  ok('daily_requests places counts on correct days', agg && agg.daily_requests[5] === 1 && agg.daily_requests[6] === 0);

  // Production fail-closed: no memory backend, reads null, writes 503.
  ok('production resolves to fail_closed backend', store.resolveBackend({ NODE_ENV: 'production' }) === 'fail_closed');
  const prod = store.createFailClosedRepository();
  ok('fail-closed aggregate is null', (await prod.aggregate({})) === null);
  const prodWrite = await prod.record(baseValidEvent());
  ok('fail-closed record returns safe 503', prodWrite && prodWrite.ok === false && prodWrite.status === 503);

  const bad = store.createMemoryRepository();
  const rej = await bad.record({ schema_version: 'nope' });
  ok('memory repo rejects contract-invalid event', rej && rej.ok === false && rej.code === 'invalid_ai_usage_event');
}

// ── Part B: ingest endpoint (loopback server) ───────────────────────────────
async function partB() {
  delete process.env.NODE_ENV; // memory backend
  delete process.env.CROWSNEST_AUTH_REQUIRED; // browser auth off; ingest is token-gated
  store._resetRepositoryForTests();

  const api = require(path.join(ROOT, 'scripts', 'crowsnest-api.js'));
  const port = Number(process.env.CROWSNEST_AI_USAGE_VERIFY_PORT) || 13141;
  await new Promise((r) => api.server.listen(port, '127.0.0.1', r));

  function req(method, pathname, { headers = {}, body } = {}) {
    return new Promise((resolve) => {
      const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
      const h = { ...headers };
      if (data !== undefined) h['Content-Length'] = Buffer.byteLength(data);
      const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: h }, (res) => {
        let b = '';
        res.on('data', (d) => { b += d; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
      });
      if (data !== undefined) r.write(data);
      r.end();
    });
  }

  try {
    delete process.env.CROWSNEST_AI_USAGE_INGEST_TOKEN;
    const invisible = await req('POST', '/api/ai-usage', { body: baseValidEvent() });
    ok('ingest is 404 (invisible) until a token is configured', invisible.status === 404, invisible.status);

    process.env.CROWSNEST_AI_USAGE_INGEST_TOKEN = 'test-ingest-token';
    const auth = { Authorization: 'Bearer test-ingest-token', 'Content-Type': 'application/json' };

    const noAuth = await req('POST', '/api/ai-usage', { body: baseValidEvent() });
    ok('no bearer => 401', noAuth.status === 401, noAuth.status);
    const wrongAuth = await req('POST', '/api/ai-usage', { headers: { Authorization: 'Bearer nope' }, body: baseValidEvent() });
    ok('wrong bearer => 401', wrongAuth.status === 401, wrongAuth.status);
    const getMethod = await req('GET', '/api/ai-usage', { headers: auth });
    ok('GET => 405 (POST only)', getMethod.status === 405, getMethod.status);
    const badJson = await req('POST', '/api/ai-usage', { headers: auth, body: '{not json' });
    ok('invalid JSON => 400', badJson.status === 400, badJson.status);

    const invalid = await req('POST', '/api/ai-usage', { headers: auth, body: baseValidEvent({ provider: 'xai' }) });
    ok('contract-invalid event => 400', invalid.status === 400 && /invalid_ai_usage_event/.test(invalid.body), invalid.body);

    const secrety = await req('POST', '/api/ai-usage', { headers: auth, body: baseValidEvent({ prompt: 'hello there' }) });
    ok('secret-shaped key (prompt) rejected => 400', secrety.status === 400, secrety.status);

    const good = await req('POST', '/api/ai-usage', { headers: auth, body: baseValidEvent() });
    ok('valid event => 200 {ok:true}', good.status === 200 && /"ok":true/.test(good.body), good.body);
    ok('ingest response carries browser security headers', String(good.headers['x-content-type-options'] || '') === 'nosniff');

    const agg = await store.getSpyglassAiUsage({ env: process.env });
    ok('reader reflects ingested event (requests >= 1)', agg && agg.totals.requests >= 1, agg && JSON.stringify(agg.totals));
  } finally {
    await new Promise((r) => api.server.close(r));
  }
}

(async () => {
  // ── Part C: Spyglass panel prefers live aggregate, falls back to sample ──────
  const liveUsage = {
    sample: false, live: true, window_label: 'Last 7 days',
    totals: { requests: 3, input_tokens: 100, output_tokens: 50, total_tokens: 150, cost_usd: 1.23, avg_latency_ms: 500, success_rate: 1 },
    by_provider: [{ provider: 'openai', requests: 3, total_tokens: 150, cost_usd: 1.23, share: 1 }],
    by_client: [{ id: 'wolfhouse-somo', name: 'Wolfhouse Somo', requests: 3, total_tokens: 150, cost_usd: 1.23 }],
    daily_requests: [0, 0, 0, 0, 0, 0, 3],
  };
  const liveHtml = renderCrowsnestPage({ view: 'spyglass', aiUsage: liveUsage });
  ok('panel renders LIVE aggregate when provided (no Sample badge)', /class="sample-badge sample-badge--live"/.test(liveHtml) && !/>Sample<\/span>/.test(liveHtml) && /\$1\.23/.test(liveHtml));
  ok('live panel spark caption drops "(sample)"', /Requests · last 7 days<\/span>/.test(liveHtml));
  const sampleHtml = renderCrowsnestPage({ view: 'spyglass' });
  ok('panel falls back to labelled Sample when no live aggregate', />Sample<\/span>/.test(sampleHtml) && /last 7 days \(sample\)/.test(sampleHtml));

  await partA();
  await partB();
  console.log(`\n── verify:crowsnest-ai-usage-ingest: ${pass} passed, ${fail} failed ──`);
  if (fail === 0) console.log('verify:crowsnest-ai-usage-ingest — ALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('verify:crowsnest-ai-usage-ingest — unexpected error', err);
  process.exit(1);
});
