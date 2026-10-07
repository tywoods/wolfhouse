'use strict';
const fs=require('fs'),path=require('path'),Module=require('module'),cp=require('child_process'),crypto=require('crypto');
const ROOT=path.resolve(__dirname,'..');
const OUT=path.resolve(process.argv[2] || path.join(ROOT,'artifacts/staff-collapsed-sections'));fs.mkdirSync(OUT,{recursive:true}); const {chromium}=require('playwright');
Object.assign(process.env,{NODE_ENV:'test',STAFF_UI_BUILDER_TEST_SEAM:'1',STAFF_AUTH_REQUIRED:'false',STAFF_AUTH_ALLOW_OPEN:'true',STAFF_PORTAL_LOCALES:'en,es,it',DEFAULT_CLIENT_SLUG:'wolfhouse-somo'});delete process.env.LUNA_DEPLOYMENT;
const report={notice:'OFFLINE SYNTHETIC fixture; unmodified production buildUiHtml + browser modules; all HTTP/WebSockets intercepted. Not live auth/DB/persistence proof.',head:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),checks:[],requests:[],pageErrors:[],screenshots:[],cases:[]};
function check(tag,name,ok,detail){report.checks.push({tag,name,ok:!!ok,detail});console.log(ok?'PASS':'FAIL',tag,name,detail===undefined?'':JSON.stringify(detail));}
function compile(src,file){const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(src,file);return m.exports;}
const pricingFile=path.join(ROOT,'scripts/verify-wolfhouse-admin-pricing-playwright.js');
const tools=compile(fs.readFileSync(pricingFile,'utf8').split('(async function main()')[0]+'\nmodule.exports={buildHtmlFor};',pricingFile);
const roomFile=path.join(ROOT,'scripts/verify-staff-room-fill-page.js');const roomSource=fs.readFileSync(roomFile,'utf8');
const room=compile(roomSource.split('async function main()')[0]+'\nmodule.exports={envelope};',roomFile);
const {buildClientProfilesMap,getAccessibleClients}=require(path.join(ROOT,'scripts/lib/staff-portal-clients'));
const profiles=buildClientProfilesMap(null);
const resolver=require(path.join(ROOT,'scripts/lib/wolfhouse-pricing-resolve'));
const {getClientTransferConfig}=require(path.join(ROOT,'scripts/lib/client-transfer-config'));
const view=resolver.buildAdminPricingView({config:resolver.loadPricingConfig(),transferConfig:getClientTransferConfig('wolfhouse-somo'),dbSeasons:[],dbRules:[{item_type:'package',item_code:'review-package',season_code:'august',unit:'per_person_per_week',amount_cents:34900,currency:'EUR',active:true}],dbItems:[{item_type:'package',item_code:'review-package',label:'Synthetic review package',active:true}],dbTransferRules:[],writesEnabled:true});view.overlay_available=true;
const html={};for(const client of ['wolfhouse-somo','sunset']){html[client]=tools.buildHtmlFor(client);fs.writeFileSync(path.join(OUT,client+'.html'),html[client]);}
report.htmlHashes=Object.fromEntries(Object.entries(html).map(([k,v])=>[k,crypto.createHash('sha256').update(v).digest('hex')]));
function fixtures(client){return {
 // Explicitly bounded ancillary loads caused by the real client-switch handler.
 '/staff/query':{success:false,error:'Service queries outside disclosure fixture'},
 '/staff/inbox/views':{success:false,error:'Inbox views outside disclosure fixture'},
 '/staff/inbox/list':{success:false,error:'Inbox list outside disclosure fixture'},
 '/staff/auth/session':{success:true,auth_required:false,role:'owner',email:null,display_name:'Offline review',clients:getAccessibleClients(null),client_profiles:profiles,can_use_owner_insights:true},
 '/staff/luna-intelligence/room-fill':room.envelope,
 '/staff/intents':{success:true,intents:[]},'/staff/inbox/luna-mode':{success:true,modes:{whatsapp:'draft',email:'draft'}},'/staff/bot/global-pause-state':{success:true,paused:false,client_slug:client},
 '/staff/whatsapp-numbers':{success:true,rows:[],numbers:[]},'/staff/admin/house-notes':{success:true,notes:'Offline synthetic notes.'},'/staff/automated-notifications':{success:true,rows:[],notifications:[]},'/staff/notification-settings':{success:true,new_conversation:{enabled:false,recipients:[]},human_needed:{enabled:false,recipients:[]}},
 '/staff/bed-calendar':{success:true,rooms:[],beds:[],bookings:[],rows:[],days:[]},'/staff/admin/finance/summary':{success:false,error:'Outside offline review scope'},'/staff/luna-personality':{success:true,personality_id:'sunny'},'/staff/luna-intelligence':{success:true,enabled:false,client_slug:client},'/staff/admin/wh/pricing':{success:true,...view},
 '/staff/tour-operator/rooms':{success:true,rooms:[]},'/staff/tour-operator/blocks':{success:true,blocks:[]},'/staff/rooms':{success:true,rooms:[]},'/staff/operator-blocks':{success:true,rows:[],blocks:[]},
 '/staff/conversations':{success:false,error:'Sunset Inbox outside review fixture'},'/staff/schedule/bookings/catalog':{success:false,error:'Sunset catalog outside review fixture'},'/staff/admin/config/rental-offerings':{success:false,error:'Sunset rentals outside review fixture'},'/staff/admin/config':{success:false,error:'Sunset pricing config outside review fixture'},'/staff/schedule/day':{success:false,error:'Sunset Schedule outside review fixture'}
};}
async function setup(browser,tag,client,width,theme,base=false){const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block',colorScheme:theme});context.setDefaultTimeout(4500);await context.routeWebSocket('**/*',s=>{report.requests.push({tag,method:'WEBSOCKET',url:s.url(),disposition:'blocked'});s.close()});await context.addInitScript(({client,theme})=>{localStorage.setItem('staff_portal_client',client);localStorage.setItem('wh_staff_portal_locale','en');},{client,theme});const fixture=fixtures(client);const state={rejectNotes:false,holdNotes:null};await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());const entry={tag,method:req.method(),url:req.url(),body:req.postData(),disposition:'unexpected-blocked'};report.requests.push(entry);const json=(obj,status=200)=>{entry.disposition='synthetic-fixture';return route.fulfill({status,contentType:'application/json',body:JSON.stringify(obj)})};if(url.origin!=='http://staff.test'){entry.disposition='external-blocked';return route.abort()};if(req.method()==='GET'&&url.pathname==='/staff/ui'){entry.disposition='production-html';return route.fulfill({contentType:'text/html',body:html[client+(base?'-base':'')]})}if(req.method()==='GET'&&url.pathname==='/staff/assets/luna-front-desk-logo.png'){entry.disposition='production-asset';return route.fulfill({contentType:'image/png',body:fs.readFileSync(path.join(ROOT,'config/staff-portal/luna-front-desk-logo.png'))})}if(req.method()==='GET'&&fixture[url.pathname])return json(fixture[url.pathname]);if(req.method()==='PUT'&&url.pathname==='/staff/admin/wh/pricing/prices')return json({success:false,error:'Review fixture: price must be greater than zero'},400);if(req.method()==='POST'&&url.pathname==='/staff/admin/house-notes'&&state.rejectNotes){await new Promise(r=>state.holdNotes=r);return json({success:false,error:'Review fixture: notes save rejected'},400)}return route.abort();});const page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push({tag,message:e.message}));await page.goto('http://staff.test/staff/ui',{waitUntil:'domcontentloaded'});await page.waitForFunction(c=>!document.body.classList.contains('portal-profile-pending')&&document.getElementById('c-client')?.value===c,client);if((await page.locator('html').getAttribute('data-theme')==='dark')!==(theme==='dark')){if(!await page.locator('#staff-theme-toggle').isVisible())await page.locator('#nav-menu-toggle').click();await page.locator('#staff-theme-toggle').click();if(await page.locator('body').evaluate(e=>e.classList.contains('nav-menu-open')))await page.keyboard.press('Escape');}return {context,page,state};}
async function tab(page,name){if(!await page.locator(`button.tab-btn[data-tab="${name}"]`).isVisible())await page.locator('#nav-menu-toggle').click();await page.locator(`button.tab-btn[data-tab="${name}"]`).click();}
async function settings(page,client='wolfhouse-somo'){await tab(page,'admin');await page.locator(client==='sunset'?'#admin-tab-luna-staff':'#wh-admin-tab-luna-staff').click();}
async function shot(page,tag,name,selector){if(selector)await page.locator(selector).scrollIntoViewIfNeeded();const file=path.join(OUT,`${tag}-${name}.png`);await page.screenshot({path:file});report.screenshots.push(file);}
const settingsButtons=['#staff-notes-toggle','#staff-numbers-toggle','#staff-notifications-toggle','#staff-style-toggle','#staff-room-setup-toggle'];
async function toggleProof(page,tag,selector){const loc=page.locator(selector);await loc.waitFor({state:'visible'});check(tag,selector+' defaults closed',await loc.getAttribute('aria-expanded')==='false');const before=report.requests.length;await loc.click();check(tag,selector+' pointer opens',await loc.getAttribute('aria-expanded')==='true');await loc.focus();await page.keyboard.press('Space');check(tag,selector+' Space closes',await loc.getAttribute('aria-expanded')==='false');await page.keyboard.press('Enter');check(tag,selector+' Enter opens',await loc.getAttribute('aria-expanded')==='true');const focus=await loc.evaluate(b=>({visible:b.matches(':focus-visible'),outline:getComputedStyle(b).outline,rect:{left:b.getBoundingClientRect().left,right:b.getBoundingClientRect().right},width:innerWidth}));check(tag,selector+' focus ring',focus.visible&&!/0px|none/.test(focus.outline),focus);check(tag,selector+' no overflow',focus.rect.left>=0&&focus.rect.right<=focus.width,focus);await shot(page,tag,selector.slice(1)+'-expanded',selector);await loc.click();check(tag,selector+' toggle no mutation',report.requests.slice(before).every(r=>['GET','HEAD'].includes(r.method)));}
async function unsaved(page,tag,toggle,input,value){await page.locator(toggle).click();await page.locator(input).fill(value);const handle=await page.locator(input).elementHandle();await page.locator(toggle).click();check(tag,input+' hidden when collapsed',!await page.locator(input).isVisible());await page.locator(toggle).focus();await page.keyboard.press('Tab');check(tag,input+' collapsed fields skipped by Tab',await page.evaluate(sel=>!document.querySelector(sel).parentElement.contains(document.activeElement),input));await page.locator(toggle).click();check(tag,input+' unsaved value and DOM preserved',await page.locator(input).inputValue()===value&&await handle.evaluate(n=>n.isConnected));await page.locator(toggle).click();}
async function matrix(browser,width,theme){const tag=`${theme}-${width}`;const {context,page,state}=await setup(browser,tag,'wolfhouse-somo',width,theme);report.cases.push(tag);try{await settings(page);check(tag,'correct rendered theme',(await page.locator('html').getAttribute('data-theme')==='dark')===(theme==='dark'));await shot(page,tag,'settings-closed','#staff-style-toggle');check(tag,'closed Numbers hides late-mounted alert controls',await page.locator('#cc-staff-whatsapp-numbers button:visible').count()===1);for(const sel of settingsButtons)await toggleProof(page,tag,sel);check(tag,'Room Setup sibling separate from Personality/research',await page.evaluate(()=>document.getElementById('staff-room-setup-card').contains(document.getElementById('staff-room-fill'))&&!document.getElementById('staff-room-setup-card').contains(document.getElementById('staff-luna-intelligence-toggle'))));await unsaved(page,tag,'#staff-notes-toggle','#hn-text','Unsaved review notes');await unsaved(page,tag,'#staff-numbers-toggle','#swn-add-phone','+15550001111');await page.locator('#staff-style-toggle').click();await page.locator('#wh-admin-tab-pricing').click();await page.locator('#wh-admin-pricing-body .staff-collapse-toggle').first().waitFor({state:'visible'});check(tag,'six pricing sections',await page.locator('#wh-admin-pricing-body .staff-collapse-toggle').count()===6);await shot(page,tag,'pricing-closed','#wh-admin-pricing-body');check(tag,'closed Pricing shows only disclosure buttons',await page.locator('#wh-admin-pricing-body button:visible').count()===6);for(const name of ['seasons','packages','rentals','services','transfers','extras'])await toggleProof(page,tag,`[aria-controls="wh-pricing-collapse-${name}"]`);
 const pkg='[aria-controls="wh-pricing-collapse-packages"]';await page.locator(pkg).click();await page.locator('[data-wh-price-action="edit-package-price"]').first().click();check(tag,'pricing Edit stays expanded / editor visible',await page.locator(pkg).getAttribute('aria-expanded')==='true'&&await page.locator('#wh-price-amount').isVisible());await shot(page,tag,'pricing-edit-hidden',pkg);if(await page.locator(pkg).getAttribute('aria-expanded')==='false')await page.locator(pkg).click();await page.locator('#wh-price-amount').fill('375.00');await page.locator(pkg).click();await page.locator(pkg).click();check(tag,'pricing unsaved collapse/reopen preserved',await page.locator('#wh-price-amount').inputValue()==='375.00');await page.locator('#wh-price-amount').fill('0');await page.locator('[data-wh-price-action="save-package-price"]').first().click();await page.locator('.wh-price-banner-warn').waitFor({state:'visible'});check(tag,'pricing rejected save expands failed field',await page.locator('#wh-price-amount').isVisible());await shot(page,tag,'pricing-error-field-hidden',pkg);
 if(await page.locator(pkg).getAttribute('aria-expanded')==='false')await page.locator(pkg).click();await page.locator('#wh-admin-tab-luna-staff').click();await page.locator('#wh-admin-tab-pricing').click();check(tag,'Pricing state retained across tab change',await page.locator(pkg).getAttribute('aria-expanded')==='true');
 await page.locator('#wh-admin-tab-luna-staff').click();check(tag,'Settings state through tab change',await page.locator('#staff-style-toggle').getAttribute('aria-expanded')==='true');await page.locator('#staff-style-toggle').click();
 await page.locator('#wh-admin-tab-tour-operator').click();await shot(page,tag,'to-closed','#to-op-panel');for(const sel of ['#staff-room-block-toggle','#staff-room-release-toggle'])await toggleProof(page,tag,sel);await unsaved(page,tag,'#staff-room-block-toggle','#to-op-cin','2026-10-12');await unsaved(page,tag,'#staff-room-release-toggle','#to-rr-start','2026-10-13');
 await settings(page);await page.locator('#staff-notes-toggle').click();state.rejectNotes=true;await page.locator('#hn-text').fill('Offline rejected notes');const notesRequest=page.waitForRequest(r=>r.method()==='POST'&&r.url().includes('/staff/admin/house-notes'));await page.locator('#hn-save-btn').click();await notesRequest;await page.locator('#staff-notes-toggle').click();state.holdNotes();await page.waitForFunction(()=>document.getElementById('hn-error').textContent.includes('Review fixture:'));check(tag,'Notes asynchronous failure reopens owning card',await page.locator('#hn-error').isVisible());await shot(page,tag,'notes-error-hidden','#staff-notes-toggle');check(tag,'closed Numbers hides controls mounted after Settings reentry',await page.locator('#cc-staff-whatsapp-numbers button:visible').count()===1);await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!document.body.classList.contains('portal-profile-pending'));await settings(page);check(tag,'fresh reload closes Settings',await page.locator('#staff-notes-toggle').getAttribute('aria-expanded')==='false');
 const ids=await page.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].map(x=>x.id);return [...new Set(ids.filter((id,i)=>ids.indexOf(id)!==i))]});report.checks.push({tag,name:'duplicate IDs inventory (baseline comparison required)',ok:true,detail:ids});
 }catch(e){check(tag,'flow completed',false,e.stack);await shot(page,tag,'harness-failure').catch(()=>{});}finally{await context.close();}}
async function sunset(browser,base){const tag=base?'sunset-base':'sunset-candidate';const {context,page}=await setup(browser,tag,'sunset',1280,'light',base);try{await settings(page,'sunset');const detail=await page.evaluate(()=>({rootParent:document.getElementById('staff-room-fill').parentElement.id,roomSetupVisible:!!document.getElementById('staff-room-setup-card')?.checkVisibility(),rootVisible:document.getElementById('staff-room-fill').checkVisibility(),styleHeader:document.getElementById('staff-style-card').firstElementChild.outerHTML}));report.checks.push({tag,name:'Sunset structure',ok:base||!detail.roomSetupVisible,detail});console.log('SUNSET',tag,JSON.stringify(detail));await shot(page,tag,'settings','#staff-style-card');if(!base){check(tag,'Sunset Room Placement hierarchy restored',detail.rootParent==='staff-luna-intelligence');check(tag,'Sunset has no added disclosure buttons',await page.locator('.staff-collapse-toggle').count()===0);}}catch(e){check(tag,'flow completed',false,e.stack);await shot(page,tag,'harness-failure').catch(()=>{});}finally{await context.close();}}

async function clientContext(browser) {
  const tag = 'admitted-client-lifecycle';
  const { context, page } = await setup(browser, tag, 'wolfhouse-somo', 1280, 'light');
  try {
    await settings(page);
    await page.locator('#staff-style-toggle').click();
    const admittedKey = await page.evaluate(() => window.staffCollapseContextKey());
    await page.evaluate(() => document.documentElement.setAttribute('data-portal-client', 'sunset'));
    check(tag, 'presentation attribute cannot override admitted client',
      await page.locator('#staff-style-toggle').getAttribute('aria-expanded') === 'true' &&
      await page.evaluate(() => window.staffCollapseContextKey()) === admittedKey);
    await page.evaluate(() => document.documentElement.setAttribute('data-portal-client', 'wolfhouse-somo'));
    await page.locator('#wh-admin-tab-pricing').click();
    const pkg = '[aria-controls="wh-pricing-collapse-packages"]';
    await page.locator(pkg).click();
    // The existing client selector is hidden inside Inbox on this layout. Force only
    // select visibility; exercise its real change/profile handler, not a state hook.
    await page.locator('#c-client').selectOption('sunset', { force: true });
    await page.waitForFunction(() => window.staffCollapseContextKey().endsWith(':sunset'));
    await settings(page, 'sunset');
    check(tag, 'actual admitted switch removes Wolfhouse disclosures', await page.locator('.staff-collapse-toggle').count() === 0);
    check(tag, 'actual switch restores original Room Placement mount',
      await page.locator('#staff-room-fill').evaluate(n => n.parentElement.id) === 'staff-luna-intelligence');
    await page.locator('#c-client').selectOption('wolfhouse-somo', { force: true });
    await page.waitForFunction(() => window.staffCollapseContextKey().endsWith(':wolfhouse-somo'));
    await settings(page);
    check(tag, 'returning client starts Settings closed', await page.locator('#staff-style-toggle').getAttribute('aria-expanded') === 'false');
    await page.locator('#wh-admin-tab-pricing').click();
    await page.locator(pkg).waitFor({ state: 'visible' });
    check(tag, 'returning client starts Pricing closed', await page.locator(pkg).getAttribute('aria-expanded') === 'false');
    await shot(page, tag, 'returned-pricing', '#wh-admin-pricing-body');
  } catch (e) { check(tag, 'flow completed', false, e.stack); }
  finally { await context.close(); }
}
async function denied(browser) {
  const tag = 'permission-denied';
  const { context, page } = await setup(browser, tag, 'wolfhouse-somo', 390, 'dark');
  try {
    await context.route('**/staff/luna-intelligence/room-fill', r => r.fulfill({ status: 403, json: { success: false, error: 'Synthetic denial' } }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.body.classList.contains('portal-profile-pending'));
    await settings(page);
    await page.waitForFunction(() => document.getElementById('staff-room-fill').hidden);
    check(tag, 'whole Room Setup wrapper hidden after 403', !await page.locator('#staff-room-setup-card').isVisible());
    await shot(page, tag, 'settings', '#staff-style-card');
  } finally { await context.close(); }
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  report.chromium = browser.version();
  try {
    for (const width of (process.env.COLLAPSE_QUICK ? [390] : [390, 1280]))
      for (const theme of (process.env.COLLAPSE_QUICK ? ['light'] : ['light', 'dark'])) await matrix(browser, width, theme);
    await sunset(browser, false); await denied(browser); await clientContext(browser);
    check('ledger', 'no uncaught page errors', report.pageErrors.length === 0, report.pageErrors);
    check('ledger', 'no unexpected requests', !report.requests.some(r => r.disposition === 'unexpected-blocked'));
  } finally { await browser.close(); }
})().catch(e => check('harness', 'complete', false, e.stack)).finally(() => {
  report.failures = report.checks.filter(c => !c.ok);
  report.unexpected = report.requests.filter(r => r.disposition === 'unexpected-blocked');
  report.verdict = report.failures.length ? 'FAIL' : 'PASS';
  fs.writeFileSync(path.join(OUT, 'browser-results.json'), JSON.stringify(report, null, 2));
  console.log(report.verdict, report.failures.length, 'failures', report.unexpected.length, 'unknown blocked requests');
  process.exitCode = report.failures.length ? 1 : 0;
});
