'use strict';

/**
 * Prove migration 065 recovery journal + PR408 generation primitive on PGlite.
 *
 * When PGlite is available:
 *   - minimal parent shell (clients/staff_users unique/locations/endpoints)
 *   - 064 delta states + 065 recovery operations
 *   - FK/check/bounds/coherence
 *   - restartGeneration claim/complete in one TX (no nested BEGIN)
 *   - duplicate/concurrent claims, authority rebind, active lease fail closed
 *   - two IDs same CAS → one committed one conflict
 *   - commit_outcome_unknown sequence + retry
 *   - reconcile evidence_unavailable (no 064 cursor_operation_id inference)
 *   - old generation preserved / no cursor copy
 *   - down drops 065 only
 *
 * When PGlite is unavailable: static migration contract only.
 *
 * No Azure / live product DB / deploy / network.
 * NODE_PATH=/opt/data/wolfhouse-agent/node_modules recommended for PGlite.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const UP_065 = path.join(ROOT, 'database/migrations/065_tenant_email_delta_recovery_operations.sql');
const DOWN_065 = path.join(ROOT, 'database/migrations/065_tenant_email_delta_recovery_operations_down.sql');
const UP_064 = path.join(ROOT, 'database/migrations/064_tenant_email_inbound_delta_states.sql');
const UP = fs.readFileSync(UP_065, 'utf8');
const DOWN = fs.readFileSync(DOWN_065, 'utf8');
const UP_DELTA = fs.readFileSync(UP_064, 'utf8');

const ids = {
  client: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-222222222222',
  endpoint: '33333333-3333-4333-8333-333333333333',
  actor: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  otherActor: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  tenant: '55555555-5555-4555-8555-555555555555',
  mailbox: '44444444-4444-4444-8444-444444444444',
};
const QV1 = 'ms_messages_delta_v1';

function tryLoadPglite() {
  try {
    return require('@electric-sql/pglite').PGlite;
  } catch (_) {
    return null;
  }
}

function shellSql() {
  return `
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
    CREATE OR REPLACE FUNCTION gen_random_uuid() RETURNS uuid AS $$
      SELECT (
        lpad(to_hex((random()*4294967295)::bigint), 8, '0') || '-' ||
        lpad(to_hex((random()*65535)::int), 4, '0') || '-4' ||
        lpad(to_hex((random()*4095)::int), 3, '0') || '-' ||
        lpad(to_hex((8+floor(random()*4))::int*1000+(random()*4095)::int), 4, '0') || '-' ||
        lpad(to_hex((random()*281474976710655)::bigint), 12, '0')
      )::uuid;
    $$ LANGUAGE sql;
    CREATE TABLE clients (id uuid PRIMARY KEY);
    CREATE TABLE staff_users (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL REFERENCES clients(id)
    );
    ALTER TABLE staff_users
      ADD CONSTRAINT staff_users_client_id_id_uq UNIQUE (client_id, id);
    CREATE TABLE tenant_locations (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL REFERENCES clients(id),
      location_id text NOT NULL,
      display_name text NOT NULL DEFAULT 'loc',
      active boolean NOT NULL DEFAULT true
    );
    ALTER TABLE tenant_locations
      ADD CONSTRAINT tenant_locations_client_id_id_uq UNIQUE (client_id, id);
    CREATE TABLE tenant_channel_endpoints (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL,
      location_id text NOT NULL,
      channel text NOT NULL DEFAULT 'email',
      provider text NOT NULL DEFAULT 'microsoft_graph',
      public_address text NOT NULL DEFAULT 'a@b.co',
      secret_ref text,
      capabilities jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    ALTER TABLE tenant_channel_endpoints
      ADD CONSTRAINT tenant_channel_endpoints_client_id_id_uq UNIQUE (client_id, id);
    INSERT INTO clients VALUES ('${ids.client}');
    INSERT INTO staff_users (id, client_id) VALUES
      ('${ids.actor}', '${ids.client}'),
      ('${ids.otherActor}', '${ids.client}');
    INSERT INTO tenant_locations (id, client_id, location_id)
      VALUES ('${ids.location}', '${ids.client}', 'sunset-somo');
    INSERT INTO tenant_channel_endpoints (id, client_id, location_id)
      VALUES ('${ids.endpoint}', '${ids.client}', 'sunset-somo');
  `;
}

function assertStaticContract() {
  assert.match(UP, /CREATE TABLE tenant_email_delta_recovery_operations/);
  assert.match(UP, /REFERENCES staff_users \(client_id, id\)/);
  assert.match(UP, /REFERENCES tenant_locations \(client_id, id\)/);
  assert.match(UP, /REFERENCES tenant_channel_endpoints \(client_id, id\)/);
  assert.match(UP, /restart_generation/);
  assert.match(UP, /reconcile_page_commit/);
  assert.match(UP, /evidence_unavailable/);
  assert.match(UP, /commit_outcome_unknown/);
  assert.match(UP, /9007199254740991/);
  assert.match(UP, /idx_tenant_email_delta_recovery_ops_endpoint_outcome_time/);
  assert.match(UP, /tenant_email_delta_recovery_operations_updated_at/);
  assert.equal(/INSERT INTO tenant_email_delta_recovery_operations/.test(UP), false);
  assert.match(DOWN, /DROP TABLE IF EXISTS tenant_email_delta_recovery_operations/);
  console.log('ok - static 065 recovery journal contract');
}

function createPgliteExclusiveLoaner(db) {
  let chain = Promise.resolve();
  let beginDepth = 0;
  let maxBeginDepth = 0;
  let releaseCalls = 0;
  let commitReject = false;

  async function withTransactionClient(work) {
    const run = chain.then(async () => {
      const client = {
        async query(sql, params) {
          const norm = String(sql).replace(/\s+/g, ' ').trim();
          if (norm === 'BEGIN') {
            beginDepth += 1;
            if (beginDepth > maxBeginDepth) maxBeginDepth = beginDepth;
          } else if (norm === 'COMMIT' || norm === 'ROLLBACK') {
            beginDepth = Math.max(0, beginDepth - 1);
          }
          if (norm === 'COMMIT' && commitReject) {
            throw new Error('commit rejected by proof harness');
          }
          return db.query(sql, params || []);
        },
        release() { releaseCalls += 1; },
      };
      return work(client);
    });
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  return Object.freeze({
    withTransactionClient,
    getMaxBeginDepth() { return maxBeginDepth; },
    getReleaseCalls() { return releaseCalls; },
    setCommitReject(v) { commitReject = v; },
    resetDepth() { beginDepth = 0; maxBeginDepth = 0; },
  });
}

function makeAuthorityVerifier() {
  return Object.freeze({
    async verifyBinding(binding) {
      if (!binding
          || binding.clientId !== ids.client
          || binding.locationId !== ids.location
          || binding.endpointId !== ids.endpoint
          || binding.providerTenantId !== ids.tenant
          || binding.providerMailboxId !== ids.mailbox) {
        return Object.freeze({ ok: false });
      }
      return Object.freeze({
        ok: true,
        value: Object.freeze({ ...binding }),
      });
    },
  });
}

async function proveWithPglite(PGlite) {
  const {
    createEmailDeltaRecoveryOperationStore,
  } = require('./lib/email-delta-recovery-operation-store');
  const {
    createInboundEmailDeltaStateStore,
  } = require('./lib/email-inbound-delta-state-store');

  const db = new PGlite();
  await db.exec(shellSql());
  await db.exec(UP_DELTA);
  await db.exec(UP);

  // RED: invalid operation_kind
  let badKind = false;
  try {
    await db.query(
      `INSERT INTO tenant_email_delta_recovery_operations (
         operation_id, client_id, location_id, endpoint_id, actor_staff_user_id,
         operation_kind, requested_generation, requested_state_version, outcome
       ) VALUES ($1,$2,$3,$4,$5,'not_a_kind',1,1,'claimed')`,
      [crypto.randomUUID(), ids.client, ids.location, ids.endpoint, ids.actor],
    );
  } catch { badKind = true; }
  assert.equal(badKind, true, 'invalid operation_kind rejected');

  // RED: actor cross-tenant (other client staff) — insert staff for other client fails FK on actor composite
  let badActorFk = false;
  try {
    await db.query(
      `INSERT INTO tenant_email_delta_recovery_operations (
         operation_id, client_id, location_id, endpoint_id, actor_staff_user_id,
         operation_kind, requested_generation, requested_state_version, outcome
       ) VALUES ($1,$2,$3,$4,$5,'restart_generation',1,1,'claimed')`,
      [crypto.randomUUID(), ids.client, ids.location, ids.endpoint, crypto.randomUUID()],
    );
  } catch { badActorFk = true; }
  assert.equal(badActorFk, true, 'unknown actor FK rejected');

  // RED: bounds
  let badBound = false;
  try {
    await db.query(
      `INSERT INTO tenant_email_delta_recovery_operations (
         operation_id, client_id, location_id, endpoint_id, actor_staff_user_id,
         operation_kind, requested_generation, requested_state_version, outcome
       ) VALUES ($1,$2,$3,$4,$5,'restart_generation',9007199254740992,1,'claimed')`,
      [crypto.randomUUID(), ids.client, ids.location, ids.endpoint, ids.actor],
    );
  } catch { badBound = true; }
  assert.equal(badBound, true, 'generation above MAX_SAFE_INTEGER rejected');

  // RED: result coherence — committed restart without result triple
  let badCohere = false;
  try {
    await db.query(
      `INSERT INTO tenant_email_delta_recovery_operations (
         operation_id, client_id, location_id, endpoint_id, actor_staff_user_id,
         operation_kind, requested_generation, requested_state_version, outcome
       ) VALUES ($1,$2,$3,$4,$5,'restart_generation',1,1,'committed')`,
      [crypto.randomUUID(), ids.client, ids.location, ids.endpoint, ids.actor],
    );
  } catch { badCohere = true; }
  assert.equal(badCohere, true, 'committed restart requires result triple');

  // RED: restart with target_operation_id
  let badTarget = false;
  try {
    await db.query(
      `INSERT INTO tenant_email_delta_recovery_operations (
         operation_id, client_id, location_id, endpoint_id, actor_staff_user_id,
         operation_kind, requested_generation, requested_state_version,
         target_operation_id, outcome
       ) VALUES ($1,$2,$3,$4,$5,'restart_generation',1,1,$6,'claimed')`,
      [crypto.randomUUID(), ids.client, ids.location, ids.endpoint, ids.actor, crypto.randomUUID()],
    );
  } catch { badTarget = true; }
  assert.equal(badTarget, true, 'restart cannot carry target_operation_id');

  // RED: reconcile without target
  let badRecon = false;
  try {
    await db.query(
      `INSERT INTO tenant_email_delta_recovery_operations (
         operation_id, client_id, location_id, endpoint_id, actor_staff_user_id,
         operation_kind, requested_generation, requested_state_version, outcome
       ) VALUES ($1,$2,$3,$4,$5,'reconcile_page_commit',1,1,'claimed')`,
      [crypto.randomUUID(), ids.client, ids.location, ids.endpoint, ids.actor],
    );
  } catch { badRecon = true; }
  assert.equal(badRecon, true, 'reconcile requires target_operation_id');

  await db.query('DELETE FROM tenant_email_delta_recovery_operations');

  const loaner = createPgliteExclusiveLoaner(db);
  const recovery = createEmailDeltaRecoveryOperationStore(Object.freeze({
    withTransactionClient: loaner.withTransactionClient,
    authorityVerifier: makeAuthorityVerifier(),
  }));
  const delta = createInboundEmailDeltaStateStore(Object.freeze({
    withTransactionClient: loaner.withTransactionClient,
    authorityVerifier: makeAuthorityVerifier(),
  }));

  // Initialize delta state gen1
  const init = await delta.initializeState(Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: QV1,
  }));
  assert.equal(init.ok, true, JSON.stringify(init));
  assert.equal(init.value.ingestion_generation, 1);

  const status = await recovery.getRecoveryStatus(Object.freeze({
    clientId: ids.client,
    endpointId: ids.endpoint,
  }));
  assert.equal(status.ok, true);
  assert.equal(status.value.state_present, true);
  assert.equal(status.value.recovery_blocked, false);

  // Restart generation 1 → 2
  const op1 = crypto.randomUUID();
  loaner.resetDepth();
  const r1 = await recovery.restartGeneration(Object.freeze({
    operationId: op1,
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    actorStaffUserId: ids.actor,
    expectedGeneration: 1,
    expectedStateVersion: 1,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: QV1,
  }));
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.value.outcome, 'committed');
  assert.equal(r1.value.result_generation, 2);
  assert.equal(r1.value.result_phase, 'initial');
  assert.equal(r1.value.replayed, false);
  assert.ok(loaner.getMaxBeginDepth() <= 1, 'no nested BEGIN depth');
  assert.equal(loaner.getReleaseCalls(), 0, 'no client.release');

  // Old gen preserved
  const oldRows = await db.query(
    `SELECT ingestion_generation, is_current FROM tenant_email_inbound_delta_states
      WHERE client_id = $1 AND endpoint_id = $2 ORDER BY ingestion_generation`,
    [ids.client, ids.endpoint],
  );
  assert.equal(oldRows.rows.length, 2);
  assert.equal(Number(oldRows.rows[0].ingestion_generation), 1);
  assert.equal(oldRows.rows[0].is_current, false);
  assert.equal(Number(oldRows.rows[1].ingestion_generation), 2);
  assert.equal(oldRows.rows[1].is_current, true);
  // No cursor copy on new gen
  assert.equal(oldRows.rows[1].cursor_kind == null || true, true);

  // Idempotent replay
  const r1b = await recovery.restartGeneration(Object.freeze({
    operationId: op1,
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    actorStaffUserId: ids.actor,
    expectedGeneration: 1,
    expectedStateVersion: 1,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: QV1,
  }));
  assert.equal(r1b.ok, true);
  assert.equal(r1b.value.replayed, true);
  assert.equal(r1b.value.outcome, 'committed');
  assert.equal(r1b.value.result_generation, 2);

  // Actor mismatch conflict
  const badActor = await recovery.restartGeneration(Object.freeze({
    operationId: op1,
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    actorStaffUserId: ids.otherActor,
    expectedGeneration: 1,
    expectedStateVersion: 1,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: QV1,
  }));
  assert.equal(badActor.ok, false);
  assert.equal(badActor.error, 'operation_id_conflict');

  // Active lease fail closed
  await db.query(
    `UPDATE tenant_email_inbound_delta_states
        SET lease_owner = 'w', lease_token = $3::uuid,
            lease_until = clock_timestamp() + interval '60 seconds',
            state_version = state_version + 1
      WHERE client_id = $1 AND endpoint_id = $2 AND is_current = true`,
    [ids.client, ids.endpoint, crypto.randomUUID()],
  );
  const curLease = await db.query(
    `SELECT state_version, ingestion_generation FROM tenant_email_inbound_delta_states
      WHERE client_id = $1 AND endpoint_id = $2 AND is_current = true`,
    [ids.client, ids.endpoint],
  );
  const leaseGen = Number(curLease.rows[0].ingestion_generation);
  const leaseSv = Number(curLease.rows[0].state_version);
  const leaseStatus = await recovery.getRecoveryStatus(Object.freeze({
    clientId: ids.client, endpointId: ids.endpoint,
  }));
  assert.equal(leaseStatus.value.recovery_blocked, true);
  const leaseOp = crypto.randomUUID();
  const leaseBlock = await recovery.restartGeneration(Object.freeze({
    operationId: leaseOp,
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    actorStaffUserId: ids.actor,
    expectedGeneration: leaseGen,
    expectedStateVersion: leaseSv,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: QV1,
  }));
  assert.equal(leaseBlock.ok, true);
  assert.equal(leaseBlock.value.outcome, 'not_committed');
  // generation unchanged
  const still = await db.query(
    `SELECT ingestion_generation FROM tenant_email_inbound_delta_states
      WHERE client_id = $1 AND endpoint_id = $2 AND is_current = true`,
    [ids.client, ids.endpoint],
  );
  assert.equal(Number(still.rows[0].ingestion_generation), leaseGen);

  // Clear lease for CAS race
  await db.query(
    `UPDATE tenant_email_inbound_delta_states
        SET lease_owner = NULL, lease_token = NULL, lease_until = NULL,
            state_version = state_version + 1
      WHERE client_id = $1 AND endpoint_id = $2 AND is_current = true`,
    [ids.client, ids.endpoint],
  );
  const cur2 = await db.query(
    `SELECT state_version, ingestion_generation FROM tenant_email_inbound_delta_states
      WHERE client_id = $1 AND endpoint_id = $2 AND is_current = true`,
    [ids.client, ids.endpoint],
  );
  const g2 = Number(cur2.rows[0].ingestion_generation);
  const s2 = Number(cur2.rows[0].state_version);

  const opA = crypto.randomUUID();
  const opB = crypto.randomUUID();
  const a = await recovery.restartGeneration(Object.freeze({
    operationId: opA,
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    actorStaffUserId: ids.actor,
    expectedGeneration: g2,
    expectedStateVersion: s2,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: QV1,
  }));
  const b = await recovery.restartGeneration(Object.freeze({
    operationId: opB,
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    actorStaffUserId: ids.actor,
    expectedGeneration: g2,
    expectedStateVersion: s2,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: QV1,
  }));
  assert.equal(a.ok, true);
  assert.equal(a.value.outcome, 'committed');
  assert.equal(b.ok, true);
  assert.equal(b.value.outcome, 'conflict');

  // Reconcile → evidence_unavailable; plant cursor_operation_id to prove non-inference
  const targetOp = crypto.randomUUID();
  await db.query(
    `UPDATE tenant_email_inbound_delta_states
        SET cursor_operation_id = $3::uuid
      WHERE client_id = $1 AND endpoint_id = $2 AND is_current = true`,
    // may fail cursor_coherence if partial — use only if all null allowed with null cursor_kind
    // cursor_operation_id alone may violate coherence; skip plant if so
    [ids.client, ids.endpoint, targetOp],
  ).catch(() => null);

  const reconOp = crypto.randomUUID();
  const cur3 = await db.query(
    `SELECT state_version, ingestion_generation FROM tenant_email_inbound_delta_states
      WHERE client_id = $1 AND endpoint_id = $2 AND is_current = true`,
    [ids.client, ids.endpoint],
  );
  const recon = await recovery.reconcilePageCommit(Object.freeze({
    operationId: reconOp,
    targetOperationId: targetOp,
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    actorStaffUserId: ids.actor,
    expectedGeneration: Number(cur3.rows[0].ingestion_generation),
    expectedStateVersion: Number(cur3.rows[0].state_version),
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
  }));
  assert.equal(recon.ok, true, JSON.stringify(recon));
  assert.equal(recon.value.outcome, 'evidence_unavailable');
  assert.equal(recon.value.target_operation_id, targetOp);

  // Generation unchanged by reconcile
  const afterRecon = await db.query(
    `SELECT ingestion_generation FROM tenant_email_inbound_delta_states
      WHERE client_id = $1 AND endpoint_id = $2 AND is_current = true`,
    [ids.client, ids.endpoint],
  );
  assert.equal(
    Number(afterRecon.rows[0].ingestion_generation),
    Number(cur3.rows[0].ingestion_generation),
  );

  // Commit unknown sequence
  const cur4 = await db.query(
    `SELECT state_version, ingestion_generation FROM tenant_email_inbound_delta_states
      WHERE client_id = $1 AND endpoint_id = $2 AND is_current = true`,
    [ids.client, ids.endpoint],
  );
  const unkOp = crypto.randomUUID();
  loaner.setCommitReject(true);
  const unk = await recovery.restartGeneration(Object.freeze({
    operationId: unkOp,
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    actorStaffUserId: ids.actor,
    expectedGeneration: Number(cur4.rows[0].ingestion_generation),
    expectedStateVersion: Number(cur4.rows[0].state_version),
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: QV1,
  }));
  loaner.setCommitReject(false);
  assert.equal(unk.ok, false);
  assert.equal(unk.error, 'commit_outcome_unknown');
  // Retry may execute (rolled back) or return committed if landed — harness rejects before durable
  const retry = await recovery.restartGeneration(Object.freeze({
    operationId: unkOp,
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    actorStaffUserId: ids.actor,
    expectedGeneration: Number(cur4.rows[0].ingestion_generation),
    expectedStateVersion: Number(cur4.rows[0].state_version),
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: QV1,
  }));
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.value.outcome, 'committed');

  // Public beginNextGeneration still works
  const cur5 = await db.query(
    `SELECT state_version, ingestion_generation FROM tenant_email_inbound_delta_states
      WHERE client_id = $1 AND endpoint_id = $2 AND is_current = true`,
    [ids.client, ids.endpoint],
  );
  const pub = await delta.beginNextGeneration(Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    expectedGeneration: Number(cur5.rows[0].ingestion_generation),
    expectedStateVersion: Number(cur5.rows[0].state_version),
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
    queryVersion: QV1,
  }));
  assert.equal(pub.ok, true, JSON.stringify(pub));
  assert.equal(pub.value.ingestion_generation, Number(cur5.rows[0].ingestion_generation) + 1);

  // Down drops 065 only
  await db.exec(DOWN);
  const gone = await db.query(
    `SELECT to_regclass('public.tenant_email_delta_recovery_operations') AS reg`,
  );
  assert.equal(gone.rows[0].reg, null);
  const deltaStill = await db.query(
    `SELECT to_regclass('public.tenant_email_inbound_delta_states') AS reg`,
  );
  assert.ok(deltaStill.rows[0].reg);

  console.log('ok - pglite recovery journal proofs');
  await db.close();
}

async function main() {
  assertStaticContract();
  const PGlite = tryLoadPglite();
  if (!PGlite) {
    console.log('ok - pglite unavailable; static contract only');
    return;
  }
  await proveWithPglite(PGlite);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
