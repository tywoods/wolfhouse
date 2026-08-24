'use strict';

/**
 * Prove Ch4 Slice C1 ambient PUBLIC EXECUTE hardening (096) on PGlite.
 * RED: post-095 arbitrary LOGIN with public USAGE executes ambient functions
 * and trusted-precreated adoption fails closed.
 * GREEN: 096 revokes PUBLIC EXECUTE, preserves owner + explicit grants,
 * defaults new functions non-PUBLIC, and principal audit then allowlists
 * only the contract (still catching reintroduced PUBLIC EXECUTE).
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
} = require('./lib/email-luna-automation-principal-contract');
const {
  provisionEmailLunaAutomationPrincipal,
} = require('./lib/email-luna-automation-principal-provision');

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

const BYSTANDER = 'luna_ch4c1_bystander';
const GRANTEE = 'luna_ch4c1_grantee';
const WORKER = 'luna_ch4c1_pub_worker';
const NOT_OWNER = 'luna_ch4c1_pub_notowner';
const CANARY = 'luna_ch4c1_canary()';
const NAMED = 'luna_ch4c1_named(integer)';
const AFTER = 'luna_ch4c1_after()';
const RESTORED = 'luna_ch4c1_restored()';
const ENQUEUE = FUNCTION_SIGNATURES.tenant_email_luna_automation_enqueue;

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
  assert.equal(RED.head_reviewed, '45757de136a7f7f503989511b51df7bf69b9c5c1');
  assert.equal(RED.pr_reviewed, 709);
  assert.equal(RED.findings.length, 3);
  assert.match(UP, /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC/);
  assert.match(UP, /ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/);
  assert.match(UP, /ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/);
  assert.equal(/^\s*GRANT /m.test(UP), false);
  assert.equal(/^\s*CREATE ROLE/m.test(UP), false);
  assert.match(DOWN, /096_down_refused/);
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

async function adoptWorker(db) {
  return provisionEmailLunaAutomationPrincipal(b1.exclusiveSession(db), {
    roleName: WORKER,
    kind: 'worker',
    client_id: b1.ids.client,
    location_id: b1.ids.location,
    location_key: 'sunset-somo',
    trustedPrecreated: true,
    apply: true,
  });
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

  await db.exec(DOWN);
  assert.equal(await publicExecute(db, CANARY), true);
  assert.equal(await roleExecute(db, BYSTANDER, CANARY), true);
  assert.equal(await roleExecute(db, BYSTANDER, ENQUEUE), false, 'down re-seals Luna functions');
  await db.exec('CREATE FUNCTION public.luna_ch4c1_restored() RETURNS int LANGUAGE sql AS $$ SELECT 3 $$');
  assert.equal(await publicExecute(db, RESTORED), true);
  await db.exec(DOWN);
  console.log('ok - GREEN 096 down restores defaults, re-seals Luna, and is repeatable');
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
    (err) => matchesSql(err, '096_down_refused', '23514'),
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
  proveMissingQueue,
  tryLoadPglite,
  UP,
  DOWN,
};
