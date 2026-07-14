'use strict';

/**
 * Canonical Sunset offering schedule / date eligibility.
 *
 * Use evaluateSunsetOfferingDates everywhere dates matter:
 * Schedule preflight, manual create, Luna catalog, availability, quote, booking create.
 *
 * Weekdays use Europe/Madrid calendar dates (ISO YYYY-MM-DD), not floating
 * local Date objects that flip across UTC midnight.
 */

const DEFAULT_TIMEZONE = 'Europe/Madrid';

const WEEKLY_TO_WEEKDAYS = {
  daily: [0, 1, 2, 3, 4, 5, 6],
  mon_fri: [1, 2, 3, 4, 5],
  weekdays: [1, 2, 3, 4, 5],
  sat_sun: [0, 6],
  weekends: [0, 6],
};

function isoDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

/**
 * Spain-local calendar weekday for an ISO date key.
 * Noon UTC keeps the civil date stable across CET/CEST for Spanish summer dates.
 */
function weekdayOfIsoDate(iso, _timezone = DEFAULT_TIMEZONE) {
  const key = isoDate(iso);
  if (!key) return null;
  return new Date(`${key}T12:00:00Z`).getUTCDay();
}

function weekdaysFromWeekly(weekly) {
  const w = String(weekly || '').trim().toLowerCase();
  if (WEEKLY_TO_WEEKDAYS[w]) return WEEKLY_TO_WEEKDAYS[w].slice();
  return [];
}

function normalizeAllowedWeekdays(schedule) {
  if (!schedule || typeof schedule !== 'object') return [];
  if (Array.isArray(schedule.allowed_weekdays) && schedule.allowed_weekdays.length) {
    return schedule.allowed_weekdays.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  }
  if (Array.isArray(schedule.weekdays) && schedule.weekdays.length) {
    return schedule.weekdays.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  }
  return weekdaysFromWeekly(schedule.weekly);
}

function scheduleSummary(schedule) {
  const weekly = String((schedule && schedule.weekly) || '').trim();
  if (weekly === 'sat_sun' || weekly === 'weekends') return 'Weekends only';
  if (weekly === 'mon_fri' || weekly === 'weekdays') return 'Weekdays only (Monday–Friday)';
  if (weekly === 'daily') return 'Daily';
  const days = normalizeAllowedWeekdays(schedule);
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'Weekends only';
  if (days.length === 5 && !days.includes(0) && !days.includes(6)) {
    return 'Weekdays only (Monday–Friday)';
  }
  if (days.length === 7) return 'Daily';
  return weekly || null;
}

function staffFacingOfferingScheduleError(reasonCode, detail) {
  const code = String(reasonCode || '');
  const allowed = (detail && detail.allowed_weekdays) || [];
  if (code === 'service_dates_not_on_course_schedule'
    || code === 'offering_not_available_on_dates'
    || code === 'weekday_not_allowed') {
    if (allowed.length === 2 && allowed.includes(0) && allowed.includes(6)) {
      return {
        error: 'This course runs on weekends. Choose a Saturday or Sunday.',
        reason_code: 'service_dates_not_on_course_schedule',
      };
    }
    if (allowed.length === 5 && !allowed.includes(0) && !allowed.includes(6)) {
      return {
        error: 'This course runs on weekdays (Monday–Friday).',
        reason_code: 'service_dates_not_on_course_schedule',
      };
    }
    return {
      error: 'This course is not available on the selected dates.',
      reason_code: 'service_dates_not_on_course_schedule',
    };
  }
  if (code === 'course_schedule_not_configured' || code === 'schedule_not_configured') {
    return {
      error: 'This option is not currently bookable.',
      reason_code: code,
    };
  }
  if (code === 'outside_effective_range' || code === 'excluded_date') {
    return {
      error: 'This course is not available on the selected dates.',
      reason_code: code,
    };
  }
  return { error: code || 'offering_not_available_on_dates', reason_code: code || 'offering_not_available_on_dates' };
}

/**
 * @param {object} offering - pack, catalog offering, or { schedule | weekly | weekdays }
 * @param {string[]} requestedDates - ISO date strings
 * @param {{ timezone?: string }} opts
 */
