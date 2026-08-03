'use strict';

/**
 * Slice 2F-A: durable delegated refresh-grant custodian repository.
 * Dedicated tenant_email_delegated_grants; pinned {client} writes; short TX only
 * (no TX across I/O — seal/open and MS exchange stay OUTSIDE transactions).
 * Lease TTL via SQL clock_timestamp(). Public DTOs omit secrets/envelope/lease tokens.
 * openDelegatedGrantUnderLease re-reads under short pinned TX then opens AFTER COMMIT.
 * withTxn: pre-COMMIT → ROLLBACK; COMMIT sent then reject → commit_outcome_unknown.
 * @module email-delegated-grant-custodian
 */

const crypto = require('crypto');
const {
  validateGrantEnvelopeRecordV1,
  validateEmailGrantEnvelopeProvider,
  buildGrantEnvelopeAadV1,
  snapshotOwnDataProps,
} = require('./email-grant-envelope-provider-contract');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_REAUTH_REASONS = Object.freeze([
  'invalid_grant', 'revocation', 'policy', 'consent_loss',
]);
const RECONCILE_STATES = Object.freeze([
  'clean', 'ms_response_uncertain', 'rewrap_pending', 'needs_operator',
]);
const RECONCILE_DETAIL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MIN_TTL = 5;
const MAX_TTL = 3600;
const DEFAULT_TTL = 60;

const ENVELOPE_COLS = 'envelope_version, aead_alg, kek_wrap_alg, kek_key_name, kek_key_version, nonce, ciphertext, auth_tag, wrapped_dek';
const SQL_LOCK_GRANT = `
  SELECT g.*, e.binding_status AS endpoint_binding_status
    FROM tenant_email_delegated_grants g
    INNER JOIN tenant_channel_endpoints e
      ON e.id = g.endpoint_id AND e.client_id = g.client_id
   WHERE g.client_id = $1 AND g.endpoint_id = $2
   FOR UPDATE OF g`;
const SQL_LOCK_ENDPOINT = `
  SELECT id, client_id, provider, auth_mode, connector_mode, binding_status
    FROM tenant_channel_endpoints
   WHERE client_id = $1 AND id = $2 FOR UPDATE`;
// Shared promote/rewrap CAS: advance generation + write envelope under unexpired lease.
const SQL_COMMIT_ENVELOPE = `
  UPDATE tenant_email_delegated_grants
     SET grant_generation=$3, grant_status='active',
         grant_lease_owner=NULL, grant_lease_token=NULL, grant_lease_until=NULL,
         last_operation_id=$4, envelope_version=$5, aead_alg=$6, kek_wrap_alg=$7,
         kek_key_name=$8, kek_key_version=$9, nonce=$10, ciphertext=$11, auth_tag=$12,
         wrapped_dek=$13, reconcile_state='clean', reconcile_detail_code=NULL, updated_at=NOW()
   WHERE client_id=$1 AND endpoint_id=$2 AND grant_generation=$14
     AND grant_lease_token=$15::uuid AND grant_status='lease_held'
     AND grant_lease_until > clock_timestamp()
   RETURNING client_id, endpoint_id, grant_generation, grant_status, reconcile_state`;

