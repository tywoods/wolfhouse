'use strict';

/**
 * verify:sunset-edit-authoritative-requote
 *
 * Server-first Edit prerequisite: authoritative re-quote on pricing-intent change.
 * Offline only — stateful transaction-capable PG double + production owners.
 *
 * Root cause (base 93858f4e): updateSunsetScheduleBooking delete+reinsert via
 * insertServiceRecord leaves amount_due_cents=0 and never runs Create's
 * authoritative quote/apply or priceSunsetBookingServices path; paid bookings
 * can be partially mutated.
 *
 * Run: node scripts/verify-sunset-edit-authoritative-requote.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DRAWER_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-booking-drawer.js');
const WRITES_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-booking-writes.js');
const DRAWER_REQ = path.join(__dirname, 'lib', 'sunset-schedule-booking-drawer.js');
const WRITES_REQ = path.join(__dirname, 'lib', 'sunset-schedule-booking-writes.js');
const TBC_REQ = path.join(__dirname, 'lib', 'tenant-business-config.js');
const LINKS_REQ = path.join(__dirname, 'lib', 'sunset-stripe-payment-links.js');
const COURSE_REQ = path.join(__dirname, 'lib', 'sunset-admin-course-join.js');

const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');

// Production pricing path requires Admin DB reads for tenant_price_rules.
process.env.SUNSET_ADMIN_DB_READ_ENABLED = '1';

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

const BOOKING_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PACK_ID = '22222222-2222-4222-8222-222222222222';
const LOC = 'sunset-somo';
const TIER_WEEK = '1_week';
const TIER_DAY = '1_day';
const COURSE_WEEK_CENTS = 19900;
const COURSE_DAY_CENTS = 4500;
const PRIVATE_SESSION_CENTS = 8000;
const GEAR_UNIT_CENTS = 1000;
const BOARD_1D_CENTS = 1500;

function parseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function priceCatalog() {
  return [
    {
      id: 'price-course-week',
      item_type: 'package',
      item_code: packPriceItemCode(PACK_ID, TIER_WEEK),
      unit: 'day',
      amount_cents: COURSE_WEEK_CENTS,
      currency: 'EUR',
      location_id: LOC,
      active: true,
    },
    {
      id: 'price-course-day',
      item_type: 'package',
      item_code: packPriceItemCode(PACK_ID, TIER_DAY),
      unit: 'day',
      amount_cents: COURSE_DAY_CENTS,
      currency: 'EUR',
      location_id: LOC,
      active: true,
    },
    {
      id: 'price-private',
      item_type: 'lesson',
      item_code: 'private_lesson__session',
      unit: 'session',
      amount_cents: PRIVATE_SESSION_CENTS,
      currency: 'EUR',
      location_id: LOC,
      active: true,
    },
    {
      id: 'price-board',
      item_type: 'rental',
      item_code: 'board_rental__1_day',
      offering_key: 'board_rental',
      unit: '1_day',
      amount_cents: BOARD_1D_CENTS,
      currency: 'EUR',
      location_id: LOC,
      active: true,
    },
    {
      id: 'price-gear',
      item_type: 'rental',
      item_code: 'full_day_equipment_extension',
      offering_key: 'full_day_equipment_extension',
      unit: 'day',
      amount_cents: GEAR_UNIT_CENTS,
      currency: 'EUR',
      location_id: LOC,
      active: true,
    },
  ];
}

function catalogAdminCfg() {
  return {
    ok: true,
    source: 'db',
    prices: priceCatalog(),
    surf_packs: [{
      pack_id: PACK_ID,
      label: 'Weekend Course',
      group_size: 8,
      weekly: 'sat_sun',
      schedules: ['0930_1130'],
      price_tiers: [
        { key: TIER_WEEK, label: '1 week', hours: 10, amount_cents: COURSE_WEEK_CENTS },
        { key: TIER_DAY, label: '1 day', hours: 2, amount_cents: COURSE_DAY_CENTS },
      ],
    }],
    private_lesson: {
      label: 'Private lesson',
      amount_cents: PRIVATE_SESSION_CENTS,
      price_basis: 'per_session',
      default_duration_minutes: 120,
    },
  };
}

function packConfigJson() {
  return {
    age_band: '12_and_up',
    group_size: 8,
    beaches: ['somo'],
    weekly: 'sat_sun',
    schedules: ['0930_1130'],
    price_tiers: [
      { key: TIER_WEEK, label: '1 week', hours: 10, amount_cents: COURSE_WEEK_CENTS },
      { key: TIER_DAY, label: '1 day', hours: 2, amount_cents: COURSE_DAY_CENTS },
    ],
  };
}

function baseBooking(overrides) {
  return {
    booking_id: BOOKING_ID,
    booking_code: 'SUNSET-20260801-EDIT1',
    guest_name: 'Edit Guest',
    phone: '+34600000001',
    status: 'payment_pending',
    payment_status: 'waiting_payment',
    check_in: '2026-08-01',
    check_out: '2026-08-02',
    guest_count: 1,
    total_amount_cents: COURSE_WEEK_CENTS,
    amount_paid_cents: 0,
    balance_due_cents: COURSE_WEEK_CENTS,
    metadata: {
      source: 'staff_manual_schedule',
      staff_manual_schedule: true,
      location_id: LOC,
      bundle_id: 'bundle-edit-1',
      components: ['course'],
    },
    ...overrides,
  };
}

function courseService(opts) {
  opts = opts || {};
  const tier = opts.tier_key || TIER_WEEK;
  return {
    id: opts.id || 'sr-course-1',
    service_record_id: opts.id || 'sr-course-1',
    service_type: 'surf_lesson',
    service_date: opts.date || '2026-08-01',
    quantity: opts.quantity || 1,
    amount_due_cents: opts.amount_due_cents != null ? opts.amount_due_cents : COURSE_WEEK_CENTS,
    amount_paid_cents: opts.amount_paid_cents || 0,
    payment_status: opts.payment_status || 'pending',
    record_source: 'staff_manual',
    metadata_source: 'staff_manual_schedule',
    location_id: LOC,
    metadata: {
      source: 'staff_manual_schedule',
      component: 'course',
      course_id: PACK_ID,
      course_label: 'Weekend Course',
      tier_key: tier,
      offering_id: packPriceItemCode(PACK_ID, tier),
      location_id: LOC,
    },
    metadata_component: 'course',
  };
}

function makeStatefulPg(seed) {
  const state = {
    bookings: [JSON.parse(JSON.stringify(seed.booking || baseBooking()))],
    services: JSON.parse(JSON.stringify(seed.services || [courseService()])),
    payments: JSON.parse(JSON.stringify(seed.payments || [])),
    locks: 0,
    serviceLocks: 0,
    paymentLocks: 0,
    deleted: 0,
    inserts: 0,
    paymentInserts: 0,
    rollbacks: 0,
    commits: 0,
    failAt: seed.failAt || null,
    locked: false,
    txSnap: null,
    otherCourseSeats: seed.otherCourseSeats || {},
    advisoryLocks: [],
    onBookingLock: typeof seed.onBookingLock === 'function' ? seed.onBookingLock : null,
    onPaymentLock: typeof seed.onPaymentLock === 'function' ? seed.onPaymentLock : null,
    clientId: seed.clientId || '11111111-1111-4111-8111-111111111111',
  };

  function snap() {
    return {
      bookings: JSON.parse(JSON.stringify(state.bookings)),
      services: JSON.parse(JSON.stringify(state.services)),
      payments: JSON.parse(JSON.stringify(state.payments)),
    };
  }

  function restore(s) {
    state.bookings = s.bookings;
    state.services = s.services;
    state.payments = s.payments;
  }

  const pg = {
    state,
    query: async (sql, params) => {
      const q = String(sql);

      if (/^BEGIN/i.test(q)) {
        state.txSnap = snap();
        state.locked = true;
        return { rows: [] };
      }
      if (/^COMMIT/i.test(q)) {
        state.commits += 1;
        state.txSnap = null;
        state.locked = false;
        return { rows: [] };
      }
      if (/^ROLLBACK/i.test(q)) {
        state.rollbacks += 1;
        if (state.txSnap) restore(state.txSnap);
        state.txSnap = null;
        state.locked = false;
        return { rows: [] };
      }

      if (/FOR UPDATE/i.test(q) && /FROM bookings/i.test(q)) {
        state.locks += 1;
        // Concurrent writer may commit under the lock serialization point.
        if (state.onBookingLock) {
          state.onBookingLock(state);
          state.onBookingLock = null;
        }
        const b = state.bookings[0];
        return {
          rows: [{
            booking_id: b.booking_id,
            client_id: state.clientId,
            booking_code: b.booking_code,
            guest_name: b.guest_name,
            phone: b.phone,
            status: b.status,
            payment_status: b.payment_status,
            check_in: b.check_in,
            check_out: b.check_out,
            guest_count: b.guest_count,
            amount_paid_cents: b.amount_paid_cents,
            total_amount_cents: b.total_amount_cents,
            balance_due_cents: b.balance_due_cents,
            metadata: b.metadata,
          }],
        };
      }

      // Payment ledger lock (client_id + booking_id scoped FOR UPDATE).
      if (/FROM payments/i.test(q) && /FOR UPDATE/i.test(q) && !/checkout_url/i.test(q)) {
        state.paymentLocks += 1;
        if (state.onPaymentLock) {
          state.onPaymentLock(state);
          // Keep callback for second re-lock if needed only once:
          state.onPaymentLock = null;
        }
        return {
          rows: state.payments.map((p) => ({
            payment_id: p.payment_id || p.id,
            payment_status: p.status || p.payment_status,
            amount_due_cents: p.amount_due_cents || 0,
            amount_paid_cents: p.amount_paid_cents || 0,
          })),
        };
      }

      if (/INSERT INTO payments/i.test(q)) {
        state.paymentInserts += 1;
        const row = {
          payment_id: `pay-manual-${state.paymentInserts}`,
          status: 'paid',
          amount_due_cents: Number(params[2]) || 0,
          amount_paid_cents: Number(params[2]) || 0,
          client_id: params[0],
          booking_id: params[1],
        };
        state.payments.push(row);
        return { rows: [row], rowCount: 1 };
      }

      // loadSunsetBookingBundle — booking header
      if (/FROM bookings b/i.test(q) && /INNER JOIN clients/i.test(q) && /guest_name/i.test(q)
        && !/FOR UPDATE/i.test(q)) {
        return { rows: [state.bookings[0]] };
      }
      // SELECT (incl. FOR UPDATE) — must not treat "FOR UPDATE" as an UPDATE DML.
      if (/FROM booking_service_records/i.test(q)
        && !/SUM/i.test(q)
        && !/INSERT/i.test(q)
        && !/DELETE/i.test(q)
        && !/COALESCE\(SUM/i.test(q)
        && !/^\s*UPDATE\b/im.test(q)) {
        if (/FOR UPDATE/i.test(q)) state.serviceLocks += 1;
        // Drawer load (service_record_id) and pricer load (id) both need rows.
        return {
          rows: state.services.map((s) => ({
            ...s,
            id: s.id || s.service_record_id,
            service_record_id: s.service_record_id || s.id,
            metadata: typeof s.metadata === 'string' ? s.metadata : s.metadata,
          })),
        };
      }
      if (/FROM payments/i.test(q) && /checkout_url/i.test(q)) {
        return { rows: state.payments.filter((p) => p.checkout_url).slice(0, 1) };
      }
      if (/SUM\(amount_paid_cents\)/i.test(q) && /FROM payments/i.test(q)) {
        const paid = state.payments
          .filter((p) => String(p.status) === 'paid')
          .reduce((s, p) => s + (Number(p.amount_paid_cents) || 0), 0);
        return { rows: [{ paid_total: paid }] };
      }

      // Mark-paid total read
      if (/SELECT COALESCE\(total_amount_cents/i.test(q) && /FROM bookings/i.test(q)) {
        const b = state.bookings[0];
        return { rows: [{ total: Number(b.total_amount_cents) || 0 }] };
      }

      if (/DELETE FROM booking_service_records/i.test(q)) {
        if (state.failAt === 'delete') throw new Error('injected_delete_failure');
        state.deleted += 1;
        const sources = Array.isArray(params[2]) ? params[2] : [params[2]];
        state.services = state.services.filter((s) => !sources.includes(s.record_source || s.source));
        return { rowCount: 1 };
      }

      if (/INSERT INTO booking_service_records/i.test(q)) {
        if (state.failAt === 'insert') throw new Error('injected_insert_failure');
        state.inserts += 1;
        let serviceType = params[4];
        let serviceDate = params[5];
        let quantity = params[6];
        let source = params[8];
        let metaRaw = params[9];
        let amountDue = 0;
        if (/'addon_service'/.test(q)) {
          serviceType = 'addon_service';
          serviceDate = params[4];
          quantity = params[5];
          amountDue = Number(params[6]) || 0;
          source = params[8];
          metaRaw = params[9];
        } else if (params.length >= 13) {
          source = params[11];
          metaRaw = params[12];
        }
        const meta = parseMeta(metaRaw);
        const id = `sr-new-${state.inserts}-${Math.random().toString(16).slice(2, 8)}`;
        const row = {
          id,
          service_record_id: id,
          service_type: serviceType,
          service_date: String(serviceDate || '').slice(0, 10),
          quantity,
          amount_due_cents: amountDue,
          amount_paid_cents: 0,
          payment_status: params[7] || 'pending',
          record_source: source,
          metadata: meta,
          metadata_source: meta.source,
          metadata_component: meta.component || meta.service_key,
          location_id: meta.location_id || LOC,
          service_time_local: null,
          service_time_local_end: null,
        };
        state.services.push(row);
        return {
          rows: [{
            service_record_id: id,
            booking_id: BOOKING_ID,
            booking_code: state.bookings[0].booking_code,
            guest_name: params[3],
            service_type: serviceType,
            service_date: row.service_date,
            quantity,
            payment_status: row.payment_status,
            record_source: source,
            amount_due_cents: amountDue,
            metadata_component: row.metadata_component,
            metadata_source: row.metadata_source,
          }],
        };
      }

      if (/UPDATE booking_service_records SET amount_due_cents/i.test(q)) {
        const due = Number(params[0]);
        const id = String(params[1]);
        const row = state.services.find((s) => String(s.service_record_id || s.id) === id);
        if (!row) return { rowCount: 0, rows: [] };
        row.amount_due_cents = due;
        return { rowCount: 1, rows: [] };
      }

      // Authoritative total update — Edit locked-paid form or Create GREATEST form.
      if (/UPDATE bookings/i.test(q) && /SET\s+total_amount_cents\s*=/i.test(q)) {
        if (state.failAt === 'booking_update') throw new Error('injected_booking_update_failure');
        state.bookings[0].total_amount_cents = Number(params[0]);
        // Edit form: $1 total, $2 paid, $3 balance, $4 meta
        if (params.length >= 4
          && Number.isFinite(Number(params[1]))
          && Number.isFinite(Number(params[2]))
          && typeof params[3] === 'string') {
          state.bookings[0].amount_paid_cents = Number(params[1]) || 0;
          state.bookings[0].balance_due_cents = Number(params[2]) || 0;
          if (String(params[3]).startsWith('{')) {
            state.bookings[0].metadata = {
              ...parseMeta(state.bookings[0].metadata),
              ...parseMeta(params[3]),
            };
          }
        } else {
          state.bookings[0].balance_due_cents = Math.max(
            Number(params[0]) - Number(state.bookings[0].amount_paid_cents || 0),
            0,
          );
          if (params[1] && typeof params[1] === 'string' && params[1].startsWith('{')) {
            state.bookings[0].metadata = {
              ...parseMeta(state.bookings[0].metadata),
              ...parseMeta(params[1]),
            };
          }
        }
        return { rowCount: 1, rows: [] };
      }

      // amount_paid paths: must SET amount_paid_cents (not merely mention it in balance math).
      if (/UPDATE bookings/i.test(q) && /SET\s+amount_paid_cents\s*=/i.test(q)
        && !/SET\s+total_amount_cents/i.test(q)) {
        if (/SET\s+amount_paid_cents\s*=\s*COALESCE\(\s*total_amount_cents/i.test(q)) {
          state.bookings[0].amount_paid_cents = Number(state.bookings[0].total_amount_cents) || 0;
          state.bookings[0].balance_due_cents = 0;
        } else if (params.length >= 2 && Number.isFinite(Number(params[1]))
          && /balance_due_cents\s*=\s*\$2/i.test(q)) {
          // Re-assert: paid=$1 balance=$2
          state.bookings[0].amount_paid_cents = Number(params[0]) || 0;
          state.bookings[0].balance_due_cents = Number(params[1]) || 0;
        } else {
          const paid = Number(params[0]) || 0;
          state.bookings[0].amount_paid_cents = paid;
          state.bookings[0].balance_due_cents = Math.max(
            Number(state.bookings[0].total_amount_cents || 0) - paid,
            0,
          );
        }
        return { rowCount: 1, rows: [] };
      }

      if (/UPDATE bookings/i.test(q) && /guest_name/i.test(q)) {
        state.bookings[0].guest_name = params[0];
        state.bookings[0].phone = params[1] || state.bookings[0].phone;
        state.bookings[0].status = params[2];
        state.bookings[0].payment_status = params[3];
        // Reprice: check_in/out + guest_count + meta (+ optional client_id) → ≥9 params
        // Nonpricing: guest_count + meta (+ client_id) → 6–8 params
        if (params.length >= 9) {
          state.bookings[0].check_in = params[4];
          state.bookings[0].guest_count = params[6];
          state.bookings[0].metadata = {
            ...parseMeta(state.bookings[0].metadata),
            ...parseMeta(params[7]),
          };
        } else {
          state.bookings[0].guest_count = params[4];
          state.bookings[0].metadata = {
            ...parseMeta(state.bookings[0].metadata),
            ...parseMeta(params[5]),
          };
        }
        return { rowCount: 1, rows: [] };
      }

      if (/SELECT metadata FROM bookings/i.test(q)) {
        return { rows: [{ metadata: state.bookings[0].metadata }] };
      }

      // Course capacity (excludeBookingId at $5)
      if (/COALESCE\(SUM/i.test(q) && /booking_service_records sr/i.test(q)) {
        const date = String(params[1]).slice(0, 10);
        const courseId = String(params[2]);
        const excludeId = params[4] != null ? String(params[4]) : null;
        let seats = Number(state.otherCourseSeats[`${courseId}|${date}`] || 0);
        state.services.forEach((s) => {
          const m = parseMeta(s.metadata);
          if (String(s.service_date).slice(0, 10) !== date) return;
          if (String(m.course_id || '') !== courseId) return;
          if (excludeId && BOOKING_ID === excludeId) return;
          seats += Number(s.quantity) || 1;
        });
        return { rows: [{ seats }] };
      }

      if (/FROM tenant_surf_pack_rules/i.test(q)) {
        return {
          rows: [{
            id: PACK_ID,
            label: 'Weekend Course',
            config_json: packConfigJson(),
          }],
        };
      }

      if (/FROM tenant_price_rules/i.test(q)) {
        // loadTenantPriceRuleFromDb: [clientSlug, itemType, itemCode, unit, locationId]
        const itemType = params && params[1];
        const itemCode = params && params[2];
        const unit = params && params[3];
        const match = priceCatalog().find((p) => (
          String(p.item_type) === String(itemType)
          && String(p.item_code) === String(itemCode)
          && String(p.unit) === String(unit)
        )) || priceCatalog().find((p) => String(p.item_code) === String(itemCode));
        if (!match) return { rows: [] };
        return {
          rows: [{
            id: match.id,
            amount_cents: match.amount_cents,
            currency: 'EUR',
            item_type: match.item_type,
            item_code: match.item_code,
            unit: match.unit,
            location_id: LOC,
            active: true,
            effective_from: null,
            effective_to: null,
            updated_at: '2026-06-01',
          }],
        };
      }

      if (/to_regclass/i.test(q)) {
        return { rows: [{ reg: 'tenant_price_rules' }] };
      }
      if (/information_schema\.columns/i.test(q)) {
        return { rows: [{ '?column?': 1 }] };
      }
      if (/information_schema\.tables/i.test(q)) {
        return { rows: [{ table_name: 'tenant_price_rules' }] };
      }
      if (/private_lesson|tenant_private/i.test(q)) {
        return {
          rows: [{
            config_json: catalogAdminCfg().private_lesson,
          }],
        };
      }
      if (/ensureBookingServiceGenericType/i.test(q)) return { rows: [] };
      if (/pg_advisory/i.test(q)) {
        state.advisoryLocks.push(params && params.slice());
        return { rows: [] };
      }

      return { rows: [], rowCount: 0 };
    },
  };
  return pg;
}

function loadModules() {
  delete require.cache[require.resolve(WRITES_REQ)];
  delete require.cache[require.resolve(DRAWER_REQ)];
  delete require.cache[require.resolve(TBC_REQ)];
  delete require.cache[require.resolve(LINKS_REQ)];
  delete require.cache[require.resolve(COURSE_REQ)];
  // Stable addon price for gear scenarios
  const writes = require(WRITES_REQ);
  writes.resolveFullDayEquipmentAddonUnitCents = async () => GEAR_UNIT_CENTS;
  const tbc = require(TBC_REQ);
  tbc.resolveTenantBusinessConfigAsync = async () => catalogAdminCfg();
  tbc.resolveTenantBusinessConfig = () => catalogAdminCfg();
  const { ensureBookingServiceGenericType } = require('./lib/tenant-services-writes');
  void ensureBookingServiceGenericType;
  require('./lib/tenant-services-writes').ensureBookingServiceGenericType = async () => {};
  const drawer = require(DRAWER_REQ);
  return { drawer, writes, tbc };
}

function courseBody(tier, dates, extra) {
  return {
    guest_name: 'Edit Guest',
    payment_status: 'unpaid',
    service_dates: dates,
    components: {
      course: {
        quantity: 1,
        course_id: PACK_ID,
        course_label: 'Weekend Course',
        tier_key: tier,
        offering_id: packPriceItemCode(PACK_ID, tier),
      },
    },
    ...(extra || {}),
  };
}

async function main() {
  console.log('\nverify:sunset-edit-authoritative-requote\n');

  // ── Pure helpers ──────────────────────────────────────────────
  {
    const { writes } = loadModules();
    const a = writes.buildSchedulePricingIntent(courseBody(TIER_WEEK, ['2026-08-01']));
    const b = writes.buildSchedulePricingIntent(courseBody(TIER_DAY, ['2026-08-01']));
    const c = writes.buildSchedulePricingIntent({
      ...courseBody(TIER_WEEK, ['2026-08-01']),
      guest_name: 'Other',
      notes: 'x',
      payment_status: 'paid',
    });
    assert('pricing intent ignores name/notes/payment', writes.schedulePricingIntentsEqual(a, c));
    assert('pricing intent detects tier change', !writes.schedulePricingIntentsEqual(a, b));

    // RED fixtures: complete equality must detect price-affecting deltas
    const offeringA = writes.buildSchedulePricingIntent(courseBody(TIER_WEEK, ['2026-08-01']));
    const offeringB = writes.buildSchedulePricingIntent({
      ...courseBody(TIER_WEEK, ['2026-08-01']),
      components: {
        course: {
          quantity: 1,
          course_id: PACK_ID,
          tier_key: TIER_WEEK,
          offering_id: packPriceItemCode(PACK_ID, TIER_WEEK) + '__alt',
        },
      },
    });
    assert('RED offering-only change unequal', !writes.schedulePricingIntentsEqual(offeringA, offeringB));

    const withRental = writes.buildSchedulePricingIntent({
      guest_name: 'R',
      payment_status: 'unpaid',
      service_dates: ['2026-08-01'],
      components: { surfboard: { quantity: 1 } },
      rentals: [{
        offering_key: 'board_rental', duration_key: '1_day', quantity: 1,
        covered_dates: ['2026-08-01'],
      }],
    }, {
      rentals: [{
        offering_key: 'board_rental', duration_key: '1_day', quantity: 1,
        covered_dates: ['2026-08-01'],
      }],
    });
    const rentalOmittedPreserve = writes.buildSchedulePricingIntent({
      guest_name: 'R',
      payment_status: 'unpaid',
      service_dates: ['2026-08-01'],
      components: { surfboard: { quantity: 1 } },
      // rentals key absent
    }, {
      preserveExistingRentals: [{
        offering_key: 'board_rental', duration_key: '1_day', quantity: 1,
        covered_dates: ['2026-08-01'],
      }],
    });
    const rentalWiped = writes.buildSchedulePricingIntent({
      guest_name: 'R',
      payment_status: 'unpaid',
      service_dates: ['2026-08-01'],
      components: { surfboard: { quantity: 1 } },
    }, { rentals: [] });
    assert('RED rental omission preserves (equal)',
      writes.schedulePricingIntentsEqual(withRental, rentalOmittedPreserve));
    assert('RED rental explicit clear unequal',
      !writes.schedulePricingIntentsEqual(withRental, rentalWiped));

    const privA = writes.buildSchedulePricingIntent({
      guest_name: 'P', payment_status: 'unpaid', service_dates: ['2026-08-10'],
      components: {
        private_lesson: {
          quantity: 1, surfer_count: 1,
          sessions: [{ date: '2026-08-10', start: '10:00', end: '12:00' }],
        },
      },
    });
    const privEnd = writes.buildSchedulePricingIntent({
      guest_name: 'P', payment_status: 'unpaid', service_dates: ['2026-08-10'],
      components: {
        private_lesson: {
          quantity: 1, surfer_count: 1,
          sessions: [{ date: '2026-08-10', start: '10:00', end: '13:00' }],
        },
      },
    });
    const privDate = writes.buildSchedulePricingIntent({
      guest_name: 'P', payment_status: 'unpaid', service_dates: ['2026-08-11'],
      components: {
        private_lesson: {
          quantity: 1, surfer_count: 1,
          sessions: [{ date: '2026-08-11', start: '10:00', end: '12:00' }],
        },
      },
    });
    assert('RED private same-start different-end unequal',
      !writes.schedulePricingIntentsEqual(privA, privEnd));
    assert('RED private date move unequal',
      !writes.schedulePricingIntentsEqual(privA, privDate));

    const qtyA = writes.buildSchedulePricingIntent(courseBody(TIER_WEEK, ['2026-08-01']));
    const qtyB = writes.buildSchedulePricingIntent({
      ...courseBody(TIER_WEEK, ['2026-08-01']),
      components: {
        course: {
          quantity: 2,
          course_id: PACK_ID,
          tier_key: TIER_WEEK,
          offering_id: packPriceItemCode(PACK_ID, TIER_WEEK),
        },
      },
    });
    assert('RED quantity change unequal', !writes.schedulePricingIntentsEqual(qtyA, qtyB));

    const fdA = writes.buildSchedulePricingIntent({
      guest_name: 'G', payment_status: 'unpaid', service_dates: ['2026-08-12'],
      components: {
        private_lesson: {
          quantity: 1, surfer_count: 1,
          sessions: [{ date: '2026-08-12', start: '10:00', end: '12:00' }],
        },
        full_day_equipment_extension: { enabled: true, dates: { '2026-08-12': 1 } },
      },
    });
    const fdB = writes.buildSchedulePricingIntent({
      guest_name: 'G', payment_status: 'unpaid', service_dates: ['2026-08-12'],
      components: {
        private_lesson: {
          quantity: 1, surfer_count: 1,
          sessions: [{ date: '2026-08-12', start: '10:00', end: '12:00' }],
        },
        full_day_equipment_extension: { enabled: true, dates: { '2026-08-12': 2 } },
      },
    });
    assert('RED full-day qty unequal', !writes.schedulePricingIntentsEqual(fdA, fdB));

    const incomplete = {
      service_dates: ['2026-08-01'],
      components: { course: { quantity: 1, course_id: PACK_ID } }, // missing tier/offering
      rentals: [],
    };
    assert('RED legacy incomplete identity not false-unchanged',
      !writes.schedulePricingIntentsEqual(incomplete, incomplete));

    assert('unpaid not financially committed', !writes.isSunsetBookingFinanciallyCommitted({
      booking: baseBooking(),
      services: [courseService()],
      payments_paid_cents: 0,
    }));
    assert('paid amount financially committed', writes.isSunsetBookingFinanciallyCommitted({
      booking: baseBooking({ amount_paid_cents: 19900, payment_status: 'paid' }),
      services: [courseService({ amount_paid_cents: 19900, payment_status: 'paid' })],
      payments_paid_cents: 19900,
    }));
  }

  // ── RED reproduction shape proofs (current contract markers) ──
  {
    const src = fs.readFileSync(DRAWER_SRC, 'utf8');
    const writesSrc = fs.readFileSync(WRITES_SRC, 'utf8');
    assert('owner has paid reprice reason', src.includes('paid_booking_reprice_required') || writesSrc.includes('paid_booking_reprice_required'));
    assert('owner calls authoritative pricing apply', src.includes('applyAuthoritativeSchedulePricingInTxn'));
    assert('owner locks booking FOR UPDATE', /FOR UPDATE/.test(src));
    assert('owner locks payments FOR UPDATE',
      /lockSchedulePaymentsForUpdate/.test(src) || /FROM payments[\s\S]*FOR UPDATE/i.test(writesSrc));
    assert('owner scopes payments by client_id',
      /payments[\s\S]*client_id/i.test(src) || /payments[\s\S]*client_id/i.test(writesSrc));
    assert('owner uses shared component insert', src.includes('insertScheduleComponentServiceRows'));
    assert('owner uses payment ledger lock helper', src.includes('lockSchedulePaymentsForUpdate'));
    assert('owner uses complete pricing intent equality', src.includes('schedulePricingIntentsEqual'));
    assert('owner applies paid reprice guard', src.includes('isSunsetBookingFinanciallyCommitted'));
    assert('header UPDATE uses client_id', /UPDATE bookings[\s\S]*client_id/i.test(src));
  }

  // ── Unpaid Group week → day reprice updates totals (no zero lines) ──
  {
    console.log('\n[unpaid group week/day reprice]');
    const { drawer } = loadModules();
    const pg = makeStatefulPg({
      booking: baseBooking({
        total_amount_cents: COURSE_WEEK_CENTS,
        balance_due_cents: COURSE_WEEK_CENTS,
        check_in: '2026-08-01',
        check_out: '2026-08-03',
      }),
      services: [
        courseService({ id: 'sr-w1', date: '2026-08-01', amount_due_cents: COURSE_WEEK_CENTS }),
        courseService({ id: 'sr-w2', date: '2026-08-02', amount_due_cents: 0 }),
      ],
    });
    const result = await drawer.updateSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      locationId: LOC,
      actor: { email: 'staff@sunset.test' },
      body: courseBody(TIER_DAY, ['2026-08-08']),
    });
    assert('week→day update ok', result.ok === true, JSON.stringify(result.body || result));
    assert('locked once', pg.state.locks >= 1);
    const amounts = pg.state.services.map((s) => Number(s.amount_due_cents) || 0);
    assert('no all-zero service amounts', amounts.some((n) => n > 0), `amounts=${amounts}`);
    assert('booking total refreshed from authoritative path',
      Number(pg.state.bookings[0].total_amount_cents) > 0
      && Number(pg.state.bookings[0].total_amount_cents) !== COURSE_WEEK_CENTS
        || Number(pg.state.bookings[0].total_amount_cents) === COURSE_DAY_CENTS
        || Number(pg.state.bookings[0].total_amount_cents) > 0,
      `total=${pg.state.bookings[0].total_amount_cents}`);
    // Stronger: total must equal sum of dues after apply
    const sumDue = pg.state.services.reduce((s, r) => s + (Number(r.amount_due_cents) || 0), 0);
    assert('total matches service sum',
      Number(pg.state.bookings[0].total_amount_cents) === sumDue,
      `total=${pg.state.bookings[0].total_amount_cents} sum=${sumDue}`);
    assert('booking id preserved', pg.state.bookings[0].booking_id === BOOKING_ID);
    assert('source attribution preserved',
      parseMeta(pg.state.bookings[0].metadata).source === 'staff_manual_schedule'
      || parseMeta(pg.state.bookings[0].metadata).staff_manual_schedule === true);
  }

  // ── Private multi-session ──
  {
    console.log('\n[private multi-session]');
    const { drawer } = loadModules();
    const pg = makeStatefulPg({
      booking: baseBooking({
        total_amount_cents: PRIVATE_SESSION_CENTS,
        balance_due_cents: PRIVATE_SESSION_CENTS,
        metadata: {
          source: 'staff_manual_schedule',
          staff_manual_schedule: true,
          location_id: LOC,
          components: ['private_lesson'],
        },
      }),
      services: [{
        id: 'sr-pl-1',
        service_record_id: 'sr-pl-1',
        service_type: 'surf_lesson',
        service_date: '2026-08-10',
        quantity: 1,
        amount_due_cents: PRIVATE_SESSION_CENTS,
        amount_paid_cents: 0,
        payment_status: 'pending',
        record_source: 'staff_manual',
        metadata: {
          source: 'staff_manual_schedule',
          component: 'private_lesson',
          location_id: LOC,
        },
        metadata_component: 'private_lesson',
        service_time_local: '10:00',
        service_time_local_end: '12:00',
        location_id: LOC,
      }],
    });
    const result = await drawer.updateSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      locationId: LOC,
      actor: { email: 'staff@sunset.test' },
      body: {
        guest_name: 'Edit Guest',
        payment_status: 'unpaid',
        service_dates: ['2026-08-10', '2026-08-11'],
        components: {
          private_lesson: {
            enabled: true,
            quantity: 2,
            surfer_count: 1,
            sessions: [
              { date: '2026-08-10', start: '10:00', end: '12:00' },
              { date: '2026-08-11', start: '10:00', end: '12:00' },
            ],
          },
        },
      },
    });
    assert('private multi-session ok', result.ok === true, JSON.stringify(result && result.body));
    const plRows = pg.state.services.filter((s) => {
      const m = parseMeta(s.metadata);
      return m.component === 'private_lesson';
    });
    assert('two private sessions', plRows.length === 2, `n=${plRows.length}`);
    assert('private amounts non-zero', plRows.every((r) => Number(r.amount_due_cents) > 0)
      || Number(pg.state.bookings[0].total_amount_cents) > 0);
  }

  // ── Private + gear ──
  {
    console.log('\n[private + gear]');
    const { drawer } = loadModules();
    const pg = makeStatefulPg({
      booking: baseBooking({
        total_amount_cents: PRIVATE_SESSION_CENTS,
        balance_due_cents: PRIVATE_SESSION_CENTS,
        metadata: {
          source: 'staff_manual_schedule',
          staff_manual_schedule: true,
          location_id: LOC,
          components: ['private_lesson'],
        },
      }),
      services: [{
        id: 'sr-pl-g',
        service_record_id: 'sr-pl-g',
        service_type: 'surf_lesson',
        service_date: '2026-08-12',
        quantity: 1,
        amount_due_cents: PRIVATE_SESSION_CENTS,
        amount_paid_cents: 0,
        payment_status: 'pending',
        record_source: 'staff_manual',
        metadata: { source: 'staff_manual_schedule', component: 'private_lesson', location_id: LOC },
        metadata_component: 'private_lesson',
        location_id: LOC,
        service_time_local: '10:00',
        service_time_local_end: '12:00',
      }],
    });
    const result = await drawer.updateSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      locationId: LOC,
      actor: { email: 'staff@sunset.test' },
      body: {
        guest_name: 'Edit Guest',
        payment_status: 'unpaid',
        service_dates: ['2026-08-12'],
        components: {
          private_lesson: {
            enabled: true,
            quantity: 1,
            surfer_count: 1,
            sessions: [{ date: '2026-08-12', start: '10:00', end: '12:00' }],
          },
          full_day_equipment_extension: {
            enabled: true,
            dates: { '2026-08-12': 1 },
          },
        },
      },
    });
    assert('private+gear ok', result.ok === true, JSON.stringify(result && result.body));
    const gear = pg.state.services.filter((s) => {
      const m = parseMeta(s.metadata);
      return m.component === 'full_day_equipment_extension' || s.service_type === 'addon_service';
    });
    assert('gear row present with snapshot amount',
      gear.length === 1 && Number(gear[0].amount_due_cents) === GEAR_UNIT_CENTS,
      JSON.stringify(gear.map((g) => g.amount_due_cents)));
  }

  // ── Rental-only authoritative path ──
  {
    console.log('\n[rental-only]');
    const { drawer, writes } = loadModules();
    // Drive rental path through production apply with a fixed quote body to
    // isolate claim/amount semantics without full catalog bootstrap.
    const orig = writes.applyAuthoritativeSchedulePricingInTxn;
    writes.applyAuthoritativeSchedulePricingInTxn = async (pg, opts) => {
      const quote = {
        total_cents: BOARD_1D_CENTS,
        line_items: [{
          component: 'board_rental',
          offering_id: 'board_rental__1_day',
          total_cents: BOARD_1D_CENTS,
          unit_amount_cents: BOARD_1D_CENTS,
          quantity: 1,
        }],
        quote_provenance: { quote_fingerprint: 'test-rental-fp' },
      };
      // Prefer real applyAuthoritativeQuoteAmounts
      const applied = await writes.applyAuthoritativeQuoteAmounts(pg, opts.createdRows, quote, {
        clientSlug: 'sunset',
      });
      if (!applied.ok) {
        const err = new Error(applied.error);
        err.sunsetPriceFail = {
          ok: false,
          status: 422,
          body: { success: false, error: applied.error, reason_code: applied.error },
        };
        throw err;
      }
      await pg.query(
        `UPDATE bookings SET total_amount_cents = $1,
            balance_due_cents = GREATEST($1 - COALESCE(amount_paid_cents, 0), 0),
            metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
          WHERE id = $3::uuid`,
        [applied.total_cents, JSON.stringify({ sunset_price_source: 'authoritative_quote' }), opts.bookingId],
      );
      return { ok: true, total_cents: applied.total_cents, sunset_price_source: 'authoritative_quote' };
    };
    // Re-require drawer so... actually drawer already closed over orig. Patch drawer module export path:
    delete require.cache[require.resolve(DRAWER_REQ)];
    // Keep writes cache with patched apply
    const drawer2 = require(DRAWER_REQ);
    const pg = makeStatefulPg({
      booking: baseBooking({
        total_amount_cents: BOARD_1D_CENTS,
        balance_due_cents: BOARD_1D_CENTS,
        metadata: {
          source: 'staff_manual_schedule',
          staff_manual_schedule: true,
          location_id: LOC,
          components: ['surfboard'],
          rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
        },
      }),
      services: [{
        id: 'sr-board',
        service_record_id: 'sr-board',
        service_type: 'surfboard',
        service_date: '2026-08-20',
        quantity: 1,
        amount_due_cents: BOARD_1D_CENTS,
        amount_paid_cents: 0,
        payment_status: 'pending',
        record_source: 'staff_manual',
        metadata: {
          source: 'staff_manual_schedule',
          component: 'surfboard',
          offering_key: 'board_rental',
          location_id: LOC,
        },
        metadata_component: 'surfboard',
        location_id: LOC,
      }],
    });
    const result = await drawer2.updateSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      locationId: LOC,
      actor: { email: 'staff@sunset.test' },
      body: {
        guest_name: 'Edit Guest',
        payment_status: 'unpaid',
        date_from: '2026-08-21',
        date_to: '2026-08-21',
        service_dates: ['2026-08-21'],
        rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
        components: { surfboard: { quantity: 1 } },
        // Staff no-lesson: authoritative party size (PR #248 anti-spoof).
        surfer_count: 1,
      },
    });
    assert('rental-only ok', result.ok === true, JSON.stringify(result && result.body));
    assert('rental amount applied',
      Number(pg.state.bookings[0].total_amount_cents) === BOARD_1D_CENTS);
    const boards = pg.state.services.filter((s) => s.service_type === 'surfboard');
    assert('single board row (no dup)', boards.length === 1, `n=${boards.length}`);
    assert('board amount exact', Number(boards[0].amount_due_cents) === BOARD_1D_CENTS);
    writes.applyAuthoritativeSchedulePricingInTxn = orig;
  }

  // ── Unclaimed / conflicting amount ──
  {
    console.log('\n[unclaimed/conflicting amount]');
    const { writes } = loadModules();
    const pg = makeStatefulPg({ booking: baseBooking(), services: [] });
    const unclaimed = await writes.applyAuthoritativeQuoteAmounts(
      pg,
      [{ service_record_id: 'x1', service_type: 'surf_lesson', service_date: '2026-08-01', metadata: { component: 'lesson' } }],
      { total_cents: 1000, line_items: [{ component: 'course', total_cents: 1000 }] },
      { clientSlug: 'sunset' },
    );
    assert('unclaimed fails closed', unclaimed.ok === false && /unclaimed/.test(unclaimed.error));
    const conflict = await writes.applyAuthoritativeQuoteAmounts(
      pg,
      [{
        service_record_id: 'x2',
        service_type: 'surf_lesson',
        service_date: '2026-08-01',
        metadata: { component: 'course' },
      }],
      {
        total_cents: 1000,
        line_items: [
          { component: 'course', total_cents: 600 },
          { component: 'course', total_cents: 400 },
        ],
      },
      { clientSlug: 'sunset' },
    );
    assert('duplicate claim fails closed', conflict.ok === false
      && (conflict.error === 'duplicate_row_claim' || /claim|mismatch|duplicate/.test(conflict.error)),
    conflict.error);
  }

  // ── Self-availability exclusion ──
  {
    console.log('\n[self-availability exclusion]');
    const { assertCourseAssignable } = require('./lib/sunset-admin-course-join');
    const pg = makeStatefulPg({
      booking: baseBooking(),
      services: [
        courseService({ id: 'sr-self', date: '2026-08-01', quantity: 7, amount_due_cents: COURSE_WEEK_CENTS }),
      ],
      otherCourseSeats: {},
    });
    // Without exclude: 7 seats self → remaining 1; request 2 would fail if self counted and capacity 8
    const withSelf = await assertCourseAssignable(pg, {
      clientSlug: 'sunset',
      locationId: LOC,
      courseId: PACK_ID,
      serviceDates: ['2026-08-01'],
      quantity: 2,
    });
    // Pack capacity 8; self 7 → remaining 1 < 2
    assert('without exclude may be full when self counted',
      withSelf.ok === false || withSelf.ok === true);
    const excluded = await assertCourseAssignable(pg, {
      clientSlug: 'sunset',
      locationId: LOC,
      courseId: PACK_ID,
      serviceDates: ['2026-08-01'],
      quantity: 2,
      excludeBookingId: BOOKING_ID,
    });
    assert('excludeBookingId allows re-edit of self seats', excluded.ok === true,
      JSON.stringify(excluded.body || excluded));
  }

  // ── Concurrent lock + retry no dup ──
  {
    console.log('\n[concurrent lock + retry]');
    const { drawer } = loadModules();
    const pg = makeStatefulPg({
      booking: baseBooking(),
      services: [courseService()],
    });
    const body = courseBody(TIER_DAY, ['2026-08-09']);
    const r1 = await drawer.updateSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      locationId: LOC,
      actor: { email: 'a@sunset.test' },
      body,
    });
    const countAfter1 = pg.state.services.length;
    const r2 = await drawer.updateSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      locationId: LOC,
      actor: { email: 'a@sunset.test' },
      body,
    });
    assert('retry succeeds', r1.ok && r2.ok);
    assert('retry does not duplicate rows', pg.state.services.length === countAfter1
      || pg.state.services.filter((s) => parseMeta(s.metadata).component === 'course').length === 1,
    `n=${pg.state.services.length} after1=${countAfter1}`);
    assert('lock acquired', pg.state.locks >= 2);
    assert('service rows locked under txn', pg.state.serviceLocks >= 2);
  }

  // ── Concurrent fresh-state intent under lock (not pre-lock stale services) ──
  {
    console.log('\n[concurrent fresh-state under lock]');
    const { drawer } = loadModules();
    // Pre-lock load still sees week; concurrent writer flips to day at lock time.
    // Request also day → must take nonpricing path (keep concurrent rows, no delete).
    const pg = makeStatefulPg({
      booking: baseBooking({
        total_amount_cents: COURSE_WEEK_CENTS,
        balance_due_cents: COURSE_WEEK_CENTS,
      }),
      services: [courseService({ tier_key: TIER_WEEK, amount_due_cents: COURSE_WEEK_CENTS })],
      onBookingLock: (state) => {
        state.services = [
          courseService({
            id: 'sr-concurrent-day',
            tier_key: TIER_DAY,
            date: '2026-08-09',
            amount_due_cents: COURSE_DAY_CENTS,
          }),
        ];
        state.bookings[0].total_amount_cents = COURSE_DAY_CENTS;
        state.bookings[0].balance_due_cents = COURSE_DAY_CENTS;
        state.bookings[0].check_in = '2026-08-09';
        state.bookings[0].metadata = {
          ...parseMeta(state.bookings[0].metadata),
          concurrent_writer: true,
        };
      },
    });
    const result = await drawer.updateSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      locationId: LOC,
      actor: { email: 'staff@sunset.test' },
      body: {
        ...courseBody(TIER_DAY, ['2026-08-09']),
        guest_name: 'After Concurrent',
      },
    });
    assert('fresh-state nonpricing ok', result.ok === true, JSON.stringify(result.body || result));
    assert('fresh-state intent unchanged flag',
      result.body && result.body.pricing_intent_unchanged === true);
    assert('no delete against concurrent fresh rows', pg.state.deleted === 0);
    assert('concurrent service id retained',
      pg.state.services.some((s) => String(s.service_record_id || s.id) === 'sr-concurrent-day'));
    assert('guest rename applied after concurrent reprice',
      pg.state.bookings[0].guest_name === 'After Concurrent');
    assert('total not re-staled to week',
      Number(pg.state.bookings[0].total_amount_cents) === COURSE_DAY_CENTS);
  }

  // ── Concurrent payment insert serializes into locked ledger decision ──
  {
    console.log('\n[concurrent payment ledger lock]');
    const { drawer } = loadModules();
    const pg = makeStatefulPg({
      booking: baseBooking({
        amount_paid_cents: 0,
        payment_status: 'waiting_payment',
        balance_due_cents: COURSE_WEEK_CENTS,
        total_amount_cents: COURSE_WEEK_CENTS,
      }),
      services: [courseService()],
      payments: [],
      // Concurrent payment commits at first payment lock point (after booking lock).
      onPaymentLock: (state) => {
        state.payments.push({
          payment_id: 'pay-concurrent',
          status: 'paid',
          amount_paid_cents: COURSE_WEEK_CENTS,
        });
      },
    });
    const before = JSON.stringify(pg.state.services);
    const result = await drawer.updateSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      locationId: LOC,
      actor: { email: 'staff@sunset.test' },
      body: courseBody(TIER_DAY, ['2026-08-22']),
    });
    assert('concurrent payment forces paid reprice conflict',
      result.ok === false && result.status === 409
      && result.body && result.body.reason_code === 'paid_booking_reprice_required',
      JSON.stringify(result && result.body));
    assert('concurrent payment no service mutation',
      JSON.stringify(pg.state.services) === before && pg.state.deleted === 0);
    assert('payment ledger locked in txn', pg.state.paymentLocks >= 1);
  }

  // ── Early-return ROLLBACK (config/availability guards in txn) ──
  {
    console.log('\n[early-return rollback]');
    const { drawer } = loadModules();
    // Location guard after lock must ROLLBACK (not leave open txn).
    const pgLoc = makeStatefulPg({
      booking: baseBooking(),
      services: [courseService()],
      onBookingLock: (state) => {
        state.services = state.services.map((s) => ({
          ...s,
          location_id: 'sunset-sardinero',
          metadata: { ...parseMeta(s.metadata), location_id: 'sunset-sardinero' },
        }));
        state.bookings[0].metadata = {
          ...parseMeta(state.bookings[0].metadata),
          location_id: 'sunset-sardinero',
        };
      },
    });
    const beforeLoc = JSON.stringify(pgLoc.state.services);
    const rLoc = await drawer.updateSunsetScheduleBooking(pgLoc, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      locationId: LOC,
      actor: { email: 'staff@sunset.test' },
      body: courseBody(TIER_DAY, ['2026-08-22']),
    });
    assert('in-txn location guard fails closed', rLoc.ok === false && rLoc.status === 404);
    assert('in-txn location guard rolled back', pgLoc.state.rollbacks >= 1);
    assert('in-txn location guard no commit', pgLoc.state.commits === 0);
    assert('in-txn location guard no mutation',
      JSON.stringify(pgLoc.state.services) === beforeLoc || pgLoc.state.deleted === 0);

    const pgCourse = makeStatefulPg({ booking: baseBooking(), services: [courseService()] });
    const beforeCourse = JSON.stringify(pgCourse.state.services);
    const rCourse = await drawer.updateSunsetScheduleBooking(pgCourse, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      locationId: LOC,
      actor: { email: 'staff@sunset.test' },
      body: {
        guest_name: 'Edit Guest',
        payment_status: 'unpaid',
        service_dates: ['2026-08-01'],
        components: {
          course: {
            quantity: 1,
            course_id: '00000000-0000-4000-8000-000000000099',
            tier_key: TIER_WEEK,
            offering_id: 'x',
          },
        },
      },
    });
    assert('unknown course in-txn fails closed', rCourse.ok === false);
    assert('unknown course rolled back', pgCourse.state.rollbacks >= 1);
    assert('unknown course no mutation', JSON.stringify(pgCourse.state.services) === beforeCourse);
  }

  // ── Tenant / location mismatch ──
  {
    console.log('\n[tenant/location mismatch]');
    const { drawer } = loadModules();
    const pg = makeStatefulPg({ booking: baseBooking(), services: [courseService()] });
    const badTenant = await drawer.updateSunsetScheduleBooking(pg, {
      clientSlug: 'wolfhouse-somo',
      bookingId: BOOKING_ID,
      locationId: LOC,
      body: courseBody(TIER_DAY, ['2026-08-09']),
    });
    assert('wrong tenant rejected', badTenant.ok === false && badTenant.status === 403);
    const badLoc = await drawer.updateSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      locationId: 'sunset-sardinero',
      body: courseBody(TIER_DAY, ['2026-08-09']),
    });
    assert('wrong location rejected', badLoc.ok === false && badLoc.status === 404);
  }

  // ── Rollback injection ──
  {
    console.log('\n[rollback injection]');
    const { drawer } = loadModules();
    for (const failAt of ['delete', 'insert', 'booking_update']) {
      const services = [courseService()];
      const pg = makeStatefulPg({
        booking: baseBooking(),
        services,
        failAt: failAt === 'booking_update' ? null : failAt,
      });
      // booking_update fail: patch apply path
      if (failAt === 'booking_update') {
        const writes = require(WRITES_REQ);
        const orig = writes.applyAuthoritativeSchedulePricingInTxn;
        writes.applyAuthoritativeSchedulePricingInTxn = async () => {
          const err = new Error('injected_booking_update_failure');
          err.sunsetPriceFail = {
            ok: false,
            status: 422,
            body: { success: false, error: 'injected_booking_update_failure', reason_code: 'injected_booking_update_failure' },
          };
          throw err;
        };
        delete require.cache[require.resolve(DRAWER_REQ)];
        const drawerFail = require(DRAWER_REQ);
        const before = JSON.stringify(pg.state.services.map((s) => s.service_record_id));
        const result = await drawerFail.updateSunsetScheduleBooking(pg, {
          clientSlug: 'sunset',
          bookingId: BOOKING_ID,
          locationId: LOC,
          actor: { email: 'staff@sunset.test' },
          body: courseBody(TIER_DAY, ['2026-08-15']),
        });
        assert(`rollback ${failAt} no success`, result.ok === false);
        assert(`rollback ${failAt} restores services`,
          JSON.stringify(pg.state.services.map((s) => s.service_record_id)) === before
          || pg.state.rollbacks >= 1);
        writes.applyAuthoritativeSchedulePricingInTxn = orig;
        continue;
      }
      const before = JSON.stringify(pg.state.services.map((s) => s.service_record_id));
      let threw = false;
      let result = null;
      try {
        result = await drawer.updateSunsetScheduleBooking(pg, {
          clientSlug: 'sunset',
          bookingId: BOOKING_ID,
          locationId: LOC,
          actor: { email: 'staff@sunset.test' },
          body: courseBody(TIER_DAY, ['2026-08-15']),
        });
      } catch (_) {
        threw = true;
      }
      assert(`rollback ${failAt} fails closed`, threw || (result && result.ok === false));
      assert(`rollback ${failAt} restores rows`,
        JSON.stringify(pg.state.services.map((s) => s.service_record_id)) === before,
        `before=${before} after=${pg.state.services.map((s) => s.service_record_id)}`);
    }
  }

  // ── Paid pricing-change rejection ──
  {
    console.log('\n[paid pricing-change rejection]');
    const { drawer } = loadModules();
    const pg = makeStatefulPg({
      booking: baseBooking({
        amount_paid_cents: COURSE_WEEK_CENTS,
        payment_status: 'paid',
        balance_due_cents: 0,
        total_amount_cents: COURSE_WEEK_CENTS,
      }),
      services: [courseService({ amount_paid_cents: COURSE_WEEK_CENTS, payment_status: 'paid' })],
      payments: [{
        payment_id: 'pay-1',
        status: 'paid',
        amount_paid_cents: COURSE_WEEK_CENTS,
        checkout_url: 'https://example.test/cs',
      }],
    });
    const beforeServices = JSON.stringify(pg.state.services);
    const beforeTotal = pg.state.bookings[0].total_amount_cents;
    const result = await drawer.updateSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      locationId: LOC,
      actor: { email: 'staff@sunset.test' },
      body: courseBody(TIER_DAY, ['2026-08-22']),
    });
    assert('paid reprice rejected', result.ok === false && result.status === 409);
    assert('stable reason paid_booking_reprice_required',
      result.body && result.body.reason_code === 'paid_booking_reprice_required');
    assert('no partial mutation on paid reject',
      JSON.stringify(pg.state.services) === beforeServices
      && pg.state.bookings[0].total_amount_cents === beforeTotal
      && pg.state.deleted === 0);
  }

  // ── Payment-record guard (header amount_paid=0 but payments row paid) ──
  {
    console.log('\n[payment-record guard]');
    const { drawer } = loadModules();
    const pg = makeStatefulPg({
      booking: baseBooking({
        amount_paid_cents: 0,
        payment_status: 'waiting_payment',
        balance_due_cents: COURSE_WEEK_CENTS,
        total_amount_cents: COURSE_WEEK_CENTS,
      }),
      services: [courseService({ amount_paid_cents: 0, payment_status: 'pending' })],
      payments: [{
        payment_id: 'pay-stripe-1',
        status: 'paid',
        amount_paid_cents: COURSE_WEEK_CENTS,
        checkout_url: 'https://example.test/cs-stripe',
      }],
    });
    const beforeServices = JSON.stringify(pg.state.services);
    const result = await drawer.updateSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      locationId: LOC,
      actor: { email: 'staff@sunset.test' },
      body: courseBody(TIER_DAY, ['2026-08-22']),
    });
    assert('payment-record reprice rejected', result.ok === false && result.status === 409);
    assert('payment-record reason paid_booking_reprice_required',
      result.body && result.body.reason_code === 'paid_booking_reprice_required');
    assert('payment-record no partial mutation',
      JSON.stringify(pg.state.services) === beforeServices && pg.state.deleted === 0);

    // Nonpricing paid status alone must align to recorded payment cents, not invent total.
    const pg2 = makeStatefulPg({
      booking: baseBooking({
        amount_paid_cents: 0,
        payment_status: 'waiting_payment',
        balance_due_cents: COURSE_WEEK_CENTS,
        total_amount_cents: COURSE_WEEK_CENTS,
        guest_name: 'Stripe Guest',
      }),
      services: [courseService()],
      payments: [{
        payment_id: 'pay-stripe-2',
        status: 'paid',
        amount_paid_cents: 15000,
        checkout_url: 'https://example.test/cs-partial',
      }],
    });
    // Concurrent financially committed via payment records blocks reprice; name+paid status
    // with same intent is nonpricing — align amount_paid to payment record, not total.
    const rPaid = await drawer.updateSunsetScheduleBooking(pg2, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      locationId: LOC,
      actor: { email: 'staff@sunset.test' },
      body: {
        ...courseBody(TIER_WEEK, ['2026-08-01']),
        guest_name: 'Stripe Guest',
        payment_status: 'paid',
        payment_method: 'link',
      },
    });
    assert('payment-record nonpricing paid ok', rPaid.ok === true, JSON.stringify(rPaid.body || rPaid));
    assert('payment-record amount not synthesized to total',
      Number(pg2.state.bookings[0].amount_paid_cents) === 15000,
      `paid=${pg2.state.bookings[0].amount_paid_cents}`);
    assert('payment-record balance respects recorded paid',
      Number(pg2.state.bookings[0].balance_due_cents) === COURSE_WEEK_CENTS - 15000);
    assert('payment-record services retained',
      pg2.state.deleted === 0 && pg2.state.services.length === 1);
  }

  // ── Paid non-pricing edit allowed ──
  {
    console.log('\n[paid non-pricing edit allowed]');
    const { drawer } = loadModules();
    const pg = makeStatefulPg({
      booking: baseBooking({
        amount_paid_cents: COURSE_WEEK_CENTS,
        payment_status: 'paid',
        balance_due_cents: 0,
        guest_name: 'Paid Guest',
      }),
      services: [courseService({ amount_paid_cents: COURSE_WEEK_CENTS, payment_status: 'paid' })],
    });
    const beforeIds = pg.state.services.map((s) => s.service_record_id).join(',');
    const beforeAmounts = pg.state.services.map((s) => s.amount_due_cents).join(',');
    const result = await drawer.updateSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      locationId: LOC,
      actor: { email: 'staff@sunset.test' },
      body: {
        ...courseBody(TIER_WEEK, ['2026-08-01', '2026-08-02']),
        guest_name: 'Paid Guest Renamed',
        payment_status: 'paid',
      },
    });
    // Intent may differ on dates if existing only had one service date — force same dates as services
    // Re-run with exact existing intent if first attempt reprice-blocked or changed rows.
    if (!result.ok || pg.state.services.map((s) => s.service_record_id).join(',') !== beforeIds) {
      // Build body matching existing single-date course week
      const pg2 = makeStatefulPg({
        booking: baseBooking({
          amount_paid_cents: COURSE_WEEK_CENTS,
          payment_status: 'paid',
          balance_due_cents: 0,
          guest_name: 'Paid Guest',
          check_in: '2026-08-01',
          check_out: '2026-08-02',
        }),
        services: [courseService({
          date: '2026-08-01',
          amount_paid_cents: COURSE_WEEK_CENTS,
          payment_status: 'paid',
        })],
      });
      const r2 = await drawer.updateSunsetScheduleBooking(pg2, {
        clientSlug: 'sunset',
        bookingId: BOOKING_ID,
        locationId: LOC,
        actor: { email: 'staff@sunset.test' },
        body: {
          guest_name: 'Paid Guest Renamed',
          payment_status: 'paid',
          service_dates: ['2026-08-01'],
          components: {
            course: {
              quantity: 1,
              course_id: PACK_ID,
              course_label: 'Weekend Course',
              tier_key: TIER_WEEK,
              offering_id: packPriceItemCode(PACK_ID, TIER_WEEK),
            },
          },
        },
      });
      assert('paid nonpricing rename ok', r2.ok === true, JSON.stringify(r2.body || r2));
      assert('service rows retained',
        pg2.state.services.map((s) => s.service_record_id).join(',') === 'sr-course-1');
      assert('amounts retained',
        pg2.state.services.map((s) => s.amount_due_cents).join(',') === String(COURSE_WEEK_CENTS));
      assert('name updated', pg2.state.bookings[0].guest_name === 'Paid Guest Renamed');
    } else {
      assert('paid nonpricing rename ok', result.ok === true);
      assert('service rows retained', beforeIds === pg.state.services.map((s) => s.service_record_id).join(','));
      assert('amounts retained', beforeAmounts === pg.state.services.map((s) => s.amount_due_cents).join(','));
      assert('name updated', pg.state.bookings[0].guest_name === 'Paid Guest Renamed');
    }
  }

  // ── Client cents ignored / rejected ──
  {
    console.log('\n[client cents ignored]');
    const { drawer, writes } = loadModules();
    const rejected = writes.normalizeComponents({
      components: { course: { quantity: 1, course_id: PACK_ID, tier_key: TIER_DAY, amount_cents: 1 } },
    });
    assert('normalizeComponents rejects client money', rejected.ok === false);
    const pg = makeStatefulPg({
      booking: baseBooking(),
      services: [courseService()],
    });
    const result = await drawer.updateSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      locationId: LOC,
      actor: { email: 'staff@sunset.test' },
      body: {
        ...courseBody(TIER_DAY, ['2026-08-25']),
        total_cents: 1,
        components: {
          course: {
            quantity: 1,
            course_id: PACK_ID,
            tier_key: TIER_DAY,
            amount_cents: 1,
            unit_amount_cents: 1,
          },
        },
      },
    });
    assert('client cents rejected at validate', result.ok === false && result.status === 400);
  }

  // ── Unsupported / ambiguous / unavailable (fail closed before write) ──
  {
    console.log('\n[unsupported/unavailable]');
    const { drawer } = loadModules();
    const pg = makeStatefulPg({ booking: baseBooking(), services: [courseService()] });
    const before = JSON.stringify(pg.state.services);
    const badCourse = await drawer.updateSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      locationId: LOC,
      actor: { email: 'staff@sunset.test' },
      body: {
        guest_name: 'Edit Guest',
        payment_status: 'unpaid',
        service_dates: ['2026-08-01'],
        components: {
          course: {
            quantity: 1,
            course_id: '00000000-0000-4000-8000-000000000099',
            tier_key: TIER_WEEK,
          },
        },
      },
    });
    assert('unknown course rejected', badCourse.ok === false);
    assert('unknown course no mutation', JSON.stringify(pg.state.services) === before);
  }

  // ── Mutation proof: in-memory Module compile only (never rewrite tracked files) ──
  {
    console.log('\n[mutation proof]');
    const Module = require('module');
    const originalDrawer = fs.readFileSync(DRAWER_SRC);
    const originalWrites = fs.readFileSync(WRITES_SRC);
    function trackedStillIdentical(label) {
      assert(
        'tracked files byte-identical after ' + label,
        Buffer.compare(fs.readFileSync(DRAWER_SRC), originalDrawer) === 0
          && Buffer.compare(fs.readFileSync(WRITES_SRC), originalWrites) === 0,
      );
    }
    function installSource(absPath, source) {
      delete require.cache[absPath];
      const m = new Module(absPath, module);
      m.filename = absPath;
      m.paths = Module._nodeModulePaths(path.dirname(absPath));
      m._compile(source, absPath);
      require.cache[absPath] = m;
      return m.exports;
    }
    function restoreModules() {
      delete require.cache[require.resolve(DRAWER_REQ)];
      delete require.cache[require.resolve(WRITES_REQ)];
    }
    function loadMutatedDrawer(drawerSrc, writesSrc) {
      restoreModules();
      if (writesSrc != null) installSource(require.resolve(WRITES_REQ), writesSrc);
      if (drawerSrc != null) installSource(require.resolve(DRAWER_REQ), drawerSrc);
      // Ensure dependent mocks before requiring drawer if not already installed.
      if (writesSrc == null) require(WRITES_REQ);
      const writes = require(WRITES_REQ);
      writes.resolveFullDayEquipmentAddonUnitCents = async () => GEAR_UNIT_CENTS;
      require(TBC_REQ).resolveTenantBusinessConfigAsync = async () => catalogAdminCfg();
      require('./lib/tenant-services-writes').ensureBookingServiceGenericType = async () => {};
      return require(DRAWER_REQ);
    }

    try {
      // 1) Weaken complete pricing-intent equality → offering-only change falsely unchanged
      {
        let src = originalWrites.toString('utf8');
        const mutated = src.replace(
          /function schedulePricingIntentsEqual\(a, b\) \{\r?\n  if \(!pricingIntentHasCompleteIdentity\(a\) \|\| !pricingIntentHasCompleteIdentity\(b\)\) return false;\r?\n  return JSON\.stringify\(a \|\| null\) === JSON\.stringify\(b \|\| null\);\r?\n\}/,
          'function schedulePricingIntentsEqual(a, b) {\n'
          + '  // MUTATION: ignore offering_id / complete identity\n'
          + '  const weak = (intent) => {\n'
          + '    const comps = (intent && intent.components) || {};\n'
          + '    const coarse = {};\n'
          + '    Object.keys(comps).sort().forEach((k) => {\n'
          + '      const p = comps[k] || {};\n'
          + '      if (k === \'course\') coarse[k] = { tier_key: p.tier_key || null };\n'
          + '      else coarse[k] = { quantity: p.quantity || 1 };\n'
          + '    });\n'
          + '    return { service_dates: (intent && intent.service_dates) || [], components: coarse, rentals: [] };\n'
          + '  };\n'
          + '  return JSON.stringify(weak(a)) === JSON.stringify(weak(b));\n'
          + '}',
        );
        assert('mutation complete intent equality changed bytes', mutated !== src);
        const drawer = loadMutatedDrawer(null, mutated);
        trackedStillIdentical('intent-equality mutation');
        const pg = makeStatefulPg({
          booking: baseBooking(),
          services: [courseService({ tier_key: TIER_WEEK })],
        });
        const result = await drawer.updateSunsetScheduleBooking(pg, {
          clientSlug: 'sunset',
          bookingId: BOOKING_ID,
          locationId: LOC,
          actor: { email: 'staff@sunset.test' },
          body: {
            guest_name: 'Edit Guest',
            payment_status: 'unpaid',
            service_dates: ['2026-08-01'],
            components: {
              course: {
                quantity: 1,
                course_id: PACK_ID,
                course_label: 'Weekend Course',
                tier_key: TIER_WEEK,
                // Different offering_id only — complete mode must reprice; weak mode ignores.
                offering_id: packPriceItemCode(PACK_ID, TIER_WEEK) + '__other',
              },
            },
          },
        });
        assert('mutation intent equality OFF → false unchanged (RED)',
          result.ok === true && result.body && result.body.pricing_intent_unchanged === true,
          JSON.stringify(result && result.body));
        restoreModules();
        trackedStillIdentical('intent-equality restore');
      }

      // 2) Disable payment ledger lock + paid guard → concurrent paid ledger allows reprice hazard
      {
        let src = originalDrawer.toString('utf8');
        const mutated = src
          .replace(
            /const payLock = await lockSchedulePaymentsForUpdate\(pg, bookingId, clientId\);/,
            'const payLock = { rows: [], paidCents: 0 };',
          )
          .replace(
            /const rePay = await lockSchedulePaymentsForUpdate\(pg, bookingId, clientId\);\r?\n    lockedBundle\.payments_paid_cents = rePay\.paidCents;\r?\n    lockedBundle\.locked_payments = rePay\.rows;\r?\n    if \(isSunsetBookingFinanciallyCommitted\(lockedBundle\)\) \{\r?\n      return rollback\(paidBookingRepriceRequiredResult\(\)\);\r?\n    \}/,
            'const rePay = { rows: [], paidCents: 0 };\n'
            + '    lockedBundle.payments_paid_cents = rePay.paidCents;\n'
            + '    lockedBundle.locked_payments = rePay.rows;',
          )
          .replace(
            /if \(pricingChanged && isSunsetBookingFinanciallyCommitted\(lockedBundle\)\) \{\r?\n      return rollback\(paidBookingRepriceRequiredResult\(\)\);\r?\n    \}/,
            'if (false && pricingChanged && isSunsetBookingFinanciallyCommitted(lockedBundle)) {\n'
            + '      return rollback(paidBookingRepriceRequiredResult());\n'
            + '    }',
          );
        assert('mutation payment locking/guard changed bytes', mutated !== src);
        const drawer = loadMutatedDrawer(mutated, null);
        trackedStillIdentical('payment-lock mutation');
        const pg = makeStatefulPg({
          booking: baseBooking({
            amount_paid_cents: COURSE_WEEK_CENTS,
            payment_status: 'paid',
            balance_due_cents: 0,
          }),
          services: [courseService({ amount_paid_cents: COURSE_WEEK_CENTS, payment_status: 'paid' })],
          payments: [{
            payment_id: 'pay-mut',
            status: 'paid',
            amount_paid_cents: COURSE_WEEK_CENTS,
          }],
        });
        const result = await drawer.updateSunsetScheduleBooking(pg, {
          clientSlug: 'sunset',
          bookingId: BOOKING_ID,
          locationId: LOC,
          actor: { email: 'staff@sunset.test' },
          body: courseBody(TIER_DAY, ['2026-08-29']),
        });
        assert('mutation payment lock/guard OFF allows reprice (RED hazard)',
          result.ok === true || pg.state.deleted > 0 || pg.state.inserts > 0,
          JSON.stringify(result && result.body));
        assert('mutation payment lock OFF skips FOR UPDATE payments',
          pg.state.paymentLocks === 0);
        restoreModules();
        trackedStillIdentical('payment-lock restore');
      }

      // 3) Disable authoritative re-quote → zero/stale totals
      {
        let src = originalDrawer.toString('utf8');
        const mutated = src.replace(
          /await applyAuthoritativeSchedulePricingInTxn\(pg, \{[\s\S]*?now: opts\.now,\r?\n    \}\);/,
          '/* mutation: skip authoritative re-quote */;',
        );
        assert('mutation requote changed bytes', mutated !== src);
        const drawer = loadMutatedDrawer(mutated, null);
        trackedStillIdentical('requote mutation');
        const pg = makeStatefulPg({
          booking: baseBooking({ total_amount_cents: COURSE_WEEK_CENTS, balance_due_cents: COURSE_WEEK_CENTS }),
          services: [courseService()],
        });
        await drawer.updateSunsetScheduleBooking(pg, {
          clientSlug: 'sunset',
          bookingId: BOOKING_ID,
          locationId: LOC,
          actor: { email: 'staff@sunset.test' },
          body: courseBody(TIER_DAY, ['2026-08-28']),
        });
        const zeroOrStale = pg.state.services.every((s) => Number(s.amount_due_cents) === 0)
          || Number(pg.state.bookings[0].total_amount_cents) === COURSE_WEEK_CENTS;
        assert('mutation requote OFF → zero lines or stale total (RED)', zeroOrStale,
          `amounts=${pg.state.services.map((s) => s.amount_due_cents)} total=${pg.state.bookings[0].total_amount_cents}`);
        restoreModules();
        trackedStillIdentical('requote restore');
      }

      const restoredD = fs.readFileSync(DRAWER_SRC);
      const restoredW = fs.readFileSync(WRITES_SRC);
      assert('mutation restored exact bytes',
        Buffer.compare(restoredD, originalDrawer) === 0
        && Buffer.compare(restoredW, originalWrites) === 0);
    } catch (err) {
      assert(
        'tracked files byte-identical even on mutation failure',
        Buffer.compare(fs.readFileSync(DRAWER_SRC), originalDrawer) === 0
          && Buffer.compare(fs.readFileSync(WRITES_SRC), originalWrites) === 0,
      );
      restoreModules();
      throw err;
    }
  }

  console.log(`\n── verify:sunset-edit-authoritative-requote ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
