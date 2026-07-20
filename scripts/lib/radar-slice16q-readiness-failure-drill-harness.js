'use strict';

/**
 * radar-slice16q-readiness-failure-drill-harness — RADAR Slice 16Q locks + helpers.
 *
 * Fail-closed operator harness for a controlled ACA database-readiness failure
 * and exact restoration. Source-only in this slice: do not execute live.
 *
 * Never reads or prints secret values. Mutates only WOLFHOUSE_DATABASE_URL
 * (secretRef → unreachable non-secret PostgreSQL DSN) under explicit
 * --apply --confirm with the exact token.
 *
 * Safety invariants:
 * - Every Azure update invocation marks mutation-attempted BEFORE spawn.
 * - Restoration runs unconditionally in finally after any mutation attempt.
 * - restorationRequired clears only after exact verification succeeds.
 * - Signals abort forward mutation and await restoration before exit.
 * - Errors/evidence use allowlisted categories only (never arbitrary bodies).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MASTER_BASIS = '06b7a3f2173863afa81bfc557cd31cbd3e80d6c1';
const IMAGE_SHA_SHORT = '594247f';
const IMAGE_SHA_FULL = '594247f12a823e9b90140c56eb8645b057e1fd37';
const SLICE = 'RADAR-16Q';
const OUTCOME_ID = '16Q_readiness_failure_drill_harness';
const GATE_ID = 'G02_readiness_dependencies';
const PROGRESS_CLASS = 'source_partial_progress_only';
const BRANCH = 'radar/slice-16q-readiness-failure-drill-harness';

const DATABASE_ENV_NAME = 'WOLFHOUSE_DATABASE_URL';
const CONFIRM_TOKEN = 'RADAR-16Q-READINESS-FAILURE-DRILL';

/** Non-secret unreachable DSN — never a real credential. */
const UNREACHABLE_DSN =
  'postgresql://radar16q_drill:unreachable@127.0.0.1:1/radar16q_unreachable?connect_timeout=1&sslmode=disable';

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';

/**
 * Exact Azure account + directory locks. Verified via `az account show`
 * before any mutation. Source-only slice: live apply must use this identity.
 */
const AZURE_ACCOUNT_USER = 'ty@wolfhouse.io';
/** Source-only AAD directory lock pin — live apply must match az account show.tenantId. */
const AZURE_TENANT_ID = 'c0ffeeee-16a0-4a11-8ccc-000000000016';

function resourceIdFor(rg, app) {
  return `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${rg}/providers/Microsoft.App/containerApps/${app}`;
}

const TENANTS = Object.freeze({
  wolfhouse: Object.freeze({
    id: 'wolfhouse',
    subscriptionId: SUBSCRIPTION_ID,
    accountUser: AZURE_ACCOUNT_USER,
    azureTenantId: AZURE_TENANT_ID,
    resourceGroup: 'wh-staging-rg',
    containerApp: 'wh-staging-staff-api',
    resourceId: resourceIdFor('wh-staging-rg', 'wh-staging-staff-api'),
    publicBaseUrl: 'https://staff-staging.lunafrontdesk.com',
    fqdn: 'staff-staging.lunafrontdesk.com',
    imageRepository: 'whstagingacr.azurecr.io/wh-staff-api',
    expectedImage: `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_SHA_FULL}`,
    expectedSecretRef: 'wolfhouse-database-url',
  }),
  sunset: Object.freeze({
    id: 'sunset',
    subscriptionId: SUBSCRIPTION_ID,
    accountUser: AZURE_ACCOUNT_USER,
    azureTenantId: AZURE_TENANT_ID,
    resourceGroup: 'luna-sunset-staging-rg',
    containerApp: 'luna-sunset-staging-staff-api',
    resourceId: resourceIdFor('luna-sunset-staging-rg', 'luna-sunset-staging-staff-api'),
    publicBaseUrl: 'https://sunset-staging.lunafrontdesk.com',
    fqdn: 'sunset-staging.lunafrontdesk.com',
    imageRepository: 'whstagingacr.azurecr.io/luna-sunset-staff-api',
    expectedImage: `whstagingacr.azurecr.io/luna-sunset-staff-api:${IMAGE_SHA_FULL}`,
    expectedSecretRef: 'sunset-database-url',
  }),
});

const FORBIDDEN_RESOURCE_GROUPS = Object.freeze([
  'wh-prod-rg',
  'wolfhouse-prod-rg',
  'luna-sunset-prod-rg',
  'luna-prod-rg',
]);

const FORBIDDEN_HOST_SUFFIXES = Object.freeze([
  'staff.lunafrontdesk.com',
  'portal.lunafrontdesk.com',
  'api.lunafrontdesk.com',
]);

const FORBIDDEN_HOST_TOKENS = Object.freeze(['prod', 'production']);

const DEFAULT_POLL = Object.freeze({
  failureTimeoutMs: 180000,
  restoreTimeoutMs: 300000,
  intervalMs: 5000,
});

const DEFAULT_AZ_TIMEOUT_MS = 120000;
const DEFAULT_RESTORE_RETRIES = 3;

/** Allowlisted error/evidence categories — never arbitrary response bodies. */
const ERROR_CATEGORIES = Object.freeze([
  'cli_refused',
  'scope_mismatch',
  'baseline_invalid',
  'confirm_required',
  'mutation_failed',
  'observation_failed',
  'traffic_drift',
  'endpoint_unhealthy',
  'restore_failed',
  'restore_verify_failed',
  'timeout',
  'aborted',
  'poll_timeout',
  'subprocess_failed',
  'internal',
  'template_drift',
  'image_mismatch',
  'revision_misclassified',
  'absent_field',
  'forward_mutation_blocked',
]);

const CONTRACT_REL = 'fixtures/radar-operations/slice16q-expected-contract.json';

const OWNED_RELS = Object.freeze([
  CONTRACT_REL,
  'scripts/lib/radar-slice16q-readiness-failure-drill-harness.js',
  'scripts/radar-slice16q-readiness-failure-drill.js',
  'scripts/verify-radar-slice16q-readiness-failure-drill-harness.js',
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
  'infra/azure/staging/main.bicep',
  'infra/azure/sunset-staging/main.bicep',
  'infra/azure/staging-staff-api-metric-alerts/',
  'infra/azure/staging-cost-budgets/',
]);

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function fail(code, message, detail) {
  const category = ERROR_CATEGORIES.includes(code)
    ? code
    : (detail && detail.category && ERROR_CATEGORIES.includes(detail.category)
      ? detail.category
      : 'internal');
  const err = new Error(message || code);
  err.code = code;
  err.category = category;
  if (detail !== undefined) {
    err.detail = sanitizeEvidenceValue(detail);
  }
  return err;
}

function sanitizeEvidenceValue(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.slice(0, 200);
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((x) => sanitizeEvidenceValue(x));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const lower = String(k).toLowerCase();
    if (
      lower.includes('body')
      || lower.includes('stdout')
      || lower.includes('stderr')
      || lower.includes('password')
      || lower.includes('secret')
      || lower === 'raw'
      || lower === 'response'
    ) {
      out[k] = '[REDACTED_CATEGORY_ONLY]';
      continue;
    }
    out[k] = sanitizeEvidenceValue(v);
  }
  return out;
}

function sanitizeError(err) {
  if (!err) {
    return { category: 'internal', code: 'unknown', message: 'unknown' };
  }
  const code = trimStr(err.code) || 'unknown';
  const category = ERROR_CATEGORIES.includes(err.category)
    ? err.category
    : (ERROR_CATEGORIES.includes(code) ? code : 'internal');
  return {
    category,
    code,
    message: trimStr(err.message).slice(0, 200),
  };
}

function parseCliArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const out = {
    tenant: null,
    apply: false,
    confirm: null,
    help: false,
    unknown: [],
    positionals: [],
  };

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }
    if (a === '--apply') {
      out.apply = true;
      continue;
    }
    if (a === '--tenant') {
      out.tenant = trimStr(args[i + 1] || '');
      i += 1;
      continue;
    }
    if (a.startsWith('--tenant=')) {
      out.tenant = trimStr(a.slice('--tenant='.length));
      continue;
    }
    if (a === '--confirm') {
      out.confirm = trimStr(args[i + 1] || '');
      i += 1;
      continue;
    }
    if (a.startsWith('--confirm=')) {
      out.confirm = trimStr(a.slice('--confirm='.length));
      continue;
    }
    if (a.startsWith('-')) {
      out.unknown.push(a);
      continue;
    }
    out.positionals.push(a);
  }
  return out;
}

function resolveTenant(tenantId) {
  const id = trimStr(tenantId).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(TENANTS, id)) {
    throw fail('tenant_required', 'Support only explicit --tenant wolfhouse|sunset', {
      category: 'cli_refused',
    });
  }
  return TENANTS[id];
}

function assertConfirmForApply(parsed) {
  if (!parsed.apply) {
    return { mode: 'dry-run' };
  }
  if (parsed.confirm !== CONFIRM_TOKEN) {
    throw fail(
      'confirm_token_mismatch',
      `Apply refused: --confirm must be exact token ${CONFIRM_TOKEN}`,
      { category: 'confirm_required' },
    );
  }
  return { mode: 'apply' };
}

/** Library apply path also requires exact confirmation token. */
function assertLibraryApplyConfirm(opts) {
  const mode = opts && opts.mode;
  if (mode !== 'apply') return;
  if ((opts && opts.confirm) !== CONFIRM_TOKEN) {
    throw fail(
      'confirm_token_mismatch',
      `Library apply refused: confirm must be exact token ${CONFIRM_TOKEN}`,
      { category: 'confirm_required' },
    );
  }
}

function assertCliFailClosed(parsed) {
  if (parsed.help) return { help: true };
  if (parsed.unknown.length) {
    throw fail('unknown_flag', `Unknown flag(s): ${parsed.unknown.join(' ')}`, {
      category: 'cli_refused',
    });
  }
  if (parsed.positionals.length) {
    throw fail('unexpected_positional', `Unexpected positional(s): ${parsed.positionals.join(' ')}`, {
      category: 'cli_refused',
    });
  }
  if (!parsed.tenant) {
    throw fail('tenant_required', 'Support only explicit --tenant wolfhouse|sunset', {
      category: 'cli_refused',
    });
  }
  const tenant = resolveTenant(parsed.tenant);
  const mode = assertConfirmForApply(parsed);
  return { help: false, tenant, mode: mode.mode, confirm: parsed.confirm || null };
}

