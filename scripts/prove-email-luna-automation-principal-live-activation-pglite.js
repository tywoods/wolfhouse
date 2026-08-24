'use strict';

/**
 * Prove Ch4 Slice C1 operator-approved Sunset staging trusted-precreated
 * activation against 088-096 on PGlite. Default-off. No live DB. No secrets.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const b1 = require('./prove-email-luna-automation-issuance-material-pglite');
const b4 = require('./prove-email-luna-automation-shadow-comparison-pglite');
const {
  FUNCTION_SIGNATURES,
  createRoleSql,
  quoteSqlIdent,
  SUNSET_STAGING_TRUSTED_PRECREATED,
} = require('./lib/email-luna-automation-principal-contract');
const {
  provisionEmailLunaAutomationPrincipal,
  IDENTITY_SQL,
} = require('./lib/email-luna-automation-principal-provision');

const ROOT = path.resolve(__dirname, '..');
const RED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-principal-live-activation-red.json'),
  'utf8',
));
const WORKER_ROLE = 'luna_ch4c1_pre_worker';
const DEFAULT_ROLE = 'luna_ch4c1_default_pre';
const WRONG_ATTR_ROLE = 'luna_ch4c1_inherit';
const WRONG_MAP_ROLE = 'luna_ch4c1_wrong_map';
const MISSING_ROLE = 'luna_ch4c1_missing';
const NOT_OWNER_ROLE = 'luna_ch4c1_notowner';
const ADVERSARIAL_LOCATION = '22222222-2222-4222-8222-222222222220';
const ADVERSARIAL_CLIENT_SLUG = 'other-tenant';
const QUEUE_TABLE = 'tenant_email_luna_automation_queue';
const JOURNAL_TABLE = 'tenant_email_outbound_send_journal';
const PRINCIPAL_TABLE = 'tenant_email_luna_automation_principals';
const MATERIAL_TABLE = 'tenant_email_luna_automation_issuance_material';

const WORKER_EXECUTE = Object.freeze([
  FUNCTION_SIGNATURES.tenant_email_luna_automation_claim,
  FUNCTION_SIGNATURES.tenant_email_luna_automation_cancel_claimed,
  FUNCTION_SIGNATURES.tenant_email_luna_automation_require_handoff_claimed,
  FUNCTION_SIGNATURES.tenant_email_luna_automation_handoff,
  FUNCTION_SIGNATURES.tenant_email_luna_automation_terminalize_attempt_cap,
  FUNCTION_SIGNATURES.tenant_email_luna_automation_journal_handoff_lock,
  FUNCTION_SIGNATURES.tenant_email_luna_automation_principal_authorized,
  FUNCTION_SIGNATURES.tenant_email_luna_automation_issuance_material_load,
  FUNCTION_SIGNATURES.tenant_email_luna_automation_capture_shadow,
  FUNCTION_SIGNATURES.tenant_email_luna_automation_shadow_outcome_load,
  FUNCTION_SIGNATURES.tenant_email_luna_automation_shadow_outcome_project,
  FUNCTION_SIGNATURES.tenant_email_luna_automation_claim_scoped,
]);
const WORKER_DENIED_EXECUTE = Object.freeze([
  FUNCTION_SIGNATURES.tenant_email_luna_automation_enqueue,
  FUNCTION_SIGNATURES.tenant_email_luna_automation_persist_and_enqueue,
  FUNCTION_SIGNATURES.tenant_email_luna_automation_cancel_pending,
  FUNCTION_SIGNATURES.tenant_email_luna_automation_require_handoff_pending,
]);
const UP_096 = fs.readFileSync(
  path.join(ROOT, 'database/migrations/096_tenant_email_luna_automation_public_execute.sql'),
  'utf8',
);

function tryLoadPglite() {
  for (const base of [
    process.env.NODE_PATH,
    path.join(ROOT, 'node_modules'),
    '/opt/data/worktrees/full-sail-stage1-ch3a/node_modules',
    '/opt/data/wolfhouse-agent/node_modules',
  ].filter(Boolean)) {
    try {
      const mod = require(path.join(String(base).split(path.delimiter)[0], '@electric-sql/pglite'));
      if (mod && mod.PGlite) return mod.PGlite;
    } catch (_) { /* continue */ }
  }
  try { return require('@electric-sql/pglite').PGlite; } catch (_) { return null; }
}

