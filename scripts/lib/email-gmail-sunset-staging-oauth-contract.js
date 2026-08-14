'use strict';

/**
 * Sunset-staging Gmail delegated OAuth contract (EMAIL-GMAIL-001 scaffolding).
 *
 * Offline-first: single-consent read+send+offline shape, callback-state validation,
 * and revoke request builder. Reads OAuth app credentials only from env placeholders
 * GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET and fails closed when absent.
 *
 * No live Gmail connect, routes, DB, Key Vault, inbox wiring, auto-send, or production.
 *
 * @module email-gmail-sunset-staging-oauth-contract
 */

const crypto = require('crypto');
const { validateEmailMailboxSecretRef } = require('./email-mailbox-adapter-contract');
const { validateEmailConnectorAuthModePair } = require('./email-connector-auth-mode-contract');

const GMAIL_SUNSET_DEPLOYMENT = 'sunset-staging';
const GMAIL_SUNSET_PROVIDER = 'gmail_api';
const GMAIL_SUNSET_AUTH_MODE = 'delegated_authorization_code';
const GMAIL_SUNSET_CONNECTOR_MODE = 'google_delegated_oauth';
const GMAIL_SUNSET_REDIRECT_URI_ID = 'sunset_gmail_oauth_callback_v1';
const GMAIL_SUNSET_AUTHORIZATION_ORIGIN = 'https://accounts.google.com';
const GMAIL_SUNSET_TOKEN_ORIGIN = 'https://oauth2.googleapis.com';
const GMAIL_SUNSET_REVOKE_PATH = '/revoke';
const GMAIL_SUNSET_AUTHORIZE_PATH = '/o/oauth2/v2/auth';
const GMAIL_SUNSET_OAUTH_CLIENT_ID_ENV = 'GMAIL_OAUTH_CLIENT_ID';
const GMAIL_SUNSET_OAUTH_CLIENT_SECRET_ENV = 'GMAIL_OAUTH_CLIENT_SECRET';
const GMAIL_SUNSET_PKCE_METHOD = 'S256';
const GMAIL_SUNSET_ACCESS_TYPE = 'offline';
const GMAIL_SUNSET_INCLUDE_GRANTED_SCOPES = false;
const GMAIL_SUNSET_PROMPT = 'consent';
const GMAIL_SUNSET_AUTOMATION_MODE = 'off';
const GMAIL_SUNSET_OAUTH_TRANSACTION_TTL_SECONDS = 600;
const GMAIL_SUNSET_OAUTH_TRANSACTION_MIN_ENTROPY_BYTES = 32;

const GMAIL_SUNSET_OIDC_SCOPES = Object.freeze(['openid', 'email']);
const GMAIL_SUNSET_GMAIL_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
]);

const GMAIL_SUNSET_SINGLE_CONSENT_SCOPES = Object.freeze([
  ...GMAIL_SUNSET_OIDC_SCOPES,
  ...GMAIL_SUNSET_GMAIL_SCOPES,
]);

const FORBIDDEN_PUBLIC_VALUE_KEY_SET = new Set([
  'access_token', 'refresh_token', 'id_token', 'authorization_code', 'code',
  'state', 'nonce', 'pkce_verifier', 'pkce_challenge', 'code_verifier', 'code_challenge',
  'client_secret', 'private_key', 'client_assertion', 'raw_error', 'raw_errors',
  'password', 'api_key', 'Authorization', 'authorization', 'token', 'raw_secret',
  'clientSecret', 'accessToken', 'refreshToken', 'idToken',
]);

const DECLARATION_KEYS = Object.freeze([
  'provider', 'auth_mode', 'connector_mode', 'redirect_uri_id', 'scope_plan',
  'grant_secret_package', 'network_enabled', 'inbound_enabled', 'outbound_enabled',
  'default_automation_mode',
]);

