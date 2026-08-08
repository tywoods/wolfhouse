'use strict';
/** Phase B replacer+custody (Gate 3 PR B1). Sealed envelope CAS N→N+1; seal outside TX. */
const { timingSafeEqual } = require('crypto');
const util = require('util');
const {
  buildGrantEnvelopeAadV1, validateGrantEnvelopeRecordV1, validateEmailGrantEnvelopeProvider,
} = require('./email-grant-envelope-provider-contract');
const { resolveOptionalStageTelemetry, safeEmitStage } = require('./email-microsoft-oauth-stage-telemetry');
const {
  validateAndNormalizePhaseBTokenResponseScope, PHASE_B_REQUIRED_RESOURCE_SCOPES,
} = require('./email-microsoft-phase-b-token-response-scope');
const {
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION, EMAIL_MS_DELEGATED_SCOPE_VERSION,
} = require('./email-microsoft-delegated-oauth-contract');

// Module-init pin: ambient util.types.isProxy monkeypatches after load must not weaken.
const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy : null;
const REPLACER_ERR = 'MICROSOFT_PHASE_B_VERIFIED_GRANT_REPLACER_INVALID';
const CUSTODY_ERR = 'MICROSOFT_PHASE_B_VERIFIED_GRANT_CUSTODY_INVALID';
const REPLACER_MSG = 'Microsoft Phase B verified grant replace failed.';
const CUSTODY_MSG = 'Microsoft Phase B verified grant custody failed.';
const REPLACER_METHOD = 'replaceVerifiedGrant';
const RECONCILE_METHOD = 'reconcileReplacement';
const REPLACED_STATUS = 'replaced';
const OUTCOME_UNKNOWN = 'outcome_unknown';
const SCOPE_A = EMAIL_MS_DELEGATED_SCOPE_VERSION;
const SCOPE_B = EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION;
const TOKEN_LIMIT = 8192;
const ID_TOKEN_LIMIT = 32768;
const MAX_EXPIRES = 86_400;
const GEN_RE = /^[1-9][0-9]*$/;
const GEN_MAX = 9223372036854775807n;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRINTABLE = /^[\x21-\x7e]+$/;
const MAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const FORBIDDEN = Object.freeze([
  'accessToken', 'refreshToken', 'idToken', 'access_token', 'refresh_token', 'id_token', 'aad',
  'authorization_code', 'code', 'token', 'client_secret', 'envelopeProvider', 'sealGrantPayload',
]);
const DEP_KEYS = Object.freeze(['client']);
const REPLACE_KEYS = Object.freeze([
  'clientId', 'endpointId', 'operationId', 'actorStaffUserId',
  'expectedPriorGrantGeneration', 'identity', 'envelope',
]);
const RECONCILE_KEYS = Object.freeze([
  'clientId', 'endpointId', 'operationId', 'expectedPriorGrantGeneration',
]);
const ACK_KEYS = Object.freeze(['status', 'grantGeneration', 'operationId', 'scopeVersion']);
const OUTCOME_KEYS = Object.freeze(['status']);
const CONFIG_KEYS = Object.freeze([
  'clientId', 'endpointId', 'operationId', 'actorStaffUserId',
  'expectedNonce', 'expectedClientId', 'expectedPriorGrantGeneration',
]);
const CUSTODY_DEPS = Object.freeze(['verifiedIdentity', 'envelopeProvider', 'clock', 'replacer']);
const SELECTED_KEYS = Object.freeze([
  'accessToken', 'refreshToken', 'tokenType', 'expiresIn', 'scope', 'idToken',
]);
const IDENTITY_KEYS = Object.freeze([
  'providerTenantId', 'providerPrincipalId', 'mailboxAddress', 'displayName',
]);
const SEAL_KEYS = Object.freeze(['refresh_token', 'aad', 'operation_id']);
const LOCK_KEYS = Object.freeze([
  'id', 'client_id', 'provider', 'auth_mode', 'connector_mode', 'binding_status',
  'provider_tenant_id', 'provider_principal_oid', 'provider_resource_id', 'public_address',
  'mailbox_kind', 'mailbox_access_kind', 'grant_generation', 'grant_status', 'reconcile_state',
  'scope_version', 'grant_lease_token', 'last_operation_id', 'envelope_version', 'aead_alg',
  'kek_wrap_alg', 'kek_key_name', 'kek_key_version', 'nonce', 'ciphertext', 'auth_tag', 'wrapped_dek',
]);
const LOCK_SET = new Set(LOCK_KEYS);
const RET_KEYS = Object.freeze([
  'client_id', 'endpoint_id', 'grant_generation', 'grant_status', 'reconcile_state',
  'scope_version', 'last_operation_id',
]);
const RET_SET = new Set(RET_KEYS);
const SNAP_KEYS = Object.freeze([
  'grant_generation', 'grant_status', 'reconcile_state', 'scope_version', 'last_operation_id',
  'grant_lease_token', 'grant_lease_owner', 'grant_lease_until', 'binding_status',
  'provider_tenant_id', 'provider_principal_oid', 'provider_resource_id', 'public_address',
  'envelope_version', 'aead_alg', 'kek_wrap_alg', 'kek_key_name', 'kek_key_version',
  'nonce', 'ciphertext', 'auth_tag', 'wrapped_dek',
]);
const SNAP_SET = new Set(SNAP_KEYS);
const SEALED_ACK = Object.freeze({ status: 'accepted' });
const SQL_BEGIN = 'BEGIN';
const SQL_COMMIT = 'COMMIT';
const SQL_ROLLBACK = 'ROLLBACK';
const SQL_LOCK = `SELECT e.id, e.client_id, e.provider, e.auth_mode, e.connector_mode, e.binding_status, e.provider_tenant_id, e.provider_principal_oid, e.provider_resource_id, e.public_address, e.mailbox_kind, e.mailbox_access_kind, g.grant_generation, g.grant_status, g.reconcile_state, g.scope_version, g.grant_lease_token, g.last_operation_id, g.envelope_version, g.aead_alg, g.kek_wrap_alg, g.kek_key_name, g.kek_key_version, g.nonce, g.ciphertext, g.auth_tag, g.wrapped_dek FROM tenant_channel_endpoints e INNER JOIN tenant_email_delegated_grants g ON g.client_id = e.client_id AND g.endpoint_id = e.id WHERE e.client_id = $1 AND e.id = $2 FOR UPDATE OF e, g`;
const SQL_CAS = `UPDATE tenant_email_delegated_grants SET grant_generation=$3::bigint, last_operation_id=$4, scope_version='phase_b_v1', grant_status='active', grant_lease_owner=NULL, grant_lease_token=NULL, grant_lease_until=NULL, reconcile_state='clean', reconcile_detail_code=NULL, envelope_version=$5, aead_alg=$6, kek_wrap_alg=$7, kek_key_name=$8, kek_key_version=$9, nonce=$10, ciphertext=$11, auth_tag=$12, wrapped_dek=$13, updated_by=$14, updated_at=NOW() WHERE client_id=$1 AND endpoint_id=$2 AND grant_generation=$15::bigint AND scope_version='phase_a_v2' AND grant_status='active' AND reconcile_state='clean' AND grant_lease_token IS NULL AND grant_lease_owner IS NULL AND grant_lease_until IS NULL RETURNING client_id, endpoint_id, grant_generation, grant_status, reconcile_state, scope_version, last_operation_id`;
const SQL_SNAP = `SELECT g.grant_generation, g.grant_status, g.reconcile_state, g.scope_version, g.last_operation_id, g.grant_lease_token, g.grant_lease_owner, g.grant_lease_until, e.binding_status, e.provider_tenant_id, e.provider_principal_oid, e.provider_resource_id, e.public_address, g.envelope_version, g.aead_alg, g.kek_wrap_alg, g.kek_key_name, g.kek_key_version, g.nonce, g.ciphertext, g.auth_tag, g.wrapped_dek FROM tenant_email_delegated_grants g INNER JOIN tenant_channel_endpoints e ON e.client_id=g.client_id AND e.id=g.endpoint_id WHERE g.client_id=$1 AND g.endpoint_id=$2`;
function fail(code, msg) {
  const e = new Error(msg);
  Object.defineProperty(e, 'name', {
    value: code === REPLACER_ERR ? 'MicrosoftPhaseBVerifiedGrantReplacerError'
      : 'MicrosoftPhaseBVerifiedGrantCustodyError',
  });
  Object.defineProperty(e, 'code', { value: code, enumerable: true });
  return Object.freeze(e);
}
const rFail = () => fail(REPLACER_ERR, REPLACER_MSG);
const cFail = () => fail(CUSTODY_ERR, CUSTODY_MSG);
function asCanonGen(v) {
  try {
    if (typeof v === 'bigint') { if (v < 1n || v > GEN_MAX) return null; return v.toString(10); }
    if (typeof v === 'number') { if (!Number.isSafeInteger(v) || v < 1) return null; return String(v); }
    if (typeof v === 'string' && GEN_RE.test(v)) {
      const b = BigInt(v); if (b < 1n || b > GEN_MAX) return null; return v;
    }
    return null;
  } catch { return null; }
}
function genPlus1(g) {
  try {
    const n = BigInt(g) + 1n; if (n < 1n || n > GEN_MAX) return null;
    const s = n.toString(10); return GEN_RE.test(s) && s !== g ? s : null;
  } catch { return null; }
}
/** Pinned native isProxy; missing pin / throw → treat as proxy (fail closed). */
function isProxy(v) {
  try {
    if (typeof PINNED_IS_PROXY !== 'function' || !PINNED_UTIL_TYPES) return true;
    return Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [v]) === true;
  } catch { return true; }
}
function own(o, k) {
  try {
    if (o == null || isProxy(o)) return undefined;
    const d = Object.getOwnPropertyDescriptor(o, k);
    return d && Object.prototype.hasOwnProperty.call(d, 'value') && !d.get && !d.set ? d.value : undefined;
  } catch { return undefined; }
}
function exactPlain(o, keys) {
  try {
    if (!o || isProxy(o) || Object.getPrototypeOf(o) !== Object.prototype) return false;
    const a = Reflect.ownKeys(o);
    if (a.length !== keys.length || a.some((k) => typeof k !== 'string' || !keys.includes(k))) return false;
    return keys.every((k) => {
      const d = Object.getOwnPropertyDescriptor(o, k);
      return d && Object.prototype.hasOwnProperty.call(d, 'value') && d.enumerable && !d.get && !d.set;
    });
  } catch { return false; }
}
function exactFrozen(o, keys) { return Boolean(o && Object.isFrozen(o) && exactPlain(o, keys)); }
function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }
function copyBuf(s) { const c = Buffer.alloc(s.length); s.copy(c); return c; }
function hasForbidden(o) {
  if (!o || typeof o !== 'object' || isProxy(o)) return false;
  try { for (const k of Reflect.ownKeys(o)) { if (typeof k === 'symbol' || FORBIDDEN.includes(k)) return true; } }
  catch { return true; }
  return false;
}
function looksPool(o) {
  return Boolean(o && typeof o === 'object' && typeof o.connect === 'function'
    && (typeof o.totalCount === 'number' || typeof o.idleCount === 'number' || typeof o.waitingCount === 'number'));
}
function snapRow(row, keys, set) {
  try {
    if (!row || typeof row !== 'object' || isProxy(row)) return null;
    const p = Object.getPrototypeOf(row);
    if (p !== Object.prototype && p !== null) return null;
    const a = Reflect.ownKeys(row);
    if (a.length !== keys.length) return null;
    for (const k of a) if (typeof k !== 'string' || !set.has(k)) return null;
    const out = Object.create(null);
    for (const k of keys) {
      const d = Object.getOwnPropertyDescriptor(row, k);
      if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set || !d.enumerable) return null;
      out[k] = d.value;
    }
    return out;
  } catch { return null; }
}
/**
 * Exact usable stored row for reconcile advanced/stillPrior: canonical identity
 * formats + sealed envelope metadata/buffers via grant contract (no decrypt).
 */
