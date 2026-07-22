'use strict';

/**
 * Git-anchored whole-path redesign trust root.
 *
 * The redesign reviewed-candidate SHA is pinned here (not in working-tree JSON).
 * Bootstrap sequence:
 *   1) content commit freezes verifier/engine/fixture blobs (this SHA empty)
 *   2) anchor commit sets REDESIGN_CANDIDATE_SHA to that content commit
 *
 * Anchor-only paths (may differ between content and tip):
 *   - this module
 *   - fixtures/messi-acceptance/breakglass-whole-path-blobs.json (metadata mirror)
 *
 * REDESIGN_PATHS are byte-checked at tip against REDESIGN_CANDIDATE_SHA.
 */

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** Empty during bootstrap content commit; set by the separate anchor commit. */
const REDESIGN_CANDIDATE_SHA = '14ef46c4485a6bee50ac4916d5ddf9ee4fa188db';

const REDESIGN_CERT_ID = 'breakglass-whole-path';
const CORRECTION_CANDIDATE_BOUND = '53c1abcfb67edb491c5100de571260c60813aec4';
const MASTER_BASIS_BOUND = '38f1a719fa3287af43737b2fca7f9b4d4f71383a';

const ANCHOR_FIXTURE_REL =
  'fixtures/messi-acceptance/breakglass-whole-path-blobs.json';
const PIN_MODULE_REL = 'scripts/lib/breakglass-redesign-candidate-sha.js';

/**
 * Paths frozen by the redesign certificate (must match the content bootstrap
 * commit). Intentionally excludes PIN_MODULE_REL and ANCHOR_FIXTURE_REL so the
 * anchor commit can activate the SHA without co-tampering certified blobs.
 */
const REDESIGN_PATHS = Object.freeze([
  'fixtures/messi-acceptance/slice1a-contract.json',
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

function isRedesignActivated() {
  return /^[0-9a-f]{40}$/i.test(String(REDESIGN_CANDIDATE_SHA || '').trim());
}

module.exports = deepFreeze({
  REDESIGN_CANDIDATE_SHA,
  REDESIGN_CERT_ID,
  CORRECTION_CANDIDATE_BOUND,
  MASTER_BASIS_BOUND,
  ANCHOR_FIXTURE_REL,
  PIN_MODULE_REL,
  REDESIGN_PATHS,
  isRedesignActivated,
});
