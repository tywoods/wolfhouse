'use strict';
/** Focused browser contract: production-generated Schedule Edit Private multi-item equipment. */
const assert=require('assert');
process.env.STAFF_AUTH_REQUIRED='false';process.env.STAFF_AUTH_ALLOW_OPEN='true';process.env.NODE_ENV='test';
function pw(){try{return require('playwright');}catch(e){return require('/opt/data/workspaces/wolfhouse-grok/node_modules/playwright');}}
const listen=s=>new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${s.address().port}`));});
(async()=>{const {createSunsetAdminVerifyServer}=require('./fixtures/sunset-admin-verify-server');const server=createSunsetAdminVerifyServer(),base=await listen(server),browser=await pw().chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1280,height:900}}),patches=[],quotes=[],errors=[];
const id='33333333-3333-3333-3333-333333333333';
const options=[{offering_key:'carbon_fins',label:'Carbon fins'},{offering_key:'reef_helmet',label:'Reef helmet'}];
let activeOptions=options.slice();
let equipment=[{offering_key:'carbon_fins',mode:'during_course',quantity:3},{offering_key:'reef_helmet',mode:'all_day',quantity:2}];
const detail=()=>({success:true,booking_id:id,booking_code:'EDIT-PRIV-MULTI',guest_name:'Private Multi Guest',phone:'+34999888',date_from:'2026-08-10',date_to:'2026-08-10',notes:'private retained',payment_status:'unpaid',components:{private_lesson:{enabled:true,surfer_count:3,quantity:1,sessions:[{date:'2026-08-10',start:'10:00',end:'12:00'}]}},course_equipment:equipment,rentals:[],payment:{subtotal_cents:0,paid_cents:0,balance_due_cents:0,line_items:[]}});
page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{localStorage.setItem('staff_portal_client','sunset');localStorage.setItem('staff_portal_sunset_location','sunset-somo');localStorage.setItem('wh_staff_portal_locale','en');});
await page.route('**/staff/admin/config?**',async r=>{const x=await r.fetch(),b=await x.json();b.private_lesson={enabled:true,label:'Private Course',default_duration_minutes:120,equipment_options:activeOptions};await r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(b)});});
await page.route('**/staff/schedule/bookings/catalog?**',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,ok:true,courses:[],offerings:[{offering_type:'private_lesson',offering_key:'private',label:'Private Course',equipment_options:activeOptions}],rentals:[]})}));
await page.route('**/staff/schedule/bookings/detail?**',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(detail())}));
await page.route('**/staff/schedule/bookings/quote?**',r=>{quotes.push(JSON.parse(r.request().postData()||'{}'));return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,total_cents:0,subtotal_cents:0,line_items:[]})});});
await page.route('**/staff/schedule/bookings?**',r=>{if(r.request().method()!=='PATCH')return r.continue();const body=JSON.parse(r.request().postData()||'{}');patches.push(body);equipment=body.course_equipment;return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,context:detail()})});});
await page.route('**/staff/schedule/day?**',r=>{const date=new URL(r.request().url()).searchParams.get('date');return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,date,lessons:[],gear:[],rows:[{booking_id:id,booking_code:'EDIT-PRIV-MULTI',guest_name:'Private Multi Guest',record_source:'staff_manual',service_date:date,service_time_local:'10:00',service_type:'private_lesson',offering_label:'Private Course',metadata:{component:'private_lesson'},quantity:3,payment_status:'unpaid',booking_status:'confirmed',status:'confirmed'}]})});});
try{await page.goto(base+'/staff/ui');await page.waitForFunction(()=>document.querySelector('#c-client')?.value==='sunset');const row=page.locator('[data-ps-booking-id]').filter({hasText:'Private Multi Guest'}).first();await row.waitFor();await row.click();await page.locator('#ps-drawer-edit').click();const field=page.locator('#ps-drawer-course-equipment');await field.waitFor({state:'visible'});
// Exact independent current-style control per configured Private option; no Surfboard/Wetsuit singleton.
assert.strictEqual(await page.locator('#ps-drawer-equipment-enabled').count(),0,'no private singleton enable');
assert.strictEqual(await field.locator('.portal-schedule-course-equipment-name',{hasText:/Surfboard|Wetsuit/i}).count(),0);
let items=field.locator('.portal-schedule-course-equipment-item');assert.strictEqual(await items.count(),2);
assert.deepStrictEqual(await items.locator('.portal-schedule-course-equipment-name').allTextContents(),['Carbon fins','Reef helmet']);
assert.strictEqual(await items.nth(0).locator('input[type=checkbox]').isChecked(),true);
assert.strictEqual(await items.nth(1).locator('input[type=checkbox]').isChecked(),true);
assert.strictEqual(await items.nth(0).locator('[data-drawer-course-equipment-mode="during_course"]').getAttribute('aria-pressed'),'true');
assert.strictEqual(await items.nth(1).locator('[data-drawer-course-equipment-mode="all_day"]').getAttribute('aria-pressed'),'true');
assert.strictEqual(await items.nth(0).locator('[data-course-equipment-quantity]').inputValue(),'3');
assert.strictEqual(await items.nth(1).locator('[data-course-equipment-quantity]').inputValue(),'2');
assert.strictEqual(await items.nth(1).locator('.portal-schedule-course-equipment-sets').isVisible(),true);
// Edit: flip modes/qty and deselect; PATCH exact non-empty identity array only.
await items.nth(0).locator('[data-drawer-course-equipment-mode="all_day"]').click();
await items.nth(0).locator('[data-course-equipment-quantity]').fill('1');
await items.nth(1).locator('input[type=checkbox]').uncheck();
// Newly selected defaults During Course; During uses private surfer count.
await items.nth(1).locator('input[type=checkbox]').check();
assert.strictEqual(await items.nth(1).locator('[data-drawer-course-equipment-mode="during_course"]').getAttribute('aria-pressed'),'true');
await page.locator('#ps-drawer-private-lesson-surfers').fill('3');
const q0=quotes.length;await page.locator('#ps-drawer-save').click();await page.waitForTimeout(500);
assert.strictEqual(patches.length,1,'one PATCH');
const exact=[{offering_key:'carbon_fins',mode:'all_day',quantity:1},{offering_key:'reef_helmet',mode:'during_course',quantity:3}];
assert.deepStrictEqual(patches[0].course_equipment,exact);
assert(!/cents|label|client|location|date/i.test(JSON.stringify(patches[0].course_equipment)));
assert.strictEqual(patches[0].guest_name,'Private Multi Guest');
assert.strictEqual(patches[0].date_from,'2026-08-10');
assert.strictEqual(patches[0].components.private_lesson.surfer_count,3);
assert(Array.isArray(patches[0].components.private_lesson.sessions));
assert(quotes.length<=q0+1,`unbounded quotes ${q0}->${quotes.length}`);
// Canonical detail readback/reopen preserves exact array.
if(await page.locator('#ps-drawer-close').count())await page.locator('#ps-drawer-close').click();
await row.click();await page.locator('#ps-drawer-edit').click();await field.waitFor({state:'visible'});
items=field.locator('.portal-schedule-course-equipment-item');
assert.strictEqual(await items.nth(0).locator('[data-drawer-course-equipment-mode="all_day"]').getAttribute('aria-pressed'),'true');
assert.strictEqual(await items.nth(0).locator('[data-course-equipment-quantity]').inputValue(),'1');
assert.strictEqual(await items.nth(1).locator('input[type=checkbox]').isChecked(),true);
assert.strictEqual(await items.nth(1).locator('[data-drawer-course-equipment-mode="during_course"]').getAttribute('aria-pressed'),'true');
// Keyboard/aria + mobile widths while edit form is still mounted.
assert(!/schedule\.courseEquipment\./.test(await field.innerText()),'edit equipment labels resolved');
assert.strictEqual(await items.nth(0).locator('.portal-schedule-course-equipment-modes').getAttribute('role'),'group');
await items.nth(0).locator('input[type=checkbox]').focus();await page.keyboard.press('Space');await page.keyboard.press('Space');
assert.strictEqual(await items.nth(0).locator('[data-drawer-course-equipment-mode]').first().getAttribute('aria-pressed'),'true');
for(const width of [320,375,390,430]){
  await page.setViewportSize({width,height:900});
  const x=await field.evaluate(n=>({overflow:n.scrollWidth>n.clientWidth+1,h:[...n.querySelectorAll('button,input[type=number],label.portal-schedule-course-equipment-check')].filter(x=>x.offsetParent).map(x=>x.getBoundingClientRect().height)}));
  assert(!x.overflow,`${width}px overflow`);assert(x.h.every(h=>h>=44),`${width}px target ${x.h}`);
}
await page.setViewportSize({width:1280,height:900});
// EN/ES/IT dictionary coverage via window.t (setStaffLocale remounts; avoid while form open).
for(const locale of ['en','es','it']){
  const text=await page.evaluate(l=>{const prev=localStorage.getItem('wh_staff_portal_locale');localStorage.setItem('wh_staff_portal_locale',l);const out=['schedule.courseEquipment.during','schedule.courseEquipment.allDay','schedule.courseEquipment.quantity','schedule.courseEquipment.unavailable','schedule.courseEquipment.title'].map(k=>window.t(k));if(prev!=null)localStorage.setItem('wh_staff_portal_locale',prev);else localStorage.removeItem('wh_staff_portal_locale');return out.join('|');},locale);
  assert(!/schedule\.courseEquipment\./.test(text),locale+' labels resolved: '+text);
}
// Zero configured Private options hides the section (no historical).
activeOptions=[];equipment=[];
await page.reload();await page.waitForFunction(()=>document.querySelector('#c-client')?.value==='sunset');
await row.waitFor();await row.click();await page.locator('#ps-drawer-edit').click();
assert.strictEqual(await page.locator('#ps-drawer-course-equipment:visible').count(),0,'zero options hidden');
// Historical selected identity no longer active: unavailable/removable, not newly selectable; label from detail only.
activeOptions=[{offering_key:'carbon_fins',label:'Carbon fins'}];
equipment=[{offering_key:'retired_fins',mode:'during_course',quantity:2,label:'Retired fins'},{offering_key:'carbon_fins',mode:'all_day',quantity:1}];
await page.reload();await page.waitForFunction(()=>document.querySelector('#c-client')?.value==='sunset');
await row.waitFor();await row.click();await page.locator('#ps-drawer-edit').click();
const liveField=page.locator('#ps-drawer-course-equipment');await liveField.waitFor({state:'visible'});
items=liveField.locator('.portal-schedule-course-equipment-item');
assert.strictEqual(await items.count(),2);
const retired=liveField.locator('.portal-schedule-course-equipment-item[data-offering-key="retired_fins"]');
assert.strictEqual(await retired.count(),1);
assert.ok(await retired.evaluate(n=>n.classList.contains('is-unavailable')));
assert.strictEqual(await retired.locator('.portal-schedule-course-equipment-name').innerText(),'Retired fins');
assert.strictEqual(await retired.locator('input[type=checkbox]').isChecked(),true);
// Uncheck historical; do not allow re-select.
await retired.locator('input[type=checkbox]').uncheck();
assert.strictEqual(await retired.locator('input[type=checkbox]').isEnabled(),false);
// Empty-identity historical singleton: removable display, never submitted with empty identity.
equipment=[{offering_key:'',mode:'during_course',quantity:2}];
activeOptions=options.slice();
await page.reload();await page.waitForFunction(()=>document.querySelector('#c-client')?.value==='sunset');
await row.waitFor();await row.click();await page.locator('#ps-drawer-edit').click();
const legacyField=page.locator('#ps-drawer-course-equipment');await legacyField.waitFor({state:'visible'});
const legacy=legacyField.locator('.portal-schedule-course-equipment-item[data-legacy-empty="1"], .portal-schedule-course-equipment-item[data-offering-key=""]').first();
assert.strictEqual(await legacy.count(),1);
assert.ok(await legacy.evaluate(n=>n.classList.contains('is-unavailable')||n.getAttribute('data-legacy-empty')==='1'));
await legacy.locator('input[type=checkbox]').uncheck();
await legacyField.locator('.portal-schedule-course-equipment-item[data-offering-key="carbon_fins"] input[type=checkbox]').check();
patches.length=0;await page.locator('#ps-drawer-save').click();await page.waitForTimeout(500);
assert.strictEqual(patches.length,1);
assert.deepStrictEqual(patches[0].course_equipment,[{offering_key:'carbon_fins',mode:'during_course',quantity:3}]);
assert(patches[0].course_equipment.every(x=>String(x.offering_key||'').trim()),'never empty identity');
assert.deepStrictEqual(errors,[]);
console.log('PASS focused generated Schedule Edit Private multi-item course-equipment contract');
}finally{await browser.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exit(1);});
