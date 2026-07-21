'use strict';

/**
 * verify:radar-slice16a-operations-gate-ledger — RADAR Slice 16A
 *
 * Offline audit gate: frozen operations gate ledger + sanitized live inventory.
 * No network, no DB, no Azure calls, no live mutation, no real secrets.
 *
 * Exit 0 on pass, nonzero on failure.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'radar-operations');
const MATRIX_PATH = path.join(FIXTURE_DIR, 'gate-matrix.json');
const LIVE_PATH = path.join(FIXTURE_DIR, 'live-inventory.json');
const CONTRACT_PATH = path.join(FIXTURE_DIR, 'contract.json');
const FINDINGS_PATH = path.join(FIXTURE_DIR, 'findings.md');
const DOC_PATH = path.join(ROOT, 'docs', 'RADAR-OPERATIONS-GATE-LEDGER.md');

const MASTER_BASIS = '905ff9ff57a75d0b3defc15a16078b47e94e930f';
const MASTER_BASIS_16AM = '905ff9ff57a75d0b3defc15a16078b47e94e930f';
const MASTER_BASIS_16AK = '9fa3626326c0e2bc21f2d37905967d6ff47b7520';
const MASTER_BASIS_16AJ = '0994989a3d5d14daa98797fac55083b0c2ea809c';
const MASTER_BASIS_16AI = 'd04b633390bdcacfe3a04eed4796bba4184e29f8';
const MASTER_BASIS_16AH = '6c24e9456bd42c7fa1b051bb1308aae8f632b293';
const MASTER_BASIS_16AG = '7a283b70d38a4906e6279d82a49c0f6dd2a4994e';
const BRANCH_16AF = 'radar/slice-16af-g06-capacity-alert-live-evidence';
const BRANCH_16AG = 'radar/slice-16ag-g06-bounded-load-harness';
const BRANCH_16AH = 'radar/slice-16ah-g06-live-load-correction';
const BRANCH_16AI = 'radar/slice-16ai-g06-live-load-evidence';
const BRANCH_16AJ = 'radar/slice-16aj-g06-slo-error-budget-source';
const BRANCH_16AK = 'radar/slice-16ak-g06-backpressure-source';
const BRANCH_16AL = 'radar/slice-16al-g06-backpressure-wire';
const MASTER_BASIS_16AL = '502d762f897432c67bb8b17a8a49bfab01a0787d';
const BRANCH_16AM = 'radar/slice-16am-g06-backpressure-deploy-evidence';
const BRANCH_16AD = 'radar/slice-16ad-g02-sampled-restart-continuity-evidence';
const BRANCH_16AC = 'radar/slice-16ac-organic-restart-alert-evidence';
const BRANCH_16AB = 'radar/slice-16ab-g02-readyz503-evidence';
const BRANCH_16AA = 'radar/slice-16aa-g02-live-sigint-evidence';
const BRANCH_16Z = 'radar/slice-16z-g02-live-sigterm-evidence';
const BRANCH_16Y = 'radar/slice-16y-shutdown-completion-log';
const BRANCH_16X = 'radar/slice-16x-g02-live-evidence';
const BRANCH_16W = 'radar/slice-16w-readiness-shutdown-lifecycle';
const BRANCH_16U = 'radar/slice-16u-correlation-design-freeze';
const BRANCH_16S = 'radar/slice-16s-request-log-live-evidence';
const BRANCH_16P = 'radar/slice-16p-live-drill-evidence';
const BRANCH_16O = 'radar/slice-16o-stripe-webhook-error-minimization';
const BRANCH_16R = 'radar/slice-16r-request-completion-log';
const VERDICTS = new Set(['proven', 'partial', 'absent']);
const REQUIRED_GATE_IDS = [
  'G01_correlation_structured_logs',
  'G02_readiness_dependencies',
  'G03_actionable_tenant_aware_alerts',
  'G04_webhook_payment_worker_backlog',
  'G05_retry_replay_safety',
  'G06_scaling_capacity',
  'G07_rollback_incident_runbooks',
  'G08_retention_privacy',
  'G09_cost_controls',
];

const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]+/,
  /sk_test_[A-Za-z0-9]{20,}/,
  /whsec_[A-Za-z0-9]+/,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /ClientSecret["']?\s*[:=]\s*["'][^"']{12,}/i,
  /password["']?\s*[:=]\s*["'][^"']{8,}/i,
  /ACCOUNT_KEY["']?\s*[:=]\s*["'][^"']{16,}/i,
];

let pass = 0;
let fail = 0;

function docLacksBareOverclaim(docText, patterns) {
  const neg = /not claimed|does\s*\*+\s*not|does not|never|open|forbidden|explicitly|default OFF|not enabled|claiming |raising |OFF\/unset|disabled|no live/i;
  for (const line of String(docText).split(/\n/)) {
    if (neg.test(line)) continue;
    for (const re of patterns) {
      if (re.test(line)) return false;
    }
  }
  return true;
}


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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function countVerdicts(gates) {
  const counts = { proven: 0, partial: 0, absent: 0, total: 0 };
  for (const g of gates) {
    if (VERDICTS.has(g.verdict)) counts[g.verdict] += 1;
    counts.total += 1;
  }
  return counts;
}

function pathExists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function citeExists(ev) {
  if (!ev || !ev.path) return false;
  const abs = path.join(ROOT, ev.path);
  if (!fs.existsSync(abs)) return false;
  if (!ev.lines) return true;
  const src = fs.readFileSync(abs, 'utf8');
  const first = String(ev.lines).split(',')[0].split('-')[0];
  const lineNo = Number(first);
  if (!Number.isFinite(lineNo) || lineNo < 1) return true;
  const lines = src.split(/\r?\n/);
  return lineNo <= lines.length;
}

function secretFree(text, label) {
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) {
      return { ok: false, detail: `${label} matched ${re}` };
    }
  }
  return { ok: true };
}

function runtimePathsUnchanged() {
  // Tip freeze: database/, Hermes, correlation/completion helpers, staging Bicep,
  // 16H/16B modules untouched. 16AL may wire scripts/staff-query-api.js and
  // scripts/lib/staff-api-readiness-lifecycle.js (shutdown BEGIN hook only).
  const paths = [
    'database/',
    'docker/hermes-staging/',
    'docker/hermes-sunset/',
    'scripts/lib/staff-api-request-correlation.js',
    'scripts/lib/staff-api-request-completion-log.js',
    'scripts/lib/stripe-webhook-public-errors.js',
    'infra/azure/staging/main.bicep',
    'infra/azure/sunset-staging/main.bicep',
    'infra/azure/staging-staff-api-metric-alerts/',
    'infra/azure/staging-cost-budgets/',
  ];
  try {
    const out = execSync(
      `git diff --name-only ${MASTER_BASIS} -- ${paths.join(' ')}`,
      { cwd: ROOT, encoding: 'utf8' },
    ).trim();
    return { ok: out === '', detail: out || '(clean)' };
  } catch (err) {
    return { ok: false, detail: String(err && err.message) };
  }
}

function noTrailingWhitespace(text) {
  return !text.split(/\n/).some((line) => /[ \t]+$/.test(line));
}

/** Range check vs master basis — bare `git diff --check` on a clean tree can miss committed trailing WS. */
function rangeDiffCheckClean() {
  try {
    const out = execSync(
      `git diff --check ${MASTER_BASIS}..HEAD`,
      { cwd: ROOT, encoding: 'utf8' },
    );
    return { ok: true, detail: out.trim() || '(clean)' };
  } catch (err) {
    const detail = String((err && err.stdout) || (err && err.message) || err).trim();
    return { ok: false, detail: detail.slice(0, 800) };
  }
}

function currentBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch (_) {
    return '';
  }
}

function staffApiRuntimeDiffVsMaster() {
  // 16AL owns a bounded Staff API admission wire in staff-query-api.js and a
  // shutdown-BEGIN hook in staff-api-readiness-lifecycle.js. Other runtime
  // libs (pool close, completion log, stripe webhook) stay frozen.
  const paths = [
    'scripts/lib/staff-api-readiness.js',
    'scripts/lib/staff-api-readiness-shutdown-completion-log.js',
    'scripts/lib/stripe-webhook-public-errors.js',
    'scripts/lib/stripe-webhook-event-claim.js',
    'scripts/lib/stripe-webhook-payment-truth.js',
  ];
  try {
    return execSync(
      `git diff --name-only ${MASTER_BASIS} -- ${paths.join(' ')}`,
      { cwd: ROOT, encoding: 'utf8' },
    ).trim().split(/\n/).filter(Boolean);
  } catch (_) {
    return [];
  }
}

console.log('verify:radar-slice16a-operations-gate-ledger — RADAR Slice 16A\n');

ok('F1 gate-matrix exists', fs.existsSync(MATRIX_PATH));
ok('F2 live-inventory exists', fs.existsSync(LIVE_PATH));
ok('F3 contract exists', fs.existsSync(CONTRACT_PATH));
ok('F4 findings exists', fs.existsSync(FINDINGS_PATH));
ok('F5 ledger doc exists', fs.existsSync(DOC_PATH));

const matrix = readJson(MATRIX_PATH);
const live = readJson(LIVE_PATH);
const contract = readJson(CONTRACT_PATH);
const doc = readText(DOC_PATH);
const findings = readText(FINDINGS_PATH);

ok('F6 matrix schema_version=1', matrix.schema_version === 1);
ok('F7 no live mutation (16AA evidence-only; audit_only=true)', matrix.audit_only === true && matrix.live_mutation === false);
ok('F8 master_basis pinned', matrix.master_basis === MASTER_BASIS);
ok('F9 contract master_basis pinned', contract.master_basis === MASTER_BASIS);
ok('F10 classification policy fail-closed',
  matrix.classification_policy === 'fail_closed_absence_is_not_safe');
ok('F11 azure scope exactly two staging RGs',
  Array.isArray(matrix.azure_read_only_scope)
  && matrix.azure_read_only_scope.length === 2
  && matrix.azure_read_only_scope.includes('wh-staging-rg')
  && matrix.azure_read_only_scope.includes('luna-sunset-staging-rg'));

ok('F12 gates array length 9', Array.isArray(matrix.gates) && matrix.gates.length === 9);
const ids = matrix.gates.map((g) => g.id);
ok('F13 required gate ids present', REQUIRED_GATE_IDS.every((id) => ids.includes(id)));

let schemaOk = true;
for (const g of matrix.gates) {
  if (!g.id || !g.name || !VERDICTS.has(g.verdict)) schemaOk = false;
  if (!Array.isArray(g.source_evidence) || g.source_evidence.length < 1) schemaOk = false;
  if (!Array.isArray(g.live_evidence) || g.live_evidence.length < 1) schemaOk = false;
  if (!Array.isArray(g.gaps) || g.gaps.length < 1) schemaOk = false;
}
ok('F14 gate schema complete', schemaOk);

