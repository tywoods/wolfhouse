'use strict';

/**
 * Crowsnest AI usage adapter — pure mapping into crowsnest.ai_usage.v1 (Slice 3).
 * Secret-free, tenant-aware. No storage, network, pricing, or provider runtime wiring.
 *
 * Trusted identity (client_slug, tenant_id) must be supplied explicitly by the caller.
 * Never inferred from env, request objects, or provider payloads.
 *
 * Field reads use Object.getOwnPropertyDescriptor so inherited / accessor properties
 * cannot fabricate model, tokens, cost, or trusted context (accessors are never invoked).
 */

const {
  SCHEMA_VERSION,
  PROVIDERS,
  validateCrowsnestAiUsageEvent,
} = require('./crowsnest-ai-usage-contract');

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const ERROR_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const SECRET_VALUE_RES = Object.freeze([
  /^sk-[A-Za-z0-9]{10,}/,
  /^sk-ant-[A-Za-z0-9_-]{10,}/,
  /^Bearer\s+/i,
  /-----BEGIN (?:RSA )?PRIVATE KEY-----/,
]);

const COST_KNOWN_KEYS = Object.freeze(['state', 'amount_micros', 'currency']);
const COST_UNAVAILABLE_KEYS = Object.freeze(['state']);

const TRUSTED_CONTEXT_FIELDS = Object.freeze([
  ['client_slug', SAFE_ID_RE],
  ['tenant_id', SAFE_ID_RE],
  ['source_service', SAFE_LABEL_RE],
  ['operation', SAFE_LABEL_RE],
  ['event_id', SAFE_ID_RE],
]);

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fail(errors) {
  return { ok: false, errors: errors.slice() };
}

function pushError(errors, path, message) {
  errors.push(path ? `${path}: ${message}` : message);
}

/**
 * Safe own-data-property reader. Never walks the prototype chain and never
 * invokes accessors. Returns:
 *   { found: false }
 *   { found: true, accessor: true }
 *   { found: true, accessor: false, value }
 */
function readOwnDataProperty(obj, key) {
  if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function')) {
    return { found: false };
  }
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (!desc) {
    return { found: false };
  }
  if ('get' in desc || 'set' in desc) {
    return { found: true, accessor: true };
  }
  return { found: true, accessor: false, value: desc.value };
}

function isSafeNonNegInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function assertSafeString(value, path, errors, pattern) {
  if (typeof value !== 'string' || value.trim() === '') {
    pushError(errors, path, 'required_non_empty_string');
    return false;
  }
  if (value !== value.trim()) {
    pushError(errors, path, 'no_leading_trailing_whitespace');
    return false;
  }
  if (!(pattern || SAFE_ID_RE).test(value)) {
    pushError(errors, path, 'unsafe_identifier');
    return false;
  }
  for (const re of SECRET_VALUE_RES) {
    if (re.test(value)) {
      pushError(errors, path, 'secret_shaped_value');
      return false;
    }
  }
  return true;
}

function assertOccurredAt(value, path, errors) {
  if (typeof value !== 'string' || !ISO_UTC_RE.test(value)) {
    pushError(errors, path, 'must_be_utc_iso_z');
    return false;
  }
  return true;
}

function assertLatency(value, path, errors) {
  if (!isSafeNonNegInt(value)) {
    pushError(errors, path, 'must_be_non_negative_integer');
    return false;
  }
  return true;
}

/**
 * Require an own non-accessor data property. Accessors are rejected without
 * invocation; missing/inherited values are treated as absent.
 */
function requireOwnDataValue(obj, key, path, errors) {
  const read = readOwnDataProperty(obj, key);
  if (!read.found) {
    return { ok: false, missing: true };
  }
  if (read.accessor) {
    pushError(errors, path, 'must_be_own_data_property');
    return { ok: false, accessor: true };
  }
  return { ok: true, value: read.value };
}

/**
 * Validate optional explicit cost input. Returns { ok, cost?, errors }.
 * Omitted / inherited cost defaults to unavailable. Accessor cost fails closed.
 * Never computes pricing. Nested cost fields must be own non-accessor properties.
 */
