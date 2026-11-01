'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SUPERVISOR_EMAIL = 'supervisor@lunafrontdesk.com';
const SUPERVISOR_DISPLAY_NAME = 'Luna Supervisor';
const SUPERVISOR_ROLE = 'admin';
// France Wolfhouse staging's dedicated Staff database; never a generic/legacy shared host.
const APPROVED_STAGING_DB_HOST = 'luna-wolfhouse-staging-pg-app.postgres.database.azure.com';
const APPROVED_STAGING_DB_NAME = 'wolfhouse_staging';
const APPROVED_STAGING_DB_PORT = 5432;
const SAFE_ERROR_CODES = new Set([
  'staging_only', 'wolfhouse_somo_staging_only', 'credential_file_must_be_root_only_path',
  'database_target_invalid', 'credential_file_already_exists', 'credential_cleanup_failed',
  'supervisor_account_exists_refusing_password_reset', 'client_not_found', 'pg_client_required',
]);

function safeProvisioningErrorCode(error) {
  const code = error && typeof error.message === 'string' ? error.message : '';
  return SAFE_ERROR_CODES.has(code) ? code : 'provisioning_failed';
}

function buildStagingPgConfig(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('database_target_invalid');
  let parsed;
  try { parsed = new URL(raw); } catch (_) { throw new Error('database_target_invalid'); }
  const database = parsed.pathname.replace(/^\//, '');
  const blockedOverride = [...parsed.searchParams.keys()].some((key) => /^(host|port|database)$/i.test(key));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || parsed.hostname !== APPROVED_STAGING_DB_HOST
    || parsed.port !== String(APPROVED_STAGING_DB_PORT)
    || database !== APPROVED_STAGING_DB_NAME
    || !parsed.username || !parsed.password
    || blockedOverride) {
    throw new Error('database_target_invalid');
  }
  let user;
  let password;
  try {
    user = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } catch (_) { throw new Error('database_target_invalid'); }
  // Do not pass connectionString: pg lets query-string host/port/database override it.
  // The concrete driver config is the only authority for the destination tuple.
  return Object.freeze({
    host: APPROVED_STAGING_DB_HOST,
    port: APPROVED_STAGING_DB_PORT,
    database: APPROVED_STAGING_DB_NAME,
    user,
    password,
    ssl: Object.freeze({ rejectUnauthorized: true, servername: APPROVED_STAGING_DB_HOST }),
  });
}

function validateStagingDatabaseUrl(value) {
  return buildStagingPgConfig(value);
}

