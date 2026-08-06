'use strict';

/**
 * Prove migration 062 secret_ref null policy on stock PostgreSQL / PGlite.
 *
 * When PGlite is available: apply a minimal tenant_channel_endpoints shell +
 * 062 up, assert delegated NULL accepted / delegated NON-NULL rejected /
 * Gmail/IMAP/legacy Microsoft/app-only NULL rejected / NON-NULL accepted where
 * valid, then down safety (null blocks down; empty-null restores NOT NULL).
 *
 * When PGlite is unavailable: still run static migration contract assertions
 * (same policy as offline verifier) so CI without pglite does not go dark.
 *
 * No Azure / live DB / deploy / seed.
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const UP_PATH = path.join(ROOT, 'database/migrations/062_tenant_channel_endpoint_secret_ref_nullable.sql');
const DOWN_PATH = path.join(ROOT, 'database/migrations/062_tenant_channel_endpoint_secret_ref_nullable_down.sql');

const UP = fs.readFileSync(UP_PATH, 'utf8');
const DOWN = fs.readFileSync(DOWN_PATH, 'utf8');

const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SECRET = 'kv:luna-email-opaque-ref-example';

function tryLoadPglite() {
  try {
    return require('@electric-sql/pglite').PGlite;
  } catch (_) {
    return null;
  }
}

function assertStaticContract() {
  assert.match(UP, /DROP NOT NULL/);
  assert.match(UP, /ADD CONSTRAINT tenant_channel_endpoints_secret_ref_null_policy/);
  assert.match(UP, /provider = 'microsoft_graph'/);
  assert.match(UP, /auth_mode IS NOT DISTINCT FROM 'delegated_authorization_code'/);
  assert.match(UP, /connector_mode IS NOT DISTINCT FROM 'microsoft_delegated_oauth'/);
  assert.match(UP, /\(secret_ref IS NULL\) = \(/);
  assert.match(UP, /RAISE EXCEPTION/);
  assert.equal(/binding_status/.test(UP), false);
  // No IF EXISTS: missing/renamed constraint is schema drift and must fail closed.
  assert.match(DOWN, /DROP CONSTRAINT\s+tenant_channel_endpoints_secret_ref_null_policy/);
  assert.equal(/DROP CONSTRAINT IF EXISTS/i.test(DOWN), false);
  assert.match(DOWN, /SET NOT NULL/);
  assert.match(DOWN, /RAISE EXCEPTION/);
  console.log('ok - static 062 null-policy contract');
}

/**
 * Minimal table shell with columns the CHECK and preflight need.
 * Intentionally NOT full 057/058 — only what 062 touches.
 */
async function createShell(db) {
  await db.exec(`
    CREATE TABLE tenant_channel_endpoints (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL,
      location_id text NOT NULL,
      channel text NOT NULL DEFAULT 'email',
      provider text NOT NULL,
      public_address text,
      secret_ref text NOT NULL,
      provider_resource_id text,
      capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
      inbound_enabled boolean NOT NULL DEFAULT false,
      outbound_enabled boolean NOT NULL DEFAULT false,
      default_automation_mode text NOT NULL DEFAULT 'off',
      active boolean NOT NULL DEFAULT false,
      auth_mode text,
      connector_mode text,
      provider_tenant_id text,
      provider_principal_oid text,
      mailbox_kind text,
      mailbox_access_kind text,
      binding_status text,
      created_by uuid,
      updated_by uuid
    );
  `);
}

let idSeq = 0;
function nextId() {
  idSeq += 1;
  const n = String(idSeq).padStart(12, '0');
  return `11111111-1111-4111-8111-${n}`;
}

