'use strict';

/**
 * MAIL-MVP-007 — dedicated Sunset staging Hermes Sol author activation.
 *
 * Exact gates only. No other tenant/client path. Never reads LUNA_AI_MODEL.
 */

const util = require('node:util');
const {
  HERMES_SOL_PROVIDER,
  HERMES_SOL_MODEL,
  HERMES_SOL_RUNTIME,
} = require('./email-luna-sunset-email-hermes-sol-contract');

const isProxy = util.types.isProxy.bind(undefined);
const freeze = Object.freeze;
const create = Object.create;
const getDesc = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;

const ENV_AUTHOR_ENABLED = 'EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED';
const ENV_BASE_URL = 'EMAIL_LUNA_HERMES_SOL_BASE_URL';
const ENV_TOKEN = 'EMAIL_LUNA_HERMES_SOL_TOKEN';
const ENV_HMAC_SECRET = 'EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET';
const ENV_TIMEOUT_MS = 'EMAIL_LUNA_HERMES_SOL_TIMEOUT_MS';
const ENV_TLS_PIN = 'EMAIL_LUNA_HERMES_SOL_TLS_PIN';
const ENV_TLS_SERVER_NAME = 'EMAIL_LUNA_HERMES_SOL_TLS_SERVER_NAME';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_URL_CHARS = 256;
const MAX_TOKEN_CHARS = 256;
const MAX_PIN_CHARS = 64;
const LOCAL_HTTP = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;
const LOCAL_HTTPS = /^https:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;
const ACA_INTERNAL_HTTPS = /^https:\/\/luna-sunset-staging-email-luna\.internal\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.northeurope\.azurecontainerapps\.io$/i;
const TLS_PIN = /^[0-9a-f]{64}$/i;

function ownData(value, key) {
  try {
    const descriptor = getDesc(value, key);
    return descriptor && hasOwn(descriptor, 'value') && descriptor.enumerable && !descriptor.get && !descriptor.set
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function readString(env, key) {
  const value = ownData(env, key);
  return typeof value === 'string' ? value : '';
}

function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string' || isProxy(raw)) return null;
  const text = raw.trim();
  if (!text || text.length > MAX_URL_CHARS) return null;
  if (/[^\x20-\x7e]/.test(text)) return null;
  if (text.includes('@') || text.includes('\\') || text.includes(' ')) return null;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname && url.pathname !== '/') return null;
  const origin = `${url.protocol}//${url.host}`;
  if (LOCAL_HTTP.test(origin) || LOCAL_HTTPS.test(origin) || ACA_INTERNAL_HTTPS.test(origin)) {
    return origin.replace(/\/+$/, '');
  }
  return null;
}

function isLoopbackOrigin(origin) {
  return typeof origin === 'string' && (LOCAL_HTTP.test(origin) || LOCAL_HTTPS.test(origin));
}

function normalizeTlsPin(raw) {
  if (typeof raw !== 'string' || isProxy(raw)) return null;
  const text = raw.trim().toLowerCase();
  if (!TLS_PIN.test(text) || text.length > MAX_PIN_CHARS) return null;
  return text;
}

function normalizeServerName(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || isProxy(raw)) return null;
  const text = raw.trim().toLowerCase();
  if (!text || text.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(text)) return null;
  return text;
}

function snapshotSunsetEmailHermesSolEnv(env) {
  const src = env && typeof env === 'object' && !isProxy(env) && !Array.isArray(env) ? env : {};
  const out = create(null);
  const enabled = readString(src, ENV_AUTHOR_ENABLED);
  const baseUrl = readString(src, ENV_BASE_URL);
  const token = readString(src, ENV_TOKEN);
  const hmacSecret = readString(src, ENV_HMAC_SECRET);
  const timeoutRaw = readString(src, ENV_TIMEOUT_MS);
  const tlsPin = readString(src, ENV_TLS_PIN);
  const serverName = readString(src, ENV_TLS_SERVER_NAME);
  const deployment = readString(src, 'LUNA_DEPLOYMENT');
  if (deployment) out.LUNA_DEPLOYMENT = deployment;
  if (enabled) out[ENV_AUTHOR_ENABLED] = enabled;
  if (baseUrl) out[ENV_BASE_URL] = baseUrl;
  if (token) out[ENV_TOKEN] = token;
  if (hmacSecret) out[ENV_HMAC_SECRET] = hmacSecret;
  if (timeoutRaw) out[ENV_TIMEOUT_MS] = timeoutRaw;
  if (tlsPin) out[ENV_TLS_PIN] = tlsPin;
  if (serverName) out[ENV_TLS_SERVER_NAME] = serverName;
  return freeze(out);
}

