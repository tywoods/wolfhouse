'use strict';

/**
 * Bug Finder P1 — Negative / non-sane rental Amount rejected (client + server).
 *
 * Pricing → Create rental: Amount `-25` must not leave Save enabled; API must
 * reject negative amount_cents if the UI is bypassed.
 *
 * Run: node scripts/verify-sunset-rental-amount-validation.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  validateAmountCents,
  validatePriceCreateBody,
  validatePricePatchBody,
  MAX_RENTAL_AMOUNT_CENTS,
} = require('./lib/tenant-admin-writes');
const { getSunsetAdminUiBrowserSource } = require('./lib/sunset-admin-browser-source');
const { getSunsetAdminBrowserHelperSource } = require('./lib/sunset-admin-ui-helpers');

const ROOT = path.join(__dirname, '..');
const ADMIN_UI = path.join(ROOT, 'scripts/browser/sunset-admin-ui.js');
const WRITES = path.join(ROOT, 'scripts/lib/tenant-admin-writes.js');

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

function runServerChecks() {
  console.log('\n[1] Shared server amount gate (validateAmountCents + price bodies)\n');
  assert('MAX_RENTAL_AMOUNT_CENTS is €100,000 in cents', MAX_RENTAL_AMOUNT_CENTS === 10000000);
  assert('rejects negative cents', validateAmountCents(-2500).ok === false);
  assert('rejects non-integer', validateAmountCents(12.5).ok === false);
  assert('rejects absurd amount', validateAmountCents(MAX_RENTAL_AMOUNT_CENTS + 1).ok === false);
  assert('accepts zero when not requirePositive', validateAmountCents(0).ok === true);
  assert('rejects zero when requirePositive', validateAmountCents(0, { requirePositive: true }).ok === false);
  assert('accepts sellable amount', validateAmountCents(2500, { requirePositive: true }).ok === true
    && validateAmountCents(2500, { requirePositive: true }).value === 2500);

  const createNeg = validatePriceCreateBody({
    offering_key: 'kayak_rental',
    period_window: '1_day',
    amount_cents: -2500,
  });
  assert('create body rejects negative amount_cents', createNeg.ok === false);

  const createHuge = validatePriceCreateBody({
    offering_key: 'kayak_rental',
    period_window: '1_day',
    amount_cents: MAX_RENTAL_AMOUNT_CENTS + 1,
  });
  assert('create body rejects non-sane amount_cents', createHuge.ok === false);

  const createOk = validatePriceCreateBody({
    offering_key: 'kayak_rental',
    period_window: '1_day',
    amount_cents: 2500,
  });
  assert('create body accepts positive amount', createOk.ok === true && createOk.patch.amount_cents === 2500);

  const patchNeg = validatePricePatchBody({ amount_cents: -1 });
  assert('patch body rejects negative amount_cents', patchNeg.ok === false);

  const patchOk = validatePricePatchBody({ amount_cents: 1800 });
  assert('patch body accepts non-negative amount', patchOk.ok === true && patchOk.patch.amount_cents === 1800);
}

function runSourceContracts() {
  console.log('\n[2] Client source contracts (live Save gate)\n');
  const src = fs.readFileSync(ADMIN_UI, 'utf8');
  const writesSrc = fs.readFileSync(WRITES, 'utf8');
  assert('client ADMIN_MAX_AMOUNT_CENTS matches server max',
    /ADMIN_MAX_AMOUNT_CENTS\s*=\s*10000000/.test(src)
      && /MAX_RENTAL_AMOUNT_CENTS\s*=\s*10000000/.test(writesSrc));
  assert('adminParseEurosToCents rejects leading minus',
    /charAt\(0\)\s*===\s*'-'/.test(src));
  assert('adminParseEurosToCents rejects above ADMIN_MAX_AMOUNT_CENTS',
    /cents\s*>\s*ADMIN_MAX_AMOUNT_CENTS/.test(src));
  assert('defines adminSyncNewEquipmentFormValidation',
    /function adminSyncNewEquipmentFormValidation\s*\(/.test(src));
  assert('defines adminWireRentalAmountValidation',
    /function adminWireRentalAmountValidation\s*\(/.test(src));
  assert('create form Save starts disabled',
    /data-admin-action="save-new-equipment"\s+disabled/.test(src));
  assert('create form has amount error host',
    /data-admin-equip-amount-error="new"/.test(src));
  assert('prices render wires + syncs rental amount validation',
    /adminWireRentalAmountValidation\(\)/.test(src)
      && /adminSyncOpenRentalAmountValidation\(\)/.test(src));
  assert('save-new-equipment still blocks via adminParseEurosToCents',
    /action === 'save-new-equipment'[\s\S]{0,800}adminParseEurosToCents/.test(src));
  assert('server exports validateAmountCents',
    /validateAmountCents,/.test(writesSrc) || /exports[\s\S]*validateAmountCents/.test(writesSrc));
}

function loadParserRuntime() {
  const amountInput = {
    id: 'admin-new-equip-amount',
    value: '',
    attrs: {},
    getAttribute(k) { return this.attrs[k] != null ? String(this.attrs[k]) : null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
  };
  const errEl = { textContent: '', style: { display: 'none' } };
  const saveBtn = { disabled: true };
  const form = {
    id: 'admin-add-equip-form',
    querySelector(sel) {
      if (sel.indexOf('save-new-equipment') >= 0) return saveBtn;
      if (sel.indexOf('data-admin-equip-amount-error') >= 0) return errEl;
      return null;
    },
  };
  const sandbox = {
    console,
    document: {
      querySelector() { return null; },
      querySelectorAll() { return { length: 0 }; },
    },
    portalT(key, fallback) {
      const map = {
        'admin.edit.amountRequired': 'Enter an amount.',
        'admin.edit.amountInvalid': 'Enter a valid non-negative amount.',
        'admin.edit.amountRequiredToEnable': 'Enter a positive amount to make this duration available.',
        'admin.edit.amountEur': 'Amount (€)',
        'admin.action.save': 'Save',
        'admin.action.cancel': 'Cancel',
        'admin.prices.equipmentName': 'Equipment name',
        'admin.prices.stock': 'Total stock',
      };
      return map[key] || fallback || key;
    },
    escHtml(s) { return String(s == null ? '' : s); },
    el(id) {
      if (id === 'admin-add-equip-form') return form;
      if (id === 'admin-new-equip-amount') return amountInput;
      if (id === 'tab-admin') return { dataset: {}, addEventListener() {} };
      return null;
    },
    getClient() { return 'sunset'; },
    getSunsetLocation() { return 'somo'; },
  };
  vm.createContext(sandbox);
  vm.runInContext(getSunsetAdminBrowserHelperSource(), sandbox);
  vm.runInContext(getSunsetAdminUiBrowserSource(), sandbox);
  return { sandbox, amountInput, saveBtn, errEl };
}

function runRuntimeChecks() {
  console.log('\n[3] Runtime: Create rental Amount `-25` disables Save\n');
  const { sandbox, amountInput, saveBtn, errEl } = loadParserRuntime();

  assert('parser rejects -25', sandbox.adminParseEurosToCents('-25').ok === false);
  assert('parser rejects unicode minus', sandbox.adminParseEurosToCents('\u221225').ok === false);
  assert('parser accepts 25.00', sandbox.adminParseEurosToCents('25.00').ok === true
    && sandbox.adminParseEurosToCents('25.00').value === 2500);
  assert('parser rejects absurd euros', sandbox.adminParseEurosToCents('100000.01').ok === false);

  amountInput.value = '-25';
  const negState = sandbox.adminSyncNewEquipmentFormValidation();
  assert('sync rejects -25', negState.ok === false);
  assert('Save disabled for -25', saveBtn.disabled === true);
  assert('inline error shown for -25', errEl.style.display === 'block' && !!errEl.textContent);
  assert('aria-invalid set for -25', amountInput.getAttribute('aria-invalid') === 'true');

  amountInput.value = '25';
  const okState = sandbox.adminSyncNewEquipmentFormValidation();
  assert('sync accepts 25', okState.ok === true);
  assert('Save enabled for valid amount', saveBtn.disabled === false);
  assert('inline error cleared', errEl.style.display === 'none');
}

function main() {
  console.log('verify-sunset-rental-amount-validation');
  runServerChecks();
  runSourceContracts();
  runRuntimeChecks();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main();
