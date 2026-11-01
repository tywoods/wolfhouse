#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const start = apiSrc.indexOf('async function handleBotConversationNeedsHuman');
assert.ok(start >= 0, 'handler exists');
const endMarker = apiSrc.indexOf('\n// Staff calendar bed block', start);
const handler = apiSrc.slice(start, endMarker > start ? endMarker : start + 4000);

assert.match(handler, /booking_code:\s*body\.booking_code|body\.booking_code/);
assert.match(handler, /booking_id:\s*body\.booking_id|body\.booking_id/);
assert.match(handler, /pause_id:\s*\(result && result\.pause_id\)/);
assert.match(handler, /created:\s*!!\(result && result\.created\)/);
assert.match(handler, /existing_staff_owned:\s*!!\(result && result\.existing_staff_owned\)/);
assert.doesNotMatch(handler, /handoff_reason:\s*\(result && result\.handoff_reason\) \|\| reason/);
assert.match(handler, /handoff_reason:\s*\(result && result\.handoff_reason\) \|\| null/);

console.log('ok bot needs-human handler forwards booking and pause identity');
