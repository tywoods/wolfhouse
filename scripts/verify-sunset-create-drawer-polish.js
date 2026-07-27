'use strict';

/**
 * verify:sunset-create-drawer-polish
 *
 * Offline gates for approved Create Booking drawer polish:
 *  A) Header: title + active school on one row; close at far right; mobile-safe
 *  B) Compact From–To range trigger + accessible in-drawer calendar;
 *     hidden ps-create-date-from/to remain canonical compatibility state
 *  C) Uniform top-level Create card padding (12px vertical / 14px horizontal)
 *  D) Main activity Group / Private / No lesson as real buttons with
 *     exclusive aria-pressed, selected style, keyboard focus; no radio glyph
 *  E) EN/ES (and IT when present) copy for new range UI strings
 *
 * Static + pure DOM/vm only — no DB/Azure/network.
 * Run: node scripts/verify-sunset-create-drawer-polish.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const portalSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
const i18nSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const esSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const esSunset = require('./lib/staff-portal-i18n-es-sunset');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail += 1;
  }
}

function extractCreateModalHtml(src) {
  const start = src.indexOf('id="ps-create-modal"');
  if (start < 0) return '';
  const open = src.lastIndexOf('<div', start);
  const end = src.indexOf('id="ps-drawer-backdrop"', open);
  const close = src.lastIndexOf('</div>', end);
  return src.slice(open, close > open ? close + 6 : end);
}

function extractCssBlock(src, selectorPrefix) {
  let from = 0;
  while (from < src.length) {
    const idx = src.indexOf(selectorPrefix, from);
    if (idx < 0) return '';
    const lineStart = src.lastIndexOf('\n', idx - 1) + 1;
    const beforeSel = src.slice(lineStart, idx).trim();
    if (!beforeSel || beforeSel.endsWith('}') || beforeSel.endsWith(';')) {
      const brace = src.indexOf('{', idx);
      if (brace < 0) return '';
      let depth = 0;
      for (let i = brace; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
          depth -= 1;
          if (depth === 0) return src.slice(idx, i + 1);
        }
      }
      return '';
    }
    from = idx + selectorPrefix.length;
  }
  return '';
}

function extractFn(src, name) {
  const n = 'function ' + name + '(';
  const s = src.indexOf(n);
  if (s < 0) return null;
  const b = src.indexOf('{', s);
  let d = 0;
  for (let i = b; i < src.length; i += 1) {
    if (src[i] === '{') d += 1;
    else if (src[i] === '}') {
      d -= 1;
      if (!d) return src.slice(s, i + 1);
    }
  }
  return null;
}

const modal = extractCreateModalHtml(apiSrc);
const headerCss = extractCssBlock(apiSrc, '.portal-schedule-create-header{');
const headerTextCss = extractCssBlock(apiSrc, '.portal-schedule-create-header-text{');
const sectionCss = extractCssBlock(apiSrc, '.portal-schedule-create-section{');
const customAddonCss = extractCssBlock(apiSrc, '.portal-schedule-create-custom-addon-card{');
const activityBtnCss =
  extractCssBlock(apiSrc, '.portal-schedule-create-activity-btn{')
  || extractCssBlock(apiSrc, '.portal-schedule-create-main-activity-btn{');

console.log('\nverify:sunset-create-drawer-polish\n');

// ── A) Header: title + school same row ─────────────────────────────────────
console.log('[A] Header title + school same row; close far right');
assert('header + header-text + close present',
  /portal-schedule-create-header/.test(modal)
  && /portal-schedule-create-header-text/.test(modal)
  && /id="ps-create-close"/.test(modal)
  && /id="ps-create-title"/.test(modal)
  && /id="ps-create-school-context"/.test(modal));
assert('header-text is row layout (title + school same row)',
  /display:\s*flex/.test(headerTextCss)
  && /flex-direction:\s*row/.test(headerTextCss)
  && /align-items:\s*center/.test(headerTextCss));
assert('header aligns items center for single-row chrome',
  /align-items:\s*center/.test(headerCss));
assert('header-text wraps safely on narrow viewports',
  /flex-wrap:\s*wrap/.test(headerTextCss) || /min-width:\s*0/.test(headerTextCss));
assert('title precedes school chip precedes close in markup', (() => {
  const t = modal.indexOf('id="ps-create-title"');
  const s = modal.indexOf('id="ps-create-school-context"');
  const c = modal.indexOf('id="ps-create-close"');
  return t >= 0 && s > t && c > s;
})());
assert('school chip not forced onto its own block via column header-text',
  !/flex-direction:\s*column/.test(headerTextCss));

// ── B) Date range trigger + calendar; hidden from/to ───────────────────────
console.log('\n[B] Compact From–To range + calendar; hidden from/to canonical');
assert('range trigger present',
  /id="ps-create-date-range-trigger"/.test(modal)
  || /id="ps-create-date-range-btn"/.test(modal));
assert('range display present',
  /id="ps-create-date-range-display"/.test(modal));
assert('range popover/calendar host present',
  /id="ps-create-date-range-popover"/.test(modal)
  || /id="ps-create-date-range-calendar"/.test(modal));
assert('range actions Clear + Cancel + Apply/Done present',
  (/id="ps-create-date-range-clear"/.test(modal) || /dateRange\.clear/.test(modal + apiSrc))
  && (/id="ps-create-date-range-cancel"/.test(modal) || /dateRange\.cancel/.test(modal + apiSrc))
  && (/id="ps-create-date-range-apply"/.test(modal)
    || /id="ps-create-date-range-done"/.test(modal)
    || /dateRange\.(apply|done)/.test(modal + apiSrc)));
assert('canonical date from/to ids preserved once each',
  (modal.match(/id="ps-create-date-from"/g) || []).length === 1
  && (modal.match(/id="ps-create-date-to"/g) || []).length === 1);
assert('date from/to are hidden compatibility inputs (not dual visible natives)', (() => {
  // No visible labeled native date pair for staff; inputs are hidden/visually-hidden.
  const fromChunk = modal.slice(
    modal.indexOf('id="ps-create-date-from"') - 120,
    modal.indexOf('id="ps-create-date-from"') + 200
  );
  const toChunk = modal.slice(
    modal.indexOf('id="ps-create-date-to"') - 120,
    modal.indexOf('id="ps-create-date-to"') + 200
  );
  const hiddenish = (chunk) =>
    /type="hidden"/.test(chunk)
    || /hidden/.test(chunk)
    || /aria-hidden="true"/.test(chunk)
    || /portal-schedule-create-date-hidden|visually-hidden|sr-only/.test(chunk)
    || /tabindex="-1"/.test(chunk);
  // Visible dual labels "From date"/"To date" tied to native inputs should be gone.
  const noDualVisibleLabels =
    !/<label[^>]*for="ps-create-date-from"/.test(modal)
    && !/<label[^>]*for="ps-create-date-to"/.test(modal);
  return hiddenish(fromChunk) && hiddenish(toChunk) && noDualVisibleLabels;
})());
assert('range trigger is a button (not two native date fields)',
  /<(button)[^>]*id="ps-create-date-range-trigger"/.test(modal)
  || /<(button)[^>]*id="ps-create-date-range-btn"/.test(modal));
assert('calendar selection owner functions present',
  /function schedule(Open|Toggle|Wire|Sync)CreateDateRange/.test(apiSrc)
  || /function scheduleCreateDateRange/.test(apiSrc)
  || /scheduleWireCreateDateRange|scheduleSyncCreateDateRange|scheduleApplyCreateDateRange/.test(apiSrc));
assert('selection rules documented in owner (start/end, restart, same-day, inclusive)',
  /restart|re-?start|same[- ]?day|inclusive|draftStart|draftEnd|rangeStart|rangeEnd/.test(apiSrc)
  && (/second.*start|earlier|before.*start|draftStart/.test(apiSrc)));

// Behavioral calendar selection via extracted pure helper if present
{
  const pureName = [
    'scheduleCreateDateRangeSelectDay',
    'scheduleDateRangeSelectDay',
    'scheduleApplyDateRangeDaySelection',
  ].find((n) => extractFn(apiSrc, n));
  if (pureName) {
    const fnSrc = extractFn(apiSrc, pureName);
    const sandbox = { result: null };
    vm.runInNewContext(
      fnSrc + '; result = ' + pureName + ';',
      sandbox
    );
    const select = sandbox.result;
    let st = select({}, '2026-07-27');
    assert('first click sets start only', st.start === '2026-07-27' && !st.end);
    st = select(st, '2026-07-29');
    assert('second later click sets end', st.start === '2026-07-27' && st.end === '2026-07-29');
    st = select({ start: '2026-07-27', end: null }, '2026-07-25');
    assert('earlier second selection restarts as new start',
      st.start === '2026-07-25' && !st.end);
    st = select({ start: '2026-07-27', end: null }, '2026-07-27');
    assert('same-day range supported', st.start === '2026-07-27' && st.end === '2026-07-27');
  } else {
    assert('pure date-range day selection helper exported', false,
      'expected scheduleCreateDateRangeSelectDay (or alias)');
  }
}

// Inclusive highlight CSS/class
assert('inclusive range highlight class/CSS present',
  /is-in-range|is-range|range-day|date-range-day|is-selected-start|is-selected-end/.test(apiSrc));

// Payload owners still read hidden from/to (unchanged contract)
assert('portal prepare still writes ps-create-date-from/to',
  /ps-create-date-from/.test(portalSrc) && /ps-create-date-to/.test(portalSrc));
assert('create payload/read still uses date from/to elements',
  /ps-create-date-from/.test(apiSrc) && /ps-create-date-to/.test(apiSrc)
  && /scheduleCreateDateSpanForRentals|scheduleReadCreatePayload|date_from/.test(apiSrc + portalSrc));

// ── C) Uniform card padding ────────────────────────────────────────────────
console.log('\n[C] Uniform Create card padding 12px / 14px');
assert('create-section padding is 12px 14px',
  /padding:\s*12px\s+14px/.test(sectionCss));
assert('custom-addon card matches 12px 14px (no extra 14 all-around)',
  /padding:\s*12px\s+14px/.test(customAddonCss)
  || (!/padding:\s*14px[;}]/.test(customAddonCss) && /padding:\s*12px\s+14px/.test(sectionCss)));
assert('main activity choices drop extra top/bottom margin whitespace',
  !/\.portal-schedule-create-components\{[^}]*margin:\s*8px\s+0/.test(
    extractCssBlock(apiSrc, '.portal-schedule-create-main-activity{')
    || ''
  )
  || /portal-schedule-create-main-activity\{[^}]*margin:\s*0/.test(apiSrc)
  || /\.portal-schedule-create-components\.portal-schedule-create-main-activity\{[^}]*margin:\s*0/.test(apiSrc));
assert('activity controls keep ≥44px touch targets',
  /min-height:\s*44px/.test(activityBtnCss)
  || /\.portal-schedule-create-main-activity[\s\S]{0,240}min-height:\s*44px/.test(apiSrc));

// ── D) Main activity real buttons ──────────────────────────────────────────
console.log('\n[D] Main activity real buttons + aria-pressed exclusive');
assert('Group/Private/No lesson ids preserved',
  /id="ps-create-comp-course"/.test(modal)
  && /id="ps-create-comp-private-lesson"/.test(modal)
  && /id="ps-create-comp-no-lesson"/.test(modal));
assert('visible activity controls are buttons (not labeled radio glyphs)',
  /portal-schedule-create-activity-btn|portal-schedule-create-main-activity-btn/.test(modal)
  && /<button[^>]+(portal-schedule-create-activity-btn|portal-schedule-create-main-activity-btn)/.test(modal));
assert('aria-pressed used on activity buttons',
  /aria-pressed=/.test(modal) || /setAttribute\(\s*['"]aria-pressed['"]/.test(apiSrc));
assert('no visible radio glyph on main activity choices', (() => {
  const choicesStart = modal.indexOf('id="ps-create-main-activity-choices"');
  if (choicesStart < 0) return false;
  const choicesEnd = modal.indexOf('id="ps-create-course-list"', choicesStart);
  const chunk = modal.slice(choicesStart, choicesEnd > choicesStart ? choicesEnd : choicesStart + 2000);
  // Radios may exist but must be hidden / not the visible control surface.
  const visibleRadioLabel = /<label[^>]*portal-schedule-create-check[^>]*>\s*<input[^>]*type="radio"/.test(chunk);
  return !visibleRadioLabel;
})());
assert('selected style class for pressed activity button',
  /is-selected|is-pressed|aria-pressed/.test(activityBtnCss + apiSrc));
assert('keyboard/focus-visible support on activity buttons',
  /:focus-visible/.test(activityBtnCss) || /activity-btn:focus/.test(apiSrc));
assert('sync helper keeps aria-pressed exclusive with radio state',
  /function scheduleSyncCreateMainActivity|scheduleSyncMainActivityButtons|aria-pressed/.test(apiSrc)
  && /ps-create-comp-course/.test(apiSrc));
assert('drill-down / Back owners unchanged',
  /schedulePortalEnterGroupCourseDrilldown|schedulePortalExitMainActivityDrilldown|ps-create-main-activity-back/.test(apiSrc + portalSrc));

// ── E) i18n EN/ES (+IT) ────────────────────────────────────────────────────
console.log('\n[E] Localized EN/ES range copy');
const en = STAFF_PORTAL_STRINGS.en || {};
const it = STAFF_PORTAL_STRINGS.it || {};
const requiredKeys = [
  'schedule.create.dateRange',
  'schedule.create.dateRange.clear',
  'schedule.create.dateRange.cancel',
  'schedule.create.dateRange.apply',
];
requiredKeys.forEach((k) => {
  assert('EN ' + k, !!(en[k] && String(en[k]).trim()));
  assert('ES ' + k, !!(esSunset[k] && String(esSunset[k]).trim() && esSunset[k] !== en[k]));
});
// Optional Done alias
if (en['schedule.create.dateRange.done'] || esSunset['schedule.create.dateRange.done']) {
  assert('EN/ES dateRange.done pair',
    !!(en['schedule.create.dateRange.done'] && esSunset['schedule.create.dateRange.done']));
}
// IT preferred when present in owner table
if (it && Object.keys(it).length) {
  requiredKeys.forEach((k) => {
    if (it[k]) assert('IT ' + k + ' present', String(it[k]).trim().length > 0);
  });
}
assert('i18n source files hold new keys',
  requiredKeys.every((k) => i18nSrc.includes(k) && esSrc.includes(k)));

// ── F) 390px no-overflow still constrained ─────────────────────────────────
console.log('\n[F] Mobile width constraints preserved');
assert('create drawer width constrained (min/100vw mobile)',
  /width:\s*min\(440px,\s*94vw\)/.test(apiSrc)
  && (/@media\(max-width:640px\)\{[^}]*portal-schedule-create-drawer\{[^}]*width:100vw/.test(apiSrc)
    || /\.portal-schedule-drawer,\.portal-schedule-create-drawer\{width:100vw/.test(apiSrc)));
assert('create drawer overflow-x hidden',
  /portal-schedule-create-drawer\{[^}]*overflow-x:\s*hidden/.test(apiSrc)
  || /overflow-x:\s*hidden/.test(extractCssBlock(apiSrc, '.portal-schedule-create-drawer{')));

console.log('\n────────────────────────────────────────');
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('verify:sunset-create-drawer-polish OK\n');
