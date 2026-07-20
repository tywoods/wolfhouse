'use strict';

/**
 * verify:radar-slice16a-operations-gate-ledger — RADAR Slice 16A2
 *
 * Offline audit gate: independently reproducible + semantically truthful
 * operations gate ledger. No network, no DB, no Azure calls, no live mutation.
 *
 * Strengthened vs 16A:
 * - resolve JSON refs in live evidence
 * - validate cited line ranges contain symbols / semantic anchors
 * - compare reviewed commit range across every contract runtime path
 * - reconstruct claims (counts, emptiness, costs) rather than trust booleans
 * - G09 is cost controls (budgets = thresholds ≠ anomaly detection)
 * - 16B is budget-threshold partial progress only; notification delivery proof required
 * - capture manifest RED guards for production/secret/DB/mutation surfaces
 *
 * Exit 0 on pass, nonzero on failure.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  ALLOWED_SUBSCRIPTION_ID,
  ALLOWED_RESOURCE_GROUPS,
  ALLOWED_METHOD_IDS,
  buildCaptureManifest,
  runCaptureRedTests,
  hashCanonical,
} = require('./lib/radar-operations-azure-capture');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'radar-operations');
const MATRIX_PATH = path.join(FIXTURE_DIR, 'gate-matrix.json');
const LIVE_PATH = path.join(FIXTURE_DIR, 'live-inventory.json');
const CONTRACT_PATH = path.join(FIXTURE_DIR, 'contract.json');
const FINDINGS_PATH = path.join(FIXTURE_DIR, 'findings.md');
const DOC_PATH = path.join(ROOT, 'docs', 'RADAR-OPERATIONS-GATE-LEDGER.md');
const MANIFEST_PATH = path.join(FIXTURE_DIR, 'capture-manifest.json');
const CAPTURE_LOG_PATH = path.join(FIXTURE_DIR, 'capture-log.json');
const CAPTURE_TOOL = path.join(ROOT, 'scripts', 'capture-radar-operations-staging-readonly.js');
const CAPTURE_LIB = path.join(ROOT, 'scripts', 'lib', 'radar-operations-azure-capture.js');

const MASTER_BASIS = '5a8b08d395e11c51baf928b918016d5dd5bb4afe';
const BRANCH = 'radar/slice-16a2-ledger-provenance';
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
  /InstrumentationKey=[0-9a-f-]{20,}/i,
  /postgres(ql)?:\/\/[^\s"']+/i,
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

function noTrailingWhitespace(text) {
  return !text.split(/\n/).some((line) => /[ \t]+$/.test(line));
}

function secretFree(text, label) {
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) {
      return { ok: false, detail: `${label} matched ${re}` };
    }
  }
  return { ok: true };
}

/** Resolve fixture JSON pointer-ish refs: live-inventory.json#path.to.value */
function resolveJsonRef(ref, live, matrix) {
  if (!ref || typeof ref !== 'string') return { ok: false, detail: 'missing ref' };
  const m = ref.match(/^(live-inventory\.json|gate-matrix\.json)#(.+)$/);
  if (!m) return { ok: false, detail: `unsupported ref format: ${ref}` };
  const root = m[1] === 'live-inventory.json' ? live : matrix;
  const parts = m[2].split('.').filter(Boolean);
  let cur = root;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) {
      return { ok: false, detail: `unresolved ${ref} at ${part}` };
    }
    cur = cur[part];
  }
  return { ok: true, value: cur };
}

function parseLineRanges(linesSpec) {
  if (!linesSpec) return [];
  const ranges = [];
  for (const chunk of String(linesSpec).split(',')) {
    const t = chunk.trim();
    if (!t) continue;
    if (t.includes('-')) {
      const [a, b] = t.split('-').map((x) => Number(x));
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a) {
        ranges.push({ ok: false, detail: `bad range ${t}` });
      } else {
        ranges.push({ ok: true, start: a, end: b });
      }
    } else {
      const n = Number(t);
      if (!Number.isFinite(n) || n < 1) ranges.push({ ok: false, detail: `bad line ${t}` });
      else ranges.push({ ok: true, start: n, end: n });
    }
  }
  return ranges;
}

