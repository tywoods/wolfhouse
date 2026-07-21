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
  // 16AL owns a bounded Staff API admission wire + readiness shutdown-BEGIN hook;
  // exclude those paths on later tips.
  const paths = locks.MUST_NOT_MUTATE.filter((p) =>
    p !== 'scripts/staff-query-api.js'
    && p !== 'scripts/lib/staff-api-readiness-lifecycle.js');
  try {
    const out = execSync(
      `git diff --name-only ${locks.MASTER_BASIS} -- ${paths.join(' ')}`,
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

/**
 * Build a regular PT5M series spanning a locked burn pair's long window, with
 * all request delta concentrated in the final grain so both short and long
 * legs observe the exact (total, bad) counts. Used to exercise private BigInt
 * burn decisions exclusively through evaluateBurnPair.
 */
function buildBurnCountSeries(pair, total, bad) {
  const step = calc.SAMPLE_STEP_MS;
  const steps = pair.long_ms / step;
  const start = 1_000_000;
  const good = total - bad;
  const samples = [];
  for (let i = 0; i <= steps; i += 1) {
    samples.push({
      t_ms: start + i * step,
      requests_total: i === steps ? total : 0,
      requests_2xx: i === steps ? good : 0,
    });
  }
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

const tip16am = matrix.slice === 'RADAR-16AM'
  && matrix.branch === 'radar/slice-16am-g06-backpressure-deploy-evidence';
const tip16al = matrix.slice === 'RADAR-16AL'
  && matrix.branch === 'radar/slice-16al-g06-backpressure-wire';
const tip16ak = matrix.slice === 'RADAR-16AK'
  && matrix.branch === 'radar/slice-16ak-g06-backpressure-source';
const tipSuccessor = tip16am || tip16al || tip16ak;
const tipBranchOk = (tip16am && currentBranch() === 'radar/slice-16am-g06-backpressure-deploy-evidence')
  || (tip16al && currentBranch() === 'radar/slice-16al-g06-backpressure-wire')
  || (tip16ak && currentBranch() === 'radar/slice-16ak-g06-backpressure-source');
ok('C1 HEAD on 16AJ branch (or later tip)', currentBranch() === locks.BRANCH || tipBranchOk, currentBranch());
ok('C2 master_basis locked (16AJ lock or later tip)',
  tipSuccessor
    ? (contract.master_basis === locks.MASTER_BASIS
      && design.master_basis === locks.MASTER_BASIS
      && (tip16am
        ? (matrix.master_basis === '905ff9ff57a75d0b3defc15a16078b47e94e930f'
          && topContract.master_basis === '905ff9ff57a75d0b3defc15a16078b47e94e930f')
        : tip16al
        ? (matrix.master_basis === '502d762f897432c67bb8b17a8a49bfab01a0787d'
          && topContract.master_basis === '502d762f897432c67bb8b17a8a49bfab01a0787d')
        : (matrix.master_basis === '9fa3626326c0e2bc21f2d37905967d6ff47b7520'
          && topContract.master_basis === '9fa3626326c0e2bc21f2d37905967d6ff47b7520')))
    : (contract.master_basis === locks.MASTER_BASIS
      && design.master_basis === locks.MASTER_BASIS
      && matrix.master_basis === locks.MASTER_BASIS
      && topContract.master_basis === locks.MASTER_BASIS));
ok('C3 slice/outcome/branch locked (16AJ lock or later tip)',
  tipSuccessor
    ? (contract.slice === locks.SLICE
      && contract.outcome_id === locks.OUTCOME_ID
      && contract.branch === locks.BRANCH
      && design.slice === locks.SLICE
      && design.outcome_id === locks.OUTCOME_ID
      && (tip16am
        ? (matrix.slice === 'RADAR-16AM' && topContract.slice === 'RADAR-16AM')
        : tip16al
        ? (matrix.slice === 'RADAR-16AL' && topContract.slice === 'RADAR-16AL')
        : (matrix.slice === 'RADAR-16AK' && topContract.slice === 'RADAR-16AK')))
    : (contract.slice === locks.SLICE
      && contract.outcome_id === locks.OUTCOME_ID
      && contract.branch === locks.BRANCH
      && design.slice === locks.SLICE
      && design.outcome_id === locks.OUTCOME_ID
      && matrix.slice === locks.SLICE
      && matrix.branch === locks.BRANCH
      && topContract.slice === locks.SLICE
      && topContract.branch === locks.BRANCH));

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

ok('C7 multi-window burns locked (4 pairs + exact rationals)',
  calc.MULTI_WINDOW_BURNS.length === 4
  && contract.error_budget.multi_window_burns.length === 4
  && design.multi_window_burns.length === 4
  && calc.MULTI_WINDOW_BURNS[0].id === 'page_fast'
  && calc.MULTI_WINDOW_BURNS[0].burn_threshold === 14.4
  && calc.MULTI_WINDOW_BURNS[0].burn_threshold_rational.num === 144
  && calc.MULTI_WINDOW_BURNS[0].burn_threshold_rational.den === 10
  && calc.MULTI_WINDOW_BURNS[3].id === 'ticket_slow'
  && calc.MULTI_WINDOW_BURNS[3].burn_threshold === 1
  && calc.MULTI_WINDOW_BURNS[3].burn_threshold_rational.num === 1
  && calc.MULTI_WINDOW_BURNS[3].burn_threshold_rational.den === 1
  && !/\bburn_rate\s*\+\s*1e-12\s*>=/.test(calcSrc)
  && /burnRateMeetsThresholdExact/.test(calcSrc)
  && /CONTRACT_DRIFT/.test(calcSrc));

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
  const meetExact = calc.availabilityMeetsTargetExact(b.meet_counts.good, b.meet_counts.total);
  const missExact = calc.availabilityMeetsTargetExact(b.miss_counts.good, b.miss_counts.total);
  green('availability_boundary_99_of_100_meets',
    meet.ok && nearlyEqual(meet.sli, 0.99)
    && meetExact.ok && meetExact.meets === true);
  green('availability_boundary_98_of_100_misses',
    miss.ok && nearlyEqual(miss.sli, 0.98)
    && missExact.ok && missExact.meets === false);
}

// --- GREEN: exact unit burn and 14.4x burn via locked public evaluators ---
{
  const b = calc.exactBoundaryCases();
  // Unit burn (bad_rate 0.01 → burn=1) through locked readiness eval (PT7D).
  const unitSamples = buildExactPt7dSeries({
    per_step_total: 100,
    per_step_2xx: 99,
  });
  const unit = calc.evaluateReadinessWindow({ samples: unitSamples });
  // 14.4x burn through locked page_fast long leg (1h window).
  const pageFast = calc.MULTI_WINDOW_BURNS[0];
  const fastSamples = buildSeries({
    steps: pageFast.long_ms / calc.SAMPLE_STEP_MS,
    per_step_total: 1000,
    per_step_2xx: 856, // bad_rate 0.144
  });
  const fast = calc.evaluateBurnPair(fastSamples, 'page_fast');
  green('error_budget_unit_burn_exact',
    unit.ok && nearlyEqual(unit.burn.burn_rate, b.unit_burn_expected)
    && nearlyEqual(unit.burn.budget, calc.ERROR_BUDGET_FRACTION)
    && nearlyEqual(unit.availability.sli, 0.99),
    unit.ok ? `burn=${unit.burn.burn_rate}` : (unit.errors || []).join(' | '));
  green('error_budget_fast_burn_14_4_exact',
    fast.ok
    && nearlyEqual(fast.long.burn_rate, b.fast_burn_expected)
    && nearlyEqual(
      fast.long.budget_consumed_fraction,
      b.fast_burn_expected * (pageFast.long_ms / calc.SLO_WINDOW_MS),
    )
    && nearlyEqual(fast.short.burn_rate, b.fast_burn_expected),
    fast.ok
      ? `long_burn=${fast.long.burn_rate} consumed=${fast.long.budget_consumed_fraction}`
      : (fast.errors || []).join(' | '));
}

// --- GREEN: exact equality / just-above / strictly-below via locked pair ids ---
{
  const b = calc.exactBoundaryCases();
  let allOk = true;
  let detail = '';
  for (let i = 0; i < b.burn_boundaries.length; i += 1) {
    const row = b.burn_boundaries[i];
    const pair = calc.MULTI_WINDOW_BURNS.find((p) => p.id === row.id);
    const belowR = calc.evaluateBurnPair(
      buildBurnCountSeries(pair, row.total, row.bad_below),
      row.id,
    );
    const eqR = calc.evaluateBurnPair(
      buildBurnCountSeries(pair, row.total, row.bad_eq),
      row.id,
    );
    const aboveR = calc.evaluateBurnPair(
      buildBurnCountSeries(pair, row.total, row.bad_above),
      row.id,
    );
    if (!(belowR.ok && belowR.short.exceeds_threshold === false
      && belowR.long.exceeds_threshold === false
      && eqR.ok && eqR.short.exceeds_threshold === true
      && eqR.long.exceeds_threshold === true
      && aboveR.ok && aboveR.short.exceeds_threshold === true
      && aboveR.long.exceeds_threshold === true)) {
      allOk = false;
      detail = `${row.id} below=${belowR.ok && belowR.short.exceeds_threshold}`
        + ` eq=${eqR.ok && eqR.short.exceeds_threshold}`
        + ` above=${aboveR.ok && aboveR.short.exceeds_threshold}`;
      break;
    }
  }
  green('burn_threshold_exact_below_eq_above_all_four', allOk, detail);
}

// --- GREEN: exact PT7D readiness window healthy ---
{
  const samples = buildExactPt7dSeries({
    per_step_total: 1,
    per_step_2xx: 1,
  });
  const r = calc.evaluateReadinessWindow({ samples });
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
  const all = calc.evaluateAllLockedBurnPairs(samples);
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
  const r = calc.evaluateBurnPair(samples, 'page_fast');
  green('page_fast_would_fire_on_20pct_bad',
    r.ok && r.would_fire === true
    && r.id === 'page_fast'
    && r.short.exceeds_threshold === true
    && r.long.exceeds_threshold === true
    && r.short.coverage_reference_window_ms === pair.short_ms
    && r.long.coverage_reference_window_ms === pair.long_ms
    && r.alert_status === 'defined_not_executed',
    r.ok ? `short=${r.short.burn_rate} long=${r.long.burn_rate}` : (r.errors || []).join(' | '));
}

// --- RED: alternate public path — 50m + 0/1 custom pair object injection ---
{
  const steps = Math.ceil((60 * 60 * 1000) / calc.SAMPLE_STEP_MS) + 2;
  const samples = buildSeries({
    steps,
    per_step_total: 10,
    per_step_2xx: 8,
  });
  const custom50m01 = {
    id: 'custom_50m',
    severity: 'page',
    short_ms: 50 * 60 * 1000,
    long_ms: 60 * 60 * 1000,
    burn_threshold: 0,
    burn_threshold_rational: { num: 0, den: 1 },
  };
  const viaObject = calc.evaluateBurnPair(samples, custom50m01);
  const viaOptsWindow = calc.evaluateBurnPair(samples, 'page_fast', {
    short_ms: 50 * 60 * 1000,
    burn_threshold_rational: { num: 0, den: 1 },
  });
  const viaAllOpts = calc.evaluateAllLockedBurnPairs(samples, {
    long_ms: 50 * 60 * 1000,
    burn_threshold: 0,
  });
  const unknownId = calc.evaluateBurnPair(samples, 'not_a_locked_pair');
  red('custom_50m_0_1_pair_object_injection_rejected',
    viaObject.ok === false && viaObject.fail_closed === true
    && viaObject.code === calc.FAIL_CODES.INVALID_INPUT
    && /object|injection|locked string id/i.test((viaObject.errors || []).join(' ')),
    viaObject.ok ? 'unexpected ok' : (viaObject.errors || []).join(' | '));
  red('burn_opts_window_threshold_injection_rejected',
    viaOptsWindow.ok === false && viaOptsWindow.fail_closed === true
    && viaOptsWindow.code === calc.FAIL_CODES.INVALID_INPUT
    && viaAllOpts.ok === false && viaAllOpts.fail_closed === true
    && viaAllOpts.code === calc.FAIL_CODES.INVALID_INPUT,
    viaOptsWindow.ok || viaAllOpts.ok
      ? 'unexpected ok'
      : `${viaOptsWindow.code}/${viaAllOpts.code}`);
  red('unknown_burn_pair_id_rejected',
    unknownId.ok === false && unknownId.fail_closed === true
    && unknownId.code === calc.FAIL_CODES.INVALID_INPUT
    && /unknown burn pair id/i.test((unknownId.errors || []).join(' ')),
    unknownId.ok ? 'unexpected ok' : (unknownId.errors || []).join(' | '));
}

// --- RED: direct availabilityBurnLeg access unexported (no alternate path) ---
{
  red('availability_burn_leg_unexported_no_direct_access',
    typeof calc.availabilityBurnLeg !== 'function'
    && !Object.prototype.hasOwnProperty.call(calc, 'availabilityBurnLeg')
    && typeof calc.evaluateAllBurnPairs !== 'function'
    && typeof calc.evaluateAllLockedBurnPairs === 'function'
    && typeof calc.evaluateBurnPair === 'function');
}

// --- RED: exact burn helpers unexported (no caller target/window/threshold path) ---
{
  red('burn_exact_helpers_unexported',
    typeof calc.burnRateMeetsThresholdExact !== 'function'
    && typeof calc.burnFromBadRate !== 'function'
    && typeof calc.errorBudgetFraction !== 'function'
    && !Object.prototype.hasOwnProperty.call(calc, 'burnRateMeetsThresholdExact')
    && !Object.prototype.hasOwnProperty.call(calc, 'burnFromBadRate')
    && !Object.prototype.hasOwnProperty.call(calc, 'errorBudgetFraction'));
}

// --- RED: exhaustive production export audit — no free target/window/SLO/threshold ---
{
  const exportNames = Object.keys(calc).sort();
  const bannedExactHelpers = [
    'burnRateMeetsThresholdExact',
    'burnFromBadRate',
    'errorBudgetFraction',
    'availabilityBurnLeg',
    'evaluateAllBurnPairs',
  ];
  const bannedPresent = bannedExactHelpers.filter((k) => exportNames.includes(k));

  // Exhaustive production function allowlist. Locked readiness + burn-pair
  // evaluators are the only evaluation surface; utilities do not accept free
  // caller target / SLO-window / threshold-rational for burn decisions.
  const allowedFns = new Set([
    'failClosed',
    'rejectContractDrift',
    'rejectLatencyOrCombinedOptions',
    'rejectCombinedFromDisjointMarginals',
    'availabilityMeetsTargetExact',
    'validateCounterSeries',
    'deltasFromCounterSamples',
    'sampleCoverage',
    'availabilitySliFromDeltas',
    'evaluateReadinessWindow',
    'sliceSamplesForWindow',
    'evaluateBurnPair',
    'evaluateAllLockedBurnPairs',
    'exactBoundaryCases',
  ]);
  const fnExports = exportNames.filter((k) => typeof calc[k] === 'function');
  const unexpectedFns = fnExports.filter((k) => !allowedFns.has(k));
  const lockedEvalSurface = [
    'evaluateReadinessWindow',
    'evaluateBurnPair',
    'evaluateAllLockedBurnPairs',
  ];
  const lockedPresent = lockedEvalSurface.every((k) => typeof calc[k] === 'function');

  // No exported function signature accepts free caller target / windowMs+burn /
  // sloWindowMs / thresholdRational (private exact-math surface).
  const bannedSigRe = /\b(badRate|thresholdRational|pairThresholdRational|sloWindowMs)\b/;
  const freeParamFns = fnExports.filter((k) => {
    const src = Function.prototype.toString.call(calc[k]);
    const brace = src.indexOf('{');
    const sig = brace === -1 ? src : src.slice(0, brace);
    if (bannedSigRe.test(sig)) return true;
    // errorBudgetFraction(target) / burnFromBadRate(..., target, ...)
    if (/\btarget\b/.test(sig) && !/^function rejectContractDrift/.test(sig)
      && k !== 'rejectContractDrift') {
      return true;
    }
    return false;
  });

  const samples = buildSeries({ steps: 20, per_step_total: 5, per_step_2xx: 4 });
  const idOnlyOk = calc.evaluateBurnPair(samples, 'page_fast');
  const objectRejected = calc.evaluateBurnPair(samples, {
    id: 'page_fast',
    short_ms: 50 * 60 * 1000,
    long_ms: 60 * 60 * 1000,
    burn_threshold: 0,
    burn_threshold_rational: { num: 0, den: 1 },
  });
  const targetInject = calc.evaluateBurnPair(samples, 'page_fast', {
    availability_target: 0.5,
  });
  const sloWindowInject = calc.evaluateBurnPair(samples, 'page_fast', {
    slo_window_ms: 60 * 60 * 1000,
  });
  const windowInject = calc.evaluateBurnPair(samples, 'page_fast', {
    window_ms: 50 * 60 * 1000,
  });
  const thrInject = calc.evaluateBurnPair(samples, 'page_fast', {
    burn_threshold_rational: { num: 0, den: 1 },
  });
  const readinessTargetInject = calc.evaluateReadinessWindow({
    samples: buildExactPt7dSeries({ per_step_total: 1, per_step_2xx: 1 }),
    availability_target: 0.5,
  });
  const readinessSloInject = calc.evaluateReadinessWindow({
    samples: buildExactPt7dSeries({ per_step_total: 1, per_step_2xx: 1 }),
    slo_window_ms: 60 * 60 * 1000,
  });

  red('no_alternate_burn_export_accepts_caller_windows_thresholds',
    bannedPresent.length === 0
    && unexpectedFns.length === 0
    && freeParamFns.length === 0
    && lockedPresent
    && idOnlyOk.ok === true
    && objectRejected.ok === false
    && objectRejected.fail_closed === true
    && targetInject.ok === false && targetInject.fail_closed === true
    && sloWindowInject.ok === false && sloWindowInject.fail_closed === true
    && windowInject.ok === false && windowInject.fail_closed === true
    && thrInject.ok === false && thrInject.fail_closed === true
    && readinessTargetInject.ok === false && readinessTargetInject.fail_closed === true
    && readinessSloInject.ok === false && readinessSloInject.fail_closed === true
    && typeof calc.availabilityBurnLeg !== 'function'
    && typeof calc.burnRateMeetsThresholdExact !== 'function'
    && typeof calc.burnFromBadRate !== 'function'
    && typeof calc.errorBudgetFraction !== 'function',
    bannedPresent.length
      ? `banned exports: ${bannedPresent.join(',')}`
      : (unexpectedFns.length
        ? `unexpected fns: ${unexpectedFns.join(',')}`
        : (freeParamFns.length
          ? `free-param fns: ${freeParamFns.join(',')}`
          : (objectRejected.ok ? 'object accepted' : undefined))));
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
  const r = calc.evaluateReadinessWindow({ samples });
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
  const r = calc.evaluateReadinessWindow({ samples });
  red('insufficient_requests',
    r.ok === false && r.fail_closed === true
    && r.code === calc.FAIL_CODES.INSUFFICIENT_REQUESTS);
}

// --- RED: contract drift — PT10M sample_step_ms override ---
{
  const samples = buildExactPt7dSeries({ per_step_total: 1, per_step_2xx: 1 });
  const r = calc.evaluateReadinessWindow({
    samples,
    sample_step_ms: 10 * 60 * 1000, // PT10M
  });
  red('pt10m_sample_step_override_rejected',
    r.ok === false && r.fail_closed === true
    && r.code === calc.FAIL_CODES.CONTRACT_DRIFT,
    r.ok ? 'unexpected ok' : r.code);
}

// --- RED: contract drift — 0.98 availability_target override ---
{
  const samples = buildExactPt7dSeries({ per_step_total: 1, per_step_2xx: 1 });
  const r = calc.evaluateReadinessWindow({
    samples,
    availability_target: 0.98,
  });
  red('availability_target_0_98_override_rejected',
    r.ok === false && r.fail_closed === true
    && r.code === calc.FAIL_CODES.CONTRACT_DRIFT,
    r.ok ? 'unexpected ok' : r.code);
}

// --- RED: reviewer sub-threshold safe-integer — float+eps would fire; exact must not ---
{
  const b = calc.exactBoundaryCases();
  const row = b.reviewer_sub_threshold_safe_integer;
  const pageFast = calc.MULTI_WINDOW_BURNS.find((p) => p.id === 'page_fast');
  const r = calc.evaluateBurnPair(
    buildBurnCountSeries(pageFast, row.total, row.bad),
    'page_fast',
  );
  const floatBurn = (row.bad / row.total) / 0.01;
  const floatEpsWouldFire = floatBurn + 1e-12 >= row.burn_threshold;
  red('reviewer_sub_threshold_safe_integer_no_fire',
    Number.isSafeInteger(row.total)
    && Number.isSafeInteger(row.bad)
    && r.ok
    && r.short.exceeds_threshold === false
    && r.long.exceeds_threshold === false
    && r.would_fire === false
    && r.short.exceeds_threshold === row.exact_must_fire
    && floatEpsWouldFire === true
    && floatEpsWouldFire === row.float_eps_would_fire
    && typeof calc.burnRateMeetsThresholdExact !== 'function',
    r.ok
      ? `exceeds=${r.short.exceeds_threshold} floatBurn=${floatBurn} floatEps=${floatEpsWouldFire}`
      : (r.errors || []).join(' | '));
}

// --- RED: exact equality fires and just-below does not (all four; via locked pairs) ---
{
  const b = calc.exactBoundaryCases();
  let allOk = true;
  let detail = '';
  for (let i = 0; i < b.burn_boundaries.length; i += 1) {
    const row = b.burn_boundaries[i];
    const pair = calc.MULTI_WINDOW_BURNS.find((p) => p.id === row.id);
    const below = calc.evaluateBurnPair(
      buildBurnCountSeries(pair, row.total, row.bad_below),
      row.id,
    );
    const eq = calc.evaluateBurnPair(
      buildBurnCountSeries(pair, row.total, row.bad_eq),
      row.id,
    );
    const above = calc.evaluateBurnPair(
      buildBurnCountSeries(pair, row.total, row.bad_above),
      row.id,
    );
    // RED: below must never fire; eq and above must fire (both legs)
    if (!(below.ok && below.short.exceeds_threshold === false
      && below.long.exceeds_threshold === false
      && below.would_fire === false
      && eq.ok && eq.short.exceeds_threshold === true
      && eq.long.exceeds_threshold === true
      && eq.would_fire === true
      && above.ok && above.short.exceeds_threshold === true
      && above.long.exceeds_threshold === true
      && above.would_fire === true)) {
      allOk = false;
      detail = `${row.id} below=${below.ok && below.would_fire}`
        + ` eq=${eq.ok && eq.would_fire}`
        + ` above=${above.ok && above.would_fire}`;
      break;
    }
  }
  red('burn_threshold_boundaries_below_never_eq_and_above_fire', allOk, detail);
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
  const lines = ownedText.split('\n');
  const hits = [];
  for (const re of patterns) {
    for (const line of lines) {
      if (re.test(line)
        && !/not claimed|does\s*\*+\s*not|does not|never|open|forbidden|explicitly|default OFF|not enabled|claiming /i.test(line)) {
        hits.push(String(re));
        break;
      }
    }
  }
  red('overclaim_tokens_absent_from_owned_docs',
    hits.length === 0,
    hits.length ? hits.join(', ') : undefined);
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
