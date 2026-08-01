'use strict';

/**
 * verify:sunset-rental-create-price-lookup-p1
 *
 * P1: create-side rental price resolution must use the same item_code convention
 * as quote (item_code = offering_key__duration; unit = billing grain).
 *
 * Layer A — pure lookup (findPriceCents / configuredRentalBundleTotalCents)
 * Layer B — real executeSunsetBookingCreate path (fake PG, no network):
 *   1) bike_rental 1_day → persisted create + SUNSET-… code
 *   2) board_and_suit_rental 1_day → same
 *   3) unpriced rental → fail closed, no booking write
 *
 * Run: node scripts/verify-sunset-rental-create-price-lookup-p1.js
 */

const {
  findPriceCents,
  configuredRentalBundleTotalCents,
} = require('./lib/sunset-stripe-payment-links');
const { mapPriceRows } = require('./lib/tenant-business-config');
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
    console.error(`  FAIL  ${label}${detail != null ? ` — ${String(detail).slice(0, 240)}` : ''}`);
  }
}

const LOC = 'sunset-somo';
const SERVICE_DATE = '2026-08-20';
const FIXED_NOW = new Date('2026-07-14T12:00:00Z');

const DB_PRICE_ROWS = [
  { id: 'p-bike', item_type: 'rental', item_code: 'bike_rental__1_day', amount_cents: 1500, unit: 'day', display_name: 'Bike', currency: 'EUR', active: true, location_id: LOC },
  { id: 'p-towel', item_type: 'rental', item_code: 'towel_rental__1_day', amount_cents: 300, unit: 'item', display_name: 'Towel', currency: 'EUR', active: true, location_id: LOC },
  { id: 'p-sup', item_type: 'rental', item_code: 'sup_rental__1_day', amount_cents: 3000, unit: 'day', display_name: 'SUP', currency: 'EUR', active: true, location_id: LOC },
  { id: 'p-bas-1d', item_type: 'rental', item_code: 'board_and_suit_rental__1_day', amount_cents: 2000, unit: 'day', display_name: 'Board+suit 1d', currency: 'EUR', active: true, location_id: LOC },
  { id: 'p-bas-hd', item_type: 'rental', item_code: 'board_and_suit_rental__half_day', amount_cents: 1500, unit: 'session', display_name: 'Board+suit half', currency: 'EUR', active: true, location_id: LOC },
];

const OFFERINGS = [
  { id: 'o-bike', client_slug: 'sunset', location_id: LOC, offering_key: 'bike_rental', label: 'Bike rental', active: true, stock_quantity: 20, sort_order: 1, excludes: [] },
  { id: 'o-towel', client_slug: 'sunset', location_id: LOC, offering_key: 'towel_rental', label: 'Towel', active: true, stock_quantity: 50, sort_order: 2, excludes: [] },
  { id: 'o-sup', client_slug: 'sunset', location_id: LOC, offering_key: 'sup_rental', label: 'SUP', active: true, stock_quantity: 10, sort_order: 3, excludes: [] },
  { id: 'o-bas', client_slug: 'sunset', location_id: LOC, offering_key: 'board_and_suit_rental', label: 'Board + suit', active: true, stock_quantity: 15, sort_order: 4, excludes: [] },
  { id: 'o-ghost', client_slug: 'sunset', location_id: LOC, offering_key: 'unicorn_rental', label: 'Unicorn (no price)', active: true, stock_quantity: 5, sort_order: 5, excludes: [] },
];

