'use strict';
/** Private umbrella owner for the closed Microsoft reauthorization lifecycle. */
const {
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
  EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES,
  EMAIL_MS_DELEGATED_SCOPE_VERSION,
} = require('./email-microsoft-delegated-oauth-contract');
const PHASE_B_OPERATION = Symbol('phase_b_reauthorization');
function deepFreeze(value, seen = new Set()) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return value;
  seen.add(value); for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}
const transactionStatement = "INSERT INTO tenant_email_oauth_transactions (client_id, location_id, staff_user_id, auth_session_id, endpoint_id, state_hash, code_verifier, nonce, issued_at, expires_at, authorization_intent, scope_version, prior_grant_generation) SELECT $1::uuid, tl.id, $3::uuid, $4::uuid, e.id, $6::bytea, $7, $8, $9, $10, 'phase_b_reauthorization', 'phase_b_v1', g.grant_generation FROM tenant_channel_endpoints e INNER JOIN tenant_locations tl ON tl.client_id=e.client_id AND tl.location_id=e.location_id INNER JOIN tenant_email_delegated_grants g ON g.client_id=e.client_id AND g.endpoint_id=e.id WHERE e.client_id=$1::uuid AND e.id=$5::uuid AND tl.id=$2::uuid AND e.provider='microsoft_graph' AND e.auth_mode='delegated_authorization_code' AND e.connector_mode='microsoft_delegated_oauth' AND e.binding_status='verified' AND e.mailbox_kind='user' AND e.mailbox_access_kind='own_user' AND g.scope_version='phase_a_v2' AND g.grant_status='active' AND g.reconcile_state='clean' AND g.grant_lease_token IS NULL AND g.grant_lease_owner IS NULL AND g.grant_lease_until IS NULL AND g.grant_generation=$11::bigint RETURNING expires_at, prior_grant_generation, authorization_intent, scope_version";
const callbackConsumeStatement = "UPDATE tenant_email_oauth_transactions SET consumed_at=$4 WHERE state_hash=$1::bytea AND client_id=$2::uuid AND auth_session_id=$3::uuid AND consumed_at IS NULL AND expires_at>$4 AND authorization_intent='phase_b_reauthorization' AND scope_version='phase_b_v1' AND prior_grant_generation IS NOT NULL AND prior_grant_generation >= 1 RETURNING id, location_id, staff_user_id, code_verifier, nonce, endpoint_id, authorization_intent, scope_version, prior_grant_generation";
const REGISTRY = deepFreeze({ [PHASE_B_OPERATION]: {
  authorizationIntent: 'phase_b_reauthorization', sourceScopeVersions: [EMAIL_MS_DELEGATED_SCOPE_VERSION],
  targetScopeVersion: EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
  authorizationScopes: ['openid', 'profile', 'offline_access', ...EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES],
  transactionStatement, callbackConsumeStatement,
} });
function phaseBValue(name) { const value = REGISTRY[PHASE_B_OPERATION][name]; if (value === undefined) throw new Error('phase_b_policy_contract_invalid'); return value; }
const privateTransitionPolicy = Object.freeze({
  authorizationIntent: () => phaseBValue('authorizationIntent'),
  sourceScopeVersion: () => phaseBValue('sourceScopeVersions')[0],
  targetScopeVersion: () => phaseBValue('targetScopeVersion'),
  authorizationScopeString: () => phaseBValue('authorizationScopes').join(' '),
  transactionStatement: () => phaseBValue('transactionStatement'),
  callbackConsumeStatement: () => phaseBValue('callbackConsumeStatement'),
});

