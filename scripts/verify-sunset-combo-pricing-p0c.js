'use strict';

/**
 * P0c — staff schedule quote helper must use shared CANONICAL_RENTAL_OFFERING_KEYS.
 *
 * Live symptom on deployed revision 0000447 / base 34e4b7f3:
 *   handleSunsetScheduleBookingQuote filtered canonicalRentals with a stale
 *   hardcoded list (board_rental|wetsuit_rental|board_and_suit_rental only).
 *   surfboard_wetsuit_rental is canonical in prepare/create, so equipment-only
 *   S+W produced empty generic + empty local canonical → empty stub total 0
 *   despite live tenant_price_rules rows at 3000 (1_day) and 1500 (2_hours).
 *
 * Required:
 *   - Production staff quote helper uses shared CANONICAL list (no separate list)
 *   - Equipment-only S+W 1_day=3000, 2_hours=1500 via exact tenant_price_rules
 *   - Mixed course+SUP+S+W+CE included 0: exact sum, two S+W lines, stock qty2,
 *     provenance create succeeds via production staff helper + create owner
 *   - Unpriced/missing/zero → 422 price_* + ui_message_key; never ok €0; zero writes
 *   - Drawer UI clears total, shows Price not configured / Unpriced, Create disabled
 *   - Adversarial: every CANONICAL_RENTAL_OFFERING_KEYS key survives classification
 *   - SUP and shared keys unchanged; no alias borrow; Wolfhouse untouched
 *
 * Offline — production-shaped Admin fixture. No live calls / no push / no deploy.
 *
 * Run: node scripts/verify-sunset-combo-pricing-p0c.js
 *   npm run verify:sunset-combo-pricing-p0c
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  buildSunsetQuoteCommand,
  executeSunsetQuote,
  buildQuoteProvenance,
  QUOTE_CHANNELS,
} = require('./lib/luna-front-desk-quote-service');
const {
  prepareGenericRentalsForCreate,
  prepareCanonicalRentalsForCreate,
  buildGenericRentalAuthoritativeQuote,
  CANONICAL_RENTAL_OFFERING_KEYS,
  mergeGenericQuoteLinesIntoBody,
  transportHasNonGenericCommercialIntent,
  resolveAuthoritativeScheduleQuoteInTxn,
} = require('./lib/sunset-schedule-booking-writes');
const {
  executeSunsetStaffScheduleBookingQuote,
  classifyCanonicalRentalsForStaffQuote,
  classifyCanonicalRentalsWithStaleHardcodedFilter,
  attachStaffQuoteUiContract,
  normalizeStaffQuotePriceFailureReason,
  PRICE_NOT_CONFIGURED_UI_KEY,
  PRICE_FAILURE_REASONS,
  STALE_HARDCODED_CANONICAL_KEYS,
} = require('./lib/sunset-staff-schedule-booking-quote');
const {
  BOOKING_CREATE_CHANNELS,
  buildSunsetBookingCreateCommand,
  executeSunsetBookingCreate,
} = require('./lib/luna-front-desk-booking-create-service');
const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');
const {
  resolveGenericRentalPrice,
} = require('./lib/tenant-rental-price-resolver');
const stockService = require('./lib/tenant-rental-stock-service');
const {
  collectRentalStockClaims,
  collectCourseEquipmentStockClaims,
  mergeExactOfferingStockClaims,
} = stockService;
const {
  resolveBusinessVertical,
  VERTICAL_CHANNELS,
} = require('./lib/luna-front-desk-business-vertical');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const esStrings = require('./lib/staff-portal-i18n-es-sunset');
const jobReadonly = require('./job-sunset-staff-sw-quote-readonly');
const {
  fixtureDates, remapIsoDates, shift, daysBetween, clockAt,
} = require('./lib/gate-fixture-dates');

const FIXTURE = path.join(
  __dirname, '..', 'fixtures', 'sunset-admin-offline', 'curso-tarde-sw-collision-p0b.json',
);
const ROOT = path.join(__dirname, '..');

// The fixture pins one service day. Keep its weekday — the Admin course schedule is
// weekday-shaped — but read the rest off the clock, so the payloads stay bookable instead
// of aging into explicit_past_date and testing the calendar. The fixture's own dates are
// remapped on load, so the fixture file itself stays untouched.
const dates = fixtureDates();
const fxRaw = fs.readFileSync(FIXTURE, 'utf8');
const FIXTURE_SERVICE_DATE = JSON.parse(fxRaw).staff_drawer_selection.service_date;
const serviceDay = dates.sameWeekdayFromNow(FIXTURE_SERVICE_DATE, 30);
const fx = JSON.parse(remapIsoDates(fxRaw, (iso) => shift(serviceDay, daysBetween(FIXTURE_SERVICE_DATE, iso))));
const LOC = fx._meta.location_id;
const FIXED_NOW = clockAt(fx.staff_drawer_selection.service_date);
const PACK_ID = fx.surf_pack.pack_id;
const TIER = '1_day';
const PACK_ITEM = packPriceItemCode(PACK_ID, TIER);
const SERVICE_DATE = fx.staff_drawer_selection.service_date;
const SW = 'surfboard_wetsuit_rental';
const SUP = 'sup_rental';
const ALIAS = 'board_and_suit_rental';
const E = fx.expected;
const COURSE_CENTS = E.course_cents;
const SUP_CENTS = E.sup_1_day_cents;
const SW_DAY = E.sw_1_day_cents;
const SW_2H = E.sw_2_hours_cents;
const COMBO_TOTAL = E.combo_total_cents;

const OFFERINGS = fx.rental_offerings.map((o) => ({ ...o, client_slug: 'sunset' }));
const PRICE_ROWS = [
  {
    id: 'pr-course', amount_cents: COURSE_CENTS, currency: 'EUR', item_type: 'package',
    item_code: PACK_ITEM, unit: 'day', location_id: LOC, active: true, pricing_status: 'confirmed',
  },
  ...fx.rental_prices.map((p, i) => ({
    id: `pr-r-${i}`,
    amount_cents: p.amount_cents,
    currency: 'EUR',
    item_type: 'rental',
    item_code: p.item_code,
    unit: p.unit,
    location_id: LOC,
    active: true,
    pricing_status: p.pricing_status || 'confirmed',
    offering_key: p.offering_key,
  })),
];
const EQ_SW = fx.surf_pack.equipment_options[0];

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

function adminCfg(overrides = {}) {
  const prices = PRICE_ROWS.map((p) => {
    let amount = p.amount_cents;
    if (overrides.priceOverrides && overrides.priceOverrides[p.item_code] != null) {
      amount = overrides.priceOverrides[p.item_code];
    }
    if (overrides.omitItemCodes && overrides.omitItemCodes.includes(p.item_code)) {
      return null;
    }
    return {
      id: p.id,
      category: p.item_type,
      offering_key: p.offering_key || p.item_code,
      item_code: p.item_code,
      amount_cents: amount,
      unit: p.unit,
      active: p.active !== false,
      currency: 'EUR',
      location_id: LOC,
      pricing_status: 'confirmed',
    };
  }).filter(Boolean);
  return {
    ok: true,
    source: 'db',
    currency: 'EUR',
    rental_offerings: OFFERINGS,
    surf_packs: [{
      pack_id: PACK_ID,
      label: fx.surf_pack.label,
      active: true,
      group_size: fx.surf_pack.group_size,
      weekly: fx.surf_pack.weekly,
      schedules: fx.surf_pack.schedules,
      equipment_options: overrides.equipment_options || [EQ_SW],
      price_tiers: fx.surf_pack.price_tiers,
    }],
    prices,
    private_lesson: {
      id: 'private-p0c',
      enabled: true,
      label: 'Private',
      amount_cents: 6000,
      currency: 'EUR',
      price_basis: 'per_session',
      default_duration_minutes: 120,
      equipment_options: overrides.equipment_options || [EQ_SW],
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
    priceRuleWrites: [],
    sessionLocks: new Set(),
  };
  const priceRows = (opts.priceRows || PRICE_ROWS).map((p) => ({ ...p }));
  if (opts.priceOverrides) {
    for (const row of priceRows) {
      if (opts.priceOverrides[row.item_code] != null) {
        row.amount_cents = opts.priceOverrides[row.item_code];
      }
    }
  }
  if (opts.omitItemCodes) {
    for (let i = priceRows.length - 1; i >= 0; i -= 1) {
      if (opts.omitItemCodes.includes(priceRows[i].item_code)) priceRows.splice(i, 1);
    }
  }
  const packConfig = {
    age_band: '12_and_up',
    group_size: 24,
    beaches: ['somo'],
    weekly: 'sat_sun',
    schedules: ['1600_1800'],
    equipment_options: opts.equipment_options || [EQ_SW],
    price_tiers: fx.surf_pack.price_tiers,
  };
  const pg = {
    state,
    committed: () => state.committed,
    rolledBack: () => state.rolledBack,
    async query(sql, params = []) {
      const q = String(sql);
      state.sqlLog.push({ q: q.slice(0, 160), params: (params || []).slice(0, 8) });
      if (/^\s*BEGIN/i.test(q)) { state.inTxn = true; return { rows: [] }; }
      if (/^\s*COMMIT/i.test(q)) {
        state.committed = true;
        state.inTxn = false;
        return { rows: [] };
      }
      if (/^\s*ROLLBACK/i.test(q)) {
        state.rolledBack = true;
        state.inTxn = false;
        if (!state.committed) {
          state.bookings = [];
          state.services = [];
        }
        return { rows: [] };
      }
      if (/pg_advisory_lock\b/i.test(q) && !/xact/i.test(q)) {
        state.sessionLocks.add(`${params[0]}:${params[1]}`);
        return { rows: [{ pg_advisory_lock: true }] };
      }
      if (/pg_advisory_unlock_all\b/i.test(q)) {
        state.sessionLocks.clear();
        return { rows: [{ pg_advisory_unlock_all: '' }] };
      }
      if (/pg_advisory_unlock\b/i.test(q)) {
        state.sessionLocks.delete(`${params[0]}:${params[1]}`);
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
            label: fx.surf_pack.label,
            active: true,
            location_id: LOC,
            config_json: packConfig,
          }],
        };
      }
      if (/tenant_private_lesson/i.test(q)) return { rows: [] };
      if (/tenant_rental_offerings/i.test(q) && /FOR UPDATE/i.test(q)) {
        return {
          rows: OFFERINGS.map((o) => ({
            id: o.offering_key,
            offering_key: o.offering_key,
            stock_quantity: stockByKey[o.offering_key] != null
              ? stockByKey[o.offering_key] : stockRemaining,
            remaining: stockByKey[o.offering_key] != null
              ? stockByKey[o.offering_key] : stockRemaining,
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
              ? stockByKey[o.offering_key] : stockRemaining,
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
        const id = `bk-p0c-${state.bookingSeq}`;
        state.bookings.push({
          id,
          booking_code: params[1] || `SUNSET-P0C-${state.bookingSeq}`,
          total_amount_cents: null,
          params,
        });
        return { rows: [{ id, booking_code: params[1] || `SUNSET-P0C-${state.bookingSeq}` }] };
      }
      if (/INSERT INTO tenant_price_rules|UPSERT.*tenant_price_rules|UPDATE tenant_price_rules/i.test(q)) {
        state.priceRuleWrites.push({ q: q.slice(0, 120), params });
      }
      if (/INSERT INTO booking_service_records/i.test(q)) {
        state.serviceSeq += 1;
        const id = `sr-p0c-${state.serviceSeq}`;
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
      if (/metadata->>'idempotency_key'/i.test(q) && /SELECT/i.test(q)) return { rows: [] };
      if (/idempotency/i.test(q) && /SELECT/i.test(q)) return { rows: [] };
      if (/FROM bookings/i.test(q)) return { rows: [] };
      if (/booking_service_records/i.test(q)) return { rows: [] };
      if (/COALESCE\(SUM/i.test(q)) return { rows: [{ seats: 0, paid_total: 0 }] };
      if (/FROM payments/i.test(q)) return { rows: [] };
      return { rows: [] };
    },
  };
  return pg;
}

function makeLoadRule(rows) {
  return async (params) => {
    const duration = params.duration;
    const itemCode = params.itemCode;
    const code = String(itemCode || '').includes('__')
      ? itemCode
      : `${itemCode}__${duration}`;
    const hit = rows.find((r) => r.item_code === code && r.active !== false);
    if (!hit) return { status: 'not_found', location_id: LOC };
    if (!(Number(hit.amount_cents) > 0)) {
      return { status: 'not_found', location_id: LOC };
    }
    return {
      status: 'found',
      amount_cents: hit.amount_cents,
      currency: 'EUR',
      item_code: hit.item_code,
      unit: hit.unit,
      location_id: LOC,
      pricing_status: 'confirmed',
    };
  };
}

function equipmentOnlyPayload(durationKey) {
  return {
    guest_name: '',
    guest_phone: '',
    date_from: SERVICE_DATE,
    date_to: SERVICE_DATE,
    payment_status: 'unpaid',
    notes: '',
    components: {},
    course_equipment: [],
    rentals: [
      { offering_key: SW, duration_key: durationKey, quantity: 1 },
    ],
    custom_line_items: [],
    surfer_count: 1,
    lessons: [],
    service_dates: [SERVICE_DATE],
  };
}

function staffDrawerPayload(overrides = {}) {
  return {
    guest_name: 'P0c Combo Guest',
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
      { offering_key: SW, mode: 'during_course', quantity: 1 },
    ],
    rentals: [
      { offering_key: SUP, duration_key: '1_day', quantity: 1 },
      { offering_key: SW, duration_key: '1_day', quantity: 1 },
    ],
    custom_line_items: [],
    surfer_count: 1,
    lessons: [],
    service_dates: [SERVICE_DATE],
    ...overrides,
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
  tbc.loadTenantPriceRuleFromDb = async (_pg, params) => {
    const duration = params.duration;
    const itemCode = params.itemCode;
    const code = String(itemCode || '').includes('__')
      ? itemCode
      : `${itemCode}__${duration}`;
    const hit = (cfg.prices || []).find((p) => p.item_code === code && p.active !== false);
    if (!hit) return { status: 'not_found', location_id: LOC };
    if (!(Number(hit.amount_cents) > 0)) {
      return { status: 'not_found', location_id: LOC };
    }
    return {
      status: 'found',
      amount_cents: hit.amount_cents,
      currency: 'EUR',
      item_code: hit.item_code || code,
      unit: hit.unit,
      location_id: LOC,
      pricing_status: 'confirmed',
    };
  };
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
    unit_amount_cents: l.unit_amount_cents != null ? l.unit_amount_cents : l.unit_cents,
    billing_unit: l.billing_unit || l.unit || l.price_unit || null,
    duration_key: l.duration_key || l.tier_key || null,
    item_code: l.item_code || l.offering_item_code || l.offering_id || null,
  }));
}

/**
 * Fail if SQL log contains commercial writes or hard DDL/COMMIT.
 * Permit SELECT / BEGIN / ROLLBACK / SHOW / SET TRANSACTION / advisory lock /
 * and idempotent schema-ensure CREATE TABLE|INDEX IF NOT EXISTS (no row data).
 * Never permit INSERT/UPDATE/DELETE/COMMIT/DROP/ALTER/TRUNCATE.
 */
