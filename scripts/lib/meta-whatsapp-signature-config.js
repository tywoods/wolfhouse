'use strict';

/**
 * FORTRESS 15L — Meta WhatsApp hub signature / verify-token config (fail-closed).
 *
 * Pure validator — no Staff API monolith import, no network, no secret values logged.
 *
 * Runtime profile classification checks BOTH NODE_ENV and STAFF_RUNTIME_PROFILE:
 * - if either indicates staging/production → require Meta secrets and refuse skip
 * - contradictory signals refuse startup (never classify down to preview/ci/local)
 * - unknown/empty profiles remain fail-closed for skip
 * - explicit local/test requires consistent local/test signals
 */

const LOCAL_TEST_PROFILES = new Set(['development', 'dev', 'test', 'local']);
const STAGING_OR_PROD_PROFILES = new Set(['staging', 'production', 'prod']);

const META_APP_SECRET_VAR = 'META_APP_SECRET';
const META_VERIFY_TOKEN_VAR = 'META_WHATSAPP_VERIFY_TOKEN';
const META_SKIP_VERIFY_VAR = 'META_WEBHOOK_SKIP_VERIFY';
const RUNTIME_PROFILE_VAR = 'STAFF_RUNTIME_PROFILE';
const NODE_ENV_VAR = 'NODE_ENV';

/** Frozen external POST failure strings (detailed codes stay on admit.error / audit). */
const EXTERNAL_POST_UNAVAILABLE = 'signature_verification_unavailable';
const EXTERNAL_POST_FAILED = 'signature_verification_failed';
/** Frozen external GET failure string (detailed codes stay on verifyMetaHubChallenge). */
const EXTERNAL_GET_FAILED = 'hub_verify_failed';

function rawEnv(env, key) {
  if (!env || !Object.prototype.hasOwnProperty.call(env, key)) return undefined;
  return env[key];
}

function asTrimmedString(value) {
  if (value === undefined || value === null) return null;
  return String(value).trim();
}

/**
 * Classify one env signal into a fail-closed kind.
 * @returns {{ kind: 'empty'|'local_test'|'staging_or_production'|'unknown', value: string }}
 */
function classifyRuntimeSignal(raw) {
  const trimmed = asTrimmedString(raw);
  if (!trimmed) return { kind: 'empty', value: '' };
  const value = trimmed.toLowerCase();
  if (LOCAL_TEST_PROFILES.has(value)) return { kind: 'local_test', value };
  if (STAGING_OR_PROD_PROFILES.has(value)) return { kind: 'staging_or_production', value };
  return { kind: 'unknown', value };
}

/**
 * Prefer explicit STAFF_RUNTIME_PROFILE, else NODE_ENV (reporting only).
 * Admission / startup use classifyRuntimeSignals — never trust this alone.
 */
function resolveRuntimeProfile(env) {
  const explicit = asTrimmedString(rawEnv(env, RUNTIME_PROFILE_VAR));
  if (explicit) return explicit.toLowerCase();
  const nodeEnv = asTrimmedString(rawEnv(env, NODE_ENV_VAR));
  if (nodeEnv) return nodeEnv.toLowerCase();
  return '';
}

/**
 * Fail-closed classification across NODE_ENV + STAFF_RUNTIME_PROFILE.
 * @returns {{
 *   runtimeProfile: string,
 *   nodeEnvSignal: { kind: string, value: string },
 *   staffProfileSignal: { kind: string, value: string },
 *   localTestProfile: boolean,
 *   stagingOrProduction: boolean,
 *   contradictory: boolean,
 *   unknownProfile: boolean,
 * }}
 */
function classifyRuntimeSignals(env) {
  const e = env || {};
  const nodeEnvSignal = classifyRuntimeSignal(rawEnv(e, NODE_ENV_VAR));
  const staffProfileSignal = classifyRuntimeSignal(rawEnv(e, RUNTIME_PROFILE_VAR));
  const present = [nodeEnvSignal, staffProfileSignal].filter((s) => s.kind !== 'empty');
  const kinds = new Set(present.map((s) => s.kind));

  const stagingOrProduction = present.some((s) => s.kind === 'staging_or_production')
    || nodeEnvSignal.kind === 'staging_or_production'
    || staffProfileSignal.kind === 'staging_or_production';

  // Distinct non-empty kinds (e.g. production+test, staging+preview, test+ci) refuse.
  const contradictory = kinds.size > 1;

  const localTestProfile = !contradictory
    && present.length > 0
    && present.every((s) => s.kind === 'local_test');

  const unknownProfile = !stagingOrProduction
    && !localTestProfile
    && (present.length === 0 || present.some((s) => s.kind === 'unknown'));

  return {
    runtimeProfile: resolveRuntimeProfile(e),
    nodeEnvSignal,
    staffProfileSignal,
    localTestProfile,
    stagingOrProduction,
    contradictory,
    unknownProfile,
  };
}

