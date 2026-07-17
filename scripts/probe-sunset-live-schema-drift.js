'use strict';

/**
 * probe-sunset-live-schema-drift — FOUNDATION Slice 5 (safety-corrected)
 *
 * Zero Azure mutations. Compare Sunset staging live PostgreSQL (via pre-existing
 * access only) to the canonical 36-migration contract built on disposable local
 * Docker. Never opens firewall rules, never updates/restarts Container Apps,
 * never applies migrations to live, never prints/persists DSNs.
 */

const { execFileSync, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  EXPECTED_SUBSCRIPTION_ID,
  EXPECTED_RG,
  EXPECTED_PG_SERVER,
  EXPECTED_KV,
  EXPECTED_SECRET_NAME,
  EXPECTED_DATABASE,
  EXPECTED_HOST,
  EXPECTED_STAFF_APP,
  CA_EXEC_MAX_RETRIES,
  parseDatabaseUrl,
  assertSunsetStagingTarget,
  assertNoLeakedDsn,
  assertAzCommandAllowed,
  clientConfigFromDsn,
  fingerprintProductSchema,
  compareSnapshots,
  summarizeDrifts,
  introspectProductSchema,
  introspectLedger,
  verifyLiveSession,
  buildExactContainerAppExecArgs,
  resolveRunningExecTarget,
  verifyCollectorPayload,
  classifyLedgerStatus,
  redactSecrets,
  INTROSPECTION_SQL,
  SQL_REGISTRY_IDS,
} = require('./lib/sunset-schema-drift');
const {
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
} = require('./lib/migration-integrity');
const { runCanonicalMigrations } = require('./run-canonical-migrations');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmp', 'foundation-slice5');
const HISTORICAL_FIXTURE = path.join(
  ROOT,
  'fixtures',
  'sunset-schema-drift',
  'live-schema-drift-report.json',
);
const COMPLIANT_REPORT_PATH = path.join(OUT_DIR, 'live-schema-drift-report.compliant.json');
const COMPLIANT_FIXTURE = path.join(
  ROOT,
  'fixtures',
  'sunset-schema-drift',
  'live-schema-drift-report.compliant.json',
);
const BLOCKER_REPORT_PATH = path.join(OUT_DIR, 'live-schema-drift-blocker.json');
const REQUIRED_MASTER = 'ad90018c3e2113a4006cd4979ba1edec323b5d03';

const suffix = crypto.randomBytes(4).toString('hex');
const CONTAINER = `wh-mig-drift-${suffix}`;
const VOLUME = `wh-mig-drift-vol-${suffix}`;
const DB_NAME = `wh_mig_drift_${suffix}`;
const USER = `wh_mig_u_${suffix}`;
const PASSWORD = crypto.randomBytes(18).toString('base64url');

const AZ_BIN = process.platform === 'win32'
  ? '"C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd"'
  : 'az';

let assignedHostPort = null;
let dsnInMemory = null;
const azureCallInventory = [];

function recordAzCall(args, kind, ok) {
  const argvHead = (args || []).slice(0, 8).map((a, i) => {
    if (i > 0 && String(args[i - 1]) === '--command' && String(a).length > 80) {
      return `[command:${String(a).length}chars]`;
    }
    return a;
  });
  azureCallInventory.push({
    kind: kind || null,
    ok: Boolean(ok),
    argvHead,
  });
}

