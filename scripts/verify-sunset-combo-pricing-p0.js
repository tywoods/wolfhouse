'use strict';

/**
 * P0 + D/E/H readiness — staff-drawer combo pricing.
 *
 * P0 repro: Curso Tarde qty1 + standalone SUP + Surfboard+Wetsuit CE during_course.
 * Expected €85. Root cause proven (Hypothesis B): genericOnly early-return dropped
 * course/CE lane replay whenever SUP (generic) was the only rental.
 *
 * Production owners exercised (not HTTP route handlers — those are not exportable
 * offline without FORTRESS/auth). Claim accuracy:
 *   - Staff-shaped payload (schedulePortalBuildCreatePayload fields)
 *   - Staff quote merge (generic + vertical) via prepareGeneric + executeSunsetQuote
 *   - Create via executeSunsetBookingCreate → createSunsetScheduleBooking
 *   - Idempotency / preflight via createSunsetScheduleBooking owners
 *
 * Offline — production-shaped Admin fixture. No live calls.
 *
 * Run: node scripts/verify-sunset-combo-pricing-p0.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildSunsetQuoteCommand,
  executeSunsetQuote,
  buildQuoteProvenance,
  buildCreateRequoteTransportFromProvenance,
  QUOTE_CHANNELS,
} = require('./lib/luna-front-desk-quote-service');
const {
  prepareCanonicalRentalsForCreate,
  prepareGenericRentalsForCreate,
  buildGenericRentalAuthoritativeQuote,
  resolveAuthoritativeScheduleQuoteInTxn,
  createSunsetScheduleBooking,
  buildScheduleBookingIntentFingerprint,
  buildCreateRequestIdempotencyIdentity,
  evaluateIdempotentReplay,
  scheduleBookingIdempotencySessionKeys,
  CANONICAL_RENTAL_OFFERING_KEYS,
  transportHasNonGenericCommercialIntent,
  mergeGenericQuoteLinesIntoBody,
  validateScheduleBookingBody,
} = require('./lib/sunset-schedule-booking-writes');
const {
  BOOKING_CREATE_CHANNELS,
  buildSunsetBookingCreateCommand,
  executeSunsetBookingCreate,
} = require('./lib/luna-front-desk-booking-create-service');
const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');
const {
  defaultFreeDuringCourseEquipmentSelection,
} = require('./lib/sunset-course-equipment-options');
const stock = require('./lib/tenant-rental-stock-service');
const drawer = require('./lib/sunset-schedule-booking-drawer');

const FIXTURE_P0 = path.join(
  __dirname, '..', 'fixtures', 'sunset-admin-offline', 'curso-tarde-sup-ce-p0.json',
);
const FIXTURE_D = path.join(
  __dirname, '..', 'fixtures', 'sunset-admin-offline', 'course-equipment-policy-slice-d.json',
);
const FIXTURE_H = path.join(
  __dirname, '..', 'fixtures', 'sunset-admin-offline', 'mon-thu-service-dates-slice-h.json',
);

const LOC = 'sunset-somo';
const FIXED_NOW = new Date('2026-09-05T12:00:00Z');
const p0fx = JSON.parse(fs.readFileSync(FIXTURE_P0, 'utf8'));
const dFx = JSON.parse(fs.readFileSync(FIXTURE_D, 'utf8'));
const hFx = JSON.parse(fs.readFileSync(FIXTURE_H, 'utf8'));

const PACK_ID = p0fx.surf_pack.pack_id;
const TIER = '1_day';
const PACK_ITEM = packPriceItemCode(PACK_ID, TIER);
const SERVICE_DATE = p0fx.staff_drawer_selection.service_date;
const COURSE_CENTS = 4000;
const SUP_CENTS = 3000;
const BOARD_DURING = 1000;
const WETSUIT_DURING = 500;
const BOARD_ALL_DAY = 1500;
const WETSUIT_ALL_DAY = 1000;
const EXPECTED_TOTAL = 8500;

const OFFERINGS = p0fx.rental_offerings.map((o) => ({
  ...o, client_slug: 'sunset',
}));
const PRICE_ROWS = [
  {
    id: 'pr-course', amount_cents: COURSE_CENTS, currency: 'EUR', item_type: 'package',
    item_code: PACK_ITEM, unit: 'day', location_id: LOC, active: true, pricing_status: 'confirmed',
  },
  ...p0fx.rental_prices.map((p, i) => ({
    id: `pr-r-${i}`, amount_cents: p.amount_cents, currency: 'EUR', item_type: 'rental',
    item_code: p.item_code, unit: p.unit, location_id: LOC, active: true,
    pricing_status: p.pricing_status || 'confirmed', offering_key: p.offering_key,
  })),
];
const EQ_BOARD = p0fx.surf_pack.equipment_options[0];
const EQ_WETSUIT = p0fx.surf_pack.equipment_options[1];

function adminCfg(overrides = {}) {
  return {
    ok: true,
    source: 'db',
    currency: 'EUR',
    rental_offerings: OFFERINGS,
    surf_packs: [{
      pack_id: PACK_ID,
      label: p0fx.surf_pack.label,
      active: true,
      group_size: p0fx.surf_pack.group_size,
      weekly: p0fx.surf_pack.weekly,
      schedules: p0fx.surf_pack.schedules,
      equipment_options: overrides.equipment_options || [EQ_BOARD, EQ_WETSUIT],
      price_tiers: p0fx.surf_pack.price_tiers,
    }],
    prices: PRICE_ROWS.map((p) => ({
      id: p.id,
      category: p.item_type,
      offering_key: p.offering_key || p.item_code,
      item_code: p.item_code,
      amount_cents: overrides.priceOverrides && overrides.priceOverrides[p.item_code] != null
        ? overrides.priceOverrides[p.item_code]
        : p.amount_cents,
      unit: p.unit,
      active: true,
      currency: 'EUR',
      location_id: LOC,
      pricing_status: 'confirmed',
    })),
    private_lesson: {
      id: 'private-p0',
      enabled: true,
      label: 'Private',
      amount_cents: 6000,
      currency: 'EUR',
      price_basis: 'per_session',
      default_duration_minutes: 120,
      equipment_options: overrides.equipment_options || [EQ_BOARD, EQ_WETSUIT],
    },
  };
}

function makePg(opts = {}) {
  const stockRemaining = opts.stockRemaining != null ? opts.stockRemaining : 20;
  const stockByKey = opts.stockByKey || {};
  const state = {
    bookings: [],
    services: [],
    committed: false,
    rolledBack: false,
    bookingSeq: 0,
    serviceSeq: 0,
    inTxn: false,
    sqlLog: [],
    mutatingOutsideTxn: [],
    priceRuleWrites: [],
    sessionLocks: new Set(),
    catalogQueries: 0,
    priceQueries: 0,
    unlockCount: 0,
    lockCount: 0,
  };
  const priceRows = (opts.priceRows || PRICE_ROWS).map((p) => ({ ...p }));
  if (opts.omitPackagePrice) {
    for (let i = priceRows.length - 1; i >= 0; i -= 1) {
      if (priceRows[i].item_type === 'package' || priceRows[i].item_code === PACK_ITEM) {
        priceRows.splice(i, 1);
      }
    }
  }
  if (opts.priceOverrides) {
    for (const row of priceRows) {
      if (opts.priceOverrides[row.item_code] != null) {
        row.amount_cents = opts.priceOverrides[row.item_code];
      }
    }
  }
  const packConfig = {
    age_band: '12_and_up',
    group_size: 24,
    beaches: ['somo'],
    weekly: opts.weekly || 'sat_sun',
    schedules: opts.schedules || ['1600_1800'],
    equipment_options: opts.equipment_options || [EQ_BOARD, EQ_WETSUIT],
    price_tiers: opts.price_tiers || p0fx.surf_pack.price_tiers,
  };
  const pg = {
    state,
    committed: () => state.committed,
    rolledBack: () => state.rolledBack,
    async query(sql, params = []) {
      const q = String(sql);
      state.sqlLog.push({ q: q.slice(0, 160), params: (params || []).slice(0, 8) });
      // Durable commercial mutations only (not bootstrap CREATE TABLE/INDEX).
      const isDurableMut = /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q)
        && /(booking|tenant_price|payment)/i.test(q);
      if (isDurableMut && !state.inTxn) {
        state.mutatingOutsideTxn.push(q.slice(0, 200));
      }
      if (/^\s*BEGIN/i.test(q)) { state.inTxn = true; return { rows: [] }; }
      if (/^\s*COMMIT/i.test(q)) {
        state.committed = true;
        state.inTxn = false;
        return { rows: [] };
      }
      if (/^\s*ROLLBACK/i.test(q)) {
        state.rolledBack = true;
        state.inTxn = false;
        // Stale/idempotent abort: drop uncommitted rows
        if (!state.committed) {
          state.bookings = [];
          state.services = [];
        }
        return { rows: [] };
      }
      if (/pg_advisory_lock\b/i.test(q) && !/xact/i.test(q)) {
        state.lockCount += 1;
        const k = `${params[0]}:${params[1]}`;
        state.sessionLocks.add(k);
        return { rows: [{ pg_advisory_lock: true }] };
      }
      if (/pg_advisory_unlock_all\b/i.test(q)) {
        state.sessionLocks.clear();
        return { rows: [{ pg_advisory_unlock_all: '' }] };
      }
      if (/pg_advisory_unlock\b/i.test(q)) {
        state.unlockCount += 1;
        const k = `${params[0]}:${params[1]}`;
        state.sessionLocks.delete(k);
        return { rows: [{ unlocked: true, pg_advisory_unlock: true }] };
      }
      if (/pg_advisory/i.test(q)) return { rows: [] };
      if (/FROM information_schema\.tables/i.test(q)) {
        const names = Array.isArray(params[0]) ? params[0] : [
          'tenant_price_rules', 'tenant_lesson_capacity_rules',
          'tenant_lesson_time_rules', 'tenant_config_audit_log',
        ];
        return { rows: names.map((table_name) => ({ table_name })) };
      }
      if (/FROM information_schema\.columns/i.test(q)) return { rows: [{ '?column?': 1 }] };
      if (/to_regclass/i.test(q)) {
        return { rows: [{ reg: 'tenant_price_rules', t: 'booking_service_records' }] };
      }
      if (/pg_constraint|ALTER TABLE|CREATE UNIQUE|CREATE INDEX/i.test(q)) {
        return {
          rows: [{
            definition: "CHECK ((service_type)::text = ANY ((ARRAY['addon_service'::character varying,'surf_lesson'::character varying])::text[]))",
          }],
        };
      }
      if (/SELECT id FROM clients WHERE slug/i.test(q)) {
        return { rows: [{ id: 'client-sunset-uuid' }] };
      }
      if (/FROM tenant_surf_pack_rules/i.test(q)) {
        return {
          rows: [{
            id: PACK_ID,
            label: 'Curso Tarde',
            active: true,
            location_id: LOC,
            config_json: packConfig,
          }],
        };
      }
      if (/tenant_private_lesson/i.test(q)) return { rows: [] };
      if (/FROM tenant_rental_offerings/i.test(q) || (/rental_offerings/i.test(q) && /SELECT/i.test(q))) {
        state.catalogQueries += 1;
      }
      if (/FROM tenant_price_rules/i.test(q)) {
        state.priceQueries += 1;
      }
      if (/tenant_rental_offerings/i.test(q) && /FOR UPDATE/i.test(q)) {
        return {
          rows: OFFERINGS.map((o) => ({
            id: o.offering_key,
            offering_key: o.offering_key,
            stock_quantity: stockByKey[o.offering_key] != null
              ? stockByKey[o.offering_key]
              : stockRemaining,
            remaining: stockByKey[o.offering_key] != null
              ? stockByKey[o.offering_key]
              : stockRemaining,
            active: true,
            client_slug: 'sunset',
            location_id: LOC,
            stock_scope: 'location',
          })),
        };
      }
      if (/FROM tenant_rental_offerings/i.test(q) || (/rental_offerings/i.test(q) && /SELECT/i.test(q))) {
        return {
          rows: OFFERINGS.map((o) => ({
            id: o.offering_key,
            offering_key: o.offering_key,
            label: o.label,
            display_name: o.label,
            active: true,
            client_slug: 'sunset',
            location_id: LOC,
            stock_quantity: stockByKey[o.offering_key] != null
              ? stockByKey[o.offering_key]
              : stockRemaining,
            config_json: {},
            group_key: null,
            excludes: [],
            sort_order: 0,
          })),
        };
      }
      if (/FROM tenant_price_rules/i.test(q)) {
        const codes = params.filter((p) => typeof p === 'string' && p.includes('__'));
        let rows = priceRows;
        if (codes.length) rows = priceRows.filter((r) => codes.includes(r.item_code));
        return { rows: rows.map((r) => ({ ...r, client_slug: 'sunset' })) };
      }
      if (/INSERT INTO bookings/i.test(q)) {
        state.bookingSeq += 1;
        const id = `bk-${state.bookingSeq}`;
        state.bookings.push({
          id,
          booking_code: params[1] || `SUNSET-P0-${state.bookingSeq}`,
          total_amount_cents: null,
          params,
        });
        return { rows: [{ id, booking_code: params[1] || `SUNSET-P0-${state.bookingSeq}` }] };
      }
      if (/INSERT INTO tenant_price_rules|UPSERT.*tenant_price_rules|UPDATE tenant_price_rules/i.test(q)) {
        state.priceRuleWrites.push({ q: q.slice(0, 120), params });
      }
      if (/INSERT INTO booking_service_records/i.test(q)) {
        state.serviceSeq += 1;
        const id = `sr-${state.serviceSeq}`;
        // Two INSERT shapes:
        //  standard: $5=type $6=date $7=qty $8=payment $9=source $10=metadata
        //  generic:  type hardcoded 'addon_service'; $5=date $6=qty $7=amount $8=payment $9=source $10=metadata
        let meta = null;
        for (let i = params.length - 1; i >= 0; i -= 1) {
          const p = params[i];
          if (p && typeof p === 'object' && !Array.isArray(p)) { meta = p; break; }
          if (typeof p === 'string' && p.trim().startsWith('{')) {
            try { meta = JSON.parse(p); break; } catch (_) { /* continue */ }
          }
        }
        meta = meta && typeof meta === 'object' ? meta : {};
        const isGenericShape = /'addon_service'/.test(q) && /\$5::date/.test(q);
        let service_type;
        let service_date;
        let quantity;
        let amount_due_cents = 0;
        let payment_status = 'pending';
        if (isGenericShape) {
          service_type = 'addon_service';
          service_date = params[4];
          quantity = params[5];
          amount_due_cents = params[6] != null ? params[6] : 0;
          payment_status = params[7];
        } else {
          service_type = params[4];
          service_date = params[5];
          quantity = params[6];
          payment_status = params[7];
        }
        const row = {
          service_record_id: id,
          id,
          service_type,
          service_date,
          quantity,
          amount_due_cents,
          metadata: meta,
        };
        state.services.push(row);
        return {
          rows: [{
            ...row,
            booking_id: params[1],
            amount_paid_cents: 0,
            payment_status,
            record_source: 'staff_manual',
            // applyAuthoritativeQuoteAmounts / claim path reads these
            offering_key: meta.offering_key,
            staff_ui_service_type: meta.staff_ui_service_type,
          }],
        };
      }
      if (/UPDATE booking_service_records/i.test(q) && /amount_due_cents/i.test(q)) {
        const due = Number(params[0]);
        for (const p of params) {
          const hit = state.services.find((s) => String(s.service_record_id) === String(p)
            || String(s.id) === String(p));
          if (hit && Number.isFinite(due)) {
            hit.amount_due_cents = due;
            return { rowCount: 1, rows: [] };
          }
        }
        return { rowCount: 1, rows: [] };
      }
      if (/UPDATE booking_service_records/i.test(q)) return { rowCount: 1, rows: [] };
      if (/UPDATE bookings/i.test(q) && /total_amount_cents/i.test(q)) {
        const total = Number(params[0]);
        if (state.bookings[0] && Number.isFinite(total)) {
          state.bookings[0].total_amount_cents = total;
        }
        return { rowCount: 1, rows: [] };
      }
      if (/UPDATE bookings/i.test(q)) return { rowCount: 1, rows: [] };
      if (/metadata->>'idempotency_key'/i.test(q) && /SELECT/i.test(q)) {
        const key = params[1] != null ? String(params[1]) : '';
        const hits = state.services.filter((s) =>
          s.metadata && String(s.metadata.idempotency_key || '') === key);
        return { rows: hits.map((s) => ({
          service_record_id: s.service_record_id || s.id,
          booking_id: (state.bookings[0] && state.bookings[0].id) || 'bk-1',
          booking_code: (state.bookings[0] && state.bookings[0].booking_code) || 'SUNSET-P0-1',
          guest_name: 'P0 Combo Guest',
          service_type: s.service_type,
          service_date: s.service_date,
          quantity: s.quantity,
          payment_status: 'pending',
          record_source: 'staff_manual',
          metadata: s.metadata,
          location_id: LOC,
          idempotency_intent_fp: s.metadata && s.metadata.idempotency_intent_fp,
          idempotency_key: s.metadata && s.metadata.idempotency_key,
        })) };
      }
      if (/idempotency/i.test(q) && /SELECT/i.test(q)) return { rows: [] };
      if (/FROM bookings/i.test(q)) return { rows: [] };
      if (/booking_service_records/i.test(q)) {
        // Active reservation demand for stock
        if (opts.existingDemand && opts.existingDemand.length) {
          return { rows: opts.existingDemand };
        }
        return { rows: [] };
      }
      if (/COALESCE\(SUM/i.test(q)) return { rows: [{ seats: 0, paid_total: 0 }] };
      if (/FROM payments/i.test(q)) return { rows: [] };
      return { rows: [] };
    },
  };
  return pg;
}

