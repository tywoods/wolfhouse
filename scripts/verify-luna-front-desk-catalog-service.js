'use strict';

/**
 * verify:luna-front-desk-catalog-service
 *
 * RED → GREEN gate for the shared Sunset catalog application service.
 */

const {
  CATALOG_CHANNELS,
  CATALOG_EXCLUSION_REASONS,
  buildSunsetCatalogCommand,
  executeSunsetCatalog,
  executeSunsetCatalogSync,
} = require('./lib/luna-front-desk-catalog-service');
const {
  QUOTE_CHANNELS,
  buildSunsetQuoteCommand,
  executeSunsetQuoteSync,
} = require('./lib/luna-front-desk-quote-service');
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
  return {
    inserts,
    query: async (sql, params) => {
      const s = String(sql);
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
        if (String(itemCode || '').startsWith('surf_pack_') && unit === 'day') {
          return { rows: [{ id: 'price-1', amount_cents: priceAmount, currency: 'EUR', item_type: 'package', item_code: itemCode, unit: 'day', location_id: params[4] || LOC }] };
        }
        if (opts.rentalItem && itemCode === opts.rentalItem) {
          return { rows: [{ id: 'rent-1', amount_cents: 1500, currency: 'EUR', item_type: 'rental', item_code: itemCode, unit: 'day', location_id: LOC }] };
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

function buildCatalogCmd(channel, body, extra = {}) {
  return buildSunsetCatalogCommand({
    channel,
    transportBody: body,
    trustedLocationId: extra.trustedLocationId || LOC,
    now: FIXED_NOW,
  });
}

async function run() {
  console.log('\nverify:luna-front-desk-catalog-service\n');
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

  console.log('[A] Schedule and Luna share canonical offering IDs');
  const cfg = adminCfg();
  const transport = { service_dates: [SATURDAY], require_db: true };
  const schedBuilt = buildCatalogCmd(CATALOG_CHANNELS.SCHEDULE, transport);
  const lunaBuilt = buildCatalogCmd(CATALOG_CHANNELS.LUNA_WHATSAPP, {
    ...transport,
    client_slug: 'wolfhouse',
    location_id: 'sunset-sardinero',
  });
  assert('schedule command ok', schedBuilt.ok === true);
  assert('luna command ok', lunaBuilt.ok === true);
  assert('trusted location wins', lunaBuilt.command.locationId === LOC);
  const schedCat = executeSunsetCatalogSync(schedBuilt.command, { adminCfg: cfg });
  const lunaCat = executeSunsetCatalogSync(lunaBuilt.command, { adminCfg: cfg });
  assert('schedule catalog ok', schedCat.ok === true, JSON.stringify(schedCat.body));
  assert('luna catalog ok', lunaCat.ok === true);
  const schedOff = (schedCat.body.offerings || []).find((o) => o.offering_id === ITEM);
  const lunaOff = (lunaCat.body.offerings || []).find((o) => o.offering_id === ITEM);
  assert('same offering_id', schedOff && lunaOff && schedOff.offering_id === lunaOff.offering_id);
  assert('same unit_amount_cents', schedOff.unit_amount_cents === lunaOff.unit_amount_cents);
  assert('same billing_unit', schedOff.billing_unit === lunaOff.billing_unit);
  assert('schedule menu tier offering_id', (schedCat.body.courses || []).some((c) => (
    c.course_id === PACK_ID && (c.price_tiers || []).some((t) => t.offering_id === ITEM)
  )));

  console.log('\n[B] Weekend-only behavior with and without requested dates');
  const noDates = executeSunsetCatalogSync(buildCatalogCmd(CATALOG_CHANNELS.LUNA_WHATSAPP, { require_db: true }).command, { adminCfg: cfg });
  const friCat = executeSunsetCatalogSync(buildCatalogCmd(CATALOG_CHANNELS.LUNA_WHATSAPP, { service_dates: [FRIDAY], require_db: true }).command, { adminCfg: cfg });
  const satCat = executeSunsetCatalogSync(buildCatalogCmd(CATALOG_CHANNELS.LUNA_WHATSAPP, { service_dates: [SATURDAY], require_db: true }).command, { adminCfg: cfg });
  const noDatesOff = (noDates.body.offerings || []).find((o) => o.offering_id === ITEM);
  const friOff = (friCat.body.offerings || []).find((o) => o.offering_id === ITEM);
  const satOff = (satCat.body.offerings || []).find((o) => o.offering_id === ITEM);
  assert('no dates keeps schedule summary', noDatesOff && noDatesOff.schedule && noDatesOff.schedule.summary);
  assert('Friday ineligible', friOff && friOff.eligible_on_requested_dates === false);
  assert('Saturday eligible', satOff && satOff.eligible_on_requested_dates !== false);
  assert('weekday schedule rejection present', friOff && friOff.schedule_rejection);

  console.log('\n[C] Unpriced config tier excluded when require_db (no config-json fallback)');
  const cfgUnpriced = adminCfg([]);
  const unpriced = executeSunsetCatalogSync(
    buildCatalogCmd(CATALOG_CHANNELS.SCHEDULE, { require_db: true }).command,
    { adminCfg: cfgUnpriced },
  );
  assert('unpriced catalog ok shell', unpriced.ok === true);
  assert('unpriced offering absent', !(unpriced.body.offerings || []).some((o) => o.offering_id === ITEM));
  assert('schedule course has no bookable tiers', !(unpriced.body.courses || []).some((c) => (
    c.course_id === PACK_ID && (c.price_tiers || []).some((t) => t.bookable === true)
  )));

  console.log('\n[D] Inactive pack excluded');
  const cfgInactive = adminCfg();
  cfgInactive.surf_packs[0].active = false;
  const inactive = executeSunsetCatalogSync(
    buildCatalogCmd(CATALOG_CHANNELS.LUNA_WHATSAPP, { require_db: true }).command,
    { adminCfg: cfgInactive },
  );
  assert('inactive pack absent from offerings', !(inactive.body.offerings || []).some((o) => o.course_id === PACK_ID));

  console.log('\n[E] Private lesson projects through catalog');
  const cfgPl = adminCfg(undefined, {
    private_lesson: {
      enabled: true,
      label: 'Private lesson',
      amount_cents: 8000,
      currency: 'EUR',
      rule_id: 'pl-1',
    },
  });
  const plCat = executeSunsetCatalogSync(
    buildCatalogCmd(CATALOG_CHANNELS.LUNA_WHATSAPP, { require_db: true }).command,
    { adminCfg: cfgPl },
  );
  assert('private lesson in catalog', (plCat.body.offerings || []).some((o) => o.offering_type === 'private_lesson'));

  console.log('\n[F] Generic rental offering without catalog branch');
  const rentalKey = 'board_rental__1_day';
  const cfgRental = adminCfg([{
    id: 'rent-1',
    category: 'rental',
    offering_key: rentalKey,
    item_code: rentalKey,
    amount_cents: 1500,
    unit: 'day',
    active: true,
    currency: 'EUR',
    label: 'Board rental 1 day',
  }]);
  cfgRental.surf_packs = [];
  const rentalCat = executeSunsetCatalogSync(
    buildCatalogCmd(CATALOG_CHANNELS.LUNA_WHATSAPP, { require_db: true }).command,
    { adminCfg: cfgRental },
  );
  assert('rental offering present', (rentalCat.body.offerings || []).some((o) => o.offering_type === 'rental'));

  console.log('\n[G] Catalog reads create zero writes');
  const pg = makePg();
  const asyncCat = await executeSunsetCatalog(pg, schedBuilt.command, { adminCfg: cfg });
  assert('async catalog ok', asyncCat.ok === true);
  assert('zero inserts', pg.inserts.length === 0);

  console.log('\n[H] Quote accepts every bookable catalog result');
  for (const off of (satCat.body.offerings || []).filter((o) => o.bookable === true)) {
    const quoteBuilt = buildSunsetQuoteCommand({
      channel: QUOTE_CHANNELS.LUNA_WHATSAPP,
      trustedLocationId: LOC,
      transportBody: {
        offering_id: off.offering_id,
        course_id: off.course_id,
        tier_key: off.tier_key,
        service_dates: [SATURDAY],
        quantity: 1,
        require_db: true,
      },
    });
    const quote = executeSunsetQuoteSync(quoteBuilt.command, { adminCfg: cfg });
    assert(`quote ok for ${off.offering_id}`, quote.ok === true, JSON.stringify(quote.body));
  }

  console.log('\n[I] Excluded catalog results cannot be quoted');
  const badQuote = executeSunsetQuoteSync(buildSunsetQuoteCommand({
    channel: QUOTE_CHANNELS.MANUAL_STAFF,
    trustedLocationId: LOC,
    transportBody: {
      offering_id: ITEM,
      course_id: PACK_ID,
      tier_key: TIER,
      service_dates: [FRIDAY],
      quantity: 1,
      require_db: true,
    },
  }).command, { adminCfg: cfg });
  assert('weekday quote fails', badQuote.ok === false);

  console.log('\n[J] Trusted tenant/location cannot be overridden');
  const wolfBuilt = buildCatalogCmd(CATALOG_CHANNELS.LUNA_WHATSAPP, {
    client_slug: 'wolfhouse',
    location_id: 'wolfhouse-somo',
    require_db: true,
  });
  assert('command still sunset tenant', wolfBuilt.command.clientSlug === 'sunset');
  assert('wrong location rejected', buildSunsetCatalogCommand({
    channel: CATALOG_CHANNELS.SCHEDULE,
    trustedLocationId: 'not-a-location',
    transportBody: {},
  }).ok === false);

  console.log('\n[K] Joinable courses use canonical schedule rules');
  const pgJoin = makePg();
  const joinBuilt = buildCatalogCmd(CATALOG_CHANNELS.LUNA_WHATSAPP, {
    date: FRIDAY,
    include_capacity: true,
    joinable: true,
    courses_only: true,
    require_db: true,
  });
  const friJoin = await executeSunsetCatalog(pgJoin, joinBuilt.command, { adminCfg: cfg });
  const satJoinBuilt = buildCatalogCmd(CATALOG_CHANNELS.LUNA_WHATSAPP, {
    date: SATURDAY,
    include_capacity: true,
    joinable: true,
    courses_only: true,
    require_db: true,
  });
  const satJoin = await executeSunsetCatalog(pgJoin, satJoinBuilt.command, { adminCfg: cfg });
  const friCourse = (friJoin.body.courses || []).find((c) => c.course_id === PACK_ID);
  const satCourse = (satJoin.body.courses || []).find((c) => c.course_id === PACK_ID);
  assert('Friday joinable false or absent', !friCourse || friCourse.joinable === false);
  assert('Saturday joinable true', satCourse && satCourse.joinable === true);

  console.log('\n[L] Operator mode can include excluded offerings');
  const opBuilt = buildSunsetCatalogCommand({
    channel: CATALOG_CHANNELS.ADMIN_CONSUMER,
    trustedLocationId: LOC,
    transportBody: { require_db: true, include_excluded: true },
  });
  const opCat = executeSunsetCatalogSync(opBuilt.command, { adminCfg: cfgUnpriced });
  assert('operator excluded list populated', (opCat.body.excluded_offerings || []).length > 0);
  assert('exclusion reason typed', (opCat.body.excluded_offerings || []).every((o) => !!o.exclusion_reason));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
