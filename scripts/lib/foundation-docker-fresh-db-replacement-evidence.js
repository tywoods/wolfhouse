'use strict';

/**
 * foundation-docker-fresh-db-replacement-evidence — locks for the Lunabox
 * disposable-Docker compared result packaged as a compact offline fixture.
 *
 * Does NOT reclassify FOUNDATION G_DOCKER_FRESH_DB_REPLACEMENT or MESSI.
 * No certificate architecture. Offline verification only (no live Docker rerun).
 */

const CANDIDATE_SHA = '1f89bbfe1c62b150926feabe00ff687001b014ca';
const BRANCH = 'messi/foundation-docker-proof-spike';
const SLICE = 'foundation-docker-proof-evidence';
const GATE = 'G_DOCKER_FRESH_DB_REPLACEMENT';
const KIND = 'foundation-docker-fresh-db-replacement-evidence-v1';
const OUTCOME_ID = 'lunabox_disposable_docker_compared';

const EVIDENCE_REL =
  'fixtures/foundation-docker-proof/lunabox-disposable-compared-evidence.json';
const CONTRACT_REL = 'fixtures/foundation-docker-proof/contract.json';

const PROOF_SCRIPT_REL = 'scripts/prove-foundation-docker-fresh-db-replacement.js';
const HARNESS_REL = 'scripts/lib/disposable-postgres-harness.js';
const CANONICAL_MANIFEST_REL = 'database/migrations/canonical-manifest.json';

const PROOF_SCRIPT_SHA256 =
  '05a1d94d8ab766573dc9f4b59f49b36f926ee14a1590485ca3edf935db65a541';
const HARNESS_SHA256 =
  'f5ca4dd9eb8344cb9e84c72f02da1cf83d0c4db8296b152349d1a1fc5a3537a1';
const CANONICAL_MANIFEST_FILE_SHA256 =
  '23124a699d1f828b03f3307fa6c92c1beaced7a2c32a78e03f9bbb3ca2d37419';
const CANONICAL_MANIFEST_HASH =
  'f76df6f9287eb44499dd8ab1d186ebdfc51c24d6704cdda226b36b9366b134b5';
const CHECKSUM_MODE = 'canonical_lf_v1';

const EVIDENCE_SHA256 =
  '0fed826d959f411c30793adc9df270529678ecb277f3b0849592b4a4d9cc1c66';
const CONTRACT_SHA256 =
  'b0fdf4451ab69763d4cce1239933f91340f645623dfc387ff0d03c53ad533ecf';
const EVIDENCE_LOCK_HASH =
  'e2e87a5613d77710d25476c3c8b224fa57c02e5f5c61e62403edea6a41b9c61d';

const RAW_EVIDENCE_SHA256 =
  '3ca4eecbd0fd9d6ff4186a0bd542d69aff36b4d52f279ec2f3cd61febeb9f13c';
const SCHEMA_FINGERPRINT =
  'f0f54df09712ef93ea267f5bd35c4567b4b81acb37da025242b1ec85ba0e9496';
const SCHEMA_MIGRATIONS_HASH =
  'aa473862a62d3a963934e654f5d21cf0e5c9f50f3f4ef652603c9dc9065de4d8';

const FORWARD_COUNT = 41;
const APPLIED_COUNT = 41;
const POSTGRES_MAJOR = 15;
const PHASE = 'compared';
const BACKEND = 'docker';
const CLEANUP_CODE = 'cleanup_verified';

const REQUIRED_RED = Object.freeze([
  'forward_count_drift',
  'applied_count_drift',
  'schema_migrations_hash_drift',
  'schema_fingerprint_drift',
  'raw_evidence_hash_drift',
  'equality_flag_drift',
  'cleanup_drift',
  'candidate_drift',
  'proof_script_hash_drift',
  'harness_hash_drift',
  'manifest_hash_drift',
  'lock_hash_drift',
]);

const REQUIRED_GREEN = Object.freeze([
  'evidence_fixture_bytes',
  'evidence_lock_hash',
  'observed_facts',
  'binding_proof_script',
  'binding_harness',
  'binding_canonical_manifest',
  'classification_unchanged',
  'offline_only',
]);

const DOES_NOT_PROVE = Object.freeze([
  'G_DOCKER_FRESH_DB_REPLACEMENT_complete',
  'FOUNDATION_production_readiness',
  'MESSI_complete',
  'certificate_architecture',
  'live_restore_drill',
]);

module.exports = {
  CANDIDATE_SHA,
  BRANCH,
  SLICE,
  GATE,
  KIND,
  OUTCOME_ID,
  EVIDENCE_REL,
  CONTRACT_REL,
  PROOF_SCRIPT_REL,
  HARNESS_REL,
  CANONICAL_MANIFEST_REL,
  PROOF_SCRIPT_SHA256,
  HARNESS_SHA256,
  CANONICAL_MANIFEST_FILE_SHA256,
  CANONICAL_MANIFEST_HASH,
  CHECKSUM_MODE,
  EVIDENCE_SHA256,
  CONTRACT_SHA256,
  EVIDENCE_LOCK_HASH,
  RAW_EVIDENCE_SHA256,
  SCHEMA_FINGERPRINT,
  SCHEMA_MIGRATIONS_HASH,
  FORWARD_COUNT,
  APPLIED_COUNT,
  POSTGRES_MAJOR,
  PHASE,
  BACKEND,
  CLEANUP_CODE,
  REQUIRED_RED,
  REQUIRED_GREEN,
  DOES_NOT_PROVE,
};
