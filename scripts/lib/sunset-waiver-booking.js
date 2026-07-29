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

function resolveWaiverCounts(input) {
  const src = input || {};
  const waiver = src.waiver || {};
  const target = waiver.target_count != null
    ? Number(waiver.target_count)
    : (src.target_count != null ? Number(src.target_count) : null);
  const completed = waiver.completed_count != null
    ? Number(waiver.completed_count)
    : (src.completed_count != null ? Number(src.completed_count) : 0);
  return {
    target: Number.isFinite(target) ? target : null,
    completed: Number.isFinite(completed) ? completed : 0,
  };
}

function isGroupWaiver(input) {
  const src = input || {};
  const waiver = src.waiver || {};
  if (waiver.request_mode === 'group') return true;
  if (src.expected_request_mode === 'group') return true;
  const guestCount = Number(
    src.guest_count != null ? src.guest_count : waiver.guest_count,
  ) || 1;
  return guestCount > 1;
}

/**
 * Spanish guest copy — invite to complete hosted form.
 */
function buildLunaWaiverInviteMessage(input) {
  const src = input || {};
  const link = trimStr(src.public_url || src.publicUrl || (src.waiver && src.waiver.public_url));
  const isGroup = isGroupWaiver(src);
  const { target, completed } = resolveWaiverCounts(src);

  if (isGroup) {
    let msg = 'Perfecto — para este grupo, aquí tienes un solo enlace de Sunset que puedes enviar a todos los alumnos.\n\nCada alumno debe abrir el mismo enlace y completar su formulario antes de la clase:';
    if (link) msg += `\n${link}`;
    msg += '\n\nIré controlando cuántos formularios están completos.';
    if (target != null && target > 0 && completed > 0 && completed < target) {
      msg += `\n\nVan ${completed} de ${target} formularios completos.`;
    }
    return msg;
  }

  let msg = 'Perfecto — para terminar la inscripción, Sunset necesita un formulario rápido de seguro y responsabilidad antes de la clase. Ya he rellenado lo que sabemos, así que solo debería llevar unos 2 minutos:';
  if (link) msg += `\n${link}`;
  return msg;
}

function buildLunaWaiverCompletedMessage(input) {
  const src = input || {};
  if (isGroupWaiver(src)) {
    const { target } = resolveWaiverCounts(src);
    const guestCount = Number(src.guest_count) || 1;
    const n = (target != null && target > 0) ? target : guestCount;
    return `Perfecto, ya están completos los ${n} formularios del grupo. Queda registrado para la clase 🌊`;
  }
  return 'Perfecto, tu formulario de Sunset está completo. Ya queda registrado para la clase 🌊';
}

function buildLunaWaiverPendingReminderMessage(input) {
  const src = input || {};
  const link = trimStr((src.public_url || src.publicUrl)
    || (src.waiver && src.waiver.public_url));
  const isGroup = isGroupWaiver(src);
  const { target, completed } = resolveWaiverCounts(src);

  if (isGroup) {
    let msg = 'Todavía faltan formularios del grupo antes de la clase.';
    if (target != null && target > 0) {
      msg += ` Van ${completed} de ${target} completos.`;
    }
    msg += ' Puedes reenviar este mismo enlace a los alumnos que falten:';
    if (link) msg += `\n${link}`;
    return msg;
  }

  let msg = 'Te falta completar el formulario de inscripción de Sunset antes de la clase. Te lo dejo aquí otra vez:';
  if (link) msg += `\n${link}`;
  return msg;
}

function buildLunaWaiverProgressMessage(input) {
  const { target, completed } = resolveWaiverCounts(input);
  if (target == null || target < 1) return null;
  if (completed >= target) return null;
  return `Van ${completed} de ${target} formularios completos.`;
}

/**
 * Gate “ready for lesson” wording — never claim ready while waiver pending.
 */
function buildLunaLessonReadyMessage(waiverOrStatus) {
  if (!isLessonReadyForGuest(waiverOrStatus)) return null;
  const payload = (waiverOrStatus && typeof waiverOrStatus === 'object')
    ? { waiver: waiverOrStatus }
    : null;
  return buildLunaWaiverCompletedMessage(payload);
}

/**
 * Compose the right Luna reply from a waiver ensure/status body.
 * mode: 'invite' | 'reminder' | 'status' (default invite for pending/missing)
 */
function composeLunaWaiverReply(body, mode) {
  const b = body || {};
  const waiver = b.waiver || null;
  const m = String(mode || 'invite').toLowerCase();
  const urlPayload = {
    public_url: waiver && waiver.public_url,
    guest_count: b.guest_count,
    expected_request_mode: b.expected_request_mode,
    target_count: b.target_count,
    completed_count: b.completed_count,
    waiver,
  };

  if (isLessonReadyForGuest(waiver || (b.waiver_status || 'missing'))) {
    return buildLunaWaiverCompletedMessage(urlPayload);
  }
  if (m === 'reminder') {
    return buildLunaWaiverPendingReminderMessage(urlPayload);
  }
  if (m === 'status') {
    const progress = buildLunaWaiverProgressMessage(urlPayload);
    if (progress) return progress;
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

function bookingCreateResultNeedsWaiver(body) {
  const records = body && Array.isArray(body.records) ? body.records : [];
  return records.some((row) => {
    const type = String(row && (row._scheduleType || row.service_type) || '').toLowerCase();
    return type === 'lesson' || type === 'course' || type === 'private_lesson' || type === 'surf_lesson';
  });
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
  bookingCreateResultNeedsWaiver,
  isLessonReadyForGuest,
  resolveWaiverLane,
  buildLunaWaiverInviteMessage,
  buildLunaWaiverCompletedMessage,
  buildLunaWaiverPendingReminderMessage,
  buildLunaWaiverProgressMessage,
  buildLunaLessonReadyMessage,
  composeLunaWaiverReply,
  attachLunaWaiverFields,
  isGroupWaiver,
  resolveWaiverCounts,
  multiStudentNote,
  resolveGuestCount,
  getBookingWaiverStatus,
  DEFAULT_STAGING_BASE_URL,
};
