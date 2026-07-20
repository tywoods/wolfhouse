'use strict';

/**
 * FORTRESS Slice 15C — Sunset-staging-only Stripe webhook slug rollout preflight.
 *
 * Pure evaluation helpers (no network). Live inventory capture uses ARM/IMDS
 * separately; the static verifier never re-runs live Azure calls.
 */

const crypto = require('crypto');
const path = require('path');

const LOCKED_SCOPE = Object.freeze({
  subscriptionId: '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9',
  resourceGroup: 'luna-sunset-staging-rg',
  containerApp: 'luna-sunset-staging-staff-api',
  portalHost: 'sunset-staging.lunafrontdesk.com',
  tenantSlug: 'sunset',
  imageRepository: 'whstagingacr.azurecr.io/luna-sunset-staff-api',
  managedIdentityName: 'luna-sunset-staging-identity',
});

/** Committed Slice-1 inventory ActualCost baseline (month-to-date as of 2026-07-17). */
const COMMITTED_COST_BASELINE = Object.freeze({
  type: 'ActualCost',
  amount: 13.493559344086,
  currency: 'USD',
  period: Object.freeze({ from: '2026-07-01', to: '2026-07-17', label: 'month-to-date' }),
  source: 'infra/azure/sunset-staging/inventory/live-inventory.normalized.json',
});

/** Fail closed when current ActualCost exceeds 2× committed baseline (absolute). */
const COST_SPIKE_MULTIPLIER = 2;

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const SHA_TAG_SUFFIX_RE = /^[0-9a-f]{40}(-[A-Za-z0-9._-]+)?$/i;

const FORBIDDEN_MUTATION_SURFACE = Object.freeze([
  'secrets',
  'rbac',
  'network',
  'database',
  'scaling',
  'ingress',
  'traffic',
  'stripe_account',
  'payment_config',
]);

const EXPECTED_IAC_DELTA = Object.freeze({
  env_add: Object.freeze([
    Object.freeze({ name: 'STRIPE_WEBHOOK_CLIENT_SLUG', value: 'sunset' }),
  ]),
  env_preserve: Object.freeze([
    Object.freeze({ name: 'DEFAULT_CLIENT_SLUG', value: 'sunset' }),
    Object.freeze({ name: 'STRIPE_WEBHOOK_SKIP_VERIFY', value: 'false' }),
  ]),
  image_when_supplied: 'staffApiImageTag == full merged master SHA (immutable)',
  forbidden_surfaces: FORBIDDEN_MUTATION_SURFACE,
});

