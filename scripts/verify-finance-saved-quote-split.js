'use strict';
const assert = require('assert');
const { calculateWolfhouseQuote, loadConfig } = require('./lib/wolfhouse-quote-calculator');
const { computeSunsetFinanceSummary } = require('./lib/sunset-finance-summary');
const quote = calculateWolfhouseQuote({ client_slug: 'wolfhouse-somo', check_in: '2026-10-10',
  check_out: '2026-10-17', guest_count: 1, package_code: 'package_none', room_type: 'shared',
  payment_choice: 'deposit', add_ons: [{ code: 'yoga_class', quantity: 1 }] }, loadConfig());
assert.ok(quote.total_cents > 0);
assert.ok(quote.line_items.some(x => x.code === 'accommodation_only'));
const row = { booking_id: 'saved', service_date: '2026-10-10', amount_due_cents: quote.total_cents,
  service_type: 'accommodation', metadata: { quote_snapshot: quote } };
function summary(bsr) { return computeSunsetFinanceSummary({ now: new Date('2026-10-14T12:00:00Z'),
  productMode: 'lodging_packages', view: { granularity: 'month', anchor: '2026-10-14' },
  bookings: [{ booking_id: 'saved', total_amount_cents: quote.total_cents }], bsr, payments: [] }); }
const result = summary([row]);
const categories = result.redesign.revenue_by_product;
assert.strictEqual(categories.find(x => x.key === 'accommodation').cents,
  quote.line_items.filter(x => x.code === 'accommodation_only').reduce((n,x) => n+x.total_cents,0));
assert.strictEqual(categories.find(x => x.key === 'services').cents,
  quote.line_items.filter(x => x.code === 'yoga_class').reduce((n,x) => n+x.total_cents,0));
assert.strictEqual(categories.find(x => x.key === 'camps').cents, 0, 'complete saved producer snapshot establishes absence, not guessed cash allocation');
assert.strictEqual(categories.reduce((n,x) => n+(x.cents || 0),0), quote.total_cents);
assert.deepStrictEqual(summary([row,row]).redesign.revenue_by_product, categories, 'duplicate booking projection must not double product totals');
const inconsistent = { ...row, metadata: { quote_snapshot: { ...quote, total_cents: quote.total_cents + 1 } } };
assert.strictEqual(summary([inconsistent]).redesign.revenue_by_product.find(x => x.key === 'accommodation').cents, null);
assert.deepStrictEqual(result.redesign.net, summary([{ ...row, metadata: {} }]).redesign.net, 'split cannot change Net collected');
const adjustmentQuote = { ...quote, line_items: [...quote.line_items,
  { code: 'saved_adjustment', total_cents: -100 }], total_cents: quote.total_cents - 100 };
const adjusted = summary([{ ...row, amount_due_cents: adjustmentQuote.total_cents,
  metadata: { quote_snapshot: adjustmentQuote } }]).redesign.revenue_by_product;
assert.strictEqual(adjusted.find(x => x.key === 'unclassified').cents, -100, 'explicit signed adjustment must be retained without category guessing');
assert.strictEqual(adjusted.find(x => x.key === 'camps').cents, null, 'unknown saved adjustment keeps unsupported categories partial');
assert.strictEqual(adjusted.reduce((n,x) => n+(x.cents || 0),0), adjustmentQuote.total_cents);
const conflicting = { ...row, amount_due_cents: quote.total_cents + 1 };
assert.strictEqual(summary([row, conflicting]).redesign.revenue_by_product.find(x => x.key === 'accommodation').cents, null);
const emptyRows = summary([]).redesign.revenue_by_product;
assert.ok(emptyRows.every(x => x.cents === null), 'no saved lines is unavailable, not three invented zero totals');
console.log('PASS verify-finance-saved-quote-split (actual quote producer, saved snapshot fixture)');
