'use strict';
/**
 * MESSI SaaS Stage 2D2 — temporary apply/rollback owner.
 * Authority: D1 deriveAuthority (exact-SHA snapshot, pinned tools, subscription, compiled bytes).
 * Secrets stay in memory → ARM HTTPS bodies only. Diagnostic receipt is never authority.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { execFileSync } = require('child_process');
const d1 = require('./messi-saas-stage2d1-plan-status');
const { assertPublicHealthIdentityBody } = require('./staff-api-health-identity');
const { azureArmGuid } = require('./phase-d-kv-secrets-user-rbac-plan');

function loadC2Operator() {
  // Lazy: bootstrap-synthetic-tenant-db pulls `pg`; offline verify must not require it.
  // eslint-disable-next-line global-require
  return require('../bootstrap-synthetic-tenant-db');
}
async function gateActiveDrill(assertFn, boundary) {
  if (typeof assertFn !== 'function') return { ok: true, errors: [] };
  const r = await assertFn(boundary);
  return (r && r.ok === false) ? r : { ok: true, errors: [] };
}
async function runInjectedOperatorLifecycle({ azure, attestation, secrets, assertActiveDrill: assertFn }) {
  const att = attestation || {};
  const proc = process;
  if (azure.installSignalHandlers) azure.installSignalHandlers(proc);
  let ownershipOk = false;
  let result = { ok: false, deleted: false, ownershipVerified: false, summary: null, errors: [] };
  const bound = async (name, fn) => {
    let g = await gateActiveDrill(assertFn, `before-${name}`);
    if (!g.ok) return { ok: false, gate: true, errors: g.errors };
    const out = await fn();
    g = await gateActiveDrill(assertFn, `after-${name}`);
    if (!g.ok) return { ok: false, gate: true, errors: g.errors };
    return out;
  };
  try {
    const can = await bound('assertCanDelete', () => azure.assertCanDelete({ attestation: att }));
    if (can && can.gate) {
      result = { ...result, errors: can.errors }; return result;
    }
    if (!can || can.ok !== true) {
      return {
        ok: false, deleted: false, ownershipVerified: false,
        errors: (can && can.errors) || [err('ownership_mismatch', 'refuse start: ownership not verified')],
      };
    }
    ownershipOk = true; result.ownershipVerified = true;
    const start = await bound('startJob', () => azure.startJob({ attestation: att }));
    if (start && start.gate) { result = { ...result, ownershipVerified: true, errors: start.errors }; return result; }
    if (!start || start.ok !== true) {
      result = {
        ok: false, deleted: false, ownershipVerified: true, summary: null,
        errors: (start && start.errors) || [err('job_start_failed', 'start failed')],
      };
    } else {
      const wait = await bound('waitTerminal', () => azure.waitTerminal({
        attestation: att, executionName: start.executionName, assertActiveDrill: assertFn,
      }));
      if (wait && wait.gate) { result = { ...result, ownershipVerified: true, errors: wait.errors }; return result; }
      result = {
        ok: Boolean(wait && wait.ok), summary: (wait && wait.summary) || null,
        ownershipVerified: true, deleted: false,
        errors: (wait && wait.errors) || [], executionName: start.executionName,
      };
    }
  } catch (e) {
    result = {
      ok: false, summary: null, ownershipVerified: ownershipOk, deleted: false,
      errors: [err('operator_lifecycle_failed', redact(e.message, secrets))],
    };
  } finally {
    if (ownershipOk && azure.deleteJob) {
      try {
        const del = await bound('deleteJob', () => azure.deleteJob({ attestation: att }));
        if (del && del.gate) {
          result.ok = false; result.errors = (result.errors || []).concat(del.errors || []);
        } else {
          result.deleted = Boolean(del && del.ok && del.verifiedAbsent !== false);
          if (!result.deleted) {
            result.ok = false;
            result.errors = (result.errors || []).concat(
              (del && del.errors) || [err('job_delete_or_verify_failed', 'delete/verify failed')],
            );
          }
        }
      } catch (e2) {
        result.ok = false; result.deleted = false;
        result.errors = (result.errors || []).concat([err('job_delete_failed', redact(e2.message, secrets))]);
      }
    }
    if (azure.removeSignalHandlers) azure.removeSignalHandlers(proc);
  }
  return result;
}

const STAGE = 'saas-2d2'; const OWNER = 'messi-stage2d2'; const STAGE_TAG = 'saas-2d2-staging';
const CLI_REL = 'scripts/messi-saas-stage2d2-apply-rollback.js';
const LIB_REL = 'scripts/lib/messi-saas-stage2d2-apply-rollback.js';
const APPROVE_MAX_TOTAL_USD = 8; const TTL_HOURS_MAX = 48; const TTL_HOURS_MIN = 1;
const HOURS_PER_MONTH = 30 * 24; const ARM_API = '2022-09-01'; const DEP_API = '2021-04-01';
const APP_API = '2023-05-01'; const ROLE_API = '2022-04-01'; const LOC = 'westeurope';
const ACA_LOC = 'northeurope'; const ACR_NAME = 'whstagingacr'; const ACR_RG = 'wh-staging-rg';
const ACR_LOGIN = 'whstagingacr.azurecr.io'; const IMAGE_REPO = 'luna-sunset-staff-api';
const EXECUTOR_UAI_OID = 'e3136eed-948b-4947-a26e-50a33b45a41a';
const ROLE_CONTRIBUTOR = 'b24988ac-6180-42a0-ab88-20f7382dd24c';
const ROLE_RBAC_ADMIN = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168';
const ROLE_ACR_PUSH = '8311e382-0749-4cb8-b61a-304f252e45ec';
const ROLE_ACR_BUILD_RUNNER = 'fb382eab-e894-4461-af04-94435c366c3f';
const ROLE_OWNER = '8e3af657-a8ff-443c-a75c-2fe8c4bcb635';
const PREPARED_FOR = OWNER; const DRILL_BIND = OWNER;
const LEGITIMATE_PHASES = Object.freeze(['foundation', 'bootstrap-active', 'runtime-prereqs', 'runtime']);
const PHASE_MAX_MS = Object.freeze({
  'rg-create': 120000, infra: 1200000, bootstrap: 1200000, 'c2-operator': 1200000,
  'job-delete': 300000, 'runtime-prereqs': 1200000, roles: 600000, 'runtime-app': 1200000,
  'runtime-verify': 600000, 'cost-after': 120000, 'rg-delete': 1800000, poll: 120000,
});
const POLL_SLEEP_MS = 5000; const POLL_SLEEP_CAP_MS = 15000;
const SENTINELS = Object.freeze({
  stripeSecretKey: 'sk_test_disabled', stripeWebhookSecret: 'whsec_disabled',
  metaWhatsappToken: 'EAAG_disabled', metaAppSecret: 'meta_app_secret_disabled',
  metaWhatsappVerifyToken: 'meta_verify_disabled',
});

function err(code, message) { return { code, message }; }
function sha256(buf) {
  return crypto.createHash('sha256').update(buf == null ? '' : buf).digest('hex');
}
function redact(text, secrets) {
  let out = String(text || '');
  for (const s of secrets || []) {
    if (s && String(s).length >= 4) out = out.split(String(s)).join('[REDACTED]');
  }
  return d1.redact(out);
}
function createDeps(overrides = {}) {
  const repoRoot = overrides.repoRoot || path.join(__dirname, '..');
  const pins = overrides.pinnedBins || d1.PINNED_BINS;
  // Outside the git worktree: lock/receipt mkdir must not dirty porcelain before D1 preflight.
  const stateDir = overrides.stateDir || path.join(os.tmpdir(), 'messi-saas-stage2d2');
  const deps = {
    repoRoot, stateDir, pinnedBins: pins,
    sleep: overrides.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: overrides.now || (() => new Date()),
    process: overrides.process || process,
    randomBytes: overrides.randomBytes || ((n) => crypto.randomBytes(n)),
    d1: overrides.d1 || d1,
    bootstrapOperator: overrides.bootstrapOperator || null,
    snapshotAdapter: overrides.snapshotAdapter || null,
    toolAuthority: overrides.toolAuthority || null,
    verifiedDeploySha: overrides.verifiedDeploySha || null,
    inExactSnapshot: !!overrides.inExactSnapshot,
    bicepBuildBytes: overrides.bicepBuildBytes || null,
    hashFile: overrides.hashFile || null,
    bicepVersion: overrides.bicepVersion,
    gitExec: overrides.gitExec || ((args) => execFileSync(pins.git, args, {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()),
    azExec: overrides.azExec || ((args, envExtra) => execFileSync(pins.az, args, {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...d1.buildSanitizedChildEnv(), ...(envExtra || {}) },
    }).trim()),
    armRequest: overrides.armRequest || null,
    httpsRequest: overrides.httpsRequest || null,
    openLock: overrides.openLock || null,
    adoptAfterValidateHook: overrides.adoptAfterValidateHook || null,
    token: null,
    abortState: overrides.abortState || { aborted: false, signal: null },
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
    const raw = deps.azExec([
      'account', 'get-access-token', '--resource', 'https://management.azure.com/', '-o', 'json',
    ]);
    deps.token = JSON.parse(raw).accessToken;
  }
  const body = req.body != null ? JSON.stringify(req.body) : null;
  const headers = {
    Authorization: `Bearer ${deps.token}`, 'Content-Type': 'application/json', ...(req.headers || {}),
  };
  if (body) headers['Content-Length'] = Buffer.byteLength(body);
  const res = await genericHttps({
    method: req.method, hostname: 'management.azure.com', path: req.path, headers, body, timeout: 120000,
  });
  let parsed = res.body;
  try { parsed = res.body ? JSON.parse(res.body) : {}; } catch (_) { parsed = { raw: res.body }; }
  return { status: res.status, body: parsed, headers: res.headers };
}

function validateApprovalFlags(opts) {
  const errors = [];
  if (opts.approveMonthlyUsd != null || opts.confirmCostApproval != null || opts.maxMonthlyEstimate != null) {
    errors.push(err('monthly_approval_rejected', 'monthly approval semantics rejected; use --approve-max-total-usd + --ttl-hours'));
  }
  const maxTotal = Number(opts.approveMaxTotalUsd);
  const ttl = Number(opts.ttlHours);
  if (!Number.isFinite(maxTotal)) errors.push(err('approve_max_total_required', '--approve-max-total-usd required'));
  if (!Number.isFinite(ttl)) errors.push(err('ttl_hours_required', '--ttl-hours required'));
  if (Number.isFinite(ttl) && (!Number.isInteger(ttl) || ttl < TTL_HOURS_MIN || ttl > TTL_HOURS_MAX)) {
    errors.push(err('ttl_hours_invalid', `ttl-hours must be integer ${TTL_HOURS_MIN}..${TTL_HOURS_MAX}`));
  }
  if (Number.isFinite(maxTotal) && (!(maxTotal > 0) || maxTotal > APPROVE_MAX_TOTAL_USD)) {
    errors.push(err('approve_max_total_invalid', `--approve-max-total-usd must be >0 and <=${APPROVE_MAX_TOTAL_USD}`));
  }
  if (Number.isFinite(maxTotal) && maxTotal !== APPROVE_MAX_TOTAL_USD) {
    errors.push(err('approve_max_total_exact', `--approve-max-total-usd must be exactly ${APPROVE_MAX_TOTAL_USD}`));
  }
  if (Number.isFinite(ttl) && ttl !== TTL_HOURS_MAX) {
    errors.push(err('ttl_hours_exact', `--ttl-hours must be exactly ${TTL_HOURS_MAX}`));
  }
  return { ok: !errors.length, errors, approveMaxTotalUsd: maxTotal, ttlHours: ttl };
}
function estimateProratedWorstCaseUsd(estimatedMonthlyUsd, ttlHours) {
  return Number(estimatedMonthlyUsd) * (Number(ttlHours) / HOURS_PER_MONTH);
}
function assertCostGate({ estimatedMonthlyUsd, ttlHours, approveMaxTotalUsd, expiresAt, createdAt, now }) {
  const errors = [];
  const prorated = estimateProratedWorstCaseUsd(estimatedMonthlyUsd, ttlHours);
  if (!(prorated <= APPROVE_MAX_TOTAL_USD)) {
    errors.push(err('prorated_exceeds_hard_cap', `prorated worst-case ${prorated.toFixed(4)} > ${APPROVE_MAX_TOTAL_USD}`));
  }
  if (!(prorated <= Number(approveMaxTotalUsd))) {
    errors.push(err('prorated_exceeds_approval', `prorated ${prorated.toFixed(4)} > approved ${approveMaxTotalUsd}`));
  }
  const created = new Date(createdAt).getTime();
  const exp = new Date(expiresAt).getTime();
  const n = (now || new Date()).getTime();
  if (!(exp > created) || (exp - created) > TTL_HOURS_MAX * 3600 * 1000) {
    errors.push(err('expires_at_invalid', 'expiresAt must be > createdAt and within 48h'));
  }
  if (n >= exp) errors.push(err('ttl_expired', 'expiresAt reached — refusing continuation'));
  return { ok: !errors.length, errors, proratedWorstCaseUsd: prorated };
}
function drillTags({ tenantSlug, planDigest, deploySha, createdAt, expiresAt }) {
  return {
    tenant: tenantSlug, stage: STAGE_TAG, owner: OWNER, planDigest, deploySha,
    createdAt, expiresAt, temporaryDrill: 'true',
  };
}
function assertDrillTags(tags, expected) {
  const t = tags || {}; const exp = drillTags(expected); const errors = [];
  for (const k of Object.keys(exp)) {
    if (String(t[k] || '') !== String(exp[k])) errors.push(err('rg_tag_mismatch', `tag ${k} mismatch`));
  }
  const created = Date.parse(String(t.createdAt || ''));
  const expires = Date.parse(String(t.expiresAt || ''));
  if (!Number.isFinite(created) || !Number.isFinite(expires) || !(expires > created)
    || (expires - created) > TTL_HOURS_MAX * 3600 * 1000 || (expires - created) < TTL_HOURS_MIN * 3600 * 1000) {
    errors.push(err('drill_ttl_invalid', 'createdAt/expiresAt missing or outside 1..48h window'));
  }
  return { ok: !errors.length, errors };
}
function assertActiveDrill({ createdAt, expiresAt, now, phase, phaseMaxMs }) {
  const errors = [];
  const n = (now || new Date()).getTime();
  const created = Date.parse(String(createdAt || ''));
  const exp = Date.parse(String(expiresAt || ''));
  if (!Number.isFinite(created) || !Number.isFinite(exp) || !(exp > created)
    || (exp - created) > TTL_HOURS_MAX * 3600 * 1000) {
    errors.push(err('expires_at_invalid', 'expiresAt must be > createdAt and within 48h'));
  }
  if (Number.isFinite(exp) && n >= exp) {
    errors.push(err('ttl_expired', 'expiresAt reached — refusing continuation'));
  }
  const budget = phaseMaxMs != null ? phaseMaxMs : (PHASE_MAX_MS[phase] || PHASE_MAX_MS.poll);
  if (Number.isFinite(exp) && n < exp && (exp - n) <= budget) {
    errors.push(err('ttl_insufficient_for_phase', `remaining TTL <= phase budget for ${phase || 'poll'}`));
  }
  return { ok: !errors.length, errors, remainingMs: Number.isFinite(exp) ? exp - n : 0 };
}
function checkAbort(deps) {
  const st = deps.abortState || {};
  if (st.aborted) {
    return { ok: false, errors: [err('operation_aborted', `aborted by ${st.signal || 'signal'}`)] };
  }
  return { ok: true, errors: [] };
}
function installOperationSignals(deps) {
  const proc = deps.process || process;
  const state = deps.abortState || { aborted: false, signal: null };
  deps.abortState = state;
  const handler = (sig) => { state.aborted = true; state.signal = sig; };
  const sigs = ['SIGINT', 'SIGTERM'];
  for (const sig of sigs) {
    if (proc.on) proc.on(sig, handler);
  }
  return () => {
    for (const sig of sigs) {
      if (proc.removeListener) proc.removeListener(sig, handler);
    }
  };
}
function receiptPath(deps, slug) { return path.join(deps.stateDir, `${slug}.receipt.json`); }
function lockPath(deps, slug) { return path.join(deps.stateDir, `${slug}.op.lock`); }
function writeReceipt(deps, receipt) {
  fs.mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
  const p = receiptPath(deps, receipt.tenantSlug);
  const tmp = `${p}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  if (/postgres(ql)?:\/\//i.test(body) || /sk_live|whsec_|EAAG_/.test(body)) {
    throw Object.assign(new Error('secret_in_receipt'), { code: 'secret_in_receipt' });
  }
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, p);
  return p;
}
function readReceipt(deps, slug) {
  const p = receiptPath(deps, slug);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function acquireExclusiveLock(deps, slug) {
  fs.mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
  const lp = lockPath(deps, slug);
  try {
    const st = fs.lstatSync(lp);
    if (st.isSymbolicLink()) return { ok: false, errors: [err('lock_symlink', 'nofollow refused symlink lock')] };
  } catch (_) { /* absent */ }
  const open = deps.openLock || ((p) => {
    const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR
      | (fs.constants.O_NOFOLLOW || 0);
    return fs.openSync(p, flags, 0o600);
  });
  let fd;
  try { fd = open(lp); }
  catch (e) {
    return { ok: false, errors: [err('lock_busy', e.message || 'exclusive lock failed')] };
  }
  try { fs.writeSync(fd, `${process.pid}\n`); } catch (_) { /* */ }
  return {
    ok: true, path: lp, fd,
    release: () => {
      try { fs.closeSync(fd); } catch (_) { /* */ }
      try { fs.unlinkSync(lp); } catch (_) { /* */ }
    },
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
    postgresAdminPassword: pgPass, appDatabasePassword: appPass,
    staffSessionSecret: session, lunaBotInternalToken: bot, bootstrapAppRolePassword: appPass,
    bootstrapAdminDatabaseUrl: `postgresql://${enc(adminUser)}:${enc(pgPass)}@${host}:5432/${db}?sslmode=require`,
    appDatabaseUrl: `postgresql://${enc(appUser)}:${enc(appPass)}@${host}:5432/${db}?sslmode=require`,
    ...SENTINELS,
    locationWhatsappNumberA: '+10000000001', locationWhatsappNumberB: '+10000000002',
    locationWhatsappPhoneNumberIdA: '1000000000000001', locationWhatsappPhoneNumberIdB: '1000000000000002',
    locationInboxEmailA: `${slug}-a@inbox.${slug}.invalid`,
    locationInboxEmailB: `${slug}-b@inbox.${slug}.invalid`,
  };
}
function buildBootstrapAdminDsn({ slug, adminPassword }) {
  const host = `luna-${slug}-staging-pg-app.postgres.database.azure.com`;
  return `postgresql://${encodeURIComponent(`${slug}admin`)}:${encodeURIComponent(adminPassword)}@${host}:5432/${slug}_staging?sslmode=require`;
}
function installedAcrManifestShowArgv(tag) {
  return ['acr', 'manifest', 'show', '--name', `${IMAGE_REPO}:${tag}`, '--registry', ACR_NAME, '-o', 'json'];
}
function installedAcrBuildArgv(deploySha) {
  return [
    'acr', 'build', '--registry', ACR_NAME, '--resource-group', ACR_RG,
    '--image', `${IMAGE_REPO}:${deploySha}`, '-f', 'Dockerfile.luna-sunset-staff-api', '.',
  ];
}
function resolveImageDigest(deps, tag) {
  const argv = installedAcrManifestShowArgv(tag);
  let raw;
  try { raw = deps.azExec(argv); }
  catch (e) { return { ok: false, errors: [err('acr_manifest_show_failed', e.message)], argv }; }
  let digest = null;
  try {
    const j = JSON.parse(raw);
    // Azure CLI 2.87 `az acr manifest show` returns the immutable digest at config.digest.
    digest = j.digest
      || (j.config && j.config.digest)
      || (j.manifests && j.manifests[0] && j.manifests[0].digest)
      || null;
  } catch (_) {
    const m = String(raw || '').match(/sha256:[a-f0-9]{64}/i);
    digest = m ? m[0] : null;
  }
  if (!digest || !/^sha256:[a-f0-9]{64}$/i.test(digest)) {
    return { ok: false, errors: [err('image_digest_resolve', 'immutable digest missing')], argv };
  }
  return { ok: true, imageDigest: digest.toLowerCase().startsWith('sha256:') ? digest : `sha256:${digest}`, argv };
}
function buildStaffImage(deps, deploySha) {
  const pre = deps.d1.assertRepoDeployPreflight({
    repoRoot: deps.repoRoot, pinnedBins: deps.pinnedBins, gitExec: deps.gitExec,
  });
  if (!pre.ok) return pre;
  if (pre.verifiedDeploySha !== deploySha) {
    return { ok: false, errors: [err('image_sha_drift', 'deploySha drifted before acr build')] };
  }
  const buildArgv = installedAcrBuildArgv(deploySha);
  try { deps.azExec(buildArgv); }
  catch (e) { return { ok: false, errors: [err('acr_build_failed', e.message)], buildArgv }; }
  const dig = resolveImageDigest(deps, deploySha);
  if (!dig.ok) return dig;
  return { ok: true, imageDigest: dig.imageDigest, buildArgv, manifestArgv: dig.argv };
}
function buildNonsecretParams(names, deploySha, planDigest, phase, extras = {}) {
  return {
    tenantSlug: { value: names.tenantSlug }, environmentName: { value: 'staging' },
    location: { value: LOC }, containerAppsLocation: { value: ACA_LOC },
    appNamePrefix: { value: names.appNamePrefix },
    assertedResourceGroupName: { value: names.resourceGroupName },
    acrName: { value: ACR_NAME }, acrResourceGroupName: { value: ACR_RG },
    acrPullModuleName: { value: names.acrPullModuleName }, acrLoginServer: { value: ACR_LOGIN },
    staffApiImageRepository: { value: IMAGE_REPO }, staffApiImageTag: { value: deploySha },
    staffApiContainerName: { value: names.staffApiContainerName },
    enableSunsetRuntimeEnv: { value: false },
    schemaObserverJobName: { value: `${names.appNamePrefix}-sch-obs` },
    schemaObserverDatabaseSecretName: { value: `${names.tenantSlug}-schema-observer-database-url` },
    postgresSku: { value: d1.SKU_EST.postgresSku }, postgresVersion: { value: '15' },
    staffApiCpu: { value: d1.SKU_EST.staffApiCpu }, staffApiMemory: { value: d1.SKU_EST.staffApiMemory },
    logRetentionDays: { value: 30 }, postgresAdminUser: { value: names.postgresAdminUser },
    appDbName: { value: names.appDbName }, ownerTag: { value: OWNER },
    postgresAllowedIpAddresses: { value: [] },
    firewallRuleNamePrefix: { value: 'AllowTenantStagingEgress' },
    deployContainerApps: { value: true },
    deployStaffApi: { value: phase !== 'infra' },
    deploySchemaObserverJob: { value: false },
    staffApiMinReplicas: { value: phase === 'runtime-app' ? 1 : 0 },
    staffApiMaxReplicas: { value: phase === 'runtime-app' ? 1 : 0 },
    opsActionGroupResourceId: {
      value: `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}/providers/Microsoft.Insights/actionGroups/${names.opsActionGroupName}`,
    },
    opsActionGroupName: { value: names.opsActionGroupName },
    deployCapacityAlerts: { value: false },
    deploySha: { value: deploySha }, forceRevision: { value: deploySha },
    managedCertificateName: { value: 'unused-synthetic-no-cert' },
    staffApiCustomDomain: { value: 'unused.synthetic.invalid' },
    databaseUrlSecretName: { value: names.databaseUrlSecretName },
    staffActionsEnabled: { value: 'false' }, stripeLinksEnabled: { value: 'false' },
    whatsappDryRun: { value: 'true' }, capacityAlertNamePrefix: { value: names.tenantSlug },
    portalUrlTarget: { value: 'https://unused.synthetic.invalid' },
    planDigest: { value: planDigest }, stageTag: { value: STAGE_TAG },
    temporaryDrill: { value: extras.temporaryDrill || '' },
    createdAt: { value: extras.createdAt || '' },
    expiresAt: { value: extras.expiresAt || '' },
    deployBootstrapJob: { value: phase === 'bootstrap' },
    runtimeDeploymentPhase: {
      value: phase === 'runtime-prereqs' ? 'runtime-prereqs'
        : phase === 'runtime-app' ? 'runtime-app' : 'none',
    },
    runtimePrereqsVerified: { value: phase === 'runtime-app' },
    staffApiImageDigest: { value: extras.imageDigest || '' },
    bootstrapJobImageDigest: { value: extras.imageDigest || '' },
  };
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

function parseRetryAfterMs(headers, nowMs) {
  const h = headers || {};
  const raw = h['retry-after'] != null ? h['retry-after'] : h['Retry-After'];
  if (raw == null || raw === '') return null;
  const s = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.max(0, Math.round(Number(s) * 1000));
  const when = Date.parse(s);
  if (Number.isFinite(when)) return Math.max(0, when - (nowMs || Date.now()));
  return null;
}
function nextPollSleepMs(prevSleepMs, headers, nowMs) {
  const ra = parseRetryAfterMs(headers, nowMs);
  if (ra != null) return ra;
  if (prevSleepMs == null) return POLL_SLEEP_MS;
  return Math.min(POLL_SLEEP_CAP_MS, Math.max(POLL_SLEEP_MS, prevSleepMs * 2));
}
async function runBoundedPoll(deps, {
  phase, createdAt, expiresAt, drill, onTimeout, iterate,
}) {
  const budget = PHASE_MAX_MS[phase] || PHASE_MAX_MS.poll;
  const t0 = deps.now().getTime();
  const ttl = drill || (createdAt && expiresAt ? { createdAt, expiresAt } : null);
  let last = null; let polls = 0; let sleepMs = null;
  for (;;) {
    const aborted = checkAbort(deps);
    if (!aborted.ok) return { ...aborted, body: last && last.body, polls };
    if (ttl) {
      const active = assertActiveDrill({ ...ttl, now: deps.now(), phase, phaseMaxMs: 0 });
      if (!active.ok) return { ...active, body: last && last.body, polls };
    }
    if (deps.now().getTime() - t0 > budget) {
      return onTimeout
        ? await onTimeout({ body: last && last.body, polls, last })
        : { ok: false, errors: [err('arm_poll_timeout', 'bounded ARM poll exhausted')], body: last && last.body, polls };
    }
    const step = await iterate({ last, polls });
    if (step.last !== undefined) last = step.last;
    if (step.polls !== undefined) polls = step.polls;
    if (step.done) return step.result;
    sleepMs = nextPollSleepMs(sleepMs, step.headers, deps.now().getTime());
    await deps.sleep(sleepMs);
  }
}
async function pollArmTerminal(deps, reqPath, {
  okStates = ['Succeeded'], failStates = ['Failed', 'Canceled'],
  createdAt, expiresAt, phase = 'poll',
} = {}) {
  return runBoundedPoll(deps, {
    phase, createdAt, expiresAt,
    iterate: async ({ polls }) => {
      const res = await deps.armRequest({ method: 'GET', path: reqPath });
      const st = ((res.body || {}).properties || {}).provisioningState
        || ((res.body || {}).properties || {}).status || null;
      const next = polls + 1;
      if (okStates.includes(st)) {
        return { done: true, last: res, polls: next, result: { ok: true, body: res.body, status: st, polls: next } };
      }
      if (failStates.includes(st)) {
        return {
          done: true, last: res, polls: next,
          result: { ok: false, errors: [err('arm_terminal_failed', `state ${st}`)], body: res.body, status: st, polls: next },
        };
      }
      return { done: false, last: res, polls: next, headers: res.headers };
    },
  });
}
async function putAndPoll(deps, { method = 'PUT', path: reqPath, body, headers, createdAt, expiresAt, phase }) {
  const aborted = checkAbort(deps);
  if (!aborted.ok) return aborted;
  if (createdAt && expiresAt) {
    const active = assertActiveDrill({ createdAt, expiresAt, now: deps.now(), phase });
    if (!active.ok) return active;
  }
  const put = await deps.armRequest({ method, path: reqPath, body, headers });
  if (put.status < 200 || put.status >= 300) {
    return { ok: false, errors: [err('arm_put_failed', `status ${put.status}`)], put };
  }
  const polled = await pollArmTerminal(deps, reqPath, { createdAt, expiresAt, phase });
  return { ...polled, put };
}
async function deriveD1Authority(opts, deps) {
  const d1deps = deps.d1.createDeps({
    repoRoot: deps.repoRoot, pinnedBins: deps.pinnedBins, gitExec: deps.gitExec,
    azExec: deps.azExec, armRequest: deps.armRequest, httpsRequest: deps.httpsRequest,
    sleep: deps.sleep, now: deps.now,
    snapshotAdapter: deps.snapshotAdapter, toolAuthority: deps.toolAuthority,
    verifiedDeploySha: deps.verifiedDeploySha, inExactSnapshot: deps.inExactSnapshot,
    bicepBuildBytes: deps.bicepBuildBytes, hashFile: deps.hashFile, bicepVersion: deps.bicepVersion,
  });
  const auth = await deps.d1.deriveAuthority({ slug: opts.slug, actionGroupResourceId: opts.actionGroupResourceId }, d1deps);
  if (!auth.ok) return auth;
  if (!Buffer.isBuffer(auth.templateBytes) || !auth.compiled || !auth.compiled.template) {
    return { ok: false, errors: [err('d1_compiled_handoff', 'D1 did not supply compiled template bytes/object')] };
  }
  if (sha256(auth.templateBytes) !== auth.compiled.compiledTemplateSha256) {
    return { ok: false, errors: [err('d1_compiled_hash_mismatch', 'compiled bytes hash drift')] };
  }
  return auth;
}
function pasteReadyRollbackCommand(slug) {
  return `node scripts/messi-saas-stage2d2-apply-rollback.js rollback --slug ${slug} --confirm-delete luna-${slug}-staging-rg`;
}
function rgScopeId(names) {
  return `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}`;
}
function acrResourceId(names) {
  return `/subscriptions/${names.subscriptionId}/resourceGroups/${ACR_RG}/providers/Microsoft.ContainerRegistry/registries/${ACR_NAME}`;
}
function preparedTags({ tenantSlug, planDigest, deploySha }) {
  return { preparedFor: PREPARED_FOR, tenant: tenantSlug, planDigest, deploySha };
}
function buildPreparedRoleAssignments(names) {
  const rg = rgScopeId(names);
  const acr = acrResourceId(names);
  const mk = (kind, scope, roleDefinitionId) => {
    const name = azureArmGuid(scope, EXECUTOR_UAI_OID, roleDefinitionId, DRILL_BIND);
    return {
      kind, name, scope, roleDefinitionId, principalId: EXECUTOR_UAI_OID,
      id: `${scope}/providers/Microsoft.Authorization/roleAssignments/${name}`,
      roleDefinitionResourceId: `/subscriptions/${names.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${roleDefinitionId}`,
    };
  };
  return Object.freeze([
    mk('rg-contributor', rg, ROLE_CONTRIBUTOR),
    mk('rg-rbac-admin', rg, ROLE_RBAC_ADMIN),
    mk('acr-rbac-admin-temp', acr, ROLE_RBAC_ADMIN),
  ]);
}
function pasteReadyAcrCleanupCommand(names) {
  const temp = buildPreparedRoleAssignments(names).find((r) => r.kind === 'acr-rbac-admin-temp');
  return `az role assignment delete --ids ${temp.id}`;
}
function decodeTokenOid(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
    return claims && claims.oid != null ? String(claims.oid) : null;
  } catch (_) { return null; }
}
async function ensureToken(deps) {
  if (!deps.token) {
    const raw = deps.azExec([
      'account', 'get-access-token', '--resource', 'https://management.azure.com/', '-o', 'json',
    ]);
    deps.token = JSON.parse(raw).accessToken;
  }
  return deps.token;
}
async function assertActiveTokenExecutor(deps) {
  const token = await ensureToken(deps);
  const oid = decodeTokenOid(token);
  if (String(oid || '').toLowerCase() !== EXECUTOR_UAI_OID.toLowerCase()) {
    return { ok: false, errors: [err('executor_oid_mismatch', 'active token oid must equal approved executor')] };
  }
  return { ok: true, errors: [], oid };
}
function assertPreparedTags(tags, expected) {
  const exp = preparedTags(expected); const errors = [];
  for (const k of Object.keys(exp)) {
    if (String((tags || {})[k] || '') !== String(exp[k])) {
      errors.push(err('prepared_tag_mismatch', `tag ${k} mismatch`));
    }
  }
  return { ok: !errors.length, errors };
}
async function assertPreparedRoleAssignment(deps, expected) {
  const got = await deps.armRequest({ method: 'GET', path: `${expected.id}?api-version=${ROLE_API}` });
  if (got.status === 404) {
    return { ok: false, errors: [err('missing_prep_role', `missing ${expected.kind}`)] };
  }
  if (got.status < 200 || got.status >= 300) {
    return { ok: false, errors: [err('prep_role_read_failed', `status ${got.status}`)] };
  }
  const props = (got.body || {}).properties || {};
  const def = String(props.roleDefinitionId || '').toLowerCase();
  if (!def.endsWith(String(expected.roleDefinitionId).toLowerCase())) {
    return { ok: false, errors: [err('prep_role_definition_mismatch', `wrong role for ${expected.kind}`)] };
  }
  if (String(props.principalId || '').toLowerCase() !== String(expected.principalId).toLowerCase()) {
    return { ok: false, errors: [err('prep_role_principal_mismatch', `wrong principal for ${expected.kind}`)] };
  }
  if (Object.prototype.hasOwnProperty.call(props, 'scope')
    && String(props.scope || '').toLowerCase() !== String(expected.scope).toLowerCase()) {
    return { ok: false, errors: [err('prep_role_scope_mismatch', `wrong scope for ${expected.kind}`)] };
  }
  return { ok: true, errors: [], body: got.body, headers: got.headers };
}
function roleDefGuid(roleDefinitionId) {
  const m = String(roleDefinitionId || '').toLowerCase().match(/roledefinitions\/([0-9a-f-]{36})/i);
  return m ? m[1] : String(roleDefinitionId || '').toLowerCase().split('/').pop();
}
function normalizeArmScope(scope) {
  return String(scope || '').trim().replace(/\/+$/, '').toLowerCase();
}
function assignmentScopeFromRow(row) {
  const props = (row && row.properties) || {};
  if (Object.prototype.hasOwnProperty.call(props, 'scope') && props.scope != null && String(props.scope) !== '') {
    return String(props.scope);
  }
  const id = String((row && row.id) || '');
  const marker = '/providers/Microsoft.Authorization/roleAssignments/';
  const idx = id.toLowerCase().indexOf(marker.toLowerCase());
  if (idx > 0) return id.slice(0, idx);
  return null;
}
async function listDirectRoleAssignments(deps, scope) {
  const filter = encodeURIComponent('atScope()');
  const listed = await deps.armRequest({
    method: 'GET',
    path: `${scope}/providers/Microsoft.Authorization/roleAssignments?api-version=${ROLE_API}&$filter=${filter}`,
  });
  if (listed.status < 200 || listed.status >= 300) {
    return { ok: false, errors: [err('direct_role_list_failed', `status ${listed.status}`)], value: [] };
  }
  const want = normalizeArmScope(scope);
  const value = (((listed.body || {}).value) || []).filter((row) => {
    const got = assignmentScopeFromRow(row);
    if (got == null) return false;
    return normalizeArmScope(got) === want;
  });
  return { ok: true, errors: [], value };
}
async function assertPreparedRgInventory(deps, names, prepRoles) {
  const listPath = `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}/resources?api-version=${ARM_API}`;
  const listed = await deps.armRequest({ method: 'GET', path: listPath });
  if (listed.status < 200 || listed.status >= 300) {
    return { ok: false, errors: [err('inventory_list_failed', `status ${listed.status}`)] };
  }
  const allowed = new Set(
    prepRoles.filter((r) => r.kind.startsWith('rg-')).map((r) => String(r.name).toLowerCase()),
  );
  const resources = ((listed.body || {}).value) || [];
  for (const r of resources) {
    const typ = String(r.type || '');
    if (typ === 'Microsoft.Resources/deployments') continue;
    if (typ === 'Microsoft.Authorization/roleAssignments') {
      const nm = String(r.name || String(r.id || '').split('/').pop() || '').toLowerCase();
      if (allowed.has(nm)) continue;
      return {
        ok: false,
        errors: [err('unexpected_prep_role', `unexpected role assignment ${r.name}`)],
      };
    }
    return {
      ok: false,
      errors: [err('precreated_resource', `inventory not empty: ${typ}/${r.name}`)],
    };
  }
  return { ok: true, errors: [], resources };
}
async function assertExactDirectRgRoles(deps, names, prepRoles) {
  const rg = rgScopeId(names);
  const expected = prepRoles.filter((r) => r.kind.startsWith('rg-'));
  const listed = await listDirectRoleAssignments(deps, rg);
  if (!listed.ok) return listed;
  const byName = new Map();
  for (const row of listed.value) {
    const nm = String(row.name || String(row.id || '').split('/').pop() || '').toLowerCase();
    if (byName.has(nm)) {
      return { ok: false, errors: [err('extra_direct_rg_role', `duplicate direct RG role ${nm}`)] };
    }
    byName.set(nm, row);
  }
  if (byName.size !== expected.length) {
    return {
      ok: false,
      errors: [err('direct_rg_role_set_mismatch', `expected ${expected.length} direct RG roles, got ${byName.size}`)],
    };
  }
  for (const exp of expected) {
    const row = byName.get(String(exp.name).toLowerCase());
    if (!row) {
      return { ok: false, errors: [err('missing_direct_rg_role', `missing direct RG role ${exp.kind}`)] };
    }
    const props = row.properties || {};
    if (roleDefGuid(props.roleDefinitionId) !== String(exp.roleDefinitionId).toLowerCase()) {
      return { ok: false, errors: [err('prep_role_definition_mismatch', `wrong role for ${exp.kind}`)] };
    }
    if (String(props.principalId || '').toLowerCase() !== String(exp.principalId).toLowerCase()) {
      return { ok: false, errors: [err('prep_role_principal_mismatch', `wrong principal for ${exp.kind}`)] };
    }
    if (Object.prototype.hasOwnProperty.call(props, 'scope')
      && String(props.scope || '').toLowerCase() !== String(exp.scope).toLowerCase()) {
      return { ok: false, errors: [err('prep_role_scope_mismatch', `wrong scope for ${exp.kind}`)] };
    }
  }
  for (const nm of byName.keys()) {
    if (!expected.some((e) => String(e.name).toLowerCase() === nm)) {
      return { ok: false, errors: [err('extra_direct_rg_role', `unexpected direct RG role ${nm}`)] };
    }
  }
  return { ok: true, errors: [], value: listed.value };
}
async function assertExactExecutorAcrRoles(deps, names, prepRoles) {
  const acr = acrResourceId(names);
  const temp = prepRoles.find((r) => r.kind === 'acr-rbac-admin-temp');
  const listed = await listDirectRoleAssignments(deps, acr);
  if (!listed.ok) return listed;
  const allowed = new Set([
    ROLE_ACR_PUSH.toLowerCase(), ROLE_ACR_BUILD_RUNNER.toLowerCase(), ROLE_RBAC_ADMIN.toLowerCase(),
  ]);
  const seen = new Set();
  for (const row of listed.value) {
    const props = row.properties || {};
    if (String(props.principalId || '').toLowerCase() !== EXECUTOR_UAI_OID.toLowerCase()) continue;
    const def = roleDefGuid(props.roleDefinitionId);
    if (!allowed.has(def)) {
      return {
        ok: false,
        errors: [err('unexpected_acr_executor_role', `executor has non-allowed direct ACR role ${def}`)],
      };
    }
    if (seen.has(def)) {
      return { ok: false, errors: [err('duplicate_acr_executor_role', `duplicate executor ACR role ${def}`)] };
    }
    seen.add(def);
    if (def === ROLE_RBAC_ADMIN.toLowerCase()) {
      const nm = String(row.name || String(row.id || '').split('/').pop() || '').toLowerCase();
      if (temp && nm !== String(temp.name).toLowerCase()) {
        return {
          ok: false,
          errors: [err('acr_temp_rbac_name_mismatch', 'temp ACR RBAC-admin must be deterministic named grant')],
        };
      }
    }
  }
  if (!seen.has(ROLE_ACR_PUSH.toLowerCase()) || !seen.has(ROLE_ACR_BUILD_RUNNER.toLowerCase())) {
    return { ok: false, errors: [err('acr_build_roles_missing', 'AcrPush and ACR Build Runner must remain present')] };
  }
  if (!seen.has(ROLE_RBAC_ADMIN.toLowerCase())) {
    return { ok: false, errors: [err('missing_prep_role', 'missing acr-rbac-admin-temp')] };
  }
  if (seen.size !== 3) {
    return { ok: false, errors: [err('acr_executor_role_set_mismatch', 'executor ACR direct roles must be exact set of 3')] };
  }
  return { ok: true, errors: [], value: listed.value };
}
async function assertPreparedAuthzSnapshot(deps, names, prep) {
  const inv = await assertPreparedRgInventory(deps, names, prep);
  if (!inv.ok) return inv;
  const rgRoles = await assertExactDirectRgRoles(deps, names, prep);
  if (!rgRoles.ok) return rgRoles;
  for (const role of prep) {
    const chk = await assertPreparedRoleAssignment(deps, role);
    if (!chk.ok) return chk;
  }
  const acrRoles = await assertExactExecutorAcrRoles(deps, names, prep);
  if (!acrRoles.ok) return acrRoles;
  const oid = await assertActiveTokenExecutor(deps);
  if (!oid.ok) return oid;
  return { ok: true, errors: [] };
}
async function deleteExactTempAcrRbacAdmin(deps, names, opts = {}) {
  const expected = buildPreparedRoleAssignments(names).find((r) => r.kind === 'acr-rbac-admin-temp');
  if (opts.roleAssignmentId != null
    && String(opts.roleAssignmentId).toLowerCase() !== String(expected.id).toLowerCase()) {
    return {
      ok: false,
      errors: [err('acr_role_delete_refused', 'only exact temp ACR RBAC-admin assignment may be removed')],
    };
  }
  const got = await deps.armRequest({ method: 'GET', path: `${expected.id}?api-version=${ROLE_API}` });
  if (got.status === 404) return { ok: true, alreadyAbsent: true, deleted: false, id: expected.id };
  if (got.status < 200 || got.status >= 300) {
    return { ok: false, errors: [err('acr_temp_role_read_failed', `status ${got.status}`)] };
  }
  // Independent exact-GET identity contract: required body.id/name + properties
  // (principalId/roleDefinitionId/scope/principalType) must match before DELETE.
  const body = got.body || {};
  const props = body.properties || {};
  const idOk = Object.prototype.hasOwnProperty.call(body, 'id')
    && String(body.id).toLowerCase() === String(expected.id).toLowerCase();
  const nameOk = Object.prototype.hasOwnProperty.call(body, 'name')
    && String(body.name).toLowerCase() === String(expected.name).toLowerCase();
  const pOk = Object.prototype.hasOwnProperty.call(props, 'principalId')
    && String(props.principalId).toLowerCase() === EXECUTOR_UAI_OID.toLowerCase();
  const dOk = Object.prototype.hasOwnProperty.call(props, 'roleDefinitionId')
    && String(props.roleDefinitionId).toLowerCase()
      === String(expected.roleDefinitionResourceId).toLowerCase();
  const sOk = Object.prototype.hasOwnProperty.call(props, 'scope')
    && String(props.scope).toLowerCase() === String(expected.scope).toLowerCase();
  const ptOk = Object.prototype.hasOwnProperty.call(props, 'principalType')
    && String(props.principalType).toLowerCase() === 'serviceprincipal';
  if (!idOk) {
    return { ok: false, errors: [err('acr_temp_role_id_mismatch', 'wrong or missing assignment id')] };
  }
  if (!nameOk) {
    return { ok: false, errors: [err('acr_temp_role_name_mismatch', 'wrong or missing assignment name')] };
  }
  if (!pOk) {
    return { ok: false, errors: [err('acr_temp_role_principal_mismatch', 'wrong principal')] };
  }
  if (!dOk) {
    return { ok: false, errors: [err('acr_temp_role_definition_mismatch', 'wrong roleDefinitionId')] };
  }
  if (!sOk) {
    return { ok: false, errors: [err('acr_temp_role_scope_mismatch', 'wrong scope')] };
  }
  if (!ptOk) {
    return {
      ok: false,
      errors: [err('acr_temp_role_principal_type_mismatch', 'principalType must be ServicePrincipal')],
    };
  }
  // Live Microsoft.Authorization roleAssignments GET often returns 200 with no ETag
  // header/body field. Conditionally send If-Match only when Azure supplied one;
  // never fabricate or use '*'. Exact identity/scope/role gates above still apply.
  const etag = (got.headers && (got.headers.etag || got.headers.ETag))
    || (got.body && got.body.etag) || null;
  const delHeaders = etag ? { 'If-Match': etag } : {};
  const del = await deps.armRequest({
    method: 'DELETE', path: `${expected.id}?api-version=${ROLE_API}`, headers: delHeaders,
  });
  if (del.status === 412) return { ok: false, errors: [err('etag_race', 'If-Match precondition failed')] };
  if (!(del.status === 200 || del.status === 202 || del.status === 204 || del.status === 404)) {
    return { ok: false, errors: [err('acr_temp_role_delete_failed', `status ${del.status}`)] };
  }
  const readback = await deps.armRequest({ method: 'GET', path: `${expected.id}?api-version=${ROLE_API}` });
  if (readback.status !== 404) {
    return { ok: false, errors: [err('acr_temp_role_still_present', 'temp ACR RBAC-admin still present after delete')] };
  }
  return { ok: true, deleted: true, alreadyAbsent: false, id: expected.id };
}
async function adoptPreparedResourceGroup(deps, {
  names, planDigest, verifiedDeploySha, createdAt, expiresAt, tags,
}) {
  const cleanup = pasteReadyAcrCleanupCommand(names);
  const fail = (errors, extra = {}) => ({ ok: false, errors, acrCleanupCommand: cleanup, ...extra });
  const expectedId = rgScopeId(names);
  const rgPath = `/subscriptions/${names.subscriptionId}/resourcegroups/${names.resourceGroupName}?api-version=${ARM_API}`;
  const rg = await deps.armRequest({ method: 'GET', path: rgPath });
  if (rg.status === 404) {
    return fail([err('prepared_rg_absent', 'prepared RG required for --adopt-prepared-rg')]);
  }
  if (rg.status < 200 || rg.status >= 300) {
    return fail([err('rg_read_failed', `status ${rg.status}`)]);
  }
  const body = rg.body || {};
  const liveId = String(body.id || expectedId);
  if (liveId.toLowerCase() !== expectedId.toLowerCase()) {
    return fail([err('rg_id_mismatch', 'RG id mismatch')]);
  }
  if (String(body.location || '').toLowerCase() !== LOC) {
    return fail([err('rg_location_mismatch', `location must be ${LOC}`)]);
  }
  const tagCheck = assertPreparedTags(body.tags || {}, {
    tenantSlug: names.tenantSlug, planDigest, deploySha: verifiedDeploySha,
  });
  if (!tagCheck.ok) return fail(tagCheck.errors);
  const prep = buildPreparedRoleAssignments(names);
  const first = await assertPreparedAuthzSnapshot(deps, names, prep);
  if (!first.ok) return fail(first.errors);
  if (typeof deps.adoptAfterValidateHook === 'function') {
    await deps.adoptAfterValidateHook({ deps, names, prep });
  }
  // Live ARM Resource Group GET often returns 200 with no ETag header/body field.
  // Conditionally send If-Match only when Azure supplied one; never fabricate or use '*'.
  const etag = (rg.headers && (rg.headers.etag || rg.headers.ETag)) || body.etag || null;
  const putHeaders = etag ? { 'If-Match': etag } : {};
  const put = await deps.armRequest({
    method: 'PUT', path: rgPath, headers: putHeaders,
    body: { location: LOC, tags },
  });
  if (put.status === 412) return fail([err('etag_race', 'If-Match precondition failed')]);
  if (put.status < 200 || put.status >= 300) {
    return fail([err('rg_retag_failed', `status ${put.status}`)]);
  }
  const readback = await deps.armRequest({ method: 'GET', path: rgPath });
  if (readback.status < 200 || readback.status >= 300) {
    return fail([err('rg_read_failed', `status ${readback.status}`)], { retagged: true });
  }
  const rbBody = readback.body || {};
  const rbEtag = (readback.headers && (readback.headers.etag || readback.headers.ETag))
    || rbBody.etag || null;
  // Post-retag absence of RG ETag is accepted; drill tuple + inventory remain mandatory.
  const drillCheck = assertDrillTags(rbBody.tags || {}, {
    tenantSlug: names.tenantSlug, planDigest, deploySha: verifiedDeploySha, createdAt, expiresAt,
  });
  if (!drillCheck.ok) return fail(drillCheck.errors, { retagged: true });
  const second = await assertPreparedAuthzSnapshot(deps, names, prep);
  if (!second.ok) return fail(second.errors, { retagged: true });
  return {
    ok: true, errors: [], prep, createdAt, expiresAt, etag: rbEtag,
    acrCleanupCommand: cleanup, retagged: true,
  };
}
async function prepareSpec(opts, depsIn) {
  const deps = depsIn || createDeps();
  const approval = validateApprovalFlags(opts || {});
  if (!approval.ok) return approval;
  const auth = await deriveD1Authority(opts || {}, deps);
  if (!auth.ok) return auth;
  const { names, planDigest, verifiedDeploySha } = auth;
  const tags = preparedTags({
    tenantSlug: names.tenantSlug, planDigest, deploySha: verifiedDeploySha,
  });
  const roles = buildPreparedRoleAssignments(names);
  const rgId = rgScopeId(names);
  const tagArgs = Object.keys(tags).map((k) => `${k}=${tags[k]}`).join(' ');
  const azureAdminCommands = [
    `az group create --name ${names.resourceGroupName} --location ${LOC} --subscription ${names.subscriptionId} --tags ${tagArgs}`,
    ...roles.map((r) => (
      `az role assignment create --name ${r.name} --assignee-object-id ${EXECUTOR_UAI_OID}`
      + ` --assignee-principal-type ServicePrincipal --role ${r.roleDefinitionId}`
      + ` --scope ${r.scope} --subscription ${names.subscriptionId}`
    )),
  ];
  for (const c of azureAdminCommands) {
    if (/--scope\s+\/subscriptions\/[^/\s]+\s*$/i.test(c)
      && (c.includes(ROLE_CONTRIBUTOR) || c.includes(ROLE_OWNER) || /--role\s+Owner/i.test(c))) {
      return { ok: false, errors: [err('subscription_write_forbidden', 'never grant subscription Contributor/Owner')] };
    }
  }
  return {
    ok: true, errors: [], readOnly: true, kind: 'prepare_spec',
    tenantSlug: names.tenantSlug, planDigest, deploySha: verifiedDeploySha,
    executorPrincipalId: EXECUTOR_UAI_OID, approveMaxTotalUsd: approval.approveMaxTotalUsd,
    ttlHours: approval.ttlHours,
    resourceGroup: {
      name: names.resourceGroupName, id: rgId, location: LOC, tags,
      subscriptionId: names.subscriptionId,
    },
    roleAssignments: roles.map((r) => ({
      kind: r.kind, name: r.name, id: r.id, scope: r.scope,
      roleDefinitionId: r.roleDefinitionId, principalId: r.principalId,
    })),
    azureAdminCommands,
    acrCleanupCommand: pasteReadyAcrCleanupCommand(names),
    adoptCommand: `node scripts/messi-saas-stage2d2-apply-rollback.js apply --slug ${names.tenantSlug} --approve-max-total-usd 8 --ttl-hours 48 --adopt-prepared-rg`,
    neverGrant: Object.freeze(['subscription Contributor', 'subscription Owner']),
  };
}
async function deleteBootstrapJobExact(deps, names, drill) {
  const aborted = checkAbort(deps);
  if (!aborted.ok) return aborted;
  if (drill) {
    const active = assertActiveDrill({ ...drill, now: deps.now(), phase: 'job-delete' });
    if (!active.ok) return active;
  }
  const jobPath = `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}/providers/Microsoft.App/jobs/${names.bootstrapJobName}?api-version=${APP_API}`;
  const got = await deps.armRequest({ method: 'GET', path: jobPath });
  if (got.status === 404) return { ok: true, alreadyAbsent: true };
  if (got.status < 200 || got.status >= 300) {
    return { ok: false, errors: [err('job_read_failed', `status ${got.status}`)] };
  }
  const del = await deps.armRequest({ method: 'DELETE', path: jobPath });
  if (!(del.status === 200 || del.status === 202 || del.status === 204 || del.status === 404)) {
    return { ok: false, errors: [err('job_delete_failed', `status ${del.status}`)] };
  }
  return runBoundedPoll(deps, {
    phase: 'job-delete', drill,
    onTimeout: ({ body, polls }) => ({
      ok: false, errors: [err('job_delete_poll_timeout', 'job still present')], body, polls,
    }),
    iterate: async ({ polls }) => {
      const check = await deps.armRequest({ method: 'GET', path: jobPath });
      const next = polls + 1;
      if (check.status === 404) {
        return { done: true, last: check, polls: next, result: { ok: true, deleted: true, polls: next, body: check.body } };
      }
      return { done: false, last: check, polls: next, headers: check.headers };
    },
  });
}
async function waitExactRoles(deps, names, principalId, drill) {
  const contract = deps.d1.buildExpectedResourceContract(names, { principalId });
  return runBoundedPoll(deps, {
    phase: 'roles', drill,
    onTimeout: ({ body, polls }) => ({
      ok: false, errors: [err('role_propagation_timeout', 'exact KV/ACR role readback timed out')],
      body, attempts: polls,
    }),
    iterate: async ({ polls }) => {
      let all = true; let last = null;
      for (const role of contract.roleAssignments) {
        const expected = role.kind === 'acr'
          ? deps.d1.buildExpectedResourceContract(names, { principalId }).roleAssignments.find((x) => x.kind === 'acr')
          : role;
        if (!expected || !expected.id || !expected.name) { all = false; break; }
        const got = await deps.armRequest({ method: 'GET', path: `${expected.id}?api-version=${ROLE_API}` });
        last = got;
        if (got.status === 404) { all = false; break; }
        if (got.status < 200 || got.status >= 300) {
          return {
            done: true, last: got, polls: polls + 1,
            result: { ok: false, errors: [err('role_read_failed', `status ${got.status}`)], body: got.body },
          };
        }
        const props = (got.body || {}).properties || {};
        const def = String(props.roleDefinitionId || '').toLowerCase();
        if (!def.endsWith(String(expected.roleDefinitionId).toLowerCase())) { all = false; break; }
        if (Object.prototype.hasOwnProperty.call(props, 'principalId')
          && String(props.principalId || '').toLowerCase() !== String(principalId).toLowerCase()) {
          all = false; break;
        }
        if (Object.prototype.hasOwnProperty.call(props, 'scope')
          && String(props.scope || '').toLowerCase() !== String(expected.scope).toLowerCase()) {
          all = false; break;
        }
      }
      const next = polls + 1;
      if (all) return { done: true, last, polls: next, result: { ok: true, attempts: next, contract } };
      return { done: false, last, polls: next, headers: last && last.headers };
    },
  });
}
async function verifyRuntimeHealth(deps, names, imageDigest, drill) {
  const appPath = `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}/providers/Microsoft.App/containerApps/${names.staffApiAppName}?api-version=${APP_API}`;
  let appBody = null; let revProps = null;
  const polled = await runBoundedPoll(deps, {
    phase: 'runtime-verify', drill,
    onTimeout: ({ body }) => ({
      ok: false, errors: [err('revision_not_ready', 'revision/replica not healthy')], body,
    }),
    iterate: async () => {
      const app = await deps.armRequest({ method: 'GET', path: appPath });
      if (app.status < 200 || app.status >= 300) {
        return {
          done: true, last: app,
          result: { ok: false, errors: [err('app_read_failed', `status ${app.status}`)], body: app.body },
        };
      }
      appBody = app.body;
      const props = (appBody || {}).properties || {};
      const rev = props.latestRevisionName;
      if (!rev) return { done: false, last: app, headers: app.headers };
      const rr = await deps.armRequest({
        method: 'GET', path: `${appPath.replace(/\?.*$/, '')}/revisions/${rev}?api-version=${APP_API}`,
      });
      revProps = (rr.body || {}).properties || {};
      if (props.provisioningState === 'Succeeded'
        && String(revProps.runningState || '') === 'Running'
        && String(revProps.healthState || '') === 'Healthy'
        && Number(revProps.replicas || 0) >= 1) {
        return { done: true, last: rr, result: { ok: true } };
      }
      if (['Failed', 'Stopped'].includes(String(revProps.runningState || ''))) {
        return {
          done: true, last: rr,
          result: { ok: false, errors: [err('revision_terminal_failed', String(revProps.runningState))], body: rr.body },
        };
      }
      revProps = null;
      return { done: false, last: rr, headers: rr.headers };
    },
  });
  if (!polled.ok) return polled;
  if (!revProps) return { ok: false, errors: [err('revision_not_ready', 'revision/replica not healthy')] };
  const props = (appBody || {}).properties || {};
  const fqdn = ((props.configuration || {}).ingress || {}).fqdn;
  const containers = ((props.template || {}).containers) || [];
  const envMap = Object.fromEntries(((containers[0] && containers[0].env) || []).map((e) => [e.name, e.value]));
  const image = containers[0] && containers[0].image;
  if (!image || !String(image).includes(String(imageDigest).replace(/^sha256:/, ''))) {
    return { ok: false, errors: [err('image_digest_mismatch', 'runtime image digest mismatch')] };
  }
  if (envMap.DEFAULT_CLIENT_SLUG !== names.tenantSlug
    || envMap.STAFF_API_INGRESS_TENANT_SLUG !== names.tenantSlug) {
    return { ok: false, errors: [err('tenant_identity_mismatch', 'tenant identity env mismatch')] };
  }
  if (envMap.STAFF_ACTIONS_ENABLED !== 'false' || envMap.STRIPE_LINKS_ENABLED !== 'false'
    || envMap.WHATSAPP_DRY_RUN !== 'true') {
    return { ok: false, errors: [err('safety_flags_mismatch', 'safety flags not locked')] };
  }
  if (!fqdn) return { ok: false, errors: [err('app_fqdn_missing', 'fqdn missing')] };
  const health = await deps.httpsRequest({
    method: 'GET', hostname: fqdn, path: d1.HEALTH_IDENTITY_PATH, protocol: 'https:',
    headers: { host: fqdn }, rejectUnauthorized: true, timeout: 10000,
  });
  let body = null;
  try { body = JSON.parse(health.body); } catch (_) { body = null; }
  const idOk = health.status === 200
    && assertPublicHealthIdentityBody(body, names.tenantSlug).ok;
  if (!idOk) return { ok: false, errors: [err('health_identity_failed', 'HTTPS identity probe failed')] };
  return {
    ok: true, fqdn, image, replicas: Number(revProps.replicas || 0),
    latestRevisionName: props.latestRevisionName, healthIdentityBody: body,
  };
}