const counts = countVerdicts(matrix.gates);
ok('F15 verdict counts match matrix.verdict_counts',
  counts.proven === matrix.verdict_counts.proven
  && counts.partial === matrix.verdict_counts.partial
  && counts.absent === matrix.verdict_counts.absent
  && counts.total === matrix.verdict_counts.total);
ok('F16 expected frozen counts proven=0 partial=9 absent=0',
  counts.proven === 0 && counts.partial === 9 && counts.absent === 0 && counts.total === 9);
ok('F17 contract expected counts match',
  contract.expected_verdict_counts.proven === 0
  && contract.expected_verdict_counts.partial === 9
  && contract.expected_verdict_counts.absent === 0);

const g03 = matrix.gates.find((g) => g.id === 'G03_actionable_tenant_aware_alerts');
const g09 = matrix.gates.find((g) => g.id === 'G09_cost_controls');
ok('F18 G03 partial critical (partial_live_proven via 16AC organic restart + 16P AG test API)',
  g03 && g03.verdict === 'partial' && g03.severity === 'critical'
  && g03.progress_class === 'partial_live_proven'
  && /16AC|organic.?restart|restart.?count/i.test(String(g03.rationale || ''))
  && Array.isArray(g03.gaps)
  && g03.gaps.some((g) => /human.?inbox|inbox.?receipt/i.test(String(g)))
  && !g03.gaps.some((g) => (
    /organic.?metric.?alert.?firing.?not.?claimed/i.test(String(g))
    && !/inbox|human/i.test(String(g))
  )));
ok('F19 G09 partial high (partial_live_proven AG test API; anomaly absent)',
  g09 && g09.verdict === 'partial' && g09.severity === 'high'
  && g09.progress_class === 'partial_live_proven'
  && g09.controls
  && g09.controls.budget_threshold
  && g09.controls.budget_threshold.status === 'partial'
  && g09.controls.anomaly_detection
  && g09.controls.anomaly_detection.status === 'absent');

const sel = matrix.slice_16b_selection;
ok('F20 exactly one 16B selection',
  sel && sel.selected === true
  && sel.outcome_id === '16B_staging_rg_cost_budget_threshold'
  && sel.gate_id === 'G09_cost_controls'
  && sel.progress_class === 'budget_threshold_partial_progress_only'
  && sel.does_not_implement === 'anomaly_detection');
ok('F21 16B acceptance criteria finite (>=4)',
  Array.isArray(sel.acceptance_criteria) && sel.acceptance_criteria.length >= 4);
ok('F22 16B final controlled drill present',
  sel.final_controlled_drill
  && sel.final_controlled_drill.id === '16B_DRILL_budget_threshold_notify');
ok('F23 contract selected_16b matches',
  contract.selected_16b.outcome_id === '16B_staging_rg_cost_budget_threshold'
  && contract.selected_16b.gate_id === 'G09_cost_controls');

const sel16h = matrix.slice_16h_selection;
ok('F23b exactly one 16H selection',
  sel16h && sel16h.selected === true
  && sel16h.outcome_id === '16H_staff_api_metric_alerts'
  && sel16h.gate_id === 'G03_actionable_tenant_aware_alerts'
  && sel16h.progress_class === 'source_partial_progress_only');
ok('F23c contract selected_16h matches',
  contract.selected_16h
  && contract.selected_16h.outcome_id === '16H_staff_api_metric_alerts'
  && contract.selected_16h.gate_id === 'G03_actionable_tenant_aware_alerts');
ok('F23d 16H final controlled drill present',
  sel16h.final_controlled_drill
  && sel16h.final_controlled_drill.id === '16H_DRILL_metric_alert_fire_notify');
ok('F23e 16H acceptance criteria finite (>=4)',
  Array.isArray(sel16h.acceptance_criteria) && sel16h.acceptance_criteria.length >= 4);

const sel16i = matrix.slice_16i_selection;
ok('F23f exactly one 16I selection',
  sel16i && sel16i.selected === true
  && sel16i.outcome_id === '16I_staff_api_readiness_dependencies'
  && sel16i.gate_id === 'G02_readiness_dependencies'
  && sel16i.progress_class === 'source_partial_progress_only');
ok('F23g contract selected_16i matches',
  contract.selected_16i
  && contract.selected_16i.outcome_id === '16I_staff_api_readiness_dependencies'
  && contract.selected_16i.gate_id === 'G02_readiness_dependencies');
ok('F23h 16I final controlled drill present',
  sel16i.final_controlled_drill
  && sel16i.final_controlled_drill.id === '16I_DRILL_readiness_failure_traffic_shed');
ok('F23i 16I acceptance criteria finite (>=4)',
  Array.isArray(sel16i.acceptance_criteria) && sel16i.acceptance_criteria.length >= 4);
ok('F23j 16I supersedes deferred 16C',
  Array.isArray(sel16i.supersedes)
  && sel16i.supersedes.includes('16C_staff_api_readiness_dependencies'));

ok('F24 live inventory read_only + no mutation',
  live.read_only === true && live.live_mutation === false);
ok('F25 live budgets empty both RGs',
  Array.isArray(live.budgets['wh-staging-rg'])
  && live.budgets['wh-staging-rg'].length === 0
  && Array.isArray(live.budgets['luna-sunset-staging-rg'])
  && live.budgets['luna-sunset-staging-rg'].length === 0);
ok('F26 live alerts empty both RGs',
  live.alerts['wh-staging-rg'].metric_alerts.length === 0
  && live.alerts['luna-sunset-staging-rg'].metric_alerts.length === 0
  && live.alerts['wh-staging-rg'].activity_log_alerts.length === 0
  && live.alerts['luna-sunset-staging-rg'].activity_log_alerts.length === 0);
ok('F27 MTD costs frozen match contract',
  live.costs_mtd['wh-staging-rg'].total === contract.costs_mtd_usd_frozen['wh-staging-rg']
  && live.costs_mtd['luna-sunset-staging-rg'].total === contract.costs_mtd_usd_frozen['luna-sunset-staging-rg']
  && live.costs_mtd.combined_total === contract.costs_mtd_usd_frozen.combined);
ok('F28 MTD costs positive',
  live.costs_mtd['wh-staging-rg'].total > 0
  && live.costs_mtd['luna-sunset-staging-rg'].total > 0);

ok('F29 public healthz frozen 200 without dependency fields',
  live.public_healthz['staff-staging.lunafrontdesk.com'].http_status === 200
  && live.public_healthz['sunset-staging.lunafrontdesk.com'].http_status === 200
  && live.public_healthz['staff-staging.lunafrontdesk.com'].dependency_fields_present === false);

ok('F30 ACA probes empty/null frozen',
  Array.isArray(live.container_apps['wh-staging-staff-api'].probes)
  && live.container_apps['wh-staging-staff-api'].probes.length === 0
  && live.container_apps['luna-sunset-staging-staff-api'].probes === null);

let evidenceOk = true;
for (const g of matrix.gates) {
  for (const ev of g.source_evidence) {
    if (!citeExists(ev)) {
      evidenceOk = false;
      ok(`F31 evidence ${g.id} ${ev.path}`, false, `missing path/lines ${ev.lines}`);
    }
  }
}
ok('F31 all source evidence paths/lines resolve', evidenceOk);

const blob = [
  JSON.stringify(matrix),
  JSON.stringify(live),
  JSON.stringify(contract),
  findings,
  doc,
].join('\n');
const sec = secretFree(blob, 'fixtures+doc');
ok('F32 secret-free fixtures and doc', sec.ok, sec.detail);

ok('F33 doc mentions selected 16U id', /16U_correlation_design_freeze/.test(doc));
ok('F33b doc retains 16S id', /16S_request_completion_log_live_evidence/.test(doc));
ok('F33c doc retains 16P id', /16P_live_drill_evidence_reconciliation|16P/.test(doc));
ok('F33d doc retains 16O id', /16O_stripe_webhook_error_minimization|16O/.test(doc));
ok('F33e doc mentions 16X evidence', /16X|g02.?live.?evidence/i.test(doc));
ok('F33f doc retains 16W lifecycle', /16W|closeReadinessPool/i.test(doc));
ok('F33g doc mentions 16Y shutdown completion', /16Y|shutdown.?completion/i.test(doc));
ok('F33h doc mentions 16Z live SIGTERM evidence', /16Z|live.?sigterm/i.test(doc));
ok('F33i doc mentions 16AA live SIGINT evidence', /16AA|live.?sigint/i.test(doc));
ok('F34 doc mentions verdict counts', /proven.*0/i.test(doc) && /partial.*9/i.test(doc) && /absent.*0/i.test(doc));
ok('F35 findings lists G01/G02/G03/G05/G06/G08/G09 partial',
  /G01/.test(findings) && /G02/.test(findings) && /G03/.test(findings) && /G05/.test(findings) && /G06/.test(findings) && /G08/.test(findings) && /G09/.test(findings) && /partial/i.test(findings)
  && /16O/.test(findings) && /16P/.test(findings) && /16S/.test(findings) && /16U/.test(findings) && /16W/.test(findings) && /16X/.test(findings) && /16Y/.test(findings) && /16Z/.test(findings) && /16AA/.test(findings));

ok('F36 healthz source cite present', pathExists('scripts/staff-query-api.js'));
ok('F37 capture cost script present (read-only helper)',
  pathExists('scripts/capture-sunset-staging-rg-cost.js'));
ok('F38 payment_events unique stripe_event_id migration present',
  /stripe_event_id\s+TEXT UNIQUE/.test(readText(path.join(ROOT, 'database/migrations/001_init.sql'))));

const rt = runtimePathsUnchanged();
ok('F39 runtime paths unchanged vs master basis (16AL may wire staff-query-api only; other freeze paths clean)',
  rt.ok, rt.detail);

ok('F40 16A final controlled drill frozen',
  matrix.final_controlled_drill_16a
  && matrix.final_controlled_drill_16a.id === '16A_DRILL_ledger_freeze_read_only');

ok('F41 ledger doc has no trailing whitespace', noTrailingWhitespace(doc));
ok('F42 findings have no trailing whitespace', noTrailingWhitespace(findings));
const rangeCheck = rangeDiffCheckClean();
ok('F43 git range diff --check clean vs master basis', rangeCheck.ok, rangeCheck.detail);
ok('F44 contract gates pin range diff --check',
  Array.isArray(contract.gates)
  && contract.gates.some((g) => g === `git diff --check ${MASTER_BASIS}..HEAD`));

