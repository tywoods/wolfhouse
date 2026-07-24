#!/usr/bin/env node
'use strict';
/** verify:messi-saas-stage2d21-prepared-rg — offline D2.1 prepared-RG gate (no Azure writes). */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const BASE = '64a2eb82e9ad6e0a483e95fc85a086bf2e42110a';
const LIB_REL = 'scripts/lib/messi-saas-stage2d2-apply-rollback.js';
const CLI_REL = 'scripts/messi-saas-stage2d2-apply-rollback.js';
const DOC_REL = 'docs/MESSI-SAAS-STAGE2D21-PREPARED-RG.md';
const VERIFY_REL = 'scripts/verify-messi-saas-stage2d21-prepared-rg.js';
const FILES = [LIB_REL, CLI_REL, VERIFY_REL, DOC_REL, 'package.json'];
const SLUG = 'messiproof';
const SUB = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
const RG = `luna-${SLUG}-staging-rg`;
const SHA = 'b'.repeat(40);
const DIGEST_IMG = `sha256:${'c'.repeat(64)}`;
const EXEC = 'e3136eed-948b-4947-a26e-50a33b45a41a';
const ROLE_CONTRIB = 'b24988ac-6180-42a0-ab88-20f7382dd24c';
const ROLE_RBAC = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168';
const ROLE_PUSH = '8311e382-0749-4cb8-b61a-304f252e45ec';
const ROLE_BUILD = 'fb382eab-e894-4461-af04-94435c366c3f';
const CREATED = '2026-07-23T12:00:00.000Z';
const EXPIRES = '2026-07-25T12:00:00.000Z';
const TPL = {
  $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
  contentVersion: '1.0.0.0', resources: [{ type: 'Microsoft.Resources/deployments', name: 'tenant' }], outputs: {},
};
const TPL_BYTES = Buffer.from(JSON.stringify(TPL));
let pass = 0; let fail = 0;
const ok = (n, c, d) => { if (c) { pass += 1; console.log(`  PASS  ${n}`); }
else { fail += 1; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); } };

function jwtForOid(oid) {
  const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ oid, tid: 'tenant' })).toString('base64url');
  return `${h}.${p}.sig`;
}
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
function approval() { return { approveMaxTotalUsd: 8, ttlHours: 48 }; }

