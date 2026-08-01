'use strict';

/**
 * verify:sunset-rental-create-price-lookup-p1
 *
 * P1b: create-side rental price verification must reuse the quote resolver
 * findAdminPriceRule (scripts/lib/sunset-rental-price-lookup.js) — bare
 * offering_key + unit/duration as separate fields — not a parallel compound
 * item_code inventing path.
 *
 * Layer A — pure: findAdminPriceRule + configuredRentalBundleTotalCents on a
 * fixture that mirrors live price-rule shape (offering_key + separate unit).
 * Layer B — behavioral: real executeSunsetBookingCreate (fake PG):
 *   1) bike_rental 1_day → SUNSET-… + write
 *   2) board_and_suit_rental 1_day → SUNSET-… + write
 *   3) unpriced → fail closed, no write
 *
 * Run: node scripts/verify-sunset-rental-create-price-lookup-p1.js
 */

const {
  findPriceCents,
  configuredRentalBundleTotalCents,
} = require('./lib/sunset-stripe-payment-links');
const {
  findAdminPriceRule,
  adminPriceRuleAmountCents,
  lookupSunsetRentalPrice,
} = require('./lib/sunset-rental-price-lookup');
const {
  BOOKING_CREATE_CHANNELS,
  buildSunsetBookingCreateCommand,
  executeSunsetBookingCreate,
} = require('./lib/luna-front-desk-booking-create-service');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.error(`  FAIL  ${label}${detail != null ? ` — ${String(detail).slice(0, 280)}` : ''}`);
  }
}

const LOC = 'sunset-somo';
const SERVICE_DATE = '2026-08-20';
const FIXED_NOW = new Date('2026-07-14T12:00:00Z');

/** Live/config shape: bare offering_key + duration in unit (quote-proven). */
const QUOTE_SHAPE_PRICES = [
  { category: 'rental', offering_key: 'bike_rental', unit: '1_day', amount: 15, active: true, pricing_status: 'confirmed' },
  { category: 'rental', offering_key: 'towel_rental', unit: '1_day', amount: 3, active: true, pricing_status: 'confirmed' },
  { category: 'rental', offering_key: 'sup_rental', unit: '1_day', amount: 30, active: true, pricing_status: 'confirmed' },
  { category: 'rental', offering_key: 'board_and_suit_rental', unit: '1_day', amount: 20, active: true, pricing_status: 'confirmed' },
  { category: 'rental', offering_key: 'board_and_suit_rental', unit: 'half_day', amount: 15, active: true, pricing_status: 'confirmed' },
  // distractor duration — must not steal half_day / 1_day matches
  { category: 'rental', offering_key: 'board_and_suit_rental', unit: '1_hour', amount: 10, active: true, pricing_status: 'confirmed' },
];

/** DB mapPriceRows-ish shape still supported via shared findAdminPriceRule secondary. */
const DB_SHAPE_PRICES = [
  { category: 'rental', offering_key: 'bike_rental__1_day', item_code: 'bike_rental__1_day', unit: 'day', amount: 15, amount_cents: 1500, active: true },
  { category: 'rental', offering_key: 'board_and_suit_rental__1_day', item_code: 'board_and_suit_rental__1_day', unit: 'day', amount: 20, amount_cents: 2000, active: true },
  { category: 'rental', offering_key: 'board_and_suit_rental__half_day', item_code: 'board_and_suit_rental__half_day', unit: 'session', amount: 15, amount_cents: 1500, active: true },
];

