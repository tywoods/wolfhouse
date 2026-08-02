'use strict';

/**
 * verify:sunset-rental-create-price-lookup-p1c
 *
 * Diagnose-then-fix for live rental_bundle_price_unavailable.
 *
 * Root causes addressed:
 *  1) Hermes create forced board+suit into historical surfboard+wetsuit halves and
 *     re-quoted only board_and_suit_rental (live may use surfboard_wetsuit_rental).
 *  2) rental_pricing was not promoted to rentals[] for generics (bike, towel, …).
 *  3) P0b: after concrete catalog selection, price resolution is exact offering_key
 *     only (no board+suit / surfboard_wetsuit alias borrow). Alias family remains
 *     available for pre-selection text/intent normalization only.
 *
 * Fixture mirrors LIVE loader shape (Monshies):
 *  - tenant_price_rules: no offering_key col; item_code compound; unit day|session
 *  - includes surfboard_wetsuit_rental__1_day + bike_rental__1_day
 *
 * Layer A: lookupSunsetRentalPriceAsync + resolveGenericRentalPrice on fixture
 * Layer B: executeSunsetBookingCreate (fake PG with live-shaped rules)
 * Layer C: plugin source contracts (no historical half expansion on rental_pricing)
 *
 * Run: node scripts/verify-sunset-rental-create-price-lookup-p1c.js
 */

const fs = require('fs');
const path = require('path');
const {
  lookupSunsetRentalPriceAsync,
  rentalOfferingKeyCandidates,
  findAdminPriceRule,
  adminPriceRuleAmountCents,
} = require('./lib/sunset-rental-price-lookup');
const { resolveGenericRentalPrice } = require('./lib/tenant-rental-price-resolver');
const {
  configuredRentalBundleTotalCents,
  findPriceCents,
} = require('./lib/sunset-stripe-payment-links');
const {
  BOOKING_CREATE_CHANNELS,
  buildSunsetBookingCreateCommand,
  executeSunsetBookingCreate,
} = require('./lib/luna-front-desk-booking-create-service');
const {
  isExactOfferingFutureWriteKey,
} = require('./lib/sunset-schedule-booking-writes');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.error(`  FAIL  ${label}${detail != null ? ` — ${String(detail).slice(0, 320)}` : ''}`);
  }
}

const LOC = 'sunset-somo';
const SERVICE_DATE = '2026-08-22';
const FIXED_NOW = new Date('2026-07-14T12:00:00Z');

/**
 * Snapshot-shaped rows as returned by tenant_price_rules → mapPriceRows on live:
 * offering_key = item_code (compound), unit = billing grain.
 */
const LIVE_MAPPED_PRICES = [
  {
    category: 'rental',
    offering_key: 'bike_rental__1_day',
    item_code: 'bike_rental__1_day',
    unit: 'day',
    amount: 12,
    amount_cents: 1200,
    active: true,
    source: 'db',
  },
  {
    category: 'rental',
    offering_key: 'surfboard_wetsuit_rental__1_day',
    item_code: 'surfboard_wetsuit_rental__1_day',
    unit: 'day',
    amount: 25,
    amount_cents: 2500,
    active: true,
    source: 'db',
  },
  {
    category: 'rental',
    offering_key: 'board_and_suit_rental__1_day',
    item_code: 'board_and_suit_rental__1_day',
    unit: 'day',
    amount: 20,
    amount_cents: 2000,
    active: true,
    source: 'db',
  },
  {
    category: 'rental',
    offering_key: 'towel_rental__1_day',
    item_code: 'towel_rental__1_day',
    unit: 'item',
    amount: 3,
    amount_cents: 300,
    active: true,
    source: 'db',
  },
  {
    category: 'rental',
    offering_key: 'sup_rental__1_day',
    item_code: 'sup_rental__1_day',
    unit: 'day',
    amount: 30,
    amount_cents: 3000,
    active: true,
    source: 'db',
  },
];

