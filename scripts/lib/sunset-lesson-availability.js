'use strict';

/**
 * Sunset guest lesson availability — course/slot leftover aligned with Horario
 * (joinable-courses), not the all-day daily cap.
 *
 * Timed class requests (e.g. Thursday 10:00) must use the matching Admin
 * course's group_size − confirmed course seats. Daily 24 − all surf_lessons
 * is only the date-only fallback when no slot/course is named.
 */

const {
  listJoinableSunsetOfferings,
  parsePackScheduleKey,
} = require('./sunset-admin-course-join');

const SUNSET_CLIENT_SLUG = 'sunset';

/**
 * Normalize guest/tool time to HH:MM. Accepts "10:00", "10:00-12:00", "1000".
 * Returns null when unparseable — never invent a slot.
 */
function normalizeLessonAvailabilityTime(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const range = s.match(/^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?\s*[-–—]\s*\d/);
  if (range) {
    return `${String(Number(range[1])).padStart(2, '0')}:${range[2]}`;
  }
  const hm = s.match(/^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/);
  if (hm) {
    const hour = Number(hm[1]);
    if (hour > 23) return null;
    return `${String(hour).padStart(2, '0')}:${hm[2]}`;
  }
  const compact = s.match(/^([01]\d|2[0-3])([0-5]\d)$/);
  if (compact) return `${compact[1]}:${compact[2]}`;
  const pack = parsePackScheduleKey(s);
  if (pack) return pack.start_time;
  return null;
}

function courseScheduleStarts(course) {
  const starts = [];
  const push = (raw) => {
    const hm = normalizeLessonAvailabilityTime(raw);
    if (hm && !starts.includes(hm)) starts.push(hm);
  };
  for (const slot of course && course.schedules ? course.schedules : []) {
    if (!slot) continue;
    if (typeof slot === 'string') {
      const parsed = parsePackScheduleKey(slot);
      push(parsed ? parsed.start_time : slot);
      continue;
    }
    push(slot.start_time || slot.start || slot.key);
  }
  if (course && course.slot_time) {
    const parsed = parsePackScheduleKey(course.slot_time);
    push(parsed ? parsed.start_time : course.slot_time);
  }
  return starts;
}

function courseMatchesAvailabilitySlot(course, slotHm) {
  if (!slotHm) return false;
  return courseScheduleStarts(course).includes(slotHm);
}

/**
 * Pick the Horario/joinable course for a timed (or course_id) availability check.
 * Fail closed on zero/ambiguous matches — never invent leftover.
 */
function pickJoinableCourseForAvailability(courses, { courseId, slotTime } = {}) {
  const list = Array.isArray(courses) ? courses : [];
  const wantedId = courseId != null && String(courseId).trim() ? String(courseId).trim() : null;
  const slotHm = normalizeLessonAvailabilityTime(slotTime);

  if (wantedId) {
    const byId = list.filter((c) => String(c.course_id || c.pack_id || '') === wantedId);
    if (!byId.length) {
      return { ok: false, reason: 'unknown_course_id', slot_time: slotHm };
    }
    if (slotHm) {
      const timed = byId.filter((c) => courseMatchesAvailabilitySlot(c, slotHm));
      if (!timed.length) {
        return { ok: false, reason: 'course_slot_mismatch', slot_time: slotHm, course_id: wantedId };
      }
      if (timed.length > 1) {
        return { ok: false, reason: 'ambiguous_course_slot', slot_time: slotHm, course_id: wantedId };
      }
      return { ok: true, course: timed[0], slot_time: slotHm };
    }
    if (byId.length > 1) {
      return { ok: false, reason: 'ambiguous_course_id', course_id: wantedId };
    }
    return { ok: true, course: byId[0], slot_time: null };
  }

  if (!slotHm) {
    return { ok: false, reason: 'slot_time_required' };
  }

  const matches = list.filter((c) => courseMatchesAvailabilitySlot(c, slotHm));
  if (!matches.length) {
    return { ok: false, reason: 'no_matching_course_slot', slot_time: slotHm };
  }
  if (matches.length > 1) {
    return { ok: false, reason: 'ambiguous_course_slot', slot_time: slotHm };
  }
  return { ok: true, course: matches[0], slot_time: slotHm };
}