function isUsableReconcileRow(o) {
  try {
    if (!o || o.grant_status !== 'active' || o.reconcile_state !== 'clean') return false;
    if (o.grant_lease_token != null || o.grant_lease_owner != null || o.grant_lease_until != null) {
      return false;
    }
    if (o.binding_status !== 'verified') return false;
    if (!isUuid(o.provider_tenant_id) || !isUuid(o.provider_principal_oid)
        || !isUuid(o.provider_resource_id) || !mailbox(o.public_address)) {
      return false;
    }
    if (!isUuid(o.last_operation_id)) return false;
    // Canonical stored envelope fields only (059 CHECK + contract); never open/decrypt.
    const env = validateGrantEnvelopeRecordV1(Object.freeze({
      envelope_version: o.envelope_version,
      aead_alg: o.aead_alg,
      kek_wrap_alg: o.kek_wrap_alg,
      kek_key_name: o.kek_key_name,
      kek_key_version: o.kek_key_version,
      nonce: o.nonce,
      ciphertext: o.ciphertext,
      auth_tag: o.auth_tag,
      wrapped_dek: o.wrapped_dek,
      operation_id: o.last_operation_id,
    }));
    return !!(env && env.ok);
  } catch { return false; }
}
function printable(v, lim) {
  return typeof v === 'string' && v.length > 0 && v.length <= lim && PRINTABLE.test(v);
}
function bounded(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
}
function mailbox(v) {
  return typeof v === 'string' && v.length >= 3 && v.length <= 254
    && v === v.trim() && v === v.toLowerCase() && MAIL_RE.test(v) && !v.includes('..')
    && !/[\u0000-\u001f\u007f]/.test(v);
}
function bufEq(a, b) {
  return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && a.equals(b);
}
function envFpEqual(l, r) {
  return l && r && l.envelope_version === r.envelope_version && l.aead_alg === r.aead_alg
    && l.kek_wrap_alg === r.kek_wrap_alg && l.kek_key_name === r.kek_key_name
    && l.kek_key_version === r.kek_key_version && bufEq(l.nonce, r.nonce)
    && bufEq(l.ciphertext, r.ciphertext) && bufEq(l.auth_tag, r.auth_tag)
    && bufEq(l.wrapped_dek, r.wrapped_dek);
}
function fingerprintEnvelopeFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  return Object.freeze({
    envelope_version: row.envelope_version, aead_alg: row.aead_alg, kek_wrap_alg: row.kek_wrap_alg,
    kek_key_name: row.kek_key_name, kek_key_version: row.kek_key_version,
    nonce: Buffer.isBuffer(row.nonce) ? copyBuf(row.nonce) : row.nonce,
    ciphertext: Buffer.isBuffer(row.ciphertext) ? copyBuf(row.ciphertext) : row.ciphertext,
    auth_tag: Buffer.isBuffer(row.auth_tag) ? copyBuf(row.auth_tag) : row.auth_tag,
    wrapped_dek: Buffer.isBuffer(row.wrapped_dek) ? copyBuf(row.wrapped_dek) : row.wrapped_dek,
  });
}
function pinClient(deps) {
  if (!exactFrozen(deps, DEP_KEYS)) return null;
  const c = own(deps, 'client');
  if (!c || typeof c !== 'object' || typeof c.query !== 'function' || looksPool(c)) return null;
  if (typeof c.connect === 'function' && (Object.prototype.hasOwnProperty.call(c, 'totalCount')
      || Object.prototype.hasOwnProperty.call(c, 'idleCount')
      || Object.prototype.hasOwnProperty.call(c, 'waitingCount'))) return null;
  return c;
}
async function rollbackQuiet(c) { try { await c.query(SQL_ROLLBACK); } catch { /* sanitized */ } }
function readIdentity(v) {
  if (!exactFrozen(v, IDENTITY_KEYS)) return null;
  const tid = own(v, 'providerTenantId'); const oid = own(v, 'providerPrincipalId');
  const mb = own(v, 'mailboxAddress'); const dn = own(v, 'displayName');
  if (!bounded(tid, 256) || !UUID_RE.test(tid) || !bounded(oid, 256) || !UUID_RE.test(oid)) return null;
  if (!mailbox(mb)) return null;
  if (dn !== null && (!bounded(dn, 256) || typeof dn !== 'string')) return null;
  return Object.freeze({ providerTenantId: tid, providerPrincipalId: oid, mailboxAddress: mb, displayName: dn });
}
function snapReplace(input) {
  if (!exactFrozen(input, REPLACE_KEYS) || hasForbidden(input)) return null;
  const clientId = own(input, 'clientId');
  const endpointId = own(input, 'endpointId');
  const operationId = own(input, 'operationId');
  const actor = own(input, 'actorStaffUserId');
  const prior = asCanonGen(own(input, 'expectedPriorGrantGeneration'));
  const next = prior == null ? null : genPlus1(prior);
  const identity = readIdentity(own(input, 'identity'));
  if (!isUuid(clientId) || !isUuid(endpointId) || !isUuid(operationId)) return null;
  if (actor !== null && !isUuid(actor)) return null;
  if (prior == null || next == null || !identity) return null;
  let env;
  try { env = validateGrantEnvelopeRecordV1(own(input, 'envelope')); } catch { return null; }
  if (!env || !env.ok || env.value.operation_id !== operationId) return null;
  try {
    const aad = buildGrantEnvelopeAadV1({ clientId, endpointId, grantGeneration: next, operationId });
    if (!Buffer.isBuffer(aad) || aad.length < 1) return null;
  } catch { return null; }
  const e = env.value;
  return Object.freeze({
    clientId, endpointId, operationId, actorStaffUserId: actor,
    expectedPriorGrantGeneration: prior, nextGeneration: next, identity,
    envelope: Object.freeze({
      envelope_version: e.envelope_version, aead_alg: e.aead_alg, kek_wrap_alg: e.kek_wrap_alg,
      kek_key_name: e.kek_key_name, kek_key_version: e.kek_key_version,
      nonce: copyBuf(e.nonce), ciphertext: copyBuf(e.ciphertext),
      auth_tag: copyBuf(e.auth_tag), wrapped_dek: copyBuf(e.wrapped_dek), operation_id: e.operation_id,
    }),
  });
}
function snapLock(row, snap) {
  const o = snapRow(row, LOCK_KEYS, LOCK_SET);
  if (!o || o.id !== snap.endpointId || o.client_id !== snap.clientId) return null;
  if (o.provider !== 'microsoft_graph' || o.auth_mode !== 'delegated_authorization_code'
      || o.connector_mode !== 'microsoft_delegated_oauth' || o.binding_status !== 'verified') return null;
  const id = snap.identity;
  if (o.provider_tenant_id !== id.providerTenantId
      || o.provider_principal_oid !== id.providerPrincipalId
      || o.provider_resource_id !== id.providerPrincipalId
      || o.public_address !== id.mailboxAddress
      || o.mailbox_kind !== 'user' || o.mailbox_access_kind !== 'own_user') return null;
  const g = asCanonGen(o.grant_generation);
  if (g !== snap.expectedPriorGrantGeneration || o.grant_status !== 'active'
      || o.reconcile_state !== 'clean' || o.scope_version !== SCOPE_A || o.grant_lease_token != null) {
    return null;
  }
  return Object.freeze({ grantGeneration: g });
}
function snapRet(row, snap) {
  const o = snapRow(row, RET_KEYS, RET_SET);
  if (!o || o.client_id !== snap.clientId || o.endpoint_id !== snap.endpointId) return null;
  if (asCanonGen(o.grant_generation) !== snap.nextGeneration || o.grant_status !== 'active'
      || o.reconcile_state !== 'clean' || o.scope_version !== SCOPE_B
      || o.last_operation_id !== snap.operationId) return null;
  return Object.freeze({
    grantGeneration: snap.nextGeneration, operationId: snap.operationId, scopeVersion: SCOPE_B,
  });
}
function makeReplacedAck(snap) {
  return Object.freeze({
    status: REPLACED_STATUS, grantGeneration: snap.nextGeneration, operationId: snap.operationId, scopeVersion: SCOPE_B,
  });
}
function isExactReplacedAck(ack, expected) {
  return exactFrozen(ack, ACK_KEYS) && own(ack, 'status') === REPLACED_STATUS
    && own(ack, 'grantGeneration') === expected.nextGeneration
    && typeof own(ack, 'grantGeneration') === 'string'
    && own(ack, 'operationId') === expected.operationId && own(ack, 'scopeVersion') === SCOPE_B;
}
function isOutcomeUnknownAck(ack) {
  return exactFrozen(ack, OUTCOME_KEYS) && own(ack, 'status') === OUTCOME_UNKNOWN;
}
async function replaceInTx(client, snap) {
  let began = false; let commitSent = false;
  try {
    await client.query(SQL_BEGIN); began = true;
    const locked = await client.query(SQL_LOCK, [snap.clientId, snap.endpointId]);
    if (!locked || !Array.isArray(locked.rows) || locked.rows.length !== 1) throw rFail();
    if (!snapLock(locked.rows[0], snap)) throw rFail();
    const e = snap.envelope;
    const upd = await client.query(SQL_CAS, [
      snap.clientId, snap.endpointId, snap.nextGeneration, snap.operationId,
      e.envelope_version, e.aead_alg, e.kek_wrap_alg, e.kek_key_name, e.kek_key_version,
      e.nonce, e.ciphertext, e.auth_tag, e.wrapped_dek, snap.actorStaffUserId,
      snap.expectedPriorGrantGeneration,
    ]);
    if (!upd || !Array.isArray(upd.rows) || upd.rows.length !== 1 || !snapRet(upd.rows[0], snap)) {
      throw rFail();
    }
    commitSent = true;
    await client.query(SQL_COMMIT);
    began = false; commitSent = false;
    return makeReplacedAck(snap);
  } catch (err) {
    if (commitSent) return Object.freeze({ status: OUTCOME_UNKNOWN });
    if (began) await rollbackQuiet(client);
    if (err && err.code === REPLACER_ERR) throw err;
    throw rFail();
  }
}
function createMicrosoftPhaseBVerifiedGrantReplacer(dependencies) {
  let client;
  try { client = pinClient(dependencies); if (!client) throw rFail(); } catch { throw rFail(); }
  let replaceUsed = false;
  let replaceActive = false;
  let reconcileActive = false;
  async function replaceVerifiedGrant(input) {
    if (replaceUsed || replaceActive || reconcileActive) throw rFail();
    replaceUsed = true;
    replaceActive = true;
    try {
      let snap;
      try { snap = snapReplace(input); if (!snap) throw rFail(); } catch { throw rFail(); }
      try { return await replaceInTx(client, snap); } catch (e) {
        if (e && e.code === REPLACER_ERR) throw e; throw rFail();
      }
    } finally { replaceActive = false; }
  }
  async function reconcileReplacement(input) {
    if (replaceActive || reconcileActive) throw rFail();
    if (!exactFrozen(input, RECONCILE_KEYS) || hasForbidden(input)) throw rFail();
    const clientId = own(input, 'clientId');
    const endpointId = own(input, 'endpointId');
    const operationId = own(input, 'operationId');
    const prior = asCanonGen(own(input, 'expectedPriorGrantGeneration'));
    const next = prior == null ? null : genPlus1(prior);
    if (!isUuid(clientId) || !isUuid(endpointId) || !isUuid(operationId) || prior == null || next == null) {
      throw rFail();
    }
    reconcileActive = true;
    try {
      const res = await client.query(SQL_SNAP, [clientId, endpointId]);
      if (!res || !Array.isArray(res.rows) || res.rows.length !== 1) throw rFail();
      const o = snapRow(res.rows[0], SNAP_KEYS, SNAP_SET);
      if (!o) throw rFail();
      const gen = asCanonGen(o.grant_generation);
      if (gen == null) throw rFail();
      const usable = isUsableReconcileRow(o);
      return Object.freeze({
        grantGeneration: gen, lastOperationId: o.last_operation_id,
        scopeVersion: o.scope_version, grantStatus: o.grant_status,
        reconcileState: o.reconcile_state,
        advanced: !!(usable && gen === next && o.last_operation_id === operationId
          && o.scope_version === SCOPE_B),
        stillPrior: !!(usable && gen === prior && o.scope_version === SCOPE_A),
      });
    } catch (e) {
      if (e && e.code === REPLACER_ERR) throw e; throw rFail();
    } finally { reconcileActive = false; }
  }
  return Object.freeze({ replaceVerifiedGrant, reconcileReplacement });
}
function snapSelected(input) {
  if (!exactFrozen(input, SELECTED_KEYS)) return null;
  const accessToken = own(input, 'accessToken'); const refreshToken = own(input, 'refreshToken');
  const tokenType = own(input, 'tokenType'); const expiresIn = own(input, 'expiresIn');
  const scope = own(input, 'scope'); const idToken = own(input, 'idToken');
  if (!printable(accessToken, TOKEN_LIMIT) || !printable(refreshToken, TOKEN_LIMIT)) return null;
  if (tokenType !== 'Bearer' || !Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_EXPIRES) return null;
  const ns = validateAndNormalizePhaseBTokenResponseScope(scope);
  if (ns == null || !printable(idToken, ID_TOKEN_LIMIT)) return null;
  return Object.freeze({ accessToken, refreshToken, tokenType, expiresIn, scope: ns, idToken });
}
function snapConfig(config) {
  if (!exactFrozen(config, CONFIG_KEYS)) return null;
  const clientId = own(config, 'clientId'); const endpointId = own(config, 'endpointId');
  const operationId = own(config, 'operationId'); const actor = own(config, 'actorStaffUserId');
  const expectedNonce = own(config, 'expectedNonce'); const expectedClientId = own(config, 'expectedClientId');
  const prior = asCanonGen(own(config, 'expectedPriorGrantGeneration'));
  const next = prior == null ? null : genPlus1(prior);
  if (!isUuid(clientId) || !isUuid(endpointId) || !isUuid(operationId)) return null;
  if (actor !== null && !isUuid(actor)) return null;
  if (!bounded(expectedNonce, 512) || !bounded(expectedClientId, 256) || prior == null || next == null) return null;
  return Object.freeze({
    clientId, endpointId, operationId, actorStaffUserId: actor,
    expectedNonce, expectedClientId, expectedPriorGrantGeneration: prior, nextGeneration: next,
  });
}
function aadOk(l, r) {
  return Buffer.isBuffer(l) && Buffer.isBuffer(r) && l.length === r.length && l.length > 0 && timingSafeEqual(l, r);
}
function createMicrosoftPhaseBVerifiedGrantCustodyAdapter(config, dependencies) {
  let cfg; let verifiedIdentity; let envelopeProvider; let clock; let replacer; let stageTelemetry;
  try {
    cfg = snapConfig(config); if (!cfg) throw cFail();
    const resolved = resolveOptionalStageTelemetry(dependencies, CUSTODY_DEPS);
    if (!resolved.ok || !resolved.stageTelemetry) throw cFail();
    stageTelemetry = resolved.stageTelemetry;
    verifiedIdentity = own(dependencies, 'verifiedIdentity');
    clock = own(dependencies, 'clock');
    replacer = own(dependencies, 'replacer');
    if (!exactFrozen(verifiedIdentity, ['verifyIdentity'])
        || typeof own(verifiedIdentity, 'verifyIdentity') !== 'function') throw cFail();
    if (!exactFrozen(clock, ['nowEpochSeconds'])
        || typeof own(clock, 'nowEpochSeconds') !== 'function') throw cFail();
    if (!replacer || typeof replacer !== 'object' || !Object.isFrozen(replacer)) throw cFail();
    if (typeof own(replacer, REPLACER_METHOD) !== 'function'
        || own(replacer, 'installVerifiedGrant') !== undefined) throw cFail();
    const prov = validateEmailGrantEnvelopeProvider(own(dependencies, 'envelopeProvider'));
    if (!prov.ok) throw cFail();
    envelopeProvider = prov.value;
  } catch { throw cFail(); }
  let used = false;
  async function acceptValidatedTokens(input) {
    if (used) throw cFail();
    used = true;
    try {
      const selected = snapSelected(input); if (!selected) throw cFail();
      let now;
      try { now = Reflect.apply(own(clock, 'nowEpochSeconds'), clock, []); } catch { throw cFail(); }
      if (!Number.isSafeInteger(now) || now < 0) throw cFail();
      let idRaw;
      try {
        idRaw = await Reflect.apply(own(verifiedIdentity, 'verifyIdentity'), verifiedIdentity, [
          Object.freeze({
            idToken: selected.idToken, accessToken: selected.accessToken,
            expectedNonce: cfg.expectedNonce, expectedClientId: cfg.expectedClientId,
            nowEpochSeconds: now,
          }),
        ]);
      } catch { throw cFail(); }
      const identity = readIdentity(idRaw);
      if (!identity) throw cFail();
      let aadCanon;
      try {
        aadCanon = buildGrantEnvelopeAadV1({
          clientId: cfg.clientId, endpointId: cfg.endpointId,
          grantGeneration: cfg.nextGeneration, operationId: cfg.operationId,
        });
      } catch { throw cFail(); }
      if (!Buffer.isBuffer(aadCanon) || aadCanon.length < 1) throw cFail();
      const aadAuth = copyBuf(aadCanon); const aadProv = copyBuf(aadCanon);
      const sealInput = Object.freeze({
        refresh_token: selected.refreshToken, aad: aadProv, operation_id: cfg.operationId,
      });
      if (!exactPlain(sealInput, SEAL_KEYS)) throw cFail();
      let envRaw;
      try {
        envRaw = await Reflect.apply(own(envelopeProvider, 'sealGrantPayload'), envelopeProvider, [sealInput]);
      } catch { throw cFail(); }
      if (!aadOk(aadProv, aadAuth)) throw cFail();
      let envVal;
      try {
        const env = validateGrantEnvelopeRecordV1(envRaw);
        if (!env.ok || env.value.operation_id !== cfg.operationId) throw cFail();
        envVal = env.value;
      } catch { throw cFail(); }
      safeEmitStage(stageTelemetry, 'envelope_sealed');
      const handoff = Object.freeze({
        clientId: cfg.clientId, endpointId: cfg.endpointId, operationId: cfg.operationId,
        actorStaffUserId: cfg.actorStaffUserId,
        expectedPriorGrantGeneration: cfg.expectedPriorGrantGeneration, identity, envelope: envVal,
      });
      if (!exactPlain(handoff, REPLACE_KEYS) || hasForbidden(handoff)) throw cFail();
      safeEmitStage(stageTelemetry, 'installer_started');
      let ack;
      try {
        ack = await Reflect.apply(own(replacer, REPLACER_METHOD), replacer, [handoff]);
      } catch { throw cFail(); }
      if (isOutcomeUnknownAck(ack)) return Object.freeze({ status: OUTCOME_UNKNOWN });
      if (!isExactReplacedAck(ack, cfg)) throw cFail();
      safeEmitStage(stageTelemetry, 'installer_committed');
      return SEALED_ACK;
    } catch { throw cFail(); }
  }
  return Object.freeze({ acceptValidatedTokens });
}
module.exports = Object.freeze({
  ERROR_CODE: REPLACER_ERR, ERROR_MESSAGE: REPLACER_MSG, CUSTODY_ERROR_CODE: CUSTODY_ERR,
  CUSTODY_ERROR_MESSAGE: CUSTODY_MSG, REPLACER_METHOD, RECONCILE_METHOD, REPLACED_STATUS,
  OUTCOME_UNKNOWN, REPLACE_KEYS, RECONCILE_KEYS, ACK_KEYS, DEPENDENCY_KEYS: DEP_KEYS, CONFIG_KEYS,
  LOCK_ROW_KEYS: LOCK_KEYS, RETURNING_KEYS: RET_KEYS, SQL_LOCK, SQL_CAS_UPDATE: SQL_CAS,
  SQL_SNAPSHOT: SQL_SNAP, SCOPE_PHASE_A: SCOPE_A, SCOPE_PHASE_B: SCOPE_B, SEALED_ACK,
  PHASE_B_REQUIRED_RESOURCE_SCOPES, GEN_MAX, asCanonGen, genPlus1,
  envelopeFingerprintEqual: envFpEqual, fingerprintEnvelopeFromRow,
  createMicrosoftPhaseBVerifiedGrantReplacer, createMicrosoftPhaseBVerifiedGrantCustodyAdapter,
});
