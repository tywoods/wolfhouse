'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const owner = path.join(__dirname, 'lib/staff-email-luna-draft-route.js');
const verifier = path.join(__dirname, 'verify-staff-email-luna-draft-route.js');
const original = fs.readFileSync(owner, 'utf8');
const target = `return deps.sendJSON(res, 503, freeze({ success: false,
      error: EMAIL_LUNA_GENERATION_UNAVAILABLE_ERROR,
      reason: EMAIL_LUNA_GENERATION_UNAVAILABLE_REASON }));`;
assert.equal(original.split(target).length - 1, 1, 'expected one fail-closed unavailable boundary');
const mutants = [
  ['runtime escape', `deps.createLunaRuntime({ authority: context.authority });\n    ${target}`],
  ['wrong status', target.replace('503', '200')],
  ['missing reason', target.replace(',\n      reason: EMAIL_LUNA_GENERATION_UNAVAILABLE_REASON', '')],
];
try {
  for (const [label, replacement] of mutants) {
    fs.writeFileSync(owner, original.replace(target, replacement));
    const killed = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8', timeout: 180000 });
    assert.notEqual(killed.status, 0, `${label} mutant survived route verifier`);
    console.log(`PASS ${label} unavailable-boundary mutant killed`);
  }
} finally {
  fs.writeFileSync(owner, original);
}
