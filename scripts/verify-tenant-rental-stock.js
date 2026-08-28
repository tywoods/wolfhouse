'use strict';

/**
 * verify:tenant-rental-stock
 *
 * Offline TDD gate for the canonical rental stock calculator + row-lock contract
 * (scripts/lib/tenant-rental-stock.js). No live DB, no network, no Staff API.
 *
 * Covers:
 *   - unconfigured (null) stock fails closed
 *   - integer stock 0..999
 *   - remaining = stock − active reservations per calendar date
 *   - multi-day availability = min remaining across inclusive range
 *   - cancelled / archived / hold / expired do not consume stock
 *   - date-array occupancy (rental_service_dates / covered_dates) for load + expand
 *   - edit exclusion of the booking being replaced
 *   - independent offering_key identity (no hidden bundle deductions)
 *   - explicit historical bundle-component dedupe only (pricing_group markers)
 *   - independent same-booking rows SUM (not unconditional MAX)
 *   - client_slug + location isolation + NULL-location stock fallback
 *   - lockRentalStockRows fail-closed on missing keys
 *   - concurrency serialization + missing-row honesty at module boundary
 *
 * Run: node scripts/verify-tenant-rental-stock.js
 */

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

function loadModule() {
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    return require('./lib/tenant-rental-stock');
  } catch (err) {
    return { __loadError: err };
  }
}

