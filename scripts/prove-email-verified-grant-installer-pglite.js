'use strict';

/**
 * Real-schema RED for the atomic Gmail verified-grant installer.
 * Ephemeral PGlite only: no provider/network/token exchange/routes/activation.
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { prepareMigrationBody, MIGRATIONS_DIR } = require('./lib/migration-integrity');
const { createVerifiedGrantInstaller, ERROR_CODE } = require('./lib/email-verified-grant-installer');

const MIGRATIONS = [
  '057_tenant_locations_and_channel_endpoints.sql',
  '058_tenant_channel_endpoint_identity.sql',
  '059_tenant_email_delegated_grants.sql',
  '073_tenant_channel_endpoint_google_identity.sql',
  '074_tenant_email_delegated_grants_google_mode_guard.sql',
];
const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ACTOR_ID = 'abcdef01-2345-4678-89ab-cdef01234567';
const ISSUER = 'https://accounts.google.com';
const SUBJECT = 'Google-Sub_123:CaseSensitive';
const ADDRESS = 'owner.case+grant@example.com';
const STATUSES = ['unverified_offline', 'pending_manual_validation'];
const RAW_TOKEN_COLUMNS = ['refresh_token', 'access_token', 'id_token'];
const CAPABILITIES = JSON.stringify({
  push_notifications: false, provider_threads: false, remote_drafts: false,
  reply: false, reply_all: false, forward: false,
  attachments_metadata: false, delivery_events: false,
});

const PARENT_DDL = `
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE staff_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE, email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;

function input(endpointId, operationId) {
  return Object.freeze({
    clientId: CLIENT_ID,
    endpointId,
    operationId,
    actorStaffUserId: ACTOR_ID,
    identity: Object.freeze({
      providerTenantId: ISSUER,
      providerPrincipalId: SUBJECT,
      mailboxAddress: ADDRESS,
      displayName: null,
    }),
    envelope: Object.freeze({
      envelope_version: 'v1',
      aead_alg: 'AES-256-GCM',
      kek_wrap_alg: 'A256KW',
      kek_key_name: 'test-luna-grant-kek',
      kek_key_version: 'v1-test-0001',
      nonce: Buffer.alloc(12, 1),
      ciphertext: Buffer.alloc(32, 2),
      auth_tag: Buffer.alloc(16, 3),
      wrapped_dek: Buffer.alloc(40, 4),
      operation_id: operationId,
    }),
  });
}

async function applySchema(db) {
  await db.exec(PARENT_DDL);
  for (const filename of MIGRATIONS) {
    const prepared = prepareMigrationBody(fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8'));
    assert.equal(prepared.ok, true, `${filename}: ${prepared.message || prepared.code}`);
    await db.exec(prepared.body);
  }
}

async function seedEndpoint(db, status, endpointId) {
  await db.query("INSERT INTO clients (id,slug,name) VALUES ($1,$2,$3)",
    [CLIENT_ID, `gmail-${status.replaceAll('_', '-')}`, 'Gmail installer proof']);
  await db.query('INSERT INTO staff_users (id,client_id,email) VALUES ($1,$2,$3)',
    [ACTOR_ID, CLIENT_ID, 'actor@example.com']);
  await db.query("INSERT INTO tenant_locations (client_id,location_id,display_name) VALUES ($1,'gmail-proof','Gmail proof')",
    [CLIENT_ID]);
  await db.query(`INSERT INTO tenant_channel_endpoints (
      id, client_id, location_id, channel, provider, public_address, secret_ref, capabilities,
      inbound_enabled, outbound_enabled, default_automation_mode, active,
      auth_mode, connector_mode, binding_status
    ) VALUES ($1,$2,'gmail-proof','email','gmail_api',$3,'secret-ref:luna/email/test/gmail-proof',
      $4::jsonb,false,false,'off',false,
      'delegated_authorization_code','google_delegated_oauth',$5)`,
  [endpointId, CLIENT_ID, ADDRESS, CAPABILITIES, status]);
}

async function proveStatus(status, index) {
  const db = new PGlite();
  const endpointId = `11111111-2222-4333-8444-55555555555${index}`;
  const operationId = `99999999-8888-4777-8666-55555555555${index}`;
  const nativeFailures = [];
  try {
    await applySchema(db);
    await seedEndpoint(db, status, endpointId);
    const client = Object.freeze({
      async query(sql, params) {
        try {
          return await db.query(String(sql), params || []);
        } catch (error) {
          nativeFailures.push(Object.freeze({ code: error && error.code, message: error && error.message }));
          throw error;
        }
      },
    });
    const installer = createVerifiedGrantInstaller(Object.freeze({ client }));
    let result;
    let publicError;
    try {
      result = await installer.installVerifiedGrant(input(endpointId, operationId));
    } catch (error) {
      publicError = error;
    }

    const endpoint = await db.query(`SELECT binding_status, provider_tenant_id,
      provider_principal_oid, provider_resource_id, mailbox_kind, mailbox_access_kind
      FROM tenant_channel_endpoints WHERE id=$1`, [endpointId]);
    const grants = await db.query(`SELECT grant_generation, grant_status, reconcile_state
      FROM tenant_email_delegated_grants WHERE endpoint_id=$1`, [endpointId]);
    const columns = await db.query(`SELECT column_name FROM information_schema.columns
      WHERE table_name='tenant_email_delegated_grants'`);
    const columnNames = columns.rows.map((row) => row.column_name);
    assert.equal(RAW_TOKEN_COLUMNS.some((name) => columnNames.includes(name)), false,
      `${status}: raw token column exists`);

    if (publicError) {
      assert.equal(publicError.code, ERROR_CODE, `${status}: public error must stay sanitized`);
      assert.equal(nativeFailures.some((failure) => failure.code === '23514'), true,
        `${status}: expected underlying immediate trigger SQLSTATE 23514`);
      assert.equal(endpoint.rows[0].binding_status, status,
        `${status}: failed transaction must preserve endpoint state`);
      assert.equal(endpoint.rows[0].provider_tenant_id, null);
      assert.equal(grants.rows.length, 0, `${status}: failed transaction must commit no grant`);
      console.log(`OBSERVED ${status}: sanitized=${publicError.code} underlying=23514 endpoint=${status} grants=0`);
      return { status, error: publicError };
    }

    assert.deepEqual(result, Object.freeze({ status: 'installed' }));
    assert.deepEqual(endpoint.rows[0], {
      binding_status: 'verified',
      provider_tenant_id: ISSUER,
      provider_principal_oid: SUBJECT,
      provider_resource_id: SUBJECT,
      mailbox_kind: 'user',
      mailbox_access_kind: 'own_user',
    });
    assert.deepEqual(grants.rows[0], {
      grant_generation: 1,
      grant_status: 'active',
      reconcile_state: 'clean',
    });
    console.log(`PASS ${status}: installed verified exact Gmail identity + active generation-1 grant`);
    return { status, error: null };
  } finally {
    await db.close();
  }
}

async function main() {
  console.log('prove:email-verified-grant-installer-pglite (real 057+058+059+073+074)');
  const outcomes = [];
  for (let index = 0; index < STATUSES.length; index += 1) {
    outcomes.push(await proveStatus(STATUSES[index], index + 1));
  }
  const failures = outcomes.filter((outcome) => outcome.error);
  assert.deepEqual(failures.map((outcome) => outcome.status), [],
    'RED: Gmail installer must UPDATE endpoint to verified before immediate grant guard INSERT');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
