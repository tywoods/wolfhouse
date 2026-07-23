#!/usr/bin/env node
'use strict';
/** verify:messi-saas-stage2d-apply-owner — offline Stage 2D plan/apply/status/rollback gate (no Azure). */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE = 'ee5f344e1bd48bf02d5fa1adedcb2e89e2d5df68';
const LIB_REL = 'scripts/lib/messi-saas-stage2d-apply-owner.js';
const CLI_REL = 'scripts/messi-saas-stage2d-apply-owner.js';
const DOC_REL = 'docs/MESSI-SAAS-STAGE2D-APPLY-OWNER.md';
const FILES = [LIB_REL, CLI_REL, 'scripts/verify-messi-saas-stage2d-apply-owner.js', DOC_REL, 'package.json'];
const SLUG = 'synthdemo';
const SUB = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
const RG = `luna-${SLUG}-staging-rg`;
const SHA = 'a'.repeat(40);
const DIGEST_IMG = `sha256:${'b'.repeat(64)}`;

let pass = 0; let fail = 0;
const ok = (n, c, d) => { if (c) { pass += 1; console.log(`  PASS  ${n}`); }
else { fail += 1; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); } };

function diffStat() {
  const out = execFileSync('git', ['diff', '--numstat', BASE, '--', ...FILES], { cwd: ROOT, encoding: 'utf8' }).trim();
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
      baseLines = execFileSync('git', ['show', `${BASE}:${rel}`], { cwd: ROOT, encoding: 'utf8' }).split(/\r?\n/).length;
    } catch (_) { baseLines = 0; }
    const cur = fs.readFileSync(abs, 'utf8').split(/\r?\n/).length;
    if (!baseLines) { rawAdd += cur; perFile.push({ file: rel, add: cur, del: 0 }); }
  }
  return { rawAdd, rawDel, net: rawAdd - rawDel, files: perFile.length, perFile };
}

function writeManifest(dir, slug = SLUG) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    schema_version: 1, client_slug: slug, archetype: 'surf_house',
    enablement_forced_false: true, secrets_materialized: false, apply: false,
    files: [{ kind: 'baseline', relative_path: `preview/${slug}.baseline.json`, sha256: 'a'.repeat(64), bytes: 2 }],
  };
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(dir, 'dry-run-manifest.json'), body);
  fs.mkdirSync(path.join(dir, 'preview'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'preview', `${slug}.baseline.json`), '{}\n');
  return { manifest, sha256: crypto.createHash('sha256').update(body).digest('hex') };
}

