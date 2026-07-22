'use strict';

/**
 * foundation-docker-fresh-db-replacement-evidence — locks for the Lunabox
 * disposable-Docker compared result packaged as a compact offline fixture.
 *
 * Does NOT reclassify FOUNDATION G_DOCKER_FRESH_DB_REPLACEMENT or MESSI.
 * No certificate architecture. Offline verification only (no live Docker rerun).
 */

const CANDIDATE_SHA = '6524df68e9f04364fc1f5e58d845c2aa6b344670';
const BRANCH = 'master';
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
  'd73d6ecd0a836029ef4f90459d9c22912101958b9e64c0c8021280e8d99eab60';
const CANONICAL_MANIFEST_HASH =
  '37e64d804b9e88d6f84cd40e138c9a839b012eaa90219838d7894bcba4d677d8';
const CHECKSUM_MODE = 'canonical_lf_v1';

const EVIDENCE_SHA256 =
  'd93576b50633b5afeb5b6a2b8ad9ec71ef87491f569d148f0452ef3a9d52e5d8';
const CONTRACT_SHA256 =
  '843707304dd04b9c99a56260da7bba2e1845e779acf34adcbad2ec2e9e91df72';
const EVIDENCE_LOCK_HASH =
  'c2b5d2af6e4eb93876e18aa2c0587478e6fa45d0c6ea60591795274ea1255e48';

const RAW_EVIDENCE_SHA256 =
  '7208e815a017b095cca5ce19bc3df8815d6c9fcd888db83997a4a37f4c0b2efa';
const SCHEMA_FINGERPRINT =
  'f0f54df09712ef93ea267f5bd35c4567b4b81acb37da025242b1ec85ba0e9496';
const SCHEMA_MIGRATIONS_HASH =
  'f26b8ecfcca7609628948db8226ca420ad6815984d7135cd3871683ef2acae4b';

const FORWARD_COUNT = 43;
const APPLIED_COUNT = 43;
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
