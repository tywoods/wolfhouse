'use strict';

/**
 * Staff booking-calendar chrome: sunset fonts, stacked banner tools, no owner-schedule legend.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const start = api.indexOf('staff-portal-calendar:sunset-fonts');
assert.ok(start > 0, 'sunset-fonts marker');
const chunk = api.slice(start, start + 1800);
assert.match(chunk, /#tab-bed-calendar \*/);
assert.match(chunk, /Instrument Sans/);
assert.match(chunk, /bc-legend-sw-owner_schedule_blocked/);
assert.match(api, /#tab-bed-calendar \.bc-block\{font-size:13px/);
assert.match(api, /id="bc-legend"/);
assert.doesNotMatch(api, /id="bc-legend"[\s\S]{0,800}calendar\.legend\.ownerScheduleBlocked/);
assert.match(api, /t\('calendar\.legend\.ownerScheduleBlocked'\)/);

assert.match(api, /staff-portal-calendar:block-fonts/);
assert.match(api, /staff-portal-calendar:drawer-fonts/);
assert.match(api, /\.book-ui \.bc-block-label[\s\S]{0,400}Instrument Sans/);
assert.match(api, /#tab-bed-calendar \.bc-drawer-tab/);
assert.match(api, /\.btn-logout\{[^}]*font-family:'Instrument Sans'/);
assert.doesNotMatch(api, /\.btn-logout\{[^}]*Iowan Old Style/);

assert.match(api, /class="banner-tools-row"/);
assert.match(api, /\.luna-header-ui \.banner-tools\{[\s\S]{0,80}flex-direction:column/);
assert.match(api, /id="staff-theme-toggle"/);
assert.match(api, /id="btn-logout"/);
assert.match(api, /id="staff-lang-switch"/);
const tools = api.slice(api.indexOf('id="banner-tools"'), api.indexOf('id="banner-tools"') + 2500);
assert.ok(tools.indexOf('id="staff-theme-toggle"') < tools.indexOf('id="btn-logout"'));
assert.ok(tools.indexOf('id="btn-logout"') < tools.indexOf('id="staff-lang-switch"'));

console.log('PASS staff-calendar-chrome: fonts + stacked banner + no owner-schedule legend');
