'use strict';
/**
 * MESSI SaaS Stage 2D — synthetic staging plan/apply/status/rollback owner.
 * Plan authority: Stage1 manifest + repo Bicep + active subscription + slug only.
 * Secrets: generated in memory; ARM HTTPS bodies only; never argv/log/state/tags/files.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { execFileSync } = require('child_process');
const { assertSyntheticTenantSlug } = require('./migration-integrity');

const STAGE = 'saas-2d';
const OWNER = 'messi-stage2d';
const MODULE_REL = 'infra/azure/modules/tenant-staging/main.bicep';
const ACR_NAME = 'whstagingacr';
const ACR_RG = 'wh-staging-rg';
const ACR_LOGIN = 'whstagingacr.azurecr.io';
const IMAGE_REPO = 'luna-sunset-staff-api';
const LOC = 'westeurope';
const ACA_LOC = 'northeurope';
const ARM_API = '2022-09-01';
const COST_API = '2023-03-01';
const APP_API = '2023-05-01';
const KV_SECRETS_USER = '4633458b-17de-407f-b9ed-0503c8a34c52';
const ACR_PULL = '7f951dda-4ed3-4680-a7ca-43fe172d538d';
/** Staging subscription only — synthetic apply refuses any other active account. */
const STAGING_SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
const SENTINELS = Object.freeze({
  stripeSecretKey: 'sk_test_disabled',
  stripeWebhookSecret: 'whsec_disabled',
  metaWhatsappToken: 'EAAG_disabled',
  metaAppSecret: 'meta_app_secret_disabled',
  metaWhatsappVerifyToken: 'meta_verify_disabled',
});
const SKU_EST = Object.freeze({
  postgresSku: 'Standard_B1ms', postgresMonthlyUsd: 25,
  staffApiCpu: '0.5', staffApiMemory: '1Gi', staffApiMonthlyUsd: 18,
  natGatewayMonthlyUsd: 35, miscMonthlyUsd: 12,
});

function err(code, message) { return { code, message }; }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function sortedStringify(v) {
  return `${JSON.stringify(v, (_, x) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      const o = {}; for (const k of Object.keys(x).sort()) o[k] = x[k]; return o;
    }
    return x;
  })}\n`;
}
function redactSecrets(text, secrets) {
  let out = String(text || '');
  for (const s of secrets || []) {
    if (s && String(s).length >= 4) out = out.split(String(s)).join('[REDACTED]');
  }
  return out
    .replace(/postgres(ql)?:\/\/[^\s'"]+/gi, '[REDACTED_DSN]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]');
}

function deriveNames(slug, subscriptionId) {
  const s = String(slug || '').toLowerCase();
  const prefix = `luna-${s}-staging`;
  return {
    tenantSlug: s,
    resourceGroupName: `${prefix}-rg`,
    appNamePrefix: prefix,
    appDbName: `${s}_staging`,
    staffApiContainerName: `${prefix}-staff-api`,
    staffApiAppName: `${prefix}-staff-api`,
    postgresAdminUser: `${s}admin`,
    databaseUrlSecretName: `${s}-database-url`,
    acrPullModuleName: `${s}StagingAcrPull`,
    bootstrapJobName: `${prefix}-bootstrap`,
    keyVaultName: `luna${s.replace(/[^a-z0-9]/g, '')}stgkv`.slice(0, 24),
    managedIdentityName: `${prefix}-identity`,
    postgresServerName: `${prefix}-pg-app`,
    containerAppsEnvironmentName: `${prefix}-env`,
    subscriptionId,
    opsActionGroupName: `${prefix}-ops-budget-ag`,
  };
}

function loadAndValidateManifest(manifestDir, slug) {
  if (!manifestDir || !fs.existsSync(manifestDir)) {
    return { ok: false, errors: [err('manifest_dir_missing', 'Stage1 manifest dir required')] };
  }
  const mp = path.join(manifestDir, 'dry-run-manifest.json');
  if (!fs.existsSync(mp)) return { ok: false, errors: [err('manifest_missing', 'dry-run-manifest.json missing')] };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(mp, 'utf8')); }
  catch (e) { return { ok: false, errors: [err('manifest_parse', e.message)] }; }
  const errors = [];
  if (String(manifest.client_slug || '') !== String(slug)) errors.push(err('manifest_slug_mismatch', 'manifest client_slug != slug'));
  if (manifest.enablement_forced_false !== true) errors.push(err('manifest_enablement', 'enablement_forced_false required'));
  if (manifest.secrets_materialized === true) errors.push(err('manifest_secrets', 'secrets must not be materialized'));
  if (manifest.apply === true) errors.push(err('manifest_apply_flag', 'manifest apply must be false'));
  const gate = assertSyntheticTenantSlug(slug);
  if (!gate.ok) errors.push(...(gate.errors || []).map((e) => err(e.code || 'reserved_slug', e.message || String(e))));
  if (/prod/i.test(String(slug))) errors.push(err('reserved_slug', 'prod slug rejected'));
  if (errors.length) return { ok: false, errors };
  const body = fs.readFileSync(mp, 'utf8');
  return { ok: true, errors: [], manifest, manifestSha256: sha256(body), manifestPath: mp };
}

function defaultAzPath() {
  return ['/opt/data/.local/bin/az', '/opt/data/home/.local/bin/az', 'az'].find((p) => {
    if (p === 'az') return true;
    try { return fs.existsSync(p); } catch (_) { return false; }
  }) || 'az';
}
function defaultBicepPath() {
  return ['/opt/data/home/.azure/bin/bicep', '/opt/data/.azure/bin/bicep', '/opt/data/home/bin/bicep']
    .find((p) => fs.existsSync(p));
}

