'use strict';

/**
 * radar-slice16ap-finite-closeout — RADAR Slice 16AP locks.
 *
 * Finite milestone closeout (docs/fixtures/verifier only). Freezes score 0/9/0,
 * exact evidence classes for G01–G09, staging-readiness current-stage exit,
 * reopen triggers, and FACTORY handoff gate. Does NOT raise any formal gate to
 * proven, erase gaps, claim production, or authorize endless RADAR slices.
 */

const path = require('path');

const MASTER_BASIS = '66e34a5833ff3bcc7f297108f594b4fc58a0eccc';
const SLICE = 'RADAR-16AP';
const OUTCOME_ID = '16AP_finite_milestone_closeout';
const GATE_IDS = Object.freeze([
  'G01_correlation_structured_logs',
  'G02_readiness_dependencies',
  'G03_actionable_tenant_aware_alerts',
  'G04_webhook_payment_worker_backlog',
  'G05_retry_replay_safety',
  'G06_scaling_capacity',
  'G07_rollback_incident_runbooks',
  'G08_retention_privacy',
  'G09_cost_controls',
]);
const PROGRESS_CLASS = 'finite_milestone_closeout_staging_readiness_only';
const BRANCH = 'radar/slice-16ap-finite-closeout';

const EVIDENCE_REL = 'fixtures/radar-operations/slice16ap-finite-closeout.json';
const CONTRACT_REL = 'fixtures/radar-operations/slice16ap-expected-contract.json';

const FROZEN_SCORE = Object.freeze({
  proven: 0,
  partial: 9,
  absent: 0,
  total: 9,
});

