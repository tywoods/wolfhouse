'use strict'; const fs=require('fs'),crypto=require('crypto');
function fail(x){throw Error(x)}
function backupPlan(x){if(!x||x.cadence!=='nightly'||x.encryption!=='required'||x.maxConcurrent!==1||!Number.isInteger(x.maxSpoolBytes)||x.maxSpoolBytes<=0||!/^azure:/.test(x.offHostDestination)||/^file:/.test(x.offHostDestination))fail('invalid_backup_plan');return Object.freeze(x)}
function artifactReceipt(path,expectedSha){if(!path||!expectedSha||!fs.existsSync(path))fail('backup_readback_failed');const data=fs.readFileSync(path);if(!data.length||crypto.createHash('sha256').update(data).digest('hex')!==expectedSha)fail('backup_readback_failed');return {bytes:data.length,sha256:expectedSha}}
function verifyOffHostReadback(r){return artifactReceipt(r&&r.path,r&&r.sha256)}
module.exports={backupPlan,artifactReceipt,verifyOffHostReadback};
