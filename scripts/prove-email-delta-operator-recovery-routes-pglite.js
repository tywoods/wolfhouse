'use strict';

/**
 * Prove operator recovery service + exclusive loan semantics on PGlite.
 *
 * When PGlite is available:
 *   - minimal parent shell + 059/064/065-relevant tables
 *   - real recovery store via service
 *   - restart idempotency, CAS conflict, lease fail closed
 *   - reconcile evidence_unavailable (no event/cursor mutation)
 *   - commit ambiguity → uncertain (no success/new ID)
 *   - no nested BEGIN depth > 1; no client.release
 *   - authority rebind fail closed
 *
 * When PGlite unavailable: static source contract only.
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
const UP_064 = path.join(ROOT, 'database/migrations/064_tenant_email_inbound_delta_states.sql');
const UP = fs.readFileSync(UP_065, 'utf8');
const UP_DELTA = fs.readFileSync(UP_064, 'utf8');

const ids = {
  client: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-222222222222',
  endpoint: '33333333-3333-4333-8333-333333333333',
  actor: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  tenant: '55555555-5555-4555-8555-555555555555',
  mailbox: '44444444-4444-4444-8444-444444444444',
  otherTenant: '66666666-6666-4666-8666-666666666666',
};
const QV1 = 'ms_messages_delta_v1';
const LOCATION_SLUG = 'sunset-somo';

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
    CREATE TABLE clients (id uuid PRIMARY KEY, slug text);
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
      auth_mode text NOT NULL DEFAULT 'delegated_authorization_code',
      connector_mode text NOT NULL DEFAULT 'microsoft_delegated_oauth',
      binding_status text NOT NULL DEFAULT 'verified',
      provider_tenant_id uuid,
      provider_resource_id uuid,
      provider_principal_oid uuid,
      mailbox_kind text NOT NULL DEFAULT 'user',
      mailbox_access_kind text NOT NULL DEFAULT 'own_user',
      public_address text NOT NULL DEFAULT 'a@b.co',
      secret_ref text,
      capabilities jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    ALTER TABLE tenant_channel_endpoints
      ADD CONSTRAINT tenant_channel_endpoints_client_id_id_uq UNIQUE (client_id, id);
    CREATE TABLE tenant_email_delegated_grants (
      client_id uuid NOT NULL,
      endpoint_id uuid NOT NULL,
      PRIMARY KEY (client_id, endpoint_id)
    );
    INSERT INTO clients VALUES ('${ids.client}', 'sunset');
    INSERT INTO staff_users (id, client_id) VALUES ('${ids.actor}', '${ids.client}');
    INSERT INTO tenant_locations (id, client_id, location_id)
      VALUES ('${ids.location}', '${ids.client}', '${LOCATION_SLUG}');
    INSERT INTO tenant_channel_endpoints (
      id, client_id, location_id, provider_tenant_id, provider_resource_id,
      provider_principal_oid
    ) VALUES (
      '${ids.endpoint}', '${ids.client}', '${LOCATION_SLUG}',
      '${ids.tenant}', '${ids.mailbox}', '${ids.mailbox}'
    );
    INSERT INTO tenant_email_delegated_grants (client_id, endpoint_id)
      VALUES ('${ids.client}', '${ids.endpoint}');
  `;
}

function createPgliteExclusiveLoaner(db) {
  let chain = Promise.resolve();
  let beginDepth = 0;
  let maxBeginDepth = 0;
  let releaseCalls = 0;
  let commitReject = false;
  let checkoutCount = 0;

  async function withTransactionClient(work) {
    checkoutCount += 1;
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
    getCheckoutCount() { return checkoutCount; },
    setCommitReject(v) { commitReject = v; },
    resetDepth() { beginDepth = 0; maxBeginDepth = 0; },
  });
}

function makeAuthorityVerifier(binding) {
  return Object.freeze({
    async verifyBinding(b) {
      if (!b
          || b.clientId !== binding.clientId
          || b.locationId !== binding.locationId
          || b.endpointId !== binding.endpointId
          || b.providerTenantId !== binding.providerTenantId
          || b.providerMailboxId !== binding.providerMailboxId) {
        return Object.freeze({ ok: false });
      }
      return Object.freeze({
        ok: true,
        value: Object.freeze({ ...b }),
      });
    },
  });
}

function assertStaticContract() {
  const svc = fs.readFileSync(
    path.join(ROOT, 'scripts/lib/email-delta-operator-recovery-service.js'), 'utf8',
  );
  const routes = fs.readFileSync(
    path.join(ROOT, 'scripts/lib/staff-email-delta-operator-recovery-routes.js'), 'utf8',
  );
  const comp = fs.readFileSync(
    path.join(ROOT, 'scripts/lib/email-delta-operator-recovery-sunset-staging-runtime-composition.js'),
    'utf8',
  );
  assert.match(svc, /createEmailDeltaRecoveryOperationStore/);
  assert.match(svc, /commit_outcome_unknown/);
  assert.match(svc, /evidence_unavailable/);
  assert.equal(/CREATE TABLE tenant_email_delta_recovery_operations/.test(svc), false);
  assert.equal(/CREATE TABLE tenant_email_delta_recovery_operations/.test(routes), false);
  assert.equal(/CREATE TABLE tenant_email_delta_recovery_operations/.test(comp), false);
  assert.match(routes, /SQL_RESOLVE_OPERATOR_RECOVERY_BINDING/);
  assert.match(routes, /not_found/);
  assert.equal(/\bgetPool\s*\(/.test(routes), false);
  console.log('ok - static operator recovery route/service contract (no duplicate SQL)');
}

async function proveWithPglite(PGlite) {
  const {
    createEmailDeltaOperatorRecoveryService,
    SERVICE_OUTCOME,
  } = require('./lib/email-delta-operator-recovery-service');
  const {
    createInboundEmailDeltaStateStore,
  } = require('./lib/email-inbound-delta-state-store');

  const db = new PGlite();
  await db.exec(shellSql());
  await db.exec(UP_DELTA);
  await db.exec(UP);

  const loaner = createPgliteExclusiveLoaner(db);
  const binding = Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    providerTenantId: ids.tenant,
    providerMailboxId: ids.mailbox,
  });
  const authorityVerifier = makeAuthorityVerifier(binding);
  const delta = createInboundEmailDeltaStateStore(Object.freeze({
    withTransactionClient: loaner.withTransactionClient,
    authorityVerifier,
  }));

  async function resolveAuthorityBinding(input) {
    if (input.clientId !== ids.client
        || input.locationId !== ids.location
        || input.endpointId !== ids.endpoint) {
      return Object.freeze({ ok: false, error: 'unresolved' });
    }
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        clientId: ids.client,
        locationId: ids.location,
        endpointId: ids.endpoint,
        providerTenantId: ids.tenant,
        providerMailboxId: ids.mailbox,
        provider: 'microsoft_graph',
        bindingStatus: 'verified',
      }),
    });
  }

  const service = createEmailDeltaOperatorRecoveryService(Object.freeze({
    withTransactionClient: loaner.withTransactionClient,
    authorityVerifier,
    inboundDeltaStateStore: delta,
    resolveAuthorityBinding,
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

  // Status
  const status = await service.getStatus(Object.freeze({
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
  }));
  assert.equal(status.ok, true);
  assert.equal(status.kind, SERVICE_OUTCOME.SUCCESS);
  assert.equal(status.value.state_present, true);
  assert.equal(status.value.recovery_blocked, false);
  assert.equal(Object.prototype.hasOwnProperty.call(status.value, 'providerMailboxId'), false);
  console.log('ok - status PII-free');

  // Restart committed
  const op1 = crypto.randomUUID();
  loaner.resetDepth();
  const r1 = await service.restartGeneration(Object.freeze({
    operationId: op1,
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    actorStaffUserId: ids.actor,
    expectedGeneration: 1,
    expectedStateVersion: 1,
  }));
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.kind, SERVICE_OUTCOME.SUCCESS);
  assert.equal(r1.value.outcome, 'committed');
  assert.equal(r1.value.result_generation, 2);
  assert.equal(r1.value.replayed, false);
  assert.ok(loaner.getMaxBeginDepth() <= 1, 'no nested BEGIN');
  assert.equal(loaner.getReleaseCalls(), 0, 'no client.release');
  console.log('ok - restart committed exclusive loan');

  // Idempotent same ID
  const r1b = await service.restartGeneration(Object.freeze({
    operationId: op1,
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    actorStaffUserId: ids.actor,
    expectedGeneration: 1,
    expectedStateVersion: 1,
  }));
  assert.equal(r1b.ok, true);
  assert.equal(r1b.value.outcome, 'committed');
  assert.equal(r1b.value.replayed, true);
  assert.equal(r1b.value.operation_id, op1);
  console.log('ok - restart idempotent same ID');

  // CAS mismatch → conflict 409 class
  const op2 = crypto.randomUUID();
  const r2 = await service.restartGeneration(Object.freeze({
    operationId: op2,
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    actorStaffUserId: ids.actor,
    expectedGeneration: 1, // stale
    expectedStateVersion: 1,
  }));
  assert.equal(r2.ok, false);
  assert.equal(r2.kind, SERVICE_OUTCOME.CONFLICT);
  console.log('ok - CAS mismatch conflict');

  // Active lease → not_committed conflict
  // Re-init path: advance to gen2 already; set lease on current
  await db.query(
    `UPDATE tenant_email_inbound_delta_states
        SET lease_token = gen_random_uuid(),
            lease_owner = 'worker-x',
            lease_until = clock_timestamp() + interval '10 minutes'
      WHERE client_id = $1::uuid AND endpoint_id = $2::uuid AND is_current = true`,
    [ids.client, ids.endpoint],
  );
  const cur = await db.query(
    `SELECT ingestion_generation, state_version FROM tenant_email_inbound_delta_states
      WHERE client_id = $1::uuid AND endpoint_id = $2::uuid AND is_current = true`,
    [ids.client, ids.endpoint],
  );
  const curGen = Number(cur.rows[0].ingestion_generation);
  const curSv = Number(cur.rows[0].state_version);
  const op3 = crypto.randomUUID();
  const r3 = await service.restartGeneration(Object.freeze({
    operationId: op3,
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    actorStaffUserId: ids.actor,
    expectedGeneration: curGen,
    expectedStateVersion: curSv,
  }));
  assert.equal(r3.ok, false);
  assert.equal(r3.kind, SERVICE_OUTCOME.CONFLICT);
  assert.equal(r3.value && r3.value.outcome, 'not_committed');
  // clear lease
  await db.query(
    `UPDATE tenant_email_inbound_delta_states
        SET lease_token = NULL, lease_owner = NULL, lease_until = NULL
      WHERE client_id = $1::uuid AND endpoint_id = $2::uuid AND is_current = true`,
    [ids.client, ids.endpoint],
  );
  console.log('ok - active lease not_committed conflict');

  // Reconcile → evidence_unavailable conflict; no cursor mutation
  const beforeCursor = await db.query(
    `SELECT cursor_kind, state_version, ingestion_generation
       FROM tenant_email_inbound_delta_states
      WHERE client_id = $1::uuid AND endpoint_id = $2::uuid AND is_current = true`,
    [ids.client, ids.endpoint],
  );
  const opR = crypto.randomUUID();
  const target = crypto.randomUUID();
  const rr = await service.reconcilePageCommit(Object.freeze({
    operationId: opR,
    targetOperationId: target,
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    actorStaffUserId: ids.actor,
    expectedGeneration: Number(beforeCursor.rows[0].ingestion_generation),
    expectedStateVersion: Number(beforeCursor.rows[0].state_version),
  }));
  assert.equal(rr.ok, false);
  assert.equal(rr.kind, SERVICE_OUTCOME.CONFLICT);
  assert.equal(rr.value.outcome, 'evidence_unavailable');
  const afterCursor = await db.query(
    `SELECT cursor_kind, state_version, ingestion_generation
       FROM tenant_email_inbound_delta_states
      WHERE client_id = $1::uuid AND endpoint_id = $2::uuid AND is_current = true`,
    [ids.client, ids.endpoint],
  );
  assert.equal(
    String(afterCursor.rows[0].state_version),
    String(beforeCursor.rows[0].state_version),
  );
  assert.equal(
    String(afterCursor.rows[0].ingestion_generation),
    String(beforeCursor.rows[0].ingestion_generation),
  );
  console.log('ok - reconcile evidence_unavailable no cursor/gen mutation');

  // Commit ambiguity → uncertain; never success / never mint a new operation ID.
  // Harness rejects COMMIT after mutation SQL — store returns commit_outcome_unknown.
  // Generation may or may not land (ambiguous); service must not claim success.
  loaner.setCommitReject(true);
  const opU = crypto.randomUUID();
  const cur2 = await db.query(
    `SELECT ingestion_generation, state_version FROM tenant_email_inbound_delta_states
      WHERE client_id = $1::uuid AND endpoint_id = $2::uuid AND is_current = true`,
    [ids.client, ids.endpoint],
  );
  const ru = await service.restartGeneration(Object.freeze({
    operationId: opU,
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    actorStaffUserId: ids.actor,
    expectedGeneration: Number(cur2.rows[0].ingestion_generation),
    expectedStateVersion: Number(cur2.rows[0].state_version),
  }));
  loaner.setCommitReject(false);
  // Best-effort cleanup of dangling TX from rejected COMMIT
  try { await db.query('ROLLBACK'); } catch { /* ignore */ }
  assert.equal(ru.ok, false);
  assert.equal(ru.kind, SERVICE_OUTCOME.UNCERTAIN);
  assert.notEqual(ru.kind, SERVICE_OUTCOME.SUCCESS);
  // No new operation id minted by service on ambiguity (caller-supplied only)
  assert.ok(!ru.value || ru.value.operation_id == null || ru.value.operation_id === opU);
  console.log('ok - commit ambiguity uncertain never success/new id');

  // Authority rebind: resolve returns different tenant → verifier rejects.
  const curLive = await db.query(
    `SELECT ingestion_generation, state_version FROM tenant_email_inbound_delta_states
      WHERE client_id = $1::uuid AND endpoint_id = $2::uuid AND is_current = true`,
    [ids.client, ids.endpoint],
  );
  const rebindService = createEmailDeltaOperatorRecoveryService(Object.freeze({
    withTransactionClient: loaner.withTransactionClient,
    authorityVerifier,
    inboundDeltaStateStore: delta,
    resolveAuthorityBinding: async () => Object.freeze({
      ok: true,
      value: Object.freeze({
        clientId: ids.client,
        locationId: ids.location,
        endpointId: ids.endpoint,
        providerTenantId: ids.otherTenant,
        providerMailboxId: ids.mailbox,
        provider: 'microsoft_graph',
        bindingStatus: 'verified',
      }),
    }),
  }));
  const opB = crypto.randomUUID();
  const rb = await rebindService.restartGeneration(Object.freeze({
    operationId: opB,
    clientId: ids.client,
    locationId: ids.location,
    endpointId: ids.endpoint,
    actorStaffUserId: ids.actor,
    expectedGeneration: Number(curLive.rows[0].ingestion_generation),
    expectedStateVersion: Number(curLive.rows[0].state_version),
  }));
  // Authority verifier rejects rebind → store fails → unavailable or invalid
  assert.equal(rb.ok, false);
  assert.ok(
    rb.kind === SERVICE_OUTCOME.UNAVAILABLE
    || rb.kind === SERVICE_OUTCOME.INVALID
    || rb.kind === SERVICE_OUTCOME.CONFLICT,
  );
  console.log('ok - authority rebind fail closed');

  // Concurrent two IDs same CAS: one success one conflict
  await db.query(
    `UPDATE tenant_email_inbound_delta_states
        SET lease_token = NULL, lease_owner = NULL, lease_until = NULL
      WHERE client_id = $1::uuid AND endpoint_id = $2::uuid AND is_current = true`,
    [ids.client, ids.endpoint],
  );
  const cur4 = await db.query(
    `SELECT ingestion_generation, state_version FROM tenant_email_inbound_delta_states
      WHERE client_id = $1::uuid AND endpoint_id = $2::uuid AND is_current = true`,
    [ids.client, ids.endpoint],
  );
  const gen = Number(cur4.rows[0].ingestion_generation);
  const sv = Number(cur4.rows[0].state_version);
  const opA = crypto.randomUUID();
  const opC = crypto.randomUUID();
  const [ra, rc] = await Promise.all([
    service.restartGeneration(Object.freeze({
      operationId: opA,
      clientId: ids.client,
      locationId: ids.location,
      endpointId: ids.endpoint,
      actorStaffUserId: ids.actor,
      expectedGeneration: gen,
      expectedStateVersion: sv,
    })),
    service.restartGeneration(Object.freeze({
      operationId: opC,
      clientId: ids.client,
      locationId: ids.location,
      endpointId: ids.endpoint,
      actorStaffUserId: ids.actor,
      expectedGeneration: gen,
      expectedStateVersion: sv,
    })),
  ]);
  const kinds = [ra.kind, rc.kind].sort();
  // Serialized loaner: one committed success, one conflict
  assert.ok(
    (ra.kind === SERVICE_OUTCOME.SUCCESS && rc.kind === SERVICE_OUTCOME.CONFLICT)
    || (rc.kind === SERVICE_OUTCOME.SUCCESS && ra.kind === SERVICE_OUTCOME.CONFLICT)
    || (kinds.includes(SERVICE_OUTCOME.SUCCESS) && kinds.includes(SERVICE_OUTCOME.CONFLICT)),
    JSON.stringify({ ra, rc }),
  );
  console.log('ok - concurrent same CAS one success one conflict');

  assert.equal(loaner.getReleaseCalls(), 0, 'never nested release');
  console.log('ok - PGlite operator recovery service proofs complete');
}

async function main() {
  console.log('prove:email-delta-operator-recovery-routes-pglite');
  assertStaticContract();
  const PGlite = tryLoadPglite();
  if (!PGlite) {
    console.log('skip - PGlite unavailable (static only)');
    return;
  }
  await proveWithPglite(PGlite);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
