'use strict';

/**
 * verify:sunset-no-baseline-group-lesson-seed
 *
 * TDD gate — the €30 baseline group_lesson_adult seed must NOT be quotable or
 * catalogued when admin config is the authority. Only admin-backed lesson_slot_*
 * (or confirmed admin prices) may be offered.
 *
 * Run:
 *   node scripts/verify-sunset-no-baseline-group-lesson-seed.js
 */

const {
  resolveSunsetGroupLessonUnitCents,
  findPriceCents,
  LESSON_OFFERING_KEY,
  LESSON_UNIT_KEY,
} = require('./lib/sunset-stripe-payment-links');
const {
  quoteSunsetGroupLessonsFromPrices,
  quoteSunsetGroupLessonsSync,
} = require('./lib/sunset-group-lesson-quote');
const {
  buildSunsetLunaCatalogFromConfig,
} = require('./lib/sunset-luna-admin-catalog');
const {
  resolveTenantBusinessConfig,
  flattenOfferingPrices,
} = require('./lib/tenant-business-config');

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

const SEED_EUR = 30;
const SEED_CENTS = 3000;
const ADMIN_SLOT_CENTS = 4500;
const SLOT_ID = '11111111-2222-4333-8444-555555555555';
const SLOT_ITEM_CODE = `lesson_slot_${SLOT_ID}__session`;
const REF = new Date('2026-07-20T12:00:00Z');

function seedPrices() {
  return [{
    category: 'lesson',
    offering_key: LESSON_OFFERING_KEY,
    label: 'Adult / adolescent group surf lesson (over 12)',
    currency: 'EUR',
    unit: LESSON_UNIT_KEY,
    amount: SEED_EUR,
    active: true,
    pricing_status: 'unverified_seed',
    effective_state: 'unverified_seed',
    source: 'config',
    seed_source: 'public_site',
  }];
}

function adminSlotPrices() {
  return [{
    id: 'admin-slot-price',
    category: 'lesson',
    offering_key: SLOT_ITEM_CODE,
    label: 'Morning group lesson',
    currency: 'EUR',
    unit: 'session',
    amount: ADMIN_SLOT_CENTS / 100,
    amount_cents: ADMIN_SLOT_CENTS,
    active: true,
    pricing_status: 'confirmed',
    effective_state: 'db',
    source: 'db',
  }];
}

