'use strict';

/**
 * Staff admin email-delta operator recovery routes (Sunset-staging; default-off).
 *
 * Paths:
 *   GET  /staff/admin/email-settings/delta/recovery/status
 *   POST /staff/admin/email-settings/delta/recovery/restart-generation
 *   POST /staff/admin/email-settings/delta/recovery/reconcile
 *
 * Full gate (composition-owned isEmailDeltaOperatorRecoveryEnabled) evaluated
 * before auth/body/DB/owner load. Disabled/malformed/wrong tenant/deployment →
 * exact concealed 404 { success:false, error:'not_found' }.
 *
 * Auth: requireAuth admin (router) + explicit Sunset ACL + exact route authz.
 * Tenant fixed from deployment resolve (never HTTP). Actor from auth only.
 * Canonical selectors: location_id (slug) + endpoint_id (uuid).
 * Provider tenant/mailbox private (service-owned; never HTTP/DTO/log).
 *
 * POST content-type: exact application/json with optional charset=utf-8 only,
 * pinned header access, before any body read. Reject missing/text/plain/form/
 * vendor/malformed/duplicate/ambiguous → sanitized 415.
 *
 * POST body: bounded strict JSON tokenizer at the raw-body boundary (never
 * JSON.parse whole body). Rejects duplicate decoded property names at every
 * object depth (incl. escape-equivalent keys), invalid UTF-8/surrogates/
 * numbers/depth/tokens. Never logs raw body.
 *
 * GET status query: raw URLSearchParams entries — exactly one location_id and
 * one endpoint_id; reject extras/duplicates/arrays/fragments/userinfo/malformed
 * encoding before DB. Canonical lowercase endpoint UUID.
 *
 * One withPgClient loan per request; outer owns release; factory transaction
 * store on same exclusive client; no getPool/second checkout/nested release.
 *
 * HTTP mapping (bounded):
 *   200 success DTO
 *   400 invalid_request
 *   403 forbidden
 *   404 not_found / endpoint_not_found
 *   409 conflict outcomes (CAS/lease/mismatch/evidence_unavailable)
 *   415 unsupported_media_type (sanitized; never echoes header values)
 *   503 uncertain / unavailable (commit_outcome_unknown never success)
 *
 * PII-free allowlisted logs only (operation correlation IDs). No bodies/errors/
 * mailbox/cursor/tokens/content.
 *
 * @module staff-email-delta-operator-recovery-routes
 */

const http = require('http');
const util = require('util');
const {
  isEmailDeltaOperatorRecoveryEnabled,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  ENV_OPERATOR_RECOVERY_ENABLED,
  ENV_COMPOSITION_ENABLED,
  ENV_WORKER_ENABLED,
  ENV_ADMIN_ENABLED,
  ENV_DEPLOYMENT,
  ENV_TENANT,
  ENV_KV_COMPOSITION_ENABLED,
  ENV_KV_TRUSTED_HOST,
  ENV_KV_VERSIONED_KEY_ID,
} = require('./email-delta-operator-recovery-config');
const {
  createEmailDeltaOperatorRecoverySunsetStagingRuntime,
  SERVICE_OUTCOME,
} = require('./email-delta-operator-recovery-sunset-staging-runtime-composition');
const {
  RECOVERY_STATUS_KEYS,
  RECOVERY_RESULT_KEYS,
} = require('./email-delta-recovery-operation-store');

const RECOVERY_STATUS_PATH =
  '/staff/admin/email-settings/delta/recovery/status';
const RECOVERY_RESTART_PATH =
  '/staff/admin/email-settings/delta/recovery/restart-generation';
const RECOVERY_RECONCILE_PATH =
  '/staff/admin/email-settings/delta/recovery/reconcile';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_RE_CI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCATION_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const STATUS_QUERY_KEYS = Object.freeze(['location_id', 'endpoint_id']);
const RESTART_BODY_KEYS = Object.freeze([
  'operation_id',
  'location_id',
  'endpoint_id',
  'expected_generation',
  'expected_state_version',
]);
const RECONCILE_BODY_KEYS = Object.freeze([
  'operation_id',
  'location_id',
  'endpoint_id',
  'expected_generation',
  'expected_state_version',
  'target_operation_id',
]);

const STATUS_SUCCESS_KEYS = Object.freeze([
  'success',
  ...RECOVERY_STATUS_KEYS,
]);

const OPERATION_SUCCESS_KEYS = Object.freeze([
  'success',
  ...RECOVERY_RESULT_KEYS,
]);

const OPERATION_CONFLICT_KEYS = Object.freeze([
  'success',
  'error',
  ...RECOVERY_RESULT_KEYS,
]);

const RESOLVE_ROW_KEYS = Object.freeze(['client_id', 'location_id', 'endpoint_id']);
const RESOLVE_ROW_KEY_SET = new Set(RESOLVE_ROW_KEYS);

const UNAVAILABLE_ERROR = 'operator_recovery_unavailable';

/**
 * Trusted resolve: Sunset + active location + verified Microsoft delegated
 * endpoint with grant. Params: [location_slug, endpoint_id]. Never body client.
 */
const SQL_RESOLVE_OPERATOR_RECOVERY_BINDING = `
SELECT c.id::text AS client_id,
       l.id::text AS location_id,
       e.id::text AS endpoint_id
  FROM clients c
  INNER JOIN tenant_locations l
    ON l.client_id = c.id
  INNER JOIN tenant_channel_endpoints e
    ON e.client_id = c.id
   AND e.location_id = l.location_id
   AND e.id = $2::uuid
  INNER JOIN tenant_email_delegated_grants g
    ON g.client_id = c.id
   AND g.endpoint_id = e.id
 WHERE c.slug = 'sunset'
   AND l.location_id = $1
   AND l.active = true
   AND e.provider = 'microsoft_graph'
   AND e.auth_mode = 'delegated_authorization_code'
   AND e.connector_mode = 'microsoft_delegated_oauth'
   AND e.binding_status = 'verified'
   AND e.public_address IS NOT NULL
   AND btrim(e.public_address) <> ''`.replace(/\s+/g, ' ').trim();

