'use strict';

// Offline L3 regression. SOUL checks are instruction contracts, not model inference.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const soul = fs.readFileSync(path.join(root, 'docker/hermes-staging/SOUL.md'), 'utf8');
const sunset = fs.readFileSync(path.join(root, 'docker/hermes-sunset/SOUL.md'), 'utf8');
const short = soul.split('Short-stay flow:')[1].split('**7+ nights')[0];
const weekly = soul.split('**7+ nights')[1].split('**Payment wording')[0];
assert(short.indexOf('**Room preference') >= 0 && short.indexOf('**Room preference') < short.indexOf('**Quote'),
  'short stays must resolve room preference before quote/payment');
assert(weekly.indexOf('Room preference') >= 0 && weekly.indexOf('Room preference') < weekly.indexOf('Step 3 — Quote'),
  'weekly stays must resolve room preference before quote/payment');
for (const [name, text] of [['Wolfhouse', soul], ['Sunset', sunset]]) {
  assert(text.includes('After pay intent, never ask gender or group composition'), `${name}: missing post-pay rule`);
  assert(text.includes('full payment, a deposit, a link each, or a payment link'), `${name}: all payment intents`);
  assert(text.includes('all personality packs and guest languages'), `${name}: tone/language must not override rule`);
}
assert(!/room-preference step\*\* \(just before create\)|Ask immediately before create|One missing or uncertain traveler → ask \*\*one\*\* composition question/.test(soul),
  'remove unconditional late composition instructions');
assert(soul.includes('Do not treat payment intent as gender evidence'), 'payment is not demographic evidence');
assert(soul.includes('Would a mixed dorm work for you?'), 'neutral recovery remains available');
assert(soul.includes('Reuse the room choice and room-policy answers already given'), 'reuse earlier resolution');
assert(sunset.includes('do not import Wolfhouse accommodation or room-composition intake'), 'Sunset stays service-only');
console.log('PASS L3 SOUL ordering, no-gender-after-pay instruction contracts (both tenants)');
if (!process.argv.includes('--soul-only')) {
  const allocation = spawnSync(process.execPath, ['scripts/verify-luna-mixed-room-allocation.js'],
    { cwd: root, encoding: 'utf8', env: process.env, timeout: 60000 });
  if (allocation.stdout) process.stdout.write(allocation.stdout);
  if (allocation.stderr) process.stderr.write(allocation.stderr);
  if (allocation.error) throw allocation.error;
  assert.equal(allocation.status, 0, 'unknown-composition compatible allocation');
  for (const test of [
    'docker/hermes-staging/plugins/wolfhouse_staff_api/test_no_gender_after_pay_intent.py',
    'docker/hermes-staging/wolfhouse/test_no_gender_prompt_boundary.py',
  ]) {
    const run = spawnSync(process.env.PYTHON || 'python3', [test, '-v'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 60000 });
    if (run.stdout) process.stdout.write(run.stdout);
    if (run.stderr) process.stderr.write(run.stderr);
    if (run.error) throw run.error;
    assert.equal(run.status, 0, test);
  }
}
