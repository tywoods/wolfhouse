'use strict';

/**
 * Sunset Schedule — manual booking writes (bookings + booking_service_records).
 * Supports component combos, courses, private lessons, and multi-date via one booking header + many service records.
 */

const crypto = require('crypto');
const { loadPrivateLessonFromDb, defaultPrivateLessonApi } = require('./sunset-admin-private-lesson-rules');

// Resolve the per-person-per-day add-on unit price from school-scoped admin config (config/DB backed).
// Returns integer cents or null when unconfigured/disabled. Never hard-codes €10.
// Requires are deferred to avoid an eager require cycle with tenant-business-config/stripe-links.
async function resolveFullDayEquipmentAddonUnitCents(pg, clientSlug, locationId) {
  const { resolveTenantBusinessConfigAsync } = require('./tenant-business-config');
  const {
    findPriceCents,
    FULL_DAY_EQUIPMENT_ADDON_KEY: addonKey,
    FULL_DAY_EQUIPMENT_ADDON_UNIT: addonUnit,
  } = require('./sunset-stripe-payment-links');
  let adminCfg;
  try {
    adminCfg = await resolveTenantBusinessConfigAsync(clientSlug, { pgClient: pg, locationId });
  } catch (_) {
    adminCfg = null;
  }
  const prices = adminCfg && adminCfg.ok ? (adminCfg.prices || []) : [];
  const cents = findPriceCents(prices, 'rental', addonKey, addonUnit);
  return cents != null && cents > 0 ? cents : null;
}

const SUNSET_CLIENT_SLUG = 'sunset';
const METADATA_SOURCE_TAG = 'staff_manual_schedule';
const DB_SOURCE = 'staff_manual';
const DEFAULT_LESSON_CATEGORY = 'Adult (Over 12)';
const PRIVATE_LESSON_MAX_SESSIONS = 30;

// Add-on: "Material el resto del día" (full-day equipment extension). Per person, per date.
// Distinct shape from the per-booking components above: it carries a per-date { date -> quantity } map
// and eligibility is derived from the eligible course/rental dates on the booking.
const FULL_DAY_EQUIPMENT_ADDON_KEY = 'full_day_equipment_extension';
const FULL_DAY_EQUIPMENT_ADDON_BILLING_UNIT = 'person_per_day';
// Components whose service dates make a booking eligible for the full-day equipment add-on.
const FULL_DAY_ADDON_ELIGIBLE_COMPONENTS = new Set(['lesson', 'course', 'private_lesson', 'surfboard', 'wetsuit']);

const UI_COMPONENT_KEYS = new Set([
  'lesson', 'course', 'surfboard', 'wetsuit', 'private_lesson', FULL_DAY_EQUIPMENT_ADDON_KEY,
]);
const LEGACY_UI_SERVICE_TYPES = new Set(['lesson', 'board_rental', 'wetsuit_rental']);
const UI_PAYMENT_STATUSES = new Set(['unpaid', 'paid', 'pending']);

const UI_TO_DB_SERVICE_TYPE = {
  lesson: 'surf_lesson',
  course: 'surf_lesson',
  private_lesson: 'surf_lesson',
  surfboard: 'surfboard',
  wetsuit: 'wetsuit',
  board_rental: 'surfboard',
  wetsuit_rental: 'wetsuit',
  [FULL_DAY_EQUIPMENT_ADDON_KEY]: 'addon_service',
};

const DB_TO_UI_SERVICE_TYPE = {
  surf_lesson: 'lesson',
  surfboard: 'surfboard',
  wetsuit: 'wetsuit',
};

const UI_TO_SR_PAYMENT = {
  unpaid: 'pending',
  paid: 'paid',
  pending: 'pending',
};

const UI_TO_BOOKING_PAYMENT = {
  unpaid: 'waiting_payment',
  paid: 'paid',
  pending: 'waiting_payment',
};

function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
}

function isTimeHm(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || '').trim());
}

function timeToMinutes(hm) {
  const parts = String(hm || '').trim().split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function parseQuantity(raw, fallback) {
  const quantity = parseInt(String(raw == null ? fallback : raw), 10);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) return null;
  return quantity;
}

function normalizeRentalDuration(raw) {
  const compact = String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (compact === 'half_day' || compact === 'halfday') return 'half_day';
  return compact;
}

