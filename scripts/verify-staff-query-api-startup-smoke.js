'use strict';

const assert = require('assert');
const vm = require('vm');

process.env.NODE_ENV = 'test';
process.env.STAFF_AUTH_REQUIRED = 'false';
process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';

const api = require('./staff-query-api');
assert.equal(typeof require('./lib/sunset-course-equipment-pricing').validateConfig, 'function', 'Staff API imported pricing validator must remain callable until its route is retired');
assert.equal(typeof api.buildUiHtmlForOfflineTest, 'function', 'production Staff API must import and expose the gated UI builder');
const html = api.buildUiHtmlForOfflineTest(3036, { headers: {} });
assert.equal(typeof html, 'string');
assert.match(html, /<script[\s>]/i, 'generated /staff/ui contains browser JavaScript');
let parsed = 0;
for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
  const open = match[0].slice(0, match[0].indexOf('>') + 1);
  if (/type=["']application\/json["']/i.test(open) || /\bsrc=/i.test(open)) continue;
  new vm.Script(match[1], { filename: `generated-staff-ui-inline-${++parsed}.js` });
}
assert(parsed > 0, 'parsed at least one generated inline browser bundle');
console.log(`PASS Staff API production import + generated /staff/ui parse smoke (${parsed} scripts)`);
