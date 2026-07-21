'use strict';

/**
 * verify:radar-slice16ai-g06-live-load-evidence — RADAR Slice 16AI
 *
 * Offline gate: bounded evidence reconciliation of the successful controlled
 * dual-staging /readyz bounded-load drill + Sunset MTD ActualCost guard.
 *
 * Rejects metric/status/count/latency/cost/scope/overclaim drift and lock_hash
 * mismatch. Records final_controlled_drill live_proven for the conservative
 * readiness profile only. G06 remains partial. No Azure mutation / live network
 * by this verifier.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16ai-g06-live-load-evidence');

let pass = 0;
let fail = 0;
const redResults = [];
const greenResults = [];

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
  redResults.push({ id, ok: !!cond });
  return ok(`RED ${id}`, cond, detail);
}

function green(id, cond, detail) {
  greenResults.push({ id, ok: !!cond });
  return ok(`GREEN ${id}`, cond, detail);
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
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

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function evidenceHashPayload(ev) {
  const clone = deepClone(ev);
  delete clone.lock_hash;
  return clone;
}

function computeEvidenceLockHash(ev) {
  return crypto.createHash('sha256').update(stableStringify(evidenceHashPayload(ev))).digest('hex');
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function validateEvidenceExact(evidence) {
  const errors = [];
  const expected = readJson(locks.EVIDENCE_REL);
  const withoutHash = deepClone(evidence);
  const gotHash = withoutHash.lock_hash;
  delete withoutHash.lock_hash;
  const expectedNoHash = deepClone(expected);
  delete expectedNoHash.lock_hash;

  if (!/^[0-9a-f]{64}$/.test(String(gotHash || ''))) {
    errors.push('$.lock_hash: must be 64-char lowercase hex');
  } else {
    const recomputed = computeEvidenceLockHash(evidence);
    if (gotHash !== recomputed) {
      errors.push(`$.lock_hash: mismatch (got=${gotHash} expected=${recomputed})`);
    }
  }

  const allowedTop = [...Object.keys(expectedNoHash), 'lock_hash'].sort();
  const gotTop = Object.keys(evidence).sort();
  if (stableStringify(gotTop) !== stableStringify(allowedTop)) {
    errors.push(`top keys mismatch got=${gotTop.join(',')} allowed=${allowedTop.join(',')}`);
  }

  if (!deepEqual(withoutHash, expectedNoHash)) {
    errors.push('evidence payload mismatch vs locked fixture (excluding lock_hash check above)');
  }

  return { ok: errors.length === 0, errors };
}

function drillRoot(ev) {
  return ev && ev.observed_facts && ev.observed_facts.controlled_dual_staging_readyz_bounded_load;
}

function costRoot(ev) {
  return ev && ev.observed_facts && ev.observed_facts.sunset_mtd_actual_cost_guard;
}

function latencyOk(got, expect) {
  return got
    && got.count === expect.count
    && got.p50_ms === expect.p50_ms
    && got.p95_ms === expect.p95_ms
    && got.p99_ms === expect.p99_ms
    && got.max_ms === expect.max_ms;
}

function statusOk(counts) {
  return counts
    && counts['2xx'] === 60
    && counts['3xx'] === 0
    && counts['4xx'] === 0
    && counts['5xx'] === 0
    && counts.timeout === 0
    && counts.error === 0
    && counts.other === 0;
}

function hygieneOk(row) {
  return row
    && row.response_bodies_collected === false
    && row.redirects_followed === false
    && row.headers_sent === false
    && row.auth_sent === false
    && row.body_sent === false
    && row.dns_pinned === true
    && row.active_requests_remaining === 0;
}

function profileOk(profile) {
  return profile
    && profile.concurrency === locks.PROFILE_LOCK.concurrency
    && profile.max_duration_ms === locks.PROFILE_LOCK.max_duration_ms
    && profile.max_requests === locks.PROFILE_LOCK.max_requests
    && profile.request_timeout_ms === locks.PROFILE_LOCK.request_timeout_ms
    && profile.method === 'GET'
    && profile.headers === null
    && profile.body === null
    && profile.auth === null
    && profile.follow_redirects === false
    && profile.max_redirects === 0
    && profile.tls_required === true
    && profile.collect_response_bodies === false;
}

function targetRowOk(row, target, latency, wallMs) {
  const errors = [];
  if (!row) return { ok: false, errors: ['missing row'] };
  if (row.target !== target) errors.push('target');
  if (row.method !== 'GET') errors.push('method');
  if (!profileOk(row.profile)) errors.push('profile');
  if (row.started !== 60 || row.completed !== 60) errors.push('started_completed');
  if (row.peak_in_flight !== 2) errors.push('peak');
  if (row.wall_ms !== wallMs) errors.push('wall');
  if (row.stop_reason !== 'max_requests') errors.push('stop_reason');
  if (!statusOk(row.status_counts)) errors.push('status_counts');
  if (!latencyOk(row.latency, latency)) errors.push('latency');
  if (!hygieneOk(row)) errors.push('hygiene');
  if (!deepEqual(row.error_code_classes, {})) errors.push('error_code_classes');
  return { ok: errors.length === 0, errors };
}

function validateDrillFacts(ev) {
  const errors = [];
  const root = drillRoot(ev);
  if (!root) return { ok: false, errors: ['missing drill root'] };
  if (root.profile_id !== locks.PROFILE_ID) errors.push('profile_id');
  if (root.drill_executed_at !== locks.DRILL_EXECUTED_AT) errors.push('executed_at');
  if (root.observed_at !== locks.INDEPENDENT_VERIFY_UTC) errors.push('observed_at');
  if (root.master_sha !== locks.MASTER_BASIS) errors.push('master_sha');
  if (root.pre_post_readyz?.wolfhouse !== 'ready' || root.pre_post_readyz?.sunset !== 'ready') {
    errors.push('pre_post_readyz');
  }
  const wh = targetRowOk(root.wolfhouse, locks.WH_READYZ_URL, locks.WH_LATENCY, locks.WH_WALL_MS);
  const sun = targetRowOk(
    root.sunset,
    locks.SUNSET_READYZ_URL,
    locks.SUNSET_LATENCY,
    locks.SUNSET_WALL_MS,
  );
  if (!wh.ok) errors.push(`wh:${wh.errors.join(',')}`);
  if (!sun.ok) errors.push(`sun:${sun.errors.join(',')}`);
  return { ok: errors.length === 0, errors };
}

function validateCostFacts(ev) {
  const errors = [];
  const c = costRoot(ev);
  if (!c) return { ok: false, errors: ['missing cost root'] };
  if (c.type !== 'ActualCost') errors.push('type');
  if (c.scope !== locks.COST_SCOPE) errors.push('scope');
  if (!deepEqual(c.period, locks.COST_PERIOD)) errors.push('period');
  if (c.currency !== locks.COST_CURRENCY) errors.push('currency');
  if (c.amount_before !== locks.COST_AMOUNT) errors.push('amount_before');
  if (c.amount_after !== locks.COST_AMOUNT) errors.push('amount_after');
  if (c.identical !== true) errors.push('identical');
  if (c.captured_before_at !== locks.COST_BEFORE_AT) errors.push('before_at');
  if (c.captured_after_at !== locks.COST_AFTER_AT) errors.push('after_at');
  if (c.after_query_initial_429_then_successful_retry !== true) errors.push('429_flag');
  if (c.after_query_initial_status !== 429) errors.push('429_status');
  if (c.after_query_retry_status !== 'success') errors.push('retry_status');
  return { ok: errors.length === 0, errors };
}

function validateGateMatrix(matrix) {
  const errors = [];
  if (!matrix || typeof matrix !== 'object') return { ok: false, errors: ['matrix missing'] };
  if (matrix.slice !== locks.SLICE) errors.push(`slice=${matrix.slice}`);
  if (matrix.branch !== locks.BRANCH) errors.push(`branch=${matrix.branch}`);
  if (matrix.master_basis !== locks.MASTER_BASIS) errors.push('master_basis mismatch');
  if (matrix.live_mutation !== false) errors.push('live_mutation not false');
  const counts = matrix.verdict_counts || {};
  if (counts.proven !== 0) errors.push(`proven=${counts.proven}`);
  if (counts.partial !== 9) errors.push(`partial=${counts.partial}`);
  if (counts.absent !== 0) errors.push(`absent=${counts.absent}`);

  const g06 = (matrix.gates || []).find((g) => g.id === locks.GATE_ID);
  if (!g06) {
    errors.push('G06 missing');
  } else {
    if (g06.verdict !== 'partial') errors.push('G06 verdict not partial');
    if (g06.progress_class !== 'partial_live_proven') errors.push('G06 progress_class wrong');
    if (!/16AI|conservative.?readyz|bounded.?load/i.test(String(g06.rationale || ''))) {
      errors.push('G06 rationale missing 16AI facts');
    }
    if (!Array.isArray(g06.gaps) || !g06.gaps.some((g) => /soak|fir|notification/i.test(String(g)))) {
      errors.push('G06 gaps must retain soak/firing/notification open');
    }
    if (!g06.gaps.some((g) => /autoscal/i.test(String(g)))) {
      errors.push('G06 gaps must retain autoscaling open');
    }
    if (!g06.gaps.some((g) => /SLO|error.?budget|backpressure/i.test(String(g)))) {
      errors.push('G06 gaps must retain SLO/backpressure open');
    }
    if (g06.gaps.some((g) => /No live dual-staging \/readyz load\/soak success proof/i.test(String(g)))) {
      errors.push('G06 gaps still claim conservative /readyz load unproven unqualified');
    }
  }

  const sel = matrix.slice_16ai_selection;
  if (!sel || sel.selected !== true || sel.outcome_id !== locks.OUTCOME_ID) {
    errors.push('slice_16ai_selection');
  } else {
    if (sel.final_controlled_drill?.status !== 'live_proven') {
      errors.push('final_controlled_drill status');
    }
    if (sel.g06_verdict !== 'partial') errors.push('sel g06_verdict');
    if (sel.g06_load_soak !== 'open') errors.push('sel soak');
    if (sel.g06_conservative_readyz_bounded_load !== 'live_proven_via_16AI') {
      errors.push('sel conservative load');
    }
  }

  for (const g of matrix.gates || []) {
    if (g.verdict === 'proven') errors.push(`${g.id} falsely proven`);
  }
  return { ok: errors.length === 0, errors };
}

function overclaimHits(text) {
  const patterns = [
    /\bload\s+soak\s+proven\b/i,
    /\bsoak\s+proven\b/i,
    /\bcapacity\s+alert\s+fired\b/i,
    /\balert\s+firing\s+proven\b/i,
    /\bnotification\s+delivered\b/i,
    /\bautoscaling\s+proven\b/i,
    /\bcapacity\s+SLO\s+proven\b/i,
    /\berror\s+budget\s+proven\b/i,
    /\bbackpressure\s+proven\b/i,
    /\bfull\s+G06\b/i,
    /\bG06\s+proven\b/i,
    /\bfull_G06_proven\b/i,
    /\bproduction\b(?![^\n]{0,40}\b(forbidden|not|open|still)\b)/i,
  ];
  const hits = [];
  for (const p of patterns) {
    if (p.test(text)) hits.push(String(p));
  }
  return hits;
}

function runVerifier() {
  console.log('RADAR 16AI G06 live-load evidence — offline verifier\n');

  const evidence = readJson(locks.EVIDENCE_REL);
  const sliceContract = readJson(locks.CONTRACT_REL);
  const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
  const topContract = readJson('fixtures/radar-operations/contract.json');
  const doc = readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md');
  const findings = readText('fixtures/radar-operations/findings.md');

  ok('C1 HEAD on 16AI branch', currentBranch() === locks.BRANCH, currentBranch());
  ok('C2 evidence master_basis locked', evidence.master_basis === locks.MASTER_BASIS);
  ok('C3 slice/outcome/branch locked',
    evidence.slice === locks.SLICE
    && evidence.outcome_id === locks.OUTCOME_ID
    && evidence.branch === locks.BRANCH
    && sliceContract.branch === locks.BRANCH
    && sliceContract.outcome_id === locks.OUTCOME_ID
    && matrix.slice === locks.SLICE
    && matrix.branch === locks.BRANCH
    && topContract.slice === locks.SLICE
    && topContract.branch === locks.BRANCH);

  {
    const v = validateEvidenceExact(evidence);
    ok('C4 evidence exact recursive schema + lock_hash', v.ok, v.errors.slice(0, 12).join(' | '));
  }

  ok('C5 live_mutation false + audit_only',
    evidence.live_mutation === false
    && evidence.audit_only === true
    && evidence.this_slice_deploys === false
    && sliceContract.live_deploy === false
    && sliceContract.live_mutation === false
    && sliceContract.this_slice_deploys === false);

  ok('C6 disposition keeps G06 partial; conservative live_proven only',
    evidence.disposition.g06_verdict === 'partial'
    && evidence.disposition.g06_progress_class === 'partial_live_proven'
    && evidence.disposition.final_controlled_drill_status === 'live_proven'
    && sliceContract.final_controlled_drill.status === 'live_proven'
    && evidence.gate_progress_updates.G06_scaling_capacity.verdict === 'partial'
    && evidence.gate_progress_updates.G06_scaling_capacity.still_open.includes('load_soak_proof')
    && evidence.gate_progress_updates.G06_scaling_capacity.still_open.includes('capacity_alert_firing')
    && evidence.gate_progress_updates.G06_scaling_capacity.still_open.includes('notification_delivery')
    && evidence.gate_progress_updates.G06_scaling_capacity.still_open.includes('autoscaling')
    && evidence.gate_progress_updates.G06_scaling_capacity.still_open.includes('capacity_slo_error_budget')
    && evidence.gate_progress_updates.G06_scaling_capacity.still_open.includes('backpressure')
    && evidence.gate_progress_updates.G06_scaling_capacity.live_proven.includes(
      'conservative_dual_staging_readyz_bounded_load_via_16AI',
    ));

  {
    const d = validateDrillFacts(evidence);
    green('exact_two_targets_60_of_60_2xx', d.ok, d.errors.join(' | '));
  }

  {
    const root = drillRoot(evidence);
    green('exact_latency_and_wall',
      latencyOk(root.wolfhouse.latency, locks.WH_LATENCY)
      && root.wolfhouse.wall_ms === locks.WH_WALL_MS
      && latencyOk(root.sunset.latency, locks.SUNSET_LATENCY)
      && root.sunset.wall_ms === locks.SUNSET_WALL_MS);
  }

  green('pre_post_readyz_ready',
    drillRoot(evidence).pre_post_readyz.wolfhouse === 'ready'
    && drillRoot(evidence).pre_post_readyz.sunset === 'ready');

  green('transport_hygiene_dns_pinned_active_zero',
    hygieneOk(drillRoot(evidence).wolfhouse)
    && hygieneOk(drillRoot(evidence).sunset)
    && drillRoot(evidence).wolfhouse.peak_in_flight === 2
    && drillRoot(evidence).sunset.peak_in_flight === 2);

  {
    const c = validateCostFacts(evidence);
    green('sunset_cost_identical_with_429_retry_disclosed', c.ok, c.errors.join(' | '));
  }

  green('final_controlled_drill_live_proven_conservative_only',
    sliceContract.final_controlled_drill.id === locks.PROFILE_ID
    && sliceContract.final_controlled_drill.status === 'live_proven'
    && matrix.slice_16ai_selection.final_controlled_drill.status === 'live_proven'
    && /conservative/i.test(String(sliceContract.final_controlled_drill.pass_rule || ''))
    && /not soak|soak.*open|soak \(not claimed\)/i.test(
      `${sliceContract.final_controlled_drill.pass_rule}\n${(sliceContract.still_open || []).join('\n')}`,
    )
    && !/\bload\s+soak\s+proven\b/i.test(sliceContract.final_controlled_drill.pass_rule));

  {
    const g06 = matrix.gates.find((g) => g.id === locks.GATE_ID);
    green('g06_remains_partial',
      g06
      && g06.verdict === 'partial'
      && /16AI/.test(g06.rationale)
      && Array.isArray(g06.gaps)
      && g06.gaps.some((x) => /soak/i.test(String(x)))
      && g06.gaps.some((x) => /autoscal/i.test(String(x)))
      && g06.gaps.some((x) => /SLO|backpressure/i.test(String(x)))
      && !/\bG06\s+proven\b/i.test(String(g06.rationale)));
  }

  green('score_not_inflated',
    topContract.expected_verdict_counts
    && topContract.expected_verdict_counts.proven === 0
    && topContract.expected_verdict_counts.partial === 9
    && topContract.expected_verdict_counts.absent === 0
    && sliceContract.verdict_policy.proven === 0
    && sliceContract.verdict_policy.partial === 9
    && matrix.verdict_counts.proven === 0
    && matrix.verdict_counts.partial === 9);

  {
    const pkg = readJson('package.json');
    green('package_script_registered',
      pkg.scripts
      && pkg.scripts['verify:radar-slice16ai-g06-live-load-evidence']
        === 'node scripts/verify-radar-slice16ai-g06-live-load-evidence.js');
  }

  green('runtime_paths_unchanged', runtimePathsUnchanged().ok, runtimePathsUnchanged().detail);

  green('16ah_attempted_not_proof_retained',
    topContract.selected_16ah
    && topContract.selected_16ah.live_load_attempt_status === 'attempted_not_proof'
    && topContract.selected_16ah.g06_load_proof === 'open'
    && topContract.selected_16ag
    && topContract.selected_16ag.g06_load_proof === 'open'
    && topContract.live_load_attempt_status === 'attempted_not_proof'
    && /open/i.test(String(topContract.capacity_load_proof || ''))
    && matrix.slice_16ah_selection
    && matrix.slice_16ah_selection.live_load_attempt.status === 'attempted_not_proof'
    && matrix.slice_16ag_selection
    && matrix.slice_16ag_selection.final_controlled_drill.status === 'defined_not_executed');

  {
    const mv = validateGateMatrix(matrix);
    ok('C7 gate-matrix 16AI selection + G06 partial', mv.ok, mv.errors.join(' | '));
  }

  ok('C8 top contract selected_16ai',
    topContract.selected_16ai
    && topContract.selected_16ai.outcome_id === locks.OUTCOME_ID
    && topContract.selected_16ai.g06_verdict === 'partial'
    && topContract.selected_16ai.g06_conservative_readyz_bounded_load === 'live_proven_via_16AI'
    && topContract.selected_16ai.g06_load_soak === 'open'
    && topContract.selected_16ai.final_controlled_drill_status === 'live_proven'
    && topContract.conservative_readyz_bounded_load === 'live_proven_via_16AI'
    && topContract.load_soak === 'open'
    && topContract.load_proof === 'open');

  ok('C9 doc mentions 16AI conservative live_proven without soak/G06 proven',
    /16AI/i.test(doc)
    && /live_proven/i.test(doc)
    && /conservative/i.test(doc)
    && /G06.*partial|partial.*G06/i.test(doc)
    && /soak/i.test(doc)
    && !/\bG06\s+proven\b/i.test(doc)
    && !/\bload\s+soak\s+proven\b/i.test(doc)
    && !/\bfull\s+G06\b/i.test(doc));

  ok('C10 findings mention 16AI without overclaim',
    /16AI/i.test(findings)
    && /live_proven/i.test(findings)
    && /G06/.test(findings)
    && !/\bG06\s+proven\b/i.test(findings)
    && !/\bload\s+soak\s+proven\b/i.test(findings)
    && !/\bfull\s+G06\b/i.test(findings));

  ok('C11 runtime paths unchanged vs master', runtimePathsUnchanged().ok, runtimePathsUnchanged().detail);

  ok('C12 progress_class evidence-only',
    locks.PROGRESS_CLASS === 'partial_live_proven_evidence_only'
    && evidence.progress_class === 'partial_live_proven_evidence_only'
    && sliceContract.progress_class === 'partial_live_proven_evidence_only'
    && matrix.slice_16ai_selection.progress_class === 'partial_live_proven_evidence_only');

  // --- RED battery ---
  {
    const bad = deepClone(evidence);
    bad.observed_facts.controlled_dual_staging_readyz_bounded_load.wolfhouse.target =
      'https://evil.example/readyz';
    red('wrong_target_rejected',
      !validateEvidenceExact(bad).ok || !validateDrillFacts(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.controlled_dual_staging_readyz_bounded_load.wolfhouse.status_counts['2xx'] = 59;
    bad.observed_facts.controlled_dual_staging_readyz_bounded_load.wolfhouse.status_counts['5xx'] = 1;
    red('wrong_status_count_rejected',
      !validateEvidenceExact(bad).ok || !validateDrillFacts(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.controlled_dual_staging_readyz_bounded_load.wolfhouse.latency.p50_ms = 99;
    red('wrong_latency_rejected',
      !validateEvidenceExact(bad).ok || !validateDrillFacts(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.controlled_dual_staging_readyz_bounded_load.sunset.peak_in_flight = 4;
    red('wrong_concurrency_peak_rejected',
      !validateEvidenceExact(bad).ok || !validateDrillFacts(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.controlled_dual_staging_readyz_bounded_load.wolfhouse.status_counts.timeout = 1;
    bad.observed_facts.controlled_dual_staging_readyz_bounded_load.wolfhouse.status_counts['2xx'] = 59;
    red('timeout_or_error_drift_rejected',
      !validateEvidenceExact(bad).ok || !validateDrillFacts(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.sunset_mtd_actual_cost_guard.amount_after = 18.25;
    bad.observed_facts.sunset_mtd_actual_cost_guard.identical = false;
    red('cost_amount_drift_rejected',
      !validateEvidenceExact(bad).ok || !validateCostFacts(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.sunset_mtd_actual_cost_guard.after_query_initial_429_then_successful_retry = false;
    delete bad.observed_facts.sunset_mtd_actual_cost_guard.after_query_initial_status;
    red('cost_429_disclosure_removed_rejected',
      !validateEvidenceExact(bad).ok || !validateCostFacts(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.claims_allowed.push('load_soak_proof');
    bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'load_soak_proof');
    bad.disposition.proves.push('load_soak_proof');
    bad.gate_progress_updates.G06_scaling_capacity.still_open =
      bad.gate_progress_updates.G06_scaling_capacity.still_open.filter((x) => x !== 'load_soak_proof');
    red('soak_overclaim_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.claims_allowed.push('capacity_alert_firing');
    bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'capacity_alert_firing');
    bad.disposition.proves.push('capacity_alert_firing');
    red('firing_overclaim_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.claims_allowed.push('autoscaling');
    bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'autoscaling');
    bad.disposition.proves.push('autoscaling');
    red('autoscaling_overclaim_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.disposition.g06_verdict = 'proven';
    bad.gate_progress_updates.G06_scaling_capacity.verdict = 'proven';
    bad.gate_progress_updates.G06_scaling_capacity.still_open = [];
    bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'full_G06_proven');
    red('full_g06_overclaim_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.lock_hash = '0'.repeat(64);
    red('lock_hash_mismatch_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const badDoc = `${doc}\n\nG06 proven with load soak proven and production capacity SLO proven.\n`;
    const hits = overclaimHits(badDoc);
    red('doc_overclaim_tokens_detectable', hits.length > 0, hits.join(','));
  }
  {
    const bad = deepClone(evidence);
    bad.claims_allowed.push('production');
    bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'production');
    bad.disposition.proves.push('production');
    red('scope_overclaim_production_rejected', !validateEvidenceExact(bad).ok);
  }

  const redIds = new Set(redResults.map((r) => r.id));
  const greenIds = new Set(greenResults.map((r) => r.id));
  ok('C13 all REQUIRED_RED present',
    locks.REQUIRED_RED.every((id) => redIds.has(id)),
    locks.REQUIRED_RED.filter((id) => !redIds.has(id)).join(','));
  ok('C14 all REQUIRED_GREEN present',
    locks.REQUIRED_GREEN.every((id) => greenIds.has(id)),
    locks.REQUIRED_GREEN.filter((id) => !greenIds.has(id)).join(','));
  ok('C15 all RED/GREEN assertions passed',
    redResults.every((r) => r.ok) && greenResults.every((r) => r.ok));

  for (const id of locks.REQUIRED_RED) {
    const row = redResults.find((r) => r.id === id);
    ok(`RED-required ${id}`, row && row.ok);
  }

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16AI G06 live-load evidence (partial/live-proven conservative readiness): PASS');
}

runVerifier();
