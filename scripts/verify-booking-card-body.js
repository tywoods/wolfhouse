'use strict';
// Offline production HTML, native entrypoints. No request is forwarded.
// node scripts/verify-booking-card-body.js <durable-evidence-dir> [details|full]
const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {chromium}=require('playwright');
const {emit,calendar,detail}=require('./verify-booking-drawer-invoice-tab');
const {loadClientPortalProfile}=require('./lib/staff-portal-clients');
const {resolveTenantBusinessConfig}=require('./lib/tenant-business-config');
const ROOT=path.resolve(__dirname,'..'), OUT=path.resolve(process.argv[2] || 'artifacts/booking-card-body');
const MODE=process.argv[3] || 'full', ORIGIN='http://staff.test';
const clone=x=>JSON.parse(JSON.stringify(x));
const NAME='María Alexandra Long Booker-Surname', EMAIL='alexandra.very.long.contact.address@example.test';
async function main(){
  fs.mkdirSync(OUT,{recursive:true});
  if(MODE==='disclosure-key'){
    // Isolated ownership seam, not a claim of live cross-tenant browser navigation.
    const vm=require('node:vm'),source=fs.readFileSync(path.join(ROOT,'scripts/staff-query-api.js'),'utf8');
    let client='wolfhouse-somo';const sandbox={getBcClient:()=>client,getClient:()=> 'unrelated-inbox-client',el:()=>null};
    vm.createContext(sandbox);vm.runInContext(source.slice(source.indexOf('var bcBodyDisclosure ='),source.indexOf('function bcInitCashPaymentShell')),sandbox);
    const data={booking:{booking_id:'same-id'}};sandbox.bcInitBodyDisclosure(data);
    const failures=[];
    try{
      assert.equal(sandbox.bcBodyDisclosure.key,'wolfhouse-somo:same-id','disclosure uses calendar tenant, not unrelated Inbox selection');
      sandbox.bcBodyDisclosure.open.history=true;sandbox.bcInitBodyDisclosure(data);assert(sandbox.bcBodyDisclosure.open.history,'same identity retains state');
      client='sunset';sandbox.bcInitBodyDisclosure(data);assert.equal(Object.keys(sandbox.bcBodyDisclosure.open).length,0,'same booking id different tenant resets state');
      client='wolfhouse-somo';sandbox.bcInitBodyDisclosure(data);assert.equal(Object.keys(sandbox.bcBodyDisclosure.open).length,0,'return to previous tenant has no stale state');
    }catch(e){failures.push(e.message);}
    const result={mode:MODE,results:[{name:'isolated-calendar-tenant-disclosure-ownership'}],failures};fs.writeFileSync(path.join(OUT,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(failures.length)process.exitCode=1;return;
  }
  const htmls=Object.fromEntries(['wolfhouse-somo','sunset'].map(t=>[t,emit(t,OUT)]));
  const browser=await chromium.launch({headless:true}), results=[], failures=[];
  const matrix=MODE==='full'?[320,390,430,768,769,1440].flatMap(width=>['light','dark'].flatMap(theme=>['en','es'].map(locale=>({width,theme,locale})))):MODE==='italian'?[{width:390,theme:'light',locale:'it'}]:['light','dark'].map(theme=>({width:390,theme,locale:'en'}));
  if(MODE==='unknown-inclusion')matrix.splice(0,matrix.length,...[null,undefined,'',false,'not-a-number'].map((value,i)=>({width:390,theme:'light',locale:'en',value,variant:i})));
  if(MODE==='reentry')matrix.splice(0,matrix.length,...[390,1440].flatMap(width=>['light','dark'].map(theme=>({width,theme,locale:'en'}))));
  if(MODE==='save-reload-ownership')matrix.splice(0,matrix.length,...['other','reopen','error','network-error','dirty'].flatMap(variant=>['light','dark'].map(theme=>({width:1440,theme,locale:'en',variant}))));
  if(MODE==='fresh-disclosures')matrix.forEach(c=>c.width=1440);
  if(MODE==='protected-guest')matrix.splice(0,matrix.length,...[320,390].flatMap(width=>['light','dark'].map(theme=>({width,theme,locale:'en'}))));
  if(MODE==='package-ink')matrix.splice(0,matrix.length,...[320,390,1440].flatMap(width=>['light','dark'].flatMap(theme=>['en','es'].map(locale=>({width,theme,locale})))));
  try {for(const tenant of ['wolfhouse-somo','sunset']) for(const {width,theme,locale,value,variant} of matrix){
    if(MODE==='save-reload-ownership'&&tenant!=='wolfhouse-somo')continue;
    const sunset=tenant==='sunset', name=`${tenant}-${width}-${theme}-${locale}${variant===undefined?'':'-'+variant}`, ledger=[], errors=[], observations={};
    const state=clone(detail), cal=clone(calendar), CODE=sunset?'SUNSET-BODY-001':'WH-BODY-001';
    let deferContext=false,releaseContext;
    Object.assign(state.booking,{booking_code:CODE,guest_name:NAME,email:EMAIL,phone:'+34 600 000 000'});
    Object.assign(cal.blocks[0],state.booking);
    if(MODE==='protected-guest'||MODE==='full'){
      Object.assign(state.booking_guests[0],{guest_name:'Alexandria Verylongsurname (test)',assigned_bed_code:'R1-B1',bed_code:'R1-B1'});
      state.booking_guests.push({guest_number:2,guest_name:'Second Longsurname',assigned_bed_code:'R1-B2',metadata:{subtotal_cents:30000},deposit_amount_cents:9000,amount_paid_cents:9000,payment_status:'paid'});
    }
    const other=clone(state);other.booking.booking_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';other.booking.booking_code='WH-BODY-002';other.booking.guest_name='Other booking';
    cal.blocks.push({...cal.blocks[0],...other.booking,bed_code:'R1-B2'});
    state.service_records=[{service_record_id:'svc-zero',service_type:'addon',quantity:1,amount_due_cents:0,service_date:'2026-09-24',metadata:{catalog_service:true,service_name:'Recorded zero service'}},
      {service_record_id:'svc-long',service_type:'addon',quantity:1,amount_due_cents:12345,service_date:'2026-09-27',metadata:{catalog_service:true,service_name:'Long named extra rental and service for Alexandra'}}];
    const sun={booking_id:state.booking.booking_id,booking_code:CODE,guest_name:NAME,email:EMAIL,phone:state.booking.phone,
      status:'confirmed',booking_status:'confirmed',payment_status:'unpaid',payment_method:'in_store',
      date_from:'2026-09-24',date_to:'2026-09-27',service_dates:['2026-09-24','2026-09-27'],service_date_start:'2026-09-24',service_date_end:'2026-09-27',
      total_cents:60000,amount_paid_cents:0,balance_due_cents:60000,currency:'EUR',guest_count:2,
      components:{lessons:[],rentals:[],addons:[]},participants:[],invoice_lines:[],payments:[]};
    sun.payment={line_items:[{service_record_id:'sun-long',service_type:'addon_service',label:'Long named extra rental and service for Alexandra',quantity:1,line_cents:12345,service_date:'2026-09-24'},
      {service_record_id:'sun-zero',service_type:'addon_service',label:'Recorded zero service',quantity:1,line_cents:0,service_date:'2026-09-27'}],subtotal_cents:12345,paid_cents:0,balance_due_cents:12345};
    if(MODE==='unknown-inclusion'){
      state.service_records[0].amount_due_cents=value;
      state.service_records[0].metadata.included_equipment=true;
      sun.payment.line_items[1].line_cents=value;
      sun.payment.line_items[1].included_equipment=true;
    }
    if(MODE==='invoice-edge'){
      state.booking.total_amount_cents=null;state.booking.accommodation_total_cents=null;state.guest_accommodation_lines=[];
      state.service_records[1].amount_due_cents=-250;
      state.service_records[1].metadata.service_name='Recorded refund adjustment factual';
      sun.payment.line_items[0].line_cents=-250;sun.payment.line_items[0].label='Recorded refund adjustment factual';
      sun.payment.subtotal_cents=0;sun.payment.paid_cents=250;sun.payment.balance_due_cents=0;sun.payment.refund_credit_cents=250;
    }
    if(['facts','package-refresh','fresh-disclosures'].includes(MODE)){
      state.booking.metadata={guest_packages:[{guest_number:1,package_code:'malibu'},{guest_number:2,package_code:'waimea'}]};
      state.booking_guests.push({guest_number:2,guest_name:'Second Guest'});
      other.booking.metadata=clone(state.booking.metadata);
      state.service_records[0].metadata.included_equipment=true;
      sun.payment.line_items[1].included_equipment=true;
      sun.payment.line_items[1].course_equipment=true;
      sun.payment.line_items[1].component='course_equipment';
    }
    const ctx=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
    await ctx.routeWebSocket('**/*',ws=>{errors.push('Unexpected WebSocket '+ws.url());ws.close();});
    await ctx.route('**/*',async route=>{
      const req=route.request(),u=new URL(req.url()),entry={method:req.method(),url:req.url()};ledger.push(entry);
      if(req.method()==='GET' && u.origin==='https://fonts.googleapis.com' && u.pathname==='/css2'){entry.optionalFontAborted=true;return route.abort();}
      if(['editor','reentry','save-reload-ownership'].includes(MODE)&&req.method()==='POST'&&u.origin===ORIGIN&&u.pathname==='/staff/bookings/edit'){
        entry.syntheticWrite=true;entry.body=req.postDataJSON();
        assert.equal(entry.body.edit_type,'contact');assert.equal(entry.body.booking_code,CODE);
        state.booking.email=entry.body.email;
        return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,booking:state.booking})});
      }
      if(req.method()!=='GET'||u.origin!==ORIGIN){entry.blocked=true;return route.abort();}
      const p=decodeURIComponent(u.pathname);let data;
      if(p==='/staff/ui')return route.fulfill({contentType:'text/html',body:htmls[tenant]});
      if(p==='/staff/bed-calendar')data=cal;
      else if(p===`/staff/bookings/${CODE}/context`){
        data=clone(state);
        if(deferContext){
          deferContext=false;entry.delayed=true;
          await new Promise(resolve=>{releaseContext=resolve;});
          if(variant==='error')return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({success:false,error:'delayed context failure'})});
          if(variant==='network-error')return route.abort('failed');
        }
      }
      else if(p==='/staff/bookings/WH-BODY-002/context')data=other;
      else if(p==='/staff/auth/session')data={success:true,auth_required:false,role:'admin',clients:[{slug:tenant,name:tenant}],client_profiles:{[tenant]:loadClientPortalProfile(tenant)}};
      else if(p.startsWith('/staff/assets/')){const asset=path.join(ROOT,'config/staff-portal',path.basename(p));if(fs.existsSync(asset))return route.fulfill({path:asset});entry.unknown=true;return route.abort();}
      else if(p==='/staff/intents')data={success:true,intents:[]};
      else if(p==='/staff/inbox/luna-mode')data={success:true,mode:'off'};
      else if(p==='/staff/bot/global-pause-state')data={success:true,paused:false};
      else if(p==='/staff/whatsapp-numbers')data={success:true,numbers:[]};
      else if(p==='/staff/admin/house-notes')data={success:true,notes:''};
      else if(p==='/staff/automated-notifications')data={success:true,notifications:[]};
      else if(p==='/staff/packages')data={success:true,packages:[]};
      else if(p==='/staff/conversations')data={success:true,conversations:[]};
      else if(p==='/staff/admin/config')data={success:true,...resolveTenantBusinessConfig(tenant,'sunset-somo')};
      else if(p===`/staff/bookings/${state.booking.booking_id}/services`)data={success:true,paid_requested_services:[],unscheduled_services:[],services_by_date:[]};
      else if(p===`/staff/bookings/${state.booking.booking_id}/transfers`)data={success:true,transfers:state.transfers};
      else if(p===`/staff/bookings/${other.booking.booking_id}/services`)data={success:true,paid_requested_services:[],unscheduled_services:[],services_by_date:[]};
      else if(p===`/staff/bookings/${other.booking.booking_id}/transfers`)data={success:true,transfers:[]};
      else if(p==='/staff/clients')data={success:true,clients:[{slug:tenant,name:tenant}]};
      else if(sunset&&p==='/staff/admin/config/rental-offerings')data={success:true,offerings:[]};
      else if(sunset&&p==='/staff/admin/bookings')data={success:true,rows:[sun],total:1,summary:{}};
      else if(sunset&&p===`/staff/schedule/bookings/${sun.booking_id}/waiver`)data={success:true,waiver:null};
      else if(sunset&&p==='/staff/schedule/bookings/detail')data={success:true,...sun};
      else if(sunset&&p==='/staff/schedule/bookings/catalog')data={success:true,offerings:[],courses:[]};
      else if(sunset&&p==='/staff/schedule/rental-stock')data={success:true,stock:[],items:[]};
      else if(sunset&&p==='/staff/schedule/day')data={success:true,date:u.searchParams.get('date'),lessons:[],gear:[],rows:[]};
      else {entry.unknown=true;return route.abort();}
      return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    });
    await ctx.addInitScript(l=>{localStorage.setItem('wh_staff_portal_locale',l);window.EventSource=function(){throw Error('Offline EventSource denied');};},locale);
    const page=await ctx.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(String(e)));
    try {
      await page.goto(ORIGIN+'/staff/ui');
      await page.waitForFunction(t=>typeof window.switchToTab==='function'&&document.getElementById('c-client').value===t,tenant);
      await page.evaluate(t=>window.switchToTab(t),sunset?'bookings':'bed-calendar');
      if(sunset){await page.locator('[data-bookings-open-schedule]').first().focus();await page.keyboard.press('Enter');}
      else await page.locator('.bc-block').first().click();
      await page.mouse.move(10,500);
      await page.locator(sunset?'#ps-drawer-copy-code':'#bc-inv-totals').waitFor();
      await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
      await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),theme);
      if(MODE==='details'||MODE==='full'||MODE==='italian'){
        if(sunset){
          const body=page.locator('.booking-body-details');
          assert.equal(await body.count(),1,'native Sunset view exposes compact body Details');
          const text=await body.innerText();observations.details=text;
          assert(text.includes(NAME)&&text.includes(EMAIL),'booker/contact facts visible beneath unchanged hero');
          assert(!text.includes('2026-09-25'),'nonconsecutive dates never invented');
          const order=await body.evaluate(e=>{const hero=document.querySelector('.portal-schedule-drawer-hero'),invoice=document.querySelector('#ps-drawer-payment-box');return !!(hero.compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING)&&!!(e.compareDocumentPosition(invoice)&Node.DOCUMENT_POSITION_FOLLOWING);});
          assert(order,'Details between hero and invoice');
        }else{
          const metrics=await page.locator('#bc-field-group-contact .ctx-field-kv-grid').first().evaluate(e=>({columns:getComputedStyle(e).gridTemplateColumns,rect:e.getBoundingClientRect().toJSON(),cells:[...e.querySelectorAll('.kv')].map(c=>({text:c.innerText,rect:c.getBoundingClientRect().toJSON(),scroll:c.scrollWidth,client:c.clientWidth}))}));
          observations.contact=metrics;
          if(width<=768)assert.equal(metrics.columns.split(' ').length,1,'mobile contact has full-width fields rather than three squeezed columns');
          for(const c of metrics.cells)assert(c.scroll<=c.client+1,'long contact is not clipped');
          const dates=await page.locator('#bc-field-group-dates .v').evaluateAll(es=>es.map(e=>({text:e.innerText,height:e.getBoundingClientRect().height,line:parseFloat(getComputedStyle(e).lineHeight)})));
          observations.dates=dates;
          for(const d of dates.filter(d=>d.text.includes('2026-')))assert(d.height<=d.line+2,'ordinary date stays on one line');
        }
      }
      if((MODE==='package-ink'||MODE==='full')&&!sunset){
        // Parent Range-based probe: compare actual ink across cells, not overlapping container boxes.
        observations.packageInk=await page.locator('#bc-field-group-package .ctx-field-kv-grid').evaluate(e=>{
          const boxes=[];
          [...e.querySelectorAll('.kv')].forEach((cell,index)=>{
            const walker=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);let n;
            while(n=walker.nextNode())if(n.textContent.trim()){
              const r=document.createRange();r.selectNodeContents(n);
              for(const b of r.getClientRects())if(b.width&&b.height)boxes.push({index,text:n.textContent,rect:b.toJSON()});
            }
          });
          const collisions=[];
          for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
            const a=boxes[i],b=boxes[j];if(a.index===b.index)continue;
            if(Math.min(a.rect.right,b.rect.right)-Math.max(a.rect.left,b.rect.left)>1&&Math.min(a.rect.bottom,b.rect.bottom)-Math.max(a.rect.top,b.rect.top)>1)collisions.push([a,b]);
          }
          return {boxes,collisions};
        });
        assert.equal(observations.packageInk.collisions.length,0,'package/private-room ink does not overlap');
      }
      if((MODE==='protected-guest'||MODE==='full')&&!sunset&&width<=768){
        await page.locator('#bc-field-group-guests').scrollIntoViewIfNeeded();
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        observations.guestRows=await page.locator('#bc-guest-names .bc-guest-name-row').evaluateAll(es=>es.map(e=>{
          const name=e.querySelector('.bc-guest-name-line'),bed=e.querySelector('.bc-guest-bed'),status=e.querySelector('.bc-accom-pay-pebble');
          return {name:name?.getBoundingClientRect().toJSON(),bed:bed?.getBoundingClientRect().toJSON(),status:status?.getBoundingClientRect().toJSON()};
        }));
        assert(observations.guestRows.length,'protected Details guest rows present');
        for(const row of observations.guestRows){
          assert(row.name.width>=40,'protected guest name retains readable allocation');
          if(row.status)assert(row.status.top>=row.name.bottom-1,'protected guest status sits under the name');
          if(row.bed&&row.status)assert(row.bed.top>=row.name.bottom-1&&row.bed.right<=row.status.left+1,'protected bed then payment on the line under the name');
        }
      }
      if(MODE==='finish'||MODE==='full'){
        const samples=page.locator(sunset?'.booking-body-details strong,.booking-body-details .portal-schedule-drawer-section-title,.ps-invoice-line .ps-svc-detail':'#bc-field-group-contact .k,#bc-field-group-dates .k,#bc-inv-services .ctx-inv-group-title,#bc-inv-accommodation .booking-body-line-detail');
        observations.contrast=await samples.evaluateAll(es=>{
          function rgb(s){return (s.match(/[\d.]+/g)||[]).map(Number);}
          function lum(c){const v=c.slice(0,3).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return v[0]*.2126+v[1]*.7152+v[2]*.0722;}
          return es.filter(e=>e.getBoundingClientRect().height>0).map(e=>{const s=getComputedStyle(e);let bg=[255,255,255];const chain=[];for(let p=e;p;p=p.parentElement)chain.push(p);for(const p of chain.reverse()){const c=rgb(getComputedStyle(p).backgroundColor),a=c.length===4?c[3]:1;bg=bg.map((x,i)=>c[i]*a+x*(1-a));}const a=lum(rgb(s.color)),b=lum(bg);return {text:e.textContent,color:s.color,background:bg,font:parseFloat(s.fontSize),ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});
        });
        assert(observations.contrast.length>=4,'measured representative body labels, headings and details');
        for(const sample of observations.contrast){assert(sample.font>=12,'body label at least 12px: '+sample.text);assert(sample.ratio>=4.5,'normal-text contrast 4.5:1: '+JSON.stringify(sample));}
        // The inline mobile pencil is hidden by the existing desktop editor layout.
        const control=page.locator(sunset?'#ps-drawer-edit':width>768?'#bc-payment-history-toggle':'#bc-field-group-contact .btn-bc-field-edit');
        await page.keyboard.press('Tab');
        await control.focus();
        observations.focus=await control.evaluate(e=>{
          const s=getComputedStyle(e);
          function rgb(x){return (x.match(/[\d.]+/g)||[]).map(Number);}
          function lum(c){const v=c.slice(0,3).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return v[0]*.2126+v[1]*.7152+v[2]*.0722;}
          let bg=[255,255,255],chain=[];for(let p=e.parentElement;p;p=p.parentElement)chain.push(p);
          for(const p of chain.reverse()){const c=rgb(getComputedStyle(p).backgroundColor),a=c.length===4?c[3]:1;bg=bg.map((x,i)=>c[i]*a+x*(1-a));}
          const ratio=c=>{const a=lum(rgb(c)),b=lum(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
          return {outline:s.outlineStyle,width:parseFloat(s.outlineWidth),focusRatio:ratio(s.outlineColor),borderRatio:ratio(s.borderTopColor),color:s.color,background:bg};
        });
        assert(observations.focus.width>=2&&observations.focus.outline!=='none','visible 2px body keyboard focus');
        assert(observations.focus.focusRatio>=3,'body focus contrast 3:1');
        assert(observations.focus.borderRatio>=3,'body control boundary contrast 3:1');
        const density=await page.locator(sunset?'.booking-body-details .portal-schedule-drawer-section':'#bc-drawer-card-booking').evaluate(e=>{const s=getComputedStyle(e);return {shadow:s.boxShadow,margin:parseFloat(s.marginBottom)};});
        observations.density=density;assert.equal(density.shadow,'none','no nested body card shadow');assert(density.margin<=14,'controlled body card spacing');
      }
      if(MODE==='reentry'&&!sunset){
        // Review focused-probe.cjs reproduction: real calendar click, desktop guest/all-fields pencil.
        const edit=page.locator(width>768?'#bc-field-group-guests .btn-bc-field-edit':'#bc-field-group-contact .btn-bc-field-edit');
        await edit.click();await page.locator('#bc-field-contact-email').fill('review-unsaved@example.test');
        const editor=await page.locator('#bc-field-contact-email').elementHandle();
        const before=ledger.filter(e=>e.url.includes('/'+CODE+'/context')).length;
        await page.locator('.bc-block').first().click();await page.mouse.move(10,500);
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        observations.reentry=await page.evaluate(()=>({invoice:!!document.querySelector('#bc-inv-totals'),email:document.querySelector('#bc-field-contact-email')?.value,loading:document.querySelector('#bc-drawer-preview')?.innerText}));
        assert(await editor.evaluate(e=>e.isConnected),'same-booking native reentry preserves dirty editor mount');
        assert.equal(observations.reentry.email,'review-unsaved@example.test','same-booking reentry preserves dirty value');
        assert(observations.reentry.invoice,'invoice is not stranded behind Loading full details');
        assert.equal(ledger.filter(e=>e.url.includes('/'+CODE+'/context')).length,before,'dirty reentry does not replace context');
        // Save directly from the preserved reentry session (no intervening Cancel).
        await page.locator('#bc-field-contact-email').fill('saved@example.test');
        await page.locator(width>768?'#bc-inline-save':'#bc-field-save-contact').click();
        await page.waitForFunction(e=>!e.isConnected,editor);
        assert.equal(await page.locator('#bc-field-contact-email').inputValue(),'saved@example.test','Save reloads authoritative contact value');
        assert.equal(ledger.filter(e=>e.syntheticWrite).length,1,'Save after reentry keeps exact single contact write');
        await edit.click();await page.locator('#bc-field-contact-email').fill('discard@example.test');
        await page.locator(width>768?'#bc-inline-cancel':'[data-bc-field-cancel="contact"]').click();
        assert.equal(await page.locator('#bc-field-contact-email').inputValue(),'saved@example.test','Cancel after direct reentry Save restores snapshot');
        if(width>768)await page.locator('#bc-side-close').click();
        else {await page.locator('.bc-block').nth(1).click();await page.waitForFunction(()=>document.querySelector('#bc-field-group-contact')?.textContent.includes('Other booking'));}
        await page.locator('.bc-block').first().click();await page.mouse.move(10,500);
        await page.locator('#bc-inv-totals').waitFor();
        assert.equal(await page.locator('#bc-field-contact-email').inputValue(),'saved@example.test','fresh open after Save renders current facts');
        await edit.click();await page.locator('#bc-field-contact-email').fill('not-other@example.test');
        await page.locator('.bc-block').nth(1).click();await page.mouse.move(10,500);
        await page.waitForFunction(()=>document.querySelector('#bc-field-contact-name')?.value==='Other booking');
      }
      if(MODE==='save-reload-ownership'){
        await page.locator('#bc-field-group-guests .btn-bc-field-edit').click();
        await page.locator('#bc-field-contact-email').fill('delayed-save@example.test');
        deferContext=true;
        await page.locator('#bc-inline-save').click();
        for(let i=0;i<100&&!releaseContext;i++)await new Promise(resolve=>setTimeout(resolve,20));
        assert(releaseContext,'actual Save context GET held');
        if(variant==='reopen'){
          await page.locator('#bc-side-close').click();
          state.booking.email='new-generation@example.test';
          await page.locator('.bc-block').first().click();await page.mouse.move(10,500);
          await page.waitForFunction(()=>document.querySelector('#bc-field-contact-email')?.value==='new-generation@example.test');
        }else if(variant==='dirty'){
          await page.locator('#bc-field-group-guests .btn-bc-field-edit').click();
          await page.locator('#bc-field-contact-email').fill('new-unsaved@example.test');
        }else{
          await page.locator('.bc-block').nth(1).click();await page.mouse.move(10,500);
          await page.waitForFunction(()=>document.querySelector('#bc-field-contact-name')?.value==='Other booking');
        }
        const mount=await page.locator('#bc-drawer-card-booking').elementHandle();
        const snapshot=()=>page.evaluate(()=>({title:document.querySelector('#bc-side-title')?.textContent,name:document.querySelector('#bc-field-contact-name')?.value,email:document.querySelector('#bc-field-contact-email')?.value,invoice:document.querySelector('#bc-inv-totals')?.textContent,actionBooking:document.querySelector('#bc-side-drawer')?.getAttribute('data-mounted-booking-id'),actionGeneration:document.querySelector('#bc-side-drawer')?.getAttribute('data-booking-view-generation')}));
        observations.beforeRelease=await snapshot();
        const completed=variant==='network-error'?page.waitForEvent('requestfailed',r=>r.url().includes('/'+CODE+'/context')):page.waitForResponse(r=>r.url().includes('/'+CODE+'/context'));
        releaseContext();await completed;
        await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,100)));
        observations.afterRelease=await snapshot();
        assert.deepEqual(observations.afterRelease,observations.beforeRelease,'late Save '+variant+' completion cannot replace current booking/editor facts');
        assert(await mount.evaluate(e=>e.isConnected),'current mount and its action bindings survive late completion');
        assert.equal(ledger.filter(e=>e.syntheticWrite).length,1,'only original synthetic contact Save; no payment/write probe');
        assert.equal(ledger.find(e=>e.syntheticWrite).body.client_slug,tenant);
        if(variant==='dirty')assert(await page.locator('#bc-field-contact-email').isVisible(),'new dirty editor stays active');
      }
      if(MODE==='editor'&&!sunset){
        const edit=page.locator('#bc-field-group-contact .btn-bc-field-edit');
        await edit.click();
        await page.locator('#bc-field-contact-email').fill('unsaved@example.test');
        await page.locator('#bc-refresh-detail').click();
        assert.equal(await page.locator('#bc-field-contact-email').inputValue(),'unsaved@example.test','refresh must not silently discard dirty contact editor');
        assert(await page.locator('#bc-field-contact-email').isVisible(),'dirty editor remains open');
        await page.setViewportSize({width,height:360});
        const cancel=page.locator('[data-bc-field-cancel="contact"]');
        await cancel.scrollIntoViewIfNeeded();await cancel.focus();
        const box=await cancel.boundingBox();assert(box.y>=0&&box.y+box.height<=360,'cancel reachable in reduced-viewport keyboard proxy');
        await page.keyboard.press('Enter');
        assert(await edit.evaluate(e=>e===document.activeElement),'cancel returns focus to its editor trigger');
        await edit.click();await page.locator('#bc-field-contact-email').fill('saved@example.test');
        const save=page.locator('#bc-field-save-contact');await save.scrollIntoViewIfNeeded();await save.focus();
        const saveBox=await save.boundingBox();assert(saveBox.y>=0&&saveBox.y+saveBox.height<=360,'save reachable with reduced viewport');
        const actionCss=await save.evaluate(e=>({padding:getComputedStyle(e.parentElement).paddingBottom,position:getComputedStyle(e.parentElement).position}));
        observations.editorActions=actionCss;
        assert(parseFloat(actionCss.padding)>=8,'editor actions reserve bottom safe-area spacing');
        await page.keyboard.press('Enter');
        await page.waitForFunction(()=>document.querySelector('#bc-field-group-contact .ctx-field-read')?.textContent.includes('saved@example.test'));
        assert.equal(ledger.filter(e=>e.syntheticWrite).length,1,'exactly one local synthetic contact save');
        assert.equal(ledger.find(e=>e.syntheticWrite).body.email,'saved@example.test','unchanged contact write contract');
        await page.setViewportSize({width,height:1000});
      }
      if(MODE==='editor'&&sunset){
        await page.locator('#ps-drawer-edit').click();
        await page.locator('#ps-drawer-guest').waitFor();
        await page.locator('#ps-drawer-guest').fill('Unsaved Sunset name');
        await page.setViewportSize({width,height:360});
        for(const id of ['ps-drawer-save','ps-drawer-cancel']){
          const control=page.locator('#'+id);await control.scrollIntoViewIfNeeded();
          const box=await control.boundingBox();assert(box.y>=0&&box.y+box.height<=360,'Sunset editor action reachable: '+id);
        }
        await page.locator('#ps-drawer-cancel').focus();await page.keyboard.press('Enter');
        await page.locator('.booking-body-details').waitFor();
        assert((await page.locator('.booking-body-details').innerText()).includes(NAME),'native cancel discards unsaved Sunset name');
        await page.setViewportSize({width,height:1000});
      }
      if(MODE==='controls'){
        if(!sunset){
          const tab=page.locator('.bc-drawer-tab[data-tab="services"]');
          await tab.focus();await page.keyboard.press('Enter');
          assert(await tab.evaluate(e=>e===document.activeElement),'keyboard tab activation retains focus');
          const overview=page.locator('.bc-drawer-tab[data-tab="overview"]');await overview.focus();await page.keyboard.press('Enter');
        }
        const controls=page.locator(sunset?'#ps-drawer-edit,#ps-drawer-conversation-btn':'#bc-field-group-contact .btn-bc-field-edit,#bc-payment-history-toggle,#bc-move-bed-toggle');
        observations.controls=await controls.evaluateAll(es=>es.filter(e=>e.getBoundingClientRect().width>0).map(e=>({id:e.id,rect:e.getBoundingClientRect().toJSON()})));
        assert(observations.controls.length>=2,'native body controls present');
        for(const c of observations.controls)assert(c.rect.height>=44&&c.rect.width>=44,'body control touch target 44px: '+c.id);
      }
      if(MODE==='collapse'&&!sunset){
        const ids=['bc-per-guest-toggle','bc-payment-history-toggle','bc-move-bed-toggle'];
        for(const id of ids){assert.equal(await page.locator('#'+id).getAttribute('aria-expanded'),'false','initially collapsed');await page.locator('#'+id).click();}
        await page.locator('#bc-payment-history-toggle').focus();
        await page.evaluate(()=>document.getElementById('bc-refresh-detail').click());
        await page.locator('#bc-inv-totals').waitFor();
        assert(await page.locator('#bc-payment-history-toggle').evaluate(e=>e===document.activeElement),'refresh restores focused body disclosure');
        for(const id of ids)assert.equal(await page.locator('#'+id).getAttribute('aria-expanded'),'true','same-booking refresh retains '+id);
        await page.locator('.bc-block').nth(1).click();await page.mouse.move(10,500);
        await page.waitForFunction(()=>document.querySelector('#bc-field-group-contact')?.textContent.includes('Other booking'));
        for(const id of ids)assert.equal(await page.locator('#'+id).getAttribute('aria-expanded'),'false','different booking resets '+id);
      }
      if(MODE==='unknown-inclusion'){
        observations.unknownInclusion=String(value);
        assert.equal(await page.locator('.booking-body-included').count(),0,'unknown price is not explicit included zero: '+String(value));
      }
      if(MODE==='fresh-disclosures'&&!sunset){
        const ids=['bc-per-guest-toggle','bc-payment-history-toggle','bc-move-bed-toggle'];
        for(const close of [true,false]){
          for(const id of ids)await page.locator('#'+id).click();
          assert.equal(await page.locator('.booking-body-package-assignments').count(),0,'bottom package dropdown is gone');
          if(close)await page.locator('#bc-side-close').click();
          const old=await page.locator('#bc-inv-totals').elementHandle();
          await page.locator('.bc-block').first().click();await page.mouse.move(10,500);
          await page.waitForFunction(e=>!e.isConnected,old);await page.locator('#bc-inv-totals').waitFor();
          for(const id of ids)assert.equal(await page.locator('#'+id).getAttribute('aria-expanded'),'false','fresh native open resets '+id+' close='+close);
          assert.equal(await page.locator('.booking-body-package-assignments').count(),0,'bottom package dropdown stays gone');
        }
      }
      if(MODE==='package-refresh'&&!sunset){
        assert.equal(await page.locator('.booking-body-package-assignments').count(),0,'bottom package dropdown is gone');
        await page.locator('#bc-refresh-detail').click();await page.locator('#bc-inv-totals').waitFor();
        assert.equal(await page.locator('.booking-body-package-assignments').count(),0,'refresh does not restore the package dropdown');
        await page.locator('.bc-block').nth(1).click();await page.mouse.move(10,500);
        await page.waitForFunction(()=>document.querySelector('#bc-field-contact-name')?.value==='Other booking');
        assert.equal(await page.locator('.booking-body-package-assignments').count(),0,'other booking has no package dropdown');
      }
      if(MODE==='facts'){
        const included=page.locator('.booking-body-included');
        assert.equal(await included.count(),1,'explicit equipment inclusion is visible and not a second charged rental');
        assert((await included.innerText()).includes('Included'),'inclusion uses factual, translated label');
        if(!sunset){
          assert.equal(await page.locator('.booking-body-package-assignments').count(),0,'bottom package dropdown is gone');
          const names=(await page.locator('#bc-guest-names .bc-guest-name-line').allTextContents()).join(' ');
          const pebbles=(await page.locator('#bc-guest-names .bc-guest-pebble-line').allTextContents()).join(' ');
          assert(names.includes('Tom (test)')&&names.includes('Second Guest'),'guest names stay on the name line');
          assert(pebbles.includes('Malibu')&&pebbles.includes('Waimea'),'package pebbles stay with the guests');
        }
      }
      if(MODE==='invoice'||MODE==='full'){
        const lines=page.locator(sunset?'.ps-invoice-line':'#bc-inv-services .ctx-inv-addon-line');
        assert.equal(await lines.count(),2,'both paid and recorded-zero commercial lines retained');
        const amounts=lines.locator(sunset?'.ps-invoice-amt':'.booking-body-line-amount');
        assert.deepEqual((await amounts.allTextContents()).sort(),['€0.00','€123.45'],'authoritative amounts separated from prose, including real zero');
        observations.bill=await lines.evaluateAll(es=>es.map(e=>{const a=e.querySelector('.booking-body-line-amount,.ps-invoice-amt');return {text:e.innerText,rect:e.getBoundingClientRect().toJSON(),amount:a.getBoundingClientRect().toJSON(),nowrap:getComputedStyle(a).whiteSpace};}));
        for(const line of observations.bill){assert(line.amount.right<=line.rect.right+1&&line.amount.left>=line.rect.left,'amount inside bill');assert.equal(line.nowrap,'nowrap','amount never breaks');}
        assert(Math.abs(observations.bill[0].amount.right-observations.bill[1].amount.right)<2,'bill amounts share a right edge');
        if(!sunset){
          assert.equal(await page.locator('#bc-inv-services.booking-body-empty').count(),0,'recorded zero is not empty');
          assert.equal(await page.locator('#bc-inv-transfers.booking-body-empty').count(),1,'truly empty transfers get compact summary');
        }
      }
      if(MODE==='invoice-edge'){
        const lines=page.locator(sunset?'.ps-invoice-line':'#bc-inv-services .ctx-inv-addon-line');
        assert.equal(await lines.count(),2,'fallback retains zero and signed adjustment line identities');
        const amounts=lines.locator(sunset?'.ps-invoice-amt':'.booking-body-line-amount');
        assert.deepEqual((await amounts.allTextContents()).sort(),['€-2.50','€0.00'],'refund and recorded zero remain authoritative');
        assert((await lines.allTextContents()).some(x=>x.includes('factual')),'factual fallback label preserved');
        if(!sunset)assert.equal(await page.locator('#bc-inv-accommodation .booking-body-line-amount').count(),0,'unknown accommodation never invents an amount');
        else assert((await page.locator('#ps-drawer-payment-box').innerText()).includes('€2.50'),'existing refund footer remains discoverable');
        observations.edge=await lines.allTextContents();
      }
      await page.locator(sunset?'.booking-body-details':'#bc-drawer-card-booking').scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(OUT,name+'-local-synthetic.png')});
    }catch(e){failures.push(name+': '+e.message);await page.screenshot({path:path.join(OUT,name+'-failure.png')}).catch(()=>{});}
    finally{if(errors.length)failures.push(name+': page errors '+JSON.stringify(errors));if(ledger.some(e=>e.blocked||e.unknown))failures.push(name+': unexpected request');results.push({name,observations,ledger,errors});await ctx.close();}
  }}finally{await browser.close();}
  fs.writeFileSync(path.join(OUT,'results.json'),JSON.stringify({mode:MODE,results,failures},null,2));
  if(MODE==='full'){
    const combined={layout:{cases:results.length,failures:[...failures]},representativeInteractions:[],limitations:['Offline synthetic HTTP only','360px reduced viewport is not a physical keyboard','Italian is a label smoke; interactions run in English']};
    for(const mode of ['facts','unknown-inclusion','collapse','controls','editor','reentry','save-reload-ownership','package-refresh','fresh-disclosures','protected-guest','package-ink','italian','invoice-edge','disclosure-key']){
      const dir=path.join(OUT,mode),r=spawnSync(process.execPath,[__filename,dir,mode],{cwd:ROOT,encoding:'utf8',timeout:240000});
      fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'command.log'),r.stdout+'\n'+r.stderr);
      const result=fs.existsSync(path.join(dir,'results.json'))?JSON.parse(fs.readFileSync(path.join(dir,'results.json'),'utf8')):null;
      combined.representativeInteractions.push({mode,status:r.status,cases:result?.results.length,failures:result?.failures,error:r.error?.message});
      if(r.status!==0)failures.push(mode+' representative matrix failed');
    }
    combined.failures=failures;fs.writeFileSync(path.join(OUT,'combined.json'),JSON.stringify(combined,null,2));
  }
  console.log(JSON.stringify({mode:MODE,cases:results.length,failures},null,2));if(failures.length)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
