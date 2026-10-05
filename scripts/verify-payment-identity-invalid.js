'use strict';
const assert=require('assert/strict');
const s=require('./lib/luna-payment-short-link');
(async()=>{
 const booking_row={booking_status:'confirmed',balance_due_cents:100};
 const payment_rows=[{payment_status:'checkout_created',checkout_url:'https://checkout.stripe.com/test/wrong',metadata:{guest_number:2}}];
 const bad=[0,-1,'','x','1x','1.5','01',Number.MAX_SAFE_INTEGER+1];
 const cases=bad.map(guest_number=>({booking_code:'WH-SYNTHETIC',guest_number}));
 cases.push(...bad.map(n=>({token:`WH-SYNTHETIC/g${n}`})));
 cases.push({booking_code:'WH-SYNTHETIC/g1',guest_number:2},{token:'WH-SYNTHETIC/g1',guest_number:2});
 for(const input of cases){
  let queries=0;
  const result=await s.resolvePaymentShortLinkRedirectFromDb({query:async()=>{queries++;return {rows:[]};}},input);
  assert.equal(result.status,'invalid_token',JSON.stringify(input));
  assert.equal(queries,0);
  assert.equal(s.resolvePaymentShortLinkRedirect({...input,booking_row,payment_rows}).status,'invalid_token');
 }
 for(const input of [{token:'WH-SYNTHETIC/g1',guest_number:1},{booking_code:'WH-SYNTHETIC/g1',guest_number:'1'}]){
  assert.equal(s.resolvePaymentShortLinkRedirect({...input,booking_row,payment_rows:[{...payment_rows[0],metadata:{guest_number:1}}]}).status,'redirect');
 }
 console.log(`PASS: ${cases.length} malformed/conflicting inputs rejected before DB lookup; matching redundant identity accepted`);
})().catch(e=>{console.error(e);process.exitCode=1;});
