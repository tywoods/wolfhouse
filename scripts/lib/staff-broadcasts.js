/**
 * Staff Inbox Phase 4 — email-first segment broadcasts (domain).
 *
 * Create a draft against a saved people-view, snapshot view members on send
 * (excluding do_not_contact), and persist recipient rows as pending.
 * Bulk Graph/mailbox delivery is fail-closed behind BROADCAST_EMAIL_SEND_ENABLED.
 * Unset / "false" → snapshot recipients then 501 email_broadcast_send_not_implemented
 * (zero Graph). Flag "true" → sendMail on the existing Graph transport per recipient.
 *
 * WhatsApp is refused (promotions are email-only). Operational WhatsApp to
 * currently checked-in guests inside Meta's 24h window is out of scope.
 *
 * Suppression: customerIsDoNotContact from staff-customer-outreach-send.js.
 * View membership: buildInboxViewQuery from staff-inbox-saved-views.js.
 *
 * @module staff-broadcasts
 */

'use strict';

const { customerIsDoNotContact } = require('./staff-customer-outreach-send');
const { normalizeCustomerPhone } = require('./staff-customer-queries');
const {
  ERROR_UNKNOWN_VIEW,
  ERROR_VIEW_UNAVAILABLE,
  getInboxSavedViewDeclaration,
  buildInboxViewQuery,
} = require('./staff-inbox-saved-views');

const MAX_BROADCAST_RECIPIENTS = 50;
const MAX_BROADCAST_SCAN = 500;
const VIEW_PAGE_SIZE = 100;
const SUBJECT_MAX = 200;
const BODY_MIN = 5;
const BODY_MAX = 20000;
const VIEW_ID_MAX = 64;
const EMAIL_MAX = 160;
const NAME_MAX = 160;

const CHANNEL_EMAIL = 'email';
const CHANNEL_WHATSAPP = 'whatsapp';

const STATUS_DRAFT = 'draft';
const STATUS_PENDING = 'pending';
const STATUS_SENDING = 'sending';
const STATUS_SENT = 'sent';
const STATUS_FAILED = 'failed';
const RECIPIENT_PENDING = 'pending';
const RECIPIENT_SKIPPED = 'skipped';
const RECIPIENT_SENT = 'sent';
const RECIPIENT_ERROR = 'error';
const ENV_BROADCAST_EMAIL_SEND = 'BROADCAST_EMAIL_SEND_ENABLED';

const ERROR_WHATSAPP_NOT_SUPPORTED = 'whatsapp_broadcast_not_supported';
const ERROR_CHANNEL_NOT_SUPPORTED = 'channel_not_supported';
const ERROR_VIEW_REQUIRED = 'view_required';
const ERROR_VIEW_NOT_BROADCASTABLE = 'view_not_broadcastable';
const ERROR_SUBJECT_REQUIRED = 'subject_required';
const ERROR_BODY_TOO_SHORT = 'body_too_short';
const ERROR_RECIPIENT_CAP = 'recipient_cap_exceeded';
const ERROR_VIEW_TOO_LARGE = 'view_too_large';
const ERROR_NO_SENDABLE = 'no_sendable_recipients';
const ERROR_NOT_DRAFT = 'broadcast_not_draft';
const ERROR_CLIENT_NOT_FOUND = 'client_not_found';
const ERROR_SEND_NOT_IMPLEMENTED = 'email_broadcast_send_not_implemented';
const ERROR_SEND_UNAVAILABLE = 'email_broadcast_send_unavailable';
const ERROR_NOT_FOUND = 'not_found';

