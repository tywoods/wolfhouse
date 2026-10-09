#!/usr/bin/env node
'use strict';

const actor = process.env.DISPATCH_ACTOR || '';
const owner = process.env.REPOSITORY_OWNER || '';
const packageName = process.env.PACKAGE_NAME || '';
const raw = process.env.NEW_PACKAGES_JSON || '';

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!actor || actor !== owner) {
  fail('Only the repository owner may approve first creation');
}
if (!/^[a-z0-9][a-z0-9._-]*$/.test(packageName)) {
  fail('Package name is missing or malformed');
}

let names;
try {
  names = JSON.parse(raw);
} catch {
  fail('First-creation approval must be valid JSON');
}
if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(name))) {
  fail('First-creation approval must be an array of valid package names');
}
if (new Set(names).size !== names.length) {
  fail('First-creation approval contains duplicate package names');
}
if (!names.includes(packageName)) {
  fail(`Missing exact owner approval for first creation of ${packageName}`);
}

console.log(`Owner approved first creation of ${packageName}`);
