'use strict';

/**
 * verify:sunset-booking-drawer-summary — extended UX redesign checks
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STAFF_API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
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

console.log('\nverify:sunset-booking-drawer-summary — drawer UX redesign checks\n');

const apiSrc = fs.existsSync(STAFF_API_PATH) ? fs.readFileSync(STAFF_API_PATH, 'utf8') : '';
const i18nSrc = fs.existsSync(I18N_PATH) ? fs.readFileSync(I18N_PATH, 'utf8') : '';
const i18nEsSrc = fs.existsSync(I18N_ES_SUNSET_PATH) ? fs.readFileSync(I18N_ES_SUNSET_PATH, 'utf8') : '';

const viewFn = fnBody(apiSrc, 'scheduleRenderViewDrawerHtml');
const viewDetailsFn = fnBody(apiSrc, 'scheduleRenderDrawerViewBookingDetailsHtml');
const heroFn = fnBody(apiSrc, 'scheduleRenderDrawerHeroHtml');
const bookedFn = fnBody(apiSrc, 'scheduleRenderDrawerBookedItemsHtml');
const sunsetPayFn = fnBody(apiSrc, 'scheduleRenderSunsetDrawerPaymentSectionHtml');
const sunsetDetailsBranch = (function () {
  const marker = 'if (!isSunsetSurfActive())';
  const idx = viewDetailsFn.indexOf(marker);
  if (idx < 0) return '';
  const tail = viewDetailsFn.slice(idx + marker.length);
  const ret = tail.match(/\}\s*return\s+([\s\S]+);\s*\}$/);
  return ret ? ret[1] : '';
})();

console.log('[1] Information hierarchy');

assert('phone in hero via scheduleRenderDrawerHeroPhoneHtml', heroFn.includes('scheduleRenderDrawerHeroPhoneHtml(ctx)'));
assert('phone not in Sunset booking card branch', !sunsetDetailsBranch.includes("portalT('schedule.drawer.phone')"));
assert('Sunset view uses booking code heading not section.booking key', viewFn.includes('heading: code') && viewFn.includes('scheduleDrawerSectionHtml(null, scheduleRenderDrawerViewBookingDetailsHtml'));
assert('booking code not duplicated in hero (Sunset)', !heroFn.includes('portal-schedule-drawer-booking-code-subtle'));
assert('copy booking code control', apiSrc.includes('id="ps-drawer-copy-code"'));
assert('pricing disclaimer sentence absent from Sunset payment render', !sunsetPayFn.includes("portalT('schedule.drawer.livePricingNote')"));
assert('pricing disclaimer string absent from rendered Sunset HTML path', !viewFn.includes('Totals use current Admin prices'));
assert('livePricingNote i18n exists but unused in Sunset payment', i18nSrc.includes("'schedule.drawer.livePricingNote'"));

console.log('\n[2] Booked items by date');

assert('scheduleDrawerGroupLineItemsByDate helper', apiSrc.includes('function scheduleDrawerGroupLineItemsByDate('));
assert('scheduleDrawerCompactDateHeading helper', apiSrc.includes('function scheduleDrawerCompactDateHeading('));
assert('date group CSS class', apiSrc.includes('portal-schedule-drawer-date-group'));
assert('date heading CSS class', apiSrc.includes('portal-schedule-drawer-date-heading'));
assert('booked items grouped by date in renderer', bookedFn.includes('scheduleDrawerGroupLineItemsByDate(lineItems)'));
assert('undated fallback group', bookedFn.includes("portalT('schedule.drawer.otherItems')"));
assert('row display strips ISO dates from labels', bookedFn.includes('scheduleDrawerParseBookedItemDisplay(li)') && apiSrc.includes("parts = parts.filter(function(p){ return !/^\\d{4}-\\d{2}-\\d{2}$/.test(p); })"));
assert('no flat li.label dump in Sunset line_items branch', !bookedFn.includes('escHtml(li.label)'));

console.log('\n[3] Drawer mechanics — scroll ownership');

assert('drawer shell uses 100dvh', apiSrc.includes('height:100dvh;max-height:100dvh'));
assert('Sunset #ps-drawer-body flex column min-height 0', apiSrc.includes('portal-schedule-drawer-sunset #ps-drawer-body'));
assert('scroll region min-height 0 overflow-y auto', apiSrc.includes('flex:1 1 auto;min-height:0;overflow-y:auto'));
assert('fixed header region', apiSrc.includes('portal-schedule-drawer-header'));
assert('header outside scroll in Sunset view', viewFn.includes("'<header class=\"portal-schedule-drawer-header\">'"));
assert('scroll-end padding spacer', apiSrc.includes('portal-schedule-drawer-scroll-endpad'));
assert('footer safe-area padding', apiSrc.includes('env(safe-area-inset-bottom'));
assert('scroll lock on open', apiSrc.includes('scheduleLockDrawerPageScroll()'));
assert('scroll unlock on close', apiSrc.includes('scheduleUnlockDrawerPageScroll()'));
assert('no horizontal overflow on scroll', apiSrc.includes('overflow-x:hidden'));

console.log('\n[4] Actions — placement and button levels');

assert('footer primary Edit booking', viewFn.includes('btn btn-primary" id="ps-drawer-edit"'));
assert('footer secondary Start conversation', viewFn.includes('btn btn-secondary" id="ps-drawer-conversation-btn"'));
assert('open customer quiet tertiary', apiSrc.includes('btn btn-quiet" id="ps-drawer-open-customer"'));
assert('close in header with 44px target', apiSrc.includes('min-width:44px;min-height:44px'));
assert('refresh quiet in header', apiSrc.includes('portal-schedule-refresh-btn'));
assert('stripe actions in payment section', fnBody(apiSrc, 'scheduleRenderSunsetDrawerStripeHtml').includes('ps-drawer-stripe-link'));
assert('waiver actions in waiver section', fnBody(apiSrc, 'scheduleRenderSunsetWaiverBoxInner').includes('ps-drawer-waiver-copy'));
assert('dialog role on drawer shell', apiSrc.includes('role="dialog"'));
assert('accessible guest title id', apiSrc.includes('id="ps-drawer-guest-title"'));

console.log('\n[5] Preserved IDs + Wolfhouse fallback');

assert('ps-drawer-refresh id preserved', apiSrc.includes('id="ps-drawer-refresh"'));
assert('ps-drawer-close id preserved', apiSrc.includes('id="ps-drawer-close"'));
assert('ps-drawer-edit id preserved', apiSrc.includes('id="ps-drawer-edit"'));
assert('ps-drawer-conversation-btn id preserved', apiSrc.includes('id="ps-drawer-conversation-btn"'));
assert('ps-drawer-stripe-link id preserved', apiSrc.includes('id="ps-drawer-stripe-link"'));
assert('ps-drawer-stripe-copy id preserved', apiSrc.includes('id="ps-drawer-stripe-copy"'));
assert('ps-drawer-stripe-delete id preserved', apiSrc.includes('id="ps-drawer-stripe-delete"'));
assert('ps-drawer-manual-submit id preserved', apiSrc.includes('id="ps-drawer-manual-submit"'));
assert('non-Sunset view keeps legacy section.booking', viewFn.includes("scheduleDrawerSectionHtml('schedule.drawer.section.booking'"));
assert('non-Sunset payment keeps legacy totals', fnBody(apiSrc, 'scheduleRenderDrawerPaymentSectionHtml').includes("portalT('schedule.drawer.remaining')"));

console.log('\n[6] i18n — EN/ES parity');

assert('EN otherItems key', i18nSrc.includes("'schedule.drawer.otherItems'"));
assert('ES otherItems key', i18nEsSrc.includes("'schedule.drawer.otherItems'"));
assert('EN copyCode key', i18nSrc.includes("'schedule.drawer.copyCode'"));
assert('ES copyCode key', i18nEsSrc.includes("'schedule.drawer.copyCode'"));

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-booking-drawer-summary — FAILED');
  process.exit(1);
}
console.log('verify:sunset-booking-drawer-summary — ALL CHECKS PASSED');
