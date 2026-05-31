'use strict';
/**
 * Stage 7.2b — Staff auth migration static verifier (NO DB connection).
 *
 * Reads database/migrations/009_auth_staff_users.sql and verifies:
 *   0. Migration file 009_auth_staff_users.sql exists.
 *   1. Transaction wrapping (BEGIN/COMMIT).
 *   2. staff_users and auth_sessions tables defined (CREATE TABLE IF NOT EXISTS).
 *   3. Required columns on staff_users.
 *   4. Required columns on auth_sessions.
 *   5. role CHECK constraint includes required values.
 *   6. status CHECK constraint includes required values.
 *   7. FK references: staff_users → clients; auth_sessions → staff_users; auth_sessions → clients.
 *   8. Required indexes present (including unique and partial indexes).
 *   9. set_updated_at triggers present on both tables.
 *  10. No destructive operations (DROP TABLE, TRUNCATE, ALTER … DROP, DROP INDEX).
 *  11. Idempotency: IF NOT EXISTS used for all tables and indexes.
 *  12. No seed users / no plain-text passwords / no INSERT rows.
 *  13. Filename is 009_auth_staff_users.sql (correct migration number).
 *  14. Partial-index NOW() deferral documented in comments (Postgres immutability constraint).
 *  15. multi-client join table deferral documented.
 *
 * Usage:
 *   node scripts/verify-auth-staff-migration.js
 *
 * Exit 0 = all checks pass. Exit 1 = at least one failure.
 */

const fs   = require('fs');
const path = require('path');

const MIGRATION_FILE = path.join(__dirname, '..', 'database', 'migrations', '009_auth_staff_users.sql');
const EXPECTED_FILENAME = '009_auth_staff_users.sql';