function fail(error, details) {
  const out = { ok: false, error: String(error) };
  if (details !== undefined) out.details = Object.freeze({ ...details });
  return Object.freeze(out);
}
function ok(value) {
  return value === undefined ? Object.freeze({ ok: true }) : Object.freeze({ ok: true, value });
}
function looksLikePgPool(obj) {
  return Boolean(obj && typeof obj === 'object' && typeof obj.connect === 'function'
    && (typeof obj.totalCount === 'number' || typeof obj.idleCount === 'number'
      || typeof obj.waitingCount === 'number'));
}
function requireTransactionClient(deps) {
  if (!deps || typeof deps !== 'object' || deps.client == null) return fail('transaction_client_required');
  if (typeof deps.client !== 'object' || typeof deps.client.query !== 'function') {
    return fail('transaction_client_invalid', { reason: 'query_function_required' });
  }
  if (looksLikePgPool(deps.client)) return fail('transaction_client_invalid', { reason: 'pool_not_allowed' });
  return ok(deps.client);
}
function requireDb(deps) {
  if (!deps || typeof deps !== 'object') return fail('db_required');
  const db = deps.db != null ? deps.db : deps.client;
  if (!db || typeof db.query !== 'function') return fail('db_required');
  return ok(db);
}
async function rollbackQuiet(client) {
  try { await client.query('ROLLBACK'); } catch (_) { /* */ }
}
function parseUuid(raw, field) {
  if (raw == null || typeof raw !== 'string') return fail(`${field}_invalid`, { reason: 'must_be_string' });
  const v = raw.trim().toLowerCase();
  if (!v || !UUID_RE.test(v)) return fail(`${field}_invalid`);
  return ok(v);
}
function parseWorkerId(raw) {
  if (typeof raw !== 'string') return fail('worker_id_invalid');
  const v = raw.trim();
  if (v.length < 1 || v.length > 128 || /\s/.test(v)) return fail('worker_id_invalid');
  return ok(v);
}
function parseTtl(raw) {
  const n = raw == null ? DEFAULT_TTL : Number(raw);
  if (!Number.isInteger(n) || n < MIN_TTL || n > MAX_TTL) return fail('ttl_invalid');
  return ok(n);
}
function parseGen(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fail('generation_invalid');
  return ok(n);
}
function dbErr() { return fail('db_error'); }

function toPublicGrantStatusDto(row) {
  if (!row) {
    return Object.freeze({
      grant_present: false, grant_generation: null, grant_status: null,
      reconcile_state: null, has_active_lease: false,
    });
  }
  return Object.freeze({
    grant_present: true,
    endpoint_id: row.endpoint_id,
    client_id: row.client_id,
    grant_generation: Number(row.grant_generation),
    grant_status: row.grant_status,
    reconcile_state: row.reconcile_state,
    has_active_lease: row.grant_status === 'lease_held' && row.grant_lease_token != null,
  });
}

/** Private lease handle — ids + token only; never envelope material. */
function toPrivateLeaseHandle(row) {
  return Object.freeze({
    client_id: row.client_id,
    endpoint_id: row.endpoint_id,
    grant_generation: Number(row.grant_generation),
    lease_token: row.grant_lease_token,
    lease_until: row.grant_lease_until,
    last_operation_id: row.last_operation_id,
  });
}

function envelopeFromAuthoritativeRow(row) {
  return {
    envelope_version: row.envelope_version,
    aead_alg: row.aead_alg,
    kek_wrap_alg: row.kek_wrap_alg,
    kek_key_name: row.kek_key_name,
    kek_key_version: row.kek_key_version,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    auth_tag: row.auth_tag,
    wrapped_dek: row.wrapped_dek,
    operation_id: row.last_operation_id,
  };
}

/** Short TX: pre-COMMIT → ROLLBACK; COMMIT sent then reject → commit_outcome_unknown. */
async function withTxn(client, fn) {
  let began = false;
  let commitSent = false;
  try {
    await client.query('BEGIN');
    began = true;
    const result = await fn();
    if (result && result.ok === false) {
      await client.query('ROLLBACK');
      began = false;
      return result;
    }
    commitSent = true;
    await client.query('COMMIT');
    began = false;
    commitSent = false;
    return result;
  } catch (err) {
    if (commitSent) {
      // COMMIT dispatched; outcome unknown — do not ROLLBACK or claim restored state.
      return fail('commit_outcome_unknown');
    }
    if (began) await rollbackQuiet(client);
    const code = err && err.code ? String(err.code) : '';
    if (code === '23505') return fail('grant_already_exists');
    if (code === '23514') return fail('grant_custody_not_applicable');
    return dbErr();
  }
}

