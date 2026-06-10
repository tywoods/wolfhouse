'use strict';

/**
 * Stage 33 — attach yoga/meals pending manual services after guest hold creation.
 * Reuses booking_service_records; no fake schedule times; no automatic charges.
 */

const PENDING_ATTACH_SOURCE = 'luna_guest_pending';
const ATTACHABLE_STATUSES = new Set(['requested', 'interested', 'needs_staff_confirmation']);

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function collectPendingManualServices(extractedFields) {
  const fields = extractedFields || {};
  const services = [];
  const seen = new Set();

  function push(type, attachSource) {
    if (seen.has(type)) return;
    seen.add(type);
    services.push({ type, attach_source: attachSource });
  }

  const yoga = fields.yoga_request;
  if (yoga && typeof yoga === 'object' && ATTACHABLE_STATUSES.has(trimStr(yoga.status || 'requested'))) {
    push('yoga', 'yoga_request');
  }

  const meals = fields.meals_request;
  if (meals && typeof meals === 'object' && ATTACHABLE_STATUSES.has(trimStr(meals.status || 'requested'))) {
    push('meal', 'meals_request');
  }

  const pending = fields.services_pending_manual;
  if (Array.isArray(pending)) {
    for (const item of pending) {
      const code = trimStr(item).toLowerCase();
      if (code === 'yoga') push('yoga', 'services_pending_manual');
      if (code === 'meals' || code === 'meal') push('meal', 'services_pending_manual');
    }
  }

  return services;
}

/**
 * @param {object} pg
 * @param {object} opts
 * @returns {Promise<{ attached_manual_services: string[] }>}
 */
async function attachPendingManualGuestServices(pg, opts) {
  const o = opts || {};
  const clientSlug = trimStr(o.clientSlug) || 'wolfhouse-somo';
  const bookingId = trimStr(o.bookingId);
  const bookingCode = trimStr(o.bookingCode);
  const guestName = trimStr(o.guestName) || 'Guest';
  const services = collectPendingManualServices(o.extractedFields);

  if (!pg || typeof pg.query !== 'function' || !bookingId || services.length === 0) {
    return { attached_manual_services: [] };
  }

  const attached = [];
  for (const svc of services) {
    const existing = await pg.query(
      `SELECT id::text AS id
         FROM booking_service_records
        WHERE booking_id = $1::uuid
          AND service_type = $2
          AND source = $3
        LIMIT 1`,
      [bookingId, svc.type, PENDING_ATTACH_SOURCE],
    );
    if (existing.rows.length) continue;

    await pg.query(
      `INSERT INTO booking_service_records (
         client_slug, booking_id, booking_code, guest_name,
         service_type, service_date, quantity, status,
         amount_due_cents, amount_paid_cents, payment_status,
         source, notes, metadata
       ) VALUES (
         $1, $2::uuid, $3, $4,
         $5, NULL, 1, 'requested',
         0, 0, 'not_requested',
         $6, NULL, $7::jsonb
       )`,
      [
        clientSlug,
        bookingId,
        bookingCode,
        guestName,
        svc.type,
        PENDING_ATTACH_SOURCE,
        JSON.stringify({
          pending_manual: true,
          needs_scheduling: true,
          attach_source: svc.attach_source,
          stage: '33_guest_pending_attach',
        }),
      ],
    );
    attached.push(svc.type === 'meal' ? 'meals' : svc.type);
  }

  return { attached_manual_services: attached };
}

module.exports = {
  PENDING_ATTACH_SOURCE,
  collectPendingManualServices,
  attachPendingManualGuestServices,
};
