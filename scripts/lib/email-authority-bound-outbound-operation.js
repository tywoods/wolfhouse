'use strict';
/** Gate 3 authority-bound outbound composition (UNWIRED). Journal claimCreate/claimUpdate/claimDispatch before provider. */
const crypto = require('crypto');
const util = require('util');
const {
  EMAIL_OUTBOUND_SEND_JOURNAL_RUNTIME_WIRED, EMAIL_OUTBOUND_SEND_JOURNAL_LOGGING_FORBIDDEN,
} = require('./email-outbound-send-journal-store');
const {
  EMAIL_DELEGATED_GRANT_ACCESS_SESSION_RUNTIME_WIRED, STATUS_REAUTH, STATUS_UNCERTAIN, STATUS_UNAVAILABLE,
} = require('./email-delegated-grant-access-session');
const {
  EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_RUNTIME_WIRED, EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_DELIVERY_FROM_202,
  EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_LOGGING_FORBIDDEN, readTrustedGraphStage, FAILURE_CODE: GRAPH_FAILURE_CODE,
} = require('./email-microsoft-graph-reply-draft-transport');
const FAILURE_CODE = 'authority_bound_outbound_failed';
const FAILURE_MESSAGE = 'Authority-bound outbound operation failed.';
const EMAIL_AUTHORITY_BOUND_OUTBOUND_RUNTIME_WIRED = false;
const EMAIL_AUTHORITY_BOUND_OUTBOUND_PERSISTENCE_READY = false;
const EMAIL_AUTHORITY_BOUND_OUTBOUND_LOGGING_FORBIDDEN = true;
const EMAIL_AUTHORITY_BOUND_OUTBOUND_SAFE_FOR_RUNTIME_ROUTE = false;
const EMAIL_AUTHORITY_BOUND_OUTBOUND_AUTO_RESEND = false;
const EMAIL_AUTHORITY_BOUND_OUTBOUND_AUTO_CREATE_AFTER_DRAFT = false;
const DEPENDENCY_KEYS = Object.freeze(['journalStore', 'createAccessSession', 'replyDraftTransport', 'authority']);
const AUTHORITY_KEYS = Object.freeze([
  'clientId', 'locationId', 'locationKey', 'endpointId', 'conversationId',
  'actorStaffUserId', 'providerMailboxId', 'sourceMessageId',
]);
const INPUT_KEYS = Object.freeze(['operationId', 'approvalId', 'messageText']);
const JOURNAL_KEYS = Object.freeze([
  'claim', 'load', 'claimCreate', 'persistDraftCreated', 'claimUpdate', 'markDraftUpdated',
  'claimDispatch', 'reconcileSent', 'markTerminal',
]);
const TRANSPORT_KEYS = Object.freeze(['createReply', 'updateApprovedDraft', 'sendDraft', 'reconcileDraft']);
const ACCESS_SESSION_KEYS = Object.freeze(['runWithAccessTokenOnce']);
const GRANT_SESSION_CALL_KEYS = Object.freeze(['clientId', 'endpointId']);
const LOAN_KEYS = Object.freeze(['accessToken']);
const RESULT_KEYS = Object.freeze([
  'status', 'phase', 'outcome', 'operation_id', 'approval_id', 'body_digest',
  'create_invocation_count', 'update_invocation_count', 'send_invocation_count', 'replayed',
]);
const JOURNAL_VALUE_KEYS = Object.freeze([
  'operation_id', 'approval_id', 'phase', 'outcome', 'immutable_draft_id', 'body_digest',
  'create_invocation_count', 'update_invocation_count', 'send_invocation_count', 'provider',
  'replayed', 'authorize_create', 'authorize_update', 'authorize_dispatch',
]);
const PHASES = Object.freeze([
  'claimed', 'create_dispatched', 'draft_created', 'update_dispatched', 'draft_updated',
  'send_dispatched', 'reconciled_sent', 'terminal',
]);
const OUTCOMES = Object.freeze(['claimed', 'committed', 'not_committed', 'outcome_unknown', 'conflict', 'rejected']);
const PUBLIC_STATUS = Object.freeze([
  'committed', 'terminal', 'outcome_unknown', 'recovery', 'reauthorization_required', 'unavailable', 'uncertain',
]);
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCATION_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const BODY_DIGEST_RE = /^[0-9a-f]{64}$/;
const BODY_CONTENT_LIMIT = 64_000; const ID_LIMIT = 2048; const TOKEN_LIMIT = 16_384;
const DRAFT_SECRET_RE = new RegExp(`${'access'}_${'token'}|${'refresh'}_${'token'}|bearer\\s`, 'i');
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);
const JOURNAL_ERR = Object.freeze([
  'input_invalid', 'operation_id_invalid', 'approval_id_invalid', 'body_digest_invalid', 'location_key_invalid',
  'immutable_draft_id_invalid', 'outcome_invalid', 'operation_not_found', 'operation_id_conflict',
  'approval_id_conflict', 'phase_conflict', 'immutable_draft_id_conflict', 'db_result_invalid',
  'commit_outcome_unknown', 'email_outbound_send_journal_write_failed', 'email_outbound_send_journal_failed',
]);
const ACCESS_STATUS = Object.freeze(new Set([
  STATUS_REAUTH, STATUS_UNCERTAIN, STATUS_UNAVAILABLE,
  'reauthorization_required', 'uncertain', 'unavailable',
]));
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
const PINNED_CREATE_HASH = crypto && typeof crypto.createHash === 'function' ? crypto.createHash : null;
let PINNED_HASH_UPDATE = null; let PINNED_HASH_DIGEST = null;
try {
  if (PINNED_CREATE_HASH && PINNED_GOPD && PINNED_GPO && PINNED_HAS_OWN && PINNED_REFLECT_APPLY) {
    const probe = PINNED_REFLECT_APPLY.call(Reflect, PINNED_CREATE_HASH, crypto, ['sha256']);
    const hashProto = (crypto.Hash && crypto.Hash.prototype)
      ? crypto.Hash.prototype
      : (probe ? PINNED_GPO.call(Object, probe) : null);
    const u = hashProto ? PINNED_GOPD.call(Object, hashProto, 'update') : null;
    const d = hashProto ? PINNED_GOPD.call(Object, hashProto, 'digest') : null;
    if (u && d && PINNED_HAS_OWN.call(u, 'value') && PINNED_HAS_OWN.call(d, 'value')
        && typeof u.value === 'function' && typeof d.value === 'function' && !u.get && !d.get && !u.set && !d.set) {
      PINNED_HASH_UPDATE = u.value; PINNED_HASH_DIGEST = d.value;
    }
  }
} catch { PINNED_HASH_UPDATE = null; PINNED_HASH_DIGEST = null; }
const PINNED_READY = Boolean(PINNED_IS_PROXY && PINNED_UTIL_TYPES && PINNED_REFLECT_APPLY && PINNED_REFLECT_OWN_KEYS
  && PINNED_GOPD && PINNED_GPO && PINNED_OBJECT_FREEZE && PINNED_IS_FROZEN && PINNED_HAS_OWN
  && PINNED_OBJECT_PROTOTYPE && PINNED_CREATE_HASH && PINNED_HASH_UPDATE && PINNED_HASH_DIGEST);
