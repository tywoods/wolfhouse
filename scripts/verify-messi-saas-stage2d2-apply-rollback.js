#!/usr/bin/env node
'use strict';
/** verify:messi-saas-stage2d2-apply-rollback — offline Stage 2D2 gate (no Azure writes). */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const BASE = '0147209d31f07ab4a98424a5b6b8099bbc194576';
const LIB_REL = 'scripts/lib/messi-saas-stage2d2-apply-rollback.js';
const CLI_REL = 'scripts/messi-saas-stage2d2-apply-rollback.js';
const DOC_REL = 'docs/MESSI-SAAS-STAGE2D2-APPLY-ROLLBACK.md';
const D1_REL = 'scripts/lib/messi-saas-stage2d1-plan-status.js';
const FILES = [LIB_REL, CLI_REL, 'scripts/verify-messi-saas-stage2d2-apply-rollback.js', DOC_REL,
  'package.json', 'scripts/bootstrap-synthetic-tenant-db.js',
  'infra/azure/modules/tenant-staging/main.bicep',
  'infra/azure/modules/tenant-staging/synthetic-bootstrap-job.bicep',
  'infra/azure/modules/tenant-staging/synthetic-runtime-secrets.bicep',
  'infra/azure/modules/tenant-staging/acr-pull-role.json',
  'fixtures/messi-saas-stage2d2/live-residual-12-resource-acrpull-missing.json',
  D1_REL];
