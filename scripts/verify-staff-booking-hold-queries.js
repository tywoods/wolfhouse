'use strict';
/**
 * Stage 5.2e — Static verifier for staff-booking-hold-queries.js.
 * Checks that all four staff queries exist, are scoped by client, and never mutate data.
 * Safe to run at any time — no DB connection required.
 */

const queries = require('./lib/staff-booking-hold-queries');

const REQUIRED_EXPORTS = [
  'getActiveHoldsQuery',
  'getExpiredHoldsQuery',
  'getPaymentPendingQuery',
  'getNoPaymentRecordQuery',
];

const MUTATION_KEYWORDS = ['INSERT ', 'UPDATE ', 'DELETE ', 'TRUNCATE ', ' DROP ', ' ALTER '];
const PAYMENT_QUERIES = ['getNoPaymentRecordQuery'];

let errors = 0;

for (const name of REQUIRED_EXPORTS) {
  if (typeof queries[name] !== 'function') {
    console.error(`FAIL: ${name} is not exported`);
    errors++;
    continue;
  }
  const sql = queries[name]();
  if (typeof sql !== 'string' || sql.trim() === '') {
    console.error(`FAIL: ${name} returned empty SQL`);
    errors++;
    continue;
  }
  const upper = sql.toUpperCase();
  // Must be SELECT-only
  for (const kw of MUTATION_KEYWORDS) {
    if (upper.includes(kw)) {
      console.error(`FAIL: ${name} contains mutation keyword "${kw.trim()}"`);
      errors++;
    }
  }
  // Must reference bookings
  if (!upper.includes('BOOKINGS')) {
    console.error(`FAIL: ${name} does not reference bookings table`);
    errors++;
  }
  // Must scope by client ($1 placeholder)
  if (!upper.includes('SLUG = $1') && !upper.includes("C.SLUG = $1")) {
    // normalise spacing
    if (!sql.includes('slug = $1') && !sql.includes('c.slug = $1')) {
      console.error(`FAIL: ${name} does not scope by client slug ($1)`);
      errors++;
    }
  }
  // Payment queries must also reference payments table
  if (PAYMENT_QUERIES.includes(name) && !upper.includes('PAYMENTS')) {
    console.error(`FAIL: ${name} should reference payments table`);
    errors++;
  }
  console.log(`OK:   ${name}`);
}

if (errors === 0) {
  console.log('\nStaff booking/hold query verify (Stage 5.2e): OK');
  process.exit(0);
} else {
  console.error(`\nStaff booking/hold query verify: FAIL (${errors} error(s))`);
  process.exit(1);
}
