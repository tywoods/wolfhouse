#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const serving = fs.readFileSync(path.join(root, 'docker/hermes-staging/SOUL.md'), 'utf8');
const full = fs.readFileSync(path.join(root, 'docker/hermes-staging/SOUL.approved-full.md'), 'utf8');
const dockerfile = fs.readFileSync(path.join(root, 'docker/hermes-staging/Dockerfile'), 'utf8');
const effectiveVerifier = fs.readFileSync(path.join(root, 'docker/hermes-staging/verify_luna_effective_soul.py'), 'utf8');

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
assert.strictEqual(serving, full, 'actual serving SOUL must equal every byte of approved full SOUL');
assert.ok(serving.length <= 200000, `serving SOUL exceeds configured loader cap: ${serving.length}`);
assert.match(dockerfile, /python \/etc\/hermes-staging\/test_build_luna_serving_soul\.py -v/);
assert.doesNotMatch(dockerfile, /python -m unittest \/etc\/hermes-staging\/test_build_luna_serving_soul\.py/);
assert.doesNotMatch(effectiveVerifier, /setattr\(config_module, "load_config"/);
assert.doesNotMatch(effectiveVerifier, /setattr\(pb, "get_hermes_home"/);
assert.match(effectiveVerifier, /os\.environ\["HERMES_HOME"\]/);
assert.match(effectiveVerifier, /write_luna_config/);
assert.match(effectiveVerifier, /negative control/i);
assert.match(effectiveVerifier, /outside isolated HERMES_HOME/i);
console.log('PASS proof-round-1 failure-recovery + exact-full-serving + real-config verifier contract 26/26');
