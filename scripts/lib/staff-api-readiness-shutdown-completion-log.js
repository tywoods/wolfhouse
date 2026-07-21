'use strict';

/**
 * Staff API readiness-shutdown completion log (RADAR 16Y).
 *
 * One bounded non-sensitive structured completion record per readiness shutdown,
 * emitted after bounded pool/server results are known and before listeners detach
 * / native re-signal. Enables truthful live SIGTERM lifecycle proof after deploy.
 *
 * Fields only: event, original_signal, pool_close_result, server_close_result,
 * failure_classes, completion=true. No PID, secrets, URLs, error text/stacks,
 * or timing guesses. Logger failure never blocks detach/terminate.
 */

const EVENT_NAME = 'staff_api_readiness_shutdown_completion';

/** Mirrors 16W FAILURE_CLASSES — kept local to avoid circular require with lifecycle. */
const FAILURE_CLASSES = Object.freeze([
  'pool_close_rejected',
  'pool_close_throw',
  'pool_close_timeout',
  'server_close_rejected',
  'server_close_throw',
  'server_close_timeout',
  'server_close_already_closed',
]);

const ALLOWED_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT']);
const ALLOWED_POOL_RESULTS = Object.freeze(['ok', 'rejected', 'timeout', 'throw']);
const ALLOWED_SERVER_RESULTS = Object.freeze([
  'ok',
  'rejected',
  'timeout',
  'throw',
  'already_closed',
]);

const EVENT_ALLOWED_KEYS = Object.freeze([
  'event',
  'original_signal',
  'pool_close_result',
  'server_close_result',
  'failure_classes',
  'completion',
]);

const FORBIDDEN_EVENT_KEYS = Object.freeze([
  'pid',
  'process_id',
  'url',
  'raw_url',
  'path',
  'pathname',
  'secret',
  'token',
  'password',
  'authorization',
  'cookie',
  'stack',
  'message',
  'error',
  'error_message',
  'errorMessage',
  'duration_ms',
  'elapsed_ms',
  'timing',
  'dsn',
  'connection_string',
  'key',
]);

const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]+/,
  /sk_test_[A-Za-z0-9]{20,}/,
  /whsec_[A-Za-z0-9]+/,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /password["']?\s*[:=]\s*["'][^"']{8,}/i,
  /ACCOUNT_KEY["']?\s*[:=]\s*["'][^"']{16,}/i,
  new RegExp(String.raw`postgres(?:ql)?:` + String.raw`\/\/[^\s"']+`, 'i'),
];

/**
 * @param {unknown} raw
 * @returns {'SIGTERM'|'SIGINT'|null}
 */
function allowlistSignal(raw) {
  const s = String(raw || '');
  return ALLOWED_SIGNALS.includes(s) ? s : null;
}

/**
 * @param {unknown} raw
 * @returns {'ok'|'rejected'|'timeout'|'throw'|null}
 */
function allowlistPoolResult(raw) {
  const s = String(raw || '');
  return ALLOWED_POOL_RESULTS.includes(s) ? s : null;
}

/**
 * @param {unknown} raw
 * @returns {'ok'|'rejected'|'timeout'|'throw'|'already_closed'|null}
 */
function allowlistServerResult(raw) {
  const s = String(raw || '');
  return ALLOWED_SERVER_RESULTS.includes(s) ? s : null;
}

/**
 * Bound failure_classes to the 16W enum only; drop unknowns; preserve order uniqueness.
 * @param {unknown} raw
 * @returns {string[]}
 */
