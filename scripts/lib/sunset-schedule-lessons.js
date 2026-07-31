'use strict';

/**
 * Canonical multi-lesson model for Sunset schedule Create/Edit.
 *
 * Browser / transport may send lessons[] (preferred) or legacy single-course /
 * single-private component shapes. This module:
 *  - normalizes to ordered lessons[]
 *  - rejects mixed Group+Private
 *  - rejects only true identity duplicates (same-day multi-lesson is valid when
 *    course/time identity differs)
 *  - expands a compatibility components view for existing quote/create paths
 *  - derives unique calendar dates for course-equipment charging
 *
 * Money is never accepted from the client.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SCHEDULE_KEY = /^([01]\d|2[0-3])([0-5]\d)_([01]\d|2[0-3])([0-5]\d)$/;
const MAX_LESSONS = 30;

function isIsoDate(s) {
  return ISO_DATE.test(String(s || '').trim());
}

function isTimeHm(s) {
  return TIME_HM.test(String(s || '').trim());
}

function parseScheduleKey(raw) {
  const key = String(raw || '').trim();
  if (!key) return null;
  const m = SCHEDULE_KEY.exec(key);
  if (!m) return null;
  return {
    schedule_key: key,
    start: `${m[1]}:${m[2]}`,
    end: `${m[3]}:${m[4]}`,
  };
}

function timeToScheduleKey(start, end) {
  const s = String(start || '').trim();
  const e = String(end || '').trim();
  if (!isTimeHm(s) || !isTimeHm(e)) return null;
  return `${s.replace(':', '')}_${e.replace(':', '')}`;
}

function groupIdentity(lesson) {
  const courseId = String((lesson && lesson.course_id) || '').trim();
  const date = String((lesson && lesson.date) || '').slice(0, 10);
  const scheduleKey = String((lesson && lesson.schedule_key) || '').trim();
  const start = String((lesson && lesson.start) || '').trim();
  const end = String((lesson && lesson.end) || '').trim();
  const sk = scheduleKey || timeToScheduleKey(start, end) || '';
  return `group|${courseId}|${date}|${sk}`;
}

function privateIdentity(lesson) {
  const date = String((lesson && lesson.date) || '').slice(0, 10);
  const start = String((lesson && lesson.start) || '').trim();
  const end = String((lesson && lesson.end) || '').trim();
  return `private|${date}|${start}|${end}`;
}

function lessonIdentity(lesson) {
  if (!lesson) return '';
  return lesson.kind === 'private' ? privateIdentity(lesson) : groupIdentity(lesson);
}

function uniqueCalendarDates(lessons) {
  const set = new Set();
  (lessons || []).forEach((l) => {
    const d = String((l && l.date) || '').slice(0, 10);
    if (isIsoDate(d)) set.add(d);
  });
  return [...set].sort();
}

/**
 * Expand legacy single-course / single-private components into lessons[].
 * Does not invent mixed-mode records.
 */
