'use strict';
/** Focused browser contract: production-generated Schedule Edit Group multi-item equipment. */
const assert=require('assert'),fs=require('fs');
process.env.STAFF_AUTH_REQUIRED='false';process.env.STAFF_AUTH_ALLOW_OPEN='true';process.env.NODE_ENV='test';
function pw(){try{return require('playwright');}catch(e){return require('/opt/data/workspaces/wolfhouse-grok/node_modules/playwright');}}
const listen=s=>new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${s.address().port}`));});
(async()=>{const {createSunsetAdminVerifyServer}=require('./fixtures/sunset-admin-verify-server');const server=createSunsetAdminVerifyServer(),base=await listen(server),browser=await pw().chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1280,height:900}}),patches=[],quotes=[],errors=[];const id='11111111-1111-1111-1111-111111111111';let equipment=[{offering_key:'carbon_fins',mode:'during_course',quantity:4},{offering_key:'reef_helmet',mode:'all_day',quantity:2},{offering_key:'retired_kit',mode:'during_course',quantity:1,label:'Retired kit'}];
const detail=()=>({success:true,booking_id:id,booking_code:'EDIT-MULTI',guest_name:'Retained Guest',phone:'+341234',date_from:'2026-08-10',date_to:'2026-08-14',notes:'retained',payment_status:'unpaid',components:{course:{course_id:'group-multi',tier_key:'5_days',quantity:4,course_label:'Retained Group'}},course_equipment:equipment,rentals:[],payment:{subtotal_cents:0,paid_cents:0,balance_due_cents:0,line_items:[]}});
page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{localStorage.setItem('staff_portal_client','sunset');localStorage.setItem('staff_portal_sunset_location','sunset-somo');localStorage.setItem('wh_staff_portal_locale','en');});
await page.route('**/staff/schedule/bookings/catalog?**',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,courses:[{course_id:'group-multi',label:'Retained Group',eligible_on_requested_dates:true,equipment_options:[{offering_key:'carbon_fins',label:'Carbon fins'},{offering_key:'reef_helmet',label:'Reef helmet'}],price_tiers:[{key:'5_days',label:'5 days',duration_days:5,bookable:true,offering_id:'surf_pack_group-multi__5_days'}]}],rentals:[]})}));
await page.route('**/staff/schedule/bookings/detail?**',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(detail())}));
await page.route('**/staff/schedule/bookings/quote?**',r=>{quotes.push(JSON.parse(r.request().postData()||'{}'));return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,total_cents:0,subtotal_cents:0,line_items:[]})});});
await page.route('**/staff/schedule/bookings?**',r=>{if(r.request().method()!=='PATCH')return r.continue();const body=JSON.parse(r.request().postData()||'{}');patches.push(body);equipment=body.course_equipment;return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,context:detail()})});});
await page.route('**/staff/schedule/day?**',r=>{const date=new URL(r.request().url()).searchParams.get('date');return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,date,lessons:[],gear:[],rows:[{booking_id:id,booking_code:'EDIT-MULTI',guest_name:'Retained Guest',record_source:'staff_manual',service_date:date,service_time_local:'10:00',service_type:'surf_lesson',offering_label:'Retained Group',metadata:{component:'lesson',course_id:'group-multi'},quantity:4,payment_status:'unpaid',booking_status:'confirmed',status:'confirmed'}]})});});
try{await page.goto(base+'/staff/ui');await page.waitForFunction(()=>document.querySelector('#c-client')?.value==='sunset');const row=page.locator('[data-ps-booking-id]').filter({hasText:'Retained Guest'}).first();await row.waitFor();await row.click();await page.locator('#ps-drawer-edit').click();const field=page.locator('#ps-drawer-course-equipment');await field.waitFor({state:'visible'});let items=field.locator('.portal-schedule-course-equipment-item');assert.strictEqual(await items.count(),3);assert.deepStrictEqual(await items.locator('.portal-schedule-course-equipment-name').allTextContents(),['Carbon fins','Reef helmet','Retired kit']);assert.strictEqual(await items.nth(0).locator('input[type=checkbox]').isChecked(),true);assert.strictEqual(await items.nth(1).locator('input[type=checkbox]').isChecked(),true);assert.strictEqual(await items.nth(2).locator('input[type=checkbox]').isChecked(),true);assert.strictEqual(await items.nth(2).evaluate(el=>el.classList.contains('is-unavailable')),true);assert.strictEqual(await items.nth(0).locator('[data-drawer-course-equipment-mode="during_course"]').getAttribute('aria-pressed'),'true');assert.strictEqual(await items.nth(1).locator('[data-drawer-course-equipment-mode="all_day"]').getAttribute('aria-pressed'),'true');assert.strictEqual(await items.nth(0).locator('[data-course-equipment-quantity]').inputValue(),'4');assert.strictEqual(await items.nth(1).locator('[data-course-equipment-quantity]').inputValue(),'2');
// During quantity must track participant count (not stale hidden sets input).
await page.locator('#ps-drawer-course-qty').fill('3');await page.locator('#ps-drawer-course-qty').dispatchEvent('change');
await page.waitForFunction(()=>!document.querySelector('.portal-schedule-quote-checking'));
items=field.locator('.portal-schedule-course-equipment-item');
assert.strictEqual(await items.nth(0).locator('[data-course-equipment-quantity]').inputValue(),'3','during qty tracks surfers after decrease');
assert.strictEqual(await items.nth(1).locator('[data-course-equipment-quantity]').inputValue(),'2','all-day set qty retained when surfers drop to still-valid');
await page.locator('#ps-drawer-course-qty').fill('5');await page.locator('#ps-drawer-course-qty').dispatchEvent('change');
await page.waitForFunction(()=>!document.querySelector('.portal-schedule-quote-checking'));
items=field.locator('.portal-schedule-course-equipment-item');
assert.strictEqual(await items.nth(0).locator('[data-course-equipment-quantity]').inputValue(),'5','during qty tracks surfers after increase');
assert.strictEqual(await items.nth(1).locator('[data-course-equipment-quantity]').inputValue(),'2','all-day set qty not forced to surfers');
// Also prove During payload tracks surfers after increase (no all-day switch).
await items.nth(1).locator('input[type=checkbox]').uncheck();
await items.nth(2).locator('input[type=checkbox]').uncheck();
const q0=quotes.length;await page.locator('#ps-drawer-save').click();await page.waitForTimeout(500);assert.strictEqual(patches.length,1);
assert.deepStrictEqual(patches[0].course_equipment,[{offering_key:'carbon_fins',mode:'during_course',quantity:5}],'during payload quantity must equal surfers after increase');
assert(!/cents|label|client|location|date/i.test(JSON.stringify(patches[0].course_equipment)));assert.strictEqual(patches[0].guest_name,'Retained Guest');assert.strictEqual(patches[0].date_from,'2026-08-10');assert.strictEqual(patches[0].components.course.course_id,'group-multi');assert.strictEqual(patches[0].components.course.quantity,5);assert(quotes.length<=q0+1,`unbounded quotes ${q0}->${quotes.length}`);
// Reopen and prove All Day set quantity + historical removal still work on a clean edit mount.
if(await page.locator('#ps-drawer-close').count())await page.locator('#ps-drawer-close').click();await row.click();await page.locator('#ps-drawer-edit').click();await field.waitFor({state:'visible'});
items=field.locator('.portal-schedule-course-equipment-item');
await items.nth(0).locator('[data-drawer-course-equipment-mode="all_day"]').click();
await items.nth(0).locator('.portal-schedule-course-equipment-sets').waitFor({state:'visible'});
await items.nth(0).locator('[data-course-equipment-quantity]').fill('3');
await items.nth(1).locator('input[type=checkbox]').uncheck();
if(await items.count()>2) await items.nth(2).locator('input[type=checkbox]').uncheck();
await page.locator('#ps-drawer-save').click();await page.waitForTimeout(500);
assert.strictEqual(patches.length,2);
assert.deepStrictEqual(patches[1].course_equipment,[{offering_key:'carbon_fins',mode:'all_day',quantity:3}]);
if(await page.locator('#ps-drawer-close').count())await page.locator('#ps-drawer-close').click();await row.click();await page.locator('#ps-drawer-edit').click();await field.waitFor({state:'visible'});items=field.locator('.portal-schedule-course-equipment-item');assert.strictEqual(await items.nth(0).locator('[data-drawer-course-equipment-mode="all_day"]').getAttribute('aria-pressed'),'true');assert.strictEqual(await items.nth(0).locator('[data-course-equipment-quantity]').inputValue(),'3');assert.strictEqual(await items.nth(1).locator('input[type=checkbox]').isChecked(),false);assert.deepStrictEqual(errors,[]);console.log('PASS focused generated Schedule Edit Group multi-item course-equipment contract');
}finally{await browser.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exit(1);});
