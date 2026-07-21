'use strict';

/**
 * Deterministic verifier for Crowsnest AI usage event contract (Slice 2).
 * Pure offline checks — no network, no DB, no storage writes.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'crowsnest-ai-usage');
const CONTRACT_REL = 'scripts/lib/crowsnest/crowsnest-ai-usage-contract.js';
const CONTRACT_PATH = path.join(ROOT, CONTRACT_REL);
const DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'AI-USAGE-EVENT-CONTRACT.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const VERIFY_SCRIPT_REL = 'scripts/verify-crowsnest-ai-usage-contract.js';

const VALID_FIXTURES = Object.freeze([
  'valid-openai-measured.json',
  'valid-anthropic-estimated.json',
  'valid-tokens-unavailable.json',
  'valid-failed-opaque-error.json',
]);

/** Expected characteristic error path/code for each invalid fixture (not merely any rejection). */
const INVALID_FIXTURE_SPECS = Object.freeze({
  'invalid-missing-tenant-id.json': Object.freeze([
    Object.freeze({ path: 'tenant_id', code: 'required_non_empty_string' }),
  ]),
  'invalid-empty-client-slug.json': Object.freeze([
    Object.freeze({ path: 'client_slug', code: 'required_non_empty_string' }),
  ]),
  'invalid-token-arithmetic.json': Object.freeze([
    Object.freeze({ path: 'tokens.total_tokens', code: 'must_equal_input_plus_output' }),
  ]),
  'invalid-zero-as-unavailable.json': Object.freeze([
    Object.freeze({ path: 'tokens.input_tokens', code: 'forbidden_when_unavailable' }),
    Object.freeze({ path: 'tokens.output_tokens', code: 'forbidden_when_unavailable' }),
    Object.freeze({ path: 'tokens.total_tokens', code: 'forbidden_when_unavailable' }),
  ]),
  'invalid-unknown-top-level.json': Object.freeze([
    Object.freeze({ path: 'extra_field', code: 'unknown_field' }),
  ]),
  'invalid-sensitive-prompt-key.json': Object.freeze([
    Object.freeze({ path: 'prompt', code: 'sensitive_key_forbidden' }),
  ]),
  'invalid-nested-secret-key.json': Object.freeze([
    Object.freeze({ path: 'tokens.api_key', code: 'sensitive_key_forbidden' }),
  ]),
  'invalid-cost-unavailable-with-amount.json': Object.freeze([
    Object.freeze({ path: 'cost.amount_micros', code: 'forbidden_when_unavailable' }),
    Object.freeze({ path: 'cost.currency', code: 'forbidden_when_unavailable' }),
  ]),
  'invalid-failed-missing-error-code.json': Object.freeze([
    Object.freeze({ path: 'error_code', code: 'required_when_failed' }),
  ]),
  'invalid-raw-error-message.json': Object.freeze([
    Object.freeze({ path: 'error_message', code: 'sensitive_key_forbidden' }),
  ]),
  'invalid-unsafe-integer-tokens.json': Object.freeze([
    Object.freeze({ path: 'tokens.input_tokens', code: 'must_be_non_negative_integer' }),
    Object.freeze({ path: 'tokens.total_tokens', code: 'must_be_non_negative_integer' }),
  ]),
  'invalid-impossible-occurred-at.json': Object.freeze([
    Object.freeze({ path: 'occurred_at', code: 'invalid_timestamp' }),
  ]),
});

const INVALID_FIXTURES = Object.freeze(Object.keys(INVALID_FIXTURE_SPECS));

function errorEntry(path, code) {
  return `${path}: ${code}`;
}

function resultHasError(result, path, code) {
  return Boolean(
    result
    && Array.isArray(result.errors)
    && result.errors.includes(errorEntry(path, code)),
  );
}

const PRIVACY_BAN_PATTERNS = Object.freeze([
  /sk-[A-Za-z0-9]{10,}/,
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /-----BEGIN (?:RSA )?PRIVATE KEY-----/,
  /@(?:gmail|yahoo|hotmail|outlook)\./i,
  /\+?\d{10,}/,
  /whatsapp\.com|lunafrontdesk\.com|openai\.com|anthropic\.com/i,
]);

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

function fixtureHasBannedContent(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'invalid_json';
  }
  const blob = collectStringLeaves(parsed).join('\n');
  for (const re of PRIVACY_BAN_PATTERNS) {
    if (re.test(blob)) return re.toString();
  }
  return null;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