async function apply(opts, depsIn) {
  const deps = depsIn || createDeps();
  const secretsHeld = [];
  let lock = null;
  let invocationCreatedRg = false;
  let removeSignals = null;
  const optsIn = opts || {};
  try {
    const approval = validateApprovalFlags(optsIn);
    if (!approval.ok) return approval;
    // Authority/preflight before lock so an in-tree stateDir cannot trip dirty_tree.
    const auth = await deriveD1Authority(optsIn, deps);
    if (!auth.ok) return auth;
    lock = acquireExclusiveLock(deps, String(optsIn.slug || 'unknown'));
    if (!lock.ok) return lock;
    removeSignals = installOperationSignals(deps);
    const { names, planDigest, verifiedDeploySha, core, templateBytes, compiled } = auth;
    const aborted0 = checkAbort(deps);
    if (!aborted0.ok) return aborted0;
    const adoptPreparedRg = !!(optsIn.adoptPreparedRg);
    const rgCheck = await deps.armRequest({
      method: 'GET',
      path: `/subscriptions/${names.subscriptionId}/resourcegroups/${names.resourceGroupName}?api-version=${ARM_API}`,
    });
    if (!adoptPreparedRg && rgCheck.status !== 404) {
      return { ok: false, errors: [err('rg_exists', `target RG ${names.resourceGroupName} must be absent for APPLY`)] };
    }
    if (adoptPreparedRg && rgCheck.status === 404) {
      return {
        ok: false,
        errors: [err('prepared_rg_absent', 'prepared RG required for --adopt-prepared-rg')],
        acrCleanupCommand: pasteReadyAcrCleanupCommand(names),
      };
    }
    // One clock sample: dual deps.now() can advance 1ms and trip exact-48h expires_at_invalid.
    const nowMs = deps.now().getTime();
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + approval.ttlHours * 3600 * 1000).toISOString();
    const costGate = assertCostGate({
      estimatedMonthlyUsd: core.estimatedMonthlyUsd, ttlHours: approval.ttlHours,
      approveMaxTotalUsd: approval.approveMaxTotalUsd, createdAt, expiresAt, now: deps.now(),
    });
    if (!costGate.ok) return costGate;
    const img = buildStaffImage(deps, verifiedDeploySha);
    if (!img.ok) return img;
    const secrets = generateSecrets({ slug: names.tenantSlug, randomBytes: deps.randomBytes });
    secretsHeld.push(...Object.values(secrets).filter((v) => typeof v === 'string'));
    if (secrets.bootstrapAdminDatabaseUrl !== buildBootstrapAdminDsn({
      slug: names.tenantSlug, adminPassword: secrets.postgresAdminPassword,
    })) {
      return { ok: false, errors: [err('dsn_encode_mismatch', 'bootstrap admin DSN encoding mismatch')] };
    }
    const tags = drillTags({
      tenantSlug: names.tenantSlug, planDigest, deploySha: verifiedDeploySha, createdAt, expiresAt,
    });
    const drill = { createdAt, expiresAt };
    const drillExtras = { temporaryDrill: 'true', createdAt, expiresAt, imageDigest: img.imageDigest };
    const template = compiled.template;
    const phases = ['infra', 'bootstrap', 'c2-operator', 'job-delete', 'runtime-prereqs', 'roles', 'runtime-app', 'cost-after'];
    const deploymentIds = [];
    let runtime = null;
    let costAfter = null;
    let principalId = null;
    let acrCleanupCommand = pasteReadyAcrCleanupCommand(names);

    const phaseGate = (phase) => {
      const aborted = checkAbort(deps);
      if (!aborted.ok) return aborted;
      const active = assertActiveDrill({ createdAt, expiresAt, now: deps.now(), phase });
      if (!active.ok) return active;
      return assertCostGate({
        estimatedMonthlyUsd: core.estimatedMonthlyUsd, ttlHours: approval.ttlHours,
        approveMaxTotalUsd: approval.approveMaxTotalUsd, createdAt, expiresAt, now: deps.now(),
      });
    };

    {
      const g = phaseGate('rg-create'); if (!g.ok) return g;
      if (adoptPreparedRg) {
        const adopted = await adoptPreparedResourceGroup(deps, {
          names, planDigest, verifiedDeploySha, createdAt, expiresAt, tags,
        });
        if (!adopted.ok) {
          return preserveFailure(deps, {
            errors: adopted.errors, names, planDigest, verifiedDeploySha, tags,
            invocationCreatedRg: false, secretsHeld, opts: optsIn,
            acrCleanupCommand: adopted.acrCleanupCommand || acrCleanupCommand,
          });
        }
        invocationCreatedRg = true;
        acrCleanupCommand = adopted.acrCleanupCommand || acrCleanupCommand;
      } else {
        const rgPath = `/subscriptions/${names.subscriptionId}/resourcegroups/${names.resourceGroupName}?api-version=${ARM_API}`;
        const put = await deps.armRequest({
          method: 'PUT', path: rgPath, body: { location: LOC, tags },
        });
        if (put.status < 200 || put.status >= 300) {
          return { ok: false, errors: [err('rg_create_failed', `status ${put.status}`)] };
        }
        invocationCreatedRg = true;
      }
    }

    for (const phase of ['infra', 'bootstrap']) {
      const g = phaseGate(phase); if (!g.ok) {
        return preserveFailure(deps, {
          errors: g.errors, names, planDigest, verifiedDeploySha, tags, invocationCreatedRg, secretsHeld,
          opts: optsIn,
        });
      }
      const logical = phase;
      const params = attachSecureParams(
        buildNonsecretParams(names, verifiedDeploySha, planDigest, logical, drillExtras),
        secrets, logical,
      );
      const deployName = `messi-2d2-${phase}`;
      const depPath = `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}/providers/Microsoft.Resources/deployments/${deployName}?api-version=${DEP_API}`;
      const dep = await putAndPoll(deps, {
        path: depPath,
        body: { properties: { mode: 'Incremental', template, parameters: params } },
        createdAt, expiresAt, phase,
      });
      if (!dep.ok) {
        return preserveFailure(deps, {
          errors: dep.errors, names, planDigest, verifiedDeploySha, tags, invocationCreatedRg, secretsHeld,
          phase, opts: optsIn,
        });
      }
      deploymentIds.push((dep.body && dep.body.id) || depPath);
    }

    {
      const g = phaseGate('c2-operator'); if (!g.ok) {
        return preserveFailure(deps, {
          errors: g.errors, names, planDigest, verifiedDeploySha, tags, invocationCreatedRg, secretsHeld,
          opts: optsIn,
        });
      }
      const att = {
        tenantSlug: names.tenantSlug, expectedHost: `luna-${names.tenantSlug}-staging-pg-app.postgres.database.azure.com`,
        expectedDatabase: names.appDbName, expectedPort: 5432,
        subscriptionId: names.subscriptionId, resourceGroupName: names.resourceGroupName,
        acaEnvironmentId: `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}/providers/Microsoft.App/managedEnvironments/${names.containerAppsEnvironmentName}`,
        postgresServerId: `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${names.postgresServerName}`,
        planDigest, deploySha: verifiedDeploySha, owner: OWNER,
      };
      let op;
      const assertOpDrill = (b) => assertActiveDrill({
        createdAt, expiresAt, now: deps.now(), phase: 'c2-operator',
        phaseMaxMs: String(b || '').includes('waitTerminal') ? 0 : PHASE_MAX_MS['c2-operator'],
      });
      if (typeof deps.bootstrapOperator === 'function') {
        const azure = deps.bootstrapOperator({
          attestation: att, secrets: secretsHeld, azCommand: deps.pinnedBins.az,
          assertActiveDrill: assertOpDrill,
        });
        op = await runInjectedOperatorLifecycle({
          azure, attestation: att, secrets: secretsHeld, assertActiveDrill: assertOpDrill,
        });
      } else {
        const c2 = loadC2Operator();
        const azure = c2.createLocalAzOperator({
          attestation: att, secrets: secretsHeld, azCommand: deps.pinnedBins.az,
          assertActiveDrill: assertOpDrill, sleep: deps.sleep, now: () => deps.now().getTime(),
          pollMs: POLL_SLEEP_MS, timeoutMs: PHASE_MAX_MS['c2-operator'],
        });
        op = await c2.runOperatorJobLifecycle({
          attestation: att, secrets: secretsHeld, azure, assertActiveDrill: assertOpDrill,
        });
      }
      if (!op.ok) {
        return preserveFailure(deps, {
          errors: op.errors || [err('c2_operator_failed', 'bootstrap operator failed')],
          names, planDigest, verifiedDeploySha, tags, invocationCreatedRg, secretsHeld,
          phase: 'c2-operator', opts: optsIn,
        });
      }
    }

    {
      const g = phaseGate('job-delete'); if (!g.ok) {
        return preserveFailure(deps, {
          errors: g.errors, names, planDigest, verifiedDeploySha, tags, invocationCreatedRg, secretsHeld,
          opts: optsIn,
        });
      }
      const del = await deleteBootstrapJobExact(deps, names, drill);
      if (!del.ok) {
        return preserveFailure(deps, {
          errors: del.errors, names, planDigest, verifiedDeploySha, tags, invocationCreatedRg, secretsHeld,
          phase: 'job-delete', opts: optsIn,
        });
      }
    }

    {
      const g = phaseGate('runtime-prereqs'); if (!g.ok) {
        return preserveFailure(deps, {
          errors: g.errors, names, planDigest, verifiedDeploySha, tags, invocationCreatedRg, secretsHeld,
          opts: optsIn,
        });
      }
      const params = attachSecureParams(
        buildNonsecretParams(names, verifiedDeploySha, planDigest, 'runtime-prereqs', drillExtras),
        secrets, 'runtime-prereqs',
      );
      const deployName = 'messi-2d2-runtime-prereqs';
      const depPath = `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}/providers/Microsoft.Resources/deployments/${deployName}?api-version=${DEP_API}`;
      const dep = await putAndPoll(deps, {
        path: depPath,
        body: { properties: { mode: 'Incremental', template, parameters: params } },
        createdAt, expiresAt, phase: 'runtime-prereqs',
      });
      if (!dep.ok) {
        return preserveFailure(deps, {
          errors: dep.errors, names, planDigest, verifiedDeploySha, tags, invocationCreatedRg, secretsHeld,
          phase: 'runtime-prereqs', opts: optsIn,
        });
      }
      deploymentIds.push((dep.body && dep.body.id) || depPath);
    }

    {
      const g = phaseGate('roles'); if (!g.ok) {
        return preserveFailure(deps, {
          errors: g.errors, names, planDigest, verifiedDeploySha, tags, invocationCreatedRg, secretsHeld,
          opts: optsIn,
        });
      }
      const miPath = `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${names.identityName}?api-version=2023-01-31`;
      const mi = await deps.armRequest({ method: 'GET', path: miPath });
      principalId = String((((mi.body || {}).properties) || {}).principalId || '');
      if (!principalId) {
        return preserveFailure(deps, {
          errors: [err('principal_missing', 'managed identity principalId missing')],
          names, planDigest, verifiedDeploySha, tags, invocationCreatedRg, secretsHeld,
          phase: 'roles', opts: optsIn,
        });
      }
      const roles = await waitExactRoles(deps, names, principalId, drill);
      if (!roles.ok) {
        return preserveFailure(deps, {
          errors: roles.errors, names, planDigest, verifiedDeploySha, tags, invocationCreatedRg, secretsHeld,
          phase: 'roles', opts: optsIn,
        });
      }
    }

    {
      const g = phaseGate('runtime-app'); if (!g.ok) {
        return preserveFailure(deps, {
          errors: g.errors, names, planDigest, verifiedDeploySha, tags, invocationCreatedRg, secretsHeld,
          opts: optsIn,
        });
      }
      const params = attachSecureParams(
        buildNonsecretParams(names, verifiedDeploySha, planDigest, 'runtime-app', drillExtras),
        secrets, 'runtime-app',
      );
      const deployName = 'messi-2d2-runtime-app';
      const depPath = `/subscriptions/${names.subscriptionId}/resourceGroups/${names.resourceGroupName}/providers/Microsoft.Resources/deployments/${deployName}?api-version=${DEP_API}`;
      const dep = await putAndPoll(deps, {
        path: depPath,
        body: { properties: { mode: 'Incremental', template, parameters: params } },
        createdAt, expiresAt, phase: 'runtime-app',
      });
      if (!dep.ok) {
        return preserveFailure(deps, {
          errors: dep.errors, names, planDigest, verifiedDeploySha, tags, invocationCreatedRg, secretsHeld,
          phase: 'runtime-app', opts: optsIn,
        });
      }
      deploymentIds.push((dep.body && dep.body.id) || depPath);
      runtime = await verifyRuntimeHealth(deps, names, img.imageDigest, drill);
      if (!runtime.ok) {
        return preserveFailure(deps, {
          errors: runtime.errors, names, planDigest, verifiedDeploySha, tags, invocationCreatedRg, secretsHeld,
          phase: 'runtime-verify', opts: optsIn,
        });
      }
    }

    {
      const g = phaseGate('cost-after'); if (!g.ok) {
        return preserveFailure(deps, {
          errors: g.errors, names, planDigest, verifiedDeploySha, tags, invocationCreatedRg, secretsHeld,
          opts: optsIn,
        });
      }
      const cost = await deps.d1.queryRgCost(
        { armRequest: deps.armRequest, now: deps.now },
        names.subscriptionId, names.resourceGroupName,
      );
      if (!cost.ok) {
        return preserveFailure(deps, {
          errors: cost.errors, names, planDigest, verifiedDeploySha, tags, invocationCreatedRg, secretsHeld,
          phase: 'cost-after', opts: optsIn,
        });
      }
      costAfter = cost.currentCost;
    }

    const liveRg = await deps.armRequest({
      method: 'GET',
      path: `/subscriptions/${names.subscriptionId}/resourcegroups/${names.resourceGroupName}?api-version=${ARM_API}`,
    });
    const liveTags = (liveRg.body && liveRg.body.tags) || {};
    const tagEq = assertDrillTags(liveTags, {
      tenantSlug: names.tenantSlug, planDigest, deploySha: verifiedDeploySha, createdAt, expiresAt,
    });
    if (!tagEq.ok) {
      return preserveFailure(deps, {
        errors: [err('receipt_tag_mismatch', 'live RG tag tuple must equal drill exactly')].concat(tagEq.errors),
        names, planDigest, verifiedDeploySha, tags, invocationCreatedRg, secretsHeld,
        phase: 'receipt', opts: optsIn,
      });
    }

    const receipt = {
      schemaVersion: 1, kind: 'diagnostic_receipt_not_authority', tenantSlug: names.tenantSlug,
      resourceGroupName: names.resourceGroupName, subscriptionId: names.subscriptionId,
      planDigest, deploySha: verifiedDeploySha, compiledTemplateSha256: compiled.compiledTemplateSha256,
      compiledTemplateBytes: templateBytes.length, imageDigest: img.imageDigest,
      createdAt: liveTags.createdAt, expiresAt: liveTags.expiresAt, temporaryDrill: true,
      stage: STAGE, owner: OWNER, stageTag: STAGE_TAG,
      deploymentIds, fqdn: runtime.fqdn, replicas: runtime.replicas,
      latestRevisionName: runtime.latestRevisionName, costAfter,
      proratedWorstCaseUsd: costGate.proratedWorstCaseUsd,
      rollbackCommand: pasteReadyRollbackCommand(names.tenantSlug),
      phases,
    };
    const rp = writeReceipt(deps, receipt);
    return {
      ok: true, errors: [], receipt, receiptPath: rp, planDigest,
      deploySha: verifiedDeploySha, imageDigest: img.imageDigest,
      resourceGroupName: names.resourceGroupName, rollbackCommand: receipt.rollbackCommand,
    };
  } catch (e) {
    if (invocationCreatedRg) {
      try {
        return await preserveFailure(deps, {
          errors: [err('apply_exception', redact(e.message, secretsHeld))],
          names: { tenantSlug: String((optsIn || {}).slug || ''), resourceGroupName: `luna-${optsIn.slug}-staging-rg`, subscriptionId: '' },
          planDigest: null, verifiedDeploySha: null, tags: null, invocationCreatedRg, secretsHeld, opts: optsIn,
        });
      } catch (_) { /* fall through */ }
    }
    return {
      ok: false,
      errors: [err('apply_exception', redact(e.message, secretsHeld))],
      preservedResourceGroup: invocationCreatedRg,
    };
  } finally {
    if (typeof removeSignals === 'function') removeSignals();
    if (lock && lock.release) lock.release();
    secretsHeld.length = 0;
  }
}

