'use strict';

/**
 * Phase 19e.5a — guest_message_sends idempotency/audit SQL helpers.
 */

const SELECT_GUEST_MESSAGE_SEND_COLS = `
  id::text,
  client_slug,
  channel,
  to_phone,
  idempotency_key,
  send_kind,
  source,
  message_text,
  status,
  blocked_reasons,
  provider_message_id,
  provider_response,
  created_at,
  sent_at,
  updated_at
`;

function isMissingGuestMessageSendsTable(err) {
  if (!err) return false;
  if (err.code === '42P01') return true;
  const msg = String(err.message || '');
  return /guest_message_sends/.test(msg) && /does not exist|undefined table/i.test(msg);
}

function formatGuestMessageSendRow(row) {
  if (!row) return null;
  let blockedReasons = row.blocked_reasons;
  if (blockedReasons == null) blockedReasons = [];
  if (typeof blockedReasons === 'string') {
    try { blockedReasons = JSON.parse(blockedReasons); } catch { blockedReasons = []; }
  }
  return {
    id: row.id,
    client_slug: row.client_slug,
    channel: row.channel,
    to_phone: row.to_phone,
    idempotency_key: row.idempotency_key,
    send_kind: row.send_kind,
    source: row.source,
    message_text: row.message_text,
    status: row.status,
    blocked_reasons: Array.isArray(blockedReasons) ? blockedReasons : [],
    provider_message_id: row.provider_message_id,
    provider_response: row.provider_response || null,
    created_at: row.created_at,
    sent_at: row.sent_at,
    updated_at: row.updated_at,
  };
}

function normalizeBlockedReasons(blockedReasons) {
  if (!Array.isArray(blockedReasons)) return [];
  return [...new Set(blockedReasons.filter(Boolean).map(String))];
}

async function findGuestMessageSendByKey(pg, clientSlug, idempotencyKey) {
  try {
    const r = await pg.query(
      `SELECT ${SELECT_GUEST_MESSAGE_SEND_COLS}
         FROM guest_message_sends
        WHERE client_slug = $1
          AND idempotency_key = $2
        LIMIT 1`,
      [clientSlug, idempotencyKey],
    );
    return { row: formatGuestMessageSendRow(r.rows[0] || null) };
  } catch (err) {
    if (isMissingGuestMessageSendsTable(err)) return { row: null, table_missing: true };
    throw err;
  }
}

async function claimGuestMessageSendPending(pg, input) {
  const payload = input || {};
  try {
    const insert = await pg.query(
      `INSERT INTO guest_message_sends (
         client_slug, channel, to_phone, idempotency_key, send_kind, source,
         message_text, status, blocked_reasons
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', '[]'::jsonb)
       ON CONFLICT (client_slug, idempotency_key) DO NOTHING
       RETURNING ${SELECT_GUEST_MESSAGE_SEND_COLS}`,
      [
        payload.client_slug,
        payload.channel || 'whatsapp',
        payload.to_phone,
        payload.idempotency_key,
        payload.send_kind,
        payload.source || null,
        payload.message_text,
      ],
    );
    if (insert.rows[0]) {
      return { claimed: true, row: formatGuestMessageSendRow(insert.rows[0]) };
    }
    const existing = await findGuestMessageSendByKey(
      pg,
      payload.client_slug,
      payload.idempotency_key,
    );
    return { claimed: false, row: existing.row };
  } catch (err) {
    if (isMissingGuestMessageSendsTable(err)) return { claimed: false, row: null, table_missing: true };
    throw err;
  }
}

async function recordGuestMessageSendBlocked(pg, input) {
  const payload = input || {};
  const blockedReasons = normalizeBlockedReasons(payload.blocked_reasons);
  try {
    const r = await pg.query(
      `INSERT INTO guest_message_sends (
         client_slug, channel, to_phone, idempotency_key, send_kind, source,
         message_text, status, blocked_reasons, provider_response
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'blocked', $8::jsonb, $9::jsonb)
       ON CONFLICT (client_slug, idempotency_key) DO UPDATE SET
         status = CASE
           WHEN guest_message_sends.status = 'sent' THEN guest_message_sends.status
           ELSE EXCLUDED.status
         END,
         blocked_reasons = CASE
           WHEN guest_message_sends.status = 'sent' THEN guest_message_sends.blocked_reasons
           ELSE EXCLUDED.blocked_reasons
         END,
         message_text = CASE
           WHEN guest_message_sends.status = 'sent' THEN guest_message_sends.message_text
           ELSE EXCLUDED.message_text
         END,
         provider_response = CASE
           WHEN guest_message_sends.status = 'sent' THEN guest_message_sends.provider_response
           ELSE EXCLUDED.provider_response
         END,
         updated_at = NOW()
       RETURNING ${SELECT_GUEST_MESSAGE_SEND_COLS}`,
      [
        payload.client_slug,
        payload.channel || 'whatsapp',
        payload.to_phone,
        payload.idempotency_key,
        payload.send_kind,
        payload.source || null,
        payload.message_text,
        JSON.stringify(blockedReasons),
        payload.provider_response ? JSON.stringify(payload.provider_response) : null,
      ],
    );
    return { row: formatGuestMessageSendRow(r.rows[0] || null) };
  } catch (err) {
    if (isMissingGuestMessageSendsTable(err)) return { row: null, table_missing: true };
    throw err;
  }
}

async function finalizeGuestMessageSendSent(pg, id, providerMessageId, providerResponse) {
  try {
    const r = await pg.query(
      `UPDATE guest_message_sends
          SET status = 'sent',
              provider_message_id = $2,
              provider_response = $3::jsonb,
              blocked_reasons = '[]'::jsonb,
              sent_at = NOW(),
              updated_at = NOW()
        WHERE id = $1::uuid
          AND status IN ('pending', 'blocked', 'failed')
        RETURNING ${SELECT_GUEST_MESSAGE_SEND_COLS}`,
      [
        id,
        providerMessageId || null,
        providerResponse ? JSON.stringify(providerResponse) : null,
      ],
    );
    return { row: formatGuestMessageSendRow(r.rows[0] || null) };
  } catch (err) {
    if (isMissingGuestMessageSendsTable(err)) return { row: null, table_missing: true };
    throw err;
  }
}

async function finalizeGuestMessageSendBlocked(pg, id, blockedReasons, providerResponse) {
  const reasons = normalizeBlockedReasons(blockedReasons);
  try {
    const r = await pg.query(
      `UPDATE guest_message_sends
          SET status = 'blocked',
              blocked_reasons = $2::jsonb,
              provider_response = $3::jsonb,
              updated_at = NOW()
        WHERE id = $1::uuid
          AND status IN ('pending', 'blocked', 'failed')
        RETURNING ${SELECT_GUEST_MESSAGE_SEND_COLS}`,
      [
        id,
        JSON.stringify(reasons),
        providerResponse ? JSON.stringify(providerResponse) : null,
      ],
    );
    return { row: formatGuestMessageSendRow(r.rows[0] || null) };
  } catch (err) {
    if (isMissingGuestMessageSendsTable(err)) return { row: null, table_missing: true };
    throw err;
  }
}

module.exports = {
  SELECT_GUEST_MESSAGE_SEND_COLS,
  isMissingGuestMessageSendsTable,
  formatGuestMessageSendRow,
  findGuestMessageSendByKey,
  claimGuestMessageSendPending,
  recordGuestMessageSendBlocked,
  finalizeGuestMessageSendSent,
  finalizeGuestMessageSendBlocked,
};
