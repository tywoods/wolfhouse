'use strict';

/** Microsoft delegated OAuth (Slice 2C) offline freeze. No live OAuth/Graph/MSAL/activation. Independent of 2A/2B. @module email-microsoft-delegated-oauth-contract */

const crypto = require('crypto');
const { validateEmailMailboxSecretRef } = require('./email-mailbox-adapter-contract');
const { validateEmailConnectorAuthModePair } = require('./email-connector-auth-mode-contract');

const EMAIL_MS_DELEGATED_PROVIDER = 'microsoft_graph';
const EMAIL_MS_DELEGATED_AUTH_MODE = 'delegated_authorization_code';
const EMAIL_MS_DELEGATED_CONNECTOR_MODE = 'microsoft_delegated_oauth';
const EMAIL_MS_DELEGATED_ACCOUNT_AUDIENCE = 'organizations';
const EMAIL_MS_DELEGATED_AUTHORITY_HOST = 'login.microsoftonline.com';
const EMAIL_MS_DELEGATED_TOKEN_HOST = 'login.microsoftonline.com';
const EMAIL_MS_DELEGATED_GRAPH_HOST = 'graph.microsoft.com';
const EMAIL_MS_DELEGATED_REDIRECT_URI_ID = 'luna_ms_delegated_oauth_callback';
const EMAIL_MS_DELEGATED_CLIENT_TYPE = 'confidential_web';
const EMAIL_MS_DELEGATED_PKCE_METHOD = 'S256';
const EMAIL_MS_DELEGATED_TOKEN_ENDPOINT_CLIENT_AUTH_REQUIRED = true;
const EMAIL_MS_DELEGATED_TOKEN_ENDPOINT_CLIENT_AUTH_METHODS = Object.freeze([
  'private_key_jwt', 'client_secret_post',
]);
const EMAIL_MS_DELEGATED_PREFERRED_TOKEN_ENDPOINT_CLIENT_AUTH = 'private_key_jwt';
// client_secret_post: client_id/client_secret as Microsoft v2 token form fields; no Authorization Basic.
const EMAIL_MS_DELEGATED_CLIENT_SECRET_POST_DECLARATION = Object.freeze({
  client_id_token_form_field: true, client_secret_token_form_field: true,
  authorization_basic_header: false,
});
const EMAIL_MS_DELEGATED_PHASE_A_OIDC_SCOPES = Object.freeze(['openid', 'profile', 'offline_access']);
const EMAIL_MS_DELEGATED_PHASE_A_OPTIONAL_OIDC_SCOPES = Object.freeze(['email']);
// phase_a_v2 Graph exact set: User.Read (/me bind) + Mail.ReadBasic.
const EMAIL_MS_DELEGATED_PHASE_A_GRAPH_DELEGATED_SCOPES = Object.freeze(['User.Read', 'Mail.ReadBasic']);
const EMAIL_MS_DELEGATED_PHASE_B_GRAPH_DELEGATED_SCOPES = Object.freeze(['Mail.ReadWrite', 'Mail.Send']);
const EMAIL_MS_DELEGATED_SCOPE_VERSION = 'phase_a_v2';
const EMAIL_MS_DELEGATED_ME_REQUIRED_DELEGATED_PERMISSION = 'User.Read';
const EMAIL_MS_DELEGATED_CANONICAL_ADDRESS_FIELDS_ROLE = 'display_routing_evidence_only';
const EMAIL_MS_DELEGATED_PRINCIPAL_KEY_PREFIX = 'ms_delegated_principal:';
const EMAIL_MS_DELEGATED_PRINCIPAL_VALIDATION_RULES = Object.freeze({
  signature_and_keys: 'required', issuer: 'derived_from_validated_organizational_tenant',
  audience: 'luna_app_id', exp_nbf: 'required', nonce: 'required_match_transaction',
  tid: 'guid', oid: 'guid', sub: 'correlate_only',
  principal_is_mailbox_identity: false, email_claim_is_identity: false,
});
const EMAIL_MS_DELEGATED_OAUTH_TRANSACTION_TTL_SECONDS = 600;
const EMAIL_MS_DELEGATED_OAUTH_TRANSACTION_MIN_ENTROPY_BYTES = 32;
const EMAIL_MS_DELEGATED_GRANT_SECRET_MATERIAL_KEY_NAMES = Object.freeze(['refresh_token']);
const EMAIL_MS_DELEGATED_REFRESH_ROTATION_POLICY = Object.freeze({
  atomic_cas_or_lease: 'required', generation_handling: 'required',
  retain_old_until_durable_replacement: true,
  terminal_reauthorization_reasons: Object.freeze([
    'invalid_grant', 'revocation', 'policy', 'consent_loss',
  ]),
  app_wide_refresh_token: false,
});
// Slice 2F-A: custody schema/module present (dedicated grant table + envelope contracts).
// Runtime injection remains false offline; refresh-exchange adapter still blocked (2F-B+/later).
// Owner-approved: AEAD ciphertext + wrapped DEK may persist in Postgres (raw tokens forbidden).
const EMAIL_MS_DELEGATED_REFRESH_TOKEN_CUSTODY = Object.freeze({
  custody_deferred: false,
  cas_deferred: false,
  durable_grant_custodian_module_present: true,
  durable_grant_custodian_injected: false,
  refresh_exchange_adapter_allowed: false,
  block_reason: 'refresh_exchange_adapter_required',
  envelope_ciphertext_in_postgres_owner_approved: true,
  raw_refresh_token_in_postgres_forbidden: true,
});
const EMAIL_MS_DELEGATED_MAILBOX_ACCESS_KIND_PHASE_A = 'own_user';
const EMAIL_MS_DELEGATED_FUTURE_LIVE_MAILBOX_PROOF_FIELDS = Object.freeze([
  'durable_microsoft_mailbox_resource_id', 'canonical_address', 'mailbox_kind', 'access_kind',
]);
// Own-user live bind freeze (no Graph): /me.id == provider_principal_oid → provider_resource_id.
// Equality expected for this path; principal vs mailbox remain separate fields/concepts.
const EMAIL_MS_DELEGATED_OWN_USER_LIVE_BINDING = Object.freeze({
  mailbox_kind: 'user', access_kind: 'own_user', live_graph_path: '/me', me_id_field: 'id',
  required_delegated_permission: EMAIL_MS_DELEGATED_ME_REQUIRED_DELEGATED_PERMISSION,
  require_me_id_equals_provider_principal_oid: true,
  persist_me_id_as_provider_resource_id: true,
  equality_expected_concepts_remain_separate: true,
  offline_mailbox_derivation_forbidden: true, performs_graph: false,
  canonical_address_fields_role: EMAIL_MS_DELEGATED_CANONICAL_ADDRESS_FIELDS_ROLE,
  mail_upn_email_not_ownership_keys: true,
});
const EMAIL_MS_DELEGATED_MANUAL_VALIDATION_STATES = Object.freeze([
  'pending_manual_validation', 'manual_validation_required',
]);
const EMAIL_MS_DELEGATED_ACTIVATION_INVARIANTS = Object.freeze({
  one_verified_provider_tid_mailbox_per_active_luna_client: true,
  reconnect_same_client_updates_rotates: true,
  cross_client_collision_requires_explicit_transfer_or_recovery: true,
  one_principal_may_administer_multiple_mailboxes: true,
  aliases_do_not_create_accounts: true,
  schema_enforces_invariants: false, readiness_activation_complete: false,
});
const EMAIL_MS_DELEGATED_AUTOMATION_MODE = 'off';

