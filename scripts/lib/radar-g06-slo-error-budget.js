'use strict';

/**
 * radar-g06-slo-error-budget — dependency-free G06 staging readiness SLO /
 * error-budget calculator (RADAR 16AJ source contract).
 *
 * Availability-only SLI from ACA Requests (Azure Monitor Total = Sum of
 * request counts) split by statusCodeCategory. Pure functions only — no
 * network, Azure, filesystem, or clock I/O.
 *
 * Latency percentile SLI is explicitly blocked (pending joint request
 * telemetry/instrumentation) and is not part of this SLO. No ACA duration
 * histogram, p99, combined min/intersection, or combined error budget.
 */

/** Finite staging readiness SLO window (exact rolling PT7D). */
const SLO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Align evaluation grain with existing capacity-alert cadence (16L PT5M). */
const SAMPLE_STEP_MS = 5 * 60 * 1000;

/** Availability target: 99.0% good events over the finite PT7D window. */
const AVAILABILITY_TARGET = 0.99;

/** Exact rational form of AVAILABILITY_TARGET (99/100). */
const AVAILABILITY_TARGET_RATIONAL = Object.freeze({ num: 99, den: 100 });

/** Error-budget fraction 1 - 0.99 = 0.01 = 1/100. */
const ERROR_BUDGET_FRACTION = 0.01;
const ERROR_BUDGET_RATIONAL = Object.freeze({ num: 1, den: 100 });

/** Minimum fraction of expected PT5M slots for the reference window. */
const MIN_SAMPLE_COVERAGE = 0.5;

/** Minimum request count in a readiness window before SLO math is admissible. */
const MIN_REQUESTS = 100;

/** Minimum request count in a burn leg (locked; not caller-overridable). */
const BURN_MIN_REQUESTS = 1;

/**
 * Latency percentile SLI — blocked; not part of this availability SLO.
 * ACA does not expose a usable duration histogram for p99<=500ms here.
 */
const LATENCY_PERCENTILE_SLI = Object.freeze({
  status: 'blocked',
  reason: 'pending_joint_request_telemetry_instrumentation',
  not_part_of_this_slo: true,
  aca_duration_histogram: 'nonexistent_not_relied_upon',
  p99_objective_ms: null,
  combined_with_availability: 'forbidden_disjoint_marginals',
});

/**
 * Exact decimal-rational burn thresholds. Numeric burn_threshold retained for
 * reporting only; fire decisions use burn_threshold_rational via BigInt
 * cross-multiplication (never float epsilon).
 * 14.4 = 144/10; 6 = 6/1; 3 = 3/1; 1 = 1/1.
 */
function freezeBurnPair(pair) {
  return Object.freeze({
    id: pair.id,
    severity: pair.severity,
    short_ms: pair.short_ms,
    long_ms: pair.long_ms,
    burn_threshold: pair.burn_threshold,
    burn_threshold_rational: Object.freeze({
      num: pair.burn_threshold_rational.num,
      den: pair.burn_threshold_rational.den,
    }),
  });
}

/**
 * Multi-window burn pairs (SRE-style). Alert acceptance requires BOTH short
 * and long windows at/above burn_threshold. Short burn windows are distinct
 * from the PT7D SLO span — coverage/span checks use the declared burn window.
 * Defined for future alert wiring only — not deployed by this module.
 */
const MULTI_WINDOW_BURNS = Object.freeze([
  freezeBurnPair({
    id: 'page_fast',
    severity: 'page',
    short_ms: 5 * 60 * 1000,
    long_ms: 60 * 60 * 1000,
    burn_threshold: 14.4,
    burn_threshold_rational: { num: 144, den: 10 },
  }),
  freezeBurnPair({
    id: 'page_slow',
    severity: 'page',
    short_ms: 30 * 60 * 1000,
    long_ms: 6 * 60 * 60 * 1000,
    burn_threshold: 6,
    burn_threshold_rational: { num: 6, den: 1 },
  }),
  freezeBurnPair({
    id: 'ticket_fast',
    severity: 'ticket',
    short_ms: 2 * 60 * 60 * 1000,
    long_ms: 24 * 60 * 60 * 1000,
    burn_threshold: 3,
    burn_threshold_rational: { num: 3, den: 1 },
  }),
  freezeBurnPair({
    id: 'ticket_slow',
    severity: 'ticket',
    short_ms: 6 * 60 * 60 * 1000,
    long_ms: 3 * 24 * 60 * 60 * 1000,
    burn_threshold: 1,
    burn_threshold_rational: { num: 1, den: 1 },
  }),
]);

