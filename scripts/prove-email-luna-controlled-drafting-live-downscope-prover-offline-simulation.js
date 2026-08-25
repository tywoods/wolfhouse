'use strict';

/**
 * Offline simulation / fake harness proof for Stage 2 Chapter 4E.
 * Does not open Azure, live PG, or Microsoft. Not a live token proof.
 */

const assert = require('node:assert/strict');
const {
  runCli,
  parseArgs,
  LIVE_DEPLOY_SHA_ALLOWLIST,
} = require('./lib/email-luna-controlled-drafting-live-downscope-prover');

async function main() {
  console.log('FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4E offline simulation');
  console.log('This is not a live Microsoft/JWKS/LOGIN/custody proof.');
  assert.equal(LIVE_DEPLOY_SHA_ALLOWLIST.length, 1);
  assert.equal(LIVE_DEPLOY_SHA_ALLOWLIST[0], 'f6ee511273160cb46c72e345137800878d4c6512');
  const env = { LUNA_DEPLOYMENT: 'sunset-staging', DEFAULT_CLIENT_SLUG: 'sunset' };
  const equalsForm = runCli(['simulate', '--target=fake'], env);
  assert.equal(equalsForm.ok, false);
  assert.equal(equalsForm.reason, 'unknown_or_hostile_arg');
  const parsed = parseArgs(['simulate']);
  const okSim = runCli(['simulate', '--target', 'fake'], env);
  assert.equal(okSim.ok, true);
  assert.equal(okSim.simulation, true);
  assert.equal(okSim.live_evidence, false);
  assert.equal(okSim.token_verified, false);
  assert.equal(okSim.login_proven, false);
  assert.equal(okSim.custody_proven, false);
  const live = runCli(['prove', '--target', 'live', '--deploy-sha', 'a'.repeat(40)], env);
  assert.equal(live.ok, false);
  assert.equal(live.reason, 'target_live_alias_refused');
  const sunsetMissing = runCli(['prove', '--target', 'sunset-staging'], env);
  assert.equal(sunsetMissing.ok, false);
  assert.equal(sunsetMissing.reason, 'deploy_sha_not_allowlisted');
  const proveCli = runCli(['prove', '--target', 'fake', '--confirm', 'I_UNDERSTAND_SUNSET_STAGING_DOWNSCOPE_PROOF'], env);
  assert.equal(proveCli.ok, false);
  assert.equal(proveCli.reason, 'cli_prove_requires_offline_harness');
  assert.equal(parsed.command, 'simulate');
  console.log('  PASS  offline simulation labels itself simulation; live structurally absent');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
