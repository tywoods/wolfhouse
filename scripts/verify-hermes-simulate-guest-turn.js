'use strict';

/**
 * Static + executable gate for Hermes simulate-guest-turn hook.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const H = path.join(ROOT, 'docker', 'hermes-staging');
const WOLF = path.join(H, 'wolfhouse');

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

const core = fs.readFileSync(path.join(WOLF, 'simulate_core.py'), 'utf8');
const cli = fs.readFileSync(path.join(WOLF, 'simulate_guest_turn.py'), 'utf8');
const guard = fs.readFileSync(path.join(WOLF, 'staging_guard.py'), 'utf8');
const writeGuards = fs.readFileSync(path.join(WOLF, 'simulate_write_guards.py'), 'utf8');
const route = fs.readFileSync(path.join(H, 'apply_whatsapp_simulate_route.py'), 'utf8');
const dockerfile = fs.readFileSync(path.join(H, 'Dockerfile'), 'utf8');
const bootstrap = fs.readFileSync(path.join(H, 'bootstrap.sh'), 'utf8');

check('A1 simulate route path', /\/wolfhouse\/simulate-guest-turn/.test(core));
check('A1b isolated personality eval is a separate route',
  fs.existsSync(path.join(WOLF, 'luna_personality_live_eval.py'))
  && /register_live_eval_route/.test(core)
  && /luna-personality-live-eval/.test(fs.readFileSync(path.join(WOLF, 'luna_personality_live_eval.py'), 'utf8')));
check('A1c default simulate still exposes allow_writes', /allow_writes=bool\(body.get\("allow_writes"\)\)/.test(core));
check('A2 suppresses WhatsApp outbound', /suppressed_whatsapp/.test(core) && /WOLFHOUSE_SIMULATE_GUEST_TURN/.test(core));
check('A3 captures tool_calls with args', /tool_calls/.test(core) && /"args"/.test(core));
check('A4 staging guard', /assert_staging_environment/.test(core) && /staging/.test(guard));
check('A4b staging guard allows guest Luna roles', /ALLOWED_GUEST_LUNA_ROLES/.test(guard)
  && /["']luna["']/.test(guard)
  && /["']sunset-luna["']/.test(guard));
check('A4c staging guard excludes orchestrator', !/ALLOWED_GUEST_LUNA_ROLES\s*=\s*\{[^}]*["']orchestrator["']/.test(guard));
check('A5 writes off redirects create→preview', /redirected_create_to_booking_preview/.test(writeGuards));
check('A6 CLI module invocation', /python3 -m wolfhouse\.simulate_guest_turn/.test(cli) || /--thread/.test(cli));
check('A7 route patch script', /register_simulate_route/.test(route) && /import wolfhouse\.simulate_core/.test(route));
check('A8 Dockerfile copies wolfhouse package', /COPY wolfhouse/.test(dockerfile));
check('A9 bootstrap applies simulate route', /apply_whatsapp_simulate_route/.test(bootstrap));

check('C1 Sunset booking-create guard present', /blocked_sunset_booking_write_in_simulate/.test(writeGuards));
check('C2 Sunset payment-link guard present', /blocked_sunset_payment_write_in_simulate/.test(writeGuards));
check('C3 central blocked predicate in core', /is_simulate_write_blocked/.test(core));
check('C4 synthetic blocked result helper', /synthetic_blocked_result/.test(writeGuards) && /synthetic_blocked_result/.test(core));
check('C5 orig_post_bot skipped when blocked', /is_simulate_write_blocked\(guard_warnings\)/.test(core)
  && !/blocked_payment" in w for w in guard_warnings/.test(core));
check('C6 lesson-quote not in Sunset write block list', /sunset\/lesson-quote/.test(writeGuards)
  && !/blocked_sunset.*lesson-quote/.test(writeGuards));

check('D1 burst coalesce module', fs.existsSync(path.join(WOLF, 'whatsapp_burst_coalesce.py')));
check('D2 burst simulate path', /simulate-guest-burst/.test(core) && /run_simulated_burst/.test(core));
check('D3 burst accepts messages array', /body\.get\("messages"\)/.test(core));
check('D4 burst coalesce patch installed from gateway patches',
  fs.readFileSync(path.join(H, 'apply_gateway_patches.py'), 'utf8').includes('install_whatsapp_burst_coalesce_patch'));
check('D5 sunset compose enables coalesce',
  fs.readFileSync(path.join(ROOT, 'docker', 'hermes-sunset', 'docker-compose.vm.yml'), 'utf8')
    .includes('WHATSAPP_BURST_COALESCE_ENABLED'));
check('D6 bootstrap writes coalesce env for sunset-luna',
  /sunset-luna/.test(bootstrap) && /WHATSAPP_BURST_DEBOUNCE_MS/.test(bootstrap));

try {
  execSync(`python3 ${path.join(WOLF, 'test_simulate_write_guards.py')}`, {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  check('C7 python guard regressions', true);
} catch (err) {
  const out = String((err && err.stdout) || '') + String((err && err.stderr) || '');
  check('C7 python guard regressions', false, out.split('\n').slice(-3).join(' '));
}

try {
  execSync(`python3 ${path.join(WOLF, 'test_whatsapp_burst_coalesce.py')}`, {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  check('D7 burst coalesce unit tests', true);
} catch (err) {
  const out = String((err && err.stdout) || '') + String((err && err.stderr) || '');
  check('D7 burst coalesce unit tests', false, out.split('\n').slice(-5).join(' '));
}

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
