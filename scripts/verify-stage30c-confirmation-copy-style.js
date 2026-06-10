/**
 * Stage 30c — confirmation preview/send guest copy style verifier.
 *
 * Usage:
 *   npm run verify:stage30c-confirmation-copy-style
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STYLE_MOD = path.join(__dirname, 'lib', 'luna-guest-confirmation-copy-style.js');
const PREVIEW_MOD = path.join(__dirname, 'lib', 'luna-guest-confirmation-preview-dry-run.js');
const SEND_MOD = path.join(__dirname, 'lib', 'luna-guest-confirmation-send-go-no-go.js');
const COMPOSER = path.join(__dirname, 'lib', 'luna-guest-reply-composer.js');
const CONTRACT = path.join(__dirname, 'lib', 'luna-guest-reply-style-contract.js');
const BASE_PREVIEW = path.join(__dirname, 'lib', 'luna-booking-confirmation-preview.js');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage30c-confirmation-copy-style';

const {
  polishConfirmationGuestCopy,
  stripConfirmationInternalCopy,
  passesConfirmationStyleContract,
  CONFIRMATION_INTERNAL_PHRASES,
  GATE_CODE_REQUIRED,
  messageHasBedLeak,
} = require('./lib/luna-guest-confirmation-copy-style');
const {
  runGuestConfirmationPreviewDryRun,
  sanitizePreviewMessage,
  messageHasBedLeak: previewBedLeak,
} = require('./lib/luna-guest-confirmation-preview-dry-run');
const { buildReplyForState } = require('./lib/luna-guest-reply-composer');
const { isForbiddenGuestCopy } = require('./lib/luna-guest-reply-style-contract');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

const GATE_CODE = GATE_CODE_REQUIRED;
const ADDRESS = 'C. Mies de La Ran, 41, 39140 Somo, Cantabria';

function buildDepositDraft(overrides) {
  return {
    booking_code: 'WH-G27-PREVIEW',
    guest_name: 'Alex',
    payment_status: 'deposit_paid',
    amount_paid_cents: 20000,
    balance_due_cents: 80000,
    room_number: 'MB-01',
    address: ADDRESS,
    gate_code: GATE_CODE,
    ...overrides,
  };
}

console.log(`\nverify-stage30c-confirmation-copy-style.js  (Stage 30c)\n`);

section('A. Files + package');

check('A1', fs.existsSync(STYLE_MOD), 'confirmation copy style module exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A2', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

const previewSrc = fs.readFileSync(PREVIEW_MOD, 'utf8');
const sendSrc = fs.readFileSync(SEND_MOD, 'utf8');
const composerSrc = fs.readFileSync(COMPOSER, 'utf8');
const basePreviewSrc = fs.readFileSync(BASE_PREVIEW, 'utf8');

section('B. Preview path uses style contract');

check('B1', previewSrc.includes('luna-guest-confirmation-copy-style'), 'preview imports copy style module');
check('B2', previewSrc.includes('polishConfirmationGuestCopy'), 'sanitizePreviewMessage uses polish');
check('B3', previewSrc.includes('getLunaBookingConfirmationPreview'), 'reuses existing preview helper');
check('B4', !previewSrc.includes('function generateConfirmationMessage'), 'no second confirmation generator in preview dry-run');
check('B5', !basePreviewSrc.includes('luna-guest-confirmation-copy-style')
  || basePreviewSrc.includes('getLunaBookingConfirmationPreview'), 'base preview unchanged or still single path');

section('C. Send/ack path');

check('C1', sendSrc.includes('luna_guest_stage27q'), 'send reuses stage27q preview message');
check('C2', sendSrc.includes('preview_regenerated: false') || sendSrc.includes('preview_regenerated:false'), 'send does not regenerate message');
check('C3', composerSrc.includes('payment_received_preview_ready'), 'composer payment_received state');
check('C4', composerSrc.includes('confirmation_sent_ack'), 'composer confirmation_sent state');
check('C5', composerSrc.includes('Got it — your'), 'payment received ack copy updated');
check('C6', composerSrc.includes('Perfect — your Wolfhouse booking is confirmed'), 'confirmation sent ack copy updated');

section('D. Style sanitizer unit checks');

const dirty = 'Luna from Wolfhouse here ☀️ Hi Alex ☀️ Booking WH-G27-TEST confirmed. Paid: €100. Balance due: €80. Gate code: 2684#. Room: MB-01\nStaff review required — preview only dry run.';
const polished = polishConfirmationGuestCopy(dirty);
check('D1', polished && !/staff review|preview only|dry run/i.test(polished), 'strips internal staff phrases');
check('D2', polished.includes(GATE_CODE) && polished.includes('WH-G27-TEST'), 'preserves grounded facts');
check('D3', !isForbiddenGuestCopy(polished), 'passes forbidden phrase check');

const styleOk = passesConfirmationStyleContract(polished, {
  booking_code: 'WH-G27-TEST',
  amount_paid_cents: 10000,
  balance_due_cents: 8000,
});
check('D4', styleOk.ok, `style contract passes (${(styleOk.reasons || []).join(', ') || 'ok'})`);
check('D5', !messageHasBedLeak(polished), 'bed number blocked');

section('E. Fixture expectations');

const shortStay = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'short-stay-accommodation-only-to-deposit.json'), 'utf8'));
const sevenNight = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'seven-night-direct-package-to-deposit.json'), 'utf8'));
check('E1', shortStay.confirmation_expect && shortStay.confirmation_expect.confirmation_passes_style_contract === true, 'short-stay style contract flag');
check('E2', sevenNight.confirmation_expect && sevenNight.confirmation_expect.confirmation_passes_style_contract === true, 'seven-night style contract flag');

section('F. Composer ack copy');

const payAck = buildReplyForState('payment_received_preview_ready', {
  lang: 'en',
  fields: {},
  quote: {},
  plan: {},
  pc: {},
  result: {},
  availability: {},
  stripe: {},
  facts: { amount_paid_cents: 10000, balance_due_cents: 8000, payment_status: 'deposit_paid' },
});
check('F1', payAck && /deposit is in/i.test(payAck), 'payment ack mentions deposit');
check('F2', payAck && /remaining balance is €80/i.test(payAck), 'payment ack mentions balance');
check('F3', payAck && /full confirmation next/i.test(payAck), 'payment ack promises confirmation');
check('F4', payAck && !isForbiddenGuestCopy(payAck), 'payment ack no forbidden terms');
check('F5', !/preview ready|dry run|confirmation_sent_at|send gate/i.test(payAck || ''), 'payment ack no internal language');

const sentAck = buildReplyForState('confirmation_sent_ack', {
  lang: 'en',
  fields: {},
  quote: {},
  plan: {},
  pc: {},
  result: {},
  availability: {},
  stripe: {},
  facts: { confirmation_sent: true },
});
check('F6', sentAck && /Wolfhouse booking is confirmed/i.test(sentAck), 'sent ack confirms booking');
check('F7', sentAck && /gate code/i.test(sentAck), 'sent ack mentions gate code');
check('F8', sentAck && !isForbiddenGuestCopy(sentAck), 'sent ack no forbidden terms');

section('G. Live deposit preview integration');

(async () => {
  const deposit = await runGuestConfirmationPreviewDryRun(
    {
      booking_code: 'WH-G27-PREVIEW',
      language_hint: 'en',
      confirmation_draft: buildDepositDraft(),
    },
    { use_fixture_pg: true },
  );

  check('G1', deposit.confirmation_preview_ready === true, 'deposit preview ready');
  const msg = deposit.proposed_confirmation_message || '';
  check('G2', msg.includes(GATE_CODE), 'gate code 2684# present');
  check('G3', msg.includes('WH-G27-PREVIEW'), 'booking code present');
  check('G4', /€200|20000/.test(msg) || /paid/i.test(msg), 'paid amount present');
  check('G5', /balance|€800|80000/i.test(msg), 'balance due present when balance exists');
  check('G6', !previewBedLeak(msg), 'no bed number leak');
  check('G7', !CONFIRMATION_INTERNAL_PHRASES.some((p) => new RegExp(p, 'i').test(msg)), 'no internal confirmation phrases');

  const grounded = passesConfirmationStyleContract(msg, {
    booking_code: 'WH-G27-PREVIEW',
    amount_paid_cents: 20000,
    balance_due_cents: 80000,
  });
  check('G8', grounded.ok, `preview passes style contract (${(grounded.reasons || []).join(', ') || 'ok'})`);

  section('H. Safety — no behavior changes');

  check('H1', !previewSrc.includes('sendWhatsApp') && !previewSrc.includes('send_whatsapp'), 'preview no WhatsApp send');
  check('H2', !sendSrc.match(/\bactivate.*n8n\b/i), 'send no n8n activation');
  check('H3', !previewSrc.includes('stripe.checkout.sessions.create'), 'preview no Stripe path');
  check('H4', previewSrc.includes('confirmation_send_allowed: false') || previewSrc.includes('PREVIEW_SAFETY'), 'preview send still blocked');
  check('H5', sendSrc.includes('WHATSAPP_DRY_RUN') || sendSrc.includes('isWhatsappDryRun'), 'send gate preserved');
  check('H6', !previewSrc.includes('production') || !previewSrc.match(/deploy.*production/i), 'no production deploy hooks');

  section('Summary');
  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
