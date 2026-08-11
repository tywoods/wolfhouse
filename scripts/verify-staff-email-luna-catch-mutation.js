'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const staff = path.join(root, 'scripts/staff-query-api.js');
const verifier = path.join(root, 'scripts/verify-staff-email-inbox-ui.js');
const unsafeSelectionGuard = 'st.inFlight=false;st.approvalId=null;st.savedText=\'\';st.generationUncertain=true;if(selectedConvId!==snapConv)return;';
const movedBehindSelectionGuard = 'st.inFlight=false;if(selectedConvId!==snapConv)return;st.approvalId=null;st.savedText=\'\';st.generationUncertain=true;';

const original = fs.readFileSync(staff, 'utf8');
assert.equal(original.split(unsafeSelectionGuard).length - 1, 1, 'expected one Luna catch-path stale-selection safety target');
try {
  fs.writeFileSync(staff, original.replace(unsafeSelectionGuard, movedBehindSelectionGuard));
  const killed = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8', timeout: 180000 });
  assert.notEqual(killed.status, 0, 'catch-path unlock mutant survived cooked UI verifier');
  assert.match((killed.stdout || '') + (killed.stderr || ''), /stale completion clears authority|Timeout|fetch rejection/i,
    'mutant failed for an unrelated reason');
  console.log('PASS catch-path selected-conversation early-return mutant killed by cooked stale-selection behavior');
} finally {
  fs.writeFileSync(staff, original);
}