const g02 = matrix.gates.find((g) => g.id === 'G02_readiness_dependencies');
ok('F45 G02 partial_live_proven via 16AD sampled continuity + 16AC organic restart + 16AB readyz=503 + 16AA SIGINT + 16Z SIGTERM + 16X traffic-shed + 16Y source (absolute zero-downtime/production open)',
  g02 && g02.verdict === 'partial'
  && g02.progress_class === 'partial_live_proven'
  && /readyz|health\/ready|health.ready|traffic.?shed|g02fail|2dcda08|16X|16Z|16AA|16AB|16AC|16AD|SIGTERM|SIGINT|organic.?restart|restart.?count|sampled/i.test(g02.rationale)
  && (/16I/.test(g02.rationale) || /16P/.test(g02.rationale) || /16W/.test(g02.rationale))
  && /16X|g02fail|traffic.?shed/i.test(g02.rationale)
  && /16Y|shutdown.?completion/i.test(g02.rationale)
  && /16Z|sigterm|LAW/i.test(g02.rationale)
  && /16AA|sigint/i.test(g02.rationale)
  && /16AB|readyz.?503|g02503/i.test(g02.rationale)
  && /16AC|organic.?restart|restart.?count/i.test(g02.rationale)
  && /16AD|sampled.?restart|concurrent.?sampled/i.test(g02.rationale)
  && Array.isArray(g02.gaps)
  && !g02.gaps.some((g) => /closeReadinessPool not yet wired/i.test(String(g)))
  && !g02.gaps.some((g) => /dependency.failure.*not executed|traffic.shed.*not executed/i.test(String(g)))
  && !g02.gaps.some((g) => /SIGTERM.*not proven/i.test(String(g)) && !/SIGINT/i.test(String(g)))
  && !g02.gaps.some((g) => /SIGINT\s+.*not proven|SIGINT.*live.*not proven/i.test(String(g)))
  && !g02.gaps.some((g) => /serving.?revision.?\/?readyz.?=?503.*not exercised|readyz.?503 body path not exercised/i.test(String(g)))
  && !g02.gaps.some((g) => (
    /organic.?metric.?alert.?firing.?not.?claimed|organic.?restart.?alert/i.test(String(g))
    && /not claimed/i.test(String(g))
  ))
  && !g02.gaps.some((g) => /^Zero downtime during restart \/ concurrent sampled continuity not claimed$/i.test(String(g)))
  && g02.gaps.some((g) => /absolute|continuous|zero.?downtime|production|cold.?start/i.test(String(g))));
ok('F46 readiness lib present', pathExists('scripts/lib/staff-api-readiness.js'));
ok('F47 16I verifier script present',
  pathExists('scripts/verify-radar-slice16i-staff-api-readiness.js'));

const slice16pContract = readJson(path.join(FIXTURE_DIR, 'slice16p-expected-contract.json'));
const slice16oContract = readJson(path.join(FIXTURE_DIR, 'slice16o-expected-contract.json'));
const slice16rContract = readJson(path.join(FIXTURE_DIR, 'slice16r-expected-contract.json'));
const slice16sContract = readJson(path.join(FIXTURE_DIR, 'slice16s-expected-contract.json'));
const slice16uContract = readJson(path.join(FIXTURE_DIR, 'slice16u-expected-contract.json'));
const slice16wContract = readJson(path.join(FIXTURE_DIR, 'slice16w-expected-contract.json'));
const slice16xContract = readJson(path.join(FIXTURE_DIR, 'slice16x-expected-contract.json'));
const slice16yContract = readJson(path.join(FIXTURE_DIR, 'slice16y-expected-contract.json'));
const slice16zContract = readJson(path.join(FIXTURE_DIR, 'slice16z-expected-contract.json'));
const slice16aaContract = readJson(path.join(FIXTURE_DIR, 'slice16aa-expected-contract.json'));
const slice16abContract = readJson(path.join(FIXTURE_DIR, 'slice16ab-expected-contract.json'));
const slice16acContract = readJson(path.join(FIXTURE_DIR, 'slice16ac-expected-contract.json'));
const slice16adContract = readJson(path.join(FIXTURE_DIR, 'slice16ad-expected-contract.json'));
const headBranch = currentBranch();
const slice16afContract = readJson(path.join(FIXTURE_DIR, 'slice16af-expected-contract.json'));
const slice16agContract = readJson(path.join(FIXTURE_DIR, 'slice16ag-expected-contract.json'));
const slice16ahContract = readJson(path.join(FIXTURE_DIR, 'slice16ah-expected-contract.json'));
const slice16aiContract = readJson(path.join(FIXTURE_DIR, 'slice16ai-expected-contract.json'));
const slice16ajContract = readJson(path.join(FIXTURE_DIR, 'slice16aj-expected-contract.json'));
const slice16akContract = readJson(path.join(FIXTURE_DIR, 'slice16ak-expected-contract.json'));
const slice16alContract = readJson(path.join(FIXTURE_DIR, 'slice16al-expected-contract.json'));
const slice16amContract = readJson(path.join(FIXTURE_DIR, 'slice16am-expected-contract.json'));
ok('F48 gate-matrix branch pin equals 16AM tip contract + HEAD (16AL/16AK/16AJ/16AI/16AH/16AG locks retained)',
  matrix.branch === BRANCH_16AM
  && contract.branch === BRANCH_16AM
  && slice16amContract.branch === BRANCH_16AM
  && headBranch === BRANCH_16AM
  && slice16alContract.branch === BRANCH_16AL
  && slice16akContract.branch === BRANCH_16AK
  && slice16ajContract.branch === BRANCH_16AJ
  && slice16aiContract.branch === BRANCH_16AI
  && slice16ahContract.branch === BRANCH_16AH
  && slice16agContract.branch === BRANCH_16AG,
  `matrix=${matrix.branch} contract=${contract.branch} slice16am=${slice16amContract.branch} slice16al=${slice16alContract.branch} head=${headBranch}`);
ok('F48b frozen 16O/16P/16R/16S/16U/16W/16X/16Y/16Z/16AA/16AB/16AC/16AD/16AF contracts retain their own branch pins',
  slice16oContract.branch === BRANCH_16O
  && slice16pContract.branch === BRANCH_16P
  && slice16rContract.branch === BRANCH_16R
  && slice16sContract.branch === BRANCH_16S
  && slice16uContract.branch === BRANCH_16U
  && slice16wContract.branch === BRANCH_16W
  && slice16xContract.branch === BRANCH_16X
  && slice16yContract.branch === BRANCH_16Y
  && slice16zContract.branch === BRANCH_16Z
  && slice16aaContract.branch === BRANCH_16AA
  && slice16abContract.branch === BRANCH_16AB
  && slice16acContract.branch === BRANCH_16AC
  && slice16adContract.branch === BRANCH_16AD
  && slice16afContract.branch === BRANCH_16AF);

const mustNot = Array.isArray(matrix.must_not) ? matrix.must_not : [];
const hasStaleSourceForbid = mustNot.some((m) =>
  /^source runtime behavior change$/i.test(String(m).trim()));
const hasLiveDeployedForbid = mustNot.some((m) =>
  /live\/deployed runtime mutation/i.test(String(m)));
ok('F49 must_not forbids live/deployed mutation, not blanket source change',
  !hasStaleSourceForbid && hasLiveDeployedForbid,
  JSON.stringify(mustNot));

const g01 = matrix.gates.find((g) => g.id === 'G01_correlation_structured_logs');
const g08 = matrix.gates.find((g) => g.id === 'G08_retention_privacy');
const runtimeDiff = staffApiRuntimeDiffVsMaster();
const bicepDiff = execSync(
  `git diff --name-only ${MASTER_BASIS} -- infra/azure/staging/main.bicep infra/azure/sunset-staging/main.bicep`,
  { cwd: ROOT, encoding: 'utf8' },
).trim().split(/\n/).filter(Boolean);
const g08CitesPublicErrors = g08
  && Array.isArray(g08.source_evidence)
  && g08.source_evidence.some((ev) =>
    ev.path === 'scripts/lib/stripe-webhook-public-errors.js'
    || ev.path === 'scripts/staff-query-api.js');
ok('F50 must_not forbids live mutation; pool/webhook runtime libs unchanged vs tip basis; bicep unchanged; G08 still cites public-errors',
  !hasStaleSourceForbid
  && hasLiveDeployedForbid
  && g08CitesPublicErrors
  && runtimeDiff.length === 0
  && pathExists('scripts/lib/staff-api-readiness-lifecycle.js')
  && pathExists('scripts/lib/staff-api-readiness-shutdown-completion-log.js')
  && pathExists('scripts/lib/stripe-webhook-public-errors.js')
  && bicepDiff.length === 0
  && matrix.live_mutation === false
  && matrix.audit_only === true,
  `runtimeDiff=${runtimeDiff.join(',') || '(none)'} bicepDiff=${bicepDiff.join(',') || '(none)'} stale=${hasStaleSourceForbid}`);

ok('F51 G01 partial_live_proven via 16S + 16U design freeze (G01-A live open)',
  g01 && g01.verdict === 'partial'
  && g01.progress_class === 'partial_live_proven'
  && /16S|1bf9695|ContainerAppConsoleLogs_CL/i.test(g01.rationale)
  && /16U|design freeze|G01-A/i.test(g01.rationale)
  && Array.isArray(g01.gaps) && g01.gaps.length === 1
  && /G01-A|Meta.*Hermes|correlation/i.test(g01.gaps[0]));
ok('F52 correlation lib present', pathExists('scripts/lib/staff-api-request-correlation.js'));
ok('F53 16J verifier script present',
  pathExists('scripts/verify-radar-slice16j-staff-request-correlation.js'));

const sel16j = matrix.slice_16j_selection;
ok('F54 exactly one 16J selection',
  sel16j && sel16j.selected === true
  && sel16j.outcome_id === '16J_staff_api_request_correlation'
  && sel16j.gate_id === 'G01_correlation_structured_logs'
  && sel16j.progress_class === 'source_partial_progress_only');
ok('F55 contract selected_16j matches',
  contract.selected_16j
  && contract.selected_16j.outcome_id === '16J_staff_api_request_correlation'
  && contract.selected_16j.gate_id === 'G01_correlation_structured_logs');
ok('F56 16J final controlled drill present',
  sel16j.final_controlled_drill
  && sel16j.final_controlled_drill.id === '16J_DRILL_correlation_log_query');
ok('F57 16J acceptance criteria finite (>=4)',
  Array.isArray(sel16j.acceptance_criteria) && sel16j.acceptance_criteria.length >= 4);
