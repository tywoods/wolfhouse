'use strict';
/** Private, closed, server-owned Phase-B transition policy and static statement plans. */
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
const transactionStatement = `INSERT INTO tenant_email_oauth_transactions (client_id, location_id, staff_user_id, auth_session_id, endpoint_id, state_hash, code_verifier, nonce, issued_at, expires_at, authorization_intent, scope_version, prior_grant_generation) SELECT $1::uuid, tl.id, $3::uuid, $4::uuid, e.id, $6::bytea, $7, $8, $9, $10, 'phase_b_reauthorization', 'phase_b_v1', g.grant_generation FROM tenant_channel_endpoints e INNER JOIN tenant_locations tl ON tl.client_id=e.client_id AND tl.location_id=e.location_id INNER JOIN tenant_email_delegated_grants g ON g.client_id=e.client_id AND g.endpoint_id=e.id WHERE e.client_id=$1::uuid AND e.id=$5::uuid AND tl.id=$2::uuid AND e.provider='microsoft_graph' AND e.auth_mode='delegated_authorization_code' AND e.connector_mode='microsoft_delegated_oauth' AND e.binding_status='verified' AND e.mailbox_kind='user' AND e.mailbox_access_kind='own_user' AND g.scope_version='phase_a_v2' AND g.grant_status='active' AND g.reconcile_state='clean' AND g.grant_lease_token IS NULL AND g.grant_lease_owner IS NULL AND g.grant_lease_until IS NULL AND g.grant_generation=$11::bigint RETURNING expires_at, prior_grant_generation, authorization_intent, scope_version`;
const callbackConsumeStatement = "UPDATE tenant_email_oauth_transactions SET consumed_at=$4 WHERE state_hash=$1::bytea AND client_id=$2::uuid AND auth_session_id=$3::uuid AND consumed_at IS NULL AND expires_at>$4 AND authorization_intent='phase_b_reauthorization' AND scope_version='phase_b_v1' AND prior_grant_generation IS NOT NULL AND prior_grant_generation >= 1 RETURNING id, location_id, staff_user_id, code_verifier, nonce, endpoint_id, authorization_intent, scope_version, prior_grant_generation";
const replacerLockStatement = `SELECT e.id, e.client_id, e.provider, e.auth_mode, e.connector_mode, e.binding_status, e.provider_tenant_id, e.provider_principal_oid, e.provider_resource_id, e.public_address, e.mailbox_kind, e.mailbox_access_kind, g.grant_generation, g.grant_status, g.reconcile_state, g.scope_version, g.grant_lease_token, g.last_operation_id, g.envelope_version, g.aead_alg, g.kek_wrap_alg, g.kek_key_name, g.kek_key_version, g.nonce, g.ciphertext, g.auth_tag, g.wrapped_dek FROM tenant_channel_endpoints e INNER JOIN tenant_email_delegated_grants g ON g.client_id = e.client_id AND g.endpoint_id = e.id WHERE e.client_id = $1 AND e.id = $2 FOR UPDATE OF e, g`;
const replacerCasStatement = `UPDATE tenant_email_delegated_grants SET grant_generation=$3::bigint, last_operation_id=$4, scope_version='phase_b_v1', grant_status='active', grant_lease_owner=NULL, grant_lease_token=NULL, grant_lease_until=NULL, reconcile_state='clean', reconcile_detail_code=NULL, envelope_version=$5, aead_alg=$6, kek_wrap_alg=$7, kek_key_name=$8, kek_key_version=$9, nonce=$10, ciphertext=$11, auth_tag=$12, wrapped_dek=$13, updated_by=$14, updated_at=NOW() WHERE client_id=$1 AND endpoint_id=$2 AND grant_generation=$15::bigint AND scope_version='phase_a_v2' AND grant_status='active' AND reconcile_state='clean' AND grant_lease_token IS NULL AND grant_lease_owner IS NULL AND grant_lease_until IS NULL RETURNING client_id, endpoint_id, grant_generation, grant_status, reconcile_state, scope_version, last_operation_id`;
const POLICY = deepFreeze({
  [OPERATION.PHASE_B_REAUTHORIZATION]: {
    authorizationIntent: 'phase_b_reauthorization',
    sourceScopeVersions: [EMAIL_MS_DELEGATED_SCOPE_VERSION],
    targetScopeVersion: EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
    authorizationScopes: ['openid', 'profile', 'offline_access', ...EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES],
    verifiedMicrosoftDelegatedConnector: { provider: 'microsoft_graph', authMode: 'delegated_authorization_code', connectorMode: 'microsoft_delegated_oauth', bindingStatus: 'verified' },
    ownUserMailbox: { mailboxKind: 'user', mailboxAccessKind: 'own_user' },
    activeCleanUnleased: { grantStatus: 'active', reconcileState: 'clean', leaseToken: null, leaseOwner: null, leaseUntil: null },
    priorGenerationPredicate: 'canonical_positive_bigint_equal',
    transactionStatement, callbackConsumeStatement, replacerLockStatement, replacerCasStatement,
  },
});
function phaseB() { return POLICY[OPERATION.PHASE_B_REAUTHORIZATION]; }
function value(name) { const v = phaseB()[name]; if (v === undefined) throw new Error('phase_b_policy_contract_invalid'); return v; }
module.exports = Object.freeze({
  authorizationIntent: () => value('authorizationIntent'),
  sourceScopeVersion: () => value('sourceScopeVersions')[0],
  targetScopeVersion: () => value('targetScopeVersion'),
  authorizationScopeString: () => value('authorizationScopes').join(' '),
  transactionStatement: () => value('transactionStatement'),
  callbackConsumeStatement: () => value('callbackConsumeStatement'),
  replacerLockStatement: () => value('replacerLockStatement'),
  replacerCasStatement: () => value('replacerCasStatement'),
  verifiedMicrosoftDelegatedConnector: () => value('verifiedMicrosoftDelegatedConnector'),
  ownUserMailbox: () => value('ownUserMailbox'),
  activeCleanUnleased: () => value('activeCleanUnleased'),
  priorGenerationPredicate: () => value('priorGenerationPredicate'),
});
