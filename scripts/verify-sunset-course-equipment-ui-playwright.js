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
 const errors=[], patches=[]; let saved=JSON.parse(JSON.stringify(initial)), pending=null;
 page.on('pageerror',e=>errors.push('page:'+e.message)); page.on('console',m=>{if(m.type()==='error')errors.push('console:'+m.text());});
 await context.addInitScript(()=>{localStorage.setItem('staff_portal_client','sunset');localStorage.setItem('staff_portal_sunset_location','sunset-somo');localStorage.setItem('wh_staff_portal_locale','en');});
 await page.route('**/staff/admin/config?**',async route=>{const req=route.request();if(req.method()==='GET'){const response=await route.fetch();const body=await response.json();body.course_equipment_pricing=saved;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});} return route.continue();});
 await page.route('**/staff/admin/config/course-equipment?**',async route=>{patches.push(JSON.parse(route.request().postData()||'{}'));if(pending){pending.push(route);return;}saved=patches.at(-1);return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,course_equipment_pricing:saved})});});
 try{
  await page.goto(base+'/staff/ui',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('#c-client')?.value==='sunset'&&!document.body.classList.contains('portal-profile-pending'));
  await page.locator('button.tab-btn[data-tab="admin"]').click(); await page.locator('#admin-tab-pricing').click(); await page.locator('[data-admin-course-equipment]').waitFor();
  const order=await page.evaluate(()=>{const a=document.querySelector('[data-admin-course-equipment]'),p=a?.previousElementSibling;return {previous:(p?.textContent||'').trim(),inputs:a?.querySelectorAll('input[type=number]').length,radios:a?.querySelectorAll('input[type=radio]').length};});
  ok('section is immediately below Private Courses',/Private/i.test(order.previous),order.previous); eq('four separate price inputs',order.inputs,4); eq('Free/Extra are native radios',order.radios,2);
  const ids=['admin-course-during-board','admin-course-during-suit','admin-course-all-day-board','admin-course-all-day-suit'];
  eq('canonical GET seeds all four values',(await Promise.all(ids.map(id=>page.locator('#'+id).inputValue()))).join(','),'600,400,1200,800');
  await page.locator('input[value="free_with_course"]').check(); ok('Free disables during-course prices',await page.locator('#admin-course-during-board').isDisabled()&&await page.locator('#admin-course-during-suit').isDisabled());
  await page.locator('input[value="extra"]').check(); ok('Extra enables during-course prices',!await page.locator('#admin-course-during-board').isDisabled());
  for(let i=0;i<4;i++)await page.locator('#'+ids[i]).fill(String([701,402,1303,804][i]));
  await page.locator('[data-admin-action="save-course-equipment"]').click(); await page.waitForFunction(()=>document.querySelector('[data-admin-action="save-course-equipment"]')&&!document.querySelector('[data-admin-action="save-course-equipment"]').disabled);
  eq('save sends exactly one PATCH',patches.length,1); eq('PATCH is policy + four backend-unit prices',JSON.stringify(patches[0]),JSON.stringify({during_course:{policy:'extra',surfboard_cents:701,wetsuit_cents:402},all_day:{surfboard_cents:1303,wetsuit_cents:804}}));
  await page.locator('button.tab-btn[data-tab="admin"]').click(); await page.locator('#admin-tab-pricing').click(); await page.locator('[data-admin-course-equipment]').waitFor(); eq('production GET reloads canonical save',await page.locator('#admin-course-all-day-board').inputValue(),'1303');
  for(const locale of ['en','es','it']){await page.evaluate(l=>window.setStaffLocale(l),locale);await page.locator('button.tab-btn[data-tab="admin"]').click();await page.locator('#admin-tab-pricing').click();await page.locator('[data-admin-course-equipment]').waitFor();const t=await page.locator('[data-admin-course-equipment]').innerText();ok(locale.toUpperCase()+' localized section has no raw key',!t.includes('admin.courseEquipment.'),t);}
  await page.locator('input[value="free_with_course"]').focus();await page.keyboard.press('ArrowRight');eq('radio keyboard changes to Extra',await page.locator('input[name="admin-course-equipment-policy"]:checked').getAttribute('value'),'extra');
  for(const width of [320,375,390,430]){await page.setViewportSize({width,height:900});const layout=await page.locator('[data-admin-course-equipment]').evaluate(el=>({overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth||el.scrollWidth>el.clientWidth+1,targets:[...el.querySelectorAll('button,input[type="number"],label.portal-admin-touch')].map(x=>x.getBoundingClientRect().height)}));ok(width+'px no horizontal overflow',!layout.overflow,JSON.stringify(layout));ok(width+'px controls are 44px targets',layout.targets.every(h=>h>=44),JSON.stringify(layout.targets));}
  pending=[];await page.locator('[data-admin-action="save-course-equipment"]').click();await page.locator('[data-admin-action="save-course-equipment"]').click();await sleep(50);eq('in-flight double click creates one request',pending.length,1);await pending[0].fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,course_equipment_pricing:saved})});pending=null;
  eq('no page or console errors',errors.join('|'),'');
 }finally{await context.close();await browser.close();await close(server);}
 console.log(`\nverify:sunset-course-equipment-ui-playwright — ${pass} passed, ${fail} failed`);if(fail)process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1);});