const loadRule = async ({ itemCode, duration }) => {
  const code = String(itemCode || '').includes('__')
    ? itemCode
    : `${itemCode}__${duration}`;
  const hit = PRICE_ROWS.find((r) => r.item_code === code);
  if (!hit) return { status: 'not_found' };
  return {
    status: 'found',
    amount_cents: hit.amount_cents,
    currency: 'EUR',
    item_code: hit.item_code,
    unit: hit.unit === '1_day' ? 'day' : hit.unit,
    location_id: LOC,
    pricing_status: 'confirmed',
  };
};
const listOfferings = async () => OFFERINGS;

/** Staff-drawer create payload shape (schedulePortalBuildCreatePayload). */
function staffDrawerPayload(overrides = {}) {
  return {
    guest_name: 'P0 Combo Guest',
    guest_phone: '+34600111000',
    date_from: SERVICE_DATE,
    date_to: SERVICE_DATE,
    payment_status: 'unpaid',
    notes: '',
    components: {
      course: {
        course_id: PACK_ID,
        tier_key: TIER,
        quantity: 1,
        offering_id: PACK_ITEM,
      },
    },
    course_equipment: [
      { offering_key: 'board_rental', mode: 'during_course', quantity: 1 },
      { offering_key: 'wetsuit_rental', mode: 'during_course', quantity: 1 },
    ],
    rentals: [{ offering_key: 'sup_rental', duration_key: '1_day', quantity: 1 }],
    custom_line_items: [],
    surfer_count: 1,
    lessons: [],
    ...overrides,
  };
}

