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
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

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

const TENANTS = Object.freeze({
  wolfhouse: Object.freeze({
    id: 'wolfhouse',
    resourceGroup: 'wh-staging-rg',
    containerApp: 'wh-staging-staff-api',
    publicBaseUrl: 'https://staff-staging.lunafrontdesk.com',
    imageRepository: 'whstagingacr.azurecr.io/wh-staff-api',
    expectedSecretRef: 'wolfhouse-database-url',
  }),
  sunset: Object.freeze({
    id: 'sunset',
    resourceGroup: 'luna-sunset-staging-rg',
    containerApp: 'luna-sunset-staging-staff-api',
    publicBaseUrl: 'https://sunset-staging.lunafrontdesk.com',
    imageRepository: 'whstagingacr.azurecr.io/luna-sunset-staff-api',
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
  const err = new Error(message || code);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
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
    throw fail('tenant_required', 'Support only explicit --tenant wolfhouse|sunset');
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
    );
  }
  return { mode: 'apply' };
}

function assertCliFailClosed(parsed) {
  if (parsed.help) return { help: true };
  if (parsed.unknown.length) {
    throw fail('unknown_flag', `Unknown flag(s): ${parsed.unknown.join(' ')}`);
  }
  if (parsed.positionals.length) {
    throw fail('unexpected_positional', `Unexpected positional(s): ${parsed.positionals.join(' ')}`);
  }
  if (!parsed.tenant) {
    throw fail('tenant_required', 'Support only explicit --tenant wolfhouse|sunset');
  }
  const tenant = resolveTenant(parsed.tenant);
  const mode = assertConfirmForApply(parsed);
  return { help: false, tenant, mode: mode.mode };
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
    throw fail('tenant_invalid', 'Unknown tenant');
  }
  if (FORBIDDEN_RESOURCE_GROUPS.includes(tenant.resourceGroup)) {
    throw fail('production_rg_refused', `Production RG refused: ${tenant.resourceGroup}`);
  }
  if (!tenant.resourceGroup.endsWith('-staging-rg') && !/-staging-/.test(tenant.resourceGroup)) {
    throw fail('non_staging_rg_refused', `Non-staging RG refused: ${tenant.resourceGroup}`);
  }
  if (isForbiddenHost(tenant.publicBaseUrl)) {
    throw fail('production_host_refused', `Production host refused: ${tenant.publicBaseUrl}`);
  }
  return true;
}

