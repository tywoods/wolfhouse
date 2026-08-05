'use strict';

const crypto = require('crypto');
const AUTHORITY = ['https://login.microsoftonline.com', 'organizations', 'oauth2', 'v2.0', 'authorize'].join('/');
const REDIRECT_URI = ['https://sunset-staging.lunafrontdesk.com', 'staff', 'email', 'oauth', 'microsoft', 'callback'].join('/');
const SCOPES = 'openid profile offline_access User.Read Mail.ReadBasic';
const TTL_SECONDS = 600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL_32_RE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
/** Exact start input key order — endpoint is selected at start and bound in-row. */
const INPUT_KEYS = Object.freeze(['clientId', 'locationId', 'staffUserId', 'authSessionId', 'endpointId']);
const OWNER_KEYS = Object.freeze(['clientId', 'authSessionId']);
const CALLBACK_CODE_KEYS = Object.freeze(['state', 'code']);
const CALLBACK_ERROR_KEYS = Object.freeze(['state', 'error']);
const CALLBACK_KEY_SHAPES = Object.freeze([CALLBACK_CODE_KEYS, CALLBACK_ERROR_KEYS]);

const SQL_CREATE_TRANSACTION = `
INSERT INTO tenant_email_oauth_transactions
  (client_id, location_id, staff_user_id, auth_session_id, endpoint_id,
   state_hash, code_verifier, nonce, issued_at, expires_at)
SELECT
  $1::uuid,
  tl.id,
  $3::uuid,
  $4::uuid,
  e.id,
  $6::bytea,
  $7,
  $8,
  $9,
  $10
FROM tenant_channel_endpoints e
INNER JOIN tenant_locations tl
  ON tl.client_id = e.client_id
 AND tl.location_id = e.location_id
WHERE e.client_id = $1::uuid
  AND e.id = $5::uuid
  AND tl.id = $2::uuid
  AND e.provider = 'microsoft_graph'
  AND e.auth_mode = 'delegated_authorization_code'
  AND e.connector_mode = 'microsoft_delegated_oauth'
  AND e.binding_status IN ('unverified_offline', 'pending_manual_validation')
RETURNING expires_at`.replace(/\s+/g, ' ').trim();

const SQL_CONSUME_TRANSACTION = `
UPDATE tenant_email_oauth_transactions SET consumed_at=$4
 WHERE state_hash=$1::bytea AND client_id=$2::uuid AND auth_session_id=$3::uuid
   AND consumed_at IS NULL AND expires_at>$4
 RETURNING id, location_id, staff_user_id, code_verifier, nonce, endpoint_id`.replace(/\s+/g, ' ').trim();

function b64url(buffer) { return buffer.toString('base64url'); }
function generate32(randomBytes, error) {
  const bytes = randomBytes(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw new Error(error);
  const value = b64url(bytes);
  if (!B64URL_32_RE.test(value)) throw new Error(error);
  return value;
}

/**
 * Exact immutable own-data snapshot of a caller object.
 * - Ordinary Object.prototype or null prototype only (arrays / custom protos rejected)
 * - Frozen or unfrozen accepted (public contract)
 * - Exact own string keys in exact order; no symbols, extras, or missing keys
 * - Each key must be an own enumerable data descriptor (no getter/setter)
 * - Each descriptor value is read exactly once
 * - Reflection/proxy throws are contained; returns null
 * Never re-reads the caller after return.
 */
function snapshotExactOrderedOwnData(input, keys) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(input);
    if (actual.length !== keys.length) return null;
    for (let i = 0; i < keys.length; i += 1) {
      if (actual[i] !== keys[i]) return null;
    }
    const out = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable) {
        return null;
      }
      out[key] = descriptor.value;
    }
    return Object.freeze(out);
  } catch {
    return null;
  }
}

/** Start/owner UUID fields: exact snapshot + UUID grammar + lowercase locals. */
function snapshotExactOrderedUuids(input, keys) {
  const raw = snapshotExactOrderedOwnData(input, keys);
  if (!raw) return null;
  const out = Object.create(null);
  for (const key of keys) {
    const value = raw[key];
    if (typeof value !== 'string' || !UUID_RE.test(value)) return null;
    out[key] = value.toLowerCase();
  }
  return Object.freeze(out);
}

function isStartEnabled(env) { return !!env && env.LUNA_EMAIL_OAUTH_START_ENABLED === 'true'; }
function isCallbackEnabled(env) { return !!env && env.LUNA_EMAIL_OAUTH_CALLBACK_ENABLED === 'true'; }
function validateRuntime(env) {
  if (!env || typeof env !== 'object') throw new Error('oauth_start_unconfigured');
  if (!isStartEnabled(env)) throw new Error('oauth_start_disabled');
  if (env.LUNA_DEPLOYMENT !== 'sunset-staging') throw new Error('oauth_start_wrong_deployment');
  const appId = env.LUNA_EMAIL_OAUTH_CLIENT_ID;
  if (typeof appId !== 'string' || !UUID_RE.test(appId)) throw new Error('oauth_start_invalid_client_id');
  return appId.toLowerCase();
}

function createPostgresOAuthTransactionRepository(db) {
  if (!db || typeof db.query !== 'function') throw new TypeError('db_required');
  return Object.freeze({
    async create(row) {
      const result = await db.query(SQL_CREATE_TRANSACTION, [
        row.clientId,
        row.locationId,
        row.staffUserId,
        row.authSessionId,
        row.endpointId,
        row.stateHash,
        row.codeVerifier,
        row.nonce,
        row.issuedAt,
        row.expiresAt,
      ]);
      const created = result && result.rows && result.rows[0];
      if (!created || result.rows.length !== 1) {
        throw new Error('oauth_start_endpoint_unavailable');
      }
      return created;
    },
    async consume({ stateHash, clientId, authSessionId, now }) {
      const result = await db.query(SQL_CONSUME_TRANSACTION, [
        stateHash, clientId, authSessionId, now,
      ]);
      return (result && result.rows && result.rows[0]) || null;
    },
  });
}

