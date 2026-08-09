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
const PHASE_B_SCOPE_REJECTION_CATEGORIES = Object.freeze([
  'invalid', 'duplicate', 'dangerous', 'phase_a_mixed', 'unknown', 'missing_required',
]);
const REJECTED = Object.freeze(Object.fromEntries(PHASE_B_SCOPE_REJECTION_CATEGORIES.map((category) => [
  category, Object.freeze({ value: null, rejectionCategory: category }),
])));
function isDangerousScopeToken(item) {
  return item.includes('.Shared')
    || item === '/.default'
    || item.endsWith('/.default')
    || item.startsWith('Application ')
    || item.endsWith('.All');
}
function accepted(value) {
  return Object.freeze({ value, rejectionCategory: null });
}
/** Diagnostic classifier. Categories are fixed and contain no provider data. */
function classifyAndNormalizePhaseBTokenResponseScope(scope) {
  if (typeof scope !== 'string' || scope.length < 1 || scope.length > SCOPE_MAX_CHARS) {
    return REJECTED.invalid;
  }
  const parts = scope.split(' ');
  const seen = new Set();
  for (const item of parts) {
    if (!item) return REJECTED.invalid;
    if (seen.has(item)) return REJECTED.duplicate;
    if (isDangerousScopeToken(item) || item === 'Application') return REJECTED.dangerous;
    if (FORBIDDEN_PHASE_A.has(item)) return REJECTED.phase_a_mixed;
    if (!ALLOWED.has(item)) return REJECTED.unknown;
    seen.add(item);
  }
  for (const required of PHASE_B_REQUIRED_RESOURCE_SCOPES) {
    if (!seen.has(required)) return REJECTED.missing_required;
  }
  return accepted(PHASE_B_TOKEN_SCOPE_ORDER.filter((item) => seen.has(item)).join(' '));
}
/**
 * Validate + normalize Phase B token-response scope string.
 * @param {unknown} scope
 * @returns {string|null} normalized scope, or null if invalid
 */
function validateAndNormalizePhaseBTokenResponseScope(scope) {
  return classifyAndNormalizePhaseBTokenResponseScope(scope).value;
}
module.exports = Object.freeze({
  PHASE_B_REQUIRED_RESOURCE_SCOPES,
  PHASE_B_ALLOWED_OIDC_SCOPES,
  PHASE_B_TOKEN_SCOPE_ORDER,
  SCOPE_MAX_CHARS,
  PHASE_B_SCOPE_REJECTION_CATEGORIES,
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
  classifyAndNormalizePhaseBTokenResponseScope,
  validateAndNormalizePhaseBTokenResponseScope,
});