const FORBIDDEN_PUBLIC_VALUE_KEY_SET = new Set([
  'access_token', 'refresh_token', 'id_token', 'authorization_code', 'code',
  'state', 'nonce', 'pkce_verifier', 'pkce_challenge', 'code_verifier', 'code_challenge',
  'client_secret', 'private_key', 'client_assertion', 'raw_error', 'raw_errors',
  'password', 'api_key', 'Authorization', 'authorization', 'token', 'raw_secret',
  'clientSecret', 'accessToken', 'refreshToken', 'idToken',
]);
const TOKEN_AUTH_METHOD_SET = new Set(EMAIL_MS_DELEGATED_TOKEN_ENDPOINT_CLIENT_AUTH_METHODS);
const PHASE_A_OIDC_SET = new Set(EMAIL_MS_DELEGATED_PHASE_A_OIDC_SCOPES);
const PHASE_A_GRAPH_SET = new Set(EMAIL_MS_DELEGATED_PHASE_A_GRAPH_DELEGATED_SCOPES);
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// RFC 7636: verifier 43–128 unreserved; S256 challenge = unpadded base64url(SHA256) = 43 chars.
const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/;
const DECLARATION_KEYS = [
  'provider', 'auth_mode', 'connector_mode', 'client_auth_model', 'account_audience',
  'redirect_uri_id', 'scope_plan', 'mailbox_access', 'grant_secret_package',
  'network_enabled', 'registry_activation_enabled', 'inbound_enabled',
  'outbound_enabled', 'default_automation_mode',
];
const CLIENT_AUTH_MODEL_KEYS = [
  'client_type', 'pkce_method', 'token_endpoint_client_authentication',
  'browser_holds_app_credential', 'tenant_supplies_app_credential',
];
const SCOPE_PLAN_KEYS = ['phase', 'oidc', 'graph_delegated', 'include_email_scope'];
const OAUTH_TX_INPUT_KEY_SET = new Set([
  'state', 'nonce', 'pkce_verifier', 'pkce_challenge', 'pkce_method', 'redirect_uri_id',
  'luna_client_id', 'location_id', 'staff_session_id', 'connector_mode', 'auth_mode',
  'scope_version', 'issued_at', 'expires_at', 'now_at', 'consume', 'prior_consumed',
  'expected_luna_client_id', 'expected_location_id', 'expected_staff_session_id',
]);
const PRINCIPAL_INPUT_KEY_SET = new Set([
  'tid', 'oid', 'sub', 'aud', 'iss', 'exp', 'nbf', 'nonce', 'email', 'preferred_username',
  'signature_valid', 'keys_validated', 'expected_nonce', 'luna_app_id',
  'claim_email_as_principal', 'claim_principal_is_mailbox',
]);
const AUTHORITY_INJECTION_KEYS = [
  'authority_url', 'issuer', 'issuer_url', 'token_url', 'token_endpoint',
  'authorize_url', 'authorization_endpoint', 'graph_url', 'graph_endpoint',
  'tenant', 'tenant_id', 'tenant_hint_url',
];
const AUTHORITY_ALLOWED = [
  'account_audience', 'authority_host', 'token_host', 'graph_host', 'redirect_uri_id',
];

function deepFreezeFresh(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return Object.freeze(v.map(deepFreezeFresh));
  const o = {};
  for (const k of Object.keys(v)) o[k] = deepFreezeFresh(v[k]);
  return Object.freeze(o);
}
function fail(error, details) {
  const out = { ok: false, error: String(error) };
  if (details !== undefined) out.details = deepFreezeFresh(details);
  return Object.freeze(out);
}
function ok(value) {
  return value === undefined
    ? Object.freeze({ ok: true })
    : Object.freeze({ ok: true, value: deepFreezeFresh(value) });
}
function wrap(fn, err) {
  return (input) => {
    try { return fn(input); } catch { return fail(err, { reason: 'reflection_failed' }); }
  };
}

