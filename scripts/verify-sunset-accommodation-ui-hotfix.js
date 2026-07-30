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
    && /scheduleCreateAccommodation\s*=\s*\{/.test(saveFn);
})());
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
  makeEl('ps-create-accommodation-add-btn', { style: { display: 'none' } });
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
  let footerCalls = 0;
  const fns = [
    extractNamedFn(apiSrc, 'scheduleAddIsoDays'),
    extractNamedFn(apiSrc, 'scheduleCreateAccommodationDisplayText'),
    extractNamedFn(apiSrc, 'scheduleSyncCreateAccomDateRangeUi'),
    extractNamedFn(apiSrc, 'scheduleCreateAccomDateRangeIsOpen'),
    extractNamedFn(apiSrc, 'scheduleCreateAccomDateRangeClosePopover'),
    extractNamedFn(apiSrc, 'scheduleCreateAccomDateRangeSeedDraft'),
    extractNamedFn(apiSrc, 'scheduleRenderCreateAccommodation'),
    extractNamedFn(apiSrc, 'scheduleSyncCreateAccommodationFromDom'),
    extractNamedFn(apiSrc, 'scheduleSaveCreateAccommodation'),
    extractNamedFn(apiSrc, 'scheduleReadCreateAccommodation'),
  ].filter(Boolean);
  ok('extracted Create accommodation Save chain', fns.length >= 6, 'got ' + fns.length);

  let scheduleCreateAccommodation = {
    enabled: true, check_in: '2026-07-28', check_out: '2026-07-31',
  };
  let scheduleCreateAccommodationEditorOpen = true;
  let scheduleCreateAccomDateRangeDraft = { start: '2026-07-28', end: '2026-07-31' };
  let scheduleCreateAccomDateRangeViewYm = '2026-07';
  let scheduleCreateAccomDateRangeFocusIso = null;
  let scheduleCreateAccomDateRangeRestoreFocus = false;
  const scheduleAccommodationEnabledCache = true;

  // eslint-disable-next-line no-new-func
  const sandboxed = new Function(
    'el', 'portalT', 'escHtml',
    'get_scheduleCreateAccommodation', 'set_scheduleCreateAccommodation',
    'get_scheduleCreateAccommodationEditorOpen', 'set_scheduleCreateAccommodationEditorOpen',
    'get_scheduleCreateAccomDateRangeDraft', 'set_scheduleCreateAccomDateRangeDraft',
    'get_scheduleCreateAccomDateRangeViewYm', 'set_scheduleCreateAccomDateRangeViewYm',
    'get_scheduleCreateAccomDateRangeFocusIso', 'set_scheduleCreateAccomDateRangeFocusIso',
    'get_scheduleCreateAccomDateRangeRestoreFocus', 'set_scheduleCreateAccomDateRangeRestoreFocus',
    'scheduleAccommodationEnabledCache',
    'schedulePortalSyncCreateFooter',
    'scheduleCreateDateRangeIsValidIso',
    'scheduleCreateDateRangeDisplayText',
    'scheduleCreateDateRangeSelectDay',
    fns.join('\n')
    + '\n'
    + 'Object.defineProperty(this, "scheduleCreateAccommodation", {'
    + '  get: get_scheduleCreateAccommodation, set: set_scheduleCreateAccommodation, configurable: true });\n'
    + 'Object.defineProperty(this, "scheduleCreateAccommodationEditorOpen", {'
    + '  get: get_scheduleCreateAccommodationEditorOpen, set: set_scheduleCreateAccommodationEditorOpen, configurable: true });\n'
    // Simpler: re-bind via with-like eval — use direct assignment wrappers instead.
    + 'return {\n'
    + '  scheduleSaveCreateAccommodation: scheduleSaveCreateAccommodation,\n'
    + '  scheduleReadCreateAccommodation: scheduleReadCreateAccommodation,\n'
    + '  scheduleRenderCreateAccommodation: scheduleRenderCreateAccommodation,\n'
    + '};\n',
  );

  // Simpler direct eval sandbox with shared mutable state bag
  const state = {
    scheduleCreateAccommodation,
    scheduleCreateAccommodationEditorOpen,
    scheduleCreateAccomDateRangeDraft,
    scheduleCreateAccomDateRangeViewYm,
    scheduleCreateAccomDateRangeFocusIso,
    scheduleCreateAccomDateRangeRestoreFocus,
    scheduleAccommodationEnabledCache: true,
  };

  function el(id) { return nodes[id] || null; }
  function portalT(k) {
    if (k === 'schedule.create.accommodation.invalidStay') return 'invalid stay';
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

  // Build a scope-friendly script that uses `state.` for mutables
  const rewrite = (src) => String(src || '')
    .replace(/\bscheduleCreateAccommodationEditorOpen\b/g, 'state.scheduleCreateAccommodationEditorOpen')
    .replace(/\bscheduleCreateAccommodation\b/g, 'state.scheduleCreateAccommodation')
    .replace(/\bscheduleCreateAccomDateRangeDraft\b/g, 'state.scheduleCreateAccomDateRangeDraft')
    .replace(/\bscheduleCreateAccomDateRangeViewYm\b/g, 'state.scheduleCreateAccomDateRangeViewYm')
    .replace(/\bscheduleCreateAccomDateRangeFocusIso\b/g, 'state.scheduleCreateAccomDateRangeFocusIso')
    .replace(/\bscheduleCreateAccomDateRangeRestoreFocus\b/g, 'state.scheduleCreateAccomDateRangeRestoreFocus')
    .replace(/\bscheduleAccommodationEnabledCache\b/g, 'state.scheduleAccommodationEnabledCache');

  const body = [
    extractNamedFn(apiSrc, 'scheduleAddIsoDays'),
    extractNamedFn(apiSrc, 'scheduleCreateAccommodationDisplayText'),
    extractNamedFn(apiSrc, 'scheduleSyncCreateAccomDateRangeUi'),
    extractNamedFn(apiSrc, 'scheduleCreateAccomDateRangeIsOpen'),
    extractNamedFn(apiSrc, 'scheduleCreateAccomDateRangeSeedDraft'),
    extractNamedFn(apiSrc, 'scheduleCreateAccomDateRangeClosePopover'),
    extractNamedFn(apiSrc, 'scheduleRenderCreateAccommodation'),
    extractNamedFn(apiSrc, 'scheduleSyncCreateAccommodationFromDom'),
    extractNamedFn(apiSrc, 'scheduleSaveCreateAccommodation'),
    extractNamedFn(apiSrc, 'scheduleReadCreateAccommodation'),
  ].filter(Boolean).map(rewrite).join('\n');

  // eslint-disable-next-line no-new-func
  const run = new Function(
    'state', 'el', 'portalT', 'escHtml',
    'scheduleCreateDateRangeIsValidIso', 'scheduleCreateDateRangeDisplayText',
    'schedulePortalSyncCreateFooter',
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
  );

  const saved = api.save();
  ok('Save returns true for valid half-open stay', saved === true);
  ok('Save collapses editor', state.scheduleCreateAccommodationEditorOpen === false);
  ok('Save retains selection in state',
    state.scheduleCreateAccommodation
    && state.scheduleCreateAccommodation.enabled === true
    && state.scheduleCreateAccommodation.check_in === '2026-07-28'
    && state.scheduleCreateAccommodation.check_out === '2026-07-31');
  const payload = api.read();
  ok('Read payload has committed dates (no client money)',
    payload
    && payload.enabled === true
    && payload.check_in === '2026-07-28'
    && payload.check_out === '2026-07-31'
    && payload.amount_cents == null
    && payload.total_cents == null);
  ok('Save synced footer/quote intent only (not submit)', footerSync >= 1 && submitCalls === 0);
  ok('Editor hidden after save; summary shown',
    nodes['ps-create-accommodation-editor'].style.display === 'none'
    && nodes['ps-create-accommodation-summary'].style.display === '');
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
    && /scheduleDrawerAccommodation\s*=\s*\{/.test(saveFn);
})());
ok('Edit reuses booking date-range pure helpers',
  /scheduleCreateDateRangeSelectDay/.test(editUi)
  && /scheduleCreateDateRangeDisplayText/.test(editUi));
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

// ── 6) Parse smoke ─────────────────────────────────────────────────────────
console.log('\n[6] Parse smoke');
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

console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
