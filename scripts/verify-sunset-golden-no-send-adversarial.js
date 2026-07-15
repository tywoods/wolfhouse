'use strict';

/**
 * Adversarial proofs for Sunset golden central no-send guard.
 * RED: misconfigured fixtures / force-send attempts must remain blocked.
 * GREEN: read tools remain allowed.
 *
 * Run:
 *   node scripts/verify-sunset-golden-no-send-adversarial.js
 *   npm run verify:sunset-golden-no-send-adversarial
 */

const assert = require('assert');
const {
  BLOCK_REASON,
  evaluateSideEffect,
  evaluateToolCall,
  guardedDispatch,
  guardedToolCall,
} = require('./lib/sunset-golden-no-send-guard');

let failed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err && err.message ? err.message : err}`);
  }
}

const evil = {
  allow_writes: true,
  whatsapp_suppressed: false,
  email_suppressed: false,
};

console.log('verify-sunset-golden-no-send-adversarial\n');
console.log('── RED (must block) ──');

check('booking_create blocked when allow_writes:true', () => {
  const g = evaluateSideEffect('booking_create', evil);
  assert.strictEqual(g.allowed, false);
  assert.strictEqual(g.reason, BLOCK_REASON);
  assert.strictEqual(g.fixture_flags_ignored, true);
});

check('create_sunset_booking tool blocked when allow_writes:true', () => {
  const g = evaluateToolCall('create_sunset_booking', evil);
  assert.strictEqual(g.allowed, false);
  assert.strictEqual(g.reason, BLOCK_REASON);
});

check('create_sunset_payment_link tool blocked', () => {
  const g = evaluateToolCall('create_sunset_payment_link', evil);
  assert.strictEqual(g.allowed, false);
});

check('whatsapp_send blocked when whatsapp_suppressed:false', () => {
  const g = evaluateSideEffect('whatsapp_send', evil);
  assert.strictEqual(g.allowed, false);
});

check('email_send blocked when email_suppressed:false', () => {
  const g = evaluateSideEffect('email_send', evil);
  assert.strictEqual(g.allowed, false);
});

check('guardedDispatch never invokes create callback', () => {
  let called = false;
  const out = guardedDispatch('booking_create', evil, () => {
    called = true;
    return { ok: true };
  });
  assert.strictEqual(called, false);
  assert.strictEqual(out.blocked, true);
});

check('guardedToolCall never invokes payment-link callback', () => {
  let called = false;
  const out = guardedToolCall('create_sunset_payment_link', evil, () => {
    called = true;
    return { ok: true };
  });
  assert.strictEqual(called, false);
  assert.strictEqual(out.blocked, true);
});

console.log('\n── GREEN (must allow reads) ──');

check('get_sunset_group_lesson_quote allowed', () => {
  let called = false;
  const out = guardedToolCall('get_sunset_group_lesson_quote', evil, () => {
    called = true;
    return { ok: true };
  });
  assert.strictEqual(called, true);
  assert.strictEqual(out.ok, true);
});

check('get_sunset_lesson_availability allowed', () => {
  const g = evaluateToolCall('get_sunset_lesson_availability', evil);
  assert.strictEqual(g.allowed, true);
});

console.log(`\n── adversarial ${failed ? 'FAILED' : 'PASSED'} ──`);
process.exit(failed ? 1 : 0);
