'use strict';

/**
 * Sunset Schedule — booking drawer context, payment summary, and updates.
 * Sunset client only. Prefer persisted amount_due_cents (including explicit 0 for
 * zeroed bundle peers / course companions). Live Admin fallback only when the
 * amount was never stored (null/undefined).
 */

const crypto = require('crypto');
const {
  normalizeSunsetLocationId,
  resolveRecordLocationId,
  attachLocationToMetadata,
} = require('./sunset-school-locations');
const {
  resolveRentalOfferingFriendlyLabel,
  buildRentalCatalogLabelMap,
  enrichServiceRecordsWithCatalogLabels,
} = require('./rental-offering-label');
const { resolveItemDisplayName } = require('./item-display-name');

const { resolveTenantBusinessConfigAsync, resolveTenantBusinessConfig } = require('./tenant-business-config');
const {
  SUNSET_CLIENT_SLUG,
  METADATA_SOURCE_TAG,
  DB_SOURCE,
  LUNA_DB_SOURCE,
  LUNA_METADATA_SOURCE_TAG,
  isLunaTrustedActor,
  UI_TO_DB_SERVICE_TYPE,
  DB_TO_UI_SERVICE_TYPE,
  UI_TO_SR_PAYMENT,
  UI_TO_BOOKING_PAYMENT,
  FULL_DAY_EQUIPMENT_ADDON_KEY,
  DEFAULT_LESSON_CATEGORY,
  STAFF_CUSTOM_LINE_SOURCE,
  STAFF_CUSTOM_LINE_COMPONENT,
  STAFF_ACCOMMODATION_SOURCE,
  STAFF_ACCOMMODATION_COMPONENT,
  validateScheduleBookingBody,
  bookingStatusFromPayment,
  componentList,
  resolveFullDayEquipmentAddonUnitCents,
  insertFullDayEquipmentAddonRows,
  insertStaffCustomLineServiceRows,
  insertStaffAccommodationServiceRow,
  prepareCanonicalRentalsForCreate,
  prepareGenericRentalsForCreate,
  rentalDurationKeyFromDateRange,
  inclusiveIsoDatesFromRange,
  buildSchedulePricingIntent,
  schedulePricingIntentsEqual,
  isSunsetBookingFinanciallyCommitted,
  applyAuthoritativeSchedulePricingInTxn,
  insertScheduleComponentServiceRows,
  insertCourseEquipmentRows,
  lockSchedulePaymentsForUpdate,
  applyEditPaidAmountInTxn,
  paidBookingRepriceRequiredResult,
  PAID_BOOKING_REPRICE_REQUIRED,
  buildRentalPricingDescriptor,
  CANONICAL_RENTAL_OFFERING_KEYS,
  isExactOfferingFutureWriteKey,
} = require('./sunset-schedule-booking-writes');

const {
  serviceRecordUnitPriceCents,
  isBundleRentalServiceRow,
  parseRentalPricingMeta,
} = require('./sunset-stripe-payment-links');
const { reconcilePendingStripePaymentsForBooking } = require('./stripe-payment-reconcile');

const { loadPrivateLessonFromDb, defaultPrivateLessonApi } = require('./sunset-admin-private-lesson-rules');

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || '').trim());
}

function parseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

/**
 * Honest guest phone for drawer display / conversation gating.
 * Staff API fields only — never invent. Synthetic staff:booking:… identities
 * are not guest phones (create-conversation may use them internally).
 */
function normalizeDrawerGuestPhone(raw) {
  const p = raw != null ? String(raw).trim() : '';
  if (!p) return null;
  if (p.indexOf('staff:') === 0) return null;
  return p;
}

function resolveDrawerGuestPhoneFromBundle(bundle) {
  if (!bundle || !bundle.booking) return null;
  const booking = bundle.booking;
  const bookingMeta = parseMeta(booking.metadata);
  const fromBooking = normalizeDrawerGuestPhone(
    booking.phone || booking.guest_phone || bookingMeta.guest_phone || bookingMeta.phone,
  );
  if (fromBooking) return fromBooking;
  const services = Array.isArray(bundle.services) ? bundle.services : [];
  for (let i = 0; i < services.length; i += 1) {
    const srMeta = parseMeta(services[i] && services[i].metadata);
    const fromSr = normalizeDrawerGuestPhone(srMeta.guest_phone || srMeta.phone);
    if (fromSr) return fromSr;
  }
  return null;
}

function normalizeUiPayment(ps) {
  const p = String(ps || '').toLowerCase();
  if (p === 'paid' || p === 'complete' || p === 'completed') return 'paid';
  return 'unpaid';
}

// Safe allowlist of paid-method labels stored in booking metadata (does not affect payment math).
const PAYMENT_METHOD_VALUES = new Set(['bank_transfer', 'in_store', 'link']);
function normalizePaymentMethod(m) {
  const v = String(m || '').toLowerCase().trim();
  return PAYMENT_METHOD_VALUES.has(v) ? v : null;
}

function staffUiServiceType(componentKey) {
  if (componentKey === 'lesson') return 'lesson';
  if (componentKey === 'course') return 'course';
  if (componentKey === 'private_lesson') return 'private_lesson';
  if (componentKey === 'surfboard') return 'board_rental';
  return 'wetsuit_rental';
}

function resolveGuestCount(components) {
  if (components.private_lesson) return components.private_lesson.surfer_count;
  if (components.lesson) return components.lesson.quantity;
  if (components.course) return components.course.quantity;
  const keys = componentList(components).filter((k) => k !== FULL_DAY_EQUIPMENT_ADDON_KEY);
  const counts = keys.map((k) => Number(components[k] && components[k].quantity)).filter((n) => Number.isFinite(n));
  return counts.length ? Math.max(...counts) : 1;
}

function bookingHeaderDates(input) {
  const dates = input.service_dates.slice();
  if (input.components.private_lesson) {
    input.components.private_lesson.sessions.forEach((s) => dates.push(s.date));
  }
  const sorted = [...new Set(dates)].sort();
  return { firstDate: sorted[0], lastDate: sorted[sorted.length - 1] };
}
function formatSunsetDrawerDailyItemLabel(dbType, qty, sr) {
  const metaEarly = parseMeta(sr && sr.metadata);
  if (metaEarly && (metaEarly.source === 'staff_custom_line' || metaEarly.staff_custom_line === true
    || metaEarly.component === 'staff_custom_line')) {
    const lab = String(metaEarly.label || '').trim();
    return lab || 'Custom line';
  }
  if (metaEarly && (metaEarly.source === STAFF_ACCOMMODATION_SOURCE || metaEarly.staff_accommodation === true
    || metaEarly.component === STAFF_ACCOMMODATION_COMPONENT)) {
    const nights = Number(metaEarly.nights) || 0;
    const checkIn = String(metaEarly.check_in || '').slice(0, 10);
    const checkOut = String(metaEarly.check_out || '').slice(0, 10);
    if (checkIn && checkOut) {
      return nights
        ? `Accommodation · ${checkIn} → ${checkOut} · ${nights} night${nights === 1 ? '' : 's'}`
        : `Accommodation · ${checkIn} → ${checkOut}`;
    }
    return 'Accommodation';
  }
  const meta = parseMeta(sr && sr.metadata);
  const component = String(meta.component || sr?.metadata_component || '').toLowerCase();
  const serviceKey = String(meta.service_key || '').toLowerCase();
  const q = Number(qty) || 1;
  const sep = ' · ';
  if (meta.course_equipment === true) {
    const name = resolveItemDisplayName({ service_type: dbType, metadata: meta }, { metadata: meta })
      || resolveRentalOfferingFriendlyLabel(meta)
      || 'Equipment';
    const modeLabel = meta.course_equipment_mode === 'all_day' ? 'All Day' : 'During Course';
    return `${name}${sep}${modeLabel}${sep}${q}`;
  }
  if (dbType === 'addon_service' && (component === FULL_DAY_EQUIPMENT_ADDON_KEY || serviceKey === FULL_DAY_EQUIPMENT_ADDON_KEY)) {
    // Compact "Name · quantity" only. English default matches i18n key
    // schedule.type.fullDayEquipment; Spanish UI overlays via portal i18n ownership.
    return `Full-day gear${sep}${q}`;
  }
  // Generic Admin rental catalog rows (service_type addon_service): prefer the
  // shared item-display resolver (catalog → historical snapshot). Never surface
  // the coarse bucket name "addon_service" on the invoice.
  if (
    dbType === 'addon_service'
    || meta.rental_offering === true
    || meta.generic_rental === true
    || (meta.offering_key && (meta.duration_key || meta.item_code))
  ) {
    const adminName = resolveItemDisplayName({ service_type: dbType, metadata: meta }, { metadata: meta })
      || resolveRentalOfferingFriendlyLabel(meta);
    if (adminName && adminName.toLowerCase() !== 'addon_service') {
      return `${adminName}${sep}${q}`;
    }
  }
  if (component === 'course') {
    const name = meta.course_label || sr?.course_label;
    if (name) return `${name}${sep}${q}`;
    const map = DB_TO_UI_SERVICE_TYPE || {};
    return `${map[dbType] || dbType || 'Course'}${sep}${q}`;
  }
  if (component === 'private_lesson') {
    const name = meta.private_lesson_label || 'Private Course';
    return `${name}${sep}${q}`;
  }
  if (dbType === 'surfboard') return `Surfboard${sep}${q}`;
  if (dbType === 'wetsuit') return `Wetsuit${sep}${q}`;
  const map = DB_TO_UI_SERVICE_TYPE || {};
  const ui = map[dbType] || dbType;
  if (ui === 'lesson' || dbType === 'surf_lesson') {
    const name = meta.course_label || sr?.course_label || 'Group Course';
    return `${name}${sep}${q}`;
  }
  return `${ui || 'Item'}${sep}${q}`;
}

function lineItemLabel(dbType, qty, dateIso, slotTime, sr) {
  return formatSunsetDrawerDailyItemLabel(dbType, qty, sr);
}

async function loadSunsetBookingBundle(pg, clientSlug, bookingId, bookingCode, forUpdate = false, lockOpts = true) {
  // Lock modes:
  // - forUpdate false → no row locks
  // - forUpdate true + lockOpts true/false → booking FOR UPDATE (wait); services locked if lockOpts !== false
  // - lockOpts object: { bookingLock: 'none'|'wait'|'nowait', lockServices: boolean }
  let bookingLock = 'none';
  let lockServices = false;
  if (lockOpts && typeof lockOpts === 'object') {
    const mode = String(lockOpts.bookingLock || (forUpdate ? 'wait' : 'none')).toLowerCase();
    bookingLock = (mode === 'nowait' || mode === 'wait') ? mode : 'none';
    lockServices = !!lockOpts.lockServices && bookingLock !== 'none';
  } else if (forUpdate) {
    bookingLock = 'wait';
    lockServices = lockOpts !== false;
  }
  const bookingLockSql = bookingLock === 'nowait'
    ? '\n      FOR UPDATE OF b NOWAIT'
    : (bookingLock === 'wait' ? '\n      FOR UPDATE OF b' : '');

  const bookingRes = await pg.query(
    `SELECT b.id::text AS booking_id, b.booking_code, b.guest_name, b.phone,
            b.status::text AS status, b.payment_status::text AS payment_status,
            b.check_in::text AS check_in, b.check_out::text AS check_out,
            b.guest_count, b.total_amount_cents, b.amount_paid_cents, b.balance_due_cents,
            b.metadata
       FROM bookings b
       INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1
        AND ${bookingId ? 'b.id = $2::uuid' : 'b.booking_code = $2'}
      LIMIT 1${bookingLockSql}`,
    [clientSlug, bookingId || bookingCode],
  );
  const booking = bookingRes.rows[0];
  if (!booking) return null;
  const svcRes = await pg.query(
    `SELECT id::text AS service_record_id, service_type::text AS service_type,
            service_date::text AS service_date, quantity,
            amount_due_cents, amount_paid_cents, payment_status::text AS payment_status,
            metadata->>'slot_time' AS slot_time, metadata->>'notes' AS notes,
            metadata->>'staff_ui_service_type' AS staff_ui_service_type,
            metadata->>'component' AS metadata_component,
            metadata->>'components' AS metadata_components,
            metadata->>'location_id' AS location_id,
            metadata->>'source' AS metadata_source,
            metadata->>'staff_manual_schedule' AS staff_manual_schedule,
            metadata->>'course_id' AS course_id,
            metadata->>'course_label' AS course_label,
            service_time_local,
            service_time_local_end,
            metadata
       FROM booking_service_records
      WHERE client_slug = $1 AND booking_id = $2::uuid
      ORDER BY service_date, id${forUpdate && lockServices ? '\n      FOR UPDATE' : ''}`,
    [clientSlug, booking.booking_id],
  );
  const payRes = await pg.query(
    `SELECT p.id::text AS payment_id, p.status::text AS payment_status,
            p.amount_due_cents, p.amount_paid_cents, p.checkout_url, p.created_at
       FROM payments p
       INNER JOIN bookings b ON b.id = p.booking_id
       INNER JOIN clients c ON c.id = b.client_id
      WHERE p.booking_id = $1::uuid AND c.slug = $2
        AND p.checkout_url IS NOT NULL
      ORDER BY p.created_at DESC LIMIT 1`,
    [booking.booking_id, clientSlug],
  );
  const paidSumRes = await pg.query(
    `SELECT COALESCE(SUM(p.amount_paid_cents), 0)::int AS paid_total
       FROM payments p
       INNER JOIN bookings b ON b.id = p.booking_id
       INNER JOIN clients c ON c.id = b.client_id
      WHERE p.booking_id = $1::uuid AND c.slug = $2
        AND p.status = 'paid'::payment_record_status`,
    [booking.booking_id, clientSlug],
  );
  // Presentation-safe ledger rows: only successful paid payments (exclude unpaid/cancelled/expired/checkout).
  const paidRowsRes = await pg.query(
    `SELECT p.id::text AS payment_id, p.status::text AS payment_status,
            p.amount_paid_cents, p.paid_at, p.created_at, p.metadata
       FROM payments p
       INNER JOIN bookings b ON b.id = p.booking_id
       INNER JOIN clients c ON c.id = b.client_id
      WHERE p.booking_id = $1::uuid AND c.slug = $2
        AND p.status = 'paid'::payment_record_status
      ORDER BY COALESCE(p.paid_at, p.created_at) ASC, p.id ASC`,
    [booking.booking_id, clientSlug],
  );
  const payments_paid_cents = Number(paidSumRes.rows[0]?.paid_total || 0);
  return {
    booking,
    services: svcRes.rows,
    payment_link: payRes.rows[0] || null,
    payments_paid_cents,
    paid_payment_rows: paidRowsRes.rows || [],
  };
}

/**
 * Tenant-safe presentation ledger of successful payments only.
 * Returns positive amount_cents rows + remainder when detailed rows do not sum to aggregate paid.
 */
