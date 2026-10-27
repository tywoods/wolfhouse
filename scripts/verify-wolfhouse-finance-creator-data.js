'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const summaryLib = require('./lib/sunset-finance-summary');
const dataLib = require('./lib/sunset-finance-data');
const { buildWolfhouseFinanceCreatorFixtures } = require('./lib/wolfhouse-finance-creator-fixtures');
const now = new Date('2026-10-17T12:00:00.000Z');
const input = {
  bookings: [
    { booking_id:'luna', created_at:'2026-10-01T22:30:00Z', check_in:'2026-10-10', check_out:'2026-10-17', total_amount_cents:10000, metadata:{source:'luna_guest'}, status:'confirmed', currency:'EUR' },
    { booking_id:'staff', created_at:'2026-10-03T09:00:00Z', total_amount_cents:20000, metadata:{created_by_staff:true}, status:'confirmed', currency:'EUR' },
    { booking_id:'import', created_at:'2026-09-01T09:00:00Z', total_amount_cents:30000, metadata:{source:'import'}, status:'confirmed', currency:'EUR' },
    { booking_id:'unknown', created_at:null, total_amount_cents:40000, metadata:{}, status:'confirmed', currency:'EUR' },
  ],
  payments: [
    { payment_id:'p1', booking_id:'luna', amount_paid_cents:3000, paid_at:'2026-10-02T00:30:00Z', payment_kind:'full_amount', metadata:{paid_amount_type:'deposit'}, currency:'EUR', booking_metadata:{source:'luna_guest'} },
    { payment_id:'p1', booking_id:'luna', amount_paid_cents:3000, paid_at:'2026-10-02T00:30:00Z', payment_kind:'full_amount', metadata:{paid_amount_type:'deposit'}, currency:'EUR', booking_metadata:{source:'luna_guest'} },
    { payment_id:'p2', booking_id:'staff', amount_paid_cents:5000, paid_at:'2026-10-03T10:00:00Z', payment_kind:'full_amount', metadata:{}, currency:'EUR', booking_metadata:{created_by_staff:true} },
    { payment_id:'old-cancelled', booking_id:'old', amount_paid_cents:7000, paid_at:'2026-10-04T10:00:00Z', payment_kind:'deposit', metadata:{}, currency:'EUR', booking_metadata:{source:'import'}, booking_status:'cancelled' },
    { payment_id:'usd', booking_id:'staff', amount_paid_cents:900, paid_at:'2026-10-05T10:00:00Z', payment_kind:'deposit', metadata:{}, currency:'USD', booking_metadata:{created_by_staff:true} },
  ],
  bsr: [
    { service_record_id:'product-1', booking_id:'luna', service_date:'2026-10-02', service_type:'accommodation', quantity:1, amount_due_cents:10000, metadata:{package_code:'malibu'}, source:'luna_guest' },
    { service_record_id:'product-2', booking_id:'staff', service_date:'2026-10-03', service_type:'accommodation', quantity:1, amount_due_cents:20000, metadata:{package_code:'malibu'}, source:'luna_guest' },
  ],
  refund_records: [
    { refund_id:'r1', booking_id:'luna', amount_cents:500, effective_date:'2026-10-06', currency:'EUR', booking_metadata:{source:'luna_guest'} },
  ],
  data_quality: { malformed:[{source:'payment.amount_paid_cents',reason:'malformed_money',payment_id:'bad'}] },
  refund_ledger_unavailable:false,
};
assert.equal(summaryLib.wolfhouseCreator({source:'luna_guest'}), 'luna', 'only canonical persisted luna_guest is Luna');
assert.equal(summaryLib.wolfhouseCreator({bot_source:'luna_whatsapp'}), 'staff', 'legacy bot evidence is Staff');
assert.equal(summaryLib.wolfhouseCreator({source:'import'}), 'staff', 'other canonical sources are Staff');
assert.equal(summaryLib.wolfhouseCreator({}), 'staff', 'missing source is Staff');
const projection = summaryLib.computeWolfhouseCreatorFinance({ ...input, now, view:{granularity:'month',anchor:'2026-10-17'}, clientSlug:'wolfhouse-somo', locationId:'' });
assert.equal(projection.schema_version, 'wolfhouse.creator-finance.v1');
assert.equal(projection.metrics.gross_receipts.amount_cents, 15000, 'dedupe + receipt-date + currency isolation + cancelled receipt');
assert.equal(projection.metrics.deposits_received.amount_cents, 10000, 'verified deposit metadata/kind');
assert.equal(projection.metrics.new_booking_count.count, 2, 'Madrid created-date cohort');
assert.equal(projection.metrics.new_booking_value.amount_cents, 30000, 'current saved totals');
assert.equal(projection.metrics.outstanding_today.amount_cents, 92000, 'all-active current total-paid');
assert.deepEqual(projection.creators.map(x=>x.creator), ['luna','staff','total']);
assert.equal(projection.creators[0].gross_receipts.amount_cents, 3000, 'canonical Luna wins precedence');
assert.equal(projection.creators[1].gross_receipts.amount_cents, 12000, 'all non-Luna sources are Staff');
assert.equal(projection.creators[0].gross_receipts.amount_cents + projection.creators[1].gross_receipts.amount_cents, projection.creators[2].gross_receipts.amount_cents, 'Luna plus Staff reconciles to Total');
assert.equal(projection.trend.reduce((n,x)=>n+x.gross_receipts_cents,0),15000);
assert.equal(projection.metrics.gross_receipts.state,'partial','foreign currency is visible partial coverage');
assert.equal(projection.creators[0].receipt_share_bps,null,'partial coverage suppresses shares');
const unavailable = summaryLib.computeWolfhouseCreatorFinance({ ...input, refund_ledger_unavailable:true, now, view:{granularity:'month',anchor:'2026-10-17'}, clientSlug:'wolfhouse-somo' });
assert.equal(unavailable.metrics.gross_receipts.amount_cents,15000);
assert.equal(unavailable.metrics.net_receipts.state,'unavailable');
assert.equal(unavailable.metrics.net_receipts.amount_cents,null);
const propertyCurrencyBookings = summaryLib.computeWolfhouseCreatorFinance({
  bookings: [
    { booking_id:'currency-luna', created_at:'2026-10-01T10:00:00Z', total_amount_cents:10000, currency:null, metadata:{source:'luna_guest'} },
    { booking_id:'currency-staff', created_at:'2026-10-02T10:00:00Z', total_amount_cents:20000, currency:null, metadata:{} },
    { booking_id:'currency-known-source', created_at:'2026-10-03T10:00:00Z', total_amount_cents:30000, currency:'UNKNOWN', metadata:{source:'staff'} },
  ],
  payments: [], refund_records: [], now, view:{granularity:'month',anchor:'2026-10-17'},
  // This is the property/reporting currency supplied by Staff, never a booking guess.
  currency:'EUR', clientSlug:'wolfhouse-somo', locationId:'',
});
const propertyCurrencyRows = Object.fromEntries(propertyCurrencyBookings.creators.map(row => [row.creator, row]));
assert.equal(propertyCurrencyRows.luna.new_booking_count.count, 1, 'missing booking currency uses the Staff property currency for Luna count');
assert.equal(propertyCurrencyRows.staff.new_booking_count.count, 2, 'missing and non-Luna sources are Staff');
assert.equal(propertyCurrencyRows.total.new_booking_count.count, 3, 'property-currency total matches the shared monthly cohort');
assert.equal(propertyCurrencyRows.total.new_booking_value.amount_cents, 60000, 'property-currency total preserves saved values');
assert(!propertyCurrencyRows.total.new_booking_count.reason_codes.includes('unknown_currency'), 'Staff property currency prevents false unknown-currency partial booking metric');
const page1 = summaryLib.pageWolfhouseCreatorFinance(projection, {kind:'payments',currency:'EUR',cohort_id:projection.cohort_id,limit:2});
assert.equal(page1.detail.rows.length,2); assert.equal(page1.detail.page.complete,false); assert(page1.detail.page.next_cursor);
const page2 = summaryLib.pageWolfhouseCreatorFinance(projection, {kind:'payments',currency:'EUR',cohort_id:projection.cohort_id,limit:2,cursor:page1.detail.page.next_cursor});
assert.equal(page2.detail.page.complete,true);
assert.equal([...page1.detail.rows,...page2.detail.rows].reduce((n,x)=>n+x.amount_cents,0),15000);
for (const kind of ['bookings','outstanding','refunds','products','warnings','arrival']) {
  const detail = summaryLib.pageWolfhouseCreatorFinance(projection, {kind,currency:'EUR',cohort_id:projection.cohort_id,limit:100});
  assert.equal(detail.detail.kind, kind, `${kind} detail is served`);
  assert.equal(detail.detail.page.complete, true, `${kind} detail is complete in one page`);
}
assert.equal(summaryLib.pageWolfhouseCreatorFinance(projection,{kind:'refunds',currency:'EUR',cohort_id:projection.cohort_id,limit:100}).detail.rows[0].creator,'luna','refund contributor uses booking creator');
assert.equal(summaryLib.pageWolfhouseCreatorFinance(projection,{kind:'products',currency:'EUR',cohort_id:projection.cohort_id,limit:100}).detail.rows[0].row_id,'product-1');
assert.equal(summaryLib.pageWolfhouseCreatorFinance(projection,{kind:'products',currency:'EUR',cohort_id:projection.cohort_id,limit:100}).detail.rows.find(row=>row.row_id==='product-2').creator,'staff','product contributor retains booking creator despite service-row source');
assert.equal(summaryLib.pageWolfhouseCreatorFinance(projection,{kind:'warnings',currency:'EUR',cohort_id:projection.cohort_id,limit:100}).detail.rows[0].reason_code,'malformed_money');
assert.equal(summaryLib.pageWolfhouseCreatorFinance(projection,{kind:'arrival',currency:'EUR',cohort_id:projection.cohort_id,limit:100}).detail.rows[0].booking_id,'luna');
const scopedDetailInput = {
  ...input,
  bookings:[...input.bookings,
    {booking_id:'outside-arrival',created_at:'2026-10-01',check_in:'2026-11-02',check_out:'2026-11-03',total_amount_cents:111,currency:'EUR',metadata:{}},
    {booking_id:'usd-product',created_at:'2026-10-01',check_in:'2026-10-12',check_out:'2026-10-13',total_amount_cents:222,currency:'USD',metadata:{}}],
  bsr:[...input.bsr,
    {service_record_id:'outside-product',booking_id:'luna',service_date:'2026-11-02',service_type:'accommodation',amount_due_cents:111,metadata:{}},
    {service_record_id:'usd-product-row',booking_id:'usd-product',service_date:'2026-10-12',service_type:'accommodation',amount_due_cents:222,metadata:{}}],
};
const scopedDetailProjection=summaryLib.computeWolfhouseCreatorFinance({...scopedDetailInput,now,view:{granularity:'month',anchor:'2026-10-17'},clientSlug:'wolfhouse-somo'});
const scopedProducts=summaryLib.pageWolfhouseCreatorFinance(scopedDetailProjection,{kind:'products',currency:'EUR',cohort_id:scopedDetailProjection.cohort_id}).detail;
const scopedArrival=summaryLib.pageWolfhouseCreatorFinance(scopedDetailProjection,{kind:'arrival',currency:'EUR',cohort_id:scopedDetailProjection.cohort_id}).detail;
assert.deepEqual(scopedProducts.rows.map(r=>r.row_id),['product-1','product-2'],'product rows are period/currency scoped');
assert.deepEqual(scopedProducts.full_cohort_totals,{product_amount_cents:30000,row_count:2},'product totals use the same scoped cohort');
assert.deepEqual(scopedArrival.rows.map(r=>r.booking_id),['luna'],'arrival rows are check-in-period/currency scoped');
assert.equal(scopedArrival.page.matched_count,1,'arrival paging count uses the scoped cohort');
const outsidePeriodPayment = summaryLib.computeWolfhouseCreatorFinance({ ...input,
  payments:[...input.payments,{payment_id:'outside',booking_id:'staff',amount_paid_cents:1000,paid_at:'2026-09-20T10:00:00Z',payment_kind:'balance',metadata:{},currency:'EUR',booking_metadata:{created_by_staff:true}}],
  now, view:{granularity:'month',anchor:'2026-10-17'}, clientSlug:'wolfhouse-somo', locationId:'' });
