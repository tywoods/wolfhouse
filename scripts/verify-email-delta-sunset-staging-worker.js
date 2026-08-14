'use strict';
const assert = require('node:assert/strict');
const { createEmailDeltaSunsetStagingWorker, ACTIVATION_BOUNDARY_SQL } = require('./lib/email-delta-sunset-staging-worker');
const U={clientId:'11111111-1111-4111-8111-111111111111',locationId:'22222222-2222-4222-8222-222222222222',endpointId:'33333333-3333-4333-8333-333333333333'};
const tests=[]; const test=(n,f)=>tests.push([n,f]);
function harness(rows=[{client_id:U.clientId,location_id:U.locationId,endpoint_id:U.endpointId}]){
 const calls={queries:[],pages:[],projects:[],set:[],clear:[]}; let resolvePage;
 const deps={
  query:async(sql)=>{calls.queries.push(sql); if(sql.includes('tenant_channel_endpoints'))return {rows}; if(sql.includes('activation_boundaries'))return {rows:[{activation_watermark:'2026-08-14T12:00:00.000Z'}]}; return {rows:[{id:'44444444-4444-4444-8444-444444444444'}]};},
  runPage:async(i)=>{calls.pages.push(i); return new Promise(r=>{resolvePage=r;});},
  projectEvent:async(i)=>{calls.projects.push(i); return {status:'projected'};},
  timers:{setTimeout(fn,ms){calls.set.push(ms);return {fn};},clearTimeout(h){calls.clear.push(h);}},
  intervalMs:60000,
 }; return {calls,worker:createEmailDeltaSunsetStagingWorker(deps),finish:()=>resolvePage&&resolvePage({status:'committed'})};
}
test('one eligible verified inbound-only Microsoft endpoint; one page and unprojected bridge drain',async()=>{const h=harness();const p=h.worker.tick(); await new Promise(r=>setImmediate(r));h.finish();const out=await p;assert.equal(out.status,'completed');assert.equal(h.calls.pages.length,1);assert.equal(h.calls.projects.length,1);const q=h.calls.queries[0];for(const pin of ["provider = 'microsoft_graph'","binding_status = 'verified'",'inbound_enabled = true','outbound_enabled = false','revoked_at IS NULL','grant_lease_until']) assert.match(q,new RegExp(pin.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));});
test('refuses zero or multiple eligible endpoints',async()=>{for(const rows of [[],[{},{}]]){const h=harness(rows);const out=await h.worker.tick();assert.equal(out.status,'ineligible');assert.equal(h.calls.pages.length,0);}});
test('no overlapping ticks',async()=>{const h=harness();const a=h.worker.tick();await new Promise(r=>setImmediate(r));const b=await h.worker.tick();assert.equal(b.status,'overlap_skipped');h.finish();await a;assert.equal(h.calls.pages.length,1);});
test('scheduler stays one-shot, bounds 60-120s, and stop clears timer',async()=>{const h=harness();h.worker.start();assert.deepEqual(h.calls.set,[60000]);h.worker.stop();assert.equal(h.calls.clear.length,1);});
test('durable boundary insert is visible on its first statement and reused thereafter',()=>{assert.match(ACTIVATION_BOUNDARY_SQL,/RETURNING activation_watermark/);assert.match(ACTIVATION_BOUNDARY_SQL,/UNION ALL/);assert.match(ACTIVATION_BOUNDARY_SQL,/NOT EXISTS \(SELECT 1 FROM initialized\)/);});
test('interval outside bound rejected',()=>{for(const intervalMs of [59999,120001])assert.throws(()=>createEmailDeltaSunsetStagingWorker({...harness().worker,intervalMs}));});
(async()=>{let pass=0;for(const [n,f] of tests){try{await f();console.log('PASS',n);pass++;}catch(e){console.error('FAIL',n,e);process.exitCode=1;}}console.log(`${pass}/${tests.length} passed`);})();
