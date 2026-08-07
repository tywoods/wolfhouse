'use strict';

/**
 * Offline recovery-journal store for admin delta recovery operations (migration 065).
 *
 * Import-inert. No routes / runtime / scheduler / worker activation.
 *
 * Factory-fixed deps only (exact keys):
 *   - withTransactionClient (exclusive loan; outer release owner)
 *   - authorityVerifier ({ verifyBinding }) — initial precheck before TX
 *   - inboundDeltaStateStore — authority-bearing factory object from
 *     createInboundEmailDeltaStateStore (only its advanceGenerationOnExclusiveClient
 *     method is captured; no raw primitive import; no nested capability leakage)
 *
 * Public APIs:
 *   - getRecoveryStatus — safe current status + recovery_blocked (active lease)
 *   - restartGeneration — idempotent by operationId/actor/authority/fences;
 *     journal claim + factory-bound authority re-verification + demote/insert +
 *     journal completion in ONE outer transaction via the store object's
 *     advanceGenerationOnExclusiveClient (no nested BEGIN/checkout/release;
 *     no raw primitive import). Authority rebind between initial precheck and
 *     mutation → ROLLBACK / zero durable journal/state mutation.
 *   - reconcilePageCommit — separate reconciliation operationId + targetOperationId;
 *     classifies only durable journal evidence for matching page_commit rows
 *     (migration 066): committed terminal → committed; explicit terminal
 *     not_committed/conflict → same; missing/claimed/ambiguous →
 *     evidence_unavailable / commit_outcome_unknown. Never infers from migration
 *     064 cursor_operation_id / generation / version / lease; never mutates
 *     events/cursor/generation/lease. Does not reimplement event/state SQL.
 *
 * Idempotency:
 *   - same operationId + identical inputs → persisted exact result, zero mutation
 *   - mismatch actor/endpoint/kind/fences → operation_id_conflict
 *   - two IDs same CAS → one committed, one conflict
 *   - COMMIT dispatch ambiguity → commit_outcome_unknown (no retry-as-success)
 *   - retry same ID after committed ack-loss → persisted committed
 *   - rolled-back ambiguity may execute exactly once on same ID
 *
 * Active lease → fail closed (not_committed). Old generation preserved; no cursor
 * copy onto the new generation (PR408 insert path).
 *
 * Pinned intrinsics/proxy/accessor/symbol/nonenumerable hardening.
 * Exact frozen PII-free DTO/errors. Logless (no cursor/mailbox/token/subject).
 *
 * @module email-delta-recovery-operation-store
 */

const util = require('util');

const {
  snapshotOwnDataProps,
} = require('./email-grant-envelope-provider-contract');
const {
  DEFAULT_QUERY_VERSION,
  MAX_SAFE_GENERATION,
  SQL_LOCK_CURRENT,
  SQL_PUBLIC_STATUS,
  resolveWithTransactionClient,
  resolveExclusiveClient,
  resolveAuthorityVerifier,
  parseQueryVersion,
  parsePositiveSafeInt,
} = require('./email-inbound-delta-state-store');

const FAILURE_CODE = 'email_delta_recovery_failed';
const FAILURE_MESSAGE = 'Email delta recovery operation failed.';

/** Store module is not wired into routes/startup/pollers by itself. */
const EMAIL_DELTA_RECOVERY_OPERATION_RUNTIME_WIRED = false;
const EMAIL_DELTA_RECOVERY_OPERATION_LOGGING_FORBIDDEN = true;

const OPERATION_KINDS = Object.freeze([
  'restart_generation',
  'reconcile_page_commit',
  'page_commit',
]);
const ACTOR_KINDS = Object.freeze(['staff', 'worker']);
/** Source-pinned worker actor for page_commit journal rows only. */
const PAGE_COMMIT_WORKER_ID = 'sunset-email-delta-worker';
const OUTCOMES = Object.freeze([
  'claimed',
  'committed',
  'not_committed',
  'commit_outcome_unknown',
  'conflict',
  'evidence_unavailable',
]);

const STORE_DEPENDENCY_KEYS = Object.freeze([
  'withTransactionClient',
  'authorityVerifier',
  'inboundDeltaStateStore',
]);
const AUTHORITY_VERIFIER_KEYS = Object.freeze(['verifyBinding']);
/** Exact method captured from the authority-bearing delta state store object. */
const INBOUND_DELTA_STATE_STORE_ADVANCE_METHOD = 'advanceGenerationOnExclusiveClient';