function parseRequestedQuantity(raw) {
  const n = raw != null ? Number(raw) : null;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * Build the Staff bot payload from one enriched joinable course (Horario math).
 * seats_available is course remaining — never daily_cap − all-day booked.
 */
function buildCourseSlotAvailabilityResult({
  course,
  quantity,
  dateIso,
  locationId,
  slotTime,
  clientSlug = SUNSET_CLIENT_SLUG,
}) {
  const capacity = course && course.capacity != null
    ? Number(course.capacity)
    : (course && course.group_size != null ? Number(course.group_size) : null);
  if (!Number.isFinite(capacity) || capacity <= 0) {
    return {
      ok: true,
      success: true,
      client_slug: clientSlug,
      location_id: locationId,
      date: dateIso,
      capacity_known: false,
      take_request: true,
      reason: 'course_capacity_not_configured',
      course_id: course && (course.course_id || course.pack_id) || null,
      slot_time: slotTime || null,
      scope: 'course_slot',
    };
  }

  const seatsBooked = course.seats_booked != null ? Number(course.seats_booked) : 0;
  const booked = Number.isFinite(seatsBooked) && seatsBooked >= 0 ? seatsBooked : 0;
  const remainingRaw = course.seats_remaining != null
    ? Number(course.seats_remaining)
    : (capacity - booked);
  const seatsAvailable = Math.max(0, Number.isFinite(remainingRaw) ? remainingRaw : 0);
  const requestedQuantity = parseRequestedQuantity(quantity);
  const hasSeats = requestedQuantity != null
    ? seatsAvailable >= requestedQuantity
    : seatsAvailable > 0;

  return {
    ok: true,
    success: true,
    client_slug: clientSlug,
    location_id: locationId,
    date: dateIso,
    capacity_known: true,
    scope: 'course_slot',
    course_id: course.course_id || course.pack_id || null,
    course_label: course.label || null,
    slot_time: slotTime || null,
    // Authoritative leftover for this timed class (Horario / joinable-courses).
    course_capacity: capacity,
    seats_booked: booked,
    seats_available: seatsAvailable,
    // Keep response field for plugin compatibility; timed path is not daily.
    daily_capacity: null,
    requested_quantity: requestedQuantity,
    has_seats: hasSeats,
    take_request: !hasSeats,
    reason: hasSeats
      ? null
      : (requestedQuantity != null && seatsAvailable > 0 ? 'insufficient_seats' : 'no_seats_available'),
  };
}

/**
 * Resolve guest lesson availability for a timed class / course_id against the
 * same joinable-courses enrichment Horario uses.
 */
async function resolveCourseScopedLessonAvailability(pg, {
  locationId,
  dateIso,
  quantity,
  slotTime,
  courseId,
  clientSlug = SUNSET_CLIENT_SLUG,
} = {}) {
  const listed = await listJoinableSunsetOfferings(pg, {
    clientSlug,
    locationId,
    date: dateIso,
    includeFull: true,
  });
  if (!listed.ok) {
    return {
      ok: true,
      success: true,
      client_slug: clientSlug,
      location_id: locationId,
      date: dateIso,
      capacity_known: false,
      take_request: true,
      reason: listed.reason || 'capacity_unavailable',
      scope: 'course_slot',
      slot_time: normalizeLessonAvailabilityTime(slotTime),
      course_id: courseId || null,
    };
  }

  const picked = pickJoinableCourseForAvailability(listed.courses, { courseId, slotTime });
  if (!picked.ok) {
    return {
      ok: true,
      success: true,
      client_slug: clientSlug,
      location_id: locationId,
      date: dateIso,
      capacity_known: false,
      take_request: true,
      reason: picked.reason,
      scope: 'course_slot',
      slot_time: picked.slot_time || normalizeLessonAvailabilityTime(slotTime),
      course_id: courseId || picked.course_id || null,
    };
  }

  const course = picked.course;
  if (course && course.joinable === false && (course.seats_remaining == null || Number(course.seats_remaining) <= 0)) {
    // include_full may surface weekday-mismatched or empty courses; still use
    // their Staff remaining when present, otherwise fail closed.
    if (course.weekdays && course.weekdays.length && course.seats_booked == null) {
      return {
        ok: true,
        success: true,
        client_slug: clientSlug,
        location_id: locationId,
        date: dateIso,
        capacity_known: false,
        take_request: true,
        reason: 'course_not_offered_on_date',
        scope: 'course_slot',
        slot_time: picked.slot_time,
        course_id: course.course_id || course.pack_id || null,
      };
    }
  }

  return buildCourseSlotAvailabilityResult({
    course,
    quantity,
    dateIso,
    locationId,
    slotTime: picked.slot_time,
    clientSlug,
  });
}

function extractLessonAvailabilitySlotFromBody(body) {
  if (!body || typeof body !== 'object') return null;
  const raw = body.slot_time != null
    ? body.slot_time
    : (body.time != null
      ? body.time
      : (body.start_time != null ? body.start_time : null));
  return normalizeLessonAvailabilityTime(raw);
}

module.exports = {
  SUNSET_CLIENT_SLUG,
  normalizeLessonAvailabilityTime,
  courseScheduleStarts,
  courseMatchesAvailabilitySlot,
  pickJoinableCourseForAvailability,
  parseRequestedQuantity,
  buildCourseSlotAvailabilityResult,
  resolveCourseScopedLessonAvailability,
  extractLessonAvailabilitySlotFromBody,
};
