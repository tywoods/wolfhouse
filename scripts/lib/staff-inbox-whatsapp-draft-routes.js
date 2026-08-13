/**
 * WhatsApp outbound draft persist + read (Inbox Phase 2 smallest backend slice).
 *
 *   POST /staff/inbox/whatsapp/draft  — operator; store/update the pending draft
 *   GET  /staff/inbox/whatsapp/draft?conversation_id=  — operator; read pending
 *
 * Auth is NOT enforced here. The Staff API router must call requireAuth with
 * the minRole from WHATSAPP_DRAFT_ROUTE_TABLE before dispatching; handlers then
 * apply assertStaffClientAccess and resolve the conversation under the actor's
 * home tenant (same fail-closed join as email draft: clients.id = user.client_id).
 *
 * No approve-send. GET is SELECT-only. This module must not call Graph, Meta
 * Cloud, or evaluateGuestReplySendRouteWithPause. Email continue to use
 * /staff/inbox/email/draft and tenant_email_reply_approvals.
 *
 * Storage: luna_outbound_approvals (migration 078). Do not write
 * conversations.staff_reply_draft and do not change the thread composite payload.
 *
 * @module staff-inbox-whatsapp-draft-routes
 */

'use strict';

const crypto = require('crypto');
const { isEmailChannelPhoneNamespace } = require('./luna-staff-inbox-send-reply');

const WHATSAPP_DRAFT_PATH = '/staff/inbox/whatsapp/draft';
const WHATSAPP_DRAFT_CHANNEL = 'whatsapp';
const WHATSAPP_DRAFT_MIN_ROLE = 'operator';
const WHATSAPP_DRAFT_STATUS_PENDING = 'pending';

const POST_BODY_KEYS = Object.freeze(['conversation_id', 'draft_text', 'client_slug']);
const POST_REQUIRED_KEYS = Object.freeze(['conversation_id', 'draft_text']);
const GET_SUCCESS_DTO_KEYS = Object.freeze([
  'success',
  'conversation_id',
  'channel',
  'draft_available',
  'approval_id',
  'draft_text',
  'edited_text',
  'status',
  'tool_trace',
  'created_by_run_id',
]);
const POST_SUCCESS_DTO_KEYS = Object.freeze([
  'success',
  'conversation_id',
  'channel',
  'approval_id',
  'draft_text',
  'status',
]);

const BODY_MAX_BYTES = 10_240;
const DRAFT_MAX_BYTES = 8_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);
const OPERATOR_ROLES = Object.freeze(['operator', 'admin', 'owner']);

const NOT_FOUND = Object.freeze({ success: false, error: 'not_found' });
const FORBIDDEN = Object.freeze({ success: false, error: 'forbidden' });
const INVALID_REQUEST = Object.freeze({ success: false, error: 'invalid_request' });
const UNSUPPORTED_MEDIA = Object.freeze({ success: false, error: 'unsupported_media_type' });
const EMAIL_CHANNEL_NOT_SUPPORTED = Object.freeze({
  success: false,
  error: 'email_channel_not_supported',
});
const DRAFT_FAILED = Object.freeze({ success: false, error: 'draft_failed' });

const WHATSAPP_DRAFT_ROUTE_TABLE = Object.freeze([
  {
    id: 'whatsapp_draft_get',
    method: 'GET',
    path: WHATSAPP_DRAFT_PATH,
    match: 'exact',
    minRole: WHATSAPP_DRAFT_MIN_ROLE,
  },
  {
    id: 'whatsapp_draft_post',
    method: 'POST',
    path: WHATSAPP_DRAFT_PATH,
    match: 'exact',
    minRole: WHATSAPP_DRAFT_MIN_ROLE,
  },
]);

/**
 * Tenant + actor + conversation lock. $1 slug, $2 actor client_id, $3 actor
 * staff_user_id, $4 conversation id. Home-tenant bind matches email drafts.
 */
const SQL_RESOLVE = `
SELECT conv.id::text AS conversation_id, c.id::text AS client_id, c.slug AS client_slug,
  conv.phone, COALESCE(conv.metadata->>'channel', conv.session_state->>'channel', 'whatsapp') AS channel
FROM conversations conv
INNER JOIN clients c ON c.id = conv.client_id
INNER JOIN staff_users su ON su.client_id = c.id AND su.id = $3::uuid
WHERE c.slug = $1 AND c.id = $2::uuid AND conv.id = $4::uuid
  AND su.status = 'active' AND su.role IN ('operator','admin','owner')
LIMIT 1
`.replace(/\s+/g, ' ').trim();

