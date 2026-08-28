'use strict';
/** Gate 3 staff email draft/approve-send (offline). Default-off via EMAIL_STAFF_* env flags. */
/** Milestone 1: requires single-consent Microsoft grant (Mail.ReadWrite + Mail.Send). No Luna auto-send. */
/*
 * Genuine freeze intrinsic for recovery ack ownership — private only.
 *
 * Established before any local require whose import graph may read host
 * Object.isFrozen. Do NOT read host Object.isFrozen at import: pre-require
 * Object.isFrozen=()=>true would otherwise be pinned as trusted and map
 * mutable own-data {ok:true,code:email_send_committed} as HTTP 200.
 *
 * Source: fresh Node vm realm Object.isFrozen (independent primordial).
 * Recovery gate calls only PINNED_IS_FROZEN. NEVER install onto process-global
 * Object.isFrozen (forbidden host mutation). If a transitive dependency cannot
 * load under pre-import host poison, import may fail closed deterministically;
 * never mutate the global to force the load graph open. Scope is this freeze
 * boundary only. Fail closed (null) if acquisition fails.
 */
const PINNED_OBJECT = Object;
const PINNED_IS_FROZEN = (() => {
  try {
    // eslint-disable-next-line global-require
    const vm = require('node:vm');
    if (!vm || typeof vm.runInNewContext !== 'function') return null;
    // Extract isFrozen from a fresh realm — never host Object.isFrozen.
    const isFrozen = vm.runInNewContext('Object.isFrozen');
    if (typeof isFrozen !== 'function') return null;
    // Self-check entirely inside the fresh realm (no host isFrozen).
    const selfOk = vm.runInNewContext(
      '(function(){var o={__gate3_frz:1};'
      + 'if(Object.isFrozen(o)!==false)return false;'
      + 'Object.freeze(o);'
      + 'return Object.isFrozen(o)===true;})()'
    );
    if (selfOk !== true) return null;
    // Cross-realm: host-mutable plain object must report false.
    if (isFrozen({ __gate3_host_mutable: 1 }) !== false) return null;
    return isFrozen;
  } catch {
    return null;
  }
})();

const crypto = require('crypto');
const http = require('http');
const util = require('util');
const {
  EMAIL_AUTHORITY_BOUND_OUTBOUND_RUNTIME_WIRED, EMAIL_AUTHORITY_BOUND_OUTBOUND_SAFE_FOR_RUNTIME_ROUTE,
  EMAIL_AUTHORITY_BOUND_OUTBOUND_PERSISTENCE_READY,
} = require('./email-authority-bound-outbound-operation');
const {
  validateOutboundReplySubject, resolveOutboundReplySubject, SQL_LAST_PERSISTED_SUBJECT,
} = require('./email-outbound-reply-subject');
const EMAIL_DRAFT_PATH = '/staff/inbox/email/draft';
const EMAIL_APPROVE_SEND_PATH = '/staff/inbox/email/approve-send';
const EMAIL_RECOVER_SEND_PATH = '/staff/inbox/email/recover-send';
const EMAIL_INBOX_MIN_ROLE = 'operator';
const ENV_DRAFTS_ENABLED = 'EMAIL_STAFF_EMAIL_DRAFTS_ENABLED';
const ENV_OUTBOUND_ENABLED = 'EMAIL_STAFF_OUTBOUND_ENABLED';
const ENV_SEND_ENABLED = 'EMAIL_OUTBOUND_SEND_ENABLED';
const ENV_COMPOSITION_ENABLED = 'EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED';
const ENV_PORTAL_ORIGIN = 'STAFF_PORTAL_ORIGIN';
const SEND_PUBLIC_CODES = Object.freeze([
  'email_send_committed', 'email_send_outcome_unknown', 'email_send_recovery',
  'email_send_reauthorization_required', 'email_send_unavailable',
]);
const BODY_KEYS = Object.freeze(['conversation_id', 'message_text', 'approval_id']);
const BODY_KEYS_UI = Object.freeze(['conversation_id', 'message_text', 'approval_id', 'subject', 'email_subject']);
const RECOVERY_BODY_KEYS = Object.freeze(['conversation_id', 'approval_id']);
const SUCCESS_DTO_KEYS = Object.freeze(['success', 'conversation_id', 'message_text', 'approval_id']);
const RECOVERY_SUCCESS_DTO_KEYS = Object.freeze(['success', 'conversation_id', 'approval_id', 'status']);
const BODY_MAX_BYTES = 10_240; // production shared readBody cap
const MESSAGE_MAX_BYTES = 8_000; // UTF-8 bytes; DTO always fits in BODY_MAX_BYTES
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);
const NOT_FOUND = Object.freeze({ success: false, error: 'not_found' });
const DRAFTS_UNAVAILABLE = Object.freeze({ success: false, error: 'email_drafts_unavailable' });
const STAFF_REPLIES_UNAVAILABLE = Object.freeze({ success: false, error: 'email_staff_replies_unavailable' });
const UNSUPPORTED_MEDIA = Object.freeze({ success: false, error: 'unsupported_media_type' });
const FORBIDDEN_ORIGIN = Object.freeze({ success: false, error: 'origin_forbidden' });
const INVALID_REQUEST = Object.freeze({ success: false, error: 'invalid_request' });
const APPROVAL_CONFLICT = Object.freeze({ success: false, error: 'approval_conflict' });
const BODY_MISMATCH = Object.freeze({ success: false, error: 'body_mismatch' });
const MAILBOX_NOT_SENDABLE = Object.freeze({ success: false, error: 'email_mailbox_not_sendable' });
if (EMAIL_AUTHORITY_BOUND_OUTBOUND_RUNTIME_WIRED !== false || EMAIL_AUTHORITY_BOUND_OUTBOUND_SAFE_FOR_RUNTIME_ROUTE !== false
    || EMAIL_AUTHORITY_BOUND_OUTBOUND_PERSISTENCE_READY !== false) throw new Error('staff_email_inbox_outbound_flags');