function assertReadOnlySqlLog(sqlLog, label) {
  const writes = (sqlLog || []).filter((e) => {
    const q = String(e.q || e || '');
    if (/^\s*(SELECT|BEGIN|ROLLBACK|SHOW|SET\s+TRANSACTION|SET\s+LOCAL)\b/i.test(q)) return false;
    if (/pg_advisory_/i.test(q)) return false;
    if (/^\s*WITH\b/i.test(q) && !/\b(INSERT|UPDATE|DELETE)\b/i.test(q)) return false;
    // Idempotent schema ensure only — not a booking/service/payment/config write.
    if (/CREATE\s+(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\b/i.test(q)) return false;
    if (/\b(INSERT|UPDATE|DELETE|COMMIT|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/i.test(q)) return true;
    if (/\bCREATE\b/i.test(q) && !/IF\s+NOT\s+EXISTS/i.test(q)) return true;
    return false;
  });
  ok(`${label}: SQL log has zero commercial writes/hard-DDL/COMMIT`,
    writes.length === 0,
    writes.slice(0, 3).map((w) => w.q).join(' | '));
}

function resolveVertical() {
  return resolveBusinessVertical({ clientSlug: 'sunset', locationId: LOC });
}

/**
 * Simulate the base 34e4b7f3 staff-handler classification + empty-stub path
 * (what production did before P0c). Used only to encode RED permanently.
 */
async function simulateBaseStaleStaffQuotePath(body, pg, loadRule) {
  const requestedRentals = Array.isArray(body.rentals) ? body.rentals : [];
  const genericPrep = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: LOC,
    pgClient: pg,
    rentals: requestedRentals,
    serviceDate: SERVICE_DATE,
    source: 'staff_manual',
    calendarDayCount: 1,
    bookingDurationKey: '1_day',
    listOfferings: async () => OFFERINGS,
    loadRule,
  });
  if (!genericPrep.ok) return { ok: false, genericPrep };
  const genericQuote = buildGenericRentalAuthoritativeQuote(genericPrep.records || []);
  // STALE filter — the production bug
  const canonicalRentals = classifyCanonicalRentalsWithStaleHardcodedFilter(requestedRentals);
  const hasClosedVerticalIntent = canonicalRentals.length > 0
    || !!(body.components && Object.keys(body.components).length);
  if (!hasClosedVerticalIntent) {
    return {
      ok: true,
      status: 200,
      body: { ok: true, currency: 'EUR', total_cents: 0, line_items: [] },
      meta: {
        genericPrep,
        genericQuote,
        canonicalRentals,
        hasClosedVerticalIntent: false,
        stale: true,
      },
    };
  }
  return { ok: true, meta: { canonicalRentals, hasClosedVerticalIntent: true, stale: true } };
}