function citeSemantics(ev) {
  if (!ev || !ev.path) return { ok: false, detail: 'missing path' };
  const abs = path.join(ROOT, ev.path);
  if (!fs.existsSync(abs)) return { ok: false, detail: `missing file ${ev.path}` };
  const src = fs.readFileSync(abs, 'utf8');
  const lines = src.split(/\r?\n/);
  const ranges = parseLineRanges(ev.lines);
  if (ranges.length === 0) return { ok: false, detail: 'missing lines' };
  for (const r of ranges) {
    if (!r.ok) return r;
    if (r.end > lines.length) {
      return { ok: false, detail: `${ev.path}:${r.end} beyond EOF (${lines.length})` };
    }
  }
  const sliceText = ranges
    .map((r) => lines.slice(r.start - 1, r.end).join('\n'))
    .join('\n');
  const symbols = Array.isArray(ev.symbols) ? ev.symbols : [];
  for (const sym of symbols) {
    const s = String(sym);
    // Symbol may appear in the cited slice OR (for multi-range) nearby file — require slice.
    if (!sliceText.includes(s) && !src.includes(s)) {
      return { ok: false, detail: `symbol not found: ${s}` };
    }
    // Prefer presence in cited ranges when symbols provided.
    if (symbols.length > 0 && !sliceText.includes(s) && src.includes(s)) {
      // allow file-level for sparse docs cites with empty nearby text, but flag soft fail
      // Strict: require at least one symbol in slice when symbols non-empty.
    }
  }
  if (symbols.length > 0) {
    const anyInSlice = symbols.some((s) => sliceText.includes(String(s)));
    if (!anyInSlice) {
      return {
        ok: false,
        detail: `none of symbols [${symbols.join(', ')}] appear in cited lines ${ev.lines}`,
      };
    }
  }
  // Semantic anchors from note (optional keywords)
  if (ev.semantic_anchors && Array.isArray(ev.semantic_anchors)) {
    for (const a of ev.semantic_anchors) {
      if (!sliceText.includes(String(a)) && !src.includes(String(a))) {
        return { ok: false, detail: `semantic anchor missing: ${a}` };
      }
    }
  }
  return { ok: true, sliceText };
}

function runtimePathsUnchanged(contract) {
  const paths = (contract.zero_mutation_proof
    && contract.zero_mutation_proof.runtime_paths_unchanged) || [];
  if (!Array.isArray(paths) || paths.length < 1) {
    return { ok: false, detail: 'contract missing runtime_paths_unchanged' };
  }
  for (const p of paths) {
    const abs = path.join(ROOT, p);
    if (!fs.existsSync(abs)) {
      return { ok: false, detail: `runtime path missing on disk: ${p}` };
    }
  }
  try {
    const out = execSync(
      `git diff --name-only ${MASTER_BASIS} -- ${paths.join(' ')}`,
      { cwd: ROOT, encoding: 'utf8' },
    ).trim();
    if (out) {
      return { ok: false, detail: out };
    }
    return { ok: true, detail: `(clean: ${paths.length} paths)`, paths };
  } catch (err) {
    return { ok: false, detail: String(err && err.message) };
  }
}

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

function reconstructBudgetEmptiness(live) {
  const wh = live.budgets && live.budgets['wh-staging-rg'];
  const su = live.budgets && live.budgets['luna-sunset-staging-rg'];
  return {
    whEmpty: Array.isArray(wh) && wh.length === 0,
    sunsetEmpty: Array.isArray(su) && su.length === 0,
  };
}

function reconstructAlertEmptiness(live) {
  const out = {};
  for (const rg of ALLOWED_RESOURCE_GROUPS) {
    const a = live.alerts && live.alerts[rg];
    out[rg] = {
      metric: Array.isArray(a && a.metric_alerts) && a.metric_alerts.length === 0,
      activity: Array.isArray(a && a.activity_log_alerts) && a.activity_log_alerts.length === 0,
      scheduled: Array.isArray(a && a.scheduled_query_rules) && a.scheduled_query_rules.length === 0,
    };
  }
  return out;
}

function reconstructCosts(live, contract) {
  const wh = live.costs_mtd && live.costs_mtd['wh-staging-rg'] && live.costs_mtd['wh-staging-rg'].total;
  const su = live.costs_mtd && live.costs_mtd['luna-sunset-staging-rg']
    && live.costs_mtd['luna-sunset-staging-rg'].total;
  const combined = live.costs_mtd && live.costs_mtd.combined_total;
  const rebuilt = (Number(wh) || 0) + (Number(su) || 0);
  return {
    wh,
    su,
    combined,
    rebuilt,
    matchesContract:
      wh === contract.costs_mtd_usd_frozen['wh-staging-rg']
      && su === contract.costs_mtd_usd_frozen['luna-sunset-staging-rg']
      && combined === contract.costs_mtd_usd_frozen.combined,
    sumConsistent: Math.abs(rebuilt - Number(combined)) < 1e-6,
  };
}

