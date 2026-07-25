#!/usr/bin/env node
'use strict';
/** verify:messi-saas-stage2d1-plan-status — offline Stage 2D1 plan/status gate (no Azure writes). */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const healthz = require('./lib/staff-api-healthz');
const healthId = require('./lib/staff-api-health-identity');
const ROOT = path.join(__dirname, '..');
const BASE = 'ee5f344e1bd48bf02d5fa1adedcb2e89e2d5df68';
const LIB_REL = 'scripts/lib/messi-saas-stage2d1-plan-status.js';
const CLI_REL = 'scripts/messi-saas-stage2d1-plan-status.js';
const DOC_REL = 'docs/MESSI-SAAS-STAGE2D1-PLAN-STATUS.md';
const MOD_REL = 'infra/azure/modules/tenant-staging/main.bicep';
const WRAP_REL = 'infra/azure/sunset-staging/main.bicep';
const SUB_CFG = 'config/azure-staging-subscription.json';
const HID_REL = 'scripts/lib/staff-api-health-identity.js';
const API_REL = 'scripts/staff-query-api.js';
const FILES = [LIB_REL, CLI_REL, 'scripts/verify-messi-saas-stage2d1-plan-status.js', DOC_REL,
  'package.json', MOD_REL, SUB_CFG, HID_REL, API_REL];
