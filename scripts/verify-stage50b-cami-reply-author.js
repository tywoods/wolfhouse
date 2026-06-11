/**
 * Stage 50b — GPT Cami Reply Author verifier (mocked GPT, no live API required).
 *
 * Usage:
 *   node scripts/verify-stage50b-cami-reply-author.js
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const {
  buildAuthorInput,
  validateCamiAuthoredReply,
  runCamiGuestReplyAuthor,
  isCamiReplyAuthorEnabled,
} = require('./lib/luna-guest-cami-reply-author');
const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

const AUTHOR_ENV = {
  ...process.env,
  LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED: 'true',
  OPENAI_API_KEY: '',
  LUNA_GUEST_AGENT_BRAIN_ENABLED: 'true',
};

const MOCK_PACKAGE_REPLY = JSON.stringify({
  reply: [
    'Lovely 😊 Quick guide for your stay:',
    '',
    '🏡 Malibu — simple weekly stay, from €249.',
    '',
    '🏄 Uluwatu — Malibu + surfboard and wetsuit rental, from €349.',
    '',
    '🌊 Waimea — Malibu + lessons + gear, from €499.',
    '',
    'For June 11 to June 20 with 3 guests — stay only, gear, or lessons vibe?',
  ].join('\n'),
});

const MOCK_PACKAGE_INFO_REPLY = JSON.stringify({
  reply: [
    'Sure 😊',
    '',
    '🏡 Malibu — simple weekly stay, from €249.',
    '',
    '🏄 Uluwatu — Malibu + board + wetsuit, from €349.',
    '',
    '🌊 Waimea — Malibu + lessons + gear, from €499.',
    '',
    'Which direction feels right for you?',
  ].join('\n'),
});

const MOCK_QUOTE_REPLY = JSON.stringify({
  reply: [
    'Yay 😊 Malibu for June 11 to June 20, 3 guests.',
    '',
    'I checked it — the stay comes to €1080 total.',
    '',
    'To hold it, €100 deposit now or pay the full €1080 — which works better?',
  ].join('\n'),
});

const MOCK_PAYMENT_LINK_REPLY = JSON.stringify({
  reply: [
    'Amazing 🙌 Malibu hold is ready for June 11 to June 20.',
    '',
    'Pay the €100 deposit here: https://staff-staging.lunafrontdesk.com/pay/WH-G27-TEST123',
    '',
    'Ping me once it\'s done and I\'ll keep an eye on it for you 😊',
  ].join('\n'),
});

const MOCK_GUEST_COUNT_REPLY = JSON.stringify({
  reply: 'Super — June 11 to June 20 locked in 🌊 How many guests will be staying?',
});

const MOCK_BAD_REPLY = JSON.stringify({
  reply: 'The router says €9999 total and the Stripe link is ready — AI backend confirmed availability.',
});

function mockCaller(replyJson) {
  return async () => replyJson;
}

function baseInput(overrides) {
  return buildAuthorInput({
    client_slug: 'wolfhouse-somo',
    latest_guest_message: overrides.message || 'hello',
    deterministic_reply: overrides.deterministic || 'Perfect — dates noted. How many guests?',
    allowed_next_action: overrides.allowed_next_action || 'ask_missing_details',
    prior_guest_context: {},
    payload: {
      result: {
        extracted_fields: overrides.fields || {},
        detected_language: 'en',
        message_lane: 'new_booking_inquiry',
      },
      availability: overrides.availability || { availability_status: 'not_ready' },
      quote: overrides.quote || { quote_status: 'not_ready' },
      payment_choice: overrides.payment_choice || { payment_choice_ready: false },
      hold_payment_draft_plan: overrides.hold_plan || { plan_status: 'not_run' },
    },
    composer_state: overrides.composer_state || 'ask_package_choice',
  });
}

(async () => {
  console.log('\nverify-stage50b-cami-reply-author.js  (Stage 50b)\n');

  section('A. Package choice after dates + count');
  {
    const input = baseInput({
      message: '3',
      fields: { check_in: '2026-06-11', check_out: '2026-06-20', guest_count: 3 },
      deterministic: 'Lovely. Malibu Uluwatu Waimea options. Are you thinking stay only?',
    });
    const out = await runCamiGuestReplyAuthor(
      { ...input, deterministic_reply: input.deterministic_reply },
      { env: AUTHOR_ENV, authorCaller: mockCaller(MOCK_PACKAGE_REPLY) },
    );
    check('A1', out.author_used === true, 'author_used');
    check('A2', /malibu/i.test(out.authored_reply) && /uluwatu/i.test(out.authored_reply) && /waimea/i.test(out.authored_reply),
      'explains all three packages');
    check('A3', (out.authored_reply.match(/\n/g) || []).length >= 4, 'WhatsApp spacing');
    check('A4', !/want me to explain/i.test(out.authored_reply), 'no explain-offer');
    check('A5', (out.authored_reply.match(/\?/g) || []).length <= 2, 'one clear next question');
  }

  section('B. Package info direct answer');
  {
    const input = baseInput({
      message: 'Tell me about the packages',
      fields: { check_in: '2026-06-11', check_out: '2026-06-20', guest_count: 3 },
      composer_state: 'explain_packages',
    });
    const out = await runCamiGuestReplyAuthor(
      { ...input, deterministic_reply: 'Want me to explain them quickly?' },
      { env: AUTHOR_ENV, authorCaller: mockCaller(MOCK_PACKAGE_INFO_REPLY) },
    );
    check('B1', out.author_used === true, 'author_used');
    check('B2', !/want me to explain/i.test(out.authored_reply), 'no redundant explain ask');
    check('B3', /\n/.test(out.authored_reply), 'spaced answer');
  }

  section('C. Quote ready');
  {
    const input = baseInput({
      message: 'ok Malibu',
      fields: { check_in: '2026-06-11', check_out: '2026-06-20', guest_count: 3, package_interest: 'malibu' },
      quote: { quote_status: 'ready', quote_total_cents: 108000, deposit_required_cents: 10000, package_code: 'malibu' },
      availability: { availability_status: 'ready', has_enough_beds: true },
      allowed_next_action: 'collect_payment_choice',
      composer_state: 'package_quote_ready',
      deterministic: 'Perfect. €1080 total. Deposit or full?',
    });
    const out = await runCamiGuestReplyAuthor(
      { ...input, deterministic_reply: input.deterministic_reply },
      { env: AUTHOR_ENV, authorCaller: mockCaller(MOCK_QUOTE_REPLY) },
    );
    check('C1', out.author_used === true, 'author_used');
    check('C2', /€1080/.test(out.authored_reply), 'preserves quote total');
    check('C3', /€100/.test(out.authored_reply), 'preserves deposit');
    check('C4', /\b(?:deposit|full)\b/i.test(out.authored_reply), 'asks deposit vs full');
    check('C5', !/€9999/.test(out.authored_reply), 'no invented values');
  }

  section('D. Payment link ready');
  {
    const payUrl = 'https://staff-staging.lunafrontdesk.com/pay/WH-G27-TEST123';
    const input = baseInput({
      message: 'Deposit is fine',
      fields: { check_in: '2026-06-11', check_out: '2026-06-20', guest_count: 3, package_interest: 'malibu' },
      quote: { quote_status: 'ready', quote_total_cents: 108000, deposit_required_cents: 10000 },
      payment_choice: { payment_choice_ready: true, payment_preference: 'deposit' },
      hold_plan: { plan_status: 'ready', payment_link_url: payUrl, ready_for_hold_draft: true },
      deterministic: `Pay here: ${payUrl}`,
    });
    input.payment_choice_result = {
      ...input.payment_choice_result,
      payment_link_url: payUrl,
      hold_plan_status: 'ready',
    };
    const out = await runCamiGuestReplyAuthor(
      { ...input, deterministic_reply: input.deterministic_reply },
      { env: AUTHOR_ENV, authorCaller: mockCaller(MOCK_PAYMENT_LINK_REPLY) },
    );
    check('D1', out.author_used === true, 'author_used');
    check('D2', out.authored_reply.includes(payUrl), 'includes payment URL');
    check('D3', !/stripe\s+link/i.test(out.authored_reply), 'no Stripe link phrase');
  }

  section('E. Missing guest count');
  {
    const input = baseInput({
      message: 'June 11 to June 20',
      fields: { check_in: '2026-06-11', check_out: '2026-06-20' },
      composer_state: 'ask_guests',
      allowed_next_action: 'ask_missing_details',
      deterministic: 'Perfect — June 11 to June 20. How many guests will be staying?',
    });
    const out = await runCamiGuestReplyAuthor(
      { ...input, deterministic_reply: input.deterministic_reply },
      { env: AUTHOR_ENV, authorCaller: mockCaller(MOCK_GUEST_COUNT_REPLY) },
    );
    check('E1', out.author_used === true, 'author_used');
    check('E2', /how many guests/i.test(out.authored_reply), 'asks guest count');
    check('E3', !/package/i.test(out.authored_reply), 'does not jump to packages');
  }

  section('F. Safety rejection + fallback');
  {
    const input = baseInput({
      message: 'malibu',
      fields: { check_in: '2026-06-11', check_out: '2026-06-20', guest_count: 3 },
      quote: { quote_status: 'ready', quote_total_cents: 108000, deposit_required_cents: 10000 },
      deterministic: 'Deterministic fallback quote €1080.',
    });
    const rejections = validateCamiAuthoredReply(
      'The router says €9999 total and the Stripe link is ready — AI backend confirmed.',
      input,
    );
    check('F1', rejections.length > 0, 'validator rejects unsafe mock');
    check('F2', rejections.some((r) => r.includes('invented_price') || r === 'forbidden_internal_copy'), 'invented price or internal words');

    const out = await runCamiGuestReplyAuthor(
      { ...input, deterministic_reply: input.deterministic_reply },
      { env: AUTHOR_ENV, authorCaller: mockCaller(MOCK_BAD_REPLY) },
    );
    check('F3', out.author_used !== true, 'author not used');
    check('F4', out.fallback_used === true, 'fallback_used');
    check('F5', out.authored_reply === input.deterministic_reply, 'deterministic reply preserved');
  }

  section('G. No API key fallback');
  {
    check('G1', isCamiReplyAuthorEnabled({ LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED: 'false' }) === false, 'default off');
    const input = baseInput({ deterministic: 'Hello from deterministic path.' });
    const out = await runCamiGuestReplyAuthor(
      { ...input, deterministic_reply: input.deterministic_reply },
      { env: { ...AUTHOR_ENV, LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED: 'true', OPENAI_API_KEY: '' } },
    );
    check('G2', out.fallback_used === true, 'fallback when no key');
    check('G3', out.author_used !== true, 'author not used without key');
    check('G4', out.authored_reply === input.deterministic_reply, 'no crash, deterministic preserved');

    const off = await runCamiGuestReplyAuthor(
      { ...input, deterministic_reply: 'Stay deterministic.' },
      { env: { ...process.env, LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED: 'false' } },
    );
    check('G5', off.rejection_reason === 'author_disabled', 'flag off skips author');
  }

  section('H. Orchestrator regression — author off by default');
  {
    const out = await runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo',
      channel: 'dry_run',
      message_text: 'June 11th to 20th',
      guest_phone: '+34600500050',
      guest_context: {
        result: { extracted_fields: { check_in: '2026-06-11' } },
      },
      reference_date: '2026-06-11',
    }, { env: { ...process.env, LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED: 'false' } });
    check('H1', !!(out && out.proposed_luna_reply), 'orchestrator still returns reply');
    check('H2', !(out.result && out.result.cami_reply_author && out.result.cami_reply_author.cami_author_used), 'author off in default path');
  }

  section('I. Orchestrator with mocked author enabled');
  {
    const mockReply = JSON.stringify({
      reply: 'Heyyy 🌊 June 11–20 noted — how many of you are coming?',
    });
    const out = await runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo',
      channel: 'dry_run',
      message_text: 'June 11th to 20th',
      guest_phone: '+34600500051',
      guest_context: {},
      reference_date: '2026-06-11',
    }, {
      env: { ...AUTHOR_ENV, LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED: 'true' },
      cami_reply_author_caller: mockCaller(mockReply),
    });
    check('I1', /how many/i.test(out.proposed_luna_reply || ''), 'mock author reply used');
    check('I2', out.result && out.result.cami_reply_author && out.result.cami_reply_author.cami_author_used === true,
      'observability shows author used');
  }

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