function buildPaidPaymentLedger(paidRows, paidCentsAggregate) {
  const rows = [];
  (Array.isArray(paidRows) ? paidRows : []).forEach((r) => {
    if (!r) return;
    const status = String(r.payment_status || r.status || '').toLowerCase();
    if (status !== 'paid') return;
    const amount = Math.round(Number(r.amount_paid_cents != null ? r.amount_paid_cents : r.amount_cents) || 0);
    if (!(amount > 0)) return;
    const meta = parseMeta(r.metadata);
    const methodRaw = String(
      meta.method || meta.payment_method || r.method || '',
    ).toLowerCase().trim();
    let method = methodRaw;
    if (method === 'cash' || method === 'staff_cash' || method === 'staff_in_store') method = 'in_store';
    if (method === 'staff_bank_transfer') method = 'bank_transfer';
    if (method === 'card' || method === 'stripe' || method === 'payment_link' || method === 'staff_link') method = 'link';
    if (!method) {
      const src = String(meta.source || '').toLowerCase();
      if (src.includes('bank')) method = 'bank_transfer';
      else if (src.includes('stripe') || src.includes('link') || src.includes('checkout')) method = 'link';
      else if (src.includes('cash') || src.includes('store') || src.includes('in_store')) method = 'in_store';
      else method = 'other';
    }
    const kind = (method === 'link') ? 'card' : 'manual';
    rows.push({
      payment_id: r.payment_id || r.id || null,
      amount_cents: amount,
      method,
      kind,
      paid_at: r.paid_at || null,
    });
  });
  let detailed_sum_cents = rows.reduce((s, row) => s + Number(row.amount_cents || 0), 0);
  const aggregate = Math.max(0, Math.round(Number(paidCentsAggregate) || 0));
  // Aggregate and detail are read independently. If detail exceeds aggregate,
  // its allocation cannot be trusted for presentation: fall back to one
  // aggregate credit rather than displaying more paid than the booking ledger.
  if (detailed_sum_cents > aggregate) {
    rows.length = 0;
    detailed_sum_cents = 0;
  }
  const remainder_cents = aggregate - detailed_sum_cents;
  return {
    rows,
    detailed_sum_cents,
    remainder_cents,
  };
}

function aggregateComponentsFromServices(services) {
  const components = {};
  let slotTime = null;
  const dates = new Set();
  const privateSessions = [];
  // Multi product-button Group: course count is row cardinality; selected_courses is
  // reconstructed from physical course service rows (never invent quantity from count).
  const selectedCourses = [];
  const selectedCourseSeen = new Set();
  (services || []).forEach((sr) => {
    const dbType = String(sr.service_type || '').toLowerCase();
    const meta = parseMeta(sr.metadata);
    const component = String(meta.component || sr.metadata_component || '').toLowerCase();
    const serviceKey = String(meta.service_key || '').toLowerCase();
    if (meta.course_equipment === true) {
      if (!Array.isArray(components.course_equipment)) components.course_equipment = [];
      const offeringKey = String(meta.offering_key || '').trim();
      const mode = meta.course_equipment_mode === 'all_day' ? 'all_day' : 'during_course';
      const quantity = Number(sr.quantity) || 1;
      if (offeringKey) {
        // Canonical multi-item identity: one entry per offering_key.
        if (!components.course_equipment.some((x) => x && x.offering_key === offeringKey)) {
          components.course_equipment.push({
            offering_key: offeringKey,
            mode,
            quantity,
            // Admin label + money snaps from create/edit service row metadata.
            label: meta.label != null ? String(meta.label) : undefined,
            unit_amount_cents: meta.unit_amount_cents != null ? Number(meta.unit_amount_cents) : undefined,
            amount_cents: meta.amount_cents != null ? Number(meta.amount_cents) : undefined,
            during_course_price_cents: meta.during_course_price_cents != null
              ? Number(meta.during_course_price_cents) : undefined,
            all_day_price_cents: meta.all_day_price_cents != null
              ? Number(meta.all_day_price_cents) : undefined,
            // Policy snap for drawer/invoice restore truth (selection provenance).
            during_course_policy: meta.during_course_policy != null
              ? String(meta.during_course_policy) : undefined,
          });
        }
      } else {
        // Narrow historical singleton (board/wetsuit) — displayable/removable only.
        components.course_equipment.push({
          offering_key: '',
          mode,
          quantity,
          label: meta.label
            || (component === 'surfboard' ? 'Surfboard'
              : component === 'wetsuit' ? 'Wetsuit' : 'Equipment'),
          historical: true,
          component: component || null,
        });
      }
      return;
    }
    // Full-day equipment add-on: per-date quantity map; its dates do NOT expand the booking date range.
    if (dbType === 'addon_service'
      && (component === FULL_DAY_EQUIPMENT_ADDON_KEY || serviceKey === FULL_DAY_EQUIPMENT_ADDON_KEY)) {
      if (!components[FULL_DAY_EQUIPMENT_ADDON_KEY]) {
        components[FULL_DAY_EQUIPMENT_ADDON_KEY] = { enabled: true, dates: {} };
      }
      const iso = String(sr.service_date || '').slice(0, 10);
      if (iso) components[FULL_DAY_EQUIPMENT_ADDON_KEY].dates[iso] = Number(sr.quantity) || 1;
      return;
    }
    // Custom lines + accommodation have dedicated intent fingerprints — never
    // invent components.staff_custom_line / staff_accommodation. Still record
    // service_date for drawer date_from/date_to seed (header display only).
    if (component === STAFF_CUSTOM_LINE_COMPONENT
      || meta.source === STAFF_CUSTOM_LINE_SOURCE
      || meta.staff_custom_line === true
      || component === STAFF_ACCOMMODATION_COMPONENT
      || meta.source === STAFF_ACCOMMODATION_SOURCE
      || meta.staff_accommodation === true) {
      const isoSkip = String(sr.service_date || '').slice(0, 10);
      if (isoSkip) dates.add(isoSkip);
      return;
    }
    dates.add(String(sr.service_date || '').slice(0, 10));
    const ui = sr.staff_ui_service_type || DB_TO_UI_SERVICE_TYPE[dbType] || component;
    if (component === 'private_lesson' || ui === 'private_lesson') {
      privateSessions.push({
        date: String(sr.service_date || '').slice(0, 10),
        start: sr.service_time_local || sr.slot_time || meta.slot_time || '10:00',
        end: sr.service_time_local_end || '',
      });
      if (!components.private_lesson) {
        components.private_lesson = {
          enabled: true,
          quantity: 0,
          surfer_count: Number(sr.quantity) || 1,
          sessions: [],
        };
      }
      components.private_lesson.quantity += 1;
      components.private_lesson.surfer_count = Number(sr.quantity) || components.private_lesson.surfer_count;
      return;
    }
    let key = ui === 'board_rental' ? 'surfboard'
      : (ui === 'wetsuit_rental' ? 'wetsuit' : (ui === 'course' || component === 'course' ? 'course' : ui));
    if (key === 'lesson' && (meta.course_id || sr.course_id)) key = 'course';
    if (!components[key]) {
      components[key] = {
        // Shared surfer count: max across rows (never sum course cardinality).
        quantity: Number(sr.quantity) || 1,
        slot_time: sr.slot_time || meta.slot_time || null,
      };
    } else if (Number(sr.quantity) > Number(components[key].quantity || 0)) {
      components[key].quantity = Number(sr.quantity) || components[key].quantity;
    }
    if (key === 'course') {
      const courseId = String(meta.course_id || sr.course_id || '').trim();
      const courseLabel = meta.course_label || sr.course_label || null;
      const tierKey = meta.tier_key ? String(meta.tier_key).trim() : '';
      const offeringId = meta.offering_id ? String(meta.offering_id).trim() : '';
      // Primary mirrors first selected course for single-course readers / legacy gates.
      if (!components[key].course_id && courseId) {
        components[key].course_id = courseId;
        if (courseLabel) components[key].course_label = courseLabel;
        if (tierKey) components[key].tier_key = tierKey;
        if (offeringId) components[key].offering_id = offeringId;
      } else if (!components[key].course_label && courseLabel) {
        components[key].course_label = courseLabel;
      }
      if (courseId && !selectedCourseSeen.has(courseId)) {
        selectedCourseSeen.add(courseId);
        const sc = { course_id: courseId };
        if (courseLabel) sc.course_label = String(courseLabel);
        if (tierKey) sc.tier_key = tierKey;
        if (offeringId) sc.offering_id = offeringId;
        selectedCourses.push(sc);
      }
    }
    if (key === 'lesson') {
      const slot = sr.slot_time || meta.slot_time || null;
      if (slot) components[key].slot_time = slot;
      const cat = meta.lesson_category || sr.lesson_category || null;
      components[key].category = String(cat || components[key].category || DEFAULT_LESSON_CATEGORY).trim()
        || DEFAULT_LESSON_CATEGORY;
      slotTime = components[key].slot_time || slotTime;
    }
  });
  if (components.private_lesson) {
    components.private_lesson.sessions = privateSessions.sort((a, b) => a.date.localeCompare(b.date));
    components.private_lesson.quantity = components.private_lesson.sessions.length || components.private_lesson.quantity;
  }
  if (components.course && selectedCourses.length) {
    components.course.selected_courses = selectedCourses;
    // Authoritative primary = first selected course (row order).
    const primary = selectedCourses[0];
    components.course.course_id = primary.course_id;
    if (primary.course_label) components.course.course_label = primary.course_label;
    if (primary.tier_key) components.course.tier_key = primary.tier_key;
    if (primary.offering_id) components.course.offering_id = primary.offering_id;
  }
  const sortedDates = [...dates].filter(Boolean).sort();
  return {
    components,
    date_from: sortedDates[0] || null,
    date_to: sortedDates[sortedDates.length - 1] || sortedDates[0] || null,
    slot_time: slotTime,
  };
}

function deriveDrawerPaymentUiStatus(booking, subtotalCents, paidCents) {
  const paid = Number(paidCents) || 0;
  const subtotal = Number(subtotalCents) || 0;
  if (paid > 0 && (subtotal === 0 || paid >= subtotal)) return 'paid';
  const raw = String(booking && booking.payment_status || '').toLowerCase();
  if (raw === 'paid' || raw === 'complete' || raw === 'completed') return 'paid';
  return 'unpaid';
}

