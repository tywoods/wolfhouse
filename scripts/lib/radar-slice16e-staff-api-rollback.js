'use strict';

/**
 * radar-slice16e-staff-api-rollback — RADAR Slice 16E
 *
 * Fail-closed, staging-only Azure Container Apps Staff API traffic-weight
 * rollback plan + preflight. Offline-first. Live rollback hard-disabled.
 * Never mutates image/env/secrets/scaling/DB/restart/delete — traffic only.
 *
 * Also exposes a strict read-only live inventory capture path (exact argv,
 * injectable runner, no shell) and a traffic-set argv builder (no executor)
 * for eventual operator use. This slice never executes capture or mutation.
 */

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const MUTABLE_TAGS = Object.freeze(['latest', 'staging', 'prod', 'dev', 'main', 'master']);

/** Tokens allowed in az argv (no shell metacharacters / expansion). */
const SAFE_AZ_TOKEN_RE = /^[A-Za-z0-9._:\/@+=-]+$/;
const SAFE_REVISION_NAME_RE = /^[A-Za-z0-9._-]+$/;
const REVISION_WEIGHT_PAIR_RE = /^[A-Za-z0-9._-]+=\d+$/;
const SHELL_METACHAR_RE = /[;&|<>$`\\*!?({\[\s'"\n\r]/;
const ARGV_EXPANSION_RE = /\$\(|\$\{|`/;

/** Full ARM id for a Container App (Azure-returned identity only). */
const CONTAINER_APP_ARM_RE = new RegExp(
  String.raw`^/subscriptions/([^/]+)/resourceGroups/([^/]+)`
  + String.raw`/providers/Microsoft\.App/containerApps/([^/]+)$`,
  'i',
);
/** Full ARM id for a revision — parent must be the exact app ARM id. */
const REVISION_ARM_RE = new RegExp(
  String.raw`^/subscriptions/([^/]+)/resourceGroups/([^/]+)`
  + String.raw`/providers/Microsoft\.App/containerApps/([^/]+)/revisions/([^/]+)$`,
  'i',
);

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

const CAPTURE_STEP_IDS = Object.freeze([
  'account_show',
  'containerapp_show',
  'revision_list',
  'ingress_traffic_show',
]);

const MUTATION_AZ_VERBS = Object.freeze([
  'set', 'create', 'update', 'delete', 'restart', 'deploy', 'apply',
  'revision activate', 'revision deactivate', 'revision copy',
  'up', 'exec', 'logs',
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
  liveCaptureExecuteEnabled: false,
  confirmationPrefix: 'I-CONFIRM-TRAFFIC-ROLLBACK',
  planFixtureRel: 'fixtures/radar-operations/slice16e-rollback-plans.json',
  contractFixtureRel: 'fixtures/radar-operations/slice16e-expected-contract.json',
  runbookRel: 'docs/RADAR-16E-STAFF-API-ROLLBACK-RUNBOOK.md',
  openDrillId: '16E_DRILL_live_rollback_restore',
  requiredHealthState: 'Healthy',
  requiredRunningState: 'Running',
  requiredProvisioningState: 'Provisioned',
});

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function buildContainerAppArmId({ subscriptionId, resourceGroup, containerApp } = {}) {
  return (
    `/subscriptions/${trimStr(subscriptionId)}`
    + `/resourceGroups/${trimStr(resourceGroup)}`
    + `/providers/Microsoft.App/containerApps/${trimStr(containerApp)}`
  );
}

function buildRevisionArmId({
  subscriptionId, resourceGroup, containerApp, revisionName,
} = {}) {
  return (
    `${buildContainerAppArmId({ subscriptionId, resourceGroup, containerApp })}`
    + `/revisions/${trimStr(revisionName)}`
  );
}

function parseContainerAppArmId(id) {
  const raw = trimStr(id);
  const m = CONTAINER_APP_ARM_RE.exec(raw);
  if (!m) return { ok: false, errors: ['invalid_app_arm_id'] };
  return {
    ok: true,
    errors: [],
    id: raw,
    subscriptionId: m[1],
    resourceGroup: m[2],
    containerApp: m[3],
  };
}

function parseRevisionArmId(id) {
  const raw = trimStr(id);
  const m = REVISION_ARM_RE.exec(raw);
  if (!m) return { ok: false, errors: ['invalid_revision_arm_id'] };
  const parentAppId = buildContainerAppArmId({
    subscriptionId: m[1],
    resourceGroup: m[2],
    containerApp: m[3],
  });
  return {
    ok: true,
    errors: [],
    id: raw,
    subscriptionId: m[1],
    resourceGroup: m[2],
    containerApp: m[3],
    revisionName: m[4],
    parentAppId,
  };
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

function tokenHasShellMetachar(token) {
  const s = String(token == null ? '' : token);
  return SHELL_METACHAR_RE.test(s) || !SAFE_AZ_TOKEN_RE.test(s);
}

function tokenHasArgvExpansion(token) {
  return ARGV_EXPANSION_RE.test(String(token == null ? '' : token));
}

function assertSafeArgvTokens(argv) {
  const errors = [];
  if (!Array.isArray(argv) || argv.length === 0) {
    errors.push('malformed_argv');
    return { ok: false, errors };
  }
  for (const t of argv) {
    if (typeof t !== 'string' || t === '') {
      errors.push('malformed_argv');
      continue;
    }
    if (tokenHasArgvExpansion(t)) errors.push('argv_expansion_rejected');
    if (tokenHasShellMetachar(t)) errors.push('shell_metacharacter_rejected');
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

function assertArgvReadOnlyCapture(argv) {
  const errors = [];
  const joined = (Array.isArray(argv) ? argv : []).join(' ').toLowerCase();
  if (!Array.isArray(argv) || argv[0] !== 'az') {
    errors.push('capture_argv_not_az');
  }
  for (const verb of MUTATION_AZ_VERBS) {
    if (joined.includes(verb)) {
      errors.push('capture_mutation_argv_rejected');
      break;
    }
  }
  const allowShowList = /\b(show|list)\b/.test(joined);
  if (!allowShowList) errors.push('capture_argv_not_get_list_show');
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
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

/**
 * Strict traffic snapshot validation.
 * Each entry must have a concrete revisionName (unique), finite nonnegative weight,
 * and total weight === 100.
 * Mutation is traffic weights only — any label or latestRevision semantics is
 * unsupported_traffic_snapshot (refuse rather than claim exact restore).
 */
function assertStrictTrafficSnapshot(traffic) {
  const errors = [];
  if (!Array.isArray(traffic)) {
    errors.push('malformed_traffic');
    return { ok: false, errors, traffic: null };
  }
  if (traffic.length === 0) {
    errors.push('malformed_traffic');
    return { ok: false, errors, traffic: null };
  }

  const normalized = [];
  const seen = new Set();
  let sum = 0;

  for (const t of traffic) {
    if (!t || typeof t !== 'object') {
      errors.push('malformed_traffic');
      continue;
    }
    const revisionName = trimStr(t.revisionName);
    const hasLatest = t.latestRevision === true;
    const label = trimStr(t.label || t.revisionLabel);
    const weightRaw = t.weight;

    // Traffic-weight mutation cannot restore label/latest semantics exactly.
    if (hasLatest || label) {
      errors.push('unsupported_traffic_snapshot');
      continue;
    }
    if (!revisionName) {
      errors.push('malformed_traffic');
      continue;
    }
    if (!SAFE_REVISION_NAME_RE.test(revisionName)) {
      errors.push('shell_metacharacter_rejected');
      continue;
    }
    if (seen.has(revisionName)) {
      errors.push('duplicate_traffic_revision');
      continue;
    }
    seen.add(revisionName);

    const weight = Number(weightRaw);
    if (!Number.isFinite(weight) || weight < 0) {
      errors.push('non_finite_traffic_weight');
      continue;
    }
    sum += weight;
    normalized.push({ revisionName, weight });
  }

  if (errors.length === 0 && sum !== 100) {
    errors.push('non_100_traffic_weights');
  }

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    traffic: errors.length === 0 ? normalized : null,
    sum,
  };
}

function snapshotTraffic(inventory) {
  const check = assertStrictTrafficSnapshot(inventory && inventory.traffic);
  if (!check.ok) return { ok: false, errors: check.errors, traffic: null };
  return { ok: true, errors: [], traffic: check.traffic };
}

/**
 * Inventory identity must be proven from Azure-returned full ARM IDs/names —
 * never synthesized from requested inputs. Requires app id/name/RG/sub and each
 * revision full id whose parent is the exact app ARM id. Refuse missing fields.
 */
function assertInventoryIdentity(inventory, {
  subscriptionId,
  resourceGroup,
  containerApp,
} = {}) {
  const errors = [];
  if (!inventory || typeof inventory !== 'object') {
    errors.push('failed_verification');
    return { ok: false, errors };
  }

  if (inventory.subscriptionId == null || trimStr(inventory.subscriptionId) === '') {
    errors.push('missing_inventory_subscription');
  } else if (trimStr(inventory.subscriptionId) !== trimStr(subscriptionId)) {
    errors.push('inventory_subscription_mismatch');
  }

  if (inventory.resourceGroup == null || trimStr(inventory.resourceGroup) === '') {
    errors.push('missing_inventory_resource_group');
  } else if (trimStr(inventory.resourceGroup) !== trimStr(resourceGroup)) {
    errors.push('inventory_resource_group_mismatch');
  }

  if (inventory.containerApp == null || trimStr(inventory.containerApp) === '') {
    errors.push('missing_inventory_container_app');
  } else if (trimStr(inventory.containerApp) !== trimStr(containerApp)) {
    errors.push('inventory_container_app_mismatch');
  }

  const appName = trimStr(inventory.containerApp);
  if (inventory.appName == null || trimStr(inventory.appName) === '') {
    errors.push('app_name_absent');
  } else if (trimStr(inventory.appName) !== appName && appName) {
    errors.push('app_name_absent');
  }

  const appId = trimStr(inventory.appId);
  if (!appId) {
    errors.push('missing_app_arm_id');
  } else {
    const parsedApp = parseContainerAppArmId(appId);
    if (!parsedApp.ok) {
      errors.push('spoofed_app_arm_id');
    } else {
      if (trimStr(inventory.subscriptionId)
        && parsedApp.subscriptionId !== trimStr(inventory.subscriptionId)) {
        errors.push('mismatched_app_arm_id');
      }
      if (trimStr(inventory.resourceGroup)
        && parsedApp.resourceGroup !== trimStr(inventory.resourceGroup)) {
        errors.push('mismatched_app_arm_id');
      }
      if (trimStr(inventory.containerApp)
        && parsedApp.containerApp !== trimStr(inventory.containerApp)) {
        errors.push('mismatched_app_arm_id');
      }
      if (trimStr(subscriptionId)
        && parsedApp.subscriptionId.toLowerCase() !== trimStr(subscriptionId).toLowerCase()) {
        errors.push('mismatched_app_arm_id');
      }
      if (trimStr(resourceGroup)
        && parsedApp.resourceGroup.toLowerCase() !== trimStr(resourceGroup).toLowerCase()) {
        errors.push('mismatched_app_arm_id');
      }
      if (trimStr(containerApp)
        && parsedApp.containerApp !== trimStr(containerApp)) {
        errors.push('mismatched_app_arm_id');
      }

      const revs = Array.isArray(inventory.revisions) ? inventory.revisions : [];
      for (const rev of revs) {
        const revId = trimStr(rev && rev.id);
        if (!revId) {
          errors.push('missing_revision_arm_id');
          continue;
        }
        const parsedRev = parseRevisionArmId(revId);
        if (!parsedRev.ok) {
          errors.push('spoofed_revision_arm_id');
          continue;
        }
        if (parsedRev.parentAppId.toLowerCase() !== parsedApp.id.toLowerCase()) {
          errors.push('mismatched_revision_arm_id');
          continue;
        }
        if (trimStr(rev.name) && parsedRev.revisionName !== trimStr(rev.name)) {
          errors.push('mismatched_revision_arm_id');
        }
        // Ownership must come from ARM parent — never from requested inputs alone.
        if (rev.containerApp == null || trimStr(rev.containerApp) === '') {
          errors.push('missing_target_ownership');
        } else if (trimStr(rev.containerApp) !== parsedRev.containerApp) {
          errors.push('cross_app_revision');
        }
      }
    }
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

/**
 * Target revision proofs — no OR/fallback. Requires active===true and exact
 * Healthy / Running / Provisioned, mandatory image equal to supplied full SHA,
 * and ownership proven from revision full ARM id parent === exact app
 * (never synthesized from requested inputs alone).
 */
function assertTargetHealthyInInventory({
  inventory,
  containerApp,
  resourceGroup,
  targetRevisionName,
  expectedImage,
  expectedSha,
} = {}) {
  const errors = [];
  void resourceGroup;

  const rev = findRevision(inventory, targetRevisionName);
  if (!rev) {
    errors.push('target_revision_not_found');
    return { ok: false, errors, revision: null };
  }

  const appId = trimStr(inventory && inventory.appId)
    || buildContainerAppArmId({
      subscriptionId: trimStr(inventory && inventory.subscriptionId),
      resourceGroup: trimStr(inventory && inventory.resourceGroup),
      containerApp: trimStr(containerApp),
    });

  const revId = trimStr(rev.id);
  if (!revId) {
    errors.push('missing_revision_arm_id');
  } else {
    const parsedRev = parseRevisionArmId(revId);
    if (!parsedRev.ok) {
      errors.push('spoofed_revision_arm_id');
    } else if (parsedRev.parentAppId.toLowerCase() !== appId.toLowerCase()) {
      errors.push('mismatched_revision_arm_id');
    } else if (parsedRev.containerApp !== trimStr(containerApp)) {
      errors.push('cross_app_revision');
    } else if (parsedRev.revisionName !== trimStr(targetRevisionName)) {
      errors.push('mismatched_revision_arm_id');
    }
  }

  if (rev.containerApp == null || trimStr(rev.containerApp) === '') {
    errors.push('missing_target_ownership');
  } else if (trimStr(rev.containerApp) !== trimStr(containerApp)) {
    errors.push('cross_app_revision');
  }

  if (rev.active !== true) errors.push('target_not_active');

  if (trimStr(rev.healthState) !== LOCKS.requiredHealthState) {
    errors.push('unhealthy_target');
  }
  if (trimStr(rev.runningState) !== LOCKS.requiredRunningState) {
    errors.push('target_not_running');
  }
  if (trimStr(rev.provisioningState) !== LOCKS.requiredProvisioningState) {
    errors.push('target_not_provisioned');
  }

  if (rev.image == null || trimStr(rev.image) === '') {
    errors.push('missing_target_image');
  } else {
    const imageCheck = assertImmutableFullShaImage({
      image: rev.image,
      expectedSha,
      imageRepository: APP_PLANS[containerApp] && APP_PLANS[containerApp].imageRepository,
    });
    if (!imageCheck.ok) {
      for (const e of imageCheck.errors) {
        if (!errors.includes(e)) errors.push(e);
      }
    }
    if (expectedImage != null && trimStr(expectedImage) !== ''
      && trimStr(rev.image) !== trimStr(expectedImage)) {
      errors.push('target_image_sha_mismatch');
    }
  }

  return { ok: errors.length === 0, errors, revision: rev };
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
      errors.push('extra_mutation');
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
  const seen = new Set();
  for (const t of traffic) {
    const name = trimStr(t.revisionName);
    if (!name) {
      errors.push('malformed_traffic');
      continue;
    }
    if (seen.has(name)) {
      errors.push('duplicate_traffic_revision');
      continue;
    }
    seen.add(name);
    const w = Number(t.weight);
    if (!Number.isFinite(w) || w < 0) {
      errors.push('non_100_target_weights');
      continue;
    }
    sum += w;
    if (name === trimStr(targetRevisionName)) targetWeight = w;
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
    note: 'Repoint ingress traffic weights exactly to the pre-rollback snapshot. No image/env/secret/scaling/DB change. Label/latestRevision snapshots are refused upstream.',
  };
}

/**
 * Count --revision-weight occurrences and collect following pairs until next flag.
 */
function extractRevisionWeightPairs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const indices = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--revision-weight') indices.push(i);
  }
  if (indices.length === 0) {
    return { count: 0, pairs: [], errors: ['omitted_revision_weight_pair'] };
  }
  if (indices.length > 1) {
    return { count: indices.length, pairs: [], errors: ['repeated_revision_weight_option'] };
  }
  const start = indices[0] + 1;
  const pairs = [];
  for (let i = start; i < args.length; i += 1) {
    const tok = args[i];
    if (typeof tok !== 'string' || tok.startsWith('-')) break;
    pairs.push(tok);
  }
  return { count: 1, pairs, errors: [] };
}

/**
 * Independent argv contract for Azure CLI 2.88 traffic set:
 * exactly one --revision-weight followed by the complete ordered revision=weight
 * pair set; --subscription pinned; full argv compared.
 */
function assertTrafficSetArgvContract(argv, {
  subscriptionId,
  resourceGroup,
  containerApp,
  expectedPairs,
} = {}) {
  const errors = [];
  if (!Array.isArray(argv) || argv.length === 0) {
    return { ok: false, errors: ['malformed_argv'], expected: null };
  }

  const extracted = extractRevisionWeightPairs(argv);
  if (extracted.errors.length) {
    errors.push(...extracted.errors);
  }

  const wantPairs = Array.isArray(expectedPairs) ? expectedPairs.map(String) : [];
  if (extracted.errors.length === 0) {
    if (extracted.pairs.length !== wantPairs.length) {
      errors.push('omitted_revision_weight_pair');
    } else {
      for (let i = 0; i < wantPairs.length; i += 1) {
        if (extracted.pairs[i] !== wantPairs[i]) {
          errors.push('omitted_revision_weight_pair');
          break;
        }
      }
    }
  }

  const subIdx = argv.indexOf('--subscription');
  if (subIdx < 0 || argv[subIdx + 1] !== trimStr(subscriptionId)) {
    errors.push('subscription_context_race_shape');
  }

  const expected = [
    'az', 'containerapp', 'ingress', 'traffic', 'set',
    '-g', trimStr(resourceGroup),
    '-n', trimStr(containerApp),
    '--subscription', trimStr(subscriptionId),
    '--revision-weight',
    ...wantPairs,
  ];

  if (argv.length !== expected.length
    || expected.some((tok, i) => argv[i] !== tok)) {
    // Full argv drift — classify by dominant symptom when not already tagged.
    if (!errors.includes('subscription_context_race_shape')
      && !argv.includes('--subscription')) {
      errors.push('subscription_context_race_shape');
    }
    if (!errors.length) errors.push('malformed_argv');
  }

  return {
    ok: errors.length === 0 && argv.join('\0') === expected.join('\0'),
    errors: [...new Set(errors)],
    expected,
    extractedPairs: extracted.pairs,
  };
}

/**
 * Structured traffic-set argv for rollback/restore only. Fixed tokens.
 * Azure CLI 2.88: exactly one --revision-weight followed by all pairs.
 * Pins --subscription. No shell, no metachar expansion, no executor.
 */
function buildTrafficSetArgv({
  subscriptionId,
  resourceGroup,
  containerApp,
  traffic,
  mode,
} = {}) {
  const errors = [];
  const m = trimStr(mode);
  if (m !== 'rollback' && m !== 'restore') {
    errors.push('traffic_set_mode_invalid');
  }
  const sub = trimStr(subscriptionId) || SUBSCRIPTION_ID;
  const rg = trimStr(resourceGroup);
  const app = trimStr(containerApp);
  if (sub !== SUBSCRIPTION_ID) errors.push('wrong_subscription');
  if (!RESOURCE_GROUPS.includes(rg)) errors.push('wrong_resource_group');
  if (!ALLOWED_APPS.includes(app)) errors.push('wrong_app');

  const trafficCheck = assertStrictTrafficSnapshot(traffic);
  if (!trafficCheck.ok) errors.push(...trafficCheck.errors);

  if (errors.length) {
    return { ok: false, errors: [...new Set(errors)], argv: null, executed: false };
  }

  const pairs = [];
  for (const t of trafficCheck.traffic) {
    const pair = `${t.revisionName}=${Math.trunc(t.weight)}`;
    if (!REVISION_WEIGHT_PAIR_RE.test(pair)) {
      return {
        ok: false,
        errors: ['shell_metacharacter_rejected'],
        argv: null,
        executed: false,
      };
    }
    pairs.push(pair);
  }

  const argv = [
    'az',
    'containerapp',
    'ingress',
    'traffic',
    'set',
    '-g',
    rg,
    '-n',
    app,
    '--subscription',
    sub,
    '--revision-weight',
    ...pairs,
  ];

  const safe = assertSafeArgvTokens(argv);
  if (!safe.ok) {
    return { ok: false, errors: safe.errors, argv: null, executed: false };
  }

  const contract = assertTrafficSetArgvContract(argv, {
    subscriptionId: sub,
    resourceGroup: rg,
    containerApp: app,
    expectedPairs: pairs,
  });
  if (!contract.ok) {
    return { ok: false, errors: contract.errors, argv: null, executed: false };
  }

  return {
    ok: true,
    errors: [],
    argv,
    mode: m,
    executed: false,
    note: 'Argv builder only — caller must not execute in RADAR 16E',
  };
}

/**
 * Exact read-only capture argv plan for account/app/revision/traffic GET/list/show.
 * Pins --subscription on every app/revision/traffic resource argv (no ambient
 * subscription-context race).
 */
function buildLiveCaptureArgvPlan({
  subscriptionId,
  resourceGroup,
  containerApp,
} = {}) {
  const errors = [];
  const sub = trimStr(subscriptionId) || SUBSCRIPTION_ID;
  const rg = trimStr(resourceGroup);
  const app = trimStr(containerApp);
  if (sub !== SUBSCRIPTION_ID) errors.push('wrong_subscription');
  if (!RESOURCE_GROUPS.includes(rg)) errors.push('wrong_resource_group');
  if (!ALLOWED_APPS.includes(app)) errors.push('wrong_app');
  if (tokenHasShellMetachar(rg) || tokenHasArgvExpansion(rg)) {
    errors.push('shell_metacharacter_rejected');
  }
  if (tokenHasShellMetachar(app) || tokenHasArgvExpansion(app)) {
    errors.push('shell_metacharacter_rejected');
  }
  if (errors.length) {
    return { ok: false, errors: [...new Set(errors)], steps: null };
  }

  const steps = [
    {
      id: 'account_show',
      argv: Object.freeze(['az', 'account', 'show', '-o', 'json']),
    },
    {
      id: 'containerapp_show',
      argv: Object.freeze([
        'az', 'containerapp', 'show',
        '-g', rg, '-n', app,
        '--subscription', sub,
        '-o', 'json',
      ]),
    },
    {
      id: 'revision_list',
      argv: Object.freeze([
        'az', 'containerapp', 'revision', 'list',
        '-g', rg, '-n', app,
        '--subscription', sub,
        '-o', 'json',
      ]),
    },
    {
      id: 'ingress_traffic_show',
      argv: Object.freeze([
        'az', 'containerapp', 'ingress', 'traffic', 'show',
        '-g', rg, '-n', app,
        '--subscription', sub,
        '-o', 'json',
      ]),
    },
  ];

  for (const step of steps) {
    const safe = assertSafeArgvTokens(step.argv);
    if (!safe.ok) {
      return { ok: false, errors: safe.errors, steps: null };
    }
    const ro = assertArgvReadOnlyCapture(step.argv);
    if (!ro.ok) {
      return { ok: false, errors: ro.errors, steps: null };
    }
    if (step.id !== 'account_show') {
      const subIdx = step.argv.indexOf('--subscription');
      if (subIdx < 0 || step.argv[subIdx + 1] !== sub) {
        return {
          ok: false,
          errors: ['subscription_context_race_shape'],
          steps: null,
        };
      }
    }
  }

  return {
    ok: true,
    errors: [],
    steps: Object.freeze(steps.map((s) => Object.freeze({ id: s.id, argv: s.argv }))),
    shell: false,
    mutationExecution: false,
  };
}

/**
 * Independently compare a capture step argv against the exact expected plan.
 * Detects subscription-context race (resource argv missing --subscription pin).
 */
function assertCaptureResourceArgvExact(argv, expectedArgv) {
  const errors = [];
  if (!Array.isArray(argv) || !Array.isArray(expectedArgv)) {
    return { ok: false, errors: ['malformed_argv'] };
  }
  if (argv.join('\0') !== expectedArgv.join('\0')) {
    const isResource = argv.includes('containerapp') && !argv.includes('account');
    if (isResource && !argv.includes('--subscription')) {
      errors.push('subscription_context_race_shape');
    } else if (isResource) {
      const subIdx = argv.indexOf('--subscription');
      const expIdx = expectedArgv.indexOf('--subscription');
      if (subIdx < 0 || expIdx < 0 || argv[subIdx + 1] !== expectedArgv[expIdx + 1]) {
        errors.push('subscription_context_race_shape');
      } else {
        errors.push('malformed_argv');
      }
    } else {
      errors.push('malformed_argv');
    }
  }
  return { ok: errors.length === 0, errors };
}

function parseJsonStdout(stdout, label) {
  const s = String(stdout == null ? '' : stdout).replace(/^\uFEFF/, '').trim();
  const iObj = s.indexOf('{');
  const iArr = s.indexOf('[');
  let i = -1;
  if (iObj >= 0 && iArr >= 0) i = Math.min(iObj, iArr);
  else i = Math.max(iObj, iArr);
  if (i < 0) {
    throw Object.assign(new Error(`no JSON from ${label}`), { code: 'capture_parse_failed' });
  }
  return JSON.parse(s.slice(i));
}

/**
 * Map a revision from Azure JSON. Ownership/name/id come ONLY from the Azure
 * returned full ARM id — never from requested containerApp inputs.
 */
function mapRevisionFromAz(rev) {
  const props = (rev && rev.properties) || rev || {};
  const template = props.template || {};
  const containers = Array.isArray(template.containers) ? template.containers : [];
  const image = containers[0] && containers[0].image
    ? String(containers[0].image)
    : (rev && rev.image != null ? String(rev.image) : '');
  const id = trimStr(rev && rev.id);
  const parsed = parseRevisionArmId(id);
  if (!parsed.ok) {
    return {
      ok: false,
      errors: id ? ['spoofed_revision_arm_id'] : ['missing_revision_arm_id'],
      revision: null,
    };
  }
  const nameFromBody = trimStr(rev && (rev.name || props.name));
  if (nameFromBody && nameFromBody !== parsed.revisionName) {
    return {
      ok: false,
      errors: ['mismatched_revision_arm_id'],
      revision: null,
    };
  }
  return {
    ok: true,
    errors: [],
    revision: {
      id: parsed.id,
      name: parsed.revisionName,
      containerApp: parsed.containerApp,
      active: props.active === true || rev.active === true,
      runningState: trimStr(props.runningState || rev.runningState),
      healthState: trimStr(props.healthState || rev.healthState),
      provisioningState: trimStr(props.provisioningState || rev.provisioningState),
      image,
    },
  };
}

function mapTrafficFromAz(trafficRaw) {
  const list = Array.isArray(trafficRaw)
    ? trafficRaw
    : (trafficRaw && Array.isArray(trafficRaw.traffic) ? trafficRaw.traffic : null);
  if (!list) return null;
  return list.map((t) => {
    const entry = {
      revisionName: trimStr(t && (t.revisionName || t.revision)),
      weight: Number(t && t.weight),
    };
    if (t && t.latestRevision === true) entry.latestRevision = true;
    if (t && (t.label || t.revisionLabel)) {
      entry.label = trimStr(t.label || t.revisionLabel);
    }
    return entry;
  });
}

/**
 * Prove inventory identity solely from Azure-returned full ARM IDs/names.
 * Requires app id + name + RG/sub (from ARM) and each revision full id whose
 * parent is the exact app. Never synthesizes from requested inputs.
 */
function proveAzureInventoryIdentity({
  accountBody,
  appBody,
  revisionList,
  requested,
} = {}) {
  const errors = [];
  const accountSub = trimStr(
    accountBody && (accountBody.id || accountBody.subscriptionId),
  );
  if (!accountSub) {
    errors.push('missing_inventory_subscription');
  } else if (accountSub !== SUBSCRIPTION_ID) {
    errors.push('inventory_subscription_mismatch');
  } else if (trimStr(requested && requested.subscriptionId)
    && accountSub !== trimStr(requested.subscriptionId)) {
    errors.push('inventory_subscription_mismatch');
  }

  const appId = trimStr(appBody && appBody.id);
  const appName = trimStr(appBody && appBody.name);
  if (!appName) errors.push('app_name_absent');
  if (!appId) {
    errors.push('missing_app_arm_id');
    return { ok: false, errors: [...new Set(errors)], identity: null };
  }

  const parsedApp = parseContainerAppArmId(appId);
  if (!parsedApp.ok) {
    errors.push('spoofed_app_arm_id');
    return { ok: false, errors: [...new Set(errors)], identity: null };
  }

  if (appName && parsedApp.containerApp !== appName) {
    errors.push('mismatched_app_arm_id');
  }
  if (accountSub && parsedApp.subscriptionId !== accountSub) {
    errors.push('mismatched_app_arm_id');
  }

  const scope = assertExactStagingScope({
    subscriptionId: parsedApp.subscriptionId,
    resourceGroup: parsedApp.resourceGroup,
    containerApp: parsedApp.containerApp,
  });
  if (!scope.ok) errors.push(...scope.errors);

  if (trimStr(requested && requested.resourceGroup)
    && parsedApp.resourceGroup !== trimStr(requested.resourceGroup)) {
    errors.push('inventory_resource_group_mismatch');
  }
  if (trimStr(requested && requested.containerApp)
    && parsedApp.containerApp !== trimStr(requested.containerApp)) {
    errors.push('inventory_container_app_mismatch');
  }

  const revisions = [];
  const list = Array.isArray(revisionList) ? revisionList : [];
  for (const raw of list) {
    const mapped = mapRevisionFromAz(raw);
    if (!mapped.ok) {
      errors.push(...mapped.errors);
      continue;
    }
    const parentPrefix = `${parsedApp.id.toLowerCase()}/revisions/`;
    if (mapped.revision.containerApp !== parsedApp.containerApp
      || mapped.revision.id.toLowerCase().indexOf(parentPrefix) !== 0) {
      errors.push('mismatched_revision_arm_id');
      continue;
    }
    revisions.push(mapped.revision);
  }

  if (errors.length) {
    return { ok: false, errors: [...new Set(errors)], identity: null };
  }

  return {
    ok: true,
    errors: [],
    identity: {
      subscriptionId: parsedApp.subscriptionId,
      resourceGroup: parsedApp.resourceGroup,
      containerApp: parsedApp.containerApp,
      appName: parsedApp.containerApp,
      appId: parsedApp.id,
      revisions,
    },
  };
}

/**
 * Read-only live inventory capture for eventual operator use.
 * Requires injectable runner(argv) => { stdout } | string.
 * Never uses a shell. Never executes mutation argv.
 * Live capture execution remains disabled unless a runner is injected (tests).
 * Inventory identity is proven only from Azure-returned full ARM IDs/names.
 */
function captureLiveInventory({
  subscriptionId,
  resourceGroup,
  containerApp,
} = {}, { runner } = {}) {
  const scope = assertExactStagingScope({ subscriptionId, resourceGroup, containerApp });
  if (!scope.ok) {
    return { ok: false, errors: scope.errors, inventory: null, azureCalls: 0, executed: false };
  }
  if (typeof runner !== 'function') {
    return {
      ok: false,
      errors: ['live_capture_runner_required'],
      inventory: null,
      azureCalls: 0,
      executed: false,
      note: 'RADAR 16E does not execute live capture; inject a runner in tests only',
    };
  }
  if (LOCKS.liveCaptureExecuteEnabled === true && LOCKS.liveExecuteEnabled === true) {
    return {
      ok: false,
      errors: ['live_capture_hard_disabled'],
      inventory: null,
      azureCalls: 0,
      executed: false,
    };
  }

  const plan = buildLiveCaptureArgvPlan({
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: scope.resourceGroup,
    containerApp: scope.containerApp,
  });
  if (!plan.ok) {
    return { ok: false, errors: plan.errors, inventory: null, azureCalls: 0, executed: false };
  }

  const byId = {};
  let azureCalls = 0;
  try {
    for (const step of plan.steps) {
      const ro = assertArgvReadOnlyCapture(step.argv);
      if (!ro.ok) {
        return {
          ok: false,
          errors: ro.errors,
          inventory: null,
          azureCalls,
          executed: false,
        };
      }
      const safe = assertSafeArgvTokens(step.argv);
      if (!safe.ok) {
        return {
          ok: false,
          errors: safe.errors,
          inventory: null,
          azureCalls,
          executed: false,
        };
      }
      const result = runner(step.argv.slice());
      azureCalls += 1;
      const stdout = result && typeof result === 'object' ? result.stdout : result;
      byId[step.id] = parseJsonStdout(stdout, step.id);
    }
  } catch (err) {
    return {
      ok: false,
      errors: [(err && err.code) || 'capture_runner_failed'],
      detail: String(err && err.message || err).slice(0, 200),
      inventory: null,
      azureCalls,
      executed: false,
    };
  }

  const proven = proveAzureInventoryIdentity({
    accountBody: byId.account_show || {},
    appBody: byId.containerapp_show || {},
    revisionList: byId.revision_list,
    requested: {
      subscriptionId: scope.subscriptionId,
      resourceGroup: scope.resourceGroup,
      containerApp: scope.containerApp,
    },
  });
  if (!proven.ok) {
    return {
      ok: false,
      errors: proven.errors,
      inventory: null,
      azureCalls,
      executed: false,
    };
  }

  const trafficMapped = mapTrafficFromAz(byId.ingress_traffic_show);
  if (!trafficMapped) {
    return {
      ok: false,
      errors: ['malformed_traffic'],
      inventory: null,
      azureCalls,
      executed: false,
    };
  }
  const trafficCheck = assertStrictTrafficSnapshot(trafficMapped);
  if (!trafficCheck.ok) {
    return {
      ok: false,
      errors: trafficCheck.errors,
      inventory: null,
      azureCalls,
      executed: false,
    };
  }

  const inventory = {
    subscriptionId: proven.identity.subscriptionId,
    resourceGroup: proven.identity.resourceGroup,
    containerApp: proven.identity.containerApp,
    appName: proven.identity.appName,
    appId: proven.identity.appId,
    revisions: proven.identity.revisions,
    traffic: trafficCheck.traffic,
  };

  return {
    ok: true,
    errors: [],
    inventory,
    azureCalls,
    executed: false,
    captureSteps: CAPTURE_STEP_IDS.slice(),
    shell: false,
    mutationExecution: false,
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
    rollbackTrafficSetArgv: ctx.rollbackTrafficSetArgv || null,
    restoreTrafficSetArgv: ctx.restoreTrafficSetArgv || null,
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
  let rollbackTrafficSetArgv = null;
  let restoreTrafficSetArgv = null;

  if (!inventory) {
    errors.push('failed_verification');
  } else {
    const identity = assertInventoryIdentity(inventory, {
      subscriptionId: req.subscriptionId,
      resourceGroup: req.resourceGroup,
      containerApp: req.containerApp,
    });
    if (!identity.ok) errors.push(...identity.errors);

    const snap = snapshotTraffic(inventory);
    if (!snap.ok) {
      errors.push(...snap.errors);
    } else {
      trafficSnapshotBefore = snap.traffic;
    }

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

    if (snap.ok) {
      restorePlan = buildRestorePlan({ currentTraffic: trafficSnapshotBefore });
    }

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

    if (errors.length === 0) {
      const rbArgv = buildTrafficSetArgv({
        subscriptionId: SUBSCRIPTION_ID,
        resourceGroup: scope.resourceGroup || trimStr(req.resourceGroup),
        containerApp: scope.containerApp || trimStr(req.containerApp),
        traffic: plannedTraffic,
        mode: 'rollback',
      });
      if (!rbArgv.ok) errors.push(...rbArgv.errors);
      else rollbackTrafficSetArgv = rbArgv.argv;

      const rsArgv = buildTrafficSetArgv({
        subscriptionId: SUBSCRIPTION_ID,
        resourceGroup: scope.resourceGroup || trimStr(req.resourceGroup),
        containerApp: scope.containerApp || trimStr(req.containerApp),
        traffic: trafficSnapshotBefore,
        mode: 'restore',
      });
      if (!rsArgv.ok) errors.push(...rsArgv.errors);
      else restoreTrafficSetArgv = rsArgv.argv;
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
      rollbackTrafficSetArgv,
      restoreTrafficSetArgv,
    });
  }

  return {
    ok,
    errors: uniqueErrors,
    scope,
    trafficSnapshotBefore: ok ? trafficSnapshotBefore : trafficSnapshotBefore,
    plannedTraffic: ok ? plannedTraffic : null,
    restorePlan: ok ? restorePlan : null,
    rollbackTrafficSetArgv: ok ? rollbackTrafficSetArgv : null,
    restoreTrafficSetArgv: ok ? restoreTrafficSetArgv : null,
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
  const appId = buildContainerAppArmId({
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: plan.resourceGroup,
    containerApp: plan.containerApp,
  });
  return {
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: plan.resourceGroup,
    containerApp: plan.containerApp,
    appName: plan.containerApp,
    appId,
    revisions: [
      {
        id: buildRevisionArmId({
          subscriptionId: SUBSCRIPTION_ID,
          resourceGroup: plan.resourceGroup,
          containerApp: plan.containerApp,
          revisionName: currentRevisionName,
        }),
        name: currentRevisionName,
        containerApp: plan.containerApp,
        active: true,
        runningState: 'Running',
        healthState: 'Healthy',
        provisioningState: 'Provisioned',
        image: `${plan.imageRepository}:${'b'.repeat(40)}`,
      },
      {
        id: buildRevisionArmId({
          subscriptionId: SUBSCRIPTION_ID,
          resourceGroup: plan.resourceGroup,
          containerApp: plan.containerApp,
          revisionName: targetRevisionName,
        }),
        name: targetRevisionName,
        containerApp: plan.containerApp,
        active: true,
        runningState: 'Running',
        healthState: 'Healthy',
        provisioningState: 'Provisioned',
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

  red('missing_inventory_subscription', {
    ...base,
    inventory: { ...base.inventory, subscriptionId: '' },
  }, 'missing_inventory_subscription');

  red('target_not_active', {
    ...base,
    inventory: {
      ...base.inventory,
      revisions: base.inventory.revisions.map((r) => (
        r.name === base.targetRevisionName ? { ...r, active: false } : r
      )),
    },
  }, 'target_not_active');

  red('unsupported_latest_traffic', {
    ...base,
    inventory: {
      ...base.inventory,
      traffic: [{ latestRevision: true, weight: 100 }],
    },
  }, 'unsupported_traffic_snapshot');

  red('unsupported_label_with_revision_name', {
    ...base,
    inventory: {
      ...base.inventory,
      traffic: [{
        revisionName: base.currentRevisionName,
        weight: 100,
        label: 'production',
      }],
    },
  }, 'unsupported_traffic_snapshot');

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
      && result.plannedTraffic.some((t) => t.revisionName === req.targetRevisionName && t.weight === 100)
      && Array.isArray(result.rollbackTrafficSetArgv)
      && result.rollbackTrafficSetArgv[0] === 'az'
      && result.rollbackTrafficSetArgv.includes('set');
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
  CAPTURE_STEP_IDS,
  SAFE_AZ_TOKEN_RE,
  expectedConfirmationToken,
  buildContainerAppArmId,
  buildRevisionArmId,
  parseContainerAppArmId,
  parseRevisionArmId,
  assertExactStagingScope,
  assertImmutableFullShaImage,
  assertInventoryIdentity,
  assertStrictTrafficSnapshot,
  assertTargetHealthyInInventory,
  assertMutationsTrafficOnly,
  assertTargetTrafficWeights,
  assertSafeArgvTokens,
  assertArgvReadOnlyCapture,
  assertTrafficSetArgvContract,
  assertCaptureResourceArgvExact,
  extractRevisionWeightPairs,
  proveAzureInventoryIdentity,
  evaluateRollbackRequest,
  buildSecretFreePlans,
  buildPlannedTraffic,
  buildRestorePlan,
  buildRollbackRecord,
  buildLiveCaptureArgvPlan,
  buildTrafficSetArgv,
  captureLiveInventory,
  syntheticInventoryForApp,
  baseGreenRequest,
  runRedCases,
  runGreenCases,
};
