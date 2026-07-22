'use strict';

/**
 * Evidence durability — every commit SHA loaded via `git show` by MESSI /
 * FACTORY / RADAR break-glass gates must be reachable from master OR from a
 * durable namespaced `evidence/*` tag/ref. No branch-name trust.
 */

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const redesignPin = require('./breakglass-redesign-candidate-sha');

/**
 * Commit SHAs that gates resolve and `git show` against. Blob-only pins are
 * excluded (they are content-addressed and ride along master trees).
 */
const REQUIRED_EVIDENCE_COMMITS = Object.freeze([
  // 1E reviewed + redesign content + correction + landing + squash-proof content
  redesignPin.SQUASH_PROOF_REVIEWED_CANDIDATE,
  redesignPin.REDESIGN_CANDIDATE_SHA,
  redesignPin.CORRECTION_CANDIDATE_BOUND,
  redesignPin.SQUASH_PROOF_LANDING_TIP,
  redesignPin.SQUASH_PROOF_CANDIDATE_SHA,
  // MESSI 1B / 1D reviewed candidates
  '4a550b44bb7669a860557f0ec211260d7b76250c',
  'fa2c5d71ad6c662b4c4f60b08ede409064acf2fe',
  // FACTORY reviewed candidates
  '6910c4179677b1a33cb9e0863e90e6d5dab58935',
  '363722c8233bfce3b7c250ae994d3f2151cff96c',
  // RADAR 16AP candidate + merge (on master, listed for completeness)
  '7870a9fb818bbd94d33b291c8782851276e2715e',
  'b9feab2438e3d42817487ce97d87df7e36f7f18e',
].filter((s) => /^[0-9a-f]{40}$/i.test(String(s || '').trim())));

const EVIDENCE_TAG_PREFIX = 'evidence/';

module.exports = deepFreeze({
  REQUIRED_EVIDENCE_COMMITS,
  EVIDENCE_TAG_PREFIX,
  redesignPin,
});
