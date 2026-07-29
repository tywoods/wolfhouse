'use strict';

/**
 * verify:tenant-rental-price-resolver
 *
 * Step 1 of the generic-rental booking-acceptance path
 * (docs/PHASE-2-RENTAL-BOOKING-ACCEPTANCE.md). Proves the offering_key-native
 * price resolver:
 *   - PRICES a generic offering (kayak_rental) that the frozen ITEM_ALIASES
 *     whitelist would reject — i.e. blocker #1's pricing wall is bypassed
 *     without touching the closed set.
 *   - multiplies by quantity, and fails closed on every bad input / unknown
 *     price / duration-item mismatch (blocker #3) — never a guessed amount.
 *
 * Pure: injected loadRule spy. No DB, no API key, no network.
 *
 * Run: node scripts/verify-tenant-rental-price-resolver.js
 */

const {
  resolveGenericRentalPrice,
  buildGenericRentalServiceRecord,
  partitionRentalsForCreate,
  GENERIC_RENTAL_SERVICE_TYPE,
} = require('./lib/tenant-rental-price-resolver');
const { ITEM_ALIASES, lookupSunsetRentalPriceAsync } = require('./lib/sunset-rental-price-lookup');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; return; }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

const SOMO = 'sunset-somo';

// loadRule spy: prices from a small table keyed by persisted item_code + unit,
// mirroring loadTenantPriceRuleFromDb's found-shape.
function makeSpy(table) {
  let calls = 0;
  const seen = [];
  const fn = async (params) => {
    calls += 1;
    seen.push(params);
    const itemCode = `${params.itemCode}__${params.duration}`;
    const row = table[`${itemCode}|${params.billingUnit}|${params.locationId}`];
    if (!row) return { status: 'not_found' };
    return { status: 'found', item_code: itemCode, unit: params.billingUnit, location_id: params.locationId, ...row };
  };
  fn.calls = () => calls;
  fn.seen = () => seen;
  return fn;
}

