'use strict';
/** Slice 2D identity: connector+mailbox binding only. No DB/network/SDK. @module email-channel-endpoint-identity-contract */

const {
  validateEmailConnectorAuthModePair,
  EMAIL_DEFAULT_SAAS_PROVIDER,
  EMAIL_DEFAULT_SAAS_AUTH_MODE,
  EMAIL_DEFAULT_SAAS_CONNECTOR_MODE,
} = require('./email-connector-auth-mode-contract');

const EMAIL_IDENTITY_PROVIDERS = Object.freeze(['microsoft_graph', 'gmail_api', 'imap_smtp']);
const EMAIL_BINDING_STATUSES = Object.freeze([
  'unverified_offline', 'pending_manual_validation', 'verified',
  'reauthorization_required', 'revoked',
]);
const EMAIL_MAILBOX_KINDS = Object.freeze(['user']);
const EMAIL_MAILBOX_ACCESS_KINDS = Object.freeze(['own_user', 'application']);
const EMAIL_IDENTITY_FIELD_KEYS = Object.freeze([
  'provider', 'auth_mode', 'connector_mode', 'provider_tenant_id',
  'provider_principal_oid', 'provider_resource_id', 'mailbox_kind',
  'mailbox_access_kind', 'binding_status', 'public_address', 'secret_ref',
]);
const VERIFIED_LIKE = new Set(['verified', 'reauthorization_required']);
const PROVIDER_SET = new Set(EMAIL_IDENTITY_PROVIDERS);
const BINDING_SET = new Set(EMAIL_BINDING_STATUSES);
const KIND_SET = new Set(EMAIL_MAILBOX_KINDS);
const ACCESS_SET = new Set(EMAIL_MAILBOX_ACCESS_KINDS);
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FORBIDDEN_RAW_KEYS = Object.freeze([
  'access_token', 'refresh_token', 'id_token', 'authorization_code', 'code',
  'state', 'nonce', 'pkce_verifier', 'pkce_challenge', 'code_verifier',
  'code_challenge', 'client_secret', 'private_key', 'client_assertion',
  'password', 'api_key', 'token', 'raw_secret', 'Authorization', 'authorization',
  'grant_generation', 'grant_status',
]);
const FORBIDDEN_RAW_KEY_SET = new Set(FORBIDDEN_RAW_KEYS);

const EMAIL_IDENTITY_OWNERSHIP_RULES = Object.freeze({
  unique_index: 'tenant_channel_endpoints_verified_mailbox_ownership_uidx',
  unique_keys: Object.freeze(['provider', 'provider_tenant_id', 'provider_resource_id']),
  unique_where_binding_status: Object.freeze(['verified', 'reauthorization_required']),
  collation: 'C', conflict_sqlstate: '23505',
  same_row_reconnect: 'update_existing_row',
  reauthorization_reserves_ownership: true,
  cross_client_transfer: 'future_authorized_row_lock_update',
  aliases_not_independent_identities: true, principal_is_mailbox_identity: false,
  schema_enforces_mailbox_ownership_identity: true, schema_enforces_activation: false,
  schema_enforces_grant_rotation: false,
  deferred: Object.freeze(['grant_generation', 'grant_status', 'oauth_transaction_columns']),
});

const EMAIL_IDENTITY_SECRET_PACKAGE_SEMANTICS = Object.freeze({
  secret_ref_syntax_unchanged: true, sql_validates_package_contents: false,
  inspect_secret_store_values: false, dto_exposes: 'secret_ref_present',
  validate_mode_before_resolve: true, global_delegated_app_credential_separate: true,
  material_key_names_by_mode: Object.freeze({
    microsoft_delegated_oauth: Object.freeze(['refresh_token']),
    microsoft_app_only_enterprise: Object.freeze(['tenant_id', 'client_id', 'client_secret']),
  }),
});

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
  return value === undefined ? Object.freeze({ ok: true }) : Object.freeze({ ok: true, value: deepFreezeFresh(value) });
}
function wrap(fn, err) {
  return (input) => { try { return fn(input); } catch { return fail(err, { reason: 'reflection_failed' }); } };
}

function snapshotOwnDataProps(obj) {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'must_be_object' };
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) return { ok: false, reason: 'must_be_object' };
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key === 'symbol') return { ok: false, reason: 'symbol_key' };
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc) continue;
    if (typeof desc.get === 'function' || typeof desc.set === 'function') return { ok: false, reason: 'accessor', key: String(key) };
    out[key] = desc.value;
  }
  return { ok: true, value: out };
}

function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function isNullish(v) { return v === null || v === undefined; }
function rejectForbiddenKeys(snap) {
  for (const key of Object.keys(snap)) {
    if (FORBIDDEN_RAW_KEY_SET.has(key)) return fail('identity_forbidden_field', { reason: 'forbidden_field', key });
  }
  return null;
}
function isCanonicalGuid(v) { return typeof v === 'string' && GUID_RE.test(v); }

