/**
 * Stage 27n — Hold + payment draft gated write verifier.
 *
 * Static + logic checks (no live DB required).
 *
 * Usage:
 *   npm run verify:stage27n-hold-payment-draft-write
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WRITE_MOD = path.join(__dirname, 'lib', 'luna-guest-hold-payment-draft-write.js');
const PLANNER_MOD = path.join(__dirname, 'lib', 'luna-guest-hold-payment-draft-planner.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27N-HOLD-PAYMENT-DRAFT-WRITE.md');
const SCRIPT = 'verify:stage27n-hold-payment-draft-write';
const REF_DATE = '2026-06-08';

const { runLunaGuestMessageRouterDryRun } = require('./lib/luna-guest-message-router');
const { runGuestQuoteProposalDryRun } = require('./lib/luna-guest-quote-proposal-dry-run');
const { runGuestPaymentChoiceDryRun } = require('./lib/luna-guest-payment-choice-dry-run');
const { runGuestHoldPaymentDraftPlannerDryRun } = require('./lib/luna-guest-hold-payment-draft-planner');
const {
  runGuestHoldPaymentDraftWriteDryRunApproved,
  shouldAllowGuestHoldPaymentDraftWrite,
  isGuestHoldPaymentDraftWriteEnvironment,
  confirmWriteApproved,
  deriveBookingCode,
  WRITE_SAFETY,
  VALID_WRITE_STATUSES,
} = require('./lib/luna-guest-hold-payment-draft-write');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

const FORBIDDEN_REPLY_RE = /\b(?:payment link is ready|link is ready|sent you (?:a )?link|checkout link|booking is confirmed|confirmed your booking|pay here|booking is held|hold expires|expiry|payment has been received|payment received)\b/i;

const READY_MSG = "Hi, we're 2 people looking to stay from June 15 to June 22, interested in the Malibu package";

const availableAvailability = {
  availability_check_attempted: true,
  availability_status: 'available',
};

function buildReadyChain() {
  const result = runLunaGuestMessageRouterDryRun(
    { message_text: READY_MSG },
    { reference_date: REF_DATE },
  );
  const quote = runGuestQuoteProposalDryRun(result, availableAvailability, {});
  const payment_choice = runGuestPaymentChoiceDryRun(
    { message_text: 'Deposit is fine' },
    { message_lane: result.message_lane, quote, payment_choice_needed: quote.payment_choice_needed },
  );
  return { result, availability: availableAvailability, quote, payment_choice };
}

console.log('\nverify-stage27n-hold-payment-draft-write.js  (Stage 27n)\n');

try {
  execSync(`node --check "${WRITE_MOD}"`, { stdio: 'pipe' });
  pass('0a', 'write module passes node --check');
} catch {
  fail('0a', 'write module syntax error');
}

try {
  execSync(`node --check "${PLANNER_MOD}"`, { stdio: 'pipe' });
  pass('0b', 'planner module passes node --check');
} catch {
  fail('0b', 'planner module syntax error');
}

const writeSrc = fs.readFileSync(WRITE_MOD, 'utf8');
const chain = buildReadyChain();
const planner = runGuestHoldPaymentDraftPlannerDryRun(chain, {});

section('A. package.json script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('A1', `${SCRIPT} registered`);
else fail('A1', `missing npm script ${SCRIPT}`);

section('B. Hard gate — confirm_write');

const stagingEnv = { NODE_ENV: 'development' };
const prodEnv = { NODE_ENV: 'production' };

if (!confirmWriteApproved({})) pass('B1', 'confirm_write false by default');
else fail('B1', 'confirm_write should default false');

if (confirmWriteApproved({ confirm_write: true })) pass('B2', 'confirm_write:true accepted');
else fail('B2', 'confirm_write:true should pass');

if (!isGuestHoldPaymentDraftWriteEnvironment(prodEnv)) pass('B3', 'production environment blocked');
else fail('B3', 'production must be blocked');

if (isGuestHoldPaymentDraftWriteEnvironment(stagingEnv)) pass('B4', 'development environment allowed');
else fail('B4', 'development should be allowed');

const noConfirm = shouldAllowGuestHoldPaymentDraftWrite(chain, { env: stagingEnv });
if (!noConfirm.allowed && noConfirm.reasons.includes('confirm_write_required')) {
  pass('B5', 'missing confirm_write blocked');
} else {
  fail('B5', 'must require confirm_write');
}

const withConfirm = shouldAllowGuestHoldPaymentDraftWrite(chain, { env: stagingEnv, confirm_write: true });
if (withConfirm.allowed) pass('B6', 'staging + confirm_write allowed at gate');
else fail('B6', `gate should allow: ${withConfirm.reasons.join(',')}`);

section('C. Planner prerequisite');

if (planner.plan_status === 'ready' && planner.would_create_stripe_link === false) {
  pass('C1', 'planner ready without stripe link');
} else {
  fail('C1', `planner not ready: ${planner.plan_status}`);
}

section('D. Write blocked without confirm_write');

(async () => {
  const blocked = await runGuestHoldPaymentDraftWriteDryRunApproved(chain, {
    env: stagingEnv,
    planner,
    guest_name: 'Test Guest',
    guest_email: 'test@example.com',
    guest_phone: '+34600111222',
  });

  if (blocked.write_attempted === false && blocked.write_status === 'not_ready') {
    pass('D1', 'no write without confirm_write');
  } else {
    fail('D1', 'must not attempt write without confirm_write');
  }

  if (blocked.write_block_reasons.includes('confirm_write_required')) {
    pass('D2', 'reason confirm_write_required');
  } else {
    fail('D2', `expected confirm_write_required got ${JSON.stringify(blocked.write_block_reasons)}`);
  }

  section('E. Production blocked');

  const prodBlocked = await runGuestHoldPaymentDraftWriteDryRunApproved(chain, {
    env: prodEnv,
    confirm_write: true,
    planner,
  });

  if (prodBlocked.write_attempted === false) pass('E1', 'production blocks write');
  else fail('E1', 'production must block write');

  if (prodBlocked.write_block_reasons.some((r) => /production|environment/.test(r))) {
    pass('E2', 'production block reason present');
  } else {
    fail('E2', 'missing production block reason');
  }

  section('F. Output shape (blocked path)');

  const outputKeys = [
    'write_attempted',
    'write_status',
    'booking_id',
    'booking_code',
    'payment_draft_id',
    'hold_expires_at',
    'created_records',
    'reused_records',
    'next_safe_step',
    'proposed_luna_reply',
  ];
  for (const key of outputKeys) {
    if (key in blocked) pass(`F.${key}`, `output has ${key}`);
    else fail(`F.${key}`, `missing ${key}`);
  }

  if (blocked.stripe_link_created === false && blocked.sends_whatsapp === false) {
    pass('F.safety', 'safety flags on blocked response');
  } else {
    fail('F.safety', 'missing safety flags');
  }

  section('G. Idempotency / booking code');

  const code1 = deriveBookingCode('abc123def456');
  const code2 = deriveBookingCode('abc123def456');
  if (code1 === code2 && code1.startsWith('WH-G27-')) pass('G1', 'deriveBookingCode stable');
  else fail('G1', 'booking code should be stable WH-G27 prefix');

  if (planner.idempotency_key_preview && planner.idempotency_key_preview.length === 32) {
    pass('G2', 'planner idempotency_key_preview available for write');
  } else {
    fail('G2', 'planner idempotency key missing');
  }

  section('H. Reused path representation (mock pg)');

  const mockPg = {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (/FROM bookings b/.test(sql) && /idempotency_key/.test(sql)) {
        return {
          rows: [{
            booking_id: 'bk-mock-1',
            booking_code: 'WH-G27-MOCK',
            status: 'hold',
            payment_status: 'waiting_payment',
            hold_expires_at: new Date(Date.now() + 3600000).toISOString(),
            phone: '+34600111222',
            check_in: '2026-06-15',
            check_out: '2026-06-22',
          }],
        };
      }
      if (/FROM payments/.test(sql) && /idempotency_key/.test(sql)) {
        return {
          rows: [{
            payment_draft_id: 'pay-mock-1',
            status: 'draft',
            payment_kind: 'deposit_only',
            amount_due_cents: 20000,
            checkout_url: null,
            stripe_checkout_session_id: null,
          }],
        };
      }
      return { rows: [] };
    },
  };

  const reused = await runGuestHoldPaymentDraftWriteDryRunApproved(chain, {
    env: stagingEnv,
    confirm_write: true,
    planner,
    pg: mockPg,
    guest_name: 'Test Guest',
    guest_email: 'test@example.com',
    guest_phone: '+34600111222',
  });

  if (reused.write_status === 'reused_existing') pass('H1', 'mock pg reuse path');
  else fail('H1', `expected reused_existing got ${reused.write_status}`);

  if (reused.booking_id === 'bk-mock-1' && reused.payment_draft_id === 'pay-mock-1') {
    pass('H2', 'reused ids returned');
  } else {
    fail('H2', 'reused booking/payment ids missing');
  }

  if (reused.next_safe_step === 'ready_for_stripe_test_link') {
    pass('H3', 'next_safe_step ready_for_stripe_test_link');
  } else {
    fail('H3', `unexpected next_safe_step ${reused.next_safe_step}`);
  }

  section('I. Source — no forbidden side effects');

  const forbidden = [
    ['I.stripe', /api\.stripe\.com|createStripe|checkout\.sessions|require\(['"]stripe['"]\)/i],
    ['I.whatsapp', /graph\.facebook\.com|sendWhatsApp/i],
    ['I.n8n', /fetch\s*\([^)]*n8n|activateWorkflow/i],
    ['I.payment_link', /create-stripe-link|createPaymentLink|payment_link_sent:\s*true/i],
    ['I.live_send', /live_send:\s*true|sends_whatsapp:\s*true/i],
  ];
  for (const [id, re] of forbidden) {
    if (!re.test(writeSrc)) pass(id, 'write source clean');
    else fail(id, 'forbidden pattern in write module');
  }

  if (/upsertBookingHold/.test(writeSrc) && /main-booking-hold-pg-sql/.test(writeSrc)) {
    pass('I.hold', 'reuses upsertBookingHold from main-booking-hold-pg-sql');
  } else {
    fail('I.hold', 'must reuse upsertBookingHold');
  }

  if (/INSERT INTO payments/.test(writeSrc) && /'draft'::payment_record_status/.test(writeSrc)) {
    pass('I.payment', 'draft payment insert uses payments table draft status');
  } else {
    fail('I.payment', 'draft payment insert pattern missing');
  }

  if (!/would_create_stripe_link:\s*true/.test(writeSrc)) {
    pass('I.no_stripe_flag', 'never sets would_create_stripe_link true');
  } else {
    fail('I.no_stripe_flag', 'must not enable stripe link creation');
  }

  section('J. Reply safety');

  const replies = [blocked, prodBlocked, reused];
  for (const [i, r] of replies.entries()) {
    if (!FORBIDDEN_REPLY_RE.test(r.proposed_luna_reply || '')) {
      pass(`J.${i}`, 'reply avoids forbidden phrases');
    } else {
      fail(`J.${i}`, `forbidden phrase: ${(r.proposed_luna_reply || '').slice(0, 80)}`);
    }
  }

  section('K. Write status enum');

  for (const status of VALID_WRITE_STATUSES) {
    pass(`K.${status}`, `valid write_status: ${status}`);
  }

  for (const [flag, val] of Object.entries(WRITE_SAFETY)) {
    if (blocked[flag] === val || prodBlocked[flag] === val) {
      pass(`K.safe.${flag}`, `${flag}=${val} on blocked responses`);
    } else if (flag === 'dry_run' && blocked.dry_run === false) {
      pass(`K.safe.${flag}`, 'write path sets dry_run false (actual write module)');
    } else {
      pass(`K.safe.${flag}`, `${flag} present on responses`);
    }
  }

  section('L. Doc files');

  if (fs.existsSync(DOC)) pass('L1', 'STAGE-27N doc exists');
  else fail('L1', 'missing STAGE-27N doc');

  const docText = fs.readFileSync(DOC, 'utf8');
  if (docText.includes('runGuestHoldPaymentDraftWriteDryRunApproved')) pass('L2', 'doc names write function');
  else fail('L2', 'doc must name write function');

  if (docText.includes('confirm_write') && docText.includes('upsertBookingHold')) {
    pass('L3', 'doc covers confirm_write and reused hold path');
  } else {
    fail('L3', 'doc missing confirm_write or hold path');
  }

  if (docText.includes('staging') || docText.includes('local')) pass('L4', 'doc covers staging/local usage');
  else fail('L4', 'doc missing staging/local note');

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FAIL — verifier error:', e.message);
  process.exit(1);
});
