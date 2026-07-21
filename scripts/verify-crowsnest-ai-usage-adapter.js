'use strict';

/**
 * Deterministic verifier for Crowsnest AI usage adapter (Slice 3).
 * Pure offline checks — no network, no DB, no storage writes.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'crowsnest-ai-usage-adapter');
const ADAPTER_REL = 'scripts/lib/crowsnest/crowsnest-ai-usage-adapter.js';
const ADAPTER_PATH = path.join(ROOT, ADAPTER_REL);
const CONTRACT_REL = 'scripts/lib/crowsnest/crowsnest-ai-usage-contract.js';
const CONTRACT_PATH = path.join(ROOT, CONTRACT_REL);
const DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'AI-USAGE-ADAPTER.md');
const PRODUCT_DOC_PATH = path.join(ROOT, 'docs', 'CROWSNEST.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const VERIFY_SCRIPT_REL = 'scripts/verify-crowsnest-ai-usage-adapter.js';

const PROVIDER_FIXTURES = Object.freeze([
  'openai-response-measured.json',
  'anthropic-response-measured.json',
  'openai-response-zero-tokens.json',
  'openai-response-partial-usage.json',
  'openai-response-inconsistent-usage.json',
  'openai-response-missing-model.json',
  'openai-response-fractional-usage.json',
  'anthropic-response-overflow-usage.json',
]);

const BASE_CONTEXT = Object.freeze({
  client_slug: 'trusted-example-client',
  tenant_id: 'tenant_trusted_alpha',
  source_service: 'example-front-desk',
  operation: 'chat.completion',
  event_id: 'evt_adapter_synth_001',
  occurred_at: '2026-07-21T15:30:00.000Z',
  latency_ms: 318,
});

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail ? `— ${detail}` : '');
  }
}

function readJson(abs) {
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function collectStringLeaves(node, out = []) {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStringLeaves(item, out);
    return out;
  }
  if (node != null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      out.push(key);
      collectStringLeaves(value, out);
    }
  }
  return out;
}

function stringifyEventBlob(event) {
  return JSON.stringify(event);
}

function hasAnySubstring(blob, needles) {
  return needles.some((n) => blob.includes(n));
}

console.log('verify:crowsnest-ai-usage-adapter — AI usage adapter gate\n');

ok('adapter module path exists', fs.existsSync(ADAPTER_PATH), ADAPTER_REL);
ok('contract module path exists', fs.existsSync(CONTRACT_PATH), CONTRACT_REL);
ok('docs/crowsnest/AI-USAGE-ADAPTER.md exists', fs.existsSync(DOC_PATH));
ok('docs/CROWSNEST.md exists', fs.existsSync(PRODUCT_DOC_PATH));
ok('verifier script path is this file', path.basename(__filename) === 'verify-crowsnest-ai-usage-adapter.js');

let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
} catch {
  pkg = null;
}
ok('package.json parses', pkg != null);
ok(
  'package.json has verify:crowsnest-ai-usage-adapter',
  Boolean(pkg && pkg.scripts && pkg.scripts['verify:crowsnest-ai-usage-adapter']),
);
ok(
  'verify script points at verifier',
  Boolean(
    pkg
    && pkg.scripts
    && String(pkg.scripts['verify:crowsnest-ai-usage-adapter']).includes(VERIFY_SCRIPT_REL),
  ),
);

const onDiskFixtures = fs.existsSync(FIXTURE_DIR)
  ? fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json')).sort()
  : [];
const declaredFixtures = PROVIDER_FIXTURES.slice().sort();
ok(
  'fixture directory inventory equals declared provider fixture set',
  declaredFixtures.length === onDiskFixtures.length
    && declaredFixtures.every((name, i) => name === onDiskFixtures[i]),
  `declared=[${declaredFixtures.join(',')}] disk=[${onDiskFixtures.join(',')}]`,
);

for (const name of PROVIDER_FIXTURES) {
  const abs = path.join(FIXTURE_DIR, name);
  ok(`fixture exists ${name}`, fs.existsSync(abs));
  if (fs.existsSync(abs)) {
    try {
      readJson(abs);
      ok(`fixture parses ${name}`, true);
    } catch (err) {
      ok(`fixture parses ${name}`, false, String(err.message || err));
    }
  } else {
    ok(`fixture parses ${name}`, false, 'missing');
  }
}

let adapter = null;
let contract = null;
let loadError = null;
try {
  delete require.cache[require.resolve(CONTRACT_PATH)];
  contract = require(CONTRACT_PATH);
  delete require.cache[require.resolve(ADAPTER_PATH)];
  adapter = require(ADAPTER_PATH);
} catch (err) {
  loadError = err;
}

ok('adapter module loads', adapter != null, loadError ? String(loadError.message || loadError) : '');
ok(
  'exports adaptCrowsnestAiUsageSuccess',
  Boolean(adapter && typeof adapter.adaptCrowsnestAiUsageSuccess === 'function'),
);
ok(
  'exports adaptCrowsnestAiUsageFailure',
  Boolean(adapter && typeof adapter.adaptCrowsnestAiUsageFailure === 'function'),
);
ok(
  'contract validateCrowsnestAiUsageEvent available',
  Boolean(contract && typeof contract.validateCrowsnestAiUsageEvent === 'function'),
);

const adaptSuccess = adapter && typeof adapter.adaptCrowsnestAiUsageSuccess === 'function'
  ? adapter.adaptCrowsnestAiUsageSuccess
  : null;
const adaptFailure = adapter && typeof adapter.adaptCrowsnestAiUsageFailure === 'function'
  ? adapter.adaptCrowsnestAiUsageFailure
  : null;
const validate = contract && typeof contract.validateCrowsnestAiUsageEvent === 'function'
  ? contract.validateCrowsnestAiUsageEvent
  : null;

if (adaptSuccess && adaptFailure && validate) {
  const openaiMeasured = readJson(path.join(FIXTURE_DIR, 'openai-response-measured.json'));
  const anthropicMeasured = readJson(path.join(FIXTURE_DIR, 'anthropic-response-measured.json'));
  const openaiZero = readJson(path.join(FIXTURE_DIR, 'openai-response-zero-tokens.json'));
  const openaiPartial = readJson(path.join(FIXTURE_DIR, 'openai-response-partial-usage.json'));
  const openaiInconsistent = readJson(path.join(FIXTURE_DIR, 'openai-response-inconsistent-usage.json'));
  const openaiMissingModel = readJson(path.join(FIXTURE_DIR, 'openai-response-missing-model.json'));
  const openaiFractional = readJson(path.join(FIXTURE_DIR, 'openai-response-fractional-usage.json'));
  const anthropicOverflow = readJson(path.join(FIXTURE_DIR, 'anthropic-response-overflow-usage.json'));

  // ── Success: measured OpenAI ────────────────────────────────────────────
  const openaiOk = adaptSuccess({
    ...BASE_CONTEXT,
    provider: 'openai',
    response: deepClone(openaiMeasured),
  });
  ok('openai measured returns ok', Boolean(openaiOk && openaiOk.ok === true));
  ok('openai measured returns event', Boolean(openaiOk && openaiOk.event && typeof openaiOk.event === 'object'));
  if (openaiOk && openaiOk.event) {
    const v = validate(openaiOk.event);
    ok('openai measured event passes contract', v.ok === true, v.errors ? v.errors.join('; ') : '');
    ok('openai measured uses trusted client_slug', openaiOk.event.client_slug === BASE_CONTEXT.client_slug);
    ok('openai measured uses trusted tenant_id', openaiOk.event.tenant_id === BASE_CONTEXT.tenant_id);
    ok(
      'openai measured ignores provider client_slug',
      openaiOk.event.client_slug !== openaiMeasured.client_slug,
    );
    ok(
      'openai measured ignores provider tenant_id',
      openaiOk.event.tenant_id !== openaiMeasured.tenant_id,
    );
    ok('openai measured status succeeded', openaiOk.event.status === 'succeeded');
    ok('openai measured provider openai', openaiOk.event.provider === 'openai');
    ok('openai measured model from response', openaiOk.event.model === 'gpt-example-mini');
    ok('openai measured tokens availability', openaiOk.event.tokens.availability === 'measured');
    ok('openai measured input_tokens', openaiOk.event.tokens.input_tokens === 42);
    ok('openai measured output_tokens', openaiOk.event.tokens.output_tokens === 17);
    ok('openai measured total_tokens', openaiOk.event.tokens.total_tokens === 59);
    ok('openai measured default cost unavailable', openaiOk.event.cost.state === 'unavailable');
    const blob = stringifyEventBlob(openaiOk.event);
    ok(
      'openai measured does not leak response content/PII/secrets',
      !hasAnySubstring(blob, [
        'SECRET_SHOULD_NOT_LEAK',
        '+15550100',
        'guest@example.test',
        'sk-EXAMPLEFAKESECRETVALUE0001',
        'chatcmpl-SYNTHETIC-OPENAI-001',
        'attacker-client-from-provider',
        'attacker-tenant-from-provider',
        'choices',
        'prompt',
        'api_key',
        'metadata',
      ]),
    );
    ok(
      'openai measured event has no error_code',
      !Object.prototype.hasOwnProperty.call(openaiOk.event, 'error_code'),
    );
  }

  // ── Success: measured Anthropic (exact safe total) ──────────────────────
  const anthropicOk = adaptSuccess({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_002',
    provider: 'anthropic',
    response: deepClone(anthropicMeasured),
  });
  ok('anthropic measured returns ok', Boolean(anthropicOk && anthropicOk.ok === true));
  if (anthropicOk && anthropicOk.event) {
    const v = validate(anthropicOk.event);
    ok('anthropic measured event passes contract', v.ok === true, v.errors ? v.errors.join('; ') : '');
    ok('anthropic measured tokens availability', anthropicOk.event.tokens.availability === 'measured');
    ok('anthropic measured input_tokens', anthropicOk.event.tokens.input_tokens === 100);
    ok('anthropic measured output_tokens', anthropicOk.event.tokens.output_tokens === 25);
    ok('anthropic measured total equals input+output', anthropicOk.event.tokens.total_tokens === 125);
    ok('anthropic measured model', anthropicOk.event.model === 'claude-example-haiku');
    ok(
      'anthropic measured ignores provider tenant spoof',
      anthropicOk.event.tenant_id === BASE_CONTEXT.tenant_id
        && anthropicOk.event.tenant_id !== anthropicMeasured.tenant_id,
    );
    const blob = stringifyEventBlob(anthropicOk.event);
    ok(
      'anthropic measured does not leak content/secrets',
      !hasAnySubstring(blob, [
        'SECRET_SHOULD_NOT_LEAK',
        'Bearer EXAMPLETOKENVALUE01',
        'msg_SYNTHETIC_ANTHROPIC_001',
        'provider-spoofed-client',
        'provider-spoofed-tenant',
      ]),
    );
  }

  // ── Explicit zero tokens are measured ───────────────────────────────────
  const zeroOk = adaptSuccess({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_zero',
    provider: 'openai',
    response: deepClone(openaiZero),
  });
  ok('explicit zero usage measured ok', Boolean(zeroOk && zeroOk.ok === true));
  ok(
    'explicit zero usage measured not unavailable',
    Boolean(
      zeroOk
      && zeroOk.event
      && zeroOk.event.tokens.availability === 'measured'
      && zeroOk.event.tokens.input_tokens === 0
      && zeroOk.event.tokens.output_tokens === 0
      && zeroOk.event.tokens.total_tokens === 0,
    ),
  );

  // ── Malformed / partial / inconsistent / fractional / overflow → unavailable
  const partialOk = adaptSuccess({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_partial',
    provider: 'openai',
    response: deepClone(openaiPartial),
  });
  ok('partial usage adapts ok', Boolean(partialOk && partialOk.ok === true));
  ok(
    'partial usage tokens unavailable (not fake zero)',
    Boolean(
      partialOk
      && partialOk.event
      && partialOk.event.tokens.availability === 'unavailable'
      && !Object.prototype.hasOwnProperty.call(partialOk.event.tokens, 'input_tokens')
      && !Object.prototype.hasOwnProperty.call(partialOk.event.tokens, 'output_tokens')
      && !Object.prototype.hasOwnProperty.call(partialOk.event.tokens, 'total_tokens'),
    ),
  );
  ok(
    'partial usage event passes contract',
    Boolean(partialOk && partialOk.event && validate(partialOk.event).ok === true),
  );

  const inconsistentOk = adaptSuccess({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_inconsistent',
    provider: 'openai',
    response: deepClone(openaiInconsistent),
  });
  ok(
    'inconsistent usage tokens unavailable',
    Boolean(
      inconsistentOk
      && inconsistentOk.ok
      && inconsistentOk.event.tokens.availability === 'unavailable',
    ),
  );

  const fractionalOk = adaptSuccess({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_frac',
    provider: 'openai',
    response: deepClone(openaiFractional),
  });
  ok(
    'fractional usage tokens unavailable',
    Boolean(
      fractionalOk
      && fractionalOk.ok
      && fractionalOk.event.tokens.availability === 'unavailable',
    ),
  );

  const overflowOk = adaptSuccess({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_overflow',
    provider: 'anthropic',
    response: deepClone(anthropicOverflow),
  });
  ok(
    'overflow anthropic usage tokens unavailable',
    Boolean(
      overflowOk
      && overflowOk.ok
      && overflowOk.event.tokens.availability === 'unavailable',
    ),
  );

  const negativeUsage = adaptSuccess({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_neg',
    provider: 'openai',
    response: {
      model: 'gpt-example-mini',
      usage: { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 },
    },
  });
  ok(
    'negative usage tokens unavailable',
    Boolean(
      negativeUsage
      && negativeUsage.ok
      && negativeUsage.event.tokens.availability === 'unavailable',
    ),
  );

  const missingUsage = adaptSuccess({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_nousage',
    provider: 'openai',
    response: { model: 'gpt-example-mini' },
  });
  ok(
    'missing usage tokens unavailable',
    Boolean(
      missingUsage
      && missingUsage.ok
      && missingUsage.event.tokens.availability === 'unavailable',
    ),
  );

  // ── Model fail-closed ───────────────────────────────────────────────────
  const missingModel = adaptSuccess({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_nomodel',
    provider: 'openai',
    response: deepClone(openaiMissingModel),
  });
  ok('missing model fails closed', Boolean(missingModel && missingModel.ok === false));
  ok(
    'missing model returns errors array',
    Boolean(missingModel && Array.isArray(missingModel.errors) && missingModel.errors.length > 0),
  );
  ok('missing model does not emit event', !missingModel || missingModel.event == null);

  const unsafeModel = adaptSuccess({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_badmodel',
    provider: 'openai',
    response: {
      model: 'sk-EXAMPLEFAKESECRETVALUE0001',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  });
  ok('unsafe model fails closed', Boolean(unsafeModel && unsafeModel.ok === false));

  const blankModel = adaptSuccess({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_blankmodel',
    provider: 'openai',
    response: {
      model: '   ',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  });
  ok('blank model fails closed', Boolean(blankModel && blankModel.ok === false));

  // ── Trusted tenant context required; never from env / provider ──────────
  const missingTenant = adaptSuccess({
    ...BASE_CONTEXT,
    tenant_id: undefined,
    provider: 'openai',
    response: deepClone(openaiMeasured),
  });
  ok('missing tenant_id fails', Boolean(missingTenant && missingTenant.ok === false));

  const missingClient = adaptSuccess({
    ...BASE_CONTEXT,
    client_slug: undefined,
    provider: 'openai',
    response: deepClone(openaiMeasured),
  });
  ok('missing client_slug fails', Boolean(missingClient && missingClient.ok === false));

  const blankTenant = adaptSuccess({
    ...BASE_CONTEXT,
    tenant_id: '',
    provider: 'openai',
    response: deepClone(openaiMeasured),
  });
  ok('blank tenant_id fails', Boolean(blankTenant && blankTenant.ok === false));

  const onlyProviderTenant = adaptSuccess({
    client_slug: BASE_CONTEXT.client_slug,
    // intentionally omit tenant_id; provider response has spoofed tenant_id
    source_service: BASE_CONTEXT.source_service,
    operation: BASE_CONTEXT.operation,
    event_id: 'evt_adapter_synth_onlyprov',
    occurred_at: BASE_CONTEXT.occurred_at,
    latency_ms: BASE_CONTEXT.latency_ms,
    provider: 'openai',
    response: deepClone(openaiMeasured),
  });
  ok(
    'provider tenant_id cannot substitute trusted context',
    Boolean(onlyProviderTenant && onlyProviderTenant.ok === false),
  );

  const envBefore = process.env.CROWSNEST_TENANT_ID;
  process.env.CROWSNEST_TENANT_ID = 'env-tenant-must-not-be-used';
  const envIgnored = adaptSuccess({
    ...BASE_CONTEXT,
    tenant_id: undefined,
    provider: 'openai',
    response: deepClone(openaiMeasured),
  });
  if (envBefore === undefined) delete process.env.CROWSNEST_TENANT_ID;
  else process.env.CROWSNEST_TENANT_ID = envBefore;
  ok('env tenant is not used when trusted tenant missing', Boolean(envIgnored && envIgnored.ok === false));

  // Distinct trusted identities still work (no forced equivalence)
  const distinctIds = adaptSuccess({
    ...BASE_CONTEXT,
    client_slug: 'wolfhouse',
    tenant_id: 'wolfhouse-somo',
    event_id: 'evt_adapter_synth_distinct',
    provider: 'openai',
    response: deepClone(openaiZero),
  });
  ok(
    'allows distinct client_slug and tenant_id without mapping',
    Boolean(distinctIds && distinctIds.ok === true
      && distinctIds.event.client_slug === 'wolfhouse'
      && distinctIds.event.tenant_id === 'wolfhouse-somo'),
  );

  // ── Explicit cost semantics ─────────────────────────────────────────────
  const costReported = adaptSuccess({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_cost_pr',
    provider: 'openai',
    response: deepClone(openaiZero),
    cost: { state: 'provider_reported', amount_micros: 1250, currency: 'USD' },
  });
  ok('explicit provider_reported cost ok', Boolean(costReported && costReported.ok === true));
  ok(
    'explicit provider_reported cost preserved',
    Boolean(
      costReported
      && costReported.event
      && costReported.event.cost.state === 'provider_reported'
      && costReported.event.cost.amount_micros === 1250
      && costReported.event.cost.currency === 'USD',
    ),
  );

  const costEstimated = adaptSuccess({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_cost_est',
    provider: 'openai',
    response: deepClone(openaiZero),
    cost: { state: 'estimated', amount_micros: 0, currency: 'EUR' },
  });
  ok(
    'explicit estimated cost with zero amount ok',
    Boolean(
      costEstimated
      && costEstimated.ok
      && costEstimated.event.cost.state === 'estimated'
      && costEstimated.event.cost.amount_micros === 0
      && costEstimated.event.cost.currency === 'EUR',
    ),
  );

  const costUnavailableExplicit = adaptSuccess({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_cost_un',
    provider: 'openai',
    response: deepClone(openaiZero),
    cost: { state: 'unavailable' },
  });
  ok(
    'explicit unavailable cost ok',
    Boolean(
      costUnavailableExplicit
      && costUnavailableExplicit.ok
      && costUnavailableExplicit.event.cost.state === 'unavailable',
    ),
  );

  const costBadCurrency = adaptSuccess({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_cost_badcur',
    provider: 'openai',
    response: deepClone(openaiZero),
    cost: { state: 'estimated', amount_micros: 10, currency: 'usd' },
  });
  ok('lowercase currency cost rejected', Boolean(costBadCurrency && costBadCurrency.ok === false));

  const costNegative = adaptSuccess({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_cost_neg',
    provider: 'openai',
    response: deepClone(openaiZero),
    cost: { state: 'provider_reported', amount_micros: -1, currency: 'USD' },
  });
  ok('negative amount_micros cost rejected', Boolean(costNegative && costNegative.ok === false));

  const costExtraField = adaptSuccess({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_cost_extra',
    provider: 'openai',
    response: deepClone(openaiZero),
    cost: { state: 'estimated', amount_micros: 1, currency: 'USD', price_table: 'nope' },
  });
  ok('cost with unknown field rejected', Boolean(costExtraField && costExtraField.ok === false));

  const costUnavailableWithAmount = adaptSuccess({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_cost_badun',
    provider: 'openai',
    response: deepClone(openaiZero),
    cost: { state: 'unavailable', amount_micros: 1, currency: 'USD' },
  });
  ok(
    'unavailable cost with amount rejected',
    Boolean(costUnavailableWithAmount && costUnavailableWithAmount.ok === false),
  );

  // ── Failure adaptation ──────────────────────────────────────────────────
  const failOk = adaptFailure({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_fail',
    provider: 'openai',
    error_code: 'provider_timeout',
    model: 'gpt-example-mini',
  });
  ok('failure adaptation returns ok', Boolean(failOk && failOk.ok === true));
  if (failOk && failOk.event) {
    const v = validate(failOk.event);
    ok('failure event passes contract', v.ok === true, v.errors ? v.errors.join('; ') : '');
    ok('failure status failed', failOk.event.status === 'failed');
    ok('failure error_code opaque', failOk.event.error_code === 'provider_timeout');
    ok('failure tokens unavailable', failOk.event.tokens.availability === 'unavailable');
    ok('failure cost unavailable', failOk.event.cost.state === 'unavailable');
    ok('failure model explicit', failOk.event.model === 'gpt-example-mini');
  }

  const failWithRawError = adaptFailure({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_rawerr',
    provider: 'anthropic',
    error_code: 'rate_limited',
    model: 'claude-example-haiku',
    cost: { state: 'provider_reported', amount_micros: 42, currency: 'USD' },
    error: {
      message: 'Raw provider boom with sk-EXAMPLEFAKESECRETVALUE0001',
      body: { detail: 'guest phone +15550100' },
    },
    error_message: 'must not be copied',
    raw_error: 'must not be copied',
  });
  ok('failure ignores raw error payload fields', Boolean(failWithRawError && failWithRawError.ok === true));
  if (failWithRawError && failWithRawError.event) {
    const blob = stringifyEventBlob(failWithRawError.event);
    ok(
      'failure event excludes raw error content',
      !hasAnySubstring(blob, [
        'Raw provider boom',
        'sk-EXAMPLEFAKESECRETVALUE0001',
        '+15550100',
        'must not be copied',
        'error_message',
        'raw_error',
        'detail',
      ]),
    );
    ok('failure forces cost unavailable even if cost input present', failWithRawError.event.cost.state === 'unavailable');
  }

  const failCostIgnored = adaptFailure({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_failcost',
    provider: 'openai',
    error_code: 'upstream_error',
    model: 'gpt-example-mini',
    cost: { state: 'provider_reported', amount_micros: 99, currency: 'USD' },
  });
  ok(
    'failure forces tokens/cost unavailable despite cost input',
    Boolean(
      failCostIgnored
      && failCostIgnored.ok
      && failCostIgnored.event.tokens.availability === 'unavailable'
      && failCostIgnored.event.cost.state === 'unavailable',
    ),
  );

  const failMissingErrorCode = adaptFailure({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_noerr',
    provider: 'openai',
    model: 'gpt-example-mini',
  });
  ok('failure without error_code fails', Boolean(failMissingErrorCode && failMissingErrorCode.ok === false));

  const failMissingModel = adaptFailure({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_failnomodel',
    provider: 'openai',
    error_code: 'upstream_error',
  });
  ok('failure without explicit model fails closed', Boolean(failMissingModel && failMissingModel.ok === false));

  const failUnsafeErrorCode = adaptFailure({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_badercode',
    provider: 'openai',
    error_code: 'Bearer EXAMPLETOKENVALUE01',
    model: 'gpt-example-mini',
  });
  ok('failure with unsafe error_code fails', Boolean(failUnsafeErrorCode && failUnsafeErrorCode.ok === false));

  const failMissingTenant = adaptFailure({
    ...BASE_CONTEXT,
    tenant_id: undefined,
    event_id: 'evt_adapter_synth_failtenant',
    provider: 'openai',
    error_code: 'upstream_error',
    model: 'gpt-example-mini',
  });
  ok('failure missing tenant_id fails', Boolean(failMissingTenant && failMissingTenant.ok === false));

  // ── Required deterministic inputs ───────────────────────────────────────
  const missingLatency = adaptSuccess({
    ...BASE_CONTEXT,
    latency_ms: undefined,
    provider: 'openai',
    response: deepClone(openaiZero),
  });
  ok('missing latency_ms fails', Boolean(missingLatency && missingLatency.ok === false));

  const missingProvider = adaptSuccess({
    ...BASE_CONTEXT,
    provider: undefined,
    response: deepClone(openaiZero),
  });
  ok('missing provider fails', Boolean(missingProvider && missingProvider.ok === false));

  const badProvider = adaptSuccess({
    ...BASE_CONTEXT,
    provider: 'cohere',
    response: deepClone(openaiZero),
  });
  ok('unknown provider fails', Boolean(badProvider && badProvider.ok === false));

  const missingResponse = adaptSuccess({
    ...BASE_CONTEXT,
    provider: 'openai',
  });
  ok('success without response fails', Boolean(missingResponse && missingResponse.ok === false));

  const nonObjectResponse = adaptSuccess({
    ...BASE_CONTEXT,
    provider: 'openai',
    response: 'not-an-object',
  });
  ok('non-object response fails', Boolean(nonObjectResponse && nonObjectResponse.ok === false));

  // Contract validation enforced on emit
  const badOccurred = adaptSuccess({
    ...BASE_CONTEXT,
    occurred_at: '2026-02-30T12:00:00.000Z',
    provider: 'openai',
    response: deepClone(openaiZero),
  });
  ok(
    'impossible occurred_at fails via contract validation',
    Boolean(badOccurred && badOccurred.ok === false && Array.isArray(badOccurred.errors)),
  );

  // Adapter must not mutate provider response
  const mutateProbe = deepClone(openaiMeasured);
  const before = JSON.stringify(mutateProbe);
  adaptSuccess({
    ...BASE_CONTEXT,
    event_id: 'evt_adapter_synth_mutate',
    provider: 'openai',
    response: mutateProbe,
  });
  ok('adapter does not mutate provider response', JSON.stringify(mutateProbe) === before);

  // ── Own-data-property / prototype-inheritance security ──────────────────
  function deleteProtoKeys(keys) {
    for (const key of keys) {
      try {
        delete Object.prototype[key];
      } catch {
        // ignore
      }
    }
  }

  function protoHasOwn(key) {
    return Object.prototype.hasOwnProperty.call(Object.prototype, key);
  }

  const zeroUsageOwn = Object.freeze({
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });

  // Object.prototype pollution: trusted identity must not be inherited
  {
    const keys = ['client_slug', 'tenant_id'];
    try {
      Object.defineProperty(Object.prototype, 'client_slug', {
        value: 'proto-spoofed-client',
        configurable: true,
      });
      Object.defineProperty(Object.prototype, 'tenant_id', {
        value: 'proto-spoofed-tenant',
        configurable: true,
      });
      const pollutedTrusted = adaptSuccess({
        source_service: BASE_CONTEXT.source_service,
        operation: BASE_CONTEXT.operation,
        event_id: 'evt_proto_trusted',
        occurred_at: BASE_CONTEXT.occurred_at,
        latency_ms: BASE_CONTEXT.latency_ms,
        provider: 'openai',
        response: { model: 'gpt-example-mini', usage: { ...zeroUsageOwn } },
      });
      ok(
        'Object.prototype trusted identity pollution fails closed',
        Boolean(pollutedTrusted && pollutedTrusted.ok === false),
      );
    } finally {
      deleteProtoKeys(keys);
    }
    ok(
      'no Object.prototype pollution remains after trusted identity test',
      !protoHasOwn('client_slug') && !protoHasOwn('tenant_id'),
    );
  }

  // Object.prototype pollution: missing own model must fail closed
  {
    const keys = ['model'];
    try {
      Object.defineProperty(Object.prototype, 'model', {
        value: 'gpt-proto-invented',
        configurable: true,
      });
      const pollutedModel = adaptSuccess({
        ...BASE_CONTEXT,
        event_id: 'evt_proto_model',
        provider: 'openai',
        response: { usage: { ...zeroUsageOwn } },
      });
      ok(
        'Object.prototype model pollution fails closed for missing own model',
        Boolean(pollutedModel && pollutedModel.ok === false),
      );
    } finally {
      deleteProtoKeys(keys);
    }
    ok('no Object.prototype pollution remains after missing model test', !protoHasOwn('model'));
  }

  // Object.prototype pollution: empty usage must not fabricate measured tokens
  {
    const keys = ['prompt_tokens', 'completion_tokens', 'total_tokens'];
    try {
      Object.defineProperty(Object.prototype, 'prompt_tokens', {
        value: 7,
        configurable: true,
      });
      Object.defineProperty(Object.prototype, 'completion_tokens', {
        value: 3,
        configurable: true,
      });
      Object.defineProperty(Object.prototype, 'total_tokens', {
        value: 10,
        configurable: true,
      });
      const pollutedUsage = adaptSuccess({
        ...BASE_CONTEXT,
        event_id: 'evt_proto_usage',
        provider: 'openai',
        response: { model: 'gpt-example-mini', usage: {} },
      });
      ok(
        'Object.prototype token pollution yields unavailable tokens',
        Boolean(
          pollutedUsage
          && pollutedUsage.ok === true
          && pollutedUsage.event
          && pollutedUsage.event.tokens.availability === 'unavailable'
          && !Object.prototype.hasOwnProperty.call(pollutedUsage.event.tokens, 'input_tokens'),
        ),
      );
    } finally {
      deleteProtoKeys(keys);
    }
    ok(
      'no Object.prototype pollution remains after empty usage tokens test',
      !protoHasOwn('prompt_tokens')
        && !protoHasOwn('completion_tokens')
        && !protoHasOwn('total_tokens'),
    );
  }

  // Object.prototype pollution: empty explicit cost must not fabricate cost
  {
    const keys = ['state', 'amount_micros', 'currency'];
    try {
      Object.defineProperty(Object.prototype, 'state', {
        value: 'provider_reported',
        configurable: true,
      });
      Object.defineProperty(Object.prototype, 'amount_micros', {
        value: 9999,
        configurable: true,
      });
      Object.defineProperty(Object.prototype, 'currency', {
        value: 'USD',
        configurable: true,
      });
      const pollutedCost = adaptSuccess({
        ...BASE_CONTEXT,
        event_id: 'evt_proto_cost',
        provider: 'openai',
        response: { model: 'gpt-example-mini', usage: { ...zeroUsageOwn } },
        cost: {},
      });
      ok(
        'Object.prototype cost field pollution fails closed on empty explicit cost',
        Boolean(pollutedCost && pollutedCost.ok === false),
      );
    } finally {
      deleteProtoKeys(keys);
    }
    ok(
      'no Object.prototype pollution remains after empty explicit cost test',
      !protoHasOwn('state') && !protoHasOwn('amount_micros') && !protoHasOwn('currency'),
    );
  }

  // Inherited cost on input is omitted (default unavailable), not fabricated
  {
    const keys = ['cost'];
    try {
      Object.defineProperty(Object.prototype, 'cost', {
        value: { state: 'provider_reported', amount_micros: 1, currency: 'USD' },
        configurable: true,
      });
      const inheritedCost = adaptSuccess({
        ...BASE_CONTEXT,
        event_id: 'evt_proto_inherited_cost',
        provider: 'openai',
        response: { model: 'gpt-example-mini', usage: { ...zeroUsageOwn } },
      });
      ok(
        'inherited input.cost defaults to unavailable',
        Boolean(
          inheritedCost
          && inheritedCost.ok === true
          && inheritedCost.event
          && inheritedCost.event.cost.state === 'unavailable',
        ),
      );
    } finally {
      deleteProtoKeys(keys);
    }
    ok('no Object.prototype pollution remains after inherited cost test', !protoHasOwn('cost'));
  }

  // Getter counters: accessors must not execute
  {
    let modelGets = 0;
    const accessorModelResponse = { usage: { ...zeroUsageOwn } };
    Object.defineProperty(accessorModelResponse, 'model', {
      get() {
        modelGets += 1;
        return 'gpt-example-mini';
      },
      enumerable: true,
      configurable: true,
    });
    const accessorModel = adaptSuccess({
      ...BASE_CONTEXT,
      event_id: 'evt_accessor_model',
      provider: 'openai',
      response: accessorModelResponse,
    });
    ok('accessor response.model fails closed', Boolean(accessorModel && accessorModel.ok === false));
    ok('model getter did not execute', modelGets === 0);
  }

  {
    let usageGets = 0;
    let promptGets = 0;
    let completionGets = 0;
    let totalGets = 0;
    const usageObj = {};
    Object.defineProperty(usageObj, 'prompt_tokens', {
      get() {
        promptGets += 1;
        return 1;
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(usageObj, 'completion_tokens', {
      get() {
        completionGets += 1;
        return 1;
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(usageObj, 'total_tokens', {
      get() {
        totalGets += 1;
        return 2;
      },
      enumerable: true,
      configurable: true,
    });
    const responseWithUsageAccessor = { model: 'gpt-example-mini' };
    Object.defineProperty(responseWithUsageAccessor, 'usage', {
      get() {
        usageGets += 1;
        return usageObj;
      },
      enumerable: true,
      configurable: true,
    });
    const accessorUsage = adaptSuccess({
      ...BASE_CONTEXT,
      event_id: 'evt_accessor_usage',
      provider: 'openai',
      response: responseWithUsageAccessor,
    });
    ok(
      'accessor response.usage yields unavailable tokens',
      Boolean(
        accessorUsage
        && accessorUsage.ok === true
        && accessorUsage.event
        && accessorUsage.event.tokens.availability === 'unavailable',
      ),
    );
    ok('usage getter did not execute', usageGets === 0);

    const ownUsageAccessorTokens = adaptSuccess({
      ...BASE_CONTEXT,
      event_id: 'evt_accessor_token_fields',
      provider: 'openai',
      response: { model: 'gpt-example-mini', usage: usageObj },
    });
    ok(
      'accessor usage token fields yield unavailable tokens',
      Boolean(
        ownUsageAccessorTokens
        && ownUsageAccessorTokens.ok === true
        && ownUsageAccessorTokens.event
        && ownUsageAccessorTokens.event.tokens.availability === 'unavailable',
      ),
    );
    ok(
      'usage token getters did not execute',
      promptGets === 0 && completionGets === 0 && totalGets === 0,
    );
  }

  {
    let costGets = 0;
    const inputWithCostAccessor = {
      ...BASE_CONTEXT,
      event_id: 'evt_accessor_cost',
      provider: 'openai',
      response: { model: 'gpt-example-mini', usage: { ...zeroUsageOwn } },
    };
    Object.defineProperty(inputWithCostAccessor, 'cost', {
      get() {
        costGets += 1;
        return { state: 'provider_reported', amount_micros: 1, currency: 'USD' };
      },
      enumerable: true,
      configurable: true,
    });
    const accessorCost = adaptSuccess(inputWithCostAccessor);
    ok('accessor input.cost fails closed', Boolean(accessorCost && accessorCost.ok === false));
    ok('cost getter did not execute', costGets === 0);
  }

  {
    let stateGets = 0;
    let amountGets = 0;
    let currencyGets = 0;
    const costObj = {};
    Object.defineProperty(costObj, 'state', {
      get() {
        stateGets += 1;
        return 'provider_reported';
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(costObj, 'amount_micros', {
      get() {
        amountGets += 1;
        return 10;
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(costObj, 'currency', {
      get() {
        currencyGets += 1;
        return 'USD';
      },
      enumerable: true,
      configurable: true,
    });
    const accessorCostFields = adaptSuccess({
      ...BASE_CONTEXT,
      event_id: 'evt_accessor_cost_fields',
      provider: 'openai',
      response: { model: 'gpt-example-mini', usage: { ...zeroUsageOwn } },
      cost: costObj,
    });
    ok(
      'accessor cost field properties fail closed',
      Boolean(accessorCostFields && accessorCostFields.ok === false),
    );
    ok(
      'cost field getters did not execute',
      stateGets === 0 && amountGets === 0 && currencyGets === 0,
    );
  }

  {
    let clientGets = 0;
    let tenantGets = 0;
    let providerGets = 0;
    const trustedAccessorInput = {
      source_service: BASE_CONTEXT.source_service,
      operation: BASE_CONTEXT.operation,
      event_id: 'evt_accessor_trusted',
      occurred_at: BASE_CONTEXT.occurred_at,
      latency_ms: BASE_CONTEXT.latency_ms,
      response: { model: 'gpt-example-mini', usage: { ...zeroUsageOwn } },
    };
    Object.defineProperty(trustedAccessorInput, 'client_slug', {
      get() {
        clientGets += 1;
        return BASE_CONTEXT.client_slug;
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(trustedAccessorInput, 'tenant_id', {
      get() {
        tenantGets += 1;
        return BASE_CONTEXT.tenant_id;
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(trustedAccessorInput, 'provider', {
      get() {
        providerGets += 1;
        return 'openai';
      },
      enumerable: true,
      configurable: true,
    });
    const accessorTrusted = adaptSuccess(trustedAccessorInput);
    ok(
      'accessor trusted context fields fail closed',
      Boolean(accessorTrusted && accessorTrusted.ok === false),
    );
    ok(
      'trusted context getters did not execute',
      clientGets === 0 && tenantGets === 0 && providerGets === 0,
    );
  }

  {
    let errorCodeGets = 0;
    let failModelGets = 0;
    const failAccessorInput = {
      ...BASE_CONTEXT,
      event_id: 'evt_accessor_fail',
      provider: 'openai',
    };
    Object.defineProperty(failAccessorInput, 'error_code', {
      get() {
        errorCodeGets += 1;
        return 'provider_timeout';
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(failAccessorInput, 'model', {
      get() {
        failModelGets += 1;
        return 'gpt-example-mini';
      },
      enumerable: true,
      configurable: true,
    });
    const accessorFail = adaptFailure(failAccessorInput);
    ok(
      'accessor failure error_code/model fail closed',
      Boolean(accessorFail && accessorFail.ok === false),
    );
    ok(
      'failure error_code/model getters did not execute',
      errorCodeGets === 0 && failModelGets === 0,
    );
  }

  {
    const keys = ['error_code', 'model'];
    try {
      Object.defineProperty(Object.prototype, 'error_code', {
        value: 'proto_error',
        configurable: true,
      });
      Object.defineProperty(Object.prototype, 'model', {
        value: 'gpt-proto-fail',
        configurable: true,
      });
      const pollutedFailMissingBoth = adaptFailure({
        ...BASE_CONTEXT,
        event_id: 'evt_proto_fail',
        provider: 'openai',
      });
      ok(
        'Object.prototype failure error_code/model pollution fails closed',
        Boolean(pollutedFailMissingBoth && pollutedFailMissingBoth.ok === false),
      );
      const pollutedFailInheritedModel = adaptFailure({
        ...BASE_CONTEXT,
        event_id: 'evt_proto_fail_model',
        provider: 'openai',
        error_code: 'upstream_error',
      });
      ok(
        'Object.prototype failure model pollution fails closed with own error_code',
        Boolean(pollutedFailInheritedModel && pollutedFailInheritedModel.ok === false),
      );
    } finally {
      deleteProtoKeys(keys);
    }
    ok(
      'no Object.prototype pollution remains after failure identity test',
      !protoHasOwn('error_code') && !protoHasOwn('model'),
    );
  }

  {
    let responseGets = 0;
    const inputWithResponseAccessor = {
      ...BASE_CONTEXT,
      event_id: 'evt_accessor_response',
      provider: 'openai',
    };
    Object.defineProperty(inputWithResponseAccessor, 'response', {
      get() {
        responseGets += 1;
        return { model: 'gpt-example-mini', usage: { ...zeroUsageOwn } };
      },
      enumerable: true,
      configurable: true,
    });
    const accessorResponse = adaptSuccess(inputWithResponseAccessor);
    ok(
      'accessor input.response fails closed',
      Boolean(accessorResponse && accessorResponse.ok === false),
    );
    ok('response getter did not execute', responseGets === 0);
  }

  // Source hygiene
  const adapterSrc = fs.readFileSync(ADAPTER_PATH, 'utf8');
  ok('adapter requires only local contract module', /crowsnest-ai-usage-contract/.test(adapterSrc));
  ok('adapter does not require luna-ai-provider', !/luna-ai-provider/.test(adapterSrc));
  ok('adapter does not require staff-query-api', !/staff-query-api/.test(adapterSrc));
  ok('adapter does not require crowsnest-api', !/crowsnest-api/.test(adapterSrc));
  ok('adapter does not require crowsnest-auth', !/crowsnest-auth/.test(adapterSrc));
  ok('adapter does not open network sockets', !/\b(?:http|https|net|fetch|axios)\b/.test(adapterSrc));
  ok('adapter does not write files', !/writeFile|appendFile|createWriteStream/.test(adapterSrc));
  ok('adapter does not persist or open db', !/\b(?:persist|postgres|sqlite|mongodb|redis|createPool|createClient)\b/i.test(adapterSrc));
  ok('adapter does not read process.env for tenant', !/process\.env/.test(adapterSrc));
  ok('adapter does not hardcode model prices', !/price_per|COST_PER|usd_per_1k|per_million/i.test(adapterSrc));
  ok('adapter does not hardcode unrelated sha256 hashes', !/[a-f0-9]{64}/i.test(adapterSrc));
  ok('adapter calls validateCrowsnestAiUsageEvent', /validateCrowsnestAiUsageEvent/.test(adapterSrc));
  ok(
    'adapter uses Object.getOwnPropertyDescriptor for own-data reads',
    /Object\.getOwnPropertyDescriptor/.test(adapterSrc),
  );

  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  ok('adapter doc mentions trusted context', /trusted/i.test(doc) && /client_slug/i.test(doc) && /tenant_id/i.test(doc));
  ok('adapter doc documents model fail-closed', /fail-closed|fail closed/i.test(doc));
  ok('adapter doc documents unavailable tokens', /unavailable/i.test(doc));
  ok('adapter doc documents no persistence', /without persist|no storage|does not persist|not persist/i.test(doc));
  ok('adapter doc does not claim runtime wiring', !/\b(?:wired into|deployed to production|live telemetry connected)\b/i.test(doc));

  const productDoc = fs.readFileSync(PRODUCT_DOC_PATH, 'utf8');
  ok('CROWSNEST.md mentions AI usage adapter', /ai usage adapter|AI-USAGE-ADAPTER/i.test(productDoc));
  ok(
    'CROWSNEST.md lists verify:crowsnest-ai-usage-adapter',
    /verify:crowsnest-ai-usage-adapter/.test(productDoc),
  );
} else {
  ok('adapter behavioral checks skipped (module missing)', false, 'adapter or contract unavailable');
}

console.log(`\n── verify:crowsnest-ai-usage-adapter: ${pass} passed, ${fail} failed ──`);
if (fail === 0) {
  console.log('verify:crowsnest-ai-usage-adapter — ALL CHECKS PASSED');
}
process.exit(fail ? 1 : 0);