/** Descriptor-safe own-data plain-record reader. */
function snapshotOwnDataProps(obj) {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, reason: 'must_be_object' };
  }
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) return { ok: false, reason: 'must_be_object' };
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key === 'symbol') return { ok: false, reason: 'symbol_key' };
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc) continue;
    if (typeof desc.get === 'function' || typeof desc.set === 'function') {
      return { ok: false, reason: 'accessor', key: String(key) };
    }
    out[key] = desc.value;
  }
  return { ok: true, value: out };
}
function exactKeys(snap, keys) {
  const have = Object.keys(snap);
  if (have.length !== keys.length) return false;
  const set = new Set(keys);
  for (const k of have) if (!set.has(k)) return false;
  return true;
}
function subsetKeys(snap, allowed) {
  const set = allowed instanceof Set ? allowed : new Set(allowed);
  for (const k of Object.keys(snap)) if (!set.has(k)) return false;
  return true;
}
function rejectForbiddenKeys(snap) {
  for (const key of Object.keys(snap)) {
    if (FORBIDDEN_PUBLIC_VALUE_KEY_SET.has(key)) {
      return fail('declaration_forbidden_field', { reason: 'forbidden_field' });
    }
  }
  return ok();
}
function keySetFail(obj, keys, error) {
  if (exactKeys(obj, keys)) return null;
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k)) return fail(error, { reason: 'unknown_key' });
  }
  return fail(error, { reason: 'key_set' });
}
function snapOrFail(raw, error) {
  const snap = snapshotOwnDataProps(raw);
  if (!snap.ok) return { ok: false, fail: fail(error, { reason: snap.reason }) };
  const forbidden = rejectForbiddenKeys(snap.value);
  if (!forbidden.ok) return { ok: false, fail: forbidden };
  return { ok: true, value: snap.value };
}
function snapshotStringArray(arr) {
  if (!Array.isArray(arr)) return { ok: false, reason: 'must_be_array' };
  const proto = Object.getPrototypeOf(arr);
  if (proto !== Array.prototype && proto !== null) return { ok: false, reason: 'array_prototype' };
  for (const key of Reflect.ownKeys(arr)) {
    if (typeof key === 'symbol') return { ok: false, reason: 'symbol_key' };
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key)) return { ok: false, reason: 'array_extra_key' };
  }
  const out = [];
  for (let i = 0; i < arr.length; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(arr, i)) return { ok: false, reason: 'sparse_array' };
    const desc = Object.getOwnPropertyDescriptor(arr, String(i));
    if (!desc || typeof desc.get === 'function' || typeof desc.set === 'function') {
      return { ok: false, reason: 'accessor' };
    }
    if (typeof desc.value !== 'string') return { ok: false, reason: 'non_string_element' };
    out.push(desc.value);
  }
  return { ok: true, value: out };
}
function stringArraySetEqual(actual, expected, expectedSet) {
  if (actual.length !== expected.length) return false;
  const seen = new Set();
  for (const item of actual) {
    if (!expectedSet.has(item) || seen.has(item)) return false;
    seen.add(item);
  }
  return seen.size === expected.length;
}
const isGuid = (v) => typeof v === 'string' && GUID_RE.test(v);
const isSafeInt = (v) => typeof v === 'number' && Number.isFinite(v) && Number.isSafeInteger(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const highEntropyString = (v, n) => typeof v === 'string' && v.length >= n && !/\s/.test(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const pkceS256Challenge = (v) => crypto.createHash('sha256').update(v, 'ascii').digest('base64url');
function timingSafeStrEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8'); const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function requireExactFalse(v, field) {
  if (v !== false) return fail('network_or_activation_invalid', { reason: 'flag_not_false', field });
  return ok();
}

function validateScopePlanImpl(raw) {
  const s = snapOrFail(raw, 'scope_plan_invalid');
  if (!s.ok) return s.fail;
  const plan = s.value;
  const ks = keySetFail(plan, SCOPE_PLAN_KEYS, 'scope_plan_invalid');
  if (ks) return ks;
  if (plan.phase !== 'A') return fail('scope_plan_invalid', { reason: 'phase_not_a' });
  if (plan.include_email_scope !== true && plan.include_email_scope !== false) {
    return fail('scope_plan_invalid', { reason: 'include_email_scope_not_boolean' });
  }
  const oidc = snapshotStringArray(plan.oidc);
  if (!oidc.ok) return fail('scope_plan_invalid', { reason: oidc.reason });
  const graph = snapshotStringArray(plan.graph_delegated);
  if (!graph.ok) return fail('scope_plan_invalid', { reason: graph.reason });
  for (const tok of oidc.value.concat(graph.value)) {
    if (tok.includes('.Shared')) return fail('scope_plan_invalid', { reason: 'shared_scope_forbidden' });
    if (tok === '/.default' || tok.endsWith('/.default')) {
      return fail('scope_plan_invalid', { reason: 'application_default_scope_forbidden' });
    }
    if (tok.startsWith('Application ') || tok.endsWith('.All')
        || tok === 'Mail.ReadWrite' || tok === 'Mail.Send' || tok === 'Mail.Read') {
      return fail('scope_plan_invalid', { reason: 'forbidden_scope' });
    }
  }
  if (!stringArraySetEqual(oidc.value, EMAIL_MS_DELEGATED_PHASE_A_OIDC_SCOPES, PHASE_A_OIDC_SET)) {
    return fail('scope_plan_invalid', { reason: 'oidc_not_phase_a' });
  }
  if (!stringArraySetEqual(graph.value, EMAIL_MS_DELEGATED_PHASE_A_GRAPH_DELEGATED_SCOPES, PHASE_A_GRAPH_SET)) {
    return fail('scope_plan_invalid', { reason: 'graph_not_phase_a' });
  }
  return ok({
    phase: 'A', scope_version: EMAIL_MS_DELEGATED_SCOPE_VERSION,
    oidc: EMAIL_MS_DELEGATED_PHASE_A_OIDC_SCOPES.slice(),
    graph_delegated: EMAIL_MS_DELEGATED_PHASE_A_GRAPH_DELEGATED_SCOPES.slice(),
    include_email_scope: plan.include_email_scope === true, email_scope_authoritative: false,
    optional_oidc_display_only: plan.include_email_scope === true
      ? EMAIL_MS_DELEGATED_PHASE_A_OPTIONAL_OIDC_SCOPES.slice() : [],
    me_required_delegated_permission: EMAIL_MS_DELEGATED_ME_REQUIRED_DELEGATED_PERMISSION,
    canonical_address_fields_role: EMAIL_MS_DELEGATED_CANONICAL_ADDRESS_FIELDS_ROLE,
    phase_b_graph_delegated_future: EMAIL_MS_DELEGATED_PHASE_B_GRAPH_DELEGATED_SCOPES.slice(),
    phase_b_included_in_phase_a: false,
  });
}

function validateClientAuthModelImpl(raw) {
  const s = snapOrFail(raw, 'client_auth_model_invalid');
  if (!s.ok) return s.fail;
  const model = s.value;
  const ks = keySetFail(model, CLIENT_AUTH_MODEL_KEYS, 'client_auth_model_invalid');
  if (ks) return ks;
  if (model.client_type !== EMAIL_MS_DELEGATED_CLIENT_TYPE) return fail('client_auth_model_invalid', { reason: 'client_type' });
  if (model.pkce_method !== EMAIL_MS_DELEGATED_PKCE_METHOD) return fail('client_auth_model_invalid', { reason: 'pkce_method' });
  const tokenAuth = model.token_endpoint_client_authentication;
  if (tokenAuth === 'none' || tokenAuth === 'pkce_only' || tokenAuth === false) return fail('client_auth_model_invalid', { reason: 'pkce_only_insufficient' });
  // Reject client_secret_basic explicitly (no silent alias to client_secret_post).
  if (tokenAuth === 'client_secret_basic') return fail('client_auth_model_invalid', { reason: 'client_secret_basic_forbidden' });
  if (typeof tokenAuth !== 'string' || !TOKEN_AUTH_METHOD_SET.has(tokenAuth)) {
    return fail('client_auth_model_invalid', { reason: 'token_endpoint_client_auth' });
  }
  if (model.browser_holds_app_credential !== false) return fail('client_auth_model_invalid', { reason: 'browser_must_not_hold_app_credential' });
  if (model.tenant_supplies_app_credential !== false) return fail('client_auth_model_invalid', { reason: 'tenant_must_not_supply_app_credential' });
  const out = {
    client_type: EMAIL_MS_DELEGATED_CLIENT_TYPE, pkce_method: EMAIL_MS_DELEGATED_PKCE_METHOD,
    token_endpoint_client_authentication: tokenAuth,
    token_endpoint_client_authentication_required: EMAIL_MS_DELEGATED_TOKEN_ENDPOINT_CLIENT_AUTH_REQUIRED,
    preferred_token_endpoint_client_authentication: EMAIL_MS_DELEGATED_PREFERRED_TOKEN_ENDPOINT_CLIENT_AUTH,
    allowed_token_endpoint_client_authentication: EMAIL_MS_DELEGATED_TOKEN_ENDPOINT_CLIENT_AUTH_METHODS.slice(),
    browser_holds_app_credential: false, tenant_supplies_app_credential: false,
    pkce_alone_sufficient: false,
  };
  if (tokenAuth === 'client_secret_post') out.client_secret_post = { ...EMAIL_MS_DELEGATED_CLIENT_SECRET_POST_DECLARATION };
  return ok(out);
}

function validateAuthorityImpl(raw) {
  const s = snapOrFail(raw, 'authority_invalid');
  if (!s.ok) return s.fail;
  const obj = s.value;
  for (const k of AUTHORITY_INJECTION_KEYS) {
    if (hasOwn(obj, k)) return fail('authority_invalid', { reason: 'caller_supplied_url_or_tenant_forbidden' });
  }
  if (!subsetKeys(obj, AUTHORITY_ALLOWED)) return fail('authority_invalid', { reason: 'unknown_key' });
  for (const k of AUTHORITY_ALLOWED) {
    if (!hasOwn(obj, k)) return fail('authority_invalid', { reason: 'missing_key' });
  }
  if (obj.account_audience === 'consumers' || obj.account_audience === 'common') return fail('authority_invalid', { reason: 'personal_or_mixed_accounts_forbidden' });
  if (obj.account_audience !== EMAIL_MS_DELEGATED_ACCOUNT_AUDIENCE) return fail('authority_invalid', { reason: 'account_audience' });
  if (obj.authority_host !== EMAIL_MS_DELEGATED_AUTHORITY_HOST) return fail('authority_invalid', { reason: 'authority_host_not_allowlisted' });
  if (obj.token_host !== EMAIL_MS_DELEGATED_TOKEN_HOST) return fail('authority_invalid', { reason: 'token_host_not_allowlisted' });
  if (obj.graph_host !== EMAIL_MS_DELEGATED_GRAPH_HOST) return fail('authority_invalid', { reason: 'graph_host_not_allowlisted' });
  if (obj.redirect_uri_id !== EMAIL_MS_DELEGATED_REDIRECT_URI_ID) return fail('authority_invalid', { reason: 'redirect_uri_id' });
  return ok({
    account_audience: EMAIL_MS_DELEGATED_ACCOUNT_AUDIENCE,
    authority_host: EMAIL_MS_DELEGATED_AUTHORITY_HOST, token_host: EMAIL_MS_DELEGATED_TOKEN_HOST,
    graph_host: EMAIL_MS_DELEGATED_GRAPH_HOST, redirect_uri_id: EMAIL_MS_DELEGATED_REDIRECT_URI_ID,
    caller_supplied_tenant_issuer_authority_token_graph_url: false,
  });
}

function txFail(reason, extra) {
  return fail('oauth_transaction_invalid', extra ? { reason, ...extra } : { reason });
}
function validateOauthTransactionImpl(raw) {
  const snap = snapshotOwnDataProps(raw);
  if (!snap.ok) return txFail(snap.reason);
  const tx = snap.value;
  if (!subsetKeys(tx, OAUTH_TX_INPUT_KEY_SET)) return txFail('unknown_key');
  // Fail-closed callback consume declaration (offline; runtime must CAS server state).
  for (const k of [
    'state', 'nonce', 'pkce_verifier', 'pkce_challenge', 'pkce_method', 'redirect_uri_id',
    'luna_client_id', 'location_id', 'staff_session_id', 'connector_mode', 'auth_mode',
    'scope_version', 'issued_at', 'expires_at', 'now_at', 'consume', 'prior_consumed',
    'expected_luna_client_id', 'expected_location_id', 'expected_staff_session_id',
  ]) {
    if (!hasOwn(tx, k)) return txFail('missing_key', { key: k });
  }
  if (tx.pkce_method !== EMAIL_MS_DELEGATED_PKCE_METHOD) return txFail('pkce_method');
  if (tx.redirect_uri_id !== EMAIL_MS_DELEGATED_REDIRECT_URI_ID) return txFail('redirect_uri_id');
  if (tx.connector_mode !== EMAIL_MS_DELEGATED_CONNECTOR_MODE) return txFail('connector_mode');
  if (tx.auth_mode !== EMAIL_MS_DELEGATED_AUTH_MODE) return txFail('auth_mode');
  if (tx.scope_version !== EMAIL_MS_DELEGATED_SCOPE_VERSION) return txFail('scope_version');
  const min = EMAIL_MS_DELEGATED_OAUTH_TRANSACTION_MIN_ENTROPY_BYTES;
  if (!highEntropyString(tx.state, min)) return txFail('state_entropy');
  if (!highEntropyString(tx.nonce, min)) return txFail('nonce_entropy');
  if (typeof tx.pkce_verifier !== 'string' || !PKCE_VERIFIER_RE.test(tx.pkce_verifier)) return txFail('pkce_verifier');
  if (typeof tx.pkce_challenge !== 'string' || !PKCE_CHALLENGE_RE.test(tx.pkce_challenge)) return txFail('pkce_challenge');
  if (!timingSafeStrEq(pkceS256Challenge(tx.pkce_verifier), tx.pkce_challenge)) return txFail('pkce_s256_mismatch');
  if (!isGuid(tx.luna_client_id)) return txFail('luna_client_id');
  if (!isNonEmptyString(tx.location_id) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tx.location_id)) return txFail('location_id');
  if (!isNonEmptyString(tx.staff_session_id) || tx.staff_session_id.length < 8) return txFail('staff_session_id');
  if (!isSafeInt(tx.issued_at) || !isSafeInt(tx.expires_at) || !isSafeInt(tx.now_at)) return txFail('timestamps');
  if (tx.expires_at <= tx.issued_at) return txFail('ttl_window');
  const ttl = tx.expires_at - tx.issued_at;
  if (ttl <= 0 || ttl > EMAIL_MS_DELEGATED_OAUTH_TRANSACTION_TTL_SECONDS) return txFail('ttl_exceeds_bound');
  if (tx.now_at < tx.issued_at || tx.now_at >= tx.expires_at) return txFail('expired_or_not_yet_valid');
  if (tx.expected_luna_client_id !== tx.luna_client_id) return txFail('client_mix_up');
  if (tx.expected_location_id !== tx.location_id) return txFail('location_mix_up');
  if (tx.expected_staff_session_id !== tx.staff_session_id) return txFail('session_mix_up');
  // Callback consume only: prior_consumed must be exactly false; consume must be exactly true.
  // Validator does not persist; runtime callback must atomically compare-and-consume server state.
  if (tx.prior_consumed === true) return txFail('replay');
  if (tx.prior_consumed !== false) return txFail('prior_consumed_not_boolean_false');
  if (tx.consume !== true) return txFail('consume_not_true');
  return ok({
    transaction_id_present: true, redirect_uri_id: EMAIL_MS_DELEGATED_REDIRECT_URI_ID,
    luna_client_id: tx.luna_client_id, location_id: tx.location_id, staff_session_present: true,
    ownership_bound: true, connector_mode: EMAIL_MS_DELEGATED_CONNECTOR_MODE,
    auth_mode: EMAIL_MS_DELEGATED_AUTH_MODE, scope_version: EMAIL_MS_DELEGATED_SCOPE_VERSION,
    issued_at: tx.issued_at, expires_at: tx.expires_at, status: 'consumed',
    atomic_consume_required: true, replay_rejected: true,
    runtime_atomic_compare_and_consume: true, pkce_s256_verified: true,
    public_dto_includes_protocol_artifacts: false,
  });
}

