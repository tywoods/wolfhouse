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
ok('live preflight requires ALL seams AND, never OR',
  /REQUIRED_LIVE_SEAMS/.test(isoSrc)
  && /tool_hook_wrapped/.test(isoSrc)
  && /journal_wrapped/.test(isoSrc)
  && /executor_ctx_wrapped/.test(isoSrc)
  && !/if not \(_post_bot_wrapped or _tool_hook_wrapped\)/.test(isoSrc));
ok('executor copies ContextVar into worker threads',
  /copy_context\(/.test(isoSrc) && /ThreadPoolExecutor\.submit/.test(isoSrc));
ok('business tools denied including reads/previews',
  /check_availability/.test(evalSrc) && /quote_booking/.test(evalSrc)
  && /get_sunset_lesson_availability/.test(evalSrc) && /preview_package_prices/.test(evalSrc)
  && /terminal/.test(evalSrc) && /web_search/.test(evalSrc));
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
ok('runner execute-live owns snapshot PUT restore GET',
  /execute_live_matrix/.test(runnerSrc)
  && /put_and_verify/.test(runnerSrc)
  && /StaffSessionTransport/.test(runnerSrc)
  && /bot_write_not_authorized/.test(runnerSrc)
  && /parse_exact_staff_origin/.test(runnerSrc)
  && /OfflineStaffTransportDouble/.test(runnerSrc)
  && /never live acceptance/.test(runnerSrc));
ok('exact origin allowlist not substring',
  /ALLOWED_STAFF_ORIGINS/.test(pySrc)
  && /sunset-staging\.lunafrontdesk\.com/.test(pySrc)
  && /staff_origin_not_allowlisted/.test(pySrc)
  && /parse_exact_staff_origin/.test(runnerSrc)
  && /parse_exact_eval_url/.test(runnerSrc));
ok('same-process gateway invoke not a second SOUL/model',
  /_handle_message/.test(evalSrc) && !/alternate SOUL|second bot/i.test(evalSrc));
ok('separate-process runner uses authenticated exact-target HTTP',
  /ServingEvalHttpTransport/.test(runnerSrc)
  && /parse_exact_eval_url/.test(runnerSrc)
  && /lunabox\.lunafrontdesk\.com/.test(runnerSrc)
  && !/import gateway.run/.test(runnerSrc));
ok('eval path is Sunset HTTP /whatsapp/v1/internal not Wolfhouse /wolfhouse',
  /LIVE_EVAL_PATH = "\/whatsapp\/v1\/internal\/luna-personality-live-eval"/.test(evalSrc)
  && /live_sunset_eval_identity/.test(evalSrc)
  && /hermes-sunset-luna-http/.test(evalSrc)
  && /8094/.test(evalSrc)
  && !/LIVE_EVAL_PATH = "\/wolfhouse\/luna-personality-live-eval"/.test(evalSrc));
ok('provider dispatch is SDK create/converse not worker start',
  /observe_provider_dispatch/.test(isoSrc)
  && /provider_dispatch_wrapped/.test(isoSrc)
  && /unsupported_provider_backend/.test(isoSrc)
  && /Worker start is not SDK dispatch/.test(isoSrc));
ok('readiness requires serving runner handler and session db before Staff writes',
  /gateway_runner_unavailable/.test(evalSrc)
  && /gateway_handler_unavailable/.test(evalSrc)
  && /gateway_session_db_unavailable/.test(evalSrc)
  && /serving_runtime_missing/.test(evalSrc));
ok('canonical FINAL handler text not interim send substitute',
  /extract_final_handler_text/.test(evalSrc)
  && /final_handler_text/.test(evalSrc)
  && /interim_send_text/.test(isoSrc));
ok('independent restore GET always attempted',
  /independent_get_attempted/.test(runnerSrc)
  && /effective_restored/.test(runnerSrc)
  && /exact_source_restored/.test(runnerSrc)
  && /ambiguous_outcome/.test(runnerSrc));
ok('provider dispatch distinct from helper entry; streaming wrapped',
  /observe_provider_helper_attempt/.test(isoSrc)
  && /interruptible_streaming_api_call/.test(isoSrc)
  && /provider_streaming_wrapped/.test(isoSrc)
  && /pack_not_observed_from_provider/.test(evalSrc));
ok('env/file presence is not consumed observation',
  /consumed_model_observed/.test(runnerSrc)
  && /server_owned_env_declaration_not_consumed_observation/.test(runnerSrc)
  && !/\"model_observed\": bool\(model\)/.test(runnerSrc));
ok('eval fails closed on pack mismatch, fallback, missing model',
  /pack_mismatch/.test(evalSrc) && /setting_fallback/.test(evalSrc)
  && /model_not_invoked/.test(evalSrc) && /missing_generated_reply/.test(evalSrc));
ok('grading rejects contradictions and does not claim complete semantic proof',
  /contradicted_fact/.test(evalSrc) && /complete_semantic_proof/.test(evalSrc)
  && /PENINSULAR_MARKERS/.test(evalSrc) && /missing_spanish_language/.test(evalSrc));

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
