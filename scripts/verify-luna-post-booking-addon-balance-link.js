'use strict';

/**
 * Static gate — post-booking add-ons send their Staff-created per-service links.
 * Filename retained for the existing verify:luna-all entry; explicit balance requests still work.
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

check('P1', /one link per saved add-on/.test(soul),
  'SOUL: send each saved service link');
check('P2', !/Never.*send the per-service checkout URL|Never stack per-service links/.test(soul),
  'SOUL: no instruction suppresses valid service links');
check('P3', /same receipt/.test(soul) && /send both returned links/i.test(soul),
  'SOUL: preserve service-to-guest labels and both links');
check('P4', /add_ons.*short-stay|During a short-stay booking|During initial booking — both short stays and weekly packages/i.test(soul),
  'SOUL: during-booking bundling section preserved');
check('P5', /"use_balance_payment_link": False/.test(plugin),
  'plugin: no extra balance-link step');
check('P6', /"send_payment_link" if send_addon_link/.test(plugin),
  'plugin: successful service link goes directly to guest');
check('P7', /create_balance_payment_link.*unpaid post-booking add-on|unpaid post-booking add-on/i.test(plugin),
  'plugin: balance tool description covers unpaid add-ons');
check('P8', /two services → two service links/.test(guards),
  'test: two services keep their own links');
check('P9', /A5 balance sums both services/.test(guards),
  'test: balance amount sums both services');

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
