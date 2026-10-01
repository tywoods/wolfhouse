'use strict';
// Real emitted /staff/ui, native tenant profiles, ordinary booking clicks.
// Synthetic read-only HTTP fixtures only; never forwards requests to a service.
// Usage: node scripts/verify-booking-card-header.js <evidence-dir> [identity|full|copy-delay|chips|chrome-header|chrome-tabs|chrome-refresh|chrome-states]
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { emit, calendar, detail } = require('./verify-booking-drawer-invoice-tab');
const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
const ROOT = path.resolve(__dirname, '..'), OUT = path.resolve(process.argv[2] || 'artifacts/booking-card-header');
const MODE = process.argv[3] || 'full', ORIGIN = 'http://staff.test';
const clone = x => JSON.parse(JSON.stringify(x));
const LONG_CODE = 'HEADER-2026-REFERENCE-' + '0123456789'.repeat(6);
const results = [], failures = [];
async function main() {
  assert(['identity','full','copy-delay','chips','chrome-header','chrome-tabs','chrome-refresh','chrome-states','chrome-nav'].includes(MODE), 'known mode');
  fs.mkdirSync(OUT, {recursive:true});
  const htmls = Object.fromEntries(['wolfhouse-somo','sunset'].map(t=>[t,process.env.HEADER_TEST_HTML ? fs.readFileSync(process.env.HEADER_TEST_HTML,'utf8') : emit(t, OUT)]));
  const browser = await chromium.launch({headless:true});
  try {
    const multichipScenarios=[1440,769,768,390,320].flatMap(width=>['light','dark'].flatMap(theme=>['chips','paid-chips'].map(variant=>({width,theme,variant}))));
    const scenarios=MODE==='chrome-nav'?[1440,390,320].flatMap(width=>['conversation','customer'].map(variant=>({width,theme:'light',variant}))):MODE==='chrome-states'?[
      ...[1440,769,390,320].flatMap(width=>['paid','no-phone','services'].map(variant=>({width,theme:'light',variant}))),
      ...multichipScenarios
    ]:MODE.startsWith('chrome-')?[1440,769,768,430,390,360,320].flatMap(width=>['light','dark'].flatMap(theme=>(MODE==='chrome-header'?['short','chips','paid-chips']:['short']).map(variant=>({width,theme,variant})))):MODE==='identity'?[{width:1440,theme:'light',variant:'long'}]:MODE==='copy-delay'?[{width:1440,theme:'light',variant:'short'}]:MODE==='chips'?[{width:769,theme:'light',variant:'chips'}]:[
      ...[1440,769,768,390,320].flatMap(width=>['light','dark'].map(theme=>({width,theme,variant:'long'}))),
      {width:1440,theme:'light',variant:'short'}, {width:390,theme:'dark',variant:'escaped'},
      ...multichipScenarios
    ];
    for (const tenant of ['wolfhouse-somo','sunset']) for (const {width,theme,variant} of scenarios) {
      const sunset=tenant==='sunset', html=htmls[tenant];
      const paid=variant==='paid' || variant==='paid-chips', multichip=variant==='chips' || variant==='paid-chips';
      const CODE=(sunset?'SUNSET-':'WH-')+(variant==='short'?'20260924-001':variant==='escaped'?'REF-<b>&"quoted"-Ω':LONG_CODE);
      const name = `${tenant}-${width}-${theme}-${variant}`, ledger = [], errors = [], observations = [];
      const state = clone(detail), cal = clone(calendar);
      state.booking.booking_code = CODE;
      state.booking.guest_name = 'Header test booker';
      if(MODE.startsWith('chrome-')) { state.booking.phone='+34999000111'; state.conversation={conversation_id:'11111111-1111-4111-8111-111111111111',phone:state.booking.phone}; }
      if(paid) {state.payments={paid_total_cents:60000,rows:[{payment_id:'paid-all',payment_status:'paid',amount_paid_cents:60000,metadata:{payment_scope:'booking',method:'cash'}}]};}
      if(variant==='no-phone') {delete state.booking.phone;state.conversation=null;}
      if(variant==='services') state.service_records=[{service_type:'surfboard',quantity:4,metadata:{rental_people:4}},{service_type:'wetsuit',quantity:4,metadata:{rental_people:4}},{service_type:'yoga',quantity:4}];
      cal.blocks[0].booking_code = CODE;
      cal.blocks[0].guest_name = state.booking.guest_name;
      if(multichip) { state.booking.needs_rooming_review=true;state.transfers=['arrival','departure'].map(direction=>({direction,status:'confirmed',price_cents:0}));cal.blocks[0].transfer_summary={has_transfer:true,directions:['arrival','departure']}; }
      const sun = {booking_id:state.booking.booking_id,booking_code:CODE,guest_name:state.booking.guest_name,
        status:'confirmed',booking_status:'confirmed',payment_status:'unpaid',payment_method:'in_store',
        date_from:'2026-09-24',date_to:'2026-09-24',service_dates:['2026-09-24'],service_date_start:'2026-09-24',service_date_end:'2026-09-24',
        total_cents:60000,amount_paid_cents:0,balance_due_cents:60000,currency:'EUR',guest_count:1,
        components:{lessons:[],rentals:[],addons:[]},participants:[],invoice_lines:[],payments:[]};
      const ctx = await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
      await ctx.routeWebSocket('**/*', ws => { errors.push('Unexpected WebSocket: '+ws.url()); ws.close(); });
      await ctx.route('**/*', async route => {
        const req = route.request(), u = new URL(req.url()), entry = {method:req.method(),url:req.url()}; ledger.push(entry);
        if(req.method()==='GET' && u.origin==='https://fonts.googleapis.com' && u.pathname==='/css2') {entry.optionalFontAborted=true;return route.abort();}
        if(req.method()!=='GET' || u.origin!==ORIGIN) {entry.blocked=true;return route.abort();}
        const p = decodeURIComponent(u.pathname); let data;
        if(p==='/staff/ui') return route.fulfill({contentType:'text/html',body:html});
        if(p==='/staff/bed-calendar') data=cal;
        else if(p===`/staff/bookings/${CODE}/context`) data=state;
        else if(p==='/staff/auth/session') data={success:true,auth_required:false,role:'admin',clients:[{slug:tenant,name:tenant}],client_profiles:{[tenant]:loadClientPortalProfile(tenant)}};
        else if(p.startsWith('/staff/assets/')) {const asset=path.join(ROOT,'config/staff-portal',path.basename(p));if(fs.existsSync(asset))return route.fulfill({path:asset});entry.unknown=true;return route.abort();}
        else if(p==='/staff/intents') data={success:true,intents:[]};
        else if(p==='/staff/inbox/luna-mode') data={success:true,mode:'off'};
        else if(p==='/staff/bot/global-pause-state') data={success:true,paused:false};
        else if(p==='/staff/whatsapp-numbers') data={success:true,numbers:[]};
        else if(p==='/staff/admin/house-notes') data={success:true,notes:''};
        else if(p==='/staff/automated-notifications') data={success:true,notifications:[]};
        else if(p==='/staff/packages') data={success:true,packages:[]};
        else if(p==='/staff/conversations') data={success:true,conversations:MODE==='chrome-nav'?[{...state.conversation,guest_name:'Header test booker',channel:'whatsapp'}]:[]};
        else if(MODE==='chrome-nav' && p==='/staff/inbox/whatsapp/draft') data={success:true,draft:null};
        else if(MODE==='chrome-nav' && p==='/staff/inbox/message-events') data={success:true,events:[]};
        else if(MODE==='chrome-nav' && p==='/staff/inbox/views') data={success:true,groups:[{id:'inbox',label:'INBOX'},{id:'people',label:'PEOPLE'}],views:[{id:'all',label:'All',group:'inbox',count:1},{id:'all_people',label:'All people',group:'people',count:1}]};
        else if(MODE==='chrome-nav' && p==='/staff/inbox/list') data={success:true,rows:[{...state.conversation,customer_id:'22222222-2222-4222-8222-222222222222',display_name:state.booking.guest_name,guest_name:state.booking.guest_name,key:'customer:22222222-2222-4222-8222-222222222222',source:u.searchParams.get('view')==='all_people'?'customers':'conversations',channel:'whatsapp'}],has_more:false};
        else if(MODE==='chrome-nav' && p===`/staff/customers/${state.booking.phone}/context`) data={success:true,phone:state.booking.phone,identity:{customer_id:'22222222-2222-4222-8222-222222222222',conversation_id:'11111111-1111-4111-8111-111111111111',phone:state.booking.phone,display_name:state.booking.guest_name},bookings:[],service_records:[],messages:[],notes:{},conversation_summary:{conversation_id:'11111111-1111-4111-8111-111111111111'}};
        else if(MODE==='chrome-nav' && p==='/staff/inbox/thread/11111111-1111-4111-8111-111111111111') data={success:true,conversation_id:'11111111-1111-4111-8111-111111111111',detail:{success:true,conversation:state.conversation},context:{success:true,context:{guest_name:state.booking.guest_name},bookings:[]},messages:{success:true,messages:[]},draft:{success:false},pause_state:{success:true,paused:false}};
        else if(MODE==='chrome-nav' && p==='/staff/conversations/11111111-1111-4111-8111-111111111111/messages') data={success:true,messages:[]};
        else if(p==='/staff/admin/config') data={success:true,...resolveTenantBusinessConfig(tenant,'sunset-somo')};
        else if(p===`/staff/bookings/${state.booking.booking_id}/services`) data={success:true,paid_requested_services:[],unscheduled_services:[],services_by_date:[]};
        else if(p===`/staff/bookings/${state.booking.booking_id}/transfers`) data={success:true,transfers:state.transfers};
        else if(p==='/staff/clients') data={success:true,clients:[{slug:tenant,name:tenant}]};
        else if(sunset && p==='/staff/admin/config/rental-offerings') data={success:true,offerings:[]};
        else if(sunset && p==='/staff/admin/bookings') data={success:true,rows:[sun],total:1,summary:{}};
        else if(sunset && p===`/staff/schedule/bookings/${sun.booking_id}/waiver`) data={success:true,waiver:null};
        else if(sunset && p==='/staff/schedule/bookings/detail') data={success:true,...sun};
        else if(sunset && p==='/staff/schedule/bookings/catalog') data={success:true,offerings:[],courses:[]};
        else if(sunset && p==='/staff/schedule/day') data={success:true,date:u.searchParams.get('date'),lessons:[],gear:[],rows:[]};
        else {entry.unknown=true;return route.abort();}
        return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
      });
      await ctx.addInitScript(()=>{localStorage.setItem('wh_staff_portal_locale','en');window.EventSource=function(){throw Error('Offline EventSource denied');};});
      const page=await ctx.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(String(e)));
      try {
        await page.goto(ORIGIN+'/staff/ui');
        await page.waitForFunction(t=>typeof window.switchToTab==='function' && document.getElementById('c-client').value===t,tenant);
        await page.evaluate(t=>window.switchToTab(t),sunset?'bookings':'bed-calendar');
        if(sunset) { const link=page.locator('[data-bookings-open-schedule]').first(); await link.focus(); await page.keyboard.press('Enter'); }
        else await page.locator('.bc-block').first().click();
        await page.mouse.move(10,500);
        await page.locator(sunset?'#ps-drawer-copy-code':'#bc-inv-totals').waitFor();
        const header=page.locator(sunset?'#ps-drawer-body .portal-schedule-drawer-hero':width>768?'#bc-side-drawer .bc-side-head':'#bc-detail > .toolbar');
        await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),theme);
        await header.scrollIntoViewIfNeeded();
        const title=page.locator(sunset?'.portal-schedule-drawer-hero-title':width>768?'#bc-side-title':'.bc-detail-title');
        const titleText=await title.evaluate(e=>(e.querySelector('.bc-booking-code') || e.childNodes[0]).textContent);
        observations.push({titleText,header:await header.evaluate(e=>e.outerHTML)});
        await page.screenshot({path:path.join(OUT,name+'-local-synthetic.png')});
        assert.equal(titleText,CODE,'primary header is booking code, never booker');
        // Identify the financial fact by its exact label, not color or sibling order.
        // This also measures the pre-repair renderer for the RED regression proof.
        const checkFinancialGeometry=async phase=>{
          const primary=header.locator('.pill').filter({hasText:/^(Paid|Balance due €600\.00)$/});
          assert.equal(await primary.count(),1,'one actual primary financial pill');
          assert.equal(await primary.innerText(),paid?'Paid':'Balance due €600.00','financial label and amount preserved');
          const m=await primary.evaluate(payment=>{
            const host=payment.parentElement;
            const e=payment.closest('.bc-side-head') || payment.closest('#bc-detail > .toolbar');
            const box=el=>el.getBoundingClientRect().toJSON();
            const visible=selector=>[...e.querySelectorAll(selector)].map(box).filter(r=>r.width>0 && r.height>0);
            return {head:box(e),payment:box(payment),host:box(host),
              nav:visible('#bc-open-conversation-toolbar,#bc-open-customer-card'),controls:visible('button'),
              stay:visible('.bc-side-meta,.bc-guest-services'),chips:[...host.children].map(box),
              refresh:(()=>{const r=e.querySelector('#bc-side-refresh,#bc-refresh-detail');return r&&r.getBoundingClientRect().width?r.getBoundingClientRect().toJSON():null;})(),
              close:(()=>{const r=e.querySelector('#bc-side-close');return r&&r.getBoundingClientRect().width?r.getBoundingClientRect().toJSON():null;})(),
              overflow:e.scrollWidth>e.clientWidth+1,hostOverflow:host.scrollWidth>host.clientWidth+1};
          });
          observations.push({phase,financialGeometry:m});
          assert(m.payment.width>0 && m.payment.height>0,'financial pill visible');
          assert(m.nav.length>0,'at least one visible navigation action');
          assert(m.payment.top>=Math.max(...m.controls.map(r=>r.bottom))-1,'actual financial pill BELOW every visible header action');
          assert(m.payment.top>=Math.max(...m.stay.map(r=>r.bottom))-1,'actual financial pill below stay/services');
          assert(m.refresh,'refresh remains in the header utility cluster');
          assert(m.nav.every(r=>r.right<=m.refresh.left+1),'WhatsApp and guest-card icons sit left of refresh');
          assert(Math.abs(m.payment.right-((m.close&&m.close.width)?m.close.right:m.refresh.right))<=4,'financial pill aligns with the right utility, not the icon pills');
          assert(Math.abs(m.payment.bottom-Math.max(...m.chips.map(r=>r.bottom)))<=1,'financial pill occupies bottom chip row');
          assert(m.head.bottom-m.payment.bottom<=16,'actual financial pill is at header bottom, not just its wrapper');
          assert(!m.overflow && !m.hostOverflow,'header and nested metadata never overflow');
          for(const r of [...m.chips,...m.controls]) {
            assert(r.left>=m.head.left-1 && r.right<=m.head.right+1,'every chip/control remains within header');
            assert(r.left>=-1 && r.right<=width+1,'every chip/control fits viewport');
          }
          assert.equal(await header.locator('.bc-header-payment-primary').count(),1,'one presentation marker');
          assert.match(await primary.getAttribute('class'),/\bbc-header-payment-primary\b/,'marker belongs to actual financial pill');
          if(multichip) {
            assert(await header.locator('.pill').filter({hasText:/^Rooming review$/}).isVisible(),'Rooming review remains visible');
            const transfer=header.locator('.transfer-pebble');
            assert(await transfer.isVisible(),'Transfer remains visible');
            assert.match(await transfer.innerText(),/Arrival \+ Departure/,'both transfer directions preserved');
          }
        };
        if(MODE!=='identity' && !sunset) await checkFinancialGeometry('initial');
        if(['chrome-header','chrome-states'].includes(MODE) && !sunset) {
          const m=await header.evaluate(e=>{
            const box=s=>e.querySelector(s)?.getBoundingClientRect().toJSON();
            return {head:e.getBoundingClientRect().toJSON(),conv:box('#bc-open-conversation-toolbar'),customer:box('#bc-open-customer-card'),payment:box('.bc-header-payment-primary'),meta:box('.bc-side-meta')};
          });
          observations.push(m);
          assert(m.conv?.width>0 && (variant==='no-phone'?m.customer?.width===0:m.customer?.width>0),'navigation visibility follows current booking eligibility');
          assert(m.payment.top>=Math.max(m.conv.bottom,m.customer.bottom)-1,'actions sit above balance');
          assert(m.payment.top>=m.meta.bottom-1,'balance is below stay/services, at bottom of header');
          assert(m.head.bottom-m.payment.bottom<=16,'balance is at the bottom, without filler');
          const refreshEdge=await header.locator(width>768?'#bc-side-refresh':'#bc-refresh-detail').boundingBox();
          assert(refreshEdge&&Math.abs(m.payment.right-(width>768?m.head.right:refreshEdge.x+refreshEdge.width))<=16,'balance stays on the header right, icons do not replace it');
          assert.equal(await page.locator('#bc-open-conversation-toolbar').count(),1,'one navigation owner, no duplicate IDs');
          assert.equal(await page.locator('#bc-open-customer-card').count(),1,'one customer owner');
          const convBtn=header.locator('#bc-open-conversation-toolbar');
          const cardBtn=header.locator('#bc-open-customer-card');
          assert.equal((await convBtn.innerText()).trim(),'','conversation control is an icon, not a text pill');
          assert.equal(await convBtn.locator('svg').count(),1,'conversation uses the Inbox glyph');
          assert.equal(await convBtn.getAttribute('aria-label'),variant==='no-phone'?'Start Conversation':'Open Conversation');
          assert.equal(await cardBtn.getAttribute('aria-label'),'Open customer card');
          assert.equal(await cardBtn.isEnabled(),variant!=='no-phone');
          const iconGeom=await header.evaluate(e=>{
            const box=s=>{const n=e.querySelector(s);return n&&n.getBoundingClientRect().width?n.getBoundingClientRect().toJSON():null;};
            return {conv:box('#bc-open-conversation-toolbar'),card:box('#bc-open-customer-card'),refresh:box('#bc-side-refresh,#bc-refresh-detail'),code:box('.bc-booking-code,.bc-side-title-code'),dates:box('.bc-side-dates'),services:box('.bc-guest-services'),tabs:document.querySelector('.bc-drawer-tabs')?.getBoundingClientRect().toJSON()};
          });
          observations.push({iconGeom});
          assert(iconGeom.refresh&&iconGeom.conv.right<=iconGeom.refresh.left+1,'WhatsApp icon is left of refresh');
          assert(Math.abs(iconGeom.conv.width-iconGeom.refresh.width)<=1&&Math.abs(iconGeom.conv.height-iconGeom.refresh.height)<=1,'WhatsApp icon matches refresh size');
          if(variant!=='no-phone'){
            assert(iconGeom.card&&iconGeom.conv.right<=iconGeom.card.left+1&&iconGeom.card.right<=iconGeom.refresh.left+1,'order is WhatsApp, guest card, refresh');
            assert(Math.abs(iconGeom.card.width-iconGeom.refresh.width)<=1&&Math.abs(iconGeom.card.height-iconGeom.refresh.height)<=1,'guest-card icon matches refresh size');
          }
          if(iconGeom.code&&iconGeom.dates) assert(iconGeom.dates.top-iconGeom.code.bottom<=8,'tight gap from booking code to dates');
          if(variant==='services'&&iconGeom.services&&iconGeom.tabs) assert(iconGeom.tabs.top-iconGeom.services.bottom<=72,'tight gap from rented items to tabs');
          if(paid) assert.equal(await header.locator('.bc-header-payment-primary').innerText(),'Paid');
          if(variant==='services') assert.match(await header.locator('.bc-guest-services').innerText(),/4× surfboard[\s\S]*4× wetsuit[\s\S]*4× yoga/);
        }
        if(MODE==='chrome-tabs' && !sunset) {
          for(const tab of ['overview','services','transfers']) {
            await page.locator('.bc-drawer-tab[data-tab="'+tab+'"]').click();
            const m=await page.locator('.bc-drawer-file-tabs').evaluate(e=>{
              const box=s=>e.querySelector(s).getBoundingClientRect().toJSON();
              return {rail:box('.bc-drawer-tabs'),tabs:[...e.querySelectorAll('.bc-drawer-tab')].map(t=>t.getBoundingClientRect().toJSON()),panel:box('.bc-drawer-tab-content-panel'),card:box('#bc-drawer-card-booking'),guests:box('#bc-field-group-guests'),selected:e.querySelector('.bc-drawer-tab.is-active').dataset.tab};
            });
            observations.push(m);
            assert.equal(m.selected,tab);
            assert(Math.max(...m.tabs.map(t=>t.width))-Math.min(...m.tabs.map(t=>t.width))<=1,'three equal-width tabs');
            assert(Math.abs(m.tabs[0].left-m.panel.left)<=1 && Math.abs(m.tabs[2].right-m.panel.right)<=1,'tabs fill panel width edge to edge');
            assert(Math.abs(m.tabs[0].bottom-m.panel.top)<=2,'tab and body seam stays joined');
            if(tab==='overview') {
              assert(m.card.top-m.panel.top<=9,'compact gap under tabs');
              assert(m.guests.top-m.card.top<=9,'compact top of Invoice body');
            }
          }
          await page.locator('.bc-drawer-tab[data-tab="overview"]').click();
        }
        if(MODE==='chrome-refresh' && !sunset) {
          const refresh=header.locator(width>768?'#bc-side-refresh':'#bc-refresh-detail');
          assert.equal(await refresh.count(),1,'refresh in active header utility cluster');
          assert.equal((await refresh.innerText()).trim(),'','icon only, no Refresh text');
          assert.equal(await refresh.getAttribute('aria-label'),'Refresh');
          assert.equal(await refresh.locator('svg').innerHTML(),await page.locator('#bc-load svg').innerHTML(),'same arrows as Schedule calendar refresh');
          const r=await refresh.boundingBox(),titleBox=await title.boundingBox();
          assert(r.x>=titleBox.x+titleBox.width,'refresh after booking title');
          if(width>768) {const pin=await page.locator('#bc-side-pin').boundingBox();assert(r.x+r.width<=pin.x && Math.abs(r.y-pin.y)<2,'refresh immediately left of PIN');}
          for(let i=0;i<2;i++) {
            const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/staff/bookings/${CODE}/context`);
            await refresh.click(); await response; await page.locator('#bc-inv-totals').waitFor();
            assert.equal(await title.innerText(),CODE,'refresh keeps current booking');
            assert.equal(await page.locator('#bc-open-conversation-toolbar').count(),1,'refresh keeps one action owner');
          }
        }
        if(MODE!=='identity' && !sunset && width>768) {
          const m=await page.evaluate(()=>{
            const title=document.getElementById('bc-side-title').getBoundingClientRect();
            const chips=document.getElementById('bc-side-header-pebbles');
            const pin=document.getElementById('bc-side-pin').getBoundingClientRect();
            const close=document.getElementById('bc-side-close').getBoundingClientRect();
            const box=el=>el.getBoundingClientRect().toJSON();
            return {title:title.toJSON(),chips:box(chips),payment:box(chips.querySelector('.bc-header-payment-primary')),pin:pin.toJSON(),close:close.toJSON(),labels:chips.innerText,wrap:getComputedStyle(chips).flexWrap};
          });
          observations.push(m);
          assert(paid?m.labels.includes('Paid'):m.labels.includes('Balance due €600.00'),'existing payment meaning and amount preserved');
          if(multichip) assert(m.labels.includes('Rooming review') && m.labels.includes('Arrival') && m.labels.includes('Departure'),'multiple existing chip meanings preserved');
          assert(m.payment.top >= m.pin.bottom - 1,'payment pebble sits below the pin, no overlap');
          assert(m.payment.top >= m.close.bottom - 1,'payment pebble sits below the arrow, no overlap');
          assert(Math.abs(m.payment.right - m.close.right) <= 4,'payment pebble is right-aligned with the arrow');
          assert(m.payment.left > m.title.left + 24,'payment pebble is not under the booking code');
          assert(m.payment.right <= width + 1,'payment pebble stays inside the viewport');
          assert(m.chips.left>=0 && m.chips.right<=width+1,'wrapping host stays inside viewport');
          assert.equal(m.wrap,'wrap','chip row wraps');
        }
        if(MODE!=='identity') {
          const geometry=await title.evaluate(e=>{
            const code=e.querySelector('.bc-booking-code') || e;
            const r=code.getBoundingClientRect(),s=getComputedStyle(code);
            return {rect:r.toJSON(),scrollWidth:code.scrollWidth,clientWidth:code.clientWidth,whiteSpace:s.whiteSpace,overflow:s.overflow};
          });
          observations.push(geometry);
          assert.notEqual(geometry.whiteSpace,'nowrap','long reference is allowed to wrap');
          assert(geometry.scrollWidth<=geometry.clientWidth+1,'complete code has no horizontal clipping');
          assert(geometry.rect.left>=0 && geometry.rect.right<=width,'reference fits viewport');
          const copy=header.locator(sunset?'#ps-drawer-copy-code':'[data-bc-copy-code]');
          assert.equal(await copy.count(),1,'one code copy control in active header');
          await page.evaluate(()=>{
            window.__copied=[];
            Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:s=>{window.__copied.push(s);return Promise.resolve();}}});
          });
          await copy.click();
          assert.deepEqual(await page.evaluate(()=>window.__copied),[CODE],'real handler copies complete displayed code');
          await page.waitForFunction(selector=>document.querySelector(selector)?.getAttribute('aria-label')==='Copied',sunset?'#ps-drawer-copy-code':'[data-bc-copy-code]:not([hidden])');
          await copy.focus();await page.keyboard.press('Enter');
          assert.deepEqual(await page.evaluate(()=>window.__copied),[CODE,CODE],'keyboard copy');
          if(variant==='short') {
            await page.evaluate(()=>{navigator.clipboard.writeText=()=>new Promise(resolve=>{window.__finishCopy=resolve;});});
            await copy.click();
            await page.waitForFunction(selector=>document.querySelector(selector)?.getAttribute('aria-label')==='Copy code',sunset?'#ps-drawer-copy-code':'[data-bc-copy-code]:not([hidden])');
            await page.evaluate(()=>window.__finishCopy());
            await page.waitForFunction(selector=>document.querySelector(selector)?.getAttribute('aria-label')==='Copied',sunset?'#ps-drawer-copy-code':'[data-bc-copy-code]:not([hidden])');
            await page.waitForFunction(selector=>document.querySelector(selector)?.getAttribute('aria-label')==='Copy code',sunset?'#ps-drawer-copy-code':'[data-bc-copy-code]:not([hidden])',{timeout:4000});
          }
          // The OS clipboard is a boundary spy; the emitted event handler and fallback run unchanged.
          await page.evaluate(()=>{
            window.__fallback=[];
            navigator.clipboard.writeText=()=>Promise.reject(new Error('fixture clipboard denied'));
            document.execCommand=command=>{window.__fallback.push({command,text:document.activeElement.value});return true;};
          });
          await copy.click();
          await page.waitForFunction(()=>window.__fallback.length===1);
          assert.deepEqual(await page.evaluate(()=>window.__fallback),[{command:'copy',text:CODE}],'denied modern clipboard falls back with exact code');
          await page.waitForFunction(selector=>document.querySelector(selector)?.getAttribute('aria-label')==='Copy code',sunset?'#ps-drawer-copy-code':'[data-bc-copy-code]:not([hidden])');
          // Both clipboard paths failing must offer manual copy, never report success.
          let fallbackPrompt;
          page.once('dialog', async d=>{fallbackPrompt={message:d.message(),value:d.defaultValue()};await d.dismiss();});
          await page.evaluate(()=>{document.execCommand=()=>false;});
          await copy.click();
          await page.waitForFunction(()=>!document.querySelector('textarea[readonly]'));
          assert.deepEqual(fallbackPrompt,{message:'Booking code',value:CODE},'manual-copy prompt when both paths fail');
          assert.equal(await copy.getAttribute('aria-label'),'Copy code','no false success on copy failure');
          const boxes=await header.evaluate(e=>({header:e.getBoundingClientRect().toJSON(),buttons:[...e.querySelectorAll('button')].filter(b=>b.getBoundingClientRect().width>0).map(b=>({id:b.id,rect:b.getBoundingClientRect().toJSON()})),overflow:e.scrollWidth>e.clientWidth}));
          observations.push(boxes);
          assert(!boxes.overflow,'header never horizontally overflows');
          for(const b of boxes.buttons) assert(b.rect.left>=0 && b.rect.right<=width+1,'all header controls inside viewport');
          // Refresh through the real control: header/copy re-created, no stale data or duplicate listener.
          if(sunset || width<=768) await header.locator(sunset?'#ps-drawer-refresh':'#bc-refresh-detail').click();
          else { await page.locator('#bc-side-close').click(); await page.locator('.bc-block').first().click(); }
          await copy.waitFor();
          assert.equal(await copy.getAttribute(sunset?'data-copy':'data-bc-copy-code'),CODE,'copy payload survives refresh');
          await page.evaluate(()=>{window.__copied=[];navigator.clipboard.writeText=s=>{window.__copied.push(s);return Promise.resolve();};});
          await copy.click();
          assert.deepEqual(await page.evaluate(()=>window.__copied),[CODE],'exactly one copy handler after refresh/reopen');
          if(!sunset) await checkFinancialGeometry('refresh/reopen');
        }
        if(MODE==='chrome-nav' && !sunset) {
          const target=variant==='customer'?`/staff/customers/${state.booking.phone}/context`:'/staff/inbox/thread/11111111-1111-4111-8111-111111111111';
          const response=page.waitForResponse(r=>decodeURIComponent(new URL(r.url()).pathname)===target);
          await header.locator(variant==='customer'?'#bc-open-customer-card':'#bc-open-conversation-toolbar').click();
          await response;
          await page.waitForFunction(()=>document.querySelector('#tab-conversations').classList.contains('active'));
          assert(ledger.some(e=>decodeURIComponent(new URL(e.url).pathname)===target),'real navigation requests exactly the selected booking identity');
          observations.push({navigation:variant,target});
        }
      } catch(e) { failures.push(name+': '+e.message); }
      finally {
        if(errors.length)failures.push(name+': page errors '+JSON.stringify(errors));
        if(ledger.some(e=>e.blocked||e.unknown))failures.push(name+': unexpected request');
        results.push({name,observations,ledger,errors}); await ctx.close();
      }
    }
  } finally {await browser.close();}
  fs.writeFileSync(path.join(OUT,'results.json'),JSON.stringify({mode:MODE,results,failures},null,2));
  console.log(JSON.stringify({mode:MODE,cases:results.length,failures},null,2));
  if(failures.length)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
