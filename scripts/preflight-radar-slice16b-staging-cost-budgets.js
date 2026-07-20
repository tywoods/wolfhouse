'use strict';

/**
 * preflight-radar-slice16b-staging-cost-budgets
 *
 * Exact subscription/RG short-circuit preflight for RADAR 16B.
 * NEVER deploys. NEVER calls Azure mutating APIs.
 * Fail-closed on every unknown/positional argv. Explicitly rejects --live.
 *
 * Usage:
 *   node scripts/preflight-radar-slice16b-staging-cost-budgets.js \
 *     --resource-group wh-staging-rg
 *
 * Env: WH_RADAR_16B_OPS_NOTIFY_EMAIL (required for email check; never committed)
 */

const {
  LOCKS,
  BUDGET_PLANS,
  THRESHOLDS,
  ALLOWED_RESOURCE_TYPES,
  OPS_EMAIL_ENV,
  assertExactStagingScope,
  assertDeploymentMode,
  validateOpsEmail,
  evaluateDeployRequest,
  redactEmail,
} = require('./lib/radar-slice16b-staging-cost-budgets');

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
  '--ops-email',
  '--email',
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
    console.log(`Usage: node scripts/preflight-radar-slice16b-staging-cost-budgets.js --resource-group <rg>`);
    console.log(`Env: ${OPS_EMAIL_ENV}=ops@your-domain (required for email check; never committed)`);
    console.log(`Locks: sub=${LOCKS.subscriptionId} mode=${LOCKS.deploymentMode} liveDeploy=${LOCKS.liveDeployEnabled}`);
    console.log('Fail-closed: rejects --live/--deploy/--apply/--what-if/--complete, unknown flags, and positionals.');
    process.exit(0);
  }

  if (!args.resourceGroup) {
    refuse('missing_resource_group', '--resource-group required');
  }

  // Short-circuit BEFORE any Azure consideration. azureCalls stays 0.
  const scope = assertExactStagingScope({
    subscriptionId: LOCKS.subscriptionId,
    resourceGroup: args.resourceGroup,
  });
  if (!scope.ok) {
    refuse('scope_short_circuit', scope.errors.join(','));
  }

  const mode = assertDeploymentMode(args.deploymentMode);
  if (!mode.ok) {
    refuse('deployment_mode', mode.errors.join(','));
  }

  const plan = BUDGET_PLANS[args.resourceGroup];
  if (!plan) {
    refuse('unknown_resource_group_plan', args.resourceGroup);
  }

  const emailRaw = process.env[OPS_EMAIL_ENV];
  const email = validateOpsEmail(emailRaw);
  if (!email.ok) {
    refuse('ops_email', email.errors.join(','));
  }

  const evalResult = evaluateDeployRequest({
    subscriptionId: LOCKS.subscriptionId,
    resourceGroup: args.resourceGroup,
    deploymentMode: args.deploymentMode,
    opsNotifyEmail: email.email,
    amountUsd: plan.amountUsd,
    thresholds: THRESHOLDS.map((percent) => ({ percent, enabled: true })),
    budgetName: plan.budgetName,
    actionGroupName: plan.actionGroupName,
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
    deploymentMode: LOCKS.deploymentMode,
    liveDeployEnabled: false,
    anomalyDetectionClaimed: false,
    notification_delivery_proof: 'open',
    amountUsd: plan.amountUsd,
    budgetName: plan.budgetName,
    actionGroupName: plan.actionGroupName,
    thresholds: [...THRESHOLDS],
    opsEmailRedacted: redactEmail(email.email),
    resourceTypesAllowed: [...ALLOWED_RESOURCE_TYPES],
    bicepModuleRel: LOCKS.bicepModuleRel,
    azureCalls: azureCalls.count,
    note: 'Preflight only — no Azure calls, no deploy',
  };

  console.log(JSON.stringify(report, null, 2));
  console.log('RADAR 16B preflight: PASS (no live calls)');
}

main();
