'use strict';

/**
 * preflight-radar-slice16e-staff-api-rollback
 *
 * Exact subscription/RG/app short-circuit preflight for RADAR 16E.
 * NEVER executes rollback. NEVER calls Azure mutating APIs.
 * Fail-closed on every unknown/positional argv. Explicitly rejects --live/--execute.
 *
 * Usage (plan mode only — inventory supplied via --inventory-json fixture path):
 *   node scripts/preflight-radar-slice16e-staff-api-rollback.js \
 *     --resource-group wh-staging-rg \
 *     --container-app wh-staging-staff-api \
 *     --current-revision wh-staging-staff-api--rev-current \
 *     --target-revision wh-staging-staff-api--rev-target \
 *     --target-image whstagingacr.azurecr.io/wh-staff-api:<40-hex-sha> \
 *     --target-image-sha <40-hex-sha> \
 *     --confirm 'I-CONFIRM-TRAFFIC-ROLLBACK:wh-staging-staff-api:<target-revision>' \
 *     --inventory-json fixtures/radar-operations/slice16e-sample-inventory.wh.json
 */

const fs = require('fs');
const path = require('path');

const {
  LOCKS,
  APP_PLANS,
  ALLOWED_MUTATION,
  assertExactStagingScope,
  evaluateRollbackRequest,
  expectedConfirmationToken,
} = require('./lib/radar-slice16e-staff-api-rollback');

/** Azure dispatch counter — must remain 0 for this source-only slice. */
const azureCalls = { count: 0 };

const ALLOWED_FLAGS = new Set([
  '--resource-group',
  '-g',
  '--container-app',
  '-n',
  '--current-revision',
  '--target-revision',
  '--target-image',
  '--target-image-sha',
  '--confirm',
  '--confirmation-token',
  '--inventory-json',
  '--help',
  '-h',
]);

const FORBIDDEN_FLAGS = new Set([
  '--live',
  '--execute',
  '--apply',
  '--rollback',
  '--deploy',
  '--what-if',
  '--restart',
  '--delete',
]);

function refuse(reason, detail) {
  const report = {
    ok: false,
    refused: true,
    reason,
    detail: detail || null,
    azureCalls: azureCalls.count,
    liveRollbackEnabled: false,
    note: 'Preflight refused before any Azure call',
  };
  console.error(JSON.stringify(report));
  console.error(`REFUSED: ${reason}${detail ? ` (${detail})` : ''} azureCalls=${azureCalls.count}`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {
    resourceGroup: null,
    containerApp: null,
    currentRevisionName: null,
    targetRevisionName: null,
    targetImage: null,
    targetImageSha: null,
    confirmationToken: null,
    inventoryJson: null,
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

    const take = (key) => {
      const val = args[i + 1];
      if (val == null || String(val).startsWith('-')) {
        refuse('missing_flag_value', a);
      }
      out[key] = val;
      i += 1;
    };

    if (a === '--resource-group' || a === '-g') {
      take('resourceGroup');
      continue;
    }
    if (a === '--container-app' || a === '-n') {
      take('containerApp');
      continue;
    }
    if (a === '--current-revision') {
      take('currentRevisionName');
      continue;
    }
    if (a === '--target-revision') {
      take('targetRevisionName');
      continue;
    }
    if (a === '--target-image') {
      take('targetImage');
      continue;
    }
    if (a === '--target-image-sha') {
      take('targetImageSha');
      continue;
    }
    if (a === '--confirm' || a === '--confirmation-token') {
      take('confirmationToken');
      continue;
    }
    if (a === '--inventory-json') {
      take('inventoryJson');
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
    console.log('Usage: node scripts/preflight-radar-slice16e-staff-api-rollback.js \\');
    console.log('  --resource-group <rg> --container-app <app> \\');
    console.log('  --current-revision <name> --target-revision <name> \\');
    console.log('  --target-image <repo:40hex> --target-image-sha <40hex> \\');
    console.log('  --confirm I-CONFIRM-TRAFFIC-ROLLBACK:<app>:<target-revision> \\');
    console.log('  --inventory-json <path>');
    console.log(`Locks: sub=${LOCKS.subscriptionId} liveRollback=${LOCKS.liveRollbackEnabled}`);
    console.log('Fail-closed: rejects --live/--execute/--apply/--rollback, unknown flags, positionals.');
    process.exit(0);
  }

  if (!args.resourceGroup) refuse('missing_resource_group', '--resource-group required');
  if (!args.containerApp) refuse('missing_container_app', '--container-app required');
  if (!args.currentRevisionName) refuse('missing_current_revision', '--current-revision required');
  if (!args.targetRevisionName) refuse('missing_target_revision', '--target-revision required');
  if (!args.targetImage) refuse('missing_target_image', '--target-image required');
  if (!args.targetImageSha) refuse('missing_target_image_sha', '--target-image-sha required');
  if (!args.confirmationToken) refuse('missing_confirmation', '--confirm required');
  if (!args.inventoryJson) refuse('missing_inventory_json', '--inventory-json required');

  // Short-circuit BEFORE any Azure consideration. azureCalls stays 0.
  const scope = assertExactStagingScope({
    subscriptionId: LOCKS.subscriptionId,
    resourceGroup: args.resourceGroup,
    containerApp: args.containerApp,
  });
  if (!scope.ok) {
    refuse('scope_short_circuit', scope.errors.join(','));
  }

  const plan = APP_PLANS[args.containerApp];
  if (!plan) refuse('unknown_app_plan', args.containerApp);

  let inventory;
  try {
    const abs = path.isAbsolute(args.inventoryJson)
      ? args.inventoryJson
      : path.join(process.cwd(), args.inventoryJson);
    inventory = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    refuse('inventory_json_unreadable', String(err && err.message || err).slice(0, 200));
  }

  const evalResult = evaluateRollbackRequest({
    subscriptionId: LOCKS.subscriptionId,
    resourceGroup: args.resourceGroup,
    containerApp: args.containerApp,
    currentRevisionName: args.currentRevisionName,
    targetRevisionName: args.targetRevisionName,
    targetImage: args.targetImage,
    targetImageSha: args.targetImageSha,
    confirmationToken: args.confirmationToken,
    mutations: [{ kind: ALLOWED_MUTATION }],
    inventory,
    mode: 'plan',
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
    subscriptionId: LOCKS.subscriptionId,
    resourceGroup: args.resourceGroup,
    containerApp: args.containerApp,
    currentRevisionName: args.currentRevisionName,
    targetRevisionName: args.targetRevisionName,
    targetImageSha: String(args.targetImageSha).toLowerCase(),
    confirmationExpected: expectedConfirmationToken({
      containerApp: args.containerApp,
      targetRevisionName: args.targetRevisionName,
    }),
    mutation: ALLOWED_MUTATION,
    trafficSnapshotBefore: evalResult.trafficSnapshotBefore,
    plannedTraffic: evalResult.plannedTraffic,
    restorePlan: evalResult.restorePlan,
    rollbackRecord: evalResult.record,
    liveRollbackEnabled: false,
    liveExecuted: false,
    azureCalls: azureCalls.count,
    note: 'Preflight/plan only — no Azure calls, no traffic mutation executed',
    open_drill: LOCKS.openDrillId,
  };

  console.log(JSON.stringify(report, null, 2));
  console.log('RADAR 16E preflight: PASS (no live calls)');
}

main();
