'use strict';
const fs=require('fs'),path=require('path'),Module=require('module'),assert=require('node:assert/strict');
const {fixture}=require('./verify-room-selling-mode');
const file=path.join(__dirname,'verify-staff-collapsed-sections.js'),src=fs.readFileSync(file,'utf8'),m=new Module(file,module);m.filename=file;m.paths=module.paths;
m._compile(src.slice(0,src.indexOf('(async () => {'))+'\nmodule.exports={setup,settings,report};',file);
const {setup,settings,report}=m.exports;
const OUT=path.resolve(process.argv[2]||'/tmp/room-selling-page');
(async()=>{const browser=await require('playwright').chromium.launch({headless:true});const writes=[];
try {for(const width of [390,1280])for(const theme of ['light','dark']){
 const tag=`${width}-${theme}`,f=await fixture(path.join(OUT,tag));
 const {context,page}=await setup(browser,tag,'wolfhouse-somo',width,theme);
 await context.route('**/staff/luna-intelligence/room-fill**',async route=>{
  const r=route.request(),u=new URL(r.url());
  if(r.method()==='GET'&&u.pathname==='/staff/luna-intelligence/room-fill')return route.fulfill({json:await f.get()});
  if(r.method()==='PUT'&&u.pathname.endsWith('/gender')){const body=r.postDataJSON();const result=await f.put(body);writes.push({tag,path:u.pathname,body,status:result.status});return route.fulfill({status:result.status,json:result.body});}
  report.requests.push({url:r.url(),method:r.method(),disposition:'unexpected-blocked'});return route.abort();
 });
 try {
  const open=async()=>{await page.reload();await settings(page);await page.locator('#staff-room-setup-toggle').click();await page.locator('.rf-row').first().waitFor();};
  await open();
  const mode=page.getByRole('combobox',{name:'Selling mode for Room 1',exact:true});
  assert.equal(await mode.count(),1,'ordinary emitted room row must expose native selling-mode dropdown');
  const gender=page.getByRole('combobox',{name:'Gender for Room 1',exact:true});
  assert.equal(await mode.inputValue(),'shared');
  for(const value of ['private','private_optional','shared']){
   await mode.selectOption(value);
   assert.equal(await gender.isDisabled(),value==='private','gender disabled only for private');
   await page.getByRole('button',{name:'Save room for Room 1',exact:true}).click();
   await page.locator('.rf-gender-status').filter({hasText:'Saved'}).waitFor();
   await f.reopen();await open();
   assert.equal(await mode.inputValue(),value,'disk-backed save/reopen reads authoritative value');
   assert.equal(await gender.isDisabled(),value==='private');
   assert.equal(await gender.inputValue(),'female','gender retained for return to shared');
  }
  await mode.selectOption('private');
  await page.screenshot({path:path.join(OUT,tag,'native-private.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 } finally {await context.close();await f.close();}
}}
catch(e){report.failures=[{error:e.stack}];process.exitCode=1;}
finally{await browser.close();fs.mkdirSync(OUT,{recursive:true});
 report.writes=writes;report.unexpected=report.requests.filter(r=>r.disposition==='unexpected-blocked'||(r.disposition==='external-blocked'&&!r.url.startsWith('https://fonts.googleapis.com/css2?')));
 if(report.pageErrors.length||report.unexpected.length)process.exitCode=1;
 report.passed=!process.exitCode;fs.writeFileSync(path.join(OUT,'page-results.json'),JSON.stringify(report,null,2));console.log(report.passed?'PASS native emitted page → same Staff PUT → SQL COMMIT → disk reopen → ordinary page GET (4 cases)':'FAIL',JSON.stringify({failures:report.failures,pageErrors:report.pageErrors,unexpected:report.unexpected}));}
})();