/** Persisted due amount including explicit 0. null = never stored (live fallback eligible). */
function readPersistedServiceDueCents(sr) {
  if (!sr) return null;
  const meta = parseMeta(sr.metadata);
  // Staff custom commercial lines store signed amount in metadata (DB CHECK amount_due ≥ 0).
  if (meta && (meta.source === 'staff_custom_line' || meta.staff_custom_line === true
    || meta.component === 'staff_custom_line')
    && meta.amount_cents != null && meta.amount_cents !== '') {
    const signed = Number(meta.amount_cents);
    if (Number.isFinite(signed) && Number.isInteger(signed)) return signed;
  }
  if (sr.amount_due_cents == null || sr.amount_due_cents === '') return null;
  const n = Number(sr.amount_due_cents);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function readAuthoritativeBookingTotalCents(booking) {
  if (!booking || booking.total_amount_cents == null || booking.total_amount_cents === '') return null;
  const n = Number(booking.total_amount_cents);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function readAuthoritativeBalanceDueCents(booking) {
  if (!booking || booking.balance_due_cents == null || booking.balance_due_cents === '') return null;
  const n = Number(booking.balance_due_cents);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function resolveUnitAmountCentsFromMeta(srMeta, bookingMeta) {
  const direct = srMeta && srMeta.unit_amount_cents != null ? Number(srMeta.unit_amount_cents) : null;
  if (Number.isFinite(direct) && direct >= 0) return Math.round(direct);
  const quoteLines = Array.isArray(bookingMeta && bookingMeta.quote_line_items)
    ? bookingMeta.quote_line_items.filter(Boolean) : [];
  if (!quoteLines.length) return null;

  function norm(v) { return String(v || '').trim().toLowerCase(); }
  const component = norm(srMeta && srMeta.component);
  const offeringId = norm((srMeta && srMeta.offering_id) || (srMeta && srMeta.course_id));
  const offeringKey = norm(srMeta && srMeta.offering_key);
  const durationKey = norm((srMeta && srMeta.duration_key) || (srMeta && srMeta.tier_key));

  let candidates = quoteLines.filter((ql) => !component || norm(ql.component) === component);
  if (offeringId) {
    candidates = candidates.filter((ql) => norm(ql.offering_id) === offeringId);
  } else if (offeringKey) {
    candidates = candidates.filter((ql) => {
      const key = norm(ql.offering_item_code || ql.offering_key);
      return key === offeringKey || key.indexOf(`${offeringKey}__`) === 0;
    });
  }
  if (durationKey) {
    candidates = candidates.filter((ql) => norm(ql.duration_key) === durationKey);
  }
  // Component-only fallback is permitted only when it is unambiguous.
  if (candidates.length !== 1) return null;
  const unit = Number(candidates[0].unit_amount_cents);
  return Number.isFinite(unit) && unit >= 0 ? Math.round(unit) : null;
}

function buildPaymentSummary(prices, booking, services, adminSource, paymentsPaidCents, adminCfg, opts) {
  const bookingMeta = parseMeta(booking && booking.metadata);
  const rentalPricing = parseRentalPricingMeta(bookingMeta);
  const lineItems = [];
  let lineSumCents = 0;
  (services || []).forEach((sr) => {
    const persisted = readPersistedServiceDueCents(sr);
    let lineCents = 0;
    let usedLive = false;
    if (persisted != null) {
      // Explicit 0 is create-accounting truth for zeroed bundle/course peers — never reprice.
      lineCents = persisted;
    } else if (rentalPricing && isBundleRentalServiceRow(sr, rentalPricing)) {
      // Ambiguous legacy bundle constituent with null amount: do not invent independent live prices.
      lineCents = 0;
      usedLive = false;
    } else {
      const liveUnit = serviceRecordUnitPriceCents(prices, sr, adminCfg || null);
      usedLive = liveUnit != null;
      if (usedLive) lineCents = liveUnit;
    }
    lineSumCents += lineCents;
    const qty = Number(sr.quantity) || 1;
    const srMeta = parseMeta(sr.metadata);
    const unitAmountCents = resolveUnitAmountCentsFromMeta(srMeta, bookingMeta);
    const isAccom = !!(srMeta && (srMeta.source === STAFF_ACCOMMODATION_SOURCE
      || srMeta.staff_accommodation === true
      || srMeta.component === STAFF_ACCOMMODATION_COMPONENT));
    const seasonGroups = isAccom && Array.isArray(srMeta.season_groups)
      ? srMeta.season_groups : null;
    lineItems.push({
      service_record_id: sr.service_record_id,
      service_type: sr.service_type,
      service_date: sr.service_date,
      quantity: qty,
      unit_cents: (usedLive || persisted != null) && qty
        ? Math.round(lineCents / qty)
        : null,
      unit_amount_cents: unitAmountCents,
      line_cents: lineCents,
      label: lineItemLabel(sr.service_type, sr.quantity, sr.service_date, sr.slot_time, sr),
      priced_live: usedLive,
      pricing_group_id: srMeta.pricing_group_id || null, rental_bundle_id: srMeta.rental_bundle_id || null,
      offering_key: srMeta.offering_key || null, bundle_part: srMeta.bundle_part || null,
      rental_pricing_role: srMeta.rental_pricing_role || null,
      duration_key: srMeta.duration_key || (rentalPricing && rentalPricing.duration) || null,
      rental_service_dates: Array.isArray(srMeta.rental_service_dates) ? srMeta.rental_service_dates : null,
      component: srMeta.component || null, course_id: srMeta.course_id || null, offering_id: srMeta.offering_id || null, tier_key: srMeta.tier_key || null,
      staff_accommodation: isAccom || undefined,
      check_in: isAccom ? (srMeta.check_in || null) : undefined,
      check_out: isAccom ? (srMeta.check_out || null) : undefined,
      nights: isAccom ? (srMeta.nights != null ? Number(srMeta.nights) : null) : undefined,
      season_groups: seasonGroups || undefined,
    });
  });
  const bookingTotal = readAuthoritativeBookingTotalCents(booking);
  // Prefer server booking total when present so headline money matches create/quote truth.
  const subtotalCents = bookingTotal != null ? bookingTotal : lineSumCents;
  const storedPaid = Number(booking && booking.amount_paid_cents);
  const ledgerPaid = Number(paymentsPaidCents);
  const paidCents = Math.max(
    Number.isFinite(storedPaid) ? storedPaid : 0,
    Number.isFinite(ledgerPaid) ? ledgerPaid : 0,
  );
  const uiStatus = deriveDrawerPaymentUiStatus(booking, subtotalCents, paidCents);
  // The invoice must reconcile internally. Persisted balance remains operational
  // state, but display truth is always subtotal minus the same paid aggregate.
  const balanceDue = Math.max(subtotalCents - paidCents, 0);
  const paidRows = (opts && opts.paid_rows)
    || (opts && opts.paid_payment_rows)
    || [];
  const ledger = buildPaidPaymentLedger(paidRows, paidCents);
  const refundCreditCents = Math.max(0, paidCents - subtotalCents);
  return {
    line_items: lineItems,
    subtotal_cents: subtotalCents,
    total_cents: subtotalCents,
    paid_cents: paidCents,
    balance_due_cents: balanceDue,
    payment_status: uiStatus,
    paid_payments: ledger.rows,
    paid_ledger_remainder_cents: ledger.remainder_cents,
    refund_credit_cents: refundCreditCents,
    price_source: adminSource || bookingMeta.sunset_price_source || 'config',
    live_pricing: lineItems.some((li) => li.priced_live), rental_pricing: rentalPricing || null,
    pricing_note: bookingTotal != null
      ? 'Totals use persisted booking amount_due; line amounts keep create allocation (explicit zeros preserved).'
      : 'Totals use current Admin prices when line amounts are not stored.',
  };
}

function resolveBundleLocationId(bundle) {
  const meta = parseMeta(bundle && bundle.booking && bundle.booking.metadata);
  let recordLocationId = normalizeSunsetLocationId(meta.location_id || null);
  (bundle && bundle.services || []).some((sr) => {
    const srLoc = sr && sr.location_id;
    if (srLoc) {
      recordLocationId = normalizeSunsetLocationId(srLoc);
      return true;
    }
    return false;
  });
  return recordLocationId;
}

function serviceRecordIsStaffManual(sr) {
  if (!sr) return false;
  if (sr.metadata_source === METADATA_SOURCE_TAG) return true;
  const flag = sr.staff_manual_schedule;
  return flag === true || flag === 'true' || flag === 't';
}

function bundleHasTrustedScheduleDrawerAttribution(bundle) {
  const meta = parseMeta(bundle && bundle.booking && bundle.booking.metadata);
  if (meta.source === METADATA_SOURCE_TAG || meta.staff_manual_schedule) return true;
  if (meta.source === LUNA_METADATA_SOURCE_TAG || meta.luna_guest_booking) return true;
  if (meta.actor_source && isLunaTrustedActor({ source: meta.actor_source })) return true;
  return (bundle && bundle.services || []).some((sr) => {
    if (String(sr.record_source || sr.source || '').toLowerCase() === LUNA_DB_SOURCE) return true;
    return serviceRecordIsStaffManual(sr);
  });
}

/** @deprecated use bundleHasTrustedScheduleDrawerAttribution */
function bundleIsStaffManualSchedule(bundle) {
  return bundleHasTrustedScheduleDrawerAttribution(bundle);
}

async function getSunsetScheduleBookingDrawerContext(pg, opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, body: { success: false, error: 'unsupported_client' } };
  }
  const bookingId = String(opts.bookingId || '').trim();
  const bookingCode = String(opts.bookingCode || '').trim();
  if (!bookingId && !bookingCode) {
    return { ok: false, status: 400, body: { success: false, error: 'booking_id or booking_code is required' } };
  }
  if (bookingId && !isUuid(bookingId)) {
    return { ok: false, status: 400, body: { success: false, error: 'invalid booking_id' } };
  }

  let bundle = await loadSunsetBookingBundle(pg, clientSlug, bookingId, bookingCode);
  if (!bundle) {
    return { ok: false, status: 404, body: { success: false, error: 'booking not found' } };
  }
  const activeLocationId = normalizeSunsetLocationId(opts.locationId);
  const recordLocationId = resolveBundleLocationId(bundle);
  if (recordLocationId !== activeLocationId) {
    return { ok: false, status: 404, body: { success: false, error: 'booking_not_in_active_school' } };
  }
  let paymentReconcile = null;
  if (opts.stripe && bundle.booking && bundle.booking.booking_id) {
    paymentReconcile = await reconcilePendingStripePaymentsForBooking(pg, opts.stripe, {
      clientSlug,
      bookingId: bundle.booking.booking_id,
    });
    if (paymentReconcile && paymentReconcile.reconciled > 0) {
      bundle = await loadSunsetBookingBundle(pg, clientSlug, bundle.booking.booking_id, null);
    }
  }
  const meta = parseMeta(bundle.booking.metadata);
  if (!bundleHasTrustedScheduleDrawerAttribution(bundle)) {
    return { ok: false, status: 403, body: { success: false, error: 'drawer_untrusted_booking_source', reason_code: 'drawer_untrusted_booking_source' } };
  }

  // P0e: load tenant/location rental catalog once and overlay catalog_label on
  // service rows so invoice/payment/drawer render current Admin names even when
  // persisted offering_label is raw key, stale humanize, or an old Admin name.
  // Historical drawer/invoice: include inactive identity rows (snapshot fallback
  // when catalog load fails). Exact tenant/location only; never crash.
  let rentalLabelMap = Object.create(null);
  try {
    const { listRentalOfferings } = require('./tenant-rental-offerings');
    const offerings = await listRentalOfferings(pg, {
      clientSlug,
      locationId: activeLocationId,
      includeInactive: true,
    });
    rentalLabelMap = buildRentalCatalogLabelMap(offerings, {
      clientSlug,
      locationId: activeLocationId,
      includeInactive: true,
    });
  } catch (err) {
    console.error('[schedule drawer] rental catalog label map failed:', err && err.message);
    rentalLabelMap = Object.create(null);
  }
  if (bundle.services && Object.keys(rentalLabelMap).length) {
    bundle = {
      ...bundle,
      services: enrichServiceRecordsWithCatalogLabels(bundle.services, rentalLabelMap),
    };
  }

  let adminCfg;
  try {
    adminCfg = await resolveTenantBusinessConfigAsync(clientSlug, { locationId: activeLocationId });
  } catch (err) {
    console.error('[schedule drawer] config load failed:', err && err.message);
    adminCfg = resolveTenantBusinessConfig(clientSlug, activeLocationId);
  }
  const prices = adminCfg.ok ? (adminCfg.prices || []) : [];
  const agg = aggregateComponentsFromServices(bundle.services);
  // Prefer physical course rows; fall back to booking.metadata.selected_courses for
  // multi product-button bookings when service-row reconstruction is incomplete.
  if (agg.components && agg.components.course) {
    const fromRows = Array.isArray(agg.components.course.selected_courses)
      ? agg.components.course.selected_courses : [];
    const fromMeta = Array.isArray(meta.selected_courses) ? meta.selected_courses : [];
    if (fromRows.length < 2 && fromMeta.length > fromRows.length) {
      const seen = new Set();
      const merged = [];
      fromMeta.forEach((sc) => {
        if (!sc || typeof sc !== 'object') return;
        const id = String(sc.course_id || '').trim();
        if (!id || seen.has(id)) return;
        seen.add(id);
        const row = { course_id: id };
        if (sc.course_label) row.course_label = String(sc.course_label);
        if (sc.tier_key) row.tier_key = String(sc.tier_key);
        if (sc.offering_id) row.offering_id = String(sc.offering_id);
        merged.push(row);
      });
      if (merged.length) {
        agg.components.course.selected_courses = merged;
        agg.components.course.course_id = merged[0].course_id;
        if (merged[0].course_label) agg.components.course.course_label = merged[0].course_label;
        if (merged[0].tier_key) agg.components.course.tier_key = merged[0].tier_key;
        if (merged[0].offering_id) agg.components.course.offering_id = merged[0].offering_id;
      }
    }
  }
  const course_equipment = Array.isArray(agg.components.course_equipment)
    ? agg.components.course_equipment
    : (agg.components.course_equipment || null);
  if (agg.components && Object.prototype.hasOwnProperty.call(agg.components, 'course_equipment')) {
    delete agg.components.course_equipment;
  }
  const payment = buildPaymentSummary(
    prices,
    bundle.booking,
    bundle.services,
    adminCfg.source,
    bundle.payments_paid_cents,
    adminCfg,
    { paid_rows: bundle.paid_payment_rows || [] },
  );

  let stripeLink = null;
  let paymentLinkInvalidated = meta.payment_link_invalidated === true || meta.sunset_stripe_link_stale === true;
  try {
    const {
      buildPaymentLinkCommand,
      getPaymentStatus,
      PAYMENT_LINK_OPERATIONS,
      PAYMENT_LINK_CHANNELS,
    } = require('./luna-front-desk-payment-link-service');
    const statusBuilt = buildPaymentLinkCommand({
      operation: PAYMENT_LINK_OPERATIONS.GET_STATUS,
      trustedClientSlug: clientSlug,
      channel: PAYMENT_LINK_CHANNELS.STAFF_SCHEDULE,
      bookingId: bundle.booking.booking_id,
      bookingCode: bundle.booking.booking_code,
    });
    if (statusBuilt.ok) {
      const payStatus = await getPaymentStatus(pg, statusBuilt.command);
      if (payStatus.ok) {
        paymentLinkInvalidated = paymentLinkInvalidated || payStatus.body.lifecycle === 'invalidated'
          || payStatus.body.lifecycle === 'cancelled'
          || payStatus.body.lifecycle === 'booking_cancelled';
        if (payStatus.body.actionable && payStatus.body.checkout_url) {
          // The active payment row is authoritative. A replacement link may be
          // visible before legacy booking invalidation metadata is repaired;
          // never report that actionable replacement as stale/invalidated.
          paymentLinkInvalidated = false;
          stripeLink = {
            payment_id: payStatus.body.payment_id,
            payment_status: payStatus.body.payment_status,
            amount_due_cents: payStatus.body.amount_due_cents,
            checkout_url: payStatus.body.checkout_url,
            actionable: true,
            stale: false,
          };
        }
      }
    }
  } catch (payLinkErr) {
    console.error('[schedule drawer] payment status read failed:', payLinkErr && payLinkErr.message);
  }

  const legacyLink = bundle.payment_link;
  const linkStale = paymentLinkInvalidated
    || !!(legacyLink && legacyLink.amount_due_cents != null && Number(legacyLink.amount_due_cents) !== payment.balance_due_cents);
  if (!stripeLink && legacyLink && legacyLink.checkout_url && !paymentLinkInvalidated && !linkStale) {
    stripeLink = {
      payment_id: legacyLink.payment_id,
      payment_status: legacyLink.payment_status,
      amount_due_cents: Number(legacyLink.amount_due_cents),
      checkout_url: legacyLink.checkout_url,
      actionable: true,
      stale: linkStale,
    };
  }
  const link = stripeLink;

  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      booking_id: bundle.booking.booking_id,
      booking_code: bundle.booking.booking_code,
      booking_status: bundle.booking.status || null,
      payments_paid_cents: Number(bundle.payments_paid_cents || 0),
      guest_name: bundle.booking.guest_name,
      phone: resolveDrawerGuestPhoneFromBundle(bundle),
      notes: bundle.services[0] && bundle.services[0].notes ? bundle.services[0].notes : null,
      payment_status: payment.payment_status,
      payment_method: payment.payment_status === 'paid' ? (normalizePaymentMethod(meta.sunset_payment_method) || null) : null,
      date_from: agg.date_from,
      date_to: agg.date_to,
      components: agg.components,
      course_equipment: course_equipment || null,
      lessons: canonicalLessonsFromBundle(bundle, agg, meta),
      rentals: Array.isArray(meta.rentals) ? meta.rentals : [],
      custom_line_items: customLineItemsFromBundle(bundle),
      accommodation: accommodationFromBundle(bundle),
      rental_pricing: parseRentalPricingMeta(meta) || meta.rental_pricing || null, slot_time: agg.slot_time,
      payment,
      stripe_link: link ? {
        payment_id: link.payment_id,
        payment_status: link.payment_status,
        amount_due_cents: Number(link.amount_due_cents),
        checkout_url: link.checkout_url,
        stale: linkStale,
      } : null,
      stripe_link_stale: linkStale,
      payment_link_invalidated: paymentLinkInvalidated,
      editable: true,
      location_id: recordLocationId,
      payment_reconcile: paymentReconcile,
    },
  };
}

function resolveBookingEditAttribution(bundle, actor) {
  const meta = parseMeta(bundle && bundle.booking && bundle.booking.metadata);
  const originallyLuna = meta.source === LUNA_METADATA_SOURCE_TAG
    || meta.luna_guest_booking === true
    || (meta.actor_source && isLunaTrustedActor({ source: meta.actor_source }))
    || (bundle && bundle.services || []).some((sr) => String(sr.record_source || sr.source || '').toLowerCase() === LUNA_DB_SOURCE);
  if (originallyLuna) {
    return {
      dbSource: LUNA_DB_SOURCE,
      metadataSource: LUNA_METADATA_SOURCE_TAG,
      staffManualSchedule: false,
      lunaGuestBooking: true,
      actorSource: meta.actor_source || null,
      createdByStaff: null,
      lastEditedByStaff: actor && actor.email ? actor.email : null,
    };
  }
  return {
    dbSource: DB_SOURCE,
    metadataSource: METADATA_SOURCE_TAG,
    staffManualSchedule: true,
    lunaGuestBooking: false,
    actorSource: null,
    createdByStaff: actor && actor.email ? actor.email : null,
    lastEditedByStaff: actor && actor.email ? actor.email : null,
  };
}


