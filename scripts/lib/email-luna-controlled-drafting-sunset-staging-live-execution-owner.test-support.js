'use strict';

/**
 * TEST-ONLY Chapter 4I helpers. Not reachable from Staff API, live-target
 * compose, 4E CLI --execute-once, or the production execution-owner public
 * surface. Injects local deterministic fake 4H-reader / KV / token / JWKS /
 * PG adapters into the closed owned constructor. Production code does not
 * import this file and cannot select it by env/opts.
 *
 * @module email-luna-controlled-drafting-sunset-staging-live-execution-owner.test-support
 */

const {
  createOwnedSunsetStagingLiveExecutionOwner,
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
} = require('./email-luna-controlled-drafting-sunset-staging-live-execution-owner-owned');

const objectFreeze = Object.freeze;

if (LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== false) {
  throw new Error('controlled_drafting_live_execute_must_be_disabled_in_this_chapter');
}

function createSunsetStagingLiveExecutionOwnerForTests(adapters) {
  return createOwnedSunsetStagingLiveExecutionOwner(adapters);
}

module.exports = objectFreeze({
  createSunsetStagingLiveExecutionOwnerForTests,
});
