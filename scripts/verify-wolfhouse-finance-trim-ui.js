'use strict';
// CAP-FINANCE-TRIM: synthetic fixtures through the real server projection and composed portal.
const assert=require('assert/strict');
const {computeWolfhouseCreatorFinance:compute}=require('./lib/sunset-finance-summary');
const {renderWolfhouseCreatorFinanceHtml:render}=require('./browser/sunset-admin-finance-redesign-ui');
const input={now:new Date('2026-10-28T08:00:00Z'),clientSlug:'wolfhouse-somo',currency:'EUR',view:{granularity:'month'},bookings:[],payments:[],refund_records:[],bsr:[],booked_services:[],booked_transfers:[]};
const before=process.argv.includes('--capture-before');
const html=render({wolfhouse_creator_finance:compute(input)});
if(!before) {
for(const token of ['data-wh-fin-trend=','data-wh-fin-refunds=','data-wh-fin-arrival=','data-wh-fin-warnings=','data-wh-fin-detail=','data-wh-fin-source=','data-wh-fin-month=','data-wh-fin-open=','Behind the numbers','Source filters the bookings list','Bookings created in this period · current saved value before cash refunds.']) assert.ok(!html.includes(token),'Removed from renderer, not CSS-hidden: '+token);
assert.ok(html.indexOf('data-finance-gran="day"')<html.indexOf('data-wh-fin-headline="luna"'),'Single period control above cards');
assert.equal((html.match(/data-finance-gran=/g)||[]).length,5);
assert.ok(!html.includes('data-finance-nav="today"'),'Single range control, no second Today control');
console.log('PASS trim renderer contract');
}