assert.notEqual(outsidePeriodPayment.cohort_id,projection.cohort_id,'all-active outstanding input change invalidates cohort even outside selected receipt range');
const reordered = summaryLib.computeWolfhouseCreatorFinance({ ...input,
  bookings:[...input.bookings].reverse(), payments:[...input.payments].reverse(), bsr:[...input.bsr].reverse(),
  now, view:{granularity:'month',anchor:'2026-10-17'}, clientSlug:'wolfhouse-somo', locationId:'' });
assert.equal(reordered.cohort_id,projection.cohort_id,'cohort fingerprint is independent of database row order');
const laterClockProjection = summaryLib.computeWolfhouseCreatorFinance({ ...input,
  now:new Date('2026-10-17T12:05:00.000Z'), view:{granularity:'month',anchor:'2026-10-17'}, clientSlug:'wolfhouse-somo', locationId:'' });
assert.equal(laterClockProjection.cohort_id,projection.cohort_id,'unchanged financial facts retain the cohort across request clocks');
assert.doesNotThrow(()=>summaryLib.pageWolfhouseCreatorFinance(laterClockProjection,{kind:'outstanding',currency:'EUR',cohort_id:projection.cohort_id,limit:100}),
  'unchanged data with a different request clock keeps detail eligible for HTTP 200');
