'use strict';

/**
 * SAME-DESK-001 — Luna guest offer/quote consumes the live tenant-scoped
 * Admin catalog (Staff API canonical owners).
 *
 * Hostile checks:
 *  - disabled rental never offered or quoted
 *  - disabled course never offered or quoted
 *  - tenant mismatch / isolation
 *  - guest-visible name + price come from Admin catalog, not a hardcoded
 *    public-site bundle
 */

const {
  CATALOG_CHANNELS,
  buildSunsetCatalogCommand,
  executeSunsetCatalog,
  executeSunsetCatalogSync,
} = require('./lib/luna-front-desk-catalog-service');
const {
  QUOTE_CHANNELS,
  buildSunsetQuoteCommand,
  executeSunsetQuote,
  executeSunsetQuoteSync,
} = require('./lib/luna-front-desk-quote-service');
const {
  listConfiguredRentalOfferings,
} = require('./lib/sunset-rental-price-lookup');
const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');
const { activeRentalOfferingKeySet } = require('./lib/rental-offering-label');

let pass = 0;
let fail = 0;
function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

const LOC = 'sunset-somo';
const SARDI = 'sunset-sardinero';
const SATURDAY = '2026-07-18';
const FIXED_NOW = new Date('2026-07-14T12:00:00Z');

const LIVE_COURSE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEAD_COURSE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LIVE_COURSE_ITEM = packPriceItemCode(LIVE_COURSE_ID, '1_week');
const DEAD_COURSE_ITEM = packPriceItemCode(DEAD_COURSE_ID, '1_week');
const LIVE_COURSE_CENTS = 19900;
const DEAD_COURSE_CENTS = 13000;

const LIVE_RENTAL_KEY = 'kayak_rental';
const LIVE_RENTAL_ITEM = `${LIVE_RENTAL_KEY}__1_day`;
const LIVE_RENTAL_LABEL = 'Kayak Pro';
const LIVE_RENTAL_CENTS = 4500;

const DISABLED_RENTAL_KEY = 'board_rental';
const DISABLED_RENTAL_ITEM = `${DISABLED_RENTAL_KEY}__1_day`;
const DISABLED_RENTAL_CENTS = 1500;

// Public-site seed (docs/sunset/LUNA-SUNSET-OVERVIEW.md: Board + Suit half day = €10).
const PUBLIC_BUNDLE_KEY = 'board_and_suit_rental';
const PUBLIC_BUNDLE_ITEM = `${PUBLIC_BUNDLE_KEY}__half_day`;
const PUBLIC_BUNDLE_CENTS = 1000;
const PUBLIC_BUNDLE_LABEL = 'Board + Suit';

const FOREIGN_RENTAL_KEY = 'wolfhouse_secret_rental';
const FOREIGN_RENTAL_ITEM = `${FOREIGN_RENTAL_KEY}__1_day`;
const FOREIGN_RENTAL_CENTS = 9999;

