'use strict';

/**
 * radar-slice16e-staff-api-rollback — RADAR Slice 16E
 *
 * Fail-closed, staging-only Azure Container Apps Staff API traffic-weight
 * rollback plan + preflight. Offline-first. Live rollback hard-disabled.
 * Never mutates image/env/secrets/scaling/DB/restart/delete — traffic only.
 */

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const MUTABLE_TAGS = Object.freeze(['latest', 'staging', 'prod', 'dev', 'main', 'master']);

const APP_PLANS = Object.freeze({
  'wh-staging-staff-api': Object.freeze({
    resourceGroup: 'wh-staging-rg',
    containerApp: 'wh-staging-staff-api',
    imageRepository: 'whstagingacr.azurecr.io/wh-staff-api',
  }),
  'luna-sunset-staging-staff-api': Object.freeze({
    resourceGroup: 'luna-sunset-staging-rg',
    containerApp: 'luna-sunset-staging-staff-api',
    imageRepository: 'whstagingacr.azurecr.io/luna-sunset-staff-api',
  }),
});

const ALLOWED_APPS = Object.freeze(Object.keys(APP_PLANS));
const RESOURCE_GROUPS = Object.freeze([
  'wh-staging-rg',
  'luna-sunset-staging-rg',
]);

const ALLOWED_MUTATION = 'traffic_weight';
const FORBIDDEN_MUTATIONS = Object.freeze([
  'image',
  'env',
  'secrets',
  'scaling',
  'database',
  'db',
  'restart',
  'delete',
  'revision_create',
  'revision_deactivate',
  'containerapp_update',
  'bicep_deploy',
]);

const PRODUCTION_MARKERS = Object.freeze([
  'prod',
  'production',
  'wh-prod-rg',
  'wh-prod-',
  'luna-prod',
]);

const LOCKS = Object.freeze({
  slice: 'RADAR-16E',
  outcomeId: '16E_staff_api_aca_traffic_rollback_runbook',
  gateId: 'G07_rollback_incident_runbooks',
  progressClass: 'source_partial_progress_only',
  masterBasis: 'acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b',
  branch: 'radar/slice-16e-staff-api-rollback-runbook',
  subscriptionId: SUBSCRIPTION_ID,
  resourceGroups: RESOURCE_GROUPS,
  allowedApps: ALLOWED_APPS,
  appPlans: APP_PLANS,
  allowedMutation: ALLOWED_MUTATION,
  forbiddenMutations: FORBIDDEN_MUTATIONS,
  liveRollbackEnabled: false,
  liveExecuteEnabled: false,
  confirmationPrefix: 'I-CONFIRM-TRAFFIC-ROLLBACK',
  planFixtureRel: 'fixtures/radar-operations/slice16e-rollback-plans.json',
  contractFixtureRel: 'fixtures/radar-operations/slice16e-expected-contract.json',
  runbookRel: 'docs/RADAR-16E-STAFF-API-ROLLBACK-RUNBOOK.md',
  openDrillId: '16E_DRILL_live_rollback_restore',
});

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function parseImage(image) {
  const raw = trimStr(image);
  if (!raw) return { ok: false, reason: 'image_missing', repository: '', tag: '' };
  const idx = raw.lastIndexOf(':');
  if (idx < 0) {
    return { ok: false, reason: 'image_tag_missing', repository: raw, tag: '' };
  }
  return {
    ok: true,
    repository: raw.slice(0, idx),
    tag: raw.slice(idx + 1),
    raw,
  };
}

function expectedConfirmationToken({ containerApp, targetRevisionName } = {}) {
  return `${LOCKS.confirmationPrefix}:${trimStr(containerApp)}:${trimStr(targetRevisionName)}`;
}

/**
 * Exact subscription + RG + app short-circuit. Call before any Azure dispatch.
 */
