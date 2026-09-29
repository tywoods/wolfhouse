'use strict';

// Production /staff/ui, real calendar block + tab clicks; only HTTP data is synthetic.
// Exact synthetic Transfer POST/DELETE controls are locally fulfilled: display/payload proof, not persistence.
// No server, live credentials or outbound network. Usage: node scripts/verify-invoice-paid-history.js [artifact-dir]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'tmp/invoice-paid-history'));
const ORIGIN = 'http://staff.test';
const CODE = 'WH-CHROME-TEST';
const booking = { booking_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', booking_code: CODE,
  guest_name: 'Tom (test)', guest_count: 2, total_amount_cents:60000, accommodation_total_cents:60000, deposit_required_cents:18000, amount_paid_cents:0, balance_due_cents:60000, status: 'confirmed', check_in: '2026-09-24', check_out: '2026-09-29', nights: 5 };
const calendar = { success: true,
  days: Array.from({ length: 14 }, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 24 + i)).toISOString().slice(0, 10) })),
  rooms: Array.from({ length: 4 }, (_, i) => ({ room_code: `R${i + 1}`, room_name: `Room ${i + 1}`,
    beds: Array.from({ length: 4 }, (_, j) => ({ bed_code: `R${i + 1}-B${j + 1}`, bed_label: `Bed ${j + 1}` })) })),
  blocks: [{ ...booking, room_code: 'R1', bed_code: 'R1-B1', start_date: '2026-09-24', end_date: '2026-09-29', source: 'staff', start_offset: 0, span: 5 }], warnings: [] };
const GUEST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const detail = { success: true, booking, rooming: { assignments: [] }, booking_guests: [{booking_guest_id:GUEST, guest_number:1, guest_name:'Tom (test)', metadata:{subtotal_cents:30000}, deposit_amount_cents:9000, amount_paid_cents:0, payment_status:'not_requested'}], per_person: [],
  guest_accommodation_lines: [{guest_number:1,accommodation_cents:30000,nights:5},{guest_number:2,accommodation_cents:30000,nights:5}],
  service_records: [], transfers: [], payments: { paid_total_cents: 0, rows: [] }, pending_manual_services: [], conversation: null };