ok('F58 16J supersedes deferred 16D',
  Array.isArray(sel16j.supersedes)
  && sel16j.supersedes.includes('16D_staff_api_request_correlation'));

ok('F59 G08 partial_live_proven via 16P (+ 16O/16K source)',
  g08 && g08.verdict === 'partial'
  && g08.progress_class === 'partial_live_proven'
  && /16P|16O/.test(g08.rationale)
  && /webhook/i.test(g08.rationale)
  && /594247f|malformed|oversize/i.test(g08.rationale));
ok('F60 healthz lib present', pathExists('scripts/lib/staff-api-healthz.js'));
ok('F61 16K verifier script present',
  pathExists('scripts/verify-radar-slice16k-staff-api-healthz.js'));

const sel16k = matrix.slice_16k_selection;
ok('F62 exactly one 16K selection',
  sel16k && sel16k.selected === true
  && sel16k.outcome_id === '16K_staff_api_healthz_minimization'
  && sel16k.gate_id === 'G08_retention_privacy'
  && sel16k.progress_class === 'source_partial_progress_only');
ok('F63 contract selected_16k matches',
  contract.selected_16k
  && contract.selected_16k.outcome_id === '16K_staff_api_healthz_minimization'
  && contract.selected_16k.gate_id === 'G08_retention_privacy');
ok('F64 16K final controlled drill present',
  sel16k.final_controlled_drill
  && sel16k.final_controlled_drill.id === '16K_DRILL_healthz_privacy_live_prove');
ok('F65 16K acceptance criteria finite (>=4)',
  Array.isArray(sel16k.acceptance_criteria) && sel16k.acceptance_criteria.length >= 4);
ok('F66 16K retention still open; deploy partial via 16P',
  /live_deploy|privacy_drill|retention/i.test(String(sel16k.does_not_implement || ''))
  && /live_proven|open/i.test(String(contract.healthz_live_deploy || ''))
  && /partial|open/i.test(String(contract.healthz_privacy_drill || ''))
  && /open/i.test(String(contract.healthz_log_retention || '')));

const g06 = matrix.gates.find((g) => g.id === 'G06_scaling_capacity');
ok('F67 G06 partial_live_proven via 16AF capacity deploy + 16L source (+ 16AG harness source)',
  g06 && g06.verdict === 'partial'
  && g06.progress_class === 'partial_live_proven'
  && /16AF/.test(g06.rationale)
  && /16AG|16AH|16AI/.test(g06.rationale)
  && /16L/.test(g06.rationale)
  && /CpuPercentage/i.test(g06.rationale)
  && /MemoryPercentage/i.test(g06.rationale)
  && Array.isArray(g06.gaps)
  && !g06.gaps.some((g) => /Capacity-pressure alerts not deployed/i.test(String(g)))
  && g06.gaps.some((g) => /fir|notification/i.test(String(g)))
  && g06.gaps.some((g) => /load|soak/i.test(String(g)))
  && g06.gaps.some((g) => /autoscal/i.test(String(g)))
  && g06.gaps.some((g) => /SLO|error.?budget|backpressure/i.test(String(g))));
ok('F68 16L verifier script present',
  pathExists('scripts/verify-radar-slice16l-staff-api-capacity-alerts.js'));
ok('F69 capacity plan + contract fixtures present',
  pathExists('fixtures/radar-operations/slice16l-capacity-alert-plan.json')
  && pathExists('fixtures/radar-operations/slice16l-expected-contract.json'));

const sel16l = matrix.slice_16l_selection;
ok('F70 exactly one 16L selection',
  sel16l && sel16l.selected === true
  && sel16l.outcome_id === '16L_staff_api_capacity_pressure_alerts'
  && sel16l.gate_id === 'G06_scaling_capacity'
  && sel16l.progress_class === 'source_partial_progress_only');
ok('F71 contract selected_16l matches',
  contract.selected_16l
  && contract.selected_16l.outcome_id === '16L_staff_api_capacity_pressure_alerts'
  && contract.selected_16l.gate_id === 'G06_scaling_capacity');
ok('F72 16L final controlled drill present',
  sel16l.final_controlled_drill
  && sel16l.final_controlled_drill.id === '16L_DRILL_capacity_pressure_alert_fire');
ok('F73 16L acceptance criteria finite (>=4)',
  Array.isArray(sel16l.acceptance_criteria) && sel16l.acceptance_criteria.length >= 4);
ok('F74 16L source leaves fire/load/SLO/backpressure open; deploy closed via 16AF',
  /live_deploy/.test(String(sel16l.does_not_implement || ''))
  && /backpressure/i.test(String(sel16l.does_not_implement || ''))
  && /live_proven_via_16AF/i.test(String(contract.capacity_live_deploy || ''))
  && /open/i.test(String(contract.capacity_alert_fire || ''))
  && /open/i.test(String(contract.capacity_backpressure || ''))
  && /open/i.test(String(contract.capacity_slo || ''))
  && /open/i.test(String(contract.capacity_load_proof || '')));
ok('F75 doc mentions G06 capacity-pressure',
  /G06/.test(doc) && /capacity-pressure|CpuPercentage/i.test(doc));

const g05 = matrix.gates.find((g) => g.id === 'G05_retry_replay_safety');
ok('F76 G05 partial source-partial via 16M',
  g05 && g05.verdict === 'partial'
  && g05.progress_class === 'source_partial_progress_only'
  && /16M/.test(g05.rationale)
  && /stripe_event_id|event-id claim|event_id claim/i.test(g05.rationale));
ok('F77 16M claim lib present', pathExists('scripts/lib/stripe-webhook-event-claim.js'));
ok('F78 16M verifier script present',
  pathExists('scripts/verify-radar-slice16m-stripe-event-claim.js'));
ok('F79 16M contract fixture present',
  pathExists('fixtures/radar-operations/slice16m-expected-contract.json'));

const sel16m = matrix.slice_16m_selection;
ok('F80 exactly one 16M selection',
  sel16m && sel16m.selected === true
  && sel16m.outcome_id === '16M_stripe_webhook_event_id_claim'
  && sel16m.gate_id === 'G05_retry_replay_safety'
  && sel16m.progress_class === 'source_partial_progress_only');
ok('F81 contract selected_16m matches',
  contract.selected_16m
  && contract.selected_16m.outcome_id === '16M_stripe_webhook_event_id_claim'
  && contract.selected_16m.gate_id === 'G05_retry_replay_safety');
ok('F82 16M final controlled drill present',
  sel16m.final_controlled_drill
  && sel16m.final_controlled_drill.id === '16M_DRILL_stripe_event_claim_replay');
ok('F83 16M acceptance criteria finite (>=4)',
  Array.isArray(sel16m.acceptance_criteria) && sel16m.acceptance_criteria.length >= 4);
ok('F84 16M leaves deploy/concurrency/replay/DLQ/drill open',
  /live_deploy/.test(String(sel16m.does_not_implement || ''))
  && /open/i.test(String(contract.stripe_event_claim_live_deploy || ''))
  && /open/i.test(String(contract.stripe_event_claim_dlq || ''))
  && /open/i.test(String(contract.stripe_event_claim_drill || '')));
ok('F85 doc mentions G05 event-id claim',
  /G05/.test(doc) && /event-id claim|stripe_event_id/i.test(doc));

ok('F86 G08 partial includes 16O webhook error minimization',
  g08 && /16O/.test(g08.rationale)
  && /invalid_stripe_signature|stripe_webhook_unavailable/i.test(g08.rationale));
ok('F87 16O public-errors lib present',
  pathExists('scripts/lib/stripe-webhook-public-errors.js'));
ok('F88 16O verifier script present',
  pathExists('scripts/verify-radar-slice16o-stripe-webhook-error-minimization.js'));
ok('F89 16O contract fixture present',
  pathExists('fixtures/radar-operations/slice16o-expected-contract.json'));

const sel16o = matrix.slice_16o_selection;
ok('F90 exactly one 16O selection retained',
  sel16o && sel16o.selected === true
  && sel16o.outcome_id === '16O_stripe_webhook_error_minimization'
  && sel16o.gate_id === 'G08_retention_privacy');
ok('F91 contract selected_16o matches',
  contract.selected_16o
  && contract.selected_16o.outcome_id === '16O_stripe_webhook_error_minimization'
  && contract.selected_16o.gate_id === 'G08_retention_privacy');
ok('F92 16O final controlled drill present',
  sel16o.final_controlled_drill
  && sel16o.final_controlled_drill.id === '16O_DRILL_stripe_webhook_error_privacy_live_prove');
ok('F93 16O acceptance criteria finite (>=4)',
  Array.isArray(sel16o.acceptance_criteria) && sel16o.acceptance_criteria.length >= 4);
ok('F94 16O deploy live-proven via 16P; privacy partial; abrupt/retention open',
  /abrupt|retention|privacy/i.test(String(sel16o.does_not_implement || ''))
  && /live_proven/i.test(String(contract.stripe_webhook_error_live_deploy || ''))
  && /partial/i.test(String(contract.stripe_webhook_error_privacy_drill || '')));
ok('F95 doc mentions G08 webhook error minimization',
  /G08/.test(doc) && /webhook error|invalid_stripe_signature|stripe_webhook_unavailable|malformed|oversize/i.test(doc));

const sel16p = matrix.slice_16p_selection;
ok('F96 exactly one 16P selection',
  sel16p && sel16p.selected === true
  && sel16p.outcome_id === '16P_live_drill_evidence_reconciliation'
  && sel16p.progress_class === 'partial_live_proven_evidence_only');
ok('F97 contract selected_16p matches',
  contract.selected_16p
  && contract.selected_16p.outcome_id === '16P_live_drill_evidence_reconciliation');
ok('F98 16P evidence fixture present',
  pathExists('fixtures/radar-operations/slice16p-live-drill-evidence.json')
  && pathExists('fixtures/radar-operations/slice16p-expected-contract.json'));
ok('F99 16P verifier present',
  pathExists('scripts/verify-radar-slice16p-live-drill-evidence.js'));
ok('F100 16P final controlled drill present',
  sel16p.final_controlled_drill
  && sel16p.final_controlled_drill.id === '16P_DRILL_evidence_freeze_no_overclaim');
ok('F101 16P acceptance criteria finite (>=4)',
  Array.isArray(sel16p.acceptance_criteria) && sel16p.acceptance_criteria.length >= 4);
ok('F102 16P explicitly does not claim inbox/organic/production/abrupt/retention/dep/pg/completion',
  /human_inbox|organic_alert|production|abrupt|retention_search|dependency_failure|real_pg|completion_logging/i.test(
    String(sel16p.does_not_implement || '')));
