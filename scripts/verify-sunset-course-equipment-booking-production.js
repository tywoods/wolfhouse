'use strict';

/**
 * Stage 4B — multi-item course equipment persistence production gates.
 *
 * Exercises the REAL exported Schedule Create + Edit owners
 * (createSunsetScheduleBooking / updateSunsetScheduleBooking) through a
 * transaction-aware fake pg (BEGIN snapshot / COMMIT / ROLLBACK restore).
 * Helper-level insertCourseEquipmentRows coverage remains supplemental only.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');

const ROOT = path.join(__dirname, '..');
const WRITES_REQ = path.join(__dirname, 'lib', 'sunset-schedule-booking-writes.js');
const DRAWER_REQ = path.join(__dirname, 'lib', 'sunset-schedule-booking-drawer.js');
const TBC_REQ = path.join(__dirname, 'lib', 'tenant-business-config.js');
const COURSE_REQ = path.join(__dirname, 'lib', 'sunset-admin-course-join.js');
const LINKS_REQ = path.join(__dirname, 'lib', 'sunset-stripe-payment-links.js');
const INVOICE_REQ = path.join(__dirname, 'lib', 'service-record-invoice-line.js');

process.env.SUNSET_ADMIN_DB_READ_ENABLED = '1';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const BOOKING_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PACK_ID = '22222222-2222-4222-8222-222222222222';
const LOC = 'sunset-somo';
const TIER = '2_days';
const GROUP_UNIT = 4000;
const PRIVATE_UNIT = 6000;
const FIXED_NOW = new Date('2026-07-28T12:00:00Z');
const GROUP_ITEM = packPriceItemCode(PACK_ID, TIER);

const OFFERINGS = [
  { id: 'ro-1', client_slug: 'sunset', location_id: LOC, offering_key: 'softboard', label: 'Softboard', group_key: 'boards', excludes: [], sort_order: 1, active: true },
  { id: 'ro-2', client_slug: 'sunset', location_id: LOC, offering_key: 'carbon_fins', label: 'Carbon Fins', group_key: 'fins', excludes: [], sort_order: 2, active: true },
  { id: 'ro-3', client_slug: 'sunset', location_id: LOC, offering_key: 'same_label_a', label: 'Twin Label', group_key: 'misc', excludes: [], sort_order: 3, active: true },
  { id: 'ro-4', client_slug: 'sunset', location_id: LOC, offering_key: 'same_label_b', label: 'Twin Label', group_key: 'misc', excludes: [], sort_order: 4, active: true },
  { id: 'ro-5', client_slug: 'sunset', location_id: LOC, offering_key: 'no_price_row', label: 'No Standalone Price', group_key: 'misc', excludes: [], sort_order: 5, active: true },
  { id: 'ro-6', client_slug: 'sunset', location_id: LOC, offering_key: 'zero_surcharge', label: 'Zero Surcharge Kit', group_key: 'misc', excludes: [], sort_order: 6, active: true },
  { id: 'ro-7', client_slug: 'sunset', location_id: LOC, offering_key: 'inactive_rental', label: 'Inactive', group_key: 'misc', excludes: [], sort_order: 7, active: false },
  { id: 'ro-8', client_slug: 'sunset', location_id: 'sunset-sardinero', offering_key: 'foreign_location', label: 'Sardinero Only', group_key: 'misc', excludes: [], sort_order: 8, active: true },
  { id: 'ro-9', client_slug: 'other', location_id: LOC, offering_key: 'foreign_tenant', label: 'Foreign Tenant', group_key: 'misc', excludes: [], sort_order: 9, active: true },
];

const GROUP_OPTIONS = [
  { offering_key: 'softboard', equipment_price_cents: 500, all_day_surcharge_cents: 1000 },
  { offering_key: 'carbon_fins', equipment_price_cents: 200, all_day_surcharge_cents: 0 },
  { offering_key: 'same_label_a', equipment_price_cents: 111, all_day_surcharge_cents: 0 },
  { offering_key: 'same_label_b', equipment_price_cents: 222, all_day_surcharge_cents: 0 },
  { offering_key: 'no_price_row', equipment_price_cents: 333, all_day_surcharge_cents: 0 },
  { offering_key: 'zero_surcharge', equipment_price_cents: 400, all_day_surcharge_cents: 0 },
];

const PRIVATE_OPTIONS = [
  { offering_key: 'softboard', equipment_price_cents: 700, all_day_surcharge_cents: 300 },
  { offering_key: 'carbon_fins', equipment_price_cents: 250, all_day_surcharge_cents: 50 },
];

function parseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function durableState(pg) {
  return deepClone({
    bookings: pg.state.bookings,
    services: pg.state.services,
    payments: pg.state.payments,
  });
}

function catalogAdminCfg() {
  return {
    ok: true,
    source: 'db',
    currency: 'EUR',
    rental_offerings: OFFERINGS.filter((o) => o.active !== false && o.client_slug === 'sunset' && o.location_id === LOC),
    surf_packs: [{
      pack_id: PACK_ID,
      label: 'Verifier Group',
      active: true,
      group_size: 8,
      weekly: 'daily',
      schedules: ['0930_1130'],
      equipment_options: GROUP_OPTIONS,
      price_tiers: [{ key: TIER, label: '2 days', hours: 4, amount_cents: GROUP_UNIT, duration_days: 2 }],
    }],
    prices: [
      {
        id: 'price-group',
        category: 'package',
        item_type: 'package',
        item_code: GROUP_ITEM,
        offering_key: GROUP_ITEM,
        amount_cents: GROUP_UNIT,
        unit: 'day',
        active: true,
        currency: 'EUR',
        location_id: LOC,
      },
      {
        id: 'price-private',
        category: 'lesson',
        item_type: 'lesson',
        item_code: 'private_lesson__session',
        offering_key: 'private_lesson__session',
        amount_cents: PRIVATE_UNIT,
        unit: 'session',
        active: true,
        currency: 'EUR',
        location_id: LOC,
      },
    ],
    private_lesson: {
      id: 'private-verify',
      enabled: true,
      label: 'Private Course',
      amount_cents: PRIVATE_UNIT,
      currency: 'EUR',
      price_basis: 'per_session',
      default_duration_minutes: 120,
      equipment_options: PRIVATE_OPTIONS,
    },
  };
}

function packConfigJson() {
  return {
    age_band: '12_and_up',
    group_size: 8,
    beaches: ['somo'],
    weekly: 'daily',
    schedules: ['0930_1130'],
    equipment_options: GROUP_OPTIONS,
    price_tiers: [
      { key: TIER, label: '2 days', hours: 4, amount_cents: GROUP_UNIT, duration_days: 2 },
    ],
  };
}

function privateConfigJson() {
  return {
    enabled: true,
    amount_cents: PRIVATE_UNIT,
    currency: 'EUR',
    price_basis: 'per_session',
    default_duration_minutes: 120,
    equipment_options: PRIVATE_OPTIONS,
  };
}

/**
 * Transaction-aware fake pg for Create/Edit owners.
 * BEGIN snapshots durable tables; ROLLBACK restores; COMMIT keeps mutations.
 */