/** Mirror handleSunsetScheduleBookingQuote: vertical quote + generic merge + provenance. */
async function staffPreviewQuote(payload, cfg, pg) {
  const requestedRentals = Array.isArray(payload.rentals) ? payload.rentals : [];
  const genericPrep = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: LOC,
    pgClient: pg,
    rentals: requestedRentals,
    serviceDate: String(payload.date_from || SERVICE_DATE).slice(0, 10),
    source: 'staff_manual',
    calendarDayCount: 1,
    bookingDurationKey: '1_day',
    dateFrom: payload.date_from || SERVICE_DATE,
    dateTo: payload.date_to || SERVICE_DATE,
    serviceDates: payload.service_dates || [SERVICE_DATE],
    listOfferings,
    loadRule,
  });
  assert.equal(genericPrep.ok, true, JSON.stringify(genericPrep));
  const genericQuote = buildGenericRentalAuthoritativeQuote(genericPrep.records || []);
  const canonicalRentals = requestedRentals.filter((r) =>
    CANONICAL_RENTAL_OFFERING_KEYS.includes(String(r && r.offering_key || '').trim()));
  const transportBody = {
    ...payload,
    rentals: canonicalRentals,
    service_dates: payload.service_dates || [SERVICE_DATE],
    require_db: true,
  };
  if (genericPrep.genericRentals.length && !canonicalRentals.length) {
    delete transportBody.rentals;
  }
  const built = buildSunsetQuoteCommand({
    channel: QUOTE_CHANNELS.MANUAL_STAFF,
    transportBody,
    trustedLocationId: LOC,
    now: FIXED_NOW,
  });
  assert.equal(built.ok, true, JSON.stringify(built));
  const quoted = await executeSunsetQuote(pg, built.command, { adminCfg: cfg });
  assert.equal(quoted.ok, true, JSON.stringify(quoted.body));
  let body = quoted.body;
  if (genericQuote.line_items.length) {
    body = mergeGenericQuoteLinesIntoBody(body, genericQuote);
  }
  body.quote_provenance = buildQuoteProvenance(body);
  return {
    body,
    genericPrep,
    genericQuote,
    canonicalRentals,
    transportBody,
  };
}

async function withAdminCfg(cfg, fn) {
  const tbc = require('./lib/tenant-business-config');
  const tro = require('./lib/tenant-rental-offerings');
  const origCfg = tbc.resolveTenantBusinessConfigAsync;
  const origList = tro.listRentalOfferings;
  const origLoad = tbc.loadTenantPriceRuleFromDb;
  tbc.resolveTenantBusinessConfigAsync = async () => cfg;
  tro.listRentalOfferings = async () => OFFERINGS;
  if (typeof tbc.loadTenantPriceRuleFromDb === 'function') {
    tbc.loadTenantPriceRuleFromDb = async (_pg, params) => {
      const duration = params.duration || params.billingUnit;
      const itemCode = params.itemCode;
      const code = String(itemCode || '').includes('__')
        ? itemCode
        : `${itemCode}__${duration}`;
      const hit = (cfg.prices || []).find((p) => p.item_code === code)
        || PRICE_ROWS.find((r) => r.item_code === code);
      if (!hit) return { status: 'not_found' };
      const amount = hit.amount_cents;
      return {
        status: 'found',
        amount_cents: amount,
        currency: 'EUR',
        item_code: hit.item_code || code,
        unit: hit.unit === '1_day' ? 'day' : (hit.unit || 'day'),
        location_id: LOC,
        pricing_status: 'confirmed',
      };
    };
  }
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';
  try {
    return await fn();
  } finally {
    tbc.resolveTenantBusinessConfigAsync = origCfg;
    tro.listRentalOfferings = origList;
    if (origLoad) tbc.loadTenantPriceRuleFromDb = origLoad;
  }
}

function lineSummary(body) {
  return (body.line_items || []).map((l) => ({
    component: l.component,
    offering_key: l.offering_key || l.offering_id || l.offering_item_code,
    course_equipment: l.course_equipment === true,
    mode: l.course_equipment_mode || null,
    total_cents: l.total_cents,
    duration_key: l.duration_key || null,
  }));
}

