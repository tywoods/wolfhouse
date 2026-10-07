'use strict';
// Ordinary emitted /staff/ui; synthetic network fixtures. SQL is proved separately.
const fs=require('fs'),path=require('path'),Module=require('module'),assert=require('node:assert/strict');
const file=path.join(__dirname,'verify-staff-collapsed-sections.js'),src=fs.readFileSync(file,'utf8'),m=new Module(file,module);m.filename=file;m.paths=module.paths;
m._compile(src.slice(0,src.indexOf('(async () => {'))+'\nmodule.exports={setup,settings,shot,check,report,fixtures};',file);
const {setup,settings,shot,check,report,fixtures}=m.exports;
const OUT=path.resolve(process.argv[2]||'artifacts/staff-polish-room-page');
(async()=>{const browser=await require('playwright').chromium.launch({headless:true});
try{for(const width of [390,1280])for(const theme of ['light','dark']){
 const tag=`${width}-${theme}`,{context,page}=await setup(browser,tag,'wolfhouse-somo',width,theme);
 const saved=structuredClone(fixtures('wolfhouse-somo')['/staff/luna-intelligence/room-fill']);
 saved.catalogue.forEach((room,i)=>{room.genderEditable=i===0;room.genderLabel='Mixed';room.genderEditNote=i?'Read-only: private/couple/operator restrictions are preserved.':null;});
 const writes=[];let rejected=false;
 await context.route('**/staff/luna-intelligence/room-fill**',async route=>{
  const r=route.request(),u=new URL(r.url());
  if(r.method()==='GET')return route.fulfill({json:saved});
  const body=r.postDataJSON();writes.push({method:r.method(),path:u.pathname,body});
  if(u.pathname.endsWith('/gender')){
   if(rejected)return route.fulfill({status:409,json:{success:false,error:'catalogue_changed'}});
   saved.catalogue[0].genderLabel=body.gender[0].toUpperCase()+body.gender.slice(1);saved.catalogRevision='c'.repeat(64);
   return route.fulfill({json:saved});
  }
  if(u.pathname.endsWith('/preview'))return route.fulfill({json:{success:true,mode:body.draftPolicy.fillMode,source:'draft',decision:{status:'placed',selected:[{roomCode:'Room 1',beds:Array.from({length:body.partySize},(_,i)=>({bedCode:'Fixture B'+(i+1)}))}],rationale:[{text:'Synthetic presentation fixture; not availability evidence.'}],rooms:[]}}});
  saved.policy={...saved.policy,fillMode:body.fillMode,roomPriority:body.roomPriority};return route.fulfill({json:saved});
 });
 try{
  await page.reload();await settings(page);await page.locator('#staff-room-setup-toggle').click();await page.locator('.rf-row').first().waitFor();
  const gender=page.getByRole('combobox',{name:'Gender for Room 1',exact:true});
  check(tag,'only ordinary room has gender editor',await page.locator('.rf-gender-edit select').count()===1);
  check(tag,'special room displays explanatory note',await page.locator('#staff-room-fill').getByText('Read-only: private/couple/operator restrictions are preserved.').count()===1);
  await gender.selectOption('female');await page.locator('#staff-room-setup-toggle').click();await page.locator('#staff-room-setup-toggle').click();
  check(tag,'disclosure preserves gender draft without writes',await gender.inputValue()==='female'&&writes.length===0);
  rejected=true;await page.getByRole('button',{name:'Save gender for Room 1',exact:true}).click();await page.locator('.rf-gender-status').filter({hasText:'catalogue_changed'}).waitFor();
  check(tag,'rejected gender save remains visible and draft retained',await gender.inputValue()==='female'&&await page.locator('.rf-gender-status').filter({hasText:'catalogue_changed'}).isVisible());
  rejected=false;await page.getByRole('button',{name:'Save gender for Room 1',exact:true}).click();await page.locator('.rf-gender-status').filter({hasText:'Saved'}).waitFor();
  assert.deepEqual(Object.keys(writes.at(-1).body).sort(),['expectedCatalogRevision','gender']);
  await page.reload();await settings(page);await page.locator('#staff-room-setup-toggle').click();await gender.waitFor();
  check(tag,'ordinary page reload reads saved gender fixture',await gender.inputValue()==='female');
  const geom=await page.locator('.rf-modes label').evaluateAll(ns=>ns.map(n=>({width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})));
  check(tag,'compact native mode controls fit page',geom.every(g=>g.width<180&&g.height===(width===390?44:32)),geom);
  const down=page.getByRole('button',{name:'Move Room 1 down',exact:true});const start=await page.locator('.rf-row').evaluateAll(ns=>ns.map(n=>n.dataset.roomId));const before=writes.length;
  await down.focus();await page.keyboard.press('Enter');check(tag,'arrow reorders draft without write',await page.locator('.rf-row').first().getAttribute('data-room-id')===start[1]&&writes.length===before);
  await page.locator('#staff-room-fill-save').click();await page.waitForFunction(()=>!document.getElementById('staff-room-fill-save').disabled);
  check(tag,'explicit save contains visible order',JSON.stringify(writes.at(-1).body.roomPriority)===JSON.stringify(start.slice().reverse()));
  await page.locator('[name="checkIn"]').fill('2027-04-01');await page.locator('[name="checkOut"]').fill('2027-04-03');
  for(const n of [2,3,6,9]){
   await page.locator('[name="partySize"]').fill(String(n));await page.locator('#rf-preview-run').click();await page.locator('.rf-preview-room .rf-pebble').nth(n-1).waitFor();
   check(tag,'preview '+n+' sends visible draft and renders grouped bed chips',writes.at(-1).body.partySize===n&&writes.at(-1).body.policySource==='draft'&&await page.locator('.rf-preview-room .rf-pebble').count()===n);
  }
  await shot(page,tag,'room-setup-preview','#staff-room-fill-preview-out');
  check(tag,'no horizontal page overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 }finally{await context.close();}
}}
catch(e){report.checks.push({tag:'exception',name:e.stack,ok:false});}
finally {
 await browser.close();
 report.failures=report.checks.filter(c=>!c.ok);
 // The existing emitted page requests this exact optional font stylesheet.
 // It remains blocked offline; screenshots use fallback fonts. No external
 // request is forwarded, and every other unknown/external request fails.
 const optionalFont='https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=Instrument+Sans:wght@400;500;600;700&display=swap';
 report.expectedFontBlocks=report.requests.filter(r=>r.disposition==='external-blocked'&&r.method==='GET'&&r.url===optionalFont);
 report.unexpected=report.requests.filter(r=>(r.disposition==='unexpected-blocked'||r.disposition==='external-blocked')&&!report.expectedFontBlocks.includes(r));
 report.verdict=report.failures.length||report.pageErrors.length||report.unexpected.length?'FAIL':'PASS';
 fs.mkdirSync(OUT,{recursive:true});
 fs.writeFileSync(path.join(OUT,'ordinary-room-results.json'),JSON.stringify(report,null,2));
 console.log(report.verdict,JSON.stringify({failures:report.failures,pageErrors:report.pageErrors,unexpected:report.unexpected}));
 if(report.verdict!=='PASS')process.exitCode=1;
}
})();
