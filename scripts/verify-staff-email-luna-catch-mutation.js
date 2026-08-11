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
const safeParsedUnknown = "if(outcomeUnknown){st.approvalId=null;st.savedText='';st.generationUncertain=true;}\n    if(selectedConvId!==snapConv)return;";
const staleParsedUnknown = "if(selectedConvId!==snapConv)return;\n    if(outcomeUnknown){st.approvalId=null;st.savedText='';st.generationUncertain=true;}";
const parseFailureUnknown = "var outcomeUnknown=!out.parseOk||(out.status===503&&emailOwnData(out.data,'error')==='draft_save_outcome_unknown');";
const parseFailureUnlock = "var outcomeUnknown=out.status===503&&out.parseOk&&emailOwnData(out.data,'error')==='draft_save_outcome_unknown';";

const original = fs.readFileSync(staff, 'utf8');
assert.equal(original.split(unsafeSelectionGuard).length - 1, 1, 'expected one Luna catch-path stale-selection safety target');
assert.equal(original.split(safeParsedUnknown).length - 1, 1, 'expected one Luna parsed-outcome stale-selection safety target');
assert.equal(original.split(parseFailureUnknown).length - 1, 1, 'expected one Luna parse-failure outcome-uncertain target');
try {
  for (const [label, mutant, evidence] of [
    ['catch-path', original.replace(unsafeSelectionGuard, movedBehindSelectionGuard), /fetch rejection stale completion clears|Timeout/i],
    ['parsed-503', original.replace(safeParsedUnknown, staleParsedUnknown), /parsed 503 outcome unknown stale completion clears|Timeout/i],
    ['parse-failure-unlock', original.replace(parseFailureUnknown, parseFailureUnlock), /malformed response after dispatch|Timeout/i],
  ]) {
    fs.writeFileSync(staff, mutant);
    const killed = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8', timeout: 180000 });
    assert.notEqual(killed.status, 0, label + ' selected-conversation early-return mutant survived cooked UI verifier');
    assert.match((killed.stdout || '') + (killed.stderr || ''), evidence, label + ' mutant failed for an unrelated reason');
    console.log('PASS ' + label + ' selected-conversation early-return mutant killed by cooked stale-selection behavior');
  }
} finally {
  fs.writeFileSync(staff, original);
}
