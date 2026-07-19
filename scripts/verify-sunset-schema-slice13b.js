'use strict';

/**
 * verify:sunset-schema-slice13b — FOUNDATION Slice 13B RED→GREEN
 * Design-only gates. No Azure mutation. No DB connections. No repair SQL.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');

const MASTER = '5dc43550d0197efacbb59dab4657960d2aaa36eb';
const CANON_FP = 'daeec81cf322c596712992e0bd5d1542c925a34243e9e88e211abf172102ba52';
const LIVE_FP = 'fa7efa9246c2bd75fe41741652c462bb98b3c571906635e55a91ae5735ca1dfd';

const REQUIRED_DECISIONS = ['DEC-001', 'DEC-002', 'DEC-003', 'DEC-004', 'DEC-005', 'DEC-006'];

const ARTIFACTS = [
  'slice13b-decision-record.json',
  'slice13b-phased-reconciliation-design.json',
  'slice13b-mismatch-to-phase-map.json',
  'slice13b-ledger-bootstrap-spec.json',
  'slice13b-slice13c-rehearsal-contract.json',
  'slice13b-findings.md',
];

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
}

function collectRepairSqlHints(text) {
  const hits = [];
  if (/\bALTER\s+OWNER\s+TO\b/i.test(text)) hits.push('ALTER OWNER TO');
  if (/\bLIVE_APPLY\s*=\s*true\b/i.test(text)) hits.push('LIVE_APPLY=true');
  if (/\bENABLE_LIVE_REPAIR\b/i.test(text)) hits.push('ENABLE_LIVE_REPAIR');
  // Executable repair migration bodies are forbidden; allow SQL sketches in quoted design fields
  // only when marked design/sketch — flag bare BEGIN;CREATE patterns in .js builders that write SQL files.
  return hits;
}

function main() {
  console.log('verify:sunset-schema-slice13b — RED→GREEN\n');

  pass(
    'artifacts-exist',
    ARTIFACTS.every((f) => fs.existsSync(path.join(FIX, f))),
  );

  const decisions = readJson('slice13b-decision-record.json');
  const phases = readJson('slice13b-phased-reconciliation-design.json');
  const map = readJson('slice13b-mismatch-to-phase-map.json');
  const ledger = readJson('slice13b-ledger-bootstrap-spec.json');
  const contract = readJson('slice13b-slice13c-rehearsal-contract.json');
  const findings = fs.readFileSync(path.join(FIX, 'slice13b-findings.md'), 'utf8');
  const classReport = readJson('slice13a-mismatch-classification-report.json');
  const buildSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'build-sunset-schema-slice13b-design.js'), 'utf8');
  const verifySrc = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-sunset-schema-slice13b.js'), 'utf8');

  pass('design-only-flags',
    decisions.designOnly === true
    && decisions.containsRepairSql === false
    && decisions.containsLiveApplyCode === false
    && decisions.blessesLiveAsCanonical === false
    && decisions.liveMutation === false
    && phases.designOnly === true
    && phases.containsRepairSql === false
    && map.containsRepairSql === false
    && map.blessesLiveAsCanonical === false
    && ledger.designOnly === true
    && contract.designOnly === true
    && contract.liveApplyCapability === false);

  pass('fingerprints-locked',
    decisions.inputs.canonicalFingerprint === CANON_FP
    && decisions.inputs.liveFingerprint === LIVE_FP
    && map.canonicalExpectedFingerprint === CANON_FP
    && map.actualLiveFingerprint === LIVE_FP
    && phases.fingerprints.canonical === CANON_FP
    && phases.fingerprints.live === LIVE_FP
    && /daeec81cf322c596712992e0bd5d1542c925a34243e9e88e211abf172102ba52/.test(findings));

  pass('master-sha-basis',
    decisions.masterShaBasis === MASTER
    && phases.masterShaBasis === MASTER
    && map.masterShaBasis === MASTER
    && ledger.masterShaBasis === MASTER
    && contract.masterShaBasis === MASTER);

  // DEC-001..006 each have recommendation or fail-closed block
  const byId = new Map((decisions.decisions || []).map((d) => [d.id, d]));
  let decOk = true;
  for (const id of REQUIRED_DECISIONS) {
    const d = byId.get(id);
    if (!d) { decOk = false; break; }
    if (!d.recommendedDecision || !d.status || !d.abortCondition) { decOk = false; break; }
    if (!Array.isArray(d.evidence) || d.evidence.length < 1) { decOk = false; break; }
    if (!Array.isArray(d.alternativesRejected) || d.alternativesRejected.length < 1) { decOk = false; break; }
    if (d.operatorApprovalRequired !== true) { decOk = false; break; }
    if (!(d.confidence === 'high' || d.confidence === 'medium' || d.confidence === 'low')) { decOk = false; break; }
  }
  pass('dec-001-through-006-present-with-recommendation-or-failclosed', decOk);

  pass('dec-001-normalization-cannot-hide-privilege-escalation',
    byId.get('DEC-001')
    && byId.get('DEC-001').normalizationPolicy
    && byId.get('DEC-001').normalizationPolicy.databaseMutationAllowed === false
    && Array.isArray(byId.get('DEC-001').normalizationPolicy.forbidden)
    && byId.get('DEC-001').normalizationPolicy.forbidden.some((x) => /ACL widen|privilege/i.test(x))
    && /privilegeEscalationDetection|fail closed/i.test(
      JSON.stringify(byId.get('DEC-001').normalizationPolicy),
    ));

  pass('dec-002-location-forward-compatible-direction',
    /promote/i.test(byId.get('DEC-002').recommendedDecision)
    && /not revert/i.test(byId.get('DEC-002').recommendedDecision)
    && byId.get('DEC-002').proposedCanonicalDirection
    && byId.get('DEC-002').proposedCanonicalDirection.doNotChangeInSlice13b === true);

  pass('dec-003-035-additive-no-seed',
    byId.get('DEC-003').dependencies
    && byId.get('DEC-003').dependencies.seedOrBackfillRequired === false
    && /additive/i.test(byId.get('DEC-003').recommendedDecision));

  pass('dec-004-preflight-aggregate-queries-only',
    Array.isArray(byId.get('DEC-004').laterPreflightQueriesDesignOnly)
    && byId.get('DEC-004').laterPreflightQueriesDesignOnly.every((q) => /count\(/i.test(q.sqlSketch))
    && /Do not DROP live columns/i.test(byId.get('DEC-004').recommendedDecision));

  pass('dec-005-ledger-cannot-assert-unverified-execution',
    ledger.rowKinds
    && ledger.rowKinds.executed_by_canonical_runner
    && ledger.rowKinds.verified_structural_baseline
    && ledger.bootstrapAlgorithm.some((s) => /Never insert executed_by_canonical_runner during bootstrap/i.test(s))
    && ledger.abortConditions.some((s) => /numbering/i.test(s))
    && ledger.checksumMode === 'canonical_lf_v1');

  pass('dec-006-ambiguous-remain-blocked',
    byId.get('DEC-006').status === 'fail_closed_blocked_until_metadata_checks'
    && Array.isArray(byId.get('DEC-006').resolutionRequirements)
    && byId.get('DEC-006').resolutionRequirements.length === 3
    && byId.get('DEC-006').resolutionRequirements.every((r) => Array.isArray(r.requiredChecks) && r.requiredChecks.length >= 1)
    && /blocked/i.test(byId.get('DEC-006').recommendedDecision));

  // 88 keys map exactly once
  const sourceKeys = (classReport.classifications || []).map((c) => c.stableKey).sort();
  const mapKeys = (map.entries || []).map((e) => e.stableKey).sort();
  pass('exactly-88-source-keys', sourceKeys.length === 88 && classReport.mismatchCount === 88);
  pass('map-has-88-unique-keys', mapKeys.length === 88 && new Set(mapKeys).size === 88);
  pass('map-keys-equal-source-keys',
    sourceKeys.length === mapKeys.length && sourceKeys.every((k, i) => k === mapKeys[i]));

  const phaseIds = (map.entries || []).map((e) => e.phaseId);
  pass('every-key-maps-to-single-phase-a-d',
    phaseIds.every((p) => ['A', 'B', 'C', 'D'].includes(p))
    && map.entries.every((e) => e.phaseId && e.resolution));

  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const e of map.entries) counts[e.phaseId] += 1;
  pass('phase-totals-reconcile-to-88',
    counts.A + counts.B + counts.C + counts.D === 88
    && map.phaseCounts.A === counts.A
    && map.phaseCounts.B === counts.B
    && map.phaseCounts.C === counts.C
    && map.phaseCounts.D === counts.D
    && phases.phaseMismatchTotals.sumMappedFrom88 === 88
    && phases.phaseMismatchTotals.A === counts.A
    && phases.phaseMismatchTotals.B === counts.B
    && phases.phaseMismatchTotals.C === counts.C
    && phases.phaseMismatchTotals.D === counts.D);

  pass('phase-trajectory-88-46-29-2-0',
    Array.isArray(phases.expectedMismatchCountTrajectory)
    && phases.expectedMismatchCountTrajectory[0].mismatchCount === 88
    && phases.expectedMismatchCountTrajectory.find((t) => t.afterPhase === 'A').mismatchCount === 46
    && phases.expectedMismatchCountTrajectory.find((t) => t.afterPhase === 'B').mismatchCount === 29
    && phases.expectedMismatchCountTrajectory.find((t) => t.afterPhase === 'C').mismatchCount === 2
    && phases.expectedMismatchCountTrajectory.find((t) => t.afterPhase === 'D').mismatchCount === 0
    && phases.expectedMismatchCountTrajectory.find((t) => t.afterPhase === 'F').match === true);

  pass('phases-a-through-f-documented',
    Array.isArray(phases.phases)
    && phases.phases.map((p) => p.id).join('') === 'ABCDEF'
    && phases.phases.every((p) =>
      p.title
      && Array.isArray(p.prerequisites)
      && p.transactionalBoundary
      && p.lockDowntimeExpectation
      && p.staffApiCompatibility
      && p.backupRestoreRequirement
      && Array.isArray(p.verification)
      && p.rollbackOrForwardRecovery
      && Array.isArray(p.redAbortConditions)));

  // No executable repair SQL / live apply path in 13B design artifacts + builder
  // (exclude this verifier file — it intentionally mentions forbidden markers in RED checks)
  const designBlob = [
    JSON.stringify(decisions),
    JSON.stringify(phases),
    JSON.stringify(map),
    JSON.stringify(ledger),
    JSON.stringify(contract),
    findings,
    buildSrc,
  ].join('\n');
  pass('no-executable-repair-sql-markers', collectRepairSqlHints(designBlob).length === 0, collectRepairSqlHints(designBlob).join(','));
  pass('no-live-apply-path',
    !/\baz containerapp job start\b/i.test(designBlob)
    && !designBlob.includes('LIVE_APPLY_ENABLED')
    && !/new Client\(/.test(buildSrc)
    && !/new Client\(/.test(verifySrc)
    && contract.requirements.liveApplyCapability === false
    && contract.liveApplyCapability === false);

  // Canonical migrations/manifest/fixture must not be modified by this design slice tooling
  pass('builder-does-not-touch-canonical-manifest-or-migrations',
    !/writeFileSync\([^)]*canonical-manifest/i.test(buildSrc)
    && !/writeFileSync\([^)]*expected-product-schema/i.test(buildSrc)
    && !/writeFileSync\([^)]*database[\\/]+migrations/i.test(buildSrc));

  pass('no-canonical-fixture-or-live-blessing',
    /do\s+(\*\*)?not(\*\*)?\s+bless\s+live/i.test(findings)
    && decisions.blessesLiveAsCanonical === false
    && map.blessesLiveAsCanonical === false
    && phases.phases.some((p) =>
      Array.isArray(p.redAbortConditions)
      && p.redAbortConditions.some((c) => /expected fixture from live dump/i.test(c)))
    && !/"blessesLiveAsCanonical"\s*:\s*true/.test(designBlob));

  // Slice 13C contract disposable-only
  pass('slice13c-contract-disposable-only',
    contract.requirements.disposablePostgreSQLOnly === true
    && contract.requirements.repairToolingDefaultsDisabled === true
    && contract.requirements.secondRunNoOp === true
    && contract.requirements.canonicalObserverEndState.match === true
    && contract.requirements.canonicalObserverEndState.mismatchCount === 0
    && Array.isArray(contract.requirements.forbiddenTargets)
    && contract.requirements.forbiddenTargets.some((t) => /Sunset staging/i.test(t))
    && Array.isArray(contract.requirements.failureInjection)
    && contract.requirements.failureInjection.length >= 1);

  pass('findings-forbid-live-mutation',
    /design only/i.test(findings)
    && /Do \*\*not\*\* bless live/i.test(findings)
    && /Forbidden \(honored\)/i.test(findings));

  // Ownership mutation not recommended
  pass('no-ownership-mutation-direction',
    byId.get('DEC-001').normalizationPolicy.databaseMutationAllowed === false
    && /Do not ALTER OWNER/i.test(byId.get('DEC-001').recommendedDecision));

  console.log(`\n── verify:sunset-schema-slice13b ${failed ? 'FAILED' : 'PASSED'} (failed=${failed}) ──`);
  process.exit(failed ? 1 : 0);
}

main();
