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

const MASTER_BASIS = '28a30a688baa637e1bcb549d9b585cb5917942d1';
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
  'G09_cost_anomaly_detection',
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
  const paths = [
    'scripts/staff-query-api.js',
    'infra/azure/staging/main.bicep',
    'infra/azure/sunset-staging/main.bicep',
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
ok('F16 expected frozen counts proven=0 partial=7 absent=2',
  counts.proven === 0 && counts.partial === 7 && counts.absent === 2 && counts.total === 9);
ok('F17 contract expected counts match',
  contract.expected_verdict_counts.proven === 0
  && contract.expected_verdict_counts.partial === 7
  && contract.expected_verdict_counts.absent === 2);

const g03 = matrix.gates.find((g) => g.id === 'G03_actionable_tenant_aware_alerts');
const g09 = matrix.gates.find((g) => g.id === 'G09_cost_anomaly_detection');
ok('F18 G03 absent critical', g03 && g03.verdict === 'absent' && g03.severity === 'critical');
ok('F19 G09 absent high', g09 && g09.verdict === 'absent' && g09.severity === 'high');

const sel = matrix.slice_16b_selection;
ok('F20 exactly one 16B selection',
  sel && sel.selected === true
  && sel.outcome_id === '16B_staging_rg_cost_budget_anomaly'
  && sel.gate_id === 'G09_cost_anomaly_detection');
ok('F21 16B acceptance criteria finite (>=4)',
  Array.isArray(sel.acceptance_criteria) && sel.acceptance_criteria.length >= 4);
ok('F22 16B final controlled drill present',
  sel.final_controlled_drill
  && sel.final_controlled_drill.id === '16B_DRILL_budget_threshold_notify');
ok('F23 contract selected_16b matches',
  contract.selected_16b.outcome_id === '16B_staging_rg_cost_budget_anomaly'
  && contract.selected_16b.gate_id === 'G09_cost_anomaly_detection');

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

ok('F33 doc mentions selected 16B id', /16B_staging_rg_cost_budget_anomaly/.test(doc));
ok('F34 doc mentions verdict counts', /proven.*0/i.test(doc) && /absent.*2/i.test(doc));
ok('F35 findings lists G03 and G09 absent',
  /G03/.test(findings) && /G09/.test(findings) && /absent/i.test(findings));

ok('F36 healthz source cite present', pathExists('scripts/staff-query-api.js'));
ok('F37 capture cost script present (read-only helper)',
  pathExists('scripts/capture-sunset-staging-rg-cost.js'));
ok('F38 payment_events unique stripe_event_id migration present',
  /stripe_event_id\s+TEXT UNIQUE/.test(readText(path.join(ROOT, 'database/migrations/001_init.sql'))));

const rt = runtimePathsUnchanged();
ok('F39 zero-mutation: runtime Bicep/staff-api unchanged vs master basis', rt.ok, rt.detail);

ok('F40 16A final controlled drill frozen',
  matrix.final_controlled_drill_16a
  && matrix.final_controlled_drill_16a.id === '16A_DRILL_ledger_freeze_read_only');

console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('RADAR 16A operations gate ledger: PASS');