function isForbiddenHost(urlOrHost) {
  const raw = trimStr(urlOrHost).toLowerCase();
  let host = raw;
  try {
    if (raw.includes('://')) host = new URL(raw).hostname;
  } catch (_) {
    host = raw.replace(/^https?:\/\//, '').split('/')[0];
  }
  if (!host) return true;
  for (const suffix of FORBIDDEN_HOST_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }
  for (const token of FORBIDDEN_HOST_TOKENS) {
    if (host.split('.').includes(token) || host.includes(`-${token}-`) || host.startsWith(`${token}.`)) {
      return true;
    }
  }
  if (host.includes('prod') && !host.includes('staging')) return true;
  return false;
}

function assertTenantPins(tenant) {
  if (!tenant || !TENANTS[tenant.id]) {
    throw fail('tenant_invalid', 'Unknown tenant', { category: 'cli_refused' });
  }
  if (tenant.subscriptionId !== SUBSCRIPTION_ID) {
    throw fail('wrong_subscription', `Subscription lock mismatch: ${tenant.subscriptionId}`, {
      category: 'scope_mismatch',
    });
  }
  if (FORBIDDEN_RESOURCE_GROUPS.includes(tenant.resourceGroup)) {
    throw fail('production_rg_refused', `Production RG refused: ${tenant.resourceGroup}`, {
      category: 'scope_mismatch',
    });
  }
  if (!tenant.resourceGroup.endsWith('-staging-rg') && !/-staging-/.test(tenant.resourceGroup)) {
    throw fail('non_staging_rg_refused', `Non-staging RG refused: ${tenant.resourceGroup}`, {
      category: 'scope_mismatch',
    });
  }
  if (isForbiddenHost(tenant.publicBaseUrl) || isForbiddenHost(tenant.fqdn)) {
    throw fail('production_host_refused', `Production host refused: ${tenant.publicBaseUrl}`, {
      category: 'scope_mismatch',
    });
  }
  const wantRid = resourceIdFor(tenant.resourceGroup, tenant.containerApp);
  if (tenant.resourceId !== wantRid) {
    throw fail('wrong_resource', `Resource ID lock mismatch`, { category: 'scope_mismatch' });
  }
  return true;
}

function assertAzureAccountLock(accountShow, tenant) {
  if (!accountShow || typeof accountShow !== 'object') {
    throw fail('azure_account_missing', 'az account show payload required', {
      category: 'scope_mismatch',
    });
  }
  if (trimStr(accountShow.id) !== SUBSCRIPTION_ID) {
    throw fail('wrong_subscription', 'Azure account subscription mismatch', {
      category: 'scope_mismatch',
    });
  }
  if (trimStr(accountShow.tenantId) !== AZURE_TENANT_ID) {
    throw fail('wrong_azure_tenant', 'Azure AD tenant mismatch', {
      category: 'scope_mismatch',
    });
  }
  const userName = trimStr(accountShow.user && accountShow.user.name);
  if (userName !== AZURE_ACCOUNT_USER) {
    throw fail('wrong_azure_account', 'Azure account user mismatch', {
      category: 'scope_mismatch',
    });
  }
  if (tenant) {
    if (trimStr(accountShow.id) !== tenant.subscriptionId) {
      throw fail('wrong_subscription', 'Tenant subscription lock mismatch', {
        category: 'scope_mismatch',
      });
    }
  }
  return true;
}

function assertAppResourceLock(appShow, tenant) {
  if (!appShow || typeof appShow !== 'object') {
    throw fail('app_show_missing', 'Missing container app show payload', {
      category: 'baseline_invalid',
    });
  }
  const id = trimStr(appShow.id);
  if (id && id !== tenant.resourceId) {
    throw fail('wrong_resource', `App resource ID mismatch`, { category: 'scope_mismatch' });
  }
  const name = trimStr(appShow.name);
  if (name && name !== tenant.containerApp) {
    throw fail('wrong_resource', `App name mismatch`, { category: 'scope_mismatch' });
  }
  const fqdn = trimStr(
    appShow.properties
    && appShow.properties.configuration
    && appShow.properties.configuration.ingress
    && appShow.properties.configuration.ingress.fqdn,
  );
  if (fqdn && fqdn !== tenant.fqdn) {
    throw fail('wrong_fqdn', `Ingress FQDN mismatch: ${fqdn}`, { category: 'scope_mismatch' });
  }
  return true;
}

function getTemplate(appShow) {
  return appShow && appShow.properties && appShow.properties.template;
}

function getContainers(appShow) {
  const template = getTemplate(appShow);
  const containers = template && template.containers;
  if (!Array.isArray(containers) || containers.length < 1) {
    throw fail('template_missing_containers', 'App template has no containers', {
      category: 'baseline_invalid',
    });
  }
  return containers;
}

function primaryContainer(appShow) {
  return getContainers(appShow)[0];
}

function findEnvEntry(container, name) {
  const env = Array.isArray(container && container.env) ? container.env : [];
  return env.find((e) => e && e.name === name) || null;
}

function parseImage(image) {
  const raw = trimStr(image);
  if (!raw) return { ok: false, reason: 'image_missing', repository: '', tag: '', raw: '' };
  const idx = raw.lastIndexOf(':');
  if (idx < 0) {
    return { ok: false, reason: 'image_tag_missing', repository: raw, tag: '', raw };
  }
  return {
    ok: true,
    repository: raw.slice(0, idx),
    tag: raw.slice(idx + 1),
    raw,
  };
}

/** Exact image equality against tenant.expectedImage — never substring SHA match. */
function assertImagePinned(image, tenant) {
  const parsed = parseImage(image);
  if (!parsed.ok) {
    throw fail(parsed.reason || 'image_invalid', 'Image missing or untagged', {
      category: 'image_mismatch',
      ...parsed,
    });
  }
  const expected = tenant && tenant.expectedImage;
  if (!expected) {
    throw fail('image_expected_missing', 'Tenant expectedImage lock missing', {
      category: 'image_mismatch',
    });
  }
  if (parsed.raw !== expected) {
    throw fail('wrong_image_sha', `Image must equal exact pin ${expected}`, {
      category: 'image_mismatch',
      expected,
      actual: parsed.raw,
    });
  }
  const tag = parsed.tag.toLowerCase();
  if (tag === 'latest' || tag === 'staging' || tag === 'prod' || tag === 'production') {
    throw fail('mutable_image_refused', `Mutable image tag refused: ${parsed.tag}`, {
      category: 'image_mismatch',
    });
  }
  return parsed;
}

function probeTypes(container) {
  const probes = Array.isArray(container && container.probes) ? container.probes : [];
  const types = new Set();
  for (const p of probes) {
    const t = trimStr(p && (p.type || p.probeType));
    if (t) types.add(t);
  }
  return { probes, types };
}

function assertProbesPresent(container) {
  const { probes, types } = probeTypes(container);
  if (probes.length < 1) {
    throw fail('probes_missing', 'Container probes missing', { category: 'baseline_invalid' });
  }
  for (const need of ['Startup', 'Liveness', 'Readiness']) {
    if (![...types].some((t) => t.toLowerCase() === need.toLowerCase())) {
      throw fail('probes_incomplete', `Missing ${need} probe`, { category: 'baseline_invalid' });
    }
  }
  return probes;
}

function assertDatabaseSecretRef(container, tenant) {
  const entry = findEnvEntry(container, DATABASE_ENV_NAME);
  if (!entry) {
    throw fail('database_env_missing', `${DATABASE_ENV_NAME} missing from container env`, {
      category: 'baseline_invalid',
    });
  }
  if (Object.prototype.hasOwnProperty.call(entry, 'value') && entry.value != null && entry.value !== '') {
    throw fail('database_env_plaintext_refused', `${DATABASE_ENV_NAME} must be secretRef, not plaintext value`, {
      category: 'baseline_invalid',
    });
  }
  const ref = trimStr(entry.secretRef);
  if (!ref) {
    throw fail('database_secret_ref_missing', `${DATABASE_ENV_NAME} missing secretRef`, {
      category: 'baseline_invalid',
    });
  }
  if (tenant && ref !== tenant.expectedSecretRef) {
    throw fail('database_secret_ref_mismatch', `Expected secretRef ${tenant.expectedSecretRef}, got ${ref}`, {
      category: 'baseline_invalid',
    });
  }
  return { name: DATABASE_ENV_NAME, secretRef: ref };
}

function trafficWeights(appShow) {
  const traffic = appShow
    && appShow.properties
    && appShow.properties.configuration
    && appShow.properties.configuration.ingress
    && appShow.properties.configuration.ingress.traffic;
  return Array.isArray(traffic) ? traffic : [];
}

function canonicalTraffic(appShow) {
  return trafficWeights(appShow).map((t) => ({
    revisionName: trimStr(t && t.revisionName) || null,
    label: trimStr(t && t.label) || null,
    weight: Number(t && t.weight),
    latestRevision: t && t.latestRevision === true,
  }));
}

function assertSingleRevisionTraffic(appShow) {
  const traffic = trafficWeights(appShow);
  const active = traffic.filter((t) => Number(t && t.weight) > 0);
  if (active.length !== 1) {
    throw fail('multi_revision_traffic', 'Refuse multi-revision traffic; need exactly one weight>0 entry', {
      category: 'baseline_invalid',
      activeCount: active.length,
    });
  }
  const only = active[0];
  if (Number(only.weight) !== 100) {
    throw fail('traffic_not_100', 'Active traffic weight must be 100', {
      category: 'baseline_invalid',
    });
  }
  return {
    revisionName: trimStr(only.revisionName) || null,
    label: trimStr(only.label) || null,
    weight: 100,
    latestRevision: only.latestRevision === true,
  };
}

function latestReadyRevisionName(appShow) {
  return trimStr(
    appShow
      && appShow.properties
      && appShow.properties.latestReadyRevisionName,
  );
}

/**
 * Snapshot complete original properties.template + exact ingress traffic
 * (revision/label/weight) for canonical compare on restore.
 */
function snapshotOriginal(appShow) {
  const template = getTemplate(appShow);
  if (!template || typeof template !== 'object') {
    throw fail('template_missing', 'properties.template missing', { category: 'baseline_invalid' });
  }
  const traffic = canonicalTraffic(appShow);
  return {
    template: deepClone(template),
    traffic,
    image: trimStr(primaryContainer(appShow).image),
    dbSecretRef: assertDatabaseSecretRef(primaryContainer(appShow)).secretRef,
    latestReadyRevisionName: latestReadyRevisionName(appShow),
  };
}

function canonicalJson(v) {
  return JSON.stringify(v);
}

function assertExactTemplateMatch(originalSnapshot, appShow) {
  const current = getTemplate(appShow);
  if (canonicalJson(originalSnapshot.template) !== canonicalJson(current)) {
    throw fail('restore_template_mismatch', 'Restored properties.template does not match original', {
      category: 'template_drift',
    });
  }
  return true;
}

function assertExactTrafficMatch(originalSnapshot, appShow) {
  const current = canonicalTraffic(appShow);
  if (canonicalJson(originalSnapshot.traffic) !== canonicalJson(current)) {
    throw fail('restore_traffic_mismatch', 'Restored ingress traffic does not match original', {
      category: 'traffic_drift',
    });
  }
  return true;
}

/**
 * Verify containers/env/resources/scale/volumes/initContainers/probes,
 * exact traffic target, public endpoints, image, and DB secretRef.
 */
function assertCompleteRestore({
  appShow,
  tenant,
  originalSnapshot,
  healthStatus,
  readyStatus,
}) {
  assertAppResourceLock(appShow, tenant);
  assertExactTemplateMatch(originalSnapshot, appShow);
  assertExactTrafficMatch(originalSnapshot, appShow);

  const template = getTemplate(appShow);
  const requiredTemplateKeys = [
    'containers',
    'scale',
    'volumes',
    'initContainers',
  ];
  // Present keys in original must remain byte-equal (already covered by template match).
  // Explicitly touch fields so callers/tests know the contract.
  for (const key of requiredTemplateKeys) {
    if (Object.prototype.hasOwnProperty.call(originalSnapshot.template, key)) {
      if (canonicalJson(originalSnapshot.template[key]) !== canonicalJson(template[key])) {
        throw fail('restore_template_field_mismatch', `Template field ${key} drifted`, {
          category: 'template_drift',
          field: key,
        });
      }
    }
  }

  const container = primaryContainer(appShow);
  const image = assertImagePinned(container.image, tenant);
  if (image.raw !== originalSnapshot.image) {
    throw fail('restore_image_mismatch', 'Restored image does not match original', {
      category: 'image_mismatch',
    });
  }
  assertProbesPresent(container);
  const dbEnv = assertDatabaseSecretRef(container, tenant);
  if (dbEnv.secretRef !== originalSnapshot.dbSecretRef) {
    throw fail('restore_secret_ref_mismatch', 'Restored secretRef does not match original', {
      category: 'restore_verify_failed',
    });
  }
  const entry = findEnvEntry(container, DATABASE_ENV_NAME);
  if (entry && Object.prototype.hasOwnProperty.call(entry, 'value') && entry.value) {
    throw fail('restore_still_plaintext', 'Database env still plaintext after restore', {
      category: 'restore_verify_failed',
    });
  }

  const traffic = assertSingleRevisionTraffic(appShow);
  if (Number(healthStatus) !== 200 || Number(readyStatus) !== 200) {
    throw fail('restore_endpoints_unhealthy', 'Public endpoints not 200 after restore', {
      category: 'endpoint_unhealthy',
      health: healthStatus,
      ready: readyStatus,
    });
  }

  return { image, dbEnv, traffic };
}

function assertBaselineState({ appShow, tenant, accountShow }) {
  assertTenantPins(tenant);
  if (accountShow) assertAzureAccountLock(accountShow, tenant);
  assertAppResourceLock(appShow, tenant);
  const container = primaryContainer(appShow);
  const image = assertImagePinned(container.image, tenant);
  const probes = assertProbesPresent(container);
  const dbEnv = assertDatabaseSecretRef(container, tenant);
  const traffic = assertSingleRevisionTraffic(appShow);
  const latestReady = latestReadyRevisionName(appShow);
  if (!latestReady) {
    throw fail('latest_ready_missing', 'latestReadyRevisionName missing', {
      category: 'baseline_invalid',
    });
  }
  const original = snapshotOriginal(appShow);
  return {
    containerName: trimStr(container.name) || tenant.containerApp,
    image,
    probes,
    dbEnv,
    traffic,
    latestReadyRevisionName: latestReady,
    original,
  };
}

/**
 * Build a temporary app template that changes ONLY WOLFHOUSE_DATABASE_URL
 * from secretRef to the unreachable non-secret DSN. All other fields preserved.
 */
function buildFailureTemplate(appShow, tenant) {
  const baseline = assertBaselineState({ appShow, tenant });
  const next = deepClone(appShow);
  const container = primaryContainer(next);
  const env = container.env;
  const idx = env.findIndex((e) => e && e.name === DATABASE_ENV_NAME);
  if (idx < 0) {
    throw fail('database_env_missing', `${DATABASE_ENV_NAME} missing`, {
      category: 'baseline_invalid',
    });
  }
  env[idx] = { name: DATABASE_ENV_NAME, value: UNREACHABLE_DSN };
  const delta = {
    env_name: DATABASE_ENV_NAME,
    from: { secretRef: baseline.dbEnv.secretRef },
    to: { value: UNREACHABLE_DSN, secret: false },
  };
  return { app: next, baseline, delta };
}

function envDeltaOnlyDatabase(originalApp, mutatedApp) {
  const a = primaryContainer(originalApp).env || [];
  const b = primaryContainer(mutatedApp).env || [];
  if (a.length !== b.length) return { ok: false, reason: 'env_length_changed' };
  const changes = [];
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i] || {};
    const right = b[i] || {};
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    changes.push({ index: i, name: left.name || right.name, from: left, to: right });
  }
  if (changes.length !== 1) return { ok: false, reason: 'env_change_count', changes };
  if (changes[0].name !== DATABASE_ENV_NAME) {
    return { ok: false, reason: 'wrong_env_changed', changes };
  }
  const oa = deepClone(originalApp);
  const ma = deepClone(mutatedApp);
  const oEnv = primaryContainer(oa).env;
  const mEnv = primaryContainer(ma).env;
  oEnv[changes[0].index] = { __stripped: true };
  mEnv[changes[0].index] = { __stripped: true };
  if (JSON.stringify(oa) !== JSON.stringify(ma)) {
    return { ok: false, reason: 'non_env_template_drift' };
  }
  return { ok: true, changes };
}

