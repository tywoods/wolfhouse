'use strict';

/**
 * radar-slice16aa-g02-live-sigint-evidence — RADAR Slice 16AA locks.
 *
 * Evidence-only reconciliation of completed dual-staging live SIGINT lifecycle
 * drill @ master fd333b22. No live mutation. Provenance split:
 *   (A) operator-observed drill transcript contemporaneous facts
 *       (az containerapp exec → kill -INT 1; ClusterExecFailure exit 137
 *        transport/process-termination disconnect only; post-drill /readyz=200)
 *   (B) independently recoverable Azure/ACR/LAW read-only facts
 *
 * LAW cardinality is locked to exactly one allowlisted SIGINT completion in each
 * declared bounded inclusive drill query window — not revision-lifetime
 * exactly-one (both tenants have other revision-lifetime records disclosed).
 *
 * Claim ownership (exit 137 vs LAW):
 *   - ClusterExecFailure exit 137 is ONLY az containerapp exec
 *     transport/process-termination disconnect evidence.
 *   - Exit 137 is not an application failure and is not proof of application or
 *     Node process exact native exit status, shell code, signal encoding, or
 *     ACA restart reason.
 *   - The independent LAW allowlisted record — not 137 — is evidence the
 *     lifecycle received original_signal SIGINT and completed pool/server cleanup.
 *
 * Proves: live SIGINT cleanup telemetry in drill windows (via LAW) + post-drill
 * recovery + exit-137 transport disconnect observation.
 * Does not prove: serving /readyz=503, zero-downtime during restart,
 * concurrent restart continuity, organic alerts, production, full G02,
 * unqualified revision-lifetime exactly-one LAW cardinality, or any native
 * exit/signal/ACA-restart semantics from exit 137.
 */

const path = require('path');

const MASTER_BASIS = 'fd333b22c984bad1abe387da456b6fbf87396c13';
const SLICE = 'RADAR-16AA';
const OUTCOME_ID = '16AA_g02_live_sigint_lifecycle_evidence';
const GATE_ID = 'G02_readiness_dependencies';
const PROGRESS_CLASS = 'partial_live_proven_evidence_only';
const BRANCH = 'radar/slice-16aa-g02-live-sigint-evidence';

const EVIDENCE_REL = 'fixtures/radar-operations/slice16aa-g02-live-sigint-evidence.json';
const CONTRACT_REL = 'fixtures/radar-operations/slice16aa-expected-contract.json';

/** Deployed image SHA (independently verified; tip master is fd333b22 evidence basis). */
const IMAGE_SHA_FULL = '95dc3634ac6aaa6de495d22f5f5d8cd0a955df97';
const IMAGE_SHA_SHORT = '95dc363';

