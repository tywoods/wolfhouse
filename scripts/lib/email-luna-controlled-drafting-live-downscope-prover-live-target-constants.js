'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4G/4J — singleton live-target
 * pins shared by the operator prover and the Sunset live-target wiring.
 *
 * Import-inert. No Azure/KV/PG/Microsoft. Not an independent image
 * measurement: these are repository-owned exact pins plus source-tree
 * compatibility metadata. Chapter 4J retargets them to the currently
 * serving disabled Sunset artifact. The owned reader must compare the
 * actual immutable deployed image/revision/digest against this contract.
 *
 * @module email-luna-controlled-drafting-live-downscope-prover-live-target-constants
 */

const objectFreeze = Object.freeze;

const LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER = false;

const SUNSET_DEPLOYMENT = 'sunset-staging';
const SUNSET_TENANT = 'sunset';
const SUNSET_LOCATION_KEY = 'sunset-somo';
const EXPECTED_DATABASE = 'sunset_staging';

const EXPECTED_LIVE_TARGET = objectFreeze({
  resourceGroup: 'luna-sunset-staging-rg',
  appName: 'luna-sunset-staging-staff-api',
  revision: 'luna-sunset-staging-staff-api--0000682',
  deployedSha: 'a4188eea71a92b7361818e024cde0f810d6ee018',
  digest: 'sha256:820f302e8f59cfe8636eb0267c6f15bc0750f300b76735f511f3dde9c031dc39',
  tenant: SUNSET_TENANT,
  locationKey: SUNSET_LOCATION_KEY,
  database: EXPECTED_DATABASE,
  replica: 1,
});

const OPERATOR_PROVER_COMPATIBILITY_RULE = objectFreeze({
  rule_id: 'chapter_4g_operator_cli_may_differ_from_deployed_app_sha',
  deployedSha: EXPECTED_LIVE_TARGET.deployedSha,
  chapter4ePr: 719,
  allowsOperatorCliSourceShaToDiffer: true,
  requiresCanonicalRuntimeOwnerByteMatch: true,
  doesNotTrustCallerText: true,
  liveTargetIsDeployedStaffApiImage: true,
  sourceTreeSelfAttestation: true,
  independentImageMeasurement: false,
  cannotEstablishDeployedImageTruth: true,
  futureReaderMustCompareImmutableDeployedImageRevisionDigest: true,
});

const LIVE_CUSTODY_DSN_ENV_KEY = 'EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_DATABASE_URL';
const LIVE_CUSTODY_REFUSES_ADMIN_DSN_ENV_KEY = 'WOLFHOUSE_DATABASE_URL';

if (LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== false) {
  throw new Error('controlled_drafting_live_execute_must_be_disabled_in_this_chapter');
}

module.exports = objectFreeze({
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  SUNSET_LOCATION_KEY,
  EXPECTED_DATABASE,
  EXPECTED_LIVE_TARGET,
  OPERATOR_PROVER_COMPATIBILITY_RULE,
  LIVE_CUSTODY_DSN_ENV_KEY,
  LIVE_CUSTODY_REFUSES_ADMIN_DSN_ENV_KEY,
});
