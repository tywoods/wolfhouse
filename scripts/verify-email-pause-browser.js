#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {chromium}=require('playwright');
async function main(){const browser=await chromium.launch({headless:true,args:['--no-sandbox']});try{
const page=await browser.newPage({viewport:{width:1000,height:900}});
const src=fs.readFileSync(path.join(__dirname,'staff-query-api.js'),'utf8');
const css=[...src.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m=>m[1]).find(s=>s.includes('.portal-admin-email-card-head'));
await page.setContent('<style>body{font-family:system-ui;background:#f7f7f9;padding:30px}section{background:white;border:1px solid #ddd;padding:20px;margin-bottom:16px}'+css+'</style><div id="admin-email-settings-body"></div>');
await page.evaluate(strings=>{window.pauseTestTranslations=strings;},require('./lib/staff-portal-i18n').STAFF_PORTAL_STRINGS.en);
await page.addScriptTag({content:`var portalLang='en';function getClient(){return 'wolfhouse-somo';}function escHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');}function portalT(k){return window.pauseTestTranslations[k]||k;}function el(id){return document.getElementById(id);}`});
await page.addScriptTag({path:path.join(__dirname,'browser/sunset-admin-email-settings-ui.js')});
await page.evaluate(()=>renderAdminEmailSettingsData({locations:[{location_id:'wolfhouse-somo',active:true}],provider_actions:{},endpoints:['microsoft_graph','gmail_api','imap_smtp'].map((provider,i)=>({provider,location_id:'wolfhouse-somo',endpoint_id:'22222222-2222-4222-8222-22222222222'+i,connection_state:'connected_health',public_address:'mailbox@example.test',pause_available:true,mail_flow_paused:true,endpoint_active:true,inbound_enabled:true,outbound_enabled:false,automation_enabled:false}))}));
assert.equal(await page.locator('.portal-admin-email-flow-option.is-off').count(),3);
const positions=await page.locator('.portal-admin-email-card-head').evaluateAll(headers=>headers.map(h=>({title:h.querySelector('.portal-admin-email-card-title').getBoundingClientRect().bottom,status:h.querySelector('.portal-admin-email-status').getBoundingClientRect().top})));
for(const pos of positions)assert.ok(pos.status>=pos.title,'Connected status gets its own row, leaving top-right for toggle');
for(const viewport of [{width:1000,height:1000},{width:390,height:1100}]){await page.setViewportSize(viewport);
 const styles=await page.locator('.portal-admin-email-flow-option.is-off').evaluateAll(buttons=>buttons.map(b=>({bg:getComputedStyle(b).backgroundColor,right:b.getBoundingClientRect().right,card:b.closest('section').getBoundingClientRect().right,group:getComputedStyle(b.parentNode).display})));
 for(const s of styles){assert.equal(s.bg,'rgb(220, 38, 38)','Off selected red');assert.ok(['flex','inline-flex'].includes(s.group),'segmented pill');assert.ok(s.right<=s.card,'control remains inside card');}
 const dir=path.join(__dirname,'../tmp/email-pause-browser');fs.mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,'cards-'+viewport.width+'.png'),fullPage:true});
}
console.log('PASS Chromium desktop/mobile: three card pills, selected Off red, no card overflow; screenshots in tmp/email-pause-browser');
}finally{await browser.close();}}
main().catch(e=>{console.error(e);process.exitCode=1;});
