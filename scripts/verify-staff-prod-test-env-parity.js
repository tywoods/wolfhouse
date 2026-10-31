#!/usr/bin/env node
'use strict';

/**
 * Prod vs TEST Staff env parity — NAMES only, never values.
 * Does not read live /etc env files. Does not print secrets.
 *
 * Run: node scripts/verify-staff-prod-test-env-parity.js
 */

const path = require('path');
const { compareProdTestEnvNames } = require('./lib/staff-prod-test-env-parity');

const ROOT = path.resolve(__dirname, '..');
const compared = compareProdTestEnvNames({ root: ROOT });

console.log('staff prod-vs-TEST env NAMES (values never printed)');
console.log('required_staff_names:', compared.required_staff_names.join(', '));
console.log('missing_on_prod:', compared.missing_on_prod.join(', ') || '(none)');
console.log('note: STRIPE_WEBHOOK_SECRET and STRIPE_WEBHOOK_CLIENT_SLUG must exist as names on prod; do not invent values.');

const must = ['STRIPE_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_CLIENT_SLUG'];
const stillMissing = must.filter((n) => compared.missing_on_prod.indexOf(n) >= 0);
if (stillMissing.length) {
  console.log('parity_gap:', stillMissing.join(', '));
  process.exit(0);
}
console.log('parity_gap: none of the Stripe webhook names');
