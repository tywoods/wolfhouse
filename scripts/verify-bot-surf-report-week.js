'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const start = api.indexOf('async function handleBotSurfReport');
assert.ok(start > 0, 'handleBotSurfReport present');
const nextAsync = api.indexOf('\nasync function ', start + 10);
const fn = api.slice(start, nextAsync > 0 ? nextAsync : start + 8000);

assert.doesNotMatch(fn, /if \(day === 'week'\) \{\s*outcome = 'UNSUPPORTED_RANGE'/);
assert.match(fn, /fetchStormglassForecast\(\{[\s\S]{0,220}days:/);
assert.match(fn, /structured\.days/);
assert.match(fn, /structured\.tides/);
assert.match(fn, /weekDays/);

console.log('PASS surf-report week');