function adminCatalogCfg() {
  return {
    ok: true,
    source: 'db',
    currency: 'EUR',
    surf_packs: [
      {
        pack_id: LIVE_COURSE_ID,
        label: 'Weekend Intensive',
        active: true,
        age_band: '12_and_up',
        group_size: 8,
        beaches: ['somo'],
        weekly: 'sat_sun',
        schedules: ['0930_1130'],
        price_tiers: [{ key: '1_week', label: '1 week', hours: 10, amount_cents: LIVE_COURSE_CENTS }],
      },
      {
        pack_id: DEAD_COURSE_ID,
        label: 'Old Kids Camp',
        active: false,
        age_band: '6_to_11',
        group_size: 6,
        beaches: ['somo'],
        weekly: 'sat_sun',
        schedules: ['0930_1130'],
        price_tiers: [{ key: '1_week', label: '1 week', hours: 8, amount_cents: DEAD_COURSE_CENTS }],
      },
    ],
    rental_offerings: [
      {
        offering_key: LIVE_RENTAL_KEY,
        label: LIVE_RENTAL_LABEL,
        active: true,
        client_slug: 'sunset',
        location_id: LOC,
      },
      {
        offering_key: DISABLED_RENTAL_KEY,
        label: 'Old Board',
        active: false,
        client_slug: 'sunset',
        location_id: LOC,
      },
      {
        offering_key: FOREIGN_RENTAL_KEY,
        label: 'Wolfhouse Secret Board',
        active: true,
        client_slug: 'wolfhouse',
        location_id: 'wolfhouse-somo',
      },
    ],
    prices: [
      {
        id: 'price-live-course',
        category: 'package',
        offering_key: LIVE_COURSE_ITEM,
        item_code: LIVE_COURSE_ITEM,
        amount_cents: LIVE_COURSE_CENTS,
        unit: 'day',
        active: true,
        currency: 'EUR',
      },
      {
        id: 'price-dead-course',
        category: 'package',
        offering_key: DEAD_COURSE_ITEM,
        item_code: DEAD_COURSE_ITEM,
        amount_cents: DEAD_COURSE_CENTS,
        unit: 'day',
        active: true,
        currency: 'EUR',
      },
      {
        id: 'price-kayak',
        category: 'rental',
        offering_key: LIVE_RENTAL_ITEM,
        item_code: LIVE_RENTAL_ITEM,
        amount_cents: LIVE_RENTAL_CENTS,
        unit: 'day',
        active: true,
        currency: 'EUR',
        label: LIVE_RENTAL_LABEL,
        location_id: LOC,
      },
      {
        id: 'price-disabled-board',
        category: 'rental',
        offering_key: DISABLED_RENTAL_ITEM,
        item_code: DISABLED_RENTAL_ITEM,
        amount_cents: DISABLED_RENTAL_CENTS,
        unit: 'day',
        active: true,
        currency: 'EUR',
        label: 'Old Board',
        location_id: LOC,
      },
      {
        id: 'price-public-bundle',
        category: 'rental',
        offering_key: PUBLIC_BUNDLE_ITEM,
        item_code: PUBLIC_BUNDLE_ITEM,
        amount_cents: PUBLIC_BUNDLE_CENTS,
        unit: 'half_day',
        active: true,
        currency: 'EUR',
        label: PUBLIC_BUNDLE_LABEL,
        seed_source: 'public_site',
        pricing_status: 'unverified_seed',
        location_id: LOC,
      },
      {
        id: 'price-foreign',
        category: 'rental',
        offering_key: FOREIGN_RENTAL_ITEM,
        item_code: FOREIGN_RENTAL_ITEM,
        amount_cents: FOREIGN_RENTAL_CENTS,
        unit: 'day',
        active: true,
        currency: 'EUR',
        label: 'Wolfhouse Secret Board',
        location_id: LOC,
      },
    ],
  };
}

function catalogCmd(body, extra = {}) {
  return buildSunsetCatalogCommand({
    channel: CATALOG_CHANNELS.LUNA_WHATSAPP,
    trustedLocationId: extra.trustedLocationId || LOC,
    transportBody: { require_db: true, ...body },
    now: FIXED_NOW,
  });
}

function quoteCmd(body, extra = {}) {
  return buildSunsetQuoteCommand({
    channel: QUOTE_CHANNELS.LUNA_WHATSAPP,
    trustedLocationId: extra.trustedLocationId || LOC,
    transportBody: { require_db: true, service_dates: [SATURDAY], quantity: 1, ...body },
    now: FIXED_NOW,
  });
}

function offeringsOf(cat, type) {
  return (cat.body && cat.body.offerings || []).filter((o) => (
    !type || o.offering_type === type
  ));
}

function hasOffering(cat, pred) {
  return (cat.body && cat.body.offerings || []).some(pred);
}

function hasRentalIdentity(cat, key, item) {
  return hasOffering(cat, (o) => (
    o.offering_id === item
    || o.offering_key === key
    || String(o.item_code || '') === item
    || String(o.item_code || '').startsWith(`${key}__`)
    || String(o.offering_item_code || '') === item
  ));
}