function expandLegacyComponentsToLessons(components, serviceDates) {
  const comps = components && typeof components === 'object' ? components : {};
  const hasCourse = !!(comps.course && comps.course.course_id);
  const hasPrivate = !!(comps.private_lesson && Array.isArray(comps.private_lesson.sessions)
    && comps.private_lesson.sessions.length);
  if (hasCourse && hasPrivate) {
    return { ok: false, error: 'mixed_group_private_lessons', reason: 'mixed_group_private_lessons' };
  }
  if (!hasCourse && !hasPrivate) {
    return { ok: true, present: false, lessons: [], mode: null };
  }
  if (hasCourse) {
    const courseId = String(comps.course.course_id || '').trim();
    const label = comps.course.course_label != null ? String(comps.course.course_label).trim() : '';
    const tierKey = comps.course.tier_key != null ? String(comps.course.tier_key).trim() : '';
    const dates = Array.isArray(serviceDates) && serviceDates.length
      ? serviceDates.map((d) => String(d || '').slice(0, 10)).filter(isIsoDate)
      : [];
    if (!dates.length) {
      return { ok: false, error: 'group lessons require at least one service date' };
    }
    const lessons = dates.map((date) => {
      const row = { kind: 'group', course_id: courseId, date };
      if (label) row.course_label = label;
      if (tierKey) row.tier_key = tierKey;
      return row;
    });
    return { ok: true, present: true, lessons, mode: 'group' };
  }
  const sessions = comps.private_lesson.sessions;
  const lessons = [];
  for (let i = 0; i < sessions.length; i += 1) {
    const s = sessions[i] || {};
    const date = String(s.date || '').slice(0, 10);
    const start = String(s.start || '').trim();
    const end = String(s.end || '').trim();
    if (!isIsoDate(date) || !isTimeHm(start) || !isTimeHm(end)) {
      return { ok: false, error: `components.private_lesson.sessions[${i}] incomplete` };
    }
    lessons.push({ kind: 'private', date, start, end });
  }
  return { ok: true, present: true, lessons, mode: 'private' };
}

/**
 * Normalize transport lessons[] (preferred) or expand legacy components.
 * @returns {{ok:true, present:boolean, lessons:Array, mode:'group'|'private'|null, unique_dates:string[]}
 *          |{ok:false, error:string, reason?:string}}
 */