const OFFERINGS = [
  { id: 'o-bike', client_slug: 'sunset', location_id: LOC, offering_key: 'bike_rental', label: 'Bike rental', active: true, stock_quantity: 20, sort_order: 1, excludes: [] },
  { id: 'o-towel', client_slug: 'sunset', location_id: LOC, offering_key: 'towel_rental', label: 'Towel', active: true, stock_quantity: 50, sort_order: 2, excludes: [] },
  { id: 'o-sup', client_slug: 'sunset', location_id: LOC, offering_key: 'sup_rental', label: 'SUP', active: true, stock_quantity: 10, sort_order: 3, excludes: [] },
  { id: 'o-bas', client_slug: 'sunset', location_id: LOC, offering_key: 'board_and_suit_rental', label: 'Board + suit', active: true, stock_quantity: 15, sort_order: 4, excludes: [] },
  { id: 'o-ghost', client_slug: 'sunset', location_id: LOC, offering_key: 'unicorn_rental', label: 'Unicorn (no price)', active: true, stock_quantity: 5, sort_order: 5, excludes: [] },
];

function makeCreatePg(opts = {}) {
  const prices = opts.prices != null ? opts.prices : QUOTE_SHAPE_PRICES.map((p) => ({
    id: `p-${p.offering_key}-${p.unit}`,
    item_type: 'rental',
    item_code: `${p.offering_key}__${p.unit}`,
    // Keep BOTH shapes available to DB loaders: list load returns quote-shape rows.
    offering_key: p.offering_key,
    display_name: p.offering_key,
    currency: 'EUR',
    amount_cents: Math.round(Number(p.amount) * 100),
    unit: p.unit,
    active: true,
    location_id: LOC,
  }));
  const offerings = opts.offerings != null ? opts.offerings : OFFERINGS.slice();
  const bookingCode = opts.bookingCode || 'SUNSET-20260820-P1BIKE';
  const state = {
    inserts: [],
    bookingInserts: 0,
    serviceInserts: 0,
    committed: false,
    rolledBack: false,
    bookingId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    bookingCode,
    lastBookingMeta: null,
    services: [],
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
      if (/SELECT id FROM clients WHERE slug/i.test(q)) {
        return { rows: [{ id: 'client-sunset-uuid' }] };
      }

      if (/FROM tenant_rental_offerings/i.test(q)) {
        const isStockOnly = /stock_quantity/i.test(q)
          && !/\blabel\b/i.test(q)
          && (/FOR UPDATE/i.test(q) || /LIMIT 1/i.test(q));
        if (isStockOnly) {
          const key = params[params.length - 1];
          const hit = offerings.find((o) => String(o.offering_key) === String(key));
          if (!hit) return { rows: [] };
          return {
            rows: [{
              id: hit.id,
              client_slug: 'sunset',
              location_id: LOC,
              offering_key: hit.offering_key,
              stock_quantity: hit.stock_quantity != null ? hit.stock_quantity : 99,
              active: hit.active !== false,
            }],
          };
        }
        return {
          rows: offerings.filter((o) => o.active !== false).map((o) => ({
            ...o,
            client_slug: o.client_slug || 'sunset',
            location_id: o.location_id || LOC,
            stock_quantity: o.stock_quantity != null ? o.stock_quantity : 99,
          })),
        };
      }

      if (/booking_service_records/i.test(q)
        && /offering_key/i.test(q)
        && /NOT IN\s*\(\s*'cancelled'/i.test(q)
        && !/INSERT/i.test(q)) {
        return { rows: [] };
      }

      if (/FROM tenant_price_rules/i.test(q)) {
        // Live DB identity: item_code = offering__duration, unit = billing grain.
        // mapPriceRows projects offering_key=item_code; findAdminPriceRule secondary
        // matches that compound. prepareGenericRentals expects this identity.
        function billingUnitForDuration(dur) {
          const d = String(dur || '');
          if (/hour|half_day|lesson/i.test(d)) return 'session';
          if (d === '1_day' || d === 'full_day' || /^[1-9][0-9]*_days$/.test(d)) return 'day';
          return 'item';
        }
        function toDbRow(p, idx) {
          const amountCents = p.amount_cents != null
            ? Math.round(Number(p.amount_cents))
            : Math.round(Number(p.amount) * 100);
          const dur = p.unit; // quote-shape fixture stores duration in unit
          const itemCode = `${p.offering_key}__${dur}`;
          return {
            id: p.id || `db-${idx}`,
            item_type: 'rental',
            item_code: itemCode,
            display_name: p.offering_key,
            currency: 'EUR',
            amount_cents: amountCents,
            unit: billingUnitForDuration(dur),
            active: true,
            location_id: LOC,
            effective_from: null,
            effective_to: null,
            updated_at: '2026-06-01',
          };
        }
        const dbRows = QUOTE_SHAPE_PRICES.map((p, idx) => toDbRow(p, idx));

        if (/ORDER BY item_type, item_code, unit/i.test(q)
          || (/SELECT id, item_type, item_code/i.test(q) && !/LIMIT 1/i.test(q))) {
          return { rows: dbRows };
        }
        // Exact lookup — loadTenantPriceRuleFromDb uses composed item_code
        let match = null;
        for (const param of params) {
          const code = String(param || '');
          match = dbRows.find((x) => String(x.item_code) === code);
          if (match) break;
        }
        if (!match) {
          for (const param of params) {
            const code = String(param || '');
            if (!code.includes('__')) continue;
            match = dbRows.find((x) => String(x.item_code) === code);
            if (match) break;
          }
        }
        if (!match) return { rows: [] };
        return { rows: [match] };
      }

      if (/FROM tenant_surf_pack_rules/i.test(q)) return { rows: [] };
      if (/FROM tenant_private_lesson_rules/i.test(q)) return { rows: [] };
      if (/FROM tenant_lesson_capacity_rules/i.test(q)) return { rows: [] };
      if (/FROM tenant_lesson_time_rules/i.test(q)) return { rows: [] };
      if (/FROM tenant_config_audit_log/i.test(q)) return { rows: [] };
      if (/COALESCE\(SUM/i.test(q) && /booking_service_records/i.test(q)) {
        return { rows: [{ seats: 0, count: 0 }] };
      }
      if (/metadata->>'idempotency_key'/i.test(q)) return { rows: [] };

      if (/INSERT INTO bookings/i.test(q)) {
        state.bookingInserts += 1;
        state.inserts.push({ table: 'bookings', params: [...params] });
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
        state.inserts.push({ table: 'booking_service_records', params: [...params] });
        const metaRaw = params.find((p) => (typeof p === 'string' && p.trim().startsWith('{'))
          || (p && typeof p === 'object'));
        let meta = {};
        try {
          meta = typeof metaRaw === 'string' ? JSON.parse(metaRaw) : (metaRaw || {});
        } catch (_) { meta = {}; }
        const row = {
          id: `sr-${state.serviceInserts}`,
          service_record_id: `sr-${state.serviceInserts}`,
          booking_id: state.bookingId,
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
            amount_due_cents: row.amount_due_cents,
            payment_status: params[7],
            record_source: params[8],
            metadata: meta,
          }],
        };
      }

      if (/SELECT metadata FROM bookings/i.test(q)) {
        return {
          rows: [{
            metadata: state.lastBookingMeta || {
              location_id: LOC,
              source: 'agent_luna_whatsapp_bot',
              luna_guest_booking: true,
            },
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
      if (/UPDATE booking_service_records[\s\S]*amount_due_cents/i.test(q)
        || /UPDATE booking_service_records SET amount_due_cents/i.test(q)) {
        if (Number.isInteger(params[0])) {
          const id = params[1] || params[2];
          const hit = state.services.find((s) => String(s.id) === String(id)
            || String(s.service_record_id) === String(id));
          if (hit) hit.amount_due_cents = params[0];
        }
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE bookings\s+SET total_amount_cents/i.test(q)) {
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE bookings\s+SET status = 'cancelled'/i.test(q)) {
        state.rolledBack = true;
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE booking_service_records\s+SET status = 'cancelled'/i.test(q)) {
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE bookings SET/i.test(q) || /UPDATE booking_service_records/i.test(q)) {
        return { rows: [], rowCount: 1 };
      }

      return { rows: [] };
    },
  };
  return pg;
}

function buildRentalCommand(rentals) {
  return buildSunsetBookingCreateCommand({
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    trustedLocationId: LOC,
    transportBody: {
      guest_name: 'P1b Rental Guest',
      guest_phone: '+34600000001',
      guest_confirmed_booking: true,
      payment_status: 'unpaid',
      service_date: SERVICE_DATE,
      service_dates: [SERVICE_DATE],
      date_from: SERVICE_DATE,
      date_to: SERVICE_DATE,
      components: {},
      rentals,
    },
    now: FIXED_NOW,
  });
}

async function main() {
  console.log('\nverify:sunset-rental-create-price-lookup-p1 (P1b — shared findAdminPriceRule)\n');
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

  // ── A) Shared resolver = quote shape ──────────────────────────────────────
  console.log('[A] findAdminPriceRule on quote-shape fixture (offering_key + unit)');
  const cfg = { prices: QUOTE_SHAPE_PRICES };

  ok('bike rule via findAdminPriceRule', !!findAdminPriceRule(cfg, 'bike_rental', '1_day'));
  ok('bike amount 1500', adminPriceRuleAmountCents(findAdminPriceRule(cfg, 'bike_rental', '1_day')) === 1500);
  ok('towel amount 300', adminPriceRuleAmountCents(findAdminPriceRule(cfg, 'towel_rental', '1_day')) === 300);
  ok('sup amount 3000', adminPriceRuleAmountCents(findAdminPriceRule(cfg, 'sup_rental', '1_day')) === 3000);
  ok('board+suit 1_day 2000', adminPriceRuleAmountCents(findAdminPriceRule(cfg, 'board_and_suit_rental', '1_day')) === 2000);
  ok('board+suit half_day 1500 (not 1_hour)', adminPriceRuleAmountCents(findAdminPriceRule(cfg, 'board_and_suit_rental', 'half_day')) === 1500);
  ok('unpriced null', findAdminPriceRule(cfg, 'unicorn_rental', '1_day') == null);

  // create-side wrappers must equal the shared resolver
  ok('findPriceCents rental == findAdminPriceRule bike', findPriceCents(QUOTE_SHAPE_PRICES, 'rental', 'bike_rental', '1_day') === 1500);
  ok('findPriceCents rental == findAdminPriceRule bas half', findPriceCents(QUOTE_SHAPE_PRICES, 'rental', 'board_and_suit_rental', 'half_day') === 1500);
  ok(
    'configured bike qty1',
    configuredRentalBundleTotalCents(QUOTE_SHAPE_PRICES, { offering_key: 'bike_rental', duration: '1_day', quantity: 1 }) === 1500,
  );
  ok(
    'configured bas 1_day qty2',
    configuredRentalBundleTotalCents(QUOTE_SHAPE_PRICES, { offering_key: 'board_and_suit_rental', duration: '1_day', quantity: 2 }) === 4000,
  );
  ok(
    'configured bas half qty2',
    configuredRentalBundleTotalCents(QUOTE_SHAPE_PRICES, { offering_key: 'board_and_suit_rental', duration: 'half_day', quantity: 2 }) === 3000,
  );
  ok(
    'configured unpriced null',
    configuredRentalBundleTotalCents(QUOTE_SHAPE_PRICES, { offering_key: 'unicorn_rental', duration: '1_day', quantity: 1 }) == null,
  );

  // DB compound secondary still works through the SAME findAdminPriceRule
  ok(
    'DB-shape bike via shared resolver',
    adminPriceRuleAmountCents(findAdminPriceRule({ prices: DB_SHAPE_PRICES }, 'bike_rental', '1_day')) === 1500,
  );
  ok(
    'DB-shape bas half via shared resolver',
    adminPriceRuleAmountCents(findAdminPriceRule({ prices: DB_SHAPE_PRICES }, 'board_and_suit_rental', 'half_day')) === 1500,
  );
  ok(
    'create findPriceCents on DB-shape == shared',
    findPriceCents(DB_SHAPE_PRICES, 'rental', 'bike_rental', '1_day')
      === adminPriceRuleAmountCents(findAdminPriceRule({ prices: DB_SHAPE_PRICES }, 'bike_rental', '1_day')),
  );

  // live quote path still ok (baseline config)
  const liveQuote = lookupSunsetRentalPrice({
    client_slug: 'sunset',
    location_id: LOC,
    item: 'board_and_suit_rental',
    duration: 'half_day',
    require_confirmed: false,
  });
  ok('live quote half_day still ok', liveQuote && liveQuote.ok === true && liveQuote.amount_cents === 1500, liveQuote);

  // ── B) Real executeSunsetBookingCreate ────────────────────────────────────
  console.log('\n[B] executeSunsetBookingCreate (fake PG) — bike + board/suit + unpriced');

  {
    const pg = makeCreatePg({ bookingCode: 'SUNSET-20260820-BIKE1' });
    const built = buildRentalCommand([{ offering_key: 'bike_rental', duration_key: '1_day', quantity: 1 }]);
    ok('bike command builds', built.ok === true, built);
    const out = await executeSunsetBookingCreate(pg, built.command);
    const code = out && out.body && (out.body.booking_code || (out.body.booking && out.body.booking.booking_code));
    ok('bike create ok', out && out.ok === true, JSON.stringify(out && out.body || out).slice(0, 280));
    ok('bike SUNSET- code', typeof code === 'string' && /^SUNSET-/.test(code), code);
    ok('bike booking+service INSERT', pg.state.bookingInserts >= 1 && pg.state.serviceInserts >= 1);
    ok('bike committed', pg.state.committed === true && pg.state.rolledBack === false);
    ok('bike total_cents > 0', out && out.body && Number(out.body.total_cents) > 0, out && out.body && out.body.total_cents);
  }

  {
    const pg = makeCreatePg({ bookingCode: 'SUNSET-20260820-BAS1' });
    const built = buildRentalCommand([{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 2 }]);
    ok('bas command builds', built.ok === true, built);
    const out = await executeSunsetBookingCreate(pg, built.command);
    const code = out && out.body && (out.body.booking_code || (out.body.booking && out.body.booking.booking_code));
    ok('bas create ok', out && out.ok === true, JSON.stringify(out && out.body || out).slice(0, 280));
    ok('bas SUNSET- code', typeof code === 'string' && /^SUNSET-/.test(code), code);
    ok('bas booking+service INSERT', pg.state.bookingInserts >= 1 && pg.state.serviceInserts >= 1);
    ok('bas committed', pg.state.committed === true && pg.state.rolledBack === false);
    ok('bas total_cents >= 4000', out && out.body && Number(out.body.total_cents) >= 4000, out && out.body && out.body.total_cents);
  }

  {
    const pg = makeCreatePg({ bookingCode: 'SUNSET-SHOULD-NOT' });
    const built = buildRentalCommand([{ offering_key: 'unicorn_rental', duration_key: '1_day', quantity: 1 }]);
    ok('unpriced command builds', built.ok === true, built);
    const out = await executeSunsetBookingCreate(pg, built.command);
    ok('unpriced fails closed', out && out.ok === false, JSON.stringify(out && out.body || out).slice(0, 280));
    ok(
      'unpriced no successful write',
      pg.state.bookingInserts === 0 || pg.state.rolledBack === true || pg.state.committed === false,
      { bookingInserts: pg.state.bookingInserts, committed: pg.state.committed, rolledBack: pg.state.rolledBack },
    );
    const err = String((out && out.body && (out.body.reason_code || out.body.error)) || '');
    ok('unpriced error class', /price|unpriced|not_found|unavailable|rental_bundle|no_price|not_configured/i.test(err), err);
  }

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  console.log('PASS verify:sunset-rental-create-price-lookup-p1\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