function isLocalTestProfile(profile) {
  return LOCAL_TEST_PROFILES.has(String(profile || '').toLowerCase());
}

function isStagingOrProductionProfile(profile) {
  return STAGING_OR_PROD_PROFILES.has(String(profile || '').toLowerCase());
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
 *   contradictory: boolean,
 *   unknownProfile: boolean,
 *   skipVerify: boolean,
 *   metaAppSecretConfigured: boolean,
 *   metaVerifyTokenConfigured: boolean,
 *   errors: Array<{ variable: string, message: string }>,
 * }}
 */
function validateMetaWhatsAppSignatureConfig(env) {
  const e = env || {};
  const errors = [];
  const classified = classifyRuntimeSignals(e);
  const {
    runtimeProfile,
    localTestProfile,
    stagingOrProduction,
    contradictory,
    unknownProfile,
  } = classified;
  const skipVerify = isMetaWebhookSkipVerify(e);
  const appSecret = asTrimmedString(rawEnv(e, META_APP_SECRET_VAR)) || '';
  const verifyToken = asTrimmedString(rawEnv(e, META_VERIFY_TOKEN_VAR)) || '';

  if (contradictory) {
    pushError(
      errors,
      RUNTIME_PROFILE_VAR,
      `contradictory ${NODE_ENV_VAR}/${RUNTIME_PROFILE_VAR} signals refuse startup `
        + '(cannot classify down to preview/ci/local when another signal is stronger or divergent)',
    );
  }

  // Either signal staging/production → secrets required + skip refused.
  if (skipVerify && stagingOrProduction) {
    pushError(
      errors,
      META_SKIP_VERIFY_VAR,
      'must not be true when NODE_ENV or STAFF_RUNTIME_PROFILE is staging/production',
    );
  } else if (skipVerify && !localTestProfile) {
    // Unknown/empty/contradictory — refuse skip (fail closed).
    pushError(
      errors,
      META_SKIP_VERIFY_VAR,
      'requires consistent explicit local/test signals on NODE_ENV and STAFF_RUNTIME_PROFILE '
        + '(development|dev|test|local); unknown/preview/ci/empty refuse skip',
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
    contradictory,
    unknownProfile,
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
 * Map admit status → frozen external error string (15K-compatible status semantics).
 * Detailed codes remain on `error` for audit/internal use only.
 */
function externalMetaWhatsAppPostFailureError(status) {
  return status === 503 ? EXTERNAL_POST_UNAVAILABLE : EXTERNAL_POST_FAILED;
}

/**
 * HTTP admit decision for Meta POST after verifyMetaHubSignature256.
 * Admit only when verified:true, or when skip-verify is explicitly true
 * (startup already refused skip under staging/production / unknown / contradiction).
 *
 * @returns {{
 *   admit: boolean,
 *   status: number,
 *   error: string|null,
 *   external_error: string|null,
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
      external_error: null,
      skipped: true,
    };
  }
  if (sigResult && sigResult.verified === true) {
    return {
      admit: true,
      status: 200,
      error: null,
      external_error: null,
      skipped: false,
    };
  }
  const error = (sigResult && sigResult.error) || 'signature_verification_failed';
  const status = error === 'app_secret_unconfigured' ? 503 : 403;
  return {
    admit: false,
    status,
    error,
    external_error: externalMetaWhatsAppPostFailureError(status),
    skipped: false,
  };
}

module.exports = {
  validateMetaWhatsAppSignatureConfig,
  formatMetaWhatsAppSignatureConfigErrors,
  applyMetaWhatsAppSignatureConfigOrExit,
  decideMetaWhatsAppWebhookPostAdmit,
  externalMetaWhatsAppPostFailureError,
  classifyRuntimeSignals,
  classifyRuntimeSignal,
  isMetaWebhookSkipVerify,
  resolveRuntimeProfile,
  isLocalTestProfile,
  isStagingOrProductionProfile,
  META_APP_SECRET_VAR,
  META_VERIFY_TOKEN_VAR,
  META_SKIP_VERIFY_VAR,
  EXTERNAL_POST_UNAVAILABLE,
  EXTERNAL_POST_FAILED,
  EXTERNAL_GET_FAILED,
};
