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
assert.match(api, /#tab-bed-calendar \.bc-block-label\{font-size:12px;font-weight:700/);
assert.match(api, /#tab-bed-calendar \.bc-bed-cell\{[^}]*font-size:14px;font-weight:700;padding:4px 6px/);
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
assert.match(api, /\.luna-header-ui \.banner-actions\{/);
assert.match(api, /margin-right:4px;/);
assert.match(api, /--luna-banner-h:calc\(100vw \* 391 \/ 4016\)/);
assert.match(api, /background-size:100% 100%/);
assert.match(api, /\.luna-header-ui #tabs \.tab-btn\{[\s\S]{0,160}font-size:14\.5px/);
assert.match(api, /data-tab="bed-calendar"[\s\S]{0,400}data-i18n="nav\.tab\.portalHome">Schedule/);
assert.match(api, /data-tab="conversations"[\s\S]{0,400}data-i18n="nav\.tab\.inbox">Inbox/);
assert.match(api, /data-tab="bookings"><span class="tab-ico"/);
assert.match(api, /tab === 'bookings' && !profile\.is_surf_vertical && !portalIsLodgingAdmin/);
assert.match(api, /staff-portal-calendar:toolbar-row/);
assert.match(api, /#tab-bed-calendar \.toolbar h2\{flex:0 0 auto;order:1/);
assert.match(api, /#tab-bed-calendar \.bc-bed-cell\{padding:5px 14px\}/);
assert.match(api, /\.luna-header-ui\.luna-hdr-compact #banner \.brand-logo\{[\s\S]{0,40}display:none!important/);
assert.match(api, /\.luna-header-ui\.luna-hdr-compact #tabs\{[\s\S]{0,280}padding-left:clamp\(12px,1\.6vw,22px\)/);
assert.match(api, /staff-portal-calendar:side-drawer/);
assert.match(api, /id="bc-side-drawer"/);
assert.match(api, /id="bc-detail"/);
assert.match(api, /id="bc-sel-panel"/);
assert.match(api, /function bcInitSideDrawer/);
assert.match(api, /function bcOpenSideBooking/);
assert.match(api, /function bcDockCreatePanel/);
assert.match(api, /function bcSideHoverEnter/);
assert.match(api, /id="bc-side-pin"/);
assert.match(api, /opts\.host \|\| el\('bc-ctx-body'\)/);
assert.match(api, /function bcUpdateCalendarTitle/);
assert.match(api, /month: 'long'/);
assert.doesNotMatch(api, /t\('calendar\.title'\) \+ ' - '/);
assert.match(api, /\.luna-header-ui \.banner-tools\{/);
assert.match(api, /id="staff-theme-toggle"/);
assert.match(api, /id="btn-logout"/);
assert.match(api, /id="staff-lang-switch"/);
const tools = api.slice(api.indexOf('id="banner-tools"'), api.indexOf('id="banner-tools"') + 2500);
assert.ok(tools.indexOf('id="staff-theme-toggle"') < tools.indexOf('id="btn-logout"'));
assert.ok(tools.indexOf('id="btn-logout"') < tools.indexOf('id="staff-lang-switch"'));

console.log('PASS staff-calendar-chrome: fonts + stacked banner + no owner-schedule legend');