let failures = 0;
function ok(label)              { console.log(`  ✓ ${label}`); }
function fail(label, detail)    { console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`); failures++; }
function check(cond, pass, fail2, detail) {
  if (cond) ok(pass); else fail(fail2 || pass, detail);
}

// ── 0. File + filename ───────────────────────────────────────────────────────
console.log('\n── 0. Migration file ──');
check(
  path.basename(MIGRATION_FILE) === EXPECTED_FILENAME,
  `filename is ${EXPECTED_FILENAME}`
);
let sql;
try {
  sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
  ok(`${EXPECTED_FILENAME} exists (${sql.length} chars)`);
} catch (e) {
  fail(`${EXPECTED_FILENAME} exists`, e.message);
  process.exit(1);
}

// ── 1. Transaction ────────────────────────────────────────────────────────────
console.log('\n── 1. Transaction ──');
check(/^\s*BEGIN\s*;/m.test(sql), 'starts with BEGIN;');
check(/COMMIT\s*;/m.test(sql), 'ends with COMMIT;');

// ── 2. Table definitions ──────────────────────────────────────────────────────
console.log('\n── 2. Table definitions ──');
const REQUIRED_TABLES = ['staff_users', 'auth_sessions'];
for (const table of REQUIRED_TABLES) {
  check(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(sql),
    `CREATE TABLE IF NOT EXISTS ${table}`
  );
}

// ── 3. staff_users columns ────────────────────────────────────────────────────
console.log('\n── 3. staff_users columns ──');
const STAFF_USER_COLS = [
  'id', 'client_id', 'email', 'display_name', 'role',
  'password_hash', 'status', 'last_login_at', 'disabled_at',
  'metadata', 'created_at', 'updated_at',
];
for (const col of STAFF_USER_COLS) {
  check(
    new RegExp(`\\b${col}\\b`).test(sql),
    `staff_users: column ${col} present`
  );
}

// ── 4. auth_sessions columns ──────────────────────────────────────────────────
console.log('\n── 4. auth_sessions columns ──');
const SESSION_COLS = [
  'id', 'staff_user_id', 'client_id', 'session_token_hash',
  'expires_at', 'revoked_at', 'last_seen_at',
  'ip_hash', 'user_agent_hash', 'created_at', 'updated_at',
];
for (const col of SESSION_COLS) {
  check(
    new RegExp(`\\b${col}\\b`).test(sql),
    `auth_sessions: column ${col} present`
  );
}

// ── 5. role CHECK constraint ──────────────────────────────────────────────────
console.log('\n── 5. role CHECK constraint ──');
const REQUIRED_ROLES = ['viewer', 'operator', 'admin'];
for (const role of REQUIRED_ROLES) {
  check(
    new RegExp(`CHECK\\s*\\([^)]*role[^)]*'${role}'`, 'i').test(sql) ||
    new RegExp(`'${role}'[^)]*\\)`).test(sql),
    `role CHECK includes '${role}'`
  );
}
check(
  /CHECK\s*\(\s*role\s+IN\s*\(/i.test(sql),
  'role uses CHECK … IN (…) syntax'
);

// ── 6. status CHECK constraint ────────────────────────────────────────────────
console.log('\n── 6. status CHECK constraint ──');
const REQUIRED_STATUSES = ['active', 'invited', 'disabled'];
for (const s of REQUIRED_STATUSES) {
  check(
    new RegExp(`'${s}'`).test(sql),
    `status CHECK includes '${s}'`
  );
}
check(
  /CHECK\s*\(\s*status\s+IN\s*\(/i.test(sql),
  'status uses CHECK … IN (…) syntax'
);

// ── 7. FK references ──────────────────────────────────────────────────────────
console.log('\n── 7. FK references ──');
const FK_CHECKS = [
  ['staff_users → clients(id)',       /staff_users[\s\S]{1,600}REFERENCES clients\s*\(id\)/i],
  ['auth_sessions → staff_users(id)', /REFERENCES staff_users\s*\(id\)/i],
  ['auth_sessions → clients(id)',     /auth_sessions[\s\S]{1,600}REFERENCES clients\s*\(id\)/i],
];
for (const [label, pattern] of FK_CHECKS) {
  check(pattern.test(sql), `FK: ${label}`);
}

// ── 8. Indexes ────────────────────────────────────────────────────────────────
console.log('\n── 8. Indexes ──');
const REQUIRED_INDEXES = [
  'uq_staff_users_client_email',
  'idx_staff_users_client',
  'idx_staff_users_email',
  'idx_staff_users_role',
  'idx_staff_users_status',
  'idx_staff_users_active',
  'uq_auth_sessions_token_hash',
  'idx_auth_sessions_staff_user',
  'idx_auth_sessions_client',
  'idx_auth_sessions_expires_at',
  'idx_auth_sessions_revoked_at',
  'idx_auth_sessions_user_active',
];
for (const idx of REQUIRED_INDEXES) {
  check(sql.includes(idx), `index ${idx} present`);
}
// Unique lower(email) functional index
check(
  /uq_staff_users_client_email[\s\S]{1,200}lower\s*\(\s*email\s*\)/i.test(sql),
  'uq_staff_users_client_email uses lower(email) function'
);
// Partial index on active users
check(
  /idx_staff_users_active[\s\S]{1,200}WHERE\s+status\s*=\s*'active'/i.test(sql),
  "idx_staff_users_active has WHERE status = 'active'"
);
// Partial index on unrevoked sessions
check(
  /idx_auth_sessions_revoked_at[\s\S]{1,200}WHERE\s+revoked_at\s+IS\s+NULL/i.test(sql),
  'idx_auth_sessions_revoked_at has WHERE revoked_at IS NULL'
);
check(
  /idx_auth_sessions_user_active[\s\S]{1,200}WHERE\s+revoked_at\s+IS\s+NULL/i.test(sql),
  'idx_auth_sessions_user_active has WHERE revoked_at IS NULL'
);

// ── 9. Triggers ───────────────────────────────────────────────────────────────
console.log('\n── 9. Triggers (set_updated_at) ──');
for (const table of REQUIRED_TABLES) {
  check(
    new RegExp(
      `CREATE TRIGGER [\\w_]+_updated_at[\\s\\S]{1,200}ON ${table}\\b`,
      'i'
    ).test(sql),
    `set_updated_at trigger on ${table}`
  );
}

// ── 10. No destructive operations ─────────────────────────────────────────────
console.log('\n── 10. Safety: no destructive operations ──');
const DESTRUCTIVE = [
  [/\bDROP TABLE\b/i,           'DROP TABLE'],
  [/\bTRUNCATE\b/i,             'TRUNCATE'],
  [/\bALTER TABLE\b.*\bDROP\b/i,'ALTER TABLE … DROP'],
  [/\bDROP INDEX\b/i,           'DROP INDEX'],
];
for (const [pattern, label] of DESTRUCTIVE) {
  check(!pattern.test(sql), `no ${label}`, `found destructive operation: ${label}`);
}

// ── 11. Idempotency ───────────────────────────────────────────────────────────
console.log('\n── 11. Idempotency ──');
const ifNotExistsCount = (sql.match(/IF NOT EXISTS/gi) || []).length;
// 2 tables + all indexes = at least 14
check(
  ifNotExistsCount >= 14,
  `IF NOT EXISTS used throughout (found ${ifNotExistsCount})`
);

// ── 12. No seed rows / no plain-text secrets ──────────────────────────────────
console.log('\n── 12. No seed rows / no plain-text secrets ──');
check(
  !/\bINSERT\s+INTO\b/i.test(sql),
  'no INSERT INTO (no seed users)'
);
check(
  !/password\s*=\s*'[^']+'/i.test(sql),
  'no plain-text password assignment'
);
// Ensure any password_hash references are column definitions, not values
check(
  !/password_hash\s*=\s*'[^']+'/i.test(sql),
  'no hard-coded password_hash value'
);

// ── 13. Filename correct ──────────────────────────────────────────────────────
console.log('\n── 13. Migration number ──');
check(
  /^009_/.test(path.basename(MIGRATION_FILE)),
  'filename starts with 009_'
);

// ── 14. NOW() partial-index deferral documented ───────────────────────────────
console.log('\n── 14. NOW() deferral comment ──');
check(
  /NOW\(\).*immutab|immutab.*NOW\(\)/i.test(sql),
  'comment explaining why NOW() cannot be used in partial index predicate'
);

// ── 15. Multi-client join table deferral documented ───────────────────────────
console.log('\n── 15. Multi-client deferral comment ──');
check(
  /staff_user_client_access/i.test(sql),
  'comment referencing deferred staff_user_client_access table'
);

// ── Result ───────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
if (failures === 0) {
  console.log('Result: PASS — all checks green (0 failures)');
  process.exit(0);
} else {
  console.error(`Result: FAIL — ${failures} check(s) failed`);
  process.exit(1);
}
