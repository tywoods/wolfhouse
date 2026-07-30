'use strict';

/**
 * Sunset Schedule — manual booking writes (bookings + booking_service_records).
 * Supports component combos, courses, private lessons, and multi-date via one booking header + many service records.
 */

const crypto = require('crypto');
const { loadPrivateLessonFromDb, defaultPrivateLessonApi } = require('./sunset-admin-private-lesson-rules');
const { normalizeSunsetBookingDatesInBody } = require('./sunset-guest-date-intake');

// Resolve the per-person-per-day add-on unit price for Create/Edit snapshot.
// Live Admin DB-read mode: tenant+location tenant_price_rules row is sole owner
// (lookupSunsetFullDayEquipmentAddonAsync). Never hard-codes euros; never accepts
// client body amounts; never merges static baseline while DB-read is on (including
// null response / tables_missing — those fail closed). Returns integer cents or null.
// Requires deferred to avoid eager require cycles.
async function resolveFullDayEquipmentAddonUnitCents(pg, clientSlug, locationId, opts) {
  const { lookupSunsetFullDayEquipmentAddonAsync } = require('./sunset-rental-price-lookup');
  const lookup = await lookupSunsetFullDayEquipmentAddonAsync({
    client_slug: clientSlug,
    location_id: locationId,
    pgClient: pg,
    loadRule: opts && opts.loadRule,
  });
  if (!lookup || lookup.ok !== true) return null;
  const cents = Math.round(Number(lookup.amount_cents));
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

const SUNSET_CLIENT_SLUG = 'sunset';
const METADATA_SOURCE_TAG = 'staff_manual_schedule';
const DB_SOURCE = 'staff_manual';
const LUNA_DB_SOURCE = 'luna_guest';
const LUNA_METADATA_SOURCE_TAG = 'luna_guest_whatsapp';

/** Staff-authored commercial adjustment (not Admin catalog price). */
const STAFF_CUSTOM_LINE_SOURCE = 'staff_custom_line';
const STAFF_CUSTOM_LINE_COMPONENT = 'staff_custom_line';
const STAFF_CUSTOM_LINE_MAX = 20;
const STAFF_CUSTOM_LINE_LABEL_MAX = 120;
const STAFF_CUSTOM_LINE_ID_MAX = 64;
const STAFF_CUSTOM_LINE_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Staff-managed Accommodation commercial line (Sunset only; dedicated identity). */
const {
  STAFF_ACCOMMODATION_SOURCE,
  STAFF_ACCOMMODATION_COMPONENT,
  normalizeAccommodationSelection,
  accommodationForIntentFingerprint,
  isStaffAccommodationMeta,
  buildAccommodationQuoteLine,
  formatAccommodationBookingCard,
} = require('./sunset-accommodation-price-resolver');
/** No-lesson equipment present without valid booking surfer_count — fail closed. */
const NO_LESSON_EQUIPMENT_SURFER_REQUIRED = 'surfer_count_required_for_no_lesson_equipment';
/**
 * Trusted Luna no-lesson equipment signals disagree (board vs wetsuit qty, etc.).
 * Fail closed — never silently pick max/min (attacker-friendly).
 */
const NO_LESSON_EQUIPMENT_QTY_INCONSISTENT = 'inconsistent_equipment_quantities_for_no_lesson';

/**
 * Locale-safe money → integer cents. Accepts "12.50", "12,50", "1.234,56",
 * "-5", "0", "+0". Max 2 fraction digits. Rejects NaN/overflow/>2 decimals.
 * Normalizes -0 to 0.
 */
function parseLocaleMoneyToCents(raw) {
  if (raw == null) return { ok: false, error: 'amount_required' };
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, error: 'amount_nan' };
    if (!Number.isInteger(raw)) return { ok: false, error: 'amount_not_integer_cents' };
    if (Math.abs(raw) > Number.MAX_SAFE_INTEGER) return { ok: false, error: 'amount_overflow' };
    return { ok: true, amount_cents: raw === 0 || Object.is(raw, -0) ? 0 : raw };
  }
  let s = String(raw).trim();
  if (!s) return { ok: false, error: 'amount_required' };
  s = s.replace(/[€$£\u00a0\s]/g, '');
  let neg = false;
  if (s.charAt(0) === '-') { neg = true; s = s.slice(1); }
  else if (s.charAt(0) === '+') { s = s.slice(1); }
  if (!s) return { ok: false, error: 'amount_required' };
  // Last separator is decimal when both present; single comma with ≤2 trailing digits is decimal.
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let normalized = s;
  if (lastDot >= 0 && lastComma >= 0) {
    if (lastComma > lastDot) {
      // 1.234,56
      normalized = s.replace(/\./g, '').replace(',', '.');
    } else {
      // 1,234.56
      normalized = s.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    const frac = s.slice(lastComma + 1);
    if (/^\d{1,2}$/.test(frac) && s.indexOf(',') === lastComma) {
      normalized = s.replace(',', '.');
    } else {
      normalized = s.replace(/,/g, '');
    }
  }
  if (!/^\d+(\.\d+)?$/.test(normalized)) return { ok: false, error: 'amount_invalid' };
  const parts = normalized.split('.');
  if (parts[1] != null && parts[1].length > 2) return { ok: false, error: 'amount_too_many_decimals' };
  const whole = parts[0] || '0';
  const frac = ((parts[1] || '') + '00').slice(0, 2);
  // Build cents without floating point.
  let cents;
  try {
    const wholeN = BigInt(whole);
    const fracN = BigInt(frac);
    let total = wholeN * 100n + fracN;
    if (neg) total = -total;
    if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
      return { ok: false, error: 'amount_overflow' };
    }
    cents = Number(total);
  } catch (_) {
    return { ok: false, error: 'amount_invalid' };
  }
  if (!Number.isFinite(cents) || !Number.isInteger(cents)) return { ok: false, error: 'amount_nan' };
  if (cents === 0 || Object.is(cents, -0)) cents = 0;
  return { ok: true, amount_cents: cents };
}

/**
 * Normalize staff custom commercial adjustments.
 * Shape: [{ client_line_id, label, amount_cents }]. Not Admin catalog prices.
 * Negative = discount. Zero allowed. Aggregate bound enforced at quote (total ≥ 0).
 * amount_cents revalidated via parseLocaleMoneyToCents (integer or locale decimal string).
 */
function normalizeCustomLineItems(raw) {
  if (raw == null || raw === '') return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'custom_line_items must be an array' };
  if (raw.length > STAFF_CUSTOM_LINE_MAX) {
    return { ok: false, error: `custom_line_items max ${STAFF_CUSTOM_LINE_MAX}` };
  }
  const seen = new Set();
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const row = raw[i];
    if (!row || typeof row !== 'object') {
      return { ok: false, error: `custom_line_items[${i}] must be an object` };
    }
    const clientLineId = String(row.client_line_id != null ? row.client_line_id : '').trim();
    if (!clientLineId || clientLineId.length > STAFF_CUSTOM_LINE_ID_MAX || !STAFF_CUSTOM_LINE_ID_RE.test(clientLineId)) {
      return { ok: false, error: `custom_line_items[${i}].client_line_id invalid` };
    }
    if (seen.has(clientLineId)) {
      return { ok: false, error: `custom_line_items duplicate client_line_id: ${clientLineId}` };
    }
    seen.add(clientLineId);
    const label = String(row.label != null ? row.label : '').trim();
    if (!label) return { ok: false, error: `custom_line_items[${i}].label is required` };
    if (label.length > STAFF_CUSTOM_LINE_LABEL_MAX) {
      return { ok: false, error: `custom_line_items[${i}].label max ${STAFF_CUSTOM_LINE_LABEL_MAX} chars` };
    }
    const parsed = parseLocaleMoneyToCents(row.amount_cents);
    if (!parsed.ok) {
      return { ok: false, error: `custom_line_items[${i}].amount_cents ${parsed.error}` };
    }
    out.push({
      client_line_id: clientLineId,
      label,
      amount_cents: parsed.amount_cents,
    });
  }
  return { ok: true, value: out };
}

function customLinesForIntentFingerprint(lines) {
  return (Array.isArray(lines) ? lines : []).map((l) => ({
    client_line_id: String((l && l.client_line_id) || ''),
    label: String((l && l.label) || ''),
    amount_cents: Number(l && l.amount_cents),
  })).sort((a, b) => a.client_line_id.localeCompare(b.client_line_id));
}

function buildCustomLineQuoteLines(customLines, currency) {
  const cur = currency || 'EUR';
  return (customLines || []).map((line) => ({
    component: STAFF_CUSTOM_LINE_COMPONENT,
    offering_id: STAFF_CUSTOM_LINE_COMPONENT,
    offering_item_code: STAFF_CUSTOM_LINE_COMPONENT,
    client_line_id: line.client_line_id,
    label: line.label,
    quantity: 1,
    unit_amount_cents: line.amount_cents,
    total_cents: line.amount_cents,
    currency: cur,
    price_source: STAFF_CUSTOM_LINE_SOURCE,
    billing_unit: 'adjustment',
    billing_mode: 'staff_custom',
  }));
}

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
const COURSE_EQUIPMENT_KEY = 'course_equipment';
const {
  normalizeSelection,
  quoteCourseEquipment,
  quoteCourseEquipmentForLessonSet,
} = require('./sunset-course-equipment-pricing');
const { isPresentCourseEquipmentSelection } = require('./sunset-course-equipment-options');

function checkedMoneyInteger(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throwSunsetPriceFail(422, `${label || 'money'}_overflow`);
  return n;
}
function checkedMoneyAdd(a, b, label) {
  const sum = BigInt(checkedMoneyInteger(a, label)) + BigInt(checkedMoneyInteger(b, label));
  if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < BigInt(Number.MIN_SAFE_INTEGER)) {
    throwSunsetPriceFail(422, `${label || 'money'}_overflow`);
  }
  return Number(sum);
}
function checkedMoneySubtract(a, b, label) {
  return checkedMoneyAdd(a, -checkedMoneyInteger(b, label), label);
}
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

async function prepareGenericRentalsForCreate(opts) {
  const { listRentalOfferings, applyRentalMutualExclusion } = require('./tenant-rental-offerings');
  const {
    resolveGenericRentalPrice,
    buildGenericRentalServiceRecord,
    resolveDayRentalContinuation,
    isHourRentalDurationKey,
    dayCountFromDurationKey,
  } = require('./tenant-rental-price-resolver');
  const { isGenericRentalCreateEnabled } = require('./tenant-business-config');
  const o = opts || {};
  const rows = Array.isArray(o.rentals) ? o.rentals : [];
  const generic = rows.filter((r) => !CANONICAL_RENTAL_OFFERING_KEYS.includes(String(r && r.offering_key || '').trim()));
  if (!generic.length) return { ok: true, records: [], genericRentals: [] };
  if (!isGenericRentalCreateEnabled()) {
    return { ok: false, reason: 'invalid_rental_offering' };
  }
  const seenGenericIdentities = new Set();
  for (const row of generic) {
    const identity = `${String(row && row.offering_key || '').trim()}::${String(row && row.duration_key || '').trim()}`;
    if (seenGenericIdentities.has(identity)) return { ok: false, reason: 'duplicate_rental_offering' };
    seenGenericIdentities.add(identity);
  }
  for (const row of generic) for (const key of CLIENT_RENTAL_MONEY_FIELDS) {
    if (row && row[key] !== undefined && row[key] !== null && row[key] !== '') return { ok: false, reason: 'client_money_rejected' };
  }
  let catalog;
  try {
    catalog = await (o.listOfferings || listRentalOfferings)(o.pgClient, { clientSlug: o.clientSlug, locationId: o.locationId, includeInactive: false });
  } catch (_) { return { ok: false, reason: 'rental_catalog_unavailable' }; }
  const active = new Map((catalog || []).filter((x) => x && x.active !== false).map((x) => [x.offering_key, x]));
  for (const row of generic) if (!active.has(String(row.offering_key || '').trim())) return { ok: false, reason: 'rental_offering_not_active' };
  const exclusion = applyRentalMutualExclusion(rows.map((r) => r.offering_key), catalog || []);
  if (exclusion.blocked.length) return { ok: false, reason: 'rental_catalog_conflict' };
  const records = [];
  for (const row of generic) {
    const qty = Number(row.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      return { ok: false, reason: 'invalid_rental_quantity' };
    }
    const commonPriceOpts = {
      clientSlug: o.clientSlug,
      locationId: o.locationId,
      offeringKey: row.offering_key,
      quantity: qty,
      pgClient: o.pgClient,
      loadRule: o.loadRule,
    };
    const dayCount = Number(o.calendarDayCount);
    const bookingDurationKey = String(o.bookingDurationKey || '').trim();
    const selectedDuration = String(row.duration_key || '').trim();
    const isHourDuration = isHourRentalDurationKey(selectedDuration);
    let priced;
    if (Number.isInteger(dayCount) && dayCount > 1) {
      // Multi-day commercial rule (server-authoritative, fail-closed):
      //  - hour packages never on multi-day ranges
      //  - exact active N_days package wins
      //  - else longest configured day tier M <= N continues discounted per-day
      //    rate across all N requested days (generic arbitrary N, not 1_day-only)
      //  - stale/malicious 1_day is rejected when exact N_days exists
      if (isHourDuration) {
        return { ok: false, reason: 'rental_duration_not_compatible' };
      }
      const exactKey = bookingDurationKey || (dayCount === 1 ? '1_day' : `${dayCount}_days`);

      // Probe exact first — infrastructure errors fail closed (never invent money).
      const exactProbe = await resolveGenericRentalPrice({ ...commonPriceOpts, durationKey: exactKey });
      if (exactProbe.ok) {
        // Exact package is the only legal price identity when present.
        if (selectedDuration !== exactKey) {
          return { ok: false, reason: 'rental_duration_not_compatible' };
        }
        priced = {
          ...exactProbe,
          pricing_mode: 'exact_duration_package',
          package_repeat_count: 1,
          selected_duration_key: selectedDuration,
        };
      } else {
        const exactAbsent = exactProbe.reason === 'price_not_found'
          && exactProbe.status === 'not_found';
        if (!exactAbsent) {
          return exactProbe;
        }
        // Exact absent: resolve continuation from active day tiers.
        // Selected duration must parse as a legitimate data-driven day identity
        // (1_day / full_day / N_days via duration model — no fixed 1..7 whitelist)
        // and be compatible with the booking span (day count ≤ requested N).
        // Reject banana / unparseable / hour / contradictory longer-than-span keys.
        const selectedDayCount = dayCountFromDurationKey(selectedDuration);
        const selectedOk = selectedDayCount != null
          && Number.isInteger(selectedDayCount)
          && selectedDayCount >= 1
          && selectedDayCount <= dayCount;
        if (!selectedOk) {
          return { ok: false, reason: 'rental_duration_not_compatible' };
        }

        let tiers = [];
        if (typeof o.listDayTiers === 'function') {
          try {
            const listed = await o.listDayTiers({
              clientSlug: o.clientSlug,
              locationId: o.locationId,
              offeringKey: row.offering_key,
              pgClient: o.pgClient,
            });
            if (Array.isArray(listed)) {
              tiers = listed.map((t) => ({
                days: Number(t.days),
                amount_cents: Math.round(Number(t.amount_cents)),
                duration_key: String(t.duration_key || '').trim() || null,
              })).filter((t) => Number.isInteger(t.days) && t.days >= 1 && Number.isFinite(t.amount_cents) && t.amount_cents >= 0);
            }
          } catch (_listErr) {
            return { ok: false, reason: 'rental_catalog_unavailable' };
          }
        }
        if (!tiers.length) {
          // Probe longest → shortest day packages (1..dayCount). Stop early once
          // we have at least one tier so continuation can resolve; continue
          // probing only while seeking a longer base is unnecessary after first
          // hit from the top, but we still need all tiers for exact base pick.
          // Walk high→low so a single longer tier is found without full scan when
          // only 1_day exists after exact miss (common path).
          for (let d = dayCount; d >= 1; d -= 1) {
            const dk = d === 1 ? '1_day' : `${d}_days`;
            // eslint-disable-next-line no-await-in-loop
            const probe = await resolveGenericRentalPrice({
              ...commonPriceOpts,
              durationKey: dk,
              quantity: 1,
            });
            if (probe.ok) {
              tiers.push({ days: d, amount_cents: probe.unit_cents, duration_key: dk });
              // Longest eligible found — sufficient for continuation.
              break;
            }
            // Fail closed on every non-absence result (scope mismatch, unverified,
            // infrastructure, malformed found rows, lookup throw, …). Only true
            // absence may continue probing a shorter day tier.
            const trueAbsent = probe.reason === 'price_not_found'
              && probe.status === 'not_found';
            if (!trueAbsent) {
              return probe;
            }
          }
        }
        const cont = resolveDayRentalContinuation({
          requestedDays: dayCount,
          tiers,
          quantity: qty,
        });
        if (!cont.ok) {
          return { ok: false, reason: 'rental_duration_not_compatible' };
        }
        const baseKey = cont.base_duration_key;
        const baseTier = tiers.find((t) => t.days === cont.base_days) || tiers[0];
        // 1-day base keeps legacy repeated_base_package metadata (unit = 1-day rate).
        // Longer base tiers use continued_day_discount with unit = one item over N days.
        if (cont.base_days === 1) {
          const dayUnit = Math.round(Number(baseTier.amount_cents));
          priced = {
            ok: true,
            client_slug: o.clientSlug,
            location_id: o.locationId,
            offering_key: String(row.offering_key || '').trim(),
            duration_key: baseKey,
            item_code: `${String(row.offering_key || '').trim()}__${baseKey}`,
            unit: 'day',
            unit_cents: dayUnit,
            quantity: qty,
            amount_cents: dayUnit * qty * dayCount,
            currency: 'EUR',
            pricing_mode: 'repeated_base_package',
            package_repeat_count: dayCount,
            booking_duration_key: exactKey,
            selected_duration_key: selectedDuration,
          };
        } else {
          priced = {
            ok: true,
            client_slug: o.clientSlug,
            location_id: o.locationId,
            offering_key: String(row.offering_key || '').trim(),
            duration_key: baseKey,
            item_code: `${String(row.offering_key || '').trim()}__${baseKey}`,
            unit: 'day',
            unit_cents: cont.unit_cents,
            quantity: qty,
            amount_cents: cont.amount_cents,
            currency: 'EUR',
            pricing_mode: cont.pricing_mode,
            package_repeat_count: cont.package_repeat_count,
            booking_duration_key: exactKey,
            selected_duration_key: selectedDuration,
          };
        }
      }
    } else {
      // Single-day / hour packages: exact configured duration only (no stacking).
      priced = await resolveGenericRentalPrice({ ...commonPriceOpts, durationKey: selectedDuration });
      if (priced.ok) priced = { ...priced, pricing_mode: 'base_package', package_repeat_count: 1 };
    }
    if (!priced.ok) return priced;
    const catalogOffering = active.get(String(row.offering_key || '').trim());
    priced = { ...priced, offering_label: catalogOffering && catalogOffering.label ? String(catalogOffering.label) : null };
    const mapped = buildGenericRentalServiceRecord(priced, { serviceDate: o.serviceDate, source: o.source });
    if (!mapped.ok) return mapped;
    records.push(mapped.record);
  }
  return { ok: true, records, genericRentals: generic.map((r) => ({ offering_key: r.offering_key, duration_key: r.duration_key, quantity: r.quantity })) };
}

