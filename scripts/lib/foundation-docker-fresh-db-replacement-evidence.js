'use strict';

/**
 * foundation-docker-fresh-db-replacement-evidence — locks for the Lunabox
 * disposable-Docker compared result packaged as a compact offline fixture.
 *
 * Does NOT reclassify FOUNDATION G_DOCKER_FRESH_DB_REPLACEMENT or MESSI.
 * No certificate architecture. Offline verification only (no live Docker rerun).
 */

const CANDIDATE_SHA = '4621353f16fc00783ae87b9391ca2c6578decd44';
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
  'e6aeb09d8780016202683a82baf9ce43371c2618fd57d1c1b947a7b6cd38622c';
const CANONICAL_MANIFEST_HASH =
  '0c0b80a2b188bb8ffa69ac187d746f0db671979ac723ffa5ffa9a9f4aeabc36e';
const CHECKSUM_MODE = 'canonical_lf_v1';

const EVIDENCE_SHA256 =
  'd4efd067d2ccaacb11c86d4be8e7b937b1a8e920c8e6801a1ed7a204079419d0';
const CONTRACT_SHA256 =
  '405466965a8d7373cf2a3087e84633dfaecb0d1d22fed298768fc82088b92af0';
const EVIDENCE_LOCK_HASH =
  '5e52011f941d61a0aade66ea159c33bcf86927823526e8b430e48e403579b0b5';

const RAW_EVIDENCE_SHA256 =
  'df988d93655ae0f31358f377bcbc349c4eacfa0689251945ac6d690a0a216df9';
const SCHEMA_FINGERPRINT =
  'f0f54df09712ef93ea267f5bd35c4567b4b81acb37da025242b1ec85ba0e9496';
const SCHEMA_MIGRATIONS_HASH =
  '8df9c24f07a29891bb4cd2d67796b1d163f7c1b3576b090a00c3d0145347f02e';

const FORWARD_COUNT = 44;
const APPLIED_COUNT = 44;
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
