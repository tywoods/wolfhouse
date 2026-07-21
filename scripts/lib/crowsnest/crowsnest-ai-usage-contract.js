'use strict';

/**
 * Crowsnest AI usage event contract — pure validator only (Slice 2).
 * Secret-free, tenant-aware, closed schema. No storage, network, or provider wiring.
 */

const SCHEMA_VERSION = 'crowsnest.ai_usage.v1';

const TOP_LEVEL_KEYS = Object.freeze([
  'schema_version',
  'event_id',
  'occurred_at',
  'client_slug',
  'tenant_id',
  'source_service',
  'operation',
  'provider',
  'model',
  'status',
  'error_code',
  'tokens',
  'latency_ms',
  'cost',
]);

const TOKEN_MEASURED_KEYS = Object.freeze([
  'availability',
  'input_tokens',
  'output_tokens',
  'total_tokens',
]);

const TOKEN_UNAVAILABLE_KEYS = Object.freeze(['availability']);

const COST_KNOWN_KEYS = Object.freeze(['state', 'amount_micros', 'currency']);
const COST_UNAVAILABLE_KEYS = Object.freeze(['state']);

const PROVIDERS = Object.freeze(['openai', 'anthropic']);
const STATUSES = Object.freeze(['succeeded', 'failed']);
const TOKEN_AVAILABILITY = Object.freeze(['measured', 'unavailable']);
const COST_STATES = Object.freeze(['provider_reported', 'estimated', 'unavailable']);

/** Keys never allowed anywhere in the event tree (case-insensitive, separators stripped). */
const SENSITIVE_KEY_NORMS = Object.freeze(new Set([
  'actor',
  'guest',
  'booking',
  'conversation',
  'session',
  'thread',
  'prompt',
  'response',
  'message',
  'messages',
  'transcript',
  'phone',
  'email',
  'name',
  'apikey',
  'api_key',
  'secret',
  'password',
  'authorization',
  'cookie',
  'cookies',
  'metadata',
  'payload',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'privatekey',
  'private_key',
  'credential',
  'credentials',
  'errormessage',
  'error_message',
  'errorbody',
  'error_body',
  'rawerror',
  'raw_error',
]));

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const ERROR_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const SECRET_VALUE_RES = Object.freeze([
  /^sk-[A-Za-z0-9]{10,}/,
  /^sk-ant-[A-Za-z0-9_-]{10,}/,
  /^Bearer\s+/i,
  /-----BEGIN (?:RSA )?PRIVATE KEY-----/,
]);

function normalizeKey(key) {
  return String(key || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function pushError(errors, path, message) {
  errors.push(path ? `${path}: ${message}` : message);
}

function rejectSensitiveKeys(node, path, errors) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      rejectSensitiveKeys(node[i], `${path}[${i}]`, errors);
    }
    return;
  }
  if (!isPlainObject(node)) return;
  for (const key of Object.keys(node)) {
    const norm = normalizeKey(key);
    const childPath = path ? `${path}.${key}` : key;
    if (SENSITIVE_KEY_NORMS.has(norm) || SENSITIVE_KEY_NORMS.has(norm.replace(/_/g, ''))) {
      pushError(errors, childPath, 'sensitive_key_forbidden');
    }
    rejectSensitiveKeys(node[key], childPath, errors);
  }
}

function assertClosedObject(node, path, allowed, errors) {
  if (!isPlainObject(node)) {
    pushError(errors, path, 'must_be_object');
    return false;
  }
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) {
      pushError(errors, path ? `${path}.${key}` : key, 'unknown_field');
    }
  }
  return true;
}

function assertSafeId(value, path, errors, pattern) {
  if (typeof value !== 'string' || value.trim() === '') {
    pushError(errors, path, 'required_non_empty_string');
    return;
  }
  if (value !== value.trim()) {
    pushError(errors, path, 'no_leading_trailing_whitespace');
    return;
  }
  if (!(pattern || SAFE_ID_RE).test(value)) {
    pushError(errors, path, 'unsafe_identifier');
    return;
  }
  for (const re of SECRET_VALUE_RES) {
    if (re.test(value)) {
      pushError(errors, path, 'secret_shaped_value');
      return;
    }
  }
}

function assertNonNegInt(value, path, errors) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    pushError(errors, path, 'must_be_non_negative_integer');
  }
}

function assertOccurredAt(value, path, errors) {
  if (typeof value !== 'string' || !ISO_UTC_RE.test(value)) {
    pushError(errors, path, 'must_be_utc_iso_z');
    return;
  }
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/,
  );
  if (!match) {
    pushError(errors, path, 'must_be_utc_iso_z');
    return;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const frac = match[7] || '';
  const ms = Number((frac + '000').slice(0, 3));
  const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  if (
    dt.getUTCFullYear() !== year
    || dt.getUTCMonth() + 1 !== month
    || dt.getUTCDate() !== day
    || dt.getUTCHours() !== hour
    || dt.getUTCMinutes() !== minute
    || dt.getUTCSeconds() !== second
    || dt.getUTCMilliseconds() !== ms
  ) {
    pushError(errors, path, 'invalid_timestamp');
  }
}

