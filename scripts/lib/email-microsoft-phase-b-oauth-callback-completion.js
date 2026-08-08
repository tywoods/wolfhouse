'use strict';
/**
 * Gate 3 Phase B PR B2a — dormant consume-once Phase B callback completion.
 * Injected completion only; server-owned intent/scope/prior; import-inert.
 * Flag exact ==='true' checked before any repository consume (zero DB when off).
 * @module email-microsoft-phase-b-oauth-callback-completion
 */
const crypto = require('crypto');
const util = require('util');
const {
  AUTHORIZATION_INTENT, SCOPE_VERSION, asCanonGen,
} = require('./email-microsoft-phase-b-reauthorization-transaction-service');
const {
  OWNER_KEYS, CALLBACK_CODE_KEYS, CALLBACK_ERROR_KEYS,
} = require('./email-microsoft-oauth-transaction-service');
const {
  resolveOptionalStageTelemetry, safeEmitStage,
} = require('./email-microsoft-oauth-stage-telemetry');

// Module-init pin: ambient util.types.isProxy monkeypatches after load must not weaken.
const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy : null;

const ERROR_CODE = 'MICROSOFT_PHASE_B_OAUTH_CALLBACK_COMPLETION_INVALID';
const ERROR_MESSAGE = 'Microsoft Phase B OAuth callback completion failed.';
const ACCEPT_METHOD = 'accept';
const COMPLETION_METHOD = 'completeAuthorization';
const COMPLETION_ACK_STATUS = 'completed';
const OUTCOME_UNKNOWN = 'outcome_unknown';
const CALLBACK_ENABLED_ENV = 'LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const PUBLIC_STATUS_INVALID = Object.freeze({ status: 'invalid_or_expired' });
const PUBLIC_STATUS_DECLINED = Object.freeze({ status: 'authorization_declined' });
const PUBLIC_STATUS_RECEIVED = Object.freeze({ status: 'authorization_received' });
const PUBLIC_STATUS_UNAVAILABLE = Object.freeze({ status: 'authorization_unavailable' });
const PUBLIC_STATUS_OUTCOME_UNKNOWN = Object.freeze({ status: 'outcome_unknown' });
const DEPENDENCY_KEYS = Object.freeze(['repository', 'completion', 'env', 'clock']);
const CONSUME_ROW_KEYS = Object.freeze([
  'id', 'location_id', 'staff_user_id', 'code_verifier', 'nonce', 'endpoint_id',
  'authorization_intent', 'scope_version', 'prior_grant_generation',
]);
const CONSUME_SET = new Set(CONSUME_ROW_KEYS);
const COMPLETION_KEYS = Object.freeze([
  'authorizationCode', 'transactionId', 'clientId', 'locationId', 'endpointId',
  'staffUserId', 'codeVerifier', 'nonce', 'applicationClientId', 'expectedPriorGrantGeneration',
]);
const CODE_OPT = Object.freeze(['session_state']);
const CODE_ALLOWED = Object.freeze(new Set([...CALLBACK_CODE_KEYS, ...CODE_OPT]));
const ERR_ALLOWED = Object.freeze(new Set(CALLBACK_ERROR_KEYS));
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const CODE_RE = /^[\x21-\x7e]{1,4096}$/;
const ERR_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SS_RE = /^[\x21-\x7e]{1,256}$/;
const SQL_CONSUME_PHASE_B_TRANSACTION = "UPDATE tenant_email_oauth_transactions SET consumed_at=$4 WHERE state_hash=$1::bytea AND client_id=$2::uuid AND auth_session_id=$3::uuid AND consumed_at IS NULL AND expires_at>$4 AND authorization_intent='phase_b_reauthorization' AND scope_version='phase_b_v1' AND prior_grant_generation IS NOT NULL AND prior_grant_generation >= 1 RETURNING id, location_id, staff_user_id, code_verifier, nonce, endpoint_id, authorization_intent, scope_version, prior_grant_generation";

