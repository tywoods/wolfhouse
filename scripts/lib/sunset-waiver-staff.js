'use strict';

/**
 * Staff-facing Sunset waiver helpers (schedule drawer).
 * One waiver per booking contact for v1. No outbound guest messaging.
 * Luna booking path uses ensureWaiverForBooking (sunset-waiver-booking.js).
 */

const {
  SUNSET_TENANT_ID,
  createWaiverRequest,
  getWaiverFormVersionFromConfig,
  loadWaiverFormConfig,
  buildWaiverPublicUrl,
  resolveWaiverPublicBaseUrl,
  hashWaiverToken,
} = require('./sunset-waiver-model');
const { normalizeSunsetLocationId } = require('./sunset-school-locations');

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s || '').trim());
}

function parseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function resolveGuestCount(booking, services) {
  const fromBooking = parseInt(String(booking && booking.guest_count), 10);
  if (Number.isInteger(fromBooking) && fromBooking > 0) return fromBooking;
  let maxQ = 1;
  (services || []).forEach((sr) => {
    const q = parseInt(String(sr.quantity), 10);
    if (Number.isInteger(q) && q > maxQ) maxQ = q;
  });
  return maxQ;
}

function lessonDaysFromServices(services) {
  const dates = [...new Set((services || []).map((s) => String(s.service_date || '').slice(0, 10)).filter(Boolean))].sort();
  return dates.join(', ');
}

/**
 * Pure prefill builder for public form + metadata.
 */
function buildWaiverPrefillFromBooking(booking, services, locationId) {
  const b = booking || {};
  const meta = parseMeta(b.metadata);
  const phone = trimStr(b.phone || meta.guest_phone);
  const email = trimStr(b.email);
  const name = trimStr(b.guest_name);
  const lessonDays = lessonDaysFromServices(services);
  const loc = normalizeSunsetLocationId(locationId || meta.location_id);
  const summaryParts = [];
  if (b.booking_code) summaryParts.push(String(b.booking_code));
  if (lessonDays) summaryParts.push(lessonDays);
  if (loc) summaryParts.push(loc);
  return {
    full_name: name || undefined,
    guest_name: name || undefined,
    phone: phone || undefined,
    email: email || undefined,
    lesson_days: lessonDays || undefined,
    summary: summaryParts.length ? summaryParts.join(' · ') : undefined,
    location_id: loc,
  };
}

function staffSafeWaiver(request, submission, baseUrl) {
  if (!request) return null;
  const publicId = request.public_id;
  let publicUrl = null;
  try {
    publicUrl = buildWaiverPublicUrl(publicId, baseUrl || resolveWaiverPublicBaseUrl());
  } catch (_) {
    publicUrl = null;
  }
  const out = {
    id: request.id,
    status: request.status,
    public_id: publicId,
    public_url: publicUrl,
    form_type: request.form_type,
    form_version: request.form_version,
    participant_key: request.participant_key || null,
    sent_to_phone: request.sent_to_phone || null,
    sent_to_email: request.sent_to_email || null,
    completed_at: request.completed_at || null,
    expires_at: request.expires_at || null,
    created_at: request.created_at || null,
    submission: null,
  };
  if (submission) {
    out.submission = {
      id: submission.id,
      submitted_at: submission.submitted_at,
      respondent_name: submission.respondent_name || null,
      respondent_email: submission.respondent_email || null,
      respondent_phone: submission.respondent_phone || null,
      form_version: submission.form_version,
      raw_answers_json: submission.raw_answers_json || null,
    };
  }
  return out;
}

async function loadBookingForWaiver(pg, clientSlug, bookingId) {
  const res = await pg.query(
    `SELECT b.id::text AS booking_id,
            b.booking_code,
            b.guest_name,
            b.phone,
            b.email,
            b.customer_id::text AS customer_id,
            b.guest_count,
            b.check_in::text AS check_in,
            b.check_out::text AS check_out,
            b.metadata
       FROM bookings b
       INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND b.id = $2::uuid
      LIMIT 1`,
    [clientSlug, bookingId],
  );
  const booking = res.rows[0];
  if (!booking) return null;
  const svc = await pg.query(
    `SELECT service_date::text AS service_date, quantity, metadata
       FROM booking_service_records
      WHERE client_slug = $1 AND booking_id = $2::uuid
      ORDER BY service_date, id`,
    [clientSlug, bookingId],
  );
  return { booking, services: svc.rows };
}

