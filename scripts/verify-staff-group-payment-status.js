'use strict';
const assert = require('assert/strict');
const {handleBotGuestPaymentStatus} = require('./lib/staff-bot-v2-routes');

(async () => {
  const rows = [
    {id:'g1', guest_number:1, guest_name:'Jonas', deposit_amount_cents:10000,
     amount_paid_cents:10000, payment_status:'partial', guest_metadata:{subtotal_cents:12000},
     booking_code:'WH-B1', booking_id:'b1'},
    {id:'g2', guest_number:2, guest_name:'Léa', deposit_amount_cents:10000,
     amount_paid_cents:0, payment_status:'pending', guest_metadata:{subtotal_cents:12000},
     booking_code:'WH-B1', booking_id:'b1'},
  ].map(r => ({...r, booking_guest_id:r.id}));
  let query;
  const res = {status:null, body:null};
  const ctx = {
    DEFAULT_CLIENT:'wolfhouse-somo', boundClientSlug:'wolfhouse-somo',
    readBody:async()=>JSON.stringify({booking_code:'WH-B1',payment_scope:'booking_guests'}),
    send400:(_r,msg)=>{throw new Error(msg)},
    sendJSON:(_r,status,body)=>{res.status=status;res.body=body;return body},
    withPgClient:async(fn)=>fn({query:async(sql,params)=>{query={sql,params};return {rows}}}),
  };
  await handleBotGuestPaymentStatus({},res,{},'test',ctx);
  assert.equal(res.status,200);
  assert.equal(res.body.payment_scope,'booking_guests');
  assert.deepEqual(res.body.guest_payment_statuses.map(r=>[r.guest_number,r.amount_paid_cents,r.balance_due_cents]),
    [[1,10000,2000],[2,0,12000]]);
  assert.match(query.sql,/ORDER BY bg\.guest_number/);
  assert.deepEqual(query.params,['wolfhouse-somo','WH-B1']);
  console.log('PASS staff group payment route returns distinct real occupants including zero-paid');
})().catch(e=>{console.error(e);process.exit(1)});