async function main() {
  console.log('\nverify:tenant-rental-price-resolver — offering_key-native, fail-closed\n');

  const table = {
    [`kayak_rental__half_day|session|${SOMO}`]: { amount_cents: 2500, currency: 'EUR' },
    [`sup_rental__3_days|day|${SOMO}`]: { amount_cents: 1800, currency: 'EUR' },
  };

  console.log('[accept] generic offerings the frozen whitelist would reject');
  assert('sanity: kayak_rental is NOT in frozen ITEM_ALIASES',
    !Object.values(ITEM_ALIASES).includes('kayak_rental'));

  const spy1 = makeSpy(table);
  const kayak = await resolveGenericRentalPrice({
    clientSlug: 'sunset', locationId: SOMO, offeringKey: 'kayak_rental',
    durationKey: 'half day', quantity: 2, loadRule: spy1,
  });
  assert('kayak half-day x2 priced', kayak.ok === true, JSON.stringify(kayak));
  assert('kayak unit_cents=2500', kayak.unit_cents === 2500, JSON.stringify(kayak));
  assert('kayak amount_cents=5000 (x2)', kayak.amount_cents === 5000, JSON.stringify(kayak));
  assert('kayak item_code=kayak_rental__half_day', kayak.item_code === 'kayak_rental__half_day', JSON.stringify(kayak));
  assert('kayak unit=session', kayak.unit === 'session', JSON.stringify(kayak));
  assert('kayak duration normalized to half_day', kayak.duration_key === 'half_day', JSON.stringify(kayak));
  assert('kayak → exactly one loadRule call', spy1.calls() === 1, String(spy1.calls()));

  const spy2 = makeSpy(table);
  const sup = await resolveGenericRentalPrice({
    clientSlug: 'sunset', locationId: SOMO, offeringKey: 'sup_rental',
    durationKey: '3_days', quantity: 4, loadRule: spy2,
  });
  assert('sup 3-day x4 priced day-unit', sup.ok === true && sup.unit === 'day', JSON.stringify(sup));
  assert('sup amount_cents=7200 (1800x4)', sup.amount_cents === 7200, JSON.stringify(sup));

  console.log('\n[fail-closed] unknown price / bad rule');
  const spyMiss = makeSpy(table);
  const miss = await resolveGenericRentalPrice({
    clientSlug: 'sunset', locationId: SOMO, offeringKey: 'kayak_rental',
    durationKey: '7_days', quantity: 1, loadRule: spyMiss,
  });
  assert('no rule → price_not_found', miss.ok === false && miss.reason === 'price_not_found', JSON.stringify(miss));
  assert('no rule → no amount leaked', miss.amount_cents === undefined, JSON.stringify(miss));

  const thrower = async () => { throw new Error('db_down'); };
  const boom = await resolveGenericRentalPrice({
    clientSlug: 'sunset', locationId: SOMO, offeringKey: 'kayak_rental', durationKey: 'half_day', loadRule: thrower,
  });
  assert('loadRule throws → price_lookup_failed', boom.ok === false && boom.reason === 'price_lookup_failed', JSON.stringify(boom));

  const badAmount = async (p) => ({ status: 'found', item_code: `${p.itemCode}__${p.duration}`, unit: p.billingUnit, amount_cents: 'NaN', currency: 'EUR' });
  const bad = await resolveGenericRentalPrice({
    clientSlug: 'sunset', locationId: SOMO, offeringKey: 'kayak_rental', durationKey: 'half_day', loadRule: badAmount,
  });
  assert('non-numeric amount → price_not_found', bad.ok === false && bad.reason === 'price_not_found', JSON.stringify(bad));

  console.log('\n[integrity] duration/item mismatch never borrows another rule (#3)');
  const wrongCode = async (p) => ({ status: 'found', item_code: 'board_and_suit_rental__half_day', unit: p.billingUnit, amount_cents: 9999, currency: 'EUR' });
  const mism = await resolveGenericRentalPrice({
    clientSlug: 'sunset', locationId: SOMO, offeringKey: 'kayak_rental', durationKey: 'half_day', loadRule: wrongCode,
  });
  assert('mismatched item_code → price_scope_mismatch', mism.ok === false && mism.reason === 'price_scope_mismatch', JSON.stringify(mism));
  assert('mismatch → no amount leaked', mism.amount_cents === undefined, JSON.stringify(mism));

  const wrongUnit = async (p) => ({ status: 'found', item_code: `${p.itemCode}__${p.duration}`, unit: 'week', amount_cents: 5000, currency: 'EUR' });
  const um = await resolveGenericRentalPrice({
    clientSlug: 'sunset', locationId: SOMO, offeringKey: 'kayak_rental', durationKey: 'half_day', loadRule: wrongUnit,
  });
  assert('mismatched unit → price_scope_mismatch', um.ok === false && um.reason === 'price_scope_mismatch', JSON.stringify(um));

  const pending = async (p) => ({ status: 'found', item_code: `${p.itemCode}__${p.duration}`, unit: p.billingUnit, amount_cents: 5000, currency: 'EUR', pricing_status: 'pending' });
  const pv = await resolveGenericRentalPrice({
    clientSlug: 'sunset', locationId: SOMO, offeringKey: 'kayak_rental', durationKey: 'half_day', loadRule: pending,
  });
  assert('unconfirmed pricing_status → price_unverified', pv.ok === false && pv.reason === 'price_unverified', JSON.stringify(pv));

  console.log('\n[pre-DB guards] bad input never reaches loadRule');
  for (const [label, opts, reason] of [
    ['empty offering_key', { offeringKey: '', durationKey: 'half_day' }, 'invalid_offering_key'],
    ['offering_key with __', { offeringKey: 'kayak__x', durationKey: 'half_day' }, 'invalid_offering_key'],
    ['uppercase offering_key', { offeringKey: 'Kayak', durationKey: 'half_day' }, 'invalid_offering_key'],
    ['missing duration', { offeringKey: 'kayak_rental', durationKey: '' }, 'missing_duration_key'],
    ['unsupported duration', { offeringKey: 'kayak_rental', durationKey: 'fortnight' }, 'unsupported_duration'],
    ['zero quantity', { offeringKey: 'kayak_rental', durationKey: 'half_day', quantity: 0 }, 'invalid_quantity'],
    ['negative quantity', { offeringKey: 'kayak_rental', durationKey: 'half_day', quantity: -2 }, 'invalid_quantity'],
    ['fractional quantity', { offeringKey: 'kayak_rental', durationKey: 'half_day', quantity: 1.5 }, 'invalid_quantity'],
    ['missing client', { clientSlug: '', offeringKey: 'kayak_rental', durationKey: 'half_day' }, 'missing_client'],
  ]) {
    const spy = makeSpy(table);
    const r = await resolveGenericRentalPrice({ clientSlug: 'sunset', locationId: SOMO, loadRule: spy, ...opts });
    assert(`${label} → ${reason}`, r.ok === false && r.reason === reason, JSON.stringify(r));
    assert(`${label} → zero loadRule calls`, spy.calls() === 0, String(spy.calls()));
  }

  console.log('\n[step 2] priced generic rental → first-class booking_service_records descriptor');
  const spyRec = makeSpy(table);
  const pricedKayak = await resolveGenericRentalPrice({
    clientSlug: 'sunset', locationId: SOMO, offeringKey: 'kayak_rental',
    durationKey: 'half_day', quantity: 3, loadRule: spyRec,
  });
  const built = buildGenericRentalServiceRecord({ ...pricedKayak, offering_label: 'Sea Kayak' }, {
    bookingId: 'b-1', bookingCode: 'WH-9', guestName: 'Ada', serviceDate: '2026-08-01',
  });
  assert('record built ok', built.ok === true, JSON.stringify(built));
  const rec = built.record || {};
  assert('service_type = addon_service (generic bucket, no migration)',
    rec.service_type === GENERIC_RENTAL_SERVICE_TYPE && rec.service_type === 'addon_service', JSON.stringify(rec));
  assert('amount_due_cents = 7500 (2500 x3)', rec.amount_due_cents === 7500, JSON.stringify(rec));
  assert('quantity preserved (3)', rec.quantity === 3, JSON.stringify(rec));
  assert('unpaid: amount_paid 0 + not_requested', rec.amount_paid_cents === 0 && rec.payment_status === 'not_requested', JSON.stringify(rec));
  assert('metadata carries offering identity and Admin label', rec.metadata && rec.metadata.offering_key === 'kayak_rental'
    && rec.metadata.offering_label === 'Sea Kayak'
    && rec.metadata.item_code === 'kayak_rental__half_day' && rec.metadata.rental_offering === true, JSON.stringify(rec.metadata));
  assert('metadata carries location + unit_cents', rec.metadata.location_id === SOMO && rec.metadata.unit_cents === 2500, JSON.stringify(rec.metadata));
  assert('booking linkage passed through', rec.booking_id === 'b-1' && rec.booking_code === 'WH-9' && rec.guest_name === 'Ada', JSON.stringify(rec));

  console.log('\n[step 2 fail-closed] never build a record from bad input');
  const fromFail = buildGenericRentalServiceRecord({ ok: false, reason: 'price_not_found' }, { serviceDate: '2026-08-01' });
  assert('unpriced input → refused', fromFail.ok === false && fromFail.reason === 'unpriced', JSON.stringify(fromFail));
  const noDate = buildGenericRentalServiceRecord(pricedKayak, { bookingId: 'b-1' });
  assert('missing service_date → refused', noDate.ok === false && noDate.reason === 'missing_service_date', JSON.stringify(noDate));
  const nullIn = buildGenericRentalServiceRecord(null, { serviceDate: '2026-08-01' });
  assert('null priced → refused', nullIn.ok === false && nullIn.reason === 'unpriced', JSON.stringify(nullIn));

  console.log('\n[characterization] the frozen-alias wall this resolver bypasses (pin for step 3)');
  // Documents current live behavior: lookupSunsetRentalPriceAsync rejects a
  // generic offering at the ITEM_ALIASES gate BEFORE any DB read. If step 3 ever
  // makes the live wrapper generic, this assertion is the tripwire to update
  // deliberately (never silently).
  let wallCalls = 0;
  const wallSpy = async () => { wallCalls += 1; return { status: 'found', amount_cents: 9999, currency: 'EUR', item_code: 'kayak_rental__half_day', unit: 'session' }; };
  const walled = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset', location_id: SOMO, item: 'kayak_rental', duration: 'half_day', loadRule: wallSpy,
  });
  assert('legacy wrapper still rejects generic kayak_rental (unknown_item)',
    walled.ok === false && walled.reason === 'unknown_item', JSON.stringify(walled));
  assert('legacy wrapper blocks at alias gate BEFORE any DB read (0 loadRule calls)',
    wallCalls === 0, String(wallCalls));
  const bypass = await resolveGenericRentalPrice({
    clientSlug: 'sunset', locationId: SOMO, offeringKey: 'kayak_rental', durationKey: 'half_day', quantity: 1, loadRule: makeSpy(table),
  });
  assert('new resolver bypasses the wall for the SAME generic key', bypass.ok === true && bypass.amount_cents === 2500, JSON.stringify(bypass));

  console.log('\n[step 3 foundation] partitionRentalsForCreate — canonical vs generic lanes');
  const CANON = ['board_rental', 'wetsuit_rental', 'board_and_suit_rental'];
  const CATALOG = ['kayak_rental', 'sup_rental'];
  const mk = (k) => ({ offering_key: k, duration_key: 'half_day', quantity: 1 });

  // Flag OFF is a strict no-op: generic key rejected exactly like today (#tripwire).
  const offGeneric = partitionRentalsForCreate([mk('kayak_rental')], { canonicalKeys: CANON, catalogKeys: CATALOG, genericEnabled: false });
  assert('flag OFF: generic catalog key still rejected (behavior-preserving)',
    offGeneric.ok === false && offGeneric.reason === 'invalid_rental_offering', JSON.stringify(offGeneric));
  const offCanon = partitionRentalsForCreate([mk('board_rental'), mk('wetsuit_rental')], { canonicalKeys: CANON, catalogKeys: CATALOG, genericEnabled: false });
  assert('flag OFF: canonical keys still pass into canonical lane',
    offCanon.ok === true && offCanon.canonical.length === 2 && offCanon.generic.length === 0, JSON.stringify(offCanon));

  // Flag ON: catalog generic keys route to the generic lane; canonical stays canonical.
  const onMix = partitionRentalsForCreate([mk('board_and_suit_rental'), mk('kayak_rental')], { canonicalKeys: CANON, catalogKeys: CATALOG, genericEnabled: true });
  assert('flag ON: mixed split — 1 canonical, 1 generic',
    onMix.ok === true && onMix.canonical.length === 1 && onMix.generic.length === 1
    && onMix.canonical[0].offering_key === 'board_and_suit_rental' && onMix.generic[0].offering_key === 'kayak_rental', JSON.stringify(onMix));

  // Flag ON but key not in catalog → still fail closed (must be a real active offering).
  const onUnknown = partitionRentalsForCreate([mk('jetski_rental')], { canonicalKeys: CANON, catalogKeys: CATALOG, genericEnabled: true });
  assert('flag ON: unknown (non-catalog) key still rejected',
    onUnknown.ok === false && onUnknown.reason === 'invalid_rental_offering' && onUnknown.index === 0, JSON.stringify(onUnknown));

  console.log(`\n── verify:tenant-rental-price-resolver ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass}/${pass + fail}) ──\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