async function getLatestWaiverRequest(pg, bookingId) {
  const res = await pg.query(
    `SELECT id::text AS id, tenant_id, customer_id::text AS customer_id,
            booking_id::text AS booking_id, participant_key, public_id, token_hash,
            status, form_type, form_version, sent_to_phone, sent_to_email,
            prefill_json, metadata, sent_at, completed_at, expires_at,
            created_at, updated_at
       FROM waiver_form_requests
      WHERE tenant_id = $1 AND booking_id = $2::uuid
      ORDER BY created_at DESC
      LIMIT 1`,
    [SUNSET_TENANT_ID, bookingId],
  );
  return res.rows[0] || null;
}

async function getSubmissionForRequest(pg, requestId) {
  const res = await pg.query(
    `SELECT id::text AS id, request_id::text AS request_id, submitted_at,
            respondent_name, respondent_email, respondent_phone,
            form_version, raw_answers_json, form_snapshot_json
       FROM waiver_form_submissions
      WHERE tenant_id = $1 AND request_id = $2::uuid
      LIMIT 1`,
    [SUNSET_TENANT_ID, requestId],
  );
  return res.rows[0] || null;
}

function multiStudentNote(guestCount) {
  const n = Number(guestCount) || 1;
  if (n <= 1) return null;
  return `Esta reserva tiene ${n} alumnos. De momento este enlace es el formulario principal de la reserva; formularios por alumno vendrán después.`;
}

async function getBookingWaiverStatus(pg, opts) {
  const clientSlug = trimStr(opts.clientSlug || opts.client_slug);
  if (clientSlug !== 'sunset') {
    return { ok: false, status: 403, body: { success: false, error: 'unsupported_client' } };
  }
  const bookingId = trimStr(opts.bookingId || opts.booking_id);
  if (!isUuid(bookingId)) {
    return { ok: false, status: 400, body: { success: false, error: 'booking_id is required' } };
  }

  let loaded;
  try {
    loaded = await loadBookingForWaiver(pg, clientSlug, bookingId);
  } catch (err) {
    // Table missing (migration not applied) — soft fail for staff UI.
    if (err && (err.code === '42P01' || /waiver_form_requests/i.test(err.message || ''))) {
      return {
        ok: true,
        status: 200,
        body: {
          success: true,
          booking_id: bookingId,
          waiver: null,
          migration_pending: true,
          message: 'Waiver tables not applied yet',
        },
      };
    }
    throw err;
  }
  if (!loaded) {
    return { ok: false, status: 404, body: { success: false, error: 'booking not found' } };
  }

  const guestCount = resolveGuestCount(loaded.booking, loaded.services);
  let request = null;
  let submission = null;
  try {
    request = await getLatestWaiverRequest(pg, bookingId);
    if (request && request.status === 'completed') {
      submission = await getSubmissionForRequest(pg, request.id);
    }
  } catch (err) {
    if (err && err.code === '42P01') {
      return {
        ok: true,
        status: 200,
        body: {
          success: true,
          booking_id: bookingId,
          guest_count: guestCount,
          multi_student_note: multiStudentNote(guestCount),
          waiver: null,
          migration_pending: true,
        },
      };
    }
    throw err;
  }

  const baseUrl = resolveWaiverPublicBaseUrl({ baseUrl: opts.baseUrl, env: opts.env });
  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      booking_id: bookingId,
      booking_code: loaded.booking.booking_code || null,
      guest_count: guestCount,
      multi_student_note: multiStudentNote(guestCount),
      waiver: staffSafeWaiver(request, submission, baseUrl),
    },
  };
}