function makeCreatePg(opts = {}) {
  const prices = opts.prices != null ? opts.prices : DB_PRICE_ROWS.slice();
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
      if (/^COMMIT/i.test(q)) {
        state.committed = true;
        return { rows: [] };
      }
      if (/^ROLLBACK/i.test(q)) {
        state.rolledBack = true;
        return { rows: [] };
      }
      if (/pg_advisory/i.test(q)) return { rows: [] };
      if (/to_regclass/i.test(q)) {
        return { rows: [{ reg: 'tenant_price_rules' }] };
      }
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

      // Rental offerings catalog + stock locks
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
          rows: offerings
            .filter((o) => o.active !== false)
            .map((o) => ({
              ...o,
              client_slug: o.client_slug || 'sunset',
              location_id: o.location_id || LOC,
              stock_quantity: o.stock_quantity != null ? o.stock_quantity : 99,
            })),
        };
      }

      // Active reservations for stock remaining
      if (/booking_service_records/i.test(q)
        && /offering_key/i.test(q)
        && /NOT IN\s*\(\s*'cancelled'/i.test(q)
        && !/INSERT/i.test(q)) {
        return { rows: [] };
      }

      // Price rules — single-row lookup (loadTenantPriceRuleFromDb) + full list (config load)
      if (/FROM tenant_price_rules/i.test(q)) {
        // Full list load for resolveTenantBusinessConfigAsync
        if (/ORDER BY item_type, item_code, unit/i.test(q) || (/SELECT id, item_type, item_code/i.test(q) && !/LIMIT 1/i.test(q))) {
          return {
            rows: prices.map((p) => ({
              id: p.id,
              item_type: p.item_type || 'rental',
              item_code: p.item_code,
              display_name: p.display_name || p.item_code,
              currency: p.currency || 'EUR',
              amount_cents: p.amount_cents,
              unit: p.unit,
              active: p.active !== false,
              location_id: p.location_id || LOC,
              effective_from: null,
              effective_to: null,
              updated_at: '2026-06-01',
            })),
          };
        }
        // Exact item_code lookup
        let match = null;
        for (const p of params) {
          const code = String(p || '');
          match = prices.find((x) => String(x.item_code) === code);
          if (match) break;
        }
        if (!match) {
          for (const p of params) {
            if (typeof p === 'string' && p.includes('__')) {
              match = prices.find((x) => String(x.item_code) === p);
              if (match) break;
            }
          }
        }
        if (!match) return { rows: [] };
        return {
          rows: [{
            id: match.id || 'price-1',
            amount_cents: match.amount_cents,
            currency: 'EUR',
            item_type: match.item_type || 'rental',
            item_code: match.item_code,
            unit: match.unit || 'day',
            location_id: match.location_id || LOC,
            active: true,
            effective_from: null,
            effective_to: null,
            updated_at: '2026-06-01',
          }],
        };
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
        // params typically include metadata JSON near the end
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
        const metaRaw = params.find((p) => (typeof p === 'string' && p.trim().startsWith('{')) || (p && typeof p === 'object'));
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
          amount_due_cents: params[10] != null ? params[10] : (meta.unit_cents || 0),
          metadata: meta,
        };
        // try common positions for amount_due_cents
        for (let i = 0; i < params.length; i += 1) {
          if (Number.isInteger(params[i]) && params[i] >= 0 && params[i] < 1000000 && i > 6) {
            // keep last reasonable cents candidate if metadata didn't set it
          }
        }
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

      // After-create pricing reads
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
      if (/UPDATE booking_service_records SET amount_due_cents/i.test(q)) {
        const due = params[0];
        const id = params[1];
        const hit = state.services.find((s) => String(s.id) === String(id) || String(s.service_record_id) === String(id));
        if (hit) hit.amount_due_cents = due;
        return { rows: [], rowCount: hit ? 1 : 0 };
      }
      if (/UPDATE booking_service_records\s+SET amount_due_cents/i.test(q)) {
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE booking_service_records[\s\S]*amount_due_cents/i.test(q)) {
        // metadata || amount updates also require rowCount 1
        const id = params.find((p) => typeof p === 'string' && /[0-9a-f-]{8,}/i.test(String(p))) || params[2] || params[1];
        const hit = state.services.find((s) => String(s.id) === String(id) || String(s.service_record_id) === String(id));
        if (hit && Number.isInteger(params[0])) hit.amount_due_cents = params[0];
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE bookings\s+SET total_amount_cents/i.test(q)) {
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE bookings\s+SET status = 'cancelled'/i.test(q)) {
        state.rolledBack = true; // treat cancel-after-price-fail as no successful write
        return { rows: [] };
      }
      if (/UPDATE booking_service_records\s+SET status = 'cancelled'/i.test(q)) {
        return { rows: [] };
      }
      if (/UPDATE bookings SET/i.test(q) || /UPDATE booking_service_records/i.test(q)) {
        return { rows: [], rowCount: 1 };
      }

      return { rows: [] };
    },
  };
  return pg;
}

function buildRentalCommand(rentals, extraBody = {}) {
  return buildSunsetBookingCreateCommand({
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    trustedLocationId: LOC,
    transportBody: {
          guest_name: 'P1 Rental Guest',
          guest_phone: '+346****0001',
          guest_confirmed_booking: true,
          payment_status: 'unpaid',
          service_date: SERVICE_DATE,
          service_dates: [SERVICE_DATE],
          date_from: SERVICE_DATE,
          date_to: SERVICE_DATE,
          components: {},
          rentals,
          ...extraBody,
        },
    now: FIXED_NOW,
  });
}

