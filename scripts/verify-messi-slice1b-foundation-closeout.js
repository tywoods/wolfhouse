'use strict';

/**
 * verify:messi-slice1b-foundation-closeout — MESSI Slice 1B
 *
 * Deterministic offline FOUNDATION finite-workstream closeout gate.
 * Canonical freeze + validateCloseout live solely in
 * scripts/lib/messi-slice1b-foundation-closeout.js.
 *
 * Exit 0 on pass, nonzero on failure.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const locksPath = path.join(__dirname, 'lib', 'messi-slice1b-foundation-closeout.js');
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
  const neg = /not claimed|does\s*\*+\s*not|does not|never|open|forbidden|explicitly|remain|retained|without|absent|blocked|reject|not updated|untouched|≠|not prove/i;
  const bad = [
    /\bproduction\s+ready\b/i,
    /\bMESSI\s+complete\b/i,
    /\bdocker\s+fresh-?db\s+(replacement\s+)?(complete|proven|done)\b/i,
    /\bzero\s+remaining\s+drift\b/i,
    /\ball\s+gates\s+proven\b/i,
    /\bG_PRODUCTION_SCHEMA_READINESS\s+complete\b/i,
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
  const prefixes = locks.ALLOWED_TIP_PATH_PREFIXES;
  const bad = [];
  for (const p of changedPaths) {
    const okPath = prefixes.some((pref) => (
      pref.endsWith('/') ? p.startsWith(pref) || p === pref.slice(0, -1) : p === pref
    ));
    if (!okPath) bad.push(p);
  }
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
    // Prove 1B itself did not rewrite MESSI ledger semantics: compare the
    // ledger at 1B master basis vs the locked 1B landing tip. Later MESSI
    // slices (1C+) may wire FOUNDATION into the canonical ledger — that is
    // not a 1B regression and must not fail this green when re-run nested.
    const ledgerBase = JSON.parse(execSync(
      `git show ${locks.MASTER_BASIS}:fixtures/messi-acceptance/slice1a-ledger.json`,
      { cwd: ROOT, encoding: 'utf8' },
    ));
    const ledgerAtLanding = JSON.parse(execSync(
      `git show ${locks.LANDING_TIP}:fixtures/messi-acceptance/slice1a-ledger.json`,
      { cwd: ROOT, encoding: 'utf8' },
    ));
    const keys = [
      'slice', 'outcome_id', 'branch', 'master_basis', 'progress_class',
      'messi_complete', 'production_ready', 'frozen_messi_score',
      'radar_formal_score', 'fortress_matrix_counts', 'gate_ids',
    ];
    for (const k of keys) {
      if (!locks.deepEqual(ledgerAtLanding[k], ledgerBase[k])) {
        return { ok: false, detail: `semantic_drift_in_1b_tip:${k}` };
      }
    }
    if (!Array.isArray(ledgerAtLanding.parents) || !Array.isArray(ledgerBase.parents)) {
      return { ok: false, detail: 'parents_missing' };
    }
    if (ledgerAtLanding.parents.length !== ledgerBase.parents.length) {
      return { ok: false, detail: 'parents_length' };
    }
    for (let i = 0; i < ledgerBase.parents.length; i += 1) {
      const a = ledgerBase.parents[i];
      const b = ledgerAtLanding.parents[i];
      for (const k of [
        'id', 'tip_slice', 'outcome_id', 'canonical_tip', 'candidate_sha',
        'workstream_class', 'finite_closeout_analog', 'production_readiness',
        'npm_script', 'missing_proof_for_complete',
      ]) {
        if (!locks.deepEqual(a[k], b[k])) {
          return { ok: false, detail: `parent_semantic_drift_in_1b_tip:${a.id}:${k}` };
        }
      }
    }
    if (!locks.deepEqual(ledgerAtLanding.gates, ledgerBase.gates)) {
      return { ok: false, detail: 'gates_semantic_drift_in_1b_tip' };
    }
    if (!locks.deepEqual(ledgerAtLanding.score, ledgerBase.score)) {
      return { ok: false, detail: 'score_semantic_drift_in_1b_tip' };
    }
    const docDiff = execSync(
      `git diff --name-only ${locks.MASTER_BASIS} ${locks.LANDING_TIP} -- docs/MESSI-ACCEPTANCE-LEDGER.md fixtures/messi-acceptance/slice1a-findings.md fixtures/messi-acceptance/slice1a-contract.json`,
      { cwd: ROOT, encoding: 'utf8' },
    ).trim();
    if (docDiff) {
      return { ok: false, detail: `docs_or_contract_changed_in_1b_tip:${docDiff}` };
    }
    return { ok: true, detail: '(1B tip left MESSI ledger semantics frozen; later wiring allowed)' };
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

console.log('MESSI 1B FOUNDATION finite workstream closeout — offline verifier\n');

ok('C0 locks identity',
  locks.SLICE === 'MESSI-1B'
  && locks.OUTCOME_ID === '1B_foundation_finite_workstream_closeout'
  && locks.BRANCH === 'messi/slice-1b-foundation-closeout'
  && locks.MASTER_BASIS === '6106c27c54e25a8e4ba5ba00178d20be0c3e55f5'
  && locks.FOUNDATION_TIP === '32b44930685450cb27ac519d052332be7b18150d'
  && locks.FOUNDATION_CANDIDATE === locks.FOUNDATION_TIP
  && locks.FROZEN_SCORE.proven === 2
  && locks.FROZEN_SCORE.partial === 0
  && locks.FROZEN_SCORE.absent === 6
  && locks.FROZEN_SCORE.total === 8
  && typeof locks.validateCloseout === 'function'
  && locks.VALIDATOR_EXPORT === 'validateCloseout'
  && locks.MODULE_REL === 'scripts/lib/messi-slice1b-foundation-closeout.js'
  && /require\.cache|code injection/i.test(locks.THREAT_BOUNDARY.summary));

const evidence = readJson(locks.EVIDENCE_REL);
const contract = readJson(locks.CONTRACT_REL);
const doc = readText(locks.DOC_REL);
const findings = readText(locks.FINDINGS_REL);
const pkg = readJson('package.json');

{
  const branch = locks.currentBranch(ROOT);
  const head = locks.currentHeadSha(ROOT);
  ok('C1 HEAD tip accepts 1B (ancestry-only; branch informational)',
    locks.tipAccepts1b(head, branch, ROOT)
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
  && contract.live_mutation === false
  && contract.this_slice_deploys === false);

console.log('\n── GREEN ──');

green('score_frozen_2_0_6',
  locks.deepEqual(evidence.frozen_score, locks.FROZEN_SCORE)
  && locks.deepEqual(contract.frozen_score, locks.FROZEN_SCORE));

green('staging_and_finite_workstream_complete', (() => {
  const byId = Object.fromEntries(evidence.gates.map((g) => [g.id, g]));
  return byId.G_STAGING_SCHEMA_MIGRATION_RECOVERY.verdict === 'complete'
    && byId.G_FOUNDATION_FINITE_WORKSTREAM.verdict === 'complete';
})());

green('unknowns_absent', (() => {
  const absentIds = [
    'G_DOCKER_FRESH_DB_REPLACEMENT',
    'G_PRODUCTION_SCHEMA_READINESS',
    'G_LIVE_RESTORE_DRILL',
    'G_OPERATED_READINESS',
    'G_PRODUCTION_READINESS',
    'G_MESSI_MILESTONE',
  ];
  return absentIds.every((id) => {
    const g = evidence.gates.find((x) => x.id === id);
    return g && g.verdict === 'absent' && g.missing_proof.length > 0;
  });
})());

{
  const prov = locks.verifyFoundationTipProvenance(ROOT);
  green('foundation_tip_provenance_enforced', prov.ok, prov.errors.join('; '));
}

let gateResult = null;
{
  console.log('\n── Retained FOUNDATION gate ──');
  gateResult = locks.runRetainedFoundationGate(ROOT);
  green('retained_14ae_gate_executed',
    gateResult.ok && gateResult.status === 0,
    `status=${gateResult.status} elapsed_ms=${gateResult.elapsed_ms} ${gateResult.stderr_tail || ''}`);
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
  && allNestedFrozen(locks.FOUNDATION_TIP_BOUND_HASHES)
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
  const classification = locks.classifyFoundationCloseout({
    hashBindingOk: true,
    provenanceOk: true,
    retainedGateOk: !!(gateResult && gateResult.ok),
  });
  ok('C5 classifier matches frozen score',
    classification.ok
    && locks.deepEqual(classification.score, locks.FROZEN_SCORE)
    && classification.finite_workstream_closed === true
    && classification.production_ready === false
    && classification.messi_complete === false,
    classification.errors.join('; '));
}

// Tip scope vs master basis
console.log('\n── Tip scope ──');
{
  let changed = [];
  try {
    const out = execSync(`git diff --name-only ${locks.MASTER_BASIS}`, {
      cwd: ROOT,
      encoding: 'utf8',
    });
    changed = out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    ok('git diff vs master basis', false, String(err.message));
  }
  const untracked = execSync('git ls-files --others --exclude-standard', {
    cwd: ROOT,
    encoding: 'utf8',
  }).split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((p) => !p.startsWith('tmp/'));
  const all = [...new Set(changed.concat(untracked))];
  const scope = tipPathsAllowed(all);
  ok('tip paths only 1B closeout artifacts (+1A allowlist forward-compat + package.json)',
    scope.ok, scope.bad.slice(0, 20).join(', '));
}

// Diff check
console.log('\n── Diff check ──');
{
  const r = require('child_process').spawnSync(
    'git',
    ['diff', '--check', `${locks.MASTER_BASIS}...HEAD`],
    { cwd: ROOT, encoding: 'utf8' },
  );
  // Also check working tree / index for unstaged
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

// ── Hostile REDs ────────────────────────────────────────────────────────────
console.log('\n── Hostile REDs ──');

red('stale_but_valid_ancestor_tip', (() => {
  // Real valid ancestor of FOUNDATION tip (its master_basis), not a nonexistent hash.
  const stale = locks.FOUNDATION_MASTER_BASIS;
  const tip = locks.FOUNDATION_TIP;
  ok('stale_master_basis fixture is real ancestor',
    locks.isGitAncestor(ROOT, stale, tip) && stale !== tip);
  const r = locks.verifyFoundationTipProvenance(ROOT, {
    canonical_tip: stale,
    skipWorkingTreeCheck: true,
  });
  return r.ok === false
    && r.errors.some((e) => e.includes('stale_or_wrong_canonical_tip'));
})());

red('repinned_current_tree_hashes', (() => {
  // Claim stale tip while keeping current-tree (locked tip) hashes.
  const stale = locks.FOUNDATION_MASTER_BASIS;
  const r = locks.verifyFoundationTipProvenance(ROOT, {
    canonical_tip: stale,
    bound_hashes: { ...locks.FOUNDATION_TIP_BOUND_HASHES },
    skipWorkingTreeCheck: true,
  });
  return r.ok === false
    && r.errors.some((e) => e.includes('repinned_or_tip_blob_mismatch')
      || e.includes('stale_or_wrong_canonical_tip'));
})());

red('self_authored_completion_boolean', (() => {
  const bad = locks.thaw(evidence);
  bad.foundation_complete = true;
  bad.workstream_complete = true;
  bad.lock_hash = locks.computeLockHash(bad);
  const v = locks.validateCloseout(bad);
  return v.ok === false
    && v.errors.some((e) => e.startsWith('self_authored_completion_boolean'));
})());

red('hidden_production_gap_as_complete', (() => {
  const bad = locks.thaw(evidence);
  const g = bad.gates.find((x) => x.id === 'G_PRODUCTION_SCHEMA_READINESS');
  g.verdict = 'complete';
  g.missing_proof = [];
  g.production_only_unknowns = [];
  bad.frozen_score = { proven: 3, partial: 0, absent: 5, total: 8 };
  bad.lock_hash = locks.computeLockHash(bad);
  const v = locks.validateCloseout(bad);
  return v.ok === false
    && (
      v.errors.some((e) => e.includes('hidden_production_gap_as_complete'))
      || v.errors.some((e) => e.includes('gate_verdict_mismatch:G_PRODUCTION_SCHEMA_READINESS'))
      || v.errors.includes('frozen_score')
    );
})());

red('spoofed_locked_branch_name_rejected', (() => {
  const orphan = locks.makeUnrelatedOrphanCommit(ROOT);
  // Spoofed locked branch name must never bypass ancestry.
  const accepted = locks.tipAccepts1b(orphan, locks.BRANCH, ROOT);
  const synth = locks.makeSyntheticDescendantOfMaster(ROOT);
  const synthOk = locks.tipAccepts1b(synth, 'totally-wrong-branch-name', ROOT);
  return accepted === false && synthOk === true;
})());

red('score_inflation_rejected', (() => {
  const bad = locks.thaw(evidence);
  bad.frozen_score = { proven: 8, partial: 0, absent: 0, total: 8 };
  bad.lock_hash = locks.computeLockHash(bad);
  const v = locks.validateCloseout(bad);
  return v.ok === false && v.errors.includes('frozen_score');
})());

red('docker_unknown_flipped_complete', (() => {
  const bad = locks.thaw(evidence);
  const g = bad.gates.find((x) => x.id === 'G_DOCKER_FRESH_DB_REPLACEMENT');
  g.verdict = 'complete';
  g.missing_proof = [];
  bad.lock_hash = locks.computeLockHash(bad);
  const v = locks.validateCloseout(bad);
  return v.ok === false
    && v.errors.some((e) => e.includes('G_DOCKER_FRESH_DB_REPLACEMENT'));
})());

red('production_unknown_flipped_complete', (() => {
  const bad = locks.thaw(evidence);
  const g = bad.gates.find((x) => x.id === 'G_PRODUCTION_READINESS');
  g.verdict = 'complete';
  g.missing_proof = [];
  bad.production_ready = true;
  bad.lock_hash = locks.computeLockHash(bad);
  const v = locks.validateCloseout(bad);
  return v.ok === false
    && (
      v.errors.includes('false_production_ready')
      || v.errors.some((e) => e.includes('G_PRODUCTION_READINESS'))
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

red('missing_foundation_ref', (() => {
  const r = locks.verifyFoundationTipProvenance(ROOT, {
    canonical_tip: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    candidate_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    skipWorkingTreeCheck: true,
  });
  return r.ok === false
    && r.errors.some((e) => e.includes('missing_ref:canonical_tip'));
})());

red('altered_foundation_tip_file', (() => {
  const rel = 'fixtures/sunset-schema-observer/slice14ae-findings.md';
  const good = locks.FOUNDATION_TIP_BOUND_HASHES[rel];
  const r = locks.verifyFoundationTipProvenance(ROOT, {
    workingTreeHashes: {
      [rel]: locks.sha256Text(`${good}-tampered`),
    },
  });
  return r.ok === false
    && r.errors.some((e) => e.includes(`altered_foundation_tip_file:${rel}`));
})());

red('lock_hash_mismatch_rejected', (() => {
  const bad = locks.thaw(evidence);
  bad.lock_hash = '0'.repeat(64);
  const v = locks.validateCloseout(bad);
  return v.ok === false && v.errors.some((e) => e.startsWith('lock_hash_mismatch'));
})());

red('retained_gate_skip_env_rejected', (() => {
  // Classifier must fail closed when retainedGateOk is false even if hashes/provenance ok.
  const c = locks.classifyFoundationCloseout({
    hashBindingOk: true,
    provenanceOk: true,
    retainedGateOk: false,
  });
  return c.ok === false
    && c.errors.includes('retained_gate_failed')
    && c.gates.filter((g) => g.verdict === 'complete').length === 0
    && c.finite_workstream_closed === false;
})());

// Export mutation attempts
{
  const a = tryAssign(locks, 'FROZEN_SCORE', { proven: 99 });
  ok('export mutation attempts fail',
    (a.threw || locks.deepEqual(locks.FROZEN_SCORE, {
      proven: 2, partial: 0, absent: 6, total: 8,
    }))
    && locks.FROZEN_SCORE.proven === 2);
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