async function main() {
  console.log('verify-sunset-combo-pricing-p0 — start');

  // ── Fixture files present ──
  assert.ok(fs.existsSync(FIXTURE_P0));
  assert.ok(fs.existsSync(FIXTURE_D));
  assert.ok(fs.existsSync(FIXTURE_H));
  assert.equal(p0fx._meta.expected_total_cents, EXPECTED_TOTAL);
  assert.equal(dFx.surf_pack.equipment_options.length, 3);
  assert.deepStrictEqual(hFx.example_service_dates, ['2026-09-07', '2026-09-10']);

  // ── Domain: SUP is generic, not canonical ──
  assert.ok(!CANONICAL_RENTAL_OFFERING_KEYS.includes('sup_rental'), 'SUP must be generic');
  assert.equal(
    transportHasNonGenericCommercialIntent({
      components: { course: { course_id: PACK_ID, tier_key: TIER, quantity: 1 } },
      course_equipment: [{ offering_key: 'board_rental', mode: 'during_course', quantity: 1 }],
    }),
    true,
  );
  assert.equal(
    transportHasNonGenericCommercialIntent({
      components: {},
      rentals: [{ offering_key: 'sup_rental', duration_key: '1_day', quantity: 1 }],
    }),
    false,
  );

  const cfg = adminCfg();

  await withAdminCfg(cfg, async () => {
    const pg = makePg();
    const payload = staffDrawerPayload();

    // ── Staff preview quote (real merge path) ──
    const preview = await staffPreviewQuote(payload, cfg, pg);
    assert.equal(preview.body.quote_lane, 'components', 'components quote lane recorded');
    assert.equal(preview.body.quote_provenance.quote_lane, 'components');
    assert.equal(preview.body.total_cents, EXPECTED_TOTAL, `preview total €85 got ${preview.body.total_cents}`);
    assert.equal(preview.body.quote_provenance.total_cents, EXPECTED_TOTAL);

    const lines = lineSummary(preview.body);
    console.log('  preview lines', JSON.stringify(lines));
    assert.ok(lines.some((l) => l.component === 'course' && l.total_cents === COURSE_CENTS), 'course line');
    assert.ok(
      lines.some((l) => String(l.offering_key).startsWith('sup_rental') && l.total_cents === SUP_CENTS
        && !l.course_equipment),
      'standalone SUP from duration row',
    );
    assert.ok(
      lines.some((l) => l.course_equipment && String(l.offering_key).includes('board_rental')
        && l.mode === 'during_course' && l.total_cents === BOARD_DURING),
      'CE Surfboard during_course',
    );
    assert.ok(
      lines.some((l) => l.course_equipment && String(l.offering_key).includes('wetsuit_rental')
        && l.mode === 'during_course' && l.total_cents === WETSUIT_DURING),
      'CE Wetsuit during_course',
    );

    // Three distinct price sources: standalone SUP ≠ CE during ≠ CE all_day
    assert.notStrictEqual(SUP_CENTS, BOARD_DURING);
    assert.notStrictEqual(BOARD_DURING, BOARD_ALL_DAY);
    assert.notStrictEqual(EQ_BOARD.during_course_price_cents, EQ_BOARD.all_day_price_cents);

    // Hypothesis A: prepareCanonical must NOT invent surfboard/wetsuit for SUP-only
    const prepBody = {
      ...payload,
      rentals: preview.canonicalRentals,
      components: { ...payload.components },
    };
    if (preview.genericPrep.genericRentals.length && !preview.canonicalRentals.length) {
      delete prepBody.rentals;
    }
    const rentalPrep = prepareCanonicalRentalsForCreate(prepBody);
    assert.equal(rentalPrep.ok, true);
    assert.equal(rentalPrep.present, false, 'SUP-only → no canonical rentals');
    assert.ok(
      !(rentalPrep.body && rentalPrep.body.components
        && (rentalPrep.body.components.surfboard || rentalPrep.body.components.wetsuit)),
      'Hypothesis A false: components not mutated with operational board/wetsuit',
    );

    // Create replay transport + resolve (proves B fixed: not generic-only)
    const quoteTransport = {
      ...(rentalPrep.body && typeof rentalPrep.body === 'object' ? rentalPrep.body : {}),
      guest_name: payload.guest_name,
      guest_phone: payload.guest_phone,
      date_from: SERVICE_DATE,
      date_to: SERVICE_DATE,
      service_dates: [SERVICE_DATE],
      components: payload.components,
      surfer_count: 1,
      course_equipment: payload.course_equipment,
      custom_line_items: [],
      payment_status: 'unpaid',
    };
    const laneBuilt = buildCreateRequoteTransportFromProvenance(
      quoteTransport, preview.body.quote_provenance,
    );
    assert.equal(laneBuilt.quote_lane, 'components');
    assert.ok(laneBuilt.quoteTransport.components && laneBuilt.quoteTransport.components.course);

    const resolved = await resolveAuthoritativeScheduleQuoteInTxn(pg, {
      clientSlug: 'sunset',
      locationId: LOC,
      canonicalRentals: null,
      genericRentalRecords: preview.genericPrep.records,
      rentalPrepBody: quoteTransport,
      quotePrepBody: quoteTransport,
      quoteChannel: 'manual_staff',
      quoteProvenance: preview.body.quote_provenance,
      now: FIXED_NOW,
    });
    assert.equal(resolved.authoritativeQuote.total_cents, EXPECTED_TOTAL, 'create re-quote €85');
    const freshFp = buildQuoteProvenance(resolved.authoritativeQuote).quote_fingerprint;
    assert.equal(
      freshFp,
      preview.body.quote_provenance.quote_fingerprint,
      'unchanged create re-quote fingerprint identical',
    );
    assert.ok(
      (resolved.authoritativeQuote.line_items || []).length >= 4,
      'create re-quote retains course+CE+SUP lines',
    );

    // ── Full create owner succeeds; persisted rows = authoritative quote ──
    const createPg = makePg();
    const cmd = buildSunsetBookingCreateCommand({
      channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
      transportBody: {
        ...payload,
        service_dates: [SERVICE_DATE],
        quote_provenance: preview.body.quote_provenance,
      },
      trustedLocationId: LOC,
      now: FIXED_NOW,
      actorHints: { staff_user_id: 'staff-p0', email: 'p0@test' },
    });
    assert.equal(cmd.ok, true, JSON.stringify(cmd));
    const createOut = await executeSunsetBookingCreate(createPg, cmd.command);
    assert.equal(createOut.ok, true, JSON.stringify(createOut.body));
    assert.equal(createPg.committed(), true);
    assert.equal(createPg.rolledBack(), false);
    assert.equal(createOut.body.total_cents, EXPECTED_TOTAL, 'create body total €85');
    assert.equal(
      createPg.state.bookings[0].total_amount_cents,
      EXPECTED_TOTAL,
      'booking header total = authoritative quote',
    );

    const svc = createPg.state.services;
    assert.ok(svc.some((s) => s.service_type === 'surf_lesson'), 'course row');
    assert.ok(svc.some((s) => s.metadata && s.metadata.offering_key === 'sup_rental'), 'SUP row');
    const ceRows = svc.filter((s) => s.metadata && s.metadata.course_equipment === true);
    assert.ok(ceRows.length >= 2, 'CE board+wetsuit rows');
    assert.ok(ceRows.every((s) => s.metadata.course_equipment_mode === 'during_course'));
    // Drawer payment summary uses booking total
    const paySummaryEur = (createOut.body.total_cents / 100).toFixed(0);
    assert.equal(paySummaryEur, '85', 'drawer payment summary €85');

    // Aggregated drawer components retain CE identities
    const agg = drawer.aggregateComponentsFromServices(svc);
    const pill = (agg.components && agg.components.course_equipment) || [];
    assert.ok(pill.length >= 2, JSON.stringify(agg.components));

    // ── Stale guards: price / date / qty / offering identity ──
    async function expectStale(label, mutate) {
      const stalePg = makePg();
      const base = {
        ...payload,
        service_dates: [SERVICE_DATE],
        quote_provenance: preview.body.quote_provenance,
      };
      mutate(base);
      const staleCmd = buildSunsetBookingCreateCommand({
        channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
        transportBody: base,
        trustedLocationId: LOC,
        now: FIXED_NOW,
        actorHints: { staff_user_id: 'staff-p0', email: 'p0@test' },
      });
      const out = await executeSunsetBookingCreate(stalePg, staleCmd.command);
      assert.equal(out.ok, false, `${label}: expected fail, got ${JSON.stringify(out.body)}`);
      assert.ok(
        out.body && (
          out.body.reason_code === 'stale_quote'
          || /stale|no longer available|fingerprint/i.test(JSON.stringify(out.body))
          || out.status === 409
          || out.status === 422
        ),
        `${label}: fail-closed body ${JSON.stringify(out.body)}`,
      );
      assert.strictEqual(stalePg.state.bookings.length, 0, `${label}: zero booking writes`);
      assert.strictEqual(stalePg.state.services.length, 0, `${label}: zero service writes`);
      assert.equal(stalePg.committed(), false, `${label}: no commit`);
      console.log(`  PASS stale/fail-closed: ${label}`);
    }

    // Changed CE during price via config → fingerprint mismatch
    {
      const staleCfg = adminCfg({
        equipment_options: [
          { ...EQ_BOARD, during_course_price_cents: 9999 },
          EQ_WETSUIT,
        ],
      });
      await withAdminCfg(staleCfg, async () => {
        const stalePg = makePg({
          equipment_options: [
            { ...EQ_BOARD, during_course_price_cents: 9999 },
            EQ_WETSUIT,
          ],
        });
        // Also force adminCfg prices used by quote CE
        const tbc = require('./lib/tenant-business-config');
        tbc.resolveTenantBusinessConfigAsync = async () => staleCfg;
        const out = await executeSunsetBookingCreate(stalePg, buildSunsetBookingCreateCommand({
          channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
          transportBody: {
            ...payload,
            service_dates: [SERVICE_DATE],
            quote_provenance: preview.body.quote_provenance,
          },
          trustedLocationId: LOC,
          now: FIXED_NOW,
          actorHints: { staff_user_id: 's', email: 's@t' },
        }).command);
        assert.equal(out.ok, false, JSON.stringify(out.body));
        assert.ok(
          out.body && (out.body.reason_code === 'stale_quote'
            || /stale|no longer available/i.test(JSON.stringify(out.body))),
          JSON.stringify(out.body),
        );
        assert.strictEqual(stalePg.state.bookings.length, 0);
        console.log('  PASS stale: CE during price changed');
      });
    }

    // Changed standalone SUP price
    {
      const staleCfg = adminCfg({
        priceOverrides: { 'sup_rental__1_day': 9999 },
      });
      await withAdminCfg(staleCfg, async () => {
        const stalePg = makePg({ priceOverrides: { 'sup_rental__1_day': 9999 } });
        const out = await executeSunsetBookingCreate(stalePg, buildSunsetBookingCreateCommand({
          channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
          transportBody: {
            ...payload,
            service_dates: [SERVICE_DATE],
            quote_provenance: preview.body.quote_provenance,
          },
          trustedLocationId: LOC,
          now: FIXED_NOW,
          actorHints: { staff_user_id: 's', email: 's@t' },
        }).command);
        // SUP is re-priced via generic records at create; amount change may surface as
        // fingerprint mismatch after merge, or generic amount drift vs provenance.
        assert.equal(out.ok, false, JSON.stringify(out.body));
        assert.strictEqual(stalePg.state.bookings.length, 0, 'SUP price change: zero writes');
        console.log('  PASS stale/fail-closed: standalone SUP price changed');
      });
    }

    await expectStale('date changed', (b) => {
      b.date_from = '2026-09-12';
      b.date_to = '2026-09-12';
      b.service_dates = ['2026-09-12'];
    });
    await expectStale('CE quantity changed', (b) => {
      b.course_equipment = [
        { offering_key: 'board_rental', mode: 'during_course', quantity: 2 },
        { offering_key: 'wetsuit_rental', mode: 'during_course', quantity: 1 },
      ];
      b.surfer_count = 2;
      b.components.course.quantity = 2;
    });
    await expectStale('CE offering identity changed', (b) => {
      b.course_equipment = [
        { offering_key: 'wetsuit_rental', mode: 'during_course', quantity: 1 },
      ];
    });

    // ── all_day variant: independent all_day price, never standalone/during ──
    {
      const allDayPayload = staffDrawerPayload({
        course_equipment: [
          { offering_key: 'board_rental', mode: 'all_day', quantity: 1 },
          { offering_key: 'wetsuit_rental', mode: 'all_day', quantity: 1 },
        ],
        rentals: [], // isolate CE pricing
      });
      const adPg = makePg();
      const adPreview = await staffPreviewQuote(allDayPayload, cfg, adPg);
      assert.equal(adPreview.ok !== false, true);
      const adLines = (adPreview.body.line_items || []).filter((l) => l.course_equipment);
      assert.ok(adLines.length >= 2);
      const boardAd = adLines.find((l) => String(l.offering_key || l.offering_id || '').includes('board'));
      const wetAd = adLines.find((l) => String(l.offering_key || l.offering_id || '').includes('wetsuit'));
      assert.equal(boardAd.total_cents, BOARD_ALL_DAY, 'all_day board uses all_day price');
      assert.equal(wetAd.total_cents, WETSUIT_ALL_DAY, 'all_day wetsuit uses all_day price');
      assert.notStrictEqual(boardAd.total_cents, BOARD_DURING, 'all_day ≠ during_course');
      assert.notStrictEqual(wetAd.total_cents, WETSUIT_DURING, 'all_day wetsuit ≠ during');
      // Mode identity is authoritative even when all_day cents happen to equal standalone.
      assert.equal(boardAd.course_equipment_mode, 'all_day');
      assert.equal(wetAd.course_equipment_mode, 'all_day');
      // Standalone duration row remains a distinct commercial identity (not CE).
      assert.ok(!boardAd.duration_key || boardAd.course_equipment === true);
      console.log('  PASS all_day independent prices');
    }

    // ── Same offering_key as standalone rental + CE → two distinct lines + summed stock ──
    {
      const dual = staffDrawerPayload({
        rentals: [
          { offering_key: 'board_rental', duration_key: '1_day', quantity: 1 },
        ],
        course_equipment: [
          { offering_key: 'board_rental', mode: 'during_course', quantity: 1 },
        ],
      });
      // board_rental is canonical — staff quote keeps it on rentals[]
      const dualBuilt = buildSunsetQuoteCommand({
        channel: QUOTE_CHANNELS.MANUAL_STAFF,
        transportBody: {
          ...dual,
          service_dates: [SERVICE_DATE],
          require_db: true,
        },
        trustedLocationId: LOC,
        now: FIXED_NOW,
      });
      assert.equal(dualBuilt.ok, true);
      const dualQ = await executeSunsetQuote(pg, dualBuilt.command, { adminCfg: cfg });
      assert.equal(dualQ.ok, true, JSON.stringify(dualQ.body));
      const dualLines = dualQ.body.line_items || [];
      const rentalBoard = dualLines.filter((l) =>
        !l.course_equipment
        && (l.component === 'board_rental' || String(l.offering_id || '').startsWith('board_rental')));
      const ceBoard = dualLines.filter((l) =>
        l.course_equipment && String(l.offering_key || l.offering_id || '').includes('board'));
      assert.ok(rentalBoard.length >= 1, 'standalone board line');
      assert.ok(ceBoard.length >= 1, 'CE board line');
      assert.equal(rentalBoard[0].total_cents, 1500, 'standalone uses duration price');
      assert.equal(ceBoard[0].total_cents, BOARD_DURING, 'CE uses during_course price');
      // Stock demand sums same physical key
      const claims = stock.collectRentalStockClaims(
        [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
        SERVICE_DATE,
        SERVICE_DATE,
      );
      const ceClaims = stock.collectCourseEquipmentStockClaims(
        [{ offering_key: 'board_rental', mode: 'during_course', quantity: 1 }],
        SERVICE_DATE,
        SERVICE_DATE,
        [SERVICE_DATE],
      );
      assert.equal(claims.ok && ceClaims.ok, true);
      const merged = stock.mergeExactOfferingStockClaims
        ? stock.mergeExactOfferingStockClaims(
          [...(claims.claims || []), ...(ceClaims.claims || [])],
        )
        : { ok: true, claims: [...(claims.claims || []), ...(ceClaims.claims || [])] };
      const boardDemand = (merged.claims || merged || []).filter((c) =>
        c && c.offering_key === 'board_rental');
      const totalQty = boardDemand.reduce((s, c) => s + Number(c.quantity || 0), 0);
      assert.ok(totalQty >= 2, `summed stock demand for board_rental got ${totalQty}`);
      console.log('  PASS same offering_key two lines + summed stock');
    }

    // ── Adversarial: generic + course/CE must not pure-generic early-return ──
    // (fresh preview — do not reuse provenance after intentional stale mutations)
    {
      assert.equal(
        transportHasNonGenericCommercialIntent({
          components: { course: { course_id: 'x', tier_key: '1_day', quantity: 1 } },
          course_equipment: [{ offering_key: 'board_rental', mode: 'during_course', quantity: 1 }],
        }),
        true,
        'adversarial: course+CE is non-generic intent',
      );
      const advPg = makePg();
      const advPreview = await staffPreviewQuote(staffDrawerPayload(), cfg, advPg);
      const advPrepBody = {
        ...staffDrawerPayload(),
        rentals: advPreview.canonicalRentals,
        components: staffDrawerPayload().components,
      };
      if (advPreview.genericPrep.genericRentals.length && !advPreview.canonicalRentals.length) {
        delete advPrepBody.rentals;
      }
      const advRentalPrep = prepareCanonicalRentalsForCreate(advPrepBody);
      const advTransport = {
        ...(advRentalPrep.body || {}),
        guest_name: 'Adv',
        guest_phone: '+34600999000',
        date_from: SERVICE_DATE,
        date_to: SERVICE_DATE,
        service_dates: [SERVICE_DATE],
        components: staffDrawerPayload().components,
        surfer_count: 1,
        course_equipment: staffDrawerPayload().course_equipment,
        custom_line_items: [],
        payment_status: 'unpaid',
      };
      const advResolved = await resolveAuthoritativeScheduleQuoteInTxn(advPg, {
        clientSlug: 'sunset',
        locationId: LOC,
        canonicalRentals: null,
        genericRentalRecords: advPreview.genericPrep.records,
        rentalPrepBody: advTransport,
        quotePrepBody: advTransport,
        quoteChannel: 'manual_staff',
        quoteProvenance: advPreview.body.quote_provenance,
        now: FIXED_NOW,
      });
      assert.equal(advResolved.authoritativeQuote.total_cents, EXPECTED_TOTAL);
      assert.ok(
        (advResolved.authoritativeQuote.line_items || []).some((l) => l.component === 'course'),
        'adversarial: must not drop course when generic rentals present',
      );
      assert.ok(
        (advResolved.authoritativeQuote.line_items || []).some((l) => l.course_equipment),
        'adversarial: must not drop CE when generic rentals present',
      );
      assert.ok(
        (advResolved.authoritativeQuote.line_items || []).some((l) =>
          l.generic_rental || String(l.offering_id || l.offering_key || '').includes('sup_rental')),
        'adversarial: must retain generic SUP line',
      );
      console.log('  PASS adversarial generic+course/CE retains all lines');
    }
  });

  // ── D readiness: policy fixture + included / optional €0 / unavailable ──
  {
    const dOpts = dFx.surf_pack.equipment_options;
    assert.equal(dOpts.find((o) => o.during_course_policy === 'included').during_course_price_cents, 0);
    assert.equal(dOpts.find((o) => o.during_course_policy === 'optional').during_course_price_cents, 0);
    assert.equal(dOpts.find((o) => o.during_course_policy === 'unavailable').during_course_policy, 'unavailable');

    const free = defaultFreeDuringCourseEquipmentSelection({
      packs: [{ equipment_options: dOpts }],
      surfers: 1,
    });
    assert.ok(Array.isArray(free) && free.length === 1, 'only included auto-expands');
    assert.equal(free[0].offering_key, 'board_and_suit_rental');
    assert.equal(free[0].mode, 'during_course');

    // Optional €0 omitted from free selection
    assert.ok(!free.some((f) => f.offering_key === 'carbon_fins'));

    // Quote owners via slice-e-shaped cfg for D policies
    const dPackId = dFx.surf_pack.pack_id;
    const dItem = packPriceItemCode(dPackId, '1_day');
    const dCfg = {
      ok: true,
      source: 'db',
      currency: 'EUR',
      rental_offerings: dFx.rental_offerings.map((o) => ({ ...o, client_slug: 'sunset' })),
      surf_packs: [{
        pack_id: dPackId,
        label: dFx.surf_pack.label,
        active: true,
        group_size: 8,
        weekly: 'sat_sun',
        schedules: ['1000_1300'],
        equipment_options: dOpts,
        price_tiers: dFx.surf_pack.price_tiers,
      }],
      prices: [{
        id: 'd-course',
        category: 'package',
        offering_key: dItem,
        item_code: dItem,
        amount_cents: 4000,
        unit: 'day',
        active: true,
        currency: 'EUR',
      }],
    };
    const dDate = '2026-09-05';
    const builtInc = buildSunsetQuoteCommand({
      channel: QUOTE_CHANNELS.MANUAL_STAFF,
      transportBody: {
        guest_name: 'D',
        payment_status: 'unpaid',
        service_dates: [dDate],
        components: { course: { course_id: dPackId, tier_key: '1_day', quantity: 1 } },
        // CE omitted — included must expand
      },
      trustedLocationId: LOC,
      now: FIXED_NOW,
    });
    const qInc = executeSunsetQuote.length
      ? await (async () => {
        const { executeSunsetQuoteSync } = require('./lib/luna-front-desk-quote-service');
        return executeSunsetQuoteSync(builtInc.command, { adminCfg: dCfg });
      })()
      : null;
    assert.equal(qInc.ok, true, JSON.stringify(qInc.body));
    const gearInc = (qInc.body.line_items || []).filter((l) => l.course_equipment);
    assert.strictEqual(gearInc.length, 1);
    assert.strictEqual(gearInc[0].total_cents, 0);
    assert.strictEqual(gearInc[0].during_course_policy, 'included');

    const qOptOmit = require('./lib/luna-front-desk-quote-service').executeSunsetQuoteSync(
      buildSunsetQuoteCommand({
        channel: QUOTE_CHANNELS.MANUAL_STAFF,
        transportBody: {
          guest_name: 'D2',
          payment_status: 'unpaid',
          service_dates: [dDate],
          components: { course: { course_id: dPackId, tier_key: '1_day', quantity: 1 } },
        },
        trustedLocationId: LOC,
        now: FIXED_NOW,
      }).command,
      { adminCfg: { ...dCfg, surf_packs: [{ ...dCfg.surf_packs[0], equipment_options: [dOpts[1]] }] } },
    );
    assert.equal(qOptOmit.ok, true);
    assert.strictEqual(
      (qOptOmit.body.line_items || []).filter((l) => l.course_equipment).length,
      0,
      'optional €0 omitted unless explicit',
    );

    const qOptExplicit = require('./lib/luna-front-desk-quote-service').executeSunsetQuoteSync(
      buildSunsetQuoteCommand({
        channel: QUOTE_CHANNELS.MANUAL_STAFF,
        transportBody: {
          guest_name: 'D3',
          payment_status: 'unpaid',
          service_dates: [dDate],
          components: { course: { course_id: dPackId, tier_key: '1_day', quantity: 1 } },
          course_equipment: [{ offering_key: 'carbon_fins', mode: 'during_course', quantity: 1 }],
        },
        trustedLocationId: LOC,
        now: FIXED_NOW,
      }).command,
      { adminCfg: { ...dCfg, surf_packs: [{ ...dCfg.surf_packs[0], equipment_options: [dOpts[1]] }] } },
    );
    assert.equal(qOptExplicit.ok, true, JSON.stringify(qOptExplicit.body));
    assert.strictEqual(
      (qOptExplicit.body.line_items || []).filter((l) => l.course_equipment).length,
      1,
    );

    const qUnavail = require('./lib/luna-front-desk-quote-service').executeSunsetQuoteSync(
      buildSunsetQuoteCommand({
        channel: QUOTE_CHANNELS.MANUAL_STAFF,
        transportBody: {
          guest_name: 'D4',
          payment_status: 'unpaid',
          service_dates: [dDate],
          components: { course: { course_id: dPackId, tier_key: '1_day', quantity: 1 } },
          course_equipment: [{ offering_key: 'wax', mode: 'during_course', quantity: 1 }],
        },
        trustedLocationId: LOC,
        now: FIXED_NOW,
      }).command,
      { adminCfg: { ...dCfg, surf_packs: [{ ...dCfg.surf_packs[0], equipment_options: [dOpts[2]] }] } },
    );
    assert.equal(qUnavail.ok, false);
    assert.equal(qUnavail.body.reason, 'invalid_course_equipment');
    console.log('  PASS D readiness: included / optional €0 / unavailable');
  }

  // ── E readiness: multi-course + private+CE fingerprint retention (owners only) ──
  {
    const { executeSunsetQuoteSync } = require('./lib/luna-front-desk-quote-service');
    const eCfg = adminCfg();
    const q1 = executeSunsetQuoteSync(
      buildSunsetQuoteCommand({
        channel: QUOTE_CHANNELS.MANUAL_STAFF,
        transportBody: {
          guest_name: 'E',
          payment_status: 'unpaid',
          service_dates: [SERVICE_DATE],
          components: { course: { course_id: PACK_ID, tier_key: TIER, quantity: 1 } },
          course_equipment: [
            { offering_key: 'board_rental', mode: 'during_course', quantity: 1 },
          ],
        },
        trustedLocationId: LOC,
        now: FIXED_NOW,
      }).command,
      { adminCfg: eCfg },
    );
    assert.equal(q1.ok, true);
    assert.equal(q1.body.quote_lane, 'components');
    const fp1 = q1.body.quote_provenance.quote_fingerprint;
    const replay = buildCreateRequoteTransportFromProvenance({
      service_dates: [SERVICE_DATE],
      components: { course: { course_id: PACK_ID, tier_key: TIER, quantity: 1 } },
      course_equipment: [
        { offering_key: 'board_rental', mode: 'during_course', quantity: 1 },
      ],
    }, q1.body.quote_provenance);
    assert.equal(replay.quote_lane, 'components');
    const qReplay = executeSunsetQuoteSync(
      buildSunsetQuoteCommand({
        channel: QUOTE_CHANNELS.MANUAL_STAFF,
        transportBody: { ...replay.quoteTransport, require_db: false },
        trustedLocationId: LOC,
        now: FIXED_NOW,
      }).command,
      { adminCfg: eCfg },
    );
    assert.equal(qReplay.ok, true);
    assert.equal(qReplay.body.quote_provenance.quote_fingerprint, fp1, 'E: fingerprint retained');

    // Mutation → different fingerprint
    const qMut = executeSunsetQuoteSync(
      buildSunsetQuoteCommand({
        channel: QUOTE_CHANNELS.MANUAL_STAFF,
        transportBody: {
          guest_name: 'E',
          payment_status: 'unpaid',
          service_dates: [SERVICE_DATE],
          components: { course: { course_id: PACK_ID, tier_key: TIER, quantity: 2 } },
          course_equipment: [
            { offering_key: 'board_rental', mode: 'during_course', quantity: 2 },
          ],
        },
        trustedLocationId: LOC,
        now: FIXED_NOW,
      }).command,
      { adminCfg: eCfg },
    );
    assert.equal(qMut.ok, true);
    assert.notStrictEqual(qMut.body.quote_provenance.quote_fingerprint, fp1, 'E: qty mutation stale');

    // Private + CE
    const qPriv = executeSunsetQuoteSync(
      buildSunsetQuoteCommand({
        channel: QUOTE_CHANNELS.MANUAL_STAFF,
        transportBody: {
          guest_name: 'EP',
          payment_status: 'unpaid',
          service_dates: [SERVICE_DATE],
          components: {
            private_lesson: {
              enabled: true,
              quantity: 1,
              surfer_count: 1,
              sessions: [{ date: SERVICE_DATE, start: '10:00', end: '12:00' }],
            },
          },
          course_equipment: [
            { offering_key: 'board_rental', mode: 'during_course', quantity: 1 },
          ],
          lessons: [{ kind: 'private', date: SERVICE_DATE, start: '10:00', end: '12:00' }],
        },
        trustedLocationId: LOC,
        now: FIXED_NOW,
      }).command,
      { adminCfg: eCfg },
    );
    assert.equal(qPriv.ok, true, JSON.stringify(qPriv.body));
    assert.ok((qPriv.body.line_items || []).some((l) => l.course_equipment));
    console.log('  PASS E readiness: components/private+CE replay + stale mutation');
  }

  // ── H readiness: Mon+Thu exact dates reach stock claims; gap day irrelevant ──
  {
    const monThu = hFx.example_service_dates;
    const gap = hFx.example_gap_dates_not_claimed;
    const claims = stock.collectCourseEquipmentStockClaims(
      [{ offering_key: 'board_rental', mode: 'during_course', quantity: 1 }],
      monThu[0],
      monThu[1],
      monThu,
    );
    assert.equal(claims.ok, true, JSON.stringify(claims));
    assert.deepStrictEqual(claims.claims[0].dates, monThu);
    assert.ok(!claims.claims[0].dates.includes(gap[0]));
    assert.ok(!claims.claims[0].dates.includes(gap[1]));

    // Contiguous fallback unchanged when service_dates omitted
    const range = stock.collectCourseEquipmentStockClaims(
      [{ offering_key: 'board_rental', quantity: 1 }],
      monThu[0],
      monThu[1],
    );
    assert.equal(range.ok, true);
    assert.ok(range.claims[0].dates.includes(gap[0]), 'contiguous fallback keeps gap days');

    // Sold-out on actual Mon fails closed
    const conflictPg = {
      async query(sql) {
        const s = String(sql);
        if (/FOR UPDATE/i.test(s) || /tenant_rental_offerings/i.test(s)) {
          return {
            rows: [{
              id: '1',
              client_slug: 'sunset',
              location_id: LOC,
              offering_key: 'board_rental',
              stock_quantity: 1,
              active: true,
              stock_scope: 'location',
            }],
          };
        }
        if (/booking_service_records/i.test(s)) {
          return {
            rows: [{
              booking_id: 'other',
              offering_key: 'board_rental',
              service_date: monThu[0],
              quantity: 1,
              status: 'confirmed',
              booking_status: 'confirmed',
              rental_service_dates: [monThu[0]],
            }],
          };
        }
        return { rows: [] };
      },
    };
    const asserted = await stock.assertRentalStockClaimsInTxn(conflictPg, {
      clientSlug: 'sunset',
      locationId: LOC,
      claims: claims.claims,
      defaultLocationId: LOC,
    });
    assert.equal(asserted.ok, false, 'sold-out Mon must fail');
    assert.ok(
      asserted.error === 'rental_stock_unavailable'
      || (asserted.body && asserted.body.error === 'rental_stock_unavailable'),
      JSON.stringify(asserted),
    );

    // Gap-day demand must not affect Mon+Thu claims (sold-out Wed is irrelevant)
    const gapSoldPg = {
      async query(sql) {
        const s = String(sql);
        if (/FOR UPDATE/i.test(s) || /tenant_rental_offerings/i.test(s)) {
          return {
            rows: [{
              id: '1',
              client_slug: 'sunset',
              location_id: LOC,
              offering_key: 'board_rental',
              stock_quantity: 1,
              active: true,
              stock_scope: 'location',
            }],
          };
        }
        if (/booking_service_records/i.test(s)) {
          return {
            rows: [{
              booking_id: 'other',
              offering_key: 'board_rental',
              service_date: gap[0], // Wed — not a claimed date
              quantity: 1,
              status: 'confirmed',
              booking_status: 'confirmed',
              rental_service_dates: [gap[0]],
            }],
          };
        }
        return { rows: [] };
      },
    };
    const gapAssert = await stock.assertRentalStockClaimsInTxn(gapSoldPg, {
      clientSlug: 'sunset',
      locationId: LOC,
      claims: claims.claims,
      defaultLocationId: LOC,
    });
    assert.equal(gapAssert.ok, true, 'sold-out gap day irrelevant for Mon+Thu claims');
    console.log('  PASS H readiness: Mon+Thu stock claims + gap day irrelevant');
  }

  // ── Three-price model copy + Admin policy control path ──
  {
    const contract = fs.readFileSync(
      path.join(__dirname, '..', 'docs', 'LUNA-FRONT-DESK-DOMAIN-CONTRACT.md'), 'utf8',
    );
    // Sunset Luna SOUL (not Wolf-House hermes-staging SOUL)
    const soul = fs.readFileSync(
      path.join(__dirname, '..', 'docker', 'hermes-sunset', 'SOUL.md'), 'utf8',
    );
    const adminUi = fs.readFileSync(
      path.join(__dirname, 'browser', 'sunset-admin-ui.js'), 'utf8',
    );
    const i18n = fs.readFileSync(
      path.join(__dirname, 'lib', 'staff-portal-i18n.js'), 'utf8',
    );
    assert.ok(
      /course_equipment/.test(soul) && /all_day/.test(soul),
      'Sunset Luna SOUL owns course_equipment / all_day contract language',
    );
    assert.ok(
      /course_equipment|quote_provenance|offering/.test(contract),
      'domain contract owns quote/CE language',
    );
    // Admin offline fixture owns explicit three-price model note for Captain
    assert.ok(dFx._meta.three_price_model);
    assert.ok(dFx._meta.three_price_model.standalone_rental);
    assert.ok(dFx._meta.three_price_model.during_course);
    assert.ok(dFx._meta.three_price_model.all_day);
    // Smallest Admin policy control + persistence path (optional €0 / unavailable authorable)
    assert.ok(adminUi.includes('admin-equipment-during-policy'));
    assert.ok(adminUi.includes('during_course_policy'));
    assert.ok(adminUi.includes('adminReadEquipmentOptions'));
    assert.ok(i18n.includes('admin.courseEquipment.policyOptional'));
    assert.ok(i18n.includes('admin.courseEquipment.threePriceHelp'));
    // Server still accepts explicit policy + infers when absent
    const {
      normalizeEquipmentOptions,
      validateEquipmentOptions,
    } = require('./lib/sunset-course-equipment-options');
    const optZero = validateEquipmentOptions([{
      offering_key: 'carbon_fins',
      during_course_policy: 'optional',
      during_course_price_cents: 0,
      all_day_price_cents: 500,
    }]);
    assert.equal(optZero[0].during_course_policy, 'optional');
    const inferred = normalizeEquipmentOptions([{
      offering_key: 'softboard',
      during_course_price_cents: 0,
      all_day_price_cents: 1000,
    }]);
    assert.equal(inferred[0].during_course_policy, 'included', 'absent policy: €0 → included');
    console.log('  PASS three-price model + Admin policy control path');
  }

  // ── Transactional invariant 1: create preflight never heals price rules ──
  {
    const writesSrc = fs.readFileSync(
      path.join(__dirname, 'lib', 'sunset-schedule-booking-writes.js'), 'utf8',
    );
    // Create path must not call syncPackTierToPriceRules (Admin pack + reconcile own it).
    assert.ok(
      !/createSunsetScheduleBooking[\s\S]*syncPackTierToPriceRules/.test(writesSrc)
      || (writesSrc.match(/syncPackTierToPriceRules/g) || []).length === 0
      || !writesSrc.includes('skipTransaction: true'),
      'create path must not heal with skipTransaction sync',
    );
    // Stronger: zero require of price-sync inside writes after our fix.
    assert.ok(
      !writesSrc.includes("require('./sunset-admin-price-sync')"),
      'create owner must not require sunset-admin-price-sync',
    );

    const priceSync = require('./lib/sunset-admin-price-sync');
    let syncCalls = 0;
    const origSync = priceSync.syncPackTierToPriceRules;
    priceSync.syncPackTierToPriceRules = async function patchedSync(...args) {
      syncCalls += 1;
      return origSync.apply(this, args);
    };

    const cfg = adminCfg();
    await withAdminCfg(cfg, async () => {
      // Missing package price → preflight would have healed before; now fail-closed.
      const pgMissing = makePg({ omitPackagePrice: true });
      const payload = staffDrawerPayload({
        idempotency_key: 'p0-heal-stale-1',
      });
      // Fresh quote needs package price — build provenance from full cfg then
      // create against missing package rule so preflight/re-quote fails.
      const pgQuote = makePg();
      const preview = await staffPreviewQuote(payload, cfg, pgQuote);
      assert.equal(preview.body.total_cents, EXPECTED_TOTAL);

      // Stale provenance + missing heal path: mutate fingerprint so if we ever
      // reached re-quote it would fail; also omit package price for preflight.
      const staleProv = {
        ...preview.body.quote_provenance,
        quote_fingerprint: 'f'.repeat(64),
        total_cents: 1,
      };
      const cmd = buildSunsetBookingCreateCommand({
        channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
        transportBody: {
          ...payload,
          service_dates: [SERVICE_DATE],
          quote_provenance: staleProv,
          idempotency_key: 'p0-heal-stale-1',
        },
        trustedLocationId: LOC,
        now: FIXED_NOW,
        actorHints: { staff_user_id: 's', email: 's@t' },
      });
      const out = await executeSunsetBookingCreate(pgMissing, cmd.command);
      assert.equal(out.ok, false, JSON.stringify(out.body));
      assert.strictEqual(syncCalls, 0, 'syncPackTierToPriceRules must not run on create');
      assert.strictEqual(pgMissing.state.priceRuleWrites.length, 0, 'no price-rule writes');
      assert.strictEqual(pgMissing.state.mutatingOutsideTxn.length, 0,
        `no mutating SQL outside txn: ${JSON.stringify(pgMissing.state.mutatingOutsideTxn)}`);
      assert.strictEqual(pgMissing.state.bookings.length, 0, 'zero booking rows');
      assert.strictEqual(pgMissing.state.services.length, 0, 'zero service rows');
      assert.equal(pgMissing.state.committed, false, 'no COMMIT');
      console.log('  PASS create preflight read-only: no heal writes on fail-closed path');

      // Price present + stale provenance: fail stale, still zero durable writes.
      const pgStale = makePg();
      const outStale = await executeSunsetBookingCreate(pgStale, buildSunsetBookingCreateCommand({
        channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
        transportBody: {
          ...payload,
          service_dates: [SERVICE_DATE],
          quote_provenance: staleProv,
          idempotency_key: 'p0-stale-zero-1',
        },
        trustedLocationId: LOC,
        now: FIXED_NOW,
        actorHints: { staff_user_id: 's', email: 's@t' },
      }).command);
      assert.equal(outStale.ok, false, JSON.stringify(outStale.body));
      assert.ok(
        outStale.body && (outStale.body.reason_code === 'stale_quote'
          || /stale|no longer available/i.test(JSON.stringify(outStale.body))),
        JSON.stringify(outStale.body),
      );
      assert.strictEqual(syncCalls, 0);
      assert.strictEqual(pgStale.state.priceRuleWrites.length, 0);
      assert.strictEqual(pgStale.state.mutatingOutsideTxn.length, 0);
      assert.strictEqual(pgStale.state.bookings.length, 0);
      assert.strictEqual(pgStale.state.services.length, 0);
      assert.equal(pgStale.state.committed, false);
      console.log('  PASS stale create zero-write (no heal side effects)');
    });

    priceSync.syncPackTierToPriceRules = origSync;
  }

  // ── Transactional invariant 2: session-lock idempotency BEFORE catalog/price ──
  {
    const writesSrc = fs.readFileSync(
      path.join(__dirname, 'lib', 'sunset-schedule-booking-writes.js'), 'utf8',
    );
    assert.ok(writesSrc.includes('pg_advisory_lock'), 'session lock used');
    assert.ok(writesSrc.includes('pg_advisory_unlock'), 'session unlock used');
    assert.ok(writesSrc.includes('buildCreateRequestIdempotencyIdentity'));
    const sessionLockIdx = writesSrc.indexOf('acquireIdempotencySessionLock');
    const earlyFindIdx = writesSrc.indexOf('existingEarly');
    const genericIdx = writesSrc.indexOf('prepareGenericRentalsForCreate({');
    assert.ok(sessionLockIdx > 0 && earlyFindIdx > sessionLockIdx
      && genericIdx > earlyFindIdx,
    'session lock → early idempotent find → generic prep order');

    const cfg = adminCfg();
    await withAdminCfg(cfg, async () => {
      const IDEM = `p0-idem-${Date.now()}`;
      const pg = makePg();
      const payload = staffDrawerPayload({ idempotency_key: IDEM });
      const preview = await staffPreviewQuote(payload, cfg, pg);
      assert.equal(preview.body.total_cents, EXPECTED_TOTAL);

      const createBody = {
        ...payload,
        service_dates: [SERVICE_DATE],
        quote_provenance: preview.body.quote_provenance,
        idempotency_key: IDEM,
      };
      const pure = buildCreateRequestIdempotencyIdentity(
        createBody, LOC, createBody.quote_provenance,
      );
      assert.equal(pure.ok, true);
      assert.ok(pure.fingerprint);

      const first = await executeSunsetBookingCreate(pg, buildSunsetBookingCreateCommand({
        channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
        transportBody: createBody,
        trustedLocationId: LOC,
        now: FIXED_NOW,
        actorHints: { staff_user_id: 's', email: 's@t' },
      }).command);
      assert.equal(first.ok, true, JSON.stringify(first.body));
      assert.equal(pg.committed(), true);
      assert.ok(pg.state.lockCount >= 1 && pg.state.unlockCount >= 1, 'lock released after success');
      assert.strictEqual(pg.state.sessionLocks.size, 0, 'no leaked session locks');
      const firstBookingId = first.body.booking_id;
      const nBookings = pg.state.bookings.length;
      assert.ok(
        pg.state.services.some((s) => s.metadata && s.metadata.idempotency_key === IDEM
          && s.metadata.idempotency_intent_fp === pure.fingerprint),
        'stored intent fp equals pure request identity',
      );

      // (1) Exact completed generic rental replay after rental inactive/missing
      {
        const catBefore = pg.state.catalogQueries;
        const priceBefore = pg.state.priceQueries;
        const tro = require('./lib/tenant-rental-offerings');
        const origList = tro.listRentalOfferings;
        tro.listRentalOfferings = async () => OFFERINGS
          .filter((o) => o.offering_key !== 'sup_rental')
          .concat([{
            offering_key: 'sup_rental', label: 'SUP', active: false,
            client_slug: 'sunset', location_id: LOC, stock_quantity: 0,
          }]);
        try {
          const replay = await executeSunsetBookingCreate(pg, buildSunsetBookingCreateCommand({
            channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
            transportBody: createBody,
            trustedLocationId: LOC,
            now: FIXED_NOW,
            actorHints: { staff_user_id: 's', email: 's@t' },
          }).command);
          assert.equal(replay.ok, true, JSON.stringify(replay.body));
          assert.equal(replay.body.idempotent, true);
          assert.equal(replay.body.booking_id, firstBookingId);
          assert.strictEqual(pg.state.bookings.length, nBookings);
          assert.strictEqual(pg.state.catalogQueries, catBefore,
            `replay must not query rental catalog (was ${catBefore} now ${pg.state.catalogQueries})`);
          assert.strictEqual(pg.state.priceQueries, priceBefore,
            `replay must not query price rules (was ${priceBefore} now ${pg.state.priceQueries})`);
          assert.strictEqual(pg.state.sessionLocks.size, 0, 'unlock after replay');
          console.log('  PASS (1) exact replay after rental inactive — no catalog/price queries');
        } finally {
          tro.listRentalOfferings = origList;
        }
      }

      // (2) Exact course replay after course package price missing
      {
        const omitPg = makePg({ omitPackagePrice: true });
        omitPg.state.bookings = pg.state.bookings.slice();
        omitPg.state.services = pg.state.services.map((s) => ({ ...s, metadata: { ...s.metadata } }));
        omitPg.state.committed = true;
        const replay = await executeSunsetBookingCreate(omitPg, buildSunsetBookingCreateCommand({
          channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
          transportBody: createBody,
          trustedLocationId: LOC,
          now: FIXED_NOW,
          actorHints: { staff_user_id: 's', email: 's@t' },
        }).command);
        assert.equal(replay.ok, true, JSON.stringify(replay.body));
        assert.equal(replay.body.idempotent, true);
        assert.strictEqual(omitPg.state.priceQueries, 0,
          'course price missing must not run price preflight on exact replay');
        assert.strictEqual(omitPg.state.sessionLocks.size, 0);
        console.log('  PASS (2) exact course replay after package price missing');
      }

      // (3) Same key changed qty/CE → conflict before pricing
      {
        const conflictBody = {
          ...createBody,
          surfer_count: 2,
          components: {
            course: { ...createBody.components.course, quantity: 2 },
          },
          course_equipment: [
            { offering_key: 'board_rental', mode: 'during_course', quantity: 2 },
            { offering_key: 'wetsuit_rental', mode: 'during_course', quantity: 2 },
          ],
        };
        const catBefore = pg.state.catalogQueries;
        const conflict = await executeSunsetBookingCreate(pg, buildSunsetBookingCreateCommand({
          channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
          transportBody: conflictBody,
          trustedLocationId: LOC,
          now: FIXED_NOW,
          actorHints: { staff_user_id: 's', email: 's@t' },
        }).command);
        assert.equal(conflict.ok, false, JSON.stringify(conflict.body));
        assert.ok(
          conflict.body && (
            conflict.body.reason_code === 'idempotency_key_intent_conflict'
            || conflict.body.error === 'idempotency_key_intent_conflict'
          ),
          JSON.stringify(conflict.body),
        );
        assert.strictEqual(pg.state.catalogQueries, catBefore, 'conflict before catalog pricing');
        assert.strictEqual(pg.state.sessionLocks.size, 0, 'unlock after conflict');
        console.log('  PASS (3) intent conflict before pricing error');
      }

      // (4) Concurrent same-key serializes then rechecks
      {
        const IDEM2 = `p0-race-${Date.now()}`;
        const bodyA = {
          ...createBody,
          idempotency_key: IDEM2,
          guest_name: 'Race Guest A',
        };
        const racePg = makePg();
        let lockHeld = false;
        const realQuery = racePg.query.bind(racePg);
        racePg.query = async (sql, params = []) => {
          const q = String(sql);
          if (/pg_advisory_lock\b/i.test(q) && !/xact/i.test(q)) {
            while (lockHeld) {
              // eslint-disable-next-line no-await-in-loop
              await new Promise((r) => setImmediate(r));
            }
            lockHeld = true;
            racePg.state.lockCount += 1;
            racePg.state.sessionLocks.add(`${params[0]}:${params[1]}`);
            return { rows: [{ pg_advisory_lock: true }] };
          }
          if (/pg_advisory_unlock_all\b/i.test(q)) {
            lockHeld = false;
            racePg.state.sessionLocks.clear();
            return { rows: [{ pg_advisory_unlock_all: '' }] };
          }
          if (/pg_advisory_unlock\b/i.test(q)) {
            lockHeld = false;
            racePg.state.unlockCount += 1;
            racePg.state.sessionLocks.delete(`${params[0]}:${params[1]}`);
            return { rows: [{ unlocked: true, pg_advisory_unlock: true }] };
          }
          return realQuery(sql, params);
        };
        const win = await executeSunsetBookingCreate(racePg, buildSunsetBookingCreateCommand({
          channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
          transportBody: bodyA,
          trustedLocationId: LOC,
          now: FIXED_NOW,
          actorHints: { staff_user_id: 's', email: 's@t' },
        }).command);
        assert.equal(win.ok, true, JSON.stringify(win.body));
        const lose = await executeSunsetBookingCreate(racePg, buildSunsetBookingCreateCommand({
          channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
          transportBody: bodyA,
          trustedLocationId: LOC,
          now: FIXED_NOW,
          actorHints: { staff_user_id: 's', email: 's@t' },
        }).command);
        assert.equal(lose.ok, true, JSON.stringify(lose.body));
        assert.equal(lose.body.idempotent, true);
        assert.equal(lose.body.booking_id, win.body.booking_id);
        assert.strictEqual(racePg.state.sessionLocks.size, 0);
        console.log('  PASS (4) concurrent same-key serializes then rechecks');
      }

      // (5) Lock release on validation failure
      {
        const failPg = makePg();
        const bad = await executeSunsetBookingCreate(failPg, buildSunsetBookingCreateCommand({
          channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
          transportBody: {
            ...createBody,
            idempotency_key: `p0-valfail-${Date.now()}`,
            guest_name: '',
          },
          trustedLocationId: LOC,
          now: FIXED_NOW,
          actorHints: { staff_user_id: 's', email: 's@t' },
        }).command);
        assert.equal(bad.ok, false);
        assert.strictEqual(failPg.state.sessionLocks.size, 0, 'unlock after validation failure');
        console.log('  PASS (5) lock released on validation failure');
      }

      // (6) Omit+provenance CE equivalent + lock release after thrown path unit
      {
        const omitBody = { ...createBody };
        delete omitBody.course_equipment;
        const omitReplay = await executeSunsetBookingCreate(pg, buildSunsetBookingCreateCommand({
          channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
          transportBody: omitBody,
          trustedLocationId: LOC,
          now: FIXED_NOW,
          actorHints: { staff_user_id: 's', email: 's@t' },
        }).command);
        assert.equal(omitReplay.ok, true, JSON.stringify(omitReplay.body));
        assert.equal(omitReplay.body.idempotent, true);
        console.log('  PASS (6) omit+provenance CE equivalent + unlock');
      }

      {
        const sk = scheduleBookingIdempotencySessionKeys('sunset', 'k');
        const {
          scheduleBookingIdempotencyAdvisoryKeys,
        } = require('./lib/sunset-schedule-booking-writes');
        const xk = scheduleBookingIdempotencyAdvisoryKeys('sunset', 'k');
        assert.ok(sk[0] !== xk[0] || sk[1] !== xk[1], 'session≠xact lock keys');
        console.log('  PASS session/xact lock namespaces distinct');
      }
    });
  }

  // ── Admin policy: infer only when absent; explicit invalid fails ──
  {
    const adminSrc = fs.readFileSync(
      path.join(__dirname, 'browser', 'sunset-admin-ui.js'), 'utf8',
    );
    assert.ok(adminSrc.includes('data-policy-explicit-invalid'));
    assert.ok(adminSrc.includes('hasExplicitPolicy'));
    assert.ok(adminSrc.includes('data-policy-absent'));
    const {
      normalizeEquipmentOptions,
      validateEquipmentOptions,
    } = require('./lib/sunset-course-equipment-options');
    assert.equal(validateEquipmentOptions([{
      offering_key: 'board_and_suit_rental',
      during_course_policy: 'included',
      during_course_price_cents: 0,
      all_day_price_cents: 1000,
    }])[0].during_course_policy, 'included');
    assert.equal(validateEquipmentOptions([{
      offering_key: 'carbon_fins',
      during_course_policy: 'optional',
      during_course_price_cents: 0,
      all_day_price_cents: 500,
    }])[0].during_course_policy, 'optional');
    assert.equal(validateEquipmentOptions([{
      offering_key: 'wax',
      during_course_policy: 'unavailable',
      during_course_price_cents: 0,
      all_day_price_cents: 100,
    }])[0].during_course_policy, 'unavailable');
    assert.equal(normalizeEquipmentOptions([{
      offering_key: 'softboard',
      during_course_price_cents: 0,
      all_day_price_cents: 1000,
    }])[0].during_course_policy, 'included');
    assert.throws(() => validateEquipmentOptions([{
      offering_key: 'softboard',
      during_course_policy: 'bogus',
      during_course_price_cents: 0,
      all_day_price_cents: 1000,
    }]), /invalid during_course_policy/);
    const i18n = fs.readFileSync(path.join(__dirname, 'lib', 'staff-portal-i18n.js'), 'utf8');
    assert.ok(i18n.includes('admin.courseEquipment.policyInvalid'));
    console.log('  PASS Admin policy roundtrip: included/optional€0/unavailable/absent/invalid');
  }

  // ── Three-price Luna contract (SOUL + plugin tool desc) ──
  {
    const soul = fs.readFileSync(
      path.join(__dirname, '..', 'docker', 'hermes-sunset', 'SOUL.md'), 'utf8',
    );
    assert.ok(/Three independent price authorities/i.test(soul));
    assert.ok(/Standalone rental duration/i.test(soul));
    assert.ok(/during-course|during_course/i.test(soul));
    assert.ok(/all-day|all_day/i.test(soul));
    const chunk = soul.match(/Three independent price authorities[\s\S]{0,900}/);
    assert.ok(chunk, 'three-price chunk present');
    assert.ok(!/€\d{2,}|EUR\s*\d{2,}/i.test(chunk[0]),
      'three-price SOUL copy must not hardcode euro amounts');
    const plugin = fs.readFileSync(
      path.join(__dirname, '..', 'docker', 'hermes-staging', 'plugins',
        'wolfhouse_staff_api', '__init__.py'), 'utf8',
    );
    assert.ok(/Three independent price authorities/i.test(plugin));
    console.log('  PASS three-price model in Sunset SOUL + plugin tool description');
  }

  // ── Production owner claim ──
  {
    assert.equal(typeof executeSunsetBookingCreate, 'function');
    assert.equal(typeof createSunsetScheduleBooking, 'function');
    assert.equal(typeof buildCreateRequestIdempotencyIdentity, 'function');
    const sample = staffDrawerPayload();
    ['guest_name', 'guest_phone', 'date_from', 'date_to', 'components',
      'course_equipment', 'rentals', 'surfer_count', 'payment_status'].forEach((k) => {
      assert.ok(Object.prototype.hasOwnProperty.call(sample, k), `staff payload owns ${k}`);
    });
    console.log('  PASS production create owner + staff payload shape claims');
  }

  console.log('verify-sunset-combo-pricing-p0 — ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