const OAUTH_TX_INPUT_KEY_SET = new Set([
  'state', 'nonce', 'pkce_verifier', 'pkce_challenge', 'pkce_method', 'redirect_uri_id',
  'luna_client_id', 'location_id', 'staff_session_id', 'connector_mode', 'auth_mode',
  'issued_at', 'expires_at', 'now_at', 'consume', 'prior_consumed',
  'expected_luna_client_id', 'expected_location_id', 'expected_staff_session_id',
]);

const CLIENT_ID_SUFFIX = '.apps.googleusercontent.com';
const CLIENT_ID_PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/;
const SECRET_LIMIT_CHARS = 4096;

function deepFreezeFresh(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeFresh));
  const out = {};
  for (const key of Object.keys(value)) out[key] = deepFreezeFresh(value[key]);
  return Object.freeze(out);
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

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function snapshotOwnDataProps(object) {
  if (object == null || typeof object !== 'object' || Array.isArray(object)) {
    return { ok: false, reason: 'must_be_object' };
  }
  const proto = Object.getPrototypeOf(object);
  if (proto !== Object.prototype && proto !== null) return { ok: false, reason: 'must_be_object' };
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key === 'symbol') return { ok: false, reason: 'symbol_key' };
    if (!hasOwn(object, key)) continue;
    const desc = Object.getOwnPropertyDescriptor(object, key);
    if (!desc) continue;
    if (typeof desc.get === 'function' || typeof desc.set === 'function') {
      return { ok: false, reason: 'accessor', key: String(key) };
    }
    out[key] = desc.value;
  }
  return { ok: true, value: out };
}

function rejectForbiddenKeys(snapshot) {
  for (const key of Object.keys(snapshot)) {
    if (FORBIDDEN_PUBLIC_VALUE_KEY_SET.has(key)) {
      return fail('declaration_forbidden_field', { reason: 'forbidden_field' });
    }
  }
  return ok();
}

function snapOrFail(raw, error) {
  const snap = snapshotOwnDataProps(raw);
  if (!snap.ok) return { ok: false, fail: fail(error, { reason: snap.reason }) };
  const forbidden = rejectForbiddenKeys(snap.value);
  if (!forbidden.ok) return { ok: false, fail: forbidden };
  return { ok: true, value: snap.value };
}

function isGuid(value) {
  return typeof value === 'string' && GUID_RE.test(value);
}

function isSafeInt(value) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function highEntropyString(value, minimum) {
  return typeof value === 'string' && value.length >= minimum && !/\s/.test(value);
}

function printableSecret(value, limit) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= limit
    && /^[\x21-\x7e]+$/.test(value);
}

function validGmailClientId(value) {
  return typeof value === 'string'
    && value.length > CLIENT_ID_SUFFIX.length + 1
    && value.length <= 255
    && value.endsWith(CLIENT_ID_SUFFIX)
    && CLIENT_ID_PREFIX_RE.test(value.slice(0, -CLIENT_ID_SUFFIX.length));
}

function timingSafeStrEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function pkceS256Challenge(verifier) {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function readEnvString(env, key) {
  if (env == null || (typeof env !== 'object' && typeof env !== 'function')) return undefined;
  const desc = Object.getOwnPropertyDescriptor(env, key);
  if (!desc || typeof desc.get === 'function' || typeof desc.set === 'function') return undefined;
  return desc.value;
}

function readGmailSunsetStagingOAuthEnv(env) {
  try {
    const clientId = readEnvString(env, GMAIL_SUNSET_OAUTH_CLIENT_ID_ENV);
    const clientSecret = readEnvString(env, GMAIL_SUNSET_OAUTH_CLIENT_SECRET_ENV);
    if (!validGmailClientId(clientId)) {
      return fail('gmail_oauth_env_missing', {
        reason: 'client_id_missing_or_invalid',
        env_key: GMAIL_SUNSET_OAUTH_CLIENT_ID_ENV,
      });
    }
    if (!printableSecret(clientSecret, SECRET_LIMIT_CHARS)) {
      return fail('gmail_oauth_env_missing', {
        reason: 'client_secret_missing_or_invalid',
        env_key: GMAIL_SUNSET_OAUTH_CLIENT_SECRET_ENV,
      });
    }
    return ok({
      deployment: GMAIL_SUNSET_DEPLOYMENT,
      client_id_env_key: GMAIL_SUNSET_OAUTH_CLIENT_ID_ENV,
      client_secret_env_key: GMAIL_SUNSET_OAUTH_CLIENT_SECRET_ENV,
      client_id_present: true,
      client_secret_present: true,
      client_id_suffix: CLIENT_ID_SUFFIX,
      public_client_id: clientId,
      public_client_secret_forbidden: true,
    });
  } catch {
    return fail('gmail_oauth_env_missing', { reason: 'reflection_failed' });
  }
}

function hasGmailSunsetStagingOAuthLiveCredentials(env) {
  return readGmailSunsetStagingOAuthEnv(env).ok === true;
}

function buildGmailSunsetStagingScopePlan() {
  return Object.freeze({
    single_consent: true,
    access_type: GMAIL_SUNSET_ACCESS_TYPE,
    include_granted_scopes: GMAIL_SUNSET_INCLUDE_GRANTED_SCOPES,
    prompt: GMAIL_SUNSET_PROMPT,
    oidc_scopes: GMAIL_SUNSET_OIDC_SCOPES.slice(),
    gmail_scopes: GMAIL_SUNSET_GMAIL_SCOPES.slice(),
    authorization_scopes: GMAIL_SUNSET_SINGLE_CONSENT_SCOPES.slice(),
    scope_string: GMAIL_SUNSET_SINGLE_CONSENT_SCOPES.join(' '),
  });
}

function validateGmailSunsetStagingScopePlan(raw) {
  const snap = snapOrFail(raw, 'scope_plan_invalid');
  if (!snap.ok) return snap.fail;
  const plan = snap.value;
  if (plan.single_consent !== true) return fail('scope_plan_invalid', { reason: 'single_consent_required' });
  if (plan.access_type !== GMAIL_SUNSET_ACCESS_TYPE) return fail('scope_plan_invalid', { reason: 'access_type' });
  if (plan.include_granted_scopes !== GMAIL_SUNSET_INCLUDE_GRANTED_SCOPES) {
    return fail('scope_plan_invalid', { reason: 'include_granted_scopes' });
  }
  const oidc = Array.isArray(plan.oidc_scopes) ? plan.oidc_scopes : null;
  const gmail = Array.isArray(plan.gmail_scopes) ? plan.gmail_scopes : null;
  if (!oidc || !gmail
      || oidc.length !== GMAIL_SUNSET_OIDC_SCOPES.length
      || gmail.length !== GMAIL_SUNSET_GMAIL_SCOPES.length) {
    return fail('scope_plan_invalid', { reason: 'scope_shape' });
  }
  for (let index = 0; index < oidc.length; index += 1) {
    if (oidc[index] !== GMAIL_SUNSET_OIDC_SCOPES[index]) return fail('scope_plan_invalid', { reason: 'oidc_mismatch' });
  }
  for (let index = 0; index < gmail.length; index += 1) {
    if (gmail[index] !== GMAIL_SUNSET_GMAIL_SCOPES[index]) return fail('scope_plan_invalid', { reason: 'gmail_mismatch' });
  }
  if (gmail.includes('https://www.googleapis.com/auth/gmail.compose')
      || gmail.includes('https://www.googleapis.com/auth/gmail.modify')) {
    return fail('scope_plan_invalid', { reason: 'forbidden_scope' });
  }
  return ok(buildGmailSunsetStagingScopePlan());
}

function buildGmailSunsetStagingAuthorizationUrl(input) {
  const snap = snapshotOwnDataProps(input);
  if (!snap.ok) return fail('authorization_url_invalid', { reason: snap.reason });
  const value = snap.value;
  for (const key of ['client_id', 'redirect_uri', 'state', 'code_challenge']) {
    if (!hasOwn(value, key)) return fail('authorization_url_invalid', { reason: 'missing_key', key });
  }
  if (!validGmailClientId(value.client_id)) return fail('authorization_url_invalid', { reason: 'client_id' });
  if (!isNonEmptyString(value.redirect_uri) || !value.redirect_uri.startsWith('https://')) {
    return fail('authorization_url_invalid', { reason: 'redirect_uri' });
  }
  if (!highEntropyString(value.state, GMAIL_SUNSET_OAUTH_TRANSACTION_MIN_ENTROPY_BYTES)) {
    return fail('authorization_url_invalid', { reason: 'state_entropy' });
  }
  if (typeof value.code_challenge !== 'string' || !PKCE_CHALLENGE_RE.test(value.code_challenge)) {
    return fail('authorization_url_invalid', { reason: 'code_challenge' });
  }
  const scopePlan = buildGmailSunsetStagingScopePlan();
  const params = new URLSearchParams([
    ['client_id', value.client_id],
    ['redirect_uri', value.redirect_uri],
    ['response_type', 'code'],
    ['scope', scopePlan.scope_string],
    ['state', value.state],
    ['code_challenge', value.code_challenge],
    ['code_challenge_method', GMAIL_SUNSET_PKCE_METHOD],
    ['access_type', scopePlan.access_type],
    ['prompt', scopePlan.prompt],
    ['include_granted_scopes', String(scopePlan.include_granted_scopes)],
  ]);
  return ok({
    authorization_origin: GMAIL_SUNSET_AUTHORIZATION_ORIGIN,
    authorization_path: GMAIL_SUNSET_AUTHORIZE_PATH,
    authorization_url: `${GMAIL_SUNSET_AUTHORIZATION_ORIGIN}${GMAIL_SUNSET_AUTHORIZE_PATH}?${params.toString()}`,
    redirect_uri_id: GMAIL_SUNSET_REDIRECT_URI_ID,
    single_consent: true,
    scope_plan: scopePlan,
    pkce_method: GMAIL_SUNSET_PKCE_METHOD,
    public_query_includes_secrets: false,
  });
}

function txFail(reason, extra) {
  return fail('oauth_transaction_invalid', extra ? { reason, ...extra } : { reason });
}

function validateGmailSunsetStagingCallbackState(raw) {
  const snap = snapshotOwnDataProps(raw);
  if (!snap.ok) return txFail(snap.reason);
  const tx = snap.value;
  if (![...OAUTH_TX_INPUT_KEY_SET].every((key) => hasOwn(tx, key))) return txFail('missing_key');
  for (const key of Object.keys(tx)) {
    if (!OAUTH_TX_INPUT_KEY_SET.has(key)) return txFail('unknown_key');
  }
  if (tx.pkce_method !== GMAIL_SUNSET_PKCE_METHOD) return txFail('pkce_method');
  if (tx.redirect_uri_id !== GMAIL_SUNSET_REDIRECT_URI_ID) return txFail('redirect_uri_id');
  if (tx.connector_mode !== GMAIL_SUNSET_CONNECTOR_MODE) return txFail('connector_mode');
  if (tx.auth_mode !== GMAIL_SUNSET_AUTH_MODE) return txFail('auth_mode');
  const min = GMAIL_SUNSET_OAUTH_TRANSACTION_MIN_ENTROPY_BYTES;
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
  if (ttl <= 0 || ttl > GMAIL_SUNSET_OAUTH_TRANSACTION_TTL_SECONDS) return txFail('ttl_exceeds_bound');
  if (tx.now_at < tx.issued_at || tx.now_at >= tx.expires_at) return txFail('expired_or_not_yet_valid');
  if (tx.expected_luna_client_id !== tx.luna_client_id) return txFail('client_mix_up');
  if (tx.expected_location_id !== tx.location_id) return txFail('location_mix_up');
  if (tx.expected_staff_session_id !== tx.staff_session_id) return txFail('session_mix_up');
  if (tx.prior_consumed === true) return txFail('replay');
  if (tx.prior_consumed !== false) return txFail('prior_consumed_not_boolean_false');
  if (tx.consume !== true) return txFail('consume_not_true');
  return ok({
    transaction_id_present: true,
    redirect_uri_id: GMAIL_SUNSET_REDIRECT_URI_ID,
    luna_client_id: tx.luna_client_id,
    location_id: tx.location_id,
    staff_session_present: true,
    ownership_bound: true,
    connector_mode: GMAIL_SUNSET_CONNECTOR_MODE,
    auth_mode: GMAIL_SUNSET_AUTH_MODE,
    issued_at: tx.issued_at,
    expires_at: tx.expires_at,
    status: 'consumed',
    atomic_consume_required: true,
    replay_rejected: true,
    runtime_atomic_compare_and_consume: true,
    pkce_s256_verified: true,
    public_dto_includes_protocol_artifacts: false,
  });
}

function validateGmailSunsetStagingGrantSecretPackage(raw) {
  const snap = snapshotOwnDataProps(raw);
  if (!snap.ok) return fail('grant_secret_package_invalid', { reason: snap.reason });
  const pkg = snap.value;
  for (const key of Object.keys(pkg)) {
    if (FORBIDDEN_PUBLIC_VALUE_KEY_SET.has(key)) {
      return fail('grant_secret_package_invalid', { reason: 'raw_credential_key' });
    }
  }
  if (!hasOwn(pkg, 'secret_ref') || Object.keys(pkg).length !== 1) {
    return fail('grant_secret_package_invalid', { reason: 'key_set' });
  }
  const ref = validateEmailMailboxSecretRef(pkg.secret_ref);
  if (!ref.ok) {
    let reason = 'invalid';
    if (ref.details && typeof ref.details.reason === 'string') reason = ref.details.reason;
    else if (typeof ref.error === 'string') reason = ref.error;
    return fail('secret_ref_invalid', { reason });
  }
  return ok({
    secret_ref_present: true,
    material_key_names: ['refresh_token'],
    raw_tokens_forbidden_in_public_dto: true,
  });
}

function requireExactFalse(value, field) {
  if (value !== false) return fail('network_or_activation_invalid', { reason: 'flag_not_false', field });
  return ok();
}

function evaluateGmailSunsetStagingOAuthReadiness(raw) {
  const snap = snapshotOwnDataProps(raw);
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
  if (decl.provider !== GMAIL_SUNSET_PROVIDER) return fail('provider_invalid');
  if (decl.auth_mode !== GMAIL_SUNSET_AUTH_MODE) return fail('auth_mode_invalid');
  if (decl.connector_mode !== GMAIL_SUNSET_CONNECTOR_MODE) return fail('connector_mode_invalid');
  const pair = validateEmailConnectorAuthModePair({ provider: decl.provider, auth_mode: decl.auth_mode });
  if (!pair.ok || pair.value.connector_mode !== GMAIL_SUNSET_CONNECTOR_MODE) {
    return fail('connector_auth_mode_invalid', { reason: 'pair_mismatch' });
  }
  if (decl.redirect_uri_id !== GMAIL_SUNSET_REDIRECT_URI_ID) return fail('redirect_uri_id_invalid');
  const scopePlan = validateGmailSunsetStagingScopePlan(decl.scope_plan);
  if (!scopePlan.ok) return scopePlan;
  const grantPkg = validateGmailSunsetStagingGrantSecretPackage(decl.grant_secret_package);
  if (!grantPkg.ok) return grantPkg;
  for (const field of ['network_enabled', 'inbound_enabled', 'outbound_enabled']) {
    const flag = requireExactFalse(decl[field], field);
    if (!flag.ok) return flag;
  }
  if (decl.default_automation_mode !== GMAIL_SUNSET_AUTOMATION_MODE) return fail('automation_mode_invalid');
  return ok({
    deployment: GMAIL_SUNSET_DEPLOYMENT,
    provider: GMAIL_SUNSET_PROVIDER,
    auth_mode: GMAIL_SUNSET_AUTH_MODE,
    connector_mode: GMAIL_SUNSET_CONNECTOR_MODE,
    redirect_uri_id: GMAIL_SUNSET_REDIRECT_URI_ID,
    authorization_origin: GMAIL_SUNSET_AUTHORIZATION_ORIGIN,
    token_origin: GMAIL_SUNSET_TOKEN_ORIGIN,
    scope_plan: scopePlan.value,
    grant_secret_package: grantPkg.value,
    network_enabled: false,
    inbound_enabled: false,
    outbound_enabled: false,
    default_automation_mode: GMAIL_SUNSET_AUTOMATION_MODE,
    staff_approval_required: true,
    luna_send_capability: false,
    ready_for_live_oauth: false,
    ready_for_human_authorized_live_prerequisite_check: true,
    oauth_env_keys: Object.freeze([
      GMAIL_SUNSET_OAUTH_CLIENT_ID_ENV,
      GMAIL_SUNSET_OAUTH_CLIENT_SECRET_ENV,
    ]),
    missing_requirements: Object.freeze([]),
  });
}

function buildGmailSunsetStagingRevokeRequestBody(input) {
  const snap = snapshotOwnDataProps(input);
  if (!snap.ok) return fail('revoke_request_invalid', { reason: snap.reason });
  const value = snap.value;
  if (!hasOwn(value, 'client_id') || !hasOwn(value, 'client_secret') || !hasOwn(value, 'token')) {
    return fail('revoke_request_invalid', { reason: 'missing_key' });
  }
  if (Object.keys(value).length !== 3) return fail('revoke_request_invalid', { reason: 'unknown_key' });
  if (!validGmailClientId(value.client_id)) return fail('revoke_request_invalid', { reason: 'client_id' });
  if (!printableSecret(value.client_secret, SECRET_LIMIT_CHARS)) {
    return fail('revoke_request_invalid', { reason: 'client_secret' });
  }
  if (!printableSecret(value.token, SECRET_LIMIT_CHARS)) return fail('revoke_request_invalid', { reason: 'token' });
  const body = new URLSearchParams([
    ['client_id', value.client_id],
    ['client_secret', value.client_secret],
    ['token', value.token],
  ]).toString();
  return ok({
    token_origin: GMAIL_SUNSET_TOKEN_ORIGIN,
    revoke_path: GMAIL_SUNSET_REVOKE_PATH,
    body,
    public_body_includes_token_value: false,
  });
}

function createGmailSunsetStagingTokenRevokeService(deps) {
  const CORE_DEPS_KEYS = ['deployment', 'env', 'transport'];
  function ownData(object, key) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
  }
  function exactPlainData(object, keys) {
    if (!object || Object.getPrototypeOf(object) !== Object.prototype) return false;
    const actual = Reflect.ownKeys(object);
    return actual.length === keys.length
      && actual.every((key) => typeof key === 'string' && keys.includes(key))
      && keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        return descriptor && !descriptor.get && !descriptor.set;
      });
  }
  const FAILURE_CODE = 'gmail_sunset_token_revoke_failed';
  function failure() {
    const error = new Error(FAILURE_CODE);
    error.code = FAILURE_CODE;
    return error;
  }

  let env;
  let transport;
  let postTokenForm;
  try {
    if (!exactPlainData(deps, CORE_DEPS_KEYS) || ownData(deps, 'deployment') !== GMAIL_SUNSET_DEPLOYMENT) {
      throw failure();
    }
    env = ownData(deps, 'env');
    transport = ownData(deps, 'transport');
    if (!transport || typeof ownData(transport, 'postTokenForm') !== 'function') throw failure();
    postTokenForm = ownData(transport, 'postTokenForm');
    const config = readGmailSunsetStagingOAuthEnv(env);
    if (!config.ok) throw failure();
  } catch (error) {
    if (error && error.code === FAILURE_CODE) throw error;
    throw failure();
  }

  let used = false;
  async function revokeRefreshToken(input) {
    if (used) throw failure();
    used = true;
    try {
      if (!input || Object.getPrototypeOf(input) !== Object.prototype
          || !hasOwn(input, 'refreshToken') || Object.keys(input).length !== 1) {
        throw failure();
      }
      const refreshToken = input.refreshToken;
      if (!printableSecret(refreshToken, SECRET_LIMIT_CHARS)) throw failure();
      const config = readGmailSunsetStagingOAuthEnv(env);
      if (!config.ok) throw failure();
      const clientId = readEnvString(env, GMAIL_SUNSET_OAUTH_CLIENT_ID_ENV);
      const clientSecret = readEnvString(env, GMAIL_SUNSET_OAUTH_CLIENT_SECRET_ENV);
      const bodyResult = buildGmailSunsetStagingRevokeRequestBody({
        client_id: clientId,
        client_secret: clientSecret,
        token: refreshToken,
      });
      if (!bodyResult.ok) throw failure();
      const response = await Reflect.apply(postTokenForm, transport, [{
        origin: GMAIL_SUNSET_TOKEN_ORIGIN,
        path: GMAIL_SUNSET_REVOKE_PATH,
        body: bodyResult.value.body,
        responseLimitBytes: 8192,
      }]);
      if (!response || ownData(response, 'statusCode') !== 200) throw failure();
      return Object.freeze({ status: 'revoked' });
    } catch (error) {
      if (error && error.code === FAILURE_CODE) throw error;
      throw failure();
    }
  }

  return Object.freeze({ revokeRefreshToken });
}

