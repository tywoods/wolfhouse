'use strict';
const assert=require('node:assert/strict');
const {test,before,after}=require('node:test');
const {createFixture,BOOKING,OTHER}=require('./fixtures/staff-catalog-lifecycle');
let f;
before(async()=>{f=await createFixture();});
after(async()=>{if(f)await f.close();});
test('dated per-stay camp outside catalog window is refused without persisted attachment',async()=>{
  const before=await f.records();
  const r=await f.add(f.services.camp,{service_date:'2026-10-09'});
  assert.equal(r.status,400,JSON.stringify(r));
  assert.deepEqual(await f.records(),before);
});
test('existing camp attach -> saved SQL readback -> invoice -> manage removal, with replay',async()=>{
  const r=await f.add(f.services.camp);
  assert.equal(r.status,200,JSON.stringify(r));
  const id=r.body.service_record.service_record_id;
  const rows=await f.records();
  assert.equal(rows.length,1);
  assert.equal(rows[0].service_record_id,id);
  assert.equal(rows[0].amount_due_cents,70000);
  assert.equal(rows[0].metadata.service_id,f.services.camp.id);
  assert.equal(rows[0].metadata.service_name,'Offline dated camp');
  assert.equal(rows[0].metadata.invoice_total_inclusion,'additional');
  assert.equal((await f.totals()).invoice_total_cents,80000);
  assert.equal((await f.booking()).total_amount_cents,10000,'attachment does not rewrite accommodation total');
  const retry=await f.add(f.services.camp);
  assert.equal(retry.status,200);
  assert.equal(retry.body.idempotent,true);
  assert.equal((await f.records()).length,1);
  assert.equal((await f.totals()).invoice_total_cents,80000,'retry cannot double bill');
  assert.equal((await f.remove([id],{booking_id:OTHER})).status,404);
  assert.equal((await f.remove([id],{client_slug:'sunset'})).status,404);
  assert.equal((await f.records()).length,1,'wrong tenant/booking cannot remove another invoice line');
  assert.equal((await f.remove([id])).body.removed_count,1);
  assert.equal((await f.records()).length,0);
  assert.equal((await f.totals()).invoice_total_cents,10000);
  assert.equal((await f.remove([id])).body.removed_count,0,'remove replay is a no-op');
});
test('flat party service charges once and daily service charges the selected guest/date span',async()=>{
  const flat=await f.add(f.services.transfer,{quantity:9});
  assert.equal(flat.status,200,JSON.stringify(flat));
  assert.equal(flat.body.service_record.amount_due_cents,4000);
  const daily=await f.add(f.services.bike,{apply_from:'2026-10-12',apply_to:'2026-10-15'});
  assert.equal(daily.status,200,JSON.stringify(daily));
  assert.equal(daily.body.service_record.amount_due_cents,9000);
  assert.equal(daily.body.service_record.metadata.guests_charged,2);
  assert.equal(daily.body.service_record.metadata.nights_charged,3);
  assert.equal((await f.totals()).invoice_total_cents,23000);
  assert.equal(daily.body.service_record.service_date,'2026-10-12','saved readback date must match the actual charged span');
});
test('catalog cannot silently ignore Schedule Later or a span mode',async()=>{
  for (const schedule_mode of ['schedule_later','span_across_booking']) {
    const before=await f.records();
    const r=await f.add(f.services.transfer,{schedule_mode,service_date:null,idempotency_key:'bad-mode-'+schedule_mode});
    assert.equal(r.status,400,JSON.stringify(r));
    assert.deepEqual(await f.records(),before);
  }
});
test('selected bulk removal cannot delete owned rows before rejecting a different booking row',async()=>{
  const own=await f.add(f.services.transfer,{idempotency_key:'own-bulk'});
  const other=await f.add(f.services.transfer,{booking_id:OTHER,idempotency_key:'other-bulk'});
  assert.equal(own.status,200); assert.equal(other.status,200);
  const before=await f.records();
  const r=await f.remove([own.body.service_record.service_record_id,other.body.service_record.service_record_id]);
  assert.equal(r.status,404);
  assert.deepEqual(await f.records(),before,'bulk remove must be atomic on rejected selection');
});
test('catalog rejects impossible dates, out-of-stay daily ranges and invalid explicit quantities without writes',async()=>{
  for (const extra of [
    {service_date:'2026-02-31'}, {service_date:'not-a-date'},
    {quantity:0}, {quantity:-1}, {quantity:1.5}, {quantity:'oops'},
  ]) {
    const before=await f.records();
    const r=await f.add(f.services.transfer,{...extra,idempotency_key:'invalid-'+JSON.stringify(extra)});
    assert.equal(r.status,400,JSON.stringify(r));
    assert.deepEqual(await f.records(),before);
  }
  const before=await f.records();
  for (const range of [
    {apply_from:'2026-10-09',apply_to:'2026-10-12'},
    {apply_from:'2026-10-12',apply_to:'2026-10-18'},
    {apply_from:'2026-10-13',apply_to:'2026-10-12'},
  ]) assert.equal((await f.add(f.services.bike,{...range,idempotency_key:'invalid-range-'+JSON.stringify(range)})).status,400);
  assert.deepEqual(await f.records(),before);
});
test('slot-backed lesson requires an explicit active slot and refuses the existing full-slot guard',async()=>{
  await f.pg.query('UPDATE tenant_services SET schedule_slots=$2::jsonb WHERE id=$1',[
    f.services.lesson.id,JSON.stringify([{slot_id:'morning',time_local:'09:00',capacity:1,active:true},{slot_id:'closed',time_local:'10:00',capacity:1,active:false}])]);
  const before=await f.records();
  for(const slot of [null,'closed','unknown']) {
    const r=await f.add(f.services.lesson,{quantity:1,service_slot_id:slot,idempotency_key:'slot-'+slot});
    assert.equal(r.status,400,JSON.stringify(r));
  }
  assert.deepEqual(await f.records(),before);
  const saved=await f.add(f.services.lesson,{quantity:1,service_slot_id:'morning',idempotency_key:'slot-first'});
  assert.equal(saved.status,200,JSON.stringify(saved));
  const after=await f.records();
  assert.equal((await f.add(f.services.lesson,{quantity:1,service_slot_id:'morning',idempotency_key:'slot-second'})).status,409);
  assert.deepEqual(await f.records(),after);
});
test('inactive catalog and cross-tenant attach fail closed',async()=>{
  const before=await f.records();
  await f.pg.query('UPDATE tenant_services SET active=false WHERE id=$1',[f.services.camp.id]);
  assert.equal((await f.add(f.services.camp,{idempotency_key:'inactive'})).status,400);
  assert.equal((await f.add(f.services.transfer,{client_slug:'sunset'})).status,404);
  assert.deepEqual(await f.records(),before);
});