const DEPLOY_SEQUENCE_15D = Object.freeze([
  Object.freeze({
    step: 1,
    id: 'sync_clean_master',
    command: 'git checkout master && git fetch origin && git pull --ff-only origin master',
    notes: 'After 15C merge; working tree must be clean at origin/master',
  }),
  Object.freeze({
    step: 2,
    id: 'assert_repo_sync',
    command: 'node scripts/assert-repo-sync.js',
    notes: 'Also runs via pre-push hook after setup-git-hooks',
  }),
  Object.freeze({
    step: 3,
    id: 'deploy_preflight_assert_master',
    command: 'node scripts/assert-deploy-from-master.js',
    notes: 'npm run deploy:preflight — refuse dirty / non-master tree before az acr build',
  }),
  Object.freeze({
    step: 4,
    id: 'acr_build_sha_tag',
    command:
      'az acr build -r whstagingacr -g wh-staging-rg'
      + ' -t luna-sunset-staff-api:$(git rev-parse HEAD)'
      + ' -f Dockerfile.luna-sunset-staff-api .',
    notes: 'Image tag MUST equal exact merged master SHA; never :latest',
  }),
  Object.freeze({
    step: 5,
    id: 'bicep_or_containerapp_update',
    command:
      'az deployment group create --resource-group luna-sunset-staging-rg --mode Incremental'
      + ' --template-file infra/azure/sunset-staging/main.bicep'
      + ' --parameters @infra/azure/sunset-staging/parameters.example.json'
      + ' --parameters staffApiImageTag=$(git rev-parse HEAD)'
      + ' deploySha=$(git rev-parse HEAD) forceRevision=$(git rev-parse HEAD)'
      + ' + secure params (never committed)',
    notes:
      'Or equivalent az containerapp update scoped only to this app;'
      + ' expected delta: STRIPE_WEBHOOK_CLIENT_SLUG=sunset + SHA-tagged image only',
  }),
  Object.freeze({
    step: 6,
    id: 'health_readonly_verify',
    command:
      'az containerapp revision list -g luna-sunset-staging-rg -n luna-sunset-staging-staff-api'
      + ' && curl -fsS https://sunset-staging.lunafrontdesk.com/healthz (or staff health)',
    notes: 'Confirm single healthy revision, 100% traffic, env slugs sunset, skip-verify false',
  }),
  Object.freeze({
    step: 7,
    id: 'cost_postcheck',
    command: 'node scripts/capture-sunset-staging-rg-cost.js --phase after',
    notes: 'Secret-free ActualCost for luna-sunset-staging-rg; flag spike vs 15C baseline',
  }),
  Object.freeze({
    step: 8,
    id: 'rollback_on_health_fail',
    command:
      'az containerapp ingress traffic set -g luna-sunset-staging-rg'
      + ' -n luna-sunset-staging-staff-api --revision-weight <prior-revision>=100'
      + ' (or redeploy prior image tag)',
    notes: 'If health fails: route traffic to previous healthy revision / prior SHA image',
  }),
]);

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function truthyEnv(v) {
  const s = trimStr(v).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

function parseImage(image) {
  const raw = trimStr(image);
  if (!raw) return { ok: false, reason: 'image_missing', repository: '', tag: '' };
  const idx = raw.lastIndexOf(':');
  if (idx < 0) {
    return { ok: false, reason: 'image_tag_missing', repository: raw, tag: '' };
  }
  const repository = raw.slice(0, idx);
  const tag = raw.slice(idx + 1);
  return { ok: true, repository, tag, raw };
}

function classifyImageProvenance(image) {
  const parsed = parseImage(image);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: parsed.reason || 'image_provenance_unknown',
      mutable_latest: false,
      tag: parsed.tag || '',
      repository: parsed.repository || '',
    };
  }
  if (parsed.repository !== LOCKED_SCOPE.imageRepository) {
    return {
      ok: false,
      reason: 'image_repository_unexpected',
      mutable_latest: false,
      tag: parsed.tag,
      repository: parsed.repository,
    };
  }
  const tagLower = parsed.tag.toLowerCase();
  if (tagLower === 'latest' || tagLower === 'staging' || tagLower === 'prod') {
    return {
      ok: false,
      reason: 'mutable_latest_image',
      mutable_latest: true,
      tag: parsed.tag,
      repository: parsed.repository,
    };
  }
  if (!SHA_TAG_SUFFIX_RE.test(parsed.tag) && !FULL_SHA_RE.test(parsed.tag)) {
    return {
      ok: false,
      reason: 'image_provenance_unknown',
      mutable_latest: false,
      tag: parsed.tag,
      repository: parsed.repository,
    };
  }
  return {
    ok: true,
    reason: 'immutable_sha_tag',
    mutable_latest: false,
    tag: parsed.tag,
    repository: parsed.repository,
  };
}

function extractPlainEnvMap(inventory) {
  const env = (inventory && inventory.container_env) || {};
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v && typeof v === 'object' && v.secretRef) {
      out[k] = { secretRef: String(v.secretRef) };
    } else if (v && typeof v === 'object' && 'value' in v) {
      out[k] = { value: v.value == null ? '' : String(v.value) };
    } else if (typeof v === 'string') {
      out[k] = { value: v };
    }
  }
  return out;
}

function getPlainValue(envMap, name) {
  const e = envMap[name];
  if (!e) return '';
  if (e.secretRef) return '';
  return trimStr(e.value);
}

