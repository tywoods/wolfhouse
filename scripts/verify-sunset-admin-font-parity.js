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
check('Admin tab uses shared sans family', /#tab-admin\{[^}]*font-family:var\(--font-sans\)/.test(css));
check('Admin form controls use shared sans family', /#tab-admin input,#tab-admin textarea,#tab-admin select\{font-family:var\(--font-sans\)/.test(css));
check('Admin school heading uses shared display family', /\.portal-admin-school-heading\{[^}]*font-family:var\(--font-display\)/.test(css));
check('Group course titles use shared display family', /#tab-admin \.portal-admin-pack-title[^}]*font-family:var\(--font-display\)/.test(css));
check('Private lesson titles use shared display family', /#tab-admin \.portal-admin-lesson-title[^}]*font-family:var\(--font-display\)/.test(css));
check('Admin section labels use shared sans family', /#tab-admin \.portal-admin-section-hdr[^}]*font-family:var\(--font-sans\)/.test(css));
check('Rental periods and amounts inherit Admin sans', !/\.portal-admin-price-(?:period|amount)\{[^}]*font-family:(?!var\(--font-sans\))/.test(css));
check('Admin no longer declares legacy admin serif', !/(--admin-serif|var\(--admin-serif)/.test(css));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
