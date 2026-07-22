'use strict';

/**
 * Deterministic git commit-tree helper for gate RED topology proofs.
 * Fresh clones often lack user.name/email; commit-tree fails closed without
 * explicit author/committer identity. No branch-name trust.
 */

const { spawnSync } = require('child_process');

const PROOF_ENV = Object.freeze({
  GIT_AUTHOR_NAME: 'messi-gate-proof',
  GIT_AUTHOR_EMAIL: 'messi-gate-proof@test',
  GIT_COMMITTER_NAME: 'messi-gate-proof',
  GIT_COMMITTER_EMAIL: 'messi-gate-proof@test',
  GIT_AUTHOR_DATE: '2026-07-22T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-07-22T00:00:00Z',
});

function commitTree(root, treeSha, parents, message) {
  const args = ['commit-tree', String(treeSha)];
  for (const p of parents || []) {
    args.push('-p', String(p));
  }
  args.push('-m', String(message || 'gate-proof-commit'));
  const r = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...PROOF_ENV },
  });
  if (r.status !== 0) {
    throw new Error(String(r.stderr || r.stdout || 'commit-tree failed'));
  }
  return String(r.stdout || '').trim();
}

module.exports = {
  PROOF_ENV,
  commitTree,
};