function buildPrincipalKey(tid, oid) {
  return `${EMAIL_MS_DELEGATED_PRINCIPAL_KEY_PREFIX}${tid}:${oid}`;
}

function validatePrincipalImpl(raw) {
  const snap = snapshotOwnDataProps(raw);
  if (!snap.ok) return fail('principal_invalid', { reason: snap.reason });
  const p = snap.value;
  if (!subsetKeys(p, PRINCIPAL_INPUT_KEY_SET)) return fail('principal_invalid', { reason: 'unknown_key' });
  if (p.claim_email_as_principal === true) return fail('principal_invalid', { reason: 'email_as_identity_forbidden' });
  if (p.claim_principal_is_mailbox === true) return fail('principal_invalid', { reason: 'principal_is_not_mailbox_identity' });
  for (const k of [
    'tid', 'oid', 'aud', 'iss', 'exp', 'nbf', 'nonce',
    'signature_valid', 'keys_validated', 'expected_nonce', 'luna_app_id',
  ]) {
    if (!hasOwn(p, k)) return fail('principal_invalid', { reason: 'missing_key' });
  }
  if (p.signature_valid !== true || p.keys_validated !== true) return fail('principal_invalid', { reason: 'signature_or_keys' });
  if (!isGuid(p.tid) || !isGuid(p.oid)) return fail('principal_invalid', { reason: 'tid_oid_not_guid' });
  if (!isNonEmptyString(p.luna_app_id) || p.aud !== p.luna_app_id) return fail('principal_invalid', { reason: 'aud' });
  if (p.iss !== `https://${EMAIL_MS_DELEGATED_AUTHORITY_HOST}/${p.tid}/v2.0`) return fail('principal_invalid', { reason: 'issuer' });
  if (!isSafeInt(p.exp) || !isSafeInt(p.nbf) || p.exp <= p.nbf) return fail('principal_invalid', { reason: p.exp <= p.nbf ? 'exp_nbf_order' : 'exp_nbf' });
  if (!isNonEmptyString(p.nonce) || p.nonce !== p.expected_nonce) return fail('principal_invalid', { reason: 'nonce_mismatch' });
  if (hasOwn(p, 'sub') && typeof p.sub !== 'string') return fail('principal_invalid', { reason: 'sub_not_string' });
  return ok({
    principal_key: buildPrincipalKey(p.tid, p.oid), tid: p.tid, oid: p.oid,
    sub_correlate_only: true, principal_is_mailbox_identity: false, email_claim_is_identity: false,
    validation_rules: { ...EMAIL_MS_DELEGATED_PRINCIPAL_VALIDATION_RULES },
  });
}

