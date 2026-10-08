'use strict';

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
let pass = 0;
let fail = 0;
function check(label, ok) {
  if (ok) { console.log(`  PASS  ${label}`); pass++; }
  else { console.error(`  FAIL  ${label}`); fail++; }
}

console.log('\nverify:sunset-admin-font-parity\n');
const start = src.indexOf('.portal-admin-wrap{');
const end = src.indexOf('.portal-schedule-wrap{', start);
const css = start >= 0 && end > start ? src.slice(start, end) : '';

check('Admin CSS extractable', !!css);
check('global sans is Instrument Sans', /--font-sans:'Instrument Sans',system-ui,sans-serif/.test(src));
check('global display is Newsreader', /--font-display:'Newsreader',serif/.test(src));
check('Admin tab uses shared sans family', /#tab-admin,#tab-bookings\{font-family:var\(--font-sans\)/.test(css));
check('Admin form controls use shared sans family', /#tab-admin input,#tab-admin textarea,#tab-admin select,[\s\S]*#tab-bookings textarea,#tab-bookings select\{font-family:var\(--font-sans\)/.test(css));
check('Admin defines one Email-style heading token', /#tab-admin\{--admin-heading-font:var\(--font-sans\);--admin-heading-size:18px;--admin-heading-weight:700;--admin-heading-transform:none;--admin-heading-spacing:-\.02em\}/.test(css));
check('Admin card titles consume the shared heading token', /#tab-admin \.portal-admin-title,[\s\S]*#tab-admin \.bc-op-title\{[\s\S]*font-family:var\(--admin-heading-font\)/.test(css));
check('Admin disclosure headings consume the shared heading token', /#tab-admin \.staff-collapse-toggle\.portal-admin-section-hdr\{[^}]*font-family:var\(--admin-heading-font\)/.test(src));
check('Email card titles consume the shared heading token', /\.portal-admin-email-card-title\{[^}]*font-family:var\(--admin-heading-font/.test(css));
check('Camps uses Instrument Sans instead of a device serif', /#tab-services\{font-family:var\(--font-sans\)/.test(css) && !/--svc-serif/.test(css));
check('General Notes textarea uses the 13px body token', /#hn-text\{font-size:13px\}/.test(src));
check('Room Setup buttons use semibold', /#staff-room-fill button\{font:inherit;font-size:12px;font-weight:600/.test(fs.readFileSync(path.join(__dirname, 'browser', 'staff-room-fill.js'), 'utf8')));
check('Finance display type remains available for KPI figures', /\.pfb-range-label\{[^}]*font-family:var\(--font-display,var\(--font-sans\)\)/.test(src));
check('Rental periods and amounts inherit Admin sans', !/\.portal-admin-price-(?:period|amount)\{[^}]*font-family:(?!var\(--font-sans\))/.test(css));
check('Admin no longer declares legacy admin serif', !/(--admin-serif|var\(--admin-serif)/.test(css));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
