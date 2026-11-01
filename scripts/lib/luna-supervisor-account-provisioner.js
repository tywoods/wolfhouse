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

function validateProvisioningInput({ environment, clientSlug, credentialFile } = {}) {
  if (String(environment || '').trim() !== 'staging') throw new Error('staging_only');
  if (String(clientSlug || '').trim() !== 'wolfhouse') throw new Error('wolfhouse_staging_only');
  const output = String(credentialFile || '').trim();
  if (!path.isAbsolute(output) || !output.startsWith('/root/.luna-supervisor/')) throw new Error('credential_file_must_be_root_only_path');
  return { environment: 'staging', clientSlug: 'wolfhouse', credentialFile: output };
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
function writeCredentialFileAtomically(target, contents, { fs: fileSystem = fs, randomBytes = crypto.randomBytes } = {}) {
  const directory = path.dirname(target);
  fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fileSystem.chmodSync(directory, 0o700);
  const temp = path.join(directory, `.${path.basename(target)}.${randomBytes(12).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fileSystem.openSync(temp, 'wx', 0o600);
    fileSystem.writeFileSync(fd, contents, 'utf8');
    fileSystem.fsyncSync(fd);
    fileSystem.closeSync(fd); fd = undefined;
    // link(2) is no-replace on the target: never overwrite an existing vault file.
    fileSystem.linkSync(temp, target);
    fileSystem.unlinkSync(temp);
    fileSystem.chmodSync(target, 0o600);
  } catch (error) {
    if (fd !== undefined) try { fileSystem.closeSync(fd); } catch (_) {}
    try { fileSystem.unlinkSync(temp); } catch (_) {}
    if (error && error.code === 'EEXIST') throw new Error('credential_file_already_exists');
    throw error;
  }
}
async function provisionSupervisorAccount({ pgClient, environment, clientSlug, credentialFile, randomBytes = crypto.randomBytes, fileSystem = fs } = {}) {
  if (!pgClient || typeof pgClient.query !== 'function') throw new Error('pg_client_required');
  const input = validateProvisioningInput({ environment, clientSlug, credentialFile });
  const password = generatePassword(randomBytes);
  const passwordHash = hashPassword(password, randomBytes);
  let credentialWritten = false;
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
    writeCredentialFileAtomically(input.credentialFile, contents, { fs: fileSystem, randomBytes });
    credentialWritten = true;
    await pgClient.query('COMMIT');
    return { staffUserId: inserted.rows[0].id, email: SUPERVISOR_EMAIL, clientSlug: input.clientSlug, environment: input.environment };
  } catch (error) {
    try { await pgClient.query('ROLLBACK'); } catch (_) {}
    if (credentialWritten) try { fileSystem.unlinkSync(input.credentialFile); } catch (_) {}
    throw error;
  }
}
module.exports = Object.freeze({
  SUPERVISOR_EMAIL, SUPERVISOR_DISPLAY_NAME, SUPERVISOR_ROLE,
  validateProvisioningInput, generatePassword, hashPassword, verifyPassword,
  renderCredentialFile, writeCredentialFileAtomically, provisionSupervisorAccount,
});