const PINNED_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_TYPES && typeof PINNED_TYPES.isProxy === 'function' ? PINNED_TYPES.isProxy : null;
const PINNED_REFLECT_APPLY = typeof Reflect.apply === 'function' ? Reflect.apply : null;
const PINNED_IM_PROTO = http.IncomingMessage && http.IncomingMessage.prototype ? http.IncomingMessage.prototype : null;
const PINNED_HDR_GET = (() => {
  if (!PINNED_IM_PROTO) return null;
  const d = Object.getOwnPropertyDescriptor(PINNED_IM_PROTO, 'headers');
  return d && typeof d.get === 'function' && !Object.prototype.hasOwnProperty.call(d, 'value') ? d.get : null;
})();
function isProxy(v) {
  try { return !PINNED_IS_PROXY || !PINNED_TYPES ? true : Reflect.apply(PINNED_IS_PROXY, PINNED_TYPES, [v]) === true; } catch { return true; }
}
/** Module-init-pinned genuine isFrozen only — never host/ambient Object.isFrozen. Fail closed. */
function pinnedIsFrozen(value) {
  try {
    if (!PINNED_IS_FROZEN || typeof PINNED_IS_FROZEN !== 'function' || !PINNED_REFLECT_APPLY) return false;
    // Call the fresh-realm intrinsic; do not re-resolve host Object.isFrozen.
    return PINNED_REFLECT_APPLY.call(Reflect, PINNED_IS_FROZEN, PINNED_OBJECT, [value]) === true;
  } catch {
    return false;
  }
}
function ownData(o, k) {
  try { const d = Object.getOwnPropertyDescriptor(o, k); return d && Object.prototype.hasOwnProperty.call(d, 'value') && !d.get && !d.set ? d.value : undefined; } catch { return undefined; }
}
function utf8Bytes(s) { try { return typeof s === 'string' ? Buffer.byteLength(s, 'utf8') : -1; } catch { return -1; } }
function readRequestHeaders(req) {
  try {
    if (isProxy(req) || !req || typeof req !== 'object') return undefined;
    if (PINNED_HDR_GET && PINNED_IM_PROTO && Object.getPrototypeOf(req) === PINNED_IM_PROTO
        && req.constructor === http.IncomingMessage) {
      const h = Reflect.apply(PINNED_HDR_GET, req, []);
      if (h && typeof h === 'object' && !Array.isArray(h)) return h;
    }
    return ownData(req, 'headers');
  } catch { return undefined; }
}
function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const want = name.toLowerCase(); const values = [];
  for (const k of Reflect.ownKeys(headers)) {
    if (typeof k !== 'string' || k.toLowerCase() !== want) continue;
    const d = Object.getOwnPropertyDescriptor(headers, k);
    if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set || !d.enumerable) return undefined;
    values.push(d.value);
  }
  return values.length === 1 && typeof values[0] === 'string' ? values[0] : undefined;
}
function isExactApplicationJson(ct) {
  if (typeof ct !== 'string' || !ct || ct.length > 128) return false;
  if (/[\x00-\x1f\x7f,]/.test(ct) || ct[0] === ' ' || ct[ct.length - 1] === ' ') return false;
  const m = /^application\/json(?:\s*;\s*charset=utf-8)?$/i.exec(ct);
  return !!m && !/"/.test(ct);
}
function validateJsonContentType(req) {
  const fail = Object.freeze({ ok: false, status: 415, body: UNSUPPORTED_MEDIA });
  try {
    const ct = headerValue(readRequestHeaders(req), 'content-type');
    return ct && isExactApplicationJson(ct) ? Object.freeze({ ok: true }) : fail;
  } catch { return fail; }
}
function normalizeConfiguredOrigin(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 512) return null;
  try {
    const u = new URL(raw.trim());
    if (u.username || u.password || u.search || u.hash) return null;
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol}//${u.host}`;
  } catch { return null; }
}
function exactOriginSerialization(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 512) return null;
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.search || u.hash) return null;
    if (u.pathname !== '' && u.pathname !== '/') return null;
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol}//${u.host}`;
  } catch { return null; }
}
function originFromReferer(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 512) return null;
  try {
    const u = new URL(raw.trim());
    if (u.username || u.password || u.search || u.hash) return null;
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol}//${u.host}`;
  } catch { return null; }
}
function configuredPortalOrigin(env) {
  const raw = ownData(env && typeof env === 'object' ? env : {}, ENV_PORTAL_ORIGIN);
  return typeof raw === 'string' ? normalizeConfiguredOrigin(raw) : null;
}
function validateSameOrigin(req, env) {
  const fail = Object.freeze({ ok: false, status: 403, body: FORBIDDEN_ORIGIN });
  try {
    const expected = configuredPortalOrigin(env);
    if (!expected) return fail;
    const headers = readRequestHeaders(req);
    const origin = headerValue(headers, 'origin');
    if (origin !== undefined && origin !== null && origin !== '') {
      const got = exactOriginSerialization(origin);
      return got && got === expected ? Object.freeze({ ok: true }) : fail;
    }
    const got = originFromReferer(headerValue(headers, 'referer') || '');
    return got && got === expected ? Object.freeze({ ok: true }) : fail;
  } catch { return fail; }
}
function envFlagTrue(env, key) { try { return ownData(env && typeof env === 'object' ? env : {}, key) === 'true'; } catch { return false; } }
function isEmailStaffDraftsEnabled(env) { return envFlagTrue(env, ENV_DRAFTS_ENABLED); }
function isEmailStaffOutboundEnabled(env) { return envFlagTrue(env, ENV_OUTBOUND_ENABLED); }
function isEmailOutboundSendEnabled(env) { return envFlagTrue(env, ENV_SEND_ENABLED); }
function isEmailOutboundRuntimeCompositionEnabled(env) { return envFlagTrue(env, ENV_COMPOSITION_ENABLED); }
function snapshotGateEnv(env) {
  const src = env && typeof env === 'object' ? env : {}; const out = Object.create(null);
  for (const k of [ENV_DRAFTS_ENABLED, ENV_OUTBOUND_ENABLED, ENV_SEND_ENABLED, ENV_COMPOSITION_ENABLED, ENV_PORTAL_ORIGIN]) {
    const v = ownData(src, k); if (typeof v === 'string') out[k] = v;
  }
  return Object.freeze(out);
}
function sealApprovedDispatchRequest(row, auth, actor, lockedOperationId, subject) {
  try {
    if (!row || !auth || !actor || typeof lockedOperationId !== 'string') return null;
    const sealed = {
      operation_id: lockedOperationId,
      approval_id: String(row.approval_id).toLowerCase(),
      message_text: String(row.message_text),
      client_id: auth.client_id,
      location_id: auth.location_id,
      location_key: auth.location_key,
      endpoint_id: auth.endpoint_id,
      conversation_id: auth.conversation_id,
      actor_staff_user_id: actor.staff_user_id,
      provider_mailbox_id: auth.provider_mailbox_id,
      provider_source_message_id: auth.provider_source_message_id,
    };
    if (typeof subject === 'string') sealed.subject = subject;
    return Object.freeze(sealed);
  } catch { return null; }
}
function mapDispatchToRoute(result, conversationId, approvalId) {
  const base = { conversation_id: conversationId, approval_id: approvalId, approval_state: 'approved' };
  try {
    const code = result && typeof result === 'object' ? ownData(result, 'code') : null;
    if (typeof code === 'string' && SEND_PUBLIC_CODES.includes(code)) {
      if (code === 'email_send_committed' && result.ok === true) {
        return { status: 200, body: Object.freeze({ success: true, ...base }), code, approved: true };
      }
      return { status: 503, body: Object.freeze({ success: false, error: code, ...base }), code, approved: true };
    }
  } catch { /* */ }
  return {
    status: 503,
    body: Object.freeze({ success: false, error: 'email_send_unavailable', ...base }),
    code: 'email_send_unavailable', approved: true,
  };
}
function parseUuid(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  return UUID_RE.test(t) && t === raw.trim().toLowerCase() ? t : null;
}
function bodyDigestOf(text) {
  try { if (typeof text !== 'string' || !crypto.createHash) return null; return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); } catch { return null; }
}
function mintUuid() { return String(crypto.randomUUID()).toLowerCase(); }
function exactPlainKeys(o, keys) {
  try {
    if (!o || typeof o !== 'object' || Array.isArray(o) || isProxy(o) || Object.getPrototypeOf(o) !== Object.prototype) return false;
    const actual = Reflect.ownKeys(o);
    if (actual.length !== keys.length) return false;
    return actual.every((k) => {
      if (typeof k !== 'string' || DANGEROUS.has(k) || !keys.includes(k)) return false;
      const d = Object.getOwnPropertyDescriptor(o, k);
      return !!(d && Object.prototype.hasOwnProperty.call(d, 'value') && d.enumerable && !d.get && !d.set);
    });
  } catch { return false; }
}
function snapshotEmailReplyBody(raw) {
  try {
    const isUi = exactPlainKeys(raw, BODY_KEYS_UI);
    const isLegacy = exactPlainKeys(raw, BODY_KEYS);
    if (!isUi && !isLegacy) return null;
    const conversationId = parseUuid(ownData(raw, 'conversation_id'));
    if (!conversationId) return null;
    const messageText = ownData(raw, 'message_text');
    if (typeof messageText !== 'string' || messageText.length < 1) return null;
    const msgBytes = utf8Bytes(messageText);
    if (msgBytes < 1 || msgBytes > MESSAGE_MAX_BYTES) return null;
    const approvalRaw = ownData(raw, 'approval_id');
    let approvalId = null;
    if (approvalRaw !== null) {
      approvalId = parseUuid(approvalRaw);
      if (!approvalId) return null;
    }
    const out = { conversation_id: conversationId, message_text: messageText, approval_id: approvalId };
    if (isUi) {
      const subjectRaw = ownData(raw, 'subject');
      const emailSubjectRaw = ownData(raw, 'email_subject');
      if (typeof subjectRaw !== 'string' || typeof emailSubjectRaw !== 'string') return null;
      if (isProxy(subjectRaw) || isProxy(emailSubjectRaw)) return null;
      if (subjectRaw !== emailSubjectRaw) return null;
      if (subjectRaw === '') {
        out.subject = null;
      } else {
        const checked = validateOutboundReplySubject(subjectRaw);
        if (!checked.ok) return null;
        out.subject = checked.value;
      }
    }
    return Object.freeze(out);
  } catch { return null; }
}
/** Authority-neutral recovery browser input: conversation_id + approval_id only. */
function snapshotRecoveryBody(raw) {
  try {
    if (!exactPlainKeys(raw, RECOVERY_BODY_KEYS)) return null;
    const conversationId = parseUuid(ownData(raw, 'conversation_id'));
    const approvalId = parseUuid(ownData(raw, 'approval_id'));
    if (!conversationId || !approvalId) return null;
    return Object.freeze({ conversation_id: conversationId, approval_id: approvalId });
  } catch { return null; }
}
function successDto(conversationId, messageText, approvalId) {
  return Object.freeze({ success: true, conversation_id: conversationId, message_text: messageText, approval_id: approvalId });
}
function recoverySuccessDto(conversationId, approvalId, status) {
  return Object.freeze({
    success: true,
    conversation_id: conversationId,
    approval_id: approvalId,
    status: status === 'committed' ? 'committed' : 'committed',
  });
}
function recoveryFailureDto(conversationId, approvalId, code) {
  const err = (typeof code === 'string' && SEND_PUBLIC_CODES.includes(code)) ? code
    : (code === 'email_send_disabled' ? 'email_send_disabled' : 'email_send_unavailable');
  const status = err === 'email_send_committed' ? 'committed'
    : (err === 'email_send_outcome_unknown' ? 'outcome_unknown'
      : (err === 'email_send_recovery' ? 'recovery'
        : (err === 'email_send_reauthorization_required' ? 'reauthorization_required'
          : (err === 'email_send_disabled' ? 'disabled' : 'unavailable'))));
  return Object.freeze({
    success: false,
    error: err,
    conversation_id: conversationId,
    approval_id: approvalId,
    status,
  });
}
const RECOVERY_DISPATCH_ACK_KEYS = Object.freeze(['ok', 'code']);
/**
 * Accept only frozen local owner acknowledgements:
 * exact own keys {ok, code}, own data descriptors only (no accessors /
 * inheritance / extras / Proxy), primitive boolean + public code string.
 * Reject Proxy via module-init-pinned isProxy before any field reflection.
 * Freeze check uses module-init-pinned *genuine* isFrozen only (fresh vm realm
 * via Reflect.apply); never reads host/ambient Object.isFrozen. Fail closed
 * if pin unavailable. Never evaluates result.ok directly.
 */