function publicSitePrices() {
  return [
    {
      id: 'price-kayak',
      category: 'rental',
      offering_key: LIVE_RENTAL_ITEM,
      item_code: LIVE_RENTAL_ITEM,
      amount_cents: LIVE_RENTAL_CENTS,
      unit: 'day',
      active: true,
      currency: 'EUR',
      label: LIVE_RENTAL_LABEL,
      location_id: LOC,
    },
    {
      id: 'price-disabled-board',
      category: 'rental',
      offering_key: DISABLED_RENTAL_ITEM,
      item_code: DISABLED_RENTAL_ITEM,
      amount_cents: DISABLED_RENTAL_CENTS,
      unit: 'day',
      active: true,
      currency: 'EUR',
      label: 'Old Board',
      location_id: LOC,
    },
    {
      id: 'price-public-bundle',
      category: 'rental',
      offering_key: PUBLIC_BUNDLE_ITEM,
      item_code: PUBLIC_BUNDLE_ITEM,
      amount_cents: PUBLIC_BUNDLE_CENTS,
      unit: 'half_day',
      active: true,
      currency: 'EUR',
      label: PUBLIC_BUNDLE_LABEL,
      seed_source: 'public_site',
      pricing_status: 'unverified_seed',
      location_id: LOC,
    },
  ];
}

function cfgWithOfferingsAndPrices(rentalOfferings, prices) {
  const cfg = adminCatalogCfg();
  if (rentalOfferings === undefined) {
    delete cfg.rental_offerings;
  } else {
    cfg.rental_offerings = rentalOfferings;
  }
  cfg.prices = prices || publicSitePrices();
  cfg.surf_packs = [];
  return cfg;
}

function makeRentalCatalogPg(opts = {}) {
  return {
    query: async (sql) => {
      const s = String(sql);
      if (/tenant_rental_offerings/i.test(s) && /SELECT/i.test(s)) {
        if (opts.failRentalQuery) {
          throw new Error('rental catalog query failed');
        }
        return { rows: Array.isArray(opts.rentalRows) ? opts.rentalRows : [] };
      }
      if (/^BEGIN/i.test(s) || /^COMMIT/i.test(s) || /^ROLLBACK/i.test(s)) return { rows: [] };
      if (/CREATE TABLE/i.test(s) || /CREATE INDEX/i.test(s)) return { rows: [] };
      if (/information_schema\.(tables|columns)/i.test(s)) return { rows: [{ '?column?': 1 }] };
      if (/to_regclass/i.test(s)) return { rows: [{ reg: 'tenant_rental_offerings' }] };
      if (/SELECT id FROM clients WHERE slug/i.test(s)) return { rows: [{ id: 'client-sunset' }] };
      if (/FROM tenant_surf_pack_rules/i.test(s)) return { rows: [] };
      if (/FROM tenant_private_lesson_rules/i.test(s)) return { rows: [] };
      if (/FROM tenant_price_rules/i.test(s)) return { rows: [] };
      return { rows: [] };
    },
  };
}

function assertZeroGuestRentals(cat, label) {
  const rentals = offeringsOf(cat, 'rental');
  assert(`${label}: catalog ok shell or fail-closed`, cat && (cat.ok === true || cat.ok === false));
  assert(
    `${label}: zero guest rentals`,
    rentals.length === 0,
    JSON.stringify(rentals),
  );
  assert(
    `${label}: public-site bundle absent`,
    !hasRentalIdentity(cat, PUBLIC_BUNDLE_KEY, PUBLIC_BUNDLE_ITEM)
      && !hasOffering(cat, (o) => /board\s*\+\s*suit/i.test(String(o.label || ''))),
    JSON.stringify(rentals),
  );
  assert(
    `${label}: stale kayak/board price rows absent`,
    !hasRentalIdentity(cat, LIVE_RENTAL_KEY, LIVE_RENTAL_ITEM)
      && !hasRentalIdentity(cat, DISABLED_RENTAL_KEY, DISABLED_RENTAL_ITEM),
    JSON.stringify(rentals),
  );
}

function assertQuoteRefused(quote, label) {
  assert(
    `${label}: quote fails closed`,
    quote && quote.ok === false,
    JSON.stringify(quote && quote.body),
  );
}

