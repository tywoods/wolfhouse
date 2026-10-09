#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github/workflows/container-images.yml');
const ROOT_IGNORE = path.join(ROOT, '.dockerignore');
const HERMES_IGNORE = path.join(ROOT, 'docker/hermes-staging/.dockerignore');

let passes = 0;
let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`PASS ${label}`);
    passes += 1;
  } else {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures += 1;
  }
}

function readRequired(file, label) {
  if (!fs.existsSync(file)) {
    check(label, false, `${path.relative(ROOT, file)} is missing`);
    return '';
  }
  check(label, true);
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

const workflow = readRequired(WORKFLOW, 'container workflow exists');
const rootIgnore = readRequired(ROOT_IGNORE, 'root Docker context ignore exists');
const hermesIgnore = readRequired(HERMES_IGNORE, 'Hermes Docker context ignore exists');

if (workflow) {
  check('PR validation trigger exists', /^\s*pull_request:\s*$/m.test(workflow));
  check('manual publisher trigger exists', /^\s*workflow_dispatch:\s*$/m.test(workflow));
  check('hosted runner is versioned', /runs-on:\s*ubuntu-24\.04/.test(workflow));
  check('publisher is master-only manual dispatch', /github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*github\.ref\s*==\s*'refs\/heads\/master'/.test(workflow));
  check('default permissions are read-only', /^permissions:\s*\n\s+contents:\s*read\s*$/m.test(workflow));
  for (const permission of ['packages: write', 'attestations: write', 'id-token: write']) {
    check(`publisher grants ${permission}`, workflow.includes(permission));
  }

  const expected = [
    ['wh-staff-api', 'ghcr.io/tywoods/wh-staff-api', './Dockerfile', '.'],
    ['sunset-staff-api', 'ghcr.io/tywoods/sunset-staff-api', './Dockerfile.luna-sunset-staff-api', '.'],
    ['crowsnest', 'ghcr.io/tywoods/crowsnest', './Dockerfile.crowsnest', '.'],
    ['wh-hermes-staging', 'ghcr.io/tywoods/wh-hermes-staging', 'docker/hermes-staging/Dockerfile', 'docker/hermes-staging'],
  ];
  for (const [name, image, dockerfile, context] of expected) {
    const block = new RegExp(`name:\\s*${name}[\\s\\S]{0,350}?image:\\s*${image.replaceAll('/', '\\/')}[\\s\\S]{0,350}?dockerfile:\\s*${dockerfile.replace('.', '\\.') }[\\s\\S]{0,350}?context:\\s*${context === '.' ? '\\.' : context.replaceAll('/', '\\/')}\\s*(?:\\n|$)`);
    check(`publish matrix pins ${name} owner/context`, block.test(workflow));
    const count = [...workflow.matchAll(new RegExp(`^\\s*- name:\\s*${name}\\s*$`, 'gm'))].length;
    check(`PR and publish matrices contain exactly two ${name} entries`, count === 2, `found ${count}`);
  }

  check('all PRs run validation', /pull_request:\s*\n\s*workflow_dispatch:/m.test(workflow));
  check('PR builds are non-publishing', /pr-build:[\s\S]*?push:\s*false[\s\S]*?publish:/m.test(workflow));
  check('publisher push is explicit', /publish:[\s\S]*?push:\s*true/m.test(workflow));
  check('write permissions are absent from PR build', /pr-build:[\s\S]*?permissions:\s*\n\s*contents:\s*read[\s\S]*?publish:/m.test(workflow));
  check('publisher uses protected environment', /environment:\s*container-publish/.test(workflow));
  check('checkout token is scrubbed before build', /git config --local --unset-all http\.https:\/\/github\.com\/\.extraheader/.test(workflow));
  check('existing package must be private before push', /visibility == ["']private["']/.test(workflow));

  check('full commit SHA is the only registry tag', /tags:\s*\|\s*\n\s*\$\{\{\s*matrix\.image\s*\}\}:\$\{\{\s*github\.sha\s*\}\}/m.test(workflow)
    && !/^\s+[^#\n]*(?:latest|:master)\s*$/mi.test(workflow));
  check('source revision label is present', /org\.opencontainers\.image\.revision=\$\{\{\s*github\.sha\s*\}\}/.test(workflow));
  check('SBOM emission is enabled', /sbom:\s*true/.test(workflow));
  check('max provenance is enabled', /provenance:\s*mode=max/.test(workflow));
  check('registry digest is attested', /subject-digest:\s*\$\{\{\s*steps\.build\.outputs\.digest\s*\}\}/.test(workflow));
  check('Crow build SHA is preserved', /CROWSNEST_BUILD_SHA=\$\{\{\s*github\.sha\s*\}\}/.test(workflow));
  check('Crow build time is preserved', /CROWSNEST_BUILT_AT=/.test(workflow));

  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  check('all third-party actions are full-SHA pinned', uses.length > 0 && uses.every((entry) => /@[0-9a-f]{40}$/.test(entry)), uses.join(', '));

  for (const forbidden of ['pull_request_target', 'ssh ', 'scp ', 'az acr', 'containerapp', 'kubectl', 'docker context']) {
    check(`workflow excludes ${forbidden}`, !workflow.toLowerCase().includes(forbidden));
  }
}

const requiredRootIgnores = [
  '.git', '.github', 'node_modules', '.env', '.env.*', '**/.env', '**/.env.*',
  '.npmrc', '**/.npmrc', '.netrc', '**/.netrc', '.pypirc', '**/.pypirc', '.ssh', '**/.ssh',
  '.docker', '**/.docker/config.json', '*.pem', '*.key', '*.p12', '*credentials*.json', '*service-account*.json',
  '*.sqlite', '*.sqlite3', '*.db', '*.dump', '*.tar', '*.age', 'artifacts', '_work',
  'tmp', 'reports', 'hermes-local', 'review-packet-*',
];
for (const pattern of requiredRootIgnores) {
  check(`root context excludes ${pattern}`, rootIgnore.split(/\r?\n/).includes(pattern));
}

const requiredHermesIgnores = [
  '.git', '.env', '.env.*', '**/.env', '**/.env.*', '.npmrc', '**/.npmrc', '.netrc', '**/.netrc',
  '.pypirc', '**/.pypirc', '.ssh', '**/.ssh', '.docker', '**/.docker/config.json', '*.pem', '*.key', '*.p12',
  '*credentials*.json', '*service-account*.json', '*.sqlite', '*.sqlite3', '*.db',
  '*.dump', '*.tar', '*.age', '__pycache__', '*.pyc', 'node_modules',
];
for (const pattern of requiredHermesIgnores) {
  check(`Hermes context excludes ${pattern}`, hermesIgnore.split(/\r?\n/).includes(pattern));
}

console.log(`\ncontainer build workflow checks: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
