'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const requiredCopy = 'COPY docker/hermes-staging/wolfhouse/guest_copy.json ./docker/hermes-staging/wolfhouse/guest_copy.json';

if (!dockerfile.includes(requiredCopy)) {
  throw new Error(`root Staff Dockerfile must package runtime guest copy catalog: ${requiredCopy}`);
}

const catalogSource = fs.readFileSync(path.join(root, 'scripts/lib/luna-guest-copy-catalog.js'), 'utf8');
if (!catalogSource.includes("../../docker/hermes-staging/wolfhouse/guest_copy.json")) {
  throw new Error('verifier assumption drift: Staff runtime catalog path changed');
}

console.log('PASS root Staff image packages Luna guest copy runtime catalog');
