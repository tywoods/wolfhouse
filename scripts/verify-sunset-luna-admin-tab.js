'use strict';
/** Focused production-generated browser gate for Sunset Luna Staff in Admin. */
const fs = require('fs');
const path = require('path');
process.env.STAFF_AUTH_REQUIRED = 'false';
process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
process.env.NODE_ENV = 'test';
process.env.DEFAULT_CLIENT_SLUG = 'sunset';
process.env.STAFF_PORTAL_LOCALES = 'en,es,it';
process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'false';
let pass = 0; let fail = 0;
function ok(name, value, detail) { if (value) { pass++; console.log('  PASS  ' + name); } else { fail++; console.error('  FAIL  ' + name + (detail ? ' — ' + detail : '')); } }
function eq(name, actual, expected) { ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
function pw() { try { return require('playwright'); } catch (_) { const p='/opt/wolfhouse/WH/node_modules/playwright'; if (fs.existsSync(path.join(p,'package.json'))) return require(p); throw new Error('Playwright required'); } }
function listen(s) { return new Promise((resolve,reject)=>{ s.once('error',reject); s.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${s.address().port}`)); }); }
function close(s) { return new Promise(r=>s.close(r)); }
async function ready(page) { await page.waitForFunction(()=>document.body && !document.body.classList.contains('portal-profile-pending') && document.querySelector('#c-client option[value="wolfhouse-somo"]'), null, {timeout:30000}); }
async function main(){
  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server=createSunsetAdminVerifyServer(); const base=await listen(server);
  const browser=await pw().chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript(()=>{ localStorage.setItem('staff_portal_client','sunset'); localStorage.setItem('staff_portal_sunset_location','sunset-somo'); });
  const page=await context.newPage(); const lunaRequests=[]; const errors=[];
  page.on('pageerror',e=>errors.push(String(e.message||e)));
  await page.route('**/staff/admin/finance-summary**',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,summary:{periods:{today:{},week:{},month:{}},daily_trend:[]}})}));
  await page.route(/.*\/staff\/(global-pause|whatsapp-numbers|house-notes|notification-settings|automated-staff-notifications).*/,r=>{ lunaRequests.push(new URL(r.request().url()).pathname); r.fulfill({status:200,contentType:'application/json',body:'{"success":true,"rows":[],"numbers":[],"prompts":[]}'}); });
  await page.goto(base+'/staff/ui'); await ready(page);
  eq('Sunset has no visible top-level Luna Staff button', await page.locator('.tab-btn[data-tab="ask-luna"]:visible').count(), 0);
  await page.locator('.tab-btn[data-tab="admin"]').click();
  const shell=await page.evaluate(()=>({keys:[...document.querySelectorAll('#admin-subtab-list [data-admin-tab]')].filter(x=>getComputedStyle(x).display!=='none').map(x=>x.dataset.adminTab), labels:[...document.querySelectorAll('#admin-subtab-list [data-admin-tab]')].filter(x=>getComputedStyle(x).display!=='none').map(x=>x.textContent.trim()), selected:document.querySelector('#admin-subtab-list [aria-selected="true"]')?.dataset.adminTab, ids:document.querySelectorAll('#tab-ask-luna').length, lunaHidden:document.getElementById('admin-panel-luna-staff')?.hasAttribute('hidden')}));
  eq('Admin tab order', shell.keys.join(','), 'finance,pricing,luna-staff'); eq('Finance remains default', shell.selected, 'finance'); eq('single existing Luna panel', shell.ids, 1); eq('Luna panel hidden by default', shell.lunaHidden, true);
  const pricing=page.locator('#admin-tab-pricing'); await pricing.click(); await page.evaluate(()=>{ const x=document.querySelector('#admin-panel-pricing input'); if(x) x.value='draft-kept'; });
  await page.locator('#admin-tab-luna-staff').click();
  const luna=await page.evaluate(()=>({selected:document.getElementById('admin-tab-luna-staff').getAttribute('aria-selected'), hidden:document.getElementById('admin-panel-luna-staff').hasAttribute('hidden'), active:document.getElementById('tab-ask-luna').classList.contains('active'), parent:document.getElementById('tab-ask-luna').parentElement.id}));
  eq('Luna subtab selected',luna.selected,'true'); eq('Luna Admin panel shown',luna.hidden,false); eq('existing Luna content active',luna.active,true); eq('existing panel reparented',luna.parent,'admin-panel-luna-staff');
  const first=lunaRequests.length; await page.locator('.tab-btn[data-tab="conversations"]').click(); await page.locator('.tab-btn[data-tab="admin"]').click();
  eq('Admin re-entry defaults Finance',await page.locator('#admin-tab-finance').getAttribute('aria-selected'),'true');
  await page.locator('#admin-tab-luna-staff').click(); await page.waitForTimeout(100); ok('Luna re-entry stays bounded without duplicate listeners/fetch storms',lunaRequests.length >= first && lunaRequests.length <= first*2, `first ${first}, total ${lunaRequests.length}`);
  await page.locator('#admin-tab-finance').focus(); await page.keyboard.press('End'); eq('End focuses/selects Luna',await page.evaluate(()=>document.activeElement?.dataset.adminTab),'luna-staff'); await page.keyboard.press('Home'); eq('Home focuses/selects Finance',await page.evaluate(()=>document.activeElement?.dataset.adminTab),'finance');
  for(const locale of ['en','es','it']){ await page.locator(`[data-lang="${locale}"]`).click(); const labels=await page.locator('#admin-subtab-list').innerText(); ok(locale+' labels contain no raw keys',!labels.includes('admin.tabs.')); ok(locale+' Luna label translated',/Luna Staff/.test(labels)); }
  await page.setViewportSize({width:390,height:844}); const mobile=await page.evaluate(()=>[...document.querySelectorAll('#admin-subtab-list [data-admin-tab]')].filter(x=>getComputedStyle(x).display!=='none').map(x=>{const r=x.getBoundingClientRect();return {w:r.width,h:r.height,right:r.right}})); ok('mobile tabs are at least 44px',mobile.every(x=>x.w>=44&&x.h>=44)); ok('mobile tabs fit viewport',mobile.every(x=>x.right<=390));
  await page.evaluate(()=>{ const select=document.getElementById('c-client'); select.value='wolfhouse-somo'; select.dispatchEvent(new Event('change',{bubbles:true})); }); await page.waitForTimeout(100);
  eq('non-Sunset Luna remains enabled top-level',await page.locator('.tab-btn[data-tab="ask-luna"]').evaluate(x=>x.style.display),''); eq('non-Sunset Admin Luna subtab hidden',await page.locator('#admin-tab-luna-staff:visible').count(),0); eq('non-Sunset still has one Luna panel',await page.locator('#tab-ask-luna').count(),1);
  eq('no browser errors',errors.length,0);
  await browser.close(); await close(server); console.log(`\nSunset Luna Admin: ${pass} passed, ${fail} failed`); if(fail) process.exit(1);
}
main().catch(e=>{console.error(e);process.exit(1);});