const txExports = (() => {
/** Phase B reauth OAuth TX (Gate 3 PR B1). No prepare route/public wiring. */
const crypto = require('crypto');
const transitionPolicy = privateTransitionPolicy;
const {
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
  EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES,
} = require('./email-microsoft-delegated-oauth-contract');
const AUTHORITY = 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize';
const REDIRECT_URI = 'https://sunset-staging.lunafrontdesk.com/staff/email/oauth/microsoft/callback';
const PHASE_B_SCOPES = transitionPolicy.authorizationScopeString();
const TTL_SECONDS = 600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL_32_RE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const GEN_RE = /^[1-9][0-9]*$/;
const GEN_MAX = 9223372036854775807n;
const AUTHORIZATION_INTENT = transitionPolicy.authorizationIntent();
const SCOPE_VERSION = transitionPolicy.targetScopeVersion();
const START_ENABLED_ENV = 'LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED';
const INPUT_KEYS = Object.freeze([
  'clientId', 'locationId', 'endpointId', 'staffUserId', 'authSessionId',
  'expectedPriorGrantGeneration',
]);
const SQL_CREATE_PHASE_B_REAUTH = transitionPolicy.transactionStatement();
function b64url(b) { return b.toString('base64url'); }
function gen32(randomBytes, err) {
  const bytes = randomBytes(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw new Error(err);
  const v = b64url(bytes); if (!B64URL_32_RE.test(v)) throw new Error(err); return v;
}
function asCanonGen(v) {
  try {
    if (typeof v === 'bigint') { if (v < 1n || v > GEN_MAX) return null; return v.toString(10); }
    if (typeof v === 'number') { if (!Number.isSafeInteger(v) || v < 1) return null; return String(v); }
    if (typeof v === 'string' && GEN_RE.test(v)) {
      const b = BigInt(v); if (b < 1n || b > GEN_MAX) return null; return v;
    }
    return null;
  } catch { return null; }
}
function snapOrdered(input, keys) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const p = Object.getPrototypeOf(input);
    if (p !== Object.prototype && p !== null) return null;
    const a = Reflect.ownKeys(input);
    if (a.length !== keys.length) return null;
    for (let i = 0; i < keys.length; i += 1) if (a[i] !== keys[i]) return null;
    const out = Object.create(null);
    for (const k of keys) {
      const d = Object.getOwnPropertyDescriptor(input, k);
      if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set || !d.enumerable) {
        return null;
      }
      out[k] = d.value;
    }
    return Object.freeze(out);
  } catch { return null; }
}
function snapStart(input) {
  const raw = snapOrdered(input, INPUT_KEYS);
  if (!raw) return null;
  const out = Object.create(null);
  for (const k of INPUT_KEYS) {
    if (k === 'expectedPriorGrantGeneration') {
      const g = asCanonGen(raw[k]);
      if (g == null) return null;
      out[k] = g;
      continue;
    }
    if (typeof raw[k] !== 'string' || !UUID_RE.test(raw[k])) return null;
    out[k] = raw[k].toLowerCase();
  }
  return Object.freeze(out);
}
function isStartEnabled(env) { return !!env && env[START_ENABLED_ENV] === 'true'; }
function validateRuntime(env) {
  if (!env || typeof env !== 'object') throw new Error('phase_b_reauth_start_unconfigured');
  if (!isStartEnabled(env)) throw new Error('phase_b_reauth_start_disabled');
  if (env.LUNA_DEPLOYMENT !== 'sunset-staging') throw new Error('phase_b_reauth_start_wrong_deployment');
  const appId = env.LUNA_EMAIL_OAUTH_CLIENT_ID;
  if (typeof appId !== 'string' || !UUID_RE.test(appId)) throw new Error('phase_b_reauth_start_invalid_client_id');
  return appId.toLowerCase();
}
function createPostgresPhaseBReauthTransactionRepository(db) {
  if (!db || typeof db.query !== 'function') throw new TypeError('db_required');
  return Object.freeze({
    async create(row) {
      const result = await db.query(SQL_CREATE_PHASE_B_REAUTH, [
        row.clientId, row.locationId, row.staffUserId, row.authSessionId, row.endpointId,
        row.stateHash, row.codeVerifier, row.nonce, row.issuedAt, row.expiresAt,
        row.expectedPriorGrantGeneration,
      ]);
      const created = result && result.rows && result.rows[0];
      const prior = created && asCanonGen(created.prior_grant_generation);
      if (!created || result.rows.length !== 1
          || created.authorization_intent !== AUTHORIZATION_INTENT
          || created.scope_version !== SCOPE_VERSION
          || prior == null || prior !== row.expectedPriorGrantGeneration) {
        throw new Error('phase_b_reauth_start_endpoint_unavailable');
      }
      return created;
    },
  });
}
function createMicrosoftPhaseBReauthorizationTransactionService({
  repository, env = process.env, randomBytes = crypto.randomBytes, now = () => new Date(),
} = {}) {
  if (!repository || typeof repository.create !== 'function') throw new TypeError('repository_required');
  return Object.freeze({
    async start(input) {
      const snapshot = snapStart(input);
      if (!snapshot) throw new Error('phase_b_reauth_start_invalid_request');
      const appId = validateRuntime(env);
      const state = gen32(randomBytes, 'phase_b_reauth_start_state_generation_failed');
      const nonce = gen32(randomBytes, 'phase_b_reauth_start_nonce_generation_failed');
      const verifier = gen32(randomBytes, 'phase_b_reauth_start_verifier_generation_failed');
      if (!PKCE_VERIFIER_RE.test(verifier)) throw new Error('phase_b_reauth_start_verifier_generation_failed');
      const challenge = b64url(crypto.createHash('sha256').update(verifier, 'ascii').digest());
      const stateHash = crypto.createHash('sha256').update(state, 'ascii').digest();
      if (!B64URL_32_RE.test(challenge) || !Buffer.isBuffer(stateHash) || stateHash.length !== 32) {
        throw new Error('phase_b_reauth_start_pkce_generation_failed');
      }
      const issuedAt = new Date(now());
      const expiresAt = new Date(issuedAt.getTime() + TTL_SECONDS * 1000);
      await repository.create({
        clientId: snapshot.clientId, locationId: snapshot.locationId,
        staffUserId: snapshot.staffUserId, authSessionId: snapshot.authSessionId,
        endpointId: snapshot.endpointId, stateHash, codeVerifier: verifier, nonce,
        issuedAt, expiresAt, expectedPriorGrantGeneration: snapshot.expectedPriorGrantGeneration,
      });
      const url = new URL(AUTHORITY);
      for (const [k, v] of [
        ['client_id', appId], ['response_type', 'code'], ['redirect_uri', REDIRECT_URI],
        ['response_mode', 'query'], ['scope', PHASE_B_SCOPES], ['state', state], ['nonce', nonce],
        ['code_challenge', challenge], ['code_challenge_method', 'S256'], ['prompt', 'consent'],
      ]) url.searchParams.set(k, v);
      return Object.freeze({
        authorization_url: url.toString(), expires_at: expiresAt.toISOString(),
        authorization_intent: AUTHORIZATION_INTENT, scope_version: SCOPE_VERSION,
        prior_grant_generation: snapshot.expectedPriorGrantGeneration,
      });
    },
  });
}
return Object.freeze({
  AUTHORITY, REDIRECT_URI, PHASE_B_SCOPES, TTL_SECONDS, INPUT_KEYS, AUTHORIZATION_INTENT,
  SCOPE_VERSION, START_ENABLED_ENV, SQL_CREATE_PHASE_B_REAUTH, asCanonGen, isStartEnabled,
  validateRuntime, createPostgresPhaseBReauthTransactionRepository,
  createMicrosoftPhaseBReauthorizationTransactionService,
});

})();

