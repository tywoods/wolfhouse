'use strict';
/** Verification and deterministic projection only; intentionally NO signing API.
 * v5 authenticates bytes captured by the isolated TEST HTTP runner, not asserted
 * outcomes. The issuer key is an explicit test trust root, not Staff PKI.
 */
const crypto=require('node:crypto');
const {normalizeQuoteRequest}=require('./staff-request-contract');
const SCHEMA='staff-owner-http/v5';
const ADMIT='/staff/bot/luna-v3/admit-simulator-session', PREPARE='/staff/bot/luna-v3/check-quote-book';
const FAULTS=['non-json','malformed','http-422','exception','timeout'];
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v && typeof v==='object'?'{'+Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const same=(a,b)=>canonical(a)===canonical(b);
const sha256=text=>crypto.createHash('sha256').update(text).digest('hex');
const clone=v=>JSON.parse(JSON.stringify(v));
function insist(ok,code){if(!ok)throw new Error(code);}
function choicesForMatrix(choices) {
 return choices.map(x=>({...x,active:x.configuration?x.configuration.active===true:x.active===true}));
}
function publicPrepare(control) {
 const input={action:'prepare',purpose:'quote',...clone(control)};
 if(typeof input.package==='string')input.package={code:input.package};
 return input;
}
function normalize(input,choices,turn='fixture-admission') {
 const items=choicesForMatrix(choices).filter(x=>x.active).map(x=>({item_type:['accommodation','package'].includes(x.kind)?'package':x.kind,item_code:x.code,label:x.label||x.name||x.code,active:true,metadata:x.metadata||{includes:x.includes||[]}}));
 const beds=Array.isArray(input?.guests)?input.guests.map((_,i)=>`fixture-bed-${i+1}`):[];
 const result=normalizeQuoteRequest(input,{items},beds,{sessionId:'fixture-owner',turnId:turn});
 if(result.ok) {
  // Add-on order is not allocation. Keep guest order and package guest numbers.
  result.value.add_ons=result.value.add_ons.map(x=>({...x,...(x.dates?{dates:[...x.dates].sort()}:{}),...(x.people?{people:[...x.people].sort()}: {})})).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
 }
 return result;
}
function requestKey(input,choices) {
 const r=normalize(input,choices);
 if(!r.ok)return {refused_input:input}; // Do not erase invalid quantities or missing fields.
 const value=clone(r.value);delete value.operation_key;
 return {action:input.action,purpose:input.purpose,room:input.room,value};
}
function capture(x,route) {
 insist(x && x.route===route && x.method==='POST','capture_route_mismatch');
 insist(typeof x.request_body==='string' && x.request_sha256===sha256(x.request_body),'request_bytes_mismatch');
 insist(typeof x.body==='string' && x.body_sha256===sha256(x.body),'response_bytes_mismatch');
 const request=JSON.parse(x.request_body),response=JSON.parse(x.body);
 insist(request.external_send_allowed===false && request.staff_alert_allowed===false,'test_fence_missing');
 return {request,response,status:x.status};
}
function deriveExecution(evidence) {
 const a=capture(evidence.admission,ADMIT), p=capture(evidence.prepare,PREPARE);
 const snapshot=a.response.capability_snapshot;
 insist(a.status===200 && a.response.ok===true && a.response.admitted===true && snapshot?.ok===true && snapshot.revision && Array.isArray(snapshot.choices),'admission_missing');
 insist(typeof a.request.session_id==='string' && a.request.session_id.startsWith('luna-v3:') && p.request.session_id===a.request.session_id,'session_mismatch');
 insist(evidence.prepare.headers?.['x-luna-v3-inbound-event']===a.response.inbound_event_id && typeof a.response.inbound_event_id==='string' && a.response.inbound_event_id.length>0,'event_mismatch');
 insist(typeof evidence.prepare.headers?.['x-luna-v3-turn-id']==='string' && evidence.prepare.headers['x-luna-v3-turn-id'].length>=8,'turn_missing');
 const input=clone(p.request);for(const k of ['session_id','external_send_allowed','staff_alert_allowed','tenant_id'])delete input[k];
 insist(input.action==='prepare' && input.purpose==='quote' && !('payment' in input),'quote_only');
 const result=normalize(input,snapshot.choices), r=p.response;
 let outcome;
 if(r.ok===true) {
  insist(p.status===200 && result.ok===true && r.state==='quote' && r.held===false && r.booked===false && r.outcome==='applied','not_successful_quote');
  const q=r.quote;insist(q && typeof q.currency==='string' && ['totalCents','depositCents','remainingCents'].every(k=>Number.isSafeInteger(q[k]) && q[k]>=0) && q.totalCents===q.depositCents+q.remainingCents,'invalid_owner_money');
  insist(Array.isArray(r.guests) && r.guests.length===input.guests.length && Array.isArray(r.add_ons),'invalid_owner_allocations');
  const expectedPackages=result.value.guest_packages || input.guests.map((_,i)=>({guest_number:i+1,package_code:result.value.package_id}));
  const responsePackages=r.guests.map(g=>({guest_number:g.position,package_code:g.package})).sort((a,b)=>a.guest_number-b.guest_number);
  insist(same(expectedPackages,responsePackages) && r.guests.every(g=>g.name===result.value.guests[g.position-1]?.name),'owner_person_mismatch');
  insist(same(expectedPackages,(q.perPerson||[]).map(g=>({guest_number:g.guest_number,package_code:g.package_code})).sort((a,b)=>a.guest_number-b.guest_number)),'owner_price_person_mismatch');
  insist(r.check_in===input.check_in && r.check_out===input.check_out,'owner_dates_mismatch');
  const echoed={...input,add_ons:r.add_ons};insist(same(requestKey(input,snapshot.choices),requestKey(echoed,snapshot.choices)),'owner_addons_mismatch');
  const details=Array.isArray(r.package_details)?r.package_details:r.package_details?[r.package_details]:[];
  insist(details.every(d=>Array.isArray(d.includes||[]) && Array.isArray(d.terms||[])),'invalid_owner_terms');
  outcome={expect:'quote',facts:{currency:q.currency,total_cents:q.totalCents,deposit_cents:q.depositCents,remaining_cents:q.remainingCents,check_in:r.check_in,check_out:r.check_out,
   package:r.guests.length===1?{code:r.guests[0].package}:{per_guest:r.guests.map(g=>({guest:g.position,guest_name:g.name,code:g.package}))},
   add_ons:r.add_ons,inclusions:details.flatMap(d=>d.includes||[]),terms:details.flatMap(d=>d.terms||[])}};
 } else {
  insist(r.ok===false && p.status>=400 && p.status<500 && typeof r.code==='string' && typeof r.classification==='string' && r.outcome==='rejected' && r.retry_allowed===false,'not_owner_refusal');
  outcome={expect:'refusal',classification:r.classification,allowed_reasons:[r.code],next_step:r.next_step};
 }
 return {snapshot,input,result,response:r,outcome,session_id:a.request.session_id,event_id:a.response.inbound_event_id,turn_id:evidence.prepare.headers['x-luna-v3-turn-id'],message_digest:a.request.message_digest};
}
function deriveRecord(record) {
 insist(record.schema===SCHEMA && record.source==='test-staff-http' && !Number.isNaN(Date.parse(record.executed_at)),'unsupported_receipt');
 const execution=deriveExecution(record.evidence), binding=record.binding;
 insist(binding && typeof binding.case_id==='string' && typeof binding.prompt==='string','binding_missing');
 let outcome=execution.outcome;
 if(binding.category==='mixed' && outcome.expect==='quote')outcome={...outcome,expect:'mixed',compatibility_proven:true};
 if(binding.category==='fault') {
  insist(FAULTS.includes(binding.fault) && outcome.expect==='quote','fault_baseline_not_successful');
  outcome={expect:'uncertain'};
 }
 if(binding.category==='clarification') {
  insist(outcome.expect==='refusal' && !execution.result.ok && ['room_required','guests_required','package_choice_required','stay_dates_invalid','add_ons_required'].includes(execution.result.code),'clarification_not_missing_input');
  outcome={expect:'clarification'};
 }
 let corrected=null;
 if(record.correction) {
  corrected=deriveExecution(record.correction);
  insist(binding.category==='continuation' && typeof binding.correction_prompt==='string' && binding.correction_prompt.trim() && execution.outcome.expect==='refusal' && corrected.outcome.expect==='quote','correction_outcome_mismatch');
  insist(execution.session_id===corrected.session_id && execution.event_id!==corrected.event_id && execution.turn_id!==corrected.turn_id && execution.message_digest!==corrected.message_digest,'correction_must_use_same_session_new_event');
  insist(same(execution.snapshot,corrected.snapshot),'correction_catalog_mismatch');
 } else insist(binding.category!=='continuation' && !binding.correction_prompt,'correction_missing');
 return {execution,outcome,corrected};
}
function equivalentOutcome(a,b) {
 // Exact facts including money/terms/inclusions/person allocation; only add-on
 // ordering (not membership, quantity or allocation) is presentation-neutral.
 const project=x=>{const y=clone(x);if(y.facts?.add_ons)y.facts.add_ons.sort((a,b)=>canonical(a).localeCompare(canonical(b)));return y;};
 return same(project(a),project(b));
}
function verify(payload,key=process.env.LUNA_OWNER_RECEIPT_VERIFIER_KEY) {
 try {
  const {signature,...record}=payload.receipt||{};
  insist(record.schema===SCHEMA && typeof signature==='string' && /^[a-f0-9]{64}$/.test(signature),'unsupported_receipt');
  insist(typeof key==='string' && Buffer.byteLength(key)>=32,'verifier_key_required');
  const expected=crypto.createHmac('sha256',key).update(canonical(record)).digest('hex');
  insist(crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)),'bad_signature');
  const {execution,outcome,corrected}=deriveRecord(record), binding=record.binding;
  for(const k of ['case_id','prompt','correction_prompt'])insist(same(payload[k]??null,binding[k]??null),'proposition_mismatch');
  // category/fault MUST be passed by admission; no unsigned recategorization.
  for(const k of ['category','fault'])insist(same(payload[k]??null,binding[k]??null),'proposition_mismatch');
  insist(payload.revision===execution.snapshot.revision && (same(payload.choices,execution.snapshot.choices) || same(payload.choices,choicesForMatrix(execution.snapshot.choices))),'catalog_mismatch');
  insist(same(requestKey(payload.input,execution.snapshot.choices),requestKey(execution.input,execution.snapshot.choices)) && same(requestKey(publicPrepare(payload.control),execution.snapshot.choices),requestKey(execution.input,execution.snapshot.choices)),'request_mismatch');
  insist(equivalentOutcome(payload.outcome,outcome),'owner_outcome_mismatch');
  if(corrected) {
   insist(same(requestKey(publicPrepare(payload.corrected_control),execution.snapshot.choices),requestKey(corrected.input,execution.snapshot.choices)) && equivalentOutcome(payload.corrected_outcome,corrected.outcome),'corrected_outcome_mismatch');
  } else insist(!payload.corrected_control && !payload.corrected_outcome,'unexpected_correction');
  return {ok:true,result:execution.result,corrected_result:corrected?.result||null,owner_response:execution.response,corrected_owner_response:corrected?.response||null,owner_outcome:outcome,baseline_outcome:execution.outcome,executed_at:record.executed_at,
   provenance:{source:record.source,session_id:execution.session_id,event_id:execution.event_id,corrected_event_id:corrected?.event_id||null,injected_uncertainty:binding.category==='fault'?{fault:binding.fault,source:'matrix-fault-injection-over-real-owner-baseline'}:null}};
 }catch(e){return {ok:false,code:e.message};}
}
module.exports={SCHEMA,ADMIT,PREPARE,FAULTS,canonical,sha256,choicesForMatrix,publicPrepare,normalize,deriveExecution,deriveRecord,verify};
