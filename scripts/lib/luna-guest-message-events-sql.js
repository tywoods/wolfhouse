'use strict';

/**
 * Phase 19g.8 — guest_message_events inbound webhook persistence SQL helpers.
 */

const SELECT_GUEST_MESSAGE_EVENT_COLS = `
  id::text,
  client_slug,
  channel,
  direction,
  from_phone,
  to_phone_number_id,
  wa_message_id,
  message_type,
  message_text,
  profile_name,
  raw_payload,
  normalized,
  draft_called,
  next_action,
  suggested_reply,
  handoff_required,
  send_attempted,
  send_idempotency_key,
  send_status,
  send_blocked_reasons,
  created_at,
  updated_at
`;

function isMissingGuestMessageEventsTable(err) {
  if (!err) return false;
  if (err.code === '42P01') return true;
  const msg = String(err.message || '');
  return /guest_message_events/.test(msg) && /does not exist|undefined table/i.test(msg);
}

function parseJsonField(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function formatGuestMessageEventRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    client_slug: row.client_slug,
    channel: row.channel,
    direction: row.direction,
    from_phone: row.from_phone,
    to_phone_number_id: row.to_phone_number_id,
    wa_message_id: row.wa_message_id,
    message_type: row.message_type,
    message_text: row.message_text,
    profile_name: row.profile_name,
    raw_payload: parseJsonField(row.raw_payload),
    normalized: parseJsonField(row.normalized),
    draft_called: row.draft_called === true,
    next_action: row.next_action,
    suggested_reply: row.suggested_reply,
    handoff_required: row.handoff_required === true,
    send_attempted: row.send_attempted === true,
    send_idempotency_key: row.send_idempotency_key,
    send_status: row.send_status,
    send_blocked_reasons: parseJsonField(row.send_blocked_reasons, []),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeBlockedReasons(blockedReasons) {
  if (!Array.isArray(blockedReasons)) return [];
  return [...new Set(blockedReasons.filter(Boolean).map(String))];
}

function isGuestMessageEventProcessed(row) {
  if (!row) return false;
  const normalized = row.normalized || {};
  if (normalized.supported === false) return true;
  if (row.next_action != null && String(row.next_action).length > 0) return true;
  if (row.draft_called === true) return true;
  if (row.send_attempted === true) return true;
  return false;
}

function buildInboundEventSeed(normalized, rawPayload) {
  const norm = normalized || {};
  return {
    client_slug: norm.client_slug,
    channel: 'whatsapp',
    direction: 'inbound',
    from_phone: norm.from || null,
    to_phone_number_id: norm.phone_number_id || null,
    wa_message_id: norm.wa_message_id,
    message_type: norm.message_type || null,
    message_text: norm.message_text || null,
    profile_name: norm.profile_name || null,
    raw_payload: rawPayload || null,
    normalized: norm,
  };
}

function buildDecisionPatch(input) {
  const payload = input || {};
  const draft = payload.draft || null;
  const sendResult = payload.send_result || null;
  const handoffRequired = payload.handoff_required === true
    || !!(draft && draft.extraction && draft.extraction.handoff_required === true)
    || draft?.next_action === 'handoff_to_staff';

  let sendStatus = payload.send_status || null;
  if (!sendStatus && sendResult && sendResult.guest_message_send_status) {
    sendStatus = sendResult.guest_message_send_status;
  }
  if (!sendStatus && payload.send_attempted === true) {
    sendStatus = sendResult && sendResult.send_performed ? 'sent' : 'blocked';
  }

  return {
    draft_called: payload.draft_called === true,
    next_action: draft ? draft.next_action : (payload.next_action || null),
    suggested_reply: draft ? draft.suggested_reply : (payload.suggested_reply || null),
    handoff_required: handoffRequired,
    send_attempted: payload.send_attempted === true,
    send_idempotency_key: payload.send_idempotency_key || null,
    send_status: sendStatus,
    send_blocked_reasons: normalizeBlockedReasons(
      sendResult && sendResult.blocked_reasons
        ? sendResult.blocked_reasons
        : payload.send_blocked_reasons,
    ),
  };
}

async function findGuestMessageEventByWaMessageId(pg, clientSlug, waMessageId) {
  try {
    const r = await pg.query(
      `SELECT ${SELECT_GUEST_MESSAGE_EVENT_COLS}
         FROM guest_message_events
        WHERE client_slug = $1
          AND wa_message_id = $2
        LIMIT 1`,
      [clientSlug, waMessageId],
    );
    return { row: formatGuestMessageEventRow(r.rows[0] || null) };
  } catch (err) {
    if (isMissingGuestMessageEventsTable(err)) return { row: null, table_missing: true };
    throw err;
  }
}

/**
 * FORTRESS 15H2 — find historical guest_message_events by WhatsApp message
 * identity only. Does not trust the requested tenant/client_slug. Callers must
 * compare/reject/fill against authoritative identity and must not insert a
 * duplicate when any candidate already exists.
 *
 * @param {object} pg
 * @param {string} waMessageId
 * @returns {Promise<{ rows: object[], table_missing?: boolean }>}
 */
async function findGuestMessageEventCandidatesByWaMessageId(pg, waMessageId) {
  try {
    const r = await pg.query(
      `SELECT ${SELECT_GUEST_MESSAGE_EVENT_COLS}
         FROM guest_message_events
        WHERE wa_message_id = $1
        ORDER BY created_at ASC NULLS LAST, id ASC`,
      [waMessageId],
    );
    const rows = (r.rows || []).map((row) => formatGuestMessageEventRow(row));
    return { rows };
  } catch (err) {
    if (isMissingGuestMessageEventsTable(err)) return { rows: [], table_missing: true };
    throw err;
  }
}

/**
 * FORTRESS 15H2 — transactional advisory lock namespace for wa_message_id.
 * Serializes cross-tenant find+insert without requiring a global
 * UNIQUE(wa_message_id) schema constraint at code rollout. Existing unique is
 * still (client_slug, wa_message_id) only. Never use session pg_advisory_lock.
 */
const WA_MESSAGE_ID_LOCK_NAMESPACE = 'guest_message_events.wa_message_id';

/**
 * Merge next normalized onto stored history while preserving stored identity.
 * Authority may fill response/runtime identity only — never rewrite stored
 * client_slug / location_id (including leaving location absent when legacy-null).
 *
 * @param {object|null|undefined} storedNormalized
 * @param {object|null|undefined} nextNormalized
 * @returns {object}
 */
function mergeNormalizedPreservingStoredIdentity(storedNormalized, nextNormalized) {
  const stored = storedNormalized && typeof storedNormalized === 'object'
    ? storedNormalized
    : {};
  const next = nextNormalized && typeof nextNormalized === 'object'
    ? nextNormalized
    : {};
  const out = { ...stored, ...next };
  if (Object.prototype.hasOwnProperty.call(stored, 'client_slug')) {
    out.client_slug = stored.client_slug;
  }
  if (Object.prototype.hasOwnProperty.call(stored, 'location_id')) {
    out.location_id = stored.location_id;
  } else {
    delete out.location_id;
  }
  return out;
}

/**
 * FORTRESS 15H2 — concurrency-safe claim across tenant slugs.
 * ONE transaction: BEGIN → pg_advisory_xact_lock → global lookup → conditional
 * insert → COMMIT. ROLLBACK on every failure. Does not use session
 * pg_advisory_lock/unlock and does not require UNIQUE(wa_message_id).
 *
 * @param {object} pg
 * @param {object} seed
 * @returns {Promise<{ rows: object[], inserted: boolean, table_missing?: boolean }>}
 */
async function claimGuestMessageEventInboundByWaMessageId(pg, seed) {
  const payload = seed || {};
  const waMessageId = payload.wa_message_id;
  if (!waMessageId) {
    return { rows: [], inserted: false };
  }

  await pg.query('BEGIN');
  try {
    await pg.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      [WA_MESSAGE_ID_LOCK_NAMESPACE, String(waMessageId)],
    );

    const candidates = await findGuestMessageEventCandidatesByWaMessageId(pg, waMessageId);
    if (candidates.table_missing) {
      // Query failed inside the xact (42P01) — transaction is aborted; must ROLLBACK.
      await pg.query('ROLLBACK');
      return { rows: [], inserted: false, table_missing: true };
    }
    const existing = Array.isArray(candidates.rows) ? candidates.rows : [];
    if (existing.length > 0) {
      await pg.query('COMMIT');
      return { rows: existing, inserted: false };
    }

    const inserted = await insertGuestMessageEventInbound(pg, payload);
    if (inserted.table_missing) {
      await pg.query('ROLLBACK');
      return { rows: [], inserted: false, table_missing: true };
    }
    if (inserted.row) {
      await pg.query('COMMIT');
      return { rows: [inserted.row], inserted: inserted.inserted === true };
    }

    // ON CONFLICT DO NOTHING / concurrent same-slug: re-find under the same xact lock.
    const again = await findGuestMessageEventCandidatesByWaMessageId(pg, waMessageId);
    if (again.table_missing) {
      await pg.query('ROLLBACK');
      return { rows: [], inserted: false, table_missing: true };
    }
    await pg.query('COMMIT');
    return { rows: again.rows || [], inserted: false };
  } catch (err) {
    try {
      await pg.query('ROLLBACK');
    } catch (_) {
      /* ignore rollback errors; surface original failure */
    }
    throw err;
  }
}