async function createOrGetBookingWaiver(pg, opts) {
  const clientSlug = trimStr(opts.clientSlug || opts.client_slug);
  if (clientSlug !== 'sunset') {
    return { ok: false, status: 403, body: { success: false, error: 'unsupported_client' } };
  }
  const bookingId = trimStr(opts.bookingId || opts.booking_id);
  if (!isUuid(bookingId)) {
    return { ok: false, status: 400, body: { success: false, error: 'booking_id is required' } };
  }

  let loaded;
  try {
    loaded = await loadBookingForWaiver(pg, clientSlug, bookingId);
  } catch (err) {
    if (err && (err.code === '42P01' || /waiver_form_requests/i.test(err.message || ''))) {
      return {
        ok: false,
        status: 503,
        body: { success: false, error: 'migration_pending', message: 'Waiver tables not applied yet' },
      };
    }
    throw err;
  }
  if (!loaded) {
    return { ok: false, status: 404, body: { success: false, error: 'booking not found' } };
  }

  let existing;
  try {
    existing = await getLatestWaiverRequest(pg, bookingId);
  } catch (err) {
    if (err && err.code === '42P01') {
      return {
        ok: false,
        status: 503,
        body: { success: false, error: 'migration_pending', message: 'Waiver tables not applied yet' },
      };
    }
    throw err;
  }
  const baseUrl = resolveWaiverPublicBaseUrl({ baseUrl: opts.baseUrl, env: opts.env });
  const guestCount = resolveGuestCount(loaded.booking, loaded.services);

  if (existing && (existing.status === 'pending' || existing.status === 'needs_review' || existing.status === 'completed')) {
    let submission = null;
    if (existing.status === 'completed') {
      submission = await getSubmissionForRequest(pg, existing.id);
    }
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        created: false,
        booking_id: bookingId,
        guest_count: guestCount,
        multi_student_note: multiStudentNote(guestCount),
        waiver: staffSafeWaiver(existing, submission, baseUrl),
      },
    };
  }

  const cfg = loadWaiverFormConfig();
  const formVersion = getWaiverFormVersionFromConfig(cfg);
  const locationId = normalizeSunsetLocationId(
    opts.locationId || parseMeta(loaded.booking.metadata).location_id,
  );
  const prefill = buildWaiverPrefillFromBooking(loaded.booking, loaded.services, locationId);

  const created = await createWaiverRequest(pg, {
    tenantId: SUNSET_TENANT_ID,
    customerId: loaded.booking.customer_id || null,
    bookingId,
    participantKey: 'primary',
    formVersion,
    sentToPhone: prefill.phone || null,
    sentToEmail: prefill.email || null,
    prefillJson: prefill,
    metadata: {
      booking_code: loaded.booking.booking_code || null,
      location_id: locationId,
      guest_count: guestCount,
      source: trimStr(opts.source) || 'staff_schedule_drawer',
    },
    baseUrl,
    env: opts.env,
  });

  if (!created.ok) {
    return {
      ok: false,
      status: created.status || 500,
      body: { success: false, error: created.error || 'create_failed', detail: created.detail },
    };
  }

  return {
    ok: true,
    status: 201,
    body: {
      success: true,
      created: true,
      booking_id: bookingId,
      guest_count: guestCount,
      multi_student_note: multiStudentNote(guestCount),
      waiver: staffSafeWaiver(created.request, null, baseUrl),
    },
  };
}

async function getBookingWaiverSubmission(pg, opts) {
  const status = await getBookingWaiverStatus(pg, opts);
  if (!status.ok) return status;
  const waiver = status.body && status.body.waiver;
  if (!waiver || waiver.status !== 'completed' || !waiver.submission) {
    return {
      ok: false,
      status: 404,
      body: { success: false, error: 'submission_not_found' },
    };
  }
  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      booking_id: status.body.booking_id,
      waiver_status: waiver.status,
      public_id: waiver.public_id,
      submission: waiver.submission,
    },
  };
}


function resolveClientSlug(query, body) {
  return trimStr((query && (query.client || query.client_slug))
    || (body && (body.client_slug || body.client))
    || 'sunset');
}

