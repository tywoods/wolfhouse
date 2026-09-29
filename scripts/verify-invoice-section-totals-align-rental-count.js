'use strict';
// Offline production HTML; ordinary calendar entry with viewport set before opening.
// Usage: node scripts/verify-invoice-section-totals-align-rental-count.js <evidence-dir> <mode>
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { emit, calendar, detail, CODE } = require('./verify-booking-drawer-invoice-tab');
const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
const { buildManualBookingServiceRecordRows } = require('./lib/manual-booking-service-records');
const { normalizeSplitRentalMetadata } = require('./lib/service-record-invoice-line');
const ROOT = path.resolve(__dirname, '..'), OUT = path.resolve(process.argv[2]);
const MODE = process.argv[3] || 'full', ORIGIN = 'http://staff.test';
const clone = x => JSON.parse(JSON.stringify(x));
const names = ['Alexandria Verylongsurname (test)', 'Tom & Teresa Longsurname (test)', 'Zoë Longsurname (test)', 'Sam (test)'];
function fixture() {
  const s = clone(detail);
  s.booking = {...s.booking, guest_count:4, guest_name:names[0], total_amount_cents:120000, accommodation_total_cents:120000, deposit_required_cents:36000, amount_paid_cents:9000, balance_due_cents:111000};
  s.booking_guests = names.map((name,i)=>({...clone(detail.booking_guests[0]),booking_guest_id:`bbbbbbbb-bbbb-4bbb-8bbb-${String(i+1).padStart(12,'0')}`,guest_number:i+1,guest_name:name,assigned_bed_code:['R1-B1','R1-B12','R2-B3','R2-B14'][i],amount_paid_cents:i===1?9000:0,payment_status:i===1?'paid':'not_requested'}));
  s.guest_accommodation_lines = names.map((_,i)=>({guest_number:i+1,accommodation_cents:30000,nights:5}));
  s.payments = {paid_total_cents:9000,rows:[]};
  return s;
}
async function main() {
  fs.mkdirSync(OUT,{recursive:true});
  const html = process.env.INVOICE_TEST_HTML ? fs.readFileSync(process.env.INVOICE_TEST_HTML,'utf8') : emit('wolfhouse-somo',OUT);
  const ledger=[],errors=[],cases=[],observations=[]; let state=fixture(),failure;
  const browser=await chromium.launch({headless:true});
  const ctx=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await ctx.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url()),e={method:req.method(),url:req.url()};ledger.push(e);
    // Optional hosted font is deliberately not fetched; screenshots use fallback fonts.
    if(req.method()==='GET'&&u.origin==='https://fonts.googleapis.com'&&u.pathname==='/css2'){e.optionalFontAborted=true;return route.abort();}
    if(u.origin!==ORIGIN||req.method()!=='GET'){e.blocked=true;return route.abort();}
    const p=u.pathname;let data;
    if(p==='/staff/ui')return route.fulfill({contentType:'text/html',body:html});
    if(p==='/staff/bed-calendar')data=calendar;
    else if(p===`/staff/bookings/${CODE}/context`)data=state;
    else if(p==='/staff/auth/session')data={success:true,auth_required:false,role:'admin',clients:[{slug:'wolfhouse-somo',name:'Wolfhouse'}],client_profiles:{'wolfhouse-somo':loadClientPortalProfile('wolfhouse-somo')}};
    else if(p.startsWith('/staff/assets/')){const a=path.join(ROOT,'config/staff-portal',path.basename(p));if(fs.existsSync(a))return route.fulfill({path:a});e.unknown=true;return route.abort();}
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
    else if(p===`/staff/bookings/${detail.booking.booking_id}/services`)data={success:true,paid_requested_services:[],unscheduled_services:[],services_by_date:[]};
    else if(p===`/staff/bookings/${detail.booking.booking_id}/transfers`)data={success:true,transfers:[]};
    else if(p==='/staff/clients')data={success:true,clients:[{slug:'wolfhouse-somo',name:'Wolfhouse'}]};
    else {e.unknown=true;return route.abort();}
    return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await ctx.addInitScript(()=>{localStorage.setItem('wh_staff_portal_locale','en');window.WebSocket=function(){throw Error('Offline WebSocket denied');};window.EventSource=function(){throw Error('Offline EventSource denied');};});
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(String(e)));
  async function open(width=1440,theme='light') {
    await page.setViewportSize({width,height:1000});
    await page.goto(ORIGIN+'/staff/ui');
    await page.waitForFunction(()=>typeof window.switchToTab==='function'&&document.getElementById('c-client').value==='wolfhouse-somo');
    await page.evaluate(()=>window.switchToTab('bed-calendar'));
    await page.locator('.bc-block').first().click();await page.mouse.move(10,500);
    await page.locator('#bc-inv-totals').waitFor();
    await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),theme);
    assert(await page.locator(width<=768?'#bc-detail #bc-drawer-card-booking':'#bc-side-drawer #bc-drawer-card-booking').isVisible(),'ordinary active mount');
  }
  async function sectionTotal(section,value) {
    const total=page.locator(`#bc-inv-${section} .bc-invoice-section-total`);
    assert.equal(await total.count(),1,section+' has one distinct Total row');
    assert.equal(await total.locator('.ctx-inv-total-label').innerText(),'Total');
    assert.equal(await total.locator('.ctx-inv-total-amount').innerText(),value);
  }
  try {
    if(MODE==='accommodation'||MODE==='full') {
      await open();await sectionTotal('accommodation','€1200.00');
      cases.push('accommodation-distinct-total');
    }
    if(MODE==='services'||MODE==='full') {
      state=fixture();state.service_records=[{id:'service-one',service_type:'yoga',quantity:2,amount_due_cents:4000,status:'confirmed',metadata:{}}];
      await open();await sectionTotal('services','€40.00');cases.push('services-charge-total');
      state.service_records=[];await open();assert.equal(await page.locator('#bc-inv-services .bc-invoice-section-total').count(),0);cases.push('services-empty-no-total');
      state.service_records=[{id:'free',service_type:'wetsuit',quantity:1,amount_due_cents:0,metadata:{combo_part:'wetsuit',rental_days:1,rental_people:4}}];
      await open();assert.equal(await page.locator('#bc-inv-services .bc-invoice-section-total').count(),0);cases.push('services-free-no-total');
    }
    if(MODE==='transfers'||MODE==='full') {
      state=fixture();state.transfers=[{direction:'arrival',status:'confirmed',price_cents:4000},{direction:'departure',status:'requested',price_cents:3500},{direction:'arrival',status:'cancelled',price_cents:9999}];
      await open();await sectionTotal('transfers','€75.00');cases.push('transfers-active-charge-total');
      state.transfers=[{direction:'arrival',status:'confirmed',price_cents:0},{direction:'departure',status:'cancelled',price_cents:3500}];
      await open();assert.equal(await page.locator('#bc-inv-transfers .bc-invoice-section-total').count(),0);cases.push('transfers-free-cancelled-no-total');
      state.transfers=[];await open();assert.equal(await page.locator('#bc-inv-transfers .bc-invoice-section-total').count(),0);cases.push('transfers-empty-no-total');
    }
    if(MODE==='order'||MODE==='full') {
      state=fixture();await open();
      const order=await page.locator('#bc-overview-invoice > [id]').evaluateAll(es=>es.map(e=>e.id));
      observations.push({order});
      assert(!order.includes('bc-inv-per-guest'),'Per Guest is outside the invoice card');
      assert(order.indexOf('bc-inv-transfers')<order.indexOf('bc-inv-totals'),'Transfers before Totals');
      assert(order.indexOf('bc-inv-totals')<order.indexOf('bc-invoice-actions'),'Totals before actions');
      const siblings=await page.locator('#bc-overview-invoice,#bc-per-guest-card,#bc-payment-history-card').evaluateAll(es=>es.map(e=>e.id));
      assert(siblings.indexOf('bc-overview-invoice')<siblings.indexOf('bc-per-guest-card')&&siblings.indexOf('bc-per-guest-card')<siblings.indexOf('bc-payment-history-card'),'Per Guest sits above Payment History');
      assert.equal(await page.locator('#bc-per-guest-toggle').getAttribute('aria-expanded'),'false','Per Guest collapsed by default');
      assert.equal(await page.locator('#bc-inv-per-guest').count(),1);cases.push('transfers-per-guest-totals-actions-order');
    }
    if(MODE==='layout'||MODE==='full') {
      for(const paid of [false,true])for(const width of [1440,390,320])for(const theme of ['light','dark']) {
        state=fixture();
        if(paid){state.booking.amount_paid_cents=120000;state.payments.rows=[{payment_id:'paid-all',payment_status:'paid',amount_paid_cents:120000,metadata:{payment_scope:'booking',method:'cash'}}];}
        await open(width,theme);await page.locator('#bc-guest-names').scrollIntoViewIfNeeded();
        const rows=await page.locator('#bc-guest-names .bc-guest-name-row').evaluateAll(es=>es.map(e=>{const n=e.querySelector('.bc-guest-name-line'),b=e.querySelector('.bc-guest-bed'),s=e.querySelector('.bc-accom-pay-pebble');return {name:n.textContent,status:s.textContent,row:e.getBoundingClientRect().toJSON(),n:n.getBoundingClientRect().toJSON(),b:b.getBoundingClientRect().toJSON(),s:s.getBoundingClientRect().toJSON()};}));
        observations.push({width,theme,paid,rows});
        await page.screenshot({path:path.join(OUT,`names-${width}-${theme}-${paid?'paid':'partial'}.png`)});
        assert.equal(rows.length,4);assert.deepEqual(rows.map(r=>r.name),names);
        for(const [index,r] of rows.entries()){
          if(width<=768){
            const readable=await page.locator('#bc-guest-names .bc-guest-name-row').nth(index).evaluate(e=>{
              const n=e.querySelector('.bc-guest-name-line'),style=getComputedStyle(n),ctx=document.createElement('canvas').getContext('2d');
              ctx.font=style.fontWeight+' '+style.fontSize+' '+style.fontFamily;
              const textFits=selector=>{const el=e.querySelector(selector),range=document.createRange();range.selectNodeContents(el);const text=range.getBoundingClientRect(),box=el.getBoundingClientRect();return text.left>=box.left-1&&text.right<=box.right+1&&el.scrollWidth<=el.clientWidth+1;};
              return {shortNameWidth:ctx.measureText('Tyler').width,whiteSpace:style.whiteSpace,overflow:style.overflow,textOverflow:style.textOverflow,bedFits:textFits('.bc-guest-bed'),statusFits:textFits('.bc-accom-pay-pebble')};
            });
            assert(r.n.width>=readable.shortNameWidth,'mobile name allocation can display a basic short name');
            assert.deepEqual([readable.whiteSpace,readable.overflow,readable.textOverflow],['nowrap','hidden','ellipsis'],'mobile long names use safe ellipsis; full names retained above');
            assert(readable.bedFits&&readable.statusFits,'mobile bed and payment labels remain fully readable');
            assert(r.n.right<=r.b.left+1&&r.b.right<=r.s.left+1,'mobile name, bed and payment never overlap');
            const center=box=>(box.top+box.bottom)/2;
            assert(Math.abs(center(r.n)-center(r.b))<=1&&Math.abs(center(r.n)-center(r.s))<=1,'mobile name, bed and payment share one centered line');
          }else{assert(r.n.width>=100,'readable name width');}
          assert(r.n.left>=0&&r.s.right<=width+1,'viewport containment');assert(Math.abs(r.b.right-rows[0].b.right)<=1,'bed right edges align across guest rows');assert(Math.abs(r.s.right-rows[0].s.right)<=1,'status right edges align across guest rows');assert(Math.abs(r.b.top-r.s.top)<=2,'bed and status share aligned right-hand line');
        }
        assert.deepEqual(rows.map(r=>r.status),paid?['Paid','Paid','Paid','Paid']:['Unpaid','Deposit Paid','Unpaid','Unpaid']);
        cases.push(`layout-${width}-${theme}-${paid?'paid':'partial'}`);
      }
    }
    if(MODE==='rentals'||MODE==='preservation'||MODE==='full') {
      // Source-generated manual rows: quantity is days, rental_people is the explicit
      // participant count. This is characterization, NOT the unavailable reported case.
      for(const people of [1,2,4,6])for(const shape of ['object','json']) {
        state=fixture();const addOns=[{code:'soft_top_rental',days:5,quantity:people}];
        const quote=calculateWolfhouseQuote({client_slug:'wolfhouse-somo',check_in:'2026-09-24',check_out:'2026-09-29',guest_count:4,package_code:'package_none',payment_choice:'deposit',add_ons:addOns});
        state.service_records=buildManualBookingServiceRecordRows({addOns,quote,clientSlug:'wolfhouse-somo',bookingId:state.booking.booking_id,bookingCode:CODE,guestCount:4});
        assert.equal(state.service_records.length,1);assert.equal(state.service_records[0].quantity,5);assert.equal(state.service_records[0].metadata.rental_people,people);
        state.service_records[0].service_record_id='source-rental';
        if(shape==='json')state.service_records[0].metadata=JSON.stringify(state.service_records[0].metadata);
        const before=JSON.stringify(state);await open();
        const text=await page.locator('#bc-inv-services .ctx-inv-addon-line').innerText();
        assert.match(text,new RegExp(`5 rental days × ${people} ${people===1?'person':'people'}`));
        assert.equal(JSON.stringify(state),before,'render never mutates source money/quantity');
        observations.push({rental:{people,shape,rows:clone(state.service_records),text}});cases.push(`rental-generated-${people}-${shape}`);
      }
      state=fixture();
      state.service_records=[0,1,2,3,4].map(i=>({service_record_id:'split-'+i,service_type:'surfboard',quantity:1,amount_due_cents:6000,status:'confirmed',service_date:`2026-09-${24+i}`,metadata:normalizeSplitRentalMetadata({rental_days:5,rental_people:4,board_variant:'soft',staff_ui_service_type:'soft_board',split_from:'source-rental',split_unit:i+1},'surfboard')}));
      await open();const splitText=await page.locator('#bc-inv-services .ctx-inv-addon-line').innerText();
      assert.match(splitText,/5 rental days × 4 people = €300.00/);observations.push({rental:{splitRows:clone(state.service_records),text:splitText}});cases.push('rental-five-dates-four-people');
      state.service_records[4].status='cancelled';await open();
      observations.push({diagnostic:'legacy cancelled rental row remains in context and display; money/count repair not authorized without reported source',text:await page.locator('#bc-inv-services').innerText(),totals:await page.locator('#bc-inv-totals').innerText()});
    }
    if(MODE==='preservation'||MODE==='full') {
      for(const scenario of ['unknown','zero','supplement','bundled','additional']) {
        state=fixture();state.guest_accommodation_lines=[];state.booking.amount_paid_cents=0;state.payments={rows:[]};
        let expectedAcc,expectedTotal;
        if(scenario==='unknown'){state.booking.total_amount_cents=null;state.booking.accommodation_total_cents=null;expectedAcc='—';expectedTotal=null;}
        if(scenario==='zero'){state.booking.total_amount_cents=0;expectedAcc='€0.00';expectedTotal='€0.00';}
        if(scenario==='supplement'){state.booking.total_amount_cents=120000;state.booking.metadata={quote_snapshot:{line_items:[{code:'accommodation_only',total_cents:110000},{code:'room_supplement',total_cents:10000}]}};expectedAcc='€1200.00';expectedTotal='€1200.00';}
        if(scenario==='bundled'||scenario==='additional'){
          state.service_records=[{service_record_id:'included-service',service_type:'yoga',quantity:1,amount_due_cents:4000,status:'confirmed',metadata:scenario==='additional'?{invoice_total_inclusion:'additional'}:{}}];
          expectedAcc=scenario==='bundled'?'€1160.00':'€1200.00';expectedTotal=scenario==='bundled'?'€1200.00':'€1240.00';
        }
        const before=JSON.stringify(state);await open();
        if(MODE==='full')await sectionTotal('accommodation',expectedAcc);
        const amounts=await page.locator('#bc-inv-totals .ctx-inv-total-amount').allTextContents();
        if(expectedTotal!==null)assert.equal(amounts[0],expectedTotal);else assert(!(await page.locator('#bc-inv-totals').innerText()).includes('Invoice total'));
        assert.equal(JSON.stringify(state),before);observations.push({money:scenario,amounts,totals:await page.locator('#bc-inv-totals').innerText()});cases.push('money-'+scenario);
      }
    }
    if(MODE==='lifecycle'||MODE==='full') {
      for(const width of [1440,390,320])for(const theme of ['light','dark']) {
        state=fixture();await open(width,theme);
        state.service_records=[{service_record_id:'new-service',service_type:'yoga',quantity:2,amount_due_cents:4000,status:'confirmed',metadata:{invoice_total_inclusion:'additional'}}];
        state.transfers=[{direction:'arrival',status:'confirmed',price_cents:3500}];
        const done=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/context'));
        await page.locator('#bc-refresh-links-btn').click();await done;
        await page.waitForFunction(()=>document.querySelector('#bc-inv-services .bc-invoice-section-total'));
        await sectionTotal('accommodation','€1200.00');await sectionTotal('services','€40.00');await sectionTotal('transfers','€35.00');
        assert.match(await page.locator('#bc-inv-totals').innerText(),/€1275.00/);
        await open(width,theme);await sectionTotal('services','€40.00');await sectionTotal('transfers','€35.00');
        for(const target of ['bc-inv-accommodation','bc-inv-transfers','bc-inv-totals']) {
          await page.locator('#'+target).scrollIntoViewIfNeeded();
          const box=await page.locator('#'+target).boundingBox();assert(box&&box.y>=0&&box.y<1000,'screenshot target visible');
          await page.screenshot({path:path.join(OUT,`${target}-${width}-${theme}.png`)});
        }
        const order=await page.locator('#bc-overview-invoice > [id]').evaluateAll(es=>es.map(e=>e.id));
        assert(!order.includes('bc-inv-per-guest')&&order.indexOf('bc-inv-transfers')<order.indexOf('bc-inv-totals')&&order.indexOf('bc-inv-totals')<order.indexOf('bc-invoice-actions'));
        await page.locator('#bc-record-payment-btn').click();assert.equal(await page.locator('#bc-payment-scope').inputValue(),'booking');assert.equal(await page.locator('#bc-payment-amount').inputValue(),'');assert.equal(await page.locator('[name="bc-payment-method"]:checked').count(),0);await page.keyboard.press('Escape');
        observations.push({lifecycle:{width,theme,order,totals:await page.locator('#bc-inv-totals').innerText()}});cases.push(`refresh-reopen-defaults-${width}-${theme}`);
      }
    }
    if(MODE==='rental-count'||MODE==='full') {
      state=fixture();const addOns=[{code:'soft_top_rental',days:5,quantity:4}];
      const quote=calculateWolfhouseQuote({client_slug:'wolfhouse-somo',check_in:'2026-09-24',check_out:'2026-09-29',guest_count:4,package_code:'package_none',payment_choice:'deposit',add_ons:addOns});
      state.service_records=buildManualBookingServiceRecordRows({addOns,quote,clientSlug:'wolfhouse-somo',bookingId:state.booking.booking_id,bookingCode:CODE,guestCount:4});
      await open();await page.locator('.bc-guest-services').scrollIntoViewIfNeeded();
      const summary=await page.locator('.bc-guest-services').innerText();
      observations.push({reportedCountReproducer:{rows:clone(state.service_records),summary,invoiceLine:await page.locator('#bc-inv-services .ctx-inv-addon-line').innerText()}});
      await page.screenshot({path:path.join(OUT,'rental-count-summary.png')});
      assert.equal(summary,'surfboard — 5 rental days × 4 people','rental summary must distinguish days from participants');cases.push('rental-summary-four-people-not-five-days');
      for(const people of [1,2,4,6])for(const shape of ['object','json']) {
        const addOns=[{code:'soft_top_rental',days:people===1?1:5,quantity:people}];
        const quote=calculateWolfhouseQuote({client_slug:'wolfhouse-somo',check_in:'2026-09-24',check_out:'2026-09-29',guest_count:4,package_code:'package_none',payment_choice:'deposit',add_ons:addOns});
        state=fixture();state.service_records=buildManualBookingServiceRecordRows({addOns,quote,clientSlug:'wolfhouse-somo',bookingId:state.booking.booking_id,bookingCode:CODE,guestCount:4});
        if(shape==='json')state.service_records[0].metadata=JSON.stringify(state.service_records[0].metadata);
        const before=JSON.stringify(state);await open();
        const summary=await page.locator('.bc-guest-services').innerText();
        assert.equal(summary,`surfboard — ${people===1?'1 rental day':'5 rental days'} × ${people} ${people===1?'person':'people'}`);
        assert.equal(JSON.stringify(state),before);
        observations.push({summary,rows:clone(state.service_records)});cases.push(`summary-generated-${people}-${shape}`);
      }
      for(const people of [1,2,4,6])for(const shape of ['object','json']) {
        state=fixture();
        state.service_records=[0,1,2,3,4].map(i=>({booking_id:state.booking.booking_id,service_record_id:'split-'+i,service_type:'surfboard',quantity:1,amount_due_cents:6000,status:'confirmed',service_date:`2026-09-${24+i}`,metadata:normalizeSplitRentalMetadata({rental_days:5,rental_people:people,board_variant:'soft',split_from:'source-rental',split_unit:i+1},'surfboard')}));
        if(shape==='json')state.service_records.forEach(row=>{row.metadata=JSON.stringify(row.metadata);});
        const before=JSON.stringify(state);await open();
        const summary=await page.locator('.bc-guest-services').innerText();
        assert.equal(summary,`surfboard — 5 rental days × ${people} ${people===1?'person':'people'}`,'split dates retain participants rather than multiplying by days');
        assert.equal(JSON.stringify(state),before);
        observations.push({summary,rows:clone(state.service_records)});cases.push(`summary-split-${people}-${shape}`);
      }
      state=fixture();
      const row={booking_id:'booking-a',service_type:'surfboard',quantity:1,amount_due_cents:1000,metadata:{rental_days:1,rental_people:2,split_from:'rental-a'}};
      state.service_records=[clone(row),{...clone(row),booking_id:'booking-b'},{...clone(row),metadata:{...row.metadata,split_from:'rental-b'}},{...clone(row),service_type:'wetsuit'},{...clone(row),metadata:{rental_days:1,rental_people:2}},{...clone(row),metadata:{rental_days:1,rental_people:2}},
        {service_type:'yoga',quantity:2,metadata:{rental_people:6,rental_days:5}},{service_type:'yoga',quantity:3,metadata:'{}'},{service_type:'meal',quantity:1},
        {service_type:'surfboard',quantity:3,metadata:'not-json'}];
      const before=JSON.stringify(state);await open();
      const distinctSummary=await page.locator('.bc-guest-services').innerText();
      assert.equal(distinctSummary,['surfboard','surfboard','surfboard','wetsuit','surfboard','surfboard'].map(name=>`${name} — 1 rental day × 2 people`).concat(['5× yoga','meal','3× surfboard']).join(', '),'distinct bookings/items and ordinary quantities preserved');
      assert.equal(JSON.stringify(state),before);observations.push({summary:distinctSummary,rows:clone(state.service_records)});cases.push('summary-distinct-bookings-items-ordinary');
    }
    const expected={accommodation:1,services:3,transfers:3,order:1,layout:12,rentals:9,'rental-count':9+8+1,preservation:14,lifecycle:6,full:49+8+1};
    assert.equal(cases.length,expected[MODE],'explicit complete mode case count');
    assert.equal(errors.length,0,'page errors');
    assert.equal(ledger.filter(e=>e.unknown||e.blocked).length,0,'unexpected requests');
  } catch(e) {failure=e;try{await page.screenshot({path:path.join(OUT,'failure.png')});}catch(_){} }
  finally {
    fs.writeFileSync(path.join(OUT,'results.json'),JSON.stringify({mode:MODE,cases,observations,ledger,errors,failure:failure?String(failure.stack):null},null,2));
    await browser.close();
  }
  console.log(JSON.stringify({mode:MODE,cases:cases.length,failure:failure?String(failure):null,out:OUT},null,2));
  if(failure)throw failure;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