function idsFrom(input, fields) {
  let snap;
  try {
    snap = snapshotOwnDataProps(input == null ? {} : input);
  } catch {
    return fail('input_invalid', { reason: 'reflection_failed' });
  }
  if (!snap.ok) {
    return fail('input_invalid', {
      reason: snap.reason === 'reflection_failed' ? 'reflection_failed' : snap.reason,
    });
  }
  const out = { snap: snap.value };
  if (fields.includes('clientId')) {
    out.clientId = parseUuid(snap.value.clientId, 'client_id');
    if (!out.clientId.ok) return out.clientId;
  }
  if (fields.includes('endpointId')) {
    out.endpointId = parseUuid(snap.value.endpointId, 'endpoint_id');
    if (!out.endpointId.ok) return out.endpointId;
  }
  return out;
}

/** Require pinned client + ids + leaseToken + expectedGeneration. */
function requireLeaseCasInput(input, deps) {
  const cc = requireTransactionClient(deps);
  if (!cc.ok) return cc;
  const ids = idsFrom(input, ['clientId', 'endpointId']);
  if (ids.ok === false) return ids;
  const leaseToken = parseUuid(ids.snap.leaseToken, 'lease_token');
  if (!leaseToken.ok) return leaseToken;
  const expected = parseGen(ids.snap.expectedGeneration);
  if (!expected.ok) return expected;
  return { ok: true, client: cc.value, ids, leaseToken, expected, snap: ids.snap };
}

/** Validate envelope + operation_id match for promote/rewrap. */
function requireEnvelopeOp(snap, errCode) {
  const opId = parseUuid(snap.operationId, 'operation_id');
  if (!opId.ok) return opId;
  const env = validateGrantEnvelopeRecordV1(snap.envelope);
  if (!env.ok) return env;
  if (env.value.operation_id !== opId.value) return fail(errCode, { reason: 'operation_id_mismatch' });
  return { ok: true, opId, env: env.value };
}

function envelopeCommitParams(clientId, endpointId, expected, opId, e, leaseToken) {
  return [
    clientId, endpointId, expected + 1, opId,
    e.envelope_version, e.aead_alg, e.kek_wrap_alg, e.kek_key_name, e.kek_key_version,
    e.nonce, e.ciphertext, e.auth_tag, e.wrapped_dek, expected, leaseToken,
  ];
}

async function installInitialDelegatedGrant(input, deps) {
  const cc = requireTransactionClient(deps);
  if (!cc.ok) return cc;
  const ids = idsFrom(input, ['clientId', 'endpointId']);
  if (ids.ok === false) return ids;
  const opId = parseUuid(ids.snap.operationId, 'operation_id');
  if (!opId.ok) return opId;
  const env = validateGrantEnvelopeRecordV1(ids.snap.envelope);
  if (!env.ok) return env;
  if (env.value.operation_id !== opId.value) return fail('install_input_invalid', { reason: 'operation_id_mismatch' });
  let actor = null;
  if (ids.snap.actorStaffUserId != null) {
    const a = parseUuid(ids.snap.actorStaffUserId, 'actor_staff_user_id');
    if (!a.ok) return a;
    actor = a.value;
  }
  const e = env.value;
  return withTxn(cc.value, async () => {
    const ep = await cc.value.query(SQL_LOCK_ENDPOINT, [ids.clientId.value, ids.endpointId.value]);
    if (!ep.rows || ep.rows.length !== 1) return fail('endpoint_not_found');
    const row = ep.rows[0];
    if (row.provider !== 'microsoft_graph'
      || row.auth_mode !== 'delegated_authorization_code'
      || row.connector_mode !== 'microsoft_delegated_oauth') {
      return fail('grant_custody_not_applicable');
    }
    const ins = await cc.value.query(
      `INSERT INTO tenant_email_delegated_grants (
         client_id, endpoint_id, grant_generation, grant_status, last_operation_id, reconcile_state,
         ${ENVELOPE_COLS}, created_by, updated_by
       ) VALUES ($1,$2,1,'active',$3,'clean',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
       RETURNING client_id, endpoint_id, grant_generation, grant_status, reconcile_state`,
      [
        ids.clientId.value, ids.endpointId.value, opId.value,
        e.envelope_version, e.aead_alg, e.kek_wrap_alg, e.kek_key_name, e.kek_key_version,
        e.nonce, e.ciphertext, e.auth_tag, e.wrapped_dek, actor,
      ],
    );
    return ok(toPublicGrantStatusDto(ins.rows[0]));
  });
}