function normalizeCostInput(costInput) {
  if (costInput === undefined) {
    return { ok: true, cost: { state: 'unavailable' } };
  }
  const errors = [];
  if (!isPlainObject(costInput)) {
    return { ok: false, errors: ['cost: must_be_object'] };
  }

  const stateRead = requireOwnDataValue(costInput, 'state', 'cost.state', errors);
  if (!stateRead.ok) {
    if (stateRead.missing) {
      pushError(errors, 'cost.state', 'must_be_provider_reported_estimated_or_unavailable');
    }
    return { ok: false, errors };
  }
  const state = stateRead.value;

  if (state === 'provider_reported' || state === 'estimated') {
    for (const key of Object.keys(costInput)) {
      if (!COST_KNOWN_KEYS.includes(key)) {
        pushError(errors, `cost.${key}`, 'unknown_field');
      }
    }
    const amountRead = requireOwnDataValue(costInput, 'amount_micros', 'cost.amount_micros', errors);
    if (amountRead.ok) {
      if (!isSafeNonNegInt(amountRead.value)) {
        pushError(errors, 'cost.amount_micros', 'must_be_non_negative_integer');
      }
    } else if (amountRead.missing) {
      pushError(errors, 'cost.amount_micros', 'must_be_non_negative_integer');
    }
    const currencyRead = requireOwnDataValue(costInput, 'currency', 'cost.currency', errors);
    if (currencyRead.ok) {
      if (typeof currencyRead.value !== 'string' || !CURRENCY_RE.test(currencyRead.value)) {
        pushError(errors, 'cost.currency', 'must_be_uppercase_iso4217');
      }
    } else if (currencyRead.missing) {
      pushError(errors, 'cost.currency', 'must_be_uppercase_iso4217');
    }
    if (errors.length) return { ok: false, errors };
    return {
      ok: true,
      cost: {
        state,
        amount_micros: amountRead.value,
        currency: currencyRead.value,
      },
    };
  }
  if (state === 'unavailable') {
    for (const key of Object.keys(costInput)) {
      if (!COST_UNAVAILABLE_KEYS.includes(key)) {
        pushError(errors, `cost.${key}`, 'unknown_field');
      }
    }
    for (const banned of ['amount_micros', 'currency']) {
      const bannedRead = readOwnDataProperty(costInput, banned);
      if (bannedRead.found) {
        if (bannedRead.accessor) {
          pushError(errors, `cost.${banned}`, 'must_be_own_data_property');
        } else {
          pushError(errors, `cost.${banned}`, 'forbidden_when_unavailable');
        }
      }
    }
    if (errors.length) return { ok: false, errors };
    return { ok: true, cost: { state: 'unavailable' } };
  }
  return { ok: false, errors: ['cost.state: must_be_provider_reported_estimated_or_unavailable'] };
}

/**
 * Read optional input.cost: only own non-accessor properties are considered.
 * Inherited cost → omitted (default unavailable). Accessor cost → fail closed.
 */
function normalizeOptionalCostFromInput(input) {
  if (!isPlainObject(input)) {
    return { ok: true, cost: { state: 'unavailable' } };
  }
  const costRead = readOwnDataProperty(input, 'cost');
  if (!costRead.found) {
    return { ok: true, cost: { state: 'unavailable' } };
  }
  if (costRead.accessor) {
    return { ok: false, errors: ['cost: must_be_own_data_property'] };
  }
  return normalizeCostInput(costRead.value);
}

function validateTrustedContext(input, errors) {
  if (!isPlainObject(input)) {
    pushError(errors, 'input', 'must_be_object');
    return null;
  }

  const values = Object.create(null);

  for (const [key, pattern] of TRUSTED_CONTEXT_FIELDS) {
    const read = requireOwnDataValue(input, key, key, errors);
    if (!read.ok) {
      if (read.missing) {
        assertSafeString(undefined, key, errors, pattern);
      }
      continue;
    }
    assertSafeString(read.value, key, errors, pattern);
    values[key] = read.value;
  }

  const occurredRead = requireOwnDataValue(input, 'occurred_at', 'occurred_at', errors);
  if (!occurredRead.ok) {
    if (occurredRead.missing) {
      assertOccurredAt(undefined, 'occurred_at', errors);
    }
  } else {
    assertOccurredAt(occurredRead.value, 'occurred_at', errors);
    values.occurred_at = occurredRead.value;
  }

  const latencyRead = requireOwnDataValue(input, 'latency_ms', 'latency_ms', errors);
  if (!latencyRead.ok) {
    if (latencyRead.missing) {
      assertLatency(undefined, 'latency_ms', errors);
    }
  } else {
    assertLatency(latencyRead.value, 'latency_ms', errors);
    values.latency_ms = latencyRead.value;
  }

  const providerRead = requireOwnDataValue(input, 'provider', 'provider', errors);
  if (!providerRead.ok) {
    if (providerRead.missing) {
      pushError(errors, 'provider', 'must_be_openai_or_anthropic');
    }
  } else if (!PROVIDERS.includes(providerRead.value)) {
    pushError(errors, 'provider', 'must_be_openai_or_anthropic');
  } else {
    values.provider = providerRead.value;
  }

  return values;
}

