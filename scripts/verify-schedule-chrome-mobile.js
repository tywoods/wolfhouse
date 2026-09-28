'use strict';
// Production portal HTML, synthetic GET-only fixtures, no server or forwarded network.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {chromium}=require('playwright');
const {loadClientPortalProfile}=require('./lib/staff-portal-clients');
const {resolveTenantBusinessConfig}=require('./lib/tenant-business-config');
const ROOT=path.resolve(__dirname,'..'),OUT=path.resolve(process.argv[2]||path.join(ROOT,'tmp/schedule-chrome-evidence/final'));
const SLICE=process.argv[3]||'all',ORIGIN='http://staff.test';
const ledger=[],errors=[],observations=[];
const calendar={success:true,days:Array.from({length:62},(_,i)=>({date:new Date(Date.UTC(2026,8,1+i)).toISOString().slice(0,10)})),rooms:Array.from({length:4},(_,r)=>({room_code:'R'+(r+1),room_name:'R'+(r+1),beds:Array.from({length:32},(_,b)=>({bed_code:`R${r+1}-B${b+1}`,bed_label:'Bed '+(b+1)}))})),blocks:[],warnings:[]};
for(let r=1;r<=4;r++)for(let b=1;b<=2;b++)calendar.blocks.push({booking_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',booking_code:'WH-SYNTHETIC-GROUP',guest_name:'Synthetic guest '+r+'-'+b,guest_count:8,status:'confirmed',check_in:'2026-09-03',check_out:'2026-09-08',room_code:'R'+r,bed_code:`R${r}-B${b}`,start_date:'2026-09-03',end_date:'2026-09-08',start_offset:2,span:5,source:'staff',calendar_group_size:8,calendar_guest_number:(r-1)*2+b,invoice_total_cents:80000,ledger_paid_cents:80000,balance_due_cents:0,calendar_payment_primary:'paid'});
const htmlCache=new Map();
function emit(tenant){
 if(htmlCache.has(tenant))return htmlCache.get(tenant);
 let html;
 if(process.env.SCHEDULE_HTML_DIR)html=fs.readFileSync(path.join(process.env.SCHEDULE_HTML_DIR,tenant+'.html'),'utf8');
 else {
  const code="process.env.NODE_ENV='test';process.env.STAFF_UI_BUILDER_TEST_SEAM='1';process.env.STAFF_AUTH_REQUIRED='false';process.env.STAFF_AUTH_ALLOW_OPEN='true';process.env.DEFAULT_CLIENT_SLUG=process.argv[1];process.stdout.write(require('./scripts/staff-query-api.js').buildUiHtmlForOfflineTest(0,process.argv[1]));";
  const r=spawnSync(process.execPath,['-e',code,tenant],{cwd:ROOT,encoding:'utf8',maxBuffer:20*1024*1024});
  assert.equal(r.status,0,r.stderr);html=r.stdout;
  fs.writeFileSync(path.join(OUT,tenant+'.html.gz'),require('node:zlib').gzipSync(html));
 }
 htmlCache.set(tenant,html);return html;
}
// Include delivery of native scroll events and the production RAF-coalesced geometry pass.
async function settle(page){await page.evaluate(()=>new Promise(resolve=>{let frames=4;function tick(){if(--frames===0)resolve();else requestAnimationFrame(tick);}requestAnimationFrame(tick);}));}
async function open(browser,width=390,theme='light',date='2026-09-28',tenant='wolfhouse-somo'){
 const html=emit(tenant),ctx=await browser.newContext({viewport:{width,height:1000},hasTouch:width<=768,serviceWorkers:'block',timezoneId:'UTC'});
 await ctx.routeWebSocket('**/*',ws=>{ledger.push({method:'WEBSOCKET',url:ws.url(),blocked:true});ws.close();});
 const fixtures={
 '/staff/schedule/day':{success:true,rows:[],rental_label_map:{}},
 '/staff/schedule/bookings/catalog':{success:true,ok:true,courses:[],offerings:[],rentals:[]},
 '/staff/auth/session':{success:true,auth_required:false,role:'admin',clients:[{slug:tenant,name:tenant}],client_profiles:{[tenant]:loadClientPortalProfile(tenant)}},
 '/staff/intents':{success:true,intents:[]},'/staff/inbox/luna-mode':{success:true,mode:'off'},'/staff/bot/global-pause-state':{success:true,paused:false},'/staff/whatsapp-numbers':{success:true,numbers:[]},'/staff/admin/house-notes':{success:true,notes:''},'/staff/automated-notifications':{success:true,notifications:[]},'/staff/packages':{success:true,packages:[]},'/staff/conversations':{success:true,conversations:[]},'/staff/admin/config':{success:true,...resolveTenantBusinessConfig(tenant,'sunset-somo')},'/staff/admin/config/rental-offerings':{success:true,offerings:[]},'/staff/clients':{success:true,clients:[{slug:tenant,name:tenant}]}
 };
 const assetDir=path.join(ROOT,'config/staff-portal');
 const assets=new Map(fs.readdirSync(assetDir).filter(f=>fs.statSync(path.join(assetDir,f)).isFile()).map(f=>['/staff/assets/'+f,path.join(assetDir,f)]));
 await ctx.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url()),entry={width,theme,date,tenant,method:req.method(),url:req.url()};ledger.push(entry);
  if(req.method()==='GET'&&req.url()==='https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=Instrument+Sans:wght@400;500;600;700&display=swap'){entry.optionalFontBlocked=true;return route.abort();}
  if(u.origin!==ORIGIN||req.method()!=='GET'){entry.blocked=true;return route.abort();}
  if(u.pathname==='/staff/ui')return route.fulfill({contentType:'text/html',body:html});
  if(assets.has(u.pathname))return route.fulfill({path:assets.get(u.pathname)});
  const data=u.pathname==='/staff/bed-calendar'?calendar:fixtures[u.pathname];
  if(!data){entry.unknown=true;return route.abort();}
  return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
 });
 await ctx.addInitScript(()=>localStorage.setItem('wh_staff_portal_locale','en'));
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(String(e)));
 await page.clock.setFixedTime(new Date(date+'T12:00:00Z'));
 await page.goto(ORIGIN+'/staff/ui');
 await page.waitForFunction(t=>typeof window.switchToTab==='function'&&document.getElementById('c-client').value===t,tenant);
 if(tenant==='sunset')await page.locator('#tab-portal-home').waitFor();
 else {await page.evaluate(()=>window.switchToTab('bed-calendar'));await page.locator('.bc-room-hdr').first().waitFor();}
 await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),theme);await settle(page);
 return {ctx,page};
}
async function pills(page,key='sep-oct'){
 const m=await page.evaluate(key=>{const wrap=document.getElementById('bc-chips'),r=wrap.getBoundingClientRect(),chips=[...wrap.querySelectorAll('.bc-chip')].map(e=>{const b=e.getBoundingClientRect();return {key:e.dataset.chip,x:b.x,y:b.y,width:b.width,height:b.height};});return {width:r.width,x:r.x,scrollLeft:wrap.scrollLeft,scrollWidth:wrap.scrollWidth,clientWidth:wrap.clientWidth,overflow:getComputedStyle(wrap).overflowX,chips,active:wrap.querySelector('.bc-chip-active')?.dataset.chip,range:[document.getElementById('bc-start').value,document.getElementById('bc-end').value],target:chips.find(c=>c.key===key)};},key);
 observations.push({name:'initial-pills',key,...m});
 assert.equal(m.chips.length,9,'all existing date pills retained');
 assert(m.chips.every(c=>Math.abs(c.y-m.chips[0].y)<1),'all date pills must occupy ONE horizontal line');
 const mobile=await page.evaluate(()=>innerWidth<=768);
 assert.equal(m.overflow,'auto','pill row scrolls inside its lane and does not cover date or refresh');
 if(mobile)assert(Math.abs(m.target.x+m.target.width/2-(m.x+m.width/2))<2,'current-month relevant pill must genuinely center');
 assert.equal(m.active,'30days','centering must NOT select seasonal range');
 return m;
}
async function sticky(page,label='sticky'){
 // Geometry scrolling is not a booking-hover test; park the real pointer off the grid.
 await page.mouse.move(0,0);
 await page.locator('#bc-grid-wrap').evaluate(w=>{w.scrollTop=0;w.scrollLeft=0;});await settle(page);
 const initial=await page.evaluate(()=>{const w=document.getElementById('bc-grid-wrap'),r=w.getBoundingClientRect();return {mobile:innerWidth<=768,left:r.left,top:r.top,height:w.clientHeight,scrollHeight:w.scrollHeight,width:w.clientWidth,scrollWidth:w.scrollWidth,headLeft:w.querySelector('.bc-bed-head').getBoundingClientRect().left,bedLeft:w.querySelector('.bc-bed-cell').getBoundingClientRect().left,rooms:[...w.querySelectorAll('.bc-room-hdr-row')].map(e=>({room:e.dataset.room,top:e.getBoundingClientRect().top-r.top-1}))};});
 assert(initial.scrollHeight>initial.height+400,'fixture must overflow vertically');
 if(initial.mobile)assert(initial.scrollWidth>initial.width+400,'mobile fixture must overflow horizontally');
 else assert.equal(await page.locator('#bc-grid-wrap').evaluate(e=>getComputedStyle(e).overflowX),'hidden','desktop grid hides the horizontal scroll lane');
 await page.locator('#bc-grid-wrap').evaluate(w=>{w.scrollLeft=440;});await settle(page);
 const locked=await page.evaluate(()=>{const w=document.getElementById('bc-grid-wrap');return {head:w.querySelector('.bc-bed-head').getBoundingClientRect().left,bed:w.querySelector('.bc-bed-cell').getBoundingClientRect().left};});
 if(initial.mobile){assert(Math.abs(locked.head-initial.headLeft)<1,'existing Room/Bed head locks horizontally');assert(Math.abs(locked.bed-initial.bedLeft)<1,'existing bed labels lock horizontally');}
 for(const room of initial.rooms){
  await page.locator('#bc-grid-wrap').evaluate((w,top)=>{w.scrollTop=top+80;},room.top);await settle(page);
  const m=await page.evaluate(code=>{const w=document.getElementById('bc-grid-wrap'),wr=w.getBoundingClientRect(),head=w.querySelector('.bc-bed-head').getBoundingClientRect(),row=w.querySelector('.bc-room-hdr-row[data-room="'+code+'"]'),inner=row.querySelector('.bc-room-hdr-inner'),r=inner.getBoundingClientRect(),hit=document.elementFromPoint(wr.left+25,head.bottom+12);return {room:code,scrollTop:w.scrollTop,scrollLeft:w.scrollLeft,wrap:{left:wr.left,right:wr.right,top:wr.top,bottom:wr.bottom},headBottom:head.bottom,label:{x:r.x,y:r.y,width:r.width,height:r.height,text:inner.textContent},hitRoom:hit?.closest('.bc-room-hdr-row')?.dataset.room||null,hitText:hit?.textContent,headers:[...w.querySelectorAll('.bc-room-hdr-row')].map(e=>({room:e.dataset.room,bottom:e.getBoundingClientRect().bottom}))};},room.room);
  observations.push({name:label,...m});
  assert(m.headers.slice(0,initial.rooms.indexOf(room)).every(h=>h.bottom<=m.headBottom+1),'previous room headers leave sticky slot at their section boundary');
  assert.equal(m.hitRoom,room.room,'active room header must take over below day header after combined scroll');
  assert(m.label.x>=m.wrap.left&&m.label.x+m.label.width<=m.wrap.right,'active room text must remain inside horizontal viewport');
  await page.screenshot({path:path.join(OUT,'local-synthetic-'+label+'-'+room.room+'.png')});
 }
}
async function refresh(page){
 const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/staff/bed-calendar');
 await page.locator('#bc-load').click();await response;await page.waitForFunction(()=>!document.getElementById('bc-load').disabled);await settle(page);
}
async function refreshProbe(page){
 await page.locator('#bc-grid-wrap').evaluate(w=>{w.scrollTop=220;w.scrollLeft=440;});await settle(page);
 await page.evaluate(()=>{
  const w=document.getElementById('bc-grid-wrap');window.refreshTrace=[];
  const snapshot=stage=>window.refreshTrace.push({stage,x:w.scrollLeft,y:w.scrollTop,height:w.clientHeight,scrollHeight:w.scrollHeight,shell:getComputedStyle(document.getElementById('bc-grid-shell')).display});
  snapshot('before');
  const d=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop');
  Object.defineProperty(w,'scrollTop',{configurable:true,get(){return d.get.call(this);},set(v){snapshot('setter-before '+v+' '+new Error().stack);d.set.call(this,v);snapshot('setter-after');}});
  new MutationObserver(()=>snapshot('mutation')).observe(w.parentNode,{subtree:true,childList:true,attributes:true,attributeFilter:['style']});
  w.addEventListener('scroll',()=>snapshot('scroll'));
 });
 await refresh(page);await page.waitForTimeout(250);await settle(page);
 const trace=await page.evaluate(()=>window.refreshTrace);observations.push({name:'refresh-lifecycle-diagnostic',trace});
 console.log(JSON.stringify(trace,null,2));
}
async function interactions(page,width,label){
 const chips=page.locator('#bc-chips'),grid=page.locator('#bc-grid-wrap');
 for(const selector of ['#bc-zoom-bar','#bc-legend'])assert.equal(await page.locator(selector).isVisible(),false,selector+' is removed');
 assert.equal(await page.locator('#bc-range-btn').isVisible(),width>768,'desktop keeps custom date picker');
 const fit=await page.locator('#bc-load').evaluate(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),overflow:document.documentElement.scrollWidth>innerWidth};});
 assert(fit.left>=0&&fit.right<=width&&fit.hit&&!fit.overflow,'Refresh reachable and no page horizontal overflow');
 await chips.evaluate(e=>{e.scrollLeft=123;});
 await grid.evaluate(e=>{e.scrollTop=220;e.scrollLeft=440;});await settle(page);
 const before=await grid.evaluate(e=>({x:e.scrollLeft,y:e.scrollTop}));
 await refresh(page);
 const after=await grid.evaluate(e=>({x:e.scrollLeft,y:e.scrollTop}));
 observations.push({name:'refresh-history',label,before,after,chipLeft:await chips.evaluate(e=>e.scrollLeft)});
 assert.equal(await chips.evaluate(e=>e.scrollLeft),123,'Refresh must not recenter pill history');
 // Untouched-base diagnostic proves deferred height measurement resets vertical history.
 // This is an inherited limitation, NOT passing preservation coverage or a chrome requirement.
 observations.push({name:'known-baseline-limitation',label,issue:'Refresh resets vertical grid history',before,after});
 await page.locator('[data-chip="oct-nov"]').scrollIntoViewIfNeeded();
 const request=page.waitForRequest(r=>new URL(r.url()).pathname==='/staff/bed-calendar');
 await page.locator('[data-chip="oct-nov"]').click();const req=await request;await settle(page);
 const url=new URL(req.url());assert.equal(url.searchParams.get('start'),'2026-10-01');assert.equal(url.searchParams.get('end'),'2026-11-30');
 assert.equal(await page.locator('.bc-chip-active').getAttribute('data-chip'),'oct-nov');
 await grid.evaluate(e=>{e.scrollTop=0;e.scrollLeft=440;});await settle(page);
 const hide=page.locator('.bc-room-hide-btn[data-room="R1"]');await hide.click();
 assert.equal(await page.locator('.bc-room-bed-row[data-room="R1"]:visible').count(),0,'real Hide collapses room');
 await refresh(page);assert.equal(await page.locator('.bc-room-bed-row[data-room="R1"]:visible').count(),0,'Refresh retains room collapse');
 await grid.evaluate(e=>{e.scrollTop=0;});await hide.click();assert.equal(await page.locator('.bc-room-bed-row[data-room="R1"]:visible').count(),32,'real Show expands room');
 assert.equal(await page.locator('.bc-block').count(),8,'group bed blocks preserved');
 assert.equal(await page.locator('.bc-group-parent-row').count(),0,'above-room group banner removed');
 assert(await page.locator('.bc-block .bc-group-chip').count()>=1,'Group pebble stays inside split booking bars');
 if(width>768){
  assert.equal(await page.locator('#bc-zoom-bar').isVisible(),false,'desktop zoom controls are removed');
  assert.equal(await page.locator('#bc-legend').isVisible(),false,'desktop legend is removed');
  assert.equal(await grid.evaluate(e=>getComputedStyle(e).overflowX),'hidden','desktop grid has no horizontal scroll lane');
  assert.equal(await page.locator('.bc-chips').evaluate(e=>getComputedStyle(e).overflowX),'auto','desktop month shortcuts scroll inside the toolbar and do not cover date or refresh');
  await page.locator('#bc-range-btn').click();assert(await page.locator('#bc-range-pop').isVisible(),'desktop picker opens');
  await page.locator('[data-bc-range-day="2026-10-05"]').click();
  const requested=page.waitForRequest(r=>new URL(r.url()).pathname==='/staff/bed-calendar');
  await page.locator('[data-bc-range-day="2026-10-12"]').click();const custom=new URL((await requested).url());
  assert.equal(custom.searchParams.get('start'),'2026-10-05');assert.equal(custom.searchParams.get('end'),'2026-10-12');
  await page.waitForFunction(()=>!document.getElementById('bc-load').disabled);await settle(page);
 }
 await sticky(page,label+'-after-controls');
 observations.push({name:'controls-complete',label,width});
}
async function nativePan(page){
 const grid=page.locator('#bc-grid-wrap');await grid.evaluate(w=>{w.scrollLeft=100;w.scrollTop=250;});await settle(page);
 const b=await grid.boundingBox(),x=b.x+b.width-40,y=b.y+260;
 const hit=await page.evaluate(({x,y})=>({inside:!!document.elementFromPoint(x,y)?.closest('#bc-grid-wrap'),tag:document.elementFromPoint(x,y)?.tagName}),{x,y});assert(hit.inside,'touch origin inside real grid');
 const before=await page.evaluate(()=>({x:document.getElementById('bc-grid-wrap').scrollLeft,y:document.getElementById('bc-grid-wrap').scrollTop,body:document.scrollingElement.scrollTop}));
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
 for(let i=1;i<=12;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-i*6,y:y-i*12}]});await page.waitForTimeout(20);}
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await page.waitForTimeout(350);await settle(page);
 const after=await page.evaluate(()=>({x:document.getElementById('bc-grid-wrap').scrollLeft,y:document.getElementById('bc-grid-wrap').scrollTop,body:document.scrollingElement.scrollTop}));
 observations.push({name:'native-chromium-touch-pan',hit,before,after});
 assert(after.y>before.y+40,'native touch pan actually scrolls calendar');assert.equal(after.body,before.body,'calendar pan does not scroll document');await cdp.detach();
}
async function matrix(browser){
 for(const width of [320,390,768,769,1440])for(const theme of ['light','dark']){
  const {ctx,page}=await open(browser,width,theme);const label=width+'-'+theme;
  await pills(page);await page.screenshot({path:path.join(OUT,'local-synthetic-initial-'+label+'.png')});
  await sticky(page,label);await interactions(page,width,label);
  if(width===390&&theme==='light')await nativePan(page);
  if(width===1440&&theme==='light'){
   await page.setViewportSize({width:1100,height:850});await settle(page);await sticky(page,'resized-desktop');
   const b=await page.locator('#bc-grid-wrap').boundingBox();await page.locator('#bc-grid-wrap').evaluate(e=>{e.scrollTop=200;});await page.mouse.move(b.x+300,b.y+180);await page.mouse.wheel(170,150);await page.waitForTimeout(200);
   assert(await page.locator('#bc-grid-wrap').evaluate(e=>e.scrollTop)>200,'desktop wheel scrolls real calendar');
  }
  await ctx.close();
 }
 assert.equal(observations.filter(o=>o.name==='controls-complete').length,10,'all ten fresh viewport/theme cases completed');
 for(const [date,key] of [['2026-04-01','apr-may'],['2026-08-31','aug-sept'],['2026-10-01','oct-nov'],['2026-11-30','oct-nov'],['2026-12-31','30days'],['2027-01-01','30days']]){
  const {ctx,page}=await open(browser,390,'light',date);const m=await pills(page,key);assert.equal(m.range[0],date,'initial selected range still starts today');observations.push({name:'boundary-date',date,key});await ctx.close();
 }
 assert.equal(observations.filter(o=>o.name==='boundary-date').length,6);
 for(const width of [390,1440])for(const theme of ['light','dark']){
  const {ctx,page}=await open(browser,width,theme,'2026-09-28','sunset');
  assert(await page.locator('#tab-portal-home').isVisible(),'native Sunset surf Schedule visible');
  assert.equal(await page.locator('#tab-bed-calendar').isVisible(),false,'Sunset bed-calendar stays hidden');
  assert(ledger.some(e=>e.tenant==='sunset'&&new URL(e.url).pathname==='/staff/schedule/day'),'native surf schedule requested');
  await page.screenshot({path:path.join(OUT,'local-synthetic-sunset-'+width+'-'+theme+'.png')});
  observations.push({name:'sunset-native',width,theme});await ctx.close();
 }
 assert.equal(observations.filter(o=>o.name==='sunset-native').length,4);
}
async function main(){
 fs.mkdirSync(OUT,{recursive:true});const browser=await chromium.launch({headless:true});let failure;
 try{
  const {ctx,page}=await open(browser);
  await page.screenshot({path:path.join(OUT,'local-synthetic-initial.png')});
  if(SLICE==='refresh-diagnostic'){await refreshProbe(page);await ctx.close();assert.deepEqual(errors,[]);assert.deepEqual(ledger.filter(e=>e.blocked||e.unknown),[]);return;}
  await pills(page);
  if(SLICE!=='pills'){
   assert.equal(await page.locator('#bc-zoom-bar').isVisible(),false,'mobile zoom controls must be hidden');
   assert.equal(await page.locator('#bc-legend').isVisible(),false,'mobile legend must be hidden');
   assert(await page.locator('#bc-load').isVisible(),'Refresh remains visible');
   const refreshBox=await page.locator('#bc-load').boundingBox();const titleBox=await page.locator('#bc-calendar-title').boundingBox();
   assert(refreshBox.x>titleBox.x+titleBox.width/2&&refreshBox.y<=titleBox.y+4,'mobile Refresh is top-right beside the title');
   assert((await page.locator('#bc-load svg').boundingBox()).width>=25,'mobile Refresh arrows are enlarged');
   assert.equal(await page.locator('#bc-grid-wrap').evaluate(e=>getComputedStyle(e).overflowX),'auto','mobile grid keeps horizontal scroll');
  }
  if(['picker','sticky','all'].includes(SLICE))assert.equal(await page.locator('#bc-range-btn').isVisible(),false,'mobile custom range opener must be hidden');
  if(['sticky','all'].includes(SLICE))await sticky(page);
  await ctx.close();
  if(SLICE==='all')await matrix(browser);
 }catch(e){failure=e;console.error(e.stack);}
 finally{await browser.close();fs.writeFileSync(path.join(OUT,'observations.json'),JSON.stringify({slice:SLICE,observations,ledger,errors,failure:failure?.message||null},null,2));}
 if(failure)throw failure;
 assert.deepEqual(errors,[],'no page errors');assert.deepEqual(ledger.filter(e=>e.blocked||e.unknown),[],'no unexpected network or mutations');
 console.log('PASS schedule chrome '+SLICE+'; '+observations.length+' observations; '+ledger.length+' intercepted requests; no pageerrors/unexpected network/mutations');
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