async function preserveFailure(deps, ctx) {
  const acrCleanupCommand = ctx.acrCleanupCommand
    || (ctx.names && ctx.names.subscriptionId ? pasteReadyAcrCleanupCommand(ctx.names) : null);
  const base = {
    ok: false, errors: ctx.errors, preservedResourceGroup: true,
    invocationCreatedRg: !!ctx.invocationCreatedRg, phase: ctx.phase || null,
    acrCleanupCommand,
  };
  try {
    writeReceipt(deps, {
      schemaVersion: 1, kind: 'diagnostic_receipt_not_authority', status: 'apply_failed',
      tenantSlug: ctx.names.tenantSlug, resourceGroupName: ctx.names.resourceGroupName,
      subscriptionId: ctx.names.subscriptionId, planDigest: ctx.planDigest,
      deploySha: ctx.verifiedDeploySha, phase: ctx.phase || null,
      tags: ctx.tags, rollbackCommand: pasteReadyRollbackCommand(ctx.names.tenantSlug),
      acrCleanupCommand, preservedResourceGroup: true,
    });
  } catch (_) { /* receipt best-effort */ }
  if (ctx.opts && ctx.opts.rollbackOnFailure && ctx.invocationCreatedRg) {
    const rb = await rollback({
      slug: ctx.names.tenantSlug,
      confirmDelete: ctx.names.resourceGroupName,
      _internalFailureRollback: true,
    }, deps);
    return { ...base, rollbackOnFailure: rb };
  }
  return base;
}

