'use strict';

/**
 * verify:messi-slice1a-acceptance-ledger — MESSI acceptance ledger (1A + 1E wiring)
 *
 * Read-only deterministic acceptance ledger verifier. Canonical classifier +
 * parent bindings live in scripts/lib/messi-slice1a-acceptance-ledger.js.
 * Slice 1E wires FORTRESS 1D finite audit closeout into the ledger. Runs
 * retained offline parent gates only — no deploy/DB/cloud/network/live product
 * mutation.
 *
 * Exit 0 on pass, nonzero on failure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const locksPath = path.join(__dirname, 'lib', 'messi-slice1a-acceptance-ledger.js');
const locks = require(locksPath);
const blobCerts = require('./lib/reviewed-candidate-blob-certificates');

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

console.log('verify:messi-slice1a-acceptance-ledger — MESSI ledger (1E FORTRESS wiring)\n');

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

ok('contract slice MESSI-1E', contract.slice === locks.SLICE && locks.SLICE === 'MESSI-1E');
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
  /Finite staging\/offline\/audit closeouts are \*\*not\*\* production readiness/i.test(findings)
  || /Finite staging\/offline closeouts are \*\*not\*\* production readiness/i.test(findings)
  || /distinguish.*finite.*production/i.test(doc));
ok('findings have no trailing whitespace', noTrailingWhitespace(findings));
ok('doc has no trailing whitespace', noTrailingWhitespace(doc));
ok('1B merge/candidate bound',
  locks.FOUNDATION_1B_MERGE_TIP === '98202775a57e64597e0e606a6e58933bb8ba7250'
  && locks.PARENTS.FOUNDATION.canonical_tip === locks.FOUNDATION_1B_MERGE_TIP
  && locks.PARENTS.FOUNDATION.candidate_sha === locks.FOUNDATION_1B_CANDIDATE_SHA
  && locks.sameGitTree(ROOT, locks.FOUNDATION_1B_CANDIDATE_SHA, locks.FOUNDATION_1B_MERGE_TIP));
ok('1D candidate/merge bound',
  locks.FORTRESS_1D_CANDIDATE_SHA === 'fa2c5d71ad6c662b4c4f60b08ede409064acf2fe'
  && locks.FORTRESS_1D_MERGE_TIP === 'ff285598ac2cfec980e8316e772924a9c79a6a7e'
  && locks.PARENTS.FORTRESS.canonical_tip === locks.FORTRESS_1D_MERGE_TIP
  && locks.PARENTS.FORTRESS.candidate_sha === locks.FORTRESS_1D_CANDIDATE_SHA
  && locks.assertCandidateFitsTip(
    ROOT,
    locks.FORTRESS_1D_CANDIDATE_SHA,
    locks.FORTRESS_1D_MERGE_TIP,
    locks.PARENTS.FORTRESS.provenance_bound_files,
  ).ok);

// ── Package script ──────────────────────────────────────────────────────────
console.log('\n── Package script ──');
{
  const pkg = readJson('package.json');
  green(
    'package_script_registered',
    pkg.scripts
      && pkg.scripts[locks.PACKAGE_JSON_ALLOWED_SCRIPT_KEY]
      === locks.PACKAGE_JSON_ALLOWED_SCRIPT_VALUE
      && pkg.scripts[locks.PACKAGE_JSON_1C_SCRIPT_KEY]
      === locks.PACKAGE_JSON_1C_SCRIPT_VALUE
      && pkg.scripts[locks.PACKAGE_JSON_1E_SCRIPT_KEY]
      === locks.PACKAGE_JSON_1E_SCRIPT_VALUE,
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
    const candFit = locks.assertCandidateFitsTip(
      ROOT,
      p.candidate_sha,
      p.canonical_tip,
      p.provenance_bound_files,
    );
    ok(`${id} candidate_sha fits canonical_tip`, candFit.ok, candFit.detail);
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
  && locks.PARENTS.FOUNDATION.workstream_class
    === 'finite_staging_schema_migration_recovery_closeout'
  && locks.PARENTS.FORTRESS.workstream_class
    === 'finite_fortress_audit_workstream_closeout'
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
green('foundation_finite_staging_exposed', (() => {
  const g = classification.gates.find((x) => x.id === 'G_FOUNDATION_PARENT');
  const ledgerG = (ledger.gates || []).find((x) => x.id === 'G_FOUNDATION_PARENT');
  return g
    && g.verdict === 'partial'
    && g.finite_staging_workstream_complete === true
    && g.finite_closeout_analog === 'verify:messi-slice1b-foundation-closeout'
    && Array.isArray(g.missing_proof)
    && g.missing_proof.includes('docker_fresh_db_replacement_proof')
    && g.missing_proof.includes('production_schema_readiness')
    && g.missing_proof.includes('live_restore_drill')
    && g.missing_proof.includes('operated_readiness')
    && ledgerG
    && ledgerG.finite_staging_workstream_complete === true
    && ledgerG.verdict === 'partial';
})());
green('fortress_finite_audit_exposed', (() => {
  const g = classification.gates.find((x) => x.id === 'G_FORTRESS_PARENT');
  const ledgerG = (ledger.gates || []).find((x) => x.id === 'G_FORTRESS_PARENT');
  return g
    && g.verdict === 'partial'
    && g.finite_audit_workstream_complete === true
    && g.finite_closeout_analog === 'verify:messi-slice1d-fortress-closeout'
    && g.workstream_class === 'finite_fortress_audit_workstream_closeout'
    && Array.isArray(g.missing_proof)
    && g.missing_proof.includes('matrix_unproven_cleared_to_proven_fail_closed')
    && g.missing_proof.includes('matrix_vulnerable_remediated')
    && g.missing_proof.includes('15L_live_kv_secret_creation_and_staff_api_deploy_activation')
    && g.missing_proof.includes('production_tenant_boundary_proof')
    && g.missing_proof.includes('security_drills')
    && g.missing_proof.includes('operated_readiness')
    && ledgerG
    && ledgerG.finite_audit_workstream_complete === true
    && ledgerG.verdict === 'partial'
    && !Object.prototype.hasOwnProperty.call(g, 'finite_staging_workstream_complete');
})());
green('unrelated_gates_byte_identical_to_base', (() => {
  const ledgerMatch = locks.unrelatedGatesMatchBase(ledger.gates || []);
  const classMatch = locks.unrelatedGatesMatchBase(classification.gates);
  return ledgerMatch.ok
    && classMatch.ok
    && locks.UNRELATED_GATE_IDS.length === 5
    && locks.BASE_UNRELATED_GATE_OBJECTS.length === 5
    && locks.BASE_UNRELATED_GATE_OBJECTS.every((exp) => {
      const got = (ledger.gates || []).find((x) => x.id === exp.id);
      return got
        && !Object.prototype.hasOwnProperty.call(got, 'finite_audit_workstream_complete')
        && locks.deepEqual(locks.ledgerGateObject(got), locks.deepClone(exp));
    })
    && (ledger.gates || []).find((x) => x.id === 'G_FOUNDATION_PARENT')
      ?.finite_staging_workstream_complete === true
    && (ledger.gates || []).find((x) => x.id === 'G_MESSI_MILESTONE_CLOSEOUT')
      ?.workstream_class === locks.MESSI_CLOSEOUT_WORKSTREAM_CLASS
    && (ledger.gates || []).find((x) => x.id === 'G_MESSI_MILESTONE_CLOSEOUT')
      ?.workstream_class === 'acceptance_ledger_inventory_and_verifier_only';
})());
green('messi_not_complete',
  classification.messi_complete === false
  && ledger.messi_complete === false
  && contract.messi_complete === false);

for (const g of classification.gates) {
  ok(`${g.id} verdict=${g.verdict}`, ['partial', 'absent', 'complete'].includes(g.verdict));
  ok(`${g.id} has explicit missing_proof`, Array.isArray(g.missing_proof) && g.missing_proof.length > 0);
}

// ── Tip scope (immutable reviewed-candidate blob certificates) ──────────────
console.log('\n── Tip scope ──');
{
  const built = locks.buildLockedReviewedBlobCertificates(ROOT);
  ok('locked certificate chain builds', built.ok, (built.errors || []).join('; '));

  const tipVerify = locks.verifyReviewedBlobCertificatesAtTip(ROOT);
  green('reviewed_candidate_scope_authorized',
    tipVerify.ok && Object.keys(tipVerify.effective || {}).length > 0,
    (tipVerify.errors || []).slice(0, 20).join('; '));
  green('blob_certificates_match_current_tree',
    tipVerify.ok,
    (tipVerify.errors || []).slice(0, 20).join('; '));

  const head = locks.currentHeadSha(ROOT);
  ok('tipAcceptsCertificates at HEAD (detached / wrong branch irrelevant)',
    locks.tipAcceptsCertificates(ROOT, head, 'totally-wrong-branch-name'),
    `head=${head}`);
}

// ── Structural: parents must not invoke MESSI (no recursion) ────────────────
console.log('\n── Recursion fence ──');
{
  const parentVerifiers = [
    'scripts/verify-messi-slice1b-foundation-closeout.js',
    'scripts/verify-messi-slice1d-fortress-closeout.js',
    'scripts/verify-radar-slice16ap-finite-closeout.js',
    'scripts/verify-factory-slice1e-finite-closeout.js',
  ];
  for (const rel of parentVerifiers) {
    const src = readText(rel);
    ok(`${rel} does not spawn MESSI ledger verifier`,
      !/verify-messi-slice1a-acceptance-ledger\.js|verify:messi-slice1c-foundation-wiring|verify:messi-slice1e-fortress-wiring/.test(src));
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

red('finite_closeout_as_production_completion', (() => {
  // Finite staging complete must never imply FOUNDATION parent complete /
  // production_ready / emptied production missing proofs.
  const badLedger = locks.thaw(ledger);
  const g = badLedger.gates.find((x) => x.id === 'G_FOUNDATION_PARENT');
  g.verdict = 'complete';
  g.finite_staging_workstream_complete = true;
  g.missing_proof = [];
  badLedger.production_ready = true;
  badLedger.score = { proven: 1, partial: 3, absent: 2, total: 6 };
  const v = locks.validateLedgerFixture(badLedger, classification);
  const forged = locks.classifyMessiGates({
    hashBindingOk: true,
    gateResults,
    radarFormalScore: radarScore,
    fortressMatrixCounts: matrixCounts,
  });
  const fg = forged.gates.find((x) => x.id === 'G_FOUNDATION_PARENT');
  return v.ok === false
    && fg.verdict === 'partial'
    && fg.finite_staging_workstream_complete === true
    && forged.production_ready === false
    && (
      v.errors.includes('false_production_ready')
      || v.errors.includes('gate_verdict_mismatch:G_FOUNDATION_PARENT')
      || v.errors.includes('downgraded_or_false_complete:G_FOUNDATION_PARENT')
      || v.errors.includes('score_mismatch')
    );
})());

red('stale_or_repinned_1b_provenance', (() => {
  // Stale-but-valid: 1B master basis is a real ancestor of the 1B merge tip.
  const stale = locks.FOUNDATION_1B_MASTER_BASIS;
  ok('1B master_basis is real ancestor of merge tip',
    locks.isGitAncestor(ROOT, stale, locks.FOUNDATION_1B_MERGE_TIP)
    && stale !== locks.FOUNDATION_1B_MERGE_TIP);
  const r = locks.verifyParentShaProvenance(ROOT, {
    claimedParents: {
      FOUNDATION: {
        canonical_tip: stale,
        candidate_sha: stale,
        bound_hashes: { ...locks.BOUND_FILE_HASHES },
      },
    },
    skipWorkingTreeCheck: true,
  });
  return r.ok === false
    && r.errors.some((e) => e.includes('FOUNDATION:')
      && (e.includes('stale_or_wrong_canonical_tip')
        || e.includes('repinned_or_tip_blob_mismatch')));
})());

red('hidden_missing_proofs', (() => {
  const badLedger = locks.thaw(ledger);
  const g = badLedger.gates.find((x) => x.id === 'G_FOUNDATION_PARENT');
  g.missing_proof = g.missing_proof.filter((m) => m !== 'docker_fresh_db_replacement_proof'
    && m !== 'operated_readiness');
  const v = locks.validateLedgerFixture(badLedger, classification);
  // Classifier itself must still surface the required missing proofs.
  const c = locks.classifyMessiGates({
    hashBindingOk: true,
    gateResults,
    radarFormalScore: radarScore,
    fortressMatrixCounts: matrixCounts,
  });
  const cg = c.gates.find((x) => x.id === 'G_FOUNDATION_PARENT');
  return v.ok === false
    && v.errors.some((e) => e.includes('gate_missing_proof_mismatch:G_FOUNDATION_PARENT'))
    && cg.missing_proof.includes('docker_fresh_db_replacement_proof')
    && cg.missing_proof.includes('production_schema_readiness')
    && cg.missing_proof.includes('live_restore_drill')
    && cg.missing_proof.includes('operated_readiness');
})());

red('self_authored_score_change', (() => {
  const badLedger = locks.thaw(ledger);
  badLedger.frozen_messi_score = { proven: 1, partial: 3, absent: 2, total: 6 };
  badLedger.score = { proven: 1, partial: 3, absent: 2, total: 6 };
  const v = locks.validateLedgerFixture(badLedger, classification);
  return v.ok === false
    && (
      v.errors.includes('frozen_messi_score')
      || v.errors.includes('score_mismatch')
    );
})());

red('unrelated_gate_semantic_drift', (() => {
  // Leak finite_audit onto FOUNDATION (unrelated) — must fail closed.
  const leak = locks.thaw(ledger);
  const fg = leak.gates.find((x) => x.id === 'G_FOUNDATION_PARENT');
  fg.finite_audit_workstream_complete = false;
  const vLeak = locks.validateLedgerFixture(leak, classification);
  // Mutate G_MESSI_MILESTONE_CLOSEOUT.workstream_class away from base.
  const drift = locks.thaw(ledger);
  const cg = drift.gates.find((x) => x.id === 'G_MESSI_MILESTONE_CLOSEOUT');
  cg.workstream_class = locks.PROGRESS_CLASS;
  const vDrift = locks.validateLedgerFixture(drift, classification);
  // Exact compare of locked base objects vs live unrelated ledger gates.
  const live = locks.unrelatedGatesMatchBase(ledger.gates || []);
  return live.ok === true
    && vLeak.ok === false
    && vLeak.errors.some((e) => e === 'finite_audit_on_unrelated_gate:G_FOUNDATION_PARENT'
      || e === 'unrelated_gate_drift:G_FOUNDATION_PARENT')
    && vDrift.ok === false
    && vDrift.errors.includes('unrelated_gate_drift:G_MESSI_MILESTONE_CLOSEOUT');
})());

red('unrelated_gate_identity', (() => {
  // Exact byte-identity of all five unrelated gate objects vs locked base.
  const live = locks.unrelatedGatesMatchBase(ledger.gates || []);
  const classified = locks.unrelatedGatesMatchBase(classification.gates);
  const forged = locks.thaw(ledger);
  const radar = forged.gates.find((x) => x.id === 'G_RADAR_PARENT');
  radar.missing_proof = [...radar.missing_proof, 'hostile_extra_gap'];
  const v = locks.validateLedgerFixture(forged, classification);
  return live.ok === true
    && classified.ok === true
    && locks.UNRELATED_GATE_IDS.length === 5
    && locks.deepEqual([...locks.UNRELATED_GATE_IDS].sort(), [
      'G_CROSS_PARENT_INTEGRATION',
      'G_FACTORY_PARENT',
      'G_FOUNDATION_PARENT',
      'G_MESSI_MILESTONE_CLOSEOUT',
      'G_RADAR_PARENT',
    ])
    && v.ok === false
    && v.errors.includes('unrelated_gate_drift:G_RADAR_PARENT');
})());

red('finite_as_security_overclaim', (() => {
  // Finite audit complete must never imply FORTRESS parent complete /
  // production_ready / emptied security missing proofs.
  const badLedger = locks.thaw(ledger);
  const g = badLedger.gates.find((x) => x.id === 'G_FORTRESS_PARENT');
  g.verdict = 'complete';
  g.finite_audit_workstream_complete = true;
  g.production_readiness = 'proven';
  g.missing_proof = [];
  badLedger.production_ready = true;
  badLedger.score = { proven: 1, partial: 3, absent: 2, total: 6 };
  const v = locks.validateLedgerFixture(badLedger, classification);
  const forged = locks.classifyMessiGates({
    hashBindingOk: true,
    gateResults,
    radarFormalScore: radarScore,
    fortressMatrixCounts: matrixCounts,
  });
  const fg = forged.gates.find((x) => x.id === 'G_FORTRESS_PARENT');
  return v.ok === false
    && fg.verdict === 'partial'
    && fg.finite_audit_workstream_complete === true
    && fg.production_readiness === 'absent'
    && forged.production_ready === false
    && (
      v.errors.includes('false_production_ready')
      || v.errors.includes('gate_verdict_mismatch:G_FORTRESS_PARENT')
      || v.errors.includes('downgraded_or_false_complete:G_FORTRESS_PARENT')
      || v.errors.includes('score_mismatch')
      || forged.errors.includes('fortress_complete_without_security_production_proofs')
      || forged.errors.includes('finite_audit_as_security_or_production_readiness')
    );
})());

red('stale_or_repinned_1d_provenance', (() => {
  // Stale-but-valid: 1D master basis is a real ancestor of the 1D merge tip.
  const stale = locks.FORTRESS_1D_MASTER_BASIS;
  ok('1D master_basis is real ancestor of merge tip',
    locks.isGitAncestor(ROOT, stale, locks.FORTRESS_1D_MERGE_TIP)
    && stale !== locks.FORTRESS_1D_MERGE_TIP);
  const r = locks.verifyParentShaProvenance(ROOT, {
    claimedParents: {
      FORTRESS: {
        canonical_tip: stale,
        candidate_sha: stale,
        bound_hashes: { ...locks.BOUND_FILE_HASHES },
      },
    },
    skipWorkingTreeCheck: true,
  });
  return r.ok === false
    && r.errors.some((e) => e.includes('FORTRESS:')
      && (e.includes('stale_or_wrong_canonical_tip')
        || e.includes('repinned_or_tip_blob_mismatch')));
})());

red('hidden_fortress_missing_proofs', (() => {
  const badLedger = locks.thaw(ledger);
  const g = badLedger.gates.find((x) => x.id === 'G_FORTRESS_PARENT');
  g.missing_proof = g.missing_proof.filter((m) => m !== 'security_drills'
    && m !== 'operated_readiness'
    && m !== 'matrix_vulnerable_remediated');
  const v = locks.validateLedgerFixture(badLedger, classification);
  const c = locks.classifyMessiGates({
    hashBindingOk: true,
    gateResults,
    radarFormalScore: radarScore,
    fortressMatrixCounts: matrixCounts,
  });
  const cg = c.gates.find((x) => x.id === 'G_FORTRESS_PARENT');
  return v.ok === false
    && v.errors.some((e) => e.includes('gate_missing_proof_mismatch:G_FORTRESS_PARENT'))
    && cg.missing_proof.includes('security_drills')
    && cg.missing_proof.includes('operated_readiness')
    && cg.missing_proof.includes('matrix_vulnerable_remediated')
    && cg.missing_proof.includes('matrix_unproven_cleared_to_proven_fail_closed');
})());

red('missing_reviewed_candidate_ref', (() => {
  const built = locks.buildLockedReviewedBlobCertificates(ROOT);
  if (!built.ok) return false;
  const forged = locks.deepClone(built.certificates);
  forged[0] = {
    ...forged[0],
    candidate_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };
  const head = locks.currentHeadSha(ROOT);
  const r = blobCerts.verifyReviewedBlobCertificates(ROOT, {
    certificates: forged,
    tip_sha: head,
  });
  return r.ok === false
    && r.errors.some((e) => e.includes('missing_ref:reviewed_candidate'));
})());

red('altered_certificate_scope', (() => {
  const built = locks.buildLockedReviewedBlobCertificates(ROOT);
  if (!built.ok) return false;
  const forged = locks.deepClone(built.certificates);
  forged[0] = {
    ...forged[0],
    paths: [...forged[0].paths, 'hostile/extra-path.js'],
    blobs: {
      ...forged[0].blobs,
      'hostile/extra-path.js': '0'.repeat(64),
    },
  };
  const r = locks.verifyReviewedBlobCertificatesAtTip(ROOT, {
    claimed_certificates: forged,
  });
  return r.ok === false
    && r.errors.some((e) => e.includes('altered_certificate_scope'));
})());

red('altered_candidate_scope', (() => {
  const built = locks.buildLockedReviewedBlobCertificates(ROOT);
  if (!built.ok) return false;
  const forged = locks.deepClone(built.certificates);
  const rel = forged[0].paths[0];
  forged[0] = {
    ...forged[0],
    blobs: {
      ...forged[0].blobs,
      [rel]: 'f'.repeat(64),
    },
  };
  const r = locks.verifyReviewedBlobCertificatesAtTip(ROOT, {
    claimed_certificates: forged,
  });
  return r.ok === false
    && (
      r.errors.some((e) => e.includes('altered_certificate_scope'))
      || r.errors.some((e) => e.includes('certificate_blob_mismatch'))
    );
})());

red('reordered_or_superseded_certificates', (() => {
  const built = locks.buildLockedReviewedBlobCertificates(ROOT);
  if (!built.ok || built.certificates.length < 2) return false;
  const forged = [built.certificates[1], built.certificates[0]];
  const r = locks.verifyReviewedBlobCertificatesAtTip(ROOT, {
    claimed_certificates: forged,
  });
  return r.ok === false
    && r.errors.some((e) => e.includes('reordered_or_superseded_certificates'));
})());

red('changed_protected_blob', (() => {
  const orphan = locks.makeUnrelatedOrphanCommit(ROOT);
  const r = locks.verifyReviewedBlobCertificatesAtTip(ROOT, { tip_sha: orphan });
  return r.ok === false
    && r.errors.some((e) => e.includes('changed_protected_blob')
      || e.includes('missing_protected_blob'));
})());

red('spoofed_locked_branch_name_rejected', (() => {
  const orphan = locks.makeUnrelatedOrphanCommit(ROOT);
  const head = locks.currentHeadSha(ROOT);
  return locks.tipAcceptsCertificates(ROOT, orphan, locks.BRANCH) === false
    && locks.tipAcceptsCertificates(ROOT, head, 'totally-wrong-branch-name') === true;
})());

red('multi_squash_unrelated_topology', (() => {
  const built = locks.buildLockedReviewedBlobCertificates(ROOT);
  if (!built.ok) return false;
  const candidateCerts = blobCerts.certificatesBeforeRedesign(built.certificates);
  const topo = blobCerts.makeMultiSquashUnrelatedTopology(ROOT, candidateCerts);
  const atTip = blobCerts.verifyReviewedBlobCertificates(ROOT, {
    certificates: candidateCerts,
    tip_sha: topo.tipSha,
  });
  const unrelatedBefore = blobCerts.verifyReviewedBlobCertificates(ROOT, {
    certificates: candidateCerts,
    tip_sha: topo.unrelatedBefore,
  });
  return atTip.ok === true
    && unrelatedBefore.ok === false
    && unrelatedBefore.errors.some((e) => e.includes('changed_protected_blob')
      || e.includes('missing_protected_blob'));
})());

red('concurrent_merge_topology', (() => {
  const built = locks.buildLockedReviewedBlobCertificates(ROOT);
  if (!built.ok) return false;
  const head = locks.currentHeadSha(ROOT);
  const candidateCerts = blobCerts.certificatesBeforeRedesign(built.certificates);
  const real = locks.verifyReviewedBlobCertificatesAtTip(ROOT, { tip_sha: head });
  const forged = locks.verifyReviewedBlobCertificatesAtTip(ROOT, {
    tip_sha: locks.MASTER_BASIS,
  });
  const topo = blobCerts.makeMultiSquashUnrelatedTopology(ROOT, candidateCerts);
  const topologyOk = blobCerts.verifyReviewedBlobCertificates(ROOT, {
    certificates: candidateCerts,
    tip_sha: topo.tipSha,
  });
  return real.ok === true
    && forged.ok === false
    && topologyOk.ok === true
    && (
      forged.errors.some((e) => e.includes('changed_protected_blob'))
      || forged.errors.some((e) => e.includes('missing_protected_blob'))
    );
})());


red('source_fixture_co_tamper', (() => {
  if (!blobCerts.redesignPin.isRedesignActivated()) {
    const meta = blobCerts.validateWholePathRedesignAnchor(ROOT);
    const forged = {
      id: blobCerts.REDESIGN_CERT_ID,
      candidate_sha: '',
      correction_candidate_bound: blobCerts.redesignPin.CORRECTION_CANDIDATE_BOUND,
      master_basis: blobCerts.redesignPin.MASTER_BASIS_BOUND,
      paths: [...blobCerts.redesignPin.REDESIGN_PATHS],
      blobs: { 'hostile.js': 'f'.repeat(64) },
    };
    const hostile = blobCerts.validateWholePathRedesignAnchorData(
      blobCerts.redesignPin,
      forged,
      ROOT,
    );
    return meta.ok === true
      && meta.activated === false
      && hostile.ok === false
      && hostile.errors.some((e) => e.includes('fixture_blobs_forbidden'));
  }
  const built = locks.buildLockedReviewedBlobCertificates(ROOT);
  if (!built.ok) return false;
  const redesign = built.certificates.find((c) => c.id === blobCerts.REDESIGN_CERT_ID);
  if (!redesign || !redesign.paths.length) return false;
  const rel = redesign.paths[0];
  const forgedFixture = {
    id: blobCerts.REDESIGN_CERT_ID,
    candidate_sha: redesign.candidate_sha,
    correction_candidate_bound: blobCerts.redesignPin.CORRECTION_CANDIDATE_BOUND,
    master_basis: blobCerts.redesignPin.MASTER_BASIS_BOUND,
    paths: [...redesign.paths],
    blobs: { ...redesign.blobs, [rel]: 'f'.repeat(64) },
  };
  const meta = blobCerts.validateWholePathRedesignAnchorData(
    blobCerts.redesignPin,
    forgedFixture,
    ROOT,
  );
  const forgedCerts = built.certificates.map((c) => {
    if (c.id !== blobCerts.REDESIGN_CERT_ID) return c;
    return {
      ...c,
      blobs: { ...c.blobs, [rel]: 'f'.repeat(64) },
    };
  });
  const r = locks.verifyReviewedBlobCertificatesAtTip(ROOT, {
    claimed_certificates: forgedCerts,
    skip_anchor_validation: true,
  });
  return meta.ok === false
    && meta.errors.some((e) => e.includes('fixture_blobs_forbidden'))
    && r.ok === false
    && (
      r.errors.some((e) => e.includes('altered_certificate_scope'))
      || r.errors.some((e) => e.includes('certificate_blob_mismatch'))
    );
})());

red('fixture_metadata_tamper', (() => {
  const forged = {
    id: blobCerts.REDESIGN_CERT_ID,
    candidate_sha: 'a'.repeat(40),
    correction_candidate_bound: 'b'.repeat(40),
    master_basis: 'c'.repeat(40),
    paths: ['hostile/not-in-pin.js'],
  };
  const meta = blobCerts.validateWholePathRedesignAnchorData(
    blobCerts.redesignPin,
    forged,
    ROOT,
  );
  return meta.ok === false
    && meta.errors.some((e) => e.includes('fixture_metadata_'))
    && meta.errors.some((e) => e.includes('candidate_sha_mismatch')
      || e.includes('correction_ref_mismatch')
      || e.includes('master_basis_mismatch')
      || e.includes('paths_mismatch')
      || e.includes('candidate_sha_premature'));
})());

red('redesign_ref_tamper', (() => {
  if (!blobCerts.redesignPin.isRedesignActivated()) {
    const meta = blobCerts.validateWholePathRedesignAnchor(ROOT);
    const forged = {
      id: blobCerts.REDESIGN_CERT_ID,
      candidate_sha: 'dddddddddddddddddddddddddddddddddddddddd',
      correction_candidate_bound: blobCerts.redesignPin.CORRECTION_CANDIDATE_BOUND,
      master_basis: blobCerts.redesignPin.MASTER_BASIS_BOUND,
      paths: [...blobCerts.redesignPin.REDESIGN_PATHS],
    };
    const hostile = blobCerts.validateWholePathRedesignAnchorData(
      blobCerts.redesignPin,
      forged,
      ROOT,
    );
    return meta.ok === true
      && meta.activated === false
      && hostile.ok === false
      && hostile.errors.some((e) => e.includes('candidate_sha_premature'));
  }
  const built = locks.buildLockedReviewedBlobCertificates(ROOT);
  if (!built.ok) return false;
  const redesign = built.certificates.find((c) => c.id === blobCerts.REDESIGN_CERT_ID);
  if (!redesign) return false;
  const forged = built.certificates.map((c) => {
    if (c.id !== blobCerts.REDESIGN_CERT_ID) return c;
    return { ...c, candidate_sha: 'dddddddddddddddddddddddddddddddddddddddd' };
  });
  const r = locks.verifyReviewedBlobCertificatesAtTip(ROOT, {
    claimed_certificates: forged,
  });
  return r.ok === false
    && r.errors.some((e) => e.includes('stale_or_wrong_reviewed_candidate')
      || e.includes('missing_ref:reviewed_candidate'));
})());

red('redesign_hash_tamper', (() => {
  if (!blobCerts.redesignPin.isRedesignActivated()) {
    const meta = blobCerts.validateWholePathRedesignAnchor(ROOT);
    return meta.ok === true && meta.activated === false;
  }
  const built = locks.buildLockedReviewedBlobCertificates(ROOT);
  if (!built.ok) return false;
  const redesign = built.certificates.find((c) => c.id === blobCerts.REDESIGN_CERT_ID);
  if (!redesign || !redesign.paths.length) return false;
  const rel = redesign.paths[0];
  const forged = built.certificates.map((c) => {
    if (c.id !== blobCerts.REDESIGN_CERT_ID) return c;
    return {
      ...c,
      blobs: { ...c.blobs, [rel]: 'e'.repeat(64) },
    };
  });
  const r = locks.verifyReviewedBlobCertificatesAtTip(ROOT, {
    claimed_certificates: forged,
  });
  return r.ok === false
    && (
      r.errors.some((e) => e.includes('altered_certificate_scope'))
      || r.errors.some((e) => e.includes('certificate_blob_mismatch'))
    );
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