const SKIP_DO_NOT_CONTACT = 'do_not_contact';
const SKIP_MISSING_EMAIL = 'missing_email';
const SKIP_MISSING_PHONE = 'missing_phone';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SQL_INSERT_BROADCAST = `
INSERT INTO broadcasts (
  client_id, view_id, channel, email_subject, email_body, status, created_by_staff_user_id
)
SELECT c.id, $2, $3, $4, $5, 'draft', $6
  FROM clients c
 WHERE c.slug = $1
RETURNING id, client_id, $1::text AS client_slug, view_id, channel,
          email_subject, email_body, status, created_by_staff_user_id,
          created_at, updated_at
`.trim();

const SQL_SELECT_BROADCAST = `
SELECT b.id, b.client_id, c.slug AS client_slug, b.view_id, b.channel,
       b.email_subject, b.email_body, b.status, b.created_by_staff_user_id,
       b.created_at, b.updated_at
  FROM broadcasts b
 INNER JOIN clients c ON c.id = b.client_id
 WHERE b.id = $1
   AND c.slug = $2
`.trim();

const SQL_SELECT_RECIPIENTS = `
SELECT id, phone, email, display_name, status, skip_reason, created_at
  FROM broadcast_recipients
 WHERE broadcast_id = $1
   AND client_id = $2
 ORDER BY created_at ASC, phone ASC
`.trim();

const SQL_INSERT_RECIPIENT = `
INSERT INTO broadcast_recipients (
  client_id, broadcast_id, phone, email, display_name, status, skip_reason
) VALUES ($1, $2, $3, $4, $5, $6, $7)
`.trim();

const SQL_MARK_PENDING = `
UPDATE broadcasts
   SET status = 'pending'
 WHERE id = $1
   AND client_id = $2
   AND status = 'draft'
RETURNING id, status
`.trim();

const SQL_MARK_BROADCAST_STATUS = `
UPDATE broadcasts
   SET status = $3
 WHERE id = $1
   AND client_id = $2
RETURNING id, status
`.trim();

const SQL_UPDATE_RECIPIENT_STATUS = `
UPDATE broadcast_recipients
   SET status = $3
 WHERE broadcast_id = $1
   AND client_id = $2
   AND phone = $4
   AND status = 'pending'
RETURNING id, status
`.trim();

function trimText(value, maxLen) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  return s.slice(0, maxLen);
}

function isValidBroadcastEmail(email) {
  const s = trimText(email, EMAIL_MAX);
  if (!s || s.length > EMAIL_MAX) return false;
  return EMAIL_RE.test(s);
}

function isoOrNull(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

function isBroadcastEmailSendEnabled(env) {
  try {
    if (!env || typeof env !== 'object') return false;
    return env[ENV_BROADCAST_EMAIL_SEND] === 'true';
  } catch {
    return false;
  }
}

function summarizeClassified(classified) {
  const rows = Array.isArray(classified) ? classified : [];
  const reasons = {};
  let pending = 0;
  let skipped = 0;
  let sent = 0;
  let error = 0;
  for (const row of rows) {
    if (row.status === RECIPIENT_PENDING) pending += 1;
    else if (row.status === RECIPIENT_SENT) sent += 1;
    else if (row.status === RECIPIENT_ERROR) error += 1;
    else if (row.status === RECIPIENT_SKIPPED) {
      skipped += 1;
      const reason = row.skip_reason || 'skipped';
      reasons[reason] = (reasons[reason] || 0) + 1;
    }
  }
  return {
    requested: rows.length,
    pending,
    skipped,
    sent,
    error,
    skipped_reasons: reasons,
  };
}

/**
 * @param {object} body
 * @returns {{ ok: true, value: object } | { ok: false, error: string, viewId?: string }}
 */
function parseBroadcastCreateBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const channelRaw = trimText(b.channel == null ? CHANNEL_EMAIL : b.channel, 32).toLowerCase();
  const channel = channelRaw || CHANNEL_EMAIL;
  if (channel === CHANNEL_WHATSAPP) {
    return { ok: false, error: ERROR_WHATSAPP_NOT_SUPPORTED };
  }
  if (channel !== CHANNEL_EMAIL) {
    return { ok: false, error: ERROR_CHANNEL_NOT_SUPPORTED };
  }

  const viewId = trimText(b.view_id || b.view || b.segment_id, VIEW_ID_MAX);
  if (!viewId) return { ok: false, error: ERROR_VIEW_REQUIRED };

  const declared = getInboxSavedViewDeclaration(viewId);
  if (!declared) return { ok: false, error: ERROR_UNKNOWN_VIEW, viewId };
  if (!declared.available) {
    return {
      ok: false,
      error: ERROR_VIEW_UNAVAILABLE,
      viewId,
      reason: declared.unavailableReason,
    };
  }
  if (!declared.multiSelect) {
    return { ok: false, error: ERROR_VIEW_NOT_BROADCASTABLE, viewId };
  }

  const subject = trimText(b.email_subject || b.subject, SUBJECT_MAX);
  if (!subject) return { ok: false, error: ERROR_SUBJECT_REQUIRED };
  const emailBody = trimText(b.email_body || b.body || b.message, BODY_MAX);
  if (!emailBody || emailBody.length < BODY_MIN) {
    return { ok: false, error: ERROR_BODY_TOO_SHORT };
  }

  return {
    ok: true,
    value: {
      viewId,
      channel,
      subject,
      emailBody,
    },
  };
}