function validateMailboxBindingHintImpl(raw) {
  const s = snapOrFail(raw, 'mailbox_binding_invalid');
  if (!s.ok) return s.fail;
  const b = s.value;
  if (!subsetKeys(b, [
    'requested_address', 'claimed_shared', 'claim_godaddy_supported',
    'claim_binding_verified_offline', 'claim_principal_equals_mailbox',
    'reseller_or_shared_restriction',
  ])) {
    return fail('mailbox_binding_invalid', { reason: 'unknown_key' });
  }
  if (b.claim_binding_verified_offline === true) return fail('mailbox_binding_invalid', { reason: 'offline_binding_not_verified' });
  if (b.claim_principal_equals_mailbox === true) return fail('mailbox_binding_invalid', { reason: 'mailbox_is_not_principal' });
  if (b.claim_godaddy_supported === true) return fail('mailbox_binding_invalid', { reason: 'godaddy_support_not_claimed' });
  if (b.claimed_shared === true) return fail('mailbox_binding_invalid', { reason: 'shared_mailbox_deferred_phase_a' });
  if (hasOwn(b, 'requested_address') && (typeof b.requested_address !== 'string' || !b.requested_address.includes('@'))) {
    return fail('mailbox_binding_invalid', { reason: 'requested_address_shape' });
  }
  let restrictionState = null;
  if (hasOwn(b, 'reseller_or_shared_restriction')) {
    if (b.reseller_or_shared_restriction !== true && b.reseller_or_shared_restriction !== false) {
      return fail('mailbox_binding_invalid', { reason: 'restriction_not_boolean' });
    }
    if (b.reseller_or_shared_restriction === true) restrictionState = 'pending_manual_validation';
  }
  return ok({
    binding_status: 'unverified_offline', requested_address_is_hint_only: true,
    requested_address_present: hasOwn(b, 'requested_address'),
    principal_is_mailbox_identity: false, shared_mailbox_phase_a: 'rejected_deferred',
    godaddy_support_claimed: false,
    future_live_proof_required_fields: EMAIL_MS_DELEGATED_FUTURE_LIVE_MAILBOX_PROOF_FIELDS.slice(),
    own_user_live_binding: { ...EMAIL_MS_DELEGATED_OWN_USER_LIVE_BINDING },
    manual_validation_state: restrictionState,
    allowed_manual_validation_states: EMAIL_MS_DELEGATED_MANUAL_VALIDATION_STATES.slice(),
    access_kind_phase_a: EMAIL_MS_DELEGATED_MAILBOX_ACCESS_KIND_PHASE_A,
  });
}