async function writeRollbackDiagnostic(deps, ctx) {
  try {
    writeReceipt(deps, {
      schemaVersion: 1, kind: 'diagnostic_receipt_not_authority', status: ctx.status,
      tenantSlug: ctx.slug,
      resourceGroupName: (ctx.names && ctx.names.resourceGroupName) || `luna-${ctx.slug}-staging-rg`,
      subscriptionId: (ctx.names && ctx.names.subscriptionId) || null,
      planDigest: ctx.planDigest || null, deploySha: ctx.deploySha || null,
      phase: ctx.phase || null, signal: ctx.signal || null,
      errors: (ctx.errors || []).map((e) => ({ code: e.code, message: e.message })),
      rollbackCommand: pasteReadyRollbackCommand(ctx.slug),
    });
  } catch (_) { /* best-effort */ }
}

async function rollback(opts, depsIn) {
  const deps = depsIn || createDeps();
  let lock = null;
  let removeSignals = null;
  let rgKnownPresent = false;
  let namesRef = null;
  let planDigestRef = null;
  let deployShaRef = null;
  let phaseRef = null;
  const slug = String((opts || {}).slug || '');
  try {
    const confirm = String((opts || {}).confirmDelete || '');
    const expectedRg = `luna-${slug}-staging-rg`;
    if (!slug || confirm !== expectedRg) {
      return { ok: false, errors: [err('confirm_delete_required', `--confirm-delete ${expectedRg} required`)] };
    }
    const auth = await deriveD1Authority({ slug }, deps);
    if (!auth.ok) return auth;
    lock = acquireExclusiveLock(deps, slug);
    if (!lock.ok) return lock;
    removeSignals = installOperationSignals(deps);
    const { names, planDigest, verifiedDeploySha } = auth;
    namesRef = names; planDigestRef = planDigest; deployShaRef = verifiedDeploySha;
    if (names.resourceGroupName !== expectedRg) {
      return { ok: false, errors: [err('rg_name_mismatch', 'derived RG mismatch')] };
    }
    const aborted = checkAbort(deps);
    if (!aborted.ok) {
      return aborted;
    }
    const rgPath = `/subscriptions/${names.subscriptionId}/resourcegroups/${names.resourceGroupName}?api-version=${ARM_API}`;
    const rg = await deps.armRequest({ method: 'GET', path: rgPath });
    if (rg.status === 404) {
      const acrDel = await deleteExactTempAcrRbacAdmin(deps, names);
      return {
        ok: acrDel.ok, alreadyAbsent: true, resourceGroupName: expectedRg,
        acrTempRoleAbsent: !!(acrDel.ok && (acrDel.alreadyAbsent || acrDel.deleted)),
        acrCleanupCommand: pasteReadyAcrCleanupCommand(names),
        errors: acrDel.ok ? [] : acrDel.errors,
      };
    }
    if (rg.status < 200 || rg.status >= 300) {
      return { ok: false, errors: [err('rg_read_failed', `status ${rg.status}`)] };
    }
    rgKnownPresent = true;
    const tags = (rg.body && rg.body.tags) || {};
    // Capture optional RG ETag after ownership/provenance/inventory gates (not before).
    // Live ARM often omits RG ETag; delete without If-Match only when none was supplied.
    const etag = (rg.headers && (rg.headers.etag || rg.headers.ETag)) || (rg.body && rg.body.etag) || null;
    const drillCheck = assertDrillTags(tags, {
      tenantSlug: names.tenantSlug, planDigest, deploySha: verifiedDeploySha,
      createdAt: tags.createdAt, expiresAt: tags.expiresAt,
    });
    if (!drillCheck.ok) {
      return { ok: false, errors: [err('rollback_tag_mismatch', 'live RG tags do not match rederived drill ownership')].concat(drillCheck.errors) };
    }
    const live = await deps.d1.collectLiveInventory(deps, names, {
      tenant: names.tenantSlug, stage: STAGE_TAG, owner: OWNER, planDigest, deploySha: verifiedDeploySha,
    });
    if (!live.ok) return live;
    const phase = deps.d1.inferLivePhase(live);
    phaseRef = phase;
    if (!LEGITIMATE_PHASES.includes(phase)) {
      return {
        ok: false,
        errors: [err('rollback_phase_invalid', `phase ${phase} is not an exact legitimate complete contract`)],
        phase,
      };
    }
    const findings = deps.d1.phaseContractFindings(live, phase);
    if (findings.length) {
      return {
        ok: false,
        errors: [err('inventory_findings', 'refusing rollback with any D1 inventory finding')],
        findings, phase,
      };
    }
    const stop = checkAbort(deps);
    if (!stop.ok) {
      await writeRollbackDiagnostic(deps, {
        slug, names, status: 'rollback_aborted', errors: stop.errors,
        planDigest, deploySha: verifiedDeploySha, phase, signal: (deps.abortState || {}).signal,
      });
      return stop;
    }
    const delHeaders = etag ? { 'If-Match': etag } : {};
    const del = await deps.armRequest({
      method: 'DELETE', path: rgPath, headers: delHeaders,
    });
    if (del.status === 412) {
      return { ok: false, errors: [err('etag_race', 'If-Match precondition failed')] };
    }
    if (!(del.status === 200 || del.status === 202 || del.status === 204)) {
      return { ok: false, errors: [err('rg_delete_failed', `status ${del.status}`)] };
    }
    const polled = await runBoundedPoll(deps, {
      phase: 'rg-delete',
      onTimeout: async ({ body, polls }) => {
        const timeoutErr = [err('delete_poll_timeout', 'RG still present after delete')];
        await writeRollbackDiagnostic(deps, {
          slug, names, status: 'rollback_failed', errors: timeoutErr,
          planDigest, deploySha: verifiedDeploySha, phase,
        });
        return { ok: false, errors: timeoutErr, body, polls };
      },
      iterate: async ({ polls }) => {
        const check = await deps.armRequest({ method: 'GET', path: rgPath });
        const next = polls + 1;
        if (check.status === 404) {
          try { fs.unlinkSync(receiptPath(deps, slug)); } catch (_) { /* */ }
          return {
            done: true, last: check, polls: next,
            result: {
              ok: true, deleted: true, resourceGroupName: expectedRg, polls: next, phase, body: check.body,
            },
          };
        }
        return { done: false, last: check, polls: next, headers: check.headers };
      },
    });
    if (!polled.ok && (polled.errors || []).some((e) => e.code === 'operation_aborted')) {
      await writeRollbackDiagnostic(deps, {
        slug, names, status: 'rollback_aborted', errors: polled.errors,
        planDigest, deploySha: verifiedDeploySha, phase, signal: (deps.abortState || {}).signal,
      });
      return polled;
    }
    if (!polled.ok) return polled;
    const acrDel = await deleteExactTempAcrRbacAdmin(deps, names);
    if (!acrDel.ok) {
      return {
        ok: false, deleted: true, resourceGroupName: expectedRg, phase,
        acrTempRoleAbsent: false, acrCleanupCommand: pasteReadyAcrCleanupCommand(names),
        errors: acrDel.errors,
      };
    }
    return {
      ...polled,
      acrTempRoleAbsent: true,
      acrCleanupCommand: pasteReadyAcrCleanupCommand(names),
    };
  } catch (e) {
    const errors = [err('rollback_exception', redact(e.message, []))];
    if (rgKnownPresent) {
      await writeRollbackDiagnostic(deps, {
        slug, names: namesRef, status: 'rollback_failed', errors,
        planDigest: planDigestRef, deploySha: deployShaRef, phase: phaseRef,
      });
    }
    return { ok: false, errors };
  } finally {
    if (typeof removeSignals === 'function') removeSignals();
    if (lock && lock.release) lock.release();
  }
}

