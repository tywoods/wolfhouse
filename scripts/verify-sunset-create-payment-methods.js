'use strict';

/**
 * verify:sunset-create-payment-methods
 *
 * BOOKING-PAYMENT-METHOD-001 — Create-booking Paid methods + invoice.
 * Offline only. No DB / Azure / network / inbox / Admin Email.
 *
 * Run: node scripts/verify-sunset-create-payment-methods.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const enSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const esSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');
const writesSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-writes.js'), 'utf8');
const actionsSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-actions.js'), 'utf8');
const viewSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-view-ui.js'), 'utf8');
const editSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-edit-ui.js'), 'utf8');
const inboxThreadSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'), 'utf8');
const emailUiSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js'), 'utf8');
const writes = require('./lib/sunset-schedule-booking-writes');

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

function extractFn(src, name) {
  const needle = 'function ' + name + '(';
  const start = src.indexOf(needle);
  if (start < 0) return null;
  const brace = src.indexOf('{', start);
  if (brace < 0) return null;
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function extractCreateModalHtml(src) {
  const start = src.indexOf('id="ps-create-modal"');
  if (start < 0) return '';
  const open = src.lastIndexOf('<div', start);
  const end = src.indexOf('id="ps-drawer-backdrop"', open);
  const close = src.lastIndexOf('</div>', end);
  return src.slice(open, close > open ? close + 6 : end);
}

function evalParse(raw) {
  const fn = extractFn(apiSrc, 'scheduleParseCreatePaymentChoice');
  const sb = { result: null };
  vm.runInNewContext(fn + '\nresult = scheduleParseCreatePaymentChoice(' + JSON.stringify(raw) + ');', sb, { timeout: 1000 });
  return sb.result;
}

console.log('\nverify:sunset-create-payment-methods\n');

console.log('[1] Create drawer has unpaid + three Paid methods');
const modal = extractCreateModalHtml(apiSrc);
const payChunkStart = modal.indexOf('id="ps-create-payment"');
ok('create payment select present', payChunkStart >= 0);
const payChunk = payChunkStart >= 0 ? modal.slice(payChunkStart, payChunkStart + 900) : '';
ok('keeps Unpaid', /value="unpaid"[^>]*data-i18n="schedule\.payment\.unpaid"/.test(payChunk)
  && />Unpaid</.test(payChunk));
ok('Paid - Stripe option', /value="paid_via_link"[^>]*data-i18n="schedule\.payment\.paidViaLink"/.test(payChunk)
  && /Paid - Stripe/.test(payChunk));
ok('Paid - Bank Transfer option', /value="paid_bank_transfer"[^>]*data-i18n="schedule\.payment\.paidBankTransfer"/.test(payChunk)
  && /Paid - Bank Transfer/.test(payChunk));
ok('Paid - Cash option', /value="paid_in_store"[^>]*data-i18n="schedule\.payment\.paidInStore"/.test(payChunk)
  && /Paid - Cash/.test(payChunk));
ok('no bare Paid option in create select', !/<option value="paid"/.test(payChunk));
ok('pending not invented on create select', !/value="pending"/.test(payChunk));
ok('create uses #632 enum values (link/bank/in_store)',
  /paid_via_link/.test(payChunk) && /paid_bank_transfer/.test(payChunk) && /paid_in_store/.test(payChunk));

console.log('\n[2] Payload maps UI choice → payment_status + payment_method');
ok('parse helper extractable', !!extractFn(apiSrc, 'scheduleParseCreatePaymentChoice'));
ok('unpaid → unpaid/null', (() => {
  const r = evalParse('unpaid');
  return r && r.payment_status === 'unpaid' && r.payment_method == null;
})());
ok('pending kept', (() => {
  const r = evalParse('pending');
  return r && r.payment_status === 'pending' && r.payment_method == null;
})());
ok('Paid - Stripe → paid + link', (() => {
  const r = evalParse('paid_via_link');
  return r && r.payment_status === 'paid' && r.payment_method === 'link';
})());
ok('Paid - Bank Transfer → paid + bank_transfer', (() => {
  const r = evalParse('paid_bank_transfer');
  return r && r.payment_status === 'paid' && r.payment_method === 'bank_transfer';
})());
ok('Paid - Cash → paid + in_store', (() => {
  const r = evalParse('paid_in_store');
  return r && r.payment_status === 'paid' && r.payment_method === 'in_store';
})());
ok('legacy paid still paid without method', (() => {
  const r = evalParse('paid');
  return r && r.payment_status === 'paid' && r.payment_method == null;
})());
const readFn = extractFn(apiSrc, 'scheduleReadCreatePayload');
ok('create payload sends payment_method', !!readFn && /payment_method:\s*paymentMethod/.test(readFn));
ok('create payload still sends payment_status (not UI composite)',
  !!readFn && /payment_status:\s*payment/.test(readFn)
  && !/payment_status:\s*el\('ps-create-payment'\)/.test(readFn));

console.log('\n[3] Persist reuses #632 enum on booking metadata');
ok('normalizeSunsetPaidMethod exported', typeof writes.normalizeSunsetPaidMethod === 'function');
ok('allowlist is bank_transfer / in_store / link',
  writes.SUNSET_PAID_METHODS && writes.SUNSET_PAID_METHODS.has('bank_transfer')
  && writes.SUNSET_PAID_METHODS.has('in_store')
  && writes.SUNSET_PAID_METHODS.has('link')
  && writes.SUNSET_PAID_METHODS.size === 3);
ok('link / bank_transfer / in_store pass through',
  writes.normalizeSunsetPaidMethod('link') === 'link'
  && writes.normalizeSunsetPaidMethod('bank_transfer') === 'bank_transfer'
  && writes.normalizeSunsetPaidMethod('in_store') === 'in_store');
ok('cash/stripe aliases map into enum',
  writes.normalizeSunsetPaidMethod('cash') === 'in_store'
  && writes.normalizeSunsetPaidMethod('stripe') === 'link');
ok('garbage method dropped', writes.normalizeSunsetPaidMethod('bitcoin') == null);
ok('create writes sunset_payment_method from body payment_method',
  /sunset_payment_method:\s*paymentMethod/.test(writesSrc)
  && /normalizeSunsetPaidMethod\(bodyIn\.payment_method\)/.test(writesSrc));
ok('unpaid create stores null method',
  /input\.payment_status === 'paid'/.test(writesSrc)
  && /normalizeSunsetPaidMethod\(bodyIn\.payment_method\)/.test(writesSrc));
ok('drawer still reads sunset_payment_method for invoice/edit',
  /meta\.sunset_payment_method/.test(fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-drawer.js'), 'utf8')));

console.log('\n[4] Invoice shows the same Paid method labels');
ok('invoice status uses schedulePaymentStatusLabel(status, method)',
  /schedulePaymentStatusLabel\(\s*effStatus\s*,\s*ctx\s*&&\s*ctx\.payment_method\s*\)/.test(viewSrc)
  && /schedulePaymentStatusLabel\(\s*effStatus\s*,\s*ctx\s*&&\s*ctx\.payment_method\s*\)/.test(editSrc));
ok('label owner maps link → Paid - Stripe key',
  /method === 'link'\) return portalT\('schedule\.payment\.paidViaLink'\)/.test(actionsSrc));
ok('label owner maps bank_transfer → Paid - Bank Transfer key',
  /method === 'bank_transfer'\) return portalT\('schedule\.payment\.paidBankTransfer'\)/.test(actionsSrc));
ok('label owner maps in_store → Paid - Cash key',
  /method === 'in_store'\) return portalT\('schedule\.payment\.paidInStore'\)/.test(actionsSrc));

console.log('\n[5] EN/ES copy (drawer already i18n)');
ok('EN Paid - Stripe', /'schedule\.payment\.paidViaLink': 'Paid - Stripe'/.test(enSrc));
ok('EN Paid - Bank Transfer', /'schedule\.payment\.paidBankTransfer': 'Paid - Bank Transfer'/.test(enSrc));
ok('EN Paid - Cash', /'schedule\.payment\.paidInStore': 'Paid - Cash'/.test(enSrc));
ok('ES Pagado - Stripe', /'schedule\.payment\.paidViaLink': 'Pagado - Stripe'/.test(esSrc));
ok('ES Pagado - Transferencia', /'schedule\.payment\.paidBankTransfer': 'Pagado - Transferencia'/.test(esSrc));
ok('ES Pagado - Efectivo', /'schedule\.payment\.paidInStore': 'Pagado - Efectivo'/.test(esSrc));
ok('create select has data-i18n on all four options',
  (payChunk.match(/data-i18n="schedule\.payment\./g) || []).length === 4);

console.log('\n[6] Stay-off inbox / Admin Email / inbound');
ok('did not edit inbox-thread.js this slice',
  !/paid_via_link|Paid - Stripe|Paid - Cash/.test(inboxThreadSrc));
ok('did not edit Admin Email chrome this slice',
  !/paid_via_link|Paid - Stripe|Paid - Cash/.test(emailUiSrc));
ok('create HTML is schedule create drawer only',
  /data-create-section="payment"/.test(modal) && /id="ps-create-payment"/.test(modal));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
