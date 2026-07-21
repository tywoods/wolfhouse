'use strict';

/**
 * verify:radar-slice16ad-g02-sampled-restart-continuity-evidence — RADAR Slice 16AD
 *
 * Offline gate: bounded concurrent sampled revision-restart continuity evidence.
 * Rejects: hidden WH warmup failures; treating warmup as restart failures;
 * claiming all 91 WH passed; wrong sample/window/status; wrong LAW
 * timestamp/payload; fabricated Azure historical samples; absolute downtime
 * claim; production/full G02 overclaims; lock_hash mismatch.
 * No Azure mutation.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16ad-g02-sampled-restart-continuity-evidence');

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

function computeEvidenceLockHash(ev) {
  const clone = deepClone(ev);
  delete clone.lock_hash;
  return crypto.createHash('sha256').update(stableStringify(clone)).digest('hex');
}

function secretFree(blob, label) {
  const text = String(blob || '');
  const hits = [];
  if (/sk_live_[A-Za-z0-9]+|sk_test_[A-Za-z0-9]+|postgres:\/\/[^"'\s]+|postgresql:\/\/[^"'\s]+|AccountKey=[A-Za-z0-9+/=]+/i.test(text)) {
    hits.push('secret_like');
  }
  return { ok: hits.length === 0, detail: hits.join(',') || `${label}:clean` };
}

function classA(ev) {
  return ev.observed_facts && ev.observed_facts.A_operator_observed_drill_transcript;
}

function classB(ev) {
  return ev.observed_facts && ev.observed_facts.B_independently_recoverable_azure_readonly;
}

function tenantA(ev, kind) {
  const a = classA(ev);
  return a && a[kind];
}

function tenantB(ev, kind) {
  const b = classB(ev);
  return b && b[kind];
}

function validateWhSamples(wh) {
  const errors = [];
  if (!wh || !Array.isArray(wh.samples) || wh.samples.length !== locks.SAMPLE_COUNT) {
    errors.push(`WH sample count want ${locks.SAMPLE_COUNT}`);
    return { ok: false, errors };
  }
  if (!wh.warmup_disclosure
    || JSON.stringify(wh.warmup_disclosure.sample_indices) !== JSON.stringify([...locks.WH_WARMUP_EXCLUDED_INDICES])
    || wh.warmup_disclosure.outcome !== 'timeout'
    || wh.warmup_disclosure.excluded_from_restart_window_claim !== true
    || wh.warmup_disclosure.must_not_hide !== true
    || wh.warmup_disclosure.must_not_treat_as_restart_window_failure !== true
    || wh.warmup_disclosure.must_not_claim_all_91_passed !== true) {
    errors.push('WH warmup_disclosure incomplete/wrong');
  }
  for (let i = 0; i < locks.SAMPLE_COUNT; i += 1) {
    const s = wh.samples[i];
    if (!s || s.sample_index !== i) errors.push(`WH sample_index gap at ${i}`);
    const isWarmup = locks.WH_WARMUP_EXCLUDED_INDICES.includes(i);
    if (isWarmup) {
      if (s.outcome !== 'timeout' || s.public_healthz !== 'timeout' || s.public_readyz !== 'timeout') {
        errors.push(`WH warmup ${i} not timeout`);
      }
      if (s.excluded_from_restart_window_claim !== true) errors.push(`WH warmup ${i} not excluded`);
      if (s.sample_class !== locks.SAMPLE_CLASS_WARMUP) errors.push(`WH warmup ${i} bad class`);
    } else {
      if (s.public_healthz !== 200 || s.public_readyz !== 200 || s.outcome !== 'both_200') {
        errors.push(`WH claim sample ${i} not both_200`);
      }
      if (s.excluded_from_restart_window_claim !== false) errors.push(`WH claim ${i} wrongly excluded`);
    }
  }
  if (wh.poll_window.start_utc !== locks.WH_POLL_WINDOW.start_utc
    || wh.poll_window.end_utc !== locks.WH_POLL_WINDOW.end_utc) {
    errors.push('WH poll_window mismatch');
  }
  if (wh.operator_restart.started_utc !== locks.WH_RESTART.started_utc
    || wh.operator_restart.ended_utc !== locks.WH_RESTART.ended_utc) {
    errors.push('WH restart window mismatch');
  }
  for (const exp of locks.WH_RESTART_WINDOW_SAMPLES) {
    const s = wh.samples.find((x) => x.sample_index === exp.sample_index);
    const r = (wh.restart_window_samples || []).find((x) => x.sample_index === exp.sample_index);
    if (!s || s.absolute_observed_at_utc !== exp.absolute_observed_at_utc
      || s.public_healthz !== 200 || s.public_readyz !== 200) {
      errors.push(`WH restart sample ${exp.sample_index} mismatch`);
    }
    if (!r || r.absolute_observed_at_utc !== exp.absolute_observed_at_utc
      || r.public_healthz !== 200 || r.public_readyz !== 200) {
      errors.push(`WH restart_window_samples ${exp.sample_index} mismatch`);
    }
  }
  // Must not claim all 91 passed
  const allPassed = wh.samples.every((s) => s.outcome === 'both_200');
  if (allPassed) errors.push('WH incorrectly claims all 91 passed');
  if (wh.claim_eligible_samples.sample_count !== locks.WH_CLAIM_SAMPLE_COUNT) {
    errors.push('WH claim_eligible sample_count wrong');
  }
  return { ok: errors.length === 0, errors };
}

function validateSunsetSamples(su) {
  const errors = [];
  if (!su || !Array.isArray(su.samples) || su.samples.length !== locks.SAMPLE_COUNT) {
    errors.push(`Sunset sample count want ${locks.SAMPLE_COUNT}`);
    return { ok: false, errors };
  }
  for (let i = 0; i < locks.SAMPLE_COUNT; i += 1) {
    const s = su.samples[i];
    if (!s || s.sample_index !== i) errors.push(`Sunset sample_index gap at ${i}`);
    if (s.public_healthz !== 200 || s.public_readyz !== 200 || s.outcome !== 'both_200') {
      errors.push(`Sunset sample ${i} not both_200`);
    }
    if (s.excluded_from_restart_window_claim !== false) errors.push(`Sunset ${i} wrongly excluded`);
  }
  if (su.poll_window.start_utc !== locks.SUNSET_POLL_WINDOW.start_utc
    || su.poll_window.end_utc !== locks.SUNSET_POLL_WINDOW.end_utc) {
    errors.push('Sunset poll_window mismatch');
  }
  if (su.operator_restart.started_utc !== locks.SUNSET_RESTART.started_utc
    || su.operator_restart.ended_utc !== locks.SUNSET_RESTART.ended_utc) {
    errors.push('Sunset restart window mismatch');
  }
  for (const exp of locks.SUNSET_RESTART_WINDOW_SAMPLES) {
    const s = su.samples.find((x) => x.sample_index === exp.sample_index);
    if (!s || s.absolute_observed_at_utc !== exp.absolute_observed_at_utc
      || s.public_healthz !== 200 || s.public_readyz !== 200) {
      errors.push(`Sunset restart sample ${exp.sample_index} mismatch`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateLaw(tenant, kind) {
  const errors = [];
  const law = tenant && tenant.law_completion;
  if (!law) return { ok: false, errors: [`${kind} missing law_completion`] };
  const wantTime = kind === 'wolfhouse' ? locks.WH_LAW_TIME : locks.SUNSET_LAW_TIME;
  const wantRev = kind === 'wolfhouse' ? locks.WH_REVISION : locks.SUNSET_REVISION;
  const wantRep = kind === 'wolfhouse' ? locks.WH_LAW_REPLICA : locks.SUNSET_LAW_REPLICA;
  if (law.TimeGenerated !== wantTime) errors.push(`${kind} LAW time`);
  if (law.revision !== wantRev) errors.push(`${kind} LAW revision`);
  if (law.replica !== wantRep) errors.push(`${kind} LAW replica`);
  const rec = law.record || {};
  if (rec.event !== locks.EVENT_NAME
    || rec.original_signal !== 'SIGTERM'
    || rec.pool_close_result !== 'ok'
    || rec.server_close_result !== 'ok'
    || rec.completion !== true
    || !Array.isArray(rec.failure_classes)
    || rec.failure_classes.length !== 0) {
    errors.push(`${kind} LAW payload`);
  }
  const keys = Object.keys(rec).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...locks.ALLOWED_RECORD_KEYS].sort())) {
    errors.push(`${kind} LAW record keys`);
  }
  return { ok: errors.length === 0, errors };
}

function validateClassBCurrent(tenant, kind) {
  const errors = [];
  if (!tenant) return { ok: false, errors: [`${kind} missing`] };
  if (tenant.active_revisions_mode !== 'Single') errors.push(`${kind} mode`);
  if (tenant.latest_revision !== (kind === 'wolfhouse' ? locks.WH_REVISION : locks.SUNSET_REVISION)) {
    errors.push(`${kind} latest`);
  }
  if (tenant.latest_ready_revision !== tenant.latest_revision) errors.push(`${kind} latestReady`);
  if (tenant.traffic_weight_percent !== 100) errors.push(`${kind} traffic`);
  if (tenant.health_state !== 'Healthy') errors.push(`${kind} healthState`);
  if (!tenant.public_current || tenant.public_current.healthz !== 200 || tenant.public_current.readyz !== 200) {
    errors.push(`${kind} public_current`);
  }
  if (tenant.digest !== (kind === 'wolfhouse' ? locks.WH_DIGEST : locks.SUNSET_DIGEST)) {
    errors.push(`${kind} digest`);
  }
  return { ok: errors.length === 0, errors };
}

function claimsAbsoluteOrAll91OrProduction(ev) {
  const blob = JSON.stringify(ev);
  if (/\babsolute_zero_downtime\b/.test(blob) && Array.isArray(ev.disposition?.proves)
    && ev.disposition.proves.includes('absolute_zero_downtime')) return true;
  if (ev.claims_allowed && ev.claims_allowed.includes('all_91_wh_samples_passed')) return true;
  if (ev.disposition && ev.disposition.proves
    && (ev.disposition.proves.includes('production')
      || ev.disposition.proves.includes('full_G02_proven')
      || ev.disposition.proves.includes('absolute_zero_downtime')
      || ev.disposition.proves.includes('all_91_wh_samples_passed'))) {
    return true;
  }
  if (ev.disposition && ev.disposition.g02_verdict === 'proven') return true;
  return false;
}

function historicalSamplesFabricatedAsAzure(ev) {
  const a = classA(ev);
  if (!a) return true;
  if (a.source_type !== locks.SOURCE_TYPE_A) return true;
  const wh = a.wolfhouse;
  if (!wh || !Array.isArray(wh.samples)) return true;
  return wh.samples.some((s) => s.source_type && s.source_type !== locks.SOURCE_TYPE_A);
}

function validateEvidenceCore(ev) {
  const errors = [];
  if (ev.slice !== locks.SLICE) errors.push('slice');
  if (ev.branch !== locks.BRANCH) errors.push('branch');
  if (ev.master_basis !== locks.MASTER_BASIS) errors.push('master');
  if (ev.outcome_id !== locks.OUTCOME_ID) errors.push('outcome');
  if (ev.live_mutation !== false || ev.this_slice_deploys !== false) errors.push('mutation flags');
  if (ev.claim_semantics !== locks.CLAIM_SEMANTICS) errors.push('claim_semantics');
  if (computeEvidenceLockHash(ev) !== ev.lock_hash) errors.push('lock_hash');
  for (const k of locks.EXPLICITLY_NOT_CLAIMED) {
    if (!ev.explicitly_not_claimed.includes(k)) errors.push(`missing not_claimed ${k}`);
  }
  for (const k of locks.CLAIMS_ALLOWED) {
    if (!ev.claims_allowed.includes(k)) errors.push(`missing claim ${k}`);
  }
  if (claimsAbsoluteOrAll91OrProduction(ev)) errors.push('overclaim');
  if (historicalSamplesFabricatedAsAzure(ev)) errors.push('fabricated azure samples');
  const whV = validateWhSamples(tenantA(ev, 'wolfhouse'));
  const suV = validateSunsetSamples(tenantA(ev, 'sunset'));
  errors.push(...whV.errors, ...suV.errors);
  errors.push(...validateLaw(tenantB(ev, 'wolfhouse'), 'wolfhouse').errors);
  errors.push(...validateLaw(tenantB(ev, 'sunset'), 'sunset').errors);
  errors.push(...validateClassBCurrent(tenantB(ev, 'wolfhouse'), 'wolfhouse').errors);
  errors.push(...validateClassBCurrent(tenantB(ev, 'sunset'), 'sunset').errors);
  if (ev.disposition.g02_verdict !== 'partial') errors.push('g02 not partial');
  if (!ev.gate_progress_updates.G02_readiness_dependencies.live_proven.includes(
    'concurrent_sampled_restart_continuity_via_16AD',
  )) {
    errors.push('missing live_proven 16AD');
  }
  if (!ev.gate_progress_updates.G02_readiness_dependencies.still_open.includes('production')) {
    errors.push('production still_open missing');
  }
  if (ev.gate_progress_updates.G02_readiness_dependencies.still_open.some(
    (x) => /concurrent_sampled_restart_continuity(?!.*absolute)/i.test(String(x))
      && !/absolute|between|sub.?second|cold/i.test(String(x)),
  )) {
    // still listing the closed gap as open without qualification is wrong
    const open = ev.gate_progress_updates.G02_readiness_dependencies.still_open;
    if (open.includes('concurrent_sampled_restart_continuity')
      || open.includes('Zero downtime during restart / concurrent sampled continuity not claimed')) {
      errors.push('concurrent sampled continuity still listed open unqualified');
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateGateMatrix(matrix) {
  const errors = [];
  const tip16ae = matrix.slice === 'RADAR-16AE';
  if (matrix.slice !== locks.SLICE && !tip16ae) errors.push('matrix.slice');
  if (matrix.slice === locks.SLICE) {
    if (matrix.branch !== locks.BRANCH) errors.push('matrix.branch');
    if (matrix.master_basis !== locks.MASTER_BASIS) errors.push('matrix.master');
  }
  const g02 = (matrix.gates || []).find((g) => g.id === 'G02_readiness_dependencies');
  if (!g02 || g02.verdict !== 'partial') errors.push('g02 verdict');
  if (!/16AD|sampled.?restart|concurrent.?sampled/i.test(String(g02.rationale || ''))) {
    errors.push('g02 rationale missing 16AD');
  }
  if (!(g02.gaps || []).some((g) => /production/i.test(String(g)))) errors.push('g02 gaps production');
  if ((g02.gaps || []).some((g) => /^Zero downtime during restart \/ concurrent sampled continuity not claimed$/i.test(String(g)))) {
    errors.push('g02 still lists concurrent sampled continuity as open unqualified');
  }
  if (!(g02.live_evidence || []).some((e) => /slice16ad/i.test(String(e.ref || e.note || '')))) {
    errors.push('g02 live_evidence missing 16AD');
  }
  const sel = matrix.slice_16ad_selection;
  if (!sel || sel.selected !== true || sel.outcome_id !== locks.OUTCOME_ID) {
    errors.push('slice_16ad_selection');
  }
  return { ok: errors.length === 0, errors };
}

function fieldLevelOverclaim(text) {
  const hits = [];
  const forbidden = [
    /\bG02\s+proven\b/i,
    /\bfull\s+G02\b/i,
    /\babsolute\s+zero\s+downtime\b(?!.*not claimed)/i,
    /\ball\s+91\s+WH\s+passed\b/i,
  ];
  // Allow "not absolute zero downtime" / "does not claim absolute"
  for (const re of forbidden) {
    if (re.test(text) && !/not claim|does not claim|not claimed|explicitly not/i.test(text)) {
      // more careful: only fail if positive overclaim without negation nearby
    }
  }
  if (/\bG02\s+proven\b/i.test(text)) hits.push('G02 proven');
  if (/\bfull\s+G02\b/i.test(text) && !/not.*full G02|full G02\.|not claim.*full/i.test(text)) {
    hits.push('full G02');
  }
  return hits;
}

function runVerifier() {
  console.log('RADAR 16AD G02 sampled restart continuity evidence — offline verifier\n');

  const evidence = readJson(locks.EVIDENCE_REL);
  const contract = readJson(locks.CONTRACT_REL);
  const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
  const topContract = readJson('fixtures/radar-operations/contract.json');
  const findings = readText('fixtures/radar-operations/findings.md');
  const doc = readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md');

  ok('C1 evidence slice/branch/master',
    evidence.slice === locks.SLICE
    && evidence.branch === locks.BRANCH
    && evidence.master_basis === locks.MASTER_BASIS
    && evidence.outcome_id === locks.OUTCOME_ID
    && evidence.progress_class === locks.PROGRESS_CLASS
    && evidence.live_mutation === false
    && evidence.this_slice_deploys === false);

  ok('C2 contract slice/branch/master',
    contract.slice === locks.SLICE
    && contract.branch === locks.BRANCH
    && contract.master_basis === locks.MASTER_BASIS
    && contract.outcome_id === locks.OUTCOME_ID
    && contract.live_deploy === false
    && contract.this_slice_deploys === false);

  ok('C3 HEAD on 16AD branch or successor tip 16AE',
    currentBranch() === locks.BRANCH
    || currentBranch() === 'radar/slice-16ae-g01-capability-boundary-freeze',
    currentBranch());

  {
    const v = validateEvidenceCore(evidence);
    ok('C4 evidence exact schema + warmup + restart windows + LAW + lock_hash',
      v.ok, v.errors.slice(0, 15).join(' | '));
  }

  ok('C5 claim semantics bounded (sampling resolution after warmup)',
    evidence.claim_semantics === locks.CLAIM_SEMANTICS
    && evidence.disposition.proves.includes(
      'no_observed_public_interruption_at_sampling_resolution_during_declared_restart_windows_after_warmup',
    )
    && evidence.disposition.does_not_prove.includes('absolute_zero_downtime')
    && evidence.disposition.does_not_prove.includes('between_sample_proof')
    && evidence.disposition.does_not_prove.includes('all_91_wh_samples_passed')
    && evidence.disposition.does_not_prove.includes('cold_start_availability')
    && evidence.disposition.does_not_prove.includes('production')
    && evidence.disposition.does_not_prove.includes('full_G02_proven'));

  ok('C6 G02 partial; concurrent sampled continuity closed; production open',
    evidence.disposition.g02_verdict === 'partial'
    && evidence.gate_progress_updates.G02_readiness_dependencies.verdict === 'partial'
    && evidence.gate_progress_updates.G02_readiness_dependencies.closed_by_this_slice.includes(
      'concurrent_sampled_restart_continuity_at_declared_sampling_resolution_after_warmup',
    )
    && evidence.gate_progress_updates.G02_readiness_dependencies.still_open.includes('production'));

  {
    const mv = validateGateMatrix(matrix);
    ok('C7 matrix tip=16AD-or-16AE G02 partial with 16AD selection retained', mv.ok, mv.errors.join(' | '));
  }

  ok('C8 top contract selected_16ad + prior selections retained',
    (topContract.slice === locks.SLICE || topContract.slice === 'RADAR-16AE')
    && topContract.selected_16ad
    && topContract.selected_16ad.outcome_id === locks.OUTCOME_ID
    && topContract.selected_16ad.g02_sampled_restart_continuity === 'live_proven_via_16AD'
    && topContract.selected_16ad.g02_verdict === 'partial'
    && topContract.selected_16ac
    && topContract.selected_16ab
    && topContract.selected_16aa
    && topContract.selected_16z);

  ok('C9 doc mentions 16AD + warmup disclosure + sampling-resolution claim without G02 proven',
    /16AD|sampled.?restart|concurrent.?sampled/i.test(doc)
    && /warmup|0\.\.2|samples 0..2/i.test(doc)
    && /sampling resolution|not absolute|not claim.*absolute/i.test(doc)
    && /partial/i.test(doc)
    && !/\bG02\s+proven\b/i.test(doc));

  ok('C10 findings mention 16AD without proven overclaim',
    /16AD/.test(findings)
    && /warmup|sampling resolution|partial/i.test(findings)
    && !/\bG02\s+proven\b/i.test(findings));

  {
    const rt = runtimePathsUnchanged();
    ok('C11 runtime paths unchanged vs master', rt.ok, rt.detail);
  }

  {
    const sec = secretFree(JSON.stringify(evidence), 'evidence');
    ok('C12 secret-free evidence', sec.ok, sec.detail);
  }

  {
    const pkg = readJson('package.json');
    ok('C13 package script registered',
      pkg.scripts
      && pkg.scripts['verify:radar-slice16ad-g02-sampled-restart-continuity-evidence']
        === 'node scripts/verify-radar-slice16ad-g02-sampled-restart-continuity-evidence.js');
  }

  green('wh_warmup_disclosed_excluded',
    validateWhSamples(tenantA(evidence, 'wolfhouse')).ok);

  green('sunset_all_both_200',
    validateSunsetSamples(tenantA(evidence, 'sunset')).ok);

  green('law_exact_both_tenants',
    validateLaw(tenantB(evidence, 'wolfhouse'), 'wolfhouse').ok
    && validateLaw(tenantB(evidence, 'sunset'), 'sunset').ok);

  green('class_b_single_latest_100',
    validateClassBCurrent(tenantB(evidence, 'wolfhouse'), 'wolfhouse').ok
    && validateClassBCurrent(tenantB(evidence, 'sunset'), 'sunset').ok);

  green('bounded_claim_not_absolute',
    !claimsAbsoluteOrAll91OrProduction(evidence)
    && evidence.explicitly_not_claimed.includes('absolute_zero_downtime')
    && evidence.explicitly_not_claimed.includes('all_91_wh_samples_passed'));

  green('samples_not_azure_fabricated', !historicalSamplesFabricatedAsAzure(evidence));

  green('runtime_paths_unchanged', runtimePathsUnchanged().ok);

  green('lock_hash_stable', computeEvidenceLockHash(evidence) === evidence.lock_hash);

  // --- RED suite ---
  {
    const bad = deepClone(evidence);
    // hide warmup: mark 0..2 as both_200 and remove disclosure
    for (const i of [0, 1, 2]) {
      bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.samples[i].outcome = 'both_200';
      bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.samples[i].public_healthz = 200;
      bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.samples[i].public_readyz = 200;
      bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.samples[i].excluded_from_restart_window_claim = false;
    }
    delete bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.warmup_disclosure;
    bad.lock_hash = computeEvidenceLockHash(bad);
    red('hidden_wh_warmup_failures', !validateEvidenceCore(bad).ok);
  }

  {
    const bad = deepClone(evidence);
    // treat warmup as restart failure: put timeout samples inside restart window claim
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.samples[8].outcome = 'timeout';
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.samples[8].public_healthz = 'timeout';
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.samples[8].public_readyz = 'timeout';
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.samples[8].sample_class = locks.SAMPLE_CLASS_WARMUP;
    bad.lock_hash = computeEvidenceLockHash(bad);
    red('warmup_or_timeout_treated_as_restart_window_success_path_break', !validateEvidenceCore(bad).ok);
  }

  {
    const bad = deepClone(evidence);
    bad.claims_allowed.push('all_91_wh_samples_passed');
    bad.disposition.proves.push('all_91_wh_samples_passed');
    for (const i of [0, 1, 2]) {
      const s = bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.samples[i];
      s.outcome = 'both_200';
      s.public_healthz = 200;
      s.public_readyz = 200;
      s.excluded_from_restart_window_claim = false;
    }
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.warmup_disclosure.must_not_claim_all_91_passed = false;
    bad.lock_hash = computeEvidenceLockHash(bad);
    red('claim_all_91_wh_passed', !validateEvidenceCore(bad).ok || claimsAbsoluteOrAll91OrProduction(bad));
  }

  {
    const bad = deepClone(evidence);
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.operator_restart.started_utc = '2026-07-21T13:21:00Z';
    bad.lock_hash = computeEvidenceLockHash(bad);
    red('wrong_restart_window', !validateEvidenceCore(bad).ok);
  }

  {
    const bad = deepClone(evidence);
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.samples[8].public_readyz = 503;
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.samples[8].outcome = 'readyz_503';
    bad.lock_hash = computeEvidenceLockHash(bad);
    red('wrong_restart_sample_status', !validateEvidenceCore(bad).ok);
  }

  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.law_completion.TimeGenerated = '2026-07-21T13:22:00.0000000Z';
    bad.lock_hash = computeEvidenceLockHash(bad);
    red('wrong_law_timestamp', !validateEvidenceCore(bad).ok);
  }

  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.sunset.law_completion.record.pool_close_result = 'error';
    bad.lock_hash = computeEvidenceLockHash(bad);
    red('wrong_law_payload', !validateEvidenceCore(bad).ok);
  }

  {
    const bad = deepClone(evidence);
    for (const s of bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.samples) {
      s.source_type = locks.SOURCE_TYPE_B;
    }
    bad.observed_facts.A_operator_observed_drill_transcript.source_type = locks.SOURCE_TYPE_B;
    bad.lock_hash = computeEvidenceLockHash(bad);
    red('fabricated_azure_historical_samples', !validateEvidenceCore(bad).ok || historicalSamplesFabricatedAsAzure(bad));
  }

  {
    const bad = deepClone(evidence);
    bad.disposition.proves.push('absolute_zero_downtime');
    bad.disposition.does_not_prove = bad.disposition.does_not_prove.filter((x) => x !== 'absolute_zero_downtime');
    bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'absolute_zero_downtime');
    bad.lock_hash = computeEvidenceLockHash(bad);
    red('absolute_downtime_claim', !validateEvidenceCore(bad).ok || claimsAbsoluteOrAll91OrProduction(bad));
  }

  {
    const bad = deepClone(evidence);
    bad.disposition.g02_verdict = 'proven';
    bad.disposition.proves.push('full_G02_proven');
    bad.disposition.proves.push('production');
    bad.lock_hash = computeEvidenceLockHash(bad);
    red('production_or_full_g02', !validateEvidenceCore(bad).ok || claimsAbsoluteOrAll91OrProduction(bad));
  }

  {
    const bad = deepClone(evidence);
    bad.lock_hash = '0'.repeat(64);
    red('lock_hash_mismatch', !validateEvidenceCore(bad).ok);
  }

  const redFailed = redResults.filter((r) => !r.ok);
  const greenFailed = greenResults.filter((r) => !r.ok);
  ok('RED suite all rejected', redFailed.length === 0, redFailed.map((r) => r.id).join(','));
  ok('GREEN suite all passed', greenFailed.length === 0, greenFailed.map((r) => r.id).join(','));

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16AD G02 sampled restart continuity evidence (partial/live-proven): PASS');
}

runVerifier();
