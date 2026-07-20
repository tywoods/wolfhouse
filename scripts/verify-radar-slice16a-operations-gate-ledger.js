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

const MASTER_BASIS = '1bf9695264250680c41c3e7f82baba97300001a0';
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
  // 16S is evidence-only; 16A freeze requires database/, Hermes, Staff API runtime,
  // completion-log helper, staging Bicep, 16H metric-alert module, and 16B budgets
  // untouched vs master.
  const paths = [
    'database/',
    'docker/hermes-staging/',
    'scripts/staff-query-api.js',
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
  const paths = [
    'scripts/staff-query-api.js',
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
ok('F7 audit_only + no live mutation', matrix.audit_only === true && matrix.live_mutation === false);
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
ok('F18 G03 partial critical (partial_live_proven via 16P AG test API)',
  g03 && g03.verdict === 'partial' && g03.severity === 'critical'
  && g03.progress_class === 'partial_live_proven');
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

ok('F33 doc mentions selected 16S id', /16S_request_completion_log_live_evidence/.test(doc));
ok('F33b doc retains 16P id', /16P_live_drill_evidence_reconciliation|16P/.test(doc));
ok('F33c doc retains 16O id', /16O_stripe_webhook_error_minimization|16O/.test(doc));
ok('F34 doc mentions verdict counts', /proven.*0/i.test(doc) && /partial.*9/i.test(doc) && /absent.*0/i.test(doc));
ok('F35 findings lists G01/G02/G03/G05/G06/G08/G09 partial',
  /G01/.test(findings) && /G02/.test(findings) && /G03/.test(findings) && /G05/.test(findings) && /G06/.test(findings) && /G08/.test(findings) && /G09/.test(findings) && /partial/i.test(findings)
  && /16O/.test(findings) && /16P/.test(findings) && /16S/.test(findings));

ok('F36 healthz source cite present', pathExists('scripts/staff-query-api.js'));
ok('F37 capture cost script present (read-only helper)',
  pathExists('scripts/capture-sunset-staging-rg-cost.js'));
ok('F38 payment_events unique stripe_event_id migration present',
  /stripe_event_id\s+TEXT UNIQUE/.test(readText(path.join(ROOT, 'database/migrations/001_init.sql'))));

const rt = runtimePathsUnchanged();
ok('F39 zero-mutation: database/Hermes/StaffAPI/Bicep/16H/16B unchanged vs master basis (16S evidence-only)', rt.ok, rt.detail);

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
ok('F45 G02 partial_live_proven via 16P (healthy path; 16I source retained)',
  g02 && g02.verdict === 'partial'
  && g02.progress_class === 'partial_live_proven'
  && /readyz|health\/ready|health.ready/i.test(g02.rationale)
  && (/16I/.test(g02.rationale) || /16P/.test(g02.rationale)));
ok('F46 readiness lib present', pathExists('scripts/lib/staff-api-readiness.js'));
ok('F47 16I verifier script present',
  pathExists('scripts/verify-radar-slice16i-staff-api-readiness.js'));

const slice16pContract = readJson(path.join(FIXTURE_DIR, 'slice16p-expected-contract.json'));
const slice16oContract = readJson(path.join(FIXTURE_DIR, 'slice16o-expected-contract.json'));
const slice16rContract = readJson(path.join(FIXTURE_DIR, 'slice16r-expected-contract.json'));
const slice16sContract = readJson(path.join(FIXTURE_DIR, 'slice16s-expected-contract.json'));
const headBranch = currentBranch();
ok('F48 gate-matrix branch pin equals 16S contract + HEAD',
  matrix.branch === BRANCH_16S
  && contract.branch === BRANCH_16S
  && slice16sContract.branch === BRANCH_16S
  && headBranch === BRANCH_16S,
  `matrix=${matrix.branch} contract=${contract.branch} slice16s=${slice16sContract.branch} head=${headBranch}`);
ok('F48b frozen 16O/16P/16R contracts retain their own branch pins',
  slice16oContract.branch === BRANCH_16O
  && slice16pContract.branch === BRANCH_16P
  && slice16rContract.branch === BRANCH_16R);

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
ok('F50 must_not forbids live mutation; 16S leaves Staff API/Bicep unchanged; G08 still cites public-errors',
  !hasStaleSourceForbid
  && hasLiveDeployedForbid
  && g08CitesPublicErrors
  && runtimeDiff.length === 0
  && pathExists('scripts/lib/stripe-webhook-public-errors.js')
  && bicepDiff.length === 0
  && matrix.live_mutation === false,
  `runtimeDiff=${runtimeDiff.join(',') || '(none)'} bicepDiff=${bicepDiff.join(',') || '(none)'} stale=${hasStaleSourceForbid}`);

ok('F51 G01 partial_live_proven via 16S (16J/16R source retained; E2E drill open)',
  g01 && g01.verdict === 'partial'
  && g01.progress_class === 'partial_live_proven'
  && /16S|1bf9695|ContainerAppConsoleLogs_CL/i.test(g01.rationale)
  && Array.isArray(g01.gaps) && g01.gaps.length === 1
  && /Meta.*Hermes|end-to-end/i.test(g01.gaps[0]));
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
ok('F67 G06 partial source-partial via 16L',
  g06 && g06.verdict === 'partial'
  && g06.progress_class === 'source_partial_progress_only'
  && /16L/.test(g06.rationale)
  && /CpuPercentage/i.test(g06.rationale)
  && /MemoryPercentage/i.test(g06.rationale));
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
ok('F74 16L leaves deploy/load/SLO/backpressure open',
  /live_deploy/.test(String(sel16l.does_not_implement || ''))
  && /backpressure/i.test(String(sel16l.does_not_implement || ''))
  && /open/i.test(String(contract.capacity_live_deploy || ''))
  && /open/i.test(String(contract.capacity_backpressure || ''))
  && /open/i.test(String(contract.capacity_slo || '')));
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
ok('F104 G05/G06 remain not partial_live_proven',
  matrix.gates.filter((g) => ['G05_retry_replay_safety', 'G06_scaling_capacity'].includes(g.id))
    .every((g) => g.progress_class !== 'partial_live_proven'));
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
ok('F113 correlation delivery/search/retention live via 16S; E2E drill open',
  contract.correlation_delivery_proof === 'live_proven_via_16S'
  && contract.correlation_search_proof === 'live_proven_via_16S'
  && /live_proven_via_16S/.test(String(contract.correlation_retention || ''))
  && /open/.test(String(contract.correlation_drill || '')));

console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('RADAR 16A operations gate ledger: PASS');
