'use strict';

/**
 * radar-slice16af-g06-capacity-alert-live-evidence — RADAR Slice 16AF locks.
 *
 * Evidence-only reconciliation of live dual-staging Staff API capacity-pressure
 * metric alerts + current scale truth @ master 0a2fb084. No live mutation.
 * Azure read-only only.
 *
 * Proves: four capacity alerts deployed Enabled Sev2 Average>80 PT5M/PT15M on
 * exact Staff API app scopes wired to tenant ops AGs; WH min0/max1/rules null;
 * Sunset min1/max1/rules null; latest=latestReady g02503r. Closes only the G06
 * alert-deployment gap. Does not prove firing/notification, load/soak,
 * autoscaling, SLO/error budget, backpressure, production, or full G06.
 */

const path = require('path');

const MASTER_BASIS = '0a2fb08486b835dd45a4fc904e3dd152702bea6f';
const SLICE = 'RADAR-16AF';
const OUTCOME_ID = '16AF_g06_capacity_alert_live_evidence';
const GATE_ID = 'G06_scaling_capacity';
const GATE_IDS = Object.freeze([GATE_ID]);
const PROGRESS_CLASS = 'partial_live_proven_evidence_only';
const BRANCH = 'radar/slice-16af-g06-capacity-alert-live-evidence';

const EVIDENCE_REL = 'fixtures/radar-operations/slice16af-g06-capacity-alert-live-evidence.json';
const CONTRACT_REL = 'fixtures/radar-operations/slice16af-expected-contract.json';

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';

const WH_RG = 'wh-staging-rg';
const WH_APP = 'wh-staging-staff-api';
const WH_CPU_RULE = 'wolfhouse-staff-api-cpu-pressure';
const WH_MEM_RULE = 'wolfhouse-staff-api-memory-pressure';
const WH_AG_NAME = 'wh-staging-ops-budget-ag';
const WH_AG_ID =
  `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${WH_RG}/providers/Microsoft.Insights/actionGroups/${WH_AG_NAME}`;
const WH_APP_SCOPE =
  `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${WH_RG}/providers/Microsoft.App/containerApps/${WH_APP}`;
const WH_REVISION = 'wh-staging-staff-api--g02503r';
const WH_MIN = 0;
const WH_MAX = 1;

const SUNSET_RG = 'luna-sunset-staging-rg';
const SUNSET_APP = 'luna-sunset-staging-staff-api';
const SUNSET_CPU_RULE = 'sunset-staff-api-cpu-pressure';
const SUNSET_MEM_RULE = 'sunset-staff-api-memory-pressure';
const SUNSET_AG_NAME = 'luna-sunset-staging-ops-budget-ag';
const SUNSET_AG_ID =
  `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${SUNSET_RG}/providers/Microsoft.Insights/actionGroups/${SUNSET_AG_NAME}`;
const SUNSET_APP_SCOPE =
  `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${SUNSET_RG}/providers/Microsoft.App/containerApps/${SUNSET_APP}`;
const SUNSET_REVISION = 'luna-sunset-staging-staff-api--g02503r';
const SUNSET_MIN = 1;
const SUNSET_MAX = 1;

const METRIC_NAMESPACE = 'Microsoft.App/containerApps';
const TIME_AGGREGATION = 'Average';
const OPERATOR = 'GreaterThan';
const THRESHOLD = 80;
const EVALUATION_FREQUENCY = 'PT5M';
const WINDOW_SIZE = 'PT15M';
const RULE_ENABLED = true;
const RULE_SEVERITY_INT = 2;
const SEVERITY_LABEL = 'Sev2';
const CRITERION_TYPE = 'StaticThresholdCriterion';
const AG_ENABLED = true;
const RECEIVER_NAME = 'ops-email';
const RECEIVER_STATUS = 'Enabled';
const SCALE_RULES = null;
const ACTIVE_MODE = 'Single';

const SOURCE_TYPE =
  'azure_monitor_metric_alert_action_group_containerapp_scale_readonly_independently_reverified';
const INDEPENDENT_VERIFY_UTC = '2026-07-21T14:30:07Z';
const SOURCE_REF =
  `az_monitor_metric_alert_ag_containerapp_scale_readonly_${INDEPENDENT_VERIFY_UTC}`;
const OBSERVED_AT_SEMANTICS = 'independently_reverified_at_recorded_utc';

const PROVENANCE_LIMITATIONS =
  'Independently recovered Azure Monitor metric-alert rule definitions, action-group '
  + 'enabled/receiver-name/status fields, and Container App scale/revision/traffic fields '
  + `via read-only Azure calls at ${INDEPENDENT_VERIFY_UTC}. Proves the four capacity-pressure alerts are `
  + 'deployed Enabled Sev2 Average>80 PT5M/PT15M on exact Staff API app scopes wired to tenant '
  + 'ops action groups, and records current scale truth (WH minReplicas=0 maxReplicas=1 rules=null; '
  + 'Sunset minReplicas=1 maxReplicas=1 rules=null; latest=latestReady g02503r both tenants). '
  + 'Does not prove alert firing, notification/inbox delivery, load/soak, autoscaling, SLO/error '
  + 'budget, backpressure, production, or full G06. Receiver email addresses intentionally not recorded.';

const NON_RECOVERABILITY =
  'Azure read-only APIs cannot prove alert firing, notification delivery, human inbox receipt, '
  + 'load/soak behavior, autoscaling actuation, SLO/error-budget consumption, or backpressure. '
  + 'Do not invent fired instances, email addresses, scale-rule mutations, or raising G06 to proven.';

