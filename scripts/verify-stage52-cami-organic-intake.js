/**
 * Stage 52 — Cami organic intake: greeting variation + Cami on intake/quote/payment warmth.
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const {
  CAMI_ELIGIBLE_STATES,
  COMPOSER_OWNED_STATES,
  shouldSkipCamiAuthor,
  applyGuestReplyPipeline,
} = require('./lib/luna-guest-reply-pipeline');
const {
  buildAuthorInput,
  runCamiGuestReplyAuthor,
} = require('./lib/luna-guest-cami-reply-author');
const { buildVariationContext } = require('./lib/luna-guest-cami-reply-variation');
const { buildWelcomeReply } = require('./lib/luna-guest-personality-config');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

const ENV = {
  ...process.env,
  LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED: 'true',
  OPENAI_API_KEY: '',
};

const mockCaller = (json) => async () => json;

(async () => {
  console.log('\nverify-stage52-cami-organic-intake.js  (Stage 52)\n');

  section('A. Cami eligible on intake + greeting');
  check('A1', CAMI_ELIGIBLE_STATES.includes('greeting'), 'greeting cami-eligible');
  check('A2', CAMI_ELIGIBLE_STATES.includes('ask_dates'), 'ask_dates cami-eligible');
  check('A3', CAMI_ELIGIBLE_STATES.includes('package_quote_ready'), 'quote cami-eligible');
  check('A4', CAMI_ELIGIBLE_STATES.includes('payment_choice_ack'), 'payment ack cami-eligible');
  check('A5', !COMPOSER_OWNED_STATES.includes('ask_dates'), 'ask_dates not composer-owned');

  section('B. Pipeline does not skip Cami on hello / intake');
  {
    const hello = shouldSkipCamiAuthor({
      composed: { covered: true, composer_state: 'greeting', reply: 'Hey!' },
      payload: { result: { greeting_only: true } },
    });
    check('B1', hello.skip !== true, 'hello does not skip cami');

    const dates = shouldSkipCamiAuthor({
      composed: { covered: true, composer_state: 'ask_dates', reply: 'What dates?' },
      payload: { result: {} },
    });
    check('B2', dates.skip !== true, 'ask_dates does not skip cami');
  }

  section('C. Welcome variation by conversation');
  {
    const w1 = buildWelcomeReply('wolfhouse-somo', 'en', {}, {
      guest_phone: '+34600111111',
      conversation_id: 'conv-aaa',
    });
    const w2 = buildWelcomeReply('wolfhouse-somo', 'en', {}, {
      guest_phone: '+34600111111',
      conversation_id: 'conv-bbb',
    });
    check('C1', w1 && w2, 'welcome replies generated');
    check('C2', w1 !== w2, 'different conversations get different welcome wording');
  }

  section('D. Cami author accepts greeting + quote mocks');
  {
    const greetOut = await runCamiGuestReplyAuthor({
      client_slug: 'wolfhouse-somo',
      latest_guest_message: 'hello!',
      deterministic_reply: "Heyyy! I'm Luna from Wolfhouse 🌊 Book a stay or need info?",
      composer_state: 'greeting',
      payload: { result: { greeting_only: true } },
      booking_state: { greeting_only: true, detected_language: 'en', missing_fields: [] },
    }, {
      env: ENV,
      authorCaller: mockCaller(JSON.stringify({
        reply: "Holaaa 🌊 I'm Luna at Wolfhouse!\n\nBook a stay or want some info — what sounds good?",
      })),
    });
    check('D1', greetOut.author_used === true, 'greeting cami author_used');
    check('D2', !/malibu/i.test(greetOut.authored_reply), 'greeting no packages');

    const quoteInput = buildAuthorInput({
      client_slug: 'wolfhouse-somo',
      latest_guest_message: 'malibu',
      deterministic_reply: 'Perfect — Malibu €498 total. Deposit or full?',
      composer_state: 'package_quote_ready',
      allowed_next_action: 'collect_payment_choice',
      payload: {
        result: { extracted_fields: { check_in: '2026-06-22', check_out: '2026-06-29', guest_count: 2, package_interest: 'malibu' } },
        quote: { quote_status: 'ready', quote_total_cents: 49800, deposit_required_cents: 20000 },
        payment_choice: { payment_choice_ready: false },
      },
    });
    const quoteOut = await runCamiGuestReplyAuthor(
      { ...quoteInput, deterministic_reply: quoteInput.deterministic_reply },
      {
        env: ENV,
        authorCaller: mockCaller(JSON.stringify({
          reply: 'Yay 😊 Malibu for June 22 to June 29, 2 guests.\n\nI checked — €498 total.\n\n€200 deposit or pay in full — which works?',
        })),
      },
    );
    check('D3', quoteOut.author_used === true, 'quote cami author_used');
    check('D4', /€498|498 total/i.test(quoteOut.authored_reply), 'quote preserves total');
  }

  section('E. Reply pipeline invokes Cami on hello (mock)');
  {
    const out = await applyGuestReplyPipeline({
      client_slug: 'wolfhouse-somo',
      message_text: 'hello!',
      composed: {
        covered: true,
        composer_state: 'greeting',
        reply: 'Heyyy! Book a stay?',
        reply_source: 'composer',
      },
      candidate_reply: 'Heyyy! Book a stay?',
      candidate_source: 'composer',
      payload: { result: { greeting_only: true } },
      env: ENV,
      authorCaller: mockCaller(JSON.stringify({ reply: 'Ciao 🌊 Luna here — book a stay or need info?' })),
    });
    check('E1', out.reply_pipeline.cami_skipped !== true, 'pipeline does not skip cami on hello');
    check('E2', out.cami_reply_author.cami_author_used === true, 'cami used on hello with mock');
  }

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})();