function validateOwnUserLiveBindingDeclarationImpl(raw) {
  const s = snapOrFail(raw == null ? {} : raw, 'own_user_live_binding_invalid');
  if (!s.ok) return s.fail;
  const b = s.value;
  const claims = [
    ['claim_binding_verified_offline', 'offline_binding_not_verified'],
    ['claim_derived_mailbox_offline', 'offline_mailbox_derivation_forbidden'],
    ['claim_performed_graph', 'graph_not_performed'],
    ['claim_me_id_not_required', 'me_id_required_for_own_user'],
    ['claim_mail_claim_is_ownership_key', 'mail_upn_email_not_ownership_keys'],
  ];
  if (!subsetKeys(b, claims.map((c) => c[0]))) return fail('own_user_live_binding_invalid', { reason: 'unknown_key' });
  for (const [k, reason] of claims) {
    if (b[k] === true) return fail('own_user_live_binding_invalid', { reason });
  }
  return ok({ ...EMAIL_MS_DELEGATED_OWN_USER_LIVE_BINDING });
}

function evaluateRefreshExchangeAdapterGateImpl(raw) {
  const s = snapOrFail(raw == null ? {} : raw, 'refresh_exchange_gate_invalid');
  if (!s.ok) return s.fail;
  const g = s.value;
  if (!subsetKeys(g, [
    'claim_grant_custodian_injected',
    'claim_grant_custodian_module_present',
    'claim_refresh_exchange_allowed',
  ])) {
    return fail('refresh_exchange_gate_invalid', { reason: 'unknown_key' });
  }
  // Module is present in 2F-A; claiming it is absent is false.
  if (g.claim_grant_custodian_module_present === false) {
    return fail('refresh_exchange_gate_invalid', { reason: 'module_is_present' });
  }
  // Runtime injection is composition-time only; offline claim of injected is dishonest.
  if (g.claim_grant_custodian_injected === true) {
    return fail('refresh_exchange_gate_invalid', { reason: 'grant_custodian_injection_is_runtime' });
  }
  // Exchange adapter remains a separate later slice — still blocked.
  if (g.claim_refresh_exchange_allowed === true) {
    return fail('refresh_exchange_gate_invalid', {
      reason: EMAIL_MS_DELEGATED_REFRESH_TOKEN_CUSTODY.block_reason,
    });
  }
  return ok({ ...EMAIL_MS_DELEGATED_REFRESH_TOKEN_CUSTODY });
}

function validateGrantSecretPackageImpl(raw) {
  const snap = snapshotOwnDataProps(raw);
  if (!snap.ok) return fail('grant_secret_package_invalid', { reason: snap.reason });
  const pkg = snap.value;
  for (const key of Object.keys(pkg)) {
    if (FORBIDDEN_PUBLIC_VALUE_KEY_SET.has(key)) {
      return fail('grant_secret_package_invalid', { reason: 'raw_credential_key' });
    }
  }
  const ks = keySetFail(pkg, ['secret_ref'], 'grant_secret_package_invalid');
  if (ks) return ks;
  const ref = validateEmailMailboxSecretRef(pkg.secret_ref);
  if (!ref.ok) {
    let reason = 'invalid';
    if (ref.details && typeof ref.details.reason === 'string') reason = ref.details.reason;
    else if (typeof ref.error === 'string') reason = ref.error;
    return fail('secret_ref_invalid', { reason });
  }
  return ok({
    secret_ref_present: true,
    material_key_names: EMAIL_MS_DELEGATED_GRANT_SECRET_MATERIAL_KEY_NAMES.slice(),
    luna_global_app_credential_separate: true, per_grant_opaque_handle_only: true,
    raw_tokens_forbidden_in_public_dto: true,
  });
}

function validateRefreshRotationImpl(raw) {
  const s = snapOrFail(raw, 'refresh_rotation_invalid');
  if (!s.ok) return s.fail;
  const p = s.value;
  const ks = keySetFail(p, [
    'atomic_cas_or_lease', 'generation_handling',
    'retain_old_until_durable_replacement', 'app_wide_refresh_token',
  ], 'refresh_rotation_invalid');
  if (ks) return ks;
  if (p.atomic_cas_or_lease !== 'required') return fail('refresh_rotation_invalid', { reason: 'atomic_cas_or_lease' });
  if (p.generation_handling !== 'required') return fail('refresh_rotation_invalid', { reason: 'generation_handling' });
  if (p.retain_old_until_durable_replacement !== true) return fail('refresh_rotation_invalid', { reason: 'retain_old' });
  if (p.app_wide_refresh_token !== false) return fail('refresh_rotation_invalid', { reason: 'app_wide_refresh_forbidden' });
  return ok({
    atomic_cas_or_lease: 'required', generation_handling: 'required',
    retain_old_until_durable_replacement: true,
    terminal_reauthorization_reasons:
      EMAIL_MS_DELEGATED_REFRESH_ROTATION_POLICY.terminal_reauthorization_reasons.slice(),
    app_wide_refresh_token: false,
    refresh_token_custody: { ...EMAIL_MS_DELEGATED_REFRESH_TOKEN_CUSTODY },
  });
}

