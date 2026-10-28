const test=require('node:test');
const assert=require('node:assert/strict');
const c=require('./contract');
const b=require('./backup');

test('allowlist excludes operational data',()=>{
  assert(!c.ALLOWLIST.includes('bookings'));
  assert.throws(()=>c.snapshot({schema:['bookings'],tables:{bookings:[]}}),/forbidden_import_table/);
});
test('unknown schema fails closed',()=>assert.throws(()=>c.schema(['mystery']),/unknown_table/));
test('wrong production target fails closed',()=>assert.throws(()=>c.target({host:'178.33.91.59',database:'test'}),/invalid_prod_target_identity/));
test('complete declared production identity passes',()=>assert.doesNotThrow(()=>c.target({host:'178.33.91.59',database:'wolfhouse_prod',mounts:{data:'/prod/data',backupSpool:'/prod/spool'},backupDestination:'azure://prod'})));
test('backup requires nightly encryption, a bounded spool, single concurrency, and off-host target',()=>{
  assert.throws(()=>b.backupPlan({cadence:'hourly',encryption:'required',maxConcurrent:1,maxSpoolBytes:1,offHostDestination:'azure://prod'}),/invalid_backup_plan/);
  assert.deepEqual(b.backupPlan({cadence:'nightly',encryption:'required',maxConcurrent:1,maxSpoolBytes:1024,offHostDestination:'azure://prod'}).maxConcurrent,1);
  assert.throws(()=>b.verifyOffHostReadback({encrypted:true,readback:false,artifactId:'x'}),/backup_readback_failed/);
});
