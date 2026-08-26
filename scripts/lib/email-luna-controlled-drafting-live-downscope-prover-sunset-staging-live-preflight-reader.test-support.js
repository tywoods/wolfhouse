'use strict';

/**
 * TEST-ONLY Chapter 4H helpers. Not reachable from Staff API, live-target
 * compose, CLI --execute-once, or the production preflight-reader public
 * surface. Injects local deterministic fake Azure/ACR/PG adapters into the
 * closed owned constructor. Production code does not import this file and
 * cannot select it by env/opts.
 *
 * @module email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader.test-support
 */

const {
  createOwnedSunsetStagingLivePreflightReader,
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
} = require('./email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader-owned');

const objectFreeze = Object.freeze;

if (LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== false) {
  throw new Error('controlled_drafting_live_execute_must_be_disabled_in_this_chapter');
}

function createSunsetStagingLivePreflightReaderForTests(adapters) {
  return createOwnedSunsetStagingLivePreflightReader(adapters);
}

module.exports = objectFreeze({
  createSunsetStagingLivePreflightReaderForTests,
});
