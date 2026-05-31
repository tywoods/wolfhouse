'use strict';
/**
 * Stage 5.3 — Static verifier for payment-balances-query.js and staff-payment-queries.js.
 * Checks that all helpers exist, are SELECT-only, are client-scoped, and reference expected tables.
 * No DB connection required. Safe to run at any time.
 *
 * Usage: node scripts/verify-staff-payment-queries.js
 */

const balances = require('./lib/payment-balances-query');
const payments = require('./lib/staff-payment-queries');

const MUTATION_KEYWORDS = ['INSERT ', 'UPDATE ', 'DELETE ', 'TRUNCATE ', ' DROP ', ' ALTER ', ' CREATE '];

let errors = 0;

function check(label, sql) {
  if (typeof sql !== 'string' || sql.trim() === '') {
    console.error(`FAIL: ${label} returned empty SQL`);
    errors++;
    return;
  }
  const upper = sql.toUpperCase();
  for (const kw of MUTATION_KEYWORDS) {
    if (upper.includes(kw)) {
      console.error(`FAIL: ${label} contains mutation keyword "${kw.trim()}"`);
      errors++;
    }
  }
  if (!sql.includes('slug = $1') && !sql.includes('c.slug = $1')) {
    console.error(`FAIL: ${label} does not scope by client slug ($1)`);
    errors++;
  }
  console.log(`OK:   ${label}`);
}

// ── payment-balances-query ──────────────────────────────────────────────────

if (typeof balances.getPaymentBalancesQuery !== 'function') {
  console.error('FAIL: payment-balances-query does not export getPaymentBalancesQuery');
  errors++;
} else {
  const sql = balances.getPaymentBalancesQuery();
  check('getPaymentBalancesQuery', sql);
  const upper = sql.toUpperCase();
  if (!upper.includes('BOOKINGS')) {
    console.error('FAIL: getPaymentBalancesQuery does not reference bookings table');
    errors++;
  }
  if (!upper.includes('PAYMENTS')) {
    console.error('FAIL: getPaymentBalancesQuery does not reference payments table');
    errors++;
  }
}

// ── staff-payment-queries ───────────────────────────────────────────────────

const REQUIRED_PAYMENT_EXPORTS = [
  'getDepositPaidQuery',
  'getFullyPaidQuery',
  'getBalanceDueQuery',
  'getNoPaymentRecordQuery',
  'getWaitingPaymentQuery',
  'getConfirmationNeededQuery',
  'getPaymentClaimedNoRecordQuery',
];

// Queries that must reference the payments table
const REQUIRES_PAYMENTS_TABLE = new Set([
  'getDepositPaidQuery',
  'getFullyPaidQuery',
  'getNoPaymentRecordQuery',
  'getWaitingPaymentQuery',
]);

for (const name of REQUIRED_PAYMENT_EXPORTS) {
  if (typeof payments[name] !== 'function') {
    console.error(`FAIL: staff-payment-queries does not export ${name}`);
    errors++;
    continue;
  }
  const sql = payments[name]();
  check(name, sql);
  const upper = sql.toUpperCase();
  if (!upper.includes('BOOKINGS')) {
    console.error(`FAIL: ${name} does not reference bookings table`);
    errors++;
  }
  if (REQUIRES_PAYMENTS_TABLE.has(name) && !upper.includes('PAYMENTS')) {
    console.error(`FAIL: ${name} should reference payments table`);
    errors++;
  }
}

// ── Result ──────────────────────────────────────────────────────────────────

if (errors === 0) {
  console.log('\nStaff payment query verify (Stage 5.3): OK');
  process.exit(0);
} else {
  console.error(`\nStaff payment query verify: FAIL (${errors} error(s))`);
  process.exit(1);
}