function acceptRecoveryDispatchAck(result) {
  try {
    if (result == null) return null;
    // Proxy rejection must precede getOwnPropertyDescriptor / ownKeys / reads.
    if (isProxy(result)) return null;
    if (typeof result !== 'object' || Array.isArray(result)) return null;
    // Genuine pinned isFrozen only — host pre/post-import always-true must not open committed.
    if (pinnedIsFrozen(result) !== true) return null;
    if (!exactPlainKeys(result, RECOVERY_DISPATCH_ACK_KEYS)) return null;
    const okVal = ownData(result, 'ok');
    const code = ownData(result, 'code');
    if (typeof okVal !== 'boolean') return null;
    if (typeof code !== 'string' || !SEND_PUBLIC_CODES.includes(code)) return null;
    return Object.freeze({ ok: okVal, code });
  } catch {
    return null;
  }
}
function mapRecoveryDispatch(result, conversationId, approvalId) {
  try {
    const ack = acceptRecoveryDispatchAck(result);
    if (ack) {
      if (ack.code === 'email_send_committed' && ack.ok === true) {
        return {
          status: 200,
          body: recoverySuccessDto(conversationId, approvalId, 'committed'),
          code: ack.code,
          approved: true,
        };
      }
      return {
        status: 503,
        body: recoveryFailureDto(conversationId, approvalId, ack.code),
        code: ack.code,
        approved: true,
      };
    }
  } catch { /* */ }
  return {
    status: 503,
    body: recoveryFailureDto(conversationId, approvalId, 'email_send_unavailable'),
    code: 'email_send_unavailable', approved: true,
  };
}
function parseInvocationCountText(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 1) return raw;
  if (typeof raw === 'string' && /^(0|1)$/.test(raw)) return Number(raw);
  return null;
}
function journalEligibleForRecovery(row) {
  try {
    if (!row || typeof row !== 'object') return Object.freeze({ ok: false, reason: 'missing' });
    const phase = ownData(row, 'phase');
    const outcome = ownData(row, 'outcome');
    const createC = parseInvocationCountText(ownData(row, 'create_invocation_count'));
    const updateC = parseInvocationCountText(ownData(row, 'update_invocation_count'));
    const sendC = parseInvocationCountText(ownData(row, 'send_invocation_count'));
    if (createC == null || updateC == null || sendC == null) return Object.freeze({ ok: false, reason: 'counts' });
    if (phase === 'create_dispatched' || phase === 'update_dispatched') {
      return Object.freeze({ ok: false, reason: 'frozen', code: 'email_send_recovery' });
    }
    if (phase === 'reconciled_sent' && outcome === 'committed' && createC === 1 && updateC === 1 && sendC === 1) {
      return Object.freeze({ ok: true, mode: 'already_committed' });
    }
    if (phase === 'send_dispatched' && outcome === 'outcome_unknown' && createC === 1 && updateC === 1 && sendC === 1) {
      return Object.freeze({ ok: true, mode: 'reconcile' });
    }
    return Object.freeze({ ok: false, reason: 'ineligible', code: 'email_send_recovery' });
  } catch {
    return Object.freeze({ ok: false, reason: 'error' });
  }
}
// Authority mailbox identity: endpoint.provider_resource_id (canonical Graph
// mailbox UUID from Phase B verified grant / OAuth /me.id bind). Event
// provider_mailbox_id must exact-match that resource id. Never equate
// public_address (sender config email) to Graph mailbox UUID. Current inbound
// delta state is operational cursor only — not required outbound identity.
const SQL_RESOLVE = `
SELECT c.id::text AS conversation_id, cl.id::text AS client_id, loc.id::text AS location_id,
  loc.location_id AS location_key, ep.id::text AS endpoint_id, ev.id::text AS source_inbound_event_id,
  ev.provider AS provider, ev.provider_mailbox_id AS provider_mailbox_id,
  ev.provider_message_id AS provider_source_message_id, ep.outbound_enabled AS endpoint_outbound_enabled,
  ep.public_address AS public_address, su.id::text AS actor_staff_user_id
FROM clients cl
INNER JOIN staff_users su ON su.client_id = cl.id AND su.id = $2::uuid
INNER JOIN conversations c ON c.client_id = cl.id AND c.id = $3::uuid
INNER JOIN tenant_email_inbound_inbox_projections p ON p.client_id = cl.id AND p.conversation_id = c.id
INNER JOIN tenant_email_inbound_events ev ON ev.client_id = p.client_id AND ev.id = p.inbound_event_id
  AND ev.location_id = p.location_id AND ev.endpoint_id = p.endpoint_id
  AND ev.provider = p.provider AND ev.provider_mailbox_id = p.provider_mailbox_id
  AND ev.provider_message_id = p.provider_message_id
INNER JOIN tenant_locations loc ON loc.client_id = ev.client_id AND loc.id = ev.location_id
INNER JOIN tenant_channel_endpoints ep ON ep.client_id = ev.client_id AND ep.id = ev.endpoint_id
  AND ep.location_id = loc.location_id
WHERE cl.id = $1::uuid AND su.status = 'active' AND su.role IN ('operator','admin','owner')
  AND c.phone ~ '^(emailv1|email):' AND ev.provider = 'microsoft_graph' AND ep.provider = 'microsoft_graph'
  AND ep.channel = 'email' AND ep.auth_mode = 'delegated_authorization_code'
  AND ep.connector_mode = 'microsoft_delegated_oauth' AND ep.mailbox_access_kind = 'own_user'
  AND ep.binding_status = 'verified' AND ep.public_address IS NOT NULL AND btrim(ep.public_address) <> ''
  AND ep.provider_resource_id IS NOT NULL AND btrim(ep.provider_resource_id) <> ''
  AND ep.provider_resource_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND ev.provider_mailbox_id = ep.provider_resource_id
ORDER BY ev.received_at DESC, ev.id DESC LIMIT 1 FOR UPDATE OF c,p,ev,ep`.replace(/\s+/g, ' ').trim();
const SQL_VISIBLE_EMAIL = `
SELECT c.id::text AS conversation_id
FROM conversations c
WHERE c.client_id = $1::uuid AND c.id = $2::uuid
  AND c.phone ~ '^(emailv1|email):'
LIMIT 1`.replace(/\s+/g, ' ').trim();
const SQL_INSERT_DRAFT = `
INSERT INTO tenant_email_reply_approvals (
  approval_id, operation_id, client_id, location_id, location_key, endpoint_id, conversation_id,
  source_inbound_event_id, provider, provider_mailbox_id, provider_source_message_id,
  draft_actor_staff_user_id, approved_actor_staff_user_id, message_text, body_digest, subject, state, drafted_at, approved_at
) VALUES (
  $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid,$7::uuid,$8::uuid,'microsoft_graph',$9,$10,$11::uuid,NULL,$12,$13,$14,'draft',NOW(),NULL
) RETURNING approval_id::text AS approval_id, message_text, conversation_id::text AS conversation_id, subject
`.replace(/\s+/g, ' ').trim();
const SQL_CAS_DRAFT = `
UPDATE tenant_email_reply_approvals
   SET message_text=$4, body_digest=$5, draft_actor_staff_user_id=$6::uuid, subject=$7
 WHERE approval_id=$1::uuid AND client_id=$2::uuid AND conversation_id=$3::uuid AND state='draft'
 RETURNING approval_id::text AS approval_id, message_text, conversation_id::text AS conversation_id, subject
`.replace(/\s+/g, ' ').trim();
const SQL_LOCK = `
SELECT approval_id::text AS approval_id, operation_id::text AS operation_id,
  client_id::text AS client_id, location_id::text AS location_id, location_key,
  endpoint_id::text AS endpoint_id, conversation_id::text AS conversation_id,
  source_inbound_event_id::text AS source_inbound_event_id, provider,
  provider_mailbox_id, provider_source_message_id, message_text, body_digest, subject, state
FROM tenant_email_reply_approvals
WHERE approval_id=$1::uuid AND client_id=$2::uuid AND conversation_id=$3::uuid FOR UPDATE
`.replace(/\s+/g, ' ').trim();
const SQL_APPROVE = `
UPDATE tenant_email_reply_approvals
   SET state='approved', approved_actor_staff_user_id=$5::uuid, approved_at=NOW()
 WHERE approval_id=$1::uuid AND client_id=$2::uuid AND conversation_id=$3::uuid
   AND operation_id=$4::uuid AND state='draft' AND message_text=$6 AND body_digest=$7
   AND subject IS NOT DISTINCT FROM $8
 RETURNING approval_id::text AS approval_id, conversation_id::text AS conversation_id, message_text, subject, state
`.replace(/\s+/g, ' ').trim();
const SQL_LOAD_APPROVAL = `
SELECT approval_id::text AS approval_id, operation_id::text AS operation_id,
  client_id::text AS client_id, location_id::text AS location_id, location_key,
  endpoint_id::text AS endpoint_id, conversation_id::text AS conversation_id,
  source_inbound_event_id::text AS source_inbound_event_id, provider,
  provider_mailbox_id, provider_source_message_id, message_text, body_digest, subject, state
FROM tenant_email_reply_approvals
WHERE approval_id=$1::uuid AND client_id=$2::uuid AND conversation_id=$3::uuid
`.replace(/\s+/g, ' ').trim();
/** Journal phase only — BIGINT counters returned as text; never select draft body/ids for HTTP. */
const SQL_JOURNAL_RECOVERY_PHASE = `
SELECT phase, outcome,
  create_invocation_count::text AS create_invocation_count,
  update_invocation_count::text AS update_invocation_count,
  send_invocation_count::text AS send_invocation_count
FROM tenant_email_outbound_send_journal
WHERE client_id=$1::uuid AND approval_id=$2::uuid AND operation_id=$3::uuid
  AND conversation_id=$4::uuid
LIMIT 1
`.replace(/\s+/g, ' ').trim();
/** Exact immutable-operation existence check used before approved initial dispatch. */
const SQL_JOURNAL_EXISTS = `
SELECT 1 AS journal_exists
FROM tenant_email_outbound_send_journal
WHERE client_id=$1::uuid AND approval_id=$2::uuid AND operation_id=$3::uuid
  AND conversation_id=$4::uuid
LIMIT 1
`.replace(/\s+/g, ' ').trim();
/**
 * Best-effort staff inbox thread mirror after Graph commit (body in message_text).
 * Atomic identity: partial unique index messages_staff_email_reply_approval_uq (072)
 * on (client_id, conversation_id, metadata->>'approval_id') for outbound
 * staff_email_reply/email rows only. ON CONFLICT DO NOTHING; RETURNING empty
 * means a concurrent/retried peer already inserted — do not rewrite preview.
 */
