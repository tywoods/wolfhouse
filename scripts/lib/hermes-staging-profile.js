'use strict';

/**
 * Hermes Agent staging profile — Container App env (non-secrets).
 * Secrets go in Key Vault → Container App secret refs.
 */

const HERMES_STAGING_V1 = Object.freeze({
  HERMES_HOME: '/opt/data',
  // Dashboard spawns extra processes that contend on SQLite; disable on ACA until NFS persistence.
  HERMES_DASHBOARD: '0',
  API_SERVER_ENABLED: 'true',
  API_SERVER_HOST: '0.0.0.0',
  GENERIC_TIMEZONE: 'Europe/Madrid',
  HERMES_MODEL: 'gpt-4o-mini',
  HERMES_INFERENCE_MODEL: 'gpt-4o-mini',
  OPENAI_MODEL: 'gpt-4o-mini',
  WOLFHOUSE_STAFF_API_BASE_URL: 'https://staff-staging.lunafrontdesk.com',
});

const HERMES_STAGING_V1_LABEL = 'hermes-staging-v1';

function applyHermesStagingProfile(baseEnv, profile) {
  const p = profile || HERMES_STAGING_V1;
  return { ...(baseEnv || process.env), ...p };
}

module.exports = {
  HERMES_STAGING_V1,
  HERMES_STAGING_V1_LABEL,
  applyHermesStagingProfile,
};
