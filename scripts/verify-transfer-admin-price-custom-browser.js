'use strict';
// Full production HTML + registered calendar/Transfer events, synthetic HTTP only.
// Transfer responses use real production SQL in PGlite. Context/auth scaffolding is synthetic.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {chromium}=require('playwright');
const {loadClientPortalProfile}=require('./lib/staff-portal-clients');
const {resolveTenantBusinessConfig}=require('./lib/tenant-business-config');
const {createHarness,ADMIN_CENT_CASES}=require('./verify-transfer-admin-price-custom');
const {loadStaffTransferConfig}=require('./lib/staff-transfer-pricing');
const ROOT=path.resolve(__dirname,'..');
const OUT=path.resolve(process.env.TRANSFER_BROWSER_OUT || process.argv[2] || '/opt/data/workspace/sandbox-repos/WH-captain/artifacts/transfer-admin-price-custom-001/ui/drawer');
const ORIGIN='http://staff.test',CODE='WH-CHROME-TEST';
// Same ordinary calendar/context fixture shape as verify-invoice-paid-history.js.
const booking={booking_id:'00000000-0000-4000-8000-000000000001',booking_code:CODE,guest_name:'Tom (test)',guest_count:2,total_amount_cents:60000,accommodation_total_cents:60000,deposit_required_cents:18000,amount_paid_cents:0,balance_due_cents:60000,status:'confirmed',check_in:'2026-09-24',check_out:'2026-09-29',nights:5};
const calendar={success:true,days:Array.from({length:14},(_,i)=>({date:new Date(Date.UTC(2026,8,24+i)).toISOString().slice(0,10)})),rooms:[{room_code:'R1',room_name:'Room 1',beds:[{bed_code:'R1-B1',bed_label:'Bed 1'}]}],blocks:[{...booking,room_code:'R1',bed_code:'R1-B1',start_date:booking.check_in,end_date:booking.check_out,source:'staff',start_offset:0,span:5}],warnings:[]};

