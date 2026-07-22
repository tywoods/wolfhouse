'use strict';

/**
 * Git-anchored whole-path redesign trust root + 1E squash-proof supersession pin.
 *
 * The redesign reviewed-candidate SHA is pinned here (not in working-tree JSON).
 * Bootstrap sequence:
 *   1) content commit freezes verifier/engine/fixture blobs (this SHA empty)
 *   2) anchor commit sets REDESIGN_CANDIDATE_SHA to that content commit
 *
 * Post-merge PR #154 squash break-glass:
 *   - package.json is intentionally NOT in REDESIGN_PATHS (concurrent master
 *     scripts may diverge; MESSI script keys stay GREEN-checked).
 *   - Exact reviewed 1E candidate 9a35afcc and squash landing c61bc9fe bind via
 *     candidate-path blob equality (no ancestry / path-range inference).
 *   - SQUASH_PROOF_* activates a superseding certificate for redesign-path
 *     files edited by this correction (content commit → anchor commit).
 *
 * Anchor-only paths (may differ between content and tip):
 *   - this module
 *   - fixtures/messi-acceptance/breakglass-whole-path-blobs.json (metadata mirror)
 */

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** Empty during bootstrap content commit; set by the separate anchor commit. */
const REDESIGN_CANDIDATE_SHA = '20f96aead39fbf0854452ec77f855965df3c0ac0';

const REDESIGN_CERT_ID = 'breakglass-whole-path';
const CORRECTION_CANDIDATE_BOUND = '53c1abcfb67edb491c5100de571260c60813aec4';
const MASTER_BASIS_BOUND = '38f1a719fa3287af43737b2fca7f9b4d4f71383a';

/** Exact reviewed 1E candidate (pre-squash tip of messi/slice-1e-fortress-wiring). */
const SQUASH_PROOF_REVIEWED_CANDIDATE =
  '9a35afcc6b94fc4bf49a96b11654c6e8ec424bb1';
/** Squash landing on master (PR #154). */
const SQUASH_PROOF_LANDING_TIP =
  'c61bc9feba412de8e24cd14b5907bd62b65abd13';

const SQUASH_PROOF_CERT_ID = 'breakglass-1e-squash-proof';
/**
 * Empty during content bootstrap; anchor commit sets this to the content SHA
 * so tip blobs for SQUASH_PROOF_PATHS bind without ancestry trust.
 * 1F reuses this existing squash-proof cert (no new certificate architecture).
 */
const SQUASH_PROOF_CANDIDATE_SHA = '';

const ANCHOR_FIXTURE_REL =
  'fixtures/messi-acceptance/breakglass-whole-path-blobs.json';
const PIN_MODULE_REL = 'scripts/lib/breakglass-redesign-candidate-sha.js';

/**
 * Paths frozen by the redesign certificate (must match the content bootstrap
 * commit). Intentionally excludes PIN_MODULE_REL and ANCHOR_FIXTURE_REL so the
 * anchor commit can activate the SHA without co-tampering certified blobs.
 *
 * package.json excluded: concurrent unrelated script registration on master
 * must not resolve protected package.json to a stale breakglass blob.
 */
const REDESIGN_PATHS = Object.freeze([
  'docs/MESSI-ACCEPTANCE-LEDGER.md',
  'fixtures/messi-acceptance/slice1a-contract.json',
  'fixtures/messi-acceptance/slice1a-findings.md',
  'fixtures/messi-acceptance/slice1a-ledger.json',
  'scripts/lib/factory-slice1b-archetype-templates.js',
  'scripts/lib/factory-slice1e-finite-closeout.js',
  'scripts/lib/messi-slice1a-acceptance-ledger.js',
  'scripts/lib/messi-slice1b-foundation-closeout.js',
  'scripts/lib/messi-slice1d-fortress-closeout.js',
  'scripts/lib/reviewed-candidate-blob-certificates.js',
  'scripts/verify-factory-slice1b-archetype-templates.js',
  'scripts/verify-factory-slice1e-finite-closeout.js',
  'scripts/verify-messi-slice1a-acceptance-ledger.js',
  'scripts/verify-messi-slice1b-foundation-closeout.js',
  'scripts/verify-messi-slice1d-fortress-closeout.js',
].sort());

/**
 * Redesign-path files this squash-proof correction may supersede once the
 * content candidate SHA is anchored. Subset of REDESIGN_PATHS. Expanded for
 * MESSI 1F ledger/doc/fixture wiring (reuse existing cert id — no new arch).
 */
const SQUASH_PROOF_PATHS = Object.freeze([
  'docs/MESSI-ACCEPTANCE-LEDGER.md',
  'fixtures/messi-acceptance/slice1a-contract.json',
  'fixtures/messi-acceptance/slice1a-findings.md',
  'fixtures/messi-acceptance/slice1a-ledger.json',
  'scripts/lib/messi-slice1a-acceptance-ledger.js',
  'scripts/lib/messi-slice1b-foundation-closeout.js',
  'scripts/lib/messi-slice1d-fortress-closeout.js',
  'scripts/lib/reviewed-candidate-blob-certificates.js',
  'scripts/verify-factory-slice1b-archetype-templates.js',
  'scripts/verify-factory-slice1e-finite-closeout.js',
  'scripts/verify-messi-slice1a-acceptance-ledger.js',
  'scripts/verify-messi-slice1b-foundation-closeout.js',
  'scripts/verify-messi-slice1d-fortress-closeout.js',
].sort());

function isRedesignActivated() {
  return /^[0-9a-f]{40}$/i.test(String(REDESIGN_CANDIDATE_SHA || '').trim());
}

function isSquashProofActivated() {
  return /^[0-9a-f]{40}$/i.test(String(SQUASH_PROOF_CANDIDATE_SHA || '').trim());
}

module.exports = deepFreeze({
  REDESIGN_CANDIDATE_SHA,
  REDESIGN_CERT_ID,
  CORRECTION_CANDIDATE_BOUND,
  MASTER_BASIS_BOUND,
  ANCHOR_FIXTURE_REL,
  PIN_MODULE_REL,
  REDESIGN_PATHS,
  SQUASH_PROOF_CERT_ID,
  SQUASH_PROOF_CANDIDATE_SHA,
  SQUASH_PROOF_REVIEWED_CANDIDATE,
  SQUASH_PROOF_LANDING_TIP,
  SQUASH_PROOF_PATHS,
  isRedesignActivated,
  isSquashProofActivated,
});
