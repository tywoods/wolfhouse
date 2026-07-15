'use strict';

/**
 * verify:sunset-schedule-portal-module
 *
 * Slice 11 — Schedule portal canonical API/data layer gate.
 *
 * Run:
 *   node scripts/verify-sunset-schedule-portal-module.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PORTAL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-portal-module.js');
const DRAWER_SERVER = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-booking-drawer.js');
const BROWSER_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-browser-source.js');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

function extractFunctionSource(src, name) {
  const needle = `function ${name}(`;
  const start = src.indexOf(needle);
  if (start < 0) return null;
  const braceStart = src.indexOf('{', start);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

console.log('\nverify:sunset-schedule-portal-module\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const modSrc = fs.readFileSync(PORTAL_MODULE, 'utf8');
const drawerSrc = fs.readFileSync(DRAWER_SERVER, 'utf8');
const browserLoader = fs.readFileSync(BROWSER_SRC, 'utf8');

console.log('[1] Module files and injection');
assert('portal module exists', fs.existsSync(PORTAL_MODULE));
assert('browser source loader exists', fs.existsSync(BROWSER_SRC));
assert('inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-portal-module */'));
assert('drawer view inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-drawer-view-ui */'));
assert('drawer edit inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-drawer-edit-ui */'));
assert('drawer payment inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-drawer-payment-ui */'));
assert('drawer waiver inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-drawer-waiver-ui */'));
assert('drawer delete inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-drawer-delete-ui */'));
assert('drawer controller inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-drawer-controller */'));
assert('day ops board inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-day-ops-board-ui */'));
assert('forecast cards inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-forecast-cards-ui */'));
assert('view grid inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-view-grid-ui */'));
assert('navigation inject marker in staff HTML script', apiSrc.includes('/* INJECT:sunset-schedule-navigation-ui */'));
assert('browser source loads forecast cards module', browserLoader.includes('getSunsetScheduleForecastCardsBrowserSource'));
assert('browser source loads view grid module', browserLoader.includes('getSunsetScheduleViewGridBrowserSource'));
assert('browser source loads navigation module', browserLoader.includes('getSunsetScheduleNavigationBrowserSource'));
assert('browser source loads drawer delete module', browserLoader.includes('getSunsetScheduleDrawerDeleteBrowserSource'));
assert('browser source loads drawer controller module', browserLoader.includes('getSunsetScheduleDrawerControllerBrowserSource'));
assert('browser source loads drawer waiver module', browserLoader.includes('getSunsetScheduleDrawerWaiverBrowserSource'));
assert('browser source loads drawer edit module', browserLoader.includes('getSunsetScheduleDrawerEditBrowserSource'));
assert('browser source loads drawer view module', browserLoader.includes('getSunsetScheduleDrawerViewBrowserSource'));
assert('injectSunsetSchedulePortalModule defined', browserLoader.includes('function injectSunsetSchedulePortalModule'));
assert('buildUiHtml calls inject', /injectSunsetSchedulePortalModule\(html\)/.test(apiSrc));
assert('create quote preview element', apiSrc.includes('id="ps-create-quote-preview"'));

console.log('\n[2] Canonical API endpoints in portal module');
assert('catalog fetch', modSrc.includes('/staff/schedule/bookings/catalog'));
assert('quote fetch', modSrc.includes('/staff/schedule/bookings/quote'));
assert('create fetch', modSrc.includes('/staff/schedule/bookings?'));
assert('detail fetch', modSrc.includes('/staff/schedule/bookings/detail'));
assert('payment-link fetch', modSrc.includes('/staff/schedule/bookings/payment-link'));
assert('quote provenance on create', modSrc.includes('quote_provenance'));
const submitCreateSrc = extractFunctionSource(modSrc, 'schedulePortalSubmitCreate') || '';
assert(
  'no client amount fields in create body builder',
  submitCreateSrc.length > 0
    && !submitCreateSrc.includes('amount_due_cents')
    && !/\btotal_cents\b/.test(submitCreateSrc.replace(/quote_provenance/g, ''))
);

console.log('\n[3] Luna + Staff drawer parity gates');
const rowRefSrc = extractFunctionSource(apiSrc, 'scheduleRowBookingRef');
const ctx = {
  __group: null,
  scheduleFindGroupForRow: function() { return ctx.__group; },
};
vm.createContext(ctx);
if (rowRefSrc) vm.runInContext(`${rowRefSrc}\nthis.scheduleRowBookingRef=scheduleRowBookingRef;`, ctx);
vm.createContext(ctx);
['scheduleDrawerTrustedPersistedSource', 'scheduleDrawerCanLoadCanonical', 'scheduleDrawerCanEdit'].forEach((name) => {
  const fnSrc = extractFunctionSource(modSrc, name);
  assert(`module defines ${name}`, !!fnSrc);
  if (fnSrc) vm.runInContext(`${fnSrc}\nthis.${name}=${name};`, ctx);
});

const STAFF_ROW = { _isDbManual: true, record_source: 'staff_manual', booking_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
const LUNA_ROW = { record_source: 'luna_guest', booking_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' };
const DEMO_ROW = { _isDemo: true, record_source: 'luna_guest', booking_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' };

ctx.__group = { records: [STAFF_ROW] };
assert('staff row loads canonical drawer', ctx.scheduleDrawerCanLoadCanonical(STAFF_ROW) === true);
ctx.__group = { records: [LUNA_ROW] };
assert('luna row loads canonical drawer', ctx.scheduleDrawerCanLoadCanonical(LUNA_ROW) === true);
assert('luna row editable in drawer', ctx.scheduleDrawerCanEdit(LUNA_ROW) === true);
assert('demo row blocked', ctx.scheduleDrawerCanLoadCanonical(DEMO_ROW) === false);

console.log('\n[4] Server drawer attribution (not Luna vs staff gate)');
assert('bundleHasTrustedScheduleDrawerAttribution', drawerSrc.includes('function bundleHasTrustedScheduleDrawerAttribution'));
assert('luna metadata allowed', /LUNA_METADATA_SOURCE_TAG/.test(drawerSrc));
assert('uses payment-link getPaymentStatus', drawerSrc.includes('getPaymentStatus'));
assert('legacy drawer_edits error removed from detail gate', !drawerSrc.includes('drawer_edits_limited_to_staff_manual_schedule'));

console.log('\n[5] No browser weekday price authority in create submit');
assert('submit uses quote API not scheduleCourseEligibleOnDates', modSrc.includes('schedulePortalFetchQuote') && !modSrc.includes('scheduleCourseEligibleOnDates'));
assert('populate courses uses eligible_on_requested_dates', modSrc.includes('eligible_on_requested_dates'));
assert('staff-api submitScheduleManualBooking removed', !/function submitScheduleManualBooking\s*\(/.test(apiSrc));
assert('scheduleCourseEligibleOnDates only compatibility wrapper', apiSrc.includes('function scheduleCourseEligibleOnDates('));

console.log('\n[6] Payment link display rules');
assert('schedulePortalStripeLinkFromCtx', modSrc.includes('function schedulePortalStripeLinkFromCtx'));
assert('invalidated links not actionable', modSrc.includes('payment_link_invalidated'));
assert('stripe section uses portal resolver', (function () {
  const payPath = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-payment-ui.js');
  const paySrc = fs.existsSync(payPath) ? fs.readFileSync(payPath, 'utf8') : '';
  return paySrc.includes('schedulePortalStripeLinkFromCtx');
})());

console.log(`\n── verify:sunset-schedule-portal-module ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
process.exit(fail ? 1 : 0);