async function run() {
  console.log('\nverify:luna-same-desk-admin-catalog\n');
  const cfg = adminCatalogCfg();
  const cat = executeSunsetCatalogSync(catalogCmd({}).command, { adminCfg: cfg });
  assert('catalog ok', cat.ok === true, JSON.stringify(cat.body));

  console.log('\n[A] Live Admin rental: same name and price staff see');
  const kayak = offeringsOf(cat, 'rental').find((o) => (
    o.offering_id === LIVE_RENTAL_ITEM || o.offering_key === LIVE_RENTAL_KEY
    || String(o.item_code || '') === LIVE_RENTAL_ITEM
  ));
  assert('live kayak offered', !!kayak, JSON.stringify(offeringsOf(cat, 'rental')));
  assert(
    'guest-visible name is Admin catalog label, not public-site bundle',
    !!(kayak && kayak.label === LIVE_RENTAL_LABEL),
    kayak && JSON.stringify({ label: kayak.label, guest: kayak.guest_description }),
  );
  assert(
    'authoritative price is Admin catalog cents, not public-site €10',
    !!(kayak && Number(kayak.unit_amount_cents || (kayak.price && kayak.price.amount_cents)) === LIVE_RENTAL_CENTS),
    kayak && JSON.stringify({
      unit_amount_cents: kayak.unit_amount_cents,
      price: kayak.price,
    }),
  );
  assert(
    'price_source is admin, not public_site seed',
    !!(kayak && (kayak.price_source === 'admin_db' || (kayak.price && kayak.price.price_id === 'price-kayak'))),
    kayak && JSON.stringify({ price_source: kayak.price_source, price: kayak.price }),
  );

  const kayakQuote = executeSunsetQuoteSync(
    quoteCmd({ offering_id: LIVE_RENTAL_ITEM }).command,
    { adminCfg: cfg },
  );
  assert('live kayak quote ok', kayakQuote.ok === true, JSON.stringify(kayakQuote.body));
  const quotedCents = kayakQuote.body && (
    kayakQuote.body.total_cents != null
      ? kayakQuote.body.total_cents
      : kayakQuote.body.unit_amount_cents
  );
  assert(
    'quoted cents match Admin catalog, not public-site 1000',
    quotedCents === LIVE_RENTAL_CENTS,
    JSON.stringify({ quotedCents, body: kayakQuote.body }),
  );
  const quotedLine = kayakQuote.body && Array.isArray(kayakQuote.body.line_items)
    ? kayakQuote.body.line_items[0]
    : null;
  assert(
    'quoted payload uses Admin Kayak Pro label, not Board + Suit',
    !!(kayakQuote.body
      && kayakQuote.body.label === LIVE_RENTAL_LABEL
      && quotedLine
      && quotedLine.label === LIVE_RENTAL_LABEL
      && kayakQuote.body.offering_id === LIVE_RENTAL_ITEM
      && quotedCents === LIVE_RENTAL_CENTS
      && kayakQuote.body.label !== PUBLIC_BUNDLE_LABEL
      && quotedLine.label !== PUBLIC_BUNDLE_LABEL),
    JSON.stringify({
      label: kayakQuote.body && kayakQuote.body.label,
      offering_id: kayakQuote.body && kayakQuote.body.offering_id,
      line: quotedLine && { label: quotedLine.label, offering_id: quotedLine.offering_id },
      quotedCents,
    }),
  );

  console.log('\n[B] Disabled rental never offered or quoted');
  assert(
    'disabled board_rental absent from guest catalog',
    !hasOffering(cat, (o) => (
      o.offering_id === DISABLED_RENTAL_ITEM
      || o.offering_key === DISABLED_RENTAL_KEY
      || String(o.item_code || '').startsWith(`${DISABLED_RENTAL_KEY}__`)
      || /old board/i.test(String(o.label || ''))
    )),
    JSON.stringify(offeringsOf(cat, 'rental')),
  );
  const deadRentalQuote = executeSunsetQuoteSync(
    quoteCmd({ offering_id: DISABLED_RENTAL_ITEM }).command,
    { adminCfg: cfg },
  );
  assert(
    'disabled rental quote fails closed',
    deadRentalQuote.ok === false,
    JSON.stringify(deadRentalQuote.body),
  );

  console.log('\n[C] Disabled course never offered or quoted');
  assert(
    'disabled Old Kids Camp absent from guest catalog',
    !hasOffering(cat, (o) => (
      o.course_id === DEAD_COURSE_ID
      || o.offering_id === DEAD_COURSE_ITEM
      || /old kids camp/i.test(String(o.label || o.guest_description || ''))
    )),
    JSON.stringify((cat.body && cat.body.offerings) || []),
  );
  assert(
    'disabled course absent from courses menu',
    !((cat.body && cat.body.courses) || []).some((c) => c.course_id === DEAD_COURSE_ID),
    JSON.stringify(cat.body && cat.body.courses),
  );
  const deadCourseQuote = executeSunsetQuoteSync(
    quoteCmd({
      offering_id: DEAD_COURSE_ITEM,
      course_id: DEAD_COURSE_ID,
      tier_key: '1_week',
    }).command,
    { adminCfg: cfg },
  );
  assert(
    'disabled course quote fails closed',
    deadCourseQuote.ok === false,
    JSON.stringify(deadCourseQuote.body),
  );

  const liveCourse = hasOffering(cat, (o) => o.course_id === LIVE_COURSE_ID || o.offering_id === LIVE_COURSE_ITEM);
  assert('enabled Weekend Intensive still offered', liveCourse);

  console.log('\n[D] No hardcoded public-site bundle');
  assert(
    'public-site board+suit bundle absent from guest catalog',
    !hasOffering(cat, (o) => (
      o.offering_id === PUBLIC_BUNDLE_ITEM
      || o.offering_key === PUBLIC_BUNDLE_KEY
      || /board\s*\+\s*suit/i.test(String(o.label || ''))
    )),
    JSON.stringify(offeringsOf(cat, 'rental')),
  );
  const publicQuote = executeSunsetQuoteSync(
    quoteCmd({ offering_id: PUBLIC_BUNDLE_ITEM }).command,
    { adminCfg: cfg },
  );
  assert(
    'public-site bundle cannot be quoted',
    publicQuote.ok === false,
    JSON.stringify(publicQuote.body),
  );
  const listed = listConfiguredRentalOfferings(cfg);
  assert(
    'rental menu helper excludes public-site bundle and disabled board',
    listed.some((o) => o.offering_key === LIVE_RENTAL_KEY && o.label === LIVE_RENTAL_LABEL)
      && !listed.some((o) => o.offering_key === PUBLIC_BUNDLE_KEY)
      && !listed.some((o) => o.offering_key === DISABLED_RENTAL_KEY),
    JSON.stringify(listed),
  );

  console.log('\n[E] Tenant isolation');
  assert(
    'foreign wolfhouse rental absent from Sunset catalog',
    !hasOffering(cat, (o) => (
      o.offering_id === FOREIGN_RENTAL_ITEM
      || o.offering_key === FOREIGN_RENTAL_KEY
      || /wolfhouse secret/i.test(String(o.label || ''))
    )),
    JSON.stringify(offeringsOf(cat, 'rental')),
  );
  const foreignQuote = executeSunsetQuoteSync(
    quoteCmd({ offering_id: FOREIGN_RENTAL_ITEM }).command,
    { adminCfg: cfg },
  );
  assert(
    'foreign tenant rental cannot be quoted on Sunset',
    foreignQuote.ok === false,
    JSON.stringify(foreignQuote.body),
  );

  const hijack = catalogCmd({
    client_slug: 'wolfhouse',
    location_id: 'wolfhouse-somo',
  });
  assert('Luna catalog command stays sunset tenant', hijack.ok && hijack.command.clientSlug === 'sunset');
  assert('trusted Sunset location wins over wolfhouse body', hijack.ok && hijack.command.locationId === LOC);

  const sardiCat = executeSunsetCatalogSync(
    catalogCmd({}, { trustedLocationId: SARDI }).command,
    { adminCfg: cfg },
  );
  assert(
    'Somo-scoped kayak does not leak to El Sardinero',
    !hasOffering(sardiCat, (o) => (
      o.offering_id === LIVE_RENTAL_ITEM || o.offering_key === LIVE_RENTAL_KEY
    )),
    JSON.stringify(sardiCat.body && sardiCat.body.offerings),
  );

  console.log('\n[F] Empty Admin rental_offerings is an allowlist, not price-only bootstrap');
  const emptySet = activeRentalOfferingKeySet([], { clientSlug: 'sunset', locationId: LOC });
  assert(
    'activeRentalOfferingKeySet([]) is empty Set, not null',
    emptySet instanceof Set && emptySet.size === 0,
    JSON.stringify({ emptySet }),
  );
  assert(
    'activeRentalOfferingKeySet(null) stays bootstrap (null)',
    activeRentalOfferingKeySet(null) == null,
  );
  assert(
    'activeRentalOfferingKeySet(undefined) stays bootstrap (null)',
    activeRentalOfferingKeySet(undefined) == null,
  );

  const emptyCfg = cfgWithOfferingsAndPrices([]);
  const emptyCat = executeSunsetCatalogSync(catalogCmd({}).command, { adminCfg: emptyCfg });
  assertZeroGuestRentals(emptyCat, 'rental_offerings: []');
  const emptyListed = listConfiguredRentalOfferings(emptyCfg);
  assert(
    'empty identity catalog does not list public-site price-row rentals',
    Array.isArray(emptyListed) && emptyListed.length === 0,
    JSON.stringify(emptyListed),
  );
  assertQuoteRefused(
    executeSunsetQuoteSync(quoteCmd({ offering_id: PUBLIC_BUNDLE_ITEM }).command, { adminCfg: emptyCfg }),
    'empty catalog public-site bundle',
  );
  assertQuoteRefused(
    executeSunsetQuoteSync(quoteCmd({ offering_id: LIVE_RENTAL_ITEM }).command, { adminCfg: emptyCfg }),
    'empty catalog stale kayak',
  );
  assertQuoteRefused(
    executeSunsetQuoteSync(quoteCmd({ offering_id: DISABLED_RENTAL_ITEM }).command, { adminCfg: emptyCfg }),
    'empty catalog stale board',
  );

  console.log('\n[G] All Admin rentals disabled → zero rentals despite stale price rows');
  const allDisabledCfg = cfgWithOfferingsAndPrices([
    {
      offering_key: LIVE_RENTAL_KEY,
      label: LIVE_RENTAL_LABEL,
      active: false,
      client_slug: 'sunset',
      location_id: LOC,
    },
    {
      offering_key: DISABLED_RENTAL_KEY,
      label: 'Old Board',
      active: false,
      client_slug: 'sunset',
      location_id: LOC,
    },
    {
      offering_key: PUBLIC_BUNDLE_KEY,
      label: PUBLIC_BUNDLE_LABEL,
      active: false,
      client_slug: 'sunset',
      location_id: LOC,
    },
  ]);
  const allDisabledCat = executeSunsetCatalogSync(catalogCmd({}).command, { adminCfg: allDisabledCfg });
  assertZeroGuestRentals(allDisabledCat, 'all rentals disabled');
  assertQuoteRefused(
    executeSunsetQuoteSync(quoteCmd({ offering_id: PUBLIC_BUNDLE_ITEM }).command, { adminCfg: allDisabledCfg }),
    'all-disabled public-site bundle',
  );
  assertQuoteRefused(
    executeSunsetQuoteSync(quoteCmd({ offering_id: LIVE_RENTAL_ITEM }).command, { adminCfg: allDisabledCfg }),
    'all-disabled kayak',
  );

  console.log('\n[H] Serialized inactive flags are fail-closed');
  const inactiveValues = [false, 'false', 0, '0'];
  inactiveValues.forEach((raw) => {
    const tagged = `active=${JSON.stringify(raw)}`;
    const set = activeRentalOfferingKeySet([{
      offering_key: LIVE_RENTAL_KEY,
      label: LIVE_RENTAL_LABEL,
      active: raw,
      client_slug: 'sunset',
      location_id: LOC,
    }], { clientSlug: 'sunset', locationId: LOC });
    assert(
      `${tagged} key set is empty`,
      set instanceof Set && set.size === 0 && !set.has(LIVE_RENTAL_KEY),
      JSON.stringify({ size: set && set.size, has: set && set.has(LIVE_RENTAL_KEY) }),
    );
    const cfg = cfgWithOfferingsAndPrices([{
      offering_key: LIVE_RENTAL_KEY,
      label: LIVE_RENTAL_LABEL,
      active: raw,
      client_slug: 'sunset',
      location_id: LOC,
    }]);
    const cat = executeSunsetCatalogSync(catalogCmd({}).command, { adminCfg: cfg });
    assert(
      `${tagged} kayak not offered`,
      !hasRentalIdentity(cat, LIVE_RENTAL_KEY, LIVE_RENTAL_ITEM),
      JSON.stringify(offeringsOf(cat, 'rental')),
    );
    assert(
      `${tagged} public-site bundle not offered`,
      !hasRentalIdentity(cat, PUBLIC_BUNDLE_KEY, PUBLIC_BUNDLE_ITEM),
      JSON.stringify(offeringsOf(cat, 'rental')),
    );
    assertQuoteRefused(
      executeSunsetQuoteSync(quoteCmd({ offering_id: LIVE_RENTAL_ITEM }).command, { adminCfg: cfg }),
      tagged,
    );
    assertQuoteRefused(
      executeSunsetQuoteSync(quoteCmd({ offering_id: PUBLIC_BUNDLE_ITEM }).command, { adminCfg: cfg }),
      `${tagged} public-site`,
    );
  });
  const liveSet = activeRentalOfferingKeySet([{
    offering_key: LIVE_RENTAL_KEY,
    label: LIVE_RENTAL_LABEL,
    active: true,
    client_slug: 'sunset',
    location_id: LOC,
  }], { clientSlug: 'sunset', locationId: LOC });
  assert('boolean true remains active', liveSet instanceof Set && liveSet.has(LIVE_RENTAL_KEY));

  console.log('\n[I] Async Admin query with zero active rows fail-closes over stale prices');
  const asyncEmptyCfg = cfgWithOfferingsAndPrices(undefined);
  const asyncEmptyCat = await executeSunsetCatalog(
    makeRentalCatalogPg({ rentalRows: [] }),
    catalogCmd({}).command,
    { adminCfg: asyncEmptyCfg },
  );
  assertZeroGuestRentals(asyncEmptyCat, 'async zero active rows');
  const asyncEmptyQuote = await executeSunsetQuote(
    makeRentalCatalogPg({ rentalRows: [] }),
    quoteCmd({ offering_id: PUBLIC_BUNDLE_ITEM }).command,
    { adminCfg: asyncEmptyCfg },
  );
  assertQuoteRefused(asyncEmptyQuote, 'async zero-active public-site bundle');
  const asyncEmptyKayakQuote = await executeSunsetQuote(
    makeRentalCatalogPg({ rentalRows: [] }),
    quoteCmd({ offering_id: LIVE_RENTAL_ITEM }).command,
    { adminCfg: asyncEmptyCfg },
  );
  assertQuoteRefused(asyncEmptyKayakQuote, 'async zero-active stale kayak');

  console.log('\n[J] Async rental catalog query failure fail-closes (no price-only fallback)');
  const asyncFailCfg = cfgWithOfferingsAndPrices(undefined);
  let asyncFailCat = null;
  let asyncFailThrew = null;
  try {
    asyncFailCat = await executeSunsetCatalog(
      makeRentalCatalogPg({ failRentalQuery: true }),
      catalogCmd({}).command,
      { adminCfg: asyncFailCfg },
    );
  } catch (err) {
    asyncFailThrew = err;
  }
  assert(
    'async rental query failure does not throw uncaught',
    !asyncFailThrew,
    asyncFailThrew && asyncFailThrew.message,
  );
  assertZeroGuestRentals(asyncFailCat || { ok: false, body: { offerings: [] } }, 'async query failure');
  let asyncFailQuote = null;
  let asyncFailQuoteThrew = null;
  try {
    asyncFailQuote = await executeSunsetQuote(
      makeRentalCatalogPg({ failRentalQuery: true }),
      quoteCmd({ offering_id: PUBLIC_BUNDLE_ITEM }).command,
      { adminCfg: asyncFailCfg },
    );
  } catch (err) {
    asyncFailQuoteThrew = err;
  }
  assert(
    'async rental query failure quote does not throw uncaught',
    !asyncFailQuoteThrew,
    asyncFailQuoteThrew && asyncFailQuoteThrew.message,
  );
  assertQuoteRefused(asyncFailQuote || { ok: false, body: { reason: 'uncaught' } }, 'async query failure public-site');

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
