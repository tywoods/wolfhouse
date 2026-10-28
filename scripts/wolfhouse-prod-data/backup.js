'use strict';
function fail(code){ const error=new Error(code); error.code=code; throw error; }
function backupPlan(input){
  if (!input || input.cadence !== 'nightly' || input.encryption !== 'required' || !Number.isInteger(input.maxConcurrent) || input.maxConcurrent !== 1 || !Number.isInteger(input.maxSpoolBytes) || input.maxSpoolBytes <= 0 || !input.offHostDestination) fail('invalid_backup_plan');
  return Object.freeze({cadence:'nightly', encryption:'required', maxConcurrent:1, maxSpoolBytes:input.maxSpoolBytes, offHostDestination:input.offHostDestination});
}
function verifyOffHostReadback(receipt){ if (!receipt || receipt.encrypted !== true || receipt.readback !== true || !receipt.artifactId) fail('backup_readback_failed'); return true; }
module.exports={backupPlan,verifyOffHostReadback};
