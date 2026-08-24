'use strict';

/**
 * Staff booking-calendar chrome: site font, smaller nav/header, no owner-schedule legend.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');

assert.match(api, /#tab-bed-calendar,#tab-bed-calendar \.bc-grid/);
assert.match(api, /#tab-bed-calendar \.bc-grid,#tab-bed-calendar \.bc-block[\s\S]{0,240}font-family:var\(--font-sans\)/);
assert.match(api, /#tab-bed-calendar \.toolbar h2\{[\s\S]{0,80}font-family:var\(--font-display\)/);
assert.match(api, /\.tab-btn\{padding:8px 14px;font-size:13px/);
assert.match(api, /#tabs\{[^}]*min-height:44px/);
assert.match(api, /\.luna-header-ui\.luna-hdr-compact #banner\{\s*height:52px/);
assert.match(api, /id="bc-legend"/);
assert.doesNotMatch(api, /id="bc-legend"[\s\S]{0,800}calendar\.legend\.ownerScheduleBlocked/);
assert.match(api, /t\('calendar\.legend\.ownerScheduleBlocked'\)/);

console.log('PASS staff-calendar-chrome: font + smaller nav + no owner-schedule legend');
