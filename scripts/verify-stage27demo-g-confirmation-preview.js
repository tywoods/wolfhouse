/**
 * Stage 27demo-g — Open demo confirmation preview dry-run verifier.
 *
 * Usage:
 *   npm run verify:stage27demo-g-confirmation-preview
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PREVIEW_BASE = path.join(__dirname, 'lib', 'luna-booking-confirmation-preview.js');
const PREVIEW_27Q = path.join(__dirname, 'lib', 'luna-guest-confirmation-preview-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage27demo-g-confirmation-preview';

const {
  runGuestConfirmationPreviewDryRun,
  messageHasBedLeak,
} = require('./lib/luna-guest-confirmation-preview-dry-run');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27demo-g-confirmation-preview.js  (Stage 27demo-g)\n');

try {
  execSync(`node --check ${PREVIEW_BASE}`, { stdio: 'pipe' });
  execSync(`node --check ${PREVIEW_27Q}`, { stdio: 'pipe' });
  pass('0a', 'preview modules pass node --check');
} catch (e) {
  fail('0a', 'node --check failed');
}

const baseSrc = fs.readFileSync(PREVIEW_BASE, 'utf8');
const qSrc = fs.readFileSync(PREVIEW_27Q, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

section('A. Reuses Stage 27q path');

if (qSrc.includes('runGuestConfirmationPreviewDryRun')) pass('A1', '27q wrapper present');
else fail('A1', '27q wrapper missing');

if (qSrc.includes('getLunaBookingConfirmationPreview')) pass('A2', 'delegates to Phase 14b preview');
else fail('A2', '14b preview not wired');

if (qSrc.includes('preview.room_numbers')) pass('A3', 'mapPreviewSuccess uses room_numbers from 14b');
else fail('A3', 'room_numbers not passed through 27q map');

section('B. Demo bed → room fallback');

if (baseSrc.includes("regexp_replace(bb.bed_code, '-B[0-9]+$', '')")) {
  pass('B1', 'ROOM_CODES_SQL derives room from bed_code when room_code null');
} else {
  fail('B1', 'bed_code room fallback missing');
}

if (baseSrc.includes('room_numbers: roomNumbers')) pass('B2', '14b returns room_numbers on success');
else fail('B2', 'room_numbers not returned from 14b');

section('C. Open demo deposit-paid preview fixture');

const demoDraft = {
  booking_code: 'WH-G27-DEMO-G',
  guest_name: 'Guest',
  payment_status: 'deposit_paid',
  amount_paid_cents: 20000,
  balance_due_cents: 49800,
  room_number: null,
  address: 'C. Mies de La Ran, 41, 39140 Somo, Cantabria',
  gate_code: '2684#',
};

const demoPg = {
  async query(sql, params) {
    if (/FROM bookings b/.test(sql)) {
      return {
        rows: [{
          booking_id: 'ba1a0426-c1c7-469e-a7c4-edf9b89ee12d',
          booking_code: 'WH-G27-DEMO-G',
          payment_status: 'deposit_paid',
          confirmation_sent_at: null,
          primary_room_code: null,
          amount_paid_cents: 20000,
          total_amount_cents: 69800,
          metadata: { confirmation_draft: demoDraft, language: 'en' },
        }],
      };
    }
    if (/FROM booking_beds bb/.test(sql)) {
      return { rows: [{ room_code: 'DEMO-R2' }] };
    }
    if (/FROM payments p/.test(sql)) return { rows: [] };
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  },
};

(async () => {
  const out = await runGuestConfirmationPreviewDryRun(
    { booking_code: 'WH-G27-DEMO-G', language_hint: 'en', client_slug: 'wolfhouse-somo' },
    { pg: demoPg },
  );

  if (out.confirmation_preview_ready === true) pass('C1', 'open demo deposit preview ready');
  else fail('C1', `not ready: ${(out.block_reasons || []).join(',')}`);

  if (out.next_safe_step === 'ready_for_confirmation_send_go_no_go') pass('C2', 'next_safe_step send go/no-go');
  else fail('C2', `unexpected next_safe_step: ${out.next_safe_step}`);

  const msg = out.proposed_confirmation_message || '';
  if (/DEMO-R2|Room:/i.test(msg)) pass('C3', 'message includes room label');
  else fail('C3', 'room label missing');

  if (!messageHasBedLeak(msg)) pass('C4', 'no bed-code leak');
  else fail('C4', 'bed leak in message');

  if (out.confirmation_send_allowed === false && out.sends_whatsapp === false) {
    pass('C5', 'preview safety flags block send');
  } else {
    fail('C5', 'send not blocked on preview');
  }

  section('D. Package script');

  if (pkg.scripts[SCRIPT]) pass('D1', `${SCRIPT} registered`);
  else fail('D1', `${SCRIPT} missing from package.json`);

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  fail('X', e.message);
  process.exit(1);
});
