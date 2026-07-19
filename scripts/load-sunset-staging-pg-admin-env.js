'use strict';

/**
 * FOUNDATION Slice 9 — load protected Sunset PG admin credentials into env
 * from Key Vault secret sunset-database-url (user/password only).
 *
 * Never prints the DSN or password. Does not write credentials to disk.
 * Used only to populate SUNSET_STAGING_PG_ADMIN_* for the provisioner.
 */

const { execSync } = require('child_process');
const {
  TARGETS,
  ENV_PG_ADMIN_USER,
  ENV_PG_ADMIN_PASSWORD,
} = require('./lib/sunset-schema-observer-role-provision');
const { parseDatabaseUrl } = require('./lib/sunset-schema-observer');

function azPath() {
  if (process.platform === 'win32') {
    return '"C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd"';
  }
  return 'az';
}

function loadAdminEnvFromExistingAppDsn() {
  let out;
  try {
    out = execSync(
      `${azPath()} keyvault secret show --vault-name ${TARGETS.keyVault} --name sunset-database-url --subscription ${TARGETS.subscriptionId} -o json`,
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (_) {
    throw new Error('failed to read sunset-database-url for admin bootstrap');
  }
  const j = JSON.parse(String(out).replace(/^\uFEFF/, '').trim());
  const parsed = parseDatabaseUrl(String(j.value || ''));
  if (!parsed.ok || !parsed.parsed.user || !parsed.parsed.hasPassword) {
    throw new Error('sunset-database-url is not a usable admin DSN shape');
  }
  if (parsed.parsed.host !== TARGETS.postgresHost) {
    throw new Error('sunset-database-url host is not locked Sunset staging host');
  }
  if (parsed.parsed.database !== TARGETS.database) {
    throw new Error('sunset-database-url database is not sunset_staging');
  }
  const url = new URL(String(j.value));
  process.env[ENV_PG_ADMIN_USER] = decodeURIComponent(url.username || '');
  process.env[ENV_PG_ADMIN_PASSWORD] = decodeURIComponent(url.password || '');
  process.env.AZURE_SUBSCRIPTION_ID = TARGETS.subscriptionId;
  return {
    userSet: Boolean(process.env[ENV_PG_ADMIN_USER]),
    passwordSet: Boolean(process.env[ENV_PG_ADMIN_PASSWORD]),
    host: TARGETS.postgresHost,
    database: TARGETS.database,
  };
}

module.exports = { loadAdminEnvFromExistingAppDsn };

if (require.main === module) {
  try {
    const meta = loadAdminEnvFromExistingAppDsn();
    console.log(JSON.stringify({
      ok: true,
      userSet: meta.userSet,
      passwordSet: meta.passwordSet,
      host: meta.host,
      database: meta.database,
    }));
  } catch (err) {
    console.error('load failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
}