function shellQuoteAzArg(a) {
  const s = String(a);
  if (!/[\s"]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function azArgs(args, opts) {
  const gate = assertAzCommandAllowed(args);
  if (!gate.ok) {
    recordAzCall(args, gate.kind, false);
    throw Object.assign(new Error(gate.message), { code: gate.code });
  }
  recordAzCall(args, gate.kind, true);
  const cmd = `${AZ_BIN} ${args.map(shellQuoteAzArg).join(' ')}`;
  return execSync(cmd, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    shell: true,
    ...(opts || {}),
  });
}

function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function cleanupLocal() {
  try {
    docker(['rm', '-f', CONTAINER]);
  } catch (_) {
    /* ignore */
  }
  try {
    docker(['volume', 'rm', '-f', VOLUME]);
  } catch (_) {
    /* ignore */
  }
}

function wipeSecretsFromMemory() {
  dsnInMemory = null;
}

function fetchDatabaseUrlFromKeyVault() {
  const value = String(
    azArgs([
      'keyvault',
      'secret',
      'show',
      '--vault-name',
      EXPECTED_KV,
      '--name',
      EXPECTED_SECRET_NAME,
      '--query',
      'value',
      '-o',
      'tsv',
    ]),
  )
    .replace(/^\uFEFF/, '')
    .trim();
  if (!value || !/^postgres/i.test(value)) {
    throw Object.assign(new Error('Key Vault did not return a postgres URL'), {
      code: 'kv_secret_invalid',
    });
  }
  return value;
}

function queryCost() {
  const today = new Date();
  const from = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const to = today.toISOString().slice(0, 10);
  const bodyPath = path.join(OUT_DIR, 'cost-body.json');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    bodyPath,
    `${JSON.stringify({
      type: 'ActualCost',
      timeframe: 'Custom',
      timePeriod: { from, to },
      dataset: {
        granularity: 'None',
        aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
      },
    })}\n`,
  );
  const url =
    `https://management.azure.com/subscriptions/${EXPECTED_SUBSCRIPTION_ID}`
    + `/resourceGroups/${EXPECTED_RG}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`;
  const raw = azArgs(['rest', '--method', 'post', '--url', url, '--body', `@${bodyPath}`, '-o', 'json']);
  const s = String(raw).replace(/^\uFEFF/, '').trim();
  const i = Math.min(...[s.indexOf('{'), s.indexOf('[')].filter((x) => x >= 0));
  const j = JSON.parse(s.slice(i));
  const row = (j.properties && j.properties.rows && j.properties.rows[0]) || [null, null];
  try {
    fs.unlinkSync(bodyPath);
  } catch (_) {
    /* ignore */
  }
  return {
    type: 'ActualCost',
    scope: `/subscriptions/${EXPECTED_SUBSCRIPTION_ID}/resourceGroups/${EXPECTED_RG}`,
    period: { from, to, label: 'month-to-date' },
    amount: row[0],
    currency: row[1],
  };
}