const SQL_INSERT_OUTBOUND_THREAD = `
INSERT INTO messages (
  client_id, conversation_id, direction, message_text, message_type,
  source, route, metadata
) VALUES (
  $1::uuid, $2::uuid, 'outbound', $3, 'email',
  'staff_email_reply', 'email', $4::jsonb
)
ON CONFLICT (client_id, conversation_id, ((metadata->>'approval_id')))
WHERE direction = 'outbound'
  AND source = 'staff_email_reply'
  AND route = 'email'
  AND (metadata->>'approval_id') IS NOT NULL
  AND (metadata->>'approval_id') <> ''
DO NOTHING
RETURNING id::text AS message_id
`.replace(/\s+/g, ' ').trim();
const SQL_TOUCH_OUTBOUND_PREVIEW = `
UPDATE conversations
   SET last_message_preview=$3, last_staff_reply_at=NOW(), updated_at=NOW()
 WHERE client_id=$1::uuid AND id=$2::uuid
`.replace(/\s+/g, ' ').trim();
function actorFromUser(user) {
  if (!user || typeof user !== 'object') return null;
  const sid = parseUuid(typeof user.staff_user_id === 'string' ? user.staff_user_id : null);
  const clientId = parseUuid(typeof user.client_id === 'string' ? user.client_id : null);
  const role = typeof user.role === 'string' ? user.role : null;
  return (sid && clientId && role && ['operator', 'admin', 'owner'].includes(role))
    ? Object.freeze({ staff_user_id: sid, client_id: clientId, role }) : null;
}
function auditSafe(appendAuditLog, fields) {
  if (typeof appendAuditLog !== 'function') return;
  try {
    const o = { ts: new Date().toISOString(), category: fields.category || 'email_inbox_reply', intent: fields.intent || 'api:inbox.email', success: fields.success === true };
    for (const k of ['code', 'approval_id', 'conversation_id', 'staff_user_id']) if (typeof fields[k] === 'string') o[k] = fields[k];
    if (typeof fields.elapsed_ms === 'number') o.elapsed_ms = fields.elapsed_ms;
    appendAuditLog(Object.freeze(o));
  } catch { /* */ }
}
function authorityMatchesApproval(auth, row) {
  try {
    return auth.client_id === String(row.client_id).toLowerCase()
      && auth.location_id === String(row.location_id).toLowerCase()
      && auth.location_key === String(row.location_key)
      && auth.endpoint_id === String(row.endpoint_id).toLowerCase()
      && auth.conversation_id === String(row.conversation_id).toLowerCase()
      && auth.source_inbound_event_id === String(row.source_inbound_event_id).toLowerCase()
      && auth.provider === String(row.provider)
      && auth.provider_mailbox_id === String(row.provider_mailbox_id)
      && auth.provider_source_message_id === String(row.provider_source_message_id);
  } catch { return false; }
}
function createStaffEmailInboxRoutes(deps) {
  if (!deps || typeof deps !== 'object') throw new Error('deps required');
  const { sendJSON, withPgClient, appendAuditLog } = deps;
  const readBody = typeof deps.readBody === 'function' ? deps.readBody : null;
  const outboundDispatch = typeof deps.outboundDispatch === 'function' ? deps.outboundDispatch : null;
  const createOutboundDispatch = typeof deps.createOutboundDispatch === 'function' ? deps.createOutboundDispatch : null;
  if (typeof sendJSON !== 'function' || typeof withPgClient !== 'function') throw new Error('deps required');
  async function readBoundedJsonBody(req) {
    try {
      let text;
      if (readBody) {
        const raw = await readBody(req, BODY_MAX_BYTES);
        text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
      } else {
        const chunks = []; let total = 0;
        await new Promise((resolve, reject) => {
          req.on('data', (c) => {
            total += c.length;
            if (total > BODY_MAX_BYTES) reject(new Error('body_too_large'));
            else chunks.push(c);
          });
          req.on('end', resolve); req.on('error', reject);
        });
        text = Buffer.concat(chunks).toString('utf8');
      }
      if (typeof text !== 'string') return { ok: false, status: 400, body: INVALID_REQUEST };
      if (utf8Bytes(text) > BODY_MAX_BYTES) return { ok: false, status: 400, body: INVALID_REQUEST };
      let parsed; try { parsed = JSON.parse(text); } catch { return { ok: false, status: 400, body: INVALID_REQUEST }; }
      const snap = snapshotEmailReplyBody(parsed);
      return snap ? { ok: true, body: snap } : { ok: false, status: 400, body: INVALID_REQUEST };
    } catch {
      return { ok: false, status: 400, body: INVALID_REQUEST };
    }
  }
  async function resolveAuthority(pg, actor, conversationId) {
    const res = await pg.query(SQL_RESOLVE, [actor.client_id, actor.staff_user_id, conversationId]);
    if (!res || !Array.isArray(res.rows) || res.rows.length !== 1 || !res.rows[0]) return null;
    const row = res.rows[0];
    return Object.freeze({
      client_id: String(row.client_id).toLowerCase(), location_id: String(row.location_id).toLowerCase(),
      location_key: String(row.location_key), endpoint_id: String(row.endpoint_id).toLowerCase(),
      conversation_id: String(row.conversation_id).toLowerCase(),
      source_inbound_event_id: String(row.source_inbound_event_id).toLowerCase(),
      provider: String(row.provider),
      provider_mailbox_id: String(row.provider_mailbox_id),
      provider_source_message_id: String(row.provider_source_message_id),
      endpoint_outbound_enabled: row.endpoint_outbound_enabled === true,
    });
  }
  async function resolveSendableAuthority(pg, actor, conversationId) {
    const auth = await resolveAuthority(pg, actor, conversationId);
    if (auth) return { auth };
    const visible = await pg.query(SQL_VISIBLE_EMAIL, [actor.client_id, conversationId]);
    if (visible && Array.isArray(visible.rows) && visible.rows.length === 1 && visible.rows[0]) {
      return { status: 409, body: MAILBOX_NOT_SENDABLE, code: 'email_mailbox_not_sendable' };
    }
    return { status: 404, body: NOT_FOUND, code: 'conversation_not_found' };
  }
  async function preflight(req, res, user, gateEnv, enabled, unavailableBody) {
    if (!enabled) { sendJSON(res, 404, unavailableBody || NOT_FOUND); return null; }
    const origin = validateSameOrigin(req, gateEnv);
    if (!origin.ok) { sendJSON(res, origin.status, origin.body); return null; }
    const ct = validateJsonContentType(req);
    if (!ct.ok) { sendJSON(res, ct.status, ct.body); return null; }
    const actor = actorFromUser(user);
    if (!actor) { sendJSON(res, 403, Object.freeze({ success: false, error: 'forbidden' })); return null; }
    const parsed = await readBoundedJsonBody(req);
    if (!parsed.ok) { sendJSON(res, parsed.status, parsed.body); return null; }
    const digest = bodyDigestOf(parsed.body.message_text);
    if (!digest) { sendJSON(res, 400, INVALID_REQUEST); return null; }
    return { actor, input: parsed.body, digest };
  }
  function hasExplicitSubjectOverride(input) {
    try {
      return Object.prototype.hasOwnProperty.call(input, 'subject')
        && typeof input.subject === 'string'
        && input.subject.length > 0;
    } catch {
      return false;
    }
  }
  async function loadLastPersistedSubject(pg, clientId, conversationId) {
    const res = await pg.query(SQL_LAST_PERSISTED_SUBJECT, [clientId, conversationId]);
    if (!res || !Array.isArray(res.rows) || res.rows.length !== 1 || !res.rows[0]) return null;
    const s = ownData(res.rows[0], 'subject');
    return typeof s === 'string' && s.trim() ? s : null;
  }
  function resolveSendSubject(input, lastSubject) {
    const overridePresent = hasExplicitSubjectOverride(input);
    return resolveOutboundReplySubject({
      overridePresent,
      override: overridePresent ? input.subject : undefined,
      lastSubject,
    });
  }
  async function resolvePersistedDraftSubject(pg, clientId, conversationId, input) {
    const lastSubject = hasExplicitSubjectOverride(input)
      ? null
      : await loadLastPersistedSubject(pg, clientId, conversationId);
    const resolved = resolveSendSubject(input, lastSubject);
    if (!resolved || resolved.ok !== true) {
      const err = new Error('subject_resolve_failed');
      err.code = 'subject_invalid';
      throw err;
    }
    return resolved.value;
  }
  async function persistNewDraftThroughStaffOwner(pg, a, body, digest, expectedAuthority) {
    const resolved = await resolveSendableAuthority(pg, a, body.conversation_id);
    if (!resolved.auth) return resolved;
    const auth = resolved.auth;
    if (expectedAuthority && !authorityMatchesExpected(auth, expectedAuthority)) {
      return { status: 409, body: Object.freeze({ success: false, error: 'stale_authority' }), code: 'stale_authority' };
    }
    const subject = await resolvePersistedDraftSubject(pg, auth.client_id, auth.conversation_id, body);
    const approvalId = mintUuid(); const operationId = mintUuid();
    const ins = await pg.query(SQL_INSERT_DRAFT, [approvalId, operationId, auth.client_id, auth.location_id,
      auth.location_key, auth.endpoint_id, auth.conversation_id, auth.source_inbound_event_id,
      auth.provider_mailbox_id, auth.provider_source_message_id, a.staff_user_id, body.message_text, digest, subject]);
    if (!ins || !ins.rows || ins.rows.length !== 1) {
      return { status: 500, body: Object.freeze({ success: false, error: 'draft_failed' }), code: 'draft_insert_failed' };
    }
    const row = ins.rows[0];
    return { status: 200, body: successDto(row.conversation_id, row.message_text, row.approval_id), code: 'draft_created', approval_id: row.approval_id };
  }
  async function persistUpdatedDraftThroughStaffOwner(pg, a, body, digest) {
    const resolved = await resolveSendableAuthority(pg, a, body.conversation_id);
    if (!resolved.auth) return resolved;
    const auth = resolved.auth;
    const subject = await resolvePersistedDraftSubject(pg, auth.client_id, auth.conversation_id, body);
    const upd = await pg.query(SQL_CAS_DRAFT, [
      body.approval_id, a.client_id, body.conversation_id, body.message_text, digest, a.staff_user_id,
      subject,
    ]);
    if (!upd || !upd.rows || upd.rows.length !== 1) {
      return { status: 409, body: APPROVAL_CONFLICT, code: 'draft_cas_miss' };
    }
    const row = upd.rows[0];
    return { status: 200, body: successDto(row.conversation_id, row.message_text, row.approval_id), code: 'draft_updated', approval_id: row.approval_id };
  }
  function authorityMatchesExpected(auth, expected) {
    const keys = ['client_id', 'location_id', 'location_key', 'endpoint_id', 'conversation_id',
      'source_inbound_event_id', 'provider', 'provider_mailbox_id', 'provider_source_message_id'];
    try { return keys.every((key) => Object.hasOwn(expected, key) && expected[key] === auth[key]); } catch { return false; }
  }
  async function handleDraft(req, res, user, gateEnv) {
    const started = Date.now();
    const env = gateEnv || snapshotGateEnv(deps.runtimeEnv || process.env);
    let pre;
    try { pre = await preflight(req, res, user, env, isEmailStaffDraftsEnabled(env), DRAFTS_UNAVAILABLE); }
    catch {
      auditSafe(appendAuditLog, { intent: 'api:inbox.email.draft', category: 'email_inbox_draft', success: false, code: 'draft_error' });
      return sendJSON(res, 500, Object.freeze({ success: false, error: 'draft_failed' }));
    }
    if (!pre) return;
    const { actor, input, digest } = pre;
    try {
      const result = await withPgClient(async (pg) => {
        await pg.query('BEGIN');
        try {
          const persisted = input.approval_id == null
            ? await persistNewDraftThroughStaffOwner(pg, actor, input, digest, null)
            : await persistUpdatedDraftThroughStaffOwner(pg, actor, input, digest);
          if (persisted.status !== 200) {
            await pg.query('ROLLBACK');
            return persisted;
          }
          await pg.query('COMMIT');
          return persisted;
        } catch (error) {
          try { await pg.query('ROLLBACK'); } catch { /* preserve original error */ }
          throw error;
        }
      });
      auditSafe(appendAuditLog, { intent: 'api:inbox.email.draft', category: 'email_inbox_draft', success: result.status === 200,
        code: result.code, approval_id: result.approval_id, conversation_id: input.conversation_id,
        staff_user_id: actor.staff_user_id, elapsed_ms: Date.now() - started });
      return sendJSON(res, result.status, result.body);
    } catch (_err) {
      auditSafe(appendAuditLog, { intent: 'api:inbox.email.draft', category: 'email_inbox_draft', success: false, code: 'draft_error',
        conversation_id: input.conversation_id, staff_user_id: actor.staff_user_id, elapsed_ms: Date.now() - started });
      return sendJSON(res, 500, Object.freeze({ success: false, error: 'draft_failed' }));
    }
  }
  /** Best-effort: durable staff-visible outbound body after Graph commit. */
  async function mirrorCommittedOutboundThread(actor, conversationId, approvalId, messageText, subject) {
    try {
      if (!actor || !conversationId || !approvalId || typeof messageText !== 'string' || !messageText.length) return;
      await withPgClient(async (pg) => {
        const preview = messageText.slice(0, 500);
        const meta = {
          channel: 'email',
          approval_id: String(approvalId).toLowerCase(),
          send_kind: 'staff_email_reply',
        };
        if (typeof subject === 'string') meta.email_subject = subject;
        const inserted = await pg.query(SQL_INSERT_OUTBOUND_THREAD, [
          actor.client_id,
          conversationId,
          messageText,
          JSON.stringify(meta),
        ]);
        // Preview/timestamp only when this invocation won the insert (RETURNING).
        if (!inserted || !Array.isArray(inserted.rows) || inserted.rows.length !== 1) return;
        await pg.query(SQL_TOUCH_OUTBOUND_PREVIEW, [actor.client_id, conversationId, preview]);
      });
    } catch { /* non-authoritative after provider commit */ }
  }
  /** Shared authoritative new-draft persistence owner for manual and Luna routes. */
  async function saveDraftThroughStaffOwner(input) {
    const a = input && input.actor;
    const raw = input && {
      conversation_id: input.conversation_id,
      message_text: input.message_text,
      approval_id: input.approval_id,
    };
    if (raw && input && (Object.prototype.hasOwnProperty.call(input, 'subject')
        || Object.prototype.hasOwnProperty.call(input, 'email_subject'))) {
      raw.subject = input.subject;
      raw.email_subject = Object.prototype.hasOwnProperty.call(input, 'email_subject')
        ? input.email_subject : input.subject;
    }
    const body = snapshotEmailReplyBody(raw);
    if (!a || !body || body.approval_id !== null) throw new Error('invalid draft owner input');
    const digest = bodyDigestOf(body.message_text);
    return withPgClient(async (pg) => {
      await pg.query('BEGIN');
      try {
        const result = await persistNewDraftThroughStaffOwner(pg, a, body, digest, input.expected_authority || null);
        if (result.status !== 200) {
          await pg.query('ROLLBACK');
          return Object.freeze({
            status: 'not_saved',
            conversation_id: body.conversation_id,
            approval_id: null,
            code: typeof result.code === 'string' ? result.code : 'draft_failed',
          });
        }
        await pg.query('COMMIT');
        return Object.freeze({ status: 'saved', conversation_id: body.conversation_id, approval_id: result.approval_id });
      } catch (error) {
        try { await pg.query('ROLLBACK'); } catch { /* preserve original error */ }
        throw error;
      }
    });
  }
  async function executeApproveAndDispatch(pg, actor, input, digest, env) {
    let began = false;
    try { await pg.query('BEGIN'); began = true; } catch { began = false; }
    try {
      const approvalId = input.approval_id;
      const locked = await pg.query(SQL_LOCK, [approvalId, actor.client_id, input.conversation_id]);
      if (!locked || !locked.rows || locked.rows.length !== 1) {
        if (began) await pg.query('ROLLBACK');
        return { status: 404, body: NOT_FOUND, code: 'approval_not_found' };
      }
      const row = locked.rows[0];
      if (row.state !== 'draft' && row.state !== 'approved') {
        if (began) await pg.query('ROLLBACK');
        return { status: 409, body: APPROVAL_CONFLICT, code: 'approval_not_dispatchable' };
      }
      if (row.message_text !== input.message_text || row.body_digest !== digest) {
        if (began) await pg.query('ROLLBACK');
        return { status: 409, body: BODY_MISMATCH, code: 'body_mismatch' };
      }
      const lockedSubject = (row.subject == null || row.subject === '') ? null : String(row.subject);
      if (hasExplicitSubjectOverride(input) && input.subject !== lockedSubject) {
        if (began) await pg.query('ROLLBACK');
        return { status: 409, body: BODY_MISMATCH, code: 'body_mismatch' };
      }
      const resolved = await resolveSendableAuthority(pg, actor, input.conversation_id);
      if (!resolved.auth) {
        if (began) await pg.query('ROLLBACK');
        return resolved;
      }
      const auth = resolved.auth;
      if (!authorityMatchesApproval(auth, row)) {
        if (began) await pg.query('ROLLBACK');
        return { status: 409, body: APPROVAL_CONFLICT, code: 'authority_drift' };
      }
      // Kill switch: bound endpoint outbound must be true before durable approve CAS.
      if (auth.endpoint_outbound_enabled !== true) {
        if (began) await pg.query('ROLLBACK');
        return { status: 503, body: Object.freeze({ success: false, error: 'email_send_disabled', conversation_id: input.conversation_id, approval_id: approvalId, approval_state: 'draft' }),
          code: 'email_send_disabled', approval_id: approvalId, approved: false };
      }
      const sendSubject = lockedSubject;
      const lockedOperationId = parseUuid(typeof row.operation_id === 'string' ? row.operation_id : null);
      if (!lockedOperationId) {
        if (began) await pg.query('ROLLBACK');
        return { status: 409, body: APPROVAL_CONFLICT, code: 'approve_operation_missing' };
      }
      if (row.state === 'approved') {
        // Dispatch an approved record here only if this immutable operation
        // has never entered the journal. Any row or malformed result closes.
        const journal = await pg.query(SQL_JOURNAL_EXISTS, [
          actor.client_id, approvalId, lockedOperationId, input.conversation_id,
        ]);
        if (!journal || !Array.isArray(journal.rows) || journal.rows.length !== 0) {
          if (began) await pg.query('ROLLBACK');
          return { status: 409, body: APPROVAL_CONFLICT, code: 'approved_operation_already_dispatched' };
        }
      } else {
        const approved = await pg.query(SQL_APPROVE, [
          approvalId, actor.client_id, input.conversation_id, lockedOperationId,
          actor.staff_user_id, input.message_text, digest, sendSubject,
        ]);
        if (!approved || !approved.rows || approved.rows.length !== 1) {
          if (began) await pg.query('ROLLBACK');
          return { status: 409, body: APPROVAL_CONFLICT, code: 'approve_cas_miss' };
        }
        row.state = 'approved';
      }
      if (began) await pg.query('COMMIT');
      // Post-COMMIT only. Global send + composition flags independently required.
      // Hard-false owner constants remain; no token/Graph when either flag is off.
      const sendEnabled = isEmailOutboundSendEnabled(env);
      const compositionEnabled = isEmailOutboundRuntimeCompositionEnabled(env);
      if (!sendEnabled || !compositionEnabled) {
        return { status: 503, body: Object.freeze({ success: false, error: 'email_send_disabled', conversation_id: input.conversation_id, approval_id: approvalId, approval_state: 'approved' }),
          code: 'email_send_disabled', approval_id: approvalId, approved: true };
      }
      const sealed = sealApprovedDispatchRequest(row, auth, actor, lockedOperationId, sendSubject);
      if (!sealed) {
        return { status: 503, body: Object.freeze({ success: false, error: 'email_send_unavailable', conversation_id: input.conversation_id, approval_id: approvalId, approval_state: 'approved' }),
          code: 'email_send_unavailable', approval_id: approvalId, approved: true };
      }
      let dispatchResult = null;
      // Full runtime env for owner pins (gateEnv is flag snapshot only).
      const compositionEnv = deps.runtimeEnv || process.env;
      if (typeof createOutboundDispatch === 'function') {
        // Lazy construction on pinned post-COMMIT client; never release here.
        try {
          const surface = createOutboundDispatch(pg, compositionEnv);
          if (!surface || typeof surface.dispatchApprovedOutbound !== 'function') {
            return { status: 503, body: Object.freeze({ success: false, error: 'email_send_unavailable', conversation_id: input.conversation_id, approval_id: approvalId, approval_state: 'approved' }),
              code: 'email_send_unavailable', approval_id: approvalId, approved: true };
          }
          dispatchResult = await surface.dispatchApprovedOutbound(sealed);
        } catch {
          return { status: 503, body: Object.freeze({ success: false, error: 'email_send_unavailable', conversation_id: input.conversation_id, approval_id: approvalId, approval_state: 'approved' }),
            code: 'email_send_unavailable', approval_id: approvalId, approved: true };
        }
      } else if (typeof outboundDispatch === 'function') {
        dispatchResult = await outboundDispatch(sealed);
      } else {
        return { status: 503, body: Object.freeze({ success: false, error: 'email_send_disabled', conversation_id: input.conversation_id, approval_id: approvalId, approval_state: 'approved' }),
          code: 'email_send_disabled_unreachable', approval_id: approvalId, approved: true };
      }
      const mapped = mapDispatchToRoute(dispatchResult, input.conversation_id, approvalId);
      return {
        ...mapped,
        approval_id: approvalId,
        send_subject: sendSubject,
        message_text: row.message_text,
        journaled: true,
        provider_invoked: true,
      };
    } catch (err) {
      if (began) { try { await pg.query('ROLLBACK'); } catch { /* */ } }
      throw err;
    }
  }
  async function approveAndDispatchEmailOutbound(input) {
    const a = input && input.actor;
    const raw = input && {
      conversation_id: input.conversation_id,
      message_text: input.message_text,
      approval_id: input.approval_id,
    };
    if (raw && input && (Object.prototype.hasOwnProperty.call(input, 'subject')
        || Object.prototype.hasOwnProperty.call(input, 'email_subject'))) {
      raw.subject = input.subject;
      raw.email_subject = Object.prototype.hasOwnProperty.call(input, 'email_subject')
        ? input.email_subject : input.subject;
    }
    const body = snapshotEmailReplyBody(raw);
    if (!a || !body || body.approval_id == null) throw new Error('invalid approve owner input');
    const digest = bodyDigestOf(body.message_text);
    const env = input.env || snapshotGateEnv(deps.runtimeEnv || process.env);
    const result = await withPgClient(async (pg) => executeApproveAndDispatch(pg, a, body, digest, env));
    const deliveryCommitted = result.code === 'email_send_committed'
      && result.status === 200
      && result.body
      && result.body.success === true;
    if (deliveryCommitted === true) {
      await mirrorCommittedOutboundThread(
        a,
        body.conversation_id,
        result.approval_id,
        typeof result.message_text === 'string' ? result.message_text : body.message_text,
        result.send_subject,
      );
    }
    return result;
  }
  async function handleApproveSend(req, res, user, gateEnv) {
    const started = Date.now();
    const env = gateEnv || snapshotGateEnv(deps.runtimeEnv || process.env);
    let pre;
    try { pre = await preflight(req, res, user, env, isEmailStaffOutboundEnabled(env), STAFF_REPLIES_UNAVAILABLE); }
    catch {
      auditSafe(appendAuditLog, { intent: 'api:inbox.email.approve_send', category: 'email_inbox_approve_send', success: false, code: 'approve_error' });
      return sendJSON(res, 500, Object.freeze({ success: false, error: 'approve_failed' }));
    }
    if (!pre) return;
    const { actor, input, digest } = pre;
    if (input.approval_id == null) {
      auditSafe(appendAuditLog, {
        intent: 'api:inbox.email.approve_send', category: 'email_inbox_approve_send',
        success: false, code: 'approval_id_required', conversation_id: input.conversation_id,
        staff_user_id: actor.staff_user_id, elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 400, INVALID_REQUEST);
    }
    try {
      const result = await withPgClient(async (pg) => executeApproveAndDispatch(pg, actor, input, digest, env));
      // Audit success only for exact committed delivery — not mere approval persistence.
      const deliveryCommitted = result.code === 'email_send_committed'
        && result.status === 200
        && result.body
        && result.body.success === true;
      if (deliveryCommitted === true) {
        await mirrorCommittedOutboundThread(
          actor,
          input.conversation_id,
          result.approval_id,
          typeof result.message_text === 'string' ? result.message_text : input.message_text,
          result.send_subject,
        );
      }
      auditSafe(appendAuditLog, { intent: 'api:inbox.email.approve_send', category: 'email_inbox_approve_send',
        success: deliveryCommitted === true, code: result.code, approval_id: result.approval_id || input.approval_id,
        conversation_id: input.conversation_id, staff_user_id: actor.staff_user_id, elapsed_ms: Date.now() - started });
      return sendJSON(res, result.status, result.body);
    } catch (_err) {
      auditSafe(appendAuditLog, { intent: 'api:inbox.email.approve_send', category: 'email_inbox_approve_send', success: false,
        code: 'approve_error', conversation_id: input.conversation_id, approval_id: input.approval_id,
        staff_user_id: actor.staff_user_id, elapsed_ms: Date.now() - started });
      return sendJSON(res, 500, Object.freeze({ success: false, error: 'approve_failed' }));
    }
  }
  async function readRecoveryBody(req) {
    try {
      let text;
      if (readBody) {
        const raw = await readBody(req, BODY_MAX_BYTES);
        text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
      } else {
        const chunks = []; let total = 0;
        await new Promise((resolve, reject) => {
          req.on('data', (c) => {
            total += c.length;
            if (total > BODY_MAX_BYTES) reject(new Error('body_too_large'));
            else chunks.push(c);
          });
          req.on('end', resolve); req.on('error', reject);
        });
        text = Buffer.concat(chunks).toString('utf8');
      }
      if (typeof text !== 'string') return { ok: false, status: 400, body: INVALID_REQUEST };
      if (utf8Bytes(text) > BODY_MAX_BYTES) return { ok: false, status: 400, body: INVALID_REQUEST };
      let parsed; try { parsed = JSON.parse(text); } catch { return { ok: false, status: 400, body: INVALID_REQUEST }; }
      const snap = snapshotRecoveryBody(parsed);
      return snap ? { ok: true, body: snap } : { ok: false, status: 400, body: INVALID_REQUEST };
    } catch {
      return { ok: false, status: 400, body: INVALID_REQUEST };
    }
  }
  /**
   * Staff-safe recovery for already-approved operations in send_dispatched/outcome_unknown.
   * Browser input: conversation_id + approval_id only. Server derives authority + operation facts.
   * Only dispatchApprovedOutbound reconcile-only path for send_dispatched; never second create/update/send.
   */
  async function handleRecoverSend(req, res, user, gateEnv) {
    const started = Date.now();
    const env = gateEnv || snapshotGateEnv(deps.runtimeEnv || process.env);
    if (!isEmailStaffOutboundEnabled(env)) {
      sendJSON(res, 404, STAFF_REPLIES_UNAVAILABLE);
      return;
    }
    const origin = validateSameOrigin(req, env);
    if (!origin.ok) { sendJSON(res, origin.status, origin.body); return; }
    const ct = validateJsonContentType(req);
    if (!ct.ok) { sendJSON(res, ct.status, ct.body); return; }
    const actor = actorFromUser(user);
    if (!actor) { sendJSON(res, 403, Object.freeze({ success: false, error: 'forbidden' })); return; }
    let input;
    try {
      const parsed = await readRecoveryBody(req);
      if (!parsed.ok) { sendJSON(res, parsed.status, parsed.body); return; }
      input = parsed.body;
    } catch {
      auditSafe(appendAuditLog, {
        intent: 'api:inbox.email.recover_send', category: 'email_inbox_recover_send',
        success: false, code: 'recover_error', staff_user_id: actor.staff_user_id,
      });
      return sendJSON(res, 500, Object.freeze({ success: false, error: 'recover_failed' }));
    }
    try {
      const result = await withPgClient(async (pg) => {
        const resolved = await resolveSendableAuthority(pg, actor, input.conversation_id);
        if (!resolved.auth) return resolved;
        const auth = resolved.auth;
        const loaded = await pg.query(SQL_LOAD_APPROVAL, [input.approval_id, actor.client_id, input.conversation_id]);
        if (!loaded || !loaded.rows || loaded.rows.length !== 1) {
          return { status: 404, body: NOT_FOUND, code: 'approval_not_found' };
        }
        const row = loaded.rows[0];
        if (row.state !== 'approved') {
          return { status: 409, body: APPROVAL_CONFLICT, code: 'approval_not_approved' };
        }
        if (!authorityMatchesApproval(auth, row)) {
          return { status: 409, body: APPROVAL_CONFLICT, code: 'authority_drift' };
        }
        if (auth.endpoint_outbound_enabled !== true) {
          return {
            status: 503,
            body: recoveryFailureDto(input.conversation_id, input.approval_id, 'email_send_disabled'),
            code: 'email_send_disabled',
            approval_id: input.approval_id,
          };
        }
        const lockedOperationId = parseUuid(typeof row.operation_id === 'string' ? row.operation_id : null);
        if (!lockedOperationId) {
          return { status: 409, body: APPROVAL_CONFLICT, code: 'recover_operation_missing' };
        }
        const journalRes = await pg.query(SQL_JOURNAL_RECOVERY_PHASE, [
          actor.client_id, input.approval_id, lockedOperationId, input.conversation_id,
        ]);
        if (!journalRes || !Array.isArray(journalRes.rows) || journalRes.rows.length !== 1) {
          return {
            status: 503,
            body: recoveryFailureDto(input.conversation_id, input.approval_id, 'email_send_recovery'),
            code: 'email_send_recovery',
            approval_id: input.approval_id,
          };
        }
        const eligibility = journalEligibleForRecovery(journalRes.rows[0]);
        if (!eligibility.ok) {
          const code = eligibility.code || 'email_send_recovery';
          return {
            status: 503,
            body: recoveryFailureDto(input.conversation_id, input.approval_id, code),
            code,
            approval_id: input.approval_id,
          };
        }
        const lockedSubject = (row.subject == null || row.subject === '') ? null : String(row.subject);
        const lockedMessage = typeof row.message_text === 'string' ? row.message_text : null;
        if (eligibility.mode === 'already_committed') {
          return {
            status: 200,
            body: recoverySuccessDto(input.conversation_id, input.approval_id, 'committed'),
            code: 'email_send_committed',
            approval_id: input.approval_id,
            send_subject: lockedSubject,
            message_text: lockedMessage,
          };
        }
        // send_dispatched reconcile-only via existing dispatchApprovedOutbound path.
        const sendEnabled = isEmailOutboundSendEnabled(env);
        const compositionEnabled = isEmailOutboundRuntimeCompositionEnabled(env);
        if (!sendEnabled || !compositionEnabled) {
          return {
            status: 503,
            body: recoveryFailureDto(input.conversation_id, input.approval_id, 'email_send_disabled'),
            code: 'email_send_disabled',
            approval_id: input.approval_id,
          };
        }
        const sealed = sealApprovedDispatchRequest(row, auth, actor, lockedOperationId, lockedSubject);
        if (!sealed) {
          return {
            status: 503,
            body: recoveryFailureDto(input.conversation_id, input.approval_id, 'email_send_unavailable'),
            code: 'email_send_unavailable',
            approval_id: input.approval_id,
          };
        }
        const compositionEnv = deps.runtimeEnv || process.env;
        let dispatchResult = null;
        if (typeof createOutboundDispatch === 'function') {
          try {
            const surface = createOutboundDispatch(pg, compositionEnv);
            if (!surface || typeof surface.dispatchApprovedOutbound !== 'function') {
              return {
                status: 503,
                body: recoveryFailureDto(input.conversation_id, input.approval_id, 'email_send_unavailable'),
                code: 'email_send_unavailable',
                approval_id: input.approval_id,
              };
            }
            dispatchResult = await surface.dispatchApprovedOutbound(sealed);
          } catch {
            return {
              status: 503,
              body: recoveryFailureDto(input.conversation_id, input.approval_id, 'email_send_unavailable'),
              code: 'email_send_unavailable',
              approval_id: input.approval_id,
            };
          }
        } else if (typeof outboundDispatch === 'function') {
          dispatchResult = await outboundDispatch(sealed);
        } else {
          return {
            status: 503,
            body: recoveryFailureDto(input.conversation_id, input.approval_id, 'email_send_disabled'),
            code: 'email_send_disabled',
            approval_id: input.approval_id,
          };
        }
        const mapped = mapRecoveryDispatch(dispatchResult, input.conversation_id, input.approval_id);
        return {
          ...mapped,
          approval_id: input.approval_id,
          send_subject: lockedSubject,
          message_text: lockedMessage,
        };
      });
      const deliveryCommitted = result.code === 'email_send_committed'
        && result.status === 200
        && result.body
        && result.body.success === true;
      if (deliveryCommitted === true && typeof result.message_text === 'string') {
        await mirrorCommittedOutboundThread(
          actor,
          input.conversation_id,
          result.approval_id || input.approval_id,
          result.message_text,
          result.send_subject,
        );
      }
      auditSafe(appendAuditLog, {
        intent: 'api:inbox.email.recover_send', category: 'email_inbox_recover_send',
        success: deliveryCommitted === true, code: result.code,
        approval_id: result.approval_id || input.approval_id,
        conversation_id: input.conversation_id, staff_user_id: actor.staff_user_id,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, result.status, result.body);
    } catch (_err) {
      auditSafe(appendAuditLog, {
        intent: 'api:inbox.email.recover_send', category: 'email_inbox_recover_send', success: false,
        code: 'recover_error', conversation_id: input.conversation_id, approval_id: input.approval_id,
        staff_user_id: actor.staff_user_id, elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 500, Object.freeze({ success: false, error: 'recover_failed' }));
    }
  }
  return Object.freeze({
    EMAIL_DRAFT_PATH, EMAIL_APPROVE_SEND_PATH, EMAIL_RECOVER_SEND_PATH, EMAIL_INBOX_MIN_ROLE,
    handleDraft, handleApproveSend, handleRecoverSend, saveDraftThroughStaffOwner,
    approveAndDispatchEmailOutbound,
  });
}
module.exports = {
  EMAIL_DRAFT_PATH, EMAIL_APPROVE_SEND_PATH, EMAIL_RECOVER_SEND_PATH, EMAIL_INBOX_MIN_ROLE,
  ENV_DRAFTS_ENABLED, ENV_OUTBOUND_ENABLED, ENV_SEND_ENABLED, ENV_COMPOSITION_ENABLED, ENV_PORTAL_ORIGIN,
  BODY_KEYS, BODY_KEYS_UI, RECOVERY_BODY_KEYS, SUCCESS_DTO_KEYS, RECOVERY_SUCCESS_DTO_KEYS,
  BODY_MAX_BYTES, MESSAGE_MAX_BYTES, SEND_PUBLIC_CODES,
  SQL_RESOLVE, SQL_VISIBLE_EMAIL, SQL_APPROVE, SQL_LOAD_APPROVAL, SQL_JOURNAL_RECOVERY_PHASE, SQL_JOURNAL_EXISTS,
  createStaffEmailInboxRoutes,
  isEmailStaffDraftsEnabled, isEmailStaffOutboundEnabled, isEmailOutboundSendEnabled,
  isEmailOutboundRuntimeCompositionEnabled,
  snapshotGateEnv, snapshotEmailReplyBody, snapshotRecoveryBody, validateJsonContentType, validateSameOrigin,
  isExactApplicationJson, bodyDigestOf, exactOriginSerialization, normalizeConfiguredOrigin,
  sealApprovedDispatchRequest, mapDispatchToRoute, mapRecoveryDispatch, journalEligibleForRecovery,
};
