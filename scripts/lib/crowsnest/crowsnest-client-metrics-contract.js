'use strict';

/**
 * Crowsnest client operational-metrics event contract (v1).
 *
 * Secret-free, tenant-aware **event shape + pure validator** for the per-client
 * operational numbers shown on the Spyglass dashboard (Pupil groundwork). This
 * module defines the CONTRACT ONLY — no storage, no DB, no network, no UI.
 *
 * Each event is a point-in-time snapshot of aggregate counts for ONE client:
 * how many conversations Luna is holding, message volume, and how many
 * conversations currently need a human. These map to real columns on the tenant
 * `conversations` / `messages` tables (conversations.needs_human, status,
 * updated_at, and message rows), but this contract does not read them.
 *
 * Privacy: aggregate counts and timestamps only. Never guest/operator content,
 * phone/email/name, message text, or secrets (see SENSITIVE_KEY_NORMS). Closed
 * schema — unknown top-level or nested fields are rejected.
 *
 * Identity: `client_slug` and `tenant_id` are BOTH required and independent;
 * neither is derived from the other. Emitters must supply trusted values from an
 * authenticated tenant context.
 *
 * needs_human note: `conversations_needing_human` counts `conversations.needs_human = true`.
 * Its operational meaning varies by client — for most clients it pauses Luna, for
 * Sunset it is an inbox-only flag — but the count itself is uniform.
 */

const SCHEMA_VERSION = 'crowsnest.client_metrics.v1';

const TOP_LEVEL_KEYS = Object.freeze([
  'schema_version',
  'snapshot_id',
  'captured_at',
  'client_slug',
  'tenant_id',
  'source_service',
  'window',
  'metrics',
]);

const WINDOW_KEYS = Object.freeze(['kind', 'days']);
const WINDOW_KINDS = Object.freeze(['rolling_24h', 'rolling_7d', 'today', 'all_time']);

const METRICS_MEASURED_KEYS = Object.freeze([
  'availability',
  'conversations_total',
  'conversations_active',
  'conversations_needing_human',
  'messages_last_24h',
  'messages_per_day_avg',
  'last_activity_at',
]);
const METRICS_UNAVAILABLE_KEYS = Object.freeze(['availability']);
const METRIC_AVAILABILITY = Object.freeze(['measured', 'unavailable']);

/** Keys never allowed anywhere in the event tree (case-insensitive, separators stripped). */
const SENSITIVE_KEY_NORMS = Object.freeze(new Set([
  'actor', 'guest', 'booking', 'conversation', 'session', 'thread',
  'prompt', 'response', 'message', 'messages', 'transcript',
  'phone', 'email', 'name', 'apikey', 'api_key', 'secret', 'password',
  'authorization', 'cookie', 'cookies', 'metadata', 'payload',
  'accesstoken', 'access_token', 'refreshtoken', 'refresh_token',
  'privatekey', 'private_key', 'credential', 'credentials',
]));

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
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
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function pushError(errors, path, message) {
  errors.push(path ? `${path}: ${message}` : message);
}

function rejectSensitiveKeys(node, path, errors) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) rejectSensitiveKeys(node[i], `${path}[${i}]`, errors);
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

function assertNonNegNumber(value, path, errors) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    pushError(errors, path, 'must_be_non_negative_number');
  }
}

function isCanonicalUtcInstant(value) {
  const match = String(value).match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/,
  );
  if (!match) return false;
  const [y, mo, d, h, mi, s] = match.slice(1, 7).map(Number);
  const ms = Number(((match[7] || '') + '000').slice(0, 3));
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === mo && dt.getUTCDate() === d
    && dt.getUTCHours() === h && dt.getUTCMinutes() === mi && dt.getUTCSeconds() === s
    && dt.getUTCMilliseconds() === ms
  );
}

function assertCapturedAt(value, path, errors) {
  if (typeof value !== 'string' || !ISO_UTC_RE.test(value)) {
    pushError(errors, path, 'must_be_utc_iso_z');
    return;
  }
  if (!isCanonicalUtcInstant(value)) {
    pushError(errors, path, 'invalid_timestamp');
  }
}

function assertNullableTimestamp(value, path, errors) {
  if (value === null) return; // explicitly allowed: client has no activity yet
  if (typeof value !== 'string' || !ISO_UTC_RE.test(value) || !isCanonicalUtcInstant(value)) {
    pushError(errors, path, 'must_be_utc_iso_z_or_null');
  }
}

function validateWindow(window, errors) {
  if (!assertClosedObject(window, 'window', WINDOW_KEYS, errors)) return;
  if (!WINDOW_KINDS.includes(window.kind)) {
    pushError(errors, 'window.kind', 'invalid_window_kind');
  }
  if ('days' in window) assertNonNegInt(window.days, 'window.days', errors);
}

function validateMetrics(metrics, errors) {
  if (!isPlainObject(metrics)) {
    pushError(errors, 'metrics', 'must_be_object');
    return;
  }
  const availability = metrics.availability;
  if (!METRIC_AVAILABILITY.includes(availability)) {
    pushError(errors, 'metrics.availability', 'invalid_availability');
    // Still enforce closed shape against the measured superset to surface stray keys.
    assertClosedObject(metrics, 'metrics', METRICS_MEASURED_KEYS, errors);
    return;
  }
  if (availability === 'unavailable') {
    // No numbers may ride along on an unavailable snapshot.
    assertClosedObject(metrics, 'metrics', METRICS_UNAVAILABLE_KEYS, errors);
    return;
  }
  // measured: full set required, all present and valid.
  assertClosedObject(metrics, 'metrics', METRICS_MEASURED_KEYS, errors);
  assertNonNegInt(metrics.conversations_total, 'metrics.conversations_total', errors);
  assertNonNegInt(metrics.conversations_active, 'metrics.conversations_active', errors);
  assertNonNegInt(metrics.conversations_needing_human, 'metrics.conversations_needing_human', errors);
  assertNonNegInt(metrics.messages_last_24h, 'metrics.messages_last_24h', errors);
  assertNonNegNumber(metrics.messages_per_day_avg, 'metrics.messages_per_day_avg', errors);
  assertNullableTimestamp(metrics.last_activity_at, 'metrics.last_activity_at', errors);
}

function validateCrowsnestClientMetricsEvent(event) {
  const errors = [];
  if (!isPlainObject(event)) {
    return { ok: false, errors: ['event: must_be_object'] };
  }
  rejectSensitiveKeys(event, '', errors);
  assertClosedObject(event, '', TOP_LEVEL_KEYS, errors);

  if (event.schema_version !== SCHEMA_VERSION) {
    pushError(errors, 'schema_version', 'must_equal_crowsnest.client_metrics.v1');
  }
  assertSafeId(event.snapshot_id, 'snapshot_id', errors);
  assertCapturedAt(event.captured_at, 'captured_at', errors);
  assertSafeId(event.client_slug, 'client_slug', errors);
  assertSafeId(event.tenant_id, 'tenant_id', errors);
  assertSafeId(event.source_service, 'source_service', errors, SAFE_LABEL_RE);
  validateWindow(event.window, errors);
  validateMetrics(event.metrics, errors);

  return { ok: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION,
  TOP_LEVEL_KEYS,
  WINDOW_KINDS,
  METRICS_MEASURED_KEYS,
  METRIC_AVAILABILITY,
  validateCrowsnestClientMetricsEvent,
};