function revisionNameSet(revisions) {
  const set = new Set();
  for (const r of Array.isArray(revisions) ? revisions : []) {
    const n = trimStr(r && (r.name || r.id));
    if (n) set.add(n);
  }
  return set;
}

/** Identify only set-difference new revision names vs pre-mutation set. */
function newRevisionNames(preNames, currentRevisions) {
  const pre = preNames instanceof Set ? preNames : new Set(preNames || []);
  const next = revisionNameSet(currentRevisions);
  const added = [];
  for (const n of next) {
    if (!pre.has(n)) added.push(n);
  }
  return added;
}

function requireExplicitField(obj, pathParts, label) {
  let cur = obj;
  for (const p of pathParts) {
    if (cur == null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, p)) {
      throw fail('absent_field', `Required field absent: ${label || pathParts.join('.')}`, {
        category: 'absent_field',
        field: label || pathParts.join('.'),
      });
    }
    cur = cur[p];
  }
  return cur;
}

/**
 * Classify failed revision from separate revision-show + replica-list payloads.
 * No defaulting of absent values — fields must be explicit.
 */
function classifyFailedRevision({ revisionShow, replicaList, latestReadyRevisionName: latestReady, preRevisionNames }) {
  if (!revisionShow || typeof revisionShow !== 'object') {
    return { ok: false, reason: 'revision_show_missing' };
  }
  const name = trimStr(revisionShow.name || revisionShow.id);
  if (!name) return { ok: false, reason: 'revision_name_missing' };

  if (preRevisionNames) {
    const pre = preRevisionNames instanceof Set ? preRevisionNames : new Set(preRevisionNames);
    if (pre.has(name)) {
      return { ok: false, reason: 'old_revision_misclassified', name };
    }
  }

  const props = revisionShow.properties;
  if (!props || typeof props !== 'object') {
    return { ok: false, reason: 'revision_properties_missing' };
  }

  let healthState;
  let provisioningState;
  let runningState;
  let degraded;
  try {
    healthState = requireExplicitField(props, ['healthState'], 'properties.healthState');
    provisioningState = requireExplicitField(props, ['provisioningState'], 'properties.provisioningState');
    runningState = requireExplicitField(props, ['runningState'], 'properties.runningState');
    if (Object.prototype.hasOwnProperty.call(props, 'degraded')) {
      degraded = props.degraded;
    } else {
      throw fail('absent_field', 'Required field absent: properties.degraded', {
        category: 'absent_field',
      });
    }
  } catch (e) {
    if (e && e.code === 'absent_field') {
      return { ok: false, reason: 'absent_field', field: e.detail && e.detail.field };
    }
    throw e;
  }

  const replicas = Array.isArray(replicaList) ? replicaList : null;
  if (!replicas || replicas.length < 1) {
    return { ok: false, reason: 'replica_list_missing' };
  }
  const replica = replicas[0];
  const requiredReplica = ['runningState', 'running', 'started', 'ready', 'restartCount'];
  for (const f of requiredReplica) {
    if (!Object.prototype.hasOwnProperty.call(replica, f)) {
      return { ok: false, reason: 'absent_field', field: `replica.${f}` };
    }
  }

  const observations = {
    name,
    healthState: trimStr(healthState),
    provisioningState: trimStr(provisioningState),
    runningState: trimStr(runningState),
    degraded: degraded === true,
    replica: {
      runningState: trimStr(replica.runningState),
      running: replica.running === true,
      started: replica.started === true,
      ready: replica.ready === true,
      restartCount: replica.restartCount,
    },
    isLatestReady: Boolean(latestReady) && name === latestReady,
    isNewVsPreSet: preRevisionNames
      ? !(preRevisionNames instanceof Set ? preRevisionNames : new Set(preRevisionNames)).has(name)
      : true,
  };

  // Contract: Running / started=true / ready=false / restartCount=0 / not latest-ready.
  // healthState may be Unhealthy/Degraded; provisioning Provisioned; degraded may be true.
  const pass = observations.replica.started === true
    && observations.replica.ready === false
    && observations.replica.restartCount === 0
    && observations.replica.running === true
    && observations.isLatestReady === false
    && observations.isNewVsPreSet === true
    && (observations.runningState === 'Running' || observations.runningState === 'RunningAtMaxScale')
    && (observations.provisioningState === 'Provisioned');

  return { ok: pass, observations, reason: pass ? null : 'failed_revision_not_observed' };
}