async function browserProof(){
 const fs=require('fs'),path=require('path');
 const out=process.env.FINANCE_PROOF_DIR||path.resolve(__dirname,'../artifacts/finance-trim');fs.mkdirSync(out,{recursive:true});
 Object.assign(process.env,{NODE_ENV:'test',STAFF_UI_BUILDER_TEST_SEAM:'1',STAFF_AUTH_REQUIRED:'false',STAFF_AUTH_ALLOW_OPEN:'true',STAFF_PORTAL_LOCALES:'en,es,it',DEFAULT_CLIENT_SLUG:'wolfhouse-somo'});
 const portal=require('./staff-query-api').buildUiHtmlForOfflineTest(0,'wolfhouse-somo');
 const {buildClientProfilesMap,getAccessibleClients}=require('./lib/staff-portal-clients');
 const {computeSunsetFinanceSummary:legacy,pageWolfhouseCreatorFinance:detail}=require('./lib/sunset-finance-summary');
 // Explicit synthetic fixture matching the supplied MTD acceptance numbers, NOT live guest records.
 const bookings=[];
 for(const [creator,n,total,unit] of [['luna',8,191500,20000],['staff',19,349600,18000]]){
  for(let i=0;i<n;i++)bookings.push({booking_id:creator+'-'+i,created_at:'2026-10-'+(i===0?'28':i===1?'26':'03'),total_amount_cents:i===n-1?total-unit*(n-1):unit,metadata:creator==='luna'?{source:'luna_guest'}:{}});
 }
 bookings.push({booking_id:'prior',created_at:'2026-09-14',total_amount_cents:403,metadata:{source:'luna_guest'}},{booking_id:'tomorrow',created_at:'2026-10-28T23:00:00Z',total_amount_cents:99999,metadata:{source:'luna_guest'}});
 const {chromium}=require('playwright');const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:950},serviceWorkers:'block',timezoneId:'America/Los_Angeles'});
 await page.clock.setFixedTime(input.now);
 const requests=[],unexpected=[],errors=[],cases=[],responses=[];let completed=false,fail=false,partial=false,missing=false,empty=false,hold=false,held=null;
 const fonts=process.env.FINANCE_FONT_DIR;const manifest=fonts?JSON.parse(fs.readFileSync(path.join(fonts,'manifest.json'))):{};
 page.on('pageerror',e=>errors.push(String(e)));
 await page.route('**/*',async route=>{
  const r=route.request(),u=new URL(r.url());
  if(manifest[u.href])return route.fulfill({contentType:manifest[u.href].contentType,body:fs.readFileSync(path.join(fonts,manifest[u.href].file))});
  if(u.origin==='https://fonts.googleapis.com'&&r.resourceType()==='stylesheet')return route.fulfill({contentType:'text/css',body:'/* Offline fallback font; actual-font proof uses FINANCE_FONT_DIR. */'});
  if(u.origin!=='http://finance.test'||r.method()!=='GET'){unexpected.push(r.method()+' '+u.href);return route.abort();}
  const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(u.pathname==='/staff/ui')return route.fulfill({contentType:'text/html',body:portal});
  if(['/staff/assets/luna-front-desk-logo.png','/staff/assets/luna-header-sign.png','/favicon.ico'].includes(u.pathname))return route.fulfill({status:204,body:''});
  if(u.pathname==='/staff/auth/session')return json({success:true,auth_required:false,role:'owner',clients:getAccessibleClients(null),client_profiles:buildClientProfilesMap(null),can_use_owner_insights:true});
  if(u.pathname==='/staff/admin/finance/summary'){
   requests.push(u.href);if(fail)return json({success:false,code:'FINANCE_DATA_QUALITY'},503);
   const q=u.searchParams,view={granularity:q.get('granularity')||'month',anchor:q.get('anchor')||undefined,start:q.get('start'),end:q.get('end')};
   const args={...input,view,bookings:empty?[]:bookings,booked_services_unavailable:partial};const proj=compute(args);
   const response={success:true,client:'wolfhouse-somo',summary:legacy({...args,productMode:'lodging_packages'}),wolfhouse_creator_finance:missing?undefined:proj};
   if(q.has('creator_detail'))response.wolfhouse_creator_finance=detail(proj,{kind:q.get('creator_detail'),currency:'EUR',cohort_id:proj.cohort_id});
   responses.push({url:u.href,scope:proj.scope,creators:proj.creators});
   if(hold){hold=false;held=()=>json(response);return;}
   return json(response);
  }
  if(['/staff/inbox','/staff/admin','/staff/config','/staff/bookings','/staff/notifications','/staff/owner','/staff/calendar','/staff/luna','/staff/clients','/staff/health','/staff/me','/staff/settings','/staff/luna-intelligence/room-fill','/staff/intents','/staff/bot/global-pause-state','/staff/whatsapp-numbers','/staff/automated-notifications','/staff/bed-calendar'].some(prefix=>u.pathname===prefix||u.pathname.startsWith(prefix+'/')))return json({success:true,rows:[],conversations:[],offerings:[],services:[]});
  unexpected.push(r.method()+' '+u.href);return route.abort();
 });
 await page.addInitScript(()=>{localStorage.setItem('staff_portal_client','wolfhouse-somo');localStorage.setItem('wh_staff_portal_locale','en');});
 const host=page.locator('#wh-admin-finance-body'),gran=g=>host.locator('[data-finance-gran="'+g+'"]');
 const settle=()=>host.locator('[data-wh-fin-headline="total"]').waitFor({timeout:15000});
 const values=()=>host.locator('[data-wh-fin-headline]').evaluateAll(es=>es.map(e=>({cents:Number(e.querySelector('[data-wh-fin-cents]').dataset.whFinCents),count:Number(e.querySelector('.wh-fin-count').textContent)})));
 const pass=label=>{cases.push(label);console.log('PASS',label);};
 const verify=async(g,start,end)=>{
  await settle();await page.waitForFunction(g=>document.querySelector('[data-finance-gran="'+g+'"][aria-selected="true"]'),g);
  const result=await values();
  const rows=bookings.filter(b=>{const d=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(b.created_at.length===10?b.created_at+'T12:00:00Z':b.created_at));return d>=start&&d<=end;});
  const expected=['luna','staff','total'].map(c=>{const a=rows.filter(b=>c==='total'||(b.metadata.source==='luna_guest'?'luna':'staff')===c);return {cents:a.reduce((s,b)=>s+b.total_amount_cents,0),count:a.length};});
  assert.deepEqual(result,expected);assert.equal(result[0].cents+result[1].cents,result[2].cents);assert.equal(result[0].count+result[1].count,result[2].count);
  const response=responses.at(-1);assert.equal(response.scope.range.start,start);assert.equal(response.scope.range.end,end);
  const query=new URL(response.url).searchParams;
  if(g!=='custom')for(const key of ['anchor','start','end'])assert.equal(query.has(key),false,'server-timezone preset must not carry a stale/browser anchor: '+key);
  assert.deepEqual(result,response.creators.map(c=>({cents:c.new_booking_value.amount_cents,count:c.new_booking_count.count})));
  pass(g+' server range '+start+'..'+end+' '+JSON.stringify(result));return result;
 };
 try{
  await page.goto('http://finance.test/staff/ui',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.getElementById('c-client')?.value==='wolfhouse-somo');
  await page.locator('button.tab-btn[data-tab="admin"]').click();await page.locator('[data-wh-admin-tab="finance"]').click();await settle();
  if(before)await host.locator('[data-wh-fin-detail-kind="bookings"] table').waitFor();
  if(!before){
   assert.ok(requests.every(u=>!new URL(u).searchParams.has('creator_detail')),'No unused detail fetch at native entry');
   assert.deepEqual(await verify('month','2026-10-01','2026-10-28'),[{cents:191500,count:8},{cents:349600,count:19},{cents:541100,count:27}]);
  }
  for(const width of [1280,390])for(const theme of ['light','dark']){
   await page.setViewportSize({width:1280,height:950});if(await page.locator('html').getAttribute('data-theme')!==theme)await page.locator('#staff-theme-toggle').click();await page.setViewportSize({width,height:950});
   await page.evaluate(()=>document.fonts.ready);
   if(fonts)assert.deepEqual(await page.evaluate(()=>[...new Set([...document.fonts].filter(f=>f.status==='loaded').map(f=>f.family))].sort()),['DM Sans','Manrope']);
   await host.locator('h2').first().evaluate(e=>e.scrollIntoView({block:'start'}));
   await page.screenshot({path:path.join(out,(before?'before':'after')+'-'+width+'-'+theme+'.png')});
   if(!before){
    const geometry=await host.evaluate(root=>{const box=root.getBoundingClientRect(),nav=root.querySelector('.pfb-nav').getBoundingClientRect(),card=root.querySelector('[data-wh-fin-headline]').getBoundingClientRect();return {top:nav.bottom<=card.top,overflow:[...root.querySelectorAll('.wh-fin-headline,.pfb-gran-btn')].some(e=>{const r=e.getBoundingClientRect();return r.left<box.left-1||r.right>box.right+1||r.width<=0;}),bg:getComputedStyle(root.querySelector('.wh-fin')).backgroundColor,primary:getComputedStyle(root.querySelector('.wh-fin-headline')).backgroundColor};});
    if(width===390){
     const mobile=await host.evaluate(root=>({amounts:[...root.querySelectorAll('.wh-fin-headline .wh-fin-amt')].every(e=>e.getBoundingClientRect().height<=parseFloat(getComputedStyle(e).lineHeight)+1),rangeTops:[...root.querySelectorAll('.pfb-gran-btn')].map(e=>e.getBoundingClientRect().top)}));
     assert.equal(mobile.amounts,true,'mobile money must not split its cents onto another line');assert.equal(new Set(mobile.rangeTops).size,1,'all five range choices fit one mobile row');
    }
    assert.equal(geometry.top,true);assert.equal(geometry.overflow,false);assert.equal(geometry.bg,theme==='light'?'rgb(245, 247, 248)':'rgb(33, 61, 73)');assert.equal(geometry.primary,theme==='light'?'rgb(41, 78, 93)':'rgb(53, 93, 110)');
    assert.equal(await host.locator('[data-wh-fin-source],[data-wh-fin-month],[data-wh-fin-detail],[data-wh-fin-open],[data-wh-fin-trend],[data-wh-fin-refunds],[data-wh-fin-arrival],[data-wh-fin-warnings]').count(),0);pass('rendered trim and retained palette '+width+' '+theme);
   }
  }
  if(before){completed=true;return;}
  await page.setViewportSize({width:1280,height:950});
  await gran('week').click();await verify('week','2026-10-26','2026-11-01');
  await gran('day').focus();await page.keyboard.press('Enter');await verify('day','2026-10-28','2026-10-28');
  await gran('year').click();await verify('year','2026-01-01','2026-12-31');
  await gran('month').click();await verify('month','2026-10-01','2026-10-28');
  await gran('custom').click();await host.locator('#pfb-custom-prev').click();assert.match(await host.locator('#pfb-custom-month-label').innerText(),/September/);
  await host.locator('#pfb-custom-next').click();assert.match(await host.locator('#pfb-custom-month-label').innerText(),/October/);
  await host.locator('#pfb-custom-prev').click();await host.locator('#pfb-custom-clear').click();
  const day=d=>host.locator('#pfb-custom-grid [data-date="'+d+'"],#pfb-custom-grid [data-pfb-day="'+d+'"]');
  await day('2026-09-14').click();await day('2026-09-16').click();await verify('custom','2026-09-14','2026-09-16');
  const q=new URL(requests.at(-1)).searchParams;assert.equal(q.get('start'),'2026-09-14');assert.equal(q.get('end'),'2026-09-16');
  for(const locale of ['es','it','en']){const n=requests.length;await page.locator('.staff-lang-btn[data-lang="'+locale+'"]').click();await settle();assert.equal(requests.length,n);assert.deepEqual(await values(),[{cents:403,count:1},{cents:0,count:0},{cents:403,count:1}]);}pass('locale repaint retains server Custom totals without fetch');
  await gran('month').click();await verify('month','2026-10-01','2026-10-28');
  // A second native Finance-tab load supersedes a held summary. No harness-only UI or global hooks.
  hold=true;await page.locator('[data-wh-admin-tab="finance"]').click();await host.locator('[data-wh-fin-summary-state="pending"]').waitFor();assert.equal(await host.locator('[data-wh-fin-headline]').count(),0);
  assert.ok(held);empty=true;await page.locator('[data-wh-admin-tab="finance"]').click();await settle();const zero=[{cents:0,count:0},{cents:0,count:0},{cents:0,count:0}];assert.deepEqual(await values(),zero);await held();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));assert.deepEqual(await values(),zero);empty=false;pass('late superseded summary cannot repaint');
  fail=true;await gran('month').click();await host.locator('#admin-finance-retry').waitFor();assert.equal(await host.locator('[data-wh-fin-headline]').count(),0);fail=false;await host.locator('#admin-finance-retry').click();await verify('month','2026-10-01','2026-10-28');pass('503 clears stale cards, requested-range retry');
  partial=true;await gran('month').click();await settle();assert.ok(await host.locator('[data-wh-fin-headline="total"] [data-wh-fin-state="partial"]').count());pass('card-level incompleteness survives removed warning section');partial=false;
  empty=true;await gran('month').click();await settle();assert.deepEqual(await values(),[{cents:0,count:0},{cents:0,count:0},{cents:0,count:0}]);pass('complete empty range is real zero');empty=false;
  missing=true;await gran('month').click();await host.locator('[data-wh-fin-state="missing"]').waitFor();assert.equal(await host.locator('[data-wh-fin-headline]').count(),0);pass('missing projection never falls back to legacy amounts');missing=false;
  await page.locator('[data-wh-admin-tab="finance"]').click();await verify('month','2026-10-01','2026-10-28');
  await page.reload();await page.locator('button.tab-btn[data-tab="admin"]').click();await page.locator('[data-wh-admin-tab="finance"]').click();await verify('month','2026-10-01','2026-10-28');pass('refresh defaults Month-to-date');
  assert.ok(requests.every(u=>!new URL(u).searchParams.has('creator_detail')),'No unused detail fetch on any path');assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);completed=true;
 }finally{
  fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify({completed,before,fixture:'synthetic, not live records',actualFonts:!!fonts,cases,requests,responses,unexpected,errors},null,2));await browser.close();
 }
}
browserProof().catch(e=>{console.error(e);process.exitCode=1;});
