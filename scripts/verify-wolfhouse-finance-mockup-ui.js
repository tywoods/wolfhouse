'use strict';
// Offline Finance Part 2: actual producer, renderer and composed portal.
const assert = require('assert/strict');
const { computeWolfhouseCreatorFinance: compute, pageWolfhouseCreatorFinance: pageProjection } = require('./lib/sunset-finance-summary');
const { renderWolfhouseCreatorFinanceHtml: render } = require('./browser/sunset-admin-finance-redesign-ui');
const input = { now:new Date('2026-10-27T12:00:00Z'),clientSlug:'wolfhouse-somo',currency:'EUR',view:{granularity:'month',anchor:'2026-10-27'},
  bookings:[{booking_id:'luna',created_at:'2026-10-03',total_amount_cents:10001,metadata:{source:'luna_guest'}},{booking_id:'staff',created_at:'2026-10-04',total_amount_cents:20002,metadata:{}}],
  payments:[],refund_records:[],bsr:[],booked_services:[],booked_transfers:[] };
const projection=compute(input);
const html=render({wolfhouse_creator_finance:projection});
for (const creator of ['luna','staff','total']) {
 const cents=projection.creators.find(r=>r.creator===creator).new_booking_value.amount_cents;
 assert.match(html,new RegExp('data-wh-fin-headline="'+creator+'"[^>]*>[\\s\\S]*?data-wh-fin-cents="'+cents+'"'),creator+' headline must show server booked value, not receipts');
}
console.log('PASS three booked-value headlines use server creator totals');

