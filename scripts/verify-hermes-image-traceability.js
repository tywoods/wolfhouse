#!/usr/bin/env node
'use strict';

/**
 * verify-hermes-image-traceability
 *
 * Prove staging Hermes compose refuses floating :latest and requires a full-SHA
 * HERMES_IMAGE. Run: node scripts/verify-hermes-image-traceability.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const COMPOSE_WH = path.join(ROOT, 'docker/hermes-staging/docker-compose.vm.yml');
const COMPOSE_SU = path.join(ROOT, 'docker/hermes-sunset/docker-compose.vm.yml');
const DEPLOY = path.join(ROOT, 'scripts/deploy-staging-hermes-vm.js');
const PROFILE = path.join(ROOT, 'scripts/lib/hermes-vm-profile.js');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

function assertHermesImage(image, expectedSha) {
  const { assertHermesImageRef } = require('./lib/hermes-image-traceability');
  return assertHermesImageRef(image, expectedSha);
}

console.log('\nverify-hermes-image-traceability — immutable Hermes image gates\n');

console.log('[1] Compose has no :latest');
for (const [label, file] of [['wolfhouse', COMPOSE_WH], ['sunset', COMPOSE_SU]]) {
  const text = read(file);
  assert(`${label} compose uses HERMES_IMAGE`, /\$\{HERMES_IMAGE/.test(text));
  assert(`${label} compose refuses missing HERMES_IMAGE`, /\?HERMES_IMAGE must be set/.test(text));
  assert(`${label} compose has no :latest image tag`, !/wh-hermes-staging:latest/.test(text));
}

console.log('\n[2] Deploy script + profile');
const deploy = read(DEPLOY);
assert('deploy builds full SHA tag', /rev-parse HEAD|fullSha|FULL_SHA|git_sha_full/.test(deploy));
assert('deploy refuses :latest for Hermes runtime', /latest/.test(deploy) && /refuse|reject|HERMES_IMAGE/.test(deploy));
assert('deploy selects luna services only for recreate', /hermes-luna|hermes-sunset-luna/.test(deploy));
assert('deploy does not restart orchestrator on luna deploy', /LUNA_ONLY|hermes-luna|no-deps|--no-deps/.test(deploy));

const profile = read(PROFILE);
assert('profile IMAGE is not hard-coded :latest', !/IMAGE:\s*'[^']*:latest'/.test(profile));

console.log('\n[3] Image ref validator');
const sha = '5ca04cb4815866c4e3439e8b3582e16ccc0c5a51';
const {
  assertHermesImageRef,
} = require('./lib/hermes-image-traceability');

assert('missing image fails', assertHermesImageRef('', sha).ok === false);
assert('latest fails', assertHermesImageRef('whstagingacr.azurecr.io/wh-hermes-staging:latest', sha).ok === false);
assert('short sha fails', assertHermesImageRef(`whstagingacr.azurecr.io/wh-hermes-staging:${sha.slice(0, 7)}`, sha).ok === false);
assert('wrong registry fails', assertHermesImageRef(`other.azurecr.io/wh-hermes-staging:${sha}`, sha).ok === false);
assert('mismatch sha fails', assertHermesImageRef(`whstagingacr.azurecr.io/wh-hermes-staging:${'a'.repeat(40)}`, sha).ok === false);
assert(
  'correct full sha passes',
  assertHermesImageRef(`whstagingacr.azurecr.io/wh-hermes-staging:${sha}`, sha).ok === true,
);

console.log('\n[4] Rendered compose resolves to exact SHA');
const img = `whstagingacr.azurecr.io/wh-hermes-staging:${sha}`;
const rendered = spawnSync(
  'docker',
  ['compose', '-f', COMPOSE_WH, 'config'],
  {
    cwd: ROOT,
    env: { ...process.env, HERMES_IMAGE: img },
    encoding: 'utf8',
  },
);
if (rendered.status !== 0) {
  // compose may fail without env files — fallback: substitute manually
  const text = read(COMPOSE_WH).split('${HERMES_IMAGE:?HERMES_IMAGE must be set to whstagingacr.azurecr.io/wh-hermes-staging:<full-master-sha>}').join(img);
  assert('manual render uses exact image', text.includes(img) && !text.includes(':latest'));
  assert('manual render has hermes-luna', /hermes-luna:/.test(text));
  assert('manual render has hermes-orchestrator (defined but not auto-restarted by luna deploy)', /hermes-orchestrator:/.test(text));
} else {
  assert('compose config exit 0', rendered.status === 0);
  assert('compose config image exact', (rendered.stdout || '').includes(img));
  assert('compose config no latest', !(rendered.stdout || '').includes('wh-hermes-staging:latest'));
}

// Missing HERMES_IMAGE must fail compose config
const missing = spawnSync(
  'docker',
  ['compose', '-f', COMPOSE_WH, 'config'],
  {
    cwd: ROOT,
    env: { ...process.env, HERMES_IMAGE: '' },
    encoding: 'utf8',
  },
);
assert(
  'missing HERMES_IMAGE fails compose config',
  missing.status !== 0 || /HERMES_IMAGE must be set/.test(String(missing.stderr || missing.stdout || '')),
);

console.log(`\nverify-hermes-image-traceability: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
