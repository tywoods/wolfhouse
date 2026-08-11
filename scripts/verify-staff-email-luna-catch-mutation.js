'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const staff = path.join(root, 'scripts/staff-query-api.js');
const verifier = path.join(root, 'scripts/verify-staff-email-inbox-ui.js');
const safeCatch = "}).catch(function(){if(mySeq!==st.seq)return;st.inFlight=false;if(selectedConvId!==snapConv)return;st.approvalId=null;st.savedText='';st.generationUncertain=true;showDraftSendStatus(statusEl,'blocked','Draft save outcome is unknown. Reload the conversation or page before generating again.');setEmailReplyControlsDisabled(targetEl,true,st.locked);});";
const unsafeCatch = "}).catch(function(){if(mySeq!==st.seq)return;st.inFlight=false;if(selectedConvId===snapConv)showDraftSendStatus(statusEl,'error','Could not generate Luna draft.');setEmailReplyControlsDisabled(targetEl,false,st.locked);});";

const original = fs.readFileSync(staff, 'utf8');
assert.equal(original.split(safeCatch).length - 1, 1, 'expected one Luna catch-path lock target');
try {
  fs.writeFileSync(staff, original.replace(safeCatch, unsafeCatch));
  const killed = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8', timeout: 180000 });
  assert.notEqual(killed.status, 0, 'catch-path unlock mutant survived cooked UI verifier');
  assert.match((killed.stdout || '') + (killed.stderr || ''), /outcome is unknown|Timeout|dispatched fetch rejection/i,
    'mutant failed for an unrelated reason');
  console.log('PASS catch-path unlock mutant killed by cooked dispatched-rejection behavior');
} finally {
  fs.writeFileSync(staff, original);
}
