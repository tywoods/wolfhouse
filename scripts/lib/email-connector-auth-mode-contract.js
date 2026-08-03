'use strict';

/** Email connector/auth-mode (Slice 2C). Default SaaS: microsoft_graph+delegated_authorization_code; app-only enterprise. Own-data only; never throws. @module email-connector-auth-mode-contract */

const EMAIL_AUTH_MODES = Object.freeze([
  'delegated_authorization_code', 'application_client_credentials',
]);
const EMAIL_CONNECTOR_MODE_IDS = Object.freeze([
  'microsoft_delegated_oauth', 'microsoft_app_only_enterprise',
]);
const EMAIL_CONNECTOR_MODE_ROWS = Object.freeze([
  Object.freeze({
    connector_mode: 'microsoft_delegated_oauth', provider: 'microsoft_graph',
    auth_mode: 'delegated_authorization_code', default_saas: true,
    enterprise_opt_in: false, phase: 'A',
  }),
  Object.freeze({
    connector_mode: 'microsoft_app_only_enterprise', provider: 'microsoft_graph',
    auth_mode: 'application_client_credentials', default_saas: false,
    enterprise_opt_in: true, phase: 'enterprise',
  }),
]);
const EMAIL_DEFAULT_SAAS_CONNECTOR_MODE = 'microsoft_delegated_oauth';
const EMAIL_DEFAULT_SAAS_PROVIDER = 'microsoft_graph';
const EMAIL_DEFAULT_SAAS_AUTH_MODE = 'delegated_authorization_code';
const EMAIL_CONNECTOR_MATERIAL_KEY_NAMES = Object.freeze({
  microsoft_delegated_oauth: Object.freeze(['refresh_token']),
  microsoft_app_only_enterprise: Object.freeze(['tenant_id', 'client_id', 'client_secret']),
});
const PAIR_KEYS = ['provider', 'auth_mode'];
const MODE_KEYS = ['connector_mode'];
const AUTH_MODE_SET = new Set(EMAIL_AUTH_MODES);
const CONNECTOR_MODE_SET = new Set(EMAIL_CONNECTOR_MODE_IDS);
const PROVIDER_AUTH_INDEX = new Map();
const CONNECTOR_MODE_INDEX = new Map();
for (const row of EMAIL_CONNECTOR_MODE_ROWS) {
  PROVIDER_AUTH_INDEX.set(`${row.provider}\0${row.auth_mode}`, row);
  CONNECTOR_MODE_INDEX.set(row.connector_mode, row);
}
const EXPLICIT_IMPOSSIBLE_MIXES = Object.freeze([
  Object.freeze({ provider: 'microsoft_graph', auth_mode: 'password_or_app_password' }),
  Object.freeze({ provider: 'gmail_api', auth_mode: 'application_client_credentials' }),
  Object.freeze({ provider: 'imap_smtp', auth_mode: 'delegated_authorization_code' }),
  Object.freeze({ provider: 'imap_smtp', auth_mode: 'application_client_credentials' }),
]);

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
function keySetFail(obj, keys, error) {
  if (exactKeys(obj, keys)) return null;
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k)) return fail(error, { reason: 'unknown_key' });
  }
  return fail(error, { reason: 'key_set' });
}
function rowToValue(row) {
  return {
    connector_mode: row.connector_mode, provider: row.provider, auth_mode: row.auth_mode,
    default_saas: row.default_saas === true, enterprise_opt_in: row.enterprise_opt_in === true,
    phase: row.phase,
    material_key_names: (EMAIL_CONNECTOR_MATERIAL_KEY_NAMES[row.connector_mode] || []).slice(),
  };
}

function validateEmailConnectorAuthModePair(input) {
  try {
    const snap = snapshotOwnDataProps(input);
    if (!snap.ok) return fail('connector_auth_mode_invalid', { reason: snap.reason });
    const obj = snap.value;
    const ks = keySetFail(obj, PAIR_KEYS, 'connector_auth_mode_invalid');
    if (ks) return ks;
    if (typeof obj.provider !== 'string') return fail('connector_auth_mode_invalid', { reason: 'provider_not_string' });
    if (typeof obj.auth_mode !== 'string') return fail('connector_auth_mode_invalid', { reason: 'auth_mode_not_string' });
    for (const mix of EXPLICIT_IMPOSSIBLE_MIXES) {
      if (obj.provider === mix.provider && obj.auth_mode === mix.auth_mode) {
        return fail('connector_auth_mode_impossible_mix', { reason: 'impossible_mix' });
      }
    }
    if (!AUTH_MODE_SET.has(obj.auth_mode)) return fail('connector_auth_mode_invalid', { reason: 'auth_mode_unknown' });
    const row = PROVIDER_AUTH_INDEX.get(`${obj.provider}\0${obj.auth_mode}`);
    if (!row) return fail('connector_auth_mode_impossible_mix', { reason: 'pair_unknown' });
    return ok(rowToValue(row));
  } catch {
    return fail('connector_auth_mode_invalid', { reason: 'reflection_failed' });
  }
}

function resolveEmailConnectorMode(input) {
  try {
    const snap = snapshotOwnDataProps(input);
    if (!snap.ok) return fail('connector_mode_invalid', { reason: snap.reason });
    const obj = snap.value;
    const ks = keySetFail(obj, MODE_KEYS, 'connector_mode_invalid');
    if (ks) return ks;
    if (typeof obj.connector_mode !== 'string') return fail('connector_mode_invalid', { reason: 'connector_mode_not_string' });
    const row = CONNECTOR_MODE_INDEX.get(obj.connector_mode);
    if (!row || !CONNECTOR_MODE_SET.has(obj.connector_mode)) {
      return fail('connector_mode_invalid', { reason: 'connector_mode_unknown' });
    }
    return ok(rowToValue(row));
  } catch {
    return fail('connector_mode_invalid', { reason: 'reflection_failed' });
  }
}

function isDefaultSaasEmailConnectorAuthMode(input) {
  try {
    const r = validateEmailConnectorAuthModePair(input);
    return Boolean(r && r.ok && r.value && r.value.default_saas === true
      && r.value.connector_mode === EMAIL_DEFAULT_SAAS_CONNECTOR_MODE);
  } catch { return false; }
}

function getEmailConnectorMaterialKeyNames(connectorMode) {
  try {
    if (typeof connectorMode !== 'string') return fail('connector_mode_invalid', { reason: 'connector_mode_not_string' });
    if (!CONNECTOR_MODE_SET.has(connectorMode)) return fail('connector_mode_invalid', { reason: 'connector_mode_unknown' });
    const names = EMAIL_CONNECTOR_MATERIAL_KEY_NAMES[connectorMode];
    if (!names) return fail('connector_mode_invalid', { reason: 'material_keys_missing' });
    return ok(names.slice());
  } catch {
    return fail('connector_mode_invalid', { reason: 'reflection_failed' });
  }
}

module.exports = {
  validateEmailConnectorAuthModePair, resolveEmailConnectorMode,
  isDefaultSaasEmailConnectorAuthMode, getEmailConnectorMaterialKeyNames,
  EMAIL_AUTH_MODES, EMAIL_CONNECTOR_MODE_IDS, EMAIL_CONNECTOR_MODE_ROWS,
  EMAIL_DEFAULT_SAAS_CONNECTOR_MODE, EMAIL_DEFAULT_SAAS_PROVIDER,
  EMAIL_DEFAULT_SAAS_AUTH_MODE, EMAIL_CONNECTOR_MATERIAL_KEY_NAMES,
};
