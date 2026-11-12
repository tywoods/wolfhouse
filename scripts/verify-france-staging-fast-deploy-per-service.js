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
const dirA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fast-staff-'));
const dirB = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fast-luna-'));
try {
  materializeCommitTree(repo, staffTo, dirA);
  materializeCommitTree(repo, lunaTo, dirB);
  const fileA = fs.readFileSync(path.join(dirA, 'scripts/france-wolfhouse-staging-fast-deploy.js'), 'utf8');
  const fileB = fs.readFileSync(path.join(dirB, 'scripts/france-wolfhouse-staging-fast-deploy.js'), 'utf8');
  assert.notEqual(fileA, fileB, 'Staff and Luna source contexts must come from different commits');
  assert.match(src, /materializeCommitTree/);
  assert.match(src, /git archive/);
} finally {
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
}

console.log('PASS fast-deploy dry-run pins Staff and Luna to different SHAs and different source trees');