/** Reconstruct staff custom commercial lines from service rows / booking metadata. */
function customLineItemsFromBundle(bundle) {
  const services = (bundle && bundle.services) || [];
  const fromRows = [];
  const seen = new Set();
  services.forEach((sr) => {
    const m = parseMeta(sr.metadata);
    if (!(m.source === STAFF_CUSTOM_LINE_SOURCE || m.staff_custom_line === true
      || m.component === STAFF_CUSTOM_LINE_COMPONENT)) {
      return;
    }
    const id = String(m.client_line_id || sr.service_record_id || sr.id || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    let amount = m.amount_cents != null ? Number(m.amount_cents) : Number(sr.amount_due_cents);
    if (!Number.isFinite(amount) || !Number.isInteger(amount)) amount = 0;
    fromRows.push({
      client_line_id: id,
      label: String(m.label || '').trim() || 'Custom line',
      amount_cents: amount,
    });
  });
  if (fromRows.length) return fromRows;
  const meta = parseMeta(bundle && bundle.booking && bundle.booking.metadata);
  if (Array.isArray(meta.custom_line_items) && meta.custom_line_items.length) {
    return meta.custom_line_items.map((l) => ({
      client_line_id: String((l && l.client_line_id) || '').trim(),
      label: String((l && l.label) || '').trim(),
      amount_cents: Number(l && l.amount_cents) || 0,
    })).filter((l) => l.client_line_id && l.label);
  }
  return [];
}

/**
 * Reconstruct staff Accommodation identity from service rows / booking metadata.
 * Returns multi-stay selection (dates only) for Edit seed + omit-preserve, plus
 * per-stay card snapshots. Singular first-stay fields mirrored for legacy readers.
 */
function accommodationFromBundle(bundle) {
  const {
    isStaffAccommodationMeta,
    formatAccommodationBookingCard,
    buildAccommodationSelectionValue,
    sortAccommodationStays,
  } = require('./sunset-accommodation-price-resolver');
  const services = (bundle && bundle.services) || [];
  const found = [];
  for (const sr of services) {
    const m = parseMeta(sr.metadata);
    if (!isStaffAccommodationMeta(m)) continue;
    const checkIn = String(m.check_in || '').slice(0, 10);
    const checkOut = String(m.check_out || '').slice(0, 10);
    if (!checkIn || !checkOut) continue;
    const card = formatAccommodationBookingCard(m, sr.amount_due_cents);
    found.push({
      client_stay_id: m.client_stay_id ? String(m.client_stay_id) : null,
      check_in: checkIn,
      check_out: checkOut,
      nights: Number(m.nights) || null,
      card,
      snapshot: {
        total_cents: m.total_cents != null ? Number(m.total_cents) : Number(sr.amount_due_cents) || 0,
        season_groups: Array.isArray(m.season_groups) ? m.season_groups : [],
        nightly_breakdown: Array.isArray(m.nightly_breakdown) ? m.nightly_breakdown : [],
        currency: m.currency || 'EUR',
      },
      service_record_id: sr.service_record_id || sr.id || null,
      amount_due_cents: Number(sr.amount_due_cents) || 0,
    });
  }
  if (found.length) {
    const ordered = sortAccommodationStays(found);
    const value = buildAccommodationSelectionValue(ordered.map((s) => ({
      client_stay_id: s.client_stay_id,
      check_in: s.check_in,
      check_out: s.check_out,
      nights: s.nights,
    })));
    if (!value) return null;
    // Attach cards/snapshots aligned to ordered stays for Edit seed + booking view.
    value.cards = ordered.map((s) => s.card);
    value.stay_details = ordered.map((s) => ({
      client_stay_id: s.client_stay_id,
      check_in: s.check_in,
      check_out: s.check_out,
      nights: s.nights,
      card: s.card,
      snapshot: s.snapshot,
      service_record_id: s.service_record_id,
      amount_due_cents: s.amount_due_cents,
    }));
    // First-stay card/snapshot for singular legacy consumers.
    value.card = ordered[0].card;
    value.snapshot = ordered[0].snapshot;
    return value;
  }
  const meta = parseMeta(bundle && bundle.booking && bundle.booking.metadata);
  // Legacy booking metadata: singular or multi stays array.
  if (meta.accommodation) {
    const a = meta.accommodation;
    if (Array.isArray(a.stays) && a.stays.length) {
      const value = buildAccommodationSelectionValue(a.stays.map((s) => ({
        client_stay_id: s.client_stay_id || null,
        check_in: String(s.check_in || '').slice(0, 10),
        check_out: String(s.check_out || '').slice(0, 10),
        nights: Number(s.nights) || 0,
      })).filter((s) => s.check_in && s.check_out));
      if (value) {
        value.card = null;
        value.snapshot = null;
        value.cards = [];
        value.stay_details = (value.stays || []).map((s) => ({
          ...s, card: null, snapshot: null,
        }));
        return value;
      }
    }
    if (a.check_in && a.check_out) {
      const value = buildAccommodationSelectionValue([{
        client_stay_id: a.client_stay_id || null,
        check_in: String(a.check_in).slice(0, 10),
        check_out: String(a.check_out).slice(0, 10),
        nights: Number(a.nights) || 0,
      }]);
      if (value) {
        value.card = null;
        value.snapshot = null;
        value.cards = [];
        value.stay_details = (value.stays || []).map((s) => ({
          ...s, card: null, snapshot: null,
        }));
        return value;
      }
    }
  }
  return null;
}

/**
 * Same production owner as drawer readback lessons[]:
 *  1) booking metadata.lessons (exact create/edit identity)
 *  2) reconstruct from physical lesson service rows (same-day multi survives)
 *  3) legacy single-course / single-private expand only when exact lesson
 *     service rows are absent — never invent multi same-day from an outer range
 *     when service rows already own lesson identity.
 */
function canonicalLessonsFromBundle(bundle, agg, meta) {
  try {
    const {
      normalizeCanonicalLessons,
      reconstructLessonsFromServiceRows,
    } = require('./sunset-schedule-lessons');
    const services = (bundle && bundle.services) || [];
    const bookingMeta = meta || parseMeta(bundle && bundle.booking && bundle.booking.metadata);
    // 1) Prefer booking metadata.lessons when present (exact create/edit identity).
    if (Array.isArray(bookingMeta.lessons) && bookingMeta.lessons.length) {
      const fromMeta = normalizeCanonicalLessons({ lessons: bookingMeta.lessons });
      if (fromMeta.ok && fromMeta.present) return fromMeta.lessons;
    }
    // 2) Reconstruct from physical service rows (same-day multi survives).
    const fromRows = reconstructLessonsFromServiceRows(services);
    if (fromRows.ok && fromRows.present) return fromRows.lessons;
    // 3) Narrow legacy: single-course / single-private components only.
    // Only when exact lesson service rows did not yield identity — do not invent
    // multi same-day cardinality from an outer date range alone.
    const components = (agg && agg.components) || {};
    const expanded = normalizeCanonicalLessons({
      components,
      service_dates: (() => {
        const from = agg && agg.date_from ? String(agg.date_from).slice(0, 10) : '';
        const to = agg && agg.date_to ? String(agg.date_to).slice(0, 10) : from;
        if (!from) return [];
        const out = [];
        let cur = from;
        let guard = 0;
        while (cur && cur <= to && guard < 31) {
          out.push(cur);
          const d = new Date(`${cur}T12:00:00Z`);
          d.setUTCDate(d.getUTCDate() + 1);
          cur = d.toISOString().slice(0, 10);
          guard += 1;
        }
        return out;
      })(),
    });
    if (expanded.ok && expanded.present) return expanded.lessons;
    return null;
  } catch (_) {
    return null;
  }
}

function pricingIntentFromBundle(bundle) {
  const services = (bundle && bundle.services) || [];
  const agg = aggregateComponentsFromServices(services);
  const meta = parseMeta(bundle && bundle.booking && bundle.booking.metadata);
  let rentals = Array.isArray(meta.rentals) ? meta.rentals.slice() : [];
  if (rentals.length) {
    const cover = {};
    services.forEach((sr) => {
      const m = parseMeta(sr.metadata);
      const ok = String(m.offering_key || '').trim();
      if (!ok) return;
      if (!cover[ok]) cover[ok] = new Set();
      const iso = String(sr.service_date || '').slice(0, 10);
      if (iso) cover[ok].add(iso);
      (m.rental_service_dates || []).forEach((d) => {
        const x = String(d || '').slice(0, 10);
        if (x) cover[ok].add(x);
      });
    });
    rentals = rentals.map((r) => ({
      ...r,
      covered_dates: cover[r.offering_key]
        ? [...cover[r.offering_key]].sort()
        : (r.covered_dates || r.rental_service_dates || []),
      pricing_group_id: r.pricing_group_id
        || (meta.rental_pricing && meta.rental_pricing.pricing_group_id)
        || null,
    }));
  }
  const custom_line_items = customLineItemsFromBundle(bundle);
  const course_equipment = Array.isArray(agg.components.course_equipment)
    ? agg.components.course_equipment
      .map((row) => ({
        offering_key: row.offering_key,
        mode: row.mode,
        quantity: row.quantity,
      }))
      .filter((row) => row.offering_key)
      .sort((a, b) => String(a.offering_key).localeCompare(String(b.offering_key)))
    : (agg.components.course_equipment || null);
  if (agg.components && Object.prototype.hasOwnProperty.call(agg.components, 'course_equipment')) {
    delete agg.components.course_equipment;
  }
  // Multi product-button selected_courses: service rows first, metadata fallback.
  if (agg.components && agg.components.course) {
    const fromRows = Array.isArray(agg.components.course.selected_courses)
      ? agg.components.course.selected_courses : [];
    const fromMeta = Array.isArray(meta.selected_courses) ? meta.selected_courses : [];
    if (fromRows.length < 2 && fromMeta.length > fromRows.length) {
      const seen = new Set();
      const merged = [];
      fromMeta.forEach((sc) => {
        if (!sc || typeof sc !== 'object') return;
        const id = String(sc.course_id || '').trim();
        if (!id || seen.has(id)) return;
        seen.add(id);
        const row = { course_id: id };
        if (sc.tier_key) row.tier_key = String(sc.tier_key);
        if (sc.offering_id) row.offering_id = String(sc.offering_id);
        merged.push(row);
      });
      if (merged.length) {
        agg.components.course.selected_courses = merged;
        agg.components.course.course_id = merged[0].course_id;
        if (merged[0].tier_key) agg.components.course.tier_key = merged[0].tier_key;
        if (merged[0].offering_id) agg.components.course.offering_id = merged[0].offering_id;
      }
    }
  }

  // Reconstruct canonical lessons[] so multi-lesson commercial identity compares
  // equal to an identical Edit PATCH (guest/name/notes-only must not reprice).
  const lessons = canonicalLessonsFromBundle(bundle, agg, meta);
  let components = agg.components || {};
  if (Array.isArray(lessons) && lessons.length) {
    // Align class components with validate/expand path (primary course for multi-course).
    // Aggregate last-row course_id would false-trigger paid reprice for multi-course.
    try {
      const { expandLessonsToLegacyComponents } = require('./sunset-schedule-lessons');
      const surfers = Number(
        (components.course && components.course.quantity)
        || (components.private_lesson && components.private_lesson.surfer_count)
        || 1,
      ) || 1;
      const expanded = expandLessonsToLegacyComponents(lessons, surfers);
      if (expanded.ok && expanded.components) {
        const next = { ...components };
        delete next.course;
        delete next.private_lesson;
        Object.assign(next, expanded.components);
        components = next;
      }
    } catch (_) { /* keep aggregate components */ }
  }

  // Reconstruct existing accommodation identity so paid notes-only / omitted-wire
  // edits compare equal to the live stays. Explicit accommodation:null still drops
  // them (request path does not call this reconstruction for the requested intent).
  const accommodation = accommodationFromBundle(bundle);
  let accommodationIntent = null;
  if (accommodation && accommodation.enabled) {
    const stays = Array.isArray(accommodation.stays) ? accommodation.stays : [];
    if (stays.length) {
      accommodationIntent = {
        enabled: true,
        stays: stays.map((s) => ({
          client_stay_id: s.client_stay_id || null,
          check_in: String(s.check_in || '').slice(0, 10),
          check_out: String(s.check_out || '').slice(0, 10),
        })),
        check_in: String(accommodation.check_in || stays[0].check_in || '').slice(0, 10),
        check_out: String(accommodation.check_out || stays[0].check_out || '').slice(0, 10),
      };
    } else if (accommodation.check_in && accommodation.check_out) {
      accommodationIntent = {
        enabled: true,
        stays: [{
          check_in: String(accommodation.check_in).slice(0, 10),
          check_out: String(accommodation.check_out).slice(0, 10),
        }],
        check_in: String(accommodation.check_in).slice(0, 10),
        check_out: String(accommodation.check_out).slice(0, 10),
      };
    }
  }

  return buildSchedulePricingIntent({
    service_dates: (() => {
      // Prefer unique calendar days from reconstructed lessons when present —
      // matches requested intent and avoids private-session exclusion mismatches.
      if (Array.isArray(lessons) && lessons.length) {
        try {
          const { uniqueCalendarDates } = require('./sunset-schedule-lessons');
          const fromLessons = uniqueCalendarDates(lessons);
          if (fromLessons.length) return fromLessons;
        } catch (_) { /* fall through */ }
      }
      const dates = new Set();
      services.forEach((sr) => {
        const m = parseMeta(sr.metadata);
        const component = String(m.component || sr.metadata_component || '').toLowerCase();
        const ui = String(sr.staff_ui_service_type || '').toLowerCase();
        if (component === FULL_DAY_EQUIPMENT_ADDON_KEY) return;
        if (component === 'private_lesson' || ui === 'private_lesson') return;
        if (component === STAFF_CUSTOM_LINE_COMPONENT
          || m.source === STAFF_CUSTOM_LINE_SOURCE
          || m.staff_custom_line === true) return;
        if (component === STAFF_ACCOMMODATION_COMPONENT
          || m.source === STAFF_ACCOMMODATION_SOURCE
          || m.staff_accommodation === true) return;
        if (String(sr.service_type || '').toLowerCase() === 'addon_service') return;
        const iso = String(sr.service_date || '').slice(0, 10);
        if (iso) dates.add(iso);
      });
      if (!dates.size && agg.date_from) {
        if (agg.date_from) dates.add(agg.date_from);
        if (agg.date_to) dates.add(agg.date_to);
      }
      return [...dates].sort();
    })(),
    components,
    lessons: Array.isArray(lessons) ? lessons : [],
    course_equipment,
    rentals,
    custom_line_items,
    accommodation: accommodationIntent,
  }, { rentals, custom_line_items });
}

async function updateSunsetScheduleBooking(pg, opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, body: { success: false, error: 'unsupported_client' } };
  }
  const bookingId = String(opts.bookingId || opts.body?.booking_id || '').trim();
  if (!bookingId || !isUuid(bookingId)) {
    return { ok: false, status: 400, body: { success: false, error: 'booking_id is required' } };
  }

  const bundle = await loadSunsetBookingBundle(pg, clientSlug, bookingId, null);
  if (!bundle) {
    return { ok: false, status: 404, body: { success: false, error: 'booking not found' } };
  }
  const activeLocationId = normalizeSunsetLocationId(opts.locationId);
  if (resolveBundleLocationId(bundle) !== activeLocationId) {
    return { ok: false, status: 404, body: { success: false, error: 'booking_not_in_active_school' } };
  }
  if (!bundleHasTrustedScheduleDrawerAttribution(bundle)) {
    return { ok: false, status: 403, body: { success: false, error: 'updates_untrusted_booking_source', reason_code: 'updates_untrusted_booking_source' } };
  }
  {
    const bookingSt = String(bundle.booking && bundle.booking.status || '').toLowerCase();
    if (bookingSt === 'cancelled' || bookingSt === 'canceled') {
      return { ok: false, status: 409, body: { success: false, error: 'booking_cancelled', message: 'Cancelled bookings are read-only.' } };
    }
  }

  // Mirror Create: exact-offering lane (board_and_suit + custom) via generic prep;
  // component lane is board/wetsuit only. Never invent bundle component halves.
  const requestBody = opts.body && typeof opts.body === 'object' ? opts.body : {};
  const requestedRentals = Array.isArray(requestBody.rentals) ? requestBody.rentals : [];
  const dateFromForRental = String(requestBody.date_from || '').slice(0, 10);
  const dateToForRental = String(requestBody.date_to || requestBody.date_from || '').slice(0, 10);
  const editSpanDates = inclusiveIsoDatesFromRange(dateFromForRental, dateToForRental);
  const genericPrep = await prepareGenericRentalsForCreate({
    clientSlug,
    locationId: activeLocationId,
    pgClient: pg,
    rentals: requestedRentals,
    serviceDate: dateFromForRental,
    source: DB_SOURCE,
    calendarDayCount: editSpanDates.length,
    bookingDurationKey: rentalDurationKeyFromDateRange(dateFromForRental, dateToForRental),
    dateFrom: dateFromForRental,
    dateTo: dateToForRental,
    serviceDates: editSpanDates,
  });
  if (!genericPrep.ok) {
    const badCatalogKey = genericPrep.reason === 'rental_offering_not_active'
      || genericPrep.reason === 'invalid_rental_offering';
    return {
      ok: false,
      status: badCatalogKey ? 400 : 409,
      body: {
        success: false,
        error: genericPrep.reason || genericPrep.error || 'invalid_rental_offering',
        reason: genericPrep.reason,
        reason_code: genericPrep.reason,
      },
    };
  }
  // Shared SSoT — never a local subset that drops surfboard_wetsuit_rental /
  // board_and_wetsuit_rental on Edit.
  const CANONICAL_RENTAL_KEYS = new Set(CANONICAL_RENTAL_OFFERING_KEYS);
  const COMPONENT_LANE_KEYS = new Set(['board_rental', 'wetsuit_rental']);
  const canonicalRequested = requestedRentals.filter((r) => CANONICAL_RENTAL_KEYS.has(String(r && r.offering_key || '').trim()));
  let prepBody = genericPrep.genericRentals.length
    ? { ...requestBody, rentals: canonicalRequested, components: requestBody.components || {} }
    : requestBody;
  if (genericPrep.genericRentals.length && !canonicalRequested.length) {
    prepBody = { ...prepBody };
    delete prepBody.rentals;
  }
  const rentalPrep = prepareCanonicalRentalsForCreate(prepBody);
  if (!rentalPrep.ok) {
    return { ok: false, status: 400, body: { success: false, error: rentalPrep.error, reason: rentalPrep.reason, reason_code: rentalPrep.reason } };
  }

  // Unrelated edits must not silently delete accommodation: when the wire omits
  // the accommodation key, preserve all existing stay identities from service rows.
  const editBodyBase = rentalPrep.present ? rentalPrep.body : prepBody;
  const preservedAccom = accommodationFromBundle(bundle);
  let editBody = { ...editBodyBase };
  if (!Object.prototype.hasOwnProperty.call(requestBody, 'accommodation')
    && !Object.prototype.hasOwnProperty.call(editBodyBase, 'accommodation')
    && preservedAccom) {
    const stays = Array.isArray(preservedAccom.stays) ? preservedAccom.stays : [];
    if (stays.length) {
      editBody.accommodation = {
        enabled: true,
        stays: stays.map((s) => ({
          client_stay_id: s.client_stay_id || null,
          check_in: s.check_in,
          check_out: s.check_out,
        })),
        check_in: preservedAccom.check_in,
        check_out: preservedAccom.check_out,
      };
    } else if (preservedAccom.check_in && preservedAccom.check_out) {
      editBody.accommodation = {
        enabled: true,
        check_in: preservedAccom.check_in,
        check_out: preservedAccom.check_out,
      };
    }
  }
  const hasExactOfferingRentals = Array.isArray(canonicalRequested)
    && canonicalRequested.some((r) => isExactOfferingFutureWriteKey(String(r && r.offering_key || '').trim()));
  const validated = validateScheduleBookingBody({
    ...editBody,
    guest_name: requestBody.guest_name != null
      ? requestBody.guest_name
      : bundle.booking.guest_name,
  }, {
    allowEmptyComponents: genericPrep.genericRentals.length > 0
      || hasExactOfferingRentals
      || !!(editBody.accommodation && editBody.accommodation.enabled !== false),
  });
  if (!validated.ok) {
    return { ok: false, status: 400, body: { success: false, error: validated.error } };
  }
  const input = validated.value;
  const phoneRaw = requestBody.guest_phone ?? requestBody.phone_number ?? requestBody.phone;
  const guest_phone = phoneRaw != null
    ? String(phoneRaw).trim().slice(0, 40)
    : (bundle.booking.phone || '');
  if (guest_phone) input.guest_phone = guest_phone;

  const srPayment = UI_TO_SR_PAYMENT[input.payment_status];
  const bookingPayment = UI_TO_BOOKING_PAYMENT[input.payment_status];
  const bookingStatus = bookingStatusFromPayment(input.payment_status);
  const paymentMethod = input.payment_status === 'paid'
    ? normalizePaymentMethod(requestBody.payment_method)
    : null;
  const editAttribution = resolveBookingEditAttribution(bundle, opts.actor);
  const componentKeys = componentList(input.components);
  const guestCount = resolveGuestCount(input.components);
  const { firstDate, lastDate } = bookingHeaderDates(input);
  let canonicalRentals = rentalPrep.present ? rentalPrep.rentals : null;
  let rentalSpanDates = rentalPrep.present ? rentalPrep.rentalSpanDates : null;
  let rentalPricingGroupId = rentalPrep.present ? rentalPrep.pricingGroupId : null;
  let rentalPricingDescriptor = buildRentalPricingDescriptor(input.rental_pricing, input.service_dates);
  const allRequestedRentals = [
    ...(canonicalRentals || []),
    ...genericPrep.genericRentals,
  ];

  await pg.query('BEGIN');
  try {
    const rollback = async (result) => { await pg.query('ROLLBACK'); return result; };
    // Lock booking by client; re-check active location on locked header+services.
    const lockRes = await pg.query(
      `SELECT b.id::text AS booking_id, b.client_id::text AS client_id,
              b.booking_code, b.guest_name, b.phone,
              b.status::text AS status, b.payment_status::text AS payment_status,
              b.check_in::text AS check_in, b.check_out::text AS check_out,
              b.guest_count, b.total_amount_cents, b.amount_paid_cents, b.balance_due_cents,
              b.metadata
         FROM bookings b
         INNER JOIN clients c ON c.id = b.client_id
        WHERE c.slug = $1 AND b.id = $2::uuid
        FOR UPDATE OF b`,
      [clientSlug, bookingId],
    );
    if (!lockRes.rows.length) {
      return rollback({ ok: false, status: 404, body: { success: false, error: 'booking not found' } });
    }
    const clientId = lockRes.rows[0].client_id;
    const svcLockRes = await pg.query(
      `SELECT id::text AS service_record_id, service_type::text AS service_type,
              service_date::text AS service_date, quantity,
              amount_due_cents, amount_paid_cents, payment_status::text AS payment_status,
              service_time_local, service_time_local_end, metadata, source AS record_source
         FROM booking_service_records
        WHERE client_slug = $1 AND booking_id = $2::uuid
        ORDER BY service_date, id FOR UPDATE`,
      [clientSlug, bookingId],
    );
    // Lock payment ledger (client+booking) before paid/intent decision.
    const payLock = await lockSchedulePaymentsForUpdate(pg, bookingId, clientId);
    const lockedServices = svcLockRes.rows.map((sr) => {
      const m = parseMeta(sr.metadata);
      return Object.assign({}, sr, {
        slot_time: m.slot_time || null,
        staff_ui_service_type: m.staff_ui_service_type || null,
        metadata_component: m.component || null,
        location_id: m.location_id || null,
        metadata_source: m.source || null,
        course_id: m.course_id || null,
        course_label: m.course_label || null,
        lesson_category: m.lesson_category || null,
      });
    });
    const lockedBundle = {
      booking: lockRes.rows[0],
      services: lockedServices,
      payments_paid_cents: payLock.paidCents,
      locked_payments: payLock.rows,
    };
    const recordLocationId = resolveBundleLocationId(lockedBundle);
    if (recordLocationId !== activeLocationId) {
      return rollback({ ok: false, status: 404, body: { success: false, error: 'booking_not_in_active_school' } });
    }
    if (!bundleHasTrustedScheduleDrawerAttribution(lockedBundle)) {
      return rollback({ ok: false, status: 403, body: { success: false, error: 'updates_untrusted_booking_source', reason_code: 'updates_untrusted_booking_source' } });
    }

    const lockedMeta = parseMeta(lockedBundle.booking.metadata);
    // Explicit rentals[] present (even empty) owns rental intent; generic +
    // component-lane keys both fingerprint. Omitted rentals → preserve existing.
    // IMPORTANT: exact-offering Edit (board_and_suit + custom) strips those keys
    // before prepareCanonical, so rentalPrep.present is false even when the client
    // sent rentals[]. That is NOT "omitted" — do not restore lockedMeta.rentals
    // into the component lane.
    const rentalsPresentOnPatch = Object.prototype.hasOwnProperty.call(requestBody, 'rentals');
    if (!rentalPrep.present) {
      if (!rentalsPresentOnPatch
        && Array.isArray(lockedMeta.rentals)
        && lockedMeta.rentals.length) {
        // Omitted rentals only: preserve board/wetsuit for the component lane.
        // board_and_suit + custom catalog keys stay on lockedMeta.rentals for
        // fingerprint/metadata preserve — never as canonicalRentals.
        const onlyComponentLane = lockedMeta.rentals.filter((r) =>
          COMPONENT_LANE_KEYS.has(String(r && r.offering_key || '').trim()));
        canonicalRentals = onlyComponentLane.length ? onlyComponentLane : null;
        if (lockedMeta.rental_pricing) rentalPricingDescriptor = lockedMeta.rental_pricing;
        rentalPricingGroupId = (lockedMeta.rental_pricing && lockedMeta.rental_pricing.pricing_group_id) || null;
      }
      // Explicit rentals[] with only exact offerings: leave canonicalRentals null
      // so genericOnly quote short-circuit + genericPrep.records own pricing.
    }

    // Physical stock inside Edit transaction: exclude this booking, then check
    // replacement allocation (new selection or preserved rentals with new dates).
    // Includes replacement course_equipment claims. Fail closed before service
    // row mutation (no partial delete/recreate on stock failure).
    //
    // Course equipment ownership (inside locked txn, after service FOR UPDATE):
    //   - explicit course_equipment on patch owns (including [] = remove)
    //   - omitted → reconstruct from locked service rows via pricingIntentFromBundle
    //     (Create does not persist course_equipment on booking metadata)
    {
      const effectiveRentalsForStock = rentalsPresentOnPatch
        ? allRequestedRentals
        : (Array.isArray(lockedMeta.rentals) ? lockedMeta.rentals : []);
      const {
        isPresentCourseEquipmentSelection,
      } = require('./sunset-course-equipment-options');
      const cePresentOnPatch = Object.prototype.hasOwnProperty.call(requestBody, 'course_equipment');
      // Reconstruct after service-row lock — never unlocked pre-read / never metadata.
      const preservedCeFromLockedServices = (() => {
        const fromRows = pricingIntentFromBundle(lockedBundle).course_equipment;
        return isPresentCourseEquipmentSelection(fromRows) ? fromRows : [];
      })();
      const effectiveCeForStock = cePresentOnPatch
        ? (isPresentCourseEquipmentSelection(input.course_equipment) ? input.course_equipment : [])
        : preservedCeFromLockedServices;
      // Omitted CE: service-derived selection owns reprice/insert so date-only
      // moves preserve claims (do not alter display snapshots; same shape as rows).
      if (!cePresentOnPatch && preservedCeFromLockedServices.length) {
        input.course_equipment = preservedCeFromLockedServices;
      }
      if (effectiveRentalsForStock.length || (Array.isArray(effectiveCeForStock) && effectiveCeForStock.length)) {
        const {
          assertRentalStockClaimsInTxn,
          collectRentalStockClaims,
          collectCourseEquipmentStockClaims,
          mergeExactOfferingStockClaims,
          stockFailureHttp,
        } = require('./tenant-rental-stock-service');
        const { DEFAULT_SUNSET_LOCATION_ID } = require('./sunset-school-locations');
        const stockDateFrom = input.date_from || firstDate;
        const stockDateTo = input.date_to || lastDate || firstDate;
        const ceServiceDates = Array.isArray(input.service_dates) && input.service_dates.length
          ? input.service_dates
          : (Array.isArray(input.lessons)
            ? input.lessons.map((l) => l && l.date).filter(Boolean)
            : null);
        const rentalClaims = collectRentalStockClaims(
          effectiveRentalsForStock, stockDateFrom, stockDateTo,
        );
        if (!rentalClaims.ok) {
          return rollback({
            ok: false,
            status: 400,
            body: {
              success: false,
              error: rentalClaims.error || 'invalid_stock_request',
              reason_code: rentalClaims.error || 'invalid_stock_request',
              message: rentalClaims.message,
            },
          });
        }
        const ceClaims = collectCourseEquipmentStockClaims(
          effectiveCeForStock, stockDateFrom, stockDateTo, ceServiceDates,
        );
        if (!ceClaims.ok) {
          return rollback({
            ok: false,
            status: 400,
            body: {
              success: false,
              error: ceClaims.error || 'invalid_stock_request',
              reason_code: ceClaims.error || 'invalid_stock_request',
              message: ceClaims.message,
            },
          });
        }
        const merged = mergeExactOfferingStockClaims(rentalClaims.claims, ceClaims.claims);
        const stockAssert = await assertRentalStockClaimsInTxn(pg, {
          clientSlug,
          locationId: activeLocationId,
          claims: merged.claims,
          excludeBookingId: bookingId,
          defaultLocationId: clientSlug === SUNSET_CLIENT_SLUG ? DEFAULT_SUNSET_LOCATION_ID : null,
        });
        if (!stockAssert.ok) {
          const http = stockFailureHttp(stockAssert);
          return rollback({
            ok: false,
            status: (http && http.status) || 409,
            body: (http && http.body) || {
              success: false,
              error: stockAssert.error,
              reason_code: stockAssert.error,
            },
          });
        }
      }
    }

    const existingIntent = pricingIntentFromBundle(lockedBundle);
    const requestedIntent = buildSchedulePricingIntent(input, {
      rentals: rentalsPresentOnPatch
        ? allRequestedRentals.map((r) => ({
          ...r,
          covered_dates: rentalSpanDates || inclusiveIsoDatesFromRange(firstDate, lastDate),
        }))
        : (lockedMeta.rentals || canonicalRentals || []),
      rentalCoveredDates: rentalSpanDates || undefined,
      preserveExistingRentals: !rentalsPresentOnPatch ? (lockedMeta.rentals || []) : undefined,
      custom_line_items: input.custom_line_items || [],
    });
    const pricingChanged = !schedulePricingIntentsEqual(existingIntent, requestedIntent);
    if (pricingChanged && isSunsetBookingFinanciallyCommitted(lockedBundle)) {
      return rollback(paidBookingRepriceRequiredResult());
    }

    const bundleId = lockedMeta.bundle_id || crypto.randomBytes(8).toString('hex');
    const headerMetaPatch = attachLocationToMetadata({
      guest_phone: guest_phone || null,
      bundle_id: bundleId,
      components: componentKeys,
      sunset_payment_method: paymentMethod,
      sunset_stripe_link_stale: true,
      sunset_updated_at: new Date().toISOString(),
      source: editAttribution.metadataSource,
      staff_manual_schedule: editAttribution.staffManualSchedule,
      luna_guest_booking: editAttribution.lunaGuestBooking,
      actor_source: editAttribution.actorSource,
      last_edited_by_staff: editAttribution.lastEditedByStaff,
      rentals: rentalsPresentOnPatch
        ? (allRequestedRentals.length ? allRequestedRentals : [])
        : (lockedMeta.rentals || null),
      rental_pricing: rentalPricingDescriptor || lockedMeta.rental_pricing || null,
      custom_line_items: input.custom_line_items || [],
      lessons: Array.isArray(input.lessons) ? input.lessons : null,
      notes: input.notes || null,
    }, recordLocationId);

    // Non-pricing: keep service rows/totals. Paid: locked ledger / manual payment row.
    if (!pricingChanged) {
      const headerUpd = await pg.query(
        // MULTICLIENT_SCOPE_OK: Edit header matches Create trust boundary
        `UPDATE bookings
            SET guest_name = $1,
                phone = NULLIF($2, ''),
                status = $3::booking_status,
                payment_status = $4::payment_status,
                guest_count = $5,
                metadata = COALESCE(metadata, '{}'::jsonb) || $6::jsonb
          WHERE id = $7::uuid AND client_id = $8::uuid`,
        [
          input.guest_name, guest_phone, bookingStatus, bookingPayment, guestCount,
          JSON.stringify(headerMetaPatch), bookingId, clientId,
        ],
      );
      if (Number(headerUpd && headerUpd.rowCount) !== 1) {
        return rollback({ ok: false, status: 409, body: { success: false, error: 'booking_update_conflict' } });
      }
      if (input.payment_status === 'paid') {
        const paidApply = await applyEditPaidAmountInTxn(pg, {
          bookingId, clientId, paymentsPaidCents: lockedBundle.payments_paid_cents,
          paymentMethod, actorEmail: editAttribution.lastEditedByStaff,
        });
        if (!paidApply.ok) return rollback(paidApply);
      }
      await pg.query('COMMIT');
      const ctxKeep = await getSunsetScheduleBookingDrawerContext(pg, { clientSlug, bookingId });
      return {
        ok: true,
        status: 200,
        body: {
          success: true,
          booking_id: bookingId,
          booking_code: lockedBundle.booking.booking_code,
          records: lockedBundle.services,
          pricing_intent_unchanged: true,
          context: ctxKeep.ok ? ctxKeep.body : null,
          stripe_link_stale: true,
        },
      };
    }

    // Reprice: capacity/config after lock (self-exclusion for course seats).
    let privateLessonConfig = defaultPrivateLessonApi();
    if (input.components.private_lesson) {
      const plLoad = await loadPrivateLessonFromDb(pg, clientSlug, recordLocationId);
      privateLessonConfig = plLoad.api || privateLessonConfig;
    }

    let addonUnitCents = null;
    if (input.components[FULL_DAY_EQUIPMENT_ADDON_KEY]) {
      addonUnitCents = await resolveFullDayEquipmentAddonUnitCents(pg, clientSlug, recordLocationId);
      if (addonUnitCents == null) {
        return rollback({ ok: false, status: 409, body: { success: false, error: 'full_day_equipment_extension_price_unavailable' } });
      }
    }

    let assignedCourse = null;
    let assignedCoursesById = null;
    const {
      shouldPriceGroupLessonsIndividually,
    } = require('./sunset-schedule-lessons');
    const groupLessonsEdit = Array.isArray(input.lessons)
      ? input.lessons.filter((l) => l && l.kind === 'group')
      : [];
    const multiCourseEdit = groupLessonsEdit.length > 0
      && shouldPriceGroupLessonsIndividually(groupLessonsEdit);

    if (multiCourseEdit || (input.components.course && groupLessonsEdit.length > 1)) {
      const { assertCourseAssignable } = require('./sunset-admin-course-join');
      const { packPriceItemCode } = require('./sunset-admin-price-identity');
      assignedCoursesById = {};
      const surfers = input.surfer_count != null
        ? Math.max(1, Number(input.surfer_count) || 1)
        : Math.max(1, Number(input.components.course && input.components.course.quantity) || 1);
      const byCourse = new Map();
      for (const lesson of groupLessonsEdit) {
        const cid = String(lesson.course_id || '').trim();
        if (!cid) continue;
        if (!byCourse.has(cid)) byCourse.set(cid, []);
        byCourse.get(cid).push(lesson);
      }
      for (const [courseId, lessonsForCourse] of byCourse.entries()) {
        const dates = [...new Set(lessonsForCourse.map((l) => String(l.date).slice(0, 10)))].sort();
        const gate = await assertCourseAssignable(pg, {
          clientSlug,
          locationId: recordLocationId,
          courseId,
          serviceDates: dates,
          quantity: surfers,
          excludeBookingId: bookingId,
        });
        if (!gate.ok) return rollback(gate);
        assignedCoursesById[courseId] = gate;
        if (!assignedCourse) assignedCourse = gate;
        for (const lesson of lessonsForCourse) {
          if (!lesson.tier_key) lesson.tier_key = '1_day';
          lesson.offering_id = packPriceItemCode(courseId, lesson.tier_key);
        }
      }
      if (input.components.course && assignedCourse) {
        if (!input.components.course.course_label
          || input.components.course.course_label === input.components.course.course_id) {
          input.components.course.course_label = assignedCourse.course_label
            || input.components.course.course_label;
        }
        if (!input.components.course.tier_key) input.components.course.tier_key = '1_day';
        input.components.course.offering_id = packPriceItemCode(
          input.components.course.course_id,
          input.components.course.tier_key,
        );
      }
    } else if (input.components.course) {
      const { assertCourseAssignable } = require('./sunset-admin-course-join');
      const { packPriceItemCode } = require('./sunset-admin-price-identity');
      const gate = await assertCourseAssignable(pg, {
        clientSlug,
        locationId: recordLocationId,
        courseId: input.components.course.course_id,
        serviceDates: input.service_dates,
        quantity: input.components.course.quantity,
        excludeBookingId: bookingId,
      });
      if (!gate.ok) return rollback(gate);
      assignedCourse = gate;
      if (!input.components.course.course_label
        || input.components.course.course_label === input.components.course.course_id) {
        input.components.course.course_label = gate.course_label || input.components.course.course_label;
      }
      const tierKey = String(input.components.course.tier_key || '').trim();
      if (tierKey) {
        input.components.course.offering_id = packPriceItemCode(
          input.components.course.course_id,
          tierKey,
        );
      }
    }

    // Re-lock ledger immediately before delete so concurrent payment insert serializes.
    const rePay = await lockSchedulePaymentsForUpdate(pg, bookingId, clientId);
    lockedBundle.payments_paid_cents = rePay.paidCents;
    lockedBundle.locked_payments = rePay.rows;
    if (isSunsetBookingFinanciallyCommitted(lockedBundle)) {
      return rollback(paidBookingRepriceRequiredResult());
    }

    const headerUpd = await pg.query(
      // MULTICLIENT_SCOPE_OK: Edit reprice header
      `UPDATE bookings
          SET guest_name = $1,
              phone = NULLIF($2, ''),
              status = $3::booking_status,
              payment_status = $4::payment_status,
              check_in = $5::date,
              check_out = ($6::date + INTERVAL '1 day')::date,
              guest_count = $7,
              metadata = COALESCE(metadata, '{}'::jsonb) || $8::jsonb
        WHERE id = $9::uuid AND client_id = $10::uuid`,
      [
        input.guest_name, guest_phone, bookingStatus, bookingPayment, firstDate, lastDate,
        guestCount, JSON.stringify(headerMetaPatch), bookingId, clientId,
      ],
    );
    if (Number(headerUpd && headerUpd.rowCount) !== 1) {
      return rollback({ ok: false, status: 409, body: { success: false, error: 'booking_update_conflict' } });
    }

    await pg.query(
      `DELETE FROM booking_service_records
        WHERE client_slug = $1 AND booking_id = $2::uuid AND source = ANY($3::text[])`,
      [clientSlug, bookingId, [DB_SOURCE, LUNA_DB_SOURCE]],
    );

    const bookingCode = lockedBundle.booking.booking_code;
    const createdRows = await insertScheduleComponentServiceRows(pg, {
      clientSlug, bookingId, bookingCode, input, componentKeys,
      attribution: editAttribution, locationId: recordLocationId, srPayment,
      privateLessonConfig, assignedCourse, assignedCoursesById, canonicalRentals,
      rentalSpanDates,
      rentalPricingGroupId, rentalPricingDescriptor, bundleId,
      privateLessonDefaultLabel: 'Private Course',
      wrapMeta: (meta, loc) => attachLocationToMetadata(meta, loc),
      metaBase: {
        updated_by_staff: editAttribution.lastEditedByStaff,
        last_edited_by_staff: editAttribution.lastEditedByStaff,
      },
    });

    // Generic Admin catalog rentals — same Create insert path (auditable rows).
    for (const descriptor of genericPrep.records || []) {
      const meta = attachLocationToMetadata({
        ...descriptor.metadata,
        source: editAttribution.metadataSource,
        staff_manual_schedule: editAttribution.staffManualSchedule,
        bundle_id: bundleId,
        updated_by_staff: editAttribution.lastEditedByStaff,
        last_edited_by_staff: editAttribution.lastEditedByStaff,
      }, recordLocationId);
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
        [
          clientSlug, bookingId, bookingCode, input.guest_name, descriptor.service_type,
          descriptor.service_date || firstDate, descriptor.quantity, descriptor.amount_due_cents,
          srPayment, editAttribution.dbSource, JSON.stringify(meta),
        ],
      );
      createdRows.push(ins.rows[0]);
    }

    if (require('./sunset-course-equipment-options').isPresentCourseEquipmentSelection(input.course_equipment)) {
      const { listRentalOfferings } = require('./tenant-rental-offerings');
      const rentalOfferings = await listRentalOfferings(pg, {
        clientSlug, locationId: recordLocationId, includeInactive: false,
      });
      const groupLessonsCE = Array.isArray(input.lessons)
        ? input.lessons.filter((l) => l && l.kind === 'group')
        : [];
      let equipmentCourses = null;
      let equipmentCourse = null;
      let equipmentSurfers = null;
      let equipmentDates = null;
      if (input.components.private_lesson) {
        equipmentCourse = privateLessonConfig;
        equipmentSurfers = input.components.private_lesson.surfer_count;
        equipmentDates = (input.components.private_lesson.sessions || []).map((s) => s.date);
      } else if (groupLessonsCE.length) {
        const { uniqueCalendarDates } = require('./sunset-schedule-lessons');
        const courseIds = [...new Set(groupLessonsCE.map((l) => String(l.course_id).trim()))];
        equipmentCourses = courseIds.map((cid) => {
          const assigned = (assignedCoursesById && assignedCoursesById[cid])
            || (assignedCourse && String(assignedCourse.course_id || '') === cid ? assignedCourse : null);
          return assigned && assigned.pack
            ? { ...assigned.pack, course_id: cid, pack_id: assigned.pack.pack_id || cid }
            : null;
        }).filter(Boolean);
        if (equipmentCourses.length !== courseIds.length) {
          if (courseIds.length === 1 && assignedCourse && assignedCourse.pack) {
            equipmentCourses = [{
              ...assignedCourse.pack,
              course_id: courseIds[0],
              pack_id: assignedCourse.pack.pack_id || courseIds[0],
            }];
          } else {
            return rollback({
              ok: false,
              status: 422,
              body: {
                success: false,
                reason: 'course_equipment_not_authorized_for_all_courses',
                reason_code: 'course_equipment_not_authorized_for_all_courses',
                error: 'course equipment requires pack config for every selected course',
              },
            });
          }
        }
        equipmentSurfers = input.surfer_count != null
          ? input.surfer_count
          : (input.components.course && input.components.course.quantity);
        equipmentDates = uniqueCalendarDates(groupLessonsCE);
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
        attribution: editAttribution, locationId: recordLocationId, bundleId, srPayment,
      });
      equipmentRows.forEach((r) => createdRows.push(r));
    }

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
        locationId: recordLocationId,
        srPayment,
        notes: input.notes || null,
        needsReply: input.needs_reply,
        guestPhone: guest_phone || null,
        actorEmail: editAttribution.lastEditedByStaff,
        idempotencyKey: null,
        attribution: editAttribution,
      });
      addonRows.forEach((r) => createdRows.push(r));
    }

    // Staff custom commercial adjustments — same Create path (auditable rows + quote claim).
    if (input.custom_line_items && input.custom_line_items.length) {
      const customRows = await insertStaffCustomLineServiceRows(pg, {
        clientSlug,
        bookingId,
        bookingCode,
        guestName: input.guest_name,
        serviceDate: firstDate,
        srPayment,
        attribution: editAttribution,
        locationId: recordLocationId,
        componentKeys,
        bundleId,
        notes: input.notes || null,
        needsReply: input.needs_reply,
        customLineItems: input.custom_line_items,
        metaBase: {
          updated_by_staff: editAttribution.lastEditedByStaff,
          last_edited_by_staff: editAttribution.lastEditedByStaff,
        },
      });
      customRows.forEach((r) => createdRows.push(r));
    }

    // Staff Accommodation — edit parity: multi-stay add/edit/remove/reprice.
    // New add while product disabled is blocked; existing dedicated stays may
    // reprice (historical). Permission is derived only from locked service rows.
    const {
      isStaffAccommodationMeta,
      accommodationStaysFromSelection,
    } = require('./sunset-accommodation-price-resolver');
    const existingAccomRows = (lockedBundle.services || []).filter((sr) => {
      const m = parseMeta(sr.metadata);
      return isStaffAccommodationMeta(m);
    });
    const hadStaffAccommodation = existingAccomRows.length > 0;
    const existingAccommodationStayCount = existingAccomRows.length;
    if (input.accommodation && input.accommodation.enabled) {
      const { resolveAccommodationPrice, loadAccommodationConfig } = require('./sunset-accommodation-admin');
      const accomStays = accommodationStaysFromSelection(input.accommodation);
      // Growth beyond historical stay count requires product explicitly enabled.
      // Config load failure or disabled must block net-new before insert —
      // do not rely on later quote rollback or requireEnabled:false.
      if (hadStaffAccommodation && accomStays.length > existingAccommodationStayCount) {
        let cfg;
        try {
          cfg = await loadAccommodationConfig(pg, clientSlug, recordLocationId);
        } catch (_cfg) {
          return rollback({
            ok: false,
            status: 409,
            body: {
              success: false,
              error: 'Accommodation config unavailable; cannot add new stays to this booking.',
              reason_code: 'accommodation_disabled',
            },
          });
        }
        if (!cfg || cfg.enabled !== true) {
          return rollback({
            ok: false,
            status: 409,
            body: {
              success: false,
              error: 'Accommodation is disabled; cannot add new stays to this booking.',
              reason_code: 'accommodation_disabled',
            },
          });
        }
      }
      for (const stay of accomStays) {
        const accomRes = await resolveAccommodationPrice(pg, {
          clientSlug,
          locationId: recordLocationId,
          checkIn: stay.check_in,
          checkOut: stay.check_out,
          requireEnabled: !hadStaffAccommodation,
        });
        if (!accomRes.ok) {
          return rollback({
            ok: false,
            status: accomRes.status || 422,
            body: accomRes.body || {
              success: false,
              error: accomRes.error,
              reason_code: accomRes.reason_code,
              uncovered_nights: accomRes.uncovered_nights || null,
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
          attribution: editAttribution,
          locationId: recordLocationId,
          componentKeys,
          bundleId,
          notes: input.notes || null,
          needsReply: input.needs_reply,
          priced: accomRes.priced,
          clientStayId: stay.client_stay_id || null,
          metaBase: {
            updated_by_staff: editAttribution.lastEditedByStaff,
            last_edited_by_staff: editAttribution.lastEditedByStaff,
          },
        });
        if (accomRow) createdRows.push(accomRow);
      }
    }

    // Authoritative re-quote body must carry custom lines + accommodation + components/dates/rentals/lessons.
    const quotePrepBody = {
      ...(rentalPrep.body && typeof rentalPrep.body === 'object' ? rentalPrep.body : {}),
      guest_name: input.guest_name,
      guest_phone: guest_phone || null,
      payment_status: input.payment_status,
      notes: input.notes || '',
      components: input.components,
      lessons: Array.isArray(input.lessons) ? input.lessons : null,
      custom_line_items: input.custom_line_items || [],
      accommodation: input.accommodation || null,
      surfer_count: input.surfer_count != null ? input.surfer_count : null,
      date_from: firstDate,
      date_to: lastDate,
      service_dates: input.service_dates,
      course_equipment: input.course_equipment || null,
    };
    if (rentalsPresentOnPatch) {
      // Canonical keys only on quote transport body — generic priced via records.
      if (canonicalRentals && canonicalRentals.length) quotePrepBody.rentals = canonicalRentals;
      else delete quotePrepBody.rentals;
    } else if (rentalPrep.present && rentalPrep.rentals) {
      quotePrepBody.rentals = rentalPrep.rentals;
    } else if (canonicalRentals && canonicalRentals.length) {
      quotePrepBody.rentals = canonicalRentals;
    }

    // Shared Create dual path: exact claim then total/balance before COMMIT.
    // Thread locked-bundle historical accommodation permission into quote only.
    await applyAuthoritativeSchedulePricingInTxn(pg, {
      clientSlug, bookingId, clientId, createdRows,
      locationId: recordLocationId,
      lockedPaidCents: lockedBundle.payments_paid_cents,
      canonicalRentals,
      genericRentalRecords: genericPrep.records,
      rentalPrepBody: quotePrepBody,
      quotePrepBody: quotePrepBody,
      rentalPricingDescriptor,
      quoteChannel: opts.quoteChannel,
      quoteProvenance: opts.quoteProvenance,
      allowExistingAccommodationWhenDisabled: hadStaffAccommodation,
      existingAccommodationStayCount,
      now: opts.now,
    });

    if (input.payment_status === 'paid') {
      const paidApply = await applyEditPaidAmountInTxn(pg, {
        bookingId, clientId, paymentsPaidCents: lockedBundle.payments_paid_cents,
        paymentMethod, actorEmail: editAttribution.lastEditedByStaff,
      });
      if (!paidApply.ok) return rollback(paidApply);
    }

    await pg.query('COMMIT');
    const ctx = await getSunsetScheduleBookingDrawerContext(pg, { clientSlug, bookingId });
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        booking_id: bookingId,
        booking_code: bookingCode,
        records: createdRows,
        context: ctx.ok ? ctx.body : null,
        stripe_link_stale: true,
      },
    };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) { /* ignore */ }
    if (err && err.sunsetPriceFail) return err.sunsetPriceFail;
    throw err;
  }
}