function normalizeRentalPricing(raw, components) {
  if (raw == null || raw === '') return { ok: true, skip: true };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'rental_pricing must be an object' };
  }
  const offering_key = String(raw.offering_key || '').trim();
  if (!offering_key) return { ok: false, error: 'rental_pricing.offering_key is required' };
  const duration = normalizeRentalDuration(raw.duration);
  if (!duration) return { ok: false, error: 'rental_pricing.duration is required' };
  const quantity = parseInt(String(raw.quantity), 10);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    return { ok: false, error: 'rental_pricing.quantity must be 1–99' };
  }
  const quotedRaw = raw.quoted_total_cents;
  const quoted_total_cents = quotedRaw == null || quotedRaw === ''
    ? null
    : parseInt(String(quotedRaw), 10);
  if (quoted_total_cents != null && (!Number.isInteger(quoted_total_cents) || quoted_total_cents < 0)) {
    return { ok: false, error: 'rental_pricing.quoted_total_cents must be a non-negative integer' };
  }
  if (offering_key === 'board_and_suit_rental') {
    const comps = components && typeof components === 'object' ? components : {};
    if (!comps.surfboard || !comps.wetsuit) {
      return { ok: false, error: 'board_and_suit_rental requires surfboard and wetsuit components' };
    }
    const boardQty = parseQuantity(comps.surfboard.quantity, 1);
    const suitQty = parseQuantity(comps.wetsuit.quantity, 1);
    if (boardQty !== quantity || suitQty !== quantity) {
      return { ok: false, error: 'board_and_suit_rental component quantities must match rental_pricing.quantity' };
    }
  }
  return {
    ok: true,
    value: {
      offering_key,
      duration,
      quantity,
      quoted_total_cents,
    },
  };
}

function parsePrivateLessonQuantity(raw) {
  const quantity = parseInt(String(raw == null ? 1 : raw), 10);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > PRIVATE_LESSON_MAX_SESSIONS) return null;
  return quantity;
}

function isPrivateLessonEnabled(part) {
  if (!part || typeof part !== 'object') return false;
  return part.enabled === true || part.enabled === 'true' || part.enabled === 1;
}

function normalizePrivateLessonSessions(sessions, quantity) {
  if (!Array.isArray(sessions)) {
    return { ok: false, error: 'components.private_lesson.sessions must be an array' };
  }
  if (sessions.length !== quantity) {
    return { ok: false, error: `components.private_lesson.sessions length must equal quantity (${quantity})` };
  }
  const normalized = [];
  for (let i = 0; i < sessions.length; i += 1) {
    const s = sessions[i] && typeof sessions[i] === 'object' ? sessions[i] : {};
    const date = String(s.date || '').trim();
    const start = String(s.start || '').trim();
    const end = String(s.end || '').trim();
    if (!isIsoDate(date)) {
      return { ok: false, error: `components.private_lesson.sessions[${i}].date must be YYYY-MM-DD` };
    }
    if (!isTimeHm(start)) {
      return { ok: false, error: `components.private_lesson.sessions[${i}].start must be HH:MM` };
    }
    if (!isTimeHm(end)) {
      return { ok: false, error: `components.private_lesson.sessions[${i}].end must be HH:MM` };
    }
    const startM = timeToMinutes(start);
    const endM = timeToMinutes(end);
    if (endM <= startM) {
      return { ok: false, error: `components.private_lesson.sessions[${i}].end must be after start` };
    }
    normalized.push({ date, start, end, index: i + 1 });
  }
  return { ok: true, value: normalized };
}

function normalizePrivateLessonPart(part) {
  if (!isPrivateLessonEnabled(part)) return { ok: true, skip: true };
  const quantity = parsePrivateLessonQuantity(part.quantity != null ? part.quantity : part.count);
  if (!quantity) {
    return { ok: false, error: `components.private_lesson.quantity must be 1–${PRIVATE_LESSON_MAX_SESSIONS}` };
  }
  const surfer_count = parseQuantity(part.surfer_count, 1);
  if (!surfer_count) {
    return { ok: false, error: 'components.private_lesson.surfer_count must be 1–99' };
  }
  const sessions = normalizePrivateLessonSessions(part.sessions, quantity);
  if (!sessions.ok) return sessions;
  return {
    ok: true,
    value: {
      enabled: true,
      quantity,
      surfer_count,
      sessions: sessions.value,
      label: String(part.label || '').trim() || null,
    },
  };
}

function isFullDayEquipmentAddonEnabled(part) {
  if (!part || typeof part !== 'object') return false;
  return part.enabled === true || part.enabled === 'true' || part.enabled === 1;
}

// Normalize the full-day equipment add-on part: { enabled, dates: { 'YYYY-MM-DD': quantity } }.
// Also accepts an array form [{ date, quantity }]. Quantity = people (positive int 1–99).
function normalizeFullDayEquipmentAddon(part) {
  if (!isFullDayEquipmentAddonEnabled(part)) return { ok: true, skip: true };
  const rawDates = part.dates;
  const map = {};
  if (Array.isArray(rawDates)) {
    for (const entry of rawDates) {
      const e = entry && typeof entry === 'object' ? entry : {};
      const iso = String(e.date || '').trim();
      if (!isIsoDate(iso)) {
        return { ok: false, error: `components.${FULL_DAY_EQUIPMENT_ADDON_KEY}.dates[].date must be YYYY-MM-DD` };
      }
      const qty = parseQuantity(e.quantity != null ? e.quantity : e.people, 1);
      if (!qty) return { ok: false, error: `components.${FULL_DAY_EQUIPMENT_ADDON_KEY} quantity must be 1–99` };
      map[iso] = qty;
    }
  } else if (rawDates && typeof rawDates === 'object') {
    for (const [iso, rawQty] of Object.entries(rawDates)) {
      const date = String(iso || '').trim();
      if (!isIsoDate(date)) {
        return { ok: false, error: `components.${FULL_DAY_EQUIPMENT_ADDON_KEY}.dates keys must be YYYY-MM-DD` };
      }
      const qty = parseQuantity(rawQty, 1);
      if (!qty) return { ok: false, error: `components.${FULL_DAY_EQUIPMENT_ADDON_KEY} quantity must be 1–99` };
      map[date] = qty;
    }
  } else {
    return { ok: false, error: `components.${FULL_DAY_EQUIPMENT_ADDON_KEY}.dates is required when enabled` };
  }
  if (!Object.keys(map).length) {
    return { ok: false, error: `components.${FULL_DAY_EQUIPMENT_ADDON_KEY}.dates must include at least one date` };
  }
  return { ok: true, value: { enabled: true, dates: map } };
}

