'use strict';

/**
 * Fast-deploy must pin Staff and Luna to separate tested SHAs (not one shared version).
 * Dry-run / plan-only. No compose, no docker, no deploy.
 *
 * Run: node scripts/verify-france-staging-fast-deploy-per-service.js
 */

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.join(__dirname, '..');
const script = path.join(__dirname, 'france-wolfhouse-staging-fast-deploy.js');

function git(args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return (r.stdout || '').trim();
}

const staffTo = git(['rev-parse', 'HEAD']);
const lunaTo = git(['rev-parse', 'HEAD~1']);
const sharedFrom = git(['rev-parse', 'HEAD~2']);
assert.notEqual(staffTo, lunaTo, 'fixture SHAs must differ');

const r = spawnSync(process.execPath, [
  script,
  '--staff-from', sharedFrom,
  '--staff-to', staffTo,
  '--luna-from', sharedFrom,
  '--luna-to', lunaTo,
  '--repo', repo,
], { encoding: 'utf8', cwd: repo });

assert.equal(r.status, 0, r.stderr || r.stdout);
const out = String(r.stdout || '');
assert.match(out, /FASTDEPLOY plan|FASTDEPLOY PLAN-ONLY/);
assert.match(out, new RegExp(`staff_to ${staffTo}`));
assert.match(out, new RegExp(`luna_to ${lunaTo}`));
assert.doesNotMatch(out, new RegExp(`staff_to ${lunaTo}`));
assert.doesNotMatch(out, new RegExp(`luna_to ${staffTo}`));

const src = fs.readFileSync(script, 'utf8');
assert.match(src, /assertDeployTargetHasCodeMigrations/, 'keep #1649 refuse-to-finish migration gate');
assert.ok(src.indexOf('assertDeployTargetHasCodeMigrations') < src.indexOf('FASTDEPLOY DONE'));

const { materializeCommitTree } = require('./france-wolfhouse-staging-fast-deploy');
assert.equal(typeof materializeCommitTree, 'function');
assert.match(src, /sha: staffTo/, 'Staff build must use the Staff target SHA');
assert.match(src, /sha: lunaTo/, 'Luna build must use the Luna target SHA');
assert.match(src, /materializeCommitTree/);
assert.match(src, /git archive/);

// Use purpose-built commits rather than HEAD/HEAD~1: unrelated future commits may
// legitimately leave this deploy script byte-identical while the target SHAs differ.
const fixtureRepo = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fast-source-fixture-'));
const dirA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fast-staff-'));
const dirB = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fast-luna-'));
function fixtureGit(args) {
  const result = spawnSync('git', args, { cwd: fixtureRepo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}
try {
  fixtureGit(['init', '--quiet']);
  fixtureGit(['config', 'user.name', 'Fast Deploy Test']);
  fixtureGit(['config', 'user.email', 'fast-deploy-test@example.invalid']);
  fs.writeFileSync(path.join(fixtureRepo, 'source.txt'), 'staff source\n');
  fixtureGit(['add', 'source.txt']);
  fixtureGit(['commit', '--quiet', '-m', 'staff source']);
  const staffFixtureSha = fixtureGit(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(fixtureRepo, 'source.txt'), 'luna source\n');
  fixtureGit(['commit', '--quiet', '-am', 'luna source']);
  const lunaFixtureSha = fixtureGit(['rev-parse', 'HEAD']);
  assert.notEqual(staffFixtureSha, lunaFixtureSha, 'fixture source SHAs must differ');

  materializeCommitTree(fixtureRepo, staffFixtureSha, dirA);
  materializeCommitTree(fixtureRepo, lunaFixtureSha, dirB);
  assert.equal(fs.readFileSync(path.join(dirA, 'source.txt'), 'utf8'), 'staff source\n');
  assert.equal(fs.readFileSync(path.join(dirB, 'source.txt'), 'utf8'), 'luna source\n');
} finally {
  fs.rmSync(fixtureRepo, { recursive: true, force: true });
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
}

console.log('PASS fast-deploy dry-run pins Staff and Luna to different SHAs and different source trees');
