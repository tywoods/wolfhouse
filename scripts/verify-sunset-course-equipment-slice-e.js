'use strict';

/**
 * Slice E acceptance — production owners only.
 *
 * Exercises executeSunsetBookingCreate, executeSunsetQuote, intent fingerprint,
 * restoreSunsetScheduleBooking, validateScheduleBookingBody, and drawer labels.
 * Offline fake PG — no live/staging calls.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildSunsetQuoteCommand,
  executeSunsetQuoteSync,
  executeSunsetQuote,
  buildCreateRequoteTransportFromProvenance,
  validateQuoteProvenanceForCreate,
  QUOTE_CHANNELS,
} = require('./lib/luna-front-desk-quote-service');
const {
  buildScheduleBookingIntentFingerprint,
  validateScheduleBookingBody,
  FULL_DAY_EQUIPMENT_ADDON_KEY,
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
const drawer = require('./lib/sunset-schedule-booking-drawer');

const LOC = 'sunset-somo';
const FIXED_NOW = new Date('2026-07-28T12:00:00Z');
// Saturday in sat_sun pack schedule — far future relative to FIXED_NOW and wall clock
const SERVICE_DATE = '2026-09-05';
const PACK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TIER = '1_day';
const PACK_ITEM = packPriceItemCode(PACK_ID, TIER);
const COURSE_AMOUNT = 4000;
const GEAR_KEY = 'board_and_suit_rental';

const INCLUDED_EQ = {
  offering_key: GEAR_KEY,
  during_course_policy: 'included',
  during_course_price_cents: 0,
  all_day_price_cents: 1000,
  label: 'Board and wetsuit',
};
const OPTIONAL_ZERO_EQ = {
  offering_key: 'carbon_fins',
  during_course_policy: 'optional',
  during_course_price_cents: 0,
  all_day_price_cents: 500,
  label: 'Carbon Fins',
};
const UNAVAILABLE_EQ = {
  offering_key: 'wax',
  during_course_policy: 'unavailable',
  during_course_price_cents: 0,
  all_day_price_cents: 100,
  label: 'Wax',
};

const OFFERINGS = [
  { offering_key: GEAR_KEY, label: 'Board and wetsuit', active: true, client_slug: 'sunset', location_id: LOC, stock_quantity: 20 },
  { offering_key: 'carbon_fins', label: 'Carbon Fins', active: true, client_slug: 'sunset', location_id: LOC, stock_quantity: 20 },
  { offering_key: 'wax', label: 'Wax', active: true, client_slug: 'sunset', location_id: LOC, stock_quantity: 20 },
];

function adminCfg(equipmentOptions) {
  const opts = equipmentOptions || [INCLUDED_EQ, OPTIONAL_ZERO_EQ, UNAVAILABLE_EQ];
  return {
    ok: true,
    source: 'db',
    currency: 'EUR',
    rental_offerings: OFFERINGS,
    surf_packs: [{
      pack_id: PACK_ID,
      label: 'Slice E Course',
      active: true,
      group_size: 8,
      weekly: 'sat_sun',
      schedules: ['1000_1300'],
      equipment_options: opts,
      price_tiers: [{ key: TIER, label: '1 day', hours: 3, amount_cents: COURSE_AMOUNT }],
    }],
    prices: [{
      id: 'price-course',
      category: 'package',
      offering_key: PACK_ITEM,
      item_code: PACK_ITEM,
      amount_cents: COURSE_AMOUNT,
      unit: 'day',
      active: true,
      currency: 'EUR',
    }],
    private_lesson: {
      id: 'private-e',
      enabled: true,
      label: 'Private',
      amount_cents: 6000,
      currency: 'EUR',
      price_basis: 'per_session',
      default_duration_minutes: 120,
      equipment_options: opts,
    },
  };
}

function packRow(equipmentOptions) {
  return {
    id: PACK_ID,
    label: 'Slice E Course',
    config_json: {
      age_band: '12_and_up',
      group_size: 8,
      beaches: ['somo'],
      weekly: 'sat_sun',
      schedules: ['1000_1300'],
      equipment_options: equipmentOptions || [INCLUDED_EQ, OPTIONAL_ZERO_EQ, UNAVAILABLE_EQ],
      price_tiers: [{ key: TIER, label: '1 day', hours: 3, amount_cents: COURSE_AMOUNT }],
    },
  };
}

function makeCreatePg(opts = {}) {
  const packs = [packRow(opts.equipmentOptions)];
  const stockRemaining = opts.stockRemaining != null ? opts.stockRemaining : 20;
  const state = {
    bookings: [],
    services: [],
    committed: false,
    rolledBack: false,
    bookingSeq: 0,
    serviceSeq: 0,
  };
  const pg = {
    state,
    committed: () => state.committed,
    rolledBack: () => state.rolledBack,
    async query(sql, params = []) {
      const q = String(sql);
      if (/^\s*BEGIN/i.test(q)) return { rows: [] };
      if (/^\s*COMMIT/i.test(q)) { state.committed = true; return { rows: [] }; }
      if (/^\s*ROLLBACK/i.test(q)) { state.rolledBack = true; return { rows: [] }; }
      if (/pg_advisory_xact_lock/i.test(q)) return { rows: [] };
      if (/FROM information_schema\.tables/i.test(q) && /table_name = ANY/i.test(q)) {
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
      if (/pg_constraint|ALTER TABLE/i.test(q)) {
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
          rows: packs.map((p) => ({
            id: p.id, label: p.label, config_json: p.config_json,
            active: true, location_id: LOC,
          })),
        };
      }
      if (/COALESCE\(SUM/i.test(q) && /booking_service_records/i.test(q)) {
        return { rows: [{ seats: 0 }] };
      }
      // Lock path first: assertRentalStockClaimsInTxn uses
      // SELECT … FROM tenant_rental_offerings … FOR UPDATE and reads stock_quantity
      // (0 = sold out). Must not fall through to the non-lock list branch.
      if (/tenant_rental_offerings/i.test(q) && /FOR UPDATE/i.test(q)) {
        return {
          rows: OFFERINGS.map((o) => ({
            id: o.offering_key,
            offering_key: o.offering_key,
            stock_quantity: stockRemaining,
            remaining: stockRemaining,
            active: true,
            client_slug: 'sunset',
            location_id: LOC,
          })),
        };
      }
      if (/FROM tenant_rental_offerings/i.test(q) || (/rental_offerings/i.test(q) && /SELECT/i.test(q))) {
        return {
          rows: OFFERINGS.map((o) => ({
            id: o.offering_key, offering_key: o.offering_key, label: o.label,
            display_name: o.label, active: true, client_slug: 'sunset',
            location_id: LOC,
            // Catalog list also honors test stock override (same pool as lock).
            stock_quantity: stockRemaining,
            config_json: {},
          })),
        };
      }
      if (/FROM tenant_price_rules/i.test(q)) {
        return {
          rows: [{
            id: 'pr-course', amount_cents: COURSE_AMOUNT, currency: 'EUR',
            item_type: 'package', item_code: PACK_ITEM, unit: 'day',
            location_id: LOC, active: true,
          }],
        };
      }
      if (/INSERT INTO bookings/i.test(q)) {
        state.bookingSeq += 1;
        const id = `bk-${state.bookingSeq}`;
        const code = params[1] || `SUNSET-E-${state.bookingSeq}`;
        state.bookings.push({ id, booking_code: code, params });
        return { rows: [{ id, booking_code: code }] };
      }
      if (/INSERT INTO booking_service_records/i.test(q)) {
        state.serviceSeq += 1;
        const id = `sr-${state.serviceSeq}`;
        let meta = params[9] || params[params.length - 1];
        if (typeof meta === 'string') {
          try { meta = JSON.parse(meta); } catch (_) { meta = {}; }
        }
        const row = {
          service_record_id: id,
          id,
          service_type: params[4],
          service_date: params[5],
          quantity: params[6],
          amount_due_cents: params[7] != null ? params[7] : 0,
          metadata: meta || {},
          params,
        };
        state.services.push(row);
        return {
          rows: [{
            service_record_id: id,
            booking_id: params[1],
            booking_code: params[2],
            guest_name: params[3],
            service_type: params[4],
            service_date: params[5],
            quantity: params[6],
            amount_due_cents: row.amount_due_cents,
            amount_paid_cents: 0,
            payment_status: params[8],
            record_source: params[9] && typeof params[9] === 'string' && !params[9].startsWith('{')
              ? params[9] : 'agent_luna_whatsapp_bot',
            metadata: meta,
            offering_key: meta && meta.offering_key,
            staff_ui_service_type: meta && meta.staff_ui_service_type,
          }],
        };
      }
      if (/UPDATE booking_service_records/i.test(q) && /amount_due_cents/i.test(q)) {
        const due = Number(params[0]);
        const id = String(params[params.length - 1] || params[1] || '');
        const sr = state.services.find((s) => String(s.service_record_id) === id || String(s.id) === id);
        if (sr) {
          sr.amount_due_cents = due;
          return { rowCount: 1, rows: [] };
        }
        // applyAuthoritative may update by id in different param slots
        for (const p of params) {
          const hit = state.services.find((s) => String(s.service_record_id) === String(p)
            || String(s.id) === String(p));
          if (hit && Number.isFinite(due)) {
            hit.amount_due_cents = due;
            return { rowCount: 1, rows: [] };
          }
        }
        return { rowCount: 0, rows: [] };
      }
      if (/UPDATE booking_service_records/i.test(q)) {
        return { rowCount: 1, rows: [] };
      }
      if (/UPDATE bookings/i.test(q)) return { rowCount: 1, rows: [] };
      if (/idempotency_key/i.test(q) && /SELECT/i.test(q)) return { rows: [] };
      if (/FROM bookings/i.test(q)) return { rows: [] };
      return { rows: [] };
    },
  };
  return pg;
}

function gearLines(body) {
  return (body.line_items || []).filter((l) => l && l.course_equipment === true);
}

function quoteSync(body, cfg, channel = QUOTE_CHANNELS.LUNA_WHATSAPP) {
  const built = buildSunsetQuoteCommand({
    channel,
    transportBody: body,
    trustedLocationId: LOC,
    now: FIXED_NOW,
  });
  assert.equal(built.ok, true, JSON.stringify(built));
  return executeSunsetQuoteSync(built.command, { adminCfg: cfg || adminCfg() });
}

/** Quote via the same async+pg+adminCfg path create re-quotes use. */
async function quoteForCreate(body, cfg, channel = QUOTE_CHANNELS.LUNA_WHATSAPP, pgOpts) {
  const built = buildSunsetQuoteCommand({
    channel,
    transportBody: { ...body, require_db: true },
    trustedLocationId: LOC,
    now: FIXED_NOW,
  });
  assert.equal(built.ok, true, JSON.stringify(built));
  const pg = makeCreatePg(pgOpts);
  const { resolveTenantBusinessConfigAsync } = require('./lib/tenant-business-config');
  const orig = resolveTenantBusinessConfigAsync;
  require('./lib/tenant-business-config').resolveTenantBusinessConfigAsync = async () => cfg || adminCfg();
  try {
    process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';
    return await executeSunsetQuote(pg, built.command, { adminCfg: cfg || adminCfg() });
  } finally {
    require('./lib/tenant-business-config').resolveTenantBusinessConfigAsync = orig;
  }
}

