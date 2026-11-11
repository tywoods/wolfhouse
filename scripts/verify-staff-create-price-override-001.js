'use strict';

// Ale Launch Fix Pack item 8: Staff Create Booking has a price-override field
// that quote preview and create send as manual_price_per_night_euros.
const assert = require('node:assert/strict');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

const src = readStaffPortalUiSource();

assert.match(src, /id="bk-price-override"/, 'create form has price override input');
assert.match(src, /data-i18n="calendar.create.priceOverride"/);

function extractFunction(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start > 0, name + ' exists');
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

const quote = extractFunction('runQuotePreview');
assert.match(quote, /bk-price-override/, 'quote reads override field');
assert.match(quote, /manual_price_per_night_euros/, 'quote sends override euros');
assert.match(quote, /manual_override/, 'quote uses existing manual override package');

const create = extractFunction('runManualBookingCreate');
assert.match(create, /bk-price-override/, 'create reads override field');
assert.match(create, /manual_price_per_night_euros/, 'create sends override euros');
assert.match(create, /manual_override/, 'create uses existing manual override package');

const en = STAFF_PORTAL_STRINGS.en;
const es = STAFF_PORTAL_STRINGS.es;
const it = STAFF_PORTAL_STRINGS.it;
assert.ok(en['calendar.create.priceOverride']);
assert.doesNotMatch(en['calendar.create.priceOverride'], /person/i);
assert.ok(es['calendar.create.priceOverride'] && es['calendar.create.priceOverride'] !== en['calendar.create.priceOverride']);
assert.ok(it['calendar.create.priceOverride'] && it['calendar.create.priceOverride'] !== en['calendar.create.priceOverride']);

console.log('PASS create booking price override');
