'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const { assertSyntheticTenantSlug } = require('./migration-integrity');
const gen = require('./factory-slice1c-dry-run-generator');
const mat = require('./messi-saas-stage1-materialize');
const {
  HEALTH_IDENTITY_PATH,
  assertPublicHealthIdentityBody,
} = require('./staff-api-health-identity');
const { azureArmGuid } = require('./phase-d-kv-secrets-user-rbac-plan');
const STAGE = 'saas-2d1';
const OWNER = 'messi-stage2d1';
const MODULE_REL = 'infra/azure/modules/tenant-staging/main.bicep';
const SUBS_REL = 'fixtures/factory-client-productization/slice1c-substitutions-surf_house.json';
const STAGING_SUB_REL = 'config/azure-staging-subscription.json';
const CLI_REL = 'scripts/messi-saas-stage2d1-plan-status.js';
const LIB_REL = 'scripts/lib/messi-saas-stage2d1-plan-status.js';
const INTERNAL_FLAG = '--internal-snapshot-worker';
const CAPABILITY_FD = 3;
const PINNED_BINS = Object.freeze({
  git: '/usr/bin/git', tar: '/usr/bin/tar', node: '/usr/local/bin/node',
  az: '/opt/data/.local/bin/az', bicep: '/opt/data/.azure/bin/bicep',
});
const ARCHETYPE = 'surf_house';
const ACR_NAME = 'whstagingacr';
const ACR_RG = 'wh-staging-rg';
const ACR_LOGIN = 'whstagingacr.azurecr.io';
const IMAGE_REPO = 'luna-sunset-staff-api';
const LOC = 'westeurope';
const ACA_LOC = 'northeurope';
const ARM_API = '2022-09-01';
const COST_API = '2023-03-01';
const APP_API = '2023-05-01';
const KV_API = '2023-07-01';
const MI_API = '2023-01-31';
const ROLE_API = '2022-04-01';
const PG_API = '2023-06-01-preview';
const DNS_API = '2020-06-01';
const ARM_HOST = 'management.azure.com';
const MAX_ARM_PAGES = 40;
const ROLE_KV_SECRETS_USER = '4633458b-17de-408a-b874-0445c86b69e6';
const ROLE_ACR_PULL = '7f951dda-4ed3-4680-a7ca-43fe172d538d';
const IGNORE_TYPES = Object.freeze(['Microsoft.Resources/deployments']);
const FIXED_RUNTIME_SECRETS = Object.freeze([
  'stripe-webhook-secret', 'meta-whatsapp-token', 'meta-app-secret', 'meta-whatsapp-verify-token',
  'staff-session-secret', 'stripe-secret-key', 'luna-bot-internal-token',
  'tenant-loc-1-wa-number', 'tenant-loc-1-wa-phone-id', 'tenant-loc-1-inbox-email',
  'tenant-loc-2-wa-number', 'tenant-loc-2-wa-phone-id', 'tenant-loc-2-inbox-email',
]);
const SKU_EST = Object.freeze({
  postgresSku: 'Standard_B1ms', postgresMonthlyUsd: 25,
  staffApiCpu: '0.5', staffApiMemory: '1Gi', staffApiMonthlyUsd: 18,
  natGatewayMonthlyUsd: 35, miscMonthlyUsd: 12,
});
function err(code, message) { return { code, message }; }
function sha256(buf) {
  return crypto.createHash('sha256').update(buf == null ? '' : buf).digest('hex');
}
function sortedStringify(v) {
  return `${JSON.stringify(v, (_, x) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      const o = {}; for (const k of Object.keys(x).sort()) o[k] = x[k]; return o;
    }
    return x;
  })}\n`;
}
function redact(text) {
  return String(text || '').replace(/postgres(ql)?:\/\/[^\s'"]+/gi, '[REDACTED_DSN]');
}
function deriveNames(slug, subscriptionId) {
  const p = `luna-${slug}-staging`;
  return {
    tenantSlug: slug, subscriptionId, resourceGroupName: `${p}-rg`, appNamePrefix: p,
    appDbName: `${slug}_staging`, staffApiAppName: `${p}-staff-api`, staffApiContainerName: `${p}-staff-api`,
    postgresAdminUser: `${slug}admin`, databaseUrlSecretName: `${slug}-database-url`,
    acrPullModuleName: `${slug}StagingAcrPull`, acrName: ACR_NAME, acrResourceGroupName: ACR_RG,
    keyVaultName: `${p}-kv`, postgresServerName: `${p}-pg-app`,
    containerAppsEnvironmentName: `${p}-env`, logAnalyticsName: `${p}-logs`,
    appInsightsName: `${p}-appinsights`, identityName: `${p}-identity`,
    vnetName: `${p}-vnet`, natName: `${p}-nat`, natPipName: `${p}-nat-pip`,
    privateDnsZoneName: 'privatelink.postgres.database.azure.com',
    privateDnsLinkName: `${p}-pg-dns-link`, bootstrapJobName: `${p}-bootstrap`,
    opsActionGroupName: `${p}-ops-budget-ag`,
  };
}
function rid(sub, rg, type, name) {
  return `/subscriptions/${sub}/resourceGroups/${rg}/providers/${type}/${name}`;
}
function runtimeSecretNames(slug) {
  const db = `${slug}-database-url`;
  return Object.freeze(['stripe-webhook-secret', db, ...FIXED_RUNTIME_SECRETS.slice(1)]);
}
function buildExpectedResourceContract(names, opts = {}) {
  const sub = names.subscriptionId; const rg = names.resourceGroupName;
  const top = [
    [names.logAnalyticsName, 'Microsoft.OperationalInsights/workspaces'],
    [names.appInsightsName, 'Microsoft.Insights/components'],
    [names.identityName, 'Microsoft.ManagedIdentity/userAssignedIdentities'],
    [names.keyVaultName, 'Microsoft.KeyVault/vaults'],
    [names.postgresServerName, 'Microsoft.DBforPostgreSQL/flexibleServers'],
    [names.containerAppsEnvironmentName, 'Microsoft.App/managedEnvironments'],
    [names.vnetName, 'Microsoft.Network/virtualNetworks'],
    [names.natName, 'Microsoft.Network/natGateways'],
    [names.natPipName, 'Microsoft.Network/publicIPAddresses'],
    [names.privateDnsZoneName, 'Microsoft.Network/privateDnsZones'],
  ].map(([name, type]) => ({ id: rid(sub, rg, type, name), name, type, taggable: true }));
  const pgId = rid(sub, rg, 'Microsoft.DBforPostgreSQL/flexibleServers', names.postgresServerName);
  const dnsId = rid(sub, rg, 'Microsoft.Network/privateDnsZones', names.privateDnsZoneName);
  const kvId = rid(sub, rg, 'Microsoft.KeyVault/vaults', names.keyVaultName);
  const miId = rid(sub, rg, 'Microsoft.ManagedIdentity/userAssignedIdentities', names.identityName);
  const acrId = rid(sub, names.acrResourceGroupName || ACR_RG, 'Microsoft.ContainerRegistry/registries', names.acrName || ACR_NAME);
  const nested = [
    {
      id: `${pgId}/databases/${names.appDbName}`, name: names.appDbName,
      type: 'Microsoft.DBforPostgreSQL/flexibleServers/databases', taggable: false,
      parentName: names.postgresServerName, parentId: pgId,
    },
    {
      id: `${dnsId}/virtualNetworkLinks/${names.privateDnsLinkName}`, name: names.privateDnsLinkName,
      type: 'Microsoft.Network/privateDnsZones/virtualNetworkLinks', taggable: true,
      parentName: names.privateDnsZoneName, parentId: dnsId,
    },
  ];
  const kvRoleName = azureArmGuid(kvId, miId, ROLE_KV_SECRETS_USER);
  const principalId = opts.principalId || null;
  const acrRoleName = principalId ? azureArmGuid(acrId, principalId, ROLE_ACR_PULL) : null;
  const roles = [
    {
      kind: 'kv', id: `${kvId}/providers/Microsoft.Authorization/roleAssignments/${kvRoleName}`,
      name: kvRoleName, type: 'Microsoft.Authorization/roleAssignments', scope: kvId,
      roleDefinitionId: ROLE_KV_SECRETS_USER, taggable: false,
    },
    {
      kind: 'acr',
      id: acrRoleName ? `${acrId}/providers/Microsoft.Authorization/roleAssignments/${acrRoleName}` : null,
      name: acrRoleName, type: 'Microsoft.Authorization/roleAssignments', scope: acrId,
      roleDefinitionId: ROLE_ACR_PULL, taggable: false, needsPrincipalId: true,
    },
  ];
  const secretNames = runtimeSecretNames(names.tenantSlug);
  const secrets = secretNames.map((name) => ({
    id: `${kvId}/secrets/${name}`, name, type: 'Microsoft.KeyVault/vaults/secrets', taggable: true,
  }));
  const job = {
    id: rid(sub, rg, 'Microsoft.App/jobs', names.bootstrapJobName),
    name: names.bootstrapJobName, type: 'Microsoft.App/jobs', taggable: true,
  };
  const app = {
    id: rid(sub, rg, 'Microsoft.App/containerApps', names.staffApiAppName),
    name: names.staffApiAppName, type: 'Microsoft.App/containerApps', taggable: true,
  };
  return {
    foundationTopLevel: top, nestedChildren: nested, roleAssignments: roles,
    runtimeSecrets: secrets, runtimeSecretNames: secretNames, bootstrapJob: job, runtimeApp: app,
    ignoreTypes: IGNORE_TYPES.slice(),
    counts: {
      foundationTopLevel: 10, nestedChildren: 2, roleAssignments: 2, runtimeSecrets: 14, bootstrapJob: 1, runtimeApp: 1,
    },
  };
}
function validateSlug(raw) {
  const s = String(raw || '');
  if (s !== s.toLowerCase()) {
    return { ok: false, errors: [err('slug_not_lowercase', 'tenant slug must be strict lowercase')] };
  }
  const gate = assertSyntheticTenantSlug(s);
  if (!gate.ok) {
    return { ok: false, errors: (gate.errors || []).map((e) => err(e.code || 'reserved_slug', e.message || String(e))) };
  }
  return { ok: true, errors: [], slug: s };
}
function buildSubstitutions(repoRoot, slug) {
  const base = JSON.parse(fs.readFileSync(path.join(repoRoot, SUBS_REL), 'utf8'));
  return {
    ...base, CLIENT_SLUG: slug, LOCATION_ID: `${slug}-main`,
    CLIENT_NAME: `Synthetic ${slug}`, BRAND_NAME: `Brand ${slug}`,
  };
}
function safeReadFile(abs, containRoot) {
  let lst;
  try { lst = fs.lstatSync(abs); } catch (e) {
    return { ok: false, errors: [err('path_missing', e.message)] };
  }
  if (lst.isSymbolicLink()) return { ok: false, errors: [err('path_symlink', abs)] };
  if (!lst.isFile()) return { ok: false, errors: [err('path_nonregular', abs)] };
  let real;
  try { real = fs.realpathSync(abs); } catch (e) {
    return { ok: false, errors: [err('path_realpath', e.message)] };
  }
  const rootReal = fs.realpathSync(containRoot);
  const rel = path.relative(rootReal, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, errors: [err('path_escape', abs)] };
  }
  return { ok: true, errors: [], bytes: fs.readFileSync(real), realPath: real };
}
function readStagingSubscriptionAuthority(repoRoot) {
  const abs = path.join(repoRoot, STAGING_SUB_REL);
  const read = safeReadFile(abs, repoRoot);
  if (!read.ok) return { ok: false, errors: read.errors.map((e) => err('staging_sub_config', e.message)) };
  let parsed;
  try { parsed = JSON.parse(read.bytes.toString('utf8')); }
  catch (e) { return { ok: false, errors: [err('staging_sub_parse', e.message)] }; }
  const id = String((parsed && parsed.subscriptionId) || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return { ok: false, errors: [err('staging_sub_invalid', 'subscriptionId missing/invalid')] };
  }
  return { ok: true, errors: [], subscriptionId: id, configSha256: sha256(read.bytes) };
}
function buildSanitizedChildEnv(home) {
  return {
    HOME: home || process.env.HOME || '', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1',
  };
}
function hashPinnedToolAuthority(deps) {
  const pins = deps.pinnedBins || PINNED_BINS;
  const hashFile = deps.hashFile || ((p) => sha256(fs.readFileSync(p)));
  const tools = {
    gitSha256: hashFile(pins.git), tarSha256: hashFile(pins.tar), nodeSha256: hashFile(pins.node),
    azSha256: hashFile(pins.az), bicepSha256: hashFile(pins.bicep),
    bicepVersion: deps.bicepVersion != null ? String(deps.bicepVersion)
      : execFileSync(pins.bicep, ['--version'], {
        encoding: 'utf8', env: buildSanitizedChildEnv(), stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
  };
  return tools;
}
function assertSafeTarMembers(tfText, tvfText) {
  const errors = [];
  for (const name of String(tfText || '').split('\n').filter(Boolean)) {
    if (name.startsWith('/') || name.startsWith('~/') || /(^|\/)\.\.(\/|$)/.test(name)) {
      errors.push(err('tar_member_path', name));
    }
  }
  for (const line of String(tvfText || '').split('\n').filter(Boolean)) {
    if (line[0] !== '-' && line[0] !== 'd') errors.push(err('tar_member_type', `type=${line[0]}`));
  }
  return { ok: !errors.length, errors };
}
function verifyLauncherBytes(deps, verifiedDeploySha, rels = [CLI_REL, LIB_REL]) {
  const errors = []; const pins = deps.pinnedBins || PINNED_BINS;
  for (const rel of rels) {
    const disk = safeReadFile(path.join(deps.repoRoot, rel), deps.repoRoot);
    if (!disk.ok) { errors.push(...disk.errors); continue; }
    let gitBytes;
    try {
      gitBytes = deps.gitShowBytes ? deps.gitShowBytes(verifiedDeploySha, rel)
        : execFileSync(pins.git, ['show', `${verifiedDeploySha}:${rel}`], {
          cwd: deps.repoRoot, stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (e) { errors.push(err('launcher_git_show', `${rel}: ${e.message}`)); continue; }
    if (!Buffer.isBuffer(gitBytes)) gitBytes = Buffer.from(gitBytes);
    if (!disk.bytes.equals(gitBytes)) errors.push(err('launcher_bytes_mismatch', rel));
  }
  return { ok: !errors.length, errors };
}
function createDeps(overrides = {}) {
  const repoRoot = overrides.repoRoot || path.join(__dirname, '..');
  const pins = overrides.pinnedBins || PINNED_BINS;
  const deps = {
    repoRoot,
    pinnedBins: pins,
    inExactSnapshot: !!overrides.inExactSnapshot,
    verifiedDeploySha: overrides.verifiedDeploySha || null,
    toolAuthority: overrides.toolAuthority || null,
    hashFile: overrides.hashFile || null,
    bicepVersion: overrides.bicepVersion,
    gitShowBytes: overrides.gitShowBytes || null,
    snapshotWorker: overrides.snapshotWorker || null,
    sleep: overrides.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: overrides.now || (() => new Date()),
    snapshotAdapter: overrides.snapshotAdapter || null,
    gitExec: overrides.gitExec || ((args) => execFileSync(pins.git, args, {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()),
    azExec: overrides.azExec || ((args, envExtra) => execFileSync(pins.az, args, {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...buildSanitizedChildEnv(), ...(envExtra || {}) },
    }).trim()),
    bicepBuildBytes: overrides.bicepBuildBytes || ((rel, root) => {
      const out = path.join(os.tmpdir(), `s2d1-bicep-${crypto.randomBytes(4).toString('hex')}.json`);
      execFileSync(pins.bicep, ['build', path.join(root, rel), '--outfile', out], {
        cwd: root, env: buildSanitizedChildEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const got = safeReadFile(out, path.dirname(out));
      try { fs.unlinkSync(out); } catch (_) { /* temp */ }
      if (!got.ok) throw new Error(got.errors[0].message);
      return got.bytes;
    }),
    armRequest: overrides.armRequest || null,
    httpsRequest: overrides.httpsRequest || null,
    token: null,
  };
  if (!deps.armRequest) deps.armRequest = (req) => armHttps(deps, req);
  if (!deps.httpsRequest) deps.httpsRequest = (opts) => genericHttps(opts);
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
      res.on('end', () => resolve({
        status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers,
      }));
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
    deps.token = JSON.parse(raw).accessToken;
  }
  const body = req.body != null ? JSON.stringify(req.body) : null;
  const headers = {
    Authorization: `Bearer ${deps.token}`, 'Content-Type': 'application/json', ...(req.headers || {}),
  };
  if (body) headers['Content-Length'] = Buffer.byteLength(body);
  const res = await genericHttps({
    method: req.method, hostname: ARM_HOST, path: req.path, headers, body, timeout: 60000,
  });
  let parsed = res.body;
  try { parsed = res.body ? JSON.parse(res.body) : {}; } catch (_) { parsed = { raw: res.body }; }
  return { status: res.status, body: parsed, headers: res.headers };
}
function assertRepoDeployPreflight(deps) {
  const errors = []; let branch = ''; let head = ''; let om = '';
  try { deps.gitExec(['fetch', 'origin', 'master']); } catch (e) { errors.push(err('git_fetch_master', e.message)); }
  try { branch = deps.gitExec(['rev-parse', '--abbrev-ref', 'HEAD']); } catch (e) { errors.push(err('git_branch', e.message)); }
  if (branch && branch !== 'master') errors.push(err('branch_not_master', `current branch must be master (got ${branch})`));
  try { if (deps.gitExec(['status', '--porcelain']) !== '') errors.push(err('dirty_tree', 'working tree dirty')); }
  catch (e) { errors.push(err('git_status', e.message)); }
  try { head = deps.gitExec(['rev-parse', 'HEAD']); om = deps.gitExec(['rev-parse', 'origin/master']); }
  catch (e) { errors.push(err('git_rev', e.message)); }
  if (head && om && head !== om) {
    errors.push(err('not_synced_master', `HEAD!=origin/master (${head.slice(0, 8)}!=${om.slice(0, 8)})`));
  }
  return { ok: errors.length === 0, errors, verifiedDeploySha: head || om, deploySha: head || om, branch };
}
function createExactShaSnapshot(deps, verifiedDeploySha) {
  if (typeof deps.snapshotAdapter === 'function') {
    const snap = deps.snapshotAdapter({ repoRoot: deps.repoRoot, verifiedDeploySha });
    if (!snap || !snap.root) return { ok: false, errors: [err('snapshot_adapter', 'adapter returned no root')] };
    return { ok: true, errors: [], root: snap.root, cleanup: snap.cleanup || (() => {}), mode: 'adapter', verifiedDeploySha };
  }
  const sha = String(verifiedDeploySha || '');
  if (!/^[0-9a-f]{40}$/i.test(sha)) return { ok: false, errors: [err('snapshot_sha_invalid', 'verifiedDeploySha required')] };
  const pins = deps.pinnedBins || PINNED_BINS;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'messi-2d1-snap-'));
  const wipe = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* */ } };
  try {
    fs.chmodSync(tmp, 0o700);
    const tarPath = path.join(tmp, `.${sha}.tar`);
    execFileSync(pins.git, ['archive', '--format=tar', sha, '-o', tarPath], {
      cwd: deps.repoRoot, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tf = execFileSync(pins.tar, ['-tf', tarPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const tvf = execFileSync(pins.tar, ['-tvf', tarPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const safe = assertSafeTarMembers(tf, tvf);
    if (!safe.ok) { wipe(); return safe; }
    execFileSync(pins.tar, ['-xf', tarPath, '-C', tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
    fs.unlinkSync(tarPath);
    if ((fs.statSync(tmp).mode & 0o777) !== 0o700) fs.chmodSync(tmp, 0o700);
    return { ok: true, errors: [], root: tmp, mode: 'git_archive', verifiedDeploySha: sha, cleanup: wipe };
  } catch (e) {
    wipe(); return { ok: false, errors: [err('snapshot_failed', e.message)] };
  }
}
function createHeadSnapshot(deps) { return createExactShaSnapshot(deps, deps.verifiedDeploySha || deps.gitExec(['rev-parse', 'HEAD'])); }
function generateStage1InSnapshot(snapRoot, slug) {
  const substitutions = buildSubstitutions(snapRoot, slug);
  const preview = gen.generateDryRunPreview({
    repoRoot: snapRoot, archetype: ARCHETYPE, mode: gen.MODE_DRY_RUN, substitutions,
  });
  if (!preview.ok) {
    return { ok: false, errors: (preview.errors || []).map((e) => err('stage1_generate', String(e))) };
  }
  const mf = (preview.files || []).find((f) => f.relativePath === 'dry-run-manifest.json');
  const manifestBody = mf ? String(mf.content) : `${JSON.stringify(preview.manifest, null, 2)}\n`;
  const manifestBytes = Buffer.from(manifestBody, 'utf8');
  const artifacts = [];
  for (const f of (preview.files || [])) {
    const bytes = Buffer.from(String(f.content), 'utf8');
    const digest = sha256(bytes);
    if (f.sha256 && f.sha256 !== digest) {
      return { ok: false, errors: [err('artifact_hash_mismatch', f.relativePath)] };
    }
    artifacts.push({ relativePath: f.relativePath, sha256: digest, bytes: bytes.length });
  }
  return {
    ok: true, errors: [], manifest: preview.manifest,
    manifestBytes, manifestSha256: sha256(manifestBytes),
    artifacts, substitutions,
    materializeApi: typeof mat.materializeDryRunTo === 'function',
    loadedFrom: path.dirname(require.resolve('./factory-slice1c-dry-run-generator')),
  };
}
function compileBicepInSnapshot(deps, snapRoot) {
  const bytes = deps.bicepBuildBytes(MODULE_REL, snapRoot);
  if (!Buffer.isBuffer(bytes)) return { ok: false, errors: [err('bicep_bytes', 'compiler must return Buffer')] };
  let template;
  try { template = JSON.parse(bytes.toString('utf8')); }
  catch (e) { return { ok: false, errors: [err('bicep_parse', e.message)] }; }
  return { ok: true, errors: [], templateBytes: bytes, template, compiledTemplateSha256: sha256(bytes) };
}
function readActiveSubscription(deps) {
  const acct = JSON.parse(deps.azExec(['account', 'show', '-o', 'json']));
  if (!acct || !acct.id || acct.state !== 'Enabled') {
    return { ok: false, errors: [err('subscription_inactive', 'active subscription missing/disabled')] };
  }
  return { ok: true, errors: [], subscriptionId: acct.id };
}
function assertSubscriptionMatchesAuthority(activeId, expectedId) {
  if (String(activeId) !== String(expectedId)) {
    return {
      ok: false,
      errors: [err('subscription_mismatch',
        `active ${activeId} != repo staging authority ${expectedId}`)],
    };
  }
  return { ok: true, errors: [] };
}
async function getResourceGroup(deps, sub, rg) {
  const res = await deps.armRequest({ method: 'GET', path: `/subscriptions/${sub}/resourcegroups/${rg}?api-version=${ARM_API}` });
  if (res.status === 404) return { ok: true, exists: false, body: null };
  if (res.status >= 200 && res.status < 300) return { ok: true, exists: true, body: res.body };
  return { ok: false, errors: [err('rg_read_failed', `status ${res.status}`)] };
}
function ownershipTags({ tenantSlug, planDigest, deploySha }) {
  return { tenant: tenantSlug, stage: STAGE, owner: OWNER, planDigest, deploySha };
}
function assertOwnedRg(rgBody, expected) {
  const tags = (rgBody && rgBody.tags) || {}; const exp = ownershipTags(expected); const errors = [];
  for (const k of Object.keys(exp)) {
    if (String(tags[k] || '') !== String(exp[k])) errors.push(err('rg_ownership_tuple', `tag ${k} mismatch`));
  }
  return { ok: errors.length === 0, errors, tags };
}
async function queryRgCost(deps, sub, rg) {
  const path = `/subscriptions/${sub}/providers/Microsoft.CostManagement/query?api-version=${COST_API}`;
  const now = deps.now();
  const from = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const to = now.toISOString().slice(0, 10);
  const res = await deps.armRequest({
    method: 'POST', path, body: {
      type: 'ActualCost', timeframe: 'Custom', timePeriod: { from, to },
      dataset: {
        granularity: 'None', aggregation: { totalCost: { name: 'PreTaxCost', function: 'Sum' } },
        filter: { dimensions: { name: 'ResourceGroupName', operator: 'In', values: [rg] } },
      },
    },
  });
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, errors: [err('cost_query_failed', `Cost Management status ${res.status}`)] };
  }
  const rows = (((res.body || {}).properties || {}).rows) || [];
  if (!rows.length) return { ok: true, currentCost: { amount: 0, currency: 'USD', period: { from, to }, empty: true } };
  const amount = Number(rows[0][0]);
  if (!Number.isFinite(amount)) return { ok: false, errors: [err('cost_query_parse', 'cost amount not numeric')] };
  return { ok: true, currentCost: { amount, currency: String(rows[0][1] || 'USD'), period: { from, to }, empty: false } };
}
function estimateMonthlySkus() {
  const estimatedMonthlyUsd = SKU_EST.postgresMonthlyUsd + SKU_EST.staffApiMonthlyUsd
    + SKU_EST.natGatewayMonthlyUsd + SKU_EST.miscMonthlyUsd;
  return { intendedSkus: { ...SKU_EST }, estimatedMonthlyUsd, approvalCeilingUsd: Math.ceil(estimatedMonthlyUsd * 1.25) };
}
function capacityAlertsConfig(actionGroupResourceId) {
  const id = String(actionGroupResourceId || '').trim();
  if (!id) return { enabled: false, reason: 'action_group_required', actionGroupResourceId: null };
  return { enabled: true, reason: 'action_group_supplied', actionGroupResourceId: id };
}
function parseNextLink(nextLink, sub) {
  if (!nextLink) return null;
  let u;
  try { u = new URL(nextLink); } catch (_) {
    return { ok: false, errors: [err('nextlink_invalid', 'unparseable nextLink')] };
  }
  if (u.protocol !== 'https:' || u.hostname !== ARM_HOST) {
    return { ok: false, errors: [err('nextlink_host', `nextLink host ${u.hostname}`)] };
  }
  if (!u.pathname.startsWith(`/subscriptions/${sub}/`)) {
    return { ok: false, errors: [err('nextlink_subscription', 'nextLink subscription drift')] };
  }
  return { ok: true, path: `${u.pathname}${u.search}` };
}
async function armListPaged(deps, startPath, sub) {
  let reqPath = startPath;
  const all = [];
  for (let page = 0; page < MAX_ARM_PAGES; page += 1) {
    const res = await deps.armRequest({ method: 'GET', path: reqPath });
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, errors: [err('arm_list_failed', `status ${res.status} path=${startPath}`)] };
    }
    all.push(...(((res.body || {}).value) || []));
    const nl = (res.body || {}).nextLink;
    if (!nl) return { ok: true, value: all, pages: page + 1 };
    const parsed = parseNextLink(nl, sub);
    if (!parsed.ok) return parsed;
    reqPath = parsed.path;
  }
  return { ok: false, errors: [err('arm_list_truncated', `exceeded ${MAX_ARM_PAGES} pages`)] };
}
async function listRgResources(deps, sub, rg) {
  const listed = await armListPaged(deps,
    `/subscriptions/${sub}/resourceGroups/${rg}/resources?api-version=2021-04-01`, sub);
  if (!listed.ok) return listed;
  return { ok: true, resources: listed.value, pages: listed.pages };
}
async function armGet(deps, path) {
  const res = await deps.armRequest({ method: 'GET', path });
  if (res.status === 404) return { ok: true, exists: false, body: null };
  if (res.status >= 200 && res.status < 300) return { ok: true, exists: true, body: res.body };
  return { ok: false, errors: [err('arm_get_failed', `status ${res.status}`)] };
}
function matchTags(tags, expected) {
  const findings = [];
  const t = tags || {};
  if (!Object.keys(t).length) return [{ code: 'untagged_resource' }];
  for (const k of ['tenant', 'stage', 'owner', 'planDigest', 'deploySha']) {
    if (String(t[k] || '') !== String(expected[k])) findings.push({ code: 'tag_mismatch', tag: k });
  }
  return findings;
}
async function collectLiveInventory(deps, names, expectedTags) {
  const findings = []; const sub = names.subscriptionId; const rg = names.resourceGroupName;
  const listed = await listRgResources(deps, sub, rg); if (!listed.ok) return listed;
  const top = listed.resources.filter((r) => !IGNORE_TYPES.includes(r.type || ''));
  const mi = await armGet(deps,
    `${rid(sub, rg, 'Microsoft.ManagedIdentity/userAssignedIdentities', names.identityName)}?api-version=${MI_API}`);
  if (!mi.ok) return mi;
  const principalId = mi.exists ? String((((mi.body || {}).properties) || {}).principalId || '') : '';
  const contract = buildExpectedResourceContract(names, { principalId: principalId || undefined });
  const seen = new Set();
  for (const r of top) {
    const id = String(r.id || '').toLowerCase();
    if (seen.has(id)) findings.push({ code: 'duplicate_resource', name: r.name, type: r.type });
    seen.add(id);
  }
  const topKeys = new Set(contract.foundationTopLevel.map((e) => `${e.type}|${e.name}`));
  for (const exp of contract.foundationTopLevel) {
    const hits = top.filter((r) => r.type === exp.type && r.name === exp.name);
    if (!hits.length) findings.push({ code: 'missing_resource', name: exp.name, type: exp.type });
    else if (hits.length > 1) findings.push({ code: 'duplicate_resource', name: exp.name, type: exp.type });
    else {
      if ((hits[0].provisioningState || 'Succeeded') !== 'Succeeded') {
        findings.push({ code: 'provisioning_not_succeeded', name: hits[0].name, type: hits[0].type });
      }
      for (const f of matchTags(hits[0].tags, expectedTags)) findings.push({ ...f, name: hits[0].name, type: hits[0].type });
    }
  }
  for (const r of top) {
    if (contract.foundationTopLevel.some((e) => e.type === r.type) && !topKeys.has(`${r.type}|${r.name}`)) {
      findings.push({ code: 'unexpected_resource', name: r.name, type: r.type });
    }
  }
  const nestedLive = [];
  for (const child of contract.nestedChildren) {
    const got = await armGet(deps, `${child.id}?api-version=${child.type.includes('databases') ? PG_API : DNS_API}`);
    if (!got.ok) return got;
    if (!got.exists) { findings.push({ code: 'missing_resource', name: child.name, type: child.type }); continue; }
    nestedLive.push(got.body);
    if (child.taggable) {
      for (const f of matchTags((got.body || {}).tags, expectedTags)) findings.push({ ...f, name: child.name, type: child.type });
    } else if (!String((got.body || {}).id || child.id).includes(child.parentName)) {
      findings.push({ code: 'nested_parent_mismatch', name: child.name, type: child.type });
    }
  }
  const rolesLive = [];
  for (const role of contract.roleAssignments) {
    if (role.kind === 'acr' && !principalId) {
      findings.push({ code: 'missing_role_assignment', kind: 'acr' }); continue;
    }
    const expected = role.kind === 'acr'
      ? buildExpectedResourceContract(names, { principalId }).roleAssignments.find((x) => x.kind === 'acr') : role;
    const exactRole = await armGet(deps, `${expected.id}?api-version=${ROLE_API}`);
    if (!exactRole.ok) return exactRole;
    const hit = exactRole.exists ? exactRole.body : null;
    if (!hit) findings.push({ code: 'missing_role_assignment', kind: role.kind, name: expected.name });
    else {
      rolesLive.push(hit);
      if (!String(((hit.properties) || {}).roleDefinitionId || '').toLowerCase()
        .endsWith(expected.roleDefinitionId.toLowerCase())) {
        findings.push({ code: 'role_assignment_wrong_definition', kind: role.kind });
      }
    }
  }
  const secList = await armListPaged(deps,
    `${rid(sub, rg, 'Microsoft.KeyVault/vaults', names.keyVaultName)}/secrets?api-version=${KV_API}`, sub);
  if (!secList.ok) return secList;
  const secretMeta = secList.value.map((s) => ({
    id: s.id, name: String(s.name || (s.id || '').split('/').pop()),
    type: 'Microsoft.KeyVault/vaults/secrets', tags: s.tags || {},
  }));
  const secretByName = new Map();
  for (const s of secretMeta) {
    if (secretByName.has(s.name)) findings.push({ code: 'duplicate_resource', name: s.name, type: s.type });
    secretByName.set(s.name, s);
  }
  let secretsExact = 0;
  for (const exp of contract.runtimeSecrets) {
    const exactSecret = await armGet(deps, `${exp.id}?api-version=${KV_API}`);
    if (!exactSecret.ok) return exactSecret;
    if (!exactSecret.exists) continue;
    const s = exactSecret.body || {};
    secretsExact += 1;
    for (const f of matchTags(s.tags, expectedTags)) findings.push({ ...f, name: s.name, type: s.type });
  }
  for (const [name, s] of secretByName) {
    if (!contract.runtimeSecretNames.includes(name)) findings.push({ code: 'unexpected_resource', name, type: s.type });
  }
  const jobGot = await armGet(deps, `${rid(sub, rg, 'Microsoft.App/jobs', names.bootstrapJobName)}?api-version=${APP_API}`);
  if (!jobGot.ok) return jobGot;
  if (jobGot.exists) {
    for (const f of matchTags((jobGot.body || {}).tags, expectedTags)) {
      findings.push({ ...f, name: names.bootstrapJobName, type: 'Microsoft.App/jobs' });
    }
  }
  const appGot = await armGet(deps,
    `${rid(sub, rg, 'Microsoft.App/containerApps', names.staffApiAppName)}?api-version=${APP_API}`);
  if (!appGot.ok) return appGot;
  const known = new Set([
    ...contract.foundationTopLevel.map((e) => `${e.type}|${e.name}`),
    `${contract.bootstrapJob.type}|${contract.bootstrapJob.name}`,
    `${contract.runtimeApp.type}|${contract.runtimeApp.name}`,
  ]);
  for (const r of top) {
    if (known.has(`${r.type}|${r.name}`)) continue;
    if (/\/secrets$|roleAssignments/.test(r.type || '')) continue;
    if (contract.nestedChildren.some((e) => r.type === e.type
      && (r.name === e.name || String(r.name || '').endsWith(`/${e.name}`)))) continue;
    findings.push({ code: 'unexpected_resource', name: r.name, type: r.type });
  }
  return {
    ok: true, contract, resources: listed.resources, topLevel: top, nestedLive, rolesLive, secretMeta,
    secretsExact, secretCount: secretMeta.length, jobExists: !!jobGot.exists, job: jobGot.body,
    appExists: !!appGot.exists, appBody: appGot.body, principalId, findings, pages: listed.pages,
  };
}
function inferLivePhase(live) {
  if (!live || live.rgExists === false) return 'absent';
  const secretsComplete = live.secretsExact === 14 && live.secretCount === 14;
  const rolesOk = (live.rolesLive || []).length === 2;
  if (live.appExists && secretsComplete && rolesOk) return 'runtime';
  if (secretsComplete && rolesOk && !live.appExists) return 'runtime-prereqs';
  if (live.jobExists) return 'bootstrap-active';
  return 'foundation';
}
function phaseContractFindings(live, phase) {
  const findings = [...(live.findings || [])]; const c = live.contract;
  const pushMiss = (name, type) => {
    if (!findings.some((f) => f.code === 'missing_resource' && f.name === name)) {
      findings.push({ code: 'missing_resource', name, type });
    }
  };
  for (const exp of c.foundationTopLevel) {
    if (!(live.topLevel || []).some((r) => r.type === exp.type && r.name === exp.name)) pushMiss(exp.name, exp.type);
  }
  const banJobAppSecrets = (banSecrets) => {
    if (live.jobExists && phase !== 'bootstrap-active') {
      findings.push({ code: 'unexpected_resource', name: c.bootstrapJob.name, type: c.bootstrapJob.type });
    }
    if (banSecrets && live.secretCount > 0) {
      findings.push({ code: 'unexpected_resource', type: 'Microsoft.KeyVault/vaults/secrets' });
    }
    if (live.appExists && phase !== 'runtime') {
      findings.push({ code: 'unexpected_resource', name: c.runtimeApp.name, type: c.runtimeApp.type });
    }
  };
  if (phase === 'foundation') banJobAppSecrets(true);
  else if (phase === 'bootstrap-active') {
    if (!live.jobExists) pushMiss(c.bootstrapJob.name, c.bootstrapJob.type);
    banJobAppSecrets(true);
  } else if (phase === 'runtime-prereqs' || phase === 'runtime') {
    for (const exp of c.runtimeSecrets) {
      if (!(live.secretMeta || []).some((s) => s.name === exp.name)) pushMiss(exp.name, exp.type);
    }
    if ((live.rolesLive || []).length < 2) findings.push({ code: 'missing_role_assignment', expectedMin: 2 });
    if (live.jobExists) findings.push({ code: 'unexpected_resource', name: c.bootstrapJob.name, type: c.bootstrapJob.type });
    if (phase === 'runtime-prereqs' && live.appExists) {
      findings.push({ code: 'unexpected_resource', name: c.runtimeApp.name, type: c.runtimeApp.type });
    }
    if (phase === 'runtime' && !live.appExists) pushMiss(c.runtimeApp.name, c.runtimeApp.type);
  }
  return findings;
}
async function readAppRuntime(deps, names) {
  const appPath = `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}/providers/Microsoft.App/containerApps/${names.staffApiAppName}?api-version=${APP_API}`;
  const app = await deps.armRequest({ method: 'GET', path: appPath });
  if (app.status === 404) return { ok: true, exists: false };
  if (app.status < 200 || app.status >= 300) return { ok: false, errors: [err('app_read_failed', `status ${app.status}`)] };
  const props = (app.body || {}).properties || {};
  const rev = props.latestRevisionName;
  const fqdn = ((props.configuration || {}).ingress || {}).fqdn;
  const containers = ((props.template || {}).containers) || [];
  const envMap = Object.fromEntries(((containers[0] && containers[0].env) || []).map((e) => [e.name, e.value]));
  const scale = ((props.template || {}).scale) || {};
  let revision = null;
  if (rev) {
    const rr = await deps.armRequest({
      method: 'GET', path: `${appPath.replace(/\?.*$/, '')}/revisions/${rev}?api-version=${APP_API}`,
    });
    revision = (rr.body || {}).properties || null;
  }
  const image = containers[0] && containers[0].image;
  const imageOk = typeof image === 'string' && image.startsWith(`${ACR_LOGIN}/${IMAGE_REPO}@sha256:`);
  const readyTerminal = props.provisioningState === 'Succeeded' && revision
    && String(revision.runningState || '') === 'Running' && String(revision.healthState || '') === 'Healthy';
  const tenantIdentityOk = envMap.DEFAULT_CLIENT_SLUG === names.tenantSlug
    && envMap.STAFF_API_INGRESS_TENANT_SLUG === names.tenantSlug;
  const safetyOk = envMap.STAFF_ACTIONS_ENABLED === 'false'
    && envMap.STRIPE_LINKS_ENABLED === 'false' && envMap.WHATSAPP_DRY_RUN === 'true';
  let healthIdentityOk = false; let healthIdentityBody = null;
  if (fqdn) {
    try {
      const health = await deps.httpsRequest({
        method: 'GET', hostname: fqdn, path: HEALTH_IDENTITY_PATH, protocol: 'https:',
        headers: { host: fqdn }, rejectUnauthorized: true, timeout: 10000,
      });
      if (health.status === 200) {
        try { healthIdentityBody = JSON.parse(health.body); } catch (_) { healthIdentityBody = null; }
        healthIdentityOk = assertPublicHealthIdentityBody(healthIdentityBody, names.tenantSlug).ok;
      }
    } catch (_) { healthIdentityOk = false; }
  }
  return {
    ok: true, exists: true,
    app: {
      id: app.body.id, tags: (app.body && app.body.tags) || {},
      provisioningState: props.provisioningState, latestRevisionName: rev, fqdn,
      image, imageOk, readyTerminal, replicas: revision ? Number(revision.replicas || 0) : null,
      minReplicas: scale.minReplicas, maxReplicas: scale.maxReplicas,
      revisionHealth: revision && revision.healthState, revisionRunning: revision && revision.runningState,
      tenantIdentityOk, safetyOk, healthIdentityOk, healthIdentityBody,
      envSafety: {
        DEFAULT_CLIENT_SLUG: envMap.DEFAULT_CLIENT_SLUG || null,
        STAFF_API_INGRESS_TENANT_SLUG: envMap.STAFF_API_INGRESS_TENANT_SLUG || null,
        STAFF_ACTIONS_ENABLED: envMap.STAFF_ACTIONS_ENABLED || null,
        STRIPE_LINKS_ENABLED: envMap.STRIPE_LINKS_ENABLED || null, WHATSAPP_DRY_RUN: envMap.WHATSAPP_DRY_RUN || null,
      },
    },
  };
}
async function deriveAuthority(opts, deps) {
  const slugGate = validateSlug(opts.slug);
  if (!slugGate.ok) return slugGate;
  const slug = slugGate.slug;
  let verifiedDeploySha = deps.verifiedDeploySha || null;
  let pre = null;
  if (!deps.inExactSnapshot) {
    pre = assertRepoDeployPreflight(deps);
    if (!pre.ok) return pre;
    verifiedDeploySha = pre.verifiedDeploySha;
  } else if (!verifiedDeploySha) {
    return { ok: false, errors: [err('verified_sha_required', 'internal mode needs verifiedDeploySha')] };
  } else {
    pre = { ok: true, errors: [], verifiedDeploySha, deploySha: verifiedDeploySha, branch: 'master' };
  }
  const tools = deps.toolAuthority || hashPinnedToolAuthority(deps);
  let snapRoot = deps.repoRoot;
  let cleanup = () => {};
  if (!deps.inExactSnapshot) {
    const snap = createExactShaSnapshot(deps, verifiedDeploySha);
    if (!snap.ok) return snap;
    snapRoot = snap.root;
    cleanup = snap.cleanup;
  }
  try {
    const expectedSub = readStagingSubscriptionAuthority(snapRoot);
    if (!expectedSub.ok) return expectedSub;
    const active = readActiveSubscription(deps);
    if (!active.ok) return active;
    const subMatch = assertSubscriptionMatchesAuthority(active.subscriptionId, expectedSub.subscriptionId);
    if (!subMatch.ok) return subMatch;
    const man = generateStage1InSnapshot(snapRoot, slug);
    if (!man.ok) return man;
    if (deps.inExactSnapshot) {
      const snapLib = path.join(snapRoot, 'scripts', 'lib');
      if (!String(man.loadedFrom).startsWith(snapLib)) {
        return { ok: false, errors: [err('modules_not_from_snapshot', 'Stage1 modules escaped snapshot')] };
      }
    }
    const compiled = compileBicepInSnapshot(deps, snapRoot);
    if (!compiled.ok) return compiled;
    const names = deriveNames(slug, expectedSub.subscriptionId);
    const skus = estimateMonthlySkus();
    const alerts = capacityAlertsConfig(opts.actionGroupResourceId);
    const core = {
      schemaVersion: 1, authority: 'repo_stage1_generator_azure', stage: STAGE, ownerTag: OWNER,
      tenantSlug: names.tenantSlug, resourceGroupName: names.resourceGroupName,
      subscriptionId: names.subscriptionId, appNamePrefix: names.appNamePrefix, appDbName: names.appDbName,
      deploySha: verifiedDeploySha,
      compiledTemplateSha256: compiled.compiledTemplateSha256,
      compiledTemplateBytes: compiled.templateBytes.length,
      manifestSha256: man.manifestSha256, moduleRel: MODULE_REL,
      stagingSubscriptionConfigSha256: expectedSub.configSha256,
      toolAuthority: {
        gitSha256: tools.gitSha256, tarSha256: tools.tarSha256, nodeSha256: tools.nodeSha256,
        azSha256: tools.azSha256, bicepSha256: tools.bicepSha256, bicepVersion: tools.bicepVersion,
        gitPath: PINNED_BINS.git, tarPath: PINNED_BINS.tar, nodePath: PINNED_BINS.node,
        azPath: PINNED_BINS.az, bicepPath: PINNED_BINS.bicep,
      },
      acrName: ACR_NAME, acrLoginServer: ACR_LOGIN, staffApiImageRepository: IMAGE_REPO,
      location: LOC, containerAppsLocation: ACA_LOC, intendedSkus: skus.intendedSkus,
      estimatedMonthlyUsd: skus.estimatedMonthlyUsd, approvalCeilingUsd: skus.approvalCeilingUsd,
      capacityAlerts: alerts,
    };
    const planDigest = sha256(sortedStringify(core));
    return {
      ok: true, errors: [], slug, names, pre, expectedSub, active, man, compiled, core,
      planDigest, skus, alerts, templateBytes: compiled.templateBytes,
      verifiedDeploySha, tools, snapRoot,
    };
  } finally {
    cleanup();
  }
}
function readCapabilityFd(fd = CAPABILITY_FD) {
  try {
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    if (n <= 0) return { ok: false, errors: [err('internal_capability_missing', 'empty capability FD')] };
    const payload = JSON.parse(buf.slice(0, n).toString('utf8').trim());
    if (!payload || typeof payload.capability !== 'string' || payload.capability.length < 32) {
      return { ok: false, errors: [err('internal_capability_invalid', 'capability too short')] };
    }
    return { ok: true, errors: [], payload };
  } catch (e) {
    return { ok: false, errors: [err('internal_capability_required', e.message)] };
  }
}
function execSnapshotWorker(opts, deps) {
  const payload = {
    capability: crypto.randomBytes(32).toString('hex'),
    verifiedDeploySha: opts.verifiedDeploySha, toolAuthority: opts.tools, snapRoot: opts.snapRoot,
  };
  if (typeof deps.snapshotWorker === 'function') return deps.snapshotWorker({ payload, argv: opts.argv || [] });
  const pins = deps.pinnedBins || PINNED_BINS;
  return new Promise((resolve, reject) => {
    const child = spawn(pins.node, [path.join(opts.snapRoot, CLI_REL), INTERNAL_FLAG, ...(opts.argv || [])], {
      cwd: opts.snapRoot, env: buildSanitizedChildEnv(), stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdio[CAPABILITY_FD].write(`${JSON.stringify(payload)}\n`);
    child.stdio[CAPABILITY_FD].end();
    child.on('error', reject);
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch (_) { /* */ }
      resolve({
        ok: code === 0 && parsed && parsed.ok === true, exitCode: code, stdout, stderr, result: parsed,
        errors: (parsed && parsed.errors) || [err('snapshot_worker_failed', redact(stderr || `exit ${code}`))],
      });
    });
  });
}
async function runProductionParent(argv, depsIn) {
  const deps = depsIn || createDeps();
  const pre = assertRepoDeployPreflight(deps);
  if (!pre.ok) return pre;
  const verifiedDeploySha = pre.verifiedDeploySha;
  const launch = verifyLauncherBytes(deps, verifiedDeploySha);
  if (!launch.ok) return launch;
  const tools = hashPinnedToolAuthority(deps);
  const snap = createExactShaSnapshot(deps, verifiedDeploySha);
  if (!snap.ok) return snap;
  try {
    const worker = await execSnapshotWorker({ snapRoot: snap.root, verifiedDeploySha, tools, argv }, deps);
    const post = assertRepoDeployPreflight(deps);
    if (!post.ok) return post;
    if (post.verifiedDeploySha !== verifiedDeploySha) {
      return { ok: false, errors: [err('post_child_sha_drift', 'HEAD/origin/master changed after worker')] };
    }
    return worker.result || { ok: false, errors: worker.errors || [err('snapshot_worker_failed', 'no result')] };
  } finally { snap.cleanup(); }
}
async function plan(opts, depsIn) {
  const deps = depsIn || createDeps();
  try {
    const d = await deriveAuthority(opts || {}, deps);
    if (!d.ok) return d;
    const rg = await getResourceGroup(deps, d.expectedSub.subscriptionId, d.names.resourceGroupName);
    if (!rg.ok) return rg;
    if (rg.exists) {
      return { ok: false, errors: [err('rg_exists', `target RG ${d.names.resourceGroupName} already exists — PLAN requires absent`)] };
    }
    const cost = await queryRgCost(deps, d.expectedSub.subscriptionId, d.names.resourceGroupName);
    if (!cost.ok) return cost;
    return {
      ok: true, errors: [],
      plan: {
        ...d.core, planDigest: d.planDigest, rgExists: false, currentCost: cost.currentCost,
        templateBytes: d.templateBytes.length, artifacts: d.man.artifacts,
      },
    };
  } catch (e) {
    return { ok: false, errors: [err('plan_exception', redact(e.message))] };
  }
}
async function status(opts, depsIn) {
  const deps = depsIn || createDeps();
  try {
    const d = await deriveAuthority(opts || {}, deps);
    if (!d.ok) return d;
    const planDigest = d.planDigest;
    const rg = await getResourceGroup(deps, d.expectedSub.subscriptionId, d.names.resourceGroupName);
    if (!rg.ok) return rg;
    if (!rg.exists) {
      return {
        ok: true, errors: [], present: false, phase: 'absent', comparedAgainst: 'arm_readback',
        ignoresLocalState: true, planDigest, resourceGroupName: d.names.resourceGroupName,
        expectedNames: d.names, expectedContract: buildExpectedResourceContract(d.names), resources: [],
      };
    }
    const owned = assertOwnedRg(rg.body, {
      tenantSlug: d.names.tenantSlug, planDigest, deploySha: d.verifiedDeploySha,
    });
    const expectedTags = ownershipTags({
      tenantSlug: d.names.tenantSlug, planDigest, deploySha: d.verifiedDeploySha,
    });
    const live = await collectLiveInventory(deps, d.names, expectedTags);
    if (!live.ok) return live;
    live.rgExists = true;
    const phase = inferLivePhase(live);
    const findings = [];
    if (!owned.ok) findings.push(...owned.errors.map((e) => ({ code: e.code, message: e.message })));
    findings.push(...phaseContractFindings(live, phase));
    let app = null;
    if (phase === 'runtime' && live.appExists) {
      const appRead = await readAppRuntime(deps, d.names);
      if (!appRead.ok) {
        return { ...appRead, present: true, phase, comparedAgainst: 'arm_readback', ignoresLocalState: true };
      }
      if (appRead.exists) {
        app = appRead.app;
        if (!app.readyTerminal) findings.push({ code: 'app_not_ready_terminal' });
        if (!app.imageOk) findings.push({ code: 'app_image_mismatch' });
        if (!app.fqdn) findings.push({ code: 'app_fqdn_missing' });
        if (!(app.replicas >= 1)) findings.push({ code: 'app_replicas_invalid' });
        if (!app.tenantIdentityOk) findings.push({ code: 'tenant_identity_mismatch' });
        if (!app.safetyOk) findings.push({ code: 'safety_flags_mismatch' });
        if (!app.healthIdentityOk) findings.push({ code: 'health_identity_failed' });
      } else {
        findings.push({ code: 'missing_resource', name: d.names.staffApiAppName, type: 'Microsoft.App/containerApps' });
      }
    }
    const okStatus = findings.length === 0;
    return {
      ok: okStatus,
      errors: okStatus ? [] : findings.map((f) => err(f.code, f.message || f.code)),
      present: true, phase, comparedAgainst: 'arm_readback', ignoresLocalState: true,
      planDigest, rgTags: (rg.body && rg.body.tags) || {},
      resources: live.resources.map((r) => ({
        id: r.id, name: r.name, type: r.type, tags: r.tags || {},
        provisioningState: r.provisioningState || null,
      })),
      findings, app, expectedNames: d.names, expectedContract: live.contract,
      live: { secretsExact: live.secretsExact, secretCount: live.secretCount, jobExists: live.jobExists, appExists: live.appExists, roles: live.rolesLive.length },
    };
  } catch (e) {
    return { ok: false, errors: [err('status_exception', redact(e.message))] };
  }
}
module.exports = Object.freeze({
  STAGE, OWNER, MODULE_REL, STAGING_SUB_REL, SKU_EST, COST_API, HEALTH_IDENTITY_PATH,
  PINNED_BINS, INTERNAL_FLAG, CAPABILITY_FD, CLI_REL, LIB_REL,
  ROLE_KV_SECRETS_USER, ROLE_ACR_PULL, ACR_RG, IGNORE_TYPES,
  createDeps, deriveNames, plan, status, buildExpectedResourceContract, inferLivePhase,
  runtimeSecretNames, azureArmGuid, collectLiveInventory, phaseContractFindings,
  readStagingSubscriptionAuthority, assertRepoDeployPreflight, createHeadSnapshot,
  createExactShaSnapshot, assertSafeTarMembers, verifyLauncherBytes, hashPinnedToolAuthority,
  buildSanitizedChildEnv, readCapabilityFd, execSnapshotWorker, runProductionParent,
  listRgResources, queryRgCost, ownershipTags, sha256, sortedStringify, redact,
});
