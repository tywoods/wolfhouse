'use strict';

/**
 * LUNA-PAYLINK-MAPS-AND-NOTES + view-card Notes visibility
 *
 * Sunset booking card: Notes under invoice, above safety/registration form.
 * Notes chrome is always present on view (not Edit-only). Drawer context
 * resolves notes from booking.metadata.notes (notes-only Edit) then services.
 *
 * Run: node scripts/verify-luna-paylink-maps-and-notes.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VIEW = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-view-ui.js');
const DRAWER_LIB = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-booking-drawer.js');
const I18N = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js');
const I18N_ES = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es-sunset.js');

const viewSrc = fs.readFileSync(VIEW, 'utf8');
const drawerLibSrc = fs.readFileSync(DRAWER_LIB, 'utf8');
const i18nSrc = fs.readFileSync(I18N, 'utf8');
const i18nEsSrc = fs.readFileSync(I18N_ES, 'utf8');

const {
  resolveDrawerNotesFromBundle,
} = require('./lib/sunset-schedule-booking-drawer');

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
const notesSectionFn = fnBody(viewSrc, 'scheduleRenderSunsetViewNotesSectionHtml');
const invoiceCardFn = fnBody(viewSrc, 'scheduleRenderSunsetInvoiceCardHtml');

const inv = sunsetViewFn.indexOf('scheduleRenderSunsetInvoiceCardHtml');
const notes = sunsetViewFn.indexOf('scheduleRenderSunsetViewNotesSectionHtml');
const notesLegacy = sunsetViewFn.indexOf('schedule.drawer.section.notes');
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

console.log('\n[view Notes chrome — always visible]\n');

ok('view notes helper exists', notesSectionFn.includes('schedule.drawer.section.notes'));
ok('view notes not gated on ctx.notes truthiness',
  !/if\s*\(\s*ctx\s*&&\s*ctx\.notes\s*\)/.test(sunsetViewFn)
  && !/if\s*\(\s*ctx\.notes\s*\)/.test(sunsetViewFn));
ok('view notes always mounted via helper',
  sunsetViewFn.includes('scheduleRenderSunsetViewNotesSectionHtml(ctx)')
  && notesLegacy < 0);
ok('view notes shows content when present',
  notesSectionFn.includes('ps-drawer-view-notes')
  && notesSectionFn.includes('escHtml(notes)'));
ok('view notes empty state when absent',
  notesSectionFn.includes('ps-drawer-view-notes-empty')
  && notesSectionFn.includes("portalT('schedule.drawer.notesEmpty')"));
ok('EN notesEmpty i18n', i18nSrc.includes("'schedule.drawer.notesEmpty': 'No notes yet.'"));
ok('ES notesEmpty i18n', i18nEsSrc.includes("'schedule.drawer.notesEmpty': 'Sin notas aún.'"));

console.log('\n[drawer context notes resolution]\n');

ok('resolver exported', typeof resolveDrawerNotesFromBundle === 'function');
ok('context body uses resolveDrawerNotesFromBundle',
  drawerLibSrc.includes('notes: resolveDrawerNotesFromBundle(bundle)'));
ok('notes-only edit syncs service metadata.notes',
  /pricingChanged[\s\S]{0,1200}jsonb_build_object\('notes'/.test(drawerLibSrc)
  || /Non-pricing[\s\S]{0,800}jsonb_build_object\('notes'/.test(drawerLibSrc));

ok('prefers booking.metadata.notes over empty services',
  resolveDrawerNotesFromBundle({
    booking: { metadata: { notes: 'From booking meta' } },
    services: [{ notes: null }, { notes: '' }],
  }) === 'From booking meta');
ok('falls back to first service notes when booking meta empty',
  resolveDrawerNotesFromBundle({
    booking: { metadata: {} },
    services: [{ notes: null }, { notes: 'Service note' }],
  }) === 'Service note');
ok('booking meta wins over stale service notes',
  resolveDrawerNotesFromBundle({
    booking: { metadata: { notes: 'Updated note' } },
    services: [{ notes: 'Stale service note' }],
  }) === 'Updated note');
ok('returns null when nowhere',
  resolveDrawerNotesFromBundle({
    booking: { metadata: { notes: '  ' } },
    services: [{ notes: null }],
  }) === null);

console.log('\n────────────────────────────────────────────────');
if (fail === 0) {
  console.log(`Results: ${pass} passed, ${fail} failed`);
  console.log('verify:luna-paylink-maps-and-notes — ALL CHECKS PASSED\n');
  process.exit(0);
}
console.error(`Results: ${pass} passed, ${fail} failed`);
console.error('verify:luna-paylink-maps-and-notes — FAILED\n');
process.exit(1);
