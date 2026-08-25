'use strict';

/**
 * Phase-aware Microsoft refresh-token response classification owner.
 *
 * Keyed only by trusted persisted grant scope_version (never client UI, process
 * environment, or provider-body policy selection):
 *   phase_a_v2 → single-consent validator (User.Read + Mail.ReadWrite + Mail.Send)
 *   phase_b_v1 → legacy Phase B validator (same resource set)
 *   unknown / missing / hostile → fail-closed uncertain
 *
 * Preserves Phase A semantics exactly. Never mixes A/B scopes. Never logs or
 * returns tokens, error_description, correlation ids, or raw bodies.
 *
 * @module email-microsoft-refresh-token-response-by-scope-version
 */

const {
  EMAIL_MS_DELEGATED_SCOPE_VERSION,
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
} = require('./email-microsoft-delegated-oauth-contract');
const {
  classifyMicrosoftRefreshTokenResponse,
  classifyMicrosoftRefreshTokenResponseWithScopeValidator,
} = require('./email-microsoft-refresh-token-response');
const {
  validateAndNormalizePhaseBTokenResponseScope,
} = require('./email-microsoft-phase-b-token-response-scope');
const {
  CONTENT_SCOPE_VERSION,
  validateContentReadTokenScope,
} = require('./email-microsoft-content-read-scope');

const SCOPE_VERSION_MAX_CHARS = 32;

function uncertain() {
  return Object.freeze({ kind: 'uncertain' });
}

/**
 * @param {unknown} scopeVersion trusted persisted custody scope_version
 * @param {unknown} response frozen transport shape { statusCode, contentType, body }
 * @returns {{ kind: 'success'|'invalid_grant'|'uncertain', selected?: object }}
 */
function classifyMicrosoftRefreshTokenResponseForScopeVersion(scopeVersion, response) {
  try {
    if (typeof scopeVersion !== 'string'
        || scopeVersion.length < 1
        || scopeVersion.length > SCOPE_VERSION_MAX_CHARS
        || scopeVersion !== scopeVersion.trim()
        || /[\s\r\n]/.test(scopeVersion)) {
      return uncertain();
    }
    if (scopeVersion === EMAIL_MS_DELEGATED_SCOPE_VERSION) {
      // Exact Phase A path — same public classifier, no alternate allowlist.
      return classifyMicrosoftRefreshTokenResponse(response);
    }
    if (scopeVersion === EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION) {
      return classifyMicrosoftRefreshTokenResponseWithScopeValidator(
        response,
        validateAndNormalizePhaseBTokenResponseScope,
      );
    }
    if (scopeVersion === CONTENT_SCOPE_VERSION) {
      return classifyMicrosoftRefreshTokenResponseWithScopeValidator(
        response,
        validateContentReadTokenScope,
      );
    }
    if (scopeVersion === 'controlled_drafting_v1') {
      // Lazy require avoids a load-time cycle with Chapter 1/4C owners.
      // Mail.Send or any extra dangerous Graph scope → null → uncertain.
      let validateControlledDraftingTokenResponseScope;
      try {
        ({ validateControlledDraftingTokenResponseScope } = require('./email-luna-controlled-drafting-provider-contract'));
      } catch (_) {
        return uncertain();
      }
      if (typeof validateControlledDraftingTokenResponseScope !== 'function') return uncertain();
      return classifyMicrosoftRefreshTokenResponseWithScopeValidator(
        response,
        (scope) => {
          try {
            const normalized = validateControlledDraftingTokenResponseScope(scope);
            return typeof normalized === 'string' ? normalized : null;
          } catch (_) {
            return null;
          }
        },
      );
    }
    return uncertain();
  } catch (_) {
    return uncertain();
  }
}

module.exports = Object.freeze({
  SCOPE_VERSION_MAX_CHARS,
  EMAIL_MS_DELEGATED_SCOPE_VERSION,
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
  CONTENT_SCOPE_VERSION,
  CONTROLLED_DRAFTING_SCOPE_VERSION: 'controlled_drafting_v1',
  classifyMicrosoftRefreshTokenResponseForScopeVersion,
});
