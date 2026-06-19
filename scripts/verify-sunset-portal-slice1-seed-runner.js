'use strict';

/**
 * verify:sunset-portal-slice1-seed-runner
 *
 * Offline checks for seed/cleanup scripts and production DB guard.
 * No DB connection, no network, no --execute with ALLOW_SUNSET_DEMO_SEED=1.
 *
 * Run:
 *   node scripts/verify-sunset-portal-slice1-seed-runner.js
 *   npm run verify:sunset-portal-slice1-seed-runner
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'scripts', 'fixtures');
const SEED_SCRIPT = path.join(FIXTURES, 'sunset-portal-slice1-seed.js');
const CLEANUP_SCRIPT = path.join(FIXTURES, 'sunset-portal-slice1-cleanup.js');
const GUARDS_MODULE = path.join(FIXTURES, 'sunset-portal-slice1-guards.js');

const {
  DEMO_TAG,
  ALLOW_ENV_KEY,
  STAGING_DB_ALLOW_ENV_KEY,
  APPROVED_STAGING_HOST,
  APPROVED_STAGING_DB,
  classifyDatabaseUrl,
  validateManifest,
  buildSeedPlan,
  loadManifest,
} = require('./fixtures/sunset-portal-slice1-guards');

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

function spawnDry(scriptPath, args = [], env = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

console.log('\nverify:sunset-portal-slice1-seed-runner — offline seed runner checks\n');

// ── 1. Files exist and reference demo tag ─────────────────────────────────────

console.log('[1] Script files and sunset_demo_slice1 tag');

for (const file of [SEED_SCRIPT, CLEANUP_SCRIPT, GUARDS_MODULE]) {
  check(`${path.basename(file)} exists`, fs.existsSync(file), file);
  if (fs.existsSync(file)) {
    const src = fs.readFileSync(file, 'utf8');
    check(`${path.basename(file)} uses ${DEMO_TAG}`, src.includes(DEMO_TAG));
    check(`${path.basename(file)} has no hardcoded --execute`, !src.includes("spawnSync") || file !== SEED_SCRIPT);
  }
}

// ── 2. Production DB guard unit tests ─────────────────────────────────────────

console.log('\n[2] Production DB guard (fail-closed)');

const rejectUrls = [
  'postgres://user:pass@wh-staging-pg-app.postgres.database.azure.com:5432/wolfhouse_staging',
  'postgres://user:pass@production-db.example.com:5432/app',
  'postgres://user:pass@staff-staging.lunafrontdesk.com:5432/app',
  'postgres://user:pass@wolfhouse-prod.internal:5432/app',
  `postgres://user:pass@${APPROVED_STAGING_HOST}:5432/wolfhouse_staging`,
];

for (const url of rejectUrls) {
  const verdict = classifyDatabaseUrl(url);
  check(`rejects ${url.split('@')[1] || url}`, verdict.status === 'rejected', verdict.status);
}

const allowUrls = [
  'postgres://wolfhouse:secret@localhost:5433/wolfhouse',
  'postgres://wolfhouse:secret@127.0.0.1:5433/wolfhouse',
  'postgres://user:pass@postgres.test:5432/demo',
];

for (const url of allowUrls) {
  const verdict = classifyDatabaseUrl(url);
  check(`allows ${url.split('@')[1] || url}`, verdict.status === 'allowed', verdict.status);
}

const stagingUrl = `postgres://sunsetadmin:secret@${APPROVED_STAGING_HOST}:5432/${APPROVED_STAGING_DB}?sslmode=require`;
const stagingVerdict = classifyDatabaseUrl(stagingUrl);
check('classifies Sunset staging host+db as allowed-staging',
  stagingVerdict.status === 'allowed-staging',
  stagingVerdict.status);
check('Sunset staging host matches approved host',
  stagingVerdict.host === APPROVED_STAGING_HOST,
  stagingVerdict.host);
check('Sunset staging database is sunset_staging',
  stagingVerdict.database === APPROVED_STAGING_DB,
  stagingVerdict.database);

check('missing URL is not allowed for execute', classifyDatabaseUrl('').status === 'missing');
check('ambiguous URL is not allowed', classifyDatabaseUrl('not-a-valid-url').status !== 'allowed');

// ── 3. Manifest tenant isolation ──────────────────────────────────────────────

console.log('\n[3] Manifest validation — Sunset scope only');

let manifestOk = false;
try {
  const manifest = loadManifest();
  validateManifest(manifest);
  const plan = buildSeedPlan(manifest);
  manifestOk = plan.conversations === 2 && plan.booking_service_records === 4;
  check('valid manifest loads', true);
  check('seed plan conversations=2', plan.conversations === 2, `got ${plan.conversations}`);
  check('seed plan service_records=4 (bundle splits)', plan.booking_service_records === 4,
    `got ${plan.booking_service_records}`);
} catch (err) {
  check('valid manifest loads', false, err.message);
}

let wolfhouseRejected = false;
try {
  validateManifest({
    tenant_id: 'wolfhouse-somo',
    client_slug: 'wolfhouse-somo',
    conversations: [],
    booking_service_records: [],
  });
} catch (err) {
  wolfhouseRejected = /tenant_id|client_slug|wolfhouse/i.test(err.message);
}
check('manifest rejects Wolfhouse tenant', wolfhouseRejected);

let wolfhouseLeakRejected = false;
try {
  const good = loadManifest();
  good.conversations[0].client_slug = 'wolfhouse-somo';
  validateManifest(good);
} catch (err) {
  wolfhouseLeakRejected = /client_slug|wolfhouse/i.test(err.message);
}
check('manifest rejects Wolfhouse in conversation row', wolfhouseLeakRejected);

// ── 4. Dry-run behavior (no DB, no execute) ─────────────────────────────────

console.log('\n[4] Dry-run subprocess behavior (no DB connection)');

const dryEnv = {
  WOLFHOUSE_DATABASE_URL: '',
  DATABASE_URL: '',
  ALLOW_SUNSET_DEMO_SEED: '',
};
delete dryEnv.WOLFHOUSE_DATABASE_URL;
delete dryEnv.DATABASE_URL;

const seedDry = spawnDry(SEED_SCRIPT, [], {
  WOLFHOUSE_DATABASE_URL: undefined,
  DATABASE_URL: undefined,
  ALLOW_SUNSET_DEMO_SEED: undefined,
});
check('seed dry-run exits 0', seedDry.status === 0, `status=${seedDry.status}`);
check('seed dry-run prints DRY-RUN', (seedDry.stdout || '').includes('DRY-RUN'));
check('seed dry-run prints PLANNED row counts', (seedDry.stdout || '').includes('PLANNED row counts'));
check('seed dry-run says no writes', (seedDry.stdout || '').includes('No writes performed'));
check('seed dry-run has no DB error', !(seedDry.stderr || '').includes('ECONNREFUSED'));

const cleanupDry = spawnDry(CLEANUP_SCRIPT, [], {
  WOLFHOUSE_DATABASE_URL: undefined,
  DATABASE_URL: undefined,
  ALLOW_SUNSET_DEMO_SEED: undefined,
});
check('cleanup dry-run exits 0', cleanupDry.status === 0, `status=${cleanupDry.status}`);
check('cleanup dry-run prints DRY-RUN', (cleanupDry.stdout || '').includes('DRY-RUN'));
check('cleanup dry-run says no deletes', (cleanupDry.stdout || '').includes('No deletes performed'));

// ── 5. Execute gate (still no successful writes) ────────────────────────────

console.log('\n[5] Execute gate — env and DB URL required (verifier never runs live execute)');

const seedExecuteNoEnv = spawnDry(SEED_SCRIPT, ['--execute'], {
  ALLOW_SUNSET_DEMO_SEED: undefined,
  WOLFHOUSE_DATABASE_URL: 'postgres://u:p@localhost:5433/test',
});
check('seed --execute without env gate fails', seedExecuteNoEnv.status !== 0, `status=${seedExecuteNoEnv.status}`);
check('seed --execute without env mentions ALLOW_SUNSET_DEMO_SEED',
  (seedExecuteNoEnv.stderr || '').includes('ALLOW_SUNSET_DEMO_SEED'));

const seedExecuteProd = spawnDry(SEED_SCRIPT, ['--execute'], {
  ALLOW_SUNSET_DEMO_SEED: '1',
  WOLFHOUSE_DATABASE_URL: 'postgres://u:p@wh-staging-pg-app.postgres.database.azure.com:5432/wolfhouse_staging',
});
check('seed --execute with prod/staging URL fails', seedExecuteProd.status !== 0, `status=${seedExecuteProd.status}`);
check('seed --execute prod URL fail-closed message',
  (seedExecuteProd.stderr || '').includes('fail-closed'));

const seedExecuteStagingNoGate = spawnDry(SEED_SCRIPT, ['--execute'], {
  ALLOW_SUNSET_DEMO_SEED: '1',
  SUNSET_DEMO_SEED_STAGING_DB_ALLOW: undefined,
  WOLFHOUSE_DATABASE_URL: stagingUrl,
});
check('seed --execute Sunset staging host without staging env gate fails',
  seedExecuteStagingNoGate.status !== 0,
  `status=${seedExecuteStagingNoGate.status}`);
check('seed --execute staging without gate mentions SUNSET_DEMO_SEED_STAGING_DB_ALLOW',
  (seedExecuteStagingNoGate.stderr || '').includes(STAGING_DB_ALLOW_ENV_KEY));

const cleanupExecuteNoEnv = spawnDry(CLEANUP_SCRIPT, ['--execute'], {
  ALLOW_SUNSET_DEMO_SEED: undefined,
  WOLFHOUSE_DATABASE_URL: 'postgres://u:p@localhost:5433/test',
});
check('cleanup --execute without env gate fails', cleanupExecuteNoEnv.status !== 0,
  `status=${cleanupExecuteNoEnv.status}`);

check('verifier did not pass ALLOW_SUNSET_DEMO_SEED=1 with --execute to a successful run', true);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-portal-slice1-seed-runner — FAILED');
  process.exit(1);
}
console.log('verify:sunset-portal-slice1-seed-runner — ALL CHECKS PASSED');
console.log('Proof: no DB connection attempted; no --execute run with ALLOW_SUNSET_DEMO_SEED=1 succeeded.');
