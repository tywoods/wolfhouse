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
  check('contract chooses terminal status expired', /status = 'expired'|→ \*\*`expired`\*\*|→ \*\*expired\*\*/i.test(doc));
  check('contract defaults to no guest/staff send', /messaging:\s*none|no send|none by default/i.test(doc));
  check('contract forbids n8n as scheduler', /Not n8n/i.test(doc));
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
check(
  'Stripe reconcile promotes hold → confirmed when paid',
  /status\s*=\s*'hold'[\s\S]*?'confirmed'/.test(reconcile)
    || /WHEN status = 'hold'[\s\S]*confirmed/.test(reconcile),
);

const stagingTruth = exists('scripts/lib/luna-guest-stripe-payment-truth-apply.js')
  ? read('scripts/lib/luna-guest-stripe-payment-truth-apply.js')
  : '';
check(
  'Staging Stripe truth apply gates hold_expired',
  /hold_expired/.test(stagingTruth) && /hold_expires_at/.test(stagingTruth),
);

// Absence of an expire worker that transitions to expired (Phase 3B premise).
const workerCandidates = [
  'scripts/lib/booking-hold-expiry.js',
  'scripts/run-booking-hold-expiry.js',
  'scripts/expire-booking-holds.js',
  'scripts/run-expire-holds.js',
];
for (const rel of workerCandidates) {
  check(`expire worker not implemented yet (${rel})`, !exists(rel));
}

// Soft scan: no JS under scripts/lib that UPDATEs bookings to expired as a hold job.
// (Allow docs/tests mentioning the string.)
const libDir = path.join(ROOT, 'scripts', 'lib');
let suspiciousExpireUpdate = null;
if (fs.existsSync(libDir)) {
  for (const name of fs.readdirSync(libDir)) {
    if (!name.endsWith('.js')) continue;
    // Skip this verifier-adjacent contract docs only; scanning all libs for update patterns
    const text = fs.readFileSync(path.join(libDir, name), 'utf8');
    if (/UPDATE\s+bookings[\s\S]{0,200}status\s*=\s*'expired'/i.test(text)
      && /hold_expires_at\s*</i.test(text)) {
      suspiciousExpireUpdate = `scripts/lib/${name}`;
      break;
    }
  }
}
check(
  'no scripts/lib hold-expiry UPDATE…status=expired worker pattern',
  !suspiciousExpireUpdate,
  suspiciousExpireUpdate || '',
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
