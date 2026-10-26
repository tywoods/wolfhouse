#!/usr/bin/env node
'use strict';
// Owner execution adapter. In server mode receipts are opaque, one-use records
// held only in this process. No signing key or registry is available to fixture
// authors, and verification recomputes Staff normalization before consuming it.
const { normalizeQuoteRequest } = require('./staff-request-contract');
const crypto = require('node:crypto');
function catalogFromChoices(choices) {
  return {items:(choices || []).filter(x => x && x.active === true).map(x => ({
    item_type:x.kind === 'accommodation' || x.kind === 'package' ? 'package' : x.kind,
    item_code:x.code, label:x.label || x.name || x.code, active:true, metadata:x.metadata || {}
  }))};
}
function execute(payload) {
  const input=payload.input;
  const beds=(input && Array.isArray(input.guests)) ? input.guests.map((_,i)=>`fixture-bed-${i+1}`) : [];
  return normalizeQuoteRequest(input,catalogFromChoices(payload.choices),beds,{sessionId:'fixture-owner',turnId:payload.turn_id || 'fixture'});
}
const stable = value => JSON.stringify(value, Object.keys(value || {}).sort());
const same = (a,b) => stable(a) === stable(b);
const registry = new Map();
function issue(payload) {
  const result=execute(payload);
  const receipt_id=crypto.randomBytes(32).toString('hex');
  const record={schema:'staff-owner-execution/v2',receipt_id,nonce:crypto.randomBytes(24).toString('hex'),executed_at:new Date().toISOString(),revision:payload.revision,case_id:payload.case_id,prompt:payload.prompt,control:payload.control,outcome:payload.outcome,input:payload.input,result};
  registry.set(receipt_id,record);
  return record;
}
function verify(payload) {
  const receipt=payload.receipt || {}; const record=registry.get(receipt.receipt_id);
  if (!record || !same(record,receipt)) return {ok:false,code:'unknown_or_altered_receipt'};
  const expected={revision:payload.revision,case_id:payload.case_id,prompt:payload.prompt,control:payload.control,outcome:payload.outcome,input:payload.input};
  if (!Object.entries(expected).every(([k,v])=>same(record[k],v))) return {ok:false,code:'proposition_mismatch'};
  if (!same(record.result,execute(payload))) return {ok:false,code:'execution_mismatch'};
  registry.delete(receipt.receipt_id);
  return {ok:true,result:record.result,executed_at:record.executed_at,nonce:record.nonce};
}
function handle(payload) {
  if(payload.command==='normalize') return execute(payload);
  if(payload.command==='issue') return issue(payload);
  if(payload.command==='verify') return verify(payload);
  throw new Error('unknown command');
}
if (process.argv.includes('--server')) {
  const readline=require('node:readline').createInterface({input:process.stdin,crlfDelay:Infinity});
  readline.on('line',line=>{ try { process.stdout.write(JSON.stringify(handle(JSON.parse(line)))+'\n'); } catch(e) { process.stdout.write(JSON.stringify({ok:false,code:'adapter_error',error:String(e.message)})+'\n'); } });
} else {
  const payload=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
  process.stdout.write(JSON.stringify(handle(payload)));
}
