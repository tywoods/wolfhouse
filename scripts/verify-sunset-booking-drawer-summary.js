'use strict';

/**
 * verify:sunset-booking-drawer-summary
 *
 * Offline checks for Sunset booking drawer header + view-mode summary cleanup.
 * Static source assertions only — no Staff API, DB, or network.
 *
 * Run:
 *   node scripts/verify-sunset-booking-drawer-summary.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STAFF_API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const VIEW_MODULE_PATH = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-view-ui.js');
const I18N_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js');
const I18N_ES_SUNSET_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es-sunset.js');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

function fnBody(src, name) {
  const re = new RegExp('function ' + name + '\\([^)]*\\)\\{');
  const m = re.exec(src);
  if (!m) return '';
  let i = m.index + m[0].length - 1;
  let depth = 0;
  let started = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') {
      depth--;
      if (started && depth === 0) return src.slice(m.index, i + 1);
    }
  }
  return '';
}

console.log('\nverify:sunset-booking-drawer-summary — drawer header + summary checks\n');

const apiSrc = fs.existsSync(STAFF_API_PATH) ? fs.readFileSync(STAFF_API_PATH, 'utf8') : '';
const viewModSrc = fs.existsSync(VIEW_MODULE_PATH) ? fs.readFileSync(VIEW_MODULE_PATH, 'utf8') : '';
const drawerSrc = viewModSrc || apiSrc;
const i18nSrc = fs.existsSync(I18N_PATH) ? fs.readFileSync(I18N_PATH, 'utf8') : '';
const i18nEsSrc = fs.existsSync(I18N_ES_SUNSET_PATH) ? fs.readFileSync(I18N_ES_SUNSET_PATH, 'utf8') : '';

console.log('[1] Hero + view summary helpers');

assert('scheduleRenderDrawerHeroMetadataLine helper', drawerSrc.includes('function scheduleRenderDrawerHeroMetadataLine('));
assert('scheduleRenderDrawerViewBookingDetailsHtml helper', drawerSrc.includes('function scheduleRenderDrawerViewBookingDetailsHtml('));
assert('scheduleRenderDrawerViewDateRow helper', drawerSrc.includes('function scheduleRenderDrawerViewDateRow('));
assert('scheduleRenderDrawerBookedItemsRow helper', drawerSrc.includes('function scheduleRenderDrawerBookedItemsRow('));
assert('scheduleDrawerSameDay helper', drawerSrc.includes('function scheduleDrawerSameDay('));
assert('hero metadata CSS class', apiSrc.includes('portal-schedule-drawer-hero-meta'));
assert('hero title CSS class', apiSrc.includes('portal-schedule-drawer-hero-title'));
assert('icon close button class', apiSrc.includes('portal-schedule-drawer-close-btn'));

console.log('\n[2] View mode — no duplicate guest/source; dates + booked items');

const viewFn = fnBody(drawerSrc, 'scheduleRenderViewDrawerHtml');
const viewDetailsFn = fnBody(drawerSrc, 'scheduleRenderDrawerViewBookingDetailsHtml');
const dateRowFn = fnBody(drawerSrc, 'scheduleRenderDrawerViewDateRow');
const sunsetDetailsBranch = (function () {
  const marker = 'if (!isSunsetSurfActive())';
  const idx = viewDetailsFn.indexOf(marker);
  if (idx < 0) return '';
  const tail = viewDetailsFn.slice(idx + marker.length);
  const ret = tail.match(/\}\s*return\s+([\s\S]+);\s*\}$/);
  return ret ? ret[1] : '';
})();

assert('view drawer uses booking details helper', viewFn.includes('scheduleRenderDrawerViewBookingDetailsHtml(ctx, row)'));
assert('view details omit guest name row (Sunset branch)', !sunsetDetailsBranch.includes("portalT('schedule.create.guestName')"));
assert('view details omit source row (Sunset branch)', !sunsetDetailsBranch.includes("portalT('schedule.drawer.source')"));
assert('view details show phone', viewDetailsFn.includes("portalT('schedule.drawer.phone')"));
assert('view details include booked items row', viewDetailsFn.includes('scheduleRenderDrawerBookedItemsRow'));
assert('booked items uses scheduleFormatComponentsView', drawerSrc.includes('scheduleFormatComponentsView(comps)'));
assert('same-day date label key', dateRowFn.includes("'schedule.create.date'"));
assert('multi-day dates label key', dateRowFn.includes("'schedule.drawer.section.dates'"));
assert('same-day uses scheduleDrawerSameDay', dateRowFn.includes('scheduleDrawerSameDay(ctx)'));

console.log('\n[3] Hero — metadata line + accessible controls');

const heroFn = fnBody(drawerSrc, 'scheduleRenderDrawerHeroHtml');
assert('hero metadata line removed from Sunset hero', !heroFn.includes('portal-schedule-drawer-hero-meta'));
assert('hero school in metadata via scheduleResolveDrawerSchoolLabel', apiSrc.includes('scheduleResolveDrawerSchoolLabel(ctx, row)'));
assert('hero source in metadata via scheduleRowSourceDrawerLabel', apiSrc.includes('scheduleRowSourceDrawerLabel(row)'));
assert('refresh retains aria-label', heroFn.includes('id="ps-drawer-refresh"') && heroFn.includes('aria-label'));
assert('close retains aria-label (Sunset icon)', heroFn.includes('id="ps-drawer-close"') && heroFn.includes('aria-label'));
assert('close retains title', heroFn.includes('schedule.drawer.close'));
assert('booking code subdued class', heroFn.includes('portal-schedule-drawer-booking-code-subtle'));

console.log('\n[4] Preserved drawer IDs + Wolfhouse fallback');

assert('ps-drawer-refresh id preserved', (drawerSrc + apiSrc).includes('id="ps-drawer-refresh"'));
assert('ps-drawer-close id preserved', (drawerSrc + apiSrc).includes('id="ps-drawer-close"'));
assert('ps-drawer-edit id preserved', (drawerSrc + apiSrc).includes('id="ps-drawer-edit"'));
assert('ps-drawer-conversation-btn id preserved', apiSrc.includes('id="ps-drawer-conversation-btn"'));
assert('non-Sunset view fallback keeps legacy rows', viewDetailsFn.includes('!isSunsetSurfActive()'));
assert('drawer-scoped mobile CSS', apiSrc.includes('@media(max-width:420px){.portal-schedule-drawer-hero-inner'));

console.log('\n[5] i18n — booked items EN/ES parity');

assert('EN bookedItems key', i18nSrc.includes("'schedule.drawer.bookedItems': 'Booked items'"));
assert('ES bookedItems key', i18nEsSrc.includes("'schedule.drawer.bookedItems'"));

console.log('\n[6] Redesigned money-first drawer');

const sunsetViewFn = fnBody(drawerSrc, 'scheduleRenderSunsetViewDrawerHtml');
const bookingCardFn = fnBody(drawerSrc, 'scheduleRenderSunsetBookingCardHtml');
const moneyCardFn = fnBody(drawerSrc, 'scheduleRenderSunsetMoneyCardHtml');
const recordFn = fnBody(drawerSrc, 'scheduleRenderSunsetRecordPaymentHtml');

assert('sunset view drawer helper exists', drawerSrc.includes('function scheduleRenderSunsetViewDrawerHtml('));
assert('money card helper exists', drawerSrc.includes('function scheduleRenderSunsetMoneyCardHtml('));
assert('booking card helper exists', drawerSrc.includes('function scheduleRenderSunsetBookingCardHtml('));
assert('view drawer branches to sunset renderer', drawerSrc.includes('if (isSunsetSurfActive()) return scheduleRenderSunsetViewDrawerHtml('));
assert('booking card rendered before money (owner reorder)', sunsetViewFn.indexOf('scheduleRenderSunsetBookingCardHtml(') > -1 &&
  sunsetViewFn.indexOf('scheduleRenderSunsetBookingCardHtml(') < sunsetViewFn.indexOf('scheduleRenderDrawerPaymentSectionHtml(ctx)'));
const payModSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-payment-ui.js'), 'utf8');
const waiverModSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-waiver-ui.js'), 'utf8');
assert('payment section delegates to view module', payModSrc.includes('scheduleRenderDrawerPaymentSectionViewHtml'));
assert('payment section delegates to edit module', payModSrc.includes('scheduleRenderDrawerPaymentSectionEditHtml'));
assert('date-strip helper exists', drawerSrc.includes('function scheduleDrawerStripLabelDate('));
assert('daily rows strip the ISO date', bookingCardFn.includes('scheduleDrawerStripLabelDate(li.label)'));
assert('drawer daily labels come from compact lineItemLabel', fs.existsSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-drawer.js'))
  && fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-drawer.js'), 'utf8').includes('formatSunsetDrawerDailyItemLabel'));
assert('record-payment collapsible keeps manual IDs', recordFn.includes('id="ps-drawer-manual-submit"') && recordFn.includes('id="ps-drawer-manual-amount"'));
assert('money card preserves payment-box id', moneyCardFn.includes('id="ps-drawer-payment-box"'));
assert('money card keeps stripe copy/delete ids', drawerSrc.includes("'ps-drawer-stripe-copy'") && drawerSrc.includes('id="ps-drawer-stripe-delete"'));
assert('progress bar for group waiver', waiverModSrc.includes('ps-reg-progress-bar'));

console.log('\n[6b] Sunset booking-context overview order');

const bcDrawerFn = fnBody(apiSrc, 'renderBookingContextDrawer');
const bcPayIdx = bcDrawerFn.indexOf('bcRenderPaymentSummaryBriefHtml');
const bcCardIdx = bcDrawerFn.indexOf('bc-drawer-card-booking');
assert('Sunset booking-context payment summary precedes booking card',
  bcDrawerFn.includes("var isSunset = getClient() === 'sunset'") &&
  bcDrawerFn.includes('if (isSunset) {') &&
  bcDrawerFn.includes('if (!isSunset) {') &&
  bcPayIdx > -1 && bcCardIdx > -1 && bcPayIdx < bcCardIdx);
assert('non-Sunset booking-context keeps payment summary after booking card',
  bcDrawerFn.lastIndexOf('bcRenderPaymentSummaryBriefHtml') > bcCardIdx);

console.log('\n[7] i18n — redesign keys EN/ES parity');
['schedule.drawer.paidInFull', 'schedule.drawer.createPaymentLink', 'schedule.drawer.copyPaymentLink', 'schedule.drawer.recordPayment', 'schedule.drawer.showDaily', 'schedule.drawer.daysWord'].forEach(function (k) {
  assert('EN key ' + k, i18nSrc.includes("'" + k + "'"));
  assert('ES key ' + k, i18nEsSrc.includes("'" + k + "'"));
});

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-booking-drawer-summary — FAILED');
  process.exit(1);
}
console.log('verify:sunset-booking-drawer-summary — ALL CHECKS PASSED');