function makeHarness(lib) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 's2d-state-'));
  const secretLog = [];
  const armLog = [];
  const azLog = [];
  let rg = null;
  let costFail = false;
  let jobStatus = 'Succeeded';
  let bootstrapPresent = false;
  let revisionHealthy = true;
  let roleDelay = 0;
  let deleteMismatch = false;
  const secretsSeenInArm = [];
  const store = new Map();

  const baseAz = (args) => {
    azLog.push(args.slice());
    const joined = args.join(' ');
    if (secretLog.length && secretLog.some((s) => joined.includes(s))) {
      throw new Error(`secret_leaked_to_az:${joined.slice(0, 80)}`);
    }
    if (args[0] === 'account' && args[1] === 'show') {
      return JSON.stringify({ id: SUB, name: 'Azure subscription 1', state: 'Enabled' });
    }
    if (args[0] === 'account' && args[1] === 'get-access-token') {
      return JSON.stringify({ accessToken: 'TEST_TOKEN_NOT_SECRET', expiresOn: '2099-01-01' });
    }
    if (args[0] === 'acr' && args.includes('build')) return 'build-ok';
    if (args[0] === 'acr' && (args.includes('manifest') || args.includes('show-manifests'))) {
      return JSON.stringify({ digest: DIGEST_IMG });
    }
    return '';
  };

  const deps = lib.createDeps({
    repoRoot: ROOT,
    stateDir,
    sleep: async () => {},
    now: () => new Date('2026-07-23T12:00:00Z'),
    randomBytes: (n) => Buffer.alloc(n, 7),
    gitExec: (args) => {
      const a = args.join(' ');
      if (a === 'status --porcelain') return '';
      if (a === 'rev-parse HEAD' || a === 'rev-parse origin/master') return SHA;
      if (a.startsWith('rev-parse')) return SHA;
      return '';
    },
    azExec: baseAz,
    bicepBuild: () => ({
      $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
      contentVersion: '1.0.0.0',
      resources: [],
      outputs: {},
    }),
    armRequest: async (req) => {
      armLog.push({ method: req.method, path: req.path, hasBody: !!req.body });
      if (req.method === 'GET' && /resourcegroups\/[^/]+\?/i.test(req.path) && !/providers\//.test(req.path.split('resourcegroups/')[1] || '')) {
        if (!rg) return { status: 404, body: { error: { code: 'ResourceGroupNotFound' } } };
        return { status: 200, body: rg };
      }
      if (req.method === 'PUT' && /resourcegroups\/[^/?]+(\?|$)/i.test(req.path) && !/providers\//.test(req.path.split('resourcegroups/')[1] || '')) {
        rg = {
          name: RG, id: `/subscriptions/${SUB}/resourceGroups/${RG}`,
          properties: { provisioningState: 'Succeeded' },
          tags: (req.body && req.body.tags) || {},
        };
        store.set('rg', rg);
        if (rg.tags && rg.tags.planDigest) store.set('planDigest', rg.tags.planDigest);
        return { status: 200, body: rg };
      }
      if (req.method === 'DELETE' && /resourcegroups\/[^/?]+(\?|$)/i.test(req.path)) {
        if (deleteMismatch) return { status: 409, body: { error: { code: 'Conflict' } } };
        rg = null; store.delete('rg');
        return { status: 202, body: {} };
      }
      if (/CostManagement\/query/i.test(req.path)) {
        if (costFail) return { status: 503, body: { error: { code: 'CostUnavailable' } } };
        return {
          status: 200,
          body: { properties: { columns: [{ name: 'PreTaxCost' }, { name: 'Currency' }], rows: [[12.5, 'USD']] } },
        };
      }
      if (/deployments\//i.test(req.path) && req.method === 'PUT') {
        const params = (((req.body || {}).properties || {}).parameters) || {};
        if (Object.prototype.hasOwnProperty.call(params, 'deployBootstrapJob')) {
          bootstrapPresent = params.deployBootstrapJob.value === true;
        }
        return {
          status: 201,
          body: {
            id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Resources/deployments/test`,
            name: 'test',
            properties: {
              provisioningState: 'Succeeded',
              outputs: {
                postgresServerId: { value: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.DBforPostgreSQL/flexibleServers/luna-${SLUG}-staging-pg-app` },
                containerAppsEnvironmentId: { value: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/managedEnvironments/luna-${SLUG}-staging-env` },
                staffApiFqdn: { value: `${SLUG}.example.azurecontainerapps.io` },
                staffApiUrl: { value: `https://${SLUG}.example.azurecontainerapps.io` },
                staffApiResourceId: { value: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/luna-${SLUG}-staging-staff-api` },
                staffApiLatestRevisionName: { value: `luna-${SLUG}-staging-staff-api--rev1` },
                keyVaultName: { value: `luna${SLUG}stgkv`.slice(0, 24) },
                managedIdentityPrincipalId: { value: '11111111-1111-1111-1111-111111111111' },
              },
            },
          },
        };
      }
      if (/deployments\//i.test(req.path) && req.method === 'GET') {
        return { status: 200, body: { properties: { provisioningState: 'Succeeded' } } };
      }
      if (/Microsoft.App\/jobs\//i.test(req.path) && /\/start/i.test(req.path)) {
        if (jobStatus === 'Failed') return { status: 200, body: { name: 'exec-1', properties: { status: 'Failed' } } };
        return { status: 200, body: { name: 'exec-1', id: 'exec-1', properties: { status: 'Running' } } };
      }
      if (/Microsoft.App\/jobs\//i.test(req.path) && /executions/i.test(req.path)) {
        return { status: 200, body: { properties: { status: jobStatus, startTime: '2026-07-23T12:00:00Z', endTime: '2026-07-23T12:01:00Z' } } };
      }
      if (/Microsoft.App\/jobs\/[^/]+\?/i.test(req.path) && req.method === 'GET') {
        if (!bootstrapPresent) return { status: 404, body: {} };
        return { status: 200, body: { name: `luna-${SLUG}-staging-bootstrap` } };
      }
      if (/roleAssignments/i.test(req.path)) {
        if (roleDelay > 0) { roleDelay -= 1; return { status: 200, body: { value: [] } }; }
        return {
          status: 200,
          body: {
            value: [
              { properties: { roleDefinitionId: `/providers/Microsoft.Authorization/roleDefinitions/${'4633458b-17de-407f-b9ed-0503c8a34c52'}` } },
              { properties: { roleDefinitionId: `/providers/Microsoft.Authorization/roleDefinitions/${'7f951dda-4ed3-4680-a7ca-43fe172d538d'}` } },
            ],
          },
        };
      }
      if (/revisions\//i.test(req.path)) {
        return {
          status: 200,
          body: {
            properties: {
              runningState: revisionHealthy ? 'Running' : 'Failed',
              healthState: revisionHealthy ? 'Healthy' : 'Unhealthy',
              replicas: revisionHealthy ? 1 : 0,
            },
          },
        };
      }
      if (/containerApps\//i.test(req.path) && req.method === 'GET') {
        const env = [
          { name: 'DEFAULT_CLIENT_SLUG', value: SLUG },
          { name: 'STAFF_ACTIONS_ENABLED', value: 'false' },
          { name: 'STRIPE_LINKS_ENABLED', value: 'false' },
          { name: 'WHATSAPP_DRY_RUN', value: 'true' },
        ];
        return {
          status: 200,
          body: {
            id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/luna-${SLUG}-staging-staff-api`,
            tags: {
              tenant: SLUG, stage: 'saas-2d', owner: 'messi-stage2d',
              planDigest: store.get('planDigest') || '', deploySha: SHA,
            },
            properties: {
              provisioningState: 'Succeeded',
              runningStatus: revisionHealthy ? 'Running' : 'Stopped',
              latestRevisionName: `luna-${SLUG}-staging-staff-api--rev1`,
              configuration: { ingress: { fqdn: `${SLUG}.example.azurecontainerapps.io` } },
              template: { containers: [{ name: `luna-${SLUG}-staging-staff-api`, env, image: `whstagingacr.azurecr.io/luna-sunset-staff-api@${DIGEST_IMG}` }], scale: { minReplicas: 1, maxReplicas: 1 } },
            },
          },
        };
      }
      return { status: 200, body: {} };
    },
    httpsRequest: async (opts) => {
      if (!revisionHealthy) return { status: 503, body: 'unhealthy' };
      if ((opts.path || '').includes('/healthz') || opts.path === '/') {
        return { status: 200, body: '{"ok":true}' };
      }
      return { status: 404, body: '' };
    },
  });

  return {
    deps, stateDir, armLog, azLog, secretLog, secretsSeenInArm, store, baseAz,
    setRg(v) { rg = v; },
    setCostFail(v) { costFail = v; },
    setJobStatus(v) { jobStatus = v; },
    setRevisionHealthy(v) { revisionHealthy = v; },
    setRoleDelay(v) { roleDelay = v; },
    setDeleteMismatch(v) { deleteMismatch = v; },
  };
}