if (EMAIL_OUTBOUND_SEND_JOURNAL_RUNTIME_WIRED !== false) throw new Error('authority_bound_outbound_journal_runtime_wired');
if (EMAIL_OUTBOUND_SEND_JOURNAL_LOGGING_FORBIDDEN !== true) throw new Error('authority_bound_outbound_journal_logging_unexpected');
if (EMAIL_DELEGATED_GRANT_ACCESS_SESSION_RUNTIME_WIRED !== false) throw new Error('authority_bound_outbound_access_session_runtime_wired');
if (EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_RUNTIME_WIRED !== false) throw new Error('authority_bound_outbound_transport_runtime_wired');
if (EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_DELIVERY_FROM_202 !== false) throw new Error('authority_bound_outbound_delivery_from_202_unexpected');
if (EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_LOGGING_FORBIDDEN !== true) throw new Error('authority_bound_outbound_transport_logging_unexpected');
function freeze(v) { return PINNED_OBJECT_FREEZE.call(Object, v); }
function isFrozen(v) { try { return PINNED_IS_FROZEN.call(Object, v) === true; } catch { return false; } }
function failure(code) {
  const e = new Error(FAILURE_MESSAGE);
  Object.defineProperty(e, 'name', { value: 'AuthorityBoundOutboundOperationError' });
  Object.defineProperty(e, 'code', { value: (typeof code === 'string' && code) || FAILURE_CODE, enumerable: true });
  return freeze(e);
}
function fail(error) { return freeze({ ok: false, error: typeof error === 'string' && error ? error : FAILURE_CODE }); }
function ok(value) { return freeze({ ok: true, value }); }
function isProxy(v) {
  try { if (!PINNED_READY) return true; return PINNED_REFLECT_APPLY.call(Reflect, PINNED_IS_PROXY, PINNED_UTIL_TYPES, [v]) === true; }
  catch { return true; }
}
function ownData(o, k) {
  try {
    if (!PINNED_GOPD || !PINNED_HAS_OWN) return undefined;
    const d = PINNED_GOPD.call(Object, o, k);
    return d && PINNED_HAS_OWN.call(d, 'value') && !d.get && !d.set ? d.value : undefined;
  } catch { return undefined; }
}
function exactPlain(o, keys) {
  try {
    if (!PINNED_READY || !o || typeof o !== 'object' || Array.isArray(o) || isProxy(o)) return false;
    if (PINNED_GPO.call(Object, o) !== PINNED_OBJECT_PROTOTYPE) return false;
    const actual = PINNED_REFLECT_OWN_KEYS.call(Reflect, o);
    if (actual.length !== keys.length || actual.some((k) => typeof k !== 'string' || DANGEROUS.has(k) || !keys.includes(k))) return false;
    return keys.every((k) => {
      const d = PINNED_GOPD.call(Object, o, k);
      return Boolean(d && PINNED_HAS_OWN.call(d, 'value') && d.enumerable && !d.get && !d.set);
    });
  } catch { return false; }
}
function parseUuid(raw, field) {
  if (raw == null || typeof raw !== 'string') return fail(`${field}_invalid`);
  const t = raw.trim().toLowerCase();
  if (!t || !UUID_CANON.test(t) || t !== raw.trim().toLowerCase()) return fail(`${field}_invalid`);
  return ok(t);
}
function parseLocationKey(raw) {
  return raw != null && typeof raw === 'string' && LOCATION_KEY_RE.test(raw) && raw.length <= 64 ? ok(raw) : fail('location_key_invalid');
}
function parseSourceMessageId(raw) {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > ID_LIMIT) return fail('source_message_id_invalid');
  if (!/^[\x21-\x7e]+$/.test(raw) || /[/?#]/.test(raw) || raw.indexOf('@') !== -1) return fail('source_message_id_invalid');
  return ok(raw);
}
function parseMessageText(raw) {
  return typeof raw === 'string' && raw.length >= 1 && raw.length <= BODY_CONTENT_LIMIT ? ok(raw) : fail('message_text_invalid');
}
function mapJournalError(code) { return typeof code === 'string' && JOURNAL_ERR.includes(code) ? code : FAILURE_CODE; }
function exactCount(v) { return typeof v === 'number' && Number.isInteger(v) && (v === 0 || v === 1) ? v : null; }
function draftShapeOk(raw) {
  return raw != null && typeof raw === 'string' && raw.length >= 1 && raw.length <= ID_LIMIT
    && raw.indexOf('@') === -1 && !DRAFT_SECRET_RE.test(raw);
}
function phaseCouplingOk(phase, outcome, draft, createC, updateC, sendC) {
  const has = draft !== null;
  if (phase === 'claimed') return !has && createC === 0 && updateC === 0 && sendC === 0 && outcome === 'claimed';
  if (phase === 'create_dispatched') return !has && createC === 1 && updateC === 0 && sendC === 0 && outcome === 'outcome_unknown';
  if (phase === 'draft_created') return has && createC === 1 && updateC === 0 && sendC === 0 && outcome === 'not_committed';
  if (phase === 'update_dispatched') return has && createC === 1 && updateC === 1 && sendC === 0 && outcome === 'outcome_unknown';
  if (phase === 'draft_updated') return has && createC === 1 && updateC === 1 && sendC === 0 && outcome === 'not_committed';
  if (phase === 'send_dispatched') return has && createC === 1 && updateC === 1 && sendC === 1 && outcome === 'outcome_unknown';
  if (phase === 'reconciled_sent') return has && createC === 1 && updateC === 1 && sendC === 1 && outcome === 'committed';
  if (phase !== 'terminal' || !['not_committed', 'outcome_unknown', 'conflict', 'rejected'].includes(outcome)) return false;
  if (updateC === 1 && createC !== 1) return false;
  if (sendC === 1 && !(createC === 1 && updateC === 1 && has)) return false;
  if (has && createC !== 1) return false;
  if (!has && (updateC !== 0 || sendC !== 0)) return false;
  return !(outcome === 'not_committed' && sendC !== 0);
}
function authCouplingOk(method, phase, draft, createC, updateC, sendC, replayed, aC, aU, aD) {
  if ((aC === true ? 1 : 0) + (aU === true ? 1 : 0) + (aD === true ? 1 : 0) > 1) return false;
  if (replayed === true || phase === 'terminal' || method === 'claim' || method === 'load'
      || method === 'persistDraftCreated' || method === 'markDraftUpdated' || method === 'reconcileSent' || method === 'markTerminal') {
    return aC === false && aU === false && aD === false;
  }
  if (aC === true) return method === 'claimCreate' && phase === 'create_dispatched' && createC === 1 && updateC === 0 && sendC === 0 && draft === null;
  if (aU === true) return method === 'claimUpdate' && phase === 'update_dispatched' && createC === 1 && updateC === 1 && sendC === 0 && draft !== null;
  if (aD === true) return method === 'claimDispatch' && phase === 'send_dispatched' && createC === 1 && updateC === 1 && sendC === 1 && draft !== null;
  return true;
}
function bodyDigestOf(text) {
  try {
    const h = PINNED_REFLECT_APPLY.call(Reflect, PINNED_CREATE_HASH, crypto, ['sha256']);
    if (!h) return fail(FAILURE_CODE);
    PINNED_REFLECT_APPLY.call(Reflect, PINNED_HASH_UPDATE, h, [text, 'utf8']);
    const dig = PINNED_REFLECT_APPLY.call(Reflect, PINNED_HASH_DIGEST, h, ['hex']);
    return typeof dig === 'string' && BODY_DIGEST_RE.test(dig) ? ok(dig) : fail(FAILURE_CODE);
  } catch { return fail(FAILURE_CODE); }
}
function snapshotAuthority(authority) {
  try {
    if (!exactPlain(authority, AUTHORITY_KEYS)) return null;
    const p = [
      parseUuid(ownData(authority, 'clientId'), 'client_id'), parseUuid(ownData(authority, 'locationId'), 'location_id'),
      parseLocationKey(ownData(authority, 'locationKey')), parseUuid(ownData(authority, 'endpointId'), 'endpoint_id'),
      parseUuid(ownData(authority, 'conversationId'), 'conversation_id'), parseUuid(ownData(authority, 'actorStaffUserId'), 'actor_staff_user_id'),
      parseUuid(ownData(authority, 'providerMailboxId'), 'provider_mailbox_id'), parseSourceMessageId(ownData(authority, 'sourceMessageId')),
    ];
    if (!p.every((x) => x.ok)) return null;
    return freeze({
      clientId: p[0].value, locationId: p[1].value, locationKey: p[2].value, endpointId: p[3].value,
      conversationId: p[4].value, actorStaffUserId: p[5].value, providerMailboxId: p[6].value, sourceMessageId: p[7].value,
    });
  } catch { return null; }
}
function resolveCallable(surface, key) {
  try {
    if (!surface || (typeof surface !== 'object' && typeof surface !== 'function') || isProxy(surface)) return null;
    const d = PINNED_GOPD.call(Object, surface, key);
    if (!d || !PINNED_HAS_OWN.call(d, 'value') || typeof d.value !== 'function' || d.get || d.set || isProxy(d.value)) return null;
    return d.value;
  } catch { return null; }
}
function resolveMethodBag(raw, keys) {
  try {
    if (!raw || (typeof raw !== 'object' && typeof raw !== 'function') || isProxy(raw) || !isFrozen(raw)) return null;
    const actual = PINNED_REFLECT_OWN_KEYS.call(Reflect, raw);
    if (!actual || actual.length !== keys.length || actual.some((k) => typeof k !== 'string' || DANGEROUS.has(k) || !keys.includes(k))) return null;
    const out = {};
    for (const k of keys) {
      const fn = resolveCallable(raw, k); if (!fn) return null;
      const receiver = raw;
      out[k] = function pinned(...args) { return PINNED_REFLECT_APPLY.call(Reflect, fn, receiver, args); };
    }
    return freeze(out);
  } catch { return null; }
}
function resolveCreateAccessSession(raw) {
  try {
    if (typeof raw !== 'function' || isProxy(raw)) return null;
    const captured = raw;
    return function pinnedCreate() {
      const session = PINNED_REFLECT_APPLY.call(Reflect, captured, undefined, []);
      if (!session || (typeof session !== 'object' && typeof session !== 'function') || isProxy(session) || !isFrozen(session)) throw failure();
      const keys = PINNED_REFLECT_OWN_KEYS.call(Reflect, session);
      if (!keys || keys.length !== 1 || keys[0] !== 'runWithAccessTokenOnce') throw failure();
      const fn = resolveCallable(session, 'runWithAccessTokenOnce'); if (!fn) throw failure();
      return freeze({ runWithAccessTokenOnce(...args) { return PINNED_REFLECT_APPLY.call(Reflect, fn, session, args); } });
    };
  } catch { return null; }
}
function acceptJournalResult(result, expect) {
  try {
    if (!expect || typeof expect !== 'object' || typeof expect.method !== 'string' || typeof expect.operationId !== 'string'
        || typeof expect.approvalId !== 'string' || typeof expect.bodyDigest !== 'string') return null;
    if (!result || typeof result !== 'object' || isProxy(result) || !isFrozen(result)) return null;
    if (ownData(result, 'ok') === false) {
      return exactPlain(result, ['ok', 'error']) ? fail(mapJournalError(ownData(result, 'error'))) : null;
    }
    if (ownData(result, 'ok') !== true || !exactPlain(result, ['ok', 'value'])) return null;
    const value = ownData(result, 'value');
    if (!value || typeof value !== 'object' || isProxy(value) || !isFrozen(value) || !exactPlain(value, JOURNAL_VALUE_KEYS)) return null;
    const phase = ownData(value, 'phase'); const outcome = ownData(value, 'outcome');
    if (typeof phase !== 'string' || !PHASES.includes(phase) || typeof outcome !== 'string' || !OUTCOMES.includes(outcome)) return null;
    const operationId = ownData(value, 'operation_id'); const approvalId = ownData(value, 'approval_id');
    if (typeof operationId !== 'string' || !UUID_CANON.test(operationId) || operationId !== operationId.toLowerCase()) return null;
    if (typeof approvalId !== 'string' || !UUID_CANON.test(approvalId) || approvalId !== approvalId.toLowerCase()) return null;
    if (operationId !== expect.operationId || approvalId !== expect.approvalId) return null;
    const draftRaw = ownData(value, 'immutable_draft_id');
    const draftId = draftRaw == null ? null : (draftShapeOk(draftRaw) ? draftRaw : null);
    if (draftRaw != null && draftId == null) return null;
    if (PINNED_HAS_OWN.call(expect, 'expectedDraftId') && draftId !== expect.expectedDraftId) return null;
    const bodyDigest = ownData(value, 'body_digest');
    if (typeof bodyDigest !== 'string' || !BODY_DIGEST_RE.test(bodyDigest) || bodyDigest !== expect.bodyDigest
        || ownData(value, 'provider') !== 'microsoft_graph') return null;
    const createC = exactCount(ownData(value, 'create_invocation_count'));
    const updateC = exactCount(ownData(value, 'update_invocation_count'));
    const sendC = exactCount(ownData(value, 'send_invocation_count'));
    if (createC == null || updateC == null || sendC == null) return null;
    const replayed = ownData(value, 'replayed'); const authCreate = ownData(value, 'authorize_create');
    const authUpdate = ownData(value, 'authorize_update'); const authDispatch = ownData(value, 'authorize_dispatch');
    if (replayed !== true && replayed !== false) return null;
    if (authCreate !== true && authCreate !== false) return null;
    if (authUpdate !== true && authUpdate !== false) return null;
    if (authDispatch !== true && authDispatch !== false) return null;
    if (!phaseCouplingOk(phase, outcome, draftId, createC, updateC, sendC)) return null;
    if (!authCouplingOk(expect.method, phase, draftId, createC, updateC, sendC, replayed, authCreate, authUpdate, authDispatch)) return null;
    return ok(freeze({
      operation_id: operationId, approval_id: approvalId, phase, outcome, immutable_draft_id: draftId, body_digest: bodyDigest,
      create_invocation_count: createC, update_invocation_count: updateC, send_invocation_count: sendC,
      replayed, authorize_create: authCreate, authorize_update: authUpdate, authorize_dispatch: authDispatch,
    }));
  } catch { return null; }
}
function toPublic(state, status) {
  const st = typeof status === 'string' && PUBLIC_STATUS.includes(status) ? status : 'outcome_unknown';
  return freeze({
    status: st, phase: state.phase, outcome: state.outcome, operation_id: state.operation_id,
    approval_id: state.approval_id, body_digest: state.body_digest,
    create_invocation_count: state.create_invocation_count, update_invocation_count: state.update_invocation_count,
    send_invocation_count: state.send_invocation_count, replayed: state.replayed === true,
  });
}
function mapAccessFail(status, state) {
  if (status === STATUS_REAUTH || status === 'reauthorization_required') return ok(toPublic(state, 'reauthorization_required'));
  if (status === STATUS_UNAVAILABLE || status === 'unavailable') return ok(toPublic(state, 'unavailable'));
  return (status === STATUS_UNCERTAIN || status === 'uncertain') ? ok(toPublic(state, 'uncertain')) : fail(FAILURE_CODE);
}
function graphStage(err) {
  try {
    if (!err || (typeof err !== 'object' && typeof err !== 'function') || isProxy(err) || ownData(err, 'code') !== GRAPH_FAILURE_CODE) return null;
    const stage = readTrustedGraphStage(err); return typeof stage === 'string' ? stage : null;
  } catch { return null; }
}
function extractLoanToken(loan) {
  try {
    if (!loan || typeof loan !== 'object' || isProxy(loan) || PINNED_GPO.call(Object, loan) !== PINNED_OBJECT_PROTOTYPE) return null;
    const keys = PINNED_REFLECT_OWN_KEYS.call(Reflect, loan);
    if (!keys || keys.length !== 1 || keys[0] !== 'accessToken') return null;
    const d = PINNED_GOPD.call(Object, loan, 'accessToken');
    if (!d || !PINNED_HAS_OWN.call(d, 'value') || d.get || d.set) return null;
    const token = d.value;
    return (typeof token === 'string' && token.length >= 1 && token.length <= TOKEN_LIMIT && /^[\x21-\x7e]+$/.test(token)) ? token : null;
  } catch { return null; }
}
function scrubTokenField(holder) {
  try { if (holder && typeof holder === 'object' && !isProxy(holder)) holder.accessToken = null; } catch { /* */ }
}
function createAuthorityBoundOutboundOperation(deps) {
  if (!PINNED_READY) throw failure();
  let journal; let createAccessSession; let transport; let authority;
  try {
    if (!exactPlain(deps, DEPENDENCY_KEYS)) throw failure();
    journal = resolveMethodBag(ownData(deps, 'journalStore'), JOURNAL_KEYS);
    createAccessSession = resolveCreateAccessSession(ownData(deps, 'createAccessSession'));
    transport = resolveMethodBag(ownData(deps, 'replyDraftTransport'), TRANSPORT_KEYS);
    authority = snapshotAuthority(ownData(deps, 'authority'));
    if (!journal || !createAccessSession || !transport || !authority) throw failure();
  } catch (err) {
    if (err && ownData(err, 'code') === FAILURE_CODE) throw err;
    throw failure();
  }
  const grantInput = freeze({ clientId: authority.clientId, endpointId: authority.endpointId });
  async function withAccessToken(consumer) {
    if (typeof consumer !== 'function' || isProxy(consumer)) return fail(FAILURE_CODE);
    let session;
    try { session = createAccessSession(); } catch { return fail(FAILURE_CODE); }
    const run = ownData(session, 'runWithAccessTokenOnce');
    if (typeof run !== 'function') return fail(FAILURE_CODE);
    let sessionResult; let consumerEntered = false;
    try {
      sessionResult = await PINNED_REFLECT_APPLY.call(Reflect, run, session, [
        grantInput,
        async (loan) => {
          consumerEntered = true;
          try {
            const token = extractLoanToken(loan);
            if (!token) throw failure();
            try { loan.accessToken = null; } catch { /* */ }
            return consumer(token);
          } finally { try { if (loan) loan.accessToken = null; } catch { /* */ } }
        },
      ]);
    } catch (err) {
      if (err && ownData(err, 'code') === FAILURE_CODE) {
        return consumerEntered ? freeze({ ok: false, error: FAILURE_CODE, after_provider: true }) : fail(FAILURE_CODE);
      }
      const stage = graphStage(err);
      if (stage) return freeze({ ok: false, error: `graph_${stage}`, stage, after_provider: true });
      return consumerEntered ? freeze({ ok: false, error: FAILURE_CODE, after_provider: true }) : fail(FAILURE_CODE);
    }
    if (!sessionResult || typeof sessionResult !== 'object' || isProxy(sessionResult)) return fail(FAILURE_CODE);
    if (ownData(sessionResult, 'ok') === true) return ok(ownData(sessionResult, 'value'));
    if (ownData(sessionResult, 'ok') === false) {
      const st = ownData(sessionResult, 'status');
      if (typeof st === 'string' && ACCESS_STATUS.has(st)) {
        return freeze({ ok: false, error: 'access_session_failed', access_status: st });
      }
      return fail(FAILURE_CODE);
    }
    return fail(FAILURE_CODE);
  }
  async function journalCall(method, input, expect) {
    try {
      const fn = ownData(journal, method);
      if (typeof fn !== 'function') return fail(FAILURE_CODE);
      const accepted = acceptJournalResult(await PINNED_REFLECT_APPLY.call(Reflect, fn, journal, [input]), expect);
      return accepted || fail(FAILURE_CODE);
    } catch { return fail(FAILURE_CODE); }
  }
  async function reconcileOnly(state) {
    const draftId = state.immutable_draft_id;
    if (typeof draftId !== 'string' || !draftId) return ok(toPublic(state, 'outcome_unknown'));
    const rec = await withAccessToken(async (token) => {
      const req = { accessToken: token, provider_mailbox_id: authority.providerMailboxId, immutable_draft_id: draftId };
      try { return await transport.reconcileDraft(req); } finally { scrubTokenField(req); }
    });
    if (!rec.ok) {
      if (ownData(rec, 'error') === 'access_session_failed') return mapAccessFail(ownData(rec, 'access_status'), state);
      return ok(toPublic(state, 'outcome_unknown'));
    }
    const body = rec.value;
    if (!body || typeof body !== 'object' || isProxy(body)) return ok(toPublic(state, 'outcome_unknown'));
    if (ownData(body, 'immutable_draft_id') !== draftId) return ok(toPublic(state, 'outcome_unknown'));
    if (ownData(body, 'outcome') === 'sent' && ownData(body, 'isDraft') === false) {
      const committed = await journalCall('reconcileSent', freeze({ operationId: state.operation_id, immutableDraftId: draftId }), {
        method: 'reconcileSent', operationId: state.operation_id, approvalId: state.approval_id,
        bodyDigest: state.body_digest, expectedDraftId: draftId,
      });
      return committed.ok ? ok(toPublic(committed.value, 'committed')) : ok(toPublic(state, 'outcome_unknown'));
    }
    return ok(toPublic(state, 'outcome_unknown'));
  }
  async function runAuthorityBoundOutbound(input) {
    if (!exactPlain(input, INPUT_KEYS)) return fail('input_invalid');
    const operationId = parseUuid(ownData(input, 'operationId'), 'operation_id'); if (!operationId.ok) return operationId;
    const approvalId = parseUuid(ownData(input, 'approvalId'), 'approval_id'); if (!approvalId.ok) return approvalId;
    const messageText = parseMessageText(ownData(input, 'messageText')); if (!messageText.ok) return messageText;
    const digest = bodyDigestOf(messageText.value); if (!digest.ok) return digest;
    const opId = operationId.value; const apId = approvalId.value; const dig = digest.value;
    const jExpect = (method, expectedDraftId) => {
      const e = { method, operationId: opId, approvalId: apId, bodyDigest: dig };
      if (expectedDraftId !== undefined) e.expectedDraftId = expectedDraftId;
      return e;
    };
    let approvedText = messageText.value;
    try {
      const claimed = await journalCall('claim', freeze({
        operationId: opId, approvalId: apId, bodyDigest: dig,
      }), jExpect('claim'));
      if (!claimed.ok) return claimed;
      let state = claimed.value;
      if (state.phase === 'reconciled_sent' && state.outcome === 'committed') return ok(toPublic(state, 'committed'));
      if (state.phase === 'terminal') return ok(toPublic(state, 'terminal'));
      if (state.phase === 'create_dispatched') return ok(toPublic(state, 'outcome_unknown'));
      if (state.phase === 'update_dispatched') return ok(toPublic(state, 'outcome_unknown'));
      if (state.phase === 'send_dispatched') return reconcileOnly(state);
      if (state.phase === 'claimed') {
        const createClaim = await journalCall('claimCreate', freeze({ operationId: opId }), jExpect('claimCreate'));
        if (!createClaim.ok) {
          return createClaim.error === 'commit_outcome_unknown'
            ? ok(toPublic(state, 'outcome_unknown'))
            : createClaim;
        }
        state = createClaim.value;
        if (state.authorize_create === true) {
          const created = await withAccessToken(async (token) => {
            const req = {
              accessToken: token, provider_mailbox_id: authority.providerMailboxId, source_message_id: authority.sourceMessageId,
            };
            try {
              const r = await transport.createReply(req);
              if (!r || typeof r !== 'object' || isProxy(r)) throw failure();
              const id = ownData(r, 'immutable_draft_id');
              if (typeof id !== 'string' || id.length < 1 || id.length > ID_LIMIT) throw failure();
              return id;
            } finally { scrubTokenField(req); }
          });
          if (!created.ok) {
            if (ownData(created, 'error') === 'access_session_failed') return mapAccessFail(ownData(created, 'access_status'), state);
            if (ownData(created, 'after_provider') === true) return ok(toPublic(state, 'outcome_unknown'));
            return fail(FAILURE_CODE);
          }
          const persisted = await journalCall('persistDraftCreated', freeze({
            operationId: opId, immutableDraftId: created.value,
          }), jExpect('persistDraftCreated', created.value));
          if (!persisted.ok) {
            if (persisted.error === 'immutable_draft_id_conflict') return persisted;
            return ok(toPublic(state, 'outcome_unknown'));
          }
          state = persisted.value;
        } else if (state.phase === 'create_dispatched') {
          return ok(toPublic(state, 'outcome_unknown'));
        }
      }
      if (state.phase === 'draft_created') {
        const draftId = state.immutable_draft_id;
        if (typeof draftId !== 'string' || !draftId) return ok(toPublic(state, 'recovery'));
        const updateClaim = await journalCall('claimUpdate', freeze({
          operationId: opId, immutableDraftId: draftId,
        }), jExpect('claimUpdate', draftId));
        if (!updateClaim.ok) {
          return updateClaim.error === 'commit_outcome_unknown'
            ? ok(toPublic(state, 'outcome_unknown'))
            : updateClaim;
        }
        state = updateClaim.value;
        if (state.authorize_update === true) {
          const updated = await withAccessToken(async (token) => {
            const req = {
              accessToken: token, provider_mailbox_id: authority.providerMailboxId,
              immutable_draft_id: draftId, body_content_type: 'Text', body_content: approvedText,
            };
            try {
              const r = await transport.updateApprovedDraft(req);
              if (!r || typeof r !== 'object' || isProxy(r) || ownData(r, 'immutable_draft_id') !== draftId) throw failure();
              return true;
            } finally {
              scrubTokenField(req);
              try { req.body_content = null; } catch { /* */ }
            }
          });
          approvedText = null;
          if (!updated.ok) {
            if (ownData(updated, 'error') === 'access_session_failed') return mapAccessFail(ownData(updated, 'access_status'), state);
            if (ownData(updated, 'after_provider') === true) return ok(toPublic(state, 'outcome_unknown'));
            return fail(FAILURE_CODE);
          }
          const marked = await journalCall('markDraftUpdated', freeze({ operationId: opId }), jExpect('markDraftUpdated', draftId));
          if (!marked.ok) return ok(toPublic(state, 'outcome_unknown'));
          state = marked.value;
        } else if (state.phase === 'update_dispatched') {
          approvedText = null;
          return ok(toPublic(state, 'outcome_unknown'));
        } else {
          approvedText = null;
        }
      } else {
        approvedText = null;
      }
      if (state.phase === 'draft_updated') {
        const draftId = state.immutable_draft_id;
        const dispatched = await journalCall('claimDispatch', freeze({ operationId: opId }), jExpect('claimDispatch', draftId));
        if (!dispatched.ok) {
          return dispatched.error === 'commit_outcome_unknown'
            ? ok(toPublic(state, 'outcome_unknown'))
            : ok(toPublic(state, 'recovery'));
        }
        state = dispatched.value;
        if (state.authorize_dispatch === true) {
          const sent = await withAccessToken(async (token) => {
            const req = {
              accessToken: token, provider_mailbox_id: authority.providerMailboxId, immutable_draft_id: draftId,
            };
            try {
              const r = await transport.sendDraft(req);
              if (!r || typeof r !== 'object' || isProxy(r) || ownData(r, 'delivery_claimed') === true) throw failure();
              return true;
            } finally { scrubTokenField(req); }
          });
          if (!sent.ok) {
            if (ownData(sent, 'error') === 'access_session_failed') return mapAccessFail(ownData(sent, 'access_status'), state);
            return ok(toPublic(state, 'outcome_unknown'));
          }
        }
      }
      if (state.phase === 'send_dispatched') return reconcileOnly(state);
      return ok(toPublic(state, 'recovery'));
    } finally {
      approvedText = null;
    }
  }
  return freeze({ runAuthorityBoundOutbound });
}
module.exports = freeze({
  FAILURE_CODE, FAILURE_MESSAGE,
  EMAIL_AUTHORITY_BOUND_OUTBOUND_RUNTIME_WIRED, EMAIL_AUTHORITY_BOUND_OUTBOUND_PERSISTENCE_READY,
  EMAIL_AUTHORITY_BOUND_OUTBOUND_LOGGING_FORBIDDEN, EMAIL_AUTHORITY_BOUND_OUTBOUND_SAFE_FOR_RUNTIME_ROUTE,
  EMAIL_AUTHORITY_BOUND_OUTBOUND_AUTO_RESEND, EMAIL_AUTHORITY_BOUND_OUTBOUND_AUTO_CREATE_AFTER_DRAFT,
  DEPENDENCY_KEYS, AUTHORITY_KEYS, INPUT_KEYS, JOURNAL_KEYS, TRANSPORT_KEYS, ACCESS_SESSION_KEYS,
  GRANT_SESSION_CALL_KEYS, LOAN_KEYS, RESULT_KEYS, createAuthorityBoundOutboundOperation,
});
