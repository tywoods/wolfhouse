/**
 * Stage 27demo-i / closeout — confirmation send idempotency normalization verifier.
 *
 * Usage:
 *   npm run verify:stage27demo-i-confirmation-send
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SEND_MOD = path.join(__dirname, 'lib', 'luna-guest-confirmation-send-go-no-go.js');
const CLOSEOUT = path.join(ROOT, 'docs', 'STAGE-27DEMO-CLOSEOUT.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage27demo-i-confirmation-send';

const {
  runGuestConfirmationSendGoNoGo,
  normalizeSendStatus,
  isConfirmationSendIdempotentReplay,
} = require('./lib/luna-guest-confirmation-send-go-no-go');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

const READY_PREVIEW = {
  success: true,
  confirmation_preview_ready: true,
  confirmation_send_allowed: false,
  booking_id: 'ba1a0426-c1c7-469e-a7c4-edf9b89ee12d',
  booking_code: 'WH-G27-850FDAFDB9',
  payment_status: 'deposit_paid',
  proposed_confirmation_message: 'Hi Guest — Room DEMO-R2 Gate 2684# WH-G27-850FDAFDB9',
  next_safe_step: 'ready_for_confirmation_send_go_no_go',
};

const LIVE_ENV = {
  WHATSAPP_DRY_RUN: 'false',
  LUNA_AUTO_SEND_ENABLED: 'true',
  LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST: '+491726422307',
};

console.log('\nverify-stage27demo-i-confirmation-send.js  (Stage 27demo-i closeout)\n');

try {
  execSync(`node --check "${SEND_MOD}"`, { stdio: 'pipe' });
  pass('0a', 'go/no-go module passes node --check');
} catch {
  fail('0a', 'module syntax error');
}

section('A. normalizeSendStatus idempotent replay');

if (normalizeSendStatus({ idempotent_replay: true, guest_message_send_status: 'sent' }, LIVE_ENV)
  === 'idempotent_replay') {
  pass('A1', 'idempotent_replay maps to idempotent_replay status');
} else {
  fail('A1', 'idempotent_replay must not map to send_error');
}

if (normalizeSendStatus({ confirmation_already_sent: true }, LIVE_ENV) === 'idempotent_replay') {
  pass('A2', 'confirmation_already_sent maps to idempotent_replay');
} else {
  fail('A2', 'confirmation_already_sent normalization');
}

if (isConfirmationSendIdempotentReplay({ send_skipped_reason: 'confirmation_sent_at_already_set' })) {
  pass('A3', 'confirmation_sent_at_already_set detected as replay');
} else {
  fail('A3', 'send_skipped_reason replay detection');
}

section('B. Duplicate send via guest_message_sends replay');

(async () => {
  let sendCallCount = 0;
  const mockSend = async () => {
    sendCallCount += 1;
    return {
      ok: true,
      status: 200,
      result: {
        success: true,
        send_performed: false,
        sends_whatsapp: false,
        idempotent_replay: true,
        duplicate: true,
        confirmation_already_sent: true,
        guest_message_send_status: 'sent',
        whatsapp_message_id: 'wamid.test-replay',
        guest_message_send_id: '00000000-0000-4000-8000-000000000099',
        confirmation_sent_at: '2026-06-09T21:36:03.370Z',
        message_preview: READY_PREVIEW.proposed_confirmation_message,
        blocked_reasons: [],
        updates_confirmation_sent_at: false,
      },
    };
  };

  const replay = await runGuestConfirmationSendGoNoGo(
    {
      confirmation_preview_result: READY_PREVIEW,
      confirm_send: true,
      to: '+491726422307',
      idempotency_key: 'open-demo:27demo-i:replay-test',
      client_slug: 'wolfhouse-somo',
      booking_code: READY_PREVIEW.booking_code,
    },
    { env: LIVE_ENV, sendLunaBookingConfirmation: mockSend, pg: { query: async () => ({ rows: [] }) } },
  );

  if (replay.send_status === 'idempotent_replay') pass('B1', 'duplicate returns idempotent_replay');
  else fail('B1', `expected idempotent_replay got ${replay.send_status}`);

  if (replay.confirmation_sent === true) pass('B2', 'confirmation_sent true on replay');
  else fail('B2', 'confirmation_sent must be true when already sent');

  if (replay.sends_whatsapp !== true) pass('B3', 'no second WhatsApp on replay');
  else fail('B3', 'sends_whatsapp must be false on replay');

  if (replay.duplicate_send_blocked === true) pass('B4', 'duplicate_send_blocked true');
  else fail('B4', 'duplicate_send_blocked flag');

  if (replay.next_safe_step === 'confirmation_sent') pass('B5', 'next_safe_step confirmation_sent');
  else fail('B5', `unexpected next_safe_step ${replay.next_safe_step}`);

  if (sendCallCount === 1) pass('B6', 'send helper invoked once (no duplicate provider call)');
  else fail('B6', `expected 1 send call got ${sendCallCount}`);

  section('C. confirmation_sent_at_already_set path');

  const alreadySentPreview = async () => ({
    success: true,
    message_preview: READY_PREVIEW.proposed_confirmation_message,
    booking_id: READY_PREVIEW.booking_id,
    booking_code: READY_PREVIEW.booking_code,
    confirmation_sent_at: '2026-06-09T21:36:03.370Z',
  });

  let alreadySentCalls = 0;
  const mockAlreadySent = async (_input, ctx) => {
    alreadySentCalls += 1;
    const preview = await ctx.getLunaBookingConfirmationPreview({}, {});
    return {
      ok: true,
      status: 200,
      result: {
        success: true,
        idempotent_replay: true,
        duplicate: true,
        confirmation_already_sent: true,
        send_skipped_reason: 'confirmation_sent_at_already_set',
        send_performed: false,
        sends_whatsapp: false,
        message_preview: preview.message_preview,
        blocked_reasons: [],
      },
    };
  };

  const fromSentAt = await runGuestConfirmationSendGoNoGo(
    {
      confirmation_preview_result: READY_PREVIEW,
      confirm_send: true,
      to: '+491726422307',
      idempotency_key: 'open-demo:27demo-i:sent-at-test',
      booking_code: READY_PREVIEW.booking_code,
    },
    {
      env: LIVE_ENV,
      sendLunaBookingConfirmation: mockAlreadySent,
      getLunaBookingConfirmationPreview: alreadySentPreview,
      pg: { query: async () => ({ rows: [] }) },
    },
  );

  if (fromSentAt.send_status === 'idempotent_replay') pass('C1', 'sent_at path returns idempotent_replay');
  else fail('C1', `sent_at path got ${fromSentAt.send_status}`);

  if (fromSentAt.sends_whatsapp !== true) pass('C2', 'sent_at path does not re-send WhatsApp');
  else fail('C2', 'sent_at path must not send WhatsApp');

  section('D. Closeout doc and package');

  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  if (pkg.scripts && pkg.scripts[SCRIPT]) pass('D1', `${SCRIPT} registered`);
  else fail('D1', `${SCRIPT} missing`);

  if (fs.existsSync(CLOSEOUT)) pass('D2', 'STAGE-27DEMO-CLOSEOUT.md exists');
  else fail('D2', 'closeout doc missing');

  const closeout = fs.readFileSync(CLOSEOUT, 'utf8');
  if (closeout.includes('27demo-i') && closeout.includes('WH-G27-850FDAFDB9')) {
    pass('D3', 'closeout references demo-i and anchor booking');
  } else {
    fail('D3', 'closeout missing demo-i or anchor booking');
  }

  const sendSrc = fs.readFileSync(SEND_MOD, 'utf8');
  if (sendSrc.includes('duplicate_send_blocked')) pass('D4', 'duplicate_send_blocked in go/no-go module');
  else fail('D4', 'duplicate_send_blocked flag missing');

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FAIL — verifier error:', e.message);
  process.exit(1);
});
