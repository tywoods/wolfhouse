'use strict';

/**
 * Wolfhouse SMTP secret-reference contract (WOLFHOUSE-EMAIL-001).
 * Independent of Sunset `sunset-smtp-*` names and env keys.
 * Runtime env may only hold opaque `kv:<name>` refs — never secret values.
 *
 * @module email-wolfhouse-smtp-secret-ref-contract
 */

const { types } = require('node:util');
const { validateEmailMailboxSecretRef } = require('./email-mailbox-adapter-contract');
const {
  ENV_UI,
  ENV_SMTP_REGISTER,
  WOLFHOUSE_DEPLOYMENT,
  WOLFHOUSE_SMTP_IDENTITY_SECRET_REF,
} = require('./email-wolfhouse-tenant');

const EMAIL_SMTP_IDENTITY_PATH = '/staff/admin/email-settings/smtp/endpoint';
const EMAIL_SMTP_VERIFY_PATH = '/staff/admin/email-settings/smtp/verify';
const EMAIL_SMTP_DISCONNECT_PATH = '/staff/admin/email-settings/smtp/disconnect';

const WOLFHOUSE_SMTP_SECRET_NAMES = Object.freeze([
  'wolfhouse-smtp-host',
  'wolfhouse-smtp-port',
  'wolfhouse-smtp-tls-mode',
  'wolfhouse-smtp-username',
  'wolfhouse-smtp-password',
]);

const WOLFHOUSE_SMTP_SECRET_REFS = Object.freeze(
  WOLFHOUSE_SMTP_SECRET_NAMES.map((name) => `kv:${name}`),
);

const WOLFHOUSE_SMTP_SECRET_ENV_KEYS = Object.freeze({
  'wolfhouse-smtp-host': 'WOLFHOUSE_EMAIL_SMTP_HOST_SECRET_REF',
  'wolfhouse-smtp-port': 'WOLFHOUSE_EMAIL_SMTP_PORT_SECRET_REF',
  'wolfhouse-smtp-tls-mode': 'WOLFHOUSE_EMAIL_SMTP_TLS_MODE_SECRET_REF',
  'wolfhouse-smtp-username': 'WOLFHOUSE_EMAIL_SMTP_USERNAME_SECRET_REF',
  'wolfhouse-smtp-password': 'WOLFHOUSE_EMAIL_SMTP_PASSWORD_SECRET_REF',
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

function isWolfhouseEmailSmtpIdentityRegisterEnabled(env) {
  try {
    if (!env || typeof env !== 'object' || Array.isArray(env)) return false;
    if (isProxySurface(env)) return false;
    if (ownData(env, ENV_UI) !== 'true') return false;
    if (ownData(env, 'LUNA_DEPLOYMENT') !== WOLFHOUSE_DEPLOYMENT) return false;
    if (ownData(env, ENV_SMTP_REGISTER) !== 'true') return false;
    return true;
  } catch (_) {
    return false;
  }
}

function evaluateWolfhouseSmtpSecretRefs(env) {
  const missing = [];
  try {
    if (!env || typeof env !== 'object' || Array.isArray(env) || isProxySurface(env)) {
      return Object.freeze({
        ok: false,
        missing_secret_names: Object.freeze(WOLFHOUSE_SMTP_SECRET_NAMES.slice()),
        secret_refs: Object.freeze([]),
      });
    }
    for (let i = 0; i < WOLFHOUSE_SMTP_SECRET_NAMES.length; i += 1) {
      const name = WOLFHOUSE_SMTP_SECRET_NAMES[i];
      const envKey = WOLFHOUSE_SMTP_SECRET_ENV_KEYS[name];
      const expected = WOLFHOUSE_SMTP_SECRET_REFS[i];
      const actual = ownData(env, envKey);
      if (actual !== expected || !opaqueRefValid(expected) || !opaqueRefValid(actual)) {
        missing.push(name);
      }
    }
    const ok = missing.length === 0;
    return Object.freeze({
      ok,
      missing_secret_names: Object.freeze(missing.slice()),
      secret_refs: Object.freeze(ok ? WOLFHOUSE_SMTP_SECRET_REFS.slice() : []),
    });
  } catch (_) {
    return Object.freeze({
      ok: false,
      missing_secret_names: Object.freeze(missing.length
        ? missing.slice()
        : WOLFHOUSE_SMTP_SECRET_NAMES.slice()),
      secret_refs: Object.freeze([]),
    });
  }
}

module.exports = Object.freeze({
  EMAIL_SMTP_IDENTITY_PATH,
  EMAIL_SMTP_VERIFY_PATH,
  EMAIL_SMTP_DISCONNECT_PATH,
  WOLFHOUSE_SMTP_IDENTITY_SECRET_REF,
  WOLFHOUSE_SMTP_SECRET_NAMES,
  WOLFHOUSE_SMTP_SECRET_REFS,
  WOLFHOUSE_SMTP_SECRET_ENV_KEYS,
  isWolfhouseEmailSmtpIdentityRegisterEnabled,
  evaluateWolfhouseSmtpSecretRefs,
});