function validateActivationInvariantsImpl(raw) {
  const s = snapOrFail(raw == null ? {} : raw, 'activation_invariants_invalid');
  if (!s.ok) return s.fail;
  const a = s.value;
  if (!subsetKeys(a, ['claim_schema_enforces', 'claim_activation_complete', 'claim_ready_for_activation'])) {
    return fail('activation_invariants_invalid', { reason: 'unknown_key' });
  }
  if (a.claim_schema_enforces === true) return fail('activation_invariants_invalid', { reason: 'schema_does_not_enforce' });
  if (a.claim_activation_complete === true) return fail('activation_invariants_invalid', { reason: 'activation_not_complete' });
  if (a.claim_ready_for_activation === true) return fail('activation_invariants_invalid', { reason: 'activation_readiness_false' });
  return ok({
    invariants: {
      one_verified_provider_tid_mailbox_per_active_luna_client: true,
      reconnect_same_client_updates_rotates: true,
      cross_client_collision_requires_explicit_transfer_or_recovery: true,
      one_principal_may_administer_multiple_mailboxes: true,
      aliases_do_not_create_accounts: true,
    },
    schema_enforces_invariants: false, readiness_activation_complete: false,
    registry_activation_enabled: false,
  });
}

function validateMailboxAccessImpl(raw) {
  const snap = snapshotOwnDataProps(raw);
  if (!snap.ok) return fail('mailbox_access_invalid', { reason: snap.reason });
  const m = snap.value;
  const ks = keySetFail(m, ['kind'], 'mailbox_access_invalid');
  if (ks) return ks;
  if (m.kind === 'shared' || m.kind === 'shared_mailbox' || m.kind === 'application') return fail('mailbox_access_invalid', { reason: 'shared_or_app_forbidden_phase_a' });
  if (m.kind !== EMAIL_MS_DELEGATED_MAILBOX_ACCESS_KIND_PHASE_A) return fail('mailbox_access_invalid', { reason: 'kind' });
  return ok({ kind: EMAIL_MS_DELEGATED_MAILBOX_ACCESS_KIND_PHASE_A });
}

function evaluateReadinessImpl(input) {
  const snap = snapshotOwnDataProps(input);
  if (!snap.ok) return fail('declaration_invalid', { reason: snap.reason });
  const decl = snap.value;
  const forbidden = rejectForbiddenKeys(decl);
  if (!forbidden.ok) return forbidden;
  for (const key of Object.keys(decl)) {
    if (!DECLARATION_KEYS.includes(key)) return fail('declaration_unknown_key', { reason: 'unknown_key' });
  }
  for (const required of DECLARATION_KEYS) {
    if (!hasOwn(decl, required)) return fail('declaration_missing_key', { reason: 'missing_key', key: required });
  }
  if (decl.provider !== EMAIL_MS_DELEGATED_PROVIDER) return fail('provider_invalid');
  if (decl.auth_mode !== EMAIL_MS_DELEGATED_AUTH_MODE) return fail('auth_mode_invalid');
  if (decl.connector_mode !== EMAIL_MS_DELEGATED_CONNECTOR_MODE) return fail('connector_mode_invalid');
  const pair = validateEmailConnectorAuthModePair({ provider: decl.provider, auth_mode: decl.auth_mode });
  if (!pair.ok || pair.value.connector_mode !== EMAIL_MS_DELEGATED_CONNECTOR_MODE) {
    return fail('connector_auth_mode_invalid', { reason: 'pair_mismatch' });
  }
  const clientAuth = validateClientAuthModelImpl(decl.client_auth_model);
  if (!clientAuth.ok) return clientAuth;
  if (decl.account_audience === 'consumers' || decl.account_audience === 'common') return fail('account_audience_invalid', { reason: 'personal_or_mixed_accounts_forbidden' });
  if (decl.account_audience !== EMAIL_MS_DELEGATED_ACCOUNT_AUDIENCE) return fail('account_audience_invalid', { reason: 'account_audience' });
  if (decl.redirect_uri_id !== EMAIL_MS_DELEGATED_REDIRECT_URI_ID) return fail('redirect_uri_id_invalid');
  const scopePlan = validateScopePlanImpl(decl.scope_plan);
  if (!scopePlan.ok) return scopePlan;
  const mailboxAccess = validateMailboxAccessImpl(decl.mailbox_access);
  if (!mailboxAccess.ok) return mailboxAccess;
  const grantPkg = validateGrantSecretPackageImpl(decl.grant_secret_package);
  if (!grantPkg.ok) return grantPkg;
  for (const field of ['network_enabled', 'registry_activation_enabled', 'inbound_enabled', 'outbound_enabled']) {
    const f = requireExactFalse(decl[field], field);
    if (!f.ok) return f;
  }
  if (decl.default_automation_mode !== EMAIL_MS_DELEGATED_AUTOMATION_MODE) return fail('automation_mode_invalid');
  return ok({
    provider: EMAIL_MS_DELEGATED_PROVIDER, auth_mode: EMAIL_MS_DELEGATED_AUTH_MODE,
    connector_mode: EMAIL_MS_DELEGATED_CONNECTOR_MODE, default_saas: true,
    client_auth_model: clientAuth.value, account_audience: EMAIL_MS_DELEGATED_ACCOUNT_AUDIENCE,
    authority_host: EMAIL_MS_DELEGATED_AUTHORITY_HOST, token_host: EMAIL_MS_DELEGATED_TOKEN_HOST,
    graph_host: EMAIL_MS_DELEGATED_GRAPH_HOST, redirect_uri_id: EMAIL_MS_DELEGATED_REDIRECT_URI_ID,
    scope_plan: scopePlan.value, mailbox_access: mailboxAccess.value,
    grant_secret_package: grantPkg.value,
    refresh_rotation_policy: {
      atomic_cas_or_lease: EMAIL_MS_DELEGATED_REFRESH_ROTATION_POLICY.atomic_cas_or_lease,
      generation_handling: EMAIL_MS_DELEGATED_REFRESH_ROTATION_POLICY.generation_handling,
      retain_old_until_durable_replacement:
        EMAIL_MS_DELEGATED_REFRESH_ROTATION_POLICY.retain_old_until_durable_replacement,
      terminal_reauthorization_reasons:
        EMAIL_MS_DELEGATED_REFRESH_ROTATION_POLICY.terminal_reauthorization_reasons.slice(),
      app_wide_refresh_token: false,
      refresh_token_custody: { ...EMAIL_MS_DELEGATED_REFRESH_TOKEN_CUSTODY },
    },
    own_user_live_binding: { ...EMAIL_MS_DELEGATED_OWN_USER_LIVE_BINDING },
    activation_invariants: {
      ...EMAIL_MS_DELEGATED_ACTIVATION_INVARIANTS,
      terminal_note: 'schema_does_not_enforce_activation_false',
    },
    network_enabled: false, registry_activation_enabled: false,
    inbound_enabled: false, outbound_enabled: false,
    default_automation_mode: EMAIL_MS_DELEGATED_AUTOMATION_MODE,
    ready_for_human_authorized_live_prerequisite_check: true, missing_requirements: [],
    azure_facts_independently_verified: false, entra_facts_independently_verified: false,
    mailbox_facts_independently_verified: false, mailbox_binding_verified_offline: false,
    principal_is_mailbox_identity: false,
  });
}

