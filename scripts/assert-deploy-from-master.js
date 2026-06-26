'use strict';

/**
 * Deploy preflight guard.
 *
 * Refuse to build/ship a staging or prod image unless the local tree is CLEAN and
 * HEAD == origin/master. This prevents the recurring failure where two machines /
 * agents each build an image from their own divergent local tip and silently
 * overwrite each other's merged work on staging/prod.
 *
 * Run this immediately before any `az acr build` + containerapp deploy of
 * wh-staff-api (staging or prod):
 *   node scripts/assert-deploy-from-master.js
 *
 * Exit 0 = safe to build from this tree. Nonzero = stop, with guidance.
 */

const { execSync } = require('child_process');

function git(args) { return execSync(`git ${args}`, { encoding: 'utf8' }).trim(); }

const fail = [];

try {
  if (git('status --porcelain') !== '') {
    fail.push('working tree is DIRTY — commit/stash before building a deploy image (images must be reproducible from a commit).');
  }
} catch (e) { fail.push(`could not read git status: ${e.message}`); }

try { execSync('git fetch origin master --quiet', { stdio: 'ignore' }); }
catch (e) { fail.push(`git fetch origin master failed: ${e.message}`); }

let head = '';
let om = '';
try { head = git('rev-parse HEAD'); om = git('rev-parse origin/master'); }
catch (e) { fail.push(`rev-parse failed: ${e.message}`); }

if (head && om && head !== om) {
  fail.push(`HEAD (${head.slice(0, 9)}) != origin/master (${om.slice(0, 9)}). Deploy images MUST be built from current origin/master so parallel deploys can't clobber merged work.`);
  try {
    const ab = git('rev-list --left-right --count origin/master...HEAD'); // "<behind>\t<ahead>"
    const [behind, ahead] = ab.split(/\s+/);
    fail.push(`  (behind origin/master by ${behind}, ahead by ${ahead})`);
  } catch (_) { /* ignore */ }
}

if (fail.length) {
  console.error('✗ assert-deploy-from-master FAILED — do NOT build/deploy:');
  fail.forEach((f) => console.error(`  - ${f}`));
  console.error('\nFix: merge your branch to master first, then:');
  console.error('  git checkout master && git fetch origin && git reset --hard origin/master');
  console.error('  …then rebuild the image, tagging it with the master SHA.');
  process.exit(1);
}

console.log(`✓ deploy preflight OK — clean tree at origin/master (${head.slice(0, 9)}). Safe to build the image.`);
process.exit(0);