ok('F103 G07 partial_live_proven via 16P rollback/rollforward',
  (() => {
    const g07 = matrix.gates.find((g) => g.id === 'G07_rollback_incident_runbooks');
    return g07 && g07.verdict === 'partial' && g07.progress_class === 'partial_live_proven'
      && /0000515|0000516|rollforward|594247f/i.test(g07.rationale);
  })());
ok('F104 G05 remains not partial_live_proven; G06 is partial_live_proven via 16AF',
  matrix.gates.filter((g) => g.id === 'G05_retry_replay_safety')
    .every((g) => g.progress_class !== 'partial_live_proven')
  && matrix.gates.filter((g) => g.id === 'G06_scaling_capacity')
    .every((g) => g.progress_class === 'partial_live_proven'));
ok('F105 doc forbids overclaims',
  /human inbox/i.test(doc) && /organic metric|end-to-end/i.test(doc) && /not claim/i.test(doc));

const sel16s = matrix.slice_16s_selection;
ok('F106 exactly one 16S selection',
  sel16s && sel16s.selected === true
  && sel16s.outcome_id === '16S_request_completion_log_live_evidence'
  && sel16s.gate_id === 'G01_correlation_structured_logs');
ok('F107 contract selected_16s matches',
  contract.selected_16s
  && contract.selected_16s.outcome_id === '16S_request_completion_log_live_evidence');
ok('F108 16S evidence fixture present',
  pathExists('fixtures/radar-operations/slice16s-request-log-live-evidence.json')
  && pathExists('fixtures/radar-operations/slice16s-expected-contract.json'));
ok('F109 16S verifier present',
  pathExists('scripts/verify-radar-slice16s-request-log-live-evidence.js'));
ok('F110 16S final controlled drill present',
  sel16s.final_controlled_drill
  && sel16s.final_controlled_drill.id === '16S_DRILL_completion_log_delivery_search_retention');
ok('F111 16S acceptance criteria finite (>=4)',
  Array.isArray(sel16s.acceptance_criteria) && sel16s.acceptance_criteria.length >= 4);
ok('F112 16S explicitly does not claim E2E/proven/G02-G09 changes',
  /e2e|meta_hermes|any_gate_proven|concurrent|abort/i.test(String(sel16s.does_not_implement || '')));
ok('F113 correlation delivery/search/retention live via 16S; G01-A drill open',
  contract.correlation_delivery_proof === 'live_proven_via_16S'
  && contract.correlation_search_proof === 'live_proven_via_16S'
  && /live_proven_via_16S/.test(String(contract.correlation_retention || ''))
  && /open|g01a/i.test(String(contract.correlation_drill || '')));

const sel16u = matrix.slice_16u_selection;
ok('F114 exactly one 16U selection',
  sel16u && sel16u.selected === true
  && sel16u.outcome_id === '16U_correlation_design_freeze'
  && sel16u.gate_id === 'G01_correlation_structured_logs'
  && sel16u.progress_class === 'audit_only_design_freeze');
ok('F115 contract selected_16u matches',
  contract.selected_16u
  && contract.selected_16u.outcome_id === '16U_correlation_design_freeze'
  && contract.correlation_drill_design === 'frozen_via_16U');
ok('F116 16U call graph + design fixtures present',
  pathExists('fixtures/radar-operations/slice16u-call-graph.json')
  && pathExists('fixtures/radar-operations/slice16u-correlation-design-freeze.json')
  && pathExists('fixtures/radar-operations/slice16u-expected-contract.json'));
ok('F117 16U verifier present',
  pathExists('scripts/lib/radar-slice16u-correlation-design-freeze.js')
  && pathExists('scripts/verify-radar-slice16u-correlation-design-freeze.js'));
ok('F118 16U final controlled drill present',
  sel16u.final_controlled_drill
  && sel16u.final_controlled_drill.id === '16U_DRILL_design_freeze_reject_independent_probes');
ok('F119 16U acceptance criteria finite (>=4)',
  Array.isArray(sel16u.acceptance_criteria) && sel16u.acceptance_criteria.length >= 4);
ok('F120 16U does not implement runtime/live',
  /runtime|live|any_gate_proven/i.test(String(sel16u.does_not_implement || '')));
ok('F121 doc rejects independent same-ID probes as E2E',
  /independent same-id|same-ID probe/i.test(doc));
ok('F122 doc states Stripe cannot without mutation',
  /cannot be exercised without mutation/i.test(doc));
ok('F123 no 16T harness on this tip',
  !pathExists('scripts/run-radar-slice16t-e2e-correlation-drill.js')
  && !pathExists('scripts/lib/radar-slice16t-e2e-correlation-drill.js'));

const sel16w = matrix.slice_16w_selection;
ok('F124 exactly one 16W selection',
  sel16w && sel16w.selected === true
  && sel16w.outcome_id === '16W_readiness_shutdown_lifecycle'
  && sel16w.gate_id === 'G02_readiness_dependencies'
  && sel16w.progress_class === 'source_partial_progress_only');
ok('F125 contract selected_16w matches (drill closed via 16X)',
  contract.selected_16w
  && contract.selected_16w.outcome_id === '16W_readiness_shutdown_lifecycle'
  && contract.selected_16w.g02_lifecycle_source === 'closed_via_16W'
  && contract.selected_16w.g02_dependency_failure_drill === 'live_proven_via_16X');
ok('F126 16W fixtures + verifier present',
  pathExists('fixtures/radar-operations/slice16w-expected-contract.json')
  && pathExists('scripts/lib/radar-slice16w-readiness-shutdown-lifecycle.js')
  && pathExists('scripts/verify-radar-slice16w-readiness-shutdown-lifecycle.js')
  && pathExists('scripts/lib/staff-api-readiness-lifecycle.js'));
ok('F127 16W final controlled drill references 16I_DRILL live_proven via 16X',
  sel16w.final_controlled_drill
  && sel16w.final_controlled_drill.id === '16I_DRILL_readiness_failure_traffic_shed'
  && /live_proven_via_16X/i.test(String(sel16w.final_controlled_drill.status)));
ok('F128 16W does not claim deploy/probes/SQL/production',
  /readyz_sql|probes|production|controlled_dependency_failure/i.test(String(sel16w.does_not_implement || '')));
ok('F129 doc mentions 16X + G02 partial + traffic shed; SIGTERM live open',
  /16X|g02.?live.?evidence/i.test(doc)
  && /G02.*partial|partial.*G02/i.test(doc)
  && /traffic.?shed|g02fail|Activating/i.test(doc)
  && /SIGTERM|lifecycle.?live/i.test(doc));

const sel16x = matrix.slice_16x_selection;
ok('F130 exactly one 16X selection',
  sel16x && sel16x.selected === true
  && sel16x.outcome_id === '16X_g02_lifecycle_deploy_traffic_shed_live_evidence'
  && sel16x.gate_id === 'G02_readiness_dependencies'
  && sel16x.progress_class === 'partial_live_proven_evidence_only');
ok('F131 contract selected_16x matches',
  contract.selected_16x
  && contract.selected_16x.outcome_id === '16X_g02_lifecycle_deploy_traffic_shed_live_evidence'
  && contract.selected_16x.g02_dependency_failure_drill === 'live_proven_via_16X'
  && contract.selected_16x.g02_lifecycle_deploy === 'live_proven_via_16X'
  && contract.selected_16x.g02_sigterm_live === 'live_proven_via_16Z'
  && contract.selected_16x.g02_sigint_live === 'live_proven_via_16AA'
  && contract.selected_16x.g02_verdict === 'partial');
ok('F132 16X fixtures + verifier present',
  pathExists('fixtures/radar-operations/slice16x-g02-live-evidence.json')
  && pathExists('fixtures/radar-operations/slice16x-expected-contract.json')
  && pathExists('scripts/lib/radar-slice16x-g02-live-evidence.js')
  && pathExists('scripts/verify-radar-slice16x-g02-live-evidence.js'));
ok('F133 16X acceptance criteria finite (>=4)',
  Array.isArray(sel16x.acceptance_criteria) && sel16x.acceptance_criteria.length >= 4);
ok('F134 16X explicitly does not claim SIGTERM live / full G02 / production',
  /sigterm|organic|production|full_g02|readyz_503/i.test(String(sel16x.does_not_implement || '')));
ok('F135 16I matrix drill status live_proven via 16X',
  sel16i.final_controlled_drill
  && /live_proven_via_16X/i.test(String(sel16i.final_controlled_drill.status)));

const sel16y = matrix.slice_16y_selection;
ok('F136 exactly one 16Y selection',
  sel16y && sel16y.selected === true
  && sel16y.outcome_id === '16Y_readiness_shutdown_completion_log'
  && sel16y.gate_id === 'G02_readiness_dependencies'
  && sel16y.progress_class === 'source_partial_progress_only');
ok('F137 contract selected_16y matches (SIGTERM live closed via 16Z)',
  contract.selected_16y
  && contract.selected_16y.outcome_id === '16Y_readiness_shutdown_completion_log'
  && contract.selected_16y.g02_shutdown_completion_log === 'closed_via_16Y'
  && contract.selected_16y.g02_sigterm_live === 'live_proven_via_16Z'
  && contract.selected_16y.g02_sigint_live === 'live_proven_via_16AA'
  && contract.selected_16y.g02_verdict === 'partial');
ok('F138 16Y fixtures + verifier present',
  pathExists('fixtures/radar-operations/slice16y-expected-contract.json')
  && pathExists('scripts/lib/radar-slice16y-shutdown-completion-log.js')
  && pathExists('scripts/verify-radar-slice16y-shutdown-completion-log.js')
  && pathExists('scripts/lib/staff-api-readiness-shutdown-completion-log.js'));
ok('F139 16Y final controlled drill live_proven via 16Z',
  sel16y.final_controlled_drill
  && sel16y.final_controlled_drill.id === '16Y_DRILL_live_sigterm_completion_log_evidence'
  && /live_proven_via_16Z/i.test(String(sel16y.final_controlled_drill.status)));
ok('F140 16Y does not claim deploy/probes/SQL/production',
  /readyz_sql|probes|production|sigterm_live/i.test(String(sel16y.does_not_implement || '')));
ok('F141 doc mentions 16Y + G02 partial; SIGTERM via 16Z',
  /16Y|shutdown.?completion/i.test(doc)
  && /G02.*partial|partial.*G02/i.test(doc)
  && /SIGTERM|lifecycle.?live/i.test(doc));