/**
 * Classify view-member rows into pending vs skipped. Does not send.
 *
 * @param {Array<object>} rows
 * @param {{ maxRecipients?: number }} [opts]
 */
function classifyBroadcastRecipients(rows, opts = {}) {
  const maxRecipients = Number.isFinite(opts.maxRecipients)
    ? opts.maxRecipients
    : MAX_BROADCAST_RECIPIENTS;
  const seen = new Set();
  const classified = [];

  for (const raw of rows || []) {
    const phone = normalizeCustomerPhone(raw && raw.phone) || '';
    const email = trimText(raw && raw.email, EMAIL_MAX);
    const displayName = trimText(raw && (raw.display_name || raw.full_name), NAME_MAX) || null;
    const dedupeKey = phone || (email ? `email:${email.toLowerCase()}` : `anon:${classified.length}`);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    if (customerIsDoNotContact(raw)) {
      if (!phone) continue;
      classified.push({
        phone,
        email: email || null,
        display_name: displayName,
        status: RECIPIENT_SKIPPED,
        skip_reason: SKIP_DO_NOT_CONTACT,
      });
      continue;
    }
    if (!phone) {
      continue;
    }
    if (!isValidBroadcastEmail(email)) {
      classified.push({
        phone,
        email: email || null,
        display_name: displayName,
        status: RECIPIENT_SKIPPED,
        skip_reason: SKIP_MISSING_EMAIL,
      });
      continue;
    }
    classified.push({
      phone,
      email,
      display_name: displayName,
      status: RECIPIENT_PENDING,
      skip_reason: null,
    });
  }

  const summary = summarizeClassified(classified);
  if (summary.pending > maxRecipients) {
    return { ok: false, error: ERROR_RECIPIENT_CAP, classified, summary };
  }
  return { ok: true, classified, summary };
}

function recipientDto(row) {
  return {
    phone: row.phone || null,
    email: row.email || null,
    display_name: row.display_name || null,
    status: row.status,
    skip_reason: row.skip_reason || null,
  };
}

function broadcastRecordDto(row) {
  return {
    id: row.id,
    client_slug: row.client_slug,
    view_id: row.view_id,
    channel: row.channel,
    email_subject: row.email_subject,
    email_body: row.email_body,
    status: row.status,
    created_by_staff_user_id: row.created_by_staff_user_id || null,
    created_at: isoOrNull(row.created_at),
    updated_at: isoOrNull(row.updated_at),
  };
}

function broadcastResponse(row, recipients) {
  const list = Array.isArray(recipients) ? recipients : [];
  return {
    success: true,
    broadcast: broadcastRecordDto(row),
    recipients: list.map(recipientDto),
    summary: summarizeClassified(list),
  };
}