/** Formal gate verdict remains partial for all nine; evidence_class is the freeze. */
const GATE_EVIDENCE_FREEZE = Object.freeze([
  Object.freeze({
    id: 'G01_correlation_structured_logs',
    formal_verdict: 'partial',
    evidence_class: 'staging_live_partial',
    source_proven: [
      '16J_staff_http_correlation_ALS',
      '16R_staff_api_request_completion_schema',
      '16U_correlation_design_freeze',
    ],
    staging_live_partial: [
      '16S_LAW_delivery_search_retention_SHA_1bf9695',
    ],
    production_only_unknowns: [
      'production_correlation_path',
      'production_LAW_retention_search',
    ],
    retained_gaps: [
      'G01-A live Meta→Hermes→Staff correlated read path open',
      'central capability boundary before dry-run',
    ],
    deferred_owner: 'platform-correlation / Hermes ingress',
  }),
  Object.freeze({
    id: 'G02_readiness_dependencies',
    formal_verdict: 'partial',
    evidence_class: 'staging_live_partial',
    source_proven: [
      '16I_readyz_dedicated_pool',
      '16W_closeReadinessPool_lifecycle',
      '16Y_shutdown_completion_log',
    ],
    staging_live_partial: [
      '16X_traffic_shed',
      '16Z_SIGTERM',
      '16AA_SIGINT',
      '16AB_readyz_503',
      '16AC_organic_restart_alerts',
      '16AD_sampled_restart_continuity',
    ],
    production_only_unknowns: [
      'production_readiness_lifecycle',
      'production_zero_downtime',
    ],
    retained_gaps: [
      'absolute/continuous zero downtime not claimed',
      'cold-start availability not claimed',
      'production forbidden',
    ],
    deferred_owner: 'platform-ops / ACA lifecycle',
  }),
  Object.freeze({
    id: 'G03_actionable_tenant_aware_alerts',
    formal_verdict: 'partial',
    evidence_class: 'staging_live_partial',
    source_proven: [
      '16H_staff_api_metric_alert_IaC',
    ],
    staging_live_partial: [
      '16P_AG_test_notification_API',
      '16AC_organic_restart_fire_resolve',
    ],
    production_only_unknowns: [
      'production_alert_routing',
      'production_inbox_receipt',
    ],
    retained_gaps: [
      'human inbox receipt not claimed',
      'unique causality beyond platform fields open',
      'Requests 5xx alert firing not claimed',
    ],
    deferred_owner: 'platform-ops / Azure Monitor',
  }),
  Object.freeze({
    id: 'G04_webhook_payment_worker_backlog',
    formal_verdict: 'partial',
    evidence_class: 'source_partial',
    source_proven: [
      'stripe_meta_webhook_handlers_exist',
      'sunset_hold_expiry_job_declared',
    ],
    staging_live_partial: [],
    production_only_unknowns: [
      'production_backlog_depth',
      'production_DLQ',
    ],
    retained_gaps: [
      'no backlog depth metrics',
      'no DLQ',
      'no lag alert proven',
    ],
    deferred_owner: 'payments / worker-ops',
  }),
  Object.freeze({
    id: 'G05_retry_replay_safety',
    formal_verdict: 'partial',
    evidence_class: 'source_partial',
    source_proven: [
      '16M_stripe_event_id_claim',
    ],
    staging_live_partial: [],
    production_only_unknowns: [
      'production_replay_safety',
      'production_UNIQUE_contention',
    ],
    retained_gaps: [
      'live concurrency proof open',
      'controlled replay drill open',
      'Meta dual-ingress replay safety open',
    ],
    deferred_owner: 'payments / Stripe webhook',
  }),
  Object.freeze({
    id: 'G06_scaling_capacity',
    formal_verdict: 'partial',
    evidence_class: 'staging_live_partial',
    source_proven: [
      '16L_capacity_alert_IaC',
      '16AG_bounded_load_harness',
      '16AH_pinnedLookup_all_true_correction',
      '16AJ_availability_SLO_error_budget_source',
      '16AK_backpressure_admission_source',
      '16AL_backpressure_wire_flag_default_OFF',
      '16AN_ingress_tenant_slug_source',
    ],
    staging_live_partial: [
      '16AF_capacity_alert_deploy',
      '16AI_conservative_readyz_bounded_load',
      '16AM_exact_SHA_16AL_deploy_flag_OFF',
      '16AO_admission_activation_auth_rejection_403',
      '16AN_16AO_failed_identity_canary_rollback_correction',
    ],
    production_only_unknowns: [
      'production_capacity',
      'production_SLO',
      'production_backpressure',
      'production_autoscaling',
    ],
    retained_gaps: [
      'queue_overflow_503_overload_shedding',
      'fairness_under_contention',
      'load_soak_sustained_capacity',
      'autoscaling_rules_null',
      'capacity_SLO_error_budget_live',
      'capacity_alert_fire_notification',
      'backpressure_runtime_live_proven',
      'production_forbidden',
    ],
    deferred_owner: 'platform-capacity / Staff API admission',
    g06_subcontrol_freeze: Object.freeze({
      exact_sha_capacity_deploy: 'live_proven_via_16AM_and_16AO',
      bounded_readiness_load: 'live_proven_via_16AI',
      availability_slo_source: 'source_defined_via_16AJ',
      backpressure_source: 'source_defined_via_16AK',
      backpressure_wire: 'integration_source_proven_via_16AL',
      backpressure_deploy_flag_off: 'live_proven_via_16AM',
      backpressure_activation_auth_rejection: 'live_proven_via_16AO',
      failed_identity_canary_rollback_correction: 'recorded_via_16AN_16AO',
      overload_shed: 'open',
      fairness: 'open',
      soak: 'open',
      autoscale: 'open',
      live_slo: 'open',
      alert_fire: 'open',
      production: 'open',
    }),
  }),
  Object.freeze({
    id: 'G07_rollback_incident_runbooks',
    formal_verdict: 'partial',
    evidence_class: 'staging_live_partial',
    source_proven: [
      'rollback_runbooks_written',
    ],
    staging_live_partial: [
      '16P_ACA_revision_rollback_rollforward',
    ],
    production_only_unknowns: [
      'production_rollback_drill',
      'production_restore',
    ],
    retained_gaps: [
      'Postgres restore drill open',
      'geo-redundant backup disabled staging',
    ],
    deferred_owner: 'platform-ops / incident',
  }),
  Object.freeze({
    id: 'G08_retention_privacy',
    formal_verdict: 'partial',
    evidence_class: 'staging_live_partial',
    source_proven: [
      '16O_stripe_webhook_error_minimization',
      '16K_healthz_minimization',
    ],
    staging_live_partial: [
      '16P_live_webhook_privacy_paths_SHA_594247f',
    ],
    production_only_unknowns: [
      'production_PII_redaction_proof',
      'production_log_retention_policy_proof',
    ],
    retained_gaps: [
      'abrupt paths open',
      'retention/search open',
    ],
    deferred_owner: 'security / privacy',
  }),
  Object.freeze({
    id: 'G09_cost_controls',
    formal_verdict: 'partial',
    evidence_class: 'staging_live_partial',
    source_proven: [
      '16B_staging_RG_cost_budget_thresholds',
    ],
    staging_live_partial: [
      '16P_ops_AG_test_notification_API',
    ],
    production_only_unknowns: [
      'production_budgets',
      'production_cost_anomaly',
    ],
    retained_gaps: [
      'budget resources live-list proof open',
      'cost anomaly detection open',
      'human inbox receipt not claimed',
    ],
    deferred_owner: 'platform-ops / cost',
  }),
]);