async function expiryStatus(opts, depsIn) {
  const deps = depsIn || createDeps();
  try {
    const auth = await deriveD1Authority(opts || {}, deps);
    if (!auth.ok) return auth;
    const { names, planDigest, verifiedDeploySha } = auth;
    const rgPath = `/subscriptions/${names.subscriptionId}/resourcegroups/${names.resourceGroupName}?api-version=${ARM_API}`;
    const rg = await deps.armRequest({ method: 'GET', path: rgPath });
    const rollbackCommand = pasteReadyRollbackCommand(names.tenantSlug);
    const acrCleanupCommand = pasteReadyAcrCleanupCommand(names);
    const temp = buildPreparedRoleAssignments(names).find((r) => r.kind === 'acr-rbac-admin-temp');
    const acrGot = await deps.armRequest({ method: 'GET', path: `${temp.id}?api-version=${ROLE_API}` });
    const warnings = [];
    if (acrGot.status === 200) {
      warnings.push({
        code: 'temp_acr_rbac_admin_present',
        message: 'temporary ACR Role Based Access Control Administrator assignment still present',
        roleAssignmentId: temp.id,
      });
    }
    if (rg.status === 404) {
      return {
        ok: true, present: false, expired: false, planDigest, deploySha: verifiedDeploySha,
        resourceGroupName: names.resourceGroupName, rollbackCommand, acrCleanupCommand, warnings,
      };
    }
    if (rg.status < 200 || rg.status >= 300) {
      return { ok: false, errors: [err('rg_read_failed', `status ${rg.status}`)] };
    }
    const tags = (rg.body && rg.body.tags) || {};
    const expiresAt = tags.expiresAt || null;
    const createdAt = tags.createdAt || null;
    const now = deps.now();
    const expired = !!(expiresAt && new Date(expiresAt).getTime() <= now.getTime());
    const within48 = !!(createdAt && expiresAt
      && (new Date(expiresAt).getTime() - new Date(createdAt).getTime()) <= TTL_HOURS_MAX * 3600 * 1000);
    return {
      ok: true, present: true, expired, within48hWindow: within48,
      createdAt, expiresAt, temporaryDrill: tags.temporaryDrill === 'true',
      planDigest: tags.planDigest || null, deploySha: tags.deploySha || null,
      rederivedPlanDigest: planDigest, rederivedDeploySha: verifiedDeploySha,
      resourceGroupName: names.resourceGroupName, rollbackCommand, acrCleanupCommand, warnings, tags,
    };
  } catch (e) {
    return { ok: false, errors: [err('expiry_status_exception', redact(e.message, []))] };
  }
}

