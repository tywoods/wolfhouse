'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4G/4H — source-tree
 * self-hash attestation of canonical 4C/4E runtime owners. Not an
 * independent image measurement and cannot establish deployed image truth.
 *
 * @module email-luna-controlled-drafting-live-downscope-prover-canonical-owners
 */

const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const {
  EXPECTED_LIVE_TARGET,
  OPERATOR_PROVER_COMPATIBILITY_RULE,
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
} = require('./email-luna-controlled-drafting-live-downscope-prover-live-target-constants');

const objectFreeze = Object.freeze;

const CANONICAL_RUNTIME_OWNER_DIGESTS = objectFreeze({
  'email-delegated-grant-custodian.js':
    '28cbcd5773e8135bf42b22acd4cf11d42365ead02b873b370d93018f2d355f5d',
  'email-delegated-grant-access-session.js':
    '9a40122bdedd085e10bdc24b1fa4dc4c77b34a0b68b76dc346ea35f822155757',
  'email-microsoft-refresh-token-request.js':
    'a5ea40a96d2af0b383e17051a98b594ecf100736be32fa56a216775c403c3006',
  'email-microsoft-refresh-token-response-by-scope-version.js':
    'c3f273658c385810930c93b009d4de67f8de63a1d73f21c48d4fdf387de719f2',
  'email-microsoft-oidc-jwks-verifier.js':
    'a2806088c9101d43892612642a40c739e83282b61b1cb883de88ce740793297e',
  'email-microsoft-token-http-transport.js':
    '8b560823cbb31831d17a5081811cafd90e7a355f09154ec3c93486d03196779b',
  'email-luna-controlled-drafting-access-token-claims.js':
    'a392674851e6fdbbcb040dea3eae7786b8d25f7d8b999ecfed32d25b31a8e74a',
  'email-luna-controlled-drafting-session-proof.js':
    'f570713c80ece2c6eb460a2cf323dae6d08c4c2dfe3daab7980731c41eb14909',
  'email-luna-controlled-drafting-principal-connection.js':
    '68e4ee1c4c64946e95fde043cfd9d133e7562bc4318270354214ec3677467196',
  'email-luna-controlled-drafting-token-loan.js':
    '19189b827be30b8eb89ec02efb505876fb15ca00ede79de4c6aa37cf9405dd8a',
  'email-grant-envelope-azure-kv-sunset-staging-runtime-composition.js':
    'd27363f44252567d8916deb1cab9020c498067111f0be81e41f5f8878951ebc9',
  'sunset-microsoft-oauth-provider.js':
    'e6e96d57e10cc6bdcc7e7725a78eeefc862ed79841a96de7888a882a113b0054',
  'email-microsoft-delegated-oauth-contract.js':
    '3ca32b447033692908b265eebd324040db6ffe54bee80bfc563857679550d986',
  'email-grant-envelope-provider-contract.js':
    '352f7564a37c3a8501063e1ae71f2c31abac4d40e93997ec771322d109481038',
  'email-luna-controlled-drafting-closed-data.js':
    '0e95f5187da38fc1a31e5e3f9eb170ef7d75ea317bb7062a396cbe8431ecaa04',
});

if (LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== false) {
  throw new Error('controlled_drafting_live_execute_must_be_disabled_in_this_chapter');
}

function sha256File(abs) {
  const hasher = nodeCrypto.createHash('sha256');
  hasher.update(fs.readFileSync(abs));
  return hasher.digest('hex');
}

function proveCanonicalRuntimeOwnersMatchDeployedContract() {
  const files = Object.keys(CANONICAL_RUNTIME_OWNER_DIGESTS);
  const mismatches = [];
  for (let i = 0; i < files.length; i += 1) {
    const rel = files[i];
    const abs = path.join(__dirname, rel);
    let digest;
    try {
      digest = sha256File(abs);
    } catch (_) {
      return objectFreeze({
        ok: false,
        matched: false,
        file_count: files.length,
        attestation_kind: 'source_tree_self_hash',
        independent_image_measurement: false,
        cannot_establish_deployed_image_truth: true,
        mismatches: objectFreeze([rel]),
      });
    }
    if (digest !== CANONICAL_RUNTIME_OWNER_DIGESTS[rel]) mismatches.push(rel);
  }
  return objectFreeze({
    ok: mismatches.length === 0,
    matched: mismatches.length === 0,
    file_count: files.length,
    deployed_sha: EXPECTED_LIVE_TARGET.deployedSha,
    rule_id: OPERATOR_PROVER_COMPATIBILITY_RULE.rule_id,
    attestation_kind: 'source_tree_self_hash',
    independent_image_measurement: false,
    cannot_establish_deployed_image_truth: true,
    mismatches: objectFreeze(mismatches),
  });
}

module.exports = objectFreeze({
  CANONICAL_RUNTIME_OWNER_DIGESTS,
  proveCanonicalRuntimeOwnersMatchDeployedContract,
});