const sel16z = matrix.slice_16z_selection;
ok('F142 exactly one 16Z selection',
  sel16z && sel16z.selected === true
  && sel16z.outcome_id === '16Z_g02_live_sigterm_lifecycle_evidence'
  && sel16z.gate_id === 'G02_readiness_dependencies'
  && sel16z.progress_class === 'partial_live_proven_evidence_only');
ok('F143 contract selected_16z matches',
  contract.selected_16z
  && contract.selected_16z.outcome_id === '16Z_g02_live_sigterm_lifecycle_evidence'
  && contract.selected_16z.g02_sigterm_live === 'live_proven_via_16Z'
  && contract.selected_16z.g02_sigint_live === 'live_proven_via_16AA'
  && contract.selected_16z.g02_verdict === 'partial');
ok('F144 16Z fixtures + verifier present',
  pathExists('fixtures/radar-operations/slice16z-expected-contract.json')
  && pathExists('fixtures/radar-operations/slice16z-g02-live-sigterm-evidence.json')
  && pathExists('scripts/lib/radar-slice16z-g02-live-sigterm-evidence.js')
  && pathExists('scripts/verify-radar-slice16z-g02-live-sigterm-evidence.js'));
ok('F145 16Z final controlled drill live_proven',
  sel16z.final_controlled_drill
  && /live_proven_via_16Z/i.test(String(sel16z.final_controlled_drill.status)));
ok('F146 16Z does not claim SIGINT/readyz=503/zero-downtime/production/full G02',
  /sigint|readyz_503|zero_downtime|production|full_g02/i.test(String(sel16z.does_not_implement || '')));
ok('F147 doc mentions 16Z + G02 partial; readyz=503 or zero-downtime still open',
  /16Z|live.?sigterm/i.test(doc)
  && /G02.*partial|partial.*G02/i.test(doc)
  && /zero.?downtime|readyz.?503/i.test(doc));

ok('F148 contract selected_16z retains SIGTERM and gains SIGINT via 16AA',
  contract.selected_16z
  && contract.selected_16z.outcome_id === '16Z_g02_live_sigterm_lifecycle_evidence'
  && contract.selected_16z.g02_sigterm_live === 'live_proven_via_16Z'
  && contract.selected_16z.g02_sigint_live === 'live_proven_via_16AA'
  && contract.selected_16z.g02_verdict === 'partial');

const sel16aa = matrix.slice_16aa_selection;
ok('F149 exactly one 16AA selection',
  sel16aa && sel16aa.selected === true
  && sel16aa.outcome_id === '16AA_g02_live_sigint_lifecycle_evidence'
  && sel16aa.gate_id === 'G02_readiness_dependencies'
  && sel16aa.progress_class === 'partial_live_proven_evidence_only');
ok('F150 contract selected_16aa matches',
  contract.selected_16aa
  && contract.selected_16aa.outcome_id === '16AA_g02_live_sigint_lifecycle_evidence'
  && contract.selected_16aa.g02_sigint_live === 'live_proven_via_16AA'
  && contract.selected_16aa.g02_sigterm_live === 'live_proven_via_16Z'
  && contract.selected_16aa.g02_verdict === 'partial');
ok('F151 16AA fixtures + verifier present',
  pathExists('fixtures/radar-operations/slice16aa-expected-contract.json')
  && pathExists('fixtures/radar-operations/slice16aa-g02-live-sigint-evidence.json')
  && pathExists('scripts/lib/radar-slice16aa-g02-live-sigint-evidence.js')
  && pathExists('scripts/verify-radar-slice16aa-g02-live-sigint-evidence.js'));
ok('F152 16AA final controlled drill live_proven',
  sel16aa.final_controlled_drill
  && /live_proven_via_16AA/i.test(String(sel16aa.final_controlled_drill.status)));
ok('F153 16AA does not claim readyz=503/zero-downtime/production/full G02',
  /readyz_503|zero_downtime|production|full_g02/i.test(String(sel16aa.does_not_implement || '')));
ok('F154 doc mentions 16AA + G02 partial; exit137/SIGINT retained',
  /16AA|live.?sigint/i.test(doc)
  && /G02.*partial|partial.*G02/i.test(doc)
  && /zero.?downtime|readyz.?503/i.test(doc)
  && /exit\s*137|ClusterExecFailure|kill -INT/i.test(doc));

const sel16ab = matrix.slice_16ab_selection;
ok('F155 exactly one 16AB selection',
  sel16ab && sel16ab.selected === true
  && sel16ab.outcome_id === '16AB_g02_serving_readyz_503_body_path_evidence'
  && sel16ab.gate_id === 'G02_readiness_dependencies'
  && sel16ab.progress_class === 'partial_live_proven_evidence_only');
ok('F156 contract selected_16ab matches',
  contract.selected_16ab
  && contract.selected_16ab.outcome_id === '16AB_g02_serving_readyz_503_body_path_evidence'
  && contract.selected_16ab.g02_serving_readyz_503_live === 'live_proven_via_16AB'
  && contract.selected_16ab.g02_sigint_live === 'live_proven_via_16AA'
  && contract.selected_16ab.g02_sigterm_live === 'live_proven_via_16Z'
  && contract.selected_16ab.g02_verdict === 'partial');
ok('F157 16AB fixtures + verifier present',
  pathExists('fixtures/radar-operations/slice16ab-expected-contract.json')
  && pathExists('fixtures/radar-operations/slice16ab-g02-readyz503-evidence.json')
  && pathExists('scripts/lib/radar-slice16ab-g02-readyz503-evidence.js')
  && pathExists('scripts/verify-radar-slice16ab-g02-readyz503-evidence.js'));
ok('F158 16AB final controlled drill live_proven',
  sel16ab.final_controlled_drill
  && /live_proven_via_16AB/i.test(String(sel16ab.final_controlled_drill.status)));
ok('F159 16AB does not claim zero-downtime/organic-alerts/production/full G02',
  /zero_downtime|organic|production|full_g02/i.test(String(sel16ab.does_not_implement || '')));
ok('F160 doc mentions 16AB + readyz=503 + unavailable_in_command_transcript; G02 partial; Azure cannot recreate historical 503',
  /16AB|readyz.?503|g02503/i.test(doc)
  && /G02.*partial|partial.*G02/i.test(doc)
  && /unavailable_in_command_transcript/i.test(doc)
  && /cannot recreate|not Azure-reconstructible/i.test(doc)
  && /zero.?downtime/i.test(doc));

const sel16ac = matrix.slice_16ac_selection;
ok('F161 exactly one 16AC selection',
  sel16ac && sel16ac.selected === true
  && sel16ac.outcome_id === '16AC_organic_restart_alert_evidence'
  && sel16ac.progress_class === 'partial_live_proven_evidence_only'
  && Array.isArray(sel16ac.gate_ids)
  && sel16ac.gate_ids.includes('G02_readiness_dependencies')
  && sel16ac.gate_ids.includes('G03_actionable_tenant_aware_alerts'));
ok('F162 contract selected_16ac matches',
  contract.selected_16ac
  && contract.selected_16ac.outcome_id === '16AC_organic_restart_alert_evidence'
  && contract.selected_16ac.g02_organic_restart_alert === 'live_proven_via_16AC'
  && contract.selected_16ac.g03_organic_restart_alert === 'live_proven_via_16AC'
  && contract.selected_16ac.g02_verdict === 'partial'
  && contract.selected_16ac.g03_verdict === 'partial'
  && contract.selected_16ac.g03_human_inbox_receipt === 'open');
ok('F163 16AC fixtures + verifier present',
  pathExists('fixtures/radar-operations/slice16ac-expected-contract.json')
  && pathExists('fixtures/radar-operations/slice16ac-organic-restart-alert-evidence.json')
  && pathExists('scripts/lib/radar-slice16ac-organic-restart-alert-evidence.js')
  && pathExists('scripts/verify-radar-slice16ac-organic-restart-alert-evidence.js'));
ok('F164 16AC final controlled drill live_proven',
  sel16ac.final_controlled_drill
  && /live_proven_via_16AC/i.test(String(sel16ac.final_controlled_drill.status)));
ok('F165 16AC does not claim inbox/unique-causality/5xx/zero-downtime/production/full gates',
  /inbox|unique_causality|5xx|zero_downtime|production|full_g02|full_g03/i.test(
    String(sel16ac.does_not_implement || ''),
  ));
ok('F166 doc mentions 16AC + organic restart + inbox open + G02/G03 partial',
  /16AC|organic.?restart/i.test(doc)
  && /G02.*partial|partial.*G02/i.test(doc)
  && /G03.*partial|partial.*G03/i.test(doc)
  && /inbox/i.test(doc)
  && /isSuppressed|unsuppressed/i.test(doc)
  && !/\bG02\s+proven\b/i.test(doc)
  && !/\bG03\s+proven\b/i.test(doc));

const sel16ad = matrix.slice_16ad_selection;
ok('F167 exactly one 16AD selection',
  sel16ad && sel16ad.selected === true
  && sel16ad.outcome_id === '16AD_g02_sampled_restart_continuity_evidence'
  && sel16ad.gate_id === 'G02_readiness_dependencies'
  && sel16ad.progress_class === 'partial_live_proven_evidence_only');
ok('F168 contract selected_16ad matches',
  contract.selected_16ad
  && contract.selected_16ad.outcome_id === '16AD_g02_sampled_restart_continuity_evidence'
  && contract.selected_16ad.g02_sampled_restart_continuity === 'live_proven_via_16AD'
  && contract.selected_16ad.g02_verdict === 'partial'
  && contract.selected_16ad.g02_absolute_zero_downtime === 'open'
  && contract.selected_16ad.g02_production === 'open');
ok('F169 16AD fixtures + verifier present',
  pathExists('fixtures/radar-operations/slice16ad-expected-contract.json')
  && pathExists('fixtures/radar-operations/slice16ad-g02-sampled-restart-continuity-evidence.json')
  && pathExists('scripts/lib/radar-slice16ad-g02-sampled-restart-continuity-evidence.js')
  && pathExists('scripts/verify-radar-slice16ad-g02-sampled-restart-continuity-evidence.js'));
ok('F170 16AD final controlled drill live_proven',
  sel16ad.final_controlled_drill
  && /live_proven_via_16AD/i.test(String(sel16ad.final_controlled_drill.status)));
ok('F171 16AD does not claim absolute zero-downtime/cold-start/all-91/production/full G02',
  /absolute|cold_start|production|full_g02|between_sample/i.test(String(sel16ad.does_not_implement || '')));
ok('F172 doc mentions 16AD + warmup disclosure + sampling-resolution claim; G02 partial',
  /16AD|sampled.?restart|concurrent.?sampled/i.test(doc)
  && /warmup|0\.\.2|samples 0..2/i.test(doc)
  && /sampling resolution|not absolute|not claim.*absolute/i.test(doc)
  && /G02.*partial|partial.*G02/i.test(doc)
  && !/\bG02\s+proven\b/i.test(doc));