const SLUG = 'messiproof';
const SUB = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
const RG = `luna-${SLUG}-staging-rg`;
const SHA = 'b'.repeat(40);
const DIGEST_IMG = `sha256:${'c'.repeat(64)}`;
const PINNED_AZ = '/opt/data/.local/bin/az';
const CREATED = '2026-07-23T12:00:00.000Z';
const EXPIRES = '2026-07-25T12:00:00.000Z';
const TPL = {
  $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
  contentVersion: '1.0.0.0', resources: [{ type: 'Microsoft.Resources/deployments', name: 'tenant' }], outputs: {},
};
const TPL_BYTES = Buffer.from(JSON.stringify(TPL));
const PID = '11111111-2222-3333-4444-555555555555';
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
function makeHarness(lib, d1, opts = {}) {
  const armLog = []; const azLog = []; const azCmdLog = [];
  let rg = null; let etag = '"etag-1"';
  let deployments = {}; let deploymentList = []; let deploymentListStatus = null;
  let job = null; let app = null;
  let mi = { properties: { principalId: PID } };
  let rolesById = {}; let resources = []; let nested = {}; let secrets = [];
  let costRows = [[0, 'USD']]; let costFail = false;
  let branch = 'master'; let identityOk = true;
  let acrFail = false; let putFailPath = null;
  let pollStates = {}; let deleteEtagRace = false;
  let clock = new Date('2026-07-23T12:00:00Z');
  // Default GREEN: AlertsManagement Registered (live defect was NotRegistered).
  let providerHttpStatus = 200;
  let providerBody = {
    id: `/subscriptions/${SUB}/providers/Microsoft.AlertsManagement`,
    namespace: 'Microsoft.AlertsManagement',
    registrationState: 'Registered',
  };
  const headSha = String(opts.headSha || opts.verifiedDeploySha || SHA).toLowerCase();
  const originMasterSha = String(opts.originMasterSha || headSha).toLowerCase();
  const missingShas = new Set((opts.missingShas || []).map((s) => String(s).toLowerCase()));
  const nonCommitShas = new Set((opts.nonCommitShas || []).map((s) => String(s).toLowerCase()));
  const isAncestorFn = typeof opts.isAncestor === 'function'
    ? opts.isAncestor
    : (anc, desc) => String(anc).toLowerCase() === String(desc).toLowerCase();
  const listeners = {};
  const fakeProc = {
    on(sig, fn) { listeners[sig] = (listeners[sig] || []).concat([fn]); },
    removeListener(sig, fn) {
      listeners[sig] = (listeners[sig] || []).filter((x) => x !== fn);
    },
    emit(sig) { for (const fn of (listeners[sig] || [])) fn(sig); },
    exit() {},
  };
  const fakeTools = {
    gitSha256: '1'.repeat(64), tarSha256: '2'.repeat(64), nodeSha256: '3'.repeat(64),
    azSha256: '4'.repeat(64), bicepSha256: '5'.repeat(64), bicepVersion: 'Bicep CLI version 0.45.15 (test)',
  };
  const stateDir = opts.stateDir || fs.mkdtempSync(path.join(os.tmpdir(), 'messi-2d2-'));
  const isDepListPath = (p) => /\/providers\/Microsoft\.Resources\/deployments(\?|$)/i.test(p);
  // Offline GREEN: in-worktree node_modules path only (no ambient NODE_PATH / real npm install).
  const inTreePg = path.join(ROOT, 'node_modules', 'pg', 'lib', 'index.js');
  const deps = lib.createDeps({
    repoRoot: ROOT, stateDir,
    sleep: async (ms) => { clock = new Date(clock.getTime() + (Number(ms) || 0)); },
    now: () => new Date(clock.getTime()),
    process: opts.process || fakeProc,
    toolAuthority: opts.toolAuthority || fakeTools, verifiedDeploySha: opts.verifiedDeploySha || headSha,
    snapshotAdapter: opts.snapshotAdapter || (() => ({ root: ROOT, cleanup: () => {} })),
    bicepBuildBytes: opts.bicepBuildBytes || (() => Buffer.from(TPL_BYTES)),
    randomBytes: (n) => Buffer.alloc(n, 7),
    requireResolve: opts.requireResolve || ((id) => {
      if (String(id) === 'pg') return inTreePg;
      return require.resolve(id, { paths: [ROOT] });
    }),
    // Synthetic in-tree paths need not exist on disk for the offline harness.
    realpath: opts.realpath || ((p) => {
      try { return fs.realpathSync(p); } catch (_) { return path.resolve(String(p)); }
    }),
    bootstrapOperator: opts.bootstrapOperator || ((args) => {
      azCmdLog.push(args && args.azCommand);
      return {
        assertCanDelete: async () => ({ ok: true, errors: [] }),
        startJob: async () => ({ ok: true, executionName: 'exec-1', errors: [] }),
        waitTerminal: async () => ({ ok: true, status: 'Succeeded', summary: { ok: true }, errors: [] }),
        deleteJob: async () => ({ ok: true, verifiedAbsent: true, errors: [] }),
        installSignalHandlers() {}, removeSignalHandlers() {},
      };
    }),
    gitExec: (args) => {
      const a = args.join(' ');
      if (a === 'fetch origin master') return '';
      if (a === 'rev-parse --abbrev-ref HEAD') return branch;
      if (a === 'status --porcelain') return opts.dirty ? ' M x' : '';
      if (a === 'rev-parse HEAD') return headSha;
      if (a === 'rev-parse origin/master') return originMasterSha;
      if (args[0] === 'cat-file' && args[1] === '-t') {
        const sha = String(args[2] || '').toLowerCase();
        if (missingShas.has(sha)) {
          const e = new Error(`Not a valid object name ${sha}`); e.status = 128; throw e;
        }
        if (nonCommitShas.has(sha)) return 'blob';
        return 'commit';
      }
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        const anc = String(args[2] || '').toLowerCase();
        const desc = String(args[3] || '').toLowerCase();
        if (isAncestorFn(anc, desc)) return '';
        const e = new Error('not an ancestor'); e.status = 1; throw e;
      }
      return '';
    },
    azExec: (args) => {
      azLog.push(args.slice());
      if (args[0] === 'account' && args[1] === 'show') {
        return JSON.stringify({ id: opts.activeSub || SUB, name: 'staging', state: 'Enabled' });
      }
      if (args[0] === 'account' && args[1] === 'get-access-token') {
        return JSON.stringify({ accessToken: 'TEST_TOKEN_NOT_SECRET', expiresOn: '2099-01-01' });
      }
      if (args[0] === 'acr' && args[1] === 'build') return 'built';
      if (args[0] === 'acr' && args[1] === 'manifest' && args[2] === 'list-metadata') {
        if (acrFail) throw new Error('acr manifest list-metadata failed');
        // Exact repo+tag mapping only — other tags/untagged must not win.
        return JSON.stringify([
          {
            digest: DIGEST_IMG,
            tags: [headSha],
            architecture: 'amd64',
            os: 'linux',
            mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
            configMediaType: 'application/vnd.docker.container.image.v1+json',
          },
          {
            digest: `sha256:${'d'.repeat(64)}`,
            tags: ['old-other-tag'],
            architecture: 'amd64',
            os: 'linux',
          },
          {
            digest: `sha256:${'e'.repeat(64)}`,
            tags: [],
            architecture: 'amd64',
            os: 'linux',
          },
        ]);
      }
      throw new Error(`unexpected_az:${args.join(' ')}`);
    },
    armRequest: async (req) => {
      armLog.push({ method: req.method, path: req.path, body: req.body || null, headers: req.headers || null });
      const p = req.path || '';
      if (putFailPath && req.method === 'PUT' && p.includes(putFailPath)) {
        return { status: 500, body: { error: 'fail' }, headers: {} };
      }
      // Subscription-scope provider registration GET (exact Microsoft.AlertsManagement preflight).
      if (req.method === 'GET'
        && /^\/subscriptions\/[^/]+\/providers\/Microsoft\.AlertsManagement(\?|$)/i.test(p)
        && !/resource[Gg]roups/i.test(p)) {
        return { status: providerHttpStatus, body: providerBody, headers: {} };
      }
      if (req.method === 'GET' && /resourcegroups\/[^/?]+(\?|$)/i.test(p)
        && !/providers\//i.test(p.split('resourcegroups/')[1] || '')) {
        return rg
          ? { status: 200, body: rg, headers: etag ? { etag } : {} }
          : { status: 404, body: {}, headers: {} };
      }
      if (req.method === 'PUT' && /resourcegroups\/[^/?]+(\?|$)/i.test(p)
        && !/providers\//i.test(p.split('resourcegroups/')[1] || '')) {
        if (rg && etag) {
          const want = (req.headers && (req.headers['If-Match'] || req.headers['if-match'])) || null;
          if (!want || want !== etag) return { status: 412, body: {}, headers: {} };
        }
        rg = { name: RG, location: 'westeurope', tags: (req.body && req.body.tags) || {}, properties: { provisioningState: 'Succeeded' } };
        if (etag) etag = `"etag-${Date.now()}"`;
        return { status: 200, body: rg, headers: etag ? { etag } : {} };
      }
      if (req.method === 'DELETE' && /resourcegroups\/[^/?]+(\?|$)/i.test(p)
        && !/providers\//i.test(p.split('resourcegroups/')[1] || '')) {
        if (deleteEtagRace) return { status: 412, body: {}, headers: {} };
        if (etag) {
          const want = (req.headers && (req.headers['If-Match'] || req.headers['if-match'])) || null;
          if (!want || want !== etag) return { status: 412, body: {}, headers: {} };
        }
        rg = null;
        return { status: 202, body: {}, headers: {} };
      }
      if (/CostManagement\/query/i.test(p)) {
        return costFail ? { status: 503, body: {}, headers: {} }
          : { status: 200, body: { properties: { rows: costRows } }, headers: {} };
      }
      // Authoritative RG deployment history LIST (empty-phase gate).
      if (isDepListPath(p)) {
        if (deploymentListStatus != null) {
          return { status: deploymentListStatus, body: { error: { code: 'HarnessForced' } }, headers: {} };
        }
        return { status: 200, body: { value: deploymentList }, headers: {} };
      }
      if (/\/deployments\//i.test(p)) {
        const name = decodeURIComponent((p.match(/deployments\/([^/?]+)/) || [])[1] || '');
        if (req.method === 'PUT') {
          deployments[name] = { id: p.replace(/\?.*$/, ''), properties: { provisioningState: 'Accepted' } };
          const seq = pollStates[name] || ['Succeeded'];
          pollStates[name] = seq.slice();
          return { status: 201, body: deployments[name], headers: {} };
        }
        if (req.method === 'GET') {
          // Prefer inventory LIST row (SHOW readback for Failure-Anomalies correlation).
          const listHit = (deploymentList || []).find((d) => String(d.name || '') === name);
          if (listHit) {
            return {
              status: 200,
              body: {
                id: listHit.id || p.replace(/\?.*$/, ''),
                name: listHit.name,
                type: listHit.type || 'Microsoft.Resources/deployments',
                properties: listHit.properties
                  || { provisioningState: listHit.provisioningState || 'Succeeded' },
              },
              headers: {},
            };
          }
          const seq = pollStates[name] || ['Succeeded'];
          const st = seq.length > 1 ? seq.shift() : seq[0];
          pollStates[name] = seq;
          deployments[name] = { id: p.replace(/\?.*$/, ''), name, type: 'Microsoft.Resources/deployments', properties: { provisioningState: st } };
          return { status: 200, body: deployments[name], headers: {} };
        }
      }
      if (/\/jobs\//i.test(p) && !/executions/i.test(p)) {
        if (req.method === 'DELETE') { job = null; return { status: 200, body: {}, headers: {} }; }
        return job ? { status: 200, body: job, headers: {} } : { status: 404, body: {}, headers: {} };
      }
      if (/userAssignedIdentities\//i.test(p)) {
        return mi ? { status: 200, body: mi, headers: {} } : { status: 404, body: {}, headers: {} };
      }
      if (/roleAssignments\/[0-9a-f-]{36}/i.test(p)) {
        const id = (p.match(/roleAssignments\/([0-9a-f-]{36})/i) || [])[1];
        const key = String(id).toLowerCase();
        if (req.method === 'PUT') {
          const props = (req.body && req.body.properties) || {};
          const scopeFromPath = p.replace(/\?.*$/, '').replace(/\/providers\/Microsoft\.Authorization\/roleAssignments\/[^/]+$/i, '');
          const body = {
            id: p.replace(/\?.*$/, ''),
            name: id,
            type: 'Microsoft.Authorization/roleAssignments',
            properties: {
              roleDefinitionId: props.roleDefinitionId,
              principalId: props.principalId,
              principalType: props.principalType || 'ServicePrincipal',
              scope: props.scope || scopeFromPath,
            },
          };
          rolesById[key] = body;
          return { status: 201, body, headers: {} };
        }
        if (req.method === 'DELETE') {
          if (!rolesById[key]) return { status: 404, body: {}, headers: {} };
          delete rolesById[key];
          return { status: 200, body: {}, headers: {} };
        }
        const hit = rolesById[key];
        return hit ? { status: 200, body: hit, headers: {} } : { status: 404, body: {}, headers: {} };
      }
      if (/\/resources(\?|&|$)/i.test(p)) return { status: 200, body: { value: resources }, headers: {} };
      // Exact smart-detector provider GET (pinned SMART_DETECTOR_API) — not sparse /resources.
      if (req.method === 'GET' && /smartDetectorAlertRules\//i.test(p)) {
        const rawName = decodeURIComponent((p.match(/smartDetectorAlertRules\/([^/?]+)/i) || [])[1] || '');
        const hit = (resources || []).find((r) => r
          && /smartDetectorAlertRules/i.test(String(r.type || ''))
          && (String(r.name || '') === rawName
            || String(r.name || '').toLowerCase() === rawName.toLowerCase()
            || (r.id && String(r.id).toLowerCase().endsWith(`/${rawName.toLowerCase()}`))));
        if (!hit) return { status: 404, body: {}, headers: {} };
        return { status: 200, body: hit, headers: {} };
      }
      if (/KeyVault\/vaults/i.test(p) && /\/secrets(\/|\?|$)/i.test(p)) {
        const m = p.match(/\/secrets\/([^/?]+)(?:\?|$)/i);
        if (m) {
          const hit = secrets.find((s) => s.name === decodeURIComponent(m[1]));
          return hit
            ? { status: 200, body: { id: hit.id, name: hit.name, tags: hit.tags || {} }, headers: {} }
            : { status: 404, body: {}, headers: {} };
        }
        return { status: 200, body: { value: secrets }, headers: {} };
      }
      if (/databases\//i.test(p) || /virtualNetworkLinks\//i.test(p)) {
        const key = Object.keys(nested).find((k) => p.includes(k));
        return key ? { status: 200, body: nested[key], headers: {} } : { status: 404, body: {}, headers: {} };
      }
      if (/containerApps\//i.test(p) && !/revisions\//i.test(p)) {
        return app ? { status: 200, body: app, headers: {} } : { status: 404, body: {}, headers: {} };
      }
      if (/revisions\//i.test(p)) {
        return {
          status: 200,
          body: { properties: { runningState: 'Running', healthState: 'Healthy', replicas: 1 } },
          headers: {},
        };
      }
      return { status: 200, body: {}, headers: {} };
    },
    httpsRequest: async () => (identityOk
      ? { status: 200, body: JSON.stringify({ status: 'ok', service: 'staff-api', default_client_slug: SLUG }) }
      : { status: 503, body: '{}' }),
  });
  return {
    deps, armLog, azLog, azCmdLog, stateDir, fakeProc, listeners,
    setRg(v) { rg = v; }, setEtag(v) { etag = v; }, setJob(v) { job = v; }, setApp(v) { app = v; },
    setMi(v) { mi = v; }, setRoles(v) { rolesById = v; }, setResources(v) { resources = v; },
    setNested(v) { nested = v; }, setSecrets(v) { secrets = v; },
    setDeploymentsList(v) { deploymentList = v; }, setDeploymentListStatus(v) { deploymentListStatus = v; },
    setCostFail(v) { costFail = v; }, setCostRows(v) { costRows = v; },
    setBranch(v) { branch = v; }, setAcrFail(v) { acrFail = v; },
    setPutFailPath(v) { putFailPath = v; }, setPollStates(v) { pollStates = v; },
    setDeleteEtagRace(v) { deleteEtagRace = v; }, setIdentityOk(v) { identityOk = v; },
    setClock(v) { clock = new Date(v); }, advanceClock(ms) { clock = new Date(clock.getTime() + ms); },
    setProvider(status, body) { providerHttpStatus = status; providerBody = body; },
    setProviderRegistrationState(state) {
      providerHttpStatus = 200;
      providerBody = {
        id: `/subscriptions/${SUB}/providers/Microsoft.AlertsManagement`,
        namespace: 'Microsoft.AlertsManagement',
        registrationState: state,
      };
    },
    seedRoles(names, opts = {}) {
      const c = d1.buildExpectedResourceContract(names, { principalId: PID });
      // Default seeds both roles for foundation inventory tests. Apply still PUTs AcrPull
      // (create-or-update). Pass { acrPull: false } to start without AcrPull (JS PUT path).
      const list = opts.acrPull === false
        ? c.roleAssignments.filter((role) => role.kind !== 'acr')
        : c.roleAssignments;
      rolesById = Object.fromEntries(list.map((role) => [String(role.name).toLowerCase(), {
        id: role.id, name: role.name,
        properties: {
          roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${role.roleDefinitionId}`,
          principalId: PID, scope: role.scope, principalType: 'ServicePrincipal',
        },
      }]));
      return c;
    },
    seedFoundation(tags) {
      const names = d1.deriveNames(SLUG, SUB);
      const c = d1.buildExpectedResourceContract(names, { principalId: PID });
      resources = c.foundationTopLevel.map((r) => ({
        id: r.id, name: r.name, type: r.type, tags, provisioningState: 'Succeeded',
      }));
      const [n0, n1] = c.nestedChildren;
      nested = {
        [n0.id]: { id: n0.id, name: n0.name, type: n0.type },
        [n1.id]: { id: n1.id, name: n1.name, type: n1.type, tags },
      };
      this.seedRoles(names); return c;
    },
  };
}
function approval() { return { approveMaxTotalUsd: 8, ttlHours: 48 }; }
function drillOwned(digest, deploySha = SHA) {
  return {
    tenant: SLUG, stage: 'saas-2d2-staging', owner: 'messi-stage2d2',
    planDigest: digest, deploySha, temporaryDrill: 'true', createdAt: CREATED, expiresAt: EXPIRES,
  };
}
/** Live Bicep hardcodes bootstrap Job stage saas-2c2 (not RG stage saas-2d2-staging). */
function bootstrapJobOwnedTags(rgTags) {
  return { ...rgTags, stage: 'saas-2c2' };
}
/** Rederive planDigest for an exact deploySha under the test harness authority surface. */
async function rederivedDigestAt(lib, d1, deploySha, harnessOpts = {}) {
  const h = makeHarness(lib, d1, harnessOpts);
  const d1deps = d1.createDeps({
    repoRoot: ROOT, stateDir: h.stateDir, gitExec: h.deps.gitExec, azExec: h.deps.azExec,
    armRequest: h.deps.armRequest, snapshotAdapter: h.deps.snapshotAdapter,
    toolAuthority: h.deps.toolAuthority, bicepBuildBytes: h.deps.bicepBuildBytes,
    verifiedDeploySha: deploySha,
  });
  const pre = {
    ok: true, errors: [], verifiedDeploySha: deploySha, deploySha, branch: 'master',
  };
  const auth = await d1.buildAuthorityAtExactSha({ slug: SLUG }, d1deps, deploySha, pre);
  if (!auth.ok) throw new Error(`rederivedDigestAt failed: ${JSON.stringify(auth.errors)}`);
  return { digest: auth.planDigest, auth, harness: h };
}
function runtimeAppBody(names) {
  return {
    id: 'app', tags: {},
    properties: {
      provisioningState: 'Succeeded', latestRevisionName: 'rev1',
      configuration: { ingress: { fqdn: `${SLUG}.example.azurecontainerapps.io` } },
      template: {
        containers: [{
          name: names.staffApiContainerName,
          image: `whstagingacr.azurecr.io/luna-sunset-staff-api@${DIGEST_IMG}`,
          env: [
            { name: 'DEFAULT_CLIENT_SLUG', value: SLUG }, { name: 'STAFF_API_INGRESS_TENANT_SLUG', value: SLUG },
            { name: 'STAFF_ACTIONS_ENABLED', value: 'false' }, { name: 'STRIPE_LINKS_ENABLED', value: 'false' },
            { name: 'WHATSAPP_DRY_RUN', value: 'true' },
          ],
        }],
      },
    },
  };
}

async function main() {
  console.log('verify:messi-saas-stage2d2-apply-rollback — Stage 2D2\n');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok('package_script', pkg.scripts['verify:messi-saas-stage2d2-apply-rollback']
    === 'node scripts/verify-messi-saas-stage2d2-apply-rollback.js');
  ok('files_exist', [CLI_REL, LIB_REL, DOC_REL, D1_REL].every((r) => fs.existsSync(path.join(ROOT, r))));
  let lib; let d1;
  try {
    lib = require('./lib/messi-saas-stage2d2-apply-rollback');
    d1 = require('./lib/messi-saas-stage2d1-plan-status');
  } catch (e) { ok('lib_loads', false, String(e.message)); process.exit(1); }
  ok('lib_loads', !!lib && typeof d1.deriveAuthority === 'function');
  ok('api_surface', typeof lib.apply === 'function' && typeof lib.rollback === 'function'
    && typeof lib.expiryStatus === 'function' && typeof lib.deriveD1Authority === 'function'
    && typeof lib.deriveD1HistoricalRollbackAuthority === 'function'
    && typeof d1.deriveHistoricalRollbackAuthority === 'function'
    && typeof d1.assertHistoricalDeployShaCandidate === 'function'
    && typeof d1.resolveCurrentStagingNames === 'function');

  const doc = fs.readFileSync(path.join(ROOT, DOC_REL), 'utf8');
  const src = fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8') + fs.readFileSync(path.join(ROOT, CLI_REL), 'utf8');
  ok('docs_exact_commands', /approve-max-total-usd 8/.test(doc) && /ttl-hours 48/.test(doc)
    && /expiry-status/.test(doc) && /confirm-delete luna-messiproof-staging-rg/.test(doc)
    && !/scheduler|setInterval|cron/i.test(doc) && /monthly_approval_rejected/.test(src)
    && !/--approve-monthly-usd/.test(doc)
    && /\bnpm ci\b/.test(doc) && /local_runtime_dependency_missing/.test(doc)
    && /Local runtime preflight/.test(doc)
    && /worktree's own `node_modules`|own node_modules install/i.test(doc)
    && /manually maintained/i.test(doc) && /not auto-complete/i.test(doc));
  ok('d1_handoff_and_lock', /deriveAuthority/.test(src) && /O_NOFOLLOW|nofollow/.test(src)
    && /temporaryDrill/.test(src) && /expiresAt/.test(src)
    && /If-Match/.test(src) && /HEALTH_IDENTITY_PATH/.test(src)
    && /assertActiveDrill/.test(src) && /LEGITIMATE_PHASES/.test(src)
    && /SIGINT|SIGTERM/.test(src) && /PHASE_MAX_MS/.test(src)
    && /rg-delete/.test(src) && /parseRetryAfterMs|Retry-After|retry-after/.test(src)
    && /rollback_aborted|rollback_failed/.test(src)
    && lib.PHASE_MAX_MS['rg-delete'] >= 30 * 60 * 1000
    && /assertLocalApplyRuntimePreflight/.test(src)
    && /LOCAL_APPLY_RUNTIME_MODULES/.test(src)
    && typeof lib.assertLocalApplyRuntimePreflight === 'function'
    && lib.LOCAL_APPLY_RUNTIME_MODULES.includes('pg')
    && lib.LOCAL_APPLY_RUNTIME_PREREQ_CMD === 'npm ci'
    && /pathIsInside|node_modules/.test(src)
    && /manually maintained frozen list|not auto-complete under future C2/i.test(src)
    && !/\bnpm install\b/.test(src));
  ok('docs_claim_truth', /assertActiveDrill|SIGINT|pinned absolute|inventory finding|legitimate/i.test(doc)
    && /wall-clock|PHASE_MAX|30m|Retry-After|tag tuple|rollback_failed/i.test(doc)
    && /\bnpm ci\b/.test(doc) && /local_runtime_dependency_missing|before ACR build/i.test(doc)
    && /NODE_PATH|ancestor|out-of-worktree linked/i.test(doc)
    && /manually maintained/i.test(doc) && /not auto-complete/i.test(doc)
    && !/scheduler|setInterval|cron|background expiry daemon runs/i.test(doc));

  {
    const main = fs.readFileSync(path.join(ROOT, 'infra/azure/modules/tenant-staging/main.bicep'), 'utf8');
    const job = fs.readFileSync(path.join(ROOT, 'infra/azure/modules/tenant-staging/synthetic-bootstrap-job.bicep'), 'utf8');
    const sec = fs.readFileSync(path.join(ROOT, 'infra/azure/modules/tenant-staging/synthetic-runtime-secrets.bicep'), 'utf8');
    ok('bicep_drill_tags_default_noop', /param temporaryDrill string = ''/.test(main)
      && /param createdAt string = ''/.test(main) && /param expiresAt string = ''/.test(main)
      && /enablePrivateNetwork && !empty\(temporaryDrill\)/.test(main)
      && /provenance\.temporaryDrill/.test(job) && /provenance\.temporaryDrill/.test(sec));
  }

  // Stage 2D2 messiproof: canonical KV name exceeds Azure 24-char limit (InvalidTemplate class).
  // Owner function shortens; Bicep params / contract / role IDs all use the same name.
  {
    const canon = d1.canonicalKeyVaultName(SLUG);
    const names = d1.deriveNames(SLUG, SUB);
    const kv = names.keyVaultName;
    ok('d2_kv_name_red_messiproof_canonical_invalid',
      SLUG === 'messiproof'
      && canon === 'luna-messiproof-staging-kv'
      && canon.length === 26
      && d1.isValidAzureKeyVaultName(canon) === false);
    ok('d2_kv_name_green_owner_valid',
      kv === d1.deriveKeyVaultName(SLUG)
      && d1.isValidAzureKeyVaultName(kv) === true
      && kv.length <= 24 && kv !== canon);
    const contract = d1.buildExpectedResourceContract(names, { principalId: PID });
    const params = lib.buildNonsecretParams(names, SHA, 'd'.repeat(64), 'infra', {
      temporaryDrill: 'true', createdAt: CREATED, expiresAt: EXPIRES,
    });
    ok('d2_kv_name_params_contract_role_ids_consistent',
      params.keyVaultName && params.keyVaultName.value === kv
      && contract.foundationTopLevel.some((r) => r.type === 'Microsoft.KeyVault/vaults' && r.name === kv)
      && contract.roleAssignments.some((r) => r.kind === 'kv' && r.scope.endsWith(`/vaults/${kv}`))
      && contract.runtimeSecrets.every((s) => s.id.includes(`/vaults/${kv}/secrets/`))
      && !JSON.stringify(params).includes(canon)
      && !JSON.stringify(contract).includes(canon),
      `kv=${kv} param=${params.keyVaultName && params.keyVaultName.value}`);
    const liveFix = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'fixtures/messi-saas-stage2d2/infra-partial-live-crash.json'), 'utf8',
    ));
    ok('d2_kv_name_fixture_excluded_uses_owner',
      Array.isArray(liveFix.excludedFoundationNames)
      && liveFix.excludedFoundationNames[0] === kv
      && liveFix.excludedFoundationNames[0] !== canon
      && !liveFix.topLevelResourceNames.includes(kv)
      && !liveFix.topLevelResourceNames.includes(canon));
    // Attack/edge: min/max slugs + similar long prefixes cannot collide.
    const minKv = d1.deriveKeyVaultName('aaa');
    const maxKv = d1.deriveKeyVaultName(`z${'y'.repeat(31)}`);
    const p1 = d1.deriveKeyVaultName('messiproofaa');
    const p2 = d1.deriveKeyVaultName('messiproofbb');
    ok('d2_kv_name_edges_and_collision_resistance',
      d1.isValidAzureKeyVaultName(minKv) && d1.isValidAzureKeyVaultName(maxKv)
      && minKv === d1.canonicalKeyVaultName('aaa')
      && maxKv.length === 24 && p1 !== p2
      && d1.isValidAzureKeyVaultName(p1) && d1.isValidAzureKeyVaultName(p2));
  }

  // Stage 2D2 messiproof: canonical bootstrap Job name is 33 chars (Azure max 32).
  // Live evidence: ContainerAppInvalidName on luna-messiproof-staging-bootstrap after
  // infra+AcrPull succeeded. Owner shortens; params/contract/operator share that name.
  {
    const canon = d1.canonicalBootstrapJobName(SLUG);
    const names = d1.deriveNames(SLUG, SUB);
    const job = names.bootstrapJobName;
    ok('d2_bootstrap_job_name_red_messiproof_canonical_invalid',
      SLUG === 'messiproof'
      && canon === 'luna-messiproof-staging-bootstrap'
      && canon.length === 33
      && d1.isValidAzureContainerAppsJobName(canon) === false);
    ok('d2_bootstrap_job_name_green_owner_valid',
      job === d1.deriveBootstrapJobName(SLUG)
      && d1.isValidAzureContainerAppsJobName(job) === true
      && job.length <= 32 && job !== canon
      && job === 'luna-messiproof-63aa6df2'
      && job !== canon.slice(0, 32)
      && job.includes(d1.sha256(canon).slice(0, 8)));
    const contract = d1.buildExpectedResourceContract(names, { principalId: PID });
    const params = lib.buildNonsecretParams(names, SHA, 'd'.repeat(64), 'bootstrap', {
      temporaryDrill: 'true', createdAt: CREATED, expiresAt: EXPIRES,
      imageDigest: `sha256:${'a'.repeat(64)}`,
    });
    ok('d2_bootstrap_job_name_params_contract_consistent',
      params.bootstrapJobName && params.bootstrapJobName.value === job
      && contract.bootstrapJob && contract.bootstrapJob.name === job
      && contract.bootstrapJob.id.endsWith(`/Microsoft.App/jobs/${job}`)
      && !JSON.stringify(params).includes(canon)
      && !JSON.stringify(contract).includes(canon)
      && params.keyVaultName && params.keyVaultName.value === names.keyVaultName,
      `job=${job} param=${params.bootstrapJobName && params.bootstrapJobName.value}`);
    // Hostile edges: min/max slug + similar long prefixes; no raw truncation collisions.
    const minJob = d1.deriveBootstrapJobName('aaa');
    const maxJob = d1.deriveBootstrapJobName(`z${'y'.repeat(31)}`);
    const p1 = d1.deriveBootstrapJobName('messiproofaa');
    const p2 = d1.deriveBootstrapJobName('messiproofbb');
    ok('d2_bootstrap_job_name_edges_and_collision_resistance',
      d1.isValidAzureContainerAppsJobName(minJob)
      && d1.isValidAzureContainerAppsJobName(maxJob)
      && minJob === d1.canonicalBootstrapJobName('aaa')
      && maxJob.length <= 32 && p1 !== p2 && p1 !== job && p2 !== job
      && d1.isValidAzureContainerAppsJobName(p1)
      && d1.isValidAzureContainerAppsJobName(p2)
      && d1.deriveBootstrapJobName('sunset') === 'luna-sunset-staging-bootstrap'
      && d1.deriveBootstrapJobName('synthdemo') === 'luna-synthdemo-staging-bootstrap');
    // Compiled Bicep parity: main module takes owner param; job module uses jobName param.
    const mainSrc = fs.readFileSync(
      path.join(ROOT, 'infra/azure/modules/tenant-staging/main.bicep'), 'utf8',
    );
    const jobSrc = fs.readFileSync(
      path.join(ROOT, 'infra/azure/modules/tenant-staging/synthetic-bootstrap-job.bicep'), 'utf8',
    );
    ok('d2_bootstrap_job_name_bicep_param_parity',
      /param bootstrapJobName string/.test(mainSrc)
      && /@maxLength\(32\)/.test(mainSrc)
      && /@minLength\(2\)/.test(mainSrc)
      && /var resolvedBootstrapJobName = bootstrapJobName/.test(mainSrc)
      && /jobName:\s*resolvedBootstrapJobName/.test(mainSrc)
      && !mainSrc.includes("var bootstrapJobName = '${prefix}-bootstrap'")
      && /param jobName string/.test(jobSrc)
      && /name:\s*jobName/.test(jobSrc),
      'bicep still prefix-derives bootstrap job name');
  }

  {
    const bad = [{}, { approveMaxTotalUsd: 8, ttlHours: 49 }, { approveMaxTotalUsd: 9, ttlHours: 48 },
      { approveMaxTotalUsd: 8, ttlHours: 48, approveMonthlyUsd: 120 },
      { approveMaxTotalUsd: 7, ttlHours: 48 }, { approveMaxTotalUsd: 8, ttlHours: 24 }]
      .map((o) => lib.validateApprovalFlags(o));
    const good = lib.validateApprovalFlags({ approveMaxTotalUsd: 8, ttlHours: 48 });
    ok('invalid_cost_ttl_gates', bad.every((r) => !r.ok) && good.ok
      && bad[2].errors.some((e) => /approve_max_total/.test(e.code))
      && bad[3].errors.some((e) => e.code === 'monthly_approval_rejected'));
  }
  {
    const prorated = lib.estimateProratedWorstCaseUsd(90, 48);
    const base = {
      estimatedMonthlyUsd: 90, ttlHours: 48, approveMaxTotalUsd: 8,
      createdAt: CREATED, expiresAt: EXPIRES,
    };
    const gate = lib.assertCostGate({ ...base, now: new Date('2026-07-23T12:00:00Z') });
    const expired = lib.assertCostGate({ ...base, now: new Date('2026-07-26T12:00:00Z') });
    ok('prorated_under_cap', prorated <= 8 && prorated > 0);
    ok('expiry_enforced', gate.ok && !expired.ok && expired.errors.some((e) => e.code === 'ttl_expired'));
  }

  {
    // Dual deps.now() for createdAt/expiresAt: a 1ms clock advance makes exact 48h exceed the max.
    const h = makeHarness(lib, d1);
    const names = d1.deriveNames(SLUG, SUB);
    h.seedRoles(names);
    h.setJob({ id: 'job', name: names.bootstrapJobName, tags: {} });
    h.setApp(runtimeAppBody(names));
    let nowCalls = 0;
    const t0 = Date.parse(CREATED);
    h.deps.now = () => new Date(t0 + (nowCalls++));
    const r = await lib.apply({ slug: SLUG, ...approval() }, h.deps);
    const receipt = lib.readReceipt(h.deps, SLUG);
    const spanMs = receipt
      ? (Date.parse(receipt.expiresAt) - Date.parse(receipt.createdAt))
      : NaN;
    ok('single_clock_48h_apply_survives_advancing_now', r.ok === true
      && !(r.errors || []).some((e) => e.code === 'expires_at_invalid')
      && receipt
      && spanMs === 48 * 3600 * 1000,
    r.ok ? `spanMs=${spanMs}` : `errors=${JSON.stringify(r.errors || [])}`);
  }

  {
    const argv = lib.installedAcrManifestListMetadataArgv();
    let help = '';
    let azHelpOk = !fs.existsSync(d1.PINNED_BINS.az);
    try {
      help = execFileSync(d1.PINNED_BINS.az, ['acr', 'manifest', 'list-metadata', '-h'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      azHelpOk = /--name|--registry/.test(help);
    } catch (e) {
      // Lunabox pin absent on laptop/offline hosts — argv shape still fail-closed below.
      azHelpOk = e && (e.code === 'ENOENT' || /ENOENT/.test(String(e.message || e)));
    }
    ok('acr_syntax_installed_valid', argv[0] === 'acr' && argv[1] === 'manifest'
      && argv[2] === 'list-metadata'
      && argv.includes('--name') && argv.includes('luna-sunset-staff-api')
      && !argv.some((a) => String(a).includes(':'))
      && argv.includes('--registry') && argv.includes('whstagingacr')
      && azHelpOk && !argv.includes('--repository'));
  }
  {
    const h = makeHarness(lib, d1);
    h.setAcrFail(true);
    const r = await lib.apply({ slug: SLUG, ...approval() }, h.deps);
    ok('acr_failure_fail_closed', r.ok === false
      && (r.errors || []).some((e) => /acr|image_digest|manifest/i.test(e.code || e.message || '')));
  }

  {
    const sec = lib.generateSecrets({ slug: SLUG, randomBytes: (n) => Buffer.alloc(n, 9) });
    const dsn = lib.buildBootstrapAdminDsn({ slug: SLUG, adminPassword: sec.postgresAdminPassword });
    ok('dsn_percent_encoded_actual', dsn === sec.bootstrapAdminDatabaseUrl
      && dsn.includes(encodeURIComponent(sec.postgresAdminPassword))
      && !dsn.includes('***') && /sslmode=require/.test(dsn)
      && dsn.includes(`${SLUG}admin`) && dsn.includes(`${SLUG}_staging`));
  }

  {
    const h = makeHarness(lib, d1);
    h.setPollStates({ 'messi-2d2-infra': ['Running', 'Running', 'Succeeded'] });
    const pathKey = 'messi-2d2-infra';
    let gets = 0;
    const real = h.deps.armRequest;
    h.deps.armRequest = async (req) => {
      const res = await real(req);
      if (req.method === 'GET' && (req.path || '').includes(`/deployments/${pathKey}`)) {
        gets += 1;
        if (gets < 3) {
          return { status: 200, body: { properties: { provisioningState: 'Running' } }, headers: {} };
        }
      }
      return res;
    };
    const polled = await lib.pollArmTerminal(h.deps,
      `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Resources/deployments/${pathKey}?api-version=2021-04-01`,
      { createdAt: CREATED, expiresAt: EXPIRES, phase: 'infra' });
    ok('arm_polling_gets_until_terminal', polled.ok && polled.polls >= 3 && polled.status === 'Succeeded'
      && gets >= 3 && polled.body && polled.body.properties.provisioningState === 'Succeeded');
  }

  {
    const h = makeHarness(lib, d1);
    const sleeps = []; const t0 = h.deps.now().getTime(); let polls = 0;
    h.deps.sleep = async (ms) => { sleeps.push(ms); h.advanceClock(ms); };
    const real = h.deps.armRequest;
    h.deps.armRequest = async (req) => {
      if (req.method === 'GET' && /deployments\/long15/.test(req.path || '')) {
        polls += 1;
        const st = (h.deps.now().getTime() - t0) < 15 * 60 * 1000 ? 'Running' : 'Succeeded';
        return { status: 200, body: { properties: { provisioningState: st } }, headers: {} };
      }
      return real(req);
    };
    const polled = await lib.pollArmTerminal(h.deps,
      `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Resources/deployments/long15?api-version=2021-04-01`,
      { createdAt: CREATED, expiresAt: EXPIRES, phase: 'infra' });
    ok('wall_clock_15m_and_retry_after', polled.ok && polled.status === 'Succeeded'
      && sleeps[0] === 5000 && sleeps.includes(15000) && polls > 3
      && (h.deps.now().getTime() - t0) >= 15 * 60 * 1000
      && lib.parseRetryAfterMs({ 'retry-after': '7' }, 0) === 7000
      && lib.nextPollSleepMs(null, { 'retry-after': '9' }, 0) === 9000
      && lib.nextPollSleepMs(5000, {}, 0) === 10000
      && lib.nextPollSleepMs(15000, {}, 0) === 15000
      && lib.parseRetryAfterMs({ 'Retry-After': 'Wed, 23 Jul 2026 12:00:12 GMT' }, Date.parse(CREATED)) === 12000);
  }

  {
    const h = makeHarness(lib, d1);
    const names = d1.deriveNames(SLUG, SUB);
    h.seedRoles(names);
    h.setJob({
      id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/jobs/${names.bootstrapJobName}`,
      name: names.bootstrapJobName, tags: {},
    });
    const app = runtimeAppBody(names);
    app.id = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/${names.staffApiAppName}`;
    app.properties.latestRevisionName = `${names.staffApiAppName}--rev1`;
    app.properties.template.scale = { minReplicas: 1, maxReplicas: 1 };
    h.setApp(app);
    const r = await lib.apply({ slug: SLUG, ...approval() }, h.deps);
    const blob = JSON.stringify(r);
    const receipt = lib.readReceipt(h.deps, SLUG);
    const deletes = h.armLog.filter((x) => x.method === 'DELETE' && /\/jobs\//i.test(x.path || ''));
    const costPosts = h.armLog.filter((x) => x.method === 'POST' && /CostManagement\/query/i.test(x.path || ''));
    const roleGets = h.armLog.filter((x) => x.method === 'GET' && /roleAssignments\/[0-9a-f-]{36}/i.test(x.path || ''));
    const providerGets = h.armLog.filter((x) => x.method === 'GET'
      && /^\/subscriptions\/[^/]+\/providers\/Microsoft\.AlertsManagement(\?|$)/i.test(x.path || ''));
    const rgPuts = h.armLog.filter((x) => x.method === 'PUT'
      && /resourcegroups\/[^/?]+(\?|$)/i.test(x.path || '')
      && !/providers\//i.test((x.path || '').split('resourcegroups/')[1] || ''));
    ok('apply_happy_job_delete_roles_health_receipt', r.ok === true && deletes.length >= 1
      && costPosts.length >= 1 && roleGets.length >= 2
      && providerGets.length >= 1
      && providerGets[0].path === d1.alertsManagementProviderPath(SUB)
      && rgPuts.length >= 1
      && h.armLog.findIndex((x) => x.method === 'GET'
        && /Microsoft\.AlertsManagement/i.test(x.path || ''))
        < h.armLog.findIndex((x) => x.method === 'PUT'
          && /resourcegroups\//i.test(x.path || '') && !/providers\//i.test(x.path || ''))
      && receipt && receipt.kind === 'diagnostic_receipt_not_authority'
      && receipt.rollbackCommand === lib.pasteReadyRollbackCommand(SLUG)
      && receipt.createdAt === CREATED
      && !blob.includes(lib.generateSecrets({ slug: SLUG, randomBytes: (n) => Buffer.alloc(n, 7) }).postgresAdminPassword)
      && !/postgresql:\/\//i.test(blob) && !/postgresql:\/\//i.test(JSON.stringify(receipt)));
    ok('secret_nonleak_apply_output', !/postgresql:\/\/|sk_live|whsec_|EAAG_|base64url/i.test(blob)
      && h.azLog.every((a) => !a.some((x) => /postgresql:\/\//i.test(String(x)))));
    ok('live_tag_receipt_equality', r.ok && receipt.createdAt === CREATED && receipt.expiresAt === EXPIRES
      && h.azCmdLog.every((c) => c === PINNED_AZ || c == null));
    const putParams = h.armLog.filter((x) => x.method === 'PUT' && /\/deployments\//i.test(x.path || ''));
    ok('bicep_params_carry_drill_tags', putParams.length >= 1 && putParams.every((p) => {
      const pr = (p.body && p.body.properties && p.body.properties.parameters) || {};
      return pr.temporaryDrill && pr.temporaryDrill.value === 'true'
        && pr.createdAt && pr.createdAt.value && pr.expiresAt && pr.expiresAt.value;
    }));
    ok('local_runtime_preflight_preserves_happy_path',
      r.ok === true
      && typeof lib.assertLocalApplyRuntimePreflight === 'function'
      && lib.assertLocalApplyRuntimePreflight(h.deps).ok === true
      && src.indexOf('assertLocalApplyRuntimePreflight')
        < src.indexOf('buildStaffImage(deps, verifiedDeploySha)')
      && src.indexOf('assertLocalApplyRuntimePreflight')
        < src.indexOf("phaseGate('rg-create')"));
  }

  // --- Local runtime preflight: missing pg / entrypoint → zero ACR + zero ARM writes ---
  {
    const leakAbs = 'C:\\\\Users\\\\attacker\\\\.env';
    const leakDsn = 'postgresql://messi:SuperSecretPass@luna-messiproof-staging-pg-app.postgres.database.azure.com:5432/app?sslmode=require';
    const leakTok = 'sk_live_SHOULD_NOT_LEAK_123456';
    const approvalOpts = () => ({ slug: SLUG, approveMaxTotalUsd: 8, ttlHours: 48 });
    const zeroMut = (h, r, code) => {
      const acrBuilds = h.azLog.filter((a) => a[0] === 'acr' && a[1] === 'build');
      const armMut = h.armLog.filter((x) => ['PUT', 'DELETE', 'PATCH'].includes(x.method));
      const blob = JSON.stringify(r);
      return r.ok === false
        && r.refusedBeforeAzureMutation === true
        && r.refusedBeforeRgWrite === true
        && r.prerequisiteCommand === 'npm ci'
        && (r.errors || []).some((e) => e.code === code)
        && acrBuilds.length === 0 && armMut.length === 0
        && !blob.includes(leakAbs) && !blob.includes(leakDsn) && !blob.includes(leakTok)
        && !/postgresql:\/\//i.test(blob)
        && !/Require stack/i.test(blob)
        && !/node_modules/i.test(blob)
        && !/SuperSecretPass|sk_live_|DATABASE_URL|process\.env/i.test(blob);
    };
    {
      const h = makeHarness(lib, d1);
      h.deps.requireResolve = (id) => {
        if (id === 'pg') {
          const e = new Error(
            `Cannot find module 'pg'\nRequire stack:\n- ${leakAbs}\nDSN=${leakDsn}\nTOK=${leakTok}`,
          );
          e.code = 'MODULE_NOT_FOUND';
          throw e;
        }
        return require.resolve(id, { paths: [ROOT] });
      };
      const r = await lib.apply(approvalOpts(), h.deps);
      ok('missing_pg_zero_acr_zero_azure_writes',
        zeroMut(h, r, 'local_runtime_dependency_missing')
        && (r.errors || []).some((e) => e.message === 'missing required module: pg'),
        JSON.stringify({ errors: r.errors, az: h.azLog.length, arm: h.armLog.length }).slice(0, 280));
    }
    {
      const h = makeHarness(lib, d1);
      const miss = 'scripts/bootstrap-synthetic-tenant-db.js';
      h.deps.fileExists = (p) => {
        const norm = String(p).replace(/\\/g, '/');
        if (norm.endsWith(miss)) return false;
        return fs.existsSync(p);
      };
      const r = await lib.apply(approvalOpts(), h.deps);
      ok('missing_entrypoint_zero_azure_mutation',
        zeroMut(h, r, 'local_runtime_entrypoint_missing')
        && (r.errors || []).some((e) => e.message === `missing entrypoint ${miss}`)
        && !JSON.stringify(r).includes(h.stateDir),
        JSON.stringify({ errors: r.errors }).slice(0, 240));
    }
    {
      const h = makeHarness(lib, d1);
      const direct = lib.assertLocalApplyRuntimePreflight({
        repoRoot: ROOT,
        requireResolve: () => {
          throw new Error(`Cannot find module 'pg'\nRequire stack:\n- ${leakAbs}\n${leakDsn}\n${leakTok}`);
        },
        fileExists: () => true,
      });
      const blob = JSON.stringify(direct);
      ok('local_runtime_error_sanitized_no_secrets_or_fs',
        direct.ok === false
        && (direct.errors || []).every((e) => e.code === 'local_runtime_dependency_missing')
        && !blob.includes(leakAbs) && !/postgresql:\/\//i.test(blob)
        && !blob.includes(leakTok) && !/Require stack/i.test(blob)
        && !/node_modules|process\.env|DATABASE_URL/i.test(blob));
    }
    // Hostile: ambient NODE_PATH / global resolve succeeds outside worktree node_modules.
    {
      const ambientPg = path.join('/usr', 'lib', 'node_modules', 'pg', 'lib', 'index.js');
      const h = makeHarness(lib, d1);
      h.deps.requireResolve = (id) => {
        if (String(id) === 'pg') return ambientPg;
        return path.join(ROOT, 'node_modules', String(id));
      };
      h.deps.realpath = (p) => path.resolve(String(p));
      const r = await lib.apply(approvalOpts(), h.deps);
      ok('ambient_node_path_pg_refused_zero_mutation',
        zeroMut(h, r, 'local_runtime_dependency_missing')
        && !JSON.stringify(r).includes(ambientPg)
        && !JSON.stringify(r).includes('/usr/lib'),
        JSON.stringify({ errors: r.errors, az: h.azLog.length, arm: h.armLog.length }).slice(0, 280));
    }
    // Hostile: ancestor node_modules resolve succeeds (walk-up outside this worktree install).
    {
      const ancestorPg = path.join(ROOT, '..', 'node_modules', 'pg', 'lib', 'index.js');
      const h = makeHarness(lib, d1);
      h.deps.requireResolve = (id) => {
        if (String(id) === 'pg') return ancestorPg;
        return path.join(ROOT, 'node_modules', String(id));
      };
      h.deps.realpath = (p) => path.resolve(String(p));
      const r = await lib.apply(approvalOpts(), h.deps);
      ok('ancestor_node_modules_pg_refused_zero_mutation',
        zeroMut(h, r, 'local_runtime_dependency_missing')
        && !JSON.stringify(r).includes('..')
        && !JSON.stringify(r).includes(path.resolve(ROOT, '..')),
        JSON.stringify({ errors: r.errors }).slice(0, 240));
    }
    // Hostile: lexical path under worktree node_modules but realpath outside (npm link / external).
    {
      const linkedLexical = path.join(ROOT, 'node_modules', 'pg', 'lib', 'index.js');
      const linkedReal = path.join('/tmp', 'hostile-out-of-worktree-pg', 'lib', 'index.js');
      const h = makeHarness(lib, d1);
      h.deps.requireResolve = (id) => {
        if (String(id) === 'pg') return linkedLexical;
        return path.join(ROOT, 'node_modules', String(id));
      };
      h.deps.realpath = (p) => {
        const abs = path.resolve(String(p));
        if (abs === path.resolve(linkedLexical)
          || abs.includes(`${path.sep}node_modules${path.sep}pg`)) {
          return linkedReal;
        }
        return abs;
      };
      const r = await lib.apply(approvalOpts(), h.deps);
      const blob = JSON.stringify(r);
      ok('out_of_worktree_linked_pg_refused_zero_mutation',
        zeroMut(h, r, 'local_runtime_dependency_missing')
        && !blob.includes(linkedReal) && !blob.includes('hostile-out-of-worktree')
        && !blob.includes('/tmp/'),
        JSON.stringify({ errors: r.errors }).slice(0, 240));
    }
    // Direct unit: ambient success still yields stable sanitized code (no path echo).
    {
      const ambient = '/home/attacker/.node_modules/pg/index.js';
      const direct = lib.assertLocalApplyRuntimePreflight({
        repoRoot: ROOT,
        requireResolve: () => ambient,
        realpath: (p) => path.resolve(String(p)),
        fileExists: () => true,
      });
      const blob = JSON.stringify(direct);
      ok('ambient_resolve_sanitized_no_path_echo',
        direct.ok === false
        && (direct.errors || []).every((e) => e.code === 'local_runtime_dependency_missing'
          && e.message === 'missing required module: pg')
        && !blob.includes(ambient) && !blob.includes('attacker')
        && !blob.includes('.node_modules') && !/node_modules/i.test(blob));
    }
  }

  // --- AlertsManagement provider gate: refuse before RG writes (live Failure-Anomalies defect) ---
  {
    const fix = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'fixtures/messi-saas-stage2d2/alerts-management-provider-not-registered.json'), 'utf8',
    ));
    const mainBicep = fs.readFileSync(
      path.join(ROOT, 'infra/azure/modules/tenant-staging/main.bicep'), 'utf8',
    );
    const aiBlock = (mainBicep.match(/resource appInsights[\s\S]*?\n\}/) || [''])[0];
    ok('d2_provider_fixture_observed_platform_fa',
      fix.observedPlatformDeploymentFromAppInsightsCreate === true
      && fix.repoTemplateDisablePropertyFound === false
      && fix.globalPlatformDeploymentUnavoidabilityClaimed === false
      && fix.platformDeploymentUnavoidableForAppInsights !== true
      && fix.liveProviderShow.registrationState === 'NotRegistered'
      && fix.liveProviderShow.id
        === `/subscriptions/${SUB}/providers/Microsoft.AlertsManagement`
      && fix.correlatedFailureAnomalies.deploymentName
        === 'Failure-Anomalies-Alert-Rule-Deployment-ea8f51b8'
      && /Microsoft\.Insights\/components@2020-02-02/.test(mainBicep)
      && !/smartDetector|DisableSmart/i.test(aiBlock));
  }
  {
    const h = makeHarness(lib, d1);
    h.setProviderRegistrationState('NotRegistered');
    const r = await lib.apply({ slug: SLUG, ...approval() }, h.deps);
    const rgWrites = h.armLog.filter((x) => ['PUT', 'DELETE', 'PATCH'].includes(x.method)
      && /resourcegroups\//i.test(x.path || ''));
    const depWrites = h.armLog.filter((x) => x.method === 'PUT' && /\/deployments\//i.test(x.path || ''));
    const providerPosts = h.armLog.filter((x) => x.method === 'POST'
      && /Microsoft\.AlertsManagement/i.test(x.path || ''));
    ok('apply_refuses_NotRegistered_before_rg_write',
      r.ok === false
      && r.refusedBeforeRgWrite === true
      && (r.errors || []).some((e) => e.code === 'alerts_management_provider_not_registered'
        && /NotRegistered/.test(e.message)
        && e.message.includes(`az provider register --namespace Microsoft.AlertsManagement --subscription ${SUB} --wait`))
      && Array.isArray(r.azureAdminCommands)
      && r.azureAdminCommands[0].includes('az provider register')
      && rgWrites.length === 0 && depWrites.length === 0 && providerPosts.length === 0
      && h.armLog.some((x) => x.method === 'GET'
        && x.path === d1.alertsManagementProviderPath(SUB)),
    JSON.stringify({ errors: r.errors, refused: r.refusedBeforeRgWrite }).slice(0, 320));
  }
  {
    for (const state of ['Registering', 'Unregistered', 'NotRegistered']) {
      const h = makeHarness(lib, d1);
      h.setProviderRegistrationState(state);
      const r = await lib.apply({ slug: SLUG, ...approval() }, h.deps);
      const rgPuts = h.armLog.filter((x) => x.method === 'PUT' && /resourcegroups\//i.test(x.path || '')
        && !/providers\//i.test(x.path || ''));
      ok(`apply_refuses_provider_${state}_no_rg_put`,
        r.ok === false && rgPuts.length === 0
        && (r.errors || []).some((e) => e.code === 'alerts_management_provider_not_registered'),
      JSON.stringify(r.errors || r).slice(0, 180));
    }
  }
  {
    const cases = [
      ['malformed', 200, 'x', 'alerts_management_provider_unreadable'],
      ['http_403', 403, { namespace: 'Microsoft.AlertsManagement', registrationState: 'Registered' },
        'alerts_management_provider_unreadable'],
      ['http_500', 500, {}, 'alerts_management_provider_unreadable'],
      ['wrong_namespace', 200, {
        namespace: 'Microsoft.Insights', registrationState: 'Registered',
        id: `/subscriptions/${SUB}/providers/Microsoft.Insights`,
      }, 'alerts_management_provider_wrong_namespace'],
      ['wrong_sub', 200, {
        namespace: 'Microsoft.AlertsManagement', registrationState: 'Registered',
        id: '/subscriptions/00000000-0000-0000-0000-000000000099/providers/Microsoft.AlertsManagement',
      }, 'alerts_management_provider_wrong_subscription'],
    ];
    for (const [name, status, body, code] of cases) {
      const h = makeHarness(lib, d1);
      h.setProvider(status, body);
      const r = await lib.apply({ slug: SLUG, ...approval() }, h.deps);
      const rgPuts = h.armLog.filter((x) => x.method === 'PUT' && /resourcegroups\//i.test(x.path || '')
        && !/providers\//i.test(x.path || ''));
      ok(`apply_provider_fail_${name}`,
        r.ok === false && r.refusedBeforeRgWrite === true && rgPuts.length === 0
        && (r.errors || []).some((e) => e.code === code
          && /az provider register/.test(e.message || '')),
      JSON.stringify(r.errors || r).slice(0, 200));
    }
  }
  {
    // D2 identity attacks: require exact body.id; refuse before any RG write; no self-register.
    const exactId = `/subscriptions/${SUB}/providers/Microsoft.AlertsManagement`;
    const base = { namespace: 'Microsoft.AlertsManagement', registrationState: 'Registered' };
    const attacks = [
      ['absent_id', { ...base }, 'alerts_management_provider_unreadable'],
      ['null_id', { ...base, id: null }, 'alerts_management_provider_unreadable'],
      ['empty_id', { ...base, id: '' }, 'alerts_management_provider_unreadable'],
      ['non_string_id', { ...base, id: { nested: true } }, 'alerts_management_provider_unreadable'],
      ['query_id', { ...base, id: `${exactId}?api-version=2021-04-01` },
        'alerts_management_provider_unreadable'],
      ['suffix_child_id', { ...base, id: `${exactId}/smartDetectorAlertRules` },
        'alerts_management_provider_unreadable'],
      ['suffix_path_id', { ...base, id: `${exactId}/foo/bar` },
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
      const h = makeHarness(lib, d1);
      h.setProvider(200, body);
      const r = await lib.apply({ slug: SLUG, ...approval() }, h.deps);
      const rgWrites = h.armLog.filter((x) => ['PUT', 'DELETE', 'PATCH'].includes(x.method)
        && /resourcegroups\//i.test(x.path || ''));
      const depWrites = h.armLog.filter((x) => x.method === 'PUT' && /\/deployments\//i.test(x.path || ''));
      const providerPosts = h.armLog.filter((x) => x.method === 'POST'
        && /Microsoft\.AlertsManagement/i.test(x.path || ''));
      ok(`apply_provider_id_attack_${name}_zero_rg_writes`,
        r.ok === false
        && r.refusedBeforeRgWrite === true
        && (r.errors || []).some((e) => e.code === code
          && /az provider register/.test(e.message || ''))
        && rgWrites.length === 0
        && depWrites.length === 0
        && providerPosts.length === 0
        && !h.armLog.some((x) => x.method === 'PUT' && /resourcegroups\//i.test(x.path || '')
          && !/providers\//i.test(x.path || '')),
      JSON.stringify({
        errors: r.errors, refused: r.refusedBeforeRgWrite, rg: rgWrites.length,
      }).slice(0, 280));
    }
  }
  {
    const h = makeHarness(lib, d1);
    h.setProviderRegistrationState('Registered');
    const names = d1.deriveNames(SLUG, SUB);
    h.seedRoles(names);
    h.setApp(runtimeAppBody(names));
    const r = await lib.apply({ slug: SLUG, ...approval() }, h.deps);
    ok('apply_provider_Registered_succeeds',
      r.ok === true
      && h.armLog.some((x) => x.method === 'PUT' && /resourcegroups\//i.test(x.path || '')),
    JSON.stringify(r.errors || { ok: r.ok }).slice(0, 200));
  }
  {
    // prepare-spec remains read-only but exposes explicit register + readback first.
    const h = makeHarness(lib, d1);
    const spec = await lib.prepareSpec({ slug: SLUG, ...approval() }, h.deps);
    const cmds = d1.buildAlertsManagementAdminCommands(SUB);
    ok('prepare_spec_exposes_provider_admin_prereq_readonly',
      spec.ok === true && spec.readOnly === true
      && Array.isArray(spec.azureAdminCommands)
      && spec.azureAdminCommands[0] === cmds[0]
      && spec.azureAdminCommands[1] === cmds[1]
      && /az group create/.test(spec.azureAdminCommands[2] || '')
      && spec.providerPrerequisites
      && spec.providerPrerequisites.namespace === 'Microsoft.AlertsManagement'
      && spec.providerPrerequisites.requiredRegistrationState === 'Registered'
      && spec.providerPrerequisites.registerCommand === cmds[0]
      && spec.providerPrerequisites.readbackCommand === cmds[1]
      && !h.armLog.some((x) => ['PUT', 'POST', 'DELETE', 'PATCH'].includes(x.method))
      && !h.armLog.some((x) => /Microsoft\.AlertsManagement\/register/i.test(x.path || ''))
      && !spec.neverGrant.some((g) => !/subscription/i.test(g)),
    JSON.stringify({
      ok: spec.ok, cmds: (spec.azureAdminCommands || []).slice(0, 2), prep: spec.providerPrerequisites,
    }).slice(0, 280));
    // Apply path source never self-registers.
    const d2src = fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8');
    ok('apply_never_self_registers_provider',
      /assertAlertsManagementProviderRegistered/.test(d2src)
      && !/provider register --namespace Microsoft\.AlertsManagement/.test(
        (d2src.match(/async function apply[\s\S]*?\nasync function /) || [''])[0],
      )
      && !/\/providers\/Microsoft\.AlertsManagement\/register/i.test(d2src));
  }

  {
    const h = makeHarness(lib, d1);
    h.setPutFailPath('messi-2d2-infra');
    const r = await lib.apply({ slug: SLUG, ...approval() }, h.deps);
    ok('signal_receipt_preserves_rg', r.ok === false && r.preservedResourceGroup === true
      && lib.readReceipt(h.deps, SLUG) && lib.readReceipt(h.deps, SLUG).preservedResourceGroup === true);
  }

  {
    const h = makeHarness(lib, d1);
    const forged = {
      schemaVersion: 1, tenantSlug: SLUG, planDigest: 'f'.repeat(64), deploySha: SHA,
      resourceGroupName: RG, kind: 'diagnostic_receipt_not_authority',
    };
    fs.mkdirSync(h.stateDir, { recursive: true });
    fs.writeFileSync(path.join(h.stateDir, `${SLUG}.receipt.json`), JSON.stringify(forged));
    const authPreview = await lib.deriveD1Authority({ slug: SLUG }, h.deps);
    const tags = drillOwned(authPreview.planDigest);
    h.setRg({ name: RG, tags, properties: { provisioningState: 'Succeeded' } });
    h.seedFoundation(tags);
    const rb = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
    ok('forged_state_ignored_rollback', rb.ok === true && rb.deleted === true && rb.phase === 'foundation'
      && authPreview.planDigest !== forged.planDigest);
  }

  {
    const h = makeHarness(lib, d1);
    h.setRg({
      name: RG,
      tags: {
        tenant: SLUG, stage: 'saas-2d2-staging', owner: 'other-owner',
        planDigest: 'a'.repeat(64), deploySha: SHA, temporaryDrill: 'true',
        createdAt: CREATED, expiresAt: EXPIRES,
      },
    });
    const rb = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
    ok('takeover_refused', rb.ok === false
      && (rb.errors || []).some((e) => /tag_mismatch|takeover|rollback_tag/i.test(e.code || '')));
  }

  {
    const h = makeHarness(lib, d1);
    const authPreview = await lib.deriveD1Authority({ slug: SLUG }, h.deps);
    const tags = drillOwned(authPreview.planDigest);
    h.setRg({ name: RG, tags });
    h.seedFoundation(tags);
    h.setResources([
      ...h.deps.d1.buildExpectedResourceContract(d1.deriveNames(SLUG, SUB), { principalId: PID })
        .foundationTopLevel.slice(0, 3).map((r) => ({
          id: r.id, name: r.name, type: r.type, tags, provisioningState: 'Succeeded',
        })),
      {
        id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/rogue`,
        name: 'rogue', type: 'Microsoft.Storage/storageAccounts', tags: {}, provisioningState: 'Succeeded',
      },
    ]);
    const foreign = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
    ok('inventory_any_finding_refused', foreign.ok === false
      && (foreign.errors || []).some((e) => e.code === 'inventory_findings')
      && (foreign.findings || []).length >= 1);
    h.setDeleteEtagRace(true);
    h.seedFoundation(tags);
    const race = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
    ok('etag_race_refused', race.ok === false && (race.errors || []).some((e) => e.code === 'etag_race'));
  }

  // Live ARM RG GET returns 200 with no ETag — rollback must delete without If-Match
  // after full ownership/provenance/inventory checks; wrong tags still refuse with zero DELETE.
  {
    const authPreview = await lib.deriveD1Authority({ slug: SLUG }, makeHarness(lib, d1).deps);
    const tags = drillOwned(authPreview.planDigest);
    const h = makeHarness(lib, d1);
    h.setRg({ name: RG, tags });
    h.seedFoundation(tags);
    h.setEtag(null);
    const rb = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
    const del = h.armLog.find((x) => x.method === 'DELETE'
      && /resourcegroups\/[^/?]+(\?|$)/i.test(x.path || '')
      && !/providers\//i.test((x.path || '').split('resourcegroups/')[1] || ''));
    const ifMatch = del && del.headers && (del.headers['If-Match'] || del.headers['if-match']);
    ok('rollback_no_rg_etag_omits_if_match', rb.ok === true && rb.deleted === true && rb.phase === 'foundation'
      && !!del && !ifMatch, rb.ok ? `ifMatch=${ifMatch}` : JSON.stringify(rb.errors || rb).slice(0, 400));

    const bad = makeHarness(lib, d1);
    bad.setRg({
      name: RG,
      tags: { ...tags, owner: 'other-owner' },
    });
    bad.setEtag(null);
    const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, bad.deps);
    const badDel = bad.armLog.filter((x) => x.method === 'DELETE');
    ok('rollback_no_rg_etag_still_enforces_ownership', refuse.ok === false
      && (refuse.errors || []).some((e) => /tag_mismatch|takeover|rollback_tag/i.test(e.code || ''))
      && badDel.length === 0);

    const withEtag = makeHarness(lib, d1);
    withEtag.setRg({ name: RG, tags });
    withEtag.seedFoundation(tags);
    withEtag.setEtag('"live-etag"');
    const okRb = await lib.rollback({ slug: SLUG, confirmDelete: RG }, withEtag.deps);
    const delMatch = withEtag.armLog.find((x) => x.method === 'DELETE'
      && /resourcegroups\/[^/?]+(\?|$)/i.test(x.path || '')
      && !/providers\//i.test((x.path || '').split('resourcegroups/')[1] || ''));
    ok('rollback_with_rg_etag_sends_if_match', okRb.ok === true && okRb.deleted === true
      && delMatch && delMatch.headers && delMatch.headers['If-Match'] === '"live-etag"');
  }

  {
    const h = makeHarness(lib, d1);
    const tags = drillOwned((await lib.deriveD1Authority({ slug: SLUG }, h.deps)).planDigest);
    const c = h.seedFoundation(tags); h.setRg({ name: RG, tags });
    const top = (t, ps) => ({ id: t.id, name: t.name, type: t.type, tags, provisioningState: ps || 'Succeeded' });
    const refuse = async (setup) => { setup(); return lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps); };
    const cases = [
      await refuse(() => h.setResources(c.foundationTopLevel.slice(0, 2).map((r) => top(r)))),
      await refuse(() => { h.seedFoundation({ ...tags, owner: 'wrong' }); h.setRg({ name: RG, tags }); }),
      await refuse(() => {
        h.seedFoundation(tags); h.setRg({ name: RG, tags });
        const tops = c.foundationTopLevel.map((r) => top(r));
        h.setResources([...tops, { ...tops[0], id: `${tops[0].id}-dup` }]);
      }),
      await refuse(() => {
        h.seedFoundation(tags); h.setRg({ name: RG, tags });
        h.setResources(c.foundationTopLevel.map((r, i) => top(r, i === 0 ? 'Updating' : 'Succeeded')));
      }),
      await refuse(() => { h.seedFoundation(tags); h.setRg({ name: RG, tags }); h.setRoles({}); }),
      await refuse(() => {
        h.seedFoundation(tags); h.setRg({ name: RG, tags });
        h.setSecrets(c.runtimeSecrets.slice(0, 1).map((s) => ({ id: s.id, name: s.name, tags })));
      }),
    ];
    ok('inventory_partial_tag_dup_prov_role_secret_refuse', cases.every((r) => !r.ok
      && (r.errors || []).some((e) => e.code === 'inventory_findings' || e.code === 'rollback_tag_mismatch')));
  }

  {
    const tags = drillOwned((await lib.deriveD1Authority({ slug: SLUG }, makeHarness(lib, d1).deps)).planDigest);
    const runPhase = async (setup) => {
      const hx = makeHarness(lib, d1); hx.setRg({ name: RG, tags }); setup(hx);
      return lib.rollback({ slug: SLUG, confirmDelete: RG }, hx.deps);
    };
    const phases = [
      { name: 'foundation', r: await runPhase((hx) => hx.seedFoundation(tags)) },
      { name: 'bootstrap-active', r: await runPhase((hx) => {
        const c = hx.seedFoundation(tags);
        hx.setJob({
          id: c.bootstrapJob.id, name: c.bootstrapJob.name, type: c.bootstrapJob.type,
          tags: bootstrapJobOwnedTags(tags),
        });
      }) },
      { name: 'runtime-prereqs', r: await runPhase((hx) => {
        const c = hx.seedFoundation(tags);
        hx.setSecrets(c.runtimeSecrets.map((s) => ({ id: s.id, name: s.name, tags })));
      }) },
      { name: 'runtime', r: await runPhase((hx) => {
        const c = hx.seedFoundation(tags);
        hx.setSecrets(c.runtimeSecrets.map((s) => ({ id: s.id, name: s.name, tags })));
        hx.setApp({
          id: c.runtimeApp.id, name: c.runtimeApp.name, type: c.runtimeApp.type, tags,
          properties: { provisioningState: 'Succeeded' },
        });
      }) },
    ];
    ok('legitimate_phases_compile_accept', phases.every((p) => p.r.ok && p.r.deleted && p.r.phase === p.name));
  }

  // Live residual: RG stage saas-2d2-staging; plan-owned bootstrap Job carries Bicep stage saas-2c2
  // (luna-messiproof-63aa6df2). Rollback must accept that exact owned bootstrap-active residual and
  // refuse missing/wrong job tags, foreign id/type/name, lookalikes, and extra resources.
  {
    const authPreview = await lib.deriveD1Authority({ slug: SLUG }, makeHarness(lib, d1).deps);
    const tags = drillOwned(authPreview.planDigest);
    const jobTags = bootstrapJobOwnedTags(tags);
    const names = d1.deriveNames(SLUG, SUB);
    const allDeletes = (hx) => hx.armLog.filter((x) => x.method === 'DELETE');
    const seedBootstrapActive = (hx, jobBody) => {
      const c = hx.seedFoundation(tags);
      hx.setRg({ name: RG, tags });
      hx.setJob(jobBody || {
        id: c.bootstrapJob.id, name: c.bootstrapJob.name, type: c.bootstrapJob.type, tags: jobTags,
      });
      return c;
    };
    {
      const h = makeHarness(lib, d1);
      const c = seedBootstrapActive(h);
      ok('live_bootstrap_job_name_is_messiproof_owner',
        c.bootstrapJob.name === 'luna-messiproof-63aa6df2'
        && names.bootstrapJobName === 'luna-messiproof-63aa6df2');
      const rb = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('rollback_bootstrap_active_live_saas_2c2_job_accepted', rb.ok === true && rb.deleted === true
        && rb.phase === 'bootstrap-active',
      rb.ok ? `phase=${rb.phase}` : JSON.stringify(rb.errors || rb.findings || rb).slice(0, 400));
    }
    const refuseAttack = async (label, mutate) => {
      const h = makeHarness(lib, d1);
      const c = seedBootstrapActive(h);
      mutate(h, c);
      const rb = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      const refused = rb.ok === false && allDeletes(h).length === 0
        && (rb.errors || []).some((e) => e.code === 'inventory_findings'
          || e.code === 'rollback_phase_invalid' || e.code === 'rollback_tag_mismatch');
      ok(`rollback_bootstrap_job_attack_${label}_refused`, refused,
        JSON.stringify(rb.errors || rb.findings || rb).slice(0, 320));
      return refused;
    };
    await refuseAttack('rg_stage_on_job', (h, c) => {
      h.setJob({ id: c.bootstrapJob.id, name: c.bootstrapJob.name, type: c.bootstrapJob.type, tags });
    });
    await refuseAttack('wrong_job_stage', (h, c) => {
      h.setJob({
        id: c.bootstrapJob.id, name: c.bootstrapJob.name, type: c.bootstrapJob.type,
        tags: { ...jobTags, stage: 'saas-2c3' },
      });
    });
    await refuseAttack('missing_job_tags', (h, c) => {
      h.setJob({ id: c.bootstrapJob.id, name: c.bootstrapJob.name, type: c.bootstrapJob.type, tags: {} });
    });
    await refuseAttack('wrong_tenant', (h, c) => {
      h.setJob({
        id: c.bootstrapJob.id, name: c.bootstrapJob.name, type: c.bootstrapJob.type,
        tags: { ...jobTags, tenant: 'other-tenant' },
      });
    });
    await refuseAttack('wrong_owner', (h, c) => {
      h.setJob({
        id: c.bootstrapJob.id, name: c.bootstrapJob.name, type: c.bootstrapJob.type,
        tags: { ...jobTags, owner: 'other-owner' },
      });
    });
    await refuseAttack('wrong_plan_digest', (h, c) => {
      h.setJob({
        id: c.bootstrapJob.id, name: c.bootstrapJob.name, type: c.bootstrapJob.type,
        tags: { ...jobTags, planDigest: 'f'.repeat(64) },
      });
    });
    await refuseAttack('foreign_job_id', (h, c) => {
      h.setJob({
        id: `${c.bootstrapJob.id}-foreign`, name: c.bootstrapJob.name, type: c.bootstrapJob.type,
        tags: jobTags,
      });
    });
    await refuseAttack('foreign_job_type', (h, c) => {
      h.setJob({
        id: c.bootstrapJob.id, name: c.bootstrapJob.name, type: 'Microsoft.App/containerApps',
        tags: jobTags,
      });
    });
    await refuseAttack('lookalike_job_name', (h, c) => {
      h.setJob({
        id: c.bootstrapJob.id, name: `${c.bootstrapJob.name}x`, type: c.bootstrapJob.type,
        tags: jobTags,
      });
    });
    await refuseAttack('extra_resource', (h, c) => {
      h.setJob({
        id: c.bootstrapJob.id, name: c.bootstrapJob.name, type: c.bootstrapJob.type, tags: jobTags,
      });
      h.setResources(c.foundationTopLevel.map((r) => ({
        id: r.id, name: r.name, type: r.type, tags, provisioningState: 'Succeeded',
      })).concat([{
        id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/rogue`,
        name: 'rogueacct', type: 'Microsoft.Storage/storageAccounts', tags: {},
        provisioningState: 'Succeeded',
      }]));
    });
  }

  // In-process apply→rollbackOnFailure must re-enter under the apply-held lock (same PID),
  // not refuse with lock_busy "lock held by current pid".
  {
    const authPreview = await lib.deriveD1Authority({ slug: SLUG }, makeHarness(lib, d1).deps);
    const tags = drillOwned(authPreview.planDigest);
    const h = makeHarness(lib, d1);
    const c = h.seedFoundation(tags);
    h.setRg({ name: RG, tags });
    h.setJob({
      id: c.bootstrapJob.id, name: c.bootstrapJob.name, type: c.bootstrapJob.type,
      tags: bootstrapJobOwnedTags(tags),
    });
    const held = lib.acquireExclusiveLock(h.deps, SLUG);
    ok('nested_failure_lock_acquired', held.ok === true);
    const rb = await lib.rollback({
      slug: SLUG, confirmDelete: RG, _internalFailureRollback: true,
    }, h.deps);
    ok('nested_failure_rollback_own_pid_lock_accepted', rb.ok === true && rb.deleted === true
      && rb.phase === 'bootstrap-active'
      && !(rb.errors || []).some((e) => e.code === 'lock_busy' || e.code === 'lock_live'),
    rb.ok ? `phase=${rb.phase}` : JSON.stringify(rb.errors || rb).slice(0, 360));
    if (held && held.release) held.release();
  }

  // Owned exact-tag empty RG (apply failed before foundation / no KV): allow delete only via
  // narrow empty phase with independent zero Microsoft.Resources/deployments LIST.
  // Absent vault must not arm_list_failed on secrets LIST. Unowned, wrong tags, any
  // deployment history, LIST failure, or nonzero/unexpected inventory remain refused.
  {
    const wrapAbsentKvSecrets404 = (hx) => {
      const real = hx.deps.armRequest;
      hx.deps.armRequest = async (req) => {
        const p = req.path || '';
        if (/KeyVault\/vaults\/[^/]+\/secrets(\?|$)/i.test(p) && !/\/secrets\/[^/?]+(\?|$)/i.test(p)) {
          return { status: 404, body: { error: { code: 'ResourceNotFound' } }, headers: {} };
        }
        return real(req);
      };
      return hx;
    };
    const rgDeleteCount = (hx) => hx.armLog.filter((x) => x.method === 'DELETE'
      && /resourcegroups\/[^/?]+(\?|$)/i.test(x.path || '')
      && !/providers\//i.test((x.path || '').split('resourcegroups/')[1] || '')).length;
    const authPreview = await lib.deriveD1Authority({ slug: SLUG }, makeHarness(lib, d1).deps);
    const tags = drillOwned(authPreview.planDigest);
    const hEmpty = wrapAbsentKvSecrets404(makeHarness(lib, d1));
    hEmpty.setRg({ name: RG, tags });
    hEmpty.setResources([]);
    hEmpty.setDeploymentsList([]);
    hEmpty.setNested({});
    hEmpty.setSecrets([]);
    hEmpty.setMi(null);
    const emptyRb = await lib.rollback({ slug: SLUG, confirmDelete: RG }, hEmpty.deps);
    const emptyDel = hEmpty.armLog.find((x) => x.method === 'DELETE'
      && /resourcegroups\/[^/?]+(\?|$)/i.test(x.path || '')
      && !/providers\//i.test((x.path || '').split('resourcegroups/')[1] || ''));
    const secretListCalls = hEmpty.armLog.filter((x) => /KeyVault\/vaults\/[^/]+\/secrets(\?|$)/i.test(x.path || '')
      && !/\/secrets\/[^/?]+(\?|$)/i.test(x.path || ''));
    const depListCalls = hEmpty.armLog.filter((x) => /\/providers\/Microsoft\.Resources\/deployments(\?|$)/i.test(x.path || ''));
    ok('rollback_owned_empty_rg_safe_empty_phase', emptyRb.ok === true && emptyRb.deleted === true
      && emptyRb.phase === 'empty' && !!emptyDel && secretListCalls.length === 0
      && depListCalls.length >= 1
      && depListCalls.every((c) => (c.path || '').includes(`api-version=${d1.DEP_API}`))
      && emptyRb.acrTempRoleAbsent === true
      && lib.LEGITIMATE_PHASES.includes('empty'),
    emptyRb.ok
      ? `phase=${emptyRb.phase} secretList=${secretListCalls.length} depList=${depListCalls.length}`
      : JSON.stringify(emptyRb.errors || emptyRb).slice(0, 400));

    const hWrongOwner = wrapAbsentKvSecrets404(makeHarness(lib, d1));
    hWrongOwner.setRg({ name: RG, tags: { ...tags, owner: 'other-owner' } });
    hWrongOwner.setResources([]);
    hWrongOwner.setDeploymentsList([]);
    const refuseOwner = await lib.rollback({ slug: SLUG, confirmDelete: RG }, hWrongOwner.deps);
    ok('rollback_empty_unowned_refused', refuseOwner.ok === false
      && (refuseOwner.errors || []).some((e) => /tag_mismatch|takeover|rollback_tag/i.test(e.code || ''))
      && hWrongOwner.armLog.filter((x) => x.method === 'DELETE').length === 0);

    const hWrongTag = wrapAbsentKvSecrets404(makeHarness(lib, d1));
    hWrongTag.setRg({ name: RG, tags: { ...tags, stage: 'wrong-stage' } });
    hWrongTag.setResources([]);
    hWrongTag.setDeploymentsList([]);
    const refuseTag = await lib.rollback({ slug: SLUG, confirmDelete: RG }, hWrongTag.deps);
    ok('rollback_empty_wrong_tags_refused', refuseTag.ok === false
      && (refuseTag.errors || []).some((e) => /tag_mismatch|takeover|rollback_tag/i.test(e.code || ''))
      && hWrongTag.armLog.filter((x) => x.method === 'DELETE').length === 0);

    // Failed deployment history via LIST (resources still empty) refuses RG DELETE.
    const hDeployFailed = wrapAbsentKvSecrets404(makeHarness(lib, d1));
    hDeployFailed.setRg({ name: RG, tags });
    hDeployFailed.setResources([]);
    hDeployFailed.setDeploymentsList([{
      id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Resources/deployments/leftover-failed`,
      name: 'leftover-failed', type: 'Microsoft.Resources/deployments',
      properties: { provisioningState: 'Failed' },
    }]);
    const refuseDeployFailed = await lib.rollback({ slug: SLUG, confirmDelete: RG }, hDeployFailed.deps);
    ok('rollback_empty_with_failed_deployment_refused', refuseDeployFailed.ok === false
      && (refuseDeployFailed.errors || []).some((e) => e.code === 'inventory_findings'
        || e.code === 'rollback_phase_invalid')
      && rgDeleteCount(hDeployFailed) === 0,
    JSON.stringify(refuseDeployFailed.errors || refuseDeployFailed).slice(0, 280));

    // Succeeded deployment history also refuses empty-phase RG DELETE.
    const hDeployOk = wrapAbsentKvSecrets404(makeHarness(lib, d1));
    hDeployOk.setRg({ name: RG, tags });
    hDeployOk.setResources([]);
    hDeployOk.setDeploymentsList([{
      id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Resources/deployments/leftover-ok`,
      name: 'leftover-ok', type: 'Microsoft.Resources/deployments',
      properties: { provisioningState: 'Succeeded' },
    }]);
    const refuseDeployOk = await lib.rollback({ slug: SLUG, confirmDelete: RG }, hDeployOk.deps);
    ok('rollback_empty_with_succeeded_deployment_refused', refuseDeployOk.ok === false
      && (refuseDeployOk.errors || []).some((e) => e.code === 'inventory_findings'
        || e.code === 'rollback_phase_invalid')
      && rgDeleteCount(hDeployOk) === 0,
    JSON.stringify(refuseDeployOk.errors || refuseDeployOk).slice(0, 280));

    // Deployment LIST failure (403) refuses empty-phase deletion.
    const hDepListFail = wrapAbsentKvSecrets404(makeHarness(lib, d1));
    hDepListFail.setRg({ name: RG, tags });
    hDepListFail.setResources([]);
    hDepListFail.setDeploymentListStatus(403);
    const refuseDepList = await lib.rollback({ slug: SLUG, confirmDelete: RG }, hDepListFail.deps);
    ok('rollback_empty_deployment_list_failure_refused', refuseDepList.ok === false
      && (refuseDepList.errors || []).some((e) => e.code === 'arm_list_failed')
      && rgDeleteCount(hDepListFail) === 0,
    JSON.stringify(refuseDepList.errors || refuseDepList).slice(0, 280));

    const hRogue = wrapAbsentKvSecrets404(makeHarness(lib, d1));
    hRogue.setRg({ name: RG, tags });
    hRogue.setResources([{
      id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/rogue`,
      name: 'rogue', type: 'Microsoft.Storage/storageAccounts', tags: {}, provisioningState: 'Succeeded',
    }]);
    hRogue.setDeploymentsList([]);
    const refuseRogue = await lib.rollback({ slug: SLUG, confirmDelete: RG }, hRogue.deps);
    ok('rollback_empty_with_unexpected_refused', refuseRogue.ok === false
      && (refuseRogue.errors || []).some((e) => e.code === 'inventory_findings')
      && (refuseRogue.findings || []).some((f) => f.code === 'unexpected_resource')
      && rgDeleteCount(hRogue) === 0);

    const hPartial = wrapAbsentKvSecrets404(makeHarness(lib, d1));
    hPartial.setRg({ name: RG, tags });
    const cPartial = d1.buildExpectedResourceContract(d1.deriveNames(SLUG, SUB), { principalId: PID });
    hPartial.setResources(cPartial.foundationTopLevel.slice(0, 2).map((r) => ({
      id: r.id, name: r.name, type: r.type, tags, provisioningState: 'Succeeded',
    })));
    hPartial.setDeploymentsList([]);
    const refusePartial = await lib.rollback({ slug: SLUG, confirmDelete: RG }, hPartial.deps);
    ok('rollback_partial_nonzero_inventory_refused', refusePartial.ok === false
      && (refusePartial.errors || []).some((e) => e.code === 'inventory_findings')
      && rgDeleteCount(hPartial) === 0);
  }

  // Interrupted infra apply (partial foundation + plan-owned deployment history):
  // fail-closed subset of rederived contract may roll back via entire RG DELETE + temp ACR role only.
  // Unexpected resource, foreign deployment, malformed inventory, wrong tags refuse with zero deletes.
  // Receipt is never authority. Stale PID lock recovers only after dead-PID + no-competitor proof.
  // Failure-Anomalies admitted only via strict platform SHOW signature + exact AI in inventory.
  // Live SHOW: parameters/outputResources/validatedResources null; dependencies []. No receipt trust.
  {
    const allDeletes = (hx) => hx.armLog.filter((x) => x.method === 'DELETE');
    const authPreview = await lib.deriveD1Authority({ slug: SLUG }, makeHarness(lib, d1).deps);
    const tags = drillOwned(authPreview.planDigest);
    const names = d1.deriveNames(SLUG, SUB);
    const contract = d1.buildExpectedResourceContract(names, { principalId: PID });
    const ownedDeps = typeof d1.buildOwnedDeploymentNames === 'function'
      ? d1.buildOwnedDeploymentNames(names)
      : (contract.ownedDeploymentNames || []);
    const depId = (name) => `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Resources/deployments/${name}`;
    const ownedDepRows = ['messi-2d2-infra', names.acrPullModuleName, 'privateNetwork']
      .map((name) => ({
        id: depId(name), name, type: 'Microsoft.Resources/deployments',
        properties: { provisioningState: name === 'messi-2d2-infra' ? 'Failed' : 'Succeeded' },
      }));
    const aiExp = contract.foundationTopLevel.find((e) => e.type === 'Microsoft.Insights/components');
    const liveFix = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/messi-saas-stage2d2/infra-partial-live-crash.json'), 'utf8'));
    const faProps = liveFix.deployments[3].properties;
    const faName = liveFix.deployments[3].name;
    const faRow = {
      id: depId(faName), name: faName, type: 'Microsoft.Resources/deployments',
      provisioningState: 'Failed', properties: faProps,
    };
    const liveFourDeps = liveFix.deployments.map((d) => ({
      id: depId(d.name), name: d.name, type: d.type || 'Microsoft.Resources/deployments',
      provisioningState: d.provisioningState || (d.properties && d.properties.provisioningState) || 'Succeeded',
      properties: d.properties || { provisioningState: d.provisioningState || 'Succeeded' },
    }));
    const subset = contract.foundationTopLevel.slice(0, 6).map((r) => ({
      id: r.id, name: r.name, type: r.type, tags, provisioningState: 'Succeeded',
    }));
    const liveTopNames = new Set(liveFix.topLevelResourceNames);
    const liveSubset = contract.foundationTopLevel
      .filter((r) => liveTopNames.has(r.name))
      .map((r) => ({ id: r.id, name: r.name, type: r.type, tags, provisioningState: 'Succeeded' }));
    const dnsLink = contract.nestedChildren.find((n) => n.type.includes('virtualNetworkLinks'));
    const liveNested = dnsLink
      ? { [dnsLink.id]: { id: dnsLink.id, name: dnsLink.name, type: dnsLink.type, tags } } : {};
    const faScope = { subscriptionId: SUB, resourceGroupName: RG };
    const faProv = (patch, extra) => ({
      namespace: faProps.providers[0].namespace,
      resourceTypes: [{
        resourceType: faProps.providers[0].resourceTypes[0].resourceType,
        locations: [faProps.providers[0].resourceTypes[0].locations[0]],
        ...extra,
      }],
      ...patch,
    });
    const faMut = (propsPatch, rowPatch = {}) => ({
      ...faRow, ...rowPatch,
      properties: propsPatch === null ? null
        : { ...JSON.parse(JSON.stringify(faProps)), ...propsPatch },
    });
    const isFaGet = (p) => /Failure-Anomalies-Alert-Rule-Deployment-ea8f51b8/i.test(p)
      && /\/deployments\/[^/?]+/i.test(p) && !/deployments(\?|$)/i.test(String(p).split('?')[0]);

    {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources(subset); h.setNested({}); h.setSecrets([]); h.setRoles({});
      h.setDeploymentsList(ownedDepRows);
      fs.mkdirSync(h.stateDir, { recursive: true });
      fs.writeFileSync(path.join(h.stateDir, `${SLUG}.receipt.json`), JSON.stringify({
        schemaVersion: 1, kind: 'diagnostic_receipt_not_authority', status: 'apply_failed',
        tenantSlug: SLUG, planDigest: 'f'.repeat(64), deploySha: 'a'.repeat(40),
        phase: 'runtime', resourceGroupName: RG,
      }));
      const rb = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      const del = h.armLog.find((x) => x.method === 'DELETE'
        && /resourcegroups\/[^/?]+(\?|$)/i.test(x.path || '')
        && !/providers\//i.test((x.path || '').split('resourcegroups/')[1] || ''));
      ok('rollback_infra_partial_owned_subset_accepted', rb.ok === true && rb.deleted === true
        && rb.phase === 'infra-partial' && !!del && rb.acrTempRoleAbsent === true
        && lib.LEGITIMATE_PHASES.includes('infra-partial') && ownedDeps.length >= 3
        && ownedDeps.includes('messi-2d2-infra') && ownedDeps.includes(names.acrPullModuleName)
        && ownedDeps.includes('privateNetwork') && !ownedDeps.some((n) => /Failure-Anomalies/i.test(n)),
      rb.ok ? `phase=${rb.phase} owned=${ownedDeps.join(',')}` : JSON.stringify(rb.errors || rb).slice(0, 500));
      ok('rollback_infra_partial_stale_receipt_not_authority', rb.ok === true
        && rb.phase === 'infra-partial' && authPreview.planDigest !== 'f'.repeat(64));
    }

    // RED: live Azure SHOW has params=null; legacy ScopeResourceId-only and sparse LIST lack signature.
    {
      const legacy = faMut({
        templateHash: undefined, providers: undefined,
        parameters: { ScopeResourceId: { value: aiExp.id } },
      });
      delete legacy.properties.templateHash; delete legacy.properties.providers;
      const sparse = faMut({
        templateHash: undefined, providers: undefined,
        parameters: null, dependencies: [], outputResources: null, validatedResources: null,
      });
      delete sparse.properties.templateHash; delete sparse.properties.providers;
      ok('failure_anomalies_live_shaped_without_signature_refused',
        d1.failureAnomaliesMatchesPlatformSignature(legacy) === false
        && d1.isExactOwnedFailureAnomaliesDeployment(legacy, faScope, aiExp, liveSubset) === false
        && d1.failureAnomaliesMatchesPlatformSignature(sparse) === false
        && d1.isExactOwnedFailureAnomaliesDeployment(sparse, faScope, aiExp, liveSubset) === false
        && faProps.parameters === null && faProps.outputResources === null
        && faProps.validatedResources === null
        && Array.isArray(faProps.dependencies) && faProps.dependencies.length === 0);
    }

    // RED: exact captured nested error shape must be required — flat top-level MissingSubscriptionRegistration
    // (pre-correction wrong level) and each nested-shape attack refuse helper + collect/phase.
    {
      const liveErr = faProps.error;
      const liveDetail = liveErr && Array.isArray(liveErr.details) ? liveErr.details[0] : null;
      ok('failure_anomalies_fixture_nested_error_shape',
        liveErr && String(liveErr.code) === 'DeploymentFailed'
        && Array.isArray(liveErr.details) && liveErr.details.length === 1
        && liveDetail && String(liveDetail.code) === 'MissingSubscriptionRegistration'
        && liveDetail.target === null
        && !Object.prototype.hasOwnProperty.call(liveDetail, 'details')
        && d1.FAILURE_ANOMALIES_TOP_ERROR_CODE === 'DeploymentFailed'
        && d1.FAILURE_ANOMALIES_ERROR_CODE === 'MissingSubscriptionRegistration');

      const flatTopOnly = faMut({
        error: {
          code: 'MissingSubscriptionRegistration',
          message: 'The subscription is not registered to use namespace \'Microsoft.AlertsManagement\'.',
        },
      });
      const topCodeChanged = faMut({
        error: {
          code: liveFix.attacks.wrongTopErrorCode || liveFix.attacks.wrongErrorCode,
          details: [{ code: 'MissingSubscriptionRegistration', target: null }],
        },
      });
      const zeroDetails = faMut({
        error: { code: 'DeploymentFailed', details: [] },
      });
      const multiDetails = faMut({
        error: {
          code: 'DeploymentFailed',
          details: [
            { code: 'MissingSubscriptionRegistration', target: null },
            { code: 'MissingSubscriptionRegistration', target: null },
          ],
        },
      });
      const wrongDetailCode = faMut({
        error: {
          code: 'DeploymentFailed',
          details: [{
            code: liveFix.attacks.wrongDetailErrorCode || liveFix.attacks.wrongErrorCode,
            target: null,
          }],
        },
      });
      const nestedChildren = faMut({
        error: {
          code: 'DeploymentFailed',
          details: [{
            code: 'MissingSubscriptionRegistration',
            target: null,
            details: [{ code: 'NestedChild', target: null }],
          }],
        },
      });
      const malformedError = faMut({ error: ['not-an-object'] });
      // REST omits null-materialized target (not an attack) — see rest_omitted GREEN below.
      const nonNullTarget = faMut({
        error: {
          code: 'DeploymentFailed',
          details: [{ code: 'MissingSubscriptionRegistration', target: 'Microsoft.AlertsManagement' }],
        },
      });
      const targetLookalikes = [
        ['detail_target_empty_string', ''],
        ['detail_target_false', false],
        ['detail_target_zero', 0],
        ['detail_target_object', {}],
        ['detail_target_array', []],
        ['detail_target_forged', 'Microsoft.AlertsManagement'],
      ].map(([label, target]) => [label, faMut({
        error: {
          code: 'DeploymentFailed',
          details: [{ code: 'MissingSubscriptionRegistration', target }],
        },
      })]);
      // details/additionalInfo: absent-or-null only. Empty array was a fallthrough bug (Array.isArray+length===0).
      const optionalNullLookalikes = [
        ['detail_details_empty_array', { details: [] }],
        ['detail_details_empty_string', { details: '' }],
        ['detail_details_false', { details: false }],
        ['detail_details_object', { details: {} }],
        ['detail_details_forged', { details: [{ code: 'forged' }] }],
        ['detail_additionalInfo_forged', { additionalInfo: [{ info: 'x' }] }],
        ['detail_additionalInfo_empty_string', { additionalInfo: '' }],
        ['detail_additionalInfo_false', { additionalInfo: false }],
        ['detail_additionalInfo_array', { additionalInfo: [] }],
      ].map(([label, extra]) => [label, faMut({
        error: {
          code: 'DeploymentFailed',
          details: [{ code: 'MissingSubscriptionRegistration', target: null, ...extra }],
        },
      })]);
      const nestedShapeAttacks = [
        ['flat_top_missing_subscription_registration', flatTopOnly],
        ['top_error_code_changed', topCodeChanged],
        ['zero_details', zeroDetails],
        ['multiple_details', multiDetails],
        ['wrong_detail_code', wrongDetailCode],
        ['detail_nested_children', nestedChildren],
        ['malformed_error', malformedError],
        ['non_null_detail_target', nonNullTarget],
        ...targetLookalikes,
        ...optionalNullLookalikes,
      ];
      let nestedRefuse = 0;
      for (const [label, row] of nestedShapeAttacks) {
        const helperRefuse = d1.failureAnomaliesMatchesPlatformSignature(row) === false
          && d1.isExactOwnedFailureAnomaliesDeployment(row, faScope, aiExp, liveSubset) === false;
        const h = makeHarness(lib, d1);
        h.setRg({ name: RG, tags });
        h.setResources(liveSubset); h.setNested(liveNested); h.setSecrets([]); h.setRoles({});
        h.setDeploymentsList([...ownedDepRows, row]);
        const inv = await d1.collectLiveInventory(h.deps, names, tags);
        inv.rgExists = true;
        const phaseRefuse = inv.ok === true
          && d1.inferLivePhase(inv) !== 'infra-partial'
          && d1.isExactInfraPartialLive(inv) === false;
        if (helperRefuse && phaseRefuse) nestedRefuse += 1;
        else {
          ok(`failure_anomalies_nested_error_${label}_refused`, false,
            `helper=${helperRefuse} phase=${d1.inferLivePhase(inv)} invOk=${inv.ok}`);
        }
      }
      ok('failure_anomalies_nested_error_shape_attacks_refused',
        nestedRefuse === nestedShapeAttacks.length,
        `pass=${nestedRefuse}/${nestedShapeAttacks.length}`);
    }

    // RED→GREEN: ARM REST GET omits null-valued detail keys; Azure CLI materializes them as null.
    // Detail keys from live REST are exactly code,message. Current `target !== null` rejects undefined.
    {
      const liveMsg = String((faProps.error.details[0] && faProps.error.details[0].message) || '');
      const restDetail = {
        code: 'MissingSubscriptionRegistration',
        message: liveMsg,
      };
      ok('failure_anomalies_rest_detail_keys_exactly_code_message',
        Object.keys(restDetail).sort().join(',') === 'code,message'
        && !Object.prototype.hasOwnProperty.call(restDetail, 'target')
        && !Object.prototype.hasOwnProperty.call(restDetail, 'details')
        && !Object.prototype.hasOwnProperty.call(restDetail, 'additionalInfo')
        && liveMsg.includes("Microsoft.AlertsManagement"));
      const restRow = faMut({
        error: {
          code: 'DeploymentFailed',
          message: faProps.error.message,
          details: [restDetail],
        },
      });
      const cliNullDetail = {
        code: 'MissingSubscriptionRegistration',
        message: liveMsg,
        target: null,
        details: null,
        additionalInfo: null,
      };
      const cliRow = faMut({
        error: {
          code: 'DeploymentFailed',
          message: faProps.error.message,
          details: [cliNullDetail],
        },
      });
      // GREEN after fix: both CLI-null and REST-omitted must match platform signature + infra-partial.
      ok('failure_anomalies_cli_null_materialized_target_accepted',
        d1.failureAnomaliesMatchesPlatformSignature(cliRow) === true
        && d1.isExactOwnedFailureAnomaliesDeployment(cliRow, faScope, aiExp, liveSubset) === true
        && d1.failureAnomaliesMatchesPlatformSignature(faRow) === true);
      ok('failure_anomalies_rest_omitted_null_keys_helper_accepted',
        d1.failureAnomaliesMatchesPlatformSignature(restRow) === true
        && d1.isExactOwnedFailureAnomaliesDeployment(restRow, faScope, aiExp, liveSubset) === true);
      const hRest = makeHarness(lib, d1);
      hRest.setRg({ name: RG, tags });
      hRest.setResources(liveSubset); hRest.setNested(liveNested); hRest.setSecrets([]); hRest.setRoles({});
      hRest.setDeploymentsList([...ownedDepRows, restRow]);
      const invRest = await d1.collectLiveInventory(hRest.deps, names, tags);
      invRest.rgExists = true;
      ok('failure_anomalies_rest_omitted_collect_infra_partial',
        invRest.ok === true
        && d1.inferLivePhase(invRest) === 'infra-partial'
        && d1.isExactInfraPartialLive(invRest) === true
        && d1.phaseContractFindings(invRest, 'infra-partial').length === 0,
      invRest.ok
        ? `phase=${d1.inferLivePhase(invRest)}`
        : JSON.stringify(invRest.errors || invRest).slice(0, 400));
      const hCli = makeHarness(lib, d1);
      hCli.setRg({ name: RG, tags });
      hCli.setResources(liveSubset); hCli.setNested(liveNested); hCli.setSecrets([]); hCli.setRoles({});
      hCli.setDeploymentsList([...ownedDepRows, cliRow]);
      const invCli = await d1.collectLiveInventory(hCli.deps, names, tags);
      invCli.rgExists = true;
      ok('failure_anomalies_cli_null_collect_infra_partial',
        invCli.ok === true
        && d1.inferLivePhase(invCli) === 'infra-partial'
        && d1.isExactInfraPartialLive(invCli) === true);
    }

    // GREEN: collectLiveInventory GET readback + phase inference + rollback (not helper-only).
    // Requires exact nested error shape (DeploymentFailed + one MissingSubscriptionRegistration detail).
    {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources(liveSubset); h.setNested(liveNested); h.setSecrets([]); h.setRoles({});
      h.setDeploymentsList(liveFourDeps);
      const inv = await d1.collectLiveInventory(h.deps, names, tags);
      inv.rgExists = true;
      const faLive = (inv.deployments || []).find((d) => d.name === faName);
      const getCalls = h.armLog.filter((x) => x.method === 'GET' && isFaGet(x.path || ''));
      const liveErr = (faLive && faLive.properties && faLive.properties.error) || {};
      const liveDetail = Array.isArray(liveErr.details) ? liveErr.details[0] : null;
      ok('collect_live_inventory_failure_anomalies_get_readback', inv.ok === true && !!faLive
        && String((faLive.properties || {}).templateHash) === liveFix.failureAnomaliesPlatform.templateHash
        && getCalls.length >= 1);
      ok('collect_live_inventory_infers_infra_partial_with_live_fa',
        d1.inferLivePhase(inv) === 'infra-partial' && d1.isExactInfraPartialLive(inv) === true
        && d1.phaseContractFindings(inv, 'infra-partial').length === 0);
      ok('failure_anomalies_platform_signature_and_ai_present',
        d1.failureAnomaliesMatchesPlatformSignature(faRow) === true
        && d1.failureAnomaliesMatchesPlatformSignature(faLive) === true
        && String(liveErr.code) === 'DeploymentFailed'
        && Array.isArray(liveErr.details) && liveErr.details.length === 1
        && liveDetail && String(liveDetail.code) === 'MissingSubscriptionRegistration'
        && liveDetail.target === null
        && d1.liveInventoryHasExactAppInsights(liveSubset, aiExp) === true
        && d1.isExactOwnedFailureAnomaliesDeployment(faRow, faScope, aiExp, liveSubset) === true
        && d1.isExactOwnedFailureAnomaliesDeployment(faRow, faScope, aiExp, null) === false);
      const hRb = makeHarness(lib, d1);
      hRb.setRg({ name: RG, tags });
      hRb.setResources(liveSubset); hRb.setNested(liveNested); hRb.setSecrets([]); hRb.setRoles({});
      hRb.setDeploymentsList(liveFourDeps);
      const rb = await lib.rollback({ slug: SLUG, confirmDelete: RG }, hRb.deps);
      ok('rollback_infra_partial_live_fixture_four_deps_accepted', rb.ok === true && rb.deleted === true
        && rb.phase === 'infra-partial' && liveSubset.length === 9
        && liveFourDeps.map((d) => d.name).join(',')
          === 'messi-2d2-infra,messiproofStagingAcrPull,privateNetwork,Failure-Anomalies-Alert-Rule-Deployment-ea8f51b8'
        && !liveSubset.some((r) => r.type === 'Microsoft.KeyVault/vaults') && faProps.parameters === null
        && String((faProps.error || {}).code) === 'DeploymentFailed',
      rb.ok ? `phase=${rb.phase}` : JSON.stringify(rb.errors || rb).slice(0, 500));
    }

    // RED: FA GET failure/mismatch fail closed.
    for (const [label, status, body, code] of [
      ['get_fail_closed', 500, { error: { code: 'HarnessGetFail' } }, 'arm_get_failed'],
      ['get_mismatch_fail_closed', 200, {
        id: depId('other-name'), name: 'other-name', type: 'Microsoft.Resources/deployments', properties: faProps,
      }, 'deployment_get_mismatch'],
    ]) {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources(liveSubset); h.setNested(liveNested); h.setSecrets([]); h.setRoles({});
      h.setDeploymentsList(liveFourDeps);
      const realArm = h.deps.armRequest;
      h.deps.armRequest = async (req) => (req.method === 'GET' && isFaGet(req.path || '')
        ? { status, body, headers: {} } : realArm(req));
      const inv = await d1.collectLiveInventory(h.deps, names, tags);
      ok(`collect_live_inventory_failure_anomalies_${label}`, inv.ok === false
        && (inv.errors || []).some((e) => e.code === code));
    }

    {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources([...subset, {
        id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/rogue`,
        name: 'rogue', type: 'Microsoft.Storage/storageAccounts', tags, provisioningState: 'Succeeded',
      }]);
      h.setDeploymentsList(ownedDepRows);
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('rollback_infra_partial_unexpected_resource_refused', refuse.ok === false
        && (refuse.errors || []).some((e) => e.code === 'inventory_findings' || e.code === 'rollback_phase_invalid')
        && (refuse.findings || []).some((f) => f.code === 'unexpected_resource')
        && allDeletes(h).length === 0);
    }

    {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources(subset);
      h.setDeploymentsList([...ownedDepRows.slice(0, 1), {
        id: depId('foreign-deploy'), name: 'foreign-deploy', type: 'Microsoft.Resources/deployments',
        properties: { provisioningState: 'Succeeded' },
      }]);
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('rollback_infra_partial_foreign_deployment_refused', refuse.ok === false
        && (refuse.errors || []).some((e) => e.code === 'inventory_findings' || e.code === 'rollback_phase_invalid')
        && allDeletes(h).length === 0);
    }

    // RED: lookalike signature attacks + nested error attacks + absent/wrong App Insights refuse with zero deletes.
    {
      const atk = liveFix.attacks;
      const noErr = JSON.parse(JSON.stringify(faProps)); delete noErr.error;
      const goodDetail = { code: 'MissingSubscriptionRegistration', target: null };
      const attacks = [
        { label: 'lookalike_prefix', row: {
          id: depId(atk.lookalikePrefix), name: atk.lookalikePrefix,
          type: 'Microsoft.Resources/deployments', provisioningState: 'Failed', properties: faProps,
        } },
        { label: 'wrong_template_hash', row: faMut({ templateHash: atk.wrongTemplateHash }) },
        { label: 'extra_provider', row: faMut({
          providers: [faProps.providers[0], {
            namespace: atk.extraProviderNamespace, resourceTypes: faProps.providers[0].resourceTypes,
          }],
        }) },
        { label: 'wrong_resource_type', row: faMut({
          providers: [faProv({}, { resourceType: atk.wrongResourceType })],
        }) },
        { label: 'wrong_location', row: faMut({
          providers: [faProv({}, { locations: [atk.wrongLocation] })],
        }) },
        { label: 'non_failed_state', row: faMut(
          { provisioningState: atk.nonFailedState },
          { provisioningState: atk.nonFailedState },
        ) },
        { label: 'top_error_code_changed', row: faMut({
          error: { code: atk.wrongTopErrorCode || atk.wrongErrorCode, details: [goodDetail] },
        }) },
        { label: 'zero_details', row: faMut({ error: { code: 'DeploymentFailed', details: [] } }) },
        { label: 'multiple_details', row: faMut({
          error: { code: 'DeploymentFailed', details: [goodDetail, goodDetail] },
        }) },
        { label: 'wrong_detail_code', row: faMut({
          error: {
            code: 'DeploymentFailed',
            details: [{ code: atk.wrongDetailErrorCode || atk.wrongErrorCode, target: null }],
          },
        }) },
        { label: 'detail_nested_children', row: faMut({
          error: {
            code: 'DeploymentFailed',
            details: [{
              code: 'MissingSubscriptionRegistration',
              target: null,
              details: [{ code: 'NestedChild', target: null }],
            }],
          },
        }) },
        { label: 'flat_top_missing_subscription_registration', row: faMut({
          error: { code: 'MissingSubscriptionRegistration', message: 'flat wrong level' },
        }) },
        { label: 'wrong_error_code', row: faMut({ error: { code: atk.wrongErrorCode } }) },
        { label: 'missing_error', row: { ...faRow, properties: noErr } },
        { label: 'malformed_error', row: faMut({ error: ['x'] }) },
        { label: 'null_properties', row: faMut(null) },
        { label: 'malformed_properties', row: { ...faRow, properties: ['x'] } },
        { label: 'wrong_type', row: { ...faRow, type: atk.wrongType } },
        { label: 'wrong_id', row: {
          ...faRow,
          id: `/subscriptions/${atk.wrongIdSub}/resourceGroups/${RG}/providers/Microsoft.Resources/deployments/${faName}`,
        } },
        { label: 'absent_app_insights', row: faRow,
          resources: liveSubset.filter((r) => r.type !== 'Microsoft.Insights/components') },
        { label: 'wrong_app_insights_id', row: faRow,
          resources: liveSubset.map((r) => (r.type === 'Microsoft.Insights/components'
            ? { ...r, id: `${r.id}-x`, name: `${r.name}-x` } : r)) },
      ];
      let attackPass = 0;
      for (const at of attacks) {
        const h = makeHarness(lib, d1);
        h.setRg({ name: RG, tags });
        h.setResources(at.resources || liveSubset); h.setNested(liveNested);
        h.setDeploymentsList([...ownedDepRows, at.row]);
        const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
        const helperRow = {
          id: at.row.id, name: at.row.name, type: at.row.type,
          provisioningState: at.row.provisioningState
            || (at.row.properties && at.row.properties.provisioningState) || null,
          properties: at.row.properties,
        };
        if (refuse.ok === false && allDeletes(h).length === 0
          && d1.isExactOwnedFailureAnomaliesDeployment(helperRow, faScope, aiExp, at.resources || liveSubset) === false
          && (refuse.errors || []).some((e) => /inventory_findings|rollback_phase_invalid|arm_get_failed|deployment_get_mismatch/.test(e.code || ''))) {
          attackPass += 1;
        } else {
          ok(`rollback_infra_partial_failure_anomalies_${at.label}_refused`, false,
            JSON.stringify(refuse.errors || refuse).slice(0, 240));
        }
      }
      ok('rollback_infra_partial_failure_anomalies_attacks_refused', attackPass === attacks.length,
        `pass=${attackPass}/${attacks.length}`);
    }

    // RED: missing/wrong resource ID; missing/wrong deployment id/type.
    {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources(subset.map((r, i) => (i === 0 ? { name: r.name, type: r.type, tags, provisioningState: 'Succeeded' } : r)));
      h.setDeploymentsList(ownedDepRows);
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('rollback_infra_partial_missing_resource_id_refused', refuse.ok === false
        && allDeletes(h).length === 0
        && (refuse.errors || []).some((e) => e.code === 'inventory_findings' || e.code === 'rollback_phase_invalid'),
      JSON.stringify(refuse.errors || refuse).slice(0, 280));
    }
    {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources(subset.map((r, i) => (i === 0
        ? { ...r, id: `${r.id}-tampered` }
        : r)));
      h.setDeploymentsList(ownedDepRows);
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('rollback_infra_partial_wrong_resource_id_refused', refuse.ok === false
        && allDeletes(h).length === 0
        && (refuse.errors || []).some((e) => e.code === 'inventory_findings' || e.code === 'rollback_phase_invalid'),
      JSON.stringify(refuse.errors || refuse).slice(0, 280));
    }
    {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources(subset);
      h.setDeploymentsList(ownedDepRows.map((d, i) => (i === 0
        ? { name: d.name, type: d.type, properties: d.properties }
        : d)));
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('rollback_infra_partial_missing_deployment_id_refused', refuse.ok === false
        && allDeletes(h).length === 0
        && (refuse.errors || []).some((e) => e.code === 'inventory_findings' || e.code === 'rollback_phase_invalid'),
      JSON.stringify(refuse.errors || refuse).slice(0, 280));
    }
    {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources(subset);
      h.setDeploymentsList(ownedDepRows.map((d, i) => (i === 0
        ? { ...d, type: 'Microsoft.Resources/deployments/operations' }
        : d)));
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('rollback_infra_partial_wrong_deployment_type_refused', refuse.ok === false
        && allDeletes(h).length === 0
        && (refuse.errors || []).some((e) => e.code === 'inventory_findings' || e.code === 'rollback_phase_invalid'),
      JSON.stringify(refuse.errors || refuse).slice(0, 280));
    }

    // RED: foreign nested / role / secret still refuse (do not weaken).
    {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources([
        ...liveSubset,
        {
          id: `${dnsLink.parentId}/virtualNetworkLinks/foreign-dns-link`,
          name: 'foreign-dns-link',
          type: 'Microsoft.Network/privateDnsZones/virtualNetworkLinks',
          tags, provisioningState: 'Succeeded',
        },
      ]);
      h.setNested(liveNested);
      h.setDeploymentsList(liveFourDeps);
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('rollback_infra_partial_foreign_nested_refused', refuse.ok === false && allDeletes(h).length === 0
        && (refuse.errors || []).some((e) => e.code === 'inventory_findings' || e.code === 'rollback_phase_invalid'),
      JSON.stringify(refuse.errors || refuse).slice(0, 280));
    }
    {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources([
        ...liveSubset,
        {
          id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Authorization/roleAssignments/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
          name: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          type: 'Microsoft.Authorization/roleAssignments',
          tags, provisioningState: 'Succeeded',
        },
      ]);
      h.setNested(liveNested);
      h.setDeploymentsList(liveFourDeps);
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('rollback_infra_partial_foreign_role_refused', refuse.ok === false && allDeletes(h).length === 0
        && (refuse.errors || []).some((e) => e.code === 'inventory_findings' || e.code === 'rollback_phase_invalid'),
      JSON.stringify(refuse.errors || refuse).slice(0, 280));
    }
    {
      const kv = contract.foundationTopLevel.find((r) => r.type === 'Microsoft.KeyVault/vaults');
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources([
        ...liveSubset,
        { id: kv.id, name: kv.name, type: kv.type, tags, provisioningState: 'Succeeded' },
      ]);
      h.setNested(liveNested);
      h.setSecrets([{ id: `${kv.id}/secrets/rogue-secret`, name: 'rogue-secret', tags }]);
      h.setDeploymentsList(liveFourDeps);
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('rollback_infra_partial_foreign_secret_refused', refuse.ok === false && allDeletes(h).length === 0
        && (refuse.errors || []).some((e) => e.code === 'inventory_findings' || e.code === 'rollback_phase_invalid'),
      JSON.stringify(refuse.errors || refuse).slice(0, 280));
    }

    {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources(subset);
      h.setDeploymentListStatus(500);
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('rollback_infra_partial_malformed_inventory_refused', refuse.ok === false
        && (refuse.errors || []).some((e) => e.code === 'arm_list_failed' || e.code === 'arm_list_malformed'
          || e.code === 'inventory_list_failed' || e.code === 'inventory_findings')
        && allDeletes(h).length === 0,
      JSON.stringify(refuse.errors || refuse).slice(0, 280));
    }

    {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags: { ...tags, owner: 'other-owner', planDigest: '0'.repeat(64) } });
      h.setResources(subset.map((r) => ({ ...r, tags: { ...tags, owner: 'other-owner' } })));
      h.setDeploymentsList(ownedDepRows);
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('rollback_infra_partial_wrong_tags_refused', refuse.ok === false
        && (refuse.errors || []).some((e) => /tag_mismatch|takeover|rollback_tag/i.test(e.code || ''))
        && allDeletes(h).length === 0,
      JSON.stringify(refuse.errors || refuse).slice(0, 280));
    }

    // Stale lock: recorded PID absent + no competing process → recover and proceed.
    {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources(subset);
      h.setDeploymentsList(ownedDepRows);
      const deadPid = 424242;
      fs.mkdirSync(h.stateDir, { recursive: true });
      fs.writeFileSync(path.join(h.stateDir, `${SLUG}.op.lock`), `${deadPid}\n`, { mode: 0o600 });
      h.deps.processKill = (pid, sig) => {
        if (Number(pid) === deadPid && (sig === 0 || sig === 'SIGCONT')) {
          const e = new Error('kill ESRCH'); e.code = 'ESRCH'; throw e;
        }
        return process.kill(pid, sig);
      };
      h.deps.findCompetingProcesses = () => [];
      const rb = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('rollback_stale_pid_lock_recovered_after_dead_proof', rb.ok === true && rb.deleted === true
        && rb.phase === 'infra-partial'
        && !fs.existsSync(path.join(h.stateDir, `${SLUG}.op.lock`)),
      rb.ok ? `phase=${rb.phase}` : JSON.stringify(rb.errors || rb).slice(0, 400));
    }

    // Live lock: recorded PID still present → never steal.
    {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources(subset);
      h.setDeploymentsList(ownedDepRows);
      const livePid = process.pid;
      fs.mkdirSync(h.stateDir, { recursive: true });
      fs.writeFileSync(path.join(h.stateDir, `${SLUG}.op.lock`), `${livePid}\n`, { mode: 0o600 });
      h.deps.processKill = (pid, sig) => process.kill(pid, sig);
      h.deps.findCompetingProcesses = () => [];
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('rollback_live_pid_lock_never_stolen', refuse.ok === false
        && (refuse.errors || []).some((e) => e.code === 'lock_busy' || e.code === 'lock_live')
        && fs.existsSync(path.join(h.stateDir, `${SLUG}.op.lock`))
        && allDeletes(h).length === 0,
      JSON.stringify(refuse.errors || refuse).slice(0, 280));
    }

    // Competing process proof blocks recovery even if recorded PID is dead.
    {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources(subset);
      h.setDeploymentsList(ownedDepRows);
      const deadPid = 434343;
      fs.mkdirSync(h.stateDir, { recursive: true });
      fs.writeFileSync(path.join(h.stateDir, `${SLUG}.op.lock`), `${deadPid}\n`, { mode: 0o600 });
      h.deps.processKill = (pid, sig) => {
        if (Number(pid) === deadPid) {
          const e = new Error('kill ESRCH'); e.code = 'ESRCH'; throw e;
        }
        return process.kill(pid, sig);
      };
      h.deps.findCompetingProcesses = () => [{ pid: 999001, cmd: `node ${CLI_REL} rollback --slug ${SLUG}` }];
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('rollback_competing_process_blocks_stale_lock_steal', refuse.ok === false
        && (refuse.errors || []).some((e) => e.code === 'lock_busy' || e.code === 'lock_competing')
        && allDeletes(h).length === 0,
      JSON.stringify(refuse.errors || refuse).slice(0, 280));
    }
  }

  {
    const h = makeHarness(lib, d1);
    const authPreview = await lib.deriveD1Authority({ slug: SLUG }, h.deps);
    const tags = lib.drillTags({
      tenantSlug: SLUG, planDigest: authPreview.planDigest, deploySha: SHA,
      createdAt: '2026-07-23T10:00:00.000Z', expiresAt: '2026-07-23T11:00:00.000Z',
    });
    h.setRg({ name: RG, tags });
    h.deps.now = () => new Date('2026-07-23T12:00:00Z');
    const st = await lib.expiryStatus({ slug: SLUG }, h.deps);
    ok('expiry_status_paste_ready', st.ok && st.present && st.expired === true
      && st.rollbackCommand === `node scripts/messi-saas-stage2d2-apply-rollback.js rollback --slug ${SLUG} --confirm-delete ${RG}`);
  }

  {
    const bootSrc = fs.readFileSync(path.join(ROOT, 'scripts/bootstrap-synthetic-tenant-db.js'), 'utf8');
    const h = makeHarness(lib, d1);
    const names = d1.deriveNames(SLUG, SUB);
    h.seedRoles(names);
    h.setJob({ id: 'job', name: names.bootstrapJobName, tags: {} });
    h.setApp(runtimeAppBody(names));
    await lib.apply({ slug: SLUG, ...approval() }, h.deps);
    ok('pinned_az_absolute_no_bare',
      /function resolveOperatorAzCommand/.test(bootSrc)
      && bootSrc.includes("'/opt/data/.local/bin/az'")
      && !/run\('az'/.test(bootSrc) && !/runSync\('az'/.test(bootSrc)
      && /az_command_must_be_absolute/.test(bootSrc)
      && h.azCmdLog.includes(PINNED_AZ)
      && /azCommand:\s*deps\.pinnedBins\.az/.test(src));
  }

  {
    const h = makeHarness(lib, d1); let polls = 0;
    const real = h.deps.armRequest;
    h.deps.armRequest = async (req) => {
      const res = await real(req);
      if (req.method === 'GET' && /deployments\/messi-2d2-expiry/.test(req.path || '')) {
        polls += 1;
        if (polls === 2) h.setClock(EXPIRES);
        return { status: 200, body: { properties: { provisioningState: 'Running' } }, headers: {} };
      }
      return res;
    };
    const polled = await lib.pollArmTerminal(h.deps,
      `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Resources/deployments/messi-2d2-expiry?api-version=2021-04-01`,
      { createdAt: CREATED, expiresAt: EXPIRES, phase: 'infra' });
    ok('expiry_checked_during_long_poll', !polled.ok
      && (polled.errors || []).some((e) => e.code === 'ttl_expired' || e.code === 'ttl_insufficient_for_phase')
      && polls >= 2 && Object.prototype.hasOwnProperty.call(polled, 'body'));
  }

  {
    const h = makeHarness(lib, d1);
    const names = d1.deriveNames(SLUG, SUB);
    const c = d1.buildExpectedResourceContract(names, { principalId: PID });
    const map = {};
    for (const role of c.roleAssignments) {
      map[String(role.name).toLowerCase()] = {
        id: role.id, name: role.name,
        properties: {
          roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${role.roleDefinitionId}`,
          principalId: role.kind === 'acr' ? '99999999-9999-9999-9999-999999999999' : PID,
          scope: role.scope,
        },
      };
    }
    h.setRoles(map);
    h.deps.sleep = async (ms) => { h.advanceClock(Math.min(Number(ms) || 0, 60_000)); };
    const r = await lib.waitExactRoles(h.deps, names, PID, { createdAt: CREATED, expiresAt: EXPIRES });
    ok('role_readback_requires_principal_scope_def', !r.ok
      && (r.errors || []).some((e) => e.code === 'role_propagation_timeout'));
  }

  {
    const boundaries = []; let waitPolls = 0; let started = false; let deleted = false;
    const assertFn = (b) => {
      boundaries.push(b);
      if (String(b).includes('waitTerminal-poll') && waitPolls++ >= 1) {
        return { ok: false, errors: [{ code: 'ttl_expired', message: 'expired mid wait' }] };
      }
      return { ok: true, errors: [] };
    };
    const r = await lib.runInjectedOperatorLifecycle({
      azure: {
        assertCanDelete: async () => ({ ok: true, errors: [] }),
        startJob: async () => { started = true; return { ok: true, executionName: 'exec-1', errors: [] }; },
        waitTerminal: async (args) => {
          for (let i = 0; i < 3; i += 1) {
            const g = await args.assertActiveDrill('waitTerminal-poll');
            if (g && g.ok === false) return g;
          }
          return { ok: true, status: 'Succeeded', summary: { ok: true }, errors: [] };
        },
        deleteJob: async () => { deleted = true; return { ok: true, verifiedAbsent: true, errors: [] }; },
        installSignalHandlers() {}, removeSignalHandlers() {},
      },
      attestation: {}, secrets: [], assertActiveDrill: assertFn,
    });
    ok('operator_lifecycle_threads_assertActiveDrill', !r.ok
      && (r.errors || []).some((e) => e.code === 'ttl_expired') && started && deleted
      && boundaries.includes('before-startJob') && boundaries.includes('after-startJob')
      && boundaries.some((b) => String(b).includes('waitTerminal'))
      && boundaries.includes('before-deleteJob'));
  }

  {
    const h = makeHarness(lib, d1);
    const names = d1.deriveNames(SLUG, SUB);
    h.seedRoles(names);
    h.setJob({ id: 'job', name: names.bootstrapJobName, tags: {} });
    h.setApp(runtimeAppBody(names));
    const real = h.deps.armRequest;
    h.deps.armRequest = async (req) => {
      const res = await real(req);
      if (req.method === 'GET' && /resourcegroups\/[^/?]+(\?|$)/i.test(req.path || '')
        && !/providers\//i.test((req.path || '').split('resourcegroups/')[1] || '')
        && res.status === 200 && res.body && res.body.tags
        && h.armLog.some((x) => x.method === 'POST' && /CostManagement\/query/i.test(x.path || ''))) {
        return {
          status: 200,
          body: { ...res.body, tags: { ...res.body.tags, tenant: 'wrong-tenant' } },
          headers: res.headers,
        };
      }
      return res;
    };
    const r = await lib.apply({ slug: SLUG, ...approval() }, h.deps);
    ok('receipt_requires_full_live_tag_tuple', !r.ok
      && (r.errors || []).some((e) => e.code === 'receipt_tag_mismatch' || e.code === 'rg_tag_mismatch'));
  }

  {
    const h = makeHarness(lib, d1);
    const names = d1.deriveNames(SLUG, SUB);
    h.seedRoles(names);
    h.setJob({ id: 'job', name: names.bootstrapJobName, tags: {} });
    h.setApp(runtimeAppBody(names));
    let signaled = false;
    const real = h.deps.armRequest;
    h.deps.armRequest = async (req) => {
      const res = await real(req);
      if (!signaled && req.method === 'PUT' && /resourcegroups\//i.test(req.path || '')
        && !/providers\//i.test((req.path || '').split('resourcegroups/')[1] || '')) {
        signaled = true; h.fakeProc.emit('SIGTERM');
      }
      return res;
    };
    const r = await lib.apply({ slug: SLUG, ...approval() }, h.deps);
    ok('signal_aborts_apply_receipt_lock_released', !r.ok
      && (r.errors || []).some((e) => e.code === 'operation_aborted')
      && (r.preservedResourceGroup === true || lib.readReceipt(h.deps, SLUG))
      && !fs.existsSync(path.join(h.stateDir, `${SLUG}.op.lock`)) && signaled);
  }

  {
    const h = makeHarness(lib, d1);
    const authPreview = await lib.deriveD1Authority({ slug: SLUG }, h.deps);
    const tags = drillOwned(authPreview.planDigest);
    h.setRg({ name: RG, tags });
    h.seedFoundation(tags);
    let signaled = false;
    let rgGets = 0;
    const real = h.deps.armRequest;
    h.deps.armRequest = async (req) => {
      const res = await real(req);
      // Signal only on the locked re-read (2nd RG GET) after installOperationSignals.
      if (req.method === 'GET' && /resourcegroups\/[^/?]+(\?|$)/i.test(req.path || '')
        && !/providers\//i.test((req.path || '').split('resourcegroups/')[1] || '')
        && res.status === 200) {
        rgGets += 1;
        if (!signaled && rgGets >= 2) {
          signaled = true; h.fakeProc.emit('SIGTERM');
        }
      }
      return res;
    };
    const rb = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
    const receipt = lib.readReceipt(h.deps, SLUG);
    ok('rollback_signal_writes_aborted_receipt', !rb.ok
      && (rb.errors || []).some((e) => e.code === 'operation_aborted')
      && receipt && /rollback_aborted|rollback_failed/.test(receipt.status)
      && !/postgresql:\/\/|sk_live|whsec_/i.test(JSON.stringify(receipt))
      && !fs.existsSync(path.join(h.stateDir, `${SLUG}.op.lock`)) && signaled,
    `rb=${JSON.stringify(rb.errors || rb).slice(0, 200)} receipt=${receipt && receipt.status} gets=${rgGets}`);
  }

  {
    const near = lib.assertActiveDrill({
      createdAt: CREATED, expiresAt: EXPIRES,
      now: new Date(Date.parse(EXPIRES) - 60_000), phase: 'infra',
    });
    const okBudget = lib.assertActiveDrill({
      createdAt: CREATED, expiresAt: EXPIRES,
      now: new Date('2026-07-23T12:00:00Z'), phase: 'infra',
    });
    ok('phase_ttl_budget_gate', near.ok === false
      && near.errors.some((e) => e.code === 'ttl_insufficient_for_phase') && okBudget.ok === true);
  }

  {
    // D1 compiled handoff: digest rederived (never hardcoded 4a306b)
    const h = makeHarness(lib, d1);
    const auth = await lib.deriveD1Authority({ slug: SLUG }, h.deps);
    ok('d1_compiled_handoff_rederived', auth.ok && Buffer.isBuffer(auth.templateBytes)
      && auth.compiled.compiledTemplateSha256 === lib.sha256(auth.templateBytes)
      && /^[a-f0-9]{64}$/.test(auth.planDigest)
      && !src.includes('4a306b') && auth.planDigest !== '4a306b');
  }

  {
    const h = makeHarness(lib, d1);
    h.setRg({ name: RG, tags: { tenant: SLUG } });
    const r = await lib.apply({ slug: SLUG, ...approval() }, h.deps);
    ok('apply_requires_absent_rg', r.ok === false && (r.errors || []).some((e) => e.code === 'rg_exists'));
  }

  {
    // Live b0b6b319: bootstrap ACA Job rejected config digest (az acr manifest show
    // config.digest) as MANIFEST_UNKNOWN. list-metadata maps exact tag → image-manifest.
    const LIVE_TAG = 'fb34fd622829609fe70cddaa56ceee2831ac0b6e';
    const CONFIG_DIGEST = `sha256:8bfb${'0'.repeat(60)}`; // wrong: config blob
    const MANIFEST_DIGEST = `sha256:002f7388${'1'.repeat(56)}`; // correct: image-manifest
    const OTHER_DIGEST = `sha256:${'a'.repeat(64)}`;
    const LAYER_DIGEST = `sha256:${'b'.repeat(64)}`;
    // Live-shaped list-metadata: exact tag→manifest; foreign tags; untagged; no config/layers.
    const liveList = [
      {
        digest: MANIFEST_DIGEST,
        tags: [LIVE_TAG],
        architecture: 'amd64',
        os: 'linux',
        mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
        configMediaType: 'application/vnd.docker.container.image.v1+json',
        imageSize: 148_291_344,
      },
      {
        digest: OTHER_DIGEST,
        tags: ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
        architecture: 'amd64',
        os: 'linux',
      },
      { digest: `sha256:${'c'.repeat(64)}`, tags: [], architecture: 'amd64', os: 'linux' },
    ];
    const green = lib.resolveImageDigest({
      azExec: (argv) => {
        ok('list_metadata_argv_pinned_ownership',
          Array.isArray(argv) && argv[0] === 'acr' && argv[1] === 'manifest'
          && argv[2] === 'list-metadata'
          && argv.includes('--name') && argv.includes('luna-sunset-staff-api')
          && argv.includes('--registry') && argv.includes('whstagingacr')
          && !argv.some((a) => /:|@sha256:/.test(String(a))));
        return JSON.stringify(liveList);
      },
    }, LIVE_TAG);
    ok('acr_list_metadata_exact_tag_manifest_digest', green.ok === true
      && green.imageDigest === MANIFEST_DIGEST.toLowerCase()
      && green.imageDigest !== CONFIG_DIGEST.toLowerCase());

    // Hostile: show-shaped body with only config.digest / layers (prior wrong path).
    const showShaped = {
      schemaVersion: 2,
      mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
      config: { mediaType: 'application/vnd.docker.container.image.v1+json', size: 1, digest: CONFIG_DIGEST },
      layers: [{ mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', size: 1, digest: LAYER_DIGEST }],
    };
    const refuseShow = lib.resolveImageDigest({
      azExec: () => JSON.stringify(showShaped),
    }, LIVE_TAG);
    ok('acr_refuses_show_config_layer_digests', refuseShow.ok === false
      && (refuseShow.errors || []).some((e) => e.code === 'image_digest_resolve'));

    // Hostile: config.digest equal to lookalike on a row that also has our tag — still refuse pollution.
    const polluted = [{
      digest: MANIFEST_DIGEST,
      tags: [LIVE_TAG],
      config: { digest: CONFIG_DIGEST },
    }];
    const refusePolluted = lib.resolveImageDigest({
      azExec: () => JSON.stringify(polluted),
    }, LIVE_TAG);
    ok('acr_refuses_config_polluted_metadata_row', refusePolluted.ok === false
      && (refusePolluted.errors || []).some((e) => e.code === 'image_digest_resolve'));

    const absent = lib.resolveImageDigest({
      azExec: () => JSON.stringify(liveList),
    }, 'ffffffffffffffffffffffffffffffffffffffff');
    ok('acr_tag_absent_fail_closed', absent.ok === false
      && (absent.errors || []).some((e) => e.code === 'image_digest_resolve'));

    const untaggedOnly = lib.resolveImageDigest({
      azExec: () => JSON.stringify([{ digest: MANIFEST_DIGEST, tags: [] }]),
    }, LIVE_TAG);
    ok('acr_untagged_not_accepted', untaggedOnly.ok === false
      && (untaggedOnly.errors || []).some((e) => e.code === 'image_digest_resolve'));

    const dup = lib.resolveImageDigest({
      azExec: () => JSON.stringify([
        { digest: MANIFEST_DIGEST, tags: [LIVE_TAG] },
        { digest: OTHER_DIGEST, tags: [LIVE_TAG] },
      ]),
    }, LIVE_TAG);
    ok('acr_duplicate_tag_fail_closed', dup.ok === false
      && (dup.errors || []).some((e) => e.code === 'image_digest_resolve'));

    const malformed = lib.resolveImageDigest({
      azExec: () => JSON.stringify([{ digest: MANIFEST_DIGEST, tags: 'not-array' }]),
    }, LIVE_TAG);
    ok('acr_malformed_tags_fail_closed', malformed.ok === false
      && (malformed.errors || []).some((e) => e.code === 'image_digest_resolve'));

    const badDigest = lib.resolveImageDigest({
      azExec: () => JSON.stringify([{ digest: 'latest', tags: [LIVE_TAG] }]),
    }, LIVE_TAG);
    ok('acr_non_sha256_manifest_digest_fail_closed', badDigest.ok === false
      && (badDigest.errors || []).some((e) => e.code === 'image_digest_resolve'));

    // buildStaffImage must resolve only the exact newly built deploySha tag.
    const builtSha = SHA;
    const foreign = `sha256:${'f'.repeat(64)}`;
    const h = makeHarness(lib, d1);
    const origAz = h.deps.azExec;
    h.deps.azExec = (args) => {
      if (args[0] === 'acr' && args[1] === 'manifest' && args[2] === 'list-metadata') {
        return JSON.stringify([
          { digest: foreign, tags: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] },
          { digest: DIGEST_IMG, tags: [builtSha] },
          { digest: `sha256:${'e'.repeat(64)}`, tags: [] },
        ]);
      }
      return origAz(args);
    };
    const img = lib.buildStaffImage(h.deps, builtSha);
    ok('build_resolves_only_exact_new_tag', img.ok === true
      && img.imageDigest === DIGEST_IMG.toLowerCase()
      && img.imageDigest !== foreign
      && Array.isArray(img.manifestArgv) && img.manifestArgv[2] === 'list-metadata');
  }

  {
    // Live ARM atScope() can return inherited parent-scope rows; exact-role gates must ignore them.
    const names = d1.deriveNames(SLUG, SUB);
    const prep = lib.buildPreparedRoleAssignments(names);
    const rgScope = `/subscriptions/${SUB}/resourceGroups/${RG}`;
    const acrScope = `/subscriptions/${SUB}/resourceGroups/wh-staging-rg/providers/Microsoft.ContainerRegistry/registries/whstagingacr`;
    const subScope = `/subscriptions/${SUB}`;
    const human = '78442e5b-c8de-407f-bbd2-e4f91348d22a';
    const ownerDef = `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/8e3af657-a8ff-443c-a75c-2fe8c4bcb635`;
    const readerDef = `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/acdd72a7-3385-48ef-bd42-f606fba81ae7`;
    const costDef = `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/72fafb9e-0641-4937-9268-a91bfd8191a3`;
    const pushDef = `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${lib.ROLE_ACR_PUSH}`;
    const tasksDef = `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${lib.ROLE_ACR_BUILD_RUNNER}`;
    const mk = (name, scope, principalId, roleDefinitionId, withPropsScope = true) => ({
      name,
      id: `${scope}/providers/Microsoft.Authorization/roleAssignments/${name}`,
      properties: {
        ...(withPropsScope ? { scope } : {}),
        principalId,
        roleDefinitionId,
      },
    });
    const rgFixture = [
      mk(prep[0].name, rgScope, lib.EXECUTOR_UAI_OID, prep[0].roleDefinitionResourceId),
      mk(prep[1].name, rgScope, lib.EXECUTOR_UAI_OID, prep[1].roleDefinitionResourceId),
      mk('human-owner-1', subScope, human, ownerDef),
      mk('human-owner-2', subScope, human, ownerDef),
      mk('exec-reader-sub', subScope, lib.EXECUTOR_UAI_OID, readerDef),
      mk('exec-cost-sub', subScope, lib.EXECUTOR_UAI_OID, costDef),
      mk('unproven-row', rgScope, lib.EXECUTOR_UAI_OID, prep[0].roleDefinitionResourceId, false),
    ];
    // Unproven row: wipe id so scope cannot be derived either.
    rgFixture[rgFixture.length - 1].id = 'not-a-role-assignment-id';
    const rgDeps = {
      armRequest: async () => ({ status: 200, body: { value: rgFixture }, headers: {} }),
    };
    const rgListed = await lib.listDirectRoleAssignments(rgDeps, rgScope);
    ok('list_direct_rg_roles_excludes_inherited', rgListed.ok === true
      && rgListed.value.length === 2
      && rgListed.value.every((r) => String((r.properties || {}).scope).toLowerCase() === rgScope.toLowerCase())
      && rgListed.value.every((r) => [prep[0].name, prep[1].name].includes(r.name)));
    const rgAssert = await lib.assertExactDirectRgRoles(rgDeps, names, prep);
    ok('assert_exact_rg_roles_ignores_inherited_owners', rgAssert.ok === true
      && (rgAssert.value || []).length === 2);

    const slashDeps = {
      armRequest: async () => ({
        status: 200,
        body: {
          value: [
            mk(prep[0].name, `${rgScope}/`, lib.EXECUTOR_UAI_OID, prep[0].roleDefinitionResourceId),
            mk(prep[1].name, rgScope, lib.EXECUTOR_UAI_OID, prep[1].roleDefinitionResourceId),
            mk('human-owner-1', subScope, human, ownerDef),
          ],
        },
        headers: {},
      }),
    };
    const slashListed = await lib.listDirectRoleAssignments(slashDeps, rgScope);
    ok('list_direct_roles_normalizes_trailing_slash', slashListed.ok === true && slashListed.value.length === 2);

    const acrFixture = [
      mk('exec-acr-push', acrScope, lib.EXECUTOR_UAI_OID, pushDef),
      mk('exec-acr-tasks', acrScope, lib.EXECUTOR_UAI_OID, tasksDef),
      mk(prep[2].name, acrScope, lib.EXECUTOR_UAI_OID, prep[2].roleDefinitionResourceId),
      mk('exec-reader-sub', subScope, lib.EXECUTOR_UAI_OID, readerDef),
      mk('exec-reader-rg', `/subscriptions/${SUB}/resourceGroups/wh-staging-rg`, lib.EXECUTOR_UAI_OID, readerDef),
      mk('exec-cost-sub', subScope, lib.EXECUTOR_UAI_OID, costDef),
      mk('other-acr-pull', acrScope, human, `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/7f951dda-4ed3-4680-a7ca-43fe172d538d`),
    ];
    const acrDeps = {
      armRequest: async () => ({ status: 200, body: { value: acrFixture }, headers: {} }),
    };
    const acrListed = await lib.listDirectRoleAssignments(acrDeps, acrScope);
    ok('list_direct_acr_roles_excludes_inherited', acrListed.ok === true
      && acrListed.value.length === 4
      && acrListed.value.every((r) => String((r.properties || {}).scope).toLowerCase() === acrScope.toLowerCase()));
    const acrAssert = await lib.assertExactExecutorAcrRoles(acrDeps, names, prep);
    ok('assert_exact_acr_roles_ignores_inherited_readers', acrAssert.ok === true);
  }

  // Live apply acquires exclusive lock after HEAD authority. Rollback probes live tags,
  // locks, re-reads (same ETag/full tuple), then historical authority — never receipt.
  // If default stateDir lives under the git worktree, mkdir dirties porcelain.
  {
    const def = lib.createDeps({ repoRoot: ROOT });
    const underRepo = def.stateDir === path.join(ROOT, 'tmp', 'messi-saas-stage2d2')
      || def.stateDir.startsWith(`${ROOT}${path.sep}`);
    ok('default_state_dir_outside_repo', !underRepo
      && path.basename(def.stateDir) === 'messi-saas-stage2d2',
    `stateDir=${def.stateDir}`);

    const applySrc = fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8');
    const applyFn = applySrc.slice(applySrc.indexOf('async function apply('), applySrc.indexOf('async function preserveFailure('));
    const rbFn = applySrc.slice(applySrc.indexOf('async function rollback('), applySrc.indexOf('async function expiryStatus('));
    const authBeforeLock = (fn) => {
      const a = fn.indexOf('deriveD1Authority(');
      const l = fn.indexOf('acquireExclusiveLock(');
      return a >= 0 && l >= 0 && a < l;
    };
    ok('apply_derives_authority_before_lock', authBeforeLock(applyFn));
    // Rollback: staging names/preflight + live probe before lock; historical authority after lock re-read.
    const resolveIdx = rbFn.indexOf('resolveCurrentStagingNames(');
    const lockIdx = rbFn.indexOf('acquireExclusiveLock(');
    const histIdx = rbFn.indexOf('deriveD1HistoricalRollbackAuthority(');
    ok('rollback_probes_and_locks_before_historical_authority',
      resolveIdx >= 0 && lockIdx >= 0 && histIdx >= 0
      && resolveIdx < lockIdx && lockIdx < histIdx
      && rbFn.includes('assertRgProbeUnchanged')
      && !/readReceipt\(/.test(rbFn));
    ok('apply_never_calls_historical_authority',
      !applyFn.includes('deriveD1HistoricalRollbackAuthority')
      && !applyFn.includes('deriveHistoricalRollbackAuthority')
      && !applyFn.includes('historicalDeploySha')
      && !applyFn.includes('liveDeploySha'));

    const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'messi-2d2-dirty-'));
    try {
      execFileSync('git', ['init', '-b', 'master'], { cwd: probeRoot, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'messi@example.invalid'], { cwd: probeRoot, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'messi'], { cwd: probeRoot, stdio: 'ignore' });
      fs.writeFileSync(path.join(probeRoot, 'README'), 'x\n');
      execFileSync('git', ['add', 'README'], { cwd: probeRoot, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: probeRoot, stdio: 'ignore' });
      const probe = lib.createDeps({ repoRoot: probeRoot });
      const lock = lib.acquireExclusiveLock(probe, SLUG);
      ok('default_lock_keeps_git_clean', lock.ok === true
        && execFileSync('git', ['status', '--porcelain'], {
          cwd: probeRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        }).trim() === '');
      if (lock.release) lock.release();
    } finally {
      try { fs.rmSync(probeRoot, { recursive: true, force: true }); } catch (_) { /* */ }
    }
  }

  // Historical authority (rollback-only): live deploySha is a prior master ancestor while
  // current clean HEAD/origin/master has advanced. Old HEAD-only derive failed tag_mismatch
  // (same class as empty-RG cleanup). GREEN rederives from live tags + exact-SHA snapshot.
  {
    const LIVE_ANCESTOR = 'e1179bf285a62e456a48e3e933e498fa5f65e3fd';
    const CURRENT_HEAD = 'f60f1f32d9b89993ef547b84692a2dc48e402626';
    const SIDE_BRANCH = 'd'.repeat(40);
    const liveFix = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'fixtures/messi-saas-stage2d2/infra-partial-live-crash.json'), 'utf8',
    ));
    ok('fixture_live_shaped_ancestor_current_head',
      liveFix.liveDeploySha === LIVE_ANCESTOR
      && liveFix.currentHeadAdvanced === CURRENT_HEAD
      && liveFix.originMaster === CURRENT_HEAD
      && liveFix.receiptIsAuthority === false);

    const ancestorOf = (anc, desc) => {
      const a = String(anc).toLowerCase();
      const d = String(desc).toLowerCase();
      if (a === d) return true;
      if (a === LIVE_ANCESTOR && (d === CURRENT_HEAD || d === LIVE_ANCESTOR)) return true;
      return false;
    };
    const histOpts = {
      headSha: CURRENT_HEAD,
      originMasterSha: CURRENT_HEAD,
      verifiedDeploySha: CURRENT_HEAD,
      isAncestor: ancestorOf,
    };
    const { digest: liveDigest } = await rederivedDigestAt(lib, d1, LIVE_ANCESTOR, histOpts);
    const { digest: headDigest } = await rederivedDigestAt(lib, d1, CURRENT_HEAD, histOpts);
    ok('historical_digest_differs_from_advanced_head',
      liveDigest !== headDigest && /^[0-9a-f]{64}$/.test(liveDigest));

    // RED class: current-HEAD authority cannot match prior-ancestor live tags.
    {
      const h = makeHarness(lib, d1, histOpts);
      const headAuth = await lib.deriveD1Authority({ slug: SLUG }, h.deps);
      ok('red_head_authority_mismatches_ancestor_live_tags',
        headAuth.ok === true
        && headAuth.verifiedDeploySha === CURRENT_HEAD
        && headAuth.planDigest === headDigest
        && headAuth.planDigest !== liveDigest
        && headAuth.verifiedDeploySha !== LIVE_ANCESTOR);
    }

    const allDeletes = (hx) => hx.armLog.filter((x) => x.method === 'DELETE');
    const names = d1.deriveNames(SLUG, SUB);
    const contract = d1.buildExpectedResourceContract(names, { principalId: PID });
    const depId = (name) => `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Resources/deployments/${name}`;
    const ownedDepRows = ['messi-2d2-infra', names.acrPullModuleName, 'privateNetwork']
      .map((name) => ({
        id: depId(name), name, type: 'Microsoft.Resources/deployments',
        properties: { provisioningState: name === 'messi-2d2-infra' ? 'Failed' : 'Succeeded' },
      }));
    const subset = contract.foundationTopLevel.slice(0, 6).map((r) => {
      const tags = drillOwned(liveDigest, LIVE_ANCESTOR);
      return { id: r.id, name: r.name, type: r.type, tags, provisioningState: 'Succeeded' };
    });
    const tags = drillOwned(liveDigest, LIVE_ANCESTOR);

    // GREEN: legitimate prior-ancestor crash inventory rolls back under advanced HEAD.
    {
      const h = makeHarness(lib, d1, histOpts);
      h.setRg({ name: RG, tags });
      h.setResources(subset);
      h.setDeploymentsList(ownedDepRows);
      h.setNested({});
      h.setSecrets([]);
      const rb = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('green_rollback_prior_ancestor_crash_under_advanced_head',
        rb.ok === true && rb.deleted === true && rb.phase === 'infra-partial'
        && rb.historicalDeploySha === LIVE_ANCESTOR
        && rb.historicalPlanDigest === liveDigest
        && allDeletes(h).some((x) => /resourcegroups\//i.test(x.path || '')),
      rb.ok ? `phase=${rb.phase} sha=${rb.historicalDeploySha}` : JSON.stringify(rb.errors || rb).slice(0, 400));
    }

    // Current-SHA rollback unchanged (live deploySha === HEAD).
    {
      const curTags = drillOwned(headDigest, CURRENT_HEAD);
      const h = makeHarness(lib, d1, histOpts);
      h.setRg({ name: RG, tags: curTags });
      h.setResources(subset.map((r) => ({ ...r, tags: curTags })));
      h.setDeploymentsList(ownedDepRows);
      const rb = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('rollback_current_sha_unchanged',
        rb.ok === true && rb.deleted === true && rb.phase === 'infra-partial'
        && rb.historicalDeploySha === CURRENT_HEAD,
      rb.ok ? `sha=${rb.historicalDeploySha}` : JSON.stringify(rb.errors || rb).slice(0, 400));
    }

    // Attacks: nonancestor / side-branch / missing object / digest mismatch / tag drift /
    // wrong sub / dirty / non-master — all zero mutation.
    {
      const h = makeHarness(lib, d1, {
        ...histOpts,
        isAncestor: (anc, desc) => String(anc).toLowerCase() === String(desc).toLowerCase(),
      });
      h.setRg({ name: RG, tags });
      h.setResources(subset);
      h.setDeploymentsList(ownedDepRows);
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('attack_nonancestor_sha_zero_mutation',
        refuse.ok === false
        && (refuse.errors || []).some((e) => e.code === 'deploy_sha_not_ancestor'
          || e.code === 'deploy_sha_side_branch')
        && allDeletes(h).length === 0,
      JSON.stringify(refuse.errors || refuse).slice(0, 280));
    }
    {
      // Side-branch-only: ancestor of a divergent HEAD tip but not of origin/master.
      const h = makeHarness(lib, d1, {
        headSha: CURRENT_HEAD,
        originMasterSha: LIVE_ANCESTOR,
        verifiedDeploySha: CURRENT_HEAD,
        isAncestor: (anc, desc) => {
          const a = String(anc).toLowerCase();
          const d = String(desc).toLowerCase();
          if (a === d) return true;
          if (a === SIDE_BRANCH && d === CURRENT_HEAD) return true;
          if (a === LIVE_ANCESTOR && d === CURRENT_HEAD) return true;
          return false;
        },
      });
      const d1deps = d1.createDeps({
        repoRoot: ROOT, gitExec: h.deps.gitExec, azExec: h.deps.azExec,
        toolAuthority: h.deps.toolAuthority, snapshotAdapter: h.deps.snapshotAdapter,
        bicepBuildBytes: h.deps.bicepBuildBytes, verifiedDeploySha: CURRENT_HEAD,
      });
      const cand = d1.assertHistoricalDeployShaCandidate(d1deps, SIDE_BRANCH);
      ok('attack_side_branch_sha_zero_mutation',
        cand.ok === false
        && (cand.errors || []).some((e) => e.code === 'deploy_sha_side_branch'
          || e.code === 'deploy_sha_not_ancestor'),
      JSON.stringify(cand.errors || cand).slice(0, 280));
    }
    {
      const h = makeHarness(lib, d1, { ...histOpts, missingShas: [LIVE_ANCESTOR] });
      h.setRg({ name: RG, tags });
      h.setResources(subset);
      h.setDeploymentsList(ownedDepRows);
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('attack_missing_object_zero_mutation',
        refuse.ok === false
        && (refuse.errors || []).some((e) => e.code === 'deploy_sha_missing_object')
        && allDeletes(h).length === 0,
      JSON.stringify(refuse.errors || refuse).slice(0, 280));
    }
    {
      const h = makeHarness(lib, d1, { ...histOpts, nonCommitShas: [LIVE_ANCESTOR] });
      h.setRg({ name: RG, tags });
      h.setResources(subset);
      h.setDeploymentsList(ownedDepRows);
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('attack_non_commit_object_zero_mutation',
        refuse.ok === false
        && (refuse.errors || []).some((e) => e.code === 'deploy_sha_not_commit')
        && allDeletes(h).length === 0,
      JSON.stringify(refuse.errors || refuse).slice(0, 280));
    }
    {
      const badTags = { ...tags, planDigest: '0'.repeat(64) };
      const h = makeHarness(lib, d1, histOpts);
      h.setRg({ name: RG, tags: badTags });
      h.setResources(subset.map((r) => ({ ...r, tags: badTags })));
      h.setDeploymentsList(ownedDepRows);
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('attack_digest_mismatch_zero_mutation',
        refuse.ok === false
        && (refuse.errors || []).some((e) => e.code === 'historical_plan_digest_mismatch'
          || e.code === 'rollback_tag_mismatch')
        && allDeletes(h).length === 0,
      JSON.stringify(refuse.errors || refuse).slice(0, 280));
    }
    {
      // TOCTOU: tags change after probe / before locked re-read → refuse zero mutation.
      const h = makeHarness(lib, d1, histOpts);
      let reads = 0;
      const real = h.deps.armRequest;
      h.deps.armRequest = async (req) => {
        if (req.method === 'GET' && /resourcegroups\/[^/?]+(\?|$)/i.test(req.path || '')
          && !/providers\//i.test((req.path || '').split('resourcegroups/')[1] || '')) {
          reads += 1;
          if (reads === 1) {
            return {
              status: 200,
              body: { name: RG, tags },
              headers: { etag: '"etag-probe-1"' },
            };
          }
          return {
            status: 200,
            body: { name: RG, tags: { ...tags, planDigest: '1'.repeat(64) } },
            headers: { etag: '"etag-probe-2"' },
          };
        }
        return real(req);
      };
      h.setResources(subset);
      h.setDeploymentsList(ownedDepRows);
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('attack_tag_drift_after_lock_zero_mutation',
        refuse.ok === false
        && (refuse.errors || []).some((e) => e.code === 'tag_drift' || e.code === 'etag_race')
        && allDeletes(h).length === 0
        && reads >= 2,
      JSON.stringify(refuse.errors || refuse).slice(0, 280));
    }
    {
      const h = makeHarness(lib, d1, { ...histOpts, dirty: true });
      h.setRg({ name: RG, tags });
      h.setResources(subset);
      h.setDeploymentsList(ownedDepRows);
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('attack_dirty_tree_zero_mutation',
        refuse.ok === false
        && (refuse.errors || []).some((e) => e.code === 'dirty_tree')
        && allDeletes(h).length === 0,
      JSON.stringify(refuse.errors || refuse).slice(0, 280));
    }
    {
      const h = makeHarness(lib, d1, histOpts);
      h.setBranch('captain/feature');
      h.setRg({ name: RG, tags });
      h.setResources(subset);
      h.setDeploymentsList(ownedDepRows);
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('attack_non_master_checkout_zero_mutation',
        refuse.ok === false
        && (refuse.errors || []).some((e) => e.code === 'branch_not_master')
        && allDeletes(h).length === 0,
      JSON.stringify(refuse.errors || refuse).slice(0, 280));
    }
    {
      const h = makeHarness(lib, d1, {
        ...histOpts,
        headSha: CURRENT_HEAD,
        originMasterSha: 'a'.repeat(40), // HEAD != origin/master
        isAncestor: ancestorOf,
      });
      h.setRg({ name: RG, tags });
      h.setResources(subset);
      h.setDeploymentsList(ownedDepRows);
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('attack_head_not_synced_master_zero_mutation',
        refuse.ok === false
        && (refuse.errors || []).some((e) => e.code === 'not_synced_master')
        && allDeletes(h).length === 0,
      JSON.stringify(refuse.errors || refuse).slice(0, 280));
    }
    {
      const h = makeHarness(lib, d1, { ...histOpts, activeSub: '00000000-0000-0000-0000-000000000000' });
      h.setRg({ name: RG, tags });
      h.setResources(subset);
      h.setDeploymentsList(ownedDepRows);
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('attack_wrong_subscription_zero_mutation',
        refuse.ok === false
        && (refuse.errors || []).some((e) => e.code === 'subscription_mismatch')
        && allDeletes(h).length === 0,
      JSON.stringify(refuse.errors || refuse).slice(0, 280));
    }

    // Apply must NEVER accept historical authority (still HEAD-only; refuses pre-existing RG).
    {
      const h = makeHarness(lib, d1, histOpts);
      h.setRg({ name: RG, tags });
      const applied = await lib.apply({ slug: SLUG, ...approval() }, h.deps);
      ok('apply_never_accepts_historical_live_rg',
        applied.ok === false
        && (applied.errors || []).some((e) => e.code === 'rg_exists')
        && !((applied.receipt && applied.receipt.deploySha) === LIVE_ANCESTOR),
      JSON.stringify(applied.errors || applied).slice(0, 280));
      // Even if apply path is forced through deriveD1Authority, it is HEAD not live tags.
      const auth = await lib.deriveD1Authority({ slug: SLUG }, h.deps);
      ok('apply_authority_is_current_head_not_live_tags',
        auth.ok === true && auth.verifiedDeploySha === CURRENT_HEAD
        && auth.planDigest === headDigest
        && auth.verifiedDeploySha !== LIVE_ANCESTOR);
    }

    // Receipt remains diagnostic: poisoned receipt must not influence historical authority.
    {
      const h = makeHarness(lib, d1, histOpts);
      h.setRg({ name: RG, tags });
      h.setResources(subset);
      h.setDeploymentsList(ownedDepRows);
      fs.mkdirSync(h.stateDir, { recursive: true });
      fs.writeFileSync(path.join(h.stateDir, `${SLUG}.receipt.json`), JSON.stringify({
        schemaVersion: 1, kind: 'diagnostic_receipt_not_authority', status: 'apply_failed',
        tenantSlug: SLUG, planDigest: 'f'.repeat(64), deploySha: 'a'.repeat(40),
        phase: 'runtime', resourceGroupName: RG,
      }));
      const rb = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      ok('receipt_never_authority_for_historical_rollback',
        rb.ok === true && rb.deleted === true && rb.historicalDeploySha === LIVE_ANCESTOR
        && rb.historicalPlanDigest === liveDigest,
      rb.ok ? `sha=${rb.historicalDeploySha}` : JSON.stringify(rb.errors || rb).slice(0, 400));
    }
  }

  // ── Live residual recovery (xhOFOm): 12-resource infra-partial + JS AcrPull owner ──
  // Nested Bicep AcrPull removed; platform-supplemental Failure Anomalies smart detector
  // accepted only via exact contract; missing AcrPull OK in infra-partial; rollback deletes
  // whole RG + exact AcrPull (if present) + exact temp admin. Attacks: zero mutation.
  {
    const residualPath = path.join(ROOT,
      'fixtures/messi-saas-stage2d2/live-residual-12-resource-acrpull-missing.json');
    const residual = JSON.parse(fs.readFileSync(residualPath, 'utf8'));
    const authPreview = await lib.deriveD1Authority({ slug: SLUG }, makeHarness(lib, d1).deps);
    const tags = drillOwned(authPreview.planDigest);
    const names = d1.deriveNames(SLUG, SUB);
    const livePid = residual.principalId || PID;
    const contract = d1.buildExpectedResourceContract(names, { principalId: livePid });
    const platExp = d1.buildExpectedFailureAnomaliesSmartDetector(names);
    const depId = (name) => `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Resources/deployments/${name}`;
    const ownedDepRows = (residual.deployments || []).map((d) => ({
      id: depId(d.name),
      name: d.name,
      type: d.type || 'Microsoft.Resources/deployments',
      provisioningState: d.provisioningState || 'Succeeded',
      properties: { provisioningState: d.provisioningState || 'Succeeded' },
    }));
    // List rows stay sparse; harness GET returns exact provider GET body (live evidence).
    const sdListRow = residual.topLevelResources.find((r) => /smartDetector/i.test(r.type));
    const sdExactGet = residual.platformSupplemental && residual.platformSupplemental.exactGet;
    const sdExactPath = path.join(ROOT,
      'fixtures/messi-saas-stage2d2/failure-anomalies-smart-detector-exact-get.json');
    const sdExactFix = JSON.parse(fs.readFileSync(sdExactPath, 'utf8'));
    const residualResources = (residual.topLevelResources || []).map((r) => {
      if (/smartDetector/i.test(String(r.type || '')) && sdExactGet) {
        // Enriched GET body served by harness on smartDetectorAlertRules GET.
        // Keep list id for list↔GET identity (case-insensitive).
        return {
          id: r.id,
          name: sdExactGet.name || r.name,
          type: sdExactGet.type || r.type,
          location: sdExactGet.location,
          tags: sdExactGet.tags,
          properties: JSON.parse(JSON.stringify(sdExactGet.properties)),
          provisioningState: 'Succeeded',
        };
      }
      return {
        id: r.id, name: r.name, type: r.type, tags,
        provisioningState: 'Succeeded',
        properties: r.properties === undefined ? undefined : r.properties,
      };
    });
    const dnsLink = contract.nestedChildren.find((n) => n.type.includes('virtualNetworkLinks'));
    const appDb = contract.nestedChildren.find((n) => n.type.includes('flexibleServers/databases'));
    // Live residual (xhOFOm/cleanup-216): nested app DB + DNS link present; only AcrPull absent.
    // Seed both nested children so foundation residual path matches live (infra-partial also filters
    // missing nested, but foundation does not — and cleanup-216 classifies as foundation).
    const residualNested = {};
    if (appDb) residualNested[appDb.id] = { id: appDb.id, name: appDb.name, type: appDb.type };
    if (dnsLink) residualNested[dnsLink.id] = { id: dnsLink.id, name: dnsLink.name, type: dnsLink.type, tags };
    // KV role only (AcrPull never created in residual).
    const kvRole = contract.roleAssignments.find((r) => r.kind === 'kv');
    const residualRoles = kvRole ? {
      [String(kvRole.name).toLowerCase()]: {
        id: kvRole.id, name: kvRole.name,
        properties: {
          roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${kvRole.roleDefinitionId}`,
          principalId: livePid, scope: kvRole.scope, principalType: 'ServicePrincipal',
        },
      },
    } : {};
    const isSdGet = (p) => /smartDetectorAlertRules\//i.test(p)
      && /api-version=2019-03-01/i.test(p);

    ok('live_residual_fixture_shape',
      residual.kind === 'live_residual_infra_partial_fixture'
      && residual.tenantSlug === SLUG
      && residual.topLevelResources.length === 12
      && residual.acrPullPresent === false
      && residual.platformSupplemental.name === platExp.name
      && residual.acrPullRoleAssignmentName === contract.roleAssignments.find((r) => r.kind === 'acr').name
      && residual.principalId === livePid
      && sdExactGet && sdExactGet.location === 'global'
      && sdExactFix.apiVersion === d1.SMART_DETECTOR_API
      && d1.SMART_DETECTOR_API === '2019-03-01');

    ok('platform_supplemental_exact_contract',
      platExp.name === `Failure Anomalies - ${names.appInsightsName}`
      && platExp.type === d1.SMART_DETECTOR_ALERT_RULES_TYPE
      && platExp.id.toLowerCase() === String(sdListRow.id).toLowerCase()
      // Sparse generic /resources row (properties null) must NOT classify alone.
      && d1.isExactPlatformSupplementalSmartDetector(sdListRow, platExp, residualResources) === false
      // Live exact GET shape accepted.
      && d1.isExactPlatformSupplementalSmartDetector(sdExactGet, platExp, residualResources) === true
      && d1.isExactPlatformSupplementalSmartDetector(
        residualResources.find((r) => /smartDetector/i.test(r.type)),
        platExp,
        residualResources,
      ) === true
      && d1.FAILURE_ANOMALIES_FREQUENCY === 'PT1M'
      && d1.FAILURE_ANOMALIES_SEVERITY === 'Sev3'
      && d1.FAILURE_ANOMALIES_STATE === 'Enabled'
      && d1.FAILURE_ANOMALIES_DETECTOR_NAME === 'Failure Anomalies');

    // Attacks against smart-detector contract (zero acceptance).
    {
      const good = residualResources.find((r) => /smartDetector/i.test(r.type));
      const gprops = good.properties;
      const attacks = [
        ['lookalike_name', { ...good, name: residual.attacks.lookalikeSmartDetectorName,
          id: good.id.replace(good.name, residual.attacks.lookalikeSmartDetectorName) }],
        ['wrong_case_name', { ...good, name: residual.attacks.wrongCaseSmartDetectorName,
          id: good.id.replace(good.name, residual.attacks.wrongCaseSmartDetectorName) }],
        ['wrong_type', { ...good, type: residual.attacks.wrongType }],
        ['wrong_sub', { ...good, id: good.id.replace(SUB, residual.attacks.wrongSubId) }],
        ['wrong_rg', { ...good, id: good.id.replace(RG, residual.attacks.wrongRg) }],
        ['missing_ai_linkage', good], // evaluated without AI in topLevel
        ['props_null', { ...good, properties: null }],
        ['props_absent', (() => { const x = { ...good }; delete x.properties; return x; })()],
        ['props_empty', { ...good, properties: {} }],
        ['extra_scope', { ...good, properties: {
          ...gprops,
          scope: [gprops.scope[0], `${gprops.scope[0]}${residual.attacks.extraScopeSuffix}`],
        } }],
        ['wrong_detector_id', { ...good, properties: {
          ...gprops, detector: { ...gprops.detector, id: residual.attacks.wrongDetectorId },
        } }],
        ['wrong_detector_name', { ...good, properties: {
          ...gprops, detector: { ...gprops.detector, name: 'Failure Anomalies X' },
        } }],
        ['extra_supported_type', { ...good, properties: {
          ...gprops,
          detector: {
            ...gprops.detector,
            supportedResourceTypes: ['ApplicationInsights', 'LogAnalytics'],
          },
        } }],
        ['wrong_frequency', { ...good, properties: {
          ...gprops, frequency: residual.attacks.wrongFrequency,
        } }],
        ['wrong_severity', { ...good, properties: {
          ...gprops, severity: residual.attacks.wrongSeverity,
        } }],
        ['wrong_state', { ...good, properties: {
          ...gprops, state: residual.attacks.wrongState,
        } }],
        ['wrong_location', { ...good, location: residual.attacks.wrongLocation }],
        ['nonempty_tags', { ...good, tags: residual.attacks.nonEmptyTags }],
      ];
      let attackPass = 0;
      for (const [label, row] of attacks) {
        const top = label === 'missing_ai_linkage'
          ? residualResources.filter((r) => r.type !== 'Microsoft.Insights/components')
          : residualResources;
        if (d1.isExactPlatformSupplementalSmartDetector(row, platExp, top) === false) attackPass += 1;
        else ok(`platform_supplemental_attack_${label}_refused`, false);
      }
      ok('platform_supplemental_attacks_refused', attackPass === attacks.length,
        `pass=${attackPass}/${attacks.length}`);
    }

    // Collect + phase: residual accepted as infra-partial via exact GET readback;
    // missing AcrPull not a finding; topLevel uses enriched GET row (not list props null).
    {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources(residualResources);
      h.setNested(residualNested);
      h.setSecrets([]);
      h.setRoles(residualRoles);
      h.setMi({ properties: { principalId: livePid } });
      h.setDeploymentsList(ownedDepRows);
      const inv = await d1.collectLiveInventory(h.deps, names, tags);
      inv.rgExists = true;
      const phase = d1.inferLivePhase(inv);
      const findings = d1.phaseContractFindings(inv, phase);
      const sdLive = (inv.topLevel || []).find((r) => /smartDetector/i.test(String(r.type || '')));
      const sdGets = h.armLog.filter((x) => x.method === 'GET' && isSdGet(x.path || ''));
      const platLive = inv.platformSupplementalLive || [];
      ok('live_residual_collect_infra_partial',
        inv.ok === true
        && phase === 'infra-partial'
        && d1.isExactInfraPartialLive(inv) === true
        && findings.length === 0
        && (inv.findings || []).some((f) => f.code === 'missing_role_assignment' && f.kind === 'acr')
        && !(inv.findings || []).some((f) => f.code === 'unexpected_resource'
          && /smartDetector/i.test(String(f.type || '')))
        && sdGets.length >= 1
        && platLive.length === 1
        && sdLive
        && sdLive.location === 'global'
        && sdLive.properties && sdLive.properties.frequency === 'PT1M'
        && sdLive.properties.severity === 'Sev3'
        && sdLive.properties.state === 'Enabled'
        && Array.isArray(sdLive.properties.scope) && sdLive.properties.scope.length === 1
        && String(sdLive.properties.detector && sdLive.properties.detector.id)
          === d1.FAILURE_ANOMALIES_DETECTOR_ID
        && d1.isExactPlatformSupplementalSmartDetector(sdLive, platExp, inv.topLevel) === true,
        inv.ok
          ? `phase=${phase} sdGets=${sdGets.length} plat=${platLive.length} freq=${sdLive && sdLive.properties && sdLive.properties.frequency}`
          : JSON.stringify(inv.errors || inv).slice(0, 400));
    }

    // RED: smart-detector GET 403/404/500 fail closed (no soft classify on list row).
    for (const [label, status, code] of [
      ['get_403_fail_closed', 403, 'arm_get_failed'],
      ['get_404_fail_closed', 404, 'arm_get_failed'],
      ['get_500_fail_closed', 500, 'arm_get_failed'],
    ]) {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources(residualResources);
      h.setNested(residualNested);
      h.setSecrets([]);
      h.setRoles(residualRoles);
      h.setMi({ properties: { principalId: livePid } });
      h.setDeploymentsList(ownedDepRows);
      const realArm = h.deps.armRequest;
      h.deps.armRequest = async (req) => (req.method === 'GET'
        && /smartDetectorAlertRules\//i.test(req.path || '')
        ? { status, body: status === 404 ? {} : { error: { code: 'HarnessForced' } }, headers: {} }
        : realArm(req));
      const inv = await d1.collectLiveInventory(h.deps, names, tags);
      ok(`collect_live_inventory_smart_detector_${label}`, inv.ok === false
        && (inv.errors || []).some((e) => e.code === code));
    }

    // RED: sparse list-only body (properties null, no location) refused — not platform-supplemental.
    {
      const sparseOnly = residualResources.map((r) => (/smartDetector/i.test(String(r.type || ''))
        ? {
          id: r.id, name: r.name, type: r.type, tags: {},
          properties: null, provisioningState: 'Succeeded',
        }
        : r));
      const hInv = makeHarness(lib, d1);
      hInv.setRg({ name: RG, tags });
      hInv.setResources(sparseOnly);
      hInv.setNested(residualNested);
      hInv.setSecrets([]);
      hInv.setRoles(residualRoles);
      hInv.setMi({ properties: { principalId: livePid } });
      hInv.setDeploymentsList(ownedDepRows);
      const inv = await d1.collectLiveInventory(hInv.deps, names, tags);
      const hRb = makeHarness(lib, d1);
      hRb.setRg({ name: RG, tags });
      hRb.setResources(sparseOnly);
      hRb.setNested(residualNested);
      hRb.setSecrets([]);
      hRb.setRoles(residualRoles);
      hRb.setMi({ properties: { principalId: livePid } });
      hRb.setDeploymentsList(ownedDepRows);
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, hRb.deps);
      const dels = hRb.armLog.filter((x) => x.method === 'DELETE');
      ok('sparse_list_smart_detector_refused_zero_mutation',
        inv.ok === true
        && (inv.findings || []).some((f) => f.code === 'unexpected_resource'
          && /smartDetector|Failure Anomalies/i.test(String(f.name || f.type || '')))
        && refuse.ok === false
        && dels.length === 0,
        inv.ok
          ? `findings=${JSON.stringify(inv.findings).slice(0, 200)} rbOk=${refuse.ok}`
          : JSON.stringify(inv.errors || inv).slice(0, 300));
    }

    // GREEN rollback: whole RG + AcrPull absent (never created) + temp admin.
    {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources(residualResources);
      h.setNested(residualNested);
      h.setSecrets([]);
      h.setRoles(residualRoles);
      h.setMi({ properties: { principalId: livePid } });
      h.setDeploymentsList(ownedDepRows);
      // Seed temp ACR RBAC-admin present (exact prepared name).
      const prep = lib.buildPreparedRoleAssignments(names);
      const temp = prep.find((r) => r.kind === 'acr-rbac-admin-temp');
      const rolesMap = { ...residualRoles };
      rolesMap[String(temp.name).toLowerCase()] = {
        id: temp.id, name: temp.name,
        properties: {
          roleDefinitionId: temp.roleDefinitionResourceId,
          principalId: lib.EXECUTOR_UAI_OID,
          scope: temp.scope,
          principalType: 'ServicePrincipal',
        },
      };
      h.setRoles(rolesMap);
      const rb = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      const rgDel = h.armLog.filter((x) => x.method === 'DELETE'
        && /resourcegroups\/[^/?]+(\?|$)/i.test(x.path || '')
        && !/providers\//i.test((x.path || '').split('resourcegroups/')[1] || ''));
      const acrPullName = contract.roleAssignments.find((r) => r.kind === 'acr').name;
      const acrPullDel = h.armLog.filter((x) => x.method === 'DELETE'
        && new RegExp(`roleAssignments/${acrPullName}`, 'i').test(x.path || ''));
      const tempDel = h.armLog.filter((x) => x.method === 'DELETE'
        && new RegExp(`roleAssignments/${temp.name}`, 'i').test(x.path || ''));
      ok('live_residual_rollback_green',
        rb.ok === true && rb.deleted === true && rb.phase === 'infra-partial'
        && rb.acrTempRoleAbsent === true && rb.acrPullRoleAbsent === true
        && rgDel.length === 1
        && acrPullDel.length === 0 // never present — GET 404, no DELETE required
        && tempDel.length === 1,
        rb.ok
          ? `phase=${rb.phase} rgDel=${rgDel.length} tempDel=${tempDel.length}`
          : JSON.stringify(rb.errors || rb.findings || rb).slice(0, 500));
    }

    // When exact AcrPull IS present, rollback must DELETE it after RG (before temp admin).
    {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources(residualResources);
      h.setNested(residualNested);
      h.setSecrets([]);
      h.setMi({ properties: { principalId: livePid } });
      h.setDeploymentsList(ownedDepRows);
      const acrRole = contract.roleAssignments.find((r) => r.kind === 'acr');
      const prep = lib.buildPreparedRoleAssignments(names);
      const temp = prep.find((r) => r.kind === 'acr-rbac-admin-temp');
      h.setRoles({
        [String(kvRole.name).toLowerCase()]: residualRoles[String(kvRole.name).toLowerCase()],
        [String(acrRole.name).toLowerCase()]: {
          id: acrRole.id, name: acrRole.name,
          properties: {
            roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${acrRole.roleDefinitionId}`,
            principalId: livePid, scope: acrRole.scope, principalType: 'ServicePrincipal',
          },
        },
        [String(temp.name).toLowerCase()]: {
          id: temp.id, name: temp.name,
          properties: {
            roleDefinitionId: temp.roleDefinitionResourceId,
            principalId: lib.EXECUTOR_UAI_OID, scope: temp.scope, principalType: 'ServicePrincipal',
          },
        },
      });
      const rb = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      const delOrder = h.armLog
        .filter((x) => x.method === 'DELETE')
        .map((x) => x.path || '');
      const rgIdx = delOrder.findIndex((p) => /resourcegroups\/[^/?]+(\?|$)/i.test(p)
        && !/providers\//i.test((p.split('resourcegroups/')[1] || '')));
      const acrPullIdx = delOrder.findIndex((p) => new RegExp(`roleAssignments/${acrRole.name}`, 'i').test(p));
      const tempIdx = delOrder.findIndex((p) => new RegExp(`roleAssignments/${temp.name}`, 'i').test(p));
      ok('rollback_deletes_acrpull_then_temp_admin',
        rb.ok === true && rb.acrPullRoleAbsent === true && rb.acrTempRoleAbsent === true
        && rgIdx >= 0 && acrPullIdx > rgIdx && tempIdx > acrPullIdx,
        `order rg=${rgIdx} acrPull=${acrPullIdx} temp=${tempIdx} ok=${rb.ok}`);
    }

    // Attack: unexpected foreign role remains refused with zero mutation.
    {
      const h = makeHarness(lib, d1);
      h.setRg({ name: RG, tags });
      h.setResources(residualResources);
      h.setNested(residualNested);
      h.setSecrets([]);
      h.setMi({ properties: { principalId: livePid } });
      h.setDeploymentsList(ownedDepRows);
      h.setRoles({
        ...residualRoles,
        [residual.attacks.foreignRoleName]: {
          id: `${contract.roleAssignments.find((r) => r.kind === 'acr').scope}/providers/Microsoft.Authorization/roleAssignments/${residual.attacks.foreignRoleName}`,
          name: residual.attacks.foreignRoleName,
          properties: {
            roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${d1.ROLE_ACR_PULL}`,
            principalId: residual.attacks.wrongAcrPullPrincipal,
            scope: contract.roleAssignments.find((r) => r.kind === 'acr').scope,
            principalType: 'ServicePrincipal',
          },
        },
      });
      // Foreign role on ACR is not in live inventory findings path via exact GET of expected only —
      // unexpected smart-detector lookalike as resource row does refuse.
      h.setResources([...residualResources, {
        id: residualResources.find((r) => /smartDetector/i.test(r.type)).id.replace(
          residual.platformSupplemental.name,
          residual.attacks.lookalikeSmartDetectorName,
        ),
        name: residual.attacks.lookalikeSmartDetectorName,
        type: d1.SMART_DETECTOR_ALERT_RULES_TYPE,
        tags: {},
        provisioningState: 'Succeeded',
      }]);
      const refuse = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
      const anyDel = h.armLog.filter((x) => x.method === 'DELETE');
      ok('live_residual_lookalike_smart_detector_refused_zero_mutation',
        refuse.ok === false && anyDel.length === 0
        && ((refuse.findings || []).some((f) => f.code === 'unexpected_resource'
          || f.code === 'duplicate_resource')
          || (refuse.errors || []).some((e) => e.code === 'inventory_findings'
            || e.code === 'rollback_phase_invalid')),
        JSON.stringify(refuse.findings || refuse.errors || refuse).slice(0, 300));
    }

    // residual-cleanup-216: live residual classifies as foundation (Succeeded FA deploy is
    // not the Failed MissingSubscriptionRegistration signature → not infra-partial). D1 still
    // emits missing_role_assignment kind=acr; phaseContractFindings must permit it before
    // top-level inventory_findings refuse so full rollback reaches exact inventory gate +
    // canonical order (RG → exact AcrPull if present → temp admin). Missing KV still zero mut.
    {
      const faSucceeded = {
        id: depId('Failure-Anomalies-Alert-Rule-Deployment-ea8f51b8'),
        name: 'Failure-Anomalies-Alert-Rule-Deployment-ea8f51b8',
        type: 'Microsoft.Resources/deployments',
        provisioningState: 'Succeeded',
        properties: { provisioningState: 'Succeeded' },
      };
      const depRowsFoundation = [...ownedDepRows, faSucceeded];
      const prep = lib.buildPreparedRoleAssignments(names);
      const temp = prep.find((r) => r.kind === 'acr-rbac-admin-temp');
      const acrRole = contract.roleAssignments.find((r) => r.kind === 'acr');

      // Collect: foundation phase + live missing AcrPull finding + classifier permits it.
      {
        const h = makeHarness(lib, d1);
        h.setRg({ name: RG, tags });
        h.setResources(residualResources);
        h.setNested(residualNested);
        h.setSecrets([]);
        h.setRoles(residualRoles);
        h.setMi({ properties: { principalId: livePid } });
        h.setDeploymentsList(depRowsFoundation);
        const inv = await d1.collectLiveInventory(h.deps, names, tags);
        inv.rgExists = true;
        const phase = d1.inferLivePhase(inv);
        const classified = d1.phaseContractFindings(inv, phase);
        const liveMissingAcr = (inv.findings || []).some((f) => f.code === 'missing_role_assignment'
          && f.kind === 'acr'
          && String(f.name || '') === String(acrRole.name));
        ok('live_residual_foundation_missing_acrpull_classified_permitted',
          inv.ok === true
          && phase === 'foundation'
          && d1.isExactInfraPartialLive(inv) === false
          && liveMissingAcr === true
          && d1.isPermittedAbsentTenantAcrPullFinding({
            code: 'missing_role_assignment', kind: 'acr', name: acrRole.name,
          }) === true
          && d1.isPermittedAbsentTenantAcrPullFinding({
            code: 'missing_role_assignment', kind: 'kv', name: kvRole.name,
          }) === false
          && classified.length === 0,
          inv.ok
            ? `phase=${phase} liveAcr=${liveMissingAcr} classified=${JSON.stringify(classified).slice(0, 200)}`
            : JSON.stringify(inv.errors || inv).slice(0, 400));
      }

      // Full rollback path GREEN: inventory gate accepts, canonical delete order.
      {
        const h = makeHarness(lib, d1);
        h.setRg({ name: RG, tags });
        h.setResources(residualResources);
        h.setNested(residualNested);
        h.setSecrets([]);
        h.setMi({ properties: { principalId: livePid } });
        h.setDeploymentsList(depRowsFoundation);
        const rolesMap = { ...residualRoles };
        rolesMap[String(temp.name).toLowerCase()] = {
          id: temp.id, name: temp.name,
          properties: {
            roleDefinitionId: temp.roleDefinitionResourceId,
            principalId: lib.EXECUTOR_UAI_OID,
            scope: temp.scope,
            principalType: 'ServicePrincipal',
          },
        };
        h.setRoles(rolesMap);
        const rb = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
        const delOrder = h.armLog
          .filter((x) => x.method === 'DELETE')
          .map((x) => x.path || '');
        const rgIdx = delOrder.findIndex((p) => /resourcegroups\/[^/?]+(\?|$)/i.test(p)
          && !/providers\//i.test((p.split('resourcegroups/')[1] || '')));
        const acrPullIdx = delOrder.findIndex((p) => new RegExp(`roleAssignments/${acrRole.name}`, 'i').test(p));
        const tempIdx = delOrder.findIndex((p) => new RegExp(`roleAssignments/${temp.name}`, 'i').test(p));
        ok('live_residual_foundation_missing_acrpull_full_rollback_green',
          rb.ok === true && rb.deleted === true && rb.phase === 'foundation'
          && !(rb.errors || []).some((e) => e.code === 'inventory_findings')
          && rb.acrTempRoleAbsent === true && rb.acrPullRoleAbsent === true
          && rgIdx >= 0 && acrPullIdx < 0 && tempIdx > rgIdx,
          rb.ok
            ? `phase=${rb.phase} order rg=${rgIdx} acrPull=${acrPullIdx} temp=${tempIdx}`
            : JSON.stringify(rb.errors || rb.findings || rb).slice(0, 500));
      }

      // Attack: missing KV role (not permitted) → inventory_findings + zero mutation.
      {
        const h = makeHarness(lib, d1);
        h.setRg({ name: RG, tags });
        h.setResources(residualResources);
        h.setNested(residualNested);
        h.setSecrets([]);
        h.setMi({ properties: { principalId: livePid } });
        h.setDeploymentsList(depRowsFoundation);
        h.setRoles({}); // no KV, no AcrPull
        const rb = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
        const anyDel = h.armLog.filter((x) => x.method === 'DELETE');
        ok('live_residual_foundation_missing_kv_zero_mutation',
          rb.ok === false && anyDel.length === 0
          && (rb.errors || []).some((e) => e.code === 'inventory_findings')
          && (rb.findings || []).some((f) => f.code === 'missing_role_assignment' && f.kind === 'kv')
          && !(rb.findings || []).some((f) => f.code === 'missing_role_assignment' && f.kind === 'acr'),
          rb.ok
            ? 'unexpected ok'
            : `findings=${JSON.stringify(rb.findings || []).slice(0, 240)} dels=${anyDel.length}`);
      }
    }

    // JS AcrPull PUT after infra: exact principal/type/role/scope + fail-closed before bootstrap.
    {
      const h = makeHarness(lib, d1);
      const names2 = d1.deriveNames(SLUG, SUB);
      h.seedRoles(names2, { acrPull: false }); // KV only — apply must PUT AcrPull
      h.setJob({ id: 'job', name: names2.bootstrapJobName, tags: {} });
      h.setApp(runtimeAppBody(names2));
      const r = await lib.apply({ slug: SLUG, ...approval() }, h.deps);
      const acrRole = d1.buildExpectedResourceContract(names2, { principalId: PID })
        .roleAssignments.find((x) => x.kind === 'acr');
      const puts = h.armLog.filter((x) => x.method === 'PUT'
        && new RegExp(`roleAssignments/${acrRole.name}`, 'i').test(x.path || ''));
      ok('apply_puts_exact_acrpull_after_infra',
        r.ok === true && puts.length >= 1
        && puts[0].body && puts[0].body.properties
        && String(puts[0].body.properties.principalId) === PID
        && String(puts[0].body.properties.principalType) === 'ServicePrincipal'
        && String(puts[0].body.properties.roleDefinitionId).toLowerCase()
          .endsWith(String(d1.ROLE_ACR_PULL).toLowerCase())
        && r.receipt && r.receipt.acrPullRoleAssignment
        && String(r.receipt.acrPullRoleAssignment.id).toLowerCase() === String(acrRole.id).toLowerCase(),
        r.ok
          ? `puts=${puts.length} receipt=${!!(r.receipt && r.receipt.acrPullRoleAssignment)}`
          : JSON.stringify(r.errors || r).slice(0, 400));
    }

    // PUT failure fails closed before bootstrap deploy.
    {
      const h = makeHarness(lib, d1);
      const names2 = d1.deriveNames(SLUG, SUB);
      h.seedRoles(names2, { acrPull: false });
      const acrRole = d1.buildExpectedResourceContract(names2, { principalId: PID })
        .roleAssignments.find((x) => x.kind === 'acr');
      const real = h.deps.armRequest;
      h.deps.armRequest = async (req) => {
        if (req.method === 'PUT'
          && new RegExp(`roleAssignments/${acrRole.name}`, 'i').test(req.path || '')) {
          return { status: 403, body: { error: { code: 'AuthorizationFailed' } }, headers: {} };
        }
        return real(req);
      };
      const r = await lib.apply({ slug: SLUG, ...approval() }, h.deps);
      const bootPuts = h.armLog.filter((x) => x.method === 'PUT'
        && /deployments\/messi-2d2-bootstrap/i.test(x.path || ''));
      ok('acrpull_put_fail_closed_before_bootstrap',
        r.ok === false && r.phase === 'acr-pull'
        && (r.errors || []).some((e) => e.code === 'acr_pull_put_failed')
        && bootPuts.length === 0,
        r.ok ? 'unexpected ok' : `phase=${r.phase} bootPuts=${bootPuts.length}`);
    }

    // Bicep source: no nested AcrPull module.
    {
      const mainSrc = fs.readFileSync(
        path.join(ROOT, 'infra/azure/modules/tenant-staging/main.bicep'), 'utf8',
      );
      const acrJson = fs.readFileSync(
        path.join(ROOT, 'infra/azure/modules/tenant-staging/acr-pull-role.json'), 'utf8',
      );
      ok('bicep_acr_pull_disabled',
        !/module\s+acrPullRole\b/.test(mainSrc)
        && !/dependsOn:[\s\S]{0,200}acrPullRole/.test(mainSrc)
        && /JS apply|roleAssignments PUT|JS-owned/i.test(mainSrc)
        && /"resources"\s*:\s*\[\s*\]/.test(acrJson)
        && /DISABLED|historical residual/i.test(acrJson));
    }
  }

  // Live e083a457: exact deploy-shape AuthorizationFailed only (quoted OID/action/scope; no substrings).
  {
    const rgScope = `/subscriptions/${SUB}/resourceGroups/${RG}`;
    const writeAct = 'Microsoft.Network/privateDnsZones/virtualNetworkLinks/write';
    const oid = lib.EXECUTOR_UAI_OID;
    const authzMsg = (o, sc, act) => (
      `The client 'appid' with object id '${o}' does not have authorization to perform action `
      + `'${act}' over scope '${sc}/providers/Microsoft.Network/privateDnsZones/z/virtualNetworkLinks/l' `
      + 'or the scope is invalid. If access was recently granted, please refresh your credentials.'
    );
    const failedBody = (msg, outer = 'DeploymentFailed') => ({
      properties: {
        provisioningState: 'Failed',
        error: {
          code: outer, message: 'At least one resource deployment operation failed.',
          details: [{
            code: 'DeploymentFailed', message: 'nested privateNetwork failed',
            details: [{ code: 'AuthorizationFailed', message: msg }],
          }],
        },
      },
    });
    const prose = authzMsg(oid, rgScope, writeAct);
    const liveAuthz = failedBody(prose);
    const classify = lib.classifyRetryableRbacPropagationFailure;
    const ctx = { executorOid: oid, resourceGroupScope: rgScope };
    const cOk = classify(liveAuthz, ctx);
    ok('rbac_prop_exact_classification_retryable',
      cOk && cOk.retryable === true && cOk.code === 'AuthorizationFailed' && cOk.action === writeAct);
    // Hostile: wrong OID/RG/action, root/direct prose, RG/principal lookalikes, bad quotes.
    const attacks = [
      failedBody(authzMsg('00000000-0000-0000-0000-000000000099', rgScope, writeAct)),
      failedBody(authzMsg(oid, `/subscriptions/${SUB}/resourceGroups/wh-staging-rg`, writeAct)),
      failedBody(authzMsg(oid, rgScope, 'Microsoft.Network/privateDnsZones/read')),
      { properties: { provisioningState: 'Failed', error: { code: 'ResourceNotFound', message: 'x' } } },
      { properties: { provisioningState: 'Failed' } },
      { error: { code: 'AuthorizationFailed', message: 'denied' } },
      failedBody(authzMsg(oid, `${rgScope}-evil`, writeAct)),
      failedBody(authzMsg(`${oid}0`, rgScope, writeAct)),
      { error: { code: 'AuthorizationFailed', message: prose } },
      { properties: { provisioningState: 'Failed', error: { code: 'AuthorizationFailed', message: prose } } },
      failedBody(`object id '${oid}' object id '00000000-0000-0000-0000-000000000001' perform action '${writeAct}' over scope '${rgScope}/providers/x' If access was recently granted, please refresh your credentials.`),
      failedBody(`object id '${oid}' perform action '${writeAct}'. If access was recently granted, please refresh your credentials.`),
      failedBody(prose, 'LinkedAuthorizationFailed'),
    ];
    ok('rbac_prop_hostile_classification_refused',
      attacks.every((b) => classify(b, ctx).retryable === false), `n=${attacks.length}`);
    const base = {
      path: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Resources/deployments/messi-2d2-infra?api-version=2021-04-01`,
      body: { properties: { mode: 'Incremental', template: TPL, parameters: {} } },
      createdAt: CREATED, expiresAt: EXPIRES, phase: 'infra',
    };
    const putOk = { status: 201, body: { properties: { provisioningState: 'Accepted' } }, headers: {} };
    const deps = (armRequest, clock) => ({
      abortState: {}, now: () => new Date(clock != null ? clock() : CREATED),
      sleep: async (ms) => { if (clock) clock(Number(ms) || 0); }, armRequest,
    });
    {
      let puts = 0;
      const r = await lib.putAndPollWithRbacPropagationRetry(deps(async (req) => (
        req.method === 'PUT' ? (puts += 1, putOk) : { status: 200, body: liveAuthz, headers: {} }
      )), base);
      const maxA = lib.RBAC_PROPAGATION_MAX_ATTEMPTS;
      ok('rbac_prop_retry_exhaustion_fail_closed',
        r.ok === false && r.attempts === maxA && puts === maxA
        && (r.errors || []).some((e) => e.code === 'arm_terminal_failed')
        && (r.errors || []).some((e) => e.code === 'rbac_propagation_retries_exhausted')
        && Array.isArray(r.attemptErrors) && r.attemptErrors.length === maxA);
    }
    {
      let puts = 0; let gets = 0; let t = Date.parse(CREATED);
      const r = await lib.putAndPollWithRbacPropagationRetry(deps(async (req) => {
        if (req.method === 'PUT') { puts += 1; return putOk; }
        gets += 1;
        return puts === 1 ? { status: 200, body: liveAuthz, headers: {} }
          : { status: 200, body: { properties: { provisioningState: 'Succeeded' } }, headers: {} };
      }, (d) => (d == null ? t : (t += d, t))), base);
      ok('rbac_prop_eventual_success_after_retry', r.ok === true && r.attempts === 2 && puts === 2 && gets >= 2);
    }
    {
      let armCalls = 0;
      const d = deps(async () => { armCalls += 1; return { status: 200, body: {}, headers: {} }; });
      const rolePath = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Authorization/roleAssignments/x?api-version=2022-04-01`;
      const rRole = await lib.putAndPollWithRbacPropagationRetry(d, { ...base, path: rolePath, body: {} });
      const rGet = await lib.putAndPollWithRbacPropagationRetry(d, { ...base, method: 'GET' });
      ok('rbac_prop_hostile_non_deployment_wrapper_refused',
        rRole.ok === false && rGet.ok === false && armCalls === 0 && rRole.attempts === 0
        && (rRole.errors || []).some((e) => e.code === 'rbac_retry_not_deployment_put')
        && (rGet.errors || []).some((e) => e.code === 'rbac_retry_not_deployment_put'));
    }
    {
      let puts = 0;
      const r = await lib.putAndPollWithRbacPropagationRetry(deps(async (req) => {
        if (req.method !== 'PUT') { puts += 100; return { status: 200, body: {}, headers: {} }; }
        puts += 1;
        return { status: 403, body: { error: { code: 'AuthorizationFailed', message: prose } }, headers: {} };
      }), base);
      ok('rbac_prop_hostile_direct_http_403_one_put_zero_retries',
        r.ok === false && puts === 1 && r.attempts === 1
        && (r.errors || []).some((e) => e.code === 'arm_put_failed')
        && !(r.errors || []).some((e) => e.code === 'rbac_propagation_retries_exhausted')
        && r.rbacPropagation && r.rbacPropagation.retryable === false);
    }
    ok('rbac_prop_apply_uses_retry_boundary',
      /putAndPollWithRbacPropagationRetry/.test(fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8'))
      && typeof lib.putAndPollWithRbacPropagationRetry === 'function'
      && lib.RBAC_PROPAGATION_MAX_ATTEMPTS >= 2 && lib.RBAC_PROPAGATION_MAX_ATTEMPTS <= 5);
  }

  // Lifecycle: default temporary unchanged; internal durable-staging via real apply path.
  {
    const baseAuth = await lib.deriveD1Authority({ slug: SLUG }, makeHarness(lib, d1).deps);
    const bound = lib.bindLifecyclePlanDigest(baseAuth.planDigest, lib.LIFECYCLE_DURABLE);
    ok('default_lifecycle_digest_unbound',
      lib.resolveLifecycleMode({}).mode === lib.LIFECYCLE_TEMPORARY
      && lib.bindLifecyclePlanDigest(baseAuth.planDigest, lib.LIFECYCLE_TEMPORARY) === baseAuth.planDigest
      && bound !== baseAuth.planDigest
      && !/_internalDurableLifecycle|lifecycleMode|durable-staging|lifecycle-mode/.test(
        fs.readFileSync(path.join(ROOT, CLI_REL), 'utf8'),
      )
      && /temporary-drill|durable-staging|_internalDurableLifecycle|zero mutation/i.test(doc));
    const hCli = makeHarness(lib, d1);
    const rCli = await lib.apply({ slug: SLUG, ...approval(), lifecycleMode: 'durable-staging' }, hCli.deps);
    ok('public_cli_lifecycle_activation_refused',
      !rCli.ok && rCli.refusedBeforeAzureMutation
      && !hCli.armLog.some((x) => ['PUT', 'DELETE', 'PATCH'].includes(x.method))
      && (rCli.errors || []).some((e) => e.code === 'lifecycle_mode_cli_forbidden'));
    const hOk = makeHarness(lib, d1);
    const names = d1.deriveNames(SLUG, SUB);
    hOk.seedRoles(names);
    hOk.setJob({
      id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/jobs/${names.bootstrapJobName}`,
      name: names.bootstrapJobName, tags: {},
    });
    const app = runtimeAppBody(names);
    app.id = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/${names.staffApiAppName}`;
    app.properties.latestRevisionName = `${names.staffApiAppName}--rev1`;
    app.properties.template.scale = { minReplicas: 1, maxReplicas: 1 };
    hOk.setApp(app);
    const rOk = await lib.apply({ slug: SLUG, _internalDurableLifecycle: true }, hOk.deps);
    const rec = lib.readReceipt(hOk.deps, SLUG);
    const tags = ((hOk.armLog.filter((x) => x.method === 'PUT'
      && /resourcegroups\/[^/?]+(\?|$)/i.test(x.path || '')).pop() || {}).body || {}).tags || {};
    ok('durable_mocked_success_preserved',
      rOk.ok && rOk.lifecycleMode === lib.LIFECYCLE_DURABLE && rOk.destroyAfterSuccess === false
      && rOk.planDigest === bound && rec && rec.lifecycleMode === lib.LIFECYCLE_DURABLE
      && rec.durableStaging === true && rec.temporaryDrill === false && rec.createdAt == null
      && tags.durableStaging === 'true' && tags.temporaryDrill == null && tags.planDigest === bound
      && !hOk.armLog.some((x) => x.method === 'DELETE' && /resourcegroups\/[^/?]+(\?|$)/i.test(x.path || '')
        && !/providers\//i.test((x.path || '').split('resourcegroups/')[1] || '')));
    const hFail = makeHarness(lib, d1);
    hFail.setPutFailPath('messi-2d2-infra');
    const rFail = await lib.apply({ slug: SLUG, _internalDurableLifecycle: true, rollbackOnFailure: true }, hFail.deps);
    ok('durable_mocked_failure_rolled_back',
      !rFail.ok && rFail.rollbackOnFailure && rFail.rollbackOnFailure.ok && rFail.rollbackOnFailure.deleted);
    const hX = makeHarness(lib, d1);
    const dTags = lib.durableLifecycleTags({ tenantSlug: SLUG, planDigest: bound, deploySha: SHA });
    hX.setRg({ name: RG, tags: dTags }); hX.seedFoundation(dTags);
    const rbPublic = await lib.rollback({ slug: SLUG, confirmDelete: RG }, hX.deps);
    const replay = await lib.deriveD1HistoricalRollbackAuthority({
      slug: SLUG, liveDeploySha: SHA, livePlanDigest: baseAuth.planDigest, lifecycleMode: lib.LIFECYCLE_DURABLE,
    }, hX.deps);
    ok('cross_mode_takeover_replay_refused',
      !rbPublic.ok && (rbPublic.errors || []).some((e) => e.code === 'durable_rollback_not_public')
      && !replay.ok && (replay.errors || []).some((e) => /plan_digest|digest/i.test(e.code || ''))
      && !lib.assertDurableLifecycleTags(drillOwned(baseAuth.planDigest), {
        tenantSlug: SLUG, planDigest: bound, deploySha: SHA,
      }).ok
      && !lib.assertDrillTags(dTags, {
        tenantSlug: SLUG, planDigest: bound, deploySha: SHA, createdAt: CREATED, expiresAt: EXPIRES,
      }).ok);
  }

  const st = diffStat();
  ok('file_budget', st.files <= 14, `files=${st.files}`);
  // Budget raised for JS-owned AcrPull + platform-supplemental smart detector + live residual
  // + Container Apps Job 32-char name owner (messiproof ContainerAppInvalidName)
  // + internal durable-staging lifecycle mode (planDigest/tags/receipt/authority bind).
  ok('net_budget', st.net <= 8200, `net=${st.net} raw=+${st.rawAdd}/-${st.rawDel}`);
  console.log(`\nRESULT: ${fail ? 'FAIL' : 'PASS'}  pass=${pass} fail=${fail}  net=+${st.net}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
