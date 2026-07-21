'use strict';

/**
 * verify:radar-slice16aj-g06-slo-error-budget — RADAR Slice 16AJ
 *
 * Offline RED/GREEN for G06 capacity SLO / error-budget source contract.
 * Availability-only ACA Requests Sum SLI; exact PT7D; burn baseline grain;
 * reviewer RED examples. No network / live / deploy.
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

/** Build regular PT5M cumulative counter series (no latency fields). */
function buildSeries(opts) {
  const o = opts || {};
  const steps = o.steps == null ? 24 : o.steps;
  const stepMs = o.step_ms == null ? calc.SAMPLE_STEP_MS : o.step_ms;
  const start = o.start_t_ms == null ? 1_000_000 : o.start_t_ms;
  const perStepTotal = o.per_step_total == null ? 10 : o.per_step_total;
  const perStep2xx = o.per_step_2xx == null ? perStepTotal : o.per_step_2xx;

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
  return samples;
}

function buildExactPt7dSeries(opts) {
  const o = opts || {};
  const steps = calc.SLO_WINDOW_MS / calc.SAMPLE_STEP_MS;
  return buildSeries(Object.assign({}, o, { steps }));
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

ok('C6 availability-only SLI locks match calculator',
  locks.SLI_LOCK.kind === 'availability_only'
  && locks.SLI_LOCK.availability.target === calc.AVAILABILITY_TARGET
  && locks.SLI_LOCK.availability.aggregation === 'Total'
  && locks.SLI_LOCK.availability.aggregation_semantics === 'sum_of_request_counts'
  && locks.SLI_LOCK.availability.good_dimension.name === 'statusCodeCategory'
  && locks.SLI_LOCK.latency_percentile_sli.status === 'blocked'
  && locks.SLI_LOCK.combined.status === 'forbidden'
  && locks.SLI_LOCK.window.slo_window_ms === calc.SLO_WINDOW_MS
  && locks.SLI_LOCK.window.sample_step_ms === calc.SAMPLE_STEP_MS
  && locks.SLI_LOCK.window.min_sample_coverage === calc.MIN_SAMPLE_COVERAGE
  && locks.SLI_LOCK.window.min_requests === calc.MIN_REQUESTS
  && contract.sli.availability_target === calc.AVAILABILITY_TARGET
  && contract.sli.kind === 'availability_only'
  && design.sli_contract.availability_target === calc.AVAILABILITY_TARGET
  && design.sli_contract.kind === 'availability_only'
  && !Object.prototype.hasOwnProperty.call(calc, 'LATENCY_OBJECTIVE_MS')
  && !Object.prototype.hasOwnProperty.call(calc, 'COMBINED_TARGET')
  && typeof calc.latencySuccessRatioFromHistogram !== 'function'
  && typeof calc.validateLatencyHistogram !== 'function');

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

// --- GREEN: exact PT7D readiness window healthy ---
{
  const samples = buildExactPt7dSeries({
    per_step_total: 1,
    per_step_2xx: 1,
  });
  const r = calc.evaluateReadinessWindow({
    samples,
    min_requests: 100,
    min_sample_coverage: 0.5,
  });
  green('readiness_window_exact_pt7d_healthy',
    r.ok && r.meets_availability === true && r.sli_kind === 'availability_only'
    && r.window_ms === calc.SLO_WINDOW_MS
    && r.coverage_reference_window_ms === calc.SLO_WINDOW_MS
    && r.latency_percentile_sli.status === 'blocked'
    && nearlyEqual(r.availability.sli, 1),
    r.ok ? JSON.stringify({ sli: r.availability.sli, cov: r.coverage }) : (r.errors || []).join(' | '));
}

// --- GREEN: multi-window burn all quiet on healthy series ---
{
  const steps = Math.ceil((3 * 24 * 60 * 60 * 1000) / calc.SAMPLE_STEP_MS) + 2;
  const samples = buildSeries({
    steps,
    per_step_total: 2,
    per_step_2xx: 2,
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
  const samples = buildSeries({
    steps,
    per_step_total: 10,
    per_step_2xx: 8,
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
    && r.short.coverage_reference_window_ms === pair.short_ms
    && r.long.coverage_reference_window_ms === pair.long_ms
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
    { t_ms: 0, requests_total: 1, requests_2xx: 1 },
    { t_ms: calc.SAMPLE_STEP_MS, requests_total: null, requests_2xx: 1 },
  ]);
  red('missing_counter_fields',
    r.ok === false && r.fail_closed === true && r.code === calc.FAIL_CODES.MISSING_SAMPLES);
}

// --- RED: counter reset ---
{
  const r = calc.deltasFromCounterSamples([
    { t_ms: 0, requests_total: 100, requests_2xx: 99 },
    { t_ms: calc.SAMPLE_STEP_MS, requests_total: 50, requests_2xx: 49 },
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
    { t_ms: calc.SAMPLE_STEP_MS * 2, requests_total: 1, requests_2xx: 1 },
    { t_ms: calc.SAMPLE_STEP_MS, requests_total: 2, requests_2xx: 2 },
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

// --- RED: 5-minute fragment (not exact PT7D) ---
{
  const samples = buildSeries({ steps: 1, per_step_total: 200, per_step_2xx: 200 });
  const r = calc.evaluateReadinessWindow({
    samples,
    min_sample_coverage: 0.5,
    min_requests: 100,
  });
  red('five_minute_fragment_not_exact_pt7d',
    r.ok === false && r.fail_closed === true
    && r.code === calc.FAIL_CODES.WINDOW_SPAN_MISMATCH,
    r.ok ? 'unexpected ok' : r.code);
}

// --- RED: sparse / insufficient coverage against PT7D ---
{
  // Build exact PT7D span but with only endpoints → irregular grain fails first;
  // use coverage helper directly with NaN-safe path via sparse sample_count.
  const cov = calc.sampleCoverage(2, calc.SLO_WINDOW_MS, calc.SAMPLE_STEP_MS, 0.5);
  red('sparse_insufficient_coverage_against_pt7d',
    cov.ok === false && cov.fail_closed === true
    && cov.code === calc.FAIL_CODES.INSUFFICIENT_COVERAGE,
    cov.ok ? 'unexpected ok' : cov.code);
}

// --- RED: insufficient requests on exact PT7D ---
{
  const samples = buildExactPt7dSeries({
    per_step_total: 0,
    per_step_2xx: 0,
  });
  // Force a tiny nonzero delta below min by patching last counters
  samples[samples.length - 1].requests_total = 50;
  samples[samples.length - 1].requests_2xx = 50;
  const r = calc.evaluateReadinessWindow({
    samples,
    min_requests: 100,
    min_sample_coverage: 0.5,
  });
  red('insufficient_requests',
    r.ok === false && r.fail_closed === true
    && r.code === calc.FAIL_CODES.INSUFFICIENT_REQUESTS);
}

// --- RED: reviewer [400,1000] — histogram API deleted / latency blocked ---
{
  const b = calc.exactBoundaryCases();
  red('histogram_api_deleted_no_exact_bucket_400_1000',
    typeof calc.latencySuccessRatioFromHistogram !== 'function'
    && typeof calc.validateLatencyHistogram !== 'function'
    && Array.isArray(b.rejected_histogram_le_ms)
    && b.rejected_histogram_le_ms[0] === 400
    && b.rejected_histogram_le_ms[1] === 1000
    && !b.rejected_histogram_le_ms.includes(500)
    && calc.LATENCY_PERCENTILE_SLI.status === 'blocked'
    && calc.LATENCY_PERCENTILE_SLI.not_part_of_this_slo === true
    && calc.LATENCY_PERCENTILE_SLI.aca_duration_histogram === 'nonexistent_not_relied_upon');
}
{
  const samples = buildExactPt7dSeries({ per_step_total: 1, per_step_2xx: 1 });
  const r = calc.evaluateReadinessWindow({
    samples,
    latency_histogram: { le_ms: [400, 1000], counts: [99, 100] },
    latency_objective_ms: 500,
  });
  red('latency_histogram_binding_blocked',
    r.ok === false && r.fail_closed === true
    && r.code === calc.FAIL_CODES.LATENCY_SLI_BLOCKED);
}

// --- RED: disjoint marginals — no combined claim ---
{
  const r = calc.rejectCombinedFromDisjointMarginals(0.99, 0.99, 0.99);
  red('disjoint_marginals_no_combined_claim',
    r.ok === false && r.fail_closed === true
    && r.code === calc.FAIL_CODES.COMBINED_CLAIM_FORBIDDEN);
}
{
  const samples = buildExactPt7dSeries({ per_step_total: 1, per_step_2xx: 1 });
  const r = calc.evaluateReadinessWindow({
    samples,
    combined_target: 0.99,
  });
  red('combined_target_option_forbidden',
    r.ok === false && r.fail_closed === true
    && r.code === calc.FAIL_CODES.COMBINED_CLAIM_FORBIDDEN);
}

// --- RED: 55-minute stale baseline ---
{
  const step = calc.SAMPLE_STEP_MS;
  const windowMs = 60 * 60 * 1000; // 1h burn window
  const end = 10_000_000;
  const startT = end - windowMs;
  const staleSkew = 55 * 60 * 1000;
  // One stale prior (55m early) + regular in-window samples missing startT.
  const staleSeries = [];
  staleSeries.push({
    t_ms: startT - staleSkew,
    requests_total: 0,
    requests_2xx: 0,
  });
  let sTot = 100;
  let sOk = 80;
  for (let tt = startT + step; tt <= end; tt += step) {
    staleSeries.push({ t_ms: tt, requests_total: sTot, requests_2xx: sOk });
    sTot += 10;
    sOk += 8;
  }
  const sliced = calc.sliceSamplesForWindow(staleSeries, windowMs, step);
  red('fifty_five_minute_stale_baseline',
    sliced.ok === false && sliced.fail_closed === true
    && sliced.code === calc.FAIL_CODES.STALE_BASELINE,
    sliced.ok ? 'unexpected ok' : sliced.code);
}

// --- RED: MAX_SAFE overflow ---
{
  const r = calc.deltasFromCounterSamples([
    { t_ms: 0, requests_total: Number.MAX_SAFE_INTEGER, requests_2xx: 1 },
    {
      t_ms: calc.SAMPLE_STEP_MS,
      requests_total: Number.MAX_SAFE_INTEGER + 1,
      requests_2xx: 2,
    },
  ]);
  red('max_safe_integer_overflow',
    r.ok === false && r.fail_closed === true
    && (r.code === calc.FAIL_CODES.UNSAFE_INTEGER
      || r.code === calc.FAIL_CODES.INVALID_INPUT),
    r.ok ? 'unexpected ok' : r.code);
}
{
  const r = calc.availabilitySliFromDeltas(Number.MAX_SAFE_INTEGER + 1, 1);
  red('max_safe_delta_rejected',
    r.ok === false && r.fail_closed === true
    && r.code === calc.FAIL_CODES.UNSAFE_INTEGER);
}

// --- RED: NaN coverage ---
{
  const cov = calc.sampleCoverage(10, NaN, calc.SAMPLE_STEP_MS, 0.5);
  red('nan_coverage_rejected',
    cov.ok === false && cov.fail_closed === true
    && cov.code === calc.FAIL_CODES.INVALID_INPUT);
}
{
  const cov = calc.sampleCoverage(10, calc.SLO_WINDOW_MS, NaN, 0.5);
  red('nan_step_coverage_rejected',
    cov.ok === false && cov.fail_closed === true
    && cov.code === calc.FAIL_CODES.INVALID_INPUT);
}

// --- RED: overclaim tokens in owned docs ---
{
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
    /\bp99\s*<=\s*500ms\b/i,
    /\bcombined\s+SLO\s+proven\b/i,
  ];
  const hits = patterns.filter((re) => re.test(ownedText));
  red('overclaim_tokens_absent_from_owned_docs',
    hits.length === 0,
    hits.length ? hits.map((r) => String(r)).join(', ') : undefined);
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
  && /availability-only|availability only/i.test(doc)
  && /G06.*partial|partial.*G06/i.test(doc)
  && /blocked/i.test(doc)
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
  && /blocked/i.test(JSON.stringify(design.metric_surface_inspected.latency_percentile_sli))
  && /16AI/i.test(JSON.stringify(contract.informed_by_existing))
  && /does NOT become SLO proof|not SLO/i.test(JSON.stringify(design.metric_surface_inspected))
  && contract.final_controlled_drill.status === 'offline_source_proven');

console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('RADAR 16AJ G06 SLO / error-budget source (partial/source-only): PASS');
