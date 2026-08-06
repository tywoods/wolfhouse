'use strict';

/**
 * Microsoft v2 token-response scope validation + deterministic normalization.
 *
 * Authorize/request may still ask for openid profile offline_access + Graph
 * User.Read + Mail.ReadBasic (+ optional OIDC email). The *token response*
 * `scope` field is effective granted *access-token* scopes: offline_access is
 * evidenced by a required refresh_token and need not be echoed; optional OIDC
 * email may appear. Never synthesize missing scopes into actual custody scope.
 *
 * Rules:
 * - Require exact resource scopes: User.Read, Mail.ReadBasic
 * - Allow only OIDC metadata: openid, profile, offline_access, email (any order)
 * - Reject duplicates, empty tokens, unknown scopes, omitted required resource,
 *   and higher-privilege Graph scopes
 * - Normalize present scopes to a deterministic order for custody/replay
 *
 * @module email-microsoft-token-response-scope
 */

const TOKEN_RESPONSE_REQUIRED_RESOURCE_SCOPES = Object.freeze([
  'User.Read',
  'Mail.ReadBasic',
]);
const TOKEN_RESPONSE_ALLOWED_OIDC_SCOPES = Object.freeze([
  'openid',
  'profile',
  'offline_access',
  'email',
]);
/** Deterministic actual-scope order: OIDC metadata (incl. optional email) then resources. */
const TOKEN_RESPONSE_SCOPE_ORDER = Object.freeze([
  'openid',
  'profile',
  'offline_access',
  'email',
  'User.Read',
  'Mail.ReadBasic',
]);
const ALLOWED_TOKEN_RESPONSE_SCOPES = new Set([
  ...TOKEN_RESPONSE_ALLOWED_OIDC_SCOPES,
  ...TOKEN_RESPONSE_REQUIRED_RESOURCE_SCOPES,
]);
const SCOPE_MAX_CHARS = 512;

/**
 * Validate a Microsoft v2 token-response scope string and return deterministic
 * normalized actual scope of only the scopes that were present (no synthesis).
 *
 * @param {unknown} scope
 * @returns {string|null} normalized scope, or null if invalid
 */
function validateAndNormalizeTokenResponseScope(scope) {
  if (typeof scope !== 'string' || scope.length < 1 || scope.length > SCOPE_MAX_CHARS) {
    return null;
  }
  const parts = scope.split(' ');
  if (parts.length < 1) return null;

  const seen = new Set();
  for (const item of parts) {
    if (!item || !ALLOWED_TOKEN_RESPONSE_SCOPES.has(item) || seen.has(item)) {
      return null;
    }
    seen.add(item);
  }

  for (const required of TOKEN_RESPONSE_REQUIRED_RESOURCE_SCOPES) {
    if (!seen.has(required)) return null;
  }

  return TOKEN_RESPONSE_SCOPE_ORDER.filter((item) => seen.has(item)).join(' ');
}

module.exports = Object.freeze({
  TOKEN_RESPONSE_REQUIRED_RESOURCE_SCOPES,
  TOKEN_RESPONSE_ALLOWED_OIDC_SCOPES,
  TOKEN_RESPONSE_SCOPE_ORDER,
  ALLOWED_TOKEN_RESPONSE_SCOPES,
  SCOPE_MAX_CHARS,
  validateAndNormalizeTokenResponseScope,
});
