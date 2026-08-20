'use strict';

/**
 * Server-owned Sunset SMTP secret-reference contract (EMAIL-SMTP-002).
 *
 * Approved Key Vault secret *names* are exact and closed. Runtime env may
 * only hold the opaque `kv:<name>` references — never secret values.
 * Evaluation reports missing NAMES only. No resolve, no Azure, no plaintext.
 *
 * @module email-sunset-smtp-secret-ref-contract
 */

const { types } = require('node:util');
const { validateEmailMailboxSecretRef } = require('./email-mailbox-adapter-contract');

const SMTP_IDENTITY_REGISTER_ENABLED_ENV = 'LUNA_EMAIL_SMTP_IDENTITY_REGISTER_ENABLED';
const EMAIL_SMTP_IDENTITY_PATH = '/staff/admin/email-settings/smtp/endpoint';
const SMTP_VERIFY_ENABLED_ENV = 'LUNA_EMAIL_SMTP_VERIFY_ENABLED';
const EMAIL_SMTP_VERIFY_PATH = '/staff/admin/email-settings/smtp/verify';
const SUNSET_SMTP_IDENTITY_SECRET_REF = 'secret-ref:email/smtp/sunset-staging';
const UI_ENABLED_ENV = 'SUNSET_EMAIL_SETTINGS_UI_ENABLED';
const DEPLOYMENT_ENV = 'LUNA_DEPLOYMENT';
const SUNSET_STAGING = 'sunset-staging';

const SUNSET_SMTP_SECRET_NAMES = Object.freeze([
  'sunset-smtp-host',
  'sunset-smtp-port',
  'sunset-smtp-tls-mode',
  'sunset-smtp-username',
  'sunset-smtp-password',
]);

const SUNSET_SMTP_SECRET_REFS = Object.freeze(
  SUNSET_SMTP_SECRET_NAMES.map((name) => `kv:${name}`),
);

const SUNSET_SMTP_SECRET_ENV_KEYS = Object.freeze({
  'sunset-smtp-host': 'LUNA_EMAIL_SMTP_HOST_SECRET_REF',
  'sunset-smtp-port': 'LUNA_EMAIL_SMTP_PORT_SECRET_REF',
  'sunset-smtp-tls-mode': 'LUNA_EMAIL_SMTP_TLS_MODE_SECRET_REF',
  'sunset-smtp-username': 'LUNA_EMAIL_SMTP_USERNAME_SECRET_REF',
  'sunset-smtp-password': 'LUNA_EMAIL_SMTP_PASSWORD_SECRET_REF',
});

const PINNED_IS_PROXY = types && typeof types.isProxy === 'function'
  ? types.isProxy.bind(types)
  : null;

function opaqueRefValid(value) {
  try {
    return validateEmailMailboxSecretRef(value).ok === true;
  } catch (_) {
    return false;
  }
}

function isProxySurface(value) {
  try {
    if (typeof PINNED_IS_PROXY !== 'function') return true;
    return PINNED_IS_PROXY(value) === true;
  } catch (_) {
    return true;
  }
}

function ownData(obj, key) {
  try {
    if (!obj || typeof obj !== 'object') return undefined;
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    return desc && Object.hasOwn(desc, 'value') && !desc.get && !desc.set
      ? desc.value
      : undefined;
  } catch (_) {
    return undefined;
  }
}

function isSunsetEmailSmtpIdentityRegisterEnabled(env) {
  try {
    if (!env || typeof env !== 'object' || Array.isArray(env)) return false;
    if (isProxySurface(env)) return false;
    if (ownData(env, UI_ENABLED_ENV) !== 'true') return false;
    if (ownData(env, DEPLOYMENT_ENV) !== SUNSET_STAGING) return false;
    if (ownData(env, SMTP_IDENTITY_REGISTER_ENABLED_ENV) !== 'true') return false;
    return true;
  } catch (_) {
    return false;
  }
}

function isSunsetEmailSmtpVerifyEnabled(env) {
  try {
    return isSunsetEmailSmtpIdentityRegisterEnabled(env)
      && ownData(env, SMTP_VERIFY_ENABLED_ENV) === 'true';
  } catch (_) {
    return false;
  }
}

function evaluateSunsetSmtpSecretRefs(env) {
  const missing = [];
  try {
    if (!env || typeof env !== 'object' || Array.isArray(env) || isProxySurface(env)) {
      return Object.freeze({
        ok: false,
        missing_secret_names: Object.freeze(SUNSET_SMTP_SECRET_NAMES.slice()),
        secret_refs: Object.freeze([]),
      });
    }
    for (let i = 0; i < SUNSET_SMTP_SECRET_NAMES.length; i += 1) {
      const name = SUNSET_SMTP_SECRET_NAMES[i];
      const envKey = SUNSET_SMTP_SECRET_ENV_KEYS[name];
      const expected = SUNSET_SMTP_SECRET_REFS[i];
      const actual = ownData(env, envKey);
      if (actual !== expected || !opaqueRefValid(expected) || !opaqueRefValid(actual)) {
        missing.push(name);
      }
    }
    const ok = missing.length === 0;
    return Object.freeze({
      ok,
      missing_secret_names: Object.freeze(missing.slice()),
      secret_refs: Object.freeze(ok ? SUNSET_SMTP_SECRET_REFS.slice() : []),
    });
  } catch (_) {
    return Object.freeze({
      ok: false,
      missing_secret_names: Object.freeze(missing.length
        ? missing.slice()
        : SUNSET_SMTP_SECRET_NAMES.slice()),
      secret_refs: Object.freeze([]),
    });
  }
}

module.exports = Object.freeze({
  SMTP_IDENTITY_REGISTER_ENABLED_ENV,
  EMAIL_SMTP_IDENTITY_PATH,
  SMTP_VERIFY_ENABLED_ENV,
  EMAIL_SMTP_VERIFY_PATH,
  SUNSET_SMTP_IDENTITY_SECRET_REF,
  SUNSET_SMTP_SECRET_NAMES,
  SUNSET_SMTP_SECRET_REFS,
  SUNSET_SMTP_SECRET_ENV_KEYS,
  isSunsetEmailSmtpIdentityRegisterEnabled,
  isSunsetEmailSmtpVerifyEnabled,
  evaluateSunsetSmtpSecretRefs,
});