function assertFailedRevisionObservation(payload, ctx) {
  const result = classifyFailedRevision({ ...payload, ...ctx });
  if (!result.ok) {
    throw fail('failed_revision_not_observed', 'Failed revision observation did not match contract', {
      category: 'observation_failed',
      reason: result.reason,
      observations: result.observations,
    });
  }
  return result.observations;
}

function assertRestoredState({
  appShow,
  tenant,
  originalSnapshot,
  healthStatus,
  readyStatus,
}) {
  return assertCompleteRestore({
    appShow,
    tenant,
    originalSnapshot,
    healthStatus: healthStatus != null ? healthStatus : 200,
    readyStatus: readyStatus != null ? readyStatus : 200,
  });
}

function assertTrafficUnchanged(originalTraffic, appShow) {
  const current = canonicalTraffic(appShow);
  if (canonicalJson(originalTraffic) !== canonicalJson(current)) {
    throw fail('traffic_drift', 'Ingress traffic drifted during failure window', {
      category: 'traffic_drift',
    });
  }
  return true;
}

function redactSecretsDeep(value, seen) {
  const walk = (v, s) => {
    if (v == null) return v;
    if (typeof v !== 'object') return v;
    if (s.has(v)) return '[Circular]';
    s.add(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, s));
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const key = String(k);
      const lower = key.toLowerCase();
      if (
        lower.includes('password')
        || lower.includes('secret')
        || (lower === 'value' && typeof val === 'string' && /postgres(ql)?:\/\//i.test(val))
        || lower.endsWith('connectionstring')
        || lower === 'body'
        || lower === 'stdout'
        || lower === 'stderr'
      ) {
        if (key === 'secretRef' || lower === 'secretref') {
          out[k] = val;
          continue;
        }
        if (typeof val === 'string' && val === UNREACHABLE_DSN) {
          out[k] = UNREACHABLE_DSN;
          continue;
        }
        out[k] = '[REDACTED]';
        continue;
      }
      if (key === 'secrets' && Array.isArray(val)) {
        out[k] = val.map((item) => {
          if (!item || typeof item !== 'object') return item;
          const copy = { ...item };
          if (Object.prototype.hasOwnProperty.call(copy, 'value')) copy.value = '[REDACTED]';
          return copy;
        });
        continue;
      }
      out[k] = walk(val, s);
    }
    return out;
  };
  return walk(value, seen || new WeakSet());
}

function buildEvidenceSkeleton({ tenant, mode, workDir }) {
  return {
    schema_version: 1,
    slice: SLICE,
    outcome_id: OUTCOME_ID,
    gate_id: GATE_ID,
    progress_class: PROGRESS_CLASS,
    master_basis: MASTER_BASIS,
    branch: BRANCH,
    mode,
    live_executed: false,
    mutation_attempted: false,
    tenant: tenant.id,
    subscriptionId: tenant.subscriptionId,
    azureTenantId: tenant.azureTenantId,
    accountUser: tenant.accountUser,
    resourceGroup: tenant.resourceGroup,
    containerApp: tenant.containerApp,
    resourceId: tenant.resourceId,
    publicBaseUrl: tenant.publicBaseUrl,
    fqdn: tenant.fqdn,
    database_env: DATABASE_ENV_NAME,
    image_exact_required: tenant.expectedImage,
    image_sha_short_required: IMAGE_SHA_SHORT,
    workDir,
    claims_allowed: mode === 'apply'
      ? ['apply_path_executed']
      : ['dry_run_plan_only'],
    explicitly_not_claimed: [
      'live_drill_completed_in_16q_source_slice',
      'dependency_failure_proven',
      'production',
      'secret_values',
    ],
    steps: [],
    timestamps_utc: {},
  };
}

function createWorkDir(opts) {
  const mkdtemp = (opts && opts.mkdtemp) || ((prefix) => fs.mkdtempSync(prefix));
  const tmpRoot = (opts && opts.tmpRoot) || os.tmpdir();
  const dir = mkdtemp(path.join(tmpRoot, 'radar16q-'));
  if (dir.startsWith(path.join(__dirname, '..', '..'))) {
    throw fail('workdir_inside_repo', 'Work dir must be outside repo', { category: 'internal' });
  }
  return dir;
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

/**
 * Cancellable async subprocess with hard timeout.
 * Replaces execFileSync for Azure CLI invocations.
 */
function runSubprocessAsync(command, args, opts) {
  const options = opts || {};
  const timeoutMs = options.timeoutMs != null ? options.timeoutMs : DEFAULT_AZ_TIMEOUT_MS;
  const signal = options.signal;
  const spawnFn = options.spawnFn || spawn;

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(fail('aborted', 'Subprocess aborted before spawn', { category: 'aborted' }));
      return;
    }

    let settled = false;
    let timedOut = false;
    let killedByAbort = false;
    const child = spawnFn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env || process.env,
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    if (child.stdout) child.stdout.on('data', (c) => stdoutChunks.push(c));
    if (child.stderr) child.stderr.on('data', (c) => stderrChunks.push(c));

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }, timeoutMs);

    const onAbort = () => {
      killedByAbort = true;
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    };
    if (signal) {
      if (typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true });
      } else if (typeof signal.on === 'function') {
        signal.on('abort', onAbort);
      }
    }

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      if (err) reject(err);
      else resolve(result);
    };

    child.on('error', (err) => {
      finish(fail('subprocess_failed', `Failed to spawn ${command}`, {
        category: 'subprocess_failed',
        message: trimStr(err && err.message).slice(0, 120),
      }));
    });

    child.on('close', (code) => {
      if (timedOut) {
        finish(fail('timeout', `Subprocess timed out after ${timeoutMs}ms`, {
          category: 'timeout',
        }));
        return;
      }
      if (killedByAbort || (signal && signal.aborted)) {
        finish(fail('aborted', 'Subprocess aborted by signal', { category: 'aborted' }));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        finish(fail('subprocess_failed', `${command} exited ${code}`, {
          category: 'subprocess_failed',
          exitCode: code,
          // Never attach raw stderr/stdout bodies — category only.
        }));
        return;
      }
      finish(null, { code, stdout, stderr });
    });
  });
}

/**
 * Ensure every az invocation includes --subscription <locked id>.
 */
function withSubscriptionArgs(args, subscriptionId) {
  const sub = subscriptionId || SUBSCRIPTION_ID;
  const list = Array.isArray(args) ? args.slice() : [];
  const hasSub = list.some((a, i) => a === '--subscription' || (typeof a === 'string' && a.startsWith('--subscription=')));
  if (!hasSub) {
    list.push('--subscription', sub);
  }
  return list;
}

