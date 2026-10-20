'use strict';

/**
 * Selected Wolfhouse TEST WhatsApp identity.
 *
 * Values come from the operator env file already loaded into the process
 * (compose env_file / systemd EnvironmentFile). This module never reads a
 * vault, never calls Graph, and never writes env files.
 *
 * Absent keys mean this process is not the selected profile. The unselected
 * path keeps the historical proof tuple only — it is not a fallback once any
 * WA_* key is present. A selected profile with a missing, empty, or
 * conflicting public value fails closed. E.164 and display are separate
 * nonsecret configuration; a phone-number ID cannot derive them.
 */

const PUBLIC_KEYS = Object.freeze([
  'WA_PHONE_NUMBER_ID',
  'WA_BUSINESS_ACCOUNT_ID',
  'WA_APP_ID',
]);
const SECRET_KEYS = Object.freeze([
  'WA_ACCESS_TOKEN',
  'WA_APP_SECRET',
]);
const ALL_KEYS = Object.freeze([...PUBLIC_KEYS, ...SECRET_KEYS]);
const PHONE_ALIASES = Object.freeze([
  'WHATSAPP_CLOUD_PHONE_NUMBER_ID',
  'WHATSAPP_PHONE_NUMBER_ID',
  'OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID',
]);
const APP_ALIASES = Object.freeze([
  'WHATSAPP_CLOUD_APP_ID',
]);
const WABA_ALIASES = Object.freeze([
  'WHATSAPP_CLOUD_WABA_ID',
]);
const NUMBER_E164_KEY = 'LUNA_STAGING_WHATSAPP_NUMBER_E164';
const NUMBER_DISPLAY_KEY = 'LUNA_STAGING_WHATSAPP_NUMBER_DISPLAY';
const ID_RE = /^[0-9]{8,20}$/;
// Shared with docker/hermes-staging/wolfhouse/whatsapp_runtime_config.py. Do not use \s:
// Python and JavaScript disagree on U+FEFF, U+0085, and U+001C-U+001F
// (Python str.strip treats the file separators as whitespace; JavaScript trim does not).
const CREDENTIAL_REJECTED = /[\t\n\v\f\r \u001c\u001d\u001e\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;
const E164_RE = /^\+[1-9][0-9]{7,14}$/;
const UNAVAILABLE = 'Identity unavailable';
const UNSELECTED_LEGACY = Object.freeze({
  numberE164: ['+34', '6****', '9419'].join(''),
  phoneNumberId: ['1152', '900101', '233109'].join(''),
  numberDisplay: ['+34 663', ' 43 94 19'].join(''),
});

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function hasKey(env, key) {
  return Object.prototype.hasOwnProperty.call(env || {}, key);
}

function raw(env, key) {
  const value = env ? env[key] : undefined;
  return value == null ? '' : String(value);
}

function selected(env) {
  return ALL_KEYS.some((key) => hasKey(env, key));
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function agree(env, aliases, expected) {
  for (const alias of aliases) {
    const value = raw(env, alias).trim();
    if (!value) continue;
    if (value !== expected) throw fail('identity_alias_conflict');
  }
}

function emptyPublic(active, code) {
  return {
    ok: false,
    active,
    legacy: !active,
    code,
    phoneNumberId: '',
    wabaId: '',
    appId: '',
    numberE164: '',
    numberDisplay: UNAVAILABLE,
    profileId: '',
  };
}

function resolveNumberDisplay(env) {
  const numberE164 = raw(env, NUMBER_E164_KEY).trim();
  const numberDisplay = raw(env, NUMBER_DISPLAY_KEY).trim();
  if (!E164_RE.test(numberE164) || !numberDisplay || /[\u0000-\u001f]/.test(raw(env, NUMBER_DISPLAY_KEY))) {
    throw fail('identity_malformed');
  }
  if (digits(numberDisplay) !== digits(numberE164)) throw fail('identity_malformed');
  return { numberE164, numberDisplay };
}

function publicSnapshot(env = process.env) {
  if (!selected(env)) return emptyPublic(false, 'identity_not_configured');
  try {
    const identity = resolvePublicIdentity(env);
    const display = resolveNumberDisplay(env);
    return {
      ok: true,
      active: true,
      legacy: false,
      code: null,
      phoneNumberId: identity.phoneNumberId,
      wabaId: identity.wabaId,
      appId: identity.appId,
      numberE164: display.numberE164,
      numberDisplay: display.numberDisplay,
      profileId: identity.phoneNumberId,
    };
  } catch (error) {
    return emptyPublic(true, error.code || 'identity_rejected');
  }
}

function resolvePublicIdentity(env = process.env) {
  if (!selected(env)) throw fail('identity_not_configured');
  const phoneNumberId = raw(env, 'WA_PHONE_NUMBER_ID').trim();
  const wabaId = raw(env, 'WA_BUSINESS_ACCOUNT_ID').trim();
  const appId = raw(env, 'WA_APP_ID').trim();
  if (!ID_RE.test(phoneNumberId) || !ID_RE.test(wabaId) || !ID_RE.test(appId)) {
    throw fail('identity_malformed');
  }
  agree(env, PHONE_ALIASES, phoneNumberId);
  agree(env, APP_ALIASES, appId);
  agree(env, WABA_ALIASES, wabaId);
  return { phoneNumberId, wabaId, appId };
}

function resolveSecrets(env = process.env) {
  const accessToken = raw(env, 'WA_ACCESS_TOKEN');
  const appSecret = raw(env, 'WA_APP_SECRET');
  if (!accessToken.trim() || !appSecret.trim() || CREDENTIAL_REJECTED.test(accessToken) || CREDENTIAL_REJECTED.test(appSecret)) {
    throw fail('secret_missing');
  }
  return { accessToken: accessToken.trim(), appSecret: appSecret.trim() };
}

function proofExpectation(env = process.env) {
  if (!selected(env)) {
    return {
      reject: false,
      legacy: true,
      numberE164: UNSELECTED_LEGACY.numberE164,
      phoneNumberId: UNSELECTED_LEGACY.phoneNumberId,
    };
  }
  const snapshot = publicSnapshot(env);
  if (!snapshot.ok || !snapshot.numberE164 || !snapshot.phoneNumberId) {
    return { reject: true, legacy: false, numberE164: '', phoneNumberId: '' };
  }
  return {
    reject: false,
    legacy: false,
    numberE164: snapshot.numberE164,
    phoneNumberId: snapshot.phoneNumberId,
  };
}

function routePublicIdentity(env = process.env) {
  if (!selected(env)) {
    return {
      ok: true,
      active: false,
      legacy: true,
      phoneNumberId: UNSELECTED_LEGACY.phoneNumberId,
      numberE164: UNSELECTED_LEGACY.numberE164,
      numberDisplay: UNSELECTED_LEGACY.numberDisplay,
      profileId: UNSELECTED_LEGACY.phoneNumberId,
    };
  }
  return publicSnapshot(env);
}

function exportedPublicId(field, env = process.env) {
  if (!selected(env)) {
    if (field === 'numberDisplay') return UNSELECTED_LEGACY.numberDisplay;
    return UNSELECTED_LEGACY[field] || '';
  }
  const snapshot = publicSnapshot(env);
  return snapshot.ok ? snapshot[field] || '' : '';
}

function applyStaffProcessEnv(env = process.env) {
  const identity = resolvePublicIdentity(env);
  const secrets = resolveSecrets(env);
  env.WHATSAPP_PHONE_NUMBER_ID = identity.phoneNumberId;
  env.WHATSAPP_CLOUD_ACCESS_TOKEN = secrets.accessToken;
  env.META_APP_SECRET = secrets.appSecret;
  return { applied: true, phoneConfigured: true };
}

function applyLunaProcessEnv(env = process.env) {
  const identity = resolvePublicIdentity(env);
  const secrets = resolveSecrets(env);
  env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = identity.phoneNumberId;
  env.WHATSAPP_CLOUD_ACCESS_TOKEN = secrets.accessToken;
  env.WHATSAPP_CLOUD_APP_SECRET = secrets.appSecret;
  env.WHATSAPP_CLOUD_APP_ID = identity.appId;
  env.WHATSAPP_CLOUD_WABA_ID = identity.wabaId;
  return { applied: true, phoneConfigured: true };
}

module.exports = {
  PUBLIC_KEYS,
  SECRET_KEYS,
  ALL_KEYS,
  PHONE_ALIASES,
  APP_ALIASES,
  WABA_ALIASES,
  NUMBER_E164_KEY,
  NUMBER_DISPLAY_KEY,
  UNAVAILABLE,
  UNSELECTED_LEGACY,
  selected,
  publicSnapshot,
  resolvePublicIdentity,
  resolveSecrets,
  proofExpectation,
  routePublicIdentity,
  exportedPublicId,
  applyStaffProcessEnv,
  applyLunaProcessEnv,
};