async function tryAcquireDelegatedGrantLease(input, deps) {
  const cc = requireTransactionClient(deps);
  if (!cc.ok) return cc;
  const ids = idsFrom(input, ['clientId', 'endpointId']);
  if (ids.ok === false) return ids;
  const workerId = parseWorkerId(ids.snap.workerId);
  if (!workerId.ok) return workerId;
  const ttl = parseTtl(ids.snap.ttlSeconds);
  if (!ttl.ok) return ttl;
  const leaseToken = crypto.randomUUID();
  return withTxn(cc.value, async () => {
    const res = await cc.value.query(SQL_LOCK_GRANT, [ids.clientId.value, ids.endpointId.value]);
    if (!res.rows || res.rows.length !== 1) return fail('grant_not_found');
    const g = res.rows[0];
    if (g.grant_status === 'reauthorization_required' || g.grant_status === 'revoked') {
      return fail('grant_reauthorization_required');
    }
    if (g.grant_status === 'lease_held') {
      const exp = await cc.value.query(
        `SELECT (grant_lease_until IS NOT NULL AND grant_lease_until < clock_timestamp()) AS expired
           FROM tenant_email_delegated_grants WHERE client_id=$1 AND endpoint_id=$2`,
        [ids.clientId.value, ids.endpointId.value],
      );
      if (!(exp.rows[0] && exp.rows[0].expired === true)) return fail('lease_held_by_other');
    } else if (g.grant_status !== 'active') {
      return fail('grant_status_invalid');
    }
    const upd = await cc.value.query(
      `UPDATE tenant_email_delegated_grants
          SET grant_status='lease_held', grant_lease_owner=$3, grant_lease_token=$4::uuid,
              grant_lease_until=clock_timestamp()+($5::text||' seconds')::interval, updated_at=NOW()
        WHERE client_id=$1 AND endpoint_id=$2 AND grant_generation=$6
          AND (grant_status='active'
               OR (grant_status='lease_held' AND grant_lease_until < clock_timestamp()))
        RETURNING *`,
      [ids.clientId.value, ids.endpointId.value, workerId.value, leaseToken, String(ttl.value), g.grant_generation],
    );
    if (!upd.rows || upd.rows.length !== 1) return fail('lease_acquire_conflict');
    return ok(toPrivateLeaseHandle(upd.rows[0]));
  });
}

async function renewDelegatedGrantLease(input, deps) {
  const cas = requireLeaseCasInput(input, deps);
  if (!cas.ok) return cas;
  const ttl = parseTtl(cas.snap.ttlSeconds);
  if (!ttl.ok) return ttl;
  return withTxn(cas.client, async () => {
    const upd = await cas.client.query(
      `UPDATE tenant_email_delegated_grants
          SET grant_lease_until=clock_timestamp()+($5::text||' seconds')::interval, updated_at=NOW()
        WHERE client_id=$1 AND endpoint_id=$2 AND grant_generation=$3
          AND grant_lease_token=$4::uuid AND grant_status='lease_held'
          AND grant_lease_until > clock_timestamp()
        RETURNING grant_generation, grant_status`,
      [cas.ids.clientId.value, cas.ids.endpointId.value, cas.expected.value, cas.leaseToken.value, String(ttl.value)],
    );
    if (!upd.rows || upd.rows.length !== 1) return fail('lease_fenced');
    return ok(Object.freeze({
      grant_generation: Number(upd.rows[0].grant_generation),
      grant_status: upd.rows[0].grant_status,
      renewed: true,
    }));
  });
}

/**
 * Open under held lease: re-read row in short pinned TX (token+gen+unexpired);
 * envelope from row only; provider open after COMMIT. Stale handles skip provider.
 */
