'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, 'browser/wolfhouse-services-admin.js'), 'utf8');
const start = src.indexOf('function servicesApi');
assert.ok(start > 0, 'servicesApi present');
const fn = src.slice(start, src.indexOf('\n  function svcMsg', start));

assert.match(
  fn,
  /\.catch\s*\(\s*function\s*\([^)]*\)\s*\{[\s\S]{0,180}status:\s*0/,
  'servicesApi must settle rejected fetches as status 0 so load/save never stick on Loading or blank feedback'
);
assert.match(fn, /adminApiRequest/, 'still uses adminApiRequest when present');

console.log('PASS services api rejection root');