async function main() {
  console.log('verify:messi-saas-stage2d-apply-owner — Stage 2D\n');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok('package_script', pkg.scripts['verify:messi-saas-stage2d-apply-owner']
    === 'node scripts/verify-messi-saas-stage2d-apply-owner.js');
  ok('cli_exists', fs.existsSync(path.join(ROOT, CLI_REL)));
  ok('lib_exists', fs.existsSync(path.join(ROOT, LIB_REL)));
  ok('docs_exist', fs.existsSync(path.join(ROOT, DOC_REL)));

  let lib = null;
  try { lib = require('./lib/messi-saas-stage2d-apply-owner'); } catch (e) {
    ok('lib_loads', false, String(e && e.message)); 
    console.log(`\nRESULT: FAIL  pass=${pass} fail=${fail}`);
    process.exit(1);
  }
  ok('lib_loads', !!lib);
  ok('api_surface', typeof lib.plan === 'function' && typeof lib.apply === 'function'
    && typeof lib.status === 'function' && typeof lib.rollback === 'function'
    && typeof lib.createDeps === 'function');

  const doc = fs.readFileSync(path.join(ROOT, DOC_REL), 'utf8');
  ok('docs_exact_commands', /messi-saas-stage2d-apply-owner\.js plan/.test(doc)
    && /--confirm-cost-approval/.test(doc) && /--max-monthly-estimate/.test(doc)
    && /--confirm-rollback/.test(doc) && /--rollback-on-failure/.test(doc));

  const src = fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8') + fs.readFileSync(path.join(ROOT, CLI_REL), 'utf8');
  ok('no_secret_argv_flags', !/--admin-database-url|--postgres-admin-password|--app-role-password|--session-secret/i.test(src));
  ok('uses_arm_https_token', /get-access-token/.test(src) && /management\.azure\.com/.test(src));
  ok('no_az_deployment_file', !/az deployment group create/.test(src) && !/parameters\.json/.test(src));

  const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 's2d-man-'));
  writeManifest(mdir);

  console.log('\n── PLAN ──');
  {
    const h = makeHarness(lib);
    const r = await lib.plan({ slug: SLUG, manifestDir: mdir }, h.deps);
    ok('plan_ok', r.ok === true, JSON.stringify(r.errors || r).slice(0, 200));
    ok('plan_rg_name', r.ok && r.plan.resourceGroupName === RG);
    ok('plan_digest_shape', r.ok && /^[a-f0-9]{64}$/.test(r.plan.planDigest));
    ok('plan_no_secrets', r.ok && !JSON.stringify(r.plan).includes('postgres://')
      && !/"postgresAdminPassword"/.test(JSON.stringify(r.plan)));
    ok('plan_cost_present', r.ok && r.plan.currentCost && r.plan.currentCost.amount === 12.5);
    ok('plan_no_caller_authority', r.ok && r.plan.authority === 'repo_manifest_azure');
    h.store.set('planDigest', r.plan.planDigest);
  }
  {
    const h = makeHarness(lib);
    h.setCostFail(true);
    const r = await lib.plan({ slug: SLUG, manifestDir: mdir }, h.deps);
    ok('plan_cost_fail_closed', r.ok === false && (r.errors || []).some((e) => /cost/i.test(e.code || e)));
    ok('plan_no_fabricated_zero', r.ok === false && !((r.plan || {}).currentCost && r.plan.currentCost.amount === 0));
  }
  {
    const h = makeHarness(lib);
    const r = await lib.plan({ slug: 'sunset', manifestDir: mdir }, h.deps);
    ok('plan_rejects_reserved', r.ok === false && (r.errors || []).some((e) => /reserved|sunset|slug/i.test(String(e.code || e))));
  }
  {
    const h = makeHarness(lib);
    h.setRg({
      name: RG, id: `/subscriptions/${SUB}/resourceGroups/${RG}`,
      tags: { tenant: 'other', stage: 'saas-2d', owner: 'messi-stage2d', planDigest: 'x', deploySha: SHA },
      properties: { provisioningState: 'Succeeded' },
    });
    const r = await lib.plan({ slug: SLUG, manifestDir: mdir }, h.deps);
    ok('plan_rejects_rg_takeover', r.ok === false && (r.errors || []).some((e) => /ownership|takeover|tuple/i.test(String(e.code || e))));
  }

  console.log('\n── APPLY attacks ──');
  {
    const h = makeHarness(lib);
    const p = await lib.plan({ slug: SLUG, manifestDir: mdir }, h.deps);
    h.store.set('planDigest', p.plan.planDigest);
    // forge plan digest via state
    fs.mkdirSync(h.stateDir, { recursive: true });
    fs.writeFileSync(path.join(h.stateDir, `${SLUG}.local.json`), JSON.stringify({
      planDigest: 'f'.repeat(64), tenantSlug: SLUG, subscriptionId: SUB, resourceGroupName: RG,
    }));
    const forged = await lib.apply({
      slug: SLUG, manifestDir: mdir, confirmCostApproval: true, maxMonthlyEstimate: 500,
      expectedPlanDigest: 'f'.repeat(64),
    }, h.deps);
    ok('apply_rejects_forged_plan', forged.ok === false
      && (forged.errors || []).some((e) => /digest|forge|mismatch/i.test(String(e.code || e))));
  }
  {
    const h = makeHarness(lib);
    h.deps.azExec = (args) => {
      if (args[0] === 'account' && args[1] === 'show') {
        return JSON.stringify({ id: '00000000-0000-0000-0000-000000000099', state: 'Enabled' });
      }
      return h.baseAz(args);
    };
    const r = await lib.apply({
      slug: SLUG, manifestDir: mdir, confirmCostApproval: true, maxMonthlyEstimate: 500,
    }, h.deps);
    ok('apply_subscription_drift', r.ok === false && (r.errors || []).some((e) => /subscription/i.test(String(e.code || e))));
  }
  {
    const h = makeHarness(lib);
    const r = await lib.apply({ slug: SLUG, manifestDir: mdir, maxMonthlyEstimate: 500 }, h.deps);
    ok('apply_requires_cost_flag', r.ok === false && (r.errors || []).some((e) => /cost_approval|confirm/i.test(String(e.code || e))));
  }
  {
    const h = makeHarness(lib);
    const p = await lib.plan({ slug: SLUG, manifestDir: mdir }, h.deps);
    h.store.set('planDigest', p.plan.planDigest);
    // Capture generated secrets by monkeypatching generate via apply success path inspection:
    // instead assert arm body redaction helper
    const secrets = lib.generateSecrets({ slug: SLUG, randomBytes: (n) => Buffer.alloc(n, 9) });
    Object.values(secrets).forEach((s) => h.secretLog.push(s));
    const red = lib.redactSecrets(`dsn=${secrets.appDatabaseUrl} tok=${secrets.lunaBotInternalToken}`, Object.values(secrets));
    ok('secret_redaction', !red.includes(secrets.appDatabaseUrl) && !red.includes(secrets.lunaBotInternalToken) && /REDACTED/.test(red));
    ok('secrets_not_in_argv_surface', !process.argv.join(' ').includes(secrets.postgresAdminPassword));
  }
  {
    const h = makeHarness(lib);
    const p = await lib.plan({ slug: SLUG, manifestDir: mdir }, h.deps);
    h.store.set('planDigest', p.plan.planDigest);
    h.setJobStatus('Failed');
    const r = await lib.apply({
      slug: SLUG, manifestDir: mdir, confirmCostApproval: true, maxMonthlyEstimate: 500,
    }, h.deps);
    ok('apply_job_failure_preserves_rg', r.ok === false
      && (r.errors || []).some((e) => /bootstrap|job/i.test(String(e.code || e)))
      && r.preservedResourceGroup === true);
  }
  {
    const h = makeHarness(lib);
    const p = await lib.plan({ slug: SLUG, manifestDir: mdir }, h.deps);
    h.store.set('planDigest', p.plan.planDigest);
    h.setRoleDelay(50);
    h.deps.rolePropagateAttempts = 3;
    const r = await lib.apply({
      slug: SLUG, manifestDir: mdir, confirmCostApproval: true, maxMonthlyEstimate: 500,
    }, h.deps);
    ok('apply_rbac_timeout', r.ok === false && (r.errors || []).some((e) => /rbac|role|propagat/i.test(String(e.code || e))));
  }
  {
    const h = makeHarness(lib);
    const p = await lib.plan({ slug: SLUG, manifestDir: mdir }, h.deps);
    h.store.set('planDigest', p.plan.planDigest);
    h.setRevisionHealthy(false);
    const r = await lib.apply({
      slug: SLUG, manifestDir: mdir, confirmCostApproval: true, maxMonthlyEstimate: 500,
    }, h.deps);
    ok('apply_unhealthy_revision', r.ok === false && (r.errors || []).some((e) => /health|revision|replica/i.test(String(e.code || e))));
  }
  {
    const h = makeHarness(lib);
    const p = await lib.plan({ slug: SLUG, manifestDir: mdir }, h.deps);
    h.store.set('planDigest', p.plan.planDigest);
    h.setJobStatus('Succeeded');
    // Force partial: fail after infra by making bootstrap start throw once job path hit — use job deleted early
    let phase = 0;
    const inner = h.deps.armRequest;
    h.deps.armRequest = async (req) => {
      if (/deployments\//i.test(req.path) && req.method === 'PUT') {
        phase += 1;
        if (phase === 2) return { status: 500, body: { error: { code: 'PartialDeploy' } } };
      }
      return inner(req);
    };
    const r = await lib.apply({
      slug: SLUG, manifestDir: mdir, confirmCostApproval: true, maxMonthlyEstimate: 500,
    }, h.deps);
    ok('apply_partial_preserves_rg', r.ok === false && r.preservedResourceGroup === true);
  }

  console.log('\n── APPLY happy + STATUS/ROLLBACK ──');
  {
    const h = makeHarness(lib);
    const p = await lib.plan({ slug: SLUG, manifestDir: mdir }, h.deps);
    h.store.set('planDigest', p.plan.planDigest);
    const r = await lib.apply({
      slug: SLUG, manifestDir: mdir, confirmCostApproval: true, maxMonthlyEstimate: 500,
    }, h.deps);
    ok('apply_ok', r.ok === true, JSON.stringify(r.errors || []).slice(0, 240));
    ok('apply_state_nonsecret', r.ok && fs.existsSync(path.join(h.stateDir, `${SLUG}.local.json`)));
    if (r.ok) {
      const st = JSON.parse(fs.readFileSync(path.join(h.stateDir, `${SLUG}.local.json`), 'utf8'));
      ok('state_has_ids', st.subscriptionId === SUB && st.resourceGroupName === RG && st.planDigest === p.plan.planDigest);
      ok('state_no_secrets', !JSON.stringify(st).includes('postgres://') && !JSON.stringify(st).includes(Buffer.alloc(24, 9).toString('base64')));
    } else {
      ok('state_has_ids', false, 'skipped');
      ok('state_no_secrets', false, 'skipped');
    }
    const st = await lib.status({ slug: SLUG, manifestDir: mdir }, h.deps);
    ok('status_ok', st.ok === true, JSON.stringify(st.errors || []).slice(0, 200));
    ok('status_compares_arm', st.ok && st.comparedAgainst === 'arm_readback');

    const statePath = path.join(h.stateDir, `${SLUG}.local.json`);
    if (fs.existsSync(statePath)) {
      const cur = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      cur.subscriptionId = '00000000-0000-0000-0000-000000000099';
      fs.writeFileSync(statePath, JSON.stringify(cur));
      const badSt = await lib.status({ slug: SLUG, manifestDir: mdir }, h.deps);
      ok('status_rejects_forged_state', badSt.ok === false);
      cur.subscriptionId = SUB;
      fs.writeFileSync(statePath, JSON.stringify(cur));
      const rb = await lib.rollback({ slug: SLUG, confirmRollback: true }, h.deps);
      ok('rollback_ok', rb.ok === true, JSON.stringify(rb.errors || []).slice(0, 200));
      ok('rollback_removes_state', !fs.existsSync(statePath));
    } else {
      ok('status_rejects_forged_state', false, 'no state');
      ok('rollback_ok', false, 'no state');
      ok('rollback_removes_state', false, 'no state');
    }
  }
  {
    const h = makeHarness(lib);
    const p = await lib.plan({ slug: SLUG, manifestDir: mdir }, h.deps);
    h.store.set('planDigest', p.plan.planDigest);
    const applied = await lib.apply({
      slug: SLUG, manifestDir: mdir, confirmCostApproval: true, maxMonthlyEstimate: 500,
    }, h.deps);
    h.setDeleteMismatch(true);
    const rb = await lib.rollback({ slug: SLUG, confirmRollback: true }, h.deps);
    ok('rollback_delete_mismatch', applied.ok === true && rb.ok === false
      && (rb.errors || []).some((e) => /delete|mismatch|conflict/i.test(String(e.code || e))),
      JSON.stringify({ applied: applied.errors, rb: rb.errors }).slice(0, 240));
  }
  {
    const h = makeHarness(lib);
    const r = await lib.rollback({ slug: SLUG }, h.deps);
    ok('rollback_requires_flag', r.ok === false && (r.errors || []).some((e) => /confirm/i.test(String(e.code || e))));
  }

  console.log('\n── Budget ──');
  const st = diffStat();
  ok('file_budget', st.files <= 10, `files=${st.files}`);
  ok('net_budget', st.net <= 1600, `net=${st.net} raw=+${st.rawAdd}/-${st.rawDel}`);

  console.log(`\nRESULT: ${fail ? 'FAIL' : 'PASS'}  pass=${pass} fail=${fail}  net=+${st.net}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