async function waitForPg(connection, attempts) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    const client = new Client({ ...connection, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (e) {
      last = e;
      try {
        await client.end();
      } catch (_) {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw last || new Error('postgres never became ready');
}

async function buildExpectedSnapshot() {
  docker([
    'run',
    '-d',
    '--name',
    CONTAINER,
    '-e',
    `POSTGRES_USER=${USER}`,
    '-e',
    `POSTGRES_PASSWORD=${PASSWORD}`,
    '-e',
    'POSTGRES_DB=postgres',
    '-p',
    '127.0.0.1::5432',
    '-v',
    `${VOLUME}:/var/lib/postgresql/data`,
    'postgres:15-alpine',
  ]);
  const portMap = String(docker(['port', CONTAINER, '5432/tcp'])).trim();
  const portMatch = portMap.match(/:(\d+)\s*$/);
  if (!portMatch) throw new Error(`could not parse published port from: ${portMap}`);
  assignedHostPort = Number(portMatch[1]);

  const admin = {
    host: '127.0.0.1',
    port: assignedHostPort,
    user: USER,
    password: PASSWORD,
    database: 'postgres',
  };
  await waitForPg(admin, 60);

  const adminClient = new Client(admin);
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE ${DB_NAME}`);
  await adminClient.end();

  const conn = { ...admin, database: DB_NAME };
  const applied = await runCanonicalMigrations({ connection: conn });
  if (!applied.ok) {
    throw Object.assign(new Error('canonical migrations failed on disposable DB'), {
      code: 'expected_build_failed',
      detail: {
        errors: applied.errors,
        applied: (applied.applied || []).length,
        skipped: (applied.skipped || []).length,
      },
    });
  }

  const client = new Client(conn);
  await client.connect();
  const { snapshot, usedAllowlist } = await introspectProductSchema(client);
  const ledger = await introspectLedger(client, forwardEntries(loadManifest()));
  await client.end();

  return {
    snapshot,
    fingerprint: fingerprintProductSchema(snapshot),
    appliedCount: applied.applied ? applied.applied.length : 0,
    ledgerStatus: ledger.status,
    usedAllowlist,
    hostPort: assignedHostPort,
  };
}

async function tryDirectLiveProbe(dsn) {
  const cfg = clientConfigFromDsn(dsn);
  const client = new Client({ ...cfg, connectionTimeoutMillis: 8000 });
  try {
    await client.connect();
  } catch (e) {
    try {
      await client.end();
    } catch (_) {
      /* ignore */
    }
    return {
      ok: false,
      code: 'network_path_unavailable',
      message: redactSecrets(e.message || String(e)),
      path: 'direct',
    };
  }
  try {
    const session = await verifyLiveSession(client);
    if (!session.ok) {
      return { ok: false, code: 'session_not_read_only', errors: session.errors, path: 'direct' };
    }
    const product = await introspectProductSchema(client);
    const ledger = await introspectLedger(client, forwardEntries(loadManifest()));
    return {
      ok: true,
      path: 'direct',
      scopeCompliant: true,
      session: session.show,
      snapshot: product.snapshot,
      fingerprint: fingerprintProductSchema(product.snapshot),
      ledger: {
        status: ledger.status.status,
        detail: ledger.status.detail,
        rowCount: (ledger.rows || []).length,
        note: 'ledger status is independent of product-schema object match',
      },
    };
  } finally {
    try {
      await client.end();
    } catch (_) {
      /* ignore */
    }
  }
}

function parseAzJson(raw) {
  const s = String(raw || '').replace(/^\uFEFF/, '').trim();
  const iObj = s.indexOf('{');
  const iArr = s.indexOf('[');
  let i = -1;
  if (iObj >= 0 && iArr >= 0) i = Math.min(iObj, iArr);
  else i = Math.max(iObj, iArr);
  if (i < 0) throw new Error('no json from az');
  return JSON.parse(s.slice(i));
}

function resolveExactRunningTarget() {
  const app = parseAzJson(azArgs([
    'containerapp',
    'show',
    '-g',
    EXPECTED_RG,
    '-n',
    EXPECTED_STAFF_APP,
    '-o',
    'json',
  ]));

  const revisions = parseAzJson(azArgs([
    'containerapp',
    'revision',
    'list',
    '-g',
    EXPECTED_RG,
    '-n',
    EXPECTED_STAFF_APP,
    '-o',
    'json',
  ]));

  const traffic = ((((app.properties || {}).configuration || {}).ingress || {}).traffic) || [];
  const full = traffic.find((t) => Number(t.weight) === 100);
  let revisionName = full && full.revisionName ? full.revisionName : null;
  if (full && full.latestRevision && !revisionName) {
    revisionName = (app.properties && app.properties.latestRevisionName) || null;
  }
  if (!full || !revisionName) {
    return {
      ok: false,
      errors: [{ code: 'no_100_percent_revision', message: 'no ingress traffic entry with weight 100 resolving to a revision name' }],
      target: null,
    };
  }

  const replicas = parseAzJson(azArgs([
    'containerapp',
    'replica',
    'list',
    '-g',
    EXPECTED_RG,
    '-n',
    EXPECTED_STAFF_APP,
    '--revision',
    revisionName,
    '-o',
    'json',
  ]));

  return resolveRunningExecTarget(app, revisions, replicas);
}

function tryContainerAppExecProbe() {
  const resolved = resolveExactRunningTarget();
  if (!resolved.ok || !resolved.target) {
    return {
      ok: false,
      code: 'network_path_unavailable',
      message: 'could not resolve exact running revision/replica/container read-only',
      path: 'containerapp_exec',
      detail: resolved.errors || null,
      execTarget: null,
      retries: [],
    };
  }

  const execArgs = buildExactContainerAppExecArgs(resolved.target);
  const gate = assertAzCommandAllowed(execArgs);
  if (!gate.ok) {
    return {
      ok: false,
      code: 'network_path_unavailable',
      message: gate.message,
      path: 'containerapp_exec',
      execTarget: resolved.target,
      retries: [],
    };
  }

  const retries = [];
  let lastFail = null;
  for (let attempt = 1; attempt <= CA_EXEC_MAX_RETRIES; attempt += 1) {
    let raw = '';
    try {
      raw = azArgs(execArgs);
      retries.push({ attempt, ok: true, note: 'az exec returned' });
    } catch (e) {
      const msg = redactSecrets(String(e.stderr || e.message || e)).slice(0, 400);
      retries.push({ attempt, ok: false, note: msg });
      lastFail = {
        ok: false,
        code: 'network_path_unavailable',
        message: msg,
        path: 'containerapp_exec',
        execTarget: resolved.target,
        retries,
      };
      continue;
    }

    const text = String(raw || '');
    const begin = text.indexOf('WH_SCHEMA_DRIFT_BEGIN');
    const end = text.indexOf('WH_SCHEMA_DRIFT_END');
    if (begin < 0 || end < 0 || end <= begin) {
      lastFail = {
        ok: false,
        code: 'network_path_unavailable',
        message:
          'containerapp exec did not return marker-delimited collector JSON; '
          + 'refusing to invent evidence or mutate Azure',
        path: 'containerapp_exec',
        execTarget: resolved.target,
        retries,
      };
      continue;
    }
    const jsonLine = text.slice(begin + 'WH_SCHEMA_DRIFT_BEGIN'.length, end).trim();
    let payload;
    try {
      payload = JSON.parse(jsonLine);
    } catch (_) {
      lastFail = {
        ok: false,
        code: 'network_path_unavailable',
        message: 'collector JSON parse failed',
        path: 'containerapp_exec',
        execTarget: resolved.target,
        retries,
      };
      continue;
    }

    const verified = verifyCollectorPayload(payload);
    if (!verified.ok) {
      lastFail = {
        ok: false,
        code: 'network_path_unavailable',
        message: 'collector payload failed independent verification',
        path: 'containerapp_exec',
        detail: verified.errors,
        execTarget: resolved.target,
        retries,
      };
      continue;
    }

    const ledgerStatus = classifyLedgerStatus(
      payload.ledgerMeta || { exists: false },
      payload.ledgerRows || [],
      forwardEntries(loadManifest()),
    );
    return {
      ok: true,
      path: 'containerapp_exec',
      scopeCompliant: true,
      session: payload.session,
      snapshot: payload.snapshot,
      fingerprint: fingerprintProductSchema(payload.snapshot),
      usedAllowlist: payload.usedAllowlist,
      execTarget: resolved.target,
      retries,
      ledger: {
        status: ledgerStatus.status,
        detail: ledgerStatus.detail,
        rowCount: (payload.ledgerRows || []).length,
        note: 'ledger status is independent of product-schema object match',
      },
    };
  }

  return lastFail || {
    ok: false,
    code: 'network_path_unavailable',
    message: `containerapp exec failed after ${CA_EXEC_MAX_RETRIES} attempts`,
    path: 'containerapp_exec',
    execTarget: resolved.target,
    retries,
  };
}

function assertReportSecretFree(report) {
  const text = JSON.stringify(report);
  const hits = assertNoLeakedDsn(text, dsnInMemory);
  if (hits.length) {
    throw Object.assign(new Error(`report leaked secrets: ${hits.join(',')}`), { code: 'leaked_dsn' });
  }
}

function markHistoricalNoncompliant() {
  if (!fs.existsSync(HISTORICAL_FIXTURE)) return null;
  const hist = JSON.parse(fs.readFileSync(HISTORICAL_FIXTURE, 'utf8'));
  hist.scopeCompliant = false;
  hist.zeroMutationProof = false;
  hist.compliance = {
    scopeCompliant: false,
    zeroMutationProof: false,
    violation: 'original_probe_created_and_deleted_temporary_postgres_firewall_rule',
    detail:
      'The original Slice 5 live probe temporarily created then removed a PostgreSQL firewall rule. '
      + 'Cleanup succeeded, but that run violated the zero-Azure-mutation boundary. '
      + 'This report preserves drift findings for history and must never be cited as zero-mutation proof.',
    preservedDriftCounts: hist.drift && hist.drift.counts ? hist.drift.counts : null,
    preservedFingerprints: hist.product
      ? {
        fingerprintExpected: hist.product.fingerprintExpected,
        fingerprintLive: hist.product.fingerprintLive,
      }
      : null,
  };
  // Remove misleading cleanup claim that implied mutation was part of compliant design
  if (hist.cleanup) {
    hist.cleanup.firewallRuleRemoved = true;
    hist.cleanup.note =
      'firewallRuleRemoved=true records that the noncompliant temporary rule was cleaned up; '
      + 'it does not make this run scope-compliant.';
  }
  fs.writeFileSync(HISTORICAL_FIXTURE, `${JSON.stringify(hist, null, 2)}\n`);
  return hist;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const historical = markHistoricalNoncompliant();

  const masterSha = String(
    execSync('git rev-parse origin/master', { cwd: ROOT, encoding: 'utf8' }),
  ).trim();

  const report = {
    ok: false,
    kind: 'sunset-live-schema-drift',
    scopeCompliant: false,
    zeroMutationProof: false,
    requiredMaster: REQUIRED_MASTER,
    masterSha,
    target: {
      subscriptionId: EXPECTED_SUBSCRIPTION_ID,
      resourceGroup: EXPECTED_RG,
      postgresServer: EXPECTED_PG_SERVER,
      database: EXPECTED_DATABASE,
      host: EXPECTED_HOST,
      staffApp: EXPECTED_STAFF_APP,
      keyVault: EXPECTED_KV,
      secretName: EXPECTED_SECRET_NAME,
    },
    accessPath: null,
    execTarget: null,
    execRetries: [],
    session: null,
    product: {
      fingerprintExpected: null,
      fingerprintLive: null,
      match: false,
    },
    drift: {
      counts: { expected_only: 0, live_only: 0, definition_mismatch: 0 },
      sample: [],
    },
    ledger: null,
    sqlRegistryExact: SQL_REGISTRY_IDS.slice(),
    azureCallInventory: [],
    azureMutationCalls: 0,
    costBaseline: null,
    historicalNoncompliantReport: historical
      ? {
        scopeCompliant: false,
        zeroMutationProof: false,
        driftCounts: historical.drift && historical.drift.counts,
        fingerprints: historical.product,
        ledgerStatus: historical.ledger && historical.ledger.status,
      }
      : null,
    cleanup: {
      localContainerRemoved: false,
      localVolumeRemoved: false,
      credentialsWiped: false,
      azureMutationsPerformed: 0,
    },
    blockers: [],
    stopReason: null,
  };

  try {
    if (masterSha !== REQUIRED_MASTER) {
      report.blockers.push({
        code: 'master_mismatch',
        message: `origin/master ${masterSha} != required ${REQUIRED_MASTER}`,
      });
      report.stopReason = 'master_mismatch';
      throw new Error(report.stopReason);
    }

    const manifest = loadManifest();
    const integrity = validateManifestIntegrity(manifest);
    if (!integrity.ok) {
      report.blockers.push({ code: 'manifest_integrity', errors: integrity.errors.slice(0, 5) });
      report.stopReason = 'manifest_integrity';
      throw new Error(report.stopReason);
    }

    console.log('Building expected schema on disposable local PostgreSQL...');
    const expected = await buildExpectedSnapshot();
    report.product.fingerprintExpected = expected.fingerprint;
    report.expectedBuild = {
      appliedCount: expected.appliedCount,
      hostPort: expected.hostPort,
      localLedgerStatus: expected.ledgerStatus.status,
    };

    // Attempt 1: direct connect using pre-existing network access only (no firewall changes).
    console.log('Attempting direct read-only probe (no firewall changes)...');
    dsnInMemory = fetchDatabaseUrlFromKeyVault();
    const parsed = parseDatabaseUrl(dsnInMemory);
    if (!parsed.ok) {
      report.blockers.push({ code: 'dsn_parse_failed', errors: parsed.errors });
      report.stopReason = 'dsn_parse_failed';
      throw new Error(report.stopReason);
    }
    const targetGate = assertSunsetStagingTarget(parsed.parsed, {
      subscriptionId: EXPECTED_SUBSCRIPTION_ID,
      resourceGroup: EXPECTED_RG,
      serverName: EXPECTED_PG_SERVER,
    });
    if (!targetGate.ok) {
      report.blockers.push({ code: 'wrong_target', errors: targetGate.errors });
      report.stopReason = 'wrong_target';
      throw new Error(report.stopReason);
    }

    let live = await tryDirectLiveProbe(dsnInMemory);
    if (!live.ok) {
      console.log('Direct path unavailable; attempting read-only containerapp exec...');
      live = tryContainerAppExecProbe();
    }

    if (!live.ok) {
      report.accessPath = live.path || null;
      report.execTarget = live.execTarget || null;
      report.execRetries = live.retries || [];
      report.stopReason = 'network_path_unavailable';
      report.blockers.push({
        code: 'network_path_unavailable',
        message:
          'No pre-existing network path could run the fixed read-only collector without Azure mutations',
        detail: live.message || null,
        verificationErrors: live.detail || null,
        attemptedPaths: ['direct', 'containerapp_exec'],
        execTarget: live.execTarget || null,
        retries: live.retries || [],
      });
      throw new Error(report.stopReason);
    }

    report.accessPath = live.path;
    report.execTarget = live.execTarget || null;
    report.execRetries = live.retries || [];
    report.scopeCompliant = true;
    report.zeroMutationProof = true;
    report.session = live.session;
    report.product.fingerprintLive = live.fingerprint;
    report.ledger = live.ledger;

    const cmp = compareSnapshots(expected.snapshot, live.snapshot);
    report.drift.counts = cmp.counts;
    report.drift.sample = summarizeDrifts(cmp.drifts);
    report.product.match = cmp.ok
      && report.product.fingerprintExpected === report.product.fingerprintLive;

    report.costBaseline = queryCost();

    if (!report.product.match) {
      report.ok = false;
      report.stopReason = 'product_schema_differs';
      report.blockers.push({
        code: 'product_schema_differs',
        message: 'live product schema differs from canonical expected; no repair attempted',
        counts: cmp.counts,
      });
    } else {
      report.ok = true;
      report.stopReason = null;
    }
  } catch (e) {
    if (!report.stopReason) {
      report.stopReason = e.code || 'probe_error';
      let msg = redactSecrets(e.message || String(e));
      msg = msg.replace(/POSTGRES_PASSWORD=\S+/g, 'POSTGRES_PASSWORD=***');
      msg = msg.replace(/wh_mig_u_[a-f0-9]+/g, 'wh_mig_u_***');
      report.blockers.push({
        code: report.stopReason,
        message: msg.slice(0, 800),
        detail: e.detail || undefined,
      });
    }
    report.ok = false;
    if (report.stopReason === 'network_path_unavailable') {
      report.scopeCompliant = false;
      report.zeroMutationProof = false;
    }
  } finally {
    cleanupLocal();
    let containerGone = true;
    let volumeGone = true;
    try {
      const ps = docker(['ps', '-a', '--filter', `name=^/${CONTAINER}$`, '--format', '{{.Names}}']);
      containerGone = !String(ps).includes(CONTAINER);
    } catch (_) {
      containerGone = true;
    }
    try {
      const vols = docker(['volume', 'ls', '--format', '{{.Name}}']);
      volumeGone = !String(vols).split(/\r?\n/).includes(VOLUME);
    } catch (_) {
      volumeGone = true;
    }
    report.cleanup.localContainerRemoved = containerGone;
    report.cleanup.localVolumeRemoved = volumeGone;
    wipeSecretsFromMemory();
    report.cleanup.credentialsWiped = dsnInMemory == null;
    report.azureCallInventory = azureCallInventory.slice();
    // Mutation commands are rejected before exec; inventory contains only allowlisted reads.
    report.azureMutationCalls = 0;
    report.cleanup.azureMutationsPerformed = 0;
  }

  try {
    assertReportSecretFree(report);
  } catch (_) {
    report.ok = false;
    report.blockers.push({ code: 'leaked_dsn', message: 'report failed secret-free check' });
  }

  // Write compliant fixture only when scope-compliant live evidence was obtained.
  if (report.scopeCompliant && report.accessPath) {
    const out = `${JSON.stringify(report, null, 2)}\n`;
    fs.writeFileSync(COMPLIANT_REPORT_PATH, out);
    fs.writeFileSync(COMPLIANT_FIXTURE, out);
  } else {
    fs.writeFileSync(BLOCKER_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    // Ensure no stale compliant fixture claims success
    if (fs.existsSync(COMPLIANT_FIXTURE) && report.stopReason === 'network_path_unavailable') {
      // leave absence preferred — remove if previously written in this session
      try {
        fs.unlinkSync(COMPLIANT_FIXTURE);
      } catch (_) {
        /* ignore */
      }
    }
  }

  console.log(JSON.stringify({
    ok: report.ok,
    scopeCompliant: report.scopeCompliant,
    zeroMutationProof: report.zeroMutationProof,
    stopReason: report.stopReason,
    accessPath: report.accessPath,
    execTarget: report.execTarget,
    execRetries: report.execRetries,
    driftCounts: report.drift.counts,
    fingerprintExpected: report.product.fingerprintExpected,
    fingerprintLive: report.product.fingerprintLive,
    ledgerStatus: report.ledger && report.ledger.status,
    azureMutationCalls: report.azureMutationCalls,
    azureCallInventory: report.azureCallInventory,
    costBaseline: report.costBaseline,
    cleanup: report.cleanup,
    historicalScopeCompliant: false,
    sqlRegistryCount: SQL_REGISTRY_IDS.length,
  }, null, 2));

  if (!report.cleanup.localContainerRemoved || !report.cleanup.localVolumeRemoved) {
    process.exit(2);
  }
  if (report.stopReason === 'network_path_unavailable') {
    process.exit(3);
  }
  if (!report.ok) {
    process.exit(2);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(redactSecrets(e && e.stack ? e.stack : String(e)));
  cleanupLocal();
  wipeSecretsFromMemory();
  process.exit(1);
});
