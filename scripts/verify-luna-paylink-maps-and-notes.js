'use strict';

/**
 * LUNA-PAYLINK-MAPS-AND-NOTES
 *
 * Sunset booking card: Notes under invoice, above safety/registration form.
 * Pay-link controls stay mapped inside the invoice card.
 *
 * Run: node scripts/verify-luna-paylink-maps-and-notes.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VIEW = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-view-ui.js');
const viewSrc = fs.readFileSync(VIEW, 'utf8');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail ? `— ${detail}` : '');
  }
}

function fnBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const rest = src.slice(start);
  const after = rest.indexOf('\nfunction ', 1);
  return after > 0 ? rest.slice(0, after) : rest.slice(0, 8000);
}

console.log('verify:luna-paylink-maps-and-notes\n');

const sunsetViewFn = fnBody(viewSrc, 'scheduleRenderSunsetViewDrawerHtml');
const invoiceCardFn = fnBody(viewSrc, 'scheduleRenderSunsetInvoiceCardHtml');

const inv = sunsetViewFn.indexOf('scheduleRenderSunsetInvoiceCardHtml');
const notes = sunsetViewFn.indexOf('schedule.drawer.section.notes');
const waiver = sunsetViewFn.indexOf('scheduleRenderDrawerWaiverSectionHtml');
const moneyInInvoice = invoiceCardFn.indexOf('scheduleRenderSunsetMoneyActionsHtml');
const recordInInvoice = invoiceCardFn.indexOf('scheduleRenderSunsetRecordPaymentHtml');

ok('sunset view owns invoice + notes + waiver', inv >= 0 && notes >= 0 && waiver >= 0);
ok('notes after invoice', notes > inv);
ok('waiver / safety form after notes', waiver > notes);
ok('pay-link actions live in invoice card', moneyInInvoice >= 0);
ok('pay-link actions not duplicated after invoice', sunsetViewFn.indexOf('scheduleRenderSunsetMoneyActionsHtml') < 0);
ok('record-payment stays inside invoice card', recordInInvoice > moneyInInvoice);
ok('invoice card closes after pay-link + record payment',
  invoiceCardFn.lastIndexOf("html += '</div>'") > recordInInvoice);

console.log('\n────────────────────────────────────────────────');
if (fail === 0) {
  console.log(`Results: ${pass} passed, ${fail} failed`);
  console.log('verify:luna-paylink-maps-and-notes — ALL CHECKS PASSED\n');
  process.exit(0);
}
console.error(`Results: ${pass} passed, ${fail} failed`);
console.error('verify:luna-paylink-maps-and-notes — FAILED\n');
process.exit(1);
