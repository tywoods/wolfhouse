'use strict';
// Offline Finance Part 2: actual producer, renderer and composed portal.
const assert = require('assert/strict');
const { computeWolfhouseCreatorFinance: compute, pageWolfhouseCreatorFinance: pageProjection, computeSunsetFinanceSummary: computeLegacy } = require('./lib/sunset-finance-summary');
const { renderWolfhouseCreatorFinanceHtml: render, renderWolfhouseCreatorFinanceDetailHtml: renderDetail } = require('./browser/sunset-admin-finance-redesign-ui');
const input = { now:new Date('2026-10-27T12:00:00Z'),clientSlug:'wolfhouse-somo',currency:'EUR',view:{granularity:'month',anchor:'2026-10-27'},
  bookings:[{booking_id:'luna',created_at:'2026-10-03',total_amount_cents:10001,metadata:{source:'luna_guest'}},{booking_id:'staff',created_at:'2026-10-04',total_amount_cents:20002,metadata:{}}],
  payments:[],refund_records:[],bsr:[],booked_services:[],booked_transfers:[] };
const projection=compute(input);
const html=render({wolfhouse_creator_finance:projection});
for (const creator of ['luna','staff','total']) {
 const cents=projection.creators.find(r=>r.creator===creator).new_booking_value.amount_cents;
 assert.match(html,new RegExp('data-wh-fin-headline="'+creator+'"[^>]*>[\\s\\S]*?data-wh-fin-cents="'+cents+'"'),creator+' headline must show server booked value, not receipts');
}
console.log('PASS three booked-value headlines use server creator totals');
for (const extra of [{}, {booked_services_unavailable:true}, {bookings:[]}, {bookings:input.bookings.map(b=>({...b,total_amount_cents:'unreadable'}))}]) {
  const summary=compute({...input,...extra});
  for (const creator of ['', 'luna', 'staff']) {
    const detail=pageProjection(summary,{kind:'bookings',creator,currency:'EUR',cohort_id:summary.cohort_id});
    const state=summary.creators.find(r=>r.creator===(creator||'total')).new_booking_value.state;
    const rendered=renderDetail(detail,{creator,summary});
    assert.ok(rendered.includes('data-wh-fin-booking-state="'+state+'"'));
    assert.equal(rendered.includes('Full-cohort total'),state==='complete');
    if(!detail.detail.rows.length) assert.equal(rendered.includes('No contributing bookings for this selection.'),state==='complete');
    for(const unmatched of [undefined,{...summary,cohort_id:'older-cohort'},{...summary,scope:{...summary.scope,currency:'USD'}}]) {
      const unknown=renderDetail(detail,{creator,summary:unmatched});
      assert.ok(unknown.includes('data-wh-fin-booking-state="missing"'));assert.ok(!unknown.includes('Full-cohort total'));
    }
  }
}
console.log('PASS booking completeness matrix: All/Luna/Staff, complete/partial/empty/unreadable, missing/stale/currency-mismatched summary');

// CAP-FINANCE-TRIM supersedes the deleted month/source/drilldown browser workflow.
// Keep the producer/detail-helper checks above; run the active composed UI contract.
require('./verify-wolfhouse-finance-trim-ui');
