'use strict';
// Actual emitted browser functions in a tiny DOM boundary. Full ordinary browser
// and SQL evidence lives in the accompanying packet, not in these UI unit tests.
const assert=require('node:assert/strict');
const {test}=require('node:test');
const vm=require('node:vm');
Object.assign(process.env,{NODE_ENV:'test',STAFF_UI_BUILDER_TEST_SEAM:'1',STAFF_AUTH_REQUIRED:'false',STAFF_AUTH_ALLOW_OPEN:'true'});
const html=require('./staff-query-api').buildUiHtmlForOfflineTest(0,'wolfhouse-somo');
const {extract}=require('./fixtures/staff-catalog-lifecycle');
const tick=()=>new Promise(setImmediate);
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function context(outcomes){
  const requests=[], bodies=[], messages=[];
  const values={date:'2026-10-10',from:'2026-10-10',to:'2026-10-17',note:'Original note'};
  const elements=Object.fromEntries(['save-btn','date','note','from','to','date-wrap','date-label','sched-mode-links','add-row-btn','form-wrap','btn','result'].map(n=>['bc-add-ons-'+n,{value:values[n]||'',style:{},disabled:false}]));
  const rows=['service:camp','service:bike'].map(type=>{
    const fields={type:{value:type,disabled:false},qty:{value:'2',disabled:false},slot:{value:'slot-'+type,disabled:false}};
    return {fields,querySelector:selector=>fields[selector.replace('.bc-add-ons-entry-','')],querySelectorAll:()=>Object.values(fields)};
  });
  const links=['specific_date','schedule_later'].map(mode=>({disabled:false,getAttribute:()=>mode,classList:{toggle(){}}}));
  let key=0,closed=0,refreshed=0,client='wolfhouse-somo';
  const api={Promise,Number,JSON,Date,
    bcAddServiceCtx:{bookingCode:'WH-TEST',bookingId:'booking',checkIn:'2026-10-10',scheduleMode:'specific_date',addInFlight:false},
    el:id=>elements[id],getBcClient:()=>client,
    bcRenderAddServiceResult:(data,error)=>messages.push({data,error}),
    bcRefreshServicesTabAfterMutation:()=>{refreshed++;},
    bcNewAddServiceIdempotencyKey:()=> 'key-'+(++key),
    document:{querySelectorAll:selector=>selector==='.bc-add-ons-entry-row'?rows:selector==='.bc-add-ons-sched-link'?links:[]},
    fetch:async(url,options)=>{assert.equal(url,'/staff/bookings/add-service');assert.equal(options.method,'POST');
      bodies.push(options.body);requests.push(JSON.parse(options.body));let outcome=outcomes.shift();
      if(outcome && outcome.promise)outcome=await outcome.promise;
      if(outcome==='network')throw Error('offline response lost');
      return {ok:outcome,status:outcome?200:400,json:async()=>({success:outcome,...(!outcome?{error:'fixture rejection'}:{message:'added'})})};},
  };
  vm.createContext(api);
  for(const name of ['bcRunAddServiceSave','bcAddServiceCollectEntryRows','bcCloseAddServiceForm','bcAddServiceApplyScheduleMode'])vm.runInContext(extract(html,name),api);
  const close=api.bcCloseAddServiceForm;api.bcCloseAddServiceForm=()=>{closed++;close();};
  return {api,requests,bodies,messages,elements,rows,links,get closed(){return closed;},get refreshed(){return refreshed;},
    setClient(value){client=value;},async save(){api.bcRunAddServiceSave();await tick();}};
}
function assertLocked(c){
  for(const id of ['date','from','to','note','add-row-btn'])assert.equal(c.elements['bc-add-ons-'+id].disabled,true,id+' locked');
  for(const control of [...c.links,...c.rows.flatMap(row=>Object.values(row.fields))])assert.equal(control.disabled,true,'row/mode locked');
}
function changeFields(c){
  for(const id of ['date','from','to'])c.elements['bc-add-ons-'+id].value='2026-11-01';
  c.elements['bc-add-ons-note'].value='Changed note';c.api.bcAddServiceCtx.scheduleMode='schedule_later';
  for(const row of c.rows){row.fields.type.value='service:changed';row.fields.qty.value='7';row.fields.slot.value='changed-slot';}
}
test('first failure then success never claims all entries were added; only failed entry retries',async()=>{
  const c=context([false,true,true]);await c.save();
  assert.equal(c.messages.at(-1).error,true);
  assert.equal(c.closed,0);
  assert(c.refreshed>0,'saved successes must refresh readback');
  assertLocked(c);changeFields(c);
  await c.save();
  assert.equal(c.requests.length,3);
  assert.equal(c.requests[2].service_type,'service:camp');
  assert.equal(c.requests[2].idempotency_key,c.requests[0].idempotency_key);
  assert.equal(c.bodies[2],c.bodies[0],'complete payload is byte-identical');
  assert.equal(c.closed,1);
});
test('success then lost response retries unresolved entry with the same key, not successful rows',async()=>{
  const c=context([true,'network',true]);await c.save();
  assert.equal(c.messages.at(-1).error,true);
  assertLocked(c);changeFields(c);
  await c.save();
  assert.equal(c.requests.length,3);
  assert.equal(c.requests[2].service_type,'service:bike');
  assert.equal(c.requests[2].idempotency_key,c.requests[1].idempotency_key);
  assert.equal(c.bodies[2],c.bodies[1],'complete payload is byte-identical despite field changes');
  assert.deepEqual(c.requests[1],{client_slug:'wolfhouse-somo',booking_id:'booking',booking_code:'WH-TEST',
    service_type:'service:bike',quantity:2,schedule_mode:'specific_date',service_date:'2026-10-10',
    service_slot_id:'slot-service:bike',apply_from:'2026-10-10',apply_to:'2026-10-17',note:'Original note',idempotency_key:'key-2'});
  assert.equal(c.closed,1);
});
for(const dimension of ['tenant','bookingId','bookingCode','form generation'])test('retained retry rejects changed '+dimension+' without POST or success',async()=>{
  const c=context(['network',true,true]);await c.save();
  const original=c.api.bcAddServiceCtx[dimension];
  if(dimension==='tenant')c.setClient('sunset');
  else if(dimension==='form generation')c.api.bcCloseAddServiceForm();
  else c.api.bcAddServiceCtx[dimension]='other-booking';
  const closed=c.closed,refreshed=c.refreshed;
  await c.save();
  assert.equal(c.requests.length,2,'must not replay cached payload in a different context');
  assert.equal(c.messages.at(-1).error,true,'no cross-context success');
  assert.equal(c.closed,closed);assert.equal(c.refreshed,refreshed);
  assert.equal(c.api.bcAddServiceCtx.addInFlight,false);
  assert.equal(c.elements['bc-add-ons-save-btn'].disabled,false);
  assertLocked(c);
  if(dimension!=='form generation'){
    if(dimension==='tenant')c.setClient('wolfhouse-somo');else c.api.bcAddServiceCtx[dimension]=original;
    await c.save();
    assert.equal(c.requests.length,3,'deliberate retry in original context still works');
    assert.equal(c.bodies[2],c.bodies[0]);assert.equal(c.closed,1);
  }
});
for(const outcome of [true,'network'])test('pending '+outcome+' response after tenant switch releases its busy state without cross-context effects',async()=>{
  const pending=deferred(),c=context([pending,true,true]);
  await c.save();
  assert.equal(c.requests.length,1);assertLocked(c);
  assert.equal(c.api.bcAddServiceCtx.addInFlight,true);
  assert.equal(c.elements['bc-add-ons-save-btn'].disabled,true);
  await c.save();assert.equal(c.requests.length,1,'double click cannot start another batch');
  c.setClient('sunset');pending.resolve(outcome);await tick();
  assert.equal(c.api.bcAddServiceCtx.addInFlight,false,'finished stale operation releases busy flag');
  assert.equal(c.elements['bc-add-ons-save-btn'].disabled,false,'finished stale operation releases save button');
  assert.equal(c.requests.length,1,'queued row must not POST after tenant changes');
  assert.equal(c.closed,0);assert.equal(c.refreshed,0);
  assert.equal(c.messages.at(-1).error,true,'stale result must not claim success or remain Adding');
  await c.save();assert.equal(c.requests.length,1,'stale retained rows remain blocked in Sunset');
  c.setClient('wolfhouse-somo');await c.save();
  assert.equal(c.closed,1,'original context can finish its unresolved rows');
  assert.equal(c.requests.length,outcome===true?2:3);
  if(outcome==='network')assert.equal(c.bodies[1],c.bodies[0]);
  else assert.equal(c.requests[1].service_type,'service:bike','completed first row is skipped');
});
for(const oldFinishesFirst of [true,false])test('old form completion cannot release or overwrite a newer batch; old first='+oldFinishesFirst,async()=>{
  const old=deferred(),fresh=deferred(),c=context([old,fresh,true]);
  await c.save();const oldRows=[...c.rows];
  c.api.bcCloseAddServiceForm();
  assert.equal(c.api.bcAddServiceCtx.addInFlight,false,'closing invalidates old operation ownership');
  // Replace the mounted rows as reopening the form does, keeping the same tenant/booking/button.
  const replacement=context([]).rows;c.rows.splice(0,c.rows.length,...replacement);
  await c.save();assert.equal(c.requests.length,2);
  assert.notEqual(c.requests[1].idempotency_key,c.requests[0].idempotency_key);
  const messages=c.messages.length,closed=c.closed,refreshed=c.refreshed;
  if(oldFinishesFirst){
    old.resolve(true);await tick();
    assert.equal(c.api.bcAddServiceCtx.addInFlight,true,'older completion must not release newer busy flag');
    assert.equal(c.elements['bc-add-ons-save-btn'].disabled,true,'older completion must not unlock newer save');
    assert.equal(c.messages.length,messages);assert.equal(c.closed,closed);assert.equal(c.refreshed,refreshed);
    assert.equal(c.requests.length,2,'old queued row is cancelled');
    assert(!c.rows[0]._bcAddComplete,'old completion must not complete replacement row');
    fresh.resolve(true);await tick();
  }else{
    fresh.resolve(true);await tick();
    const after=c.messages.length;old.resolve(true);await tick();assert.equal(c.messages.length,after);
  }
  assert.equal(c.requests.length,3);assert.equal(c.closed,closed+1);assert.equal(c.refreshed,refreshed+1);
  assert.equal(c.api.bcAddServiceCtx.addInFlight,false);assert.equal(c.elements['bc-add-ons-save-btn'].disabled,false);
  assert(!oldRows[1]._bcAddComplete,'old unsent row never completes');
});
test('emitted catalog invoice agrees with the authoritative formatter across billing units',()=>{
  const {formatServiceRecordInvoiceLineText}=require('./lib/service-record-invoice-line');
  const api={Number,Math,isNaN,bcParseServiceRecordMeta:m=>m,bcRunningInvoiceSvcTypeLabel:()=> 'Workshop',
    bcResolveRentalInvoiceDisplayQty:()=>1,bcServiceRecordBillableCents:r=>r.amount_due_cents,
    bcPluralUnit:(n,one,many)=>n===1?one:many};
  vm.createContext(api);vm.runInContext(extract(html,'bcRunningInvoiceSvcLineText'),api);
  for (const price_unit of ['per_day','per_stay','per_lesson']) for(const per_guest of [true,false]){
    const row={service_type:'addon_service',quantity:1,amount_due_cents:9000,metadata:{catalog_service:true,
      service_name:'Workshop',price_unit,per_guest,guests_charged:3,catalog_price_cents:1500,nights_charged:2}};
    assert.equal(api.bcRunningInvoiceSvcLineText(row),formatServiceRecordInvoiceLineText(row));
  }
});
test('manage picker uses each individual ID rather than aggregated chip representative',()=>{
  let picked;
  const api={escHtml:s=>s,t:s=>s,bcFormatServiceScheduleDayLabel:s=>s,bcRenderServiceChipHtml:()=>'',
    bcRenderSchedulePickerHtml:()=>'',bcRenderUnschedulePickerHtml:rows=>{picked=rows;return '';}};
  vm.createContext(api);vm.runInContext(extract(html,'bcRenderServicesScheduleSections'),api);
  const records=[{service_record_id:'first',service_date:'2026-10-10'},{service_record_id:'second',service_date:'2026-10-10'}];
  api.bcRenderServicesScheduleSections({success:true,individual_records:records,
    services_by_date:[{date:'2026-10-10',services:[{service_record_id:'first',quantity:2}]}]});
  assert.deepEqual(picked,records);
});
test('deferred mode keeps mode controls visible and can return to a date',()=>{
  const c=context([]);c.api.bcAddServiceApplyScheduleMode('schedule_later');
  assert.notEqual(c.elements['bc-add-ons-date-wrap'].style.display,'none');
  c.api.bcAddServiceApplyScheduleMode('specific_date');
  assert.equal(c.elements['bc-add-ons-date'].value,'2026-10-10');
  assert.notEqual(c.elements['bc-add-ons-date'].style.display,'none');
});
