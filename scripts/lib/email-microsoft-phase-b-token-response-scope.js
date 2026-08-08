'use strict';
/**
 * Phase B Microsoft v2 token-response scope owner (Gate 3 PR B1).
 * Exact Graph delegated resources from the delegated OAuth contract:
 * User.Read + Mail.ReadWrite + Mail.Send. OIDC metadata allowlisted only.
 * Accept any provider order; normalize deterministically. Never expose raw tokens.
 *
 * @module email-microsoft-phase-b-token-response-scope
 */
const {
  EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES,
  EMAIL_MS_DELEGATED_PHASE_B_ALLOWED_OIDC_SCOPES,
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
} = require('./email-microsoft-delegated-oauth-contract');
/** Exact contract resources (User.Read Mail.ReadWrite Mail.Send). */
const PHASE_B_REQUIRED_RESOURCE_SCOPES = EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES;
/** Exact contract OIDC allowlist (openid profile offline_access email). */
const PHASE_B_ALLOWED_OIDC_SCOPES = EMAIL_MS_DELEGATED_PHASE_B_ALLOWED_OIDC_SCOPES;
/** Deterministic order: OIDC metadata then exact Phase B Graph resources. */
const PHASE_B_TOKEN_SCOPE_ORDER = Object.freeze([
  'openid', 'profile', 'offline_access', 'email',
  ...PHASE_B_REQUIRED_RESOURCE_SCOPES,
]);
const SCOPE_MAX_CHARS = 512;
const ALLOWED = new Set([...PHASE_B_ALLOWED_OIDC_SCOPES, ...PHASE_B_REQUIRED_RESOURCE_SCOPES]);
const FORBIDDEN_PHASE_A = new Set(['Mail.ReadBasic', 'Mail.Read']);
function isDangerousScopeToken(item) {
  return item.includes('.Shared')
    || item === '/.default'
    || item.endsWith('/.default')
    || item.startsWith('Application ')
    || item.endsWith('.All');
}
/**
 * Validate + normalize Phase B token-response scope string.
 * @param {unknown} scope
 * @returns {string|null} normalized scope, or null if invalid
 */
function validateAndNormalizePhaseBTokenResponseScope(scope) {
  if (typeof scope !== 'string' || scope.length < 1 || scope.length > SCOPE_MAX_CHARS) {
    return null;
  }
  const parts = scope.split(' ');
  if (parts.length < 1) return null;
  const seen = new Set();
  for (const item of parts) {
    if (!item || seen.has(item) || isDangerousScopeToken(item) || FORBIDDEN_PHASE_A.has(item)) {
      return null;
    }
    if (!ALLOWED.has(item)) return null;
    seen.add(item);
  }
  for (const required of PHASE_B_REQUIRED_RESOURCE_SCOPES) {
    if (!seen.has(required)) return null;
  }
  return PHASE_B_TOKEN_SCOPE_ORDER.filter((item) => seen.has(item)).join(' ');
}
module.exports = Object.freeze({
  PHASE_B_REQUIRED_RESOURCE_SCOPES,
  PHASE_B_ALLOWED_OIDC_SCOPES,
  PHASE_B_TOKEN_SCOPE_ORDER,
  SCOPE_MAX_CHARS,
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
  validateAndNormalizePhaseBTokenResponseScope,
});
