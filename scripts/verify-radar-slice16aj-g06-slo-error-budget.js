'use strict';

/**
 * verify:radar-slice16aj-g06-slo-error-budget — RADAR Slice 16AJ
 *
 * Offline RED/GREEN for G06 capacity SLO / error-budget source contract.
 * Exact boundaries, counter resets, sparse samples, percentile misuse,
 * overclaims. No network / live / deploy.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16aj-g06-slo-error-budget');
const calc = locks.calc;

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

function red(id, cond, detail) {
  return ok(`RED ${id}`, cond, detail);
}

function green(id, cond, detail) {
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
  ];
  for (let i = 0; i < patterns.length; i += 1) {
    if (patterns[i].test(text)) return { ok: false, detail: `${label} matched ${patterns[i]}` };
  }
  return { ok: true };
}

function nearlyEqual(a, b, eps) {
  const e = eps == null ? 1e-12 : eps;
  return Math.abs(a - b) <= e;
}

/** Build PT5M cumulative counter series with constant rate and a window hist. */
function buildSeries(opts) {
  const o = opts || {};
  const steps = o.steps == null ? 24 : o.steps;
  const stepMs = o.step_ms == null ? calc.SAMPLE_STEP_MS : o.step_ms;
  const start = o.start_t_ms == null ? 1_000_000 : o.start_t_ms;
  const perStepTotal = o.per_step_total == null ? 10 : o.per_step_total;
  const perStep2xx = o.per_step_2xx == null ? perStepTotal : o.per_step_2xx;
  const objectiveMs = o.latency_objective_ms == null
    ? calc.LATENCY_OBJECTIVE_MS
    : o.latency_objective_ms;
  const slowFraction = o.slow_fraction == null ? 0 : o.slow_fraction;

  const samples = [];
  let total = 0;
  let ok2xx = 0;
  for (let i = 0; i <= steps; i += 1) {
    samples.push({
      t_ms: start + i * stepMs,
      requests_total: total,
      requests_2xx: ok2xx,
    });
    if (i < steps) {
      total += perStepTotal;
      ok2xx += perStep2xx;
    }
  }
  const windowTotal = total;
  const slow = Math.round(windowTotal * slowFraction);
  const fast = windowTotal - slow;
  const hist = {
    le_ms: [objectiveMs, objectiveMs * 2, objectiveMs * 10],
    counts: [fast, windowTotal, windowTotal],
  };
  samples[samples.length - 1].latency_histogram = hist;
  return samples;
}

console.log('RADAR 16AJ G06 SLO / error-budget source — offline verifier\n');

const design = readJson(locks.DESIGN_REL);
const contract = readJson(locks.CONTRACT_REL);
const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
const topContract = readJson('fixtures/radar-operations/contract.json');
const doc = readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md');
const findings = readText('fixtures/radar-operations/findings.md');
const calcSrc = readText(locks.CALC_REL);
const verifySrc = readText(locks.VERIFY_REL);

ok('C1 HEAD on 16AJ branch', currentBranch() === locks.BRANCH, currentBranch());
ok('C2 master_basis locked',
  contract.master_basis === locks.MASTER_BASIS
  && design.master_basis === locks.MASTER_BASIS
  && matrix.master_basis === locks.MASTER_BASIS
  && topContract.master_basis === locks.MASTER_BASIS);
ok('C3 slice/outcome/branch locked',
  contract.slice === locks.SLICE
  && contract.outcome_id === locks.OUTCOME_ID
  && contract.branch === locks.BRANCH
  && design.slice === locks.SLICE
  && design.outcome_id === locks.OUTCOME_ID
  && matrix.slice === locks.SLICE
  && matrix.branch === locks.BRANCH
  && topContract.slice === locks.SLICE
  && topContract.branch === locks.BRANCH);

ok('C4 live flags false + source-only',
  contract.live_deploy === false
  && contract.live_mutation === false
  && contract.live_network === false
  && contract.this_slice_deploys === false
  && contract.this_slice_implements_runtime === false
  && matrix.live_mutation === false
  && matrix.audit_only === true);

