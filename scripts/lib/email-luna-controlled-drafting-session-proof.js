'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4A.
 *
 * Tiny composition over Chapter 3 mapped-principal attestation plus the
 * canonical schema_migration_ledger. Never sets checksum_ok from table
 * existence. Never applies migration. Never logs credentials.
 */

const {
  isProxySurface,
  ownData,
  isCanonUuid,
} = require('./email-luna-controlled-drafting-closed-data');
const {
  inspectEmailLunaControlledDraftingMappedPrincipal,
} = require('./email-luna-controlled-drafting-sunset-staging-runtime-composition');

const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const objectPrototype = Object.prototype;
const arrayIsArray = Array.isArray;

const MIGRATION_097_ID = '097_tenant_email_luna_controlled_draft_operations';
const MIGRATION_097_SHA256 = 'e36e2028eaf6d473e399a2326b988c40aad55e58d5f8fb6cfec35f96acfbfb62';
const MIGRATION_098_ID = '098_tenant_email_luna_controlled_drafting_staging_test_authorization';
const MIGRATION_098_SHA256 = '8d181becd9708416d0b02755deba9bf056b7fc927029fa22afd62dc06368d0cc';
const EXPECTED_CHECKSUM_MODE = 'canonical_lf_v1';
const EXPECTED_DATABASE = 'sunset_staging';

const LEDGER_SQL = [
  'SELECT current_database, ledger_097_id, ledger_097_checksum, ledger_097_mode,',
  '       ledger_098_id, ledger_098_checksum, ledger_098_mode',
  '  FROM public.tenant_email_luna_controlled_draft_staging_schema_ready()',
].join('\n');

const PROVE_SQL = [
  'SELECT ok, status, operation_id::text AS operation_id, issuance_id::text AS issuance_id,',
  '       client_id::text AS client_id, location_id::text AS location_id,',
  '       location_key, endpoint_id::text AS endpoint_id, mailbox_id, provider',
  '  FROM public.tenant_email_luna_controlled_draft_staging_test_prove(',
  '    $1::uuid, $2::uuid, $3::uuid, $4::text',
  '  )',
].join('\n');
const CONSUME_SQL = 'SELECT public.tenant_email_luna_controlled_draft_staging_test_consume($1::uuid, $2::uuid, $3::uuid) AS ok';

function freeze(value) {
  return objectFreeze(value);
}

function failedInspect() {
  return freeze({
    ok: false,
    inspect_failed: true,
    schema_applied: false,
    checksum_ok: false,
    principal_applied: false,
    login_ok: false,
    mapping_ok: false,
    execute_ok: false,
    session_user: null,
    current_database: null,
    reason: 'inspect_failed',
  });
}

function resolveQuery(client) {
  if (!client || (typeof client !== 'object' && typeof client !== 'function') || isProxySurface(client)) {
    return null;
  }
  const own = objectGetOwnPropertyDescriptor(client, 'query');
  if (own) {
    return objectHasOwn(own, 'value') && typeof own.value === 'function' && !own.get && !own.set
      ? own.value
      : null;
  }
  let proto = objectGetPrototypeOf(client);
  let depth = 0;
  while (proto && proto !== objectPrototype && depth < 8) {
    if (isProxySurface(proto)) return null;
    const descriptor = objectGetOwnPropertyDescriptor(proto, 'query');
    if (descriptor) {
      return objectHasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
        && !descriptor.get && !descriptor.set
        ? descriptor.value
        : null;
    }
    proto = objectGetPrototypeOf(proto);
    depth += 1;
  }
  return null;
}

function copyLedgerRow(row) {
  try {
    if (!row || typeof row !== 'object' || isProxySurface(row) || arrayIsArray(row)) return null;
    const copy = objectCreate(null);
    const keys = [
      'current_database', 'ledger_097_id', 'ledger_097_checksum', 'ledger_097_mode',
      'ledger_098_id', 'ledger_098_checksum', 'ledger_098_mode',
    ];
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const descriptor = objectGetOwnPropertyDescriptor(row, key);
      if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
        return null;
      }
      const value = descriptor.value;
      if (value !== null && typeof value !== 'string') return null;
      objectDefineProperty(copy, key, {
        value, enumerable: true, writable: true, configurable: true,
      });
    }
    return copy;
  } catch (_) {
    return null;
  }
}

