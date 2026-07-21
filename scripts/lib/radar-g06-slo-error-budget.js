'use strict';

/**
 * radar-g06-slo-error-budget — dependency-free G06 staging readiness SLO /
 * error-budget calculator (RADAR 16AJ source contract).
 *
 * Pure functions only. No network, Azure, filesystem, or clock I/O.
 * Does not prove live SLO compliance. Callers supply synthetic or recorded
 * counter/histogram samples; fail-closed on missing/reset/out-of-order/
 * zero-traffic/sparse/percentile-misuse inputs.
 */

/** Finite staging readiness SLO window (7 days). */
const SLO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Align evaluation grain with existing capacity-alert cadence (16L PT5M). */
const SAMPLE_STEP_MS = 5 * 60 * 1000;

/** Availability target: 99.0% good events over the finite window. */
const AVAILABILITY_TARGET = 0.99;

/**
 * Latency objective: fraction of requests with latency <= this bucket edge.
 * Conservative staging objective; not a claim that live traffic meets it.
 */
const LATENCY_OBJECTIVE_MS = 500;

/** Latency success fraction (99% of observed requests under objective). */
const LATENCY_SUCCESS_FRACTION = 0.99;

/** Combined readiness target (both availability and latency must meet). */
const COMBINED_TARGET = 0.99;

/** Minimum fraction of expected PT5M slots present in the evaluation window. */
const MIN_SAMPLE_COVERAGE = 0.5;

/** Minimum request count in a window before SLO math is admissible. */
const MIN_REQUESTS = 100;

/**
 * Multi-window burn pairs (SRE-style). Alert acceptance requires BOTH short
 * and long windows at/above burn_threshold. Defined for future alert wiring
 * only — not deployed by this module.
 */
const MULTI_WINDOW_BURNS = Object.freeze([
  Object.freeze({
    id: 'page_fast',
    severity: 'page',
    short_ms: 5 * 60 * 1000,
    long_ms: 60 * 60 * 1000,
    burn_threshold: 14.4,
  }),
  Object.freeze({
    id: 'page_slow',
    severity: 'page',
    short_ms: 30 * 60 * 1000,
    long_ms: 6 * 60 * 60 * 1000,
    burn_threshold: 6,
  }),
  Object.freeze({
    id: 'ticket_fast',
    severity: 'ticket',
    short_ms: 2 * 60 * 60 * 1000,
    long_ms: 24 * 60 * 60 * 1000,
    burn_threshold: 3,
  }),
  Object.freeze({
    id: 'ticket_slow',
    severity: 'ticket',
    short_ms: 6 * 60 * 60 * 1000,
    long_ms: 3 * 24 * 60 * 60 * 1000,
    burn_threshold: 1,
  }),
]);

const FAIL_CODES = Object.freeze({
  MISSING_SAMPLES: 'missing_samples',
  COUNTER_RESET: 'counter_reset',
  OUT_OF_ORDER: 'out_of_order',
  ZERO_TRAFFIC: 'zero_traffic_insufficient_coverage',
  INSUFFICIENT_COVERAGE: 'insufficient_sample_coverage',
  INSUFFICIENT_REQUESTS: 'insufficient_requests',
  PERCENTILE_MISUSE: 'percentile_misuse',
  INVALID_HISTOGRAM: 'invalid_histogram',
  INVALID_INPUT: 'invalid_input',
});

function failClosed(code, errors, extra) {
  const out = {
    ok: false,
    fail_closed: true,
    code,
    errors: Array.isArray(errors) ? errors.slice() : [String(errors || code)],
  };
  if (extra && typeof extra === 'object') {
    Object.keys(extra).forEach((k) => {
      out[k] = extra[k];
    });
  }
  return out;
}