function normalizeComponents(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.components && typeof b.components === 'object') {
    const out = {};
    for (const key of UI_COMPONENT_KEYS) {
      if (key === 'private_lesson') continue;
      if (key === FULL_DAY_EQUIPMENT_ADDON_KEY) continue;
      const part = b.components[key];
      if (!part) continue;
      const qty = parseQuantity(part.quantity != null ? part.quantity : part.count, 1);
      if (!qty) return { ok: false, error: `components.${key}.quantity must be 1–99` };
      const entry = { quantity: qty };
      if (key === 'lesson') {
        const slot = String(part.slot_time || part.time_local || b.time_local || b.slot_time || '').trim();
        if (slot && !isTimeHm(slot)) return { ok: false, error: 'lesson slot_time must be HH:MM' };
        entry.slot_time = slot || null;
        entry.category = String(part.category || b.lesson_category || DEFAULT_LESSON_CATEGORY).trim() || DEFAULT_LESSON_CATEGORY;
      }
      if (key === 'course') {
        const courseId = String(part.course_id || part.offering_key || '').trim();
        if (!courseId) return { ok: false, error: 'components.course.course_id is required' };
        entry.course_id = courseId;
        entry.course_label = String(part.course_label || part.label || '').trim() || courseId;
      }
      out[key] = entry;
    }
    if (b.components.private_lesson) {
      const pl = normalizePrivateLessonPart(b.components.private_lesson);
      if (!pl.ok) return pl;
      if (!pl.skip) out.private_lesson = pl.value;
    }
    if (!Object.keys(out).length) {
      return { ok: false, error: 'components must include at least one of lesson, course, private_lesson, surfboard, wetsuit' };
    }
    // Full-day equipment add-on is only valid alongside an eligible base component.
    if (b.components[FULL_DAY_EQUIPMENT_ADDON_KEY]) {
      const addon = normalizeFullDayEquipmentAddon(b.components[FULL_DAY_EQUIPMENT_ADDON_KEY]);
      if (!addon.ok) return addon;
      if (!addon.skip) {
        const hasEligibleBase = Object.keys(out).some((k) => FULL_DAY_ADDON_ELIGIBLE_COMPONENTS.has(k));
        if (!hasEligibleBase) {
          return { ok: false, error: `components.${FULL_DAY_EQUIPMENT_ADDON_KEY} requires an eligible lesson/course/rental component` };
        }
        out[FULL_DAY_EQUIPMENT_ADDON_KEY] = addon.value;
      }
    }
    return { ok: true, value: out };
  }

  const booking_type = String(b.booking_type || '').trim();
  if (!LEGACY_UI_SERVICE_TYPES.has(booking_type)) {
    return { ok: false, error: 'booking_type or components is required' };
  }
  const qty = parseQuantity(b.quantity != null ? b.quantity : b.count, 1);
  if (!qty) return { ok: false, error: 'quantity must be 1–99' };
  const legacyKey = booking_type === 'lesson' ? 'lesson' : (booking_type === 'board_rental' ? 'surfboard' : 'wetsuit');
  const out = { [legacyKey]: { quantity: qty } };
  if (legacyKey === 'lesson') {
    const slot = String(b.time_local || b.slot_time || '').trim();
    if (slot && !isTimeHm(slot)) return { ok: false, error: 'time_local must be HH:MM' };
    out.lesson.slot_time = slot || null;
    out.lesson.category = DEFAULT_LESSON_CATEGORY;
  }
  return { ok: true, value: out };
}

