#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const routes = fs.readFileSync(path.join(root, 'scripts/lib/staff-bot-v2-routes.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'scripts/lib/luna-front-desk-payment-link-service.js'), 'utf8');

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing section ${start}`);
  return source.slice(from, to);
}

const whole = between(routes, 'async function handleBotPaymentCreateStripeLink', 'async function handleBotCreateBalancePaymentLink');
const perGuest = between(routes, 'async function handleBotGuestPaymentCreateLink', 'async function handleBotGuestPaymentStatus');
const create = between(service, 'async function createPaymentLink', 'async function loadLockedDepositCheckout');

assert.match(create, /idempotent:\s*true[\s\S]*expires_at:\s*pm\.expires_at/,
  'reused whole-booking links must return the persisted expiry');
assert.match(create, /const expiresAt = session\.expires_at[\s\S]*expires_at:\s*expiresAt/,
  'new whole-booking links must return the Stripe expiry');
assert.ok((whole.match(/expires_at:\s*b\.expires_at \|\| null/g) || []).length >= 2,
  'whole-booking route must expose expiry for new and idempotent responses');
assert.match(perGuest, /expires_at:\s*checkout\.session\.expires_at\s*\?\s*new Date\(checkout\.session\.expires_at \* 1000\)\.toISOString\(\)\s*:\s*null/,
  'per-guest route must expose authoritative Stripe expiry');

console.log('verify:booking-payment-deadline-propagation PASS');
