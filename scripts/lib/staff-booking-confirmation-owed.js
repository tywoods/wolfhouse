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

function tableMissing(err) {
  const msg = err && err.message ? err.message : String(err);
  return /booking_confirmation_(owed|delivery_events)/i.test(msg)
    && /does not exist|relation/i.test(msg);
}

async function recordConfirmationOwed(pg, fields) {
  const bookingId = trimStr(fields && fields.booking_id);
  const clientId = trimStr(fields && fields.client_id);
  if (!pg || !bookingId || !clientId) {
    return { ok: false, owed: false, reason: 'missing_booking_or_client' };
  }
  try {
    const r = await pg.query(RECORD_SQL, [bookingId, clientId]);
    return { ok: true, owed: true, inserted: !!(r.rows && r.rows[0]) };
  } catch (err) {
    if (tableMissing(err)) return { ok: false, owed: false, reason: 'table_missing' };
    throw err;
  }
}

async function storeDeliveryEvent(pg, providerId) {
  const id = trimStr(providerId);
  if (!pg || !id) return { ok: true, stored: false };
  try {
    const r = await pg.query(STORE_DELIVERY_SQL, [id]);
    return { ok: true, stored: true, inserted: !!(r.rows && r.rows[0]) };
  } catch (err) {
    if (tableMissing(err)) return { ok: false, stored: false, reason: 'table_missing' };
    throw err;
  }
}

async function hasDeliveryEvent(pg, providerId) {
  const id = trimStr(providerId);
  if (!pg || !id) return false;
  try {
    const r = await pg.query(SELECT_DELIVERY_SQL, [id]);
    return !!(r.rows && r.rows[0]);
  } catch (err) {
    if (tableMissing(err)) return false;
    throw err;
  }
}

async function clearByProviderId(pg, providerId) {
  const r = await pg.query(CLEAR_SQL, [providerId]);
  return {
    ok: true,
    cleared: !!(r.rows && r.rows[0]),
    clear_reason: r.rows && r.rows[0] ? r.rows[0].clear_reason : null,
  };
}

async function reconcileConfirmationOwed(pg, fields) {
  const providerId = trimStr(fields && fields.provider_message_id);
  if (!pg || !providerId) {
    return { ok: true, cleared: false, reason: 'missing_provider' };
  }
  const delivered = await hasDeliveryEvent(pg, providerId);
  if (!delivered) return { ok: true, cleared: false, reason: 'no_delivery_event' };
  try {
    return await clearByProviderId(pg, providerId);
  } catch (err) {
    if (tableMissing(err)) return { ok: false, cleared: false, reason: 'table_missing' };
    throw err;
  }
}

async function recordConfirmationAccepted(pg, fields) {
  const bookingId = trimStr(fields && fields.booking_id);
  const providerId = trimStr(fields && fields.provider_message_id);
  if (!pg || !bookingId || !providerId) {
    return { ok: true, stamped: false, cleared: false, reason: 'missing_booking_or_provider' };
  }
  try {
    const r = await pg.query(STAMP_ACCEPT_SQL, [bookingId, providerId]);
    const stamped = !!(r.rows && r.rows[0]);
    const reconciled = await reconcileConfirmationOwed(pg, { provider_message_id: providerId });
    return {
      ok: true,
      stamped,
      cleared: reconciled.cleared === true,
      clear_reason: reconciled.clear_reason || null,
    };
  } catch (err) {
    if (tableMissing(err)) return { ok: false, stamped: false, cleared: false, reason: 'table_missing' };
    throw err;
  }
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
  try {
    await storeDeliveryEvent(pg, providerId);
    return await reconcileConfirmationOwed(pg, { provider_message_id: providerId });
  } catch (err) {
    if (tableMissing(err)) return { ok: false, cleared: false, reason: 'table_missing' };
    throw err;
  }
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

module.exports = {
  isDeliveredCallback,
  recordConfirmationOwed,
  recordConfirmationAccepted,
  storeDeliveryEvent,
  reconcileConfirmationOwed,
  clearConfirmationOwedOnDelivery,
  extractDeliveryStatuses,
  applyConfirmationDeliveryStatuses,
};