function installCleanupTrap(opts) {
  const {
    restore,
    onAfterRestore,
    signals = ['SIGINT', 'SIGTERM'],
    processRef = process,
    abortController,
    onAbort,
  } = opts || {};
  if (typeof restore !== 'function') {
    throw fail('restore_fn_required', 'Cleanup trap requires restore function', {
      category: 'internal',
    });
  }
  let armed = true;
  let restoring = false;
  let restorePromise = null;
  const state = {
    armed: true,
    restoreCalls: 0,
    lastError: null,
    aborted: false,
    awaitingRestore: false,
  };

  const runRestore = async (reason) => {
    if (!armed) return { skipped: true, reason: 'disarmed' };
    if (restoring && restorePromise) {
      state.awaitingRestore = true;
      return restorePromise;
    }
    restoring = true;
    state.restoreCalls += 1;
    state.awaitingRestore = true;
    restorePromise = (async () => {
      try {
        await restore(reason);
        if (typeof onAfterRestore === 'function') await onAfterRestore(reason);
        return { ok: true, reason };
      } catch (err) {
        state.lastError = err;
        throw err;
      } finally {
        restoring = false;
        state.awaitingRestore = false;
      }
    })();
    return restorePromise;
  };

  const handlers = {};
  for (const sig of signals) {
    handlers[sig] = () => {
      state.aborted = true;
      if (abortController && typeof abortController.abort === 'function') {
        try { abortController.abort(sig); } catch (_) { /* ignore */ }
      }
      if (typeof onAbort === 'function') {
        try { onAbort(sig); } catch (_) { /* ignore */ }
      }
      // Await restoration before allowing process exit.
      Promise.resolve(runRestore(`signal:${sig}`))
        .catch(() => {})
        .finally(() => {
          try {
            processRef.exitCode = processRef.exitCode || 130;
          } catch (_) { /* ignore */ }
        });
    };
    if (typeof processRef.on === 'function') processRef.on(sig, handlers[sig]);
  }

  return {
    state,
    async restoreNow(reason) {
      return runRestore(reason || 'explicit');
    },
    async awaitPendingRestore() {
      if (restorePromise) {
        try { await restorePromise; } catch (_) { /* surfaced elsewhere */ }
      }
    },
    disarm() {
      armed = false;
      state.armed = false;
      for (const sig of signals) {
        if (typeof processRef.removeListener === 'function' && handlers[sig]) {
          processRef.removeListener(sig, handlers[sig]);
        }
      }
    },
  };
}

async function sleepMs(ms, sleepFn) {
  const fn = sleepFn || ((n) => new Promise((r) => setTimeout(r, n)));
  await fn(ms);
}

async function pollUntil(predicate, opts) {
  const timeoutMs = (opts && opts.timeoutMs) != null ? opts.timeoutMs : 60000;
  const intervalMs = (opts && opts.intervalMs) != null ? opts.intervalMs : 1000;
  const now = (opts && opts.now) || (() => Date.now());
  const sleep = (opts && opts.sleep) || null;
  const label = (opts && opts.label) || 'poll';
  const signal = opts && opts.signal;
  const start = now();
  let last;
  for (;;) {
    if (signal && signal.aborted) {
      throw fail('aborted', `Aborted while waiting for ${label}`, { category: 'aborted' });
    }
    last = await predicate();
    if (last && last.ok) return last;
    if (now() - start >= timeoutMs) {
      throw fail('poll_timeout', `Timed out waiting for ${label}`, {
        category: 'poll_timeout',
        last: sanitizeEvidenceValue(last),
      });
    }
    await sleepMs(intervalMs, sleep);
  }
}

function checkRepoPreflight(deps) {
  const exec = deps && deps.execGit;
  if (typeof exec !== 'function') {
    throw fail('git_exec_required', 'git exec helper required', { category: 'internal' });
  }
  const status = trimStr(exec('git status --porcelain'));
  if (status) {
    throw fail('dirty_repo', 'Refuse dirty repo', { category: 'cli_refused' });
  }
  const head = trimStr(exec('git rev-parse HEAD'));
  const originMaster = trimStr(exec('git rev-parse origin/master'));
  if (originMaster !== MASTER_BASIS) {
    throw fail('wrong_master', `origin/master must be ${MASTER_BASIS}`, {
      category: 'cli_refused',
      originMaster,
      head,
    });
  }
  if (typeof deps.execAssertRepoSync === 'function') {
    deps.execAssertRepoSync();
  }
  return { head, originMaster };
}

/**
 * Dry-run plan truth: planned steps only; no mutation_attempted; no false live claims.
 */
function planDryRun({ tenant, baseline, delta, workDir }) {
  return {
    mode: 'dry-run',
    slice: SLICE,
    tenant: tenant.id,
    subscriptionId: tenant.subscriptionId,
    accountUser: tenant.accountUser,
    azureTenantId: tenant.azureTenantId,
    resourceGroup: tenant.resourceGroup,
    containerApp: tenant.containerApp,
    resourceId: tenant.resourceId,
    publicBaseUrl: tenant.publicBaseUrl,
    fqdn: tenant.fqdn,
    database_env: DATABASE_ENV_NAME,
    image: baseline.image.raw,
    image_exact: tenant.expectedImage,
    latestReadyRevisionName: baseline.latestReadyRevisionName,
    traffic: baseline.traffic,
    delta,
    workDir,
    mutation_attempted: false,
    live_mutation: false,
    executed: [],
    would: [
      'verify az account show against locked subscription/account/tenant',
      'capture complete properties.template + ingress traffic to temp outside repo',
      'capture pre-revision name set',
      'install cleanup trap + abort controller before mutation',
      'mark mutation-attempted BEFORE spawning az containerapp update',
      `set ${DATABASE_ENV_NAME} to unreachable non-secret DSN (narrow template only)`,
      'apply narrow template via cancellable async az with --subscription + hard timeout',
      'identify new revision via set-difference only',
      'observe failed revision via revision-show + replica-list (explicit fields; no defaults)',
      'continuously poll original traffic target/weight and public /healthz+/readyz during failure window',
      'restore exact original template + traffic if drifted (bounded retries in finally)',
      'verify complete template/traffic/image/secretRef/endpoints before clearing restoration-required',
      'write machine-readable redacted evidence (allowlisted categories only)',
    ],
    explicitly_not_executed_in_dry_run: [
      'azure_containerapp_update',
      'failure_inject',
      'restore',
    ],
  };
}

/**
 * Orchestrate dry-run or apply. Azure/HTTP/git injected via deps (tests mock).
 * Default path is dry-run; apply requires confirm token (CLI and library).
 */
