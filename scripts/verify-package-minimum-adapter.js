'use strict';
const assert = require('node:assert/strict');
const { accommodationVerticalAdapter: adapter } = require('./lib/verticals/accommodation-vertical-adapter');
const { resolveBusinessVertical } = require('./lib/luna-front-desk-business-vertical');
const { loadConfig } = require('./lib/wolfhouse-quote-calculator');
const config = loadConfig();
config.package_min_nights = 4;
const resolved = resolveBusinessVertical({ clientSlug: 'wolfhouse-somo' });
const result = adapter.evaluateDates({ resolved, config, transportBody: {
  check_in: '2026-07-01', check_out: '2026-07-05', package_code: 'malibu',
} });
assert.equal(result.package_min_nights, 4);
assert.equal(result.ok, true);
console.log('PASS adapter forwards effective package minimum');