function evaluateSunsetOfferingDates(offering, requestedDates, opts = {}) {
  const timezone = opts.timezone || DEFAULT_TIMEZONE;
  const schedule = (offering && offering.schedule && typeof offering.schedule === 'object')
    ? offering.schedule
    : {
      weekly: offering && (offering.weekly || (offering.pack && offering.pack.weekly)),
      weekdays: offering && offering.weekdays,
      allowed_weekdays: offering && offering.allowed_weekdays,
      specific_dates: offering && offering.specific_dates,
      excluded_dates: offering && offering.excluded_dates,
      starts_on: offering && (offering.starts_on || offering.effective_from),
      ends_on: offering && (offering.ends_on || offering.effective_to),
      time_slots: offering && (offering.time_slots || offering.schedules),
    };

  const dates = [...new Set((requestedDates || []).map(isoDate).filter(Boolean))];
  if (!dates.length) {
    return {
      ok: false,
      reason: 'service_dates_required',
      timezone,
      eligible: false,
      dates: [],
      allowed_weekdays: normalizeAllowedWeekdays(schedule),
      schedule_summary: scheduleSummary(schedule),
    };
  }

  const specific = (schedule.specific_dates || []).map(isoDate).filter(Boolean);
  const excluded = new Set((schedule.excluded_dates || []).map(isoDate).filter(Boolean));
  const startsOn = isoDate(schedule.starts_on);
  const endsOn = isoDate(schedule.ends_on);
  const allowed = specific.length ? null : normalizeAllowedWeekdays(schedule);

  if (!specific.length && (!allowed || !allowed.length)) {
    return {
      ok: false,
      reason: 'course_schedule_not_configured',
      timezone,
      eligible: false,
      dates,
      allowed_weekdays: [],
      schedule_summary: scheduleSummary(schedule),
      staff_error: staffFacingOfferingScheduleError('course_schedule_not_configured'),
    };
  }

  for (const iso of dates) {
    if (excluded.has(iso)) {
      return {
        ok: false,
        reason: 'excluded_date',
        timezone,
        eligible: false,
        dates,
        detail: { date: iso },
        allowed_weekdays: allowed || [],
        schedule_summary: scheduleSummary(schedule),
        staff_error: staffFacingOfferingScheduleError('excluded_date', { date: iso }),
      };
    }
    if (startsOn && iso < startsOn) {
      return {
        ok: false,
        reason: 'outside_effective_range',
        timezone,
        eligible: false,
        dates,
        detail: { date: iso, starts_on: startsOn },
        allowed_weekdays: allowed || [],
        schedule_summary: scheduleSummary(schedule),
        staff_error: staffFacingOfferingScheduleError('outside_effective_range'),
      };
    }
    if (endsOn && iso > endsOn) {
      return {
        ok: false,
        reason: 'outside_effective_range',
        timezone,
        eligible: false,
        dates,
        detail: { date: iso, ends_on: endsOn },
        allowed_weekdays: allowed || [],
        schedule_summary: scheduleSummary(schedule),
        staff_error: staffFacingOfferingScheduleError('outside_effective_range'),
      };
    }
    if (specific.length) {
      if (!specific.includes(iso)) {
        return {
          ok: false,
          reason: 'offering_not_available_on_dates',
          timezone,
          eligible: false,
          dates,
          detail: { date: iso, specific_dates: specific },
          allowed_weekdays: [],
          schedule_summary: scheduleSummary(schedule),
          staff_error: staffFacingOfferingScheduleError('offering_not_available_on_dates'),
        };
      }
      continue;
    }
    const wd = weekdayOfIsoDate(iso, timezone);
    if (!allowed.includes(wd)) {
      return {
        ok: false,
        reason: 'service_dates_not_on_course_schedule',
        timezone,
        eligible: false,
        dates,
        detail: { date: iso, weekday: wd, allowed_weekdays: allowed },
        allowed_weekdays: allowed,
        schedule_summary: scheduleSummary(schedule),
        staff_error: staffFacingOfferingScheduleError('service_dates_not_on_course_schedule', {
          allowed_weekdays: allowed,
        }),
      };
    }
  }

  return {
    ok: true,
    reason: null,
    timezone,
    eligible: true,
    dates,
    allowed_weekdays: allowed || weekdaysFromWeekly('daily'),
    schedule_summary: scheduleSummary(schedule),
  };
}

function datesBelongToPackSchedule(pack, serviceDates, opts) {
  const result = evaluateSunsetOfferingDates({
    weekly: pack && pack.weekly,
    weekdays: pack && pack.weekdays,
    schedule: pack && pack.schedule,
    specific_dates: pack && pack.specific_dates,
    excluded_dates: pack && pack.excluded_dates,
    starts_on: pack && pack.starts_on,
    ends_on: pack && pack.ends_on,
  }, serviceDates, opts);
  if (!result.ok) {
    return {
      ok: false,
      error: result.reason,
      detail: result.detail || null,
      staff_error: result.staff_error || null,
    };
  }
  return {
    ok: true,
    dates: result.dates,
    allowed_weekdays: result.allowed_weekdays,
  };
}

module.exports = {
  DEFAULT_TIMEZONE,
  isoDate,
  weekdayOfIsoDate,
  weekdaysFromWeekly,
  weekdaysFromPackWeekly: weekdaysFromWeekly,
  normalizeAllowedWeekdays,
  scheduleSummary,
  evaluateSunsetOfferingDates,
  datesBelongToPackSchedule,
  staffFacingOfferingScheduleError,
};
