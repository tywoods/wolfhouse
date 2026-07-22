'use strict';

/**
 * verify:evidence-durable-refs
 *
 * Fail closed when any commit SHA loaded by gate `git show` is missing from a
 * fresh-clone-reachable durable ref: ancestor of origin/master (or master) OR
 * a namespaced evidence/* tag. No branch-name trust. No path allowlists.
 */

const { execSync } = require('child_process');
const path = require('path');
const locks = require('./lib/evidence-durable-refs');

const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;

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

function git(args) {
  return execSync(args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(args) {
  try {
    return { ok: true, out: git(args) };
  } catch (err) {
    return {
      ok: false,
      out: String((err && err.stderr) || (err && err.message) || err),
    };
  }
}

function resolveMasterTip() {
  for (const ref of ['origin/master', 'master', 'HEAD']) {
    const r = tryGit(`git rev-parse --verify ${ref}^{commit}`);
    if (r.ok) return r.out;
  }
  return null;
}

function isCommit(sha) {
  const r = tryGit(`git cat-file -t ${sha}`);
  return r.ok && r.out === 'commit';
}

function isAncestor(ancestor, descendant) {
  const r = tryGit(`git merge-base --is-ancestor ${ancestor} ${descendant}`);
  return r.ok;
}

function evidenceTagFor(sha) {
  return `${locks.EVIDENCE_TAG_PREFIX}${sha}`;
}

function tagPointsAt(tag, sha) {
  const r = tryGit(`git rev-parse --verify ${tag}^{commit}`);
  return r.ok && r.out.toLowerCase() === String(sha).toLowerCase();
}

function listEvidenceTags() {
  const r = tryGit('git tag -l evidence/*');
  if (!r.ok || !r.out) return [];
  return r.out.split('\n').map((s) => s.trim()).filter(Boolean);
}

console.log('verify:evidence-durable-refs\n');

const master = resolveMasterTip();
ok('master tip resolvable', Boolean(master), 'origin/master|master|HEAD');

const required = locks.REQUIRED_EVIDENCE_COMMITS;
ok('required evidence commit list non-empty', required.length > 0, `n=${required.length}`);

const missing = [];
const durable = [];

for (const sha of required) {
  if (!isCommit(sha)) {
    missing.push(`not_a_commit:${sha}`);
    ok(`commit exists ${sha.slice(0, 12)}`, false, 'missing object');
    continue;
  }
  const onMaster = master ? isAncestor(sha, master) : false;
  const tag = evidenceTagFor(sha);
  const tagged = tagPointsAt(tag, sha);
  const okDurable = onMaster || tagged;
  ok(
    `durable ${sha.slice(0, 12)}`,
    okDurable,
    onMaster
      ? 'reachable_from_master'
      : (tagged ? `tag:${tag}` : `missing_durable_ref:need ${tag}`),
  );
  if (okDurable) {
    durable.push({
      sha,
      via: onMaster ? 'master' : tag,
    });
  } else {
    missing.push(sha);
  }
}

ok('no missing durable refs', missing.length === 0, missing.join(','));

// RED: evidence tag namespace must not be confused with branch names.
ok(
  'evidence prefix is namespaced',
  locks.EVIDENCE_TAG_PREFIX === 'evidence/',
);

const tags = listEvidenceTags();
ok(
  'evidence tags are commit-ish when present',
  tags.every((t) => {
    const r = tryGit(`git rev-parse --verify ${t}^{commit}`);
    return r.ok;
  }),
  `tags=${tags.length}`,
);

console.log(`\n── Summary: ${pass} passed / ${fail} failed ──`);
if (fail > 0) {
  console.log('verify:evidence-durable-refs — FAILED');
  process.exit(1);
}
console.log('verify:evidence-durable-refs — ALL CHECKS PASSED');