console.log('verify:crowsnest-ai-usage-contract — AI usage event contract gate\n');

ok('contract module path exists', fs.existsSync(CONTRACT_PATH), CONTRACT_REL);
ok('docs/crowsnest/AI-USAGE-EVENT-CONTRACT.md exists', fs.existsSync(DOC_PATH));
ok('verifier script path is this file', path.basename(__filename) === 'verify-crowsnest-ai-usage-contract.js');

let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
} catch {
  pkg = null;
}
ok('package.json parses', pkg != null);
ok(
  'package.json has verify:crowsnest-ai-usage-contract',
  Boolean(pkg && pkg.scripts && pkg.scripts['verify:crowsnest-ai-usage-contract']),
);
ok(
  'verify script points at verifier',
  Boolean(
    pkg
    && pkg.scripts
    && String(pkg.scripts['verify:crowsnest-ai-usage-contract']).includes(VERIFY_SCRIPT_REL),
  ),
);

let contract = null;
let loadError = null;
try {
  // Fresh require each run
  delete require.cache[require.resolve(CONTRACT_PATH)];
  contract = require(CONTRACT_PATH);
} catch (err) {
  loadError = err;
}

ok('contract module loads', contract != null, loadError ? String(loadError.message || loadError) : '');
ok(
  'exports SCHEMA_VERSION',
  Boolean(contract && contract.SCHEMA_VERSION === 'crowsnest.ai_usage.v1'),
);
ok(
  'exports validateCrowsnestAiUsageEvent',
  Boolean(contract && typeof contract.validateCrowsnestAiUsageEvent === 'function'),
);

const validate = contract && typeof contract.validateCrowsnestAiUsageEvent === 'function'
  ? contract.validateCrowsnestAiUsageEvent
  : null;

const declaredFixtures = [...VALID_FIXTURES, ...INVALID_FIXTURES].slice().sort();
const onDiskFixtures = fs.existsSync(FIXTURE_DIR)
  ? fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json')).sort()
  : [];
ok(
  'fixture directory inventory equals declared valid+invalid set',
  declaredFixtures.length === onDiskFixtures.length
    && declaredFixtures.every((name, i) => name === onDiskFixtures[i]),
  `declared=[${declaredFixtures.join(',')}] disk=[${onDiskFixtures.join(',')}]`,
);

for (const name of VALID_FIXTURES) {
  const abs = path.join(FIXTURE_DIR, name);
  ok(`fixture exists ${name}`, fs.existsSync(abs));
  if (!fs.existsSync(abs) || !validate) {
    ok(`accepts ${name}`, false, validate ? 'missing fixture' : 'no validator');
    continue;
  }
  const raw = fs.readFileSync(abs, 'utf8');
  const banned = fixtureHasBannedContent(raw);
  ok(`fixture sanitized ${name}`, banned == null, banned ? `matched ${banned}` : '');
  const event = readJson(abs);
  const result = validate(event);
  ok(`accepts ${name}`, Boolean(result && result.ok === true), result && result.errors ? result.errors.join('; ') : '');
}

for (const name of INVALID_FIXTURES) {
  const abs = path.join(FIXTURE_DIR, name);
  const expected = INVALID_FIXTURE_SPECS[name];
  ok(`fixture exists ${name}`, fs.existsSync(abs));
  if (!fs.existsSync(abs) || !validate) {
    ok(`rejects ${name}`, false, validate ? 'missing fixture' : 'no validator');
    continue;
  }
  const raw = fs.readFileSync(abs, 'utf8');
  const banned = fixtureHasBannedContent(raw);
  ok(`fixture sanitized ${name}`, banned == null, banned ? `matched ${banned}` : '');
  const event = readJson(abs);
  const result = validate(event);
  ok(
    `rejects ${name}`,
    Boolean(result && result.ok === false && Array.isArray(result.errors) && result.errors.length > 0),
  );
  for (const spec of expected) {
    ok(
      `rejects ${name} with ${spec.path}:${spec.code}`,
      resultHasError(result, spec.path, spec.code),
      result && result.errors ? result.errors.join('; ') : 'no errors',
    );
  }
}