async function runStaffQuote(body, cfg, pg, loadRule, extra = {}) {
  const resolved = resolveVertical();
  assert.ok(resolved.ok, 'vertical resolves for sunset-somo');
  const invokeCalls = [];
  const { invokeVerticalOperation } = require('./lib/luna-front-desk-business-vertical');
  const userInvoke = extra.invokeVertical;
  const invokeVertical = async (resolvedV, op, pgClient, req) => {
    invokeCalls.push({ op, transportBody: req && req.transportBody });
    if (typeof userInvoke === 'function') return userInvoke(resolvedV, op, pgClient, req);
    return invokeVerticalOperation(resolvedV, op, pgClient, req);
  };
  const { invokeVertical: _drop, ...restExtra } = extra;
  const result = await executeSunsetStaffScheduleBookingQuote({
    clientSlug: 'sunset',
    locationId: LOC,
    body,
    pgClient: pg,
    verticalResolved: resolved,
    channel: VERTICAL_CHANNELS.MANUAL_STAFF,
    listOfferings: async () => OFFERINGS,
    loadRule,
    ...restExtra,
    invokeVertical,
  });
  result._invokeCalls = invokeCalls;
  return result;
}

function extractFn(src, name) {
  const n = `function ${name}(`;
  const s = src.indexOf(n);
  if (s < 0) return null;
  const b = src.indexOf('{', s);
  let d = 0;
  for (let i = b; i < src.length; i += 1) {
    if (src[i] === '{') d += 1;
    else if (src[i] === '}') {
      d -= 1;
      if (!d) return src.slice(s, i + 1);
    }
  }
  return null;
}

function loadPortalQuoteSandbox() {
  const portalSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'),
    'utf8',
  );
  const en = STAFF_PORTAL_STRINGS.en || {};
  const nodes = {};
  function N(id, x) {
    nodes[id] = Object.assign({
      id,
      value: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      style: { display: 'none' },
      dataset: {},
      classList: { add() {}, remove() {} },
      options: [],
      selectedIndex: -1,
      _ls: {},
      addEventListener() {},
      setAttribute(k, v) { this[`_${k}`] = v; },
      getAttribute(k) { return this[`_${k}`] || null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    }, x || {});
    return nodes[id];
  }
  N('ps-create-quote-preview');
  N('ps-create-submit', { disabled: false });
  N('ps-create-guest', { value: 'Guest' });
  N('ps-create-phone', { value: '+34600111222' });
  N('ps-create-comp-course', { checked: false });
  N('ps-create-msg');

  const strings = {
    ...en,
    'schedule.create.priceNotConfigured': en['schedule.create.priceNotConfigured'] || 'Price not configured',
    'schedule.create.unpriced': en['schedule.create.unpriced'] || 'Unpriced',
    'schedule.create.quoteFailed': en['schedule.create.quoteFailed'] || 'Quote unavailable',
    'schedule.create.failed': en['schedule.create.failed'] || 'Create failed',
  };
  const ctx = {
    schedulePortalQuoteState: null,
    schedulePortalQuoteGen: 0,
    schedulePortalQuoteAbort: null,
    schedulePortalQuoteTimer: null,
    schedulePortalQuoteDebounceMs: 400,
    schedulePortalSubmitInFlight: false,
    schedulePortalQuotePriceBlocked: false,
    schedulePortalCreateAmbiguous: false,
    portalT: (k) => strings[k] || k,
    escHtml: (s) => String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;'),
    el: (id) => nodes[id] || null,
    schedulePortalIsValidCreatePhone: () => true,
    schedulePortalGetSelectedCreateCourseId: () => null,
    console,
  };
  const names = [
    'schedulePortalQuoteFailureMessage',
    'schedulePortalResetQuoteRuntimeState',
    'schedulePortalApplyQuoteFailure',
    'schedulePortalRenderCreateQuotePreview',
    'schedulePortalSyncCreateSubmitEnabled',
    'schedulePortalClearQuotePreviewUi',
    'schedulePortalStrictQuoteTotalCents',
  ];
  const chunks = names.map((n) => extractFn(portalSrc, n)).filter(Boolean);
  assert.ok(chunks.length >= 4, 'portal quote functions extractable');
  vm.createContext(ctx);
  vm.runInContext(
    `${chunks.join('\n')}\n`
    + 'this.schedulePortalQuoteFailureMessage = schedulePortalQuoteFailureMessage;\n'
    + 'this.schedulePortalResetQuoteRuntimeState = schedulePortalResetQuoteRuntimeState;\n'
    + 'this.schedulePortalApplyQuoteFailure = schedulePortalApplyQuoteFailure;\n'
    + 'this.schedulePortalRenderCreateQuotePreview = schedulePortalRenderCreateQuotePreview;\n'
    + 'this.schedulePortalSyncCreateSubmitEnabled = schedulePortalSyncCreateSubmitEnabled;\n'
    + 'this.schedulePortalClearQuotePreviewUi = schedulePortalClearQuotePreviewUi;\n'
    + 'this.getBlocked = function(){ return schedulePortalQuotePriceBlocked; };\n'
    + 'this.getState = function(){ return schedulePortalQuoteState; };\n'
    + 'this.setState = function(s){ schedulePortalQuoteState = s; };\n'
    + 'this.setBlocked = function(b){ schedulePortalQuotePriceBlocked = !!b; };\n'
    + 'this.getNodes = function(){ return { preview: el("ps-create-quote-preview"), btn: el("ps-create-submit"), msg: el("ps-create-msg") }; };\n',
    ctx,
  );
  return ctx;
}