/** Frozen gate env snapshot keys (router + handler TOCTOU-resistant). */
const GATE_ENV_KEYS = Object.freeze([
  ENV_DEPLOYMENT,
  ENV_TENANT,
  ENV_OPERATOR_RECOVERY_ENABLED,
  ENV_COMPOSITION_ENABLED,
  ENV_ADMIN_ENABLED,
  ENV_WORKER_ENABLED,
  ENV_KV_COMPOSITION_ENABLED,
  ENV_KV_TRUSTED_HOST,
  ENV_KV_VERSIONED_KEY_ID,
]);

/** Match staff-query-api readBody default; recovery POST bodies are small DTOs. */
const RECOVERY_BODY_MAX_BYTES = 10240;
const RECOVERY_JSON_MAX_DEPTH = 8;
const RECOVERY_JSON_MAX_KEYS_PER_OBJECT = 64;
const RECOVERY_JSON_MAX_ARRAY_LENGTH = 64;
const RECOVERY_JSON_MAX_STRING_LENGTH = 2048;
const RECOVERY_CONTENT_TYPE_MAX_LEN = 128;
const UNSUPPORTED_MEDIA_TYPE_ERROR = 'unsupported_media_type';
const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

// Module-init pin: genuine IncomingMessage headers via native prototype getter only.
const PINNED_INCOMING_MESSAGE = http.IncomingMessage;
const PINNED_INCOMING_MESSAGE_PROTOTYPE = http.IncomingMessage
  && http.IncomingMessage.prototype
  ? http.IncomingMessage.prototype
  : null;
const PINNED_HEADERS_DESCRIPTOR = PINNED_INCOMING_MESSAGE_PROTOTYPE
  ? Object.getOwnPropertyDescriptor(PINNED_INCOMING_MESSAGE_PROTOTYPE, 'headers')
  : null;
const PINNED_HEADERS_GET = PINNED_HEADERS_DESCRIPTOR
  && typeof PINNED_HEADERS_DESCRIPTOR.get === 'function'
  && !Object.prototype.hasOwnProperty.call(PINNED_HEADERS_DESCRIPTOR, 'value')
  ? PINNED_HEADERS_DESCRIPTOR.get
  : null;
const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;
const PINNED_URL_SEARCH_PARAMS = typeof URLSearchParams === 'function' ? URLSearchParams : null;

/**
 * Snapshot gate-relevant env values once (enumerable string data only).
 * @param {object} env
 * @returns {Readonly<object>}
 */
function snapshotOperatorRecoveryGateEnv(env) {
  const out = Object.create(null);
  const src = env && typeof env === 'object' ? env : {};
  for (const key of GATE_ENV_KEYS) {
    const v = src[key];
    if (typeof v === 'string') out[key] = v;
  }
  return Object.freeze(out);
}

function isProxySurface(value) {
  try {
    if (typeof PINNED_IS_PROXY !== 'function' || !PINNED_UTIL_TYPES) return true;
    return Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true;
  } catch {
    return true;
  }
}

function isPinnedIncomingMessage(req) {
  try {
    if (isProxySurface(req)) return false;
    if (!PINNED_HEADERS_GET || !PINNED_INCOMING_MESSAGE || !PINNED_INCOMING_MESSAGE_PROTOTYPE) {
      return false;
    }
    if (req === null || typeof req !== 'object') return false;
    if (Object.getPrototypeOf(req) !== PINNED_INCOMING_MESSAGE_PROTOTYPE) return false;
    if (req.constructor !== PINNED_INCOMING_MESSAGE) return false;
    const live = Object.getOwnPropertyDescriptor(PINNED_INCOMING_MESSAGE_PROTOTYPE, 'headers');
    if (!live || live.get !== PINNED_HEADERS_GET) return false;
    return true;
  } catch {
    return false;
  }
}

function readOwnDataValue(obj, key) {
  try {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc || !Object.prototype.hasOwnProperty.call(desc, 'value')) return undefined;
    if (desc.get || desc.set) return undefined;
    return desc.value;
  } catch {
    return undefined;
  }
}

/**
 * Secure request headers access:
 * 1) Proxy rejected
 * 2) Genuine pinned IncomingMessage → Reflect.apply module-init native getter
 * 3) Own-data plain/mock path for unit tests → readOwnData only
 */
function readRequestHeaders(req) {
  try {
    if (isProxySurface(req)) return undefined;
    if (isPinnedIncomingMessage(req)) {
      const headers = Reflect.apply(PINNED_HEADERS_GET, req, []);
      if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
        return undefined;
      }
      return headers;
    }
    return readOwnDataValue(req, 'headers');
  } catch {
    return undefined;
  }
}

function isHttpTcharCode(c) {
  if (c >= 0x30 && c <= 0x39) return true;
  if (c >= 0x41 && c <= 0x5a) return true;
  if (c >= 0x61 && c <= 0x7a) return true;
  switch (c) {
    case 0x21: case 0x23: case 0x24: case 0x25: case 0x26: case 0x27:
    case 0x2a: case 0x2b: case 0x2d: case 0x2e: case 0x5e: case 0x5f:
    case 0x60: case 0x7c: case 0x7e:
      return true;
    default:
      return false;
  }
}

/**
 * Exact request Content-Type: application/json with optional charset=utf-8 only.
 * Rejects vendor types, form, text/plain, extra params, quoted charset, CR/LF,
 * commas (multi-value), controls, trailing junk.
 * @param {string} ct
 * @returns {boolean}
 */