function normalizeCanonicalLessons(body, opts) {
  opts = opts || {};
  const b = body && typeof body === 'object' ? body : {};
  const hasLessonsField = Object.prototype.hasOwnProperty.call(b, 'lessons')
    // Validated create/quote bodies echo lessons:null when absent — treat null as omitted
    // so re-validation / re-quote does not fail closed on an explicit null.
    && b.lessons != null;

  if (hasLessonsField) {
    if (!Array.isArray(b.lessons)) {
      return { ok: false, error: 'lessons must be an array', reason: 'invalid_lessons' };
    }
    if (b.lessons.length > MAX_LESSONS) {
      return { ok: false, error: `lessons max ${MAX_LESSONS}`, reason: 'too_many_lessons' };
    }
    if (!b.lessons.length) {
      // Empty array = no class component (rental-only / empty allowed upstream).
      return { ok: true, present: false, lessons: [], mode: null, unique_dates: [] };
    }

    const lessons = [];
    let mode = null;
    const seen = new Set();

    for (let i = 0; i < b.lessons.length; i += 1) {
      const raw = b.lessons[i];
      if (!raw || typeof raw !== 'object') {
        return { ok: false, error: `lessons[${i}] must be an object`, reason: 'invalid_lessons' };
      }
      // Reject client money fields if present.
      for (const moneyKey of [
        'unit_amount_cents', 'amount_cents', 'total_cents', 'price', 'amount', 'label_price',
      ]) {
        if (raw[moneyKey] !== undefined && raw[moneyKey] !== null && raw[moneyKey] !== '') {
          return {
            ok: false,
            error: `lessons[${i}].${moneyKey} must not be supplied by the client`,
            reason: 'client_money_rejected',
          };
        }
      }

      const kindRaw = String(raw.kind || raw.mode || raw.type || '').trim().toLowerCase();
      const kind = kindRaw === 'private' || kindRaw === 'private_lesson'
        ? 'private'
        : (kindRaw === 'group' || kindRaw === 'course' || kindRaw === 'group_lesson'
          ? 'group' : null);
      if (!kind) {
        return { ok: false, error: `lessons[${i}].kind must be group or private`, reason: 'invalid_lesson_kind' };
      }
      if (mode && mode !== kind) {
        return {
          ok: false,
          error: 'mixed Group and Private lessons are not allowed on one booking',
          reason: 'mixed_group_private_lessons',
        };
      }
      mode = kind;

      const date = String(raw.date || raw.service_date || '').slice(0, 10);
      if (!isIsoDate(date)) {
        return { ok: false, error: `lessons[${i}].date must be YYYY-MM-DD`, reason: 'invalid_lesson_date' };
      }

      if (kind === 'group') {
        const courseId = String(raw.course_id || '').trim();
        if (!courseId) {
          return { ok: false, error: `lessons[${i}].course_id is required`, reason: 'invalid_lesson_course' };
        }
        let schedule_key = String(raw.schedule_key || '').trim();
        let start = String(raw.start || raw.start_time || '').trim();
        let end = String(raw.end || raw.end_time || '').trim();
        if (schedule_key) {
          const parsed = parseScheduleKey(schedule_key);
          if (!parsed) {
            return {
              ok: false,
              error: `lessons[${i}].schedule_key must be HHmm_HHmm`,
              reason: 'invalid_lesson_schedule',
            };
          }
          start = parsed.start;
          end = parsed.end;
          schedule_key = parsed.schedule_key;
        } else if (start || end) {
          if (!isTimeHm(start) || !isTimeHm(end)) {
            return {
              ok: false,
              error: `lessons[${i}].start/end must be HH:MM`,
              reason: 'invalid_lesson_time',
            };
          }
          schedule_key = timeToScheduleKey(start, end);
        }
        const row = { kind: 'group', course_id: courseId, date };
        if (schedule_key) {
          row.schedule_key = schedule_key;
          row.start = start;
          row.end = end;
        }
        if (raw.course_label != null && String(raw.course_label).trim()) {
          row.course_label = String(raw.course_label).trim().slice(0, 120);
        }
        if (raw.tier_key != null && String(raw.tier_key).trim()) {
          row.tier_key = String(raw.tier_key).trim();
        }
        const id = lessonIdentity(row);
        if (seen.has(id)) {
          return {
            ok: false,
            error: `duplicate lesson row at lessons[${i}]`,
            reason: 'duplicate_lesson',
          };
        }
        seen.add(id);
        lessons.push(row);
      } else {
        const start = String(raw.start || raw.start_time || '').trim();
        const end = String(raw.end || raw.end_time || '').trim();
        if (!isTimeHm(start) || !isTimeHm(end)) {
          return {
            ok: false,
            error: `lessons[${i}].start/end must be HH:MM`,
            reason: 'invalid_lesson_time',
          };
        }
        const startM = Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5));
        const endM = Number(end.slice(0, 2)) * 60 + Number(end.slice(3, 5));
        if (!(endM > startM)) {
          return {
            ok: false,
            error: `lessons[${i}].end must be after start`,
            reason: 'invalid_lesson_time',
          };
        }
        const row = { kind: 'private', date, start, end };
        const id = lessonIdentity(row);
        if (seen.has(id)) {
          return {
            ok: false,
            error: `duplicate lesson row at lessons[${i}]`,
            reason: 'duplicate_lesson',
          };
        }
        seen.add(id);
        lessons.push(row);
      }
    }

    // Stable ordered identity: date, then time/course.
    lessons.sort((a, b) => {
      const d = a.date.localeCompare(b.date);
      if (d) return d;
      if (a.kind === 'group' && b.kind === 'group') {
        const c = a.course_id.localeCompare(b.course_id);
        if (c) return c;
        return String(a.schedule_key || '').localeCompare(String(b.schedule_key || ''));
      }
      return String(a.start || '').localeCompare(String(b.start || ''))
        || String(a.end || '').localeCompare(String(b.end || ''));
    });

    return {
      ok: true,
      present: true,
      lessons,
      mode,
      unique_dates: uniqueCalendarDates(lessons),
    };
  }

  // Compatibility reader — legacy components only.
  // Accept the same date owners Create/Edit may send: service_dates[], singular
  // service_date, or date_from(/date_to). Do not invent multi-day spans from
  // check-in/out of unrelated commercial lines (e.g. accommodation).
  let legacyDates = null;
  if (Array.isArray(opts.serviceDates) && opts.serviceDates.length) {
    legacyDates = opts.serviceDates;
  } else if (Array.isArray(b.service_dates) && b.service_dates.length) {
    legacyDates = b.service_dates;
  } else if (b.service_date && isIsoDate(b.service_date)) {
    legacyDates = [String(b.service_date).slice(0, 10)];
  } else if (b.date_from && isIsoDate(b.date_from)) {
    const from = String(b.date_from).slice(0, 10);
    const to = (b.date_to && isIsoDate(b.date_to))
      ? String(b.date_to).slice(0, 10)
      : from;
    if (to < from) {
      return { ok: false, error: 'date_to must be on or after date_from' };
    }
    const span = [];
    // Inclusive calendar walk (UTC noon avoids DST edge noise).
    const start = new Date(`${from}T12:00:00Z`);
    const end = new Date(`${to}T12:00:00Z`);
    for (let cur = new Date(start); cur <= end; cur.setUTCDate(cur.getUTCDate() + 1)) {
      span.push(cur.toISOString().slice(0, 10));
      if (span.length > 31) break;
    }
    legacyDates = span;
  }
  const expanded = expandLegacyComponentsToLessons(b.components, legacyDates);
  if (!expanded.ok) return expanded;
  if (!expanded.present) {
    return { ok: true, present: false, lessons: [], mode: null, unique_dates: [] };
  }
  return {
    ok: true,
    present: true,
    lessons: expanded.lessons,
    mode: expanded.mode,
    unique_dates: uniqueCalendarDates(expanded.lessons),
  };
}

