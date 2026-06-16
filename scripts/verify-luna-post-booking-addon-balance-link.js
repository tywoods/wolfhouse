'use strict';

/**
 * Static gate — post-booking add-ons use one balance payment link (not per-service).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const soul = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/SOUL.md'), 'utf8');
const plugin = fs.readFileSync(
  path.join(ROOT, 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py'),
  'utf8',
);
const guards = fs.readFileSync(
  path.join(ROOT, 'docker/hermes-staging/plugins/wolfhouse_staff_api/test_luna_tool_guards.py'),
  'utf8',
);

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }

console.log('\nverify-luna-post-booking-addon-balance-link.js\n');

check('P1', /create_balance_payment_link.*add_service_to_booking|after each successful add/i.test(soul),
  'SOUL: post-booking flow calls create_balance_payment_link after add_service');
check('P2', /Never.*per-service checkout URL/i.test(soul),
  'SOUL: never send per-service checkout URL');
check('P3', /one.*balance link|one.*link from.*create_balance_payment_link/i.test(soul),
  'SOUL: one balance link for guest');
check('P4', /add_ons.*short-stay|During a short-stay booking/i.test(soul),
  'SOUL: during-booking bundling section preserved');
check('P5', /use_balance_payment_link/.test(plugin),
  'plugin: add_service sets use_balance_payment_link');
check('P6', /next_action.*create_balance_payment_link/.test(plugin),
  'plugin: next_action create_balance_payment_link');
check('P7', /create_balance_payment_link.*unpaid post-booking add-on|unpaid post-booking add-on/i.test(plugin),
  'plugin: balance tool description covers unpaid add-ons');
check('P8', /two services → one balance link/.test(guards),
  'test: two services → one balance link scenario');
check('P9', /A5 balance sums both services/.test(guards),
  'test: balance amount sums both services');

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