function assertExactStagingScope({ subscriptionId, resourceGroup, containerApp } = {}) {
  const errors = [];
  const sub = trimStr(subscriptionId);
  const rg = trimStr(resourceGroup);
  const app = trimStr(containerApp);

  if (sub !== SUBSCRIPTION_ID) errors.push('wrong_subscription');
  if (!RESOURCE_GROUPS.includes(rg)) errors.push('wrong_resource_group');
  if (!ALLOWED_APPS.includes(app)) errors.push('wrong_app');

  const blob = `${sub}|${rg}|${app}`.toLowerCase();
  for (const marker of PRODUCTION_MARKERS) {
    if (blob.includes(String(marker).toLowerCase())) {
      errors.push('production_marker_rejected');
      break;
    }
  }

  const locked = APP_PLANS[app];
  if (locked && rg && locked.resourceGroup !== rg) {
    errors.push('app_resource_group_mismatch');
  }

  return {
    ok: errors.length === 0,
    errors,
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: RESOURCE_GROUPS.includes(rg) ? rg : null,
    containerApp: ALLOWED_APPS.includes(app) ? app : null,
    locked: locked || null,
  };
}

function assertImmutableFullShaImage({ image, expectedSha, imageRepository } = {}) {
  const errors = [];
  const parsed = parseImage(image);
  if (!parsed.ok) {
    errors.push(parsed.reason || 'image_missing');
    return { ok: false, errors, parsed };
  }
  if (trimStr(imageRepository) && parsed.repository !== trimStr(imageRepository)) {
    errors.push('image_repository_unexpected');
  }
  const tagLower = parsed.tag.toLowerCase();
  if (MUTABLE_TAGS.includes(tagLower) || tagLower.endsWith('-latest')) {
    errors.push('mutable_tag_rejected');
  }
  if (!FULL_SHA_RE.test(parsed.tag)) {
    errors.push('mutable_tag_rejected');
  }
  const sha = trimStr(expectedSha).toLowerCase();
  if (!FULL_SHA_RE.test(sha)) {
    errors.push('target_image_sha_invalid');
  } else if (parsed.tag.toLowerCase() !== sha) {
    errors.push('target_image_sha_mismatch');
  }
  return {
    ok: errors.length === 0,
    errors,
    parsed,
    sha: FULL_SHA_RE.test(sha) ? sha : null,
  };
}

function findRevision(inventory, revisionName) {
  const revs = Array.isArray(inventory && inventory.revisions) ? inventory.revisions : [];
  return revs.find((r) => trimStr(r && r.name) === trimStr(revisionName)) || null;
}

function snapshotTraffic(inventory) {
  const traffic = Array.isArray(inventory && inventory.traffic) ? inventory.traffic : [];
  return traffic.map((t) => ({
    revisionName: trimStr(t && (t.revisionName || t.revision)),
    weight: Number(t && t.weight),
  }));
}

function assertTargetHealthyInInventory({
  inventory,
  containerApp,
  resourceGroup,
  targetRevisionName,
  expectedImage,
  expectedSha,
} = {}) {
  const errors = [];
  const invApp = trimStr(inventory && inventory.containerApp);
  const invRg = trimStr(inventory && inventory.resourceGroup);
  if (invApp && invApp !== trimStr(containerApp)) errors.push('cross_app_revision');
  if (invRg && invRg !== trimStr(resourceGroup)) errors.push('cross_app_revision');

  const rev = findRevision(inventory, targetRevisionName);
  if (!rev) {
    errors.push('target_revision_not_found');
    return { ok: false, errors, revision: null };
  }

  const revApp = trimStr(rev.containerApp || rev.app);
  if (revApp && revApp !== trimStr(containerApp)) errors.push('cross_app_revision');

  const active = rev.active === true
    || String(rev.runningState || '').toLowerCase() === 'running'
    || String(rev.provisioningState || '').toLowerCase() === 'provisioned';
  if (!active) errors.push('target_revision_not_active');

  const health = trimStr(rev.healthState || rev.health).toLowerCase();
  if (health !== 'healthy') errors.push('unhealthy_target');

  const imageCheck = assertImmutableFullShaImage({
    image: rev.image || expectedImage,
    expectedSha,
    imageRepository: APP_PLANS[containerApp] && APP_PLANS[containerApp].imageRepository,
  });
  if (!imageCheck.ok) {
    for (const e of imageCheck.errors) {
      if (!errors.includes(e)) errors.push(e);
    }
  }
  if (expectedImage && trimStr(rev.image) && trimStr(rev.image) !== trimStr(expectedImage)) {
    errors.push('target_image_sha_mismatch');
  }

  return { ok: errors.length === 0, errors, revision: rev, imageCheck };
}