async function run() {
  console.log('\nverify:tenant-rental-stock\n');

  const mod = loadModule();
  ok('module loads', !mod.__loadError, mod.__loadError && String(mod.__loadError.message || mod.__loadError));
  if (mod.__loadError) {
    console.log(`\nverify-tenant-rental-stock  pass=${pass}  fail=${fail} (RED — module missing)`);
    process.exit(1);
  }

  const {
    isValidStockQuantity,
    validateStockQuantity,
    inclusiveIsoDates,
    isActiveReservation,
    expandReservationDemand,
    normalizeReservationDemand,
    computeRentalStockAvailability,
    buildRentalStockRowLockQuery,
    resolveLockedStockRows,
    lockRentalStockRows,
    buildConfiguredStockQuery,
    buildActiveRentalReservationsQuery,
    createInMemoryStockTxnGate,
    STOCK_MIN,
    STOCK_MAX,
    ERROR_STOCK_NOT_CONFIGURED,
    ERROR_STOCK_UNAVAILABLE,
  } = mod;

  console.log('── A. stock quantity bounds ──');
  ok('STOCK_MIN is 0', STOCK_MIN === 0);
  ok('STOCK_MAX is 999', STOCK_MAX === 999);
  ok('0 valid', isValidStockQuantity(0) === true);
  ok('999 valid', isValidStockQuantity(999) === true);
  ok('12 valid', isValidStockQuantity(12) === true);
  ok('null is not a configured quantity', isValidStockQuantity(null) === false);
  ok('undefined invalid', isValidStockQuantity(undefined) === false);
  ok('negative invalid', isValidStockQuantity(-1) === false);
  ok('1000 invalid', isValidStockQuantity(1000) === false);
  ok('float invalid', isValidStockQuantity(1.5) === false);
  ok('string number invalid', isValidStockQuantity('5') === false);

  const vNull = validateStockQuantity(null);
  ok('validate null → unconfigured ok value null', vNull.ok === true && vNull.value === null, JSON.stringify(vNull));
  const vUndef = validateStockQuantity(undefined);
  ok('validate undefined → unconfigured ok value null', vUndef.ok === true && vUndef.value === null, JSON.stringify(vUndef));
  const vBad = validateStockQuantity(1000);
  ok('validate 1000 rejected', vBad.ok === false, JSON.stringify(vBad));
  const vOk = validateStockQuantity(20);
  ok('validate 20 accepted', vOk.ok === true && vOk.value === 20, JSON.stringify(vOk));

  console.log('\n── B. inclusive date range ──');
  ok('single day', JSON.stringify(inclusiveIsoDates('2026-08-01', '2026-08-01')) === JSON.stringify(['2026-08-01']));
  ok('three days inclusive',
    JSON.stringify(inclusiveIsoDates('2026-08-01', '2026-08-03')) === JSON.stringify(['2026-08-01', '2026-08-02', '2026-08-03']));
  ok('inverted range empty/fail-closed',
    Array.isArray(inclusiveIsoDates('2026-08-03', '2026-08-01'))
      && inclusiveIsoDates('2026-08-03', '2026-08-01').length === 0);

  console.log('\n── C. reservation expansion + normalization ──');
  const expanded = expandReservationDemand({
    booking_id: 'b1',
    offering_key: 'board_rental',
    service_date: '2026-08-01',
    quantity: 2,
    rental_service_dates: ['2026-08-01', '2026-08-02', '2026-08-03'],
  });
  ok('expands multi-day metadata to 3 demand units',
    expanded.length === 3
      && expanded.every((d) => d.quantity === 2)
      && expanded.map((d) => d.date).join(',') === '2026-08-01,2026-08-02,2026-08-03',
    JSON.stringify(expanded));

  const single = expandReservationDemand({
    booking_id: 'b2',
    offering_key: 'kayak_rental',
    service_date: '2026-08-05',
    quantity: 1,
  });
  ok('single service_date expands to itself',
    single.length === 1 && single[0].date === '2026-08-05' && single[0].quantity === 1);

  // Historical board+suit component pair: shared pricing_group_id + distinct bundle_part
  const dual = normalizeReservationDemand([
    {
      booking_id: 'b3',
      offering_key: 'board_and_suit_rental',
      service_date: '2026-08-10',
      quantity: 1,
      status: 'confirmed',
      pricing_group_id: 'grp-hist-1',
      bundle_part: 'surfboard',
      rental_pricing_role: 'surfboard',
      rental_bundle_id: 'grp-hist-1',
    },
    {
      booking_id: 'b3',
      offering_key: 'board_and_suit_rental',
      service_date: '2026-08-10',
      quantity: 1,
      status: 'confirmed',
      pricing_group_id: 'grp-hist-1',
      bundle_part: 'wetsuit',
      rental_pricing_role: 'wetsuit',
      rental_bundle_id: 'grp-hist-1',
    },
  ]);
  ok('explicit historical board+suit pair counts once at bundle quantity',
    dual.length === 1 && dual[0].quantity === 1 && dual[0].date === '2026-08-10',
    JSON.stringify(dual));

  // Independent same booking+offering+date rows SUM (no unconditional MAX collapse)
  const independentSum = normalizeReservationDemand([
    {
      booking_id: 'b4', offering_key: 'board_rental', service_date: '2026-08-11',
      quantity: 2, status: 'confirmed',
    },
    {
      booking_id: 'b4', offering_key: 'board_rental', service_date: '2026-08-11',
      quantity: 3, status: 'confirmed',
    },
  ]);
  ok('two independent rows quantities 2 and 3 count 5 (SUM, not MAX)',
    independentSum.length === 1 && independentSum[0].quantity === 5,
    JSON.stringify(independentSum));

  // Without bundle markers, dual-looking rows must NOT collapse via MAX
  const noMarkers = normalizeReservationDemand([
    {
      booking_id: 'b5', offering_key: 'board_and_suit_rental', service_date: '2026-08-12',
      quantity: 1, status: 'confirmed',
    },
    {
      booking_id: 'b5', offering_key: 'board_and_suit_rental', service_date: '2026-08-12',
      quantity: 1, status: 'confirmed',
    },
  ]);
  ok('same key+date without group markers SUM (no cross-offering inference)',
    noMarkers.length === 1 && noMarkers[0].quantity === 2,
    JSON.stringify(noMarkers));

  // Same explicit group + same part (repeated surfboard rows) must SUM, not MAX
  const samePartGroup = normalizeReservationDemand([
    {
      booking_id: 'b6', offering_key: 'board_rental', service_date: '2026-08-13',
      quantity: 2, status: 'confirmed',
      pricing_group_id: 'grp-same-part', bundle_part: 'surfboard',
    },
    {
      booking_id: 'b6', offering_key: 'board_rental', service_date: '2026-08-13',
      quantity: 3, status: 'confirmed',
      pricing_group_id: 'grp-same-part', bundle_part: 'surfboard',
    },
  ]);
  ok('same group + same part qty 2 and 3 => 5 (SUM; not MAX dedupe)',
    samePartGroup.length === 1 && samePartGroup[0].quantity === 5,
    JSON.stringify(samePartGroup));

  // Shared group + distinct surfboard/wetsuit parts => one bundle quantity (MAX)
  const distinctParts = normalizeReservationDemand([
    {
      booking_id: 'b7', offering_key: 'board_and_suit_rental', service_date: '2026-08-14',
      quantity: 2, status: 'confirmed',
      pricing_group_id: 'grp-pair', bundle_part: 'surfboard', rental_pricing_role: 'surfboard',
    },
    {
      booking_id: 'b7', offering_key: 'board_and_suit_rental', service_date: '2026-08-14',
      quantity: 1, status: 'confirmed',
      pricing_group_id: 'grp-pair', bundle_part: 'wetsuit', rental_pricing_role: 'wetsuit',
    },
  ]);
  ok('shared group + surfboard/wetsuit pair => one bundle quantity (MAX of components)',
    distinctParts.length === 1 && distinctParts[0].quantity === 2,
    JSON.stringify(distinctParts));

  // rental_bundle_id only + rental_pricing_role only still dedupes on distinct parts
  const roleMarkers = normalizeReservationDemand([
    {
      booking_id: 'b8', offering_key: 'combo', service_date: '2026-08-15',
      quantity: 1, status: 'confirmed',
      rental_bundle_id: 'rb1', rental_pricing_role: 'surfboard',
    },
    {
      booking_id: 'b8', offering_key: 'combo', service_date: '2026-08-15',
      quantity: 1, status: 'confirmed',
      rental_bundle_id: 'rb1', rental_pricing_role: 'wetsuit',
    },
  ]);
  ok('rental_bundle_id + distinct rental_pricing_role collapses to one',
    roleMarkers.length === 1 && roleMarkers[0].quantity === 1,
    JSON.stringify(roleMarkers));

  console.log('\n── D. unconfigured fails closed ──');
  const uncfg = computeRentalStockAvailability({
    offering_key: 'board_rental',
    stock_quantity: null,
    quantity: 1,
    date_from: '2026-08-01',
    date_to: '2026-08-01',
    reservations: [],
  });
  ok('null stock → rental_stock_not_configured',
    uncfg.ok === false && uncfg.error === ERROR_STOCK_NOT_CONFIGURED,
    JSON.stringify(uncfg));
  ok('not_configured carries offering_key + requested',
    uncfg.offering_key === 'board_rental' && uncfg.requested_quantity === 1,
    JSON.stringify(uncfg));

  console.log('\n── E. one-day remaining math ──');
  const day = computeRentalStockAvailability({
    offering_key: 'board_rental',
    stock_quantity: 5,
    quantity: 2,
    date_from: '2026-08-01',
    date_to: '2026-08-01',
    reservations: [
      {
        booking_id: 'a', offering_key: 'board_rental', service_date: '2026-08-01',
        quantity: 2, status: 'confirmed',
      },
      {
        booking_id: 'b', offering_key: 'board_rental', service_date: '2026-08-01',
        quantity: 1, status: 'requested',
      },
    ],
  });
  ok('available when remaining >= requested', day.ok === true, JSON.stringify(day));
  ok('remaining = 5 - 3 = 2', day.remaining === 2, JSON.stringify(day));
  ok('reserved = 3', day.reserved === 3, JSON.stringify(day));
  ok('stock_quantity echoed', day.stock_quantity === 5, JSON.stringify(day));

  const sold = computeRentalStockAvailability({
    offering_key: 'board_rental',
    stock_quantity: 5,
    quantity: 3,
    date_from: '2026-08-01',
    date_to: '2026-08-01',
    reservations: [
      {
        booking_id: 'a', offering_key: 'board_rental', service_date: '2026-08-01',
        quantity: 3, status: 'paid',
      },
    ],
  });
  ok('request above remaining → unavailable',
    sold.ok === false && sold.error === ERROR_STOCK_UNAVAILABLE,
    JSON.stringify(sold));
  ok('unavailable includes remaining + requested + limiting_date',
    sold.remaining === 2
      && sold.requested_quantity === 3
      && sold.limiting_date === '2026-08-01',
    JSON.stringify(sold));

  console.log('\n── F. multi-day = min remaining across range ──');
  const multi = computeRentalStockAvailability({
    offering_key: 'kayak_rental',
    stock_quantity: 4,
    quantity: 2,
    date_from: '2026-08-01',
    date_to: '2026-08-03',
    reservations: [
      {
        booking_id: 'r1', offering_key: 'kayak_rental', service_date: '2026-08-01',
        quantity: 1, status: 'confirmed',
      },
      {
        booking_id: 'r2', offering_key: 'kayak_rental', service_date: '2026-08-02',
        quantity: 2, status: 'confirmed',
      },
      {
        booking_id: 'r3', offering_key: 'kayak_rental', service_date: '2026-08-02',
        quantity: 1, status: 'confirmed',
      },
    ],
  });
  ok('multi-day request fails on limiting day',
    multi.ok === false && multi.error === ERROR_STOCK_UNAVAILABLE,
    JSON.stringify(multi));
  ok('limiting_date is day with min remaining',
    multi.limiting_date === '2026-08-02' && multi.remaining === 1,
    JSON.stringify(multi));

  const multiOk = computeRentalStockAvailability({
    offering_key: 'kayak_rental',
    stock_quantity: 4,
    quantity: 1,
    date_from: '2026-08-01',
    date_to: '2026-08-03',
    reservations: [
      {
        booking_id: 'r1', offering_key: 'kayak_rental', service_date: '2026-08-01',
        quantity: 1, status: 'confirmed',
      },
      {
        booking_id: 'r2', offering_key: 'kayak_rental', service_date: '2026-08-02',
        quantity: 2, status: 'confirmed',
      },
      {
        booking_id: 'r3', offering_key: 'kayak_rental', service_date: '2026-08-02',
        quantity: 1, status: 'confirmed',
      },
    ],
  });
  ok('multi-day ok when quantity fits min remaining',
    multiOk.ok === true && multiOk.remaining === 1 && multiOk.limiting_date === '2026-08-02',
    JSON.stringify(multiOk));

  console.log('\n── G. cancelled / archived / inactive booking statuses ──');
  ok('isActive: cancelled service false', isActiveReservation({ status: 'cancelled' }) === false);
  ok('isActive: booking cancelled false', isActiveReservation({ status: 'confirmed', booking_status: 'cancelled' }) === false);
  ok('isActive: booking canceled false', isActiveReservation({ status: 'confirmed', booking_status: 'canceled' }) === false);
  ok('isActive: booking expired false', isActiveReservation({ status: 'confirmed', booking_status: 'expired' }) === false);
  ok('isActive: unpaid hold occupies stock', isActiveReservation({ status: 'confirmed', booking_status: 'hold' }) === true);
  ok('isActive: schedule_archived true false', isActiveReservation({ status: 'confirmed', schedule_archived: true }) === false);
  ok('isActive: sr_schedule_archived true false', isActiveReservation({ status: 'confirmed', sr_schedule_archived: 'true' }) === false);
  ok('isActive: confirmed true', isActiveReservation({ status: 'confirmed', booking_status: 'confirmed' }) === true);

  const freed = computeRentalStockAvailability({
    offering_key: 'board_rental',
    stock_quantity: 2,
    quantity: 2,
    date_from: '2026-08-01',
    date_to: '2026-08-01',
    reservations: [
      {
        booking_id: 'c1', offering_key: 'board_rental', service_date: '2026-08-01',
        quantity: 2, status: 'cancelled',
      },
      {
        booking_id: 'c2', offering_key: 'board_rental', service_date: '2026-08-01',
        quantity: 2, status: 'confirmed', schedule_archived: true,
      },
      {
        booking_id: 'c3', offering_key: 'board_rental', service_date: '2026-08-01',
        quantity: 1, status: 'confirmed', archived: true,
      },
      {
        booking_id: 'c4', offering_key: 'board_rental', service_date: '2026-08-01',
        quantity: 2, status: 'confirmed', booking_status: 'cancelled',
      },
      {
        booking_id: 'c5', offering_key: 'board_rental', service_date: '2026-08-01',
        quantity: 2, status: 'confirmed', booking_status: 'expired',
      },
    ],
  });
  ok('cancelled + archived + expired ignored → full stock available',
    freed.ok === true && freed.remaining === 2 && freed.reserved === 0,
    JSON.stringify(freed));

  const holdOccupies = computeRentalStockAvailability({
    offering_key: 'board_rental',
    stock_quantity: 2,
    quantity: 2,
    date_from: '2026-08-01',
    date_to: '2026-08-01',
    reservations: [
      {
        booking_id: 'h1', offering_key: 'board_rental', service_date: '2026-08-01',
        quantity: 2, status: 'confirmed', booking_status: 'hold',
      },
    ],
  });
  ok('unpaid hold occupies rental stock until expiry',
    holdOccupies.ok === false && holdOccupies.reserved === 2,
    JSON.stringify(holdOccupies));

  console.log('\n── H. edit excludes booking being replaced ──');
  const edit = computeRentalStockAvailability({
    offering_key: 'board_rental',
    stock_quantity: 3,
    quantity: 2,
    date_from: '2026-08-01',
    date_to: '2026-08-01',
    exclude_booking_id: 'self',
    reservations: [
      {
        booking_id: 'self', offering_key: 'board_rental', service_date: '2026-08-01',
        quantity: 2, status: 'confirmed',
      },
      {
        booking_id: 'other', offering_key: 'board_rental', service_date: '2026-08-01',
        quantity: 1, status: 'confirmed',
      },
    ],
  });
  ok('exclude_booking_id ignores self reservation',
    edit.ok === true && edit.reserved === 1 && edit.remaining === 2,
    JSON.stringify(edit));
  const editNoExcl = computeRentalStockAvailability({
    offering_key: 'board_rental',
    stock_quantity: 3,
    quantity: 2,
    date_from: '2026-08-01',
    date_to: '2026-08-01',
    reservations: [
      {
        booking_id: 'self', offering_key: 'board_rental', service_date: '2026-08-01',
        quantity: 2, status: 'confirmed',
      },
      {
        booking_id: 'other', offering_key: 'board_rental', service_date: '2026-08-01',
        quantity: 1, status: 'confirmed',
      },
    ],
  });
  ok('without exclusion remaining is 0 (self still counted)',
    editNoExcl.ok === false && editNoExcl.remaining === 0 && editNoExcl.reserved === 3,
    JSON.stringify(editNoExcl));

  console.log('\n── I. independent offering_key — no hidden bundle deductions ──');
  const boardOnly = computeRentalStockAvailability({
    offering_key: 'board_rental',
    stock_quantity: 5,
    quantity: 5,
    date_from: '2026-08-01',
    date_to: '2026-08-01',
    reservations: [
      {
        booking_id: 'bundle1',
        offering_key: 'board_and_suit_rental',
        service_date: '2026-08-01',
        quantity: 5,
        status: 'confirmed',
      },
      {
        booking_id: 'w1', offering_key: 'wetsuit_rental', service_date: '2026-08-01',
        quantity: 5, status: 'confirmed',
      },
    ],
  });
  ok('board_rental ignores other offering_keys entirely',
    boardOnly.ok === true && boardOnly.reserved === 0 && boardOnly.remaining === 5,
    JSON.stringify(boardOnly));

  const combined = computeRentalStockAvailability({
    offering_key: 'board_and_suit_rental',
    stock_quantity: 3,
    quantity: 1,
    date_from: '2026-08-01',
    date_to: '2026-08-01',
    reservations: [
      {
        booking_id: 'bundle1',
        offering_key: 'board_and_suit_rental',
        service_date: '2026-08-01',
        quantity: 2,
        status: 'confirmed',
        pricing_group_id: 'pg1',
        rental_bundle_id: 'pg1',
        bundle_part: 'surfboard',
        rental_pricing_role: 'surfboard',
      },
      {
        booking_id: 'bundle1',
        offering_key: 'board_and_suit_rental',
        service_date: '2026-08-01',
        quantity: 2,
        status: 'confirmed',
        pricing_group_id: 'pg1',
        rental_bundle_id: 'pg1',
        bundle_part: 'wetsuit',
        rental_pricing_role: 'wetsuit',
      },
      {
        booking_id: 'b-only', offering_key: 'board_rental', service_date: '2026-08-01',
        quantity: 9, status: 'confirmed',
      },
    ],
  });
  ok('Surfboard+Wetsuit key counts only itself once for explicit group',
    combined.ok === true && combined.reserved === 2 && combined.remaining === 1,
    JSON.stringify(combined));

  console.log('\n── J. zero stock = sold out (not deleted) ──');
  const zero = computeRentalStockAvailability({
    offering_key: 'towel_rental',
    stock_quantity: 0,
    quantity: 1,
    date_from: '2026-08-01',
    date_to: '2026-08-01',
    reservations: [],
  });
  ok('stock 0 rejects any positive quantity',
    zero.ok === false && zero.error === ERROR_STOCK_UNAVAILABLE && zero.remaining === 0,
    JSON.stringify(zero));

  console.log('\n── K. deterministic row-lock contract + location fallback ──');
  const lockQ = buildRentalStockRowLockQuery({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offeringKeys: ['wetsuit_rental', 'board_rental', 'board_rental', 'kayak_rental'],
  });
  ok('lock query returns SQL with FOR UPDATE',
    lockQ && typeof lockQ.sql === 'string' && /FOR UPDATE/i.test(lockQ.sql),
    JSON.stringify(lockQ && lockQ.sql));
  ok('lock order is sorted unique offering keys',
    JSON.stringify(lockQ.lock_order) === JSON.stringify(['board_rental', 'kayak_rental', 'wetsuit_rental']),
    JSON.stringify(lockQ.lock_order));
  ok('params are client_slug, location_id, keys in lock order',
    lockQ.params[0] === 'sunset'
      && lockQ.params[1] === 'sunset-somo'
      && JSON.stringify(lockQ.params[2]) === JSON.stringify(lockQ.lock_order),
    JSON.stringify(lockQ.params));
  ok('SQL scopes by client_slug + offering_key',
    /client_slug/i.test(lockQ.sql)
      && /offering_key/i.test(lockQ.sql)
      && /tenant_rental_offerings/i.test(lockQ.sql));
  ok('SQL includes exact location OR location_id IS NULL fallback',
    /location_id = \$2 OR location_id IS NULL/i.test(lockQ.sql)
      || /\(location_id = \$2 OR location_id IS NULL\)/i.test(lockQ.sql),
    lockQ.sql);
  ok('SQL orders exact location before NULL fallback',
    /CASE WHEN location_id IS NOT DISTINCT FROM \$2 THEN 0 ELSE 1 END/i.test(lockQ.sql),
    lockQ.sql);
  ok('SQL orders by offering_key for deadlock-free lock acquisition',
    /ORDER BY\s+offering_key/i.test(lockQ.sql));

  const lockOther = buildRentalStockRowLockQuery({
    clientSlug: 'sunset',
    locationId: 'sunset-other',
    offeringKeys: ['board_rental'],
  });
  ok('location isolation in lock params',
    lockOther.params[1] === 'sunset-other' && lockOther.params[0] === 'sunset');

  // resolveLockedStockRows: exact over NULL
  const resolvedExact = resolveLockedStockRows({
    requestedKeys: ['board_rental'],
    locationId: 'sunset-somo',
    lockedRows: [
      {
        id: 'null-row', client_slug: 'sunset', location_id: null,
        offering_key: 'board_rental', stock_quantity: 99,
      },
      {
        id: 'exact-row', client_slug: 'sunset', location_id: 'sunset-somo',
        offering_key: 'board_rental', stock_quantity: 5,
      },
    ],
  });
  ok('exact location wins over NULL fallback',
    resolvedExact.missing_keys.length === 0
      && resolvedExact.resolved.length === 1
      && resolvedExact.resolved[0].row.id === 'exact-row'
      && resolvedExact.resolved[0].stock_scope === 'location'
      && resolvedExact.resolved[0].resolved_location_id === 'sunset-somo',
    JSON.stringify(resolvedExact));

  const resolvedNull = resolveLockedStockRows({
    requestedKeys: ['kayak_rental'],
    locationId: 'sunset-somo',
    lockedRows: [
      {
        id: 'null-kayak', client_slug: 'sunset', location_id: null,
        offering_key: 'kayak_rental', stock_quantity: 7,
      },
    ],
  });
  ok('NULL-location fallback selected with client stock_scope',
    resolvedNull.missing_keys.length === 0
      && resolvedNull.resolved[0].stock_scope === 'client'
      && resolvedNull.resolved[0].resolved_location_id == null
      && resolvedNull.resolved[0].row.stock_quantity === 7,
    JSON.stringify(resolvedNull));

  const lockedKeys = [];
  const mockPg = {
    query: async (sql, params) => {
      ok('lockRentalStockRows issues FOR UPDATE', /FOR UPDATE/i.test(String(sql)));
      lockedKeys.push(...(params[2] || params[1] || []));
      return {
        rows: (params[2] || []).map((k) => ({
          id: `id-${k}`,
          client_slug: params[0],
          location_id: params[1],
          offering_key: k,
          stock_quantity: 5,
        })),
        rowCount: (params[2] || []).length,
      };
    },
  };
  const locked = await lockRentalStockRows(mockPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offeringKeys: ['kayak_rental', 'board_rental'],
  });
  ok('lockRentalStockRows ok when all keys present', locked.ok === true, JSON.stringify(locked));
  ok('locked rows follow sorted order',
    locked.rows.map((r) => r.offering_key).join(',') === 'board_rental,kayak_rental',
    JSON.stringify(locked.rows));
  ok('lock acquisition order deterministic',
    lockedKeys.join(',') === 'board_rental,kayak_rental',
    lockedKeys.join(','));
  ok('resolved rows carry stock_scope location',
    locked.rows.every((r) => r.stock_scope === 'location' && r.resolved_location_id === 'sunset-somo'),
    JSON.stringify(locked.rows));

  // Missing key fail-closed
  const mockPgMissing = {
    query: async () => ({
      rows: [{
        id: 'id-board',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        offering_key: 'board_rental',
        stock_quantity: 5,
      }],
      rowCount: 1,
    }),
  };
  const lockedMissing = await lockRentalStockRows(mockPgMissing, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offeringKeys: ['board_rental', 'missing_rental'],
  });
  ok('lockRentalStockRows fails closed when key missing',
    lockedMissing.ok === false
      && lockedMissing.error === ERROR_STOCK_NOT_CONFIGURED
      && Array.isArray(lockedMissing.missing_keys)
      && lockedMissing.missing_keys.includes('missing_rental'),
    JSON.stringify(lockedMissing));
  ok('missing lock never returns ok:true with incomplete keys',
    lockedMissing.ok !== true && (!lockedMissing.rows || lockedMissing.rows.length === 0),
    JSON.stringify(lockedMissing));

  // Inactive/inaccessible: empty result set
  const mockPgEmpty = { query: async () => ({ rows: [], rowCount: 0 }) };
  const lockedEmpty = await lockRentalStockRows(mockPgEmpty, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offeringKeys: ['ghost_rental'],
  });
  ok('lockRentalStockRows fails closed when no accessible rows',
    lockedEmpty.ok === false
      && lockedEmpty.error === ERROR_STOCK_NOT_CONFIGURED
      && lockedEmpty.missing_keys.includes('ghost_rental'),
    JSON.stringify(lockedEmpty));

  console.log('\n── L. concurrency semantics at module boundary (no live DB) ──');
  const gate = createInMemoryStockTxnGate({
    offerings: {
      'sunset|sunset-somo|board_rental': { stock_quantity: 1 },
    },
  });
  const claimA = gate.runTransaction(async (txn) => {
    const lock = await txn.lockStockRows({
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      offeringKeys: ['board_rental'],
    });
    if (!lock.ok) return lock;
    const check = txn.checkAvailability({
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      offering_key: 'board_rental',
      quantity: 1,
      date_from: '2026-08-01',
      date_to: '2026-08-01',
    });
    if (!check.ok) return check;
    txn.reserve({
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      offering_key: 'board_rental',
      booking_id: 'booking-A',
      quantity: 1,
      date_from: '2026-08-01',
      date_to: '2026-08-01',
    });
    return { ok: true, booking_id: 'booking-A' };
  });
  const claimB = gate.runTransaction(async (txn) => {
    const lock = await txn.lockStockRows({
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      offeringKeys: ['board_rental'],
    });
    if (!lock.ok) return lock;
    const check = txn.checkAvailability({
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      offering_key: 'board_rental',
      quantity: 1,
      date_from: '2026-08-01',
      date_to: '2026-08-01',
    });
    if (!check.ok) return check;
    txn.reserve({
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      offering_key: 'board_rental',
      booking_id: 'booking-B',
      quantity: 1,
      date_from: '2026-08-01',
      date_to: '2026-08-01',
    });
    return { ok: true, booking_id: 'booking-B' };
  });
  const [resA, resB] = await Promise.all([claimA, claimB]);
  const successes = [resA, resB].filter((r) => r && r.ok === true);
  const failures = [resA, resB].filter((r) => r && r.ok === false);
  ok('exactly one concurrent last-unit claim succeeds',
    successes.length === 1, JSON.stringify({ resA, resB }));
  ok('loser fails with rental_stock_unavailable',
    failures.length === 1 && failures[0].error === ERROR_STOCK_UNAVAILABLE,
    JSON.stringify({ resA, resB }));

  // Missing-row concurrent: both fail closed; no phantom offering created
  const missingGate = createInMemoryStockTxnGate({ offerings: {} });
  const missA = missingGate.runTransaction(async (txn) => {
    const lock = await txn.lockStockRows({
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      offeringKeys: ['phantom_rental'],
    });
    if (!lock.ok) return lock;
    return { ok: true, unexpected: true };
  });
  const missB = missingGate.runTransaction(async (txn) => {
    const lock = await txn.lockStockRows({
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      offeringKeys: ['phantom_rental'],
    });
    if (!lock.ok) return lock;
    return { ok: true, unexpected: true };
  });
  const [mA, mB] = await Promise.all([missA, missB]);
  ok('concurrent missing-row claims both fail closed',
    mA.ok === false && mB.ok === false
      && mA.error === ERROR_STOCK_NOT_CONFIGURED
      && mB.error === ERROR_STOCK_NOT_CONFIGURED,
    JSON.stringify({ mA, mB }));
  ok('no phantom offering synthesized in gate state',
    missingGate._debugState().size === 0
      || ![...missingGate._debugState().keys()].some((k) => k.includes('phantom_rental')
        && missingGate._debugState().get(k).stock_quantity != null),
    JSON.stringify([...missingGate._debugState().keys()]));
  // Stronger: gate must not invent a configured row for phantom
  const phantomKeys = [...missingGate._debugState().entries()]
    .filter(([k]) => k.includes('phantom_rental'));
  ok('missing concurrent lock never creates phantom stock row',
    phantomKeys.length === 0,
    JSON.stringify(phantomKeys));

  // Deadlock-free multi-key order
  const orderLog = [];
  const gate2 = createInMemoryStockTxnGate({
    offerings: {
      'sunset|sunset-somo|board_rental': { stock_quantity: 5 },
      'sunset|sunset-somo|kayak_rental': { stock_quantity: 5 },
    },
    onLock: (key) => orderLog.push(key),
  });
  await Promise.all([
    gate2.runTransaction(async (txn) => {
      await txn.lockStockRows({
        clientSlug: 'sunset',
        locationId: 'sunset-somo',
        offeringKeys: ['kayak_rental', 'board_rental'],
      });
      return { ok: true };
    }),
    gate2.runTransaction(async (txn) => {
      await txn.lockStockRows({
        clientSlug: 'sunset',
        locationId: 'sunset-somo',
        offeringKeys: ['board_rental', 'kayak_rental'],
      });
      return { ok: true };
    }),
  ]);
  const pairs = [];
  for (let i = 0; i + 1 < orderLog.length; i += 2) {
    pairs.push([orderLog[i], orderLog[i + 1]]);
  }
  ok('each txn acquires locks in sorted offering_key order',
    pairs.length === 2
      && pairs.every((p) => p[0].endsWith('board_rental') && p[1].endsWith('kayak_rental')),
    JSON.stringify(orderLog));

  console.log('\n── M. production reservation SQL: date overlap + active truth ──');
  const resQ = buildActiveRentalReservationsQuery({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offeringKey: 'board_rental',
    dateFrom: '2026-08-03',
    dateTo: '2026-08-04',
    defaultLocationId: 'sunset-somo',
  });
  ok('reservation SQL joins bookings + clients for isolation',
    /INNER JOIN bookings b/i.test(resQ.sql)
      && /INNER JOIN clients c/i.test(resQ.sql)
      && /c\.slug = \$1/i.test(resQ.sql)
      && /sr\.client_slug = \$1/i.test(resQ.sql),
    resQ.sql);
  ok('reservation SQL excludes cancelled service status',
    /sr\.status <> 'cancelled'/i.test(resQ.sql), resQ.sql);
  ok('reservation SQL excludes cancelled/canceled/expired; unpaid holds occupy stock',
    /NOT IN \('cancelled', 'canceled', 'expired'\)/i.test(resQ.sql)
      && !/NOT IN \('cancelled', 'canceled', 'expired', 'hold'\)/i.test(resQ.sql),
    resQ.sql);
  ok('reservation SQL excludes booking schedule_archived',
    /b\.metadata->>'schedule_archived'/.test(resQ.sql)
      && /<> 'true'/.test(resQ.sql),
    resQ.sql);
  ok('reservation SQL excludes service schedule_archived',
    /sr\.metadata->>'schedule_archived'/.test(resQ.sql),
    resQ.sql);
  ok('reservation SQL uses rental_service_dates array overlap (not only service_date BETWEEN)',
    /rental_service_dates/i.test(resQ.sql)
      && /jsonb_array_elements_text/i.test(resQ.sql)
      && /jsonb_typeof/i.test(resQ.sql),
    resQ.sql);
  ok('reservation SQL supports covered_dates array overlap',
    /covered_dates/i.test(resQ.sql),
    resQ.sql);
  ok('reservation SQL has service_date fallback when no usable array dates',
    /service_date >= \$3::date/i.test(resQ.sql)
      && /service_date <= \$4::date/i.test(resQ.sql),
    resQ.sql);
  ok('window params are Aug 3..4 for overlap load test',
    resQ.params[2] === '2026-08-03' && resQ.params[3] === '2026-08-04',
    JSON.stringify(resQ.params));

  // ── Location inheritance: sr.metadata → b.metadata → explicit default only ──
  ok('location-scoped reservation SQL uses sr then booking then explicit default',
    resQ.stock_scope === 'location'
      && /COALESCE\s*\(\s*NULLIF\s*\(\s*sr\.metadata->>'location_id'\s*,\s*''\s*\)/i.test(resQ.sql)
      && /NULLIF\s*\(\s*b\.metadata->>'location_id'\s*,\s*''\s*\)/i.test(resQ.sql),
    resQ.sql);
  ok('Sunset defaultLocationId sunset-somo is bound (not silent requested-location assign)',
    resQ.default_location_id === 'sunset-somo'
      && resQ.params.includes('sunset-somo')
      && resQ.params.filter((p) => p === 'sunset-somo').length >= 2,
    JSON.stringify({ params: resQ.params, default: resQ.default_location_id }));
  ok('location clause does not equate empty metadata to requested location alone',
    !/COALESCE\s*\(\s*sr\.metadata->>'location_id'\s*,\s*''\s*\)\s*=\s*COALESCE\s*\(\s*\$\d+\s*,\s*''\s*\)/i.test(resQ.sql),
    resQ.sql);

  // Pure location resolution (caller-facing semantics)
  const {
    resolveReservationLocationId,
    sqlOccupiedDateOverlap,
    coerceIsoDateArray,
    reservationHasUsableOccupiedDates,
  } = mod;
  ok('resolve: service metadata location wins',
    resolveReservationLocationId({
      serviceLocationId: 'sunset-sardinero',
      bookingLocationId: 'sunset-somo',
      defaultLocationId: 'sunset-somo',
    }) === 'sunset-sardinero');
  ok('resolve: booking metadata when service empty (legacy sr-less location)',
    resolveReservationLocationId({
      serviceLocationId: '',
      bookingLocationId: 'sunset-sardinero',
      defaultLocationId: 'sunset-somo',
    }) === 'sunset-sardinero');
  ok('resolve: explicit default when neither location present',
    resolveReservationLocationId({
      serviceLocationId: null,
      bookingLocationId: null,
      defaultLocationId: 'sunset-somo',
    }) === 'sunset-somo');
  ok('resolve: without explicit default, missing rows stay null (not arbitrary requested)',
    resolveReservationLocationId({
      serviceLocationId: '',
      bookingLocationId: '',
      defaultLocationId: null,
    }) == null);
  ok('resolve: different booking location is not replaced by default',
    resolveReservationLocationId({
      serviceLocationId: null,
      bookingLocationId: 'sunset-sardinero',
      defaultLocationId: 'sunset-somo',
    }) === 'sunset-sardinero');

  // Location stock inclusion via pure match (location-scoped demand)
  function locationMatches(resolved, requested) {
    return resolved != null && resolved === requested;
  }
  ok('location stock includes legacy row with only booking metadata location',
    locationMatches(
      resolveReservationLocationId({
        serviceLocationId: null,
        bookingLocationId: 'sunset-somo',
        defaultLocationId: 'sunset-somo',
      }),
      'sunset-somo',
    ));
  ok('location stock includes legacy neither-location only when default matches',
    locationMatches(
      resolveReservationLocationId({
        serviceLocationId: null,
        bookingLocationId: null,
        defaultLocationId: 'sunset-somo',
      }),
      'sunset-somo',
    )
      && !locationMatches(
        resolveReservationLocationId({
          serviceLocationId: null,
          bookingLocationId: null,
          defaultLocationId: 'sunset-sardinero',
        }),
        'sunset-somo',
      ));
  ok('different booking location remains excluded from sunset-somo stock',
    !locationMatches(
      resolveReservationLocationId({
        serviceLocationId: null,
        bookingLocationId: 'sunset-sardinero',
        defaultLocationId: 'sunset-somo',
      }),
      'sunset-somo',
    ));

  // No defaultLocationId: SQL still binds null default; does not inject locationId as default
  const noDefaultQ = buildActiveRentalReservationsQuery({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offeringKey: 'board_rental',
    dateFrom: '2026-08-03',
    dateTo: '2026-08-04',
  });
  ok('without defaultLocationId contract returns null default_location_id',
    noDefaultQ.default_location_id == null
      && noDefaultQ.stock_scope === 'location',
    JSON.stringify(noDefaultQ.params));

  // Anchor Aug 1 + covered Aug 1..6 must load for window Aug 3..4 (pure expand proof)
  const multiDayLoad = expandReservationDemand({
    booking_id: 'prod-1',
    offering_key: 'board_rental',
    service_date: '2026-08-01', // anchor outside Aug 3..4
    quantity: 1,
    rental_service_dates: [
      '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06',
    ],
  });
  const overlapDays = multiDayLoad.filter((d) => d.date === '2026-08-03' || d.date === '2026-08-04');
  ok('anchor Aug 1 + covered Aug 1..6 expands into Aug 3..4 demand units',
    multiDayLoad.length === 6 && overlapDays.length === 2,
    JSON.stringify(multiDayLoad));

  // SQL must NOT rely solely on service_date BETWEEN (would miss this row)
  ok('SQL does not use sole service_date BETWEEN without array path',
    !/sr\.service_date BETWEEN/i.test(resQ.sql)
      && /jsonb_array_elements_text/i.test(resQ.sql),
    resQ.sql);

  // Malformed JSON safety: jsonb_typeof guards present
  ok('SQL guards non-array JSONB with jsonb_typeof',
    (resQ.sql.match(/jsonb_typeof/g) || []).length >= 2,
    resQ.sql);

  // ── Date-array SQL safety: no untrusted ::date cast; anchored ISO; fallback parity ──
  const overlapFrag = typeof sqlOccupiedDateOverlap === 'function'
    ? sqlOccupiedDateOverlap('$3', '$4')
    : resQ.sql;
  ok('SQL never casts array element with val::date (or d.val::date)',
    !/\bval\s*::\s*date\b/i.test(overlapFrag)
      && !/\bd\.val\s*::\s*date\b/i.test(resQ.sql)
      && !/::date\s*>=\s*\$3/i.test(overlapFrag.replace(/service_date\s*>=\s*\$3::date/gi, '')),
    overlapFrag);
  ok('SQL uses fully anchored YYYY-MM-DD regex (start and end)',
    /~\s*'\\^\\\\d\{4\}-\\\\d\{2\}-\\\\d\{2\}\$'/.test(resQ.sql)
      || /~\s*'\\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$'/.test(resQ.sql)
      || /val\s*~\s*'[\^].*[\$]'/.test(resQ.sql),
    resQ.sql);
  ok('SQL compares array dates lexically to ISO params as text (no element cast)',
    /val\s*>=\s*\$3::text/i.test(resQ.sql) || /val\s*>=\s*\(\$3\)::text/i.test(resQ.sql)
      || (/val\s*>=\s*\$3/i.test(resQ.sql) && !/val\s*::\s*date/i.test(resQ.sql)),
    resQ.sql);

  // Pure: coerce / usable-date / expand fallback parity with isIsoDate exact shape
  ok('junk 2026-08-01junk is not a usable exact ISO date element',
    coerceIsoDateArray(['2026-08-01junk']).length === 0
      && !reservationHasUsableOccupiedDates({
        rental_service_dates: ['2026-08-01junk'],
        covered_dates: ['2026-08-01junk'],
      }));
  ok('2026-99-99 is exact shape (usable) but never requires DB cast in SQL fragment',
    coerceIsoDateArray(['2026-99-99']).length === 1
      && coerceIsoDateArray(['2026-99-99'])[0] === '2026-99-99'
      && !/val\s*::\s*date/i.test(overlapFrag));
  const junkFallback = expandReservationDemand({
    booking_id: 'junk1',
    offering_key: 'board_rental',
    service_date: '2026-08-03',
    quantity: 1,
    rental_service_dates: ['2026-08-01junk', 'not-a-date'],
    covered_dates: ['2026-99'], // wrong length
  });
  ok('nonempty malformed arrays + valid service_date use fallback anchor',
    junkFallback.length === 1 && junkFallback[0].date === '2026-08-03',
    JSON.stringify(junkFallback));
  ok('junk date does not suppress fallback (no usable array dates)',
    reservationHasUsableOccupiedDates({
      rental_service_dates: ['2026-08-01junk'],
      covered_dates: [],
    }) === false);

  const validOverlap = expandReservationDemand({
    booking_id: 'ok1',
    offering_key: 'board_rental',
    service_date: '2026-08-01',
    quantity: 1,
    rental_service_dates: ['2026-08-03', '2026-08-04'],
  });
  ok('valid date array overlap still expands those dates (not only anchor)',
    validOverlap.map((d) => d.date).join(',') === '2026-08-03,2026-08-04',
    JSON.stringify(validOverlap));

  const outsideWindow = expandReservationDemand({
    booking_id: 'out1',
    offering_key: 'board_rental',
    service_date: '2026-08-03', // would be in window if fallback applied
    quantity: 1,
    rental_service_dates: ['2026-08-10', '2026-08-11'],
  });
  ok('valid arrays outside window do not fall back to service_date anchor',
    outsideWindow.length === 2
      && outsideWindow.every((d) => d.date === '2026-08-10' || d.date === '2026-08-11')
      && !outsideWindow.some((d) => d.date === '2026-08-03'),
    JSON.stringify(outsideWindow));

  // SQL fallback must check for usable exact-format dates, not merely empty arrays
  ok('SQL fallback triggers when arrays nonempty but have no exact ISO elements',
    /NOT EXISTS/i.test(resQ.sql)
      || (/~\s*'\\^/.test(resQ.sql) && /service_date\s*>=/.test(resQ.sql)),
    resQ.sql);
  // Prefer explicit NOT EXISTS over length-only empty check for fallback
  ok('SQL fallback is not only jsonb_array_length > 0 empty-array gate',
    !/\bjsonb_array_length\s*\(\s*sr\.metadata->'rental_service_dates'\s*\)\s*>\s*0/.test(resQ.sql)
      || /NOT EXISTS/i.test(resQ.sql),
    resQ.sql);

  // Client-wide shared stock: no location filter
  const sharedQ = buildActiveRentalReservationsQuery({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offeringKey: 'board_rental',
    dateFrom: '2026-08-03',
    dateTo: '2026-08-04',
    stockScope: 'client',
    defaultLocationId: 'sunset-somo',
  });
  ok('client stock_scope omits location filtering (shared stock across locations)',
    sharedQ.stock_scope === 'client'
      && !/NULLIF\s*\(\s*sr\.metadata->>'location_id'/i.test(sharedQ.sql)
      && !/NULLIF\s*\(\s*b\.metadata->>'location_id'/i.test(sharedQ.sql),
    sharedQ.sql);

  // Cross-location shared stock semantics via compute: same offering reserved at any location counts against client-wide stock
  // (callers load without location filter when stock_scope=client; pure math then sums all).
  const sharedAvail = computeRentalStockAvailability({
    offering_key: 'board_rental',
    stock_quantity: 3,
    quantity: 1,
    date_from: '2026-08-03',
    date_to: '2026-08-03',
    reservations: [
      // reservation originally booked at location A
      {
        booking_id: 'locA', offering_key: 'board_rental', service_date: '2026-08-03',
        quantity: 2, status: 'confirmed',
      },
      // reservation originally booked at location B — still counts under client-wide stock
      {
        booking_id: 'locB', offering_key: 'board_rental', service_date: '2026-08-03',
        quantity: 1, status: 'confirmed',
      },
    ],
  });
  ok('client-wide shared stock sums demand across locations (remaining 0)',
    sharedAvail.ok === false && sharedAvail.reserved === 3 && sharedAvail.remaining === 0,
    JSON.stringify(sharedAvail));

  // Configured stock query also uses exact-over-null precedence
  const cfgQ = buildConfiguredStockQuery({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offeringKey: 'board_rental',
  });
  ok('configured stock SQL prefers exact location then NULL fallback',
    /location_id = \$2 OR location_id IS NULL/i.test(cfgQ.sql)
      && /CASE WHEN location_id IS NOT DISTINCT FROM \$2 THEN 0 ELSE 1 END/i.test(cfgQ.sql),
    cfgQ.sql);

  // Cross-client never: SQL always binds client_slug / clients.slug
  ok('reservation SQL never omits client isolation predicates',
    /c\.slug = \$1/.test(resQ.sql) && /sr\.client_slug = \$1/.test(resQ.sql));

  // In-memory location fallback: exact wins; NULL used when no exact
  const locGate = createInMemoryStockTxnGate({
    offerings: {
      'sunset||board_rental': { stock_quantity: 10, location_id: null, offering_key: 'board_rental', client_slug: 'sunset' },
      'sunset|sunset-somo|board_rental': { stock_quantity: 2, location_id: 'sunset-somo', offering_key: 'board_rental', client_slug: 'sunset' },
    },
  });
  const exactLock = await locGate.runTransaction(async (txn) => txn.lockStockRows({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offeringKeys: ['board_rental'],
  }));
  ok('in-memory lock resolves exact location over NULL',
    exactLock.ok === true
      && exactLock.rows[0].stock_quantity === 2
      && exactLock.rows[0].stock_scope === 'location',
    JSON.stringify(exactLock));

  const nullOnlyGate = createInMemoryStockTxnGate({
    offerings: {
      'sunset||kayak_rental': { stock_quantity: 4, location_id: null, offering_key: 'kayak_rental', client_slug: 'sunset' },
    },
  });
  const nullLock = await nullOnlyGate.runTransaction(async (txn) => txn.lockStockRows({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offeringKeys: ['kayak_rental'],
  }));
  ok('in-memory lock falls back to NULL-location shared stock',
    nullLock.ok === true
      && nullLock.rows[0].stock_quantity === 4
      && nullLock.rows[0].stock_scope === 'client'
      && nullLock.rows[0].resolved_location_id == null,
    JSON.stringify(nullLock));

  // Cross-client isolation in gate
  const crossGate = createInMemoryStockTxnGate({
    offerings: {
      'other||board_rental': { stock_quantity: 99, location_id: null, offering_key: 'board_rental', client_slug: 'other' },
    },
  });
  const crossLock = await crossGate.runTransaction(async (txn) => txn.lockStockRows({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offeringKeys: ['board_rental'],
  }));
  ok('cross-client stock rows never accessible',
    crossLock.ok === false
      && crossLock.error === ERROR_STOCK_NOT_CONFIGURED
      && crossLock.missing_keys.includes('board_rental'),
    JSON.stringify(crossLock));

  console.log(`\nverify-tenant-rental-stock  pass=${pass}  fail=${fail}`);
  if (fail === 0) console.log('verify-tenant-rental-stock — ALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