function assertStaticContract() {
  assert.equal(RED.id, 'email-luna-automation-principal-live-activation.ch4c1-red.v1');
  assert.equal(RED.head_reviewed, 'a804f394e1f240ba996ca442d0d4a159f9fd86aa');
  assert.equal(SUNSET_STAGING_TRUSTED_PRECREATED.database, 'sunset_staging');
  assert.equal(SUNSET_STAGING_TRUSTED_PRECREATED.client_slug, 'sunset');
  assert.equal(SUNSET_STAGING_TRUSTED_PRECREATED.location_key, 'sunset-somo');
  assert.equal(IDENTITY_SQL, 'SELECT current_database() AS database, session_user AS session_user');
  console.log('ok - static C1 live-principal activation contract');
}

async function seedSunsetClientBinding(db) {
  await db.exec('ALTER TABLE public.clients ADD COLUMN slug text');
  await db.query(
    'UPDATE public.clients SET slug = $1 WHERE id = $2::uuid',
    [SUNSET_STAGING_TRUSTED_PRECREATED.client_slug, b1.ids.client],
  );
  await db.query(
    'UPDATE public.clients SET slug = $1 WHERE id = $2::uuid',
    [ADVERSARIAL_CLIENT_SLUG, b1.ids.client2],
  );
  await db.query(
    `INSERT INTO public.tenant_locations (id, client_id, location_id)
     VALUES ($1::uuid, $2::uuid, $3)`,
    [ADVERSARIAL_LOCATION, b1.ids.client2, SUNSET_STAGING_TRUSTED_PRECREATED.location_key],
  );
}

async function applyThrough095(db) {
  await b1.applyThrough088(db);
  await db.exec(b1.UP);
  await db.exec(b4.UP_093);
  await db.exec(b4.UP_094);
  await db.exec(b4.UP_095);
  await db.exec(UP_096);
  await seedSunsetClientBinding(db);
}

function identitySession(db, identity) {
  const fakeDatabase = identity && identity.database;
  const fakeUser = identity && identity.session_user;
  const rewrite = identity && identity.rewriteDatabaseIdent === true;
  return {
    async connect() {
      return {
        async query(text, params) {
          const sql = String(text);
          if (sql === IDENTITY_SQL) {
            const real = await db.query(text, params);
            const row = Object.assign({}, real.rows[0]);
            if (fakeDatabase != null) row.database = fakeDatabase;
            if (fakeUser != null) row.session_user = fakeUser;
            return { rows: [row] };
          }
          if (rewrite && fakeDatabase && sql.includes(`ON DATABASE "${fakeDatabase}"`)) {
            const actual = await db.query('SELECT current_database() AS database');
            const to = quoteSqlIdent(String(actual.rows[0].database));
            const rewritten = sql.split(`ON DATABASE "${fakeDatabase}"`).join(`ON DATABASE ${to}`);
            return db.query(rewritten, params);
          }
          return db.query(text, params);
        },
        async release() {},
      };
    },
  };
}

function trackingSession(inner) {
  const seen = [];
  return {
    seen,
    async connect() {
      const client = await inner.connect();
      return {
        async query(text, params) {
          seen.push(String(text));
          return client.query(text, params);
        },
        async release() {
          if (client && typeof client.release === 'function') await client.release();
        },
      };
    },
  };
}

function sunsetSpec(overrides) {
  return Object.assign({
    roleName: WORKER_ROLE,
    kind: 'worker',
    client_id: b1.ids.client,
    location_id: b1.ids.location,
    location_key: 'sunset-somo',
    trustedPrecreated: true,
    apply: true,
    allowSunsetStagingTrustedPrecreated: true,
  }, overrides);
}