function evaluateScope(inventory) {
  const failures = [];
  const scope = (inventory && inventory.scope) || {};
  if (trimStr(scope.subscriptionId) !== LOCKED_SCOPE.subscriptionId) {
    failures.push({ code: 'unexpected_subscription', detail: trimStr(scope.subscriptionId) });
  }
  if (trimStr(scope.resourceGroup) !== LOCKED_SCOPE.resourceGroup) {
    failures.push({ code: 'unexpected_resource_group', detail: trimStr(scope.resourceGroup) });
  }
  if (trimStr(scope.containerApp) !== LOCKED_SCOPE.containerApp) {
    failures.push({ code: 'unexpected_container_app', detail: trimStr(scope.containerApp) });
  }
  if (trimStr(scope.portalHost) && trimStr(scope.portalHost) !== LOCKED_SCOPE.portalHost) {
    failures.push({ code: 'unexpected_portal_host', detail: trimStr(scope.portalHost) });
  }
  return failures;
}

function evaluateTenantSlugs(envMap, opts) {
  const options = opts || {};
  const failures = [];
  const defaultSlug = getPlainValue(envMap, 'DEFAULT_CLIENT_SLUG');
  const webhookSlug = getPlainValue(envMap, 'STRIPE_WEBHOOK_CLIENT_SLUG');
  const skipVerify = getPlainValue(envMap, 'STRIPE_WEBHOOK_SKIP_VERIFY');

  if (defaultSlug && defaultSlug !== LOCKED_SCOPE.tenantSlug) {
    failures.push({
      code: 'default_client_slug_not_sunset',
      detail: defaultSlug,
    });
  }
  if (webhookSlug && webhookSlug !== LOCKED_SCOPE.tenantSlug) {
    failures.push({
      code: 'stripe_webhook_client_slug_not_sunset',
      detail: webhookSlug,
    });
  }
  if (defaultSlug && webhookSlug && defaultSlug !== webhookSlug) {
    failures.push({
      code: 'conflicting_runtime_client_slugs',
      detail: `${defaultSlug}!=${webhookSlug}`,
    });
  }
  // Post-15D / runtime-ready gate: at least one authoritative slug must resolve.
  if (options.requireRuntimeTenantSlug && !defaultSlug && !webhookSlug) {
    failures.push({
      code: 'missing_runtime_client_slug',
      detail: 'DEFAULT_CLIENT_SLUG and STRIPE_WEBHOOK_CLIENT_SLUG both empty',
    });
  }
  if (truthyEnv(skipVerify)) {
    failures.push({
      code: 'stripe_webhook_skip_verify_true',
      detail: skipVerify,
    });
  }
  return {
    failures,
    defaultSlug: defaultSlug || null,
    webhookSlug: webhookSlug || null,
    skipVerify: skipVerify || null,
    webhookSlugPresent: Boolean(webhookSlug),
  };
}

function evaluateRevisionTraffic(inventory) {
  const failures = [];
  const rev = (inventory && inventory.active_revision) || {};
  const health = trimStr(rev.healthState || rev.health);
  const provisioning = trimStr(rev.provisioningState || rev.provisioning);
  const running = trimStr(rev.runningState || rev.running);
  const trafficWeight = Number(rev.trafficWeight);
  const active = rev.active !== false;

  if (!active) {
    failures.push({ code: 'active_revision_inactive', detail: trimStr(rev.name) });
  }
  if (health && health.toLowerCase() !== 'healthy') {
    failures.push({ code: 'unhealthy_revision', detail: health });
  }
  if (provisioning && !['succeeded', 'provisioned'].includes(provisioning.toLowerCase())) {
    failures.push({ code: 'revision_provisioning_not_ready', detail: provisioning });
  }
  if (Number.isFinite(trafficWeight) && trafficWeight !== 100) {
    failures.push({ code: 'ambiguous_traffic', detail: `trafficWeight=${trafficWeight}` });
  }

  const traffic = Array.isArray(inventory && inventory.traffic) ? inventory.traffic : [];
  const weighted = traffic.filter((t) => Number(t.weight) > 0);
  if (weighted.length > 1) {
    failures.push({
      code: 'ambiguous_traffic',
      detail: `positive_weights=${weighted.length}`,
    });
  }
  if (weighted.length === 1 && Number(weighted[0].weight) !== 100) {
    failures.push({
      code: 'ambiguous_traffic',
      detail: `single_weight=${weighted[0].weight}`,
    });
  }

  const appState = trimStr((inventory && inventory.app && inventory.app.runningStatus) || '');
  if (appState && appState.toLowerCase() !== 'running') {
    failures.push({ code: 'app_not_running', detail: appState });
  }
  const appProv = trimStr((inventory && inventory.app && inventory.app.provisioningState) || '');
  if (appProv && appProv.toLowerCase() !== 'succeeded') {
    failures.push({ code: 'app_provisioning_failed', detail: appProv });
  }

  return {
    failures,
    health: health || null,
    provisioning: provisioning || null,
    running: running || null,
    trafficWeight: Number.isFinite(trafficWeight) ? trafficWeight : null,
    revisionName: trimStr(rev.name) || null,
  };
}

