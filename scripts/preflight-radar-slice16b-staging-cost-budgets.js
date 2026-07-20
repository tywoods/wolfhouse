'use strict';

/**
 * preflight-radar-slice16b-staging-cost-budgets
 *
 * Exact subscription/RG short-circuit preflight for RADAR 16B.
 * NEVER deploys. NEVER calls Azure mutating APIs.
 *
 * Usage:
 *   node scripts/preflight-radar-slice16b-staging-cost-budgets.js \
 *     --resource-group wh-staging-rg \
 *     [--ops-email via env WH_RADAR_16B_OPS_NOTIFY_EMAIL only]
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

function parseArgs(argv) {
  const out = { resourceGroup: null, deploymentMode: 'Incremental', help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--resource-group' || a === '-g') {
      out.resourceGroup = argv[i + 1];
      i += 1;
    } else if (a === '--mode' || a === '--deployment-mode') {
      out.deploymentMode = argv[i + 1];
      i += 1;
    } else if (a === '--ops-email' || a === '--email') {
      console.error('REFUSED: do not pass email on argv (use env ' + OPS_EMAIL_ENV + ')');
      process.exit(2);
    } else if (a === '--deploy' || a === '--apply' || a === '--what-if' || a === '--complete') {
      console.error(`REFUSED: forbidden flag ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.resourceGroup) {
    console.log(`Usage: node scripts/preflight-radar-slice16b-staging-cost-budgets.js --resource-group <rg>`);
    console.log(`Env: ${OPS_EMAIL_ENV}=ops@your-domain (required for email check; never committed)`);
    console.log(`Locks: sub=${LOCKS.subscriptionId} mode=${LOCKS.deploymentMode} liveDeploy=${LOCKS.liveDeployEnabled}`);
    process.exit(args.help ? 0 : 2);
  }

  // Short-circuit BEFORE any Azure consideration.
  const scope = assertExactStagingScope({
    subscriptionId: LOCKS.subscriptionId,
    resourceGroup: args.resourceGroup,
  });
  if (!scope.ok) {
    console.error('REFUSED: scope short-circuit', scope.errors.join(','));
    process.exit(2);
  }

  const mode = assertDeploymentMode(args.deploymentMode);
  if (!mode.ok) {
    console.error('REFUSED: deployment mode', mode.errors.join(','));
    process.exit(2);
  }

  const plan = BUDGET_PLANS[args.resourceGroup];
  const emailRaw = process.env[OPS_EMAIL_ENV];
  const email = validateOpsEmail(emailRaw);
  if (!email.ok) {
    console.error('REFUSED: ops email', email.errors.join(','));
    process.exit(2);
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
    console.error('REFUSED: preflight', evalResult.errors.join(','));
    process.exit(2);
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
    note: 'Preflight only — no Azure calls, no deploy',
  };

  console.log(JSON.stringify(report, null, 2));
  console.log('RADAR 16B preflight: PASS (no live calls)');
}

main();
