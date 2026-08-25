'use strict';

/**
 * Chapter 4G CLI near-miss proof. Requires the operator prover only.
 * Must not load the live-target factory, Azure, KV, JWKS, token, or PG.
 * A source test cannot consume a live attempt.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const {
  runCli,
  parseArgs,
  liveModeAllowed,
  LIVE_DEPLOY_SHA_ALLOWLIST,
  CONFIRMATION_PHRASE,
} = require('./lib/email-luna-controlled-drafting-live-downscope-prover');

const DEPLOYED_SHA = 'f6ee511273160cb46c72e345137800878d4c6512';
const REVISION = 'luna-sunset-staging-staff-api--ch4f-f6ee5112';
const DIGEST = 'sha256:20d419d708a8e88115ccea3fb81bbd2a7d2ec67e0942c0be5be376d08d1a234a';
const LIVE_TARGET_SUFFIX = 'email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-target.js';

function liveTargetLoaded() {
  return Object.keys(require.cache).some((key) => String(key).replace(/\\/g, '/').endsWith(LIVE_TARGET_SUFFIX));
}

function disabledEnv(patch = {}) {
  return Object.assign({
    LUNA_DEPLOYMENT: 'sunset-staging',
    DEFAULT_CLIENT_SLUG: 'sunset',
    EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED: 'false',
    EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: 'false',
    EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED: 'false',
    EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_TICK_ENABLED: 'false',
    EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED: 'false',
    LUNA_AUTO_SEND_ENABLED: 'false',
    CUSTOMER_OUTREACH_WHATSAPP_ENABLED: 'false',
    STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED: 'false',
    EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT: '1',
  }, patch);
}

function completeSunsetArgs(extra = []) {
  return [
    'prove',
    '--target', 'sunset-staging',
    '--deploy-sha', DEPLOYED_SHA,
    '--revision', REVISION,
    '--digest', DIGEST,
    '--confirm', CONFIRMATION_PHRASE,
    '--operator-nonce', 'ab'.repeat(32),
    '--confirm-issued-at', new Date().toISOString(),
    ...extra,
  ];
}

function assertSanitized(record) {
  const text = JSON.stringify(record);
  assert.equal(text.includes('postgres://'), false);
  assert.equal(text.includes('eyJ'), false);
  assert.equal(/Bearer\s+[A-Za-z0-9._-]+/.test(text), false);
}

async function main() {
  console.log('FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4G CLI near-miss (zero sensitive deps)');
  assert.equal(liveTargetLoaded(), false);
  assert.equal(LIVE_DEPLOY_SHA_ALLOWLIST.length, 1);
  assert.equal(LIVE_DEPLOY_SHA_ALLOWLIST[0], DEPLOYED_SHA);
  assert.equal(Object.isFrozen(LIVE_DEPLOY_SHA_ALLOWLIST), true);
  assert.equal(liveModeAllowed(DEPLOYED_SHA), true);
  assert.equal(liveModeAllowed(DEPLOYED_SHA.slice(0, 8)), false);
  assert.equal(liveModeAllowed(DEPLOYED_SHA.toUpperCase()), false);
  assert.equal(liveModeAllowed(`${DEPLOYED_SHA}a`.slice(1)), false);
  assert.equal(liveModeAllowed('0'.repeat(40)), false);
  assert.equal(liveModeAllowed(`${DEPLOYED_SHA}ff`.slice(0, 40) === DEPLOYED_SHA
    ? 'e'.repeat(40)
    : `${DEPLOYED_SHA.slice(0, 39)}e`), false);

  const env = disabledEnv();
  const equalsForm = runCli(['prove', '--target=sunset-staging'], env);
  assert.equal(equalsForm.ok, false);
  assert.equal(equalsForm.simulation, true);
  assert.equal(equalsForm.live_evidence, false);
  assert.equal(equalsForm.reason, 'unknown_or_hostile_arg');
  assert.equal(liveTargetLoaded(), false);

  const liveAlias = runCli(['prove', '--target', 'live', '--deploy-sha', DEPLOYED_SHA], env);
  assert.equal(liveAlias.ok, false);
  assert.equal(liveAlias.reason, 'target_live_alias_refused');
  assert.equal(liveTargetLoaded(), false);

  const azureAlias = runCli(['prove', '--target', 'azure', '--deploy-sha', DEPLOYED_SHA], env);
  assert.equal(azureAlias.ok, false);
  assert.equal(azureAlias.reason, 'target_live_alias_refused');

  const wolf = runCli(completeSunsetArgs(), { LUNA_DEPLOYMENT: 'wolfhouse' });
  assert.equal(wolf.ok, false);
  assert.equal(wolf.reason, 'production_or_wolfhouse_refused');

  const prod = runCli(completeSunsetArgs(), { DEFAULT_CLIENT_SLUG: 'production' });
  assert.equal(prod.ok, false);
  assert.equal(prod.reason, 'production_or_wolfhouse_refused');

  const proxy = runCli(completeSunsetArgs(), disabledEnv({ HTTPS_PROXY: 'http://127.0.0.1:1' }));
  assert.equal(proxy.ok, false);
  assert.equal(proxy.reason, 'proxy_refused');

  const prefix = runCli([
    'prove', '--target', 'sunset-staging', '--deploy-sha', DEPLOYED_SHA.slice(0, 8),
  ], env);
  assert.equal(prefix.ok, false);
  assert.equal(prefix.reason, 'deploy_sha_not_allowlisted');
  assert.equal(liveTargetLoaded(), false);

  const extraByte = runCli([
    'prove', '--target', 'sunset-staging', '--deploy-sha', `${DEPLOYED_SHA}0`,
  ], env);
  assert.equal(extraByte.ok, false);
  assert.equal(extraByte.reason, 'deploy_sha_not_allowlisted');

  const upper = runCli([
    'prove', '--target', 'sunset-staging', '--deploy-sha', DEPLOYED_SHA.toUpperCase(),
  ], env);
  assert.equal(upper.ok, false);
  assert.equal(upper.reason, 'deploy_sha_not_allowlisted');

  const missingSha = runCli(['prove', '--target', 'sunset-staging'], env);
  assert.equal(missingSha.ok, false);
  assert.equal(missingSha.reason, 'deploy_sha_not_allowlisted');

  const dup = runCli([
    'prove', '--target', 'sunset-staging', '--deploy-sha', DEPLOYED_SHA, '--deploy-sha', DEPLOYED_SHA,
  ], env);
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'duplicate_arg');

  const extraArg = runCli([
    'prove', '--target', 'sunset-staging', '--deploy-sha', DEPLOYED_SHA, '--consumer', 'x',
  ], env);
  assert.equal(extraArg.ok, false);
  assert.equal(extraArg.reason, 'unknown_or_hostile_arg');

  const parsedExecute = parseArgs(completeSunsetArgs(['--execute-once']));
  assert.equal(parsedExecute.invalid, false);
  assert.equal(parsedExecute.executeOnce, true);
  assert.equal(parsedExecute.target, 'sunset-staging');

  const prep = runCli(completeSunsetArgs(), env);
  assert.equal(prep.ok, true);
  assert.equal(prep.simulation, true);
  assert.equal(prep.preparation, true);
  assert.equal(prep.execute_once, false);
  assert.equal(prep.live_evidence, false);
  assert.equal(prep.token_verified, false);
  assert.equal(prep.jwks_live, false);
  assert.equal(prep.microsoft_live, false);
  assert.equal(prep.login_proven, false);
  assert.equal(prep.custody_proven, false);
  assert.equal(prep.graph_called, false);
  assert.equal(prep.send_called, false);
  assert.equal(prep.mutated_098, false);
  assert.equal(prep.target, 'sunset-staging');
  assert.equal(prep.deploy_sha, DEPLOYED_SHA);
  assertSanitized(prep);
  assert.equal(liveTargetLoaded(), false);

  const execNoConfirm = runCli([
    'prove', '--target', 'sunset-staging', '--deploy-sha', DEPLOYED_SHA, '--execute-once',
  ], env);
  assert.equal(execNoConfirm.ok, false);
  assert.equal(execNoConfirm.live_evidence, false);
  assert.equal(['confirmation_required', 'revision_mismatch', 'digest_mismatch', 'operator_nonce_invalid']
    .includes(execNoConfirm.reason), true);
  assert.equal(liveTargetLoaded(), false);

  const execWrongNonce = runCli(completeSunsetArgs(['--execute-once']).map((part, i, arr) => {
    if (arr[i - 1] === '--operator-nonce') return 'not-a-nonce';
    return part;
  }), env);
  assert.equal(execWrongNonce.ok, false);
  assert.equal(execWrongNonce.reason, 'operator_nonce_invalid');
  assert.equal(liveTargetLoaded(), false);

  const execFromSourceTest = runCli(completeSunsetArgs(['--execute-once']), env);
  assert.equal(execFromSourceTest.ok, false);
  assert.equal(execFromSourceTest.reason, 'source_test_cannot_consume_live_attempt');
  assert.equal(execFromSourceTest.live_evidence, false);
  assert.equal(execFromSourceTest.token_verified, false);
  assert.equal(liveTargetLoaded(), false);

  const cacheHits = Object.keys(require.cache).filter((key) => {
    const n = String(key).replace(/\\/g, '/');
    return n.includes('email-grant-envelope-azure-kv-sunset-staging-runtime-composition')
      || n.includes('sunset-microsoft-oauth-provider')
      || n.includes('email-luna-controlled-drafting-principal-connection')
      || n.endsWith(LIVE_TARGET_SUFFIX);
  });
  assert.deepEqual(cacheHits, []);
  assert.equal(path.basename(__filename).includes('near-miss'), true);
  console.log('  PASS  CLI near-misses acquire zero live-target/KV/token/JWKS dependencies');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