const RECOVERY_STATUS_KEYS = Object.freeze([
  'state_present',
  'phase',
  'ingestion_generation',
  'query_version',
  'state_version',
  'has_active_lease',
  'recovery_blocked',
]);

const RECOVERY_RESULT_KEYS = Object.freeze([
  'operation_id',
  'operation_kind',
  'outcome',
  'requested_generation',
  'requested_state_version',
  'result_generation',
  'result_state_version',
  'result_phase',
  'target_operation_id',
  'replayed',
]);

const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/* ── Module-init pins ────────────────────────────────────────────────────── */
const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;
const PINNED_OBJECT_PROTOTYPE = Object.prototype;
const PINNED_REFLECT_APPLY = typeof Reflect.apply === 'function' ? Reflect.apply : null;
const PINNED_REFLECT_OWN_KEYS = typeof Reflect.ownKeys === 'function' ? Reflect.ownKeys : null;
const PINNED_GET_OWN_PROPERTY_DESCRIPTOR =
  typeof Object.getOwnPropertyDescriptor === 'function' ? Object.getOwnPropertyDescriptor : null;
const PINNED_GET_PROTOTYPE_OF =
  typeof Object.getPrototypeOf === 'function' ? Object.getPrototypeOf : null;
const PINNED_OBJECT_FREEZE =
  typeof Object.freeze === 'function' ? Object.freeze : null;
const PINNED_IS_FROZEN =
  typeof Object.isFrozen === 'function' ? Object.isFrozen : null;
const PINNED_HAS_OWN =
  typeof Object.prototype.hasOwnProperty === 'function'
    ? Object.prototype.hasOwnProperty
    : null;

const PINNED_INTRINSICS_READY = Boolean(
  PINNED_IS_PROXY
  && PINNED_UTIL_TYPES
  && PINNED_REFLECT_APPLY
  && PINNED_REFLECT_OWN_KEYS
  && PINNED_GET_OWN_PROPERTY_DESCRIPTOR
  && PINNED_GET_PROTOTYPE_OF
  && PINNED_OBJECT_FREEZE
  && PINNED_IS_FROZEN
  && PINNED_HAS_OWN
  && PINNED_OBJECT_PROTOTYPE,
);

function pinnedFreeze(value) {
  return PINNED_OBJECT_FREEZE.call(Object, value);
}

const SQL_SELECT_OPERATION_FOR_UPDATE = `
SELECT operation_id, client_id, location_id, endpoint_id,
       actor_staff_user_id, actor_kind, worker_id,
       operation_kind, requested_generation, requested_state_version,
       target_operation_id, outcome,
       result_generation, result_state_version, result_phase
  FROM tenant_email_delta_recovery_operations
 WHERE operation_id = $1::uuid
 FOR UPDATE
`.replace(/\s+/g, ' ').trim();

const SQL_INSERT_CLAIMED = `
INSERT INTO tenant_email_delta_recovery_operations (
  operation_id, client_id, location_id, endpoint_id,
  actor_staff_user_id, actor_kind, worker_id,
  operation_kind, requested_generation, requested_state_version,
  target_operation_id, outcome
) VALUES (
  $1::uuid, $2::uuid, $3::uuid, $4::uuid,
  $5::uuid, $6, $7,
  $8, $9::bigint, $10::bigint,
  $11::uuid, 'claimed'
)
ON CONFLICT (operation_id) DO NOTHING
RETURNING operation_id
`.replace(/\s+/g, ' ').trim();

const SQL_COMPLETE_COMMITTED_RESTART = `
UPDATE tenant_email_delta_recovery_operations
   SET outcome = 'committed',
       result_generation = $2::bigint,
       result_state_version = $3::bigint,
       result_phase = $4,
       updated_at = NOW()
 WHERE operation_id = $1::uuid
   AND outcome = 'claimed'
 RETURNING operation_id, operation_kind, outcome,
           requested_generation, requested_state_version,
           result_generation, result_state_version, result_phase,
           target_operation_id
`.replace(/\s+/g, ' ').trim();

const SQL_COMPLETE_TERMINAL = `
UPDATE tenant_email_delta_recovery_operations
   SET outcome = $2,
       result_generation = NULL,
       result_state_version = NULL,
       result_phase = NULL,
       updated_at = NOW()
 WHERE operation_id = $1::uuid
   AND outcome = 'claimed'
 RETURNING operation_id, operation_kind, outcome,
           requested_generation, requested_state_version,
           result_generation, result_state_version, result_phase,
           target_operation_id
`.replace(/\s+/g, ' ').trim();