function sunsetSession(db) {
  return identitySession(db, { database: 'sunset_staging', rewriteDatabaseIdent: true });
}

async function hasExecute(db, role, signature) {
  const result = await db.query(
    `SELECT pg_catalog.has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`,
    [role, `public.${signature}`],
  );
  return result.rows[0] && result.rows[0].ok === true;
}

async function hasTablePrivilege(db, role, table, privilege) {
  const result = await db.query(
    `SELECT pg_catalog.has_table_privilege($1, $2::regclass, $3) AS ok`,
    [role, `public.${table}`, privilege],
  );
  return result.rows[0] && result.rows[0].ok === true;
}

async function mappingRow(db, roleName) {
  const result = await db.query(
    `SELECT principal_kind, client_id::text AS client_id, location_id::text AS location_id, location_key
       FROM public.tenant_email_luna_automation_principals
      WHERE role_name = $1`,
    [roleName],
  );
  return result.rows[0] || null;
}

function assertNoRoleOrPasswordSql(seen) {
  for (const sql of seen) {
    assert.equal(/\bCREATE\s+ROLE\b/i.test(sql), false, sql);
    assert.equal(/\bALTER\s+ROLE\b/i.test(sql), false, sql);
    assert.equal(/\bPASSWORD\b/i.test(sql), false, sql);
  }
}

