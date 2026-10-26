'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
const { MODEL_TOOL_SCHEMAS } = require('./lib/model-led-luna/contracts');

function quoteWith(addOnConfig, addOn) {
  const config = loadConfig();
  config.seasons = [{
    code: 'all', active: true, bookable: true, priority: 1,
    ranges: [{ start_month: 1, start_day: 1, end_month: 12, end_day: 31 }],
  }];
  for (const pkg of config.packages) pkg.seasonal_prices.all = { weekly_per_person_cents: 10000 };
  config.add_ons = { [addOn.code]: { name: addOn.code, price_cents: 4000, ...addOnConfig } };
  return calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2027-06-01', check_out: '2027-06-08', guest_count: 1,
    room_type: 'shared', package_code: 'package_none', manual_price_per_night_cents: 1000,
    add_ons: [addOn], payment_choice: 'deposit',
  }, config);
}

for (const [unit, addOn, expected] of [
  ['per_lesson', { code: 'group_lesson', quantity: 2 }, 8000],
  ['per_person', { code: 'airport_breakfast', quantity: 2 }, 8000],
  ['per_stay', { code: 'late_checkout', quantity: 3 }, 4000],
  ['flat', { code: 'locker_key', quantity: 3 }, 4000],
]) {
  const result = quoteWith({ pricing_unit: unit, item_type: 'service' }, addOn);
  assert.equal(result.success, true, `${unit}: ${JSON.stringify(result)}`);
  const line = result.line_items.find((item) => item.code === addOn.code);
  assert(line, `${unit} must produce a line item`);
  assert.equal(line.total_cents, expected, `${unit} total`);
}

const unknown = quoteWith({ pricing_unit: 'per_mystery', item_type: 'service' }, { code: 'mystery', quantity: 1 });
assert.equal(unknown.success, false, JSON.stringify(unknown));
assert.match(String(unknown.reason_code || unknown.code || unknown.blockers), /pricing|unit/i);

const quantitySchema = MODEL_TOOL_SCHEMAS.check_quote_book.properties.add_ons.items.properties.quantity;
assert.equal(quantitySchema.minimum, undefined, 'the model-visible schema must forward invalid quantities to Staff');

const booking = fs.readFileSync(path.join(__dirname, '../docker/hermes-luna-v3/instructions/booking.md'), 'utf8');
assert.match(booking, /including zero, negative, or otherwise invalid quantities/i);
assert.match(booking, /total, deposit, and remaining balance/i);
assert.match(booking, /Staff(?: alone)? (?:validates|decides)/i);

console.log('luna v3 LIVE3 root fixes: PASS');