async function main(){
 fs.mkdirSync(OUT,{recursive:true});
 const htmlPath=path.join(OUT,'wolfhouse-somo.html');
 const emit=spawnSync(process.execPath,['scripts/verify-inbox-ui-parity.js','--emit','wolfhouse-somo',htmlPath],{cwd:ROOT,encoding:'utf8',env:{...process.env,STAFF_ACTIONS_ENABLED:'true'}});
 assert.equal(emit.status,0,emit.stderr||emit.stdout);
 const html=fs.readFileSync(htmlPath,'utf8');
 const results=[];let failure,browser;
 try{for(const size of ['desktop','mobile'])for(const theme of ['light','dark']){
  const locale=theme==='dark'?'es':'en',name=`${size}-${theme}-${locale}`;
  // Each complete viewport/theme case owns a browser process. Keep repeated
  // mobile full-page reopens from accumulating across the four-case matrix.
  browser=await chromium.launch({headless:true});
  const ctx=await browser.newContext({viewport:size==='desktop'?{width:1440,height:1000}:{width:390,height:844},serviceWorkers:'block'});
  const ledger=[],errors=[],consoleErrors=[],observations=[],responses=[];
  let expectedSave={airport:'BIO',override:true,price:0},packageCode=null,guestCount=2;
  const h=await createHarness();
  await h.db.query('UPDATE bookings SET booking_code=$2,guest_count=2,check_in=$3,check_out=$4 WHERE id=$1',[booking.booking_id,CODE,booking.check_in,booking.check_out]);
  await h.db.query("INSERT INTO wh_pricing_transfer_rules (client_slug,airport_code,label,requires_package,min_guest_count) VALUES ('wolfhouse-somo','MAD','Madrid',false,NULL),('wolfhouse-somo','BIO','Bilbao',false,NULL)");
  await h.fare('SDR',4200,'flat');await h.fare('BIO',12300,'flat');
  const payload=async()=>{const r=await h.dispatch('GET');assert.equal(r.status,200);responses.push({seam:'GET',body:r.body});return r.body;};
  const detail=async()=>{
   const rows=await h.saved(),config=await loadStaffTransferConfig(h.pg,'wolfhouse-somo');
   const currentBooking={...booking,guest_count:guestCount,package_code:packageCode};
   const embedded=h.routes.buildTransfersDrawerPayload('wolfhouse-somo',currentBooking,rows,{resolvedConfig:config});
   responses.push({seam:'embedded-builder',body:embedded});
   return {success:true,booking:currentBooking,rooming:{assignments:[]},booking_guests:[],per_person:[],guest_accommodation_lines:[],service_records:[],transfers:rows,transfers_drawer:size==='desktop'?embedded:null,payments:{paid_total_cents:0,rows:[]},pending_manual_services:[],conversation:null};
  };
  async function snapshots(price,currency,note,included=false){
   for(const direction of ['arrival','departure']){
    assert.equal((await h.dispatch('POST',{direction})).status,200);
    await h.db.query('UPDATE booking_transfers SET price_cents=$2,currency=$3,pricing_note=$4,included_in_package=$5 WHERE booking_id=$1 AND direction=$6',[booking.booking_id,price,currency,note,included,direction]);
   }
  }
  await snapshots(1900,'EUR','Historical saved charge');
  await ctx.route('**/*',async route=>{
   try {
   const req=route.request(),url=new URL(req.url()),p=url.pathname,e={method:req.method(),url:req.url()};ledger.push(e);
   if(url.origin!==ORIGIN){e.font=/^https:\/\/fonts\.(googleapis|gstatic)\.com/.test(req.url());e.blocked=true;return route.abort();}
   let data;
   if(req.method()==='POST'&&p===`/staff/bookings/${booking.booking_id}/transfers`){
    e.body=req.postDataJSON();e.syntheticWrite=true;
    const b=e.body;assert.equal(b.client_slug,'wolfhouse-somo');assert(['arrival','departure'].includes(b.direction));assert.equal(b.manual_override_enabled,expectedSave.override?true:undefined);if(expectedSave.override)assert.equal(b.manual_override_euros,0);else assert.equal(b.manual_override_euros,undefined);assert.equal(b.airport_code,expectedSave.airport);assert.equal(b.source,'staff');
    const result=await h.dispatch('POST',b);assert.equal(result.status,200);data=result.body;
    assert.equal(data.pricing.price_cents,expectedSave.price,'top-level POST saved charge');
    assert.deepEqual(data.pricing,data.transfer.pricing);
    assert.equal((await h.saved()).find(r=>r.direction===b.direction).price_cents,expectedSave.price,'independent POST SQL readback');
    if(expectedSave.currency){
     const row=(await h.saved()).find(r=>r.direction===b.direction);
     for(const quote of [data.pricing,row]){assert.equal(quote.currency,expectedSave.currency);assert.equal(quote.pricing_note,expectedSave.note);}
    }
    responses.push({seam:'POST',body:data,readback:await h.saved()});
   }else if(req.method()==='DELETE'&&new RegExp(`^/staff/bookings/${booking.booking_id}/transfers/(arrival|departure)$`).test(p)){
    e.syntheticWrite=true;assert.equal(url.searchParams.get('client_slug'),'wolfhouse-somo');assert.equal(req.postData(),null);
    const res={status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await h.routes.handleDeleteBookingTransfer(booking.booking_id,p.split('/').pop(),{client_slug:'wolfhouse-somo'},res);assert.equal(res.code,200);data=res.body;
   }else if(req.method()!=='GET'){e.unexpected=true;return route.abort();}
   else if(p==='/staff/ui')return route.fulfill({contentType:'text/html',body:html});
   else if(p==='/staff/bed-calendar')data=calendar;
   else if(p===`/staff/bookings/${CODE}/context`)data=await detail();
   else if(p===`/staff/bookings/${booking.booking_id}/transfers`)data=await payload();
   else if(p===`/staff/bookings/${booking.booking_id}/services`)data={success:true,paid_requested_services:[],unscheduled_services:[],services_by_date:[]};
   else if(p==='/staff/auth/session')data={success:true,auth_required:false,role:'admin',clients:[{slug:'wolfhouse-somo',name:'Wolfhouse'}],client_profiles:{'wolfhouse-somo':loadClientPortalProfile('wolfhouse-somo')}};
   else if(p.startsWith('/staff/assets/')){const f=path.join(ROOT,'config/staff-portal',path.basename(p));if(fs.existsSync(f))return route.fulfill({path:f});e.unexpected=true;return route.abort();}
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
   else if(p==='/staff/clients')data={success:true,clients:[{slug:'wolfhouse-somo',name:'Wolfhouse'}]};
   else{e.unexpected=true;return route.abort();}
   return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
   } catch(error) { errors.push('route: '+error.stack);return route.fulfill({status:500,json:{success:false,error:error.message}}); }
  });
  await ctx.addInitScript(({locale,theme})=>{localStorage.setItem('wh_staff_portal_locale',locale);localStorage.setItem('wh_staff_portal_theme',theme);},{locale,theme});
  const page=await ctx.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});page.on('dialog',d=>d.accept());
  try{
   await page.goto(ORIGIN+'/staff/ui');await page.waitForFunction(()=>typeof window.switchToTab==='function'&&document.getElementById('c-client').value==='wolfhouse-somo');
   await page.evaluate(theme=>{document.documentElement.setAttribute('data-theme',theme);window.switchToTab('bed-calendar');},theme);
   async function open(){await page.locator('.bc-block').first().click();await page.mouse.move(10,10);await page.locator('.bc-drawer-tab[data-tab="transfers"]').click();await page.locator('#bc-transfer-arrival-airport').waitFor();}
   async function reopen(){
    if(size==='desktop')await page.locator('#bc-side-close').click();
    else{ // Mobile uses an inline detail card, not the desktop close button.
     await page.reload();await page.waitForFunction(()=>typeof window.switchToTab==='function'&&document.getElementById('c-client').value==='wolfhouse-somo');
     await page.evaluate(()=>window.switchToTab('bed-calendar'));
    }
    await open();
   }
   await open();
   // Full production ADMIN validator/store → GET/embedded → ordinary controls →
   // real Staff POST + independent SQL, using literal three-guest expectations.
   guestCount=3;
   await h.db.query('UPDATE bookings SET guest_count=3 WHERE id=$1',[booking.booking_id]);
   for(const c of ADMIN_CENT_CASES){
    const adminRow=await h.adminFare('SDR',c.amount,c.unit,c.currency);
    await h.db.query('DELETE FROM booking_transfers WHERE booking_id=$1',[booking.booking_id]);
    expectedSave={airport:'SDR',override:false,price:c.total,currency:c.currency,note:c.note};
    await reopen();
    for(const direction of ['arrival','departure']){
     const prefix='#bc-transfer-'+direction;
     const ref=await page.locator(prefix+'-admin-price .bc-transfer-pricing').allTextContents();
     const unit=locale==='en'?(c.unit==='flat'?'Per group':'Per person'):(c.unit==='flat'?'Por grupo':'Por persona');
     observations.push({direction,state:'exact-cents-reference',case:c,adminRow,reference:ref});
     assert.deepEqual(ref,[c.rate+' · '+unit,c.note],'reference must show exact unit/total cents and configured currency, with no contradictory copy');
     await page.locator(`.bc-transfer-save[data-direction="${direction}"]`).click();
     await page.locator(`.bc-transfer-remove[data-direction="${direction}"]`).waitFor();
     const text=await page.locator(prefix+'-pricing').innerText();
     assert(text.includes(c.note),'immediate POST saved display uses exact note');
     assert(!text.includes('€20')&&!text.includes('€59'),'no rounded new saved charge');
     await reopen();assert.equal(await page.locator(prefix+'-pricing').innerText(),text,'exact saved cents/currency survive ordinary reopen');
    }
    const before=await h.saved(),referenceCurrency=c.currency==='EUR'?'GBP':'EUR';
    await h.adminFare('SDR',4200,'flat',referenceCurrency);await reopen();
    for(const direction of ['arrival','departure']){
     const prefix='#bc-transfer-'+direction;
     assert((await page.locator(prefix+'-admin-price').innerText()).includes(referenceCurrency==='EUR'?'€42.00':'GBP 42.00'));
     const savedText=await page.locator(prefix+'-pricing').innerText();
     assert(savedText.includes(c.note),'changed ADMIN currency must not rewrite historical saved note');
     observations.push({direction,state:'exact-cents-historical',case:c,referenceCurrency,savedText});
    }
    assert.deepEqual(await h.saved(),before,'UI reference reads preserve historical SQL snapshot');
   }
   await h.adminFare('SDR',1950,'per_person','GBP');
   await h.db.query('DELETE FROM booking_transfers WHERE booking_id=$1',[booking.booking_id]);
   expectedSave={airport:'SDR',override:true,price:0,currency:'EUR',note:'Manual transfer override'};await reopen();
   for(const direction of ['arrival','departure']){
    const prefix='#bc-transfer-'+direction;
    await page.locator(`.bc-transfer-override-toggle[data-direction="${direction}"]`).click();
    await page.locator(prefix+'-override-amount').fill('0');
    await page.locator(`.bc-transfer-save[data-direction="${direction}"]`).click();
    await page.locator(`.bc-transfer-remove[data-direction="${direction}"]`).waitFor();
    await reopen();
    assert.match(await page.locator(prefix+'-pricing').innerText(),/€0.00/,'legacy explicit-euros custom override remains independent');
    assert.match(await page.locator(prefix+'-admin-price').innerText(),/GBP 58.50/,'custom zero does not replace GBP current quote');
    observations.push({direction,state:'GBP-reference-custom-zero',savedText:await page.locator(prefix+'-pricing').innerText(),reference:await page.locator(prefix+'-admin-price').innerText()});
   }
   // Restore the existing two-guest preservation matrix without weakening it.
   guestCount=2;expectedSave={airport:'BIO',override:true,price:0};
   await h.db.query('UPDATE bookings SET guest_count=2 WHERE id=$1',[booking.booking_id]);
   await h.fare('SDR',4200,'flat');await snapshots(1900,'EUR','Historical saved charge');await reopen();
   for(const direction of ['arrival','departure']){
    const savedText=await page.locator('#bc-transfer-'+direction+'-pricing').innerText();
    observations.push({direction,state:'historical',savedText});
    assert.match(await page.locator('#bc-transfer-'+direction+'-admin-price').innerText(),/42.00/);
    assert.match(savedText,/19.00/,'saved historical charge must not be replaced by current ADMIN €42');
    assert.match(savedText,/Historical saved charge/);
   }
   await h.db.query('DELETE FROM booking_transfers WHERE booking_id=$1',[booking.booking_id]);
   await h.fare('SDR',3700,'per_person');await reopen();
   for(const direction of ['arrival','departure']){
    const prefix='#bc-transfer-'+direction,toggle=page.locator(`.bc-transfer-override-toggle[data-direction="${direction}"]`),ref=page.locator(prefix+'-admin-price');
    assert.equal(await toggle.innerText(),locale==='en'?'Custom Price':'Precio personalizado','Transfer custom-price label');
    assert.equal(await ref.count(),1,'selected airport has a server-price reference above Custom Price');
    for(const airport of ['SDR','BIO','SDR','MAD','BIO']){
     await page.locator(prefix+'-airport').selectOption(airport);
     const text=await ref.innerText();observations.push({direction,airport,text});
     if(airport==='MAD'){assert.match(text,/not configured/i);assert(!text.includes('€0.00'),'absent price is not zero');}
     else {assert(text.includes(airport==='SDR'?'37.00':'123.00'),'configured unit rate');assert(text.includes(locale==='en'?(airport==='SDR'?'Per person':'Per group'):(airport==='SDR'?'Por persona':'Por grupo')),'localized unit');if(airport==='SDR')assert.match(text,/€74(?:\.00)? extra/,'production server-resolved total, not unit rate');}
    }
    const above=await ref.evaluate(e=>e.getBoundingClientRect().bottom);assert(above<=await toggle.evaluate(e=>e.getBoundingClientRect().top),'Price above Custom Price');
    await toggle.click();await page.locator(prefix+'-override-amount').fill('0');
    await page.locator(`.bc-transfer-save[data-direction="${direction}"]`).click();await page.locator(`.bc-transfer-remove[data-direction="${direction}"]`).waitFor();
    assert.match(await page.locator(prefix+'-pricing').innerText(),/0.00/,'POST completion displays persisted custom zero');
    assert.match(await page.locator(prefix+'-pricing').innerText(),/Manual transfer override/);
    await reopen();
    assert.equal(await page.locator(prefix+'-override-amount').inputValue(),'0','custom zero survives synthetic reopen');assert.equal(await toggle.getAttribute('aria-expanded'),'true');assert.match(await ref.innerText(),/123.00/,'reference remains separate from zero');
    await page.locator(prefix+'-airport').selectOption('SDR');assert.equal(await page.locator(prefix+'-override-amount').inputValue(),'0','airport reference change preserves saved custom zero');
    assert.match(await page.locator(prefix+'-pricing').innerText(),/0.00/,'saved custom charge distinct from airport reference');
    await page.locator('#bc-transfer-card-'+direction).scrollIntoViewIfNeeded();
    const box=await page.locator('#bc-transfer-card-'+direction).boundingBox();assert(box&&box.y>=-1&&box.y+box.height<=(size==='desktop'?1000:844)+1,'focused card visible in viewport');
    const visibility=await ref.evaluate(e=>{
     const r=e.getBoundingClientRect();let clip={left:0,top:0,right:innerWidth,bottom:innerHeight};
     for(let n=e.parentElement;n;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='contents')continue;const b=n.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(s.overflowY)){clip.top=Math.max(clip.top,b.top);clip.bottom=Math.min(clip.bottom,b.bottom);}if(/auto|scroll|hidden|clip/.test(s.overflowX)){clip.left=Math.max(clip.left,b.left);clip.right=Math.min(clip.right,b.right);}}
     return {theme:document.documentElement.getAttribute('data-theme'),visible:r.top>=clip.top-1&&r.bottom<=clip.bottom+1&&r.left>=clip.left-1&&r.right<=clip.right+1,rect:{x:r.x,y:r.y,width:r.width,height:r.height},clip};
    });assert.equal(visibility.visible,true,'reference price inside all clipping ancestors');assert.equal(visibility.theme,theme);observations.push({direction,screenshotVisibility:visibility});
    await page.screenshot({path:path.join(OUT,`${name}-${direction}.png`)});
    await page.locator(`.bc-transfer-remove[data-direction="${direction}"]`).click();
    await page.locator(`.bc-transfer-remove[data-direction="${direction}"]`).waitFor({state:'detached'});
    assert.equal(await page.locator(prefix+'-airport').inputValue(),'SDR');
    assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert.equal(await page.locator(prefix+'-override-amount').inputValue(),'');assert.match(await ref.innerText(),/37.00/,'clear refreshes reference price');
    await reopen();assert.equal(await page.locator(`.bc-transfer-remove[data-direction="${direction}"]`).count(),0,'removed on reopen');
   }
   await h.fare('SDR',4200,'flat');
   for(const state of [{name:'historical-currency',price:1900,currency:'GBP',note:'Historical saved charge'}, {name:'unknown',price:null,currency:'EUR',note:'Historical amount unknown'}, {name:'included',price:0,currency:'EUR',note:'Historical package inclusion',included:true}]){
    await snapshots(state.price,state.currency,state.note,state.included);await reopen();
    for(const direction of ['arrival','departure']){
     const prefix='#bc-transfer-'+direction, text=await page.locator(prefix+'-pricing').innerText();
     observations.push({direction,state:state.name,savedText:text});
     assert.match(await page.locator(prefix+'-admin-price').innerText(),/42.00/);
     assert.equal(await page.locator(`.bc-transfer-override-toggle[data-direction="${direction}"]`).getAttribute('aria-expanded'),'false');
     if(state.name==='historical-currency'){assert.match(text,/GBP.*19.00/);assert.match(text,/Historical saved charge/);}
     if(state.name==='unknown'){assert.match(text,/Historical amount unknown/);assert(!/0.00|42.00/.test(text),'unknown is neither zero nor current quote');}
     if(state.included)assert.match(text,locale==='en'?/included in package/i:/incluido en el paquete/i);
     await page.locator(prefix+'-airport').selectOption('BIO');
     assert.match(await page.locator(prefix+'-admin-price').innerText(),/123.00/);
     assert.equal(await page.locator(prefix+'-pricing').innerText(),text,'reference selection never rewrites saved display');
    }
   }
   for(const state of [{name:'POST-unknown',airport:'MAD',price:null,packageCode:null},{name:'POST-included',airport:'SDR',price:0,packageCode:'malibu'}]){
    packageCode=state.packageCode;expectedSave={airport:state.airport,price:state.price,override:false};
    await h.db.query('UPDATE bookings SET package_code=$2 WHERE id=$1',[booking.booking_id,packageCode]);
    await h.db.query('DELETE FROM booking_transfers WHERE booking_id=$1',[booking.booking_id]);await reopen();
    for(const direction of ['arrival','departure']){
     const prefix='#bc-transfer-'+direction;
     await page.locator(prefix+'-airport').selectOption(state.airport);
     await page.locator(`.bc-transfer-save[data-direction="${direction}"]`).click();
     await page.locator(`.bc-transfer-remove[data-direction="${direction}"]`).waitFor();
     const text=await page.locator(prefix+'-pricing').innerText();observations.push({direction,state:state.name,savedText:text});
     if(state.price===null){assert.match(text,/not configured/i);assert(!/0.00/.test(text));}
     else assert.match(text,locale==='en'?/included in package/i:/incluido en el paquete/i);
     await reopen();assert.equal(await page.locator(prefix+'-pricing').innerText(),text,'POST unknown/included survives reopen');
    }
   }
   assert.equal(observations.filter(o=>o.state==='exact-cents-reference').length,10);
   assert.equal(observations.filter(o=>o.state==='exact-cents-historical').length,10);
   assert.equal(observations.filter(o=>o.state==='GBP-reference-custom-zero').length,2);
   assert.equal(ledger.filter(e=>e.syntheticWrite).length,20);assert.deepEqual(errors,[]);assert.deepEqual(ledger.filter(e=>e.unexpected||(e.blocked&&!e.font)),[]);assert.deepEqual(consoleErrors.filter(e=>!e.includes('net::ERR_FAILED')),[]);
   results.push({name,passed:true,observations});
  }catch(e){results.push({name,passed:false,error:e.stack,observations});try{await page.screenshot({path:path.join(OUT,name+'-failure.png')});}catch(shotError){errors.push('failure screenshot: '+shotError.stack);}throw e;}
  finally{fs.writeFileSync(path.join(OUT,name+'-ledger.json'),JSON.stringify({ledger,errors,consoleErrors},null,2));fs.writeFileSync(path.join(OUT,name+'-responses.json'),JSON.stringify(responses,null,2));await ctx.close();await h.close();await browser.close();browser=null;}
 }assert.equal(results.length,4);}catch(e){failure=e;}finally{if(browser)await browser.close();fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify({passed:!failure,cases:results,limitations:'Production Transfer dispatcher GET/POST/SQL and embedded payload builder over isolated PGlite; synthetic calendar/context/auth scaffolding (not full context SQL or auth). Chromium emulation, not physical mobile; screenshots not independent visual review. Fonts aborted.'},null,2));}
 if(failure)throw failure;console.log('PASS: four desktop/mobile light/dark cases; both directions, airports, missing fare, custom zero save/reopen/remove; offline isolation.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