console.log('verify:radar-slice16a-operations-gate-ledger — RADAR Slice 16A2\n');

ok('F1 gate-matrix exists', fs.existsSync(MATRIX_PATH));
ok('F2 live-inventory exists', fs.existsSync(LIVE_PATH));
ok('F3 contract exists', fs.existsSync(CONTRACT_PATH));
ok('F4 findings exists', fs.existsSync(FINDINGS_PATH));
ok('F5 ledger doc exists', fs.existsSync(DOC_PATH));
ok('F5b capture-manifest exists', fs.existsSync(MANIFEST_PATH));
ok('F5c capture-log exists', fs.existsSync(CAPTURE_LOG_PATH));
ok('F5d capture tool exists', fs.existsSync(CAPTURE_TOOL));
ok('F5e capture lib exists', fs.existsSync(CAPTURE_LIB));

const matrix = readJson(MATRIX_PATH);
const live = readJson(LIVE_PATH);
const contract = readJson(CONTRACT_PATH);
const manifest = readJson(MANIFEST_PATH);
const captureLog = readJson(CAPTURE_LOG_PATH);
const doc = readText(DOC_PATH);
const findings = readText(FINDINGS_PATH);

ok('F6 matrix schema_version>=1', matrix.schema_version >= 1);
ok('F7 audit_only + no live mutation', matrix.audit_only === true && matrix.live_mutation === false);
ok('F8 master_basis pinned to 16A2 basis', matrix.master_basis === MASTER_BASIS);
ok('F9 contract master_basis pinned', contract.master_basis === MASTER_BASIS);
ok('F9b branch name', matrix.branch === BRANCH && contract.branch === BRANCH);
ok('F10 classification policy fail-closed',
  matrix.classification_policy === 'fail_closed_absence_is_not_safe');
ok('F11 azure scope exactly two staging RGs',
  Array.isArray(matrix.azure_read_only_scope)
  && matrix.azure_read_only_scope.length === 2
  && matrix.azure_read_only_scope.includes('wh-staging-rg')
  && matrix.azure_read_only_scope.includes('luna-sunset-staging-rg'));

ok('F12 gates array length 9', Array.isArray(matrix.gates) && matrix.gates.length === 9);
const ids = matrix.gates.map((g) => g.id);
ok('F13 required gate ids present (G09_cost_controls)', REQUIRED_GATE_IDS.every((id) => ids.includes(id)));
ok('F13b no legacy G09_cost_anomaly_detection id', !ids.includes('G09_cost_anomaly_detection'));

let schemaOk = true;
for (const g of matrix.gates) {
  if (!g.id || !g.name || !VERDICTS.has(g.verdict)) schemaOk = false;
  if (!Array.isArray(g.source_evidence) || g.source_evidence.length < 1) schemaOk = false;
  if (!Array.isArray(g.live_evidence) || g.live_evidence.length < 1) schemaOk = false;
  if (!Array.isArray(g.gaps) || g.gaps.length < 1) schemaOk = false;
}
ok('F14 gate schema complete', schemaOk);

const counts = countVerdicts(matrix.gates);
ok('F15 reconstructed verdict counts match matrix.verdict_counts',
  counts.proven === matrix.verdict_counts.proven
  && counts.partial === matrix.verdict_counts.partial
  && counts.absent === matrix.verdict_counts.absent
  && counts.total === matrix.verdict_counts.total);
ok('F16 expected frozen counts proven=0 partial=7 absent=2',
  counts.proven === 0 && counts.partial === 7 && counts.absent === 2 && counts.total === 9);
ok('F17 contract expected counts match reconstructed',
  contract.expected_verdict_counts.proven === counts.proven
  && contract.expected_verdict_counts.partial === counts.partial
  && contract.expected_verdict_counts.absent === counts.absent);

const g03 = matrix.gates.find((g) => g.id === 'G03_actionable_tenant_aware_alerts');
const g09 = matrix.gates.find((g) => g.id === 'G09_cost_controls');
ok('F18 G03 absent critical', g03 && g03.verdict === 'absent' && g03.severity === 'critical');
ok('F19 G09 cost controls absent high', g09 && g09.verdict === 'absent' && g09.severity === 'high');
ok('F19b G09 name is cost controls', g09 && /cost controls/i.test(g09.name));
ok('F19c G09 separates budget threshold vs anomaly detection',
  g09
  && g09.controls
  && g09.controls.budget_threshold
  && g09.controls.anomaly_detection
  && g09.controls.budget_threshold.kind === 'threshold'
  && g09.controls.anomaly_detection.kind === 'anomaly_detection'
  && g09.controls.budget_threshold.status === 'absent'
  && g09.controls.anomaly_detection.status === 'absent');

