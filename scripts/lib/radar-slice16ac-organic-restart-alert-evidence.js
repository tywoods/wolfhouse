'use strict';

/**
 * radar-slice16ac-organic-restart-alert-evidence — RADAR Slice 16AC locks.
 *
 * Evidence-only reconciliation of independently discovered organic Azure
 * Monitor restart-count alert instances temporally associated with completed
 * 16AA dual-staging SIGINT drills @ master 72d8faf7. No live mutation.
 * Azure read-only only.
 *
 * Proves: enabled deployed RestartCount alerts organically fired/resolved on
 * both staging apps and invoked the unsuppressed action path (AG receivers
 * named ops-email status Enabled). Does not prove human inbox receipt,
 * unique causality beyond platform alert fields, 5xx alert firing,
 * production, zero downtime, or full G02/G03.
 */

const path = require('path');

const MASTER_BASIS = '72d8faf74df27a714482ebdefb8f88870d080306';
const SLICE = 'RADAR-16AC';
const OUTCOME_ID = '16AC_organic_restart_alert_evidence';
const GATE_IDS = Object.freeze([
  'G02_readiness_dependencies',
  'G03_actionable_tenant_aware_alerts',
]);
const PROGRESS_CLASS = 'partial_live_proven_evidence_only';
const BRANCH = 'radar/slice-16ac-organic-restart-alert-evidence';

const EVIDENCE_REL = 'fixtures/radar-operations/slice16ac-organic-restart-alert-evidence.json';
const CONTRACT_REL = 'fixtures/radar-operations/slice16ac-expected-contract.json';

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';

const WH_RG = 'wh-staging-rg';
const WH_APP = 'wh-staging-staff-api';
const WH_RULE = 'wolfhouse-staff-api-restart-count';
const WH_ALERT_NAME = 'wolfhouse-staff-api-restart-count';
const WH_ALERT_INSTANCE_ID =
  '89b5348f-af7a-4c27-9f90-98003722f000';
const WH_ALERT_RESOURCE_ID =
  `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${WH_RG}/providers/microsoft.app/containerapps/${WH_APP}/providers/Microsoft.AlertsManagement/alerts/${WH_ALERT_INSTANCE_ID}`;
const WH_RULE_RESOURCE_ID =
  `/subscriptions/${SUBSCRIPTION_ID}/resourcegroups/${WH_RG}/providers/Microsoft.Insights/metricAlerts/${WH_RULE}`;
const WH_START_UTC = '2026-07-21T12:11:40.2497189Z';
const WH_RESOLVED_UTC = '2026-07-21T12:17:59.4591399Z';
const WH_AG_NAME = 'wh-staging-ops-budget-ag';
const WH_AG_ID =
  `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${WH_RG}/providers/Microsoft.Insights/actionGroups/${WH_AG_NAME}`;
const WH_COST_USD = 69.3920793568176;
const WH_SIGINT_LAW_UTC = '2026-07-21T12:08:28.6734879Z';

const SUNSET_RG = 'luna-sunset-staging-rg';
const SUNSET_APP = 'luna-sunset-staging-staff-api';
const SUNSET_RULE = 'sunset-staff-api-restart-count';
const SUNSET_ALERT_NAME = 'sunset-staff-api-restart-count';
const SUNSET_ALERT_INSTANCE_ID =
  'b162b124-7d78-42cf-97dc-0ddb8150f000';
const SUNSET_ALERT_RESOURCE_ID =
  `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${SUNSET_RG}/providers/microsoft.app/containerapps/${SUNSET_APP}/providers/Microsoft.AlertsManagement/alerts/${SUNSET_ALERT_INSTANCE_ID}`;
const SUNSET_RULE_RESOURCE_ID =
  `/subscriptions/${SUBSCRIPTION_ID}/resourcegroups/${SUNSET_RG}/providers/Microsoft.Insights/metricAlerts/${SUNSET_RULE}`;
const SUNSET_START_UTC = '2026-07-21T12:12:51.2774974Z';
const SUNSET_RESOLVED_UTC = '2026-07-21T12:19:32.3682899Z';
const SUNSET_AG_NAME = 'luna-sunset-staging-ops-budget-ag';
const SUNSET_AG_ID =
  `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${SUNSET_RG}/providers/Microsoft.Insights/actionGroups/${SUNSET_AG_NAME}`;
const SUNSET_COST_USD = 18.1452292043011;
const SUNSET_SIGINT_LAW_UTC = '2026-07-21T12:09:25.9915987Z';