const changedFinancialProjection = summaryLib.computeWolfhouseCreatorFinance({ ...input,
  bookings:input.bookings.map(b=>b.booking_id==='staff'?{...b,total_amount_cents:20001}:b),
  now:new Date('2026-10-17T12:05:00.000Z'), view:{granularity:'month',anchor:'2026-10-17'}, clientSlug:'wolfhouse-somo', locationId:'' });
assert.throws(()=>summaryLib.pageWolfhouseCreatorFinance(changedFinancialProjection,{kind:'outstanding',currency:'EUR',cohort_id:projection.cohort_id,limit:100}),
  e=>e&&e.code==='FINANCE_COHORT_STALE','real financial changes invalidate detail for HTTP 409');
for (const [label, patch] of [
  ['arrival checkout', {bookings:input.bookings.map(b=>b.booking_id==='luna'?{...b,check_out:'2026-10-18'}:b)}],
  ['booking creator evidence', {bookings:input.bookings.map(b=>b.booking_id==='luna'?{...b,metadata:{source:'import'}}:b)}],
  ['product service date', {bsr:input.bsr.map(r=>r.service_record_id==='product-1'?{...r,service_date:'2026-10-04'}:r)}],
  ['refund effective date', {refund_records:input.refund_records.map(r=>({...r,effective_date:'2026-10-07'}))}],
  ['refund ledger availability', {refund_ledger_unavailable:true}],
]) {
  const changed=summaryLib.computeWolfhouseCreatorFinance({...input,...patch,now,view:{granularity:'month',anchor:'2026-10-17'},clientSlug:'wolfhouse-somo',locationId:''});
  assert.notEqual(changed.cohort_id,projection.cohort_id,`${label} invalidates cohort`);
}
assert.throws(()=>summaryLib.pageWolfhouseCreatorFinance(projection,{kind:'payments',currency:'EUR',cohort_id:'stale',limit:2}),e=>e&&e.code==='FINANCE_COHORT_STALE');
const sql = dataLib.LODGING_PAYMENTS_SQL;
assert(/payment_kind/.test(sql) && /paid_amount_type|metadata/.test(sql) && /booking_metadata/.test(sql), 'query projects purpose and creator evidence');
assert(/created_at/.test(dataLib.LODGING_BOOKINGS_SQL) && /metadata/.test(dataLib.LODGING_BOOKINGS_SQL), 'booking query projects creation evidence');
assert(/b\.booking_source::text AS record_source/.test(dataLib.LODGING_BOOKINGS_SQL), 'booking query aliases the migration-backed booking_source column');
assert(!/b\.record_source/.test(dataLib.LODGING_BOOKINGS_SQL + dataLib.LODGING_REFUNDS_SQL), 'lodging SQL never references nonexistent bookings.record_source');
const initMigration=fs.readFileSync(path.join(ROOT,'database/migrations/001_init.sql'),'utf8');
const refundMigration=fs.readFileSync(path.join(ROOT,'database/migrations/056_booking_refund_records.sql'),'utf8');
assert(/booking_source\s+booking_source/.test(initMigration) && /currency\s+CHAR\(3\)/.test(refundMigration), 'queried booking/refund columns exist in migrations');
assert(!/COALESCE[\s\S]*'EUR'/.test(dataLib.LODGING_BOOKINGS_SQL), 'booking SQL does not invent EUR');
assert(!/COALESCE[\s\S]*'EUR'/.test(dataLib.LODGING_PAYMENTS_SQL), 'payment SQL does not invent EUR');
assert(!/COALESCE[\s\S]*'EUR'/.test(dataLib.LODGING_REFUNDS_SQL), 'refund SQL does not invent EUR');
assert(/NULLIF\(upper\(p\.currency/.test(dataLib.LODGING_PAYMENTS_SQL) && !/metadata->>'currency'/.test(dataLib.LODGING_PAYMENTS_SQL), 'payment currency comes only from payments.currency');
assert(/NULLIF\(upper\(r\.currency/.test(dataLib.LODGING_REFUNDS_SQL) && !/metadata->>'currency'/.test(dataLib.LODGING_REFUNDS_SQL), 'refund currency comes only from booking_refund_records.currency');
assert.throws(()=>summaryLib.computeWolfhouseCreatorFinance({...input,currency:'USD',now,view:{granularity:'month',anchor:'2026-10-17'}}),e=>e&&e.code==='FINANCE_INVALID_CURRENCY');
const bad = summaryLib.computeWolfhouseCreatorFinance({...input,payments:[...input.payments,{...input.payments[0],amount_paid_cents:3001}],now,view:{granularity:'month',anchor:'2026-10-17'}});
assert(bad.metrics.gross_receipts.reason_codes.includes('conflicting_payment_identity'));
assert.equal(bad.metrics.gross_receipts.amount_cents,12000,'conflicted payment identity is excluded, not first-row-wins');
const missingDate = summaryLib.computeWolfhouseCreatorFinance({...input,payments:[...input.payments,{payment_id:'no-date',booking_id:'staff',amount_paid_cents:1,paid_at:null,payment_kind:'balance',currency:'EUR',booking_metadata:{created_by_staff:true}}],now,view:{granularity:'month',anchor:'2026-10-17'}});
assert(missingDate.metrics.gross_receipts.reason_codes.includes('receipt_date_missing'));
const unsafe = summaryLib.computeWolfhouseCreatorFinance({...input,payments:[...input.payments,{payment_id:'unsafe',booking_id:'staff',amount_paid_cents:'9007199254740992',paid_at:'2026-10-03',currency:'EUR'}],now,view:{granularity:'month',anchor:'2026-10-17'}});
assert(unsafe.metrics.gross_receipts.reason_codes.includes('unsafe_integer'));
const missingSource = summaryLib.computeWolfhouseCreatorFinance({...input,payments:[...input.payments,{payment_id:'missing-source',booking_id:'x',amount_paid_cents:1,paid_at:'2026-10-03',currency:'EUR',booking_metadata:{}}],now,view:{granularity:'month',anchor:'2026-10-17'}});
assert(!missingSource.metrics.gross_receipts.reason_codes.includes('creator_unresolved'), 'missing source is attributed to Staff, not left unresolved');
assert.equal(missingSource.creators.find(row=>row.creator==='staff').gross_receipts.amount_cents,12001, 'missing payment source is Staff');
assert.equal(missingSource.creators.find(row=>row.creator==='total').gross_receipts.amount_cents,15001, 'Luna plus Staff remains the total');
const conflictRefund = summaryLib.computeWolfhouseCreatorFinance({...input,refund_records:[...input.refund_records,{...input.refund_records[0],amount_cents:501}],now,view:{granularity:'month',anchor:'2026-10-17'}});
assert(conflictRefund.metrics.recorded_refunds.reason_codes.includes('conflicting_refund_identity'));
assert.equal(conflictRefund.metrics.recorded_refunds.amount_cents,0);
for (const metric of Object.values(projection.metrics)) assert.deepEqual(Object.keys(metric.coverage).sort(),['assessed_count','excluded_count','included_count','unknown_count']);
assert.deepEqual(projection.detail_queries,{payments:true,bookings:true,outstanding:true,refunds:true,products:true,warnings:true,arrival:true});
assert.deepEqual(Object.keys(projection.arrival_date_report),['date_basis']);
assert.deepEqual(Object.keys(summaryLib.pageWolfhouseCreatorFinance(projection,{kind:'arrival',currency:'EUR',cohort_id:projection.cohort_id}).detail.rows[0]).sort(),['booking_id','check_in','check_out','creator','current_saved_total_cents']);
assert.deepEqual(Object.keys(summaryLib.pageWolfhouseCreatorFinance(projection,{kind:'warnings',currency:'EUR',cohort_id:projection.cohort_id}).detail.rows[0]).sort(),['component','payment_id','reason_code','row_id']);
const expectedTotalKeys={payments:['deposits_received_cents','gross_receipts_cents'],bookings:['new_booking_count','new_booking_value_cents'],outstanding:['outstanding_cents'],refunds:['recorded_refunds_cents'],products:['product_amount_cents','row_count'],warnings:['row_count'],arrival:['row_count']};
for (const [kind,keys] of Object.entries(expectedTotalKeys)) {
  const detail=summaryLib.pageWolfhouseCreatorFinance(projection,{kind,currency:'EUR',cohort_id:projection.cohort_id});
  assert.deepEqual(Object.keys(detail.detail.full_cohort_totals).sort(),keys,`${kind} full cohort total keys are contractual`);
}
const generatedFixtures=buildWolfhouseFinanceCreatorFixtures();
for (const name of ['success.json','complete-empty.json','partial.json','unavailable-refunds.json','multi-page.json']) {
  const fixture=require(path.join(ROOT,'fixtures/wolfhouse-finance-creator-data',name));
  assert.deepEqual(fixture,generatedFixtures[name],`${name} is the deterministic producer output`);
  assert(fixture.input && fixture.request && fixture.response && Number.isInteger(fixture.response.status),`${name} is a complete producer-backed wire example`);
}
console.log('verify:wolfhouse-finance-creator-data — ALL CHECKS PASSED');