async function insertGuestMessageEventInbound(pg, seed) {
  const payload = seed || {};
  try {
    const r = await pg.query(
      `INSERT INTO guest_message_events (
         client_slug, channel, direction, from_phone, to_phone_number_id,
         wa_message_id, message_type, message_text, profile_name,
         raw_payload, normalized
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
       ON CONFLICT (client_slug, wa_message_id) DO NOTHING
       RETURNING ${SELECT_GUEST_MESSAGE_EVENT_COLS}`,
      [
        payload.client_slug,
        payload.channel || 'whatsapp',
        payload.direction || 'inbound',
        payload.from_phone,
        payload.to_phone_number_id,
        payload.wa_message_id,
        payload.message_type,
        payload.message_text,
        payload.profile_name,
        payload.raw_payload ? JSON.stringify(payload.raw_payload) : null,
        payload.normalized ? JSON.stringify(payload.normalized) : null,
      ],
    );
    if (r.rows[0]) {
      return { inserted: true, row: formatGuestMessageEventRow(r.rows[0]) };
    }
    const existing = await findGuestMessageEventByWaMessageId(
      pg,
      payload.client_slug,
      payload.wa_message_id,
    );
    return { inserted: false, row: existing.row };
  } catch (err) {
    if (isMissingGuestMessageEventsTable(err)) return { inserted: false, row: null, table_missing: true };
    throw err;
  }
}

