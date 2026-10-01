'use strict';
// Full emitted portal, ordinary Bookings row entry. Synthetic HTTP only; never forwarded.
// node scripts/verify-sunset-invoice-chrome-parity.js <evidence-dir> [modal|guest|full]
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { emit } = require('./verify-booking-drawer-invoice-tab');
const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
const { buildPaymentSummary } = require('./lib/sunset-schedule-booking-drawer');
// Real native payment projection from synthetic persisted service/catalog rows.
// catalog_service_category is read from tenant_services, never inferred from a name.
function categoryFixture(kind) {
  const state=fixture();
  const row=(id,label,cents,meta={},category=null,type='addon_service',date='2026-09-24')=>({
    service_record_id:id,service_type:type,service_date:date,quantity:1,status:'confirmed',
    amount_due_cents:cents,catalog_service_category:category,metadata:{service_name:label,...meta}
  });
  const services=[
    row('transfer-1','Airport shuttle',1500,{service_id:'11111111-1111-4111-8111-111111111111'},'transfer'),
    row('stay-1','Stay',7000,{staff_accommodation:true,component:'staff_accommodation',check_in:'2026-09-24',check_out:'2026-09-26',nights:2}),
    row('course-1','Course',2000,{component:'course',course_id:'local-course',course_label:'Local course'},null,'surf_lesson'),
    row('course-2','Course',0,{component:'course',course_id:'local-course',course_label:'Local course'},null,'surf_lesson','2026-09-25'),
    row('unknown','Transfer name is not category',400,{service_id:'22222222-2222-4222-8222-222222222222'}),
    row('transfer-2','Station shuttle',500,{service_id:'33333333-3333-4333-8333-333333333333'},'transfer'),
    row('stay-2','Stay',3000,{component:'staff_accommodation',check_in:'2026-09-27',check_out:'2026-09-28',nights:1}),
    row('experience','Accommodation name is not category',600,{service_id:'44444444-4444-4444-8444-444444444444'},'experience'),
    row('zero','Zero recorded service',0,{},'other')
  ];
  const picked=kind==='empty'?[]:kind==='unknown'?[services[4],services[7],services[8]]:services;
  const subtotal=kind==='empty'?0:kind==='unknown'?1000:20000; // Persisted booking amount deliberately differs from line sum.
  const paid=kind==='paid'?20000:kind==='refund'?23000:kind==='empty'||kind==='unknown'?0:3000;
  const booking={amount_due_cents:subtotal,total_amount_cents:subtotal,amount_paid_cents:paid,metadata:{}};
  state.payment=buildPaymentSummary({},booking,picked,'local-synthetic',paid,null,{paid_rows:paid?[{payment_id:'receipt',payment_status:'paid',amount_paid_cents:2000,metadata:{method:'bank_transfer'}}]:[]});
  state.participants=[{participant_id:'55555555-5555-4555-8555-555555555555',name:'Not a booking guest'},{id:'66666666-6666-4666-8666-666666666666',name:'Also not a booking guest'}];
  state.guest_count=2;
  state.total_cents=subtotal;state.amount_paid_cents=paid;state.balance_due_cents=state.payment.balance_due_cents;
  return {state,services:picked};
}
const ROOT = path.resolve(__dirname, '..'), OUT = path.resolve(process.argv[2] || 'artifacts/sunset-invoice-chrome-parity');
const MODE = process.argv[3] || 'full', ORIGIN = 'http://staff.test', TENANT = 'sunset';
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const matrix = [[320,844],[390,844],[1440,1000],[390,320],[1024,320]].flatMap(([width,height]) => ['light','dark'].map(theme => ({width,height,theme})));
function fixture() {
  return { success:true,booking_id:ID,booking_code:'SUNSET-CHROME-LOCAL',guest_name:'Local synthetic booking',
    email:'local@example.test',phone:'+34 600 000 000',status:'confirmed',booking_status:'confirmed',payment_status:'partial',payment_method:'in_store',
    date_from:'2026-09-24',date_to:'2026-09-27',service_dates:['2026-09-24','2026-09-27'],service_date_start:'2026-09-24',service_date_end:'2026-09-27',
    total_cents:12345,amount_paid_cents:2345,balance_due_cents:10000,currency:'EUR',guest_count:2,
    components:{lessons:[],rentals:[],addons:[]},participants:[],invoice_lines:[],payments:[],
    payment:{line_items:[{service_record_id:'synthetic-service',service_type:'addon_service',label:'Local synthetic service',quantity:1,line_cents:12345,service_date:'2026-09-24'}],
      subtotal_cents:12345,paid_cents:2345,balance_due_cents:10000,payment_status:'partial',paid_payments:[{amount_cents:2345,method:'bank_transfer'}]} };
}
async function run(browser,html,{width,height,theme},results,failures) {
  const name = `${width}x${height}-${theme}`, ledger=[], errors=[], consoleErrors=[], observations=[], receipts=[];
  const state=fixture();
  let receiptReply='ok', releaseReceipt;
  const ctx=await browser.newContext({viewport:{width,height},serviceWorkers:'block'});
  await ctx.routeWebSocket('**/*',ws=>{errors.push('Unexpected WebSocket '+ws.url());ws.close();});
  await ctx.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url()),entry={method:req.method(),url:req.url()};ledger.push(entry);
    if(req.method()==='GET'&&u.origin==='https://fonts.googleapis.com'&&u.pathname==='/css2'){
      entry.optionalFontFixture=true;return route.fulfill({contentType:'text/css',body:'/* offline optional font */'});
    }
    if(req.method()==='POST'&&u.origin===ORIGIN&&u.pathname==='/staff/bookings/record-cash-payment') {
      entry.syntheticWrite=true;entry.body=req.postDataJSON();receipts.push(entry.body);
      if(receiptReply==='held')await new Promise(resolve=>{releaseReceipt=resolve;});
      if(receiptReply==='rejected')return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({success:false,error:'local_definite_rejection'})});
      // Browser/payload + authoritative reread fixture only; not a DB persistence proof.
      state.payment.paid_cents+=entry.body.amount_cents;
      state.payment.balance_due_cents-=entry.body.amount_cents;
      state.payment.paid_payments.push({amount_cents:entry.body.amount_cents,method:entry.body.method});
      if(receiptReply==='uncertain')return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({success:false,error:'local_uncertain_receipt'})});
      return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true})});
    }
    if(req.method()!=='GET'||u.origin!==ORIGIN){entry.blocked=true;return route.abort();}
    const p=u.pathname;let data;
    if(p==='/staff/ui')return route.fulfill({contentType:'text/html',body:html});
    if(p==='/staff/auth/session')data={success:true,auth_required:false,role:'admin',clients:[{slug:TENANT,name:TENANT}],client_profiles:{[TENANT]:loadClientPortalProfile(TENANT)}};
    else if(p.startsWith('/staff/assets/')) {const asset=path.join(ROOT,'config/staff-portal',path.basename(p));if(fs.existsSync(asset))return route.fulfill({path:asset});entry.unknown=true;return route.abort();}
    else if(p==='/staff/intents')data={success:true,intents:[]};
    else if(p==='/staff/inbox/luna-mode')data={success:true,mode:'off'};
    else if(p==='/staff/bot/global-pause-state')data={success:true,paused:false};
    else if(p==='/staff/whatsapp-numbers')data={success:true,numbers:[]};
    else if(p==='/staff/admin/house-notes')data={success:true,notes:''};
    else if(p==='/staff/automated-notifications')data={success:true,notifications:[]};
    else if(p==='/staff/packages')data={success:true,packages:[]};
    else if(p==='/staff/conversations')data={success:true,conversations:[]};
    else if(p==='/staff/admin/config')data={success:true,...resolveTenantBusinessConfig(TENANT,'sunset-somo')};
    else if(p==='/staff/clients')data={success:true,clients:[{slug:TENANT,name:TENANT}]};
    else if(p==='/staff/admin/config/rental-offerings')data={success:true,offerings:[]};
    else if(p==='/staff/admin/bookings')data={success:true,rows:[state],total:1,summary:{}};
    else if(p===`/staff/schedule/bookings/${ID}/waiver`)data={success:true,waiver:null};
    else if(p==='/staff/schedule/bookings/detail')data=state;
    else if(p==='/staff/schedule/bookings/catalog')data={success:true,offerings:[],courses:[]};
    else if(p==='/staff/schedule/rental-stock')data={success:true,stock:[],items:[]};
    else if(p==='/staff/schedule/day')data={success:true,date:u.searchParams.get('date'),lessons:[],gear:[],rows:[]};
    else {entry.unknown=true;return route.abort();}
    return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await ctx.addInitScript(theme=>{
    localStorage.setItem('wh_staff_portal_locale','en');localStorage.setItem('wh_staff_portal_theme',theme);
    window.EventSource=function(){throw Error('Unexpected EventSource');};
  },theme);
  const page=await ctx.newPage();page.setDefaultTimeout(7000);
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',e=>{if(e.type()==='error')consoleErrors.push(e.text());});
  async function enter() {
    await page.goto(ORIGIN+'/staff/ui');
    await page.waitForFunction(t=>typeof window.switchToTab==='function'&&document.getElementById('c-client').value===t,TENANT);
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;window.switchToTab('bookings');},theme);
    await page.locator('[data-bookings-open-schedule]').first().click();
    await page.locator('#ps-drawer-subtotal').waitFor();
    await page.mouse.move(1,1);
  }
  const trigger=page.locator('#ps-drawer-record-payment'),dialog=page.locator('#ps-record-payment-dialog');
  const amount=page.locator('#ps-drawer-manual-amount'),method=page.locator('#ps-drawer-manual-method'),note=page.locator('#ps-drawer-manual-note');
  const cancel=page.locator('#ps-drawer-manual-cancel'),submit=page.locator('#ps-drawer-manual-submit'),scope=page.locator('#ps-drawer-manual-scope');
  async function totals(label) {
    const rows=await page.locator('.ps-invoice-total-row').evaluateAll(es=>es.map(e=>{
      const l=e.querySelector('.ctx-inv-total-label'),a=e.querySelector('.ctx-inv-total-amount'),ls=getComputedStyle(l),as=getComputedStyle(a);
      return {label:l.textContent,amount:a.textContent,labelStyle:{font:ls.fontSize,transform:ls.textTransform,spacing:ls.letterSpacing,color:ls.color},amountStyle:{font:as.fontSize,color:as.color},labelRect:l.getBoundingClientRect().toJSON(),amountRect:a.getBoundingClientRect().toJSON()};
    }));observations.push({label,rows});return rows;
  }
  async function structure() {
    const sections=page.locator('#ps-drawer-payment-box > .ctx-inv-group');
    const expected=['accommodation','services','transfers','per-guest','totals'];
    assert.deepEqual(await sections.evaluateAll(es=>es.map(e=>e.id)),expected.map(s=>'ps-inv-'+s),'actual invoice sections: Accommodation → Services → Transfers → Per Guest → Totals (not flat rows)');
    assert.deepEqual(await sections.locator(':scope > .ctx-inv-group-title').allTextContents(),['Accommodation','Services','Transfers','Per Guest','Totals']);
    const boxes=await sections.evaluateAll(es=>es.map(e=>e.getBoundingClientRect().toJSON()));
    for(let i=0;i<boxes.length-1;i++)assert(boxes[i].height>0&&boxes[i].bottom<=boxes[i+1].top+1,'sections have real visible ordered bodies');
    assert.equal(await page.locator('#ps-inv-totals #ps-drawer-subtotal').count(),1,'native subtotal inside Totals');
    assert.equal(await page.locator('#ps-inv-totals #ps-drawer-remaining').count(),1,'native balance inside Totals');
    assert.equal(await page.locator('#ps-inv-per-guest .ctx-none').innerText(),'Not available','no native durable guest allocation');
    assert.equal(await page.locator('#ps-inv-per-guest button,#ps-inv-per-guest a,#ps-inv-per-guest .ps-invoice-amt').count(),0,'no invented guest amounts or actions');
    assert.equal(await page.locator('#ps-inv-per-guest').innerText().then(s=>/[€$]|Local synthetic booking/.test(s)),false);
    observations.push({label:'structure',sections:expected,boxes});
  }
  async function defaults() {
    assert.equal(await scope.count(),1,'native Record Payment exposes Guest booking scope');
    assert.equal(await scope.inputValue(),'booking','Guest defaults to All without interaction');
    assert.deepEqual(await scope.locator('option').evaluateAll(es=>es.map(e=>({value:e.value,text:e.textContent}))),[{value:'booking',text:'All — booking payment'}],'no invented guest identity or allocation');
    assert.equal(await scope.evaluate(e=>document.activeElement===e),true,'Guest initial focus');
    assert.equal(await amount.inputValue(),(state.payment.balance_due_cents/100).toFixed(2),'preserve Sunset amount default');
    assert.equal(await method.inputValue(),'bank_transfer','preserve Sunset method default');
    assert.equal(await note.inputValue(),'');
  }
  try {
    await enter();
    if(MODE==='full') await structure();
    const before=await totals('native-invoice-before');
    assert.deepEqual(before.map(r=>r.amount),['€123.45','−€23.45','€100.00'],'existing financial rows remain present');
    await page.locator('#ps-drawer-payment-box').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(OUT,`${name}-invoice-local-synthetic.png`)});
    const control=page.getByText('Record a manual payment',{exact:true}).first();
    assert.equal(await control.evaluate(e=>e.tagName),'BUTTON','Record Payment must be an action button, not inline disclosure');
    await trigger.click();
    assert.equal(await dialog.evaluate(e=>e.matches(':modal')),true,'native showModal');
    const m=await dialog.evaluate(e=>({rect:e.getBoundingClientRect().toJSON(),scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}));
    observations.push({label:'modal-geometry',...m});
    await page.screenshot({path:path.join(OUT,`${name}-dialog-local-synthetic.png`)});
    const inset=width<=600?0:12;
    assert(Math.abs(width-m.rect.right-inset)<=1,'right edge matches WH');
    assert(Math.abs(height-m.rect.bottom-inset)<=1,'bottom edge matches WH');
    assert(m.rect.x>=0&&m.rect.y>=0&&m.rect.bottom<=height,'dialog inside viewport');
    assert(m.scrollWidth<=m.clientWidth,'no horizontal overflow');
    if(width<=600)assert.equal(m.rect.width,width,'phone full-width bottom sheet');
    if(height===320){assert(m.scrollHeight>m.clientHeight,'short dialog scroll range');await dialog.evaluate(e=>e.scrollTop=e.scrollHeight);assert(await dialog.evaluate(e=>e.scrollTop>0),'short dialog scrolls');await page.screenshot({path:path.join(OUT,`${name}-scrolled-local-synthetic.png`)});}
    if(MODE!=='modal')await defaults();
    const first=await scope.count()?scope:amount;
    await submit.focus();await page.keyboard.press('Tab');assert(await first.evaluate(e=>e===document.activeElement),'Tab trapped');
    await page.keyboard.press('Shift+Tab');assert(await submit.evaluate(e=>e===document.activeElement),'reverse Tab trapped');
    await page.keyboard.press('Escape');assert.equal(await dialog.evaluate(e=>e.open),false,'Escape closes only payment dialog');
    assert(await trigger.isVisible(),'parent remains open');assert(await trigger.evaluate(e=>e===document.activeElement),'Escape restores trigger focus');
    await page.keyboard.press('Enter');if(MODE!=='modal')await defaults();
    await amount.fill('9.87');await note.fill('discard');await cancel.click();
    assert(await trigger.evaluate(e=>e===document.activeElement),'Cancel restores focus');
    await trigger.click();if(MODE!=='modal')await defaults();await cancel.click();
    assert.equal(receipts.length,0,'opening/closing is read-only');
    if(MODE==='full') {
      // WH totals use a shared right-aligned amount column and neutral sentence-case labels.
      assert.equal(before[0].labelStyle.transform,'none','Subtotal uses WH label chrome, not Sunset uppercase');
      assert.equal(before[0].labelStyle.spacing,'normal','Subtotal uses WH letter spacing');
      assert.equal(before[0].amountStyle.font,'12px','Subtotal uses WH amount size');
      assert.equal(before[2].amountStyle.font,'12px','Balance uses WH amount size');
      if(theme==='dark')assert.equal(before[2].amountStyle.color,'rgb(255, 184, 150)','Balance uses existing shared dark owing token');
      for(const row of before){assert(Math.abs(row.amountRect.right-before[0].amountRect.right)<1,'amount column aligned');assert(row.labelRect.right<=row.amountRect.left,'label and amount do not collide');}
      const order=await page.locator('#ps-drawer-payment-box').evaluate(e=>[...e.querySelectorAll(':scope > .ctx-inv-group,#ps-drawer-record-payment')].map(n=>n.id));
      assert.deepEqual(order,['ps-inv-accommodation','ps-inv-services','ps-inv-transfers','ps-inv-per-guest','ps-inv-totals','ps-drawer-record-payment'],'five sections followed by native payment action');
      assert(await page.locator('#ps-drawer-payment-box').evaluate(e=>e.scrollWidth<=e.clientWidth),'invoice has no horizontal overflow');
      await trigger.click();await defaults();
      await amount.fill('0');await submit.click();assert.equal(receipts.length,0,'existing invalid-amount guard');
      await amount.fill('12.34');await note.fill('  local synthetic receipt  ');
      // All stays untouched; no payment_scope / guest id is added to Sunset's payload.
      await submit.click();
      await page.waitForFunction(()=>document.querySelector('#ps-drawer-remaining')?.textContent==='€87.66');
      assert.equal(receipts.length,1);
      const {idempotency_key:key,...body}=receipts[0];
      assert.match(key,new RegExp('^sunset-drawer-pay-'+ID+'-\\d+$'));
      assert.deepEqual(body,{client_slug:TENANT,booking_id:ID,amount_cents:1234,method:'bank_transfer',note:'local synthetic receipt'});
      assert.equal(await dialog.evaluate(e=>e.open),false,'successful native remount leaves no modal');
      assert.deepEqual((await totals('after-receipt-reread')).map(r=>r.amount),['€123.45','−€23.45','−€12.34','€87.66']);
      await trigger.click();await defaults();await cancel.click();
      const oldMount=await trigger.elementHandle();
      await page.locator('#ps-drawer-refresh').click();
      await page.waitForFunction(e=>!e.isConnected,oldMount);
      await trigger.click();await defaults();await cancel.click();
      await page.locator('#ps-drawer-close').click();
      await page.locator('[data-bookings-open-schedule]').first().click();
      await trigger.click();await defaults();await cancel.click();
      // Ordinary reload, row-open and fresh defaults from the synthetic authoritative response.
      await enter();assert.equal(await page.locator('#ps-drawer-remaining').innerText(),'€87.66');
      await trigger.click();await defaults();await cancel.click();
      assert.equal(receipts.length,1,'refresh/reopen never resubmits');
      await trigger.click();await method.selectOption('in_store');await amount.fill('1.00');await submit.click();
      await page.waitForFunction(()=>document.querySelector('#ps-drawer-remaining')?.textContent==='€86.66');
      const {idempotency_key:secondKey,...secondBody}=receipts[1];
      assert.notEqual(secondKey,key);
      assert.deepEqual(secondBody,{client_slug:TENANT,booking_id:ID,amount_cents:100,method:'in_store',note:null},'native in_store receipt semantics also unchanged');
      assert.equal(receipts.length,2);
      const categoryCases=[];
      for(const kind of ['multi','paid','refund','empty','unknown']) {
        const projected=categoryFixture(kind);Object.assign(state,projected.state);
        await enter();await structure();
        const amounts=async section=>page.locator('#ps-inv-'+section+' .ps-svc-amt').allTextContents();
        const mixed=!['empty','unknown'].includes(kind);
        assert.deepEqual(await amounts('transfers'),mixed?['€15.00','€5.00']:[],'catalog transfer charges belong in Transfers');
        assert.deepEqual(await amounts('accommodation'),mixed?['€70.00','€30.00']:[],'each authoritative stay remains separate');
        assert.deepEqual((await amounts('services')).sort(),kind==='empty'?[]:(mixed?['€20.00','€4.00','€6.00','€0.00']:['€4.00','€6.00','€0.00']).sort(),'course rollup, unknown service and explicit zero retained exactly once');
        if(kind!=='empty') {
          assert.match(await page.locator('#ps-inv-services').innerText(),/Transfer name is not category/,'labels do not decide transfer classification');
          assert.match(await page.locator('#ps-inv-services').innerText(),/Accommodation name is not category/,'labels do not decide accommodation classification');
        }
        if(!mixed) {
          assert.equal(await page.locator('#ps-inv-accommodation .ctx-none').innerText(),'Not available');
          assert.equal(await page.locator('#ps-inv-transfers .ctx-none').innerText(),'No transfer charges.');
        }
        if(kind==='empty')assert.equal(await page.locator('#ps-inv-services .ctx-none').innerText(),'No services recorded.');
        const expected={multi:['€200.00','−€20.00','−€10.00','€170.00'],paid:['€200.00','−€20.00','−€180.00','€0.00'],refund:['€200.00','−€20.00','−€210.00','€30.00'],empty:['€0.00','€0.00'],unknown:['€10.00','€10.00']};
        const rows=await totals(kind);
        assert.deepEqual(rows.map(r=>r.amount),expected[kind],'Totals preserve authoritative subtotal, ledger remainder, paid/refund semantics without summing sections');
        assert.equal(await page.locator('.ps-invoice-balance').getAttribute('class').then(s=>s.includes('is-'+(kind==='paid'?'paid':kind==='refund'?'refund':'due'))),true);
        assert.equal(await page.locator('#ps-drawer-payment-box .ps-invoice-total-row').count(),await page.locator('#ps-inv-totals .ps-invoice-total-row').count(),'every financial summary row belongs to Totals');
        assert(await page.locator('#ps-drawer-payment-box').evaluate(e=>e.scrollWidth<=e.clientWidth),'category invoice has no horizontal overflow');
        for(const row of rows){assert(Math.abs(row.amountRect.right-rows[0].amountRect.right)<1,'category totals amount column aligned');assert(row.labelRect.right<=row.amountRect.left,'category total label and amount do not collide');}
        const commercialGeometry=await page.locator('#ps-drawer-payment-box .ps-invoice-line').evaluateAll(es=>es.map(e=>({name:e.querySelector('.ps-svc-name').getBoundingClientRect().toJSON(),amount:e.querySelector('.ps-svc-amt').getBoundingClientRect().toJSON()})));
        for(const line of commercialGeometry)assert(line.name.right<=line.amount.left+1,'commercial names and amounts do not collide');
        if(kind==='multi') {
          await page.locator('#ps-inv-accommodation').scrollIntoViewIfNeeded();
          await page.screenshot({path:path.join(OUT,`${name}-multi-top-local-synthetic.png`)});
          await page.locator('#ps-inv-totals').scrollIntoViewIfNeeded();
          await page.screenshot({path:path.join(OUT,`${name}-multi-bottom-local-synthetic.png`)});
          await trigger.click();await defaults();await cancel.click();
        }
        assert.equal(receipts.length,2,'category/paid/refund/empty inspection is read-only');
        categoryCases.push(kind);
        observations.push({label:'category-'+kind,payment:state.payment,participants:state.participants,commercialGeometry,invoiceHtml:await page.locator('#ps-drawer-payment-box').evaluate(e=>e.outerHTML)});
      }
      assert.deepEqual(categoryCases,['multi','paid','refund','empty','unknown'],'complete category matrix');
    }
    if(MODE==='adverse') {
      for(const reply of ['uncertain','rejected']) {
        Object.assign(state,fixture());await enter();await trigger.click();
        receiptReply=reply;await amount.fill('12.34');await method.selectOption('in_store');await note.fill('retain attempted receipt');
        const count=receipts.length;await submit.click();
        await page.locator('#ps-drawer-manual-msg').waitFor({state:'visible'});
        assert.equal(receipts.length,count+1);const requests=ledger.length;
        await cancel.click();await trigger.click();
        assert.equal(await amount.inputValue(),'12.34',reply+' amount retained');
        assert.equal(await method.inputValue(),'in_store',reply+' method retained');
        assert.equal(await note.inputValue(),'retain attempted receipt',reply+' note retained');
        assert(await page.locator('#ps-drawer-manual-msg').isVisible(),reply+' warning remains visible');
        assert.equal(ledger.length,requests,'reopen neither rereads nor resubmits');
        await cancel.click();observations.push({label:'retained-'+reply,requests:receipts.length});
      }
      Object.assign(state,fixture());await enter();await trigger.click();receiptReply='held';
      const oldButton=await submit.elementHandle(),count=receipts.length;
      await amount.fill('12.34');await submit.click();
      await page.waitForFunction(()=>document.getElementById('ps-drawer-manual-submit').disabled);
      while(!releaseReceipt)await new Promise(resolve=>setImmediate(resolve));
      await page.keyboard.press('Escape');
      assert(await trigger.isVisible(),'busy Escape must not hide parent');
      assert(await dialog.evaluate(e=>e.matches(':modal')),'busy Escape retains visible modal');
      await page.keyboard.press('Tab');assert(await dialog.evaluate(e=>e.contains(document.activeElement)),'busy Tab stays inside modal');
      await page.evaluate(()=>document.activeElement.blur());await page.keyboard.press('Escape');
      assert(await trigger.isVisible(),'busy Escape after focus loss must not hide parent');
      await cancel.click();assert(await dialog.evaluate(e=>e.open),'busy Cancel fenced');
      await submit.evaluate(e=>e.click());assert.equal(receipts.length,count+1,'duplicate submit fenced');
      await page.locator('#ps-drawer-close').evaluate(e=>e.click());
      assert.equal(await page.locator('dialog:modal').count(),0,'programmatic parent teardown releases modal top layer');
      await page.locator('[data-bookings-open-schedule]').first().click();await trigger.click();await defaults();
      const requests=ledger.length;releaseReceipt();
      await page.waitForFunction(e=>!e.disabled,oldButton);
      assert(await dialog.evaluate(e=>e.open),'stale completion preserves replacement modal');
      assert.equal(await amount.inputValue(),'100.00');assert.equal(ledger.length,requests,'stale receipt causes no reread');
      assert.equal(await page.locator('#ps-drawer-manual-msg').isVisible(),false,'stale response does not flash new message');
      await cancel.click();assert(await trigger.evaluate(e=>e===document.activeElement),'settled stale request releases guard/focus');
      observations.push({label:'busy-and-teardown',ordinaryPointerReentry:true,receipts:receipts.length});
    }
    results.push({name,mode:MODE,localSynthetic:true});
  } catch(e) { failures.push(`${name}: ${e.stack}`);await page.screenshot({path:path.join(OUT,`${name}-failure-local-synthetic.png`)}); }
  finally {
    fs.writeFileSync(path.join(OUT,`${name}.json`),JSON.stringify({observations,ledger,errors,consoleErrors,receipts},null,2));
    const unexpectedConsoleErrors=consoleErrors.filter(message=>!(MODE==='adverse'&&/^Failed to load resource: the server responded with a status of (409|500) \(/.test(message)));
    if(errors.length||unexpectedConsoleErrors.length)failures.push(`${name}: errors ${JSON.stringify({errors,consoleErrors:unexpectedConsoleErrors})}`);
    if(ledger.some(e=>e.blocked||e.unknown))failures.push(`${name}: unknown requests ${JSON.stringify(ledger.filter(e=>e.blocked||e.unknown))}`);
    await ctx.close();
  }
}
async function main(){
  fs.mkdirSync(OUT,{recursive:true});
  const html=process.env.SUNSET_CHROME_TEST_HTML?fs.readFileSync(process.env.SUNSET_CHROME_TEST_HTML,'utf8'):emit(TENANT,OUT),results=[],failures=[];
  fs.writeFileSync(path.join(OUT,'exercised.html'),html);
  const browser=await chromium.launch({headless:true});
  try{for(const size of matrix)await run(browser,html,size,results,failures);}finally{await browser.close();}
  if(results.length!==matrix.length)failures.push(`Expected ${matrix.length} complete cases; got ${results.length}`);
  const sha256=s=>createHash('sha256').update(s).digest('hex');
  const report={mode:MODE,results,failures,localSynthetic:true,htmlSource:process.env.SUNSET_CHROME_TEST_HTML||'fresh production emission',htmlSha256:sha256(html),verifierSha256:sha256(fs.readFileSync(__filename))};
  fs.writeFileSync(path.join(OUT,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(failures.length)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