async function runHarness(options) {
  const opts = options || {};
  const parsed = opts.parsed || assertCliFailClosed(parseCliArgs(opts.argv || []));
  if (parsed.help) {
    return { ok: true, help: true };
  }
  const tenant = parsed.tenant;
  assertTenantPins(tenant);
  const mode = parsed.mode;

  // Library apply also requires exact confirmation.
  assertLibraryApplyConfirm({
    mode,
    confirm: parsed.confirm != null ? parsed.confirm : opts.confirm,
  });

  const deps = opts.deps || {};
  const evidence = buildEvidenceSkeleton({
    tenant,
    mode,
    workDir: null,
  });
  evidence.timestamps_utc.started = new Date().toISOString();

  checkRepoPreflight({
    execGit: deps.execGit,
    execAssertRepoSync: deps.execAssertRepoSync,
  });
  evidence.steps.push({ id: 'repo_preflight', ok: true, category: 'baseline_invalid' });

  if (typeof deps.showApp !== 'function') {
    throw fail('show_app_required', 'showApp dependency required', { category: 'internal' });
  }

  let accountShow = null;
  if (typeof deps.showAccount === 'function') {
    accountShow = await deps.showAccount();
    assertAzureAccountLock(accountShow, tenant);
    evidence.steps.push({ id: 'azure_account_locked', ok: true, category: 'scope_mismatch' });
  } else if (mode === 'apply') {
    throw fail('azure_account_required', 'showAccount required for --apply', {
      category: 'scope_mismatch',
    });
  }

  const appShow = await deps.showApp(tenant);
  const baseline = assertBaselineState({ appShow, tenant, accountShow });
  evidence.steps.push({
    id: 'baseline_validated',
    ok: true,
    image: baseline.image.raw,
    secretRef: baseline.dbEnv.secretRef,
    latestReadyRevisionName: baseline.latestReadyRevisionName,
    resourceId: tenant.resourceId,
    traffic: baseline.traffic,
  });

  const workDir = opts.workDir || createWorkDir({
    mkdtemp: deps.mkdtemp,
    tmpRoot: deps.tmpRoot,
  });
  evidence.workDir = workDir;

  const originalPath = path.join(workDir, 'original-app.redacted.json');
  const failurePath = path.join(workDir, 'failure-template.redacted.json');
  const evidencePath = path.join(workDir, 'evidence.json');
  writeJson(originalPath, redactSecretsDeep({
    template: baseline.original.template,
    traffic: baseline.original.traffic,
    resourceId: tenant.resourceId,
  }));

  const { app: failureApp, delta } = buildFailureTemplate(appShow, tenant);
  const narrow = envDeltaOnlyDatabase(appShow, failureApp);
  if (!narrow.ok) {
    throw fail('template_delta_not_narrow', 'Failure template must change only database env', {
      category: 'template_drift',
      reason: narrow.reason,
    });
  }
  writeJson(failurePath, redactSecretsDeep({
    template: getTemplate(failureApp),
    delta,
  }));

  if (mode === 'dry-run') {
    const plan = planDryRun({ tenant, baseline, delta, workDir });
    evidence.steps.push({ id: 'dry_run_plan', ok: true, plan });
    evidence.live_executed = false;
    evidence.mutation_attempted = false;
    evidence.timestamps_utc.finished = new Date().toISOString();
    writeJson(evidencePath, evidence);
    return {
      ok: true,
      mode,
      plan,
      evidence,
      evidencePath,
      workDir,
      live_mutation: false,
      mutation_attempted: false,
    };
  }

  // ── apply path ──────────────────────────────────────────────────────────
  if (typeof deps.applyTemplate !== 'function' || typeof deps.listRevisions !== 'function') {
    throw fail('apply_deps_required', 'applyTemplate and listRevisions required for --apply', {
      category: 'internal',
    });
  }
  if (typeof deps.showRevision !== 'function' || typeof deps.listReplicas !== 'function') {
    throw fail('revision_deps_required', 'showRevision and listReplicas required for --apply', {
      category: 'internal',
    });
  }
  if (typeof deps.httpGet !== 'function') {
    throw fail('http_get_required', 'httpGet required for --apply', { category: 'internal' });
  }

  const AbortCtrl = deps.AbortController || (typeof AbortController !== 'undefined' ? AbortController : null);
  const abortController = AbortCtrl ? new AbortCtrl() : { aborted: false, abort() { this.aborted = true; }, signal: { aborted: false } };
  if (!abortController.signal) {
    abortController.signal = abortController;
  }

  let mutationAttempted = false;
  let restorationRequired = false;
  let restorationVerified = false;
  let forwardMutationAllowed = true;
  const restoreRetries = (opts.restoreRetries != null) ? opts.restoreRetries : DEFAULT_RESTORE_RETRIES;

  const markMutationAttempted = (purpose) => {
    if (!forwardMutationAllowed && purpose === 'failure_inject') {
      throw fail('forward_mutation_blocked', 'Abort set: further forward mutation refused', {
        category: 'forward_mutation_blocked',
      });
    }
    mutationAttempted = true;
    restorationRequired = true;
    evidence.mutation_attempted = true;
    evidence.steps.push({
      id: 'mutation_attempted',
      ok: true,
      purpose,
      before_spawn: true,
    });
  };

  const verifyRestored = async () => {
    const restoredShow = typeof deps.showAppAfter === 'function'
      ? await deps.showAppAfter(tenant)
      : await deps.showApp(tenant);
    const health = await deps.httpGet(`${tenant.publicBaseUrl}/healthz`);
    const ready = await deps.httpGet(`${tenant.publicBaseUrl}/readyz`);
    assertCompleteRestore({
      appShow: restoredShow,
      tenant,
      originalSnapshot: baseline.original,
      healthStatus: health.status,
      readyStatus: ready.status,
    });
    restorationVerified = true;
    restorationRequired = false;
    evidence.steps.push({
      id: 'restore_verified',
      ok: true,
      health: health.status,
      ready: ready.status,
    });
    return restoredShow;
  };

  const restoreWithRetries = async (reason) => {
    evidence.steps.push({
      id: 'restore_begin',
      ok: true,
      reason: String(reason || ''),
      restoration_required: restorationRequired,
    });
    let lastErr = null;
    for (let attempt = 1; attempt <= restoreRetries; attempt += 1) {
      try {
        // Traffic restore if drifted (apply original template includes traffic via dedicated call).
        if (typeof deps.applyTraffic === 'function') {
          const cur = typeof deps.showAppAfter === 'function'
            ? await deps.showAppAfter(tenant)
            : await deps.showApp(tenant);
          try {
            assertExactTrafficMatch(baseline.original, cur);
          } catch (_) {
            evidence.steps.push({ id: 'traffic_restore_needed', ok: true, attempt });
            await deps.applyTraffic(tenant, baseline.original.traffic, {
              purpose: 'traffic_restore',
              reason,
              signal: abortController.signal,
            });
          }
        }
        await deps.applyTemplate(tenant, appShow, {
          purpose: 'restore',
          reason,
          signal: abortController.signal,
        });
        await verifyRestored();
        return { ok: true, attempt };
      } catch (err) {
        lastErr = err;
        evidence.steps.push({
          id: 'restore_attempt',
          ok: false,
          attempt,
          ...sanitizeError(err),
        });
        // Never clear restorationRequired until verification succeeds.
        restorationRequired = true;
        restorationVerified = false;
      }
    }
    throw fail('restore_failed', 'Bounded restore retries exhausted without exact verification', {
      category: 'restore_failed',
      last: sanitizeError(lastErr),
    });
  };

  const trap = installCleanupTrap({
    restore: restoreWithRetries,
    processRef: deps.processRef || process,
    signals: deps.signals || ['SIGINT', 'SIGTERM'],
    abortController,
    onAbort: () => {
      forwardMutationAllowed = false;
      evidence.steps.push({ id: 'abort_set', ok: true, category: 'aborted' });
    },
  });

  try {
    const healthBefore = await deps.httpGet(`${tenant.publicBaseUrl}/healthz`);
    const readyBefore = await deps.httpGet(`${tenant.publicBaseUrl}/readyz`);
    if (Number(healthBefore.status) !== 200 || Number(readyBefore.status) !== 200) {
      throw fail('baseline_endpoints_unhealthy', 'Refuse apply: public health/ready not 200', {
        category: 'endpoint_unhealthy',
        health: healthBefore.status,
        ready: readyBefore.status,
      });
    }
    evidence.steps.push({
      id: 'baseline_endpoints',
      ok: true,
      health: healthBefore.status,
      ready: readyBefore.status,
    });

    const preRevisions = await deps.listRevisions(tenant);
    const preRevisionNames = revisionNameSet(preRevisions);
    evidence.steps.push({
      id: 'pre_revision_set_captured',
      ok: true,
      count: preRevisionNames.size,
    });

    // Mark mutation attempted BEFORE spawning Azure update.
    markMutationAttempted('failure_inject');
    await deps.applyTemplate(tenant, failureApp, {
      purpose: 'failure_inject',
      signal: abortController.signal,
      beforeSpawn: () => {
        // Adapter may call this; already marked above.
      },
    });
    evidence.steps.push({ id: 'failure_template_applied', ok: true });

    const failureObs = await pollUntil(async () => {
      // Continuous traffic + public health/ready poll during failure window.
      const liveShow = typeof deps.showAppAfter === 'function'
        ? await deps.showAppAfter(tenant)
        : await deps.showApp(tenant);
      try {
        assertTrafficUnchanged(baseline.original.traffic, liveShow);
      } catch (driftErr) {
        throw driftErr;
      }
      const healthDuring = await deps.httpGet(`${tenant.publicBaseUrl}/healthz`);
      const readyDuring = await deps.httpGet(`${tenant.publicBaseUrl}/readyz`);
      if (Number(healthDuring.status) !== 200 || Number(readyDuring.status) !== 200) {
        throw fail('old_revision_endpoints_failed', 'Public old revision health/ready must stay 200', {
          category: 'endpoint_unhealthy',
          health: healthDuring.status,
          ready: readyDuring.status,
        });
      }

      const revisions = await deps.listRevisions(tenant);
      const added = newRevisionNames(preRevisionNames, revisions);
      if (added.length !== 1) {
        return { ok: false, addedCount: added.length };
      }
      const newName = added[0];
      const revisionShow = await deps.showRevision(tenant, newName);
      const replicaList = await deps.listReplicas(tenant, newName);
      const classified = classifyFailedRevision({
        revisionShow,
        replicaList,
        latestReadyRevisionName: baseline.latestReadyRevisionName,
        preRevisionNames,
      });
      if (classified.ok) {
        return { ok: true, revision: classified.observations };
      }
      return { ok: false, reason: classified.reason };
    }, {
      timeoutMs: (opts.poll && opts.poll.failureTimeoutMs) || DEFAULT_POLL.failureTimeoutMs,
      intervalMs: (opts.poll && opts.poll.intervalMs) || DEFAULT_POLL.intervalMs,
      now: deps.now,
      sleep: deps.sleep,
      signal: abortController.signal,
      label: 'failed_revision',
    });
    evidence.steps.push({
      id: 'failed_revision_observed',
      ok: true,
      revision: failureObs.revision,
    });

    evidence.steps.push({
      id: 'old_revision_public_ok',
      ok: true,
    });

    // Success-path restore (also covered by finally).
    await restoreWithRetries('success_path');

    await pollUntil(async () => {
      const show = typeof deps.showAppAfter === 'function'
        ? await deps.showAppAfter(tenant)
        : await deps.showApp(tenant);
      const readyName = latestReadyRevisionName(show);
      const health = await deps.httpGet(`${tenant.publicBaseUrl}/healthz`);
      const ready = await deps.httpGet(`${tenant.publicBaseUrl}/readyz`);
      const restoredOk = (() => {
        try {
          assertCompleteRestore({
            appShow: show,
            tenant,
            originalSnapshot: baseline.original,
            healthStatus: health.status,
            readyStatus: ready.status,
          });
          return true;
        } catch (_) {
          return false;
        }
      })();
      return {
        ok: restoredOk
          && Boolean(readyName)
          && Number(health.status) === 200
          && Number(ready.status) === 200,
        readyName,
        health: health.status,
        ready: ready.status,
      };
    }, {
      timeoutMs: (opts.poll && opts.poll.restoreTimeoutMs) || DEFAULT_POLL.restoreTimeoutMs,
      intervalMs: (opts.poll && opts.poll.intervalMs) || DEFAULT_POLL.intervalMs,
      now: deps.now,
      sleep: deps.sleep,
      signal: abortController.signal,
      label: 'restore_healthy_latest_ready',
    });

    evidence.steps.push({ id: 'restore_healthy_latest_ready', ok: true });
    evidence.live_executed = true;
    evidence.timestamps_utc.finished = new Date().toISOString();
    writeJson(evidencePath, evidence);
    trap.disarm();
    return {
      ok: true,
      mode,
      evidence,
      evidencePath,
      workDir,
      live_mutation: true,
      mutation_attempted: true,
      restored: true,
      restoration_verified: restorationVerified,
    };
  } catch (err) {
    evidence.steps.push({
      id: 'error',
      ok: false,
      ...sanitizeError(err),
    });
    // Restoration is handled in finally when mutation was attempted.
    evidence.timestamps_utc.finished = new Date().toISOString();
    try {
      writeJson(evidencePath, evidence);
    } catch (_) { /* ignore */ }
    throw err;
  } finally {
    // Unconditional restore after any mutation attempt.
    if (mutationAttempted && restorationRequired) {
      try {
        await trap.restoreNow(`finally:restoration_required`);
        evidence.steps.push({ id: 'finally_restore', ok: true });
      } catch (restoreErr) {
        evidence.steps.push({
          id: 'finally_restore',
          ok: false,
          ...sanitizeError(restoreErr),
        });
      }
    }
    await trap.awaitPendingRestore();
    try {
      writeJson(evidencePath, evidence);
    } catch (_) { /* ignore */ }
    trap.disarm();
  }
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

module.exports = {
  MASTER_BASIS,
  IMAGE_SHA_SHORT,
  IMAGE_SHA_FULL,
  SLICE,
  OUTCOME_ID,
  GATE_ID,
  PROGRESS_CLASS,
  BRANCH,
  DATABASE_ENV_NAME,
  CONFIRM_TOKEN,
  UNREACHABLE_DSN,
  SUBSCRIPTION_ID,
  AZURE_ACCOUNT_USER,
  AZURE_TENANT_ID,
  TENANTS,
  FORBIDDEN_RESOURCE_GROUPS,
  FORBIDDEN_HOST_SUFFIXES,
  DEFAULT_POLL,
  DEFAULT_AZ_TIMEOUT_MS,
  DEFAULT_RESTORE_RETRIES,
  ERROR_CATEGORIES,
  CONTRACT_REL,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  deepClone,
  parseCliArgs,
  resolveTenant,
  assertCliFailClosed,
  assertConfirmForApply,
  assertLibraryApplyConfirm,
  assertTenantPins,
  assertAzureAccountLock,
  assertAppResourceLock,
  isForbiddenHost,
  primaryContainer,
  findEnvEntry,
  parseImage,
  assertImagePinned,
  assertProbesPresent,
  assertDatabaseSecretRef,
  assertSingleRevisionTraffic,
  assertBaselineState,
  snapshotOriginal,
  canonicalTraffic,
  assertExactTemplateMatch,
  assertExactTrafficMatch,
  assertCompleteRestore,
  assertTrafficUnchanged,
  buildFailureTemplate,
  envDeltaOnlyDatabase,
  revisionNameSet,
  newRevisionNames,
  classifyFailedRevision,
  assertFailedRevisionObservation,
  assertRestoredState,
  redactSecretsDeep,
  sanitizeError,
  sanitizeEvidenceValue,
  buildEvidenceSkeleton,
  createWorkDir,
  installCleanupTrap,
  pollUntil,
  checkRepoPreflight,
  planDryRun,
  runHarness,
  runSubprocessAsync,
  withSubscriptionArgs,
  sha256Hex,
  latestReadyRevisionName,
  resourceIdFor,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