const FAIL_CODES = Object.freeze({
  MISSING_SAMPLES: 'missing_samples',
  COUNTER_RESET: 'counter_reset',
  OUT_OF_ORDER: 'out_of_order',
  ZERO_TRAFFIC: 'zero_traffic_insufficient_coverage',
  INSUFFICIENT_COVERAGE: 'insufficient_sample_coverage',
  INSUFFICIENT_REQUESTS: 'insufficient_requests',
  INVALID_INPUT: 'invalid_input',
  IRREGULAR_GRAIN: 'irregular_or_gapped_grain',
  STALE_BASELINE: 'stale_baseline',
  WINDOW_SPAN_MISMATCH: 'window_span_mismatch',
  UNSAFE_INTEGER: 'unsafe_integer',
  LATENCY_SLI_BLOCKED: 'latency_sli_blocked',
  COMBINED_CLAIM_FORBIDDEN: 'combined_claim_forbidden',
  CONTRACT_DRIFT: 'contract_drift',
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

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function isSafeTimestamp(n) {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

function isNonNegSafeInt(n) {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

function assertFiniteInRange(name, n, lo, hi) {
  if (!isFiniteNumber(n)) {
    return failClosed(FAIL_CODES.INVALID_INPUT, [`${name} not finite`]);
  }
  if (n < lo || n > hi) {
    return failClosed(FAIL_CODES.INVALID_INPUT, [`${name} out of range`]);
  }
  return null;
}

function assertSafeNonNegInt(name, n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return failClosed(FAIL_CODES.INVALID_INPUT, [`${name} not finite`]);
  }
  if (!Number.isSafeInteger(n) || n < 0) {
    return failClosed(FAIL_CODES.UNSAFE_INTEGER, [
      `${name} must be nonnegative Number.isSafeInteger`,
    ]);
  }
  return null;
}

function assertFiniteArithmetic(name, n) {
  if (!isFiniteNumber(n)) {
    return failClosed(FAIL_CODES.INVALID_INPUT, [`${name} arithmetic not finite`]);
  }
  return null;
}

/**
 * Public evaluation options are locked to normative contract constants.
 * Callers may omit a key or pass the exact locked value; any other value is
 * contract drift. Only sample series data is variable.
 */
function rejectContractDrift(name, provided, locked) {
  if (provided == null) return null;
  if (provided === locked) return null;
  return failClosed(FAIL_CODES.CONTRACT_DRIFT, [
    `${name} contract drift: only locked value ${locked} allowed; got ${provided}`,
  ], { option: name, locked, provided });
}

/**
 * Exact availability meet: good/total >= 99/100
 * ↔ good * 100 >= total * 99 (safe BigInt cross-multiplication).
 */
function availabilityMeetsTargetExact(good, total) {
  const gBad = assertSafeNonNegInt('good', good);
  if (gBad) return gBad;
  const tBad = assertSafeNonNegInt('total', total);
  if (tBad) return tBad;
  if (total === 0) {
    return failClosed(FAIL_CODES.ZERO_TRAFFIC, ['zero total for availability meet']);
  }
  if (good > total) {
    return failClosed(FAIL_CODES.INVALID_INPUT, ['good > total']);
  }
  const lhs = BigInt(good) * BigInt(AVAILABILITY_TARGET_RATIONAL.den);
  const rhs = BigInt(total) * BigInt(AVAILABILITY_TARGET_RATIONAL.num);
  return { ok: true, meets: lhs >= rhs };
}

/**
 * Exact burn-rate threshold decision from request counts.
 * burn = (bad/total) / (budget_num/budget_den) = bad * budget_den / (total * budget_num)
 * burn >= thr_num/thr_den
 * ↔ bad * budget_den * thr_den >= total * budget_num * thr_num
 *
 * Numeric burn_rate is not used for the decision (reporting only).
 */
function burnRateMeetsThresholdExact(bad, total, thresholdRational) {
  const bBad = assertSafeNonNegInt('bad', bad);
  if (bBad) return bBad;
  const tBad = assertSafeNonNegInt('total', total);
  if (tBad) return tBad;
  if (total === 0) {
    return failClosed(FAIL_CODES.ZERO_TRAFFIC, ['zero total for burn threshold']);
  }
  if (bad > total) {
    return failClosed(FAIL_CODES.INVALID_INPUT, ['bad > total']);
  }
  if (!thresholdRational
    || !Number.isSafeInteger(thresholdRational.num)
    || !Number.isSafeInteger(thresholdRational.den)
    || thresholdRational.num < 0
    || thresholdRational.den <= 0) {
    return failClosed(FAIL_CODES.INVALID_INPUT, ['thresholdRational invalid']);
  }
  const lhs = BigInt(bad)
    * BigInt(ERROR_BUDGET_RATIONAL.den)
    * BigInt(thresholdRational.den);
  const rhs = BigInt(total)
    * BigInt(ERROR_BUDGET_RATIONAL.num)
    * BigInt(thresholdRational.num);
  return {
    ok: true,
    meets: lhs >= rhs,
    bad,
    total,
    threshold_rational: {
      num: thresholdRational.num,
      den: thresholdRational.den,
    },
  };
}

/**
 * Reject any attempt to bind latency histogram / p99 / combined intersection
 * into this availability-only SLO.
 */
function rejectLatencyOrCombinedOptions(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const latencyKeys = [
    'latency_histogram',
    'latency_objective_ms',
    'latency_success_fraction',
    'latency_success_ratio',
    'p99_ms',
    'average_ms',
  ];
  for (let i = 0; i < latencyKeys.length; i += 1) {
    if (Object.prototype.hasOwnProperty.call(cfg, latencyKeys[i])
      && cfg[latencyKeys[i]] != null) {
      return failClosed(FAIL_CODES.LATENCY_SLI_BLOCKED, [
        `latency percentile SLI blocked (${latencyKeys[i]}); pending joint `
        + 'request telemetry/instrumentation — not part of this SLO',
      ]);
    }
  }
  if (Object.prototype.hasOwnProperty.call(cfg, 'combined_target')
    && cfg.combined_target != null) {
    return failClosed(FAIL_CODES.COMBINED_CLAIM_FORBIDDEN, [
      'combined min/intersection error budget forbidden; availability-only SLO',
    ]);
  }
  if (Object.prototype.hasOwnProperty.call(cfg, 'combined_sli')
    && cfg.combined_sli != null) {
    return failClosed(FAIL_CODES.COMBINED_CLAIM_FORBIDDEN, [
      'combined SLI claim forbidden from disjoint marginals',
    ]);
  }
  return null;
}

/**
 * Disjoint marginals cannot justify a joint/combined success claim.
 * Availability ratio and an independent latency ratio are not an intersection.
 */
function rejectCombinedFromDisjointMarginals(availabilitySli, latencyRatio, combinedTarget) {
  if (latencyRatio != null || combinedTarget != null) {
    return failClosed(FAIL_CODES.COMBINED_CLAIM_FORBIDDEN, [
      'disjoint marginals cannot claim combined min/intersection SLO',
      `availability_sli=${availabilitySli}`,
      `latency_ratio=${latencyRatio}`,
      `combined_target=${combinedTarget}`,
    ]);
  }
  return failClosed(FAIL_CODES.COMBINED_CLAIM_FORBIDDEN, [
    'combined claim forbidden; availability-only SLO',
  ]);
}

/**
 * Error budget size for a target (fraction of events allowed to be bad).
 */
function errorBudgetFraction(target) {
  const bad = assertFiniteInRange('target', target, Number.EPSILON, 1 - Number.EPSILON);
  if (bad) return bad;
  const budget = 1 - target;
  const fin = assertFiniteArithmetic('budget', budget);
  if (fin) return fin;
  return { ok: true, target, budget };
}

/**
 * Burn rate = observed_bad_rate / budget.
 * budget_consumed over window_ms relative to slo_window_ms:
 *   consumed = burn * (window_ms / slo_window_ms)
 */
function burnFromBadRate(badRate, target, windowMs, sloWindowMs) {
  const eb = errorBudgetFraction(target);
  if (!eb.ok) return eb;
  const br = assertFiniteInRange('badRate', badRate, 0, 1);
  if (br) return br;
  const w = assertFiniteInRange('windowMs', windowMs, Number.EPSILON, Number.MAX_SAFE_INTEGER);
  if (w) return w;
  const sw = assertFiniteInRange('sloWindowMs', sloWindowMs, Number.EPSILON, Number.MAX_SAFE_INTEGER);
  if (sw) return sw;
  const burn = badRate / eb.budget;
  const budgetConsumed = burn * (windowMs / sloWindowMs);
  const finBurn = assertFiniteArithmetic('burn_rate', burn);
  if (finBurn) return finBurn;
  const finCons = assertFiniteArithmetic('budget_consumed_fraction', budgetConsumed);
  if (finCons) return finCons;
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
 * Validate sample fields, order, and monotonic counters (no grain check).
 * Each sample: { t_ms, requests_total, requests_2xx }
 */
function validateCounterSamplesBasic(samples) {
  if (!Array.isArray(samples) || samples.length < 2) {
    return failClosed(FAIL_CODES.MISSING_SAMPLES, ['need >=2 counter samples']);
  }
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    if (!s || typeof s !== 'object') {
      return failClosed(FAIL_CODES.MISSING_SAMPLES, [`sample ${i} missing`]);
    }
    if (s.latency_histogram != null || s.p99_ms != null || s.average_ms != null) {
      return failClosed(FAIL_CODES.LATENCY_SLI_BLOCKED, [
        `sample ${i} carries latency fields; latency SLI blocked`,
      ]);
    }
    if (!isSafeTimestamp(s.t_ms)) {
      return failClosed(FAIL_CODES.UNSAFE_INTEGER, [
        `sample ${i} t_ms must be nonnegative Number.isSafeInteger`,
      ]);
    }
    if (s.requests_total == null || s.requests_2xx == null) {
      return failClosed(FAIL_CODES.MISSING_SAMPLES, [`sample ${i} counters missing`]);
    }
    const totBad = assertSafeNonNegInt(`sample ${i} requests_total`, s.requests_total);
    if (totBad) return totBad;
    const okBad = assertSafeNonNegInt(`sample ${i} requests_2xx`, s.requests_2xx);
    if (okBad) return okBad;
    if (s.requests_2xx > s.requests_total) {
      return failClosed(FAIL_CODES.INVALID_INPUT, [`sample ${i} 2xx > total`]);
    }
    if (i > 0) {
      const prev = samples[i - 1];
      if (s.t_ms <= prev.t_ms) {
        return failClosed(FAIL_CODES.OUT_OF_ORDER, [
          `sample ${i} t_ms ${s.t_ms} <= prior ${prev.t_ms}`,
        ]);
      }
      if (s.requests_total < prev.requests_total
        || s.requests_2xx < prev.requests_2xx) {
        return failClosed(FAIL_CODES.COUNTER_RESET, [
          `sample ${i} counter decreased (reset)`,
        ]);
      }
    }
  }
  return { ok: true, sample_count: samples.length };
}

/**
 * Require exact PT5M grain between consecutive samples (no gaps).
 */
function validateRegularGrain(samples, stepMs) {
  const step = stepMs == null ? SAMPLE_STEP_MS : stepMs;
  const stepBad = assertFiniteInRange('stepMs', step, 1, Number.MAX_SAFE_INTEGER);
  if (stepBad) return stepBad;
  if (!Number.isSafeInteger(step)) {
    return failClosed(FAIL_CODES.UNSAFE_INTEGER, ['stepMs must be Number.isSafeInteger']);
  }
  if (!Array.isArray(samples) || samples.length < 2) {
    return failClosed(FAIL_CODES.MISSING_SAMPLES, ['need >=2 samples for grain check']);
  }
  for (let i = 1; i < samples.length; i += 1) {
    const dt = samples[i].t_ms - samples[i - 1].t_ms;
    if (dt !== step) {
      return failClosed(FAIL_CODES.IRREGULAR_GRAIN, [
        `sample ${i} grain ${dt}ms != step ${step}ms (gap/irregular)`,
      ]);
    }
  }
  return { ok: true, step_ms: step };
}

/**
 * Validate ordered cumulative counter samples (regular PT5M grain).
 */
function validateCounterSeries(samples, stepMs) {
  const basic = validateCounterSamplesBasic(samples);
  if (!basic.ok) return basic;
  const grain = validateRegularGrain(samples, stepMs);
  if (!grain.ok) return grain;
  return { ok: true, sample_count: samples.length, step_ms: grain.step_ms };
}

/**
 * Deltas from first→last of an already-validated contiguous slice.
 */
function deltasFromValidatedSlice(samples) {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const totalDelta = last.requests_total - first.requests_total;
  const ok2xxDelta = last.requests_2xx - first.requests_2xx;
  if (!Number.isSafeInteger(totalDelta) || !Number.isSafeInteger(ok2xxDelta)
    || totalDelta < 0 || ok2xxDelta < 0) {
    return failClosed(FAIL_CODES.UNSAFE_INTEGER, ['delta not nonnegative safe integer']);
  }
  const windowMs = last.t_ms - first.t_ms;
  if (!Number.isSafeInteger(windowMs) || windowMs < 0) {
    return failClosed(FAIL_CODES.UNSAFE_INTEGER, ['window_ms not safe']);
  }
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
 * Validate series then compute first→last deltas (full series span).
 */
function deltasFromCounterSamples(samples, stepMs) {
  const v = validateCounterSeries(samples, stepMs);
  if (!v.ok) return v;
  return deltasFromValidatedSlice(samples);
}

/**
 * Sample coverage vs expected PT5M slots for a reference window
 * (PT7D for readiness SLO; declared burn window for burn legs).
 */
function sampleCoverage(sampleCount, referenceWindowMs, stepMs, minCoverage) {
  if (!isNonNegSafeInt(sampleCount) || sampleCount < 1) {
    return failClosed(FAIL_CODES.MISSING_SAMPLES, ['sampleCount invalid']);
  }
  if (!isFiniteNumber(referenceWindowMs) || !isFiniteNumber(stepMs)) {
    return failClosed(FAIL_CODES.INVALID_INPUT, [
      'coverage referenceWindowMs/stepMs not finite (NaN/Infinity rejected)',
    ]);
  }
  if (referenceWindowMs < 0 || stepMs <= 0) {
    return failClosed(FAIL_CODES.INVALID_INPUT, ['coverage window/step invalid']);
  }
  if (!Number.isSafeInteger(stepMs)) {
    return failClosed(FAIL_CODES.UNSAFE_INTEGER, ['stepMs must be Number.isSafeInteger']);
  }
  const expectedSlots = Math.floor(referenceWindowMs / stepMs) + 1;
  if (!Number.isSafeInteger(expectedSlots) || expectedSlots < 1) {
    return failClosed(FAIL_CODES.UNSAFE_INTEGER, ['expectedSlots unsafe']);
  }
  const coverage = sampleCount / expectedSlots;
  if (!Number.isFinite(coverage)) {
    return failClosed(FAIL_CODES.INVALID_INPUT, ['coverage arithmetic not finite']);
  }
  const minCov = minCoverage == null ? MIN_SAMPLE_COVERAGE : minCoverage;
  const mc = assertFiniteInRange('minCoverage', minCov, 0, 1);
  if (mc) return mc;
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
    reference_window_ms: referenceWindowMs,
  };
}

/**
 * Availability SLI from counter deltas: 2xx / total.
 */
function availabilitySliFromDeltas(totalDelta, ok2xxDelta) {
  const tBad = assertSafeNonNegInt('totalDelta', totalDelta);
  if (tBad) return tBad;
  const gBad = assertSafeNonNegInt('ok2xxDelta', ok2xxDelta);
  if (gBad) return gBad;
  if (ok2xxDelta > totalDelta) {
    return failClosed(FAIL_CODES.INVALID_INPUT, ['2xx delta > total']);
  }
  if (totalDelta === 0) {
    return failClosed(FAIL_CODES.ZERO_TRAFFIC, ['zero request delta']);
  }
  const sli = ok2xxDelta / totalDelta;
  const fin = assertFiniteArithmetic('sli', sli);
  if (fin) return fin;
  return {
    ok: true,
    total: totalDelta,
    good: ok2xxDelta,
    bad: totalDelta - ok2xxDelta,
    sli,
  };
}

/**
 * Slice cumulative counter samples for a declared burn/eval window ending at
 * the last sample. Requires a baseline within one PT5M grain of window start;
 * rejects missing, stale (>1 grain early), or irregular baselines. Computed
 * delta interval must match declared window within one grain.
 */
function sliceSamplesForWindow(samples, windowMs, stepMs) {
  if (!Array.isArray(samples) || samples.length < 2) {
    return failClosed(FAIL_CODES.MISSING_SAMPLES, ['burn samples missing']);
  }
  const step = stepMs == null ? SAMPLE_STEP_MS : stepMs;
  const wBad = assertFiniteInRange('windowMs', windowMs, 1, Number.MAX_SAFE_INTEGER);
  if (wBad) return wBad;
  if (!Number.isSafeInteger(windowMs)) {
    return failClosed(FAIL_CODES.UNSAFE_INTEGER, ['windowMs must be Number.isSafeInteger']);
  }
  const stepBad = assertFiniteInRange('stepMs', step, 1, Number.MAX_SAFE_INTEGER);
  if (stepBad) return stepBad;
  if (!Number.isSafeInteger(step)) {
    return failClosed(FAIL_CODES.UNSAFE_INTEGER, ['stepMs must be Number.isSafeInteger']);
  }

  // Basic order/counter checks first so stale baselines are classifiable even
  // when a pre-window gap makes the full series irregular.
  const basic = validateCounterSamplesBasic(samples);
  if (!basic.ok) return basic;

  const last = samples[samples.length - 1];
  const startT = last.t_ms - windowMs;
  if (!Number.isSafeInteger(startT)) {
    return failClosed(FAIL_CODES.UNSAFE_INTEGER, ['window startT not safe integer']);
  }

  let baselineIdx = -1;
  let bestSkew = Infinity;
  let nearestPriorIdx = -1;
  for (let i = 0; i < samples.length; i += 1) {
    const t = samples[i].t_ms;
    if (t <= startT) {
      nearestPriorIdx = i;
      const skew = startT - t; // baseline must be at or before window start
      if (skew <= step && skew < bestSkew) {
        bestSkew = skew;
        baselineIdx = i;
      }
    }
  }

  if (baselineIdx < 0) {
    if (nearestPriorIdx >= 0) {
      const priorT = samples[nearestPriorIdx].t_ms;
      const skew = startT - priorT;
      if (skew > step) {
        return failClosed(FAIL_CODES.STALE_BASELINE, [
          `baseline stale: nearest prior ${priorT} is >1 PT5M grain before `
          + `window start ${startT} (skew=${skew}ms)`,
        ], { window_start_t_ms: startT, nearest_prior_t_ms: priorT, skew_ms: skew });
      }
    }
    return failClosed(FAIL_CODES.MISSING_SAMPLES, [
      `no baseline within one PT5M grain at-or-before window start ${startT}`,
    ], { window_start_t_ms: startT });
  }

  const sliced = samples.slice(baselineIdx);
  if (sliced.length < 2) {
    return failClosed(FAIL_CODES.MISSING_SAMPLES, [
      `window ${windowMs}ms has <2 samples after baseline`,
    ]);
  }

  // Regular grain required inside the computed window (gaps rejected).
  const grain = validateRegularGrain(sliced, step);
  if (!grain.ok) return grain;

  const deltaInterval = sliced[sliced.length - 1].t_ms - sliced[0].t_ms;
  if (Math.abs(deltaInterval - windowMs) > step) {
    return failClosed(FAIL_CODES.WINDOW_SPAN_MISMATCH, [
      `computed delta interval ${deltaInterval}ms does not match declared `
      + `window ${windowMs}ms within one PT5M grain`,
    ], {
      declared_window_ms: windowMs,
      computed_delta_ms: deltaInterval,
      baseline_skew_ms: bestSkew,
    });
  }

  return {
    ok: true,
    samples: sliced,
    window_ms: windowMs,
    computed_delta_ms: deltaInterval,
    baseline_t_ms: sliced[0].t_ms,
    baseline_skew_ms: bestSkew,
  };
}

/**
 * Evaluate staging readiness availability SLI over an exact rolling PT7D
 * counter series. Coverage is measured against PT7D expected slots.
 * Normative constants are locked — only `samples` is variable.
 */
function evaluateReadinessWindow(input) {
  const cfg = input || {};
  const blocked = rejectLatencyOrCombinedOptions(cfg);
  if (blocked) return blocked;

  const driftTarget = rejectContractDrift(
    'availability_target',
    cfg.availability_target,
    AVAILABILITY_TARGET,
  );
  if (driftTarget) return driftTarget;

  const driftSlo = rejectContractDrift('slo_window_ms', cfg.slo_window_ms, SLO_WINDOW_MS);
  if (driftSlo) return driftSlo;

  const driftStep = rejectContractDrift('sample_step_ms', cfg.sample_step_ms, SAMPLE_STEP_MS);
  if (driftStep) return driftStep;

  const driftCov = rejectContractDrift(
    'min_sample_coverage',
    cfg.min_sample_coverage,
    MIN_SAMPLE_COVERAGE,
  );
  if (driftCov) return driftCov;

  const driftReq = rejectContractDrift('min_requests', cfg.min_requests, MIN_REQUESTS);
  if (driftReq) return driftReq;

  const target = AVAILABILITY_TARGET;
  const sloWindowMs = SLO_WINDOW_MS;
  const stepMs = SAMPLE_STEP_MS;
  const minCoverage = MIN_SAMPLE_COVERAGE;
  const minRequests = MIN_REQUESTS;

  const samples = cfg.samples;
  const series = validateCounterSeries(samples, stepMs);
  if (!series.ok) return series;

  const d = deltasFromValidatedSlice(samples);
  if (!d.ok) return d;

  // Exact rolling PT7D span required for readiness evaluation.
  if (d.window_ms !== sloWindowMs) {
    return failClosed(FAIL_CODES.WINDOW_SPAN_MISMATCH, [
      `readiness span ${d.window_ms}ms != exact PT7D ${sloWindowMs}ms `
      + '(short fragments rejected; use burn windows for short intervals)',
    ], { span_ms: d.window_ms, required_ms: sloWindowMs });
  }

  // Coverage always against PT7D expected slots (not a shorter fragment).
  const cov = sampleCoverage(d.sample_count, sloWindowMs, stepMs, minCoverage);
  if (!cov.ok) return cov;

  if (d.requests_total_delta < minRequests) {
    return failClosed(FAIL_CODES.INSUFFICIENT_REQUESTS, [
      `requests ${d.requests_total_delta} < min ${minRequests}`,
    ], { requests: d.requests_total_delta, min_requests: minRequests });
  }

  const avail = availabilitySliFromDeltas(d.requests_total_delta, d.requests_2xx_delta);
  if (!avail.ok) return avail;

  const meet = availabilityMeetsTargetExact(avail.good, avail.total);
  if (!meet.ok) return meet;
  const availabilityOk = meet.meets;
  const badRate = 1 - avail.sli;
  const burn = burnFromBadRate(badRate, target, d.window_ms, sloWindowMs);
  if (!burn.ok) return burn;

  return {
    ok: true,
    fail_closed: false,
    sli_kind: 'availability_only',
    window_ms: d.window_ms,
    sample_count: d.sample_count,
    coverage: cov.coverage,
    coverage_reference_window_ms: sloWindowMs,
    availability: avail,
    availability_target: target,
    meets_availability: availabilityOk,
    burn,
    latency_percentile_sli: LATENCY_PERCENTILE_SLI,
  };
}

/**
 * Availability-only burn leg. Coverage/span use the declared burn window
 * (short windows are not measured against PT7D).
 * Normative constants are locked — only `samples` / window pair are variable.
 */
function availabilityBurnLeg(samples, windowMs, pairThresholdRational, opts) {
  const o = opts || {};
  const blocked = rejectLatencyOrCombinedOptions(o);
  if (blocked) return blocked;

  const driftTarget = rejectContractDrift(
    'availability_target',
    o.availability_target,
    AVAILABILITY_TARGET,
  );
  if (driftTarget) return driftTarget;

  const driftSlo = rejectContractDrift('slo_window_ms', o.slo_window_ms, SLO_WINDOW_MS);
  if (driftSlo) return driftSlo;

  const driftStep = rejectContractDrift('sample_step_ms', o.sample_step_ms, SAMPLE_STEP_MS);
  if (driftStep) return driftStep;

  const driftCov = rejectContractDrift(
    'burn_min_sample_coverage',
    o.burn_min_sample_coverage,
    MIN_SAMPLE_COVERAGE,
  );
  if (driftCov) return driftCov;

  const driftReq = rejectContractDrift(
    'burn_min_requests',
    o.burn_min_requests,
    BURN_MIN_REQUESTS,
  );
  if (driftReq) return driftReq;

  const target = AVAILABILITY_TARGET;
  const sloWindowMs = SLO_WINDOW_MS;
  const stepMs = SAMPLE_STEP_MS;
  const minCoverage = MIN_SAMPLE_COVERAGE;
  const minRequests = BURN_MIN_REQUESTS;

  const thrRational = pairThresholdRational && typeof pairThresholdRational === 'object'
    ? pairThresholdRational
    : null;
  if (!thrRational) {
    return failClosed(FAIL_CODES.INVALID_INPUT, ['burn threshold rational required']);
  }

  const sliced = sliceSamplesForWindow(samples, windowMs, stepMs);
  if (!sliced.ok) return sliced;

  const d = deltasFromValidatedSlice(sliced.samples);
  if (!d.ok) return d;

  // Coverage against the declared burn window (not PT7D).
  const cov = sampleCoverage(d.sample_count, windowMs, stepMs, minCoverage);
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

  const thr = burnRateMeetsThresholdExact(
    avail.bad,
    avail.total,
    thrRational,
  );
  if (!thr.ok) return thr;

  return {
    ok: true,
    window_ms: windowMs,
    computed_delta_ms: sliced.computed_delta_ms,
    availability_sli: avail.sli,
    bad_rate: 1 - avail.sli,
    burn_rate: b.burn_rate, // reporting only
    budget_consumed_fraction: b.budget_consumed_fraction,
    coverage: cov.coverage,
    coverage_reference_window_ms: windowMs,
    requests: d.requests_total_delta,
    exceeds_threshold: thr.meets,
  };
}

/**
 * Evaluate one burn window pair against sample series.
 * Returns fail-closed if either leg cannot be computed.
 * Alert firing is acceptance-only (defined_not_executed) — never live proof.
 */
function evaluateBurnPair(samples, pair, opts) {
  if (!pair || !isFiniteNumber(pair.short_ms) || !isFiniteNumber(pair.long_ms)
    || !isFiniteNumber(pair.burn_threshold)
    || !pair.burn_threshold_rational) {
    return failClosed(FAIL_CODES.INVALID_INPUT, ['burn pair invalid']);
  }
  if (!Number.isSafeInteger(pair.short_ms) || !Number.isSafeInteger(pair.long_ms)) {
    return failClosed(FAIL_CODES.UNSAFE_INTEGER, ['burn pair windows unsafe']);
  }
  if (!Array.isArray(samples) || samples.length < 2) {
    return failClosed(FAIL_CODES.MISSING_SAMPLES, ['burn samples missing']);
  }

  const short = availabilityBurnLeg(
    samples,
    pair.short_ms,
    pair.burn_threshold_rational,
    opts,
  );
  if (!short.ok) return short;
  const long = availabilityBurnLeg(
    samples,
    pair.long_ms,
    pair.burn_threshold_rational,
    opts,
  );
  if (!long.ok) return long;

  const wouldFire = short.exceeds_threshold && long.exceeds_threshold;
  return {
    ok: true,
    fail_closed: false,
    id: pair.id,
    severity: pair.severity,
    burn_threshold: pair.burn_threshold,
    burn_threshold_rational: pair.burn_threshold_rational,
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
  // Count-derived equality cases: burn = bad*100/total == thr_num/thr_den
  // ↔ bad * 100 * den == total * num. Choose total = 100 * den.
  const burnBoundaries = Object.freeze(MULTI_WINDOW_BURNS.map((pair) => {
    const { num, den } = pair.burn_threshold_rational;
    const total = 100 * den;
    const badEq = (total * num) / (100 * den);
    return Object.freeze({
      id: pair.id,
      burn_threshold: pair.burn_threshold,
      burn_threshold_rational: pair.burn_threshold_rational,
      total,
      bad_below: badEq - 1,
      bad_eq: badEq,
      bad_above: badEq + 1,
    });
  }));

  return Object.freeze({
    availability_target: AVAILABILITY_TARGET,
    availability_target_rational: AVAILABILITY_TARGET_RATIONAL,
    error_budget_rational: ERROR_BUDGET_RATIONAL,
    // Exactly at target: 99 good of 100 → sli=0.99 meets; 98/100 misses.
    meet_counts: Object.freeze({ total: 100, good: 99 }),
    miss_counts: Object.freeze({ total: 100, good: 98 }),
    // Burn: bad_rate 0.01 on 99% target → burn=1.0 exactly.
    unit_burn_bad_rate: 0.01,
    unit_burn_expected: 1,
    // 14.4x: bad_rate = 14.4 * 0.01 = 0.144
    fast_burn_bad_rate: 0.144,
    fast_burn_expected: 14.4,
    slo_window_ms: SLO_WINDOW_MS,
    sample_step_ms: SAMPLE_STEP_MS,
    burn_boundaries: burnBoundaries,
    // Reviewer sub-threshold safe-integer: float+eps would fire; exact must not.
    reviewer_sub_threshold_safe_integer: Object.freeze({
      total: 9007199254740991,
      bad: 1297036692682702,
      burn_threshold: 14.4,
      burn_threshold_rational: Object.freeze({ num: 144, den: 10 }),
      float_eps_would_fire: true,
      exact_must_fire: false,
    }),
    // Reviewer histogram non-example: no exact 500ms bucket in [400,1000].
    rejected_histogram_le_ms: Object.freeze([400, 1000]),
    latency_percentile_sli: LATENCY_PERCENTILE_SLI,
  });
}

module.exports = {
  SLO_WINDOW_MS,
  SAMPLE_STEP_MS,
  AVAILABILITY_TARGET,
  AVAILABILITY_TARGET_RATIONAL,
  ERROR_BUDGET_FRACTION,
  ERROR_BUDGET_RATIONAL,
  MIN_SAMPLE_COVERAGE,
  MIN_REQUESTS,
  BURN_MIN_REQUESTS,
  LATENCY_PERCENTILE_SLI,
  MULTI_WINDOW_BURNS,
  FAIL_CODES,
  failClosed,
  rejectContractDrift,
  rejectLatencyOrCombinedOptions,
  rejectCombinedFromDisjointMarginals,
  availabilityMeetsTargetExact,
  burnRateMeetsThresholdExact,
  errorBudgetFraction,
  burnFromBadRate,
  validateCounterSeries,
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