// Soft-delete a staff-created schedule booking: mark the booking + its service records cancelled
// so they drop off the schedule (the day query filters out cancelled bookings/records).
async function cancelSunsetScheduleBooking(pg, opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, body: { success: false, error: 'unsupported_client' } };
  }
  const bookingId = String(opts.bookingId || opts.body?.booking_id || '').trim();
  if (!bookingId || !isUuid(bookingId)) {
    return { ok: false, status: 400, body: { success: false, error: 'booking_id is required' } };
  }

  let began = false;
  try {
    await pg.query('BEGIN');
    began = true;

    // Single authoritative booking lock: FOR UPDATE OF b NOWAIT on the first booking SELECT.
    // No earlier blocking lock. No service-row FOR UPDATE (deadlock/timeout risk).
    let bundle;
    try {
      bundle = await loadSunsetBookingBundle(pg, clientSlug, bookingId, null, true, {
        bookingLock: 'nowait',
        lockServices: false,
      });
    } catch (lockErr) {
      const msg = String(lockErr && lockErr.message || lockErr || '');
      await pg.query('ROLLBACK'); began = false;
      if (/could not obtain lock|lock_not_available|55P03/i.test(msg)) {
        return {
          ok: false,
          status: 409,
          body: {
            success: false,
            error: 'booking_busy',
            message: 'This booking is being updated. Try cancel again in a moment.',
            detail: msg.slice(0, 200),
          },
        };
      }
      return {
        ok: false,
        status: 500,
        body: { success: false, error: 'cancel_failed', detail: msg.slice(0, 240) },
      };
    }

    if (!bundle) {
      await pg.query('ROLLBACK'); began = false;
      return { ok: false, status: 404, body: { success: false, error: 'booking not found' } };
    }

    const activeLocationId = normalizeSunsetLocationId(opts.locationId);
    if (resolveBundleLocationId(bundle) !== activeLocationId) {
      await pg.query('ROLLBACK'); began = false;
      return { ok: false, status: 404, body: { success: false, error: 'booking_not_in_active_school' } };
    }
    if (!bundleHasTrustedScheduleDrawerAttribution(bundle)) {
      await pg.query('ROLLBACK'); began = false;
      return {
        ok: false,
        status: 403,
        body: {
          success: false,
          error: 'delete_untrusted_booking_source',
          reason_code: 'delete_untrusted_booking_source',
        },
      };
    }
    if (String(bundle.booking.status || '').toLowerCase() === 'cancelled'
      || String(bundle.booking.status || '').toLowerCase() === 'canceled') {
      await pg.query('ROLLBACK'); began = false;
      return {
        ok: true,
        status: 200,
        body: {
          success: true,
          cancelled: true,
          deleted: false,
          idempotent: true,
          booking_id: bookingId,
        },
      };
    }

    const paidCents = Number(bundle.payments_paid_cents || 0);

    // Original cancel semantics (paid allowed): BSR + booking status.
    await pg.query(
      `UPDATE booking_service_records SET status = 'cancelled'
        WHERE client_slug = $1 AND booking_id = $2::uuid AND status <> 'cancelled'`,
      [clientSlug, bookingId],
    );

    const cancelUpd = await pg.query(
      // MULTICLIENT_SCOPE_OK: cancel via client join trust boundary
      `UPDATE bookings b SET status = 'cancelled'::booking_status,
              metadata = COALESCE(b.metadata, '{}'::jsonb) || $1::jsonb
        FROM clients c
        WHERE b.id = $2::uuid AND c.id = b.client_id AND c.slug = $3`,
      [JSON.stringify({
        cancelled_by_staff: true,
        cancelled_at: new Date().toISOString(),
      }), bookingId, clientSlug],
    );
    if (Number(cancelUpd && cancelUpd.rowCount) !== 1) {
      await pg.query('ROLLBACK'); began = false;
      return { ok: false, status: 409, body: { success: false, error: 'booking_cancel_conflict' } };
    }

    // Void open unpaid checkout links before COMMIT (same SQL as deleteSunsetScheduleStripeLink).
    let voidedCount = 0;
    try {
      const voidPay = await pg.query(
        `UPDATE payments
            SET checkout_url = NULL,
                metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
          WHERE booking_id = $1::uuid
            AND checkout_url IS NOT NULL
            AND status IN ('draft'::payment_record_status, 'checkout_created'::payment_record_status)`,
        [bookingId, JSON.stringify({
          voided_by_staff: true,
          voided_at: new Date().toISOString(),
          voided_reason: 'booking_cancelled',
        })],
      );
      voidedCount = Number(voidPay && voidPay.rowCount) || 0;
      await pg.query(
        `UPDATE bookings
            SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
          WHERE id = $2::uuid`,
        [JSON.stringify({
          sunset_stripe_link_stale: true,
          last_payment_link_url: null,
          payment_link_invalidated: true,
          payment_link_generation: crypto.randomBytes(16).toString('hex'),
        }), bookingId],
      );
    } catch (linkErr) {
      await pg.query('ROLLBACK'); began = false;
      return {
        ok: false,
        status: 500,
        body: {
          success: false,
          error: 'payment_link_invalidate_failed',
          message: 'Could not invalidate open payment links; cancel was not applied.',
          detail: linkErr && linkErr.message ? String(linkErr.message).slice(0, 240) : undefined,
        },
      };
    }

    await pg.query('COMMIT');
    began = false;

    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        cancelled: true,
        deleted: false,
        booking_id: bookingId,
        booking_code: bundle.booking.booking_code,
        payments_paid_cents: paidCents,
        payment_links_voided: voidedCount,
      },
    };
  } catch (err) {
    if (began) {
      try { await pg.query('ROLLBACK'); } catch (_) { /* ignore */ }
    }
    return {
      ok: false,
      status: 500,
      body: {
        success: false,
        error: 'cancel_failed',
        message: 'Could not cancel booking.',
        detail: err && err.message ? String(err.message).slice(0, 240) : undefined,
      },
    };
  }
}
async function hideSunsetScheduleBooking(pg, opts) {
  return archiveSunsetScheduleBooking(pg, opts);
}

