'use strict';

const fs = require('fs');
const path = require('path');

const soul = fs.readFileSync(
  path.join(__dirname, '..', 'docker', 'hermes-staging', 'SOUL.md'),
  'utf8',
);

const required = [
  [
    'fresh greeting is hospitality before intake',
    /hospitality before intake[\s\S]{0,160}fresh greeting/i,
  ],
  [
    'open-ended first message does not ask for dates, guest count, or names',
    /open-ended[^\n]*(?:do not|don't)[^\n]*ask[^\n]*dates[^\n]*guest count[^\n]*names/i,
  ],
  [
    'fresh greeting mandates one booking-vs-information question',
    /ask exactly one booking-vs-information question/i,
  ],
  [
    'explicit booking intent asks only dates and guest count',
    /explicit booking intent[^\n]*dates[^\n]*guest count[^\n]*(?:do not|don't)[^\n]*names/i,
  ],
  [
    'booking step one is not necessarily conversation turn one',
    /first booking-intake step[^\n]*not necessarily[^\n]*first conversation reply/i,
  ],
  [
    'names are collected in Step 1B',
    /Step 1B[^\n]*names/i,
  ],
  [
    'greeting example introduces Luna before booking-or-information question',
    /greeting-only reply[^\n]*shape:[^\n]*I['’]m Luna[^\n]*thinking about a stay[^\n]*help with some info/i,
  ],
  [
    'both booking sequences place Step 1B before their next flow step',
    /Short-stay flow:[\s\S]{0,180}Step 1B[\s\S]{0,100}Availability[\s\S]*7\+ nights[\s\S]{0,500}Step 1B[\s\S]{0,100}Package choice/i,
  ],
  [
    'incident phrase is covered',
    /Hey Luna, you there\?/i,
  ],
];

const forbidden = [
  [
    'no stale names-from-Step-1 instruction remains',
    /names? (?:from|in) Step 1(?!B)|names? were collected in Step 1(?!B)|already have everyone(?:'s)? names from Step 1(?!B)/i,
  ],
  [
    'booking-vs-information question is mandatory, not optional guidance',
    /open question such as/i,
  ],
];

let failed = 0;
for (const [label, pattern] of required) {
  if (pattern.test(soul)) {
    console.log(`✓ ${label}`);
  } else {
    console.error(`✗ ${label}`);
    failed++;
  }
}
for (const [label, pattern] of forbidden) {
  if (pattern.test(soul)) {
    console.error(`✗ ${label}`);
    failed++;
  } else {
    console.log(`✓ ${label}`);
  }
}

const total = required.length + forbidden.length;
if (failed) {
  console.error(`\n${failed}/${total} Wolfhouse hospitality-first checks failed`);
  process.exit(1);
}

console.log(`\n${total}/${total} Wolfhouse hospitality-first checks passed`);
