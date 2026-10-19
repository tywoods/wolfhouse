'use strict';

/**
 * Selected Wolfhouse TEST WhatsApp identity.
 *
 * Values come from the operator env file already loaded into the process
 * (compose env_file / systemd EnvironmentFile). This module never reads a
 * vault, never calls Graph, and never writes env files.
 *
 * Absent keys mean this process is not the selected profile: callers must
 * leave other tenants alone. Any present key makes the profile active, and
 * missing or conflicting values fail closed. There is no old-number fallback.
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
const ID_RE = /^[0-9]{8,20}$/;
const UNAVAILABLE = 'Identity unavailable';
const CLOSED = Object.freeze({ numberE164: '\u0000', phoneNumberId: '\u0000' });

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

function publicSnapshot(env = process.env) {
  if (!selected(env)) {
    return {
      ok: false,
      active: false,
      code: 'identity_not_configured',
      phoneNumberId: '',
      wabaId: '',
      appId: '',
      numberE164: '',
      numberDisplay: UNAVAILABLE,
      profileId: '',
    };
  }
  try {
    const identity = resolvePublicIdentity(env);
    const tail = identity.phoneNumberId.slice(-4);
    return {
      ok: true,
      active: true,
      code: null,
      phoneNumberId: identity.phoneNumberId,
      wabaId: identity.wabaId,
      appId: identity.appId,
      numberE164: '',
      numberDisplay: `configured ···${tail}`,
      profileId: identity.phoneNumberId,
    };
  } catch (error) {
    return {
      ok: false,
      active: true,
      code: error.code || 'identity_rejected',
      phoneNumberId: '',
      wabaId: '',
      appId: '',
      numberE164: '',
      numberDisplay: UNAVAILABLE,
      profileId: '',
    };
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
  for (const alias of PHONE_ALIASES) {
    const value = raw(env, alias).trim();
    if (!value) continue;
    if (value !== phoneNumberId) throw fail('identity_alias_conflict');
  }
  return { phoneNumberId, wabaId, appId };
}

function resolveSecrets(env = process.env) {
  const accessToken = raw(env, 'WA_ACCESS_TOKEN').trim();
  const appSecret = raw(env, 'WA_APP_SECRET').trim();
  if (!accessToken || !appSecret || /\s/.test(raw(env, 'WA_ACCESS_TOKEN')) || /\s/.test(raw(env, 'WA_APP_SECRET'))) {
    throw fail('secret_missing');
  }
  return { accessToken, appSecret };
}

function proofExpectation(env = process.env) {
  const snapshot = publicSnapshot(env);
  if (!snapshot.active) return { numberE164: '', phoneNumberId: '' };
  if (!snapshot.ok) return { numberE164: CLOSED.numberE164, phoneNumberId: CLOSED.phoneNumberId };
  return { numberE164: snapshot.numberE164, phoneNumberId: snapshot.phoneNumberId };
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
  UNAVAILABLE,
  selected,
  publicSnapshot,
  resolvePublicIdentity,
  resolveSecrets,
  proofExpectation,
  applyStaffProcessEnv,
  applyLunaProcessEnv,
};
