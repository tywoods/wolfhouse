'use strict';
/** Private, server-owned transition policy. No registry or policy object is exported. */
const {
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
  EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES,
  EMAIL_MS_DELEGATED_SCOPE_VERSION,
} = require('./email-microsoft-delegated-oauth-contract');

const OPERATION = Object.freeze({ PHASE_B_REAUTHORIZATION: Symbol('phase_b_reauthorization') });
function deepFreeze(value, seen = new Set()) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}
const POLICY = deepFreeze({
  [OPERATION.PHASE_B_REAUTHORIZATION]: {
    authorizationIntent: 'phase_b_reauthorization',
    sourceScopeVersion: EMAIL_MS_DELEGATED_SCOPE_VERSION,
    targetScopeVersion: EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
    authorizationScopes: ['openid', 'profile', 'offline_access', ...EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES],
  },
});
function select(operation) {
  if (operation !== OPERATION.PHASE_B_REAUTHORIZATION) throw new TypeError('unknown_reauthorization_operation');
  return POLICY[operation];
}
function phaseBValue(name) { return select(OPERATION.PHASE_B_REAUTHORIZATION)[name]; }
module.exports = Object.freeze({
  authorizationIntent: () => phaseBValue('authorizationIntent'),
  sourceScopeVersion: () => phaseBValue('sourceScopeVersion'),
  targetScopeVersion: () => phaseBValue('targetScopeVersion'),
  authorizationScopeString: () => phaseBValue('authorizationScopes').join(' '),
});