function createDeps(overrides = {}) {
  const repoRoot = overrides.repoRoot || path.join(__dirname, '..');
  const stateDir = overrides.stateDir || path.join(repoRoot, 'tmp', 'messi-saas-stage2d');
  const azBin = overrides.azBin || defaultAzPath();
  const bicepBin = overrides.bicepBin || defaultBicepPath();
  const deps = {
    repoRoot,
    stateDir,
    rolePropagateAttempts: overrides.rolePropagateAttempts || 30,
    pollAttempts: overrides.pollAttempts || 60,
    sleep: overrides.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: overrides.now || (() => new Date()),
    randomBytes: overrides.randomBytes || ((n) => crypto.randomBytes(n)),
    gitExec: overrides.gitExec || ((args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()),
    azExec: overrides.azExec || ((args) => execFileSync(azBin, args, {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
    }).trim()),
    bicepBuild: overrides.bicepBuild || ((rel) => {
      const out = path.join(require('os').tmpdir(), `s2d-bicep-${crypto.randomBytes(4).toString('hex')}.json`);
      execFileSync(bicepBin, ['build', path.join(repoRoot, rel), '--outfile', out], {
        cwd: repoRoot, env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const tpl = JSON.parse(fs.readFileSync(out, 'utf8'));
      try { fs.unlinkSync(out); } catch (_) { /* nonsecret temp */ }
      return tpl;
    }),
    armRequest: overrides.armRequest || null,
    httpsRequest: overrides.httpsRequest || null,
    token: null,
  };
  if (!deps.armRequest) {
    deps.armRequest = (req) => armHttps(deps, req);
  }
  if (!deps.httpsRequest) {
    deps.httpsRequest = (opts) => genericHttps(opts);
  }
  return deps;
}

function genericHttps(opts) {
  const mod = opts.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const r = mod.request({
      method: opts.method || 'GET', hostname: opts.hostname, path: opts.path || '/',
      port: opts.port, headers: opts.headers || {}, rejectUnauthorized: opts.rejectUnauthorized !== false,
      timeout: opts.timeout || 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('https_timeout')); });
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

async function armHttps(deps, req) {
  if (!deps.token) {
    const raw = deps.azExec(['account', 'get-access-token', '--resource', 'https://management.azure.com/', '-o', 'json']);
    const tok = JSON.parse(raw);
    deps.token = tok.accessToken;
  }
  const body = req.body != null ? JSON.stringify(req.body) : null;
  const headers = {
    Authorization: `Bearer ${deps.token}`,
    'Content-Type': 'application/json',
    ...(req.headers || {}),
  };
  if (body) headers['Content-Length'] = Buffer.byteLength(body);
  const res = await genericHttps({
    method: req.method, hostname: 'management.azure.com', path: req.path, headers, body, timeout: 120000,
  });
  let parsed = res.body;
  try { parsed = res.body ? JSON.parse(res.body) : {}; } catch (_) { parsed = { raw: res.body }; }
  return { status: res.status, body: parsed, headers: res.headers };
}

function assertRepoDeployPreflight(deps) {
  const errors = [];
  try {
    if (deps.gitExec(['status', '--porcelain']) !== '') errors.push(err('dirty_tree', 'working tree dirty'));
  } catch (e) { errors.push(err('git_status', e.message)); }
  let head = ''; let om = '';
  try {
    head = deps.gitExec(['rev-parse', 'HEAD']);
    om = deps.gitExec(['rev-parse', 'origin/master']);
  } catch (e) { errors.push(err('git_rev', e.message)); }
  if (head && om && head !== om) errors.push(err('not_synced_master', `HEAD!=origin/master (${head.slice(0, 8)}!=${om.slice(0, 8)})`));
  return { ok: errors.length === 0, errors, deploySha: head || om };
}

function readActiveSubscription(deps, { requireStaging = false } = {}) {
  const raw = deps.azExec(['account', 'show', '-o', 'json']);
  const acct = JSON.parse(raw);
  if (!acct || !acct.id || acct.state !== 'Enabled') {
    return { ok: false, errors: [err('subscription_inactive', 'active subscription missing/disabled')] };
  }
  if (requireStaging && String(acct.id) !== STAGING_SUBSCRIPTION_ID) {
    return { ok: false, errors: [err('subscription_drift', `active subscription ${acct.id} is not staging`)] };
  }
  return { ok: true, errors: [], subscriptionId: acct.id, account: acct };
}

async function getResourceGroup(deps, sub, rg) {
  const path_ = `/subscriptions/${sub}/resourcegroups/${rg}?api-version=${ARM_API}`;
  const res = await deps.armRequest({ method: 'GET', path: path_ });
  if (res.status === 404) return { ok: true, exists: false, body: null };
  if (res.status >= 200 && res.status < 300) return { ok: true, exists: true, body: res.body };
  return { ok: false, errors: [err('rg_read_failed', `status ${res.status}`)] };
}

function ownershipTags({ tenantSlug, planDigest, deploySha }) {
  return { tenant: tenantSlug, stage: STAGE, owner: OWNER, planDigest, deploySha };
}

function assertOwnedRg(rgBody, expected) {
  const tags = (rgBody && rgBody.tags) || {};
  const exp = ownershipTags(expected);
  const errors = [];
  for (const k of Object.keys(exp)) {
    if (String(tags[k] || '') !== String(exp[k])) {
      errors.push(err('rg_ownership_tuple', `tag ${k} mismatch`));
    }
  }
  return { ok: errors.length === 0, errors, tags };
}

async function queryRgCost(deps, sub, rg) {
  const path_ = `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.CostManagement/query?api-version=${COST_API}`;
  const now = deps.now();
  const from = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const to = now.toISOString().slice(0, 10);
  const body = {
    type: 'ActualCost', timeframe: 'Custom',
    timePeriod: { from, to },
    dataset: { granularity: 'None', aggregation: { totalCost: { name: 'PreTaxCost', function: 'Sum' } } },
  };
  const res = await deps.armRequest({ method: 'PUT', path: path_, body });
  // Cost Management uses POST in Azure; accept PUT/POST via deps — try POST shape
  const res2 = res.status >= 400
    ? await deps.armRequest({ method: 'POST', path: path_, body })
    : res;
  const final = res.status < 400 ? res : res2;
  if (final.status < 200 || final.status >= 300) {
    return { ok: false, errors: [err('cost_query_failed', `Cost Management status ${final.status}`)] };
  }
  const rows = (((final.body || {}).properties || {}).rows) || [];
  if (!rows.length) {
    return { ok: true, currentCost: { amount: 0, currency: 'USD', period: { from, to }, empty: true } };
  }
  const amount = Number(rows[0][0]);
  const currency = String(rows[0][1] || 'USD');
  if (!Number.isFinite(amount)) {
    return { ok: false, errors: [err('cost_query_parse', 'cost amount not numeric')] };
  }
  return { ok: true, currentCost: { amount, currency, period: { from, to }, empty: false } };
}

function estimateMonthlySkus() {
  const estimatedMonthlyUsd = SKU_EST.postgresMonthlyUsd + SKU_EST.staffApiMonthlyUsd
    + SKU_EST.natGatewayMonthlyUsd + SKU_EST.miscMonthlyUsd;
  return {
    intendedSkus: { ...SKU_EST },
    estimatedMonthlyUsd,
  };
}

function generateSecrets({ slug, randomBytes }) {
  const rb = randomBytes || crypto.randomBytes;
  const pgPass = rb(24).toString('base64url');
  const appPass = rb(24).toString('base64url');
  const session = rb(32).toString('base64url');
  const bot = rb(32).toString('base64url');
  const host = `luna-${slug}-staging-pg-app.postgres.database.azure.com`;
  const db = `${slug}_staging`;
  const adminUser = `${slug}admin`;
  const appUser = `${slug}_app`;
  const enc = (s) => encodeURIComponent(s);
  return {
    postgresAdminPassword: pgPass,
    appDatabasePassword: appPass,
    staffSessionSecret: session,
    lunaBotInternalToken: bot,
    bootstrapAppRolePassword: appPass,
    bootstrapAdminDatabaseUrl: `postgresql://${enc(adminUser)}:${enc(pgPass)}@${host}:5432/${db}?sslmode=require`,
    appDatabaseUrl: `postgresql://${enc(appUser)}:${enc(appPass)}@${host}:5432/${db}?sslmode=require`,
    ...SENTINELS,
    locationWhatsappNumberA: '+10000000001',
    locationWhatsappNumberB: '+10000000002',
    locationWhatsappPhoneNumberIdA: '1000000000000001',
    locationWhatsappPhoneNumberIdB: '1000000000000002',
    locationInboxEmailA: `${slug}-a@inbox.${slug}.invalid`,
    locationInboxEmailB: `${slug}-b@inbox.${slug}.invalid`,
  };
}

function buildNonsecretParams(names, deploySha, planDigest, phase, extras = {}) {
  const p = {
    tenantSlug: { value: names.tenantSlug },
    environmentName: { value: 'staging' },
    location: { value: LOC },
    containerAppsLocation: { value: ACA_LOC },
    appNamePrefix: { value: names.appNamePrefix },
    assertedResourceGroupName: { value: names.resourceGroupName },
    acrName: { value: ACR_NAME },
    acrResourceGroupName: { value: ACR_RG },
    acrPullModuleName: { value: names.acrPullModuleName },
    acrLoginServer: { value: ACR_LOGIN },
    staffApiImageRepository: { value: IMAGE_REPO },
    staffApiImageTag: { value: deploySha },
    staffApiContainerName: { value: names.staffApiContainerName },
    enableSunsetRuntimeEnv: { value: false },
    postgresSku: { value: SKU_EST.postgresSku },
    postgresVersion: { value: '15' },
    staffApiCpu: { value: SKU_EST.staffApiCpu },
    staffApiMemory: { value: SKU_EST.staffApiMemory },
    logRetentionDays: { value: 30 },
    postgresAdminUser: { value: names.postgresAdminUser },
    appDbName: { value: names.appDbName },
    ownerTag: { value: OWNER },
    postgresAllowedIpAddresses: { value: [] },
    firewallRuleNamePrefix: { value: 'AllowTenantStagingEgress' },
    deployContainerApps: { value: true },
    deployStaffApi: { value: true },
    deploySchemaObserverJob: { value: false },
    staffApiMinReplicas: { value: 1 },
    staffApiMaxReplicas: { value: 1 },
    opsActionGroupResourceId: {
      value: `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}/providers/Microsoft.Insights/actionGroups/${names.opsActionGroupName}`,
    },
    opsActionGroupName: { value: names.opsActionGroupName },
    deploySha: { value: deploySha },
    forceRevision: { value: deploySha },
    managedCertificateName: { value: 'unused-synthetic-no-cert' },
    staffApiCustomDomain: { value: 'unused.synthetic.invalid' },
    databaseUrlSecretName: { value: names.databaseUrlSecretName },
    staffActionsEnabled: { value: 'false' },
    stripeLinksEnabled: { value: 'false' },
    whatsappDryRun: { value: 'true' },
    capacityAlertNamePrefix: { value: names.tenantSlug },
    portalUrlTarget: { value: 'https://unused.synthetic.invalid' },
    planDigest: { value: planDigest },
    stageTag: { value: STAGE },
    deployBootstrapJob: { value: phase === 'bootstrap' },
    runtimeDeploymentPhase: {
      value: phase === 'runtime-prereqs' ? 'runtime-prereqs'
        : phase === 'runtime-app' ? 'runtime-app' : 'none',
    },
    runtimePrereqsVerified: { value: phase === 'runtime-app' },
    staffApiImageDigest: { value: extras.imageDigest || '' },
    bootstrapJobImageDigest: { value: extras.imageDigest || '' },
  };
  return p;
}

function attachSecureParams(params, secrets, phase) {
  const out = { ...params };
  out.postgresAdminPassword = { value: secrets.postgresAdminPassword };
  out.lunaBotInternalToken = { value: secrets.lunaBotInternalToken };
  out.locationWhatsappNumberA = { value: secrets.locationWhatsappNumberA };
  out.locationWhatsappNumberB = { value: secrets.locationWhatsappNumberB };
  out.locationWhatsappPhoneNumberIdA = { value: secrets.locationWhatsappPhoneNumberIdA };
  out.locationWhatsappPhoneNumberIdB = { value: secrets.locationWhatsappPhoneNumberIdB };
  out.locationInboxEmailA = { value: secrets.locationInboxEmailA };
  out.locationInboxEmailB = { value: secrets.locationInboxEmailB };
  if (phase === 'bootstrap') {
    out.bootstrapAdminDatabaseUrl = { value: secrets.bootstrapAdminDatabaseUrl };
    out.bootstrapAppRolePassword = { value: secrets.bootstrapAppRolePassword };
  }
  if (phase === 'runtime-prereqs' || phase === 'runtime-app') {
    out.appDatabasePassword = { value: secrets.appDatabasePassword };
    out.staffSessionSecret = { value: secrets.staffSessionSecret };
    out.stripeSecretKey = { value: secrets.stripeSecretKey };
    out.stripeWebhookSecret = { value: secrets.stripeWebhookSecret };
    out.metaWhatsappToken = { value: secrets.metaWhatsappToken };
    out.metaAppSecret = { value: secrets.metaAppSecret };
    out.metaWhatsappVerifyToken = { value: secrets.metaWhatsappVerifyToken };
  }
  return out;
}

function canonicalPlanCore(fields) {
  return {
    schemaVersion: 1,
    authority: 'repo_manifest_azure',
    stage: STAGE,
    ownerTag: OWNER,
    tenantSlug: fields.tenantSlug,
    resourceGroupName: fields.resourceGroupName,
    subscriptionId: fields.subscriptionId,
    appNamePrefix: fields.appNamePrefix,
    appDbName: fields.appDbName,
    deploySha: fields.deploySha,
    bicepContentSha256: fields.bicepContentSha256,
    manifestSha256: fields.manifestSha256,
    moduleRel: MODULE_REL,
    acrName: ACR_NAME,
    acrLoginServer: ACR_LOGIN,
    staffApiImageRepository: IMAGE_REPO,
    location: LOC,
    containerAppsLocation: ACA_LOC,
    intendedSkus: fields.intendedSkus,
    estimatedMonthlyUsd: fields.estimatedMonthlyUsd,
  };
}

async function derivePlan(opts, deps) {
  const slug = String(opts.slug || '').toLowerCase();
  const man = loadAndValidateManifest(opts.manifestDir, slug);
  if (!man.ok) return man;
  const pre = assertRepoDeployPreflight(deps);
  if (!pre.ok) return pre;
  const sub = readActiveSubscription(deps, { requireStaging: !!opts.requireStagingSubscription });
  if (!sub.ok) return sub;
  const names = deriveNames(slug, sub.subscriptionId);
  let template;
  try { template = deps.bicepBuild(MODULE_REL); }
  catch (e) { return { ok: false, errors: [err('bicep_compile', e.message)] }; }
  const bicepSrc = fs.readFileSync(path.join(deps.repoRoot, MODULE_REL), 'utf8');
  const bicepContentSha256 = sha256(bicepSrc);
  const rg = await getResourceGroup(deps, sub.subscriptionId, names.resourceGroupName);
  if (!rg.ok) return rg;
  const skus = estimateMonthlySkus();
  const core = canonicalPlanCore({
    ...names, deploySha: pre.deploySha, bicepContentSha256,
    manifestSha256: man.manifestSha256, ...skus,
  });
  const planDigest = sha256(sortedStringify(core));
  if (rg.exists) {
    const owned = assertOwnedRg(rg.body, { tenantSlug: slug, planDigest, deploySha: pre.deploySha });
    // Existing RG may predate this planDigest — allow exact prior owned tuple with same tenant/owner/stage/deploySha
    if (!owned.ok) {
      const tags = (rg.body && rg.body.tags) || {};
      const soft = tags.tenant === slug && tags.owner === OWNER && tags.stage === STAGE
        && tags.deploySha === pre.deploySha && tags.planDigest;
      if (!soft) return { ok: false, errors: owned.errors.length ? owned.errors : [err('rg_takeover', 'RG exists without ownership tuple')] };
    }
  }
  const cost = await queryRgCost(deps, sub.subscriptionId, names.resourceGroupName);
  if (!cost.ok) return cost;
  const plan = {
    ...core,
    planDigest,
    rgExists: rg.exists,
    rgTags: rg.exists ? ((rg.body && rg.body.tags) || {}) : null,
    currentCost: cost.currentCost,
    templateBytes: Buffer.byteLength(JSON.stringify(template)),
  };
  return { ok: true, errors: [], plan, template, names, deploySha: pre.deploySha };
}

async function plan(opts, deps) {
  try {
    const r = await derivePlan(opts, deps || createDeps());
    if (!r.ok) return r;
    return { ok: true, errors: [], plan: r.plan };
  } catch (e) {
    return { ok: false, errors: [err('plan_exception', redactSecrets(e.message, []))] };
  }
}

function statePath(deps, slug) { return path.join(deps.stateDir, `${slug}.local.json`); }
function readState(deps, slug) {
  const p = statePath(deps, slug);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeState(deps, state) {
  fs.mkdirSync(deps.stateDir, { recursive: true });
  const p = statePath(deps, state.tenantSlug);
  const tmp = `${p}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, p);
}
function removeState(deps, slug) {
  const p = statePath(deps, slug);
  try { fs.unlinkSync(p); } catch (_) { /* absent */ }
}

async function putRg(deps, names, tags) {
  const path_ = `/subscriptions/${names.subscriptionId}/resourcegroups/${names.resourceGroupName}?api-version=${ARM_API}`;
  const res = await deps.armRequest({
    method: 'PUT', path: path_,
    body: { location: LOC, tags },
  });
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, errors: [err('rg_create_failed', `status ${res.status}`)] };
  }
  return { ok: true, body: res.body };
}

async function deployPhase(deps, { names, template, params, deployName }) {
  const path_ = `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}/providers/Microsoft.Resources/deployments/${deployName}?api-version=2021-04-01`;
  const res = await deps.armRequest({
    method: 'PUT', path: path_, _allowSecrets: true,
    body: {
      properties: {
        mode: 'Incremental',
        template,
        parameters: params,
      },
    },
  });
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, errors: [err('deployment_failed', `status ${res.status}`)], status: res.status };
  }
  // poll
  for (let i = 0; i < (deps.pollAttempts || 60); i += 1) {
    const st = (((res.body || {}).properties || {}).provisioningState)
      || (await deps.armRequest({ method: 'GET', path: path_ })).body?.properties?.provisioningState;
    if (st === 'Succeeded') return { ok: true, body: res.body, deploymentId: (res.body && res.body.id) || path_ };
    if (st === 'Failed' || st === 'Canceled') {
      return { ok: false, errors: [err('deployment_provision', `state ${st}`)] };
    }
    await deps.sleep(1000);
  }
  return { ok: false, errors: [err('deployment_timeout', 'provisioning poll timeout')] };
}

async function runBootstrapJob(deps, names) {
  const job = names.bootstrapJobName;
  const startPath = `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}/providers/Microsoft.App/jobs/${job}/start?api-version=${APP_API}`;
  const started = await deps.armRequest({ method: 'POST', path: startPath, body: {} });
  if (started.status < 200 || started.status >= 300) {
    return { ok: false, errors: [err('bootstrap_start_failed', `status ${started.status}`)] };
  }
  const execName = (started.body && (started.body.name || (started.body.properties && started.body.properties.name))) || 'exec-1';
  const execPath = `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}/providers/Microsoft.App/jobs/${job}/executions/${execName}?api-version=${APP_API}`;
  for (let i = 0; i < (deps.pollAttempts || 60); i += 1) {
    const st = await deps.armRequest({ method: 'GET', path: execPath });
    const status = ((st.body || {}).properties || {}).status || (st.body || {}).status;
    if (status === 'Succeeded') return { ok: true, execution: execName };
    if (status === 'Failed' || status === 'Canceled') {
      return { ok: false, errors: [err('bootstrap_job_failed', `execution ${status}`)] };
    }
    await deps.sleep(1000);
  }
  return { ok: false, errors: [err('bootstrap_job_timeout', 'execution poll timeout')] };
}

async function verifyBootstrapDeleted(deps, names) {
  const path_ = `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}/providers/Microsoft.App/jobs/${names.bootstrapJobName}?api-version=${APP_API}`;
  const res = await deps.armRequest({ method: 'GET', path: path_ });
  if (res.status === 404) return { ok: true };
  return { ok: false, errors: [err('bootstrap_not_deleted', `job still present status ${res.status}`)] };
}

async function waitRbac(deps, names, principalId) {
  const scope = `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}`;
  const path_ = `${scope}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=principalId eq '${principalId}'`;
  for (let i = 0; i < (deps.rolePropagateAttempts || 30); i += 1) {
    const res = await deps.armRequest({ method: 'GET', path: path_ });
    const vals = ((res.body || {}).value) || [];
    const ids = vals.map((v) => String(((v.properties || {}).roleDefinitionId) || ''));
    const hasKv = ids.some((id) => id.endsWith(KV_SECRETS_USER));
    const hasAcr = ids.some((id) => id.endsWith(ACR_PULL));
    if (hasKv && hasAcr) return { ok: true, roleAssignments: vals.length };
    await deps.sleep(500);
  }
  return { ok: false, errors: [err('rbac_propagation_timeout', 'KV Secrets User / AcrPull not visible')] };
}

async function verifyRuntime(deps, names, planDigest, deploySha, imageDigest) {
  const appPath = `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}/providers/Microsoft.App/containerApps/${names.staffApiAppName}?api-version=${APP_API}`;
  const app = await deps.armRequest({ method: 'GET', path: appPath });
  if (app.status < 200 || app.status >= 300) {
    return { ok: false, errors: [err('app_read_failed', `status ${app.status}`)] };
  }
  const tags = (app.body && app.body.tags) || {};
  const owned = assertOwnedRg({ tags }, { tenantSlug: names.tenantSlug, planDigest, deploySha });
  if (!owned.ok) return owned;
  const props = (app.body || {}).properties || {};
  const rev = props.latestRevisionName;
  const fqdn = ((props.configuration || {}).ingress || {}).fqdn;
  const containers = ((props.template || {}).containers) || [];
  const env = (containers[0] && containers[0].env) || [];
  const envMap = Object.fromEntries(env.map((e) => [e.name, e.value]));
  if (envMap.DEFAULT_CLIENT_SLUG !== names.tenantSlug) {
    return { ok: false, errors: [err('tenant_identity', 'DEFAULT_CLIENT_SLUG mismatch')] };
  }
  if (envMap.STAFF_ACTIONS_ENABLED !== 'false' || envMap.STRIPE_LINKS_ENABLED !== 'false' || envMap.WHATSAPP_DRY_RUN !== 'true') {
    return { ok: false, errors: [err('safety_flags', 'staff/stripe/whatsapp safety flags not disabled')] };
  }
  const image = containers[0] && containers[0].image;
  if (imageDigest && image && !String(image).includes(imageDigest.replace(/^sha256:/, '')) && !String(image).includes(imageDigest)) {
    return { ok: false, errors: [err('image_digest_mismatch', 'runtime image digest mismatch')] };
  }
  const revPath = `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}/providers/Microsoft.App/containerApps/${names.staffApiAppName}/revisions/${rev}?api-version=${APP_API}`;
  let healthy = false;
  for (let i = 0; i < (deps.pollAttempts || 60); i += 1) {
    const rr = await deps.armRequest({ method: 'GET', path: revPath });
    const rp = (rr.body || {}).properties || {};
    if ((rp.healthState === 'Healthy' || rp.runningState === 'Running') && Number(rp.replicas || 0) >= 1) {
      healthy = true; break;
    }
    if (rp.healthState === 'Unhealthy' || rp.runningState === 'Failed') {
      return { ok: false, errors: [err('revision_unhealthy', `rev ${rp.healthState || rp.runningState}`)] };
    }
    await deps.sleep(500);
  }
  if (!healthy) return { ok: false, errors: [err('revision_timeout', 'revision not healthy')] };
  const health = await deps.httpsRequest({
    method: 'GET', hostname: fqdn, path: '/healthz', protocol: 'https:',
    headers: { host: fqdn }, rejectUnauthorized: true,
  });
  if (health.status !== 200) {
    return { ok: false, errors: [err('healthz_failed', `status ${health.status}`)] };
  }
  return {
    ok: true,
    fqdn,
    staffApiUrl: `https://${fqdn}`,
    staffApiResourceId: app.body.id,
    latestRevisionName: rev,
    image,
  };
}