module.exports = Object.freeze({
  GMAIL_SUNSET_DEPLOYMENT,
  GMAIL_SUNSET_PROVIDER,
  GMAIL_SUNSET_AUTH_MODE,
  GMAIL_SUNSET_CONNECTOR_MODE,
  GMAIL_SUNSET_REDIRECT_URI_ID,
  GMAIL_SUNSET_AUTHORIZATION_ORIGIN,
  GMAIL_SUNSET_TOKEN_ORIGIN,
  GMAIL_SUNSET_REVOKE_PATH,
  GMAIL_SUNSET_OAUTH_CLIENT_ID_ENV,
  GMAIL_SUNSET_OAUTH_CLIENT_SECRET_ENV,
  GMAIL_SUNSET_PKCE_METHOD,
  GMAIL_SUNSET_ACCESS_TYPE,
  GMAIL_SUNSET_AUTOMATION_MODE,
  GMAIL_SUNSET_OIDC_SCOPES,
  GMAIL_SUNSET_GMAIL_SCOPES,
  GMAIL_SUNSET_SINGLE_CONSENT_SCOPES,
  readGmailSunsetStagingOAuthEnv,
  hasGmailSunsetStagingOAuthLiveCredentials,
  buildGmailSunsetStagingScopePlan,
  validateGmailSunsetStagingScopePlan,
  buildGmailSunsetStagingAuthorizationUrl,
  validateGmailSunsetStagingCallbackState,
  validateGmailSunsetStagingGrantSecretPackage,
  evaluateGmailSunsetStagingOAuthReadiness,
  buildGmailSunsetStagingRevokeRequestBody,
  createGmailSunsetStagingTokenRevokeService,
});