function createMicrosoftOAuthTransactionService({ repository, env = process.env, randomBytes = crypto.randomBytes, now = () => new Date() }) {
  if (!repository || typeof repository.create !== 'function') throw new TypeError('repository_required');
  return Object.freeze({
    async start(input) {
      // Snapshot before any randomness or persistence; never reread caller.
      const snapshot = snapshotExactOrderedUuids(input, INPUT_KEYS);
      if (!snapshot) throw new Error('oauth_start_invalid_request');
      const appId = validateRuntime(env);
      const state = generate32(randomBytes, 'oauth_start_state_generation_failed');
      const nonce = generate32(randomBytes, 'oauth_start_nonce_generation_failed');
      const verifier = generate32(randomBytes, 'oauth_start_verifier_generation_failed');
      if (!PKCE_VERIFIER_RE.test(verifier)) throw new Error('oauth_start_verifier_generation_failed');
      const challenge = b64url(crypto.createHash('sha256').update(verifier, 'ascii').digest());
      const stateHash = crypto.createHash('sha256').update(state, 'ascii').digest();
      if (!B64URL_32_RE.test(challenge) || !Buffer.isBuffer(stateHash) || stateHash.length !== 32) {
        throw new Error('oauth_start_pkce_generation_failed');
      }
      const issuedAt = new Date(now());
      const expiresAt = new Date(issuedAt.getTime() + TTL_SECONDS * 1000);
      await repository.create({
        clientId: snapshot.clientId,
        locationId: snapshot.locationId,
        staffUserId: snapshot.staffUserId,
        authSessionId: snapshot.authSessionId,
        endpointId: snapshot.endpointId,
        stateHash,
        codeVerifier: verifier,
        nonce,
        issuedAt,
        expiresAt,
      });
      const url = new URL(AUTHORITY);
      for (const [key, value] of [
        ['client_id', appId], ['response_type', 'code'], ['redirect_uri', REDIRECT_URI],
        ['response_mode', 'query'], ['scope', SCOPES], ['state', state], ['nonce', nonce],
        ['code_challenge', challenge], ['code_challenge_method', 'S256'],
      ]) url.searchParams.set(key, value);
      return Object.freeze({ authorization_url: url.toString(), expires_at: expiresAt.toISOString() });
    },
  });
}

const PROVIDER_CODE_RE = /^[\x21-\x7e]{1,4096}$/;
const PROVIDER_ERROR_RE = /^[a-z][a-z0-9_]{0,63}$/;

function snapshotCallbackInput(input) {
  for (const keys of CALLBACK_KEY_SHAPES) {
    const raw = snapshotExactOrderedOwnData(input, keys);
    if (!raw) continue;
    if (typeof raw.state !== 'string' || !B64URL_32_RE.test(raw.state)) continue;
    if (keys[1] === 'code') {
      if (typeof raw.code !== 'string' || !PROVIDER_CODE_RE.test(raw.code)) continue;
      return Object.freeze({ kind: 'code', state: raw.state, code: raw.code });
    }
    if (typeof raw.error !== 'string' || !PROVIDER_ERROR_RE.test(raw.error)) continue;
    return Object.freeze({ kind: 'error', state: raw.state, error: raw.error });
  }
  return null;
}

function createMicrosoftOAuthCallbackService({ repository, env = process.env, now = () => new Date() }) {
  if (!repository || typeof repository.consume !== 'function') throw new TypeError('repository_required');
  return Object.freeze({
    async accept(input, owner) {
      if (!isCallbackEnabled(env) || env.LUNA_DEPLOYMENT !== 'sunset-staging') throw new Error('oauth_callback_disabled');
      // Exact owner snapshot before any consume; never reread caller.
      const ownerSnap = snapshotExactOrderedUuids(owner, OWNER_KEYS);
      if (!ownerSnap) throw new Error('oauth_callback_invalid_owner');
      const inputSnap = snapshotCallbackInput(input);
      if (!inputSnap) throw new Error('oauth_callback_invalid_request');
      const stateHash = crypto.createHash('sha256').update(inputSnap.state, 'ascii').digest();
      const row = await repository.consume({
        stateHash,
        clientId: ownerSnap.clientId,
        authSessionId: ownerSnap.authSessionId,
        now: new Date(now()),
      });
      if (!row) return Object.freeze({ status: 'invalid_or_expired' });
      // Public surface: status only — never expose row id, verifier, nonce, or endpoint_id.
      return Object.freeze({
        status: inputSnap.kind === 'code' ? 'authorization_received' : 'authorization_declined',
      });
    },
  });
}

module.exports = {
  AUTHORITY,
  REDIRECT_URI,
  SCOPES,
  TTL_SECONDS,
  INPUT_KEYS,
  OWNER_KEYS,
  CALLBACK_CODE_KEYS,
  CALLBACK_ERROR_KEYS,
  SQL_CREATE_TRANSACTION,
  SQL_CONSUME_TRANSACTION,
  isStartEnabled,
  isCallbackEnabled,
  validateRuntime,
  createPostgresOAuthTransactionRepository,
  createMicrosoftOAuthTransactionService,
  createMicrosoftOAuthCallbackService,
};
