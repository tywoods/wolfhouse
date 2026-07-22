'use strict';

/**
 * verify:messi-slice1d-fortress-closeout — MESSI Slice 1D
 *
 * Deterministic offline FORTRESS finite-audit-workstream closeout gate.
 * Canonical freeze + validateCloseout live solely in
 * scripts/lib/messi-slice1d-fortress-closeout.js.
 *
 * Exit 0 on pass, nonzero on failure.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const locksPath = path.join(__dirname, 'lib', 'messi-slice1d-fortress-closeout.js');
const locks = require(locksPath);

const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
const greenResults = [];
const redResults = [];

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

function green(name, cond, detail) {
  greenResults.push({ id: name, ok: !!cond });
  return ok(`GREEN ${name}`, cond, detail);
}

function red(name, cond, detail) {
  redResults.push({ id: name, ok: !!cond });
  return ok(`RED   ${name}`, cond, detail);
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function overclaimHits(text) {
  const hits = [];
  const lines = String(text).split(/\n/);
  const neg = /not claimed|does\s*\*+\s*not|does not|never|open|forbidden|explicitly|remain|retained|without|absent|blocked|reject|not updated|untouched|≠|not prove|must not/i;
  const bad = [
    /\bproduction\s+ready\b/i,
    /\bMESSI\s+complete\b/i,
    /\bFORTRESS\s+(security\s+)?(production\s+)?ready\b/i,
    /\blive\s+(KV|Key Vault|deploy)\s+activation\s+(complete|proven|done)\b/i,
    /\ball\s+gates\s+proven\b/i,
    /\bunproven\s+cleared\b/i,
    /\bvulnerable\s+remediated\b/i,
    /\bG_FORTRESS_SECURITY_PRODUCTION_READINESS\s+complete\b/i,
    /\bG_MESSI_MILESTONE\s+complete\b/i,
  ];
  for (const line of lines) {
    if (neg.test(line)) continue;
    for (const re of bad) {
      if (re.test(line)) hits.push(line.trim().slice(0, 120));
    }
  }
  return hits;
}

function tipPathsAllowed(changedPaths) {
  const bad = locks.unauthorizedTipPaths(changedPaths);
  return { ok: bad.length === 0, bad };
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

function messiLedgerSemanticsUntouched() {
  try {
    // 1D must not rewrite MESSI ledger semantics vs its master basis.
    // Tip-scope hash rebinds on forward-compat allowlist files are checked
    // separately; semantic keys/gates/parents must stay frozen.
    const ledgerBase = JSON.parse(execSync(
      `git show ${locks.MASTER_BASIS}:fixtures/messi-acceptance/slice1a-ledger.json`,
      { cwd: ROOT, encoding: 'utf8' },
    ));
    const ledgerNow = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'fixtures/messi-acceptance/slice1a-ledger.json'), 'utf8'),
    );
    const keys = [
      'slice', 'outcome_id', 'branch', 'master_basis', 'progress_class',
      'messi_complete', 'production_ready', 'frozen_messi_score',
      'radar_formal_score', 'fortress_matrix_counts', 'gate_ids',
    ];
    for (const k of keys) {
      if (!locks.deepEqual(ledgerNow[k], ledgerBase[k])) {
        return { ok: false, detail: `semantic_drift:${k}` };
      }
    }
    if (!Array.isArray(ledgerNow.parents) || !Array.isArray(ledgerBase.parents)) {
      return { ok: false, detail: 'parents_missing' };
    }
    if (ledgerNow.parents.length !== ledgerBase.parents.length) {
      return { ok: false, detail: 'parents_length' };
    }
    for (let i = 0; i < ledgerBase.parents.length; i += 1) {
      const a = ledgerBase.parents[i];
      const b = ledgerNow.parents[i];
      for (const k of [
        'id', 'tip_slice', 'outcome_id', 'canonical_tip', 'candidate_sha',
        'workstream_class', 'finite_closeout_analog', 'production_readiness',
        'npm_script', 'missing_proof_for_complete',
      ]) {
        if (!locks.deepEqual(a[k], b[k])) {
          return { ok: false, detail: `parent_semantic_drift:${a.id}:${k}` };
        }
      }
    }
    if (!locks.deepEqual(ledgerNow.gates, ledgerBase.gates)) {
      return { ok: false, detail: 'gates_semantic_drift' };
    }
    if (!locks.deepEqual(ledgerNow.score, ledgerBase.score)) {
      return { ok: false, detail: 'score_semantic_drift' };
    }
    // Doc / findings / contract must stay byte-identical for this disposition slice.
    for (const rel of [
      'docs/MESSI-ACCEPTANCE-LEDGER.md',
      'fixtures/messi-acceptance/slice1a-findings.md',
      'fixtures/messi-acceptance/slice1a-contract.json',
    ]) {
      const base = execSync(`git show ${locks.MASTER_BASIS}:${rel}`, {
        cwd: ROOT,
        encoding: 'buffer',
        maxBuffer: 32 * 1024 * 1024,
      });
      const now = fs.readFileSync(path.join(ROOT, rel));
      if (Buffer.compare(base, now) !== 0) {
        return { ok: false, detail: `doc_or_contract_changed:${rel}` };
      }
    }
    return { ok: true, detail: '(1D left MESSI ledger semantics frozen; hash rebinds only allowed)' };
  } catch (err) {
    return { ok: false, detail: String(err && err.message) };
  }
}

function everyDescriptorImmutable(obj) {
  const names = Object.getOwnPropertyNames(obj);
  for (const name of names) {
    const d = Object.getOwnPropertyDescriptor(obj, name);
    if (!d || d.writable !== false || d.configurable !== false) return false;
  }
  return names.length > 0;
}

function allNestedFrozen(value, seen) {
  const visited = seen || new WeakSet();
  if (value === null || typeof value !== 'object') return true;
  if (visited.has(value)) return true;
  visited.add(value);
  if (!Object.isFrozen(value)) return false;
  if (Array.isArray(value)) {
    return value.every((item) => allNestedFrozen(item, visited));
  }
  return Object.keys(value).every((k) => allNestedFrozen(value[k], visited));
}

function tryAssign(obj, key, value) {
  try {
    obj[key] = value;
    return { threw: false, current: obj[key] };
  } catch (err) {
    return { threw: true, current: obj[key], error: err };
  }
}

console.log('MESSI 1D FORTRESS finite audit workstream closeout — offline verifier\n');

ok('C0 locks identity',
  locks.SLICE === 'MESSI-1D'
  && locks.OUTCOME_ID === '1D_fortress_finite_audit_workstream_closeout'
  && locks.BRANCH === 'messi/slice-1d-fortress-closeout'
  && locks.MASTER_BASIS === '949be24936c3056b19904904f98feccab5caf883'
  && locks.REVIEWED_CANDIDATE === 'fa2c5d71ad6c662b4c4f60b08ede409064acf2fe'
  && locks.LANDING_TIP === 'ff285598ac2cfec980e8316e772924a9c79a6a7e'
  && locks.FORTRESS_TIP === '28a30a688baa637e1bcb549d9b585cb5917942d1'
  && locks.FORTRESS_CANDIDATE === locks.FORTRESS_TIP
  && locks.FORTRESS_15A_TIP === '8ed81111b9a67a656dee0b7dbd5a46ab91ca125c'
  && locks.FROZEN_SCORE.proven === 3
  && locks.FROZEN_SCORE.partial === 0
  && locks.FROZEN_SCORE.absent === 8
  && locks.FROZEN_SCORE.total === 11
  && locks.FORTRESS_MATRIX_VERDICT_COUNTS.unproven === 3
  && locks.FORTRESS_MATRIX_VERDICT_COUNTS.vulnerable === 4
  && typeof locks.validateCloseout === 'function'
  && typeof locks.verifyReviewedCandidateScope === 'function'
  && typeof locks.verifyMergedProvenance === 'function'
  && locks.VALIDATOR_EXPORT === 'validateCloseout'
  && locks.MODULE_REL === 'scripts/lib/messi-slice1d-fortress-closeout.js'
  && /require\.cache|code injection/i.test(locks.THREAT_BOUNDARY.summary));

const evidence = readJson(locks.EVIDENCE_REL);
const contract = readJson(locks.CONTRACT_REL);
const doc = readText(locks.DOC_REL);
const findings = readText(locks.FINDINGS_REL);
const pkg = readJson('package.json');

{
  const branch = locks.currentBranch(ROOT);
  const head = locks.currentHeadSha(ROOT);
  ok('C1 HEAD tip accepts 1D (ancestry-only; branch informational)',
    locks.tipAccepts1d(head, branch, ROOT)
    && !/===\s*locks\.BRANCH\)\s*return\s*true/.test(fs.readFileSync(__filename, 'utf8'))
    && !/===\s*BRANCH\)\s*return\s*true/.test(fs.readFileSync(locksPath, 'utf8')),
    `branch=${branch} head=${head}`);
}

ok('C2 evidence/contract identity locked',
  evidence.slice === locks.SLICE
  && evidence.outcome_id === locks.OUTCOME_ID
  && evidence.branch === locks.BRANCH
  && evidence.master_basis === locks.MASTER_BASIS
  && contract.slice === locks.SLICE
  && contract.outcome_id === locks.OUTCOME_ID
  && contract.branch === locks.BRANCH
  && contract.master_basis === locks.MASTER_BASIS
  && contract.production_validator === 'validateCloseout'
  && contract.messi_ledger_updated === false);

{
  const v = locks.validateCloseout(evidence);
  ok('C3 production validation path accepts committed evidence',
    v.ok,
    v.errors.join('; '));
}

ok('C4 audit-only + no live mutation/deploy + ledger untouched flag',
  evidence.audit_only === true
  && evidence.live_mutation === false
  && evidence.this_slice_deploys === false
  && evidence.runtime_behavior_changed === false
  && evidence.messi_ledger_updated === false
  && evidence.production_ready === false
  && evidence.messi_complete === false
  && evidence.fortress_security_production_ready === false
  && contract.live_mutation === false
  && contract.this_slice_deploys === false);

console.log('\n── GREEN ──');

green('score_frozen_3_0_8',
  locks.deepEqual(evidence.frozen_score, locks.FROZEN_SCORE)
  && locks.deepEqual(contract.frozen_score, locks.FROZEN_SCORE));

green('audit_source_and_finite_workstream_complete', (() => {
  const byId = Object.fromEntries(evidence.gates.map((g) => [g.id, g]));
  return byId.G_15A_MATRIX_AUDIT.verdict === 'complete'
    && byId.G_15L_SIGNATURE_SOURCE.verdict === 'complete'
    && byId.G_FORTRESS_FINITE_AUDIT_WORKSTREAM.verdict === 'complete';
})());

green('unknowns_absent', (() => {
  const absentIds = [
    'G_MATRIX_UNPROVEN_CLEARED',
    'G_MATRIX_VULNERABLE_REMEDIATED',
    'G_15L_LIVE_KV_DEPLOY_ACTIVATION',
    'G_PRODUCTION_TENANT_BOUNDARY_PROOF',
    'G_SECURITY_DRILLS',
    'G_OPERATED_READINESS',
    'G_FORTRESS_SECURITY_PRODUCTION_READINESS',
    'G_MESSI_MILESTONE',
  ];
  return absentIds.every((id) => {
    const g = evidence.gates.find((x) => x.id === id);
    return g && g.verdict === 'absent' && g.missing_proof.length > 0;
  });
})());

{
  const counts = locks.readMatrixCounts(ROOT);
  green('matrix_counts_locked',
    locks.deepEqual(counts, locks.FORTRESS_MATRIX_VERDICT_COUNTS)
    && locks.deepEqual(evidence.fortress_matrix_counts, locks.FORTRESS_MATRIX_VERDICT_COUNTS),
    JSON.stringify(counts));
}

{
  const prov = locks.verifyFortressTipProvenance(ROOT);
  green('fortress_tip_provenance_enforced', prov.ok, prov.errors.join('; '));
}

let gate15a = null;
let gate15l = null;
{
  console.log('\n── Retained FORTRESS gates ──');
  gate15a = locks.runRetained15AGate(ROOT);
  green('retained_15a_gate_partial',
    gate15a.ok && gate15a.status === 0,
    `status=${gate15a.status} elapsed_ms=${gate15a.elapsed_ms} ${gate15a.stderr_tail || ''}`);
  gate15l = locks.runRetained15LGate(ROOT);
  green('retained_15l_gate_partial',
    gate15l.ok && gate15l.status === 0,
    `status=${gate15l.status} elapsed_ms=${gate15l.elapsed_ms} ${gate15l.stderr_tail || ''}`);
  green('retained_15a_and_15l_gates_executed',
    !!(gate15a && gate15a.ok && gate15l && gate15l.ok));
}

{
  const rt = runtimePathsUnchanged();
  green('runtime_paths_unchanged', rt.ok, rt.detail);
}

{
  const ml = messiLedgerSemanticsUntouched();
  green('messi_ledger_untouched', ml.ok, ml.detail);
}

green('package_script_registered',
  pkg.scripts
  && pkg.scripts[locks.PACKAGE_JSON_ALLOWED_SCRIPT_KEY] === locks.PACKAGE_JSON_ALLOWED_SCRIPT_VALUE);

green('no_doc_overclaim',
  overclaimHits(doc).length === 0 && overclaimHits(findings).length === 0,
  [...overclaimHits(doc), ...overclaimHits(findings)].slice(0, 5).join(' | '));

green('export_object_frozen',
  Object.isFrozen(locks)
  && everyDescriptorImmutable(locks)
  && allNestedFrozen(locks.GATE_EXPECTATIONS)
  && allNestedFrozen(locks.FORTRESS_TIP_BOUND_HASHES)
  && allNestedFrozen(locks.REQUIRED_RED)
  && allNestedFrozen(locks.REQUIRED_GREEN));

{
  const head = locks.currentHeadSha(ROOT);
  green('master_basis_ancestor_of_head',
    locks.isGitAncestor(ROOT, locks.MASTER_BASIS, head)
    || head === locks.resolveCommitSha(ROOT, locks.MASTER_BASIS),
    `head=${head}`);
}

{
  const classification = locks.classifyFortressCloseout({
    hashBindingOk: true,
    provenanceOk: true,
    retained15aOk: !!(gate15a && gate15a.ok),
    retained15lOk: !!(gate15l && gate15l.ok),
    matrixCountsOk: locks.deepEqual(
      locks.readMatrixCounts(ROOT),
      locks.FORTRESS_MATRIX_VERDICT_COUNTS,
    ),
  });
  ok('C5 classifier matches frozen score',
    classification.ok
    && locks.deepEqual(classification.score, locks.FROZEN_SCORE)
    && classification.finite_workstream_closed === true
    && classification.fortress_security_production_ready === false
    && classification.production_ready === false
    && classification.messi_complete === false,
    classification.errors.join('; '));
}

console.log('\n── Tip scope ──');
{
  // Exact reviewed candidate scope — NOT base-to-HEAD (concurrent #147).
  const cand = locks.verifyReviewedCandidateScope(ROOT);
  green('reviewed_candidate_scope_authorized',
    cand.ok && Array.isArray(cand.paths) && cand.paths.length > 0,
    (cand.errors || []).concat(cand.unauthorized || []).slice(0, 20).join('; '));

  const merged = locks.verifyMergedProvenance(ROOT);
  green('merged_provenance_matches_reviewed_candidate',
    merged.ok,
    (merged.errors || []).slice(0, 20).join('; '));

  const post = locks.verifyPostLandingDeltaScope(ROOT);
  ok('post-landing delta only allowlisted 1D paths (break-glass; no pre-merge allowlist)',
    post.ok,
    (post.errors || []).concat(post.unauthorized || []).slice(0, 20).join('; '));

  // Explicit: base-to-landing may include unrelated concurrent files; that must
  // not be treated as 1D tip scope.
  const baseToLanding = locks.listDiffPaths(
    ROOT,
    locks.MASTER_BASIS,
    locks.LANDING_TIP,
  ) || [];
  const concurrentUnrelated = locks.unauthorizedTipPaths(baseToLanding);
  ok('concurrent pre-merge master paths need no 1D file allowlist',
    concurrentUnrelated.length > 0
    && cand.ok
    && tipPathsAllowed(cand.paths).ok,
    `unrelated=${concurrentUnrelated.slice(0, 8).join(',')}`);
}

console.log('\n── Diff check ──');
{
  const r = require('child_process').spawnSync(
    'git',
    ['diff', '--check', `${locks.MASTER_BASIS}...HEAD`],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const r2 = require('child_process').spawnSync(
    'git',
    ['diff', '--check'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const r3 = require('child_process').spawnSync(
    'git',
    ['diff', '--cached', '--check'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  ok('git diff --check clean',
    r.status === 0 && r2.status === 0 && r3.status === 0,
    `${r.stdout || ''}${r.stderr || ''}${r2.stdout || ''}${r3.stdout || ''}`.trim() || '(clean)');
}

console.log('\n── Hostile REDs ──');

red('stale_but_valid_ancestor_tip', (() => {
  const stale = locks.FORTRESS_MASTER_BASIS;
  const tip = locks.FORTRESS_TIP;
  ok('stale_master_basis fixture is real ancestor',
    locks.isGitAncestor(ROOT, stale, tip) && stale !== tip);
  const r = locks.verifyFortressTipProvenance(ROOT, {
    canonical_tip: stale,
    skipWorkingTreeCheck: true,
  });
  return r.ok === false
    && r.errors.some((e) => e.includes('stale_or_wrong_canonical_tip'));
})());

red('repinned_current_tree_hashes', (() => {
  const stale = locks.FORTRESS_MASTER_BASIS;
  const r = locks.verifyFortressTipProvenance(ROOT, {
    canonical_tip: stale,
    bound_hashes: { ...locks.FORTRESS_TIP_BOUND_HASHES },
    skipWorkingTreeCheck: true,
  });
  return r.ok === false
    && r.errors.some((e) => e.includes('repinned_or_tip_blob_mismatch')
      || e.includes('stale_or_wrong_canonical_tip'));
})());

red('self_authored_completion_boolean', (() => {
  const bad = locks.thaw(evidence);
  bad.fortress_complete = true;
  bad.workstream_complete = true;
  bad.lock_hash = locks.computeLockHash(bad);
  const v = locks.validateCloseout(bad);
  return v.ok === false
    && v.errors.some((e) => e.startsWith('self_authored_completion_boolean'));
})());

red('hiding_vulnerable_unproven_controls', (() => {
  const bad = locks.thaw(evidence);
  bad.fortress_matrix_counts = {
    proven_fail_closed: 12,
    proven_isolated_by_runtime: 3,
    unproven: 0,
    vulnerable: 0,
    total: 15,
  };
  bad.matrix_unproven_ids = [];
  bad.matrix_vulnerable_ids = [];
  const gU = bad.gates.find((x) => x.id === 'G_MATRIX_UNPROVEN_CLEARED');
  gU.verdict = 'complete';
  gU.missing_proof = [];
  const gV = bad.gates.find((x) => x.id === 'G_MATRIX_VULNERABLE_REMEDIATED');
  gV.verdict = 'complete';
  gV.missing_proof = [];
  bad.frozen_score = { proven: 5, partial: 0, absent: 6, total: 11 };
  bad.lock_hash = locks.computeLockHash(bad);
  const v = locks.validateCloseout(bad);
  return v.ok === false
    && v.errors.some((e) => e.includes('hiding_vulnerable_unproven_controls')
      || e.includes('G_MATRIX_UNPROVEN_CLEARED')
      || e.includes('G_MATRIX_VULNERABLE_REMEDIATED')
      || e === 'fortress_matrix_counts'
      || e === 'frozen_score');
})());

red('relabeling_source_as_activation', (() => {
  const bad = locks.thaw(evidence);
  const g = bad.gates.find((x) => x.id === 'G_15L_LIVE_KV_DEPLOY_ACTIVATION');
  g.verdict = 'complete';
  g.missing_proof = [];
  g.production_only_unknowns = [];
  bad.source_is_activation = true;
  bad.frozen_score = { proven: 4, partial: 0, absent: 7, total: 11 };
  bad.lock_hash = locks.computeLockHash(bad);
  const v = locks.validateCloseout(bad);
  return v.ok === false
    && v.errors.some((e) => e.includes('relabeling_source_as_activation')
      || e.includes('G_15L_LIVE_KV_DEPLOY_ACTIVATION')
      || e === 'frozen_score');
})());

red('spoofed_locked_branch_name_rejected', (() => {
  const orphan = locks.makeUnrelatedOrphanCommit(ROOT);
  const accepted = locks.tipAccepts1d(orphan, locks.BRANCH, ROOT);
  const synth = locks.makeSyntheticDescendantOfLanding(ROOT);
  const synthOk = locks.tipAccepts1d(synth, 'totally-wrong-branch-name', ROOT);
  return accepted === false && synthOk === true;
})());

red('non_descendant_tip_rejected', (() => {
  // Descendant of MASTER_BASIS only (pre-merge / side tip) — not of LANDING_TIP.
  const masterOnly = locks.makeSyntheticDescendantOfMaster(ROOT);
  const landingOk = locks.tipAccepts1d(
    locks.makeSyntheticDescendantOfLanding(ROOT),
    'wrong-branch',
    ROOT,
  );
  return locks.tipAccepts1d(masterOnly, locks.BRANCH, ROOT) === false
    && landingOk === true;
})());

red('missing_reviewed_candidate_ref', (() => {
  const r = locks.verifyReviewedCandidateScope(ROOT, {
    candidate_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  return r.ok === false
    && r.errors.some((e) => e.includes('missing_ref:reviewed_candidate'));
})());

red('altered_candidate_scope', (() => {
  // Synthetic commit with LANDING_TIP tree parented on MASTER_BASIS — diff
  // includes concurrent #147 crowsnest paths (unauthorized for 1D candidate).
  let synth = '';
  try {
    const tree = execSync(`git rev-parse ${locks.LANDING_TIP}^{tree}`, {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    synth = execSync(
      `git commit-tree ${tree} -p ${locks.MASTER_BASIS} -m "messi1d-altered-candidate-scope-probe"`,
      { cwd: ROOT, encoding: 'utf8' },
    ).trim();
  } catch (_) {
    return false;
  }
  const paths = locks.listDiffPaths(ROOT, locks.MASTER_BASIS, synth) || [];
  const bad = locks.unauthorizedTipPaths(paths);
  const identity = locks.verifyReviewedCandidateScope(ROOT, {
    candidate_sha: synth,
  });
  return bad.length > 0
    && identity.ok === false
    && (
      identity.errors.some((e) => e.startsWith('altered_candidate_scope:'))
      || identity.errors.some((e) => e.startsWith('stale_or_wrong_reviewed_candidate:'))
    );
})());

red('concurrent_merge_topology', (() => {
  // Reproduce #147 between basis 949be249 and squash #148: base..landing has
  // unauthorized paths, but exact reviewed candidate scope stays clean. Forging
  // LANDING_TIP as the reviewed candidate must reject.
  const baseToLanding = locks.listDiffPaths(
    ROOT,
    locks.MASTER_BASIS,
    locks.LANDING_TIP,
  ) || [];
  const unrelated = locks.unauthorizedTipPaths(baseToLanding);
  const forged = locks.verifyReviewedCandidateScope(ROOT, {
    candidate_sha: locks.LANDING_TIP,
  });
  const real = locks.verifyReviewedCandidateScope(ROOT);
  return unrelated.length > 0
    && real.ok === true
    && forged.ok === false
    && (
      forged.errors.some((e) => e.startsWith('stale_or_wrong_reviewed_candidate:'))
      || forged.errors.some((e) => e.startsWith('altered_candidate_scope:'))
    );
})());

red('score_inflation_rejected', (() => {
  const bad = locks.thaw(evidence);
  bad.frozen_score = { proven: 11, partial: 0, absent: 0, total: 11 };
  bad.lock_hash = locks.computeLockHash(bad);
  const v = locks.validateCloseout(bad);
  return v.ok === false && v.errors.includes('frozen_score');
})());

red('fortress_readiness_flipped_complete', (() => {
  const bad = locks.thaw(evidence);
  const g = bad.gates.find((x) => x.id === 'G_FORTRESS_SECURITY_PRODUCTION_READINESS');
  g.verdict = 'complete';
  g.missing_proof = [];
  bad.fortress_security_production_ready = true;
  bad.production_ready = true;
  bad.lock_hash = locks.computeLockHash(bad);
  const v = locks.validateCloseout(bad);
  return v.ok === false
    && (
      v.errors.includes('false_production_ready')
      || v.errors.some((e) => e.includes('self_authored_completion_boolean:fortress_security_production_ready'))
      || v.errors.some((e) => e.includes('G_FORTRESS_SECURITY_PRODUCTION_READINESS'))
    );
})());

red('messi_milestone_flipped_complete', (() => {
  const bad = locks.thaw(evidence);
  const g = bad.gates.find((x) => x.id === 'G_MESSI_MILESTONE');
  g.verdict = 'complete';
  g.missing_proof = [];
  bad.messi_complete = true;
  bad.lock_hash = locks.computeLockHash(bad);
  const v = locks.validateCloseout(bad);
  return v.ok === false
    && (
      v.errors.includes('false_messi_complete')
      || v.errors.some((e) => e.includes('G_MESSI_MILESTONE'))
    );
})());

red('missing_fortress_ref', (() => {
  const r = locks.verifyFortressTipProvenance(ROOT, {
    canonical_tip: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    candidate_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    skipWorkingTreeCheck: true,
  });
  return r.ok === false
    && r.errors.some((e) => e.includes('missing_ref:canonical_tip'));
})());

red('altered_fortress_tip_file', (() => {
  const rel = 'fixtures/fortress-tenant-identity/slice15l-findings.md';
  const good = locks.FORTRESS_TIP_BOUND_HASHES[rel];
  const r = locks.verifyFortressTipProvenance(ROOT, {
    workingTreeHashes: {
      [rel]: locks.sha256Text(`${good}-tampered`),
    },
  });
  return r.ok === false
    && r.errors.some((e) => e.includes(`altered_fortress_tip_file:${rel}`));
})());

red('lock_hash_mismatch_rejected', (() => {
  const bad = locks.thaw(evidence);
  bad.lock_hash = '0'.repeat(64);
  const v = locks.validateCloseout(bad);
  return v.ok === false && v.errors.some((e) => e.startsWith('lock_hash_mismatch'));
})());

red('retained_gate_skip_env_rejected', (() => {
  const c = locks.classifyFortressCloseout({
    hashBindingOk: true,
    provenanceOk: true,
    retained15aOk: true,
    retained15lOk: false,
    matrixCountsOk: true,
  });
  return c.ok === false
    && c.errors.includes('retained_15l_gate_failed')
    && c.gates.filter((g) => g.verdict === 'complete').length === 0
    && c.finite_workstream_closed === false;
})());

{
  const a = tryAssign(locks, 'FROZEN_SCORE', { proven: 99 });
  ok('export mutation attempts fail',
    (a.threw || locks.deepEqual(locks.FROZEN_SCORE, {
      proven: 3, partial: 0, absent: 8, total: 11,
    }))
    && locks.FROZEN_SCORE.proven === 3);
}

for (const id of locks.REQUIRED_RED) {
  ok(`REQUIRED_RED has ${id}`, redResults.some((r) => r.id === id && r.ok));
}
for (const id of locks.REQUIRED_GREEN) {
  ok(`REQUIRED_GREEN has ${id}`, greenResults.some((r) => r.id === id && r.ok));
}

console.log(`\n── Summary: ${pass} passed / ${fail} failed ──`);
if (fail > 0) {
  process.exitCode = 1;
} else {
  console.log('PASS');
}