const SQL_SELECT_TARGET_JOURNAL = `
SELECT operation_id, client_id, location_id, endpoint_id,
       actor_staff_user_id, actor_kind, worker_id,
       operation_kind, outcome,
       result_generation, result_state_version, result_phase
  FROM tenant_email_delta_recovery_operations
 WHERE operation_id = $1::uuid
`.replace(/\s+/g, ' ').trim();

function failure(code) {
  const error = new Error(FAILURE_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'EmailDeltaRecoveryOperationError' });
  Object.defineProperty(error, 'code', {
    value: typeof code === 'string' && code ? code : FAILURE_CODE,
    enumerable: true,
  });
  return pinnedFreeze(error);
}

function fail(error) {
  return pinnedFreeze({
    ok: false,
    error: typeof error === 'string' && error ? error : FAILURE_CODE,
  });
}

function ok(value) {
  return value === undefined
    ? pinnedFreeze({ ok: true })
    : pinnedFreeze({ ok: true, value });
}

function isProxySurface(value) {
  try {
    if (!PINNED_INTRINSICS_READY) return true;
    return PINNED_REFLECT_APPLY.call(Reflect, PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true;
  } catch {
    return true;
  }
}

function ownData(object, key) {
  try {
    if (!PINNED_GET_OWN_PROPERTY_DESCRIPTOR || !PINNED_HAS_OWN) return undefined;
    const descriptor = PINNED_GET_OWN_PROPERTY_DESCRIPTOR.call(Object, object, key);
    return descriptor
      && PINNED_HAS_OWN.call(descriptor, 'value')
      && !descriptor.get
      && !descriptor.set
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function parseUuid(raw, field) {
  if (raw == null || typeof raw !== 'string') return fail(`${field}_invalid`);
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || !UUID_CANON.test(trimmed) || trimmed !== raw.trim().toLowerCase()) {
    return fail(`${field}_invalid`);
  }
  return ok(trimmed);
}

function coerceSafeIntField(raw) {
  const p = parsePositiveSafeInt(
    typeof raw === 'bigint' ? raw : (typeof raw === 'number' ? raw : String(raw)),
    'field',
  );
  return p.ok ? p.value : null;
}

function toRecoveryResult(row, replayed) {
  const reqGen = coerceSafeIntField(row.requested_generation);
  const reqSv = coerceSafeIntField(row.requested_state_version);
  const resGen = row.result_generation == null
    ? null
    : coerceSafeIntField(row.result_generation);
  const resSv = row.result_state_version == null
    ? null
    : coerceSafeIntField(row.result_state_version);
  return pinnedFreeze({
    operation_id: String(row.operation_id).toLowerCase(),
    operation_kind: String(row.operation_kind),
    outcome: String(row.outcome),
    requested_generation: reqGen,
    requested_state_version: reqSv,
    result_generation: resGen,
    result_state_version: resSv,
    result_phase: row.result_phase == null ? null : String(row.result_phase),
    target_operation_id: row.target_operation_id == null
      ? null
      : String(row.target_operation_id).toLowerCase(),
    replayed: replayed === true,
  });
}

function inputsMatchRow(row, expected) {
  try {
    if (String(row.client_id).toLowerCase() !== expected.clientId) return false;
    if (String(row.location_id).toLowerCase() !== expected.locationId) return false;
    if (String(row.endpoint_id).toLowerCase() !== expected.endpointId) return false;
    const rowActorKind = row.actor_kind == null ? 'staff' : String(row.actor_kind);
    const expActorKind = expected.actorKind == null ? 'staff' : expected.actorKind;
    if (rowActorKind !== expActorKind) return false;
    const rowStaff = row.actor_staff_user_id == null
      ? null
      : String(row.actor_staff_user_id).toLowerCase();
    const expStaff = expected.actorStaffUserId == null
      ? null
      : expected.actorStaffUserId;
    if (rowStaff !== expStaff) return false;
    const rowWorker = row.worker_id == null ? null : String(row.worker_id);
    const expWorker = expected.workerId == null ? null : expected.workerId;
    if (rowWorker !== expWorker) return false;
    if (String(row.operation_kind) !== expected.operationKind) return false;
    const rg = coerceSafeIntField(row.requested_generation);
    const rsv = coerceSafeIntField(row.requested_state_version);
    if (rg !== expected.requestedGeneration) return false;
    if (rsv !== expected.requestedStateVersion) return false;
    const rowTarget = row.target_operation_id == null
      ? null
      : String(row.target_operation_id).toLowerCase();
    const expTarget = expected.targetOperationId == null
      ? null
      : expected.targetOperationId;
    if (rowTarget !== expTarget) return false;
    return true;
  } catch {
    return false;
  }
}

async function attemptRollback(client) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // no rollback claim
  }
}