async function createLuna(body, cfg, pgOpts) {
  const cmd = buildSunsetBookingCreateCommand({
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    transportBody: body,
    trustedLocationId: LOC,
    now: FIXED_NOW,
  });
  assert.equal(cmd.ok, true, JSON.stringify(cmd));
  const pg = makeCreatePg(pgOpts);
  const { resolveTenantBusinessConfigAsync } = require('./lib/tenant-business-config');
  const orig = resolveTenantBusinessConfigAsync;
  require('./lib/tenant-business-config').resolveTenantBusinessConfigAsync = async () => cfg || adminCfg();
  try {
    process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';
    const out = await executeSunsetBookingCreate(pg, cmd.command);
    return { out, pg };
  } finally {
    require('./lib/tenant-business-config').resolveTenantBusinessConfigAsync = orig;
  }
}

async function main() {
// ── 1) Luna-style omitted included → quote provenance → create → €0 rows + pill ON ──
{
  const cfg = adminCfg([INCLUDED_EQ, OPTIONAL_ZERO_EQ]);
  // Components-lane quote on the same require_db async path create re-quotes with
  const q = await quoteForCreate({
    guest_name: 'Included Guest',
    payment_status: 'unpaid',
    service_dates: [SERVICE_DATE],
    components: { course: { course_id: PACK_ID, tier_key: TIER, quantity: 2 } },
    // course_equipment omitted — included must expand
  }, cfg, QUOTE_CHANNELS.LUNA_WHATSAPP);
  assert.equal(q.ok, true, JSON.stringify(q.body));
  assert.equal(q.body.quote_lane, 'components');
  assert.equal(q.body.quote_provenance.quote_lane, 'components');
  const lines = gearLines(q.body);
  assert.strictEqual(lines.length, 1, 'only included auto-expands');
  assert.strictEqual(lines[0].total_cents, 0);
  assert.strictEqual(lines[0].during_course_policy, 'included');
  assert.deepStrictEqual(q.body.course_equipment, [
    { offering_key: GEAR_KEY, mode: 'during_course', quantity: 2 },
  ]);
  assert.deepStrictEqual(q.body.quote_provenance.course_equipment, q.body.course_equipment);

  // create: omit top-level CE; carry provenance only (Luna contract)
  const { out, pg } = await createLuna({
    guest_name: 'Included Guest',
    guest_phone: '+34600111222',
    payment_status: 'unpaid',
    service_dates: [SERVICE_DATE],
    components: { course: { course_id: PACK_ID, tier_key: TIER, quantity: 2 } },
    quote_provenance: q.body.quote_provenance,
  }, cfg);
  assert.equal(out.ok, true, JSON.stringify(out.body));
  assert.equal(pg.committed(), true);
  assert.equal(pg.rolledBack(), false);
  const ce = pg.state.services.filter((s) => s.metadata && s.metadata.course_equipment === true);
  assert.ok(ce.length >= 1, `expected CE rows, got ${ce.length}`);
  assert.ok(ce.every((s) => Number(s.amount_due_cents) === 0 || s.metadata.unit_amount_cents === 0));
  assert.ok(ce.every((s) => s.metadata.during_course_policy === 'included'));
  assert.ok(ce.every((s) => s.metadata.course_equipment_mode === 'during_course'));
  // Production drawer aggregation owner — pill ON when CE present on service rows.
  const agg = drawer.aggregateComponentsFromServices(pg.state.services);
  const pill = (agg.components && agg.components.course_equipment) || [];
  assert.ok(Array.isArray(pill) && pill.length >= 1, JSON.stringify(agg.components));
  assert.equal(pill[0].mode, 'during_course');
  assert.equal(pill[0].offering_key, GEAR_KEY);
  assert.equal(pill[0].during_course_policy, 'included');
}

// ── 1b) Omitted included CE → real create owner → real stock owner → zero writes ──
// Uses executeSunsetBookingCreate + assertRentalStockClaimsInTxn via makeCreatePg
// stock_quantity:0 on the FOR UPDATE lock path (not a copied remaining algorithm).
{
  const cfg = adminCfg([INCLUDED_EQ]);
  const q = await quoteForCreate({
    guest_name: 'Stock Guest',
    payment_status: 'unpaid',
    service_dates: [SERVICE_DATE],
    components: { course: { course_id: PACK_ID, tier_key: TIER, quantity: 1 } },
  }, cfg);
  assert.equal(q.ok, true, JSON.stringify(q.body));
  assert.ok(Array.isArray(q.body.course_equipment) && q.body.course_equipment.length > 0,
    'quote must expand included CE before create stock gate');
  assert.equal(q.body.course_equipment[0].offering_key, GEAR_KEY);
  const { out, pg } = await createLuna({
    guest_name: 'Stock Guest',
    guest_phone: '+34600111333',
    payment_status: 'unpaid',
    service_dates: [SERVICE_DATE],
    components: { course: { course_id: PACK_ID, tier_key: TIER, quantity: 1 } },
    quote_provenance: q.body.quote_provenance,
  }, cfg, { stockRemaining: 0 });
  assert.equal(out.ok, false, JSON.stringify(out.body));
  assert.equal(out.body.error, 'rental_stock_unavailable', JSON.stringify(out.body));
  assert.equal(out.body.reason_code, 'rental_stock_unavailable', JSON.stringify(out.body));
  assert.strictEqual(pg.state.bookings.length, 0, 'stock fail: zero booking writes');
  assert.strictEqual(pg.state.services.length, 0, 'stock fail: zero service writes');
  assert.equal(pg.committed(), false, 'stock fail: no COMMIT');
  assert.equal(pg.rolledBack(), true, 'stock fail: must ROLLBACK');
}

// ── 2) Exact + components lane replay through production create ──
{
  const cfg = adminCfg([INCLUDED_EQ]);
  // Exact offering quote → create with components body + provenance (Luna style)
  const exactQ = quoteSync({
    offering_id: PACK_ITEM,
    course_id: PACK_ID,
    quantity: 1,
    service_dates: [SERVICE_DATE],
    course_equipment: [{ offering_key: GEAR_KEY, mode: 'all_day', quantity: 1 }],
  }, cfg);
  assert.equal(exactQ.ok, true, JSON.stringify(exactQ.body));
  assert.equal(exactQ.body.quote_provenance.quote_lane, 'exact_offering');

  const lane = buildCreateRequoteTransportFromProvenance({
    service_dates: [SERVICE_DATE],
    components: { course: { course_id: PACK_ID, tier_key: TIER, quantity: 1 } },
    course_equipment: [{ offering_key: GEAR_KEY, mode: 'all_day', quantity: 1 }],
  }, exactQ.body.quote_provenance);
  assert.equal(lane.quote_lane, 'exact_offering');
  assert.equal(lane.quoteTransport.offering_id, PACK_ITEM);
  assert.ok(lane.quoteTransport.offering_id, 'exact lane keeps offering_id');

  // Exact-lane re-quote identity (same adminCfg, no pg catalog drift): unchanged
  // all_day selection keeps fingerprint; price change must not.
  const laneTransport = lane.quoteTransport;
  const reQ = quoteSync({
    offering_id: laneTransport.offering_id,
    course_id: laneTransport.course_id,
    tier_key: laneTransport.tier_key,
    quantity: 1,
    service_dates: [SERVICE_DATE],
    course_equipment: [{ offering_key: GEAR_KEY, mode: 'all_day', quantity: 1 }],
  }, cfg);
  assert.equal(reQ.ok, true, JSON.stringify(reQ.body));
  assert.equal(
    reQ.body.quote_provenance.quote_fingerprint,
    exactQ.body.quote_provenance.quote_fingerprint,
    'exact-lane unchanged re-quote must match fingerprint',
  );
  const staleCfg = adminCfg([{ ...INCLUDED_EQ, all_day_price_cents: 9999 }]);
  const staleQ = quoteSync({
    offering_id: PACK_ITEM,
    course_id: PACK_ID,
    quantity: 1,
    service_dates: [SERVICE_DATE],
    course_equipment: [{ offering_key: GEAR_KEY, mode: 'all_day', quantity: 1 }],
  }, staleCfg);
  assert.equal(staleQ.ok, true);
  assert.notStrictEqual(
    staleQ.body.quote_provenance.quote_fingerprint,
    exactQ.body.quote_provenance.quote_fingerprint,
  );
  // Production create with exact provenance + changed config → zero writes.
  // Staff/API create body carries wire array (plugin expands Luna intent → wire).
  const { out: staleOut, pg: pgStale } = await createLuna({
    guest_name: 'Stale Guest',
    guest_phone: '+34600111224',
    payment_status: 'unpaid',
    service_dates: [SERVICE_DATE],
    components: { course: { course_id: PACK_ID, tier_key: TIER, quantity: 1 } },
    course_equipment: [{ offering_key: GEAR_KEY, mode: 'all_day', quantity: 1 }],
    quote_provenance: exactQ.body.quote_provenance,
  }, staleCfg);
  assert.equal(staleOut.ok, false, JSON.stringify(staleOut.body));
  assert.ok(
    staleOut.body && (staleOut.body.reason_code === 'stale_quote'
      || /stale|no longer available/i.test(JSON.stringify(staleOut.body))),
    JSON.stringify(staleOut.body),
  );
  assert.strictEqual(pgStale.state.bookings.length, 0, 'stale must leave zero booking writes');

  // Components lane create through production owner
  const compQ = await quoteForCreate({
    guest_name: 'C',
    service_dates: [SERVICE_DATE],
    payment_status: 'unpaid',
    components: { course: { course_id: PACK_ID, tier_key: TIER, quantity: 1 } },
    course_equipment: [{ offering_key: GEAR_KEY, mode: 'during_course', quantity: 1 }],
  }, cfg, QUOTE_CHANNELS.MANUAL_STAFF);
  assert.equal(compQ.ok, true, JSON.stringify(compQ.body));
  assert.equal(compQ.body.quote_provenance.quote_lane, 'components');
  const compLane = buildCreateRequoteTransportFromProvenance({
    offering_id: PACK_ITEM, // projected — must not select exact lane
    service_dates: [SERVICE_DATE],
    components: { course: { course_id: PACK_ID, tier_key: TIER, quantity: 1 } },
    course_equipment: [{ offering_key: GEAR_KEY, mode: 'during_course', quantity: 1 }],
  }, compQ.body.quote_provenance);
  assert.equal(compLane.quote_lane, 'components');
  assert.ok(!compLane.quoteTransport.offering_id, 'components lane drops offering_id');

  const { out: compCreate, pg: pgComp } = await createLuna({
    guest_name: 'Comp Lane Guest',
    guest_phone: '+34600111225',
    payment_status: 'unpaid',
    service_dates: [SERVICE_DATE],
    components: { course: { course_id: PACK_ID, tier_key: TIER, quantity: 1 } },
    course_equipment: [{ offering_key: GEAR_KEY, mode: 'during_course', quantity: 1 }],
    quote_provenance: compQ.body.quote_provenance,
  }, cfg);
  assert.equal(compCreate.ok, true, JSON.stringify(compCreate.body));
  assert.equal(pgComp.rolledBack(), false);
  assert.ok(pgComp.state.services.some((s) => s.metadata && s.metadata.course_equipment === true));
}

// ── 3) Optional zero omitted vs explicit ──
{
  const cfg = adminCfg([OPTIONAL_ZERO_EQ]);
  assert.strictEqual(
    defaultFreeDuringCourseEquipmentSelection({
      packs: [{ equipment_options: [OPTIONAL_ZERO_EQ] }],
      surfers: 1,
    }),
    null,
  );
  const omitted = quoteSync({
    guest_name: 'O',
    service_dates: [SERVICE_DATE],
    payment_status: 'unpaid',
    components: { course: { course_id: PACK_ID, tier_key: TIER, quantity: 1 } },
  }, cfg, QUOTE_CHANNELS.MANUAL_STAFF);
  assert.equal(omitted.ok, true);
  assert.strictEqual(gearLines(omitted.body).length, 0);

  const explicit = quoteSync({
    guest_name: 'E',
    service_dates: [SERVICE_DATE],
    payment_status: 'unpaid',
    components: { course: { course_id: PACK_ID, tier_key: TIER, quantity: 1 } },
    course_equipment: [{ offering_key: 'carbon_fins', mode: 'during_course', quantity: 1 }],
  }, cfg, QUOTE_CHANNELS.MANUAL_STAFF);
  assert.equal(explicit.ok, true, JSON.stringify(explicit.body));
  assert.strictEqual(gearLines(explicit.body).length, 1);
  assert.strictEqual(gearLines(explicit.body)[0].total_cents, 0);
  assert.strictEqual(gearLines(explicit.body)[0].during_course_policy, 'optional');
}

// ── 4) Unavailable: object intent + direct wire both rejected ──
{
  const cfg = adminCfg([UNAVAILABLE_EQ]);
  const wire = quoteSync({
    guest_name: 'U',
    service_dates: [SERVICE_DATE],
    payment_status: 'unpaid',
    components: { course: { course_id: PACK_ID, tier_key: TIER, quantity: 1 } },
    course_equipment: [{ offering_key: 'wax', mode: 'during_course', quantity: 1 }],
  }, cfg, QUOTE_CHANNELS.MANUAL_STAFF);
  assert.equal(wire.ok, false, 'direct wire must reject unavailable during_course');
  assert.equal(wire.body.reason, 'invalid_course_equipment');

  const intent = quoteSync({
    guest_name: 'U2',
    service_dates: [SERVICE_DATE],
    payment_status: 'unpaid',
    components: { course: { course_id: PACK_ID, tier_key: TIER, quantity: 1 } },
    course_equipment: { mode: 'during_course', quantity: 1 },
  }, cfg, QUOTE_CHANNELS.MANUAL_STAFF);
  // Intent expands non-unavailable keys; with only unavailable, must fail not_configured
  assert.equal(intent.ok, false, JSON.stringify(intent.body));
  assert.ok(
    intent.body.reason === 'course_equipment_not_configured'
    || intent.body.reason === 'invalid_course_equipment',
    JSON.stringify(intent.body),
  );
}

// ── 5) Idempotency: omit included == explicit same wire; changed conflicts ──
{
  const cfg = adminCfg([INCLUDED_EQ]);
  const q = quoteSync({
    offering_id: PACK_ITEM,
    course_id: PACK_ID,
    quantity: 2,
    service_dates: [SERVICE_DATE],
  }, cfg);
  assert.equal(q.ok, true);
  const wire = q.body.course_equipment;
  assert.ok(Array.isArray(wire) && wire.length === 1);

  const base = {
    guest_name: 'Idem Guest',
    guest_phone: '+34600999888',
    payment_status: 'unpaid',
    service_dates: [SERVICE_DATE],
    components: { course: { course_id: PACK_ID, tier_key: TIER, quantity: 2 } },
    notes: '',
    needs_reply: false,
  };
  const fpOmitWithProv = buildScheduleBookingIntentFingerprint(base, LOC, {
    course_equipment: wire,
  });
  const fpExplicit = buildScheduleBookingIntentFingerprint({
    ...base,
    course_equipment: wire,
  }, LOC);
  assert.strictEqual(fpOmitWithProv, fpExplicit, 'omit+provenance wire == explicit same selection');

  const fpMode = buildScheduleBookingIntentFingerprint({
    ...base,
    course_equipment: [{ offering_key: GEAR_KEY, mode: 'all_day', quantity: 2 }],
  }, LOC);
  const fpQty = buildScheduleBookingIntentFingerprint({
    ...base,
    course_equipment: [{ offering_key: GEAR_KEY, mode: 'during_course', quantity: 1 }],
  }, LOC);
  const fpNone = buildScheduleBookingIntentFingerprint(base, LOC);
  assert.notStrictEqual(fpExplicit, fpMode);
  assert.notStrictEqual(fpExplicit, fpQty);
  assert.notStrictEqual(fpExplicit, fpNone);
}

// ── 6) Course all_day: one coherent line + English full-day label (non-course FDA) ──
{
  const cfg = adminCfg([INCLUDED_EQ]);
  const q = quoteSync({
    guest_name: 'AD',
    service_dates: [SERVICE_DATE],
    payment_status: 'unpaid',
    components: { course: { course_id: PACK_ID, tier_key: TIER, quantity: 2 } },
    course_equipment: [{ offering_key: GEAR_KEY, mode: 'all_day', quantity: 2 }],
  }, cfg, QUOTE_CHANNELS.MANUAL_STAFF);
  assert.equal(q.ok, true, JSON.stringify(q.body));
  const lines = gearLines(q.body);
  assert.strictEqual(lines.length, 1, 'exactly one all-day gear line');
  assert.strictEqual(lines[0].course_equipment_mode, 'all_day');
  assert.strictEqual(lines[0].total_cents, 1000 * 2 * 1);
  assert.ok(!lines.some((l) => l.course_equipment_mode === 'during_course'));

  // English drawer label for non-course full-day extension (correct signature)
  const lbl = drawer.formatSunsetDrawerDailyItemLabel('addon_service', 3, {
    metadata: {
      component: 'full_day_equipment_extension',
      service_key: 'full_day_equipment_extension',
    },
  });
  assert.match(String(lbl), /Full-day gear/);
  assert.ok(!/Material el resto del día/.test(String(lbl)));
}

// ── 7) Overlap rejected in quote / create validate / restore (real owner) ──
{
  const qBody = {
    guest_name: 'Ov',
    service_dates: [SERVICE_DATE],
    payment_status: 'unpaid',
    components: {
      course: { course_id: PACK_ID, tier_key: TIER, quantity: 1 },
      [FULL_DAY_EQUIPMENT_ADDON_KEY]: { enabled: true, dates: { [SERVICE_DATE]: 1 } },
    },
  };
  const q = quoteSync(qBody, adminCfg(), QUOTE_CHANNELS.MANUAL_STAFF);
  assert.equal(q.ok, false);
  assert.equal(q.body.reason, 'full_day_equipment_extension_not_with_course');

  const validated = validateScheduleBookingBody({
    guest_name: 'Ov',
    service_dates: [SERVICE_DATE],
    payment_status: 'unpaid',
    components: {
      course: { course_id: PACK_ID, tier_key: TIER, quantity: 1 },
      [FULL_DAY_EQUIPMENT_ADDON_KEY]: { enabled: true, dates: { [SERVICE_DATE]: 1 } },
    },
  }, { refDate: FIXED_NOW, horizonDays: 365 });
  assert.equal(validated.ok, false);
  assert.match(String(validated.error || ''), /full_day_equipment_extension_not_with_course/);

  const bookingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  /** Fake PG for restoreSunsetScheduleBooking — pack assign + rental stock + commit. */
  function makeRestorePg(bookingRow, services) {
    const log = [];
    let committed = false;
    let rolledBack = false;
    const serviceRows = (services || []).map((sr, i) => ({
      service_record_id: `cccccccc-cccc-4ccc-8ccc-ccccccccccc${i}`,
      service_type: sr.service_type,
      service_date: sr.service_date || SERVICE_DATE,
      quantity: sr.quantity || 1,
      amount_due_cents: sr.amount_due_cents || 0,
      amount_paid_cents: 0,
      payment_status: 'pending',
      status: 'cancelled',
      location_id: LOC,
      metadata_source: 'staff_manual_schedule',
      staff_manual_schedule: 'true',
      metadata_component: (sr.metadata && sr.metadata.component) || null,
      metadata: sr.metadata || {},
    }));
    return {
      log,
      services: serviceRows,
      committed: () => committed,
      rolledBack: () => rolledBack,
      mutations: () => log.filter((e) => (
        /^\s*UPDATE\b/i.test(e.s) || /^\s*INSERT\b/i.test(e.s) || /^\s*DELETE\b/i.test(e.s)
      )),
      async query(sql, params) {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        log.push({ s, params });
        if (/^BEGIN/i.test(s)) return { rows: [] };
        if (/^COMMIT/i.test(s)) { committed = true; return { rows: [] }; }
        if (/^ROLLBACK/i.test(s)) { rolledBack = true; return { rows: [] }; }
        if (s.includes('FROM bookings b') && s.includes('SELECT b.id::text')) {
          return { rows: [bookingRow] };
        }
        if (s.includes('FROM booking_service_records') && s.includes('SELECT id::text')) {
          return { rows: serviceRows };
        }
        if (s.includes('FROM payments p')) return { rows: [] };
        if (s.includes('SUM') && s.includes('amount_paid_cents')) {
          return { rows: [{ paid_total: 0 }] };
        }
        if (s.includes('UPDATE booking_service_records') || s.includes('UPDATE bookings')) {
          return { rowCount: 1, rows: [] };
        }
        if (/CREATE TABLE|CREATE INDEX/i.test(s)) return { rows: [] };
        if (s.includes('information_schema')) {
          return { rows: [{ '?column?': 1, exists: true }] };
        }
        // assertCourseAssignable → loadSurfPacksFromDb needs real pack id + schedule.
        if (s.includes('tenant_surf_pack_rules')) {
          return {
            rows: [{
              id: PACK_ID,
              label: 'Slice E Course',
              config_json: packRow().config_json,
              active: true,
              location_id: LOC,
            }],
          };
        }
        if (s.includes('AS seats') || (s.includes('COALESCE(SUM') && s.includes('booking_service_records'))) {
          return { rows: [{ seats: 0 }] };
        }
        // listRentalOfferings + lockRentalStockRows
        if (s.includes('tenant_rental_offerings') || (/FOR UPDATE/i.test(s) && /rental|offering/i.test(s))) {
          return {
            rows: OFFERINGS.map((o) => ({
              id: o.offering_key,
              offering_key: o.offering_key,
              label: o.label,
              active: true,
              stock_quantity: 20,
              client_slug: 'sunset',
              location_id: LOC,
              group_key: null,
              excludes: [],
              sort_order: 0,
            })),
          };
        }
        // Active reservation demand for stock recheck
        if (s.includes('booking_service_records')) return { rows: [] };
        return { rows: [] };
      },
    };
  }

  const baseBooking = {
    booking_id: bookingId,
    booking_code: 'SUNSET-CXL',
    guest_name: 'Restore Guest',
    status: 'cancelled',
    payment_status: 'unpaid',
    guest_count: 1,
    total_amount_cents: 4000,
    amount_paid_cents: 0,
    metadata: {
      source: 'staff_manual_schedule',
      staff_manual_schedule: true,
      location_id: LOC,
      cancelled_by_staff: true,
    },
  };

  // Course + FDA → reject, zero mutations
  const courseFdaPg = makeRestorePg(baseBooking, [
    {
      service_type: 'surf_lesson',
      service_date: SERVICE_DATE,
      quantity: 1,
      amount_due_cents: 4000,
      metadata: {
        component: 'course',
        course_id: PACK_ID,
        source: 'staff_manual_schedule',
        staff_manual_schedule: true,
        location_id: LOC,
      },
    },
    {
      service_type: 'addon_service',
      service_date: SERVICE_DATE,
      quantity: 1,
      amount_due_cents: 1000,
      metadata: {
        component: FULL_DAY_EQUIPMENT_ADDON_KEY,
        service_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
        source: 'staff_manual_schedule',
        staff_manual_schedule: true,
        location_id: LOC,
      },
    },
  ]);
  const courseFda = await drawer.restoreSunsetScheduleBooking(courseFdaPg, {
    clientSlug: 'sunset', bookingId, locationId: LOC,
  });
  assert.equal(courseFda.ok, false, JSON.stringify(courseFda.body));
  assert.equal(courseFda.body.reason_code || courseFda.body.error,
    'full_day_equipment_extension_not_with_course');
  assert.strictEqual(courseFdaPg.mutations().length, 0, 'reject must not mutate');

  // CE all_day + FDA → reject
  const ceFdaPg = makeRestorePg(baseBooking, [
    {
      service_type: 'addon_service',
      metadata: {
        course_equipment: true,
        course_equipment_mode: 'all_day',
        offering_key: GEAR_KEY,
        source: 'staff_manual_schedule',
        staff_manual_schedule: true,
        location_id: LOC,
      },
    },
    {
      service_type: 'addon_service',
      metadata: {
        component: FULL_DAY_EQUIPMENT_ADDON_KEY,
        service_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
        source: 'staff_manual_schedule',
        staff_manual_schedule: true,
        location_id: LOC,
      },
    },
  ]);
  const ceFda = await drawer.restoreSunsetScheduleBooking(ceFdaPg, {
    clientSlug: 'sunset', bookingId, locationId: LOC,
  });
  assert.equal(ceFda.ok, false, JSON.stringify(ceFda.body));
  assert.equal(ceFda.body.reason_code || ceFda.body.error, 'course_equipment_full_day_overlap');
  assert.strictEqual(ceFdaPg.mutations().length, 0);

  // Ordinary lesson (component:lesson) + FDA → real restore must succeed (not course).
  const lessonFdaServices = [
    {
      service_type: 'surf_lesson',
      service_date: SERVICE_DATE,
      quantity: 2,
      amount_due_cents: 4000,
      metadata: {
        component: 'lesson',
        source: 'staff_manual_schedule',
        staff_manual_schedule: true,
        location_id: LOC,
      },
    },
    {
      service_type: 'addon_service',
      service_date: SERVICE_DATE,
      quantity: 2,
      amount_due_cents: 2000,
      metadata: {
        component: FULL_DAY_EQUIPMENT_ADDON_KEY,
        service_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
        source: 'staff_manual_schedule',
        staff_manual_schedule: true,
        location_id: LOC,
      },
    },
  ];
  const lessonFdaPg = makeRestorePg(baseBooking, lessonFdaServices);
  const lessonFda = await drawer.restoreSunsetScheduleBooking(lessonFdaPg, {
    clientSlug: 'sunset', bookingId, locationId: LOC,
  });
  assert.equal(lessonFda.ok, true, JSON.stringify(lessonFda.body));
  assert.equal(lessonFda.body.restored, true, JSON.stringify(lessonFda.body));
  assert.equal(lessonFdaPg.committed(), true, 'lesson+FDA restore must COMMIT');
  assert.equal(lessonFdaPg.rolledBack(), false);
  assert.ok(lessonFdaPg.mutations().length >= 2, 'expect BSR + booking UPDATE');
  assert.ok(
    lessonFdaPg.mutations().some((m) => /UPDATE booking_service_records/i.test(m.s)),
    'must mutate booking_service_records',
  );
  assert.ok(
    lessonFdaPg.mutations().some((m) => /UPDATE bookings/i.test(m.s)),
    'must mutate bookings',
  );

  // Valid CE during_course restore: must succeed; CE metadata / policy provenance intact.
  const ceDuringServices = [
    {
      service_type: 'surf_lesson',
      service_date: SERVICE_DATE,
      quantity: 1,
      amount_due_cents: 4000,
      metadata: {
        component: 'course',
        course_id: PACK_ID,
        source: 'staff_manual_schedule',
        staff_manual_schedule: true,
        location_id: LOC,
      },
    },
    {
      service_type: 'addon_service',
      service_date: SERVICE_DATE,
      quantity: 1,
      amount_due_cents: 0,
      metadata: {
        course_equipment: true,
        course_equipment_mode: 'during_course',
        during_course_policy: 'included',
        offering_key: GEAR_KEY,
        label: 'Board and wetsuit',
        unit_amount_cents: 0,
        during_course_price_cents: 0,
        all_day_price_cents: 1000,
        source: 'staff_manual_schedule',
        staff_manual_schedule: true,
        location_id: LOC,
      },
    },
  ];
  const ceDuringPg = makeRestorePg(baseBooking, ceDuringServices);
  const ceDuring = await drawer.restoreSunsetScheduleBooking(ceDuringPg, {
    clientSlug: 'sunset', bookingId, locationId: LOC,
  });
  assert.equal(ceDuring.ok, true, JSON.stringify(ceDuring.body));
  assert.equal(ceDuring.body.restored, true, JSON.stringify(ceDuring.body));
  assert.equal(ceDuringPg.committed(), true, 'CE during_course restore must COMMIT');
  assert.equal(ceDuringPg.rolledBack(), false);
  assert.ok(ceDuringPg.mutations().length >= 2, 'expect BSR + booking UPDATE');
  // Production drawer aggregation: selection provenance + during_course_policy intact.
  const ceAgg = drawer.aggregateComponentsFromServices(ceDuringPg.services);
  const cePill = (ceAgg.components && ceAgg.components.course_equipment) || [];
  assert.strictEqual(cePill.length, 1, JSON.stringify(ceAgg.components));
  assert.equal(cePill[0].offering_key, GEAR_KEY);
  assert.equal(cePill[0].mode, 'during_course');
  assert.equal(cePill[0].during_course_policy, 'included');
  assert.equal(cePill[0].quantity, 1);
  // Restored service metadata must still carry policy snap (restore only clears archive flag).
  const ceMeta = ceDuringPg.services.find((s) => s.metadata && s.metadata.course_equipment === true);
  assert.ok(ceMeta, 'CE service row present');
  assert.equal(ceMeta.metadata.during_course_policy, 'included');
  assert.equal(ceMeta.metadata.course_equipment_mode, 'during_course');
  assert.equal(ceMeta.metadata.offering_key, GEAR_KEY);
}

// ── 7b) CE stock claims use exact service dates (Mon+Thu ≠ Tue/Wed) ──
{
  const stock = require('./lib/tenant-rental-stock-service');
  const monThu = ['2026-09-07', '2026-09-10']; // Mon + Thu
  const claims = stock.collectCourseEquipmentStockClaims(
    [{ offering_key: GEAR_KEY, mode: 'during_course', quantity: 2 }],
    monThu[0],
    monThu[1],
    monThu,
  );
  assert.equal(claims.ok, true, JSON.stringify(claims));
  assert.deepStrictEqual(claims.claims[0].dates, monThu);
  assert.ok(!claims.claims[0].dates.includes('2026-09-08'), 'must not claim Tue');
  assert.ok(!claims.claims[0].dates.includes('2026-09-09'), 'must not claim Wed');
  assert.strictEqual(claims.claims[0].quantity, 2);

  // Range fallback still contiguous when serviceDates omitted
  const range = stock.collectCourseEquipmentStockClaims(
    [{ offering_key: GEAR_KEY, quantity: 1 }],
    monThu[0],
    monThu[1],
  );
  assert.equal(range.ok, true);
  assert.ok(range.claims[0].dates.includes('2026-09-08'), 'range fallback includes mid week');

  // Conflict on Mon when stock exhausted that day only
  const conflictPg = {
    async query(sql, params) {
      const s = String(sql);
      if (/FOR UPDATE/i.test(s) || /tenant_rental_offerings/i.test(s)) {
        return {
          rows: [{
            id: '1', client_slug: 'sunset', location_id: LOC,
            offering_key: GEAR_KEY, stock_quantity: 1, active: true,
            stock_scope: 'location',
          }],
        };
      }
      if (/booking_service_records/i.test(s)) {
        return {
          rows: [{
            booking_id: 'other',
            offering_key: GEAR_KEY,
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
  assert.equal(asserted.ok, false, 'Mon conflict must fail closed');
  assert.ok(
    asserted.error === 'rental_stock_unavailable'
    || (asserted.body && asserted.body.error === 'rental_stock_unavailable'),
    JSON.stringify(asserted),
  );
}

// ── 8) Plugin: course + private_lesson CE contracts → exact wire POST ──
{
  const { execFileSync } = require('child_process');
  const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'docker', 'hermes-staging', 'plugins'))})
import wolfhouse_staff_api as mod

calls = []
def fake(path, payload):
    calls.append((path, dict(payload or {})))
    return {"success": True, "booking_id": "b1", "booking_code": "SUNSET-E", "total_cents": 4000}
mod._post_bot = fake

def run(payload):
    calls.clear()
    return json.loads(mod.create_sunset_booking(payload)), list(calls)

wire = [{"offering_key": ${JSON.stringify(GEAR_KEY)}, "mode": "during_course", "quantity": 2}]
prov = {
  "quote_fingerprint": "a" * 64,
  "quote_lane": "exact_offering",
  "total_cents": 4000,
  "course_equipment": wire,
  "line_items": [
    {"total_cents": 4000},
    {"course_equipment": True, "course_equipment_mode": "during_course", "quantity": 2, "total_cents": 0},
  ],
}
# Course included omitted CE
out, c = run({
  "guest_name": "Plugin Guest", "guest_confirmed_booking": True, "location_id": "sunset-somo",
  "service_dates": [${JSON.stringify(SERVICE_DATE)}],
  "components": {"course": {"course_id": ${JSON.stringify(PACK_ID)}, "tier_key": "1_day", "quantity": 2}},
  "quote_provenance": prov,
})
assert out.get("success") is True, out
body = next(b for p,b in c if "booking-create" in p)
assert body.get("course_equipment") == wire, body.get("course_equipment")

# Private lesson intent + provenance → exact wire
priv_wire = [{"offering_key": ${JSON.stringify(GEAR_KEY)}, "mode": "all_day", "quantity": 1}]
priv_prov = {
  "quote_fingerprint": "b" * 64, "total_cents": 7000,
  "course_equipment": priv_wire,
  "line_items": [
    {"total_cents": 6000},
    {"course_equipment": True, "course_equipment_mode": "all_day", "quantity": 1, "total_cents": 1000},
  ],
}
out, c = run({
  "guest_name": "Private Guest", "guest_confirmed_booking": True, "location_id": "sunset-somo",
  "service_dates": [${JSON.stringify(SERVICE_DATE)}],
  "components": {"private_lesson": {"surfer_count": 1, "quantity": 1,
    "sessions": [{"date": ${JSON.stringify(SERVICE_DATE)}, "start": "10:00", "end": "12:00"}]}},
  "course_equipment": {"mode": "all_day", "quantity": 1},
  "quote_provenance": priv_prov,
})
assert out.get("success") is True, out
body = next(b for p,b in c if "booking-create" in p)
assert body.get("course_equipment") == priv_wire, body.get("course_equipment")

# Private included omitted CE
out, c = run({
  "guest_name": "Private Inc", "guest_confirmed_booking": True, "location_id": "sunset-somo",
  "service_dates": [${JSON.stringify(SERVICE_DATE)}],
  "components": {"private_lesson": {"surfer_count": 2, "quantity": 1,
    "sessions": [{"date": ${JSON.stringify(SERVICE_DATE)}, "start": "10:00", "end": "12:00"}]}},
  "quote_provenance": {
    "quote_fingerprint": "c" * 64, "total_cents": 6000,
    "course_equipment": wire,
    "line_items": [
      {"total_cents": 6000},
      {"course_equipment": True, "course_equipment_mode": "during_course", "quantity": 2, "total_cents": 0},
    ],
  },
})
assert out.get("success") is True, out
body = next(b for p,b in c if "booking-create" in p)
assert body.get("course_equipment") == wire

# Invalid qty > private surfer_count
out, c = run({
  "guest_name": "Bad Qty", "guest_confirmed_booking": True, "location_id": "sunset-somo",
  "service_dates": [${JSON.stringify(SERVICE_DATE)}],
  "components": {"private_lesson": {"surfer_count": 1, "quantity": 1,
    "sessions": [{"date": ${JSON.stringify(SERVICE_DATE)}, "start": "10:00", "end": "12:00"}]}},
  "course_equipment": {"mode": "during_course", "quantity": 3},
  "quote_provenance": priv_prov,
})
assert out.get("success") is False and out.get("error") == "course_equipment_invalid", out
assert not any("booking-create" in p for p,_ in c)

# Private + full_day extension rejected
out, c = run({
  "guest_name": "PrivFda", "guest_confirmed_booking": True, "location_id": "sunset-somo",
  "service_dates": [${JSON.stringify(SERVICE_DATE)}],
  "components": {
    "private_lesson": {"surfer_count": 1, "quantity": 1,
      "sessions": [{"date": ${JSON.stringify(SERVICE_DATE)}, "start": "10:00", "end": "12:00"}]},
    "full_day_equipment_extension": {"enabled": True, "dates": {${JSON.stringify(SERVICE_DATE)}: 1}},
  },
})
assert out.get("success") is False and out.get("error") == "full_day_equipment_extension_not_with_course", out

print("PLUGIN_PRIVATE_AND_COURSE_CE_OK")
`;
  const out = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
  assert.ok(out.includes('PLUGIN_PRIVATE_AND_COURSE_CE_OK'), out);
}

// ── 8b) STATIC registration only (not behavioral proof) ──
// Route handlers (auth + location + invoke owners) are not safely callable offline
// without invasive FORTRESS/refactor. Captain live path is the final route gate.
// Behavioral acceptance above uses exported owners only:
//   executeSunsetBookingCreate, restoreSunsetScheduleBooking, executeSunsetQuote,
//   plugin create_sunset_booking wire body.
// Contractual surface: pathnames remain registered in staff-query-api (static).
{
  const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  assert.ok(
    apiSrc.includes("pathname === '/staff/bot/sunset/booking-create'"),
    'STATIC: /staff/bot/sunset/booking-create remains registered',
  );
  assert.ok(
    apiSrc.includes("pathname === '/staff/schedule/bookings/restore'"),
    'STATIC: /staff/schedule/bookings/restore remains registered',
  );
}

// ── 9) STATIC absence: no semantic duplicate-as-new resurrect path ──
{
  const root = path.join(__dirname, '..');
  const candidates = [
    'scripts/lib/sunset-schedule-booking-drawer.js',
    'scripts/lib/sunset-schedule-booking-writes.js',
    'scripts/staff-query-api.js',
  ];
  let foundDuplicateAsNew = false;
  for (const rel of candidates) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    if (/duplicateAsNew|duplicate_as_new|cloneScheduleBooking|copyBookingAsNew/i.test(src)) {
      foundDuplicateAsNew = true;
    }
  }
  assert.equal(
    foundDuplicateAsNew,
    false,
    'STATIC: no duplicate-as-new schedule booking path; restore is the only resurrect surface',
  );
}

console.log('verify:sunset-course-equipment-slice-e — ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
