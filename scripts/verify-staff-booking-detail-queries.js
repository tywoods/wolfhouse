/**
 * Stage 7.7i — Static verifier for staff-booking-detail-queries.js
 *
 * Checks (26 total):
 *   1–4:   File exists, readable, syntax-clean, module loads
 *   5–10:  All 6 query helpers exported as functions
 *  11–14:  getBookingDetailQuery — SELECT, client-scoped, bookings referenced, $1/$2
 *  15–18:  getBookingPaymentsQuery — SELECT, payments referenced, client-scoped, $2
 *  19–20:  getBookingRoomingAssignmentsQuery — booking_beds referenced, SELECT
 *  21–22:  getBookingConversationQuery — conversations referenced, SELECT
 *  23–24:  getBookingHandoffQuery — staff_handoffs referenced, SELECT
 *  25–26:  No mutation keywords; getBookingAddOnSummaryQuery present
 *
 * Usage:
 *   node scripts/verify-staff-booking-detail-queries.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const QFILE = path.join(__dirname, 'lib', 'staff-booking-detail-queries.js');

let passes = 0, failures = 0;
function ok(msg)   { console.log('  PASS  ' + msg); passes++; }
function fail(msg) { console.error('  FAIL  ' + msg); failures++; }
function check(cond, msg) { if (cond) ok(msg); else fail(msg); }

console.log('\nverify-staff-booking-detail-queries.js  (Stage 7.7i)\n');

// 1. File exists
check(fs.existsSync(QFILE), 'staff-booking-detail-queries.js exists');
if (!fs.existsSync(QFILE)) process.exit(1);

// 2. Readable
const src = fs.readFileSync(QFILE, 'utf8');
check(src.length > 500, 'File is readable and non-trivial');

// 3. Syntax clean
try { execSync('node --check "' + QFILE + '"', { stdio: 'ignore' }); ok('Passes node --check'); }
catch (_) { fail('Passes node --check'); }

// 4. No mutation keywords in SQL
const MUTATION_RE = /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i;
check(!MUTATION_RE.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')),
  'No mutation SQL keywords in source');

// 5–10. Module loads and exports all 6 functions
let mod;
try { mod = require(QFILE); ok('Module loads without error'); }
catch (e) { fail('Module loads: ' + e.message); process.exit(1); }

const fns = [
  'getBookingDetailQuery',
  'getBookingPaymentsQuery',
  'getBookingRoomingAssignmentsQuery',
  'getBookingConversationQuery',
  'getBookingHandoffQuery',
  'getBookingAddOnSummaryQuery',
];
fns.forEach(function(name) {
  check(typeof mod[name] === 'function', name + ' exported as function');
});

// 11–14. getBookingDetailQuery
const detailSql = mod.getBookingDetailQuery();
check(/^\s*SELECT/i.test(detailSql),            'getBookingDetailQuery starts with SELECT');
check(/\$1/.test(detailSql) && /\$2/.test(detailSql), 'getBookingDetailQuery uses $1/$2 params');
check(/\bclients\b/i.test(detailSql),           'getBookingDetailQuery joins clients table');
check(/\bbookings\b/i.test(detailSql),          'getBookingDetailQuery references bookings');

// 15–18. getBookingPaymentsQuery
const paymentSql = mod.getBookingPaymentsQuery();
check(/^\s*SELECT/i.test(paymentSql),           'getBookingPaymentsQuery starts with SELECT');
check(/\bpayments\b/i.test(paymentSql),         'getBookingPaymentsQuery references payments');
check(/\$1/.test(paymentSql) && /\$2/.test(paymentSql), 'getBookingPaymentsQuery uses $1/$2 params');
check(/\bclients\b/i.test(paymentSql),          'getBookingPaymentsQuery is client-scoped');

// 19–20. getBookingRoomingAssignmentsQuery
const roomSql = mod.getBookingRoomingAssignmentsQuery();
check(/^\s*SELECT/i.test(roomSql),              'getBookingRoomingAssignmentsQuery starts with SELECT');
check(/\bbooking_beds\b/i.test(roomSql),        'getBookingRoomingAssignmentsQuery references booking_beds');

// 21–22. getBookingConversationQuery
const convSql = mod.getBookingConversationQuery();
check(/^\s*SELECT/i.test(convSql),              'getBookingConversationQuery starts with SELECT');
check(/\bconversations\b/i.test(convSql),       'getBookingConversationQuery references conversations');

// 23–24. getBookingHandoffQuery
const handoffSql = mod.getBookingHandoffQuery();
check(/^\s*SELECT/i.test(handoffSql),           'getBookingHandoffQuery starts with SELECT');
check(/\bstaff_handoffs\b/i.test(handoffSql),   'getBookingHandoffQuery references staff_handoffs');

// 25. No eval / execSync
check(!/\beval\s*\(|execSync|child_process/.test(src), 'No eval/execSync in source');

// 26. getBookingAddOnSummaryQuery references add_on_orders
const addonSql = mod.getBookingAddOnSummaryQuery();
check(/\badd_on_orders\b/i.test(addonSql),      'getBookingAddOnSummaryQuery references add_on_orders');

console.log('\nResult: ' + passes + ' passed, ' + failures + ' failed\n');
if (failures > 0) process.exit(1);