function isNonNegInt(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && Math.floor(n) === n;
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Validate a cumulative latency histogram.
 * counts[i] = requests with latency <= le_ms[i]; must be nondecreasing;
 * final count must equal requests accounted (when provided).
 */
function validateLatencyHistogram(hist, expectedTotal) {
  if (!hist || typeof hist !== 'object') {
    return failClosed(FAIL_CODES.INVALID_HISTOGRAM, ['histogram missing']);
  }
  const le = hist.le_ms;
  const counts = hist.counts;
  if (!Array.isArray(le) || !Array.isArray(counts) || le.length === 0 || le.length !== counts.length) {
    return failClosed(FAIL_CODES.INVALID_HISTOGRAM, ['le_ms/counts length mismatch']);
  }
  for (let i = 0; i < le.length; i += 1) {
    if (!isFiniteNumber(le[i]) || le[i] < 0) {
      return failClosed(FAIL_CODES.INVALID_HISTOGRAM, [`bad le_ms at ${i}`]);
    }
    if (!isNonNegInt(counts[i])) {
      return failClosed(FAIL_CODES.INVALID_HISTOGRAM, [`bad counts at ${i}`]);
    }
    if (i > 0 && le[i] <= le[i - 1]) {
      return failClosed(FAIL_CODES.INVALID_HISTOGRAM, ['le_ms not strictly increasing']);
    }
    if (i > 0 && counts[i] < counts[i - 1]) {
      return failClosed(FAIL_CODES.INVALID_HISTOGRAM, ['counts not cumulative nondecreasing']);
    }
  }
  if (expectedTotal != null) {
    if (!isNonNegInt(expectedTotal)) {
      return failClosed(FAIL_CODES.INVALID_INPUT, ['expectedTotal invalid']);
    }
    if (counts[counts.length - 1] !== expectedTotal) {
      return failClosed(FAIL_CODES.INVALID_HISTOGRAM, [
        `histogram final count ${counts[counts.length - 1]} != total ${expectedTotal}`,
      ]);
    }
  }
  return { ok: true, le_ms: le, counts };
}

/**
 * Fraction of requests with latency <= objectiveMs from a cumulative histogram.
 * Rejects percentile misuse (mean-as-p99, non-histogram inputs).
 */
function latencySuccessRatioFromHistogram(hist, objectiveMs, totalRequests) {
  if (hist && Object.prototype.hasOwnProperty.call(hist, 'average_ms')
    && !Array.isArray(hist.le_ms)) {
    return failClosed(FAIL_CODES.PERCENTILE_MISUSE, [
      'average_ms cannot substitute for cumulative histogram percentile',
    ]);
  }
  if (hist && Object.prototype.hasOwnProperty.call(hist, 'p99_ms')
    && !Array.isArray(hist.le_ms)) {
    return failClosed(FAIL_CODES.PERCENTILE_MISUSE, [
      'scalar p99_ms claim without histogram is percentile misuse',
    ]);
  }
  if (!isFiniteNumber(objectiveMs) || objectiveMs < 0) {
    return failClosed(FAIL_CODES.INVALID_INPUT, ['objectiveMs invalid']);
  }
  const v = validateLatencyHistogram(hist, totalRequests);
  if (!v.ok) return v;
  const total = v.counts[v.counts.length - 1];
  if (total === 0) {
    return failClosed(FAIL_CODES.ZERO_TRAFFIC, ['histogram total is zero']);
  }
  let atOrBelow = 0;
  let found = false;
  for (let i = 0; i < v.le_ms.length; i += 1) {
    if (v.le_ms[i] >= objectiveMs) {
      atOrBelow = v.counts[i];
      found = true;
      break;
    }
  }
  if (!found) {
    // Objective beyond last bucket edge → treat all as exceeding (fail closed for ratio=0)
    atOrBelow = 0;
  }
  return {
    ok: true,
    total,
    at_or_below: atOrBelow,
    ratio: atOrBelow / total,
    objective_ms: objectiveMs,
  };
}

/**
 * Error budget size for a target (fraction of events allowed to be bad).
 */
function errorBudgetFraction(target) {
  if (!isFiniteNumber(target) || target <= 0 || target >= 1) {
    return failClosed(FAIL_CODES.INVALID_INPUT, ['target must be in (0,1)']);
  }
  return { ok: true, target, budget: 1 - target };
}

/**
 * Burn rate = observed_bad_rate / budget.
 * budget_consumed over window_ms relative to slo_window_ms:
 *   consumed = burn * (window_ms / slo_window_ms)
 */
function burnFromBadRate(badRate, target, windowMs, sloWindowMs) {
  const eb = errorBudgetFraction(target);
  if (!eb.ok) return eb;
  if (!isFiniteNumber(badRate) || badRate < 0 || badRate > 1) {
    return failClosed(FAIL_CODES.INVALID_INPUT, ['badRate must be in [0,1]']);
  }
  if (!isFiniteNumber(windowMs) || windowMs <= 0
    || !isFiniteNumber(sloWindowMs) || sloWindowMs <= 0) {
    return failClosed(FAIL_CODES.INVALID_INPUT, ['window durations invalid']);
  }
  const burn = badRate / eb.budget;
  const budgetConsumed = burn * (windowMs / sloWindowMs);
  return {
    ok: true,
    bad_rate: badRate,
    target,
    budget: eb.budget,
    burn_rate: burn,
    window_ms: windowMs,
    slo_window_ms: sloWindowMs,
    budget_consumed_fraction: budgetConsumed,
  };
}

/**
 * Validate ordered counter samples and compute deltas.
 * Each sample: { t_ms, requests_total, requests_2xx, latency_histogram? }
 * Counters are cumulative monotonically nondecreasing snapshots.
 */
function deltasFromCounterSamples(samples) {
  if (!Array.isArray(samples) || samples.length < 2) {
    return failClosed(FAIL_CODES.MISSING_SAMPLES, ['need >=2 counter samples']);
  }
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    if (!s || typeof s !== 'object') {
      return failClosed(FAIL_CODES.MISSING_SAMPLES, [`sample ${i} missing`]);
    }
    if (!isFiniteNumber(s.t_ms)) {
      return failClosed(FAIL_CODES.MISSING_SAMPLES, [`sample ${i} t_ms missing`]);
    }
    if (s.requests_total == null || s.requests_2xx == null) {
      return failClosed(FAIL_CODES.MISSING_SAMPLES, [`sample ${i} counters missing`]);
    }
    if (!isNonNegInt(s.requests_total) || !isNonNegInt(s.requests_2xx)) {
      return failClosed(FAIL_CODES.INVALID_INPUT, [`sample ${i} counters not nonneg int`]);
    }
    if (s.requests_2xx > s.requests_total) {
      return failClosed(FAIL_CODES.INVALID_INPUT, [`sample ${i} 2xx > total`]);
    }
    if (i > 0) {
      if (s.t_ms <= samples[i - 1].t_ms) {
        return failClosed(FAIL_CODES.OUT_OF_ORDER, [
          `sample ${i} t_ms ${s.t_ms} <= prior ${samples[i - 1].t_ms}`,
        ]);
      }
      if (s.requests_total < samples[i - 1].requests_total
        || s.requests_2xx < samples[i - 1].requests_2xx) {
        return failClosed(FAIL_CODES.COUNTER_RESET, [
          `sample ${i} counter decreased (reset)`,
        ]);
      }
    }
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const totalDelta = last.requests_total - first.requests_total;
  const ok2xxDelta = last.requests_2xx - first.requests_2xx;
  const windowMs = last.t_ms - first.t_ms;
  return {
    ok: true,
    sample_count: samples.length,
    window_ms: windowMs,
    requests_total_delta: totalDelta,
    requests_2xx_delta: ok2xxDelta,
    requests_bad_delta: totalDelta - ok2xxDelta,
    first_t_ms: first.t_ms,
    last_t_ms: last.t_ms,
  };
}

/**
 * Sample coverage vs expected PT5M slots spanning [first,last].
 */
function sampleCoverage(sampleCount, windowMs, stepMs, minCoverage) {
  if (!isNonNegInt(sampleCount) || sampleCount < 1) {
    return failClosed(FAIL_CODES.MISSING_SAMPLES, ['sampleCount invalid']);
  }
  if (!isFiniteNumber(windowMs) || windowMs < 0
    || !isFiniteNumber(stepMs) || stepMs <= 0) {
    return failClosed(FAIL_CODES.INVALID_INPUT, ['coverage window/step invalid']);
  }
  const expectedSlots = Math.max(1, Math.floor(windowMs / stepMs) + 1);
  const coverage = sampleCount / expectedSlots;
  const minCov = minCoverage == null ? MIN_SAMPLE_COVERAGE : minCoverage;
  if (coverage + 1e-12 < minCov) {
    return failClosed(FAIL_CODES.INSUFFICIENT_COVERAGE, [
      `coverage ${coverage} < min ${minCov} (samples=${sampleCount} expected=${expectedSlots})`,
    ], { coverage, expected_slots: expectedSlots, sample_count: sampleCount });
  }
  return {
    ok: true,
    coverage,
    expected_slots: expectedSlots,
    sample_count: sampleCount,
    min_coverage: minCov,
  };
}

/**
 * Availability SLI from counter deltas: 2xx / total.
 */
function availabilitySliFromDeltas(totalDelta, ok2xxDelta) {
  if (!isNonNegInt(totalDelta) || !isNonNegInt(ok2xxDelta)) {
    return failClosed(FAIL_CODES.INVALID_INPUT, ['deltas invalid']);
  }
  if (ok2xxDelta > totalDelta) {
    return failClosed(FAIL_CODES.INVALID_INPUT, ['2xx delta > total']);
  }
  if (totalDelta === 0) {
    return failClosed(FAIL_CODES.ZERO_TRAFFIC, ['zero request delta']);
  }
  return {
    ok: true,
    total: totalDelta,
    good: ok2xxDelta,
    bad: totalDelta - ok2xxDelta,
    sli: ok2xxDelta / totalDelta,
  };
}

/**
 * Evaluate staging readiness SLI over counter samples + optional end histogram.
 * Histogram, when provided on the last sample (or as histOverride), must account
 * for the request delta in the window (delta histogram) OR be a window-local
 * cumulative histogram whose final count equals totalDelta.
 */
function evaluateReadinessWindow(input) {
  const cfg = input || {};
  const samples = cfg.samples;
  const target = cfg.availability_target == null ? AVAILABILITY_TARGET : cfg.availability_target;
  const latencyTarget = cfg.latency_success_fraction == null
    ? LATENCY_SUCCESS_FRACTION
    : cfg.latency_success_fraction;
  const combinedTarget = cfg.combined_target == null ? COMBINED_TARGET : cfg.combined_target;
  const objectiveMs = cfg.latency_objective_ms == null
    ? LATENCY_OBJECTIVE_MS
    : cfg.latency_objective_ms;
  const sloWindowMs = cfg.slo_window_ms == null ? SLO_WINDOW_MS : cfg.slo_window_ms;
  const stepMs = cfg.sample_step_ms == null ? SAMPLE_STEP_MS : cfg.sample_step_ms;
  const minCoverage = cfg.min_sample_coverage == null
    ? MIN_SAMPLE_COVERAGE
    : cfg.min_sample_coverage;
  const minRequests = cfg.min_requests == null ? MIN_REQUESTS : cfg.min_requests;

  const d = deltasFromCounterSamples(samples);
  if (!d.ok) return d;

  const cov = sampleCoverage(d.sample_count, d.window_ms, stepMs, minCoverage);
  if (!cov.ok) return cov;

  if (d.requests_total_delta < minRequests) {
    return failClosed(FAIL_CODES.INSUFFICIENT_REQUESTS, [
      `requests ${d.requests_total_delta} < min ${minRequests}`,
    ], { requests: d.requests_total_delta, min_requests: minRequests });
  }

  const avail = availabilitySliFromDeltas(d.requests_total_delta, d.requests_2xx_delta);
  if (!avail.ok) return avail;

  const hist = cfg.latency_histogram != null
    ? cfg.latency_histogram
    : (samples[samples.length - 1] && samples[samples.length - 1].latency_histogram);
  if (hist == null) {
    return failClosed(FAIL_CODES.MISSING_SAMPLES, ['latency_histogram missing']);
  }
  const lat = latencySuccessRatioFromHistogram(hist, objectiveMs, d.requests_total_delta);
  if (!lat.ok) return lat;

  const availabilityOk = avail.sli + 1e-12 >= target;
  const latencyOk = lat.ratio + 1e-12 >= latencyTarget;
  // Combined event-good approximation: min of the two ratios (conservative AND).
  const combinedSli = Math.min(avail.sli, lat.ratio);
  const combinedOk = combinedSli + 1e-12 >= combinedTarget;
  const badRate = 1 - combinedSli;
  const burn = burnFromBadRate(badRate, combinedTarget, d.window_ms, sloWindowMs);
  if (!burn.ok) return burn;

  return {
    ok: true,
    fail_closed: false,
    window_ms: d.window_ms,
    sample_count: d.sample_count,
    coverage: cov.coverage,
    availability: avail,
    latency: {
      ratio: lat.ratio,
      at_or_below: lat.at_or_below,
      total: lat.total,
      objective_ms: objectiveMs,
      success_fraction_target: latencyTarget,
      meets_objective: latencyOk,
    },
    combined_sli: combinedSli,
    availability_target: target,
    latency_success_fraction: latencyTarget,
    combined_target: combinedTarget,
    meets_availability: availabilityOk,
    meets_latency: latencyOk,
    meets_combined: combinedOk,
    burn,
  };
}

/**
 * Slice cumulative counter samples to cover the trailing windowMs ending at
 * the last sample, including one prior baseline point when available.
 */
function sliceSamplesForWindow(samples, windowMs) {
  if (!Array.isArray(samples) || samples.length < 2) {
    return failClosed(FAIL_CODES.MISSING_SAMPLES, ['burn samples missing']);
  }
  if (!isFiniteNumber(windowMs) || windowMs <= 0) {
    return failClosed(FAIL_CODES.INVALID_INPUT, ['windowMs invalid']);
  }
  const last = samples[samples.length - 1];
  const startT = last.t_ms - windowMs;
  let priorIdx = -1;
  for (let i = 0; i < samples.length; i += 1) {
    if (samples[i].t_ms < startT) priorIdx = i;
  }
  const inWindow = samples.filter((s) => s.t_ms >= startT);
  const sliced = priorIdx >= 0
    ? [samples[priorIdx]].concat(inWindow.filter((s) => s.t_ms > samples[priorIdx].t_ms))
    : inWindow;
  if (sliced.length < 2) {
    return failClosed(FAIL_CODES.MISSING_SAMPLES, [
      `window ${windowMs}ms has <2 samples after baseline`,
    ]);
  }
  return { ok: true, samples: sliced, window_ms: windowMs };
}

/**
 * Availability-only burn leg (classic SRE multi-window). Latency remains part
 * of the finite readiness window contract; burn pairs use 2xx/total bad rate
 * so short windows do not invent histogram deltas.
 */
function availabilityBurnLeg(samples, windowMs, pairThreshold, opts) {
  const o = opts || {};
  const target = o.availability_target == null ? AVAILABILITY_TARGET : o.availability_target;
  const sloWindowMs = o.slo_window_ms == null ? SLO_WINDOW_MS : o.slo_window_ms;
  const stepMs = o.sample_step_ms == null ? SAMPLE_STEP_MS : o.sample_step_ms;
  const minCoverage = o.burn_min_sample_coverage == null
    ? MIN_SAMPLE_COVERAGE
    : o.burn_min_sample_coverage;
  const minRequests = o.burn_min_requests == null ? 1 : o.burn_min_requests;

  const sliced = sliceSamplesForWindow(samples, windowMs);
  if (!sliced.ok) return sliced;

  const d = deltasFromCounterSamples(sliced.samples);
  if (!d.ok) return d;

  const cov = sampleCoverage(d.sample_count, d.window_ms, stepMs, minCoverage);
  if (!cov.ok) return cov;

  if (d.requests_total_delta < minRequests) {
    return failClosed(FAIL_CODES.INSUFFICIENT_REQUESTS, [
      `burn leg requests ${d.requests_total_delta} < min ${minRequests}`,
    ]);
  }
  if (d.requests_total_delta === 0) {
    return failClosed(FAIL_CODES.ZERO_TRAFFIC, ['burn leg zero traffic']);
  }

  const avail = availabilitySliFromDeltas(d.requests_total_delta, d.requests_2xx_delta);
  if (!avail.ok) return avail;

  const b = burnFromBadRate(1 - avail.sli, target, windowMs, sloWindowMs);
  if (!b.ok) return b;

  return {
    ok: true,
    window_ms: windowMs,
    availability_sli: avail.sli,
    bad_rate: 1 - avail.sli,
    burn_rate: b.burn_rate,
    budget_consumed_fraction: b.budget_consumed_fraction,
    coverage: cov.coverage,
    requests: d.requests_total_delta,
    exceeds_threshold: b.burn_rate + 1e-12 >= pairThreshold,
  };
}

/**
 * Evaluate one burn window pair against sample series.
 * Returns fail-closed if either leg cannot be computed.
 * Alert firing is acceptance-only (defined_not_executed) — never live proof.
 */
function evaluateBurnPair(samples, pair, opts) {
  if (!pair || !isFiniteNumber(pair.short_ms) || !isFiniteNumber(pair.long_ms)
    || !isFiniteNumber(pair.burn_threshold)) {
    return failClosed(FAIL_CODES.INVALID_INPUT, ['burn pair invalid']);
  }
  if (!Array.isArray(samples) || samples.length < 2) {
    return failClosed(FAIL_CODES.MISSING_SAMPLES, ['burn samples missing']);
  }

  const short = availabilityBurnLeg(samples, pair.short_ms, pair.burn_threshold, opts);
  if (!short.ok) return short;
  const long = availabilityBurnLeg(samples, pair.long_ms, pair.burn_threshold, opts);
  if (!long.ok) return long;

  const wouldFire = short.exceeds_threshold && long.exceeds_threshold;
  return {
    ok: true,
    fail_closed: false,
    id: pair.id,
    severity: pair.severity,
    burn_threshold: pair.burn_threshold,
    short,
    long,
    would_fire: wouldFire,
    alert_status: 'defined_not_executed',
  };
}

/**
 * Evaluate all locked multi-window burn pairs.
 */
function evaluateAllBurnPairs(samples, opts) {
  const results = [];
  for (let i = 0; i < MULTI_WINDOW_BURNS.length; i += 1) {
    const r = evaluateBurnPair(samples, MULTI_WINDOW_BURNS[i], opts);
    if (!r.ok) {
      return failClosed(r.code, r.errors, { failed_pair: MULTI_WINDOW_BURNS[i].id, leg: r });
    }
    results.push(r);
  }
  return {
    ok: true,
    fail_closed: false,
    pairs: results,
    any_page_would_fire: results.some((r) => r.severity === 'page' && r.would_fire),
    any_ticket_would_fire: results.some((r) => r.severity === 'ticket' && r.would_fire),
    alert_status: 'defined_not_executed',
  };
}

/**
 * Exact boundary helpers for verifier RED/GREEN.
 */
function exactBoundaryCases() {
  return Object.freeze({
    availability_target: AVAILABILITY_TARGET,
    // Exactly at target: 99 good of 100 → sli=0.99 meets; 98/100 misses.
    meet_counts: Object.freeze({ total: 100, good: 99 }),
    miss_counts: Object.freeze({ total: 100, good: 98 }),
    // Burn: bad_rate 0.01 on 99% target → burn=1.0 exactly.
    unit_burn_bad_rate: 0.01,
    unit_burn_expected: 1,
    // 14.4x: bad_rate = 14.4 * 0.01 = 0.144
    fast_burn_bad_rate: 0.144,
    fast_burn_expected: 14.4,
    latency_objective_ms: LATENCY_OBJECTIVE_MS,
    latency_success_fraction: LATENCY_SUCCESS_FRACTION,
  });
}

module.exports = {
  SLO_WINDOW_MS,
  SAMPLE_STEP_MS,
  AVAILABILITY_TARGET,
  LATENCY_OBJECTIVE_MS,
  LATENCY_SUCCESS_FRACTION,
  COMBINED_TARGET,
  MIN_SAMPLE_COVERAGE,
  MIN_REQUESTS,
  MULTI_WINDOW_BURNS,
  FAIL_CODES,
  failClosed,
  validateLatencyHistogram,
  latencySuccessRatioFromHistogram,
  errorBudgetFraction,
  burnFromBadRate,
  deltasFromCounterSamples,
  sampleCoverage,
  availabilitySliFromDeltas,
  evaluateReadinessWindow,
  sliceSamplesForWindow,
  availabilityBurnLeg,
  evaluateBurnPair,
  evaluateAllBurnPairs,
  exactBoundaryCases,
};
