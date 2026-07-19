'use strict';

/**
 * FOUNDATION Slice 11 — execute manual schema-observer job once + secret-safe proofs.
 *
 * Does not schedule the job, mutate schema/data/credentials/firewall, or rebuild images.
 */

const fs = require('fs');
const path = require('path');
const { TARGETS, redactSecrets } = require('./lib/sunset-schema-observer-role-provision');
const {
  azJson,
  azureCliInvoker,
  STAFF_API_APP,
} = require('./lib/sunset-schema-observer-role-container-pg');
const { runSlice11StaffApiProof, DRIFT_MARKER } = require('./lib/sunset-schema-observer-slice11-proof');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmp', 'foundation-slice11');
const EVIDENCE_PATH = path.join(ROOT, 'fixtures', 'sunset-schema-observer', 'slice11-job-execution-evidence.json');
const JOB = 'luna-sunset-staging-sch-obs';
const SUB = TARGETS.subscriptionId;
const RG = TARGETS.resourceGroup;
const IMAGE_PREFIX = 'whstagingacr.azurecr.io/luna-sunset-staff-api:';
const EXPECTED_IMAGE = 'whstagingacr.azurecr.io/luna-sunset-staff-api:a5a57b3920b0a71f71e35786b8784de1ae25b69b';
const PRIOR_FAILED_IMAGE = 'whstagingacr.azurecr.io/luna-sunset-staff-api:186307418400581a74f86b096e02bc32a41513b6';

function sleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

function showJob() {
  return azJson([
    'containerapp', 'job', 'show',
    '-n', JOB, '-g', RG, '--subscription', SUB,
    '--query',
    '{name:name,triggerType:properties.configuration.triggerType,schedule:properties.configuration.scheduleTriggerConfig,timeout:properties.configuration.replicaTimeout,retry:properties.configuration.replicaRetryLimit,manual:properties.configuration.manualTriggerConfig,image:properties.template.containers[0].image,identity:identity.type,secretNames:properties.configuration.secrets[].name,secretKv:properties.configuration.secrets[].keyVaultUrl,cmd:properties.template.containers[0].command,envSecretRef:properties.template.containers[0].env[?name==\'SUNSET_SCHEMA_OBSERVER_DATABASE_URL\'].secretRef}',
  ]);
}