const SQL_RESOLVE_FOR_UPDATE = `${SQL_RESOLVE} FOR UPDATE OF conv`;

const SQL_SELECT_PENDING = `
SELECT id::text AS approval_id, conversation_id::text AS conversation_id, channel,
  draft_text, edited_text, status, tool_trace, created_by_run_id
FROM luna_outbound_approvals
WHERE client_id = $1::uuid AND conversation_id = $2::uuid
  AND channel = 'whatsapp' AND status = 'pending'
ORDER BY updated_at DESC, id DESC
LIMIT 1
`.replace(/\s+/g, ' ').trim();

const SQL_UPSERT_PENDING = `
INSERT INTO luna_outbound_approvals (
  id, client_id, conversation_id, channel, draft_text, edited_text, status,
  tool_trace, created_by_run_id, created_by_staff_user_id
) VALUES (
  $1::uuid, $2::uuid, $3::uuid, 'whatsapp', $4, NULL, 'pending',
  '{}'::jsonb, NULL, $5::uuid
)
ON CONFLICT (client_id, conversation_id, channel) WHERE status = 'pending'
DO UPDATE SET
  draft_text = EXCLUDED.draft_text,
  created_by_staff_user_id = EXCLUDED.created_by_staff_user_id
RETURNING id::text AS approval_id, conversation_id::text AS conversation_id,
  channel, draft_text, status
`.replace(/\s+/g, ' ').trim();

function ownData(o, k) {
  try {
    const d = Object.getOwnPropertyDescriptor(o, k);
    return d && Object.prototype.hasOwnProperty.call(d, 'value') && !d.get && !d.set ? d.value : undefined;
  } catch {
    return undefined;
  }
}

function utf8Bytes(s) {
  try {
    return typeof s === 'string' ? Buffer.byteLength(s, 'utf8') : -1;
  } catch {
    return -1;
  }
}

function parseUuid(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const t = raw.trim();
  return UUID_RE.test(t) ? t : null;
}

function mintUuid() {
  return String(crypto.randomUUID()).toLowerCase();
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const want = name.toLowerCase();
  const values = [];
  for (const k of Reflect.ownKeys(headers)) {
    if (typeof k !== 'string' || k.toLowerCase() !== want) continue;
    const d = Object.getOwnPropertyDescriptor(headers, k);
    if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set || !d.enumerable) {
      return undefined;
    }
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
    const headers = req && typeof req === 'object' ? ownData(req, 'headers') || req.headers : undefined;
    const ct = headerValue(headers, 'content-type');
    return ct && isExactApplicationJson(ct) ? Object.freeze({ ok: true }) : fail;
  } catch {
    return fail;
  }
}

function actorFromUser(user) {
  if (!user || typeof user !== 'object') return null;
  const sid = parseUuid(typeof user.staff_user_id === 'string' ? user.staff_user_id : null);
  const clientId = parseUuid(typeof user.client_id === 'string' ? user.client_id : null);
  const role = typeof user.role === 'string' ? user.role : null;
  const clientSlug = typeof user.client_slug === 'string' ? user.client_slug.trim() : '';
  return (sid && clientId && role && OPERATOR_ROLES.includes(role))
    ? Object.freeze({
      staff_user_id: sid,
      client_id: clientId,
      role,
      client_slug: clientSlug || null,
    })
    : null;
}

function allowedOwnKeys(o, allowed) {
  try {
    if (!o || typeof o !== 'object' || Array.isArray(o) || Object.getPrototypeOf(o) !== Object.prototype) {
      return false;
    }
    const actual = Reflect.ownKeys(o);
    if (actual.length < POST_REQUIRED_KEYS.length || actual.length > allowed.length) return false;
    return actual.every((k) => {
      if (typeof k !== 'string' || DANGEROUS.has(k) || !allowed.includes(k)) return false;
      const d = Object.getOwnPropertyDescriptor(o, k);
      return !!(d && Object.prototype.hasOwnProperty.call(d, 'value') && d.enumerable && !d.get && !d.set);
    }) && POST_REQUIRED_KEYS.every((k) => Object.prototype.hasOwnProperty.call(o, k));
  } catch {
    return false;
  }
}

