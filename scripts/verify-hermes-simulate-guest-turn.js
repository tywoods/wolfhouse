'use strict';

/**
 * Static gate for Hermes simulate-guest-turn hook (no API key, no container).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const H = path.join(ROOT, 'docker', 'hermes-staging');

function threadToDigits(thread) {
  const key = String(thread || '').trim();
  if (!key) throw new Error('thread is required');
  if (key.startsWith('+')) {
    const digits = key.replace(/\D/g, '');
    if (digits.length >= 10) return digits;
  }
  const bare = key.replace(/\s/g, '');
  if (/^\d+$/.test(bare) && bare.length >= 10) return bare;
  const digest = crypto.createHash('sha256').update(key).digest('hex');
  const suffix = parseInt(digest.slice(0, 15), 16) % 10_000_000_000;
  return `49${String(suffix).padStart(10, '0')}`;
}

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n── verify-hermes-simulate-guest-turn ──\n');

const core = fs.readFileSync(path.join(H, 'wolfhouse', 'simulate_core.py'), 'utf8');
const cli = fs.readFileSync(path.join(H, 'wolfhouse', 'simulate_guest_turn.py'), 'utf8');
const guard = fs.readFileSync(path.join(H, 'wolfhouse', 'staging_guard.py'), 'utf8');
const route = fs.readFileSync(path.join(H, 'apply_whatsapp_simulate_route.py'), 'utf8');
const dockerfile = fs.readFileSync(path.join(H, 'Dockerfile'), 'utf8');
const bootstrap = fs.readFileSync(path.join(H, 'bootstrap.sh'), 'utf8');

check('A1 simulate route path', /\/wolfhouse\/simulate-guest-turn/.test(core));
check('A2 suppresses WhatsApp outbound', /suppressed_whatsapp/.test(core) && /WOLFHOUSE_SIMULATE_GUEST_TURN/.test(core));
check('A3 captures tool_calls with args', /tool_calls/.test(core) && /"args"/.test(core));
check('A4 staging guard', /assert_staging_environment/.test(core) && /staging/.test(guard));
const writeGuards = fs.readFileSync(path.join(H, 'wolfhouse', 'simulate_write_guards.py'), 'utf8');
check('A5 writes off redirects create→preview', /redirected_create_to_booking_preview/.test(writeGuards));
check('A6 CLI module invocation', /python3 -m wolfhouse\.simulate_guest_turn/.test(cli) || /--thread/.test(cli));
check('A7 route patch script', /register_simulate_route/.test(route) && /import wolfhouse\.simulate_core/.test(route));
check('A8 Dockerfile copies wolfhouse package', /COPY wolfhouse/.test(dockerfile));
check('A9 bootstrap applies simulate route', /apply_whatsapp_simulate_route/.test(bootstrap));

check('B1 thread_to_digits never uses wall clock', /never wall-clock/.test(core) && /Hash the full thread id/.test(core));
check('B2 hashes full thread string', /sha256\(key\.encode\("utf-8"\)\)/.test(core));
const isoA = threadToDigits('sim:iso-a');
const isoB = threadToDigits('sim:iso-b');
const isoA2 = threadToDigits('sim:iso-a');
check('B3 distinct sim threads', isoA !== isoB, `${isoA} vs ${isoB}`);
check('B4 stable across calls', isoA === isoA2);
check('B5 not epoch-shaped', !/^1\d{9}$/.test(isoA) && isoA.startsWith('49'));

console.log(`\n── Summary: ${pass} passed, ${fail} failed ──\n`);
process.exit(fail > 0 ? 1 : 0);