async function proveOnDatabase(db, options) {
  const wrapSunset = options && options.wrapSunsetIdentity === true;
  const proveDefault = options && options.proveDefaultTrustedPrecreated !== false;
  const ids = b1.ids;
  const liveSunset = wrapSunset ? sunsetSession(db) : b1.exclusiveSession(db);
  const nonSunsetSession = (options && options.nonSunsetSession) || b1.exclusiveSession(db);

  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(liveSunset, {
      roleName: WORKER_ROLE,
      kind: 'worker',
      client_id: ids.client,
      location_id: ids.location,
      location_key: 'sunset-somo',
      trustedPrecreated: true,
      apply: true,
    }),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_FORBIDDEN_DATABASE',
  );
  console.log('ok - RED default trustedPrecreated refuses sunset_staging');

  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(nonSunsetSession, sunsetSpec()),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_FORBIDDEN_DATABASE',
  );
  console.log('ok - option on non-sunset_staging current_database fails closed');

  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(
      identitySession(db, { database: 'wolfhouse_prod', rewriteDatabaseIdent: true }),
      sunsetSpec(),
    ),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_FORBIDDEN_DATABASE',
  );
  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(
      identitySession(db, { database: 'sunset_prod', rewriteDatabaseIdent: true }),
      sunsetSpec(),
    ),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_FORBIDDEN_DATABASE',
  );
  console.log('ok - option does not broaden other product databases');

  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(liveSunset, sunsetSpec({
      allowSunsetStagingTrustedPrecreated: true,
      trustedPrecreated: true,
      apply: true,
      kind: 'operator',
    })),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID',
  );
  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(liveSunset, sunsetSpec({
      password: b1.PASSWORD,
    })),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_PASSWORD_REFUSED',
  );
  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(liveSunset, sunsetSpec({
      location_key: 'sunset-sardinero',
    })),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID',
  );
  console.log('ok - option with password, operator kind, or wrong location_key fails closed');

  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(liveSunset, sunsetSpec({
      location_id: ids.locationB,
    })),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID',
  );
  console.log('ok - caller binding that is not durable sunset-somo fails closed');

  const sunsetSomoRows = await db.query(
    `SELECT c.slug AS slug, tl.client_id::text AS client_id, tl.id::text AS location_uuid
       FROM public.tenant_locations tl
       JOIN public.clients c ON c.id = tl.client_id
      WHERE tl.location_id = $1
      ORDER BY c.slug`,
    [SUNSET_STAGING_TRUSTED_PRECREATED.location_key],
  );
  assert.equal(sunsetSomoRows.rows.length, 2);
  assert.equal(sunsetSomoRows.rows[0].slug, ADVERSARIAL_CLIENT_SLUG);
  assert.equal(sunsetSomoRows.rows[0].client_id, ids.client2);
  assert.equal(sunsetSomoRows.rows[0].location_uuid, ADVERSARIAL_LOCATION);
  assert.equal(sunsetSomoRows.rows[1].slug, SUNSET_STAGING_TRUSTED_PRECREATED.client_slug);
  assert.equal(sunsetSomoRows.rows[1].client_id, ids.client);
  const locationIdUniques = await db.query(
    `SELECT 1
       FROM pg_catalog.pg_constraint
      WHERE conrelid = 'public.tenant_locations'::pg_catalog.regclass
        AND contype IN ('u', 'p')
        AND pg_catalog.pg_get_constraintdef(oid) ~ 'location_id'
        AND pg_catalog.pg_get_constraintdef(oid) !~ 'client_id'`,
  );
  assert.equal(locationIdUniques.rows.length, 0);
  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(liveSunset, sunsetSpec({
      client_id: ids.client2,
      location_id: ADVERSARIAL_LOCATION,
      location_key: SUNSET_STAGING_TRUSTED_PRECREATED.location_key,
    })),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID',
  );
  console.log('ok - non-Sunset client holding sunset-somo is refused by clients.slug join');

  await db.exec(createRoleSql(NOT_OWNER_ROLE, b1.PASSWORD));
  await db.exec(`SET SESSION AUTHORIZATION ${NOT_OWNER_ROLE}`);
  try {
    await assert.rejects(
      () => provisionEmailLunaAutomationPrincipal(liveSunset, sunsetSpec()),
      (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_SESSION_NOT_OWNER',
    );
  } finally {
    await db.exec('SET SESSION AUTHORIZATION postgres');
  }
  console.log('ok - non-owner session_user fails closed');

  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(liveSunset, sunsetSpec({ roleName: MISSING_ROLE })),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_ROLE_MISSING',
  );
  const missingMapped = await mappingRow(db, MISSING_ROLE);
  assert.equal(missingMapped, null);
  console.log('ok - create-role / missing role fails closed without mapping');

  await db.exec(
    `CREATE ROLE ${WRONG_ATTR_ROLE} LOGIN PASSWORD '${b1.PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS`,
  );
  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(liveSunset, sunsetSpec({ roleName: WRONG_ATTR_ROLE })),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INCONSISTENT_ROLE',
  );
  assert.equal(await mappingRow(db, WRONG_ATTR_ROLE), null);
  console.log('ok - wrong fail-closed LOGIN attributes fail closed');

  await db.exec(createRoleSql(WRONG_MAP_ROLE, b1.PASSWORD));
  await db.query(
    `INSERT INTO public.tenant_email_luna_automation_principals
       (role_name, principal_kind, client_id, location_id, location_key)
     VALUES ($1, 'worker', $2::uuid, $3::uuid, $4)`,
    [WRONG_MAP_ROLE, ids.client, ids.locationB, 'sunset-sardinero'],
  );
  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(liveSunset, sunsetSpec({ roleName: WRONG_MAP_ROLE })),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INCONSISTENT_MAPPING',
  );
  const wrongMap = await mappingRow(db, WRONG_MAP_ROLE);
  assert.equal(wrongMap.location_key, 'sunset-sardinero');
  console.log('ok - existing wrong mapping fails closed and is unchanged');

  if (proveDefault) {
    await db.exec(createRoleSql(DEFAULT_ROLE, b1.PASSWORD));
    const defaultAdopt = await provisionEmailLunaAutomationPrincipal(nonSunsetSession, {
      roleName: DEFAULT_ROLE,
      kind: 'worker',
      client_id: ids.client,
      location_id: ids.location,
      location_key: 'sunset-somo',
      trustedPrecreated: true,
      apply: true,
    });
    assert.equal(defaultAdopt.ok, true);
    assert.equal(defaultAdopt.roleAction, 'trusted_precreated');
    assert.equal(defaultAdopt.allowSunsetStagingTrustedPrecreated, false);
    console.log('ok - default trustedPrecreated on non-product databases remains available');
  }

  await db.exec(createRoleSql(WORKER_ROLE, b1.PASSWORD));
  const tracked = trackingSession(liveSunset);
  const adopted = await provisionEmailLunaAutomationPrincipal(tracked, sunsetSpec());
  assert.equal(adopted.ok, true);
  assert.equal(adopted.apply, true);
  assert.equal(adopted.roleAction, 'trusted_precreated');
  assert.equal(adopted.mappingAction, 'insert');
  assert.equal(adopted.allowSunsetStagingTrustedPrecreated, true);
  assert.equal(adopted.kind, 'worker');
  assert.equal(adopted.location_key, 'sunset-somo');
  assert.equal(JSON.stringify(adopted).includes(b1.PASSWORD), false);
  assert.equal(adopted.plan.some((line) => /CREATE ROLE/i.test(line)), false);
  assertNoRoleOrPasswordSql(tracked.seen);
  assert.equal(
    tracked.seen.some((sql) => /JOIN public\.clients/.test(sql) && /public\.clients\.slug = \$4/.test(sql)),
    true,
  );
  const mapped = await mappingRow(db, WORKER_ROLE);
  assert.equal(mapped.principal_kind, 'worker');
  assert.equal(mapped.client_id, ids.client);
  assert.equal(mapped.location_id, ids.location);
  assert.equal(mapped.location_key, 'sunset-somo');
  console.log('ok - GREEN exact trusted precreated Sunset worker is adopted and mapped');

  const rerunTracked = trackingSession(liveSunset);
  const rerun = await provisionEmailLunaAutomationPrincipal(rerunTracked, sunsetSpec());
  assert.equal(rerun.ok, true);
  assert.equal(rerun.roleAction, 'verify_noop');
  assert.equal(rerun.mappingAction, 'verify_noop');
  assertNoRoleOrPasswordSql(rerunTracked.seen);
  console.log('ok - GREEN exact mapped Sunset worker rerun is convergent');

  for (const signature of WORKER_EXECUTE) {
    assert.equal(await hasExecute(db, WORKER_ROLE, signature), true, signature);
  }
  for (const signature of WORKER_DENIED_EXECUTE) {
    assert.equal(await hasExecute(db, WORKER_ROLE, signature), false, signature);
  }
  assert.equal(await hasTablePrivilege(db, WORKER_ROLE, QUEUE_TABLE, 'SELECT'), true);
  assert.equal(await hasTablePrivilege(db, WORKER_ROLE, QUEUE_TABLE, 'INSERT'), false);
  assert.equal(await hasTablePrivilege(db, WORKER_ROLE, QUEUE_TABLE, 'UPDATE'), false);
  assert.equal(await hasTablePrivilege(db, WORKER_ROLE, QUEUE_TABLE, 'DELETE'), false);
  assert.equal(await hasTablePrivilege(db, WORKER_ROLE, JOURNAL_TABLE, 'SELECT'), false);
  assert.equal(await hasTablePrivilege(db, WORKER_ROLE, PRINCIPAL_TABLE, 'SELECT'), false);
  assert.equal(await hasTablePrivilege(db, WORKER_ROLE, MATERIAL_TABLE, 'SELECT'), false);
  console.log('ok - GREEN worker received only contract capabilities');
}

function runPgliteProof() {
  assertStaticContract();
  const PGlite = tryLoadPglite();
  if (!PGlite) {
    console.log('ok - pglite unavailable; static C1 live-principal activation contract only');
    return Promise.resolve();
  }
  return Promise.resolve().then(async () => {
    const db = new PGlite();
    await applyThrough095(db);
    await proveOnDatabase(db, { wrapSunsetIdentity: true });
    console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice C1 live-principal activation pglite');
  });
}

if (require.main === module) {
  runPgliteProof().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  runPgliteProof,
  applyThrough095,
  proveOnDatabase,
  identitySession,
  sunsetSpec,
  sunsetSession,
  trackingSession,
  WORKER_ROLE,
  WORKER_EXECUTE,
  WORKER_DENIED_EXECUTE,
};