/**
 * Expand lessons[] into a components + service_dates view for legacy insert/quote
 * paths when the set is homogeneous enough. Multi-course group or same-day multi
 * group lessons keep a synthetic components.course only when a single course_id
 * is used; callers that need per-lesson rows should use lessons directly.
 */
function expandLessonsToLegacyComponents(lessons, surferCount) {
  const list = Array.isArray(lessons) ? lessons : [];
  if (!list.length) {
    return { ok: true, components: {}, service_dates: [], mode: null };
  }
  const mode = list[0].kind;
  if (list.some((l) => l.kind !== mode)) {
    return { ok: false, error: 'mixed_group_private_lessons', reason: 'mixed_group_private_lessons' };
  }
  const surfers = Math.max(1, Number(surferCount) || 1);
  const uniqueDates = uniqueCalendarDates(list);

  if (mode === 'private') {
    return {
      ok: true,
      mode: 'private',
      service_dates: uniqueDates,
      components: {
        private_lesson: {
          enabled: true,
          quantity: list.length,
          surfer_count: surfers,
          sessions: list.map((l, i) => ({
            date: l.date,
            start: l.start,
            end: l.end,
            index: i + 1,
          })),
        },
      },
    };
  }

  // Group — legacy component path uses the primary (first ordered) course for
  // surfer count / equipment owner. Multi-course bookings keep full lessons[].
  const courseIds = [...new Set(list.map((l) => l.course_id))];
  const multiCourse = courseIds.length !== 1;
  const courseId = String(list[0].course_id || '').trim();
  const label = list.find((l) => l.course_label)?.course_label || '';
  // Pack-tier optimization eligible only when single course and ≤1 lesson per day.
  const perDay = new Map();
  list.forEach((l) => {
    perDay.set(l.date, (perDay.get(l.date) || 0) + 1);
  });
  const multiSessionSameDay = [...perDay.values()].some((n) => n > 1);
  const entry = {
    course: {
      course_id: courseId,
      quantity: surfers,
    },
  };
  if (label) entry.course.course_label = label;
  // Prefer explicit tier_key when all lessons agree; otherwise derive from unique
  // calendar day count for the pack multi-date path (1_day … 7_days).
  const tiers = [...new Set(list.map((l) => String(l.tier_key || '').trim()).filter(Boolean))];
  if (tiers.length === 1) {
    entry.course.tier_key = tiers[0];
  } else if (!multiCourse && !multiSessionSameDay) {
    const dayCount = Math.min(7, Math.max(1, uniqueDates.length));
    entry.course.tier_key = dayCount === 1 ? '1_day' : `${dayCount}_days`;
  } else {
    // Multi-course or multi-session same day: each lesson is independently 1_day.
    entry.course.tier_key = '1_day';
  }

  return {
    ok: true,
    mode: 'group',
    multi_course: multiCourse,
    multi_session_same_day: multiSessionSameDay,
    service_dates: uniqueDates,
    components: entry,
    lessons: list,
  };
}