// Build server-owned quote lines directly from records already priced by the
// exact tenant_price_rules resolver; generic keys must not re-enter the closed
// canonical quote parser.
function buildGenericRentalAuthoritativeQuote(records) {
  const lineItems = (Array.isArray(records) ? records : []).map((record) => {
    const meta = rowMetadata(record);
    const total = checkedMoneyInteger(record.amount_due_cents, 'generic_rental_total');
    const quantity = checkedMoneyInteger(record.quantity, 'generic_rental_quantity');
    const offeringKey = String(meta.offering_key || '').trim();
    const itemCode = String(meta.item_code || '').trim();
    if (!offeringKey || !itemCode || quantity < 1 || total < 0) throw new Error('invalid_generic_rental_quote_record');
    return {
      component: 'addon_service', generic_rental: true,
      offering_id: offeringKey, offering_item_code: itemCode,
      duration_key: meta.duration_key, quantity,
      unit_amount_cents: checkedMoneyInteger(meta.unit_cents, 'generic_rental_unit'),
      package_repeat_count: Number(meta.package_repeat_count || 1),
      pricing_mode: meta.pricing_mode || 'base_package',
      total_cents: total, price_source: 'tenant_price_rules',
    };
  });
  const totalCents = lineItems.reduce((sum, line) => checkedMoneyAdd(sum, line.total_cents, 'generic_rental_quote_total'), 0);
  return { total_cents: totalCents, currency: 'EUR', line_items: lineItems };
}

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
function prepareCanonicalRentalsForCreate(body, opts) {
  opts = opts || {};
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

  let bodyOut = {
    ...b,
    components,
    service_dates: rangeDates,
    date_from: dateFrom,
    date_to: dateTo,
  };
  let rentalsOut = rentals;
  // No-lesson: equipment qty is independent; surfer_count still required (guest field).
  // Trusted Luna may derive surfer_count from consistent component quantities (opts.actor).
  const forced = applyNoLessonEquipmentQtyFromSurfers(bodyOut, rentals, opts);
  if (!forced.ok) {
    return {
      ok: false,
      error: forced.error || NO_LESSON_EQUIPMENT_SURFER_REQUIRED,
      reason: forced.reason || forced.reason_code || NO_LESSON_EQUIPMENT_SURFER_REQUIRED,
    };
  }
  // Always apply validated body/rentals (qty clamp + optional Luna-derived surfer_count).
  bodyOut = forced.body || bodyOut;
  rentalsOut = forced.rentals || rentalsOut;
  // Re-sync legacy component quantities from independent rental rows.
  if (Array.isArray(rentalsOut)) {
    for (const row of rentalsOut) {
      if (row.offering_key === 'board_rental') {
        bodyOut.components.surfboard = { quantity: row.quantity };
      } else if (row.offering_key === 'wetsuit_rental') {
        bodyOut.components.wetsuit = { quantity: row.quantity };
      } else if (row.offering_key === 'board_and_suit_rental') {
        bodyOut.components.surfboard = { quantity: row.quantity };
        bodyOut.components.wetsuit = { quantity: row.quantity };
      }
    }
  }

  return {
    ok: true,
    present: true,
    rentals: rentalsOut,
    rentalSpanDates: rangeDates,
    pricingGroupId: crypto.randomBytes(8).toString('hex'),
    body: bodyOut,
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

/**
 * Compound identity for bare board/wetsuit rental quote lines.
 * Rejects bundle halves, opposite-side gear, and corrupt/contradictory offering_key.
 * board_rental / wetsuit_rental lines require that offering_key; legacy
 * surfboard / wetsuit lines accept the matching bare offering_key or absent
 * (pre-canonical rows). Never soft-matches through a partial OR.
 */
function rentalRowMatchesBareRentalLine(row, line, spec) {
  const component = String((line && line.component) || '').trim();
  if (component !== spec.canonicalComponent && component !== spec.legacyComponent) {
    return false;
  }
  const meta = rowMetadata(row);
  const serviceType = String(row.service_type || '').trim();
  const offeringKey = String(meta.offering_key || '').trim();
  const metaComponent = String(meta.component || '').trim();
  const bundlePart = String(meta.bundle_part || '').trim();

  // Bundle halves are owned exclusively by board_and_suit_rental lines.
  if (offeringKey === 'board_and_suit_rental' || bundlePart) return false;

  // Explicit opposite-side / contradictory identity rejects (no soft OR rescue).
  if (offeringKey && offeringKey !== spec.bareOfferingKey) return false;
  if (metaComponent && metaComponent !== spec.metaComponent) return false;
  if (serviceType && serviceType !== spec.serviceType) return false;

  const sideOk = serviceType === spec.serviceType || metaComponent === spec.metaComponent;
  if (!sideOk) return false;

  // Canonical rentals[] quote line — require explicit bare offering_key.
  if (component === spec.canonicalComponent) {
    return offeringKey === spec.bareOfferingKey;
  }
  // Legacy components quote line (surfboard / wetsuit).
  return !offeringKey || offeringKey === spec.bareOfferingKey;
}

function rowMatchesQuoteLine(row, line) {
  const component = String((line && line.component) || '').trim();
  const meta = rowMetadata(row);
  const serviceType = String(row.service_type || '').trim();
  if (line && line.generic_rental === true) {
    const offeringKey = String(line.offering_id || '').trim();
    const itemCode = String(line.offering_item_code || line.item_code || '').trim();
    return serviceType === 'addon_service'
      && meta.rental_offering === true
      && !!offeringKey && String(meta.offering_key || '').trim() === offeringKey
      && !!itemCode && String(meta.item_code || '').trim() === itemCode;
  }
  // Course-equipment lines own exactly one independent offering_key row.
  // Never claim legacy rentals, included-course gear, or other equipment keys.
  if (line && line.course_equipment === true) {
    const lineKey = String(line.offering_key || (line.metadata && line.metadata.offering_key) || '').trim();
    const rowKey = String(meta.offering_key || '').trim();
    if (!lineKey || !rowKey || lineKey !== rowKey) return false;
    return meta.course_equipment === true
      && meta.course_equipment_mode === line.course_equipment_mode;
  }
  if (component === 'course') {
    // Course lines own course-component rows only. DB type is surf_lesson for
    // course/private/lesson alike — never claim by service_type alone (would
    // swallow bare lesson / private rows and green-path "unclaimed fails closed").
    if (!(meta.component === 'course' || serviceType === 'course')) {
      return false;
    }
    // Per-lesson quote lines carry identity — claim exact physical lesson rows only.
    const lineCourseId = String((line && line.course_id) || '').trim();
    const rowCourseId = String(meta.course_id || row.course_id || '').trim();
    if (lineCourseId && rowCourseId && lineCourseId !== rowCourseId) return false;

    const lineIdentity = String((line && line.lesson_identity) || '').trim();
    const rowIdentity = String(meta.lesson_identity || '').trim();
    if (lineIdentity && rowIdentity) return lineIdentity === rowIdentity;
    if (lineIdentity && !rowIdentity) return false;

    const lineSk = String((line && line.schedule_key) || '').trim();
    const rowSk = String(meta.schedule_key || '').trim();
    if (lineSk || rowSk) {
      if (lineSk !== rowSk) return false;
    }

    const lineDates = Array.isArray(line && line.service_dates)
      ? line.service_dates.map((d) => String(d || '').slice(0, 10)).filter(Boolean)
      : [];
    if (lineDates.length === 1) {
      const rowDate = String(row.service_date || meta.service_date || '').slice(0, 10);
      if (rowDate && rowDate !== lineDates[0]) return false;
    }
    return true;
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
  // Canonical rentals[] emit board_rental / wetsuit_rental; legacy components
  // quote path still labels lines as surfboard / wetsuit. Compound identity only
  // — never OR-match a half-identity (would claim bundle halves / wrong side /
  // corrupt offering_key, and let one row satisfy dual lines).
  if (component === 'board_rental' || component === 'surfboard') {
    return rentalRowMatchesBareRentalLine(row, line, {
      canonicalComponent: 'board_rental',
      legacyComponent: 'surfboard',
      bareOfferingKey: 'board_rental',
      serviceType: 'surfboard',
      metaComponent: 'surfboard',
    });
  }
  if (component === 'wetsuit_rental' || component === 'wetsuit') {
    return rentalRowMatchesBareRentalLine(row, line, {
      canonicalComponent: 'wetsuit_rental',
      legacyComponent: 'wetsuit',
      bareOfferingKey: 'wetsuit_rental',
      serviceType: 'wetsuit',
      metaComponent: 'wetsuit',
    });
  }
  if (component === FULL_DAY_EQUIPMENT_ADDON_KEY || component === 'addon_service') {
    // Do not claim staff_custom_line or accommodation rows as Admin full-day/addon lines.
    if (meta.component === STAFF_CUSTOM_LINE_COMPONENT
      || meta.source === STAFF_CUSTOM_LINE_SOURCE
      || meta.staff_custom_line === true) {
      return false;
    }
    if (isStaffAccommodationMeta(meta)) return false;
    // Course-owned multi-item equipment also persists as addon_service rows.
    // Full-day/addon quote lines must never claim them (duplicate_row_claim / misprice).
    if (meta.course_equipment === true) return false;
    return meta.component === FULL_DAY_EQUIPMENT_ADDON_KEY
      || serviceType === 'addon_service'
      || meta.service_key === FULL_DAY_EQUIPMENT_ADDON_KEY;
  }
  if (component === STAFF_CUSTOM_LINE_COMPONENT) {
    const lineId = String((line && line.client_line_id) || '').trim();
    const rowId = String(meta.client_line_id || '').trim();
    return (meta.component === STAFF_CUSTOM_LINE_COMPONENT
      || meta.source === STAFF_CUSTOM_LINE_SOURCE
      || meta.staff_custom_line === true)
      && !!lineId && lineId === rowId;
  }
  if (component === STAFF_ACCOMMODATION_COMPONENT) {
    if (!isStaffAccommodationMeta(meta)) return false;
    // Multi-stay: match by client_stay_id when both sides carry it; else by
    // half-open check_in/check_out identity so each stay row claims exactly one line.
    const lineStayId = String((line && line.client_stay_id) || '').trim();
    const rowStayId = String(meta.client_stay_id || '').trim();
    if (lineStayId && rowStayId) return lineStayId === rowStayId;
    const lineIn = String((line && line.check_in) || '').slice(0, 10);
    const lineOut = String((line && line.check_out) || '').slice(0, 10);
    const rowIn = String(meta.check_in || '').slice(0, 10);
    const rowOut = String(meta.check_out || '').slice(0, 10);
    if (lineIn && lineOut && rowIn && rowOut) {
      return lineIn === rowIn && lineOut === rowOut;
    }
    // Legacy single-stay rows without dates on the quote line: allow only when
    // both lack date identity (ambiguous multi would fail closed above).
    if (!lineIn && !lineOut && !rowIn && !rowOut) return true;
    return false;
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
  if (!Number.isFinite(quoteTotal) || !Number.isInteger(quoteTotal) || quoteTotal < 0) {
    return { ok: false, error: 'invalid_quote_total' };
  }
  let lineTotalSum = 0;
  try {
    for (const line of lines) lineTotalSum = checkedMoneyAdd(lineTotalSum, line && line.total_cents, 'quote_line_total');
  } catch (_) { return { ok: false, error: 'quote_line_total_overflow' }; }
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
    const isCustom = String((line && line.component) || '') === STAFF_CUSTOM_LINE_COMPONENT
      || String((line && line.price_source) || '') === STAFF_CUSTOM_LINE_SOURCE;
    const isAccommodation = String((line && line.component) || '') === STAFF_ACCOMMODATION_COMPONENT
      || String((line && line.price_source) || '') === STAFF_ACCOMMODATION_SOURCE
      || !!(line && line.staff_accommodation === true);
    // Custom lines may be negative (discount) or zero; Admin lines stay non-negative.
    if (!Number.isFinite(lineTotal) || !Number.isInteger(lineTotal)) {
      return { ok: false, error: 'invalid_quote_line_total' };
    }
    if (!isCustom && lineTotal < 0) {
      return { ok: false, error: 'invalid_quote_line_total' };
    }
    try { appliedLineTotal = checkedMoneyAdd(appliedLineTotal, lineTotal, 'applied_line_total'); }
    catch (_) { return { ok: false, error: 'applied_line_total_overflow' }; }

    // Course equipment: one auditable row per unique course date. Split the
    // aggregate quote line evenly as unit × quantity per date row (never dump
    // the full multi-date total onto the first row).
    if (line && line.course_equipment === true) {
      const unit = Number(line.unit_amount_cents != null ? line.unit_amount_cents : line.amount_cents);
      const qty = Number(line.quantity);
      if (!Number.isSafeInteger(unit) || unit < 0 || !Number.isSafeInteger(qty) || qty < 1) {
        return { ok: false, error: 'invalid_course_equipment_line' };
      }
      const perDate = unit * qty;
      if (!Number.isSafeInteger(perDate) || perDate < 0) {
        return { ok: false, error: 'invalid_course_equipment_line' };
      }
      if (perDate * matches.length !== lineTotal) {
        return { ok: false, error: 'course_equipment_date_split_mismatch' };
      }
      for (const row of matches) {
        const id = String(row.service_record_id || row.id || '');
        const upd = await pg.query(
          // MULTICLIENT_SCOPE_OK: same-txn service row; client_slug predicate defense-in-depth
          'UPDATE booking_service_records SET amount_due_cents = $1 WHERE id = $2::uuid AND client_slug = $3',
          [perDate, id, clientSlug],
        );
        if (Number(upd && upd.rowCount) !== 1) {
          return { ok: false, error: 'service_amount_update_mismatch' };
        }
        try { persistedAmountSum = checkedMoneyAdd(persistedAmountSum, perDate, 'persisted_amount_sum'); }
        catch (_) { return { ok: false, error: 'persisted_amount_sum_overflow' }; }
      }
      continue;
    }

    // Private multi-session: one auditable row per session. Aggregate quote line
    // is unit × surfers × sessions — split evenly so every session carries its
    // authoritative amount (never dump full total onto the first row / zero peers).
    // Dedupe does not apply to lesson price (same calendar day still bills each session).
    if (String((line && line.component) || '') === 'private_lesson' && matches.length > 1) {
      const unit = Number(line.unit_amount_cents != null ? line.unit_amount_cents : line.amount_cents);
      const qty = Number(line.quantity); // surfer_count on private quote lines
      let perSession = null;
      if (Number.isSafeInteger(unit) && unit >= 0 && Number.isSafeInteger(qty) && qty >= 1
        && Number.isSafeInteger(unit * qty)
        && unit * qty * matches.length === lineTotal) {
        perSession = unit * qty;
      } else if (Number.isSafeInteger(lineTotal) && matches.length > 0
        && lineTotal % matches.length === 0) {
        perSession = lineTotal / matches.length;
      }
      if (perSession == null || !Number.isSafeInteger(perSession) || perSession < 0) {
        return { ok: false, error: 'private_lesson_session_split_mismatch' };
      }
      for (const row of matches) {
        const id = String(row.service_record_id || row.id || '');
        const upd = await pg.query(
          // MULTICLIENT_SCOPE_OK: same-txn service row; client_slug predicate defense-in-depth
          'UPDATE booking_service_records SET amount_due_cents = $1 WHERE id = $2::uuid AND client_slug = $3',
          [perSession, id, clientSlug],
        );
        if (Number(upd && upd.rowCount) !== 1) {
          return { ok: false, error: 'service_amount_update_mismatch' };
        }
        try { persistedAmountSum = checkedMoneyAdd(persistedAmountSum, perSession, 'persisted_amount_sum'); }
        catch (_) { return { ok: false, error: 'persisted_amount_sum_overflow' }; }
      }
      continue;
    }

    for (let i = 0; i < matches.length; i += 1) {
      const row = matches[i];
      const id = String(row.service_record_id || row.id || '');
      // Primary row carries the line total; remaining bundle/span constituents are explicit zeros.
      // amount_due_cents CHECK is >= 0 — store non-negative; signed amount lives in metadata for custom discounts.
      const signedDue = i === 0 ? lineTotal : 0;
      const due = signedDue < 0 ? 0 : signedDue;
      if (isCustom && i === 0) {
        const meta = rowMetadata(row);
        const nextMeta = {
          ...meta,
          source: STAFF_CUSTOM_LINE_SOURCE,
          staff_custom_line: true,
          component: STAFF_CUSTOM_LINE_COMPONENT,
          client_line_id: line.client_line_id || meta.client_line_id,
          label: line.label || meta.label,
          amount_cents: signedDue,
        };
        const metaUpd = await pg.query(
          // MULTICLIENT_SCOPE_OK: same-txn service row
          `UPDATE booking_service_records
              SET amount_due_cents = $1,
                  metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
            WHERE id = $3::uuid AND client_slug = $4`,
          [due, JSON.stringify(nextMeta), id, clientSlug],
        );
        if (Number(metaUpd && metaUpd.rowCount) !== 1) {
          return { ok: false, error: 'service_amount_update_mismatch' };
        }
        try { persistedAmountSum = checkedMoneyAdd(persistedAmountSum, signedDue, 'persisted_amount_sum'); }
        catch (_) { return { ok: false, error: 'persisted_amount_sum_overflow' }; }
        continue;
      }
      if (isAccommodation && i === 0) {
        const meta = rowMetadata(row);
        const nextMeta = {
          ...meta,
          source: STAFF_ACCOMMODATION_SOURCE,
          staff_accommodation: true,
          component: STAFF_ACCOMMODATION_COMPONENT,
          client_stay_id: line.client_stay_id || meta.client_stay_id || null,
          check_in: line.check_in || meta.check_in,
          check_out: line.check_out || meta.check_out,
          nights: line.nights != null ? line.nights : meta.nights,
          season_groups: line.season_groups || meta.season_groups || [],
          nightly_breakdown: line.nightly_breakdown || meta.nightly_breakdown || [],
          total_cents: signedDue,
          amount_cents: signedDue,
          currency: line.currency || meta.currency || 'EUR',
        };
        const metaUpd = await pg.query(
          // MULTICLIENT_SCOPE_OK: same-txn service row
          `UPDATE booking_service_records
              SET amount_due_cents = $1,
                  metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
            WHERE id = $3::uuid AND client_slug = $4`,
          [due, JSON.stringify(nextMeta), id, clientSlug],
        );
        if (Number(metaUpd && metaUpd.rowCount) !== 1) {
          return { ok: false, error: 'service_amount_update_mismatch' };
        }
        try { persistedAmountSum = checkedMoneyAdd(persistedAmountSum, signedDue, 'persisted_amount_sum'); }
        catch (_) { return { ok: false, error: 'persisted_amount_sum_overflow' }; }
        continue;
      }
      const upd = await pg.query(
        // MULTICLIENT_SCOPE_OK: same-txn service row; client_slug predicate defense-in-depth
        'UPDATE booking_service_records SET amount_due_cents = $1 WHERE id = $2::uuid AND client_slug = $3',
        [due, id, clientSlug],
      );
      if (Number(upd && upd.rowCount) !== 1) {
        return { ok: false, error: 'service_amount_update_mismatch' };
      }
      try { persistedAmountSum = checkedMoneyAdd(persistedAmountSum, signedDue, 'persisted_amount_sum'); }
      catch (_) { return { ok: false, error: 'persisted_amount_sum_overflow' }; }
    }
  }

  if (appliedLineTotal !== quoteTotal) {
    return { ok: false, error: 'applied_line_total_mismatch' };
  }
  if (persistedAmountSum !== quoteTotal) {
    return { ok: false, error: 'persisted_amount_sum_mismatch' };
  }
  if (quoteTotal < 0) {
    return { ok: false, error: 'booking_total_negative' };
  }
  if (quoteTotal <= 0) {
    return { ok: false, error: 'booking_total_zero' };
  }
  return { ok: true, total_cents: appliedLineTotal, applied_line_total_cents: appliedLineTotal };
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

function normalizeComponents(body, allowEmpty) {
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
        const { sanitizeCourseLabelForStorage } = require('./sunset-course-display-label');
        const { PACK_TIER_KEYS_READABLE, packPriceItemCode } = require('./sunset-admin-pack-rules');

        function normalizeOneCourseIdentity(raw, idxPath) {
          const courseId = String((raw && raw.course_id) || '').trim();
          if (!courseId) {
            return { ok: false, error: `${idxPath}.course_id is required` };
          }
          const row = {
            course_id: courseId,
            course_label: sanitizeCourseLabelForStorage(
              courseId,
              (raw && (raw.course_label || raw.label)) || '',
            ),
          };
          let tierKey = '';
          if (raw && raw.tier && raw.tier.key != null) tierKey = String(raw.tier.key).trim();
          else if (raw && raw.tier_key != null) tierKey = String(raw.tier_key).trim();
          else if (raw && raw.duration_key != null) tierKey = String(raw.duration_key).trim();
          const offeringIdRaw = String((raw && raw.offering_id) || '').trim();
          if (!tierKey && /^surf_pack_.+__.+$/i.test(offeringIdRaw)) {
            tierKey = offeringIdRaw.split('__').pop() || '';
          }
          if (tierKey && !PACK_TIER_KEYS_READABLE.has(tierKey)) {
            return { ok: false, error: `${idxPath}.tier_key invalid: ${tierKey}` };
          }
          if (!tierKey) {
            return { ok: false, error: `${idxPath}.tier_key is required` };
          }
          row.tier_key = tierKey;
          row.offering_id = packPriceItemCode(courseId, tierKey);
          return { ok: true, value: row };
        }

        // Multi product buttons: selected_courses carries exact course IDs + tier identities.
        const selectedRaw = Array.isArray(part.selected_courses) ? part.selected_courses : null;
        if (selectedRaw && selectedRaw.length) {
          const selected = [];
          const seen = new Set();
          for (let si = 0; si < selectedRaw.length; si += 1) {
            const rawSc = selectedRaw[si];
            // Reject client money on wire rows before identity normalize strips keys.
            if (rawSc && typeof rawSc === 'object') {
              for (const mk of Object.keys(rawSc)) {
                if (MODEL_MONEY_FIELDS.has(String(mk).toLowerCase())) {
                  return {
                    ok: false,
                    error: `components.course.selected_courses[${si}].${mk} must not be supplied by the client`,
                  };
                }
              }
            }
            const one = normalizeOneCourseIdentity(
              rawSc,
              `components.course.selected_courses[${si}]`,
            );
            if (!one.ok) return one;
            if (seen.has(one.value.course_id)) {
              return {
                ok: false,
                error: `components.course.selected_courses duplicate course_id: ${one.value.course_id}`,
              };
            }
            seen.add(one.value.course_id);
            selected.push(one.value);
          }
          if (!selected.length) {
            return { ok: false, error: 'components.course.selected_courses requires at least one course' };
          }
          // Primary mirrors first selected for single-course readers / legacy gates.
          entry.course_id = selected[0].course_id;
          entry.course_label = selected[0].course_label;
          entry.tier_key = selected[0].tier_key;
          entry.offering_id = selected[0].offering_id;
          entry.selected_courses = selected;
        } else {
          const one = normalizeOneCourseIdentity(part, 'components.course');
          if (!one.ok) return one;
          entry.course_id = one.value.course_id;
          entry.course_label = one.value.course_label;
          entry.tier_key = one.value.tier_key;
          entry.offering_id = one.value.offering_id;
          // Always expose normalized single-course list for downstream multi-aware owners.
          entry.selected_courses = [one.value];
        }
      }
      out[key] = entry;
    }
    if (componentsIn.private_lesson) {
      const pl = normalizePrivateLessonPart(componentsIn.private_lesson);
      if (!pl.ok) return pl;
      if (!pl.skip) out.private_lesson = pl.value;
    }
    if (!Object.keys(out).length && !allowEmpty) {
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

  // No components object: either legacy booking_type, or allowEmpty (e.g. accommodation-
  // only / generic-rental-only commercial content that does not use UI components).
  const booking_type = String(b.booking_type || '').trim();
  if (!LEGACY_UI_SERVICE_TYPES.has(booking_type)) {
    if (allowEmpty) return { ok: true, value: {} };
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
  // Group courses: hard max 14 inclusive days (8–14 priced from Admin 7_days).
  if (components && components.course && unique.length > 14) {
    return {
      ok: false,
      error: 'group course duration exceeds maximum 14 days',
      reason: 'course_duration_exceeds_max',
    };
  }
  for (const iso of unique) {
    if (!isIsoDate(iso)) return { ok: false, error: 'service_dates must be YYYY-MM-DD' };
  }
  return { ok: true, value: unique };
}

/**
 * Staff Create phone: nonblank, max 40, at least 6 digits (international ok).
 * Quote path never requires phone.
 */
function isValidStaffCreateGuestPhone(raw) {
  const phone = raw != null ? String(raw).trim().slice(0, 40) : '';
  if (!phone) return false;
  if (phone.length > 40) return false;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 6;
}

/**
 * No-lesson (rental-only) mode: equipment quantity is independent physical units.
 * When equipment is present, authoritative surfer_count is still required as the
 * guest-count field (ops/display) but does NOT overwrite rental quantities.
 * Absent/invalid surfer_count with equipment fails closed (staff). Group/Private
 * and no-lesson all keep per-item equipment qty. Does not invent Admin prices.
 */
function isNoLessonComponents(components) {
  const c = components && typeof components === 'object' ? components : {};
  return !c.course && !c.private_lesson && !c.lesson;
}

function hasNoLessonEquipment(components, rentals) {
  const c = components && typeof components === 'object' ? components : {};
  if (c.surfboard || c.wetsuit) return true;
  if (!Array.isArray(rentals)) return false;
  return rentals.some((r) => {
    const key = String((r && r.offering_key) || '').trim();
    return key === 'board_rental' || key === 'wetsuit_rental' || key === 'board_and_suit_rental';
  });
}

function parseAuthoritativeSurferCount(body) {
  const b = body && typeof body === 'object' ? body : {};
  const raw = b.surfer_count != null ? b.surfer_count
    : (b.guest_count != null ? b.guest_count : null);
  if (raw == null || raw === '') return null;
  const n = parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 1 || n > 99) return null;
  return n;
}

function parseEquipmentQuantitySignal(raw) {
  if (raw == null || raw === '') return null;
  const n = parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 1 || n > 99) return null;
  return n;
}

/**
 * Collect no-lesson equipment quantity signals from trusted Luna component /
 * rentals / rental_pricing shapes. Never invents a count — only reads present qty.
 */
function collectNoLessonEquipmentQuantitySignals(body, rentals) {
  const b = body && typeof body === 'object' ? body : {};
  const comps = b.components && typeof b.components === 'object' ? b.components : {};
  const signals = [];
  if (comps.surfboard && typeof comps.surfboard === 'object') {
    const q = parseEquipmentQuantitySignal(comps.surfboard.quantity);
    if (q != null) signals.push({ source: 'components.surfboard', quantity: q });
  }
  if (comps.wetsuit && typeof comps.wetsuit === 'object') {
    const q = parseEquipmentQuantitySignal(comps.wetsuit.quantity);
    if (q != null) signals.push({ source: 'components.wetsuit', quantity: q });
  }
  if (Array.isArray(rentals)) {
    for (const row of rentals) {
      const key = String((row && row.offering_key) || '').trim();
      if (key !== 'board_rental' && key !== 'wetsuit_rental' && key !== 'board_and_suit_rental') {
        continue;
      }
      const q = parseEquipmentQuantitySignal(row && row.quantity);
      if (q != null) signals.push({ source: `rentals.${key}`, quantity: q });
    }
  }
  const rp = b.rental_pricing && typeof b.rental_pricing === 'object' ? b.rental_pricing : null;
  if (rp) {
    const key = String(rp.offering_key || '').trim();
    if (key === 'board_rental' || key === 'wetsuit_rental' || key === 'board_and_suit_rental') {
      const q = parseEquipmentQuantitySignal(rp.quantity);
      if (q != null) signals.push({ source: 'rental_pricing', quantity: q });
    }
  }
  return signals;
}

/**
 * Derive ONE canonical surfer_count from trusted no-lesson equipment quantities.
 * All present signals must agree — inconsistent board vs wetsuit (or rentals)
 * fails closed. Never silently chooses max/min.
 *
 * Call only for isLunaTrustedActor after confirming no authoritative surfer_count.
 */
function deriveCanonicalNoLessonSurferCountFromEquipment(body, rentals) {
  const signals = collectNoLessonEquipmentQuantitySignals(body, rentals);
  if (!signals.length) {
    return {
      ok: false,
      error: NO_LESSON_EQUIPMENT_SURFER_REQUIRED,
      reason: NO_LESSON_EQUIPMENT_SURFER_REQUIRED,
      reason_code: NO_LESSON_EQUIPMENT_SURFER_REQUIRED,
    };
  }
  const first = signals[0].quantity;
  if (signals.some((s) => s.quantity !== first)) {
    return {
      ok: false,
      error: NO_LESSON_EQUIPMENT_QTY_INCONSISTENT,
      reason: NO_LESSON_EQUIPMENT_QTY_INCONSISTENT,
      reason_code: NO_LESSON_EQUIPMENT_QTY_INCONSISTENT,
      signals,
    };
  }
  return { ok: true, surfer_count: first, signals };
}

/**
 * Whether no-lesson equipment qty may be derived from component quantities
 * when surfer_count is absent. ONLY trusted Luna actors — never staff/manual.
 */
function resolveLunaTrustedNoLessonDerivation(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  if (o.lunaTrusted === true) return true;
  if (o.actor && isLunaTrustedActor(o.actor)) return true;
  return false;
}

/**
 * No-lesson equipment quantities are independent physical unit counts (1..99).
 * They are NOT forced from surfer/guest count.
 *
 * Still:
 *  - Staff/manual: when equipment is present, surfer_count remains required as
 *    the guest-count field (ops/display) — but never overwrites rental qty.
 *  - Trusted Luna only: when surfer_count is absent, derive guest count from
 *    consistent equipment signals (legacy plugin contract). Does not rewrite
 *    per-item rental quantities.
 *
 * @param {object} body
 * @param {array|null} rentals
 * @param {object} [opts] — { actor } or { lunaTrusted: true }
 */
function applyNoLessonEquipmentQtyFromSurfers(body, rentals, opts) {
  const b = body && typeof body === 'object' ? body : {};
  const comps = b.components && typeof b.components === 'object' ? b.components : {};
  if (!isNoLessonComponents(comps)) {
    return { ok: true, body: b, rentals: rentals || null, forced: false };
  }
  if (!hasNoLessonEquipment(comps, rentals)) {
    return { ok: true, body: b, rentals: rentals || null, forced: false };
  }

  // Validate independent equipment quantities (1..99) — never rewrite them.
  let nextRentals = rentals;
  if (Array.isArray(rentals) && rentals.length) {
    nextRentals = [];
    for (let i = 0; i < rentals.length; i += 1) {
      const row = rentals[i] || {};
      const key = String(row.offering_key || '').trim();
      const isEquip = key === 'board_rental' || key === 'wetsuit_rental'
        || key === 'board_and_suit_rental' || key;
      if (!isEquip) {
        nextRentals.push(row);
        continue;
      }
      const q = parseEquipmentQuantitySignal(row.quantity);
      if (q == null) {
        return {
          ok: false,
          forced: false,
          error: 'invalid_rental_quantity',
          reason: 'invalid_rental_quantity',
          reason_code: 'invalid_rental_quantity',
          body: b,
          rentals: rentals || null,
        };
      }
      nextRentals.push({ ...row, quantity: q });
    }
  }
  const nextComps = { ...comps };
  if (nextComps.surfboard) {
    const q = parseEquipmentQuantitySignal(nextComps.surfboard.quantity);
    if (q == null) {
      return {
        ok: false,
        forced: false,
        error: 'invalid_rental_quantity',
        reason: 'invalid_rental_quantity',
        reason_code: 'invalid_rental_quantity',
        body: b,
        rentals: nextRentals,
      };
    }
    nextComps.surfboard = { ...nextComps.surfboard, quantity: q };
  }
  if (nextComps.wetsuit) {
    const q = parseEquipmentQuantitySignal(nextComps.wetsuit.quantity);
    if (q == null) {
      return {
        ok: false,
        forced: false,
        error: 'invalid_rental_quantity',
        reason: 'invalid_rental_quantity',
        reason_code: 'invalid_rental_quantity',
        body: b,
        rentals: nextRentals,
      };
    }
    nextComps.wetsuit = { ...nextComps.wetsuit, quantity: q };
  }
  // Canonical rentals[] own equipment qty when present — re-sync legacy components
  // to match (never the reverse force from surfer_count).
  if (Array.isArray(nextRentals)) {
    for (const row of nextRentals) {
      const q = parseEquipmentQuantitySignal(row.quantity) || 1;
      if (row.offering_key === 'board_rental') {
        nextComps.surfboard = { ...(nextComps.surfboard || {}), quantity: q };
      } else if (row.offering_key === 'wetsuit_rental') {
        nextComps.wetsuit = { ...(nextComps.wetsuit || {}), quantity: q };
      } else if (row.offering_key === 'board_and_suit_rental') {
        nextComps.surfboard = { ...(nextComps.surfboard || {}), quantity: q };
        nextComps.wetsuit = { ...(nextComps.wetsuit || {}), quantity: q };
      }
    }
  }

  let sn = parseAuthoritativeSurferCount(b);
  let derivedFromEquipment = false;
  if (sn == null && resolveLunaTrustedNoLessonDerivation(opts)) {
    const derived = deriveCanonicalNoLessonSurferCountFromEquipment(b, nextRentals);
    if (!derived.ok) {
      return {
        ok: false,
        forced: false,
        error: derived.error || NO_LESSON_EQUIPMENT_SURFER_REQUIRED,
        reason: derived.reason || derived.reason_code || derived.error || NO_LESSON_EQUIPMENT_SURFER_REQUIRED,
        reason_code: derived.reason_code || derived.reason || derived.error || NO_LESSON_EQUIPMENT_SURFER_REQUIRED,
        body: b,
        rentals: nextRentals || null,
      };
    }
    sn = derived.surfer_count;
    derivedFromEquipment = true;
  }
  if (sn == null) {
    return {
      ok: false,
      forced: false,
      error: NO_LESSON_EQUIPMENT_SURFER_REQUIRED,
      reason: NO_LESSON_EQUIPMENT_SURFER_REQUIRED,
      reason_code: NO_LESSON_EQUIPMENT_SURFER_REQUIRED,
      body: b,
      rentals: nextRentals || null,
    };
  }

  return {
    ok: true,
    // forced=true only when Luna-derived surfer_count was applied (guest field).
    // Equipment quantities are never rewritten from guest/surfer count.
    forced: derivedFromEquipment,
    surfer_count: sn,
    derived_from_equipment: derivedFromEquipment,
    rentals: nextRentals,
    body: {
      ...b,
      surfer_count: sn,
      components: nextComps,
    },
  };
}

function validateScheduleBookingBody(body, opts) {
  opts = opts || {};
  const dateBoundary = normalizeSunsetBookingDatesInBody(body, opts.refDate || new Date(), opts);
  if (!dateBoundary.ok) {
    return { ok: false, error: dateBoundary.reason || 'invalid_date' };
  }
  const b = dateBoundary.body;
  const guest_name = String(b.guest_name || '').trim();
  // Quote may run with blank guest name; create remains fail-closed unless allowBlankGuest.
  if (opts.allowBlankGuest) {
    if (guest_name.length > 200) {
      return { ok: false, error: 'guest_name is required (max 200 chars)' };
    }
  } else if (!guest_name || guest_name.length > 200) {
    return { ok: false, error: 'guest_name is required (max 200 chars)' };
  }
  const guest_phone = b.guest_phone != null ? String(b.guest_phone).trim().slice(0, 40) : '';
  // Staff Create requires valid phone; quote + Luna create keep phone optional.
  if (opts.requireGuestPhone) {
    if (!isValidStaffCreateGuestPhone(guest_phone)) {
      return { ok: false, error: 'guest_phone is required' };
    }
  }

  // Canonical multi-lesson array (preferred) with legacy single-course/private expand.
  const {
    normalizeCanonicalLessons,
    expandLessonsToLegacyComponents,
  } = require('./sunset-schedule-lessons');
  const lessonsNorm = normalizeCanonicalLessons(b);
  if (!lessonsNorm.ok) {
    return {
      ok: false,
      error: lessonsNorm.error || 'invalid_lessons',
      reason: lessonsNorm.reason || lessonsNorm.error,
    };
  }
  // When lessons[] present, expand into components/service_dates for legacy paths
  // (homogeneous single-course multi-date / private sessions). Multi-course group
  // keeps lessons[] for insert; still seeds service_dates from unique calendar days.
  let bodyForComponents = b;
  if (lessonsNorm.present) {
    const surferHint = parseAuthoritativeSurferCount(b)
      || (b.components && b.components.course && Number(b.components.course.quantity))
      || (b.components && b.components.private_lesson
        && Number(b.components.private_lesson.surfer_count))
      || 1;
    const expanded = expandLessonsToLegacyComponents(lessonsNorm.lessons, surferHint);
    if (!expanded.ok) {
      return { ok: false, error: expanded.error || 'invalid_lessons', reason: expanded.reason };
    }
    const nextComponents = { ...(b.components && typeof b.components === 'object' ? b.components : {}) };
    // Drop legacy class keys before re-seeding from lessons (never mix).
    delete nextComponents.course;
    delete nextComponents.private_lesson;
    delete nextComponents.lesson;
    Object.assign(nextComponents, expanded.components || {});
    bodyForComponents = {
      ...b,
      components: nextComponents,
      service_dates: expanded.service_dates && expanded.service_dates.length
        ? expanded.service_dates
        : lessonsNorm.unique_dates,
      date_from: (expanded.service_dates && expanded.service_dates[0])
        || lessonsNorm.unique_dates[0]
        || b.date_from,
      date_to: (expanded.service_dates && expanded.service_dates[expanded.service_dates.length - 1])
        || lessonsNorm.unique_dates[lessonsNorm.unique_dates.length - 1]
        || b.date_to,
      lessons: lessonsNorm.lessons,
    };
  }

  const accommodationSel = normalizeAccommodationSelection(b.accommodation);
  if (!accommodationSel.ok) {
    return {
      ok: false,
      error: accommodationSel.error,
      reason: accommodationSel.reason_code || 'accommodation_invalid',
    };
  }
  // Accommodation (or generic rentals) may be the sole commercial content — allow empty components.
  const allowEmpty = opts.allowEmptyComponents === true
    || (!!accommodationSel.value && !accommodationSel.skip);
  const components = normalizeComponents(bodyForComponents, !!allowEmpty);
  if (!components.ok) return components;
  const serviceDates = normalizeServiceDates(bodyForComponents, components.value);
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
  const customLines = normalizeCustomLineItems(b.custom_line_items);
  if (!customLines.ok) return customLines;
  // Shared quote/create owner: independent equipment qty; surfer_count is guest field.
  // Staff: fail closed when equipment present and surfer_count absent/invalid.
  // Trusted Luna (opts.actor / opts.lunaTrusted): may derive surfer_count from component qty.
  const rentalsForForce = Array.isArray(bodyForComponents.rentals) ? bodyForComponents.rentals : null;
  const forceOpts = {
    actor: opts.actor || null,
    lunaTrusted: opts.lunaTrusted === true,
  };
  const forced = applyNoLessonEquipmentQtyFromSurfers(
    { ...bodyForComponents, components: components.value },
    rentalsForForce,
    forceOpts,
  );
  if (!forced.ok) {
    return {
      ok: false,
      error: forced.error || NO_LESSON_EQUIPMENT_SURFER_REQUIRED,
      reason: forced.reason || forced.reason_code || NO_LESSON_EQUIPMENT_SURFER_REQUIRED,
    };
  }
  const forcedComps = (forced.body && forced.body.components) || components.value;
  let surfer_count = forced.surfer_count != null
    ? forced.surfer_count
    : parseAuthoritativeSurferCount(forced.body || bodyForComponents);
  // When lessons[] owns class identity, surfer_count is shared across all lessons.
  if (surfer_count == null && lessonsNorm.present) {
    if (forcedComps.course && Number(forcedComps.course.quantity) >= 1) {
      surfer_count = Number(forcedComps.course.quantity);
    } else if (forcedComps.private_lesson && Number(forcedComps.private_lesson.surfer_count) >= 1) {
      surfer_count = Number(forcedComps.private_lesson.surfer_count);
    }
  }
  // Absent wire forms (undefined / null / []) mean no course equipment selected.
  // Browser Create always serializes course_equipment: [] for rental-only; do not
  // treat that empty array as a supplied selection requiring Group/Private.
  let course_equipment = null;
  if (isPresentCourseEquipmentSelection(bodyForComponents.course_equipment)) {
    const coursePart = forcedComps.course || forcedComps.private_lesson || lessonsNorm.present;
    if (!coursePart) return { ok: false, error: 'course_equipment requires a group or private course' };
    const surfers = forcedComps.private_lesson
      ? Number(forcedComps.private_lesson.surfer_count)
      : (forcedComps.course
        ? Number(forcedComps.course.quantity)
        : (surfer_count != null ? surfer_count : 1));
    try { course_equipment = normalizeSelection(bodyForComponents.course_equipment, surfers); }
    catch (err) {
      return {
        ok: false,
        error: 'invalid_course_equipment',
        reason: 'invalid_course_equipment',
        detail: String(err.message || err),
      };
    }
    // Quote-stage selection is wire-canonical arrays. Persistence still owns write rows.
    if (Array.isArray(course_equipment)
      && course_equipment.some((row) => row && row.mode === 'all_day')
      && forcedComps[FULL_DAY_EQUIPMENT_ADDON_KEY]) {
      return { ok: false, error: 'course_equipment all_day must not overlap legacy full-day equipment extension' };
    }
  }

  // Always echo canonical lessons (from wire or legacy expand) for readback/fingerprint.
  // Multi product-button selected_courses (≥2) own course identity without Group lessons[] —
  // do not invent a single-course lesson expand (would clobber multi persist/quote paths).
  let lessonsOut = null;
  if (lessonsNorm.present) {
    lessonsOut = lessonsNorm.lessons;
  } else if (forcedComps.course || forcedComps.private_lesson) {
    const multiSelectedCourses = forcedComps.course
      && Array.isArray(forcedComps.course.selected_courses)
      && forcedComps.course.selected_courses.length > 1;
    if (multiSelectedCourses) {
      lessonsOut = [];
    } else {
      const expandedBack = normalizeCanonicalLessons({
        components: forcedComps,
        service_dates: serviceDates.value,
      });
      if (expandedBack.ok && expandedBack.present) lessonsOut = expandedBack.lessons;
    }
  }

  return {
    ok: true,
    value: {
      guest_name,
      guest_phone: guest_phone || null,
      components: forcedComps,
      service_dates: serviceDates.value,
      payment_status,
      notes,
      needs_reply,
      idempotency_key: idempotency_key || null,
      rental_pricing: rentalPricing.skip ? null : rentalPricing.value,
      custom_line_items: customLines.value,
      accommodation: accommodationSel.skip ? null : accommodationSel.value,
      surfer_count: surfer_count != null ? surfer_count : null,
      course_equipment,
      lessons: lessonsOut,
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
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : null,
    _meta: row.metadata && typeof row.metadata === 'object' ? row.metadata : null,
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
            sr.metadata AS metadata,
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
                 metadata AS metadata,
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
                 metadata AS metadata,
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
                 metadata AS metadata,
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

function canonicalRentalCoveredDates(r) {
  const raw = (r && (r.covered_dates || r.rental_service_dates)) || [];
  return Array.isArray(raw)
    ? raw.map((d) => String(d || '').slice(0, 10)).filter(Boolean).sort()
    : [];
}

function canonicalRentalsForIntentFingerprint(rentals) {
  if (!Array.isArray(rentals) || !rentals.length) return [];
  return rentals.map((r) => {
    const offering_key = String((r && r.offering_key) || '').trim();
    return {
      offering_key,
      duration_key: String((r && r.duration_key) || '').trim(),
      quantity: Number(r && r.quantity) || 0,
      covered_dates: canonicalRentalCoveredDates(r),
      pricing_group: (
        offering_key === 'board_and_suit_rental'
        || (r && (r.pricing_group_id || r.rental_bundle_id))
      ) ? 'bundle' : 'single',
    };
  }).filter((r) => r.offering_key)
    .sort((a, b) => (a.offering_key < b.offering_key ? -1 : (a.offering_key > b.offering_key ? 1 : 0)));
}

function buildScheduleBookingIntentFingerprint(input, locationId, opts) {
  opts = opts || {};
  const components = input && input.components ? input.components : {};
  const ordered = {};
  Object.keys(components).sort().forEach((k) => { ordered[k] = components[k]; });
  const rentalsSrc = opts.rentals != null ? opts.rentals
    : (input && input.rentals != null ? input.rentals : []);
  const customSrc = opts.custom_line_items != null
    ? opts.custom_line_items
    : (input && input.custom_line_items);
  const accomSrc = opts.accommodation != null
    ? opts.accommodation
    : (input && input.accommodation);
  const {
    canonicalLessonsForIntentFingerprint,
  } = require('./sunset-schedule-lessons');
  const lessonsSrc = opts.lessons != null
    ? opts.lessons
    : (input && input.lessons != null ? input.lessons : []);
  return crypto.createHash('sha256').update(JSON.stringify({
    location_id: String(locationId || ''),
    guest_name: String((input && input.guest_name) || ''),
    guest_phone: input && input.guest_phone != null ? String(input.guest_phone) : '',
    payment_status: String((input && input.payment_status) || 'unpaid'),
    service_dates: ((input && input.service_dates) || []).slice().sort(),
    components: ordered,
    lessons: canonicalLessonsForIntentFingerprint(lessonsSrc),
    rentals: canonicalRentalsForIntentFingerprint(rentalsSrc),
    custom_line_items: customLinesForIntentFingerprint(customSrc),
    accommodation: accommodationForIntentFingerprint(accomSrc),
    notes: String((input && input.notes) || ''),
    needs_reply: !!(input && input.needs_reply),
  })).digest('hex');
}

/** Pricing intent only (dates + components + rentals); guest/payment excluded. */
function buildSchedulePricingIntent(input, opts) {
  opts = opts || {};
  const componentsIn = (input && input.components && typeof input.components === 'object')
    ? input.components : {};
  const components = {};
  Object.keys(componentsIn).sort().forEach((key) => {
    const part = componentsIn[key];
    if (!part || typeof part !== 'object') return;
    if (key === 'private_lesson') {
      const sessions = Array.isArray(part.sessions)
        ? part.sessions.map((s) => ({
          date: String((s && s.date) || '').slice(0, 10),
          start: String((s && s.start) || '').trim(),
          end: String((s && s.end) || '').trim(),
        })).sort((a, b) => a.date.localeCompare(b.date)
          || a.start.localeCompare(b.start)
          || a.end.localeCompare(b.end))
        : [];
      components[key] = {
        quantity: Number(part.quantity) || sessions.length || 1,
        surfer_count: Number(part.surfer_count) || 1,
        sessions,
      };
      return;
    }
    if (key === FULL_DAY_EQUIPMENT_ADDON_KEY) {
      const dates = {};
      const rawDates = (part.dates && typeof part.dates === 'object') ? part.dates : {};
      Object.keys(rawDates).sort().forEach((iso) => {
        dates[String(iso).slice(0, 10)] = Number(rawDates[iso]) || 1;
      });
      components[key] = { enabled: true, dates };
      return;
    }
    const row = { quantity: Number(part.quantity) || 1 };
    if (key === 'lesson') {
      if (part.slot_time) row.slot_time = String(part.slot_time).trim();
      row.category = String(part.category || DEFAULT_LESSON_CATEGORY).trim() || DEFAULT_LESSON_CATEGORY;
    }
    if (key === 'course') {
      if (part.course_id) row.course_id = String(part.course_id).trim();
      if (part.tier_key) row.tier_key = String(part.tier_key).trim();
      if (part.offering_id) row.offering_id = String(part.offering_id).trim();
      else if (row.course_id && row.tier_key) {
        try {
          row.offering_id = require('./sunset-admin-price-identity')
            .packPriceItemCode(row.course_id, row.tier_key);
        } catch (_) { /* incomplete → equality fails closed */ }
      }
      if (Array.isArray(part.selected_courses) && part.selected_courses.length) {
        row.selected_courses = part.selected_courses.map((sc) => ({
          course_id: String((sc && sc.course_id) || '').trim(),
          tier_key: String((sc && sc.tier_key) || '').trim() || null,
          offering_id: String((sc && sc.offering_id) || '').trim() || null,
        })).filter((sc) => sc.course_id)
          .sort((a, b) => a.course_id.localeCompare(b.course_id)
            || String(a.tier_key || '').localeCompare(String(b.tier_key || '')));
      }
    }
    components[key] = row;
  });
  let rentalsSrc;
  if (Object.prototype.hasOwnProperty.call(opts, 'rentals')) rentalsSrc = opts.rentals;
  else if (input && Object.prototype.hasOwnProperty.call(input, 'rentals')) rentalsSrc = input.rentals;
  else if (opts.preserveExistingRentals != null) rentalsSrc = opts.preserveExistingRentals;
  else rentalsSrc = [];
  if (Array.isArray(rentalsSrc) && Array.isArray(opts.rentalCoveredDates) && opts.rentalCoveredDates.length) {
    rentalsSrc = rentalsSrc.map((r) => {
      const covered = canonicalRentalCoveredDates(r);
      return { ...r, covered_dates: covered.length ? covered : opts.rentalCoveredDates.slice() };
    });
  }
  const customSrc = opts.custom_line_items != null
    ? opts.custom_line_items
    : (input && input.custom_line_items);
  const accomSrc = opts.accommodation != null
    ? opts.accommodation
    : (input && input.accommodation);
  const {
    canonicalLessonsForIntentFingerprint,
  } = require('./sunset-schedule-lessons');
  const lessonsSrc = opts.lessons != null
    ? opts.lessons
    : (input && input.lessons != null ? input.lessons : []);
  return {
    service_dates: ((input && input.service_dates) || [])
      .map((d) => String(d || '').slice(0, 10)).filter(Boolean).sort(),
    components,
    lessons: canonicalLessonsForIntentFingerprint(lessonsSrc),
    rentals: canonicalRentalsForIntentFingerprint(rentalsSrc),
    // Custom adjustments are pricing intent — changes invalidate stale quote / paid reprice.
    custom_line_items: customLinesForIntentFingerprint(customSrc),
    accommodation: accommodationForIntentFingerprint(accomSrc),
    course_equipment: (() => {
      const raw = input && input.course_equipment;
      if (!isPresentCourseEquipmentSelection(raw)) return null;
      if (Array.isArray(raw)) {
        const rows = raw
          .map((row) => {
            if (!row || typeof row !== 'object') return null;
            const offering_key = String(row.offering_key || '').trim();
            if (!offering_key) return null;
            return {
              offering_key,
              mode: row.mode === 'all_day' ? 'all_day' : 'during_course',
              quantity: Number(row.quantity) || 0,
            };
          })
          .filter(Boolean)
          .sort((a, b) => a.offering_key.localeCompare(b.offering_key));
        return rows.length ? rows : null;
      }
      // Narrow historical singleton shape for intent equality only.
      if (raw && typeof raw === 'object') return { ...raw };
      return null;
    })(),
  };
}

function pricingIntentHasCompleteIdentity(intent) {
  if (!intent || typeof intent !== 'object') return false;
  const comps = intent.components || {};
  for (const key of Object.keys(comps)) {
    const part = comps[key];
    if (!part || typeof part !== 'object') return false;
    if (key === 'course') {
      if (!part.course_id || !part.tier_key || !part.offering_id || !(Number(part.quantity) > 0)) return false;
    } else if (key === 'lesson') {
      if (!part.category || !(Number(part.quantity) > 0)) return false;
    } else if (key === 'private_lesson') {
      const sessions = part.sessions || [];
      if (!sessions.length || sessions.some((s) => !s.date || !s.start || !s.end)) return false;
    } else if (key === FULL_DAY_EQUIPMENT_ADDON_KEY) {
      if (!part.dates || !Object.keys(part.dates).length) return false;
    } else if (!(Number(part.quantity) > 0)) return false;
  }
  return !(intent.rentals || []).some(
    (r) => !r.offering_key || !r.duration_key || !(Number(r.quantity) > 0),
  );
}

/** Complete semantic equality only — incomplete identity never false-unchanged. */
function schedulePricingIntentsEqual(a, b) {
  if (!pricingIntentHasCompleteIdentity(a) || !pricingIntentHasCompleteIdentity(b)) return false;
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

const PAID_BOOKING_REPRICE_REQUIRED = 'paid_booking_reprice_required';

function isSunsetBookingFinanciallyCommitted(bundle) {
  const booking = (bundle && bundle.booking) || {};
  if (Number(booking.amount_paid_cents) > 0) return true;
  if (Number(bundle && bundle.payments_paid_cents) > 0) return true;
  const ps = String(booking.payment_status || '').toLowerCase();
  if (ps === 'paid' || ps === 'complete' || ps === 'completed' || ps === 'partially_paid') return true;
  for (const sr of (bundle && bundle.services) || []) {
    if (Number(sr && sr.amount_paid_cents) > 0) return true;
    const sPs = String((sr && sr.payment_status) || '').toLowerCase();
    if (sPs === 'paid' || sPs === 'complete' || sPs === 'completed') return true;
  }
  return false;
}

function paidBookingRepriceRequiredResult() {
  return {
    ok: false,
    status: 409,
    body: {
      success: false,
      error: PAID_BOOKING_REPRICE_REQUIRED,
      reason_code: PAID_BOOKING_REPRICE_REQUIRED,
    },
  };
}

async function lockSchedulePaymentsForUpdate(pg, bookingId, clientId) {
  const res = await pg.query(
    `SELECT id::text AS payment_id, status::text AS payment_status,
            amount_due_cents, amount_paid_cents
       FROM payments
      WHERE booking_id = $1::uuid AND client_id = $2::uuid
      FOR UPDATE`,
    [bookingId, clientId],
  );
  const rows = res.rows || [];
  let paidCents = 0;
  for (const p of rows.filter((row) => String(row.payment_status || '').toLowerCase() === 'paid')) {
    paidCents = checkedMoneyAdd(paidCents, p.amount_paid_cents || 0, 'payments_paid');
  }
  return { rows, paidCents };
}

async function applyEditPaidAmountInTxn(pg, opts) {
  const { bookingId, clientId, paymentMethod, actorEmail } = opts;
  let paid = Number(opts.paymentsPaidCents) || 0;
  if (paid <= 0) {
    if (!clientId) {
      return {
        ok: false, status: 409,
        body: {
          success: false,
          error: 'mark_paid_requires_client_scope',
          reason_code: 'mark_paid_requires_client_scope',
        },
      };
    }
    const totalRes = await pg.query(
      // MULTICLIENT_SCOPE_OK: mark-paid total
      `SELECT COALESCE(total_amount_cents, 0)::int AS total FROM bookings
        WHERE id = $1::uuid AND client_id = $2::uuid`,
      [bookingId, clientId],
    );
    if (!totalRes.rows.length) {
      return { ok: false, status: 409, body: { success: false, error: 'booking_mark_paid_conflict' } };
    }
    const total = Number(totalRes.rows[0].total) || 0;
    if (total <= 0) {
      return {
        ok: false, status: 409,
        body: {
          success: false,
          error: 'cannot_mark_paid_zero_total',
          reason_code: 'cannot_mark_paid_zero_total',
        },
      };
    }
    await pg.query(
      `INSERT INTO payments (
         client_id, booking_id, status, payment_kind, currency,
         amount_due_cents, amount_paid_cents, metadata
       ) VALUES (
         $1::uuid, $2::uuid, 'paid'::payment_record_status, 'full_amount'::payment_kind, 'EUR',
         $3, $3, $4::jsonb)`,
      [
        clientId, bookingId, total,
        JSON.stringify({
          source: 'staff_edit_manual_mark_paid',
          method: paymentMethod || 'in_store',
          actor: actorEmail || null,
        }),
      ],
    );
    paid = total;
  }
  const upd = await pg.query(
    // MULTICLIENT_SCOPE_OK: money header
    `UPDATE bookings SET amount_paid_cents = $1,
            balance_due_cents = GREATEST(COALESCE(total_amount_cents, 0) - $1, 0)
      WHERE id = $2::uuid AND client_id = $3::uuid`,
    [paid, bookingId, clientId],
  );
  if (Number(upd && upd.rowCount) !== 1) {
    return { ok: false, status: 409, body: { success: false, error: 'booking_mark_paid_conflict' } };
  }
  return { ok: true, amount_paid_cents: paid };
}

function throwSunsetPriceFail(status, error, extra) {
  const err = new Error(error);
  err.sunsetPriceFail = {
    ok: false,
    status,
    body: { success: false, error, reason_code: error, ...(extra || {}) },
  };
  throw err;
}

async function resolveAuthoritativeScheduleQuoteInTxn(pg, opts) {
  const clientSlug = String((opts && opts.clientSlug) || '').trim();
  const locationId = (opts && opts.locationId) != null ? String(opts.locationId) : '';
  let rentalPricingDescriptor = opts && opts.rentalPricingDescriptor;
  const genericQuote = buildGenericRentalAuthoritativeQuote(opts && opts.genericRentalRecords);
  const genericOnly = genericQuote.line_items.length > 0
    && !(opts && Array.isArray(opts.canonicalRentals) && opts.canonicalRentals.length);
  if (genericOnly) return { authoritativeQuote: genericQuote, rentalPricingDescriptor };
  // Sunset Create/Edit commercial pricing: every mutation requires an Admin-backed
  // quote transport body (quotePrepBody). Missing body is fail-closed — never
  // silently fall back to priceSunsetBookingServices or fabricated cents.
  const transportBody = (opts && (opts.quotePrepBody || opts.rentalPrepBody)) || null;
  if (!transportBody || typeof transportBody !== 'object') {
    throwSunsetPriceFail(422, 'authoritative_quote_body_required', {
      reason_code: 'authoritative_quote_body_required',
    });
  }
  const {
    buildSunsetQuoteCommand, executeSunsetQuote, buildQuoteProvenance, QUOTE_CHANNELS,
  } = require('./luna-front-desk-quote-service');
  const {
    resolveTenantBusinessConfigAsync,
    isSunsetAdminDbReadEnabled,
  } = require('./tenant-business-config');
  const adminCfg = await resolveTenantBusinessConfigAsync(clientSlug, {
    locationId, pgClient: pg,
  });
  if (!adminCfg || adminCfg.ok === false) {
    throwSunsetPriceFail(422, 'admin_config_unavailable', {
      reason_code: 'admin_db_expected_unavailable',
    });
  }
  // When Admin DB-read is on, Create must re-quote from DB (fail closed if source
  // is not db). When the flag is off, config-file Admin prices are the authority
  // — do not demand source===db (unit tests + offline config mode).
  const requireDb = isSunsetAdminDbReadEnabled() === true;
  const channel = opts.quoteChannel === 'luna_whatsapp'
    ? QUOTE_CHANNELS.LUNA_WHATSAPP : QUOTE_CHANNELS.MANUAL_STAFF;
  const quoteBuilt = buildSunsetQuoteCommand({
    channel,
    trustedLocationId: locationId,
    transportBody: { ...transportBody, require_db: requireDb },
    // Trusted server-only: Edit path sets this when locked bundle already has
    // dedicated staff_accommodation. Never copied from transportBody.
    allowExistingAccommodationWhenDisabled:
      opts && opts.allowExistingAccommodationWhenDisabled === true,
    existingAccommodationStayCount: Number.isInteger(
      opts && opts.existingAccommodationStayCount,
    )
      ? opts.existingAccommodationStayCount
      : null,
    now: opts.now instanceof Date ? opts.now : new Date(),
  });
  if (!quoteBuilt.ok) {
    const err = new Error((quoteBuilt.body && quoteBuilt.body.error) || 'quote_failed');
    err.sunsetPriceFail = quoteBuilt;
    throw err;
  }
  const freshQuote = await executeSunsetQuote(pg, quoteBuilt.command, { adminCfg });
  if (!freshQuote.ok) {
    const msg = (freshQuote.body && (freshQuote.body.error || freshQuote.body.reason)) || 'quote_failed';
    throwSunsetPriceFail(freshQuote.status || 422, msg, {
      reason_code: (freshQuote.body && (freshQuote.body.reason_code || freshQuote.body.reason))
        || 'quote_failed',
      quote_error: freshQuote.body,
    });
  }
  const provenance = opts.quoteProvenance;
  if (provenance && typeof provenance === 'object') {
    const freshProv = buildQuoteProvenance(freshQuote.body);
    if (String(provenance.quote_fingerprint || '') !== String(freshProv.quote_fingerprint || '')) {
      throwSunsetPriceFail(409, 'The quoted price is no longer available. Please request a fresh quote.', {
        reason_code: 'stale_quote',
        detail: 'quote_fingerprint_mismatch',
        expected_fingerprint: provenance.quote_fingerprint,
        current_fingerprint: freshProv.quote_fingerprint,
      });
    }
  }
  let authoritativeQuote = freshQuote.body;
  if (genericQuote.line_items.length) {
    authoritativeQuote = {
      ...authoritativeQuote,
      line_items: [...(authoritativeQuote.line_items || []), ...genericQuote.line_items],
      total_cents: checkedMoneyAdd(authoritativeQuote.total_cents, genericQuote.total_cents, 'mixed_quote_total'),
    };
  }
  if (rentalPricingDescriptor && rentalPricingDescriptor.offering_key === 'board_and_suit_rental') {
    const bundleLine = findQuoteLineForRentalOffering(
      authoritativeQuote.line_items, 'board_and_suit_rental',
    );
    if (bundleLine && bundleLine.total_cents != null) {
      rentalPricingDescriptor = {
        ...rentalPricingDescriptor,
        quoted_total_cents: Number(bundleLine.total_cents),
      };
    }
  }
  return { authoritativeQuote, rentalPricingDescriptor };
}

/** Exact quote claim or DB price path; requires clientId. Throws sunsetPriceFail. */
async function applyAuthoritativeSchedulePricingInTxn(pg, opts) {
  const clientSlug = String((opts && opts.clientSlug) || '').trim();
  const bookingId = opts && opts.bookingId;
  const clientId = opts && opts.clientId;
  if (!clientId) throwSunsetPriceFail(500, 'client_id_required_for_pricing');
  const createdRows = (opts && opts.createdRows) || [];
  let rentalPricingDescriptor = opts && opts.rentalPricingDescriptor;
  let authoritativeQuote = opts && opts.authoritativeQuote;

  if (!authoritativeQuote && opts && (opts.rentalPrepBody || opts.quotePrepBody)) {
    const resolved = await resolveAuthoritativeScheduleQuoteInTxn(pg, opts);
    authoritativeQuote = resolved.authoritativeQuote;
    if (resolved.rentalPricingDescriptor) {
      rentalPricingDescriptor = resolved.rentalPricingDescriptor;
    }
  }

  if (!authoritativeQuote) {
    // Create/Edit reprice path: no silent fallback when quote is absent.
    // Paid safety remains upstream (isSunsetBookingFinanciallyCommitted / lockedPaidCents).
    throwSunsetPriceFail(422, 'authoritative_quote_required', {
      reason_code: 'authoritative_quote_required',
    });
  }

  // Full-day equipment is a commercial quote line when present on the Admin quote.
  // Claim those rows via quote (no double-add of snapshotted addon cents).
  // Legacy path: if quote has no full-day line, keep snapshot amounts outside the claim.
  const quoteLines = Array.isArray(authoritativeQuote.line_items)
    ? authoritativeQuote.line_items : [];
  const fullDayInQuote = quoteLines.some((line) => {
    if (!line) return false;
    const c = String(line.component || '');
    const code = String(line.offering_item_code || line.offering_id || '');
    return c === FULL_DAY_EQUIPMENT_ADDON_KEY || c === 'addon_service'
      || code === `${FULL_DAY_EQUIPMENT_ADDON_KEY}__day`
      || code.startsWith(`${FULL_DAY_EQUIPMENT_ADDON_KEY}__`);
  });
  function isFullDayServiceRow(row) {
    const meta = rowMetadata(row);
    // Staff custom commercial lines also use service_type addon_service + own metadata.
    // Never treat them as full-day snapshot rows or exclude them from quote claim.
    if (meta.component === STAFF_CUSTOM_LINE_COMPONENT
      || meta.source === STAFF_CUSTOM_LINE_SOURCE
      || meta.staff_custom_line === true) {
      return false;
    }
    if (isStaffAccommodationMeta(meta)) return false;
    // Multi-item course equipment uses addon_service but is quote-owned, not full-day.
    if (meta.course_equipment === true) return false;
    const st = String(row.service_type || '').toLowerCase();
    return st === 'addon_service'
      || meta.component === FULL_DAY_EQUIPMENT_ADDON_KEY
      || meta.service_key === FULL_DAY_EQUIPMENT_ADDON_KEY;
  }
  const quoteOwnedRows = createdRows.filter((row) => {
    const meta = rowMetadata(row);
    // Included gear has its own persisted €0 audit rows and is already commercially
    // represented by the course quote line. Never force it to claim a paid catalog line.
    if (meta.included_equipment === true
      && (meta.component === 'surfboard' || meta.component === 'wetsuit')) return false;
    if (isFullDayServiceRow(row)) return fullDayInQuote;
    return true;
  });
  const applied = await applyAuthoritativeQuoteAmounts(pg, quoteOwnedRows, authoritativeQuote, {
    clientSlug,
  });
  if (!applied.ok) throwSunsetPriceFail(422, applied.error || 'quote_amount_apply_failed');
  if (Number(authoritativeQuote.total_cents) !== Number(applied.total_cents)) {
    throwSunsetPriceFail(422, 'quote_total_mismatch');
  }
  // Only add snapshotted full-day cents when they were NOT claimed via the quote
  // (avoids double-charging). Bundle peers stay zero-valued by applyAuthoritativeQuoteAmounts.
  let addonSum = 0;
  for (const row of createdRows) {
    if (quoteOwnedRows.includes(row)) continue;
    const meta = rowMetadata(row);
    // A legacy full-day snapshot is outside ownership only when no matching quote line exists.
    if (fullDayInQuote) continue;
    const due = checkedMoneyInteger(row.amount_due_cents || 0, 'addon_sum');
    if (due > 0) addonSum = checkedMoneyAdd(addonSum, due, 'addon_sum');
  }
  const bookingTotal = checkedMoneyAdd(applied.total_cents, addonSum, 'booking_total');
  const metaPatch = {
    sunset_priced_at: new Date().toISOString(),
    sunset_price_source: 'authoritative_quote',
    quote_fingerprint: authoritativeQuote.quote_provenance
      && authoritativeQuote.quote_provenance.quote_fingerprint,
    // Persist exact quoted lines + total (server-owned; no client money).
    quote_total_cents: Number(authoritativeQuote.total_cents),
    quote_line_items: Array.isArray(authoritativeQuote.line_items)
      ? authoritativeQuote.line_items.map((line) => {
        const base = {
          component: line && line.component,
          offering_id: line && line.offering_id,
          offering_item_code: line && (line.offering_item_code || line.item_code),
          duration_key: line && line.duration_key,
          quantity: line && line.quantity,
          unit_amount_cents: line && line.unit_amount_cents,
          total_cents: line && line.total_cents,
        };
        // Staff custom lines: keep identity + signed cents for audit/display (amount_due CHECK ≥ 0).
        if (line && (line.component === STAFF_CUSTOM_LINE_COMPONENT
          || line.price_source === STAFF_CUSTOM_LINE_SOURCE)) {
          base.client_line_id = line.client_line_id != null ? line.client_line_id : null;
          base.label = line.label != null ? line.label : null;
          base.price_source = STAFF_CUSTOM_LINE_SOURCE;
        }
        return base;
      })
      : [],
  };
  const bookingUpd = await pg.query(
    // MULTICLIENT_SCOPE_OK: same-txn booking header; client_id predicate defense-in-depth
    `UPDATE bookings
        SET total_amount_cents = $1,
            balance_due_cents = GREATEST($1 - COALESCE(amount_paid_cents, 0), 0),
            metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
      WHERE id = $3::uuid AND client_id = $4::uuid`,
    [bookingTotal, JSON.stringify(metaPatch), bookingId, clientId],
  );
  if (Number(bookingUpd && bookingUpd.rowCount) !== 1) {
    throwSunsetPriceFail(422, 'booking_total_update_mismatch');
  }
  let priced = {
    ok: true,
    total_cents: bookingTotal,
    sunset_price_source: 'authoritative_quote',
    authoritativeQuote,
    rentalPricingDescriptor,
  };
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'lockedPaidCents')) {
    const lockedPaidCents = Math.max(0, checkedMoneyInteger(opts.lockedPaidCents || 0, 'paid'));
    const total = checkedMoneyInteger(priced.total_cents, 'booking_total');
    const balance = Math.max(checkedMoneySubtract(total, lockedPaidCents, 'balance'), 0);
    const bal = await pg.query(
      // MULTICLIENT_SCOPE_OK: balance = total - locked ledger paid
      `UPDATE bookings SET amount_paid_cents = $1, balance_due_cents = $2
        WHERE id = $3::uuid AND client_id = $4::uuid`,
      [lockedPaidCents, balance, bookingId, clientId],
    );
    if (Number(bal && bal.rowCount) !== 1) {
      throwSunsetPriceFail(409, 'booking_balance_update_conflict');
    }
    priced = { ...priced, amount_paid_cents: lockedPaidCents, balance_due_cents: balance };
  }
  return priced;
}

function decorateRentalServiceMetadata(metadata, opts) {
  const componentKey = opts.componentKey;
  if (componentKey !== 'surfboard' && componentKey !== 'wetsuit') return metadata;
  if (opts.canonicalRentals) {
    const rental = opts.canonicalRentals.find((r) => {
      if (r.offering_key === 'board_and_suit_rental') return true;
      if (componentKey === 'surfboard') return r.offering_key === 'board_rental';
      return r.offering_key === 'wetsuit_rental';
    });
    if (rental) {
      const quoteLine = opts.authoritativeQuote
        ? findQuoteLineForRentalOffering(opts.authoritativeQuote.line_items, rental.offering_key)
        : null;
      metadata.offering_key = rental.offering_key;
      metadata.duration_key = rental.duration_key;
      metadata.quantity = rental.quantity;
      metadata.rental_service_dates = opts.rentalSpanDates;
      metadata.offering_id = `${rental.offering_key}__${rental.duration_key}`;
      if (rental.offering_key === 'board_and_suit_rental') {
        metadata.pricing_group_id = opts.rentalPricingGroupId;
        metadata.bundle_part = componentKey;
        metadata.rental_pricing_role = componentKey;
        metadata.rental_bundle_id = opts.rentalPricingGroupId;
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
    return metadata;
  }
  const d = opts.rentalPricingDescriptor;
  if (d && opts.serviceDate === d.service_date) {
    metadata.pricing_group_id = d.pricing_group_id;
    metadata.rental_pricing_role = componentKey;
  }
  return metadata;
}

/** Shared Create/Edit: insert private + dated component rows (not full-day addon). */
async function insertScheduleComponentServiceRows(pg, opts) {
  const {
    clientSlug, bookingId, bookingCode, input, attribution, locationId, srPayment,
    assignedCourse, canonicalRentals, rentalSpanDates, rentalPricingGroupId,
    rentalPricingDescriptor, authoritativeQuote, bundleId,
  } = opts;
  const assignedCoursesById = opts.assignedCoursesById || null;
  const wrapMeta = typeof opts.wrapMeta === 'function' ? opts.wrapMeta : (m) => m;
  const plConfig = opts.privateLessonConfig || defaultPrivateLessonApi();
  const keys = opts.componentKeys || componentList(input.components);
  const base = opts.metaBase || {};
  const createdRows = [];
  const common = () => ({
    source: attribution.metadataSource,
    staff_manual_schedule: attribution.staffManualSchedule,
    components: keys,
    bundle_id: bundleId,
    notes: input.notes || null,
    needs_reply: input.needs_reply,
    location_id: locationId || null,
    ...base,
  });
  const {
    lessonIdentity,
    normalizeSelectedCourses,
  } = require('./sunset-schedule-lessons');
  const { packPriceItemCode } = require('./sunset-admin-price-identity');
  const groupLessons = Array.isArray(input.lessons)
    ? input.lessons.filter((l) => l && l.kind === 'group')
    : [];
  const selectedCourses = input.components && input.components.course
    ? normalizeSelectedCourses(input.components.course)
    : [];
  // Multi product-button selection (Create): one auditable course row per selected course.
  // Prefer this over date-range expand when ≥2 selected courses and no Edit lessons[].
  const useSelectedCoursesRows = selectedCourses.length > 1 && groupLessons.length === 0;
  // Always prefer one physical row per canonical group lesson when lessons[] owns identity.
  // Pack multi-date without schedule identity still expands via service_dates × course below
  // only when lessons[] is absent (legacy). When lessons[] is present, always one row each.
  const useCanonicalGroupLessonRows = groupLessons.length > 0;

  if (input.components.private_lesson) {
    const pl = input.components.private_lesson;
    const plLabel = pl.label || plConfig.label || opts.privateLessonDefaultLabel || 'Private lesson';
    // Prefer canonical private lessons when present (preserves same-day multi sessions).
    const privateLessons = Array.isArray(input.lessons)
      ? input.lessons.filter((l) => l && l.kind === 'private')
      : [];
    const sessions = privateLessons.length
      ? privateLessons.map((l, i) => ({
        date: l.date,
        start: l.start,
        end: l.end,
        index: i + 1,
      }))
      : (pl.sessions || []);
    for (const session of sessions) {
      const lid = lessonIdentity({
        kind: 'private', date: session.date, start: session.start, end: session.end,
      });
      const metadata = wrapMeta({
        ...common(),
        staff_ui_service_type: 'private_lesson',
        component: 'private_lesson',
        slot_time: session.start,
        start: session.start,
        end: session.end,
        lesson_identity: lid,
        private_lesson_label: plLabel,
        private_lesson_session_index: session.index,
        private_lesson_session_count: sessions.length || pl.quantity,
        price_basis: plConfig.price_basis || 'per_session',
        unit_amount_cents: plConfig.amount_cents || 0,
        default_duration_minutes: plConfig.default_duration_minutes || 120,
      }, locationId);
      const row = await insertServiceRecord(pg, [
        clientSlug, bookingId, bookingCode, input.guest_name,
        UI_TO_DB_SERVICE_TYPE.private_lesson, session.date, pl.surfer_count,
        srPayment, attribution.dbSource, JSON.stringify(metadata),
      ], { service_time_local: session.start, service_time_local_end: session.end });
      createdRows.push({ ...row, metadata });
    }
  }

  if (useSelectedCoursesRows) {
    const surfers = input.surfer_count != null
      ? Math.max(1, Number(input.surfer_count) || 1)
      : Math.max(1, Number(input.components.course && input.components.course.quantity) || 1);
    const primaryDate = Array.isArray(input.service_dates) && input.service_dates.length
      ? String(input.service_dates[0]).slice(0, 10)
      : String(input.date_from || '').slice(0, 10);
    for (const sc of selectedCourses) {
      const courseId = String(sc.course_id || '').trim();
      if (!courseId) continue;
      const tierKey = String(sc.tier_key || '1_day').trim() || '1_day';
      const assigned = (assignedCoursesById && assignedCoursesById[courseId])
        || (assignedCourse && String(assignedCourse.course_id || assignedCourse.pack_id || '') === courseId
          ? assignedCourse
          : null)
        || assignedCourse;
      const pack = assigned && assigned.pack ? assigned.pack : null;
      const courseLabel = sc.course_label
        || (pack && pack.label)
        || (assigned && assigned.course_label)
        || courseId;
      const offeringId = packPriceItemCode(courseId, tierKey);
      const metadata = wrapMeta({
        ...common(),
        staff_ui_service_type: 'course',
        component: 'course',
        course_id: courseId,
        course_label: courseLabel,
        tier_key: tierKey,
        offering_id: offeringId,
        selected_course: true,
        admin_course_assigned: !!assigned,
        admin_pack_id: assigned ? (assigned.course_id || courseId) : undefined,
        included_equipment: pack && pack.equipment_included === true ? true : undefined,
        include_board: pack && pack.equipment_included === true ? true : undefined,
        include_wetsuit: pack && pack.equipment_included === true ? true : undefined,
        included_equipment_amount_cents: pack && pack.equipment_included === true ? 0 : undefined,
      }, locationId);
      const row = await insertServiceRecord(pg, [
        clientSlug, bookingId, bookingCode, input.guest_name,
        UI_TO_DB_SERVICE_TYPE.course, primaryDate, surfers,
        srPayment, attribution.dbSource, JSON.stringify(metadata),
      ]);
      createdRows.push({ ...row, metadata });
      if (pack && pack.equipment_included === true) {
        for (const gearComponent of ['surfboard', 'wetsuit']) {
          const gearMetadata = wrapMeta({
            ...common(), staff_ui_service_type: gearComponent, component: gearComponent,
            included_equipment: true, included_course_id: courseId,
            included_course_service_date: primaryDate, price_basis: 'included_in_course',
            unit_amount_cents: 0, amount_cents: 0,
          }, locationId);
          const gearRow = await insertServiceRecord(pg, [
            clientSlug, bookingId, bookingCode, input.guest_name,
            UI_TO_DB_SERVICE_TYPE[gearComponent], primaryDate, surfers,
            srPayment, attribution.dbSource, JSON.stringify(gearMetadata),
          ]);
          createdRows.push({ ...gearRow, metadata: gearMetadata, amount_due_cents: 0 });
        }
      }
    }
  } else if (useCanonicalGroupLessonRows) {
    const surfers = input.surfer_count != null
      ? Math.max(1, Number(input.surfer_count) || 1)
      : Math.max(1, Number(input.components.course && input.components.course.quantity) || 1);
    for (const lesson of groupLessons) {
      const courseId = String(lesson.course_id || '').trim();
      const tierKey = String(lesson.tier_key || '1_day').trim() || '1_day';
      const assigned = (assignedCoursesById && assignedCoursesById[courseId])
        || (assignedCourse && String(assignedCourse.course_id || assignedCourse.pack_id || '') === courseId
          ? assignedCourse
          : null)
        || assignedCourse;
      const pack = assigned && assigned.pack ? assigned.pack : null;
      const courseLabel = lesson.course_label
        || (pack && pack.label)
        || (assigned && assigned.course_label)
        || (input.components.course && input.components.course.course_label)
        || courseId;
      const offeringId = packPriceItemCode(courseId, tierKey);
      const lid = lessonIdentity(lesson);
      const metadata = wrapMeta({
        ...common(),
        staff_ui_service_type: 'course',
        component: 'course',
        course_id: courseId,
        course_label: courseLabel,
        tier_key: tierKey,
        offering_id: offeringId,
        schedule_key: lesson.schedule_key || null,
        start: lesson.start || null,
        end: lesson.end || null,
        slot_time: lesson.start || null,
        lesson_identity: lid,
        admin_course_assigned: !!assigned,
        admin_pack_id: assigned ? (assigned.course_id || courseId) : undefined,
        included_equipment: pack && pack.equipment_included === true ? true : undefined,
        include_board: pack && pack.equipment_included === true ? true : undefined,
        include_wetsuit: pack && pack.equipment_included === true ? true : undefined,
        included_equipment_amount_cents: pack && pack.equipment_included === true ? 0 : undefined,
      }, locationId);
      const row = await insertServiceRecord(pg, [
        clientSlug, bookingId, bookingCode, input.guest_name,
        UI_TO_DB_SERVICE_TYPE.course, lesson.date, surfers,
        srPayment, attribution.dbSource, JSON.stringify(metadata),
      ], lesson.start || lesson.end
        ? { service_time_local: lesson.start || null, service_time_local_end: lesson.end || null }
        : undefined);
      createdRows.push({ ...row, metadata });
      if (pack && pack.equipment_included === true) {
        for (const gearComponent of ['surfboard', 'wetsuit']) {
          const gearMetadata = wrapMeta({
            ...common(), staff_ui_service_type: gearComponent, component: gearComponent,
            included_equipment: true, included_course_id: courseId,
            included_course_service_date: lesson.date, price_basis: 'included_in_course',
            unit_amount_cents: 0, amount_cents: 0,
          }, locationId);
          const gearRow = await insertServiceRecord(pg, [
            clientSlug, bookingId, bookingCode, input.guest_name,
            UI_TO_DB_SERVICE_TYPE[gearComponent], lesson.date, surfers,
            srPayment, attribution.dbSource, JSON.stringify(gearMetadata),
          ]);
          createdRows.push({ ...gearRow, metadata: gearMetadata, amount_due_cents: 0 });
        }
      }
    }
  }

  for (const serviceDate of input.service_dates) {
    for (const componentKey of keys) {
      if (componentKey === 'private_lesson' || componentKey === FULL_DAY_EQUIPMENT_ADDON_KEY) continue;
      // Canonical lessons / multi selected_courses own physical course rows —
      // never also expand date-range course.
      if (componentKey === 'course' && (useCanonicalGroupLessonRows || useSelectedCoursesRows)) continue;
      const part = input.components[componentKey];
      if (!part) continue;
      const metadata = wrapMeta({
        ...common(),
        staff_ui_service_type: staffUiServiceType(componentKey),
        component: componentKey,
        slot_time: componentKey === 'lesson' ? part.slot_time : null,
        lesson_category: componentKey === 'lesson' ? part.category : null,
        course_id: componentKey === 'course' ? part.course_id : null,
        course_label: componentKey === 'course' ? part.course_label : null,
        tier_key: componentKey === 'course' ? (part.tier_key || null) : null,
        offering_id: part.offering_id || null,
        admin_course_assigned: componentKey === 'course' && assignedCourse ? true : undefined,
        admin_pack_id: componentKey === 'course' && assignedCourse ? assignedCourse.course_id : undefined,
        included_equipment: componentKey === 'course' && assignedCourse && assignedCourse.pack && assignedCourse.pack.equipment_included === true ? true : undefined,
        include_board: componentKey === 'course' && assignedCourse && assignedCourse.pack && assignedCourse.pack.equipment_included === true ? true : undefined,
        include_wetsuit: componentKey === 'course' && assignedCourse && assignedCourse.pack && assignedCourse.pack.equipment_included === true ? true : undefined,
        included_equipment_amount_cents: componentKey === 'course' && assignedCourse && assignedCourse.pack && assignedCourse.pack.equipment_included === true ? 0 : undefined,
      }, locationId);
      decorateRentalServiceMetadata(metadata, {
        componentKey, serviceDate, canonicalRentals, rentalSpanDates,
        rentalPricingGroupId, rentalPricingDescriptor, authoritativeQuote,
      });
      const row = await insertServiceRecord(pg, [
        clientSlug, bookingId, bookingCode, input.guest_name,
        UI_TO_DB_SERVICE_TYPE[componentKey], serviceDate, part.quantity,
        srPayment, attribution.dbSource, JSON.stringify(metadata),
      ]);
      createdRows.push({ ...row, metadata });
      if (componentKey === 'course' && assignedCourse && assignedCourse.pack
        && assignedCourse.pack.equipment_included === true) {
        for (const gearComponent of ['surfboard', 'wetsuit']) {
          const gearMetadata = wrapMeta({
            ...common(), staff_ui_service_type: gearComponent, component: gearComponent,
            included_equipment: true, included_course_id: assignedCourse.course_id,
            included_course_service_date: serviceDate, price_basis: 'included_in_course',
            unit_amount_cents: 0, amount_cents: 0,
          }, locationId);
          const gearRow = await insertServiceRecord(pg, [
            clientSlug, bookingId, bookingCode, input.guest_name,
            UI_TO_DB_SERVICE_TYPE[gearComponent], serviceDate, part.quantity,
            srPayment, attribution.dbSource, JSON.stringify(gearMetadata),
          ]);
          createdRows.push({ ...gearRow, metadata: gearMetadata, amount_due_cents: 0 });
        }
      }
    }
  }
  return createdRows;
}

/**
 * Persist course-owned multi-item equipment as independent service rows.
 * One auditable row per offering_key × unique course service date.
 * Money/labels come only from quoteCourseEquipment at write time.
 * Total authority: mode unit price × quantity × unique course dates.
 */
async function insertCourseEquipmentRows(pg, opts) {
  if (opts.selection == null) return [];
  const selection = Array.isArray(opts.selection) ? opts.selection : opts.selection;
  if (Array.isArray(selection) && selection.length === 0) return [];

  const bookingDates = [...new Set(
    (opts.bookingDates || [])
      .map((d) => String(d || '').slice(0, 10))
      .filter(Boolean),
  )].sort();
  if (!bookingDates.length) throw new TypeError('course equipment requires a booking service date');

  const courseId = (opts.course && (opts.course.course_id || opts.course.pack_id || opts.course.id)) || null;
  const courseList = Array.isArray(opts.courses) && opts.courses.length
    ? opts.courses
    : (opts.course ? [opts.course] : []);
  const quote = quoteCourseEquipmentForLessonSet({
    courses: courseList,
    selection,
    surfers: opts.surfers,
    offerings: opts.offerings,
    clientSlug: opts.clientSlug || opts.clientSlugForOfferings,
    locationId: opts.locationId,
    serviceDates: bookingDates,
  });

  const rows = [];
  for (const line of quote.lines) {
    const mode = line.course_equipment_mode || line.mode
      || (line.all_day ? 'all_day' : 'during_course');
    const offeringKey = String(line.offering_key || '').trim();
    if (!offeringKey) throw new TypeError('course equipment line missing offering_key');
    const during = Number(
      line.during_course_price_cents != null
        ? line.during_course_price_cents
        : (line.metadata && line.metadata.during_course_price_cents),
    );
    const allDayPrice = Number(
      line.all_day_price_cents != null
        ? line.all_day_price_cents
        : (line.metadata && line.metadata.all_day_price_cents),
    );
    const unit = Number(line.unit_amount_cents != null ? line.unit_amount_cents : line.amount_cents);
    const lineTotal = Number(line.total_cents);
    // Per-date amount = unit × quantity (quote total already multiplies by date_count).
    if (!Number.isSafeInteger(unit) || unit < 0) throw new TypeError('course equipment line money invalid');
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
      throw new TypeError('course equipment line quantity invalid');
    }
    const dateTotal = unit * line.quantity;
    if (!Number.isSafeInteger(dateTotal) || dateTotal < 0) {
      throw new TypeError('course equipment line money invalid');
    }
    if (!Number.isSafeInteger(during) || during < 0
      || !Number.isSafeInteger(allDayPrice) || allDayPrice < 0
      || !Number.isSafeInteger(lineTotal) || lineTotal < 0) {
      throw new TypeError('course equipment line money invalid');
    }
    const expectedDates = line.date_count || bookingDates.length;
    if (dateTotal * expectedDates !== lineTotal) {
      throw new TypeError('course equipment date expansion mismatch');
    }
    const serviceDates = (line.service_dates && line.service_dates.length)
      ? line.service_dates
      : bookingDates;
    for (const serviceDate of serviceDates) {
      const metadata = {
        source: opts.attribution.metadataSource,
        staff_manual_schedule: opts.attribution.staffManualSchedule,
        course_equipment: true,
        offering_key: offeringKey,
        label: String(line.label || offeringKey),
        course_equipment_mode: mode,
        component: 'course_equipment',
        staff_ui_service_type: 'course_equipment',
        price_basis: 'per_person_per_course_date',
        billing_unit: 'person_per_course_date',
        pricing_provenance: 'course_owned_equipment',
        price_source: 'course_owned_equipment',
        during_course_price_cents: during,
        all_day_price_cents: allDayPrice,
        unit_amount_cents: unit,
        amount_cents: dateTotal,
        service_date: serviceDate,
        course_id: courseId,
        location_id: opts.locationId || null,
        bundle_id: opts.bundleId || null,
      };
      const row = await insertServiceRecord(pg, [
        opts.clientSlug, opts.bookingId, opts.bookingCode, opts.guestName,
        'addon_service', serviceDate, line.quantity,
        opts.srPayment, opts.attribution.dbSource, JSON.stringify(metadata),
      ]);
      const id = row && (row.service_record_id || row.id);
      if (id) {
        await pg.query(
          'UPDATE booking_service_records SET amount_due_cents = $1 WHERE id = $2::uuid AND client_slug = $3',
          [dateTotal, id, opts.clientSlug],
        );
      }
      rows.push({ ...row, metadata, amount_due_cents: dateTotal, service_type: 'addon_service' });
    }
  }
  return rows;
}

/**
 * Persist staff Accommodation as one dedicated auditable service row.
 * Column source stays staff_manual (CHECK); metadata.source = staff_accommodation.
 * Snapshots nightly/seasonal breakdown so later Admin price edits do not rewrite history.
 */
async function insertStaffAccommodationServiceRow(pg, opts) {
  const priced = opts && opts.priced;
  if (!priced || !priced.ok) return null;
  const {
    clientSlug, bookingId, bookingCode, guestName, serviceDate, srPayment,
    attribution, locationId, componentKeys, bundleId, notes, needsReply, metaBase,
    clientStayId,
  } = opts;
  const stayId = clientStayId != null && String(clientStayId).trim()
    ? String(clientStayId).trim().slice(0, 64)
    : (priced.client_stay_id ? String(priced.client_stay_id).trim().slice(0, 64) : null);
  const metadata = {
    source: STAFF_ACCOMMODATION_SOURCE,
    staff_accommodation: true,
    staff_manual_schedule: attribution && attribution.staffManualSchedule,
    staff_ui_service_type: STAFF_ACCOMMODATION_COMPONENT,
    component: STAFF_ACCOMMODATION_COMPONENT,
    client_stay_id: stayId || null,
    check_in: priced.check_in,
    check_out: priced.check_out,
    nights: priced.nights,
    occupied_nights: priced.occupied_nights || [],
    nightly_breakdown: priced.nightly_breakdown || [],
    season_groups: priced.season_groups || [],
    total_cents: priced.total_cents,
    amount_cents: priced.total_cents,
    currency: priced.currency || 'EUR',
    unit_quantity: 1,
    components: componentKeys || [],
    bundle_id: bundleId || null,
    notes: notes || null,
    needs_reply: !!needsReply,
    location_id: locationId || null,
    ...(metaBase || {}),
  };
  const dueStore = priced.total_cents;
  const row = await insertServiceRecord(pg, [
    clientSlug, bookingId, bookingCode, guestName,
    'addon_service', serviceDate || priced.check_in, 1,
    srPayment, attribution.dbSource, JSON.stringify(metadata),
  ]);
  if (row && (row.service_record_id || row.id)) {
    await pg.query(
      // MULTICLIENT_SCOPE_OK: same-txn seed
      'UPDATE booking_service_records SET amount_due_cents = $1 WHERE id = $2::uuid AND client_slug = $3',
      [dueStore, row.service_record_id || row.id, clientSlug],
    );
  }
  return { ...row, metadata, amount_due_cents: dueStore };
}

/**
 * Persist staff custom commercial lines as dedicated auditable service rows.
 * Column source stays staff_manual (CHECK); metadata.source = staff_custom_line.
 * amount_due_cents stays non-negative (CHECK); signed amount lives in metadata.amount_cents.
 */
async function insertStaffCustomLineServiceRows(pg, opts) {
  const lines = Array.isArray(opts.customLineItems) ? opts.customLineItems : [];
  if (!lines.length) return [];
  const {
    clientSlug, bookingId, bookingCode, guestName, serviceDate, srPayment,
    attribution, locationId, componentKeys, bundleId, notes, needsReply, metaBase,
  } = opts;
  const created = [];
  const base = metaBase || {};
  for (const line of lines) {
    const metadata = {
      source: STAFF_CUSTOM_LINE_SOURCE,
      staff_custom_line: true,
      staff_manual_schedule: attribution && attribution.staffManualSchedule,
      staff_ui_service_type: STAFF_CUSTOM_LINE_COMPONENT,
      component: STAFF_CUSTOM_LINE_COMPONENT,
      client_line_id: line.client_line_id,
      label: line.label,
      amount_cents: line.amount_cents,
      components: componentKeys || [],
      bundle_id: bundleId || null,
      notes: notes || null,
      needs_reply: !!needsReply,
      location_id: locationId || null,
      ...base,
    };
    // CHECK amount_due_cents >= 0 — store max(0, cents); signed value is metadata.amount_cents.
    const dueStore = line.amount_cents < 0 ? 0 : line.amount_cents;
    const row = await insertServiceRecord(pg, [
      clientSlug, bookingId, bookingCode, guestName,
      'addon_service', serviceDate, 1,
      srPayment, attribution.dbSource, JSON.stringify(metadata),
    ]);
    // Seed amount before authoritative claim (claim overwrites + re-writes metadata).
    if (row && (row.service_record_id || row.id)) {
      await pg.query(
        // MULTICLIENT_SCOPE_OK: same-txn seed
        'UPDATE booking_service_records SET amount_due_cents = $1 WHERE id = $2::uuid AND client_slug = $3',
        [dueStore, row.service_record_id || row.id, clientSlug],
      );
    }
    created.push({ ...row, metadata, amount_due_cents: dueStore });
  }
  return created;
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

  const locationId = opts.locationId != null ? String(opts.locationId).trim() : '';
  const attribution = resolveScheduleBookingAttribution(opts.actor);
  // Actor-gated Luna derivation must run before force/validation so Hermes
  // component-qty payloads (no top-level surfer_count) stay compatible.
  const lunaForceOpts = { actor: opts.actor || null };
  const requestedRentals = Array.isArray(opts.body && opts.body.rentals) ? opts.body.rentals : [];
  const genericPrep = await prepareGenericRentalsForCreate({
    clientSlug, locationId, pgClient: pg, rentals: requestedRentals,
    serviceDate: String(opts.body && opts.body.date_from || '').slice(0, 10), source: attribution.dbSource,
    calendarDayCount: inclusiveIsoDatesFromRange(opts.body && opts.body.date_from, opts.body && opts.body.date_to).length,
    bookingDurationKey: rentalDurationKeyFromDateRange(opts.body && opts.body.date_from, opts.body && opts.body.date_to),
  });
  if (!genericPrep.ok) {
    const badCatalogKey = genericPrep.reason === 'rental_offering_not_active'
      || genericPrep.reason === 'invalid_rental_offering';
    return {
      ok: false,
      status: badCatalogKey ? 400 : 409,
      body: { success: false, error: genericPrep.reason, reason_code: genericPrep.reason },
    };
  }
  const canonicalRequested = requestedRentals.filter((r) => CANONICAL_RENTAL_OFFERING_KEYS.includes(String(r && r.offering_key || '').trim()));
  const prepBody = genericPrep.genericRentals.length
    ? { ...opts.body, rentals: canonicalRequested, components: opts.body.components || {} }
    : opts.body;
  if (genericPrep.genericRentals.length && !canonicalRequested.length) delete prepBody.rentals;
  const rentalPrep = prepareCanonicalRentalsForCreate(prepBody, lunaForceOpts);
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

  // Staff Create: guest name + valid phone required. Luna create keeps phone optional.
  // Quote path never uses this function.
  const bodyForValidate = rentalPrep.body || {};
  const hasAccomWire = !!(bodyForValidate.accommodation
    && bodyForValidate.accommodation.enabled !== false
    && (
      bodyForValidate.accommodation.check_in
      || bodyForValidate.accommodation.check_out
      || (Array.isArray(bodyForValidate.accommodation.stays)
        && bodyForValidate.accommodation.stays.length > 0)
      || (Array.isArray(bodyForValidate.accommodation)
        && bodyForValidate.accommodation.length > 0)
    ));
  const validated = validateScheduleBookingBody(bodyForValidate, {
    requireGuestPhone: attribution.staffManualSchedule === true,
    actor: opts.actor || null,
    allowEmptyComponents: genericPrep.genericRentals.length > 0 || hasAccomWire,
  });
  if (!validated.ok) {
    return { ok: false, status: 400, body: { success: false, error: validated.error } };
  }
  const input = validated.value;
  const canonicalRentals = rentalPrep.present ? rentalPrep.rentals : null;
  const rentalSpanDates = rentalPrep.present ? rentalPrep.rentalSpanDates : null;
  const rentalPricingGroupId = rentalPrep.present ? rentalPrep.pricingGroupId : null;
  const allRequestedRentals = [
    ...(canonicalRentals || []),
    ...genericPrep.genericRentals,
  ];
  const intentFpOpts = {
    rentals: allRequestedRentals,
    custom_line_items: input.custom_line_items || [],
    accommodation: input.accommodation || null,
  };
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
    const plLoad = await loadPrivateLessonFromDb(pg, clientSlug, locationId);
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
  // Multi-lesson sets and multi selected_courses assign every distinct course_id.
  let assignedCourse = null;
  let assignedCoursesById = null;
  let coursePricePreflight = null;
  const {
    shouldPriceGroupLessonsIndividually,
    normalizeSelectedCourses,
  } = require('./sunset-schedule-lessons');
  const groupLessonsForAssign = Array.isArray(input.lessons)
    ? input.lessons.filter((l) => l && l.kind === 'group')
    : [];
  const selectedCoursesForAssign = input.components && input.components.course
    ? normalizeSelectedCourses(input.components.course)
    : [];
  const multiCourseAssign = (groupLessonsForAssign.length > 0
    && shouldPriceGroupLessonsIndividually(groupLessonsForAssign))
    || selectedCoursesForAssign.length > 1;

  if (multiCourseAssign || (input.components.course && groupLessonsForAssign.length > 1)
    || selectedCoursesForAssign.length > 1) {
    const { assertCourseAssignable } = require('./sunset-admin-course-join');
    const { packPriceItemCode } = require('./sunset-admin-price-identity');
    const { resolveActiveSunsetAdminPrice, staffFacingSunsetAdminPriceError } = require('./sunset-admin-price-resolve');
    assignedCoursesById = {};
    const surfers = input.surfer_count != null
      ? Math.max(1, Number(input.surfer_count) || 1)
      : Math.max(1, Number(input.components.course && input.components.course.quantity) || 1);

    // Product-button multi-course path (no Group lessons[]): each selected course
    // resolves independently against the booking span dates + its own tier.
    if (selectedCoursesForAssign.length > 1 && groupLessonsForAssign.length === 0) {
      const spanDates = Array.isArray(input.service_dates) && input.service_dates.length
        ? input.service_dates.map((d) => String(d).slice(0, 10)).filter(Boolean)
        : [];
      for (const sc of selectedCoursesForAssign) {
        const courseId = String(sc.course_id || '').trim();
        if (!courseId) continue;
        const tierKey = String(sc.tier_key || '').trim();
        if (!tierKey) {
          return {
            ok: false,
            status: 400,
            body: {
              success: false,
              error: 'components.course.selected_courses.tier_key is required',
              reason_code: 'course_tier_required',
              course_id: courseId,
            },
          };
        }
        const gate = await assertCourseAssignable(pg, {
          clientSlug,
          locationId,
          courseId,
          serviceDates: spanDates,
          quantity: surfers,
        });
        if (!gate.ok) return gate;
        assignedCoursesById[courseId] = gate;
        if (!assignedCourse) assignedCourse = gate;
        sc.offering_id = packPriceItemCode(courseId, tierKey);
        const packTiers = ((gate.pack && gate.pack.price_tiers) || [])
          .map((t) => String((t && t.key) || '').trim())
          .filter(Boolean);
        if (packTiers.length && !packTiers.includes(tierKey)) {
          return {
            ok: false,
            status: 400,
            body: {
              success: false,
              error: 'Select a course duration that belongs to the selected course.',
              reason_code: 'course_tier_mismatch',
              course_id: courseId,
              tier_key: tierKey,
            },
          };
        }
        const lookupArgs = {
          clientSlug,
          locationId,
          quantity: surfers,
          metadata: {
            component: 'course',
            staff_ui_service_type: 'course',
            course_id: courseId,
            tier_key: tierKey,
            offering_id: packPriceItemCode(courseId, tierKey),
            location_id: locationId,
          },
          pgClient: pg,
        };
        let pre = await resolveActiveSunsetAdminPrice(pg, lookupArgs);
        if (!pre || pre.ok !== true) {
          try {
            const { syncPackTierToPriceRules } = require('./sunset-admin-price-sync');
            const pack = gate.pack || {};
            await syncPackTierToPriceRules(pg, {
              clientSlug,
              locationId,
              packId: pack.pack_id || courseId,
              packLabel: pack.label || 'Course',
              tiers: pack.price_tiers || [],
              actor: opts.actor || {},
              skipTransaction: true,
            });
            pre = await resolveActiveSunsetAdminPrice(pg, lookupArgs);
          } catch (_) { /* keep original */ }
        }
        if (!pre || pre.ok !== true || !(pre.amount_cents > 0)) {
          const faced = staffFacingSunsetAdminPriceError(
            (pre && pre.reason) || 'no_price_for_surf_lesson',
            pre && pre.identity,
          );
          return {
            ok: false,
            status: 422,
            body: {
              success: false,
              error: faced.error,
              reason_code: faced.reason_code,
              detail: (pre && pre.reason) || 'price_not_configured',
              course_id: courseId,
              tier_key: tierKey,
            },
          };
        }
        coursePricePreflight = pre;
      }
      if (input.components.course && assignedCourse) {
        if (!input.components.course.course_label
          || input.components.course.course_label === input.components.course.course_id) {
          input.components.course.course_label = assignedCourse.course_label
            || input.components.course.course_label;
        }
        if (selectedCoursesForAssign[0]) {
          input.components.course.course_id = selectedCoursesForAssign[0].course_id;
          input.components.course.tier_key = selectedCoursesForAssign[0].tier_key;
          input.components.course.offering_id = packPriceItemCode(
            selectedCoursesForAssign[0].course_id,
            selectedCoursesForAssign[0].tier_key,
          );
          input.components.course.selected_courses = selectedCoursesForAssign;
        }
      }
    } else {
    const byCourse = new Map();
    for (const lesson of groupLessonsForAssign) {
      const cid = String(lesson.course_id || '').trim();
      if (!cid) continue;
      if (!byCourse.has(cid)) byCourse.set(cid, []);
      byCourse.get(cid).push(lesson);
    }
    for (const [courseId, lessonsForCourse] of byCourse.entries()) {
      const dates = [...new Set(lessonsForCourse.map((l) => String(l.date).slice(0, 10)))].sort();
      const gate = await assertCourseAssignable(pg, {
        clientSlug,
        locationId,
        courseId,
        serviceDates: dates,
        quantity: surfers,
      });
      if (!gate.ok) return gate;
      assignedCoursesById[courseId] = gate;
      if (!assignedCourse) assignedCourse = gate;
      // Stamp each lesson's tier (default 1_day for multi same-day / multi-course).
      for (const lesson of lessonsForCourse) {
        if (!lesson.tier_key) lesson.tier_key = '1_day';
        lesson.offering_id = packPriceItemCode(courseId, lesson.tier_key);
      }
      const tierKey = String(lessonsForCourse[0].tier_key || '1_day').trim() || '1_day';
      const packTiers = ((gate.pack && gate.pack.price_tiers) || [])
        .map((t) => String((t && t.key) || '').trim())
        .filter(Boolean);
      // Per-lesson multi path always needs the resolved tier (usually 1_day).
      const tiersNeeded = [...new Set(lessonsForCourse.map((l) => String(l.tier_key || '1_day').trim() || '1_day'))];
      for (const tk of tiersNeeded) {
        if (packTiers.length && !packTiers.includes(tk)) {
          return {
            ok: false,
            status: 400,
            body: {
              success: false,
              error: 'Select a course duration that belongs to the selected course.',
              reason_code: 'course_tier_mismatch',
              course_id: courseId,
              tier_key: tk,
            },
          };
        }
        const lookupArgs = {
          clientSlug,
          locationId,
          quantity: surfers,
          metadata: {
            component: 'course',
            staff_ui_service_type: 'course',
            course_id: courseId,
            tier_key: tk,
            offering_id: packPriceItemCode(courseId, tk),
            location_id: locationId,
          },
          pgClient: pg,
        };
        let pre = await resolveActiveSunsetAdminPrice(pg, lookupArgs);
        if (!pre || pre.ok !== true) {
          try {
            const { syncPackTierToPriceRules } = require('./sunset-admin-price-sync');
            const pack = gate.pack || {};
            await syncPackTierToPriceRules(pg, {
              clientSlug,
              locationId,
              packId: pack.pack_id || courseId,
              packLabel: pack.label || 'Course',
              tiers: pack.price_tiers || [],
              actor: opts.actor || {},
              skipTransaction: true,
            });
            pre = await resolveActiveSunsetAdminPrice(pg, lookupArgs);
          } catch (_) { /* keep original */ }
        }
        if (!pre || pre.ok !== true || !(pre.amount_cents > 0)) {
          const faced = staffFacingSunsetAdminPriceError(
            (pre && pre.reason) || 'no_price_for_surf_lesson',
            pre && pre.identity,
          );
          return {
            ok: false,
            status: 422,
            body: {
              success: false,
              error: faced.error,
              reason_code: faced.reason_code,
              detail: (pre && pre.reason) || 'price_not_configured',
              course_id: courseId,
              tier_key: tk,
            },
          };
        }
        coursePricePreflight = pre;
      }
      void tierKey;
    }
    // Seed components.course from primary for legacy fields when multi.
    if (input.components.course && assignedCourse) {
      if (!input.components.course.course_label
        || input.components.course.course_label === input.components.course.course_id) {
        input.components.course.course_label = assignedCourse.course_label
          || input.components.course.course_label;
      }
      if (!input.components.course.tier_key) {
        input.components.course.tier_key = '1_day';
      }
      input.components.course.offering_id = packPriceItemCode(
        input.components.course.course_id,
        input.components.course.tier_key,
      );
    }
    } // end lessons[] multi-course branch
  } else if (input.components.course) {
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

    // Authoritative Admin quote for Create (course / private / rental).
    // Prefer validated input (canonical lessons[]) over raw rental prep body.
    let authoritativeQuote = null;
    {
      const quoteTransport = {
        ...(rentalPrep.body && typeof rentalPrep.body === 'object' ? rentalPrep.body : {}),
        guest_name: input.guest_name,
        guest_phone: input.guest_phone,
        date_from: input.date_from || (input.service_dates && input.service_dates[0]),
        date_to: input.date_to
          || (input.service_dates && input.service_dates[input.service_dates.length - 1]),
        service_dates: input.service_dates,
        components: input.components,
        lessons: input.lessons || null,
        surfer_count: input.surfer_count,
        course_equipment: input.course_equipment,
        custom_line_items: input.custom_line_items || [],
        rentals: Array.isArray(rentalPrep.body && rentalPrep.body.rentals)
          ? rentalPrep.body.rentals
          : (input.rentals || undefined),
        payment_status: input.payment_status,
      };
      const resolved = await resolveAuthoritativeScheduleQuoteInTxn(pg, {
        clientSlug,
        locationId,
        canonicalRentals,
        genericRentalRecords: genericPrep.records,
        rentalPrepBody: quoteTransport,
        quotePrepBody: quoteTransport,
        rentalPricingDescriptor,
        quoteChannel: opts.quoteChannel,
        quoteProvenance: opts.quoteProvenance,
        now: opts.now,
      });
      authoritativeQuote = resolved.authoritativeQuote;
      if (resolved.rentalPricingDescriptor) {
        rentalPricingDescriptor = resolved.rentalPricingDescriptor;
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
          rentals: allRequestedRentals.length ? allRequestedRentals : null,
          custom_line_items: input.custom_line_items || [],
          lessons: Array.isArray(input.lessons) ? input.lessons : null,
          selected_courses: input.components && input.components.course
            && Array.isArray(input.components.course.selected_courses)
            ? input.components.course.selected_courses
            : null,
          idempotency_key: input.idempotency_key || null,
          idempotency_intent_fp: idempotencyIntentFp || null,
        }),
      ],
    );
    const bookingId = bookingIns.rows[0].id;
    const createdRows = await insertScheduleComponentServiceRows(pg, {
      clientSlug, bookingId, bookingCode, input, componentKeys, attribution,
      locationId, srPayment, privateLessonConfig, assignedCourse, assignedCoursesById,
      canonicalRentals,
      rentalSpanDates, rentalPricingGroupId, rentalPricingDescriptor,
      authoritativeQuote, bundleId,
      metaBase: {
        actor_source: attribution.actorSource || null,
        guest_phone: input.guest_phone,
        created_by_staff: attribution.createdByStaff,
        idempotency_key: input.idempotency_key,
        idempotency_intent_fp: idempotencyIntentFp || null,
      },
    });

    for (const descriptor of genericPrep.records) {
      const meta = {
        ...descriptor.metadata,
        source: attribution.metadataSource,
        bundle_id: bundleId,
        idempotency_key: input.idempotency_key || null,
        idempotency_intent_fp: idempotencyIntentFp || null,
      };
      const ins = await pg.query(
        `INSERT INTO booking_service_records
           (client_slug, booking_id, booking_code, guest_name, service_type, service_date,
            quantity, status, amount_due_cents, amount_paid_cents, payment_status, source, metadata)
         VALUES ($1, $2::uuid, $3, $4, $5, $6::date, $7, 'confirmed', $8, 0, $9, $10, $11::jsonb)
         RETURNING id::text AS service_record_id, booking_id::text AS booking_id, booking_code,
           guest_name, service_type::text AS service_type, service_date::text AS service_date,
           quantity, amount_due_cents, amount_paid_cents, payment_status::text AS payment_status,
           source AS record_source, metadata,
           metadata->>'offering_key' AS offering_key,
           metadata->>'staff_ui_service_type' AS staff_ui_service_type`,
        [clientSlug, bookingId, bookingCode, input.guest_name, descriptor.service_type,
          descriptor.service_date, descriptor.quantity, descriptor.amount_due_cents, srPayment,
          attribution.dbSource, JSON.stringify(meta)],
      );
      createdRows.push(ins.rows[0]);
    }

    if (isPresentCourseEquipmentSelection(input.course_equipment)) {
      const { listRentalOfferings } = require('./tenant-rental-offerings');
      const rentalOfferings = await listRentalOfferings(pg, {
        clientSlug, locationId, includeInactive: false,
      });
      const groupLessonsCE = Array.isArray(input.lessons)
        ? input.lessons.filter((l) => l && l.kind === 'group')
        : [];
      const { uniqueCalendarDates, normalizeSelectedCourses } = require('./sunset-schedule-lessons');
      const selectedCoursesCE = input.components && input.components.course
        ? normalizeSelectedCourses(input.components.course)
        : [];
      let equipmentCourses = null;
      let equipmentCourse = null;
      let equipmentSurfers = null;
      let equipmentDates = null;
      if (input.components.private_lesson) {
        equipmentCourse = privateLessonConfig;
        equipmentSurfers = input.components.private_lesson.surfer_count;
        equipmentDates = (input.components.private_lesson.sessions || []).map((s) => s.date);
      } else if (groupLessonsCE.length || selectedCoursesCE.length > 1) {
        const courseIds = groupLessonsCE.length
          ? [...new Set(groupLessonsCE.map((l) => String(l.course_id).trim()).filter(Boolean))]
          : selectedCoursesCE.map((sc) => String(sc.course_id).trim()).filter(Boolean);
        equipmentCourses = courseIds.map((cid) => {
          const assigned = (assignedCoursesById && assignedCoursesById[cid])
            || (assignedCourse && String(assignedCourse.course_id || '') === cid ? assignedCourse : null);
          return assigned && assigned.pack
            ? { ...assigned.pack, course_id: cid, pack_id: assigned.pack.pack_id || cid }
            : null;
        }).filter(Boolean);
        if (equipmentCourses.length !== courseIds.length) {
          // Fall back to primary pack only when single course; multi missing pack fails closed.
          if (courseIds.length === 1 && assignedCourse && assignedCourse.pack) {
            equipmentCourses = [{
              ...assignedCourse.pack,
              course_id: courseIds[0],
              pack_id: assignedCourse.pack.pack_id || courseIds[0],
            }];
          } else {
            throw Object.assign(new Error('course equipment requires pack config for every selected course'), {
              sunsetPriceFail: {
                ok: false,
                status: 422,
                body: {
                  success: false,
                  reason: 'course_equipment_not_authorized_for_all_courses',
                  reason_code: 'course_equipment_not_authorized_for_all_courses',
                  error: 'course equipment requires pack config for every selected course',
                },
              },
            });
          }
        }
        equipmentSurfers = input.surfer_count != null
          ? input.surfer_count
          : (input.components.course && input.components.course.quantity);
        equipmentDates = groupLessonsCE.length
          ? uniqueCalendarDates(groupLessonsCE)
          : input.service_dates;
        equipmentCourse = equipmentCourses[0];
      } else {
        equipmentCourse = assignedCourse && assignedCourse.pack;
        equipmentSurfers = input.components.course && input.components.course.quantity;
        equipmentDates = input.service_dates;
      }
      const equipmentRows = await insertCourseEquipmentRows(pg, {
        clientSlug, bookingId, bookingCode, guestName: input.guest_name,
        selection: input.course_equipment,
        surfers: equipmentSurfers,
        bookingDates: equipmentDates,
        course: equipmentCourse,
        courses: equipmentCourses,
        offerings: rentalOfferings,
        attribution, locationId, bundleId, srPayment,
      });
      equipmentRows.forEach((r) => createdRows.push(r));
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

    // Staff custom commercial adjustments — dedicated auditable rows (not Admin catalog).
    if (input.custom_line_items && input.custom_line_items.length) {
      const customRows = await insertStaffCustomLineServiceRows(pg, {
        clientSlug,
        bookingId,
        bookingCode,
        guestName: input.guest_name,
        serviceDate: firstDate,
        srPayment,
        attribution,
        locationId,
        componentKeys,
        bundleId,
        notes: input.notes || null,
        needsReply: input.needs_reply,
        customLineItems: input.custom_line_items,
        metaBase: {
          actor_source: attribution.actorSource || null,
          guest_phone: input.guest_phone,
          created_by_staff: attribution.createdByStaff,
          idempotency_key: input.idempotency_key,
          idempotency_intent_fp: idempotencyIntentFp || null,
        },
      });
      customRows.forEach((r) => createdRows.push(r));
    }

    // Staff Accommodation — one dedicated service row per stay; server-priced snapshot.
    if (input.accommodation && input.accommodation.enabled) {
      const { resolveAccommodationPrice } = require('./sunset-accommodation-admin');
      const {
        accommodationStaysFromSelection,
      } = require('./sunset-accommodation-price-resolver');
      const accomStays = accommodationStaysFromSelection(input.accommodation);
      for (const stay of accomStays) {
        const accomRes = await resolveAccommodationPrice(pg, {
          clientSlug,
          locationId,
          checkIn: stay.check_in,
          checkOut: stay.check_out,
          requireEnabled: true,
        });
        if (!accomRes.ok) {
          throw Object.assign(new Error(accomRes.error || 'accommodation_price_failed'), {
            sunsetPriceFail: {
              ok: false,
              status: accomRes.status || 422,
              body: accomRes.body || {
                success: false,
                error: accomRes.error,
                reason_code: accomRes.reason_code,
                uncovered_nights: accomRes.uncovered_nights || null,
                overlap: accomRes.overlap || null,
              },
            },
          });
        }
        const accomRow = await insertStaffAccommodationServiceRow(pg, {
          clientSlug,
          bookingId,
          bookingCode,
          guestName: input.guest_name,
          serviceDate: stay.check_in || firstDate,
          srPayment,
          attribution,
          locationId,
          componentKeys,
          bundleId,
          notes: input.notes || null,
          needsReply: input.needs_reply,
          priced: accomRes.priced,
          clientStayId: stay.client_stay_id || null,
          metaBase: {
            actor_source: attribution.actorSource || null,
            guest_phone: input.guest_phone,
            created_by_staff: attribution.createdByStaff,
            idempotency_key: input.idempotency_key,
            idempotency_intent_fp: idempotencyIntentFp || null,
          },
        });
        if (accomRow) createdRows.push(accomRow);
      }
    }

    const quoteTransportBody = {
      ...(rentalPrep.body && typeof rentalPrep.body === 'object' ? rentalPrep.body : {}),
      custom_line_items: input.custom_line_items || [],
      accommodation: input.accommodation || null,
    };

    const priced = await applyAuthoritativeSchedulePricingInTxn(pg, {
      clientSlug,
      bookingId,
      clientId,
      createdRows,
      locationId,
      canonicalRentals,
      genericRentalRecords: genericPrep.records,
      rentalPrepBody: quoteTransportBody,
      quotePrepBody: quoteTransportBody,
      rentalPricingDescriptor,
      authoritativeQuote,
      quoteChannel: opts.quoteChannel,
      quoteProvenance: opts.quoteProvenance,
      now: opts.now,
    });
    authoritativeQuote = priced.authoritativeQuote || authoritativeQuote;
    if (priced.rentalPricingDescriptor) {
      rentalPricingDescriptor = priced.rentalPricingDescriptor;
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
  prepareGenericRentalsForCreate,
  buildGenericRentalAuthoritativeQuote,
  prepareCanonicalRentalsForCreate,
  rentalDurationKeyFromDateRange,
  inclusiveIsoDatesFromRange,
  applyAuthoritativeQuoteAmounts,
  resolveAuthoritativeScheduleQuoteInTxn,
  applyAuthoritativeSchedulePricingInTxn,
  insertScheduleComponentServiceRows,
  insertCourseEquipmentRows,
  insertStaffCustomLineServiceRows,
  insertStaffAccommodationServiceRow,
  lockSchedulePaymentsForUpdate,
  applyEditPaidAmountInTxn,
  paidBookingRepriceRequiredResult,
  PAID_BOOKING_REPRICE_REQUIRED,
  buildSchedulePricingIntent,
  schedulePricingIntentsEqual,
  isSunsetBookingFinanciallyCommitted,
  findIdempotentBooking,
  buildScheduleBookingIntentFingerprint,
  evaluateIdempotentReplay,
  scheduleBookingIdempotencyAdvisoryKeys,
  STAFF_CUSTOM_LINE_SOURCE,
  STAFF_CUSTOM_LINE_COMPONENT,
  STAFF_CUSTOM_LINE_MAX,
  STAFF_CUSTOM_LINE_LABEL_MAX,
  STAFF_ACCOMMODATION_SOURCE,
  STAFF_ACCOMMODATION_COMPONENT,
  parseLocaleMoneyToCents,
  normalizeCustomLineItems,
  buildCustomLineQuoteLines,
  customLinesForIntentFingerprint,
  normalizeAccommodationSelection,
  accommodationForIntentFingerprint,
  isStaffAccommodationMeta,
  buildAccommodationQuoteLine,
  formatAccommodationBookingCard,
  isValidStaffCreateGuestPhone,
  isNoLessonComponents,
  hasNoLessonEquipment,
  parseAuthoritativeSurferCount,
  deriveCanonicalNoLessonSurferCountFromEquipment,
  collectNoLessonEquipmentQuantitySignals,
  applyNoLessonEquipmentQtyFromSurfers,
  NO_LESSON_EQUIPMENT_SURFER_REQUIRED,
  NO_LESSON_EQUIPMENT_QTY_INCONSISTENT,
  rowMatchesQuoteLine,
  checkedMoneyInteger,
  checkedMoneyAdd,
  checkedMoneySubtract,
};