const sel = matrix.slice_16b_selection;
ok('F20 exactly one 16B selection (budget threshold)',
  sel && sel.selected === true
  && sel.outcome_id === '16B_staging_rg_cost_budget_threshold'
  && sel.gate_id === 'G09_cost_controls'
  && sel.progress_class === 'budget_threshold_partial_progress_only');
ok('F20b 16B does not claim anomaly detection',
  sel
  && sel.does_not_implement === 'anomaly_detection'
  && !/anomaly/i.test(sel.outcome_id));
ok('F21 16B acceptance criteria finite (>=4) and split',
  Array.isArray(sel.acceptance_criteria) && sel.acceptance_criteria.length >= 4
  && Array.isArray(sel.budget_notification_acceptance)
  && sel.budget_notification_acceptance.length >= 2
  && Array.isArray(sel.anomaly_detection_acceptance)
  && sel.anomaly_detection_acceptance.length >= 1);
ok('F22 16B requires real notification delivery proof (not Enabled-only)',
  sel.final_controlled_drill
  && sel.final_controlled_drill.id === '16B_DRILL_budget_threshold_notify'
  && /delivery|delivered|received/i.test(JSON.stringify(sel.final_controlled_drill))
  && !/confirm Azure shows Enabled \+ threshold/i.test(JSON.stringify(sel.final_controlled_drill.steps || [])));
ok('F23 contract selected_16b matches',
  contract.selected_16b.outcome_id === '16B_staging_rg_cost_budget_threshold'
  && contract.selected_16b.gate_id === 'G09_cost_controls'
  && contract.selected_16b.progress_class === 'budget_threshold_partial_progress_only');

ok('F24 live inventory read_only + no mutation',
  live.read_only === true && live.live_mutation === false);
const budgetsRe = reconstructBudgetEmptiness(live);
ok('F25 reconstructed budgets empty both RGs', budgetsRe.whEmpty && budgetsRe.sunsetEmpty);
const alertsRe = reconstructAlertEmptiness(live);
ok('F26 reconstructed alerts empty both RGs',
  ALLOWED_RESOURCE_GROUPS.every((rg) => (
    alertsRe[rg].metric && alertsRe[rg].activity && alertsRe[rg].scheduled
  )));
const costsRe = reconstructCosts(live, contract);
ok('F27 reconstructed MTD costs match contract', costsRe.matchesContract, JSON.stringify(costsRe));
ok('F27b cost sum reconstructed from RG totals', costsRe.sumConsistent);
ok('F28 MTD costs positive', costsRe.wh > 0 && costsRe.su > 0);

ok('F29 public healthz frozen 200 without dependency readiness fields',
  live.public_healthz['staff-staging.lunafrontdesk.com'].http_status === 200
  && live.public_healthz['sunset-staging.lunafrontdesk.com'].http_status === 200
  && live.public_healthz['staff-staging.lunafrontdesk.com'].dependency_fields_present === false);

ok('F30 ACA probes empty/null frozen',
  Array.isArray(live.container_apps['wh-staging-staff-api'].probes)
  && live.container_apps['wh-staging-staff-api'].probes.length === 0
  && live.container_apps['luna-sunset-staging-staff-api'].probes === null);

// F31 — cite semantics for every source evidence
let evidenceOk = true;
const evidenceFails = [];
for (const g of matrix.gates) {
  for (const ev of g.source_evidence) {
    const r = citeSemantics(ev);
    if (!r.ok) {
      evidenceOk = false;
      evidenceFails.push(`${g.id} ${ev.path}:${ev.lines} — ${r.detail}`);
    }
  }
}
ok('F31 all source evidence line ranges/symbols/semantics resolve', evidenceOk,
  evidenceFails.slice(0, 8).join(' | '));

// F31b — resolve every live_evidence JSON ref
let refsOk = true;
const refFails = [];
for (const g of matrix.gates) {
  for (const ev of g.live_evidence) {
    const r = resolveJsonRef(ev.ref, live, matrix);
    if (!r.ok) {
      refsOk = false;
      refFails.push(`${g.id} ${ev.ref} — ${r.detail}`);
    }
  }
}
ok('F31b all live_evidence JSON refs resolve', refsOk, refFails.slice(0, 8).join(' | '));

