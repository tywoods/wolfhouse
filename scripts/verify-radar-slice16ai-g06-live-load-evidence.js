'use strict';

/**
 * verify:radar-slice16ai-g06-live-load-evidence — RADAR Slice 16AI
 *
 * Offline gate: bounded evidence reconciliation of the successful controlled
 * dual-staging /readyz bounded-load drill + Sunset MTD ActualCost guard.
 *
 * Claims are bound only to committed secret-free raw fixtures (slice16ai-raw-*)
 * via SHA-256 of exact file bytes. Rejects metric/status/count/latency/cost/
 * scope/overclaim drift, raw artifact/hash drift, reappearance of omitted
 * pre/post-readyz or 429/retry claims, and lock_hash mismatch.
 * Records final_controlled_drill live_proven for the conservative readiness
 * profile only. G06 remains partial. No Azure mutation / live network by this
 * verifier.
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

function readBytes(rel) {
  return fs.readFileSync(path.join(ROOT, rel));
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
  const paths = locks.MUST_NOT_MUTATE.filter((p) => p !== 'scripts/staff-query-api.js');
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

function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
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
  if (Object.prototype.hasOwnProperty.call(root, 'pre_post_readyz')) {
    errors.push('pre_post_readyz_must_be_absent');
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
  if (Object.prototype.hasOwnProperty.call(c, 'after_query_initial_429_then_successful_retry')) {
    errors.push('429_flag_must_be_absent');
  }
  if (Object.prototype.hasOwnProperty.call(c, 'after_query_initial_status')) {
    errors.push('429_status_must_be_absent');
  }
  if (Object.prototype.hasOwnProperty.call(c, 'after_query_retry_status')) {
    errors.push('retry_status_must_be_absent');
  }
  return { ok: errors.length === 0, errors };
}

function validateRawArtifactHashes(ev) {
  const errors = [];
  const expected = [
    [locks.RAW_DRILL_REL, locks.RAW_DRILL_SHA256, 'raw_drill'],
    [locks.RAW_COST_BEFORE_REL, locks.RAW_COST_BEFORE_SHA256, 'raw_cost_before'],
    [locks.RAW_COST_AFTER_REL, locks.RAW_COST_AFTER_SHA256, 'raw_cost_after'],
  ];
  const prov = ev && ev.durable_raw_artifact_provenance;
  if (!prov || !Array.isArray(prov.artifacts) || prov.artifacts.length !== 3) {
    return { ok: false, errors: ['provenance artifacts missing'] };
  }
  for (const [rel, expectSha, id] of expected) {
    if (!fs.existsSync(path.join(ROOT, rel))) {
      errors.push(`missing ${rel}`);
      continue;
    }
    const got = sha256Bytes(readBytes(rel));
    if (got !== expectSha) errors.push(`${id} file hash ${got} != ${expectSha}`);
    const row = prov.artifacts.find((a) => a.id === id);
    if (!row) {
      errors.push(`provenance missing ${id}`);
      continue;
    }
    if (row.path !== rel) errors.push(`${id} path`);
    if (row.sha256 !== expectSha) errors.push(`${id} provenance sha`);
  }
  if (!deepEqual(prov.excluded_ephemeral_paths, [...locks.EXCLUDED_EPHEMERAL_PATHS])) {
    errors.push('excluded_ephemeral_paths');
  }
  const drill = drillRoot(ev);
  const cost = costRoot(ev);
  if (!drill || drill.raw_artifact_sha256 !== locks.RAW_DRILL_SHA256) {
    errors.push('drill.raw_artifact_sha256');
  }
  if (!cost
    || cost.raw_before_sha256 !== locks.RAW_COST_BEFORE_SHA256
    || cost.raw_after_sha256 !== locks.RAW_COST_AFTER_SHA256) {
    errors.push('cost raw sha fields');
  }
  return { ok: errors.length === 0, errors };
}

function validateEvidenceMatchesRaw(ev) {
  const errors = [];
  const rawDrill = readJson(locks.RAW_DRILL_REL);
  const rawBefore = readJson(locks.RAW_COST_BEFORE_REL);
  const rawAfter = readJson(locks.RAW_COST_AFTER_REL);
  const root = drillRoot(ev);
  const cost = costRoot(ev);
  if (!root || !cost) return { ok: false, errors: ['missing roots'] };

  const whRaw = rawDrill.results.find((r) => r.target === locks.WH_READYZ_URL);
  const sunRaw = rawDrill.results.find((r) => r.target === locks.SUNSET_READYZ_URL);
  if (!whRaw || !sunRaw) return { ok: false, errors: ['raw targets missing'] };

  const strip = (row) => ({
    target: row.target,
    method: row.method,
    profile: row.profile,
    started: row.started,
    completed: row.completed,
    peak_in_flight: row.peak_in_flight,
    wall_ms: row.wall_ms,
    stop_reason: row.stop_reason,
    status_counts: row.status_counts,
    error_code_classes: row.error_code_classes,
    latency: row.latency,
    response_bodies_collected: row.response_bodies_collected,
    redirects_followed: row.redirects_followed,
    headers_sent: row.headers_sent,
    auth_sent: row.auth_sent,
    body_sent: row.body_sent,
    dns_pinned: row.dns_pinned,
    active_requests_remaining: row.active_requests_remaining,
  });

  if (!deepEqual(strip(root.wolfhouse), strip(whRaw))) errors.push('wh mismatch vs raw');
  if (!deepEqual(strip(root.sunset), strip(sunRaw))) errors.push('sunset mismatch vs raw');
  if (root.drill_executed_at !== rawDrill.executed_at) errors.push('executed_at');
  if (root.drill_id !== rawDrill.drill_id) errors.push('drill_id');
  if (root.master_sha !== rawDrill.master_sha) errors.push('master_sha');

  if (cost.amount_before !== rawBefore.amount) errors.push('amount_before');
  if (cost.amount_after !== rawAfter.amount) errors.push('amount_after');
  if (cost.captured_before_at !== rawBefore.capturedAt) errors.push('captured_before');
  if (cost.captured_after_at !== rawAfter.capturedAt) errors.push('captured_after');
  if (cost.scope !== rawBefore.scope || cost.scope !== rawAfter.scope) errors.push('scope');
  if (Object.prototype.hasOwnProperty.call(rawDrill, 'pre_post_readyz')) {
    errors.push('raw_drill unexpectedly has pre_post_readyz');
  }
  return { ok: errors.length === 0, errors };
}

function omittedClaimsAbsent(ev, sliceContract, matrix, doc, findings) {
  const errors = [];
  const blobs = [
    JSON.stringify(ev),
    JSON.stringify(sliceContract),
    JSON.stringify(matrix.slice_16ai_selection || {}),
    // 16AI-owned doc/findings sections: full docs may mention 16AH pre/post attempt
  ];
  for (const token of [
    'pre_post_readyz_ready',
    'after_query_initial_429_then_successful_retry',
    'after_query_initial_status',
    'after_query_retry_status',
  ]) {
    if (ev.claims_allowed && ev.claims_allowed.includes(token)) {
      errors.push(`claims_allowed has ${token}`);
    }
    if (!(ev.explicitly_not_claimed || []).includes(token)
      && (token === 'pre_post_readyz_ready'
        || token === 'after_query_initial_429_then_successful_retry')) {
      errors.push(`explicitly_not_claimed missing ${token}`);
    }
  }
  if (drillRoot(ev) && Object.prototype.hasOwnProperty.call(drillRoot(ev), 'pre_post_readyz')) {
    errors.push('evidence.pre_post_readyz present');
  }
  if (costRoot(ev)
    && Object.prototype.hasOwnProperty.call(
      costRoot(ev),
      'after_query_initial_429_then_successful_retry',
    )) {
    errors.push('evidence.429 flag present');
  }
  if (sliceContract.required_observed
    && Object.prototype.hasOwnProperty.call(sliceContract.required_observed, 'pre_post_readyz')) {
    errors.push('contract.required_observed.pre_post_readyz');
  }
  if (sliceContract.required_observed
    && Object.prototype.hasOwnProperty.call(
      sliceContract.required_observed,
      'after_query_initial_429_then_successful_retry',
    )) {
    errors.push('contract.required_observed.429');
  }
  // 16AI outcome/table claims in docs/findings must not affirmatively assert omitted facts.
  // Negation phrasing ("does not claim", "explicitly omitted", "does not prove") is allowed.
  const aiDocHit = /## Outcome \(16AI\)[\s\S]*?(?=## Outcome \(16AH)/.exec(doc);
  const aiFindingsHit = /## Slice 16AI[\s\S]*?(?=## Slice 16AH)/.exec(findings);
  const aiOwned = `${aiDocHit ? aiDocHit[0] : ''}\n${aiFindingsHit ? aiFindingsHit[0] : ''}`;
  const affirmativePrePost = /(?:^|\n)\s*(?:\|)?\s*Pre\/post[^\n]*\|\s*ready\b/i.test(aiOwned)
    || /pre\/post\s+`?\/readyz`?\s+\*\*ready\*\*/i.test(aiOwned)
    || /pre\/post\s+`?\/readyz`?\s+ready(?!ness)/i.test(
      aiOwned.replace(/does\s+not\s+(?:\*\*)?claim[\s\S]{0,80}pre\/post/gi, '')
        .replace(/does not prove:[\s\S]*?(?=\n\n|\n\*\*)/gi, '')
        .replace(/explicitly omitted[^\n]*/gi, '')
        .replace(/explicitly does \*\*not\*\* claim[^\n]*/gi, ''),
    );
  const affirmative429 = /initial after-query\s+\*\*429\*\*/i.test(aiOwned)
    || /429 then successful retry disclosed/i.test(aiOwned)
    || (/before=after[^\n]*429/i.test(aiOwned) && !/omitted|not claim|does not prove/i.test(aiOwned));
  if (affirmativePrePost) errors.push('16AI docs claim pre/post ready');
  if (affirmative429) errors.push('16AI docs claim 429');
  const selNote = JSON.stringify(matrix.slice_16ai_selection || {});
  if (/pre\/post \/readyz ready(?!ness)/i.test(selNote)
    && !/explicitly not claimed|omitted/i.test(selNote)) {
    errors.push('matrix 16AI selection claims pre/post ready');
  }
  if (/429 then successful retry disclosed|initial after-query 429/i.test(selNote)) {
    errors.push('matrix 16AI selection claims 429');
  }
  for (const b of blobs) {
    if (/"pre_post_readyz"\s*:/.test(b)) errors.push('pre_post_readyz key in locked blob');
    if (/after_query_initial_429_then_successful_retry/.test(b)
      && !/does_not_prove|explicitly_not_claimed|must_not_claim|OMITTED|not claim|omitted/.test(b)) {
      // allow only as negative claim tokens
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateGateMatrix(matrix) {
  const errors = [];
  if (!matrix || typeof matrix !== 'object') return { ok: false, errors: ['matrix missing'] };
  const tip16aj = matrix.slice === 'RADAR-16AJ'
    && matrix.branch === 'radar/slice-16aj-g06-slo-error-budget-source'
    && matrix.master_basis === '0994989a3d5d14daa98797fac55083b0c2ea809c';
  const tip16ak = matrix.slice === 'RADAR-16AK'
    && matrix.branch === 'radar/slice-16ak-g06-backpressure-source'
    && matrix.master_basis === '9fa3626326c0e2bc21f2d37905967d6ff47b7520';
  const tip16al = matrix.slice === 'RADAR-16AL'
    && matrix.branch === 'radar/slice-16al-g06-backpressure-wire'
    && matrix.master_basis === '502d762f897432c67bb8b17a8a49bfab01a0787d';
  const tip16am = matrix.slice === 'RADAR-16AM'
    && matrix.branch === 'radar/slice-16am-g06-backpressure-deploy-evidence'
    && matrix.master_basis === '905ff9ff57a75d0b3defc15a16078b47e94e930f';
  const tipOk = (matrix.slice === locks.SLICE
    && matrix.branch === locks.BRANCH
    && matrix.master_basis === locks.MASTER_BASIS)
    || tip16aj
    || tip16ak
    || tip16al
    || tip16am;
  if (!tipOk) {
    errors.push(`slice=${matrix.slice}`);
    errors.push(`branch=${matrix.branch}`);
    errors.push('master_basis mismatch');
  }
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
    if (/16AI reconciles[\s\S]*initial after-query 429 then successful retry disclosed/.test(
      String(g06.rationale || ''),
    )) {
      errors.push('G06 rationale still claims 16AI 429');
    }
    if (/16AI reconciles[\s\S]*pre\/post \/readyz ready;/.test(String(g06.rationale || ''))) {
      errors.push('G06 rationale still claims 16AI pre/post ready');
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
    const lines = String(text || '').split('\n');
    for (const line of lines) {
      if (p.test(line)
        && !/not claimed|does\s*\*+\s*not|does not|never|open|forbidden|explicitly|default OFF|not enabled|claiming /i.test(line)) {
        hits.push(String(p));
        break;
      }
    }
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

  const tip16aj = matrix.slice === 'RADAR-16AJ';
  const tip16ak = matrix.slice === 'RADAR-16AK';
  const tip16al = matrix.slice === 'RADAR-16AL';
  const tip16am = matrix.slice === 'RADAR-16AM';
  const tipBranchOk = (tip16aj && currentBranch() === 'radar/slice-16aj-g06-slo-error-budget-source')
    || (tip16ak && currentBranch() === 'radar/slice-16ak-g06-backpressure-source')
    || (tip16al && currentBranch() === 'radar/slice-16al-g06-backpressure-wire')
    || (tip16am && currentBranch() === 'radar/slice-16am-g06-backpressure-deploy-evidence');
  const tipBasisOk = (tip16aj
    && matrix.master_basis === '0994989a3d5d14daa98797fac55083b0c2ea809c'
    && topContract.master_basis === '0994989a3d5d14daa98797fac55083b0c2ea809c')
    || (tip16ak
    && matrix.master_basis === '9fa3626326c0e2bc21f2d37905967d6ff47b7520'
    && topContract.master_basis === '9fa3626326c0e2bc21f2d37905967d6ff47b7520')
    || (tip16al
    && matrix.master_basis === '502d762f897432c67bb8b17a8a49bfab01a0787d'
    && topContract.master_basis === '502d762f897432c67bb8b17a8a49bfab01a0787d')
    || (tip16am
    && matrix.master_basis === '905ff9ff57a75d0b3defc15a16078b47e94e930f'
    && topContract.master_basis === '905ff9ff57a75d0b3defc15a16078b47e94e930f');
  ok('C1 HEAD on 16AI branch (or later tip)',
    currentBranch() === locks.BRANCH || tipBranchOk, currentBranch());
  ok('C2 evidence master_basis locked', evidence.master_basis === locks.MASTER_BASIS);
  ok('C3 slice/outcome/branch locked (16AI lock or later tip)',
    (evidence.slice === locks.SLICE
      && evidence.outcome_id === locks.OUTCOME_ID
      && evidence.branch === locks.BRANCH
      && sliceContract.branch === locks.BRANCH
      && sliceContract.outcome_id === locks.OUTCOME_ID
      && matrix.slice === locks.SLICE
      && matrix.branch === locks.BRANCH
      && topContract.slice === locks.SLICE
      && topContract.branch === locks.BRANCH)
    || (tip16aj
      && tipBasisOk
      && matrix.slice === 'RADAR-16AJ'
      && matrix.branch === 'radar/slice-16aj-g06-slo-error-budget-source'
      && topContract.slice === 'RADAR-16AJ'
      && topContract.branch === 'radar/slice-16aj-g06-slo-error-budget-source'
      && evidence.slice === locks.SLICE
      && evidence.branch === locks.BRANCH
      && sliceContract.slice === locks.SLICE
      && sliceContract.branch === locks.BRANCH)
    || (tip16ak
      && tipBasisOk
      && matrix.slice === 'RADAR-16AK'
      && matrix.branch === 'radar/slice-16ak-g06-backpressure-source'
      && topContract.slice === 'RADAR-16AK'
      && topContract.branch === 'radar/slice-16ak-g06-backpressure-source'
      && evidence.slice === locks.SLICE
      && evidence.branch === locks.BRANCH
      && sliceContract.slice === locks.SLICE
      && sliceContract.branch === locks.BRANCH)
    || (tip16al
      && tipBasisOk
      && matrix.slice === 'RADAR-16AL'
      && matrix.branch === 'radar/slice-16al-g06-backpressure-wire'
      && topContract.slice === 'RADAR-16AL'
      && topContract.branch === 'radar/slice-16al-g06-backpressure-wire'
      && evidence.slice === locks.SLICE
      && evidence.branch === locks.BRANCH
      && sliceContract.slice === locks.SLICE
      && sliceContract.branch === locks.BRANCH)
    || (tip16am
      && tipBasisOk
      && matrix.slice === 'RADAR-16AM'
      && matrix.branch === 'radar/slice-16am-g06-backpressure-deploy-evidence'
      && topContract.slice === 'RADAR-16AM'
      && topContract.branch === 'radar/slice-16am-g06-backpressure-deploy-evidence'
      && evidence.slice === locks.SLICE
      && evidence.branch === locks.BRANCH
      && sliceContract.slice === locks.SLICE
      && sliceContract.branch === locks.BRANCH));

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

  green('transport_hygiene_dns_pinned_active_zero',
    hygieneOk(drillRoot(evidence).wolfhouse)
    && hygieneOk(drillRoot(evidence).sunset)
    && drillRoot(evidence).wolfhouse.peak_in_flight === 2
    && drillRoot(evidence).sunset.peak_in_flight === 2);

  {
    const c = validateCostFacts(evidence);
    green('sunset_cost_identical_before_after', c.ok, c.errors.join(' | '));
  }

  {
    const h = validateRawArtifactHashes(evidence);
    green('raw_artifacts_sha256_match', h.ok, h.errors.join(' | '));
  }

  {
    const m = validateEvidenceMatchesRaw(evidence);
    green('evidence_values_match_raw_artifacts', m.ok, m.errors.join(' | '));
  }

  {
    const passRule = String(sliceContract.final_controlled_drill.pass_rule || '');
    const passRuleWithoutOmittedNegations = passRule
      .replace(/Does not claim pre\/post \/readyz readiness \(absent from raw drill\)/gi, '')
      .replace(/or after-query 429\/retry \(no durable transcript\)/gi, '');
    green('final_controlled_drill_live_proven_conservative_only',
      sliceContract.final_controlled_drill.id === locks.PROFILE_ID
      && sliceContract.final_controlled_drill.status === 'live_proven'
      && matrix.slice_16ai_selection.final_controlled_drill.status === 'live_proven'
      && /conservative/i.test(passRule)
      && /not soak|soak.*open|soak \(not claimed\)/i.test(
        `${passRule}\n${(sliceContract.still_open || []).join('\n')}`,
      )
      && !/\bload\s+soak\s+proven\b/i.test(passRule)
      && /Does not claim pre\/post \/readyz readiness/i.test(passRule)
      && /Does not claim[\s\S]*429\/retry/i.test(passRule)
      && !/pre\/post \/readyz ready/i.test(passRuleWithoutOmittedNegations)
      && !/\b429\b/.test(passRuleWithoutOmittedNegations));
  }

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

  function scrubNegatedFullG06(text) {
    return String(text || '')
      .replace(/does\s+\*\*not\*\*\s+claim[^\n]*full G06/gi, 'NEGATED')
      .replace(/\*\*Does not\*\*[^\n]*full G06/gi, 'NEGATED')
      .replace(/does not claim[^\n]*full G06/gi, 'NEGATED')
      .replace(/claiming backpressure live\/proven\/full G06/gi, 'NEGATED');
  }

  ok('C9 doc mentions 16AI conservative live_proven without soak/G06 proven',
    /16AI/i.test(doc)
    && /live_proven/i.test(doc)
    && /conservative/i.test(doc)
    && /G06.*partial|partial.*G06/i.test(doc)
    && /soak/i.test(doc)
    && !/\bG06\s+proven\b/i.test(doc)
    && !/\bload\s+soak\s+proven\b/i.test(doc)
    && !/\bfull\s+G06\b/i.test(scrubNegatedFullG06(doc)));

  ok('C10 findings mention 16AI without overclaim',
    /16AI/i.test(findings)
    && /live_proven/i.test(findings)
    && /G06/.test(findings)
    && !/\bG06\s+proven\b/i.test(findings)
    && !/\bload\s+soak\s+proven\b/i.test(findings)
    && !/\bfull\s+G06\b/i.test(scrubNegatedFullG06(findings)));

  ok('C11 runtime paths unchanged vs master', runtimePathsUnchanged().ok, runtimePathsUnchanged().detail);

  ok('C12 progress_class evidence-only',
    locks.PROGRESS_CLASS === 'partial_live_proven_evidence_only'
    && evidence.progress_class === 'partial_live_proven_evidence_only'
    && sliceContract.progress_class === 'partial_live_proven_evidence_only'
    && matrix.slice_16ai_selection.progress_class === 'partial_live_proven_evidence_only');

  {
    const o = omittedClaimsAbsent(evidence, sliceContract, matrix, doc, findings);
    ok('C16 omitted pre/post and 429 claims stay absent', o.ok, o.errors.join(' | '));
  }

  ok('C17 raw fixtures exist and are not tmp paths',
    fs.existsSync(path.join(ROOT, locks.RAW_DRILL_REL))
    && fs.existsSync(path.join(ROOT, locks.RAW_COST_BEFORE_REL))
    && fs.existsSync(path.join(ROOT, locks.RAW_COST_AFTER_REL))
    && !locks.RAW_DRILL_REL.startsWith('tmp/')
    && !locks.RAW_COST_BEFORE_REL.startsWith('/tmp/')
    && deepEqual(
      evidence.durable_raw_artifact_provenance.excluded_ephemeral_paths,
      [...locks.EXCLUDED_EPHEMERAL_PATHS],
    ));

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
    bad.durable_raw_artifact_provenance.artifacts[0].sha256 = '0'.repeat(64);
    bad.observed_facts.controlled_dual_staging_readyz_bounded_load.raw_artifact_sha256 = '0'.repeat(64);
    red('raw_artifact_hash_drift_rejected',
      !validateEvidenceExact(bad).ok || !validateRawArtifactHashes(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.controlled_dual_staging_readyz_bounded_load.pre_post_readyz = {
      wolfhouse: 'ready',
      sunset: 'ready',
    };
    bad.claims_allowed.push('pre_post_readyz_ready');
    bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'pre_post_readyz_ready');
    bad.disposition.proves.push('pre_post_readyz_ready');
    red('omitted_pre_post_readyz_claim_reappears_rejected',
      !validateEvidenceExact(bad).ok || !validateDrillFacts(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.sunset_mtd_actual_cost_guard.after_query_initial_429_then_successful_retry = true;
    bad.observed_facts.sunset_mtd_actual_cost_guard.after_query_initial_status = 429;
    bad.observed_facts.sunset_mtd_actual_cost_guard.after_query_retry_status = 'success';
    bad.claims_allowed.push('after_query_initial_429_then_successful_retry_disclosed');
    bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter(
      (x) => x !== 'after_query_initial_429_then_successful_retry',
    );
    bad.disposition.proves.push('after_query_initial_429_then_successful_retry');
    red('omitted_429_retry_claim_reappears_rejected',
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