const STAGING_READINESS_EXIT = Object.freeze({
  definition:
    'RADAR current-stage is complete only as bounded dual-staging Staff API readiness: retained source contracts + committed staging-live evidence through 16AO, with formal gates remaining partial 0/9/0 and production unknowns retained.',
  current_stage_status: 'complete_under_bounded_staging_readiness_exit',
  formal_gates_status: 'all_nine_remain_partial',
  score_frozen: FROZEN_SCORE,
  does_not_mean: Object.freeze([
    'any_gate_verdict_proven',
    'production_ready',
    'full_G06_proven',
    'gaps_erased',
    'endless_radar_implementation_slices_authorized',
  ]),
});

const REOPEN_TRIGGERS = Object.freeze([
  Object.freeze({
    id: 'production_launch',
    description: 'Any production Staff API / WhatsApp / payment cutover or production RG change.',
  }),
  Object.freeze({
    id: 'third_tenant_factory',
    description: 'Third-tenant FACTORY onboarding beyond Wolfhouse + Sunset staging pair.',
  }),
  Object.freeze({
    id: 'traffic_or_cost_threshold',
    description: 'Sustained traffic or cost crossing locked staging budget/alert thresholds requiring capacity work.',
  }),
  Object.freeze({
    id: 'incident',
    description: 'Sev1/Sev2 staging or production incident exposing an open residual risk.',
  }),
  Object.freeze({
    id: 'security_boundary_change',
    description: 'Ingress, tenant-identity, auth, webhook, or privacy boundary change invalidating frozen evidence.',
  }),
]);

const FACTORY_HANDOFF_GATE = Object.freeze({
  id: '16AP_FACTORY_handoff_gate',
  required: Object.freeze([
    'score_frozen_0_9_0',
    'all_nine_formal_gates_partial',
    'gate_evidence_classes_frozen',
    'residual_risks_and_deferred_owners_listed',
    'reopen_triggers_explicit',
    'no_runtime_iac_live_mutation_by_16AP',
    'successor_RADAR_slice_requires_reopen_trigger',
  ]),
  blocked_without_reopen: Object.freeze([
    'additional_RADAR_implementation_expansion_slices',
    'raising_any_gate_to_proven',
    'claiming_production_ready',
    'erasing_retained_gaps',
  ]),
});

