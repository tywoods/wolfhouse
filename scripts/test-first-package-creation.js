#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const gate = path.join(__dirname, 'verify-first-package-creation.js');

function run(overrides = {}) {
  return spawnSync(process.execPath, [gate], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      DISPATCH_ACTOR: 'tywoods',
      REPOSITORY_OWNER: 'tywoods',
      PACKAGE_NAME: 'wolfhouse-staff-private-v1',
      NEW_PACKAGES_JSON: '["wolfhouse-staff-private-v1"]',
      ...overrides,
    },
  });
}

const cases = [
  ['owner exact approval passes', {}, 0],
  ['non-owner fails', { DISPATCH_ACTOR: 'delegate' }, 1],
  ['missing exact name fails', { NEW_PACKAGES_JSON: '["different-private-name"]' }, 1],
  ['duplicate list fails', { NEW_PACKAGES_JSON: '["wolfhouse-staff-private-v1","wolfhouse-staff-private-v1"]' }, 1],
  ['malformed package in list fails', { NEW_PACKAGES_JSON: '["wolfhouse-staff-private-v1","BAD NAME"]' }, 1],
  ['malformed JSON fails', { NEW_PACKAGES_JSON: '[' }, 1],
  ['non-array JSON fails', { NEW_PACKAGES_JSON: '"wolfhouse-staff-private-v1"' }, 1],
];

for (const [name, overrides, expected] of cases) {
  const result = run(overrides);
  assert.equal(result.status, expected, `${name}: stdout=${result.stdout} stderr=${result.stderr}`);
  console.log(`PASS ${name}`);
}
console.log(`\nfirst-creation gate checks: ${cases.length} passed, 0 failed`);