function normalizeServiceDates(body, components) {
  const b = body && typeof body === 'object' ? body : {};
  const dates = [];
  if (Array.isArray(b.service_dates)) {
    b.service_dates.forEach((d) => {
      const iso = String(d || '').trim();
      if (iso) dates.push(iso);
    });
  } else if (b.date_from && b.date_to) {
    const from = String(b.date_from).trim();
    const to = String(b.date_to).trim();
    if (!isIsoDate(from) || !isIsoDate(to)) return { ok: false, error: 'date_from/date_to must be YYYY-MM-DD' };
    const start = new Date(from + 'T12:00:00');
    const end = new Date(to + 'T12:00:00');
    if (end < start) return { ok: false, error: 'date_to must be on or after date_from' };
    for (let cur = new Date(start); cur <= end; cur.setDate(cur.getDate() + 1)) {
      dates.push(cur.toISOString().slice(0, 10));
    }
  } else if (components && components.private_lesson && components.private_lesson.sessions) {
    components.private_lesson.sessions.forEach((s) => {
      if (s.date) dates.push(s.date);
    });
  } else {
    const single = String(b.service_date || '').trim();
    if (!isIsoDate(single)) return { ok: false, error: 'service_date or service_dates is required' };
    dates.push(single);
  }
  if (components && components.private_lesson && components.private_lesson.sessions) {
    components.private_lesson.sessions.forEach((s) => {
      if (s.date) dates.push(s.date);
    });
  }
  const unique = [...new Set(dates)];
  if (!unique.length) return { ok: false, error: 'at least one service date is required' };
  if (unique.length > 31) return { ok: false, error: 'too many service dates (max 31)' };
  for (const iso of unique) {
    if (!isIsoDate(iso)) return { ok: false, error: 'service_dates must be YYYY-MM-DD' };
  }
  return { ok: true, value: unique };
}

function validateScheduleBookingBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const guest_name = String(b.guest_name || '').trim();
  if (!guest_name || guest_name.length > 200) {
    return { ok: false, error: 'guest_name is required (max 200 chars)' };
  }
  const guest_phone = b.guest_phone != null ? String(b.guest_phone).trim().slice(0, 40) : '';
  const components = normalizeComponents(b);
  if (!components.ok) return components;
  const serviceDates = normalizeServiceDates(b, components.value);
  if (!serviceDates.ok) return serviceDates;
  // Add-on dates must be a subset of the booking's eligible service dates (course/rental/lesson dates,
  // plus any private-lesson session dates). Server-side revalidation — never trust the browser.
  const addonPart = components.value[FULL_DAY_EQUIPMENT_ADDON_KEY];
  if (addonPart && addonPart.dates) {
    const eligible = new Set(serviceDates.value);
    if (components.value.private_lesson && components.value.private_lesson.sessions) {
      components.value.private_lesson.sessions.forEach((s) => { if (s.date) eligible.add(s.date); });
    }
    for (const iso of Object.keys(addonPart.dates)) {
      if (!eligible.has(iso)) {
        return { ok: false, error: `components.${FULL_DAY_EQUIPMENT_ADDON_KEY} date ${iso} is not an eligible booking date` };
      }
    }
  }
  const payment_status = String(b.payment_status || 'unpaid').trim().toLowerCase();
  if (!UI_PAYMENT_STATUSES.has(payment_status)) {
    return { ok: false, error: 'payment_status must be unpaid, paid, or pending' };
  }
  const notes = b.notes != null ? String(b.notes).trim().slice(0, 2000) : '';
  const needs_reply = b.needs_reply === true || b.needs_reply === 'true' || b.needs_reply === 1;
  const idempotency_key = b.idempotency_key != null ? String(b.idempotency_key).trim().slice(0, 120) : '';
  const rentalPricing = normalizeRentalPricing(b.rental_pricing, components.value);
  if (!rentalPricing.ok) return rentalPricing;

  return {
    ok: true,
    value: {
      guest_name,
      guest_phone: guest_phone || null,
      components: components.value,
      service_dates: serviceDates.value,
      payment_status,
      notes,
      needs_reply,
      idempotency_key: idempotency_key || null,
      rental_pricing: rentalPricing.skip ? null : rentalPricing.value,
    },
  };
}

function generateSunsetManualBookingCode(locationId) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  // Location-prefixed booking codes: El Sardinero -> ELSARDI, Somo (default) -> SUNSET.
  const prefix = String(locationId || '').trim() === 'sunset-sardinero' ? 'ELSARDI' : 'SUNSET';
  return `${prefix}-${stamp}-${suffix}`;
}

function bookingStatusFromPayment(paymentStatus) {
  return paymentStatus === 'paid' ? 'confirmed' : 'payment_pending';
}

function componentList(components) {
  return Object.keys(components || {});
}

function staffUiServiceType(componentKey) {
  if (componentKey === 'lesson') return 'lesson';
  if (componentKey === 'course') return 'course';
  if (componentKey === 'private_lesson') return 'private_lesson';
  if (componentKey === 'surfboard') return 'board_rental';
  return 'wetsuit_rental';
}