const SIGNAL_TYPE = 'Metric';
const SEVERITY = 'Sev2';
const MONITOR_SERVICE = 'Platform';
const MONITOR_CONDITION = 'Resolved';
const IS_SUPPRESSED = false;
const METRIC_NAME = 'RestartCount';
const METRIC_NAMESPACE = 'Microsoft.App/containerApps';
const TIME_AGGREGATION = 'Total';
const OPERATOR = 'GreaterThan';
const THRESHOLD = 0;
const EVALUATION_FREQUENCY = 'PT1M';
const WINDOW_SIZE = 'PT5M';
const RULE_ENABLED = true;
const RULE_SEVERITY_INT = 2;
const AG_ENABLED = true;
const RECEIVER_NAME = 'ops-email';
const RECEIVER_STATUS = 'Enabled';
const METRIC_VALUE_AT_FIRE = 1.0;

const SOURCE_TYPE =
  'azure_monitor_alerts_management_metric_alert_action_group_readonly_independently_reverified';
const SOURCE_REF =
  'az_monitor_alerts_management_metric_alert_ag_readonly_2026-07-21T13:07:35Z';
const INDEPENDENT_VERIFY_UTC = '2026-07-21T13:07:35Z';
const OBSERVED_AT_SEMANTICS = 'independently_reverified_at_recorded_utc';

const ATTRIBUTION_SEMANTICS =
  'organic_alert_instances_temporally_associated_with_16AA_sigint_restart_producing_drills_exact_app_rule_not_proof_of_email_receipt_or_unique_causality_beyond_platform_alert_fields';

const PROVENANCE_LIMITATIONS =
  'Independently recovered Azure Monitor Alerts Management alert instances, '
  + 'metric-alert rule definitions, and action-group enabled/receiver-name/'
  + 'status fields via read-only Azure calls at independent_azure_verify_utc. '
  + 'Chronology cautiously attributes these organic restart-alert instances as '
  + 'temporally associated with completed 16AA dual-staging SIGINT drills '
  + `(WH LAW SIGINT ${WH_SIGINT_LAW_UTC}; Sunset LAW SIGINT ${SUNSET_SIGINT_LAW_UTC}) `
  + 'and exact app/rule — not proof of email receipt or unique causality beyond '
  + 'platform alert fields. Human inbox receipt remains unproven. Receiver '
  + 'email addresses are intentionally not recorded. CostManagement query was '
  + 'RBAC-denied on this reverify identity; MTD costs are locked to the '
  + 'discovery before/after unchanged figures with no resources created in this '
  + 'evidence capture. Does not claim 5xx alert firing, production, zero '
  + 'downtime, or full G02/G03.';

const NON_RECOVERABILITY =
  'Azure read-only APIs cannot prove human inbox delivery, SMTP acceptance, '
  + 'or unique causality beyond platform alert essentials/actionStatus fields. '
  + 'CostManagement ActualCost reverify was RBAC-denied for this identity; '
  + 'locked MTD figures must not be rewritten from invented values. Alert '
  + 'instance history is recovered from Alerts Management; do not invent '
  + 'suppressed=false, wrong timestamps, or 5xx alert fire claims.';

const CLAIM_OWNERSHIP = Object.freeze({
  organic_restart_alert_instances: Object.freeze({
    owner_class: 'azure_monitor_readonly_independently_reverified',
    observation: 'restart_count_metric_alerts_fired_resolved_unsuppressed_both_tenants',
    proves: [
      'organic_restart_alert_fired_and_resolved_both_staging_apps',
      'monitorCondition_Resolved_Metric_Sev2_Platform',
      'actionStatus_isSuppressed_false',
      'exact_rule_names_targets_timestamps',
    ],
    does_not_prove: [
      'human_inbox_receipt',
      'unique_causality_beyond_platform_alert_fields',
      'requests_5xx_alert_firing',
      'production',
      'zero_downtime_during_restart',
      'full_G02_proven',
      'full_G03_proven',
    ],
    limitation:
      'Platform alert fields + unsuppressed actionStatus only; inbox and unique '
      + 'causality remain open',
  }),
  deployed_restart_rules_and_action_groups: Object.freeze({
    owner_class: 'azure_monitor_readonly_independently_reverified',
    observation: 'enabled_restart_rules_scoped_to_apps_wired_to_ops_budget_ags',
    proves: [
      'rules_enabled_RestartCount_Total_GreaterThan_0_PT1M_PT5M',
      'exact_app_scopes',
      'exact_ops_budget_action_group_ids',
      'action_groups_enabled_ops_email_receiver_Enabled',
    ],
    does_not_prove: [
      'receiver_email_address',
      'human_inbox_receipt',
      'requests_5xx_alert_firing',
    ],
    limitation: 'Receiver address intentionally omitted; delivery unproven',
  }),
  chronology_with_16aa_sigint: Object.freeze({
    owner_class: 'prior_16AA_locked_law_plus_alert_timestamps',
    observation: 'alert_start_after_16AA_sigint_law_completions_same_apps',
    proves: [
      'temporal_association_with_16AA_sigint_restart_producing_drills',
    ],
    does_not_prove: [
      'unique_causality_beyond_platform_alert_fields',
      'human_inbox_receipt',
    ],
    limitation:
      'Cautious temporal association only; not unique-causality proof',
  }),
  cost_unchanged_no_resources_created: Object.freeze({
    owner_class: 'locked_discovery_mtd_figures_plus_readonly_capture',
    observation: 'mtd_costs_locked_unchanged_no_resources_created_this_capture',
    proves: [
      'locked_mtd_costs_wh_69_3920793568176_sunset_18_1452292043011',
      'no_resources_created_in_this_evidence_capture',
    ],
    does_not_prove: [
      'cost_management_reverify_succeeded_on_this_identity',
      'cost_decreased',
      'cost_increased',
    ],
    limitation:
      'CostManagement reverify RBAC-denied; figures locked from discovery '
      + 'before/after unchanged values',
  }),
});

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'human_inbox_receipt',
  'unique_causality_beyond_platform_alert_fields',
  'requests_5xx_alert_firing',
  'receiver_email_address_disclosure',
  'invented_email_delivery_proof',
  'production',
  'zero_downtime_during_restart',
  'full_G02_proven',
  'full_G03_proven',
  'any_gate_verdict_proven',
  'cost_mutation',
  'resources_created_this_capture',
]);