function validateProvisioningInput({ environment, clientSlug, credentialFile } = {}) {
  if (String(environment || '').trim() !== 'staging') throw new Error('staging_only');
  if (String(clientSlug || '').trim() !== 'wolfhouse-somo') throw new Error('wolfhouse_somo_staging_only');
  const output = String(credentialFile || '').trim();
  if (!path.isAbsolute(output) || !output.startsWith('/root/.luna-supervisor/')) throw new Error('credential_file_must_be_root_only_path');
  return { environment: 'staging', clientSlug: 'wolfhouse-somo', credentialFile: output };
}
function generatePassword(randomBytes = crypto.randomBytes) {
  return randomBytes(48).toString('base64url');
}
function hashPassword(password, randomBytes = crypto.randomBytes) {
  const salt = randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash.toString('hex')}`;
}
function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hashHex] = parts;
  try {
    const expected = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, { N: Number(N), r: Number(r), p: Number(p) });
    const actual = Buffer.from(hashHex, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) { return false; }
}
function renderCredentialFile({ staffUserId, password, clientSlug, environment }) {
  return [
    '# Root-only Luna Supervisor credential. Never commit, print, or upload this file.',
    `LUNA_SUPERVISOR_STAFF_USER_ID=${staffUserId}`,
    `LUNA_SUPERVISOR_EMAIL=${SUPERVISOR_EMAIL}`,
    `LUNA_SUPERVISOR_CLIENT=${clientSlug}`,
    `LUNA_SUPERVISOR_ENVIRONMENT=${environment}`,
    `LUNA_SUPERVISOR_PASSWORD=${password}`,
    '',
  ].join('\n');
}
function unlinkOwnedArtifact(fileSystem, file) {
  try { fileSystem.unlinkSync(file); return null; } catch (error) {
    return error && error.code === 'ENOENT' ? null : error;
  }
}

function writeCredentialFileAtomically(target, contents, { fs: fileSystem = fs, randomBytes = crypto.randomBytes } = {}) {
  const directory = path.dirname(target);
  fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fileSystem.chmodSync(directory, 0o700);
  const temp = path.join(directory, `.${path.basename(target)}.${randomBytes(12).toString('hex')}.tmp`);
  let fd;
  let tempOwned = false;
  let targetOwned = false;
  try {
    fd = fileSystem.openSync(temp, 'wx', 0o600); tempOwned = true;
    fileSystem.writeFileSync(fd, contents, 'utf8');
    fileSystem.fsyncSync(fd);
    fileSystem.closeSync(fd); fd = undefined;
    // link(2) is no-replace on the target: never overwrite an existing vault file.
    fileSystem.linkSync(temp, target); targetOwned = true;
    const tempCleanupError = unlinkOwnedArtifact(fileSystem, temp);
    if (tempCleanupError) throw tempCleanupError;
    tempOwned = false;
    fileSystem.chmodSync(target, 0o600);
    return Object.freeze({ targetPublished: true });
  } catch (error) {
    if (fd !== undefined) try { fileSystem.closeSync(fd); } catch (_) {}
    const cleanupErrors = [];
    if (targetOwned) {
      const cleanupError = unlinkOwnedArtifact(fileSystem, target);
      if (cleanupError) cleanupErrors.push(cleanupError);
    }
    if (tempOwned) {
      const cleanupError = unlinkOwnedArtifact(fileSystem, temp);
      if (cleanupError) cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length) throw new Error('credential_cleanup_failed');
    if (error && error.code === 'EEXIST') throw new Error('credential_file_already_exists');
    throw error;
  }
}
async function provisionSupervisorAccount({ pgClient, environment, clientSlug, credentialFile, randomBytes = crypto.randomBytes, fileSystem = fs } = {}) {
  if (!pgClient || typeof pgClient.query !== 'function') throw new Error('pg_client_required');
  const input = validateProvisioningInput({ environment, clientSlug, credentialFile });
  const password = generatePassword(randomBytes);
  const passwordHash = hashPassword(password, randomBytes);
  let credentialPublished = false;
  await pgClient.query('BEGIN');
  try {
    const client = await pgClient.query('SELECT id::text AS id FROM clients WHERE slug = $1 FOR UPDATE', [input.clientSlug]);
    if (!client.rows[0]) throw new Error('client_not_found');
    const existing = await pgClient.query(
      'SELECT id::text AS id FROM staff_users WHERE client_id = $1::uuid AND lower(email) = lower($2) FOR UPDATE',
      [client.rows[0].id, SUPERVISOR_EMAIL]
    );
    if (existing.rows[0]) throw new Error('supervisor_account_exists_refusing_password_reset');
    const inserted = await pgClient.query(
      `INSERT INTO staff_users (client_id, email, display_name, role, status, password_hash)
       VALUES ($1::uuid, $2, $3, $4, 'active', $5) RETURNING id::text AS id`,
      [client.rows[0].id, SUPERVISOR_EMAIL, SUPERVISOR_DISPLAY_NAME, SUPERVISOR_ROLE, passwordHash]
    );
    const contents = renderCredentialFile({ staffUserId: inserted.rows[0].id, password, ...input });
    const publication = writeCredentialFileAtomically(input.credentialFile, contents, { fs: fileSystem, randomBytes });
    credentialPublished = publication.targetPublished;
    await pgClient.query('COMMIT');
    return { staffUserId: inserted.rows[0].id, email: SUPERVISOR_EMAIL, clientSlug: input.clientSlug, environment: input.environment };
  } catch (error) {
    try { await pgClient.query('ROLLBACK'); } catch (_) {}
    if (credentialPublished && unlinkOwnedArtifact(fileSystem, input.credentialFile)) {
      throw new Error('credential_cleanup_failed');
    }
    throw error;
  }
}
module.exports = Object.freeze({
  SUPERVISOR_EMAIL, SUPERVISOR_DISPLAY_NAME, SUPERVISOR_ROLE,
  APPROVED_STAGING_DB_HOST, APPROVED_STAGING_DB_NAME, APPROVED_STAGING_DB_PORT, SAFE_ERROR_CODES,
  safeProvisioningErrorCode, buildStagingPgConfig, validateStagingDatabaseUrl,
  validateProvisioningInput, generatePassword, hashPassword, verifyPassword,
  renderCredentialFile, writeCredentialFileAtomically, provisionSupervisorAccount,
});