async function main() {
  console.log('\nverify:sunset-rental-create-price-lookup-p1\n');
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

  // ── A) Pure lookup ────────────────────────────────────────────────────────
  console.log('[A] Pure create-side lookup (DB item_code shape)');
  const dbMapped = mapPriceRows(DB_PRICE_ROWS, { clientSlug: 'sunset', locationId: LOC });
  ok('mapPriceRows offering_key is compound item_code', dbMapped.every((p) => String(p.offering_key || '').includes('__')));
  ok('bike 1_day unit cents', findPriceCents(dbMapped, 'rental', 'bike_rental', '1_day') === 1500);
  ok('towel 1_day unit cents', findPriceCents(dbMapped, 'rental', 'towel_rental', '1_day') === 300);
  ok('sup 1_day unit cents', findPriceCents(dbMapped, 'rental', 'sup_rental', '1_day') === 3000);
  ok('bundle 1_day unit cents', findPriceCents(dbMapped, 'rental', 'board_and_suit_rental', '1_day') === 2000);
  ok('bundle half_day unit cents', findPriceCents(dbMapped, 'rental', 'board_and_suit_rental', 'half_day') === 1500);
  ok(
    'configured bike qty1',
    configuredRentalBundleTotalCents(dbMapped, { offering_key: 'bike_rental', duration: '1_day', quantity: 1 }) === 1500,
  );
  ok(
    'configured board+suit 1_day qty2',
    configuredRentalBundleTotalCents(dbMapped, { offering_key: 'board_and_suit_rental', duration: '1_day', quantity: 2 }) === 4000,
  );
  ok(
    'unpriced → null',
    configuredRentalBundleTotalCents(dbMapped, { offering_key: 'unicorn_rental', duration: '1_day', quantity: 1 }) == null,
  );

  // Legacy bare + duration-as-unit still works
  const legacy = [
    { category: 'rental', offering_key: 'board_and_suit_rental', unit: 'half_day', amount: 15, active: true },
  ];
  ok('legacy half_day', findPriceCents(legacy, 'rental', 'board_and_suit_rental', 'half_day') === 1500);

  // ── B) Real executeSunsetBookingCreate path ───────────────────────────────
  console.log('\n[B] executeSunsetBookingCreate (fake PG) — bike + board/suit + unpriced');

  // B1 bike
  {
    const pg = makeCreatePg({ bookingCode: 'SUNSET-20260820-BIKE1' });
    const built = buildRentalCommand([
      { offering_key: 'bike_rental', duration_key: '1_day', quantity: 1 },
    ]);
    ok('bike command builds', built.ok === true, built);
    const out = await executeSunsetBookingCreate(pg, built.command);
    const code = out && out.body && (out.body.booking_code || (out.body.booking && out.body.booking.booking_code));
    ok('bike create ok', out && out.ok === true && out.body && out.body.success !== false, JSON.stringify(out && out.body || out).slice(0, 300));
    ok('bike returns SUNSET- code', typeof code === 'string' && /^SUNSET-/.test(code), code);
    ok('bike booking INSERT happened', pg.state.bookingInserts >= 1, pg.state.bookingInserts);
    ok('bike service INSERT happened', pg.state.serviceInserts >= 1, pg.state.serviceInserts);
    ok('bike committed (not rolled back)', pg.state.committed === true && pg.state.rolledBack === false, {
      committed: pg.state.committed,
      rolledBack: pg.state.rolledBack,
    });
    ok(
      'bike total_cents > 0',
      out && out.body && Number(out.body.total_cents) > 0,
      out && out.body && out.body.total_cents,
    );
  }

  // B2 board + suit
  {
    const pg = makeCreatePg({ bookingCode: 'SUNSET-20260820-BAS1' });
    const built = buildRentalCommand([
      { offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 2 },
    ]);
    ok('board+suit command builds', built.ok === true, built);
    const out = await executeSunsetBookingCreate(pg, built.command);
    const code = out && out.body && (out.body.booking_code || (out.body.booking && out.body.booking.booking_code));
    ok('board+suit create ok', out && out.ok === true && out.body && out.body.success !== false, JSON.stringify(out && out.body || out).slice(0, 300));
    ok('board+suit returns SUNSET- code', typeof code === 'string' && /^SUNSET-/.test(code), code);
    ok('board+suit booking INSERT happened', pg.state.bookingInserts >= 1, pg.state.bookingInserts);
    ok('board+suit service INSERT happened', pg.state.serviceInserts >= 1, pg.state.serviceInserts);
    ok('board+suit committed', pg.state.committed === true && pg.state.rolledBack === false, {
      committed: pg.state.committed,
      rolledBack: pg.state.rolledBack,
    });
    ok(
      'board+suit total_cents >= 4000 (qty 2 × 2000)',
      out && out.body && Number(out.body.total_cents) >= 4000,
      out && out.body && out.body.total_cents,
    );
  }

  // B3 unpriced — catalog-active but no price rule
  {
    const pg = makeCreatePg({ bookingCode: 'SUNSET-SHOULD-NOT-EXIST' });
    const built = buildRentalCommand([
      { offering_key: 'unicorn_rental', duration_key: '1_day', quantity: 1 },
    ]);
    ok('unpriced command builds', built.ok === true, built);
    const out = await executeSunsetBookingCreate(pg, built.command);
    ok('unpriced create fails closed', out && out.ok === false, JSON.stringify(out && out.body || out).slice(0, 300));
    ok(
      'unpriced no successful booking write',
      pg.state.bookingInserts === 0 || pg.state.rolledBack === true || pg.state.committed === false,
      {
        bookingInserts: pg.state.bookingInserts,
        committed: pg.state.committed,
        rolledBack: pg.state.rolledBack,
      },
    );
    const err = String((out && out.body && (out.body.reason_code || out.body.error)) || out && out.error || '');
    ok(
      'unpriced error is price/availability class',
      /price|unpriced|not_found|unavailable|rental_bundle|no_price|not_configured/i.test(err),
      err,
    );
  }

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  console.log('PASS verify:sunset-rental-create-price-lookup-p1\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
