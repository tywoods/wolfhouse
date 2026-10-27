'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const start = api.indexOf('async function handleBotSurfReport');
assert.ok(start > 0, 'handleBotSurfReport present');
const nextAsync = api.indexOf('\nasync function ', start + 10);
const fn = api.slice(start, nextAsync > 0 ? nextAsync : start + 9000);

assert.doesNotMatch(fn, /UNSUPPORTED_RANGE/);
assert.match(fn, /dayRaw === 'week'/);
assert.match(fn, /day === 'week' \? 7/);
assert.match(fn, /daysRaw >= 1 && daysRaw <= 7/);
assert.match(fn, /\bdays,/);
assert.match(fn, /structured\.days/);
assert.match(fn, /structured\.tides/);

const plugin = fs.readFileSync(path.join(__dirname, '../docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py'), 'utf8');
assert.match(plugin, /if day not in \("today", "tomorrow", "week"\)/);
assert.match(plugin, /payload\["days"\] = days/);
assert.match(plugin, /has_dedicated_tides/);
assert.match(plugin, /"days": data.get\("days"\)/);
assert.match(plugin, /"tides": tides or data.get\("tides"\)/);
assert.match(plugin, /"enum": \["today", "tomorrow", "week"\]/);

console.log('PASS surf-report week days tides contract');