/** Ordered identity for fingerprints / idempotency. */
function canonicalLessonsForIntentFingerprint(lessons) {
  if (!Array.isArray(lessons) || !lessons.length) return [];
  return lessons.map((l) => {
    if (!l || typeof l !== 'object') return null;
    if (l.kind === 'private') {
      return {
        kind: 'private',
        date: String(l.date || '').slice(0, 10),
        start: String(l.start || '').trim(),
        end: String(l.end || '').trim(),
      };
    }
    return {
      kind: 'group',
      course_id: String(l.course_id || '').trim(),
      date: String(l.date || '').slice(0, 10),
      schedule_key: String(l.schedule_key || '').trim() || null,
      tier_key: String(l.tier_key || '').trim() || null,
    };
  }).filter(Boolean);
}

/**
 * Whether group lessons can use existing single-course pack multi-date path
 * (one course, at most one lesson per day).
 */
function canUsePackMultiDatePath(lessons) {
  if (!Array.isArray(lessons) || !lessons.length) return false;
  if (lessons.some((l) => l.kind !== 'group')) return false;
  const courseIds = new Set(lessons.map((l) => l.course_id));
  if (courseIds.size !== 1) return false;
  const perDay = new Map();
  for (const l of lessons) {
    const n = (perDay.get(l.date) || 0) + 1;
    if (n > 1) return false;
    perDay.set(l.date, n);
  }
  return true;
}

/**
 * Multi same-day or multi-course Group sets must price each lesson at its own
 * Admin course/tier amount (typically 1_day). Do not fold them into the first
 * course's pack date-range tier.
 */
function shouldPriceGroupLessonsIndividually(lessons) {
  if (!Array.isArray(lessons) || !lessons.length) return false;
  if (lessons.some((l) => l.kind !== 'group')) return false;
  if (lessons.length === 1) return false;
  return !canUsePackMultiDatePath(lessons);
}

/**
 * Reconstruct ordered canonical lessons from physical service rows.
 * Prefer explicit metadata.lesson_identity fields; never invent rows from a
 * outer date-range alone (same-day multi would collapse).
 */
