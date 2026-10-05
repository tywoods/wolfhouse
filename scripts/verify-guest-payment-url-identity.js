'use strict';
// Offline synthetic fixtures only. Execute real owners; fake only PG/Stripe/transport.
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const {spawnSync} = require('child_process');
const short = require('./lib/luna-payment-short-link');
const {insertBookingGuestsForBooking} = require('./lib/booking-guests');
const root = require('path').join(__dirname, '..');
const source = fs.readFileSync(`${__dirname}/lib/staff-bot-v2-routes.js`, 'utf8');
const handler = source.slice(source.indexOf('async function handleBotGuestPaymentCreateLink('), source.indexOf('// POST /staff/bot/booking-guests/payment-status'));
const api = fs.readFileSync(`${__dirname}/staff-query-api.js`, 'utf8');
const route = api.slice(api.indexOf('async function handleGuestPaymentShortLinkRedirect('), api.indexOf('// Route: GET /staff/intents'));
(async () => {
 const env = {PUBLIC_PAYMENT_BASE_URL:'https://synthetic.invalid'};
 const permutations = [[1,2,3],[1,3,2],[2,1,3],[2,3,1],[3,1,2],[3,2,1]];
 for (const rosterOrder of permutations) for (const paymentOrder of permutations) {
 const names={1:'Oliver Synthetic Fullname',2:'Chloe Synthetic Fullname',3:'Anna Synthetic Fullname'};
 const guests = rosterOrder.map(guest_number=>({guest_number,guest_name:names[guest_number]}));
 const rows = await insertBookingGuestsForBooking({query:async(sql,p)=>({rows:[{booking_guest_id:`guest-${p[2]}`,guest_number:p[2],guest_name:p[3],deposit_amount_cents:p[6]}]})}, {clientId:'client',bookingId:'booking',guests,perPersonBreakdown:guests.map(g=>({guest_number:g.guest_number,deposit_cents:10000+g.guest_number*1000+g.guest_number*17}))});
 const payments = []; const responses = [];
 const coordinator = require('./lib/per-guest-checkout');
 let coordinatorCalls = 0;
 const pg = {query:async(sql,p)=> {
  if (['BEGIN','COMMIT','ROLLBACK'].includes(sql)) return {rows:[]};
  if (sql===coordinator.LOCKED_GUEST_SQL || sql.startsWith('SELECT bg.id::text AS booking_guest_id')) return {rows:rows.filter(r=>r.booking_guest_id===p[0]).map(r=>({...r,client_id:'client',booking_id:'booking',booking_code:'WH-SYNTHETIC',booking_status:'confirmed',guest_metadata:{subtotal_cents:50000},amount_paid_cents:0}))};
  if(sql.startsWith('SELECT bg.booking_id::text')) return {rows:[{booking_id:'booking'}]};
  if(sql.startsWith('SELECT id FROM')) return {rows:[{id:p[0]}]};
  if(sql.includes('FROM payments WHERE client_id=')) return {rows:payments.filter(r=>r.booking_guest_id===p[2])};
  if(sql.includes('INSERT INTO payments')) {payments.unshift({payment_id:`payment-${p[2]}`,client_id:p[0],booking_id:p[1],booking_guest_id:p[2],amount_due_cents:p[4],currency:'EUR',metadata:JSON.parse(p[5]),payment_status:'draft'});return {rows:[payments[0]]};}
  if(sql.startsWith('UPDATE payments SET metadata=')) {Object.assign(payments.find(r=>r.payment_id===p[0]).metadata,JSON.parse(p[1]));return {rows:[],rowCount:1};}
  if(sql.includes('UPDATE payments SET status=')) {Object.assign(payments.find(r=>r.payment_id===p[4]),{checkout_url:p[1],stripe_checkout_session_id:p[0],payment_status:'checkout_created'});return {rows:[],rowCount:1};}
  if(sql.includes('UPDATE booking_guests')) return {rows:[],rowCount:1};
  if(sql===short.PAYMENT_SHORT_LINK_LOOKUP_SQL) return {rows:[{booking_id:'booking',client_id:'client',booking_status:'confirmed',balance_due_cents:33000}]};
  if(sql===short.PAYMENT_SHORT_LINK_PAYMENTS_SQL) return {rows:paymentOrder.map(n=>({...payments.find(p=>p.booking_guest_id===`guest-${n}`),authoritative_guest_number:n}))};
  throw Error(sql);
 }};
 const sandbox = {require:(name)=>{assert.equal(name,'./per-guest-checkout');return {run:async opts=>{coordinatorCalls++;return coordinator.run(opts);}};},process:{env},buildPaymentShortLink:short.buildPaymentShortLink};
 const stripe = {checkout:{sessions:{create:async input=>{
  const owner=rows.find(r=>r.booking_guest_id===input.metadata.booking_guest_id);
  assert.equal(input.line_items[0].price_data.product_data.name,`Booking WH-SYNTHETIC — ${owner.guest_name}`);
  assert.equal(input.line_items[0].price_data.unit_amount,owner.deposit_amount_cents);
  assert.equal(input.metadata.booking_id,'booking');
  assert.equal(input.line_items[0].price_data.product_data.description,`Deposit | Guest ${owner.guest_number}`);
  return {id:`cs_test_${input.metadata.booking_guest_id}`,status:'open',payment_status:'unpaid',expires_at:4102444800,url:`https://checkout.stripe.com/test/${input.metadata.booking_guest_id}/${input.line_items[0].price_data.unit_amount}`};
 }}}};
 vm.createContext(sandbox);vm.runInContext(handler,sandbox);
 for(const row of rows) {
  await sandbox.handleBotGuestPaymentCreateLink(row.booking_guest_id,{}, {},null,'offline', {stripe,sendJSON:(res,status,data)=>{assert.equal(status,200,JSON.stringify(data));responses.push(data);},readBody:async()=> '{}',withPgClient:fn=>fn(pg),guestPaymentLinkObservability:()=>({}),BOT_BOOKING_ENABLED:true,STRIPE_LINKS_ENABLED:true,STRIPE_SECRET_KEY:'synthetic',DEFAULT_CLIENT:'wolfhouse-somo',stripeCheckoutRedirectUrlsConfigured:()=>true,stripeCheckoutSessionSuccessUrl:()=> 'https://synthetic.invalid/success',stripeCheckoutSessionCancelUrl:()=> 'https://synthetic.invalid/cancel'});
 }
 assert.equal(coordinatorCalls,3,'reachable coordinator must execute for every guest');
 assert.ok(payments.every(p=>p.metadata.guest_number == null),'do not invent legacy identity metadata');
 // Execute the actual Python adapter body with a fixture transport, not a rewrite.
 const py = spawnSync('python3',[`${__dirname}/verify-payment-identity-batch.py`,`${root}/docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py`,'standalone'],{input:JSON.stringify(responses),encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(py.status,0,py.stderr);const adapted=JSON.parse(py.stdout);
 const batch=spawnSync('python3',[`${__dirname}/verify-payment-identity-batch.py`,`${root}/docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py`],{input:JSON.stringify(responses),encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(batch.status,0,batch.stderr);
 const batchLinks=JSON.parse(batch.stdout).guest_payment_links;
 // Installed Luna amount pairing is evidenced by the host capture; repository batch source is not that hot copy.
 assert.deepEqual(batchLinks.map(l=>[l.booking_guest_id,l.guest_name,l.secure_payment_url]),adapted.map(l=>[l.booking_guest_id,l.guest_name,l.secure_payment_url]));
 const routeSandbox={parsePaymentShortLinkToken:short.parsePaymentShortLinkToken,resolvePaymentShortLinkRedirectFromDb:short.resolvePaymentShortLinkRedirectFromDb,withPgClient:fn=>fn(pg),process:{env},sendGuestPaymentLinkStatus:()=>assert.fail('unexpected non-redirect')};
 vm.createContext(routeSandbox);vm.runInContext(route,routeSandbox);
 for(const link of adapted) {
  const authoritative=rows.find(r=>r.booking_guest_id===link.booking_guest_id);
  assert.equal(link.guest_name,authoritative.guest_name);assert.equal(link.amount_due_cents,authoritative.deposit_amount_cents);
  assert.ok(link.secure_payment_url.endsWith(`/g${authoritative.guest_number}`));
  let location;
  await routeSandbox.handleGuestPaymentShortLinkRedirect('WH-SYNTHETIC',String(authoritative.guest_number),{}, {}, {writeHead:(status,h)=>{assert.equal(status,302);location=h.Location;},end:()=>{}});
  assert.equal(location,`https://checkout.stripe.com/test/${authoritative.booking_guest_id}/${authoritative.deposit_amount_cents}`);
  // Direct composite-token resolver must also preserve the guest selection.
  const direct=await short.resolvePaymentShortLinkRedirectFromDb(pg,{token:`WH-SYNTHETIC/g${authoritative.guest_number}`,env});
  assert.equal(direct.payment_short_url,link.secure_payment_url);
 }
  }
 console.log('PASS: 36 roster/payment-order permutations, 108 identities: real Staff/Stripe inputs → standalone + automatic Python tool JSON → HTTP/DB redirect; no model rendering claimed');
})().catch(e=>{console.error(e);process.exitCode=1;});