function resolveImageDigest(deps, tag) {
  const raw = deps.azExec([
    'acr', 'manifest', 'show', '--name', ACR_NAME, '--registry', ACR_NAME,
    '--repository', IMAGE_REPO, '--name', tag, '-o', 'json',
  ]);
  // fallback shape: az acr repository show-manifests
  let digest = null;
  try {
    const j = JSON.parse(raw);
    digest = j.digest || (Array.isArray(j) && j[0] && j[0].digest) || null;
  } catch (_) {
    digest = String(raw || '').trim();
  }
  if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    // try alternate CLI
    const raw2 = deps.azExec([
      'acr', 'repository', 'show-manifests', '--name', ACR_NAME,
      '--repository', IMAGE_REPO, '--query', `[?tags[?contains(@,'${tag}')]].digest|[0]`, '-o', 'tsv',
    ]);
    digest = String(raw2 || '').trim();
  }
  if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    return { ok: false, errors: [err('image_digest_resolve', 'unable to resolve immutable digest')] };
  }
  return { ok: true, imageDigest: digest };
}

function buildStaffImage(deps, deploySha) {
  // Existing preflight: assert-deploy-from-master semantics already enforced by assertRepoDeployPreflight
  deps.azExec([
    'acr', 'build', '--registry', ACR_NAME, '--image', `${IMAGE_REPO}:${deploySha}`,
    '-f', 'Dockerfile.luna-sunset-staff-api', '.',
  ]);
  return resolveImageDigest(deps, deploySha);
}

