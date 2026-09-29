'use strict';
// Real emitted /staff/ui, native tenant profiles, ordinary booking clicks.
// Synthetic read-only HTTP fixtures only; never forwards requests to a service.
// Usage: node scripts/verify-booking-card-header.js <evidence-dir> [identity|full|copy-delay|chips]
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
  assert(['identity','full','copy-delay','chips'].includes(MODE), 'known mode');
  fs.mkdirSync(OUT, {recursive:true});
  const htmls = Object.fromEntries(['wolfhouse-somo','sunset'].map(t=>[t,process.env.HEADER_TEST_HTML ? fs.readFileSync(process.env.HEADER_TEST_HTML,'utf8') : emit(t, OUT)]));
  const browser = await chromium.launch({headless:true});
  try {
    const scenarios=MODE==='identity'?[{width:1440,theme:'light',variant:'long'}]:MODE==='copy-delay'?[{width:1440,theme:'light',variant:'short'}]:MODE==='chips'?[{width:769,theme:'light',variant:'chips'}]:[
      ...[1440,769,768,390,320].flatMap(width=>['light','dark'].map(theme=>({width,theme,variant:'long'}))),
      {width:1440,theme:'light',variant:'short'}, {width:390,theme:'dark',variant:'escaped'}, {width:769,theme:'light',variant:'chips'}
    ];
    for (const tenant of ['wolfhouse-somo','sunset']) for (const {width,theme,variant} of scenarios) {
      const sunset=tenant==='sunset', html=htmls[tenant];
      const CODE=(sunset?'SUNSET-':'WH-')+(variant==='short'?'20260924-001':variant==='escaped'?'REF-<b>&"quoted"-Ω':LONG_CODE);
      const name = `${tenant}-${width}-${theme}-${variant}`, ledger = [], errors = [], observations = [];
      const state = clone(detail), cal = clone(calendar);
      state.booking.booking_code = CODE;
      state.booking.guest_name = 'Header test booker';
      cal.blocks[0].booking_code = CODE;
      cal.blocks[0].guest_name = state.booking.guest_name;
      if(variant==='chips') { state.booking.needs_rooming_review=true;state.transfers=['arrival','departure'].map(direction=>({direction,status:'confirmed',price_cents:0}));cal.blocks[0].transfer_summary={has_transfer:true,directions:['arrival','departure']}; }
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
        else if(p==='/staff/conversations') data={success:true,conversations:[]};
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
        if(MODE!=='identity' && !sunset && width>768) {
          const m=await page.evaluate(()=>{
            const title=document.getElementById('bc-side-title').getBoundingClientRect();
            const chips=document.getElementById('bc-side-header-pebbles');
            return {title:title.toJSON(),chips:chips.getBoundingClientRect().toJSON(),labels:chips.innerText,wrap:getComputedStyle(chips).flexWrap};
          });
          observations.push(m);
          assert(m.labels.includes('Balance due €600.00'),'existing payment meaning and amount preserved');
          if(variant==='chips') assert(m.labels.includes('Rooming review') && m.labels.includes('Arrival') && m.labels.includes('Departure'),'multiple existing chip meanings preserved');
          assert(m.chips.top>=m.title.bottom,'chips have own row below booking identity');
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
