'use strict';

/**
 * Confirmation owed — one record per saved booking.
 * Provider ACCEPT (wamid / sent) never clears by itself.
 * Only a delivered callback clears, and delivery events are stored so
 * delivered-before-accept still reconciles.
 */

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function isDeliveredCallback(status) {
  return trimStr(status).toLowerCase() === 'delivered';
}

const RECORD_SQL = `
INSERT INTO booking_confirmation_owed (booking_id, client_id, owed_at)
VALUES ($1::uuid, $2::uuid, NOW())
ON CONFLICT (booking_id) DO NOTHING
RETURNING booking_id::text AS booking_id, owed_at, cleared_at`;

const STAMP_ACCEPT_SQL = `
UPDATE booking_confirmation_owed
   SET provider_message_id = $2
 WHERE booking_id = $1::uuid
   AND cleared_at IS NULL
   AND $2 <> ''
RETURNING booking_id::text AS booking_id, provider_message_id, cleared_at`;

const CLEAR_SQL = `
UPDATE booking_confirmation_owed
   SET cleared_at = NOW(),
       clear_reason = 'delivered'
 WHERE cleared_at IS NULL
   AND provider_message_id = $1
   AND $1 <> ''
RETURNING booking_id::text AS booking_id, cleared_at, clear_reason`;

const STORE_DELIVERY_SQL = `
INSERT INTO booking_confirmation_delivery_events (provider_message_id, delivered_at)
VALUES ($1, NOW())
ON CONFLICT (provider_message_id) DO NOTHING
RETURNING provider_message_id`;

const SELECT_DELIVERY_SQL = `
SELECT provider_message_id, delivered_at
  FROM booking_confirmation_delivery_events
 WHERE provider_message_id = $1`;

function isUndefinedTableError(err) {
  return !!(err && err.code === '42P01');
}

let optionalSpSeq = 0;

/**
 * Optional-table writes must not abort an open caller transaction.
 * 42P01 is rolled back to a SAVEPOINT when already in BEGIN; autocommit
 * (25P01 on SAVEPOINT) isolates the failure by itself.
 */
async function withOptionalTableSavepoint(pg, work) {
  const name = `confirmation_owed_optional_${++optionalSpSeq}`;
  let spOpen = false;
  try {
    await pg.query(`SAVEPOINT ${name}`);
    spOpen = true;
  } catch (err) {
    if (!(err && err.code === '25P01')) throw err;
  }
  try {
    const result = await work();
    if (spOpen) {
      try { await pg.query(`RELEASE SAVEPOINT ${name}`); } catch (_) {}
    }
    return result;
  } catch (err) {
    if (spOpen) {
      try { await pg.query(`ROLLBACK TO SAVEPOINT ${name}`); } catch (_) {}
      try { await pg.query(`RELEASE SAVEPOINT ${name}`); } catch (_) {}
    }
    if (isUndefinedTableError(err)) {
      return { ok: false, reason: 'table_missing', table_missing: true };
    }
    throw err;
  }
}

async function recordConfirmationOwed(pg, fields) {
  const bookingId = trimStr(fields && fields.booking_id);
  const clientId = trimStr(fields && fields.client_id);
  if (!pg || !bookingId || !clientId) {
    return { ok: false, owed: false, reason: 'missing_booking_or_client' };
  }
  const out = await withOptionalTableSavepoint(pg, async () => {
    const r = await pg.query(RECORD_SQL, [bookingId, clientId]);
    return { ok: true, owed: true, inserted: !!(r.rows && r.rows[0]) };
  });
  if (out && out.table_missing) return { ok: false, owed: false, reason: 'table_missing' };
  return out;
}

async function storeDeliveryEvent(pg, providerId) {
  const id = trimStr(providerId);
  if (!pg || !id) return { ok: true, stored: false };
  const out = await withOptionalTableSavepoint(pg, async () => {
    const r = await pg.query(STORE_DELIVERY_SQL, [id]);
    return { ok: true, stored: true, inserted: !!(r.rows && r.rows[0]) };
  });
  if (out && out.table_missing) return { ok: false, stored: false, reason: 'table_missing' };
  return out;
}

async function hasDeliveryEvent(pg, providerId) {
  const id = trimStr(providerId);
  if (!pg || !id) return false;
  const out = await withOptionalTableSavepoint(pg, async () => {
    const r = await pg.query(SELECT_DELIVERY_SQL, [id]);
    return { ok: true, found: !!(r.rows && r.rows[0]) };
  });
  if (out && out.table_missing) return false;
  return !!(out && out.found);
}