function assertMutationsTrafficOnly(mutations) {
  const errors = [];
  const list = Array.isArray(mutations) ? mutations : [];
  for (const m of list) {
    const kind = trimStr(typeof m === 'string' ? m : m && m.kind).toLowerCase();
    if (!kind) {
      errors.push('extra_mutation');
      continue;
    }
    if (kind !== ALLOWED_MUTATION) {
      if (FORBIDDEN_MUTATIONS.includes(kind) || kind !== ALLOWED_MUTATION) {
        errors.push('extra_mutation');
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function assertTargetTrafficWeights(plannedTraffic, targetRevisionName) {
  const errors = [];
  const traffic = Array.isArray(plannedTraffic) ? plannedTraffic : [];
  if (traffic.length === 0) {
    errors.push('non_100_target_weights');
    return { ok: false, errors };
  }
  let sum = 0;
  let targetWeight = 0;
  for (const t of traffic) {
    const w = Number(t.weight);
    if (!Number.isFinite(w) || w < 0) {
      errors.push('non_100_target_weights');
      continue;
    }
    sum += w;
    if (trimStr(t.revisionName) === trimStr(targetRevisionName)) targetWeight = w;
  }
  if (sum !== 100 || targetWeight !== 100) {
    errors.push('non_100_target_weights');
  }
  return { ok: errors.length === 0, errors, sum, targetWeight };
}

function buildPlannedTraffic({ currentTraffic, currentRevisionName, targetRevisionName } = {}) {
  const names = new Set();
  for (const t of currentTraffic || []) {
    if (trimStr(t.revisionName)) names.add(trimStr(t.revisionName));
  }
  if (trimStr(currentRevisionName)) names.add(trimStr(currentRevisionName));
  if (trimStr(targetRevisionName)) names.add(trimStr(targetRevisionName));

  return [...names].map((revisionName) => ({
    revisionName,
    weight: revisionName === trimStr(targetRevisionName) ? 100 : 0,
  }));
}

function buildRestorePlan({ currentTraffic } = {}) {
  return {
    mode: 'restore_prior_traffic_weights',
    mutation: ALLOWED_MUTATION,
    traffic: (currentTraffic || []).map((t) => ({
      revisionName: trimStr(t.revisionName),
      weight: Number(t.weight),
    })),
    note: 'Repoint ingress traffic weights exactly to the pre-rollback snapshot. No image/env/secret/scaling/DB change.',
  };
}

function buildRollbackRecord(ctx) {
  return {
    schema_version: 1,
    slice: LOCKS.slice,
    outcome_id: LOCKS.outcomeId,
    gate_id: LOCKS.gateId,
    progress_class: LOCKS.progressClass,
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: ctx.resourceGroup,
    containerApp: ctx.containerApp,
    currentRevisionName: ctx.currentRevisionName,
    targetRevisionName: ctx.targetRevisionName,
    targetImage: ctx.targetImage,
    targetImageSha: ctx.targetImageSha,
    trafficSnapshotBefore: ctx.trafficSnapshotBefore,
    plannedTraffic: ctx.plannedTraffic,
    restorePlan: ctx.restorePlan,
    mutation: ALLOWED_MUTATION,
    forbiddenMutations: [...FORBIDDEN_MUTATIONS],
    liveRollbackEnabled: false,
    liveExecuted: false,
    secretFree: true,
    azureCalls: 0,
  };
}

/**
 * Evaluate a hypothetical rollback request. Never mutates Azure.
 * Plans traffic change only after read-only preflight proofs succeed.
 */
function evaluateRollbackRequest(req = {}) {
  const errors = [];

  if (req.liveRollback === true || req.liveExecute === true || req.mode === 'execute') {
    errors.push('live_rollback_hard_disabled');
  }

  const scope = assertExactStagingScope({
    subscriptionId: req.subscriptionId,
    resourceGroup: req.resourceGroup,
    containerApp: req.containerApp,
  });
  if (!scope.ok) errors.push(...scope.errors);

  const currentRevisionName = trimStr(req.currentRevisionName);
  const targetRevisionName = trimStr(req.targetRevisionName);
  if (!currentRevisionName) errors.push('missing_current_revision');
  if (!targetRevisionName) errors.push('missing_target_revision');
  if (currentRevisionName && targetRevisionName && currentRevisionName === targetRevisionName) {
    errors.push('current_equals_target_revision');
  }

  const confirmationToken = trimStr(req.confirmationToken);
  if (!confirmationToken) {
    errors.push('missing_confirmation');
  } else {
    const expected = expectedConfirmationToken({
      containerApp: req.containerApp,
      targetRevisionName,
    });
    if (confirmationToken !== expected) errors.push('missing_confirmation');
  }

  const locked = scope.locked || APP_PLANS[trimStr(req.containerApp)];
  const imageEval = assertImmutableFullShaImage({
    image: req.targetImage,
    expectedSha: req.targetImageSha,
    imageRepository: locked && locked.imageRepository,
  });
  if (!imageEval.ok) errors.push(...imageEval.errors);

  const mut = assertMutationsTrafficOnly(req.mutations);
  if (!mut.ok) errors.push(...mut.errors);

  const inventory = req.inventory || null;
  let trafficSnapshotBefore = [];
  let plannedTraffic = [];
  let restorePlan = null;
  let targetHealth = null;

  if (!inventory) {
    errors.push('failed_verification');
  } else {
    trafficSnapshotBefore = snapshotTraffic(inventory);
    targetHealth = assertTargetHealthyInInventory({
      inventory,
      containerApp: req.containerApp,
      resourceGroup: req.resourceGroup,
      targetRevisionName,
      expectedImage: req.targetImage,
      expectedSha: req.targetImageSha,
    });
    if (!targetHealth.ok) errors.push(...targetHealth.errors);

    const currentRev = findRevision(inventory, currentRevisionName);
    if (currentRevisionName && !currentRev) {
      errors.push('failed_verification');
    }

    plannedTraffic = Array.isArray(req.plannedTraffic) && req.plannedTraffic.length
      ? req.plannedTraffic.map((t) => ({
        revisionName: trimStr(t.revisionName),
        weight: Number(t.weight),
      }))
      : buildPlannedTraffic({
        currentTraffic: trafficSnapshotBefore,
        currentRevisionName,
        targetRevisionName,
      });

    const weights = assertTargetTrafficWeights(plannedTraffic, targetRevisionName);
    if (!weights.ok) errors.push(...weights.errors);

    restorePlan = buildRestorePlan({ currentTraffic: trafficSnapshotBefore });

    // Post-plan verification: planned traffic must reference known revisions only.
    const known = new Set(
      (Array.isArray(inventory.revisions) ? inventory.revisions : [])
        .map((r) => trimStr(r && r.name))
        .filter(Boolean),
    );
    for (const t of plannedTraffic) {
      if (known.size && t.revisionName && !known.has(t.revisionName)) {
        errors.push('failed_verification');
        break;
      }
    }
  }

  const uniqueErrors = [...new Set(errors)];
  const ok = uniqueErrors.length === 0;

  let record = null;
  if (ok) {
    record = buildRollbackRecord({
      resourceGroup: scope.resourceGroup || trimStr(req.resourceGroup),
      containerApp: scope.containerApp || trimStr(req.containerApp),
      currentRevisionName,
      targetRevisionName,
      targetImage: trimStr(req.targetImage),
      targetImageSha: trimStr(req.targetImageSha).toLowerCase(),
      trafficSnapshotBefore,
      plannedTraffic,
      restorePlan,
    });
  }

  return {
    ok,
    errors: uniqueErrors,
    scope,
    trafficSnapshotBefore,
    plannedTraffic: ok ? plannedTraffic : null,
    restorePlan: ok ? restorePlan : null,
    record,
    liveRollbackEnabled: false,
    azureCalls: 0,
  };
}

function syntheticInventoryForApp(appKey, {
  currentRevisionName,
  targetRevisionName,
  targetImage,
  currentWeight = 100,
} = {}) {
  const plan = APP_PLANS[appKey];
  return {
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: plan.resourceGroup,
    containerApp: plan.containerApp,
    revisions: [
      {
        name: currentRevisionName,
        containerApp: plan.containerApp,
        active: true,
        runningState: 'Running',
        healthState: 'Healthy',
        image: `${plan.imageRepository}:${'b'.repeat(40)}`,
      },
      {
        name: targetRevisionName,
        containerApp: plan.containerApp,
        active: true,
        runningState: 'Running',
        healthState: 'Healthy',
        image: targetImage,
      },
    ],
    traffic: [
      { revisionName: currentRevisionName, weight: currentWeight },
      { revisionName: targetRevisionName, weight: 100 - currentWeight },
    ],
  };
}

function buildSecretFreePlans() {
  const shaWh = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const shaSun = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const apps = ALLOWED_APPS.map((appKey) => {
    const plan = APP_PLANS[appKey];
    const sha = appKey.startsWith('wh-') ? shaWh : shaSun;
    const currentRevisionName = `${plan.containerApp}--rev-current`;
    const targetRevisionName = `${plan.containerApp}--rev-target`;
    const targetImage = `${plan.imageRepository}:${sha}`;
    return {
      resourceGroup: plan.resourceGroup,
      containerApp: plan.containerApp,
      imageRepository: plan.imageRepository,
      currentRevisionName,
      targetRevisionName,
      targetImage,
      targetImageSha: sha,
      confirmationToken: expectedConfirmationToken({
        containerApp: plan.containerApp,
        targetRevisionName,
      }),
      mutations: [{ kind: ALLOWED_MUTATION }],
      inventory: syntheticInventoryForApp(appKey, {
        currentRevisionName,
        targetRevisionName,
        targetImage,
        currentWeight: 100,
      }),
    };
  });

  return {
    schema_version: 1,
    slice: LOCKS.slice,
    outcome_id: LOCKS.outcomeId,
    gate_id: LOCKS.gateId,
    progress_class: LOCKS.progressClass,
    master_basis: LOCKS.masterBasis,
    branch: LOCKS.branch,
    subscriptionId: SUBSCRIPTION_ID,
    liveRollbackEnabled: false,
    liveExecuteEnabled: false,
    allowedMutation: ALLOWED_MUTATION,
    forbiddenMutations: [...FORBIDDEN_MUTATIONS],
    open_drill: LOCKS.openDrillId,
    apps,
    zero_live_mutation: true,
  };
}

function baseGreenRequest(appKey) {
  const plans = buildSecretFreePlans();
  const app = plans.apps.find((a) => a.containerApp === appKey);
  return {
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: app.resourceGroup,
    containerApp: app.containerApp,
    currentRevisionName: app.currentRevisionName,
    targetRevisionName: app.targetRevisionName,
    targetImage: app.targetImage,
    targetImageSha: app.targetImageSha,
    confirmationToken: app.confirmationToken,
    mutations: [{ kind: ALLOWED_MUTATION }],
    inventory: app.inventory,
    mode: 'plan',
  };
}

function runRedCases() {
  const cases = [];
  function red(name, req, expectError) {
    const result = evaluateRollbackRequest(req);
    const hit = result.errors.includes(expectError);
    cases.push({
      name,
      expect: 'RED',
      ok: result.ok === false && hit,
      expectError,
      errors: result.errors,
    });
  }

  const base = baseGreenRequest('wh-staging-staff-api');

  red('wrong_subscription', {
    ...base,
    subscriptionId: '00000000-0000-0000-0000-000000000000',
  }, 'wrong_subscription');

  red('wrong_resource_group', {
    ...base,
    resourceGroup: 'other-staging-rg',
  }, 'wrong_resource_group');

  red('wrong_app', {
    ...base,
    containerApp: 'wh-staging-hermes',
  }, 'wrong_app');

  red('production_marker', {
    ...base,
    resourceGroup: 'wh-prod-rg',
    containerApp: 'wh-staging-staff-api',
  }, 'wrong_resource_group');

  red('production_marker_app', {
    ...base,
    containerApp: 'wh-prod-staff-api',
  }, 'wrong_app');

  red('mutable_tag', {
    ...base,
    targetImage: `${APP_PLANS['wh-staging-staff-api'].imageRepository}:latest`,
    targetImageSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }, 'mutable_tag_rejected');

  red('cross_app_revision', {
    ...base,
    inventory: {
      ...base.inventory,
      revisions: base.inventory.revisions.map((r) => (
        r.name === base.targetRevisionName
          ? { ...r, containerApp: 'luna-sunset-staging-staff-api' }
          : r
      )),
    },
  }, 'cross_app_revision');

  red('unhealthy_target', {
    ...base,
    inventory: {
      ...base.inventory,
      revisions: base.inventory.revisions.map((r) => (
        r.name === base.targetRevisionName
          ? { ...r, healthState: 'Unhealthy' }
          : r
      )),
    },
  }, 'unhealthy_target');

  red('missing_confirmation', {
    ...base,
    confirmationToken: '',
  }, 'missing_confirmation');

  red('extra_mutation', {
    ...base,
    mutations: [{ kind: 'traffic_weight' }, { kind: 'image' }],
  }, 'extra_mutation');

  red('non_100_target_weights', {
    ...base,
    plannedTraffic: [
      { revisionName: base.targetRevisionName, weight: 50 },
      { revisionName: base.currentRevisionName, weight: 50 },
    ],
  }, 'non_100_target_weights');

  red('failed_verification', {
    ...base,
    inventory: null,
  }, 'failed_verification');

  red('live_rollback_rejected', {
    ...base,
    liveRollback: true,
  }, 'live_rollback_hard_disabled');

  return cases;
}

function runGreenCases() {
  const cases = [];
  for (const appKey of ALLOWED_APPS) {
    const req = baseGreenRequest(appKey);
    const result = evaluateRollbackRequest(req);
    const recordOk = result.ok
      && result.record
      && result.record.secretFree === true
      && result.record.mutation === ALLOWED_MUTATION
      && result.record.liveExecuted === false
      && result.restorePlan
      && Array.isArray(result.plannedTraffic)
      && result.plannedTraffic.some((t) => t.revisionName === req.targetRevisionName && t.weight === 100);
    cases.push({
      name: `green_plan_${appKey}`,
      expect: 'GREEN',
      ok: recordOk === true && result.errors.length === 0,
      errors: result.errors,
      record: result.record,
      restorePlan: result.restorePlan,
    });
  }
  return cases;
}

module.exports = {
  LOCKS,
  SUBSCRIPTION_ID,
  RESOURCE_GROUPS,
  ALLOWED_APPS,
  APP_PLANS,
  ALLOWED_MUTATION,
  FORBIDDEN_MUTATIONS,
  FULL_SHA_RE,
  expectedConfirmationToken,
  assertExactStagingScope,
  assertImmutableFullShaImage,
  assertTargetHealthyInInventory,
  assertMutationsTrafficOnly,
  assertTargetTrafficWeights,
  evaluateRollbackRequest,
  buildSecretFreePlans,
  buildPlannedTraffic,
  buildRestorePlan,
  buildRollbackRecord,
  syntheticInventoryForApp,
  baseGreenRequest,
  runRedCases,
  runGreenCases,
};