function insertSql({ provider, authMode, connectorMode, secretRef, bindingStatus }) {
  const auth = authMode == null ? 'NULL' : `'${authMode}'`;
  const conn = connectorMode == null ? 'NULL' : `'${connectorMode}'`;
  const bind = bindingStatus == null ? 'NULL' : `'${bindingStatus}'`;
  const secret = secretRef == null ? 'NULL' : `'${secretRef}'`;
  const id = nextId();
  return `
    INSERT INTO tenant_channel_endpoints (
      id, client_id, location_id, provider, public_address, secret_ref,
      auth_mode, connector_mode, binding_status
    ) VALUES (
      '${id}'::uuid, '${CLIENT}'::uuid, 'loc-a', '${provider}', 'a@example.test', ${secret},
      ${auth}, ${conn}, ${bind}
    )`;
}

async function expectReject(db, sql, label) {
  let failed = false;
  try {
    await db.exec(sql);
  } catch (err) {
    failed = true;
    const msg = String(err && err.message || err);
    assert.ok(
      /check|violat|null|not-null|not null|constraint/i.test(msg),
      `${label}: unexpected error ${msg}`,
    );
  }
  assert.equal(failed, true, `${label}: expected rejection`);
}

async function proveWithPglite(PGlite) {
  const db = new PGlite();
  await createShell(db);

  // Seed only valid pre-062 rows (all NON-NULL secret_ref, non-delegated).
  await db.exec(insertSql({
    provider: 'gmail_api',
    authMode: null,
    connectorMode: null,
    secretRef: SECRET,
  }));
  await db.exec(insertSql({
    provider: 'microsoft_graph',
    authMode: null,
    connectorMode: null,
    secretRef: SECRET,
  }));
  await db.exec(insertSql({
    provider: 'microsoft_graph',
    authMode: 'application_client_credentials',
    connectorMode: 'microsoft_app_only_enterprise',
    secretRef: SECRET,
  }));

  // Up applies cleanly when preflight is clean.
  await db.exec(UP);
  console.log('ok - 062 up on clean shell');

  // Delegated NULL accepted (any lifecycle binding_status).
  for (const bindingStatus of [
    'unverified_offline',
    'pending_manual_validation',
    'verified',
    'reauthorization_required',
    'revoked',
    null,
  ]) {
    await db.exec(insertSql({
      provider: 'microsoft_graph',
      authMode: 'delegated_authorization_code',
      connectorMode: 'microsoft_delegated_oauth',
      secretRef: null,
      bindingStatus,
    }));
  }
  console.log('ok - delegated null accepted (all lifecycle statuses)');

  // Delegated NON-NULL rejected.
  await expectReject(db, insertSql({
    provider: 'microsoft_graph',
    authMode: 'delegated_authorization_code',
    connectorMode: 'microsoft_delegated_oauth',
    secretRef: SECRET,
    bindingStatus: 'unverified_offline',
  }), 'delegated non-null');
  console.log('ok - delegated non-null rejected');

  // Gmail / IMAP / legacy Microsoft / app-only NULL rejected.
  for (const row of [
    { provider: 'gmail_api', authMode: null, connectorMode: null },
    { provider: 'imap_smtp', authMode: null, connectorMode: null },
    { provider: 'microsoft_graph', authMode: null, connectorMode: null },
    {
      provider: 'microsoft_graph',
      authMode: 'application_client_credentials',
      connectorMode: 'microsoft_app_only_enterprise',
    },
  ]) {
    await expectReject(db, insertSql({
      ...row,
      secretRef: null,
    }), `${row.provider}/${row.authMode || 'legacy'} null`);
  }
  console.log('ok - gmail/imap/legacy/app-only null rejected');

  // NON-NULL accepted where valid (non-delegated).
  await db.exec(insertSql({
    provider: 'gmail_api',
    authMode: null,
    connectorMode: null,
    secretRef: 'kv:another-opaque-ref',
  }));
  await db.exec(insertSql({
    provider: 'microsoft_graph',
    authMode: 'application_client_credentials',
    connectorMode: 'microsoft_app_only_enterprise',
    secretRef: 'kv:app-only-ref',
  }));
  console.log('ok - non-null accepted where valid');

  // Down blocked while NULL rows remain.
  let downBlocked = false;
  try {
    await db.exec(DOWN);
  } catch (err) {
    downBlocked = true;
    assert.match(String(err.message || err), /NULL secret_ref|prevent restoring NOT NULL/i);
  }
  assert.equal(downBlocked, true, 'down must fail while null rows exist');
  // Failed down aborts its txn; clear session before further work.
  try { await db.exec('ROLLBACK'); } catch { /* idle is fine */ }
  console.log('ok - down fails closed while null remains');

  // Clear null rows but drop/rename constraint → down fails (no IF EXISTS).
  await db.exec(`DELETE FROM tenant_channel_endpoints WHERE secret_ref IS NULL`);
  await db.exec(`
    ALTER TABLE tenant_channel_endpoints
      DROP CONSTRAINT tenant_channel_endpoints_secret_ref_null_policy
  `);
  let missingConstraintBlocked = false;
  try {
    await db.exec(DOWN);
  } catch (err) {
    missingConstraintBlocked = true;
    const msg = String(err.message || err);
    assert.ok(
      /does not exist|constraint|tenant_channel_endpoints_secret_ref_null_policy/i.test(msg),
      `unexpected missing-constraint error: ${msg}`,
    );
  }
  assert.equal(missingConstraintBlocked, true, 'down must fail when expected constraint is absent');
  try { await db.exec('ROLLBACK'); } catch { /* idle is fine */ }
  console.log('ok - down fails when expected constraint is absent (no IF EXISTS)');

  // Re-add constraint + no null rows → down succeeds → NOT NULL restored.
  await db.exec(`
    ALTER TABLE tenant_channel_endpoints
      ADD CONSTRAINT tenant_channel_endpoints_secret_ref_null_policy
      CHECK (
        (secret_ref IS NULL) = (
          provider = 'microsoft_graph'
          AND auth_mode IS NOT DISTINCT FROM 'delegated_authorization_code'
          AND connector_mode IS NOT DISTINCT FROM 'microsoft_delegated_oauth'
        )
      )
  `);
  await db.exec(DOWN);
  console.log('ok - down after clearing nulls with constraint present');

  // After down, NULL insert fails via NOT NULL (constraint dropped).
  await expectReject(db, insertSql({
    provider: 'microsoft_graph',
    authMode: 'delegated_authorization_code',
    connectorMode: 'microsoft_delegated_oauth',
    secretRef: null,
  }), 'post-down delegated null');
  console.log('ok - post-down NOT NULL restored');

  // Re-up preflight rejects invalid existing data (simulate delegated NON-NULL
  // which violates policy once 062 would apply). After down, secret_ref is
  // NOT NULL again, so insert delegated NON-NULL first, then attempt up.
  await db.exec(insertSql({
    provider: 'microsoft_graph',
    authMode: 'delegated_authorization_code',
    connectorMode: 'microsoft_delegated_oauth',
    secretRef: SECRET,
  }));
  let preflightBlocked = false;
  try {
    await db.exec(UP);
  } catch (err) {
    preflightBlocked = true;
    assert.match(String(err.message || err), /nullability policy|refuse silent permit/i);
  }
  assert.equal(preflightBlocked, true, 'up preflight must reject invalid existing rows');
  try { await db.exec('ROLLBACK'); } catch { /* idle is fine */ }
  console.log('ok - up preflight rejects invalid existing delegated non-null');

  await db.close();
  console.log('PASS PGlite 062 secret_ref null-policy proof');
}

async function main() {
  assertStaticContract();
  const PGlite = tryLoadPglite();
  if (!PGlite) {
    console.log('note - PGlite unavailable; static contract only (prove on stock PG before deploy)');
    console.log('PASS 062 secret_ref null-policy (static only)');
    return;
  }
  await proveWithPglite(PGlite);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
