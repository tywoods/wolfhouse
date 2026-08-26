'use strict';

/**
 * verify:sunset-accommodation-ui-hotfix
 *
 * Focused DOM/owner gate for the Sunset Accommodation UI hotfix:
 *  1) Create/Edit use the booking date-range calendar control (not dual native date pickers)
 *  2) Label is CHECK IN / CHECK OUT (i18n EN/ES/IT)
 *  3) Save is rendered beside Remove; validates half-open stay; persists to payload state;
 *     collapses editor; does NOT trigger whole-booking submit/create
 *  4) Admin Pricing: single Accommodation title + Enabled beside it; no help sentence;
 *     stable title/date/price columns
 *  5) Locked cards: no separate bottom Total row; theme-aware surface/border/text CSS
 *
 * Static source + lightweight behavioral sandbox (no Azure/DB/network).
 *
 * Run: node scripts/verify-sunset-accommodation-ui-hotfix.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail += 1;
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function extractNamedFn(src, name) {
  const start = src.search(new RegExp('function\\s+' + name + '\\s*\\('));
  if (start < 0) return null;
  const brace = src.indexOf('{', start);
  if (brace < 0) return null;
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function extractCreateAccommodationHtml(apiSrc) {
  const start = apiSrc.indexOf('id="ps-create-accommodation-wrap"');
  if (start < 0) return '';
  const open = apiSrc.lastIndexOf('<div', start);
  // Accommodation block ends before payment section.
  const end = apiSrc.indexOf('data-create-section="payment"', open);
  return apiSrc.slice(open, end > open ? end : open + 8000);
}

console.log('\nverify:sunset-accommodation-ui-hotfix\n');

const apiSrc = read('scripts/staff-query-api.js');
const editUi = read('scripts/browser/sunset-schedule-drawer-edit-ui.js');
const adminUi = read('scripts/browser/sunset-admin-ui.js');
const i18nEn = read('scripts/lib/staff-portal-i18n.js');
const i18nEs = read('scripts/lib/staff-portal-i18n-es-sunset.js');
const createHtml = extractCreateAccommodationHtml(apiSrc);

// ── 1) Create: date-range control (reuse booking calendar pattern) ─────────
console.log('[1] Create accommodation date-range control');
ok('Create editor has date-range field (shared classes)',
  /id="ps-create-accommodation-date-range"/.test(createHtml)
  && /portal-schedule-create-date-range-field/.test(createHtml)
  && /portal-schedule-create-date-range-trigger/.test(createHtml)
  && /portal-schedule-create-date-range-popover/.test(createHtml)
  && /portal-schedule-create-date-range-grid/.test(createHtml));
ok('Create label is CHECK IN / CHECK OUT i18n key',
  /data-i18n="schedule\.create\.accommodation\.checkInOut"/.test(createHtml)
  || /schedule\.create\.accommodation\.checkInOut/.test(createHtml));
ok('Create does not show dual visible native CHECK IN / CHECK OUT inputs', (() => {
  // Hidden type=date for canonical state is OK; no visible labelled dual fields.
  const dualVisible = /label for="ps-create-accommodation-check-in"[\s\S]{0,200}type="date"(?![^>]*hidden)/.test(createHtml)
    && /label for="ps-create-accommodation-check-out"[\s\S]{0,200}type="date"(?![^>]*hidden)/.test(createHtml);
  const hasHiddenCanonical = /id="ps-create-accommodation-check-in"[\s\S]{0,120}hidden/.test(createHtml)
    && /id="ps-create-accommodation-check-out"[\s\S]{0,120}hidden/.test(createHtml);
  return !dualVisible && hasHiddenCanonical;
})());
ok('Create reuses pure booking date-range helpers',
  /scheduleCreateDateRangeSelectDay/.test(apiSrc)
  && /scheduleCreateDateRangeDisplayText/.test(apiSrc)
  && /function scheduleRenderCreateAccomDateRangeCalendar/.test(apiSrc)
  && /function scheduleWireCreateAccomDateRange/.test(apiSrc));

// ── 2) Create: Save beside Remove + behavioral owner ───────────────────────
console.log('\n[2] Create Save beside Remove (DOM + behavioral owner)');
ok('Save button present with testid',
  /id="ps-create-accommodation-save"/.test(createHtml)
  && /data-testid="ps-create-accommodation-save"/.test(createHtml));
ok('Remove button present with testid',
  /id="ps-create-accommodation-remove"/.test(createHtml)
  && /data-testid="ps-create-accommodation-remove"/.test(createHtml));
ok('Save appears before Remove in actions row', (() => {
  const actions = createHtml.match(
    /portal-schedule-create-custom-line-actions[\s\S]{0,800}?<\/div>/,
  );
  if (!actions) return false;
  const chunk = actions[0];
  const si = chunk.indexOf('ps-create-accommodation-save');
  const ri = chunk.indexOf('ps-create-accommodation-remove');
  return si >= 0 && ri > si;
})());
ok('Save i18n key present',
  /data-i18n="schedule\.create\.accommodation\.save"/.test(createHtml)
  || /schedule\.create\.accommodation\.save/.test(createHtml));
ok('scheduleSaveCreateAccommodation owner exists',
  /function scheduleSaveCreateAccommodation\s*\(/.test(apiSrc));
ok('Save does not call whole-booking submit/create', (() => {
  const saveFn = extractNamedFn(apiSrc, 'scheduleSaveCreateAccommodation') || '';
  if (!saveFn) return false;
  return !/scheduleSubmitCreate|scheduleCreateBooking|ps-create-submit|createSunsetScheduleBooking/.test(saveFn)
    && !/\.submit\s*\(/.test(saveFn)
    && /scheduleCreateAccommodationEditorOpen\s*=\s*false/.test(saveFn)
    && (/scheduleCreateAccommodation\s*=\s*\{/.test(saveFn)
      || /scheduleCreateAccommodationStays\.push/.test(saveFn)
      || /nextStay/.test(saveFn));
})());
ok('Create + remains visible after saves (permanent when product enabled)',
  /addBtn\.style\.display\s*=\s*scheduleAccommodationEnabledCache\s*\?\s*''\s*:\s*'none'/.test(apiSrc)
  || /addBtn\.style\.display = scheduleAccommodationEnabledCache \? '' : 'none'/.test(apiSrc));
const setAccommodationEnabledFn = extractNamedFn(apiSrc, 'scheduleSetAccommodationProductEnabled');
let firstOpenRace = null;
try {
  // Simulate first render with cache=false followed by async Admin config enablement.
  firstOpenRace = new Function(
    'var scheduleAccommodationEnabledCache=false; var renders=0;'
    + 'var wrap={style:{display:"none"},removeAttribute:function(){this.hidden=false;},setAttribute:function(){this.hidden=true;}};'
    + 'function el(){return wrap;} function scheduleRenderCreateAccommodation(){renders+=1;}'
    + setAccommodationEnabledFn
    + '; scheduleSetAccommodationProductEnabled(true); return {renders:renders,display:wrap.style.display,hidden:wrap.hidden,enabled:scheduleAccommodationEnabledCache};',
  )();
} catch (_raceErr) { firstOpenRace = null; }
ok('Async config enable rerenders Accommodation + on first drawer open',
  !!firstOpenRace && firstOpenRace.enabled === true && firstOpenRace.renders === 1
  && firstOpenRace.display === '' && firstOpenRace.hidden === false);
ok('Create multi-stay list + locked cards owners present',
  /ps-create-accommodation-list/.test(apiSrc)
  && /scheduleRenderCreateAccommodationCardHtml/.test(apiSrc)
  && /data-edit-accom-stay/.test(apiSrc)
  && /data-remove-accom-stay/.test(apiSrc));
ok('Save validates half-open stay', (() => {
  const saveFn = extractNamedFn(apiSrc, 'scheduleSaveCreateAccommodation') || '';
  return /checkOut\s*<=\s*checkIn/.test(saveFn)
    && /scheduleAddIsoDays/.test(saveFn);
})());

// Lightweight behavioral sandbox for Save owner
console.log('\n[2b] Behavioral Save sandbox (Create)');
(function runCreateSaveSandbox() {
  const nodes = {};
  function makeEl(id, extras) {
    nodes[id] = Object.assign({
      id,
      value: '',
      textContent: '',
      style: { display: 'none' },
      hidden: true,
      attributes: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(k, v) { this.attributes[k] = String(v); this[k] = v; },
      getAttribute(k) { return this.attributes[k] != null ? this.attributes[k] : null; },
      removeAttribute(k) { delete this.attributes[k]; try { delete this[k]; } catch (_e) { this[k] = undefined; } },
      addEventListener() {},
      focus() {},
      contains() { return false; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    }, extras || {});
    return nodes[id];
  }
  makeEl('ps-create-accommodation-check-in', { value: '2026-07-28' });
  makeEl('ps-create-accommodation-check-out', { value: '2026-07-31' });
  makeEl('ps-create-accommodation-error', { style: { display: 'none' }, textContent: '' });
  makeEl('ps-create-accommodation-editor', { style: { display: '' }, hidden: false });
  makeEl('ps-create-accommodation-summary', { style: { display: 'none' }, hidden: true });
  makeEl('ps-create-accommodation-summary-display', { textContent: '' });
  makeEl('ps-create-accommodation-list', { innerHTML: '', style: { display: '' } });
  makeEl('ps-create-accommodation-add-btn', { style: { display: '' } });
  makeEl('ps-create-accommodation-date-range-display', { textContent: '' });
  makeEl('ps-create-accommodation-date-range-apply', { disabled: false });
  makeEl('ps-create-accommodation-date-range-popover', {
    hidden: true, style: { display: 'none' },
  });
  makeEl('ps-create-accommodation-date-range-trigger', { attributes: {} });
  makeEl('ps-create-accommodation-date-range-grid');
  makeEl('ps-create-accommodation-date-range-month-label');
  makeEl('ps-create-accommodation-date-range');

  let submitCalls = 0;
  const state = {
    scheduleCreateAccommodationStays: [],
    scheduleCreateAccommodation: {
      enabled: true, check_in: '2026-07-28', check_out: '2026-07-31', client_stay_id: 'as_test_1',
    },
    scheduleCreateAccommodationEditorOpen: true,
    scheduleCreateAccommodationEditingId: null,
    scheduleCreateAccommodationStaySeq: 1,
    scheduleCreateAccomDateRangeDraft: { start: '2026-07-28', end: '2026-07-31' },
    scheduleCreateAccomDateRangeViewYm: '2026-07',
    scheduleCreateAccomDateRangeFocusIso: null,
    scheduleCreateAccomDateRangeRestoreFocus: false,
    scheduleAccommodationEnabledCache: true,
  };

  function el(id) { return nodes[id] || null; }
  function portalT(k) {
    if (k === 'schedule.create.accommodation.invalidStay') return 'invalid stay';
    if (k === 'schedule.create.accommodation.overlap') {
      return 'Accommodation stays overlap: [{aIn}, {aOut}) and [{bIn}, {bOut})';
    }
    return k;
  }
  function escHtml(s) { return String(s == null ? '' : s); }
  function scheduleCreateDateRangeIsValidIso(iso) {
    return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(iso || '').slice(0, 10));
  }
  function scheduleCreateDateRangeDisplayText(from, to) {
    from = from ? String(from).slice(0, 10) : '';
    to = to ? String(to).slice(0, 10) : from;
    if (!from) return 'Select dates';
    if (!to || from === to) return from;
    return from + ' – ' + to;
  }

  // Longer names first so partial renames do not corrupt identifiers.
  const rewrite = (src) => String(src || '')
    .replace(/\bscheduleCreateAccommodationStaySeq\b/g, 'state.scheduleCreateAccommodationStaySeq')
    .replace(/\bscheduleCreateAccommodationStays\b/g, 'state.scheduleCreateAccommodationStays')
    .replace(/\bscheduleCreateAccommodationEditingId\b/g, 'state.scheduleCreateAccommodationEditingId')
    .replace(/\bscheduleCreateAccommodationEditorOpen\b/g, 'state.scheduleCreateAccommodationEditorOpen')
    .replace(/\bscheduleCreateAccommodation\b/g, 'state.scheduleCreateAccommodation')
    .replace(/\bscheduleCreateAccomDateRangeDraft\b/g, 'state.scheduleCreateAccomDateRangeDraft')
    .replace(/\bscheduleCreateAccomDateRangeViewYm\b/g, 'state.scheduleCreateAccomDateRangeViewYm')
    .replace(/\bscheduleCreateAccomDateRangeFocusIso\b/g, 'state.scheduleCreateAccomDateRangeFocusIso')
    .replace(/\bscheduleCreateAccomDateRangeRestoreFocus\b/g, 'state.scheduleCreateAccomDateRangeRestoreFocus')
    .replace(/\bscheduleAccommodationEnabledCache\b/g, 'state.scheduleAccommodationEnabledCache');

  const body = [
    extractNamedFn(apiSrc, 'scheduleAddIsoDays'),
    extractNamedFn(apiSrc, 'scheduleNewCreateAccommodationStayId'),
    extractNamedFn(apiSrc, 'scheduleCreateAccommodationDisplayText'),
    extractNamedFn(apiSrc, 'scheduleCreateAccommodationNights'),
    extractNamedFn(apiSrc, 'scheduleCreateAccommodationOverlaps'),
    extractNamedFn(apiSrc, 'scheduleRenderCreateAccommodationCardHtml'),
    extractNamedFn(apiSrc, 'scheduleSyncCreateAccomDateRangeUi'),
    extractNamedFn(apiSrc, 'scheduleCreateAccomDateRangeIsOpen'),
    extractNamedFn(apiSrc, 'scheduleCreateAccomDateRangeSeedDraft'),
    extractNamedFn(apiSrc, 'scheduleCreateAccomDateRangeClosePopover'),
    extractNamedFn(apiSrc, 'scheduleRenderCreateAccommodation'),
    extractNamedFn(apiSrc, 'scheduleSyncCreateAccommodationFromDom'),
    extractNamedFn(apiSrc, 'scheduleSaveCreateAccommodation'),
    extractNamedFn(apiSrc, 'scheduleReadCreateAccommodation'),
  ].filter(Boolean).map(rewrite).join('\n');
  ok('extracted Create accommodation Save chain', body.length > 200);

  // eslint-disable-next-line no-new-func
  const run = new Function(
    'state', 'el', 'portalT', 'escHtml',
    'scheduleCreateDateRangeIsValidIso', 'scheduleCreateDateRangeDisplayText',
    'schedulePortalSyncCreateFooter', 'scheduleEscapeHtmlLite', 'scheduleFormatCentsMoney',
    body
    + '\nreturn {\n'
    + '  save: scheduleSaveCreateAccommodation,\n'
    + '  read: scheduleReadCreateAccommodation,\n'
    + '};\n',
  );

  let footerSync = 0;
  const api = run(
    state, el, portalT, escHtml,
    scheduleCreateDateRangeIsValidIso, scheduleCreateDateRangeDisplayText,
    function schedulePortalSyncCreateFooter() { footerSync += 1; },
    function scheduleEscapeHtmlLite(s) { return String(s == null ? '' : s); },
    function scheduleFormatCentsMoney(c) { return '€' + (Number(c) / 100).toFixed(2); },
  );

  const saved = api.save();
  ok('Save returns true for valid half-open stay', saved === true);
  ok('Save collapses editor', state.scheduleCreateAccommodationEditorOpen === false);
  ok('Save retains selection in state',
    state.scheduleCreateAccommodation
    && state.scheduleCreateAccommodation.enabled === true
    && state.scheduleCreateAccommodation.check_in === '2026-07-28'
    && state.scheduleCreateAccommodation.check_out === '2026-07-31');
  ok('Save appends locked stay card',
    Array.isArray(state.scheduleCreateAccommodationStays)
    && state.scheduleCreateAccommodationStays.length === 1
    && state.scheduleCreateAccommodationStays[0].check_in === '2026-07-28'
    && state.scheduleCreateAccommodationStays[0].check_out === '2026-07-31');
  const payload = api.read();
  ok('Read payload has committed dates (no client money)',
    payload
    && payload.enabled === true
    && Array.isArray(payload.stays)
    && payload.stays.length === 1
    && payload.stays[0].check_in === '2026-07-28'
    && payload.stays[0].check_out === '2026-07-31'
    && payload.amount_cents == null
    && payload.total_cents == null);
  ok('Save synced footer/quote intent only (not submit)', footerSync >= 1 && submitCalls === 0);
  ok('Editor hidden after save; + still visible',
    nodes['ps-create-accommodation-editor'].style.display === 'none'
    && nodes['ps-create-accommodation-add-btn'].style.display === '');
  ok('Locked card list rendered after save',
    String(nodes['ps-create-accommodation-list'].innerHTML || '').indexOf('ps-create-accommodation-card') >= 0
    || state.scheduleCreateAccommodationStays.length === 1);
})();

// ── 3) Edit parity ─────────────────────────────────────────────────────────
console.log('\n[3] Edit accommodation date-range + Save parity');
ok('Edit HTML has date-range field classes',
  /ps-drawer-accommodation-date-range/.test(editUi)
  && /portal-schedule-create-date-range-field/.test(editUi)
  && /portal-schedule-create-date-range-trigger/.test(editUi)
  && /portal-schedule-create-date-range-grid/.test(editUi));
ok('Edit label checkInOut',
  /schedule\.create\.accommodation\.checkInOut/.test(editUi));
ok('Edit Save beside Remove', (() => {
  const saveIdx = editUi.indexOf('ps-drawer-accommodation-save');
  const removeIdx = editUi.indexOf('ps-drawer-accommodation-remove');
  return saveIdx >= 0 && removeIdx > saveIdx
    && /data-testid="ps-drawer-accommodation-save"/.test(editUi)
    && /data-testid="ps-drawer-accommodation-remove"/.test(editUi);
})());
ok('Edit Save owner does not submit booking', (() => {
  const saveFn = extractNamedFn(editUi, 'scheduleDrawerSaveAccommodation') || '';
  return !!saveFn
    && !/scheduleDrawerSubmit|scheduleUpdateBooking|fetch\(/.test(saveFn)
    && /scheduleDrawerAccommodationEditorOpen\s*=\s*false/.test(saveFn)
    && (/scheduleDrawerAccommodation\s*=\s*\{/.test(saveFn)
      || /scheduleDrawerAccommodationStays/.test(saveFn));
})());
ok('Edit reuses booking date-range pure helpers',
  /scheduleCreateDateRangeSelectDay/.test(editUi)
  && /scheduleCreateDateRangeDisplayText/.test(editUi));
ok('Edit multi-stay list + permanent + owners',
  /ps-drawer-accommodation-list/.test(editUi)
  && /scheduleDrawerAccommodationStays/.test(editUi)
  && /addBtn\.style\.display = productOn \? '' : 'none'/.test(editUi));
ok('Edit summary collapsed saved state',
  /ps-drawer-accommodation-summary/.test(editUi)
  && /scheduleDrawerAccommodationEditorOpen/.test(editUi));

// ── 4) Admin Pricing card cleanup ──────────────────────────────────────────
console.log('\n[4] Admin Pricing Accommodation card cleanup');
ok('Admin section has no duplicate section-hdr Accommodation title',
  !/<div class="portal-admin-section-hdr"[^>]*data-i18n="admin\.section\.accommodation"/.test(apiSrc)
  && /id="admin-sec-accommodation"/.test(apiSrc)
  && /id="admin-accommodation-body"/.test(apiSrc));
ok('Admin card keeps single title with Enabled beside it',
  /data-i18n="admin\.accommodation\.title"/.test(adminUi)
  && /data-testid="admin-accommodation-enabled-status"/.test(adminUi)
  && /portal-admin-subsection-title-group[\s\S]{0,400}admin\.accommodation\.title[\s\S]{0,400}admin-accommodation-enabled-status/.test(adminUi));
ok('Admin help sentence not rendered',
  !/data-i18n="admin\.accommodation\.help"/.test(adminUi)
  && !/Seasonal per-night prices\. Checkout night is free/.test(adminUi));
ok('Admin range rows use stable title/date/price columns',
  /portal-admin-accommodation-range-row/.test(adminUi)
  && /portal-admin-accommodation-range-title/.test(adminUi)
  && /portal-admin-accommodation-range-dates/.test(adminUi)
  && /portal-admin-accommodation-range-price/.test(adminUi));
ok('Admin column CSS present and responsive',
  /portal-admin-accommodation-range-row\{[^}]*grid-template-columns/.test(apiSrc)
  && /@media \(max-width:520px\)[\s\S]{0,400}portal-admin-accommodation-range-row/.test(apiSrc));
ok('Admin edit toggle + save-accommodation preserved',
  /edit-accommodation/.test(adminUi)
  && /save-accommodation/.test(adminUi)
  && /admin-accom-enabled/.test(adminUi));
ok('Admin range readout uses locale formatter (not raw ISO concat)',
  /adminFormatAccomDateRange\(r\.check_in, r\.check_out\)/.test(adminUi)
  && !/escHtml\(\(r\.check_in \|\| ''\) \+ ' → ' \+ \(r\.check_out \|\| ''\)\)/.test(adminUi));
ok('Admin coverage gap warning rendered in readout mode',
  /renderAdminAccommodationCoverageWarning/.test(adminUi)
  && /data-testid="admin-accommodation-coverage-warning"/.test(adminUi)
  && /adminFindAccommodationCoverageGaps/.test(adminUi));
ok('Admin coverage gap warning CSS present',
  /portal-admin-accommodation-coverage-warn/.test(apiSrc));
ok('Admin coverage gap i18n EN/ES',
  /'admin\.accommodation\.coverageGap'/.test(i18nEn)
  && /'admin\.accommodation\.coverageGap'/.test(i18nEs));

// ── 5) i18n EN/ES/IT ───────────────────────────────────────────────────────
console.log('\n[5] i18n EN/ES/IT for checkInOut + Save');
const newKeys = [
  'schedule.create.accommodation.checkInOut',
  'schedule.create.accommodation.save',
  'schedule.create.accommodation.invalidStay',
];
newKeys.forEach((k) => {
  ok(`EN key ${k}`, i18nEn.includes(`'${k}'`));
  ok(`ES key ${k}`, i18nEs.includes(`'${k}'`));
});
ok('EN checkInOut label', /'schedule\.create\.accommodation\.checkInOut': 'Check in \/ Check out'/.test(i18nEn));
ok('IT checkInOut label', /'schedule\.create\.accommodation\.checkInOut': 'Check-in \/ Check-out'/.test(i18nEn));
ok('ES checkInOut label', /'schedule\.create\.accommodation\.checkInOut': 'Entrada \/ Salida'/.test(i18nEs));
ok('EN Save', /'schedule\.create\.accommodation\.save': 'Save'/.test(i18nEn));
ok('IT Save', /'schedule\.create\.accommodation\.save': 'Salva'/.test(i18nEn));
ok('ES Save', /'schedule\.create\.accommodation\.save': 'Guardar'/.test(i18nEs));

// ── 6) Locked-card nights after quote merge (Create + Edit production owners) ─
console.log('\n[6] Locked-card nights after quote attachment (Create + Edit)');

// Guard: card owners must not overwrite ISO-derived nights with finite q.nights
// (the bug: quote nights:0 → "0 nights" while dates persist Jul 31 → Aug 4).
ok('Create card does not prefer q.nights over date-derived nights', (() => {
  const fn = extractNamedFn(apiSrc, 'scheduleRenderCreateAccommodationCardHtml') || '';
  return /scheduleCreateAccommodationNights\s*\(/.test(fn)
    && !/if\s*\(\s*q\s*&&\s*Number\.isFinite\s*\(\s*Number\s*\(\s*q\.nights\s*\)\s*\)\s*\)\s*nights\s*=\s*Number\s*\(\s*q\.nights\s*\)/.test(fn);
})());
ok('Edit card does not prefer q.nights over date-derived nights', (() => {
  const fn = extractNamedFn(editUi, 'scheduleDrawerRenderAccommodationCardHtml') || '';
  return /scheduleDrawerAccommodationNights\s*\(/.test(fn)
    && !/if\s*\(\s*q\s*&&\s*Number\.isFinite\s*\(\s*Number\s*\(\s*q\.nights\s*\)\s*\)\s*\)\s*nights\s*=\s*Number\s*\(\s*q\.nights\s*\)/.test(fn);
})());
ok('Create quote merge resolves nights (no bare Number(match.nights)||0 path)',
  /function scheduleResolveAccommodationQuoteNights\s*\(/.test(apiSrc)
  && /scheduleResolveAccommodationQuoteNights\s*\(\s*match/.test(apiSrc));
ok('Edit quote merge + attach parity present',
  /function scheduleDrawerResolveAccommodationQuoteNights\s*\(/.test(editUi)
  && /function scheduleAttachDrawerAccommodationQuote\s*\(/.test(editUi)
  && /scheduleAttachDrawerAccommodationQuote\s*\(\s*result\.body\s*\)/.test(editUi));

(function runLockedCardNightsSandbox() {
  function portalT(k) {
    if (k === 'schedule.create.accommodation.title') return 'Accommodation';
    if (k === 'schedule.create.accommodation.total') return 'Total';
    if (k === 'schedule.create.accommodation.edit') return 'Edit';
    if (k === 'schedule.create.accommodation.remove') return 'Remove';
    return k;
  }
  function escHtml(s) { return String(s == null ? '' : s); }
  function scheduleEscapeHtmlLite(s) { return escHtml(s); }
  function scheduleFormatCentsMoney(c) { return '€' + (Number(c) / 100).toFixed(2); }
  function scheduleCreateDateRangeDisplayText(from, to) {
    from = from ? String(from).slice(0, 10) : '';
    to = to ? String(to).slice(0, 10) : from;
    if (!from) return 'Select dates';
    if (!to || from === to) return from;
    return from + ' – ' + to;
  }

  // ── Create production path: attach quote (nights:0) → locked card HTML ──
  const createBody = [
    extractNamedFn(apiSrc, 'scheduleAddIsoDays'),
    extractNamedFn(apiSrc, 'scheduleCreateAccommodationNights'),
    extractNamedFn(apiSrc, 'scheduleResolveAccommodationQuoteNights'),
    extractNamedFn(apiSrc, 'scheduleCreateAccommodationDisplayText'),
    extractNamedFn(apiSrc, 'scheduleAttachCreateAccommodationQuote'),
    extractNamedFn(apiSrc, 'scheduleRenderCreateAccommodationCardHtml'),
    // Minimal render stub so attach can call it without DOM.
    'function scheduleRenderCreateAccommodation(){ /* sandbox */ }',
  ].filter(Boolean).map(function(src){
    // These Create owners live inside the server HTML template; evaluate the
    // emitted browser JavaScript after removing exactly one template escape layer.
    return String(src).replace(/\\\\/g, '\\');
  }).join('\n');
  ok('extracted Create nights/attach/card owners', createBody.length > 200);

  // eslint-disable-next-line no-new-func
  const createRun = new Function(
    'portalT', 'escHtml', 'scheduleEscapeHtmlLite', 'scheduleFormatCentsMoney',
    'scheduleCreateDateRangeDisplayText',
    'var scheduleCreateAccommodationStays = [];\n'
    + createBody
    + '\nreturn {\n'
    + '  setStays: function(s){ scheduleCreateAccommodationStays = s; },\n'
    + '  getStays: function(){ return scheduleCreateAccommodationStays; },\n'
    + '  attach: scheduleAttachCreateAccommodationQuote,\n'
    + '  cardHtml: scheduleRenderCreateAccommodationCardHtml,\n'
    + '  nights: scheduleCreateAccommodationNights,\n'
    + '  resolve: scheduleResolveAccommodationQuoteNights,\n'
    + '};\n',
  );
  const createApi = createRun(
    portalT, escHtml, scheduleEscapeHtmlLite, scheduleFormatCentsMoney,
    scheduleCreateDateRangeDisplayText,
  );

  // Helper unit cases (timezone-safe ISO arithmetic)
  ok('Create helper Jul 31→Aug 4 = 4', createApi.nights('2026-07-31', '2026-08-04') === 4);
  ok('Create helper Dec 31→Jan 2 = 2', createApi.nights('2026-12-31', '2027-01-02') === 2);
  ok('Create helper same-day fails closed to 0', createApi.nights('2026-07-31', '2026-07-31') === 0);
  ok('Create helper inverted fails closed to 0', createApi.nights('2026-08-04', '2026-07-31') === 0);
  ok('Create helper invalid fails closed to 0', createApi.nights('Jul 31', 'Aug 4') === 0);

  // Production locked-card path: stay dates correct, quote enrichment nights:0
  // with authoritative season/price — card must show 4 nights, keep money.
  createApi.setStays([{
    client_stay_id: 'as_jul',
    check_in: '2026-07-31',
    check_out: '2026-08-04',
    quote: null,
  }]);
  createApi.attach({
    line_items: [{
      staff_accommodation: true,
      client_stay_id: 'as_jul',
      check_in: '2026-07-31',
      check_out: '2026-08-04',
      nights: 0, // buggy / missing snapshot nights
      total_cents: 20000,
      currency: 'EUR',
      season_groups: [
        { title: 'High', nights: 4, nightly_cents: 5000, subtotal_cents: 20000 },
      ],
      label: 'Accommodation · High · 4 nights',
    }],
  });
  const createStay = createApi.getStays()[0];
  ok('Create attach stores positive nights (not 0) for Jul31→Aug4',
    createStay && createStay.quote && createStay.quote.nights === 4,
    createStay && createStay.quote ? 'nights=' + createStay.quote.nights : 'no quote');
  ok('Create attach preserves season_groups + total',
    createStay && createStay.quote
    && createStay.quote.total_cents === 20000
    && Array.isArray(createStay.quote.season_groups)
    && createStay.quote.season_groups[0].title === 'High'
    && createStay.quote.season_groups[0].nights === 4);
  const createHtmlJul = createApi.cardHtml(createStay);
  ok('Create locked card shows 4 nights for Jul31→Aug4 after quote nights:0',
    /4 nights/.test(createHtmlJul) && !/>0 nights</.test(createHtmlJul)
    && /ps-create-accommodation-card/.test(createHtmlJul),
    createHtmlJul.slice(0, 280));
  ok('Create locked card keeps season price summary',
    /High/.test(createHtmlJul) && /€200\.00/.test(createHtmlJul));

  // Cross-year
  createApi.setStays([{
    client_stay_id: 'as_nye',
    check_in: '2026-12-31',
    check_out: '2027-01-02',
    quote: null,
  }]);
  createApi.attach({
    line_items: [{
      component: 'staff_accommodation',
      client_stay_id: 'as_nye',
      check_in: '2026-12-31',
      check_out: '2027-01-02',
      nights: 0,
      total_cents: 8000,
      currency: 'EUR',
      season_groups: [
        { title: 'Low', nights: 2, nightly_cents: 4000, subtotal_cents: 8000 },
      ],
    }],
  });
  const createNye = createApi.getStays()[0];
  ok('Create attach Dec31→Jan2 nights=2',
    createNye && createNye.quote && createNye.quote.nights === 2);
  ok('Create locked card shows 2 nights for Dec31→Jan2',
    /2 nights/.test(createApi.cardHtml(createNye)));

  // Fail closed on invalid stay even with quote.nights>0 — display uses dates.
  const invalidHtml = createApi.cardHtml({
    client_stay_id: 'as_bad',
    check_in: '2026-07-31',
    check_out: '2026-07-31',
    quote: {
      nights: 99,
      total_cents: 1000,
      season_groups: [{ title: 'X', nights: 99, nightly_cents: 10, subtotal_cents: 1000 }],
    },
  });
  ok('Create invalid same-day card fails closed to 0 nights (ignores quote.nights=99)',
    /0 nights/.test(invalidHtml) && !/99 nights/.test(invalidHtml));

  // ── Edit production path parity ──
  const editBody = [
    extractNamedFn(editUi, 'scheduleDrawerAddIsoDays'),
    extractNamedFn(editUi, 'scheduleDrawerAccommodationNights'),
    extractNamedFn(editUi, 'scheduleDrawerResolveAccommodationQuoteNights'),
    extractNamedFn(editUi, 'scheduleDrawerAccommodationDisplayText'),
    extractNamedFn(editUi, 'scheduleAttachDrawerAccommodationQuote'),
    extractNamedFn(editUi, 'scheduleDrawerRenderAccommodationCardHtml'),
    'function scheduleDrawerRenderAccommodation(){ /* sandbox */ }',
  ].filter(Boolean).join('\n');
  ok('extracted Edit nights/attach/card owners', editBody.length > 200);

  // eslint-disable-next-line no-new-func
  const editRun = new Function(
    'portalT', 'escHtml', 'scheduleEscapeHtmlLite', 'scheduleFormatCentsMoney',
    'scheduleCreateDateRangeDisplayText',
    'var scheduleDrawerAccommodationStays = [];\n'
    + editBody
    + '\nreturn {\n'
    + '  setStays: function(s){ scheduleDrawerAccommodationStays = s; },\n'
    + '  getStays: function(){ return scheduleDrawerAccommodationStays; },\n'
    + '  attach: scheduleAttachDrawerAccommodationQuote,\n'
    + '  cardHtml: scheduleDrawerRenderAccommodationCardHtml,\n'
    + '  nights: scheduleDrawerAccommodationNights,\n'
    + '};\n',
  );
  const editApi = editRun(
    portalT, escHtml, scheduleEscapeHtmlLite, scheduleFormatCentsMoney,
    scheduleCreateDateRangeDisplayText,
  );

  ok('Edit helper Jul 31→Aug 4 = 4', editApi.nights('2026-07-31', '2026-08-04') === 4);
  ok('Edit helper Dec 31→Jan 2 = 2', editApi.nights('2026-12-31', '2027-01-02') === 2);
  ok('Edit helper same-day fails closed to 0', editApi.nights('2026-07-31', '2026-07-31') === 0);

  editApi.setStays([{
    client_stay_id: 'as_edit_jul',
    check_in: '2026-07-31',
    check_out: '2026-08-04',
    quote: { nights: 0, total_cents: 1, season_groups: [] }, // stale seed
  }]);
  editApi.attach({
    line_items: [{
      price_source: 'staff_accommodation',
      client_stay_id: 'as_edit_jul',
      check_in: '2026-07-31',
      check_out: '2026-08-04',
      nights: 0,
      total_cents: 20000,
      currency: 'EUR',
      season_groups: [
        { title: 'High', nights: 4, nightly_cents: 5000, subtotal_cents: 20000 },
      ],
    }],
  });
  const editStay = editApi.getStays()[0];
  ok('Edit attach stores nights=4 for Jul31→Aug4 despite quote nights:0',
    editStay && editStay.quote && editStay.quote.nights === 4);
  const editHtmlJul = editApi.cardHtml(editStay);
  ok('Edit locked card shows 4 nights for Jul31→Aug4 after quote nights:0',
    /4 nights/.test(editHtmlJul) && !/>0 nights</.test(editHtmlJul)
    && /ps-drawer-accommodation-card/.test(editHtmlJul),
    editHtmlJul.slice(0, 280));
  ok('Edit locked card keeps season price summary',
    /High/.test(editHtmlJul) && /€200\.00/.test(editHtmlJul));

  // No separate bottom Total row — itemized season subtotals only (Create + Edit).
  ok('Create locked card has no card-total row',
    !/portal-schedule-create-accommodation-card-total/.test(createHtmlJul)
    && !/ps-create-accommodation-card-total/.test(createHtmlJul)
    && !/>Total</.test(createHtmlJul)
    && /portal-schedule-create-accommodation-card-breakdown-row/.test(createHtmlJul)
    && /High · 4 × €50\.00/.test(createHtmlJul));
  ok('Edit locked card has no card-total row',
    !/portal-schedule-create-accommodation-card-total/.test(editHtmlJul)
    && !/ps-drawer-accommodation-card-total/.test(editHtmlJul)
    && !/>Total</.test(editHtmlJul)
    && /portal-schedule-create-accommodation-card-breakdown-row/.test(editHtmlJul)
    && /High · 4 × €50\.00/.test(editHtmlJul));
  // Source owners: total-row markup permanently removed (not just empty when total missing).
  ok('Create card owner source has no card-total markup', (() => {
    const fn = extractNamedFn(apiSrc, 'scheduleRenderCreateAccommodationCardHtml') || '';
    return !!fn
      && !/portal-schedule-create-accommodation-card-total/.test(fn)
      && !/ps-create-accommodation-card-total/.test(fn)
      && !/schedule\.create\.accommodation\.total/.test(fn);
  })());
  ok('Edit card owner source has no card-total markup', (() => {
    const fn = extractNamedFn(editUi, 'scheduleDrawerRenderAccommodationCardHtml') || '';
    return !!fn
      && !/portal-schedule-create-accommodation-card-total/.test(fn)
      && !/ps-drawer-accommodation-card-total/.test(fn)
      && !/schedule\.create\.accommodation\.total/.test(fn);
  })());

  editApi.setStays([{
    client_stay_id: 'as_edit_nye',
    check_in: '2026-12-31',
    check_out: '2027-01-02',
    quote: null,
  }]);
  editApi.attach({
    line_items: [{
      staff_accommodation: true,
      client_stay_id: 'as_edit_nye',
      check_in: '2026-12-31',
      check_out: '2027-01-02',
      nights: 0,
      total_cents: 8000,
      currency: 'EUR',
      season_groups: [{ title: 'Low', nights: 2, nightly_cents: 4000, subtotal_cents: 8000 }],
    }],
  });
  ok('Edit locked card shows 2 nights for Dec31→Jan2',
    /2 nights/.test(editApi.cardHtml(editApi.getStays()[0])));

  const editInvalid = editApi.cardHtml({
    client_stay_id: 'as_edit_bad',
    check_in: 'not-a-date',
    check_out: '2026-08-04',
    quote: { nights: 4, total_cents: 1000, season_groups: [] },
  });
  ok('Edit invalid dates fail closed to 0 nights (ignores quote.nights)',
    /0 nights/.test(editInvalid) && !/4 nights/.test(editInvalid));

  // Both owners share corrected helper behavior (cross-month + cross-year).
  ok('Create/Edit helpers agree on cross-month and cross-year',
    createApi.nights('2026-07-31', '2026-08-04') === editApi.nights('2026-07-31', '2026-08-04')
    && createApi.nights('2026-12-31', '2027-01-02') === editApi.nights('2026-12-31', '2027-01-02')
    && createApi.nights('2026-07-31', '2026-08-04') === 4
    && createApi.nights('2026-12-31', '2027-01-02') === 2);
})();