function requireTrimmedNonemptyString(v, field) {
  if (typeof v !== 'string') return fail('identity_field_invalid', { reason: 'not_string', field });
  if (v !== v.trim() || v.length === 0) return fail('identity_field_invalid', { reason: 'untrimmed_or_empty', field });
  return null;
}

function nullOrCanonicalGuid(v, field) {
  if (isNullish(v)) return null;
  const shape = requireTrimmedNonemptyString(v, field);
  if (shape) return shape;
  if (!isCanonicalGuid(v)) return fail('identity_field_invalid', { reason: 'guid_grammar', field });
  return null;
}

function pairRow(authMode, connectorMode) {
  if (authMode === 'delegated_authorization_code'
    && connectorMode === 'microsoft_delegated_oauth') {
    return {
      provider: EMAIL_DEFAULT_SAAS_PROVIDER,
      auth_mode: EMAIL_DEFAULT_SAAS_AUTH_MODE,
      connector_mode: EMAIL_DEFAULT_SAAS_CONNECTOR_MODE,
      default_saas: true,
    };
  }
  if (authMode === 'application_client_credentials'
    && connectorMode === 'microsoft_app_only_enterprise') {
    return {
      provider: 'microsoft_graph',
      auth_mode: 'application_client_credentials',
      connector_mode: 'microsoft_app_only_enterprise',
      default_saas: false,
    };
  }
  return null;
}

function validateIdentityModePairImpl(raw) {
  const snap = snapshotOwnDataProps(raw);
  if (!snap.ok) return fail('identity_mode_pair_invalid', { reason: snap.reason });
  const o = snap.value;
  const forbidden = rejectForbiddenKeys(o);
  if (forbidden) return forbidden;
  for (const k of Object.keys(o)) {
    if (k !== 'provider' && k !== 'auth_mode' && k !== 'connector_mode') {
      return fail('identity_mode_pair_invalid', { reason: 'unknown_key' });
    }
  }
  if (!hasOwn(o, 'provider') || typeof o.provider !== 'string' || !PROVIDER_SET.has(o.provider)) {
    return fail('identity_mode_pair_invalid', { reason: 'provider' });
  }
  const authNull = isNullish(o.auth_mode);
  const connNull = isNullish(o.connector_mode);
  if (authNull !== connNull) {
    return fail('identity_mode_pair_invalid', { reason: 'auth_connector_null_coupling' });
  }
  if (o.provider !== 'microsoft_graph') {
    if (!authNull || !connNull) {
      return fail('identity_mode_pair_invalid', { reason: 'non_graph_modes_must_be_null' });
    }
    return ok({
      provider: o.provider, auth_mode: null, connector_mode: null, legacy_unclassified: true,
    });
  }
  if (authNull) {
    return ok({
      provider: 'microsoft_graph', auth_mode: null, connector_mode: null, legacy_unclassified: true,
    });
  }
  if (typeof o.auth_mode !== 'string' || typeof o.connector_mode !== 'string') {
    return fail('identity_mode_pair_invalid', { reason: 'mode_not_string' });
  }
  const row = pairRow(o.auth_mode, o.connector_mode);
  if (!row) return fail('identity_mode_pair_invalid', { reason: 'unsupported_pair' });
  const pair = validateEmailConnectorAuthModePair({
    provider: row.provider, auth_mode: row.auth_mode,
  });
  if (!pair.ok || pair.value.connector_mode !== row.connector_mode) {
    return fail('identity_mode_pair_invalid', { reason: 'connector_matrix_mismatch' });
  }
  return ok({
    provider: row.provider,
    auth_mode: row.auth_mode,
    connector_mode: row.connector_mode,
    default_saas: row.default_saas === true,
    legacy_unclassified: false,
  });
}