async function clearByProviderId(pg, providerId) {
  const out = await withOptionalTableSavepoint(pg, async () => {
    const r = await pg.query(CLEAR_SQL, [providerId]);
    return {
      ok: true,
      cleared: !!(r.rows && r.rows[0]),
      clear_reason: r.rows && r.rows[0] ? r.rows[0].clear_reason : null,
    };
  });
  if (out && out.table_missing) return { ok: false, cleared: false, reason: 'table_missing' };
  return out;
}

async function reconcileConfirmationOwed(pg, fields) {
  const providerId = trimStr(fields && fields.provider_message_id);
  if (!pg || !providerId) {
    return { ok: true, cleared: false, reason: 'missing_provider' };
  }
  const delivered = await hasDeliveryEvent(pg, providerId);
  if (!delivered) return { ok: true, cleared: false, reason: 'no_delivery_event' };
  return clearByProviderId(pg, providerId);
}

async function recordConfirmationAccepted(pg, fields) {
  const bookingId = trimStr(fields && fields.booking_id);
  const providerId = trimStr(fields && fields.provider_message_id);
  if (!pg || !bookingId || !providerId) {
    return { ok: true, stamped: false, cleared: false, reason: 'missing_booking_or_provider' };
  }
  const stampedOut = await withOptionalTableSavepoint(pg, async () => {
    const r = await pg.query(STAMP_ACCEPT_SQL, [bookingId, providerId]);
    return { ok: true, stamped: !!(r.rows && r.rows[0]) };
  });
  if (stampedOut && stampedOut.table_missing) {
    return { ok: false, stamped: false, cleared: false, reason: 'table_missing' };
  }
  const reconciled = await reconcileConfirmationOwed(pg, { provider_message_id: providerId });
  return {
    ok: true,
    stamped: stampedOut.stamped === true,
    cleared: reconciled.cleared === true,
    clear_reason: reconciled.clear_reason || null,
  };
}

async function clearConfirmationOwedOnDelivery(pg, fields) {
  const providerId = trimStr(fields && fields.provider_message_id);
  if (!pg) {
    return { ok: false, cleared: false, reason: 'missing_pg' };
  }
  if (!isDeliveredCallback(fields && fields.delivery_status)) {
    return { ok: true, cleared: false, reason: 'not_delivered' };
  }
  if (!providerId) {
    return { ok: true, cleared: false, reason: 'no_provider_message_id' };
  }
  await storeDeliveryEvent(pg, providerId);
  return reconcileConfirmationOwed(pg, { provider_message_id: providerId });
}

function extractDeliveryStatuses(payload) {
  const out = [];
  const entries = payload && Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = entry && Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const statuses = change && change.value && Array.isArray(change.value.statuses)
        ? change.value.statuses
        : [];
      for (const st of statuses) {
        if (!st) continue;
        out.push({
          id: trimStr(st.id || st.provider_message_id),
          status: trimStr(st.status).toLowerCase(),
        });
      }
    }
  }
  return out;
}

