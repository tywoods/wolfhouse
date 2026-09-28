'use strict';
// Focused production-module proof, not full Admin navigation/layout or DB persistence.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {buildAdminPricingView}=require('./lib/wolfhouse-pricing-resolve');
const {validateTransferRuleBody,validatePriceRuleBody}=require('./lib/wolfhouse-pricing-writes');
const {STAFF_PORTAL_STRINGS}=require('./lib/staff-portal-i18n');
const OUT=path.resolve(process.env.TRANSFER_ADMIN_OUT||process.argv[2]||'/opt/data/workspace/sandbox-repos/WH-captain/artifacts/transfer-admin-price-custom-001/ui/admin');
const ORIGIN='http://admin.test',BASE='/staff/admin/wh/pricing';
async function main(){
 fs.mkdirSync(OUT,{recursive:true});const browser=await chromium.launch({headless:true}),cases=[];let failure;
 try{for(const locale of ['en','es']){
  const ctx=await browser.newContext({serviceWorkers:'block'}),ledger=[],errors=[];
  let rules=[{airport_code:'SDR',label:'Santander',requires_package:false,included_when_package:false,min_guest_count:null,active:true}],prices=[{item_type:'transfer',item_code:'SDR',unit:'flat',amount_cents:5300,currency:'EUR',active:true}];
  const view=()=>({success:true,...buildAdminPricingView({config:{},transferConfig:{},dbSeasons:[],dbItems:[],dbRules:prices,dbTransferRules:rules,writesEnabled:true})});
  await ctx.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url()),e={method:req.method(),url:req.url()};ledger.push(e);
   if(u.origin!==ORIGIN){e.unexpected=true;return route.abort();}
   if(u.pathname==='/'&&req.method()==='GET')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><main id="wh-admin-pricing-body"></main></body></html>'});
   if(u.searchParams.get('client')!=='wolfhouse-somo'){e.unexpected=true;return route.abort();}
   if(u.pathname===BASE&&req.method()==='GET')return route.fulfill({json:view()});
   if(req.method()==='PUT'&&[BASE+'/transfers',BASE+'/prices'].includes(u.pathname)){
    e.body=req.postDataJSON();e.syntheticWrite=true;
    const isRule=u.pathname.endsWith('/transfers'),validated=(isRule?validateTransferRuleBody:validatePriceRuleBody)(e.body);assert.equal(validated.ok,true,validated.error);
    if(isRule)rules=[validated.value];else{assert.equal(e.body.item_type,'transfer');assert.equal(e.body.item_code,'SDR');prices=[validated.value];}
    return route.fulfill({json:view()});
   }
   e.unexpected=true;return route.abort();
  });
  const page=await ctx.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(String(e)));
  try{
   await page.goto(ORIGIN);await page.evaluate(strings=>{window.t=key=>strings[key]||key;},STAFF_PORTAL_STRINGS[locale]);
   await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'browser/wolfhouse-admin-pricing-ui.js'),'utf8')});
   await page.evaluate(()=>window.loadWolfhouseAdminPricing({force:true}));
   const edit=()=>page.locator('[data-wh-price-action="edit-transfer"][data-wh-airport="SDR"]');
   const card=()=>page.locator('.portal-admin-price-card').filter({has:edit()});
   const labels=locale==='en'?['Per group','Per person']:['Por grupo','Por persona'];
   assert((await card().innerText()).includes(labels[0]),'Transfer flat card says Per group');
   for(const [unit,amount,label] of [['per_person','37.00',labels[1]],['flat','123.00',labels[0]]]){
    await edit().click();assert.deepEqual(await page.locator('#wh-price-transfer-unit option').allTextContents(),labels,'existing stored units have transfer-only labels');
    await page.locator('#wh-price-transfer-unit').selectOption(unit);await page.locator('#wh-price-transfer-amount').fill(amount);
    await page.locator('[data-wh-price-action="save-transfer"]').click();await edit().waitFor();assert((await card().innerText()).includes(label));assert((await card().innerText()).includes('€'+amount));
    await page.evaluate(()=>window.loadWolfhouseAdminPricing({force:true}));assert((await card().innerText()).includes(label));
    await edit().click();assert.equal(await page.locator('#wh-price-transfer-unit').inputValue(),unit);assert.equal(await page.locator('#wh-price-transfer-amount').inputValue(),amount);
    await page.screenshot({path:path.join(OUT,`${locale}-${unit}.png`)});await page.locator('[data-wh-price-action="cancel"]').click();
   }
   assert.equal(ledger.filter(e=>e.syntheticWrite).length,4);assert.deepEqual(errors,[]);assert.deepEqual(ledger.filter(e=>e.unexpected),[]);cases.push({locale,passed:true});
  }catch(e){cases.push({locale,passed:false,error:e.stack});throw e;}finally{fs.writeFileSync(path.join(OUT,locale+'-ledger.json'),JSON.stringify({ledger,errors},null,2));await ctx.close();}
 }assert.equal(cases.length,2);}catch(e){failure=e;}finally{await browser.close();fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify({passed:!failure,cases,limitations:'Minimal mount of unmodified production admin module, exported loader and delegated clicks; HTTP writes validated and resolver-backed in-memory responses only. Not production portal layout or DB persistence.'},null,2));}
 if(failure)throw failure;console.log('PASS: EN/ES Transfer unit cards/options; edit/save/reload/reopen per_person and flat; validators/resolver synthetic responses.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