function scheduleRowFromDb(row) {
  const dbType = String(row.service_type || '').toLowerCase();
  const uiType = row.staff_ui_service_type || DB_TO_UI_SERVICE_TYPE[dbType] || dbType;
  const component = String(row.metadata_component || row.component || '').toLowerCase();
  const isPrivateLesson = component === 'private_lesson'
    || String(row.staff_ui_service_type || '').toLowerCase() === 'private_lesson';
  const isCourse = component === 'course'
    || String(row.staff_ui_service_type || '').toLowerCase() === 'course';
  const isLesson = !isCourse && !isPrivateLesson && (dbType === 'surf_lesson' || uiType === 'lesson');
  let payment = String(row.payment_status || '').toLowerCase();
  if (payment === 'pending' || payment === 'not_requested') payment = 'unpaid';
  const metaComponents = row.metadata_components ? String(row.metadata_components).split(',').filter(Boolean) : null;

  return {
    _scheduleId: String(row.service_record_id || row.id || ''),
    _isDbManual: row.record_source === DB_SOURCE && (row.metadata_source === METADATA_SOURCE_TAG || row.staff_manual_schedule === true || (row.metadata_source == null && row.staff_ui_service_type)),
    _isDemo: false,
    _isLuna: row.record_source === 'luna_guest' || row.record_source === 'stripe',
    record_source: row.record_source || null,
    guest_name: row.guest_name || null,
    service_type: isPrivateLesson ? 'private_lesson' : (isCourse ? 'course' : uiType),
    service_date: row.service_date,
    slot_time: row.slot_time || row.service_time_local || null,
    service_time_local: row.service_time_local || null,
    service_time_local_end: row.service_time_local_end || null,
    quantity: row.quantity != null ? Number(row.quantity) : 1,
    payment_status: payment,
    booking_code: row.booking_code || null,
    booking_id: row.booking_id || null,
    notes: row.notes || null,
    lesson_category: row.lesson_category || null,
    course_id: row.course_id || null,
    course_label: row.course_label || null,
    components: metaComponents,
    bundle_id: row.bundle_id || null,
    _needsReply: row.needs_reply === true || row.needs_reply === 't',
    _scheduleType: isPrivateLesson ? 'private_lesson' : (isCourse ? 'course' : (isLesson ? 'lesson' : 'rental')),
    service_record_id: row.service_record_id || row.id || null,
  };
}

async function ensureServiceRecordTimeColumns(pg) {
  await pg.query(`ALTER TABLE booking_service_records ADD COLUMN IF NOT EXISTS service_time_local TEXT`);
  await pg.query(`ALTER TABLE booking_service_records ADD COLUMN IF NOT EXISTS service_time_local_end TEXT`);
}

async function findIdempotentBooking(pg, clientSlug, idempotencyKey) {
  if (!idempotencyKey) return null;
  const res = await pg.query(
    `SELECT sr.id::text AS service_record_id,
            sr.booking_id::text AS booking_id,
            sr.booking_code,
            sr.guest_name,
            sr.service_type::text AS service_type,
            sr.service_date::text AS service_date,
            sr.quantity,
            sr.payment_status::text AS payment_status,
            sr.source AS record_source,
            sr.service_time_local,
            sr.service_time_local_end,
            sr.metadata->>'slot_time' AS slot_time,
            sr.metadata->>'notes' AS notes,
            COALESCE((sr.metadata->>'needs_reply')::boolean, false) AS needs_reply,
            sr.metadata->>'staff_ui_service_type' AS staff_ui_service_type,
            sr.metadata->>'source' AS metadata_source,
            sr.metadata->>'lesson_category' AS lesson_category,
            sr.metadata->>'course_id' AS course_id,
            sr.metadata->>'course_label' AS course_label,
            sr.metadata->>'component' AS metadata_component,
            sr.metadata->>'bundle_id' AS bundle_id,
            sr.metadata->>'components' AS metadata_components
       FROM booking_service_records sr
      WHERE sr.client_slug = $1
        AND sr.metadata->>'idempotency_key' = $2
      ORDER BY sr.service_date, sr.id
      LIMIT 50`,
    [clientSlug, idempotencyKey],
  );
  return res.rows.length ? res.rows : null;
}