function validateBindingIdentityImpl(raw) {
  const snap = snapshotOwnDataProps(raw);
  if (!snap.ok) return fail('binding_identity_invalid', { reason: snap.reason });
  const o = snap.value;
  const forbidden = rejectForbiddenKeys(o);
  if (forbidden) return forbidden;
  for (const k of Object.keys(o)) {
    if (!EMAIL_IDENTITY_FIELD_KEYS.includes(k)) {
      return fail('binding_identity_invalid', { reason: 'unknown_key', key: k });
    }
  }
  if (typeof o.provider !== 'string' || !PROVIDER_SET.has(o.provider)) {
    return fail('binding_identity_invalid', { reason: 'provider_required' });
  }

  // Fail closed on unknown provider before mode logic (allowlist = 057 CHECK).
  const mode = validateIdentityModePairImpl({
    provider: o.provider,
    auth_mode: hasOwn(o, 'auth_mode') ? o.auth_mode : null,
    connector_mode: hasOwn(o, 'connector_mode') ? o.connector_mode : null,
  });
  if (!mode.ok) return mode;

  const identityKeys = [
    'provider_tenant_id', 'provider_principal_oid', 'mailbox_kind',
    'mailbox_access_kind', 'binding_status',
  ];
  const anyIdentity = identityKeys.some((k) => hasOwn(o, k) && !isNullish(o[k]));
  if (anyIdentity && mode.value.legacy_unclassified) {
    return fail('binding_identity_invalid', { reason: 'identity_requires_modes' });
  }
  if (o.provider !== 'microsoft_graph' && anyIdentity) {
    return fail('binding_identity_invalid', { reason: 'non_graph_identity_forbidden' });
  }

  // Non-null provider_resource_id: exact-trimmed nonempty in every status (no coercion).
  if (hasOwn(o, 'provider_resource_id') && !isNullish(o.provider_resource_id)) {
    const e = requireTrimmedNonemptyString(o.provider_resource_id, 'provider_resource_id');
    if (e) return e;
  }
  if (hasOwn(o, 'provider_tenant_id') && !isNullish(o.provider_tenant_id)) {
    const e = nullOrCanonicalGuid(o.provider_tenant_id, 'provider_tenant_id');
    if (e) return e;
  }
  if (hasOwn(o, 'provider_principal_oid') && !isNullish(o.provider_principal_oid)) {
    const e = nullOrCanonicalGuid(o.provider_principal_oid, 'provider_principal_oid');
    if (e) return e;
  }
  if (hasOwn(o, 'mailbox_kind') && !isNullish(o.mailbox_kind)) {
    const e = requireTrimmedNonemptyString(o.mailbox_kind, 'mailbox_kind');
    if (e) return e;
    if (!KIND_SET.has(o.mailbox_kind)) {
      return fail('binding_identity_invalid', { reason: 'mailbox_kind_unknown' });
    }
  }
  if (hasOwn(o, 'mailbox_access_kind') && !isNullish(o.mailbox_access_kind)) {
    const e = requireTrimmedNonemptyString(o.mailbox_access_kind, 'mailbox_access_kind');
    if (e) return e;
    if (!ACCESS_SET.has(o.mailbox_access_kind)) {
      return fail('binding_identity_invalid', { reason: 'mailbox_access_kind_unknown' });
    }
  }
  if (hasOwn(o, 'binding_status') && !isNullish(o.binding_status)) {
    if (typeof o.binding_status !== 'string' || !BINDING_SET.has(o.binding_status)) {
      return fail('binding_identity_invalid', { reason: 'binding_status_unknown' });
    }
  }

  const auth = mode.value.auth_mode;
  if (auth === 'delegated_authorization_code') {
    if (hasOwn(o, 'mailbox_kind') && !isNullish(o.mailbox_kind) && o.mailbox_kind !== 'user') {
      return fail('binding_identity_invalid', { reason: 'delegated_mailbox_kind' });
    }
    if (hasOwn(o, 'mailbox_access_kind') && !isNullish(o.mailbox_access_kind)
      && o.mailbox_access_kind !== 'own_user') {
      return fail('binding_identity_invalid', { reason: 'delegated_access_kind' });
    }
  }
  if (auth === 'application_client_credentials') {
    if (hasOwn(o, 'provider_principal_oid') && !isNullish(o.provider_principal_oid)) {
      return fail('binding_identity_invalid', { reason: 'app_only_principal_forbidden' });
    }
    if (hasOwn(o, 'mailbox_kind') && !isNullish(o.mailbox_kind) && o.mailbox_kind !== 'user') {
      return fail('binding_identity_invalid', { reason: 'app_only_mailbox_kind' });
    }
    if (hasOwn(o, 'mailbox_access_kind') && !isNullish(o.mailbox_access_kind)
      && o.mailbox_access_kind !== 'application') {
      return fail('binding_identity_invalid', { reason: 'app_only_access_kind' });
    }
  }

  const status = hasOwn(o, 'binding_status') ? o.binding_status : null;
  if (status != null && VERIFIED_LIKE.has(status)) {
    if (o.provider !== 'microsoft_graph' || mode.value.legacy_unclassified) {
      return fail('binding_identity_invalid', { reason: 'verified_requires_graph_pair' });
    }
    if (!isCanonicalGuid(o.provider_tenant_id)) {
      return fail('binding_identity_invalid', { reason: 'verified_requires_tenant' });
    }
    // Shape already enforced above; verified requires non-null string present.
    if (typeof o.provider_resource_id !== 'string') {
      return fail('binding_identity_invalid', { reason: 'verified_requires_resource' });
    }
    if (o.mailbox_kind !== 'user') {
      return fail('binding_identity_invalid', { reason: 'verified_requires_mailbox_kind' });
    }
    if (auth === 'delegated_authorization_code') {
      if (!isCanonicalGuid(o.provider_principal_oid)) {
        return fail('binding_identity_invalid', { reason: 'verified_delegated_requires_principal' });
      }
      if (o.mailbox_access_kind !== 'own_user') {
        return fail('binding_identity_invalid', { reason: 'verified_delegated_access' });
      }
    } else if (auth === 'application_client_credentials') {
      if (!isNullish(o.provider_principal_oid)) {
        return fail('binding_identity_invalid', { reason: 'verified_app_only_principal_null' });
      }
      if (o.mailbox_access_kind !== 'application') {
        return fail('binding_identity_invalid', { reason: 'verified_app_only_access' });
      }
    } else {
      return fail('binding_identity_invalid', { reason: 'verified_requires_pair' });
    }
  }

  return ok({
    provider: o.provider,
    auth_mode: mode.value.auth_mode,
    connector_mode: mode.value.connector_mode,
    provider_tenant_id: isNullish(o.provider_tenant_id) ? null : o.provider_tenant_id,
    provider_principal_oid: isNullish(o.provider_principal_oid) ? null : o.provider_principal_oid,
    provider_resource_id: isNullish(o.provider_resource_id) ? null : o.provider_resource_id,
    mailbox_kind: isNullish(o.mailbox_kind) ? null : o.mailbox_kind,
    mailbox_access_kind: isNullish(o.mailbox_access_kind) ? null : o.mailbox_access_kind,
    binding_status: isNullish(status) ? null : status,
    principal_is_mailbox_identity: false,
    legacy_unclassified: mode.value.legacy_unclassified === true,
    ownership: {
      verified_like: status != null && VERIFIED_LIKE.has(status),
      reserves_via_reauthorization: status === 'reauthorization_required',
    },
    secret_package_semantics: {
      dto_exposes: 'secret_ref_present',
      sql_validates_package_contents: false,
      material_key_names: mode.value.connector_mode
        ? (EMAIL_IDENTITY_SECRET_PACKAGE_SEMANTICS.material_key_names_by_mode[
          mode.value.connector_mode
        ] || []).slice()
        : [],
    },
  });
}

