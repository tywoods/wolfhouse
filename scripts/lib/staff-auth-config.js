'use strict';

/**
 * Pure Staff API auth-config validator (fail-closed).
 *
 * Keep this module free of staff-query-api.js so startup rules are unit-testable
 * without importing the monolith.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const LOCAL_TEST_PROFILES = new Set(['development', 'dev', 'test', 'local']);
const STAGING_OR_PROD_PROFILES = new Set(['staging', 'production', 'prod']);

const AUTH_REQUIRED_VAR = 'STAFF_AUTH_REQUIRED';
const AUTH_HTTPS_VAR = 'STAFF_AUTH_HTTPS';
const AUTH_ALLOW_OPEN_VAR = 'STAFF_AUTH_ALLOW_OPEN';
const RUNTIME_PROFILE_VAR = 'STAFF_RUNTIME_PROFILE';
const BIND_HOST_VAR = 'STAFF_QUERY_API_HOST';
const BOT_TOKEN_VAR = 'LUNA_BOT_INTERNAL_TOKEN';
const NODE_ENV_VAR = 'NODE_ENV';

const MIN_BOT_TOKEN_LENGTH = 32;

function rawEnv(env, key) {
  if (!env || !Object.prototype.hasOwnProperty.call(env, key)) return undefined;
  return env[key];
}

function asTrimmedString(value) {
  if (value === undefined || value === null) return null;
  return String(value).trim();
}

function resolveRuntimeProfile(env) {
  const explicit = asTrimmedString(rawEnv(env, RUNTIME_PROFILE_VAR));
  if (explicit) return explicit.toLowerCase();
  const nodeEnv = asTrimmedString(rawEnv(env, NODE_ENV_VAR));
  if (nodeEnv) return nodeEnv.toLowerCase();
  return '';
}

function isLocalTestProfile(profile) {
  return LOCAL_TEST_PROFILES.has(profile);
}

function isStagingOrProductionProfile(profile) {
  return STAGING_OR_PROD_PROFILES.has(profile);
}

function resolveBindHost(env) {
  const raw = asTrimmedString(rawEnv(env, BIND_HOST_VAR));
  if (!raw) return '127.0.0.1';
  return raw;
}

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host || '').trim().toLowerCase());
}

function pushError(errors, variable, message) {
  errors.push({ variable, message: `${variable}: ${message}` });
}

/**
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @returns {{
 *   ok: boolean,
 *   authRequired: boolean,
 *   authHttps: boolean,
 *   openMode: boolean,
 *   bindHost: string,
 *   botInternalToken: string,
 *   runtimeProfile: string,
 *   localTestProfile: boolean,
 *   errors: Array<{ variable: string, message: string }>,
 * }}
 */