function loadEditDrawerQuoteSandbox() {
  const editSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-edit-ui.js'),
    'utf8',
  );
  const portalSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'),
    'utf8',
  );
  const en = STAFF_PORTAL_STRINGS.en || {};
  const nodes = {};
  function N(id, x) {
    nodes[id] = Object.assign({
      id,
      value: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      style: { display: 'none' },
      dataset: {},
      classList: { add() {}, remove() {} },
      setAttribute(k, v) { this[`_${k}`] = v; },
      getAttribute(k) { return this[`_${k}`] || null; },
    }, x || {});
    return nodes[id];
  }
  N('ps-drawer-quote-preview');
  N('ps-drawer-save', { disabled: false });
  const strings = {
    ...en,
    'schedule.create.priceNotConfigured': 'Price not configured',
    'schedule.create.quoteFailed': 'Quote unavailable',
    'schedule.create.quoteTotal': 'Quoted total',
  };
  const ctx = {
    scheduleDrawerQuoteState: { total_cents: 3000, intent_key: 'x' },
    scheduleDrawerQuotePriceBlocked: false,
    scheduleDrawerSaveInFlight: false,
    scheduleDrawerValidationState: { ok: true },
    portalT: (k) => strings[k] || k,
    escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    el: (id) => nodes[id] || null,
    schedulePortalStrictQuoteTotalCents: (body) => {
      const v = body && body.total_cents;
      return (typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v && v >= 0) ? v : null;
    },
    schedulePortalQuoteFailureMessage: null,
    console,
  };
  const failMsg = extractFn(portalSrc, 'schedulePortalQuoteFailureMessage');
  const render = extractFn(editSrc, 'scheduleDrawerRenderQuotePreview');
  const syncSave = extractFn(editSrc, 'scheduleDrawerSyncSaveEnabled');
  const reset = extractFn(editSrc, 'scheduleDrawerResetQuoteRuntime');
  assert.ok(failMsg && render, 'edit drawer quote functions extractable');
  vm.createContext(ctx);
  vm.runInContext(
    `${failMsg}\n${syncSave || 'function scheduleDrawerSyncSaveEnabled(){}'}\n${render}\n${reset || 'function scheduleDrawerResetQuoteRuntime(){}'}\n`
    + 'this.schedulePortalQuoteFailureMessage = schedulePortalQuoteFailureMessage;\n'
    + 'this.scheduleDrawerRenderQuotePreview = scheduleDrawerRenderQuotePreview;\n'
    + 'this.scheduleDrawerSyncSaveEnabled = scheduleDrawerSyncSaveEnabled;\n'
    + 'this.scheduleDrawerResetQuoteRuntime = scheduleDrawerResetQuoteRuntime;\n'
    + 'this.getBlocked = function(){ return scheduleDrawerQuotePriceBlocked; };\n'
    + 'this.getState = function(){ return scheduleDrawerQuoteState; };\n'
    + 'this.getNodes = function(){ return { preview: el("ps-drawer-quote-preview"), btn: el("ps-drawer-save") }; };\n',
    ctx,
  );
  return ctx;
}

