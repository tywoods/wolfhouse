#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const gate = path.join(__dirname, 'verify-container-package-targets.js');
const fresh = {
  WH_STAFF_PACKAGE: 'wh-staff-api-private',
  SUNSET_STAFF_PACKAGE: 'sunset-staff-api-private',
  CROWSNEST_PACKAGE: 'crowsnest-private',
  WH_HERMES_PACKAGE: 'wh-hermes-staging-private',
};
const approvals = JSON.stringify(Object.values(fresh));

function run(overrides = {}) {
  return spawnSync(process.execPath, [gate], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      DISPATCH_ACTOR: 'tywoods',
      REPOSITORY_OWNER: 'tywoods',
      NEW_PACKAGES_JSON: approvals,
      ...fresh,
      ...overrides,
    },
  });
}

const cases = [
  ['four distinct fresh targets with exact approval pass', {}, 0],
  ['original public package name fails', { WH_STAFF_PACKAGE: 'wh-staff-api', NEW_PACKAGES_JSON: JSON.stringify(['wh-staff-api', fresh.SUNSET_STAFF_PACKAGE, fresh.CROWSNEST_PACKAGE, fresh.WH_HERMES_PACKAGE]) }, 1],
  ['unapproved alternate fresh name fails', { WH_STAFF_PACKAGE: 'wh-staff-api-private-v2', NEW_PACKAGES_JSON: JSON.stringify(['wh-staff-api-private-v2', fresh.SUNSET_STAFF_PACKAGE, fresh.CROWSNEST_PACKAGE, fresh.WH_HERMES_PACKAGE]) }, 1],
  ['duplicate target fails', { WH_STAFF_PACKAGE: fresh.SUNSET_STAFF_PACKAGE }, 1],
  ['approval with missing target fails', { NEW_PACKAGES_JSON: JSON.stringify(Object.values(fresh).slice(0, 3)) }, 1],
  ['approval with extra target fails', { NEW_PACKAGES_JSON: JSON.stringify([...Object.values(fresh), 'extra-private-v2']) }, 1],
  ['non-owner dispatch fails', { DISPATCH_ACTOR: 'delegate' }, 1],
];

for (const [name, overrides, expected] of cases) {
  const result = run(overrides);
  assert.equal(result.status, expected, `${name}: stdout=${result.stdout} stderr=${result.stderr}`);
  console.log(`PASS ${name}`);
}
console.log(`\nreplacement-target gate checks: ${cases.length} passed, 0 failed`);