function isMicrosoftDelegatedOauthReadinessComplete(input) {
  try {
    const r = evaluateMicrosoftDelegatedOauthReadiness(input);
    return Boolean(r && r.ok && r.value
      && r.value.ready_for_human_authorized_live_prerequisite_check === true
      && r.value.network_enabled === false && r.value.registry_activation_enabled === false
      && r.value.mailbox_binding_verified_offline === false);
  } catch { return false; }
}

function buildMicrosoftDelegatedPrincipalKey(tid, oid) {
  try {
    if (!isGuid(tid) || !isGuid(oid)) return fail('principal_key_invalid', { reason: 'tid_oid_not_guid' });
    return ok(buildPrincipalKey(tid, oid));
  } catch { return fail('principal_key_invalid', { reason: 'reflection_failed' }); }
}

const evaluateMicrosoftDelegatedOauthReadiness = wrap(evaluateReadinessImpl, 'declaration_invalid');
const validateMicrosoftDelegatedScopePlan = wrap(validateScopePlanImpl, 'scope_plan_invalid');
const validateMicrosoftDelegatedClientAuthModel = wrap(validateClientAuthModelImpl, 'client_auth_model_invalid');
const validateMicrosoftDelegatedAuthority = wrap(validateAuthorityImpl, 'authority_invalid');
const validateMicrosoftDelegatedOauthTransaction = wrap(validateOauthTransactionImpl, 'oauth_transaction_invalid');
const validateMicrosoftDelegatedPrincipal = wrap(validatePrincipalImpl, 'principal_invalid');
const validateMicrosoftDelegatedMailboxBindingHint = wrap(validateMailboxBindingHintImpl, 'mailbox_binding_invalid');
const validateMicrosoftDelegatedOwnUserLiveBinding = wrap(validateOwnUserLiveBindingDeclarationImpl, 'own_user_live_binding_invalid');
const validateMicrosoftDelegatedRefreshRotationPolicy = wrap(validateRefreshRotationImpl, 'refresh_rotation_invalid');
const evaluateMicrosoftDelegatedRefreshExchangeGate = wrap(evaluateRefreshExchangeAdapterGateImpl, 'refresh_exchange_gate_invalid');
const validateMicrosoftDelegatedActivationInvariants = wrap(validateActivationInvariantsImpl, 'activation_invariants_invalid');

module.exports = {
  evaluateMicrosoftDelegatedOauthReadiness, isMicrosoftDelegatedOauthReadinessComplete,
  validateMicrosoftDelegatedScopePlan, validateMicrosoftDelegatedClientAuthModel,
  validateMicrosoftDelegatedAuthority, validateMicrosoftDelegatedOauthTransaction,
  validateMicrosoftDelegatedPrincipal, validateMicrosoftDelegatedMailboxBindingHint,
  validateMicrosoftDelegatedOwnUserLiveBinding, validateMicrosoftDelegatedRefreshRotationPolicy,
  evaluateMicrosoftDelegatedRefreshExchangeGate, validateMicrosoftDelegatedActivationInvariants,
  buildMicrosoftDelegatedPrincipalKey,
  EMAIL_MS_DELEGATED_PROVIDER, EMAIL_MS_DELEGATED_AUTH_MODE, EMAIL_MS_DELEGATED_CONNECTOR_MODE,
  EMAIL_MS_DELEGATED_ACCOUNT_AUDIENCE, EMAIL_MS_DELEGATED_AUTHORITY_HOST,
  EMAIL_MS_DELEGATED_TOKEN_HOST, EMAIL_MS_DELEGATED_GRAPH_HOST, EMAIL_MS_DELEGATED_REDIRECT_URI_ID,
  EMAIL_MS_DELEGATED_PKCE_METHOD, EMAIL_MS_DELEGATED_TOKEN_ENDPOINT_CLIENT_AUTH_REQUIRED,
  EMAIL_MS_DELEGATED_TOKEN_ENDPOINT_CLIENT_AUTH_METHODS,
  EMAIL_MS_DELEGATED_PREFERRED_TOKEN_ENDPOINT_CLIENT_AUTH,
  EMAIL_MS_DELEGATED_CLIENT_SECRET_POST_DECLARATION,
  EMAIL_MS_DELEGATED_PHASE_A_OIDC_SCOPES, EMAIL_MS_DELEGATED_PHASE_A_GRAPH_DELEGATED_SCOPES,
  EMAIL_MS_DELEGATED_PHASE_B_GRAPH_DELEGATED_SCOPES, EMAIL_MS_DELEGATED_SCOPE_VERSION,
  EMAIL_MS_DELEGATED_ME_REQUIRED_DELEGATED_PERMISSION, EMAIL_MS_DELEGATED_CANONICAL_ADDRESS_FIELDS_ROLE,
  EMAIL_MS_DELEGATED_OWN_USER_LIVE_BINDING, EMAIL_MS_DELEGATED_REFRESH_TOKEN_CUSTODY,
  EMAIL_MS_DELEGATED_PRINCIPAL_KEY_PREFIX, EMAIL_MS_DELEGATED_PRINCIPAL_VALIDATION_RULES,
  EMAIL_MS_DELEGATED_ACTIVATION_INVARIANTS, EMAIL_MS_DELEGATED_REFRESH_ROTATION_POLICY,
  EMAIL_MS_DELEGATED_OAUTH_TRANSACTION_TTL_SECONDS,
};
