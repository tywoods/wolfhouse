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

console.log('\nverify:sunset-customers-font-parity\n');
const customersStart = src.indexOf('/* ── Customers tab');
const customersEnd = src.indexOf('/* Luna Staff (Ask Luna)', customersStart + 30);
const customersCss = customersStart >= 0
  ? src.slice(customersStart, customersEnd > customersStart ? customersEnd : customersStart + 24000)
  : '';

check('global sans is Instrument Sans', /--font-sans:'Instrument Sans',system-ui,sans-serif/.test(src));
check('global display is Newsreader', /--font-display:'Newsreader',serif/.test(src));
check('Schedule heading uses display family', /\.portal-schedule-range[\s\S]{0,500}font-family:var\(--font-display\)/.test(src));
check('Customers CSS extractable', !!customersCss);
check('Customers body uses shared sans family', /#tab-customers\{[^}]*font-family:var\(--font-sans\)/.test(customersCss));
check('Customers school heading uses shared display family', /\.customers-school-heading\{[^}]*font-family:var\(--font-display\)/.test(customersCss));
check('Customers form controls use shared sans family', /#tab-customers input,#tab-customers textarea,#tab-customers select\{font-family:var\(--font-sans\)/.test(customersCss));
check('Customers no longer declares legacy Iowan/Palatino serif', !/(Iowan Old Style|Palatino Linotype|Book Antiqua)/.test(customersCss));
check('Customers buttons inherit shared tab sans', /#tab-customers \.btn[^}]*font-family:inherit/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
