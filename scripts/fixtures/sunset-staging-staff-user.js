'use strict';

/**
 * One-off Sunset staging staff login user (guarded).
 *
 *   ALLOW_SUNSET_STAFF_USER_SEED=1 \
 *   SUNSET_STAFF_EMAIL=you@example.com \
 *   SUNSET_STAFF_PASSWORD=... \
 *   WOLFHOUSE_DATABASE_URL=postgres://... \
 *   node scripts/fixtures/sunset-staging-staff-user.js
 *
 * Fail-closed: only luna-sunset-staging-pg-app / sunset_staging.
 * Never logs password or password_hash.
 */

const crypto = require('crypto');
const readline = require('readline');
const { withPgClient } = require('../lib/pg-connect');

const ALLOW_ENV_KEY = 'ALLOW_SUNSET_STAFF_USER_SEED';
const APPROVED_HOST = 'luna-sunset-staging-pg-app.postgres.database.azure.com';
const APPROVED_DB = 'sunset_staging';
const CLIENT_SLUG = 'sunset';
const STAFF_USER_SOURCE = 'sunset_staging_staff_user';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

const BLOCKED_URL_PATTERNS = [
  /wolfhouse/i,
  /wh-staging/i,
  /production/i,
  /(^|[-_.])prod([-.]|$)/i,
  /\.prod\./i,
  /wolfhouse_staging/i,
  /staff-staging\.lunafrontdesk/i,
];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash.toString('hex')}`;
}

function parseDatabaseTarget(connectionString) {
  const url = String(connectionString || '').trim();
  if (!url) {
    throw new Error('WOLFHOUSE_DATABASE_URL (or DATABASE_URL) is required');
  }

  for (const pattern of BLOCKED_URL_PATTERNS) {
    if (pattern.test(url)) {
      throw new Error(`database URL rejected by fail-closed guard (${pattern})`);
    }
  }

  let host;
  let database;
  try {
    const normalized = url.replace(/^postgres(ql)?:\/\//i, 'http://');
    const parsed = new URL(normalized);
    host = parsed.hostname;
    database = parsed.pathname.replace(/^\//, '').split('?')[0];
  } catch {
    throw new Error('could not parse database URL');
  }

  if (host !== APPROVED_HOST) {
    throw new Error(`database host must be ${APPROVED_HOST} (got ${host})`);
  }
  if (database !== APPROVED_DB) {
    throw new Error(`database name must be ${APPROVED_DB} (got ${database})`);
  }

  return { host, database };
}

function assertEnvGates() {
  if (process.env[ALLOW_ENV_KEY] !== '1') {
    throw new Error(`${ALLOW_ENV_KEY}=1 is required`);
  }
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new Error('NODE_ENV=production is not allowed');
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function redactEmail(email) {
  const e = normalizeEmail(email);
  const at = e.indexOf('@');
  if (at <= 1) return '***';
  return `${e[0]}***${e.slice(at)}`;
}

async function readPasswordFromPrompt() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question('SUNSET_STAFF_PASSWORD: ', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function resolvePassword() {
  const fromEnv = String(process.env.SUNSET_STAFF_PASSWORD || '');
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    throw new Error('SUNSET_STAFF_PASSWORD is required when stdin is not a TTY');
  }
  return readPasswordFromPrompt();
}

async function upsertStaffUser(pg, { email, passwordHash, displayName }) {
  const clientRes = await pg.query(
    'SELECT id::text AS id, slug FROM clients WHERE slug = $1 LIMIT 1',
    [CLIENT_SLUG],
  );
  if (clientRes.rows.length === 0) {
    throw new Error(`clients.slug=${CLIENT_SLUG} not found`);
  }
  const clientId = clientRes.rows[0].id;

  const existing = await pg.query(
    `SELECT id::text AS id
       FROM staff_users
      WHERE client_id = $1::uuid
        AND lower(email) = $2
      LIMIT 1`,
    [clientId, email],
  );

  const metadata = JSON.stringify({
    source: STAFF_USER_SOURCE,
    purpose: 'sunset_staging_portal_smoke',
    not_demo_seed: true,
  });

  let userId;
  let action;
  if (existing.rows.length > 0) {
    userId = existing.rows[0].id;
    action = 'updated';
    await pg.query(
      `UPDATE staff_users
          SET password_hash = $1,
              role = 'owner',
              status = 'active',
              display_name = COALESCE($2, display_name),
              disabled_at = NULL,
              metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
              updated_at = NOW()
        WHERE id = $4::uuid`,
      [passwordHash, displayName, metadata, userId],
    );
  } else {
    const ins = await pg.query(
      `INSERT INTO staff_users
         (client_id, email, display_name, role, password_hash, status, metadata)
       VALUES ($1::uuid, $2, $3, 'owner', $4, 'active', $5::jsonb)
       RETURNING id::text AS id`,
      [clientId, email, displayName, passwordHash, metadata],
    );
    userId = ins.rows[0].id;
    action = 'created';
  }

  return {
    action,
    userId,
    clientId,
    clientSlug: CLIENT_SLUG,
    email,
  };
}

async function main() {
  assertEnvGates();

  const email = normalizeEmail(process.env.SUNSET_STAFF_EMAIL);
  if (!email || !email.includes('@')) {
    throw new Error('SUNSET_STAFF_EMAIL is required');
  }

  const password = await resolvePassword();
  if (!password || password.length < 12) {
    throw new Error('password must be at least 12 characters');
  }

  const target = parseDatabaseTarget(
    process.env.WOLFHOUSE_DATABASE_URL || process.env.DATABASE_URL,
  );

  const passwordHash = hashPassword(password);

  const result = await withPgClient(async (pg) => {
    const row = await upsertStaffUser(pg, {
      email,
      passwordHash,
      displayName: 'Sunset Staging Portal',
    });

    const verify = await pg.query(
      `SELECT su.id::text AS id,
              su.email,
              su.role,
              su.status,
              c.slug AS client_slug
         FROM staff_users su
         JOIN clients c ON c.id = su.client_id
        WHERE su.id = $1::uuid`,
      [row.userId],
    );

    return { ...row, verify: verify.rows[0] };
  });

  console.log(JSON.stringify({
    ok: true,
    action: result.action,
    user_id: result.userId,
    email_redacted: redactEmail(result.email),
    client_slug: result.clientSlug,
    client_scope: CLIENT_SLUG,
    all_clients_grant: false,
    login_row_exists: !!result.verify,
    db_host: target.host,
    db_name: target.database,
  }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