function evaluateCost(cost, baseline) {
  const base = baseline || COMMITTED_COST_BASELINE;
  const amount = cost && typeof cost.amount === 'number' ? cost.amount : null;
  const currency = trimStr(cost && cost.currency) || null;
  if (amount == null || !Number.isFinite(amount)) {
    return {
      ok: false,
      spike: false,
      failures: [{ code: 'cost_amount_unavailable', detail: 'missing' }],
      amount: null,
      currency,
      baseline_amount: base.amount,
      threshold: base.amount * COST_SPIKE_MULTIPLIER,
    };
  }
  if (currency && currency !== base.currency) {
    return {
      ok: false,
      spike: false,
      failures: [{ code: 'cost_currency_mismatch', detail: currency }],
      amount,
      currency,
      baseline_amount: base.amount,
      threshold: base.amount * COST_SPIKE_MULTIPLIER,
    };
  }
  const threshold = base.amount * COST_SPIKE_MULTIPLIER;
  const spike = amount > threshold;
  return {
    ok: !spike,
    spike,
    failures: spike
      ? [{ code: 'cost_spike', detail: `${amount}>${threshold}` }]
      : [],
    amount,
    currency: currency || base.currency,
    baseline_amount: base.amount,
    threshold,
  };
}

/**
 * Evaluate a secret-free Sunset staging inventory snapshot for 15C preflight.
 * @returns {{ ok: boolean, failures: object[], summary: object }}
 */
function evaluateSunsetRolloutPreflight(inventory, opts) {
  const options = opts || {};
  const failures = [];
  failures.push(...evaluateScope(inventory));

  const envMap = extractPlainEnvMap(inventory);
  const slugEval = evaluateTenantSlugs(envMap, {
    requireRuntimeTenantSlug: !!options.requireRuntimeTenantSlug,
  });
  failures.push(...slugEval.failures);

  const revEval = evaluateRevisionTraffic(inventory);
  failures.push(...revEval.failures);

  const image = trimStr(
    (inventory && inventory.active_revision && inventory.active_revision.image)
    || (inventory && inventory.app && inventory.app.image)
    || '',
  );
  const imageEval = classifyImageProvenance(image);
  if (!imageEval.ok) {
    failures.push({ code: imageEval.reason, detail: imageEval.tag || image });
  }

  const costEval = evaluateCost(
    inventory && inventory.cost,
    options.costBaseline || COMMITTED_COST_BASELINE,
  );
  failures.push(...costEval.failures);

  const codes = new Set(failures.map((f) => f.code));
  return {
    ok: failures.length === 0,
    failures,
    summary: {
      scope_ok: !codes.has('unexpected_subscription')
        && !codes.has('unexpected_resource_group')
        && !codes.has('unexpected_container_app')
        && !codes.has('unexpected_portal_host'),
      default_client_slug: slugEval.defaultSlug,
      stripe_webhook_client_slug: slugEval.webhookSlug,
      stripe_webhook_client_slug_present: slugEval.webhookSlugPresent,
      stripe_webhook_skip_verify: slugEval.skipVerify,
      revision: revEval.revisionName,
      health: revEval.health,
      traffic_weight: revEval.trafficWeight,
      image,
      image_provenance: imageEval.reason,
      cost_amount: costEval.amount,
      cost_currency: costEval.currency,
      cost_spike: costEval.spike,
      cost_threshold: costEval.threshold,
      iac_pending_webhook_slug: !slugEval.webhookSlugPresent,
    },
  };
}