function isExactRequestApplicationJsonContentType(ct) {
  if (typeof ct !== 'string' || !ct) return false;
  if (ct.length > RECOVERY_CONTENT_TYPE_MAX_LEN) return false;
  for (let i = 0; i < ct.length; i += 1) {
    const c = ct.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f || c === 0x2c) return false;
  }
  if (ct.charCodeAt(0) === 0x20 || ct.charCodeAt(ct.length - 1) === 0x20) {
    return false;
  }

  let i = 0;
  const len = ct.length;
  const typeStart = i;
  while (i < len && isHttpTcharCode(ct.charCodeAt(i))) i += 1;
  if (i === typeStart) return false;
  if (i >= len || ct.charCodeAt(i) !== 0x2f) return false;
  i += 1;
  const subtypeStart = i;
  while (i < len && isHttpTcharCode(ct.charCodeAt(i))) i += 1;
  if (i === subtypeStart) return false;
  const mediaType = ct.slice(typeStart, i).toLowerCase();
  if (mediaType !== 'application/json') return false;

  // Optional single parameter: charset=utf-8 (token form only; OWS = SP only).
  while (i < len && ct.charCodeAt(i) === 0x20) i += 1;
  if (i >= len) return true;
  if (ct.charCodeAt(i) !== 0x3b) return false;
  i += 1;
  while (i < len && ct.charCodeAt(i) === 0x20) i += 1;
  if (i >= len) return false;

  const nameStart = i;
  while (i < len && isHttpTcharCode(ct.charCodeAt(i))) i += 1;
  if (i === nameStart) return false;
  const paramName = ct.slice(nameStart, i).toLowerCase();
  if (paramName !== 'charset') return false;
  if (i >= len || ct.charCodeAt(i) !== 0x3d) return false;
  i += 1;
  if (i >= len) return false;
  // Reject quoted-string charset; only token utf-8.
  if (ct.charCodeAt(i) === 0x22) return false;
  const valStart = i;
  while (i < len && isHttpTcharCode(ct.charCodeAt(i))) i += 1;
  if (i === valStart) return false;
  const paramVal = ct.slice(valStart, i).toLowerCase();
  if (paramVal !== 'utf-8') return false;
  // No further parameters / trailing junk.
  while (i < len && ct.charCodeAt(i) === 0x20) i += 1;
  return i === len;
}

/**
 * Require exact JSON media type before body read.
 * Sanitized 415 only — never echoes header values / body.
 * @param {object} req
 * @returns {{ok:true}|{ok:false,status:number,body:object}}
 */