/**
 * One outer exclusive TX. Pre-COMMIT structured fail → ROLLBACK.
 * Structured ok (including journaled not_committed/conflict/evidence_unavailable)
 * → COMMIT so the journal outcome is durable.
 * COMMIT sent then reject → exact commit_outcome_unknown (never retry-as-success).
 */
async function withOuterTxn(client, fn) {
  let begun = false;
  let commitSent = false;
  try {
    await client.query('BEGIN');
    begun = true;
    const result = await fn();
    if (result && result.ok === false) {
      await client.query('ROLLBACK');
      begun = false;
      return result;
    }
    commitSent = true;
    await client.query('COMMIT');
    begun = false;
    commitSent = false;
    return result;
  } catch {
    if (commitSent) {
      return fail('commit_outcome_unknown');
    }
    if (begun) await attemptRollback(client);
    return fail('email_delta_recovery_write_failed');
  }
}

function snapshotRequired(input, fields) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return fail('input_invalid');
  }
  if (isProxySurface(input)) return fail('input_invalid');
  const snap = snapshotOwnDataProps(input);
  if (!snap.ok) return fail('input_invalid');
  const out = { snap: snap.value };
  for (const f of fields) {
    if (f === 'operationId') {
      out.operationId = parseUuid(snap.value.operationId, 'operation_id');
      if (!out.operationId.ok) return out.operationId;
    } else if (f === 'clientId') {
      out.clientId = parseUuid(snap.value.clientId, 'client_id');
      if (!out.clientId.ok) return out.clientId;
    } else if (f === 'locationId') {
      out.locationId = parseUuid(snap.value.locationId, 'location_id');
      if (!out.locationId.ok) return out.locationId;
    } else if (f === 'endpointId') {
      out.endpointId = parseUuid(snap.value.endpointId, 'endpoint_id');
      if (!out.endpointId.ok) return out.endpointId;
    } else if (f === 'actorStaffUserId') {
      out.actorStaffUserId = parseUuid(snap.value.actorStaffUserId, 'actor_staff_user_id');
      if (!out.actorStaffUserId.ok) return out.actorStaffUserId;
    } else if (f === 'expectedGeneration') {
      out.expectedGeneration = parsePositiveSafeInt(
        snap.value.expectedGeneration, 'ingestion_generation',
      );
      if (!out.expectedGeneration.ok) return out.expectedGeneration;
    } else if (f === 'expectedStateVersion') {
      out.expectedStateVersion = parsePositiveSafeInt(
        snap.value.expectedStateVersion, 'state_version',
      );
      if (!out.expectedStateVersion.ok) return out.expectedStateVersion;
    } else if (f === 'targetOperationId') {
      out.targetOperationId = parseUuid(snap.value.targetOperationId, 'target_operation_id');
      if (!out.targetOperationId.ok) return out.targetOperationId;
    }
  }
  return out;
}

async function verifyAuthority(authorityVerifier, binding) {
  let verified;
  try {
    verified = await authorityVerifier.verifyBinding(binding);
  } catch {
    return fail('authority_not_verified');
  }
  if (!verified || verified.ok !== true) return fail('authority_not_verified');
  if (verified.value && typeof verified.value === 'object') {
    const v = verified.value;
    if (String(v.clientId || '').toLowerCase() !== binding.clientId
        || String(v.locationId || '').toLowerCase() !== binding.locationId
        || String(v.endpointId || '').toLowerCase() !== binding.endpointId
        || String(v.providerTenantId || '').toLowerCase() !== binding.providerTenantId
        || String(v.providerMailboxId || '').toLowerCase() !== binding.providerMailboxId) {
      return fail('authority_not_verified');
    }
  }
  return ok(true);
}

/**
 * Capture only the authority-bearing exclusive-client generation method from a
 * createInboundEmailDeltaStateStore factory object. Does not re-export nested
 * store methods or leak the raw demote/insert primitive.
 */