const sel16af = matrix.slice_16af_selection;
ok('F173 exactly one 16AF selection',
  sel16af && sel16af.selected === true
  && sel16af.outcome_id === '16AF_g06_capacity_alert_live_evidence'
  && sel16af.gate_id === 'G06_scaling_capacity'
  && sel16af.progress_class === 'partial_live_proven_evidence_only');
ok('F174 contract selected_16af matches',
  contract.selected_16af
  && contract.selected_16af.outcome_id === '16AF_g06_capacity_alert_live_evidence'
  && contract.selected_16af.g06_capacity_alert_deploy === 'live_proven_via_16AF'
  && contract.selected_16af.g06_verdict === 'partial'
  && contract.selected_16af.g06_capacity_alert_fire === 'open'
  && contract.selected_16af.g06_autoscaling === 'open'
  && contract.selected_16af.g06_backpressure === 'open');
ok('F175 16AF fixtures + verifier present',
  pathExists('fixtures/radar-operations/slice16af-expected-contract.json')
  && pathExists('fixtures/radar-operations/slice16af-g06-capacity-alert-live-evidence.json')
  && pathExists('scripts/lib/radar-slice16af-g06-capacity-alert-live-evidence.js')
  && pathExists('scripts/verify-radar-slice16af-g06-capacity-alert-live-evidence.js'));
ok('F176 16AF final controlled drill live_proven deploy readback',
  sel16af.final_controlled_drill
  && /live_proven_via_16AF/i.test(String(sel16af.final_controlled_drill.status)));
ok('F177 16AF does not claim fire/notification/load/autoscale/SLO/backpressure/production/full G06',
  /fire|notification|load|autoscale|slo|backpressure|production|full_g06/i.test(
    String(sel16af.does_not_implement || '')));
ok('F178 doc mentions 16AF + capacity deploy + G06 partial + open firing/autoscale',
  /16AF|capacity.?alert.?live/i.test(doc)
  && /G06.*partial|partial.*G06/i.test(doc)
  && /fir|notification/i.test(doc)
  && /autoscal|load|soak|SLO|backpressure/i.test(doc)
  && !/\bG06\s+proven\b/i.test(doc));


const sel16ag = matrix.slice_16ag_selection;
ok('F179 exactly one 16AG selection',
  sel16ag && sel16ag.selected === true
  && sel16ag.outcome_id === '16AG_g06_bounded_load_harness'
  && sel16ag.gate_id === 'G06_scaling_capacity'
  && sel16ag.progress_class === 'source_partial_progress_only');
ok('F180 contract selected_16ag matches',
  contract.selected_16ag
  && contract.selected_16ag.outcome_id === '16AG_g06_bounded_load_harness'
  && contract.selected_16ag.g06_load_harness_source === 'source_closed_via_16AG'
  && contract.selected_16ag.g06_load_proof === 'open'
  && contract.selected_16ag.g06_verdict === 'partial'
  && contract.selected_16ag.g06_autoscaling === 'open'
  && contract.selected_16ag.g06_backpressure === 'open');
ok('F181 16AG fixtures + harness + verifier present',
  pathExists('fixtures/radar-operations/slice16ag-expected-contract.json')
  && pathExists('scripts/lib/radar-g06-bounded-load-harness.js')
  && pathExists('scripts/lib/radar-slice16ag-g06-bounded-load-harness.js')
  && pathExists('scripts/verify-radar-slice16ag-g06-bounded-load-harness.js'));
ok('F182 16AG final controlled drill defined_not_executed',
  sel16ag.final_controlled_drill
  && sel16ag.final_controlled_drill.status === 'defined_not_executed');
ok('F183 16AG does not claim live load/soak/SLO/backpressure/autoscale/fire/production/full G06',
  /live_load|soak|autoscale|slo|backpressure|fire|notification|production|full_g06/i.test(
    String(sel16ag.does_not_implement || '')));
ok('F184 doc mentions 16AG + bounded load harness + defined_not_executed + G06 partial',
  /16AG|bounded.?load.?harness/i.test(doc)
  && /defined.?not.?executed|not executed|attempted_not_proof/i.test(doc)
  && /G06.*partial|partial.*G06/i.test(doc)
  && !/\bG06\s+proven\b/i.test(doc)
  && !/\bload\s+soak\s+proven\b/i.test(doc));
ok('F185 score unchanged after 16AG (proven=0 partial=9 absent=0)',
  contract.expected_verdict_counts.proven === 0
  && contract.expected_verdict_counts.partial === 9
  && contract.expected_verdict_counts.absent === 0);


const sel16ah = matrix.slice_16ah_selection;
ok('F186 exactly one 16AH selection',
  sel16ah && sel16ah.selected === true
  && sel16ah.outcome_id === '16AH_g06_live_load_correction'
  && sel16ah.gate_id === 'G06_scaling_capacity'
  && sel16ah.progress_class === 'source_partial_progress_only'
  && sel16ah.live_load_attempt
  && sel16ah.live_load_attempt.status === 'attempted_not_proof');
ok('F187 contract selected_16ah matches',
  contract.selected_16ah
  && contract.selected_16ah.outcome_id === '16AH_g06_live_load_correction'
  && contract.selected_16ah.g06_load_proof === 'open'
  && contract.selected_16ah.live_load_attempt_status === 'attempted_not_proof'
  && contract.selected_16ah.pinned_lookup_all_true === 'corrected'
  && contract.selected_16ah.g06_verdict === 'partial');
ok('F188 16AH fixtures + verifier present',
  pathExists('fixtures/radar-operations/slice16ah-expected-contract.json')
  && pathExists('scripts/lib/radar-slice16ah-g06-live-load-correction.js')
  && pathExists('scripts/verify-radar-slice16ah-g06-live-load-correction.js')
  && pathExists('scripts/lib/radar-g06-bounded-load-harness.js'));
ok('F189 16AH does not claim live load success / G06 proven',
  /live_load|soak|autoscale|slo|backpressure|fire|notification|production|full_g06/i.test(
    String(sel16ah.does_not_implement || ''))
  && !/\bG06\s+proven\b/i.test(doc)
  && !/\bload\s+soak\s+proven\b/i.test(doc)
  && /attempted_not_proof/i.test(doc)
  && /attempted_not_proof/i.test(findings)
  && /16AH|pinned.?lookup|all=true/i.test(doc));
ok('F190 score unchanged after 16AH (proven=0 partial=9 absent=0)',
  contract.expected_verdict_counts.proven === 0
  && contract.expected_verdict_counts.partial === 9
  && contract.expected_verdict_counts.absent === 0);

const sel16ai = matrix.slice_16ai_selection;
ok('F191 exactly one 16AI selection',
  sel16ai && sel16ai.selected === true
  && sel16ai.outcome_id === '16AI_g06_live_load_evidence'
  && sel16ai.gate_id === 'G06_scaling_capacity'
  && sel16ai.progress_class === 'partial_live_proven_evidence_only'
  && sel16ai.final_controlled_drill
  && sel16ai.final_controlled_drill.status === 'live_proven'
  && sel16ai.g06_conservative_readyz_bounded_load === 'live_proven_via_16AI'
  && sel16ai.g06_load_soak === 'open');
ok('F192 contract selected_16ai matches',
  contract.selected_16ai
  && contract.selected_16ai.outcome_id === '16AI_g06_live_load_evidence'
  && contract.selected_16ai.g06_conservative_readyz_bounded_load === 'live_proven_via_16AI'
  && contract.selected_16ai.g06_load_soak === 'open'
  && contract.selected_16ai.final_controlled_drill_status === 'live_proven'
  && contract.selected_16ai.g06_verdict === 'partial'
  && contract.conservative_readyz_bounded_load === 'live_proven_via_16AI'
  && contract.load_soak === 'open'
  && contract.load_proof === 'open');
ok('F193 16AI fixtures + verifier present',
  pathExists('fixtures/radar-operations/slice16ai-g06-live-load-evidence.json')
  && pathExists('fixtures/radar-operations/slice16ai-expected-contract.json')
  && pathExists('fixtures/radar-operations/slice16ai-raw-drill.json')
  && pathExists('fixtures/radar-operations/slice16ai-raw-cost-before.json')
  && pathExists('fixtures/radar-operations/slice16ai-raw-cost-after.json')
  && pathExists('scripts/lib/radar-slice16ai-g06-live-load-evidence.js')
  && pathExists('scripts/verify-radar-slice16ai-g06-live-load-evidence.js'));
ok('F194 16AI does not claim soak / fire / autoscale / SLO / backpressure / production / full G06',
  /load_soak|soak|autoscale|slo|backpressure|fire|notification|production|full_g06/i.test(
    String(sel16ai.does_not_implement || ''))
  && !/\bG06\s+proven\b/i.test(doc)
  && !/\bload\s+soak\s+proven\b/i.test(doc)
  && !/\bfull\s+G06\b/i.test(doc)
  && /16AI|conservative|live_proven/i.test(doc)
  && /live_proven/i.test(findings));
ok('F195 score unchanged after 16AI (proven=0 partial=9 absent=0)',
  contract.expected_verdict_counts.proven === 0
  && contract.expected_verdict_counts.partial === 9
  && contract.expected_verdict_counts.absent === 0
  && MASTER_BASIS_16AI === 'd04b633390bdcacfe3a04eed4796bba4184e29f8');

const sel16aj = matrix.slice_16aj_selection;
ok('F196 exactly one 16AJ selection',
  sel16aj && sel16aj.selected === true
  && sel16aj.outcome_id === '16AJ_g06_slo_error_budget_source'
  && sel16aj.gate_id === 'G06_scaling_capacity'
  && sel16aj.progress_class === 'source_partial_progress_only'
  && sel16aj.final_controlled_drill
  && sel16aj.final_controlled_drill.status === 'offline_source_proven'
  && sel16aj.g06_slo_source === 'source_defined_via_16AJ'
  && sel16aj.g06_slo === 'open');
ok('F197 contract selected_16aj matches',
  contract.selected_16aj
  && contract.selected_16aj.outcome_id === '16AJ_g06_slo_error_budget_source'
  && contract.selected_16aj.g06_slo_source === 'source_defined_via_16AJ'
  && contract.selected_16aj.g06_slo === 'open'
  && contract.selected_16aj.final_controlled_drill_status === 'offline_source_proven'
  && contract.selected_16aj.g06_verdict === 'partial'
  && contract.g06_slo_source === 'source_defined_via_16AJ'
  && contract.g06_slo === 'open'
  && contract.slo_live_proof === 'open');
