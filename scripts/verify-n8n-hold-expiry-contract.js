'use strict';

/**
 * Offline verifier for Phase 3B hold-expiry contract premises.
 * Does not implement expiry, mutate DB, or schedule jobs.
 *
 * Exit 0 when invariants hold; nonzero on failure.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let failed = 0;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function check(label, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('verify-n8n-hold-expiry-contract\n');

const contractRel = 'docs/N8N-DECOMMISSION-PHASE-3B-HOLD-EXPIRY-CONTRACT.md';
check('contract document present', exists(contractRel));

if (exists(contractRel)) {
  const doc = read(contractRel);
  for (const section of [
    'Lifecycle map',
    'Authoritative expire transaction',
    'Unpaid proof',
    'Concurrent Stripe payment',
    'Idempotency',
    'Never expire automatically',
    'Dry-run',
    'External scheduler',
    'Race-condition analysis',
    'Smallest safe Phase 3C',
  ]) {
    check(`contract section mentions "${section}"`, new RegExp(section, 'i').test(doc));
  }
  check('contract chooses booking terminal status expired', /hold` → \*\*`expired`\*\*|hold → \*\*`expired`\*\*/i.test(doc));
  check('contract defaults to no guest/staff send', /messaging:\s*none|no send|none by default/i.test(doc));
  check('contract forbids n8n as scheduler', /Not n8n/i.test(doc));
  check(
    'late Stripe payment marked UNRESOLVED / not approved',
    /UNRESOLVED[\s\S]*late Stripe|Late Stripe payment handling[\s\S]*Not approved/i.test(doc),
  );
  check(
    'payment-row terminal status marked UNRESOLVED / not approved',
    /Payment-row terminal status[\s\S]*Not approved|UNRESOLVED[\s\S]*payments rows/i.test(doc),
  );
  check(
    'payment_pending expiry marked UNRESOLVED / not approved',
    /payment_pending` expiry[\s\S]*Not approved|UNRESOLVED[\s\S]*payment_pending/i.test(doc),
  );
}

const initSql = exists('database/migrations/001_init.sql') ? read('database/migrations/001_init.sql') : '';
check(
  'booking_status enum includes expired',
  /CREATE TYPE booking_status AS ENUM[\s\S]*?'expired'/i.test(initSql),
);

const holdQueries = exists('scripts/lib/staff-booking-hold-queries.js')
  ? read('scripts/lib/staff-booking-hold-queries.js')
  : '';
check(
  'getExpiredHoldsQuery detects stuck holds (status=hold, hold_expires_at < NOW())',
  /function getExpiredHoldsQuery/.test(holdQueries)
    && /status\s*=\s*'hold'/.test(holdQueries)
    && /hold_expires_at\s*<\s*NOW\(\)/i.test(holdQueries),
);

const lunaWrite = exists('scripts/lib/luna-guest-hold-payment-draft-write.js')
  ? read('scripts/lib/luna-guest-hold-payment-draft-write.js')
  : '';
check(
  'Luna hold+draft TTL is 6 hours',
  /HOLD_EXPIRES_IN_HOURS\s*=\s*6\b/.test(lunaWrite),
);

const mainHold = exists('scripts/lib/main-booking-hold-pg-sql.js')
  ? read('scripts/lib/main-booking-hold-pg-sql.js')
  : '';
check(
  'Main proposeHoldExpiresAt is 1 hour (documented TTL skew)',
  /function proposeHoldExpiresAt/.test(mainHold)
    && /60\s*\*\s*60\s*\*\s*1000/.test(mainHold),
);
check(
  'Main hold upsert SQL uses NOW() + INTERVAL \'1 hour\'',
  /NOW\(\)\s*\+\s*INTERVAL\s+'1 hour'/.test(mainHold),
);

const baseline = exists('config/clients/wolfhouse-somo.baseline.json')
  ? read('config/clients/wolfhouse-somo.baseline.json')
  : '';
check(
  'baseline product SoT hold_expiry_minutes is 360',
  /"hold_expiry_minutes"\s*:\s*360/.test(baseline),
);

const reconcile = exists('scripts/lib/stripe-payment-reconcile.js')
  ? read('scripts/lib/stripe-payment-reconcile.js')
  : '';
const holdPolicy = exists('scripts/lib/stripe-hold-promote-policy.js')
  ? read('scripts/lib/stripe-hold-promote-policy.js')
  : '';
check(
  'Stripe reconcile uses shared hold promote policy',
  /applyStripeBookingPaymentTruthWrites/.test(reconcile)
    && /stripe-hold-promote-policy/.test(reconcile),
);
check(
  'Hold promote policy gates hold → confirmed on money + expiry',
  /status === 'hold'/.test(holdPolicy)
    && /promote_to_confirmed: moneyOk/.test(holdPolicy)
    && /hold_expired_by_db/.test(holdPolicy),
);

const stagingTruth = exists('scripts/lib/luna-guest-stripe-payment-truth-apply.js')
  ? read('scripts/lib/luna-guest-stripe-payment-truth-apply.js')
  : '';
check(
  'Staging Stripe truth apply gates hold_expired',
  /hold_expired/.test(stagingTruth) && /hold_expires_at/.test(stagingTruth),
);

// WB-4 worker implemented — contract premises updated from "absent" to "present".
const workerFiles = [
  'scripts/lib/booking-hold-expiry.js',
  'scripts/run-booking-hold-expiry.js',
];
for (const rel of workerFiles) {
  check(`expire worker present (${rel})`, exists(rel));
}

const holdExpiryLib = exists('scripts/lib/booking-hold-expiry.js')
  ? read('scripts/lib/booking-hold-expiry.js')
  : '';
check(
  'worker sets booking status expired under lock',
  /status = 'expired'::booking_status/.test(holdExpiryLib)
    && /FOR UPDATE/.test(holdExpiryLib),
);
check(
  'worker deletes booking_beds scoped by booking_id and client_id',
  /DELETE FROM booking_beds[\s\S]*booking_id[\s\S]*client_id/.test(holdExpiryLib),
);
check(
  'worker cancels unpaid payment links only (not paid)',
  /status = 'cancelled'::payment_record_status/.test(holdExpiryLib)
    && /CANCELLABLE_PAYMENT_STATUSES/.test(holdExpiryLib),
);
check(
  'CLI defaults dry-run; apply flag required',
  exists('scripts/run-booking-hold-expiry.js')
    && /--apply/.test(read('scripts/run-booking-hold-expiry.js'))
    && /apply:\s*false/.test(read('scripts/run-booking-hold-expiry.js')),
);

const regression = exists('docs/regression-test-plan.md') ? read('docs/regression-test-plan.md') : '';
check(
  'historical regression documents hold expiry job',
  /Hold expiry job/i.test(regression) && /Expired holds/i.test(regression),
);

const dependencyMap = exists('docs/workflow-dependency-map.md')
  ? read('docs/workflow-dependency-map.md')
  : '';
check(
  'historical n8n schedule name recorded',
  /Delete Expired Holds/i.test(dependencyMap),
);

console.log(`\n── verify-n8n-hold-expiry-contract ${failed ? 'FAILED' : 'PASSED'} ──`);
process.exit(failed ? 1 : 0);