/**
 * Model fail-closed: absent, blank, unsafe, secret-shaped, inherited, or
 * accessor model identifiers are rejected. Never invent a model name.
 */
function extractSafeOwnModel(obj, errors) {
  const read = requireOwnDataValue(obj, 'model', 'model', errors);
  if (!read.ok) {
    if (read.missing) {
      assertSafeString(undefined, 'model', errors, MODEL_RE);
    }
    return null;
  }
  assertSafeString(read.value, 'model', errors, MODEL_RE);
  return typeof read.value === 'string' ? read.value : null;
}

function tokensUnavailable() {
  return { availability: 'unavailable' };
}

function tokensMeasured(inputTokens, outputTokens, totalTokens) {
  return {
    availability: 'measured',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
}

function readOwnSafeNonNegInt(obj, key) {
  const read = readOwnDataProperty(obj, key);
  if (!read.found || read.accessor) {
    return { ok: false };
  }
  if (!isSafeNonNegInt(read.value)) {
    return { ok: false };
  }
  return { ok: true, value: read.value };
}

/**
 * Map OpenAI usage technical fields only.
 * Requires own non-accessor prompt_tokens, completion_tokens, total_tokens as
 * safe non-neg ints with total === prompt + completion. Otherwise unavailable.
 */
function mapOpenAiTokens(usage) {
  if (!isPlainObject(usage)) return tokensUnavailable();
  const input = readOwnSafeNonNegInt(usage, 'prompt_tokens');
  const output = readOwnSafeNonNegInt(usage, 'completion_tokens');
  const total = readOwnSafeNonNegInt(usage, 'total_tokens');
  if (!input.ok || !output.ok || !total.ok) {
    return tokensUnavailable();
  }
  // Exact arithmetic must be safe and consistent with provider total.
  if (input.value > Number.MAX_SAFE_INTEGER - output.value) {
    return tokensUnavailable();
  }
  const sum = input.value + output.value;
  if (sum !== total.value) {
    return tokensUnavailable();
  }
  return tokensMeasured(input.value, output.value, total.value);
}

/**
 * Map Anthropic usage technical fields only.
 * total_tokens is exact safe input+output arithmetic (never read a provider total).
 * input_tokens / output_tokens must be own non-accessor properties.
 */
function mapAnthropicTokens(usage) {
  if (!isPlainObject(usage)) return tokensUnavailable();
  const input = readOwnSafeNonNegInt(usage, 'input_tokens');
  const output = readOwnSafeNonNegInt(usage, 'output_tokens');
  if (!input.ok || !output.ok) {
    return tokensUnavailable();
  }
  if (input.value > Number.MAX_SAFE_INTEGER - output.value) {
    return tokensUnavailable();
  }
  const total = input.value + output.value;
  if (!Number.isSafeInteger(total)) {
    return tokensUnavailable();
  }
  return tokensMeasured(input.value, output.value, total);
}

function mapTokens(provider, response) {
  const usageRead = readOwnDataProperty(response, 'usage');
  if (!usageRead.found || usageRead.accessor || !isPlainObject(usageRead.value)) {
    return tokensUnavailable();
  }
  if (provider === 'openai') return mapOpenAiTokens(usageRead.value);
  if (provider === 'anthropic') return mapAnthropicTokens(usageRead.value);
  return tokensUnavailable();
}

function finalizeEvent(event) {
  const result = validateCrowsnestAiUsageEvent(event);
  if (!result.ok) {
    return fail(result.errors);
  }
  return { ok: true, event };
}

/**
 * Adapt a successful native provider response into a Crowsnest AI usage event.
 *
 * Inspects only provider technical fields:
 * - openai: response.model, response.usage.{prompt_tokens,completion_tokens,total_tokens}
 * - anthropic: response.model, response.usage.{input_tokens,output_tokens}
 *
 * Never copies choices, content, messages, prompts, IDs, metadata, headers, or
 * provider client_slug/tenant_id into the event.
 *
 * @param {object} input
 * @returns {{ ok: true, event: object } | { ok: false, errors: string[] }}
 */
function adaptCrowsnestAiUsageSuccess(input) {
  const errors = [];
  const ctx = validateTrustedContext(input, errors);

  const responseRead = isPlainObject(input)
    ? readOwnDataProperty(input, 'response')
    : { found: false };
  if (!responseRead.found) {
    pushError(errors, 'response', 'required');
  } else if (responseRead.accessor) {
    pushError(errors, 'response', 'must_be_own_data_property');
  } else if (!isPlainObject(responseRead.value)) {
    pushError(errors, 'response', 'must_be_object');
  }

  const costNorm = normalizeOptionalCostFromInput(input);
  if (!costNorm.ok) {
    errors.push(...costNorm.errors);
  }

  if (errors.length) {
    return fail(errors);
  }

  // Fail-closed on model: do not guess, inherit, or invoke accessors.
  const modelErrors = [];
  const model = extractSafeOwnModel(responseRead.value, modelErrors);
  if (modelErrors.length || model == null) {
    return fail(modelErrors.length ? modelErrors : ['model: required_non_empty_string']);
  }

  const tokens = mapTokens(ctx.provider, responseRead.value);

  const event = {
    schema_version: SCHEMA_VERSION,
    event_id: ctx.event_id,
    occurred_at: ctx.occurred_at,
    client_slug: ctx.client_slug,
    tenant_id: ctx.tenant_id,
    source_service: ctx.source_service,
    operation: ctx.operation,
    provider: ctx.provider,
    model,
    status: 'succeeded',
    tokens,
    latency_ms: ctx.latency_ms,
    cost: costNorm.cost,
  };

  return finalizeEvent(event);
}

/**
 * Adapt a failed AI call into a Crowsnest AI usage event.
 *
 * Does not accept or copy a raw provider error payload. Requires only a safe
 * opaque error_code and an explicit safe model. Forces tokens and cost to
 * unavailable (ignores any cost input).
 *
 * @param {object} input
 * @returns {{ ok: true, event: object } | { ok: false, errors: string[] }}
 */
function adaptCrowsnestAiUsageFailure(input) {
  const errors = [];
  const ctx = validateTrustedContext(input, errors);

  const errorCodeRead = isPlainObject(input)
    ? requireOwnDataValue(input, 'error_code', 'error_code', errors)
    : { ok: false, missing: true };
  if (!errorCodeRead.ok) {
    if (errorCodeRead.missing) {
      pushError(errors, 'error_code', 'required_when_failed');
    }
  } else {
    assertSafeString(errorCodeRead.value, 'error_code', errors, ERROR_CODE_RE);
  }

  const modelErrors = [];
  let model = null;
  if (isPlainObject(input)) {
    model = extractSafeOwnModel(input, modelErrors);
  } else {
    assertSafeString(undefined, 'model', modelErrors, MODEL_RE);
  }
  if (modelErrors.length || model == null) {
    errors.push(...(modelErrors.length ? modelErrors : ['model: required_non_empty_string']));
  }

  if (errors.length) {
    return fail(errors);
  }

  const event = {
    schema_version: SCHEMA_VERSION,
    event_id: ctx.event_id,
    occurred_at: ctx.occurred_at,
    client_slug: ctx.client_slug,
    tenant_id: ctx.tenant_id,
    source_service: ctx.source_service,
    operation: ctx.operation,
    provider: ctx.provider,
    model,
    status: 'failed',
    error_code: errorCodeRead.value,
    tokens: tokensUnavailable(),
    latency_ms: ctx.latency_ms,
    cost: { state: 'unavailable' },
  };

  return finalizeEvent(event);
}

module.exports = {
  adaptCrowsnestAiUsageSuccess,
  adaptCrowsnestAiUsageFailure,
};
