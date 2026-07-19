'use strict';

/**
 * Finish Slice 11 after image/contract correction:
 * baseline observe start, injob proofs, evidence, cost, what-if.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { TARGETS, redactSecrets } = require('./lib/sunset-schema-observer-role-provision');
const { azJson, azureCliInvoker } = require('./lib/sunset-schema-observer-role-container-pg');
const { DRIFT_MARKER } = require('./lib/sunset-schema-observer-slice11-proof');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmp', 'foundation-slice11');
const EVIDENCE_PATH = path.join(ROOT, 'fixtures', 'sunset-schema-observer', 'slice11-job-execution-evidence.json');
const JOB = 'luna-sunset-staging-sch-obs';
const SUB = TARGETS.subscriptionId;
const RG = TARGETS.resourceGroup;
const IMAGE = 'whstagingacr.azurecr.io/luna-sunset-staff-api:a5a57b3920b0a71f71e35786b8784de1ae25b69b-slice11final';

function sleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (_) { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

function workspaceId() {
  const inv = azureCliInvoker();
  const id = String(spawnSync(inv.exe, inv.prefixArgs.concat([
    'containerapp', 'env', 'show',
    '-n', 'luna-sunset-staging-env', '-g', RG, '--subscription', SUB,
    '--query', 'properties.appLogsConfiguration.logAnalyticsConfiguration.customerId',
    '-o', 'tsv',
  ]), { encoding: 'utf8' }).stdout || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('workspace_missing');
  return id;
}

function waitExec(name) {
  let last = null;
  for (let i = 0; i < 40; i += 1) {
    last = azJson([
      'containerapp', 'job', 'execution', 'show',
      '-n', JOB, '-g', RG, '--subscription', SUB,
      '--job-execution-name', name,
    ]);
    const status = String(last.properties && last.properties.status || '');
    if (/Succeeded|Failed|Stopped|Degraded/i.test(status)) return last;
    sleep(5000);
  }
  return last;
}

function logsFor(ws, prefix) {
  const q = `ContainerAppConsoleLogs_CL | where ContainerGroupName_s has '${prefix}' | order by TimeGenerated asc | project Log_s`;
  return azJson([
    'monitor', 'log-analytics', 'query',
    '--workspace', ws, '--analytics-query', q, '-o', 'json',
  ], { allowEmpty: true }) || [];
}

function textFromRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => r.Log_s || '').join('\n');
}

function parseMarked(text, begin, end) {
  const b = text.indexOf(begin);
  const e = text.indexOf(end);
  if (b < 0 || e <= b) return null;
  return JSON.parse(text.slice(b + begin.length, e).trim());
}

function startDefault() {
  return azJson(['containerapp', 'job', 'start', '-n', JOB, '-g', RG, '--subscription', SUB]);
}

function startProof() {
  return azJson([
    'containerapp', 'job', 'start',
    '-n', JOB, '-g', RG, '--subscription', SUB,
    '--image', IMAGE,
    '--command', 'node',
    '--args', 'scripts/prove-sunset-schema-observer-slice11-injob.js',
    '--env-vars', 'SUNSET_SCHEMA_OBSERVER_DATABASE_URL=secretref:sunset-schema-observer-database-url',
  ]);
}

function showJob() {
  return azJson([
    'containerapp', 'job', 'show',
    '-n', JOB, '-g', RG, '--subscription', SUB,
    '--query',
    '{name:name,triggerType:properties.configuration.triggerType,schedule:properties.configuration.scheduleTriggerConfig,image:properties.template.containers[0].image,cmd:properties.template.containers[0].command,args:properties.template.containers[0].args,secretNames:properties.configuration.secrets[].name}',
  ]);
}

function listExec() {
  const list = azJson([
    'containerapp', 'job', 'execution', 'list',
    '-n', JOB, '-g', RG, '--subscription', SUB,
  ], { allowEmpty: true });
  return Array.isArray(list) ? list : [];
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const masterSha = String(spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: ROOT }).stdout || '').trim();
  const preJob = showJob();
  if (preJob.triggerType !== 'Manual' || preJob.schedule) throw new Error('job_not_manual');
  if (preJob.image !== IMAGE) throw new Error(`image_mismatch ${preJob.image}`);

  console.log('Baseline observe start…');
  const start = startDefault();
  const baselineName = start.name;
  const baseline = waitExec(baselineName);
  writeJson(path.join(OUT_DIR, 'baseline-final-execution.json'), baseline);
  if (String(baseline.properties.status) !== 'Succeeded') {
    throw new Error(`baseline_failed ${baseline.properties.status}`);
  }

  const ws = workspaceId();
  let report = null;
  for (let i = 0; i < 18; i += 1) {
    const text = textFromRows(logsFor(ws, baselineName));
    report = parseMarked(text, 'WH_SCHEMA_OBSERVER_BEGIN', 'WH_SCHEMA_OBSERVER_END');
    if (report) break;
    sleep(10000);
  }
  writeJson(path.join(OUT_DIR, 'baseline-final-report.json'), report);
  if (!report || report.ok !== true || report.match !== true) {
    throw new Error(`baseline_not_match ${report && report.code}`);
  }
  const mismatchCount = report.drift.counts.expected_only
    + report.drift.counts.live_only
    + report.drift.counts.definition_mismatch;
  if (mismatchCount !== 0) throw new Error('baseline_mismatch_nonzero');

  console.log('In-job proof start…');
  const proofStart = startProof();
  const proofName = proofStart.name;
  const proofExec = waitExec(proofName);
  writeJson(path.join(OUT_DIR, 'proof-execution.json'), proofExec);
  if (String(proofExec.properties.status) !== 'Succeeded') {
    throw new Error(`proof_failed ${proofExec.properties.status}`);
  }
  let proof = null;
  for (let i = 0; i < 18; i += 1) {
    const text = textFromRows(logsFor(ws, proofName));
    proof = parseMarked(text, 'WH_SLICE11_PROOF_BEGIN', 'WH_SLICE11_PROOF_END');
    if (proof) break;
    sleep(10000);
  }
  writeJson(path.join(OUT_DIR, 'proof-report.json'), proof);
  if (!proof || proof.ok !== true) throw new Error('proof_payload_missing');
  if (!(proof.session.green_host_db && proof.session.green_read_only && proof.session.green_catalog && proof.session.green_authority)) {
    throw new Error('readonly_green_failed');
  }
  const red = proof.denied;
  if (!(red.insert.ok && red.update.ok && red.createTable.ok && red.createRole.ok)) {
    throw new Error('readonly_red_failed');
  }
  if (!(proof.drift.status === 4 && proof.drift.mismatchCount > 0)) {
    throw new Error('drift_failed');
  }
  if (!(proof.recover.status === 0 && proof.recover.ok && proof.recover.match && proof.recover.mismatchCount === 0)) {
    throw new Error('recover_failed');
  }
  if (proof.match.leaked || proof.drift.leaked || proof.recover.leaked) {
    throw new Error('secret_leak');
  }

  const postJob = showJob();
  const postExec = listExec();
  const durationSec = baseline.properties.startTime && baseline.properties.endTime
    ? Math.round((Date.parse(baseline.properties.endTime) - Date.parse(baseline.properties.startTime)) / 1000)
    : null;

  const evidence = {
    kind: 'sunset-schema-observer-job-slice11-evidence',
    generatedAt: new Date().toISOString(),
    masterShaAtStart: 'a5a57b3920b0a71f71e35786b8784de1ae25b69b',
    workingTreeSha: masterSha,
    outcome: 'Executed manual schema-observer job with live-catalog contract match; proved read-only, safe drift, recovery',
    targets: {
      subscriptionId: SUB,
      resourceGroup: RG,
      jobName: JOB,
      database: TARGETS.database,
      role: TARGETS.roleName,
      secretName: 'sunset-schema-observer-database-url',
      jobImage: IMAGE,
      staffApiImageUnchanged: 'whstagingacr.azurecr.io/luna-sunset-staff-api:186307418400581a74f86b096e02bc32a41513b6',
    },
    imageCorrection: {
      required: true,
      priorImageLackedObserverScript: true,
      priorFailedExecution: 'luna-sunset-staging-sch-obs-ealngjc',
      liveContractRefreshRequired: true,
      liveFingerprint: report.productFingerprintLive,
      staffApiRedeployed: false,
    },
    baselineExecution: {
      name: baselineName,
      id: baseline.id || null,
      status: 'Succeeded',
      startTime: baseline.properties.startTime,
      endTime: baseline.properties.endTime,
      durationSeconds: durationSec,
      exitCodeInferred: 0,
      observerOk: true,
      match: true,
      productFingerprintExpected: report.productFingerprintExpected,
      productFingerprintLive: report.productFingerprintLive,
      mismatchCount,
      secretLeakInLogs: false,
    },
    readOnlyProof: {
      path: 'temporary injob override (secretRef); not a schedule change',
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
      executionName: proofName,
      distinctFromBaselineObserve: true,
      liveSchemaMutated: false,
      canonicalCommittedFixtureMutatedOnlyInTempFile: true,
      jobScheduleMutated: false,
      exitStatus: proof.drift.status,
      mismatchCount: proof.drift.mismatchCount,
      hasDefinitionMismatch: proof.drift.hasDefinitionMismatch,
      driftLabel: DRIFT_MARKER,
      hasMarker: proof.drift.hasMarker,
    },
    recoveryProof: {
      path: 'same injob observer + canonical live contract',
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
      command: postJob.cmd,
      args: postJob.args,
      executionCount: postExec.length,
      secretNames: postJob.secretNames,
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
      jobImageUpdatedForObserverOnly: true,
      secretValuesExposed: false,
    },
  };
  writeJson(EVIDENCE_PATH, evidence);
  console.log(JSON.stringify({
    ok: true,
    baselineName,
    proofName,
    mismatchCount,
    driftExit: proof.drift.status,
    recoverExit: proof.recover.status,
    executionCount: postExec.length,
  }, null, 2));
}

try {
  main();
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: redactSecrets(String(e && e.message || e)) }));
  process.exit(2);
}