async function archiveSunsetScheduleBooking(pg, opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, body: { success: false, error: 'unsupported_client' } };
  }
  const bookingId = String(opts.bookingId || opts.body?.booking_id || '').trim();
  if (!bookingId || !isUuid(bookingId)) {
    return { ok: false, status: 400, body: { success: false, error: 'booking_id is required' } };
  }
  await pg.query('BEGIN');
  try {
    const bundle = await loadSunsetBookingBundle(pg, clientSlug, bookingId, null, true);
    const reject = async (result) => { await pg.query('ROLLBACK'); return result; };
    if (!bundle) return reject({ ok: false, status: 404, body: { success: false, error: 'booking not found' } });
    const activeLocationId = normalizeSunsetLocationId(opts.locationId);
    if (resolveBundleLocationId(bundle) !== activeLocationId) {
      return reject({ ok: false, status: 404, body: { success: false, error: 'booking_not_in_active_school' } });
    }
    if (!bundleHasTrustedScheduleDrawerAttribution(bundle)) {
      return reject({ ok: false, status: 403, body: { success: false, error: 'delete_untrusted_booking_source', reason_code: 'delete_untrusted_booking_source' } });
    }
    const st = String(bundle.booking.status || '').toLowerCase();
    if (st !== 'cancelled' && st !== 'canceled') {
      return reject({ ok: false, status: 409, body: { success: false, error: 'cancel_before_archive', message: 'Cancel the booking before removing it from the schedule.' } });
    }
    const meta = bundle.booking.metadata && typeof bundle.booking.metadata === 'object' ? bundle.booking.metadata : {};
    if (meta.schedule_archived === true || meta.schedule_archived === 'true') {
      await pg.query('ROLLBACK');
      return { ok: true, status: 200, body: { success: true, archived: true, idempotent: true, booking_id: bookingId } };
    }
    // Never DELETE bookings row — payments.booking_id ON DELETE CASCADE would destroy money truth.
    const patch = {
      schedule_archived: true,
      schedule_archived_at: new Date().toISOString(),
      schedule_archived_by_staff: true,
    };
    const upd = await pg.query(
      `UPDATE bookings b SET hidden = true,
             metadata = COALESCE(b.metadata, '{}'::jsonb) || $1::jsonb
        FROM clients c
        WHERE b.id = $2::uuid AND c.id = b.client_id AND c.slug = $3`,
      [JSON.stringify(patch), bookingId, clientSlug],
    );
    if (Number(upd && upd.rowCount) !== 1) {
      await pg.query('ROLLBACK');
      return { ok: false, status: 409, body: { success: false, error: 'booking_archive_conflict' } };
    }
    await pg.query(
      `UPDATE booking_service_records
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
        WHERE client_slug = $2 AND booking_id = $3::uuid`,
      [JSON.stringify({ schedule_archived: true }), clientSlug, bookingId],
    );

    // Classify payments for Finance exclusion. Never DELETE payments/payment_events.
    // Never call Stripe refund APIs. Refund is assumed manual/external.
    const paidCents = Number(bundle.payments_paid_cents || 0);
    const dueCents = Number(
      bundle.booking.total_amount_cents != null
        ? bundle.booking.total_amount_cents
        : (bundle.services || []).reduce((sum, sr) => sum + (Number(sr.amount_due_cents) || 0), 0),
    );
    let captureClass = 'none';
    if (paidCents > 0 && dueCents > 0 && paidCents < dueCents) captureClass = 'partial';
    else if (paidCents > 0 && (dueCents <= 0 || paidCents >= dueCents)) captureClass = 'full';
    else if (paidCents > 0) captureClass = 'full';

    const classifyMeta = {
      schedule_booking_deleted: true,
      schedule_booking_deleted_at: new Date().toISOString(),
      payment_capture_class: captureClass,
      refund_handling: 'assumed_manual_external',
      finance_exclusion_reason: 'schedule_booking_deleted',
    };
    await pg.query(
      `UPDATE payments p
          SET finance_exclusion = 'deleted_cancelled_booking',
              metadata = COALESCE(p.metadata, '{}'::jsonb) || $2::jsonb
         FROM bookings b
         JOIN clients c ON c.id = b.client_id
        WHERE p.booking_id = $1::uuid
          AND p.client_id = b.client_id
          AND b.id = $1::uuid
          AND c.slug = $3
          AND p.finance_exclusion IS NULL`,
      [bookingId, JSON.stringify(classifyMeta), clientSlug],
    );

    await pg.query('COMMIT');
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        archived: true,
        deleted: false,
        booking_id: bookingId,
        booking_code: bundle.booking.booking_code,
        payment_capture_class: captureClass,
        payments_paid_cents: paidCents,
      },
    };
  } catch (err) {
    await pg.query('ROLLBACK');
    throw err;
  }
}

