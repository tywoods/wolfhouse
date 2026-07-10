'use strict';

/**
 * Sunset waiver + Luna booking reply helpers.
 * Tenant-scoped to sunset. No WhatsApp send. No Wolfhouse coupling.
 */

const {
  createOrGetBookingWaiver,
  getBookingWaiverStatus,
  multiStudentNote,
  resolveGuestCount,
} = require('./sunset-waiver-staff');
const { DEFAULT_STAGING_BASE_URL } = require('./sunset-waiver-model');

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * Ensure a waiver exists for a Sunset booking (create or reuse pending/completed).
 * Same prefill/create path as staff drawer.
 */
async function ensureWaiverForBooking(pg, bookingId, options) {
  const opts = options || {};
  const id = typeof bookingId === 'string' ? bookingId : (opts.bookingId || opts.booking_id);
  const result = await createOrGetBookingWaiver(pg, {
    clientSlug: 'sunset',
    bookingId: id,
    locationId: opts.locationId || opts.location_id,
    baseUrl: opts.baseUrl || opts.base_url,
    env: opts.env,
    source: opts.source || 'luna_booking',
  });
  if (result && result.ok && result.body) {
    result.body = attachLunaWaiverFields(result.body);
  }
  return result;
}

/**
 * @param {object|string} waiverOrStatus — waiver object (preferred) or legacy status string
 */
function isLessonReadyForGuest(waiverOrStatus) {
  if (waiverOrStatus && typeof waiverOrStatus === 'object') {
    const w = waiverOrStatus;
    const mode = w.request_mode || 'single';
    if (mode === 'group') {
      const target = Number(w.target_count);
      const completed = Number(w.completed_count);
      if (!Number.isFinite(target) || target < 1) return false;
      return completed >= target;
    }
    return String(w.status || '').toLowerCase() === 'completed';
  }
  return String(waiverOrStatus || '').toLowerCase() === 'completed';
}

function resolveWaiverLane(waiverStatus) {
  const s = String(waiverStatus || '').toLowerCase();
  if (!s || s === 'missing') return 'missing';
  if (s === 'completed') return 'completed';
  if (s === 'needs_review') return 'needs_review';
  if (s === 'expired' || s === 'revoked') return 'unavailable';
  if (s === 'pending') return 'pending';
  return s;
}

/**
 * Spanish guest copy — invite to complete hosted form.
 */
function buildLunaWaiverInviteMessage(input) {
  const src = input || {};
  const link = trimStr(src.public_url || src.publicUrl || (src.waiver && src.waiver.public_url));
  const guestCount = Number(
    src.guest_count != null ? src.guest_count : (src.waiver && src.guest_count),
  ) || 1;
  const note = src.multi_student_note
    || (guestCount > 1
      ? 'Comparte este enlace con el grupo. Cada alumno debe completar el formulario una vez.'
      : null);

  let msg = 'Perfecto — para terminar la inscripción, Sunset necesita un formulario rápido de seguro y responsabilidad antes de la clase. Ya he rellenado lo que sabemos, así que solo debería llevar unos 2 minutos:';
  if (link) msg += `\n${link}`;
  if (note) msg += `\n\n${note}`;
  return msg;
}

function buildLunaWaiverCompletedMessage() {
  return 'Perfecto, tu formulario de Sunset está completo. Ya queda registrado para la clase 🌊';
}

function buildLunaWaiverPendingReminderMessage(input) {
  const link = trimStr((input && (input.public_url || input.publicUrl))
    || (input && input.waiver && input.waiver.public_url));
  let msg = 'Te falta completar el formulario de inscripción de Sunset antes de la clase. Te lo dejo aquí otra vez:';
  if (link) msg += `\n${link}`;
  return msg;
}

/**
 * Gate “ready for lesson” wording — never claim ready while waiver pending.
 */
function buildLunaLessonReadyMessage(waiverStatus) {
  if (isLessonReadyForGuest(waiverStatus)) {
    return buildLunaWaiverCompletedMessage();
  }
  return null;
}

/**
 * Compose the right Luna reply from a waiver ensure/status body.
 * mode: 'invite' | 'reminder' | 'status' (default invite for pending/missing)
 */
function composeLunaWaiverReply(body, mode) {
  const b = body || {};
  const waiver = b.waiver || null;
  const status = waiver ? waiver.status : (b.waiver_status || 'missing');
  const lane = resolveWaiverLane(status);
  const m = String(mode || 'invite').toLowerCase();
  const urlPayload = {
    public_url: waiver && waiver.public_url,
    guest_count: b.guest_count,
    multi_student_note: b.multi_student_note,
    waiver,
  };

  if (lane === 'completed') {
    return buildLunaWaiverCompletedMessage();
  }
  if (m === 'reminder') {
    return buildLunaWaiverPendingReminderMessage(urlPayload);
  }
  return buildLunaWaiverInviteMessage(urlPayload);
}

/**
 * Attach Luna-facing fields onto an ensure/create result body.
 */
function attachLunaWaiverFields(body) {
  const b = body && typeof body === 'object' ? { ...body } : {};
  const waiver = b.waiver || null;
  const status = waiver ? waiver.status : (b.waiver_status || 'missing');
  b.luna_waiver_message = composeLunaWaiverReply(b, 'invite');
  b.lesson_ready = waiver ? isLessonReadyForGuest(waiver) : isLessonReadyForGuest(status);
  b.waiver_lane = resolveWaiverLane(status);
  if (!b.lesson_ready) {
    b.lesson_ready_blocked_reason = 'waiver_not_completed';
  } else {
    delete b.lesson_ready_blocked_reason;
  }
  return b;
}

/**
 * Soft-fail wrapper for booking-create paths when migration is not applied.
 */
async function ensureWaiverForBookingSoft(pg, bookingId, options) {
  try {
    return await ensureWaiverForBooking(pg, bookingId, options);
  } catch (err) {
    if (err && (err.code === '42P01' || /waiver_form_requests/i.test(err.message || ''))) {
      return {
        ok: false,
        status: 503,
        body: {
          success: false,
          error: 'migration_pending',
          message: 'Waiver tables not applied yet',
        },
      };
    }
    throw err;
  }
}

module.exports = {
  ensureWaiverForBooking,
  ensureWaiverForBookingSoft,
  isLessonReadyForGuest,
  resolveWaiverLane,
  buildLunaWaiverInviteMessage,
  buildLunaWaiverCompletedMessage,
  buildLunaWaiverPendingReminderMessage,
  buildLunaLessonReadyMessage,
  composeLunaWaiverReply,
  attachLunaWaiverFields,
  multiStudentNote,
  resolveGuestCount,
  getBookingWaiverStatus,
  DEFAULT_STAGING_BASE_URL,
};
