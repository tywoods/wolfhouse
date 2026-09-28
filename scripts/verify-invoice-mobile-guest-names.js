'use strict';
// Production HTML and registered drawer controls; exact synthetic HTTP only, no listeners.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {chromium}=require('playwright');
const {loadClientPortalProfile}=require('./lib/staff-portal-clients');
const {resolveTenantBusinessConfig}=require('./lib/tenant-business-config');
const ROOT=path.resolve(__dirname,'..'),OUT=path.resolve(process.argv[2]||'tmp/mobile-evidence/browser');
const MODE=process.argv[3]||'layout',ORIGIN='http://staff.test',CODE='WH-NAMES-TEST';
const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const gids=['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc','dddddddd-dddd-4ddd-8ddd-dddddddddddd'];
const names=['Alexandria Verylongsurname (test)','Tom & Teresa Longsurname (test)','Zoë Longsurname (test)'];
const booking={booking_id:ID,booking_code:CODE,guest_name:names[0],guest_count:3,total_amount_cents:90000,accommodation_total_cents:90000,deposit_required_cents:27000,amount_paid_cents:9000,balance_due_cents:81000,status:'confirmed',check_in:'2026-09-24',check_out:'2026-09-29',nights:5};
const state={success:true,booking,rooming:{assignments:[]},booking_guests:gids.map((id,i)=>({booking_guest_id:id,guest_number:i+1,guest_name:names[i],assigned_bed_code:'R1-B'+(i+1),metadata:{subtotal_cents:30000},deposit_amount_cents:9000,amount_paid_cents:i===1?9000:0,payment_status:i===1?'paid':'not_requested'})),per_person:[],guest_accommodation_lines:gids.map((_,i)=>({guest_number:i+1,accommodation_cents:30000,nights:5})),service_records:[],transfers:[],payments:{paid_total_cents:9000,rows:[]},pending_manual_services:[],conversation:null};
const calendar={success:true,days:Array.from({length:14},(_,i)=>({date:new Date(Date.UTC(2026,8,24+i)).toISOString().slice(0,10)})),rooms:[{room_code:'R1',room_name:'Room 1',beds:gids.map((_,i)=>({bed_code:'R1-B'+(i+1),bed_label:'Bed '+(i+1)}))}],blocks:gids.map((_,i)=>({...booking,room_code:'R1',bed_code:'R1-B'+(i+1),start_date:booking.check_in,end_date:booking.check_out,source:'staff',start_offset:0,span:5,calendar_group_size:3,calendar_guest_number:i+1,calendar_guest_share_cents:30000,calendar_guest_deposit_cents:9000,calendar_guest_paid_cents:i===1?9000:0})),warnings:[]};
async function main(){
 fs.mkdirSync(OUT,{recursive:true});
 const emitted=path.join(OUT,'wolfhouse-somo.html');
 const emit=spawnSync(process.execPath,['scripts/verify-inbox-ui-parity.js','--emit','wolfhouse-somo',emitted],{cwd:ROOT,encoding:'utf8',env:{...process.env,STAFF_ACTIONS_ENABLED:'true',STRIPE_LINKS_ENABLED:'true'}});
 assert.equal(emit.status,0,emit.stderr||emit.stdout);
 const html=fs.readFileSync(emitted,'utf8'),ledger=[],errors=[],cases=[],layouts=[],dialogs=[];
 const other=JSON.parse(JSON.stringify(state));other.booking={...other.booking,booking_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',booking_code:'WH-OTHER',guest_name:'Other booking'};
 other.booking_guests=[{...other.booking_guests[0],guest_name:'Other booking',booking_guest_id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'}];
 calendar.blocks.push({...calendar.blocks[0],...other.booking,bed_code:'R1-B4'});calendar.rooms[0].beds.push({bed_code:'R1-B4',bed_label:'Bed 4'});
 let writeControl=null;
 const browser=await chromium.launch({headless:true});
 const ctx=await browser.newContext({viewport:{width:320,height:1000},serviceWorkers:'block'});
 await ctx.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url()),e={method:req.method(),url:req.url()};ledger.push(e);
  if(u.origin===ORIGIN&&req.method()==='POST'&&u.pathname==='/staff/bookings/edit'&&MODE==='edit'){
   e.syntheticWrite=true;e.raw=req.postData();e.body=req.postDataJSON();
   const b=e.body;
   assert.equal(b.client_slug,'wolfhouse-somo');
   assert(['guest_names','contact','dates','private_room'].includes(b.edit_type));
   if(b.edit_type==='guest_names')assert(Array.isArray(b.guest_names)&&b.guest_names.length>0);
   const control=writeControl;writeControl=null;
   if(control&&control.hold){e.held=true;await new Promise(resolve=>{control.release=resolve;});e.released=true;}
   if(control&&control.network)return route.abort('failed');
   if(control&&control.fail)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({success:false,error:'Synthetic save failed'})});
   if(b.edit_type==='guest_names')for(const edit of b.guest_names){const guest=state.booking_guests.find(g=>g.booking_guest_id===edit.booking_guest_id);assert(guest,'durable guest ID');guest.guest_name=edit.guest_name;if(guest.guest_number===1)state.booking.guest_name=edit.guest_name;}
   if(b.edit_type==='contact')for(const key of ['guest_name','phone','email'])if(Object.hasOwn(b,key))state.booking[key]=b[key];
   return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,updated:true})});
  }
  if(u.origin!==ORIGIN||req.method()!=='GET'){e.blocked=true;return route.abort();}
  const p=u.pathname;let data;
  if(p==='/staff/ui')return route.fulfill({contentType:'text/html',body:html});
  if(p==='/staff/bed-calendar')data=calendar;
  else if(p===`/staff/bookings/${CODE}/context`)data=state;
  else if(p==='/staff/bookings/WH-OTHER/context')data=other;
  else if(p===`/staff/bookings/${other.booking.booking_id}/services`)data={success:true,paid_requested_services:[],unscheduled_services:[],services_by_date:[]};
  else if(p===`/staff/bookings/${other.booking.booking_id}/transfers`)data={success:true,client_slug:'wolfhouse-somo',booking_id:other.booking.booking_id,transfers:[],airports:[],defaults:{}};
  else if(p==='/staff/auth/session')data={success:true,auth_required:false,role:'admin',clients:[{slug:'wolfhouse-somo',name:'Wolfhouse'}],client_profiles:{'wolfhouse-somo':loadClientPortalProfile('wolfhouse-somo')}};
  else if(p.startsWith('/staff/assets/')){const asset=path.join(ROOT,'config/staff-portal',path.basename(p));if(fs.existsSync(asset))return route.fulfill({path:asset});e.unknown=true;return route.abort();}
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
  else if(p===`/staff/bookings/${ID}/services`)data={success:true,paid_requested_services:[],unscheduled_services:[],services_by_date:[]};
  else if(p===`/staff/bookings/${ID}/transfers`)data={success:true,client_slug:'wolfhouse-somo',booking_id:ID,booking_code:CODE,timezone:'Europe/Madrid',transfers_available:true,airports:[],transfers:[],defaults:{default_airport_code:'SDR'}};
  else if(p==='/staff/clients')data={success:true,clients:[{slug:'wolfhouse-somo',name:'Wolfhouse'}]};
  else {e.unknown=true;return route.abort();}
  return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
 });
 await ctx.addInitScript(()=>{localStorage.setItem('wh_staff_portal_locale','en');window.WebSocket=function(){throw new Error('Offline WebSocket denied');};});
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(String(e)));page.on('dialog',async d=>{dialogs.push(d.message());await d.accept();});
 let failure=null;
 try{
  async function open(theme='light'){
   await page.goto(ORIGIN+'/staff/ui');
   await page.waitForFunction(()=>typeof window.switchToTab==='function'&&document.getElementById('c-client').value==='wolfhouse-somo');
   await page.evaluate(()=>window.switchToTab('bed-calendar'));
   await page.locator('.bc-block').first().click();await page.mouse.move(10,500);
   await page.locator('#bc-inv-totals').waitFor();
   await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),theme);
   const width=page.viewportSize().width;
   assert(await page.locator(width<=768?'#bc-detail #bc-drawer-card-booking':'#bc-side-drawer #bc-drawer-card-booking').isVisible(),'ordinary entrypoint active mount');
  }
  function setPaid(paid){state.payments.rows=paid?[{payment_id:'receipt-all',payment_status:'paid',amount_paid_cents:90000,created_at:'2026-09-26T10:00:00Z',paid_at:'2026-09-26T10:01:00Z',metadata:{method:'bank_transfer',payment_scope:'booking'}}]:[];}
  const pen=()=>page.locator('#bc-field-group-guests .btn-bc-field-edit').click();
  const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const contextReads=()=>ledger.filter(e=>new URL(e.url).pathname.endsWith('/context')).length;
  async function select(index,name){await page.locator('.bc-block').nth(index).click();await page.mouse.move(10,500);await page.waitForFunction(n=>document.getElementById('bc-field-contact-name')?.value===n,name);}
  if(MODE==='edit'){
   for(const paid of [false,true])for(const width of [1440,320,390])for(const theme of ['light','dark']){
    setPaid(paid);await page.setViewportSize({width,height:1000});await open(theme);
    await page.locator('#bc-field-group-guests .btn-bc-field-edit').click();
    assert.equal(await page.locator('.bc-inline-guest-name:visible').count(),3,'top Booking Details pen opens every guest name on '+width);
    const inputs=page.locator('.bc-inline-guest-name');
    const proposed='Edited non-lead '+width+' '+theme+' '+paid+' & <test>';
    await inputs.nth(1).fill(proposed);
    const editStyle=await inputs.nth(1).evaluate(e=>({fg:getComputedStyle(e).color,bg:getComputedStyle(e).backgroundColor,rect:e.getBoundingClientRect().toJSON()}));
    function luminance(rgb){const a=rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;});return a[0]*0.2126+a[1]*0.7152+a[2]*0.0722;}
    const fg=luminance(editStyle.fg),bg=luminance(editStyle.bg);
    assert((Math.max(fg,bg)+0.05)/(Math.min(fg,bg)+0.05)>=4.5,'editable name contrast '+JSON.stringify({width,theme,editStyle}));
    assert(editStyle.rect.width>=100&&editStyle.rect.left>=0&&editStyle.rect.right<=width+1,'name input fits active viewport');
    await page.locator('#bc-drawer-card-booking').screenshot({path:path.join(OUT,`edit-${width}-${theme}-${paid?'paid':'partial'}.png`)});
    const before=ledger.filter(e=>e.syntheticWrite).length;
    await page.locator('#bc-inline-save').click();
    await page.waitForFunction(()=>!document.querySelector('.bc-inline-guest-name'));
    assert.equal(ledger.filter(e=>e.syntheticWrite).length,before+1,'non-lead Save must post its name');
    assert.equal(state.booking_guests[1].guest_name,proposed);
    await open();assert((await page.locator('#bc-guest-names').innerText()).includes(proposed),'ordinary reopen shows saved name');
    cases.push('non-lead-save-reopen-'+width+'-'+theme+'-'+paid);
   }
   await page.setViewportSize({width:1440,height:1000});await open();
   await page.locator('#bc-field-group-guests .btn-bc-field-edit').click();
   await page.locator('.bc-inline-guest-name').nth(1).fill('Delayed old save');
   const held={hold:true};writeControl=held;
   const requested=page.waitForRequest(r=>r.method()==='POST'&&new URL(r.url()).pathname==='/staff/bookings/edit');
   await page.locator('#bc-inline-save').click();await requested;
   await page.locator('.bc-block').nth(3).click();await page.mouse.move(1300,500);
   await page.waitForFunction(()=>document.getElementById('bc-field-contact-name')?.value==='Other booking');
   await page.locator('#bc-field-group-guests .btn-bc-field-edit').click();
   await page.locator('.bc-inline-guest-name').fill('Unsaved other name');
   const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/staff/bookings/edit');
   held.release();await response;await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   assert.equal(await page.locator('.bc-inline-guest-name').count(),1,'late old Save must not close another booking editor');
   assert.equal(await page.locator('.bc-inline-guest-name').inputValue(),'Unsaved other name');
   cases.push('late-save-does-not-close-new-booking-editor');
   await open();await page.locator('#bc-field-group-guests .btn-bc-field-edit').click();
   await page.locator('.bc-inline-guest-name').nth(1).fill('Queued name');
   await page.locator('#bc-field-dates-check-out').fill('2026-09-30');
   await page.locator('label[for="bc-field-private-room-read-switch"]').click();
   assert.equal(await page.locator('#bc-field-private-room-read-switch').isChecked(),true);
   const queueHeld={hold:true};writeControl=queueHeld;
   const queueStart=ledger.length;
   const queueRequest=page.waitForRequest(r=>r.method()==='POST');
   await page.locator('#bc-inline-save').click();await queueRequest;
   await page.locator('.bc-block').nth(3).click();await page.mouse.move(1300,500);
   await page.waitForFunction(()=>document.getElementById('bc-field-contact-name')?.value==='Other booking');
   const queueDone=page.waitForResponse(r=>r.request().postDataJSON()?.edit_type==='private_room'&&r.request().method()==='POST');
   queueHeld.release();await queueDone;
   const queued=ledger.slice(queueStart).filter(e=>e.syntheticWrite).map(e=>e.body);
   assert.deepEqual(queued.map(b=>b.edit_type),['guest_names','dates','private_room']);
   assert(queued.every(b=>b.booking_id===ID&&b.booking_code===CODE&&b.client_slug==='wolfhouse-somo'),'every serial job retains original booking/tenant');
   assert.equal(queued[1].check_out,'2026-09-30','date captured before dispatch');
   assert.equal(queued[2].private_room_enabled,true);
   cases.push('serial-payloads-capture-booking-and-inputs');
   await open();await page.locator('#bc-field-group-guests .btn-bc-field-edit').click();
   await page.locator('.bc-inline-guest-name').first().fill('New lead with contact');
   await page.locator('#bc-field-contact-phone').fill('+34942000000');
   await page.locator('#bc-field-contact-email').fill('edited@example.test');
   const contactStart=ledger.length;
   await page.locator('#bc-inline-save').click();
   await page.waitForFunction(()=>!document.querySelector('.bc-inline-guest-name')&&document.getElementById('bc-guest-names'));
   assert.equal(state.booking.guest_name,'New lead with contact','contact Save must not overwrite the new lead with old hidden name');
   assert.equal(state.booking.phone,'+34942000000');assert.equal(state.booking.email,'edited@example.test');
   assert.deepEqual(ledger.slice(contactStart).filter(e=>e.syntheticWrite).map(e=>e.body.edit_type),['guest_names','contact']);
   cases.push('lead-name-and-explicit-contact-edit');
   for(const width of [1440,320,390]){
    await page.setViewportSize({width,height:1000});await open();await pen();
    const writes=ledger.filter(e=>e.syntheticWrite).length;
    await page.locator('.bc-inline-guest-name').nth(1).fill('Cancelled edit');
    await page.locator('#bc-inline-cancel').click();await pen();
    assert.notEqual(await page.locator('.bc-inline-guest-name').nth(1).inputValue(),'Cancelled edit');
    await page.locator('#bc-inline-save').click();await page.waitForFunction(()=>!document.querySelector('.bc-inline-guest-name'));
    assert.equal(ledger.filter(e=>e.syntheticWrite).length,writes,'cancel and unchanged Save do not mutate');
    cases.push('cancel-and-unchanged-'+width);
    for(const outcome of ['http','network']){
     await open();await pen();const proposed='Retained '+outcome+' '+width;
     await page.locator('.bc-inline-guest-name').nth(1).fill(proposed);
     writeControl=outcome==='http'?{fail:true}:{network:true};const ds=dialogs.length;
     await page.locator('#bc-inline-save').click();
     await page.waitForFunction(()=>document.getElementById('bc-inline-save')?.disabled===false);
     assert.equal(dialogs.length,ds+1);assert.equal(await page.locator('.bc-inline-guest-name').nth(1).inputValue(),proposed);
     assert(await page.locator('#bc-inline-cancel').isEnabled());
     await page.locator('#bc-inline-save').click();await page.waitForFunction(()=>!document.querySelector('.bc-inline-guest-name'));
     assert.equal(state.booking_guests.find(g=>g.booking_guest_id===gids[1]).guest_name,proposed);
     cases.push('current-failure-retains-input-and-retry-'+width+'-'+outcome);
    }
   }
   for(const width of [1440,320,390])for(const pathName of ['A-B','A-B-A','cancel-reopen'])for(const outcome of ['success','http','network']){
    await page.setViewportSize({width,height:1000});await open();await pen();
    await page.locator('.bc-inline-guest-name').nth(1).fill('Held '+width+' '+pathName+' '+outcome);
    const control={hold:true,fail:outcome==='http',network:outcome==='network'};writeControl=control;
    const request=page.waitForRequest(r=>r.method()==='POST');await page.locator('#bc-inline-save').click();await request;
    if(pathName==='cancel-reopen')await page.locator('#bc-inline-cancel').click();
    else {await select(3,'Other booking');if(pathName==='A-B-A')await select(0,state.booking.guest_name);}
    await pen();await page.locator('.bc-inline-guest-name').first().fill('New session unsaved');
    const node=await page.locator('.bc-inline-guest-name').first().elementHandle();
    const before={reads:contextReads(),dialogs:dialogs.length,count:await page.locator('.bc-inline-guest-name').count()};
    const done=outcome==='network'?page.waitForEvent('requestfailed',{predicate:r=>r.method()==='POST'}):page.waitForResponse(r=>r.request().method()==='POST');
    control.release();await done;await settle();
    assert.equal(await node.evaluate(e=>e.isConnected&&e.value==='New session unsaved'),true,'late completion preserves exact current editor node');
    assert.equal(await page.locator('.bc-inline-guest-name').count(),before.count);
    assert(await page.locator('#bc-inline-save').isEnabled());assert(await page.locator('#bc-inline-cancel').isEnabled());
    assert.equal(contextReads(),before.reads,'obsolete completion does not refresh');assert.equal(dialogs.length,before.dialogs,'obsolete errors do not alert');
    cases.push('held-'+width+'-'+pathName+'-'+outcome);
   }
   // Duplicate names, a blank durable slot and reordered context/display are not identities.
   state.booking_guests.forEach((g,i)=>g.guest_name=i===2?'':'Same name');state.booking.guest_name='Same name';
   state.booking_guests.reverse();await open();await pen();
   assert.deepEqual(await page.locator('.bc-inline-guest-name').evaluateAll(es=>es.map(e=>e.dataset.bookingGuestId)),gids);
   await page.locator('#bc-guest-names').evaluate(e=>e.prepend(e.lastElementChild));
   const expected=gids.map((id,i)=>({booking_guest_id:id,guest_name:'Identity '+(i+1)+' & <safe>'}));
   for(const edit of expected)await page.locator('.bc-inline-guest-name[data-booking-guest-id="'+edit.booking_guest_id+'"]').fill(edit.guest_name);
   const captured=page.waitForRequest(r=>r.method()==='POST');await page.locator('#bc-inline-save').click();const raw=(await captured).postData();
   await page.waitForFunction(()=>!document.querySelector('.bc-inline-guest-name'));
   assert.deepEqual(JSON.parse(raw).guest_names.slice().sort((a,b)=>a.booking_guest_id.localeCompare(b.booking_guest_id)),expected);
   fs.writeFileSync(path.join(OUT,'captured-guest-names-payload.json'),raw);
   await open();for(const edit of expected)assert((await page.locator('#bc-guest-names').innerText()).includes(edit.guest_name));
   cases.push('durable-duplicate-blank-reordered-all-names');
   await page.setViewportSize({width:320,height:1000});await open();
   await page.locator('#bc-field-group-contact .btn-bc-field-edit').click();
   assert(await page.locator('#bc-field-contact-name').isVisible(),'phone standalone contact editor retains explicit name editing');
   assert(await page.locator('#bc-field-save-contact').isVisible(),'phone standalone contact Save remains available');
   await page.locator('[data-bc-field-cancel="contact"]').click();
   await page.locator('#bc-field-group-package .btn-bc-field-edit').click();
   assert(await page.locator('#bc-field-package-select-1').isVisible(),'phone standalone package editor preserved');
   await page.locator('[data-bc-field-cancel="package"]').click();await pen();
   assert(await page.locator('#bc-field-guests-select').isVisible(),'phone guest count editor preserved alongside names');
   cases.push('phone-unrelated-edit-controls-preserved');
   for(const explicitName of [false,true]){
    await open();await pen();
    const lead='Phone lead '+explicitName;
    await page.locator('.bc-inline-guest-name').first().fill(lead);
    await page.locator('#bc-field-contact-phone').fill(explicitName?'+34942000002':'+34942000001');
    if(explicitName)await page.locator('#bc-field-contact-name').fill('Explicit booking contact');
    await page.locator('#bc-inline-save').click();await page.waitForFunction(()=>!document.querySelector('.bc-inline-guest-name'));
    assert.equal(state.booking_guests.find(g=>g.guest_number===1).guest_name,lead);
    assert.equal(state.booking.guest_name,explicitName?'Explicit booking contact':lead);
    assert.equal(state.booking.phone,explicitName?'+34942000002':'+34942000001');
    cases.push('phone-lead-contact-precedence-'+explicitName);
   }
   await open();await pen();const invalidStart=ledger.length;
   await page.locator('.bc-inline-guest-name').first().fill('   ');
   await page.locator('#bc-inline-save').click();await settle();
   assert.equal(ledger.slice(invalidStart).filter(e=>e.syntheticWrite).length,0,'blank name validation precedes mutations');
   assert.equal(await page.locator('.bc-inline-guest-name').first().inputValue(),'   ');
   assert(await page.locator('#bc-inline-save').isEnabled());
   await page.locator('.bc-inline-guest-name').first().fill('Valid name with invalid dates');
   await page.locator('#bc-field-dates-check-out').fill('2026-09-20');
   await page.locator('#bc-inline-save').click();await settle();
   assert.equal(ledger.slice(invalidStart).filter(e=>e.syntheticWrite).length,0,'all jobs validate before any name dispatch');
   cases.push('invalid-name-or-later-job-no-partial-dispatch');
   const missing=state.booking_guests.find(g=>g.guest_number===3),savedId=missing.booking_guest_id;
   delete missing.booking_guest_id;await open();await pen();
   assert(await page.locator('.bc-inline-guest-name').nth(2).isDisabled(),'missing durable identity is explicitly read-only');
   assert.match(await page.locator('.bc-inline-guest-name').nth(2).getAttribute('title'),/no saved identity/);
   missing.booking_guest_id=savedId;cases.push('missing-durable-ID-no-invented-identity');
  }else for(const paid of [false,true]){
   setPaid(paid);
   for(const width of [320,390,1440]){
    await page.setViewportSize({width,height:1000});
    await open();
    for(const theme of ['light','dark']){
     await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),theme);
     await page.locator('#bc-guest-names').scrollIntoViewIfNeeded();
     const rows=await page.locator('#bc-guest-names .bc-guest-name-row').evaluateAll(es=>es.map(e=>{const n=e.querySelector('.bc-guest-name-line'),b=e.querySelector('.bc-guest-bed'),s=e.querySelector('.bc-accom-pay-pebble');return {name:n.textContent,bed:b.textContent,status:s.textContent,row:e.getBoundingClientRect().toJSON(),n:n.getBoundingClientRect().toJSON(),b:b.getBoundingClientRect().toJSON(),s:s.getBoundingClientRect().toJSON(),nameOverflow:n.scrollWidth>n.clientWidth,rowOverflow:e.scrollWidth>e.clientWidth};}));
     const ancestors=await page.locator('#bc-guest-names').evaluate(e=>{const a=[];for(let n=e;n;n=n.parentElement){const c=getComputedStyle(n);a.push({id:n.id,cls:n.className,rect:n.getBoundingClientRect().toJSON(),grid:c.gridTemplateColumns,display:c.display});}return a;});
     layouts.push({width,theme,paid,rows,ancestors});
     await page.screenshot({path:path.join(OUT,`names-${width}-${theme}-${paid?'paid':'partial'}.png`)});
     assert.equal(rows.length,3,'all saved names represented');
     assert.deepEqual(rows.map(r=>r.name),names);
     assert.deepEqual(rows.map(r=>r.status),paid?['Paid','Paid','Paid']:['Unpaid','Deposit Paid','Unpaid']);
     for(const r of rows){assert(r.n.width>=100,'readable guest name width >=100px: '+JSON.stringify(r));assert(!r.nameOverflow,'full guest name is readable rather than single-letter ellipsis');assert(!r.rowOverflow&&r.row.left>=0&&r.row.right<=width+1,'guest row fits viewport');assert(r.n.left<r.b.left&&(r.b.right<=r.s.left+1||r.s.top>=r.n.bottom),'name left of bed; status follows on same or next line');}
     cases.push(`layout-${width}-${theme}-${paid}`);
    }
   }
  }
  assert.equal(cases.length,MODE==='edit'?57:12);
  assert.deepEqual(errors,[],'no page errors');
  assert.equal(ledger.filter(e=>e.method!=='GET'&&!e.syntheticWrite).length,0,'no unexpected mutation');
  assert.equal(ledger.filter(e=>e.unknown).length,0,'all local GETs explicit');
 }catch(e){failure=e;console.error(e.stack);}
 finally{fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify({passed:!failure,mode:MODE,cases,layouts,ledger,errors,dialogs,failure:failure&&failure.stack},null,2));await browser.close();}
 if(failure)process.exitCode=1;else console.log('PASS '+cases.length+' mobile guest-name groups; '+OUT);
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
