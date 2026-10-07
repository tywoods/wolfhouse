'use strict';
// Reuse ordinary emitted-page / admitted-tenant fixture, never mount renderer fragments.
const fs = require('fs'), path = require('path'), Module = require('module');
const file = path.join(__dirname, 'verify-staff-collapsed-sections.js');
const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(__dirname);
m._compile(fs.readFileSync(file, 'utf8').split('(async () => {')[0] + '\nmodule.exports={setup,settings,shot,check,report,OUT};', file);
const {setup,settings,shot,check,report,OUT} = m.exports;
const {chromium} = require('playwright');
(async () => {
 const browser = await chromium.launch({headless:true});
 try {
  for (const width of [390,1280]) for (const theme of ['light','dark']) {
   const tag = `${width}-${theme}`, {context,page}=await setup(browser,tag,'wolfhouse-somo',width,theme);
   try {
    await settings(page);
    for(const id of ['staff-alerts-toggle','staff-personality-toggle']) check(tag,id+' closed',await page.locator('#'+id).getAttribute('aria-expanded')==='false');
    await page.locator('#staff-alerts-toggle').click();
    let releaseAlert;
    await context.route('**/staff/notification-settings*',async r=>{
      if(r.request().method()!=='PUT') return r.fallback();
      await new Promise(resolve=>{releaseAlert=resolve;});
      return r.fulfill({status:400,json:{success:false,error:'Synthetic rejected alert save'}});
    });
    const alertRequest=page.waitForRequest(r=>r.method()==='PUT'&&r.url().includes('/staff/notification-settings'));
    await page.locator('#sns-save-btn').click();await alertRequest;
    await page.locator('#staff-alerts-toggle').click();releaseAlert();
    await page.waitForFunction(()=>document.getElementById('sns-error').textContent==='Synthetic rejected alert save');
    check(tag,'late alert error reopens owning disclosure',await page.locator('#sns-error').isVisible());
    await page.locator('#staff-personality-toggle').click();
    const button=page.locator('#staff-luna-intelligence-toggle');
    await page.waitForFunction(()=>!document.getElementById('staff-luna-intelligence-toggle').disabled);
    const box=await button.boundingBox();
    check(tag,'Intelligence compact Staff switch with retained slider',await button.locator('.portal-admin-equip-switch-slider').count()===1 && box.width<=60 && box.height<=48,box);
    await shot(page,tag,'intelligence', '#staff-luna-personality-card');
    let enabled=false,puts=0;
    await context.route('**/staff/luna-intelligence',async r=>{
     if(r.request().method()==='PUT'){puts++;enabled=JSON.parse(r.request().postData()).enabled;}
     return r.fulfill({json:{success:true,enabled,client_slug:'wolfhouse-somo'}});
    });
    await button.click(); await page.waitForFunction(()=>document.getElementById('staff-luna-intelligence-status').textContent==='Saved.');
    check(tag,'single write authoritative on state',puts===1 && await button.getAttribute('aria-checked')==='true');
    check(tag,'slider survives setting readback',await button.locator('.portal-admin-equip-switch-slider').count()===1);
    await context.route('**/staff/luna-intelligence',r=>r.fulfill({status:500,json:{success:false}}));
    await button.click(); await page.waitForFunction(()=>document.getElementById('staff-luna-intelligence-status').textContent.includes('Could not save'));
    check(tag,'failed save retains authoritative state',await button.getAttribute('aria-checked')==='true');
    await page.locator('#staff-personality-toggle').click();
    check(tag,'collapse does not save Intelligence',puts===1);
    await page.locator('#wh-admin-tab-tour-operator').click();
    check(tag,'Wolfhouse intro removed',!await page.locator('[data-i18n="tourOperator.intro"]').isVisible());
    for(const id of ['staff-room-block-toggle','staff-room-release-toggle']) {await page.locator('#'+id).click();check(tag,id+' still works',await page.locator('#'+id).getAttribute('aria-expanded')==='true');}
    await shot(page,tag,'tour-operator','#to-op-panel');
    await page.locator('#c-client').selectOption('sunset',{force:true});
    await page.waitForFunction(()=>window.staffCollapseContextKey().endsWith(':sunset'));
    check(tag,'Sunset intro restored',await page.locator('[data-i18n="tourOperator.intro"]').evaluate(n=>!n.closest('.card').hidden));
    check(tag,'Sunset original Intelligence chrome restored',await button.evaluate(n=>n.classList.contains('luna-header-mode-btn')&&!n.classList.contains('staff-intelligence-switch')) && await button.locator('.portal-admin-equip-switch-slider').count()===0);
   } catch(e) {check(tag,'flow completed',false,e.stack);} finally {await context.close();}
  }
  check('ledger','no page errors',report.pageErrors.length===0,report.pageErrors);
  check('ledger','no unknown traffic',!report.requests.some(r=>r.disposition==='unexpected-blocked'));
 } finally {await browser.close();}
})().catch(e=>check('harness','completed',false,e.stack)).finally(()=>{
 report.failures=report.checks.filter(c=>!c.ok);report.verdict=report.failures.length?'FAIL':'PASS';
 fs.writeFileSync(path.join(OUT,'polish-controls-results.json'),JSON.stringify(report,null,2));
 console.log(report.verdict,report.failures.length,'failures');process.exitCode=report.failures.length?1:0;
});
