/**
 * Stage 56 — 100-case Luna guest agent regression fixture generator.
 *
 * Focused multi-turn booking flows for agent-driven fix loops:
 * package tier intake, payment phrase variants, tier/name pollution guards.
 *
 * Usage:
 *   node scripts/generate-luna-guest-agent-regression-fixtures.js
 *   npm run luna:agent-regression:generate
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SEED = 56001;
const DEFAULT_OUT = path.join(__dirname, 'fixtures', 'generated-luna-guest-agent-regression.json');

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function baseSafety() {
  return {
    banned_reply_terms_absent: true,
    must_not_confirm_booking: true,
    must_not_claim_payment_received: true,
    must_not_invent_availability: true,
  };
}

const TIER_PHRASES = [
  { text: 'stay only', package: 'malibu' },
  { text: 'gear included', package: 'uluwatu' },
  { text: 'lessons included', package: 'waimea' },
  { text: 'malibu', package: 'malibu' },
  { text: 'uluwatu', package: 'uluwatu' },
  { text: 'waimea', package: 'waimea' },
  { text: 'accommodation only', package: 'malibu' },
  { text: 'room only', package: 'malibu' },
];

const DEPOSIT_PHRASES = [
  'deposit works',
  'deposit is fine',
  "i'll start with the deposit",
  'ill start with the deposit',
  'start with the deposit',
  'pay the deposit',
  'just the deposit',
  'deposit please',
  'a deposit',
];

const DATE_RANGES = [
  'Aug 1-8',
  'August 1 to August 8',
  'Jul 10 thru Jul 17',
  'September 5 to September 12',
  'Oct 3 - Oct 10',
  'June 15 to June 22',
  '1 Aug to 8 Aug',
  '10 July to 17 July',
];

const GUEST_COUNTS = ['2 please', '2 guests', 'we are 2', 'just me', '3 people', 'family of 4'];

const OPENERS = ['Looking to book', 'Hi, looking to book', 'I want to book', 'Book a stay please'];

function packageTierIntakeFlows(rng, count) {
  const cases = [];
  for (let i = 0; i < count; i++) {
    const tier = pick(rng, TIER_PHRASES);
    const dates = pick(rng, DATE_RANGES);
    const guests = pick(rng, GUEST_COUNTS);
    const opener = pick(rng, OPENERS);
    const deposit = pick(rng, DEPOSIT_PHRASES);
    cases.push({
      id: `agent-pkg-${String(i + 1).padStart(3, '0')}`,
      category: 'package_tier_intake',
      language: 'en',
      kind: 'flow',
      endpoint: 'simulator',
      tags: ['stay_only_fix', 'payment_choice'],
      turns: [
        {
          message: opener,
          expect: {
            ...baseSafety(),
            message_lane: 'new_booking_inquiry',
          },
        },
        {
          message: dates,
          expect: { ...baseSafety() },
        },
        {
          message: guests,
          expect: { ...baseSafety() },
        },
        {
          message: tier.text,
          expect: {
            ...baseSafety(),
            extracted_fields: { package_interest: tier.package },
            extracted_fields_must_not: { guest_name: tier.text },
            reply_must_not_contain: [
              'are you thinking more stay only',
              'quick guide',
            ],
          },
        },
        {
          message: deposit,
          expect: {
            ...baseSafety(),
            payment_choice: 'deposit',
          },
        },
      ],
      final_expect: {
        ...baseSafety(),
        extracted_fields: { package_interest: tier.package },
        extracted_fields_must_not: { guest_name: tier.text },
      },
    });
  }
  return cases;
}

function paymentPhraseCases(rng, count) {
  const cases = [];
  const quoteCtx = {
    message_lane: 'new_booking_inquiry',
    extracted_fields: {
      check_in: '2026-08-01',
      check_out: '2026-08-08',
      guest_count: 2,
      package_interest: 'malibu',
    },
    quote: {
      quote_status: 'quote_ready',
      total_eur: 698,
      deposit_eur: 200,
    },
    payment_choice: { payment_choice_ready: false },
  };
  for (let i = 0; i < count; i++) {
    const phrase = DEPOSIT_PHRASES[i % DEPOSIT_PHRASES.length];
    cases.push({
      id: `agent-pay-${String(i + 1).padStart(3, '0')}`,
      category: 'payment_phrase',
      language: 'en',
      kind: 'single',
      message_text: phrase,
      guest_context: quoteCtx,
      expected: {
        ...baseSafety(),
        message_lane: 'new_booking_inquiry',
        payment_choice: 'deposit',
        payment_choice_ready: true,
      },
    });
  }
  return cases;
}

function tierPhraseGuardCases(rng, count) {
  const cases = [];
  for (let i = 0; i < count; i++) {
    const tier = TIER_PHRASES[i % TIER_PHRASES.length];
    cases.push({
      id: `agent-guard-${String(i + 1).padStart(3, '0')}`,
      category: 'tier_phrase_guard',
      language: 'en',
      kind: 'single',
      message_text: tier.text,
      guest_context: {
        extracted_fields: {
          check_in: '2026-08-01',
          check_out: '2026-08-08',
          guest_count: 2,
        },
        intake_state: { active_field: 'package_interest' },
      },
      expected: {
        ...baseSafety(),
        message_lane: 'new_booking_inquiry',
        extracted_fields: { package_interest: tier.package },
        extracted_fields_must_not: { guest_name: tier.text },
      },
    });
  }
  return cases;
}

function repeatGuideRegressionCases(rng, count) {
  const cases = [];
  const variants = [
    ['Looking to book', 'Aug 1-8', '2 please', 'stay only'],
    ['Hi', 'July 10 to July 17', '2 guests', 'gear included'],
    ['Book please', 'Sep 5 to Sep 12', 'we are 2', 'lessons included'],
  ];
  for (let i = 0; i < count; i++) {
    const flow = variants[i % variants.length];
    const tier = TIER_PHRASES[i % TIER_PHRASES.length];
    cases.push({
      id: `agent-repeat-${String(i + 1).padStart(3, '0')}`,
      category: 'repeat_guide_regression',
      language: 'en',
      kind: 'flow',
      endpoint: 'simulator',
      tags: ['repeat_guide'],
      turns: flow.slice(0, 3).map((message) => ({
        message,
        expect: { ...baseSafety() },
      })).concat([{
        message: tier.text,
        expect: {
          ...baseSafety(),
          extracted_fields: { package_interest: tier.package },
          reply_must_not_contain: [
            'are you thinking more stay only, gear included',
            'malibu — simple weekly stay',
          ],
        },
      }]),
      final_expect: { ...baseSafety() },
    });
  }
  return cases;
}

function buildAllCases(seed = SEED) {
  const rng = mulberry32(seed);
  return [
    ...packageTierIntakeFlows(rng, 50),
    ...paymentPhraseCases(rng, 25),
    ...tierPhraseGuardCases(rng, 15),
    ...repeatGuideRegressionCases(rng, 10),
  ];
}

function main() {
  const outArg = process.argv.find((a, i) => process.argv[i - 1] === '--output');
  const seedArg = process.argv.find((a, i) => process.argv[i - 1] === '--seed');
  const out = outArg || DEFAULT_OUT;
  const seed = seedArg ? Number(seedArg) : SEED;
  const cases = buildAllCases(seed);
  const payload = {
    version: 'stage56-agent-regression-v1',
    seed,
    generated_at: new Date().toISOString(),
    reference_date: '2026-06-08',
    default_client_slug: 'wolfhouse-somo',
    case_count: cases.length,
    categories: {
      package_tier_intake: 50,
      payment_phrase: 25,
      tier_phrase_guard: 15,
      repeat_guide_regression: 10,
    },
    cases,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${cases.length} agent regression cases → ${out}`);
}

if (require.main === module) main();

module.exports = { buildAllCases, SEED, DEFAULT_OUT };
