#!/usr/bin/env node
'use strict';
/* Staff-owner fixture receipt boundary.
 * `generate` is an explicit owner-authoring operation and requires an issuer key.
 * Matrix admission exposes only `verify` and a verifier key. Receipts are immutable,
 * reusable evidence (the matrix intentionally runs each fixture three times).
 */
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
function canonical(v) {
  if (Array.isArray(v)) return '['+v.map(canonical).join(',')+']';
  if (v && typeof v === 'object') return '{'+Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
  return JSON.stringify(v);
}
const same=(a,b)=>canonical(a)===canonical(b);
function key(name) {
  const value=process.env[name];
  if (!value || value.length < 32) throw new Error(`${name} is required (minimum 32 bytes)`);
  return value;
}
function mac(record,k) { return crypto.createHmac('sha256',k).update(canonical(record)).digest('hex'); }
function normalizedValue(result) {
  if (!result || result.ok !== true || !result.value || typeof result.value !== 'object') return null;
  const value=JSON.parse(JSON.stringify(result.value)); delete value.operation_key; return value;
}
function code(v) { return typeof v === 'string' ? v : v && (v.code || v.name); }
function reconcile(outcome,result) {
  if (!outcome || typeof outcome !== 'object') return false;
  const value=normalizedValue(result);
  if (!value) return outcome.expect === 'refusal' || outcome.expect === 'clarification';
  if (!['quote','mixed','uncertain','refusal'].includes(outcome.expect)) return false;
  // Fault/refusal rows bind the normalized owner request; the quote boundary supplies the later failure.
  if (outcome.expect === 'uncertain' || outcome.expect === 'refusal') return true;
  const facts=outcome.facts;
  if (!facts || facts.check_in !== value.check_in || facts.check_out !== value.check_out) return false;
  const expectedPackages=(facts.package && Array.isArray(facts.package.per_guest)) ? facts.package.per_guest.map(x=>code(x)).sort() : [code(facts.package)];
  const actualPackages=Array.isArray(value.guest_packages) ? value.guest_packages.map(x=>x.package_code).sort() : [value.package_id || code(value.package)];
  if (!same(expectedPackages,actualPackages)) return false;
  const normAddon=x=>({code:code(x),quantity:x.quantity,dates:(x.dates||x.requested_dates||[]).slice().sort(),people:(x.people||x.participants||[]).slice().sort()});
  return same((facts.add_ons||[]).map(normAddon).sort((a,b)=>canonical(a).localeCompare(canonical(b))),
              (value.add_ons||[]).map(normAddon).sort((a,b)=>canonical(a).localeCompare(canonical(b))));
}
function proposition(payload) {
  return {revision:payload.revision,case_id:payload.case_id,prompt:payload.prompt,control:payload.control,
    outcome:payload.outcome,correction_prompt:payload.correction_prompt || null,
    corrected_control:payload.corrected_control || null,corrected_outcome:payload.corrected_outcome || null,
    input:payload.input,choices:payload.choices,turn_id:payload.turn_id || 'fixture-admission'};
}
function generate(payload) {
  const p=proposition(payload), result=execute(p);
  if (!reconcile(p.outcome,result)) throw new Error('declared outcome does not reconcile with Staff normalized result');
  const executed_at=payload.executed_at || new Date().toISOString();
  if (Number.isNaN(Date.parse(executed_at))) throw new Error('valid executed_at required');
  const record={schema:'staff-owner-execution/v3',executed_at,proposition:p,result};
  return {...record,signature:mac(record,key('LUNA_OWNER_RECEIPT_ISSUER_KEY'))};
}
function verify(payload) {
  const receipt=payload.receipt || {}, {signature,...record}=receipt;
  if (record.schema !== 'staff-owner-execution/v3' || typeof signature !== 'string') return {ok:false,code:'malformed_receipt'};
  const expected=mac(record,key('LUNA_OWNER_RECEIPT_VERIFIER_KEY'));
  if (signature.length!==expected.length || !crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) return {ok:false,code:'bad_signature'};
  const current=proposition(payload), signed=record.proposition;
  for (const field of ['revision','case_id','prompt','control','outcome','correction_prompt','corrected_control','corrected_outcome','input','turn_id'])
    if (!same(signed[field],current[field])) return {ok:false,code:'proposition_mismatch'};
  if (!same(record.result,execute(signed)) || !same(record.result,execute(current)) || !reconcile(signed.outcome,record.result)) return {ok:false,code:'execution_or_outcome_mismatch'};
  return {ok:true,result:record.result,executed_at:record.executed_at};
}
function handle(payload) {
  if(payload.command==='normalize') return execute(payload);
  if(payload.command==='generate') return generate(payload);
  if(payload.command==='verify') return verify(payload);
  throw new Error('unknown command');
}
if (process.argv.includes('--server')) {
  const readline=require('node:readline').createInterface({input:process.stdin,crlfDelay:Infinity});
  readline.on('line',line=>{ try { process.stdout.write(JSON.stringify(handle(JSON.parse(line)))+'\n'); } catch(e) { process.stdout.write(JSON.stringify({ok:false,code:'adapter_error',error:String(e.message)})+'\n'); } });
} else {
  try { const payload=JSON.parse(require('node:fs').readFileSync(0,'utf8')); process.stdout.write(JSON.stringify(handle(payload))); }
  catch(e) { process.stderr.write(String(e.message)+'\n'); process.exit(1); }
}
