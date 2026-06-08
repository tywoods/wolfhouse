/**
 * Stage 27r — Confirmation send go/no-go verifier.
 *
 * Usage:
 *   npm run verify:stage27r-confirmation-send-go-no-go
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SEND_MOD = path.join(__dirname, 'lib', 'luna-guest-confirmation-send-go-no-go.js');
const PREVIEW_MOD = path.join(__dirname, 'lib', 'luna-guest-confirmation-preview-dry-run.js');
const SEND_BASE = path.join(__dirname, 'lib', 'luna-booking-confirmation-send.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27R-CONFIRMATION-SEND-GO-NO-GO.md');
const SCRIPT = 'verify:stage27r-confirmation-send-go-no-go';

const {
  runGuestConfirmationSendGoNoGo,
  buildPreviewLoaderFrom27q,
  isWhatsappDryRun,
  REUSED_SEND_PATH,
  SEND_SAFETY,
} = require('./lib/luna-guest-confirmation-send-go-no-go');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

const UNIQUE_MSG = 'Luna from Wolfhouse here ☀️ STAGE27R-UNIQUE-MSG gate code 2684# Room MB-01';

const READY_PREVIEW = {
  success: true,
  confirmation_preview_ready: true,
  confirmation_preview_attempted: true,
  confirmation_send_allowed: false,
  booking_id: '00000000-0000-4000-8000-000000000027',
  booking_code: 'WH-G27-SEND',
  payment_status: 'deposit_paid',
  proposed_confirmation_message: UNIQUE_MSG,
  next_safe_step: 'ready_for_confirmation_send_go_no_go',
};

const DRY_RUN_ENV = {
  LUNA_AUTO_SEND_ENABLED: 'true',
  WHATSAPP_DRY_RUN: 'true',
};

const SEND_INPUT = {
  confirmation_preview_result: READY_PREVIEW,
  confirm_send: true,
  to: '+34600000027',
  idempotency_key: 'stage27r-send-test',
  client_slug: 'wolfhouse-somo',
  booking_code: 'WH-G27-SEND',
};

console.log('\nverify-stage27r-confirmation-send-go-no-go.js  (Stage 27r)\n');

try {
  execSync(`node --check "${SEND_MOD}"`, { stdio: 'pipe' });
  pass('0a', 'go/no-go module passes node --check');
} catch {
  fail('0a', 'module syntax error');
}

const sendSrc = fs.readFileSync(SEND_MOD, 'utf8');
const sendBaseSrc = fs.readFileSync(SEND_BASE, 'utf8');

section('A. package.json script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('A1', `${SCRIPT} registered`);
else fail('A1', `missing npm script ${SCRIPT}`);

section('B. Reused send path');

if (sendSrc.includes('sendLunaBookingConfirmation')) pass('B1', 'delegates to sendLunaBookingConfirmation');
else fail('B1', 'must use sendLunaBookingConfirmation');

if (sendSrc.includes('buildPreviewLoaderFrom27q')) pass('B2', 'injects 27q preview loader');
else fail('B2', 'must inject 27q preview without regeneration');

if (REUSED_SEND_PATH.includes('20j')) pass('B3', 'REUSED_SEND_PATH names Phase 20j');
else fail('B3', 'REUSED_SEND_PATH should name 20j');

if (sendBaseSrc.includes('sendLunaBookingConfirmation')) pass('B4', 'base send helper exists');
else fail('B4', 'base send helper missing');

section('C. confirm_send gate');

(async () => {
  const noConfirm = await runGuestConfirmationSendGoNoGo(
    { ...SEND_INPUT, confirm_send: false },
    { env: DRY_RUN_ENV },
  );

  if (noConfirm.send_attempted === false && noConfirm.send_status === 'not_approved') {
    pass('C1', 'confirm_send false never sends');
  } else {
    fail('C1', 'confirm_send false must block');
  }

  const missingConfirm = await runGuestConfirmationSendGoNoGo(
    { confirmation_preview_result: READY_PREVIEW, to: '+34600000027', idempotency_key: 'x' },
    { env: DRY_RUN_ENV },
  );

  if (missingConfirm.send_attempted === false && missingConfirm.send_status === 'not_approved') {
    pass('C2', 'missing confirm_send never sends');
  } else {
    fail('C2', 'missing confirm_send must block');
  }

  if (noConfirm.next_safe_step === 'awaiting_confirmation_send_go_no_go') {
    pass('C3', 'not approved next_safe_step');
  } else {
    fail('C3', 'unexpected next_safe_step when not approved');
  }

  section('D. Preview readiness gates');

  const notReady = await runGuestConfirmationSendGoNoGo(
    {
      confirmation_preview_result: {
        confirmation_preview_ready: false,
        block_reasons: ['payment_truth_not_recorded'],
      },
      confirm_send: true,
      to: '+34600000027',
      idempotency_key: 'not-ready',
    },
    { env: DRY_RUN_ENV },
  );

  if (notReady.send_attempted === false && notReady.send_status === 'not_ready') {
    pass('D1', 'not-ready preview never sends');
  } else {
    fail('D1', 'not-ready preview must block send');
  }

  const staffReview = await runGuestConfirmationSendGoNoGo(
    {
      confirmation_preview_result: {
        confirmation_preview_ready: false,
        next_safe_step: 'staff_review_confirmation',
        block_reasons: ['missing_room_number_or_label'],
      },
      confirm_send: true,
      to: '+34600000027',
      idempotency_key: 'staff-review',
    },
    { env: DRY_RUN_ENV },
  );

  if (staffReview.send_attempted === false && staffReview.send_status === 'staff_review_required') {
    pass('D2', 'staff-review preview never sends');
  } else {
    fail('D2', 'staff review must block send');
  }

  const bedLeak = await runGuestConfirmationSendGoNoGo(
    {
      confirmation_preview_result: {
        ...READY_PREVIEW,
        proposed_confirmation_message: 'Room bed number: 3 and B1 leak',
      },
      confirm_send: true,
      to: '+34600000027',
      idempotency_key: 'bed-leak',
    },
    { env: DRY_RUN_ENV },
  );

  if (bedLeak.send_attempted === false && bedLeak.send_status === 'staff_review_required') {
    pass('D3', 'bed-number leak preview never sends');
  } else {
    fail('D3', 'bed leak must block send');
  }

  section('E. Ready preview + confirm_send → send gate');

  let sendCalled = false;
  let injectedMessage = null;

  const mockSend = async (input, ctx) => {
    sendCalled = true;
    if (typeof ctx.getLunaBookingConfirmationPreview === 'function') {
      const loaded = await ctx.getLunaBookingConfirmationPreview({});
      injectedMessage = loaded.message_preview;
    }
    return {
      ok: true,
      status: 200,
      result: {
        success: false,
        send_performed: false,
        sends_whatsapp: false,
        would_send_whatsapp: true,
        blocked_reasons: ['whatsapp_dry_run_active'],
        message_preview: injectedMessage,
        updates_confirmation_sent_at: false,
      },
    };
  };

  const dryRunSend = await runGuestConfirmationSendGoNoGo(SEND_INPUT, {
    env: DRY_RUN_ENV,
    sendLunaBookingConfirmation: mockSend,
    pg: { query: async () => ({ rows: [] }) },
  });

  if (sendCalled) pass('E1', 'ready preview + confirm_send calls send path');
  else fail('E1', 'send path must be invoked');

  if (injectedMessage === UNIQUE_MSG) {
    pass('E2', '27q proposed_confirmation_message reused not regenerated');
  } else {
    fail('E2', `message mismatch: ${String(injectedMessage).slice(0, 60)}`);
  }

  if (dryRunSend.send_attempted === true && dryRunSend.send_status === 'blocked_dry_run') {
    pass('E3', 'WHATSAPP_DRY_RUN produces blocked_dry_run');
  } else {
    fail('E3', `expected blocked_dry_run got ${dryRunSend.send_status}`);
  }

  if (dryRunSend.sends_whatsapp === false && dryRunSend.live_send_blocked === true) {
    pass('E4', 'dry-run blocks live WhatsApp');
  } else {
    fail('E4', 'live send must be blocked under dry run');
  }

  section('F. Real send path dry-run integration');

  const realDry = await runGuestConfirmationSendGoNoGo(SEND_INPUT, {
    env: DRY_RUN_ENV,
    pg: { query: async () => ({ rows: [] }) },
  });

  if (realDry.send_attempted === true) pass('F1', 'real send helper attempted with dry-run env');
  else fail('F1', 'real send path should be attempted');

  if (realDry.send_status === 'blocked_dry_run' || realDry.send_status === 'send_gate_blocked') {
    pass('F2', 'real path blocked without live send');
  } else {
    fail('F2', `unexpected real send status ${realDry.send_status}`);
  }

  if (realDry.sends_whatsapp !== true) pass('F3', 'no live WhatsApp under dry run');
  else fail('F3', 'must not live-send WhatsApp');

  section('G. Output shape');

  const keys = ['send_attempted', 'send_status', 'sends_whatsapp', 'live_send_blocked', 'next_safe_step'];
  for (const key of keys) {
    if (key in dryRunSend) pass(`G.${key}`, `output has ${key}`);
    else fail(`G.${key}`, `missing ${key}`);
  }

  if (dryRunSend.preview_regenerated === false) pass('G.no_regen', 'preview_regenerated false');
  else fail('G.no_regen', 'must not regenerate preview');

  section('H. Preview loader unit');

  const loader = buildPreviewLoaderFrom27q(READY_PREVIEW);
  const loaded = await loader({});
  if (loaded.message_preview === UNIQUE_MSG && loaded.preview_source === 'luna_guest_stage27q') {
    pass('H1', 'preview loader returns 27q message');
  } else {
    fail('H1', 'preview loader must return 27q message');
  }

  section('I. Source hygiene');

  const forbidden = [
    ['I.stripe', /require\s*\(\s*['"]stripe['"]\)|checkout\.sessions|STRIPE_SECRET/i],
    ['I.payment_write', /amount_paid_cents\s*=|status\s*=\s*'paid'::payment_record_status/i],
    ['I.n8n', /fetch\s*\([^)]*n8n|activateWorkflow/i],
    ['I.meta_activate', /graph\.facebook\.com.*POST|activateWorkflow/i],
    ['I.regen_preview', /runGuestConfirmationPreviewDryRun|getLunaBookingConfirmationPreview\s*\(\s*\{[^}]*booking/i],
  ];

  for (const [id, re] of forbidden) {
    if (!re.test(sendSrc)) pass(id, 'module source clean');
    else fail(id, 'forbidden pattern in go/no-go module');
  }

  if (sendSrc.includes('preview_regenerated: false') || sendSrc.includes('preview_regenerated')) {
    pass('I.preview_flag', 'tracks preview regeneration flag');
  } else {
    fail('I.preview_flag', 'should track preview_regenerated');
  }

  if (isWhatsappDryRun(DRY_RUN_ENV)) pass('I.dry_run_env', 'dry-run env detected');
  else fail('I.dry_run_env', 'WHATSAPP_DRY_RUN should be true in test env');

  section('J. SEND_SAFETY constants');

  for (const [k, v] of Object.entries(SEND_SAFETY)) {
    if (dryRunSend[k] === v) pass(`J.${k}`, `${k}=${v}`);
    else fail(`J.${k}`, `expected ${k}=${v}`);
  }

  section('K. Doc files');

  if (fs.existsSync(DOC)) pass('K1', 'STAGE-27R doc exists');
  else fail('K1', 'missing STAGE-27R doc');

  const docText = fs.readFileSync(DOC, 'utf8');
  if (docText.includes('runGuestConfirmationSendGoNoGo')) pass('K2', 'doc names function');
  else fail('K2', 'doc must name function');

  if (docText.includes('confirm_send') && docText.includes('WHATSAPP_DRY_RUN')) {
    pass('K3', 'doc covers confirm_send and dry-run');
  } else {
    fail('K3', 'doc missing confirm_send or dry-run');
  }

  if (docText.includes('27q') || docText.includes('Stage 27q')) {
    pass('K4', 'doc references 27q prerequisite');
  } else {
    fail('K4', 'doc should reference 27q');
  }

  section('L. 27q verifier still registered');

  if (pkg.scripts && pkg.scripts['verify:stage27q-confirmation-preview']) {
    pass('L1', '27q verifier script still registered');
  } else {
    fail('L1', '27q verifier must remain registered');
  }

  if (fs.existsSync(PREVIEW_MOD)) pass('L2', '27q preview module still present');
  else fail('L2', '27q module missing');

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FAIL — verifier error:', e.message);
  process.exit(1);
});
