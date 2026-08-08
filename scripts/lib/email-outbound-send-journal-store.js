'use strict'; /** Offline outbound send-journal store (068+069). Exclusive TX claim/replay + CAS. Unwired. */
const util = require('util');
const FAILURE_CODE = 'email_outbound_send_journal_failed';
const FAILURE_MESSAGE = 'Email outbound send journal operation failed.';
const EMAIL_OUTBOUND_SEND_JOURNAL_RUNTIME_WIRED = false;
const EMAIL_OUTBOUND_SEND_JOURNAL_LOGGING_FORBIDDEN = true;
const EMAIL_OUTBOUND_SEND_JOURNAL_PROVIDER = 'microsoft_graph';
const STORE_DEPENDENCY_KEYS = Object.freeze(['withTransactionClient', 'authority']);
const AUTHORITY_KEYS = Object.freeze(['clientId','locationId','locationKey','endpointId','conversationId','actorStaffUserId']);
const CLAIM_INPUT_KEYS = Object.freeze(['operationId','approvalId','bodyDigest']);
const OP_ID_KEYS = Object.freeze(['operationId']);
const DRAFT_INPUT_KEYS = Object.freeze(['operationId','immutableDraftId']);
const TERMINAL_INPUT_KEYS = Object.freeze(['operationId','outcome']);
const OPERATION_RESULT_KEYS = Object.freeze([
  'operation_id','approval_id','phase','outcome','immutable_draft_id','body_digest',
  'create_invocation_count','update_invocation_count','send_invocation_count','provider',
  'replayed','authorize_create','authorize_update','authorize_dispatch',
]);
const OUTCOMES = Object.freeze(['claimed','committed','not_committed','outcome_unknown','conflict','rejected']);
const PHASES = Object.freeze([
  'claimed','create_dispatched','draft_created','update_dispatched','draft_updated','send_dispatched','reconciled_sent','terminal',
]);
const PRE_INTENT_TERMINAL = Object.freeze(['not_committed','conflict','rejected']);
const INTENT_TERMINAL = Object.freeze(['outcome_unknown','conflict','rejected','not_committed']);
const POST_SEND_TERMINAL = Object.freeze(['outcome_unknown','conflict','rejected']);
const LOCK_FIELDS = Object.freeze([
  'operation_id','client_id','location_id','location_key','endpoint_id','conversation_id','approval_id','actor_staff_user_id',
  'provider','immutable_draft_id','body_digest','phase','outcome',
  'create_invocation_count','update_invocation_count','send_invocation_count',
]);
const PUBLIC_FIELDS = Object.freeze([
  'operation_id','approval_id','phase','outcome','immutable_draft_id','body_digest',
  'create_invocation_count','update_invocation_count','send_invocation_count','provider',
]);
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BODY_DIGEST_RE = /^[0-9a-f]{64}$/;
const LOCATION_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DRAFT_SECRET_RE = new RegExp(`${'access'}_${'token'}|${'refresh'}_${'token'}|bearer\\s`, 'i');
const DANGEROUS = new Set(['__proto__','prototype','constructor']);
const RET = 'operation_id, approval_id, phase, outcome, immutable_draft_id, body_digest, create_invocation_count, update_invocation_count, send_invocation_count, provider';
const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function' ? PINNED_UTIL_TYPES.isProxy : null;
const PINNED_OBJECT_PROTOTYPE = Object.prototype;
const PINNED_REFLECT_APPLY = typeof Reflect.apply === 'function' ? Reflect.apply : null;
const PINNED_REFLECT_OWN_KEYS = typeof Reflect.ownKeys === 'function' ? Reflect.ownKeys : null;
const PINNED_GOPD = typeof Object.getOwnPropertyDescriptor === 'function' ? Object.getOwnPropertyDescriptor : null;
const PINNED_GPO = typeof Object.getPrototypeOf === 'function' ? Object.getPrototypeOf : null;
const PINNED_OBJECT_FREEZE = typeof Object.freeze === 'function' ? Object.freeze : null;
const PINNED_IS_FROZEN = typeof Object.isFrozen === 'function' ? Object.isFrozen : null;
const PINNED_HAS_OWN = typeof Object.prototype.hasOwnProperty === 'function' ? Object.prototype.hasOwnProperty : null;
const PINNED_OBJECT_CREATE = typeof Object.create === 'function' ? Object.create : null;
const PINNED_DEFINE_PROPERTY = typeof Object.defineProperty === 'function' ? Object.defineProperty : null;
const PINNED_READY = Boolean(PINNED_IS_PROXY && PINNED_UTIL_TYPES && PINNED_REFLECT_APPLY && PINNED_REFLECT_OWN_KEYS && PINNED_GOPD && PINNED_GPO && PINNED_OBJECT_FREEZE && PINNED_IS_FROZEN && PINNED_HAS_OWN && PINNED_OBJECT_PROTOTYPE && PINNED_OBJECT_CREATE && PINNED_DEFINE_PROPERTY);
function freeze(v) { return PINNED_OBJECT_FREEZE.call(Object, v); }
function isFrozen(v) { try { return PINNED_IS_FROZEN.call(Object, v) === true; } catch { return false; } }
function failure(code) {
  const e = new Error(FAILURE_MESSAGE); PINNED_DEFINE_PROPERTY.call(Object, e, 'name', { value: 'EmailOutboundSendJournalError' });
  PINNED_DEFINE_PROPERTY.call(Object, e, 'code', { value: (typeof code === 'string' && code) || FAILURE_CODE, enumerable: true }); return freeze(e);
}
function fail(error) { return freeze({ ok: false, error: typeof error === 'string' && error ? error : FAILURE_CODE }); }
function ok(value) { return value === undefined ? freeze({ ok: true }) : freeze({ ok: true, value }); }
function isProxy(v) {
  try { if (!PINNED_READY) return true; return PINNED_REFLECT_APPLY.call(Reflect, PINNED_IS_PROXY, PINNED_UTIL_TYPES, [v]) === true; }
  catch { return true; }
}
function ownData(o, k) {
  try {
    if (!PINNED_GOPD || !PINNED_HAS_OWN) return undefined;
    const d = PINNED_GOPD.call(Object, o, k); return d && PINNED_HAS_OWN.call(d, 'value') && !d.get && !d.set ? d.value : undefined;
  } catch { return undefined; }
}
function ownErrorCode(err) {
  try {
    if (err == null || (typeof err !== 'object' && typeof err !== 'function') || isProxy(err)) return undefined;
    const c = ownData(err, 'code'); return typeof c === 'string' ? c : undefined;
  } catch { return undefined; }
}
function isOurFailure(err) {
  try { return Boolean(err && typeof err === 'object' && !isProxy(err) && isFrozen(err) && ownErrorCode(err) === FAILURE_CODE); }
  catch { return false; }
}
function isUniqueViolation(err) { return ownErrorCode(err) === '23505'; }
function exactPlain(o, keys) {
  try {
    if (!PINNED_READY || !o || typeof o !== 'object' || Array.isArray(o) || isProxy(o)) return false; if (PINNED_GPO.call(Object, o) !== PINNED_OBJECT_PROTOTYPE) return false;
    const actual = PINNED_REFLECT_OWN_KEYS.call(Reflect, o); if (actual.length !== keys.length || actual.some((k) => typeof k !== 'string' || DANGEROUS.has(k) || !keys.includes(k))) return false;
    return keys.every((k) => { const d = PINNED_GOPD.call(Object, o, k); return Boolean(d && PINNED_HAS_OWN.call(d, 'value') && d.enumerable && !d.get && !d.set); });
  } catch { return false; }
}
function parseUuid(raw, field) {
  if (raw == null || typeof raw !== 'string') return fail(`${field}_invalid`);
  const t = raw.trim().toLowerCase();
  if (!t || !UUID_CANON.test(t) || t !== raw.trim().toLowerCase()) return fail(`${field}_invalid`);
  return ok(t);
}
function parseDigest(raw) { return raw != null && typeof raw === 'string' && BODY_DIGEST_RE.test(raw) ? ok(raw) : fail('body_digest_invalid'); }
function parseLocationKey(raw) { return raw != null && typeof raw === 'string' && LOCATION_KEY_RE.test(raw) && raw.length <= 64 ? ok(raw) : fail('location_key_invalid'); }
function draftShapeOk(raw) {
  return raw != null && typeof raw === 'string' && raw.length >= 1 && raw.length <= 2048 && raw.indexOf('@') === -1 && !DRAFT_SECRET_RE.test(raw);
}
function parseDraftId(raw) { return draftShapeOk(raw) ? ok(raw) : fail('immutable_draft_id_invalid'); }
function exactUuidField(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.toLowerCase(); return UUID_CANON.test(t) && t === raw.toLowerCase() && raw.trim() === raw ? t : null;
}
function exactCount(raw) { return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 1 ? raw : null; }
function phaseCouplingOk(phase, outcome, draft, createC, updateC, sendC) {
  if (phase === 'claimed') return draft === null && createC === 0 && updateC === 0 && sendC === 0 && outcome === 'claimed';
  if (phase === 'create_dispatched') return draft === null && createC === 1 && updateC === 0 && sendC === 0 && outcome === 'outcome_unknown';
  if (phase === 'draft_created') return draft !== null && createC === 1 && updateC === 0 && sendC === 0 && outcome === 'not_committed';
  if (phase === 'update_dispatched') return draft !== null && createC === 1 && updateC === 1 && sendC === 0 && outcome === 'outcome_unknown';
  if (phase === 'draft_updated') return draft !== null && createC === 1 && updateC === 1 && sendC === 0 && outcome === 'not_committed';
  if (phase === 'send_dispatched') return draft !== null && createC === 1 && updateC === 1 && sendC === 1 && outcome === 'outcome_unknown';
  if (phase === 'reconciled_sent') return draft !== null && createC === 1 && updateC === 1 && sendC === 1 && outcome === 'committed';
  if (phase === 'terminal') {
    if (!['not_committed','outcome_unknown','conflict','rejected'].includes(outcome)) return false;
    if (updateC === 1 && createC !== 1) return false;
    if (sendC === 1 && !(createC === 1 && updateC === 1 && draft !== null)) return false;
    if (draft !== null && createC !== 1) return false;
    if (draft === null && (updateC !== 0 || sendC !== 0)) return false;
    if (outcome === 'not_committed' && sendC !== 0) return false;
    return true;
  }
  return false;
}
function snapshotRow(row, mode) {
  try {
    if (!row || typeof row !== 'object' || Array.isArray(row) || isProxy(row)) return null;
    const out = PINNED_OBJECT_CREATE.call(Object, null); for (const k of (mode === 'lock' ? LOCK_FIELDS : PUBLIC_FIELDS)) {
      const v = ownData(row, k); if (k === 'immutable_draft_id') { if (v == null) out[k] = null; else if (!draftShapeOk(v)) return null; else out[k] = v; }
      else if (k === 'create_invocation_count' || k === 'update_invocation_count' || k === 'send_invocation_count') {
        const c = exactCount(v); if (c == null) return null; out[k] = c;
      } else if (k === 'body_digest') { if (typeof v !== 'string' || !BODY_DIGEST_RE.test(v)) return null; out[k] = v; }
      else if (k === 'location_key') { if (typeof v !== 'string' || !LOCATION_KEY_RE.test(v) || v.length > 64) return null; out[k] = v; }
      else if (k === 'provider') { if (v !== EMAIL_OUTBOUND_SEND_JOURNAL_PROVIDER) return null; out[k] = v; }
      else if (k === 'phase') { if (typeof v !== 'string' || !PHASES.includes(v)) return null; out[k] = v; }
      else if (k === 'outcome') { if (typeof v !== 'string' || !OUTCOMES.includes(v)) return null; out[k] = v; }
      else { const u = exactUuidField(v); if (!u) return null; out[k] = u; }
    }
    if (!phaseCouplingOk(out.phase, out.outcome, out.immutable_draft_id, out.create_invocation_count, out.update_invocation_count, out.send_invocation_count)) return null;
    if (!exactTsOk(ownData(row, 'created_at')) || !exactTsOk(ownData(row, 'updated_at'))) return null; return freeze(out);
  } catch { return null; }
}
function exactTsOk(raw) {
  if (raw == null) return true; if (raw instanceof Date) return Number.isFinite(raw.getTime());
  if (typeof raw === 'string') return raw.length >= 10 && raw.length <= 64 && Number.isFinite(Date.parse(raw)); return false;
}
function dbInvalid() { return fail('db_result_invalid'); }
const SQL_LOCK = `SELECT ${LOCK_FIELDS.join(', ')}, created_at, updated_at FROM tenant_email_outbound_send_journal WHERE operation_id = $1::uuid FOR UPDATE`;
const SQL_BY_APPROVAL = 'SELECT operation_id FROM tenant_email_outbound_send_journal WHERE client_id = $1::uuid AND approval_id = $2::uuid FOR UPDATE';
const SQL_INSERT = `INSERT INTO tenant_email_outbound_send_journal (operation_id, client_id, location_id, location_key, endpoint_id, conversation_id, approval_id, actor_staff_user_id, provider, immutable_draft_id, body_digest, phase, outcome, create_invocation_count, update_invocation_count, send_invocation_count) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7::uuid,$8::uuid,'microsoft_graph',NULL,$9,'claimed','claimed',0,0,0) ON CONFLICT (operation_id) DO NOTHING RETURNING ${RET}`;
const SQL_CLAIM_CREATE = `UPDATE tenant_email_outbound_send_journal SET phase='create_dispatched', outcome='outcome_unknown', create_invocation_count=1 WHERE operation_id=$1::uuid AND phase='claimed' AND outcome='claimed' AND immutable_draft_id IS NULL AND create_invocation_count=0 AND update_invocation_count=0 AND send_invocation_count=0 RETURNING ${RET}`;
const SQL_DRAFT = `UPDATE tenant_email_outbound_send_journal SET phase='draft_created', outcome='not_committed', immutable_draft_id=$2 WHERE operation_id=$1::uuid AND phase='create_dispatched' AND outcome='outcome_unknown' AND immutable_draft_id IS NULL AND create_invocation_count=1 AND update_invocation_count=0 AND send_invocation_count=0 RETURNING ${RET}`;
const SQL_CLAIM_UPDATE = `UPDATE tenant_email_outbound_send_journal SET phase='update_dispatched', outcome='outcome_unknown', update_invocation_count=1 WHERE operation_id=$1::uuid AND phase='draft_created' AND outcome='not_committed' AND immutable_draft_id IS NOT NULL AND immutable_draft_id=$2 AND create_invocation_count=1 AND update_invocation_count=0 AND send_invocation_count=0 RETURNING ${RET}`;
const SQL_UPDATED = `UPDATE tenant_email_outbound_send_journal SET phase='draft_updated', outcome='not_committed' WHERE operation_id=$1::uuid AND phase='update_dispatched' AND outcome='outcome_unknown' AND immutable_draft_id IS NOT NULL AND create_invocation_count=1 AND update_invocation_count=1 AND send_invocation_count=0 RETURNING ${RET}`;
const SQL_DISPATCH = `UPDATE tenant_email_outbound_send_journal SET phase='send_dispatched', outcome='outcome_unknown', send_invocation_count=1 WHERE operation_id=$1::uuid AND phase='draft_updated' AND outcome='not_committed' AND immutable_draft_id IS NOT NULL AND create_invocation_count=1 AND update_invocation_count=1 AND send_invocation_count=0 RETURNING ${RET}`;
const SQL_RECONCILE = `UPDATE tenant_email_outbound_send_journal SET phase='reconciled_sent', outcome='committed' WHERE operation_id=$1::uuid AND phase='send_dispatched' AND outcome='outcome_unknown' AND immutable_draft_id IS NOT NULL AND create_invocation_count=1 AND update_invocation_count=1 AND send_invocation_count=1 AND immutable_draft_id=$2 RETURNING ${RET}`;
const SQL_TERMINAL = `UPDATE tenant_email_outbound_send_journal SET phase='terminal', outcome=$2 WHERE operation_id=$1::uuid AND phase=$3 AND create_invocation_count=$4::integer AND update_invocation_count=$5::integer AND send_invocation_count=$6::integer RETURNING ${RET}`;
function resolveQuery(surface) {
  try {
    if (!surface || (typeof surface !== 'object' && typeof surface !== 'function') || isProxy(surface)) return null;
    const own = PINNED_GOPD.call(Object, surface, 'query'); if (own) return PINNED_HAS_OWN.call(own, 'value') && typeof own.value === 'function' && !own.get && !own.set ? own.value : null;
    let proto = PINNED_GPO.call(Object, surface); let depth = 0; while (proto && proto !== PINNED_OBJECT_PROTOTYPE && depth < 8) {
      if (isProxy(proto)) return null;
      const d = PINNED_GOPD.call(Object, proto, 'query'); if (d) return PINNED_HAS_OWN.call(d, 'value') && typeof d.value === 'function' && !d.get && !d.set ? d.value : null;
      proto = PINNED_GPO.call(Object, proto); depth += 1;
    }
    return null;
  } catch { return null; }
}
function resolveExclusiveClient(client) {
  try {
    if (client == null || (typeof client !== 'object' && typeof client !== 'function') || isProxy(client)) return null;
    const q = resolveQuery(client); if (typeof q !== 'function' || isProxy(q)) return null; return freeze({ query(...args) { return PINNED_REFLECT_APPLY.call(Reflect, q, client, args); } });
  } catch { return null; }
}
function resolveWithTransactionClient(raw) {
  try {
    if (typeof raw !== 'function' || isProxy(raw)) return null;
    const captured = raw; return async function pinned(work) {
      if (typeof work !== 'function' || isProxy(work)) throw failure(); return PINNED_REFLECT_APPLY.call(Reflect, captured, undefined, [async (client) => {
        const exclusive = resolveExclusiveClient(client); if (!exclusive) throw failure(); return work(exclusive);
      }]);
    };
  } catch { return null; }
}
function snapshotAuthority(authority) {
  try {
    if (!exactPlain(authority, AUTHORITY_KEYS)) return null;
    const p = [ parseUuid(ownData(authority, 'clientId'), 'client_id'), parseUuid(ownData(authority, 'locationId'), 'location_id'),
      parseLocationKey(ownData(authority, 'locationKey')), parseUuid(ownData(authority, 'endpointId'), 'endpoint_id'),
      parseUuid(ownData(authority, 'conversationId'), 'conversation_id'), parseUuid(ownData(authority, 'actorStaffUserId'), 'actor_staff_user_id'),
    ]; if (!p.every((x) => x.ok)) return null;
    return freeze({ clientId: p[0].value, locationId: p[1].value, locationKey: p[2].value, endpointId: p[3].value, conversationId: p[4].value, actorStaffUserId: p[5].value });
  } catch { return null; }
}
function snapshotInput(input, keys) {
  if (!exactPlain(input, keys)) return fail('input_invalid');
  const out = PINNED_OBJECT_CREATE.call(Object, null); for (const k of keys) out[k] = ownData(input, k); return ok(out);
}
function toPublic(snap, replayed, auth) {
  const a = auth && typeof auth === 'object' ? auth : {};
  return freeze({
    operation_id: snap.operation_id, approval_id: snap.approval_id, phase: snap.phase, outcome: snap.outcome,
    immutable_draft_id: snap.immutable_draft_id, body_digest: snap.body_digest,
    create_invocation_count: snap.create_invocation_count, update_invocation_count: snap.update_invocation_count,
    send_invocation_count: snap.send_invocation_count, provider: snap.provider,
    replayed: replayed === true,
    authorize_create: a.create === true, authorize_update: a.update === true, authorize_dispatch: a.dispatch === true,
  });
}
function authMatch(snap, a) {
  return snap.client_id === a.clientId && snap.location_id === a.locationId && snap.location_key === a.locationKey
    && snap.endpoint_id === a.endpointId && snap.conversation_id === a.conversationId
    && snap.actor_staff_user_id === a.actorStaffUserId && snap.provider === EMAIL_OUTBOUND_SEND_JOURNAL_PROVIDER;
}
function claimMatch(snap, exp) { return authMatch(snap, exp.authority) && snap.approval_id === exp.approvalId && snap.body_digest === exp.bodyDigest; }
function publicOrInvalid(row, replayed, auth) { const snap = snapshotRow(row, 'public'); return snap ? ok(toPublic(snap, replayed, auth)) : dbInvalid(); }
async function attemptRollback(client) { try { await client.query('ROLLBACK'); } catch { /* best-effort */ } }
async function withOuterTxn(client, fn) {
  let begun = false; let commitSent = false; try {
    await client.query('BEGIN'); begun = true;
    const result = await fn(); if (result && result.ok === false) { await client.query('ROLLBACK'); begun = false; return result; }
    commitSent = true; await client.query('COMMIT'); begun = false; commitSent = false; return result;
  } catch {
    if (commitSent) { await attemptRollback(client); return fail('commit_outcome_unknown'); }
    if (begun) await attemptRollback(client); return fail('email_outbound_send_journal_write_failed');
  }
}
function createEmailOutboundSendJournalStore(deps) {
  if (!PINNED_READY) throw failure();
  let withTransactionClient; let authority; try {
    if (!exactPlain(deps, STORE_DEPENDENCY_KEYS)) throw failure(); withTransactionClient = resolveWithTransactionClient(ownData(deps, 'withTransactionClient'));
    authority = snapshotAuthority(ownData(deps, 'authority')); if (!withTransactionClient || !authority) throw failure();
  } catch (err) { if (isOurFailure(err)) throw err; throw failure(); }
  async function run(work) {
    try { return await withTransactionClient((client) => work(client)); }
    catch (err) { return isOurFailure(err) ? fail(FAILURE_CODE) : fail('email_outbound_send_journal_write_failed'); }
  }
  async function lockRowResult(client, operationId) {
    const r = await client.query(SQL_LOCK, [operationId]); if (!r || !Array.isArray(r.rows) || r.rows.length === 0) return ok(null); if (r.rows.length !== 1) return dbInvalid();
    const snap = snapshotRow(r.rows[0], 'lock'); return snap ? ok(snap) : dbInvalid();
  }
  async function requireLocked(client, operationId) {
    const row = await lockRowResult(client, operationId); if (!row.ok) return row; if (!row.value) return fail('operation_not_found');
    if (!authMatch(row.value, authority)) return fail('operation_id_conflict'); return row;
  }
  async function claim(input) {
    const snapIn = snapshotInput(input, CLAIM_INPUT_KEYS); if (!snapIn.ok) return snapIn;
    const operationId = parseUuid(snapIn.value.operationId, 'operation_id'); if (!operationId.ok) return operationId;
    const approvalId = parseUuid(snapIn.value.approvalId, 'approval_id'); if (!approvalId.ok) return approvalId;
    const bodyDigest = parseDigest(snapIn.value.bodyDigest); if (!bodyDigest.ok) return bodyDigest;
    const expected = freeze({ operationId: operationId.value, approvalId: approvalId.value, bodyDigest: bodyDigest.value, authority }); return run((client) => withOuterTxn(client, async () => {
      const existing = await lockRowResult(client, expected.operationId); if (!existing.ok) return existing;
      if (existing.value) return claimMatch(existing.value, expected) ? ok(toPublic(existing.value, true, null)) : fail('operation_id_conflict');
      const byAp = await client.query(SQL_BY_APPROVAL, [authority.clientId, expected.approvalId]); if (byAp && byAp.rows && byAp.rows.length === 1) {
        const opU = exactUuidField(ownData(byAp.rows[0], 'operation_id')); if (!opU) return dbInvalid(); if (opU !== expected.operationId) return fail('approval_id_conflict');
      } else if (byAp && byAp.rows && byAp.rows.length > 1) return dbInvalid();
      let ins; try {
        ins = await client.query(SQL_INSERT, [ expected.operationId, authority.clientId, authority.locationId, authority.locationKey,
          authority.endpointId, authority.conversationId, expected.approvalId, authority.actorStaffUserId, expected.bodyDigest,
        ]);
      } catch (err) { if (isUniqueViolation(err)) return fail('approval_id_conflict'); throw err; }
      if (ins && ins.rows && ins.rows.length === 1) return publicOrInvalid(ins.rows[0], false, null);
      const raced = await lockRowResult(client, expected.operationId); if (!raced.ok) return raced; if (!raced.value) return fail('email_outbound_send_journal_write_failed');
      return claimMatch(raced.value, expected) ? ok(toPublic(raced.value, true, null)) : fail('operation_id_conflict');
    }));
  }
  async function load(input) {
    const snapIn = snapshotInput(input, OP_ID_KEYS); if (!snapIn.ok) return snapIn;
    const operationId = parseUuid(snapIn.value.operationId, 'operation_id'); if (!operationId.ok) return operationId; return run((client) => withOuterTxn(client, async () => {
      const row = await requireLocked(client, operationId.value); if (!row.ok) return row; return ok(toPublic(row.value, true, null));
    }));
  }
  async function claimCreate(input) {
    const snapIn = snapshotInput(input, OP_ID_KEYS); if (!snapIn.ok) return snapIn;
    const operationId = parseUuid(snapIn.value.operationId, 'operation_id'); if (!operationId.ok) return operationId; return run((client) => withOuterTxn(client, async () => {
      const row = await requireLocked(client, operationId.value); if (!row.ok) return row;
      const cur = row.value;
      if (cur.phase === 'create_dispatched' || cur.phase === 'draft_created' || cur.phase === 'update_dispatched'
          || cur.phase === 'draft_updated' || cur.phase === 'send_dispatched' || cur.phase === 'reconciled_sent'
          || cur.create_invocation_count === 1) {
        return ok(toPublic(cur, true, null));
      }
      if (cur.phase === 'terminal' || cur.phase !== 'claimed') return fail('phase_conflict');
      const updated = await client.query(SQL_CLAIM_CREATE, [operationId.value]);
      if (!updated || !updated.rows || updated.rows.length !== 1) {
        const again = await lockRowResult(client, operationId.value); if (!again.ok) return again;
        if (again.value && again.value.create_invocation_count === 1) return ok(toPublic(again.value, true, null));
        return fail('phase_conflict');
      }
      return publicOrInvalid(updated.rows[0], false, { create: true });
    }));
  }
  async function persistDraftCreated(input) {
    const snapIn = snapshotInput(input, DRAFT_INPUT_KEYS); if (!snapIn.ok) return snapIn;
    const operationId = parseUuid(snapIn.value.operationId, 'operation_id'); if (!operationId.ok) return operationId;
    const draftId = parseDraftId(snapIn.value.immutableDraftId); if (!draftId.ok) return draftId; return run((client) => withOuterTxn(client, async () => {
      const row = await requireLocked(client, operationId.value); if (!row.ok) return row;
      const cur = row.value; if (cur.phase === 'draft_created' && cur.immutable_draft_id === draftId.value) return ok(toPublic(cur, true, null));
      if (cur.immutable_draft_id != null && cur.immutable_draft_id !== draftId.value) return fail('immutable_draft_id_conflict');
      if (cur.phase !== 'create_dispatched' || cur.create_invocation_count !== 1) return fail('phase_conflict');
      let updated; try { updated = await client.query(SQL_DRAFT, [operationId.value, draftId.value]); }
      catch (err) { if (isUniqueViolation(err)) return fail('immutable_draft_id_conflict'); throw err; }
      if (!updated || !updated.rows || updated.rows.length !== 1) return fail('phase_conflict'); return publicOrInvalid(updated.rows[0], false, null);
    }));
  }
  async function claimUpdate(input) {
    const snapIn = snapshotInput(input, DRAFT_INPUT_KEYS); if (!snapIn.ok) return snapIn;
    const operationId = parseUuid(snapIn.value.operationId, 'operation_id'); if (!operationId.ok) return operationId;
    const draftId = parseDraftId(snapIn.value.immutableDraftId); if (!draftId.ok) return draftId; return run((client) => withOuterTxn(client, async () => {
      const row = await requireLocked(client, operationId.value); if (!row.ok) return row;
      const cur = row.value;
      if (cur.immutable_draft_id != null && cur.immutable_draft_id !== draftId.value) return fail('immutable_draft_id_conflict');
      if (cur.phase === 'update_dispatched' || cur.phase === 'draft_updated' || cur.phase === 'send_dispatched'
          || cur.phase === 'reconciled_sent' || cur.update_invocation_count === 1) {
        return ok(toPublic(cur, true, null));
      }
      if (cur.phase === 'terminal' || cur.phase !== 'draft_created' || cur.create_invocation_count !== 1) return fail('phase_conflict');
      if (cur.immutable_draft_id == null || cur.immutable_draft_id !== draftId.value) return fail('immutable_draft_id_conflict');
      const updated = await client.query(SQL_CLAIM_UPDATE, [operationId.value, draftId.value]);
      if (!updated || !updated.rows || updated.rows.length !== 1) {
        const again = await lockRowResult(client, operationId.value); if (!again.ok) return again;
        if (again.value && again.value.update_invocation_count === 1) return ok(toPublic(again.value, true, null));
        return fail('phase_conflict');
      }
      return publicOrInvalid(updated.rows[0], false, { update: true });
    }));
  }
  async function markDraftUpdated(input) {
    const snapIn = snapshotInput(input, OP_ID_KEYS); if (!snapIn.ok) return snapIn;
    const operationId = parseUuid(snapIn.value.operationId, 'operation_id'); if (!operationId.ok) return operationId; return run((client) => withOuterTxn(client, async () => {
      const row = await requireLocked(client, operationId.value); if (!row.ok) return row;
      if (row.value.phase === 'draft_updated') return ok(toPublic(row.value, true, null));
      if (row.value.phase !== 'update_dispatched' || row.value.update_invocation_count !== 1) return fail('phase_conflict');
      const updated = await client.query(SQL_UPDATED, [operationId.value]); if (!updated || !updated.rows || updated.rows.length !== 1) return fail('phase_conflict');
      return publicOrInvalid(updated.rows[0], false, null);
    }));
  }
  async function claimDispatch(input) {
    const snapIn = snapshotInput(input, OP_ID_KEYS); if (!snapIn.ok) return snapIn;
    const operationId = parseUuid(snapIn.value.operationId, 'operation_id'); if (!operationId.ok) return operationId; return run((client) => withOuterTxn(client, async () => {
      const row = await requireLocked(client, operationId.value); if (!row.ok) return row;
      const cur = row.value; if (cur.phase === 'send_dispatched' || cur.phase === 'reconciled_sent' || cur.send_invocation_count === 1) return ok(toPublic(cur, true, null));
      if (cur.phase === 'terminal' || cur.phase !== 'draft_updated') return fail('phase_conflict');
      const updated = await client.query(SQL_DISPATCH, [operationId.value]); if (!updated || !updated.rows || updated.rows.length !== 1) {
        const again = await lockRowResult(client, operationId.value); if (!again.ok) return again;
        if (again.value && again.value.send_invocation_count === 1) return ok(toPublic(again.value, true, null)); return fail('phase_conflict');
      }
      return publicOrInvalid(updated.rows[0], false, { dispatch: true });
    }));
  }
  async function reconcileSent(input) {
    const snapIn = snapshotInput(input, DRAFT_INPUT_KEYS); if (!snapIn.ok) return snapIn;
    const operationId = parseUuid(snapIn.value.operationId, 'operation_id'); if (!operationId.ok) return operationId;
    const draftId = parseDraftId(snapIn.value.immutableDraftId); if (!draftId.ok) return draftId; return run((client) => withOuterTxn(client, async () => {
      const row = await requireLocked(client, operationId.value); if (!row.ok) return row;
      const cur = row.value; if (cur.phase === 'reconciled_sent' && cur.outcome === 'committed') {
        return cur.immutable_draft_id === draftId.value ? ok(toPublic(cur, true, null)) : fail('immutable_draft_id_conflict');
      }
      if (cur.phase === 'terminal' || cur.phase !== 'send_dispatched') return fail('phase_conflict');
      if (cur.immutable_draft_id == null || cur.immutable_draft_id !== draftId.value) return fail('immutable_draft_id_conflict');
      const updated = await client.query(SQL_RECONCILE, [operationId.value, draftId.value]); if (!updated || !updated.rows || updated.rows.length !== 1) return fail('phase_conflict');
      return publicOrInvalid(updated.rows[0], false, null);
    }));
  }
  async function markTerminal(input) {
    const snapIn = snapshotInput(input, TERMINAL_INPUT_KEYS); if (!snapIn.ok) return snapIn;
    const operationId = parseUuid(snapIn.value.operationId, 'operation_id'); if (!operationId.ok) return operationId;
    const outcome = snapIn.value.outcome; if (typeof outcome !== 'string' || !OUTCOMES.includes(outcome)) return fail('outcome_invalid'); return run((client) => withOuterTxn(client, async () => {
      const row = await requireLocked(client, operationId.value); if (!row.ok) return row;
      const cur = row.value; if (cur.phase === 'terminal') return cur.outcome === outcome ? ok(toPublic(cur, true, null)) : fail('phase_conflict');
      if (cur.phase === 'reconciled_sent') return fail('phase_conflict');
      const phase = cur.phase; const createC = cur.create_invocation_count; const updateC = cur.update_invocation_count; const sendC = cur.send_invocation_count;
      let allowed;
      if (phase === 'create_dispatched' || phase === 'update_dispatched') allowed = INTENT_TERMINAL;
      else if (sendC === 1) allowed = POST_SEND_TERMINAL;
      else allowed = PRE_INTENT_TERMINAL;
      if (!allowed.includes(outcome)) return fail('outcome_invalid');
      if (phase === 'create_dispatched' && !(createC === 1 && updateC === 0 && sendC === 0)) return fail('phase_conflict');
      if (phase === 'update_dispatched' && !(createC === 1 && updateC === 1 && sendC === 0)) return fail('phase_conflict');
      if (sendC === 0 && !['claimed','create_dispatched','draft_created','update_dispatched','draft_updated'].includes(phase)) return fail('phase_conflict');
      if (sendC === 1 && phase !== 'send_dispatched') return fail('phase_conflict');
      const updated = await client.query(SQL_TERMINAL, [operationId.value, outcome, phase, createC, updateC, sendC]);
      if (!updated || !updated.rows || updated.rows.length !== 1) return fail('phase_conflict');
      return publicOrInvalid(updated.rows[0], false, null);
    }));
  }
  return freeze({ claim, load, claimCreate, persistDraftCreated, claimUpdate, markDraftUpdated, claimDispatch, reconcileSent, markTerminal });
}
module.exports = freeze({
  FAILURE_CODE, FAILURE_MESSAGE, EMAIL_OUTBOUND_SEND_JOURNAL_RUNTIME_WIRED,
  EMAIL_OUTBOUND_SEND_JOURNAL_LOGGING_FORBIDDEN, EMAIL_OUTBOUND_SEND_JOURNAL_PROVIDER,
  STORE_DEPENDENCY_KEYS, AUTHORITY_KEYS, OPERATION_RESULT_KEYS, OUTCOMES, PHASES,
  createEmailOutboundSendJournalStore,
});