const callbackExports = (() => {
/**
 * Gate 3 Phase B PR B2a — dormant consume-once Phase B callback completion.
 * Injected completion only; server-owned intent/scope/prior; import-inert.
 * Flag exact ==='true' checked before any repository consume (zero DB when off).
 * @module email-microsoft-phase-b-oauth-callback-completion
 */
const crypto = require('crypto');
const util = require('util');
const transitionPolicy = privateTransitionPolicy;
const {
  AUTHORIZATION_INTENT, SCOPE_VERSION, asCanonGen,
} = txExports;
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
const SQL_CONSUME_PHASE_B_TRANSACTION = transitionPolicy.callbackConsumeStatement();

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
/**
 * Own enumerable data-descriptor string only. Never env[key] / inherited / accessors.
 * null → invalid surface (fail closed); {present:false} → key absent.
 */
function readOwnEnvString(env, key) {
  try {
    if (env == null || (typeof env !== 'object' && typeof env !== 'function') || isProxy(env)) {
      return null;
    }
    if (!Object.prototype.hasOwnProperty.call(env, key)) return { present: false };
    const d = Object.getOwnPropertyDescriptor(env, key);
    if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set || !d.enumerable) {
      return null;
    }
    if (typeof d.value !== 'string') return null;
    return { present: true, value: d.value };
  } catch { return null; }
}
/**
 * Exact lowercase 'true' via own data only (zero getter hits).
 * true | false | null(invalid accessor/proxy/non-enumerable surface).
 * Absent or own non-'true' data (incl. non-string) → false — gate off, factory ok.
 */
function readOwnEnvExactTrue(env, key) {
  try {
    if (env == null || (typeof env !== 'object' && typeof env !== 'function') || isProxy(env)) {
      return null;
    }
    if (!Object.prototype.hasOwnProperty.call(env, key)) return false;
    const d = Object.getOwnPropertyDescriptor(env, key);
    if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set || !d.enumerable) {
      return null;
    }
    return d.value === 'true';
  } catch { return null; }
}
/** Exact lowercase 'true' via own data only; proxy/accessor/inherited → false, zero getter hits. */
function isCallbackEnabled(env) {
  try {
    return readOwnEnvExactTrue(env, CALLBACK_ENABLED_ENV) === true;
  } catch { return false; }
}
/**
 * Snap deployment + app client id + B flag from own data descriptors only.
 * Rejects transparent Proxy, symbol own keys, accessors; no env[key].
 * Flag: exact 'true' only; missing/false/malformed own data → phaseBEnabled false.
 */
