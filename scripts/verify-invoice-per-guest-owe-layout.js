'use strict';
// Actual emitted portal + ordinary calendar click. All HTTP is fixture-only; no server.
// node scripts/verify-invoice-per-guest-owe-layout.js <evidence-dir> [money|layout|totals|full]
// INVOICE_TEST_HTML=<untouched emitted HTML> runs identical assertions as a negative control.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { emit, calendar, detail, CODE } = require('./verify-booking-drawer-invoice-tab');
const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
const ROOT = path.resolve(__dirname, '..'), OUT = path.resolve(process.argv[2]);
const MODE = process.argv[3] || 'full', ORIGIN = 'http://staff.test';
const clone = x => JSON.parse(JSON.stringify(x));
const names = ['Alexandria Verylongsurname (test)', 'Tom & Teresa Longsurname (test)', 'Zoë Longsurname (test)', 'Sam (test)'];
function fixture(kind = 'full') {
  const s = clone(detail);
  const paid = {full:120000,partial:9000,zero:0,overpaid:130000,guest:9000,unknown:9000,'unknown-known-shares':9000,fallback:0}[kind];
  s.booking = {...s.booking, guest_count:4, guest_name:names[0], total_amount_cents:120000, accommodation_total_cents:120000, deposit_required_cents:36000, amount_paid_cents:paid, balance_due_cents:Math.max(0,120000-paid)};
  s.booking_guests = names.map((name,i)=>({...clone(detail.booking_guests[0]), booking_guest_id:`bbbbbbbb-bbbb-4bbb-8bbb-${String(i+1).padStart(12,'0')}`, guest_number:i+1, guest_name:name, amount_paid_cents:kind==='guest'&&i===1?9000:0}));
  s.guest_accommodation_lines = names.map((_,i)=>({guest_number:i+1,accommodation_cents:30000,nights:5}));
  s.payments = {paid_total_cents:paid, rows:paid?[{payment_id:'receipt',payment_status:'paid',amount_paid_cents:paid,booking_guest_id:kind==='guest'?s.booking_guests[1].booking_guest_id:null,metadata:{method:'cash',payment_scope:kind==='guest'?'guest':'booking'}}]:[]};
  if(kind==='unknown') {s.booking.total_amount_cents=null;s.booking.accommodation_total_cents=null;s.guest_accommodation_lines=[];s.booking_guests.forEach(g=>{g.metadata={};});}
  if(kind==='unknown-known-shares') {s.booking.total_amount_cents=null;s.booking.accommodation_total_cents=null;s.guest_accommodation_lines=[];}
  if(kind==='fallback') {s.booking_guests.forEach(g=>{g.metadata={};});s.per_person=s.booking_guests.map(g=>({guest_number:g.guest_number,subtotal_cents:30000,deposit_amount_cents:9000}));}
  return s;
}
async function main() {
  fs.mkdirSync(OUT,{recursive:true});
  let tenant='wolfhouse-somo', state=fixture(), failure;
  let html=process.env.INVOICE_TEST_HTML?fs.readFileSync(process.env.INVOICE_TEST_HTML,'utf8'):emit(tenant,OUT);
  const ledger=[], errors=[], consoleErrors=[], cases=[], observations=[];
  const browser=await chromium.launch({headless:true});
  const ctx=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await ctx.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url()),e={method:req.method(),url:req.url()};ledger.push(e);
    if(req.method()==='GET'&&u.origin==='https://fonts.googleapis.com'&&u.pathname==='/css2'){e.optionalFontAborted=true;return route.abort();}
    if(u.origin!==ORIGIN||req.method()!=='GET'){e.blocked=true;return route.abort();}
    const p=u.pathname;let data;
    if(p==='/staff/ui')return route.fulfill({contentType:'text/html',body:html});
    if(p==='/staff/bed-calendar')data=calendar;
    else if(p===`/staff/bookings/${CODE}/context`)data=state;
    else if(p==='/staff/auth/session')data={success:true,auth_required:false,role:'admin',clients:[{slug:tenant,name:tenant}],client_profiles:{[tenant]:loadClientPortalProfile(tenant)}};
    else if(p.startsWith('/staff/assets/')){const a=path.join(ROOT,'config/staff-portal',path.basename(p));if(fs.existsSync(a))return route.fulfill({path:a});e.unknown=true;return route.abort();}
    else if(p==='/staff/intents')data={success:true,intents:[]};
    else if(p==='/staff/inbox/luna-mode')data={success:true,mode:'off'};
    else if(p==='/staff/bot/global-pause-state')data={success:true,paused:false};
    else if(p==='/staff/whatsapp-numbers')data={success:true,numbers:[]};
    else if(p==='/staff/admin/house-notes')data={success:true,notes:''};
    else if(p==='/staff/automated-notifications')data={success:true,notifications:[]};
    else if(p==='/staff/packages')data={success:true,packages:[]};
    else if(p==='/staff/conversations')data={success:true,conversations:[]};
    else if(p==='/staff/admin/config')data={success:true,...resolveTenantBusinessConfig(tenant,'sunset-somo')};
    else if(p==='/staff/admin/config/rental-offerings')data={success:true,offerings:[]};
    else if(p==='/staff/schedule/bookings/catalog')data={success:true,offerings:[],courses:[]};
    else if(p==='/staff/schedule/day')data={success:true,date:u.searchParams.get('date'),lessons:[],gear:[],rows:[]};
    else if(p===`/staff/bookings/${detail.booking.booking_id}/services`)data={success:true,paid_requested_services:[],unscheduled_services:[],services_by_date:[]};
    else if(p===`/staff/bookings/${detail.booking.booking_id}/transfers`)data={success:true,transfers:[]};
    else if(p==='/staff/clients')data={success:true,clients:[{slug:tenant,name:tenant}]};
    else {e.unknown=true;return route.abort();}
    return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await ctx.addInitScript(()=>{localStorage.setItem('wh_staff_portal_locale','en');window.WebSocket=function(){throw Error('Offline WebSocket denied');};window.EventSource=function(){throw Error('Offline EventSource denied');};});
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')consoleErrors.push({text:m.text(),location:m.location()});});
  async function open(width=1440,theme='light') {
    await page.setViewportSize({width,height:1000});await page.goto(ORIGIN+'/staff/ui');
    await page.waitForFunction(t=>typeof window.switchToTab==='function'&&document.getElementById('c-client').value===t,tenant);
    await page.evaluate(()=>window.switchToTab('bed-calendar'));
    if(tenant==='sunset'){await page.waitForFunction(()=>document.getElementById('tab-portal-home').classList.contains('active'));}
    else {await page.locator('.bc-block').first().click();await page.mouse.move(10,500);await page.locator('#bc-inv-totals').waitFor();assert(await page.locator(width<=768?'#bc-detail #bc-drawer-card-booking':'#bc-side-drawer #bc-drawer-card-booking').isVisible(),'ordinary active mount');}
    await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),theme);
    await page.evaluate(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));});
  }
  async function money(kind) {
    const owes=await page.locator('.bc-guest-pay-owed').allTextContents();
    const paid=await page.locator('.bc-guest-pay-paid').allTextContents();
    const expected=kind==='full'||kind==='overpaid'||kind==='unknown'?['€0.00','€0.00','€0.00','€0.00']:kind==='guest'?['€300.00','€210.00','€300.00','€300.00']:Array(4).fill('€300.00');
    observations.push({kind,owes,paid,totals:await page.locator('#bc-inv-totals').innerText()});
    assert.deepEqual(owes,expected,kind+': fully settled booking owes zero; partial booking fence is not settlement');
    assert.deepEqual(paid,kind==='guest'?['€0.00','€90.00','€0.00','€0.00']:Array(4).fill('€0.00'),'booking receipts never fabricate guest Paid allocation');
    assert.equal(await page.locator('.bc-create-guest-payment-link-btn').count(),['zero','fallback'].includes(kind)?8:kind==='guest'?7:0,'preserve collection fence and guest actions');
  }
  try {
    if(MODE==='money'||MODE==='full') {
      for(const kind of ['full','partial','zero','overpaid','guest','unknown','unknown-known-shares','fallback']) {
        state=fixture(kind);const before=JSON.stringify(state);await open();await money(kind);assert.equal(JSON.stringify(state),before,'fixture financial inputs unchanged');cases.push('money-'+kind);
      }
    }
    if(MODE==='layout'||MODE==='full') {
      for(const kind of ['full','partial'])for(const width of [320,390,430,1440])for(const theme of ['light','dark']) {
        state=fixture(kind);await open(width,theme);
        if(await page.locator('#bc-per-guest-toggle').count()&&await page.locator('#bc-per-guest-toggle').getAttribute('aria-expanded')!=='true') await page.locator('#bc-per-guest-toggle').click();
        await money(kind);
        const rows=page.locator('.bc-guest-pay-row');assert.equal(await rows.count(),4);
        for(let i=0;i<4;i++) {
          const row=rows.nth(i);
          assert.deepEqual(await row.locator('.bc-guest-pay-title').allTextContents(),['Paid','Owe','Price'],'clear Paid/Owe/Price titles');
          assert.equal(await row.locator('.bc-guest-pay-price').innerText(),'€300.00','stored guest price');
          assert.equal(await row.locator('.bc-guest-pay-name').innerText(),names[i],'full escaped long name retained');
          const geometry=await row.evaluate(e=>{
            const box=s=>e.querySelector(s).getBoundingClientRect().toJSON();
            const fits=s=>{const el=e.querySelector(s),r=document.createRange();r.selectNodeContents(el);const b=el.getBoundingClientRect(),rects=Array.from(r.getClientRects());return el.scrollWidth<=el.clientWidth+1&&rects.every(t=>t.left>=b.left-1&&t.right<=b.right+1&&t.top>=b.top-1&&t.bottom<=b.bottom+1);};
            const price=e.querySelector('.bc-guest-pay-price'),style=getComputedStyle(price);
            return {row:e.getBoundingClientRect().toJSON(),name:box('.bc-guest-pay-name'),paid:box('.bc-guest-pay-paid'),owed:box('.bc-guest-pay-owed'),price:box('.bc-guest-pay-price'),color:style.color,background:style.backgroundColor,priceWeight:style.fontWeight,readable:['.bc-guest-pay-name','.bc-guest-pay-paid','.bc-guest-pay-owed','.bc-guest-pay-price'].every(fits)};
          });
          observations.push({kind,width,theme,i,geometry});
          if(theme==='dark'){
            assert.equal(geometry.color,'rgb(255, 255, 255)','dark price is white');
            assert.notEqual(geometry.background,'rgb(255, 255, 255)','dark price has no white backing');
            assert(Number(geometry.priceWeight)>=700,'dark price is bold like Paid/Owe');
          } else {
            assert.equal(geometry.color,'rgb(0, 0, 0)','price is black');
            assert(Number(geometry.priceWeight)<700,'light price is not bold');
          }
          assert(geometry.paid.right<=geometry.owed.left&&geometry.owed.right<geometry.price.left,'Paid/Owe left of price');
          assert(geometry.paid.top>=geometry.name.bottom-1,'Paid/Owe/Price sit on the next line');
          assert(geometry.name.bottom<=geometry.paid.top+1,'name does not overlap money');
          assert(geometry.name.width>=geometry.row.width*0.32,'long names keep a readable share');
          assert(geometry.price.right>=geometry.row.right-1,'price sits on the right edge');
          assert(geometry.readable,'long names and amounts fully readable without overflow');
          assert(geometry.row.left>=0&&geometry.row.right<=width+1,'contained at minimum mobile width');
        }
        await page.locator('#bc-inv-per-guest').scrollIntoViewIfNeeded();
        const b=await page.locator('#bc-inv-per-guest').boundingBox();assert(b.y>=0&&b.y+b.height<=1001,'entire screenshot target visible');
        await page.screenshot({path:path.join(OUT,`per-guest-${kind}-${width}-${theme}.png`)});
        cases.push(`layout-${kind}-${width}-${theme}`);
      }
      for(const kind of ['unknown','fallback']) {state=fixture(kind);await open();assert.deepEqual(await page.locator('.bc-guest-pay-price').allTextContents(),Array(4).fill(kind==='unknown'?'—':'€300.00'),'unknown is unavailable; quote fallback preserved');cases.push('price-'+kind);}
    }
    if(MODE==='totals'||MODE==='full') {
      for(const kind of ['full','zero'])for(const width of [320,390,430,1440])for(const theme of ['light','dark']) {
        state=fixture(kind);state.guest_accommodation_lines.forEach(g=>{g.accommodation_cents=29000;});state.service_records=[{service_record_id:'yoga',service_type:'yoga',quantity:2,amount_due_cents:4000,status:'confirmed',metadata:{}}];
        await open(width,theme);
        for(const section of ['accommodation','services']) {
          const total=page.locator(`#bc-inv-${section} .bc-invoice-section-total`);
          const g=await total.evaluate(e=>{const label=e.querySelector('.ctx-inv-total-label'),amount=e.querySelector('.ctx-inv-total-amount');return {row:e.getBoundingClientRect().toJSON(),label:label.getBoundingClientRect().toJSON(),amount:amount.getBoundingClientRect().toJSON(),labelAlign:getComputedStyle(label).textAlign,amountAlign:getComputedStyle(amount).textAlign,text:amount.textContent};});
          observations.push({kind,width,theme,section,g});
          assert.equal(g.labelAlign,'right',section+' Total label right aligned');assert.equal(g.amountAlign,'right',section+' Total amount right aligned');
          assert(Math.abs(g.amount.right-g.row.right)<=1,'section amount at right edge');assert(g.amount.left-g.label.right<=12,'section Total label beside amount, not stranded left');
          assert.equal(g.text,section==='accommodation'?'€1160.00':'€40.00','unchanged section calculations');
        }
        const totals=await page.locator('#bc-inv-totals .ctx-inv-total-amount').evaluateAll(es=>es.map(e=>({rect:e.getBoundingClientRect().toJSON(),align:getComputedStyle(e).textAlign,text:e.textContent})));
        observations.push({kind,width,theme,totals});
        assert.deepEqual(totals.map(x=>x.text),kind==='full'?['€1200.00','€400.00','€1200.00']:['€1200.00','€400.00','€0.00','€1200.00'],'deposit is nights × guests');
        for(const a of totals){assert.equal(a.align,'right');assert(Math.abs(a.rect.right-totals[0].rect.right)<=1,'every TOTALS amount shares right edge');assert(a.rect.left>=0&&a.rect.right<=width,'TOTALS amount contained');}
        const links=page.locator('#bc-inv-totals .bc-total-create-link');
        assert.equal(await links.count(),kind==='full'?0:2,'booking collection controls preserved');
        if(kind==='zero') {assert.deepEqual(await links.allTextContents(),['Deposit Link','Payment Link']);for(const link of await links.all()){const b=await link.boundingBox();assert(b.x>=totals[0].rect.right&&b.x+b.width<=width,'link remains readable to right of amount');assert(await link.isEnabled());}}
        for(const target of ['bc-inv-accommodation','bc-inv-totals']) {await page.locator('#'+target).scrollIntoViewIfNeeded();const b=await page.locator('#'+target).boundingBox();assert(b.y>=0&&b.y+b.height<=1001,'screenshot total target visible');await page.screenshot({path:path.join(OUT,`${target}-${kind}-${width}-${theme}.png`)});}
        cases.push(`totals-${kind}-${width}-${theme}`);
      }
    }
    if(MODE==='lifecycle'||MODE==='full') {
      for(const width of [320,390,430,1440])for(const theme of ['light','dark']) {
        state=fixture('partial');await open(width,theme);await money('partial');
        for(const kind of ['full','partial']) {
          state=fixture(kind);const response=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/context'));
          await page.locator('#bc-refresh-links-btn').click();await response;
          await page.waitForFunction(expected=>document.querySelector('.bc-guest-pay-owed')?.textContent===expected,kind==='full'?'€0.00':'€300.00');
          await money(kind);assert.deepEqual(await page.locator('.bc-guest-pay-price').allTextContents(),Array(4).fill('€300.00'));
          assert.equal(await page.locator('#bc-inv-per-guest').count(),1,'refresh retains one per-guest mount');
          assert.equal(await page.locator('.bc-guest-pay-title').count(),12,'refresh retains titles');
        }
        await open(width,theme);await money('partial');cases.push(`refresh-reopen-${width}-${theme}`);
      }
    }
    if(MODE==='sunset'||MODE==='full') {
      tenant='sunset';html=emit(tenant,OUT);
      for(const width of [320,390,430,1440])for(const theme of ['light','dark']) {
        await open(width,theme);assert.equal(await page.locator('#bc-grid-resize-handle').isVisible(),false,'native Sunset lodging hidden');
        assert.equal(await page.locator('.bc-guest-pay-row').count(),0,'no force-enabled Invoice on native Sunset');
        await page.screenshot({path:path.join(OUT,`sunset-native-${width}-${theme}.png`)});cases.push(`sunset-native-${width}-${theme}`);
      }
    }
    const expected={money:8,layout:18,totals:16,lifecycle:8,sunset:8,full:58};assert.equal(cases.length,expected[MODE],'complete explicit case count');
    assert.equal(errors.length,0,'page errors');assert.equal(ledger.filter(e=>e.unknown||e.blocked).length,0,'unexpected requests');
    assert.equal(consoleErrors.filter(e=>!e.location.url.startsWith('https://fonts.googleapis.com/')).length,0,'unexpected console errors');
  } catch(e) {failure=e;await page.screenshot({path:path.join(OUT,'failure.png')}).catch(()=>{});}
  finally {await ctx.close();await browser.close();}
  const result={mode:MODE,ok:!failure,caseCount:cases.length,cases,failure:failure?String(failure.stack):null,observations,ledger,errors,consoleErrors};
  fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({mode:MODE,ok:result.ok,caseCount:cases.length,failure:failure?failure.message:null,out:OUT}));if(failure)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