module.exports = Object.freeze({
  STAGE, OWNER, STAGE_TAG, CLI_REL, LIB_REL, APPROVE_MAX_TOTAL_USD, TTL_HOURS_MAX, ACR_NAME, IMAGE_REPO,
  EXECUTOR_UAI_OID, ROLE_CONTRIBUTOR, ROLE_RBAC_ADMIN, ROLE_ACR_PUSH, ROLE_ACR_BUILD_RUNNER, PREPARED_FOR,
  SENTINELS, LEGITIMATE_PHASES, PHASE_MAX_MS, createDeps, apply, rollback, expiryStatus, prepareSpec,
  validateApprovalFlags, estimateProratedWorstCaseUsd, assertCostGate, assertActiveDrill, assertDrillTags,
  drillTags, preparedTags, buildPreparedRoleAssignments, deleteExactTempAcrRbacAdmin,
  pasteReadyAcrCleanupCommand, generateSecrets, buildBootstrapAdminDsn, installedAcrManifestShowArgv,
  installedAcrBuildArgv, resolveImageDigest, buildStaffImage, putAndPoll, pollArmTerminal,
  pasteReadyRollbackCommand, acquireExclusiveLock, writeReceipt, readReceipt, deriveD1Authority, redact,
  sha256, checkAbort, installOperationSignals, buildNonsecretParams, parseRetryAfterMs, nextPollSleepMs,
  runInjectedOperatorLifecycle, waitExactRoles, adoptPreparedResourceGroup, decodeTokenOid,
  listDirectRoleAssignments, assertExactDirectRgRoles, assertExactExecutorAcrRoles, assertPreparedAuthzSnapshot,
  normalizeArmScope, assignmentScopeFromRow,
});