async function restoreSunsetScheduleBooking(pg, opts) {
  const clientSlug = String(opts.clientSlug || '').trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, body: { success: false, error: 'unsupported_client' } };
  }
  const bookingId = String(opts.bookingId || opts.body?.booking_id || '').trim();
  if (!bookingId || !isUuid(bookingId)) {
    return { ok: false, status: 400, body: { success: false, error: 'booking_id is required' } };
  }

  let began = false;
  try {
    await pg.query('BEGIN');
    began = true;

    let bundle;
    try {
      bundle = await loadSunsetBookingBundle(pg, clientSlug, bookingId, null, true, {
        bookingLock: 'nowait',
        lockServices: false,
      });
    } catch (lockErr) {
      const msg = String(lockErr && lockErr.message || lockErr || '');
      await pg.query('ROLLBACK'); began = false;
      if (/could not obtain lock|lock_not_available|55P03/i.test(msg)) {
        return {
          ok: false,
          status: 409,
          body: {
            success: false,
            error: 'booking_busy',
            message: 'This booking is being updated. Try restore again in a moment.',
            detail: msg.slice(0, 200),
          },
        };
      }
      return {
        ok: false,
        status: 500,
        body: { success: false, error: 'restore_failed', detail: msg.slice(0, 240) },
      };
    }

    if (!bundle) {
      await pg.query('ROLLBACK'); began = false;
      return { ok: false, status: 404, body: { success: false, error: 'booking not found' } };
    }

    const activeLocationId = normalizeSunsetLocationId(opts.locationId);
    if (resolveBundleLocationId(bundle) !== activeLocationId) {
      await pg.query('ROLLBACK'); began = false;
      return { ok: false, status: 404, body: { success: false, error: 'booking_not_in_active_school' } };
    }
    if (!bundleHasTrustedScheduleDrawerAttribution(bundle)) {
      await pg.query('ROLLBACK'); began = false;
      return {
        ok: false,
        status: 403,
        body: {
          success: false,
          error: 'delete_untrusted_booking_source',
          reason_code: 'delete_untrusted_booking_source',
        },
      };
    }

    const meta = parseMeta(bundle.booking.metadata);
    if (meta.schedule_archived === true || meta.schedule_archived === 'true') {
      await pg.query('ROLLBACK'); began = false;
      return {
        ok: false,
        status: 409,
        body: {
          success: false,
          error: 'booking_archived',
          message: 'Deleted bookings cannot be restored onto the operational schedule.',
        },
      };
    }

    const st = String(bundle.booking.status || '').toLowerCase();
    if (st !== 'cancelled' && st !== 'canceled') {
      await pg.query('ROLLBACK'); began = false;
      return {
        ok: false,
        status: 409,
        body: { success: false, error: 'booking_not_cancelled', message: 'Only cancelled bookings can be restored.' },
      };
    }

    // Recheck authoritative course capacity while locked. Cancelled seats are
    // already excluded from occupancy counts, so excludeBookingId is belt-and-braces.
    const agg = aggregateComponentsFromServices(bundle.services || []);

    // full_day_equipment_extension is non-course only; course keep-all-day is
    // course_equipment mode:all_day. Course/private identity comes from persisted
    // component metadata — ordinary part-day lesson (component:lesson) + extension
    // remains restorable.
    {
      const FULL_DAY_KEY = 'full_day_equipment_extension';
      let hasCourseOrPrivate = !!(agg.components && (agg.components.course || agg.components.private_lesson));
      let hasFda = false;
      let hasCeAllDay = false;
      for (const sr of (bundle.services || [])) {
        const md = parseMeta(sr.metadata);
        const component = String(md.component || sr.metadata_component || '').toLowerCase();
        const serviceKey = String(md.service_key || '').toLowerCase();
        const staffUi = String(md.staff_ui_service_type || '').toLowerCase();
        if (md.course_equipment === true && md.course_equipment_mode === 'all_day') {
          hasCeAllDay = true;
        }
        if (component === FULL_DAY_KEY || serviceKey === FULL_DAY_KEY
          || staffUi === FULL_DAY_KEY) {
          hasFda = true;
        }
        // Configured course / private only — not ordinary group lesson rows.
        if (component === 'course' || component === 'private_lesson'
          || staffUi === 'course' || staffUi === 'private_lesson') {
          hasCourseOrPrivate = true;
        }
      }
      if (hasFda && hasCourseOrPrivate) {
        await pg.query('ROLLBACK'); began = false;
        return {
          ok: false,
          status: 409,
          body: {
            success: false,
            error: 'full_day_equipment_extension_not_with_course',
            reason_code: 'full_day_equipment_extension_not_with_course',
            message: 'Cannot restore: full-day gear extension is not valid with a course booking.',
          },
        };
      }
      if (hasFda && hasCeAllDay) {
        await pg.query('ROLLBACK'); began = false;
        return {
          ok: false,
          status: 409,
          body: {
            success: false,
            error: 'course_equipment_full_day_overlap',
            reason_code: 'course_equipment_full_day_overlap',
            message: 'Cannot restore: course all-day equipment and full-day extension cannot coexist.',
          },
        };
      }
    }
    const courseIds = new Set();
    const dateByCourse = new Map();
    for (const sr of (bundle.services || [])) {
      const md = parseMeta(sr.metadata);
      const courseId = String(md.course_id || '').trim();
      const component = String(md.component || sr.metadata_component || '').toLowerCase();
      const dateIso = String(sr.service_date || '').slice(0, 10);
      if (!courseId || !dateIso) continue;
      if (component && !['course', 'lesson', 'group_lesson', 'surf_lesson', ''].includes(component)
        && String(sr.service_type || '').toLowerCase() !== 'surf_lesson') {
        continue;
      }
      if (String(sr.service_type || '').toLowerCase() === 'surf_lesson' || component === 'course' || component === 'lesson' || component === 'group_lesson') {
        courseIds.add(courseId);
        if (!dateByCourse.has(courseId)) dateByCourse.set(courseId, new Set());
        dateByCourse.get(courseId).add(dateIso);
      }
    }
    if (agg.components && agg.components.course && agg.components.course.course_id) {
      courseIds.add(String(agg.components.course.course_id).trim());
    }
    if (agg.components && Array.isArray(agg.components.course && agg.components.course.selected_courses)) {
      for (const sc of agg.components.course.selected_courses) {
        if (sc && sc.course_id) courseIds.add(String(sc.course_id).trim());
      }
    }

    const surfers = Math.max(
      1,
      Number((agg.components && agg.components.course && agg.components.course.quantity) || 0)
        || Number(bundle.booking.guest_count) || 1,
    );

    if (courseIds.size) {
      const { assertCourseAssignable } = require('./sunset-admin-course-join');
      for (const courseId of courseIds) {
        const dates = [...(dateByCourse.get(courseId) || new Set())].sort();
        const serviceDates = dates.length
          ? dates
          : [...new Set((bundle.services || []).map((sr) => String(sr.service_date || '').slice(0, 10)).filter(Boolean))].sort();
        if (!serviceDates.length) {
          await pg.query('ROLLBACK'); began = false;
          return {
            ok: false,
            status: 409,
            body: { success: false, error: 'restore_dates_missing', course_id: courseId },
          };
        }
        const gate = await assertCourseAssignable(pg, {
          clientSlug,
          locationId: activeLocationId,
          courseId,
          serviceDates,
          quantity: surfers,
          excludeBookingId: bookingId,
        });
        if (!gate.ok) {
          await pg.query('ROLLBACK'); began = false;
          return gate;
        }
      }
    }

    // Catalog + physical stock for rental / course-equipment offerings.
    // Restore must recheck remaining stock (cancel released demand) inside this txn.
    const offeringKeys = new Set();
    for (const sr of (bundle.services || [])) {
      const md = parseMeta(sr.metadata);
      const key = String(md.offering_key || '').trim();
      if (!key) continue;
      const stype = String(sr.service_type || '').toLowerCase();
      if (md.course_equipment === true || stype === 'surfboard' || stype === 'wetsuit' || stype === 'addon_service' || md.component === 'rental' || md.staff_ui_service_type === 'rental' || md.rental_offering === true) {
        offeringKeys.add(key);
      }
    }
    if (offeringKeys.size) {
      const { listRentalOfferings } = require('./tenant-rental-offerings');
      let offerings;
      try {
        offerings = await listRentalOfferings(pg, {
          clientSlug,
          locationId: activeLocationId,
          includeInactive: false,
        });
      } catch (err) {
        await pg.query('ROLLBACK'); began = false;
        return {
          ok: false,
          status: 409,
          body: {
            success: false,
            error: 'rental_catalog_unavailable',
            detail: err && err.message ? String(err.message).slice(0, 200) : undefined,
          },
        };
      }
      const activeKeys = new Set((offerings || []).map((o) => String(o.offering_key || o.key || '').trim()).filter(Boolean));
      for (const key of offeringKeys) {
        if (!activeKeys.has(key)) {
          await pg.query('ROLLBACK'); began = false;
          return {
            ok: false,
            status: 409,
            body: {
              success: false,
              error: 'rental_offering_unavailable',
              offering_key: key,
              message: 'Equipment/rental offering is no longer available; restore left cancelled.',
            },
          };
        }
      }

      // Physical stock recheck (cancelled demand is already excluded from counts).
      // Exclude this booking id so any residual rows cannot double-count.
      const {
        collectRentalStockClaimsFromServices,
        assertRentalStockClaimsInTxn,
        stockFailureHttp,
      } = require('./tenant-rental-stock-service');
      const { DEFAULT_SUNSET_LOCATION_ID } = require('./sunset-school-locations');
      const claimsPack = collectRentalStockClaimsFromServices(bundle.services || []);
      if (claimsPack.ok && claimsPack.claims.length) {
        const stockAssert = await assertRentalStockClaimsInTxn(pg, {
          clientSlug,
          locationId: activeLocationId,
          claims: claimsPack.claims,
          excludeBookingId: bookingId,
          defaultLocationId: clientSlug === SUNSET_CLIENT_SLUG ? DEFAULT_SUNSET_LOCATION_ID : null,
        });
        if (!stockAssert.ok) {
          await pg.query('ROLLBACK'); began = false;
          const http = stockFailureHttp(stockAssert);
          return {
            ok: false,
            status: (http && http.status) || 409,
            body: (http && http.body) || {
              success: false,
              error: stockAssert.error,
              reason_code: stockAssert.error,
              message: 'Not enough rental stock to restore this booking.',
            },
          };
        }
      }
    }

    // Restore BSR + booking. Do NOT reactivate voided Stripe links or clear invalidate flags.
    await pg.query(
      `UPDATE booking_service_records
          SET status = 'confirmed',
              metadata = COALESCE(metadata, '{}'::jsonb) - 'schedule_archived'
        WHERE client_slug = $1 AND booking_id = $2::uuid AND status = 'cancelled'`,
      [clientSlug, bookingId],
    );

    const paidCents = Number(bundle.payments_paid_cents || 0);
    const restoreStatus = paidCents > 0 ? 'confirmed' : 'payment_pending';
    const restoreMeta = {
      schedule_restored: true,
      schedule_restored_at: new Date().toISOString(),
      schedule_restored_by_staff: true,
    };
    const restoreUpd = await pg.query(
      // MULTICLIENT_SCOPE_OK: restore via client join trust boundary
      `UPDATE bookings b
          SET status = $1::booking_status,
              metadata = (COALESCE(b.metadata, '{}'::jsonb) || $2::jsonb)
        FROM clients c
        WHERE b.id = $3::uuid AND c.id = b.client_id AND c.slug = $4
          AND LOWER(b.status::text) IN ('cancelled', 'canceled')`,
      [restoreStatus, JSON.stringify(restoreMeta), bookingId, clientSlug],
    );
    if (Number(restoreUpd && restoreUpd.rowCount) !== 1) {
      await pg.query('ROLLBACK'); began = false;
      return { ok: false, status: 409, body: { success: false, error: 'booking_restore_conflict' } };
    }

    await pg.query('COMMIT');
    began = false;
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        restored: true,
        booking_id: bookingId,
        booking_code: bundle.booking.booking_code,
        booking_status: restoreStatus,
        payments_paid_cents: paidCents,
        payment_links_reactivated: false,
      },
    };
  } catch (err) {
    if (began) {
      try { await pg.query('ROLLBACK'); } catch (_) { /* ignore */ }
    }
    return {
      ok: false,
      status: 500,
      body: {
        success: false,
        error: 'restore_failed',
        message: 'Could not restore booking.',
        detail: err && err.message ? String(err.message).slice(0, 240) : undefined,
      },
    };
  }
}