async function openDelegatedGrantUnderLease(input, deps) {
  const cc = requireTransactionClient(deps);
  if (!cc.ok) return cc;
  const prov = validateEmailGrantEnvelopeProvider(deps && deps.envelopeProvider);
  if (!prov.ok) return prov;

  let clientId;
  let endpointId;
  let leaseToken;
  let gen;
  const ids = idsFrom(input, ['clientId', 'endpointId']);
  if (ids.ok !== false) {
    clientId = ids.clientId;
    endpointId = ids.endpointId;
    leaseToken = parseUuid(
      ids.snap.leaseToken != null ? ids.snap.leaseToken : ids.snap.lease_token, 'lease_token',
    );
    gen = parseGen(
      ids.snap.expectedGeneration != null ? ids.snap.expectedGeneration : ids.snap.grant_generation,
    );
  } else {
    // CamelCase ids failed — try private-handle snake_case shape.
    let snap;
    try {
      snap = snapshotOwnDataProps(input == null ? {} : input);
    } catch {
      return fail('open_handle_invalid', { reason: 'reflection_failed' });
    }
    if (!snap.ok) {
      return fail('open_handle_invalid', {
        reason: snap.reason === 'reflection_failed' ? 'reflection_failed' : snap.reason,
      });
    }
    clientId = parseUuid(snap.value.client_id, 'client_id');
    endpointId = parseUuid(snap.value.endpoint_id, 'endpoint_id');
    leaseToken = parseUuid(snap.value.lease_token, 'lease_token');
    gen = parseGen(snap.value.grant_generation);
  }
  if (!clientId.ok) return clientId;
  if (!endpointId.ok) return endpointId;
  if (!leaseToken.ok) return leaseToken;
  if (!gen.ok) return gen;

  let envelopeSnap = null;
  let aadGen = gen.value;
  let aadOp = null;

  const txResult = await withTxn(cc.value, async () => {
    const res = await cc.value.query(
      `SELECT client_id, endpoint_id, grant_generation, grant_status,
              grant_lease_token, grant_lease_until, last_operation_id,
              ${ENVELOPE_COLS}
         FROM tenant_email_delegated_grants
        WHERE client_id=$1 AND endpoint_id=$2 AND grant_generation=$3
          AND grant_lease_token=$4::uuid AND grant_status='lease_held'
          AND grant_lease_until > clock_timestamp()
        FOR UPDATE`,
      [clientId.value, endpointId.value, gen.value, leaseToken.value],
    );
    if (!res.rows || res.rows.length !== 1) return fail('lease_fenced');
    const row = res.rows[0];
    const env = validateGrantEnvelopeRecordV1(envelopeFromAuthoritativeRow(row));
    if (!env.ok) return fail('envelope_record_invalid', { reason: 'authoritative_row' });
    envelopeSnap = env.value;
    aadGen = Number(row.grant_generation);
    aadOp = String(row.last_operation_id).trim().toLowerCase();
    return ok();
  });
  if (!txResult.ok) return txResult;

  // Outside TX — provider open only after successful lease re-read + COMMIT.
  let aad;
  try {
    aad = buildGrantEnvelopeAadV1({
      clientId: clientId.value,
      endpointId: endpointId.value,
      grantGeneration: aadGen,
      operationId: aadOp,
    });
  } catch (_) {
    return fail('aad_invalid');
  }
  try {
    const material = await prov.value.openGrantPayload({ envelope: envelopeSnap, aad });
    let matSnap;
    try {
      matSnap = snapshotOwnDataProps(material == null ? {} : material);
    } catch {
      return fail('envelope_open_failed');
    }
    if (!matSnap.ok || typeof matSnap.value.refresh_token !== 'string'
      || !matSnap.value.refresh_token) {
      return fail('envelope_open_failed');
    }
    return ok(Object.freeze({ refresh_token: matSnap.value.refresh_token }));
  } catch (_) {
    return fail('envelope_open_failed');
  }
}

async function commitDelegatedGrantRotation(input, deps) {
  const cas = requireLeaseCasInput(input, deps);
  if (!cas.ok) return cas;
  const envOp = requireEnvelopeOp(cas.snap, 'commit_input_invalid');
  if (!envOp.ok) return envOp;
  return withTxn(cas.client, async () => {
    const upd = await cas.client.query(
      SQL_COMMIT_ENVELOPE,
      envelopeCommitParams(
        cas.ids.clientId.value, cas.ids.endpointId.value, cas.expected.value,
        envOp.opId.value, envOp.env, cas.leaseToken.value,
      ),
    );
    if (!upd.rows || upd.rows.length !== 1) return fail('generation_conflict');
    return ok(toPublicGrantStatusDto(upd.rows[0]));
  });
}

