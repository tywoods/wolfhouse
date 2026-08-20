'use strict';

/**
 * Server-owned Sunset IMAP secret-reference contract (EMAIL-IMAP-001).
 *
 * Approved Key Vault secret *names* are exact and closed. Runtime env may
 * only hold the opaque `kv:<name>` references — never secret values.
 * Evaluation reports missing NAMES only. No resolve, no Azure, no plaintext.
 *
 * @module email-sunset-imap-secret-ref-contract
 */

const { types } = require('node:util');
const { validateEmailMailboxSecretRef } = require('./email-mailbox-adapter-contract');

const IMAP_VERIFY_ENABLED_ENV = 'LUNA_EMAIL_IMAP_VERIFY_ENABLED';
const IMAP_INBOUND_ENABLED_ENV = 'LUNA_EMAIL_IMAP_INBOUND_ENABLED';
const IMAP_POLL_ENABLED_ENV = 'LUNA_EMAIL_IMAP_POLL_ENABLED';
const IMAP_RUNTIME_COMPOSITION_ENABLED_ENV = 'LUNA_EMAIL_IMAP_RUNTIME_COMPOSITION_ENABLED';
const IMAP_WORKER_ENABLED_ENV = 'LUNA_EMAIL_IMAP_WORKER_ENABLED';
const EMAIL_IMAP_VERIFY_PATH = '/staff/admin/email-settings/imap/verify';
const UI_ENABLED_ENV = 'SUNSET_EMAIL_SETTINGS_UI_ENABLED';
const DEPLOYMENT_ENV = 'LUNA_DEPLOYMENT';
const SUNSET_STAGING = 'sunset-staging';

const SUNSET_IMAP_SECRET_NAMES = Object.freeze([
  'sunset-imap-host',
  'sunset-imap-port',
  'sunset-imap-tls-mode',
  'sunset-imap-username',
  'sunset-imap-password',
]);

const SUNSET_IMAP_SECRET_REFS = Object.freeze(
  SUNSET_IMAP_SECRET_NAMES.map((name) => `kv:${name}`),
);

const SUNSET_IMAP_SECRET_ENV_KEYS = Object.freeze({
  'sunset-imap-host': 'LUNA_EMAIL_IMAP_HOST_SECRET_REF',
  'sunset-imap-port': 'LUNA_EMAIL_IMAP_PORT_SECRET_REF',
  'sunset-imap-tls-mode': 'LUNA_EMAIL_IMAP_TLS_MODE_SECRET_REF',
  'sunset-imap-username': 'LUNA_EMAIL_IMAP_USERNAME_SECRET_REF',
  'sunset-imap-password': 'LUNA_EMAIL_IMAP_PASSWORD_SECRET_REF',
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

function isSunsetStagingUi(env) {
  try {
    if (!env || typeof env !== 'object' || Array.isArray(env)) return false;
    if (isProxySurface(env)) return false;
    if (ownData(env, UI_ENABLED_ENV) !== 'true') return false;
    if (ownData(env, DEPLOYMENT_ENV) !== SUNSET_STAGING) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function isSunsetEmailImapVerifyEnabled(env) {
  try {
    return isSunsetStagingUi(env) && ownData(env, IMAP_VERIFY_ENABLED_ENV) === 'true';
  } catch (_) {
    return false;
  }
}

function isSunsetEmailImapInboundEnabled(env) {
  try {
    return isSunsetEmailImapVerifyEnabled(env)
      && ownData(env, IMAP_INBOUND_ENABLED_ENV) === 'true';
  } catch (_) {
    return false;
  }
}

function isSunsetEmailImapPollEnabled(env) {
  try {
    return isSunsetEmailImapVerifyEnabled(env)
      && ownData(env, IMAP_POLL_ENABLED_ENV) === 'true';
  } catch (_) {
    return false;
  }
}

function evaluateSunsetImapSecretRefs(env) {
  const missing = [];
  try {
    if (!env || typeof env !== 'object' || Array.isArray(env) || isProxySurface(env)) {
      return Object.freeze({
        ok: false,
        missing_secret_names: Object.freeze(SUNSET_IMAP_SECRET_NAMES.slice()),
        secret_refs: Object.freeze([]),
      });
    }
    for (let i = 0; i < SUNSET_IMAP_SECRET_NAMES.length; i += 1) {
      const name = SUNSET_IMAP_SECRET_NAMES[i];
      const envKey = SUNSET_IMAP_SECRET_ENV_KEYS[name];
      const expected = SUNSET_IMAP_SECRET_REFS[i];
      const actual = ownData(env, envKey);
      if (actual !== expected || !opaqueRefValid(expected) || !opaqueRefValid(actual)) {
        missing.push(name);
      }
    }
    const ok = missing.length === 0;
    return Object.freeze({
      ok,
      missing_secret_names: Object.freeze(missing.slice()),
      secret_refs: Object.freeze(ok ? SUNSET_IMAP_SECRET_REFS.slice() : []),
    });
  } catch (_) {
    return Object.freeze({
      ok: false,
      missing_secret_names: Object.freeze(missing.length
        ? missing.slice()
        : SUNSET_IMAP_SECRET_NAMES.slice()),
      secret_refs: Object.freeze([]),
    });
  }
}

module.exports = Object.freeze({
  IMAP_VERIFY_ENABLED_ENV,
  IMAP_INBOUND_ENABLED_ENV,
  IMAP_POLL_ENABLED_ENV,
  IMAP_RUNTIME_COMPOSITION_ENABLED_ENV,
  IMAP_WORKER_ENABLED_ENV,
  EMAIL_IMAP_VERIFY_PATH,
  SUNSET_IMAP_SECRET_NAMES,
  SUNSET_IMAP_SECRET_REFS,
  SUNSET_IMAP_SECRET_ENV_KEYS,
  isSunsetEmailImapVerifyEnabled,
  isSunsetEmailImapInboundEnabled,
  isSunsetEmailImapPollEnabled,
  evaluateSunsetImapSecretRefs,
});
