#!/usr/bin/env node
'use strict';

/**
 * verify:luna-personality-live-eval
 *
 * Isolated Sunset-only no-send live-model corpus path (source + offline tests).
 * Does not call a live model, deploy, or mutate staging.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WOLF = path.join(ROOT, 'docker/hermes-staging/wolfhouse');
const CORE = path.join(WOLF, 'simulate_core.py');
const EVAL = path.join(WOLF, 'luna_personality_live_eval.py');
const ISO = path.join(WOLF, 'luna_personality_isolation.py');
const RUNNER = path.join(WOLF, 'run_luna_personality_live_proof.py');
const ROUTES = path.join(ROOT, 'scripts/lib/staff-luna-personality-routes.js');
const PY = path.join(WOLF, 'luna_personality.py');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

console.log('\nverify:luna-personality-live-eval — isolated no-send corpus path\n');

const evalSrc = fs.readFileSync(EVAL, 'utf8');
const isoSrc = fs.readFileSync(ISO, 'utf8');
const coreSrc = fs.readFileSync(CORE, 'utf8');
const pySrc = fs.readFileSync(PY, 'utf8');
const routeSrc = fs.readFileSync(ROUTES, 'utf8');
const runnerSrc = fs.readFileSync(RUNNER, 'utf8');

ok('isolation uses ContextVar not process env', /ContextVar/.test(isoSrc) && !/WOLFHOUSE_SIMULATE_GUEST_TURN/.test(isoSrc));
ok('isolation aborts before model, does not warn-and-continue',
  /IsolationAbort/.test(isoSrc) && /preflight_isolation_or_abort/.test(isoSrc)
  && !/warnings.append\(f"tool_capture_unavailable/.test(isoSrc));
ok('business tools denied including reads/previews',
  /check_availability/.test(evalSrc) && /quote_booking/.test(evalSrc)
  && /get_sunset_lesson_availability/.test(evalSrc) && /preview_package_prices/.test(evalSrc));
ok('allowlisted case ids only', /ALLOWED_CASE_IDS/.test(evalSrc) && /caller_override_rejected/.test(evalSrc));
ok('no arbitrary text/model/tenant overrides on route',
  /"text"/.test(evalSrc) && /"model"/.test(evalSrc) && /"client_slug"/.test(evalSrc));
ok('default simulate allow_writes preserved', /allow_writes=bool\(body.get\("allow_writes"\)\)/.test(coreSrc));
ok('isolated route registered without replacing simulate',
  /register_live_eval_route/.test(coreSrc) && /simulate-guest-turn/.test(coreSrc));
ok('bot GET resolves slug-only principal',
  /resolvePrincipalTenant/.test(routeSrc) && /loadSettingsBySlug/.test(routeSrc));
ok('canonical bot header helper present', /canonical_bot_auth_headers/.test(pySrc));
ok('runner defaults to dry-run and qualifies stored sunny restore',
  /dry-run/.test(runnerSrc) && /source=stored/.test(runnerSrc)
  && /LUNA_PERSONALITY_LIVE_PROOF/.test(runnerSrc));
ok('same-process gateway invoke not a second SOUL/model',
  /_handle_message/.test(evalSrc) && !/alternate SOUL|second bot/i.test(evalSrc));

const py = spawnSync('python3', ['-m', 'unittest', 'wolfhouse.test_luna_personality_live_eval'], {
  cwd: path.join(ROOT, 'docker/hermes-staging'),
  encoding: 'utf8',
});
if (py.status !== 0) {
  process.stdout.write(py.stdout || '');
  process.stderr.write(py.stderr || '');
}
ok('python isolated eval tests green', py.status === 0, `status ${py.status}`);

const dry = spawnSync('python3', ['-m', 'wolfhouse.run_luna_personality_live_proof'], {
  cwd: path.join(ROOT, 'docker/hermes-staging'),
  encoding: 'utf8',
  env: { ...process.env, HERMES_ROLE: 'luna', LUNA_CLIENT_SLUG: 'wolfhouse-somo' },
});
let dryJson = {};
try { dryJson = JSON.parse(dry.stdout || '{}'); } catch (_) { dryJson = {}; }
ok('dry-run runner does not execute live',
  dry.status === 0 && dryJson.mode === 'dry-run' && dryJson.execute_live === false,
  dry.stderr || `status ${dry.status}`);

console.log(`\nverify:luna-personality-live-eval: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
