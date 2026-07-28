'use strict';

/**
 * Verifier for the Crowsnest AI-usage reporter ("the observer").
 * Pure + a fake fetch — no live database, no Azure, no real network.
 *
 * Proves: opt-in no-op when unconfigured; server-owned identity always wins over
 * caller-supplied identity; success + failure receipts validate and POST with a
 * bearer token; fresh vs reused event_id; and that NO fault (bad facts, thrown
 * fetch) ever escapes as an exception into the caller.
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');
const reporter = require(path.join(ROOT, 'scripts', 'crowsnest-ai-usage-reporter.js'));
const { validateCrowsnestAiUsageEvent } = require(path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-ai-usage-contract.js'));

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

const FULL_ENV = {
  CROWSNEST_AI_USAGE_INGEST_URL: 'https://crowsnest.example/api/ai-usage',
  CROWSNEST_AI_USAGE_INGEST_TOKEN: 'tok_secret',
  CROWSNEST_AI_USAGE_CLIENT_SLUG: 'sunset-somo',
  CROWSNEST_AI_USAGE_TENANT_ID: 'sunset',
  CROWSNEST_AI_USAGE_SOURCE_SERVICE: 'hermes',
};

// Fake fetch that records the last request and returns a scripted response.
function fakeFetch(script = { status: 200, json: { ok: true } }) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    return {
      status: script.status,
      async json() {
        if (script.throwJson) throw new Error('not json');
        return script.json;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

function okOpenAiResponse(overrides = {}) {
  return {
    model: 'gpt-4o-mini',
    usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
    // Decoy content that must never leak into the receipt:
    choices: [{ message: { content: 'secret guest reply' } }],
    ...overrides,
  };
}

async function partConfig() {
  console.log('\n── config / opt-in ──');
  const off = reporter.readReporterConfig({});
  ok('unconfigured => enabled:false', off.enabled === false);

  const partial = reporter.readReporterConfig({ ...FULL_ENV, CROWSNEST_AI_USAGE_INGEST_TOKEN: '' });
  ok('missing token => enabled:false', partial.enabled === false);

  const full = reporter.readReporterConfig(FULL_ENV);
  ok('fully configured => enabled:true', full.enabled === true);
  ok('source_service defaults to hermes', reporter.readReporterConfig({ ...FULL_ENV, CROWSNEST_AI_USAGE_SOURCE_SERVICE: '' }).sourceService === 'hermes');

  // No network attempted when unconfigured.
  const ff = fakeFetch();
  const res = await reporter.reportSuccess(
    { provider: 'openai', operation: 'guest_reply', response: okOpenAiResponse(), latency_ms: 500 },
    {},
    { fetchImpl: ff },
  );
  ok('unconfigured report is a skipped no-op', res.ok === false && res.skipped === true && res.reason === 'not_configured');
  ok('unconfigured report makes no fetch call', ff.calls.length === 0);
}

async function partSuccess() {
  console.log('\n── success receipt ──');
  const ff = fakeFetch({ status: 200, json: { ok: true } });
  const res = await reporter.reportSuccess(
    { provider: 'openai', operation: 'guest_reply', response: okOpenAiResponse(), latency_ms: 640, cost: { state: 'estimated', amount_micros: 1_200_000, currency: 'USD' } },
    FULL_ENV,
    { fetchImpl: ff },
  );
  ok('success => ok:true HTTP 200', res.ok === true && res.status === 200, JSON.stringify(res));
  ok('exactly one POST made', ff.calls.length === 1);

  const call = ff.calls[0] || { opts: {} };
  ok('POSTs to configured ingest url', call.url === FULL_ENV.CROWSNEST_AI_USAGE_INGEST_URL);
  ok('sends bearer token', (call.opts.headers || {}).authorization === 'Bearer tok_secret');
  ok('method POST', (call.opts.method || '').toUpperCase() === 'POST');

  const sent = JSON.parse(call.opts.body);
  ok('sent event passes the contract', validateCrowsnestAiUsageEvent(sent).ok === true);
  ok('measured tokens carried through', sent.tokens && sent.tokens.availability === 'measured' && sent.tokens.total_tokens === 200);
  ok('status succeeded', sent.status === 'succeeded');
  ok('model carried from response', sent.model === 'gpt-4o-mini');

  // Secret-free: no guest content / choices anywhere in the payload.
  const wire = call.opts.body;
  ok('receipt carries no prompt/response content', !wire.includes('secret guest reply') && !wire.includes('choices'));
}

async function partIdentityWins() {
  console.log('\n── server-owned identity wins ──');
  const ff = fakeFetch();
  await reporter.reportSuccess(
    {
      provider: 'openai',
      operation: 'guest_reply',
      response: okOpenAiResponse(),
      latency_ms: 300,
      // Caller tries to spoof attribution — must be ignored.
      client_slug: 'attacker-client',
      tenant_id: 'attacker-tenant',
      source_service: 'attacker-svc',
    },
    FULL_ENV,
    { fetchImpl: ff },
  );
  const sent = JSON.parse(ff.calls[0].opts.body);
  ok('client_slug from config, not caller', sent.client_slug === 'sunset-somo');
  ok('tenant_id from config, not caller', sent.tenant_id === 'sunset');
  ok('source_service from config, not caller', sent.source_service === 'hermes');
}

async function partEventId() {
  console.log('\n── event_id: fresh vs reused ──');
  const ff = fakeFetch();
  await reporter.reportSuccess({ provider: 'openai', operation: 'guest_reply', response: okOpenAiResponse(), latency_ms: 200 }, FULL_ENV, { fetchImpl: ff });
  await reporter.reportSuccess({ provider: 'openai', operation: 'guest_reply', response: okOpenAiResponse(), latency_ms: 200 }, FULL_ENV, { fetchImpl: ff });
  const a = JSON.parse(ff.calls[0].opts.body).event_id;
  const b = JSON.parse(ff.calls[1].opts.body).event_id;
  ok('fresh attempts get distinct event_ids', a && b && a !== b);

  const ff2 = fakeFetch();
  const fixed = 'evt_retry_fixed_001';
  await reporter.reportSuccess({ provider: 'openai', operation: 'guest_reply', response: okOpenAiResponse(), latency_ms: 200, event_id: fixed }, FULL_ENV, { fetchImpl: ff2 });
  ok('retry reuses supplied event_id', JSON.parse(ff2.calls[0].opts.body).event_id === fixed);
}

async function partFailureReceipt() {
  console.log('\n── failure receipt ──');
  const ff = fakeFetch();
  const res = await reporter.reportFailure(
    { provider: 'anthropic', operation: 'guest_reply', model: 'claude-3-haiku', error_code: 'upstream_timeout', latency_ms: 5000 },
    FULL_ENV,
    { fetchImpl: ff },
  );
  ok('failure => ok:true HTTP 200', res.ok === true, JSON.stringify(res));
  const sent = JSON.parse(ff.calls[0].opts.body);
  ok('failure event passes the contract', validateCrowsnestAiUsageEvent(sent).ok === true);
  ok('status failed + error_code', sent.status === 'failed' && sent.error_code === 'upstream_timeout');
  ok('failure tokens unavailable', sent.tokens && sent.tokens.availability === 'unavailable');
  ok('failure cost unavailable', sent.cost && sent.cost.state === 'unavailable');
}

async function partNeverThrows() {
  console.log('\n── never throws into the caller ──');
  // Malformed facts (missing provider/response) must be a skipped result, not a throw.
  let threw = false;
  let res;
  try {
    res = await reporter.reportSuccess({ operation: 'guest_reply', latency_ms: 100 }, FULL_ENV, { fetchImpl: fakeFetch() });
  } catch { threw = true; }
  ok('bad facts do not throw', threw === false);
  ok('bad facts => skipped invalid_event', res && res.ok === false && res.reason === 'invalid_event');

  // A fetch that throws (network down) must be swallowed.
  threw = false;
  const boomFetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    res = await reporter.reportSuccess({ provider: 'openai', operation: 'guest_reply', response: okOpenAiResponse(), latency_ms: 100 }, FULL_ENV, { fetchImpl: boomFetch });
  } catch { threw = true; }
  ok('network fault does not throw', threw === false);
  ok('network fault => skipped reporter_error', res && res.ok === false && res.reason === 'reporter_error');
}

async function main() {
  console.log('Crowsnest AI-usage reporter verifier');
  await partConfig();
  await partSuccess();
  await partIdentityWins();
  await partEventId();
  await partFailureReceipt();
  await partNeverThrows();
  console.log(`\n${fail === 0 ? 'OK' : 'FAILED'}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verifier crashed:', err);
  process.exit(1);
});