function validateOperatorRecoveryJsonContentType(req) {
  const fail = Object.freeze({
    ok: false,
    status: 415,
    body: Object.freeze({ success: false, error: UNSUPPORTED_MEDIA_TYPE_ERROR }),
  });
  try {
    const headers = readRequestHeaders(req);
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return fail;

    const values = [];
    const keys = Reflect.ownKeys(headers);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (typeof key !== 'string') return fail;
      if (key.toLowerCase() !== 'content-type') continue;
      const desc = Object.getOwnPropertyDescriptor(headers, key);
      if (!desc
          || !Object.prototype.hasOwnProperty.call(desc, 'value')
          || desc.get
          || desc.set
          || !desc.enumerable) {
        return fail;
      }
      values.push(desc.value);
    }
    if (values.length === 0) return fail;
    if (values.length > 1) return fail;
    const ct = values[0];
    // Node may join duplicate Content-Type with ", " → rejected by comma ban.
    if (typeof ct !== 'string') return fail;
    if (Array.isArray(ct)) return fail;
    if (!isExactRequestApplicationJsonContentType(ct)) return fail;
    return Object.freeze({ ok: true });
  } catch {
    return fail;
  }
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isAsciiWs(c) {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

/**
 * Bounded strict JSON tokenizer/parser.
 * Detects duplicate decoded property names recursively (including Unicode-escape
 * aliases). Rejects invalid numbers, unpaired surrogates, over-depth, dangerous
 * keys, trailing junk. Does not use whole-body JSON.parse or regex key scans.
 * Never logs input.
 * @param {string} text
 * @returns {unknown}
 */
function parseStrictJsonNoDuplicateKeys(text) {
  if (typeof text !== 'string') throw new Error('strict_json_fail');
  let at = 0;
  const fail = () => { throw new Error('strict_json_fail'); };
  const ws = () => {
    while (at < text.length && isAsciiWs(text.charCodeAt(at))) at += 1;
  };

  function parseString() {
    if (text.charCodeAt(at) !== 0x22) fail();
    const start = at;
    at += 1;
    let escaped = false;
    while (at < text.length) {
      const code = text.charCodeAt(at);
      if (!escaped && code === 0x22) {
        at += 1;
        // Decode a single JSON string token only (not the whole body).
        let result;
        try {
          result = JSON.parse(text.slice(start, at));
        } catch {
          fail();
        }
        if (typeof result !== 'string') fail();
        if (result.length > RECOVERY_JSON_MAX_STRING_LENGTH) fail();
        if (hasUnpairedSurrogate(result)) fail();
        return result;
      }
      if (!escaped && code < 0x20) fail();
      if (!escaped && code === 0x5c) {
        escaped = true;
      } else {
        escaped = false;
      }
      at += 1;
    }
    fail();
  }

  function parseNumber() {
    const start = at;
    if (text.charCodeAt(at) === 0x2d) at += 1;
    if (at >= text.length) fail();
    const first = text.charCodeAt(at);
    if (first === 0x30) {
      at += 1;
    } else if (first >= 0x31 && first <= 0x39) {
      at += 1;
      while (at < text.length) {
        const d = text.charCodeAt(at);
        if (d < 0x30 || d > 0x39) break;
        at += 1;
      }
    } else {
      fail();
    }
    if (at < text.length && text.charCodeAt(at) === 0x2e) {
      at += 1;
      if (at >= text.length) fail();
      const d = text.charCodeAt(at);
      if (d < 0x30 || d > 0x39) fail();
      at += 1;
      while (at < text.length) {
        const dd = text.charCodeAt(at);
        if (dd < 0x30 || dd > 0x39) break;
        at += 1;
      }
    }
    if (at < text.length) {
      const e = text.charCodeAt(at);
      if (e === 0x65 || e === 0x45) {
        at += 1;
        if (at < text.length) {
          const sign = text.charCodeAt(at);
          if (sign === 0x2b || sign === 0x2d) at += 1;
        }
        if (at >= text.length) fail();
        const d = text.charCodeAt(at);
        if (d < 0x30 || d > 0x39) fail();
        at += 1;
        while (at < text.length) {
          const dd = text.charCodeAt(at);
          if (dd < 0x30 || dd > 0x39) break;
          at += 1;
        }
      }
    }
    const lexeme = text.slice(start, at);
    // Reject leading-zero forms already handled; reject non-JSON number junk.
    if (lexeme === '-' || lexeme === '' || lexeme === '.' || lexeme === '-.') fail();
    const number = Number(lexeme);
    if (!Number.isFinite(number)) fail();
    return number;
  }

  function parseValue(depth) {
    if (depth > RECOVERY_JSON_MAX_DEPTH) fail();
    ws();
    if (at >= text.length) fail();
    const c = text.charCodeAt(at);
    if (c === 0x7b) return parseObject(depth + 1);
    if (c === 0x5b) return parseArray(depth + 1);
    if (c === 0x22) return parseString();
    if (c === 0x74) {
      if (text.slice(at, at + 4) !== 'true') fail();
      at += 4;
      return true;
    }
    if (c === 0x66) {
      if (text.slice(at, at + 5) !== 'false') fail();
      at += 5;
      return false;
    }
    if (c === 0x6e) {
      if (text.slice(at, at + 4) !== 'null') fail();
      at += 4;
      return null;
    }
    if (c === 0x2d || (c >= 0x30 && c <= 0x39)) return parseNumber();
    fail();
  }

  function parseObject(depth) {
    // consume '{'
    at += 1;
    const result = Object.create(null);
    const names = new Set();
    ws();
    if (at < text.length && text.charCodeAt(at) === 0x7d) {
      at += 1;
      return result;
    }
    for (;;) {
      ws();
      if (at >= text.length || text.charCodeAt(at) !== 0x22) fail();
      const key = parseString();
      if (DANGEROUS_JSON_KEYS.has(key)) fail();
      if (names.has(key)) fail();
      if (names.size >= RECOVERY_JSON_MAX_KEYS_PER_OBJECT) fail();
      names.add(key);
      ws();
      if (at >= text.length || text.charCodeAt(at) !== 0x3a) fail();
      at += 1;
      result[key] = parseValue(depth);
      ws();
      if (at >= text.length) fail();
      if (text.charCodeAt(at) === 0x7d) {
        at += 1;
        return result;
      }
      if (text.charCodeAt(at) !== 0x2c) fail();
      at += 1;
    }
  }

  function parseArray(depth) {
    at += 1;
    const result = [];
    ws();
    if (at < text.length && text.charCodeAt(at) === 0x5d) {
      at += 1;
      return result;
    }
    for (;;) {
      if (result.length >= RECOVERY_JSON_MAX_ARRAY_LENGTH) fail();
      result.push(parseValue(depth));
      ws();
      if (at >= text.length) fail();
      if (text.charCodeAt(at) === 0x5d) {
        at += 1;
        return result;
      }
      if (text.charCodeAt(at) !== 0x2c) fail();
      at += 1;
    }
  }

  const value = parseValue(0);
  ws();
  if (at !== text.length) fail();
  return value;
}

function decodeUtf8Strict(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  try {
    // fatal rejects invalid UTF-8 sequences (no replacement chars).
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/**
 * Read bounded raw body then strict-parse JSON (duplicate keys rejected).
 * Content-Type must already have been validated. Never logs raw body.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<{ok:true,body:unknown}|{ok:false,status:number,body:object}>}
 */
function readOperatorRecoveryStrictJsonBody(req) {
  const invalid = Object.freeze({
    ok: false,
    status: 400,
    body: Object.freeze({ success: false, error: 'invalid_request' }),
  });
  return new Promise((resolve) => {
    try {
      if (req && req._operatorRecoveryCachedBody !== undefined) {
        const cached = req._operatorRecoveryCachedBody;
        if (cached && cached.ok === true) {
          resolve(Object.freeze({ ok: true, body: cached.body }));
          return;
        }
        resolve(invalid);
        return;
      }
      const chunks = [];
      let total = 0;
      let oversized = false;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        try {
          if (req && typeof req === 'object') {
            req._operatorRecoveryCachedBody = result;
          }
        } catch {
          // ignore cache failures
        }
        resolve(result);
      };

      const onData = (chunk) => {
        if (settled) return;
        try {
          if (oversized) return; // drain remainder without retaining bytes
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.length;
          if (total > RECOVERY_BODY_MAX_BYTES) {
            oversized = true;
            chunks.length = 0;
            total = 0;
            return;
          }
          chunks.push(buf);
        } catch {
          oversized = true;
          chunks.length = 0;
        }
      };
      const onEnd = () => {
        if (settled) return;
        cleanup();
        if (oversized) {
          finish(invalid);
          return;
        }
        try {
          const raw = Buffer.concat(chunks, total);
          const text = decodeUtf8Strict(raw);
          if (text === null) {
            finish(invalid);
            return;
          }
          // Empty body is not a valid recovery DTO; strict parse rejects.
          let parsed;
          try {
            parsed = parseStrictJsonNoDuplicateKeys(text);
          } catch {
            finish(invalid);
            return;
          }
          finish(Object.freeze({ ok: true, body: parsed }));
        } catch {
          finish(invalid);
        }
      };
      const onError = () => {
        if (settled) return;
        cleanup();
        finish(invalid);
      };
      const cleanup = () => {
        try { req.removeListener('data', onData); } catch { /* ignore */ }
        try { req.removeListener('end', onEnd); } catch { /* ignore */ }
        try { req.removeListener('error', onError); } catch { /* ignore */ }
      };
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
    } catch {
      resolve(invalid);
    }
  });
}

/**
 * Percent-decode with strict UTF-8; rejects malformed % encodings.
 * @param {string} input
 * @returns {string|null}
 */
function strictPercentDecode(input) {
  if (typeof input !== 'string') return null;
  try {
    // Reject bare % not followed by two hex digits before decodeURIComponent.
    for (let i = 0; i < input.length; i += 1) {
      if (input.charCodeAt(i) !== 0x25) continue;
      if (i + 2 >= input.length) return null;
      const h1 = input.charCodeAt(i + 1);
      const h2 = input.charCodeAt(i + 2);
      const isHex = (c) => (c >= 0x30 && c <= 0x39)
        || (c >= 0x41 && c <= 0x46)
        || (c >= 0x61 && c <= 0x66);
      if (!isHex(h1) || !isHex(h2)) return null;
      i += 2;
    }
    const decoded = decodeURIComponent(input);
    if (hasUnpairedSurrogate(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Extract pathname + raw query from req.url. Reject userinfo, fragments in the
 * request-target, and absolute-form with credentials.
 * @param {string} rawUrl
 * @returns {{pathname:string,search:string}|null}
 */
function splitRequestTarget(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return null;
  // Reject fragments (should not appear on wire; reject if present).
  if (rawUrl.includes('#')) return null;
  // Absolute-form: scheme://[userinfo@]host/path?query
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawUrl)) {
    // userinfo before host
    const afterScheme = rawUrl.indexOf('://');
    if (afterScheme < 0) return null;
    const rest = rawUrl.slice(afterScheme + 3);
    const slash = rest.indexOf('/');
    const authority = slash < 0 ? rest : rest.slice(0, slash);
    if (authority.includes('@')) return null;
    const pathAndQuery = slash < 0 ? '/' : rest.slice(slash);
    const q = pathAndQuery.indexOf('?');
    if (q < 0) {
      return { pathname: pathAndQuery || '/', search: '' };
    }
    return {
      pathname: pathAndQuery.slice(0, q) || '/',
      search: pathAndQuery.slice(q + 1),
    };
  }
  // origin-form / path?query
  if (rawUrl.charCodeAt(0) !== 0x2f) return null;
  // Reject userinfo-looking junk in origin-form.
  if (rawUrl.includes('@')) return null;
  const q = rawUrl.indexOf('?');
  if (q < 0) return { pathname: rawUrl, search: '' };
  return {
    pathname: rawUrl.slice(0, q) || '/',
    search: rawUrl.slice(q + 1),
  };
}

/**
 * Parse status query from the raw request URL via URLSearchParams entries so
 * duplicate keys cannot collapse. Exactly one location_id + one endpoint_id.
 * @param {object} req
 * @returns {{ok:true,query:Readonly<object>}|{ok:false,status:number,body:object}}
 */
function parseOperatorRecoveryStatusQueryFromRequest(req) {
  const invalid = Object.freeze({
    ok: false,
    status: 400,
    body: Object.freeze({ success: false, error: 'invalid_request' }),
  });
  try {
    if (!req || typeof req !== 'object' || isProxySurface(req)) return invalid;
    const rawUrl = readOwnDataValue(req, 'url');
    // IncomingMessage.url is typically an own data string; also accept pinned read.
    const urlValue = typeof rawUrl === 'string'
      ? rawUrl
      : (typeof req.url === 'string' ? req.url : null);
    if (typeof urlValue !== 'string') return invalid;
    const parts = splitRequestTarget(urlValue);
    if (!parts) return invalid;
    if (!PINNED_URL_SEARCH_PARAMS) return invalid;
    // URLSearchParams over the raw query string preserves multi-value entries.
    const params = new PINNED_URL_SEARCH_PARAMS(parts.search);
    const seen = Object.create(null);
    const entries = [];
    // Iterate raw entries — duplicate keys remain distinct.
    for (const pair of params.entries()) {
      if (!Array.isArray(pair) || pair.length !== 2) return invalid;
      const key = pair[0];
      const value = pair[1];
      if (typeof key !== 'string' || typeof value !== 'string') return invalid;
      if (Object.prototype.hasOwnProperty.call(seen, key)) return invalid;
      seen[key] = true;
      entries.push([key, value]);
    }
    if (entries.length !== 2) return invalid;
    let locationId = null;
    let endpointId = null;
    for (let i = 0; i < entries.length; i += 1) {
      const key = entries[i][0];
      const value = entries[i][1];
      // Values from URLSearchParams are already percent-decoded; re-validate
      // that the original search segment had no malformed encoding by checking
      // the raw search for this key's encodings is not needed if construction
      // succeeded — but URLSearchParams is lenient on some % forms. Re-scan.
      if (key === 'location_id') {
        if (locationId !== null) return invalid;
        locationId = value;
      } else if (key === 'endpoint_id') {
        if (endpointId !== null) return invalid;
        endpointId = value;
      } else {
        return invalid;
      }
    }
    if (locationId === null || endpointId === null) return invalid;
    // Reject empty / multi-value smuggled as empty arrays (strings only here).
    if (typeof locationId !== 'string' || typeof endpointId !== 'string') return invalid;
    if (!LOCATION_SLUG_RE.test(locationId)) return invalid;
    if (!UUID_RE.test(endpointId)) return invalid;
    if (endpointId !== endpointId.toLowerCase()) return invalid;
    // Malformed encoding pass: re-parse raw search tokens with strict decoder.
    if (parts.search) {
      const pairs = parts.search.split('&');
      if (pairs.length !== 2) return invalid;
      for (let i = 0; i < pairs.length; i += 1) {
        const piece = pairs[i];
        const eq = piece.indexOf('=');
        if (eq <= 0) return invalid;
        const rawK = piece.slice(0, eq);
        const rawV = piece.slice(eq + 1);
        if (rawK.includes('+') || rawV.includes('+')) {
          // application/x-www-form-urlencoded + as space — not accepted for UUIDs/slugs
          // that must not contain spaces. URLSearchParams treats + as space; reject.
          return invalid;
        }
        const k = strictPercentDecode(rawK);
        const v = strictPercentDecode(rawV);
        if (k === null || v === null) return invalid;
        if (k !== 'location_id' && k !== 'endpoint_id') return invalid;
        if (k === 'location_id' && v !== locationId) return invalid;
        if (k === 'endpoint_id' && v !== endpointId) return invalid;
      }
    }
    return Object.freeze({
      ok: true,
      query: Object.freeze({
        location_id: locationId,
        endpoint_id: endpointId,
      }),
    });
  } catch {
    return invalid;
  }
}

function snapshotExactOwnData(body, keys) {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    if (isProxySurface(body)) return null;
    const proto = Object.getPrototypeOf(body);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(body);
    if (actual.length !== keys.length) return null;
    for (let i = 0; i < keys.length; i += 1) {
      if (actual[i] !== keys[i] || typeof actual[i] !== 'string') return null;
    }
    const out = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(body, key);
      if (!descriptor
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable) {
        return null;
      }
      out[key] = descriptor.value;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Exact status query surface: only location_id + endpoint_id own enumerable
 * data strings. Rejects extras, symbols, accessors, inherited, proxies, arrays.
 * @param {object} query
 * @returns {Readonly<{location_id:string,endpoint_id:string}>|null}
 */
function snapshotStatusQuery(query) {
  try {
    if (!query || typeof query !== 'object' || Array.isArray(query)) return null;
    if (isProxySurface(query)) return null;
    const proto = Object.getPrototypeOf(query);
    if (proto !== Object.prototype && proto !== null) return null;
    const keys = Reflect.ownKeys(query);
    if (keys.length !== STATUS_QUERY_KEYS.length) return null;
    // Allow either key order; require exact set {location_id, endpoint_id}.
    const keySet = new Set();
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (typeof key !== 'string') return null;
      if (key !== 'location_id' && key !== 'endpoint_id') return null;
      if (keySet.has(key)) return null;
      keySet.add(key);
      const desc = Object.getOwnPropertyDescriptor(query, key);
      if (!desc
          || !Object.prototype.hasOwnProperty.call(desc, 'value')
          || desc.get
          || desc.set
          || !desc.enumerable) {
        return null;
      }
      if (typeof desc.value !== 'string') return null;
      // Reject multi-value arrays smuggled as non-strings already handled.
    }
    if (!keySet.has('location_id') || !keySet.has('endpoint_id')) return null;
    const locationId = Object.getOwnPropertyDescriptor(query, 'location_id').value;
    const endpointId = Object.getOwnPropertyDescriptor(query, 'endpoint_id').value;
    if (typeof locationId !== 'string' || !LOCATION_SLUG_RE.test(locationId)) return null;
    if (typeof endpointId !== 'string' || !UUID_RE.test(endpointId)) return null;
    if (endpointId !== endpointId.toLowerCase()) return null;
    return Object.freeze({
      location_id: locationId,
      endpoint_id: endpointId,
    });
  } catch {
    return null;
  }
}

function snapshotRestartBody(body) {
  const out = snapshotExactOwnData(body, RESTART_BODY_KEYS);
  if (!out) return null;
  if (typeof out.operation_id !== 'string' || !UUID_RE.test(out.operation_id)) return null;
  if (out.operation_id !== out.operation_id.toLowerCase()) return null;
  if (typeof out.location_id !== 'string' || !LOCATION_SLUG_RE.test(out.location_id)) return null;
  if (typeof out.endpoint_id !== 'string' || !UUID_RE.test(out.endpoint_id)) return null;
  if (out.endpoint_id !== out.endpoint_id.toLowerCase()) return null;
  if (!Number.isInteger(out.expected_generation) || out.expected_generation < 1
      || out.expected_generation > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  if (!Number.isInteger(out.expected_state_version) || out.expected_state_version < 1
      || out.expected_state_version > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return Object.freeze({
    operation_id: out.operation_id,
    location_id: out.location_id,
    endpoint_id: out.endpoint_id,
    expected_generation: out.expected_generation,
    expected_state_version: out.expected_state_version,
  });
}

function snapshotReconcileBody(body) {
  const out = snapshotExactOwnData(body, RECONCILE_BODY_KEYS);
  if (!out) return null;
  if (typeof out.operation_id !== 'string' || !UUID_RE.test(out.operation_id)) return null;
  if (out.operation_id !== out.operation_id.toLowerCase()) return null;
  if (typeof out.target_operation_id !== 'string' || !UUID_RE.test(out.target_operation_id)) {
    return null;
  }
  if (out.target_operation_id !== out.target_operation_id.toLowerCase()) return null;
  if (out.operation_id === out.target_operation_id) return null;
  if (typeof out.location_id !== 'string' || !LOCATION_SLUG_RE.test(out.location_id)) return null;
  if (typeof out.endpoint_id !== 'string' || !UUID_RE.test(out.endpoint_id)) return null;
  if (out.endpoint_id !== out.endpoint_id.toLowerCase()) return null;
  if (!Number.isInteger(out.expected_generation) || out.expected_generation < 1
      || out.expected_generation > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  if (!Number.isInteger(out.expected_state_version) || out.expected_state_version < 1
      || out.expected_state_version > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return Object.freeze({
    operation_id: out.operation_id,
    location_id: out.location_id,
    endpoint_id: out.endpoint_id,
    expected_generation: out.expected_generation,
    expected_state_version: out.expected_state_version,
    target_operation_id: out.target_operation_id,
  });
}

function snapshotExactResolveRow(row) {
  try {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const keys = Reflect.ownKeys(row);
    if (keys.length !== RESOLVE_ROW_KEYS.length) return null;
    for (let i = 0; i < RESOLVE_ROW_KEYS.length; i += 1) {
      if (keys[i] !== RESOLVE_ROW_KEYS[i]) return null;
    }
    const out = Object.create(null);
    for (const key of RESOLVE_ROW_KEYS) {
      const desc = Object.getOwnPropertyDescriptor(row, key);
      if (!desc
          || !Object.prototype.hasOwnProperty.call(desc, 'value')
          || desc.get
          || desc.set
          || !desc.enumerable
          || typeof desc.value !== 'string'
          || !UUID_RE.test(desc.value.toLowerCase())) {
        return null;
      }
      out[key] = desc.value.toLowerCase();
    }
    return Object.freeze(out);
  } catch {
    return null;
  }
}

function snapshotResolveQueryResult(result) {
  try {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return Object.freeze({ kind: 'invalid' });
    }
    const rootKeys = Reflect.ownKeys(result);
    let rowsDesc = null;
    for (let i = 0; i < rootKeys.length; i += 1) {
      const key = rootKeys[i];
      if (typeof key === 'symbol') return Object.freeze({ kind: 'invalid' });
      const desc = Object.getOwnPropertyDescriptor(result, key);
      if (!desc
          || !Object.prototype.hasOwnProperty.call(desc, 'value')
          || desc.get
          || desc.set) {
        return Object.freeze({ kind: 'invalid' });
      }
      if (key === 'rows') {
        if (rowsDesc) return Object.freeze({ kind: 'invalid' });
        rowsDesc = desc;
      }
    }
    if (!rowsDesc) return Object.freeze({ kind: 'invalid' });
    const rows = rowsDesc.value;
    if (!Array.isArray(rows)) return Object.freeze({ kind: 'invalid' });
    if (Object.getPrototypeOf(rows) !== Array.prototype) {
      return Object.freeze({ kind: 'invalid' });
    }
    const lengthDesc = Object.getOwnPropertyDescriptor(rows, 'length');
    if (!lengthDesc
        || !Object.prototype.hasOwnProperty.call(lengthDesc, 'value')
        || typeof lengthDesc.value !== 'number'
        || !Number.isInteger(lengthDesc.value)
        || lengthDesc.value < 0) {
      return Object.freeze({ kind: 'invalid' });
    }
    const n = lengthDesc.value;
    if (n === 0) return Object.freeze({ kind: 'empty' });
    if (n === 1) {
      const indexDesc = Object.getOwnPropertyDescriptor(rows, '0');
      if (!indexDesc
          || !Object.prototype.hasOwnProperty.call(indexDesc, 'value')
          || indexDesc.get
          || indexDesc.set) {
        return Object.freeze({ kind: 'invalid' });
      }
      const rowSnap = snapshotExactResolveRow(indexDesc.value);
      if (!rowSnap) return Object.freeze({ kind: 'invalid' });
      return Object.freeze({ kind: 'one', row: rowSnap });
    }
    return Object.freeze({ kind: 'invalid' });
  } catch {
    return Object.freeze({ kind: 'invalid' });
  }
}

function buildStatusSuccessJson(value) {
  try {
    if (!value || typeof value !== 'object') return null;
    const dto = {};
    dto.success = true;
    for (const key of RECOVERY_STATUS_KEYS) {
      dto[key] = value[key];
    }
    const keys = Reflect.ownKeys(dto);
    if (keys.length !== STATUS_SUCCESS_KEYS.length
        || keys.join(',') !== STATUS_SUCCESS_KEYS.join(',')) {
      return null;
    }
    return Object.freeze(dto);
  } catch {
    return null;
  }
}

function buildOperationSuccessJson(value) {
  try {
    if (!value || typeof value !== 'object') return null;
    const dto = {};
    dto.success = true;
    for (const key of RECOVERY_RESULT_KEYS) {
      dto[key] = value[key];
    }
    const keys = Reflect.ownKeys(dto);
    if (keys.length !== OPERATION_SUCCESS_KEYS.length
        || keys.join(',') !== OPERATION_SUCCESS_KEYS.join(',')) {
      return null;
    }
    return Object.freeze(dto);
  } catch {
    return null;
  }
}

function buildOperationConflictJson(value, errorCode) {
  try {
    const dto = {};
    dto.success = false;
    dto.error = typeof errorCode === 'string' && errorCode ? errorCode : 'conflict';
    if (value && typeof value === 'object') {
      for (const key of RECOVERY_RESULT_KEYS) {
        dto[key] = value[key] !== undefined ? value[key] : null;
      }
    } else {
      for (const key of RECOVERY_RESULT_KEYS) {
        dto[key] = null;
      }
    }
    return Object.freeze(dto);
  } catch {
    return Object.freeze({ success: false, error: 'conflict' });
  }
}

function mapServiceToHttp(sendJSON, res, result) {
  if (!result || typeof result !== 'object') {
    return sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
  }
  if (result.ok === true && result.kind === SERVICE_OUTCOME.SUCCESS) {
    if (result.value && Object.prototype.hasOwnProperty.call(result.value, 'state_present')) {
      const json = buildStatusSuccessJson(result.value);
      if (!json) return sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
      return sendJSON(res, 200, json);
    }
    const json = buildOperationSuccessJson(result.value);
    if (!json) return sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
    return sendJSON(res, 200, json);
  }
  if (result.kind === SERVICE_OUTCOME.CONFLICT) {
    const err = typeof result.error === 'string' ? result.error : 'conflict';
    // Prefer outcome field when full DTO present.
    const outcomeErr = result.value && result.value.outcome
      ? String(result.value.outcome)
      : err;
    if (result.value && result.value.operation_id) {
      return sendJSON(res, 409, buildOperationConflictJson(result.value, outcomeErr));
    }
    return sendJSON(res, 409, { success: false, error: outcomeErr === 'operation_id_conflict'
      ? 'operation_id_conflict'
      : (outcomeErr || 'conflict') });
  }
  if (result.kind === SERVICE_OUTCOME.UNCERTAIN) {
    // Sanitized 503 — never success, never new operation id mint.
    return sendJSON(res, 503, { success: false, error: 'commit_outcome_unknown' });
  }
  if (result.kind === SERVICE_OUTCOME.NOT_FOUND) {
    return sendJSON(res, 404, { success: false, error: 'endpoint_not_found' });
  }
  if (result.kind === SERVICE_OUTCOME.INVALID) {
    return sendJSON(res, 400, { success: false, error: 'invalid_request' });
  }
  return sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
}

/**
 * Allowlisted PII-free log helper (operation correlation id only).
 * Never logs bodies/errors/mailbox/cursor/tokens/content.
 */
function logSafe(logger, event, operationId) {
  try {
    if (!logger || typeof logger.info !== 'function') return;
    const payload = { event };
    if (typeof operationId === 'string' && UUID_RE.test(operationId)) {
      payload.operation_id = operationId;
    }
    logger.info(payload);
  } catch {
    // never throw from log
  }
}

function buildRuntime(env, pg) {
  async function withTransactionClient(work) {
    return work(pg);
  }
  return createEmailDeltaOperatorRecoverySunsetStagingRuntime(Object.freeze({
    env,
    pgClient: pg,
    withTransactionClient,
  }));
}

/**
 * @param {{
 *   sendJSON: Function,
 *   withPgClient: Function,
 *   assertStaffClientAccess: Function,
 *   authorizeAuthenticatedStaffRoute: Function,
 *   runtimeEnv?: object,
 *   logger?: object,
 * }} deps
 */
function createStaffEmailDeltaOperatorRecoveryRoutes(deps) {
  const env = deps.runtimeEnv || process.env;
  const logger = deps.logger || null;

  function gateOff(gateEnv) {
    return !isEmailDeltaOperatorRecoveryEnabled(gateEnv);
  }

  function authAdminSunset(user, res, method, pathname) {
    if (!user || user.client_slug !== 'sunset'
        || !UUID_RE_CI.test(user.staff_user_id || '')
        || !UUID_RE_CI.test(user.session_id || '')) {
      deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
      return null;
    }
    if (!deps.assertStaffClientAccess(user, 'sunset', res)) return null;
    const authz = deps.authorizeAuthenticatedStaffRoute({
      clientSlug: 'sunset',
      method,
      pathname,
      env,
    });
    if (!authz.ok) {
      deps.sendJSON(res, authz.status || 403, authz.body || { success: false, error: 'forbidden' });
      return null;
    }
    return {
      actorStaffUserId: String(user.staff_user_id).toLowerCase(),
    };
  }

  async function handleStatus(query, req, res, user, gateEnv = env) {
    if (gateOff(gateEnv)) {
      return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    }
    const actor = authAdminSunset(user, res, 'GET', RECOVERY_STATUS_PATH);
    if (!actor) return undefined;
    const q = snapshotStatusQuery(query);
    if (!q) {
      return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    }
    try {
      return await deps.withPgClient(async (pg) => {
        const found = await pg.query(SQL_RESOLVE_OPERATOR_RECOVERY_BINDING, [
          q.location_id,
          q.endpoint_id,
        ]);
        const resolved = snapshotResolveQueryResult(found);
        if (resolved.kind === 'empty') {
          return deps.sendJSON(res, 404, { success: false, error: 'endpoint_not_found' });
        }
        if (resolved.kind !== 'one') {
          return deps.sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
        }
        const row = resolved.row;
        if (row.endpoint_id !== q.endpoint_id) {
          return deps.sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
        }
        const runtime = buildRuntime(env, pg);
        const result = await runtime.getStatus(Object.freeze({
          clientId: row.client_id,
          locationId: row.location_id,
          endpointId: row.endpoint_id,
        }));
        return mapServiceToHttp(deps.sendJSON, res, result);
      });
    } catch (_) {
      return deps.sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
    }
  }

  async function handleRestartGeneration(body, req, res, user, gateEnv = env) {
    if (gateOff(gateEnv)) {
      return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    }
    const actor = authAdminSunset(user, res, 'POST', RECOVERY_RESTART_PATH);
    if (!actor) return undefined;
    const b = snapshotRestartBody(body);
    if (!b) {
      return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    }
    try {
      return await deps.withPgClient(async (pg) => {
        const found = await pg.query(SQL_RESOLVE_OPERATOR_RECOVERY_BINDING, [
          b.location_id,
          b.endpoint_id,
        ]);
        const resolved = snapshotResolveQueryResult(found);
        if (resolved.kind === 'empty') {
          return deps.sendJSON(res, 404, { success: false, error: 'endpoint_not_found' });
        }
        if (resolved.kind !== 'one') {
          return deps.sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
        }
        const row = resolved.row;
        if (row.endpoint_id !== b.endpoint_id) {
          return deps.sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
        }
        const runtime = buildRuntime(env, pg);
        const result = await runtime.restartGeneration(Object.freeze({
          operationId: b.operation_id,
          clientId: row.client_id,
          locationId: row.location_id,
          endpointId: row.endpoint_id,
          actorStaffUserId: actor.actorStaffUserId,
          expectedGeneration: b.expected_generation,
          expectedStateVersion: b.expected_state_version,
        }));
        logSafe(logger, 'email_delta_operator_recovery_restart', b.operation_id);
        return mapServiceToHttp(deps.sendJSON, res, result);
      });
    } catch (_) {
      return deps.sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
    }
  }

  async function handleReconcile(body, req, res, user, gateEnv = env) {
    if (gateOff(gateEnv)) {
      return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    }
    const actor = authAdminSunset(user, res, 'POST', RECOVERY_RECONCILE_PATH);
    if (!actor) return undefined;
    const b = snapshotReconcileBody(body);
    if (!b) {
      return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    }
    try {
      return await deps.withPgClient(async (pg) => {
        const found = await pg.query(SQL_RESOLVE_OPERATOR_RECOVERY_BINDING, [
          b.location_id,
          b.endpoint_id,
        ]);
        const resolved = snapshotResolveQueryResult(found);
        if (resolved.kind === 'empty') {
          return deps.sendJSON(res, 404, { success: false, error: 'endpoint_not_found' });
        }
        if (resolved.kind !== 'one') {
          return deps.sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
        }
        const row = resolved.row;
        if (row.endpoint_id !== b.endpoint_id) {
          return deps.sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
        }
        const runtime = buildRuntime(env, pg);
        const result = await runtime.reconcilePageCommit(Object.freeze({
          operationId: b.operation_id,
          targetOperationId: b.target_operation_id,
          clientId: row.client_id,
          locationId: row.location_id,
          endpointId: row.endpoint_id,
          actorStaffUserId: actor.actorStaffUserId,
          expectedGeneration: b.expected_generation,
          expectedStateVersion: b.expected_state_version,
        }));
        logSafe(logger, 'email_delta_operator_recovery_reconcile', b.operation_id);
        return mapServiceToHttp(deps.sendJSON, res, result);
      });
    } catch (_) {
      return deps.sendJSON(res, 503, { success: false, error: UNAVAILABLE_ERROR });
    }
  }

  return Object.freeze({
    handleStatus,
    handleRestartGeneration,
    handleReconcile,
  });
}

module.exports = {
  RECOVERY_STATUS_PATH,
  RECOVERY_RESTART_PATH,
  RECOVERY_RECONCILE_PATH,
  STATUS_QUERY_KEYS,
  RESTART_BODY_KEYS,
  RECONCILE_BODY_KEYS,
  STATUS_SUCCESS_KEYS,
  OPERATION_SUCCESS_KEYS,
  SQL_RESOLVE_OPERATOR_RECOVERY_BINDING,
  GATE_ENV_KEYS,
  UNAVAILABLE_ERROR,
  UNSUPPORTED_MEDIA_TYPE_ERROR,
  RECOVERY_BODY_MAX_BYTES,
  RECOVERY_JSON_MAX_DEPTH,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  snapshotOperatorRecoveryGateEnv,
  snapshotStatusQuery,
  snapshotRestartBody,
  snapshotReconcileBody,
  snapshotResolveQueryResult,
  buildStatusSuccessJson,
  buildOperationSuccessJson,
  validateOperatorRecoveryJsonContentType,
  readOperatorRecoveryStrictJsonBody,
  parseOperatorRecoveryStatusQueryFromRequest,
  parseStrictJsonNoDuplicateKeys,
  isExactRequestApplicationJsonContentType,
  createStaffEmailDeltaOperatorRecoveryRoutes,
  isEmailDeltaOperatorRecoveryEnabled,
};