function allowlistFailureClasses(raw) {
  const allowed = Array.isArray(FAILURE_CLASSES) ? FAILURE_CLASSES : [];
  const input = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of input) {
    const s = String(item || '');
    if (allowed.includes(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Build allowlisted shutdown completion record. Never includes PID/secrets/URLs/errors/timing.
 * @param {{
 *   original_signal?: unknown,
 *   pool_close_result?: unknown,
 *   server_close_result?: unknown,
 *   failure_classes?: unknown,
 * }} fields
 * @returns {object|null}
 */
function buildShutdownCompletionRecord(fields) {
  const original_signal = allowlistSignal(fields && fields.original_signal);
  const pool_close_result = allowlistPoolResult(fields && fields.pool_close_result);
  const server_close_result = allowlistServerResult(fields && fields.server_close_result);
  if (!original_signal || !pool_close_result || !server_close_result) return null;

  const record = {
    event: EVENT_NAME,
    original_signal,
    pool_close_result,
    server_close_result,
    failure_classes: allowlistFailureClasses(fields && fields.failure_classes),
    completion: true,
  };

  const out = {};
  for (const key of EVENT_ALLOWED_KEYS) {
    out[key] = record[key];
  }
  for (const bad of FORBIDDEN_EVENT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, bad)) {
      delete out[bad];
    }
  }
  return out;
}

/**
 * Default production logger: exactly one JSON line to stdout.
 * @param {object} record
 */
function defaultShutdownCompletionLogger(record) {
  console.log(JSON.stringify(record));
}

/** @type {(record: object) => void} */
let shutdownCompletionLogger = defaultShutdownCompletionLogger;

/**
 * Test harness override. Pass null to restore default.
 * @param {((record: object) => void) | null} fn
 */
function setShutdownCompletionLogger(fn) {
  shutdownCompletionLogger = typeof fn === 'function' ? fn : defaultShutdownCompletionLogger;
}

/**
 * Emit one allowlisted completion record. Logger failures swallowed.
 * @param {{
 *   original_signal?: unknown,
 *   pool_close_result?: unknown,
 *   server_close_result?: unknown,
 *   failure_classes?: unknown,
 *   logger?: ((record: object) => void) | null,
 * }} fields
 */
function emitStaffApiReadinessShutdownCompleted(fields) {
  try {
    const record = buildShutdownCompletionRecord(fields || {});
    if (!record) return;

    const logger = fields && typeof fields.logger === 'function'
      ? fields.logger
      : shutdownCompletionLogger;

    try {
      logger(record);
    } catch (_) {
      // Logger failure must not block detach / native termination.
    }
  } catch (_) {
    // Never let completion logging break shutdown.
  }
}

/**
 * Assert a record matches the safe 16Y completion contract (for verifiers).
 * @param {object} event
 * @returns {{ ok: boolean, detail?: string }}
 */
function assertSafeShutdownCompletionRecord(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, detail: 'event_not_object' };
  }
  if (event.event !== EVENT_NAME) {
    return { ok: false, detail: 'bad_event_name' };
  }
  for (const key of Object.keys(event)) {
    if (!EVENT_ALLOWED_KEYS.includes(key)) {
      return { ok: false, detail: `unexpected_key:${key}` };
    }
    if (FORBIDDEN_EVENT_KEYS.includes(key)) {
      return { ok: false, detail: `forbidden_key:${key}` };
    }
  }
  for (const key of EVENT_ALLOWED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(event, key)) {
      return { ok: false, detail: `missing_key:${key}` };
    }
  }
  if (!ALLOWED_SIGNALS.includes(String(event.original_signal || ''))) {
    return { ok: false, detail: 'bad_original_signal' };
  }
  if (!ALLOWED_POOL_RESULTS.includes(String(event.pool_close_result || ''))) {
    return { ok: false, detail: 'bad_pool_close_result' };
  }
  if (!ALLOWED_SERVER_RESULTS.includes(String(event.server_close_result || ''))) {
    return { ok: false, detail: 'bad_server_close_result' };
  }
  if (!Array.isArray(event.failure_classes)) {
    return { ok: false, detail: 'bad_failure_classes' };
  }
  for (const fc of event.failure_classes) {
    if (!FAILURE_CLASSES.includes(fc)) {
      return { ok: false, detail: `unknown_failure_class:${fc}` };
    }
  }
  if (event.completion !== true) {
    return { ok: false, detail: 'completion_not_true' };
  }
  const blob = JSON.stringify(event);
  for (const re of SECRET_PATTERNS) {
    if (re.test(blob)) {
      return { ok: false, detail: `secret_pattern:${re}` };
    }
  }
  if (/\bpid\b|"duration_ms"|"elapsed_ms"|Error:|at\s+\S+\s+\(/i.test(blob)) {
    return { ok: false, detail: 'leaky_blob_shape' };
  }
  return { ok: true };
}

/**
 * Parse completion records from captured console lines.
 * @param {string[]} lines
 * @returns {object[]}
 */
function parseShutdownCompletionRecordsFromConsole(lines) {
  const out = [];
  for (const line of lines || []) {
    const s = String(line || '').trim();
    if (!s.includes(EVENT_NAME)) continue;
    const idx = s.indexOf('{');
    if (idx < 0) continue;
    try {
      const obj = JSON.parse(s.slice(idx));
      if (obj && obj.event === EVENT_NAME) out.push(obj);
    } catch (_) {
      // ignore non-JSON noise
    }
  }
  return out;
}

module.exports = {
  EVENT_NAME,
  EVENT_ALLOWED_KEYS,
  FORBIDDEN_EVENT_KEYS,
  ALLOWED_SIGNALS,
  ALLOWED_POOL_RESULTS,
  ALLOWED_SERVER_RESULTS,
  allowlistSignal,
  allowlistPoolResult,
  allowlistServerResult,
  allowlistFailureClasses,
  buildShutdownCompletionRecord,
  emitStaffApiReadinessShutdownCompleted,
  defaultShutdownCompletionLogger,
  setShutdownCompletionLogger,
  assertSafeShutdownCompletionRecord,
  parseShutdownCompletionRecordsFromConsole,
};
