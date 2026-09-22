#!/usr/bin/env node
'use strict';

/**
 * GINA-BOOKING-DISPLAY-001
 * Booking drawer shows Gina, Jamie, and Tina with their beds, and services
 * as 3×. No shaka. Display only — no money math.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const invoiceSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/service-record-invoice-line.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log('  PASS  ' + label);
    pass += 1;
    return;
  }
  console.error('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
  fail += 1;
}

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

console.log('\nverify-gina-booking-display-001\n');

ok('guest name+bed helper exists', apiSrc.includes('function bcGuestNameBedDisplayHtml('));
ok('services qty label helper exists', apiSrc.includes('function bcBookingServicesQtyLabel('));
ok('drawer uses name+bed helper', apiSrc.includes('bcGuestNameBedDisplayHtml((data && data.booking_guests)'));
ok('drawer uses services qty label', apiSrc.includes('bcBookingServicesQtyLabel((data && data.service_records)'));
ok('portal booking display has no shaka', !apiSrc.includes('free with board 🤙'));
ok('invoice line display has no shaka', !invoiceSrc.includes('🤙'));
ok('name line stays name-only for the editor', apiSrc.includes("'<span class=\"bc-guest-name-line\">' + escHtml(name)"));
ok('helper does not print money', !/deposit_amount_cents|amount_paid_cents|stripe/i.test(extractFunction(apiSrc, 'bcGuestNameBedDisplayHtml') + extractFunction(apiSrc, 'bcBookingServicesQtyLabel')));

const sandbox = {
  escHtml: (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;'),
  bcPluralUnit: (count, singular, plural) => (Number(count) === 1 ? singular : plural),
};
vm.createContext(sandbox);
vm.runInContext(
  [
    extractFunction(apiSrc, 'bcFormatRentalPeopleDaysLine'),
    extractFunction(apiSrc, 'bcGuestNameBedDisplayHtml'),
    extractFunction(apiSrc, 'bcBookingServicesQtyLabel'),
  ].join('\n'),
  sandbox,
);

const html = sandbox.bcGuestNameBedDisplayHtml([
  { guest_number: 2, guest_name: 'Jamie', assigned_bed_code: 'B2' },
  { guest_number: 3, guest_name: 'Tina', assigned_bed_code: 'B3' },
  { guest_number: 1, guest_name: 'Gina', assigned_bed_code: 'B1' },
], 'Gina');

ok('Gina leads', html.indexOf('Gina') >= 0 && html.indexOf('Gina') < html.indexOf('Jamie') && html.indexOf('Gina') < html.indexOf('Tina'), html);
ok('Jamie and Tina names', html.includes('Jamie') && html.includes('Tina'));
ok('beds B1 B2 B3', html.includes('>B1<') && html.includes('>B2<') && html.includes('>B3<'));
ok('name span is the name only', /<span class="bc-guest-name-line">Gina<\/span>/.test(html));
ok('no shaka in party html', !html.includes('🤙'));

const services = sandbox.bcBookingServicesQtyLabel([
  { service_type: 'surf_lesson', quantity: 1, metadata: { service_name: 'Surf lesson' } },
  { service_type: 'surf_lesson', quantity: 1, metadata: { service_name: 'Surf lesson' } },
  { service_type: 'surf_lesson', quantity: 1, metadata: { service_name: 'Surf lesson 🤙' } },
]);
ok('3× services', services === '3× Surf lesson', services);
ok('services drop shaka', !services.includes('🤙'));

const freeLine = sandbox.bcFormatRentalPeopleDaysLine('Wetsuit', 3, 1, 0, 'free with board 🤙');
ok('rental line shows a real times sign', freeLine.includes('×') && !freeLine.includes('\\u00d7'), freeLine);
ok('rental free note has no shaka', freeLine.includes('free with board') && !freeLine.includes('🤙'), freeLine);
ok('rental line does not reprice a free note', !/€/.test(freeLine), freeLine);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