async function loadViewMemberRows(pg, { viewId, clientSlug, query }) {
  const declared = getInboxSavedViewDeclaration(viewId);
  if (!declared) return { ok: false, error: ERROR_UNKNOWN_VIEW, viewId };
  if (!declared.available) {
    return {
      ok: false,
      error: ERROR_VIEW_UNAVAILABLE,
      viewId,
      reason: declared.unavailableReason,
    };
  }
  if (!declared.multiSelect) {
    return { ok: false, error: ERROR_VIEW_NOT_BROADCASTABLE, viewId };
  }

  const rows = [];
  let offset = 0;
  let truncated = false;
  const queries = [];

  while (rows.length < MAX_BROADCAST_SCAN) {
    const built = buildInboxViewQuery({
      view: viewId,
      clientSlug,
      query: { ...(query || {}), limit: VIEW_PAGE_SIZE, offset },
    });
    if (!built.ok) {
      return {
        ok: false,
        error: built.error,
        viewId: built.viewId || viewId,
        reason: built.reason,
      };
    }
    queries.push({ sql: built.sql, params: built.params });
    const result = await pg.query(built.sql, built.params);
    const batch = (result && result.rows) || [];
    rows.push(...batch);
    if (batch.length < VIEW_PAGE_SIZE) break;
    offset += VIEW_PAGE_SIZE;
    if (offset >= MAX_BROADCAST_SCAN) {
      truncated = batch.length >= VIEW_PAGE_SIZE;
      break;
    }
  }

  if (rows.length > MAX_BROADCAST_SCAN) {
    truncated = true;
    rows.length = MAX_BROADCAST_SCAN;
  }

  return { ok: true, rows, truncated, viewId, queries };
}

async function executeCreateBroadcast(pg, { clientSlug, body, staffUserId }) {
  const parsed = parseBroadcastCreateBody(body);
  if (!parsed.ok) {
    const status = parsed.error === ERROR_WHATSAPP_NOT_SUPPORTED ? 400 : 400;
    return { ok: false, status, error: parsed.error, viewId: parsed.viewId || null };
  }

  const { viewId, channel, subject, emailBody } = parsed.value;
  const result = await pg.query(SQL_INSERT_BROADCAST, [
    clientSlug,
    viewId,
    channel,
    subject,
    emailBody,
    staffUserId || null,
  ]);
  const row = result && result.rows && result.rows[0];
  if (!row) {
    return { ok: false, status: 400, error: ERROR_CLIENT_NOT_FOUND };
  }
  return {
    ok: true,
    status: 201,
    body: broadcastResponse(row, []),
  };
}

async function loadBroadcastWithRecipients(pg, broadcastId, clientSlug) {
  const found = await pg.query(SQL_SELECT_BROADCAST, [broadcastId, clientSlug]);
  const row = found && found.rows && found.rows[0];
  if (!row) return { ok: false, status: 404, error: ERROR_NOT_FOUND };
  const rec = await pg.query(SQL_SELECT_RECIPIENTS, [row.id, row.client_id]);
  return { ok: true, row, recipients: (rec && rec.rows) || [] };
}

async function executeGetBroadcast(pg, { clientSlug, broadcastId }) {
  const loaded = await loadBroadcastWithRecipients(pg, broadcastId, clientSlug);
  if (!loaded.ok) return loaded;
  return {
    ok: true,
    status: 200,
    body: broadcastResponse(loaded.row, loaded.recipients),
  };
}

