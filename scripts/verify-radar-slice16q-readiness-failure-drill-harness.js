'use strict';

/**
 * verify:radar-slice16q-readiness-failure-drill-harness — RADAR Slice 16Q
 *
 * Offline gate: fail-closed readiness-failure drill harness (source-partial).
 * Mock RED/GREEN covers every refuse point + restoration. No Azure / live apply.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16q-readiness-failure-drill-harness');

let pass = 0;
let fail = 0;
const redResults = [];
const greenResults = [];

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${name}`);
  if (detail) console.log(`        ${detail}`);
  return false;
}

function red(id, cond, detail) {
  redResults.push({ id, ok: !!cond });
  return ok(`RED ${id}`, cond, detail);
}

function green(id, cond, detail) {
  greenResults.push({ id, ok: !!cond });
  return ok(`GREEN ${id}`, cond, detail);
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function currentBranch() {
  return execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
}

function runtimePathsUnchanged() {
  try {
    const out = execSync(
      `git diff --name-only ${locks.MASTER_BASIS} -- ${locks.MUST_NOT_MUTATE.join(' ')}`,
      { cwd: ROOT, encoding: 'utf8' },
    ).trim();
    return { ok: out === '', detail: out || '(clean)' };
  } catch (err) {
    return { ok: false, detail: String(err && err.message) };
  }
}

function secretFree(text, label) {
  const patterns = [
    /sk_live_[A-Za-z0-9]+/,
    /sk_test_[A-Za-z0-9]{20,}/,
    /whsec_[A-Za-z0-9]+/,
    /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
    /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/i,
  ];
  for (const re of patterns) {
    // Allow the intentional unreachable non-secret drill DSN only.
    if (re.test(text)) {
      if (re.source.includes('postgres') && text.includes(locks.UNREACHABLE_DSN)) {
        const stripped = text.split(locks.UNREACHABLE_DSN).join('');
        if (!re.test(stripped)) continue;
      }
      return { ok: false, detail: `${label} matched ${re}` };
    }
  }
  return { ok: true };
}

function makeAppShow(tenant, overrides) {
  const o = overrides || {};
  const secretRef = o.secretRef != null ? o.secretRef : tenant.expectedSecretRef;
  const image = o.image != null
    ? o.image
    : `${tenant.imageRepository}:${locks.IMAGE_SHA_FULL}`;
  const probes = o.probes != null ? o.probes : [
    { type: 'Startup', httpGet: { path: '/healthz', port: 3036 } },
    { type: 'Liveness', httpGet: { path: '/healthz', port: 3036 } },
    { type: 'Readiness', httpGet: { path: '/readyz', port: 3036 } },
  ];
  const env = o.env != null ? o.env : [
    { name: 'NODE_ENV', value: 'staging' },
    { name: locks.DATABASE_ENV_NAME, secretRef },
    { name: 'STRIPE_SECRET_KEY', secretRef: 'stripe-secret-key' },
  ];
  const traffic = o.traffic != null ? o.traffic : [
    { revisionName: `${tenant.containerApp}--0000516`, weight: 100, latestRevision: true },
  ];
  const latestReady = o.latestReadyRevisionName != null
    ? o.latestReadyRevisionName
    : `${tenant.containerApp}--0000516`;

  return {
    name: tenant.containerApp,
    type: 'Microsoft.App/containerApps',
    location: 'northeurope',
    properties: {
      latestReadyRevisionName: latestReady,
      configuration: {
        ingress: { traffic, fqdn: tenant.publicBaseUrl.replace(/^https?:\/\//, '') },
        secrets: [
          { name: secretRef, value: 'SUPER_SECRET_SHOULD_NEVER_LEAK' },
        ],
      },
      template: {
        containers: [
          {
            name: tenant.containerApp,
            image,
            env,
            probes,
          },
        ],
      },
    },
  };
}

function makeFailedRevision(name) {
  return {
    name,
    properties: {
      runningState: 'Running',
      ready: false,
      restartCount: 0,
      trafficWeight: 0,
    },
    started: true,
    ready: false,
    restartCount: 0,
    trafficWeight: 0,
  };
}

console.log('verify:radar-slice16q-readiness-failure-drill-harness — RADAR Slice 16Q\n');

const contract = readJson(locks.CONTRACT_REL);
const headBranch = currentBranch();

green('locks_pinned',
  locks.SLICE === 'RADAR-16Q'
  && locks.OUTCOME_ID === '16Q_readiness_failure_drill_harness'
  && locks.GATE_ID === 'G02_readiness_dependencies'
  && locks.PROGRESS_CLASS === 'source_partial_progress_only'
  && locks.MASTER_BASIS === '06b7a3f2173863afa81bfc557cd31cbd3e80d6c1'
  && locks.IMAGE_SHA_SHORT === '594247f'
  && locks.CONFIRM_TOKEN === 'RADAR-16Q-READINESS-FAILURE-DRILL'
  && locks.DATABASE_ENV_NAME === 'WOLFHOUSE_DATABASE_URL'
  && locks.BRANCH === 'radar/slice-16q-readiness-failure-drill-harness');

green('contract_matches_locks',
  contract.slice === locks.SLICE
  && contract.outcome_id === locks.OUTCOME_ID
  && contract.master_basis === locks.MASTER_BASIS
  && contract.branch === locks.BRANCH
  && contract.progress_class === locks.PROGRESS_CLASS
  && contract.live_mutation === false
  && contract.this_slice_executes_live === false
  && contract.confirm_token === locks.CONFIRM_TOKEN
  && contract.image_sha_short === locks.IMAGE_SHA_SHORT
  && contract.database_env === locks.DATABASE_ENV_NAME);

green('branch_pin',
  headBranch === locks.BRANCH
  && contract.branch === locks.BRANCH,
  `head=${headBranch}`);

green('tenants_pinned',
  locks.TENANTS.wolfhouse.resourceGroup === 'wh-staging-rg'
  && locks.TENANTS.wolfhouse.containerApp === 'wh-staging-staff-api'
  && locks.TENANTS.wolfhouse.publicBaseUrl === 'https://staff-staging.lunafrontdesk.com'
  && locks.TENANTS.wolfhouse.expectedSecretRef === 'wolfhouse-database-url'
  && locks.TENANTS.sunset.resourceGroup === 'luna-sunset-staging-rg'
  && locks.TENANTS.sunset.containerApp === 'luna-sunset-staging-staff-api'
  && locks.TENANTS.sunset.publicBaseUrl === 'https://sunset-staging.lunafrontdesk.com'
  && locks.TENANTS.sunset.expectedSecretRef === 'sunset-database-url');

green('unreachable_dsn_non_secret',
  /^postgresql:\/\/radar16q_drill:unreachable@127\.0\.0\.1:1\//.test(locks.UNREACHABLE_DSN)
  && !/sk_|whsec_|BEGIN PRIVATE/i.test(locks.UNREACHABLE_DSN));

// ── CLI refuse points ─────────────────────────────────────────────────────
red('missing_tenant_rejected', (() => {
  try {
    locks.assertCliFailClosed(locks.parseCliArgs([]));
    return false;
  } catch (e) {
    return e.code === 'tenant_required';
  }
})());

red('unknown_tenant_rejected', (() => {
  try {
    locks.assertCliFailClosed(locks.parseCliArgs(['--tenant', 'prod']));
    return false;
  } catch (e) {
    return e.code === 'tenant_required';
  }
})());

red('unknown_flag_rejected', (() => {
  try {
    locks.assertCliFailClosed(locks.parseCliArgs(['--tenant', 'wolfhouse', '--live']));
    return false;
  } catch (e) {
    return e.code === 'unknown_flag';
  }
})());

red('positional_rejected', (() => {
  try {
    locks.assertCliFailClosed(locks.parseCliArgs(['--tenant', 'wolfhouse', 'extra']));
    return false;
  } catch (e) {
    return e.code === 'unexpected_positional';
  }
})());

red('apply_without_confirm_rejected', (() => {
  try {
    locks.assertCliFailClosed(locks.parseCliArgs(['--tenant', 'wolfhouse', '--apply']));
    return false;
  } catch (e) {
    return e.code === 'confirm_token_mismatch';
  }
})());

red('apply_wrong_confirm_rejected', (() => {
  try {
    locks.assertCliFailClosed(locks.parseCliArgs([
      '--tenant', 'wolfhouse', '--apply', '--confirm', 'WRONG',
    ]));
    return false;
  } catch (e) {
    return e.code === 'confirm_token_mismatch';
  }
})());

green('default_dry_run', (() => {
  const p = locks.assertCliFailClosed(locks.parseCliArgs(['--tenant', 'sunset']));
  return p.mode === 'dry-run' && p.tenant.id === 'sunset';
})());

green('apply_with_exact_token', (() => {
  const p = locks.assertCliFailClosed(locks.parseCliArgs([
    '--tenant', 'wolfhouse',
    '--apply',
    '--confirm', locks.CONFIRM_TOKEN,
  ]));
  return p.mode === 'apply' && p.tenant.id === 'wolfhouse';
})());

// ── Production / pin refuses ──────────────────────────────────────────────
red('production_rg_refused', (() => {
  try {
    locks.assertTenantPins({
      id: 'wolfhouse',
      resourceGroup: 'wh-prod-rg',
      publicBaseUrl: 'https://staff-staging.lunafrontdesk.com',
    });
    return false;
  } catch (e) {
    return e.code === 'production_rg_refused' || e.code === 'non_staging_rg_refused';
  }
})());

red('production_host_refused', (() => {
  try {
    locks.assertTenantPins({
      ...locks.TENANTS.wolfhouse,
      publicBaseUrl: 'https://staff.lunafrontdesk.com',
    });
    return false;
  } catch (e) {
    return e.code === 'production_host_refused';
  }
})());

red('wrong_image_sha_rejected', (() => {
  try {
    locks.assertImagePinned(
      `${locks.TENANTS.wolfhouse.imageRepository}:deadbeef`,
      locks.TENANTS.wolfhouse,
    );
    return false;
  } catch (e) {
    return e.code === 'wrong_image_sha';
  }
})());

red('mutable_latest_image_rejected', (() => {
  try {
    locks.assertImagePinned(
      `${locks.TENANTS.wolfhouse.imageRepository}:latest`,
      locks.TENANTS.wolfhouse,
    );
    return false;
  } catch (e) {
    return e.code === 'mutable_image_refused';
  }
})());

red('missing_probes_rejected', (() => {
  try {
    locks.assertBaselineState({
      tenant: locks.TENANTS.wolfhouse,
      appShow: makeAppShow(locks.TENANTS.wolfhouse, { probes: [] }),
    });
    return false;
  } catch (e) {
    return e.code === 'probes_missing' || e.code === 'probes_incomplete';
  }
})());

red('missing_readiness_probe_rejected', (() => {
  try {
    locks.assertBaselineState({
      tenant: locks.TENANTS.wolfhouse,
      appShow: makeAppShow(locks.TENANTS.wolfhouse, {
        probes: [
          { type: 'Startup', httpGet: { path: '/healthz', port: 3036 } },
          { type: 'Liveness', httpGet: { path: '/healthz', port: 3036 } },
        ],
      }),
    });
    return false;
  } catch (e) {
    return e.code === 'probes_incomplete';
  }
})());

red('missing_secret_ref_rejected', (() => {
  try {
    locks.assertBaselineState({
      tenant: locks.TENANTS.wolfhouse,
      appShow: makeAppShow(locks.TENANTS.wolfhouse, {
        env: [{ name: locks.DATABASE_ENV_NAME, value: 'not-a-secret-ref' }],
      }),
    });
    return false;
  } catch (e) {
    return e.code === 'database_env_plaintext_refused'
      || e.code === 'database_secret_ref_missing';
  }
})());

red('wrong_secret_ref_rejected', (() => {
  try {
    locks.assertBaselineState({
      tenant: locks.TENANTS.wolfhouse,
      appShow: makeAppShow(locks.TENANTS.wolfhouse, { secretRef: 'other-db-url' }),
    });
    return false;
  } catch (e) {
    return e.code === 'database_secret_ref_mismatch';
  }
})());

red('multi_revision_traffic_rejected', (() => {
  try {
    locks.assertBaselineState({
      tenant: locks.TENANTS.wolfhouse,
      appShow: makeAppShow(locks.TENANTS.wolfhouse, {
        traffic: [
          { revisionName: 'a', weight: 50 },
          { revisionName: 'b', weight: 50 },
        ],
      }),
    });
    return false;
  } catch (e) {
    return e.code === 'multi_revision_traffic';
  }
})());

red('ambiguous_latest_ready_rejected', (() => {
  try {
    locks.assertBaselineState({
      tenant: locks.TENANTS.wolfhouse,
      appShow: makeAppShow(locks.TENANTS.wolfhouse, { latestReadyRevisionName: '' }),
    });
    return false;
  } catch (e) {
    return e.code === 'latest_ready_missing';
  }
})());

red('dirty_repo_rejected', (() => {
  try {
    locks.checkRepoPreflight({
      execGit: (cmd) => (cmd.includes('status') ? ' M file.js\n' : locks.MASTER_BASIS),
    });
    return false;
  } catch (e) {
    return e.code === 'dirty_repo';
  }
})());

red('wrong_master_rejected', (() => {
  try {
    locks.checkRepoPreflight({
      execGit: (cmd) => {
        if (cmd.includes('status')) return '';
        if (cmd.includes('origin/master')) return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        return locks.MASTER_BASIS;
      },
    });
    return false;
  } catch (e) {
    return e.code === 'wrong_master';
  }
})());

// ── GREEN baseline + narrow template ──────────────────────────────────────
const wh = locks.TENANTS.wolfhouse;
const sun = locks.TENANTS.sunset;

green('baseline_wolfhouse', (() => {
  const b = locks.assertBaselineState({
    tenant: wh,
    appShow: makeAppShow(wh),
  });
  return b.dbEnv.secretRef === 'wolfhouse-database-url'
    && b.image.raw.includes(locks.IMAGE_SHA_SHORT);
})());

green('baseline_sunset', (() => {
  const b = locks.assertBaselineState({
    tenant: sun,
    appShow: makeAppShow(sun),
  });
  return b.dbEnv.secretRef === 'sunset-database-url';
})());

green('failure_template_narrow_delta', (() => {
  const original = makeAppShow(wh);
  const { app, delta } = locks.buildFailureTemplate(original, wh);
  const narrow = locks.envDeltaOnlyDatabase(original, app);
  const entry = locks.findEnvEntry(locks.primaryContainer(app), locks.DATABASE_ENV_NAME);
  return narrow.ok
    && delta.env_name === locks.DATABASE_ENV_NAME
    && entry.value === locks.UNREACHABLE_DSN
    && !entry.secretRef
    && locks.findEnvEntry(locks.primaryContainer(original), locks.DATABASE_ENV_NAME).secretRef
      === 'wolfhouse-database-url';
})());

green('redaction_strips_secret_values', (() => {
  const original = makeAppShow(wh);
  const redacted = locks.redactSecretsDeep(original);
  const blob = JSON.stringify(redacted);
  return !blob.includes('SUPER_SECRET_SHOULD_NEVER_LEAK')
    && blob.includes('[REDACTED]')
    && blob.includes('wolfhouse-database-url'); // secretRef name retained
})());

green('failed_revision_classification', (() => {
  const latest = `${wh.containerApp}--0000516`;
  const failed = makeFailedRevision(`${wh.containerApp}--0000517`);
  const obs = locks.assertFailedRevisionObservation(failed, {
    latestReadyRevisionName: latest,
  });
  return obs.started === true
    && obs.ready === false
    && obs.restartCount === 0
    && obs.isLatestReady === false;
})());

red('failed_revision_restart_loop_rejected', (() => {
  try {
    locks.assertFailedRevisionObservation({
      name: 'x--0000517',
      started: true,
      ready: false,
      restartCount: 3,
      properties: { runningState: 'Running', ready: false, restartCount: 3 },
    }, { latestReadyRevisionName: 'x--0000516' });
    return false;
  } catch (e) {
    return e.code === 'failed_revision_not_observed';
  }
})());

red('failed_revision_is_latest_ready_rejected', (() => {
  try {
    locks.assertFailedRevisionObservation(
      makeFailedRevision('x--0000516'),
      { latestReadyRevisionName: 'x--0000516' },
    );
    return false;
  } catch (e) {
    return e.code === 'failed_revision_not_observed';
  }
})());

green('restore_state_verifies_secret_ref', (() => {
  const original = makeAppShow(wh);
  const baseline = locks.assertBaselineState({ appShow: original, tenant: wh });
  const restored = locks.assertRestoredState({
    appShow: original,
    tenant: wh,
    expectedImage: baseline.image.raw,
    expectedSecretRef: baseline.dbEnv.secretRef,
    expectedProbes: baseline.probes,
  });
  return restored.dbEnv.secretRef === 'wolfhouse-database-url';
})());

red('restore_plaintext_rejected', (() => {
  try {
    const bad = makeAppShow(wh, {
      env: [
        { name: 'NODE_ENV', value: 'staging' },
        { name: locks.DATABASE_ENV_NAME, value: locks.UNREACHABLE_DSN },
      ],
    });
    locks.assertRestoredState({
      appShow: bad,
      tenant: wh,
      expectedImage: locks.primaryContainer(bad).image,
      expectedSecretRef: 'wolfhouse-database-url',
    });
    return false;
  } catch (e) {
    return e.code === 'database_env_plaintext_refused'
      || e.code === 'database_secret_ref_missing'
      || e.code === 'restore_still_plaintext';
  }
})());

green('workdir_outside_repo', (() => {
  const dir = locks.createWorkDir({
    tmpRoot: os.tmpdir(),
    mkdtemp: (prefix) => fs.mkdtempSync(prefix),
  });
  const outside = !dir.startsWith(ROOT);
  fs.rmSync(dir, { recursive: true, force: true });
  return outside;
})());

async function runAsyncBattery() {
  const asyncChecks = [];

  asyncChecks.push(['GREEN cleanup_trap_restores', async () => {
    let restored = 0;
    const trap = locks.installCleanupTrap({
      restore: async () => { restored += 1; },
      processRef: { on() {}, removeListener() {}, exitCode: 0 },
      signals: ['SIGINT'],
    });
    await trap.restoreNow('test');
    trap.disarm();
    return restored === 1;
  }]);

  asyncChecks.push(['GREEN poll_until_success', async () => {
    let n = 0;
    const result = await locks.pollUntil(async () => {
      n += 1;
      return { ok: n >= 2, n };
    }, {
      timeoutMs: 1000,
      intervalMs: 1,
      sleep: async () => {},
      now: (() => { let t = 0; return () => { t += 10; return t; }; })(),
      label: 'test',
    });
    return result.ok && result.n === 2;
  }]);

  asyncChecks.push(['GREEN dry_run_orchestration', async () => {
    const app = makeAppShow(wh);
    const result = await locks.runHarness({
      parsed: { help: false, tenant: wh, mode: 'dry-run' },
      deps: {
        execGit: (cmd) => (cmd.includes('status') ? '' : locks.MASTER_BASIS),
        execAssertRepoSync: () => {},
        showApp: async () => app,
        mkdtemp: (prefix) => fs.mkdtempSync(prefix),
        tmpRoot: os.tmpdir(),
      },
    });
    const planOk = result.ok
      && result.mode === 'dry-run'
      && result.live_mutation === false
      && Array.isArray(result.plan.would)
      && result.plan.would.length >= 5
      && fs.existsSync(result.evidencePath);
    const ev = JSON.parse(fs.readFileSync(result.evidencePath, 'utf8'));
    const sec = secretFree(JSON.stringify(ev), 'dry_run_evidence');
    fs.rmSync(result.workDir, { recursive: true, force: true });
    return planOk && sec.ok && ev.explicitly_not_claimed.includes('dependency_failure_proven');
  }]);

  asyncChecks.push(['GREEN apply_success_and_restore', async () => {
    const original = makeAppShow(wh);
    let current = locks.deepClone(original);
    const applied = [];
    const httpLog = [];
    let revPhase = 0;
    const result = await locks.runHarness({
      parsed: { help: false, tenant: wh, mode: 'apply' },
      poll: { failureTimeoutMs: 500, restoreTimeoutMs: 500, intervalMs: 1 },
      deps: {
        execGit: (cmd) => (cmd.includes('status') ? '' : locks.MASTER_BASIS),
        execAssertRepoSync: () => {},
        showApp: async () => current,
        showAppAfter: async () => current,
        listRevisions: async () => {
          revPhase += 1;
          const latest = original.properties.latestReadyRevisionName;
          if (revPhase < 2) {
            return [{ name: latest, ready: true, started: true, restartCount: 0 }];
          }
          return [
            { name: latest, ready: true, started: true, restartCount: 0, trafficWeight: 100 },
            makeFailedRevision(`${wh.containerApp}--0000517`),
          ];
        },
        applyTemplate: async (_t, appResource, meta) => {
          applied.push(meta.purpose);
          current = meta.purpose === 'restore'
            ? locks.deepClone(original)
            : locks.deepClone(appResource);
        },
        httpGet: async (url) => {
          httpLog.push(url);
          return { status: 200, body: '{}' };
        },
        sleep: async () => {},
        now: (() => { let t = 0; return () => { t += 20; return t; }; })(),
        mkdtemp: (prefix) => fs.mkdtempSync(prefix),
        tmpRoot: os.tmpdir(),
        processRef: { on() {}, removeListener() {}, exitCode: 0 },
      },
    });
    fs.rmSync(result.workDir, { recursive: true, force: true });
    return result.ok
      && result.restored
      && applied.includes('failure_inject')
      && applied.includes('restore')
      && httpLog.some((u) => u.endsWith('/healthz'))
      && httpLog.some((u) => u.endsWith('/readyz'));
  }]);

  asyncChecks.push(['GREEN apply_error_triggers_restore', async () => {
    const original = makeAppShow(wh);
    let current = locks.deepClone(original);
    const applied = [];
    let blew = false;
    try {
      await locks.runHarness({
        parsed: { help: false, tenant: wh, mode: 'apply' },
        poll: { failureTimeoutMs: 200, restoreTimeoutMs: 200, intervalMs: 1 },
        deps: {
          execGit: (cmd) => (cmd.includes('status') ? '' : locks.MASTER_BASIS),
          execAssertRepoSync: () => {},
          showApp: async () => current,
          showAppAfter: async () => current,
          listRevisions: async () => {
            throw Object.assign(new Error('boom'), { code: 'list_boom' });
          },
          applyTemplate: async (_t, appResource, meta) => {
            applied.push(meta.purpose);
            current = meta.purpose === 'restore'
              ? locks.deepClone(original)
              : locks.deepClone(appResource);
          },
          httpGet: async () => ({ status: 200, body: '{}' }),
          sleep: async () => {},
          now: (() => { let t = 0; return () => { t += 50; return t; }; })(),
          mkdtemp: (prefix) => fs.mkdtempSync(prefix),
          tmpRoot: os.tmpdir(),
          processRef: { on() {}, removeListener() {}, exitCode: 0 },
        },
      });
    } catch (e) {
      blew = e.code === 'list_boom' || e.message === 'boom';
    }
    return blew && applied.includes('failure_inject') && applied.includes('restore');
  }]);

  asyncChecks.push(['RED apply_refuses_unhealthy_baseline_endpoints', async () => {
    try {
      await locks.runHarness({
        parsed: { help: false, tenant: wh, mode: 'apply' },
        deps: {
          execGit: (cmd) => (cmd.includes('status') ? '' : locks.MASTER_BASIS),
          execAssertRepoSync: () => {},
          showApp: async () => makeAppShow(wh),
          listRevisions: async () => [],
          applyTemplate: async () => { throw new Error('should_not_apply'); },
          httpGet: async () => ({ status: 503, body: '{}' }),
          mkdtemp: (prefix) => fs.mkdtempSync(prefix),
          tmpRoot: os.tmpdir(),
          processRef: { on() {}, removeListener() {}, exitCode: 0 },
        },
      });
      return false;
    } catch (e) {
      return e.code === 'baseline_endpoints_unhealthy';
    }
  }]);

  asyncChecks.push(['RED poll_timeout_restores', async () => {
    const original = makeAppShow(wh);
    let restored = false;
    try {
      await locks.runHarness({
        parsed: { help: false, tenant: wh, mode: 'apply' },
        poll: { failureTimeoutMs: 30, restoreTimeoutMs: 30, intervalMs: 1 },
        deps: {
          execGit: (cmd) => (cmd.includes('status') ? '' : locks.MASTER_BASIS),
          execAssertRepoSync: () => {},
          showApp: async () => original,
          showAppAfter: async () => original,
          listRevisions: async () => [
            { name: original.properties.latestReadyRevisionName, ready: true, started: true, restartCount: 0 },
          ],
          applyTemplate: async (_t, _a, meta) => {
            if (meta.purpose === 'restore') restored = true;
          },
          httpGet: async () => ({ status: 200, body: '{}' }),
          sleep: async () => {},
          now: (() => { let t = 0; return () => { t += 20; return t; }; })(),
          mkdtemp: (prefix) => fs.mkdtempSync(prefix),
          tmpRoot: os.tmpdir(),
          processRef: { on() {}, removeListener() {}, exitCode: 0 },
        },
      });
      return false;
    } catch (e) {
      return e.code === 'poll_timeout' && restored === true;
    }
  }]);

  for (const [name, fn] of asyncChecks) {
    let cond = false;
    let detail;
    try {
      cond = await fn();
    } catch (err) {
      cond = false;
      detail = String(err && err.message);
    }
    if (name.startsWith('RED ')) {
      red(name.slice(4), cond, detail);
    } else if (name.startsWith('GREEN ')) {
      green(name.slice(6), cond, detail);
    } else {
      ok(name, cond, detail);
    }
  }
}

// ── Source / ledger artifacts ─────────────────────────────────────────────
green('cli_script_exists',
  fs.existsSync(path.join(ROOT, 'scripts/radar-slice16q-readiness-failure-drill.js')));

green('package_script_wired',
  /verify:radar-slice16q-readiness-failure-drill-harness/.test(
    readText('package.json'),
  ));

green('no_secret_read_in_sources', (() => {
  const lib = readText('scripts/lib/radar-slice16q-readiness-failure-drill-harness.js');
  const cli = readText('scripts/radar-slice16q-readiness-failure-drill.js');
  const blob = `${lib}\n${cli}`;
  return !/secret show/i.test(blob)
    && !/az keyvault secret/i.test(blob)
    && !/query value -o tsv/.test(blob)
    && /redactSecretsDeep/.test(lib)
    && /installCleanupTrap/.test(lib)
    && /UNREACHABLE_DSN/.test(lib);
})());

const rt = runtimePathsUnchanged();
green('runtime_paths_unchanged', rt.ok, rt.detail);

green('ledger_source_partial_only', (() => {
  const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
  const findings = readText('fixtures/radar-operations/findings.md');
  const doc = readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md');
  const g02 = matrix.gates.find((g) => g.id === 'G02_readiness_dependencies');
  const sel = matrix.slice_16q_selection;
  return matrix.slice === 'RADAR-16Q'
    && matrix.master_basis === locks.MASTER_BASIS
    && matrix.branch === locks.BRANCH
    && matrix.live_mutation === false
    && sel
    && sel.outcome_id === locks.OUTCOME_ID
    && sel.progress_class === 'source_partial_progress_only'
    && /16Q/.test(doc)
    && /source.partial|source_partial/i.test(doc)
    && !/dependency failure is proven|dependency-failure is proven|live drill completed/i.test(doc)
    && g02
    && g02.gaps.some((g) => /failure drill|dependency-failure|not executed/i.test(g))
    && /16Q/.test(findings)
    && contract.this_slice_executes_live === false;
})());

const ownedSec = secretFree(
  locks.OWNED_RELS.map((rel) => {
    try { return readText(rel); } catch (_) { return ''; }
  }).join('\n'),
  'owned_rels',
);
green('owned_artifacts_secret_free', ownedSec.ok, ownedSec.detail);

green('required_red_ids_present', (() => {
  const required = [
    'missing_tenant_rejected',
    'unknown_tenant_rejected',
    'unknown_flag_rejected',
    'positional_rejected',
    'apply_without_confirm_rejected',
    'apply_wrong_confirm_rejected',
    'production_rg_refused',
    'production_host_refused',
    'wrong_image_sha_rejected',
    'mutable_latest_image_rejected',
    'missing_probes_rejected',
    'missing_readiness_probe_rejected',
    'missing_secret_ref_rejected',
    'wrong_secret_ref_rejected',
    'multi_revision_traffic_rejected',
    'ambiguous_latest_ready_rejected',
    'dirty_repo_rejected',
    'wrong_master_rejected',
    'failed_revision_restart_loop_rejected',
    'failed_revision_is_latest_ready_rejected',
    'restore_plaintext_rejected',
  ];
  const ids = new Set(redResults.map((r) => r.id));
  return required.every((id) => ids.has(id) && redResults.find((r) => r.id === id).ok);
})());

console.log('\nRunning async battery…');
runAsyncBattery().then(() => {
  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  console.log(`RED ${redResults.filter((r) => r.ok).length}/${redResults.length}; GREEN ${greenResults.filter((r) => r.ok).length}/${greenResults.length}`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16Q readiness-failure drill harness (source-partial): PASS');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