function getContainers(appShow) {
  const containers = appShow
    && appShow.properties
    && appShow.properties.template
    && appShow.properties.template.containers;
  if (!Array.isArray(containers) || containers.length < 1) {
    throw fail('template_missing_containers', 'App template has no containers');
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

function assertImagePinned(image, tenant) {
  const parsed = parseImage(image);
  if (!parsed.ok) throw fail(parsed.reason || 'image_invalid', 'Image missing or untagged', parsed);
  if (tenant && parsed.repository !== tenant.imageRepository) {
    throw fail('image_repository_mismatch', `Image repository mismatch: ${parsed.repository}`);
  }
  const tag = parsed.tag.toLowerCase();
  if (tag === 'latest' || tag === 'staging' || tag === 'prod' || tag === 'production') {
    throw fail('mutable_image_refused', `Mutable image tag refused: ${parsed.tag}`);
  }
  if (!tag.includes(IMAGE_SHA_SHORT.toLowerCase())) {
    throw fail('wrong_image_sha', `Image must pin staging SHA ${IMAGE_SHA_SHORT}`, parsed);
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
    throw fail('probes_missing', 'Container probes missing');
  }
  for (const need of ['Startup', 'Liveness', 'Readiness']) {
    if (![...types].some((t) => t.toLowerCase() === need.toLowerCase())) {
      throw fail('probes_incomplete', `Missing ${need} probe`);
    }
  }
  return probes;
}

function assertDatabaseSecretRef(container, tenant) {
  const entry = findEnvEntry(container, DATABASE_ENV_NAME);
  if (!entry) {
    throw fail('database_env_missing', `${DATABASE_ENV_NAME} missing from container env`);
  }
  if (Object.prototype.hasOwnProperty.call(entry, 'value') && entry.value != null && entry.value !== '') {
    throw fail('database_env_plaintext_refused', `${DATABASE_ENV_NAME} must be secretRef, not plaintext value`);
  }
  const ref = trimStr(entry.secretRef);
  if (!ref) {
    throw fail('database_secret_ref_missing', `${DATABASE_ENV_NAME} missing secretRef`);
  }
  if (tenant && ref !== tenant.expectedSecretRef) {
    throw fail('database_secret_ref_mismatch', `Expected secretRef ${tenant.expectedSecretRef}, got ${ref}`);
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

function assertSingleRevisionTraffic(appShow) {
  const traffic = trafficWeights(appShow);
  const active = traffic.filter((t) => Number(t && t.weight) > 0);
  if (active.length !== 1) {
    throw fail('multi_revision_traffic', 'Refuse multi-revision traffic; need exactly one weight>0 entry', {
      activeCount: active.length,
    });
  }
  const only = active[0];
  if (Number(only.weight) !== 100) {
    throw fail('traffic_not_100', 'Active traffic weight must be 100', only);
  }
  return only;
}

function latestReadyRevisionName(appShow) {
  return trimStr(
    appShow
      && appShow.properties
      && appShow.properties.latestReadyRevisionName,
  );
}

function assertBaselineState({ appShow, tenant }) {
  assertTenantPins(tenant);
  if (!appShow || typeof appShow !== 'object') {
    throw fail('app_show_missing', 'Missing container app show payload');
  }
  const container = primaryContainer(appShow);
  const image = assertImagePinned(container.image, tenant);
  const probes = assertProbesPresent(container);
  const dbEnv = assertDatabaseSecretRef(container, tenant);
  const traffic = assertSingleRevisionTraffic(appShow);
  const latestReady = latestReadyRevisionName(appShow);
  if (!latestReady) {
    throw fail('latest_ready_missing', 'latestReadyRevisionName missing');
  }
  return {
    containerName: trimStr(container.name) || tenant.containerApp,
    image,
    probes,
    dbEnv,
    traffic,
    latestReadyRevisionName: latestReady,
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
  if (idx < 0) throw fail('database_env_missing', `${DATABASE_ENV_NAME} missing`);
  env[idx] = { name: DATABASE_ENV_NAME, value: UNREACHABLE_DSN };
  // Prove narrow delta for callers/tests.
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
  // Image / probes / other template fields must be byte-equal aside from that env.
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

function classifyFailedRevision(revision, { latestReadyRevisionName: latestReady }) {
  const name = trimStr(revision && (revision.name || revision.id));
  const runningState = trimStr(revision && revision.properties && revision.properties.runningState)
    || trimStr(revision && revision.runningState);
  const health = (revision && revision.properties && revision.properties.healthState)
    || (revision && revision.healthState)
    || {};
  // ACA revision list exposes replicas summary inconsistently; accept explicit fields.
  const started = revision && (
    revision.properties && (
      revision.properties.runningState === 'Running'
      || revision.properties.provisioningState === 'Provisioned'
    )
  )
    ? true
    : revision && revision.started;
  const ready = revision && (
    Object.prototype.hasOwnProperty.call(revision, 'ready')
      ? revision.ready
      : (revision.properties && revision.properties.ready)
  );
  const restartCount = Number(
    (revision && revision.restartCount != null && revision.restartCount)
    || (revision && revision.properties && revision.properties.restartCount)
    || 0,
  );
  const trafficWeight = Number(
    (revision && revision.trafficWeight != null && revision.trafficWeight)
    || (revision && revision.properties && revision.properties.trafficWeight)
    || 0,
  );

  const observations = {
    name,
    runningState,
    started: started === true || runningState === 'Running',
    ready: ready === true,
    restartCount,
    trafficWeight,
    isLatestReady: Boolean(latestReady) && name === latestReady,
  };

  const pass = observations.started === true
    && observations.ready === false
    && observations.restartCount === 0
    && observations.isLatestReady === false
    && (observations.runningState === 'Running' || observations.runningState === '');

  return { ok: pass, observations };
}

function assertFailedRevisionObservation(revision, ctx) {
  const result = classifyFailedRevision(revision, ctx);
  if (!result.ok) {
    throw fail('failed_revision_not_observed', 'Failed revision observation did not match contract', result.observations);
  }
  return result.observations;
}

function assertRestoredState({ appShow, tenant, expectedImage, expectedSecretRef, expectedProbes }) {
  const baseline = assertBaselineState({ appShow, tenant });
  if (expectedImage && baseline.image.raw !== expectedImage) {
    throw fail('restore_image_mismatch', 'Restored image does not match original', {
      expected: expectedImage,
      actual: baseline.image.raw,
    });
  }
  if (expectedSecretRef && baseline.dbEnv.secretRef !== expectedSecretRef) {
    throw fail('restore_secret_ref_mismatch', 'Restored secretRef does not match original');
  }
  if (expectedProbes) {
    const got = JSON.stringify(baseline.probes);
    const want = JSON.stringify(expectedProbes);
    if (got !== want) {
      throw fail('restore_probes_mismatch', 'Restored probes do not match original');
    }
  }
  const entry = findEnvEntry(primaryContainer(appShow), DATABASE_ENV_NAME);
  if (entry && Object.prototype.hasOwnProperty.call(entry, 'value') && entry.value) {
    throw fail('restore_still_plaintext', 'Database env still plaintext after restore');
  }
  return baseline;
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
        || lower === 'value' && typeof val === 'string' && /postgres(ql)?:\/\//i.test(val)
        || lower.endsWith('connectionstring')
      ) {
        if (key === 'secretRef' || lower === 'secretref') {
          out[k] = val; // name only, not secret value
          continue;
        }
        if (typeof val === 'string' && val === UNREACHABLE_DSN) {
          out[k] = UNREACHABLE_DSN; // intentional non-secret drill DSN
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
    live_executed: mode === 'apply',
    tenant: tenant.id,
    resourceGroup: tenant.resourceGroup,
    containerApp: tenant.containerApp,
    publicBaseUrl: tenant.publicBaseUrl,
    database_env: DATABASE_ENV_NAME,
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
  // Outside repo: system temp, never under workspace.
  const dir = mkdtemp(path.join(tmpRoot, 'radar16q-'));
  if (dir.startsWith(path.join(__dirname, '..', '..'))) {
    throw fail('workdir_inside_repo', 'Work dir must be outside repo');
  }
  return dir;
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function installCleanupTrap(opts) {
  const {
    restore,
    onAfterRestore,
    signals = ['SIGINT', 'SIGTERM'],
    processRef = process,
  } = opts || {};
  if (typeof restore !== 'function') {
    throw fail('restore_fn_required', 'Cleanup trap requires restore function');
  }
  let armed = true;
  let restoring = false;
  const state = { armed: true, restoreCalls: 0, lastError: null };

  const runRestore = async (reason) => {
    if (!armed || restoring) return { skipped: true, reason: restoring ? 'in_flight' : 'disarmed' };
    restoring = true;
    state.restoreCalls += 1;
    try {
      await restore(reason);
      if (typeof onAfterRestore === 'function') await onAfterRestore(reason);
      return { ok: true, reason };
    } catch (err) {
      state.lastError = err;
      throw err;
    } finally {
      restoring = false;
    }
  };

  const handlers = {};
  for (const sig of signals) {
    handlers[sig] = () => {
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
  const start = now();
  let last;
  for (;;) {
    last = await predicate();
    if (last && last.ok) return last;
    if (now() - start >= timeoutMs) {
      throw fail('poll_timeout', `Timed out waiting for ${label}`, last);
    }
    await sleepMs(intervalMs, sleep);
  }
}

function checkRepoPreflight(deps) {
  const exec = deps && deps.execGit;
  if (typeof exec !== 'function') {
    throw fail('git_exec_required', 'git exec helper required');
  }
  const status = trimStr(exec('git status --porcelain'));
  if (status) {
    throw fail('dirty_repo', 'Refuse dirty repo', status.slice(0, 400));
  }
  const head = trimStr(exec('git rev-parse HEAD'));
  const originMaster = trimStr(exec('git rev-parse origin/master'));
  if (originMaster !== MASTER_BASIS) {
    throw fail('wrong_master', `origin/master must be ${MASTER_BASIS}`, {
      originMaster,
      head,
    });
  }
  // Require fetch-sync: local origin/master matches; optionally compare to upstream tip via deps.
  if (typeof deps.execAssertRepoSync === 'function') {
    deps.execAssertRepoSync();
  }
  return { head, originMaster };
}

function planDryRun({ tenant, baseline, delta, workDir }) {
  return {
    mode: 'dry-run',
    slice: SLICE,
    tenant: tenant.id,
    resourceGroup: tenant.resourceGroup,
    containerApp: tenant.containerApp,
    publicBaseUrl: tenant.publicBaseUrl,
    database_env: DATABASE_ENV_NAME,
    image: baseline.image.raw,
    latestReadyRevisionName: baseline.latestReadyRevisionName,
    delta,
    workDir,
    would: [
      'capture template/revisions/image/probes to temp outside repo',
      'install cleanup trap before mutation',
      `set ${DATABASE_ENV_NAME} to unreachable non-secret DSN`,
      'apply narrow template',
      'observe failed revision Running/started=true/ready=false/restartCount=0 not latest-ready',
      'confirm public old revision /healthz and /readyz stay 200',
      'restore exact original template',
      'wait healthy latest-ready; verify image/probes/env secretRef/endpoints',
      'write machine-readable redacted evidence',
    ],
    live_mutation: false,
  };
}

/**
 * Orchestrate dry-run or apply. Azure/HTTP/git injected via deps (tests mock).
 * Default path is dry-run; apply requires confirm token already validated.
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
  evidence.steps.push({ id: 'repo_preflight', ok: true });

  if (typeof deps.showApp !== 'function') {
    throw fail('show_app_required', 'showApp dependency required');
  }
  const appShow = await deps.showApp(tenant);
  const baseline = assertBaselineState({ appShow, tenant });
  evidence.steps.push({
    id: 'baseline_validated',
    ok: true,
    image: baseline.image.raw,
    secretRef: baseline.dbEnv.secretRef,
    latestReadyRevisionName: baseline.latestReadyRevisionName,
  });

  const workDir = opts.workDir || createWorkDir({
    mkdtemp: deps.mkdtemp,
    tmpRoot: deps.tmpRoot,
  });
  evidence.workDir = workDir;

  const originalPath = path.join(workDir, 'original-app.redacted.json');
  const failurePath = path.join(workDir, 'failure-template.redacted.json');
  const evidencePath = path.join(workDir, 'evidence.json');
  writeJson(originalPath, redactSecretsDeep(appShow));

  const { app: failureApp, delta } = buildFailureTemplate(appShow, tenant);
  const narrow = envDeltaOnlyDatabase(appShow, failureApp);
  if (!narrow.ok) {
    throw fail('template_delta_not_narrow', 'Failure template must change only database env', narrow);
  }
  writeJson(failurePath, redactSecretsDeep(failureApp));

  if (mode === 'dry-run') {
    const plan = planDryRun({ tenant, baseline, delta, workDir });
    evidence.steps.push({ id: 'dry_run_plan', ok: true, plan });
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
    };
  }

  // ── apply path ──────────────────────────────────────────────────────────
  if (typeof deps.applyTemplate !== 'function' || typeof deps.listRevisions !== 'function') {
    throw fail('apply_deps_required', 'applyTemplate and listRevisions required for --apply');
  }
  if (typeof deps.httpGet !== 'function') {
    throw fail('http_get_required', 'httpGet required for --apply');
  }

  let mutated = false;
  const restore = async (reason) => {
    evidence.steps.push({ id: 'restore_begin', ok: true, reason: String(reason || '') });
    await deps.applyTemplate(tenant, appShow, { purpose: 'restore', reason });
    mutated = false;
    const restoredShow = typeof deps.showAppAfter === 'function'
      ? await deps.showAppAfter(tenant)
      : await deps.showApp(tenant);
    assertRestoredState({
      appShow: restoredShow,
      tenant,
      expectedImage: baseline.image.raw,
      expectedSecretRef: baseline.dbEnv.secretRef,
      expectedProbes: baseline.probes,
    });
    const health = await deps.httpGet(`${tenant.publicBaseUrl}/healthz`);
    const ready = await deps.httpGet(`${tenant.publicBaseUrl}/readyz`);
    if (Number(health.status) !== 200 || Number(ready.status) !== 200) {
      throw fail('restore_endpoints_unhealthy', 'Public endpoints not 200 after restore', {
        health: health.status,
        ready: ready.status,
      });
    }
    evidence.steps.push({
      id: 'restore_verified',
      ok: true,
      health: health.status,
      ready: ready.status,
    });
  };

  const trap = installCleanupTrap({
    restore,
    processRef: deps.processRef || process,
    signals: deps.signals || ['SIGINT', 'SIGTERM'],
  });

  try {
    // Public endpoints must be healthy before mutation.
    const healthBefore = await deps.httpGet(`${tenant.publicBaseUrl}/healthz`);
    const readyBefore = await deps.httpGet(`${tenant.publicBaseUrl}/readyz`);
    if (Number(healthBefore.status) !== 200 || Number(readyBefore.status) !== 200) {
      throw fail('baseline_endpoints_unhealthy', 'Refuse apply: public health/ready not 200', {
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

    await deps.applyTemplate(tenant, failureApp, { purpose: 'failure_inject' });
    mutated = true;
    evidence.steps.push({ id: 'failure_template_applied', ok: true });

    const failureObs = await pollUntil(async () => {
      const revisions = await deps.listRevisions(tenant);
      const latestReady = baseline.latestReadyRevisionName;
      const candidates = (Array.isArray(revisions) ? revisions : [])
        .filter((r) => {
          const n = trimStr(r && (r.name || r.id));
          return n && n !== latestReady;
        });
      for (const rev of candidates) {
        const classified = classifyFailedRevision(rev, {
          latestReadyRevisionName: latestReady,
        });
        if (classified.ok) {
          return { ok: true, revision: classified.observations, all: revisions };
        }
      }
      return { ok: false, candidates: candidates.length };
    }, {
      timeoutMs: (opts.poll && opts.poll.failureTimeoutMs) || DEFAULT_POLL.failureTimeoutMs,
      intervalMs: (opts.poll && opts.poll.intervalMs) || DEFAULT_POLL.intervalMs,
      now: deps.now,
      sleep: deps.sleep,
      label: 'failed_revision',
    });
    evidence.steps.push({
      id: 'failed_revision_observed',
      ok: true,
      revision: failureObs.revision,
    });

    // Old public revision must stay healthy while failed rev is not latest-ready.
    const healthDuring = await deps.httpGet(`${tenant.publicBaseUrl}/healthz`);
    const readyDuring = await deps.httpGet(`${tenant.publicBaseUrl}/readyz`);
    if (Number(healthDuring.status) !== 200 || Number(readyDuring.status) !== 200) {
      throw fail('old_revision_endpoints_failed', 'Public old revision health/ready must stay 200', {
        health: healthDuring.status,
        ready: readyDuring.status,
      });
    }
    evidence.steps.push({
      id: 'old_revision_public_ok',
      ok: true,
      health: healthDuring.status,
      ready: readyDuring.status,
    });

    await restore('success_path');
    mutated = false;

    await pollUntil(async () => {
      const show = typeof deps.showAppAfter === 'function'
        ? await deps.showAppAfter(tenant)
        : await deps.showApp(tenant);
      const readyName = latestReadyRevisionName(show);
      const health = await deps.httpGet(`${tenant.publicBaseUrl}/healthz`);
      const ready = await deps.httpGet(`${tenant.publicBaseUrl}/readyz`);
      const restoredOk = (() => {
        try {
          assertRestoredState({
            appShow: show,
            tenant,
            expectedImage: baseline.image.raw,
            expectedSecretRef: baseline.dbEnv.secretRef,
            expectedProbes: baseline.probes,
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
      label: 'restore_healthy_latest_ready',
    });

    evidence.steps.push({ id: 'restore_healthy_latest_ready', ok: true });
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
      restored: true,
    };
  } catch (err) {
    evidence.steps.push({
      id: 'error',
      ok: false,
      code: err && err.code,
      message: trimStr(err && err.message).slice(0, 400),
    });
    if (mutated) {
      try {
        await trap.restoreNow(`error:${err && err.code ? err.code : 'unknown'}`);
        evidence.steps.push({ id: 'error_path_restore', ok: true });
      } catch (restoreErr) {
        evidence.steps.push({
          id: 'error_path_restore',
          ok: false,
          message: trimStr(restoreErr && restoreErr.message).slice(0, 400),
        });
      }
    }
    evidence.timestamps_utc.finished = new Date().toISOString();
    try {
      writeJson(evidencePath, evidence);
    } catch (_) { /* ignore */ }
    trap.disarm();
    throw err;
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
  TENANTS,
  FORBIDDEN_RESOURCE_GROUPS,
  FORBIDDEN_HOST_SUFFIXES,
  DEFAULT_POLL,
  CONTRACT_REL,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  deepClone,
  parseCliArgs,
  resolveTenant,
  assertCliFailClosed,
  assertConfirmForApply,
  assertTenantPins,
  isForbiddenHost,
  primaryContainer,
  findEnvEntry,
  parseImage,
  assertImagePinned,
  assertProbesPresent,
  assertDatabaseSecretRef,
  assertSingleRevisionTraffic,
  assertBaselineState,
  buildFailureTemplate,
  envDeltaOnlyDatabase,
  classifyFailedRevision,
  assertFailedRevisionObservation,
  assertRestoredState,
  redactSecretsDeep,
  buildEvidenceSkeleton,
  createWorkDir,
  installCleanupTrap,
  pollUntil,
  checkRepoPreflight,
  planDryRun,
  runHarness,
  sha256Hex,
  latestReadyRevisionName,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
