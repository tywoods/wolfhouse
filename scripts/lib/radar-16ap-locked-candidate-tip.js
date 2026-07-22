'use strict';

/**
 * Shared 16AP locked-candidate tip acceptance for C1 / F48.
 *
 * Canonical matrix/contract/selected_16ap branch *pins* stay exact elsewhere.
 * Checkout tip acceptance is ancestry-only: every accepted current/synthetic tip
 * must pass `git merge-base --is-ancestor` exact reviewed candidate
 * 7870a9fb818bbd94d33b291c8782851276e2715e <tip>. Branch name is informational
 * only and is never trusted — including a tip claiming
 * radar/slice-16ap-finite-closeout.
 *
 * Fail-closed: invalid refs, non-hex tips, and git errors all reject.
 * Single owner module so finite-closeout + operations-ledger verifiers cannot drift.
 */

const { execSync } = require('child_process');
const { commitTree } = require('./git-identity-commit-tree');

const CANDIDATE_SHA = '7870a9fb818bbd94d33b291c8782851276e2715e';
const MERGE_SHA = 'b9feab2438e3d42817487ce97d87df7e36f7f18e';
const BRANCH = 'radar/slice-16ap-finite-closeout';
const MASTER_BASIS = '66e34a5833ff3bcc7f297108f594b4fc58a0eccc';

function resolveRoot(cwd) {
  return cwd || process.cwd();
}

function currentBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: resolveRoot(cwd),
      encoding: 'utf8',
    }).trim();
  } catch (_) {
    return 'HEAD';
  }
}

function currentHeadSha(cwd) {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: resolveRoot(cwd),
      encoding: 'utf8',
    }).trim();
  } catch (_) {
    return '';
  }
}

/**
 * True when tipSha is the locked candidate or any descendant containing it as
 * ancestor. Fail-closed on bad tip shape or git errors.
 */
function tipContainsCandidate(tipSha, cwd) {
  const tip = String(tipSha || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(tip)) return false;
  try {
    execSync(
      `git merge-base --is-ancestor ${CANDIDATE_SHA} ${tip}`,
      {
        cwd: resolveRoot(cwd),
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Tip acceptance: mandatory ancestry only. `_branchName` is informational and
 * must never bypass the merge-base check (spoofed locked branch name rejects).
 */
function tipAccepts16ap(tipSha, _branchName, cwd) {
  return tipContainsCandidate(tipSha, cwd);
}

function makeSyntheticDescendantOfCandidate(cwd) {
  const root = resolveRoot(cwd);
  const tree = execSync(
    `git rev-parse ${CANDIDATE_SHA}^{tree}`,
    { cwd: root, encoding: 'utf8' },
  ).trim();
  return commitTree(root, tree, [CANDIDATE_SHA], '16ap-synth-descendant-proof');
}

function makeUnrelatedOrphanCommit(cwd) {
  const root = resolveRoot(cwd);
  const tree = execSync(
    `git rev-parse ${MASTER_BASIS}^{tree}`,
    { cwd: root, encoding: 'utf8' },
  ).trim();
  return commitTree(root, tree, [], '16ap-unrelated-orphan-proof');
}

module.exports = Object.freeze({
  CANDIDATE_SHA,
  MERGE_SHA,
  BRANCH,
  MASTER_BASIS,
  currentBranch,
  currentHeadSha,
  tipContainsCandidate,
  tipAccepts16ap,
  makeSyntheticDescendantOfCandidate,
  makeUnrelatedOrphanCommit,
});