/** Terminal reauth under exact held unexpired lease + generation CAS. */
async function markDelegatedGrantReauthorizationRequired(input, deps) {
  const cas = requireLeaseCasInput(input, deps);
  if (!cas.ok) return cas;
  const reason = typeof cas.snap.reason === 'string' ? cas.snap.reason : '';
  if (!TERMINAL_REAUTH_REASONS.includes(reason)) return fail('reauth_reason_invalid');
  return withTxn(cas.client, async () => {
    const locked = await cas.client.query(SQL_LOCK_GRANT, [cas.ids.clientId.value, cas.ids.endpointId.value]);
    if (!locked.rows || locked.rows.length !== 1) return fail('grant_not_found');
    const g = locked.rows[0];
    const upd = await cas.client.query(
      `UPDATE tenant_email_delegated_grants
          SET grant_status='reauthorization_required',
              grant_lease_owner=NULL, grant_lease_token=NULL, grant_lease_until=NULL,
              reconcile_state='needs_operator', reconcile_detail_code=$5, updated_at=NOW()
        WHERE client_id=$1 AND endpoint_id=$2 AND grant_generation=$3
          AND grant_lease_token=$4::uuid AND grant_status='lease_held'
          AND grant_lease_until > clock_timestamp()
        RETURNING grant_generation, grant_status`,
      [cas.ids.clientId.value, cas.ids.endpointId.value, cas.expected.value, cas.leaseToken.value, reason],
    );
    if (!upd.rows || upd.rows.length !== 1) return fail('lease_fenced');
    if (g.endpoint_binding_status === 'verified' || g.endpoint_binding_status === 'reauthorization_required') {
      await cas.client.query(
        `UPDATE tenant_channel_endpoints SET binding_status='reauthorization_required', updated_at=NOW()
          WHERE client_id=$1 AND id=$2`,
        [cas.ids.clientId.value, cas.ids.endpointId.value],
      );
    }
    return ok(Object.freeze({
      grant_present: true, grant_status: 'reauthorization_required',
      grant_generation: Number(upd.rows[0].grant_generation), reason,
    }));
  });
}

/** Abort lease: owner may clear even if expired; reassigned token → lease_fenced. */
async function abortDelegatedGrantLease(input, deps) {
  const cas = requireLeaseCasInput(input, deps);
  if (!cas.ok) return cas;
  return withTxn(cas.client, async () => {
    // No unexpired predicate — owner may clear expired own lease.
    const upd = await cas.client.query(
      `UPDATE tenant_email_delegated_grants
          SET grant_status='active', grant_lease_owner=NULL, grant_lease_token=NULL,
              grant_lease_until=NULL, updated_at=NOW()
        WHERE client_id=$1 AND endpoint_id=$2 AND grant_generation=$3
          AND grant_lease_token=$4::uuid AND grant_status='lease_held'
        RETURNING client_id, endpoint_id, grant_generation, grant_status, reconcile_state`,
      [cas.ids.clientId.value, cas.ids.endpointId.value, cas.expected.value, cas.leaseToken.value],
    );
    if (!upd.rows || upd.rows.length !== 1) return fail('lease_fenced');
    return ok(toPublicGrantStatusDto(upd.rows[0]));
  });
}