async function executeSendBroadcast(pg, opts) {
  const clientSlug = opts && opts.clientSlug;
  const broadcastId = opts && opts.broadcastId;
  const query = opts && opts.query;
  const loaded = await loadBroadcastWithRecipients(pg, broadcastId, clientSlug);
  if (!loaded.ok) return loaded;
  if (loaded.row.channel !== CHANNEL_EMAIL) {
    return { ok: false, status: 400, error: ERROR_WHATSAPP_NOT_SUPPORTED };
  }
  if (loaded.row.status !== STATUS_DRAFT) {
    return { ok: false, status: 409, error: ERROR_NOT_DRAFT };
  }

  const members = await loadViewMemberRows(pg, {
    viewId: loaded.row.view_id,
    clientSlug,
    query,
  });
  if (!members.ok) {
    const status = members.error === ERROR_UNKNOWN_VIEW ? 400 : 409;
    return { ok: false, status, error: members.error, viewId: members.viewId || null };
  }
  if (members.truncated) {
    return { ok: false, status: 400, error: ERROR_VIEW_TOO_LARGE };
  }

  const classified = classifyBroadcastRecipients(members.rows);
  if (!classified.ok) {
    return { ok: false, status: 400, error: classified.error, summary: classified.summary };
  }
  if (classified.summary.pending === 0) {
    return {
      ok: false,
      status: 400,
      error: ERROR_NO_SENDABLE,
      summary: classified.summary,
    };
  }

  for (const rec of classified.classified) {
    await pg.query(SQL_INSERT_RECIPIENT, [
      loaded.row.client_id,
      loaded.row.id,
      rec.phone,
      rec.email,
      rec.display_name,
      rec.status,
      rec.skip_reason,
    ]);
  }

  const marked = await pg.query(SQL_MARK_PENDING, [loaded.row.id, loaded.row.client_id]);
  if (!marked || !marked.rows || marked.rows.length !== 1) {
    return { ok: false, status: 409, error: ERROR_NOT_DRAFT };
  }

  const pendingRow = { ...loaded.row, status: STATUS_PENDING };
  const notImplementedBody = {
    success: false,
    error: ERROR_SEND_NOT_IMPLEMENTED,
    detail: 'Recipients were stored as pending. Bulk Graph/mailbox send is a follow-up slice.',
    broadcast: broadcastRecordDto(pendingRow),
    recipients: classified.classified.map(recipientDto),
    summary: classified.summary,
  };

  if (!isBroadcastEmailSendEnabled(opts.env)) {
    return {
      ok: true,
      implemented: false,
      status: 501,
      error: ERROR_SEND_NOT_IMPLEMENTED,
      body: notImplementedBody,
    };
  }

  const sendMail = typeof opts.sendMail === 'function'
    ? opts.sendMail
    : (typeof opts.createSendMail === 'function' ? opts.createSendMail(pg, opts.env) : null);
  if (typeof sendMail !== 'function') {
    return {
      ok: false,
      status: 503,
      error: ERROR_SEND_UNAVAILABLE,
      body: {
        success: false,
        error: ERROR_SEND_UNAVAILABLE,
        detail: 'Broadcast email send is enabled but the Graph send helper is unavailable.',
        broadcast: broadcastRecordDto(pendingRow),
        recipients: classified.classified.map(recipientDto),
        summary: classified.summary,
      },
    };
  }

  await pg.query(SQL_MARK_BROADCAST_STATUS, [loaded.row.id, loaded.row.client_id, STATUS_SENDING]);

  const pendingRecipients = classified.classified.filter((row) => row.status === RECIPIENT_PENDING);
  let delivery;
  try {
    delivery = await sendMail({
      clientId: loaded.row.client_id,
      subject: loaded.row.email_subject,
      body: loaded.row.email_body,
      recipients: pendingRecipients.map((row) => ({ phone: row.phone, email: row.email })),
    });
  } catch (_err) {
    delivery = { ok: false, invokedGraph: false, results: [] };
  }

  if (!delivery || delivery.invokedGraph !== true) {
    await pg.query(SQL_MARK_BROADCAST_STATUS, [loaded.row.id, loaded.row.client_id, STATUS_PENDING]);
    return {
      ok: false,
      status: 503,
      error: ERROR_SEND_UNAVAILABLE,
      body: {
        success: false,
        error: ERROR_SEND_UNAVAILABLE,
        detail: 'Graph send was not invoked.',
        broadcast: broadcastRecordDto(pendingRow),
        recipients: classified.classified.map(recipientDto),
        summary: classified.summary,
      },
    };
  }

  const resultByPhone = new Map();
  for (const row of delivery.results || []) {
    if (row && row.phone) resultByPhone.set(row.phone, row.ok === true);
  }

  for (const rec of classified.classified) {
    if (rec.status !== RECIPIENT_PENDING) continue;
    rec.status = resultByPhone.get(rec.phone) === true ? RECIPIENT_SENT : RECIPIENT_ERROR;
    rec.skip_reason = null;
    await pg.query(SQL_UPDATE_RECIPIENT_STATUS, [
      loaded.row.id,
      loaded.row.client_id,
      rec.status,
      rec.phone,
    ]);
  }

  const summary = summarizeClassified(classified.classified);
  const allSent = summary.error === 0 && summary.sent > 0;
  const finalStatus = allSent ? STATUS_SENT : STATUS_FAILED;
  await pg.query(SQL_MARK_BROADCAST_STATUS, [loaded.row.id, loaded.row.client_id, finalStatus]);
  const finalRow = { ...loaded.row, status: finalStatus };
  return {
    ok: true,
    implemented: true,
    status: 200,
    body: {
      success: allSent,
      broadcast: broadcastRecordDto(finalRow),
      recipients: classified.classified.map(recipientDto),
      summary,
    },
  };
}