const WH_APP = 'wh-staging-staff-api';
const WH_RG = 'wh-staging-rg';
const WH_IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_SHA_FULL}`;
const WH_DIGEST = 'sha256:a9677f75a7d17be9b6ae75b60bc026d462df971cc164496344c29b8c57aee6de';
const WH_REVISION = 'wh-staging-staff-api--0000519';
const WH_REVISION_SUFFIX = '0000519';
const WH_REPLICA = 'wh-staging-staff-api--0000519-7f6f87fbcc-fbqwq';
const WH_PUBLIC_HOST = 'staff-staging.lunafrontdesk.com';

const SUNSET_APP = 'luna-sunset-staging-staff-api';
const SUNSET_RG = 'luna-sunset-staging-rg';
const SUNSET_IMAGE = `whstagingacr.azurecr.io/luna-sunset-staff-api:${IMAGE_SHA_FULL}`;
const SUNSET_DIGEST = 'sha256:8a0b1647ba246bb548d437fcc37e3e4f600181ca1d04dc1eb73e3f4a69d51c10';
const SUNSET_REVISION = 'luna-sunset-staging-staff-api--0000279';
const SUNSET_REVISION_SUFFIX = '0000279';
const SUNSET_REPLICA = 'luna-sunset-staging-staff-api--0000279-dbb57db7-zzx8n';
const SUNSET_PUBLIC_HOST = 'sunset-staging.lunafrontdesk.com';

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';

const LOG_TABLE = 'ContainerAppConsoleLogs_CL';
const EVENT_NAME = 'staff_api_readiness_shutdown_completion';

const WH_LAW = Object.freeze({
  customer_id: '43ae26dd-4a82-4a91-b744-5e1f94a2ae8f',
  workspace_name: 'wh-staging-logs',
  retention_days: 30,
});

const SUNSET_LAW = Object.freeze({
  customer_id: '552489bf-8e57-48df-8413-6e775caaa7d0',
  workspace_name: 'luna-sunset-staging-logs',
  retention_days: 30,
});

const COMPLETION_RECORD = Object.freeze({
  event: EVENT_NAME,
  original_signal: 'SIGINT',
  pool_close_result: 'ok',
  server_close_result: 'ok',
  failure_classes: Object.freeze([]),
  completion: true,
});

const SIGTERM_COMPLETION_RECORD = Object.freeze({
  event: EVENT_NAME,
  original_signal: 'SIGTERM',
  pool_close_result: 'ok',
  server_close_result: 'ok',
  failure_classes: Object.freeze([]),
  completion: true,
});

const ALLOWED_RECORD_KEYS = Object.freeze([
  'event',
  'original_signal',
  'pool_close_result',
  'server_close_result',
  'failure_classes',
  'completion',
]);

const WH_LAW_TIME = '2026-07-21T12:08:28.6734879Z';
const SUNSET_LAW_TIME = '2026-07-21T12:09:25.9915987Z';

const EXEC_METHOD = 'az_containerapp_exec';
const EXEC_COMMAND = 'kill -INT 1';
const EXEC_COMMAND_ARGV = Object.freeze(['kill', '-INT', '1']);
const EXEC_DISCONNECT_CLASS =
  'cluster_exec_failure_exit_137_expected_after_process_termination';
const EXEC_EXIT_CODE = 137;
const EXEC_DISCONNECT_SEMANTICS =
  'az_containerapp_exec_transport_process_termination_disconnect_only';
const EXEC_DISCONNECT_PROVES =
  'az_containerapp_exec_transport_process_termination_disconnect';
const EXEC_DISCONNECT_DOES_NOT_PROVE = Object.freeze([
  'application_failure',
  'application_or_node_process_exact_native_exit_status',
  'shell_exit_code',
  'signal_encoding',
  'aca_restart_reason',
]);
const EXEC_DISCONNECT_NOTE =
  'ClusterExecFailure exit 137 is only az containerapp exec transport/process-termination '
  + 'disconnect evidence; it is not an application failure and not proof of the application '
  + 'or Node process exact native exit status, shell code, signal encoding, or ACA restart reason. '
  + 'Independent LAW allowlisted record — not 137 — evidences original_signal SIGINT and '
  + 'pool/server cleanup completion.';

/** (A) transcript-derived contemporaneous observation. */
const SOURCE_TYPE_A = 'operator_drill_transcript_contemporaneous_observation';
const SOURCE_REF_A = 'operator_g02_live_sigint_lifecycle_command_transcript_2026-07-21';
const OBSERVED_AT_SEMANTICS_A =
  'contemporaneous_operator_exec_kill_int_and_post_drill_readyz_not_azure_reconstructible';

/** (B) independently recoverable Azure/ACR/LAW read-only / public current. */
const SOURCE_TYPE_B = 'azure_acr_law_readonly_independently_reverified';
const SOURCE_REF_B =
  'az_containerapp_acr_law_query_public_curl_readonly_2026-07-21T12:10:51Z';
const OBSERVED_AT_SEMANTICS_B = 'independently_reverified_at_recorded_utc';

const INDEPENDENT_VERIFY_UTC = '2026-07-21T12:10:51Z';

/** LAW cardinality reverify (bounded drill windows + other-record disclosure). */
const LAW_CARDINALITY_REVERIFY_UTC = '2026-07-21T12:11:18Z';
const SOURCE_REF_LAW_CARDINALITY =
  'az_monitor_log_analytics_query_readonly_bounded_drill_windows_2026-07-21T12:11:18Z';

const CARDINALITY_SEMANTICS =
  'exactly_one_in_declared_bounded_drill_query_window_not_revision_lifetime';

const WH_LAW_QUERY_WINDOW = Object.freeze({
  start_utc: '2026-07-21T12:08:00Z',
  end_utc: '2026-07-21T12:09:00Z',
  start_inclusive: true,
  end_inclusive: true,
  semantics: 'bounded_inclusive_drill_query_window_adjacent_endpoints_allowed',
  derivation:
    'WH drill LAW query window = 2026-07-21T12:08:00Z through 2026-07-21T12:09:00Z (inclusive); '
    + 'abuts Sunset window at 12:09:00Z endpoint (interiors non-overlapping); '
    + 'cardinality claim is exactly one target-revision allowlisted SIGINT completion in this window only',
});

const SUNSET_LAW_QUERY_WINDOW = Object.freeze({
  start_utc: '2026-07-21T12:09:00Z',
  end_utc: '2026-07-21T12:10:00Z',
  start_inclusive: true,
  end_inclusive: true,
  semantics: 'bounded_inclusive_drill_query_window_adjacent_endpoints_allowed',
  derivation:
    'Sunset drill LAW query window = 2026-07-21T12:09:00Z through 2026-07-21T12:10:00Z (inclusive); '
    + 'abuts WH window at 12:09:00Z endpoint (interiors non-overlapping); '
    + 'cardinality claim is exactly one target-revision allowlisted SIGINT completion in this window only',
});

/** Other revision-lifetime records disclosed at review (not 16AA drill completions). */
const WH_OTHER_LAW_RECORDS_AT_REVIEW = Object.freeze([
  Object.freeze({
    TimeGenerated: '2026-07-21T11:16:20.3631884Z',
    class: 'revision_lifetime_record_not_16aa_drill_completion',
    revision: WH_REVISION,
    record: Object.freeze({ ...SIGTERM_COMPLETION_RECORD, failure_classes: Object.freeze([]) }),
  }),
  Object.freeze({
    TimeGenerated: '2026-07-21T11:24:48.5525367Z',
    class: 'revision_lifetime_record_not_16aa_drill_completion',
    revision: WH_REVISION,
    record: Object.freeze({ ...SIGTERM_COMPLETION_RECORD, failure_classes: Object.freeze([]) }),
  }),
  Object.freeze({
    TimeGenerated: '2026-07-21T11:47:54.2072273Z',
    class: 'revision_lifetime_record_not_16aa_drill_completion',
    revision: WH_REVISION,
    record: Object.freeze({ ...SIGTERM_COMPLETION_RECORD, failure_classes: Object.freeze([]) }),
  }),
  Object.freeze({
    TimeGenerated: '2026-07-21T12:00:48.8352797Z',
    class: 'revision_lifetime_record_not_16aa_drill_completion',
    revision: WH_REVISION,
    record: Object.freeze({ ...SIGTERM_COMPLETION_RECORD, failure_classes: Object.freeze([]) }),
  }),
]);

const SUNSET_OTHER_LAW_RECORDS_AT_REVIEW = Object.freeze([
  Object.freeze({
    TimeGenerated: '2026-07-21T11:18:04.1610218Z',
    class: 'revision_lifetime_record_not_16aa_drill_completion',
    revision: SUNSET_REVISION,
    record: Object.freeze({ ...SIGTERM_COMPLETION_RECORD, failure_classes: Object.freeze([]) }),
  }),
]);

const WH_REVISION_LIFETIME_COUNT_AT_REVIEW = 5; // 4 other + 1 drill; not a frozen invariant
const SUNSET_REVISION_LIFETIME_COUNT_AT_REVIEW = 2; // 1 other + 1 drill; not a frozen invariant

const PROVENANCE_LIMITATIONS =
  'Class A operator az containerapp exec kill -INT 1 command, exact replica targets, '
  + 'ClusterExecFailure exit 137 (az containerapp exec transport/process-termination disconnect only), '
  + 'and post-drill public /readyz=200 are operator-observed contemporaneous transcript facts. '
  + 'Class B digests/revisions/replicas/probes/public-current are independently reverified '
  + 'Azure/ACR/public read-only facts at independent_azure_verify_utc; LAW drill-window cardinality + '
  + 'other revision-lifetime record disclosure are independently reverified at '
  + 'law_cardinality_reverify_utc via bounded inclusive query windows (adjacent endpoints allowed). '
  + 'Unqualified revision-lifetime exactly-one is false (both tenants have other records; counts may grow). '
  + 'ClusterExecFailure exit 137 is only az containerapp exec transport/process-termination disconnect '
  + 'evidence; it is not an application failure and not proof of the application or Node process exact '
  + 'native exit status, shell code, signal encoding, or ACA restart reason. The independent LAW '
  + 'allowlisted record — not 137 — is evidence the lifecycle received original_signal SIGINT and '
  + 'completed pool/server cleanup. Do not treat A as Azure-reconstructible, and do not treat current '
  + 'public probes as authority to rewrite A historical facts or claim concurrent restart continuity / '
  + 'zero-downtime-during-restart.';

const NON_RECOVERABILITY =
  'Azure/ACR/LAW read-only APIs cannot recreate or replay the historical operator exec command, '
  + 'replica targeting, ClusterExecFailure exit 137 transport/process-termination disconnect observation, '
  + 'or post-drill /readyz sample; those values exist only in the operator drill command transcript. '
  + 'Current public probes and LAW queries verify present state / stored completion rows only. '
  + 'Exit 137 cannot be reconstructed into application/Node native exit status, shell code, signal '
  + 'encoding, or ACA restart reason. LAW cardinality claims require declared bounded query windows; '
  + 'revision-lifetime counts are not frozen and must not be claimed as cardinality.';

/** Exact claim ownership: what exit 137 owns vs what LAW owns. */
const CLAIM_OWNERSHIP = Object.freeze({
  exit_137_cluster_exec_failure: Object.freeze({
    owner_class: 'A_operator_observed_drill_transcript',
    observation: 'ClusterExecFailure_exit_137',
    proves: EXEC_DISCONNECT_PROVES,
    semantics: EXEC_DISCONNECT_SEMANTICS,
    does_not_prove: EXEC_DISCONNECT_DOES_NOT_PROVE,
    limitation:
      'ClusterExecFailure exit 137 is only az containerapp exec transport/process-termination '
      + 'disconnect evidence; not application failure; not proof of application or Node process '
      + 'exact native exit status, shell code, signal encoding, or ACA restart reason',
  }),
  law_allowlisted_sigint_completion: Object.freeze({
    owner_class: 'B_independently_recoverable_azure_readonly',
    observation: 'allowlisted_staff_api_readiness_shutdown_completion',
    proves: Object.freeze([
      'lifecycle_received_original_signal_SIGINT',
      'pool_close_result_ok',
      'server_close_result_ok',
      'failure_classes_empty',
      'completion_true',
      'exactly_one_in_declared_bounded_drill_query_window',
    ]),
    does_not_derive_from: 'exit_137',
    limitation:
      'Independent LAW allowlisted record — not ClusterExecFailure exit 137 — is evidence the '
      + 'lifecycle received original_signal SIGINT and completed pool/server cleanup',
  }),
});

const WH_TIMELINE_B = Object.freeze({
  acr_tag_created_utc: '2026-07-21T11:11:54.3612271Z',
  revision_created_utc: '2026-07-21T11:12:46+00:00',
});

const SUNSET_TIMELINE_B = Object.freeze({
  acr_tag_created_utc: '2026-07-21T11:12:04.3397072Z',
  revision_created_utc: '2026-07-21T11:13:51+00:00',
});

const PROBE_SUMMARY = Object.freeze([
  { type: 'Liveness', path: '/healthz', port: 3036 },
  { type: 'Readiness', path: '/readyz', port: 3036 },
  { type: 'Startup', path: '/healthz', port: 3036 },
]);

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'serving_revision_readyz_503_body_path',
  'zero_downtime_during_restart',
  'concurrent_restart_continuity',
  'organic_metric_alert_firing',
  'human_inbox_receipt',
  'production',
  'full_G02_proven',
  'any_gate_verdict_proven',
  'revision_lifetime_exactly_one_sigint_completion',
  'unbounded_law_cardinality_exactly_one',
  'exit_137_as_application_failure',
  'exit_137_proves_application_native_exit_status',
  'exit_137_proves_node_process_exit_status',
  'exit_137_proves_shell_exit_code',
  'exit_137_proves_signal_encoding',
  'exit_137_proves_aca_restart_reason',
]);

const CLAIMS_ALLOWED = Object.freeze([
  'exact_sha_95dc363_images_digests_both_tenants',
  'revisions_wh_0000519_sunset_0000279_healthy_serving',
  'exact_replicas_wh_fbqwq_sunset_zzx8n',
  'operator_az_exec_kill_int_1_both_tenants_with_exit_137_transport_disconnect',
  'law_exactly_one_sigint_completion_each_tenant_in_declared_drill_query_window',
  'allowlisted_completion_json_sigint_pool_ok_server_ok_failures_empty_completion_true',
  'law_not_exit_137_owns_sigint_pool_server_cleanup_evidence',
  'post_drill_public_readyz_200_both_tenants',
  'public_current_healthz_readyz_200_both_tenants',
  'no_production_scope',
  'other_revision_lifetime_records_disclosed_not_drill_completions',
  'exit_137_az_exec_transport_disconnect_only_not_app_exit_or_aca_reason',
]);

const OWNED_RELS = Object.freeze([
  EVIDENCE_REL,
  CONTRACT_REL,
  'scripts/lib/radar-slice16aa-g02-live-sigint-evidence.js',
  'scripts/verify-radar-slice16aa-g02-live-sigint-evidence.js',
  'docs/RADAR-OPERATIONS-GATE-LEDGER.md',
  'fixtures/radar-operations/gate-matrix.json',
  'fixtures/radar-operations/contract.json',
  'fixtures/radar-operations/findings.md',
]);

const MUST_NOT_MUTATE = Object.freeze([
  'database/',
  'docker/hermes-staging/',
  'scripts/staff-query-api.js',
  'scripts/lib/staff-api-readiness.js',
  'scripts/lib/staff-api-readiness-lifecycle.js',
  'scripts/lib/staff-api-readiness-shutdown-completion-log.js',
  'infra/azure/staging/main.bicep',
  'infra/azure/sunset-staging/main.bicep',
  'infra/azure/staging-staff-api-metric-alerts/',
  'infra/azure/staging-cost-budgets/',
]);

function mergeLiveProbeWithoutRewritingHistorical(evidence, liveProbeResult) {
  const out = JSON.parse(JSON.stringify(evidence));
  const b = out.observed_facts
    && out.observed_facts.B_independently_recoverable_azure_readonly;
  if (b && liveProbeResult && typeof liveProbeResult === 'object') {
    b.live_probe_attempt = {
      attempted_at_utc: liveProbeResult.attempted_at_utc || null,
      result: liveProbeResult.result || 'unknown',
      note: 'Live probe result must not rewrite class-A historical transcript facts',
    };
  }
  return out;
}

function historicalSamplesRewrittenByLiveProbe(before, after) {
  const aBefore = before.observed_facts
    && before.observed_facts.A_operator_observed_drill_transcript;
  const aAfter = after.observed_facts
    && after.observed_facts.A_operator_observed_drill_transcript;
  if (!aBefore || !aAfter) return true;
  return JSON.stringify(aBefore) !== JSON.stringify(aAfter);
}

module.exports = {
  MASTER_BASIS,
  SLICE,
  OUTCOME_ID,
  GATE_ID,
  PROGRESS_CLASS,
  BRANCH,
  EVIDENCE_REL,
  CONTRACT_REL,
  IMAGE_SHA_FULL,
  IMAGE_SHA_SHORT,
  WH_APP,
  WH_RG,
  WH_IMAGE,
  WH_DIGEST,
  WH_REVISION,
  WH_REVISION_SUFFIX,
  WH_REPLICA,
  WH_PUBLIC_HOST,
  SUNSET_APP,
  SUNSET_RG,
  SUNSET_IMAGE,
  SUNSET_DIGEST,
  SUNSET_REVISION,
  SUNSET_REVISION_SUFFIX,
  SUNSET_REPLICA,
  SUNSET_PUBLIC_HOST,
  SUBSCRIPTION_ID,
  LOG_TABLE,
  EVENT_NAME,
  WH_LAW,
  SUNSET_LAW,
  COMPLETION_RECORD,
  SIGTERM_COMPLETION_RECORD,
  ALLOWED_RECORD_KEYS,
  WH_LAW_TIME,
  SUNSET_LAW_TIME,
  EXEC_METHOD,
  EXEC_COMMAND,
  EXEC_COMMAND_ARGV,
  EXEC_DISCONNECT_CLASS,
  EXEC_EXIT_CODE,
  EXEC_DISCONNECT_SEMANTICS,
  EXEC_DISCONNECT_PROVES,
  EXEC_DISCONNECT_DOES_NOT_PROVE,
  EXEC_DISCONNECT_NOTE,
  CLAIM_OWNERSHIP,
  SOURCE_TYPE_A,
  SOURCE_REF_A,
  OBSERVED_AT_SEMANTICS_A,
  SOURCE_TYPE_B,
  SOURCE_REF_B,
  OBSERVED_AT_SEMANTICS_B,
  INDEPENDENT_VERIFY_UTC,
  LAW_CARDINALITY_REVERIFY_UTC,
  SOURCE_REF_LAW_CARDINALITY,
  CARDINALITY_SEMANTICS,
  WH_LAW_QUERY_WINDOW,
  SUNSET_LAW_QUERY_WINDOW,
  WH_OTHER_LAW_RECORDS_AT_REVIEW,
  SUNSET_OTHER_LAW_RECORDS_AT_REVIEW,
  WH_REVISION_LIFETIME_COUNT_AT_REVIEW,
  SUNSET_REVISION_LIFETIME_COUNT_AT_REVIEW,
  PROVENANCE_LIMITATIONS,
  NON_RECOVERABILITY,
  WH_TIMELINE_B,
  SUNSET_TIMELINE_B,
  PROBE_SUMMARY,
  EXPLICITLY_NOT_CLAIMED,
  CLAIMS_ALLOWED,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  mergeLiveProbeWithoutRewritingHistorical,
  historicalSamplesRewrittenByLiveProbe,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