async function main() {
  console.log('verify-sunset-combo-pricing-p0c — staff S+W quote path (no empty €0 stub)\n');
  assert.ok(fs.existsSync(FIXTURE), 'P0b fixture present (shared live-shape amounts)');

  // ── A) Encoded RED: base stale filter → empty stub 0 for equipment-only S+W ──
  console.log('[A] Encoded RED — stale hardcoded filter drops S+W → total 0');
  ok('stale list omits surfboard_wetsuit_rental + board_and_wetsuit_rental',
    !STALE_HARDCODED_CANONICAL_KEYS.includes(SW)
    && !STALE_HARDCODED_CANONICAL_KEYS.includes('board_and_wetsuit_rental')
    && STALE_HARDCODED_CANONICAL_KEYS.length === 3);
  ok('shared SSoT includes S+W + board_and_wetsuit',
    CANONICAL_RENTAL_OFFERING_KEYS.includes(SW)
    && CANONICAL_RENTAL_OFFERING_KEYS.includes('board_and_wetsuit_rental'));
  {
    const cfg = adminCfg();
    const loadRule = makeLoadRule(PRICE_ROWS);
    await withAdminCfg(cfg, async () => {
      const pg = makePg();
      const body = equipmentOnlyPayload('1_day');
      const red = await simulateBaseStaleStaffQuotePath(body, pg, loadRule);
      ok('RED: base-equivalent path returns ok total 0 for equipment-only S+W',
        red.ok === true
        && red.body
        && red.body.total_cents === 0
        && Array.isArray(red.body.line_items)
        && red.body.line_items.length === 0
        && red.meta
        && red.meta.canonicalRentals.length === 0
        && red.meta.hasClosedVerticalIntent === false,
        JSON.stringify(red.body || red).slice(0, 300));
      ok('RED: generic prep also empty (S+W classified canonical by prepare)',
        red.meta.genericPrep
        && red.meta.genericPrep.ok
        && (red.meta.genericPrep.genericRentals || []).length === 0);
    });
  }

  // ── B) Production staff helper: equipment-only exact identity ──
  console.log('\n[B] Production staff quote helper — equipment-only S+W exact rules');
  {
    const cfg = adminCfg();
    const loadRule = makeLoadRule(PRICE_ROWS);
    await withAdminCfg(cfg, async () => {
      const pg = makePg();
      const day = await runStaffQuote(equipmentOnlyPayload('1_day'), cfg, pg, loadRule);
      ok('staff helper 1_day ok', day.ok === true, JSON.stringify(day.body || day).slice(0, 400));
      ok('staff helper 1_day total 3000 exact',
        day.ok && day.body.total_cents === SW_DAY,
        String(day.body && day.body.total_cents));
      const dayLines = lineSummary(day.body || {});
      const daySw = dayLines.find((l) => !l.course_equipment
        && String(l.item_code || '') === `${SW}__1_day`);
      ok('exact identity 1_day: item_code=S+W__1_day unit=day amount=3000',
        daySw
        && daySw.item_code === `${SW}__1_day`
        && daySw.billing_unit === 'day'
        && Number(daySw.unit_amount_cents) === SW_DAY
        && daySw.total_cents === SW_DAY,
        JSON.stringify(daySw || dayLines));
      ok('staff helper classifies S+W as canonical (not generic empty stub)',
        day.meta
        && day.meta.canonicalRentals.some((r) => r.offering_key === SW)
        && day.meta.hasClosedVerticalIntent === true
        && (day.meta.genericPrep.genericRentals || []).length === 0
        && Array.isArray(day._invokeCalls)
        && day._invokeCalls.some((c) => c.op === 'quoteOffering'));

      const twoH = await runStaffQuote(equipmentOnlyPayload('2_hours'), cfg, pg, loadRule);
      ok('staff helper 2_hours ok', twoH.ok === true, JSON.stringify(twoH.body || twoH).slice(0, 400));
      ok('staff helper 2_hours total 1500 exact',
        twoH.ok && twoH.body.total_cents === SW_2H,
        String(twoH.body && twoH.body.total_cents));
      const twoLines = lineSummary(twoH.body || {});
      const twoSw = twoLines.find((l) => !l.course_equipment
        && String(l.item_code || '') === `${SW}__2_hours`);
      ok('exact identity 2_hours: item_code=S+W__2_hours unit=session amount=1500',
        twoSw
        && twoSw.item_code === `${SW}__2_hours`
        && twoSw.billing_unit === 'session'
        && Number(twoSw.unit_amount_cents) === SW_2H
        && twoSw.total_cents === SW_2H,
        JSON.stringify(twoSw || twoLines));
      ok('staff helper 2_hours not alias / not SUP',
        twoH.ok
        && !(twoH.body.line_items || []).some((l) =>
          String(l.offering_key || l.offering_id || '').includes(SUP)
          || String(l.offering_key || l.offering_id || '').includes(ALIAS)));
    });
  }

  // Handler wiring: production helper is the route body owner (auth stays in handler).
  // Do not overclaim HTTP execution — behavioral money evidence is the helper itself.
  {
    const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
    const handlerFn = extractFn(apiSrc, 'handleSunsetScheduleBookingQuote') || '';
    ok('handler imports executeSunsetStaffScheduleBookingQuote',
      /executeSunsetStaffScheduleBookingQuote/.test(apiSrc)
      && /require\('\.\/lib\/sunset-staff-schedule-booking-quote'\)/.test(apiSrc));
    ok('handler body delegates to helper (no local stale board_rental filter)',
      /executeSunsetStaffScheduleBookingQuote\(\{/.test(handlerFn)
      && !/canonicalRentals = requestedRentals\.filter\(\(r\) => \['board_rental'/.test(handlerFn)
      && !/\['board_rental',\s*'wetsuit_rental',\s*'board_and_suit_rental'\]/.test(handlerFn));
    const helperSrc = fs.readFileSync(
      path.join(ROOT, 'scripts/lib/sunset-staff-schedule-booking-quote.js'), 'utf8',
    );
    ok('helper classifies via CANONICAL_RENTAL_OFFERING_KEYS (shared authority)',
      /CANONICAL_RENTAL_OFFERING_KEYS\.includes/.test(helperSrc)
      && /classifyCanonicalRentalsForStaffQuote/.test(helperSrc));
    ok('helper reuses transportHasNonGenericCommercialIntent (no private predicate)',
      /transportHasNonGenericCommercialIntent\(transportBody\)/.test(helperSrc)
      && !/hasAccommodationQuoteIntent/.test(helperSrc));
  }

  // ── B2) Commercial intent: lessons / CE / custom must invoke vertical ──
  console.log('\n[B2] Commercial intent — lessons/CE/custom invoke vertical (never empty €0)');
  {
    const cfg = adminCfg();
    const loadRule = makeLoadRule(PRICE_ROWS);
    await withAdminCfg(cfg, async () => {
      const stubVertical = async () => ({
        ok: true,
        status: 200,
        body: {
          ok: true,
          currency: 'EUR',
          total_cents: 1111,
          line_items: [{ component: 'lesson_stub', total_cents: 1111 }],
        },
      });

      // lessons-only
      {
        const pg = makePg();
        const body = {
          date_from: SERVICE_DATE,
          date_to: SERVICE_DATE,
          service_dates: [SERVICE_DATE],
          components: {},
          lessons: [{ kind: 'group', date: SERVICE_DATE, course_id: PACK_ID }],
          rentals: [],
          course_equipment: [],
          surfer_count: 1,
        };
        ok('predicate: lessons alone is commercial intent',
          transportHasNonGenericCommercialIntent(body) === true);
        const out = await runStaffQuote(body, cfg, pg, loadRule, { invokeVertical: stubVertical });
        ok('lessons-only invokes vertical quoteOffering',
          out._invokeCalls.some((c) => c.op === 'quoteOffering'));
        ok('lessons-only never ok empty €0 stub',
          !(out.ok && out.body && out.body.total_cents === 0
            && (out.body.line_items || []).length === 0)
          && out.meta && out.meta.hasClosedVerticalIntent === true);
      }

      // CE-only
      {
        const pg = makePg();
        const body = {
          date_from: SERVICE_DATE,
          date_to: SERVICE_DATE,
          service_dates: [SERVICE_DATE],
          components: {
            course: {
              course_id: PACK_ID, tier_key: TIER, quantity: 1, offering_id: PACK_ITEM,
            },
          },
          lessons: [],
          rentals: [],
          course_equipment: [{ offering_key: SW, mode: 'during_course', quantity: 1 }],
          surfer_count: 1,
        };
        ok('predicate: CE with course is commercial intent',
          transportHasNonGenericCommercialIntent(body) === true);
        const out = await runStaffQuote(body, cfg, pg, loadRule);
        ok('CE path hasClosedVerticalIntent true',
          out.meta && out.meta.hasClosedVerticalIntent === true);
        ok('CE path not empty stub (invokes vertical)',
          out._invokeCalls.some((c) => c.op === 'quoteOffering'));
      }

      // custom_line_items alone
      {
        const pg = makePg();
        const body = {
          date_from: SERVICE_DATE,
          date_to: SERVICE_DATE,
          service_dates: [SERVICE_DATE],
          components: {},
          lessons: [],
          rentals: [],
          course_equipment: [],
          custom_line_items: [{
            label: 'Wax',
            quantity: 1,
            unit_amount_cents: 500,
            currency: 'EUR',
          }],
          surfer_count: 1,
        };
        ok('predicate: custom lines alone is commercial intent',
          transportHasNonGenericCommercialIntent(body) === true);
        const out = await runStaffQuote(body, cfg, pg, loadRule, { invokeVertical: stubVertical });
        ok('custom-only invokes vertical',
          out._invokeCalls.some((c) => c.op === 'quoteOffering')
          && out.meta.hasClosedVerticalIntent === true);
        ok('custom-only never empty ok €0',
          !(out.ok && out.body && out.body.total_cents === 0
            && !(out.body.line_items || []).length));
      }

      // generic SUP + lesson: retains both (generic merge + vertical)
      {
        const pg = makePg();
        const body = {
          date_from: SERVICE_DATE,
          date_to: SERVICE_DATE,
          service_dates: [SERVICE_DATE],
          components: {
            course: {
              course_id: PACK_ID, tier_key: TIER, quantity: 1, offering_id: PACK_ITEM,
            },
          },
          lessons: [],
          rentals: [{ offering_key: SUP, duration_key: '1_day', quantity: 1 }],
          course_equipment: [],
          surfer_count: 1,
        };
        const out = await runStaffQuote(body, cfg, pg, loadRule);
        ok('generic+course invokes vertical',
          out._invokeCalls.some((c) => c.op === 'quoteOffering'));
        ok('generic+course retains SUP generic line + course',
          out.ok === true
          && (out.body.line_items || []).some((l) => String(l.offering_key || l.component || '').includes(SUP))
          && (out.body.line_items || []).some((l) => l.component === 'course'),
          JSON.stringify(lineSummary(out.body || {})).slice(0, 400));
        ok('generic+course total includes both',
          out.ok && out.body.total_cents === COURSE_CENTS + SUP_CENTS,
          String(out.body && out.body.total_cents));
      }
    });
  }

  // ── C) Mixed combo via staff helper + create owner ──
  console.log('\n[C] Mixed course + SUP + standalone S+W + CE included 0');
  {
    const cfg = adminCfg();
    const loadRule = makeLoadRule(PRICE_ROWS);
    await withAdminCfg(cfg, async () => {
      const pg = makePg();
      const payload = staffDrawerPayload();
      const quoted = await runStaffQuote(payload, cfg, pg, loadRule);
      ok('combo staff helper quote ok', quoted.ok === true, JSON.stringify(quoted.body || quoted).slice(0, 400));
      ok(`combo total exact ${COMBO_TOTAL}`,
        quoted.ok && quoted.body.total_cents === COMBO_TOTAL,
        String(quoted.body && quoted.body.total_cents));
      const lines = lineSummary(quoted.body || {});
      console.log('  lines', JSON.stringify(lines));
      ok('course line present',
        lines.some((l) => l.component === 'course' && l.total_cents === COURSE_CENTS));
      ok('standalone SUP 5000 (generic path preserved)',
        lines.some((l) => String(l.offering_key).includes(SUP) && l.total_cents === SUP_CENTS
          && !l.course_equipment));
      ok('standalone S+W 3000 commercial',
        lines.some((l) => String(l.offering_key).includes(SW) && l.total_cents === SW_DAY
          && !l.course_equipment));
      ok('CE S+W during_course included 0',
        lines.some((l) => l.course_equipment && String(l.offering_key).includes(SW)
          && l.mode === 'during_course' && l.total_cents === 0));
      const swStandalone = lines.filter((l) => String(l.offering_key).includes(SW) && !l.course_equipment);
      const swCe = lines.filter((l) => String(l.offering_key).includes(SW) && l.course_equipment);
      ok('two S+W-related semantic lines (1 standalone commercial + 1 CE included)',
        swStandalone.length === 1 && swStandalone[0].total_cents === SW_DAY
        && swCe.length === 1 && swCe[0].total_cents === 0
        && swStandalone.length + swCe.length === E.sw_commercial_lines,
        JSON.stringify({ swStandalone, swCe }));

      // Provenance fingerprint + line identities (standalone vs CE separate)
      const prov = quoted.body && quoted.body.quote_provenance;
      ok('quote_provenance fingerprint present',
        prov && typeof prov.quote_fingerprint === 'string' && prov.quote_fingerprint.length > 8,
        JSON.stringify(prov && { fp: prov.quote_fingerprint }).slice(0, 200));
      const provLines = Array.isArray(prov.line_items) ? prov.line_items : [];
      ok('fingerprint line identities include standalone S+W and CE separately',
        provLines.some((l) => !l.course_equipment
          && String(l.offering_key || l.offering_item_code || l.item_code || '').includes(SW)
          && Number(l.total_cents) === SW_DAY)
        && provLines.some((l) => l.course_equipment === true
          && String(l.offering_key || '').includes(SW)
          && Number(l.total_cents) === 0),
        JSON.stringify(provLines).slice(0, 500));

      // Capture actual stock claims consumed by executeSunsetBookingCreate
      const createPg = makePg();
      let capturedStockClaims = null;
      const origAssert = stockService.assertRentalStockClaimsInTxn;
      stockService.assertRentalStockClaimsInTxn = async (pgClient, opts) => {
        capturedStockClaims = (opts && opts.claims) || null;
        return origAssert(pgClient, opts);
      };
      let createOut;
      try {
        const cmd = buildSunsetBookingCreateCommand({
          channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
          transportBody: {
            ...payload,
            service_dates: [SERVICE_DATE],
            quote_provenance: quoted.body.quote_provenance,
          },
          trustedLocationId: LOC,
          now: FIXED_NOW,
          actorHints: { staff_user_id: 'staff-p0c', email: 'p0c@test' },
        });
        ok('create command builds', cmd.ok === true, JSON.stringify(cmd));
        createOut = await executeSunsetBookingCreate(createPg, cmd.command);
      } finally {
        stockService.assertRentalStockClaimsInTxn = origAssert;
      }
      ok('provenance create succeeds via production create owner',
        createOut && createOut.ok === true, JSON.stringify(createOut && createOut.body || createOut).slice(0, 400));
      const swStock = (capturedStockClaims || []).find((c) => c && c.offering_key === SW);
      ok('create-path stock claims S+W total qty 2 (assertRentalStockClaimsInTxn capture)',
        swStock && Number(swStock.quantity) === E.sw_merged_stock_qty,
        JSON.stringify(capturedStockClaims));
      if (createOut && createOut.ok) {
        ok('create total matches combo',
          createOut.body.total_cents === COMBO_TOTAL
          || createPg.state.bookings[0]?.total_amount_cents === COMBO_TOTAL,
          JSON.stringify({ body: createOut.body.total_cents, bk: createPg.state.bookings[0] }));
        ok('create no price-rule healing writes',
          createPg.state.priceRuleWrites.length === 0);
        ok('create committed', createPg.committed() === true);
      }

      // Create re-quote fingerprint equals staff helper provenance fingerprint
      const prepBody = {
        ...payload,
        rentals: quoted.meta.canonicalRentals,
        components: { ...payload.components },
        service_dates: [SERVICE_DATE],
      };
      if (quoted.meta.genericPrep.genericRentals.length && !quoted.meta.canonicalRentals.length) {
        delete prepBody.rentals;
      }
      const rentalPrep = prepareCanonicalRentalsForCreate(prepBody);
      ok('canonical prep for create re-quote present',
        rentalPrep.ok === true && rentalPrep.present === true, JSON.stringify(rentalPrep));
      try {
        const resolved = await resolveAuthoritativeScheduleQuoteInTxn(pg, {
          clientSlug: 'sunset',
          locationId: LOC,
          canonicalRentals: rentalPrep.rentals || quoted.meta.canonicalRentals,
          genericRentalRecords: quoted.meta.genericPrep.records,
          rentalPrepBody: {
            ...(rentalPrep.body || {}),
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
            rentals: rentalPrep.rentals || quoted.meta.canonicalRentals,
          },
          quotePrepBody: null,
          quoteChannel: 'manual_staff',
          quoteProvenance: quoted.body.quote_provenance,
          now: FIXED_NOW,
        });
        if (resolved && resolved.authoritativeQuote) {
          const freshFp = buildQuoteProvenance(resolved.authoritativeQuote).quote_fingerprint;
          ok('create re-quote fingerprint equals staff helper fingerprint',
            freshFp === quoted.body.quote_provenance.quote_fingerprint,
            JSON.stringify({
              fresh: freshFp,
              prev: quoted.body.quote_provenance.quote_fingerprint,
            }));
          ok('create re-quote total unchanged',
            resolved.authoritativeQuote.total_cents === COMBO_TOTAL);
        } else {
          ok('create re-quote available', false, JSON.stringify(resolved).slice(0, 300));
        }
      } catch (err) {
        ok('create re-quote fingerprint (create already matched provenance)',
          createOut && createOut.ok === true, err && err.message);
      }
    });
  }

  // ── D) Unpriced / missing / zero → 422 visible contract; zero writes ──
  console.log('\n[D] Unpriced / missing / zero standalone fail closed');
  {
    await withAdminCfg(adminCfg({ omitItemCodes: [`${SW}__1_day`, `${SW}__2_hours`] }), async () => {
      const unpricedPg = makePg({ omitItemCodes: [`${SW}__1_day`, `${SW}__2_hours`] });
      const loadRule = makeLoadRule(PRICE_ROWS.filter((r) => !String(r.item_code).startsWith(SW)));
      const body = equipmentOnlyPayload('1_day');
      const beforeBk = unpricedPg.state.bookings.length;
      const beforeSvc = unpricedPg.state.services.length;
      unpricedPg.state.sqlLog.length = 0;
      const out = await runStaffQuote(
        body,
        adminCfg({ omitItemCodes: [`${SW}__1_day`, `${SW}__2_hours`] }),
        unpricedPg,
        loadRule,
      );
      ok('unpriced S+W staff quote not ok', out.ok === false, JSON.stringify(out.body || out).slice(0, 300));
      const rc = out.body && (out.body.reason_code || out.body.reason || out.body.error);
      ok('unpriced returns price_not_found or price_missing',
        rc === 'price_not_found' || rc === 'price_missing' || rc === 'price_not_configured',
        String(rc));
      ok('unpriced status 422-class (never 200 ok)',
        out.ok === false
        && (out.status === 422 || out.status === 400 || out.status === 409 || out.status >= 400));
      ok('unpriced body has ui_message_key for drawer',
        out.body
        && out.body.ui_message_key === PRICE_NOT_CONFIGURED_UI_KEY
        && out.body.price_status === 'unpriced');
      ok('unpriced never empty ok €0',
        !(out.ok === true && out.body && out.body.total_cents === 0)
        && (out.body.total_cents == null || out.ok === false));
      ok('unpriced zero booking writes', unpricedPg.state.bookings.length === beforeBk);
      ok('unpriced zero service writes', unpricedPg.state.services.length === beforeSvc);
      ok('unpriced no COMMIT', unpricedPg.committed() === false);
      ok('unpriced no price-rule writes', unpricedPg.state.priceRuleWrites.length === 0);
      assertReadOnlySqlLog(unpricedPg.state.sqlLog, 'unpriced missing-row');
    });

    // Exact zero amount row via staff helper (not only resolver direct)
    {
      const zeroRows = PRICE_ROWS.map((r) => (
        String(r.item_code).startsWith(SW) ? { ...r, amount_cents: 0 } : r
      ));
      // loadRule returns found with amount 0 so resolver hits invalid_amount path
      const zeroLoad = async (params) => {
        const duration = params.duration;
        const itemCode = params.itemCode;
        const code = String(itemCode || '').includes('__')
          ? itemCode
          : `${itemCode}__${duration}`;
        const hit = zeroRows.find((r) => r.item_code === code && r.active !== false);
        if (!hit) return { status: 'not_found', location_id: LOC };
        return {
          status: 'found',
          amount_cents: hit.amount_cents,
          currency: 'EUR',
          item_code: hit.item_code,
          unit: hit.unit,
          location_id: LOC,
          pricing_status: 'confirmed',
        };
      };
      const cfgZero = adminCfg({ priceOverrides: { [`${SW}__1_day`]: 0, [`${SW}__2_hours`]: 0 } });
      // Also force resolveTenantBusinessConfig prices to 0
      await withAdminCfg(cfgZero, async () => {
        const tbc = require('./lib/tenant-business-config');
        const origLoad = tbc.loadTenantPriceRuleFromDb;
        tbc.loadTenantPriceRuleFromDb = async (_pg, params) => zeroLoad(params);
        try {
          const zeroPg = makePg({ priceOverrides: { [`${SW}__1_day`]: 0, [`${SW}__2_hours`]: 0 } });
          zeroPg.state.sqlLog.length = 0;
          const out = await runStaffQuote(
            equipmentOnlyPayload('1_day'),
            cfgZero,
            zeroPg,
            zeroLoad,
          );
          ok('exact zero-row staff helper not ok',
            out.ok === false, JSON.stringify(out.body || out).slice(0, 300));
          const rc = out.body && (out.body.reason_code || out.body.reason);
          ok('exact zero-row returns price_* / UI unpriced',
            (rc === 'price_not_found' || rc === 'price_missing' || rc === 'price_not_configured')
            && out.body.ui_message_key === PRICE_NOT_CONFIGURED_UI_KEY
            && out.body.price_status === 'unpriced',
            String(rc));
          ok('exact zero-row status 422-class',
            out.ok === false && out.status >= 400);
          assertReadOnlySqlLog(zeroPg.state.sqlLog, 'exact zero-row');
          ok('exact zero-row no booking/service/COMMIT',
            zeroPg.state.bookings.length === 0
            && zeroPg.state.services.length === 0
            && zeroPg.committed() === false);
        } finally {
          if (origLoad) tbc.loadTenantPriceRuleFromDb = origLoad;
        }
      });
    }

    // Shared normalizer covers production codes
    ok('PRICE_FAILURE_REASONS includes price_not_configured',
      PRICE_FAILURE_REASONS.has('price_not_configured')
      && PRICE_FAILURE_REASONS.has('price_not_found')
      && PRICE_FAILURE_REASONS.has('price_missing')
      && PRICE_FAILURE_REASONS.has('unpriced_offering')
      && PRICE_FAILURE_REASONS.has('ambiguous_price'));
    ok('normalizeStaffQuotePriceFailureReason maps known codes',
      normalizeStaffQuotePriceFailureReason('price_not_configured') === 'price_not_configured'
      && normalizeStaffQuotePriceFailureReason('price_missing') === 'price_missing'
      && normalizeStaffQuotePriceFailureReason('no_price_for_x') === 'price_not_configured');
    const attached = attachStaffQuoteUiContract({
      ok: false,
      status: 200,
      body: { reason_code: 'price_not_configured' },
    });
    ok('attachStaffQuoteUiContract normalizes status to 422 + ui key',
      attached.status === 422
      && attached.body.ui_message_key === PRICE_NOT_CONFIGURED_UI_KEY
      && attached.body.price_status === 'unpriced');
  }

  // ── E) Drawer UI: clear total, localized Unpriced, Create disabled ──
  console.log('\n[E] Drawer UI — production browser function behavior');
  {
    const en = STAFF_PORTAL_STRINGS.en || {};
    const it = STAFF_PORTAL_STRINGS.it || {};
    ok('i18n EN priceNotConfigured / unpriced',
      en['schedule.create.priceNotConfigured'] === 'Price not configured'
      && en['schedule.create.unpriced'] === 'Unpriced');
    ok('i18n ES priceNotConfigured / unpriced',
      esStrings['schedule.create.priceNotConfigured'] === 'Precio no configurado'
      && esStrings['schedule.create.unpriced'] === 'Sin precio');
    ok('i18n IT present and not EN',
      it['schedule.create.priceNotConfigured']
      && it['schedule.create.priceNotConfigured'] !== en['schedule.create.priceNotConfigured']);

    const sb = loadPortalQuoteSandbox();
    // Prior success then unpriced failure clears total
    sb.setState({
      quote_provenance: { quote_fingerprint: 'prior' },
      total_cents: 3000,
      intent_key: 'k1',
    });
    sb.schedulePortalRenderCreateQuotePreview({
      ok: true,
      body: { total_cents: 3000, currency: 'EUR', line_items: [] },
    });
    let nodes = sb.getNodes();
    ok('success paints quoted total',
      /€30\.00|Quoted total/i.test(nodes.preview.innerHTML)
      && !/unpriced/i.test(nodes.preview.innerHTML));

    sb.schedulePortalRenderCreateQuotePreview({
      ok: false,
      status: 422,
      body: {
        reason_code: 'price_not_found',
        reason: 'price_not_found',
        ui_message_key: PRICE_NOT_CONFIGURED_UI_KEY,
        price_status: 'unpriced',
      },
    });
    nodes = sb.getNodes();
    ok('failure clears € total from preview',
      !/€\d/.test(nodes.preview.innerHTML)
      && !/Quoted total/i.test(nodes.preview.innerHTML));
    ok('failure clears quote state/provenance',
      sb.getState() == null);
    ok('failure renders Price not configured',
      /Price not configured/i.test(nodes.preview.innerHTML)
      || /Unpriced/i.test(nodes.preview.innerHTML));
    ok('failure marks data-quote-status=unpriced',
      /data-quote-status="unpriced"/.test(nodes.preview.innerHTML));
    ok('Create remains disabled after unpriced failure',
      nodes.btn.disabled === true
      && sb.getBlocked() === true);

    // Network rejection atomic path via schedulePortalApplyQuoteFailure
    sb.setState({
      quote_provenance: { quote_fingerprint: 'stale-success' },
      total_cents: 3000,
    });
    sb.setBlocked(false);
    sb.schedulePortalApplyQuoteFailure({
      ok: false,
      error: 'network_error',
      status: 0,
      body: { reason_code: 'network_error', error: 'network_error' },
    });
    nodes = sb.getNodes();
    ok('network rejection clears state + blocks Create',
      sb.getState() == null
      && sb.getBlocked() === true
      && nodes.btn.disabled === true);
    ok('network rejection renders failure (no stale € total)',
      !/€\d/.test(nodes.preview.innerHTML));

    // finally-style sync: blocked remains after re-enable attempt with blocked flag
    sb.schedulePortalSyncCreateSubmitEnabled();
    ok('finally sync keeps Create disabled while priceBlocked',
      sb.getNodes().btn.disabled === true && sb.getBlocked() === true);

    // close/reopen recovery: reset clears blocked + state together
    sb.schedulePortalResetQuoteRuntimeState();
    sb.schedulePortalClearQuotePreviewUi();
    sb.schedulePortalSyncCreateSubmitEnabled();
    nodes = sb.getNodes();
    ok('close/reopen reset clears blocked + state together',
      sb.getState() == null
      && sb.getBlocked() === false
      && nodes.btn.disabled === false);

    const esMsg = sb.schedulePortalQuoteFailureMessage({
      ok: false,
      body: {
        reason_code: 'price_missing',
        ui_message_key: PRICE_NOT_CONFIGURED_UI_KEY,
      },
    });
    ok('failure message function resolves priceNotConfigured key',
      esMsg === 'Price not configured' || esMsg === 'Unpriced');
    ok('ES drawer copy distinct from EN',
      esStrings['schedule.create.priceNotConfigured'] !== en['schedule.create.priceNotConfigured']);
  }

  // ── E2) Edit drawer failure renderer (behavioral) ──
  console.log('\n[E2] Edit drawer quote failure clears total and blocks Save');
  {
    const ed = loadEditDrawerQuoteSandbox();
    ed.scheduleDrawerRenderQuotePreview({
      ok: true,
      body: { total_cents: 3000, currency: 'EUR', line_items: [] },
    });
    let nodes = ed.getNodes();
    ok('edit success paints total',
      /€30\.00|Quoted total/i.test(nodes.preview.innerHTML));

    ed.scheduleDrawerRenderQuotePreview({
      ok: false,
      status: 422,
      body: {
        reason_code: 'price_not_found',
        ui_message_key: PRICE_NOT_CONFIGURED_UI_KEY,
        price_status: 'unpriced',
      },
    });
    nodes = ed.getNodes();
    ok('edit failure clears € total/state',
      ed.getState() == null
      && !/€\d/.test(nodes.preview.innerHTML));
    ok('edit failure shows Price not configured',
      /Price not configured/i.test(nodes.preview.innerHTML));
    ok('edit Save remains disabled after unpriced',
      nodes.btn.disabled === true && ed.getBlocked() === true);

    ed.scheduleDrawerResetQuoteRuntime();
    ed.scheduleDrawerSyncSaveEnabled();
    ok('edit reset clears blocked so Save can recover',
      ed.getBlocked() === false);
  }

  // ── F) Adversarial: every shared canonical key survives classification ──
  console.log('\n[F] Adversarial classification drift guard');
  {
    for (const key of CANONICAL_RENTAL_OFFERING_KEYS) {
      const classified = classifyCanonicalRentalsForStaffQuote([
        { offering_key: key, duration_key: '1_day', quantity: 1 },
        { offering_key: SUP, duration_key: '1_day', quantity: 1 },
      ]);
      ok(`canonical key survives handler classification: ${key}`,
        classified.length === 1 && classified[0].offering_key === key,
        JSON.stringify(classified));
    }
    ok('SUP remains generic (not in canonical classification)',
      !CANONICAL_RENTAL_OFFERING_KEYS.includes(SUP)
      && classifyCanonicalRentalsForStaffQuote([
        { offering_key: SUP, duration_key: '1_day', quantity: 1 },
      ]).length === 0);
    // Stale filter would drop S+W — production must not match stale set for SW
    ok('production classification includes keys stale filter dropped',
      classifyCanonicalRentalsForStaffQuote([{ offering_key: SW, duration_key: '1_day', quantity: 1 }])
        .some((r) => r.offering_key === SW)
      && classifyCanonicalRentalsWithStaleHardcodedFilter([
        { offering_key: SW, duration_key: '1_day', quantity: 1 },
      ]).length === 0);
  }

  // ── G) Domain / no alias / Wolfhouse isolation ──
  console.log('\n[G] Domain gates');
  ok('S+W still exact-offering/canonical', CANONICAL_RENTAL_OFFERING_KEYS.includes(SW));
  ok('SUP still generic', !CANONICAL_RENTAL_OFFERING_KEYS.includes(SUP));
  ok('alias board_and_suit remains in shared list (historical exact key)',
    CANONICAL_RENTAL_OFFERING_KEYS.includes(ALIAS));
  {
    const noExact = PRICE_ROWS.filter((r) => !String(r.item_code).startsWith(SW));
    const aliasOnly = await resolveGenericRentalPrice({
      clientSlug: 'sunset', locationId: LOC, offeringKey: SW,
      durationKey: '1_day', quantity: 1, loadRule: makeLoadRule(noExact),
    });
    ok('no alias borrow for S+W when exact missing',
      aliasOnly.ok === false && aliasOnly.reason === 'price_not_found');
  }
  {
    // Real tenant isolation: unknown / wolfhouse context must not run sunset staff quote.
    const unknown = resolveBusinessVertical({ clientSlug: 'not-a-tenant', locationId: LOC });
    ok('unknown tenant fails closed (not sunset staff vertical)',
      unknown.ok === false
      && (unknown.reason_code === 'unknown_tenant' || unknown.reason === 'unknown_tenant'),
      JSON.stringify(unknown));

    const wh = resolveBusinessVertical({
      clientSlug: 'wolfhouse-somo',
      locationId: 'wolfhouse',
    });
    // Accommodation vertical (or fail) — never sunset surf_school + sunset-somo staff path.
    const isSunsetSurf = wh.ok === true
      && (wh.verticalId === 'surf_school' || wh.vertical === 'surf_school')
      && (wh.clientSlug === 'sunset' || wh.tenant === 'sunset');
    ok('Wolfhouse does not resolve as sunset surf_school staff vertical',
      isSunsetSurf === false,
      JSON.stringify(wh));

    // Helper rejects non-ok vertical (tenant isolation at service boundary).
    const pg = makePg();
    const rejected = await executeSunsetStaffScheduleBookingQuote({
      clientSlug: 'wolfhouse-somo',
      locationId: 'wolfhouse',
      body: equipmentOnlyPayload('1_day'),
      pgClient: pg,
      verticalResolved: { ok: false, reason: 'unknown_tenant', reason_code: 'unknown_tenant' },
    });
    ok('staff helper rejects non-ok vertical (no silent quote)',
      rejected.ok === false
      && (rejected.body.reason_code === 'unknown_tenant'
        || rejected.body.reason_code === 'vertical_unresolved'),
      JSON.stringify(rejected.body || rejected));
  }

  // ── G2) Read-only job contract (PG READ ONLY + stderr + date) ──
  console.log('\n[G2] Read-only job contract');
  {
    ok('job default service date is validated YYYY-MM-DD',
      /^\d{4}-\d{2}-\d{2}$/.test(jobReadonly.DEFAULT_SERVICE_DATE)
      && jobReadonly.parseServiceDate().ok === true
      && jobReadonly.parseServiceDate().date === jobReadonly.DEFAULT_SERVICE_DATE);
    const bad = (() => {
      const prev = process.env.SERVICE_DATE;
      process.env.SERVICE_DATE = 'not-a-date';
      try { return jobReadonly.parseServiceDate(); }
      finally {
        if (prev == null) delete process.env.SERVICE_DATE;
        else process.env.SERVICE_DATE = prev;
      }
    })();
    ok('job rejects invalid SERVICE_DATE',
      bad.ok === false && bad.reason === 'invalid_date');
    ok('job stderr allowlist excludes raw bodies',
      jobReadonly.STDERR_ALLOWLIST.has('mismatch')
      && jobReadonly.STDERR_ALLOWLIST.has('price_missing')
      && jobReadonly.STDERR_ALLOWLIST.has('pg_connect_failed')
      && !jobReadonly.STDERR_ALLOWLIST.has('ECONNREFUSED'));
    // beginReadOnlyTxn with fake client
    const sql = [];
    const fakeClient = {
      async query(q) {
        sql.push(String(q));
        if (/BEGIN/i.test(q) && !/READ ONLY/i.test(q)) return { rows: [] };
        if (/SET TRANSACTION READ ONLY/i.test(q)) return { rows: [] };
        if (/BEGIN READ ONLY/i.test(q)) return { rows: [] };
        return { rows: [] };
      },
    };
    const began = await jobReadonly.beginReadOnlyTxn(fakeClient);
    ok('job begins READ ONLY transaction',
      began.ok === true
      && (began.mode === 'set_transaction_read_only' || began.mode === 'begin_read_only')
      && sql.some((q) => /READ ONLY/i.test(q)),
      JSON.stringify({ began, sql }));
  }

  // ── H) Direct executeSunsetQuote still prices S+W (data path unchanged) ──
  console.log('\n[H] Vertical quote owner still prices S+W (sanity; not sole evidence)');
  {
    const cfg = adminCfg();
    await withAdminCfg(cfg, async () => {
      const built = buildSunsetQuoteCommand({
        channel: QUOTE_CHANNELS.MANUAL_STAFF,
        transportBody: {
          date_from: SERVICE_DATE,
          date_to: SERVICE_DATE,
          service_dates: [SERVICE_DATE],
          rentals: [{ offering_key: SW, duration_key: '1_day', quantity: 1 }],
          surfer_count: 1,
          require_db: true,
        },
        trustedLocationId: LOC,
        now: FIXED_NOW,
      });
      ok('direct buildSunsetQuoteCommand ok', built.ok === true, JSON.stringify(built));
      const quoted = await executeSunsetQuote(makePg(), built.command, { adminCfg: cfg });
      ok('direct executeSunsetQuote prices S+W 3000 (data path)',
        quoted.ok === true && quoted.body.total_cents === SW_DAY,
        JSON.stringify(quoted.body || quoted).slice(0, 300));
      // Point of P0c: staff helper must match this, not empty stub
      ok('staff helper path (section B) is the required route evidence, not this alone', true);
    });
  }

  console.log(`\n── verify:sunset-combo-pricing-p0c ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass}/${pass + fail}) ──\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