function declareReconnectTransferPolicyImpl(raw) {
  const snap = snapshotOwnDataProps(raw == null ? {} : raw);
  if (!snap.ok) return fail('reconnect_transfer_invalid', { reason: snap.reason });
  const o = snap.value;
  const forbidden = rejectForbiddenKeys(o);
  if (forbidden) return forbidden;
  for (const k of Object.keys(o)) {
    if (![
      'claim_aliases_are_independent', 'claim_reauth_does_not_reserve',
      'claim_cross_client_silent_steal', 'claim_schema_enforces_activation',
    ].includes(k)) {
      return fail('reconnect_transfer_invalid', { reason: 'unknown_key' });
    }
  }
  if (o.claim_aliases_are_independent === true) {
    return fail('reconnect_transfer_invalid', { reason: 'aliases_not_independent' });
  }
  if (o.claim_reauth_does_not_reserve === true) {
    return fail('reconnect_transfer_invalid', { reason: 'reauth_reserves_ownership' });
  }
  if (o.claim_cross_client_silent_steal === true) {
    return fail('reconnect_transfer_invalid', { reason: 'transfer_requires_authorization' });
  }
  if (o.claim_schema_enforces_activation === true) {
    return fail('reconnect_transfer_invalid', { reason: 'activation_not_enforced_by_2d' });
  }
  return ok({ ...EMAIL_IDENTITY_OWNERSHIP_RULES });
}

const validateEmailChannelEndpointIdentityModePair = wrap(
  validateIdentityModePairImpl, 'identity_mode_pair_invalid',
);
const validateEmailChannelEndpointBindingIdentity = wrap(
  validateBindingIdentityImpl, 'binding_identity_invalid',
);
const declareEmailChannelEndpointReconnectTransferPolicy = wrap(
  declareReconnectTransferPolicyImpl, 'reconnect_transfer_invalid',
);

module.exports = {
  validateEmailChannelEndpointIdentityModePair,
  validateEmailChannelEndpointBindingIdentity,
  declareEmailChannelEndpointReconnectTransferPolicy,
  EMAIL_IDENTITY_PROVIDERS,
  EMAIL_BINDING_STATUSES,
  EMAIL_MAILBOX_KINDS,
  EMAIL_MAILBOX_ACCESS_KINDS,
  EMAIL_IDENTITY_FIELD_KEYS,
  EMAIL_IDENTITY_OWNERSHIP_RULES,
  EMAIL_IDENTITY_SECRET_PACKAGE_SEMANTICS,
  FORBIDDEN_RAW_KEYS,
};
