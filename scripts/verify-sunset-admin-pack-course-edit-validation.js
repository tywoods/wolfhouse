'use strict';

/**
 * Bug Finder #8 — Group course (Precios) edit inline validation.
 *
 * Invalid group size (<1) or start>=end must show inline errors and disable Guardar.
 *
 * Run: node scripts/verify-sunset-admin-pack-course-edit-validation.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { getSunsetAdminBrowserHelperSource } = require('./lib/sunset-admin-ui-helpers');
const { getSunsetAdminUiBrowserSource } = require('./lib/sunset-admin-browser-source');

const ROOT = path.join(__dirname, '..');
const ADMIN_UI = path.join(ROOT, 'scripts/browser/sunset-admin-ui.js');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return true;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
  return false;
}

function buildPortalT() {
  const es = require('./lib/staff-portal-i18n-es-sunset');
  const en = require('./lib/staff-portal-i18n');
  const map = Object.assign({}, en, es);
  return function portalT(key, fallback) {
    return map[key] || fallback || key;
  };
}

function makeInput(id, value, attrs) {
  attrs = attrs || {};
  return {
    id,
    value: String(value == null ? '' : value),
    getAttribute(k) { return attrs[k] != null ? String(attrs[k]) : null; },
    setAttribute() {},
    removeAttribute() {},
  };
}

function makeFormRoot(html, packId) {
  const byId = {};
  const fieldErrors = {};
  const saveBtns = [];
  const inputRe = /id="([^"]+)"[^>]*value="([^"]*)"/g;
  let m;
  while ((m = inputRe.exec(html))) {
    byId[m[1]] = makeInput(m[1], m[2]);
  }
  const groupSizeRe = /id="([^"]+-group-size)"[^>]*value="([^"]*)"/;
  const gs = groupSizeRe.exec(html);
  if (gs) byId[gs[1]] = makeInput(gs[1], gs[2], { 'data-admin-pack-validate': 'group-size' });

  const scheduleRe = /id="(admin-pack-[^"]+-schedule-(?:start2?|end2?))"[^>]*value="([^"]*)"/g;
  while ((m = scheduleRe.exec(html))) {
    byId[m[1]] = makeInput(m[1], m[2], { 'data-admin-pack-validate': 'schedule' });
  }

  return {
    getAttribute(k) { return k === 'data-admin-pack-form' ? packId : null; },
    querySelector(sel) {
      const errMatch = /\[data-admin-pack-field-error="([^"]+)"\]/.exec(sel);
      if (errMatch) {
        if (!fieldErrors[errMatch[1]]) {
          fieldErrors[errMatch[1]] = { textContent: '', style: { display: 'none' } };
        }
        return fieldErrors[errMatch[1]];
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel.indexOf('save-pack') >= 0 || sel.indexOf('save-new-pack') >= 0) {
        return {
          length: saveBtns.length,
          item(i) { return saveBtns[i]; },
          0: saveBtns[0],
        };
      }
      return { length: 0 };
    },
    _byId: byId,
    _fieldErrors: fieldErrors,
    _saveBtn: (function() {
      const btn = { disabled: false };
      saveBtns.push(btn);
      return btn;
    })(),
  };
}

function loadAdminRuntime(opts) {
  const elements = Object.assign({}, (opts && opts.elements) || {});
  const forms = (opts && opts.forms) || {};
  const sandbox = {
    console,
    document: {
      querySelector(sel) {
        if (sel.indexOf('[data-admin-pack-form="') === 0) {
          const id = sel.slice('[data-admin-pack-form="'.length, -2);
          return forms[id] || null;
        }
        return null;
      },
      querySelectorAll(sel) {
        if (sel === '[data-admin-pack-form]') {
          const keys = Object.keys(forms);
          return {
            length: keys.length,
            item(i) { return forms[keys[i]]; },
          };
        }
        return { length: 0 };
      },
    },
    portalT: buildPortalT(),
    escHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
    el(id) {
      for (const form of Object.values(forms)) {
        if (form._byId[id]) return form._byId[id];
      }
      return elements[id] || null;
    },
    getClient() { return 'sunset'; },
    getSunsetLocation() { return 'somo'; },
    adminCfgWritesEnabled() { return true; },
    adminEditTarget: (opts && opts.editTarget) || null,
    adminConfigCache: null,
    SUNSET_SCHEDULE_LESSON_DAY_CAP: 16,
    adminCollectSinglePill() { return '12_and_up'; },
    adminCollectPillValues() { return ['somo']; },
    adminReadEquipmentOptions() { return { ok: true, value: [] }; },
    adminReadPackTierRows() { return [{ key: '1_day', amount: '25.00' }]; },
    adminPackTierDurations() {
      return [{ key: '1_day', label: '1 day', hours: 2 }];
    },
    adminParseEurosToCents(text) {
      const n = Number(String(text || '').replace(',', '.').trim());
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'bad amount' };
      return { ok: true, value: Math.round(n * 100) };
    },
    adminEurosFromAmount(n) {
      const v = Number(n);
      if (!Number.isFinite(v)) return '';
      return (Math.round(v * 100) / 100).toFixed(2);
    },
    adminPeriodLabel(k) { return String(k || '').replace('_', ' '); },
    adminLessonAgeLabel() { return '12+'; },
    adminRenderPillRow() { return ''; },
    adminRenderEquipmentEditor() { return ''; },
    adminRenderPackTierFields() { return ''; },
    adminPackBeachOptions() { return []; },
    adminPackWeeklyPillOptions() { return []; },
    adminPackAgeOptions() { return []; },
    adminDefaultPackSeed() {
      return {
        label: 'Curso Matutino',
        group_size: 8,
        schedules: ['0930_1130'],
        price_tiers: [{ key: '1_day', amount_cents: 2500 }],
      };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(getSunsetAdminBrowserHelperSource(), sandbox);
  vm.runInContext(getSunsetAdminUiBrowserSource(), sandbox);
  return sandbox;
}

function runStaticChecks() {
  console.log('\n[1] Source contracts (inline pack course edit validation)\n');
  const src = fs.readFileSync(ADMIN_UI, 'utf8');
  assert('defines adminValidatePackFormState', /function adminValidatePackFormState\s*\(/.test(src));
  assert('defines adminSyncPackFormValidation', /function adminSyncPackFormValidation\s*\(/.test(src));
  assert('defines adminWirePackFormValidation', /function adminWirePackFormValidation\s*\(/.test(src));
  assert('group size field has inline error host', /data-admin-pack-field-error="group-size"/.test(src));
  assert('schedule block has inline error host', /data-admin-pack-field-error="schedule"/.test(src));
  assert('save-pack checks adminValidatePackFormState before submit',
    /action === 'save-pack'[\s\S]{0,500}adminValidatePackFormState/.test(src));
  assert('adminReadPackFormPayload exposes _groupSizeError',
    /_groupSizeError:/.test(src));
  assert('no silent group_size default to 16 on read',
    !/group_size:[\s\S]{0,120}\? n : 16/.test(src));
}

function runValidationProofs() {
  console.log('\n[2] VM proofs — invalid values block Guardar with inline errors\n');
  const pack = {
    label: 'Curso Matutino',
    group_size: 8,
    schedules: ['0930_1130'],
    price_tiers: [{ key: '1_day', amount_cents: 2500 }],
  };
  const sandbox = loadAdminRuntime();
  const html = sandbox.adminRenderPackEditForm('matutino', pack);
  const form = makeFormRoot(html, 'matutino');
  const forms = { matutino: form };
  sandbox.document.querySelector = (sel) => {
    if (sel === '[data-admin-pack-form="matutino"]') return form;
    return null;
  };
  sandbox.el = (id) => {
    if (form._byId[id]) return form._byId[id];
    return null;
  };
  sandbox.adminPackFormRoot = (pid) => forms[pid || 'new'] || null;

  // Valid baseline
  let state = sandbox.adminSyncPackFormValidation('matutino');
  assert('valid course keeps Guardar enabled', state.ok === true && form._saveBtn.disabled === false);

  // Invalid group size
  form._byId['admin-pack-matutino-group-size'].value = '-5';
  state = sandbox.adminSyncPackFormValidation('matutino');
  assert('negative group size invalid', state.ok === false && !!state.errors.groupSize);
  assert('negative group size disables Guardar', form._saveBtn.disabled === true);
  assert('negative group size shows inline error',
    form._fieldErrors['group-size'].style.display === 'block'
      && form._fieldErrors['group-size'].textContent.length > 0);

  // Restore group size; invalid schedule (start >= end)
  form._byId['admin-pack-matutino-group-size'].value = '8';
  form._byId['admin-pack-matutino-schedule-start'].value = '18:00';
  form._byId['admin-pack-matutino-schedule-end'].value = '12:00';
  state = sandbox.adminSyncPackFormValidation('matutino');
  assert('start>=end schedule invalid', state.ok === false && !!state.errors.schedule);
  assert('start>=end disables Guardar', form._saveBtn.disabled === true);
  assert('start>=end shows inline schedule error',
    form._fieldErrors.schedule.style.display === 'block'
      && String(form._fieldErrors.schedule.textContent || '').length > 0);

  // Payload must not silently coerce invalid group size
  form._byId['admin-pack-matutino-group-size'].value = '-5';
  const badPayload = sandbox.adminReadPackFormPayload('matutino');
  assert('read payload has _groupSizeError when group size invalid', !!badPayload._groupSizeError);
  assert('read payload does not coerce invalid group_size to 16', badPayload.group_size !== 16);
}

function main() {
  console.log('verify-sunset-admin-pack-course-edit-validation');
  runStaticChecks();
  runValidationProofs();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('PASS focused pack course edit inline validation');
}

main();