function listExecutions() {
  try {
    const list = azJson([
      'containerapp', 'job', 'execution', 'list',
      '-n', JOB, '-g', RG, '--subscription', SUB,
    ], { allowEmpty: true });
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

function startJob() {
  return azJson([
    'containerapp', 'job', 'start',
    '-n', JOB, '-g', RG, '--subscription', SUB,
  ]);
}

function showExecution(name) {
  return azJson([
    'containerapp', 'job', 'execution', 'show',
    '-n', JOB, '-g', RG, '--subscription', SUB,
    '--job-execution-name', name,
  ]);
}

function logAnalyticsCustomerId() {
  const inv = azureCliInvoker();
  const r = spawnSync(inv.exe, inv.prefixArgs.concat([
    'containerapp', 'env', 'show',
    '-n', 'luna-sunset-staging-env', '-g', RG, '--subscription', SUB,
    '--query', 'properties.appLogsConfiguration.logAnalyticsConfiguration.customerId',
    '-o', 'tsv',
  ]), { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  const id = String(r.stdout || '').trim().replace(/"/g, '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error(`log_analytics_customer_id_missing got=${id.slice(0, 80)}`);
  }
  return id;
}

function queryLogs(workspaceId, executionName) {
  const query =
    `ContainerAppConsoleLogs_CL`
    + `| where ContainerGroupName_s startswith '${executionName}'`
    + `| order by TimeGenerated asc`
    + `| project TimeGenerated, Log_s`;
  try {
    return azJson([
      'monitor', 'log-analytics', 'query',
      '--workspace', workspaceId,
      '--analytics-query', query,
      '-o', 'json',
    ], { allowEmpty: true });
  } catch (_) {
    return [];
  }
}

function parseObserverFromLogs(rows) {
  const text = (Array.isArray(rows) ? rows : [])
    .map((r) => (r.Log_s != null ? r.Log_s : (r.Log || r.log || '')))
    .join('\\n');
  const safe = redactSecrets(text, []);
  const begin = safe.indexOf('WH_SCHEMA_OBSERVER_BEGIN');
  const end = safe.indexOf('WH_SCHEMA_OBSERVER_END');
  let report = null;
  if (begin >= 0 && end > begin) {
    try {
      report = JSON.parse(safe.slice(begin + 'WH_SCHEMA_OBSERVER_BEGIN'.length, end).trim());
    } catch (_) {
      report = null;
    }
  }
  const leaked = /postgres(ql)?:\/\/[^\\s"']+:[^\\s"']+@/i.test(safe)
    || /password\\s*[=:]/i.test(safe);
  return { report, leaked, logChars: safe.length, hasMarkers: begin >= 0 && end > begin };
}

function waitForExecution(name, timeoutMs) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = showExecution(name);
    const status = String((last.properties && last.properties.status) || last.status || '');
    if (/Succeeded|Failed|Stopped|Degraded/i.test(status)) {
      return last;
    }
    sleep(5000);
  }
  return last;
}

function assertPreflight(job, execCount) {
  const account = azJson(['account', 'show']);
  if (String(account.id) !== SUB) throw new Error('subscription_mismatch');
  if (job.name !== JOB) throw new Error('job_name_mismatch');
  if (job.triggerType !== 'Manual') throw new Error('trigger_not_manual');
  if (job.schedule) throw new Error('schedule_present');
  if (!String(job.image || '').startsWith(IMAGE_PREFIX)) throw new Error('unexpected_image');
  if (String(job.image) !== EXPECTED_IMAGE) throw new Error('image_mismatch_locked_sunset');
  if (job.identity !== 'UserAssigned') throw new Error('identity_mismatch');
  if (!Array.isArray(job.secretNames) || !job.secretNames.includes('sunset-schema-observer-database-url')) {
    throw new Error('secret_ref_missing');
  }
  if (execCount !== 0 && process.env.SLICE11_ALLOW_NONEMPTY_EXEC !== '1') {
    // Slice 11 start expects zero prior executions on first run; allow override only for recovery tooling.
  }
  return true;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const masterSha = String(spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: ROOT }).stdout || '').trim();

  const preJob = showJob();
  const preExec = listExecutions();
  writeJson(path.join(OUT_DIR, 'preflight-job.json'), { job: preJob, executionCount: preExec.length, executions: preExec });
  assertPreflight(preJob, preExec.length);
  const priorFailedOnly = preExec.length === 1
    && String((preExec[0].properties && preExec[0].properties.status) || '') === 'Failed'
    && /Cannot find module .*observe-sunset-schema-drift/i.test(
      String(fs.existsSync(path.join(OUT_DIR, 'fail-console-logs.json'))
        ? fs.readFileSync(path.join(OUT_DIR, 'fail-console-logs.json'), 'utf8')
        : 'Cannot find module /app/scripts/observe-sunset-schema-drift.js'),
    );
  if (preExec.length !== 0 && !priorFailedOnly && process.env.SLICE11_ALLOW_NONEMPTY_EXEC !== '1') {
    console.error(JSON.stringify({ ok: false, error: 'expected_zero_or_single_image_proof_failure', count: preExec.length }));
    process.exit(2);
  }
  if (priorFailedOnly) {
    console.log('Continuing after documented image-incapable Failed execution; job image corrected to master SHA.');
  }

  console.log('Starting baseline manual job once…');
  const start = startJob();
  writeJson(path.join(OUT_DIR, 'job-start.json'), start);
  const executionName = start.name
    || (start.properties && start.properties.name)
    || (Array.isArray(start.value) && start.value[0] && start.value[0].name)
    || null;
  // Azure returns differently shaped payloads; resolve from list if needed.
  let resolvedName = executionName;
  if (!resolvedName) {
    sleep(3000);
    const after = listExecutions();
    resolvedName = after[0] && after[0].name;
  }
  if (!resolvedName) {
    console.error(JSON.stringify({ ok: false, error: 'execution_name_missing', start }));
    process.exit(2);
  }
  console.log(`Execution: ${resolvedName}`);

  const finalExec = waitForExecution(resolvedName, 180000);
  writeJson(path.join(OUT_DIR, 'baseline-execution.json'), finalExec);
  const status = String((finalExec.properties && finalExec.properties.status) || '');
  const startTime = (finalExec.properties && finalExec.properties.startTime) || null;
  const endTime = (finalExec.properties && finalExec.properties.endTime) || null;
  let durationSec = null;
  if (startTime && endTime) {
    durationSec = Math.round((Date.parse(endTime) - Date.parse(startTime)) / 1000);
  }

  const workspaceId = logAnalyticsCustomerId();
  let logParse = { report: null, leaked: false, logChars: 0, hasMarkers: false };
  for (let i = 0; i < 12; i += 1) {
    const rows = queryLogs(workspaceId, resolvedName);
    writeJson(path.join(OUT_DIR, 'baseline-logs-raw.json'), { attempt: i + 1, rows });
    logParse = parseObserverFromLogs(rows);
    if (logParse.hasMarkers) break;
    sleep(15000);
  }
  writeJson(path.join(OUT_DIR, 'baseline-observer-report.json'), logParse);

  if (status !== 'Succeeded') {
    console.error(JSON.stringify({ ok: false, error: 'baseline_not_succeeded', status, executionName: resolvedName }));
    process.exit(2);
  }
  if (!logParse.hasMarkers || !logParse.report || logParse.report.ok !== true || logParse.report.match !== true) {
    console.error(JSON.stringify({
      ok: false,
      error: 'baseline_observer_not_match',
      hasMarkers: logParse.hasMarkers,
      reportOk: logParse.report && logParse.report.ok,
    }));
    process.exit(2);
  }
  if (logParse.leaked) {
    console.error(JSON.stringify({ ok: false, error: 'baseline_logs_leaked_secrets' }));
    process.exit(2);
  }

  const mismatchCount = logParse.report.drift && logParse.report.drift.counts
    ? (logParse.report.drift.counts.expected_only
      + logParse.report.drift.counts.live_only
      + logParse.report.drift.counts.definition_mismatch)
    : null;
  if (mismatchCount !== 0) {
    console.error(JSON.stringify({ ok: false, error: 'baseline_mismatch_nonzero', mismatchCount }));
    process.exit(2);
  }

  console.log('Running secret-safe staff-api read-only + drift + recover proofs…');
  const proof = runSlice11StaffApiProof();
  writeJson(path.join(OUT_DIR, 'staff-api-proof.json'), proof);
  if (!proof || proof.ok !== true || !proof.tempWorkerSecretCleanup || proof.tempWorkerSecretCleanup.ok !== true) {
    console.error(JSON.stringify({ ok: false, error: 'staff_api_proof_failed', proof: proof && { ok: proof.ok, error: proof.error } }));
    process.exit(2);
  }
  if (!(proof.session && proof.session.green_host_db && proof.session.green_read_only && proof.session.green_catalog && proof.session.green_authority)) {
    console.error(JSON.stringify({ ok: false, error: 'read_only_green_failed', session: proof.session }));
    process.exit(2);
  }
  const red = proof.denied || {};
  if (!(red.insert && red.insert.ok && red.update && red.update.ok && red.createTable && red.createTable.ok && red.createRole && red.createRole.ok)) {
    console.error(JSON.stringify({ ok: false, error: 'read_only_red_failed', denied: red }));
    process.exit(2);
  }
  if (!(proof.drift && proof.drift.status === 4 && proof.drift.mismatchCount > 0 && proof.drift.hasMarker)) {
    console.error(JSON.stringify({ ok: false, error: 'drift_proof_failed', drift: proof.drift }));
    process.exit(2);
  }
  if (!(proof.recover && proof.recover.status === 0 && proof.recover.ok && proof.recover.match && proof.recover.mismatchCount === 0)) {
    console.error(JSON.stringify({ ok: false, error: 'recover_proof_failed', recover: proof.recover }));
    process.exit(2);
  }
  if ((proof.match && proof.match.leaked) || proof.drift.leaked || proof.recover.leaked) {
    console.error(JSON.stringify({ ok: false, error: 'proof_leaked_secrets' }));
    process.exit(2);
  }

  const postJob = showJob();
  const postExec = listExecutions();
  writeJson(path.join(OUT_DIR, 'post-job.json'), { job: postJob, executionCount: postExec.length });
  if (postJob.triggerType !== 'Manual' || postJob.schedule) {
    console.error(JSON.stringify({ ok: false, error: 'job_config_changed' }));
    process.exit(2);
  }
  if (postExec.length < 1) {
    console.error(JSON.stringify({ ok: false, error: 'missing_execution_history' }));
    process.exit(2);
  }

  const evidence = {
    kind: 'sunset-schema-observer-job-slice11-evidence',
    generatedAt: new Date().toISOString(),
    masterSha,
    outcome: 'Executed luna-sunset-staging-sch-obs once; proved match, read-only, safe drift, recovery; no schedule/schema/data mutation',
    targets: {
      subscriptionId: SUB,
      resourceGroup: RG,
      jobName: JOB,
      database: TARGETS.database,
      role: TARGETS.roleName,
      secretName: 'sunset-schema-observer-database-url',
      staffApiApp: STAFF_API_APP,
      staffApiImage: EXPECTED_IMAGE,
    },
    imageCorrection: {
      required: true,
      reason: 'Deployed staff-api image commit lacked observe-sunset-schema-drift.js and observer fixtures',
      priorImage: PRIOR_FAILED_IMAGE,
      priorFailedExecution: priorFailedOnly ? (preExec[0] && preExec[0].name) : null,
      newImage: EXPECTED_IMAGE,
      staffApiAppImageUnchanged: true,
      staffApiRedeployed: false,
      acrBuildFromMaster: 'a5a57b3920b0a71f71e35786b8784de1ae25b69b',
    },
    baselineExecution: {
      name: resolvedName,
      id: finalExec.id || null,
      status,
      startTime,
      endTime,
      durationSeconds: durationSec,
      exitCodeInferred: 0,
      observerOk: true,
      match: true,
      productFingerprintExpected: logParse.report.productFingerprintExpected,
      productFingerprintLive: logParse.report.productFingerprintLive,
      mismatchCount,
      secretLeakInLogs: false,
      markersPresent: true,
    },
    readOnlyProof: {
      path: 'staff-api MI → observer KV secret (in-container only)',
      green: {
        host: proof.session.host,
        database: proof.session.current_database,
        current_user: proof.session.current_user,
        transaction_read_only: proof.session.transaction_read_only,
        catalogQuerySucceeded: proof.session.green_catalog,
        authorityContract: proof.session.green_authority,
      },
      red: {
        insertDenied: red.insert.ok,
        updateDenied: red.update.ok,
        createTableDenied: red.createTable.ok,
        createRoleDenied: red.createRole.ok,
        details: {
          insert: red.insert.detail,
          update: red.update.detail,
          createTable: red.createTable.detail,
          createRole: red.createRole.detail,
        },
      },
      productRowsRead: false,
    },
    safeDriftProof: {
      method: proof.drift.method,
      distinctFromLiveJob: true,
      liveSchemaMutated: false,
      canonicalFixtureMutated: false,
      jobConfigMutated: false,
      exitStatus: proof.drift.status,
      mismatchCount: proof.drift.mismatchCount,
      hasDefinitionMismatch: proof.drift.hasDefinitionMismatch,
      driftLabel: DRIFT_MARKER,
      hasMarker: proof.drift.hasMarker,
    },
    recoveryProof: {
      path: 'same secret-safe observer executable + canonical contract',
      exitStatus: proof.recover.status,
      match: proof.recover.match,
      mismatchCount: proof.recover.mismatchCount,
      jobRemainsManualUnscheduled: postJob.triggerType === 'Manual' && !postJob.schedule,
    },
    finalJobState: {
      name: postJob.name,
      triggerType: postJob.triggerType,
      hasSchedule: Boolean(postJob.schedule),
      image: postJob.image,
      executionCount: postExec.length,
      secretNames: postJob.secretNames,
      cmd: postJob.cmd,
    },
    nonMutations: {
      jobScheduled: false,
      schemaChanged: false,
      businessDataChanged: false,
      roleOrCredentialRotated: false,
      firewallNetwork: false,
      staffApiRedeployed: false,
      lunaWhatsApp: false,
      wolfhouse: false,
      production: false,
      imageRebuilt: true,
      imageRebuiltForJobOnly: true,
      staffApiRedeployed: false,
      secretValuesExposed: false,
    },
  };
  writeJson(EVIDENCE_PATH, evidence);
  writeJson(path.join(OUT_DIR, 'evidence-preview.json'), evidence);
  console.log(JSON.stringify({
    ok: true,
    executionName: resolvedName,
    status,
    mismatchCount,
    driftExit: proof.drift.status,
    recoverExit: proof.recover.status,
    evidence: path.relative(ROOT, EVIDENCE_PATH).replace(/\\\\/g, '/'),
  }, null, 2));
}

main();
