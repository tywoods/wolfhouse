#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
assert.match(api, /function bcPlaceYearPop\(/);
assert.match(api, /#bc-year-pop\{[^}]*position:fixed/);
assert.match(api, /#bc-year-pop\{[^}]*z-index:40/);
assert.doesNotMatch(api, /#tab-bed-calendar\.active\{[^}]*overflow\s*:\s*visible/);
assert.match(api, /document\.body\.appendChild\(pop\)/);

function extractFunction(name) {
  const start = api.indexOf('function ' + name + '(');
  assert.ok(start > 0, name);
  let i = api.indexOf('{', start);
  let depth = 0;
  for (; i < api.length; i += 1) {
    if (api[i] === '{') depth += 1;
    else if (api[i] === '}') {
      depth -= 1;
      if (depth === 0) return api.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

const bodyKids = [];
const pop = { hidden: true, innerHTML: '', children: [], style: {}, parentNode: null };
pop.appendChild = (node) => pop.children.push(node);
const yearBtn = {
  expanded: 'false',
  setAttribute: (k, v) => { if (k === 'aria-expanded') yearBtn.expanded = v; },
  getBoundingClientRect: () => ({ left: 12, top: 28, right: 40, bottom: 48, width: 28, height: 20 }),
};
const sandbox = {
  window: {
    t: () => 'No booking years yet',
    addEventListener() {},
  },
  bcData: { booking_years: [2026, 2027], blocks: [] },
  el: (id) => ({ 'bc-year-pop': pop, 'bc-year-open': yearBtn, 'bc-start': { value: '2026-11-01' } }[id] || null),
  document: {
    createElement: () => ({ className: '', textContent: '', setAttribute() {} }),
    body: { appendChild: (node) => { bodyKids.push(node); node.parentNode = sandbox.document.body; return node; } },
    addEventListener() {},
  },
  Date,
  Number,
  String,
  Math,
};
vm.createContext(sandbox);
const names = ['bcFourDigitYear', 'bcBookingYearsFromData', 'bcYearEmptyText', 'bcPlaceYearPop', 'bcPlaceYearPopIfOpen', 'bcCloseYearPop', 'bcRenderYearPop', 'bcOpenYearPop'];
vm.runInContext(names.map(extractFunction).join('\n') + '\nthis.api = { bcOpenYearPop, bcPlaceYearPop };', sandbox);
sandbox.api.bcOpenYearPop();
assert.equal(bodyKids[0], pop, 'year pop portals to document.body');
assert.equal(pop.style.position, 'fixed');
assert.equal(String(pop.style.zIndex), '40');
assert.equal(pop.hidden, false);
assert.equal(yearBtn.expanded, 'true');
console.log('ok schedule year popup stacks above the grid');
