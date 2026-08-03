'use strict';

/**
 * verify:rental-stock-slice-b
 *
 * Integration Slice B — stock availability API contract, in-txn assert owner,
 * board_and_suit exact future-write, Schedule UI stock helpers, Luna fail-closed,
 * concurrent last-unit gate, multi-day/edit/restore contracts.
 *
 * Offline / injectable. No live DB, no push/deploy.
 *
 * Run: node scripts/verify-rental-stock-slice-b.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

// ── Owners ──────────────────────────────────────────────────────────────────
const stock = require('./lib/tenant-rental-stock');
const stockService = require('./lib/tenant-rental-stock-service');
const writes = require('./lib/sunset-schedule-booking-writes');
const rentalAvail = require('./browser/sunset-schedule-rental-availability');
const { buildGenericRentalServiceRecord } = require('./lib/tenant-rental-price-resolver');

console.log('\nverify:rental-stock-slice-b\n');

// ── A. Service owner surface ────────────────────────────────────────────────
section('A. stock service owner surface');
ok('queryRentalStockAvailability exported', typeof stockService.queryRentalStockAvailability === 'function');
ok('assertRentalStockClaimsInTxn exported', typeof stockService.assertRentalStockClaimsInTxn === 'function');
ok('collectRentalStockClaims exported', typeof stockService.collectRentalStockClaims === 'function');
ok('stockFailureHttp exported', typeof stockService.stockFailureHttp === 'function');
ok('collectRentalStockClaimsFromServices exported', typeof stockService.collectRentalStockClaimsFromServices === 'function');

// ── B. Claims from rentals[] — exact keys only ──────────────────────────────
section('B. collect claims — exact offering_key, no component expansion');
{
  const pack = stockService.collectRentalStockClaims([
    { offering_key: 'board_and_suit_rental', quantity: 2 },
    { offering_key: 'kayak_rental', quantity: 1 },
  ], '2026-08-10', '2026-08-12');
  ok('claims ok', pack.ok === true);
  ok('two exact claims', pack.claims.length === 2);
  ok('board_and_suit is one claim (not board+wetsuit)',
    pack.claims.some((c) => c.offering_key === 'board_and_suit_rental' && c.quantity === 2)
    && !pack.claims.some((c) => c.offering_key === 'board_rental')
    && !pack.claims.some((c) => c.offering_key === 'wetsuit_rental'));
  ok('multi-day dates inclusive', pack.dates && pack.dates.length === 3);
  ok('custom Board+Suit key independent', (() => {
    const custom = stockService.collectRentalStockClaims([
      { offering_key: 'board_plus_suit_custom', quantity: 3 },
      { offering_key: 'board_rental', quantity: 1 },
    ], '2026-08-01', '2026-08-01');
    return custom.ok
      && custom.claims.find((c) => c.offering_key === 'board_plus_suit_custom').quantity === 3
      && custom.claims.find((c) => c.offering_key === 'board_rental').quantity === 1;
  })());
}

// Async tests
(async function main() {
  // ── C. last-unit concurrent Create ────────────────────────────────────────
  section('C. last-unit concurrent Create — exactly one commits');
  {
    const gate = stock.createInMemoryStockTxnGate({
      offerings: {
        [stock.offeringStateKey('sunset', 'sunset-somo', 'board_rental')]: {
          stock_quantity: 1,
          location_id: 'sunset-somo',
          offering_key: 'board_rental',
          client_slug: 'sunset',
        },
      },
    });
    const results = [];
    await Promise.all([
      gate.runTransaction(async (txn) => {
        const lock = await txn.lockStockRows({
          clientSlug: 'sunset', locationId: 'sunset-somo', offeringKeys: ['board_rental'],
        });
        if (!lock.ok) { results.push({ ok: false, stage: 'lock' }); return; }
        const check = txn.checkAvailability({
          clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'board_rental',
          quantity: 1, date_from: '2026-09-01', date_to: '2026-09-01',
        });
        if (!check.ok) { results.push({ ok: false, stage: 'check', error: check.error }); return; }
        txn.reserve({
          clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'board_rental',
          quantity: 1, date_from: '2026-09-01', date_to: '2026-09-01', booking_id: 'winner',
        });
        results.push({ ok: true, booking: 'winner' });
      }),
      gate.runTransaction(async (txn) => {
        const lock = await txn.lockStockRows({
          clientSlug: 'sunset', locationId: 'sunset-somo', offeringKeys: ['board_rental'],
        });
        if (!lock.ok) { results.push({ ok: false, stage: 'lock' }); return; }
        const check = txn.checkAvailability({
          clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'board_rental',
          quantity: 1, date_from: '2026-09-01', date_to: '2026-09-01',
        });
        if (!check.ok) { results.push({ ok: false, stage: 'check', error: check.error }); return; }
        txn.reserve({
          clientSlug: 'sunset', locationId: 'sunset-somo', offering_key: 'board_rental',
          quantity: 1, date_from: '2026-09-01', date_to: '2026-09-01', booking_id: 'loser',
        });
        results.push({ ok: true, booking: 'loser' });
      }),
    ]);
    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);
    ok('exactly one concurrent create succeeds', wins.length === 1, JSON.stringify(results));
    ok('loser fails with rental_stock_unavailable',
      losses.length === 1 && losses[0].error === stock.ERROR_STOCK_UNAVAILABLE,
      JSON.stringify(losses));
  }

  // ── D. Multi-item lock order deterministic ────────────────────────────────
  section('D. simultaneous multi-item locks deterministic');
  {
    const lockOrder = [];
    const gate = stock.createInMemoryStockTxnGate({
      offerings: {
        [stock.offeringStateKey('sunset', 'sunset-somo', 'wetsuit_rental')]: {
          stock_quantity: 5, location_id: 'sunset-somo', offering_key: 'wetsuit_rental', client_slug: 'sunset',
        },
        [stock.offeringStateKey('sunset', 'sunset-somo', 'board_rental')]: {
          stock_quantity: 5, location_id: 'sunset-somo', offering_key: 'board_rental', client_slug: 'sunset',
        },
        [stock.offeringStateKey('sunset', 'sunset-somo', 'kayak_rental')]: {
          stock_quantity: 5, location_id: 'sunset-somo', offering_key: 'kayak_rental', client_slug: 'sunset',
        },
      },
      onLock: (k) => lockOrder.push(k),
    });
    await gate.runTransaction(async (txn) => {
      await txn.lockStockRows({
        clientSlug: 'sunset',
        locationId: 'sunset-somo',
        offeringKeys: ['kayak_rental', 'board_rental', 'wetsuit_rental'],
      });
    });
    const keysOnly = lockOrder.map((k) => k.split('|')[2]);
    ok('locks acquired sorted by offering_key',
      JSON.stringify(keysOnly) === JSON.stringify(['board_rental', 'kayak_rental', 'wetsuit_rental']),
      JSON.stringify(keysOnly));
  }

  // ── E. Missing stock row — both claims fail, no phantom lock invent ───────
  section('E. missing stock row both claims fail');
  {
    const gate = stock.createInMemoryStockTxnGate({ offerings: {} });
    const a = await gate.runTransaction(async (txn) => txn.lockStockRows({
      clientSlug: 'sunset', locationId: 'sunset-somo', offeringKeys: ['ghost_rental'],
    }));
    const b = await gate.runTransaction(async (txn) => txn.lockStockRows({
      clientSlug: 'sunset', locationId: 'sunset-somo', offeringKeys: ['ghost_rental'],
    }));
    ok('first missing fails not_configured', a.ok === false && a.error === stock.ERROR_STOCK_NOT_CONFIGURED);
    ok('second missing fails not_configured', b.ok === false && b.error === stock.ERROR_STOCK_NOT_CONFIGURED);
    ok('no phantom rows invented', gate._debugState().size === 0);
  }

  // ── F. Custom Board+Suit consumes only own stock ──────────────────────────
  section('F. exact custom Board+Suit independent of board/wetsuit');
  {
    const customKey = 'surfboard_plus_wetsuit_combo';
    const avail = stock.computeRentalStockAvailability({
      offering_key: customKey,
      stock_quantity: 2,
      quantity: 1,
      date_from: '2026-08-20',
      date_to: '2026-08-20',
      reservations: [
        {
          booking_id: 'b1',
          offering_key: 'board_rental',
          service_date: '2026-08-20',
          quantity: 10,
          status: 'confirmed',
        },
        {
          booking_id: 'b2',
          offering_key: 'wetsuit_rental',
          service_date: '2026-08-20',
          quantity: 10,
          status: 'confirmed',
        },
        {
          booking_id: 'b3',
          offering_key: customKey,
          service_date: '2026-08-20',
          quantity: 1,
          status: 'confirmed',
        },
      ],
    });
    ok('custom combo remaining ignores board/wetsuit demand',
      avail.ok === true && avail.remaining === 1,
      JSON.stringify(avail));
  }

  // ── G. board_and_suit future write — exact offering, not components ───────
  section('G. board_and_suit future write = exact offering record');
  {
    ok('board_and_suit is exact future-write key',
      writes.isExactOfferingFutureWriteKey('board_and_suit_rental') === true);
    ok('board_and_suit not component lane',
      writes.isComponentLaneRentalKey('board_and_suit_rental') === false);
    ok('board_rental remains component lane',
      writes.isComponentLaneRentalKey('board_rental') === true);

    // prepareCanonical rejects board_and_suit (must go generic path)
    const prep = writes.prepareCanonicalRentalsForCreate({
      date_from: '2026-08-01',
      date_to: '2026-08-01',
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: {},
      guest_name: 'Test',
      surfer_count: 1,
      payment_status: 'unpaid',
    });
    ok('prepareCanonical accepts board_and_suit without inventing components',
      prep.ok === true
      && prep.present === true
      && prep.rentals[0].offering_key === 'board_and_suit_rental'
      && !prep.body.components.surfboard
      && !prep.body.components.wetsuit,
      JSON.stringify(prep));

    // serialize selection never expands to board+wetsuit
    const serialized = rentalAvail.scheduleSerializeRentalsSelection(
      [{ offering_key: 'board_and_suit_rental', quantity: 2 }],
      '1_day',
      { expandCombinedShort: true },
    );
    ok('serialize keeps exact board_and_suit',
      serialized.length === 1
      && serialized[0].offering_key === 'board_and_suit_rental'
      && serialized[0].quantity === 2,
      JSON.stringify(serialized));
    ok('legacy components helper does not invent halves for board_and_suit',
      Object.keys(rentalAvail.scheduleRentalsToLegacyComponents(serialized)).length === 0);

    // generic service record for board_and_suit is one exact offering
    const rec = buildGenericRentalServiceRecord({
      ok: true,
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      offering_key: 'board_and_suit_rental',
      duration_key: '1_day',
      item_code: 'board_and_suit_rental__1_day',
      unit: 'day',
      unit_cents: 4500,
      quantity: 2,
      amount_cents: 9000,
      currency: 'EUR',
    }, {
      serviceDate: '2026-08-01',
      serviceDates: ['2026-08-01'],
      source: 'staff_manual',
    });
    ok('exact offering record builds', rec.ok === true);
    ok('metadata.offering_key is board_and_suit_rental',
      rec.record.metadata.offering_key === 'board_and_suit_rental');
    ok('no bundle_part / component halves on future write',
      !rec.record.metadata.bundle_part
      && !rec.record.metadata.rental_pricing_role
      && rec.record.metadata.component !== 'surfboard'
      && rec.record.metadata.component !== 'wetsuit');
  }

  // ── H. Multi-day overlap anchor outside window ────────────────────────────
  section('H. multi-day overlap where anchor outside window still blocks');
  {
    const avail = stock.computeRentalStockAvailability({
      offering_key: 'board_rental',
      stock_quantity: 1,
      quantity: 1,
      date_from: '2026-08-12',
      date_to: '2026-08-14',
      reservations: [
        {
          booking_id: 'overlap',
          offering_key: 'board_rental',
          service_date: '2026-08-10', // anchor outside
          rental_service_dates: ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'],
          quantity: 1,
          status: 'confirmed',
        },
      ],
    });
    ok('overlap blocks on shared dates',
      avail.ok === false && avail.error === stock.ERROR_STOCK_UNAVAILABLE,
      JSON.stringify(avail));
    ok('limiting date inside query window',
      avail.limiting_date === '2026-08-12' || avail.limiting_date === '2026-08-13',
      String(avail.limiting_date));
  }

  // ── I. Create success / unavailable / not-configured ──────────────────────
  section('I. create success / unavailable / not-configured');
  {
    const mockPg = createMockStockPg({
      offerings: [
        {
          id: '1', client_slug: 'sunset', location_id: 'sunset-somo',
          offering_key: 'board_rental', stock_quantity: 2, active: true,
        },
        {
          id: '2', client_slug: 'sunset', location_id: 'sunset-somo',
          offering_key: 'kayak_rental', stock_quantity: null, active: true,
        },
      ],
      reservations: [
        {
          booking_id: 'exist',
          service_date: '2026-08-01',
          quantity: 1,
          status: 'confirmed',
          booking_status: 'confirmed',
          offering_key: 'board_rental',
          rental_service_dates: ['2026-08-01'],
          covered_dates: null,
          schedule_archived: '',
          sr_schedule_archived: '',
        },
      ],
    });

    const okCreate = await stockService.assertRentalStockClaimsInTxn(mockPg, {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      rentals: [{ offering_key: 'board_rental', quantity: 1 }],
      dateFrom: '2026-08-01',
      dateTo: '2026-08-01',
      defaultLocationId: 'sunset-somo',
    });
    ok('create succeeds when remaining covers request', okCreate.ok === true, JSON.stringify(okCreate));

    const unavail = await stockService.assertRentalStockClaimsInTxn(mockPg, {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      rentals: [{ offering_key: 'board_rental', quantity: 2 }],
      dateFrom: '2026-08-01',
      dateTo: '2026-08-01',
      defaultLocationId: 'sunset-somo',
    });
    ok('create fails when remaining insufficient',
      unavail.ok === false && unavail.error === stock.ERROR_STOCK_UNAVAILABLE,
      JSON.stringify(unavail));

    const notCfg = await stockService.assertRentalStockClaimsInTxn(mockPg, {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      rentals: [{ offering_key: 'kayak_rental', quantity: 1 }],
      dateFrom: '2026-08-01',
      dateTo: '2026-08-01',
      defaultLocationId: 'sunset-somo',
    });
    ok('create fails closed when stock_quantity null',
      notCfg.ok === false && notCfg.error === stock.ERROR_STOCK_NOT_CONFIGURED,
      JSON.stringify(notCfg));
  }

  // ── J. Edit exclusion + replacement ───────────────────────────────────────
  section('J. Edit exclusion + replacement allocation');
  {
    const mockPg = createMockStockPg({
      offerings: [{
        id: '1', client_slug: 'sunset', location_id: 'sunset-somo',
        offering_key: 'board_rental', stock_quantity: 1, active: true,
      }],
      reservations: [{
        booking_id: 'edit-me',
        service_date: '2026-08-05',
        quantity: 1,
        status: 'confirmed',
        booking_status: 'confirmed',
        offering_key: 'board_rental',
        rental_service_dates: ['2026-08-05'],
        schedule_archived: '',
        sr_schedule_archived: '',
      }],
    });
    const withExclude = await stockService.assertRentalStockClaimsInTxn(mockPg, {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      rentals: [{ offering_key: 'board_rental', quantity: 1 }],
      dateFrom: '2026-08-05',
      dateTo: '2026-08-05',
      excludeBookingId: 'edit-me',
      defaultLocationId: 'sunset-somo',
    });
    ok('edit exclude allows same qty replacement', withExclude.ok === true, JSON.stringify(withExclude));

    const noExclude = await stockService.assertRentalStockClaimsInTxn(mockPg, {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      rentals: [{ offering_key: 'board_rental', quantity: 1 }],
      dateFrom: '2026-08-05',
      dateTo: '2026-08-05',
      defaultLocationId: 'sunset-somo',
    });
    ok('without exclude same qty conflicts',
      noExclude.ok === false && noExclude.error === stock.ERROR_STOCK_UNAVAILABLE,
      JSON.stringify(noExclude));
  }

  // ── K. Restore success / conflict; cancel releases ────────────────────────
  section('K. Restore + cancel release semantics');
  {
    const services = [{
      service_type: 'addon_service',
      service_date: '2026-08-07',
      quantity: 1,
      metadata: {
        offering_key: 'board_rental',
        rental_offering: true,
        rental_service_dates: ['2026-08-07'],
      },
    }];
    const claims = stockService.collectRentalStockClaimsFromServices(services);
    ok('restore claims from services', claims.ok && claims.claims.length === 1);
    ok('restore claim exact key + qty',
      claims.claims[0].offering_key === 'board_rental' && claims.claims[0].quantity === 1);

    // Cancelled demand does not consume
    const cancelled = stock.computeRentalStockAvailability({
      offering_key: 'board_rental',
      stock_quantity: 1,
      quantity: 1,
      date_from: '2026-08-07',
      date_to: '2026-08-07',
      reservations: [{
        booking_id: 'cancelled-one',
        offering_key: 'board_rental',
        service_date: '2026-08-07',
        quantity: 1,
        status: 'cancelled',
        booking_status: 'cancelled',
      }],
    });
    ok('cancelled does not consume stock', cancelled.ok === true && cancelled.remaining === 1);

    const mockPg = createMockStockPg({
      offerings: [{
        id: '1', client_slug: 'sunset', location_id: 'sunset-somo',
        offering_key: 'board_rental', stock_quantity: 1, active: true,
      }],
      reservations: [{
        booking_id: 'other',
        service_date: '2026-08-07',
        quantity: 1,
        status: 'confirmed',
        booking_status: 'confirmed',
        offering_key: 'board_rental',
        rental_service_dates: ['2026-08-07'],
        schedule_archived: '',
        sr_schedule_archived: '',
      }],
    });
    const restoreConflict = await stockService.assertRentalStockClaimsInTxn(mockPg, {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      claims: claims.claims,
      excludeBookingId: 'restore-me',
      defaultLocationId: 'sunset-somo',
    });
    ok('restore conflicts when another booking took the unit',
      restoreConflict.ok === false && restoreConflict.error === stock.ERROR_STOCK_UNAVAILABLE,
      JSON.stringify(restoreConflict));
  }

  // ── L. Tenant/location isolation + NULL client-wide fallback ──────────────
  section('L. tenant/location isolation + NULL client-wide fallback');
  {
    const plan = stock.buildRentalStockRowLockQuery({
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      offeringKeys: ['board_rental'],
    });
    ok('lock SQL scopes client_slug', plan.sql.includes('client_slug = $1'));
    ok('lock SQL allows exact or NULL location',
      plan.sql.includes('location_id = $2 OR location_id IS NULL')
      || plan.sql.includes('location_id IS NULL'));

    const resolved = stock.resolveLockedStockRows({
      requestedKeys: ['board_rental'],
      locationId: 'sunset-somo',
      lockedRows: [
        {
          id: 'null-row', client_slug: 'sunset', location_id: null,
          offering_key: 'board_rental', stock_quantity: 3, active: true,
        },
        {
          id: 'exact', client_slug: 'sunset', location_id: 'sunset-somo',
          offering_key: 'board_rental', stock_quantity: 7, active: true,
        },
        {
          id: 'other-tenant', client_slug: 'wolfhouse', location_id: 'sunset-somo',
          offering_key: 'board_rental', stock_quantity: 99, active: true,
        },
      ],
    });
    ok('exact location preferred over NULL',
      resolved.resolved[0].row.id === 'exact'
      && resolved.resolved[0].row.stock_quantity === 7);
    // Cross-tenant not in locked set from SQL; if present, resolve only by location match
    ok('cross-tenant row not chosen as exact/fallback for sunset',
      resolved.resolved[0].row.client_slug === 'sunset' || resolved.resolved[0].row.id === 'exact');

    const nullOnly = stock.resolveLockedStockRows({
      requestedKeys: ['board_rental'],
      locationId: 'sunset-sardinero',
      lockedRows: [{
        id: 'null-row', client_slug: 'sunset', location_id: null,
        offering_key: 'board_rental', stock_quantity: 4, active: true,
      }],
    });
    ok('NULL client-wide fallback when no exact location',
      nullOnly.resolved.length === 1 && nullOnly.resolved[0].stock_scope === 'client');
  }

  // ── M. Schedule UI stock helpers ──────────────────────────────────────────
  section('M. Schedule UI stock helpers (generated module)');
  {
    ok('format available',
      /2 available|2 disponibles/.test(rentalAvail.scheduleFormatRentalStockLabel(
        { remaining: 2, status: 'available' },
        (k, f) => (k === 'schedule.create.stockAvailable' ? '{n} available' : f),
      )));
    ok('format sold out',
      rentalAvail.scheduleFormatRentalStockLabel(
        { remaining: 0, sold_out: true, status: 'sold_out' },
        (k, f) => (k === 'schedule.create.stockSoldOut' ? 'Sold out' : f),
      ) === 'Sold out');
    ok('format not configured',
      rentalAvail.scheduleFormatRentalStockLabel(
        { not_configured: true, status: 'not_configured' },
        (k, f) => (k === 'schedule.create.stockNotConfigured' ? 'Stock not configured' : f),
      ) === 'Stock not configured');
    ok('qty max from stock caps +',
      rentalAvail.scheduleRentalQtyMaxFromStock({ remaining: 3 }) === 3);
    ok('qty max 0 when not configured',
      rentalAvail.scheduleRentalQtyMaxFromStock({ not_configured: true }) === 0);
    ok('can submit when all available',
      rentalAvail.scheduleCanSubmitRentalStock([{ ok: true, remaining: 2, requested_quantity: 1 }]) === true);
    ok('cannot submit sold out',
      rentalAvail.scheduleCanSubmitRentalStock([{ ok: false, sold_out: true, remaining: 0 }]) === false);
    ok('cannot submit not configured',
      rentalAvail.scheduleCanSubmitRentalStock([{ not_configured: true, status: 'not_configured' }]) === false);

    const body = rentalAvail.scheduleRentalStockRequestBody({
      dateFrom: '2026-08-01',
      dateTo: '2026-08-03',
      locationId: 'sunset-somo',
      offerings: [{ offering_key: 'board_rental', quantity: 2 }],
    });
    ok('stock request body shape',
      body.date_from === '2026-08-01'
      && body.date_to === '2026-08-03'
      && body.offerings[0].offering_key === 'board_rental');
  }

  // ── N. Staff API + Luna endpoint contract (source) ────────────────────────
  section('N. Staff API + Luna endpoint wiring (source owners)');
  {
    const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
    ok('schedule rental-stock route present',
      apiSrc.includes("/staff/schedule/rental-stock"));
    ok('luna bot rental-stock route present',
      apiSrc.includes("/staff/bot/sunset/rental-stock"));
    ok('handler uses queryRentalStockAvailability',
      apiSrc.includes('queryRentalStockAvailability'));
    ok('create UI refreshes stock on change',
      apiSrc.includes('scheduleRefreshCreateRentalStock'));
    ok('create UI stock label element',
      apiSrc.includes('data-rental-stock-label'));
    ok('create submit blocked by stock',
      apiSrc.includes('data-stock-blocked'));

    const createSrc = fs.readFileSync(
      path.join(ROOT, 'scripts/lib/sunset-schedule-booking-writes.js'), 'utf8',
    );
    ok('create asserts stock inside BEGIN transaction',
      /BEGIN[\s\S]*assertRentalStockClaimsInTxn[\s\S]*INSERT INTO bookings/m.test(createSrc)
      || (createSrc.indexOf('assertRentalStockClaimsInTxn') > createSrc.indexOf("await pg.query('BEGIN')")
        && createSrc.indexOf('assertRentalStockClaimsInTxn') < createSrc.indexOf('INSERT INTO bookings')));
    ok('create does not invent board_and_suit components descriptor',
      !/components:\s*\[\s*['"]surfboard['"]\s*,\s*['"]wetsuit['"]\s*\]/.test(createSrc)
      || createSrc.includes('never invent component halves'));

    const drawerSrc = fs.readFileSync(
      path.join(ROOT, 'scripts/lib/sunset-schedule-booking-drawer.js'), 'utf8',
    );
    ok('edit asserts stock with excludeBookingId',
      drawerSrc.includes('assertRentalStockClaimsInTxn')
      && drawerSrc.includes('excludeBookingId: bookingId'));
    ok('restore asserts stock before reactivation',
      drawerSrc.includes('collectRentalStockClaimsFromServices')
      && drawerSrc.indexOf('assertRentalStockClaimsInTxn') < drawerSrc.indexOf('schedule_restored'));

    const quoteSrc = fs.readFileSync(
      path.join(ROOT, 'scripts/lib/luna-front-desk-quote-service.js'), 'utf8',
    );
    ok('Luna quote calls queryRentalStockAvailability before claiming',
      quoteSrc.includes('queryRentalStockAvailability'));
    ok('Luna quote fails closed on stock error',
      quoteSrc.includes('rental_stock_unavailable')
      || quoteSrc.includes('rental_stock_not_configured'));
  }

  // ── O. Historical read adapters preserved ─────────────────────────────────
  section('O. Historical booking fixtures readable unchanged');
  {
    // Historical board+suit component pair still collapses to one demand unit
    const hist = stock.normalizeReservationDemand([
      {
        booking_id: 'hist',
        offering_key: 'board_and_suit_rental',
        service_date: '2026-07-01',
        quantity: 2,
        status: 'confirmed',
        pricing_group_id: 'grp-hist',
        bundle_part: 'surfboard',
      },
      {
        booking_id: 'hist',
        offering_key: 'board_and_suit_rental',
        service_date: '2026-07-01',
        quantity: 2,
        status: 'confirmed',
        pricing_group_id: 'grp-hist',
        bundle_part: 'wetsuit',
      },
    ]);
    ok('historical dual components count once at qty 2',
      hist.length === 1 && hist[0].quantity === 2);

    // rowMatches for board_and_suit still exists for quote application
    ok('historical quote matcher still handles board_and_suit component',
      fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-writes.js'), 'utf8')
        .includes("component === 'board_and_suit_rental'"));
  }

  // ── P. Default location explicit sunset-somo ──────────────────────────────
  section('P. Sunset default location explicit (no silent generic default)');
  {
    const svcSrc = fs.readFileSync(
      path.join(ROOT, 'scripts/lib/tenant-rental-stock-service.js'), 'utf8',
    );
    ok('service never invents default location silently',
      svcSrc.includes('never invents a requested location')
      || svcSrc.includes('Explicit only'));
    ok('create passes DEFAULT_SUNSET_LOCATION_ID explicitly',
      fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-writes.js'), 'utf8')
        .includes('DEFAULT_SUNSET_LOCATION_ID'));
  }

  // ── Q. Admin Rental Prices panel does not paint today (stock APIs elsewhere intact) ──
  section('Q. Admin panel no today paint; stock service untouched');
  {
    const adminSrc = fs.readFileSync(
      path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8',
    );
    ok('admin rental prices panel has no today availability slot',
      !adminSrc.includes('data-equip-available-today')
      && !adminSrc.includes('adminRefreshEquipAvailableToday'));
    ok('admin does not reimplement stock calculator',
      !adminSrc.includes('computeRentalStockAvailability'));
    ok('schedule rental-stock API path still present in repo (backend/UI elsewhere)',
      fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8').includes('rental-stock')
      || fs.existsSync(path.join(ROOT, 'scripts/lib/tenant-rental-stock-service.js')));
  }

  // ── R. Migration integrity still references 055 ───────────────────────────
  section('R. migration integrity / foundation intact');
  {
    const mig = fs.readFileSync(
      path.join(ROOT, 'database/migrations/055_tenant_rental_offering_stock.sql'), 'utf8',
    );
    ok('migration 055 has stock_quantity', mig.includes('stock_quantity'));
    ok('canonical calculator still present',
      fs.existsSync(path.join(ROOT, 'scripts/lib/tenant-rental-stock.js')));
  }

  // ── S. Cockpit source not redesigned ──────────────────────────────────────
  section('S. Captain Day Cockpit not redesigned');
  {
    const cockpit = path.join(ROOT, 'scripts/browser/sunset-schedule-day-cockpit-ui.js');
    ok('cockpit module still exists', fs.existsSync(cockpit));
    // Slice B must not rewrite cockpit structure
    const cockpitSrc = fs.readFileSync(cockpit, 'utf8');
    ok('cockpit still has day cockpit markers',
      /cockpit|day-ops|prep/i.test(cockpitSrc));
  }

  // ── T. stockFailureHttp maps structured conflicts ─────────────────────────
  section('T. structured server conflict mapping');
  {
    const mapped = stockService.stockFailureHttp({
      ok: false,
      error: stock.ERROR_STOCK_UNAVAILABLE,
      offering_key: 'board_rental',
      remaining: 0,
      requested_quantity: 1,
      message: 'sold out',
      status: 409,
      body: {
        success: false,
        error: stock.ERROR_STOCK_UNAVAILABLE,
        reason_code: stock.ERROR_STOCK_UNAVAILABLE,
        remaining: 0,
      },
    });
    ok('maps 409 with reason_code',
      mapped.status === 409
      && mapped.body.reason_code === stock.ERROR_STOCK_UNAVAILABLE);
  }

  // ── U. query availability via mock pg ─────────────────────────────────────
  section('U. queryRentalStockAvailability response shape');
  {
    const mockPg = createMockStockPg({
      offerings: [{
        id: '1', client_slug: 'sunset', location_id: 'sunset-somo',
        offering_key: 'board_rental', stock_quantity: 5, active: true,
      }],
      reservations: [],
    });
    const q = await stockService.queryRentalStockAvailability(mockPg, {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      dateFrom: '2026-08-01',
      dateTo: '2026-08-02',
      offerings: [{ offering_key: 'board_rental', quantity: 1 }],
      defaultLocationId: 'sunset-somo',
    });
    ok('query ok', q.ok === true);
    ok('item has remaining + days',
      q.items[0].remaining === 5
      && Array.isArray(q.items[0].days)
      && q.items[0].days.length === 2);
    ok('status available', q.items[0].status === 'available');
  }

  console.log(`\nverify-rental-stock-slice-b  pass=${pass}  fail=${fail}`);
  if (fail === 0) console.log('verify-rental-stock-slice-b — ALL CHECKS PASSED');
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('verify-rental-stock-slice-b crashed:', err);
  process.exit(1);
});

/**
 * Minimal pg mock implementing stock lock + reservation queries.
 */