const SLUG = 'synthdemo';
const SUB = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
const RG = `luna-${SLUG}-staging-rg`;
const SHA = 'a'.repeat(40);
const PREFIX = `luna-${SLUG}-staging`;
const TPL_BYTES = Buffer.from(JSON.stringify({
  $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
  contentVersion: '1.0.0.0', resources: [{ type: 'Microsoft.Resources/deployments', name: 'tenant' }], outputs: {},
}), 'utf8');
let pass = 0; let fail = 0;
const ok = (n, c, d) => { if (c) { pass += 1; console.log(`  PASS  ${n}`); }
else { fail += 1; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); } };
function diffStat() {
  const out = execFileSync('git', ['diff', '--numstat', BASE, '--', ...FILES], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  let rawAdd = 0; let rawDel = 0; const perFile = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [a, d, file] = line.split('\t');
    const add = a === '-' ? 0 : Number(a); const del = d === '-' ? 0 : Number(d);
    rawAdd += add; rawDel += del; perFile.push({ file, add, del });
  }
  for (const rel of FILES) {
    if (perFile.some((p) => p.file === rel)) continue;
    const abs = path.join(ROOT, rel); if (!fs.existsSync(abs)) continue;
    let baseLines = 0;
    try {
      baseLines = execFileSync('git', ['show', `${BASE}:${rel}`], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).split(/\r?\n/).length;
    } catch (_) { baseLines = 0; }
    const cur = fs.readFileSync(abs, 'utf8').split(/\r?\n/).length;
    if (!baseLines) { rawAdd += cur; perFile.push({ file: rel, add: cur, del: 0 }); }
  }
  return { rawAdd, rawDel, net: rawAdd - rawDel, files: perFile.length };
}
function ownedTags(digest) {
  return { tenant: SLUG, stage: 'saas-2d1', owner: 'messi-stage2d1', planDigest: digest, deploySha: SHA };
}
const PID = '11111111-2222-3333-4444-555555555555';
const BICEP = ['/opt/data/.azure/bin/bicep', '/opt/data/home/.azure/bin/bicep'].find((p) => fs.existsSync(p));
function foundationTop(lib, tags) {
  const c = lib.buildExpectedResourceContract(lib.deriveNames(SLUG, SUB), { principalId: PID });
  return c.foundationTopLevel.map((r) => ({
    id: r.id, name: r.name, type: r.type, tags, provisioningState: 'Succeeded',
  }));
}
function makeHarness(lib, opts = {}) {
  const armLog = []; const gitLog = [];
  let rg = null; let resources = []; let app = null; let job = null;
  let secrets = []; let rolesByScope = {}; let nested = {};
  let deployments = []; let deploymentPages = null; let deploymentListStatus = null;
  let costFail = false; let costRows = [[12.5, 'USD']];
  let identityOk = true; let branch = 'master'; let pages = null;
  let miBody = { properties: { principalId: PID } };
  // Default GREEN: Microsoft.AlertsManagement Registered (live defect was NotRegistered).
  let providerHttpStatus = 200;
  let providerBody = {
    id: `/subscriptions/${SUB}/providers/Microsoft.AlertsManagement`,
    namespace: 'Microsoft.AlertsManagement',
    registrationState: 'Registered',
  };
  const fakeTools = {
    gitSha256: '1'.repeat(64), tarSha256: '2'.repeat(64), nodeSha256: '3'.repeat(64),
    azSha256: '4'.repeat(64), bicepSha256: '5'.repeat(64), bicepVersion: 'Bicep CLI version 0.45.15 (test)',
  };
  const notFound = { status: 404, body: {} };
  const isDepListPath = (p) => /\/providers\/Microsoft\.Resources\/deployments(\?|$)/i.test(p)
    || (/Microsoft\.Resources\/deployments/i.test(p) && /\$skiptoken=/i.test(p)
      && !/\/deployments\/[^/?]+(\?|$)/i.test(p));
  const deps = lib.createDeps({
    repoRoot: ROOT, sleep: async () => {}, now: () => new Date('2026-07-23T12:00:00Z'),
    toolAuthority: opts.toolAuthority || fakeTools, verifiedDeploySha: opts.verifiedDeploySha || SHA,
    inExactSnapshot: opts.inExactSnapshot === true,
    snapshotAdapter: opts.snapshotAdapter === null ? null
      : (opts.snapshotAdapter || (() => ({ root: ROOT, cleanup: () => {} }))),
    gitExec: (args) => {
      const a = args.join(' '); gitLog.push(a);
      if (a === 'fetch origin master') return '';
      if (a === 'rev-parse --abbrev-ref HEAD') return branch;
      if (a === 'status --porcelain') return opts.dirty ? ' M x' : '';
      if (a === 'rev-parse HEAD' || a === 'rev-parse origin/master') return SHA;
      return '';
    },
    azExec: (args) => {
      if (args[0] === 'account' && args[1] === 'show') {
        return JSON.stringify({ id: opts.activeSub || SUB, name: 'staging', state: 'Enabled' });
      }
      if (args[0] === 'account' && args[1] === 'get-access-token') {
        return JSON.stringify({ accessToken: 'TEST_TOKEN_NOT_SECRET', expiresOn: '2099-01-01' });
      }
      throw new Error(`unexpected_az:${args.join(' ')}`);
    },
    bicepBuildBytes: () => Buffer.from(TPL_BYTES),
    armRequest: async (req) => {
      armLog.push({ method: req.method, path: req.path, body: req.body || null });
      const p = req.path || '';
      // Subscription-scope provider registration GET (not RG-scoped providers).
      if (req.method === 'GET'
        && /^\/subscriptions\/[^/]+\/providers\/Microsoft\.AlertsManagement(\?|$)/i.test(p)
        && !/resource[Gg]roups/i.test(p)) {
        return { status: providerHttpStatus, body: providerBody };
      }
      if (req.method === 'GET' && /resourcegroups\/[^/?]+(\?|$)/i.test(p)
        && !/providers\//i.test(p.split('resourcegroups/')[1] || '')) {
        return rg ? { status: 200, body: rg } : { status: 404, body: { error: { code: 'ResourceGroupNotFound' } } };
      }
      if (/CostManagement\/query/i.test(p)) {
        return costFail ? { status: 503, body: {} }
          : { status: 200, body: { properties: { columns: [{ name: 'PreTaxCost' }, { name: 'Currency' }], rows: costRows } } };
      }
      // Independent Microsoft.Resources/deployments LIST (not generic /resources).
      if (isDepListPath(p)) {
        if (deploymentListStatus != null) {
          return { status: deploymentListStatus, body: { error: { code: 'HarnessForced' } } };
        }
        if (Array.isArray(deploymentPages)) {
          const n = armLog.filter((x) => isDepListPath(x.path || '')).length - 1;
          return { status: 200, body: deploymentPages[n] || { value: [] } };
        }
        return { status: 200, body: { value: deployments } };
      }
      // Exact deployment GET (Failure-Anomalies SHOW readback).
      if (req.method === 'GET' && /\/deployments\/[^/?]+(\?|$)/i.test(p)) {
        const name = decodeURIComponent((p.match(/\/deployments\/([^/?]+)/i) || [])[1] || '');
        const hit = (deployments || []).find((d) => String(d.name || '') === name);
        if (!hit) return notFound;
        return {
          status: 200,
          body: {
            id: hit.id,
            name: hit.name,
            type: hit.type || 'Microsoft.Resources/deployments',
            properties: hit.properties || { provisioningState: hit.provisioningState || 'Succeeded' },
          },
        };
      }
      if (/\/resources(\?|&|$)/i.test(p) || (/skiptoken=/i.test(p) && /\/resources/i.test(p))) {
        if (Array.isArray(pages)) {
          return { status: 200, body: pages[armLog.filter((x) => /\/resources/i.test(x.path)).length - 1] || { value: [] } };
        }
        return { status: 200, body: { value: resources } };
      }
      // Exact smart-detector provider GET (pinned SMART_DETECTOR_API).
      if (req.method === 'GET' && /smartDetectorAlertRules\//i.test(p)) {
        const rawName = decodeURIComponent((p.match(/smartDetectorAlertRules\/([^/?]+)/i) || [])[1] || '');
        const hit = (resources || []).find((r) => r
          && /smartDetectorAlertRules/i.test(String(r.type || ''))
          && (String(r.name || '') === rawName
            || String(r.name || '').toLowerCase() === rawName.toLowerCase()));
        if (!hit) return notFound;
        return { status: 200, body: hit };
      }
      if (/userAssignedIdentities\//i.test(p)) return miBody ? { status: 200, body: miBody } : notFound;
      if (/roleAssignments/i.test(p)) {
        const m = p.match(/roleAssignments\/([0-9a-f-]{36})(?:\?|$)/i);
        if (m) {
          for (const list of Object.values(rolesByScope)) {
            const hit = (list || []).find((r) => String(r.name || '').toLowerCase() === m[1].toLowerCase());
            if (hit) return { status: 200, body: hit };
          }
          return notFound;
        }
        return { status: 200, body: { value: rolesByScope[p.split('/providers/Microsoft.Authorization/roleAssignments')[0]] || [] } };
      }
      if (/KeyVault\/vaults/i.test(p) && /\/secrets(\/|\?|$)/i.test(p)) {
        const m = p.match(/\/secrets\/([^/?]+)(?:\?|$)/i);
        if (m) {
          const hit = secrets.find((s) => s.name === decodeURIComponent(m[1]));
          return hit ? { status: 200, body: { id: hit.id, name: hit.name, tags: hit.tags || {} } } : notFound;
        }
        return { status: 200, body: { value: secrets } };
      }
      if (/databases\//i.test(p) || /virtualNetworkLinks\//i.test(p)) {
        const key = Object.keys(nested).find((k) => p.includes(k));
        return key ? { status: 200, body: nested[key] } : notFound;
      }
      if (/\/jobs\//i.test(p) && !/executions/i.test(p)) return job ? { status: 200, body: job } : notFound;
      if (/containerApps\//i.test(p) && !/revisions\//i.test(p)) return app ? { status: 200, body: app } : notFound;
      if (/revisions\//i.test(p)) {
        return { status: 200, body: { properties: { runningState: 'Running', healthState: 'Healthy', replicas: 1 } } };
      }
      if (/roleAssignments\/|\/secrets\//i.test(p)) return notFound;
      return { status: 200, body: {} };
    },
    httpsRequest: async (o) => {
      if ((o.path || '') !== healthId.HEALTH_IDENTITY_PATH) return { status: 404, body: '' };
      if (!identityOk) return { status: 503, body: '{}' };
      return { status: 200, body: JSON.stringify({ status: 'ok', service: 'staff-api', default_client_slug: SLUG }) };
    },
  });
  return {
    deps, armLog, gitLog,
    setRg(v) { rg = v; }, setResources(v) { resources = v; }, setApp(v) { app = v; },
    setJob(v) { job = v; }, setSecrets(v) { secrets = v; }, setRoles(v) { rolesByScope = v; },
    setNested(v) { nested = v; }, setMi(v) { miBody = v; },
    setDeployments(v) { deployments = v; }, setDeploymentPages(v) { deploymentPages = v; },
    setDeploymentListStatus(v) { deploymentListStatus = v; },
    setCostFail(v) { costFail = v; }, setCostRows(v) { costRows = v; },
    setIdentityOk(v) { identityOk = v; }, setBranch(v) { branch = v; }, setPages(v) { pages = v; },
    setProvider(status, body) { providerHttpStatus = status; providerBody = body; },
    setProviderRegistrationState(state) {
      providerHttpStatus = 200;
      providerBody = {
        id: `/subscriptions/${SUB}/providers/Microsoft.AlertsManagement`,
        namespace: 'Microsoft.AlertsManagement',
        registrationState: state,
      };
    },
  };
}
function seedFoundation(h, lib, tags) {
  const names = lib.deriveNames(SLUG, SUB);
  const c = lib.buildExpectedResourceContract(names, { principalId: PID });
  h.setResources(foundationTop(lib, tags));
  h.setNested({
    [c.nestedChildren[0].id]: { id: c.nestedChildren[0].id, name: c.nestedChildren[0].name, type: c.nestedChildren[0].type },
    [c.nestedChildren[1].id]: {
      id: c.nestedChildren[1].id, name: c.nestedChildren[1].name, type: c.nestedChildren[1].type, tags,
    },
  });
  const kv = c.roleAssignments.find((r) => r.kind === 'kv');
  const acr = c.roleAssignments.find((r) => r.kind === 'acr');
  const roleBody = (role) => [{
    id: role.id, name: role.name, type: role.type,
    properties: {
      roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${role.roleDefinitionId}`,
      principalId: PID, scope: role.scope,
    },
  }];
  h.setRoles({ [kv.scope]: roleBody(kv), [acr.scope]: roleBody(acr) });
  return c;
}
function compileBicep(file) {
  const out = path.join(require('os').tmpdir(), `d1-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  execFileSync(BICEP, ['build', file, '--outfile', out], {
    cwd: ROOT, env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1', PATH: '/usr/bin:/bin' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const json = JSON.parse(fs.readFileSync(out, 'utf8'));
  try { fs.unlinkSync(out); } catch (_) { /* */ }
  return json;
}
async function main() {
  console.log('verify:messi-saas-stage2d1-plan-status — Stage 2D1\n');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok('package_script', pkg.scripts['verify:messi-saas-stage2d1-plan-status']
    === 'node scripts/verify-messi-saas-stage2d1-plan-status.js');
  ok('files_exist', [CLI_REL, LIB_REL, DOC_REL, SUB_CFG].every((r) => fs.existsSync(path.join(ROOT, r))));
  let lib;
  try { lib = require('./lib/messi-saas-stage2d1-plan-status'); }
  catch (e) { ok('lib_loads', false, String(e.message)); process.exit(1); }
  ok('lib_loads', !!lib);
  ok('api_surface', typeof lib.plan === 'function' && typeof lib.status === 'function'
    && typeof lib.createDeps === 'function' && typeof lib.apply !== 'function'
    && typeof lib.rollback !== 'function'
    && typeof lib.deriveKeyVaultName === 'function'
    && typeof lib.isValidAzureKeyVaultName === 'function'
    && typeof lib.canonicalKeyVaultName === 'function'
    && typeof lib.deriveBootstrapJobName === 'function'
    && typeof lib.isValidAzureContainerAppsJobName === 'function'
    && typeof lib.canonicalBootstrapJobName === 'function');
  // Azure Key Vault name owner: RED messiproof canonical invalid (26>24); GREEN shortened valid.
  // Preserve short canonicals; shorten only overlength with stable hash of full canonical.
  {
    const MESSIPROOF = 'messiproof';
    const canonMessi = lib.canonicalKeyVaultName(MESSIPROOF);
    ok('kv_name_red_messiproof_canonical_invalid',
      canonMessi === 'luna-messiproof-staging-kv'
      && canonMessi.length === 26
      && lib.isValidAzureKeyVaultName(canonMessi) === false,
      `canon=${canonMessi} len=${canonMessi.length}`);
    const namesMessi = lib.deriveNames(MESSIPROOF, SUB);
    const kvMessi = namesMessi.keyVaultName;
    ok('kv_name_green_messiproof_valid_from_owner',
      kvMessi === lib.deriveKeyVaultName(MESSIPROOF)
      && lib.isValidAzureKeyVaultName(kvMessi) === true
      && kvMessi.length <= lib.AZURE_KEY_VAULT_NAME_MAX
      && kvMessi.length >= lib.AZURE_KEY_VAULT_NAME_MIN
      && kvMessi !== canonMessi
      && /^[a-z][a-z0-9-]*[a-z0-9]$/.test(kvMessi)
      && !kvMessi.includes('--'),
      `kv=${kvMessi} len=${kvMessi && kvMessi.length}`);
    // Contract / role / secret IDs must all bind the same owner-derived vault name.
    const contractMessi = lib.buildExpectedResourceContract(namesMessi, { principalId: PID });
    const kvTop = contractMessi.foundationTopLevel.find((r) => r.type === 'Microsoft.KeyVault/vaults');
    const kvRole = contractMessi.roleAssignments.find((r) => r.kind === 'kv');
    ok('kv_name_contract_role_secret_ids_use_owner',
      kvTop && kvTop.name === kvMessi
      && kvTop.id.endsWith(`/Microsoft.KeyVault/vaults/${kvMessi}`)
      && kvRole && kvRole.scope.endsWith(`/vaults/${kvMessi}`)
      && (contractMessi.runtimeSecrets || []).every((s) => s.id.includes(`/vaults/${kvMessi}/secrets/`))
      && !JSON.stringify(contractMessi).includes(canonMessi),
      `top=${kvTop && kvTop.name} scope=${kvRole && kvRole.scope}`);
    // Preserve when canonical already <=24 (compatibility — e.g. locked-live sunset).
    const shortSlugs = ['aaa', 'abcdefg', 'abcdefgh', 'sunset'];
    ok('kv_name_preserves_short_canonical',
      shortSlugs.every((s) => {
        const c = lib.canonicalKeyVaultName(s);
        return c.length <= 24
          && lib.deriveKeyVaultName(s) === c
          && lib.isValidAzureKeyVaultName(c);
      }),
      shortSlugs.map((s) => `${s}:${lib.deriveKeyVaultName(s)}`).join(','));
    // Min / max accepted synthetic slug shape ([a-z][a-z0-9]{2,31}).
    const minSlug = 'aaa';
    const maxSlug = `a${'b'.repeat(31)}`;
    const minKv = lib.deriveKeyVaultName(minSlug);
    const maxKv = lib.deriveKeyVaultName(maxSlug);
    ok('kv_name_min_max_slug_edges',
      minSlug.length === 3 && maxSlug.length === 32
      && lib.isValidAzureKeyVaultName(minKv) && lib.isValidAzureKeyVaultName(maxKv)
      && minKv === lib.canonicalKeyVaultName(minSlug)
      && maxKv !== lib.canonicalKeyVaultName(maxSlug)
      && maxKv.length === 24,
      `min=${minKv} max=${maxKv}`);
    // Similar long prefixes must not collide (hash of full canonical).
    const a = lib.deriveKeyVaultName('messiproofaa');
    const b = lib.deriveKeyVaultName('messiproofbb');
    const c = lib.deriveKeyVaultName('abcdefghijlongone');
    const d = lib.deriveKeyVaultName('abcdefghijlongtwo');
    ok('kv_name_long_similar_prefix_no_collision',
      a !== b && c !== d
      && lib.isValidAzureKeyVaultName(a) && lib.isValidAzureKeyVaultName(b)
      && lib.isValidAzureKeyVaultName(c) && lib.isValidAzureKeyVaultName(d)
      && new Set([a, b, c, d]).size === 4,
      `a=${a} b=${b} c=${c} d=${d}`);
    // Deterministic across repeated calls; reserved/slug gates must stay fail-closed.
    const mig = require('./lib/migration-integrity');
    ok('kv_name_deterministic_and_reserved_intact',
      lib.deriveKeyVaultName(MESSIPROOF) === kvMessi
      && lib.deriveKeyVaultName(MESSIPROOF) === lib.deriveKeyVaultName(MESSIPROOF)
      && mig.assertSyntheticTenantSlug('sunset').ok === false
      && mig.assertSyntheticTenantSlug('wolfhouse').ok === false
      && mig.assertSyntheticTenantSlug('prod').ok === false
      && mig.assertSyntheticTenantSlug('wh').ok === false
      && mig.assertSyntheticTenantSlug('ab').ok === false
      && mig.assertSyntheticTenantSlug(MESSIPROOF).ok === true);
    // Bicep module takes keyVaultName param (not prefix-derived) with Azure length bounds.
    const modSrc = fs.readFileSync(path.join(ROOT, MOD_REL), 'utf8');
    ok('kv_name_bicep_param_owner_not_prefix',
      /param keyVaultName string/.test(modSrc)
      && /@maxLength\(24\)/.test(modSrc)
      && /@minLength\(3\)/.test(modSrc)
      && /var kvName = keyVaultName/.test(modSrc)
      && !modSrc.includes("var kvName = '${prefix}-kv'"),
      'bicep still derives kv from prefix');
  }
  // Azure Container Apps Job name owner: RED messiproof canonical invalid (33>32);
  // GREEN owner shortens with stable hash (ContainerAppInvalidName class from live evidence).
  {
    const MESSIPROOF = 'messiproof';
    const canonJob = lib.canonicalBootstrapJobName(MESSIPROOF);
    ok('bootstrap_job_name_red_messiproof_canonical_invalid',
      canonJob === 'luna-messiproof-staging-bootstrap'
      && canonJob.length === 33
      && lib.isValidAzureContainerAppsJobName(canonJob) === false,
      `canon=${canonJob} len=${canonJob.length}`);
    const namesMessi = lib.deriveNames(MESSIPROOF, SUB);
    const jobMessi = namesMessi.bootstrapJobName;
    ok('bootstrap_job_name_green_messiproof_valid_from_owner',
      jobMessi === lib.deriveBootstrapJobName(MESSIPROOF)
      && lib.isValidAzureContainerAppsJobName(jobMessi) === true
      && jobMessi.length <= lib.AZURE_CONTAINER_APPS_JOB_NAME_MAX
      && jobMessi.length >= lib.AZURE_CONTAINER_APPS_JOB_NAME_MIN
      && jobMessi !== canonJob
      && jobMessi === 'luna-messiproof-63aa6df2'
      && /^[a-z][a-z0-9-]*[a-z0-9]$/.test(jobMessi)
      && !jobMessi.includes('--')
      && !/^luna-messiproof-staging-bootstra/.test(jobMessi),
      `job=${jobMessi} len=${jobMessi && jobMessi.length}`);
    // Contract bootstrap job resource binds the same owner-derived name (not raw truncation).
    const contractMessi = lib.buildExpectedResourceContract(namesMessi, { principalId: PID });
    ok('bootstrap_job_name_contract_uses_owner',
      contractMessi.bootstrapJob
      && contractMessi.bootstrapJob.name === jobMessi
      && contractMessi.bootstrapJob.id.endsWith(`/Microsoft.App/jobs/${jobMessi}`)
      && !JSON.stringify(contractMessi.bootstrapJob).includes(canonJob)
      && !JSON.stringify(contractMessi).includes(canonJob),
      `name=${contractMessi.bootstrapJob && contractMessi.bootstrapJob.name}`);
    // Preserve short/edge-valid canonicals (sunset 29, synthdemo exact-32, short slugs).
    const shortSlugs = ['aaa', 'sunset', 'synthdemo'];
    ok('bootstrap_job_name_preserves_short_canonical',
      shortSlugs.every((s) => {
        const c = lib.canonicalBootstrapJobName(s);
        return c.length <= 32
          && lib.deriveBootstrapJobName(s) === c
          && lib.isValidAzureContainerAppsJobName(c);
      }),
      shortSlugs.map((s) => `${s}:${lib.deriveBootstrapJobName(s)}`).join(','));
    // Min / max accepted synthetic slug shape; max must shorten (not raw truncate alone).
    const minSlug = 'aaa';
    const maxSlug = `a${'b'.repeat(31)}`;
    const minJob = lib.deriveBootstrapJobName(minSlug);
    const maxJob = lib.deriveBootstrapJobName(maxSlug);
    const maxCanon = lib.canonicalBootstrapJobName(maxSlug);
    ok('bootstrap_job_name_min_max_slug_edges',
      minSlug.length === 3 && maxSlug.length === 32
      && lib.isValidAzureContainerAppsJobName(minJob)
      && lib.isValidAzureContainerAppsJobName(maxJob)
      && minJob === lib.canonicalBootstrapJobName(minSlug)
      && maxJob !== maxCanon
      && maxJob.length <= 32
      && maxJob.includes(lib.sha256(maxCanon).slice(0, 8)),
      `min=${minJob} max=${maxJob}`);
    // Hostile similar long prefixes must not collide (hash of full canonical).
    const a = lib.deriveBootstrapJobName('messiproofaa');
    const b = lib.deriveBootstrapJobName('messiproofbb');
    const c = lib.deriveBootstrapJobName('abcdefghijlongone');
    const d = lib.deriveBootstrapJobName('abcdefghijlongtwo');
    ok('bootstrap_job_name_long_similar_prefix_no_collision',
      a !== b && c !== d
      && lib.isValidAzureContainerAppsJobName(a) && lib.isValidAzureContainerAppsJobName(b)
      && lib.isValidAzureContainerAppsJobName(c) && lib.isValidAzureContainerAppsJobName(d)
      && new Set([a, b, c, d, jobMessi]).size === 5
      && a !== jobMessi && b !== jobMessi,
      `a=${a} b=${b} c=${c} d=${d}`);
    // Not raw truncation: overlength must include hash suffix of full canonical.
    const rawTrunc = canonJob.slice(0, 32);
    ok('bootstrap_job_name_not_raw_truncation',
      jobMessi !== rawTrunc
      && jobMessi.includes(lib.sha256(canonJob).slice(0, 8))
      && rawTrunc === 'luna-messiproof-staging-bootstra',
      `job=${jobMessi} rawTrunc=${rawTrunc}`);
    // Deterministic; reserved slug gates stay fail-closed.
    const mig = require('./lib/migration-integrity');
    ok('bootstrap_job_name_deterministic_and_reserved_intact',
      lib.deriveBootstrapJobName(MESSIPROOF) === jobMessi
      && lib.deriveBootstrapJobName(MESSIPROOF) === lib.deriveBootstrapJobName(MESSIPROOF)
      && mig.assertSyntheticTenantSlug('sunset').ok === false
      && mig.assertSyntheticTenantSlug(MESSIPROOF).ok === true);
    // Bicep takes bootstrapJobName param (not prefix-derived) with Azure 2..32 bounds.
    const modSrc = fs.readFileSync(path.join(ROOT, MOD_REL), 'utf8');
    ok('bootstrap_job_name_bicep_param_owner_not_prefix',
      /param bootstrapJobName string/.test(modSrc)
      && /@maxLength\(32\)/.test(modSrc)
      && /@minLength\(2\)/.test(modSrc)
      && /var resolvedBootstrapJobName = bootstrapJobName/.test(modSrc)
      && /jobName:\s*resolvedBootstrapJobName/.test(modSrc)
      && !modSrc.includes("var bootstrapJobName = '${prefix}-bootstrap'"),
      'bicep still derives bootstrap job from prefix');
  }
  const doc = fs.readFileSync(path.join(ROOT, DOC_REL), 'utf8');
  const src = fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8') + fs.readFileSync(path.join(ROOT, CLI_REL), 'utf8');
  const apiSrc = fs.readFileSync(path.join(ROOT, API_REL), 'utf8');
  ok('docs_exact_commands', /messi-saas-stage2d1-plan-status\.js plan/.test(doc)
    && /messi-saas-stage2d1-plan-status\.js status/.test(doc) && !/\bapply --/.test(doc)
    && /expected-plan-digest|freshly derived plan digest/i.test(doc));
  ok('readonly_and_authority', !/--manifest[_-]dir/.test(src) && !/\basync function apply\b/.test(src)
    && !/\basync function rollback\b/.test(src) && !/acr',\s*'build'|method:\s*'DELETE'/i.test(src)
    && !/expectedPlanDigest/.test(fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8'))
    && /fetch',\s*'origin',\s*'master'/.test(src) && /branch_not_master/.test(src)
    && /archive',\s*'--format=tar'/.test(src) && !/archive',\s*'--format=tar',\s*'HEAD'/.test(src)
    && /verifiedDeploySha/.test(src) && /0o700|chmodSync\(tmp,\s*0o700\)/.test(src)
    && /snapshotAdapter/.test(src) && /subscription_mismatch/.test(src) && /nextLink/.test(src)
    && /HEALTH_IDENTITY_PATH|healthz\/identity/.test(src)
    && /\/usr\/bin\/git/.test(src) && /\/usr\/local\/bin\/node/.test(src)
    && /internal-snapshot-worker/.test(src) && /readCapabilityFd|CAPABILITY_FD/.test(src)
    && /assertSafeTarMembers|tar_member_/.test(src) && /toolAuthority|bicepVersion/.test(src)
    && /verifyLauncherBytes|launcher_bytes_mismatch/.test(src) && /buildSanitizedChildEnv/.test(src)
    && /account',\s*'get-access-token'/.test(src) && /CostManagement\/query/.test(src)
    && /factory-slice1c-dry-run-generator/.test(src) && /messi-saas-stage1-materialize/.test(src)
    && /realpathSync|lstatSync/.test(src));
  const mod = fs.readFileSync(path.join(ROOT, MOD_REL), 'utf8');
  const wrap = fs.readFileSync(path.join(ROOT, WRAP_REL), 'utf8');
  ok('alerts_and_sub', /param deployCapacityAlerts bool = false/.test(mod)
    && /deployCapacityAlerts && syntheticRuntimePhase/.test(mod)
    && /!enablePrivateNetwork \|\| \(deployCapacityAlerts && syntheticRuntimePhase\)/.test(mod)
    && /opsActionGroupResourceId string = '\/subscriptions\/6dfa56e7/.test(wrap)
    && !/deployCapacityAlerts:/.test(wrap)
    && JSON.parse(fs.readFileSync(path.join(ROOT, SUB_CFG), 'utf8')).subscriptionId === SUB);
  ok('health_identity_endpoint', healthId.HEALTH_IDENTITY_PATH === '/healthz/identity'
    && typeof healthId.handleStaffApiHealthIdentity === 'function'
    && /HEALTH_IDENTITY_PATH/.test(apiSrc) && /handleStaffApiHealthIdentity/.test(apiSrc));
  {
    const bodies = [];
    healthId.handleStaffApiHealthIdentity({}, (res, status, body) => {
      bodies.push({ status, body }); return body;
    }, { env: { DEFAULT_CLIENT_SLUG: SLUG, STRIPE_SECRET_KEY: 'sk_live_SHOULD_NOT_LEAK' } });
    ok('health_identity_no_secrets', bodies[0] && bodies[0].status === 200
      && bodies[0].body.default_client_slug === SLUG
      && !JSON.stringify(bodies[0].body).includes('sk_live')
      && healthId.assertPublicHealthIdentityBody(bodies[0].body, SLUG).ok
      && healthz.assertPublicHealthzBody(healthz.HEALTHZ_BODY).ok);
  }
  {
    const h = makeHarness(lib);
    const r = await lib.plan({ slug: SLUG }, h.deps);
    const costCalls = h.armLog.filter((x) => /CostManagement\/query/i.test(x.path));
    const providerGets = h.armLog.filter((x) => x.method === 'GET'
      && /^\/subscriptions\/[^/]+\/providers\/Microsoft\.AlertsManagement(\?|$)/i.test(x.path || ''));
    ok('plan_ok_core_cost', r.ok === true && r.plan.rgExists === false && r.plan.resourceGroupName === RG
      && /^[a-f0-9]{64}$/.test(r.plan.planDigest) && r.plan.compiledTemplateSha256 === lib.sha256(TPL_BYTES)
      && r.plan.deploySha === SHA && r.plan.subscriptionId === SUB && r.plan.currentCost.amount === 12.5
      && r.plan.capacityAlerts.enabled === false && costCalls.length >= 1
      && r.plan.alertsManagementRegistrationState === 'Registered'
      && providerGets.length >= 1
      && providerGets.every((g) => g.path.includes(SUB) && /api-version=2021-04-01/.test(g.path)
        && !/resource[Gg]roups/i.test(g.path))
      && costCalls.every((c) => c.method === 'POST'
        && /\/subscriptions\/[^/]+\/providers\/Microsoft\.CostManagement\/query/.test(c.path)
        && c.body.dataset.filter.dimensions.values.includes(RG)),
    JSON.stringify(r.errors || r).slice(0, 200));
  }
  // --- Microsoft.AlertsManagement provider preflight (live Failure-Anomalies defect) ---
  {
    const fixPath = path.join(ROOT, 'fixtures/messi-saas-stage2d2/alerts-management-provider-not-registered.json');
    const fix = JSON.parse(fs.readFileSync(fixPath, 'utf8'));
    const bicep = fs.readFileSync(path.join(ROOT, MOD_REL), 'utf8');
    const aiBlock = (bicep.match(/resource appInsights[\s\S]*?\n\}/) || [''])[0];
    ok('provider_fixture_and_template_evidence',
      fix.kind === 'alerts_management_provider_not_registered'
      && fix.subscriptionId === SUB
      && fix.liveProviderShow.registrationState === 'NotRegistered'
      && fix.liveProviderShow.id
        === `/subscriptions/${SUB}/providers/Microsoft.AlertsManagement`
      && fix.observedPlatformDeploymentFromAppInsightsCreate === true
      && fix.repoTemplateDisablePropertyFound === false
      && fix.globalPlatformDeploymentUnavoidabilityClaimed === false
      && fix.platformDeploymentUnavoidableForAppInsights !== true
      && fix.appInsightsComponent.templateDisableSmartDetectionPropertyFound === false
      && /Microsoft\.Insights\/components@2020-02-02/.test(bicep)
      && /Application_Type:\s*'web'/.test(aiBlock)
      && /WorkspaceResourceId:\s*logAnalytics\.id/.test(aiBlock)
      && !/smartDetector|DisableSmart|Failure.?Anomal/i.test(aiBlock)
      && typeof lib.assertAlertsManagementProviderRegistered === 'function'
      && typeof lib.buildAlertsManagementAdminCommands === 'function'
      && lib.ALERTS_MANAGEMENT_NAMESPACE === 'Microsoft.AlertsManagement'
      && lib.REQUIRED_PROVIDER_REGISTRATION_STATE === 'Registered',
    `aiBlock=${aiBlock.slice(0, 120)}`);
    const cmds = lib.buildAlertsManagementAdminCommands(SUB);
    ok('provider_admin_commands_exact',
      Array.isArray(cmds) && cmds.length === 2
      && cmds[0] === `az provider register --namespace Microsoft.AlertsManagement --subscription ${SUB} --wait`
      && cmds[1] === `az provider show --namespace Microsoft.AlertsManagement --subscription ${SUB} --query registrationState -o tsv`
      && !cmds.some((c) => /Contributor|Owner/i.test(c)));
  }
  {
    // RED live shape: NotRegistered where plan used to proceed — GREEN refuses with paste-ready admin guidance.
    const h = makeHarness(lib);
    h.setProviderRegistrationState('NotRegistered');
    const r = await lib.plan({ slug: SLUG }, h.deps);
    const guidance = lib.pasteReadyAlertsManagementAdminGuidance(SUB);
    const providerGets = h.armLog.filter((x) => x.method === 'GET'
      && /Microsoft\.AlertsManagement/i.test(x.path || ''));
    const writes = h.armLog.filter((x) => ['PUT', 'POST', 'DELETE', 'PATCH'].includes(x.method)
      && !/CostManagement/i.test(x.path || ''));
    ok('plan_refuses_provider_NotRegistered_with_admin_guidance',
      r.ok === false
      && (r.errors || []).some((e) => e.code === 'alerts_management_provider_not_registered'
        && /NotRegistered/.test(e.message)
        && e.message.includes(`az provider register --namespace Microsoft.AlertsManagement --subscription ${SUB} --wait`)
        && e.message.includes('registrationState'))
      && providerGets.length >= 1
      && providerGets[0].path === lib.alertsManagementProviderPath(SUB)
      && writes.length === 0
      && guidance.includes('--wait')
      && Array.isArray(r.azureAdminCommands)
      && r.azureAdminCommands[0].includes('az provider register'),
    JSON.stringify(r.errors || r).slice(0, 320));
  }
  {
    for (const state of ['Registering', 'Unregistered', 'NotRegistered']) {
      const h = makeHarness(lib);
      h.setProviderRegistrationState(state);
      const r = await lib.plan({ slug: SLUG }, h.deps);
      ok(`plan_refuses_provider_${state}`,
        r.ok === false
        && (r.errors || []).some((e) => e.code === 'alerts_management_provider_not_registered'
          && String(e.message || '').includes(state)
          && String(e.message || '').includes('az provider register')),
      JSON.stringify(r.errors || r).slice(0, 200));
    }
  }
  {
    const cases = [
      ['malformed_body', 200, 'not-an-object', 'alerts_management_provider_unreadable'],
      ['empty_body', 200, null, 'alerts_management_provider_unreadable'],
      ['http_403', 403, { namespace: 'Microsoft.AlertsManagement', registrationState: 'Registered' },
        'alerts_management_provider_unreadable'],
      ['http_500', 500, { error: { code: 'InternalServerError' } }, 'alerts_management_provider_unreadable'],
      ['wrong_namespace', 200, {
        id: `/subscriptions/${SUB}/providers/Microsoft.Insights`,
        namespace: 'Microsoft.Insights', registrationState: 'Registered',
      }, 'alerts_management_provider_wrong_namespace'],
      ['wrong_sub_in_id', 200, {
        id: '/subscriptions/00000000-0000-0000-0000-000000000099/providers/Microsoft.AlertsManagement',
        namespace: 'Microsoft.AlertsManagement', registrationState: 'Registered',
      }, 'alerts_management_provider_wrong_subscription'],
      ['absent_registrationState', 200, {
        id: `/subscriptions/${SUB}/providers/Microsoft.AlertsManagement`,
        namespace: 'Microsoft.AlertsManagement',
      }, 'alerts_management_provider_unreadable'],
    ];
    for (const [name, status, body, code] of cases) {
      const h = makeHarness(lib);
      h.setProvider(status, body);
      const r = await lib.plan({ slug: SLUG }, h.deps);
      ok(`plan_provider_fail_${name}`,
        r.ok === false && (r.errors || []).some((e) => e.code === code)
        && (r.errors || []).some((e) => /az provider register/.test(e.message || '')),
      JSON.stringify(r.errors || r).slice(0, 220));
    }
  }
  {
    // Identity attacks: require present exact body.id string; zero RG writes.
    const exactId = `/subscriptions/${SUB}/providers/Microsoft.AlertsManagement`;
    const base = { namespace: 'Microsoft.AlertsManagement', registrationState: 'Registered' };
    const attacks = [
      ['absent_id', { ...base }, 'alerts_management_provider_unreadable'],
      ['null_id', { ...base, id: null }, 'alerts_management_provider_unreadable'],
      ['empty_id', { ...base, id: '' }, 'alerts_management_provider_unreadable'],
      ['non_string_id', { ...base, id: 1 }, 'alerts_management_provider_unreadable'],
      ['query_id', { ...base, id: `${exactId}?api-version=2021-04-01` },
        'alerts_management_provider_unreadable'],
      ['suffix_child_id', { ...base, id: `${exactId}/smartDetectorAlertRules` },
        'alerts_management_provider_unreadable'],
      ['suffix_path_id', { ...base, id: `${exactId}/providers/Microsoft.Insights` },
        'alerts_management_provider_unreadable'],
      ['double_trailing_slash_id', { ...base, id: `${exactId}//` },
        'alerts_management_provider_unreadable'],
      ['wrong_sub_exact', {
        ...base,
        id: '/subscriptions/00000000-0000-0000-0000-000000000099/providers/Microsoft.AlertsManagement',
      }, 'alerts_management_provider_wrong_subscription'],
      ['wrong_namespace_in_id', {
        namespace: 'Microsoft.AlertsManagement',
        registrationState: 'Registered',
        id: `/subscriptions/${SUB}/providers/Microsoft.Insights`,
      }, 'alerts_management_provider_wrong_namespace'],
    ];
    for (const [name, body, code] of attacks) {
      const h = makeHarness(lib);
      h.setProvider(200, body);
      const r = await lib.plan({ slug: SLUG }, h.deps);
      const rgWrites = h.armLog.filter((x) => ['PUT', 'POST', 'DELETE', 'PATCH'].includes(x.method)
        && /resource[Gg]roups/i.test(x.path || ''));
      const providerPosts = h.armLog.filter((x) => x.method === 'POST'
        && /Microsoft\.AlertsManagement/i.test(x.path || ''));
      ok(`plan_provider_id_attack_${name}_zero_rg_writes`,
        r.ok === false
        && (r.errors || []).some((e) => e.code === code
          && /az provider register/.test(e.message || ''))
        && rgWrites.length === 0
        && providerPosts.length === 0,
      JSON.stringify({ errors: r.errors, rgWrites: rgWrites.length }).slice(0, 260));
    }
    // Fixture-shaped exact id (no trailing slash) still GREEN; optional single trailing slash ok.
    for (const [name, id] of [
      ['exact_no_slash', exactId],
      ['exact_one_trailing_slash', `${exactId}/`],
      ['exact_case_insensitive', exactId.toLowerCase().replace('microsoft.alertsmanagement', 'microsoft.ALERTSMANAGEMENT')],
    ]) {
      const h = makeHarness(lib);
      h.setProvider(200, {
        id, namespace: 'Microsoft.AlertsManagement', registrationState: 'Registered',
      });
      const r = await lib.plan({ slug: SLUG }, h.deps);
      ok(`plan_provider_id_accepts_${name}`,
        r.ok === true && r.plan.alertsManagementRegistrationState === 'Registered',
      JSON.stringify(r.errors || { ok: r.ok }).slice(0, 200));
    }
  }
  {
    const h = makeHarness(lib);
    h.setProviderRegistrationState('Registered');
    const r = await lib.plan({ slug: SLUG }, h.deps);
    ok('plan_provider_Registered_succeeds',
      r.ok === true && r.plan.alertsManagementRegistrationState === 'Registered'
      && h.armLog.some((x) => x.method === 'GET'
        && x.path === lib.alertsManagementProviderPath(SUB)),
    JSON.stringify(r.errors || { ok: r.ok }).slice(0, 200));
  }
  {
    // Unit gate: wrong subscription argument refuses before trusting body.
    const h = makeHarness(lib);
    const bad = await lib.assertAlertsManagementProviderRegistered(h.deps, 'not-a-guid');
    ok('provider_gate_invalid_sub',
      bad.ok === false && (bad.errors || []).some((e) => e.code === 'alerts_management_provider_unreadable'));
    // Gate body is GET-only; register string exists only as paste-ready admin guidance helpers.
    const libSrc = fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8');
    const gateFn = (libSrc.match(
      /async function assertAlertsManagementProviderRegistered[\s\S]*?\nasync function getResourceGroup/,
    ) || [''])[0];
    ok('provider_gate_readonly_no_self_register',
      /assertAlertsManagementProviderRegistered/.test(libSrc)
      && /method:\s*'GET'/.test(gateFn)
      && !/method:\s*'POST'/.test(gateFn)
      && !/\/register\?/.test(gateFn)
      && !/az provider register/.test(gateFn)
      && /buildAlertsManagementAdminCommands/.test(libSrc));
  }
  {
    const h = makeHarness(lib); h.setCostFail(true);
    const r = await lib.plan({ slug: SLUG }, h.deps);
    ok('plan_cost_fail_closed', r.ok === false && (r.errors || []).some((e) => /cost/i.test(e.code || ''))
      && !((r.plan || {}).currentCost && r.plan.currentCost.amount === 0));
  }
  {
    const h = makeHarness(lib);
    ok('plan_rejects_reserved', (await lib.plan({ slug: 'sunset' }, h.deps)).ok === false);
  }
  {
    const h = makeHarness(lib);
    h.setRg({ name: RG, tags: ownedTags('x') });
    const r = await lib.plan({ slug: SLUG }, h.deps);
    ok('plan_rejects_existing_rg_no_soft', r.ok === false && (r.errors || []).some((e) => /rg_exists/i.test(e.code || '')));
  }
  {
    const h = makeHarness(lib); h.setBranch('captain/messi-saas-2d1-plan-status');
    const r = await lib.plan({ slug: SLUG }, h.deps);
    ok('plan_requires_master_branch', r.ok === false
      && (r.errors || []).some((e) => e.code === 'branch_not_master'));
  }
  {
    const h = makeHarness(lib, { activeSub: '00000000-0000-0000-0000-000000000099' });
    const r = await lib.plan({ slug: SLUG }, h.deps);
    ok('plan_rejects_sub_mismatch', r.ok === false
      && (r.errors || []).some((e) => e.code === 'subscription_mismatch'));
  }
  {
    const prev = process.env.AZURE_CONFIG_DIR;
    process.env.AZURE_CONFIG_DIR = '/tmp/evil-azure-config-should-not-change-expected-sub';
    const auth = lib.readStagingSubscriptionAuthority(ROOT);
    ok('azure_config_dir_cannot_alter_expected_sub', auth.ok && auth.subscriptionId === SUB);
    if (prev == null) delete process.env.AZURE_CONFIG_DIR; else process.env.AZURE_CONFIG_DIR = prev;
  }
    {
    const h = makeHarness(lib);
    const r = await lib.status({ slug: SLUG }, h.deps);
    const planned = await lib.plan({ slug: SLUG }, h.deps);
    ok('status_absent', r.ok && r.present === false && r.phase === 'absent'
      && r.comparedAgainst === 'arm_readback' && r.ignoresLocalState === true
      && (await lib.status({ slug: SLUG, expectedPlanDigest: 'f'.repeat(64) }, h.deps)).planDigest
      === planned.plan.planDigest);
  }
  {
    const h = makeHarness(lib);
    const planned = await lib.plan({ slug: SLUG }, h.deps);
    const digest = planned.plan.planDigest;
    const tags = ownedTags(digest);
    const c = lib.buildExpectedResourceContract(lib.deriveNames(SLUG, SUB), { principalId: PID });
    ok('contract_exact_counts', c.counts.foundationTopLevel === 10 && c.counts.nestedChildren === 2
      && c.counts.roleAssignments === 2 && c.counts.runtimeSecrets === 14
      && c.runtimeSecretNames.length === 14 && c.runtimeSecretNames[1] === `${SLUG}-database-url`
      && c.roleAssignments[0].name && c.roleAssignments[1].name
      && c.roleAssignments[1].scope.includes('wh-staging-rg')
      && c.ignoreTypes.includes('Microsoft.Resources/deployments'));
    h.setRg({ name: RG, tags, properties: { provisioningState: 'Succeeded' } });
    seedFoundation(h, lib, tags);
    h.setResources([
      ...foundationTop(lib, tags).slice(0, 3),
      { id: 'x', name: 'rogue-storage', type: 'Microsoft.Storage/storageAccounts', tags: {}, provisioningState: 'Succeeded' },
      { id: 'dep', name: 'nested', type: 'Microsoft.Resources/deployments', tags: {}, provisioningState: 'Succeeded' },
    ]);
    const r = await lib.status({ slug: SLUG }, h.deps);
    ok('status_flags_missing_and_unexpected', r.phase === 'foundation'
      && (r.findings || []).some((f) => f.code === 'missing_resource')
      && (r.findings || []).some((f) => f.code === 'unexpected_resource' && f.name === 'rogue-storage')
      && !(r.findings || []).some((f) => f.type === 'Microsoft.Resources/deployments'),
    JSON.stringify(r.findings || r.errors || r).slice(0, 280));
  }
  {
    const h = makeHarness(lib);
    const planned = await lib.plan({ slug: SLUG }, h.deps);
    const tags = ownedTags(planned.plan.planDigest);
    h.setRg({ name: RG, tags, properties: { provisioningState: 'Succeeded' } });
    const c = seedFoundation(h, lib, tags);
    // Live Bicep hardcodes Job stage saas-2c2 (not D1/RG ownership stage).
    h.setJob({
      id: c.bootstrapJob.id, name: c.bootstrapJob.name, type: c.bootstrapJob.type,
      tags: { ...tags, stage: lib.BOOTSTRAP_JOB_STAGE_TAG },
    });
    const r = await lib.status({ slug: SLUG }, h.deps);
    ok('status_phase_bootstrap_active', r.phase === 'bootstrap-active' && r.ok === true,
      JSON.stringify(r.findings || r.errors || r).slice(0, 240));
  }
  {
    const h = makeHarness(lib);
    const planned = await lib.plan({ slug: SLUG }, h.deps);
    const tags = ownedTags(planned.plan.planDigest);
    h.setRg({ name: RG, tags, properties: { provisioningState: 'Succeeded' } });
    seedFoundation(h, lib, tags);
    const r = await lib.status({ slug: SLUG }, h.deps);
    ok('status_phase_foundation_after_job_cleanup', r.phase === 'foundation' && r.ok === true
      && r.live && r.live.jobExists === false && r.live.secretCount === 0,
      JSON.stringify(r.findings || r.errors || r).slice(0, 240));
  }
  {
    const h = makeHarness(lib);
    const planned = await lib.plan({ slug: SLUG }, h.deps);
    const tags = ownedTags(planned.plan.planDigest);
    h.setRg({ name: RG, tags, properties: { provisioningState: 'Succeeded' } });
    const tops = foundationTop(lib, tags);
    h.setPages([
      {
        value: tops.slice(0, 5),
        nextLink: `https://management.azure.com/subscriptions/${SUB}/resourceGroups/${RG}/resources?api-version=2021-04-01&$skiptoken=page2`,
      },
      { value: tops.slice(5) },
    ]);
    seedFoundation(h, lib, tags);
    const r = await lib.status({ slug: SLUG }, h.deps);
    ok('status_follows_nextlink_same_host_sub', r.phase === 'foundation'
      && (r.resources || []).length === tops.length
      && h.armLog.filter((x) => /\/resources/i.test(x.path)).length >= 2,
    JSON.stringify(r.findings || r.errors || { n: (r.resources || []).length }).slice(0, 240));
  }
  {
    const h = makeHarness(lib);
    const planned = await lib.plan({ slug: SLUG }, h.deps);
    const tags = ownedTags(planned.plan.planDigest);
    h.setRg({ name: RG, tags, properties: { provisioningState: 'Succeeded' } });
    h.setPages([{
      value: foundationTop(lib, tags).slice(0, 2),
      nextLink: `https://evil.example/subscriptions/${SUB}/resourceGroups/${RG}/resources?api-version=2021-04-01`,
    }]);
    const r = await lib.status({ slug: SLUG }, h.deps);
    ok('status_rejects_evil_nextlink_host', r.ok === false
      && (r.errors || []).some((e) => /nextlink_host/i.test(e.code || '')));
  }

  {
    const bad = lib.assertSafeTarMembers('ok/file.txt\n/abs/evil\n../x\n', '-rw-r--r-- 0 0 0 file\nlrwxrwxrwx 0 0 0 link -> x\n');
    let archivedSha = null;
    const h = makeHarness(lib, { snapshotAdapter: ({ verifiedDeploySha }) => {
      archivedSha = verifiedDeploySha; return { root: ROOT, cleanup: () => {} };
    } });
    const r = await lib.plan({ slug: SLUG }, h.deps);
    const mismatch = lib.verifyLauncherBytes({
      repoRoot: ROOT, pinnedBins: lib.PINNED_BINS, gitShowBytes: () => Buffer.from('NOT_THE_LAUNCHER'),
    }, SHA, [CLI_REL]);
    const refuse = lib.readCapabilityFd(9999);
    ok('snapshot_authority_locks', bad.ok === false && bad.errors.some((e) => e.code === 'tar_member_path')
      && r.ok && archivedSha === SHA && r.plan.toolAuthority.gitSha256 === '1'.repeat(64)
      && r.plan.toolAuthority.nodePath === '/usr/local/bin/node' && r.plan.stagingSubscriptionConfigSha256
      && mismatch.ok === false && mismatch.errors.some((e) => e.code === 'launcher_bytes_mismatch')
      && refuse.ok === false && refuse.errors.some((e) => /internal_capability/.test(e.code)));
  }
  {
    const h = makeHarness(lib);
    const planned = await lib.plan({ slug: SLUG }, h.deps);
    const tags = ownedTags(planned.plan.planDigest);
    h.setRg({ name: RG, tags, properties: { provisioningState: 'Succeeded' } });
    h.setResources(foundationTop(lib, tags).slice(0, 2));
    h.setNested({});
    h.setRoles({});
    const r = await lib.status({ slug: SLUG }, h.deps);
    const missing = (r.findings || []).filter((f) => f.code === 'missing_resource').map((f) => f.name);
    const expectedKv = lib.deriveNames(SLUG, SUB).keyVaultName;
    ok('status_expected_names_not_stale', r.phase === 'foundation'
      && missing.includes(expectedKv)
      && expectedKv === lib.deriveKeyVaultName(SLUG)
      && !missing.includes(`${PREFIX}-kv`)
      && missing.includes(`${PREFIX}-pg-app`)
      && missing.includes(`${PREFIX}-vnet`)
      && missing.includes('privatelink.postgres.database.azure.com')
      && !missing.includes(`${PREFIX}-logs`)
      && !missing.includes(`${PREFIX}-appinsights`)
      && r.expectedNames && r.expectedNames.staffApiAppName === `${PREFIX}-staff-api`
      && r.expectedNames.keyVaultName === expectedKv);
  }
  {
    const h = makeHarness(lib);
    const planned = await lib.plan({ slug: SLUG }, h.deps);
    const tags = ownedTags(planned.plan.planDigest);
    h.setRg({ name: RG, tags, properties: { provisioningState: 'Succeeded' } });
    const c = seedFoundation(h, lib, tags);
    h.setSecrets(c.runtimeSecrets.map((s) => ({ id: s.id, name: s.name, tags })));
    const r = await lib.status({ slug: SLUG }, h.deps);
    ok('status_phase_runtime_prereqs', r.phase === 'runtime-prereqs' && r.ok === true
      && r.live.secretsExact === 14 && r.live.appExists === false,
      JSON.stringify(r.findings || r.errors || r).slice(0, 240));
  }
  {
    const h = makeHarness(lib);
    const planned = await lib.plan({ slug: SLUG }, h.deps);
    const tags = ownedTags(planned.plan.planDigest);
    h.setRg({ name: RG, tags, properties: { provisioningState: 'Succeeded' } });
    const c = seedFoundation(h, lib, tags);
    h.setSecrets(c.runtimeSecrets.slice(0, 3).map((s) => ({ id: s.id, name: s.name, tags })));
    const r = await lib.status({ slug: SLUG }, h.deps);
    ok('status_partial_secrets_unhealthy', r.phase === 'foundation' && r.ok === false
      && (r.findings || []).some((f) => f.code === 'unexpected_resource'
        && f.type === 'Microsoft.KeyVault/vaults/secrets'),
      JSON.stringify(r.findings || r.errors || r).slice(0, 240));
  }
  // Empty owned RG (apply failed before foundation): absent Key Vault must not LIST secrets.
  // Real ARM 404 on child secrets under a missing vault used to become arm_list_failed and
  // hide the diagnosable empty/partial inventory. Skip only when expected vault is absent;
  // keep 403/5xx/malformed/nextLink and present-vault 404 closed.
  // Exact empty also requires independent zero Microsoft.Resources/deployments LIST.
  {
    const h = makeHarness(lib);
    const planned = await lib.plan({ slug: SLUG }, h.deps);
    const tags = ownedTags(planned.plan.planDigest);
    const names = lib.deriveNames(SLUG, SUB);
    h.setRg({ name: RG, tags, properties: { provisioningState: 'Succeeded' } });
    h.setResources([]);
    h.setDeployments([]);
    h.setNested({});
    h.setRoles({});
    h.setSecrets([]);
    h.setMi(null);
    const realArm = h.deps.armRequest;
    let secretListAttempts = 0;
    let secretExactAttempts = 0;
    h.deps.armRequest = async (req) => {
      const p = req.path || '';
      if (/KeyVault\/vaults\/[^/]+\/secrets(\?|$)/i.test(p) && !/\/secrets\/[^/?]+(\?|$)/i.test(p)) {
        secretListAttempts += 1;
        return { status: 404, body: { error: { code: 'ResourceNotFound' } } };
      }
      if (/\/secrets\/[^/?]+(\?|$)/i.test(p)) secretExactAttempts += 1;
      return realArm(req);
    };
    const live = await lib.collectLiveInventory(h.deps, names, tags);
    const depListCalls = h.armLog.filter((x) => /\/providers\/Microsoft\.Resources\/deployments(\?|$)/i.test(x.path || ''));
    ok('inventory_empty_rg_absent_kv_skips_secrets_list', live.ok === true
      && secretListAttempts === 0
      && secretExactAttempts === 0
      && Array.isArray(live.secretMeta) && live.secretMeta.length === 0
      && live.secretCount === 0 && live.secretsExact === 0
      && Array.isArray(live.deployments) && live.deploymentCount === 0
      && depListCalls.length >= 1
      && depListCalls.every((c) => (c.path || '').includes(`api-version=${lib.DEP_API}`))
      && (live.findings || []).some((f) => f.code === 'missing_resource'
        && f.type === 'Microsoft.KeyVault/vaults' && f.name === names.keyVaultName)
      && !(live.errors || []).some((e) => e.code === 'arm_list_failed'),
    JSON.stringify({
      ok: live.ok, errors: live.errors, secretListAttempts, secretExactAttempts,
      deploymentCount: live.deploymentCount, depListCalls: depListCalls.length,
      findings: (live.findings || []).slice(0, 4),
    }).slice(0, 320));
    live.rgExists = true;
    ok('inventory_empty_rg_infers_empty_phase', lib.inferLivePhase(live) === 'empty'
      && lib.isExactEmptyLiveInventory(live) === true
      && lib.phaseContractFindings(live, 'empty').length === 0,
    JSON.stringify({
      phase: lib.inferLivePhase(live),
      contractFindings: lib.phaseContractFindings(live, 'empty').slice(0, 4),
    }).slice(0, 240));

    // One failed deployment via authoritative LIST (not generic /resources) refuses empty.
    const hFailedDep = makeHarness(lib);
    hFailedDep.setRg({ name: RG, tags, properties: { provisioningState: 'Succeeded' } });
    hFailedDep.setResources([]);
    hFailedDep.setDeployments([{
      id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Resources/deployments/leftover-failed`,
      name: 'leftover-failed', type: 'Microsoft.Resources/deployments',
      properties: { provisioningState: 'Failed' },
    }]);
    const failedDepLive = await lib.collectLiveInventory(hFailedDep.deps, names, tags);
    failedDepLive.rgExists = true;
    ok('inventory_one_failed_deployment_not_empty', failedDepLive.ok === true
      && failedDepLive.deploymentCount === 1
      && lib.isExactEmptyLiveInventory(failedDepLive) === false
      && lib.inferLivePhase(failedDepLive) !== 'empty'
      && lib.phaseContractFindings(failedDepLive, 'empty').some((f) => f.code === 'unexpected_resource'),
    JSON.stringify({
      phase: lib.inferLivePhase(failedDepLive),
      deploymentCount: failedDepLive.deploymentCount,
      deployments: failedDepLive.deployments,
    }).slice(0, 280));

    // One succeeded deployment via LIST also refuses empty (history is nonzero).
    const hOkDep = makeHarness(lib);
    hOkDep.setRg({ name: RG, tags, properties: { provisioningState: 'Succeeded' } });
    hOkDep.setResources([]);
    hOkDep.setDeployments([{
      id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Resources/deployments/leftover-ok`,
      name: 'leftover-ok', type: 'Microsoft.Resources/deployments',
      properties: { provisioningState: 'Succeeded' },
    }]);
    const okDepLive = await lib.collectLiveInventory(hOkDep.deps, names, tags);
    okDepLive.rgExists = true;
    ok('inventory_one_succeeded_deployment_not_empty', okDepLive.ok === true
      && okDepLive.deploymentCount === 1
      && lib.isExactEmptyLiveInventory(okDepLive) === false
      && lib.inferLivePhase(okDepLive) !== 'empty',
    JSON.stringify({ phase: lib.inferLivePhase(okDepLive), deployments: okDepLive.deployments }).slice(0, 240));

    // Deployment LIST 403/404/5xx/malformed/nextLink fail closed (no empty phase).
    for (const [label, status] of [['403', 403], ['404', 404], ['500', 500]]) {
      const hx = makeHarness(lib);
      hx.setRg({ name: RG, tags, properties: { provisioningState: 'Succeeded' } });
      hx.setResources([]);
      hx.setDeploymentListStatus(status);
      const bad = await lib.collectLiveInventory(hx.deps, names, tags);
      ok(`inventory_deployment_list_${label}_fails_closed`, bad.ok === false
        && (bad.errors || []).some((e) => e.code === 'arm_list_failed')
        && lib.isExactEmptyLiveInventory(bad) === false,
      JSON.stringify(bad.errors || bad).slice(0, 200));
    }
    const hMalformed = makeHarness(lib);
    hMalformed.setRg({ name: RG, tags, properties: { provisioningState: 'Succeeded' } });
    hMalformed.setResources([]);
    hMalformed.setDeploymentPages([{ value: { not: 'array' } }]);
    const malformed = await lib.collectLiveInventory(hMalformed.deps, names, tags);
    ok('inventory_deployment_list_malformed_fails_closed', malformed.ok === false
      && (malformed.errors || []).some((e) => e.code === 'arm_list_malformed')
      && lib.isExactEmptyLiveInventory(malformed) === false,
    JSON.stringify(malformed.errors || malformed).slice(0, 200));
    const hNext = makeHarness(lib);
    hNext.setRg({ name: RG, tags, properties: { provisioningState: 'Succeeded' } });
    hNext.setResources([]);
    hNext.setDeploymentPages([{
      value: [],
      nextLink: `https://evil.example/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Resources/deployments?api-version=${lib.DEP_API}`,
    }]);
    const badNext = await lib.collectLiveInventory(hNext.deps, names, tags);
    ok('inventory_deployment_list_nextlink_fails_closed', badNext.ok === false
      && (badNext.errors || []).some((e) => e.code === 'nextlink_host' || e.code === 'nextlink_invalid'
        || e.code === 'nextlink_subscription'),
    JSON.stringify(badNext.errors || badNext).slice(0, 200));

    // Present vault: secrets LIST 404 must still fail closed (not global 404→success).
    const hPresent = makeHarness(lib);
    hPresent.setRg({ name: RG, tags, properties: { provisioningState: 'Succeeded' } });
    seedFoundation(hPresent, lib, tags);
    const realPresent = hPresent.deps.armRequest;
    hPresent.deps.armRequest = async (req) => {
      const p = req.path || '';
      if (/KeyVault\/vaults\/[^/]+\/secrets(\?|$)/i.test(p) && !/\/secrets\/[^/?]+(\?|$)/i.test(p)) {
        return { status: 404, body: { error: { code: 'ResourceNotFound' } } };
      }
      return realPresent(req);
    };
    const present404 = await lib.collectLiveInventory(hPresent.deps, names, tags);
    ok('inventory_present_kv_secrets_list_404_still_fails', present404.ok === false
      && (present404.errors || []).some((e) => e.code === 'arm_list_failed'),
    JSON.stringify(present404.errors || present404).slice(0, 240));

    const h403 = makeHarness(lib);
    h403.setRg({ name: RG, tags, properties: { provisioningState: 'Succeeded' } });
    seedFoundation(h403, lib, tags);
    const real403 = h403.deps.armRequest;
    h403.deps.armRequest = async (req) => {
      const p = req.path || '';
      if (/KeyVault\/vaults\/[^/]+\/secrets(\?|$)/i.test(p) && !/\/secrets\/[^/?]+(\?|$)/i.test(p)) {
        return { status: 403, body: { error: { code: 'AuthorizationFailed' } } };
      }
      return real403(req);
    };
    const forbidden = await lib.collectLiveInventory(h403.deps, names, tags);
    ok('inventory_present_kv_secrets_list_403_still_fails', forbidden.ok === false
      && (forbidden.errors || []).some((e) => e.code === 'arm_list_failed'),
    JSON.stringify(forbidden.errors || forbidden).slice(0, 240));

    // Non-empty / unexpected inventory must not classify as empty.
    const hRogue = makeHarness(lib);
    hRogue.setRg({ name: RG, tags, properties: { provisioningState: 'Succeeded' } });
    hRogue.setResources([{
      id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/rogue`,
      name: 'rogue', type: 'Microsoft.Storage/storageAccounts', tags: {}, provisioningState: 'Succeeded',
    }]);
    const rogueLive = await lib.collectLiveInventory(hRogue.deps, names, tags);
    rogueLive.rgExists = true;
    ok('inventory_nonzero_not_empty_phase', rogueLive.ok === true
      && lib.inferLivePhase(rogueLive) !== 'empty'
      && (rogueLive.findings || []).some((f) => f.code === 'unexpected_resource'),
    JSON.stringify({ phase: lib.inferLivePhase(rogueLive), findings: rogueLive.findings }).slice(0, 240));

    // Missing deployments array on hand-built inventory fails closed (not empty).
    ok('inventory_missing_deployments_field_not_exact_empty',
      lib.isExactEmptyLiveInventory({
        resources: [], topLevel: [], nestedLive: [], rolesLive: [], secretMeta: [],
        secretsExact: 0, secretCount: 0, jobExists: false, appExists: false,
      }) === false);
  }
  {
    const h = makeHarness(lib);
    const planned = await lib.plan({ slug: SLUG }, h.deps);
    const tags = ownedTags(planned.plan.planDigest);
    h.setRg({ name: RG, tags, properties: { provisioningState: 'Succeeded' } });
    const c = seedFoundation(h, lib, tags);
    h.setSecrets(c.runtimeSecrets.map((s) => ({ id: s.id, name: s.name, tags })));
    h.setApp({
      id: c.runtimeApp.id, tags,
      properties: {
        provisioningState: 'Succeeded', latestRevisionName: `${PREFIX}-staff-api--rev1`,
        configuration: { ingress: { fqdn: `${SLUG}.example.azurecontainerapps.io` } },
        template: {
          containers: [{
            name: `${PREFIX}-staff-api`,
            image: 'whstagingacr.azurecr.io/luna-sunset-staff-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            env: [
              { name: 'DEFAULT_CLIENT_SLUG', value: SLUG },
              { name: 'STAFF_API_INGRESS_TENANT_SLUG', value: SLUG },
              { name: 'STAFF_ACTIONS_ENABLED', value: 'false' },
              { name: 'STRIPE_LINKS_ENABLED', value: 'false' },
              { name: 'WHATSAPP_DRY_RUN', value: 'true' },
            ],
          }],
          scale: { minReplicas: 1, maxReplicas: 1 },
        },
      },
    });
    const r = await lib.status({ slug: SLUG }, h.deps);
    const ids = [...c.roleAssignments.map((x) => x.id), ...c.runtimeSecrets.map((x) => x.id)];
    const got = (id) => h.armLog.some((x) => x.method === 'GET' && (x.path || '').includes(id));
    const targeted = h.armLog.filter((x) => /databases\/|virtualNetworkLinks\/|roleAssignments|\/secrets\?|\/jobs\/|userAssignedIdentities\//i.test(x.path));
    const libSrc = fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8');
    ok('status_revision_ready_and_identity_exact', r.ok && r.phase === 'runtime' && r.app
      && r.app.revisionRunning === 'Running' && r.app.revisionHealth === 'Healthy'
      && r.app.readyTerminal === true && r.app.healthIdentityOk === true
      && r.app.healthIdentityBody && r.app.healthIdentityBody.default_client_slug === SLUG
      && Object.keys(r.app.healthIdentityBody).sort().join(',') === 'default_client_slug,service,status'
      && targeted.length >= 5,
      JSON.stringify({ app: r.app, findings: r.findings, targeted: targeted.length }).slice(0, 280));
    ok('status_exact_16_contract_ids', ids.length === 16 && ids.every(got)
      && c.roleAssignments.every((role) => h.armLog.some((x) => new RegExp(`roleAssignments/${role.name}(\\?|$)`, 'i').test(x.path || '')))
      && c.runtimeSecrets.every((s) => h.armLog.some((x) => (x.path || '').includes(`/secrets/${s.name}`)))
      && /\$\{expected\.id\}\?api-version=\$\{ROLE_API\}/.test(libSrc)
      && /\$\{exp\.id\}\?api-version=\$\{KV_API\}/.test(libSrc),
    `exact=${ids.filter(got).length}`);
    const realArm = h.deps.armRequest;
    h.deps.armRequest = async (req) => (/roleAssignments\/[0-9a-f-]{36}|\/secrets\/[^/?]+(\?|$)/i.test(req.path || '')
      ? { status: 404, body: {} } : realArm(req));
    h.armLog.length = 0;
    const listOnly = await lib.status({ slug: SLUG }, h.deps);
    ok('status_list_only_exact_gets_fail', listOnly.ok === false && listOnly.phase === 'foundation'
      && (listOnly.live || {}).secretsExact === 0 && ((listOnly.live || {}).roles || 0) === 0
      && (listOnly.findings || []).some((f) => f.code === 'missing_role_assignment'),
    JSON.stringify({ phase: listOnly.phase, live: listOnly.live }).slice(0, 200));
  }
  {
    const names = lib.deriveNames(SLUG, SUB);
    const contract = lib.buildExpectedResourceContract(names, { principalId: PID });
    if (!BICEP) ok('compile_c1_c2_c3_phase_fixtures', false, 'no bicep');
    else {
      try {
        const blob = (rel) => JSON.stringify(compileBicep(path.join(ROOT, rel)));
        const mainB = blob(MOD_REL);
        const secB = blob('infra/azure/modules/tenant-staging/synthetic-runtime-secrets.bicep');
        const netB = blob('infra/azure/modules/tenant-staging/private-network.bicep');
        const jobB = blob('infra/azure/modules/tenant-staging/synthetic-bootstrap-job.bicep');
        const c1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'infra/azure/modules/tenant-staging/parameters.synthetic.json'), 'utf8'));
        const c3 = JSON.parse(fs.readFileSync(path.join(ROOT, 'infra/azure/modules/tenant-staging/parameters.synthetic-runtime.json'), 'utf8'));
        const expectedSynthKv = lib.deriveKeyVaultName(SLUG);
        const expectedSynthJob = lib.deriveBootstrapJobName(SLUG);
        const compiledMain = compileBicep(path.join(ROOT, MOD_REL));
        const mainParams = compiledMain.parameters || {};
        const messiJob = lib.deriveBootstrapJobName('messiproof');
        const messiCanon = lib.canonicalBootstrapJobName('messiproof');
        ok('compile_c1_c2_c3_phase_fixtures',
          /natGateways/.test(netB) && /Microsoft.App\/jobs/.test(jobB)
          && /vaults\/secrets/.test(secB) && /containerApps/.test(mainB)
          && c1.parameters.deployStaffApi.value === false
          && c3.parameters.runtimeDeploymentPhase.value === 'runtime-app'
          && c1.parameters.keyVaultName && c1.parameters.keyVaultName.value === expectedSynthKv
          && c3.parameters.keyVaultName && c3.parameters.keyVaultName.value === expectedSynthKv
          && lib.isValidAzureKeyVaultName(expectedSynthKv)
          && c1.parameters.bootstrapJobName
          && c1.parameters.bootstrapJobName.value === expectedSynthJob
          && c3.parameters.bootstrapJobName
          && c3.parameters.bootstrapJobName.value === expectedSynthJob
          && lib.isValidAzureContainerAppsJobName(expectedSynthJob)
          && expectedSynthJob === lib.canonicalBootstrapJobName(SLUG)
          && contract.runtimeSecretNames.every((n) => secB.includes(n) || n === `${SLUG}-database-url`)
          && /bootstrap/.test(jobB)
          && names.keyVaultName === expectedSynthKv
          && names.bootstrapJobName === expectedSynthJob
          && contract.bootstrapJob.name === expectedSynthJob
          // Compiled Bicep parity: bootstrapJobName is a constrained param (not prefix concat).
          && mainParams.bootstrapJobName
          && Number(mainParams.bootstrapJobName.maxLength) === 32
          && Number(mainParams.bootstrapJobName.minLength) === 2
          && !mainB.includes("concat(parameters('appNamePrefix'), '-bootstrap')")
          && messiJob.length <= 32 && messiJob !== messiCanon
          && messiJob === 'luna-messiproof-63aa6df2',
          `synthJob=${expectedSynthJob} messiJob=${messiJob}`);
      } catch (e) {
        ok('compile_c1_c2_c3_phase_fixtures', false, String(e.stderr || e.message || e).slice(0, 240));
      }
    }
  }
  {
    const cli = fs.readFileSync(path.join(ROOT, CLI_REL), 'utf8');
    const libSrc = fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8');
    ok('cli_parent_and_surface', /runProductionParent/.test(cli) && /INTERNAL_FLAG/.test(cli)
      && libSrc.includes('/usr/local/bin/node') && libSrc.includes('internal-snapshot-worker')
      && /spawn\(pins\.node/.test(libSrc) && /plan|status/.test(cli)
      && !/\bapply\b|\brollback\b/.test(cli) && /expected_plan_digest_removed|expectedPlanDigest/.test(cli));
  }
  {
    const MIR = 'mirleft';
    const need = ['inventory_not_ready', 'prices_not_ready', 'channels_not_ready', 'human_staging_approval_not_ready'];
    const h = makeHarness(lib);
    const st = await lib.status({ slug: MIR, lifecycleMode: lib.LIFECYCLE_DURABLE }, h.deps);
    const codes = (st.blockers || []).map((b) => b.code);
    ok('durable_mirleft_exact_blockers', st.ok === false && st.readiness === false
      && st.lifecycleMode === 'durable-staging'
      && need.every((c) => codes.includes(c))
      && codes.length === need.length
      && !codes.includes('live_enabled_not_ready')
      && st.applyPath == null && st.mutationPath == null
      && st.rollbackPolicy && st.rollbackPolicy.onSuccess === 'preserve_rg'
      && st.rollbackPolicy.destroyAfterSuccess === false
      && (st.humanAdminPrerequisites || []).length >= 3 && st.estimatedMonthlyUsd > 0
      && st.rgTagContract && st.rgTagContract.lifecycleMode === 'durable-staging'
      && st.rgTagContract.durableStaging === 'true' && /^[a-f0-9]{64}$/.test(st.planDigest),
    JSON.stringify({ codes, err: st.errors }).slice(0, 200));
    const basePath = path.join(ROOT, 'config/clients/mirleft.baseline.json');
    const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
    const sr = base.staging_readiness || {};
    ok('durable_mirleft_committed_staging_readiness_false',
      sr.inventory_confirmed === false && sr.prices_confirmed === false
      && sr.channels_provisioned === false && sr.human_staging_approval === false);
    const ov = await lib.status({
      slug: MIR, lifecycleMode: 'durable-staging', ready: true, readiness: true,
      live_enabled: true, inventory_confirmed: true, prices_confirmed: true,
      channels_provisioned: true, human_staging_approval: true,
      blockers: [], clientReadiness: { ready: true, blockers: [] },
      staging_readiness: {
        inventory_confirmed: true, prices_confirmed: true,
        channels_provisioned: true, human_staging_approval: true,
      },
    }, h.deps);
    ok('durable_caller_cannot_override_readiness', ov.ok === false && ov.readiness === false
      && need.every((c) => (ov.blockers || []).some((b) => b.code === c))
      && !(ov.blockers || []).some((b) => b.code === 'live_enabled_not_ready'));
    const nArm = h.armLog.length;
    const p1 = await lib.plan({ slug: MIR, lifecycleMode: 'durable-staging' }, h.deps);
    const p2 = await lib.plan({ slug: MIR, lifecycleMode: 'durable-staging' }, h.deps);
    ok('durable_no_azure_dispatches', h.armLog.length === nArm && p1.azureDispatches === 0
      && p1.applyPath == null && p1.mutationPath == null);
    ok('durable_deterministic_digest', p1.ok && p2.ok && p1.planDigest === p2.planDigest
      && p1.plan.planDigest === p1.planDigest && /^[a-f0-9]{64}$/.test(p1.planDigest));
    const temp = await lib.plan({ slug: SLUG }, h.deps);
    const dur = await lib.plan({ slug: SLUG, lifecycleMode: 'durable-staging' }, h.deps);
    const blob = JSON.stringify(st) + JSON.stringify(p1);
    const libSrc = fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8');
    ok('durable_cross_mode_digest_separation', temp.ok && dur.ok
      && temp.plan.planDigest !== dur.planDigest && dur.plan.lifecycleMode === 'durable-staging'
      && temp.plan.lifecycleMode == null && !/postgres(ql)?:\/\//i.test(blob)
      && !/sk_live|sk_test|accessToken|client_secret/i.test(blob) && !/"apply"\s*:/.test(blob)
      && typeof lib.apply !== 'function'
      && !/\basync function apply\b/.test(libSrc)
      && /staging_readiness/.test(libSrc)
      && !/live_enabled_not_ready/.test(libSrc)
      && !/\/TODO\|provisional\//.test(libSrc)
      && !/pricing_status ===/.test(libSrc));
  }
  const st = diffStat();
  ok('file_budget', st.files <= 10, `files=${st.files}`);
  // Raised for infra-partial owned-deployment subset + empty-RG deployments LIST authority
  // + Azure Key Vault 24-char name owner (messiproof InvalidTemplate class).
  // Raised for Microsoft.AlertsManagement Registered preflight (Failure-Anomalies defect).
  // Raised for platform-supplemental Failure Anomalies smart-detector contract.
  // Raised for Container Apps Job 32-char name owner (messiproof ContainerAppInvalidName).
  ok('net_budget', st.net <= 4100, `net=${st.net} raw=+${st.rawAdd}/-${st.rawDel}`);
  console.log(`\nRESULT: ${fail ? 'FAIL' : 'PASS'}  pass=${pass} fail=${fail}  net=+${st.net}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