function makeHarness(lib, d1, opts = {}) {
  const armLog = [];
  let rg = null; let etag = '"etag-1"';
  let deployments = {}; let job = null; let app = null;
  let rolesById = {}; let resources = []; let nested = {}; let secrets = [];
  let acrRoleList = []; let tokenOid = opts.tokenOid || EXEC;
  let putFailPath = null; let deleteEtagRace = false; let rgPutEtagRace = false;
  let roleDeleteEtagRace = false;
  let clock = new Date('2026-07-23T12:00:00Z');
  const listeners = {};
  const fakeProc = {
    on(sig, fn) { listeners[sig] = (listeners[sig] || []).concat([fn]); },
    removeListener(sig, fn) { listeners[sig] = (listeners[sig] || []).filter((x) => x !== fn); },
    emit(sig) { for (const fn of (listeners[sig] || [])) fn(sig); },
    exit() {},
  };
  const fakeTools = {
    gitSha256: '1'.repeat(64), tarSha256: '2'.repeat(64), nodeSha256: '3'.repeat(64),
    azSha256: '4'.repeat(64), bicepSha256: '5'.repeat(64), bicepVersion: 'Bicep CLI version 0.45.15 (test)',
  };
  const stateDir = opts.stateDir || fs.mkdtempSync(path.join(os.tmpdir(), 'messi-2d21-'));
  const deps = lib.createDeps({
    repoRoot: ROOT, stateDir,
    sleep: async (ms) => { clock = new Date(clock.getTime() + (Number(ms) || 0)); },
    now: () => new Date(clock.getTime()),
    process: opts.process || fakeProc,
    toolAuthority: fakeTools, verifiedDeploySha: SHA,
    snapshotAdapter: () => ({ root: ROOT, cleanup: () => {} }),
    bicepBuildBytes: () => Buffer.from(TPL_BYTES),
    randomBytes: (n) => Buffer.alloc(n, 7),
    adoptAfterValidateHook: opts.adoptAfterValidateHook || null,
    bootstrapOperator: () => ({
      assertCanDelete: async () => ({ ok: true, errors: [] }),
      startJob: async () => ({ ok: true, executionName: 'exec-1', errors: [] }),
      waitTerminal: async () => ({ ok: true, status: 'Succeeded', summary: { ok: true }, errors: [] }),
      deleteJob: async () => ({ ok: true, verifiedAbsent: true, errors: [] }),
      installSignalHandlers() {}, removeSignalHandlers() {},
    }),
    gitExec: (args) => {
      const a = args.join(' ');
      if (a === 'fetch origin master') return '';
      if (a === 'rev-parse --abbrev-ref HEAD') return 'master';
      if (a === 'status --porcelain') return '';
      if (a === 'rev-parse HEAD' || a === 'rev-parse origin/master') return SHA;
      return '';
    },
    azExec: (args) => {
      if (args[0] === 'account' && args[1] === 'show') {
        return JSON.stringify({ id: SUB, name: 'staging', state: 'Enabled' });
      }
      if (args[0] === 'account' && args[1] === 'get-access-token') {
        return JSON.stringify({ accessToken: jwtForOid(tokenOid), expiresOn: '2099-01-01' });
      }
      if (args[0] === 'acr' && args[1] === 'build') return 'built';
      if (args[0] === 'acr' && args[1] === 'manifest' && args[2] === 'show') {
        return JSON.stringify({ digest: DIGEST_IMG });
      }
      throw new Error(`unexpected_az:${args.join(' ')}`);
    },
    armRequest: async (req) => {
      armLog.push({ method: req.method, path: req.path, body: req.body || null, headers: req.headers || null });
      const p = req.path || '';
      if (putFailPath && req.method === 'PUT' && p.includes(putFailPath)) {
        return { status: 500, body: { error: 'fail' }, headers: {} };
      }
      if (req.method === 'GET' && /resourcegroups\/[^/?]+(\?|$)/i.test(p)
        && !/providers\//i.test(p.split('resourcegroups/')[1] || '')) {
        return rg
          ? { status: 200, body: rg, headers: etag ? { etag } : {} }
          : { status: 404, body: {}, headers: {} };
      }
      if (req.method === 'PUT' && /resourcegroups\/[^/?]+(\?|$)/i.test(p)
        && !/providers\//i.test(p.split('resourcegroups/')[1] || '')) {
        if (rgPutEtagRace) return { status: 412, body: {}, headers: {} };
        if (rg && etag) {
          const want = (req.headers && (req.headers['If-Match'] || req.headers['if-match'])) || null;
          if (!want || want !== etag) return { status: 412, body: {}, headers: {} };
        }
        rg = {
          id: `/subscriptions/${SUB}/resourceGroups/${RG}`, name: RG, location: 'westeurope',
          tags: (req.body && req.body.tags) || {}, properties: { provisioningState: 'Succeeded' },
        };
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
        return { status: 200, body: { properties: { rows: [[0, 'USD']] } }, headers: {} };
      }
      // Independent RG deployment history LIST (collectLiveInventory empty-phase authority).
      if (/\/providers\/Microsoft\.Resources\/deployments(\?|$)/i.test(p)) {
        return { status: 200, body: { value: [] }, headers: {} };
      }
      if (/\/deployments\//i.test(p)) {
        const name = (p.match(/deployments\/([^/?]+)/) || [])[1];
        if (req.method === 'PUT') {
          deployments[name] = { id: p.replace(/\?.*$/, ''), properties: { provisioningState: 'Succeeded' } };
          return { status: 201, body: deployments[name], headers: {} };
        }
        return { status: 200, body: deployments[name] || { properties: { provisioningState: 'Succeeded' } }, headers: {} };
      }
      if (/\/jobs\//i.test(p) && !/executions/i.test(p)) {
        if (req.method === 'DELETE') { job = null; return { status: 200, body: {}, headers: {} }; }
        return job ? { status: 200, body: job, headers: {} } : { status: 404, body: {}, headers: {} };
      }
      if (/userAssignedIdentities\//i.test(p)) {
        return { status: 200, body: { properties: { principalId: '11111111-2222-3333-4444-555555555555' } }, headers: {} };
      }
      if (/roleAssignments(\?|$)/i.test(p) && !/roleAssignments\/[0-9a-f-]{36}/i.test(p)) {
        if (/ContainerRegistry\/registries/i.test(p)) {
          return { status: 200, body: { value: acrRoleList }, headers: {} };
        }
        const rgScope = `/subscriptions/${SUB}/resourceGroups/${RG}`.toLowerCase();
        const value = Object.values(rolesById).filter((r) => {
          const sc = String(((r.properties || {}).scope) || '').toLowerCase();
          return sc === rgScope;
        });
        return { status: 200, body: { value }, headers: {} };
      }
      if (/roleAssignments\/[0-9a-f-]{36}/i.test(p)) {
        const id = (p.match(/roleAssignments\/([0-9a-f-]{36})/i) || [])[1];
        const key = String(id).toLowerCase();
        if (req.method === 'DELETE') {
          const hit = rolesById[key];
          if (!hit) return { status: 404, body: {}, headers: {} };
          if (roleDeleteEtagRace) return { status: 412, body: {}, headers: {} };
          // Live ARM often omits role-assignment ETag; only enforce If-Match when one was supplied.
          const roleEtag = hit.etag === null ? null : (hit.etag || '"role-etag"');
          if (roleEtag) {
            const want = (req.headers && (req.headers['If-Match'] || req.headers['if-match'])) || null;
            if (!want || want !== roleEtag) return { status: 412, body: {}, headers: {} };
          }
          delete rolesById[key];
          acrRoleList = acrRoleList.filter((r) => String(r.name || '').toLowerCase() !== key);
          return { status: 200, body: {}, headers: {} };
        }
        const hit = rolesById[key];
        if (!hit) return { status: 404, body: {}, headers: {} };
        const roleEtag = hit.etag === null ? null : (hit.etag || '"role-etag"');
        return { status: 200, body: hit, headers: roleEtag ? { etag: roleEtag } : {} };
      }
      if (/\/resources(\?|&|$)/i.test(p)) return { status: 200, body: { value: resources }, headers: {} };
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
    httpsRequest: async () => ({
      status: 200,
      body: JSON.stringify({ status: 'ok', service: 'staff-api', default_client_slug: SLUG }),
    }),
  });
  return {
    deps, armLog, stateDir, fakeProc,
    setRg(v) { rg = v; }, setEtag(v) { etag = v; }, setJob(v) { job = v; }, setApp(v) { app = v; },
    setRoles(v) { rolesById = v; }, setResources(v) { resources = v; }, setNested(v) { nested = v; },
    setSecrets(v) { secrets = v; },
    setAcrRoleList(v) { acrRoleList = v; }, setTokenOid(v) { tokenOid = v; deps.token = null; },
    setPutFailPath(v) { putFailPath = v; }, setDeleteEtagRace(v) { deleteEtagRace = v; },
    setRgPutEtagRace(v) { rgPutEtagRace = v; }, setRoleDeleteEtagRace(v) { roleDeleteEtagRace = v; },
    getRoles() { return rolesById; }, getAcrRoleList() { return acrRoleList; }, getResources() { return resources; },
    seedFoundation(tags) {
      const names = d1.deriveNames(SLUG, SUB);
      const c = d1.buildExpectedResourceContract(names, {
        principalId: '11111111-2222-3333-4444-555555555555',
      });
      resources = c.foundationTopLevel.map((r) => ({
        id: r.id, name: r.name, type: r.type, tags, provisioningState: 'Succeeded',
      }));
      const [n0, n1] = c.nestedChildren;
      nested = {
        [n0.id]: { id: n0.id, name: n0.name, type: n0.type },
        [n1.id]: { id: n1.id, name: n1.name, type: n1.type, tags },
      };
      rolesById = Object.fromEntries(c.roleAssignments.map((role) => [String(role.name).toLowerCase(), {
        id: role.id, name: role.name, etag: '"role-etag"',
        properties: {
          roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${role.roleDefinitionId}`,
          principalId: '11111111-2222-3333-4444-555555555555', scope: role.scope,
        },
      }]));
      return c;
    },
    seedPrepared(lib, names, planDigest) {
      const prep = lib.buildPreparedRoleAssignments(names);
      const tags = lib.preparedTags({
        tenantSlug: SLUG, planDigest, deploySha: SHA,
      });
      rg = {
        id: `/subscriptions/${SUB}/resourceGroups/${RG}`, name: RG, location: 'westeurope', tags,
        properties: { provisioningState: 'Succeeded' },
      };
      rolesById = Object.fromEntries(prep.map((r) => [String(r.name).toLowerCase(), {
        id: r.id, name: r.name, etag: '"role-etag"',
        properties: {
          roleDefinitionId: r.roleDefinitionResourceId,
          principalId: r.principalId, principalType: 'ServicePrincipal', scope: r.scope,
        },
      }]));
      resources = prep.filter((r) => r.kind.startsWith('rg-')).map((r) => ({
        id: r.id, name: r.name, type: 'Microsoft.Authorization/roleAssignments',
      }));
      acrRoleList = [
        {
          id: `${prep[2].scope}/providers/Microsoft.Authorization/roleAssignments/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
          name: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          properties: {
            principalId: EXEC,
            roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${ROLE_PUSH}`,
            scope: prep[2].scope,
          },
        },
        {
          id: `${prep[2].scope}/providers/Microsoft.Authorization/roleAssignments/bbbbbbbb-cccc-dddd-eeee-ffffffffffff`,
          name: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
          properties: {
            principalId: EXEC,
            roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${ROLE_BUILD}`,
            scope: prep[2].scope,
          },
        },
        {
          id: prep[2].id, name: prep[2].name,
          properties: {
            principalId: EXEC,
            roleDefinitionId: prep[2].roleDefinitionResourceId,
            scope: prep[2].scope,
          },
        },
        {
          id: `${prep[2].scope}/providers/Microsoft.Authorization/roleAssignments/dddddddd-eeee-ffff-0000-111111111111`,
          name: 'dddddddd-eeee-ffff-0000-111111111111',
          properties: {
            principalId: '22222222-3333-4444-5555-666666666666',
            roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${ROLE_CONTRIB}`,
            scope: prep[2].scope,
          },
        },
      ];
      return { prep, tags };
    },
  };
}

function runtimeAppBody(names) {
  return {
    id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/${names.staffApiAppName}`,
    name: names.staffApiAppName, tags: {},
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
  console.log('verify:messi-saas-stage2d21-prepared-rg — Stage 2D2.1\n');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok('package_script', pkg.scripts['verify:messi-saas-stage2d21-prepared-rg']
    === 'node scripts/verify-messi-saas-stage2d21-prepared-rg.js');
  ok('files_exist', FILES.every((r) => fs.existsSync(path.join(ROOT, r))));
  let lib; let d1;
  try {
    lib = require('./lib/messi-saas-stage2d2-apply-rollback');
    d1 = require('./lib/messi-saas-stage2d1-plan-status');
  } catch (e) { ok('lib_loads', false, String(e.message)); process.exit(1); }
  ok('api_surface', typeof lib.prepareSpec === 'function' && typeof lib.buildPreparedRoleAssignments === 'function'
    && typeof lib.deleteExactTempAcrRbacAdmin === 'function' && typeof lib.preparedTags === 'function'
    && typeof lib.pasteReadyAcrCleanupCommand === 'function'
    && typeof lib.listDirectRoleAssignments === 'function'
    && typeof lib.assertExactDirectRgRoles === 'function'
    && typeof lib.assertExactExecutorAcrRoles === 'function'
    && lib.EXECUTOR_UAI_OID === EXEC && lib.ROLE_CONTRIBUTOR === ROLE_CONTRIB
    && lib.ROLE_RBAC_ADMIN === ROLE_RBAC);

  const doc = fs.readFileSync(path.join(ROOT, DOC_REL), 'utf8');
  const src = fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8') + fs.readFileSync(path.join(ROOT, CLI_REL), 'utf8');
  ok('docs_two_session_flow', /prepare-spec/.test(doc) && /adopt-prepared-rg/.test(doc)
    && /Session 1|session 1|Azure.admin|admin session/i.test(doc)
    && /Session 2|session 2|executor/i.test(doc)
    && /preparedFor=messi-stage2d2|preparedFor.*messi-stage2d2/.test(doc)
    && /Never grant subscription Contributor\/Owner/.test(doc)
    && /atScope\(\)|direct.?scope/i.test(doc)
    && /re-?enumerat|post-retag|TOCTOU/i.test(doc));
  ok('cli_prepare_and_adopt', /prepare-spec/.test(src) && /adopt-prepared-rg|adoptPreparedRg/.test(src)
    && /preparedFor/.test(src) && /If-Match/.test(src) && /atScope\(\)/.test(src)
    && src.includes(ROLE_CONTRIB) && src.includes(ROLE_RBAC) && src.includes(EXEC));

  {
    const h = makeHarness(lib, d1);
    const spec = await lib.prepareSpec({ slug: SLUG, ...approval() }, h.deps);
    const names = d1.deriveNames(SLUG, SUB);
    const prep = lib.buildPreparedRoleAssignments(names);
    const blob = JSON.stringify(spec);
    ok('prepare_spec_readonly_exact', spec.ok === true && spec.readOnly === true
      && spec.executorPrincipalId === EXEC
      && spec.resourceGroup.location === 'westeurope'
      && spec.resourceGroup.tags.preparedFor === 'messi-stage2d2'
      && spec.resourceGroup.tags.tenant === SLUG
      && spec.resourceGroup.tags.planDigest === spec.planDigest
      && spec.resourceGroup.tags.deploySha === SHA
      && spec.roleAssignments.length === 3
      && prep.every((r, i) => spec.roleAssignments[i].name === r.name && spec.roleAssignments[i].id === r.id)
      && spec.roleAssignments[0].roleDefinitionId === ROLE_CONTRIB
      && spec.roleAssignments[1].roleDefinitionId === ROLE_RBAC
      && spec.roleAssignments[2].roleDefinitionId === ROLE_RBAC
      && /whstagingacr/.test(spec.roleAssignments[2].scope)
      && /resourceGroups\/wh-staging-rg/.test(spec.roleAssignments[2].scope)
      && Array.isArray(spec.azureAdminCommands) && spec.azureAdminCommands.length >= 4
      && spec.azureAdminCommands.every((c) => typeof c === 'string')
      && !spec.azureAdminCommands.some((c) => {
        const scope = (c.match(/--scope\s+(\S+)/) || [])[1] || '';
        return /^\/subscriptions\/[^/]+$/.test(scope);
      })
      && !h.armLog.some((x) => ['PUT', 'POST', 'DELETE', 'PATCH'].includes(x.method))
      && !/postgresql:\/\/|sk_live|whsec_|EAAG_/i.test(blob)
      && typeof spec.acrCleanupCommand === 'string' && spec.acrCleanupCommand.includes(prep[2].id));
    ok('guid_bound_scope_executor_role_drill', prep.every((r) => {
      const n = d1.azureArmGuid(r.scope, EXEC, r.roleDefinitionId, 'messi-stage2d2');
      return r.name === n;
    }) && new Set(prep.map((r) => r.name)).size === 3);
  }

  {
    const h = makeHarness(lib, d1);
    const absent = await lib.apply({ slug: SLUG, ...approval() }, h.deps);
    ok('without_adopt_absent_behavior', absent.ok === false
      || (absent.ok === true && h.armLog.some((x) => x.method === 'PUT'
        && /resourcegroups\/luna-messiproof-staging-rg/i.test(x.path || '')
        && x.body && x.body.tags && x.body.tags.temporaryDrill === 'true')));
    // re-run clean: without flag, existing RG refused
    const h2 = makeHarness(lib, d1);
    const auth = await lib.deriveD1Authority({ slug: SLUG }, h2.deps);
    h2.seedPrepared(lib, d1.deriveNames(SLUG, SUB), auth.planDigest);
    const refused = await lib.apply({ slug: SLUG, ...approval() }, h2.deps);
    ok('without_adopt_refuses_existing_rg', refused.ok === false
      && (refused.errors || []).some((e) => e.code === 'rg_exists'));
  }

  {
    const h = makeHarness(lib, d1);
    const auth = await lib.deriveD1Authority({ slug: SLUG }, h.deps);
    const names = d1.deriveNames(SLUG, SUB);
    h.seedPrepared(lib, names, auth.planDigest);
    h.setJob({ id: 'job', name: names.bootstrapJobName, tags: {} });
    h.setApp(runtimeAppBody(names));
    // seed post-adopt KV/ACR runtime roles used by waitExactRoles
    const runtimeRoles = d1.buildExpectedResourceContract(names, {
      principalId: '11111111-2222-3333-4444-555555555555',
    }).roleAssignments;
    for (const role of runtimeRoles) {
      h.deps; // keep roles map
    }
    const roles = {};
    for (const [k, v] of Object.entries(h.armLog.length >= 0 ? {} : {})) roles[k] = v;
    // merge prepared + runtime into harness via setRoles after seedPrepared
    const prep = lib.buildPreparedRoleAssignments(names);
    const map = Object.fromEntries(prep.map((r) => [String(r.name).toLowerCase(), {
      id: r.id, name: r.name, etag: '"role-etag"',
      properties: {
        roleDefinitionId: r.roleDefinitionResourceId, principalId: r.principalId, scope: r.scope,
      },
    }]));
    for (const role of runtimeRoles) {
      map[String(role.name).toLowerCase()] = {
        id: role.id, name: role.name, etag: '"role-etag"',
        properties: {
          roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${role.roleDefinitionId}`,
          principalId: '11111111-2222-3333-4444-555555555555', scope: role.scope,
        },
      };
    }
    h.setRoles(map);
    const r = await lib.apply({ slug: SLUG, ...approval(), adoptPreparedRg: true }, h.deps);
    const retagIdx = h.armLog.findIndex((x) => x.method === 'PUT'
      && /resourcegroups\/luna-messiproof-staging-rg/i.test(x.path || '')
      && x.body && x.body.tags && x.body.tags.temporaryDrill === 'true');
    const retag = retagIdx >= 0 ? h.armLog[retagIdx] : null;
    const firstDepIdx = h.armLog.findIndex((x) => x.method === 'PUT' && /\/deployments\//i.test(x.path || ''));
    const atScopePaths = h.armLog.filter((x) => x.method === 'GET'
      && /roleAssignments\?/i.test(x.path || '') && /atScope%28%29|atScope\(\)/i.test(x.path || ''));
    const postRetagAtScope = atScopePaths.filter((x) => h.armLog.indexOf(x) > retagIdx && h.armLog.indexOf(x) < firstDepIdx);
    ok('adopt_happy_retag_before_phases', r.ok === true
      && retag && retag.headers && retag.headers['If-Match']
      && retag.body.tags.preparedFor == null
      && retag.body.tags.owner === 'messi-stage2d2'
      && h.armLog.filter((x) => x.method === 'GET' && /roleAssignments\/[0-9a-f-]{36}/i.test(x.path || '')).length >= 6
      && atScopePaths.length >= 4
      && postRetagAtScope.length >= 2
      && firstDepIdx > retagIdx
      && h.armLog.slice(retagIdx, firstDepIdx).some((x) => x.method === 'GET'
        && /resourcegroups\/luna-messiproof-staging-rg/i.test(x.path || '')
        && !/providers\//i.test((x.path || '').split('resourcegroups/')[1] || '')),
    r.ok ? '' : JSON.stringify(r.errors || r).slice(0, 400));
  }

  // Live ARM RG GET often returns 200 with no ETag header/body — adopt must still retag
  // without If-Match while preserving ownership/inventory/RBAC and accepting no post-retag ETag.
  {
    const h = makeHarness(lib, d1);
    const auth = await lib.deriveD1Authority({ slug: SLUG }, h.deps);
    const names = d1.deriveNames(SLUG, SUB);
    h.seedPrepared(lib, names, auth.planDigest);
    h.setEtag(null);
    const prep = lib.buildPreparedRoleAssignments(names);
    const runtimeRoles = d1.buildExpectedResourceContract(names, {
      principalId: '11111111-2222-3333-4444-555555555555',
    }).roleAssignments;
    const map = Object.fromEntries(prep.map((r) => [String(r.name).toLowerCase(), {
      id: r.id, name: r.name, etag: '"role-etag"',
      properties: {
        roleDefinitionId: r.roleDefinitionResourceId, principalId: r.principalId, scope: r.scope,
      },
    }]));
    for (const role of runtimeRoles) {
      map[String(role.name).toLowerCase()] = {
        id: role.id, name: role.name, etag: '"role-etag"',
        properties: {
          roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${role.roleDefinitionId}`,
          principalId: '11111111-2222-3333-4444-555555555555', scope: role.scope,
        },
      };
    }
    h.setRoles(map);
    h.setJob({ id: 'job', name: names.bootstrapJobName, tags: {} });
    h.setApp(runtimeAppBody(names));
    const r = await lib.apply({ slug: SLUG, ...approval(), adoptPreparedRg: true }, h.deps);
    const retag = h.armLog.find((x) => x.method === 'PUT'
      && /resourcegroups\/luna-messiproof-staging-rg/i.test(x.path || '')
      && x.body && x.body.tags && x.body.tags.temporaryDrill === 'true');
    const ifMatch = retag && retag.headers
      && (retag.headers['If-Match'] || retag.headers['if-match']);
    ok('adopt_no_rg_etag_omits_if_match', r.ok === true && !!retag && !ifMatch
      && retag.body.tags.preparedFor == null
      && retag.body.tags.owner === 'messi-stage2d2'
      && retag.body.tags.temporaryDrill === 'true'
      && retag.body.tags.planDigest === auth.planDigest
      && retag.body.tags.deploySha === SHA
      && h.armLog.filter((x) => x.method === 'GET' && /roleAssignments\/[0-9a-f-]{36}/i.test(x.path || '')).length >= 6
      && h.armLog.some((x) => x.method === 'GET' && /roleAssignments\?/i.test(x.path || '')
        && /atScope%28%29|atScope\(\)/i.test(x.path || '')),
    r.ok ? `ifMatch=${ifMatch}` : JSON.stringify(r.errors || r).slice(0, 400));
  }

  // When ARM supplies an RG ETag, If-Match remains mandatory; 412 is still etag_race.
  {
    const h = makeHarness(lib, d1);
    const auth = await lib.deriveD1Authority({ slug: SLUG }, h.deps);
    const names = d1.deriveNames(SLUG, SUB);
    h.seedPrepared(lib, names, auth.planDigest);
    h.setEtag('"live-etag"');
    h.setRgPutEtagRace(true);
    const race = await lib.apply({ slug: SLUG, ...approval(), adoptPreparedRg: true }, h.deps);
    const retag = h.armLog.find((x) => x.method === 'PUT'
      && /resourcegroups\/luna-messiproof-staging-rg/i.test(x.path || '')
      && x.body && x.body.tags && x.body.tags.temporaryDrill === 'true');
    ok('adopt_with_rg_etag_if_match_mandatory_412_etag_race', race.ok === false
      && retag && retag.headers && retag.headers['If-Match'] === '"live-etag"'
      && (race.errors || []).some((e) => e.code === 'etag_race'));
  }

  {
    const attack = async (mutate) => {
      const h = makeHarness(lib, d1);
      const auth = await lib.deriveD1Authority({ slug: SLUG }, h.deps);
      const names = d1.deriveNames(SLUG, SUB);
      const seeded = h.seedPrepared(lib, names, auth.planDigest);
      mutate(h, names, seeded, auth);
      return lib.apply({ slug: SLUG, ...approval(), adoptPreparedRg: true }, h.deps);
    };
    const precreated = await attack((h) => {
      h.setResources([{
        id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/rogue`,
        name: 'rogue', type: 'Microsoft.Storage/storageAccounts',
      }]);
    });
    const wrongPrincipal = await attack((h, names, seeded) => {
      const r = seeded.prep[0];
      h.setRoles({
        [r.name.toLowerCase()]: {
          id: r.id, name: r.name, etag: '"role-etag"',
          properties: {
            roleDefinitionId: r.roleDefinitionResourceId,
            principalId: '99999999-9999-9999-9999-999999999999', scope: r.scope,
          },
        },
        [seeded.prep[1].name.toLowerCase()]: {
          id: seeded.prep[1].id, name: seeded.prep[1].name, etag: '"role-etag"',
          properties: {
            roleDefinitionId: seeded.prep[1].roleDefinitionResourceId,
            principalId: EXEC, scope: seeded.prep[1].scope,
          },
        },
        [seeded.prep[2].name.toLowerCase()]: {
          id: seeded.prep[2].id, name: seeded.prep[2].name, etag: '"role-etag"',
          properties: {
            roleDefinitionId: seeded.prep[2].roleDefinitionResourceId,
            principalId: EXEC, scope: seeded.prep[2].scope,
          },
        },
      });
    });
    const wrongRole = await attack((h, names, seeded) => {
      const r = seeded.prep[0];
      h.setRoles({
        [r.name.toLowerCase()]: {
          id: r.id, name: r.name, etag: '"role-etag"',
          properties: {
            roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/8e3af657-a8ff-443c-a75c-2fe8c4bcb635`,
            principalId: EXEC, scope: r.scope,
          },
        },
        [seeded.prep[1].name.toLowerCase()]: {
          id: seeded.prep[1].id, name: seeded.prep[1].name, etag: '"role-etag"',
          properties: {
            roleDefinitionId: seeded.prep[1].roleDefinitionResourceId,
            principalId: EXEC, scope: seeded.prep[1].scope,
          },
        },
        [seeded.prep[2].name.toLowerCase()]: {
          id: seeded.prep[2].id, name: seeded.prep[2].name, etag: '"role-etag"',
          properties: {
            roleDefinitionId: seeded.prep[2].roleDefinitionResourceId,
            principalId: EXEC, scope: seeded.prep[2].scope,
          },
        },
      });
    });
    const wrongScope = await attack((h, names, seeded) => {
      const r = seeded.prep[0];
      h.setRoles({
        [r.name.toLowerCase()]: {
          id: r.id, name: r.name, etag: '"role-etag"',
          properties: {
            roleDefinitionId: r.roleDefinitionResourceId,
            principalId: EXEC, scope: `/subscriptions/${SUB}`,
          },
        },
        [seeded.prep[1].name.toLowerCase()]: {
          id: seeded.prep[1].id, name: seeded.prep[1].name, etag: '"role-etag"',
          properties: {
            roleDefinitionId: seeded.prep[1].roleDefinitionResourceId,
            principalId: EXEC, scope: seeded.prep[1].scope,
          },
        },
        [seeded.prep[2].name.toLowerCase()]: {
          id: seeded.prep[2].id, name: seeded.prep[2].name, etag: '"role-etag"',
          properties: {
            roleDefinitionId: seeded.prep[2].roleDefinitionResourceId,
            principalId: EXEC, scope: seeded.prep[2].scope,
          },
        },
      });
    });
    const wrongTag = await attack((h, names, seeded) => {
      h.setRg({
        id: `/subscriptions/${SUB}/resourceGroups/${RG}`, name: RG, location: 'westeurope',
        tags: { ...seeded.tags, preparedFor: 'other' },
        properties: { provisioningState: 'Succeeded' },
      });
    });
    const wrongLoc = await attack((h, names, seeded) => {
      h.setRg({
        id: `/subscriptions/${SUB}/resourceGroups/${RG}`, name: RG, location: 'northeurope',
        tags: seeded.tags, properties: { provisioningState: 'Succeeded' },
      });
    });
    const missingRole = await attack((h, names, seeded) => {
      const map = Object.fromEntries(seeded.prep.slice(0, 2).map((r) => [r.name.toLowerCase(), {
        id: r.id, name: r.name, etag: '"role-etag"',
        properties: {
          roleDefinitionId: r.roleDefinitionResourceId, principalId: EXEC, scope: r.scope,
        },
      }]));
      h.setRoles(map);
    });
    const oidSwap = await attack((h) => { h.setTokenOid('00000000-0000-0000-0000-000000000099'); });
    const etagRace = await attack((h) => { h.setRgPutEtagRace(true); });
    ok('attacks_precreated_principal_role_scope_tag_loc_missing_oid_etag',
      [precreated, wrongPrincipal, wrongRole, wrongScope, wrongTag, wrongLoc, missingRole, oidSwap, etagRace]
        .every((r) => r.ok === false)
      && (precreated.errors || []).some((e) => /precreated|unexpected_resource|inventory/i.test(e.code))
      && (wrongPrincipal.errors || []).some((e) => /principal/i.test(e.code))
      && (wrongRole.errors || []).some((e) => /role/i.test(e.code))
      && (wrongScope.errors || []).some((e) => /scope|direct_rg_role|missing_direct_rg/i.test(e.code))
      && (wrongTag.errors || []).some((e) => /tag|prepared/i.test(e.code))
      && (wrongLoc.errors || []).some((e) => /location/i.test(e.code))
      && (missingRole.errors || []).some((e) => /missing|role/i.test(e.code))
      && (oidSwap.errors || []).some((e) => /oid|executor/i.test(e.code))
      && (etagRace.errors || []).some((e) => e.code === 'etag_race'));

    const extraRg = await attack((h, names, seeded) => {
      const map = { ...h.getRoles() };
      map['ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb'] = {
        id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Authorization/roleAssignments/ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb`,
        name: 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb', etag: '"role-etag"',
        properties: {
          roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${ROLE_CONTRIB}`,
          principalId: EXEC, scope: seeded.prep[0].scope,
        },
      };
      h.setRoles(map);
    });
    const extraAcr = await attack((h, names, seeded) => {
      h.setAcrRoleList(h.getAcrRoleList().concat([{
        id: `${seeded.prep[2].scope}/providers/Microsoft.Authorization/roleAssignments/eeeeeeee-ffff-0000-1111-222222222222`,
        name: 'eeeeeeee-ffff-0000-1111-222222222222',
        properties: {
          principalId: EXEC,
          roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${ROLE_CONTRIB}`,
          scope: seeded.prep[2].scope,
        },
      }]));
    });
    ok('exact_direct_rg_and_acr_executor_sets',
      extraRg.ok === false && (extraRg.errors || []).some((e) => /extra_direct_rg|direct_rg_role/i.test(e.code))
      && extraAcr.ok === false
      && (extraAcr.errors || []).some((e) => /unexpected_acr_executor|acr_executor/i.test(e.code)));
  }

  {
    const toctou = async (mutate) => {
      const h = makeHarness(lib, d1, {
        adoptAfterValidateHook: async () => { mutate(h); },
      });
      const auth = await lib.deriveD1Authority({ slug: SLUG }, h.deps);
      const names = d1.deriveNames(SLUG, SUB);
      h.seedPrepared(lib, names, auth.planDigest);
      const r = await lib.apply({ slug: SLUG, ...approval(), adoptPreparedRg: true }, h.deps);
      const receipt = lib.readReceipt(h.deps, SLUG);
      const phaseWrite = h.armLog.some((x) => x.method === 'PUT' && /\/deployments\//i.test(x.path || ''));
      return { r, receipt, phaseWrite, h };
    };
    const child = await toctou((h) => {
      h.setResources([{
        id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/toctou`,
        name: 'toctou', type: 'Microsoft.Storage/storageAccounts',
      }]);
    });
    const rgRole = await toctou((h) => {
      const map = { ...h.getRoles() };
      map['aaaaaaaa-1111-2222-3333-444444444444'] = {
        id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Authorization/roleAssignments/aaaaaaaa-1111-2222-3333-444444444444`,
        name: 'aaaaaaaa-1111-2222-3333-444444444444', etag: '"role-etag"',
        properties: {
          roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${ROLE_CONTRIB}`,
          principalId: EXEC, scope: `/subscriptions/${SUB}/resourceGroups/${RG}`,
        },
      };
      h.setRoles(map);
    });
    const expectedRole = await toctou((h) => {
      const map = { ...h.getRoles() };
      const keys = Object.keys(map);
      const rgKey = keys.find((k) => (map[k].properties.scope || '').includes(RG)
        && String(map[k].properties.roleDefinitionId || '').toLowerCase().endsWith(ROLE_CONTRIB));
      map[rgKey] = {
        ...map[rgKey],
        properties: {
          ...map[rgKey].properties,
          roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/8e3af657-a8ff-443c-a75c-2fe8c4bcb635`,
        },
      };
      h.setRoles(map);
    });
    const acrExec = await toctou((h) => {
      h.setAcrRoleList(h.getAcrRoleList().concat([{
        id: `/subscriptions/${SUB}/resourceGroups/wh-staging-rg/providers/Microsoft.ContainerRegistry/registries/whstagingacr/providers/Microsoft.Authorization/roleAssignments/cccc1111-2222-3333-4444-555555555555`,
        name: 'cccc1111-2222-3333-4444-555555555555',
        properties: {
          principalId: EXEC,
          roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${ROLE_CONTRIB}`,
          scope: `/subscriptions/${SUB}/resourceGroups/wh-staging-rg/providers/Microsoft.ContainerRegistry/registries/whstagingacr`,
        },
      }]));
    });
    ok('toctou_hooks_inventory_rg_expected_acr_refuse',
      [child, rgRole, expectedRole, acrExec].every((x) => x.r.ok === false && x.phaseWrite === false
        && x.receipt && typeof x.receipt.acrCleanupCommand === 'string'
        && !/postgresql:\/\/|sk_live|whsec_|EAAG_/i.test(JSON.stringify(x.receipt)))
      && (child.r.errors || []).some((e) => /precreated|inventory/i.test(e.code))
      && (rgRole.r.errors || []).some((e) => /extra_direct_rg|direct_rg_role/i.test(e.code))
      && (expectedRole.r.errors || []).some((e) => /role|definition/i.test(e.code))
      && (acrExec.r.errors || []).some((e) => /unexpected_acr_executor|acr_executor/i.test(e.code)));
  }

  {
    const h = makeHarness(lib, d1);
    const auth = await lib.deriveD1Authority({ slug: SLUG }, h.deps);
    const names = d1.deriveNames(SLUG, SUB);
    const tags = {
      tenant: SLUG, stage: 'saas-2d2-staging', owner: 'messi-stage2d2',
      planDigest: auth.planDigest, deploySha: SHA, temporaryDrill: 'true',
      createdAt: CREATED, expiresAt: EXPIRES,
    };
    h.setRg({
      id: `/subscriptions/${SUB}/resourceGroups/${RG}`, name: RG, location: 'westeurope', tags,
      properties: { provisioningState: 'Succeeded' },
    });
    const prep = lib.buildPreparedRoleAssignments(names);
    const foundation = h.seedFoundation(tags);
    const seededRoles = {};
    for (const role of foundation.roleAssignments) {
      seededRoles[String(role.name).toLowerCase()] = {
        id: role.id, name: role.name, etag: '"role-etag"',
        properties: {
          roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${role.roleDefinitionId}`,
          principalId: '11111111-2222-3333-4444-555555555555', scope: role.scope,
        },
      };
    }
    seededRoles[prep[2].name.toLowerCase()] = {
      id: prep[2].id, name: prep[2].name, etag: '"role-etag"',
      properties: {
        roleDefinitionId: prep[2].roleDefinitionResourceId, principalId: EXEC,
        principalType: 'ServicePrincipal', scope: prep[2].scope,
      },
    };
    h.setRoles(seededRoles);
    const rb = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
    const acrDel = h.armLog.filter((x) => x.method === 'DELETE' && /roleAssignments\//i.test(x.path || ''));
    ok('rollback_deletes_rg_then_exact_temp_acr', rb.ok === true
      && acrDel.length === 1 && acrDel[0].path.includes(prep[2].name)
      && acrDel[0].headers && acrDel[0].headers['If-Match']
      && rb.acrTempRoleAbsent === true, rb.ok ? '' : JSON.stringify(rb.errors || rb.findings || rb).slice(0, 400));
  }

  {
    const h = makeHarness(lib, d1);
    const names = d1.deriveNames(SLUG, SUB);
    const prep = lib.buildPreparedRoleAssignments(names);
    const arbitrary = await lib.deleteExactTempAcrRbacAdmin(h.deps, names, {
      roleAssignmentId: `${prep[2].scope}/providers/Microsoft.Authorization/roleAssignments/cccccccc-dddd-eeee-ffff-000000000000`,
    });
    h.setRoles({
      [prep[2].name.toLowerCase()]: {
        id: prep[2].id, name: prep[2].name, etag: '"role-etag"',
        properties: {
          roleDefinitionId: prep[2].roleDefinitionResourceId, principalId: EXEC,
          principalType: 'ServicePrincipal', scope: prep[2].scope,
        },
      },
    });
    const exact = await lib.deleteExactTempAcrRbacAdmin(h.deps, names);
    ok('only_exact_temp_acr_assignment_removable', arbitrary.ok === false
      && (arbitrary.errors || []).some((e) => /refused|exact/i.test(e.code))
      && exact.ok === true && exact.deleted === true);
  }

  // Live Microsoft.Authorization roleAssignments GET often returns 200 with no ETag
  // header/body. When exact GET identity matches (id/name, principal, ACR scope, role
  // definition, principalType) but supplies no ETag, DELETE must omit If-Match and
  // require exact post-delete 404 — never fabricate '*' or skip identity gates.
  {
    const h = makeHarness(lib, d1);
    const names = d1.deriveNames(SLUG, SUB);
    const prep = lib.buildPreparedRoleAssignments(names);
    h.setRoles({
      [prep[2].name.toLowerCase()]: {
        id: prep[2].id, name: prep[2].name, etag: null,
        properties: {
          roleDefinitionId: prep[2].roleDefinitionResourceId,
          principalId: EXEC,
          principalType: 'ServicePrincipal',
          scope: prep[2].scope,
        },
      },
    });
    const missing = await lib.deleteExactTempAcrRbacAdmin(h.deps, names);
    const dels = h.armLog.filter((x) => x.method === 'DELETE' && /roleAssignments\//i.test(x.path || ''));
    const ifMatch = dels[0] && dels[0].headers
      && (dels[0].headers['If-Match'] || dels[0].headers['if-match']);
    ok('acr_role_delete_no_etag_omits_if_match', missing.ok === true && missing.deleted === true
      && dels.length === 1 && !ifMatch
      && dels[0].path.includes(prep[2].name)
      && h.getRoles()[prep[2].name.toLowerCase()] == null
      && (missing.errors || []).every((e) => e.code !== 'etag_missing'),
    missing.ok ? `ifMatch=${ifMatch}` : JSON.stringify(missing.errors || missing).slice(0, 400));
  }

  // When ARM supplies a role-assignment ETag, If-Match remains mandatory; 412 is etag_race.
  {
    const h = makeHarness(lib, d1);
    const names = d1.deriveNames(SLUG, SUB);
    const prep = lib.buildPreparedRoleAssignments(names);
    h.setRoles({
      [prep[2].name.toLowerCase()]: {
        id: prep[2].id, name: prep[2].name, etag: '"role-etag"',
        properties: {
          roleDefinitionId: prep[2].roleDefinitionResourceId,
          principalId: EXEC,
          principalType: 'ServicePrincipal',
          scope: prep[2].scope,
        },
      },
    });
    const okDel = await lib.deleteExactTempAcrRbacAdmin(h.deps, names);
    const acrDel = h.armLog.filter((x) => x.method === 'DELETE' && /roleAssignments\//i.test(x.path || ''));
    h.setRoles({
      [prep[2].name.toLowerCase()]: {
        id: prep[2].id, name: prep[2].name, etag: '"role-etag"',
        properties: {
          roleDefinitionId: prep[2].roleDefinitionResourceId,
          principalId: EXEC,
          principalType: 'ServicePrincipal',
          scope: prep[2].scope,
        },
      },
    });
    h.setRoleDeleteEtagRace(true);
    const race = await lib.deleteExactTempAcrRbacAdmin(h.deps, names);
    const raceDel = h.armLog.filter((x) => x.method === 'DELETE' && /roleAssignments\//i.test(x.path || ''));
    ok('acr_role_delete_with_etag_if_match_412_etag_race', okDel.ok === true && okDel.deleted === true
      && acrDel.some((x) => x.headers && x.headers['If-Match'] === '"role-etag"')
      && race.ok === false
      && (race.errors || []).some((e) => e.code === 'etag_race')
      && raceDel.some((x) => x.headers && x.headers['If-Match'] === '"role-etag"')
      && h.getRoles()[prep[2].name.toLowerCase()] != null,
    okDel.ok ? '' : JSON.stringify(okDel.errors || okDel).slice(0, 400));
  }

  // Exact-GET identity contract: body.id, body.name, properties.principalType are required
  // and must match expected/ServicePrincipal case-insensitively; any mismatch or missing
  // field refuses with zero DELETE. principal/definition/scope gates remain.
  {
    const names = d1.deriveNames(SLUG, SUB);
    const prep = lib.buildPreparedRoleAssignments(names);
    const goodProps = {
      roleDefinitionId: prep[2].roleDefinitionResourceId,
      principalId: EXEC,
      principalType: 'ServicePrincipal',
      scope: prep[2].scope,
    };
    const cases = [
      // body.id mismatch / missing
      {
        label: 'id_mismatch', re: /id_mismatch|acr_temp_role_id/i,
        body: { id: `${prep[2].scope}/providers/Microsoft.Authorization/roleAssignments/ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb`, name: prep[2].name, properties: goodProps },
      },
      {
        label: 'id_missing', re: /id_mismatch|acr_temp_role_id/i,
        body: { name: prep[2].name, properties: goodProps },
      },
      // body.name mismatch / missing
      {
        label: 'name_mismatch', re: /name_mismatch|acr_temp_role_name/i,
        body: { id: prep[2].id, name: 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb', properties: goodProps },
      },
      {
        label: 'name_missing', re: /name_mismatch|acr_temp_role_name/i,
        body: { id: prep[2].id, properties: goodProps },
      },
      // properties.principalType mismatch / missing
      {
        label: 'principal_type_mismatch', re: /principal_type/i,
        body: { id: prep[2].id, name: prep[2].name, properties: { ...goodProps, principalType: 'User' } },
      },
      {
        label: 'principal_type_missing', re: /principal_type/i,
        body: {
          id: prep[2].id, name: prep[2].name,
          properties: {
            roleDefinitionId: goodProps.roleDefinitionId, principalId: EXEC, scope: prep[2].scope,
          },
        },
      },
      // retained principal / definition / scope mismatches
      {
        label: 'principal_mismatch', re: /principal_mismatch|acr_temp_role_principal/i,
        body: {
          id: prep[2].id, name: prep[2].name,
          properties: { ...goodProps, principalId: '11111111-2222-3333-4444-555555555555' },
        },
      },
      {
        label: 'definition_mismatch', re: /definition|role/i,
        body: {
          id: prep[2].id, name: prep[2].name,
          properties: {
            ...goodProps,
            roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${ROLE_CONTRIB}`,
          },
        },
      },
      {
        label: 'scope_mismatch', re: /scope/i,
        body: {
          id: prep[2].id, name: prep[2].name,
          properties: { ...goodProps, scope: `/subscriptions/${SUB}/resourceGroups/${RG}` },
        },
      },
      {
        label: 'props_empty', re: /principal|definition|scope|principal_type|id|name/i,
        body: { id: prep[2].id, name: prep[2].name, properties: {} },
      },
    ];
    let all = true;
    const fails = [];
    for (const c of cases) {
      const h = makeHarness(lib, d1);
      h.setRoles({
        [prep[2].name.toLowerCase()]: { ...c.body, etag: '"role-etag"' },
      });
      const r = await lib.deleteExactTempAcrRbacAdmin(h.deps, names);
      const dels = h.armLog.filter((x) => x.method === 'DELETE');
      const passCase = r.ok === false && dels.length === 0
        && (r.errors || []).some((e) => c.re.test(e.code));
      if (!passCase) {
        all = false;
        fails.push(`${c.label}:${JSON.stringify(r.errors || r).slice(0, 120)} dels=${dels.length}`);
      }
    }
    ok('delete_temp_acr_rejects_wrong_get_identity_zero_delete', all,
      fails.length ? fails.join(' | ') : '');
  }

  {
    const h = makeHarness(lib, d1);
    const auth = await lib.deriveD1Authority({ slug: SLUG }, h.deps);
    const names = d1.deriveNames(SLUG, SUB);
    h.seedPrepared(lib, names, auth.planDigest);
    h.setPutFailPath('messi-2d2-infra');
    // need adopt path to get past RG — then fail infra
    const prep = lib.buildPreparedRoleAssignments(names);
    const map = Object.fromEntries(prep.map((r) => [String(r.name).toLowerCase(), {
      id: r.id, name: r.name, etag: '"role-etag"',
      properties: {
        roleDefinitionId: r.roleDefinitionResourceId, principalId: r.principalId, scope: r.scope,
      },
    }]));
    h.setRoles(map);
    const r = await lib.apply({ slug: SLUG, ...approval(), adoptPreparedRg: true }, h.deps);
    const receipt = lib.readReceipt(h.deps, SLUG);
    ok('apply_fail_receipt_acr_cleanup_no_secrets', r.ok === false && receipt
      && typeof receipt.acrCleanupCommand === 'string'
      && receipt.acrCleanupCommand.includes(prep[2].id)
      && !/postgresql:\/\/|sk_live|whsec_|EAAG_/i.test(JSON.stringify(receipt)));
  }

  {
    const h = makeHarness(lib, d1);
    const auth = await lib.deriveD1Authority({ slug: SLUG }, h.deps);
    const names = d1.deriveNames(SLUG, SUB);
    const prep = lib.buildPreparedRoleAssignments(names);
    h.setRoles({
      [prep[2].name.toLowerCase()]: {
        id: prep[2].id, name: prep[2].name, etag: '"role-etag"',
        properties: {
          roleDefinitionId: prep[2].roleDefinitionResourceId, principalId: EXEC, scope: prep[2].scope,
        },
      },
    });
    // RG absent
    const st = await lib.expiryStatus({ slug: SLUG }, h.deps);
    ok('expiry_warns_temp_acr_grant', st.ok === true && st.present === false
      && (st.warnings || []).some((w) => /acr|temp/i.test(w.code))
      && typeof st.acrCleanupCommand === 'string');
  }

  const st = diffStat();
  ok('file_budget', st.files <= 8, `files=${st.files}`);
  // Budget raised for exact-GET identity (id/name/principalType) + ETag-optional delete gates.
  ok('net_budget', st.net <= 1700, `net=${st.net} raw=+${st.rawAdd}/-${st.rawDel}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