function isSunsetEmailHermesSolAuthorEnabled(input) {
  if (!input || typeof input !== 'object' || isProxy(input) || Array.isArray(input)) return false;
  const env = ownData(input, 'env') || input.env;
  if (!env || typeof env !== 'object' || isProxy(env) || Array.isArray(env)) return false;
  if (ownData(env, 'LUNA_DEPLOYMENT') !== 'sunset-staging') return false;
  if (ownData(env, ENV_AUTHOR_ENABLED) !== 'true') return false;
  const url = normalizeBaseUrl(ownData(env, ENV_BASE_URL));
  if (!url) return false;
  const loopback = isLoopbackOrigin(url);
  if (!loopback && !ACA_INTERNAL_HTTPS.test(url)) return false;
  const pinRaw = ownData(env, ENV_TLS_PIN);
  const pin = normalizeTlsPin(pinRaw);
  if (pinRaw !== undefined && pinRaw !== null && pinRaw !== '' && !pin) {
    return false;
  }
  const serverNameRaw = ownData(env, ENV_TLS_SERVER_NAME);
  if (serverNameRaw !== undefined && serverNameRaw !== null && serverNameRaw !== '') {
    if (!normalizeServerName(serverNameRaw)) return false;
  }
  const token = ownData(env, ENV_TOKEN);
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_CHARS) return false;
  if (token.trim() !== token || /\s/.test(token)) return false;
  const hmacSecret = ownData(env, ENV_HMAC_SECRET);
  if (typeof hmacSecret !== 'string' || !hmacSecret || hmacSecret.length > MAX_TOKEN_CHARS) return false;
  if (hmacSecret.trim() !== hmacSecret || /\s/.test(hmacSecret)) return false;
  const timeoutRaw = ownData(env, ENV_TIMEOUT_MS);
  if (timeoutRaw !== undefined && timeoutRaw !== null && timeoutRaw !== '') {
    const parsed = Number.parseInt(timeoutRaw, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 120000 || String(parsed) !== String(timeoutRaw).trim()) {
      return false;
    }
  }
  return true;
}

function resolveSunsetEmailHermesSolClientConfig(env) {
  const snap = snapshotSunsetEmailHermesSolEnv(env);
  if (!isSunsetEmailHermesSolAuthorEnabled({ env: snap })) {
    return null;
  }
  const timeoutRaw = ownData(snap, ENV_TIMEOUT_MS);
  const timeoutMs = timeoutRaw
    ? Number.parseInt(timeoutRaw, 10)
    : DEFAULT_TIMEOUT_MS;
  const out = create(null);
  out.baseUrl = normalizeBaseUrl(ownData(snap, ENV_BASE_URL));
  out.token = ownData(snap, ENV_TOKEN);
  out.hmacSecret = ownData(snap, ENV_HMAC_SECRET);
  out.timeoutMs = timeoutMs;
  out.tlsPin = normalizeTlsPin(ownData(snap, ENV_TLS_PIN));
  out.tlsServerName = normalizeServerName(ownData(snap, ENV_TLS_SERVER_NAME));
  out.loopback = isLoopbackOrigin(out.baseUrl);
  out.provider = HERMES_SOL_PROVIDER;
  out.model = HERMES_SOL_MODEL;
  out.runtime = HERMES_SOL_RUNTIME;
  return freeze(out);
}

function secretFreeHermesSolDiagnostics(config) {
  if (!config) {
    return freeze({ enabled: false, provider: null, model: null, runtime: null });
  }
  return freeze({
    enabled: true,
    provider: HERMES_SOL_PROVIDER,
    model: HERMES_SOL_MODEL,
    runtime: HERMES_SOL_RUNTIME,
  });
}

module.exports = freeze({
  ENV_AUTHOR_ENABLED,
  ENV_BASE_URL,
  ENV_TOKEN,
  ENV_HMAC_SECRET,
  ENV_TIMEOUT_MS,
  ENV_TLS_PIN,
  ENV_TLS_SERVER_NAME,
  DEFAULT_TIMEOUT_MS,
  snapshotSunsetEmailHermesSolEnv,
  isSunsetEmailHermesSolAuthorEnabled,
  resolveSunsetEmailHermesSolClientConfig,
  secretFreeHermesSolDiagnostics,
  normalizeTlsPin,
  isLoopbackOrigin,
  ACA_INTERNAL_HTTPS,
});
