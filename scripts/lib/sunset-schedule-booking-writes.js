'use strict';

/**
 * Sunset Schedule — manual booking writes (bookings + booking_service_records).
 * Supports component combos, courses, private lessons, and multi-date via one booking header + many service records.
 */

const crypto = require('crypto');
const { loadPrivateLessonFromDb, defaultPrivateLessonApi } = require('./sunset-admin-private-lesson-rules');
const { normalizeSunsetBookingDatesInBody } = require('./sunset-guest-date-intake');

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
const LUNA_DB_SOURCE = 'luna_guest';
const LUNA_METADATA_SOURCE_TAG = 'luna_guest_whatsapp';

const LUNA_TRUSTED_ACTOR_SOURCES = new Set([
  'agent_luna_whatsapp_bot',
  'agent_luna_whatsapp',
]);

function isLunaTrustedActor(actor) {
  const src = String(actor && actor.source || '').trim().toLowerCase();
  if (!src) return false;
  if (LUNA_TRUSTED_ACTOR_SOURCES.has(src)) return true;
  return /^agent_luna/.test(src);
}

/** Canonical write-time attribution from trusted server-side actor only — never from request body. */
function resolveScheduleBookingAttribution(actor) {
  if (isLunaTrustedActor(actor)) {
    const actorSource = String(actor.source || '').trim();
    return {
      dbSource: LUNA_DB_SOURCE,
      metadataSource: LUNA_METADATA_SOURCE_TAG,
      staffManualSchedule: false,
      lunaGuestBooking: true,
      actorSource,
      createdByStaff: null,
    };
  }
  return {
    dbSource: DB_SOURCE,
    metadataSource: METADATA_SOURCE_TAG,
    staffManualSchedule: true,
    lunaGuestBooking: false,
    actorSource: null,
    createdByStaff: actor && actor.email ? actor.email : null,
  };
}
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

function buildRentalPricingDescriptor(rentalPricing, serviceDates) {
  if (!rentalPricing) return null;
  const service_date = Array.isArray(serviceDates) && serviceDates.length ? serviceDates[0] : null;
  const pricing_group_id = crypto.randomBytes(8).toString('hex');
  const components = rentalPricing.offering_key === 'board_and_suit_rental'
    ? ['surfboard', 'wetsuit']
    : [];
  return {
    pricing_group_id,
    offering_key: rentalPricing.offering_key,
    duration: rentalPricing.duration,
    quantity: rentalPricing.quantity,
    service_date,
    components,
    quoted_total_cents: rentalPricing.quoted_total_cents,
  };
}

const CANONICAL_RENTAL_OFFERING_KEYS = Object.freeze([
  'board_rental',
  'wetsuit_rental',
  'board_and_suit_rental',
]);

const CLIENT_RENTAL_MONEY_FIELDS = Object.freeze([
  'unit_amount_cents', 'amount_cents', 'total_cents', 'line_total_cents',
  'unit_price', 'unit_amount', 'line_total', 'currency_amount', 'price_source',
  'amount', 'price', 'label',
]);