/** Raw DB rows for loadTenantPriceRuleFromDb mock. */
const LIVE_DB_RULES = LIVE_MAPPED_PRICES.map((p) => ({
  id: `id-${p.item_code}`,
  item_type: 'rental',
  item_code: p.item_code,
  amount_cents: p.amount_cents,
  currency: 'EUR',
  unit: p.unit,
  location_id: LOC,
  active: true,
}));

const OFFERINGS = [
  'bike_rental',
  'surfboard_wetsuit_rental',
  'board_and_suit_rental',
  'towel_rental',
  'sup_rental',
  'unicorn_rental',
].map((k, i) => ({
  id: `o-${i}`,
  client_slug: 'sunset',
  location_id: LOC,
  offering_key: k,
  label: k,
  active: true,
  stock_quantity: 20,
  sort_order: i,
  excludes: [],
}));

function makeLoadRule(rules) {
  return async (params) => {
    const offeringKey = String(params.itemCode || '').trim();
    const durationKey = String(params.duration || '').trim();
    const billingUnit = String(params.billingUnit || '').trim();
    const code = durationKey ? `${offeringKey}__${durationKey}` : offeringKey;
    const hit = rules.find((r) => String(r.item_code) === code && String(r.unit) === billingUnit);
    if (!hit) return { status: 'not_found', location_id: LOC };
    return {
      status: 'found',
      amount_cents: hit.amount_cents,
      currency: 'EUR',
      item_type: 'rental',
      item_code: hit.item_code,
      unit: hit.unit,
      location_id: LOC,
    };
  };
}

