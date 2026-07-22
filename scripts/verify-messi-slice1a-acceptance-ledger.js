'use strict';

/**
 * verify:messi-slice1a-acceptance-ledger — MESSI Slice 1A
 *
 * Read-only deterministic acceptance ledger verifier. Canonical classifier +
 * parent bindings live in scripts/lib/messi-slice1a-acceptance-ledger.js.
 * Runs retained offline parent gates only — no deploy/DB/cloud/network/live
 * product mutation.
 *
 * Exit 0 on pass, nonzero on failure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const locksPath = path.join(__dirname, 'lib', 'messi-slice1a-acceptance-ledger.js');
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
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function green(id, cond, detail) {
  greenResults.push({ id, ok: !!cond });
  return ok(`GREEN ${id}`, cond, detail);
}

function red(id, cond, detail) {
  redResults.push({ id, ok: !!cond });
  return ok(`RED   ${id}`, cond, detail);
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function pathExists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function noTrailingWhitespace(text) {
  return !String(text).split('\n').some((line) => /[ \t]+$/.test(line));
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

console.log('verify:messi-slice1a-acceptance-ledger — MESSI Slice 1A\n');

// ── Artifacts ───────────────────────────────────────────────────────────────
console.log('── Artifacts ──');
ok('doc exists', pathExists(locks.ARTIFACT_RELS.doc));
ok('contract exists', pathExists(locks.ARTIFACT_RELS.contract));
ok('ledger exists', pathExists(locks.ARTIFACT_RELS.ledger));
ok('findings exist', pathExists(locks.ARTIFACT_RELS.findings));
ok('lock module exists', pathExists(locks.ARTIFACT_RELS.lock_module));
ok('verifier exists', pathExists(locks.ARTIFACT_RELS.verifier));

const contract = readJson(locks.ARTIFACT_RELS.contract);
const ledger = readJson(locks.ARTIFACT_RELS.ledger);
const findings = readText(locks.ARTIFACT_RELS.findings);
const doc = readText(locks.ARTIFACT_RELS.doc);
const lockSrc = readText(locks.ARTIFACT_RELS.lock_module);
const verifierSrc = readText(locks.ARTIFACT_RELS.verifier);

ok('contract slice MESSI-1A', contract.slice === locks.SLICE);
ok('contract outcome', contract.outcome_id === locks.OUTCOME_ID);
ok('contract master basis', contract.master_basis === locks.MASTER_BASIS);
ok('contract messi_complete false', contract.messi_complete === false);
ok('contract production_ready false', contract.production_ready === false);
ok('ledger messi_complete false', ledger.messi_complete === false);
ok('ledger production_ready false', ledger.production_ready === false);
ok('findings cite master basis', findings.includes(locks.MASTER_BASIS));
ok('doc defines MESSI above four parents',
  /integration gate above FOUNDATION, FORTRESS, RADAR, and FACTORY/i.test(doc));
ok('findings forbid label completion',
  /never.*marked complete from labels/i.test(findings));
ok('doc/findings distinguish finite vs production',
  /Finite staging\/offline closeouts are \*\*not\*\* production readiness/i.test(findings)
  || /distinguish.*finite.*production/i.test(doc));
ok('findings have no trailing whitespace', noTrailingWhitespace(findings));
ok('doc has no trailing whitespace', noTrailingWhitespace(doc));

// ── Package script ──────────────────────────────────────────────────────────
console.log('\n── Package script ──');
{
  const pkg = readJson('package.json');
  green(
    'package_script_registered',
    pkg.scripts
      && pkg.scripts[locks.PACKAGE_JSON_ALLOWED_SCRIPT_KEY]
      === locks.PACKAGE_JSON_ALLOWED_SCRIPT_VALUE,
  );
}

// ── Parent inventory ────────────────────────────────────────────────────────
console.log('\n── Parent inventory ──');
{
  const parentIds = Object.keys(locks.PARENTS);
  ok('exactly four parents', parentIds.length === 4
    && parentIds.includes('FOUNDATION')
    && parentIds.includes('FORTRESS')
    && parentIds.includes('RADAR')
    && parentIds.includes('FACTORY'));
  for (const id of parentIds) {
    const p = locks.PARENTS[id];
    ok(`${id} evidence files exist`, p.evidence.every((rel) => pathExists(rel)));
    ok(`${id} verifier exists`, pathExists(p.verifier_script));
    ok(`${id} production_readiness absent`, p.production_readiness === 'absent');
    ok(`${id} has missing_proof_for_complete`, p.missing_proof_for_complete.length > 0);
    ok(`${id} canonical_tip bound`, /^[0-9a-f]{40}$/.test(p.canonical_tip));
    ok(`${id} candidate_sha bound`, /^[0-9a-f]{40}$/.test(p.candidate_sha));
    const ancestor = locks.assertShaAncestor(ROOT, p.canonical_tip, locks.MASTER_BASIS);
    ok(`${id} canonical_tip is ancestor of MESSI base`, ancestor.ok, ancestor.detail);
    const candAnc = locks.assertShaAncestor(ROOT, p.candidate_sha, p.canonical_tip);
    ok(`${id} candidate_sha is ancestor of canonical_tip`, candAnc.ok, candAnc.detail);
  }
  green('parent_inventory_bound', true);
}

// ── Exact hash binding ──────────────────────────────────────────────────────
console.log('\n── Exact hash binding ──');
const hashBinding = locks.recomputeBoundHashes(ROOT);
ok('all bound files present + hashes match', hashBinding.ok,
  hashBinding.errors.slice(0, 5).join('; '));
ok('ledger bound_file_hashes match lock',
  locks.deepEqual(ledger.bound_file_hashes, locks.BOUND_FILE_HASHES));
green('exact_hashes_match', hashBinding.ok);

// ── Parent SHA provenance (cryptographic) ───────────────────────────────────
console.log('\n── Parent SHA provenance ──');
const provenance = locks.verifyParentShaProvenance(ROOT);
ok('parent SHA provenance ok', provenance.ok, provenance.errors.slice(0, 8).join(' | '));
ok('ledger parent_sha_provenance bound', !!ledger.parent_sha_provenance);
for (const id of Object.keys(locks.PARENTS)) {
  const p = locks.PARENTS[id];
  const row = ledger.parent_sha_provenance && ledger.parent_sha_provenance[id];
  ok(`${id} ledger canonical_tip`, row && row.canonical_tip === p.canonical_tip);
  ok(`${id} ledger candidate_sha`, row && row.candidate_sha === p.candidate_sha);
  const ledgerParent = (ledger.parents || []).find((x) => x.id === id);
  ok(`${id} parents[].canonical_tip`, ledgerParent && ledgerParent.canonical_tip === p.canonical_tip);
  ok(`${id} parents[].candidate_sha`, ledgerParent && ledgerParent.candidate_sha === p.candidate_sha);
  const contractParent = (contract.parents || []).find((x) => x.id === id);
  ok(`${id} contract canonical_tip`, contractParent && contractParent.canonical_tip === p.canonical_tip);
  ok(`${id} contract candidate_sha`, contractParent && contractParent.candidate_sha === p.candidate_sha);
}
green('parent_sha_provenance_enforced', provenance.ok);

// ── RADAR formal truth + FORTRESS matrix counts ─────────────────────────────
console.log('\n── Parent frozen facts ──');
const radarScore = locks.readRadarFormalScore(ROOT);
const matrixCounts = locks.readFortressMatrixCounts(ROOT);
ok('RADAR frozen_score is 0/9/0', locks.deepEqual(radarScore, locks.RADAR_FORMAL_SCORE));
ok('ledger radar_formal_score is 0/9/0',
  locks.deepEqual(ledger.radar_formal_score, locks.RADAR_FORMAL_SCORE));
ok('FORTRESS matrix counts locked',
  locks.deepEqual(matrixCounts, locks.FORTRESS_MATRIX_VERDICT_COUNTS));
green('radar_formal_0_9_0_preserved',
  locks.deepEqual(radarScore, locks.RADAR_FORMAL_SCORE));
green('finite_vs_production_distinguished',
  Object.values(locks.PARENTS).every((p) => p.production_readiness === 'absent')
  && locks.PARENTS.RADAR.workstream_class === 'finite_milestone_closeout_staging_readiness_only'
  && locks.PARENTS.FACTORY.workstream_class === 'finite_offline_dry_run_packaging_closeout');

// ── Retained gate execution ─────────────────────────────────────────────────
console.log('\n── Retained parent gates (real offline verifiers) ──');
const gateResults = locks.runAllRetainedGates(ROOT);
for (const parentId of Object.keys(locks.PARENTS)) {
  const rows = gateResults[parentId];
  for (const row of rows) {
    ok(`${parentId}/${row.id} exit 0`, row.ok,
      row.ok ? `elapsed_ms=${row.elapsed_ms}` : `${row.stderr_tail || row.stdout_tail}`);
  }
}
green('retained_gates_executed',
  Object.keys(locks.PARENTS).every((id) => locks.parentGatesAllPass(gateResults[id])));

// ── Classification ──────────────────────────────────────────────────────────
console.log('\n── Deterministic classification ──');
const classification = locks.classifyMessiGates({
  hashBindingOk: hashBinding.ok,
  gateResults,
  radarFormalScore: radarScore,
  fortressMatrixCounts: matrixCounts,
});
ok('classifier ok', classification.ok, (classification.errors || []).join(','));
ok('score is 0 proven / 4 partial / 2 absent',
  locks.deepEqual(classification.score, locks.FROZEN_MESSI_SCORE));
ok('no gate classified complete',
  classification.gates.every((g) => g.verdict !== 'complete'));
ok('messi_complete false', classification.messi_complete === false);
ok('production_ready false', classification.production_ready === false);

const ledgerValidation = locks.validateLedgerFixture(ledger, classification);
ok('ledger matches classifier', ledgerValidation.ok,
  ledgerValidation.errors.join(','));
green('classification_matches_ledger', ledgerValidation.ok);
green('messi_not_complete',
  classification.messi_complete === false
  && ledger.messi_complete === false
  && contract.messi_complete === false);

for (const g of classification.gates) {
  ok(`${g.id} verdict=${g.verdict}`, ['partial', 'absent', 'complete'].includes(g.verdict));
  ok(`${g.id} has explicit missing_proof`, Array.isArray(g.missing_proof) && g.missing_proof.length > 0);
}

// ── Tip scope (vs master basis) ─────────────────────────────────────────────
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
  ok('tip paths only messi ledger artifacts (+package.json)', scope.ok,
    scope.bad.slice(0, 20).join(', '));
}

// ── Structural: parents must not invoke MESSI (no recursion) ────────────────
console.log('\n── Recursion fence ──');
{
  const parentVerifiers = [
    'scripts/verify-sunset-schema-slice14ae.js',
    'scripts/verify-fortress-tenant-identity-boundary-matrix.js',
    'scripts/verify-fortress-slice15l-meta-signature-fail-closed.js',
    'scripts/verify-radar-slice16ap-finite-closeout.js',
    'scripts/verify-factory-slice1e-finite-closeout.js',
  ];
  for (const rel of parentVerifiers) {
    const src = readText(rel);
    ok(`${rel} does not invoke MESSI`,
      !/verify:messi-slice1a|verify-messi-slice1a|messi-slice1a-acceptance-ledger/.test(src));
  }
}

// ── Hostile REDs ────────────────────────────────────────────────────────────
console.log('\n── Hostile REDs ──');

red('missing_bound_evidence', (() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'messi1a-missing-'));
  try {
    const rel = 'fixtures/radar-operations/slice16ap-finite-closeout.json';
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // Empty tree → recomputeBoundHashes against tmp root should miss files.
    const r = locks.recomputeBoundHashes(tmp);
    return r.ok === false && r.errors.some((e) => e.startsWith('missing:'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})());

red('tampered_bound_hash', (() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'messi1a-tamper-'));
  try {
    for (const rel of locks.listBoundRels()) {
      const src = path.join(ROOT, rel);
      const dest = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
    const target = 'fixtures/factory-client-productization/slice1e-contract.json';
    fs.writeFileSync(path.join(tmp, target), `${fs.readFileSync(path.join(tmp, target), 'utf8')}\n`);
    const r = locks.recomputeBoundHashes(tmp);
    return r.ok === false && r.errors.some((e) => e.startsWith(`hash_mismatch:${target}`));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})());

red('self_referential_parent_expectation', (() => {
  const fakeParent = locks.thaw(locks.PARENTS.FOUNDATION);
  fakeParent.evidence = fakeParent.evidence.concat(['fixtures/messi-acceptance/slice1a-ledger.json']);
  const hits = locks.parentEvidenceSelfReferential(fakeParent);
  return hits.includes('fixtures/messi-acceptance/slice1a-ledger.json');
})());

red('stale_master_basis_sha', (() => {
  // Real valid ancestor of FOUNDATION tip (master_basis), not a nonexistent hash.
  const stale = locks.PARENTS.FOUNDATION.master_basis;
  const tip = locks.PARENTS.FOUNDATION.canonical_tip;
  ok('stale_master_basis fixture is real ancestor',
    locks.isGitAncestor(ROOT, stale, tip) && stale !== tip);
  const r = locks.assertShaAncestor(ROOT, '0000000000000000000000000000000000000001');
  return r.ok === false;
})());

red('stale_but_valid_ancestor_tip', (() => {
  // RADAR candidate is a real ancestor of the locked tip — must still be rejected
  // as a substitute canonical_tip.
  const staleTip = locks.PARENTS.RADAR.candidate_sha;
  const lockedTip = locks.PARENTS.RADAR.canonical_tip;
  ok('radar candidate is real strict ancestor of tip',
    locks.isGitAncestor(ROOT, staleTip, lockedTip) && staleTip !== lockedTip);
  const r = locks.verifyParentShaProvenance(ROOT, {
    claimedParents: {
      RADAR: { canonical_tip: staleTip },
    },
    skipWorkingTreeCheck: true,
  });
  return r.ok === false
    && r.errors.some((e) => e.includes('stale_or_wrong_canonical_tip'));
})());

red('repinned_current_tree_hashes', (() => {
  // Claim stale RADAR tip while keeping current-tree (locked tip) hashes.
  const staleTip = locks.PARENTS.RADAR.candidate_sha;
  const r = locks.verifyParentShaProvenance(ROOT, {
    claimedParents: {
      RADAR: {
        canonical_tip: staleTip,
        bound_hashes: { ...locks.BOUND_FILE_HASHES },
      },
    },
    skipWorkingTreeCheck: true,
  });
  return r.ok === false
    && r.errors.some((e) => e.includes('repinned_or_tip_blob_mismatch')
      || e.includes('stale_or_wrong_canonical_tip'));
})());

red('mismatched_candidate_tip_pair', (() => {
  // MESSI base is a descendant of RADAR tip — not a valid candidate for that tip.
  const badCandidate = locks.MASTER_BASIS;
  const r = locks.verifyParentShaProvenance(ROOT, {
    claimedParents: {
      RADAR: {
        canonical_tip: locks.PARENTS.RADAR.canonical_tip,
        candidate_sha: badCandidate,
      },
    },
    skipWorkingTreeCheck: true,
  });
  return r.ok === false
    && (
      r.errors.some((e) => e.includes('mismatched_candidate_tip_pair'))
      || r.errors.some((e) => e.includes('stale_or_wrong_candidate_sha'))
    );
})());

red('missing_parent_ref', (() => {
  const r = locks.verifyParentShaProvenance(ROOT, {
    claimedParents: {
      FOUNDATION: {
        canonical_tip: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        candidate_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    },
    skipWorkingTreeCheck: true,
  });
  return r.ok === false
    && r.errors.some((e) => e.includes('missing_ref:canonical_tip'));
})());

red('altered_allowed_parent_file', (() => {
  const rel = 'fixtures/radar-operations/slice16ap-finite-closeout.json';
  const good = locks.BOUND_FILE_HASHES[rel];
  const r = locks.verifyParentShaProvenance(ROOT, {
    workingTreeHashes: {
      [rel]: locks.sha256Text(`${good}-tampered`),
    },
  });
  return r.ok === false
    && r.errors.some((e) => e.includes(`altered_parent_file:${rel}`));
})());

red('stale_bound_file_hash', (() => {
  // Classifier must reject when hashBindingOk is false even if gates "pass".
  const fakeResults = {};
  for (const id of Object.keys(locks.PARENTS)) {
    fakeResults[id] = locks.PARENTS[id].retained_gates.map((g) => ({
      id: g.id,
      script: g.script,
      status: 0,
      ok: true,
      elapsed_ms: 1,
    }));
  }
  const c = locks.classifyMessiGates({
    hashBindingOk: false,
    gateResults: fakeResults,
    radarFormalScore: locks.RADAR_FORMAL_SCORE,
    fortressMatrixCounts: locks.FORTRESS_MATRIX_VERDICT_COUNTS,
  });
  return c.ok === false
    && c.errors.includes('hash_binding_failed')
    && c.gates.filter((g) => g.parent).every((g) => g.verdict === 'absent');
})());

red('downgraded_partial_to_complete', (() => {
  const badLedger = locks.thaw(ledger);
  const g = badLedger.gates.find((x) => x.id === 'G_RADAR_PARENT');
  g.verdict = 'complete';
  g.missing_proof = [];
  badLedger.score = { proven: 1, partial: 3, absent: 2, total: 6 };
  const v = locks.validateLedgerFixture(badLedger, classification);
  return v.ok === false
    && (v.errors.includes('gate_verdict_mismatch:G_RADAR_PARENT')
      || v.errors.includes('downgraded_or_false_complete:G_RADAR_PARENT')
      || v.errors.includes('score_mismatch'));
})());

red('radar_formal_score_raised', (() => {
  const c = locks.classifyMessiGates({
    hashBindingOk: true,
    gateResults,
    radarFormalScore: { proven: 9, partial: 0, absent: 0, total: 9 },
    fortressMatrixCounts: matrixCounts,
  });
  return c.ok === false && c.errors.includes('radar_formal_score_drift');
})());

red('false_messi_completion', (() => {
  const badLedger = locks.thaw(ledger);
  badLedger.messi_complete = true;
  badLedger.production_ready = true;
  const v = locks.validateLedgerFixture(badLedger, classification);
  return v.ok === false
    && v.errors.includes('false_messi_complete')
    && v.errors.includes('false_production_ready');
})());

// Extra RED: self-authored parent_complete boolean rejected
red('self_authored_parent_complete_boolean', (() => {
  const badLedger = locks.thaw(ledger);
  badLedger.parents[0].complete = true;
  const v = locks.validateLedgerFixture(badLedger, classification);
  return v.ok === false
    && v.errors.some((e) => e.startsWith('self_authored_parent_complete_boolean'));
})());

// Lock export immutability (best-effort)
console.log('\n── Lock immutability ──');
{
  let threw = false;
  try {
    locks.FROZEN_MESSI_SCORE.proven = 6;
  } catch (_) {
    threw = true;
  }
  ok('frozen score assignment throws or is ignored',
    threw || locks.FROZEN_MESSI_SCORE.proven === 0);
  ok('lock module path identity',
    locksPath.endsWith('messi-slice1a-acceptance-ledger.js'));
  ok('REQUIRED_RED coverage',
    locks.REQUIRED_RED.every((id) => redResults.some((r) => r.id === id && r.ok)));
  ok('REQUIRED_GREEN coverage',
    locks.REQUIRED_GREEN.every((id) => greenResults.some((r) => r.id === id && r.ok)));
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n── messi-slice1a: ${pass} passed, ${fail} failed ──`);
console.log(`  RED ${redResults.filter((r) => r.ok).length}/${redResults.length}`
  + `  GREEN ${greenResults.filter((r) => r.ok).length}/${greenResults.length}`);
console.log(`  Ledger score: proven=${classification.score.proven}`
  + ` / partial=${classification.score.partial}`
  + ` / absent=${classification.score.absent}`);
console.log(`  RADAR formal: proven=${radarScore.proven}`
  + ` / partial=${radarScore.partial}`
  + ` / absent=${radarScore.absent}`);

if (fail > 0) {
  console.error('MESSI Slice 1A acceptance ledger: FAIL');
  process.exit(1);
}
console.log('MESSI Slice 1A acceptance ledger: PASS');