function reconstructLessonsFromServiceRows(services) {
  const lessons = [];
  (services || []).forEach((sr) => {
    if (!sr) return;
    let meta = sr.metadata;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch (_) { meta = {}; }
    }
    meta = meta && typeof meta === 'object' ? meta : {};
    if (meta.course_equipment === true) return;
    if (meta.included_equipment === true) return;
    if (meta.rental_offering === true || meta.generic_rental === true) return;
    if (meta.staff_custom_line === true || meta.component === 'staff_custom_line') return;
    if (meta.component === 'full_day_equipment_extension'
      || meta.service_key === 'full_day_equipment_extension') return;

    const component = String(meta.component || sr.metadata_component || '').toLowerCase();
    const serviceType = String(sr.service_type || '').toLowerCase();
    const ui = String(sr.staff_ui_service_type || '').toLowerCase();
    const date = String(sr.service_date || meta.service_date || '').slice(0, 10);
    if (!isIsoDate(date)) return;

    if (component === 'private_lesson' || ui === 'private_lesson' || serviceType === 'private_lesson') {
      const start = String(
        sr.service_time_local || meta.slot_time || sr.slot_time || meta.start || '',
      ).trim();
      const end = String(sr.service_time_local_end || meta.end || '').trim();
      if (!isTimeHm(start) || !isTimeHm(end)) return;
      lessons.push({ kind: 'private', date, start, end });
      return;
    }

    const isCourse = component === 'course'
      || ui === 'course'
      || serviceType === 'course'
      || (serviceType === 'surf_lesson' && (meta.course_id || sr.course_id));
    if (!isCourse) return;

    const courseId = String(meta.course_id || sr.course_id || '').trim();
    if (!courseId) return;
    const row = { kind: 'group', course_id: courseId, date };
    let schedule_key = String(meta.schedule_key || '').trim();
    let start = String(meta.start || sr.service_time_local || meta.slot_time || '').trim();
    let end = String(meta.end || sr.service_time_local_end || '').trim();
    if (schedule_key) {
      const parsed = parseScheduleKey(schedule_key);
      if (parsed) {
        schedule_key = parsed.schedule_key;
        start = parsed.start;
        end = parsed.end;
      }
    } else if (isTimeHm(start) && isTimeHm(end)) {
      schedule_key = timeToScheduleKey(start, end);
    }
    if (schedule_key) {
      row.schedule_key = schedule_key;
      if (start) row.start = start;
      if (end) row.end = end;
    }
    if (meta.course_label || sr.course_label) {
      row.course_label = String(meta.course_label || sr.course_label).trim();
    }
    if (meta.tier_key) row.tier_key = String(meta.tier_key).trim();
    if (meta.offering_id) row.offering_id = String(meta.offering_id).trim();
    lessons.push(row);
  });

  if (!lessons.length) {
    return { ok: true, present: false, lessons: [], mode: null, unique_dates: [] };
  }
  return normalizeCanonicalLessons({ lessons });
}

/**
 * Canonical selected existing Group courses from components.course.
 * Prefer selected_courses (multi product buttons); fall back to single course_id.
 * Returns ordered { course_id, tier_key?, offering_id?, course_label? } only — no money/dates/times.
 */
function normalizeSelectedCourses(courseComp) {
  if (!courseComp || typeof courseComp !== 'object') return [];
  const out = [];
  const seen = new Set();
  const rawList = Array.isArray(courseComp.selected_courses) ? courseComp.selected_courses : null;
  if (rawList && rawList.length) {
    for (const raw of rawList) {
      if (!raw || typeof raw !== 'object') continue;
      const courseId = String(raw.course_id || '').trim();
      if (!courseId || seen.has(courseId)) continue;
      seen.add(courseId);
      const row = { course_id: courseId };
      const tierKey = String(raw.tier_key || '').trim();
      if (tierKey) row.tier_key = tierKey;
      const label = String(raw.course_label || raw.label || '').trim();
      if (label) row.course_label = label;
      const oid = String(raw.offering_id || '').trim();
      if (oid) row.offering_id = oid;
      out.push(row);
    }
  }
  if (!out.length) {
    const courseId = String(courseComp.course_id || '').trim();
    if (!courseId) return [];
    const row = { course_id: courseId };
    const tierKey = String(courseComp.tier_key || '').trim();
    if (tierKey) row.tier_key = tierKey;
    const label = String(courseComp.course_label || courseComp.label || '').trim();
    if (label) row.course_label = label;
    const oid = String(courseComp.offering_id || '').trim();
    if (oid) row.offering_id = oid;
    out.push(row);
  }
  return out;
}

module.exports = {
  MAX_LESSONS,
  isIsoDate,
  isTimeHm,
  parseScheduleKey,
  timeToScheduleKey,
  lessonIdentity,
  uniqueCalendarDates,
  expandLegacyComponentsToLessons,
  normalizeCanonicalLessons,
  expandLessonsToLegacyComponents,
  canonicalLessonsForIntentFingerprint,
  canUsePackMultiDatePath,
  shouldPriceGroupLessonsIndividually,
  reconstructLessonsFromServiceRows,
  normalizeSelectedCourses,
};