if (validate) {
  const base = readJson(path.join(FIXTURE_DIR, 'valid-openai-measured.json'));

  const missingClient = deepClone(base);
  delete missingClient.client_slug;
  ok('rejects missing client_slug', validate(missingClient).ok === false);

  const blankTenant = deepClone(base);
  blankTenant.tenant_id = '   ';
  ok('rejects blank tenant_id', validate(blankTenant).ok === false);

  const inferMap = deepClone(base);
  inferMap.client_slug = 'wolfhouse';
  inferMap.tenant_id = 'wolfhouse-somo';
  // Still valid as opaque identifiers — contract must not require equivalence
  const inferResult = validate(inferMap);
  ok('allows distinct client_slug and tenant_id without mapping', inferResult.ok === true);

  const nestedGuest = deepClone(base);
  nestedGuest.tokens = {
    availability: 'measured',
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
    guest: { id: 'should-reject' },
  };
  ok('rejects nested guest key', validate(nestedGuest).ok === false);

  const nestedMeta = deepClone(base);
  nestedMeta.cost = {
    state: 'estimated',
    amount_micros: 1,
    currency: 'USD',
    metadata: { note: 'nope' },
  };
  ok('rejects nested metadata key', validate(nestedMeta).ok === false);

  // Invalid discriminator must still report closed nested unknown_field errors.
  const badTokAvail = deepClone(base);
  badTokAvail.tokens = {
    availability: 'not_a_real_availability',
    extra_note: 'synthetic-non-sensitive',
  };
  const badTokAvailResult = validate(badTokAvail);
  ok(
    'rejects invalid tokens.availability discriminator',
    resultHasError(badTokAvailResult, 'tokens.availability', 'must_be_measured_or_unavailable'),
    badTokAvailResult.errors.join('; '),
  );
  ok(
    'reports tokens unknown_field even with invalid availability',
    resultHasError(badTokAvailResult, 'tokens.extra_note', 'unknown_field'),
    badTokAvailResult.errors.join('; '),
  );

  const badCostState = deepClone(base);
  badCostState.cost = {
    state: 'not_a_real_state',
    extra_note: 'synthetic-non-sensitive',
  };
  const badCostStateResult = validate(badCostState);
  ok(
    'rejects invalid cost.state discriminator',
    resultHasError(badCostStateResult, 'cost.state', 'must_be_provider_reported_estimated_or_unavailable'),
    badCostStateResult.errors.join('; '),
  );
  ok(
    'reports cost unknown_field even with invalid state',
    resultHasError(badCostStateResult, 'cost.extra_note', 'unknown_field'),
    badCostStateResult.errors.join('; '),
  );

  // Branch-specific forbidden semantics stay on measured/unavailable only.
  const unavailableMeasuredFields = deepClone(base);
  unavailableMeasuredFields.tokens = {
    availability: 'unavailable',
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };
  const unavailableMeasuredResult = validate(unavailableMeasuredFields);
  ok(
    'unavailable tokens still forbid measured fields',
    resultHasError(unavailableMeasuredResult, 'tokens.input_tokens', 'forbidden_when_unavailable')
      && resultHasError(unavailableMeasuredResult, 'tokens.output_tokens', 'forbidden_when_unavailable')
      && resultHasError(unavailableMeasuredResult, 'tokens.total_tokens', 'forbidden_when_unavailable'),
    unavailableMeasuredResult.errors.join('; '),
  );

  const invalidAvailWithMeasuredFields = deepClone(base);
  invalidAvailWithMeasuredFields.tokens = {
    availability: 'not_a_real_availability',
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
  };
  const invalidAvailMeasuredResult = validate(invalidAvailWithMeasuredFields);
  ok(
    'invalid tokens availability does not apply forbidden_when_unavailable',
    invalidAvailMeasuredResult.ok === false
      && !invalidAvailMeasuredResult.errors.some((e) => e.includes('forbidden_when_unavailable')),
    invalidAvailMeasuredResult.errors.join('; '),
  );

  const unavailableCostKnownFields = deepClone(base);
  unavailableCostKnownFields.cost = {
    state: 'unavailable',
    amount_micros: 1,
    currency: 'USD',
  };
  const unavailableCostResult = validate(unavailableCostKnownFields);
  ok(
    'unavailable cost still forbids amount/currency',
    resultHasError(unavailableCostResult, 'cost.amount_micros', 'forbidden_when_unavailable')
      && resultHasError(unavailableCostResult, 'cost.currency', 'forbidden_when_unavailable'),
    unavailableCostResult.errors.join('; '),
  );

  const invalidCostWithKnownFields = deepClone(base);
  invalidCostWithKnownFields.cost = {
    state: 'not_a_real_state',
    amount_micros: 1,
    currency: 'USD',
  };
  const invalidCostKnownResult = validate(invalidCostWithKnownFields);
  ok(
    'invalid cost state does not apply forbidden_when_unavailable',
    invalidCostKnownResult.ok === false
      && !invalidCostKnownResult.errors.some((e) => e.includes('forbidden_when_unavailable')),
    invalidCostKnownResult.errors.join('; '),
  );

  const secretValue = deepClone(base);
  secretValue.event_id = 'sk-EXAMPLEFAKESECRETVALUE0001';
  ok('rejects secret-shaped event_id value', validate(secretValue).ok === false);

  const bearerOp = deepClone(base);
  bearerOp.operation = 'Bearer EXAMPLETOKENVALUE01';
  ok('rejects secret-shaped operation value', validate(bearerOp).ok === false);

  const passwordKey = deepClone(base);
  passwordKey.Password = 'x';
  ok('rejects case-insensitive password key', validate(passwordKey).ok === false);

  const emailKey = deepClone(base);
  emailKey.email = 'nobody@example.test';
  ok('rejects email key', validate(emailKey).ok === false);

  const phoneKey = deepClone(base);
  phoneKey.phone = '5550100';
  ok('rejects phone key', validate(phoneKey).ok === false);

  const costMissingCurrency = deepClone(base);
  costMissingCurrency.cost = { state: 'provider_reported', amount_micros: 10 };
  ok('rejects known cost without currency', validate(costMissingCurrency).ok === false);

  const costLowerCurrency = deepClone(base);
  costLowerCurrency.cost = { state: 'estimated', amount_micros: 10, currency: 'usd' };
  ok('rejects lowercase currency', validate(costLowerCurrency).ok === false);

  const costNeg = deepClone(base);
  costNeg.cost = { state: 'estimated', amount_micros: -1, currency: 'USD' };
  ok('rejects negative amount_micros', validate(costNeg).ok === false);

  const succeededWithError = deepClone(base);
  succeededWithError.error_code = 'should_not_be_here';
  ok('rejects succeeded with error_code', validate(succeededWithError).ok === false);

  const badLatency = deepClone(base);
  badLatency.latency_ms = -1;
  ok('rejects negative latency_ms', validate(badLatency).ok === false);

  const unsafeLatency = deepClone(base);
  unsafeLatency.latency_ms = Number.MAX_SAFE_INTEGER + 1;
  ok('rejects latency_ms above MAX_SAFE_INTEGER', validate(unsafeLatency).ok === false);

  const unsafeAmount = deepClone(base);
  unsafeAmount.cost = {
    state: 'estimated',
    amount_micros: Number.MAX_SAFE_INTEGER + 1,
    currency: 'USD',
  };
  ok('rejects amount_micros above MAX_SAFE_INTEGER', validate(unsafeAmount).ok === false);

  const unsafeInput = deepClone(base);
  unsafeInput.tokens = {
    availability: 'measured',
    input_tokens: Number.MAX_SAFE_INTEGER + 1,
    output_tokens: 0,
    total_tokens: Number.MAX_SAFE_INTEGER + 1,
  };
  ok('rejects input_tokens above MAX_SAFE_INTEGER', validate(unsafeInput).ok === false);

  const unsafeOutput = deepClone(base);
  unsafeOutput.tokens = {
    availability: 'measured',
    input_tokens: 0,
    output_tokens: Number.MAX_SAFE_INTEGER + 1,
    total_tokens: Number.MAX_SAFE_INTEGER + 1,
  };
  ok('rejects output_tokens above MAX_SAFE_INTEGER', validate(unsafeOutput).ok === false);

  const unsafeTotal = deepClone(base);
  unsafeTotal.tokens = {
    availability: 'measured',
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: Number.MAX_SAFE_INTEGER + 1,
  };
  ok('rejects total_tokens above MAX_SAFE_INTEGER', validate(unsafeTotal).ok === false);

  const maxSafeOk = deepClone(base);
  maxSafeOk.latency_ms = Number.MAX_SAFE_INTEGER;
  maxSafeOk.tokens = {
    availability: 'measured',
    input_tokens: Number.MAX_SAFE_INTEGER,
    output_tokens: 0,
    total_tokens: Number.MAX_SAFE_INTEGER,
  };
  maxSafeOk.cost = {
    state: 'provider_reported',
    amount_micros: Number.MAX_SAFE_INTEGER,
    currency: 'USD',
  };
  ok('allows MAX_SAFE_INTEGER for integer fields', validate(maxSafeOk).ok === true);

  const badIso = deepClone(base);
  badIso.occurred_at = '2026-07-21T12:00:00';
  ok('rejects non-UTC-Z occurred_at', validate(badIso).ok === false);

  const impossibleCal = deepClone(base);
  impossibleCal.occurred_at = '2026-02-30T12:00:00.000Z';
  ok('rejects impossible calendar occurred_at', validate(impossibleCal).ok === false);

  const impossibleApr = deepClone(base);
  impossibleApr.occurred_at = '2026-04-31T00:00:00Z';
  ok('rejects April 31 occurred_at', validate(impossibleApr).ok === false);

  const frac1 = deepClone(base);
  frac1.occurred_at = '2026-07-21T12:00:00.5Z';
  ok('allows 1 fractional digit occurred_at', validate(frac1).ok === true);

  const frac2 = deepClone(base);
  frac2.occurred_at = '2026-07-21T12:00:00.25Z';
  ok('allows 2 fractional digit occurred_at', validate(frac2).ok === true);

  const frac3 = deepClone(base);
  frac3.occurred_at = '2026-07-21T12:00:00.125Z';
  ok('allows 3 fractional digit occurred_at', validate(frac3).ok === true);

  const wrongSchema = deepClone(base);
  wrongSchema.schema_version = 'crowsnest.ai_usage.v0';
  ok('rejects unknown schema_version', validate(wrongSchema).ok === false);

  const fakeMeasuredZeroOk = deepClone(base);
  fakeMeasuredZeroOk.tokens = {
    availability: 'measured',
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };
  ok('allows measured zeros when explicitly measured', validate(fakeMeasuredZeroOk).ok === true);

  class FakeEvent {}
  const classEvent = Object.assign(new FakeEvent(), deepClone(base));
  ok('rejects class instance as event', validate(classEvent).ok === false);

  const dateEvent = Object.assign(new Date(0), deepClone(base));
  ok('rejects Date instance as event', validate(dateEvent).ok === false);

  const mapEvent = Object.assign(new Map(), deepClone(base));
  ok('rejects Map instance as event', validate(mapEvent).ok === false);

  class FakeTokens {
    constructor() {
      this.availability = 'measured';
      this.input_tokens = 1;
      this.output_tokens = 1;
      this.total_tokens = 2;
    }
  }
  const classTokens = deepClone(base);
  classTokens.tokens = new FakeTokens();
  ok('rejects class instance as tokens', validate(classTokens).ok === false);

  // Contract source must not wire provider runtime or persist
  const contractSrc = fs.readFileSync(CONTRACT_PATH, 'utf8');
  ok('contract does not require luna-ai-provider', !/luna-ai-provider/.test(contractSrc));
  ok('contract does not require staff-query-api', !/staff-query-api/.test(contractSrc));
  ok('contract does not require crowsnest-api', !/crowsnest-api/.test(contractSrc));
  ok('contract does not open network sockets', !/\b(?:http|https|net|fetch|axios)\b/.test(contractSrc));
  ok('contract does not write files', !/writeFile|appendFile|createWriteStream/.test(contractSrc));
  ok('contract does not persist or open db', !/\b(?:persist|postgres|sqlite|mongodb|redis|createPool|createClient)\b/i.test(contractSrc));
  ok('contract does not hardcode model prices', !/price_per|COST_PER|usd_per_1k|per_million/i.test(contractSrc));
  ok('doc mentions trusted tenant requirement', /trusted tenant/i.test(fs.readFileSync(DOC_PATH, 'utf8')));
  ok('doc mentions next slice adapt-without-persist', /adapt provider result without persisting|without persisting/i.test(fs.readFileSync(DOC_PATH, 'utf8')));
  ok('doc records first-source discovery', /luna-ai-provider|first-source/i.test(fs.readFileSync(DOC_PATH, 'utf8')));
  ok('doc does not claim deployed or connected', !/\b(?:deployed|wired|connected to production|live telemetry)\b/i.test(fs.readFileSync(DOC_PATH, 'utf8')));
}

console.log(`\n── verify:crowsnest-ai-usage-contract: ${pass} passed, ${fail} failed ──`);
if (fail === 0) {
  console.log('verify:crowsnest-ai-usage-contract — ALL CHECKS PASSED');
}
process.exit(fail ? 1 : 0);
