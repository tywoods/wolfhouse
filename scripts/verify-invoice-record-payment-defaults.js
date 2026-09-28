'use strict';

// Actual emitted Staff HTML and ordinary calendar entry. HTTP data only is synthetic.
// Usage: node scripts/verify-invoice-record-payment-defaults.js <artifact-dir>
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { booking, calendar, detail, GUEST, CODE, emit } = require('./verify-booking-drawer-invoice-tab');
const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'artifacts/invoice-record-payment-defaults'));
const ORIGIN = 'http://staff.test';
const TENANT = 'wolfhouse-somo';
const sizes = [['desktop',1440,1000], ['phone',390,844], ['short-desktop',1024,420], ['short-phone',390,420]];
const results = [], failures = [];

async function runCase(browser, html, size, width, height, theme) {
  const name = `${size}-${theme}`;
  const ctx = await browser.newContext({ viewport:{width,height}, serviceWorkers:'block' });
  const ledger = [], errors = [], receipts = [], observations = [];
  const state = JSON.parse(JSON.stringify(detail));
  let failReceipt = false;
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  await ctx.routeWebSocket('**/*', ws => { errors.push(`Unexpected WebSocket: ${ws.url()}`); ws.close(); });
  await ctx.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    const entry = {method:req.method(), url:req.url()}; ledger.push(entry);
    if (url.origin === ORIGIN && req.method() === 'POST' && url.pathname === '/staff/bookings/record-cash-payment') {
      const body = req.postDataJSON(); entry.body=body; entry.syntheticWrite=true; receipts.push(body);
      if(failReceipt) { failReceipt=false; entry.simulatedUncertain=true; return route.abort('failed'); }
      // Browser/payload proof only: this fixture does not execute a DB write.
      state.payments.paid_total_cents += body.amount_cents;
      state.payments.rows.push({payment_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',payment_status:'paid',amount_paid_cents:body.amount_cents,booking_guest_id:body.booking_guest_id,metadata:{method:body.method,source:'staff_'+body.method}});
      const guest=state.booking_guests.find(g=>g.booking_guest_id===body.booking_guest_id);
      if(guest) guest.amount_paid_cents+=body.amount_cents;
      return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true})});
    }
    // Production's optional font stylesheet is deliberately unavailable offline.
    if (req.method() === 'GET' && url.origin === 'https://fonts.googleapis.com' && url.pathname === '/css2') { entry.optionalFontAborted=true; return route.abort(); }
    if (url.origin !== ORIGIN || req.method() !== 'GET') { entry.blocked=true; return route.abort(); }
    const p = url.pathname;
    if (p === '/staff/ui') return route.fulfill({contentType:'text/html',body:html});
    let data;
    if (p === '/staff/bed-calendar') data = calendar;
    else if (p === `/staff/bookings/${CODE}/context`) data = state;
    else if (p === '/staff/auth/session') data = {success:true,auth_required:false,role:'admin',clients:[{slug:TENANT,name:TENANT}],client_profiles:{[TENANT]:loadClientPortalProfile(TENANT)}};
    else if (p.startsWith('/staff/assets/')) {
      const asset = path.join(ROOT,'config/staff-portal',path.basename(p));
      if (fs.existsSync(asset)) return route.fulfill({path:asset});
      entry.unknown=true; return route.abort();
    }
    else if (p === '/staff/intents') data = {success:true,intents:[]};
    else if (p === '/staff/inbox/luna-mode') data = {success:true,mode:'off'};
    else if (p === '/staff/bot/global-pause-state') data = {success:true,paused:false};
    else if (p === '/staff/whatsapp-numbers') data = {success:true,numbers:[]};
    else if (p === '/staff/admin/house-notes') data = {success:true,notes:''};
    else if (p === '/staff/automated-notifications') data = {success:true,notifications:[]};
    else if (p === '/staff/packages') data = {success:true,packages:[]};
    else if (p === '/staff/conversations') data = {success:true,conversations:[]};
    else if (p === '/staff/admin/config') data = {success:true,...resolveTenantBusinessConfig(TENANT,'sunset-somo')};
    else if (p === '/staff/admin/config/rental-offerings') data = {success:true,offerings:[]};
    else if (p === '/staff/schedule/bookings/catalog') data = {success:true,offerings:[],courses:[]};
    else if (p === '/staff/schedule/day') data = {success:true,date:url.searchParams.get('date'),lessons:[],gear:[],rows:[]};
    else if (p === `/staff/bookings/${booking.booking_id}/services`) data = {success:true,paid_requested_services:[],unscheduled_services:[],services_by_date:[]};
    else if (p === `/staff/bookings/${booking.booking_id}/transfers`) data = {success:true,transfers:[]};
    else if (p === '/staff/clients') data = {success:true,clients:[{slug:TENANT,name:TENANT}]};
    else { entry.unknown=true; return route.abort(); }
    return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await ctx.addInitScript(theme => {
    localStorage.setItem('wh_staff_portal_locale','en');
    localStorage.setItem('wh_staff_portal_theme',theme);
  },theme);
  try {
    await page.goto(`${ORIGIN}/staff/ui`,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(t=>typeof window.switchToTab==='function' && document.getElementById('c-client').value===t,TENANT);
    await page.evaluate(theme=>{document.documentElement.setAttribute('data-theme',theme);window.switchToTab('bed-calendar');},theme);
    await page.locator('.bc-block').first().click();
    // Move off the calendar naturally; do not resize an already mounted desktop drawer.
    await page.mouse.move(width-5,height-5);
    const trigger = page.locator('#bc-record-payment-btn');
    await trigger.click();
    const dialog = page.locator('#bc-record-payment-dialog');
    const scope=page.locator('#bc-payment-scope'), amount=page.locator('#bc-payment-amount');
    const submit=page.locator('#bc-payment-submit'), cancel=page.locator('#bc-payment-cancel');
    async function freshDefault() {
      const options=await scope.locator('option').evaluateAll(es=>es.map(e=>({value:e.value,text:e.textContent})));
      observations.push({label:'fresh-default',options,selected:await scope.inputValue()});
      assert.equal(await scope.inputValue(),'booking','fresh Guest defaults to All');
      assert.deepEqual(options,[{value:'booking',text:'All — booking payment'},{value:GUEST,text:'Tom (test) (#1)'}],'All first, no placeholder, durable guest retained');
      assert.equal(await amount.inputValue(),'','do not fill amount automatically');
      assert.equal(await page.locator('input[name="bc-payment-method"]:checked').count(),0,'do not choose method automatically');
      assert.equal(await page.locator('#bc-payment-outstanding').innerText(),'Outstanding: €600.00','initialize booking outstanding without a change event');
      assert.equal(await page.locator('#bc-payment-use-outstanding').isVisible(),true);
      assert.equal(await scope.evaluate(e=>e===document.activeElement),true,'initial focus stays on Guest');
    }
    async function measure(label) {
      const data = await dialog.evaluate(e=>{
        const r=e.getBoundingClientRect(),s=getComputedStyle(e);
        return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,
          viewport:[innerWidth,innerHeight],scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,
          scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,scrollTop:e.scrollTop,
          position:s.position,overflowY:s.overflowY,modal:e.matches(':modal'),theme:document.documentElement.dataset.theme};
      });
      observations.push({label,...data});
      return data;
    }
    const m = await measure('fresh-open');
    await page.screenshot({path:path.join(OUT,`${name}-fresh-local-synthetic.png`)});
    assert.equal(m.modal,true,'preserve native showModal');
    assert(m.width>0 && m.height>0,'measure visible dialog');
    const inset=width<=600?0:12;
    assert(Math.abs(width-m.right-inset)<=1,`fresh dialog right inset expected ${inset}, got ${width-m.right}`);
    assert(Math.abs(height-m.bottom-inset)<=1,`fresh dialog bottom inset expected ${inset}, got ${height-m.bottom}`);
    assert(m.x>=0 && m.y>=0 && m.right<=width && m.bottom<=height,'both axes inside viewport');
    assert(m.scrollWidth<=m.clientWidth,'no dialog horizontal overflow');
    if(width<=600) assert.equal(m.width,width,'phone bottom sheet full width');
    await freshDefault();
    if(height===420) {
      assert(m.scrollHeight>m.clientHeight,'short dialog has real scroll range');
      await dialog.evaluate(e=>{e.scrollTop=e.scrollHeight;});
      const scrolled=await measure('short-scrolled');
      assert(scrolled.scrollTop>0,'short dialog content can scroll');
      await page.screenshot({path:path.join(OUT,`${name}-scrolled-local-synthetic.png`)});
      await dialog.evaluate(e=>{e.scrollTop=0;});
    }
    await page.locator('#bc-payment-submit').focus(); await page.keyboard.press('Tab');
    assert.equal(await page.locator('#bc-payment-scope').evaluate(e=>e===document.activeElement),true,'Tab wraps to scope');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('#bc-payment-submit').evaluate(e=>e===document.activeElement),true,'Shift+Tab wraps to submit');
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(),0,'Escape removes dialog');
    assert.equal(await trigger.evaluate(e=>e===document.activeElement),true,'Escape returns trigger focus');
    assert.equal(ledger.filter(e=>e.method!=='GET').length,0,'open and Escape are read-only');
    // Keyboard reopen, explicit guest, then cancel: neither may write or stick as a fresh default.
    await page.keyboard.press('Enter');
    await freshDefault();
    await scope.selectOption(GUEST);
    assert.equal(await page.locator('#bc-payment-outstanding').innerText(),'Outstanding: €300.00');
    await page.locator('#bc-payment-use-outstanding').click();
    assert.equal(await amount.inputValue(),'300.00','explicit guest outstanding-fill preserved');
    await cancel.click(); await trigger.click(); await freshDefault();
    await submit.click();
    assert.notEqual(await page.locator('#bc-payment-error').innerText(),'','blank amount/method rejected');
    await amount.fill('12.34'); await submit.click();
    assert.notEqual(await page.locator('#bc-payment-error').innerText(),'','missing method rejected');
    assert.equal(ledger.filter(e=>e.method!=='GET').length,0,'open/cancel/invalid forms are read-only');
    await page.locator('input[name="bc-payment-method"][value="cash"]').check();
    for(const invalid of ['0','-1','4.001']) {
      await amount.fill(invalid); await submit.click();
      assert.equal(receipts.length,0,`invalid amount ${invalid} rejected`);
    }
    // Deliberately never select All: the fresh default must reach the registered POST handler.
    await amount.fill('12.34'); await submit.click();
    await page.waitForFunction(()=>document.getElementById('bc-invoice-feedback')?.textContent.includes('Payment recorded'));
    assert.equal(receipts.length,1);
    const {idempotency_key:key,payment_date:paymentDate,...allBody}=receipts[0];
    assert.equal(typeof key,'string'); assert(key.length>0);
    assert.match(paymentDate,/^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(allBody,{client_slug:TENANT,booking_code:CODE,booking_id:booking.booking_id,payment_scope:'booking',booking_guest_id:null,amount_cents:1234,method:'cash',note:null});
    assert.equal(await dialog.count(),0);
    // An ambiguous guest intent overrides the fresh All default on reopen, unchanged.
    await trigger.click(); await scope.selectOption(GUEST); await amount.fill('9.87');
    await page.locator('input[name="bc-payment-method"][value="bank_transfer"]').check();
    // Focus first so native short-dialog focus scrolling finishes before pointer down/up.
    await dialog.locator('summary').focus();
    await dialog.locator('summary').click();
    assert.equal(await dialog.locator('details').evaluate(e=>e.open),true,'registered native Details opens');
    await page.locator('#bc-payment-date').fill('2026-09-27');
    await page.locator('#bc-payment-note').fill('guest retry fixture');
    failReceipt=true; await submit.click();
    await page.waitForFunction(()=>document.getElementById('bc-payment-error')?.textContent.includes('uncertain'));
    assert.equal(receipts.length,2);
    await cancel.click(); await trigger.click();
    assert.equal(await scope.inputValue(),GUEST,'uncertain guest must not reset to All');
    assert.equal(await amount.inputValue(),'9.87');
    assert.equal(await page.locator('input[name="bc-payment-method"]:checked').inputValue(),'bank_transfer');
    assert.equal(await page.locator('#bc-payment-date').inputValue(),'2026-09-27');
    assert.equal(await page.locator('#bc-payment-note').inputValue(),'guest retry fixture');
    assert.equal(await scope.isDisabled(),true); assert.equal(await amount.isDisabled(),true);
    assert.equal(await page.locator('#bc-payment-outstanding').innerText(),'Outstanding: €300.00','restored outstanding belongs to guest');
    await submit.click();
    await page.waitForFunction(()=>document.getElementById('bc-invoice-feedback')?.textContent.includes('Payment recorded'));
    assert.equal(receipts.length,3);
    assert.deepEqual(receipts[2],receipts[1],'retry retains complete intent and idempotency key');
    assert.notEqual(receipts[2].idempotency_key,key,'different payment gets a new key');
    assert.equal(receipts[2].booking_guest_id,GUEST); assert.equal(receipts[2].payment_scope,'guest');
    results.push({name,placement:true,focus:true,freshDefault:true,untouchedAllPayload:true,uncertainGuestRetry:true,localSynthetic:true});
  } catch(e) {
    failures.push(`${name}: ${e.stack}`);
    await page.screenshot({path:path.join(OUT,`${name}-failure.png`)});
  } finally {
    fs.writeFileSync(path.join(OUT,`${name}.json`),JSON.stringify({observations,ledger,errors,receipts},null,2));
    if(errors.length) failures.push(`${name}: JS/transport errors: ${errors.join('; ')}`);
    if(ledger.some(e=>e.unknown||e.blocked)) failures.push(`${name}: unexpected request: ${JSON.stringify(ledger.filter(e=>e.unknown||e.blocked))}`);
    await ctx.close();
  }
}
async function main() {
  fs.mkdirSync(OUT,{recursive:true});
  const html=emit(TENANT,OUT);
  const browser=await chromium.launch({headless:true});
  try { for(const [size,width,height] of sizes) for(const theme of ['light','dark']) await runCase(browser,html,size,width,height,theme); }
  finally { await browser.close(); }
  if(results.length!==8) failures.push(`Expected 8 complete cases, got ${results.length}`);
  const report={cases:results.length,results,failures,out:OUT};
  fs.writeFileSync(path.join(OUT,'results.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  if(failures.length) process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
