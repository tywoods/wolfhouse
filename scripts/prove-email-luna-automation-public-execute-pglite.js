'use strict';

/**
 * Prove Ch4 Slice C1 ambient PUBLIC EXECUTE hardening (096) on PGlite.
 * RED: post-095 arbitrary LOGIN with public USAGE executes ambient functions
 * and trusted-precreated adoption fails closed.
 * GREEN: 096 revokes PUBLIC EXECUTE, preserves owner + explicit grants,
 * defaults new functions non-PUBLIC, and principal audit then allowlists
 * only the contract (still catching reintroduced PUBLIC EXECUTE).
 * 096_down is intentionally irreversible: it refuses without ACL mutation
 * and leaves post-096 ACLs/defaults unchanged. Repeat refusal is safe.
 *
 * PGlite does not claim pgcrypto; stock-PG proof covers extension-owned
 * functions when CREATE EXTENSION is available.
 * No live DB. No secrets. No GRANT to a product worker in 096 itself.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const b1 = require('./prove-email-luna-automation-issuance-material-pglite');
const b4 = require('./prove-email-luna-automation-shadow-comparison-pglite');
const {
  createRoleSql,
  FUNCTION_SIGNATURES,
  EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT,
} = require('./lib/email-luna-automation-principal-contract');
const {
  provisionEmailLunaAutomationPrincipal,
} = require('./lib/email-luna-automation-principal-provision');
const {
  PGCRYPTO_1_3_SIGNATURES,
  PGCRYPTO_1_3_RESIDUAL,
  assertMigrationAllowlistParity,
  publicExecuteResidualSignaturesSql,
} = require('./lib/email-luna-automation-pgcrypto-residual-contract');

const ROOT = path.resolve(__dirname, '..');
const RED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-public-execute-red.json'),
  'utf8',
));
const UP = fs.readFileSync(
  path.join(ROOT, 'database/migrations/096_tenant_email_luna_automation_public_execute.sql'),
  'utf8',
);
const DOWN = fs.readFileSync(
  path.join(ROOT, 'database/migrations/096_tenant_email_luna_automation_public_execute_down.sql'),
  'utf8',
);
const PRE_CORRECTION_UP = fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-public-execute-096-pre-correction.sql'),
  'utf8',
);

const BYSTANDER = 'luna_ch4c1_bystander';
const GRANTEE = 'luna_ch4c1_grantee';
const WORKER = 'luna_ch4c1_pub_worker';
const NOT_OWNER = 'luna_ch4c1_pub_notowner';
const APPOWNER = 'luna_ch4c1_appowner';
const EXTOWNER = 'luna_ch4c1_extowner';
const CANARY = 'luna_ch4c1_canary()';
const NAMED = 'luna_ch4c1_named(integer)';
const AFTER = 'luna_ch4c1_after()';
const STILL = 'luna_ch4c1_still()';
const ENQUEUE = FUNCTION_SIGNATURES.tenant_email_luna_automation_enqueue;
const DOWN_REFUSED_SQLSTATE = '0A000';

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

function errText(err) {
  return String((err && (err.message || err.detail || err)) || '');
}

function matchesSql(err, needle, sqlstate) {
  const text = errText(err);
  const code = err && (err.code || err.sqlstate);
  return text.includes(needle) && (!sqlstate || code === sqlstate || text.includes(sqlstate));
}

function assertStaticContract() {
  assert.equal(RED.id, 'email-luna-automation-public-execute.ch4c1-red.v1');
  assert.equal(RED.head_reviewed, '3144efb83ae6f0e08d2b085be14f3d4418bb4a43');
  assert.equal(RED.pr_reviewed, 710);
  assert.equal(RED.findings.length, 4);
  assert.equal(RED.findings[3].id, 'azure-pgcrypto-residual');
  assert.match(UP, /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC/);
  assert.match(UP, /ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/);
  assert.match(UP, /ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/);
  assert.match(UP, /extversion is exactly 1\.3/);
  assert.match(UP, /NIGHTWATCH_PGCRYPTO_1_3_ALLOWLIST_BEGIN/);
  assert.equal(assertMigrationAllowlistParity(UP), true);
  assert.equal(PGCRYPTO_1_3_SIGNATURES.length, 36);
  assert.equal(PGCRYPTO_1_3_RESIDUAL.capability.databaseRead, false);
  assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.ambient_callable_functions, 'exact_luna_oids_plus_frozen_pgcrypto_1_3_residual');
  assert.equal(/^\s*GRANT /m.test(UP), false);
  assert.equal(/^\s*CREATE ROLE/m.test(UP), false);
  assert.equal(UP.includes('azuresu'), false);
  assert.equal(PRE_CORRECTION_UP.includes('NIGHTWATCH_PGCRYPTO_1_3_ALLOWLIST_BEGIN'), false);
  assert.match(DOWN, /096_down_refused/);
  assert.match(DOWN, /exact pre-096 ACL\/default-ACL state was not captured/);
  assert.match(DOWN, /broad rollback would be unsafe/);
  assert.equal(/GRANT\s+EXECUTE\s+ON\s+ALL\s+FUNCTIONS\s+IN\s+SCHEMA\s+public\s+TO\s+PUBLIC/i.test(DOWN), false);
  const downBody = String(DOWN)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*--[^\n]*$/gm, '');
  assert.equal(/\bGRANT\b/i.test(downBody), false);
  assert.equal(/\bREVOKE\b/i.test(downBody), false);
  assert.equal(/ALTER\s+DEFAULT\s+PRIVILEGES/i.test(downBody), false);
  console.log('ok - static C1 public EXECUTE contract');
}

async function applyThrough095(db) {
  await b1.applyThrough088(db);
  await db.exec(b1.UP);
  await db.exec(b4.UP_093);
  await db.exec(b4.UP_094);
  await db.exec(b4.UP_095);
}

async function publicExecute(db, signature) {
  const result = await db.query(`
    SELECT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(p.proacl, pg_catalog.acldefault('f'::"char", p.proowner))
        ) a ON TRUE
       WHERE n.nspname = 'public'
         AND p.oid = $1::pg_catalog.regprocedure
         AND a.grantee = 0
         AND a.privilege_type = 'EXECUTE'
    ) AS ok
  `, [`public.${signature}`]);
  return result.rows[0].ok === true;
}

async function roleExecute(db, role, signature) {
  const result = await db.query(
    `SELECT pg_catalog.has_function_privilege($1, $2::pg_catalog.regprocedure, 'EXECUTE') AS ok`,
    [role, `public.${signature}`],
  );
  return result.rows[0].ok === true;
}

async function publicCallableCount(db, role) {
  const result = await db.query(`
    SELECT COUNT(*)::int AS n
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND pg_catalog.has_schema_privilege($1, n.oid, 'USAGE')
       AND pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE')
  `, [role]);
  return result.rows[0].n;
}

function isDownRefused(err) {
  const text = errText(err);
  return text.includes('096_down_refused')
    && text.includes('exact pre-096 ACL/default-ACL state was not captured')
    && text.includes('broad rollback would be unsafe')
    && matchesSql(err, '096_down_refused', DOWN_REFUSED_SQLSTATE);
}

async function refuseDown(db) {
  await assert.rejects(() => db.exec(DOWN), isDownRefused);
  try { await db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
}

async function snapshotPublicExecuteAcls(db) {
  return {
    canaryPublic: await publicExecute(db, CANARY),
    canaryBystander: await roleExecute(db, BYSTANDER, CANARY),
    canaryOwner: await roleExecute(db, 'postgres', CANARY),
    namedPublic: await publicExecute(db, NAMED),
    namedGrantee: await roleExecute(db, GRANTEE, NAMED),
    namedBystander: await roleExecute(db, BYSTANDER, NAMED),
    enqueueBystander: await roleExecute(db, BYSTANDER, ENQUEUE),
    afterPublic: await publicExecute(db, AFTER),
    afterBystander: await roleExecute(db, BYSTANDER, AFTER),
    afterOwner: await roleExecute(db, 'postgres', AFTER),
    bystanderCount: await publicCallableCount(db, BYSTANDER),
    ownerDefaultPublic: await ownerDefaultPublicExecute(db, 'postgres'),
  };
}

async function ownerDefaultPublicExecute(db, owner) {
  const result = await db.query(`
    SELECT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_default_acl d
        JOIN pg_catalog.pg_roles r ON r.oid = d.defaclrole
        LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
        JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a ON TRUE
       WHERE r.rolname = $1
         AND d.defaclobjtype = 'f'
         AND (d.defaclnamespace = 0 OR n.nspname = 'public')
         AND a.grantee = 0
         AND a.privilege_type = 'EXECUTE'
    ) AS ok
  `, [owner]);
  return result.rows[0].ok === true;
}

async function tryCreatePgcrypto(db) {
  try {
    await db.exec('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    const rows = await db.query(`
      SELECT pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'digest'
       ORDER BY 1
    `);
    if (!rows.rows.length) return null;
    const textArgs = rows.rows.find((row) => String(row.args).includes('text'));
    const signature = `digest(${(textArgs || rows.rows[0]).args})`;
    return signature;
  } catch (err) {
    console.log(`ok - pgcrypto unavailable here (${errText(err).split('\n')[0]}) — documented owner/extension nuance`);
    return null;
  }
}

async function seedActors(db) {
  await db.exec(`
    CREATE FUNCTION public.luna_ch4c1_canary() RETURNS int LANGUAGE sql AS $$ SELECT 42 $$;
    CREATE FUNCTION public.luna_ch4c1_named(p int) RETURNS int LANGUAGE sql AS $$ SELECT p $$;
  `);
  await db.exec(createRoleSql(BYSTANDER, b1.PASSWORD));
  await db.exec(createRoleSql(GRANTEE, b1.PASSWORD));
  await db.exec(createRoleSql(WORKER, b1.PASSWORD));
  await db.exec(createRoleSql(NOT_OWNER, b1.PASSWORD));
  await db.exec(`GRANT EXECUTE ON FUNCTION public.luna_ch4c1_named(int) TO ${GRANTEE}`);
}

async function adoptWorker(db, roleName) {
  return provisionEmailLunaAutomationPrincipal(b1.exclusiveSession(db), {
    roleName: roleName || WORKER,
    kind: 'worker',
    client_id: b1.ids.client,
    location_id: b1.ids.location,
    location_key: 'sunset-somo',
    trustedPrecreated: true,
    apply: true,
  });
}

async function remainingPublicSignatures(db) {
  const result = await db.query(publicExecuteResidualSignaturesSql());
  return result.rows.map((row) => row.signature);
}

function isResidualRefuse(err) {
  return matchesSql(err, 'public-schema function still executable by PUBLIC', '42501')
    || matchesSql(err, 'PUBLIC-executable pgcrypto residual is not pinned extension version 1.3', '42501');
}

async function withSession(db, role, work) {
  await db.exec(`SET SESSION AUTHORIZATION ${role}`);
  try {
    return await work();
  } finally {
    try { await db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    await db.exec('SET SESSION AUTHORIZATION postgres');
  }
}

async function provePublicExecuteOnDatabase(db, options) {
  const tryPgcrypto = options && options.tryPgcrypto === true;
  await seedActors(db);
  const pgcryptoSig = tryPgcrypto ? await tryCreatePgcrypto(db) : null;

  assert.equal(await publicExecute(db, CANARY), true);
  assert.equal(await roleExecute(db, BYSTANDER, CANARY), true);
  assert.equal(await roleExecute(db, BYSTANDER, 'set_updated_at()'), true);
  assert.equal(await roleExecute(db, BYSTANDER, ENQUEUE), false, '088 already revoked Luna PUBLIC EXECUTE');
  const preCount = await publicCallableCount(db, BYSTANDER);
  assert.ok(preCount >= 2, `pre-096 ambient callable count ${preCount}`);
  const canaryCall = await b1.asRole(db, BYSTANDER, () => db.query('SELECT public.luna_ch4c1_canary() AS n'));
  assert.equal(Number(canaryCall.rows[0].n), 42);
  if (pgcryptoSig) {
    assert.equal(await publicExecute(db, pgcryptoSig), true);
    assert.equal(await roleExecute(db, BYSTANDER, pgcryptoSig), true);
    const digestCall = await b1.asRole(db, BYSTANDER, () => db.query(
      'SELECT pg_catalog.encode(public.digest($1::bytea, $2::text), \'hex\') AS d',
      [Buffer.from('nightwatch'), 'sha256'],
    ));
    assert.equal(typeof digestCall.rows[0].d, 'string');
    assert.equal(digestCall.rows[0].d.length, 64);
    console.log(`ok - RED stock pgcrypto ${pgcryptoSig} is ambient-callable before 096`);
  }
  await assert.rejects(
    () => adoptWorker(db),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_EXECUTE',
  );
  console.log('ok - RED pre-096 arbitrary LOGIN executes ambient public functions; adoption fail-closes');

  await db.exec(`SET SESSION AUTHORIZATION ${NOT_OWNER}`);
  try {
    await assert.rejects(
      () => db.exec(UP),
      (err) => matchesSql(err, 'must run as queue table/function owner', '42501'),
    );
  } finally {
    try { await db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    await db.exec('SET SESSION AUTHORIZATION postgres');
  }
  console.log('ok - GREEN 096 refuses a non-owner session');

  await db.exec(UP);
  await db.exec(UP);
  console.log('ok - GREEN 096 is idempotent');

  assert.equal(await publicExecute(db, CANARY), false);
  assert.equal(await roleExecute(db, BYSTANDER, CANARY), false);
  assert.equal(await roleExecute(db, BYSTANDER, 'set_updated_at()'), false);
  assert.equal(await roleExecute(db, 'postgres', CANARY), true, 'function owner keeps implicit EXECUTE');
  assert.equal(await publicExecute(db, NAMED), false);
  assert.equal(await roleExecute(db, GRANTEE, NAMED), true, 'explicit GRANT EXECUTE survives');
  assert.equal(await roleExecute(db, BYSTANDER, NAMED), false);
  assert.equal(await roleExecute(db, BYSTANDER, ENQUEUE), false);
  const ownerCall = await db.query('SELECT public.luna_ch4c1_canary() AS n');
  assert.equal(Number(ownerCall.rows[0].n), 42);
  await assert.rejects(
    () => b1.asRole(db, BYSTANDER, () => db.query('SELECT public.luna_ch4c1_canary() AS n')),
    (err) => /permission denied/i.test(errText(err)),
  );
  const namedCall = await b1.asRole(db, GRANTEE, () => db.query('SELECT public.luna_ch4c1_named(7) AS n'));
  assert.equal(Number(namedCall.rows[0].n), 7);
  const postCount = await publicCallableCount(db, BYSTANDER);
  assert.equal(postCount, 0, `post-096 ambient callable count ${postCount}`);
  if (pgcryptoSig) {
    assert.equal(await publicExecute(db, pgcryptoSig), false);
    assert.equal(await roleExecute(db, BYSTANDER, pgcryptoSig), false);
    await assert.rejects(
      () => b1.asRole(db, BYSTANDER, () => db.query(
        'SELECT public.digest($1::text, $2::text)',
        ['nightwatch', 'sha256'],
      )),
      (err) => /permission denied/i.test(errText(err)),
    );
    console.log(`ok - GREEN stock pgcrypto ${pgcryptoSig} is no longer ambient-callable`);
  }
  console.log('ok - GREEN post-096 ambient PUBLIC EXECUTE is gone; owner and explicit grants remain');

  const adopted = await adoptWorker(db);
  assert.equal(adopted.ok, true);
  assert.equal(adopted.roleAction, 'trusted_precreated');
  assert.equal(adopted.mappingAction, 'insert');
  const rerun = await adoptWorker(db);
  assert.equal(rerun.roleAction, 'verify_noop');
  console.log('ok - GREEN trusted-precreated adoption permits only the contract allowlist');

  await db.exec('CREATE FUNCTION public.luna_ch4c1_after() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$');
  const afterPublic = await publicExecute(db, AFTER);
  const expectDefaultPrivileges = options && options.expectDefaultPrivileges === true;
  if (expectDefaultPrivileges) {
    assert.equal(afterPublic, false);
    assert.equal(await roleExecute(db, BYSTANDER, AFTER), false);
    assert.equal(await roleExecute(db, 'postgres', AFTER), true);
    const recorded = await db.query(`
      SELECT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_default_acl d
          JOIN pg_catalog.pg_roles r ON r.oid = d.defaclrole
          LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
         WHERE r.rolname = 'postgres'
           AND d.defaclobjtype = 'f'
           AND (d.defaclnamespace = 0 OR n.nspname = 'public')
      ) AS ok
    `);
    assert.equal(recorded.rows[0].ok, true, 'stock-PG must record pg_default_acl');
    assert.equal(await ownerDefaultPublicExecute(db, 'postgres'), false);
    console.log('ok - GREEN newly created functions default non-PUBLIC after 096 (stock-PG default privileges)');
  } else if (afterPublic) {
    console.log('ok - PGlite ALTER DEFAULT PRIVILEGES is a no-op (pg_default_acl not persisted); stock-PG proves the default-privilege gate');
    await assert.rejects(
      () => adoptWorker(db),
      (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_EXECUTE',
    );
    await db.exec('REVOKE EXECUTE ON FUNCTION public.luna_ch4c1_after() FROM PUBLIC');
    const recovered = await adoptWorker(db);
    assert.equal(recovered.roleAction, 'verify_noop');
  } else {
    assert.equal(await roleExecute(db, BYSTANDER, AFTER), false);
    console.log('ok - GREEN newly created functions default non-PUBLIC after 096');
  }

  await db.exec('GRANT EXECUTE ON FUNCTION public.luna_ch4c1_after() TO PUBLIC');
  await assert.rejects(
    () => adoptWorker(db),
    (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_EXECUTE',
  );
  await db.exec('REVOKE EXECUTE ON FUNCTION public.luna_ch4c1_after() FROM PUBLIC');
  const afterRevoke = await adoptWorker(db);
  assert.equal(afterRevoke.roleAction, 'verify_noop');
  console.log('ok - GREEN ambient audit still catches reintroduced PUBLIC EXECUTE');

  if (pgcryptoSig) {
    try {
      await db.exec('DROP EXTENSION IF EXISTS pgcrypto');
      const recreated = await tryCreatePgcrypto(db);
      if (recreated) {
        const reintroduced = await publicExecute(db, recreated);
        if (reintroduced) {
          console.log('ok - nuance: CREATE EXTENSION after 096 reintroduced PUBLIC EXECUTE (extension script or other-owner default); audit would fail-close');
          await db.exec('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC');
        } else {
          console.log('ok - nuance: CREATE EXTENSION after 096 as applying owner inherited non-PUBLIC default privileges');
        }
      }
    } catch (err) {
      console.log(`ok - pgcrypto recreate nuance skipped (${errText(err).split('\n')[0]})`);
    }
  }

  const beforeDown = await snapshotPublicExecuteAcls(db);
  assert.equal(beforeDown.canaryPublic, false);
  assert.equal(beforeDown.canaryBystander, false, 'arbitrary LOGIN denied before down');
  assert.equal(beforeDown.canaryOwner, true, 'owner remains before down');
  assert.equal(beforeDown.namedGrantee, true, 'explicit grant remains before down');
  assert.equal(beforeDown.namedBystander, false);
  assert.equal(beforeDown.enqueueBystander, false);
  assert.equal(beforeDown.afterPublic, false, 'newly created owner functions are non-PUBLIC before down');
  assert.equal(beforeDown.afterBystander, false);
  assert.equal(beforeDown.afterOwner, true);
  if (expectDefaultPrivileges) {
    assert.equal(beforeDown.ownerDefaultPublic, false);
  }

  await refuseDown(db);
  const afterDown = await snapshotPublicExecuteAcls(db);
  assert.deepEqual(afterDown, beforeDown, 'refused 096_down must leave post-096 ACLs/defaults unchanged');
  assert.equal(afterDown.canaryBystander, false, 'arbitrary LOGIN remains denied');
  assert.equal(afterDown.canaryOwner, true, 'owner remains');
  assert.equal(afterDown.namedGrantee, true, 'explicit grant remains');
  assert.equal(afterDown.afterPublic, false, 'newly created owner functions remain non-PUBLIC');
  const stillAdopted = await adoptWorker(db);
  assert.equal(stillAdopted.ok, true);
  assert.equal(stillAdopted.roleAction, 'verify_noop', 'adoption remains contract-only');

  if (expectDefaultPrivileges) {
    await db.exec('CREATE FUNCTION public.luna_ch4c1_still() RETURNS int LANGUAGE sql AS $$ SELECT 4 $$');
    assert.equal(await publicExecute(db, STILL), false);
    assert.equal(await roleExecute(db, BYSTANDER, STILL), false);
    assert.equal(await roleExecute(db, 'postgres', STILL), true);
    assert.equal(await ownerDefaultPublicExecute(db, 'postgres'), false);
    console.log('ok - GREEN refused 096_down left stock-PG default privileges unreverted');
  }

  await refuseDown(db);
  const afterRepeat = await snapshotPublicExecuteAcls(db);
  assert.deepEqual(afterRepeat, beforeDown, 'repeat 096_down refusal must leave post-096 ACLs/defaults unchanged');
  const afterRepeatAdopt = await adoptWorker(db);
  assert.equal(afterRepeatAdopt.roleAction, 'verify_noop');
  console.log('ok - GREEN 096 down refuses atomically, mutates no ACLs, and is repeat-safe');
}

async function createExtensionPgcrypto13(db) {
  try {
    await db.exec("CREATE EXTENSION pgcrypto VERSION '1.3'");
  } catch (err) {
    const text = errText(err);
    if (!/already exists/i.test(text)) throw err;
  }
  const ver = await db.query(`SELECT extversion FROM pg_catalog.pg_extension WHERE extname = 'pgcrypto'`);
  return ver.rows[0] && ver.rows[0].extversion;
}

async function proveNonSuperuserPgcryptoResidual(db, options) {
  const realPgcrypto = options && options.realPgcrypto === true;
  const expectDefaultPrivileges = options && options.expectDefaultPrivileges === true;
  const splitWorker = 'luna_ch4c1_split_worker';
  const splitBystander = 'luna_ch4c1_split_bystander';
  const splitGrantee = 'luna_ch4c1_split_grantee';

  await db.exec(createRoleSql(APPOWNER, b1.PASSWORD));
  await db.exec(createRoleSql(EXTOWNER, b1.PASSWORD));
  await db.exec(createRoleSql(splitBystander, b1.PASSWORD));
  await db.exec(createRoleSql(splitGrantee, b1.PASSWORD));
  await db.exec(createRoleSql(splitWorker, b1.PASSWORD));
  await db.exec(`GRANT USAGE, CREATE ON SCHEMA public TO ${APPOWNER}`);
  await db.exec(`GRANT USAGE, CREATE ON SCHEMA public TO ${EXTOWNER}`);

  await withSession(db, APPOWNER, async () => {
    await applyThrough095(db);
    await db.exec(`
      CREATE FUNCTION public.luna_ch4c1_canary() RETURNS int LANGUAGE sql AS $$ SELECT 42 $$;
      CREATE FUNCTION public.luna_ch4c1_named(p int) RETURNS int LANGUAGE sql AS $$ SELECT p $$;
    `);
    await db.exec(`GRANT EXECUTE ON FUNCTION public.luna_ch4c1_named(int) TO ${splitGrantee}`);
  });

  if (realPgcrypto) {
    const version = await createExtensionPgcrypto13(db);
    assert.equal(version, '1.3', `stock-PG must install pgcrypto 1.3, got ${version}`);
    const coreUuid = await db.query(`
      SELECT n.nspname, l.lanname, e.extname
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_catalog.pg_language l ON l.oid = p.prolang
        LEFT JOIN pg_catalog.pg_depend d
          ON d.objid = p.oid
         AND d.deptype = 'e'
         AND d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
        LEFT JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
       WHERE p.proname = 'gen_random_uuid'
         AND pg_catalog.oidvectortypes(p.proargtypes) = ''
       ORDER BY n.nspname
    `);
    const core = coreUuid.rows.find((row) => row.nspname === 'pg_catalog');
    const ext = coreUuid.rows.find((row) => row.nspname === 'public');
    if (core) {
      assert.equal(core.extname == null, true, 'pg_catalog.gen_random_uuid() is core, not pgcrypto');
      assert.equal(core.lanname === 'internal' || core.lanname === 'c', true);
    }
    assert.ok(ext, 'public.gen_random_uuid() must exist as pgcrypto 1.3 member');
    assert.equal(ext.extname, 'pgcrypto');
    assert.equal(ext.lanname, 'c');
    console.log('ok - gen_random_uuid core vs pgcrypto membership is catalog-honest');

    await withSession(db, APPOWNER, async () => {
      await assert.rejects(() => db.exec(PRE_CORRECTION_UP), isResidualRefuse);
    });
    console.log('ok - RED pre-correction 096 rolls back when extension-owned pgcrypto remains');

    await withSession(db, APPOWNER, async () => {
      await db.exec(UP);
    });
    const residual = await remainingPublicSignatures(db);
    assert.deepEqual(residual.slice().sort(), PGCRYPTO_1_3_SIGNATURES.slice().sort());
    assert.equal(await publicExecute(db, CANARY), false);
    assert.equal(await roleExecute(db, splitBystander, CANARY), false);
    assert.equal(await roleExecute(db, APPOWNER, CANARY), true);
    assert.equal(await roleExecute(db, splitGrantee, NAMED), true);
    assert.equal(await publicExecute(db, 'digest(text, text)'), true);
    assert.equal(await roleExecute(db, splitBystander, 'digest(text, text)'), true);
    await assert.rejects(
      () => b1.asRole(db, splitBystander, () => db.query('SELECT public.luna_ch4c1_canary() AS n')),
      (err) => /permission denied/i.test(errText(err)),
    );
    const digestCall = await b1.asRole(db, splitBystander, () => db.query(
      'SELECT pg_catalog.encode(public.digest($1::bytea, $2::text), \'hex\') AS d',
      [Buffer.from('nightwatch'), 'sha256'],
    ));
    assert.equal(typeof digestCall.rows[0].d, 'string');
    assert.equal(digestCall.rows[0].d.length, 64);
    console.log('ok - GREEN corrected 096 succeeds with exact pgcrypto 1.3 residual; owner funcs lose PUBLIC; grants survive');

    const adopted = await adoptWorker(db, splitWorker);
    assert.equal(adopted.ok, true);
    assert.equal(adopted.ambient_pgcrypto_residual.extversion, '1.3');
    assert.equal(adopted.worker_pgcrypto_residual_capability.computationalOnly, true);
    assert.equal(adopted.worker_pgcrypto_residual_capability.databaseRead, false);
    assert.equal(adopted.worker_pgcrypto_residual_capability.databaseWrite, false);
    const workerDigest = await b1.asRole(db, splitWorker, () => db.query(
      'SELECT pg_catalog.encode(public.digest($1::bytea, $2::text), \'hex\') AS d',
      [Buffer.from('nightwatch'), 'sha256'],
    ));
    assert.equal(workerDigest.rows[0].d.length, 64);
    assert.equal(await roleExecute(db, splitWorker, 'digest(text, text)'), true);
    const clientsSelect = await db.query(
      `SELECT pg_catalog.has_table_privilege($1, 'public.clients'::pg_catalog.regclass, 'SELECT') AS ok`,
      [splitWorker],
    );
    assert.equal(clientsSelect.rows[0].ok, false);
    const queueInsert = await db.query(
      `SELECT pg_catalog.has_table_privilege($1, 'public.tenant_email_luna_automation_queue'::pg_catalog.regclass, 'INSERT') AS ok`,
      [splitWorker],
    );
    assert.equal(queueInsert.rows[0].ok, false);
    const queueUpdate = await db.query(
      `SELECT pg_catalog.has_table_privilege($1, 'public.tenant_email_luna_automation_queue'::pg_catalog.regclass, 'UPDATE') AS ok`,
      [splitWorker],
    );
    assert.equal(queueUpdate.rows[0].ok, false);
    await assert.rejects(
      () => b1.asRole(db, splitWorker, () => db.query('SELECT public.luna_ch4c1_canary() AS n')),
      (err) => /permission denied/i.test(errText(err)),
    );
    console.log('ok - GREEN principal adoption permits contract + frozen pgcrypto; residual has no database read/write authority');

    await db.exec(`
      CREATE FUNCTION public.luna_ch4c1_fake_digest(text) RETURNS bytea
      LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT '\\x'::bytea $$;
    `);
    await db.exec(`ALTER FUNCTION public.luna_ch4c1_fake_digest(text) OWNER TO ${EXTOWNER}`);
    await withSession(db, APPOWNER, async () => {
      await assert.rejects(() => db.exec(UP), isResidualRefuse);
    });
    await db.exec('DROP FUNCTION public.luna_ch4c1_fake_digest(text)');
    console.log('ok - GREEN fake same-name/non-extension member fails closed');

    await db.exec(`
      CREATE FUNCTION public.digest(integer) RETURNS bytea
      LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT '\\x'::bytea $$;
    `);
    await db.exec(`ALTER FUNCTION public.digest(integer) OWNER TO ${EXTOWNER}`);
    await withSession(db, APPOWNER, async () => {
      await assert.rejects(() => db.exec(UP), isResidualRefuse);
    });
    await db.exec('DROP FUNCTION public.digest(integer)');
    console.log('ok - GREEN non-extension same-name overload fails closed');

    await db.exec('ALTER FUNCTION public.digest(text, text) SECURITY DEFINER');
    await withSession(db, APPOWNER, async () => {
      await assert.rejects(() => db.exec(UP), isResidualRefuse);
    });
    await db.exec('ALTER FUNCTION public.digest(text, text) SECURITY INVOKER');
    console.log('ok - GREEN SECURITY DEFINER pgcrypto member fails closed');

    await db.exec('ALTER FUNCTION public.digest(text, text) VOLATILE');
    await withSession(db, APPOWNER, async () => {
      await assert.rejects(() => db.exec(UP), isResidualRefuse);
    });
    await db.exec('ALTER FUNCTION public.digest(text, text) IMMUTABLE');
    console.log('ok - GREEN wrong pgcrypto properties fail closed');

    await db.exec('ALTER FUNCTION public.digest(text, text) SET search_path = pg_catalog');
    const proconfig = await db.query(`
      SELECT pg_catalog.cardinality(p.proconfig) AS n
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'digest'
         AND pg_catalog.oidvectortypes(p.proargtypes) = 'text, text'
    `);
    assert.ok(Number(proconfig.rows[0].n) > 0, 'catalog-proven pgcrypto member must have nonempty proconfig');
    await withSession(db, APPOWNER, async () => {
      await assert.rejects(() => db.exec(UP), isResidualRefuse);
    });
    await assert.rejects(
      () => adoptWorker(db, splitWorker),
      (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_EXECUTE',
    );
    await db.exec('ALTER FUNCTION public.digest(text, text) RESET search_path');
    const resetCfg = await db.query(`
      SELECT COALESCE(pg_catalog.cardinality(p.proconfig), 0) AS n
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'digest'
         AND pg_catalog.oidvectortypes(p.proargtypes) = 'text, text'
    `);
    assert.equal(Number(resetCfg.rows[0].n), 0);
    const recoveredCfg = await adoptWorker(db, splitWorker);
    assert.equal(recoveredCfg.roleAction, 'verify_noop');
    console.log('ok - GREEN nonempty proconfig on catalog-proven pgcrypto fails 096 and principal audit');

    await db.exec(`
      CREATE PROCEDURE public.luna_ch4c1_proc()
      LANGUAGE sql
      AS $$ SELECT 1 $$;
    `);
    await db.exec(`ALTER PROCEDURE public.luna_ch4c1_proc() OWNER TO ${EXTOWNER}`);
    await withSession(db, APPOWNER, async () => {
      await assert.rejects(() => db.exec(UP), isResidualRefuse);
    });
    await db.exec('DROP PROCEDURE public.luna_ch4c1_proc()');
    console.log('ok - GREEN arbitrary PUBLIC procedure fails closed');

    await db.exec(`
      CREATE AGGREGATE public.luna_ch4c1_agg(integer) (
        SFUNC = pg_catalog.int4pl,
        STYPE = integer
      );
    `);
    await db.exec(`ALTER AGGREGATE public.luna_ch4c1_agg(integer) OWNER TO ${EXTOWNER}`);
    await withSession(db, APPOWNER, async () => {
      await assert.rejects(() => db.exec(UP), isResidualRefuse);
    });
    await db.exec('DROP AGGREGATE public.luna_ch4c1_agg(integer)');
    console.log('ok - GREEN arbitrary PUBLIC aggregate fails closed');

    await db.exec(`
      CREATE FUNCTION public.luna_ch4c1_pgcrypto_extra() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
    `);
    await db.exec('ALTER EXTENSION pgcrypto ADD FUNCTION public.luna_ch4c1_pgcrypto_extra()');
    await withSession(db, APPOWNER, async () => {
      await assert.rejects(() => db.exec(UP), isResidualRefuse);
    });
    await db.exec('ALTER EXTENSION pgcrypto DROP FUNCTION public.luna_ch4c1_pgcrypto_extra()');
    await db.exec('DROP FUNCTION public.luna_ch4c1_pgcrypto_extra()');
    console.log('ok - GREEN extra pgcrypto extension member fails closed');

    await db.exec(`
      CREATE FUNCTION public.luna_ch4c1_arbitrary() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
    `);
    await db.exec(`ALTER FUNCTION public.luna_ch4c1_arbitrary() OWNER TO ${EXTOWNER}`);
    await withSession(db, APPOWNER, async () => {
      await assert.rejects(() => db.exec(UP), isResidualRefuse);
    });
    await db.exec('DROP FUNCTION public.luna_ch4c1_arbitrary()');
    console.log('ok - GREEN arbitrary public function fails closed');

    await withSession(db, APPOWNER, async () => {
      await db.exec(UP);
      await db.exec('CREATE FUNCTION public.luna_ch4c1_after() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$');
    });
    if (expectDefaultPrivileges) {
      assert.equal(await publicExecute(db, AFTER), false);
      assert.equal(await roleExecute(db, splitBystander, AFTER), false);
      assert.equal(await roleExecute(db, APPOWNER, AFTER), true);
      console.log('ok - GREEN newly created owner functions default non-PUBLIC');
    }

    await db.exec('GRANT EXECUTE ON FUNCTION public.luna_ch4c1_after() TO PUBLIC');
    await assert.rejects(
      () => adoptWorker(db, splitWorker),
      (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_EXECUTE',
    );
    await db.exec('REVOKE EXECUTE ON FUNCTION public.luna_ch4c1_after() FROM PUBLIC');
    const recovered = await adoptWorker(db, splitWorker);
    assert.equal(recovered.roleAction, 'verify_noop');
    console.log('ok - GREEN reintroduction of non-allowlisted PUBLIC is still EXCESS_EXECUTE');

    await withSession(db, APPOWNER, async () => {
      await refuseDown(db);
    });
    const afterDown = await remainingPublicSignatures(db);
    assert.deepEqual(afterDown.slice().sort(), PGCRYPTO_1_3_SIGNATURES.slice().sort());
    console.log('ok - GREEN 096 down remains refusal-only and leaves residual unchanged');
    return;
  }

  await withSession(db, EXTOWNER, async () => {
    await db.exec(`
      CREATE FUNCTION public.digest(text, text) RETURNS bytea
      LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT '\\x'::bytea $$;
    `);
  });
  await withSession(db, APPOWNER, async () => {
    await assert.rejects(() => db.exec(PRE_CORRECTION_UP), isResidualRefuse);
  });
  await withSession(db, APPOWNER, async () => {
    await assert.rejects(() => db.exec(UP), isResidualRefuse);
  });
  console.log('ok - PGlite fake same-name non-extension digest remains fail-closed (pre-correction and corrected 096)');

  await db.exec('DROP FUNCTION public.digest(text, text)');
  await withSession(db, APPOWNER, async () => {
    await db.exec(UP);
  });
  assert.deepEqual(await remainingPublicSignatures(db), []);
  assert.equal(await publicExecute(db, CANARY), false);
  console.log('ok - PGlite corrected 096 succeeds with empty residual when no proven pgcrypto exists');

  await withSession(db, EXTOWNER, async () => {
    await db.exec(`
      CREATE FUNCTION public.luna_ch4c1_secdef() RETURNS int
      LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
    `);
  });
  await withSession(db, APPOWNER, async () => {
    await assert.rejects(() => db.exec(UP), isResidualRefuse);
  });
  await db.exec('DROP FUNCTION public.luna_ch4c1_secdef()');
  console.log('ok - PGlite SECURITY DEFINER arbitrary function fails closed');

  await withSession(db, EXTOWNER, async () => {
    await db.exec(`
      CREATE FUNCTION public.luna_ch4c1_arbitrary() RETURNS int LANGUAGE sql AS $$ SELECT 7 $$;
    `);
  });
  await withSession(db, APPOWNER, async () => {
    await assert.rejects(() => db.exec(UP), isResidualRefuse);
  });
  await db.exec('DROP FUNCTION public.luna_ch4c1_arbitrary()');
  console.log('ok - PGlite arbitrary public function fails closed');
  console.log('ok - PGlite limitation: real CREATE EXTENSION pgcrypto and catalog-proven residual are stock-PG proofs');
}

async function proveMissingQueue(PGlite) {
  const db = new PGlite();
  await assert.rejects(
    () => db.exec(UP),
    (err) => matchesSql(err, 'queue table owner missing', '23514'),
  );
  try { await db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
  await assert.rejects(
    () => db.exec(DOWN),
    isDownRefused,
  );
  console.log('ok - GREEN missing queue fail-closes 096 and 096_down');
}

function runPgliteProof() {
  assertStaticContract();
  const PGlite = tryLoadPglite();
  if (!PGlite) {
    console.log('ok - pglite unavailable; static C1 public EXECUTE contract only');
    return Promise.resolve();
  }
  return Promise.resolve().then(async () => {
    const db = new PGlite();
    await applyThrough095(db);
    await provePublicExecuteOnDatabase(db, { tryPgcrypto: false, expectDefaultPrivileges: false });
    const split = new PGlite();
    await proveNonSuperuserPgcryptoResidual(split, { realPgcrypto: false, expectDefaultPrivileges: false });
    await proveMissingQueue(PGlite);
    console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice C1 public EXECUTE pglite');
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
  assertStaticContract,
  applyThrough095,
  provePublicExecuteOnDatabase,
  proveNonSuperuserPgcryptoResidual,
  proveMissingQueue,
  tryLoadPglite,
  isDownRefused,
  isResidualRefuse,
  UP,
  DOWN,
  PRE_CORRECTION_UP,
};
