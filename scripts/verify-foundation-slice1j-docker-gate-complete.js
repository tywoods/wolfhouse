'use strict';

/**
 * verify:foundation-slice1j-docker-gate-complete — FOUNDATION Slice 1J
 *
 * One-gate classification overlay: promote G_DOCKER_FRESH_DB_REPLACEMENT to
 * complete from the reviewed Docker evidence gate. Exactly two hostile REDs.
 * Does not mutate certificate-bound 1B blobs or the MESSI ledger.
 *
 * Exit 0 on pass, nonzero on failure.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const locksPath = path.join(__dirname, 'lib', 'foundation-slice1j-docker-gate-complete.js');
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
  const neg = /not claimed|does\s*\*+\s*not|does not|never|open|forbidden|explicitly|remain|retained|without|absent|blocked|reject|not updated|untouched|≠|not prove|false|partial/i;
  const bad = [
    /\bproduction\s+ready\b/i,
    /\bMESSI\s+complete\b/i,
    /\bG_PRODUCTION_SCHEMA_READINESS\s+complete\b/i,
    /\bG_MESSI_MILESTONE\s+complete\b/i,
    /\bG_PRODUCTION_READINESS\s+complete\b/i,
    /\ball\s+gates\s+proven\b/i,
  ];
  for (const line of lines) {
    if (neg.test(line)) continue;
    for (const re of bad) {
      if (re.test(line)) hits.push(line.trim().slice(0, 120));
    }
  }
  return hits;
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

console.log('FOUNDATION 1J Docker gate complete — offline verifier\n');

ok('C0 locks identity',
  locks.SLICE === 'FOUNDATION-1J'
  && locks.OUTCOME_ID === '1J_docker_fresh_db_replacement_gate_complete'
  && locks.BRANCH === 'foundation/slice-1j-docker-gate-complete'
  && locks.MASTER_BASIS === 'f99c8bdc3106c3995b72aaff22e351337eb71590'
  && locks.FROZEN_SCORE.proven === 3
  && locks.FROZEN_SCORE.partial === 0
  && locks.FROZEN_SCORE.absent === 5
  && locks.FROZEN_SCORE.total === 8
  && locks.REQUIRED_RED.length === 2
  && locks.REQUIRED_RED[0] === 'evidence-gate-skipped'
  && locks.REQUIRED_RED[1] === 'Docker-proof-promoted-to-production-readiness'
  && typeof locks.validateDisposition === 'function'
  && locks.VALIDATOR_EXPORT === 'validateDisposition');

const evidence = readJson(locks.EVIDENCE_REL);
const contract = readJson(locks.CONTRACT_REL);
const doc = readText(locks.DOC_REL);
const findings = readText(locks.FINDINGS_REL);
const pkg = readJson('package.json');

ok('C1 evidence/contract identity locked',
  evidence.slice === locks.SLICE
  && evidence.outcome_id === locks.OUTCOME_ID
  && evidence.branch === locks.BRANCH
  && evidence.master_basis === locks.MASTER_BASIS
  && contract.slice === locks.SLICE
  && contract.outcome_id === locks.OUTCOME_ID
  && contract.branch === locks.BRANCH
  && contract.master_basis === locks.MASTER_BASIS
  && contract.production_validator === 'validateDisposition'
  && contract.messi_ledger_updated === false
  && contract.certificate_architecture === false
  && contract.live_rerun === false);

{
  const v = locks.validateDisposition(evidence);
  ok('C2 production validation path accepts committed disposition',
    v.ok,
    v.errors.join('; '));
}

ok('C3 audit-only + no live mutation/deploy + ledger untouched',
  evidence.audit_only === true
  && evidence.live_mutation === false
  && evidence.this_slice_deploys === false
  && evidence.runtime_behavior_changed === false
  && evidence.messi_ledger_updated === false
  && evidence.certificate_architecture === false
  && evidence.live_rerun === false
  && evidence.production_ready === false
  && evidence.messi_complete === false
  && evidence.parent_production_readiness === 'absent'
  && evidence.parent_verdict === 'partial');

console.log('\n── GREEN ──');

green('score_frozen_3_0_5',
  locks.deepEqual(evidence.frozen_score, locks.FROZEN_SCORE)
  && locks.deepEqual(contract.frozen_score, locks.FROZEN_SCORE));

green('docker_gate_complete', (() => {
  const g = evidence.gates.find((x) => x.id === 'G_DOCKER_FRESH_DB_REPLACEMENT');
  return g
    && g.verdict === 'complete'
    && Array.isArray(g.missing_proof)
    && g.missing_proof.length === 0
    && g.evidence_class === 'lunabox_disposable_docker_compared_evidence';
})());

green('docker_removed_from_missing_proof_only',
  locks.deepEqual(
    evidence.parent_remaining_missing_proof,
    [...locks.PARENT_REMAINING_MISSING_PROOF],
  )
  && !evidence.parent_remaining_missing_proof.includes('docker_fresh_db_replacement_proof')
  && evidence.parent_remaining_missing_proof.includes('production_schema_readiness')
  && evidence.parent_remaining_missing_proof.includes('live_restore_drill')
  && evidence.parent_remaining_missing_proof.includes('operated_readiness'));

green('unknowns_remain_absent', (() => {
  const absentIds = [
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

let evidenceGateResult = null;
{
  console.log('\n── Reviewed Docker evidence gate ──');
  evidenceGateResult = locks.runEvidenceGate(ROOT);
  green('evidence_gate_executed',
    evidenceGateResult.ok && evidenceGateResult.status === 0,
    `status=${evidenceGateResult.status} elapsed_ms=${evidenceGateResult.elapsed_ms}`);
}

{
  const untouched = locks.foundation1bDispositionUntouched(ROOT);
  green('foundation_1b_disposition_untouched',
    untouched.ok,
    (untouched.errors || []).join('; '));
}

{
  const ml = locks.messiLedgerUntouched(ROOT);
  green('messi_ledger_untouched', ml.ok, (ml.errors || []).join('; '));
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
  && allNestedFrozen(locks.REQUIRED_RED)
  && allNestedFrozen(locks.REQUIRED_GREEN));

green('production_ready_false',
  evidence.production_ready === false
  && contract.production_ready === false
  && evidence.gates.find((g) => g.id === 'G_PRODUCTION_READINESS').verdict === 'absent');

{
  const classification = locks.classifyFoundation1j({
    evidenceGateOk: !!(evidenceGateResult && evidenceGateResult.ok),
    foundation1bUntouched: locks.foundation1bDispositionUntouched(ROOT).ok,
  });
  ok('C4 classifier matches frozen score 3/0/5',
    classification.ok
    && locks.deepEqual(classification.score, locks.FROZEN_SCORE)
    && classification.production_ready === false
    && classification.messi_complete === false
    && classification.gates.find((g) => g.id === 'G_DOCKER_FRESH_DB_REPLACEMENT').verdict === 'complete',
    classification.errors.join('; '));
}

// Diff check
console.log('\n── Diff check ──');
{
  const r = spawnSync(
    'git',
    ['diff', '--check', `${locks.MASTER_BASIS}...HEAD`],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const r2 = spawnSync('git', ['diff', '--check'], { cwd: ROOT, encoding: 'utf8' });
  const r3 = spawnSync('git', ['diff', '--cached', '--check'], { cwd: ROOT, encoding: 'utf8' });
  ok('git diff --check clean',
    r.status === 0 && r2.status === 0 && r3.status === 0,
    `${r.stdout || ''}${r.stderr || ''}${r2.stdout || ''}${r3.stdout || ''}`.trim() || '(clean)');
}

// ── Hostile REDs (exactly two) ──────────────────────────────────────────────
console.log('\n── Hostile REDs (exactly two) ──');

red('evidence-gate-skipped', (() => {
  // Classifier must fail closed when evidence gate is skipped/failed.
  const c = locks.classifyFoundation1j({
    evidenceGateOk: false,
    foundation1bUntouched: true,
  });
  const docker = c.gates.find((g) => g.id === 'G_DOCKER_FRESH_DB_REPLACEMENT');
  // Also: disposition that claims docker complete is invalid if we strip proof markers
  // and pretend evidence was skipped — validateDisposition still requires docker complete
  // in the committed fixture shape; the RED is the classifier fail-closed path.
  return c.ok === false
    && c.errors.includes('evidence_gate_failed')
    && docker.verdict === 'absent'
    && docker.missing_proof.includes('evidence_gate_exit_nonzero_or_skipped')
    && c.gates.filter((g) => g.verdict === 'complete').length === 0;
})());

red('Docker-proof-promoted-to-production-readiness', (() => {
  const bad = locks.thaw(evidence);
  bad.production_ready = true;
  const g = bad.gates.find((x) => x.id === 'G_PRODUCTION_READINESS');
  g.verdict = 'complete';
  g.missing_proof = [];
  g.production_only_unknowns = [];
  bad.frozen_score = { proven: 4, partial: 0, absent: 4, total: 8 };
  bad.lock_hash = locks.computeLockHash(bad);
  const v = locks.validateDisposition(bad);
  return v.ok === false
    && (
      v.errors.includes('false_production_ready')
      || v.errors.includes('Docker-proof-promoted-to-production-readiness')
      || v.errors.some((e) => e.includes('G_PRODUCTION_READINESS'))
      || v.errors.includes('frozen_score')
    );
})());

ok('exactly_two_required_reds',
  locks.REQUIRED_RED.length === 2
  && redResults.length === 2
  && locks.REQUIRED_RED.every((id) => redResults.some((r) => r.id === id && r.ok)));

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