function snapEnv(env) {
  try {
    if (!env || typeof env !== 'object' || isProxy(env)) return null;
    let ownKeys;
    try { ownKeys = Reflect.ownKeys(env); } catch { return null; }
    for (let i = 0; i < ownKeys.length; i += 1) {
      if (typeof ownKeys[i] === 'symbol') return null;
    }
    const dep = readOwnEnvString(env, 'LUNA_DEPLOYMENT');
    if (!dep || !dep.present || dep.value !== SUNSET_DEPLOYMENT) return null;
    const app = readOwnEnvString(env, 'LUNA_EMAIL_OAUTH_CLIENT_ID');
    if (!app || !app.present || !UUID_RE.test(app.value)) return null;
    const flag = readOwnEnvExactTrue(env, CALLBACK_ENABLED_ENV);
    if (flag === null) return null;
    return Object.freeze({
      applicationClientId: app.value.toLowerCase(),
      phaseBEnabled: flag === true,
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
    try {
      // Exact flag gate before any repository consume / DB access / completion.
      if (!pinned.phaseBEnabled) return PUBLIC_STATUS_UNAVAILABLE;
      const ownerSnap = snapUuids(owner, OWNER_KEYS); if (!ownerSnap) throw failure();
      safeEmitStage(pinned.stageTelemetry, 'phase_b_owner_validated');
      const inputSnap = snapInput(input); if (!inputSnap) throw failure();
      safeEmitStage(pinned.stageTelemetry, 'phase_b_input_validated');
      const stateHash = crypto.createHash('sha256').update(inputSnap.state, 'ascii').digest();
      if (!Buffer.isBuffer(stateHash) || stateHash.length !== 32) throw failure();
      safeEmitStage(pinned.stageTelemetry, 'phase_b_state_hashed');
      let rawNow;
      try { rawNow = Reflect.apply(pinned.now, pinned.clock, []); } catch { throw failure(); }
      if (!(rawNow instanceof Date) || Number.isNaN(rawNow.getTime())) throw failure();
      const now = new Date(rawNow.getTime());
      safeEmitStage(pinned.stageTelemetry, 'phase_b_clock_validated');
      let rawRow;
      try {
        safeEmitStage(pinned.stageTelemetry, 'phase_b_consume_started');
        rawRow = await Reflect.apply(pinned.consume, pinned.repository, [Object.freeze({
          stateHash, clientId: ownerSnap.clientId, authSessionId: ownerSnap.authSessionId, now,
        })]);
      } catch { throw failure(); }
      safeEmitStage(pinned.stageTelemetry, 'phase_b_consume_returned');
      if (rawRow == null) {
        safeEmitStage(pinned.stageTelemetry, 'callback_failed');
        return PUBLIC_STATUS_INVALID;
      }
      safeEmitStage(pinned.stageTelemetry, 'phase_b_consume_matched');
      const rowSnap = snapValidateRow(rawRow); if (!rowSnap) throw failure();
      safeEmitStage(pinned.stageTelemetry, 'phase_b_row_validated');
      safeEmitStage(pinned.stageTelemetry, 'callback_consumed');
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
      safeEmitStage(pinned.stageTelemetry, 'callback_failed');
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
return Object.freeze({
  ERROR_CODE, ERROR_MESSAGE, ACCEPT_METHOD, COMPLETION_METHOD, COMPLETION_ACK_STATUS, OUTCOME_UNKNOWN,
  CALLBACK_ENABLED_ENV, SUNSET_DEPLOYMENT, PUBLIC_STATUS_INVALID, PUBLIC_STATUS_DECLINED,
  PUBLIC_STATUS_RECEIVED, PUBLIC_STATUS_UNAVAILABLE, PUBLIC_STATUS_OUTCOME_UNKNOWN,
  DEPENDENCY_KEYS, CONSUME_ROW_KEYS, COMPLETION_KEYS, OWNER_KEYS, CALLBACK_CODE_KEYS, CALLBACK_ERROR_KEYS,
  SQL_CONSUME_PHASE_B_TRANSACTION, AUTHORIZATION_INTENT, SCOPE_VERSION, isCallbackEnabled,
  createPostgresPhaseBOauthTransactionConsumer, createMicrosoftPhaseBOauthCallbackCompletionService,
});

})();
module.exports = Object.freeze({
  phaseBReauthorizationTransactionService: txExports,
  phaseBOauthCallbackCompletion: callbackExports,
});
