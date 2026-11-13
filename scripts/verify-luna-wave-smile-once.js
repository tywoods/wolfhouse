'use strict';

/**
 * Ty: Luna keeps plenty of emojis, mixes them, and uses the 🌊😊 pair
 * at most once per chat (first welcome). Deterministic — no model call.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const PAIR_RE = /🌊😊|😊🌊/g;

function pairHits(text) {
  return String(text || '').match(PAIR_RE) || [];
}

function turnsWithPair(messages) {
  return (messages || []).filter((m) => pairHits(m).length > 0).length;
}

const multiTurnChat = [
  "Hey, welcome to Wolf-House 🌊😊 What can I help you with?",
  "Malibu is a great week for that 🏄☀️",
  "Yoga is at 8 🧘",
  "There's taco night on Thursday 🌮🎉",
];
assert.strictEqual(
  turnsWithPair(multiTurnChat),
  1,
  'multi-turn chat may use 🌊😊 on the first welcome only',
);

const spamChat = [
  'Hey 🌊😊',
  'Those dates work 🌊😊',
  'Here is your stay 🌊😊',
  'Booking saved 🌊😊',
];
assert.strictEqual(
  turnsWithPair(spamChat),
  4,
  'helper must detect the pair on every spam turn (inverse)',
);

const soul = fs.readFileSync(path.join(root, 'docker/hermes-staging/SOUL.md'), 'utf8');
const guide01 = fs.readFileSync(
  path.join(root, 'docker/hermes-staging/soul-guides/01-core-voice-language.md'),
  'utf8',
);
assert.match(soul, /once per chat/);
assert.match(soul, /first welcome/);
assert.match(soul, /plenty of emojis/);
assert.doesNotMatch(soul, /fewer emojis|often none|at most one emoji/i);
assert.strictEqual(
  pairHits(soul).length,
  0,
  'standing SOUL must not teach the adjacent 🌊😊 pair every turn',
);
assert.strictEqual(
  pairHits(guide01).length,
  0,
  'voice guide must not teach the adjacent 🌊😊 pair every turn',
);
assert.ok(soul.includes(guide01), '01-core-voice-language.md must be the live SOUL prefix');

const personality = fs.readFileSync(
  path.join(root, 'docker/hermes-staging/wolfhouse/luna_personality.py'),
  'utf8',
);
const extraBlock = personality.slice(
  personality.indexOf('PACKS'),
  personality.indexOf('COMPOSER_OWNED_STATES'),
);
assert.match(extraBlock, /at least two colorful emoji/);
assert.doesNotMatch(
  extraBlock,
  /🌊 and 😊|😊 and 🌊|🌊😊/,
  'extra pack must not push 🌊😊 on every turn',
);

const corpus = JSON.parse(
  fs.readFileSync(
    path.join(root, 'docker/hermes-staging/fixtures/luna-personality-corpus.json'),
    'utf8',
  ),
);
for (const id of ['extra', 'sunny', 'calm', 'concise', 'conversationalist']) {
  const chat = (corpus.cases || []).map((c) => (c.replies && c.replies[id]) || '');
  const n = turnsWithPair(chat);
  assert.ok(
    n <= 1,
    `corpus ${id} multi-turn chat has ${n} 🌊😊 turns; want at most 1`,
  );
}

console.log('PASS: multi-turn chat has at most one 🌊😊');
