#!/usr/bin/env node
'use strict';

const actor = process.env.DISPATCH_ACTOR || '';
const owner = process.env.REPOSITORY_OWNER || '';
const rawApprovals = process.env.NEW_PACKAGES_JSON || '';
const targets = [
  process.env.WH_STAFF_PACKAGE || '',
  process.env.SUNSET_STAFF_PACKAGE || '',
  process.env.CROWSNEST_PACKAGE || '',
  process.env.WH_HERMES_PACKAGE || '',
];
const approvedTargets = [
  'wh-staff-api-private',
  'sunset-staff-api-private',
  'crowsnest-private',
  'wh-hermes-staging-private',
];
const validName = /^[a-z0-9][a-z0-9._-]*$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!actor || actor !== owner) fail('Only the repository owner may approve replacement package targets');
if (targets.some((name) => !validName.test(name))) fail('Every replacement package target must be a valid non-empty package name');
if (targets.some((name, index) => name !== approvedTargets[index])) fail('Workflow targets must exactly match the approved four-package replacement map');
if (new Set(targets).size !== targets.length) fail('Replacement package targets must be distinct');

let approvals;
try {
  approvals = JSON.parse(rawApprovals);
} catch {
  fail('Replacement package approvals must be valid JSON');
}
if (!Array.isArray(approvals) || approvals.some((name) => typeof name !== 'string' || !validName.test(name))) {
  fail('Replacement package approvals must be an array of valid package names');
}
if (new Set(approvals).size !== approvals.length) fail('Replacement package approvals must not contain duplicates');
if (approvals.length !== targets.length || targets.some((name) => !approvals.includes(name))) {
  fail('Owner approvals must exactly equal the four replacement package targets');
}

console.log(`Owner approved four fresh replacement package targets: ${targets.join(', ')}`);