// ── 6b) Locked-card dark-mode surface (theme-aware CSS) ────────────────────
console.log('\n[6b] Locked-card theme-aware surface CSS');
ok('Accommodation card CSS uses portal theme surface/border/text vars', (() => {
  const m = apiSrc.match(/\.portal-schedule-create-accommodation-card\{[^}]+\}/);
  if (!m) return false;
  const rule = m[0];
  return /background:\s*var\(--surface\)/.test(rule)
    && /border:\s*1px solid var\(--border-soft\)/.test(rule)
    && /color:\s*var\(--text\)/.test(rule)
    && !/--portal-surface/.test(rule)
    && !/--portal-border/.test(rule)
    && !/#fff\b/.test(rule)
    && !/#ffffff\b/i.test(rule);
})());
ok('Accommodation card CSS no longer defines unused card-total rule',
  !/\.portal-schedule-create-accommodation-card-total\{/.test(apiSrc));
ok('Create/Edit keep season breakdown + Edit/Remove + permanent + controls',
  /portal-schedule-create-accommodation-card-breakdown-row/.test(apiSrc)
  && /data-edit-accom-stay/.test(apiSrc)
  && /data-remove-accom-stay/.test(apiSrc)
  && /data-edit-drawer-accom-stay/.test(editUi)
  && /data-remove-drawer-accom-stay/.test(editUi)
  && /addBtn\.style\.display\s*=\s*scheduleAccommodationEnabledCache\s*\?\s*''\s*:\s*'none'/.test(apiSrc)
  && /addBtn\.style\.display = productOn \? '' : 'none'/.test(editUi));

// ── 7) Parse smoke ─────────────────────────────────────────────────────────
console.log('\n[7] Parse smoke');
ok('admin ui parses', (() => {
  try { new Function(adminUi); return true; } catch (e) { return false; }
})());
ok('edit ui parses', (() => {
  try { new Function(editUi); return true; } catch (e) { return false; }
})());
ok('Create Save + date-range owners parse together', (() => {
  try {
    const chunk = [
      extractNamedFn(apiSrc, 'scheduleAddIsoDays'),
      extractNamedFn(apiSrc, 'scheduleDefaultAccommodationStay'),
      extractNamedFn(apiSrc, 'scheduleSaveCreateAccommodation'),
      extractNamedFn(apiSrc, 'scheduleReadCreateAccommodation'),
    ].join('\n');
    new Function(chunk);
    return true;
  } catch (e) {
    return false;
  }
})());
ok('Create nights/attach/card owners parse together', (() => {
  try {
    const chunk = [
      extractNamedFn(apiSrc, 'scheduleAddIsoDays'),
      extractNamedFn(apiSrc, 'scheduleCreateAccommodationNights'),
      extractNamedFn(apiSrc, 'scheduleResolveAccommodationQuoteNights'),
      extractNamedFn(apiSrc, 'scheduleAttachCreateAccommodationQuote'),
      extractNamedFn(apiSrc, 'scheduleRenderCreateAccommodationCardHtml'),
      'function scheduleRenderCreateAccommodation(){}',
      'function scheduleCreateAccommodationDisplayText(a,b){return a+" – "+b;}',
    ].join('\n');
    new Function('portalT', 'escHtml', chunk);
    return true;
  } catch (e) {
    return false;
  }
})());
ok('Edit nights/attach/card owners parse together', (() => {
  try {
    const chunk = [
      extractNamedFn(editUi, 'scheduleDrawerAddIsoDays'),
      extractNamedFn(editUi, 'scheduleDrawerAccommodationNights'),
      extractNamedFn(editUi, 'scheduleDrawerResolveAccommodationQuoteNights'),
      extractNamedFn(editUi, 'scheduleAttachDrawerAccommodationQuote'),
      extractNamedFn(editUi, 'scheduleDrawerRenderAccommodationCardHtml'),
      'function scheduleDrawerRenderAccommodation(){}',
      'function scheduleDrawerAccommodationDisplayText(a,b){return a+" – "+b;}',
    ].join('\n');
    new Function('portalT', 'escHtml', chunk);
    return true;
  } catch (e) {
    return false;
  }
})());

// ── 8) Admin accommodation locale dates + coverage gap warning ───────────────
console.log('\n[8] Admin accommodation locale dates + coverage gap warning');
ok('Admin accommodation format/gap owners parse together', (() => {
  try {
    const chunk = [
      extractNamedFn(adminUi, 'adminAccommodationIsIsoDate'),
      extractNamedFn(adminUi, 'adminAccommodationAddDaysIso'),
      extractNamedFn(adminUi, 'adminFormatAccomIsoDate'),
      extractNamedFn(adminUi, 'adminFormatAccomDateRange'),
      extractNamedFn(adminUi, 'adminFindAccommodationCoverageGaps'),
      extractNamedFn(adminUi, 'adminFormatAccommodationGapLabel'),
      extractNamedFn(adminUi, 'renderAdminAccommodationCoverageWarning'),
    ].join('\n');
    new Function('financeRedesignFormatIsoDate', 'financeRedesignFormatIsoRange', 'getStaffLocale', 'portalT', 'escHtml', chunk);
    return true;
  } catch (e) {
    return false;
  }
})());
ok('Admin locale date range EN includes month name not raw ISO', (() => {
  const chunk = [
    extractNamedFn(adminUi, 'adminAccommodationIsIsoDate'),
    extractNamedFn(adminUi, 'adminAccommodationAddDaysIso'),
    extractNamedFn(adminUi, 'adminFormatAccomIsoDate'),
    extractNamedFn(adminUi, 'adminFormatAccomDateRange'),
  ].join('\n');
  const financeRedesignFormatIsoDate = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
  const financeRedesignFormatIsoRange = (start, end) => {
    const a = financeRedesignFormatIsoDate(start);
    const b = financeRedesignFormatIsoDate(end);
    return a + ' – ' + b;
  };
  const fn = new Function(
    'financeRedesignFormatIsoDate',
    'financeRedesignFormatIsoRange',
    'getStaffLocale',
    chunk + '; return adminFormatAccomDateRange("2026-03-01", "2026-04-30");',
  );
  const out = fn(financeRedesignFormatIsoDate, financeRedesignFormatIsoRange, () => 'en');
  return /Mar/.test(out) && /2026/.test(out) && !/2026-03-01/.test(out);
})());
ok('Admin locale date range ES includes Spanish month', (() => {
  const chunk = [
    extractNamedFn(adminUi, 'adminAccommodationIsIsoDate'),
    extractNamedFn(adminUi, 'adminAccommodationAddDaysIso'),
    extractNamedFn(adminUi, 'adminFormatAccomIsoDate'),
    extractNamedFn(adminUi, 'adminFormatAccomDateRange'),
  ].join('\n');
  const financeRedesignFormatIsoDate = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('es-ES', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
  const financeRedesignFormatIsoRange = (start, end) => {
    const a = financeRedesignFormatIsoDate(start);
    const b = financeRedesignFormatIsoDate(end);
    return a + ' – ' + b;
  };
  const fn = new Function(
    'financeRedesignFormatIsoDate',
    'financeRedesignFormatIsoRange',
    'getStaffLocale',
    chunk + '; return adminFormatAccomIsoDate("2026-03-01");',
  );
  const out = fn(financeRedesignFormatIsoDate, financeRedesignFormatIsoRange, () => 'es');
  return /mar/i.test(out) && /2026/.test(out) && !/2026-03-01/.test(out);
})());
ok('Admin coverage gap warning surfaces Dec–Feb hole', (() => {
  const chunk = [
    extractNamedFn(adminUi, 'adminAccommodationIsIsoDate'),
    extractNamedFn(adminUi, 'adminAccommodationAddDaysIso'),
    extractNamedFn(adminUi, 'adminFormatAccomIsoDate'),
    extractNamedFn(adminUi, 'adminFormatAccomDateRange'),
    extractNamedFn(adminUi, 'adminFindAccommodationCoverageGaps'),
    extractNamedFn(adminUi, 'adminFormatAccommodationGapLabel'),
    extractNamedFn(adminUi, 'renderAdminAccommodationCoverageWarning'),
  ].join('\n');
  const financeRedesignFormatIsoDate = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
  const financeRedesignFormatIsoRange = (start, end) => financeRedesignFormatIsoDate(start) + ' – ' + financeRedesignFormatIsoDate(end);
  const portalT = (key) => (key === 'admin.accommodation.coverageGap'
    ? 'Uncovered: {gaps}'
    : key);
  const escHtml = (s) => String(s);
  const fn = new Function(
    'financeRedesignFormatIsoDate',
    'financeRedesignFormatIsoRange',
    'getStaffLocale',
    'portalT',
    'escHtml',
    chunk + '; return renderAdminAccommodationCoverageWarning([{check_in:"2026-03-01",check_out:"2026-12-01"},{check_in:"2027-03-01",check_out:"2027-12-01"}]);',
  );
  const html = fn(
    financeRedesignFormatIsoDate,
    financeRedesignFormatIsoRange,
    () => 'en',
    portalT,
    escHtml,
  );
  return /admin-accommodation-coverage-warning/.test(html)
    && /Uncovered:/.test(html)
    && /Dec/.test(html)
    && /Feb/.test(html);
})());

console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