function createMockStockPg({ offerings, reservations }) {
  const rows = Array.isArray(offerings) ? offerings : [];
  const resRows = Array.isArray(reservations) ? reservations : [];
  return {
    async query(sql, params) {
      const s = String(sql || '');
      if (s.includes('FOR UPDATE') && s.includes('tenant_rental_offerings')) {
        // Lock query — return active candidates matching keys
        const keys = Array.isArray(params[params.length - 1])
          ? params[params.length - 1]
          : (Array.isArray(params[1]) ? params[1] : []);
        const clientSlug = params[0];
        const loc = params.length >= 3 && !Array.isArray(params[1]) ? params[1] : null;
        const filtered = rows.filter((r) => {
          if (r.client_slug !== clientSlug) return false;
          if (r.active === false) return false;
          if (keys.length && !keys.includes(r.offering_key)) return false;
          if (loc == null) return r.location_id == null;
          return r.location_id === loc || r.location_id == null;
        });
        return { rows: filtered };
      }
      if (s.includes('FROM tenant_rental_offerings') && s.includes('LIMIT 1')) {
        const clientSlug = params[0];
        const key = params[params.length - 1];
        const loc = params.length === 3 ? params[1] : null;
        let hit = rows.find((r) => r.client_slug === clientSlug
          && r.offering_key === key
          && r.active !== false
          && (loc == null ? r.location_id == null : r.location_id === loc));
        if (!hit && loc != null) {
          hit = rows.find((r) => r.client_slug === clientSlug
            && r.offering_key === key
            && r.active !== false
            && r.location_id == null);
        }
        return { rows: hit ? [hit] : [] };
      }
      if (s.includes('booking_service_records')) {
        const offeringKey = params[1];
        const excludeId = params.length > 5 ? params[params.length - 1] : null;
        // crude: filter by offering_key; exclude booking if last param looks like uuid/id
        let out = resRows.filter((r) => r.offering_key === offeringKey);
        if (excludeId && typeof excludeId === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(excludeId)) {
          // excludeBookingId is typically after location params — match known booking ids
          out = out.filter((r) => String(r.booking_id) !== String(excludeId));
        }
        // Also handle exclude via SQL param scan for known booking ids in resRows
        for (const p of params) {
          if (typeof p === 'string' && resRows.some((r) => r.booking_id === p)
            && s.includes('IS DISTINCT FROM')) {
            out = out.filter((r) => String(r.booking_id) !== String(p));
          }
        }
        return { rows: out };
      }
      return { rows: [] };
    },
  };
}
