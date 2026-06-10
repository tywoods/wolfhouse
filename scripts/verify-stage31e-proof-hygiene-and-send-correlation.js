/**
 * Stage 31e — proof hygiene + hosted send correlation verifier.
 *
 * Usage:
 *   npm run verify:stage31e-proof-hygiene-and-send-correlation
 */

'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const ROOT = path.join(__dirname, '..');
const HYGIENE = path.join(__dirname, 'lib', 'luna-live-proof-hygiene.js');
const CORRELATION = path.join(__dirname, 'lib', 'luna-hosted-proof-send-correlation.js');
const COMPOSER = path.join(__dirname, 'lib', 'luna-guest-reply-composer.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage31e-proof-hygiene-and-send-correlation';

const {
  isExplicitPaidProofReset,
  applyPaidProofArchiveReset,
} = require('./lib/luna-live-proof-hygiene');
const { correlateHostedProofTurns } = require('./lib/luna-hosted-proof-send-correlation');
const { composeLunaGuestReply } = require('./lib/luna-guest-reply-composer');
const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { withPgClient } = require('./lib/pg-connect');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage31e-proof-hygiene-and-send-correlation.js  (Stage 31e)\n`);

section('A. Files + package');

check('A1', fs.existsSync(CORRELATION), 'send correlation module exists');
check('A2', fs.existsSync(HYGIENE), 'hygiene module exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A3', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

const hygieneSrc = fs.readFileSync(HYGIENE, 'utf8');
const corrSrc = fs.readFileSync(CORRELATION, 'utf8');
const composerSrc = fs.readFileSync(COMPOSER, 'utf8');

section('B. Paid proof reset guards');

check('B1', !isExplicitPaidProofReset({}), 'paid reset blocked by default');
check('B2', isExplicitPaidProofReset({ allow_staging_paid_proof_reset: true }), 'explicit flag enables reset');
check('B3', isExplicitPaidProofReset({ env: { ALLOW_STAGING_PAID_PROOF_RESET: 'true' } }), 'env flag enables reset');
check('B4', !isExplicitPaidProofReset({ env: { ALLOW_STAGING_PAID_PROOF_RESET: 'false' } }), 'env false keeps reset off');
check('B5', hygieneSrc.includes('assertNotProductionDb'), 'production DB guard');
check('B6', hygieneSrc.includes('isStagingResetEnvironment'), 'staging environment guard');
check('B7', hygieneSrc.includes('DELETE FROM booking_beds'), 'releases bed blocks');
check('B8', !hygieneSrc.includes('DELETE FROM payments'), 'preserves payment audit rows');

section('C. Send correlation unit');

const sampleEvents = [
  {
    created_at: '2026-06-10T21:04:13.162Z',
    message_text: 'Malibu July 10 to July 17 for 1',
    wa_message_id: 'wamid.1',
    suggested_reply: 'Malibu €299 first',
  },
  {
    created_at: '2026-06-10T21:04:33.538Z',
    message_text: 'actually make it Uluwatu',
    wa_message_id: 'wamid.2',
    suggested_reply: 'Uluwatu €399 second',
  },
  {
    created_at: '2026-06-10T21:04:53.083Z',
    message_text: 'deposit',
    wa_message_id: 'wamid.3',
    suggested_reply: 'deposit ack',
  },
];
const sampleSends = [
  { id: 's1', created_at: '2026-06-10T21:04:15.970Z', message_text: 'Malibu €299 first', provider_message_id: 'p1', status: 'sent' },
  { id: 's2', created_at: '2026-06-10T21:04:36.436Z', message_text: 'Uluwatu €399 second', provider_message_id: 'p2', status: 'sent' },
  { id: 's3', created_at: '2026-06-10T21:04:56.542Z', message_text: 'deposit ack', provider_message_id: 'p3', status: 'sent' },
];
const correlated = correlateHostedProofTurns(sampleEvents, sampleSends);
check('C1', correlated.turns.length === 3, 'correlates all turns');
check('C2', correlated.turns[0].match_method === 'inbound_window' && correlated.turns[0].actual_sent_text.includes('Malibu'), 'turn 1 window match');
check('C3', correlated.turns[1].actual_sent_text.includes('Uluwatu'), 'turn 2 not first send');
check('C4', correlated.turns[2].provider_message_id === 'p3', 'turn 3 has provider_message_id');
check('C5', correlated.reused_send_ids.length === 0, 'no send reused across turns');
check('C6', corrSrc.includes('match_method'), 'correlation exposes match_method');
check('C7', corrSrc.includes('duplicate_send_reused'), 'correlation exposes duplicate warning');

const buggy = correlateHostedProofTurns(sampleEvents, [sampleSends[0]]);
check('C8', buggy.turns[1].match_method === 'suggested_reply' && buggy.turns[1].luna.includes('Uluwatu'), 'fallback to suggested_reply when send missing');

section('D. Guest-count correction copy');

const gcPayload = {
  result: {
    message_lane: 'new_booking_inquiry',
    package_night_rule: 'short_stay_accommodation',
    previous_quote_invalidated: true,
    corrected_fields: ['guest_count'],
    extracted_fields: {
      check_in: '2026-07-06',
      check_out: '2026-07-10',
      guest_count: 2,
      addons_skipped: true,
    },
  },
  quote: {
    quote_status: 'ready',
    quote_total_cents: 36000,
    payment_choice_needed: true,
    short_stay_addons_pending: false,
    check_in: '2026-07-06',
    check_out: '2026-07-10',
    guest_count: 2,
    deposit_options: { deposit_required_cents: 10000 },
  },
  payment_choice: { payment_choice_ready: false },
  availability: { availability_status: 'available' },
  hold_payment_draft_plan: { plan_status: 'not_ready' },
};
const gcReply = composeLunaGuestReply({
  payload: gcPayload,
  message_text: 'actually we are 2',
});
check('D1', gcReply.covered === true, 'guest-count correction composer covered');
check('D2', /updating that to 2 guests/i.test(gcReply.reply || ''), 'mentions updated guest count');
check('D3', /€360|360/.test(gcReply.reply || ''), 'mentions updated price');
check('D4', /deposit|full/i.test(gcReply.reply || ''), 'payment choice after add-ons resolved');
check('D5', composerSrc.includes('buildGuestCountCorrectionPaymentReply'), 'guest-count correction helper wired');

section('E. Stale quote alignment still passes');

(async () => {
  function ctxFrom(out) {
    return {
      extracted_fields: out.result && out.result.extracted_fields,
      quote: out.quote,
      payment_choice: out.payment_choice,
      availability: out.availability,
      result: { ...(out.result || {}), proposed_luna_reply: out.proposed_luna_reply },
    };
  }
  async function turn(ctx, message_text) {
    const out = await withPgClient((pg) => runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      message_text,
      guest_phone: '+491726422307',
      guest_context: ctx,
      reference_date: '2026-06-10',
    }, { reference_date: '2026-06-10', pg }));
    return { out, ctx: ctxFrom(out) };
  }

  let ctx = {};
  ({ ctx } = await turn(ctx, 'Malibu July 10 to July 17 for 1'));
  const corr = (await turn(ctx, 'actually make it Uluwatu')).out;
  check('E1', corr.result.previous_quote_invalidated === true, 'package correction still invalidates');
  check('E2', (corr.quote && corr.quote.package_code === 'uluwatu') || /uluwatu/i.test(corr.proposed_luna_reply || ''), 'package correction still shows Uluwatu');
  check('E3', !/\bmalibu\b/i.test(corr.proposed_luna_reply || ''), 'no stale Malibu copy');

  section('F. Paid reset dry-run audit');

  const mockPg = {
    queries: [],
    async query(sql) {
      this.queries.push({ sql });
      if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [] };
      if (/DELETE FROM booking_beds/.test(sql)) return { rowCount: 1, rows: [] };
      if (/UPDATE payments/.test(sql)) return { rowCount: 1, rows: [] };
      if (/UPDATE bookings/.test(sql)) return { rowCount: 1, rows: [] };
      return { rows: [] };
    },
  };
  const dry = await applyPaidProofArchiveReset(
    mockPg,
    'client-id',
    { booking_id: '11111111-1111-1111-1111-111111111111', booking_code: 'WH-G27-AE23A49F21' },
    [{ payment_id: 'p1', status: 'paid' }],
    [{ bed_code: 'DEMO-R1-B1' }],
    'stage31e-verifier',
    true,
  );
  check('F1', dry.would_reset === true, 'dry-run reports would_reset');
  check('F2', mockPg.queries.filter((q) => /UPDATE bookings/.test(q.sql)).length === 0, 'dry-run makes no booking writes');

  section('G. Safety');

  check('G1', !corrSrc.includes('sendWhatsApp'), 'correlation module does not send WhatsApp');
  check('G2', !hygieneSrc.match(/\bactivate.*n8n\b/i), 'hygiene does not activate n8n');
  check('G3', !composerSrc.includes('stripe.checkout.sessions.create'), 'composer does not create Stripe');

  section('Summary');
  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