async function handleStaffBookingWaiverGet(bookingId, query, res, user, deps) {
  const d = deps || {};
  const clientSlug = resolveClientSlug(query);
  if (clientSlug !== 'sunset') {
    return d.sendJSON(res, 403, { success: false, error: 'unsupported_client' });
  }
  if (d.assertStaffClientAccess && !d.assertStaffClientAccess(user, clientSlug, res)) return;
  if (!isUuid(bookingId)) {
    return d.sendJSON(res, 400, { success: false, error: 'booking_id is required' });
  }
  try {
    const result = await d.withPgClient((pg) => getBookingWaiverStatus(pg, {
      clientSlug,
      bookingId,
      locationId: query && query.location,
    }));
    return d.sendJSON(res, result.status, result.body);
  } catch (err) {
    console.error('[sunset-waiver-staff] GET', err && err.message);
    return d.sendJSON(res, 500, { success: false, error: 'read failed' });
  }
}

async function handleStaffBookingWaiverCreate(bookingId, query, req, res, user, deps) {
  const d = deps || {};
  let body = {};
  try {
    const raw = await d.readBody(req);
    body = JSON.parse(raw || '{}');
  } catch (_) {
    body = {};
  }
  delete body.tenant_id;
  delete body.tenantId;
  const clientSlug = resolveClientSlug(query, body);
  if (clientSlug !== 'sunset') {
    return d.sendJSON(res, 403, { success: false, error: 'unsupported_client' });
  }
  if (d.assertStaffClientAccess && !d.assertStaffClientAccess(user, clientSlug, res)) return;
  if (!isUuid(bookingId)) {
    return d.sendJSON(res, 400, { success: false, error: 'booking_id is required' });
  }
  try {
    const result = await d.withPgClient((pg) => createOrGetBookingWaiver(pg, {
      clientSlug,
      bookingId,
      locationId: (query && query.location) || body.location_id || body.location,
      source: body.source || 'staff_schedule_drawer',
    }));
    // Attach Luna invite fields when helper is available (no outbound guest messaging).
    let outBody = result.body;
    try {
      const { attachLunaWaiverFields } = require('./sunset-waiver-booking');
      if (result.ok && outBody) outBody = attachLunaWaiverFields(outBody);
    } catch (_) { /* booking helper optional for staff-only installs */ }
    return d.sendJSON(res, result.status, outBody);
  } catch (err) {
    console.error('[sunset-waiver-staff] POST', err && err.message, err && err.code);
    if (err && err.code === '42P01') {
      return d.sendJSON(res, 503, {
        success: false,
        error: 'migration_pending',
        message: 'Waiver tables not applied yet',
      });
    }
    return d.sendJSON(res, 500, { success: false, error: 'create failed' });
  }
}

async function handleStaffBookingWaiverSubmissionGet(bookingId, query, res, user, deps) {
  const d = deps || {};
  const clientSlug = resolveClientSlug(query);
  if (clientSlug !== 'sunset') {
    return d.sendJSON(res, 403, { success: false, error: 'unsupported_client' });
  }
  if (d.assertStaffClientAccess && !d.assertStaffClientAccess(user, clientSlug, res)) return;
  if (!isUuid(bookingId)) {
    return d.sendJSON(res, 400, { success: false, error: 'booking_id is required' });
  }
  try {
    const result = await d.withPgClient((pg) => getBookingWaiverSubmission(pg, {
      clientSlug,
      bookingId,
    }));
    return d.sendJSON(res, result.status, result.body);
  } catch (err) {
    console.error('[sunset-waiver-staff] submission GET', err && err.message);
    return d.sendJSON(res, 500, { success: false, error: 'read failed' });
  }
}

const STAFF_BOOKING_WAIVER_RE = /^\/staff\/schedule\/bookings\/([0-9a-f-]{36})\/waiver$/i;
const STAFF_BOOKING_WAIVER_SUBMISSION_RE = /^\/staff\/schedule\/bookings\/([0-9a-f-]{36})\/waiver\/submission$/i;

module.exports = {
  buildWaiverPrefillFromBooking,
  staffSafeWaiver,
  resolveGuestCount,
  multiStudentNote,
  getBookingWaiverStatus,
  createOrGetBookingWaiver,
  getBookingWaiverSubmission,
  handleStaffBookingWaiverGet,
  handleStaffBookingWaiverCreate,
  handleStaffBookingWaiverSubmissionGet,
  STAFF_BOOKING_WAIVER_RE,
  STAFF_BOOKING_WAIVER_SUBMISSION_RE,
  _hashWaiverToken: hashWaiverToken,
};