async function applyConfirmationDeliveryStatuses(pg, payload) {
  const items = extractDeliveryStatuses(payload);
  let cleared = 0;
  let ignored_not_delivered = 0;
  for (const item of items) {
    if (!isDeliveredCallback(item.status)) {
      ignored_not_delivered += 1;
      continue;
    }
    const r = await clearConfirmationOwedOnDelivery(pg, {
      provider_message_id: item.id,
      delivery_status: 'delivered',
    });
    if (r && r.cleared === true) cleared += 1;
  }
  return { ok: true, cleared, ignored_not_delivered };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BOOKING_LOOKUP_SQL = `
SELECT b.id::text AS booking_id, b.booking_code, b.phone, b.client_id::text AS client_id
  FROM bookings b
  JOIN clients c ON c.id = b.client_id
 WHERE c.slug = $1
   AND b.id = $2::uuid
 LIMIT 1`;

const OWED_LOOKUP_SQL = `
SELECT booking_id::text AS booking_id, provider_message_id, cleared_at
  FROM booking_confirmation_owed
 WHERE booking_id = $1::uuid
 LIMIT 1`;

const OPEN_OWED_SQL = `
SELECT o.booking_id::text AS booking_id,
       b.booking_code,
       conv.id::text AS conversation_id,
       o.owed_at,
       o.provider_message_id
  FROM booking_confirmation_owed o
  JOIN bookings b ON b.id = o.booking_id AND b.client_id = o.client_id
  JOIN clients c ON c.id = o.client_id
  LEFT JOIN conversations conv
    ON conv.client_id = c.id
   AND regexp_replace(COALESCE(conv.phone, ''), '\\D', '', 'g')
     = regexp_replace(COALESCE(b.phone, ''), '\\D', '', 'g')
   AND regexp_replace(COALESCE(b.phone, ''), '\\D', '', 'g') <> ''
 WHERE c.slug = $1
   AND o.cleared_at IS NULL
   AND ($2::uuid IS NULL OR o.booking_id = $2::uuid)
   AND ($3::uuid IS NULL OR conv.id = $3::uuid)`;

async function stampConfirmationAcceptedForBooking(pg, fields) {
  const clientSlug = trimStr(fields && fields.client_slug);
  const bookingId = trimStr(fields && fields.booking_id);
  const providerId = trimStr(fields && fields.provider_message_id);
  if (!pg) {
    return { ok: false, stamped: false, cleared: false, cause: 'missing_pg' };
  }
  if (!bookingId || !UUID_RE.test(bookingId)) {
    return {
      ok: false, stamped: false, cleared: false, cause: 'booking_id_required',
      error: 'booking_id (UUID) is required',
    };
  }
  if (!providerId) {
    return {
      ok: false, stamped: false, cleared: false, cause: 'provider_message_id_required',
      error: 'provider_message_id is required',
    };
  }
  if (!clientSlug) {
    return {
      ok: false, stamped: false, cleared: false, cause: 'client_slug_required',
      error: 'client slug is required',
    };
  }
  try {
    const booking = await pg.query(BOOKING_LOOKUP_SQL, [clientSlug, bookingId]);
    if (!booking.rows[0]) {
      return {
        ok: false, stamped: false, cleared: false, cause: 'booking_not_found',
        error: 'Booking was not found for this client',
        booking_id: bookingId,
      };
    }
    const owedRow = await pg.query(OWED_LOOKUP_SQL, [bookingId]);
    if (!owedRow.rows[0]) {
      return {
        ok: false, stamped: false, cleared: false, cause: 'owed_row_not_found',
        error: 'No confirmation-owed row for this booking',
        booking_id: bookingId,
      };
    }
    const prior = owedRow.rows[0];
    const alreadyStamped = trimStr(prior.provider_message_id) === providerId;
    const accepted = await recordConfirmationAccepted(pg, {
      booking_id: bookingId,
      provider_message_id: providerId,
    });
    return {
      ok: true,
      stamped: accepted.stamped === true || alreadyStamped || !!prior.cleared_at,
      idempotent: alreadyStamped || !!prior.cleared_at,
      cleared: accepted.cleared === true,
      booking_id: bookingId,
      provider_message_id: providerId,
    };
  } catch (err) {
    if (isUndefinedTableError(err)) {
      return { ok: false, stamped: false, cleared: false, cause: 'table_missing', error: 'confirmation owed table is missing' };
    }
    throw err;
  }
}

async function listOpenConfirmationOwed(pg, fields) {
  const clientSlug = trimStr(fields && fields.client_slug);
  const bookingId = trimStr(fields && fields.booking_id) || null;
  const conversationId = trimStr(fields && fields.conversation_id) || null;
  if (!pg) {
    return { ok: false, owed: [], cause: 'missing_pg' };
  }
  if (!bookingId && !conversationId) {
    return {
      ok: false, owed: [], cause: 'conversation_id_or_booking_id_required',
      error: 'conversation_id or booking_id is required',
    };
  }
  if (bookingId && !UUID_RE.test(bookingId)) {
    return { ok: false, owed: [], cause: 'booking_id_required', error: 'booking_id must be a UUID' };
  }
  if (conversationId && !UUID_RE.test(conversationId)) {
    return { ok: false, owed: [], cause: 'conversation_id_invalid', error: 'conversation_id must be a UUID' };
  }
  if (!clientSlug) {
    return { ok: false, owed: [], cause: 'client_slug_required', error: 'client slug is required' };
  }
  try {
    const r = await pg.query(OPEN_OWED_SQL, [clientSlug, bookingId, conversationId]);
    return {
      ok: true,
      owed: (r.rows || []).map((row) => ({
        booking_id: row.booking_id,
        booking_code: row.booking_code || null,
        conversation_id: row.conversation_id || null,
        owed_at: row.owed_at || null,
        provider_message_id: row.provider_message_id || null,
      })),
    };
  } catch (err) {
    if (isUndefinedTableError(err)) {
      return { ok: false, owed: [], cause: 'table_missing', error: 'confirmation owed table is missing' };
    }
    throw err;
  }
}

module.exports = {
  isUndefinedTableError,
  isDeliveredCallback,
  recordConfirmationOwed,
  recordConfirmationAccepted,
  stampConfirmationAcceptedForBooking,
  listOpenConfirmationOwed,
  storeDeliveryEvent,
  reconcileConfirmationOwed,
  clearConfirmationOwedOnDelivery,
  extractDeliveryStatuses,
  applyConfirmationDeliveryStatuses,
};