ok('C5 calculator has no I/O / network deps',
  !/require\(['"]https['"]\)/.test(calcSrc)
  && !/require\(['"]http['"]\)/.test(calcSrc)
  && !/require\(['"]net['"]\)/.test(calcSrc)
  && !/require\(['"]dns['"]\)/.test(calcSrc)
  && !/require\(['"]fs['"]\)/.test(calcSrc)
  && !/require\(['"]child_process['"]\)/.test(calcSrc)
  && !/fetch\(/.test(calcSrc)
  && !/az\s/.test(calcSrc));

ok('C6 SLI locks match calculator constants',
  locks.SLI_LOCK.availability.target === calc.AVAILABILITY_TARGET
  && locks.SLI_LOCK.latency.objective_ms === calc.LATENCY_OBJECTIVE_MS
  && locks.SLI_LOCK.latency.success_fraction === calc.LATENCY_SUCCESS_FRACTION
  && locks.SLI_LOCK.combined.target === calc.COMBINED_TARGET
  && locks.SLI_LOCK.window.slo_window_ms === calc.SLO_WINDOW_MS
  && locks.SLI_LOCK.window.sample_step_ms === calc.SAMPLE_STEP_MS
  && locks.SLI_LOCK.window.min_sample_coverage === calc.MIN_SAMPLE_COVERAGE
  && locks.SLI_LOCK.window.min_requests === calc.MIN_REQUESTS
  && contract.sli.availability_target === calc.AVAILABILITY_TARGET
  && design.sli_contract.availability_target === calc.AVAILABILITY_TARGET);

ok('C7 multi-window burns locked (4 pairs)',
  calc.MULTI_WINDOW_BURNS.length === 4
  && contract.error_budget.multi_window_burns.length === 4
  && design.multi_window_burns.length === 4
  && calc.MULTI_WINDOW_BURNS[0].id === 'page_fast'
  && calc.MULTI_WINDOW_BURNS[0].burn_threshold === 14.4
  && calc.MULTI_WINDOW_BURNS[3].id === 'ticket_slow'
  && calc.MULTI_WINDOW_BURNS[3].burn_threshold === 1);

ok('C8 future acceptance defined_not_executed only',
  locks.FUTURE_ALERT_ACCEPTANCE.status === 'defined_not_executed'
  && locks.FUTURE_DRILL_ACCEPTANCE.status === 'defined_not_executed'
  && contract.future_alert_acceptance.status === 'defined_not_executed'
  && contract.future_drill_acceptance.status === 'defined_not_executed'
  && design.future_acceptance_only.alert.status === 'defined_not_executed'
  && design.future_acceptance_only.drill.status === 'defined_not_executed');

// --- GREEN: exact availability boundary 99/100 meets; 98/100 misses ---
{
  const b = calc.exactBoundaryCases();
  const meet = calc.availabilitySliFromDeltas(b.meet_counts.total, b.meet_counts.good);
  const miss = calc.availabilitySliFromDeltas(b.miss_counts.total, b.miss_counts.good);
  green('availability_boundary_99_of_100_meets',
    meet.ok && nearlyEqual(meet.sli, 0.99) && meet.sli + 1e-12 >= calc.AVAILABILITY_TARGET);
  green('availability_boundary_98_of_100_misses',
    miss.ok && nearlyEqual(miss.sli, 0.98) && miss.sli + 1e-12 < calc.AVAILABILITY_TARGET);
}

// --- GREEN: exact unit burn and 14.4x burn ---
{
  const b = calc.exactBoundaryCases();
  const unit = calc.burnFromBadRate(
    b.unit_burn_bad_rate,
    calc.AVAILABILITY_TARGET,
    calc.SLO_WINDOW_MS,
    calc.SLO_WINDOW_MS,
  );
  const fast = calc.burnFromBadRate(
    b.fast_burn_bad_rate,
    calc.AVAILABILITY_TARGET,
    60 * 60 * 1000,
    calc.SLO_WINDOW_MS,
  );
  green('error_budget_unit_burn_exact',
    unit.ok && nearlyEqual(unit.burn_rate, 1) && nearlyEqual(unit.budget, 0.01));
  green('error_budget_fast_burn_14_4_exact',
    fast.ok && nearlyEqual(fast.burn_rate, 14.4)
    && nearlyEqual(fast.budget_consumed_fraction, 14.4 * ((60 * 60 * 1000) / calc.SLO_WINDOW_MS)));
}

// --- GREEN: latency histogram at exact objective boundary ---
{
  const histMeet = { le_ms: [500, 1000], counts: [99, 100] };
  const histMiss = { le_ms: [500, 1000], counts: [98, 100] };
  const meet = calc.latencySuccessRatioFromHistogram(histMeet, 500, 100);
  const miss = calc.latencySuccessRatioFromHistogram(histMiss, 500, 100);
  green('latency_histogram_99_of_100_at_500ms_meets',
    meet.ok && nearlyEqual(meet.ratio, 0.99)
    && meet.ratio + 1e-12 >= calc.LATENCY_SUCCESS_FRACTION);
  green('latency_histogram_98_of_100_at_500ms_misses',
    miss.ok && nearlyEqual(miss.ratio, 0.98)
    && miss.ratio + 1e-12 < calc.LATENCY_SUCCESS_FRACTION);
}

// --- GREEN: full readiness window healthy ---
{
  const samples = buildSeries({
    steps: 36,
    per_step_total: 5,
    per_step_2xx: 5,
    slow_fraction: 0,
  });
  // 36*5=180 requests over 36*5min — enough coverage + min requests
  const r = calc.evaluateReadinessWindow({
    samples,
    min_requests: 100,
    min_sample_coverage: 0.5,
  });
  green('readiness_window_healthy_combined',
    r.ok && r.meets_combined === true && r.meets_availability === true
    && r.meets_latency === true && nearlyEqual(r.combined_sli, 1),
    r.ok ? JSON.stringify({ sli: r.combined_sli }) : (r.errors || []).join(' | '));
}

// --- GREEN: multi-window burn all quiet on healthy series ---
{
  // Need >= 3d of samples for ticket_slow long window (3d)
  const steps = Math.ceil((3 * 24 * 60 * 60 * 1000) / calc.SAMPLE_STEP_MS) + 2;
  const samples = buildSeries({
    steps,
    per_step_total: 2,
    per_step_2xx: 2,
    slow_fraction: 0,
  });
  const all = calc.evaluateAllBurnPairs(samples, {
    burn_min_sample_coverage: 0.05,
    burn_min_requests: 1,
  });
  green('multi_window_burn_quiet_on_healthy',
    all.ok && all.any_page_would_fire === false && all.any_ticket_would_fire === false
    && all.alert_status === 'defined_not_executed'
    && all.pairs.every((p) => p.alert_status === 'defined_not_executed'),
    all.ok ? `pairs=${all.pairs.length}` : (all.errors || []).join(' | '));
}

// --- GREEN: sustained high bad rate fires page_fast (both legs) ---
{
  const steps = Math.ceil((3 * 24 * 60 * 60 * 1000) / calc.SAMPLE_STEP_MS) + 2;
  // 20% bad → burn = 0.20/0.01 = 20x > 14.4
  const samples = buildSeries({
    steps,
    per_step_total: 10,
    per_step_2xx: 8,
    slow_fraction: 0,
  });
  const pair = calc.MULTI_WINDOW_BURNS[0];
  const r = calc.evaluateBurnPair(samples, pair, {
    burn_min_sample_coverage: 0.05,
    burn_min_requests: 1,
  });
  green('page_fast_would_fire_on_20pct_bad',
    r.ok && r.would_fire === true
    && r.short.exceeds_threshold === true
    && r.long.exceeds_threshold === true
    && r.alert_status === 'defined_not_executed',
    r.ok ? `short=${r.short.burn_rate} long=${r.long.burn_rate}` : (r.errors || []).join(' | '));
}

// --- RED: missing samples ---
{
  const r = calc.deltasFromCounterSamples([{ t_ms: 1, requests_total: 1, requests_2xx: 1 }]);
  red('missing_samples_lt_2',
    r.ok === false && r.fail_closed === true && r.code === calc.FAIL_CODES.MISSING_SAMPLES);
}
{
  const r = calc.deltasFromCounterSamples([
    { t_ms: 1, requests_total: 1, requests_2xx: 1 },
    { t_ms: 2, requests_total: null, requests_2xx: 1 },
  ]);
  red('missing_counter_fields',
    r.ok === false && r.fail_closed === true && r.code === calc.FAIL_CODES.MISSING_SAMPLES);
}

// --- RED: counter reset ---
{
  const r = calc.deltasFromCounterSamples([
    { t_ms: 1, requests_total: 100, requests_2xx: 99 },
    { t_ms: 2, requests_total: 50, requests_2xx: 49 },
  ]);
  red('counter_reset',
    r.ok === false && r.fail_closed === true && r.code === calc.FAIL_CODES.COUNTER_RESET);
}

// --- RED: out of order ---
{
  const r = calc.deltasFromCounterSamples([
    { t_ms: 10, requests_total: 1, requests_2xx: 1 },
    { t_ms: 10, requests_total: 2, requests_2xx: 2 },
  ]);
  red('out_of_order_equal_ts',
    r.ok === false && r.fail_closed === true && r.code === calc.FAIL_CODES.OUT_OF_ORDER);
}
{
  const r = calc.deltasFromCounterSamples([
    { t_ms: 20, requests_total: 1, requests_2xx: 1 },
    { t_ms: 10, requests_total: 2, requests_2xx: 2 },
  ]);
  red('out_of_order_decreasing_ts',
    r.ok === false && r.fail_closed === true && r.code === calc.FAIL_CODES.OUT_OF_ORDER);
}

// --- RED: zero traffic ---
{
  const r = calc.availabilitySliFromDeltas(0, 0);
  red('zero_traffic',
    r.ok === false && r.fail_closed === true && r.code === calc.FAIL_CODES.ZERO_TRAFFIC);
}

// --- RED: sparse / insufficient coverage ---
{
  // 2 samples spanning 7d with PT5M step → expected huge, coverage tiny
  const samples = [
    {
      t_ms: 0,
      requests_total: 0,
      requests_2xx: 0,
    },
    {
      t_ms: calc.SLO_WINDOW_MS,
      requests_total: 200,
      requests_2xx: 200,
      latency_histogram: { le_ms: [500, 1000], counts: [200, 200] },
    },
  ];
  const r = calc.evaluateReadinessWindow({
    samples,
    min_sample_coverage: 0.5,
    min_requests: 100,
  });
  red('sparse_insufficient_coverage',
    r.ok === false && r.fail_closed === true
    && r.code === calc.FAIL_CODES.INSUFFICIENT_COVERAGE,
    r.ok ? 'unexpected ok' : r.code);
}

// --- RED: insufficient requests ---
{
  const samples = buildSeries({
    steps: 12,
    per_step_total: 2,
    per_step_2xx: 2,
  });
  // 24 requests < 100
  const r = calc.evaluateReadinessWindow({
    samples,
    min_requests: 100,
    min_sample_coverage: 0.05,
  });
  red('insufficient_requests',
    r.ok === false && r.fail_closed === true
    && r.code === calc.FAIL_CODES.INSUFFICIENT_REQUESTS);
}

// --- RED: percentile misuse ---
{
  const avg = calc.latencySuccessRatioFromHistogram({ average_ms: 40 }, 500, 100);
  red('percentile_misuse_average_ms',
    avg.ok === false && avg.fail_closed === true
    && avg.code === calc.FAIL_CODES.PERCENTILE_MISUSE);
  const p99 = calc.latencySuccessRatioFromHistogram({ p99_ms: 44 }, 500, 100);
  red('percentile_misuse_scalar_p99',
    p99.ok === false && p99.fail_closed === true
    && p99.code === calc.FAIL_CODES.PERCENTILE_MISUSE);
}

// --- RED: invalid / non-cumulative histogram ---
{
  const r = calc.validateLatencyHistogram({
    le_ms: [100, 200],
    counts: [50, 40],
  }, 50);
  red('invalid_histogram_non_cumulative',
    r.ok === false && r.fail_closed === true
    && r.code === calc.FAIL_CODES.INVALID_HISTOGRAM);
}

// --- RED: overclaim tokens in owned docs ---
{
  // Scan prose only — exclude forbidden_claim_tokens inventories that list the phrases.
  const ownedText = [doc, findings].join('\n')
    .replace(/Does\s+\*\*not\*\*[^\n]*/gi, '')
    .replace(/does\s+not\s+[^\n]*/gi, '')
    .replace(/without\s+claiming[^\n]*/gi, '')
    .replace(/explicitly\s+not\s+claimed[^\n]*/gi, '')
    .replace(/—\s*\*\*not claimed\*\*[^\n]*/gi, '')
    .replace(/\*\*not claimed\*\*[^\n]*/gi, '')
    .replace(/not\s+claimed[^\n]*/gi, '')
    .replace(/\|\s*Does not prove\s*\|[^\n]*/gi, '');
  const patterns = [
    /\bcapacity\s+SLO\s+proven\b/i,
    /\berror\s+budget\s+proven\b/i,
    /\bSLO\s+proven\b/i,
    /\bfull\s+G06\b/i,
    /\bfull_G06_proven\b/i,
    /\bG06\s+proven\b/i,
    /\bbackpressure\s+proven\b/i,
    /\bautoscaling\s+proven\b/i,
    /\bload\s+soak\s+proven\b/i,
    /\balert\s+fired\b/i,
    /\bnotification\s+delivered\b/i,
  ];
  const hits = patterns.filter((re) => re.test(ownedText));
  red('overclaim_tokens_absent_from_owned_docs',
    hits.length === 0,
    hits.length ? hits.map((r) => String(r)).join(', ') : ownedText.match(/SLO proven|G06 proven|full G06|alert fired/i)?.[0]);
}

// --- GREEN: disposition / score / selection ---
{
  const g06 = matrix.gates.find((g) => g.id === locks.GATE_ID);
  const sel = matrix.slice_16aj_selection;
  green('g06_remains_partial_score_unchanged',
    g06
    && g06.verdict === 'partial'
    && /16AJ/.test(g06.rationale)
    && Array.isArray(g06.gaps)
    && g06.gaps.some((x) => /SLO|error.?budget/i.test(String(x)))
    && g06.gaps.some((x) => /soak/i.test(String(x)))
    && g06.gaps.some((x) => /autoscal/i.test(String(x)))
    && g06.gaps.some((x) => /backpressure/i.test(String(x)))
    && !/\bG06\s+proven\b/i.test(String(g06.rationale))
    && topContract.expected_verdict_counts.proven === 0
    && topContract.expected_verdict_counts.partial === 9
    && topContract.expected_verdict_counts.absent === 0
    && matrix.verdict_counts.proven === 0
    && matrix.verdict_counts.partial === 9);
  green('selection_16aj_source_only',
    sel
    && sel.selected === true
    && sel.outcome_id === locks.OUTCOME_ID
    && sel.gate_id === locks.GATE_ID
    && sel.progress_class === locks.PROGRESS_CLASS
    && sel.final_controlled_drill.status === 'offline_source_proven'
    && sel.g06_slo_source === 'source_defined_via_16AJ'
    && sel.g06_slo === 'open'
    && sel.g06_verdict === 'partial'
    && topContract.selected_16aj
    && topContract.selected_16aj.outcome_id === locks.OUTCOME_ID
    && topContract.selected_16aj.g06_slo_source === 'source_defined_via_16AJ'
    && topContract.selected_16aj.g06_slo === 'open'
    && topContract.g06_slo_source === 'source_defined_via_16AJ'
    && topContract.g06_slo === 'open');
}

green('doc_findings_mention_16aj_without_slo_proven',
  /16AJ/i.test(doc)
  && /16AJ/i.test(findings)
  && /source/i.test(doc)
  && /G06.*partial|partial.*G06/i.test(doc)
  && !/\bG06\s+proven\b/i.test(doc)
  && !/\bcapacity\s+SLO\s+proven\b/i.test(doc)
  && !/\bSLO\s+proven\b/i.test(doc)
  && !/\bfull\s+G06\b/i.test(doc)
  && /defined_not_executed/i.test(doc));

green('16ai_conservative_live_proven_retained',
  topContract.selected_16ai
  && topContract.selected_16ai.g06_conservative_readyz_bounded_load === 'live_proven_via_16AI'
  && topContract.conservative_readyz_bounded_load === 'live_proven_via_16AI'
  && matrix.slice_16ai_selection
  && matrix.slice_16ai_selection.g06_conservative_readyz_bounded_load === 'live_proven_via_16AI'
  && /16AI/.test(doc));

{
  const pkg = readJson('package.json');
  green('package_script_registered',
    pkg.scripts
    && pkg.scripts['verify:radar-slice16aj-g06-slo-error-budget']
      === 'node scripts/verify-radar-slice16aj-g06-slo-error-budget.js');
}

green('runtime_paths_unchanged', runtimePathsUnchanged().ok, runtimePathsUnchanged().detail);

{
  const texts = [doc, findings, JSON.stringify(contract), JSON.stringify(design), calcSrc, verifySrc];
  let allOk = true;
  let detail = '';
  for (let i = 0; i < texts.length; i += 1) {
    const s = secretFree(texts[i], `blob${i}`);
    if (!s.ok) {
      allOk = false;
      detail = s.detail;
      break;
    }
  }
  green('secret_free', allOk, detail);
}

green('informed_by_existing_metrics_not_invented_live',
  /Requests/i.test(JSON.stringify(design.metric_surface_inspected))
  && /statusCodeCategory/i.test(JSON.stringify(design.metric_surface_inspected))
  && /PT5M/i.test(JSON.stringify(design.metric_surface_inspected))
  && /16AI/i.test(JSON.stringify(contract.informed_by_existing))
  && /does NOT become SLO proof|not SLO/i.test(JSON.stringify(design.metric_surface_inspected))
  && contract.final_controlled_drill.status === 'offline_source_proven');

console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('RADAR 16AJ G06 SLO / error-budget source (partial/source-only): PASS');