function failure() {
  const e = new Error(ERROR_MESSAGE);
  Object.defineProperty(e, 'name', { value: 'MicrosoftPhaseBOauthCallbackCompletionError' });
  Object.defineProperty(e, 'code', { value: ERROR_CODE, enumerable: true });
  return Object.freeze(e);
}
/** Pinned native isProxy; missing pin / throw → treat as proxy (fail closed). Never leaks traps. */
function isProxy(v) {
  try {
    if (typeof PINNED_IS_PROXY !== 'function' || !PINNED_UTIL_TYPES) return true;
    return Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [v]) === true;
  } catch { return true; }
}
function own(o, k) {
  try {
    if (o == null || isProxy(o)) return undefined;
    const d = Object.getOwnPropertyDescriptor(o, k);
    return d && Object.prototype.hasOwnProperty.call(d, 'value') && !d.get && !d.set ? d.value : undefined;
  } catch { return undefined; }
}
function exactPlain(o, keys) {
  try {
    if (!o || isProxy(o) || Object.getPrototypeOf(o) !== Object.prototype) return false;
    const a = Reflect.ownKeys(o);
    if (a.length !== keys.length || a.some((k) => typeof k !== 'string' || !keys.includes(k))) return false;
    return keys.every((k) => {
      const d = Object.getOwnPropertyDescriptor(o, k);
      return d && Object.prototype.hasOwnProperty.call(d, 'value') && d.enumerable && !d.get && !d.set;
    });
  } catch { return false; }
}
function exactFrozen(o, keys) { return Boolean(o && Object.isFrozen(o) && exactPlain(o, keys)); }
function exactSvc(o, m) { return Boolean(exactFrozen(o, [m]) && typeof own(o, m) === 'function'); }
function snapOrdered(input, keys) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) return null;
    const p = Object.getPrototypeOf(input);
    if (p !== Object.prototype && p !== null) return null;
    const a = Reflect.ownKeys(input);
    if (a.length !== keys.length) return null;
    for (let i = 0; i < keys.length; i += 1) if (a[i] !== keys[i]) return null;
    const out = Object.create(null);
    for (const k of keys) {
      const d = Object.getOwnPropertyDescriptor(input, k);
      if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set || !d.enumerable) return null;
      out[k] = d.value;
    }
    return Object.freeze(out);
  } catch { return null; }
}
function snapUuids(input, keys) {
  const raw = snapOrdered(input, keys); if (!raw) return null;
  const out = Object.create(null);
  for (const k of keys) {
    if (typeof raw[k] !== 'string' || !UUID_RE.test(raw[k])) return null;
    out[k] = raw[k].toLowerCase();
  }
  return Object.freeze(out);
}
function readOnce(o, k) {
  try {
    if (!o || isProxy(o)) return null;
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set || !d.enumerable) return null;
    return { value: d.value };
  } catch { return null; }
}
/** Exact allowed own-data key set, order-independent (code + optional session_state). */
function snapCode(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) return null;
    const p = Object.getPrototypeOf(input);
    if (p !== Object.prototype && p !== null) return null;
    const a = Reflect.ownKeys(input);
    if (a.length < CALLBACK_CODE_KEYS.length || a.length > CODE_ALLOWED.size) return null;
    const seen = new Set();
    for (const k of a) {
      if (typeof k !== 'string' || !CODE_ALLOWED.has(k) || seen.has(k)) return null;
      seen.add(k);
    }
    for (const r of CALLBACK_CODE_KEYS) if (!seen.has(r)) return null;
    const st = readOnce(input, 'state'); const cd = readOnce(input, 'code');
    if (!st || !cd || typeof st.value !== 'string' || !B64URL_32.test(st.value)
        || typeof cd.value !== 'string' || !CODE_RE.test(cd.value)) return null;
    if (seen.has('session_state')) {
      const ss = readOnce(input, 'session_state');
      if (!ss || typeof ss.value !== 'string' || !SS_RE.test(ss.value)) return null;
    }
    return Object.freeze({ kind: 'code', state: st.value, code: cd.value });
  } catch { return null; }
}
/** Exact allowed own-data error key set, order-independent (like code semantics). */
function snapError(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) return null;
    const p = Object.getPrototypeOf(input);
    if (p !== Object.prototype && p !== null) return null;
    const a = Reflect.ownKeys(input);
    if (a.length !== CALLBACK_ERROR_KEYS.length) return null;
    const seen = new Set();
    for (const k of a) {
      if (typeof k !== 'string' || !ERR_ALLOWED.has(k) || seen.has(k)) return null;
      seen.add(k);
    }
    for (const r of CALLBACK_ERROR_KEYS) if (!seen.has(r)) return null;
    const st = readOnce(input, 'state'); const er = readOnce(input, 'error');
    if (!st || !er || typeof st.value !== 'string' || !B64URL_32.test(st.value)
        || typeof er.value !== 'string' || !ERR_RE.test(er.value)) return null;
    return Object.freeze({ kind: 'error', state: st.value, error: er.value });
  } catch { return null; }
}
function snapInput(input) {
  const c = snapCode(input); if (c) return c;
  return snapError(input);
}
function snapRow(row) {
  try {
    if (!row || typeof row !== 'object' || isProxy(row)) return null;
    const p = Object.getPrototypeOf(row);
    if (p !== Object.prototype && p !== null) return null;
    const a = Reflect.ownKeys(row);
    if (a.length !== CONSUME_ROW_KEYS.length) return null;
    for (const k of a) if (typeof k !== 'string' || !CONSUME_SET.has(k)) return null;
    const out = Object.create(null);
    for (const k of CONSUME_ROW_KEYS) {
      const d = Object.getOwnPropertyDescriptor(row, k);
      if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set || !d.enumerable) return null;
      out[k] = d.value;
    }
    return out;
  } catch { return null; }
}
function snapValidateRow(row) {
  const o = snapRow(row); if (!o) return null;
  if (!UUID_CANON.test(o.id) || !UUID_CANON.test(o.location_id)
      || !UUID_CANON.test(o.staff_user_id) || !UUID_CANON.test(o.endpoint_id)) return null;
  if (typeof o.code_verifier !== 'string' || !PKCE.test(o.code_verifier)
      || typeof o.nonce !== 'string' || !NONCE_RE.test(o.nonce)) return null;
  if (o.authorization_intent !== AUTHORIZATION_INTENT || o.scope_version !== SCOPE_VERSION) return null;
  const prior = asCanonGen(o.prior_grant_generation); if (prior == null) return null;
  return Object.freeze({
    transactionId: o.id, locationId: o.location_id, staffUserId: o.staff_user_id,
    codeVerifier: o.code_verifier, nonce: o.nonce, endpointId: o.endpoint_id,
    authorizationIntent: AUTHORIZATION_INTENT, scopeVersion: SCOPE_VERSION,
    expectedPriorGrantGeneration: prior,
  });
}
function isCallbackEnabled(env) {
  try {
    if (!env || isProxy(env)) return false;
    return env[CALLBACK_ENABLED_ENV] === 'true';
  } catch { return false; }
}
function snapEnv(env) {
  try {
    if (!env || typeof env !== 'object' || isProxy(env) || env.LUNA_DEPLOYMENT !== SUNSET_DEPLOYMENT) return null;
    const appId = env.LUNA_EMAIL_OAUTH_CLIENT_ID;
    if (typeof appId !== 'string' || !UUID_RE.test(appId)) return null;
    return Object.freeze({
      applicationClientId: appId.toLowerCase(),
      phaseBEnabled: isCallbackEnabled(env),
    });
  } catch { return null; }
}
function sealedStatus(v) {
  try {
    if (!v || isProxy(v) || !Object.isFrozen(v) || Object.getPrototypeOf(v) !== Object.prototype) return null;
    if (Reflect.ownKeys(v).length !== 1 || Reflect.ownKeys(v)[0] !== 'status') return null;
    const st = own(v, 'status');
    return (st === COMPLETION_ACK_STATUS || st === OUTCOME_UNKNOWN) ? st : null;
  } catch { return null; }
}
function pinDeps(deps) {
  if (!deps || isProxy(deps)) return null;
  const resolved = resolveOptionalStageTelemetry(deps, DEPENDENCY_KEYS);
  if (!resolved.ok || !resolved.stageTelemetry) return null;
  const repository = own(deps, 'repository');
  const completion = own(deps, 'completion');
  const env = own(deps, 'env');
  const clock = own(deps, 'clock');
  if (isProxy(repository) || isProxy(completion) || isProxy(env) || isProxy(clock)) return null;
  if (!exactSvc(repository, 'consume') || !exactSvc(completion, COMPLETION_METHOD)
      || !exactSvc(clock, 'now')) return null;
  const envSnap = snapEnv(env); if (!envSnap) return null;
  return Object.freeze({
    repository, consume: own(repository, 'consume'),
    completion, completeAuthorization: own(completion, COMPLETION_METHOD),
    applicationClientId: envSnap.applicationClientId, phaseBEnabled: envSnap.phaseBEnabled,
    clock, now: own(clock, 'now'), stageTelemetry: resolved.stageTelemetry,
  });
}
function createMicrosoftPhaseBOauthCallbackCompletionService(dependencies) {
  let pinned;
  try { pinned = pinDeps(dependencies); if (!pinned) throw failure(); } catch { throw failure(); }
  let used = false;
  async function accept(input, owner) {
    if (used) throw failure(); used = true;
    let consumed = false;
    try {
      // Exact flag gate before any repository consume / DB access / completion.
      if (!pinned.phaseBEnabled) return PUBLIC_STATUS_UNAVAILABLE;
      const ownerSnap = snapUuids(owner, OWNER_KEYS); if (!ownerSnap) throw failure();
      const inputSnap = snapInput(input); if (!inputSnap) throw failure();
      const stateHash = crypto.createHash('sha256').update(inputSnap.state, 'ascii').digest();
      if (!Buffer.isBuffer(stateHash) || stateHash.length !== 32) throw failure();
      let rawNow;
      try { rawNow = Reflect.apply(pinned.now, pinned.clock, []); } catch { throw failure(); }
      if (!(rawNow instanceof Date) || Number.isNaN(rawNow.getTime())) throw failure();
      const now = new Date(rawNow.getTime());
      let rawRow;
      try {
        rawRow = await Reflect.apply(pinned.consume, pinned.repository, [Object.freeze({
          stateHash, clientId: ownerSnap.clientId, authSessionId: ownerSnap.authSessionId, now,
        })]);
      } catch { throw failure(); }
      if (rawRow == null) return PUBLIC_STATUS_INVALID;
      const rowSnap = snapValidateRow(rawRow); if (!rowSnap) throw failure();
      consumed = true; safeEmitStage(pinned.stageTelemetry, 'callback_consumed');
      if (inputSnap.kind === 'error') return PUBLIC_STATUS_DECLINED;
      // Never persist callback authorization code outside completion handoff surface.
      const completionInput = Object.freeze({
        authorizationCode: inputSnap.code, transactionId: rowSnap.transactionId,
        clientId: ownerSnap.clientId, locationId: rowSnap.locationId,
        endpointId: rowSnap.endpointId, staffUserId: rowSnap.staffUserId,
        codeVerifier: rowSnap.codeVerifier, nonce: rowSnap.nonce,
        applicationClientId: pinned.applicationClientId,
        expectedPriorGrantGeneration: rowSnap.expectedPriorGrantGeneration,
      });
      if (!exactPlain(completionInput, COMPLETION_KEYS)) throw failure();
      let ack;
      try {
        ack = await Reflect.apply(pinned.completeAuthorization, pinned.completion, [completionInput]);
      } catch { throw failure(); }
      const st = sealedStatus(ack);
      if (st === OUTCOME_UNKNOWN) return PUBLIC_STATUS_OUTCOME_UNKNOWN;
      if (st === COMPLETION_ACK_STATUS) return PUBLIC_STATUS_RECEIVED;
      throw failure();
    } catch (err) {
      if (consumed) safeEmitStage(pinned.stageTelemetry, 'callback_failed');
      if (err && err.code === ERROR_CODE) throw err; throw failure();
    }
  }
  return Object.freeze({ accept });
}
function createPostgresPhaseBOauthTransactionConsumer(db) {
  if (!db || typeof db.query !== 'function') throw new TypeError('db_required');
  return Object.freeze({
    async consume({ stateHash, clientId, authSessionId, now }) {
      const result = await db.query(SQL_CONSUME_PHASE_B_TRANSACTION, [stateHash, clientId, authSessionId, now]);
      return (result && result.rows && result.rows[0]) || null;
    },
  });
}
module.exports = Object.freeze({
  ERROR_CODE, ERROR_MESSAGE, ACCEPT_METHOD, COMPLETION_METHOD, COMPLETION_ACK_STATUS, OUTCOME_UNKNOWN,
  CALLBACK_ENABLED_ENV, SUNSET_DEPLOYMENT, PUBLIC_STATUS_INVALID, PUBLIC_STATUS_DECLINED,
  PUBLIC_STATUS_RECEIVED, PUBLIC_STATUS_UNAVAILABLE, PUBLIC_STATUS_OUTCOME_UNKNOWN,
  DEPENDENCY_KEYS, CONSUME_ROW_KEYS, COMPLETION_KEYS, OWNER_KEYS, CALLBACK_CODE_KEYS, CALLBACK_ERROR_KEYS,
  SQL_CONSUME_PHASE_B_TRANSACTION, AUTHORIZATION_INTENT, SCOPE_VERSION, isCallbackEnabled,
  createPostgresPhaseBOauthTransactionConsumer, createMicrosoftPhaseBOauthCallbackCompletionService,
});
