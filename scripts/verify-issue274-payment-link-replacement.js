'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const paymentLinks = require('./lib/sunset-stripe-payment-links');

const serviceSrc = fs.readFileSync(path.join(__dirname, 'lib', 'sunset-stripe-payment-links.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const actionsSrc = fs.readFileSync(path.join(__dirname, 'browser', 'sunset-schedule-drawer-actions.js'), 'utf8');
const viewSrc = fs.readFileSync(path.join(__dirname, 'browser', 'sunset-schedule-drawer-view-ui.js'), 'utf8');

console.log('\nverify:issue274-payment-link-replacement\n');

assert.strictEqual(typeof paymentLinks.resolveAuthoritativeOutstandingCents, 'function', 'production owner exports authoritative remaining resolver');
assert.strictEqual(paymentLinks.resolveAuthoritativeOutstandingCents(12000, 4500), 4500, 'partial payment replacement uses server-authoritative remainder');
assert.strictEqual(paymentLinks.resolveAuthoritativeOutstandingCents(12000, 0), 0, 'fully paid remainder is zero');
assert.throws(() => paymentLinks.resolveAuthoritativeOutstandingCents(12000, null), /authoritative/i, 'missing server truth fails closed');
assert.match(serviceSrc, /invalidateObsoleteActivePaymentRows/, 'production persistence owner invalidates obsolete active rows');
assert.match(serviceSrc, /FOR UPDATE/, 'booking mutation is serialized');
assert.match(serviceSrc, /status = 'cancelled'::payment_record_status/, 'obsolete rows become non-actionable');
assert.match(apiSrc, /status:\s*422|sendJSON\(res,\s*422/, 'zero balance is explicitly rejected');
assert.doesNotMatch(actionsSrc, /balance_due_cents\s*[-+*/]/, 'browser never computes payment-link money');
assert.match(actionsSrc, /paymentRefetchAndRemount\(row, identity\)/, 'successful action reloads drawer from server truth');
assert.match(actionsSrc, /stripeFailed[^\n]*errorText|stripeFailed[\s\S]{0,300}errorText/, 'retryable explicit failure remains visible');
assert.match(viewSrc, /createNewPaymentLink/, 'stale/deleted state offers Create new payment link');

console.log('PASS issue #274 partial-payment replacement contract');
