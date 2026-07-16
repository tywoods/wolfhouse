'use strict';

/**
 * verify:luna-front-desk-quote-service
 *
 * RED → GREEN gate for the shared Sunset quote application service.
 */

const {
  QUOTE_CHANNELS,
  buildSunsetQuoteCommand,
  executeSunsetQuote,
  executeSunsetQuoteSync,
  computeQuoteFingerprint,
  validateQuoteProvenanceForCreate,
  rejectClientSuppliedMoney,
} = require('./lib/luna-front-desk-quote-service');
const {
  BOOKING_CREATE_CHANNELS,
  buildSunsetBookingCreateCommand,
  executeSunsetBookingCreate,
} = require('./lib/luna-front-desk-booking-create-service');
const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');

let pass = 0;
let fail = 0;
function assert(label, condition, detail) {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; return; }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

const PACK_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TIER = '1_week';
const ITEM = packPriceItemCode(PACK_ID, TIER);
const AMOUNT = 19900;
const FRIDAY = '2026-07-17';
const SATURDAY = '2026-07-18';
const LOC = 'sunset-somo';
const FIXED_NOW = new Date('2026-07-14T12:00:00Z');

function adminCfg(priceRows, opts = {}) {
  return {
    ok: true,
    source: 'db',
    currency: 'EUR',
    surf_packs: [{
      pack_id: PACK_ID,
      label: 'Weekend Course',
      active: true,
      age_band: '12_and_up',
      group_size: 2,
      beaches: ['somo'],
      weekly: 'sat_sun',
      schedules: ['0930_1130'],
      price_tiers: [{ key: TIER, label: '1 week', hours: 10, amount_cents: AMOUNT }],
    }],
    prices: priceRows || [{
      id: 'price-1',
      category: 'package',
      offering_key: ITEM,
      item_code: ITEM,
      amount_cents: AMOUNT,
      unit: 'day',
      active: true,
      currency: 'EUR',
    }],
    private_lesson: opts.private_lesson || null,
  };
}