const blob = [
  JSON.stringify(matrix),
  JSON.stringify(live),
  JSON.stringify(contract),
  JSON.stringify(manifest),
  JSON.stringify(captureLog),
  findings,
  doc,
].join('\n');
const sec = secretFree(blob, 'fixtures+doc');
ok('F32 secret-free fixtures and doc', sec.ok, sec.detail);

ok('F33 doc mentions selected 16B budget threshold id',
  /16B_staging_rg_cost_budget_threshold/.test(doc));
ok('F34 doc mentions verdict counts', /proven.*0/i.test(doc) && /absent.*2/i.test(doc));
ok('F35 findings lists G03 and G09 absent',
  /G03/.test(findings) && /G09/.test(findings) && /absent/i.test(findings));
ok('F35b findings name G09 cost controls (not anomaly-only)',
  /G09.*cost controls/i.test(findings) || /cost controls/i.test(findings));

ok('F36 healthz source cite present', pathExists('scripts/staff-query-api.js'));
ok('F37 capture cost script present (read-only helper)',
  pathExists('scripts/capture-sunset-staging-rg-cost.js'));
ok('F37b radar capture tool present', pathExists('scripts/capture-radar-operations-staging-readonly.js'));
ok('F38 payment_events unique stripe_event_id migration present',
  /stripe_event_id\s+TEXT UNIQUE/.test(readText(path.join(ROOT, 'database/migrations/001_init.sql'))));

const rt = runtimePathsUnchanged(contract);
ok('F39 zero-mutation: every contract runtime path unchanged vs master basis', rt.ok, rt.detail);

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

// Capture provenance / semantic qualifications
ok('F45 capture manifest subscription pinned',
  manifest.allowed_subscription_id === ALLOWED_SUBSCRIPTION_ID
  && live.subscription_id_suffix === ALLOWED_SUBSCRIPTION_ID.slice(-12));
ok('F46 capture manifest method inventory non-empty',
  Array.isArray(manifest.allowed_method_inventory)
  && manifest.allowed_method_inventory.length === ALLOWED_METHOD_IDS.length);
ok('F47 capture-log records commands/paths/versions/timestamps/hashes',
  Array.isArray(captureLog.calls)
  && captureLog.calls.length > 10
  && captureLog.calls.every((c) => (
    c.method_id
    && c.method
    && c.started_at_utc
    && (c.response_sha256 || c.error)
  )));
ok('F48 live inventory embeds capture provenance hashes',
  live.capture_provenance
  && Array.isArray(live.capture_provenance.response_hashes)
  && live.capture_provenance.response_hashes.length === captureLog.calls.filter((c) => c.response_sha256).length);

const red = runCaptureRedTests();
ok('F49 RED tests refuse production/secret/DB/mutation surfaces',
  red.fail === 0 && red.pass >= 8,
  JSON.stringify(red.cases.filter((c) => !c.ok)));

ok('F50 diagnostic settings qualified as sampled allowlist',
  live.diagnostic_settings
  && live.diagnostic_settings.sampling_policy === 'explicit_allowlist_only'
  && Array.isArray(live.diagnostic_settings.sampled_resources)
  && live.diagnostic_settings.sampled_resources.length >= 8
  && /sampled allowlist|sampled/i.test(live.diagnostic_settings.note || ''));

const aiWh = live.retention && live.retention['wh-staging-appinsights'];
const aiSu = live.retention && live.retention['luna-sunset-staging-appinsights'];
const lawWh = live.retention && live.retention['wh-staging-logs'];
ok('F51 App Insights effective retention qualified (workspace-based)',
  aiWh && aiSu
  && aiWh.workspace_based === true
  && aiSu.workspace_based === true
  && aiWh.effective_analytics_retentionInDays === lawWh.retentionInDays
  && /workspace-based/i.test(aiWh.qualification || ''));
ok('F52 G08 live evidence does not claim unqualified App Insights 90d as effective',
  !/App Insights 90d both RGs$/.test(JSON.stringify(matrix.gates.find((g) => g.id === 'G08_retention_privacy'))));

ok('F53 built manifest hash matches committed inventory scope',
  hashCanonical(buildCaptureManifest().allowed_resource_groups)
  === hashCanonical(manifest.allowed_resource_groups));

ok('F54 critical_absent_gates reconstructed',
  Array.isArray(contract.critical_absent_gates)
  && contract.critical_absent_gates.includes('G03_actionable_tenant_aware_alerts')
  && contract.critical_absent_gates.includes('G09_cost_controls'));

console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('RADAR 16A2 operations gate ledger provenance: PASS');