async function insertServiceRecord(pg, params, timeOpts) {
  const hasTime = timeOpts && timeOpts.service_time_local;
  if (hasTime) await ensureServiceRecordTimeColumns(pg);

  const svcIns = hasTime
    ? await pg.query(
      `INSERT INTO booking_service_records (
         client_slug, booking_id, booking_code, guest_name, service_type, service_date,
         quantity, status, amount_due_cents, amount_paid_cents, payment_status, source, metadata,
         service_time_local, service_time_local_end
       ) VALUES (
         $1, $2::uuid, $3, $4, $5, $6::date,
         $7, 'confirmed', 0, 0, $8, $9, $10::jsonb,
         $11, $12
       )
       RETURNING id::text AS service_record_id,
                 booking_id::text AS booking_id,
                 booking_code,
                 guest_name,
                 service_type::text AS service_type,
                 service_date::text AS service_date,
                 quantity,
                 payment_status::text AS payment_status,
                 source AS record_source,
                 service_time_local,
                 service_time_local_end,
                 metadata->>'slot_time' AS slot_time,
                 metadata->>'notes' AS notes,
                 COALESCE((metadata->>'needs_reply')::boolean, false) AS needs_reply,
                 metadata->>'staff_ui_service_type' AS staff_ui_service_type,
                 metadata->>'source' AS metadata_source,
                 metadata->>'lesson_category' AS lesson_category,
                 metadata->>'course_id' AS course_id,
                 metadata->>'course_label' AS course_label,
                 metadata->>'component' AS metadata_component,
                 metadata->>'bundle_id' AS bundle_id,
                 metadata->>'components' AS metadata_components`,
      [...params, timeOpts.service_time_local, timeOpts.service_time_local_end || null],
    )
    : await pg.query(
      `INSERT INTO booking_service_records (
         client_slug, booking_id, booking_code, guest_name, service_type, service_date,
         quantity, status, amount_due_cents, amount_paid_cents, payment_status, source, metadata
       ) VALUES (
         $1, $2::uuid, $3, $4, $5, $6::date,
         $7, 'confirmed', 0, 0, $8, $9, $10::jsonb
       )
       RETURNING id::text AS service_record_id,
                 booking_id::text AS booking_id,
                 booking_code,
                 guest_name,
                 service_type::text AS service_type,
                 service_date::text AS service_date,
                 quantity,
                 payment_status::text AS payment_status,
                 source AS record_source,
                 metadata->>'slot_time' AS slot_time,
                 metadata->>'notes' AS notes,
                 COALESCE((metadata->>'needs_reply')::boolean, false) AS needs_reply,
                 metadata->>'staff_ui_service_type' AS staff_ui_service_type,
                 metadata->>'source' AS metadata_source,
                 metadata->>'lesson_category' AS lesson_category,
                 metadata->>'course_id' AS course_id,
                 metadata->>'course_label' AS course_label,
                 metadata->>'component' AS metadata_component,
                 metadata->>'bundle_id' AS bundle_id,
                 metadata->>'components' AS metadata_components`,
      params,
    );
  return svcIns.rows[0];
}

// Insert full-day equipment add-on rows (one per selected date). service_type='addon_service'
// (allowed by migration 029). quantity = people. amount_due_cents = snapshot(unit × qty).
// Metadata carries service_key/component for the shared price resolver + drawer label.
async function insertFullDayEquipmentAddonRows(pg, opts) {
  const rows = [];
  const dates = opts.addonDates || {};
  const unitCents = Number(opts.addonUnitCents) || 0;
  const sortedDates = Object.keys(dates).sort();
  if (sortedDates.length) {
    // Idempotently allow service_type='addon_service' before inserting — covers DBs
    // where migration 029 was never applied (else the CHECK rejects the insert and the
    // whole booking write fails). No-op once the constraint already includes it.
    // Deferred require to avoid an eager require cycle (see note above).
    const { ensureBookingServiceGenericType } = require('./tenant-services-writes');
    await ensureBookingServiceGenericType(pg);
  }
  for (const serviceDate of sortedDates) {
    const qty = parseQuantity(dates[serviceDate], 1) || 1;
    const amountDueCents = unitCents * qty;
    const metadata = {
      source: METADATA_SOURCE_TAG,
      staff_manual_schedule: true,
      staff_ui_service_type: FULL_DAY_EQUIPMENT_ADDON_KEY,
      component: FULL_DAY_EQUIPMENT_ADDON_KEY,
      service_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
      billing_unit: FULL_DAY_EQUIPMENT_ADDON_BILLING_UNIT,
      unit_amount_cents: unitCents,
      components: opts.componentKeys,
      bundle_id: opts.bundleId,
      location_id: opts.locationId || null,
      notes: opts.notes || null,
      needs_reply: opts.needsReply,
      guest_phone: opts.guestPhone,
      created_by_staff: opts.actorEmail || null,
      updated_by_staff: opts.actorEmail || null,
      idempotency_key: opts.idempotencyKey || null,
    };
    const ins = await pg.query(
      `INSERT INTO booking_service_records (
         client_slug, booking_id, booking_code, guest_name, service_type, service_date,
         quantity, status, amount_due_cents, amount_paid_cents, payment_status, source, metadata
       ) VALUES (
         $1, $2::uuid, $3, $4, 'addon_service', $5::date,
         $6, 'confirmed', $7, 0, $8, $9, $10::jsonb
       )
       RETURNING id::text AS service_record_id,
                 booking_id::text AS booking_id,
                 booking_code,
                 guest_name,
                 service_type::text AS service_type,
                 service_date::text AS service_date,
                 quantity,
                 amount_due_cents,
                 payment_status::text AS payment_status,
                 source AS record_source,
                 metadata->>'slot_time' AS slot_time,
                 metadata->>'notes' AS notes,
                 metadata->>'staff_ui_service_type' AS staff_ui_service_type,
                 metadata->>'source' AS metadata_source,
                 metadata->>'component' AS metadata_component,
                 metadata->>'bundle_id' AS bundle_id,
                 metadata->>'components' AS metadata_components`,
      [
        opts.clientSlug,
        opts.bookingId,
        opts.bookingCode,
        opts.guestName,
        serviceDate,
        qty,
        amountDueCents,
        opts.srPayment,
        DB_SOURCE,
        JSON.stringify(metadata),
      ],
    );
    rows.push(ins.rows[0]);
  }
  return rows;
}

