#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const serving = fs.readFileSync(path.join(root, 'docker/hermes-staging/SOUL.md'), 'utf8');
const full = fs.readFileSync(path.join(root, 'docker/hermes-staging/SOUL.approved-full.md'), 'utf8');

for (const soul of [serving, full]) {
  assert.match(soul, /If `quote_booking` fails before returning an authoritative price/i);
  assert.match(soul, /preserve every known date, guest, room\/bed choice/i);
  assert.match(soul, /Ask a question only when the typed refusal identifies a genuinely missing guest detail/i);
  assert.match(soul, /Never restart intake, request repeated consent, promise an unproved retry/i);
  assert.match(soul, /Solo turn 3.*do not ask the guest to say “yes, book this”/is);
  assert.match(soul, /do not tell them the booking or link will be created\/sent immediately/is);
  assert.match(soul, /Couple turn 3.*retain that acceptance/is);
  assert.match(soul, /Do not ask them to confirm, accept, or consent again/is);
}
assert.ok(serving.length < 65280, `serving SOUL too long: ${serving.length}`);
console.log('PASS proof-round-1 failure-recovery SOUL contract 17/17');
