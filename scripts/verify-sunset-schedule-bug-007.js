'use strict';

/**
 * BUG-007 — Clientes Filters Esc, Finanzas Custom arrows, payment labels.
 * Stay off inbox-thread.js, email-settings, language packs, production.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const filters = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-customers-filters.js'), 'utf8');
const profile = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-customers-profile.js'), 'utf8');
const admin = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');

assert.ok(filters.includes('function positionCustomersFiltersMenu'));
assert.ok(profile.includes("ev.key !== 'Escape'"));
assert.ok(profile.includes('closeCustomersFiltersMenu()'));
assert.ok(!admin.includes("if (g === 'custom') return;"));
assert.ok(admin.includes('financeInclusiveDayCount'));
assert.ok(admin.includes('financeAddDaysIso'));
assert.ok(admin.includes('financeCustomMonthTitle'));
assert.ok(profile.includes('function customerPaymentStatusLabel'));
assert.ok(profile.includes('customerPaymentStatusLabel(b.payment_status'));
assert.ok(!filters.includes('inbox-thread.js'));
assert.ok(!profile.includes('inbox-thread.js'));
assert.ok(!admin.includes('staff-email-settings-routes'));

const start = profile.indexOf('function customerPaymentStatusLabel');
const end = profile.indexOf('function customerBookingDateLabel');
const box = { portalT: (k) => k, portalLang: 'en' };
vm.createContext(box);
vm.runInContext(profile.slice(start, end) + '\nthis.customerPaymentStatusLabel = customerPaymentStatusLabel;', box);
assert.strictEqual(box.customerPaymentStatusLabel('paid'), 'Paid');
assert.strictEqual(box.customerPaymentStatusLabel('deposit_paid'), 'Partial');
assert.strictEqual(box.customerPaymentStatusLabel('waiting_payment'), 'Unpaid');
assert.strictEqual(box.customerPaymentStatusLabel('paid_in_full'), 'Paid');
assert.strictEqual(box.customerPaymentStatusLabel('pending_deposit'), 'Unpaid');
assert.notStrictEqual(box.customerPaymentStatusLabel('paid'), 'paid');
assert.ok(!/_/.test(box.customerPaymentStatusLabel('paid_in_full')));
box.portalLang = 'es';
assert.strictEqual(box.customerPaymentStatusLabel('paid'), 'Pagado');
assert.strictEqual(box.customerPaymentStatusLabel('pending_deposit'), 'Sin pagar');
assert.strictEqual(box.customerPaymentStatusLabel('paid_in_full'), 'Pagado');

const aStart = admin.indexOf('function financeAddDaysIso');
const aEnd = admin.indexOf('function financeShiftAnchor');
const abox = {
  financeDateIsValidIso(iso) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''));
  },
};
vm.createContext(abox);
vm.runInContext(admin.slice(aStart, aEnd) + '\nthis.financeAddDaysIso = financeAddDaysIso;\nthis.financeInclusiveDayCount = financeInclusiveDayCount;', abox);
assert.strictEqual(abox.financeAddDaysIso('2026-08-01', 15), '2026-08-16');
assert.strictEqual(abox.financeInclusiveDayCount('2026-08-01', '2026-08-15'), 15);

console.log('PASS BUG-007 filters Esc + custom arrows + payment labels');