async function browserProof() {
  const fs=require('fs'),path=require('path');
  const out=process.env.FINANCE_PROOF_DIR || path.resolve(__dirname,'../artifacts/finance-mockup-p2');fs.mkdirSync(out,{recursive:true});
  Object.assign(process.env,{NODE_ENV:'test',STAFF_UI_BUILDER_TEST_SEAM:'1',STAFF_AUTH_REQUIRED:'false',STAFF_AUTH_ALLOW_OPEN:'true',STAFF_PORTAL_LOCALES:'en,es,it',DEFAULT_CLIENT_SLUG:'wolfhouse-somo'});
  const api=require('./staff-query-api');const portal=api.buildUiHtmlForOfflineTest(0,'wolfhouse-somo');
  const {buildClientProfilesMap,getAccessibleClients}=require('./lib/staff-portal-clients');
  const {chromium}=require('playwright');const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:950},serviceWorkers:'block'});
  const requests=[],unexpected=[],errors=[];let failSummary=false,failDetail=false,partial=false,staleOnce=false,missing=false,holdDetail=false,held=null,heldReady=null;
  page.on('pageerror',e=>errors.push(String(e)));
  const allBookings=[...input.bookings,{booking_id:'september',created_at:'2026-09-14',total_amount_cents:403,metadata:{source:'luna_guest'}}];
  let count=0,completed=false;function pass(label){count++;console.log('PASS',label);}
  await page.route('**/*',async route=>{
    const r=route.request(),u=new URL(r.url());
    if(u.origin==='https://fonts.googleapis.com' && r.resourceType()==='stylesheet')return route.fulfill({contentType:'text/css',body:'/* offline system fonts */'});
    if(u.origin!=='http://finance.test' || r.method()!=='GET'){unexpected.push(r.method()+' '+u.href);return route.abort();}
    const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(u.pathname==='/staff/ui')return route.fulfill({contentType:'text/html',body:portal});
    if(['/staff/assets/luna-front-desk-logo.png','/staff/assets/luna-header-sign.png'].includes(u.pathname))return route.fulfill({status:204,body:''});
    if(u.pathname==='/staff/auth/session')return json({success:true,auth_required:false,role:'owner',clients:getAccessibleClients(null),client_profiles:buildClientProfilesMap(null),can_use_owner_insights:true});
    if(u.pathname==='/staff/admin/finance/summary'){
      requests.push(u.href);const q=u.searchParams;
      if(!q.has('creator_detail')&&failSummary)return json({success:false,code:'FINANCE_DATA_QUALITY'},503);
      if(q.has('creator_detail')&&failDetail)return json({success:false},500);
      if(q.has('creator_detail')&&staleOnce){staleOnce=false;allBookings[0].total_amount_cents+=1;return json({success:false,code:'FINANCE_COHORT_STALE'},409);}
      const p=compute({...input,bookings:allBookings,booked_services_unavailable:partial,view:{granularity:q.get('granularity')||'month',anchor:q.get('anchor')||'2026-10-27',start:q.get('start'),end:q.get('end')}});
      let result=p;
      if(q.has('creator_detail')){
        if(q.get('cohort_id')!==p.cohort_id)return json({success:false,code:'FINANCE_COHORT_STALE'},409);
        result=pageProjection(p,{kind:q.get('creator_detail'),creator:q.get('creator')||undefined,currency:q.get('currency'),cohort_id:q.get('cohort_id'),cursor:q.get('cursor')||undefined,limit:100});
      }
      const response={success:true,client:'wolfhouse-somo',summary:{redesign:{view:{granularity:p.scope.range.granularity,range:p.scope.range}}},wolfhouse_creator_finance:missing?undefined:result};
      if(q.has('creator_detail')&&holdDetail){holdDetail=false;held={json,response};if(heldReady)heldReady();return;}
      return json(response);
    }
    // Read-only non-Finance bootstrap fixtures; no booking/payment writes allowed.
    if(['/staff/inbox','/staff/admin','/staff/config','/staff/bookings','/staff/notifications','/staff/owner','/staff/calendar','/staff/luna','/staff/clients','/staff/health','/staff/me','/staff/settings','/staff/luna-intelligence/room-fill','/staff/intents','/staff/bot/global-pause-state','/staff/whatsapp-numbers','/staff/automated-notifications','/staff/bed-calendar'].some(prefix=>u.pathname===prefix||u.pathname.startsWith(prefix+'/')))
      return json({success:true,rows:[],conversations:[],offerings:[],services:[]});
    if(u.pathname==='/favicon.ico')return route.fulfill({status:204,body:''});
    unexpected.push(r.method()+' '+u.href);return route.abort();
  });
  await page.addInitScript(()=>{localStorage.setItem('staff_portal_client','wolfhouse-somo');localStorage.setItem('wh_staff_portal_locale','en');});
  const host=page.locator('#wh-admin-finance-body');
  const settle=()=>host.locator('[data-wh-fin-detail-kind="bookings"] table').waitFor({timeout:15000});
  try {
    await page.goto('http://finance.test/staff/ui',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.getElementById('c-client')?.value==='wolfhouse-somo');
    await page.locator('button.tab-btn[data-tab="admin"]').click();
    await page.locator('[data-wh-admin-tab="finance"]').click();
    await host.locator('[data-wh-fin-month]').waitFor({timeout:5000});
    await settle();
    assert.equal(await host.locator('[data-wh-fin-source=""]').getAttribute('aria-pressed'),'true');
    assert.equal(await host.locator('[data-wh-fin-month]').inputValue(),'2026-10');
    assert.equal(await host.locator('[data-wh-fin-headline]').count(),3);
    assert.equal(await host.locator('[data-wh-fin-row]').count(),2);pass('native Finance entry: All, month and server bookings list');
    const cards=()=>host.locator('[data-wh-fin-headline] [data-wh-fin-cents]').evaluateAll(es=>es.map(e=>e.dataset.whFinCents));
    assert.deepEqual(await cards(),['10001','20002','30003']);
    await host.locator('[data-wh-fin-source="luna"]').click();await page.waitForFunction(()=>document.querySelector('[data-wh-fin-detail-kind="bookings"][data-wh-fin-detail-creator="luna"] table'));
    assert.deepEqual(await cards(),['10001','20002','30003']);assert.equal(await host.locator('[data-wh-fin-row]').count(),1);pass('source filters server list, never three headlines');
    await host.locator('[data-wh-fin-source="staff"]').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('[data-wh-fin-row="staff"]'));
    assert.equal(await host.locator('[data-wh-fin-full-total="new_booking_value_cents"] [data-wh-fin-cents]').getAttribute('data-wh-fin-cents'),'20002');pass('keyboard source selection matches full-cohort total');
    await host.locator('[data-wh-fin-month]').fill('2026-09');await settle();
    await page.waitForFunction(()=>document.querySelector('[data-wh-fin-headline="total"] [data-wh-fin-cents="403"]'));
    assert.equal(await host.locator('[data-wh-fin-row]').count(),0);assert.equal(await host.locator('[data-wh-fin-source="staff"]').getAttribute('aria-pressed'),'true');pass('month switches period; preserves source and honest empty list');
    await host.locator('[data-wh-fin-source=""]').click();await page.waitForFunction(()=>document.querySelector('[data-wh-fin-row="september"]'));
    assert.deepEqual(await cards(),['403','0','403']);pass('All restores server September contributors');
    const beforeClear=requests.length;await host.locator('[data-wh-fin-month]').fill('');
    assert.equal(await host.locator('[data-wh-fin-month]').inputValue(),'2026-09');assert.equal(requests.length,beforeClear);pass('cleared month restores server period, never mismatches visible totals');
    failDetail=true;await host.locator('[data-wh-fin-source="luna"]').click();await host.locator('[data-wh-fin-detail-retry]').waitFor();
    assert.equal(await host.locator('[data-wh-fin-row]').count(),0);assert.deepEqual(await cards(),['403','0','403']);
    failDetail=false;await host.locator('[data-wh-fin-detail-retry]').click();await settle();pass('detail failure clears rows; selection-bound retry preserves headlines');
    holdDetail=true;const ready=new Promise(resolve=>{heldReady=resolve;});
    await host.locator('[data-wh-fin-source="staff"]').click();await ready;
    await host.locator('[data-wh-fin-month]').fill('2026-10');
    await page.waitForFunction(()=>document.querySelector('[data-wh-fin-row="staff"]'));
    await held.json(held.response);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    assert.equal(await host.locator('[data-wh-fin-row="staff"]').count(),1);assert.deepEqual(await cards(),['10001','20002','30003']);pass('late prior-month response cannot repaint current month');
    const beforeRefresh=requests.filter(u=>!u.includes('creator_detail')).length;staleOnce=true;
    await host.locator('[data-wh-fin-source="luna"]').click();await page.waitForFunction(()=>document.querySelector('[data-wh-fin-headline="total"] [data-wh-fin-cents="30004"]'));
    await settle();assert.equal(requests.filter(u=>!u.includes('creator_detail')).length,beforeRefresh+1);
    assert.equal(await host.locator('[data-wh-fin-detail-creator="luna"] [data-wh-fin-row="luna"]').count(),1);pass('real cohort change refreshes once and retries same source');
    failSummary=true;await host.locator('[data-wh-fin-month]').fill('2026-09');await host.locator('#admin-finance-retry').waitFor();
    assert.equal(await host.locator('[data-wh-fin-headline]').count(),0);assert.equal(await host.locator('[data-wh-fin-row]').count(),0);
    failSummary=false;await host.locator('#admin-finance-retry').click();await settle();assert.deepEqual(await cards(),['403','0','403']);pass('503 never retains stale totals; retry uses requested month');
    partial=true;await host.locator('[data-wh-fin-month]').fill('2026-10');await settle();
    assert.equal(await host.locator('[data-wh-fin-headline="total"] [data-wh-fin-state="partial"]').count()>0,true);pass('partial producer state remains visible, never a complete zero');
    partial=false;for(let i=0;i<101;i++)allBookings.push({booking_id:'nov-'+String(i).padStart(3,'0'),created_at:'2026-11-04',total_amount_cents:1,metadata:{source:'luna_guest'}});
    await host.locator('[data-wh-fin-month]').fill('2026-11');await settle();
    assert.equal(await host.locator('[data-wh-fin-row]').count(),100);assert.equal(await host.locator('[data-wh-fin-full-total="new_booking_value_cents"] [data-wh-fin-cents]').getAttribute('data-wh-fin-cents'),'101');
    await host.locator('[data-wh-fin-cursor]').click();await page.waitForFunction(()=>document.querySelector('[data-wh-fin-row="nov-100"]'));
    assert.equal(await host.locator('[data-wh-fin-row]').count(),1);assert.deepEqual(await cards(),['101','0','101']);
    assert.equal(await host.locator('[data-wh-fin-full-total="new_booking_value_cents"] [data-wh-fin-cents]').getAttribute('data-wh-fin-cents'),'101');pass('second page keeps server full-cohort total, not visible-row sum');
    for(const width of [1280,390])for(const theme of ['light','dark'])for(const locale of ['en','es','it']){
      // Locale control lives in the desktop header; switch there, then prove mobile reflow.
      await page.setViewportSize({width:1280,height:950});
      const before=requests.length;await page.locator('.staff-lang-btn[data-lang="'+locale+'"]').click();
      if(await page.locator('html').getAttribute('data-theme')!==theme)await page.locator('#staff-theme-toggle').click();
      assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
      await page.setViewportSize({width,height:950});
      assert.equal(requests.length,before);assert.equal(await host.locator('[data-wh-fin-row="nov-100"]').count(),1);
      assert.equal(await host.locator('[data-wh-fin-source="luna"]').getAttribute('aria-pressed'),'true');
      const geometry=await host.evaluate(root=>{const h=root.getBoundingClientRect();return [...root.querySelectorAll('.wh-fin-headlines .wh-fin-card,.wh-fin-controls button,.wh-fin-controls input')].every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=h.left-1&&r.right<=h.right+1;});});
      assert.equal(geometry,true,locale+' '+theme+' '+width+' controls/headlines overflow');
      await host.locator('h2').first().evaluate(e=>e.scrollIntoView({block:'start'}));
      await page.screenshot({path:path.join(out,'finance-'+width+'-'+theme+'-'+locale+'.png')});
      pass('composed '+width+' '+theme+' '+locale+' preserves source and page through locale repaint');
    }
    missing=true;await host.locator('[data-wh-fin-month]').fill('2026-12');await host.locator('[data-wh-fin-state="missing"]').waitFor();
    assert.equal(await host.locator('[data-wh-fin-cents]').count(),0);assert.equal(await host.locator('[data-wh-fin-row]').count(),0);pass('missing projection cannot fall back to misleading old totals');
    assert.equal(unexpected.length,0,JSON.stringify(unexpected));assert.equal(errors.length,0,JSON.stringify(errors));
    completed=true;
  } finally {
    fs.writeFileSync(path.join(out,'browser-receipt.json'),JSON.stringify({completed,passed:count,requests,unexpected,errors},null,2));await browser.close();
  }
}
browserProof().then(()=>console.log('PASS verify-wolfhouse-finance-mockup-ui')).catch(e=>{console.error(e);process.exitCode=1;});