async function updateGuestMessageEventDecisions(pg, clientSlug, waMessageId, patch) {
  const payload = patch || {};
  try {
    const r = await pg.query(
      `UPDATE guest_message_events
          SET draft_called = $3,
              next_action = $4,
              suggested_reply = $5,
              handoff_required = $6,
              send_attempted = $7,
              send_idempotency_key = $8,
              send_status = $9,
              send_blocked_reasons = $10::jsonb,
              updated_at = NOW()
        WHERE client_slug = $1
          AND wa_message_id = $2
        RETURNING ${SELECT_GUEST_MESSAGE_EVENT_COLS}`,
      [
        clientSlug,
        waMessageId,
        payload.draft_called === true,
        payload.next_action,
        payload.suggested_reply,
        payload.handoff_required === true,
        payload.send_attempted === true,
        payload.send_idempotency_key,
        payload.send_status,
        JSON.stringify(normalizeBlockedReasons(payload.send_blocked_reasons)),
      ],
    );
    return { row: formatGuestMessageEventRow(r.rows[0] || null) };
  } catch (err) {
    if (isMissingGuestMessageEventsTable(err)) return { row: null, table_missing: true };
    throw err;
  }
}

module.exports = {
  SELECT_GUEST_MESSAGE_EVENT_COLS,
  WA_MESSAGE_ID_LOCK_NAMESPACE,
  isMissingGuestMessageEventsTable,
  formatGuestMessageEventRow,
  isGuestMessageEventProcessed,
  buildInboundEventSeed,
  buildDecisionPatch,
  findGuestMessageEventByWaMessageId,
  findGuestMessageEventCandidatesByWaMessageId,
  mergeNormalizedPreservingStoredIdentity,
  claimGuestMessageEventInboundByWaMessageId,
  insertGuestMessageEventInbound,
  updateGuestMessageEventDecisions,
};