function bookingHeaderDates(input) {
  const dates = input.service_dates.slice();
  if (input.components.private_lesson) {
    input.components.private_lesson.sessions.forEach((s) => dates.push(s.date));
  }
  const sorted = [...new Set(dates)].sort();
  return { firstDate: sorted[0], lastDate: sorted[sorted.length - 1] };
}

function resolveGuestCount(components) {
  if (components.private_lesson) return components.private_lesson.surfer_count;
  if (components.lesson) return components.lesson.quantity;
  if (components.course) return components.course.quantity;
  const keys = componentList(components).filter((k) => k !== FULL_DAY_EQUIPMENT_ADDON_KEY);
  const counts = keys.map((k) => Number(components[k] && components[k].quantity)).filter((n) => Number.isFinite(n));
  return counts.length ? Math.max(...counts) : 1;
}

async function createSunsetScheduleBooking(pg, opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, body: { success: false, error: 'unsupported_client', client_slug: clientSlug } };
  }

  const validated = validateScheduleBookingBody(opts.body);
  if (!validated.ok) {
    return { ok: false, status: 400, body: { success: false, error: validated.error } };
  }
  const input = validated.value;
  const locationId = opts.locationId != null ? String(opts.locationId).trim() : '';

  if (input.idempotency_key) {
    const existingRows = await findIdempotentBooking(pg, clientSlug, input.idempotency_key);
    if (existingRows && existingRows.length) {
      return {
        ok: true,
        status: 200,
        body: {
          success: true,
          idempotent: true,
          booking_code: existingRows[0].booking_code,
          booking_id: existingRows[0].booking_id,
          records: existingRows.map(scheduleRowFromDb),
          booking: scheduleRowFromDb(existingRows[0]),
        },
      };
    }
  }

  const clientRes = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [clientSlug]);
  if (clientRes.rows.length === 0) {
    return { ok: false, status: 500, body: { success: false, error: 'sunset client not found' } };
  }
  const clientId = clientRes.rows[0].id;

  let privateLessonConfig = defaultPrivateLessonApi();
  if (input.components.private_lesson) {
    const plLoad = await loadPrivateLessonFromDb(pg, { clientSlug, locationId });
    privateLessonConfig = plLoad.api || privateLessonConfig;
  }

  // Snapshot the add-on unit price at insert so later admin price edits don't rewrite history.
  let addonUnitCents = null;
  if (input.components[FULL_DAY_EQUIPMENT_ADDON_KEY]) {
    addonUnitCents = await resolveFullDayEquipmentAddonUnitCents(pg, clientSlug, locationId);
    if (addonUnitCents == null) {
      return { ok: false, status: 409, body: { success: false, error: 'full_day_equipment_extension_price_unavailable' } };
    }
  }

  const srPayment = UI_TO_SR_PAYMENT[input.payment_status];
  const bookingPayment = UI_TO_BOOKING_PAYMENT[input.payment_status];
  const bookingStatus = bookingStatusFromPayment(input.payment_status);
  const bookingCode = generateSunsetManualBookingCode(locationId);
  const bundleId = crypto.randomBytes(8).toString('hex');
  const componentKeys = componentList(input.components);
  const guestCount = resolveGuestCount(input.components);
  const { firstDate } = bookingHeaderDates(input);

  await pg.query('BEGIN');
  try {
    const bookingIns = await pg.query(
      `INSERT INTO bookings (
         client_id, booking_code, guest_name, phone, status, payment_status,
         check_in, check_out, guest_count, metadata
       ) VALUES (
         $1::uuid, $2, $3, $4, $5::booking_status, $6::payment_status,
         $7::date, ($7::date + INTERVAL '1 day')::date, $8, $9::jsonb
       )
       RETURNING id::text AS id, booking_code`,
      [
        clientId,
        bookingCode,
        input.guest_name,
        input.guest_phone,
        bookingStatus,
        bookingPayment,
        firstDate,
        guestCount,
        JSON.stringify({
          source: METADATA_SOURCE_TAG,
          staff_manual_schedule: true,
          bundle_id: bundleId,
          components: componentKeys,
          guest_phone: input.guest_phone,
          location_id: locationId || null,
          rental_pricing: input.rental_pricing || null,
        }),
      ],
    );
    const bookingId = bookingIns.rows[0].id;
    const createdRows = [];

    if (input.components.private_lesson) {
      const pl = input.components.private_lesson;
      const plLabel = pl.label || privateLessonConfig.label || 'Private lesson';
      for (const session of pl.sessions) {
        const metadata = {
          source: METADATA_SOURCE_TAG,
          staff_manual_schedule: true,
          staff_ui_service_type: 'private_lesson',
          component: 'private_lesson',
          components: componentKeys,
          bundle_id: bundleId,
          slot_time: session.start,
          private_lesson_label: plLabel,
          private_lesson_session_index: session.index,
          private_lesson_session_count: pl.quantity,
          price_basis: privateLessonConfig.price_basis || 'per_session',
          unit_amount_cents: privateLessonConfig.amount_cents || 0,
          default_duration_minutes: privateLessonConfig.default_duration_minutes || 120,
          notes: input.notes || null,
          needs_reply: input.needs_reply,
          guest_phone: input.guest_phone,
          location_id: locationId || null,
          created_by_staff: opts.actor && opts.actor.email ? opts.actor.email : null,
          idempotency_key: input.idempotency_key,
        };
        const row = await insertServiceRecord(pg, [
          clientSlug,
          bookingId,
          bookingCode,
          input.guest_name,
          UI_TO_DB_SERVICE_TYPE.private_lesson,
          session.date,
          pl.surfer_count,
          srPayment,
          DB_SOURCE,
          JSON.stringify(metadata),
        ], {
          service_time_local: session.start,
          service_time_local_end: session.end,
        });
        createdRows.push(row);
      }
    }

    for (const serviceDate of input.service_dates) {
      for (const componentKey of componentKeys) {
        if (componentKey === 'private_lesson') continue;
        if (componentKey === FULL_DAY_EQUIPMENT_ADDON_KEY) continue;
        const part = input.components[componentKey];
        const dbServiceType = UI_TO_DB_SERVICE_TYPE[componentKey];
        const metadata = {
          source: METADATA_SOURCE_TAG,
          staff_manual_schedule: true,
          staff_ui_service_type: staffUiServiceType(componentKey),
          component: componentKey,
          components: componentKeys,
          bundle_id: bundleId,
          slot_time: componentKey === 'lesson' ? part.slot_time : null,
          lesson_category: componentKey === 'lesson' ? part.category : null,
          course_id: componentKey === 'course' ? part.course_id : null,
          course_label: componentKey === 'course' ? part.course_label : null,
          notes: input.notes || null,
          needs_reply: input.needs_reply,
          guest_phone: input.guest_phone,
          location_id: locationId || null,
          created_by_staff: opts.actor && opts.actor.email ? opts.actor.email : null,
          idempotency_key: input.idempotency_key,
          rental_pricing: input.rental_pricing || null,
        };
        const row = await insertServiceRecord(pg, [
          clientSlug,
          bookingId,
          bookingCode,
          input.guest_name,
          dbServiceType,
          serviceDate,
          part.quantity,
          srPayment,
          DB_SOURCE,
          JSON.stringify(metadata),
        ]);
        createdRows.push(row);
      }
    }

    // Full-day equipment add-on: one row per selected date, quantity = people, price snapshotted.
    if (input.components[FULL_DAY_EQUIPMENT_ADDON_KEY]) {
      const addonRows = await insertFullDayEquipmentAddonRows(pg, {
        clientSlug,
        bookingId,
        bookingCode,
        guestName: input.guest_name,
        addonDates: input.components[FULL_DAY_EQUIPMENT_ADDON_KEY].dates,
        addonUnitCents,
        componentKeys,
        bundleId,
        locationId,
        srPayment,
        notes: input.notes || null,
        needsReply: input.needs_reply,
        guestPhone: input.guest_phone,
        actorEmail: opts.actor && opts.actor.email ? opts.actor.email : null,
        idempotencyKey: input.idempotency_key,
      });
      addonRows.forEach((r) => createdRows.push(r));
    }

    await pg.query('COMMIT');
    return {
      ok: true,
      status: 201,
      body: {
        success: true,
        booking_code: bookingCode,
        booking_id: bookingId,
        records: createdRows.map(scheduleRowFromDb),
        booking: scheduleRowFromDb(createdRows[0]),
      },
    };
  } catch (err) {
    await pg.query('ROLLBACK');
    throw err;
  }
}

