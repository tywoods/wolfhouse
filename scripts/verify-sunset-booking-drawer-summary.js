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
const i18nSrc = fs.existsSync(I18N_PATH) ? fs.readFileSync(I18N_PATH, 'utf8') : '';
const i18nEsSrc = fs.existsSync(I18N_ES_SUNSET_PATH) ? fs.readFileSync(I18N_ES_SUNSET_PATH, 'utf8') : '';

console.log('[1] Hero + view summary helpers');

assert('scheduleRenderDrawerHeroMetadataLine helper', apiSrc.includes('function scheduleRenderDrawerHeroMetadataLine('));
assert('scheduleRenderDrawerViewBookingDetailsHtml helper', apiSrc.includes('function scheduleRenderDrawerViewBookingDetailsHtml('));
assert('scheduleRenderDrawerViewDateRow helper', apiSrc.includes('function scheduleRenderDrawerViewDateRow('));
assert('scheduleRenderDrawerBookedItemsHtml helper', apiSrc.includes('function scheduleRenderDrawerBookedItemsHtml('));
assert('scheduleDrawerSameDay helper', apiSrc.includes('function scheduleDrawerSameDay('));
assert('hero metadata CSS class', apiSrc.includes('portal-schedule-drawer-hero-meta'));
assert('hero title CSS class', apiSrc.includes('portal-schedule-drawer-hero-title'));
assert('icon close button class', apiSrc.includes('portal-schedule-drawer-close-btn'));
assert('booked items list CSS class', apiSrc.includes('portal-schedule-drawer-booked-list'));
assert('compact section CSS class', apiSrc.includes('portal-schedule-drawer-section-compact'));

console.log('\n[2] View mode — no duplicate guest/source/dates; scannable booked items');

const viewFn = fnBody(apiSrc, 'scheduleRenderViewDrawerHtml');
const viewDetailsFn = fnBody(apiSrc, 'scheduleRenderDrawerViewBookingDetailsHtml');
const dateRowFn = fnBody(apiSrc, 'scheduleRenderDrawerViewDateRow');
const sunsetDetailsBranch = (function () {
  const marker = 'if (!isSunsetSurfActive())';
  const idx = viewDetailsFn.indexOf(marker);
  if (idx < 0) return '';
  const tail = viewDetailsFn.slice(idx + marker.length);
  const ret = tail.match(/\}\s*return\s+([\s\S]+);\s*\}$/);
  return ret ? ret[1] : '';
})();

assert('view drawer uses booking details helper', viewFn.includes('scheduleRenderDrawerViewBookingDetailsHtml(ctx, row)'));
assert('view drawer uses compact section for Sunset', viewFn.includes('compact: true'));
assert('view details omit guest name row (Sunset branch)', !sunsetDetailsBranch.includes("portalT('schedule.create.guestName')"));
assert('view details omit source row (Sunset branch)', !sunsetDetailsBranch.includes("portalT('schedule.drawer.source')"));
assert('view details omit date row (Sunset branch)', !sunsetDetailsBranch.includes('scheduleRenderDrawerViewDateRow'));
assert('view details show phone', viewDetailsFn.includes("portalT('schedule.drawer.phone')"));
assert('view details include booked items list', viewDetailsFn.includes('scheduleRenderDrawerBookedItemsHtml'));
assert('booked items render as list markup', apiSrc.includes('portal-schedule-drawer-booked-list'));
assert('same-day date label key (hero metadata)', dateRowFn.includes("'schedule.create.date'"));
assert('multi-day dates label key (hero metadata)', dateRowFn.includes("'schedule.drawer.section.dates'"));
assert('same-day uses scheduleDrawerSameDay', dateRowFn.includes('scheduleDrawerSameDay(ctx)'));

console.log('\n[3] Hero — metadata line + accessible controls');

const heroFn = fnBody(apiSrc, 'scheduleRenderDrawerHeroHtml');
assert('hero metadata line helper used', heroFn.includes('scheduleRenderDrawerHeroMetadataLine(ctx, row)'));
assert('hero school in metadata via scheduleResolveDrawerSchoolLabel', apiSrc.includes('scheduleResolveDrawerSchoolLabel(ctx, row)'));
assert('hero source in metadata via scheduleRowSourceDrawerLabel', apiSrc.includes('scheduleRowSourceDrawerLabel(row)'));
assert('refresh retains aria-label', heroFn.includes('id="ps-drawer-refresh"') && heroFn.includes('aria-label'));
assert('close retains aria-label (Sunset icon)', heroFn.includes('id="ps-drawer-close"') && heroFn.includes('aria-label'));
assert('close retains title', heroFn.includes('schedule.drawer.close'));
assert('booking code subdued class', heroFn.includes('portal-schedule-drawer-booking-code-subtle'));
assert('hero title line-clamp CSS', apiSrc.includes('-webkit-line-clamp:2'));

console.log('\n[4] Preserved drawer IDs + Wolfhouse fallback');

assert('ps-drawer-refresh id preserved', apiSrc.includes('id="ps-drawer-refresh"'));
assert('ps-drawer-close id preserved', apiSrc.includes('id="ps-drawer-close"'));
assert('ps-drawer-edit id preserved', apiSrc.includes('id="ps-drawer-edit"'));
assert('ps-drawer-conversation-btn id preserved', apiSrc.includes('id="ps-drawer-conversation-btn"'));
assert('non-Sunset view fallback keeps legacy rows', viewDetailsFn.includes('!isSunsetSurfActive()'));
assert('drawer-scoped mobile CSS', apiSrc.includes('@media(max-width:420px){.portal-schedule-drawer-hero-inner'));

console.log('\n[5] i18n — booked items EN/ES parity');

assert('EN bookedItems key', i18nSrc.includes("'schedule.drawer.bookedItems': 'Booked items'"));
assert('ES bookedItems key', i18nEsSrc.includes("'schedule.drawer.bookedItems'"));

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-booking-drawer-summary — FAILED');
  process.exit(1);
}
console.log('verify:sunset-booking-drawer-summary — ALL CHECKS PASSED');