async function apply(opts, depsIn) {
  const deps = depsIn || createDeps();
  const secretsHeld = [];
  const preserve = async (errors, extra = {}) => ({
    ok: false, errors, preservedResourceGroup: true, ...extra,
  });
  try {
    if (!opts.confirmCostApproval) {
      return { ok: false, errors: [err('cost_approval_required', '--confirm-cost-approval required')] };
    }
    const maxEst = Number(opts.maxMonthlyEstimate);
    if (!Number.isFinite(maxEst) || maxEst <= 0) {
      return { ok: false, errors: [err('max_monthly_estimate_required', '--max-monthly-estimate required')] };
    }
    const derived = await derivePlan({ ...opts, requireStagingSubscription: true }, deps);
    if (!derived.ok) return derived;
    const { plan: p, template, names, deploySha } = derived;
    if (opts.expectedPlanDigest && opts.expectedPlanDigest !== p.planDigest) {
      return { ok: false, errors: [err('plan_digest_mismatch', 'caller/expected digest does not match rederived plan')] };
    }
    // Reject forged state attempting to override authority
    const existing = readState(deps, names.tenantSlug);
    if (existing && existing.planDigest && existing.planDigest !== p.planDigest
      && opts.expectedPlanDigest && opts.expectedPlanDigest === existing.planDigest) {
      return { ok: false, errors: [err('forged_plan_state', 'state planDigest does not match live rederive')] };
    }
    if (p.estimatedMonthlyUsd > maxEst) {
      return { ok: false, errors: [err('cost_estimate_exceeds_max', `estimate ${p.estimatedMonthlyUsd} > max ${maxEst}`)] };
    }
    const costBefore = p.currentCost;
    const img = buildStaffImage(deps, deploySha);
    if (!img.ok) return img;
    const secrets = generateSecrets({ slug: names.tenantSlug, randomBytes: deps.randomBytes });
    secretsHeld.push(...Object.values(secrets));
    const tags = ownershipTags({
      tenantSlug: names.tenantSlug, planDigest: p.planDigest, deploySha,
    });
    const rgPut = await putRg(deps, names, tags);
    if (!rgPut.ok) return preserve(rgPut.errors);

    const phases = ['infra', 'bootstrap', 'bootstrap-cleanup', 'runtime-prereqs', 'runtime-app'];
    const deploymentIds = [];
    let outputs = {};
    for (const phase of phases) {
      const logical = phase === 'bootstrap-cleanup' ? 'infra' : phase;
      const nonsecret = buildNonsecretParams(names, deploySha, p.planDigest, logical, {
        imageDigest: img.imageDigest,
      });
      if (phase === 'bootstrap-cleanup') {
        nonsecret.deployBootstrapJob = { value: false };
      }
      const params = attachSecureParams(nonsecret, secrets, logical === 'infra' && phase === 'bootstrap-cleanup' ? 'infra' : logical);
      const dep = await deployPhase(deps, {
        names, template, params, deployName: `messi-2d-${phase}-${deploySha.slice(0, 8)}`,
      });
      if (!dep.ok) {
        if (opts.rollbackOnFailure) {
          await deps.armRequest({
            method: 'DELETE',
            path: `/subscriptions/${names.subscriptionId}/resourcegroups/${names.resourceGroupName}?api-version=${ARM_API}`,
          }).catch(() => {});
          return { ok: false, errors: dep.errors, preservedResourceGroup: false, rolledBackOnFailure: true };
        }
        return preserve(dep.errors);
      }
      deploymentIds.push(dep.deploymentId);
      outputs = { ...outputs, ...((((dep.body || {}).properties || {}).outputs) || {}) };
      if (phase === 'bootstrap') {
        const boot = await runBootstrapJob(deps, names);
        if (!boot.ok) return preserve(boot.errors);
      }
      if (phase === 'bootstrap-cleanup') {
        const del = await verifyBootstrapDeleted(deps, names);
        if (!del.ok) return preserve(del.errors);
      }
      if (phase === 'runtime-prereqs') {
        const principalId = (outputs.managedIdentityPrincipalId && outputs.managedIdentityPrincipalId.value)
          || '11111111-1111-1111-1111-111111111111';
        const rbac = await waitRbac(deps, names, principalId);
        if (!rbac.ok) return preserve(rbac.errors);
      }
    }

    const runtime = await verifyRuntime(deps, names, p.planDigest, deploySha, img.imageDigest);
    if (!runtime.ok) return preserve(runtime.errors);

    const costAfter = await queryRgCost(deps, names.subscriptionId, names.resourceGroupName);
    if (!costAfter.ok) return preserve(costAfter.errors);
    const spike = costAfter.currentCost.amount > costBefore.amount + Math.max(maxEst, p.estimatedMonthlyUsd);
    const state = {
      schemaVersion: 1,
      stage: STAGE,
      ownerTag: OWNER,
      tenantSlug: names.tenantSlug,
      subscriptionId: names.subscriptionId,
      resourceGroupName: names.resourceGroupName,
      resourceGroupId: `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}`,
      tags,
      planDigest: p.planDigest,
      deploySha,
      imageDigest: img.imageDigest,
      fqdn: runtime.fqdn,
      staffApiUrl: runtime.staffApiUrl,
      staffApiResourceId: runtime.staffApiResourceId,
      latestRevisionName: runtime.latestRevisionName,
      deploymentIds,
      postgresServerId: outputs.postgresServerId && outputs.postgresServerId.value,
      containerAppsEnvironmentId: outputs.containerAppsEnvironmentId && outputs.containerAppsEnvironmentId.value,
      costBefore,
      costAfter: costAfter.currentCost,
      costSpikeWarning: spike,
      estimatedMonthlyUsd: p.estimatedMonthlyUsd,
      updatedAt: deps.now().toISOString(),
    };
    writeState(deps, state);
    return { ok: true, errors: [], state, planDigest: p.planDigest, costSpikeWarning: spike };
  } catch (e) {
    const msg = redactSecrets(e && e.message, secretsHeld);
    return preserve([err('apply_exception', msg)]);
  }
}