function snapshotPostBody(raw) {
  try {
    if (!allowedOwnKeys(raw, POST_BODY_KEYS)) return null;
    const conversationId = parseUuid(ownData(raw, 'conversation_id'));
    if (!conversationId) return null;
    const draftText = ownData(raw, 'draft_text');
    if (typeof draftText !== 'string' || draftText.length < 1) return null;
    const bytes = utf8Bytes(draftText);
    if (bytes < 1 || bytes > DRAFT_MAX_BYTES) return null;
    const slugRaw = ownData(raw, 'client_slug');
    let clientSlug = null;
    if (slugRaw !== undefined) {
      if (typeof slugRaw !== 'string' || !slugRaw.trim() || slugRaw.length > 64) return null;
      clientSlug = slugRaw.trim();
    }
    return Object.freeze({
      conversation_id: conversationId,
      draft_text: draftText,
      client_slug: clientSlug,
    });
  } catch {
    return null;
  }
}

function parseConversationIdQuery(query) {
  try {
    const raw = query && typeof query === 'object' ? ownData(query, 'conversation_id') : undefined;
    return parseUuid(typeof raw === 'string' ? raw : null);
  } catch {
    return null;
  }
}

function resolveClientSlug(explicit, actor, defaultClient) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  if (actor && typeof actor.client_slug === 'string' && actor.client_slug) return actor.client_slug;
  return String(defaultClient || '').trim();
}

function isWhatsAppConversation(row) {
  if (!row || typeof row !== 'object') return false;
  const phone = row.phone == null ? '' : String(row.phone).trim();
  const channel = row.channel == null ? '' : String(row.channel).trim().toLowerCase();
  const resolved = channel || WHATSAPP_DRAFT_CHANNEL;
  if (resolved === 'email' || isEmailChannelPhoneNamespace(phone)) return false;
  return resolved === WHATSAPP_DRAFT_CHANNEL;
}

function emptyGetDto(conversationId) {
  return Object.freeze({
    success: true,
    conversation_id: conversationId,
    channel: WHATSAPP_DRAFT_CHANNEL,
    draft_available: false,
    approval_id: null,
    draft_text: null,
    edited_text: null,
    status: null,
    tool_trace: null,
    created_by_run_id: null,
  });
}

function pendingGetDto(row) {
  let toolTrace = row.tool_trace;
  if (toolTrace && typeof toolTrace === 'string') {
    try { toolTrace = JSON.parse(toolTrace); } catch { toolTrace = {}; }
  }
  if (!toolTrace || typeof toolTrace !== 'object' || Array.isArray(toolTrace)) toolTrace = {};
  return Object.freeze({
    success: true,
    conversation_id: String(row.conversation_id).toLowerCase(),
    channel: WHATSAPP_DRAFT_CHANNEL,
    draft_available: true,
    approval_id: String(row.approval_id).toLowerCase(),
    draft_text: String(row.draft_text),
    edited_text: row.edited_text == null ? null : String(row.edited_text),
    status: WHATSAPP_DRAFT_STATUS_PENDING,
    tool_trace: Object.freeze({ ...toolTrace }),
    created_by_run_id: row.created_by_run_id == null ? null : String(row.created_by_run_id),
  });
}

function postSuccessDto(row) {
  return Object.freeze({
    success: true,
    conversation_id: String(row.conversation_id).toLowerCase(),
    channel: WHATSAPP_DRAFT_CHANNEL,
    approval_id: String(row.approval_id).toLowerCase(),
    draft_text: String(row.draft_text),
    status: WHATSAPP_DRAFT_STATUS_PENDING,
  });
}

function auditSafe(appendAuditLog, fields) {
  if (typeof appendAuditLog !== 'function') return;
  try {
    const o = {
      ts: new Date().toISOString(),
      category: fields.category || 'inbox_whatsapp_draft',
      intent: fields.intent || 'api:inbox.whatsapp.draft',
      success: fields.success === true,
    };
    for (const k of ['code', 'approval_id', 'conversation_id', 'staff_user_id', 'client_slug']) {
      if (typeof fields[k] === 'string') o[k] = fields[k];
    }
    if (typeof fields.elapsed_ms === 'number') o.elapsed_ms = fields.elapsed_ms;
    appendAuditLog(Object.freeze(o));
  } catch { /* */ }
}