function makeTxnPg(seed = {}) {
  const state = {
    bookings: deepClone(seed.bookings || []),
    services: deepClone(seed.services || []),
    payments: deepClone(seed.payments || []),
    offerings: deepClone(seed.offerings || OFFERINGS),
    clientId: seed.clientId || CLIENT_ID,
    rollbacks: 0,
    commits: 0,
    begins: 0,
    equipmentInserts: 0,
    serviceInserts: 0,
    failAt: seed.failAt || null,
    txSnap: null,
    locked: false,
  };

  function snap() {
    return {
      bookings: deepClone(state.bookings),
      services: deepClone(state.services),
      payments: deepClone(state.payments),
    };
  }

  function restore(s) {
    state.bookings = s.bookings;
    state.services = s.services;
    state.payments = s.payments;
  }

  function findBooking(id) {
    return state.bookings.find((b) => String(b.booking_id || b.id) === String(id));
  }

  const pg = {
    state,
    async query(sql, params = []) {
      const q = String(sql);

      if (/^\s*BEGIN\b/i.test(q)) {
        state.begins += 1;
        state.txSnap = snap();
        state.locked = true;
        return { rows: [], rowCount: 0 };
      }
      if (/^\s*COMMIT\b/i.test(q)) {
        state.commits += 1;
        state.txSnap = null;
        state.locked = false;
        return { rows: [], rowCount: 0 };
      }
      if (/^\s*ROLLBACK\b/i.test(q)) {
        state.rollbacks += 1;
        if (state.txSnap) restore(state.txSnap);
        state.txSnap = null;
        state.locked = false;
        return { rows: [], rowCount: 0 };
      }

      if (/pg_advisory/i.test(q)) return { rows: [], rowCount: 0 };
      if (/^\s*ALTER TABLE/i.test(q)) return { rows: [], rowCount: 0 };
      if (/to_regclass/i.test(q)) return { rows: [{ reg: 'tenant_price_rules', t: 'booking_service_records' }] };
      if (/information_schema\.columns/i.test(q)) return { rows: [{ column_name: 'location_id', '?column?': 1 }] };
      if (/information_schema\.tables/i.test(q)) return { rows: [{ table_name: 'tenant_price_rules' }] };
      if (/pg_constraint/i.test(q)) {
        return { rows: [{ definition: "CHECK ((service_type)::text = ANY ((ARRAY['addon_service'::character varying])::text[]))" }] };
      }

      if (/SELECT id FROM clients/i.test(q)) {
        return { rows: [{ id: state.clientId }] };
      }

      if (/FROM tenant_rental_offerings/i.test(q)) {
        const slug = params[0];
        const loc = params[1];
        const rows = state.offerings.filter((o) => {
          if (String(o.client_slug) !== String(slug)) return false;
          if (o.active === false && /active = true/i.test(q)) return false;
          if (loc != null && o.location_id != null && String(o.location_id) !== String(loc) && o.location_id !== null) {
            // SQL uses location_id = $n OR location_id IS NULL
            if (o.location_id != null && String(o.location_id) !== String(loc)) return false;
          }
          return true;
        }).filter((o) => {
          if (loc == null) return true;
          return o.location_id == null || String(o.location_id) === String(loc);
        });
        return { rows: rows.filter((o) => o.active !== false || !/active = true/i.test(q)) };
      }

      if (/FROM tenant_surf_pack_rules/i.test(q)) {
        return {
          rows: [{
            id: PACK_ID,
            label: 'Verifier Group',
            config_json: packConfigJson(),
            active: true,
          }],
        };
      }

      if (/FROM tenant_private_lesson_rules/i.test(q) || (/private_lesson/i.test(q) && /config_json/i.test(q) && /SELECT/i.test(q))) {
        return {
          rows: [{
            id: 'private-verify',
            label: 'Private Course',
            config_json: privateConfigJson(),
            active: true,
          }],
        };
      }

      if (/FROM tenant_price_rules/i.test(q)) {
        const itemCode = params.find((p, i) => i >= 1 && typeof p === 'string' && String(p).includes('__'))
          || params[2]
          || params[1];
        const code = String(itemCode || '');
        const cfg = catalogAdminCfg();
        const match = (cfg.prices || []).find((p) => String(p.item_code) === code || String(p.offering_key) === code);
        if (!match) return { rows: [] };
        return {
          rows: [{
            id: match.id,
            amount_cents: match.amount_cents,
            currency: 'EUR',
            item_type: match.item_type || match.category,
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

      // Capacity seat count
      if (/COALESCE\(SUM/i.test(q) && /booking_service_records/i.test(q)) {
        return { rows: [{ seats: 0, count: 0 }] };
      }

      // Booking lock / header reads
      if (/FROM bookings b/i.test(q) && /INNER JOIN clients/i.test(q)) {
        const id = params[1];
        const b = findBooking(id) || state.bookings[0];
        if (!b) return { rows: [] };
        if (/FOR UPDATE/i.test(q)) {
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
        return {
          rows: [{
            booking_id: b.booking_id,
            booking_code: b.booking_code,
            guest_name: b.guest_name,
            phone: b.phone,
            status: b.status,
            payment_status: b.payment_status,
            check_in: b.check_in,
            check_out: b.check_out,
            guest_count: b.guest_count,
            total_amount_cents: b.total_amount_cents,
            amount_paid_cents: b.amount_paid_cents,
            balance_due_cents: b.balance_due_cents,
            metadata: b.metadata,
          }],
        };
      }

      if (/FROM payments/i.test(q) && /FOR UPDATE/i.test(q)) {
        return {
          rows: state.payments.map((p) => ({
            payment_id: p.payment_id || p.id,
            payment_status: p.status || p.payment_status,
            amount_due_cents: p.amount_due_cents || 0,
            amount_paid_cents: p.amount_paid_cents || 0,
          })),
        };
      }
      if (/FROM payments/i.test(q) && /checkout_url/i.test(q)) {
        return { rows: state.payments.filter((p) => p.checkout_url).slice(0, 1) };
      }
      if (/SUM\(amount_paid_cents\)/i.test(q) && /FROM payments/i.test(q)) {
        const paid = state.payments
          .filter((p) => String(p.status || p.payment_status) === 'paid')
          .reduce((s, p) => s + (Number(p.amount_paid_cents) || 0), 0);
        return { rows: [{ paid_total: paid }] };
      }
      if (/SELECT COALESCE\(total_amount_cents/i.test(q) && /FROM bookings/i.test(q)) {
        const b = findBooking(params[0]) || state.bookings[0];
        return { rows: b ? [{ total: Number(b.total_amount_cents) || 0 }] : [] };
      }

      if (/FROM booking_service_records/i.test(q)
        && !/INSERT/i.test(q)
        && !/DELETE/i.test(q)
        && !/UPDATE/i.test(q)
        && !/SUM/i.test(q)) {
        const bookingId = params[1];
        const rows = state.services
          .filter((s) => !bookingId || String(s.booking_id || BOOKING_ID) === String(bookingId)
            || state.bookings.some((b) => String(b.booking_id) === String(bookingId)))
          .map((s) => ({
            ...s,
            id: s.id || s.service_record_id,
            service_record_id: s.service_record_id || s.id,
            metadata: s.metadata,
            record_source: s.record_source || s.source,
          }));
        // Prefer booking-scoped if possible
        const scoped = state.services.filter((s) => {
          if (!bookingId) return true;
          return String(s.booking_id || '') === String(bookingId)
            || (!s.booking_id && state.bookings[0] && String(state.bookings[0].booking_id) === String(bookingId));
        });
        const out = (scoped.length ? scoped : rows).map((s) => ({
          ...s,
          id: s.id || s.service_record_id,
          service_record_id: s.service_record_id || s.id,
          metadata: s.metadata,
          record_source: s.record_source || s.source || 'staff_manual',
        }));
        return { rows: out };
      }

      if (/DELETE FROM booking_service_records/i.test(q)) {
        const sources = Array.isArray(params[2]) ? params[2] : [params[2]];
        state.services = state.services.filter((s) => {
          const src = s.record_source || s.source;
          return !sources.includes(src);
        });
        return { rowCount: 1 };
      }

      if (/INSERT INTO bookings/i.test(q)) {
        const id = seed.nextBookingId || `bbbbbbbb-bbbb-4bbb-8bbb-${String(state.bookings.length + 1).padStart(12, '0')}`;
        const meta = parseMeta(params[8]);
        const row = {
          booking_id: id,
          id,
          booking_code: params[1],
          guest_name: params[2],
          phone: params[3],
          status: params[4],
          payment_status: params[5],
          check_in: params[6],
          check_out: params[6],
          guest_count: params[7],
          total_amount_cents: 0,
          amount_paid_cents: 0,
          balance_due_cents: 0,
          metadata: meta,
          client_id: params[0],
        };
        state.bookings.push(row);
        return { rows: [{ id, booking_code: params[1] }], rowCount: 1 };
      }

      if (/INSERT INTO booking_service_records/i.test(q)) {
        state.serviceInserts += 1;
        // Standard insertServiceRecord params:
        // 0 client, 1 bookingId, 2 code, 3 guest, 4 type, 5 date, 6 qty, 7 pay, 8 source, 9 meta
        // With time: + time_local, time_end at 10/11
        // Generic rental: amount_due is $8 (VALUES ...'confirmed', $8, 0, $9, $10, $11)
        let serviceType = params[4];
        let serviceDate = params[5];
        let quantity = params[6];
        let paymentStatus = params[7];
        let source = params[8];
        let metaRaw = params[9];
        let amountDue = 0;
        let bookingId = params[1];
        let bookingCode = params[2];
        let guestName = params[3];

        // Distinguish generic rental amount-inline insert from standard (0,0,$8 payment).
        if (/'confirmed',\s*\$8,\s*0,\s*\$9/i.test(q)) {
          amountDue = Number(params[7]) || 0;
          paymentStatus = params[8];
          source = params[9];
          metaRaw = params[10];
        }

        const meta = parseMeta(metaRaw);
        if (meta.course_equipment === true) {
          state.equipmentInserts += 1;
          if (state.failAt === 'equipment_insert_2' && state.equipmentInserts === 2) {
            throw new Error('simulated_second_equipment_insert_failure');
          }
        }

        const id = `00000000-0000-4000-8000-${String(state.serviceInserts).padStart(12, '0')}`;
        const row = {
          id,
          service_record_id: id,
          client_slug: params[0],
          booking_id: bookingId,
          booking_code: bookingCode,
          guest_name: guestName,
          service_type: serviceType,
          service_date: String(serviceDate || '').slice(0, 10),
          quantity,
          amount_due_cents: amountDue,
          amount_paid_cents: 0,
          payment_status: paymentStatus || 'pending',
          record_source: source,
          source,
          metadata: meta,
          metadata_component: meta.component || null,
          metadata_source: meta.source || null,
          location_id: meta.location_id || LOC,
          service_time_local: params[10] || null,
          service_time_local_end: params[11] || null,
        };
        state.services.push(row);
        return {
          rows: [{
            service_record_id: id,
            id,
            booking_id: bookingId,
            booking_code: bookingCode,
            guest_name: guestName,
            service_type: serviceType,
            service_date: row.service_date,
            quantity,
            payment_status: row.payment_status,
            record_source: source,
            amount_due_cents: amountDue,
            metadata: meta,
            metadata_component: row.metadata_component,
            metadata_source: row.metadata_source,
            staff_ui_service_type: meta.staff_ui_service_type || null,
            location_id: row.location_id,
            service_time_local: row.service_time_local,
            service_time_local_end: row.service_time_local_end,
          }],
          rowCount: 1,
        };
      }

      if (/UPDATE booking_service_records/i.test(q) && /amount_due_cents/i.test(q)) {
        const due = Number(params[0]);
        // Custom-line form: SET amount_due_cents=$1, metadata=...$2 WHERE id=$3
        if (/metadata/i.test(q) && params.length >= 3
          && typeof params[1] === 'string' && String(params[1]).trim().startsWith('{')) {
          const id = String(params[2]);
          const row = state.services.find((s) => String(s.service_record_id || s.id) === id);
          if (!row) return { rowCount: 0, rows: [] };
          row.amount_due_cents = due;
          row.metadata = { ...parseMeta(row.metadata), ...parseMeta(params[1]) };
          return { rowCount: 1, rows: [] };
        }
        // Standard: SET amount_due_cents=$1 WHERE id=$2
        const id = String(params[1]);
        const row = state.services.find((s) => String(s.service_record_id || s.id) === id);
        if (!row) return { rowCount: 0, rows: [] };
        row.amount_due_cents = due;
        return { rowCount: 1, rows: [] };
      }

      if (/UPDATE bookings/i.test(q) && /total_amount_cents/i.test(q)) {
        const b = findBooking(params[2]) || findBooking(params[3]) || state.bookings[0];
        if (!b) return { rowCount: 0, rows: [] };
        b.total_amount_cents = Number(params[0]);
        if (params[1] && typeof params[1] === 'string' && String(params[1]).startsWith('{')) {
          b.metadata = { ...parseMeta(b.metadata), ...parseMeta(params[1]) };
          b.balance_due_cents = Math.max(Number(params[0]) - Number(b.amount_paid_cents || 0), 0);
        } else if (params.length >= 4 && Number.isFinite(Number(params[1]))) {
          b.amount_paid_cents = Number(params[1]) || 0;
          b.balance_due_cents = Number(params[2]) || 0;
          if (params[3] && typeof params[3] === 'string' && String(params[3]).startsWith('{')) {
            b.metadata = { ...parseMeta(b.metadata), ...parseMeta(params[3]) };
          }
        } else {
          b.balance_due_cents = Math.max(Number(params[0]) - Number(b.amount_paid_cents || 0), 0);
        }
        return { rowCount: 1, rows: [] };
      }

      if (/UPDATE bookings/i.test(q) && /amount_paid_cents/i.test(q) && !/total_amount_cents/i.test(q)) {
        const b = findBooking(params[2]) || findBooking(params[3]) || state.bookings[0];
        if (!b) return { rowCount: 0, rows: [] };
        b.amount_paid_cents = Number(params[0]) || 0;
        if (params.length >= 2 && Number.isFinite(Number(params[1]))) {
          b.balance_due_cents = Number(params[1]) || 0;
        }
        return { rowCount: 1, rows: [] };
      }

      if (/UPDATE bookings/i.test(q) && /guest_name/i.test(q)) {
        const b = findBooking(params[params.length - 2]) || state.bookings[0];
        if (!b) return { rowCount: 0, rows: [] };
        b.guest_name = params[0];
        b.phone = params[1] || b.phone;
        b.status = params[2];
        b.payment_status = params[3];
        if (params.length >= 9) {
          b.check_in = params[4];
          b.guest_count = params[6];
          b.metadata = { ...parseMeta(b.metadata), ...parseMeta(params[7]) };
        } else {
          b.guest_count = params[4];
          b.metadata = { ...parseMeta(b.metadata), ...parseMeta(params[5]) };
        }
        return { rowCount: 1, rows: [] };
      }

      if (/SELECT metadata FROM bookings/i.test(q)) {
        const b = state.bookings[0];
        return { rows: b ? [{ metadata: b.metadata }] : [] };
      }

      // Unmatched SELECT returns empty — fail-closed paths stay safe.
      if (/^\s*SELECT\b/i.test(q)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
  return pg;
}

function loadModules() {
  for (const req of [WRITES_REQ, DRAWER_REQ, TBC_REQ, COURSE_REQ, LINKS_REQ, INVOICE_REQ]) {
    try { delete require.cache[require.resolve(req)]; } catch (_) { /* ignore */ }
  }
  // Clear dependent modules that cache admin cfg consumers
  for (const key of Object.keys(require.cache)) {
    if (/luna-front-desk-quote-service|luna-front-desk-catalog-service|sunset-bookable-offerings|tenant-rental-offerings|sunset-admin-pack-rules|sunset-admin-private-lesson|sunset-admin-price|tenant-services-writes|service-record-invoice/.test(key)) {
      delete require.cache[key];
    }
  }
  const tbc = require(TBC_REQ);
  tbc.resolveTenantBusinessConfigAsync = async () => catalogAdminCfg();
  tbc.resolveTenantBusinessConfig = () => catalogAdminCfg();
  try {
    require('./lib/tenant-services-writes').ensureBookingServiceGenericType = async () => {};
  } catch (_) { /* ignore */ }
  const writes = require(WRITES_REQ);
  const drawer = require(DRAWER_REQ);
  const { formatServiceRecordInvoiceLineText } = require(INVOICE_REQ);
  return { writes, drawer, formatServiceRecordInvoiceLineText };
}

function selectionMixed() {
  return [
    { offering_key: 'softboard', mode: 'all_day', quantity: 2 },
    { offering_key: 'carbon_fins', mode: 'during_course', quantity: 1 },
  ];
}

function groupCreateBody(equipment, extras = {}) {
  return {
    guest_name: extras.guest_name || 'Group Guest',
    guest_phone: '+34600111222',
    date_from: '2026-08-03',
    date_to: '2026-08-04',
    service_dates: ['2026-08-03', '2026-08-04'],
    payment_status: 'unpaid',
    components: {
      course: {
        quantity: 3,
        course_id: PACK_ID,
        course_label: 'Verifier Group',
        tier_key: TIER,
      },
    },
    course_equipment: equipment,
    ...extras,
  };
}

function privateCreateBody(equipment, extras = {}) {
  return {
    guest_name: extras.guest_name || 'Private Guest',
    guest_phone: '+34600111222',
    date_from: '2026-08-10',
    date_to: '2026-08-10',
    service_dates: ['2026-08-10'],
    payment_status: 'unpaid',
    components: {
      private_lesson: {
        enabled: true,
        surfer_count: 3,
        quantity: 1,
        sessions: [{ date: '2026-08-10', start: '10:00', end: '12:00' }],
      },
    },
    course_equipment: equipment,
    ...extras,
  };
}

function equipmentRowsOf(services) {
  return (services || []).filter((s) => parseMeta(s.metadata).course_equipment === true);
}

function assertEquipmentRow(row, exp) {
  const meta = parseMeta(row.metadata);
  assert.strictEqual(meta.course_equipment, true, 'course_equipment flag');
  assert.strictEqual(meta.offering_key, exp.offering_key);
  assert.strictEqual(meta.course_equipment_mode, exp.mode);
  assert.strictEqual(Number(row.quantity), exp.quantity);
  assert.strictEqual(Number(row.amount_due_cents), exp.total, `${exp.offering_key} total`);
  assert.strictEqual(Number(meta.unit_amount_cents), exp.unit, `${exp.offering_key} unit`);
  assert.strictEqual(Number(meta.base_unit_cents), exp.base);
  assert.strictEqual(Number(meta.all_day_surcharge_unit_cents), exp.surcharge);
  assert.strictEqual(meta.label, exp.label);
  assert.strictEqual(meta.pricing_provenance, 'course_owned_equipment');
  assert.strictEqual(meta.price_source, 'course_owned_equipment');
  assert.strictEqual(meta.price_basis, 'per_person_per_course');
  assert.strictEqual(meta.location_id, LOC);
  assert.notStrictEqual(row.service_type, 'surfboard');
  assert.notStrictEqual(row.service_type, 'wetsuit');
}

function seedEditBooking() {
  const equipSoft = {
    id: 'sr-eq-soft',
    service_record_id: 'sr-eq-soft',
    booking_id: BOOKING_ID,
    service_type: 'addon_service',
    service_date: '2026-08-03',
    quantity: 2,
    amount_due_cents: 3000,
    amount_paid_cents: 0,
    payment_status: 'pending',
    record_source: 'staff_manual',
    metadata: {
      source: 'staff_manual_schedule',
      staff_manual_schedule: true,
      course_equipment: true,
      offering_key: 'softboard',
      label: 'Softboard',
      course_equipment_mode: 'all_day',
      component: 'course_equipment',
      unit_amount_cents: 1500,
      base_unit_cents: 500,
      all_day_surcharge_unit_cents: 1000,
      amount_cents: 3000,
      pricing_provenance: 'course_owned_equipment',
      price_source: 'course_owned_equipment',
      price_basis: 'per_person_per_course',
      location_id: LOC,
      course_id: PACK_ID,
    },
  };
  const equipCarbon = {
    id: 'sr-eq-carbon',
    service_record_id: 'sr-eq-carbon',
    booking_id: BOOKING_ID,
    service_type: 'addon_service',
    service_date: '2026-08-03',
    quantity: 1,
    amount_due_cents: 200,
    amount_paid_cents: 0,
    payment_status: 'pending',
    record_source: 'staff_manual',
    metadata: {
      source: 'staff_manual_schedule',
      staff_manual_schedule: true,
      course_equipment: true,
      offering_key: 'carbon_fins',
      label: 'Carbon Fins',
      course_equipment_mode: 'during_course',
      component: 'course_equipment',
      unit_amount_cents: 200,
      base_unit_cents: 200,
      all_day_surcharge_unit_cents: 0,
      amount_cents: 200,
      pricing_provenance: 'course_owned_equipment',
      price_source: 'course_owned_equipment',
      price_basis: 'per_person_per_course',
      location_id: LOC,
      course_id: PACK_ID,
    },
  };
  return {
    bookings: [{
      booking_id: BOOKING_ID,
      booking_code: 'SUNSET-EDIT-EQ-1',
      guest_name: 'Edit Guest',
      phone: '+34600111222',
      status: 'payment_pending',
      payment_status: 'waiting_payment',
      check_in: '2026-08-03',
      check_out: '2026-08-05',
      guest_count: 3,
      total_amount_cents: 15200,
      amount_paid_cents: 0,
      balance_due_cents: 15200,
      metadata: {
        source: 'staff_manual_schedule',
        staff_manual_schedule: true,
        location_id: LOC,
        bundle_id: 'bundle-edit-eq',
        components: ['course'],
        custom_line_items: [{ client_line_id: 'cust-1', label: 'Discount', amount_cents: -500 }],
      },
    }],
    services: [
      {
        id: 'sr-course-1',
        service_record_id: 'sr-course-1',
        booking_id: BOOKING_ID,
        service_type: 'surf_lesson',
        service_date: '2026-08-03',
        quantity: 3,
        amount_due_cents: 12000,
        amount_paid_cents: 0,
        payment_status: 'pending',
        record_source: 'staff_manual',
        metadata: {
          source: 'staff_manual_schedule',
          staff_manual_schedule: true,
          component: 'course',
          staff_ui_service_type: 'course',
          course_id: PACK_ID,
          course_label: 'Verifier Group',
          tier_key: TIER,
          offering_id: GROUP_ITEM,
          location_id: LOC,
        },
      },
      {
        id: 'sr-course-2',
        service_record_id: 'sr-course-2',
        booking_id: BOOKING_ID,
        service_type: 'surf_lesson',
        service_date: '2026-08-04',
        quantity: 3,
        amount_due_cents: 0,
        amount_paid_cents: 0,
        payment_status: 'pending',
        record_source: 'staff_manual',
        metadata: {
          source: 'staff_manual_schedule',
          staff_manual_schedule: true,
          component: 'course',
          staff_ui_service_type: 'course',
          course_id: PACK_ID,
          course_label: 'Verifier Group',
          tier_key: TIER,
          offering_id: GROUP_ITEM,
          location_id: LOC,
        },
      },
      equipSoft,
      equipCarbon,
      {
        id: 'sr-custom-1',
        service_record_id: 'sr-custom-1',
        booking_id: BOOKING_ID,
        service_type: 'addon_service',
        service_date: '2026-08-03',
        quantity: 1,
        amount_due_cents: 0,
        amount_paid_cents: 0,
        payment_status: 'pending',
        record_source: 'staff_manual',
        metadata: {
          source: 'staff_custom_line',
          staff_custom_line: true,
          staff_manual_schedule: true,
          component: 'staff_custom_line',
          client_line_id: 'cust-1',
          label: 'Discount',
          amount_cents: -500,
          location_id: LOC,
        },
      },
      {
        id: 'sr-import-preserve',
        service_record_id: 'sr-import-preserve',
        booking_id: BOOKING_ID,
        service_type: 'addon_service',
        service_date: '2026-08-03',
        quantity: 1,
        amount_due_cents: 999,
        amount_paid_cents: 0,
        payment_status: 'pending',
        record_source: 'import',
        metadata: {
          source: 'import',
          component: 'import_note',
          label: 'Imported note',
          location_id: LOC,
          immutable_marker: 'must-survive-edit',
        },
      },
    ],
    // Unpaid payment row — proves Edit does not DELETE the payments table.
    // (A paid ledger would block reprice via paid_booking_reprice_required.)
    payments: [{
      payment_id: 'pay-seed-1',
      id: 'pay-seed-1',
      status: 'pending',
      payment_status: 'pending',
      amount_due_cents: 15200,
      amount_paid_cents: 0,
      checkout_url: 'https://example.test/checkout/seed',
      client_id: CLIENT_ID,
      booking_id: BOOKING_ID,
    }],
  };
}

(async () => {
  const { writes, drawer, formatServiceRecordInvoiceLineText } = loadModules();
  assert.strictEqual(typeof writes.createSunsetScheduleBooking, 'function');
  assert.strictEqual(typeof drawer.updateSunsetScheduleBooking, 'function');
  assert.strictEqual(typeof drawer.getSunsetScheduleBookingDrawerContext, 'function');
  assert.strictEqual(typeof drawer.aggregateComponentsFromServices, 'function');

  // ═══════════════════════════════════════════════════════════════════════════
  // 1) REAL Create — Group two-item mixed equipment
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const pg = makeTxnPg();
    const body = groupCreateBody(selectionMixed());
    const result = await writes.createSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      locationId: LOC,
      actor: { email: 'staff@sunset.test' },
      body,
      now: FIXED_NOW,
    });
    assert(result.ok === true, `group create failed: ${JSON.stringify(result.body || result)}`);
    assert.strictEqual(result.status, 201);
    assert.strictEqual(pg.state.commits, 1, 'create must COMMIT once');
    assert.strictEqual(pg.state.rollbacks, 0, 'successful create must not ROLLBACK');
    assert.strictEqual(pg.state.bookings.length, 1, 'one durable booking');

    const equip = equipmentRowsOf(pg.state.services);
    assert.strictEqual(equip.length, 2, 'two independent equipment rows');
    // softboard all_day qty2: 2×(500+1000)=3000; carbon during qty1: 200
    assertEquipmentRow(equip.find((r) => parseMeta(r.metadata).offering_key === 'softboard'), {
      offering_key: 'softboard', mode: 'all_day', quantity: 2,
      base: 500, surcharge: 1000, unit: 1500, total: 3000, label: 'Softboard',
    });
    assertEquipmentRow(equip.find((r) => parseMeta(r.metadata).offering_key === 'carbon_fins'), {
      offering_key: 'carbon_fins', mode: 'during_course', quantity: 1,
      base: 200, surcharge: 0, unit: 200, total: 200, label: 'Carbon Fins',
    });
    // Multi-day course billed once for equipment (not 2 days × 2 items)
    assert.strictEqual(new Set(equip.map((r) => String(r.service_date).slice(0, 10))).size, 1);
    assert.strictEqual(String(equip[0].service_date).slice(0, 10), '2026-08-03');

    const courseRows = pg.state.services.filter((s) => parseMeta(s.metadata).component === 'course');
    assert(courseRows.length >= 1, 'course component rows present');
    // Group 3 × 4000 = 12000 + equip 3200 = 15200
    assert.strictEqual(Number(pg.state.bookings[0].total_amount_cents), 15200, 'booking total includes equipment');
    assert.strictEqual(Number(result.body.total_cents), 15200);

    // Invoice reads persisted money
    const inv = equip.map((r) => formatServiceRecordInvoiceLineText(r));
    assert(inv.some((t) => /Softboard/i.test(t) && /All Day/i.test(t) && /€30\.00/.test(t)));
    assert(inv.some((t) => /Carbon Fins/i.test(t) && /During Course/i.test(t)));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2) REAL Create — Private two-item mixed equipment
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const pg = makeTxnPg();
    const result = await writes.createSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      locationId: LOC,
      actor: { email: 'staff@sunset.test' },
      body: privateCreateBody([
        { offering_key: 'softboard', mode: 'during_course', quantity: 2 },
        { offering_key: 'carbon_fins', mode: 'all_day', quantity: 1 },
      ]),
      now: FIXED_NOW,
    });
    assert(result.ok === true, `private create failed: ${JSON.stringify(result.body || result)}`);
    assert.strictEqual(pg.state.commits, 1);
    const equip = equipmentRowsOf(pg.state.services);
    assert.strictEqual(equip.length, 2);
    // softboard during 2×700=1400; carbon all_day 1×(250+50)=300
    assertEquipmentRow(equip.find((r) => parseMeta(r.metadata).offering_key === 'softboard'), {
      offering_key: 'softboard', mode: 'during_course', quantity: 2,
      base: 700, surcharge: 300, unit: 700, total: 1400, label: 'Softboard',
    });
    assertEquipmentRow(equip.find((r) => parseMeta(r.metadata).offering_key === 'carbon_fins'), {
      offering_key: 'carbon_fins', mode: 'all_day', quantity: 1,
      base: 250, surcharge: 50, unit: 300, total: 300, label: 'Carbon Fins',
    });
    const privateRows = pg.state.services.filter((s) => parseMeta(s.metadata).component === 'private_lesson');
    assert.strictEqual(privateRows.length, 1, 'private session row present');
    // private 3 surfers × 6000 = 18000 + 1700 equip = 19700
    assert.strictEqual(Number(pg.state.bookings[0].total_amount_cents), 19700);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3) REAL Edit — replace equipment; preserve unrelated import + payment
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const seed = seedEditBooking();
    const pg = makeTxnPg(seed);
    const beforePayments = deepClone(pg.state.payments);
    const importBefore = deepClone(pg.state.services.find((s) => s.id === 'sr-import-preserve'));

    const editBody = {
      guest_name: 'Edit Guest',
      guest_phone: '+34600111222',
      date_from: '2026-08-03',
      date_to: '2026-08-04',
      service_dates: ['2026-08-03', '2026-08-04'],
      payment_status: 'unpaid',
      components: {
        course: {
          quantity: 3,
          course_id: PACK_ID,
          course_label: 'Verifier Group',
          tier_key: TIER,
          offering_id: GROUP_ITEM,
        },
      },
      // Change softboard qty/mode, deselect carbon_fins, add same_label_a
      course_equipment: [
        { offering_key: 'softboard', mode: 'during_course', quantity: 1 },
        { offering_key: 'same_label_a', mode: 'all_day', quantity: 2 },
      ],
      custom_line_items: [{ client_line_id: 'cust-1', label: 'Discount', amount_cents: -500 }],
    };

    const result = await drawer.updateSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      locationId: LOC,
      actor: { email: 'staff@sunset.test' },
      body: editBody,
      now: FIXED_NOW,
    });
    assert(result.ok === true, `edit failed: ${JSON.stringify(result.body || result)}`);
    assert.strictEqual(pg.state.commits, 1, 'edit commits once');
    assert.strictEqual(pg.state.begins, 1, 'edit one transaction');
    assert.strictEqual(pg.state.rollbacks, 0);

    const equip = equipmentRowsOf(pg.state.services);
    assert.strictEqual(equip.length, 2, 'exactly replaced equipment set');
    assert(!equip.some((r) => parseMeta(r.metadata).offering_key === 'carbon_fins'), 'deselection removed carbon_fins');
    assertEquipmentRow(equip.find((r) => parseMeta(r.metadata).offering_key === 'softboard'), {
      offering_key: 'softboard', mode: 'during_course', quantity: 1,
      base: 500, surcharge: 1000, unit: 500, total: 500, label: 'Softboard',
    });
    assertEquipmentRow(equip.find((r) => parseMeta(r.metadata).offering_key === 'same_label_a'), {
      offering_key: 'same_label_a', mode: 'all_day', quantity: 2,
      base: 111, surcharge: 0, unit: 111, total: 222, label: 'Twin Label',
    });

    // Unrelated import row preserved (source not in DELETE list)
    const importAfter = pg.state.services.find((s) => s.id === 'sr-import-preserve');
    assert(importAfter, 'import row preserved');
    assert.deepStrictEqual(importAfter, importBefore, 'import row byte-stable');

    // Payment ledger preserved
    assert.deepStrictEqual(pg.state.payments, beforePayments, 'payments preserved');

    // Course still present after reprice rewrite
    assert(pg.state.services.some((s) => parseMeta(s.metadata).component === 'course'), 'course rows present');

    // Custom line still present (re-supplied in body)
    assert(pg.state.services.some((s) => parseMeta(s.metadata).client_line_id === 'cust-1'), 'custom line preserved via rewrite');

    // Canonical detail/readback from production aggregate + drawer context
    const agg = drawer.aggregateComponentsFromServices(pg.state.services);
    assert(Array.isArray(agg.components.course_equipment));
    const reopen = agg.components.course_equipment
      .map((x) => ({ offering_key: x.offering_key, mode: x.mode, quantity: x.quantity }))
      .sort((a, b) => a.offering_key.localeCompare(b.offering_key));
    assert.deepStrictEqual(reopen, [
      { offering_key: 'same_label_a', mode: 'all_day', quantity: 2 },
      { offering_key: 'softboard', mode: 'during_course', quantity: 1 },
    ]);

    if (result.body && result.body.context) {
      const ctxEq = result.body.context.course_equipment || [];
      const normalized = ctxEq
        .map((x) => ({ offering_key: x.offering_key, mode: x.mode, quantity: x.quantity }))
        .filter((x) => x.offering_key)
        .sort((a, b) => a.offering_key.localeCompare(b.offering_key));
      assert.deepStrictEqual(normalized, reopen, 'drawer context course_equipment canonical');
    }

    // 12000 course + 500 + 222 - 500 custom = 12222
    assert.strictEqual(Number(pg.state.bookings[0].total_amount_cents), 12222);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4) REAL Create — second equipment insert failure → ROLLBACK, zero durable
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const pg = makeTxnPg({ failAt: 'equipment_insert_2' });
    const pre = durableState(pg);
    let thrown = null;
    let result = null;
    try {
      result = await writes.createSunsetScheduleBooking(pg, {
        clientSlug: 'sunset',
        locationId: LOC,
        actor: { email: 'staff@sunset.test' },
        body: groupCreateBody(selectionMixed()),
        now: FIXED_NOW,
      });
    } catch (err) {
      thrown = err;
    }
    // Owner catches throw → ROLLBACK → rethrow (or sunsetPriceFail). Either way:
    assert(thrown || (result && result.ok === false), 'create must fail on second equipment insert');
    if (thrown) {
      assert(/simulated_second_equipment_insert_failure/.test(String(thrown.message || thrown)));
    }
    assert(pg.state.rollbacks >= 1, `ROLLBACK must run (got ${pg.state.rollbacks})`);
    assert.strictEqual(pg.state.commits, 0, 'failed create must not COMMIT');
    assert.deepStrictEqual(durableState(pg), pre, 'durable state byte-equal to pre-call after create rollback');
    assert.strictEqual(pg.state.bookings.length, 0, 'no booking after rollback');
    assert.strictEqual(pg.state.services.length, 0, 'no service rows after rollback');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5) REAL Edit — second equipment insert failure → ROLLBACK, pre-state intact
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const seed = seedEditBooking();
    const pg = makeTxnPg({ ...seed, failAt: 'equipment_insert_2' });
    const pre = durableState(pg);
    let thrown = null;
    let result = null;
    try {
      result = await drawer.updateSunsetScheduleBooking(pg, {
        clientSlug: 'sunset',
        bookingId: BOOKING_ID,
        locationId: LOC,
        actor: { email: 'staff@sunset.test' },
        body: {
          guest_name: 'Edit Guest',
          guest_phone: '+34600111222',
          date_from: '2026-08-03',
          date_to: '2026-08-04',
          service_dates: ['2026-08-03', '2026-08-04'],
          payment_status: 'unpaid',
          components: {
            course: {
              quantity: 3, course_id: PACK_ID, course_label: 'Verifier Group',
              tier_key: TIER, offering_id: GROUP_ITEM,
            },
          },
          course_equipment: [
            { offering_key: 'softboard', mode: 'during_course', quantity: 1 },
            { offering_key: 'same_label_a', mode: 'all_day', quantity: 2 },
          ],
          custom_line_items: [{ client_line_id: 'cust-1', label: 'Discount', amount_cents: -500 }],
        },
        now: FIXED_NOW,
      });
    } catch (err) {
      thrown = err;
    }
    assert(thrown || (result && result.ok === false), 'edit must fail on second equipment insert');
    if (thrown) {
      assert(/simulated_second_equipment_insert_failure/.test(String(thrown.message || thrown)));
    }
    assert(pg.state.rollbacks >= 1, 'edit ROLLBACK invoked');
    assert.strictEqual(pg.state.commits, 0, 'failed edit must not COMMIT');
    assert.deepStrictEqual(durableState(pg), pre, 'durable state byte-equal to pre-call after edit rollback');
    // Original equipment still present
    const equip = equipmentRowsOf(pg.state.services);
    assert.strictEqual(equip.length, 2);
    assert(equip.some((r) => parseMeta(r.metadata).offering_key === 'carbon_fins'));
    assert(equip.some((r) => parseMeta(r.metadata).offering_key === 'softboard'
      && parseMeta(r.metadata).course_equipment_mode === 'all_day'));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6) REAL Create — invalid second identity fails before mutation
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const pg = makeTxnPg();
    const pre = durableState(pg);
    const result = await writes.createSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      locationId: LOC,
      actor: { email: 'staff@sunset.test' },
      body: groupCreateBody([
        { offering_key: 'softboard', mode: 'all_day', quantity: 1 },
        { offering_key: 'not_configured', mode: 'during_course', quantity: 1 },
      ]),
      now: FIXED_NOW,
    });
    assert(result.ok === false, 'invalid identity must fail');
    // Validation may fail at quote (422) or insert throw→rollback. Either way no durable mutation.
    assert.strictEqual(pg.state.commits, 0, 'invalid create must not commit');
    assert.deepStrictEqual(durableState(pg), pre, 'invalid identity preserves empty durable state');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 7) Supplemental helper-level matrix (not a substitute for Create/Edit owners)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const { writes: w2, drawer: d2, formatServiceRecordInvoiceLineText: inv } = loadModules();

    // Validate wire form
    const valid = w2.validateScheduleBookingBody(groupCreateBody(selectionMixed()));
    assert(valid.ok, valid.error);
    assert.deepStrictEqual(valid.value.course_equipment, selectionMixed());
    assert(!w2.validateScheduleBookingBody(groupCreateBody({ mode: 'all_day', quantity: 1 })).ok, 'legacy singleton rejected');
    assert(!w2.validateScheduleBookingBody(groupCreateBody([
      { offering_key: 'softboard', mode: 'all_day', quantity: 1, amount_cents: 9 },
    ])).ok, 'client money rejected');
    assert(!w2.validateScheduleBookingBody({
      guest_name: 'x', guest_phone: '+34600111222', service_dates: ['2026-08-03'],
      payment_status: 'unpaid',
      components: { surfboard: { quantity: 1 } }, surfer_count: 1,
      course_equipment: selectionMixed(),
    }).ok, 'no-lesson cannot buy course coverage');

    // Direct insert helper still works with offerings (supplemental)
    const helperPg = makeTxnPg();
    // Bypass full create — call helper only for qty/surcharge/same-label matrix
    const rows = await w2.insertCourseEquipmentRows(helperPg, {
      clientSlug: 'sunset',
      bookingId: BOOKING_ID,
      bookingCode: 'SUN-H',
      guestName: 'Helper',
      selection: [
        { offering_key: 'same_label_a', mode: 'during_course', quantity: 1 },
        { offering_key: 'same_label_b', mode: 'during_course', quantity: 2 },
        { offering_key: 'zero_surcharge', mode: 'all_day', quantity: 4 },
        { offering_key: 'no_price_row', mode: 'during_course', quantity: 1 },
      ],
      surfers: 4,
      bookingDates: ['2026-08-03', '2026-08-04'],
      course: { course_id: PACK_ID, equipment_options: GROUP_OPTIONS },
      offerings: OFFERINGS,
      attribution: {
        metadataSource: 'staff_manual_schedule',
        staffManualSchedule: true,
        dbSource: 'staff_manual',
      },
      locationId: LOC,
      bundleId: 'b',
      srPayment: 'pending',
    });
    assert.strictEqual(rows.length, 4);
    assert.strictEqual(rows.find((r) => r.metadata.offering_key === 'same_label_a').amount_due_cents, 111);
    assert.strictEqual(rows.find((r) => r.metadata.offering_key === 'same_label_b').amount_due_cents, 444);
    assert.strictEqual(rows.find((r) => r.metadata.offering_key === 'zero_surcharge').amount_due_cents, 1600);
    assert.strictEqual(rows.find((r) => r.metadata.offering_key === 'zero_surcharge').metadata.all_day_surcharge_unit_cents, 0);
    assert.strictEqual(rows.filter((r) => r.metadata.label === 'Twin Label').length, 2);

    await assert.rejects(
      () => w2.insertCourseEquipmentRows(makeTxnPg(), {
        clientSlug: 'sunset', bookingId: BOOKING_ID, bookingCode: 'X', guestName: 'X',
        selection: [{ offering_key: 'foreign_location', mode: 'during_course', quantity: 1 }],
        surfers: 1, bookingDates: ['2026-08-03'],
        course: { equipment_options: [{ offering_key: 'foreign_location', equipment_price_cents: 1, all_day_surcharge_cents: 0 }] },
        offerings: OFFERINGS, attribution: { metadataSource: 's', staffManualSchedule: true, dbSource: 'staff_manual' },
        locationId: LOC, srPayment: 'pending',
      }),
      /active scoped|not an active|not configured|equipment/i,
    );

    // Historical singleton readback
    const historical = d2.aggregateComponentsFromServices([{
      service_type: 'surfboard', service_date: '2026-07-01', quantity: 2, amount_due_cents: 2400,
      metadata: {
        course_equipment: true, component: 'surfboard', course_equipment_mode: 'all_day',
        unit_amount_cents: 1200, label: 'Surfboard',
      },
    }]);
    assert(Array.isArray(historical.components.course_equipment));
    assert.strictEqual(historical.components.course_equipment[0].mode, 'all_day');
    assert.strictEqual(historical.components.course_equipment[0].quantity, 2);

    const legacyInvoice = inv({
      service_type: 'surfboard', service_date: '2026-08-01', quantity: 2, amount_due_cents: 2400,
      metadata: {
        course_equipment: true, component: 'surfboard', course_equipment_mode: 'all_day',
        unit_amount_cents: 1200,
      },
    });
    assert.match(legacyInvoice, /Surfboard — All Day/);

    // Standalone no-lesson still validates
    assert.strictEqual(w2.validateScheduleBookingBody({
      guest_name: 'No Lesson', guest_phone: '+34600111222',
      service_dates: ['2026-08-03'], payment_status: 'unpaid',
      components: { surfboard: { quantity: 1 } }, surfer_count: 1,
    }).ok, true);

    // No write callers on getCourseEquipmentPricing
    const writesSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-writes.js'), 'utf8');
    const drawerSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-drawer.js'), 'utf8');
    assert(!/getCourseEquipmentPricing\s*\(/.test(writesSrc), 'writes must not call getCourseEquipmentPricing');
    assert(!/getCourseEquipmentPricing\s*\(/.test(drawerSrc), 'drawer must not call getCourseEquipmentPricing');
  }

  console.log('verify:sunset-course-equipment-booking-production — ALL CHECKS PASSED');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