ok('F198 16AJ fixtures + verifier present',
  pathExists('fixtures/radar-operations/slice16aj-g06-slo-error-budget-contract.json')
  && pathExists('fixtures/radar-operations/slice16aj-expected-contract.json')
  && pathExists('scripts/lib/radar-g06-slo-error-budget.js')
  && pathExists('scripts/lib/radar-slice16aj-g06-slo-error-budget.js')
  && pathExists('scripts/verify-radar-slice16aj-g06-slo-error-budget.js'));
ok('F199 16AJ does not claim live SLO / fire / autoscale / backpressure / production / full G06',
  /live_deploy|alert_fire|soak|autoscale|slo_proven|backpressure|production|full_g06/i.test(
    String(sel16aj.does_not_implement || ''))
  && !/\bG06\s+proven\b/i.test(doc)
  && !/\bcapacity\s+SLO\s+proven\b/i.test(doc)
  && !/\bSLO\s+proven\b/i.test(doc)
  && !/\bfull\s+G06\b/i.test(doc)
  && /16AJ|slo|error.?budget/i.test(doc)
  && /16AJ/i.test(findings)
  && /defined_not_executed/i.test(doc));
ok('F200 score unchanged after 16AJ (proven=0 partial=9 absent=0)',
  contract.expected_verdict_counts.proven === 0
  && contract.expected_verdict_counts.partial === 9
  && contract.expected_verdict_counts.absent === 0
  && MASTER_BASIS_16AJ === '0994989a3d5d14daa98797fac55083b0c2ea809c');

const sel16ak = matrix.slice_16ak_selection;
ok('F201 exactly one 16AK selection (retained)',
  sel16ak && sel16ak.selected === true
  && sel16ak.outcome_id === '16AK_g06_backpressure_source'
  && sel16ak.gate_id === 'G06_scaling_capacity'
  && sel16ak.progress_class === 'source_partial_progress_only'
  && sel16ak.final_controlled_drill
  && sel16ak.final_controlled_drill.status === 'defined_not_executed'
  && sel16ak.g06_backpressure_source === 'source_defined_via_16AK'
  && sel16ak.g06_backpressure === 'open');
ok('F202 contract selected_16ak retained',
  contract.selected_16ak
  && contract.selected_16ak.outcome_id === '16AK_g06_backpressure_source'
  && contract.selected_16ak.g06_backpressure_source === 'source_defined_via_16AK'
  && contract.selected_16ak.g06_backpressure === 'open'
  && contract.selected_16ak.final_controlled_drill_status === 'defined_not_executed'
  && contract.selected_16ak.g06_verdict === 'partial'
  && contract.g06_backpressure_source === 'source_defined_via_16AK'
  && contract.capacity_backpressure === 'open');
ok('F203 16AK fixtures + verifier present',
  pathExists('fixtures/radar-operations/slice16ak-g06-backpressure-contract.json')
  && pathExists('fixtures/radar-operations/slice16ak-expected-contract.json')
  && pathExists('fixtures/radar-operations/slice16ak-staff-api-topology.json')
  && pathExists('scripts/lib/radar-g06-admission-control.js')
  && pathExists('scripts/lib/radar-slice16ak-g06-backpressure.js')
  && pathExists('scripts/verify-radar-slice16ak-g06-backpressure.js'));
ok('F204 16AK does not claim backpressure proven / soak / autoscale / production / full G06',
  /live_deploy|runtime_wire|soak|autoscale|backpressure_proven|production|full_g06/i.test(
    String(sel16ak.does_not_implement || ''))
  && docLacksBareOverclaim(doc, [/\bbackpressure\s+proven\b/i, /\bG06\s+proven\b/i, /\bfull\s+G06\b/i])
  && /16AK|admission|backpressure/i.test(doc)
  && /16AK/i.test(findings)
  && /defined_not_executed/i.test(doc));
ok('F205 score unchanged after 16AK retention (proven=0 partial=9 absent=0)',
  contract.expected_verdict_counts.proven === 0
  && contract.expected_verdict_counts.partial === 9
  && contract.expected_verdict_counts.absent === 0
  && MASTER_BASIS_16AK === '9fa3626326c0e2bc21f2d37905967d6ff47b7520');

const sel16al = matrix.slice_16al_selection;
ok('F206 exactly one 16AL selection',
  sel16al && sel16al.selected === true
  && sel16al.outcome_id === '16AL_g06_backpressure_wire'
  && sel16al.gate_id === 'G06_scaling_capacity'
  && sel16al.progress_class === 'integration_source_partial_progress_only'
  && sel16al.flag_enabled === false
  && sel16al.final_controlled_drill
  && sel16al.final_controlled_drill.status === 'integration_source_proven'
  && sel16al.g06_backpressure_wire_source === 'integration_source_proven_via_16AL'
  && sel16al.g06_backpressure === 'open');
ok('F207 contract selected_16al matches',
  contract.selected_16al
  && contract.selected_16al.outcome_id === '16AL_g06_backpressure_wire'
  && contract.selected_16al.g06_backpressure_wire_source === 'integration_source_proven_via_16AL'
  && contract.selected_16al.g06_backpressure === 'open'
  && contract.selected_16al.flag_enabled === false
  && contract.selected_16al.final_controlled_drill_status === 'integration_source_proven'
  && contract.selected_16al.g06_verdict === 'partial'
  && contract.g06_backpressure_wire_source === 'integration_source_proven_via_16AL'
  && contract.g06_backpressure === 'open'
  && contract.capacity_backpressure === 'open');
ok('F208 16AL fixtures + verifier + boundary present',
  pathExists('fixtures/radar-operations/slice16al-g06-backpressure-wire-contract.json')
  && pathExists('fixtures/radar-operations/slice16al-expected-contract.json')
  && pathExists('scripts/lib/staff-api-admission-boundary.js')
  && pathExists('scripts/lib/radar-slice16al-g06-backpressure-wire.js')
  && pathExists('scripts/verify-radar-slice16al-g06-backpressure-wire.js'));
ok('F209 16AL does not claim backpressure live/proven / flag enabled / soak / production / full G06',
  /live_deploy|flag_enable|soak|autoscale|backpressure_proven|production|full_g06/i.test(
    String(sel16al.does_not_implement || ''))
  && docLacksBareOverclaim(doc, [/\bbackpressure\s+proven\b/i, /\bG06\s+proven\b/i, /\bfull\s+G06\b/i])
  && /16AL/i.test(doc)
  && /16AL/i.test(findings)
  && /default OFF|flag.*OFF|not enabled/i.test(doc)
  && /Does not prove/i.test(doc)
  && MASTER_BASIS_16AL === '502d762f897432c67bb8b17a8a49bfab01a0787d');
ok('F210 score unchanged after 16AL (proven=0 partial=9 absent=0)',
  contract.expected_verdict_counts.proven === 0
  && contract.expected_verdict_counts.partial === 9
  && contract.expected_verdict_counts.absent === 0
  && slice16alContract.master_basis === MASTER_BASIS_16AL);

const sel16am = matrix.slice_16am_selection;
ok('F211 exactly one 16AM selection',
  sel16am && sel16am.selected === true
  && sel16am.outcome_id === '16AM_g06_backpressure_deploy_evidence'
  && sel16am.gate_id === 'G06_scaling_capacity'
  && sel16am.progress_class === 'partial_live_proven_evidence_only'
  && sel16am.flag_enabled === false
  && sel16am.final_controlled_drill
  && sel16am.final_controlled_drill.status === 'live_proven'
  && sel16am.g06_backpressure_deploy_flag_off === 'live_proven_via_16AM'
  && sel16am.g06_backpressure === 'open');
ok('F212 contract selected_16am matches',
  contract.selected_16am
  && contract.selected_16am.outcome_id === '16AM_g06_backpressure_deploy_evidence'
  && contract.selected_16am.g06_backpressure_deploy_flag_off === 'live_proven_via_16AM'
  && contract.selected_16am.g06_backpressure === 'open'
  && contract.selected_16am.flag_enabled === false
  && contract.selected_16am.final_controlled_drill_status === 'live_proven'
  && contract.selected_16am.g06_verdict === 'partial'
  && contract.g06_backpressure_deploy_flag_off === 'live_proven_via_16AM'
  && contract.g06_backpressure_wire_source === 'integration_source_proven_via_16AL'
  && contract.g06_backpressure === 'open');
ok('F213 16AM fixtures + verifier present',
  pathExists('fixtures/radar-operations/slice16am-g06-backpressure-deploy-evidence.json')
  && pathExists('fixtures/radar-operations/slice16am-expected-contract.json')
  && pathExists('fixtures/radar-operations/slice16am-raw-wh-update.json')
  && pathExists('fixtures/radar-operations/slice16am-raw-sunset-update.json')
  && pathExists('fixtures/radar-operations/slice16am-raw-cost-before.json')
  && pathExists('fixtures/radar-operations/slice16am-raw-cost-after.json')
  && pathExists('fixtures/radar-operations/slice16am-raw-readyz-wh.json')
  && pathExists('fixtures/radar-operations/slice16am-raw-readyz-sunset.json')
  && pathExists('fixtures/radar-operations/slice16am-raw-acr-digest.json')
  && pathExists('scripts/lib/radar-slice16am-g06-backpressure-deploy-evidence.js')
  && pathExists('scripts/verify-radar-slice16am-g06-backpressure-deploy-evidence.js'));
ok('F214 16AM does not claim flag enable / live shed / backpressure proven / production / full G06',
  /flag_enable|activation|live_shed|soak|autoscale|backpressure_proven|production|full_g06/i.test(
    String(sel16am.does_not_implement || ''))
  && docLacksBareOverclaim(doc, [/\bbackpressure\s+proven\b/i, /\bG06\s+proven\b/i, /\bfull\s+G06\b/i])
  && /16AM/i.test(doc)
  && /16AM/i.test(findings)
  && /OFF|unset|not enabled|disabled/i.test(doc)
  && /g02503r/i.test(doc)
  && /0000521/i.test(doc)
  && MASTER_BASIS_16AM === '905ff9ff57a75d0b3defc15a16078b47e94e930f');
ok('F215 score unchanged after 16AM (proven=0 partial=9 absent=0)',
  contract.expected_verdict_counts.proven === 0
  && contract.expected_verdict_counts.partial === 9
  && contract.expected_verdict_counts.absent === 0
  && slice16amContract.master_basis === MASTER_BASIS_16AM
  && matrix.master_basis === MASTER_BASIS_16AM);

console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('RADAR 16A operations gate ledger: PASS');