function validateStaffAuthConfig(env) {
  const e = env || {};
  const errors = [];
  const runtimeProfile = resolveRuntimeProfile(e);
  const localTestProfile = isLocalTestProfile(runtimeProfile);
  const stagingOrProd = isStagingOrProductionProfile(runtimeProfile);
  const bindHost = resolveBindHost(e);

  const authRaw = rawEnv(e, AUTH_REQUIRED_VAR);
  const authPresent = authRaw !== undefined && authRaw !== null;
  const authValue = authPresent ? String(authRaw) : '';
  const authTrim = authValue.trim();

  const httpsRaw = rawEnv(e, AUTH_HTTPS_VAR);
  const httpsPresent = httpsRaw !== undefined && httpsRaw !== null;
  const httpsTrim = httpsPresent ? String(httpsRaw).trim() : '';

  const allowOpenTrim = asTrimmedString(rawEnv(e, AUTH_ALLOW_OPEN_VAR)) || '';
  const allowOpenRequested = allowOpenTrim === 'true';
  const allowOpenMalformed = allowOpenTrim !== '' && allowOpenTrim !== 'true' && allowOpenTrim !== 'false';

  const botRaw = rawEnv(e, BOT_TOKEN_VAR);
  const botPresent = botRaw !== undefined && botRaw !== null && String(botRaw).length > 0;
  const botToken = botPresent ? String(botRaw) : '';

  if (allowOpenMalformed) {
    pushError(errors, AUTH_ALLOW_OPEN_VAR, 'must be exactly "true" or "false" when set');
  }

  if (botPresent && botToken.length < MIN_BOT_TOKEN_LENGTH) {
    pushError(
      errors,
      BOT_TOKEN_VAR,
      `is configured but shorter than ${MIN_BOT_TOKEN_LENGTH} characters`,
    );
  }

  // Open-mode opt-in on staging/production is always refused.
  if (allowOpenRequested && stagingOrProd) {
    pushError(
      errors,
      AUTH_ALLOW_OPEN_VAR,
      'open mode is refused when runtime profile is staging/production',
    );
  }

  let authRequired = false;
  let openMode = false;

  if (authTrim === 'true') {
    authRequired = true;
    if (allowOpenRequested) {
      pushError(
        errors,
        AUTH_ALLOW_OPEN_VAR,
        `cannot be enabled while ${AUTH_REQUIRED_VAR}=true`,
      );
    }
  } else if (authTrim === 'false') {
    openMode = true;
    if (!allowOpenRequested) {
      pushError(
        errors,
        AUTH_ALLOW_OPEN_VAR,
        `must be exactly "true" to allow ${AUTH_REQUIRED_VAR}=false`,
      );
    }
    if (!localTestProfile) {
      pushError(
        errors,
        RUNTIME_PROFILE_VAR,
        `open mode requires a local/test runtime profile via ${NODE_ENV_VAR} or ${RUNTIME_PROFILE_VAR}`,
      );
    }
    if (stagingOrProd) {
      pushError(
        errors,
        AUTH_REQUIRED_VAR,
        'open mode is refused when runtime profile is staging/production',
      );
    }
    if (!isLoopbackHost(bindHost)) {
      pushError(
        errors,
        BIND_HOST_VAR,
        'open mode must bind only to loopback (127.0.0.1, localhost, or ::1)',
      );
    }
  } else if (!authPresent || authTrim === '') {
    pushError(errors, AUTH_REQUIRED_VAR, 'is missing or empty (fail-closed)');
  } else {
    pushError(
      errors,
      AUTH_REQUIRED_VAR,
      'is malformed (must be exactly "true" or "false"; mixed-case rejected)',
    );
  }

  // HTTPS required outside local/test (authenticated staging/prod path).
  let authHttps = httpsTrim === 'true';
  if (!localTestProfile) {
    if (httpsTrim !== 'true') {
      pushError(
        errors,
        AUTH_HTTPS_VAR,
        'must be exactly "true" outside local/test mode',
      );
    }
  } else if (httpsPresent && httpsTrim !== '' && httpsTrim !== 'true' && httpsTrim !== 'false') {
    pushError(
      errors,
      AUTH_HTTPS_VAR,
      'is malformed (must be exactly "true" or "false" when set)',
    );
  }

  return {
    ok: errors.length === 0,
    authRequired,
    authHttps: authRequired ? authHttps : false,
    openMode: openMode && errors.length === 0,
    bindHost,
    botInternalToken: botToken,
    runtimeProfile,
    localTestProfile,
    errors,
  };
}

function formatStaffAuthConfigErrors(result) {
  const lines = (result && result.errors ? result.errors : [])
    .map((err) => (err && err.message) || String(err));
  return [
    'Staff API auth config refused startup (fail-closed):',
    ...lines.map((line) => `  - ${line}`),
  ].join('\n');
}

/**
 * Validate and exit the process on failure. Never prints secret values.
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @param {{ exit?: boolean, log?: (msg: string) => void }} [options]
 */
function applyStaffAuthConfigOrExit(env, options) {
  const opts = options || {};
  const result = validateStaffAuthConfig(env || process.env);
  if (result.ok) return result;
  const message = formatStaffAuthConfigErrors(result);
  const log = typeof opts.log === 'function' ? opts.log : console.error;
  log(message);
  if (opts.exit === false) {
    const err = new Error(message);
    err.staffAuthConfig = result;
    throw err;
  }
  process.exit(1);
  return result;
}

module.exports = {
  validateStaffAuthConfig,
  formatStaffAuthConfigErrors,
  applyStaffAuthConfigOrExit,
  AUTH_REQUIRED_VAR,
  AUTH_HTTPS_VAR,
  AUTH_ALLOW_OPEN_VAR,
  RUNTIME_PROFILE_VAR,
  BIND_HOST_VAR,
  BOT_TOKEN_VAR,
  MIN_BOT_TOKEN_LENGTH,
};
