'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4I — production owner for
 * the bounded Sunset staging one-shot live-execution entrypoint.
 *
 * Public surface does not export the closed adapter constructor. Fake
 * adapters are available only from the test-support sibling, which
 * production code does not import and cannot select by env/opts.
 *
 * Chapter 4E/4G/4H `LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER` remains
 * frozen false. Staff API startup and ordinary imports stay inert.
 *
 * @module email-luna-controlled-drafting-sunset-staging-live-execution-owner
 */

const {
  ERROR_CODE,
  ERROR_MESSAGE,
  PROOF_VERSION,
  CONFIRMATION_PHRASE,
  COMMAND,
  INVOCATION_KEYS,
  MACHINE_RECORD_KEYS,
  ENV_ALIAS_KEYS,
  AZURE_OWNER,
  EXPECTED_LIVE_TARGET,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  EXPECTED_DATABASE,
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
  executeOnceSunsetStagingLiveProof,
  parseArgs,
  runCli,
  validateExactInvocation,
  refusedRecord,
  invokedFromSourceTestHarness,
} = require('./email-luna-controlled-drafting-sunset-staging-live-execution-owner-owned');

const objectFreeze = Object.freeze;

if (LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== false) {
  throw new Error('controlled_drafting_live_execute_must_be_disabled_in_this_chapter');
}

module.exports = objectFreeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  PROOF_VERSION,
  CONFIRMATION_PHRASE,
  COMMAND,
  INVOCATION_KEYS,
  MACHINE_RECORD_KEYS,
  ENV_ALIAS_KEYS,
  AZURE_OWNER,
  EXPECTED_LIVE_TARGET,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  EXPECTED_DATABASE,
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
  executeOnceSunsetStagingLiveProof,
  parseArgs,
  runCli,
  validateExactInvocation,
  refusedRecord,
  invokedFromSourceTestHarness,
});
