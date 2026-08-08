'use strict';
/** Phase B reauth OAuth TX (Gate 3 PR B1). No prepare route/public wiring. */
const crypto = require('crypto');
const {
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
  EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES,
} = require('./email-microsoft-delegated-oauth-contract');
const AUTHORITY = 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize';
const REDIRECT_URI = 'https://sunset-staging.lunafrontdesk.com/staff/email/oauth/microsoft/callback';
const PHASE_B_SCOPES = ['openid', 'profile', 'offline_access', ...EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES].join(' ');
const TTL_SECONDS = 600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL_32_RE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const GEN_RE = /^[1-9][0-9]*$/;
const GEN_MAX = 9223372036854775807n;
const AUTHORIZATION_INTENT = 'phase_b_reauthorization';
const SCOPE_VERSION = EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION;
const START_ENABLED_ENV = 'LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED';
const INPUT_KEYS = Object.freeze([
  'clientId', 'locationId', 'endpointId', 'staffUserId', 'authSessionId',
  'expectedPriorGrantGeneration',
]);
const SQL_CREATE_PHASE_B_REAUTH = `INSERT INTO tenant_email_oauth_transactions (client_id, location_id, staff_user_id, auth_session_id, endpoint_id, state_hash, code_verifier, nonce, issued_at, expires_at, authorization_intent, scope_version, prior_grant_generation) SELECT $1::uuid, tl.id, $3::uuid, $4::uuid, e.id, $6::bytea, $7, $8, $9, $10, 'phase_b_reauthorization', 'phase_b_v1', g.grant_generation FROM tenant_channel_endpoints e INNER JOIN tenant_locations tl ON tl.client_id=e.client_id AND tl.location_id=e.location_id INNER JOIN tenant_email_delegated_grants g ON g.client_id=e.client_id AND g.endpoint_id=e.id WHERE e.client_id=$1::uuid AND e.id=$5::uuid AND tl.id=$2::uuid AND e.provider='microsoft_graph' AND e.auth_mode='delegated_authorization_code' AND e.connector_mode='microsoft_delegated_oauth' AND e.binding_status='verified' AND g.scope_version='phase_a_v2' AND g.grant_status='active' AND g.reconcile_state='clean' AND g.grant_lease_token IS NULL AND g.grant_lease_owner IS NULL AND g.grant_lease_until IS NULL AND g.grant_generation=$11::bigint RETURNING expires_at, prior_grant_generation, authorization_intent, scope_version`;
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
}) {
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
module.exports = Object.freeze({
  AUTHORITY, REDIRECT_URI, PHASE_B_SCOPES, TTL_SECONDS, INPUT_KEYS, AUTHORIZATION_INTENT,
  SCOPE_VERSION, START_ENABLED_ENV, SQL_CREATE_PHASE_B_REAUTH, asCanonGen, isStartEnabled,
  validateRuntime, createPostgresPhaseBReauthTransactionRepository,
  createMicrosoftPhaseBReauthorizationTransactionService,
});
