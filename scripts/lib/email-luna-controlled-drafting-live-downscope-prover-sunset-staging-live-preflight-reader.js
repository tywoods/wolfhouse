'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4H — production owner for
 * the private Sunset staging live preflight reader.
 *
 * Public surface does not export the closed adapter constructor. Fake
 * adapters are available only from the test-support sibling, which production
 * code does not import and cannot select by env/opts.
 *
 * @module email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader
 */

const {
  ERROR_CODE,
  ERROR_MESSAGE,
  EIGHT_FLAGS,
  AZURE_OWNER,
  FENCE_MAX_AGE_MS,
  COUNT_SQL,
  IDENTITY_SQL,
  GRANT_SQL,
  BINDING_SQL,
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
  readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg,
  isIndependentLivePreflight,
} = require('./email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader-owned');

const objectFreeze = Object.freeze;

if (LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== false) {
  throw new Error('controlled_drafting_live_execute_must_be_disabled_in_this_chapter');
}

module.exports = objectFreeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  EIGHT_FLAGS,
  AZURE_OWNER,
  FENCE_MAX_AGE_MS,
  COUNT_SQL,
  IDENTITY_SQL,
  GRANT_SQL,
  BINDING_SQL,
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
  readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg,
  isIndependentLivePreflight,
});