/** Reconcile under exact held unexpired lease + generation CAS. */
async function markDelegatedGrantReconciliation(input, deps) {
  const cas = requireLeaseCasInput(input, deps);
  if (!cas.ok) return cas;
  const state = cas.snap.reconcileState;
  if (!RECONCILE_STATES.includes(state)) return fail('reconcile_state_invalid');
  let detail = null;
  if (state === 'clean') {
    if (cas.snap.reconcileDetailCode != null) {
      return fail('reconcile_detail_invalid', { reason: 'clean_requires_null_detail' });
    }
  } else if (typeof cas.snap.reconcileDetailCode !== 'string'
    || !RECONCILE_DETAIL_RE.test(cas.snap.reconcileDetailCode)) {
    return fail('reconcile_detail_invalid', { reason: 'non_clean_requires_detail' });
  } else {
    detail = cas.snap.reconcileDetailCode;
  }
  return withTxn(cas.client, async () => {
    const upd = await cas.client.query(
      `UPDATE tenant_email_delegated_grants
          SET reconcile_state=$3, reconcile_detail_code=$4, updated_at=NOW()
        WHERE client_id=$1 AND endpoint_id=$2 AND grant_generation=$5
          AND grant_lease_token=$6::uuid AND grant_status='lease_held'
          AND grant_lease_until > clock_timestamp()
        RETURNING client_id, endpoint_id, grant_generation, grant_status, reconcile_state`,
      [cas.ids.clientId.value, cas.ids.endpointId.value, state, detail, cas.expected.value, cas.leaseToken.value],
    );
    if (!upd.rows || upd.rows.length !== 1) return fail('lease_fenced');
    return ok(toPublicGrantStatusDto(upd.rows[0]));
  });
}

async function listDelegatedGrantsNeedingReconciliation(input, deps) {
  const dbc = requireDb(deps);
  if (!dbc.ok) return dbc;
  const ids = idsFrom(input, ['clientId']);
  if (ids.ok === false) return ids;
  try {
    const res = await dbc.value.query(
      `SELECT client_id, endpoint_id, grant_generation, grant_status, reconcile_state
         FROM tenant_email_delegated_grants
        WHERE client_id=$1 AND reconcile_state <> 'clean' ORDER BY endpoint_id`,
      [ids.clientId.value],
    );
    return ok(Object.freeze((res.rows || []).map((r) => toPublicGrantStatusDto(r))));
  } catch (_) { return dbErr(); }
}

/** Rewrap under held unexpired lease; advances generation (stale overwrite fails). */
async function commitDelegatedGrantRewrap(input, deps) {
  const cas = requireLeaseCasInput(input, deps);
  if (!cas.ok) return cas;
  const envOp = requireEnvelopeOp(cas.snap, 'rewrap_input_invalid');
  if (!envOp.ok) return envOp;
  return withTxn(cas.client, async () => {
    const upd = await cas.client.query(
      SQL_COMMIT_ENVELOPE,
      envelopeCommitParams(
        cas.ids.clientId.value, cas.ids.endpointId.value, cas.expected.value,
        envOp.opId.value, envOp.env, cas.leaseToken.value,
      ),
    );
    if (!upd.rows || upd.rows.length !== 1) return fail('generation_conflict');
    return ok(toPublicGrantStatusDto(upd.rows[0]));
  });
}

async function getDelegatedGrantPublicStatus(input, deps) {
  const dbc = requireDb(deps);
  if (!dbc.ok) return dbc;
  const ids = idsFrom(input, ['clientId', 'endpointId']);
  if (ids.ok === false) return ids;
  try {
    const res = await dbc.value.query(
      `SELECT client_id, endpoint_id, grant_generation, grant_status, reconcile_state, grant_lease_token
         FROM tenant_email_delegated_grants WHERE client_id=$1 AND endpoint_id=$2`,
      [ids.clientId.value, ids.endpointId.value],
    );
    if (!res.rows || res.rows.length === 0) return ok(toPublicGrantStatusDto(null));
    return ok(toPublicGrantStatusDto(res.rows[0]));
  } catch (_) { return dbErr(); }
}

module.exports = {
  installInitialDelegatedGrant,
  tryAcquireDelegatedGrantLease,
  renewDelegatedGrantLease,
  openDelegatedGrantUnderLease,
  commitDelegatedGrantRotation,
  markDelegatedGrantReauthorizationRequired,
  abortDelegatedGrantLease,
  markDelegatedGrantReconciliation,
  listDelegatedGrantsNeedingReconciliation,
  commitDelegatedGrantRewrap,
  getDelegatedGrantPublicStatus,
  toPublicGrantStatusDto,
  toPrivateLeaseHandle,
  withTxn,
  TERMINAL_REAUTH_REASONS,
  RECONCILE_STATES,
};
