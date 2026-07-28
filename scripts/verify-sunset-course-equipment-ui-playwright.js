'use strict';
/** Browser proof for the production-generated Sunset Admin course-equipment UI.
 * UI markup, CSS, owners and translations come only from /staff/ui.  Routes
 * below are backend mocks; this verifier never reconstructs UI behavior. */
const fs = require('fs');
process.env.STAFF_AUTH_REQUIRED='false'; process.env.STAFF_AUTH_ALLOW_OPEN='true'; process.env.NODE_ENV='test';
let pass=0, fail=0;
function ok(name, value, detail=''){ if(value){pass++;console.log('  PASS  '+name);}else{fail++;console.error('  FAIL  '+name+(detail?' — '+detail:''));} }
function eq(name,a,b){ok(name,a===b,`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);}
const sleep=(n)=>new Promise(r=>setTimeout(r,n));
const listen=(s)=>new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${s.address().port}`));});
const close=(s)=>new Promise(r=>s.close(r));
function playwright(){try{return require('playwright');}catch(e){const p='/opt/data/workspaces/wolfhouse-grok/node_modules/playwright';if(fs.existsSync(p))return require(p);throw e;}}
const initial={during_course:{policy:'extra',surfboard_cents:600,wetsuit_cents:400},all_day:{surfboard_cents:1200,wetsuit_cents:800}};
(async()=>{
 const {createSunsetAdminVerifyServer}=require('./fixtures/sunset-admin-verify-server');
 const server=createSunsetAdminVerifyServer(), base=await listen(server), browser=await playwright().chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1280,height:900}}), page=await context.newPage();
 const errors=[], patches=[], editQuotes=[], editPatches=[], createPosts=[]; let saved=JSON.parse(JSON.stringify(initial)), pending=null;
 const bookingId='11111111-1111-1111-1111-111111111111';
 let canonicalEquipment={mode:'during_course',quantity:2};
 const created=new Map();
 const editDetail=()=>({success:true,booking_id:bookingId,booking_code:'VERIFY-EDIT',guest_name:'Generated Edit',phone:'+34111111111',date_from:'2026-08-03',date_to:'2026-08-07',notes:'browser proof',payment_status:'unpaid',components:{course:{course_id:'verify-demo-pack',tier_key:'5_days',quantity:3,course_label:'Adult group course (verify)'}},course_equipment:{...canonicalEquipment},rentals:[],payment:{subtotal_cents:0,paid_cents:0,balance_due_cents:0,line_items:[]}});
 page.on('pageerror',e=>errors.push('page:'+e.message)); page.on('console',m=>{if(m.type()==='error')errors.push('console:'+m.text());});
 await context.addInitScript(()=>{localStorage.setItem('staff_portal_client','sunset');localStorage.setItem('staff_portal_sunset_location','sunset-somo');localStorage.setItem('wh_staff_portal_locale','en');});
 await page.route('**/staff/admin/config?**',async route=>{const req=route.request();if(req.method()==='GET'){const response=await route.fetch();const body=await response.json();body.course_equipment_pricing=saved;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});} return route.continue();});
 await page.route('**/staff/admin/config/course-equipment?**',async route=>{patches.push(JSON.parse(route.request().postData()||'{}'));if(pending){pending.push(route);return;}saved=patches.at(-1);return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,course_equipment_pricing:saved})});});
 await page.route('**/staff/schedule/bookings/detail?**',route=>{const id=new URL(route.request().url()).searchParams.get('booking_id');const row=created.get(id);return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(row?row.detail:editDetail())});});
 await page.route('**/staff/schedule/bookings/catalog?**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,courses:[{course_id:'verify-demo-pack',label:'Adult group course (verify)',eligible_on_requested_dates:true,price_tiers:[{key:'5_days',label:'5 days',duration_days:5,bookable:true,offering_id:'surf_pack_verify-demo-pack__5_days'}]}],rentals:[]})}));
 await page.route('**/staff/schedule/day?**',route=>{const date=new URL(route.request().url()).searchParams.get('date');const rows=[{booking_id:bookingId,booking_code:'VERIFY-EDIT',guest_name:'Generated Edit',record_source:'staff_manual',service_date:date,service_time_local:'10:00',service_time:'10:00',slot_time:'10:00',service_type:'surf_lesson',offering_label:'Adult group course (verify)',metadata:{component:'lesson',course_id:'verify-demo-pack'},quantity:3,payment_status:'unpaid',booking_status:'confirmed',status:'confirmed'},...[...created.values()].map(x=>({...x.day,service_date:date}))];return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,date,lessons:[],gear:[],rows})});});
 await page.route('**/staff/schedule/bookings/quote?**',route=>{editQuotes.push(JSON.parse(route.request().postData()||'{}'));return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,subtotal_cents:0,total_cents:0,line_items:[],quote_provenance:{source:'verify'}})});});
 await page.route('**/staff/schedule/bookings?**',route=>{const method=route.request().method();const body=JSON.parse(route.request().postData()||'{}');if(method==='POST'){createPosts.push(body);const n=createPosts.length,id=`22222222-2222-2222-2222-22222222222${n}`,code=`VERIFY-CREATE-${n}`,equipment=body.course_equipment;const qty=equipment.quantity;created.set(id,{detail:{success:true,booking_id:id,booking_code:code,guest_name:body.guest_name,phone:body.phone,date_from:body.date_from,date_to:body.date_to,notes:body.notes||'',payment_status:'unpaid',components:{course:{course_id:'verify-demo-pack',tier_key:'5_days',quantity:qty,course_label:'Adult group course (verify)'}},course_equipment:equipment,rentals:[],payment:{subtotal_cents:0,paid_cents:0,balance_due_cents:0,line_items:[]}},day:{booking_id:id,booking_code:code,guest_name:body.guest_name,record_source:'staff_manual',service_date:body.date_from,service_time_local:'10:00',service_time:'10:00',slot_time:'10:00',service_type:body.course?'surf_lesson':'private_lesson',offering_label:body.course?'Adult group course (verify)':'Private Course',metadata:{component:'lesson'},quantity:qty,payment_status:'unpaid',booking_status:'confirmed',status:'confirmed'}});return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,booking_id:id,booking_code:code})});}if(method==='PATCH'){editPatches.push(body);canonicalEquipment=body.course_equipment;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true})});}return route.continue();});
 try{
  await page.goto(base+'/staff/ui',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('#c-client')?.value==='sunset'&&!document.body.classList.contains('portal-profile-pending'));
  // Exercise the actual generated Create drawer (not a reconstructed DOM).
  await page.locator('#ps-create-booking').click(); await page.locator('#ps-create-modal').waitFor({state:'visible'});
  const rentals=page.locator('#ps-create-rentals');
  const noLesson=await rentals.evaluate(el=>({text:el.innerText,checkboxes:[...el.querySelectorAll('input[type=checkbox]')].filter(x=>x.offsetParent).length,hints:[...el.querySelectorAll('[class*=hint]')].filter(x=>x.offsetParent).length,buttons:[...el.querySelectorAll('button')].map(b=>b.innerText.trim()),left:getComputedStyle(el).textAlign}));
  ok('No Lesson is left aligned',noLesson.left==='left'||noLesson.left==='start',noLesson.left);
  ok('No Lesson localized combined SURFBOARD + WETSUIT card',/surfboard/i.test(noLesson.text)&&/wetsuit/i.test(noLesson.text),noLesson.text);
  eq('No Lesson has no visible checkbox',noLesson.checkboxes,0); eq('No Lesson has no visible hint',noLesson.hints,0);
  ok('No Lesson shows configured short durations only',noLesson.buttons.includes('1 hour')&&noLesson.buttons.includes('Half day')&&!noLesson.buttons.some(x=>/1 day/i.test(x)),JSON.stringify(noLesson.buttons));
  const durationButtons=rentals.locator('button'); eq('rental duration has at most one initial selection',(await rentals.locator('button.is-selected').count())<=1,true);
  if(await durationButtons.first().getAttribute('aria-checked')==='true') await durationButtons.first().click();
  await durationButtons.first().click(); eq('rental duration selects one',await rentals.locator('button.is-selected').count(),1);
  await durationButtons.first().click(); eq('selected rental duration deselects',await rentals.locator('button.is-selected').count(),0);
  await durationButtons.first().focus(); await page.keyboard.press('Space'); eq('rental duration keyboard selection',await rentals.locator('button.is-selected').count(),1);
  ok('keyboard selection retains focus',await durationButtons.first().evaluate(b=>document.activeElement===b));
  // Group and Private: use the real generated form, Create request, persistence mock and reopen path.
  for(const [idx,activity] of ['ps-create-comp-course','ps-create-comp-private-lesson'].entries()){
    if(idx) { await page.locator('#ps-create-booking').click();await page.locator('#ps-create-modal').waitFor({state:'visible'}); }
    await page.locator('#ps-create-guest').fill(idx?'Private Created':'Group Created');
    await page.locator('#ps-create-phone').fill('+34600111222');
    await page.evaluate(()=>{for(const [id,value] of [['ps-create-date-from','2026-08-10'],['ps-create-date-to','2026-08-14']]){const n=document.getElementById(id);n.value=value;n.dispatchEvent(new Event('change',{bubbles:true}));}});
    await page.locator(`[data-create-activity="${activity}"]`).click();
    if(!idx){await page.locator('#ps-create-course-list button[data-course-id]').first().waitFor();await page.locator('#ps-create-course-list button[data-course-id]').first().click();}
    const field=page.locator('#ps-create-course-equipment'); await field.waitFor({state:'visible'});
    const modes=field.locator('button[data-course-equipment-mode]'); eq(activity+' has two native mode buttons',await modes.count(),2);
    eq(activity+' initial mode is none',await field.locator('button[data-course-equipment-mode][aria-pressed=true]').count(),0);
    ok(activity+' copy says every booking day',(await field.innerText()).toLowerCase().includes('every booking day'));
    await page.locator('#ps-create-surfers').fill('4'); await page.locator('#ps-create-surfers').blur();
    await modes.first().click(); eq(activity+' pointer selects During Course',await modes.first().getAttribute('aria-pressed'),'true');
    eq(activity+' qty defaults to surfers',await page.locator('#ps-create-equipment-quantity').inputValue(),'4');
    await modes.nth(1).click();eq(activity+' mode selection is mutually exclusive',await field.locator('button[data-course-equipment-mode][aria-pressed=true]').count(),1);
    ok(activity+' selected button retains focus',await modes.nth(1).evaluate(b=>document.activeElement===b));
    await modes.nth(1).click();eq(activity+' selected click clears mode',await field.locator('button[data-course-equipment-mode][aria-pressed=true]').count(),0);
    await modes.first().click();await page.locator('#ps-create-equipment-quantity').fill('3');
    const beforePosts=createPosts.length,beforeQuotes=editQuotes.length;
    await page.locator('#ps-create-submit').waitFor({state:'visible'});eq(activity+' actual Create enabled',await page.locator('#ps-create-submit').isEnabled(),true);
    await page.locator('#ps-create-submit').click();await page.locator('#ps-create-modal').waitFor({state:'hidden'});
    eq(activity+' sends one bounded POST',createPosts.length,beforePosts+1);ok(activity+' submit requote is bounded',editQuotes.length<=beforeQuotes+1,`before=${beforeQuotes} after=${editQuotes.length}`);
    const equipment=createPosts.at(-1).course_equipment;
    eq(activity+' real POST is canonical mode + quantity',JSON.stringify(equipment),JSON.stringify({mode:'during_course',quantity:3}));
    ok(activity+' POST equipment has no cents/client dates',!JSON.stringify(equipment).match(/cents|date|client/i),JSON.stringify(equipment));
    ok(activity+' has no stale legacy addon/menu',!('addons' in equipment)&&await field.locator('select').count()===0,JSON.stringify(equipment));
    if(await page.locator('#ps-detail-drawer').isVisible())await page.locator('#ps-drawer-close').click();
    await page.locator('#ps-refresh-schedule').click();
    const row=page.locator('[data-ps-booking-id]').filter({hasText:idx?'Private Created':'Group Created'}).first();await row.waitFor();await row.click();
    await page.locator('#ps-drawer-edit').click();await page.locator('#ps-drawer-course-equipment').waitFor();
    eq(activity+' reopen reads canonical saved mode',await page.locator('#ps-drawer-course-equipment [data-drawer-course-equipment-mode="during_course"]').getAttribute('aria-pressed'),'true');
    eq(activity+' reopen reads canonical saved quantity',await page.locator('#ps-drawer-equipment-quantity').inputValue(),'3');
    await page.locator('#ps-drawer-cancel').click();await page.locator('#ps-drawer-close').click();
  }
  await page.locator('#ps-create-booking').click();await page.locator('[data-create-activity="ps-create-comp-course"]').click();await page.locator('#ps-create-course-equipment').waitFor();
  await page.locator('#ps-create-equipment-during').click();await page.locator('#ps-create-equipment-during').click();eq('Create explicit none clears canonical selection',await page.locator('#ps-create-course-equipment [aria-pressed=true]').count(),0);
  await page.locator('#ps-create-equipment-during').click();
  for(const locale of ['en','es','it']){await page.evaluate(l=>window.setStaffLocale(l),locale);const text=await page.locator('#ps-create-course-equipment').innerText();ok(locale.toUpperCase()+' Create equipment localized',!text.includes('schedule.courseEquipment.'),text);}
  for(const width of [320,375,390,430]){await page.setViewportSize({width,height:900});const shape=await page.locator('#ps-create-course-equipment').evaluate(el=>({overflow:el.scrollWidth>el.clientWidth+1,targets:[...el.querySelectorAll('button,input')].map(x=>x.getBoundingClientRect().height)}));ok(width+'px Create equipment no overflow',!shape.overflow,JSON.stringify(shape));ok(width+'px Create equipment 44px targets',shape.targets.every(h=>h>=44),JSON.stringify(shape.targets));}
  await page.locator('#ps-create-close').click(); await page.setViewportSize({width:1280,height:900});
  if(await page.locator('#ps-detail-drawer').isVisible())await page.locator('#ps-drawer-close').click();
  // Open the production view and its actual Edit button against canonical readback.
  await page.locator('button.tab-btn[data-tab="portal-home"]').click();
  const generatedEditRow=page.locator('[data-ps-booking-id]').filter({hasText:'Generated Edit'}).first();
  await generatedEditRow.waitFor({state:'visible'});
  await generatedEditRow.click();
  await page.locator('#ps-drawer-edit').waitFor({state:'visible'}); await page.locator('#ps-drawer-edit').click();
  const editField=page.locator('#ps-drawer-course-equipment'); await editField.waitFor({state:'visible'});
  const editModes=editField.locator('[data-drawer-course-equipment-mode]');
  eq('Edit uses During/All Day buttons',await editModes.count(),2); eq('Edit has no old equipment menu',await editField.locator('select').count(),0);
  eq('Edit canonical mode is seeded',await editModes.first().getAttribute('aria-pressed'),'true');eq('Edit canonical quantity is seeded',await page.locator('#ps-drawer-equipment-quantity').inputValue(),'2');
  await page.locator('#ps-drawer-equipment-quantity').fill('1');await page.evaluate(()=>{const d=document.getElementById('ps-drawer-date-to');d.value='2026-08-06';d.dispatchEvent(new Event('change',{bubbles:true}));});await page.locator('#ps-drawer-course-qty').fill('2');
  eq('Edit quantity change is retained',await page.locator('#ps-drawer-equipment-quantity').inputValue(),'1');eq('Edit date change is retained',await page.locator('#ps-drawer-date-to').inputValue(),'2026-08-06');eq('Edit surfer change is retained',await page.locator('#ps-drawer-course-qty').inputValue(),'2');
  await editModes.nth(1).click();eq('Edit mode switches mutually exclusively',await editField.locator('[aria-pressed=true]').count(),1);
  await editModes.nth(1).click();eq('Edit selected mode deselects to none',await editField.locator('[aria-pressed=true]').count(),0);
  await page.locator('#ps-drawer-cancel').click();await page.locator('#ps-drawer-edit').click();await editField.waitFor({state:'visible'});
  await page.locator('#ps-drawer-equipment-quantity').fill('1');
  await sleep(100);const quotesBeforeSave=editQuotes.length;if(await page.locator('#ps-drawer-save').isDisabled())throw new Error('Edit invalid: '+await page.locator('#ps-drawer-summary').innerText());await page.locator('#ps-drawer-save').click();await page.locator('#ps-drawer-edit').waitFor({state:'visible'});
  eq('Edit save sends one bounded PATCH',editPatches.length,1);ok('Edit requote requests are bounded',editQuotes.length<=quotesBeforeSave+1,`before=${quotesBeforeSave} after=${editQuotes.length}`);
  eq('Edit authoritative save carries mode + quantity',JSON.stringify(editPatches[0].course_equipment),JSON.stringify({mode:'during_course',quantity:1}));
  ok('Edit equipment payload has no cents/client dates',!JSON.stringify(editPatches[0].course_equipment).match(/cents|date|client/i),JSON.stringify(editPatches[0].course_equipment));
  await page.locator('#ps-drawer-edit').click();await editField.waitFor({state:'visible'});eq('Edit reopen reads canonical saved mode',await editModes.first().getAttribute('aria-pressed'),'true');eq('Edit reopen reads canonical saved quantity',await page.locator('#ps-drawer-equipment-quantity').inputValue(),'1');
  await page.locator('#ps-drawer-cancel').click();
  await page.locator('#ps-drawer-close').click();
  await page.locator('button.tab-btn[data-tab="admin"]').click(); await page.locator('#admin-tab-pricing').click(); await page.locator('[data-admin-course-equipment]').waitFor();
  const order=await page.evaluate(()=>{const a=document.querySelector('[data-admin-course-equipment]'),p=a?.previousElementSibling;return {previous:(p?.textContent||'').trim(),inputs:a?.querySelectorAll('input[type=number]').length,radios:a?.querySelectorAll('input[type=radio]').length};});
  ok('section is immediately below Private Courses',/Private/i.test(order.previous),order.previous); eq('four separate price inputs',order.inputs,4); eq('Free/Extra are native radios',order.radios,2);
  const ids=['admin-course-during-board','admin-course-during-suit','admin-course-all-day-board','admin-course-all-day-suit'];
  eq('canonical GET seeds all four values',(await Promise.all(ids.map(id=>page.locator('#'+id).inputValue()))).join(','),'600,400,1200,800');
  const unrelatedGroup=page.locator('[data-admin-price-group]').filter({has:page.locator('[data-admin-action="edit-price-group"]')}).first();
  const unrelatedKey=await unrelatedGroup.getAttribute('data-admin-price-group');await unrelatedGroup.locator('[data-admin-action="edit-price-group"]').click();const unrelatedDraft=page.locator(`[data-admin-price-group="${unrelatedKey}"] [data-admin-price-field="amount"]`).first();await unrelatedDraft.fill('77.77');
  await page.locator('input[value="free_with_course"]').check(); ok('Free disables during-course prices',await page.locator('#admin-course-during-board').isDisabled()&&await page.locator('#admin-course-during-suit').isDisabled());
  await page.locator('input[value="extra"]').check(); ok('Extra enables during-course prices',!await page.locator('#admin-course-during-board').isDisabled());
  for(let i=0;i<4;i++)await page.locator('#'+ids[i]).fill(String([701,402,1303,804][i]));
  await page.locator('[data-admin-action="save-course-equipment"]').click(); await page.waitForFunction(()=>document.querySelector('[data-admin-action="save-course-equipment"]')&&!document.querySelector('[data-admin-action="save-course-equipment"]').disabled);
  eq('save sends exactly one PATCH',patches.length,1); eq('PATCH is policy + four backend-unit prices',JSON.stringify(patches[0]),JSON.stringify({during_course:{policy:'extra',surfboard_cents:701,wetsuit_cents:402},all_day:{surfboard_cents:1303,wetsuit_cents:804}}));
  eq('course equipment save preserves unrelated Pricing draft',await page.locator('[data-admin-price-field="amount"]').first().inputValue(),'77.77');
  await page.locator('#admin-tab-finance').click();await page.locator('#admin-tab-pricing').click();eq('Pricing tab roundtrip preserves unrelated draft',await page.locator('[data-admin-price-field="amount"]').first().inputValue(),'77.77');
  await page.locator('button.tab-btn[data-tab="admin"]').click(); await page.locator('#admin-tab-pricing').click(); await page.locator('[data-admin-course-equipment]').waitFor(); eq('production GET reloads canonical save',await page.locator('#admin-course-all-day-board').inputValue(),'1303');
  for(const locale of ['en','es','it']){await page.evaluate(l=>window.setStaffLocale(l),locale);await page.locator('button.tab-btn[data-tab="admin"]').click();await page.locator('#admin-tab-pricing').click();await page.locator('[data-admin-course-equipment]').waitFor();const t=await page.locator('[data-admin-course-equipment]').innerText();ok(locale.toUpperCase()+' localized section has no raw key',!t.includes('admin.courseEquipment.'),t);}
  await page.locator('input[value="free_with_course"]').focus();await page.keyboard.press('ArrowRight');eq('radio keyboard changes to Extra',await page.locator('input[name="admin-course-equipment-policy"]:checked').getAttribute('value'),'extra');
  for(const width of [320,375,390,430]){await page.setViewportSize({width,height:900});const layout=await page.locator('[data-admin-course-equipment]').evaluate(el=>({overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth||el.scrollWidth>el.clientWidth+1,targets:[...el.querySelectorAll('button,input[type="number"],label.portal-admin-touch')].map(x=>x.getBoundingClientRect().height)}));ok(width+'px no horizontal overflow',!layout.overflow,JSON.stringify(layout));ok(width+'px controls are 44px targets',layout.targets.every(h=>h>=44),JSON.stringify(layout.targets));}
  pending=[];await page.locator('[data-admin-action="save-course-equipment"]').click();await page.locator('[data-admin-action="save-course-equipment"]').click();await sleep(50);eq('in-flight double click creates one request',pending.length,1);await pending[0].fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,course_equipment_pricing:saved})});pending=null;
  await page.setViewportSize({width:1280,height:900});
  await page.evaluate(()=>{const n=document.querySelector('#c-client');n.value='wolfhouse-somo';n.dispatchEvent(new Event('change',{bubbles:true}));});await page.waitForFunction(()=>document.querySelector('#c-client')?.value==='wolfhouse-somo');
  eq('Wolfhouse has no Sunset equipment Admin controls',await page.locator('[data-admin-course-equipment]:visible').count(),0);eq('Wolfhouse has no Sunset Admin navigation',await page.locator('button.tab-btn[data-tab="admin"]:visible').count(),0);
  eq('Wolfhouse has no Sunset equipment Create controls',await page.locator('#ps-create-booking:visible').count(),0);
  const normalNav=page.locator('button.tab-btn:visible').first();await normalNav.click();ok('Wolfhouse normal navigation remains',await normalNav.evaluate(el=>el.classList.contains('active')));
  eq('no page or console errors',errors.join('|'),'');
 }finally{await context.close();await browser.close();await close(server);}
 console.log(`\nverify:sunset-course-equipment-ui-playwright — ${pass} passed, ${fail} failed`);if(fail)process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1);});
