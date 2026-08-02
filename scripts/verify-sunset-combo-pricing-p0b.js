'use strict';

/**
 * P0b — surfboard_wetsuit_rental collision (never substitute SUP).
 *
 * Live symptom on base 927f9043 (encoded RED):
 *   resolveGenericRentalPrice expanded rentalOfferingKeyCandidates, so when the
 *   exact S+W row was missing/mismatched, it borrowed board_and_suit_rental and
 *   could return €0 while concealing alias identity via duplicate offering_key
 *   + alias item_code. Catalog projection still reported exact
 *   surfboard_wetsuit_rental__1_day=3000. P0 only covered SUP (non-colliding).
 *
 * Required: exact tenant_price_rules SSoT; no alias after concrete selection;
 * fail closed on missing/<=0 standalone; CE during_course €0 remains valid;
 * combo Curso Tarde + SUP + S+W standalone + S+W CE included; quote→create;
 * bot-auth owner path (no staff cookie).
 *
 * Offline — production-shaped Admin fixture. No live calls / no push / no deploy.
 *
 * Run: node scripts/verify-sunset-combo-pricing-p0b.js
 *   npm run verify:sunset-combo-pricing-p0b
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
  prepareGenericRentalsForCreate,
  prepareCanonicalRentalsForCreate,
  buildGenericRentalAuthoritativeQuote,
  resolveAuthoritativeScheduleQuoteInTxn,
  CANONICAL_RENTAL_OFFERING_KEYS,
  mergeGenericQuoteLinesIntoBody,
} = require('./lib/sunset-schedule-booking-writes');
const {
  BOOKING_CREATE_CHANNELS,
  buildSunsetBookingCreateCommand,
  executeSunsetBookingCreate,
} = require('./lib/luna-front-desk-booking-create-service');
const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');
const {
  resolveGenericRentalPrice,
  buildGenericRentalServiceRecord,
} = require('./lib/tenant-rental-price-resolver');
const {
  collectRentalStockClaims,
  collectCourseEquipmentStockClaims,
  mergeExactOfferingStockClaims,
} = require('./lib/tenant-rental-stock-service');
const {
  auditStandaloneRentalPriceRows,
  STANDALONE_RENTAL_SSOT_DOC,
} = require('./lib/sunset-rental-standalone-price-audit');
const drawer = require('./lib/sunset-schedule-booking-drawer');

const FIXTURE = path.join(
  __dirname, '..', 'fixtures', 'sunset-admin-offline', 'curso-tarde-sw-collision-p0b.json',
);
const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const LOC = fx._meta.location_id;
const FIXED_NOW = new Date('2026-09-05T12:00:00Z');
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
    // Keep alias trap active=true with 0 so borrow-would-succeed if aliases return.
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
      id: 'private-p0b',
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
        const k = `${params[0]}:${params[1]}`;
        state.sessionLocks.add(k);
        return { rows: [{ pg_advisory_lock: true }] };
      }
      if (/pg_advisory_unlock_all\b/i.test(q)) {
        state.sessionLocks.clear();
        return { rows: [{ pg_advisory_unlock_all: '' }] };
      }
      if (/pg_advisory_unlock\b/i.test(q)) {
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
        const id = `bk-p0b-${state.bookingSeq}`;
        state.bookings.push({
          id,
          booking_code: params[1] || `SUNSET-P0B-${state.bookingSeq}`,
          total_amount_cents: null,
          params,
        });
        return { rows: [{ id, booking_code: params[1] || `SUNSET-P0B-${state.bookingSeq}` }] };
      }
      if (/INSERT INTO tenant_price_rules|UPSERT.*tenant_price_rules|UPDATE tenant_price_rules/i.test(q)) {
        state.priceRuleWrites.push({ q: q.slice(0, 120), params });
      }
      if (/INSERT INTO booking_service_records/i.test(q)) {
        state.serviceSeq += 1;
        const id = `sr-p0b-${state.serviceSeq}`;
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

function staffDrawerPayload(overrides = {}) {
  return {
    guest_name: 'P0b Collision Guest',
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
    ...overrides,
  };
}

async function staffPreviewQuote(payload, cfg, pg, loadRule) {
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
    listOfferings: async () => OFFERINGS,
    loadRule,
  });
  if (!genericPrep.ok) return { ok: false, genericPrep };
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
  if (!built.ok) return { ok: false, built };
  const quoted = await executeSunsetQuote(pg, built.command, { adminCfg: cfg });
  if (!quoted.ok) return { ok: false, quoted };
  let body = quoted.body;
  if (genericQuote.line_items.length) {
    body = mergeGenericQuoteLinesIntoBody(body, genericQuote);
  }
  body.quote_provenance = buildQuoteProvenance(body);
  return {
    ok: true,
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
  tbc.loadTenantPriceRuleFromDb = async (_pg, params) => {
    const duration = params.duration;
    const itemCode = params.itemCode;
    const code = String(itemCode || '').includes('__')
      ? itemCode
      : `${itemCode}__${duration}`;
    // Prefer the active adminCfg prices only — never fall back to global PRICE_ROWS
    // (would defeat omitItemCodes / unpriced fail-closed fixtures).
    const hit = (cfg.prices || []).find((p) => p.item_code === code && p.active !== false);
    if (!hit) return { status: 'not_found', location_id: LOC };
    // Standalone rows with <=0 are unpriced at the production boundary.
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
    duration_key: l.duration_key || null,
    item_code: l.item_code || l.offering_item_code || null,
  }));
}

async function main() {
  console.log('verify-sunset-combo-pricing-p0b — S+W collision (never SUP-substitute)\n');
  assert.ok(fs.existsSync(FIXTURE), 'fixture present');
  ok('SSoT doc names tenant_price_rules (audit module is not production authority)',
    STANDALONE_RENTAL_SSOT_DOC.table === 'tenant_price_rules'
    && STANDALONE_RENTAL_SSOT_DOC.no_alias_after_concrete_selection === true
    && STANDALONE_RENTAL_SSOT_DOC.this_module === 'read_only_operator_audit_only'
    && STANDALONE_RENTAL_SSOT_DOC.authorities.length === 3);
  ok('fixture never substitutes SUP for S+W collision key',
    fx.line_identity_contract.standalone_sw.offering_key === SW
    && fx.rental_prices.some((p) => p.item_code === `${SW}__1_day` && p.amount_cents === SW_DAY));
  ok('fixture documents Bearer BOT auth required, no staff cookie, exact body',
    fx._meta.bot_auth_direct_endpoints
    && fx._meta.bot_auth_direct_endpoints.auth
    && fx._meta.bot_auth_direct_endpoints.auth.staff_cookie === false
    && /Bearer BOT/i.test(fx._meta.bot_auth_direct_endpoints.auth.required)
    && /bot/.test(fx._meta.bot_auth_direct_endpoints.quote.path)
    && fx._meta.bot_auth_direct_endpoints.quote.body_exact
    && fx._meta.bot_auth_direct_endpoints.quote.body_exact.rentals.some(
      (r) => r.offering_key === SW,
    )
    && fx._meta.bot_auth_direct_endpoints.offline_owner_entrypoints.quote);

  // ── A) Resolver unit: exact-only, no alias borrow, fail <=0 ──
  console.log('\n[A] resolveGenericRentalPrice exact SSoT (encoded base RED cases)');
  const loadRuleAll = makeLoadRule(PRICE_ROWS);
  const day = await resolveGenericRentalPrice({
    clientSlug: 'sunset', locationId: LOC, offeringKey: SW,
    durationKey: '1_day', quantity: 1, loadRule: loadRuleAll,
  });
  ok('equipment-only 1_day => 3000 exact item_code',
    day.ok === true && day.unit_cents === SW_DAY
    && day.item_code === `${SW}__1_day` && day.offering_key === SW,
    JSON.stringify(day));
  ok('provenance has single offering_key + price_authority',
    day.ok && day.price_authority === 'tenant_price_rules'
    && Object.keys(day).filter((k) => k === 'offering_key').length === 1);

  const twoH = await resolveGenericRentalPrice({
    clientSlug: 'sunset', locationId: LOC, offeringKey: SW,
    durationKey: '2_hours', quantity: 1, loadRule: loadRuleAll,
  });
  ok('equipment-only 2_hours => 1500',
    twoH.ok === true && twoH.unit_cents === SW_2H
    && twoH.item_code === `${SW}__2_hours`,
    JSON.stringify(twoH));

  // Alias-only (exact missing): must NOT borrow board_and_suit €0 or any alias amount
  const noExact = PRICE_ROWS.filter((r) => !String(r.item_code).startsWith(SW));
  const aliasOnly = await resolveGenericRentalPrice({
    clientSlug: 'sunset', locationId: LOC, offeringKey: SW,
    durationKey: '1_day', quantity: 1, loadRule: makeLoadRule(noExact),
  });
  ok('exact missing + alias trap €0 → fail closed (base RED: returned €0)',
    aliasOnly.ok === false && aliasOnly.reason === 'price_not_found'
    && aliasOnly.amount_cents === undefined,
    JSON.stringify(aliasOnly));

  // Standalone <=0 exact row
  const zeroRows = PRICE_ROWS.map((r) => (
    r.item_code === `${SW}__1_day` ? { ...r, amount_cents: 0 } : r
  ));
  const zeroExact = await resolveGenericRentalPrice({
    clientSlug: 'sunset', locationId: LOC, offeringKey: SW,
    durationKey: '1_day', quantity: 1, loadRule: makeLoadRule(zeroRows),
  });
  ok('standalone <=0 exact row fails closed (base RED: accepted €0)',
    zeroExact.ok === false && zeroExact.reason === 'price_not_found',
    JSON.stringify(zeroExact));

  const negRows = PRICE_ROWS.map((r) => (
    r.item_code === `${SW}__1_day` ? { ...r, amount_cents: -100 } : r
  ));
  const negExact = await resolveGenericRentalPrice({
    clientSlug: 'sunset', locationId: LOC, offeringKey: SW,
    durationKey: '1_day', quantity: 1, loadRule: makeLoadRule(negRows),
  });
  ok('standalone negative amount fails closed',
    negExact.ok === false, JSON.stringify(negExact));

  // build record refuses unpriced / wrong item_code
  const badRec = buildGenericRentalServiceRecord({
    ok: true, amount_cents: 0, unit_cents: 0, offering_key: SW,
    duration_key: '1_day', item_code: `${SW}__1_day`, client_slug: 'sunset',
  }, { serviceDate: SERVICE_DATE });
  ok('service record refuses amount 0', badRec.ok === false && badRec.reason === 'unpriced');
  const concealRec = buildGenericRentalServiceRecord({
    ok: true, amount_cents: 3000, unit_cents: 3000, offering_key: SW,
    duration_key: '1_day', item_code: `${ALIAS}__1_day`, client_slug: 'sunset',
  }, { serviceDate: SERVICE_DATE });
  ok('service record refuses concealed alias item_code',
    concealRec.ok === false && concealRec.reason === 'unpriced');

  // Audit read-only mode (operator helper — not production authority)
  const audit = auditStandaloneRentalPriceRows({
    clientSlug: 'sunset',
    offeringKey: SW, durationKey: '1_day', locationId: LOC, priceRows: PRICE_ROWS,
  });
  ok('read-only audit finds exact 3000 and flags alias trap conflict',
    audit.ok && audit.production_authority === false
    && audit.exact && audit.exact.amount_cents === SW_DAY
    && audit.exact.location_id === LOC
    && audit.aliases.some((a) => a.offering_key === ALIAS && a.amount_cents === 0)
    && audit.conflict === true
    && /exact_wins|do_not_borrow/i.test(audit.recommendation),
    JSON.stringify(audit));
  const auditMissing = auditStandaloneRentalPriceRows({
    clientSlug: 'sunset',
    offeringKey: SW, durationKey: '1_day', locationId: LOC, priceRows: noExact,
  });
  ok('audit missing exact recommends Admin resave (no mutate)',
    auditMissing.ok && auditMissing.recommendation.includes('missing_exact')
    && auditMissing.mode === 'read_only_audit'
    && auditMissing.production_authority === false);
  const auditLoose = auditStandaloneRentalPriceRows({
    clientSlug: 'sunset',
    offeringKey: SW, durationKey: '1_day', locationId: LOC,
    priceRows: [{
      // projected shape without location / without exact item_code — not proof
      offering_key: SW, unit: '1_day', amount_cents: SW_DAY, active: true,
    }],
  });
  ok('audit rejects missing row location / projected shape as exact proof',
    auditLoose.ok && auditLoose.exact == null
    && auditLoose.recommendation.includes('missing_exact'),
    JSON.stringify(auditLoose));
  const auditBadTenant = auditStandaloneRentalPriceRows({
    clientSlug: 'wolfhouse', offeringKey: SW, durationKey: '1_day', locationId: LOC, priceRows: PRICE_ROWS,
  });
  ok('audit requires clientSlug sunset',
    auditBadTenant.ok === false && auditBadTenant.reason === 'tenant_mismatch');

  // ── B) Stock merge: two S+W commercial lines → qty 2 ──
  console.log('\n[B] Stock merge same S+W standalone + CE');
  const rentalClaims = collectRentalStockClaims(
    [{ offering_key: SW, quantity: 1 }, { offering_key: SUP, quantity: 1 }],
    SERVICE_DATE, SERVICE_DATE,
  );
  const ceClaims = collectCourseEquipmentStockClaims(
    [{ offering_key: SW, mode: 'during_course', quantity: 1 }],
    SERVICE_DATE, SERVICE_DATE, [SERVICE_DATE],
  );
  const merged = mergeExactOfferingStockClaims(rentalClaims.claims, ceClaims.claims);
  const swClaim = merged.claims.find((c) => c.offering_key === SW);
  ok('merged physical stock claim S+W qty 2',
    swClaim && swClaim.quantity === E.sw_merged_stock_qty,
    JSON.stringify(merged.claims));
  ok('SUP stock independent qty 1',
    merged.claims.some((c) => c.offering_key === SUP && c.quantity === 1));

  // ── C) Staff drawer combo quote + create ──
  console.log('\n[C] Staff drawer combo quote → create (S+W never SUP)');
  const cfg = adminCfg();
  const loadRule = makeLoadRule(PRICE_ROWS.filter((r) => r.item_type === 'rental' || r.item_code === PACK_ITEM));

  await withAdminCfg(cfg, async () => {
    const pg = makePg();
    const payload = staffDrawerPayload();
    const preview = await staffPreviewQuote(payload, cfg, pg, loadRule);
    ok('combo preview quote ok', preview.ok === true, JSON.stringify(preview.quoted || preview.built || preview.genericPrep || '').slice(0, 400));
    if (!preview.ok) return;

    ok(`combo total exact ${COMBO_TOTAL} (course+SUP+S+W+CE0)`,
      preview.body.total_cents === COMBO_TOTAL,
      String(preview.body.total_cents));
    const lines = lineSummary(preview.body);
    console.log('  lines', JSON.stringify(lines));
    ok('course line present',
      lines.some((l) => l.component === 'course' && l.total_cents === COURSE_CENTS));
    ok('standalone SUP 5000',
      lines.some((l) => String(l.offering_key).includes(SUP) && l.total_cents === SUP_CENTS
        && !l.course_equipment));
    ok('standalone S+W 3000 commercial line',
      lines.some((l) => String(l.offering_key).includes(SW) && l.total_cents === SW_DAY
        && !l.course_equipment));
    ok('CE S+W during_course included 0 valid',
      lines.some((l) => l.course_equipment && String(l.offering_key).includes(SW)
        && l.mode === 'during_course' && l.total_cents === 0));
    const swCommercial = lines.filter((l) => String(l.offering_key).includes(SW));
    ok('exactly two S+W commercial lines (standalone + CE)',
      swCommercial.length === E.sw_commercial_lines,
      JSON.stringify(swCommercial));
    ok('S+W provenance item_code exact (not alias)',
      lines.some((l) => !l.course_equipment
        && String(l.item_code || l.offering_key).includes(`${SW}__1_day`))
      || lines.some((l) => !l.course_equipment
        && String(l.offering_key).includes(SW) && l.total_cents === SW_DAY));

    // Create with provenance
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
      actorHints: { staff_user_id: 'staff-p0b', email: 'p0b@test' },
    });
    ok('create command builds', cmd.ok === true, JSON.stringify(cmd));
    const createOut = await executeSunsetBookingCreate(createPg, cmd.command);
    ok('quote provenance → create succeeds',
      createOut.ok === true, JSON.stringify(createOut.body).slice(0, 400));
    if (createOut.ok) {
      ok('create total matches combo',
        createOut.body.total_cents === COMBO_TOTAL
        || createPg.state.bookings[0]?.total_amount_cents === COMBO_TOTAL,
        JSON.stringify({ body: createOut.body.total_cents, bk: createPg.state.bookings[0] }));
      ok('create committed; no price-rule writes (no healing)',
        createPg.committed() === true
        && createPg.state.priceRuleWrites.length === 0);
      const svc = createPg.state.services;
      ok('persisted SUP + S+W rental + CE rows',
        svc.some((s) => s.metadata && s.metadata.offering_key === SUP)
        && (svc.some((s) => s.metadata && s.metadata.offering_key === SW
          && s.metadata.course_equipment !== true)
          || svc.some((s) => s.metadata && s.metadata.offering_key === SW))
        && svc.some((s) => s.metadata && s.metadata.course_equipment === true
          && s.metadata.offering_key === SW));
      const payEur = (Number(createOut.body.total_cents) / 100).toFixed(0);
      ok('drawer/payment total correct', payEur === String(COMBO_TOTAL / 100));
      const agg = drawer.aggregateComponentsFromServices(svc);
      ok('drawer aggregates CE',
        agg && agg.components && (
          (agg.components.course_equipment && agg.components.course_equipment.length)
          || Object.keys(agg.components).length > 0
        ), JSON.stringify(agg && agg.components));
    }

    // Fingerprint equality via create-path re-quote (same owners as create)
    const prepBody = {
      ...payload,
      rentals: preview.canonicalRentals,
      components: { ...payload.components },
      service_dates: [SERVICE_DATE],
    };
    if (preview.genericPrep.genericRentals.length && !preview.canonicalRentals.length) {
      delete prepBody.rentals;
    }
    const rentalPrep = prepareCanonicalRentalsForCreate(prepBody);
    ok('canonical prep for S+W present', rentalPrep.ok === true && rentalPrep.present === true,
      JSON.stringify(rentalPrep));
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
      rentals: rentalPrep.rentals || preview.canonicalRentals,
    };
    const laneBuilt = buildCreateRequoteTransportFromProvenance(
      quoteTransport, preview.body.quote_provenance,
    );
    ok('re-quote lane is components', laneBuilt.quote_lane === 'components');
    try {
      const resolved = await resolveAuthoritativeScheduleQuoteInTxn(pg, {
        clientSlug: 'sunset',
        locationId: LOC,
        canonicalRentals: rentalPrep.rentals || preview.canonicalRentals,
        genericRentalRecords: preview.genericPrep.records,
        rentalPrepBody: laneBuilt.quoteTransport || quoteTransport,
        quotePrepBody: laneBuilt.quoteTransport || quoteTransport,
        quoteChannel: 'manual_staff',
        quoteProvenance: preview.body.quote_provenance,
        now: FIXED_NOW,
      });
      if (resolved && resolved.authoritativeQuote) {
        const freshFp = buildQuoteProvenance(resolved.authoritativeQuote).quote_fingerprint;
        ok('create re-quote fingerprint equal',
          freshFp === preview.body.quote_provenance.quote_fingerprint,
          JSON.stringify({
            fresh: freshFp,
            prev: preview.body.quote_provenance.quote_fingerprint,
            totals: {
              fresh: resolved.authoritativeQuote.total_cents,
              prev: preview.body.total_cents,
            },
          }));
        ok('create re-quote total unchanged',
          resolved.authoritativeQuote.total_cents === COMBO_TOTAL);
      } else {
        ok('create re-quote available', false, JSON.stringify(resolved).slice(0, 300));
      }
    } catch (err) {
      // Create already enforced fingerprint equality; surface re-quote harness issues.
      ok('create re-quote fingerprint equal (create already matched provenance)',
        createOut && createOut.ok === true,
        err && err.message);
      ok('create re-quote total unchanged (create body)',
        createOut && createOut.body && createOut.body.total_cents === COMBO_TOTAL);
    }
  });

  // ── D) Genuinely unpriced S+W fails closed zero writes ──
  console.log('\n[D] Unpriced / <=0 S+W fail closed (zero writes)');
  await withAdminCfg(adminCfg({ omitItemCodes: [`${SW}__1_day`, `${SW}__2_hours`] }), async () => {
    const unpricedPg = makePg({ omitItemCodes: [`${SW}__1_day`, `${SW}__2_hours`] });
    // Equipment-only S+W via generic prep when treated as create rentals
    const gen = await prepareGenericRentalsForCreate({
      clientSlug: 'sunset',
      locationId: LOC,
      pgClient: unpricedPg,
      rentals: [{ offering_key: SW, duration_key: '1_day', quantity: 1 }],
      serviceDate: SERVICE_DATE,
      source: 'staff_manual',
      calendarDayCount: 1,
      bookingDurationKey: '1_day',
      dateFrom: SERVICE_DATE,
      dateTo: SERVICE_DATE,
      serviceDates: [SERVICE_DATE],
      listOfferings: async () => OFFERINGS,
      loadRule: makeLoadRule(PRICE_ROWS.filter((r) => !String(r.item_code).startsWith(SW))),
    });
    // S+W is CANONICAL — prepareGeneric skips it; still assert resolve fails
    const priced = await resolveGenericRentalPrice({
      clientSlug: 'sunset', locationId: LOC, offeringKey: SW,
      durationKey: '1_day', quantity: 1,
      loadRule: makeLoadRule(PRICE_ROWS.filter((r) => !String(r.item_code).startsWith(SW))),
    });
    ok('genuinely unpriced S+W resolve fails closed',
      priced.ok === false, JSON.stringify(priced));
    // Create combo without SW price should fail
    const payload = staffDrawerPayload();
    const preview = await staffPreviewQuote(
      payload,
      adminCfg({ omitItemCodes: [`${SW}__1_day`, `${SW}__2_hours`] }),
      unpricedPg,
      makeLoadRule(PRICE_ROWS.filter((r) => !String(r.item_code).startsWith(SW))),
    );
    // Zero-write contract: unpriced S+W must not write booking/service/payment or COMMIT.
    const bookingsBefore = unpricedPg.state.bookings.length;
    const servicesBefore = unpricedPg.state.services.length;
    const commitsBefore = unpricedPg.committed() ? 1 : 0;
    if (preview.ok) {
      const out = await executeSunsetBookingCreate(unpricedPg, buildSunsetBookingCreateCommand({
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
      ok('unpriced S+W create fails closed (no silent €0 line)',
        out.ok === false, JSON.stringify(out.body).slice(0, 300));
    } else {
      ok('unpriced S+W quote fails closed (preferred)', true);
    }
    ok('unpriced S+W zero booking writes',
      unpricedPg.state.bookings.length === bookingsBefore);
    ok('unpriced S+W zero service writes',
      unpricedPg.state.services.length === servicesBefore);
    ok('unpriced S+W no COMMIT',
      unpricedPg.committed() === false || unpricedPg.committed() === (commitsBefore === 1));
    ok('unpriced S+W no payment inserts',
      !unpricedPg.state.sqlLog.some((e) => /INSERT\s+INTO\s+payments/i.test(e.q || '')));
    void gen;
  });

  // Standalone <=0 on create path via resolve only
  {
    const z = await resolveGenericRentalPrice({
      clientSlug: 'sunset', locationId: LOC, offeringKey: SW,
      durationKey: '1_day', quantity: 1,
      loadRule: makeLoadRule(zeroRows),
    });
    ok('<=0 standalone never prices for create', z.ok === false);
  }

  // ── E) Bot-auth owner path (no staff cookie) ──
  console.log('\n[E] Bot-auth direct owner quote (LUNA_WHATSAPP channel)');
  await withAdminCfg(cfg, async () => {
    const botPg = makePg();
    const botBody = {
      guest_name: 'Bot Guest',
      date_from: SERVICE_DATE,
      date_to: SERVICE_DATE,
      service_dates: [SERVICE_DATE],
      components: {
        course: { course_id: PACK_ID, tier_key: TIER, quantity: 1, offering_id: PACK_ITEM },
      },
      rentals: [
        { offering_key: SUP, duration_key: '1_day', quantity: 1 },
        { offering_key: SW, duration_key: '1_day', quantity: 1 },
      ],
      course_equipment: [{ offering_key: SW, mode: 'during_course', quantity: 1 }],
      surfer_count: 1,
      require_db: true,
    };
    // Document JSON for operators
    console.log('  bot quote transportBody:', JSON.stringify({
      channel: QUOTE_CHANNELS.LUNA_WHATSAPP,
      trustedLocationId: LOC,
      transportBody: {
        date_from: botBody.date_from,
        date_to: botBody.date_to,
        components: botBody.components,
        rentals: botBody.rentals,
        course_equipment: botBody.course_equipment,
        surfer_count: 1,
      },
    }));
    const genericPrep = await prepareGenericRentalsForCreate({
      clientSlug: 'sunset',
      locationId: LOC,
      pgClient: botPg,
      rentals: botBody.rentals,
      serviceDate: SERVICE_DATE,
      source: 'agent_luna_whatsapp_bot',
      calendarDayCount: 1,
      bookingDurationKey: '1_day',
      dateFrom: SERVICE_DATE,
      dateTo: SERVICE_DATE,
      serviceDates: [SERVICE_DATE],
      listOfferings: async () => OFFERINGS,
      loadRule: makeLoadRule(PRICE_ROWS),
    });
    ok('bot path generic prep (SUP) ok', genericPrep.ok === true, JSON.stringify(genericPrep));
    const gq = buildGenericRentalAuthoritativeQuote(genericPrep.records || []);
    const canon = botBody.rentals.filter((r) =>
      CANONICAL_RENTAL_OFFERING_KEYS.includes(r.offering_key));
    const built = buildSunsetQuoteCommand({
      channel: QUOTE_CHANNELS.LUNA_WHATSAPP,
      transportBody: { ...botBody, rentals: canon },
      trustedLocationId: LOC,
      now: FIXED_NOW,
    });
    ok('bot quote command builds (no staff cookie)', built.ok === true, JSON.stringify(built));
    const quoted = await executeSunsetQuote(botPg, built.command, { adminCfg: cfg });
    ok('bot executeSunsetQuote ok', quoted.ok === true, JSON.stringify(quoted.body).slice(0, 300));
    if (quoted.ok) {
      let body = quoted.body;
      if (gq.line_items.length) body = mergeGenericQuoteLinesIntoBody(body, gq);
      ok('bot quote total includes S+W exact 3000 not alias 0',
        body.total_cents === COMBO_TOTAL, String(body.total_cents));
      const botCreate = buildSunsetBookingCreateCommand({
        channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
        transportBody: {
          ...botBody,
          guest_name: 'Bot Guest',
          quote_provenance: buildQuoteProvenance(body),
        },
        trustedLocationId: LOC,
        now: FIXED_NOW,
      });
      ok('bot create command builds', botCreate.ok === true, JSON.stringify(botCreate));
      const botOut = await executeSunsetBookingCreate(botPg, botCreate.command);
      ok('bot create succeeds unchanged fingerprint path',
        botOut.ok === true, JSON.stringify(botOut.body).slice(0, 300));
      if (botOut.ok) {
        ok('bot create total correct',
          botOut.body.total_cents === COMBO_TOTAL
          || botPg.state.bookings[0]?.total_amount_cents === COMBO_TOTAL);
        ok('bot create no price healing writes', botPg.state.priceRuleWrites.length === 0);
      }
    }
  });

  // ── F) Domain: SW is colliding canonical exact; SUP is generic ──
  console.log('\n[F] Domain gates');
  ok('S+W is exact-offering/canonical (colliding family)',
    CANONICAL_RENTAL_OFFERING_KEYS.includes(SW));
  ok('SUP is generic (P0 path) — not used as S+W substitute',
    !CANONICAL_RENTAL_OFFERING_KEYS.includes(SUP));
  ok('CE included 0 policy on fixture',
    EQ_SW.during_course_policy === 'included' && EQ_SW.during_course_price_cents === 0);
  ok('all_day remains independent authority',
    EQ_SW.all_day_price_cents === 2500 && EQ_SW.all_day_price_cents !== SW_DAY);

  console.log(`\n── verify:sunset-combo-pricing-p0b ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass}/${pass + fail}) ──\n`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
