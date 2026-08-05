'use strict';

const crypto = require('crypto');
const AUTHORITY = ['https://login.microsoftonline.com', 'organizations', 'oauth2', 'v2.0', 'authorize'].join('/');
const REDIRECT_URI = ['https://sunset-staging.lunafrontdesk.com', 'staff', 'email', 'oauth', 'microsoft', 'callback'].join('/');
const SCOPES = 'openid profile offline_access User.Read Mail.ReadBasic';
const TTL_SECONDS = 600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INPUT_KEYS = Object.freeze(['clientId', 'locationId', 'staffUserId', 'authSessionId']);

function b64url(buffer) { return buffer.toString('base64url'); }
function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Object.keys(value);
  return own.length === keys.length && own.every((key) => keys.includes(key));
}
function isStartEnabled(env) { return !!env && env.LUNA_EMAIL_OAUTH_START_ENABLED === 'true'; }
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
      const result = await db.query(
        `INSERT INTO tenant_email_oauth_transactions
          (client_id, location_id, staff_user_id, auth_session_id, state_hash, code_verifier, nonce, issued_at, expires_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bytea,$6,$7,$8,$9)
         RETURNING expires_at`,
        [row.clientId, row.locationId, row.staffUserId, row.authSessionId, row.stateHash, row.codeVerifier, row.nonce, row.issuedAt, row.expiresAt]
      );
      return result.rows[0];
    },
    async consume({ stateHash, clientId, authSessionId, now }) {
      const result = await db.query(
        `UPDATE tenant_email_oauth_transactions SET consumed_at=$4
         WHERE state_hash=$1::bytea AND client_id=$2::uuid AND auth_session_id=$3::uuid
           AND consumed_at IS NULL AND expires_at>$4
         RETURNING id, location_id, staff_user_id, code_verifier, nonce`,
        [stateHash, clientId, authSessionId, now]
      );
      return result.rows[0] || null;
    },
  });
}

function createMicrosoftOAuthTransactionService({ repository, env = process.env, randomBytes = crypto.randomBytes, now = () => new Date() }) {
  if (!repository || typeof repository.create !== 'function') throw new TypeError('repository_required');
  return Object.freeze({
    async start(input) {
      if (!exactObject(input, INPUT_KEYS) || !INPUT_KEYS.every((key) => UUID_RE.test(input[key]))) throw new Error('oauth_start_invalid_request');
      const appId = validateRuntime(env);
      const state = b64url(randomBytes(32));
      const nonce = b64url(randomBytes(32));
      const verifier = b64url(randomBytes(32));
      const challenge = b64url(crypto.createHash('sha256').update(verifier, 'ascii').digest());
      const stateHash = crypto.createHash('sha256').update(state, 'ascii').digest();
      const issuedAt = new Date(now());
      const expiresAt = new Date(issuedAt.getTime() + TTL_SECONDS * 1000);
      await repository.create({ ...input, stateHash, codeVerifier: verifier, nonce, issuedAt, expiresAt });
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

module.exports = { AUTHORITY, REDIRECT_URI, SCOPES, TTL_SECONDS, isStartEnabled, validateRuntime, createPostgresOAuthTransactionRepository, createMicrosoftOAuthTransactionService };
