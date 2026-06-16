'use strict';

/**
 * Luna UX fixes — quote-reply patch, guest memory, small-booking deposit skip.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const patches = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/apply_gateway_patches.py'), 'utf8');
const bootstrap = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/bootstrap.sh'), 'utf8');
const freshStart = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/wolfhouse_guest_fresh_start.py'), 'utf8');
const soul = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/SOUL.md'), 'utf8');
const plugin = fs.readFileSync(
  path.join(ROOT, 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py'),
  'utf8',
);

const { quoteNeedsPaymentChoice, quoteHasRemainingBalanceAfterDeposit } = require('./lib/luna-quote-payment-choice');
const { runGuestQuoteProposalDryRun } = require('./lib/luna-guest-quote-proposal-dry-run');
const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }

console.log('\nverify-luna-ux-quote-memory-deposit.js\n');

// A — WhatsApp plain replies (no quote context for Luna)
check('A1', /WHATSAPP_CHUNK_CONTEXT_ANCHOR|WHATSAPP_CHUNK_CONTEXT_PATCH/.test(patches), 'whatsapp_cloud chunk context patch defined');
check('A2', /LUNA_PLAIN_REPLY_SEND_TAG|normal WhatsApp replies without quote blocks/.test(patches), 'send() clears reply_to for Luna');
check('A3', /install_runtime_whatsapp_patches/.test(patches), 'runtime patch installs in gateway process');
check('A4', /RUNTIME_PATCH_HOOK_TAG|install runtime WhatsApp patches when gateway loads/.test(patches), 'gateway.run loads runtime patch hook');
check('A5', /_wolfhouse_stream_reply_anchor/.test(patches), 'stream consumer strips guest quote anchor for Luna');
check('A6', /initial_reply_to_id=\(\s*\n\s*None\s*\n\s*if __import__\("os"\)\.getenv\("HERMES_ROLE"\) == "luna"/.test(patches), 'gateway.run skips stream initial_reply_to_id for Luna WhatsApp');

// B — guest memory disabled + wipe + SOUL language
check('B1', /memory_enabled:\s*false/.test(bootstrap), 'Luna config disables memory_enabled');
check('B2', /user_profile_enabled:\s*false/.test(bootstrap), 'Luna config disables user_profile_enabled');
check('B3', /clear_luna_agent_memories/.test(freshStart), 'fresh-start clears agent memories');
check('B4', /memories_cleared/.test(freshStart), 'fresh-start reports memories_cleared');
check('B5', /HERMES_HOME\/memories/.test(bootstrap), 'SOUL version bump clears memories dir');
check('B6', /latest message/.test(soul) && /Never assume language from their phone/.test(soul), 'SOUL: match latest message language');
check('B7', /list_my_bookings/.test(soul) && /welcome back/i.test(soul), 'SOUL: welcome back only with existing booking');

// C — skip deposit-vs-full when deposit >= total
check('C1', quoteHasRemainingBalanceAfterDeposit({ total_cents: 8000, deposit_required_cents: 10000 }) === false,
  '€80 total / €100 deposit → no remaining balance');
check('C2', quoteNeedsPaymentChoice({ quote_status: 'ready', total_cents: 8000, deposit_required_cents: 10000 }) === false,
  'small booking skips payment choice');
check('C3', quoteNeedsPaymentChoice({ quote_status: 'ready', total_cents: 59800, deposit_required_cents: 20000 }) === true,
  'weekly quote still needs payment choice');

const smallQuote = calculateWolfhouseQuote({
  client_slug: 'wolfhouse-somo',
  check_in: '2026-09-01',
  check_out: '2026-09-02',
  guest_count: 1,
  package_code: 'package_none',
  room_type: 'shared',
  payment_choice: 'deposit',
});
check('C4', smallQuote.success && smallQuote.deposit_required_cents >= smallQuote.total_cents,
  '1-night quote has deposit floor >= total');
check('C5', quoteNeedsPaymentChoice({ quote_status: 'ready', ...smallQuote }) === false,
  'engine quote skips payment choice');

const routerResult = {
  message_lane: 'new_booking_inquiry',
  detected_language: 'en',
  readiness_state: 'ready_for_availability_check',
  booking_intake_ready: true,
  package_night_rule: 'short_stay_accommodation',
  extracted_fields: {
    check_in: '2026-09-01',
    check_out: '2026-09-02',
    guest_count: 1,
    package_interest: 'accommodation_only',
    booking_ready_to_proceed: true,
  },
};
const availability = {
  availability_status: 'available',
  availability_check_attempted: true,
};
const quoteDry = runGuestQuoteProposalDryRun(routerResult, availability, { client_slug: 'wolfhouse-somo' });
check('C6', quoteDry.quote_status === 'ready' && quoteDry.payment_choice_needed === false,
  'dry-run adapter skips payment choice for sub-deposit total');
check('C7', quoteDry.full_payment_only === true, 'dry-run sets full_payment_only');

check('C8', /payment_choice_needed/.test(plugin) && /full_payment_only/.test(plugin),
  'Hermes plugin exposes payment_choice_needed + full_payment_only');

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