const CLAIM_OWNERSHIP = Object.freeze({
  deployed_capacity_pressure_alerts: Object.freeze({
    owner_class: 'azure_monitor_readonly_independently_reverified',
    observation: 'four_capacity_alerts_enabled_sev2_average_gt_80_pt5m_pt15m_exact_scopes_ags',
    proves: [
      'capacity_alerts_deployed_enabled_both_tenants_cpu_and_memory',
      'exact_metric_CpuPercentage_MemoryPercentage',
      'Average_GreaterThan_80_Sev2_PT5M_eval_PT15M_window',
      'exact_app_scopes_and_tenant_ops_action_group_ids',
      'action_groups_enabled_ops_email_receiver_Enabled',
    ],
    does_not_prove: [
      'capacity_alert_firing',
      'notification_delivery',
      'human_inbox_receipt',
      'load_soak_proof',
      'autoscaling',
      'capacity_slo_error_budget',
      'backpressure',
      'production',
      'full_G06_proven',
    ],
    limitation:
      'Deployed enabled rule definitions + AG receiver name/status only; fire/notification remain open',
  }),
  current_scale_truth: Object.freeze({
    owner_class: 'azure_containerapp_readonly_independently_reverified',
    observation: 'wh_min0_max1_rules_null_sunset_min1_max1_rules_null_latest_equals_latestReady_g02503r',
    proves: [
      'wolfhouse_minReplicas_0_maxReplicas_1_rules_null',
      'sunset_minReplicas_1_maxReplicas_1_rules_null',
      'latest_equals_latestReady_g02503r_both_tenants',
      'active_revisions_mode_Single_traffic_100',
    ],
    does_not_prove: [
      'autoscaling_rules_present',
      'scale_mutation_by_this_slice',
      'load_driven_scale_out',
      'production',
    ],
    limitation: 'Current scale bounds/rules/revision identity only; no autoscaling or load proof',
  }),
});

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'capacity_alert_firing',
  'notification_delivery',
  'human_inbox_receipt',
  'receiver_email_address_disclosure',
  'load_soak_proof',
  'autoscaling',
  'capacity_slo_error_budget',
  'backpressure',
  'production',
  'full_G06_proven',
  'any_gate_verdict_proven',
  'scale_mutation_by_this_slice',
  'min_max_replica_mutation',
]);

const CLAIMS_ALLOWED = Object.freeze([
  'four_capacity_alerts_deployed_enabled_sev2_average_gt_80',
  'exact_cpu_memory_per_tenant_pt5m_pt15m',
  'exact_app_scopes_and_tenant_ops_ags',
  'action_groups_enabled_ops_email_Enabled_no_address',
  'wh_scale_min0_max1_rules_null',
  'sunset_scale_min1_max1_rules_null',
  'latest_equals_latestReady_g02503r_both',
  'g06_alert_deployment_gap_closed_g06_remains_partial',
  'no_fire_notification_load_autoscale_slo_backpressure_claim',
  'no_production_scope',
  'no_live_mutation_this_slice',
]);

const OWNED_RELS = Object.freeze([
  EVIDENCE_REL,
  CONTRACT_REL,
  'scripts/lib/radar-slice16af-g06-capacity-alert-live-evidence.js',
  'scripts/verify-radar-slice16af-g06-capacity-alert-live-evidence.js',
  'docs/RADAR-OPERATIONS-GATE-LEDGER.md',
  'fixtures/radar-operations/gate-matrix.json',
  'fixtures/radar-operations/contract.json',
  'fixtures/radar-operations/findings.md',
]);

const MUST_NOT_MUTATE = Object.freeze([
  'database/',
  'docker/hermes-staging/',
  'scripts/staff-query-api.js',
  'infra/azure/staging/main.bicep',
  'infra/azure/sunset-staging/main.bicep',
  'infra/azure/staging-staff-api-metric-alerts/',
  'infra/azure/staging-cost-budgets/',
]);

const CAPACITY_ALERT_NAMES = Object.freeze([
  WH_CPU_RULE,
  WH_MEM_RULE,
  SUNSET_CPU_RULE,
  SUNSET_MEM_RULE,
]);

module.exports = {
  MASTER_BASIS,
  SLICE,
  OUTCOME_ID,
  GATE_ID,
  GATE_IDS,
  PROGRESS_CLASS,
  BRANCH,
  EVIDENCE_REL,
  CONTRACT_REL,
  SUBSCRIPTION_ID,
  WH_RG,
  WH_APP,
  WH_CPU_RULE,
  WH_MEM_RULE,
  WH_AG_NAME,
  WH_AG_ID,
  WH_APP_SCOPE,
  WH_REVISION,
  WH_MIN,
  WH_MAX,
  SUNSET_RG,
  SUNSET_APP,
  SUNSET_CPU_RULE,
  SUNSET_MEM_RULE,
  SUNSET_AG_NAME,
  SUNSET_AG_ID,
  SUNSET_APP_SCOPE,
  SUNSET_REVISION,
  SUNSET_MIN,
  SUNSET_MAX,
  METRIC_NAMESPACE,
  TIME_AGGREGATION,
  OPERATOR,
  THRESHOLD,
  EVALUATION_FREQUENCY,
  WINDOW_SIZE,
  RULE_ENABLED,
  RULE_SEVERITY_INT,
  SEVERITY_LABEL,
  CRITERION_TYPE,
  AG_ENABLED,
  RECEIVER_NAME,
  RECEIVER_STATUS,
  SCALE_RULES,
  ACTIVE_MODE,
  SOURCE_TYPE,
  SOURCE_REF,
  INDEPENDENT_VERIFY_UTC,
  OBSERVED_AT_SEMANTICS,
  PROVENANCE_LIMITATIONS,
  NON_RECOVERABILITY,
  CLAIM_OWNERSHIP,
  EXPLICITLY_NOT_CLAIMED,
  CLAIMS_ALLOWED,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  CAPACITY_ALERT_NAMES,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