module.exports = {
  SUNSET_CLIENT_SLUG,
  METADATA_SOURCE_TAG,
  DB_SOURCE,
  DEFAULT_LESSON_CATEGORY,
  PRIVATE_LESSON_MAX_SESSIONS,
  UI_COMPONENT_KEYS,
  LEGACY_UI_SERVICE_TYPES,
  UI_TO_DB_SERVICE_TYPE,
  DB_TO_UI_SERVICE_TYPE,
  UI_TO_SR_PAYMENT,
  UI_TO_BOOKING_PAYMENT,
  FULL_DAY_EQUIPMENT_ADDON_KEY,
  FULL_DAY_EQUIPMENT_ADDON_BILLING_UNIT,
  FULL_DAY_ADDON_ELIGIBLE_COMPONENTS,
  isIsoDate,
  isTimeHm,
  timeToMinutes,
  isPrivateLessonEnabled,
  normalizePrivateLessonPart,
  normalizePrivateLessonSessions,
  isFullDayEquipmentAddonEnabled,
  normalizeFullDayEquipmentAddon,
  normalizeRentalDuration,
  normalizeRentalPricing,
  resolveFullDayEquipmentAddonUnitCents,
  insertFullDayEquipmentAddonRows,
  validateScheduleBookingBody,
  bookingStatusFromPayment,
  componentList,
  insertServiceRecord,
  generateSunsetManualBookingCode,
  scheduleRowFromDb,
  createSunsetScheduleBooking,
};
