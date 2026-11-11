'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  classifyChangedImages,
  canSkipInImageTests,
  STAFF_IMAGE,
  LUNA_IMAGE,
  isProdComposePath,
} = require('./lib/france-staging-changed-images');

assert.deepEqual(
  classifyChangedImages(['scripts/lib/luna-guest-handoff-warm-note.js']),
  { staff: true, luna: false },
);
assert.deepEqual(
  classifyChangedImages(['docker/hermes-staging/wolfhouse/accepted_quote.py']),
  { staff: false, luna: true },
);
assert.deepEqual(
  classifyChangedImages(['Dockerfile', 'package-lock.json']),
  { staff: true, luna: false },
);
assert.deepEqual(
  classifyChangedImages(['docker/hermes-staging/Dockerfile']),
  { staff: false, luna: true },
);
assert.deepEqual(
  classifyChangedImages(['docs/FOO.md', 'README.md']),
  { staff: false, luna: false },
);
assert.deepEqual(
  classifyChangedImages([
    'scripts/staff-query-api.js',
    'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py',
  ]),
  { staff: true, luna: true },
);

assert.equal(STAFF_IMAGE, 'luna-local/wh-staff-api');
assert.equal(LUNA_IMAGE, 'luna-local/wh-hermes-staging');

assert.equal(isProdComposePath('/opt/wolfhouse-prod/release/deploy/wolfhouse-prod/compose.yaml'), true);
assert.equal(isProdComposePath('/srv/staff/compose/compose.yml'), false);
assert.equal(isProdComposePath('/srv/luna/wolfhouse/config/compose.yml'), false);

assert.equal(canSkipInImageTests({ githubChecksPassed: true, commitSha: 'abc', checkedSha: 'abc' }), true);
assert.equal(canSkipInImageTests({ githubChecksPassed: true, commitSha: 'abc', checkedSha: 'def' }), false);
assert.equal(canSkipInImageTests({ githubChecksPassed: false, commitSha: 'abc', checkedSha: 'abc' }), false);
assert.equal(canSkipInImageTests({}), false);

const lunaDocker = fs.readFileSync(
  path.join(__dirname, '..', 'docker', 'hermes-staging', 'Dockerfile'),
  'utf8',
);
assert.match(lunaDocker, /ARG SKIP_IN_IMAGE_TESTS=/);
assert.match(lunaDocker, /SKIP_IN_IMAGE_TESTS/);
assert.match(lunaDocker, /python -m unittest/);

const staffDocker = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
assert.match(staffDocker, /COPY package\*\.json/);
assert.ok(
  staffDocker.indexOf('COPY package') < staffDocker.indexOf('RUN npm ci'),
  'staff deps before npm ci',
);
assert.ok(
  staffDocker.indexOf('RUN npm ci') < staffDocker.indexOf('COPY scripts'),
  'staff npm ci before code copy',
);

console.log('verify-france-staging-fast-deploy: PASS');
