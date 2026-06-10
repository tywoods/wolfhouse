/**
 * Stage 29c.3 — live proof paid-proof reset hygiene verifier.
 *
 * Usage:
 *   npm run verify:stage29c3-live-proof-paid-reset-hygiene
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(__dirname, 'run-luna-conversation-state-machine-tests.js');
const HYGIENE = path.join(__dirname, 'lib', 'luna-live-proof-hygiene.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage29c3-live-proof-paid-reset-hygiene';

const {
  runLiveProofHygiene,
  isExplicitPaidProofReset,
  isAllowlistedProofPhone,
  isStagingProofArtifact,
  isPaidProofResetCandidate,
  applyPaidProofArchiveReset,
} = require('./lib/luna-live-proof-hygiene');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage29c3-live-proof-paid-reset-hygiene.js  (Stage 29c.3)\n`);

section('A. Files + package');

check('A1', fs.existsSync(HYGIENE), 'hygiene helper exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A2', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

const runnerSrc = fs.readFileSync(RUNNER, 'utf8');
const hygieneSrc = fs.readFileSync(HYGIENE, 'utf8');

section('B. Explicit paid-proof reset flag');

check('B1', hygieneSrc.includes('allow_staging_paid_proof_reset'), 'supports allow_staging_paid_proof_reset');
check('B2', hygieneSrc.includes('isExplicitPaidProofReset'), 'explicit flag guard');
check('B3', hygieneSrc.includes('applyPaidProofArchiveReset'), 'archive/reset helper');
check('B4', hygieneSrc.includes('paid_proof_archived'), 'reports paid proof actions');
check('B5', !isExplicitPaidProofReset({}), 'default flag is false');
check('B6', isExplicitPaidProofReset({ allow_staging_paid_proof_reset: true }), 'explicit true accepted');

section('C. Default paid/deposit_paid refusal');

check('C1', hygieneSrc.includes('assessCleanupEligibility'), 'unpaid path still uses eligibility');
check('C2', hygieneSrc.includes('skipped_paid_or_confirmed'), 'paid bookings skipped by default');
check('C3', isPaidProofResetCandidate({ payment_status: 'paid', status: 'hold' }), 'detects paid candidate');
check('C4', !isPaidProofResetCandidate({ payment_status: 'waiting_payment', status: 'hold' }), 'unpaid not paid candidate');

const demoArtifact = isStagingProofArtifact(
  { booking_code: 'WH-G27-ABC123', payment_status: 'paid', status: 'hold' },
  [{ stripe_checkout_session_id: 'cs_test_x' }],
);
const customerArtifact = isStagingProofArtifact(
  { booking_code: 'WH-REAL-20260701-1', payment_status: 'paid', status: 'confirmed', staff_notes: '' },
  [{ stripe_checkout_session_id: 'cs_live_x' }],
);
check('C5', demoArtifact.ok === true, 'WH-G27 demo code recognized as proof artifact');
check('C6', customerArtifact.ok === false, 'non-demo confirmed booking refused as artifact');

section('D. Paid reset guards');

check('D1', hygieneSrc.includes('isAllowlistedProofPhone'), 'allowlisted phone guard');
check('D2', isAllowlistedProofPhone('+491726422307'), 'staging proof handset allowed');
check('D3', isAllowlistedProofPhone('+346298001'), 'runner synthetic prefix allowed');
check('D4', !isAllowlistedProofPhone('+15551234567'), 'random phone refused');
check('D5', hygieneSrc.includes('assertNotProductionDb'), 'production DB refused');
check('D6', hygieneSrc.includes('isStagingResetEnvironment'), 'staging/dev environment guard');
check('D7', hygieneSrc.includes('isStagingProofArtifact'), 'proof artifact recognition');

section('E. Archive behavior (no delete)');

check('E1', hygieneSrc.includes("status = 'cancelled'"), 'archives booking status');
check('E2', hygieneSrc.includes('DELETE FROM booking_beds'), 'releases beds');
check('E3', hygieneSrc.includes("payments SET status = 'cancelled'"), 'cancels test payment drafts');
check('E4', hygieneSrc.includes('confirmation_sent_at = NULL'), 'clears confirmation for reproof');
check('E5', !hygieneSrc.includes('DELETE FROM bookings'), 'does not delete booking rows');
check('E6', !hygieneSrc.includes('DELETE FROM payments'), 'does not delete payment rows');

section('F. Runner wiring');

check('F1', runnerSrc.includes('--allow-staging-paid-proof-reset'), 'runner exposes flag');
check('F2', runnerSrc.includes('allow_staging_paid_proof_reset'), 'passes flag to hygiene');
check('F3', runnerSrc.includes('paid_proof_reset_requires_allowlisted_test_phone'), 'runner validates allowlisted phone');
check('F4', runnerSrc.includes('--allow-staging-paid-proof-reset requires --preclean-unpaid-holds'), 'requires preclean');

section('G. Safety');

check('G1', !runnerSrc.includes('sendLunaBookingConfirmation'), 'no live confirmation send');
check('G2', !hygieneSrc.includes('n8n') || hygieneSrc.includes('does not'), 'hygiene does not activate n8n');
check('G3', hygieneSrc.includes('amount_paid_cents = 0'), 'resets stale paid columns on archive');

section('H. Static dry-run unit proof');

(async () => {
  const blockedPaidReset = await runLiveProofHygiene(
    { phone: '+491726422307', check_in: '2026-07-01', check_out: '2026-07-05' },
    { allow_hygiene: true, allow_staging_paid_proof_reset: false, host_header: 'localhost' },
  );
  check('H1', blockedPaidReset.paid_proof_reset_enabled === false, 'paid reset off by default');

  const noFlagPhone = await runLiveProofHygiene(
    { phone: '+15551234567', check_in: '2026-07-01', check_out: '2026-07-05' },
    { allow_hygiene: true, allow_staging_paid_proof_reset: true, host_header: 'localhost' },
  );
  check('H2', (noFlagPhone.refused_reason || '').includes('allowlisted_test_phone'), 'paid reset refuses non-allowlisted phone');

  const mockPg = {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [] };
      if (/DELETE FROM booking_beds/.test(sql)) return { rowCount: 1, rows: [] };
      if (/UPDATE payments/.test(sql)) return { rowCount: 2, rows: [] };
      if (/UPDATE bookings/.test(sql)) return { rowCount: 1, rows: [] };
      return { rows: [] };
    },
  };
  const dry = await applyPaidProofArchiveReset(
    mockPg,
    'client-id',
    { booking_id: '11111111-1111-1111-1111-111111111111', booking_code: 'WH-G27-TEST' },
    [{ payment_id: 'p1', status: 'paid' }],
    [{ bed_code: 'DEMO-R1-B1' }],
    'verifier',
    true,
  );
  check('H3', dry.mode === 'dry_run' && dry.would_reset === true, 'dry-run reports would_reset without writes');
  check('H4', mockPg.queries.filter((q) => /UPDATE bookings/.test(q.sql)).length === 0, 'dry-run makes no booking writes');

  section('I. Syntax');
  for (const f of [RUNNER, HYGIENE, __filename]) {
    try {
      execSync(`node --check "${f}"`, { stdio: 'pipe' });
      pass('I', `${path.basename(f)} passes node --check`);
    } catch {
      fail('I', `${path.basename(f)} syntax error`);
    }
  }

  section('Summary');
  console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