function makeCreatePg(opts = {}) {
  const rules = opts.rules || LIVE_DB_RULES;
  const offerings = opts.offerings || OFFERINGS;
  const bookingCode = opts.bookingCode || 'SUNSET-20260822-P1C';
  const state = {
    bookingInserts: 0,
    serviceInserts: 0,
    committed: false,
    rolledBack: false,
    bookingId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    bookingCode,
    lastBookingMeta: null,
    services: [],
    priceLookups: [],
  };

  const pg = {
    state,
    query: async (sql, params = []) => {
      const q = String(sql);
      if (/^BEGIN/i.test(q)) return { rows: [] };
      if (/^COMMIT/i.test(q)) { state.committed = true; return { rows: [] }; }
      if (/^ROLLBACK/i.test(q)) { state.rolledBack = true; return { rows: [] }; }
      if (/pg_advisory/i.test(q)) return { rows: [] };
      if (/to_regclass/i.test(q)) return { rows: [{ reg: 'tenant_price_rules' }] };
      if (/information_schema/i.test(q)) {
        return {
          rows: [
            { column_name: 'location_id', table_name: 'tenant_price_rules', '?column?': 1 },
            { column_name: 'effective_from', table_name: 'tenant_price_rules' },
            { column_name: 'effective_to', table_name: 'tenant_price_rules' },
            { column_name: 'updated_at', table_name: 'tenant_price_rules' },
          ],
        };
      }
      if (/pg_constraint/i.test(q)) {
        return {
          rows: [{
            definition: "CHECK ((service_type)::text = ANY ((ARRAY['addon_service'::character varying])::text[]))",
          }],
        };
      }
      if (/SELECT id FROM clients WHERE slug/i.test(q)) return { rows: [{ id: 'client-sunset' }] };

      if (/FROM tenant_rental_offerings/i.test(q)) {
        // Stock lock: offering_key = ANY($n::text[])
        const keysParam = params.find((p) => Array.isArray(p));
        if (keysParam || /FOR UPDATE/i.test(q) || /stock_quantity/i.test(q)) {
          const keys = Array.isArray(keysParam)
            ? keysParam.map(String)
            : offerings.map((o) => o.offering_key);
          const rows = offerings
            .filter((o) => o.active !== false && keys.includes(String(o.offering_key)))
            .map((o) => ({
              id: o.id,
              client_slug: 'sunset',
              location_id: o.location_id || LOC,
              offering_key: o.offering_key,
              stock_quantity: o.stock_quantity != null ? o.stock_quantity : 99,
              active: true,
            }));
          return { rows };
        }
        return { rows: offerings.filter((o) => o.active !== false) };
      }

      if (/booking_service_records/i.test(q) && /offering_key/i.test(q)
        && /NOT IN\s*\(\s*'cancelled'/i.test(q) && !/INSERT/i.test(q)) {
        return { rows: [] };
      }

      if (/FROM tenant_price_rules/i.test(q)) {
        // Full list
        if (/ORDER BY item_type, item_code, unit/i.test(q)
          || (/SELECT id, item_type, item_code/i.test(q) && !/LIMIT 1/i.test(q))) {
          return { rows: rules.map((r) => ({ ...r, display_name: r.item_code, effective_from: null, effective_to: null, updated_at: '2026-06-01' })) };
        }
        // Exact lookup — log inputs for diagnosis
        const itemCode = params.find((p) => typeof p === 'string' && String(p).includes('__'))
          || params[2];
        const unit = params[3];
        state.priceLookups.push({ item_code: itemCode, unit, params: params.slice() });
        const hit = rules.find((r) => String(r.item_code) === String(itemCode)
          && (unit == null || String(r.unit) === String(unit)));
        if (!hit) return { rows: [] };
        return { rows: [hit] };
      }

      if (/FROM tenant_surf_pack_rules/i.test(q)) return { rows: [] };
      if (/FROM tenant_private_lesson_rules/i.test(q)) return { rows: [] };
      if (/FROM tenant_lesson_/i.test(q)) return { rows: [] };
      if (/FROM tenant_config_audit_log/i.test(q)) return { rows: [] };
      if (/COALESCE\(SUM/i.test(q)) return { rows: [{ seats: 0 }] };
      if (/idempotency_key/i.test(q)) return { rows: [] };

      if (/INSERT INTO bookings/i.test(q)) {
        state.bookingInserts += 1;
        for (const p of params) {
          if (typeof p === 'string' && p.trim().startsWith('{')) {
            try { state.lastBookingMeta = JSON.parse(p); } catch (_) { /* */ }
          } else if (p && typeof p === 'object' && !Array.isArray(p)) {
            state.lastBookingMeta = p;
          }
        }
        return { rows: [{ id: state.bookingId, booking_code: state.bookingCode }] };
      }
      if (/INSERT INTO booking_service_records/i.test(q)) {
        state.serviceInserts += 1;
        let meta = {};
        for (const p of params) {
          if (typeof p === 'string' && p.trim().startsWith('{')) {
            try { meta = JSON.parse(p); } catch (_) { /* */ }
          } else if (p && typeof p === 'object' && !Array.isArray(p)) meta = p;
        }
        const row = {
          id: `sr-${state.serviceInserts}`,
          service_type: params[4] || 'addon_service',
          service_date: params[5] || SERVICE_DATE,
          quantity: params[6] || 1,
          amount_due_cents: 0,
          metadata: meta,
        };
        state.services.push(row);
        return {
          rows: [{
            service_record_id: row.id,
            booking_id: state.bookingId,
            booking_code: state.bookingCode,
            guest_name: params[3],
            service_type: row.service_type,
            service_date: row.service_date,
            quantity: row.quantity,
            amount_due_cents: 0,
            payment_status: params[7],
            record_source: params[8],
            metadata: meta,
          }],
        };
      }
      if (/SELECT metadata FROM bookings/i.test(q)) {
        return {
          rows: [{
            metadata: state.lastBookingMeta || { location_id: LOC, source: 'agent_luna_whatsapp_bot' },
          }],
        };
      }
      if (/SELECT id, service_type/i.test(q) && /FROM booking_service_records/i.test(q)) {
        return {
          rows: state.services.map((s) => ({
            id: s.id,
            service_type: s.service_type,
            service_date: s.service_date,
            quantity: s.quantity,
            amount_due_cents: s.amount_due_cents,
            metadata: s.metadata,
          })),
        };
      }
      if (/UPDATE /i.test(q)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
  };
  return pg;
}

function buildCmd(body) {
  return buildSunsetBookingCreateCommand({
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    trustedLocationId: LOC,
    transportBody: {
      guest_name: 'P1c Guest',
      guest_confirmed_booking: true,
      payment_status: 'unpaid',
      service_date: SERVICE_DATE,
      service_dates: [SERVICE_DATE],
      date_from: SERVICE_DATE,
      date_to: SERVICE_DATE,
      components: {},
      ...body,
    },
    now: FIXED_NOW,
  });
}

async function main() {
  console.log('\nverify:sunset-rental-create-price-lookup-p1c\n');
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

  console.log('[diagnose] live-shaped prices present keys:');
  console.log(' ', LIVE_MAPPED_PRICES.map((p) => `${p.item_code} unit=${p.unit} cents=${p.amount_cents}`).join('\n  '));

  // ── A) Shared resolver on live-shaped fixture ─────────────────────────────
  console.log('\n[A] Resolvers on live mapPriceRows shape');
  ok('candidates include surfboard_wetsuit + board_and_suit',
    rentalOfferingKeyCandidates('board_and_suit_rental').includes('surfboard_wetsuit_rental')
    && rentalOfferingKeyCandidates('surfboard_wetsuit_rental').includes('board_and_suit_rental'));

  ok('findAdminPriceRule bike compound',
    adminPriceRuleAmountCents(findAdminPriceRule({ prices: LIVE_MAPPED_PRICES }, 'bike_rental', '1_day')) === 1200);
  ok('findAdminPriceRule surfboard_wetsuit compound',
    adminPriceRuleAmountCents(findAdminPriceRule({ prices: LIVE_MAPPED_PRICES }, 'surfboard_wetsuit_rental', '1_day')) === 2500);
  ok('findPriceCents bike via shared',
    findPriceCents(LIVE_MAPPED_PRICES, 'rental', 'bike_rental', '1_day') === 1200);
  ok('configured surfboard_wetsuit qty2',
    configuredRentalBundleTotalCents(LIVE_MAPPED_PRICES, {
      offering_key: 'surfboard_wetsuit_rental', duration: '1_day', quantity: 2,
    }) === 5000);

  const loadRule = makeLoadRule(LIVE_DB_RULES);
  const bikeQuote = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset',
    location_id: LOC,
    item: 'bike_rental',
    duration: '1_day',
    require_confirmed: false,
    loadRule,
  });
  ok('async quote bike found', bikeQuote.ok === true && bikeQuote.amount_cents === 1200, bikeQuote);

  // Exact board_and_suit when both family rows exist — no cross-key borrow.
  const basExact = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset',
    location_id: LOC,
    item: 'board_and_suit_rental',
    duration: '1_day',
    require_confirmed: false,
    loadRule,
  });
  ok('async quote board_and_suit exact row (no family borrow)',
    basExact.ok === true && basExact.amount_cents === 2000
    && basExact.item === 'board_and_suit_rental',
    basExact);

  // Only surfboard_wetsuit in rules — board_and_suit must fail closed (P0b exact-only).
  const onlySw = LIVE_DB_RULES.filter((r) => r.item_code.startsWith('surfboard_wetsuit') || r.item_code.startsWith('bike'));
  const loadOnlySw = makeLoadRule(onlySw);
  const viaAlias = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset',
    location_id: LOC,
    item: 'board_and_suit_rental',
    duration: '1_day',
    require_confirmed: false,
    loadRule: loadOnlySw,
  });
  ok('board_and_suit does not alias to surfboard_wetsuit when exact missing (P0b)',
    viaAlias.ok === false,
    viaAlias);

  const genBike = await resolveGenericRentalPrice({
    clientSlug: 'sunset',
    locationId: LOC,
    offeringKey: 'bike_rental',
    durationKey: '1_day',
    quantity: 1,
    loadRule,
  });
  ok('generic create price bike', genBike.ok === true && genBike.unit_cents === 1200, genBike);

  const genSw = await resolveGenericRentalPrice({
    clientSlug: 'sunset',
    locationId: LOC,
    offeringKey: 'board_and_suit_rental',
    durationKey: '1_day',
    quantity: 1,
    loadRule: loadOnlySw,
  });
  ok('generic create refuses board_and_suit → surfboard_wetsuit alias borrow (P0b)',
    genSw.ok === false && genSw.reason === 'price_not_found', genSw);

  const genSwExact = await resolveGenericRentalPrice({
    clientSlug: 'sunset',
    locationId: LOC,
    offeringKey: 'surfboard_wetsuit_rental',
    durationKey: '1_day',
    quantity: 1,
    loadRule: loadOnlySw,
  });
  ok('generic create exact surfboard_wetsuit_rental',
    genSwExact.ok === true && genSwExact.unit_cents === 2500
    && genSwExact.item_code === 'surfboard_wetsuit_rental__1_day'
    && genSwExact.offering_key === 'surfboard_wetsuit_rental',
    genSwExact);

  ok('unpriced still null',
    configuredRentalBundleTotalCents(LIVE_MAPPED_PRICES, {
      offering_key: 'unicorn_rental', duration: '1_day', quantity: 1,
    }) == null);

  // ── B) Real create path ───────────────────────────────────────────────────
  console.log('\n[B] executeSunsetBookingCreate with live-shaped rules');

  // B1 bike via rentals[]
  {
    const pg = makeCreatePg({ bookingCode: 'SUNSET-20260822-BIKE' });
    const built = buildCmd({
      rentals: [{ offering_key: 'bike_rental', duration_key: '1_day', quantity: 1 }],
      rental_pricing: {
        offering_key: 'bike_rental', duration: '1_day', quantity: 1, quoted_total_cents: 1200,
      },
    });
    ok('bike cmd builds', built.ok === true, built);
    const out = await executeSunsetBookingCreate(pg, built.command);
    const code = out && out.body && out.body.booking_code;
    ok('bike create ok', out && out.ok === true, JSON.stringify(out && out.body || out).slice(0, 280));
    ok('bike SUNSET code', typeof code === 'string' && /^SUNSET-/.test(code), code);
    ok('bike wrote booking+service', pg.state.bookingInserts >= 1 && pg.state.serviceInserts >= 1);
    ok('bike committed', pg.state.committed === true && pg.state.rolledBack === false);
    ok('bike total > 0', out && out.body && Number(out.body.total_cents) > 0, out && out.body && out.body.total_cents);
    ok('bike price lookup used compound item_code',
      pg.state.priceLookups.some((l) => String(l.item_code).includes('bike_rental')),
      JSON.stringify(pg.state.priceLookups));
  }

  // B2 bike via rental_pricing ONLY (plugin promotion)
  {
    const pg = makeCreatePg({ bookingCode: 'SUNSET-20260822-BIKE2' });
    const built = buildCmd({
      rental_pricing: {
        offering_key: 'bike_rental', duration: '1_day', quantity: 1, quoted_total_cents: 1200,
      },
    });
    const out = await executeSunsetBookingCreate(pg, built.command);
    ok('bike rental_pricing-only create ok', out && out.ok === true, JSON.stringify(out && out.body || out).slice(0, 280));
    ok('bike rental_pricing-only SUNSET', out && out.body && /^SUNSET-/.test(String(out.body.booking_code || '')));
  }

  // B3 surfboard_wetsuit exact offering
  {
    const pg = makeCreatePg({ bookingCode: 'SUNSET-20260822-SW' });
    const built = buildCmd({
      rentals: [{ offering_key: 'surfboard_wetsuit_rental', duration_key: '1_day', quantity: 2 }],
      rental_pricing: {
        offering_key: 'surfboard_wetsuit_rental', duration: '1_day', quantity: 2, quoted_total_cents: 5000,
      },
    });
    const out = await executeSunsetBookingCreate(pg, built.command);
    ok('surfboard_wetsuit create ok', out && out.ok === true, JSON.stringify(out && out.body || out).slice(0, 280));
    ok('surfboard_wetsuit SUNSET', out && out.body && /^SUNSET-/.test(String(out.body.booking_code || '')));
    ok('surfboard_wetsuit is exact offering key', isExactOfferingFutureWriteKey('surfboard_wetsuit_rental'));
    const metaOk = pg.state.services.some((s) => {
      const m = s.metadata || {};
      return m.offering_key === 'surfboard_wetsuit_rental' && m.rental_offering === true
        && !m.bundle_part;
    });
    ok('surfboard_wetsuit service is exact (no bundle_part halves)', metaOk, JSON.stringify(pg.state.services.map((s) => s.metadata)));
    ok('surfboard_wetsuit total >= 5000', out && out.body && Number(out.body.total_cents) >= 5000, out && out.body && out.body.total_cents);
  }

  // B4 board_and_suit when only surfboard_wetsuit priced → fail closed (P0b exact-only)
  {
    const pg = makeCreatePg({
      bookingCode: 'SUNSET-20260822-ALIAS',
      rules: LIVE_DB_RULES.filter((r) => !r.item_code.startsWith('board_and_suit')),
    });
    const built = buildCmd({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      rental_pricing: {
        offering_key: 'board_and_suit_rental', duration: '1_day', quantity: 1, quoted_total_cents: 2500,
      },
    });
    const out = await executeSunsetBookingCreate(pg, built.command);
    ok('board_and_suit create does not borrow surfboard_wetsuit price (P0b fail-closed)',
      out && out.ok === false, JSON.stringify(out && out.body || out).slice(0, 280));
    ok('alias-miss create zero durable booking write',
      !pg.state.committed || pg.state.rolledBack === true || pg.state.bookingInserts === 0);
  }

  // B5 unpriced
  {
    const pg = makeCreatePg({ bookingCode: 'SUNSET-NOPE' });
    const built = buildCmd({
      rentals: [{ offering_key: 'unicorn_rental', duration_key: '1_day', quantity: 1 }],
    });
    const out = await executeSunsetBookingCreate(pg, built.command);
    ok('unpriced fails closed', out && out.ok === false, JSON.stringify(out && out.body || out).slice(0, 200));
    ok('unpriced no commit write', pg.state.bookingInserts === 0 || pg.state.committed === false || pg.state.rolledBack === true);
  }

  // ── C) Plugin source contracts ────────────────────────────────────────────
  console.log('\n[C] Plugin source contracts');
  const pluginSrc = fs.readFileSync(
    path.join(__dirname, '../docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py'),
    'utf8',
  );
  ok('plugin promotes rentals[] from rental_pricing',
    /body\["rentals"\]\s*=\s*\[/.test(pluginSrc) && /offering_key.: resolved_item/.test(pluginSrc));
  ok('plugin does not rebuild surfboard+wetsuit halves for priced rental_pricing',
    !/norm_components\["surfboard"\]\s*=\s*\{\s*"quantity": qty,\s*"duration": duration\s*\}/.test(pluginSrc));
  ok('plugin tries surfboard_wetsuit_rental candidates',
    /surfboard_wetsuit_rental/.test(pluginSrc) && /_bundle_item_candidates|_rental_price_lookup/.test(pluginSrc));
  ok('plugin re-quotes via /sunset/rental-price (same as get_sunset_rental_price)',
    pluginSrc.includes('/sunset/rental-price'));

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  console.log('PASS verify:sunset-rental-create-price-lookup-p1c\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