/**
 * Static expected what-if surface for 15C IaC (no live Azure call).
 * Only STRIPE_WEBHOOK_CLIENT_SLUG add + optional SHA image when supplied.
 */
function evaluateExpectedWhatIfSurface(delta) {
  const d = delta || {};
  const failures = [];
  const envAdds = Array.isArray(d.env_add) ? d.env_add : [];
  const envRemoves = Array.isArray(d.env_remove) ? d.env_remove : [];
  const other = Array.isArray(d.other_changes) ? d.other_changes : [];
  const surfaces = Array.isArray(d.touched_surfaces) ? d.touched_surfaces : [];

  const hasWebhook = envAdds.some(
    (e) => e && e.name === 'STRIPE_WEBHOOK_CLIENT_SLUG' && trimStr(e.value) === 'sunset',
  );
  if (!hasWebhook && d.require_webhook_add !== false) {
    failures.push({ code: 'missing_webhook_slug_env_add', detail: 'STRIPE_WEBHOOK_CLIENT_SLUG' });
  }
  for (const e of envAdds) {
    if (!e || e.name === 'STRIPE_WEBHOOK_CLIENT_SLUG') continue;
    if (e.name === 'DEPLOY_SHA' || e.name === 'FORCE_REVISION') continue;
    failures.push({ code: 'excessive_what_if_env_add', detail: e.name });
  }
  if (envRemoves.length) {
    failures.push({ code: 'excessive_what_if_env_remove', detail: String(envRemoves.length) });
  }
  for (const s of surfaces) {
    if (FORBIDDEN_MUTATION_SURFACE.includes(s)) {
      failures.push({ code: 'excessive_what_if_surface', detail: s });
    }
  }
  for (const o of other) {
    if (o === 'image_tag_when_supplied') continue;
    if (o === 'platform_noise') continue;
    failures.push({ code: 'excessive_what_if_other', detail: String(o) });
  }
  return { ok: failures.length === 0, failures };
}

function assertBicepDeclaresWebhookSlug(bicepSource) {
  const src = String(bicepSource || '');
  const hasWebhook = /name:\s*'STRIPE_WEBHOOK_CLIENT_SLUG'\s*,\s*value:\s*'sunset'/.test(src);
  const hasDefault = /name:\s*'DEFAULT_CLIENT_SLUG'\s*,\s*value:\s*'sunset'/.test(src);
  const skipFalse = /name:\s*'STRIPE_WEBHOOK_SKIP_VERIFY'\s*,\s*value:\s*'false'/.test(src);
  return {
    ok: hasWebhook && hasDefault && skipFalse,
    hasWebhook,
    hasDefault,
    skipFalse,
  };
}

function fixturePaths(root) {
  const dir = path.join(root, 'fixtures', 'fortress-tenant-identity');
  return {
    dir,
    contract: path.join(dir, 'slice15c-contract.json'),
    evidence: path.join(dir, 'slice15c-evidence.json'),
    findings: path.join(dir, 'slice15c-findings.md'),
    inventory: path.join(dir, 'slice15c-live-inventory.json'),
  };
}

module.exports = {
  LOCKED_SCOPE,
  COMMITTED_COST_BASELINE,
  COST_SPIKE_MULTIPLIER,
  EXPECTED_IAC_DELTA,
  DEPLOY_SEQUENCE_15D,
  FORBIDDEN_MUTATION_SURFACE,
  sha256Hex,
  classifyImageProvenance,
  evaluateSunsetRolloutPreflight,
  evaluateExpectedWhatIfSurface,
  evaluateCost,
  assertBicepDeclaresWebhookSlug,
  fixturePaths,
  extractPlainEnvMap,
  getPlainValue,
};
