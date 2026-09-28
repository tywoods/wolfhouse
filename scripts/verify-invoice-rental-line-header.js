'use strict';
// Local synthetic HTTP fixtures; unmodified production HTML and ordinary calendar clicks.
// Usage: node scripts/verify-invoice-rental-line-header.js <evidence-dir> [placement|mobile|full]
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
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
const hash = x => createHash('sha256').update(x).digest('hex');
const LONG = 'Advanced <img src="https://escape.invalid/test"> & "Family" ' + 'Longname'.repeat(18);
const RENTAL = 'surfboard — 5 rental days × 4 people';
const EXPECTED = {lesson:'3× Surf lesson',rental:RENTAL,mixed:'3× Surf lesson, '+RENTAL,empty:'',long:'2× '+LONG};
function fixture(kind='rental') {
  const s = clone(detail);
  const addOns=[{code:'soft_top_rental',days:5,quantity:4}];
  const quote=calculateWolfhouseQuote({client_slug:'wolfhouse-somo',check_in:s.booking.check_in,check_out:s.booking.check_out,guest_count:2,package_code:'package_none',payment_choice:'deposit',add_ons:addOns});
  const rentals=buildManualBookingServiceRecordRows({addOns,quote,clientSlug:'wolfhouse-somo',bookingId:s.booking.booking_id,bookingCode:CODE,guestCount:2});
  const lesson={service_record_id:'lesson-one',service_type:'surf_lesson',quantity:3,amount_due_cents:10000,status:'confirmed',metadata:{course_label:'Surf lesson'}};
  s.service_records=kind==='rental'?rentals:kind==='lesson'?[lesson]:kind==='mixed'?[lesson,...rentals]:kind==='long'?[{...lesson,quantity:2,metadata:{service_name:LONG}}]:[];
  s.transfers=[{direction:'arrival',status:'confirmed',price_cents:0}];
  s.booking.amount_paid_cents=60000;
  s.payments={paid_total_cents:60000,rows:[{payment_id:'paid-all',payment_status:'paid',amount_paid_cents:60000,metadata:{payment_scope:'booking',method:'cash'}}]};
  return s;
}
async function main() {
  assert(['placement','mobile','full'].includes(MODE),'known mode');
  fs.mkdirSync(OUT,{recursive:true});
  let html = process.env.INVOICE_TEST_HTML ? fs.readFileSync(process.env.INVOICE_TEST_HTML,'utf8') : emit('wolfhouse-somo',OUT);
  const wolfhouseHtml=html;
  const ledger=[],errors=[],cases=[],observations=[]; let state=fixture(),failure,tenant='wolfhouse-somo';
  const other=fixture('empty');other.booking.booking_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';other.booking.booking_code='WH-OTHER';other.booking.guest_name='Other booking';
  const cal=clone(calendar);cal.blocks[0].transfer_summary={has_transfer:true,directions:['arrival']};
  cal.blocks.push({...clone(cal.blocks[0]),...other.booking,bed_code:'R1-B2'});
  const browser=await chromium.launch({headless:true});
  const ctx=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await ctx.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url()),e={method:req.method(),url:req.url()};ledger.push(e);
    if(req.method()==='GET'&&u.origin==='https://fonts.googleapis.com'&&u.pathname==='/css2'){e.optionalFontAborted=true;return route.abort();}
    if(u.origin!==ORIGIN||req.method()!=='GET'){e.blocked=true;return route.abort();}
    const p=u.pathname;let data;
    if(p==='/staff/ui')return route.fulfill({contentType:'text/html',body:html});
    if(p==='/staff/bed-calendar')data=cal;
    else if(p===`/staff/bookings/${CODE}/context`)data=state;
    else if(p==='/staff/bookings/WH-OTHER/context')data=other;
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
    else if(tenant==='sunset'&&p==='/staff/schedule/bookings/catalog')data={success:true,offerings:[],courses:[]};
    else if(tenant==='sunset'&&p==='/staff/schedule/day')data={success:true,date:u.searchParams.get('date'),lessons:[],gear:[],rows:[]};
    else if([detail.booking.booking_id,other.booking.booking_id].some(id=>p===`/staff/bookings/${id}/services`))data={success:true,paid_requested_services:[],unscheduled_services:[],services_by_date:[]};
    else if([detail.booking.booking_id,other.booking.booking_id].some(id=>p===`/staff/bookings/${id}/transfers`))data={success:true,transfers:(p.includes(other.booking.booking_id)?other:state).transfers};
    else if(p==='/staff/clients')data={success:true,clients:[{slug:tenant,name:tenant}]};
    else {e.unknown=true;return route.abort();}
    return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await ctx.addInitScript(()=>{localStorage.setItem('wh_staff_portal_locale','en');window.WebSocket=function(){throw Error('Offline WebSocket denied');};window.EventSource=function(){throw Error('Offline EventSource denied');};});
  let page;
  // Independent fixtures must not retain old documents/renderer work across navigations.
  // Keep the context (real storage) and keep refresh/reopen/switch interactions on one page.
  async function navigateFresh(width) {
    if(page)await page.close();
    page=await ctx.newPage();page.on('pageerror',e=>errors.push(String(e)));
    page.setDefaultTimeout(10000);
    await page.setViewportSize({width,height:1000});
    await page.goto(ORIGIN+'/staff/ui');
  }
  async function open(width=1440,theme='light') {
    await navigateFresh(width);
    await page.waitForFunction(()=>typeof window.switchToTab==='function'&&document.getElementById('c-client').value==='wolfhouse-somo');
    await page.evaluate(()=>window.switchToTab('bed-calendar'));
    await page.locator('.bc-block').first().click();await page.mouse.move(10,500);
    await page.locator('#bc-inv-totals').waitFor();
    await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),theme);
    assert(await page.locator(width<=768?'#bc-detail #bc-drawer-card-booking':'#bc-side-drawer #bc-drawer-card-booking').isVisible(),'ordinary active mount');
  }
  async function placement(width,expected,name) {
    const header=page.locator(width<=768?'#bc-detail > .toolbar':'#bc-side-drawer .bc-side-head');
    await header.scrollIntoViewIfNeeded();
    const observation=await header.evaluate(e=>({html:e.outerHTML,box:e.getBoundingClientRect().toJSON()}));
    observations.push({name,width,...observation});
    await page.screenshot({path:path.join(OUT,name+'.png')});
    assert.equal(await header.locator('.bc-guest-services').count(),expected?1:0,'existing service summary belongs in active booking header');
    assert.equal(await page.locator('.bc-guest-services').count(),expected?1:0,'exactly one summary, no hidden stale duplicate');
    assert.equal(await page.locator('#bc-field-group-guests .bc-guest-services').count(),0,'no summary below guest rows');
    assert.equal(await page.locator('.bc-booking-header-lines').count(),width<=768?1:0,'mobile header never nests on refresh');
    assert.match(await header.innerText(),/2026-09-24 → 2026-09-29/,'booking dates retained');
    assert.equal(await header.locator('.transfer-pebble-drawer').count(),1,'one current Transfer pebble');
    if(expected) {
      assert.equal(await header.locator('.bc-guest-services').innerText(),expected,'unchanged quantity label');
      const geometry=await header.evaluate(e=>{
        const summary=e.querySelector('.bc-guest-services');
        const meta=summary.parentElement;
        const date=document.createRange();date.selectNodeContents(meta.firstChild);
        const payment=summary.nextElementSibling;
        const range=document.createRange();range.selectNodeContents(summary);
        return {header:e.getBoundingClientRect().toJSON(),summary:summary.getBoundingClientRect().toJSON(),textRects:Array.from(range.getClientRects(),r=>r.toJSON()),dates:date.getBoundingClientRect().toJSON(),payment:payment.getBoundingClientRect().toJSON(),paymentText:payment.textContent,summaryChildren:summary.children.length};
      });
      observations.push({name,geometry});
      assert.equal(geometry.summaryChildren,0,'escaped summary is text, never active markup');
      assert(geometry.dates.bottom<=geometry.summary.top+1,'summary below booking dates');
      assert(geometry.summary.bottom<=geometry.payment.top+1,'summary above Paid/Transfer pebbles');
      assert.match(geometry.paymentText,/Paid/,'paid status remains');
      assert.match(geometry.paymentText,/Transfer/,'Transfer pebble remains');
      for(const r of [geometry.summary,...geometry.textRects,geometry.payment]) {
        assert(r.left>=geometry.header.left-1&&r.right<=geometry.header.right+1,'header horizontal containment');
        assert(r.left>=-1&&r.right<=width+1,'viewport horizontal containment');
        assert(r.top>=geometry.header.top-1&&r.bottom<=geometry.header.bottom+1,'header vertical containment');
      }
      assert(geometry.summary.top>=0&&geometry.summary.bottom<=1000,'summary actually visible in evidence');
    }
    cases.push(name);
  }
  async function refresh(expected) {
    const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/staff/bookings/${CODE}/context`);
    await page.locator('#bc-refresh-links-btn').click();await response;
    await page.waitForFunction(text=>{
      const summaries=document.querySelectorAll('.bc-guest-services');
      return text?summaries.length===1&&summaries[0].textContent===text:summaries.length===0;
    },expected);
  }
  async function clickBooking(index) {
    const code=index?'WH-OTHER':CODE;
    const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/staff/bookings/${code}/context`);
    await page.locator('.bc-block').nth(index).click();await page.mouse.move(10,500);await response;
    await page.locator('#bc-inv-totals').waitFor();
  }
  try {
    if(MODE!=='full') {
      const width=MODE==='mobile'?390:1440;
      await open(width);await placement(width,RENTAL,'placement-'+width);
    } else {
      for(const width of [1440,390,320])for(const theme of ['light','dark']) {
        for(const kind of ['lesson','rental','mixed','empty','long']) {
          state=fixture(kind);const before=JSON.stringify(state);
          await open(width,theme);await placement(width,EXPECTED[kind],`${kind}-${width}-${theme}`);
          assert.equal(JSON.stringify(state),before,'presentation never mutates financial or rental inputs');
        }
        state=fixture('empty');await open(width,theme);
        state=fixture('mixed');await refresh(EXPECTED.mixed);await placement(width,EXPECTED.mixed,`refresh-populated-${width}-${theme}`);
        state=fixture();state.service_records=Array.from({length:5},(_,i)=>({service_record_id:'split-'+i,booking_id:state.booking.booking_id,service_type:'surfboard',quantity:1,status:'confirmed',amount_due_cents:2000,metadata:JSON.stringify(normalizeSplitRentalMetadata({rental_days:5,rental_people:6,split_from:'rental-source',split_unit:i+1},'surfboard'))}));
        const updated='surfboard — 5 rental days × 6 people';
        await refresh(updated);await placement(width,updated,`refresh-current-count-${width}-${theme}`);
        await refresh(updated);await placement(width,updated,`refresh-repeat-${width}-${theme}`);
        state=fixture('empty');await refresh('');await placement(width,'',`refresh-cleared-${width}-${theme}`);
        state=fixture('lesson');await refresh(EXPECTED.lesson);await placement(width,EXPECTED.lesson,`refresh-repopulated-${width}-${theme}`);
        if(width>768){await page.locator('#bc-side-close').click();await clickBooking(0);}
        else await open(width,theme); // Inline mobile detail has no close; same-booking click intentionally reuses its mount.
        await placement(width,EXPECTED.lesson,`reopen-${width}-${theme}`);
        await clickBooking(1);await placement(width,'',`switch-empty-${width}-${theme}`);
        await clickBooking(0);await placement(width,EXPECTED.lesson,`switch-back-${width}-${theme}`);
        await page.locator('#bc-record-payment-btn').click();
        assert.equal(await page.locator('#bc-payment-scope').inputValue(),'booking');
        assert.equal(await page.locator('#bc-payment-amount').inputValue(),'');
        assert.equal(await page.locator('[name="bc-payment-method"]:checked').count(),0);await page.keyboard.press('Escape');
      }
      tenant='sunset';html=emit(tenant,OUT);
      for(const width of [1440,390,320])for(const theme of ['light','dark']) {
        await navigateFresh(width);
        await page.waitForFunction(()=>typeof window.switchToTab==='function'&&document.getElementById('c-client').value==='sunset');
        await page.evaluate(()=>window.switchToTab('bed-calendar'));
        await page.waitForFunction(()=>document.getElementById('tab-portal-home').classList.contains('active'));
        await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),theme);
        assert.equal(await page.locator('#bc-grid-resize-handle').isVisible(),false);
        assert.equal(await page.locator('#bc-side-drawer .bc-drawer-tab').count(),0);
        assert.equal(await page.locator('.bc-guest-services').count(),0);
        const name=`sunset-native-${width}-${theme}`;await page.screenshot({path:path.join(OUT,name+'.png')});
        observations.push({name,lodgingCalendarHidden:true,note:'Native profile, not target drawer coverage.'});cases.push(name);
      }
    }
    assert.equal(cases.length,MODE==='full'?6*5+6*8+6:1,'complete mode case count');
    assert.equal(errors.length,0,'page errors');
    assert.equal(ledger.filter(e=>e.unknown||e.blocked).length,0,'unexpected requests');
  } catch(e) {failure=e;try{await page.screenshot({path:path.join(OUT,'failure.png')});}catch(_){} }
  finally {
    const sourceHashes=Object.fromEntries(['scripts/staff-query-api.js','scripts/browser/booking-invoice.js','scripts/verify-invoice-rental-line-header.js'].map(f=>[f,hash(fs.readFileSync(path.join(ROOT,f)))]));
    fs.writeFileSync(path.join(OUT,'results.json'),JSON.stringify({mode:MODE,sourceHashes,htmlSha256:hash(wolfhouseHtml),cases,observations,ledger,errors,failure:failure?String(failure.stack):null},null,2));
    await browser.close();
  }
  console.log(JSON.stringify({mode:MODE,cases:cases.length,failure:failure?String(failure):null,out:OUT},null,2));
  if(failure)throw failure;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
