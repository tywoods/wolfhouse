'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  PUBLIC_TOOL_NAMES,
  MODEL_TOOL_SCHEMAS,
  SUPPORTED_CATALOG_KINDS,
  normalizeCheckQuoteBook,
  buildCanonicalQuoteInput,
  refusalEnvelope,
} = require('./lib/model-led-luna/contracts');

assert.deepEqual(SUPPORTED_CATALOG_KINDS, ['package', 'service', 'rental']);
assert.deepEqual(Object.keys(MODEL_TOOL_SCHEMAS).sort(), [...PUBLIC_TOOL_NAMES].sort());
assert.equal(MODEL_TOOL_SCHEMAS.check_quote_book.additionalProperties, false);

const dates = ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'];
const request = normalizeCheckQuoteBook({
  action: 'prepare', purpose: 'quote', check_in: '2026-11-18', check_out: '2026-11-23',
  guests: [{ name: 'Tom' }], room: { kind: 'shared' }, package: { name: 'Custom Or Short Stay' },
  add_ons: [
    { name: 'Soft-top surfboard rental', quantity: 1, dates },
    { name: 'Wetsuit rental', people: ['Tom'], requested_dates: dates },
  ],
});
const catalog = { items: [
  { item_type: 'deposit', item_code: 'custom_or_short_stay', label: 'Custom Or Short Stay' },
  { item_type: 'rental', item_code: 'soft_top', label: 'Soft-top surfboard rental', pricing_units: ['per_day'] },
  { item_type: 'rental', item_code: 'wetsuit', label: 'Wetsuit rental', pricing_units: ['per_day'] },
] };
const built = buildCanonicalQuoteInput(request, catalog, ['BED-1'], { sessionId: 's', turnId: 't' });
assert.equal(built.ok, true, JSON.stringify(built));
assert.equal(built.value.package_id, 'package_none');
assert.deepEqual(built.value.add_ons, [
  { code: 'soft_top', dates, days: 5, quantity: 1 },
  { code: 'wetsuit', dates, days: 5, quantity: 1 },
]);

for (const kind of SUPPORTED_CATALOG_KINDS) {
  const choiceCatalog = { items: [{ item_type: kind, item_code: `${kind}_1`, label: `${kind} one` }] };
  const choice = kind === 'package'
    ? { ...request, package: { name: `${kind} one` }, add_ons: [] }
    : { ...request, package: { name: 'Custom Or Short Stay' }, add_ons: [{ name: `${kind} one`, quantity: 1, ...(kind === 'rental' ? { dates: [request.check_in] } : {}) }] };
  const availableCatalog = kind === 'package' ? choiceCatalog : { items: [...catalog.items.slice(0, 1), ...choiceCatalog.items] };
  assert.equal(buildCanonicalQuoteInput(choice, availableCatalog, ['BED-1'], { sessionId: 's', turnId: `t-${kind}` }).ok, true, kind);
}

const badDate = buildCanonicalQuoteInput({ ...request, add_ons: [{ name: 'Wetsuit rental', quantity: 1, dates: ['2026-11-23'] }] }, catalog, ['BED-1'], { sessionId: 's', turnId: 'bad' });
assert.equal(badDate.ok, false);
assert.equal(badDate.code, 'rental_dates_invalid');
assert.deepEqual(Object.keys(badDate).sort(), ['code', 'correlation_id', 'field_errors', 'message', 'next_step', 'ok', 'retry_allowed'].sort());
assert.equal(badDate.field_errors[0].path, 'add_ons[0].dates');

const noPackage = buildCanonicalQuoteInput({ ...request, package: { name: 'No package' } }, catalog, ['BED-1'], { sessionId: 's', turnId: 'no-package' });
assert.equal(noPackage.ok, false, 'catalog, not aliases, owns choices');
assert.equal(noPackage.code, 'package_choice_required');
const transport = refusalEnvelope({ code: 'staff_transport_non_json', path: '$', classification: 'transport' }, { correlationId: 'c1' });
assert.equal(transport.correlation_id, 'c1');
assert.equal(transport.retry_allowed, false);
assert.equal(transport.field_errors[0].code, 'staff_transport_non_json');

const bookingFlow = fs.readFileSync(require.resolve('./lib/model-led-luna/v3-booking-flow'), 'utf8');
const index = fs.readFileSync(require.resolve('./lib/model-led-luna'), 'utf8');
for (const retired of ['function availabilityPreferences', 'function chooseBeds', 'function packageSelection', 'function addOns']) assert.equal(bookingFlow.includes(retired), false, retired);
assert.equal(index.includes('function validateRentalDateSelections'), false);
console.log('luna v3 Staff contract root: PASS');
