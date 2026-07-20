'use strict';

/**
 * FORTRESS Slice 15D — Sunset-staging-only Staff API SHA deploy helpers.
 *
 * Pure evaluation (no network). Live Azure was executed once during the slice;
 * the static verifier never re-runs live calls.
 */

const path = require('path');
const {
  LOCKED_SCOPE,
  COMMITTED_COST_BASELINE,
  COST_SPIKE_MULTIPLIER,
  EXPECTED_IAC_DELTA,
  DEPLOY_SEQUENCE_15D,
  FORBIDDEN_MUTATION_SURFACE,
  sha256Hex,
  classifyImageProvenance,
  evaluateSunsetRolloutPreflight,
  evaluateCost,
  assertBicepDeclaresWebhookSlug,
  extractPlainEnvMap,
  getPlainValue,
} = require('./fortress-slice15c-sunset-rollout-preflight');

const MASTER_BASIS = 'fe6e1e507a986a136d0baafaf0e89f2f4a7df43e';
const PRIOR_REVISION = 'luna-sunset-staging-staff-api--0000266';
const PRIOR_IMAGE =
  'whstagingacr.azurecr.io/luna-sunset-staff-api:186307418400581a74f86b096e02bc32a41513b6';
const ACTIVE_REVISION = 'luna-sunset-staging-staff-api--0000267';
const EXPECTED_IMAGE =
  `whstagingacr.azurecr.io/luna-sunset-staff-api:${MASTER_BASIS}`;
const ACR_RUN_ID = 'cb10q';
const IMAGE_DIGEST =
  'sha256:a762c5af7adf0fcc84fdae46f6bd5af547fb5981595f5927d7e2f013f355fd03';

/** 15C captured predeploy ActualCost (same RG/month window). */
const COST_BASELINE_15C = Object.freeze({
  amount: 16.4316563548387,
  currency: 'USD',
  period: Object.freeze({ from: '2026-07-01', to: '2026-07-20', label: 'month-to-date' }),
  source: 'fixtures/fortress-tenant-identity/slice15c-contract.json#cost.captured_predeploy',
});

function fixturePaths(root) {
  const dir = path.join(root, 'fixtures', 'fortress-tenant-identity');
  return {
    dir,
    contract: path.join(dir, 'slice15d-contract.json'),
    evidence: path.join(dir, 'slice15d-evidence.json'),
    findings: path.join(dir, 'slice15d-findings.md'),
    inventory: path.join(dir, 'slice15d-live-inventory.json'),
  };
}

function evaluatePostDeployInventory(inventory, opts) {
  const options = opts || {};
  const expectedSha = options.expectedMasterSha || MASTER_BASIS;
  const base = evaluateSunsetRolloutPreflight(inventory, {
    requireRuntimeTenantSlug: true,
    costBaseline: options.costBaseline || COMMITTED_COST_BASELINE,
  });
  const failures = [...base.failures];

  const image = String(
    (inventory && inventory.active_revision && inventory.active_revision.image)
    || (inventory && inventory.app && inventory.app.image)
    || '',
  ).trim();
  const expectedImage = `whstagingacr.azurecr.io/luna-sunset-staff-api:${expectedSha}`;
  if (image !== expectedImage) {
    failures.push({ code: 'image_tag_not_master_sha', detail: image || 'missing' });
  }

  const envMap = extractPlainEnvMap(inventory);
  const webhook = getPlainValue(envMap, 'STRIPE_WEBHOOK_CLIENT_SLUG');
  const defaultSlug = getPlainValue(envMap, 'DEFAULT_CLIENT_SLUG');
  const skip = getPlainValue(envMap, 'STRIPE_WEBHOOK_SKIP_VERIFY');
  if (webhook !== 'sunset') {
    failures.push({ code: 'stripe_webhook_client_slug_missing_or_wrong', detail: webhook || 'missing' });
  }
  if (defaultSlug !== 'sunset') {
    failures.push({ code: 'default_client_slug_missing_or_wrong', detail: defaultSlug || 'missing' });
  }
  if (skip !== 'false') {
    failures.push({ code: 'stripe_webhook_skip_verify_not_false', detail: skip || 'missing' });
  }

  const running = String(
    (inventory && inventory.active_revision && inventory.active_revision.runningState) || '',
  ).toLowerCase();
  if (running && !['running', 'runningatmaxscale'].includes(running)) {
    failures.push({ code: 'revision_not_running', detail: running });
  }

  const codes = new Set(failures.map((f) => f.code));
  return {
    ok: failures.length === 0,
    failures,
    summary: {
      ...base.summary,
      image_matches_master_sha: image === expectedImage,
      webhook_slug_ok: webhook === 'sunset',
      default_slug_ok: defaultSlug === 'sunset',
      skip_verify_false: skip === 'false',
      post_deploy_codes: [...codes],
    },
  };
}

function evaluateCostDeltaVs15c(costAfter, baseline15c) {
  const base = baseline15c || COST_BASELINE_15C;
  const amount = costAfter && typeof costAfter.amount === 'number' ? costAfter.amount : null;
  if (amount == null || !Number.isFinite(amount)) {
    return {
      ok: false,
      delta: null,
      failures: [{ code: 'cost_after_unavailable', detail: 'missing' }],
    };
  }
  const spikeEval = evaluateCost(costAfter, COMMITTED_COST_BASELINE);
  return {
    ok: spikeEval.ok,
    delta: amount - base.amount,
    amount,
    baseline_15c: base.amount,
    currency: costAfter.currency || base.currency,
    spike: spikeEval.spike,
    failures: spikeEval.failures,
  };
}

module.exports = {
  LOCKED_SCOPE,
  COMMITTED_COST_BASELINE,
  COST_SPIKE_MULTIPLIER,
  COST_BASELINE_15C,
  EXPECTED_IAC_DELTA,
  DEPLOY_SEQUENCE_15D,
  FORBIDDEN_MUTATION_SURFACE,
  MASTER_BASIS,
  PRIOR_REVISION,
  PRIOR_IMAGE,
  ACTIVE_REVISION,
  EXPECTED_IMAGE,
  ACR_RUN_ID,
  IMAGE_DIGEST,
  sha256Hex,
  classifyImageProvenance,
  evaluateSunsetRolloutPreflight,
  evaluatePostDeployInventory,
  evaluateCostDeltaVs15c,
  assertBicepDeclaresWebhookSlug,
  fixturePaths,
  extractPlainEnvMap,
  getPlainValue,
};