function validateTokens(tokens, errors) {
  if (!isPlainObject(tokens)) {
    pushError(errors, 'tokens', 'must_be_object');
    return;
  }
  const availability = tokens.availability;
  if (availability === 'measured') {
    assertClosedObject(tokens, 'tokens', TOKEN_MEASURED_KEYS, errors);
    assertNonNegInt(tokens.input_tokens, 'tokens.input_tokens', errors);
    assertNonNegInt(tokens.output_tokens, 'tokens.output_tokens', errors);
    assertNonNegInt(tokens.total_tokens, 'tokens.total_tokens', errors);
    if (
      Number.isSafeInteger(tokens.input_tokens)
      && Number.isSafeInteger(tokens.output_tokens)
      && Number.isSafeInteger(tokens.total_tokens)
      && tokens.total_tokens !== tokens.input_tokens + tokens.output_tokens
    ) {
      pushError(errors, 'tokens.total_tokens', 'must_equal_input_plus_output');
    }
    return;
  }
  if (availability === 'unavailable') {
    assertClosedObject(tokens, 'tokens', TOKEN_UNAVAILABLE_KEYS, errors);
    for (const banned of ['input_tokens', 'output_tokens', 'total_tokens']) {
      if (Object.prototype.hasOwnProperty.call(tokens, banned)) {
        pushError(errors, `tokens.${banned}`, 'forbidden_when_unavailable');
      }
    }
    return;
  }
  // Invalid discriminator: still close against the union of branch keys (measured set).
  assertClosedObject(tokens, 'tokens', TOKEN_MEASURED_KEYS, errors);
  pushError(errors, 'tokens.availability', 'must_be_measured_or_unavailable');
}

function validateCost(cost, errors) {
  if (!isPlainObject(cost)) {
    pushError(errors, 'cost', 'must_be_object');
    return;
  }
  const state = cost.state;
  if (state === 'provider_reported' || state === 'estimated') {
    assertClosedObject(cost, 'cost', COST_KNOWN_KEYS, errors);
    assertNonNegInt(cost.amount_micros, 'cost.amount_micros', errors);
    if (typeof cost.currency !== 'string' || !CURRENCY_RE.test(cost.currency)) {
      pushError(errors, 'cost.currency', 'must_be_uppercase_iso4217');
    }
    return;
  }
  if (state === 'unavailable') {
    assertClosedObject(cost, 'cost', COST_UNAVAILABLE_KEYS, errors);
    for (const banned of ['amount_micros', 'currency']) {
      if (Object.prototype.hasOwnProperty.call(cost, banned)) {
        pushError(errors, `cost.${banned}`, 'forbidden_when_unavailable');
      }
    }
    return;
  }
  // Invalid discriminator: still close against the union of branch keys (known set).
  assertClosedObject(cost, 'cost', COST_KNOWN_KEYS, errors);
  pushError(errors, 'cost.state', 'must_be_provider_reported_estimated_or_unavailable');
}

/**
 * Validate a Crowsnest AI usage event.
 * @param {unknown} event
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateCrowsnestAiUsageEvent(event) {
  const errors = [];

  if (!isPlainObject(event)) {
    return { ok: false, errors: ['event: must_be_object'] };
  }

  rejectSensitiveKeys(event, '', errors);
  assertClosedObject(event, '', TOP_LEVEL_KEYS, errors);

  if (event.schema_version !== SCHEMA_VERSION) {
    pushError(errors, 'schema_version', 'must_be_crowsnest.ai_usage.v1');
  }

  assertSafeId(event.event_id, 'event_id', errors);
  assertOccurredAt(event.occurred_at, 'occurred_at', errors);
  assertSafeId(event.client_slug, 'client_slug', errors);
  assertSafeId(event.tenant_id, 'tenant_id', errors);
  assertSafeId(event.source_service, 'source_service', errors, SAFE_LABEL_RE);
  assertSafeId(event.operation, 'operation', errors, SAFE_LABEL_RE);

  if (!PROVIDERS.includes(event.provider)) {
    pushError(errors, 'provider', 'must_be_openai_or_anthropic');
  }

  assertSafeId(event.model, 'model', errors, MODEL_RE);

  if (!STATUSES.includes(event.status)) {
    pushError(errors, 'status', 'must_be_succeeded_or_failed');
  }

  const hasErrorCode = Object.prototype.hasOwnProperty.call(event, 'error_code');
  if (event.status === 'failed') {
    if (!hasErrorCode) {
      pushError(errors, 'error_code', 'required_when_failed');
    } else {
      assertSafeId(event.error_code, 'error_code', errors, ERROR_CODE_RE);
    }
  } else if (hasErrorCode) {
    pushError(errors, 'error_code', 'forbidden_when_succeeded');
  }

  if (!Object.prototype.hasOwnProperty.call(event, 'tokens')) {
    pushError(errors, 'tokens', 'required');
  } else {
    validateTokens(event.tokens, errors);
  }

  if (!Object.prototype.hasOwnProperty.call(event, 'latency_ms')) {
    pushError(errors, 'latency_ms', 'required');
  } else {
    assertNonNegInt(event.latency_ms, 'latency_ms', errors);
  }

  if (!Object.prototype.hasOwnProperty.call(event, 'cost')) {
    pushError(errors, 'cost', 'required');
  } else {
    validateCost(event.cost, errors);
  }

  // client_slug and tenant_id are independent; never infer equivalence.
  return { ok: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION,
  PROVIDERS,
  STATUSES,
  TOKEN_AVAILABILITY,
  COST_STATES,
  validateCrowsnestAiUsageEvent,
};