async function main() {
  console.log('\nverify:sunset-no-baseline-group-lesson-seed — admin is the only group-lesson catalog\n');

  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';
  process.env.SUNSET_ADMIN_JSON_OVERLAY = 'false';

  console.log('[A] Baseline file still has the €30 seed (not deleted)');
  const baselineCfg = resolveTenantBusinessConfig('sunset', 'sunset-somo');
  const seedUnit = findPriceCents(baselineCfg.prices || [], 'lesson', LESSON_OFFERING_KEY, LESSON_UNIT_KEY);
  assert('baseline still contains group_lesson_adult €30 seed row',
    seedUnit === SEED_CENTS, String(seedUnit));

  console.log('\n[B] Seed must NOT resolve as a live group-lesson unit');
  const fromSeed = resolveSunsetGroupLessonUnitCents(seedPrices());
  assert('unverified_seed group_lesson_adult → null (not €30)',
    fromSeed == null, String(fromSeed));

  const mixed = resolveSunsetGroupLessonUnitCents([...seedPrices(), ...adminSlotPrices()]);
  assert('when admin slot exists, unit is admin slot (not seed €30)',
    mixed === ADMIN_SLOT_CENTS, String(mixed));
  assert('admin slot ≠ seed', ADMIN_SLOT_CENTS !== SEED_CENTS);

  console.log('\n[C] Quote fails closed with only seed prices');
  const quoteSeed = quoteSunsetGroupLessonsFromPrices({
    locationId: 'sunset-somo',
    body: { service_dates: ['2026-07-20'], quantity: 1 },
    refDate: REF,
    prices: seedPrices(),
    adminCfg: { ok: true, source: 'config', prices: seedPrices() },
  });
  assert('seed-only quote fails', quoteSeed.ok === false, JSON.stringify(quoteSeed));
  assert('seed-only reason is group_lesson_price_unavailable',
    quoteSeed.reason === 'group_lesson_price_unavailable', JSON.stringify(quoteSeed));
  assert('seed-only quote never returns €30 total',
    quoteSeed.total_cents !== SEED_CENTS && quoteSeed.unit_amount_cents !== SEED_CENTS);

  console.log('\n[D] Quote succeeds only with admin lesson_slot price');
  const quoteAdmin = quoteSunsetGroupLessonsFromPrices({
    locationId: 'sunset-somo',
    body: { service_dates: ['2026-07-20'], quantity: 2 },
    refDate: REF,
    prices: adminSlotPrices(),
    adminCfg: { ok: true, source: 'db', prices: adminSlotPrices() },
  });
  assert('admin quote ok', quoteAdmin.ok === true, JSON.stringify(quoteAdmin));
  assert('admin quote unit is slot cents',
    quoteAdmin.unit_amount_cents === ADMIN_SLOT_CENTS, JSON.stringify(quoteAdmin));
  assert('admin quote total = unit × qty × dates',
    quoteAdmin.total_cents === ADMIN_SLOT_CENTS * 2, JSON.stringify(quoteAdmin));

  console.log('\n[E] Catalog never surfaces group lesson slots (courses-only for Luna)');
  const seedCatalog = buildSunsetLunaCatalogFromConfig({
    ok: true,
    source: 'config',
    prices: seedPrices(),
    lesson_times: [],
    surf_packs: [],
    private_lesson: null,
  }, { locationId: 'sunset-somo' });
  const seedGroupOfferings = (seedCatalog.offerings || []).filter((o) => o.offering_type === 'group_lesson'
    || /group_lesson_adult/.test(String(o.offering_id || ''))
    || /group_lesson_adult/.test(String(o.item_code || '')));
  assert('seed-only catalog has zero group_lesson offerings',
    seedGroupOfferings.length === 0, JSON.stringify(seedGroupOfferings));

  const adminCatalog = buildSunsetLunaCatalogFromConfig({
    ok: true,
    source: 'db',
    prices: [...seedPrices(), ...adminSlotPrices()],
    lesson_times: [{
      slot_id: SLOT_ID,
      slot_time: '11:00-13:00',
      offering_label: 'Morning group',
      active: true,
      weekdays_active: [1, 2, 3, 4, 5],
      age_band: '12_and_up',
      capacity: 12,
    }],
    surf_packs: [],
    private_lesson: null,
  }, { locationId: 'sunset-somo' });
  const adminGroups = (adminCatalog.offerings || []).filter((o) => o.offering_type === 'group_lesson'
    || o.offering_type === 'kids_lesson');
  assert('admin catalog excludes standalone lesson slots for Luna',
    adminGroups.length === 0, JSON.stringify(adminGroups));
  assert('admin catalog never offers seed €30 as group lesson',
    !(adminCatalog.offerings || []).some((o) => Number(o.unit_amount_cents) === SEED_CENTS),
    JSON.stringify(adminCatalog.offerings));

  console.log('\n[F] Sync baseline path (DB flag off) also refuses live seed quote');
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'false';
  const syncQuote = quoteSunsetGroupLessonsSync({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    body: { service_dates: ['2026-07-20'], quantity: 1 },
    refDate: REF,
  });
  assert('sync baseline quote fails closed (no silent €30)',
    syncQuote.ok === false && syncQuote.reason === 'group_lesson_price_unavailable',
    JSON.stringify(syncQuote));
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

  console.log('\n[G] Tenant isolation — wolfhouse helpers untouched conceptually');
  assert('LESSON_OFFERING_KEY constant retained for identity checks only',
    LESSON_OFFERING_KEY === 'group_lesson_adult');
  // flattenOfferingPrices still maps seed for admin tooling / migration — not for live quote
  const flat = flattenOfferingPrices({
    group_lesson_adult: {
      label: 'x',
      pricing_status: 'unverified_seed',
      prices_eur: { single_lesson: 30 },
      seed_source: 'public_site',
    },
  }, 'lesson', 'EUR');
  assert('flatten still produces seed rows for config tooling',
    flat.length === 1 && flat[0].pricing_status === 'unverified_seed');
  assert('flattened seed is still not live-resolvable',
    resolveSunsetGroupLessonUnitCents(flat) == null);

  console.log(`\nTotals: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
