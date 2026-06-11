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

function normalizePendingManualList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => trimStr(item).toLowerCase()).filter(Boolean);
}

/**
 * Merge observability/context pending service state into extracted_fields for attach.
 * extracted_fields remains valid but is not the only source on deposit turns.
 */
function mergePendingServiceAttachContext(extractedFields, resultContext) {
  const base = extractedFields && typeof extractedFields === 'object'
    ? { ...extractedFields }
    : {};
  const ctx = resultContext && typeof resultContext === 'object'
    ? resultContext
    : {};

  const pending = normalizePendingManualList(
    ctx.services_pending_manual != null
      ? ctx.services_pending_manual
      : base.services_pending_manual,
  );
  if (pending.length) {
    base.services_pending_manual = pending;
  }

  const yogaStatus = trimStr(ctx.yoga_status || base.yoga_status);
  const mealsStatus = trimStr(ctx.meals_status || base.meals_status);
  if (yogaStatus) base.yoga_status = yogaStatus;
  if (mealsStatus) base.meals_status = mealsStatus;

  if (ctx.yoga_request && typeof ctx.yoga_request === 'object' && !base.yoga_request) {
    base.yoga_request = ctx.yoga_request;
  }
  if (ctx.meals_request && typeof ctx.meals_request === 'object' && !base.meals_request) {
    base.meals_request = ctx.meals_request;
  }

  if (pending.includes('yoga') && !base.yoga_request) {
    const st = ATTACHABLE_STATUSES.has(yogaStatus) ? yogaStatus : 'requested';
    base.yoga_request = { status: st };
    if (ctx.yoga_requested_dates) base.yoga_request.requested_dates = ctx.yoga_requested_dates;
  } else if (yogaStatus && ATTACHABLE_STATUSES.has(yogaStatus) && !base.yoga_request) {
    base.yoga_request = { status: yogaStatus };
  }

  const mealType = ctx.meal_type || base.meal_type;
  const hasMealsPending = pending.includes('meals') || pending.includes('meal');
  if (hasMealsPending && !base.meals_request) {
    const st = ATTACHABLE_STATUSES.has(mealsStatus) ? mealsStatus : 'requested';
    base.meals_request = { status: st };
    if (mealType) base.meals_request.meal_type = mealType;
  } else if (mealsStatus && ATTACHABLE_STATUSES.has(mealsStatus) && !base.meals_request) {
    base.meals_request = { status: mealsStatus };
    if (mealType) base.meals_request.meal_type = mealType;
  }

  const mealsDays = ctx.meals_days || ctx.requested_days || base.meals_days || base.requested_days;
  if (mealsDays && base.meals_request && !base.meals_request.meals_days) {
    base.meals_request.meals_days = mealsDays;
  }

  return base;
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

  const pending = normalizePendingManualList(fields.services_pending_manual);
  for (const code of pending) {
    if (code === 'yoga') push('yoga', 'services_pending_manual');
    if (code === 'meals' || code === 'meal') push('meal', 'services_pending_manual');
  }

  const yogaStatusTop = trimStr(fields.yoga_status);
  if (yogaStatusTop && ATTACHABLE_STATUSES.has(yogaStatusTop)) {
    push('yoga', 'yoga_status');
  }

  const mealsStatusTop = trimStr(fields.meals_status);
  if (mealsStatusTop && ATTACHABLE_STATUSES.has(mealsStatusTop)) {
    push('meal', 'meals_status');
  }

  return services;
}

function resolveServiceRecordStatus(svc, fields) {
  const f = fields || {};
  if (svc.type === 'yoga') {
    const st = trimStr((f.yoga_request && f.yoga_request.status) || f.yoga_status);
    return ATTACHABLE_STATUSES.has(st) ? st : 'requested';
  }
  if (svc.type === 'meal') {
    const st = trimStr((f.meals_request && f.meals_request.status) || f.meals_status);
    return ATTACHABLE_STATUSES.has(st) ? st : 'requested';
  }
  return 'requested';
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
  const fields = mergePendingServiceAttachContext(o.extractedFields, o.resultContext);
  const services = collectPendingManualServices(fields);

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

    const recordStatus = resolveServiceRecordStatus(svc, fields);
    await pg.query(
      `INSERT INTO booking_service_records (
         client_slug, booking_id, booking_code, guest_name,
         service_type, service_date, quantity, status,
         amount_due_cents, amount_paid_cents, payment_status,
         source, notes, metadata
       ) VALUES (
         $1, $2::uuid, $3, $4,
         $5, NULL, 1, $6,
         0, 0, 'not_requested',
         $7, NULL, $8::jsonb
       )`,
      [
        clientSlug,
        bookingId,
        bookingCode,
        guestName,
        svc.type,
        recordStatus,
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
  mergePendingServiceAttachContext,
  collectPendingManualServices,
  attachPendingManualGuestServices,
};