function resolveInboundDeltaStateStoreAdvance(raw) {
  try {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (isProxySurface(raw)) return null;
    if (!PINNED_GET_OWN_PROPERTY_DESCRIPTOR || !PINNED_HAS_OWN || !PINNED_REFLECT_APPLY) {
      return null;
    }
    const descriptor = PINNED_GET_OWN_PROPERTY_DESCRIPTOR.call(
      Object, raw, INBOUND_DELTA_STATE_STORE_ADVANCE_METHOD,
    );
    if (!descriptor
        || !PINNED_HAS_OWN.call(descriptor, 'value')
        || typeof descriptor.value !== 'function'
        || descriptor.get
        || descriptor.set
        || isProxySurface(descriptor.value)) {
      return null;
    }
    const captured = descriptor.value;
    // Bind receiver to the factory object so closure/this semantics stay intact
    // without exposing any other nested capability on the recovery surface.
    const receiver = raw;
    return Object.freeze({
      async advanceGenerationOnExclusiveClient(input) {
        return PINNED_REFLECT_APPLY.call(
          Reflect, captured, receiver, [input],
        );
      },
    });
  } catch {
    return null;
  }
}

function createEmailDeltaRecoveryOperationStore(deps) {
  let withTransactionClient;
  let authorityVerifier;
  let inboundDeltaAdvance;
  try {
    if (deps == null || typeof deps !== 'object' || Array.isArray(deps)) throw failure();
    if (isProxySurface(deps)) throw failure();
    const snap = snapshotOwnDataProps(deps);
    if (!snap.ok) throw failure();
    const keySet = new Set(Object.keys(snap.value));
    if (keySet.size !== STORE_DEPENDENCY_KEYS.length) throw failure();
    for (const k of STORE_DEPENDENCY_KEYS) {
      if (!keySet.has(k)) throw failure();
    }
    withTransactionClient = resolveWithTransactionClient(snap.value.withTransactionClient);
    if (!withTransactionClient) throw failure();
    authorityVerifier = resolveAuthorityVerifier(snap.value.authorityVerifier);
    if (!authorityVerifier) throw failure();
    inboundDeltaAdvance = resolveInboundDeltaStateStoreAdvance(snap.value.inboundDeltaStateStore);
    if (!inboundDeltaAdvance) throw failure();
  } catch (err) {
    if (err && err.code === FAILURE_CODE) throw err;
    throw failure();
  }

  async function runExclusive(work) {
    try {
      return await withTransactionClient(async (client) => work(client));
    } catch (err) {
      if (err && err.code === FAILURE_CODE) return fail(FAILURE_CODE);
      return fail('email_delta_recovery_write_failed');
    }
  }

  async function getRecoveryStatus(input) {
    const ids = snapshotRequired(input, ['clientId', 'endpointId']);
    if (ids.ok === false) return ids;
    return runExclusive(async (client) => {
      try {
        const exclusive = resolveExclusiveClient(client);
        if (!exclusive) return fail('email_delta_recovery_write_failed');
        const r = await exclusive.query(SQL_PUBLIC_STATUS, [
          ids.clientId.value, ids.endpointId.value,
        ]);
        if (!r.rows || r.rows.length === 0) {
          return ok(pinnedFreeze({
            state_present: false,
            phase: null,
            ingestion_generation: null,
            query_version: null,
            state_version: null,
            has_active_lease: false,
            recovery_blocked: false,
          }));
        }
        const row = r.rows[0];
        const gen = coerceSafeIntField(row.ingestion_generation);
        const sv = coerceSafeIntField(row.state_version);
        const hasLease = row.has_active_lease === true;
        return ok(pinnedFreeze({
          state_present: true,
          phase: row.phase == null ? null : String(row.phase),
          ingestion_generation: gen,
          query_version: row.query_version == null ? null : String(row.query_version),
          state_version: sv,
          has_active_lease: hasLease,
          recovery_blocked: hasLease,
        }));
      } catch {
        return fail('email_delta_recovery_write_failed');
      }
    });
  }

  /**
   * Claim-or-replay helper inside an open TX.
   * Returns { kind:'replay', result } | { kind:'claimed' } | fail(...)
   */
  async function claimOrReplay(exclusive, expected) {
    const existing = await exclusive.query(SQL_SELECT_OPERATION_FOR_UPDATE, [
      expected.operationId,
    ]);
    if (existing.rows && existing.rows.length === 1) {
      const row = existing.rows[0];
      if (!inputsMatchRow(row, expected)) {
        return fail('operation_id_conflict');
      }
      // claimed with matching inputs should not be durable mid-flight under
      // single-TX model; treat as conflict to fail closed rather than re-run
      // half-finished work from another connection.
      if (String(row.outcome) === 'claimed') {
        return fail('operation_id_conflict');
      }
      return ok(pinnedFreeze({ kind: 'replay', row }));
    }

    const actorKind = expected.actorKind == null ? 'staff' : expected.actorKind;
    const ins = await exclusive.query(SQL_INSERT_CLAIMED, [
      expected.operationId,
      expected.clientId,
      expected.locationId,
      expected.endpointId,
      expected.actorStaffUserId,
      actorKind,
      expected.workerId == null ? null : expected.workerId,
      expected.operationKind,
      String(expected.requestedGeneration),
      String(expected.requestedStateVersion),
      expected.targetOperationId,
    ]);
    if (ins.rows && ins.rows.length === 1) {
      return ok(pinnedFreeze({ kind: 'claimed' }));
    }

    // Concurrent insert won the race — lock and compare.
    const raced = await exclusive.query(SQL_SELECT_OPERATION_FOR_UPDATE, [
      expected.operationId,
    ]);
    if (!raced.rows || raced.rows.length !== 1) {
      return fail('email_delta_recovery_write_failed');
    }
    const row = raced.rows[0];
    if (!inputsMatchRow(row, expected)) {
      return fail('operation_id_conflict');
    }
    if (String(row.outcome) === 'claimed') {
      return fail('operation_id_conflict');
    }
    return ok(pinnedFreeze({ kind: 'replay', row }));
  }

  async function restartGeneration(input) {
    const ids = snapshotRequired(input, [
      'operationId', 'clientId', 'locationId', 'endpointId', 'actorStaffUserId',
      'expectedGeneration', 'expectedStateVersion',
    ]);
    if (ids.ok === false) return ids;
    const tenant = parseUuid(ids.snap.providerTenantId, 'provider_tenant_id');
    if (!tenant.ok) return tenant;
    const mailbox = parseUuid(ids.snap.providerMailboxId, 'provider_mailbox_id');
    if (!mailbox.ok) return mailbox;
    const qv = parseQueryVersion(
      ids.snap.queryVersion == null ? DEFAULT_QUERY_VERSION : ids.snap.queryVersion,
    );
    if (!qv.ok) return qv;

    if (Object.prototype.hasOwnProperty.call(ids.snap, 'verifiedAuthority')) {
      return fail('authority_not_verified');
    }

    const binding = pinnedFreeze({
      clientId: ids.clientId.value,
      locationId: ids.locationId.value,
      endpointId: ids.endpointId.value,
      providerTenantId: tenant.value,
      providerMailboxId: mailbox.value,
    });
    const auth = await verifyAuthority(authorityVerifier, binding);
    if (!auth.ok) return auth;

    const expected = pinnedFreeze({
      operationId: ids.operationId.value,
      clientId: ids.clientId.value,
      locationId: ids.locationId.value,
      endpointId: ids.endpointId.value,
      actorStaffUserId: ids.actorStaffUserId.value,
      actorKind: 'staff',
      workerId: null,
      operationKind: 'restart_generation',
      requestedGeneration: ids.expectedGeneration.value,
      requestedStateVersion: ids.expectedStateVersion.value,
      targetOperationId: null,
    });

    return runExclusive(async (client) => withOuterTxn(client, async () => {
      const exclusive = resolveExclusiveClient(client);
      if (!exclusive) return fail('email_delta_recovery_write_failed');

      const claim = await claimOrReplay(exclusive, expected);
      if (!claim.ok) return claim;
      if (claim.value.kind === 'replay') {
        return ok(toRecoveryResult(claim.value.row, true));
      }

      // Lock current delta state; re-fence authority + active lease fail closed.
      const locked = await exclusive.query(SQL_LOCK_CURRENT, [
        ids.clientId.value, ids.endpointId.value,
      ]);
      if (!locked.rows || locked.rows.length !== 1) {
        const term = await exclusive.query(SQL_COMPLETE_TERMINAL, [
          ids.operationId.value, 'not_committed',
        ]);
        if (!term.rows || term.rows.length !== 1) {
          return fail('email_delta_recovery_write_failed');
        }
        return ok(toRecoveryResult(term.rows[0], false));
      }
      const row = locked.rows[0];
      if (String(row.client_id).toLowerCase() !== ids.clientId.value
          || String(row.location_id).toLowerCase() !== ids.locationId.value
          || String(row.endpoint_id).toLowerCase() !== ids.endpointId.value) {
        const term = await exclusive.query(SQL_COMPLETE_TERMINAL, [
          ids.operationId.value, 'conflict',
        ]);
        if (!term.rows || term.rows.length !== 1) {
          return fail('email_delta_recovery_write_failed');
        }
        return ok(toRecoveryResult(term.rows[0], false));
      }
      if (String(row.provider_tenant_id).toLowerCase() !== tenant.value
          || String(row.provider_mailbox_id).toLowerCase() !== mailbox.value) {
        const term = await exclusive.query(SQL_COMPLETE_TERMINAL, [
          ids.operationId.value, 'conflict',
        ]);
        if (!term.rows || term.rows.length !== 1) {
          return fail('email_delta_recovery_write_failed');
        }
        return ok(toRecoveryResult(term.rows[0], false));
      }

      const rowGen = coerceSafeIntField(row.ingestion_generation);
      const rowSv = coerceSafeIntField(row.state_version);
      if (rowGen == null || rowSv == null) {
        return fail('email_delta_recovery_write_failed');
      }
      if (rowGen !== ids.expectedGeneration.value
          || rowSv !== ids.expectedStateVersion.value) {
        const term = await exclusive.query(SQL_COMPLETE_TERMINAL, [
          ids.operationId.value, 'conflict',
        ]);
        if (!term.rows || term.rows.length !== 1) {
          return fail('email_delta_recovery_write_failed');
        }
        return ok(toRecoveryResult(term.rows[0], false));
      }

      // Active lease fail closed — journal not_committed, no generation advance.
      const leaseLive = await exclusive.query(
        `SELECT (lease_token IS NOT NULL AND lease_until IS NOT NULL
                 AND lease_until > clock_timestamp()) AS ok
           FROM tenant_email_inbound_delta_states
          WHERE client_id = $1::uuid AND endpoint_id = $2::uuid AND is_current = true`,
        [ids.clientId.value, ids.endpointId.value],
      );
      if (leaseLive.rows && leaseLive.rows[0] && leaseLive.rows[0].ok === true) {
        const term = await exclusive.query(SQL_COMPLETE_TERMINAL, [
          ids.operationId.value, 'not_committed',
        ]);
        if (!term.rows || term.rows.length !== 1) {
          return fail('email_delta_recovery_write_failed');
        }
        return ok(toRecoveryResult(term.rows[0], false));
      }

      // Same exclusive client; no nested BEGIN — factory-bound method re-verifies
      // authority (unavoidable) then demotes + inserts. Authority rebind since
      // initial precheck → fail closed and ROLLBACK (zero durable journal/state).
      const advanced = await inboundDeltaAdvance.advanceGenerationOnExclusiveClient(
        pinnedFreeze({
          exclusiveClient: exclusive,
          clientId: ids.clientId.value,
          locationId: ids.locationId.value,
          endpointId: ids.endpointId.value,
          expectedGeneration: ids.expectedGeneration.value,
          expectedStateVersion: ids.expectedStateVersion.value,
          providerTenantId: tenant.value,
          providerMailboxId: mailbox.value,
          queryVersion: qv.value,
        }),
      );
      if (!advanced || advanced.ok !== true) {
        // Authority failure after claim must not journal a terminal outcome —
        // withOuterTxn ROLLBACKs so claim + state stay undurable.
        if (advanced && advanced.error === 'authority_not_verified') {
          return fail('authority_not_verified');
        }
        if (advanced && advanced.error === 'authority_verifier_required') {
          return fail('authority_not_verified');
        }
        const outcome = advanced && advanced.error === 'generation_cas_conflict'
          ? 'conflict'
          : 'not_committed';
        const term = await exclusive.query(SQL_COMPLETE_TERMINAL, [
          ids.operationId.value, outcome,
        ]);
        if (!term.rows || term.rows.length !== 1) {
          return fail('email_delta_recovery_write_failed');
        }
        return ok(toRecoveryResult(term.rows[0], false));
      }

      const done = await exclusive.query(SQL_COMPLETE_COMMITTED_RESTART, [
        ids.operationId.value,
        String(advanced.value.ingestion_generation),
        String(advanced.value.state_version),
        advanced.value.phase,
      ]);
      if (!done.rows || done.rows.length !== 1) {
        return fail('email_delta_recovery_write_failed');
      }
      return ok(toRecoveryResult(done.rows[0], false));
    }));
  }

  /**
   * Reconcile a page-commit operation id against durable journal evidence only.
   * Classifies matching page_commit rows (066):
   *   committed terminal → committed
   *   explicit terminal not_committed / conflict → same
   *   commit_outcome_unknown → commit_outcome_unknown
   *   missing / claimed / non-page_commit → evidence_unavailable
   * Cross-tenant/endpoint mismatch on a durable target → conflict.
   * Never consults 064 cursor_operation_id / generation / lease / state.
   * Never mutates events/cursor/generation/lease. No event/state SQL here.
   */
  async function reconcilePageCommit(input) {
    const ids = snapshotRequired(input, [
      'operationId', 'targetOperationId',
      'clientId', 'locationId', 'endpointId', 'actorStaffUserId',
      'expectedGeneration', 'expectedStateVersion',
    ]);
    if (ids.ok === false) return ids;

    // Authority verify uses endpoint binding only when provider fields supplied;
    // for reconcile, require providerTenantId/providerMailboxId for verifier fence.
    const tenant = parseUuid(ids.snap.providerTenantId, 'provider_tenant_id');
    if (!tenant.ok) return tenant;
    const mailbox = parseUuid(ids.snap.providerMailboxId, 'provider_mailbox_id');
    if (!mailbox.ok) return mailbox;

    if (Object.prototype.hasOwnProperty.call(ids.snap, 'verifiedAuthority')) {
      return fail('authority_not_verified');
    }

    const binding = pinnedFreeze({
      clientId: ids.clientId.value,
      locationId: ids.locationId.value,
      endpointId: ids.endpointId.value,
      providerTenantId: tenant.value,
      providerMailboxId: mailbox.value,
    });
    const auth = await verifyAuthority(authorityVerifier, binding);
    if (!auth.ok) return auth;

    // Same operationId must not equal target.
    if (ids.operationId.value === ids.targetOperationId.value) {
      return fail('target_operation_id_invalid');
    }

    const expected = pinnedFreeze({
      operationId: ids.operationId.value,
      clientId: ids.clientId.value,
      locationId: ids.locationId.value,
      endpointId: ids.endpointId.value,
      actorStaffUserId: ids.actorStaffUserId.value,
      actorKind: 'staff',
      workerId: null,
      operationKind: 'reconcile_page_commit',
      requestedGeneration: ids.expectedGeneration.value,
      requestedStateVersion: ids.expectedStateVersion.value,
      targetOperationId: ids.targetOperationId.value,
    });

    return runExclusive(async (client) => withOuterTxn(client, async () => {
      const exclusive = resolveExclusiveClient(client);
      if (!exclusive) return fail('email_delta_recovery_write_failed');

      const claim = await claimOrReplay(exclusive, expected);
      if (!claim.ok) return claim;
      if (claim.value.kind === 'replay') {
        return ok(toRecoveryResult(claim.value.row, true));
      }

      // Durable journal evidence only — never consult 064 cursor/state/lease.
      const target = await exclusive.query(SQL_SELECT_TARGET_JOURNAL, [
        ids.targetOperationId.value,
      ]);
      let classify = 'evidence_unavailable';
      if (target && target.rows && target.rows.length === 1) {
        const t = target.rows[0];
        const sameTenant = String(t.client_id).toLowerCase() === ids.clientId.value
          && String(t.location_id).toLowerCase() === ids.locationId.value
          && String(t.endpoint_id).toLowerCase() === ids.endpointId.value;
        if (!sameTenant) {
          classify = 'conflict';
        } else if (String(t.operation_kind) !== 'page_commit') {
          // restart_generation / reconcile rows are not page-commit evidence.
          classify = 'evidence_unavailable';
        } else if (String(t.outcome) === 'committed') {
          classify = 'committed';
        } else if (String(t.outcome) === 'not_committed') {
          classify = 'not_committed';
        } else if (String(t.outcome) === 'conflict') {
          classify = 'conflict';
        } else if (String(t.outcome) === 'commit_outcome_unknown') {
          classify = 'commit_outcome_unknown';
        } else {
          // claimed / other non-terminal → evidence unavailable (never guess).
          classify = 'evidence_unavailable';
        }
      }

      // Do not change events/cursor/generation/lease.
      const term = await exclusive.query(SQL_COMPLETE_TERMINAL, [
        ids.operationId.value, classify,
      ]);
      if (!term.rows || term.rows.length !== 1) {
        return fail('email_delta_recovery_write_failed');
      }
      return ok(toRecoveryResult(term.rows[0], false));
    }));
  }

  return pinnedFreeze({
    getRecoveryStatus,
    restartGeneration,
    reconcilePageCommit,
  });
}

module.exports = pinnedFreeze({
  FAILURE_CODE,
  FAILURE_MESSAGE,
  EMAIL_DELTA_RECOVERY_OPERATION_RUNTIME_WIRED,
  EMAIL_DELTA_RECOVERY_OPERATION_LOGGING_FORBIDDEN,
  OPERATION_KINDS,
  ACTOR_KINDS,
  PAGE_COMMIT_WORKER_ID,
  OUTCOMES,
  STORE_DEPENDENCY_KEYS,
  AUTHORITY_VERIFIER_KEYS,
  RECOVERY_STATUS_KEYS,
  RECOVERY_RESULT_KEYS,
  createEmailDeltaRecoveryOperationStore,
});
