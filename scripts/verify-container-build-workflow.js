#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github/workflows/container-images.yml');
const ROOT_IGNORE = path.join(ROOT, '.dockerignore');
const HERMES_IGNORE = path.join(ROOT, 'docker/hermes-staging/.dockerignore');
const ANONYMOUS_DENIAL = path.join(ROOT, 'scripts/verify-ghcr-anonymous-denial.py');
const HELPER_FREE_PULL = path.join(ROOT, 'scripts/pull-ghcr-digest-helper-free.py');
const FIRST_CREATION_GATE = path.join(ROOT, 'scripts/verify-first-package-creation.js');
const PACKAGE_TARGET_GATE = path.join(ROOT, 'scripts/verify-container-package-targets.js');

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
const anonymousDenial = readRequired(ANONYMOUS_DENIAL, 'helper-free anonymous denial verifier exists');
const helperFreePull = readRequired(HELPER_FREE_PULL, 'helper-free authenticated digest puller exists');
const firstCreationGate = readRequired(FIRST_CREATION_GATE, 'owner-confirmed first-creation gate exists');
const packageTargetGate = readRequired(PACKAGE_TARGET_GATE, 'fresh replacement package target gate exists');

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
    ['wh-staff-api', 'wh-staff-api-private', './Dockerfile', '.'],
    ['sunset-staff-api', 'sunset-staff-api-private', './Dockerfile.luna-sunset-staff-api', '.'],
    ['crowsnest', 'crowsnest-private', './Dockerfile.crowsnest', '.'],
    ['wh-hermes-staging', 'wh-hermes-staging-private', 'docker/hermes-staging/Dockerfile', 'docker/hermes-staging'],
  ];
  for (const [name, packageName, dockerfile, context] of expected) {
    const block = new RegExp(`name:\\s*${name}[\\s\\S]{0,350}?package:\\s*${packageName}[\\s\\S]{0,350}?image:\\s*ghcr\\.io\\/tywoods\\/${packageName}[\\s\\S]{0,350}?dockerfile:\\s*${dockerfile.replace('.', '\\.') }[\\s\\S]{0,350}?context:\\s*${context === '.' ? '\\.' : context.replaceAll('/', '\\/')}\\s*(?:\\n|$)`);
    check(`publish matrix binds ${name} to fresh target`, block.test(workflow));
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
  check('first creation requires exact owner-supplied package JSON', /owner_approved_new_packages_json/.test(workflow) && /DISPATCH_ACTOR/.test(workflow) && /REPOSITORY_OWNER/.test(workflow) && /verify-first-package-creation\.js/.test(workflow));
  check('replacement targets are validated before publish', /validate:[\s\S]*?verify-container-package-targets\.js[\s\S]*?publish:/m.test(workflow));
  check('privacy metadata uses actual target package', /PACKAGE_NAME:\s*\$\{\{\s*matrix\.package\s*\}\}/.test(workflow) && !/PACKAGE_NAME:\s*\$\{\{\s*matrix\.name\s*\}\}/.test(workflow));
  check('missing package has no blanket safe exception', !/: # .*new package/i.test(workflow));
  check('publisher stops remaining matrix items after a privacy failure', /publish:[\s\S]*?strategy:\s*\n\s*fail-fast:\s*true[\s\S]*?matrix:/m.test(workflow));
  check('pushed package must be private before attestation', /id:\s*build[\s\S]*?visibility == ["']private["'][\s\S]*?verify-ghcr-anonymous-denial\.py[\s\S]*?Attest registry digest/m.test(workflow));
  check('complete anonymous challenge flow checks the exact pushed digest', /verify-ghcr-anonymous-denial\.py[\s\S]*?\$\{\{\s*matrix\.image\s*\}\}[\s\S]*?\$\{\{\s*steps\.build\.outputs\.digest\s*\}\}/m.test(workflow));

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

if (anonymousDenial) {
  check('anonymous verifier does not invoke Docker', !/(?:^|[\s'"`/])docker(?:\s|$)/im.test(anonymousDenial));
  check('anonymous verifier cannot invoke credential helpers', !/subprocess|os\.system|popen|exec[lvpe]*\s*\(/i.test(anonymousDenial));
  check('anonymous verifier performs a bearer challenge exchange', /www-authenticate/i.test(anonymousDenial) && /bearer/i.test(anonymousDenial));
  check('anonymous verifier binds exact GHCR issuer', /https:\/\/ghcr\.io\/token/.test(anonymousDenial) && /expected_service = ["']ghcr\.io["']/.test(anonymousDenial));
  check('anonymous verifier disables redirects', /NoRedirect/.test(anonymousDenial));
  check('anonymous verifier accepts bound token endpoint denial', /token_status in \{401, 403\}/.test(anonymousDenial));
  check('anonymous verifier classifies registry authorization denials', /require_registry_authorization_denial/.test(anonymousDenial) && /DENIED/.test(anonymousDenial) && /UNAUTHORIZED/.test(anonymousDenial));
  check('anonymous verifier accepts only authorization denial', /401/.test(anonymousDenial) && /403/.test(anonymousDenial) && /unexpected/i.test(anonymousDenial));
}

if (helperFreePull) {
  check('authenticated puller does not invoke Docker', !/(?:^|[\s'"`/])docker(?:\s|$)/im.test(helperFreePull));
  check('authenticated puller cannot invoke credential helpers', !/subprocess|os\.system|popen|exec[lvpe]*\s*\(/i.test(helperFreePull));
  check('authenticated puller reads the token without echo', /getpass\.getpass/.test(helperFreePull) && /GetPassWarning/.test(helperFreePull));
  check('authenticated puller binds exact GHCR issuer', /GHCR_REALM = ["']https:\/\/ghcr\.io\/token["']/.test(helperFreePull) && /GHCR_SERVICE = ["']ghcr\.io["']/.test(helperFreePull));
  check('authenticated puller disables credential-bearing redirects', /NoRedirect/.test(helperFreePull));
  check('authenticated puller follows only safe credential-free blob redirects', /blob_get_with_safe_redirects/.test(helperFreePull) && /parsed\.scheme != ["']https["']/.test(helperFreePull) && /key\.lower\(\) != ["']authorization["']/.test(helperFreePull));
  check('authenticated puller verifies every downloaded digest', /verify_digest\(data,/.test(helperFreePull));
  check('authenticated puller uses response mediaType and validates structure', /response_media_type/.test(helperFreePull) && /malformed OCI index structure/.test(helperFreePull));
  check('authenticated puller validates repeated descriptors before deduplication', /seen_manifests\[manifest_digest\]/.test(helperFreePull) && /seen_blobs\[blob_digest\]/.test(helperFreePull) && /conflicting repeated/.test(helperFreePull));
  check('authenticated puller guarantees temporary byte cleanup', /TemporaryDirectory/.test(helperFreePull) && /cleanup_signal_handlers/.test(helperFreePull));
}

if (firstCreationGate) {
  check('first-creation gate requires repository owner identity', /actor !== owner/.test(firstCreationGate));
  check('first-creation gate requires exact package membership', /names\.includes\(packageName\)/.test(firstCreationGate));
  check('first-creation gate rejects duplicate names', /new Set\(names\)\.size !== names\.length/.test(firstCreationGate));
  check('first-creation gate rejects malformed names', /\^\[a-z0-9\]\[a-z0-9\._-\]\*\$/.test(firstCreationGate));
}

if (packageTargetGate) {
  check('replacement target gate pins approved private map', /wh-staff-api-private/.test(packageTargetGate) && /sunset-staff-api-private/.test(packageTargetGate) && /crowsnest-private/.test(packageTargetGate) && /wh-hermes-staging-private/.test(packageTargetGate));
  check('replacement target gate requires exact mapped names', /name !== approvedTargets\[index\]/.test(packageTargetGate));
  check('replacement target approvals exactly match targets', /approvals\.length !== targets\.length/.test(packageTargetGate) && /targets\.some/.test(packageTargetGate));
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