async function inspectEmailLunaControlledDraftingSession(client, binding, kind) {
  if (kind !== 'producer' && kind !== 'worker') return failedInspect();
  const queryFn = resolveQuery(client);
  if (typeof queryFn !== 'function' || isProxySurface(queryFn)) return failedInspect();
  let ledgerResult;
  try {
    ledgerResult = await queryFn.call(client, LEDGER_SQL);
  } catch (_) {
    return failedInspect();
  }
  if (!ledgerResult || typeof ledgerResult !== 'object' || isProxySurface(ledgerResult) || arrayIsArray(ledgerResult)) {
    return failedInspect();
  }
  const rows = ownData(ledgerResult, 'rows');
  if (!arrayIsArray(rows) || rows.length !== 1 || isProxySurface(rows)) return failedInspect();
  const ledger = copyLedgerRow(ownData(rows, 0));
  if (!ledger) return failedInspect();
  const databaseOk = ledger.current_database === EXPECTED_DATABASE;
  const checksum097 = databaseOk
    && ledger.ledger_097_id === MIGRATION_097_ID
    && ledger.ledger_097_checksum === MIGRATION_097_SHA256
    && ledger.ledger_097_mode === EXPECTED_CHECKSUM_MODE;
  const checksum098 = databaseOk
    && ledger.ledger_098_id === MIGRATION_098_ID
    && ledger.ledger_098_checksum === MIGRATION_098_SHA256
    && ledger.ledger_098_mode === EXPECTED_CHECKSUM_MODE;
  const checksumOk = checksum097 === true && checksum098 === true;
  const principal = await inspectEmailLunaControlledDraftingMappedPrincipal(client, binding, kind);
  const inspectFailed = principal.inspect_failed === true;
  const schemaApplied = checksumOk === true && principal.execute_ok === true;
  const ok = inspectFailed !== true
    && checksumOk === true
    && principal.ok === true
    && principal.login_ok === true
    && principal.mapping_ok === true
    && principal.execute_ok === true;
  return freeze({
    ok,
    inspect_failed: inspectFailed,
    schema_applied: schemaApplied,
    checksum_ok: checksumOk,
    principal_applied: principal.principal_applied === true,
    login_ok: principal.login_ok === true,
    mapping_ok: principal.mapping_ok === true,
    execute_ok: principal.execute_ok === true,
    session_user: null,
    current_database: databaseOk ? EXPECTED_DATABASE : null,
    reason: ok ? 'ready' : (checksumOk ? (principal.ok ? 'schema_unproven' : 'principal_unproven') : 'checksum_unproven'),
  });
}

async function proveEmailLunaControlledDraftingStagingTestAuthorization(client, input) {
  const queryFn = resolveQuery(client);
  if (typeof queryFn !== 'function' || isProxySurface(queryFn)) return freeze({ ok: false, reason: 'inspect_failed' });
  if (!input || typeof input !== 'object' || isProxySurface(input) || arrayIsArray(input)) {
    return freeze({ ok: false, reason: 'authorization_unproven' });
  }
  const authorizationId = ownData(input, 'authorization_id');
  const operationId = ownData(input, 'operation_id');
  const issuanceId = ownData(input, 'issuance_id');
  const recipient = ownData(input, 'recipient_address');
  if (!isCanonUuid(authorizationId) || !isCanonUuid(operationId) || !isCanonUuid(issuanceId)) {
    return freeze({ ok: false, reason: 'authorization_unproven' });
  }
  if (typeof recipient !== 'string' || recipient.length < 3) {
    return freeze({ ok: false, reason: 'authorization_unproven' });
  }
  let result;
  try {
    result = await queryFn.call(client, PROVE_SQL, [authorizationId, operationId, issuanceId, recipient]);
  } catch (_) {
    return freeze({ ok: false, reason: 'authorization_unproven' });
  }
  const rows = ownData(result, 'rows');
  if (!arrayIsArray(rows) || rows.length !== 1 || isProxySurface(rows)) {
    return freeze({ ok: false, reason: 'authorization_unproven' });
  }
  const row = ownData(rows, 0);
  if (ownData(row, 'operation_id') !== operationId || ownData(row, 'issuance_id') !== issuanceId) {
    return freeze({ ok: false, reason: 'authorization_binding_mismatch' });
  }
  const status = ownData(row, 'status');
  if (status === 'revoked') {
    return freeze({ ok: false, reason: 'authorization_revoked', status: 'revoked' });
  }
  if (status !== 'authorized' && status !== 'consumed') {
    return freeze({ ok: false, reason: 'authorization_unproven' });
  }
  return freeze({
    ok: true,
    reason: status,
    status,
    authorization_id: authorizationId,
    operation_id: operationId,
    issuance_id: issuanceId,
    client_id: ownData(row, 'client_id') || null,
    location_id: ownData(row, 'location_id') || null,
    location_key: ownData(row, 'location_key') || null,
    endpoint_id: ownData(row, 'endpoint_id') || null,
    mailbox_id: ownData(row, 'mailbox_id') || null,
    provider: ownData(row, 'provider') || null,
  });
}

async function consumeEmailLunaControlledDraftingStagingTestAuthorization(client, input) {
  const queryFn = resolveQuery(client);
  if (typeof queryFn !== 'function' || isProxySurface(queryFn)) return false;
  const authorizationId = ownData(input, 'authorization_id');
  const operationId = ownData(input, 'operation_id');
  const issuanceId = ownData(input, 'issuance_id');
  if (!isCanonUuid(authorizationId) || !isCanonUuid(operationId) || !isCanonUuid(issuanceId)) return false;
  try {
    const result = await queryFn.call(client, CONSUME_SQL, [authorizationId, operationId, issuanceId]);
    const rows = ownData(result, 'rows');
    return arrayIsArray(rows) && rows.length === 1 && ownData(ownData(rows, 0), 'ok') === true;
  } catch (_) {
    return false;
  }
}

module.exports = objectFreeze({
  MIGRATION_097_ID,
  MIGRATION_097_SHA256,
  MIGRATION_098_ID,
  MIGRATION_098_SHA256,
  EXPECTED_CHECKSUM_MODE,
  EXPECTED_DATABASE,
  LEDGER_SQL,
  inspectEmailLunaControlledDraftingSession,
  proveEmailLunaControlledDraftingStagingTestAuthorization,
  consumeEmailLunaControlledDraftingStagingTestAuthorization,
});