const RESIDUAL_RISKS = Object.freeze([
  Object.freeze({
    id: 'G01A_meta_hermes_staff_correlation',
    risk: 'No live Meta→Hermes→Staff correlated read path.',
    owner: 'platform-correlation / Hermes ingress',
  }),
  Object.freeze({
    id: 'G02_cold_start_and_absolute_zdt',
    risk: 'Cold-start and absolute/continuous zero-downtime unproven.',
    owner: 'platform-ops / ACA lifecycle',
  }),
  Object.freeze({
    id: 'G03_human_inbox',
    risk: 'Human inbox receipt and 5xx alert fire unproven.',
    owner: 'platform-ops / Azure Monitor',
  }),
  Object.freeze({
    id: 'G04_backlog_dlq',
    risk: 'Webhook/payment/worker backlog depth and DLQ absent.',
    owner: 'payments / worker-ops',
  }),
  Object.freeze({
    id: 'G05_live_replay',
    risk: 'Live Stripe/Meta replay safety drills open.',
    owner: 'payments / Stripe webhook',
  }),
  Object.freeze({
    id: 'G06_overload_shed_and_capacity',
    risk: 'Overload shed, fairness, soak, autoscale, live SLO, alert fire unproven; activation≠shed.',
    owner: 'platform-capacity / Staff API admission',
  }),
  Object.freeze({
    id: 'G07_restore_drill',
    risk: 'Postgres restore drill and geo-redundant backup open.',
    owner: 'platform-ops / incident',
  }),
  Object.freeze({
    id: 'G08_retention_search',
    risk: 'Abrupt paths and retention/search privacy proof open.',
    owner: 'security / privacy',
  }),
  Object.freeze({
    id: 'G09_anomaly_and_live_budgets',
    risk: 'Live budget list proof and cost anomaly detection open.',
    owner: 'platform-ops / cost',
  }),
  Object.freeze({
    id: 'production_scope',
    risk: 'All production controls remain intentionally untouched / unknown.',
    owner: 'operator / production launch',
  }),
]);

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'any_gate_verdict_proven',
  'production_ready',
  'production',
  'full_G06_proven',
  'backpressure_proven',
  'overload_shed_proven',
  'load_soak_proven',
  'autoscaling_proven',
  'capacity_SLO_live_proven',
  'alert_fire_notification_proven',
  'gaps_erased',
  'endless_radar_slices_without_reopen',
]);

const MUST_NOT_MUTATE = Object.freeze([
  'database/',
  'docker/hermes-staging/',
  'docker/hermes-sunset/',
  'scripts/staff-query-api.js',
  'scripts/lib/staff-api-admission-boundary.js',
  'scripts/lib/radar-g06-admission-control.js',
  'scripts/lib/staff-api-request-correlation.js',
  'scripts/lib/staff-api-readiness.js',
  'scripts/lib/staff-api-readiness-lifecycle.js',
  'infra/azure/staging/main.bicep',
  'infra/azure/sunset-staging/main.bicep',
  'infra/azure/staging-staff-api-metric-alerts/',
  'infra/azure/staging-cost-budgets/',
]);

const OWNED_RELS = Object.freeze([
  EVIDENCE_REL,
  CONTRACT_REL,
  'scripts/lib/radar-slice16ap-finite-closeout.js',
  'scripts/verify-radar-slice16ap-finite-closeout.js',
  'docs/RADAR-OPERATIONS-GATE-LEDGER.md',
  'fixtures/radar-operations/gate-matrix.json',
  'fixtures/radar-operations/contract.json',
  'fixtures/radar-operations/findings.md',
]);

const REQUIRED_RED = Object.freeze([
  'score_inflation_proven_rejected',
  'score_inflation_partial_drift_rejected',
  'gap_deletion_rejected',
  'formal_gate_proven_rejected',
  'production_ready_claim_rejected',
  'full_g06_claim_rejected',
  'backpressure_proven_claim_rejected',
  'endless_slice_without_reopen_rejected',
  'lock_hash_mismatch_rejected',
  'reopen_trigger_deletion_rejected',
  'factory_handoff_weakening_rejected',
  'g06_open_subcontrol_flip_rejected',
]);

const REQUIRED_GREEN = Object.freeze([
  'score_frozen_0_9_0',
  'all_gates_formal_partial',
  'evidence_classes_match_freeze',
  'staging_readiness_exit_complete_not_proven',
  'g06_subcontrols_honest',
  'reopen_triggers_present',
  'factory_handoff_present',
  'residual_risks_and_owners_present',
  'runtime_paths_unchanged',
  'package_script_registered',
  '16ao_activation_retained',
  'no_doc_overclaim',
]);

module.exports = {
  MASTER_BASIS,
  SLICE,
  OUTCOME_ID,
  GATE_IDS,
  PROGRESS_CLASS,
  BRANCH,
  EVIDENCE_REL,
  CONTRACT_REL,
  FROZEN_SCORE,
  GATE_EVIDENCE_FREEZE,
  STAGING_READINESS_EXIT,
  REOPEN_TRIGGERS,
  FACTORY_HANDOFF_GATE,
  RESIDUAL_RISKS,
  EXPLICITLY_NOT_CLAIMED,
  MUST_NOT_MUTATE,
  OWNED_RELS,
  REQUIRED_RED,
  REQUIRED_GREEN,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
