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

/** Captured once during 15D live run — ARM GET resourceGroups; HTTP 403 is still a query. */
const PROHIBITED_PRODUCTION_SCOPE_QUERIES = Object.freeze([
  Object.freeze({
    resourceGroup: 'wh-prod-rg',
    http_method: 'GET',
    api: 'Microsoft.Resources/resourceGroups',
    api_version: '2021-04-01',
    http_status: 403,
    data_returned: false,
    modified: false,
  }),
  Object.freeze({
    resourceGroup: 'wolfhouse-prod-rg',
    http_method: 'GET',
    api: 'Microsoft.Resources/resourceGroups',
    api_version: '2021-04-01',
    http_status: 403,
    data_returned: false,
    modified: false,
  }),
]);

const INSTRUCTION_DEVIATION_15D =
  'Requested never-query-Wolfhouse-production boundary was not honored: '
  + 'two prohibited ARM GET probes were issued against production resource groups '
  + 'wh-prod-rg and wolfhouse-prod-rg '
  + '(subscriptions/{sub}/resourceGroups/{rg}?api-version=2021-04-01); '
  + 'both returned HTTP 403; no production resource data was returned; '
  + 'no production modification occurred. A denied/403 lookup is still a production query.';

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

function listProdProbeResourceGroups(scopeFailClosedProbes) {
  const probes = scopeFailClosedProbes && typeof scopeFailClosedProbes === 'object'
    ? scopeFailClosedProbes
    : {};
  return Object.keys(probes).filter((rg) => /-prod-rg$/i.test(rg) || /^wolfhouse-prod/i.test(rg));
}

/**
 * Truth gate: any prod RG probe (including HTTP 403) means production was queried.
 * False wolfhouse_production_queried=false with prod probes present must fail.
 */
function evaluateProductionQueryDisclosure(docs) {
  const contract = (docs && docs.contract) || {};
  const evidence = (docs && docs.evidence) || {};
  const inventory = (docs && docs.inventory) || {};
  const findings = String((docs && docs.findings) || '');
  const failures = [];

  const probeMap = evidence.scope_fail_closed_probes
    || inventory.scope_fail_closed_probes
    || {};
  const prodRgs = listProdProbeResourceGroups(probeMap);
  const hasProdProbes = prodRgs.length > 0
    || (Array.isArray(evidence.prohibited_production_scope_queries)
      && evidence.prohibited_production_scope_queries.length > 0)
    || (Array.isArray(contract.prohibited_production_scope_queries)
      && contract.prohibited_production_scope_queries.length > 0);

  if (hasProdProbes) {
    if (contract.wolfhouse_production_queried !== true) {
      failures.push({
        code: 'false_no_query_claim_with_prod_probes',
        detail: 'contract.wolfhouse_production_queried must be true when prod probes exist',
      });
    }
    if (evidence.wolfhouse_production_queried !== true) {
      failures.push({
        code: 'false_no_query_claim_with_prod_probes',
        detail: 'evidence.wolfhouse_production_queried must be true when prod probes exist',
      });
    }
    if (inventory.wolfhouse_production_queried !== true) {
      failures.push({
        code: 'false_no_query_claim_with_prod_probes',
        detail: 'inventory.wolfhouse_production_queried must be true when prod probes exist',
      });
    }
  }

  const expected = PROHIBITED_PRODUCTION_SCOPE_QUERIES;
  const disclosed = Array.isArray(evidence.prohibited_production_scope_queries)
    ? evidence.prohibited_production_scope_queries
    : [];
  const contractDisclosed = Array.isArray(contract.prohibited_production_scope_queries)
    ? contract.prohibited_production_scope_queries
    : [];
  const invDisclosed = Array.isArray(inventory.prohibited_production_scope_queries)
    ? inventory.prohibited_production_scope_queries
    : [];

  for (const exp of expected) {
    const match = (list) => list.find((q) => q && q.resourceGroup === exp.resourceGroup);
    const e = match(disclosed);
    const c = match(contractDisclosed);
    const i = match(invDisclosed);
    if (!e || !c || !i) {
      failures.push({
        code: 'missing_production_query_disclosure',
        detail: exp.resourceGroup,
      });
      continue;
    }
    for (const row of [e, c, i]) {
      if (Number(row.http_status) !== 403) {
        failures.push({
          code: 'production_query_http_status_mismatch',
          detail: `${exp.resourceGroup}:${row.http_status}`,
        });
      }
      if (row.data_returned !== false) {
        failures.push({
          code: 'production_query_data_returned_not_false',
          detail: exp.resourceGroup,
        });
      }
      if (row.modified !== false) {
        failures.push({
          code: 'production_query_modified_not_false',
          detail: exp.resourceGroup,
        });
      }
    }
    if (Number(probeMap[exp.resourceGroup]) !== 403) {
      failures.push({
        code: 'scope_fail_closed_probe_status_mismatch',
        detail: `${exp.resourceGroup}:${probeMap[exp.resourceGroup]}`,
      });
    }
  }

  if (contract.wolfhouse_production_modified !== false
    || evidence.wolfhouse_production_modified !== false
    || inventory.wolfhouse_production_modified !== false) {
    failures.push({ code: 'production_modified_must_be_false' });
  }

  const bc = contract.boundaryCompliance || {};
  const ebc = evidence.boundaryCompliance || {};
  const ibc = inventory.boundaryCompliance || {};
  for (const [label, block] of [['contract', bc], ['evidence', ebc], ['inventory', ibc]]) {
    if (block.noProductionQueryBoundaryPassed !== false) {
      failures.push({
        code: 'boundary_compliance_not_failed',
        detail: `${label}.noProductionQueryBoundaryPassed`,
      });
    }
    if (typeof block.instructionDeviation !== 'string'
      || block.instructionDeviation.length < 40
      || !/403/.test(block.instructionDeviation)
      || !/wh-prod-rg/.test(block.instructionDeviation)
      || !/wolfhouse-prod-rg/.test(block.instructionDeviation)) {
      failures.push({
        code: 'instruction_deviation_incomplete',
        detail: label,
      });
    }
  }

  if (/\*\*Wolfhouse production:\*\*[^\n]*not queried/i.test(findings)
    || /Wolfhouse production:\s*not queried/i.test(findings)
    || /prod untouched/i.test(findings)
    || /Wolfhouse prod untouched/i.test(findings)) {
    failures.push({
      code: 'findings_false_no_query_claim',
      detail: 'findings must not claim Wolfhouse production not queried / untouched',
    });
  }
  if (!/instructionDeviation/i.test(findings)
    || !/wh-prod-rg/.test(findings)
    || !/wolfhouse-prod-rg/.test(findings)
    || !/403/.test(findings)) {
    failures.push({
      code: 'findings_missing_production_query_disclosure',
      detail: 'findings must disclose both prod probes, 403, and instructionDeviation',
    });
  }

  return {
    ok: failures.length === 0,
    failures,
    hasProdProbes,
    prodRgs,
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
  PROHIBITED_PRODUCTION_SCOPE_QUERIES,
  INSTRUCTION_DEVIATION_15D,
  sha256Hex,
  classifyImageProvenance,
  evaluateSunsetRolloutPreflight,
  evaluatePostDeployInventory,
  evaluateCostDeltaVs15c,
  evaluateProductionQueryDisclosure,
  listProdProbeResourceGroups,
  assertBicepDeclaresWebhookSlug,
  fixturePaths,
  extractPlainEnvMap,
  getPlainValue,
};