/**
 * Unhide a cancelled booking (Bookings tab only). Clears hidden + legacy archive meta.
 */
async function unhideSunsetScheduleBooking(pg, opts) {
  const clientSlug = String((opts && opts.clientSlug) || '').trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, status: 403, body: { success: false, error: 'unsupported_client' } };
  }
  const bookingId = String((opts && (opts.bookingId || (opts.body && opts.body.booking_id))) || '').trim();
  if (!bookingId || !isUuid(bookingId)) {
    return { ok: false, status: 400, body: { success: false, error: 'booking_id is required' } };
  }
  let began = false;
  try {
    await pg.query('BEGIN');
    began = true;
    // Positional load/lock — same signature as archive/hide/cancel owners.
    const bundle = await loadSunsetBookingBundle(pg, clientSlug, bookingId, null, true);
    const reject = async (result) => {
      await pg.query('ROLLBACK');
      began = false;
      return result;
    };
    if (!bundle || !bundle.booking) {
      return reject({ ok: false, status: 404, body: { success: false, error: 'booking not found' } });
    }
    const activeLocationId = normalizeSunsetLocationId(opts && opts.locationId);
    if (resolveBundleLocationId(bundle) !== activeLocationId) {
      return reject({
        ok: false,
        status: 404,
        body: { success: false, error: 'booking_not_in_active_school' },
      });
    }
    const st = String(bundle.booking.status || '').toLowerCase();
    if (st !== 'cancelled' && st !== 'canceled') {
      return reject({
        ok: false,
        status: 409,
        body: {
          success: false,
          error: 'booking_not_cancelled',
          message: 'Only cancelled bookings can be unhidden.',
        },
      });
    }
    const meta = bundle.booking.metadata && typeof bundle.booking.metadata === 'object'
      ? bundle.booking.metadata
      : {};
    const alreadyVisible = !(
      bundle.booking.hidden === true
      || bundle.booking.hidden === 'true'
      || bundle.booking.hidden === 1
      || meta.schedule_archived === true
      || meta.schedule_archived === 'true'
    );
    if (alreadyVisible) {
      await pg.query('ROLLBACK');
      began = false;
      return {
        ok: true,
        status: 200,
        body: { success: true, hidden: false, idempotent: true, booking_id: bookingId },
      };
    }
    const upd = await pg.query(
      `UPDATE bookings b SET hidden = false,
             metadata = COALESCE(b.metadata, '{}'::jsonb)
               - 'schedule_archived' - 'schedule_archived_at' - 'schedule_archived_by_staff'
               || jsonb_build_object('schedule_unhidden_at', $3::text)
        FROM clients c
       WHERE c.id = b.client_id AND c.slug = $1 AND b.id = $2::uuid`,
      [clientSlug, bookingId, new Date().toISOString()],
    );
    if (Number(upd && upd.rowCount) !== 1) {
      return reject({ ok: false, status: 409, body: { success: false, error: 'booking_unhide_conflict' } });
    }
    // Clear legacy archive flags on service records so ghosts can reappear.
    await pg.query(
      `UPDATE booking_service_records
          SET metadata = COALESCE(metadata, '{}'::jsonb) - 'schedule_archived'
        WHERE client_slug = $1 AND booking_id = $2::uuid`,
      [clientSlug, bookingId],
    );
    await pg.query('COMMIT');
    began = false;
    return { ok: true, status: 200, body: { success: true, hidden: false, booking_id: bookingId } };
  } catch (err) {
    if (began) {
      try { await pg.query('ROLLBACK'); } catch (_r) { /* ignore */ }
    }
    return {
      ok: false,
      status: 500,
      body: {
        success: false,
        error: 'unhide failed',
        detail: String(err && err.message || err).slice(0, 200),
      },
    };
  }
}

module.exports = {
  resolveBookingEditAttribution,
  getSunsetScheduleBookingDrawerContext,
  updateSunsetScheduleBooking,
  cancelSunsetScheduleBooking,
  archiveSunsetScheduleBooking,
  hideSunsetScheduleBooking,
  unhideSunsetScheduleBooking,
  restoreSunsetScheduleBooking,
  buildPaymentSummary,
  buildPaidPaymentLedger,
  deriveDrawerPaymentUiStatus,
  aggregateComponentsFromServices,
  normalizePaymentMethod,
  normalizeDrawerGuestPhone,
  resolveDrawerGuestPhoneFromBundle,
  formatSunsetDrawerDailyItemLabel,
  pricingIntentFromBundle,
  customLineItemsFromBundle,
  accommodationFromBundle,
  PAID_BOOKING_REPRICE_REQUIRED,
};