async function status(opts, depsIn) {
  const deps = depsIn || createDeps();
  try {
    const derived = await derivePlan(opts, deps);
    if (!derived.ok) return derived;
    const { plan: p, names } = derived;
    const state = readState(deps, names.tenantSlug);
    if (state) {
      if (state.subscriptionId !== names.subscriptionId) {
        return { ok: false, errors: [err('state_subscription_drift', 'state subscription != active')] };
      }
      if (state.resourceGroupName !== names.resourceGroupName) {
        return { ok: false, errors: [err('state_rg_mismatch', 'state RG mismatch')] };
      }
    }
    const rg = await getResourceGroup(deps, names.subscriptionId, names.resourceGroupName);
    if (!rg.ok) return rg;
    if (!rg.exists) {
      return {
        ok: true, comparedAgainst: 'arm_readback', present: false,
        planDigest: p.planDigest, statePresent: !!state,
      };
    }
    const owned = assertOwnedRg(rg.body, {
      tenantSlug: names.tenantSlug,
      planDigest: (state && state.planDigest) || p.planDigest,
      deploySha: p.deploySha,
    });
    if (!owned.ok) return { ok: false, errors: owned.errors, comparedAgainst: 'arm_readback' };
    if (state && state.staffApiResourceId) {
      const runtime = await verifyRuntime(
        deps, names,
        state.planDigest || p.planDigest,
        state.deploySha || p.deploySha,
        state.imageDigest,
      );
      if (!runtime.ok) return { ...runtime, comparedAgainst: 'arm_readback' };
    }
    return {
      ok: true, comparedAgainst: 'arm_readback', present: true,
      planDigest: p.planDigest, rgTags: (rg.body && rg.body.tags) || {},
      statePlanDigest: state && state.planDigest,
      digestsMatch: !state || state.planDigest === p.planDigest,
    };
  } catch (e) {
    return { ok: false, errors: [err('status_exception', redactSecrets(e.message, []))] };
  }
}