/**
 * @param {object} deps
 */
function createWhatsAppDraftRoutes(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('createWhatsAppDraftRoutes: deps required');
  }
  const {
    sendJSON,
    send400,
    assertStaffClientAccess,
    appendAuditLog,
    withPgClient,
    DEFAULT_CLIENT,
    SQL_INJECT_RE,
  } = deps;
  const readBody = typeof deps.readBody === 'function' ? deps.readBody : null;

  if (typeof sendJSON !== 'function' || typeof send400 !== 'function' || typeof withPgClient !== 'function') {
    throw new Error('createWhatsAppDraftRoutes: sendJSON, send400 and withPgClient required');
  }
  if (typeof assertStaffClientAccess !== 'function') {
    throw new Error('createWhatsAppDraftRoutes: assertStaffClientAccess required');
  }
  if (!SQL_INJECT_RE) {
    throw new Error('createWhatsAppDraftRoutes: SQL_INJECT_RE required');
  }

  function gateClient(res, user, clientSlug) {
    if (!clientSlug || SQL_INJECT_RE.test(clientSlug)) {
      send400(res, 'invalid client slug');
      return false;
    }
    if (!assertStaffClientAccess(user, clientSlug, res)) return false;
    return true;
  }

  async function resolveOwnedWhatsApp(pg, actor, clientSlug, conversationId, forUpdate) {
    const sql = forUpdate ? SQL_RESOLVE_FOR_UPDATE : SQL_RESOLVE;
    const result = await pg.query(sql, [
      clientSlug,
      actor.client_id,
      actor.staff_user_id,
      conversationId,
    ]);
    const row = result && result.rows && result.rows[0];
    if (!row) return { ok: false, status: 404, body: NOT_FOUND, code: 'conversation_not_found' };
    if (!isWhatsAppConversation(row)) {
      return {
        ok: false,
        status: 409,
        body: EMAIL_CHANNEL_NOT_SUPPORTED,
        code: 'email_channel_not_supported',
      };
    }
    return {
      ok: true,
      conversation_id: String(row.conversation_id).toLowerCase(),
      client_id: String(row.client_id).toLowerCase(),
    };
  }

  async function handleWhatsAppDraftGet(query, res, user) {
    const started = Date.now();
    const actor = actorFromUser(user);
    if (!actor) return sendJSON(res, 403, FORBIDDEN);

    const conversationId = parseConversationIdQuery(query || {});
    if (!conversationId) return sendJSON(res, 400, INVALID_REQUEST);

    const slugRaw = query && typeof query === 'object'
      ? (ownData(query, 'client') || ownData(query, 'client_slug'))
      : undefined;
    const clientSlug = resolveClientSlug(
      typeof slugRaw === 'string' ? slugRaw : null,
      actor,
      DEFAULT_CLIENT,
    );
    if (!gateClient(res, user, clientSlug)) return undefined;

    const auditBase = {
      intent: 'api:inbox.whatsapp.draft.get',
      category: 'inbox_whatsapp_draft',
      conversation_id: conversationId,
      staff_user_id: actor.staff_user_id,
      client_slug: clientSlug,
    };

    try {
      const outcome = await withPgClient(async (pg) => {
        const owned = await resolveOwnedWhatsApp(pg, actor, clientSlug, conversationId, false);
        if (!owned.ok) return owned;
        const pending = await pg.query(SQL_SELECT_PENDING, [owned.client_id, owned.conversation_id]);
        const row = pending && pending.rows && pending.rows[0];
        return {
          ok: true,
          status: 200,
          body: row ? pendingGetDto(row) : emptyGetDto(owned.conversation_id),
          code: row ? 'draft_pending' : 'draft_absent',
        };
      });
      auditSafe(appendAuditLog, {
        ...auditBase,
        success: outcome.status === 200,
        code: outcome.code,
        approval_id: outcome.body && outcome.body.approval_id,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, outcome.status, outcome.body);
    } catch (_err) {
      auditSafe(appendAuditLog, {
        ...auditBase,
        success: false,
        code: 'draft_get_error',
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 500, DRAFT_FAILED);
    }
  }

  async function readPostBody(req) {
    try {
      let text;
      if (readBody) {
        const raw = await readBody(req, BODY_MAX_BYTES);
        text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
      } else {
        const chunks = [];
        let total = 0;
        await new Promise((resolve, reject) => {
          req.on('data', (c) => {
            total += c.length;
            if (total > BODY_MAX_BYTES) reject(new Error('body_too_large'));
            else chunks.push(c);
          });
          req.on('end', resolve);
          req.on('error', reject);
        });
        text = Buffer.concat(chunks).toString('utf8');
      }
      if (typeof text !== 'string') return { ok: false, status: 400, body: INVALID_REQUEST };
      if (utf8Bytes(text) > BODY_MAX_BYTES) return { ok: false, status: 400, body: INVALID_REQUEST };
      let parsed;
      try { parsed = JSON.parse(text); } catch { return { ok: false, status: 400, body: INVALID_REQUEST }; }
      const snap = snapshotPostBody(parsed);
      return snap ? { ok: true, body: snap } : { ok: false, status: 400, body: INVALID_REQUEST };
    } catch {
      return { ok: false, status: 400, body: INVALID_REQUEST };
    }
  }

  async function handleWhatsAppDraftPost(req, res, user) {
    const started = Date.now();
    const actor = actorFromUser(user);
    if (!actor) return sendJSON(res, 403, FORBIDDEN);

    const ct = validateJsonContentType(req);
    if (!ct.ok) return sendJSON(res, ct.status, ct.body);

    const parsed = await readPostBody(req);
    if (!parsed.ok) return sendJSON(res, parsed.status, parsed.body);
    const input = parsed.body;

    const clientSlug = resolveClientSlug(input.client_slug, actor, DEFAULT_CLIENT);
    if (!gateClient(res, user, clientSlug)) return undefined;

    const auditBase = {
      intent: 'api:inbox.whatsapp.draft.post',
      category: 'inbox_whatsapp_draft',
      conversation_id: input.conversation_id,
      staff_user_id: actor.staff_user_id,
      client_slug: clientSlug,
    };

    try {
      const outcome = await withPgClient(async (pg) => {
        const owned = await resolveOwnedWhatsApp(pg, actor, clientSlug, input.conversation_id, true);
        if (!owned.ok) return owned;
        const approvalId = mintUuid();
        const upsert = await pg.query(SQL_UPSERT_PENDING, [
          approvalId,
          owned.client_id,
          owned.conversation_id,
          input.draft_text,
          actor.staff_user_id,
        ]);
        const row = upsert && upsert.rows && upsert.rows[0];
        if (!row) {
          return { ok: false, status: 500, body: DRAFT_FAILED, code: 'draft_upsert_failed' };
        }
        return {
          ok: true,
          status: 200,
          body: postSuccessDto(row),
          code: 'draft_saved',
        };
      });
      auditSafe(appendAuditLog, {
        ...auditBase,
        success: outcome.status === 200,
        code: outcome.code,
        approval_id: outcome.body && outcome.body.approval_id,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, outcome.status, outcome.body);
    } catch (_err) {
      auditSafe(appendAuditLog, {
        ...auditBase,
        success: false,
        code: 'draft_post_error',
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 500, DRAFT_FAILED);
    }
  }

  const handlers = Object.freeze({
    whatsapp_draft_get: handleWhatsAppDraftGet,
    whatsapp_draft_post: handleWhatsAppDraftPost,
  });

  return {
    WHATSAPP_DRAFT_PATH,
    WHATSAPP_DRAFT_ROUTE_TABLE,
    handlers,
    handleWhatsAppDraftGet,
    handleWhatsAppDraftPost,
  };
}

module.exports = {
  WHATSAPP_DRAFT_PATH,
  WHATSAPP_DRAFT_CHANNEL,
  WHATSAPP_DRAFT_MIN_ROLE,
  WHATSAPP_DRAFT_STATUS_PENDING,
  WHATSAPP_DRAFT_ROUTE_TABLE,
  POST_BODY_KEYS,
  POST_REQUIRED_KEYS,
  GET_SUCCESS_DTO_KEYS,
  POST_SUCCESS_DTO_KEYS,
  BODY_MAX_BYTES,
  DRAFT_MAX_BYTES,
  SQL_RESOLVE,
  SQL_RESOLVE_FOR_UPDATE,
  SQL_SELECT_PENDING,
  SQL_UPSERT_PENDING,
  snapshotPostBody,
  parseConversationIdQuery,
  actorFromUser,
  isWhatsAppConversation,
  validateJsonContentType,
  createWhatsAppDraftRoutes,
};
