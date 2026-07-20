'use strict';

/**
 * preflight-radar-slice16f-staff-api-metric-alerts
 *
 * Exact subscription/RG/app/action-group short-circuit preflight for RADAR 16F.
 * NEVER deploys. NEVER calls Azure mutating APIs.
 * Fail-closed on every unknown/positional argv. Explicitly rejects --live.
 *
 * Usage:
 *   node scripts/preflight-radar-slice16f-staff-api-metric-alerts.js \
 *     --resource-group wh-staging-rg
 */

const {
  LOCKS,
  APP_PLANS,
  ALLOWED_RESOURCE_TYPES,
  METRIC_NAMESPACE,
  WINDOW_SIZE,
  EVALUATION_FREQUENCY,
  SEVERITY,
  assertExactStagingScope,
  assertDeploymentMode,
  evaluateDeployRequest,
} = require('./lib/radar-slice16f-staff-api-metric-alerts');

/** Azure dispatch counter — must remain 0 for this source-only slice. */
const azureCalls = { count: 0 };

const ALLOWED_FLAGS = new Set([
  '--resource-group',
  '-g',
  '--mode',
  '--deployment-mode',
  '--help',
  '-h',
]);

const FORBIDDEN_FLAGS = new Set([
  '--live',
  '--deploy',
  '--apply',
  '--what-if',
  '--complete',
]);

function refuse(reason, detail) {
  const report = {
    ok: false,
    refused: true,
    reason,
    detail: detail || null,
    azureCalls: azureCalls.count,
    liveDeployEnabled: false,
    note: 'Preflight refused before any Azure call',
  };
  console.error(JSON.stringify(report));
  console.error(`REFUSED: ${reason}${detail ? ` (${detail})` : ''} azureCalls=${azureCalls.count}`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {
    resourceGroup: null,
    deploymentMode: 'Incremental',
    help: false,
  };
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];

    if (!a.startsWith('-')) {
      refuse('unknown_positional_arg', a);
    }

    if (FORBIDDEN_FLAGS.has(a)) {
      refuse('forbidden_flag', a);
    }

    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }

    if (a === '--resource-group' || a === '-g') {
      const val = args[i + 1];
      if (val == null || String(val).startsWith('-')) {
        refuse('missing_flag_value', a);
      }
      out.resourceGroup = val;
      i += 1;
      continue;
    }

    if (a === '--mode' || a === '--deployment-mode') {
      const val = args[i + 1];
      if (val == null || String(val).startsWith('-')) {
        refuse('missing_flag_value', a);
      }
      out.deploymentMode = val;
      i += 1;
      continue;
    }

    if (!ALLOWED_FLAGS.has(a)) {
      refuse('unknown_cli_arg', a);
    }

    refuse('unknown_cli_arg', a);
  }

  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: node scripts/preflight-radar-slice16f-staff-api-metric-alerts.js --resource-group <rg>');
    console.log(`Locks: sub=${LOCKS.subscriptionId} mode=${LOCKS.deploymentMode} liveDeploy=${LOCKS.liveDeployEnabled}`);
    console.log('Fail-closed: rejects --live/--deploy/--apply/--what-if/--complete, unknown flags, and positionals.');
    process.exit(0);
  }

  if (!args.resourceGroup) {
    refuse('missing_resource_group', '--resource-group required');
  }

  const plan = APP_PLANS[args.resourceGroup];
  if (!plan) {
    refuse('scope_short_circuit', 'wrong_resource_group');
  }

  // Short-circuit BEFORE any Azure consideration. azureCalls stays 0.
  const scope = assertExactStagingScope({
    subscriptionId: LOCKS.subscriptionId,
    resourceGroup: args.resourceGroup,
    containerAppName: plan.containerAppName,
    actionGroupName: plan.actionGroupName,
  });
  if (!scope.ok) {
    refuse('scope_short_circuit', scope.errors.join(','));
  }

  const mode = assertDeploymentMode(args.deploymentMode);
  if (!mode.ok) {
    refuse('deployment_mode', mode.errors.join(','));
  }

  const evalResult = evaluateDeployRequest({
    subscriptionId: LOCKS.subscriptionId,
    resourceGroup: args.resourceGroup,
    deploymentMode: args.deploymentMode,
    containerAppName: plan.containerAppName,
    actionGroupName: plan.actionGroupName,
    tenantSlug: plan.tenantSlug,
    metricNamespace: METRIC_NAMESPACE,
    windowSize: WINDOW_SIZE,
    evaluationFrequency: EVALUATION_FREQUENCY,
    severity: SEVERITY,
    alerts: plan.alerts.map((a) => ({ ...a, dimensionValues: [...a.dimensionValues] })),
    resourceTypes: [...ALLOWED_RESOURCE_TYPES],
  });

  if (!evalResult.ok) {
    refuse('preflight_eval', evalResult.errors.join(','));
  }

  if (azureCalls.count !== 0) {
    refuse('azure_call_detected', String(azureCalls.count));
  }

  const report = {
    ok: true,
    slice: LOCKS.slice,
    outcome_id: LOCKS.outcomeId,
    progress_class: LOCKS.progressClass,
    does_not_implement: LOCKS.doesNotImplement,
    subscriptionId: LOCKS.subscriptionId,
    resourceGroup: args.resourceGroup,
    containerAppName: plan.containerAppName,
    tenantSlug: plan.tenantSlug,
    actionGroupName: plan.actionGroupName,
    actionGroupSource: LOCKS.referencedActionGroupSource,
    deploymentMode: LOCKS.deploymentMode,
    liveDeployEnabled: false,
    notification_delivery_proof: 'open',
    alert_fire_drill: 'open',
    metricNamespace: METRIC_NAMESPACE,
    windowSize: WINDOW_SIZE,
    evaluationFrequency: EVALUATION_FREQUENCY,
    severity: SEVERITY,
    alerts: plan.alerts.map((a) => ({
      name: a.name,
      metricName: a.metricName,
      operator: a.operator,
      threshold: a.threshold,
      enabled: a.enabled,
    })),
    resourceTypesAllowed: [...ALLOWED_RESOURCE_TYPES],
    bicepModuleRel: LOCKS.bicepModuleRel,
    azureCalls: azureCalls.count,
    note: 'Preflight only — no Azure calls, no deploy; AG referenced by name only',
  };

  console.log(JSON.stringify(report, null, 2));
  console.log('RADAR 16F preflight: PASS (no live calls)');
}

main();