async function rollback(opts, depsIn) {
  const deps = depsIn || createDeps();
  try {
    if (!opts.confirmRollback) {
      return { ok: false, errors: [err('confirm_rollback_required', '--confirm-rollback required')] };
    }
    const slug = String(opts.slug || '').toLowerCase();
    const gate = assertSyntheticTenantSlug(slug);
    if (!gate.ok) return { ok: false, errors: gate.errors.map((e) => err(e.code || 'slug', e.message || String(e))) };
    const pre = assertRepoDeployPreflight(deps);
    if (!pre.ok) return pre;
    const sub = readActiveSubscription(deps, { requireStaging: true });
    if (!sub.ok) return sub;
    const names = deriveNames(slug, sub.subscriptionId);
    const state = readState(deps, slug);
    if (!state) return { ok: false, errors: [err('state_missing', 'local state required for rollback')] };
    if (state.subscriptionId !== sub.subscriptionId) {
      return { ok: false, errors: [err('subscription_mismatch', 'active subscription != state')] };
    }
    if (state.resourceGroupName !== names.resourceGroupName) {
      return { ok: false, errors: [err('rg_name_mismatch', 'derived RG != state')] };
    }
    const rg = await getResourceGroup(deps, sub.subscriptionId, names.resourceGroupName);
    if (!rg.ok) return rg;
    if (!rg.exists) {
      removeState(deps, slug);
      return { ok: true, errors: [], alreadyAbsent: true };
    }
    const owned = assertOwnedRg(rg.body, {
      tenantSlug: slug, planDigest: state.planDigest, deploySha: state.deploySha,
    });
    if (!owned.ok) return { ok: false, errors: owned.errors.concat([err('foreign_or_partial', 'refusing rollback')]) };
    if (state.staffApiResourceId) {
      const appPath = `${state.staffApiResourceId}?api-version=${APP_API}`;
      const app = await deps.armRequest({ method: 'GET', path: appPath.startsWith('/') ? appPath : `/${appPath}` });
      // tolerate absolute id
      const app2 = app.status === 404 ? await deps.armRequest({
        method: 'GET',
        path: `/subscriptions/${sub.subscriptionId}/resourceGroups/${names.resourceGroupName}/providers/Microsoft.App/containerApps/${names.staffApiAppName}?api-version=${APP_API}`,
      }) : app;
      if (app2.status < 200 || app2.status >= 300) {
        return { ok: false, errors: [err('resource_id_mismatch', 'expected staff API id not readable')] };
      }
      const tags = (app2.body && app2.body.tags) || {};
      if (tags.planDigest !== state.planDigest || tags.deploySha !== state.deploySha) {
        return { ok: false, errors: [err('partial_mismatch', 'resource tags != state')] };
      }
    }
    const del = await deps.armRequest({
      method: 'DELETE',
      path: `/subscriptions/${sub.subscriptionId}/resourcegroups/${names.resourceGroupName}?api-version=${ARM_API}`,
    });
    if (del.status < 200 || del.status >= 300) {
      return { ok: false, errors: [err('delete_mismatch', `RG delete status ${del.status}`)] };
    }
    for (let i = 0; i < (deps.pollAttempts || 60); i += 1) {
      const cur = await getResourceGroup(deps, sub.subscriptionId, names.resourceGroupName);
      if (cur.ok && !cur.exists) {
        removeState(deps, slug);
        return { ok: true, errors: [], deleted: true };
      }
      await deps.sleep(500);
    }
    return { ok: false, errors: [err('delete_poll_timeout', 'RG still present')] };
  } catch (e) {
    return { ok: false, errors: [err('rollback_exception', redactSecrets(e.message, []))] };
  }
}

module.exports = Object.freeze({
  STAGE, OWNER, MODULE_REL, SENTINELS, SKU_EST, STAGING_SUBSCRIPTION_ID,
  createDeps, deriveNames, loadAndValidateManifest, generateSecrets, redactSecrets,
  plan, apply, status, rollback,
  assertRepoDeployPreflight, ownershipTags, sortedStringify, sha256,
});
