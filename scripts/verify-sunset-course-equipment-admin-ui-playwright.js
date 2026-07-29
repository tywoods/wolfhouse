'use strict';
/** Browser proof: UI markup/scripts/CSS come only from generated /staff/ui. */
const fs=require('fs');
process.env.STAFF_AUTH_REQUIRED='false';process.env.STAFF_AUTH_ALLOW_OPEN='true';process.env.NODE_ENV='test';
const assert=require('assert');
function pw(){try{return require('playwright');}catch(e){return require('/opt/data/workspaces/wolfhouse-grok/node_modules/playwright');}}
const listen=s=>new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${s.address().port}`));});
(async()=>{
 const {createSunsetAdminVerifyServer}=require('./fixtures/sunset-admin-verify-server');const server=createSunsetAdminVerifyServer(),base=await listen(server),browser=await pw().chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1280,height:900}});
 const errors=[],packWrites=[],privateWrites=[];
 let pack={pack_id:'verify-demo-pack',label:'Group',age_band:'12_and_up',group_size:8,beaches:['somo'],weekly:'mon_fri',schedules:['0930_1130'],price_tiers:[],equipment_options:[]};
 let privateLesson={enabled:true,label:'Private',amount_cents:5000,currency:'EUR',price_basis:'per_session',default_duration_minutes:120,notes:'draft',equipment_options:[{offering_key:'retired_board',equipment_price_cents:0,all_day_surcharge_cents:250}]};
 // Catalog identities are arbitrary — no Surfboard/Wetsuit hardcoding. XSS label proves escaping.
 const offerings=[
  {offering_key:'softboard',label:'Soft <img src=x onerror=alert(1)> board',active:true},
  {offering_key:'wetsuit',label:'Wetsuit (no price row)',active:true},
  {offering_key:'carbon_fins',label:'Carbon fins',active:true},
  {offering_key:'retired_board',label:'Retired board',active:false},
 ];
 page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{localStorage.setItem('staff_portal_client','sunset');localStorage.setItem('staff_portal_sunset_location','sunset-somo');localStorage.setItem('wh_staff_portal_locale','en');});
 await page.route('**/staff/admin/config?**',async r=>{const x=await r.fetch(),b=await x.json();b.surf_packs=[pack];b.private_lesson=privateLesson;await r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(b)});});
 await page.route('**/staff/admin/config/rental-offerings?**',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,offerings})}));
 await page.route('**/staff/admin/config/surf-packs/verify-demo-pack?**',r=>{const b=JSON.parse(r.request().postData());packWrites.push(b);pack={...pack,...b};return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,surf_pack:pack})});});
 await page.route('**/staff/admin/config/private-lesson?**',r=>{const b=JSON.parse(r.request().postData());privateWrites.push(b);privateLesson={...privateLesson,...b};return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,private_lesson:privateLesson})});});
 try{
  await page.goto(base+'/staff/ui');await page.waitForFunction(()=>document.querySelector('#c-client')?.value==='sunset');await page.locator('button[data-tab="admin"]').click();await page.locator('#admin-tab-pricing').click();await page.locator('#admin-course-equipment-title').waitFor();
  assert.strictEqual((await page.locator('#admin-course-equipment-title').textContent()).trim(),'Equipment + Price');

  // ── Read-only Group / Private card Equipment section ──
  const packCard=page.locator('[data-admin-pack-card="verify-demo-pack"]');
  const privateCard=page.locator('[data-admin-private-lesson-card]');
  const packEq=packCard.locator('[data-admin-equipment-readout]');
  const privEq=privateCard.locator('[data-admin-equipment-readout]');
  assert.strictEqual(await packEq.count(),1,'Group card must expose Equipment section');
  assert.strictEqual(await privEq.count(),1,'Private card must expose Equipment section');
  assert.strictEqual((await packEq.locator('.portal-admin-pill-label').textContent()).trim(),'Equipment');
  assert.strictEqual((await privEq.locator('.portal-admin-pill-label').textContent()).trim(),'Equipment');
  // Empty pack: section visible with localized empty state (not hidden, no invented defaults)
  assert.strictEqual(await packEq.locator('[data-equipment-readout-row]').count(),0);
  assert.strictEqual(await packEq.locator('[data-admin-equipment-empty]').count(),1);
  assert.ok(/no equipment/i.test(await packEq.innerText()),'pack empty state text');
  // Private: historical inactive key fallback, zero => Included, nonzero EUR format
  assert.strictEqual(await privEq.locator('[data-equipment-readout-row="retired_board"]').count(),1);
  const privText=await privEq.innerText();
  assert.ok(privText.includes('retired_board'),'inactive catalog falls back to stored key');
  assert.ok(!privText.includes('Retired board'),'inactive offering label must not be used');
  assert.ok(privText.includes('Included'),'zero equipment_price_cents => Included');
  assert.ok(privText.includes('2.50'),'nonzero all_day_surcharge_cents EUR format');
  assert.ok(!/\b0(?:\.00)?\b/.test(privText.replace(/2\.50/g,'')) && !/€0/.test(privText),'zero must not render as 0 / 0.00 / €0');

  await page.locator('[data-admin-action="edit-pack"]').click();let ed=page.locator('[data-admin-pack-form] [data-admin-equipment-editor]');assert.strictEqual((await ed.locator('h4').textContent()).trim(),'Equipment');assert.strictEqual(await ed.locator('[data-equipment-option-row]').count(),0);
  await ed.locator('[data-admin-action="add-equipment-option"]').click();let row=ed.locator('[data-equipment-option-row]').first();assert.strictEqual(await row.locator('option',{hasText:'Wetsuit (no price row)'}).count(),1);await row.locator('select').selectOption('softboard');await row.locator('.admin-equipment-price').fill('5');await row.locator('.admin-equipment-surcharge').fill('0');await page.locator('[data-admin-action="save-pack"]').click();await page.waitForTimeout(100);
  assert.deepStrictEqual(packWrites[0].equipment_options,[{offering_key:'softboard',equipment_price_cents:500,all_day_surcharge_cents:0}]);assert(!('equipment_included'in packWrites[0])&&!('equipment_price_cents'in packWrites[0]));

  // After save: Group card shows catalog label (escaped), nonzero equipment price, Included all-day
  const packEqAfter=page.locator('[data-admin-pack-card="verify-demo-pack"] [data-admin-equipment-readout]');
  assert.strictEqual(await packEqAfter.locator('[data-admin-equipment-empty]').count(),0);
  assert.strictEqual(await packEqAfter.locator('[data-equipment-readout-row="softboard"]').count(),1);
  const packText=await packEqAfter.innerText();
  assert.ok(packText.includes('Soft <img src=x onerror=alert(1)> board'),'resolved active catalog label as text');
  assert.strictEqual(await packEqAfter.locator('img').count(),0,'label HTML must be escaped');
  assert.ok(packText.includes('5.00'),'nonzero equipment_price_cents EUR format');
  assert.ok(packText.includes('Included'),'zero all_day_surcharge_cents => Included');
  assert.ok(!/€0|\b0\.00\b/.test(packText.replace(/5\.00/g,'')),'zero surcharge must not render as 0.00/€0');

  await page.locator('[data-admin-action="edit-pack"]').click();ed=page.locator('[data-admin-pack-form] [data-admin-equipment-editor]');assert.strictEqual(await ed.locator('select').inputValue(),'softboard');assert.strictEqual(await ed.locator('.admin-equipment-price').inputValue(),'5.00');assert.strictEqual(await ed.locator('.admin-equipment-surcharge').inputValue(),'0.00');await ed.locator('[data-admin-action="add-equipment-option"]').click();assert.strictEqual(await ed.locator('[data-equipment-option-row]').nth(1).locator('option[value="softboard"]').getAttribute('disabled'),'');await ed.locator('[data-equipment-option-row]').nth(1).locator('[data-admin-action="remove-equipment-option"]').click();
  // Add second arbitrary identity (carbon_fins) to prove multi-item + no fixed ordering identity
  await ed.locator('[data-admin-action="add-equipment-option"]').click();await ed.locator('[data-equipment-option-row]').nth(1).locator('select').selectOption('carbon_fins');await ed.locator('[data-equipment-option-row]').nth(1).locator('.admin-equipment-price').fill('0');await ed.locator('[data-equipment-option-row]').nth(1).locator('.admin-equipment-surcharge').fill('1.25');await page.locator('[data-admin-action="save-pack"]').click();await page.waitForTimeout(100);
  assert.deepStrictEqual(packWrites[1].equipment_options,[
   {offering_key:'softboard',equipment_price_cents:500,all_day_surcharge_cents:0},
   {offering_key:'carbon_fins',equipment_price_cents:0,all_day_surcharge_cents:125},
  ]);
  const multiText=await page.locator('[data-admin-pack-card="verify-demo-pack"] [data-admin-equipment-readout]').innerText();
  assert.ok(multiText.includes('Carbon fins')&&multiText.includes('1.25')&&multiText.includes('Included'));
  assert.ok(!/Surfboard|Wetsuit/.test(multiText)||multiText.includes('Wetsuit (no price row)')===false,'no hardcoded Surfboard/Wetsuit card identities');

  await page.locator('[data-admin-action="edit-private-lesson"]').click();ed=page.locator('[data-admin-private-lesson-form] [data-admin-equipment-editor]');assert.strictEqual((await ed.locator('h4').textContent()).trim(),'Equipment');assert((await ed.innerText()).includes('Unavailable'));await ed.locator('[data-admin-action="remove-equipment-option"]').click();await page.locator('[data-admin-action="save-private-lesson"]').click();await page.waitForTimeout(100);assert.deepStrictEqual(privateWrites[0].equipment_options,[]);assert.strictEqual(privateWrites[0].notes,'draft');
  // Private empty state after clearing options
  const privEmpty=page.locator('[data-admin-private-lesson-card] [data-admin-equipment-readout]');
  assert.strictEqual(await privEmpty.locator('[data-admin-equipment-empty]').count(),1);
  assert.ok(/no equipment/i.test(await privEmpty.innerText()));

  for(const width of [320,375,430]){await page.setViewportSize({width,height:900});await page.locator('[data-admin-action="edit-private-lesson"]').click();ed=page.locator('[data-admin-private-lesson-form] [data-admin-equipment-editor]');await ed.locator('[data-admin-action="add-equipment-option"]').click();assert(!(await ed.evaluate(x=>document.documentElement.scrollWidth>document.documentElement.clientWidth||x.scrollWidth>x.clientWidth+1)));assert((await ed.locator('button,select,input').evaluateAll(xs=>xs.every(x=>x.getBoundingClientRect().height>=44))));await page.locator('[data-admin-action="cancel-edit"]').click();}
  assert.deepStrictEqual(errors,[]);console.log('PASS generated /staff/ui Group + Private equipment editor + card readout browser contract');
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exit(1);});