module.exports = {
  MAX_BROADCAST_RECIPIENTS,
  MAX_BROADCAST_SCAN,
  VIEW_PAGE_SIZE,
  SUBJECT_MAX,
  BODY_MIN,
  BODY_MAX,
  CHANNEL_EMAIL,
  CHANNEL_WHATSAPP,
  STATUS_DRAFT,
  STATUS_PENDING,
  STATUS_SENDING,
  STATUS_SENT,
  STATUS_FAILED,
  RECIPIENT_PENDING,
  RECIPIENT_SKIPPED,
  RECIPIENT_SENT,
  RECIPIENT_ERROR,
  ENV_BROADCAST_EMAIL_SEND,
  ERROR_WHATSAPP_NOT_SUPPORTED,
  ERROR_CHANNEL_NOT_SUPPORTED,
  ERROR_VIEW_REQUIRED,
  ERROR_VIEW_NOT_BROADCASTABLE,
  ERROR_SUBJECT_REQUIRED,
  ERROR_BODY_TOO_SHORT,
  ERROR_RECIPIENT_CAP,
  ERROR_VIEW_TOO_LARGE,
  ERROR_NO_SENDABLE,
  ERROR_NOT_DRAFT,
  ERROR_CLIENT_NOT_FOUND,
  ERROR_SEND_NOT_IMPLEMENTED,
  ERROR_SEND_UNAVAILABLE,
  ERROR_NOT_FOUND,
  SKIP_DO_NOT_CONTACT,
  SKIP_MISSING_EMAIL,
  SKIP_MISSING_PHONE,
  SQL_INSERT_BROADCAST,
  SQL_SELECT_BROADCAST,
  SQL_SELECT_RECIPIENTS,
  SQL_INSERT_RECIPIENT,
  SQL_MARK_PENDING,
  SQL_MARK_BROADCAST_STATUS,
  SQL_UPDATE_RECIPIENT_STATUS,
  isBroadcastEmailSendEnabled,
  parseBroadcastCreateBody,
  classifyBroadcastRecipients,
  isValidBroadcastEmail,
  loadViewMemberRows,
  executeCreateBroadcast,
  executeGetBroadcast,
  executeSendBroadcast,
  broadcastResponse,
};
