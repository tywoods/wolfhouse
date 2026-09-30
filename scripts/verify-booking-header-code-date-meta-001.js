'use strict';

/**
 * BOOKING-HEADER-CODE-DATE-META-001
 * Drawer booking code is quiet. Header dates are their own line, a bit larger,
 * with no year. Nights and guests sit under the dates.
 *
 *   node scripts/verify-booking-header-code-date-meta-001.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');

assert.match(api, /BOOKING-HEADER-CODE-DATE-META-001/);
assert.match(api, /\.bc-side-title\{margin:0;font-size:22px/);
assert.match(api, /\.bc-side-title\.bc-side-title-code\{font-size:13px;font-weight:600/);
assert.match(api, /\.bc-booking-code\{[^}]*font-size:13px;font-weight:600/);
assert.match(api, /\.bc-side-dates\{display:block;font-size:15px;font-weight:600/);
assert.match(api, /\.bc-side-stay\{display:block;margin-top:2px;font-size:12px/);
assert.match(api, /title\.classList\.add\('bc-side-title-code'\)/);
assert.match(api, /title\.classList\.remove\('bc-side-title-code'\)/);
assert.doesNotMatch(api, /· ' \+ escHtml\(String\(nights\)/);

function extractFn(name) {
  const start = api.indexOf('function ' + name + '(');
  assert.ok(start > 0, 'missing ' + name);
  let i = api.indexOf('{', start);
  let depth = 0;
  for (; i < api.length; i++) {
    if (api[i] === '{') depth++;
    else if (api[i] === '}') {
      depth--;
      if (depth === 0) return api.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

const sandbox = {
  escHtml: function (s) { return String(s == null ? '' : s); },
};
vm.createContext(sandbox);
vm.runInContext(
  [
    extractFn('bcStayNightsFromCheckInOut'),
    extractFn('bcFormatRangeLabel'),
    extractFn('bcSideHeaderDateLabel'),
    extractFn('bcSideStayMetaHtml'),
  ].join('\n'),
  sandbox,
);

const html = sandbox.bcSideStayMetaHtml('2026-10-21', '2026-10-25', 3);
assert.equal(
  html,
  '<span class="bc-side-dates">Oct 21 → Oct 25</span><span class="bc-side-stay">4 nights · 3 guests</span>',
);
assert.doesNotMatch(html, /2026/);
assert.doesNotMatch(html, /bc-side-nights/);
assert.ok(html.indexOf('bc-side-dates') < html.indexOf('bc-side-stay'));

const one = sandbox.bcSideStayMetaHtml('2026-10-21', '2026-10-22', 1);
assert.match(one, /1 nights/);
assert.match(one, /1 guest</);
assert.doesNotMatch(one, /1 guests/);
assert.doesNotMatch(one, /2026/);

const create = sandbox.bcSideStayMetaHtml('2026-11-02', '2026-11-06');
assert.match(create, /Nov 2 → Nov 6/);
assert.match(create, /4 nights/);
assert.doesNotMatch(create, /guest/);
assert.doesNotMatch(create, /2026/);

console.log('PASS booking-header-code-date-meta-001');
