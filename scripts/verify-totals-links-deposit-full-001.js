#!/usr/bin/env node
'use strict';

/**
 * TOTALS-LINKS-DEPOSIT-FULL-001
 * Invoice Totals create buttons and the link that replaces them say
 * Deposit and Full. Booking-dropdown Deposit Link / Payment Link stays.
 */

const fs = require('fs');
const path = require('path');

const invoice = fs.readFileSync(path.join(__dirname, 'browser/booking-invoice.js'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
let pass = 0;
let fail = 0;
function ok(label, cond) {
  if (cond) { console.log('  PASS  ' + label); pass += 1; return; }
  console.error('  FAIL  ' + label);
  fail += 1;
}

console.log('\nverify-totals-links-deposit-full-001\n');

ok('totals button uses Deposit', invoice.includes("bcInvoiceText(deposit ? 'guestDeposit' : 'guestFull')"));
ok('created totals link uses Deposit and Full', invoice.includes("bcInvoiceText(target === 'deposit' ? 'guestDeposit' : 'guestFull')"));
ok('totals no longer say Deposit Link', !invoice.includes("deposit ? 'depositLink' : 'paymentLink'"));
ok('dropdown still says Deposit Link', api.includes("paymentTarget === 'deposit' ? t('drawer.invoice.depositLink') : t('drawer.invoice.paymentLink')"));
ok('per-guest row still says Deposit and Full', api.includes("t('drawer.invoice.guestDeposit')") && api.includes("t('drawer.invoice.guestFull')"));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
