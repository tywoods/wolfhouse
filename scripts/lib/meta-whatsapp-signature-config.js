'use strict';

/**
 * FORTRESS 15L — Meta WhatsApp hub signature / verify-token config (fail-closed).
 *
 * Pure validator — no Staff API monolith import, no network, no secret values logged.
 * Staging/production profiles require META_APP_SECRET + META_WHATSAPP_VERIFY_TOKEN
 * and refuse META_WEBHOOK_SKIP_VERIFY=true. Local/test may skip verify only when
 * META_WEBHOOK_SKIP_VERIFY is exactly 'true'.
 */

const LOCAL_TEST_PROFILES = new Set(['development', 'dev', 'test', 'local']);
const STAGING_OR_PROD_PROFILES = new Set(['staging', 'production', 'prod']);

const META_APP_SECRET_VAR = 'META_APP_SECRET';
const META_VERIFY_TOKEN_VAR = 'META_WHATSAPP_VERIFY_TOKEN';
const META_SKIP_VERIFY_VAR = 'META_WEBHOOK_SKIP_VERIFY';
const RUNTIME_PROFILE_VAR = 'STAFF_RUNTIME_PROFILE';
const NODE_ENV_VAR = 'NODE_ENV';

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

function isMetaWebhookSkipVerify(env) {
  return asTrimmedString(rawEnv(env, META_SKIP_VERIFY_VAR)) === 'true';
}

function pushError(errors, variable, message) {
  errors.push({ variable, message: `${variable}: ${message}` });
}

/**
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @returns {{
 *   ok: boolean,
 *   runtimeProfile: string,
 *   localTestProfile: boolean,
 *   stagingOrProduction: boolean,
 *   skipVerify: boolean,
 *   metaAppSecretConfigured: boolean,
 *   metaVerifyTokenConfigured: boolean,
 *   errors: Array<{ variable: string, message: string }>,
 * }}
 */
function validateMetaWhatsAppSignatureConfig(env) {
  const e = env || {};
  const errors = [];
  const runtimeProfile = resolveRuntimeProfile(e);
  const localTestProfile = isLocalTestProfile(runtimeProfile);
  const stagingOrProduction = isStagingOrProductionProfile(runtimeProfile);
  const skipVerify = isMetaWebhookSkipVerify(e);
  const appSecret = asTrimmedString(rawEnv(e, META_APP_SECRET_VAR)) || '';
  const verifyToken = asTrimmedString(rawEnv(e, META_VERIFY_TOKEN_VAR)) || '';

  if (skipVerify && stagingOrProduction) {
    pushError(
      errors,
      META_SKIP_VERIFY_VAR,
      'must not be true under staging/production profiles (local/test only)',
    );
  }
  if (skipVerify && !localTestProfile && !stagingOrProduction) {
    // Unknown/empty profile with skip requested — refuse (fail closed).
    pushError(
      errors,
      META_SKIP_VERIFY_VAR,
      'requires an explicit local/test runtime profile (development|dev|test|local)',
    );
  }
  if (stagingOrProduction) {
    if (!appSecret) {
      pushError(errors, META_APP_SECRET_VAR, 'required for staging/production Meta webhook HMAC');
    }
    if (!verifyToken) {
      pushError(
        errors,
        META_VERIFY_TOKEN_VAR,
        'required for staging/production Meta hub verify (no hardcoded default)',
      );
    }
  }

  return {
    ok: errors.length === 0,
    runtimeProfile,
    localTestProfile,
    stagingOrProduction,
    skipVerify,
    metaAppSecretConfigured: appSecret.length > 0,
    metaVerifyTokenConfigured: verifyToken.length > 0,
    errors,
  };
}

function formatMetaWhatsAppSignatureConfigErrors(result) {
  const lines = (result && result.errors ? result.errors : [])
    .map((err) => (err && err.message) || String(err));
  return [
    'Staff API Meta WhatsApp signature config refused startup (fail-closed):',
    ...lines.map((line) => `  - ${line}`),
  ].join('\n');
}

/**
 * Validate and exit the process on failure. Never prints secret values.
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @param {{ exit?: boolean, log?: (msg: string) => void }} [options]
 */
function applyMetaWhatsAppSignatureConfigOrExit(env, options) {
  const opts = options || {};
  const result = validateMetaWhatsAppSignatureConfig(env || process.env);
  if (result.ok) return result;
  const message = formatMetaWhatsAppSignatureConfigErrors(result);
  const log = typeof opts.log === 'function' ? opts.log : console.error;
  log(message);
  if (opts.exit === false) {
    const err = new Error(message);
    err.metaWhatsAppSignatureConfig = result;
    throw err;
  }
  process.exit(1);
  return result;
}

/**
 * HTTP admit decision for Meta POST after verifyMetaHubSignature256.
 * Admit only when verified:true, or when skip-verify is explicitly true
 * (startup already refused skip under staging/production).
 *
 * @returns {{
 *   admit: boolean,
 *   status: number,
 *   error: string|null,
 *   skipped: boolean,
 * }}
 */
function decideMetaWhatsAppWebhookPostAdmit(sigResult, env) {
  const skip = isMetaWebhookSkipVerify(env || process.env);
  if (skip) {
    return {
      admit: true,
      status: 200,
      error: null,
      skipped: true,
    };
  }
  if (sigResult && sigResult.verified === true) {
    return {
      admit: true,
      status: 200,
      error: null,
      skipped: false,
    };
  }
  const error = (sigResult && sigResult.error) || 'signature_verification_failed';
  const status = error === 'app_secret_unconfigured' ? 503 : 403;
  return {
    admit: false,
    status,
    error,
    skipped: false,
  };
}

module.exports = {
  validateMetaWhatsAppSignatureConfig,
  formatMetaWhatsAppSignatureConfigErrors,
  applyMetaWhatsAppSignatureConfigOrExit,
  decideMetaWhatsAppWebhookPostAdmit,
  isMetaWebhookSkipVerify,
  resolveRuntimeProfile,
  isLocalTestProfile,
  isStagingOrProductionProfile,
  META_APP_SECRET_VAR,
  META_VERIFY_TOKEN_VAR,
  META_SKIP_VERIFY_VAR,
};
