'use strict';

/**
 * Prove Ch4 Slice B6 095 scoped claim + activation-safety against 088-094.
 * Default-off. No provider. No journal terminal. No live DB.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const b1 = require('./prove-email-luna-automation-issuance-material-pglite');
const b4 = require('./prove-email-luna-automation-shadow-comparison-pglite');
const {
  provisionEmailLunaAutomationPrincipal,
} = require('./lib/email-luna-automation-principal-provision');
const {
  FUNCTION_SIGNATURES,
} = require('./lib/email-luna-automation-principal-contract');


const ROOT = path.resolve(__dirname, '..');
const RED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-shadow-activation-safety-red.json'),
  'utf8',
));
const UP_095 = fs.readFileSync(path.join(ROOT, 'database/migrations/095_tenant_email_luna_automation_claim_scoped.sql'), 'utf8');
const DOWN_095 = fs.readFileSync(path.join(ROOT, 'database/migrations/095_tenant_email_luna_automation_claim_scoped_down.sql'), 'utf8');
const WORKER_ROLE = 'luna_ch4b6_worker';
const PRODUCER_ROLE = 'luna_ch4b6_producer';

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
  assert.equal(RED.id, 'email-luna-automation-shadow-activation-safety.ch4b6-red.v1');
  assert.equal(RED.head_reviewed, '5054b86647a2aaf28d65a5e180345a6526cde067');
  assert.equal(/^\s*GRANT /m.test(UP_095), false);
  assert.equal(/^\s*CREATE ROLE/m.test(UP_095), false);
  assert.match(UP_095, /FOR UPDATE SKIP LOCKED/);
  assert.match(DOWN_095, /095_down_refused/);
  console.log('ok - static B6 095 contract');
}

async function provePglite(PGlite) {
  const ids = b1.ids;
  const db = new PGlite();
  await b1.applyThrough088(db);
  await db.exec(b1.UP);
  await db.exec(b4.UP_093);
  await db.exec(b4.UP_094);
  await db.exec(UP_095);
  await db.exec(DOWN_095);
  await db.exec(DOWN_095);
  console.log('ok - empty 095 down is repeatable');
  await db.exec(UP_095);
  await b1.revokePublicExecuteOutsideCatalogs(db);

  await provisionEmailLunaAutomationPrincipal(b1.exclusiveSession(db), {
    roleName: WORKER_ROLE,
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: b1.PASSWORD,
    apply: true,
  });
  await provisionEmailLunaAutomationPrincipal(b1.exclusiveSession(db), {
    roleName: PRODUCER_ROLE,
    kind: 'producer',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: b1.PASSWORD,
    apply: true,
  });

  const scopedSig = `public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_claim_scoped}`;
  const unscopedSig = `public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_claim}`;
  const workerScoped = await db.query(
    `SELECT pg_catalog.has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`,
    [WORKER_ROLE, scopedSig],
  );
  const producerScoped = await db.query(
    `SELECT pg_catalog.has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`,
    [PRODUCER_ROLE, scopedSig],
  );
  const publicScoped = await db.query(
    `SELECT pg_catalog.has_function_privilege('public', $1::regprocedure, 'EXECUTE') AS ok`,
    [scopedSig],
  );
  assert.equal(workerScoped.rows[0].ok, true);
  assert.equal(producerScoped.rows[0].ok, false);
  assert.equal(publicScoped.rows[0].ok, false);
  const workerUnscoped = await db.query(
    `SELECT pg_catalog.has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`,
    [WORKER_ROLE, unscopedSig],
  );
  assert.equal(workerUnscoped.rows[0].ok, true, '088 unscoped claim remains granted to worker');
  console.log('ok - ACL: worker EXECUTE on 095 scoped claim; producer/PUBLIC denied; 088 claim unchanged');

  const owners = b4.loadOwners();
  const ownerLoaner = {
    async withTransactionClient(work) {
      await db.exec('SET SESSION AUTHORIZATION postgres');
      return b1.createLoaner(db).withTransactionClient(work);
    },
  };
  const workerLoaner = {
    async withTransactionClient(work) {
      await db.exec(`SET SESSION AUTHORIZATION ${WORKER_ROLE}`);
      try {
        return await work({
          async query(text, params) {
            return db.query(text, params);
          },
        });
      } finally {
        await db.exec('SET SESSION AUTHORIZATION postgres');
      }
    },
  };

  await db.exec('SET session_replication_role = replica');
  await db.query(
    `INSERT INTO public.tenant_email_luna_automation_queue (
       operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key,
       endpoint_id, conversation_id, inbound_event_id, recipient_address, recipient_digest,
       policy_version, eligibility_policy_version, validator_version, draft_digest,
       state, attempt_count, created_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'sunset-sardinero',
       $6::uuid, $7::uuid, $8::uuid, 'other.guest@example.test',
       pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('other.guest@example.test', 'UTF8')), 'hex'),
       'email-luna-draft-policy.v1',
       'email-luna-autonomous-eligibility-policy.v1',
       'email-luna-draft-validator.v1',
       $9,
       'pending', 0, pg_catalog.now() - INTERVAL '1 hour'
     )`,
    [
      ids.operation2,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ids.auditB,
      ids.client2,
      ids.location2,
      ids.endpoint2,
      ids.conversation2,
      ids.inbound2,
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ],
  );
  await db.exec('SET session_replication_role = DEFAULT');
  await b4.persistPending(owners, ownerLoaner, ids, ids.operation);
  const foreignBefore = await db.query(
    `SELECT state, attempt_count, lease_owner FROM public.tenant_email_luna_automation_queue WHERE operation_id = $1`,
    [ids.operation2],
  );
  assert.equal(foreignBefore.rows[0].state, 'pending');
  assert.equal(Number(foreignBefore.rows[0].attempt_count), 0);

  await db.exec('SET SESSION AUTHORIZATION postgres');
  const ownerScoped = await db.query(
    `SELECT operation_id FROM public.tenant_email_luna_automation_claim_scoped($1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid)`,
    [ids.ownerA, ids.client, ids.location, 'sunset-somo', ids.endpoint],
  );
  assert.equal(ownerScoped.rows.length, 0, 'table owner cannot use 095 scoped claim');

  const kernel = owners.createEmailLunaAutomationShadowWorkerKernel(
    b4.workerDeps(workerLoaner, ids.client, ids.location, ids.ownerA),
  );
  const first = await kernel.processNextShadowClaim();
  assert.equal(first.status, 'would_send');
  assert.equal(first.client_id, ids.client);
  await db.exec('SET SESSION AUTHORIZATION postgres');
  const captured = await db.query(
    'SELECT state FROM public.tenant_email_luna_automation_queue WHERE operation_id = $1',
    [ids.operation],
  );
  assert.equal(captured.rows[0].state, 'shadow_captured');
  const journal = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_outbound_send_journal');
  assert.equal(journal.rows[0].n, 0);
  const foreignAfter = await db.query(
    `SELECT state, attempt_count, lease_owner FROM public.tenant_email_luna_automation_queue WHERE operation_id = $1`,
    [ids.operation2],
  );
  assert.equal(foreignAfter.rows[0].state, foreignBefore.rows[0].state);
  assert.equal(Number(foreignAfter.rows[0].attempt_count), Number(foreignBefore.rows[0].attempt_count));
  assert.equal(foreignAfter.rows[0].lease_owner, foreignBefore.rows[0].lease_owner);
  console.log('ok - Sunset worker scoped claim captures only the bound row; older foreign row untouched; no journal');

  await db.exec(`SET SESSION AUTHORIZATION ${WORKER_ROLE}`);
  const otherTenant = await db.query(
    `SELECT operation_id FROM public.tenant_email_luna_automation_claim_scoped($1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid)`,
    [ids.ownerA, ids.client2, ids.location2, 'wolfhouse-somo', ids.endpoint2],
  );
  assert.equal(otherTenant.rows.length, 0, 'mapped Sunset worker cannot scoped-claim another tenant');
  const wrongEndpoint = await db.query(
    `SELECT operation_id FROM public.tenant_email_luna_automation_claim_scoped($1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid)`,
    [ids.ownerA, ids.client, ids.location, 'sunset-somo', ids.endpoint2],
  );
  assert.equal(wrongEndpoint.rows.length, 0, 'wrong endpoint UUID cannot claim Sunset rows');
  console.log('ok - H1/M2: owner bypass absent; other tenant and wrong endpoint cannot claim');

  await db.exec('SET SESSION AUTHORIZATION postgres');
  await db.exec(DOWN_095);
  const gone = await db.query(
    `SELECT pg_catalog.to_regprocedure('public.tenant_email_luna_automation_claim_scoped(uuid, uuid, uuid, text, uuid)') IS NOT NULL AS ok`,
  );
  assert.equal(gone.rows[0].ok, false);
  const unscopedStill = await db.query(
    `SELECT pg_catalog.to_regprocedure('public.tenant_email_luna_automation_claim(uuid, uuid)') IS NOT NULL AS ok`,
  );
  assert.equal(unscopedStill.rows[0].ok, true);
  console.log('ok - 095 down drops scoped claim only; 088 unscoped claim remains');
}

async function runPgliteProof() {
  assertStaticContract();
  const PGlite = tryLoadPglite();
  if (!PGlite) {
    console.log('SKIP pglite unavailable — static 095 contract still holds');
    return;
  }
  await provePglite(PGlite);
  console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B6 pglite');
}

if (require.main === module) {
  runPgliteProof().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { runPgliteProof, UP_095, DOWN_095 };