function emit(tenant) {
  const dest = path.join(OUT, `${tenant}.html`);
  const r = spawnSync(process.execPath, ['scripts/verify-inbox-ui-parity.js', '--emit', tenant, dest], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, STAFF_ACTIONS_ENABLED: 'true', STRIPE_LINKS_ENABLED: 'true' } });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return fs.readFileSync(dest, 'utf8');
}
async function main() {
  fs.mkdirSync(OUT, {recursive:true});
  const html = emit('wolfhouse-somo');
  const browser = await chromium.launch({headless:true});
  const ctx = await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  const ledger=[], errors=[], cases=[];
  const state=JSON.parse(JSON.stringify(detail));
  state.booking_guests[0].assigned_bed_code='R1-B1';
  state.booking_guests.push({...state.booking_guests[0],booking_guest_id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',guest_number:2,guest_name:'Ada & Bea (test)',assigned_bed_code:'R1-B2',amount_paid_cents:9000,payment_status:'paid'});
  calendar.blocks=[1,2].map(n=>({...calendar.blocks[0],bed_code:'R1-B'+n,calendar_group_size:2,calendar_guest_number:n,calendar_guest_share_cents:30000,calendar_guest_deposit_cents:9000,calendar_guest_paid_cents:n===1?0:9000}));
  const other=JSON.parse(JSON.stringify(detail));
  other.booking={...other.booking,booking_id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',booking_code:'WH-OTHER',guest_name:'Other booking',total_amount_cents:99000,balance_due_cents:99000};
  other.booking_guests=[];other.guest_accommodation_lines=[];
  calendar.blocks.push({...calendar.blocks[0],...other.booking,room_code:'R2',bed_code:'R2-B1',calendar_group_size:1});
  let failure=null, holdTransfer=true, releaseTransfer, transferFlight='HELD-ARRIVAL', transferDirection='arrival';
  const transferObservations=[];
  // buildTransfersDrawerPayload returns identifiers/defaults, NOT a booking snapshot.
  function transferPayload(rows){return {success:true,client_slug:'wolfhouse-somo',booking_id:booking.booking_id,booking_code:CODE,timezone:'Europe/Madrid',transfers_available:true,airports:[{code:'SDR',label:'Santander'}],transfers:rows,defaults:{default_airport_code:'SDR'}};}
  let mutation=null, followup=null, fallbackPayload=null;
  async function syntheticWrite(route,entry,response){
    const pending=mutation;mutation=null;
    if(pending.holdWrite){entry.heldWrite=true;await new Promise(resolve=>{pending.releaseWrite=resolve;});entry.released=true;}
    if(pending.writeOutcome==='network'){entry.syntheticNetworkFailure=true;return route.abort('failed');}
    if(pending.writeOutcome==='failed')return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({success:false,error:'Synthetic write unavailable'})});
    followup=pending;
    return route.fulfill({contentType:'application/json',body:JSON.stringify(response)});
  }
  await ctx.route('**/*', async route=>{
    const req=route.request(), url=new URL(req.url()), entry={method:req.method(),url:req.url()}; ledger.push(entry);
    if(url.origin===ORIGIN && mutation && req.method()==='POST' && url.pathname===`/staff/bookings/${booking.booking_id}/transfers`){
      entry.syntheticWrite=true;entry.body=req.postDataJSON();
      assert.equal(mutation.action,'save');assert.equal(entry.body.client_slug,'wolfhouse-somo');
      assert.equal(entry.body.direction,'departure');assert.equal(entry.body.manual_override_euros,mutation.priceEuros || 0);
      assert.equal(entry.body.scheduled_at,'2026-09-29T10:00');
      const priceCents=(mutation.priceEuros || 0)*100;
      return syntheticWrite(route,entry,{success:true,transfer:{id:'synthetic-transfer',direction:'departure',status:'requested',price_cents:priceCents,pricing:{available:true,price_cents:priceCents}}});
    }
    if(url.origin===ORIGIN && mutation && req.method()==='DELETE' && url.pathname===`/staff/bookings/${booking.booking_id}/transfers/departure`){
      entry.syntheticWrite=true;assert.equal(mutation.action,'remove');
      assert.equal(url.searchParams.get('client_slug'),'wolfhouse-somo');assert.equal(req.postData(),null);
      return syntheticWrite(route,entry,{success:true});
    }
    if(url.origin!==ORIGIN || req.method()!=='GET'){entry.blocked=true;return route.abort();}
    const p=url.pathname; let data;
    if(p==='/staff/ui')return route.fulfill({contentType:'text/html',body:html});
    if(p==='/staff/bed-calendar')data=calendar;
    else if(p===`/staff/bookings/${CODE}/context`){
      if(followup){
        const pending=followup;followup=null;entry.heldFollowup=true;
        const body=JSON.stringify(pending.data || state);
        await new Promise(resolve=>{pending.release=resolve;});entry.released=true;
        return route.fulfill({status:pending.failed?503:200,contentType:'application/json',body:pending.failed?JSON.stringify({success:false,error:'Synthetic read unavailable'}):body});
      }
      data=state;
    }
    else if(p==='/staff/bookings/WH-OTHER/context')data=other;
    else if(p==='/staff/auth/session')data={success:true,auth_required:false,role:'admin',clients:[{slug:'wolfhouse-somo',name:'Wolfhouse'}],client_profiles:{'wolfhouse-somo':loadClientPortalProfile('wolfhouse-somo')}};
    else if(p.startsWith('/staff/assets/')){
      const asset=path.join(ROOT,'config/staff-portal',path.basename(p));
      if(fs.existsSync(asset))return route.fulfill({path:asset});
      entry.unknown=true;return route.abort();
    }
    else if(p==='/staff/intents')data={success:true,intents:[]};
    else if(p==='/staff/inbox/luna-mode')data={success:true,mode:'off'};
    else if(p==='/staff/bot/global-pause-state')data={success:true,paused:false};
    else if(p==='/staff/whatsapp-numbers')data={success:true,numbers:[]};
    else if(p==='/staff/admin/house-notes')data={success:true,notes:''};
    else if(p==='/staff/automated-notifications')data={success:true,notifications:[]};
    else if(p==='/staff/packages')data={success:true,packages:[]};
    else if(p==='/staff/conversations')data={success:true,conversations:[]};
    else if(p==='/staff/admin/config')data={success:true,...resolveTenantBusinessConfig('wolfhouse-somo','sunset-somo')};
    else if(p==='/staff/admin/config/rental-offerings')data={success:true,offerings:[]};
    else if(p===`/staff/bookings/${booking.booking_id}/services`)data={success:true,paid_requested_services:[],unscheduled_services:[],services_by_date:[]};
    else if(p===`/staff/bookings/${booking.booking_id}/transfers`){
      data=fallbackPayload || transferPayload([{direction:transferDirection,status:'confirmed',flight_number:transferFlight,price_cents:0}]);
      if(holdTransfer){holdTransfer=false;entry.held=true;await new Promise(resolve=>{releaseTransfer=resolve;});entry.released=true;}
    }
    else if(p===`/staff/bookings/${other.booking.booking_id}/transfers`)data={...transferPayload([]),booking_id:other.booking.booking_id,booking_code:other.booking.booking_code};
    else if(p===`/staff/bookings/${other.booking.booking_id}/services`)data={success:true,paid_requested_services:[],unscheduled_services:[],services_by_date:[]};
    else if(p==='/staff/clients')data={success:true,clients:[{slug:'wolfhouse-somo',name:'Wolfhouse'}]};
    else{entry.unknown=true;return route.abort();}
    return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await ctx.addInitScript(()=>{localStorage.setItem('wh_staff_portal_locale','en');});
  const page=await ctx.newPage(); page.on('pageerror',e=>errors.push(String(e)));
  page.on('dialog',dialog=>dialog.accept());
  try{
    await page.goto(ORIGIN+'/staff/ui');
    await page.waitForFunction(()=>typeof window.switchToTab==='function' && document.getElementById('c-client').value==='wolfhouse-somo');
    await page.evaluate(()=>window.switchToTab('bed-calendar'));
    await page.locator('.bc-block').first().click(); await page.mouse.move(1300,500);
    await page.locator('#bc-inv-totals').waitFor();
    await page.waitForFunction(()=>{const r=document.getElementById('bc-side-drawer').getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth+1;});
    async function refresh(){
      await page.locator('#bc-refresh-links-btn').click();
      await page.waitForFunction(()=>{const btn=document.getElementById('bc-refresh-links-btn');const box=document.getElementById('bc-invoice-feedback');return btn&&!btn.disabled&&box&&!/Amounts refreshed|Refreshing/i.test(box.textContent);});
    }
    state.payments.rows=[{payment_id:'receipt-all',payment_status:'paid',amount_paid_cents:60000,created_at:'2026-09-26T10:00:00Z',paid_at:'2026-09-26T10:01:00Z',metadata:{method:'bank_transfer',payment_scope:'booking'}}];
    await refresh();
    async function financialSnapshot(paymentCounts=[1,1,1]){
      const snapshot=await page.evaluate(()=>({
        guests:[...document.querySelectorAll('#bc-guest-names .bc-accom-pay-pebble')].map(e=>e.textContent),
        header:[...document.querySelectorAll('#bc-side-payment-meta .pill')].map(e=>e.textContent),
        totals:document.getElementById('bc-inv-totals').textContent,
        beds:[...document.querySelectorAll('.bc-block')].map(e=>({label:e.querySelector('.bc-block-label').textContent,payment:[...e.querySelectorAll('.bc-block-pay-badge')].map(n=>n.textContent)})),
        booking:document.getElementById('bc-side-drawer').getAttribute('data-mounted-booking-id')
      }));
      assert([booking.booking_id,other.booking.booking_id].includes(snapshot.booking),'required mounted booking');
      assert.equal(snapshot.guests.length,snapshot.booking===booking.booking_id?2:0,'guest payment node cardinality');
      assert.equal(snapshot.beds.length,3,'calendar block cardinality');
      snapshot.beds.forEach((b,i)=>{
        assert.equal(typeof b.label,'string');assert(b.label.length>0,'required bed label');
        assert.equal(b.payment.length,paymentCounts[i],'expected calendar payment badge cardinality for bed '+i);
        assert(b.payment.every(p=>typeof p==='string'&&p.length>0),'required calendar payment values');
      });
      assert(snapshot.totals.includes('Invoice total'),'required totals');
      assert(snapshot.header.every(p=>typeof p==='string'&&p.length>0),'required header values');
      assert.deepEqual(JSON.parse(JSON.stringify(snapshot)),snapshot,'no undefined observation fields');
      return snapshot;
    }
    const beforeTransfer=await financialSnapshot();
    assert.deepEqual(beforeTransfer.guests,['Paid','Paid'],'fresh Invoice read settled guests before Transfer release');
    assert.equal(typeof releaseTransfer,'function','initial fallback Transfer GET held');
    const transferResponse=page.waitForResponse(r=>new URL(r.url()).pathname===`/staff/bookings/${booking.booking_id}/transfers`);
    releaseTransfer();await transferResponse;
    await page.waitForFunction(()=>!document.getElementById('bc-transfer-cards').classList.contains('ctx-loading'));
    const afterTransfer=await financialSnapshot();
    transferObservations.push({name:'refresh-then-old-transfer',before:beforeTransfer,after:afterTransfer});
    assert.deepEqual(afterTransfer,beforeTransfer,'late initial Transfer GET must not roll back fresh Invoice financial state');
    await page.locator('.bc-drawer-tab[data-tab="transfers"]').click();
    assert.equal(await page.locator('#bc-transfer-arrival-flight').inputValue(),'HELD-ARRIVAL','late same-mount response still populates Transfer chrome');
    assert.equal(await page.locator('#bc-side-payment-meta .transfer-pebble').count(),1,'Transfer badge retained');
    assert.equal(await page.locator('.bc-block[data-bidx="0"] .transfer-pebble').count(),1,'calendar Transfer badge retained without repainting financial state');
    await page.locator('.bc-drawer-tab[data-tab="overview"]').click();
    cases.push('delayed-fallback-transfer-after-invoice-refresh-preserves-finances-and-chrome');
    assert.deepEqual(await page.locator('#bc-guest-names .bc-accom-pay-pebble').allTextContents(),['Paid','Paid'],'fully settled booking overrides unallocated guest shares immediately');
    assert.equal(await page.locator('#bc-side-payment-meta .pill').filter({hasText:/^Paid$/}).count(),1,'booking Paid');
    assert.equal(await page.locator('#bc-side-payment-meta').innerText().then(s=>/Deposit paid/i.test(s)),false);
    for(const block of await page.locator('.bc-block[data-bidx="0"],.bc-block[data-bidx="1"]').all()){
      assert.equal(await block.locator('.bc-block-pay-paid').count(),1,'every bed Paid');
      assert.equal(await block.locator('.bc-block-pay-deposit,.bc-block-pay-balance').count(),0,'no stale Deposit Paid or owing');
    }
    await page.locator('#bc-side-close').click();await page.locator('.bc-block').first().click();await page.mouse.move(1300,500);
    await page.locator('#bc-refresh-links-btn').waitFor();
    assert.deepEqual(await page.locator('#bc-guest-names .bc-accom-pay-pebble').allTextContents(),['Paid','Paid'],'reopen uses same authoritative receipt');
    cases.push('full-booking-paid-all-guests-beds-header-refresh-and-reopen');
    const guestRows=await page.locator('#bc-inv-per-guest .bc-guest-pay-row').evaluateAll(els=>els.map(e=>({name:e.querySelector('.bc-guest-pay-name').textContent,paid:e.querySelector('.bc-guest-pay-paid').textContent,owed:e.querySelector('.bc-guest-pay-owed').textContent})));
    assert.deepEqual(guestRows.map(r=>r.name),['Tom (test)','Ada & Bea (test)'],'Per Guest names stay, with no internal payment prose');
    assert(guestRows.every(r=>/^€\d+\.\d{2}$/.test(r.paid)&&/^€\d+\.\d{2}$/.test(r.owed)),'paid and owed always show an amount');
    assert.equal(await page.locator('#bc-inv-per-guest .bc-create-guest-payment-link-btn').count(),0,'removing explanation must not remove collection fence');
    cases.push('per-guest-clean-with-collection-fence-intact');
    assert.equal(await page.locator('#bc-payment-history-card').evaluate(el=>el.parentElement.classList.contains('bc-drawer-overview-panel')),true,'history is its own card');
    assert.equal(await page.locator('#bc-payment-history-card').evaluate(el=>!!el.closest('#bc-overview-invoice')),false,'history left the Invoice card');
    assert.equal(await page.locator('#bc-payment-history-card').evaluate(el=>el.nextElementSibling&&el.nextElementSibling.id),'bc-move-bed','history sits above Move Bed');
    assert.equal(await page.locator('#bc-payment-history-body').isVisible(),false,'history collapsed until opened');
    await page.locator('#bc-payment-history-toggle').click();
    assert.equal(await page.locator('#bc-payment-history-body').isVisible(),true);
    assert.equal(await page.locator('.bc-history-item').count(),1);
    const summary=page.locator('.bc-history-item summary');
    assert.match(await summary.innerText(),/Paid bank transfer/);
    assert.match(await summary.innerText(),/€600.00/);
    assert.match(await summary.innerText(),/26 Sept 2026/);
    assert.match(await summary.innerText(),/All/);
    assert.equal(await page.locator('.bc-history-item').getAttribute('open'),null,'reference/link details tucked away');
    await summary.click();
    assert.equal(await page.locator('.bc-history-item .ctx-pay-record').isVisible(),true,'original receipt details retained');
    await summary.click();
    cases.push('compact-history-under-totals-visible-with-expandable-details');
    state.payments.rows[0].booking_guest_id=GUEST;await refresh();
    assert.equal(await page.locator('#bc-inv-per-guest .bc-create-guest-payment-link-btn').count(),0,'fully paid booking never offers collection even with guest-attributed receipts');
    cases.push('fully-paid-guest-attributed-receipt-no-collection');
    for(const amount of [0,18000,59999,60000,65000]){
      state.payments.rows[0].amount_paid_cents=amount;state.payments.rows[0].booking_guest_id=null;await refresh();
      assert.deepEqual(await page.locator('#bc-guest-names .bc-accom-pay-pebble').allTextContents(),amount>=60000?['Paid','Paid']:['Unpaid','Deposit Paid']);
      assert.equal(await page.locator('#bc-side-payment-meta .pill').filter({hasText:/^Paid$/}).count(),amount>=60000?1:0);
      assert.equal(await page.locator('#bc-inv-per-guest .muted').count(),0,'no explanatory prose');
      if(amount===65000)assert.match(await page.locator('#bc-side-payment-meta').innerText(),/Refund review/,'overpayment warning retained');
    }
    cases.push('unpaid-deposit-partial-exact-overpaid-booking-matrix');
    state.payments.rows[0].amount_paid_cents=60000;
    state.transfers=[{status:'confirmed',price_cents:5000,direction:'arrival'}];await refresh();
    assert.deepEqual(await page.locator('#bc-guest-names .bc-accom-pay-pebble').allTextContents(),['Unpaid','Deposit Paid'],'outstanding transfer means entire booking is not paid');
    assert.match(await page.locator('#bc-side-payment-meta').innerText(),/50.00/);
    assert.equal(await page.locator('.bc-block-pay-paid').count(),0);
    state.transfers[0].status='cancelled';await refresh();
    assert.deepEqual(await page.locator('#bc-guest-names .bc-accom-pay-pebble').allTextContents(),['Paid','Paid']);
    state.transfers=[];
    state.booking.total_amount_cents=null;state.guest_accommodation_lines=[];await refresh();
    assert.deepEqual(await page.locator('#bc-guest-names .bc-accom-pay-pebble').allTextContents(),['Unpaid','Deposit Paid'],'unknown total never implies paid');
    state.booking.total_amount_cents=60000;state.guest_accommodation_lines=detail.guest_accommodation_lines;
    state.payments.rows[0].payment_status='checkout_created';await refresh();
    assert.deepEqual(await page.locator('#bc-guest-names .bc-accom-pay-pebble').allTextContents(),['Unpaid','Deposit Paid'],'pending amount is not a receipt');
    cases.push('transfer-cancelled-transfer-unknown-total-pending-no-false-paid');
    const savedGuest=JSON.parse(JSON.stringify(state.booking_guests[1]));
    delete state.booking_guests[1].booking_guest_id;state.booking_guests[1].payment_status='deposit_paid';await refresh();
    const ada=page.locator('#bc-inv-per-guest .ctx-inv-guest-line').nth(1);
    if(await page.locator('#bc-per-guest-toggle').getAttribute('aria-expanded')!=='true') await page.locator('#bc-per-guest-toggle').click();
    assert.equal(await ada.locator('.bc-guest-pay-name').innerText(),'Ada & Bea (test)','unlinked guest has no internal fallback prose');
    assert.match(await ada.locator('.bc-guest-pay-paid').innerText(),/^€\d+\.\d{2}$/);
    assert.match(await ada.locator('.bc-guest-pay-owed').innerText(),/^€\d+\.\d{2}$/);
    state.booking_guests[1]=savedGuest;
    state.booking_guests[0].amount_paid_cents=9000;state.booking_guests[0].payment_status='paid';
    state.payments.rows=[
      {payment_id:'receipt-bank',payment_status:'paid',amount_paid_cents:51000,created_at:'2026-09-26T12:00:00Z',paid_at:'2026-09-26T12:01:00Z',metadata:{method:'bank_transfer',payment_scope:'booking'}},
      {payment_id:'receipt-cash',booking_guest_id:GUEST,payment_status:'paid',amount_paid_cents:9000,created_at:'2026-09-25T10:00:00Z',paid_at:'2026-09-25T10:01:00Z',metadata:{method:'cash',payment_scope:'guest',note:'<img src=x onerror=alert(1)> retained as text'}},
      {payment_id:'pending-link',payment_status:'checkout_created',amount_due_cents:1000,created_at:'2026-09-24T10:00:00Z',checkout_url:'https://checkout.stripe.com/c/pay/test-history',metadata:{source:'staff_payment_link'}},
      {payment_id:'failed-payment',payment_status:'failed',amount_due_cents:1500,created_at:'2026-09-23T10:00:00Z',metadata:{}}
    ];await refresh();
    assert.deepEqual(await page.locator('#bc-guest-names .bc-accom-pay-pebble').allTextContents(),['Paid','Paid']);
    assert.equal(await page.locator('.bc-history-item').count(),4,'each actual ledger item appears once');
    assert.match(await page.locator('.bc-history-item summary').allTextContents().then(x=>x.join(' ')),/Paid cash.*€90.00.*Tom/s);
    assert.equal(await page.locator('.bc-history-item img').count(),0,'receipt note escaped');
    const cash=page.locator('.bc-history-item').filter({has:page.locator('[data-payment-id="receipt-cash"]')});
    await cash.locator('summary').focus();await page.keyboard.press('Enter');
    assert.match(await cash.locator('.ctx-pay-record').innerText(),/<img src=x onerror=alert\(1\)>/);
    await page.keyboard.press('Enter');
    cases.push('mixed-ledger-once-attribution-escaped-details-keyboard');
    for(const width of [1440,390,320]){
      await page.setViewportSize({width,height:1000});
      for(const theme of ['light','dark']){
        await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),theme);
        await page.locator('.bc-invoice-history').scrollIntoViewIfNeeded();
        if(theme==='dark') assert.equal(await page.locator('.bc-history-amount.paid').first().evaluate(e=>getComputedStyle(e).color),'rgb(158, 224, 168)','dark history receipts match readable paid-amount palette');
        const layout=await page.locator('.bc-invoice-history').evaluate(e=>{
          const items=[...e.querySelectorAll('summary')].map(n=>({r:n.getBoundingClientRect().toJSON(),amount:n.querySelector('.bc-history-amount').getBoundingClientRect().toJSON(),overflow:n.scrollWidth>n.clientWidth}));
          return {items,width:innerWidth,overflow:e.scrollWidth>e.clientWidth,outer:{scroll:e.scrollWidth,client:e.clientWidth,rect:e.getBoundingClientRect().toJSON()},wide:[...e.querySelectorAll("*")].filter(n=>n.getBoundingClientRect().right>e.getBoundingClientRect().right+1).map(n=>({tag:n.tagName,id:n.id,cls:n.className,rect:n.getBoundingClientRect().toJSON(),style:{width:getComputedStyle(n).width,margin:getComputedStyle(n).margin,padding:getComputedStyle(n).padding}}))};
        });
        fs.writeFileSync(path.join(OUT,`history-layout-${width}-${theme}.json`),JSON.stringify(layout,null,2));
        assert(!layout.overflow && layout.items.every(i=>!i.overflow&&i.r.left>=0&&i.r.right<=width+1&&i.amount.right<=width+1),'history and amounts fit viewport');
        assert(layout.items.every(i=>Math.abs(i.amount.right-layout.items[0].amount.right)<1),'history amounts aligned');
        fs.writeFileSync(path.join(OUT,`history-layout-${width}-${theme}.json`),JSON.stringify(layout,null,2));
        await page.screenshot({path:path.join(OUT,`local-synthetic-history-${width}-${theme}.png`)});
        await page.locator('#bc-guest-names').scrollIntoViewIfNeeded();
        assert.equal(await page.locator('#bc-guest-names .bc-accom-pay-pebble.is-paid').count(),2);
        const names=await page.locator('#bc-guest-names .bc-guest-name-line').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().width));
        assert(names.every(w=>w>20),'saved guest names retain readable width');
        await page.screenshot({path:path.join(OUT,`local-synthetic-paid-${width}-${theme}.png`)});
      }
    }
    cases.push('history-and-paid-names-desktop-390-320-both-themes');
    await page.setViewportSize({width:1440,height:1000});
    for(const target of ['other','reopen']){
      await page.locator('#bc-side-close').click();
      holdTransfer=true;releaseTransfer=null;transferFlight='OBSOLETE-'+target;
      transferDirection=target==='reopen'?'departure':'arrival';
      await page.locator('.bc-block[data-bidx="0"]').click();await page.mouse.move(1300,500);
      await page.locator('#bc-refresh-links-btn').waitFor();
      const heldDeadline=Date.now()+3000;
      while(!releaseTransfer && Date.now()<heldDeadline)await new Promise(resolve=>setImmediate(resolve));
      assert.equal(typeof releaseTransfer,'function','A fallback GET held before ordinary booking switch');
      const releaseOld=releaseTransfer;
      await page.locator('#bc-side-close').click();
      await page.locator('.bc-block[data-bidx="2"]').click();await page.mouse.move(1300,500);
      await page.waitForFunction(id=>document.getElementById('bc-side-drawer').getAttribute('data-mounted-booking-id')===id,other.booking.booking_id);
      if(target==='reopen'){
        transferFlight='CURRENT-REOPEN';transferDirection='arrival';
        await page.locator('#bc-side-close').click();
        await page.locator('.bc-block[data-bidx="0"]').click();await page.mouse.move(1300,500);
        await page.waitForFunction(id=>document.getElementById('bc-side-drawer').getAttribute('data-mounted-booking-id')===id,booking.booking_id);
      }
      await page.waitForFunction(()=>!document.getElementById('bc-transfer-cards').classList.contains('ctx-loading'));
      const before=await financialSnapshot();
      const chromeBefore=await page.locator('#bc-transfer-cards').innerHTML();
      const badgeBefore=await page.locator('#bc-side-payment-meta .transfer-pebble').allTextContents();
      const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/staff/bookings/${booking.booking_id}/transfers`);
      releaseOld();await (await response).finished();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const after=await financialSnapshot();
      const badgeAfter=await page.locator('#bc-side-payment-meta .transfer-pebble').allTextContents();
      transferObservations.push({name:'switch-'+target,before,after,badgeBefore,badgeAfter});
      assert.deepEqual(after,before,'old A fallback cannot change current financial state');
      assert.deepEqual(badgeAfter,badgeBefore,'old A fallback cannot change current Transfer badge');
      assert.equal(await page.locator('#bc-transfer-cards').innerHTML(),chromeBefore,'old A fallback cannot replace current Transfer controls');
      await page.locator('.bc-drawer-tab[data-tab="transfers"]').click();
      assert.equal(await page.locator('#bc-transfer-arrival-flight').inputValue(),target==='reopen'?'CURRENT-REOPEN':'','current Transfer form remains usable');
      await page.locator('#bc-transfer-arrival-flight').fill('LOCAL-ONLY');
      await page.locator('.bc-drawer-tab[data-tab="overview"]').click();
      cases.push('delayed-transfer-booking-switch-'+target);
    }
    assert.equal(cases.length,11,'complete addendum matrix');
    async function openBooking(index){
      await page.locator('#bc-side-close').click();
      await page.locator(`.bc-block[data-bidx="${index}"]`).click();await page.mouse.move(1300,500);
      await page.locator('#bc-refresh-links-btn').waitFor();
      await page.waitForFunction(()=>!document.getElementById('bc-transfer-cards').classList.contains('ctx-loading'));
    }
    async function settleBrowser(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
    async function transferCase(action,payloadKind,outcome='failed',target='current'){
      const name=`transfer-${action}-${payloadKind}-${outcome}-${target}`;
      state.payments.rows=[{payment_id:'receipt-all',payment_status:'paid',amount_paid_cents:60000,metadata:{method:'bank_transfer',payment_scope:'booking'}}];
      state.transfers=[];
      const payload=transferPayload(action==='remove'?[{id:'synthetic-transfer',direction:'departure',status:'requested',flight_number:'REMOVE-ME',scheduled_at_local:'2026-09-29T10:00',price_cents:0}]:[]);assert.equal(Object.hasOwn(payload,'booking'),false);
      state.transfers_drawer=payloadKind==='embedded'?payload:null;fallbackPayload=payload;
      await openBooking(0);
      const before=await financialSnapshot();assert.deepEqual(before.header,['Paid']);
      await page.locator('.bc-drawer-tab[data-tab="transfers"]').click();
      if(action==='save'){
        await page.locator('#bc-transfer-departure-scheduled').fill('2026-09-29T10:00');
        await page.locator('.bc-transfer-override-toggle[data-direction="departure"]').click();
        await page.locator('#bc-transfer-departure-override-amount').fill('0');
      }
      const authoritative=JSON.parse(JSON.stringify(state));authoritative.payments.rows[0].amount_paid_cents=18000;
      authoritative.transfers=action==='save'?[{id:'synthetic-transfer',direction:'departure',status:'requested',price_cents:0}]:[];
      authoritative.transfers_drawer=payloadKind==='embedded'?transferPayload(authoritative.transfers):null;
      const pending={action,failed:outcome==='failed',data:authoritative};mutation=pending;
      await page.locator(`.bc-transfer-${action}[data-direction="departure"]`).click();
      const deadline=Date.now()+3000;
      while(!pending.release && Date.now()<deadline)await new Promise(resolve=>setImmediate(resolve));
      assert.equal(typeof pending.release,'function','authoritative follow-up held after registered '+action);
      const held=await financialSnapshot();
      transferObservations.push({name:name+'-held',before,after:held});
      assert.deepEqual(held,before,action+' while authoritative read is held preserves all known finance');
      assert.equal(await page.locator('#bc-side-payment-meta .transfer-pebble').count(),action==='save'?1:0);
      assert.equal(await page.locator('.bc-block[data-bidx="0"] .transfer-pebble').count(),action==='save'?1:0);
      if(action==='remove')assert.equal(await page.locator('#bc-transfer-departure-flight').inputValue(),'');
      if(target==='other'||target==='reopen'){
        await openBooking(2);
        if(target==='reopen')await openBooking(0);
      }else if(target==='invoice'){
        await page.locator('.bc-drawer-tab[data-tab="overview"]').click();await refresh();
      }
      const beforeRelease=await financialSnapshot();
      const chromeBefore=await page.locator('#bc-transfer-cards').innerHTML();
      const badgesBefore=await page.locator('.transfer-pebble').allTextContents();
      const response=page.waitForResponse(r=>r.url().includes('/context')&&r.status()===(pending.failed?503:200));
      pending.release();await (await response).finished();await settleBrowser();
      const after=await financialSnapshot(outcome==='success'&&target==='current'?[1,2,1]:[1,1,1]);
      transferObservations.push({name,before:beforeRelease,after});
      if(outcome==='failed'||target!=='current'){
        assert.deepEqual(after,beforeRelease,action+' failed/stale authoritative read retains current finance');
        assert.equal(await page.locator('#bc-transfer-cards').innerHTML(),chromeBefore,'late read preserves current Transfer controls');
        assert.deepEqual(await page.locator('.transfer-pebble').allTextContents(),badgesBefore,'late read preserves current Transfer badges');
      }else{
        assert.match(after.totals,/Paid€180.00/,'successful authoritative read applies changed paid amount');
        assert.match(after.totals,/€420.00/,'successful authoritative read applies changed balance');
        assert(!after.header.includes('Paid'),'no obsolete booking Paid');
        assert.deepEqual(after.guests,['Deposit Paid','Deposit Paid']);
        assert(after.beds.slice(0,2).every(b=>!b.payment.includes('Paid')),'calendar reflects authoritative changed finance');
        assert.equal(await page.locator('#bc-side-payment-meta .transfer-pebble').count(),action==='save'?1:0,'authoritative finance keeps drawer Transfer badge');
        assert.equal(await page.locator('.bc-block[data-bidx="0"] .transfer-pebble').count(),action==='save'?1:0,'authoritative finance keeps calendar Transfer badge');
      }
      await page.locator('.bc-drawer-tab[data-tab="overview"]').click();
      cases.push(name);
    }
    for(const action of ['save','remove'])for(const payloadKind of ['embedded','fallback'])for(const outcome of ['failed','success'])for(const target of ['current','invoice','other','reopen'])await transferCase(action,payloadKind,outcome,target);
    assert.equal(cases.length,43,'original eleven plus complete Transfer follow-up read matrix');
    async function lateMutationCase(action,writeOutcome,target){
      const name=`late-${action}-${writeOutcome}-${target}`;
      state.payments.rows[0].amount_paid_cents=60000;
      state.transfers_drawer=transferPayload(action==='remove'?[{id:'synthetic-transfer',direction:'departure',status:'requested',flight_number:'REMOVE-ME',price_cents:0}]:[]);
      await openBooking(0);
      await page.locator('.bc-drawer-tab[data-tab="transfers"]').click();
      if(action==='save'){
        await page.locator('#bc-transfer-departure-scheduled').fill('2026-09-29T10:00');
        await page.locator('.bc-transfer-override-toggle[data-direction="departure"]').click();
        await page.locator('#bc-transfer-departure-override-amount').fill('0');
      }
      const pending={action,holdWrite:true,writeOutcome};mutation=pending;
      await page.locator(`.bc-transfer-${action}[data-direction="departure"]`).click();
      const deadline=Date.now()+3000;
      while(!pending.releaseWrite&&Date.now()<deadline)await new Promise(resolve=>setImmediate(resolve));
      assert.equal(typeof pending.releaseWrite,'function','registered mutation held');
      await openBooking(2);if(target==='reopen')await openBooking(0);
      const before=await financialSnapshot();
      const chromeBefore=await page.locator('#bc-transfer-cards').innerHTML();
      const badgesBefore=await page.locator('.transfer-pebble').allTextContents();
      const readsBefore=ledger.filter(e=>e.url.includes('/context')).length;
      const finished=page.waitForEvent(writeOutcome==='network'?'requestfailed':'requestfinished',{predicate:r=>r.method()===(action==='save'?'POST':'DELETE')});
      pending.releaseWrite();await finished;await settleBrowser();
      const after=await financialSnapshot();transferObservations.push({name,before,after});
      assert.deepEqual(after,before,'old mutation cannot alter current finance');
      assert.equal(await page.locator('#bc-transfer-cards').innerHTML(),chromeBefore,'old mutation success/error cannot alter current Transfer controls');
      assert.deepEqual(await page.locator('.transfer-pebble').allTextContents(),badgesBefore,'old mutation cannot alter current Transfer badges');
      assert.equal(ledger.filter(e=>e.url.includes('/context')).length,readsBefore,'old mutation cannot start a context read on the new mount');
      followup=null;
      cases.push(name);
    }
    for(const action of ['save','remove'])for(const writeOutcome of ['success','failed','network'])for(const target of ['other','reopen'])await lateMutationCase(action,writeOutcome,target);
    assert.equal(cases.length,55,'eleven retained plus 32 follow-up and 12 late mutation cases');
    async function waitHeld(pending){
      const deadline=Date.now()+3000;
      while(!pending.release&&Date.now()<deadline)await new Promise(resolve=>setImmediate(resolve));
      assert.equal(typeof pending.release,'function','registered operation financial read held');
    }
    async function releaseRead(pending){
      const done=page.waitForResponse(r=>new URL(r.url()).pathname===`/staff/bookings/${CODE}/context`);
      pending.release();await(await done).finished();await settleBrowser();
    }
    async function overlappingTransfers(payloadKind,order,target,latestPaid){
      const name=`overlap-${payloadKind}-${order}-${target}-${latestPaid}`;
      state.payments.rows=[{payment_id:'receipt-all',payment_status:'paid',amount_paid_cents:60000,metadata:{method:'bank_transfer',payment_scope:'booking'}}];
      state.transfers=[];fallbackPayload=transferPayload([]);
      assert.equal(Object.hasOwn(fallbackPayload,'booking'),false,'production Transfer payload has no booking snapshot');
      state.transfers_drawer=payloadKind==='embedded'?fallbackPayload:null;
      await openBooking(0);
      const mounted=await page.locator('#bc-transfer-cards').elementHandle();
      await page.locator('.bc-drawer-tab[data-tab="transfers"]').click();
      await page.locator('#bc-transfer-departure-scheduled').fill('2026-09-29T10:00');
      await page.locator('.bc-transfer-override-toggle[data-direction="departure"]').click();
      await page.locator('#bc-transfer-departure-override-amount').fill('50');
      const saved=JSON.parse(JSON.stringify(state));
      saved.transfers=[{id:'synthetic-transfer',direction:'departure',status:'requested',price_cents:5000}];
      saved.transfers_drawer=payloadKind==='embedded'?transferPayload(saved.transfers):null;
      const first={action:'save',priceEuros:50,data:saved};mutation=first;
      await page.locator('.bc-transfer-save[data-direction="departure"]').click();await waitHeld(first);
      const removed=JSON.parse(JSON.stringify(state));removed.payments.rows[0].amount_paid_cents=latestPaid;
      const second={action:'remove',data:removed,failed:target==='failed'};mutation=second;
      await page.locator('.bc-transfer-remove[data-direction="departure"]').click();await waitHeld(second);
      assert(await mounted.evaluate(e=>e===document.getElementById('bc-transfer-cards')&&e.isConnected),'both operations share one real mount');
      assert.equal(await page.locator('#bc-transfer-departure-flight').inputValue(),'','registered Remove clears form');
      assert.equal(await page.locator('.transfer-pebble').count(),0,'registered Remove clears Transfer chrome');
      if(target==='invoice'){
        state.payments.rows[0].amount_paid_cents=30000; // Distinct from both held responses.
        await page.locator('.bc-drawer-tab[data-tab="overview"]').click();await refresh();
      }else if(target==='other'||target==='reopen'){
        await openBooking(2);if(target==='reopen')await openBooking(0);
      }
      const counts=target==='invoice'?[1,2,1]:[1,1,1];
      const before=await financialSnapshot(counts);
      const chromeBefore=await page.locator('#bc-transfer-cards').innerHTML();
      const badgesBefore=await page.locator('.transfer-pebble').allTextContents();
      const sequence=order==='save-first'?[first,second]:[second,first];
      const observation={name,before,releases:[],firstAuthoritative:{invoiceTotal:65000,paid:60000,balance:5000},secondAuthoritative:{invoiceTotal:60000,paid:latestPaid,balance:60000-latestPaid,failed:second.failed}};
      transferObservations.push(observation);
      for(const pending of sequence){
        await releaseRead(pending);
        const applies=target==='current'&&(pending===second||order==='remove-first');
        const totals=await page.locator('#bc-inv-totals').textContent();
        observation.releases.push({action:pending.action,totals});
        if(!applies)assert.equal(totals,before.totals,'obsolete Save must not apply once Remove owns the financial read');
        const after=await financialSnapshot(applies&&latestPaid===18000?[1,2,1]:counts);
        observation.releases.push({action:pending.action,after});
        if(applies){
          assert.match(after.totals,/Invoice total€600.00/,'latest Remove total wins, never obsolete Save €650');
          assert.match(after.totals,latestPaid===60000?/Paid€600.00Paid in full/:/Paid€180.00Balance due€420.00/,'latest current authoritative read applies');
          assert.deepEqual(after.guests,latestPaid===60000?['Paid','Paid']:['Deposit Paid','Deposit Paid']);
          assert.equal(after.header.includes('Paid'),latestPaid===60000);
        }else assert.deepEqual(after,before,'obsolete success never replays, including before/after later read failure');
        assert.equal(await page.locator('#bc-transfer-cards').innerHTML(),chromeBefore,'overlap keeps current Transfer controls');
        assert.deepEqual(await page.locator('.transfer-pebble').allTextContents(),badgesBefore,'overlap keeps current Transfer badges');
      }
      cases.push(name);
    }
    for(const payloadKind of ['embedded','fallback'])for(const order of ['save-first','remove-first']){
      await overlappingTransfers(payloadKind,order,'current',60000); // Exact R3 figures.
      for(const target of ['current','failed','invoice','other','reopen'])await overlappingTransfers(payloadKind,order,target,18000);
    }
    assert.equal(cases.length,79,'55 retained plus 24 registered same-mount overlap groups');
  }catch(e){failure=e.stack;}
  finally{
    fs.writeFileSync(path.join(OUT,'transfer-observations.json'),JSON.stringify(transferObservations,null,2));
    await page.screenshot({path:path.join(OUT,'local-synthetic-addendum.png')});
    fs.writeFileSync(path.join(OUT,'network.json'),JSON.stringify({ledger,errors},null,2));
    const blocked=ledger.filter(e=>e.unknown||(e.blocked && !e.url.startsWith('https://fonts.googleapis.com/')));
    if(errors.length||blocked.length)failure=(failure||'')+'\nIsolation/errors: '+JSON.stringify({errors,blocked});
    fs.writeFileSync(path.join(OUT,'results.json'),JSON.stringify({cases,failure,localSynthetic:true},null,2));
    console.log(JSON.stringify({cases,failure,out:OUT},null,2));
    await browser.close();
  }
  if(failure)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
