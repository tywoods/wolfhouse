'use strict';

/**
 * verify:foundation-docker-fresh-db-replacement-evidence
 *
 * Offline gate for the compact Lunabox disposable-Docker compared fixture.
 * Binds proof script, harness, canonical migration manifest/checksums, and
 * fixture hashes. Hostile REDs for count/hash/fingerprint/equality/cleanup/
 * candidate drift. Does not reclassify FOUNDATION or MESSI. No live Docker.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  loadManifest,
  validateManifestIntegrity,
  sha256File,
  forwardEntries,
} = require('./lib/migration-integrity');
const { hashCanonicalManifest } = require('./lib/sunset-schema-observer');
const locks = require('./lib/foundation-docker-fresh-db-replacement-evidence');

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

function green(id, cond, detail) {
  greenResults.push({ id, ok: !!cond });
  return ok(`GREEN ${id}`, cond, detail);
}

function red(id, cond, detail) {
  redResults.push({ id, ok: !!cond });
  return ok(`RED   ${id}`, cond, detail);
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function computeEvidenceLockHash(ev) {
  const clone = deepClone(ev);
  delete clone.lock_hash;
  return sha256Text(stableStringify(clone));
}

function cyclesOk(cycles) {
  if (!Array.isArray(cycles) || cycles.length !== 2) return false;
  return cycles.every((c, i) => (
    c
    && c.index === i + 1
    && c.appliedCount === locks.APPLIED_COUNT
    && c.schema_fingerprint === locks.SCHEMA_FINGERPRINT
    && c.schema_migrations_hash === locks.SCHEMA_MIGRATIONS_HASH
    && c.cleanup === true
    && c.cleanup_code === locks.CLEANUP_CODE
  ));
}

function observedFactsOk(ev) {
  return ev
    && ev.ok === true
    && ev.kind === locks.KIND
    && ev.gate === locks.GATE
    && ev.outcome_id === locks.OUTCOME_ID
    && ev.candidate_sha === locks.CANDIDATE_SHA
    && ev.host === 'lunabox'
    && ev.backend === locks.BACKEND
    && ev.postgres_major === locks.POSTGRES_MAJOR
    && ev.phase === locks.PHASE
    && ev.forwardCount === locks.FORWARD_COUNT
    && cyclesOk(ev.cycles)
    && ev.volumes_distinct === true
    && ev.schema_migrations_equal === true
    && ev.schema_fingerprint_equal === true
    && ev.cleanup_ok === true
    && ev.raw_evidence_sha256 === locks.RAW_EVIDENCE_SHA256
    && Array.isArray(ev.does_not_prove)
    && locks.DOES_NOT_PROVE.every((x) => ev.does_not_prove.includes(x));
}

function bindingsOk(ev) {
  const b = ev && ev.bindings;
  return b
    && b.proof_script === locks.PROOF_SCRIPT_REL
    && b.proof_script_sha256 === locks.PROOF_SCRIPT_SHA256
    && b.harness === locks.HARNESS_REL
    && b.harness_sha256 === locks.HARNESS_SHA256
    && b.canonical_manifest === locks.CANONICAL_MANIFEST_REL
    && b.canonical_manifest_file_sha256 === locks.CANONICAL_MANIFEST_FILE_SHA256
    && b.canonical_manifest_hash === locks.CANONICAL_MANIFEST_HASH
    && b.checksum_mode === locks.CHECKSUM_MODE
    && b.forwardCount === locks.FORWARD_COUNT;
}

function validateEvidence(ev) {
  const errors = [];
  if (!observedFactsOk(ev)) errors.push('observed_facts');
  if (!bindingsOk(ev)) errors.push('bindings');
  if (computeEvidenceLockHash(ev) !== String(ev.lock_hash || '')) {
    errors.push('lock_hash');
  }
  if (!ev.classification_unchanged
    || ev.classification_unchanged.foundation_1b_docker_gate !== 'absent'
    || ev.classification_unchanged.messi_ledger_updated !== false) {
    errors.push('classification_unchanged');
  }
  return { ok: errors.length === 0, errors };
}

function mutate(ev, mutator, { recomputeLockHash = false } = {}) {
  const copy = deepClone(ev);
  mutator(copy);
  if (recomputeLockHash) {
    copy.lock_hash = computeEvidenceLockHash(copy);
  }
  return copy;
}

function redRejects(id, evidence, mutator, expectedError, { recomputeLockHash = true } = {}) {
  const result = validateEvidence(mutate(evidence, mutator, { recomputeLockHash }));
  const intendedOnly = result.ok === false
    && result.errors.includes(expectedError)
    && (
      expectedError === 'lock_hash'
        ? result.errors.length === 1
        : !result.errors.includes('lock_hash')
    );
  return red(
    id,
    intendedOnly,
    `expected=${expectedError} errors=${result.errors.join(',') || '(none)'}`,
  );
}

function main() {
  console.log('verify:foundation-docker-fresh-db-replacement-evidence — offline\n');

  const evidenceBytes = fs.readFileSync(path.join(ROOT, locks.EVIDENCE_REL));
  const contractBytes = fs.readFileSync(path.join(ROOT, locks.CONTRACT_REL));
  const evidenceText = evidenceBytes.toString('utf8');
  const evidence = JSON.parse(evidenceText);
  const contract = JSON.parse(contractBytes.toString('utf8'));

  green(
    'evidence_fixture_bytes',
    sha256Bytes(evidenceBytes) === locks.EVIDENCE_SHA256
      && sha256Bytes(contractBytes) === locks.CONTRACT_SHA256
      && contract.evidence_sha256 === locks.EVIDENCE_SHA256,
    `evidence=${sha256Bytes(evidenceBytes)} contract=${sha256Bytes(contractBytes)}`,
  );

  green(
    'evidence_lock_hash',
    evidence.lock_hash === locks.EVIDENCE_LOCK_HASH
      && computeEvidenceLockHash(evidence) === locks.EVIDENCE_LOCK_HASH,
    evidence.lock_hash,
  );

  green('observed_facts', observedFactsOk(evidence));

  const liveProofSha = sha256File(path.join(ROOT, locks.PROOF_SCRIPT_REL));
  green(
    'binding_proof_script',
    liveProofSha === locks.PROOF_SCRIPT_SHA256
      && evidence.bindings.proof_script_sha256 === locks.PROOF_SCRIPT_SHA256,
    liveProofSha,
  );

  const liveHarnessSha = sha256File(path.join(ROOT, locks.HARNESS_REL));
  green(
    'binding_harness',
    liveHarnessSha === locks.HARNESS_SHA256
      && evidence.bindings.harness_sha256 === locks.HARNESS_SHA256,
    liveHarnessSha,
  );

  const manifest = loadManifest();
  const integrity = validateManifestIntegrity(manifest);
  const liveManifestFileSha = sha256File(path.join(ROOT, locks.CANONICAL_MANIFEST_REL));
  const liveManifestHash = hashCanonicalManifest(manifest).manifestHash;
  const liveForward = forwardEntries(manifest);
  green(
    'binding_canonical_manifest',
    integrity.ok === true
      && liveManifestFileSha === locks.CANONICAL_MANIFEST_FILE_SHA256
      && liveManifestHash === locks.CANONICAL_MANIFEST_HASH
      && liveForward.length === locks.FORWARD_COUNT
      && manifest.checksumMode === locks.CHECKSUM_MODE
      && evidence.bindings.canonical_manifest_hash === locks.CANONICAL_MANIFEST_HASH
      && evidence.bindings.canonical_manifest_file_sha256
        === locks.CANONICAL_MANIFEST_FILE_SHA256,
    `file=${liveManifestFileSha} hash=${liveManifestHash} n=${liveForward.length}`,
  );

  const foundationCloseout = readJson('fixtures/foundation-closeout/finite-closeout.json');
  const dockerGate = (foundationCloseout.gates || [])
    .find((g) => g.id === 'G_DOCKER_FRESH_DB_REPLACEMENT');
  green(
    'classification_unchanged',
    evidence.classification_unchanged
      && evidence.classification_unchanged.foundation_1b_docker_gate === 'absent'
      && evidence.classification_unchanged.messi_ledger_updated === false
      && dockerGate
      && dockerGate.verdict === 'absent'
      && contract.classification_changed === false
      && contract.certificate_architecture === false,
    `1B docker gate=${dockerGate && dockerGate.verdict}`,
  );

  const proveSrc = readText(locks.PROOF_SCRIPT_REL);
  green(
    'offline_only',
    contract.live_mutation === false
      && contract.live_rerun_required === false
      && contract.certificate_architecture === false
      && /Never connects to Sunset staging/.test(proveSrc)
      && /Does not write committed evidence or edit MESSI\/FOUNDATION ledgers/.test(proveSrc)
      && validateEvidence(evidence).ok === true,
  );

  // --- Hostile REDs ---
  // Targeted semantic mutations recompute lock_hash so each RED fails only on
  // its intended guard. lock_hash_drift alone keeps a stale lock_hash.
  redRejects(
    'forward_count_drift',
    evidence,
    (e) => { e.forwardCount = 40; },
    'observed_facts',
  );
  redRejects(
    'applied_count_drift',
    evidence,
    (e) => { e.cycles[0].appliedCount = 40; },
    'observed_facts',
  );
  redRejects(
    'schema_migrations_hash_drift',
    evidence,
    (e) => {
      e.cycles[0].schema_migrations_hash = '0'.repeat(64);
      e.cycles[1].schema_migrations_hash = '0'.repeat(64);
    },
    'observed_facts',
  );
  redRejects(
    'schema_fingerprint_drift',
    evidence,
    (e) => {
      e.cycles[0].schema_fingerprint = '1'.repeat(64);
      e.cycles[1].schema_fingerprint = '1'.repeat(64);
    },
    'observed_facts',
  );
  redRejects(
    'raw_evidence_hash_drift',
    evidence,
    (e) => {
      e.raw_evidence_sha256 = '2'.repeat(64);
    },
    'observed_facts',
  );
  redRejects(
    'equality_flag_drift',
    evidence,
    (e) => {
      e.volumes_distinct = false;
      e.schema_migrations_equal = false;
      e.schema_fingerprint_equal = false;
    },
    'observed_facts',
  );
  redRejects(
    'cleanup_drift',
    evidence,
    (e) => {
      e.cleanup_ok = false;
      e.cycles[0].cleanup = false;
      e.cycles[0].cleanup_code = 'cleanup_failed';
      e.cycles[1].cleanup = false;
      e.cycles[1].cleanup_code = 'cleanup_failed';
    },
    'observed_facts',
  );
  redRejects(
    'candidate_drift',
    evidence,
    (e) => {
      e.candidate_sha = 'deadbeef'.repeat(5);
    },
    'observed_facts',
  );
  redRejects(
    'proof_script_hash_drift',
    evidence,
    (e) => {
      e.bindings.proof_script_sha256 = 'a'.repeat(64);
    },
    'bindings',
  );
  redRejects(
    'harness_hash_drift',
    evidence,
    (e) => {
      e.bindings.harness_sha256 = 'b'.repeat(64);
    },
    'bindings',
  );
  redRejects(
    'manifest_hash_drift',
    evidence,
    (e) => {
      e.bindings.canonical_manifest_hash = 'c'.repeat(64);
      e.bindings.canonical_manifest_file_sha256 = 'd'.repeat(64);
    },
    'bindings',
  );
  {
    const onlyHash = validateEvidence(mutate(evidence, (e) => {
      e.lock_hash = 'e'.repeat(64);
    }, { recomputeLockHash: false }));
    const staleNoop = validateEvidence(mutate(evidence, (e) => {
      e.forwardCount = 41;
      e.lock_hash = 'f'.repeat(64);
    }, { recomputeLockHash: false }));
    red(
      'lock_hash_drift',
      onlyHash.ok === false
        && onlyHash.errors.length === 1
        && onlyHash.errors[0] === 'lock_hash'
        && staleNoop.ok === false
        && staleNoop.errors.includes('lock_hash'),
      `only=${onlyHash.errors.join(',')} stale=${staleNoop.errors.join(',')}`,
    );
  }

  const missingRed = locks.REQUIRED_RED.filter(
    (id) => !redResults.some((r) => r.id === id && r.ok),
  );
  const missingGreen = locks.REQUIRED_GREEN.filter(
    (id) => !greenResults.some((r) => r.id === id && r.ok),
  );
  ok('required_red_coverage', missingRed.length === 0, missingRed.join(','));
  ok('required_green_coverage', missingGreen.length === 0, missingGreen.join(','));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