function inclusiveIsoDatesFromRange(dateFrom, dateTo) {
  const from = String(dateFrom || '').slice(0, 10);
  const to = String(dateTo || dateFrom || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) {
    return [];
  }
  const out = [];
  let cur = from;
  while (cur <= to && out.length < 31) {
    out.push(cur);
    const d = new Date(`${cur}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    cur = d.toISOString().slice(0, 10);
  }
  return out;
}

function rentalDurationKeyFromDateRange(dateFrom, dateTo) {
  const dates = inclusiveIsoDatesFromRange(dateFrom, dateTo);
  if (dates.length < 1) return null;
  if (dates.length === 1) return '1_day';
  return `${dates.length}_days`;
}

/**
 * When canonical rentals[] is present, expand into operational components and
 * capture rental context for authoritative quote application on create.
 */
function prepareCanonicalRentalsForCreate(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!Object.prototype.hasOwnProperty.call(b, 'rentals')) {
    return { ok: true, present: false, body: b, rentals: null };
  }
  if (!Array.isArray(b.rentals)) {
    return { ok: false, error: 'rentals must be an array', reason: 'invalid_rentals' };
  }
  for (let i = 0; i < b.rentals.length; i += 1) {
    const row = b.rentals[i];
    if (!row || typeof row !== 'object') {
      return { ok: false, error: `rentals[${i}] must be an object`, reason: 'invalid_rentals' };
    }
    for (const key of CLIENT_RENTAL_MONEY_FIELDS) {
      if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
        return { ok: false, error: `rentals[${i}].${key} must not be supplied by the client`, reason: 'client_money_rejected' };
      }
    }
  }

  const dateFrom = String(b.date_from || '').slice(0, 10);
  const dateTo = String(b.date_to || b.date_from || '').slice(0, 10);
  if (!dateFrom || !dateTo) {
    return { ok: false, error: 'date_from and date_to are required for canonical rental bookings', reason: 'invalid_date' };
  }
  const rangeDates = inclusiveIsoDatesFromRange(dateFrom, dateTo);
  if (!rangeDates.length) {
    return { ok: false, error: 'invalid date_from/date_to range', reason: 'invalid_date' };
  }
  if (Object.prototype.hasOwnProperty.call(b, 'service_dates')) {
    if (!Array.isArray(b.service_dates)) {
      return { ok: false, error: 'service_dates must be an array', reason: 'invalid_service_dates' };
    }
    const got = b.service_dates.map((d) => String(d || '').slice(0, 10)).filter(Boolean);
    if (got.length !== b.service_dates.length || new Set(got).size !== got.length) {
      return { ok: false, error: 'service_dates must be unique YYYY-MM-DD dates', reason: 'invalid_service_dates' };
    }
    const expected = rangeDates.slice().sort();
    const sortedGot = got.slice().sort();
    if (expected.length !== sortedGot.length || expected.some((d, i) => d !== sortedGot[i])) {
      return {
        ok: false,
        error: 'service_dates must match the inclusive date_from/date_to range exactly',
        reason: 'service_dates_mismatch',
      };
    }
  }

  const expectedDuration = rentalDurationKeyFromDateRange(dateFrom, dateTo);
  const seen = new Set();
  const rentals = [];
  for (let i = 0; i < b.rentals.length; i += 1) {
    const row = b.rentals[i];
    const offeringKey = String(row.offering_key || '').trim();
    if (!CANONICAL_RENTAL_OFFERING_KEYS.includes(offeringKey)) {
      return { ok: false, error: `rentals[${i}].offering_key is not allowed`, reason: 'invalid_rental_offering' };
    }
    if (seen.has(offeringKey)) {
      return { ok: false, error: `duplicate rentals offering_key ${offeringKey}`, reason: 'duplicate_rental_offering' };
    }
    seen.add(offeringKey);
    const durationKey = String(row.duration_key || '').trim();
    if (!durationKey) {
      return { ok: false, error: `rentals[${i}].duration_key is required`, reason: 'invalid_rental_duration' };
    }
    if (durationKey !== expectedDuration) {
      return {
        ok: false,
        error: `rentals[${i}].duration_key must be ${expectedDuration} for the selected dates`,
        reason: 'rental_duration_mismatch',
      };
    }
    const qty = Number(row.quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      return { ok: false, error: `rentals[${i}].quantity must be a positive integer`, reason: 'invalid_rental_quantity' };
    }
    rentals.push({ offering_key: offeringKey, duration_key: durationKey, quantity: qty });
  }
  if (seen.has('board_and_suit_rental') && (seen.has('board_rental') || seen.has('wetsuit_rental'))) {
    return {
      ok: false,
      error: 'board_and_suit_rental cannot be combined with board_rental or wetsuit_rental',
      reason: 'rental_bundle_conflict',
    };
  }

  const components = { ...(b.components && typeof b.components === 'object' ? b.components : {}) };
  const expectedLegacy = { surfboard: null, wetsuit: null };
  for (const row of rentals) {
    if (row.offering_key === 'board_rental') expectedLegacy.surfboard = row.quantity;
    else if (row.offering_key === 'wetsuit_rental') expectedLegacy.wetsuit = row.quantity;
    else if (row.offering_key === 'board_and_suit_rental') {
      expectedLegacy.surfboard = row.quantity;
      expectedLegacy.wetsuit = row.quantity;
    }
  }
  for (const key of ['surfboard', 'wetsuit']) {
    if (expectedLegacy[key] == null) continue;
    if (components[key]) {
      const legQty = Number(components[key].quantity);
      if (!Number.isInteger(legQty) || legQty !== expectedLegacy[key]) {
        return {
          ok: false,
          error: `components.${key}.quantity does not match canonical rentals`,
          reason: 'legacy_rental_mismatch',
        };
      }
    } else {
      components[key] = { quantity: expectedLegacy[key] };
    }
  }

  return {
    ok: true,
    present: true,
    rentals,
    rentalSpanDates: rangeDates,
    pricingGroupId: crypto.randomBytes(8).toString('hex'),
    body: {
      ...b,
      components,
      service_dates: rangeDates,
      date_from: dateFrom,
      date_to: dateTo,
    },
  };
}

function findQuoteLineForRentalOffering(lineItems, offeringKey) {
  const lines = Array.isArray(lineItems) ? lineItems : [];
  return lines.find((l) => l && (
    String(l.component || '') === offeringKey
    || String(l.offering_id || '') === offeringKey
    || String(l.offering_item_code || '').startsWith(`${offeringKey}__`)
  )) || null;
}

function rowMetadata(row) {
  if (row && row.metadata && typeof row.metadata === 'object') return row.metadata;
  if (row && typeof row.metadata === 'string') {
    try { return JSON.parse(row.metadata); } catch (_) { return {}; }
  }
  return {};
}

function rowMatchesQuoteLine(row, line) {
  const component = String((line && line.component) || '').trim();
  const meta = rowMetadata(row);
  const serviceType = String(row.service_type || '').trim();
  if (component === 'course') {
    return meta.component === 'course' || serviceType === 'course';
  }
  if (component === 'private_lesson') {
    return meta.component === 'private_lesson' || serviceType === 'private_lesson';
  }
  if (component === 'lesson') {
    return meta.component === 'lesson' || serviceType === 'lesson';
  }
  if (component === 'board_and_suit_rental') {
    return meta.offering_key === 'board_and_suit_rental'
      && (serviceType === 'surfboard' || serviceType === 'wetsuit'
        || meta.component === 'surfboard' || meta.component === 'wetsuit'
        || meta.bundle_part === 'surfboard' || meta.bundle_part === 'wetsuit');
  }
  if (component === 'board_rental') {
    return meta.offering_key === 'board_rental'
      && (serviceType === 'surfboard' || meta.component === 'surfboard');
  }
  if (component === 'wetsuit_rental') {
    return meta.offering_key === 'wetsuit_rental'
      && (serviceType === 'wetsuit' || meta.component === 'wetsuit');
  }
  if (component === FULL_DAY_EQUIPMENT_ADDON_KEY || component === 'addon_service') {
    return meta.component === FULL_DAY_EQUIPMENT_ADDON_KEY
      || serviceType === 'addon_service'
      || meta.service_key === FULL_DAY_EQUIPMENT_ADDON_KEY;
  }
  return false;
}

/**
 * Assign every operational row to exactly one authoritative quote line and
 * persist amounts. Bundle constituents beyond the primary row are explicitly
 * zero-valued. Unclaimed / double-claimed / missing rows fail closed.
 */
async function applyAuthoritativeQuoteAmounts(pg, createdRows, quoteBody, opts = {}) {
  const clientSlug = String((opts && opts.clientSlug) || '').trim();
  if (!clientSlug) {
    return { ok: false, error: 'client_slug_required' };
  }
  const lines = Array.isArray(quoteBody && quoteBody.line_items) ? quoteBody.line_items.slice() : [];
  if (!lines.length) {
    return { ok: false, error: 'quote_line_items_required' };
  }
  const quoteTotal = Number(quoteBody && quoteBody.total_cents);
  if (!Number.isFinite(quoteTotal) || quoteTotal < 0) {
    return { ok: false, error: 'invalid_quote_total' };
  }
  const lineTotalSum = lines.reduce((sum, line) => sum + (Number(line && line.total_cents) || 0), 0);
  if (lineTotalSum !== quoteTotal) {
    return { ok: false, error: 'quote_line_total_mismatch' };
  }

  const sortedRows = (createdRows || []).slice().sort((a, b) => {
    const d = String(a.service_date || '').localeCompare(String(b.service_date || ''));
    if (d) return d;
    return String(a.service_record_id || a.id || '').localeCompare(String(b.service_record_id || b.id || ''));
  });

  // Exclusive ownership: each row may match at most one quote line.
  const rowToLineIndex = new Map();
  for (const row of sortedRows) {
    const id = String(row.service_record_id || row.id || '');
    const matches = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (rowMatchesQuoteLine(row, lines[i])) matches.push(i);
    }
    if (matches.length > 1) {
      return { ok: false, error: 'duplicate_row_claim' };
    }
    if (matches.length === 1) {
      rowToLineIndex.set(id, matches[0]);
    }
  }

  const unclaimed = sortedRows.filter((row) => {
    const id = String(row.service_record_id || row.id || '');
    return !rowToLineIndex.has(id);
  });
  if (unclaimed.length) {
    const meta = rowMetadata(unclaimed[0]);
    const label = meta.component || meta.offering_key || unclaimed[0].service_type || 'unknown';
    return { ok: false, error: 'unclaimed_service_row_' + label };
  }

  let appliedLineTotal = 0;
  let persistedAmountSum = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const component = String((line && line.component) || '').trim() || 'line';
    const matches = sortedRows.filter((row) => {
      const id = String(row.service_record_id || row.id || '');
      return rowToLineIndex.get(id) === lineIndex;
    });
    if (!matches.length) {
      return { ok: false, error: 'no_operational_rows_for_' + component };
    }
    const lineTotal = Number(line.total_cents);
    if (!Number.isFinite(lineTotal) || lineTotal < 0) {
      return { ok: false, error: 'invalid_quote_line_total' };
    }
    appliedLineTotal += lineTotal;
    for (let i = 0; i < matches.length; i += 1) {
      const row = matches[i];
      const id = String(row.service_record_id || row.id || '');
      // Primary row carries the line total; remaining bundle/span constituents are explicit zeros.
      const due = i === 0 ? lineTotal : 0;
      const upd = await pg.query(
        // MULTICLIENT_SCOPE_OK: same-txn service row; client_slug predicate defense-in-depth
        'UPDATE booking_service_records SET amount_due_cents = $1 WHERE id = $2::uuid AND client_slug = $3',
        [due, id, clientSlug],
      );
      if (Number(upd && upd.rowCount) !== 1) {
        return { ok: false, error: 'service_amount_update_mismatch' };
      }
      persistedAmountSum += due;
    }
  }

  if (appliedLineTotal !== quoteTotal) {
    return { ok: false, error: 'applied_line_total_mismatch' };
  }
  if (persistedAmountSum !== quoteTotal) {
    return { ok: false, error: 'persisted_amount_sum_mismatch' };
  }
  if (quoteTotal <= 0) {
    return { ok: false, error: 'booking_total_zero' };
  }
  return { ok: true, total_cents: persistedAmountSum, applied_line_total_cents: appliedLineTotal };
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
      if (map[iso] != null) {
        return { ok: false, error: `components.${FULL_DAY_EQUIPMENT_ADDON_KEY}.dates contains duplicate date ${iso}` };
      }
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

// Exact approved legacy aliases only — never fuzzy-match keys containing
// "group"/"class"/"lesson". Unknown aliases fail closed.
const EXACT_COMPONENT_ALIASES = Object.freeze({
  group_lesson: 'lesson',
});

function applyExactComponentAliases(components) {
  const src = components && typeof components === 'object' ? components : {};
  const out = {};
  for (const [rawKey, part] of Object.entries(src)) {
    const key = EXACT_COMPONENT_ALIASES[rawKey] || rawKey;
    if (Object.prototype.hasOwnProperty.call(out, key) && EXACT_COMPONENT_ALIASES[rawKey]) {
      return { ok: false, error: `ambiguous component alias ${rawKey} with existing ${key}` };
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      return { ok: false, error: `duplicate component key ${key}` };
    }
    out[key] = part;
  }
  return { ok: true, value: out };
}

function normalizeComponents(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.components && typeof b.components === 'object') {
    const aliased = applyExactComponentAliases(b.components);
    if (!aliased.ok) return aliased;
    const componentsIn = aliased.value;
    const unknownKeys = Object.keys(componentsIn).filter((key) => !UI_COMPONENT_KEYS.has(key));
    if (unknownKeys.length) {
      return { ok: false, error: `unknown components: ${unknownKeys.join(', ')}` };
    }
    const MODEL_MONEY_FIELDS = new Set([
      'price', 'unit_price', 'unit_amount', 'unit_amount_cents',
      'amount', 'amount_cents', 'total', 'total_cents',
      'line_total', 'line_total_cents', 'currency', 'price_source',
      'offering_key', 'item_code', 'unit',
    ]);
    const out = {};
    for (const key of UI_COMPONENT_KEYS) {
      if (key === 'private_lesson') continue;
      if (key === FULL_DAY_EQUIPMENT_ADDON_KEY) continue;
      const part = componentsIn[key];
      if (!part) continue;
      if (typeof part !== 'object') {
        return { ok: false, error: `components.${key} must be an object` };
      }
      // Ignore/reject model-supplied money — Staff API is the price authority.
      for (const mk of Object.keys(part)) {
        if (MODEL_MONEY_FIELDS.has(String(mk).toLowerCase())) {
          return { ok: false, error: `components.${key}.${mk} must not be supplied by the client` };
        }
      }
      // Top-level request money fields are also rejected below.
      const qty = parseQuantity(part.quantity != null ? part.quantity : part.count, 1);
      if (!qty) return { ok: false, error: `components.${key}.quantity must be 1–99` };
      const entry = { quantity: qty };
      if (key === 'lesson') {
        const slot = String(part.slot_time || part.time_local || b.time_local || b.slot_time || '').trim();
        if (slot && !isTimeHm(slot)) return { ok: false, error: 'lesson slot_time must be HH:MM' };
        entry.slot_time = slot || null;
        entry.category = String(part.category || b.lesson_category || DEFAULT_LESSON_CATEGORY).trim() || DEFAULT_LESSON_CATEGORY;
        const offeringId = String(part.offering_id || '').trim();
        if (offeringId) entry.offering_id = offeringId;
      }
      if (key === 'course') {
        const courseId = String(part.course_id || '').trim();
        if (!courseId) return { ok: false, error: 'components.course.course_id is required' };
        entry.course_id = courseId;
        const { sanitizeCourseLabelForStorage } = require('./sunset-course-display-label');
        entry.course_label = sanitizeCourseLabelForStorage(
          courseId,
          part.course_label || part.label || '',
        );
        const { PACK_TIER_KEYS, packPriceItemCode } = require('./sunset-admin-pack-rules');
        let tierKey = '';
        if (part.tier && part.tier.key != null) tierKey = String(part.tier.key).trim();
        else if (part.tier_key != null) tierKey = String(part.tier_key).trim();
        else if (part.duration_key != null) tierKey = String(part.duration_key).trim();
        const offeringIdRaw = String(part.offering_id || '').trim();
        // Prefer extracting the admin suffix from surf_pack_<id>__<tier> when
        // the guest/staff selected the catalog offering_item_code.
        if (!tierKey && /^surf_pack_.+__.+$/i.test(offeringIdRaw)) {
          tierKey = offeringIdRaw.split('__').pop() || '';
        }
        if (tierKey && !PACK_TIER_KEYS.has(tierKey)) {
          return { ok: false, error: `components.course.tier_key invalid: ${tierKey}` };
        }
        if (!tierKey) {
          // Course bookings must resolve an exact Admin offering
          // (surf_pack_<courseId>__<tier>). Never accept bare course_id.
          return { ok: false, error: 'components.course.tier_key is required' };
        }
        entry.tier_key = tierKey;
        // Canonical DB item_code — must match tenant_price_rules.item_code.
        // Prefer server-derived identity over any browser-supplied offering_id.
        entry.offering_id = packPriceItemCode(courseId, tierKey);
      }
      out[key] = entry;
    }
    if (componentsIn.private_lesson) {
      const pl = normalizePrivateLessonPart(componentsIn.private_lesson);
      if (!pl.ok) return pl;
      if (!pl.skip) out.private_lesson = pl.value;
    }
    if (!Object.keys(out).length) {
      return { ok: false, error: 'components must include at least one of lesson, course, private_lesson, surfboard, wetsuit' };
    }
    // Full-day equipment add-on is only valid alongside an eligible base component.
    if (componentsIn[FULL_DAY_EQUIPMENT_ADDON_KEY]) {
      const addon = normalizeFullDayEquipmentAddon(componentsIn[FULL_DAY_EQUIPMENT_ADDON_KEY]);
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

function validateScheduleBookingBody(body, opts) {
  opts = opts || {};
  const dateBoundary = normalizeSunsetBookingDatesInBody(body, opts.refDate || new Date(), opts);
  if (!dateBoundary.ok) {
    return { ok: false, error: dateBoundary.reason || 'invalid_date' };
  }
  const b = dateBoundary.body;
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
  if (!rentalPricing.skip && serviceDates.value.length > 1) {
    return { ok: false, error: 'rental_pricing requires exactly one service date' };
  }

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
            sr.metadata->>'components' AS metadata_components,
            sr.metadata->>'location_id' AS location_id,
            sr.metadata->>'idempotency_intent_fp' AS idempotency_intent_fp,
            sr.metadata->>'idempotency_key' AS idempotency_key
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
  const attribution = opts.attribution || resolveScheduleBookingAttribution(null);
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
      source: attribution.metadataSource,
      staff_manual_schedule: attribution.staffManualSchedule,
      actor_source: attribution.actorSource || null,
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
      created_by_staff: attribution.createdByStaff || opts.actorEmail || null,
      updated_by_staff: attribution.createdByStaff || opts.actorEmail || null,
      idempotency_key: opts.idempotencyKey || null,
      idempotency_intent_fp: opts.idempotencyIntentFp || null,
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
        attribution.dbSource,
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

function canonicalRentalsForIntentFingerprint(rentals) {
  if (!Array.isArray(rentals) || !rentals.length) return [];
  return rentals
    .map((r) => ({
      offering_key: String((r && r.offering_key) || '').trim(),
      duration_key: String((r && r.duration_key) || '').trim(),
      quantity: Number(r && r.quantity) || 0,
    }))
    .filter((r) => r.offering_key)
    .sort((a, b) => (a.offering_key < b.offering_key ? -1 : (a.offering_key > b.offering_key ? 1 : 0)));
}

function buildScheduleBookingIntentFingerprint(input, locationId, opts) {
  opts = opts || {};
  const components = input && input.components ? input.components : {};
  const ordered = {};
  Object.keys(components).sort().forEach((k) => { ordered[k] = components[k]; });
  const rentalsSrc = opts.rentals != null ? opts.rentals
    : (input && input.rentals != null ? input.rentals : []);
  const payload = {
    location_id: String(locationId || ''),
    guest_name: String((input && input.guest_name) || ''),
    guest_phone: input && input.guest_phone != null ? String(input.guest_phone) : '',
    payment_status: String((input && input.payment_status) || 'unpaid'),
    service_dates: ((input && input.service_dates) || []).slice().sort(),
    components: ordered,
    rentals: canonicalRentalsForIntentFingerprint(rentalsSrc),
    notes: String((input && input.notes) || ''),
    needs_reply: !!(input && input.needs_reply),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function scheduleBookingIdempotencyAdvisoryKeys(clientSlug, idempotencyKey) {
  const h = crypto.createHash('sha256')
    .update(`sunset-schedule-create\0${String(clientSlug || '')}\0${String(idempotencyKey || '')}`)
    .digest();
  return [h.readInt32BE(0), h.readInt32BE(4)];
}

function evaluateIdempotentReplay(existingRows, input, locationId, opts) {
  if (!existingRows || !existingRows.length) return { replay: false };
  const first = existingRows[0];
  const reqLoc = String(locationId || '');
  const metaLoc = first.location_id != null && first.location_id !== ''
    ? String(first.location_id) : null;
  if (metaLoc != null && metaLoc !== reqLoc) {
    return {
      ok: false, status: 409,
      body: { success: false, error: 'idempotency_key_location_conflict', reason_code: 'idempotency_key_location_conflict' },
    };
  }
  const storedFp = first.idempotency_intent_fp != null ? String(first.idempotency_intent_fp).trim() : '';
  if (!storedFp) {
    return {
      ok: false, status: 409,
      body: { success: false, error: 'idempotency_key_intent_unverifiable', reason_code: 'idempotency_key_intent_unverifiable' },
    };
  }
  const nextFp = buildScheduleBookingIntentFingerprint(input, locationId, opts);
  if (storedFp !== nextFp) {
    return {
      ok: false, status: 409,
      body: { success: false, error: 'idempotency_key_intent_conflict', reason_code: 'idempotency_key_intent_conflict' },
    };
  }
  return {
    ok: true, replay: true, status: 200,
    body: {
      success: true, idempotent: true,
      booking_code: first.booking_code, booking_id: first.booking_id,
      records: existingRows.map(scheduleRowFromDb), booking: scheduleRowFromDb(first),
    },
  };
}

async function createSunsetScheduleBooking(pg, opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, body: { success: false, error: 'unsupported_client', client_slug: clientSlug } };
  }

  const rentalPrep = prepareCanonicalRentalsForCreate(opts.body);
  if (!rentalPrep.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        error: rentalPrep.error,
        reason: rentalPrep.reason,
        reason_code: rentalPrep.reason,
      },
    };
  }

  const validated = validateScheduleBookingBody(rentalPrep.body);
  if (!validated.ok) {
    return { ok: false, status: 400, body: { success: false, error: validated.error } };
  }
  const input = validated.value;
  const locationId = opts.locationId != null ? String(opts.locationId).trim() : '';
  const attribution = resolveScheduleBookingAttribution(opts.actor);
  const canonicalRentals = rentalPrep.present ? rentalPrep.rentals : null;
  const rentalSpanDates = rentalPrep.present ? rentalPrep.rentalSpanDates : null;
  const rentalPricingGroupId = rentalPrep.present ? rentalPrep.pricingGroupId : null;
  const intentFpOpts = { rentals: canonicalRentals || [] };
  const idempotencyIntentFp = input.idempotency_key
    ? buildScheduleBookingIntentFingerprint(input, locationId, intentFpOpts)
    : null;

  if (input.idempotency_key) {
    const existingRows = await findIdempotentBooking(pg, clientSlug, input.idempotency_key);
    if (existingRows && existingRows.length) {
      const evaluated = evaluateIdempotentReplay(existingRows, input, locationId, intentFpOpts);
      if (evaluated.replay) {
        return { ok: true, status: evaluated.status, body: evaluated.body };
      }
      if (evaluated.ok === false) return evaluated;
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

  // Course bookings must join an existing admin-configured surf pack — never mint
  // invented course_ids or arbitrary dates outside that pack's schedule/capacity.
  let assignedCourse = null;
  let coursePricePreflight = null;
  if (input.components.course) {
    const { assertCourseAssignable } = require('./sunset-admin-course-join');
    const gate = await assertCourseAssignable(pg, {
      clientSlug,
      locationId,
      courseId: input.components.course.course_id,
      serviceDates: input.service_dates,
      quantity: input.components.course.quantity,
    });
    if (!gate.ok) return gate;
    assignedCourse = gate;
    // Preserve Luna/staff attribution; only overwrite blank label with admin label.
    if (!input.components.course.course_label
      || input.components.course.course_label === input.components.course.course_id) {
      input.components.course.course_label = gate.course_label || input.components.course.course_label;
    }
    const tierKey = String(input.components.course.tier_key || '').trim();
    if (!tierKey) {
      return {
        ok: false,
        status: 400,
        body: {
          success: false,
          error: 'Select a course duration before creating the booking.',
          reason_code: 'components.course.tier_key is required',
        },
      };
    }
    const packTiers = ((gate.pack && gate.pack.price_tiers) || [])
      .map((t) => String((t && t.key) || '').trim())
      .filter(Boolean);
    if (!packTiers.includes(tierKey)) {
      return {
        ok: false,
        status: 400,
        body: {
          success: false,
          error: 'Select a course duration that belongs to the selected course.',
          reason_code: 'course_tier_mismatch',
        },
      };
    }
    const { packPriceItemCode } = require('./sunset-admin-price-identity');
    const { resolveActiveSunsetAdminPrice, staffFacingSunsetAdminPriceError } = require('./sunset-admin-price-resolve');
    input.components.course.offering_id = packPriceItemCode(input.components.course.course_id, tierKey);
    const lookupArgs = {
      clientSlug,
      locationId,
      quantity: input.components.course.quantity,
      metadata: {
        component: 'course',
        staff_ui_service_type: 'course',
        course_id: input.components.course.course_id,
        tier_key: tierKey,
        offering_id: input.components.course.offering_id,
        location_id: locationId,
      },
      pgClient: pg,
    };
    coursePricePreflight = await resolveActiveSunsetAdminPrice(pg, lookupArgs);
    // Heal: Admin Courses card can show config_json amounts while the linked
    // tenant_price_rules row is missing/wrong-unit. Sync owner-entered tier
    // amounts into the canonical identity, then retry once.
    if (!coursePricePreflight || coursePricePreflight.ok !== true) {
      try {
        const { syncPackTierToPriceRules } = require('./sunset-admin-price-sync');
        const pack = gate.pack || {};
        await syncPackTierToPriceRules(pg, {
          clientSlug,
          locationId,
          packId: pack.pack_id || input.components.course.course_id,
          packLabel: pack.label || input.components.course.course_label || 'Course',
          tiers: pack.price_tiers || [],
          actor: opts.actor || {},
          skipTransaction: true,
        });
        coursePricePreflight = await resolveActiveSunsetAdminPrice(pg, lookupArgs);
      } catch (_) {
        // Keep original failure.
      }
    }
    if (!coursePricePreflight || coursePricePreflight.ok !== true
      || !(coursePricePreflight.amount_cents > 0)) {
      const faced = staffFacingSunsetAdminPriceError(
        (coursePricePreflight && coursePricePreflight.reason) || 'no_price_for_surf_lesson',
        coursePricePreflight && coursePricePreflight.identity,
      );
      return {
        ok: false,
        status: 422,
        body: {
          success: false,
          error: faced.error,
          reason_code: faced.reason_code,
          detail: (coursePricePreflight && coursePricePreflight.reason) || 'price_not_configured',
        },
      };
    }
  }

  const srPayment = UI_TO_SR_PAYMENT[input.payment_status];
  const bookingPayment = UI_TO_BOOKING_PAYMENT[input.payment_status];
  const bookingStatus = bookingStatusFromPayment(input.payment_status);
  const bookingCode = generateSunsetManualBookingCode(locationId);
  const bundleId = crypto.randomBytes(8).toString('hex');
  let rentalPricingDescriptor = buildRentalPricingDescriptor(input.rental_pricing, input.service_dates);
  if (canonicalRentals) {
    const bundleRental = canonicalRentals.find((r) => r.offering_key === 'board_and_suit_rental');
    if (bundleRental) {
      rentalPricingDescriptor = {
        pricing_group_id: rentalPricingGroupId,
        offering_key: bundleRental.offering_key,
        duration: bundleRental.duration_key,
        quantity: bundleRental.quantity,
        service_date: (rentalSpanDates && rentalSpanDates[0]) || input.service_dates[0],
        components: ['surfboard', 'wetsuit'],
        quoted_total_cents: null,
        rental_service_dates: rentalSpanDates,
      };
    }
  }
  const componentKeys = componentList(input.components);
  const guestCount = resolveGuestCount(input.components);
  const { firstDate } = bookingHeaderDates(input);

  await pg.query('BEGIN');
  try {
    if (input.idempotency_key) {
      const [k1, k2] = scheduleBookingIdempotencyAdvisoryKeys(clientSlug, input.idempotency_key);
      await pg.query('SELECT pg_advisory_xact_lock($1, $2)', [k1, k2]);
      const lockedRows = await findIdempotentBooking(pg, clientSlug, input.idempotency_key);
      if (lockedRows && lockedRows.length) {
        const evaluated = evaluateIdempotentReplay(lockedRows, input, locationId, intentFpOpts);
        if (evaluated.replay) {
          await pg.query('ROLLBACK');
          return { ok: true, status: evaluated.status, body: evaluated.body };
        }
        if (evaluated.ok === false) {
          await pg.query('ROLLBACK');
          return evaluated;
        }
      }
    }

    let authoritativeQuote = null;
    if (canonicalRentals) {
      const {
        buildSunsetQuoteCommand,
        executeSunsetQuote,
        buildQuoteProvenance,
        QUOTE_CHANNELS,
      } = require('./luna-front-desk-quote-service');
      const { resolveTenantBusinessConfigAsync } = require('./tenant-business-config');
      const adminCfg = await resolveTenantBusinessConfigAsync(clientSlug, {
        locationId,
        pgClient: pg,
      });
      if (!adminCfg || adminCfg.ok === false) {
        const err = new Error('admin_config_unavailable');
        err.sunsetPriceFail = {
          ok: false,
          status: 422,
          body: { success: false, error: 'admin_config_unavailable', reason_code: 'admin_db_expected_unavailable' },
        };
        throw err;
      }
      const channel = opts.quoteChannel === 'luna_whatsapp'
        ? QUOTE_CHANNELS.LUNA_WHATSAPP
        : QUOTE_CHANNELS.MANUAL_STAFF;
      const quoteBuilt = buildSunsetQuoteCommand({
        channel,
        trustedLocationId: locationId,
        transportBody: {
          ...rentalPrep.body,
          require_db: true,
        },
        now: opts.now instanceof Date ? opts.now : new Date(),
      });
      if (!quoteBuilt.ok) {
        const err = new Error((quoteBuilt.body && quoteBuilt.body.error) || 'quote_failed');
        err.sunsetPriceFail = quoteBuilt;
        throw err;
      }
      const freshQuote = await executeSunsetQuote(pg, quoteBuilt.command, { adminCfg });
      if (!freshQuote.ok) {
        const err = new Error((freshQuote.body && (freshQuote.body.error || freshQuote.body.reason)) || 'quote_failed');
        err.sunsetPriceFail = {
          ok: false,
          status: freshQuote.status || 422,
          body: {
            success: false,
            error: (freshQuote.body && (freshQuote.body.error || freshQuote.body.reason)) || 'quote_failed',
            reason_code: (freshQuote.body && (freshQuote.body.reason_code || freshQuote.body.reason)) || 'quote_failed',
            quote_error: freshQuote.body,
          },
        };
        throw err;
      }
      const provenance = opts.quoteProvenance;
      if (provenance && typeof provenance === 'object') {
        const freshProv = buildQuoteProvenance(freshQuote.body);
        if (String(provenance.quote_fingerprint || '') !== String(freshProv.quote_fingerprint || '')) {
          const err = new Error('stale_quote');
          err.sunsetPriceFail = {
            ok: false,
            status: 409,
            body: {
              success: false,
              error: 'The quoted price is no longer available. Please request a fresh quote.',
              reason_code: 'stale_quote',
              detail: 'quote_fingerprint_mismatch',
              expected_fingerprint: provenance.quote_fingerprint,
              current_fingerprint: freshProv.quote_fingerprint,
            },
          };
          throw err;
        }
      }
      authoritativeQuote = freshQuote.body;
      if (rentalPricingDescriptor && rentalPricingDescriptor.offering_key === 'board_and_suit_rental') {
        const bundleLine = findQuoteLineForRentalOffering(
          authoritativeQuote.line_items,
          'board_and_suit_rental',
        );
        if (bundleLine && bundleLine.total_cents != null) {
          rentalPricingDescriptor.quoted_total_cents = Number(bundleLine.total_cents);
        }
      }
    }

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
          source: attribution.metadataSource,
          staff_manual_schedule: attribution.staffManualSchedule,
          luna_guest_booking: attribution.lunaGuestBooking,
          actor_source: attribution.actorSource,
          bundle_id: bundleId,
          components: componentKeys,
          guest_phone: input.guest_phone,
          location_id: locationId || null,
          rental_pricing: rentalPricingDescriptor || null,
          rentals: canonicalRentals || null,
          idempotency_key: input.idempotency_key || null,
          idempotency_intent_fp: idempotencyIntentFp || null,
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
          source: attribution.metadataSource,
          staff_manual_schedule: attribution.staffManualSchedule,
          actor_source: attribution.actorSource || null,
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
          created_by_staff: attribution.createdByStaff,
          idempotency_key: input.idempotency_key,
          idempotency_intent_fp: idempotencyIntentFp || null,
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
          attribution.dbSource,
          JSON.stringify(metadata),
        ], {
          service_time_local: session.start,
          service_time_local_end: session.end,
        });
        // INSERT RETURNING flattens metadata; reattach nested object so
        // applyAuthoritativeQuoteAmounts / rowMatchesQuoteLine can claim private rows.
        createdRows.push({ ...row, metadata });
      }
    }

    for (const serviceDate of input.service_dates) {
      for (const componentKey of componentKeys) {
        if (componentKey === 'private_lesson') continue;
        if (componentKey === FULL_DAY_EQUIPMENT_ADDON_KEY) continue;
        const part = input.components[componentKey];
        const dbServiceType = UI_TO_DB_SERVICE_TYPE[componentKey];
        const metadata = {
          source: attribution.metadataSource,
          staff_manual_schedule: attribution.staffManualSchedule,
          actor_source: attribution.actorSource || null,
          staff_ui_service_type: staffUiServiceType(componentKey),
          component: componentKey,
          components: componentKeys,
          bundle_id: bundleId,
          slot_time: componentKey === 'lesson' ? part.slot_time : null,
          lesson_category: componentKey === 'lesson' ? part.category : null,
          course_id: componentKey === 'course' ? part.course_id : null,
          course_label: componentKey === 'course' ? part.course_label : null,
          tier_key: componentKey === 'course' ? (part.tier_key || null) : null,
          offering_id: part.offering_id || null,
          admin_course_assigned: componentKey === 'course' && assignedCourse ? true : undefined,
          admin_pack_id: componentKey === 'course' && assignedCourse ? assignedCourse.course_id : undefined,
          notes: input.notes || null,
          needs_reply: input.needs_reply,
          guest_phone: input.guest_phone,
          location_id: locationId || null,
          created_by_staff: attribution.createdByStaff,
          idempotency_key: input.idempotency_key,
          idempotency_intent_fp: idempotencyIntentFp || null,
        };
        if (canonicalRentals && (componentKey === 'surfboard' || componentKey === 'wetsuit')) {
          const rental = canonicalRentals.find((r) => {
            if (r.offering_key === 'board_and_suit_rental') return true;
            if (componentKey === 'surfboard') return r.offering_key === 'board_rental';
            return r.offering_key === 'wetsuit_rental';
          });
          if (rental) {
            const quoteLine = authoritativeQuote
              ? findQuoteLineForRentalOffering(authoritativeQuote.line_items, rental.offering_key)
              : null;
            metadata.offering_key = rental.offering_key;
            metadata.duration_key = rental.duration_key;
            metadata.quantity = rental.quantity;
            metadata.rental_service_dates = rentalSpanDates;
            metadata.offering_id = `${rental.offering_key}__${rental.duration_key}`;
            if (rental.offering_key === 'board_and_suit_rental') {
              metadata.pricing_group_id = rentalPricingGroupId;
              metadata.bundle_part = componentKey;
              metadata.rental_pricing_role = componentKey;
              metadata.rental_bundle_id = rentalPricingGroupId;
            }
            if (quoteLine) {
              metadata.price_id = quoteLine.price_id || null;
              metadata.unit_amount_cents = quoteLine.unit_amount_cents;
              metadata.price_identity = {
                price_id: quoteLine.price_id || null,
                item_code: quoteLine.offering_item_code || quoteLine.offering_id || metadata.offering_id,
                unit: rental.duration_key,
              };
            }
          }
        } else if (rentalPricingDescriptor
          && (componentKey === 'surfboard' || componentKey === 'wetsuit')
          && serviceDate === rentalPricingDescriptor.service_date) {
          metadata.pricing_group_id = rentalPricingDescriptor.pricing_group_id;
          metadata.rental_pricing_role = componentKey;
        }
        const row = await insertServiceRecord(pg, [
          clientSlug,
          bookingId,
          bookingCode,
          input.guest_name,
          dbServiceType,
          serviceDate,
          part.quantity,
          srPayment,
          attribution.dbSource,
          JSON.stringify(metadata),
        ]);
        createdRows.push({ ...row, metadata });
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
        actorEmail: attribution.createdByStaff,
        idempotencyKey: input.idempotency_key,
        idempotencyIntentFp: idempotencyIntentFp || null,
        attribution,
      });
      addonRows.forEach((r) => createdRows.push(r));
    }

    let priced;
    if (authoritativeQuote) {
      const applied = await applyAuthoritativeQuoteAmounts(pg, createdRows, authoritativeQuote, {
        clientSlug,
      });
      if (!applied.ok) {
        const err = new Error(applied.error || 'quote_amount_apply_failed');
        err.sunsetPriceFail = {
          ok: false,
          status: 422,
          body: {
            success: false,
            error: applied.error || 'quote_amount_apply_failed',
            reason_code: applied.error || 'quote_amount_apply_failed',
          },
        };
        throw err;
      }
      const bookingUpd = await pg.query(
        // MULTICLIENT_SCOPE_OK: same-txn booking header; client_id predicate defense-in-depth
        `UPDATE bookings
            SET total_amount_cents = $1,
                balance_due_cents = GREATEST($1 - COALESCE(amount_paid_cents, 0), 0),
                metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
          WHERE id = $3::uuid AND client_id = $4::uuid`,
        [
          applied.total_cents,
          JSON.stringify({
            sunset_priced_at: new Date().toISOString(),
            sunset_price_source: 'authoritative_quote',
            quote_fingerprint: authoritativeQuote.quote_provenance
              && authoritativeQuote.quote_provenance.quote_fingerprint,
          }),
          bookingId,
          clientId,
        ],
      );
      if (Number(bookingUpd && bookingUpd.rowCount) !== 1) {
        const err = new Error('booking_total_update_mismatch');
        err.sunsetPriceFail = {
          ok: false,
          status: 422,
          body: {
            success: false,
            error: 'booking_total_update_mismatch',
            reason_code: 'booking_total_update_mismatch',
          },
        };
        throw err;
      }
      priced = {
        ok: true,
        total_cents: applied.total_cents,
        sunset_price_source: 'authoritative_quote',
      };
      if (Number(authoritativeQuote.total_cents) !== Number(applied.total_cents)) {
        const err = new Error('quote_total_mismatch');
        err.sunsetPriceFail = {
          ok: false,
          status: 422,
          body: {
            success: false,
            error: 'quote_total_mismatch',
            reason_code: 'quote_total_mismatch',
          },
        };
        throw err;
      }
    } else {
      // Price inside the same transaction. On failure ROLLBACK — no cancelled leftovers.
      const { priceSunsetBookingServices } = require('./sunset-stripe-payment-links');
      priced = await priceSunsetBookingServices(pg, clientSlug, bookingId);
      if (!priced || !priced.ok) {
        const { staffFacingSunsetAdminPriceError } = require('./sunset-admin-price-resolve');
        const faced = staffFacingSunsetAdminPriceError((priced && priced.error) || 'pricing_failed');
        const err = new Error(faced.error);
        err.sunsetPriceFail = {
          ok: false,
          status: 422,
          body: {
            success: false,
            error: faced.error,
            reason_code: faced.reason_code,
          },
        };
        throw err;
      }
    }

    await pg.query('COMMIT');
    return {
      ok: true,
      status: 201,
      body: {
        success: true,
        booking_code: bookingCode,
        booking_id: bookingId,
        total_cents: priced.total_cents,
        currency: 'EUR',
        sunset_price_source: priced.sunset_price_source || 'db',
        records: createdRows.map(scheduleRowFromDb),
        booking: scheduleRowFromDb(createdRows[0]),
        ...(assignedCourse ? {
          assigned_course: {
            course_id: assignedCourse.course_id,
            course_label: assignedCourse.course_label,
            capacity: assignedCourse.capacity,
            capacity_by_date: assignedCourse.capacity_by_date,
          },
        } : {}),
        ...(coursePricePreflight ? {
          price_preview_cents: coursePricePreflight.amount_cents,
          price_item_code: coursePricePreflight.item_code || null,
        } : {}),
      },
    };
  } catch (err) {
    await pg.query('ROLLBACK');
    if (err && err.sunsetPriceFail) return err.sunsetPriceFail;
    throw err;
  }
}

module.exports = {
  SUNSET_CLIENT_SLUG,
  METADATA_SOURCE_TAG,
  DB_SOURCE,
  LUNA_DB_SOURCE,
  LUNA_METADATA_SOURCE_TAG,
  isLunaTrustedActor,
  resolveScheduleBookingAttribution,
  DEFAULT_LESSON_CATEGORY,
  PRIVATE_LESSON_MAX_SESSIONS,
  UI_COMPONENT_KEYS,
  EXACT_COMPONENT_ALIASES,
  applyExactComponentAliases,
  normalizeComponents,
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
  buildRentalPricingDescriptor,
  resolveFullDayEquipmentAddonUnitCents,
  insertFullDayEquipmentAddonRows,
  validateScheduleBookingBody,
  bookingStatusFromPayment,
  componentList,
  insertServiceRecord,
  generateSunsetManualBookingCode,
  scheduleRowFromDb,
  createSunsetScheduleBooking,
  prepareCanonicalRentalsForCreate,
  applyAuthoritativeQuoteAmounts,
  findIdempotentBooking,
  buildScheduleBookingIntentFingerprint,
  evaluateIdempotentReplay,
  scheduleBookingIdempotencyAdvisoryKeys,
};
