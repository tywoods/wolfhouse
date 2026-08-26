'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4I — public constants
 * surface. Import-inert. Re-exports parse/validate helpers from the pure
 * proof-core only. Does not export a production adapter constructor, mint,
 * capability, owned factory, or execute-once production seam.
 *
 * Chapter 4E/4G/4H `LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER` remains
 * frozen false. Staff API startup and ordinary imports stay inert.
 *
 * @module email-luna-controlled-drafting-sunset-staging-live-execution-owner
 */

const core = require('./email-luna-controlled-drafting-chapter-4i-proof-core');

const objectFreeze = Object.freeze;

if (core.LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== false) {
  throw new Error('controlled_drafting_live_execute_must_be_disabled_in_this_chapter');
}

module.exports = objectFreeze({
  ERROR_CODE: core.ERROR_CODE,
  ERROR_MESSAGE: core.ERROR_MESSAGE,
  PROOF_VERSION: core.PROOF_VERSION,
  CONFIRMATION_PHRASE: core.CONFIRMATION_PHRASE,
  COMMAND: core.COMMAND,
  PREFLIGHT_COMMAND: core.PREFLIGHT_COMMAND,
  INVOCATION_KEYS: core.INVOCATION_KEYS,
  MACHINE_RECORD_KEYS: core.MACHINE_RECORD_KEYS,
  ENV_ALIAS_KEYS: core.ENV_ALIAS_KEYS,
  SOURCE_TRACKED_FILES: core.SOURCE_TRACKED_FILES,
  AZURE_OWNER: core.AZURE_OWNER,
  EXPECTED_LIVE_TARGET: core.EXPECTED_LIVE_TARGET,
  SUNSET_DEPLOYMENT: core.SUNSET_DEPLOYMENT,
  SUNSET_TENANT: core.SUNSET_TENANT,
  EXPECTED_DATABASE: core.EXPECTED_DATABASE,
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER: core.LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
  parseArgs: core.parseArgs,
  runCli: core.runCli,
  refuseLocalCli: core.refuseLocalCli,
  validateExactInvocation: core.validateExactInvocation,
  validatePreflightInvocation: core.validatePreflightInvocation,
  refusedRecord: core.refusedRecord,
  machineRecord: core.machineRecord,
  assertExecutingSource: core.assertExecutingSource,
});