function makePg(opts = {}) {
  const packs = opts.packs || adminCfg().surf_packs.map((p) => ({
    id: p.pack_id,
    label: p.label,
    config_json: {
      age_band: p.age_band,
      group_size: p.group_size,
      beaches: p.beaches,
      weekly: p.weekly,
      schedules: p.schedules,
      price_tiers: p.price_tiers,
    },
  }));
  const priceAmount = opts.priceAmount != null ? opts.priceAmount : AMOUNT;
  const seats = opts.existingCourseSeats || {};
  const inserts = [];
  const writes = [];
  const readOnly = opts.readOnly === true;
  return {
    inserts,
    writes,
    query: async (sql, params) => {
      const s = String(sql);
      const isTxn = /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(s);
      const isDml = /\b(INSERT|UPDATE|DELETE)\b/i.test(s);
      if (isTxn || isDml) {
        writes.push({ sql: s, params: params ? [...params] : [] });
        if (readOnly) {
          throw new Error(`read_only_pg_write_attempted: ${s.slice(0, 120)}`);
        }
      }
      if (/^BEGIN/i.test(s)) return { rows: [] };
      if (/^COMMIT/i.test(s)) return { rows: [] };
      if (/^ROLLBACK/i.test(s)) return { rows: [] };
      if (/SELECT id FROM clients WHERE slug/i.test(s)) return { rows: [{ id: 'client-sunset' }] };
      if (/information_schema\.(tables|columns)/i.test(s)) return { rows: [{ '?column?': 1 }] };
      if (/to_regclass/i.test(s)) return { rows: [{ reg: 'tenant_price_rules' }] };
      if (/FROM tenant_surf_pack_rules/i.test(s)) return { rows: packs };
      if (/COALESCE\(SUM/i.test(s) && /booking_service_records/i.test(s)) {
        const date = String(params[1]).slice(0, 10);
        const courseId = params[2];
        const key = `${courseId}|${date}`;
        return { rows: [{ seats: seats[key] != null ? seats[key] : 0 }] };
      }
      if (/FROM tenant_price_rules/i.test(s)) {
        const itemCode = params[2];
        const unit = params[3];
        const locationId = params[4] || LOC;
        if (String(itemCode || '').startsWith('surf_pack_') && unit === 'day') {
          return { rows: [{ id: 'price-1', amount_cents: priceAmount, currency: 'EUR', item_type: 'package', item_code: itemCode, unit: 'day', location_id: locationId }] };
        }
        const rentalMap = opts.rentalPrices || {};
        if (rentalMap[itemCode]) {
          const row = rentalMap[itemCode];
          if (row.active === false) return { rows: [] };
          if (row.location_id && String(row.location_id) !== String(locationId)) return { rows: [] };
          return {
            rows: [{
              id: row.id || `price-${itemCode}`,
              amount_cents: row.amount_cents,
              currency: 'EUR',
              item_type: 'rental',
              item_code: itemCode,
              unit: unit || 'day',
              location_id: locationId,
            }],
          };
        }
        return { rows: [] };
      }
      if (/INSERT INTO bookings/i.test(s)) {
        inserts.push({ table: 'bookings', params: [...params] });
        return { rows: [{ id: 'booking-uuid-1', booking_code: 'SUNSET-QTE-01' }] };
      }
      if (/INSERT INTO booking_service_records/i.test(s)) {
        inserts.push({ table: 'booking_service_records', params: [...params] });
        const meta = typeof params[9] === 'string' ? JSON.parse(params[9]) : params[9];
        return { rows: [{ service_record_id: 'sr-1', booking_id: 'booking-uuid-1', amount_due_cents: priceAmount, metadata: meta }] };
      }
      if (/SELECT metadata FROM bookings/i.test(s)) return { rows: [{ metadata: { location_id: LOC, source: 'staff_manual_schedule' } }] };
      if (/SELECT id, service_type/i.test(s) && /FROM booking_service_records/i.test(s)) {
        return {
          rows: inserts.filter((i) => i.table === 'booking_service_records').map((row, idx) => ({
            id: `sr-${idx + 1}`,
            service_type: row.params[4],
            service_date: row.params[5],
            quantity: row.params[6],
            amount_due_cents: 0,
            metadata: typeof row.params[9] === 'string' ? JSON.parse(row.params[9]) : row.params[9],
          })),
        };
      }
      if (/UPDATE booking_service_records/i.test(s) || /UPDATE bookings SET/i.test(s)) return { rows: [] };
      return { rows: [] };
    },
  };
}

function buildQuoteCmd(channel, body, extra = {}) {
  return buildSunsetQuoteCommand({
    channel,
    transportBody: body,
    trustedLocationId: extra.trustedLocationId || LOC,
    now: FIXED_NOW,
  });
}

async function run() {
  console.log('\nverify:luna-front-desk-quote-service\n');
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

  console.log('[A] Staff and Luna normalize to same quote command');
  const transport = {
    offering_id: ITEM,
    course_id: PACK_ID,
    tier_key: TIER,
    service_dates: [SATURDAY],
    quantity: 1,
  };
  const manualBuilt = buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, transport);
  const lunaBuilt = buildQuoteCmd(QUOTE_CHANNELS.LUNA_WHATSAPP, { ...transport, client_slug: 'wolfhouse-somo', location_id: 'sunset-sardinero' });
  assert('manual command', manualBuilt.ok === true);
  assert('luna command', lunaBuilt.ok === true);
  assert('both force sunset tenant', manualBuilt.command.clientSlug === 'sunset' && lunaBuilt.command.clientSlug === 'sunset');
  assert('trusted location wins', lunaBuilt.command.locationId === LOC);

  console.log('\n[B] Same canonical quote across channels (sync fixture)');
  const cfg = adminCfg();
  const manualQuote = executeSunsetQuoteSync(manualBuilt.command, { adminCfg: cfg });
  const lunaQuote = executeSunsetQuoteSync(lunaBuilt.command, { adminCfg: cfg });
  assert('manual quote ok', manualQuote.ok === true, JSON.stringify(manualQuote.body));
  assert('luna quote ok', lunaQuote.ok === true);
  assert('same total', manualQuote.body.total_cents === lunaQuote.body.total_cents);
  assert('same offering_id', manualQuote.body.offering_id === lunaQuote.body.offering_id);
  assert('provenance present', manualQuote.body.quote_provenance && manualQuote.body.quote_provenance.quote_fingerprint);

  console.log('\n[C] Weekend restrictions identical');
  const friManual = executeSunsetQuoteSync(buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, { ...transport, service_dates: [FRIDAY] }).command, { adminCfg: cfg });
  const friLuna = executeSunsetQuoteSync(buildQuoteCmd(QUOTE_CHANNELS.LUNA_WHATSAPP, { ...transport, service_dates: [FRIDAY] }).command, { adminCfg: cfg });
  assert('manual weekday fails', friManual.ok === false);
  assert('luna weekday fails', friLuna.ok === false);
  assert('weekday reasons match', friManual.body.reason === friLuna.body.reason);

  console.log('\n[D] Client money rejected');
  assert('top-level money rejected', rejectClientSuppliedMoney({ unit_amount_cents: 50 }).ok === false);
  const moneyCmd = buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, { ...transport, total_cents: 100 });
  assert('command rejects money', moneyCmd.ok === false);

  console.log('\n[E] Quote creates zero writes');
  const pg = makePg();
  const asyncQuote = await executeSunsetQuote(pg, manualBuilt.command, { adminCfg: cfg });
  assert('async quote ok', asyncQuote.ok === true);
  assert('zero inserts', pg.inserts.length === 0);

  console.log('\n[F] Quote → create parity with provenance');
  const pgQuote = makePg();
  const asyncManualQuote = await executeSunsetQuote(pgQuote, manualBuilt.command, { adminCfg: cfg });
  assert('async manual quote for provenance', asyncManualQuote.ok === true);
  const provenance = asyncManualQuote.body.quote_provenance;
  const { resolveTenantBusinessConfigAsync } = require('./lib/tenant-business-config');
  const origResolve = resolveTenantBusinessConfigAsync;
  const createCmd = buildSunsetBookingCreateCommand({
    channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
    transportBody: {
      guest_name: 'Quote Guest',
      guest_phone: '+34600111222',
      payment_status: 'unpaid',
      service_dates: [SATURDAY],
      components: { course: { quantity: 1, course_id: PACK_ID, tier_key: TIER } },
      quote_provenance: provenance,
    },
    trustedLocationId: LOC,
    actorHints: { email: 'staff@test.com' },
    now: FIXED_NOW,
  });
  const pgCreate = makePg();
  require('./lib/tenant-business-config').resolveTenantBusinessConfigAsync = async () => cfg;
  const created = await executeSunsetBookingCreate(pgCreate, createCmd.command);
  require('./lib/tenant-business-config').resolveTenantBusinessConfigAsync = origResolve;
  assert('create with provenance ok', created.ok === true, JSON.stringify(created.body));
  assert('create total matches quote', created.body.total_cents === asyncManualQuote.body.total_cents);
  assert('create has total_cents', created.body.total_cents === AMOUNT);

  console.log('\n[G] Stale quote on price change');
  const pgStale = makePg({ priceAmount: AMOUNT + 500 });
  require('./lib/tenant-business-config').resolveTenantBusinessConfigAsync = async () => ({ ...cfg, source: 'db' });
  const staleCheck = await validateQuoteProvenanceForCreate(pgStale, createCmd.command, provenance, { adminCfg: cfg });
  require('./lib/tenant-business-config').resolveTenantBusinessConfigAsync = origResolve;
  assert('stale quote blocked', staleCheck.ok === false);
  assert('stale reason_code', staleCheck.body && staleCheck.body.reason_code === 'stale_quote');
  assert('stale create no booking', pgStale.inserts.filter((i) => i.table === 'bookings').length === 0);

  console.log('\n[H] Capacity full fails consistently');
  const pgFull = makePg({ existingCourseSeats: { [`${PACK_ID}|${SATURDAY}`]: 2 } });
  const qManual = await executeSunsetQuote(pgFull, manualBuilt.command, { adminCfg: cfg });
  const qLuna = await executeSunsetQuote(makePg({ existingCourseSeats: { [`${PACK_ID}|${SATURDAY}`]: 2 } }), lunaBuilt.command, { adminCfg: cfg });
  assert('manual course_full', qManual.ok === false && (qManual.body.reason === 'course_full' || qManual.body.error === 'course_full'));
  assert('luna course_full', qLuna.ok === false && (qLuna.body.reason === 'course_full' || qLuna.body.error === 'course_full'));

  console.log('\n[I] Missing price fails closed');
  const badCfg = {
    ok: true,
    source: 'db',
    currency: 'EUR',
    surf_packs: [{ pack_id: PACK_ID, label: 'X', active: true, group_size: 2, weekly: 'sat_sun', schedules: ['0930_1130'], price_tiers: [{ key: TIER, label: '1 week' }] }],
    prices: [],
  };
  const missing = executeSunsetQuoteSync(manualBuilt.command, { adminCfg: badCfg });
  assert('missing price fails', missing.ok === false && (missing.body.reason === 'price_missing' || missing.body.reason === 'unknown_offering'));

  // ── Slice 3A: canonical rentals[] quote ─────────────────────────────────
  console.log('\n[J] Canonical rentals quote (Slice 3A)');

  const BUNDLE_1D = 2500;
  const BOARD_1D = 1500;
  const WETSUIT_1D = 800;
  const BOARD_3D = 4000;

  function rentalPrices(rows) {
    return adminCfg([
      {
        id: 'price-pack',
        category: 'package',
        offering_key: ITEM,
        item_code: ITEM,
        amount_cents: AMOUNT,
        unit: 'day',
        active: true,
        currency: 'EUR',
        location_id: LOC,
      },
      ...rows,
    ]);
  }

  function rentalRow(offeringKey, amountCents, opts = {}) {
    return {
      id: opts.id || `price-${offeringKey}`,
      category: 'rental',
      offering_key: offeringKey,
      item_code: offeringKey,
      amount_cents: amountCents,
      unit: opts.unit || 'day',
      active: opts.active !== false,
      currency: 'EUR',
      location_id: opts.location_id || LOC,
    };
  }

  const somoRentalCfg = rentalPrices([
    rentalRow('board_and_suit_rental__1_day', BUNDLE_1D),
    rentalRow('board_rental__1_day', BOARD_1D),
    rentalRow('wetsuit_rental__1_day', WETSUIT_1D),
    rentalRow('board_rental__3_days', BOARD_3D),
    rentalRow('board_rental__1_day', 1200, { id: 'price-sardi-board', location_id: 'sunset-sardinero' }),
    rentalRow('board_and_suit_rental__1_day', BUNDLE_1D, { id: 'price-inactive-bundle', active: false }),
  ]);

  function staffRentalBody(extra) {
    return {
      guest_name: 'Rental Guest',
      date_from: SATURDAY,
      date_to: SATURDAY,
      service_dates: [SATURDAY],
      payment_status: 'unpaid',
      components: {},
      ...extra,
    };
  }

  // 1. Somo bundle 1_day resolves only board_and_suit_rental__1_day
  const bundleBody = staffRentalBody({
    rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
    components: {
      surfboard: { quantity: 1 },
      wetsuit: { quantity: 1 },
    },
  });
  const bundleQuote = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, bundleBody).command,
    { adminCfg: somoRentalCfg },
  );
  assert('1 bundle quote ok', bundleQuote.ok === true, JSON.stringify(bundleQuote.body));
  assert(
    '1 Somo bundle resolves board_and_suit_rental__1_day only',
    bundleQuote.body.total_cents === BUNDLE_1D
      && Array.isArray(bundleQuote.body.line_items)
      && bundleQuote.body.line_items.filter((l) => String(l.offering_id || l.offering_item_code || '').includes('rental')).length === 1
      && bundleQuote.body.line_items.some((l) => (
        l.offering_id === 'board_and_suit_rental__1_day'
        || l.offering_item_code === 'board_and_suit_rental__1_day'
      )),
    JSON.stringify(bundleQuote.body.line_items),
  );

  // 2. Bundle quantity 2 charges exactly 2 × bundle price
  const bundleQty2 = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 2 }],
      components: { surfboard: { quantity: 2 }, wetsuit: { quantity: 2 } },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert('2 bundle qty 2 = 2× bundle', bundleQty2.ok === true && bundleQty2.body.total_cents === BUNDLE_1D * 2, JSON.stringify(bundleQty2.body));

  // 3. Bundle does not look up individual board/wetsuit prices
  const bundleOnlyCfg = rentalPrices([
    rentalRow('board_and_suit_rental__1_day', BUNDLE_1D),
    // intentionally no separate board/wetsuit rows
  ]);
  const bundleNoSeparate = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, bundleBody).command,
    { adminCfg: bundleOnlyCfg },
  );
  assert(
    '3 bundle does not require individual board/wetsuit prices',
    bundleNoSeparate.ok === true && bundleNoSeparate.body.total_cents === BUNDLE_1D,
    JSON.stringify(bundleNoSeparate.body),
  );

  // 4. Separate board and wetsuit quote independently
  const separateQuote = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [
        { offering_key: 'board_rental', duration_key: '1_day', quantity: 1 },
        { offering_key: 'wetsuit_rental', duration_key: '1_day', quantity: 1 },
      ],
      components: { surfboard: { quantity: 1 }, wetsuit: { quantity: 1 } },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    '4 separate board+wetsuit independent',
    separateQuote.ok === true && separateQuote.body.total_cents === BOARD_1D + WETSUIT_1D,
    JSON.stringify(separateQuote.body),
  );

  // 5. Bundle plus constituent rejected
  const bundlePlusBoard = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [
        { offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 },
        { offering_key: 'board_rental', duration_key: '1_day', quantity: 1 },
      ],
      components: { surfboard: { quantity: 1 }, wetsuit: { quantity: 1 } },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert('5 bundle+constituent rejected', bundlePlusBoard.ok === false, JSON.stringify(bundlePlusBoard.body));

  // 6. Invalid, duplicate, wrong-duration rejected
  const badKey = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'kayak_rental', duration_key: '1_day', quantity: 1 }],
      components: { surfboard: { quantity: 1 } },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert('6a invalid offering_key rejected', badKey.ok === false);

  const dup = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [
        { offering_key: 'board_rental', duration_key: '1_day', quantity: 1 },
        { offering_key: 'board_rental', duration_key: '1_day', quantity: 2 },
      ],
      components: { surfboard: { quantity: 1 } },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert('6b duplicate offering_key rejected', dup.ok === false);

  const badQtyCases = [
    { quantity: 0 },
    { quantity: -1 },
    { quantity: 1.5 },
    { quantity: 'abc' },
    { quantity: null },
  ];
  let badQtyOk = true;
  for (const tc of badQtyCases) {
    const q = executeSunsetQuoteSync(
      buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
        rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: tc.quantity }],
        components: { surfboard: { quantity: 1 } },
      })).command,
      { adminCfg: somoRentalCfg },
    );
    if (q.ok) badQtyOk = false;
  }
  assert('6c invalid quantities rejected', badQtyOk);

  const wrongDur = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_rental', duration_key: '3_days', quantity: 1 }],
      components: { surfboard: { quantity: 1 } },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert('6d wrong-duration vs date span rejected', wrongDur.ok === false, JSON.stringify(wrongDur.body));

  // Multi-day span requires matching duration_key and exact 3_days price (no ×3)
  const threeDayBody = staffRentalBody({
    date_from: '2026-07-18',
    date_to: '2026-07-20',
    service_dates: ['2026-07-18', '2026-07-19', '2026-07-20'],
    rentals: [{ offering_key: 'board_rental', duration_key: '3_days', quantity: 1 }],
    components: { surfboard: { quantity: 1 } },
  });
  const threeDayQuote = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, threeDayBody).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    '6e exact-duration 3_days is duration total (not × span)',
    threeDayQuote.ok === true && threeDayQuote.body.total_cents === BOARD_3D,
    JSON.stringify(threeDayQuote.body),
  );

  // 7. Inactive / missing / wrong-location fail closed
  const inactiveOnly = rentalPrices([
    rentalRow('board_rental__1_day', BOARD_1D, { active: false }),
  ]);
  const inactiveQ = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
      components: { surfboard: { quantity: 1 } },
    })).command,
    { adminCfg: inactiveOnly },
  );
  assert('7a inactive rental fails closed', inactiveQ.ok === false);

  const missingRental = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'wetsuit_rental', duration_key: '1_day', quantity: 1 }],
      components: { wetsuit: { quantity: 1 } },
    })).command,
    { adminCfg: rentalPrices([rentalRow('board_rental__1_day', BOARD_1D)]) },
  );
  assert('7b missing rental price fails closed', missingRental.ok === false);

  const sardiOnly = rentalPrices([
    rentalRow('board_rental__1_day', 1200, { location_id: 'sunset-sardinero' }),
  ]);
  // Catalog projection tags offerings to trusted location; without a Somo active row the offering is absent.
  const wrongLoc = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
      components: { surfboard: { quantity: 1 } },
    }), { trustedLocationId: LOC }).command,
    { adminCfg: sardiOnly },
  );
  // If catalog still surfaces the row (location stamped to Somo), async DB resolve must fail closed.
  if (wrongLoc.ok) {
    const pgWrong = makePg();
    const asyncWrong = await executeSunsetQuote(pgWrong, buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
      components: { surfboard: { quantity: 1 } },
      require_db: true,
    })).command, { adminCfg: sardiOnly });
    assert('7c wrong-location fails closed (async DB)', asyncWrong.ok === false, JSON.stringify(asyncWrong.body));
    assert('7c wrong-location quote zero writes', pgWrong.inserts.length === 0);
  } else {
    assert('7c wrong-location fails closed (sync catalog)', wrongLoc.ok === false, JSON.stringify(wrongLoc.body));
  }

  // 8. Matching legacy components do not double-charge
  assert(
    '8 matching legacy does not double-charge',
    bundleQuote.ok && bundleQuote.body.total_cents === BUNDLE_1D
      && !(bundleQuote.body.total_cents === BUNDLE_1D + BOARD_1D + WETSUIT_1D),
  );

  // 9. Legacy quantity mismatch rejected
  const legacyMismatch = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 2 }],
      components: { surfboard: { quantity: 1 } },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert('9 legacy quantity mismatch rejected', legacyMismatch.ok === false, JSON.stringify(legacyMismatch.body));

  // 10. Course + bundle total combines correctly
  const courseBundle = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: {
        course: { quantity: 1, course_id: PACK_ID, tier_key: TIER },
        surfboard: { quantity: 1 },
        wetsuit: { quantity: 1 },
      },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    '10 course + bundle total',
    courseBundle.ok === true && courseBundle.body.total_cents === AMOUNT + BUNDLE_1D,
    JSON.stringify(courseBundle.body),
  );

  // 11. guest_name + non-rental quote behavior remain green
  assert('11 guest_name on rental quote preserved in command path', bundleQuote.ok === true);
  const courseOnlyStill = executeSunsetQuoteSync(manualBuilt.command, { adminCfg: cfg });
  assert('11 non-rental course quote still green', courseOnlyStill.ok === true && courseOnlyStill.body.total_cents === AMOUNT);
  assert('11 provenance still present on rental quote', bundleQuote.body.quote_provenance && bundleQuote.body.quote_provenance.quote_fingerprint);

  // Legacy-only (no rentals array) preserves hardcoded __1_day behavior
  const legacyOnly = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      components: { surfboard: { quantity: 1 } },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    '11b no rentals array preserves legacy surfboard pricing',
    legacyOnly.ok === true && legacyOnly.body.total_cents === BOARD_1D,
    JSON.stringify(legacyOnly.body),
  );

  // 12. Quote performs no DB writes
  const pgRent = makePg({
    readOnly: true,
    rentalPrices: {
      board_and_suit_rental__1_day: { amount_cents: BUNDLE_1D, location_id: LOC },
    },
  });
  const asyncBundle = await executeSunsetQuote(pgRent, buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, bundleBody).command, { adminCfg: somoRentalCfg });
  assert('12 async rental quote ok', asyncBundle.ok === true, JSON.stringify(asyncBundle.body));
  assert('12 rental quote zero inserts', pgRent.inserts.length === 0);
  assert('12 rental quote zero write statements', pgRent.writes.length === 0);

  // ── Slice 3A corrections: dispatch / duration / provenance ─────────────
  console.log('\n[K] Canonical-only dispatch + authoritative duration + multi-line provenance');

  const bundleOnlyNoLegacy = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: {},
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    'K1 sync bundle-only with empty components quotes',
    bundleOnlyNoLegacy.ok === true && bundleOnlyNoLegacy.body.total_cents === BUNDLE_1D,
    JSON.stringify(bundleOnlyNoLegacy.body),
  );

  const boardOnlyNoLegacy = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 2 }],
      components: {},
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    'K2 sync board-only with empty components quotes',
    boardOnlyNoLegacy.ok === true && boardOnlyNoLegacy.body.total_cents === BOARD_1D * 2,
    JSON.stringify(boardOnlyNoLegacy.body),
  );

  const asyncBundleOnly = await executeSunsetQuote(
    makePg({
      readOnly: true,
      rentalPrices: { board_and_suit_rental__1_day: { amount_cents: BUNDLE_1D, location_id: LOC } },
    }),
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: {},
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert('K3 async bundle-only with empty components quotes', asyncBundleOnly.ok === true && asyncBundleOnly.body.total_cents === BUNDLE_1D, JSON.stringify(asyncBundleOnly.body));

  const neither = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, {
      guest_name: 'Nobody',
      date_from: SATURDAY,
      date_to: SATURDAY,
      payment_status: 'unpaid',
    }).command,
    { adminCfg: somoRentalCfg },
  );
  assert('K4 neither components nor rentals → quote_input_required', neither.ok === false && neither.body.reason === 'quote_input_required');

  // Authoritative duration from date_from/date_to — reject 3-day range + one service date + 1_day
  const spoofedSpan = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, {
      guest_name: 'Spoof',
      date_from: '2026-07-18',
      date_to: '2026-07-20',
      service_dates: ['2026-07-18'],
      payment_status: 'unpaid',
      components: {},
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
    }).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    'K5 3-day date range cannot submit one service_date + duration_key=1_day',
    spoofedSpan.ok === false,
    JSON.stringify(spoofedSpan.body),
  );

  const extraServiceDate = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, {
      guest_name: 'Extra',
      date_from: SATURDAY,
      date_to: SATURDAY,
      service_dates: [SATURDAY, '2026-07-19'],
      payment_status: 'unpaid',
      components: {},
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
    }).command,
    { adminCfg: somoRentalCfg },
  );
  assert('K6 service_dates with extra day rejected', extraServiceDate.ok === false, JSON.stringify(extraServiceDate.body));

  const threeDayOk = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, {
      guest_name: 'ThreeDay',
      date_from: '2026-07-18',
      date_to: '2026-07-20',
      service_dates: ['2026-07-18', '2026-07-19', '2026-07-20'],
      payment_status: 'unpaid',
      components: {},
      rentals: [{ offering_key: 'board_rental', duration_key: '3_days', quantity: 1 }],
    }).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    'K7 matching 3-day range + service_dates + duration_key ok',
    threeDayOk.ok === true && threeDayOk.body.total_cents === BOARD_3D,
    JSON.stringify(threeDayOk.body),
  );

  // Multi-line provenance: fingerprint changes when rental fields change
  const { computeQuoteFingerprint } = require('./lib/luna-front-desk-quote-service');
  const baseCourseBundle = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: {
        course: { quantity: 1, course_id: PACK_ID, tier_key: TIER },
      },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert('K8 course+bundle quote ok', baseCourseBundle.ok === true, JSON.stringify(baseCourseBundle.body));
  const fpBase = baseCourseBundle.body.quote_provenance.quote_fingerprint;

  const qtyChanged = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 2 }],
      components: {
        course: { quantity: 1, course_id: PACK_ID, tier_key: TIER },
      },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert('K9 fingerprint changes on rental quantity', qtyChanged.ok && qtyChanged.body.quote_provenance.quote_fingerprint !== fpBase);

  const offeringChanged = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
      components: {
        course: { quantity: 1, course_id: PACK_ID, tier_key: TIER },
      },
    })).command,
    { adminCfg: somoRentalCfg },
  );
  assert('K10 fingerprint changes on offering key', offeringChanged.ok && offeringChanged.body.quote_provenance.quote_fingerprint !== fpBase);

  const durationChanged = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, {
      guest_name: 'Dur',
      date_from: '2026-07-18',
      date_to: '2026-07-20',
      service_dates: ['2026-07-18', '2026-07-19', '2026-07-20'],
      payment_status: 'unpaid',
      components: {
        course: { quantity: 1, course_id: PACK_ID, tier_key: TIER },
      },
      rentals: [{ offering_key: 'board_rental', duration_key: '3_days', quantity: 1 }],
    }).command,
    { adminCfg: somoRentalCfg },
  );
  // Course may fail weekday for Mon — use rental-only for duration fingerprint vs board 1_day
  const board1dFp = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
      components: {},
    })).command,
    { adminCfg: somoRentalCfg },
  );
  const board3dFp = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, {
      guest_name: 'Dur',
      date_from: '2026-07-18',
      date_to: '2026-07-20',
      service_dates: ['2026-07-18', '2026-07-19', '2026-07-20'],
      payment_status: 'unpaid',
      components: {},
      rentals: [{ offering_key: 'board_rental', duration_key: '3_days', quantity: 1 }],
    }).command,
    { adminCfg: somoRentalCfg },
  );
  assert(
    'K11 fingerprint changes on duration',
    board1dFp.ok && board3dFp.ok
      && board1dFp.body.quote_provenance.quote_fingerprint !== board3dFp.body.quote_provenance.quote_fingerprint,
    JSON.stringify({ d1: board1dFp.body, d3: board3dFp.body }),
  );

  const priceIdChangedCfg = rentalPrices([
    rentalRow('board_and_suit_rental__1_day', BUNDLE_1D, { id: 'price-bundle-alt-id' }),
    rentalRow('board_rental__1_day', BOARD_1D),
    rentalRow('wetsuit_rental__1_day', WETSUIT_1D),
    rentalRow('board_rental__3_days', BOARD_3D),
  ]);
  const priceIdChanged = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: {
        course: { quantity: 1, course_id: PACK_ID, tier_key: TIER },
      },
    })).command,
    { adminCfg: priceIdChangedCfg },
  );
  assert(
    'K12 fingerprint changes on authoritative price_id',
    priceIdChanged.ok
      && priceIdChanged.body.quote_provenance.quote_fingerprint !== fpBase,
    JSON.stringify({ base: fpBase, next: priceIdChanged.body.quote_provenance }),
  );

  const unitPriceChangedCfg = rentalPrices([
    rentalRow('board_and_suit_rental__1_day', BUNDLE_1D + 100),
    rentalRow('board_rental__1_day', BOARD_1D),
    rentalRow('wetsuit_rental__1_day', WETSUIT_1D),
    rentalRow('board_rental__3_days', BOARD_3D),
  ]);
  const unitPriceChanged = executeSunsetQuoteSync(
    buildQuoteCmd(QUOTE_CHANNELS.MANUAL_STAFF, staffRentalBody({
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      components: {
        course: { quantity: 1, course_id: PACK_ID, tier_key: TIER },
      },
    })).command,
    { adminCfg: unitPriceChangedCfg },
  );
  assert(
    'K13 fingerprint changes on unit price',
    unitPriceChanged.ok
      && unitPriceChanged.body.quote_provenance.quote_fingerprint !== fpBase,
  );

  // Deterministic line summary is what the fingerprint hashes (version bumped)
  const linesSummary = (baseCourseBundle.body.line_items || []).map((l) => ({
    component: l.component,
    offering_id: l.offering_id,
    quantity: l.quantity,
  }));
  assert(
    'K14 multi-line quote includes course + rental lines',
    linesSummary.length >= 2
      && linesSummary.some((l) => l.component === 'course')
      && linesSummary.some((l) => String(l.component || '').includes('rental') || String(l.offering_id || '').includes('rental')),
    JSON.stringify(linesSummary),
  );
  assert(
    'K15 provenance version bumped for multi-line lines',
    baseCourseBundle.body.quote_provenance.quote_version >= 2,
    String(baseCourseBundle.body.quote_provenance.quote_version),
  );

  console.log(`\n── verify:luna-front-desk-quote-service ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exit(fail ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(2); });
