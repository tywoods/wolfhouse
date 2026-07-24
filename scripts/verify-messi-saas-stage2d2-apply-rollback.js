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
  let deployments = {}; let job = null; let app = null;
  let mi = { properties: { principalId: PID } };
  let rolesById = {}; let resources = []; let nested = {}; let secrets = [];
  let costRows = [[0, 'USD']]; let costFail = false;
  let branch = 'master'; let identityOk = true;
  let acrFail = false; let putFailPath = null;
  let pollStates = {}; let deleteEtagRace = false;
  let clock = new Date('2026-07-23T12:00:00Z');
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
  const deps = lib.createDeps({
    repoRoot: ROOT, stateDir,
    sleep: async (ms) => { clock = new Date(clock.getTime() + (Number(ms) || 0)); },
    now: () => new Date(clock.getTime()),
    process: opts.process || fakeProc,
    toolAuthority: opts.toolAuthority || fakeTools, verifiedDeploySha: opts.verifiedDeploySha || SHA,
    snapshotAdapter: opts.snapshotAdapter || (() => ({ root: ROOT, cleanup: () => {} })),
    bicepBuildBytes: opts.bicepBuildBytes || (() => Buffer.from(TPL_BYTES)),
    randomBytes: (n) => Buffer.alloc(n, 7),
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
      if (a === 'rev-parse HEAD' || a === 'rev-parse origin/master') return SHA;
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
      if (args[0] === 'acr' && args[1] === 'manifest' && args[2] === 'show') {
        if (acrFail) throw new Error('acr manifest show failed');
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
          ? { status: 200, body: rg, headers: { etag } }
          : { status: 404, body: {}, headers: {} };
      }
      if (req.method === 'PUT' && /resourcegroups\/[^/?]+(\?|$)/i.test(p)
        && !/providers\//i.test(p.split('resourcegroups/')[1] || '')) {
        rg = { name: RG, location: 'westeurope', tags: (req.body && req.body.tags) || {}, properties: { provisioningState: 'Succeeded' } };
        return { status: 200, body: rg, headers: { etag } };
      }
      if (req.method === 'DELETE' && /resourcegroups\/[^/?]+(\?|$)/i.test(p)
        && !/providers\//i.test(p.split('resourcegroups/')[1] || '')) {
        if (deleteEtagRace) return { status: 412, body: {}, headers: {} };
        const want = (req.headers && (req.headers['If-Match'] || req.headers['if-match'])) || null;
        if (!want || want !== etag) return { status: 412, body: {}, headers: {} };
        rg = null;
        return { status: 202, body: {}, headers: {} };
      }
      if (/CostManagement\/query/i.test(p)) {
        return costFail ? { status: 503, body: {}, headers: {} }
          : { status: 200, body: { properties: { rows: costRows } }, headers: {} };
      }
      if (/\/deployments\//i.test(p)) {
        const name = (p.match(/deployments\/([^/?]+)/) || [])[1];
        if (req.method === 'PUT') {
          deployments[name] = { id: p.replace(/\?.*$/, ''), properties: { provisioningState: 'Accepted' } };
          const seq = pollStates[name] || ['Succeeded'];
          pollStates[name] = seq.slice();
          return { status: 201, body: deployments[name], headers: {} };
        }
        if (req.method === 'GET') {
          const seq = pollStates[name] || ['Succeeded'];
          const st = seq.length > 1 ? seq.shift() : seq[0];
          pollStates[name] = seq;
          deployments[name] = { id: p.replace(/\?.*$/, ''), properties: { provisioningState: st } };
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
        const hit = rolesById[String(id).toLowerCase()];
        return hit ? { status: 200, body: hit, headers: {} } : { status: 404, body: {}, headers: {} };
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
    httpsRequest: async () => (identityOk
      ? { status: 200, body: JSON.stringify({ status: 'ok', service: 'staff-api', default_client_slug: SLUG }) }
      : { status: 503, body: '{}' }),
  });
  return {
    deps, armLog, azLog, azCmdLog, stateDir, fakeProc, listeners,
    setRg(v) { rg = v; }, setEtag(v) { etag = v; }, setJob(v) { job = v; }, setApp(v) { app = v; },
    setMi(v) { mi = v; }, setRoles(v) { rolesById = v; }, setResources(v) { resources = v; },
    setNested(v) { nested = v; }, setSecrets(v) { secrets = v; },
    setCostFail(v) { costFail = v; }, setCostRows(v) { costRows = v; },
    setBranch(v) { branch = v; }, setAcrFail(v) { acrFail = v; },
    setPutFailPath(v) { putFailPath = v; }, setPollStates(v) { pollStates = v; },
    setDeleteEtagRace(v) { deleteEtagRace = v; }, setIdentityOk(v) { identityOk = v; },
    setClock(v) { clock = new Date(v); }, advanceClock(ms) { clock = new Date(clock.getTime() + ms); },
    seedRoles(names) {
      const c = d1.buildExpectedResourceContract(names, { principalId: PID });
      rolesById = Object.fromEntries(c.roleAssignments.map((role) => [String(role.name).toLowerCase(), {
        id: role.id, name: role.name,
        properties: {
          roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${role.roleDefinitionId}`,
          principalId: PID, scope: role.scope,
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
function drillOwned(digest) {
  return {
    tenant: SLUG, stage: 'saas-2d2-staging', owner: 'messi-stage2d2',
    planDigest: digest, deploySha: SHA, temporaryDrill: 'true', createdAt: CREATED, expiresAt: EXPIRES,
  };
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
    && typeof lib.expiryStatus === 'function' && typeof lib.deriveD1Authority === 'function');

  const doc = fs.readFileSync(path.join(ROOT, DOC_REL), 'utf8');
  const src = fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8') + fs.readFileSync(path.join(ROOT, CLI_REL), 'utf8');
  ok('docs_exact_commands', /approve-max-total-usd 8/.test(doc) && /ttl-hours 48/.test(doc)
    && /expiry-status/.test(doc) && /confirm-delete luna-messiproof-staging-rg/.test(doc)
    && !/scheduler|setInterval|cron/i.test(doc) && /monthly_approval_rejected/.test(src)
    && !/--approve-monthly-usd/.test(doc));
  ok('d1_handoff_and_lock', /deriveAuthority/.test(src) && /O_NOFOLLOW|nofollow/.test(src)
    && /temporaryDrill/.test(src) && /expiresAt/.test(src)
    && /If-Match/.test(src) && /HEALTH_IDENTITY_PATH/.test(src)
    && /assertActiveDrill/.test(src) && /LEGITIMATE_PHASES/.test(src)
    && /SIGINT|SIGTERM/.test(src) && /PHASE_MAX_MS/.test(src)
    && /rg-delete/.test(src) && /parseRetryAfterMs|Retry-After|retry-after/.test(src)
    && /rollback_aborted|rollback_failed/.test(src)
    && lib.PHASE_MAX_MS['rg-delete'] >= 30 * 60 * 1000);
  ok('docs_claim_truth', /assertActiveDrill|SIGINT|pinned absolute|inventory finding|legitimate/i.test(doc)
    && /wall-clock|PHASE_MAX|30m|Retry-After|tag tuple|rollback_failed/i.test(doc)
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
    const argv = lib.installedAcrManifestShowArgv(SHA);
    const help = execFileSync(d1.PINNED_BINS.az, ['acr', 'manifest', 'show', '-h'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    ok('acr_syntax_installed_valid', argv[0] === 'acr' && argv[1] === 'manifest' && argv[2] === 'show'
      && argv.includes('--name') && argv.includes(`luna-sunset-staff-api:${SHA}`)
      && argv.includes('--registry') && argv.includes('whstagingacr')
      && /--name|--registry/.test(help) && !argv.includes('--repository'));
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
    ok('apply_happy_job_delete_roles_health_receipt', r.ok === true && deletes.length >= 1
      && costPosts.length >= 1 && roleGets.length >= 2
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
        hx.setJob({ id: c.bootstrapJob.id, name: c.bootstrapJob.name, type: c.bootstrapJob.type, tags });
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
    const real = h.deps.armRequest;
    h.deps.armRequest = async (req) => {
      const res = await real(req);
      if (!signaled && req.method === 'GET' && /resourcegroups\/[^/?]+(\?|$)/i.test(req.path || '')
        && !/providers\//i.test((req.path || '').split('resourcegroups/')[1] || '')
        && res.status === 200) {
        signaled = true; h.fakeProc.emit('SIGTERM');
      }
      return res;
    };
    const rb = await lib.rollback({ slug: SLUG, confirmDelete: RG }, h.deps);
    const receipt = lib.readReceipt(h.deps, SLUG);
    ok('rollback_signal_writes_aborted_receipt', !rb.ok
      && (rb.errors || []).some((e) => e.code === 'operation_aborted')
      && receipt && /rollback_aborted|rollback_failed/.test(receipt.status)
      && !/postgresql:\/\/|sk_live|whsec_/i.test(JSON.stringify(receipt))
      && !fs.existsSync(path.join(h.stateDir, `${SLUG}.op.lock`)) && signaled);
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
    // Live Azure CLI 2.87 `az acr manifest show` puts the immutable digest under config.digest.
    const digest = `sha256:${'a'.repeat(64)}`;
    const fromConfig = lib.resolveImageDigest({
      azExec: () => JSON.stringify({ config: { digest } }),
    }, SHA);
    ok('acr_manifest_config_digest_resolves', fromConfig.ok === true
      && fromConfig.imageDigest.toLowerCase() === digest
      && /^sha256:[a-f0-9]{64}$/.test(fromConfig.imageDigest));
    const fromTop = lib.resolveImageDigest({
      azExec: () => JSON.stringify({ digest }),
    }, SHA);
    ok('acr_manifest_top_level_digest_still_resolves', fromTop.ok === true
      && fromTop.imageDigest.toLowerCase() === digest);
    const fromManifests = lib.resolveImageDigest({
      azExec: () => JSON.stringify({ manifests: [{ digest }] }),
    }, SHA);
    ok('acr_manifest_manifests0_digest_still_resolves', fromManifests.ok === true
      && fromManifests.imageDigest.toLowerCase() === digest);
    const rejectTag = lib.resolveImageDigest({
      azExec: () => JSON.stringify({ digest: 'latest', config: { digest: 'not-a-digest' } }),
    }, SHA);
    ok('acr_manifest_rejects_non_sha256_digest', rejectTag.ok === false
      && (rejectTag.errors || []).some((e) => e.code === 'image_digest_resolve'));
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

  // Live apply acquires an exclusive lock before D1 preflight. If the default stateDir
  // lives under the git worktree, that mkdir dirties porcelain and fail-closes with dirty_tree.
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
    ok('rollback_derives_authority_before_lock', authBeforeLock(rbFn));

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

  const st = diffStat();
  ok('file_budget', st.files <= 10, `files=${st.files}`);
  // Budget raised slightly for live ACR digest + inherited atScope() regressions.
  ok('net_budget', st.net <= 3100, `net=${st.net} raw=+${st.rawAdd}/-${st.rawDel}`);
  console.log(`\nRESULT: ${fail ? 'FAIL' : 'PASS'}  pass=${pass} fail=${fail}  net=+${st.net}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