const CLAIMS_ALLOWED = Object.freeze([
  'organic_restart_alert_fired_resolved_both_tenants',
  'exact_wh_start_12_11_40_resolved_12_17_59_unsuppressed',
  'exact_sunset_start_12_12_51_resolved_12_19_32_unsuppressed',
  'rules_enabled_RestartCount_Total_GreaterThan_0_PT1M_eval_PT5M_window',
  'exact_app_scopes_and_ops_budget_action_group_ids',
  'action_groups_enabled_ops_email_receiver_Enabled_no_address',
  'temporal_association_with_16AA_sigint_law_completions',
  'locked_mtd_costs_unchanged_no_resources_created',
  'g02_organic_restart_alert_gap_closed_g02_remains_partial',
  'g03_organic_firing_closed_inbox_receipt_open_g03_remains_partial',
  'no_production_scope',
  'no_5xx_alert_fire_claim',
]);

const OWNED_RELS = Object.freeze([
  EVIDENCE_REL,
  CONTRACT_REL,
  'scripts/lib/radar-slice16ac-organic-restart-alert-evidence.js',
  'scripts/verify-radar-slice16ac-organic-restart-alert-evidence.js',
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

module.exports = {
  MASTER_BASIS,
  SLICE,
  OUTCOME_ID,
  GATE_IDS,
  PROGRESS_CLASS,
  BRANCH,
  EVIDENCE_REL,
  CONTRACT_REL,
  SUBSCRIPTION_ID,
  WH_RG,
  WH_APP,
  WH_RULE,
  WH_ALERT_NAME,
  WH_ALERT_INSTANCE_ID,
  WH_ALERT_RESOURCE_ID,
  WH_RULE_RESOURCE_ID,
  WH_START_UTC,
  WH_RESOLVED_UTC,
  WH_AG_NAME,
  WH_AG_ID,
  WH_COST_USD,
  WH_SIGINT_LAW_UTC,
  SUNSET_RG,
  SUNSET_APP,
  SUNSET_RULE,
  SUNSET_ALERT_NAME,
  SUNSET_ALERT_INSTANCE_ID,
  SUNSET_ALERT_RESOURCE_ID,
  SUNSET_RULE_RESOURCE_ID,
  SUNSET_START_UTC,
  SUNSET_RESOLVED_UTC,
  SUNSET_AG_NAME,
  SUNSET_AG_ID,
  SUNSET_COST_USD,
  SUNSET_SIGINT_LAW_UTC,
  SIGNAL_TYPE,
  SEVERITY,
  MONITOR_SERVICE,
  MONITOR_CONDITION,
  IS_SUPPRESSED,
  METRIC_NAME,
  METRIC_NAMESPACE,
  TIME_AGGREGATION,
  OPERATOR,
  THRESHOLD,
  EVALUATION_FREQUENCY,
  WINDOW_SIZE,
  RULE_ENABLED,
  RULE_SEVERITY_INT,
  AG_ENABLED,
  RECEIVER_NAME,
  RECEIVER_STATUS,
  METRIC_VALUE_AT_FIRE,
  SOURCE_TYPE,
  SOURCE_REF,
  INDEPENDENT_VERIFY_UTC,
  OBSERVED_AT_SEMANTICS,
  ATTRIBUTION_SEMANTICS,
  PROVENANCE_LIMITATIONS,
  NON_RECOVERABILITY,
  CLAIM_OWNERSHIP,
  EXPLICITLY_NOT_CLAIMED,
  CLAIMS_ALLOWED,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
