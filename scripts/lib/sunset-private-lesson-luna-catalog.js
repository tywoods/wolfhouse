'use strict';

/**
 * Sunset private lesson — Luna / Staff API catalog contract.
 * One unit product; custom session date/time per booking (no fixed slots or package tiers).
 */

const {
  validateScheduleBookingBody,
  PRIVATE_LESSON_MAX_SESSIONS,
} = require('./sunset-schedule-booking-writes');

const SERVICE_KEY = 'private_lesson';
const LEGACY_OFFERING_KEY = 'private_coaching';

function buildPrivateLessonCatalogItem(privateLesson) {
  const pl = privateLesson && typeof privateLesson === 'object' ? privateLesson : {};
  const amountCents = pl.amount_cents != null ? Number(pl.amount_cents) : 0;
  const duration = pl.default_duration_minutes != null
    ? Number(pl.default_duration_minutes)
    : 120;
  return {
    service_key: SERVICE_KEY,
    category: SERVICE_KEY,
    label: String(pl.label || 'Private lesson').trim() || 'Private lesson',
    enabled: pl.enabled === true,
    price_basis: pl.price_basis || 'per_session',
    unit: 'session',
    amount_cents: Number.isInteger(amountCents) && amountCents >= 0 ? amountCents : 0,
    currency: String(pl.currency || 'EUR').trim().toUpperCase() || 'EUR',
    default_duration_minutes: Number.isFinite(duration) ? duration : 120,
    schedule_slots: [],
    slots: [],
    requires_custom_sessions: true,
    quantity_field: 'session_count',
    quantity_aliases: ['session_count', 'quantity'],
    surfer_count_field: 'surfer_count',
    session_fields: ['date', 'start', 'end'],
    max_session_count: PRIVATE_LESSON_MAX_SESSIONS,
    package_tiers: [],
    discounts: [],
    legacy_offering_key: LEGACY_OFFERING_KEY,
    source: pl.source || 'default',
    rule_id: pl.rule_id || null,
    notes: pl.notes != null ? String(pl.notes) : '',
  };
}

function attachSunsetCatalogServices(config) {
  const base = config && typeof config === 'object' ? { ...config } : {};
  const item = buildPrivateLessonCatalogItem(base.private_lesson);
  const catalog_services = item.enabled ? [item] : [];
  return {
    ...base,
    catalog_services,
    private_lesson_catalog: item,
  };
}

function findPrivateLessonCatalogService(catalogServices) {
  const list = Array.isArray(catalogServices) ? catalogServices : [];
  return list.find((s) => s && s.service_key === SERVICE_KEY) || null;
}

/**
 * Map Luna-facing booking body to Sunset schedule create validation input.
 * session_count is an alias for components.private_lesson.quantity (session count).
 */
function normalizeLunaPrivateLessonBookingPayload(body) {
  const b = body && typeof body === 'object' ? body : {};
  const rootPl = b.private_lesson && typeof b.private_lesson === 'object' ? b.private_lesson : null;
  const compPl = b.components && b.components.private_lesson && typeof b.components.private_lesson === 'object'
    ? b.components.private_lesson
    : null;
  const pl = compPl || rootPl;
  if (!pl) {
    return { ok: false, error: 'private_lesson payload is required' };
  }
  const enabled = pl.enabled !== false && pl.enabled !== 'false' && pl.enabled !== 0;
  if (!enabled) {
    return { ok: false, error: 'private_lesson.enabled must be true' };
  }
  const sessionCountRaw = pl.session_count != null ? pl.session_count : pl.quantity;
  const quantity = parseInt(String(sessionCountRaw == null ? 1 : sessionCountRaw), 10);
  const surfer_count = parseInt(String(pl.surfer_count == null ? 1 : pl.surfer_count), 10);
  const sessions = Array.isArray(pl.sessions) ? pl.sessions.map((s) => ({
    date: s && s.date,
    start: s && s.start,
    end: s && s.end,
  })) : [];
  const normalized = {
    guest_name: b.guest_name,
    guest_phone: b.guest_phone,
    date_from: b.date_from,
    date_to: b.date_to,
    payment_status: b.payment_status,
    notes: b.notes,
    components: {
      private_lesson: {
        enabled: true,
        quantity,
        surfer_count,
        sessions,
      },
    },
  };
  const validated = validateScheduleBookingBody(normalized);
  if (!validated.ok) {
    return { ok: false, error: validated.error, normalized };
  }
  return { ok: true, value: validated.value, normalized };
}

module.exports = {
  SERVICE_KEY,
  LEGACY_OFFERING_KEY,
  buildPrivateLessonCatalogItem,
  attachSunsetCatalogServices,
  findPrivateLessonCatalogService,
  normalizeLunaPrivateLessonBookingPayload,
};
