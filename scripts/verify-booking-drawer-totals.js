'use strict';

// Production /staff/ui, real calendar block + tab clicks; only HTTP data is synthetic.
// No server, live credentials or outbound network. Usage: node scripts/verify-booking-drawer-totals.js [artifact-dir]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'tmp/booking-drawer-totals'));
const ORIGIN = 'http://staff.test';
const CODE = 'WH-CHROME-TEST';
const booking = { booking_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', booking_code: CODE,
  guest_name: 'Tom (test)', guest_count: 2, total_amount_cents:60000, accommodation_total_cents:60000, deposit_required_cents:18000, amount_paid_cents:0, balance_due_cents:60000, status: 'confirmed', check_in: '2026-09-24', check_out: '2026-09-29', nights: 5 };
const calendar = { success: true,
  days: Array.from({ length: 14 }, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 24 + i)).toISOString().slice(0, 10) })),
  rooms: Array.from({ length: 4 }, (_, i) => ({ room_code: `R${i + 1}`, room_name: `Room ${i + 1}`,
    beds: Array.from({ length: 4 }, (_, j) => ({ bed_code: `R${i + 1}-B${j + 1}`, bed_label: `Bed ${j + 1}` })) })),
  blocks: [{ ...booking, room_code: 'R1', bed_code: 'R1-B1', start_date: '2026-09-24', end_date: '2026-09-29', source: 'staff', start_offset: 0, span: 5 }], warnings: [] };
const GUEST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const detail = { success: true, booking, rooming: { assignments: [] }, booking_guests: [{booking_guest_id:GUEST, guest_number:1, guest_name:'Tom (test)', metadata:{subtotal_cents:30000}, deposit_amount_cents:9000, amount_paid_cents:0, payment_status:'not_requested'}], per_person: [],
  guest_accommodation_lines: [{guest_number:1,accommodation_cents:30000,nights:5},{guest_number:2,accommodation_cents:30000,nights:5}],
  service_records: [], transfers: [], payments: { paid_total_cents: 0, rows: [] }, pending_manual_services: [], conversation: null };

function emit(tenant) {
  const dest = path.join(OUT, `${tenant}.html`);
  const r = spawnSync(process.execPath, ['scripts/verify-inbox-ui-parity.js', '--emit', tenant, dest], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, STAFF_ACTIONS_ENABLED: 'true', STRIPE_LINKS_ENABLED: 'true' } });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return fs.readFileSync(dest, 'utf8');
}
function luminance(rgb) {
  const c = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
async function main() {
  fs.mkdirSync(OUT, {recursive:true});
  const html = emit('wolfhouse-somo');
  const browser = await chromium.launch({headless:true});
  const ctx = await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  const ledger=[], errors=[], cases=[];
  const state=JSON.parse(JSON.stringify(detail));
  let failure=null, linkFailure=false, invalidUrl=false, deferTarget=null, releaseLink=null, contextFailure=false;
  await ctx.route('**/*', async route=>{
    const req=route.request(), url=new URL(req.url()), entry={method:req.method(),url:req.url()}; ledger.push(entry);
    if(url.origin===ORIGIN && req.method()==='POST' && url.pathname==='/staff/bookings/generate-payment-link'){
      entry.syntheticWrite=true;entry.body=req.postDataJSON();
      if(deferTarget===entry.body.payment_target){deferTarget=null;await new Promise(resolve=>{releaseLink=resolve;});}
      if(linkFailure){linkFailure=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({success:false,message:'Synthetic unavailable'})});}
      const link=invalidUrl?'javascript:alert(1)':'https://checkout.stripe.com/c/pay/'+entry.body.payment_target+'-test-only';invalidUrl=false;
      return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,checkout_url:link})});
    }
    if(url.origin===ORIGIN && req.method()==='POST' && url.pathname==='/staff/bookings/generate-guest-payment-link'){
      entry.syntheticWrite=true;entry.body=req.postDataJSON();
      return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,checkout_url:'https://checkout.stripe.com/c/pay/guest-test-only'})});
    }
    if(url.origin!==ORIGIN || req.method()!=='GET'){entry.blocked=true;return route.abort();}
    const p=url.pathname; let data;
    if(p==='/staff/ui')return route.fulfill({contentType:'text/html',body:html});
    if(p==='/staff/bed-calendar')data=calendar;
    else if(p===`/staff/bookings/${CODE}/context`){
      if(contextFailure){contextFailure=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({success:false})});}
      data=state;
    }
    else if(p==='/staff/auth/session')data={success:true,auth_required:false,role:'admin',clients:[{slug:'wolfhouse-somo',name:'Wolfhouse'}],client_profiles:{'wolfhouse-somo':loadClientPortalProfile('wolfhouse-somo')}};
    else if(p.startsWith('/staff/assets/')){
      const asset=path.join(ROOT,'config/staff-portal',path.basename(p));
      if(fs.existsSync(asset))return route.fulfill({path:asset});
      entry.unknown=true;return route.abort();
    }
    else if(p==='/staff/intents')data={success:true,intents:[]};
    else if(p==='/staff/inbox/luna-mode')data={success:true,mode:'off'};
    else if(p==='/staff/bot/global-pause-state')data={success:true,paused:false};
    else if(p==='/staff/whatsapp-numbers')data={success:true,numbers:[]};
    else if(p==='/staff/admin/house-notes')data={success:true,notes:''};
    else if(p==='/staff/automated-notifications')data={success:true,notifications:[]};
    else if(p==='/staff/packages')data={success:true,packages:[]};
    else if(p==='/staff/conversations')data={success:true,conversations:[]};
    else if(p==='/staff/admin/config')data={success:true,...resolveTenantBusinessConfig('wolfhouse-somo','sunset-somo')};
    else if(p==='/staff/admin/config/rental-offerings')data={success:true,offerings:[]};
    else if(p===`/staff/bookings/${booking.booking_id}/services`)data={success:true,paid_requested_services:[],unscheduled_services:[],services_by_date:[]};
    else if(p===`/staff/bookings/${booking.booking_id}/transfers`)data={success:true,transfers:[]};
    else if(p==='/staff/clients')data={success:true,clients:[{slug:'wolfhouse-somo',name:'Wolfhouse'}]};
    else{entry.unknown=true;return route.abort();}
    return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await ctx.addInitScript(()=>{localStorage.setItem('wh_staff_portal_locale','en');window.copiedLinks=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.copiedLinks.push(text)}});});
  const page=await ctx.newPage(); page.on('pageerror',e=>errors.push(String(e)));
  try{
    await page.goto(ORIGIN+'/staff/ui');
    await page.waitForFunction(()=>typeof window.switchToTab==='function' && document.getElementById('c-client').value==='wolfhouse-somo');
    await page.evaluate(()=>window.switchToTab('bed-calendar'));
    await page.locator('.bc-block').first().click(); await page.mouse.move(1300,500);
    await page.locator('#bc-inv-totals').waitFor();
    await page.waitForFunction(()=>{const r=document.getElementById('bc-side-drawer').getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth+1;});
    const paid=page.locator('#bc-inv-totals .ctx-inv-total-amount.paid');
    const balance=page.locator('#bc-inv-totals .ctx-inv-total-amount.owing');
    async function alignment(){
      const [a,b]=await page.evaluate(()=>['.paid','.owing'].map(c=>{const r=document.querySelector('#bc-inv-totals .ctx-inv-total-amount'+c).getBoundingClientRect();return {x:r.x,width:r.width};}));
      assert(Math.abs(a.x+a.width-b.x-b.width)<1,`Paid and Balance amount right edges differ: ${a.x+a.width} vs ${b.x+b.width}`);
    }
    await alignment(); cases.push('paid-balance-column-alignment');
    await page.locator('#bc-generate-payment-link-btn').click();
    await page.locator('#bc-payment-link-result a').waitFor();
    assert.equal(await page.locator('#bc-generate-payment-link-btn').count(),0,'Balance Create must be replaced, not kept beside a second result row');
    assert(await page.locator('#bc-payment-link-result').evaluate(e=>e.closest('.ctx-inv-total-row')?.querySelector('.owing')),'link stays in Balance row');
    await alignment(); cases.push('balance-create-replaces-inline');
    const deposit=page.locator('#bc-inv-totals .bc-invoice-deposit-amount');
    assert.equal(await deposit.count(),1,'Deposit row exists under Invoice total');
    assert.equal(await deposit.innerText(),'€200.00');
    assert.equal(await deposit.getAttribute('data-deposit-state'),'unpaid');
    assert(await deposit.evaluate(e=>e.parentElement.previousElementSibling.textContent.includes('Invoice total')));
    async function refresh(){
      await page.locator('#bc-refresh-links-btn').click();
      await page.waitForFunction(()=>{const btn=document.getElementById('bc-refresh-links-btn');const box=document.getElementById('bc-invoice-feedback');return btn&&!btn.disabled&&box&&!/Amounts refreshed|Refreshing/i.test(box.textContent);});
    }
    for(const [amount,depositState,balanceText] of [[5000,'unpaid','€550.00'],[20000,'paid','€400.00']]){
      state.payments.paid_total_cents=amount;state.payments.rows=[{payment_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',payment_status:'paid',amount_paid_cents:amount}];
      await refresh();
      assert.equal(await deposit.getAttribute('data-deposit-state'),depositState);
      assert.equal(await balance.innerText(),balanceText,'subtract actual receipts once, never subtract unpaid deposit');
      await alignment();
    }
    cases.push('deposit-unpaid-partial-paid-status-and-truthful-balance');
    state.payments.paid_total_cents=0;state.payments.rows=[];await refresh();
    assert.equal(await page.locator('#bc-generate-deposit-link-btn').count(),1,'unpaid Deposit has its own Create');
    await page.locator('#bc-generate-deposit-link-btn').click();
    await page.locator('#bc-deposit-link-result a').waitFor();
    assert.equal(await page.locator('#bc-generate-deposit-link-btn').count(),0);
    assert.equal(await page.locator('#bc-deposit-link-result a').innerText(),'Deposit');
    assert(await page.locator('#bc-deposit-link-result').evaluate(e=>e.closest('.ctx-inv-total-row')?.querySelector('.bc-invoice-deposit-amount')));
    assert.equal(ledger.filter(e=>e.syntheticWrite).at(-1).body.payment_target,'deposit');
    assert.equal(ledger.filter(e=>e.syntheticWrite).at(-1).body.amount_cents,undefined,'UI never chooses provider cents');
    cases.push('deposit-create-replaces-inline-explicit-target');
    for(const theme of ['light','dark']){
      await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),theme);
      for(const amount of [0,20000]){
        state.payments.paid_total_cents=amount;state.payments.rows=amount?[{payment_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',payment_status:'paid',amount_paid_cents:amount}]:[];await refresh();
        const rgb=await deposit.evaluate(e=>getComputedStyle(e).color);
        const [r,g]=rgb.match(/[\d.]+/g).map(Number);
        assert(amount ? g>r : r>g,`Deposit ${amount?'paid green':'unpaid red'} in ${theme}: ${rgb}`);
      }
    }
    cases.push('deposit-red-green-both-themes');
    state.payments.paid_total_cents=0;state.payments.rows=[];await refresh();
    async function createTotals(){
      for(const [button,result] of [['#bc-generate-deposit-link-btn','#bc-deposit-link-result'],['#bc-generate-payment-link-btn','#bc-payment-link-result']]){
        await page.locator(button).click();await page.locator(result+' a').waitFor();
      }
    }
    await createTotals();
    if(await page.locator('#bc-per-guest-toggle').getAttribute('aria-expanded')!=='true') await page.locator('#bc-per-guest-toggle').click();
    await page.locator('.bc-create-guest-payment-link-btn[data-payment-target="remaining_share"]').click();
    await page.locator('#bc-inv-per-guest .bc-inline-payment-link').waitFor();
    for(const [result,target] of [['#bc-deposit-link-result','deposit'],['#bc-payment-link-result','balance']]){
      await page.locator(result+' .btn-bc-copy-link-icon').click();
      assert.equal(await page.evaluate(()=>window.copiedLinks.at(-1)),'https://checkout.stripe.com/c/pay/'+target+'-test-only');
      assert.equal(await page.locator(result+' .btn-bc-copy-link-icon').getAttribute('aria-label'),'Copied');
    }
    const writesBeforeReset=ledger.filter(e=>e.syntheticWrite).length;
    await refresh();
    assert.equal(await page.locator('#bc-inv-totals .bc-inline-payment-link,#bc-inv-per-guest .bc-inline-payment-link').count(),0);
    assert.equal(await page.locator('#bc-inv-totals .bc-total-create-link').count(),2);
    assert.equal(await page.locator('.bc-create-guest-payment-link-btn[data-payment-target="remaining_share"]').count(),1);
    assert.equal(ledger.filter(e=>e.syntheticWrite).length,writesBeforeReset,'reset/refresh never revokes or generates checkout');
    cases.push('copy-both-totals-and-reset-all-three-surfaces-read-only');
    for(const target of ['deposit','balance']){
      const button=target==='deposit'?'#bc-generate-deposit-link-btn':'#bc-generate-payment-link-btn';
      const result=target==='deposit'?'#bc-deposit-link-result':'#bc-payment-link-result';
      linkFailure=true;await page.locator(button).click();
      await page.waitForFunction(id=>document.querySelector(id).textContent.includes('Synthetic unavailable'),result);
      assert(await page.locator(button).isEnabled());
      const firstIntent=ledger.filter(e=>e.syntheticWrite).at(-1).body.idempotency_key;
      await page.locator(button).click();await page.locator(result+' a').waitFor();
      assert.equal(ledger.filter(e=>e.syntheticWrite).at(-1).body.idempotency_key,firstIntent,'ambiguous retry preserves intent');
      await refresh();
      invalidUrl=true;await page.locator(button).click();
      await page.waitForFunction(id=>document.querySelector(id).textContent.length>0,result);
      assert.equal(await page.locator(result+' a').count(),0,'unsafe URL rejected');
      assert(await page.locator(button).isEnabled());
      await refresh();
      for(const failRefresh of [false,true]){
        releaseLink=null;deferTarget=target;await page.locator(button).click();
        const deadline=Date.now()+3000;while(!releaseLink&&Date.now()<deadline)await new Promise(r=>setImmediate(r));
        assert.equal(typeof releaseLink,'function');
        if(failRefresh){contextFailure=true;await page.locator('#bc-refresh-links-btn').click();await page.waitForFunction(()=>document.getElementById('bc-invoice-feedback').textContent.includes('Refresh failed'));}
        else await refresh();
        const response=page.waitForResponse(r=>r.url().includes('generate-payment-link'));releaseLink();await response;
        await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
        assert.equal(await page.locator(result+' a').count(),0,'late URL cannot survive reset, even a failed read');
        assert(await page.locator(button).isEnabled(),'remounted Create recovers');
      }
    }
    cases.push('both-targets-errors-retry-url-validation-and-late-reset-fences');
    for(const required of [null,0]){
      state.booking.deposit_required_cents=required;
      state.booking.check_in=null;state.booking.check_out=null;state.booking.guest_count=null;
      await refresh();
      assert.equal(await deposit.innerText(),required===null?'—':'€0.00');
      assert.equal(await page.locator('#bc-generate-deposit-link-btn').count(),0);
    }
    state.booking.check_in='2026-09-24';state.booking.check_out='2026-09-29';state.booking.guest_count=2;
    state.booking.deposit_required_cents=18000;
    for(const amount of [20000,60000,65000]){
      state.payments.rows=[{payment_status:'paid',amount_paid_cents:amount}];await refresh();
      assert.equal(await page.locator('#bc-generate-deposit-link-btn').count(),0);
      assert.equal(await page.locator('#bc-generate-payment-link-btn').count(),amount<60000?1:0);
    }
    state.payments.rows=[];state.booking.status='cancelled';await refresh();
    assert.equal(await page.locator('#bc-inv-totals .bc-total-create-link').count(),0);
    state.booking.status='confirmed';await refresh();
    cases.push('unknown-zero-paid-overpaid-cancelled-deposit-eligibility');
    for(const width of [1440,390,320]){
      await page.setViewportSize({width,height:1000});
      for(const theme of ['light','dark']){
        await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),theme);
        await refresh();await alignment();
        await page.locator('#bc-inv-totals').scrollIntoViewIfNeeded();
        await page.locator('#bc-inv-totals').screenshot({path:path.join(OUT,`local-synthetic-totals-${width}-${theme}-create.png`)});
        await createTotals();await alignment();
        const layout=await page.locator('#bc-inv-totals').evaluate(e=>{
          const amounts=[...e.querySelectorAll('.ctx-inv-total-amount')].map(n=>n.getBoundingClientRect().right);
          const links=[...e.querySelectorAll('.bc-inline-payment-link')].map(n=>({r:n.getBoundingClientRect().toJSON(),amount:n.closest('.ctx-inv-total-row').querySelector('.ctx-inv-total-amount').getBoundingClientRect().toJSON()}));
          const ancestors=[];for(let n=e;n;n=n.parentElement){const s=getComputedStyle(n);ancestors.push({id:n.id,cls:n.className,r:n.getBoundingClientRect().toJSON(),width:s.width,minWidth:s.minWidth,overflow:s.overflowX,display:s.display});}
          return {amounts,links,ancestors,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth};
        });
        assert(layout.amounts.every(x=>Math.abs(x-layout.amounts[0])<1),'all totals use one amount column');
        assert(layout.links.every(l=>l.r.left>=l.amount.right && Math.abs(l.r.y+l.r.height/2-l.amount.y-l.amount.height/2)<3),'links stay right and vertically inline');
        assert(layout.scrollWidth<=layout.clientWidth+1,'no totals horizontal overflow');
        fs.writeFileSync(path.join(OUT,`layout-${width}-${theme}.json`),JSON.stringify(layout,null,2));
        assert(layout.links.every(l=>l.r.left>=0 && l.r.right<=width),'entire link including copy icon remains inside viewport');
        assert(layout.ancestors.filter(a=>a.display!=='contents'&&['hidden','auto','scroll','clip'].includes(a.overflow)).every(a=>layout.links.every(l=>l.r.left>=a.r.left-1&&l.r.right<=a.r.right+1)),'link and copy fit every horizontal clipping ancestor');
        await page.locator('#bc-inv-totals').screenshot({path:path.join(OUT,`local-synthetic-totals-${width}-${theme}-links.png`)});
      }
    }
    cases.push('desktop-phone-320-light-dark-alignment-inline-no-overflow');
  }catch(e){failure=e.stack;}
  finally{
    await page.screenshot({path:path.join(OUT,'local-synthetic-totals.png')});
    fs.writeFileSync(path.join(OUT,'network.json'),JSON.stringify({ledger,errors},null,2));
    const blocked=ledger.filter(e=>e.unknown||(e.blocked && !e.url.startsWith('https://fonts.googleapis.com/')));
    if(errors.length||blocked.length)failure=(failure||'')+'\nIsolation/errors: '+JSON.stringify({errors,blocked});
    fs.writeFileSync(path.join(OUT,'results.json'),JSON.stringify({cases,failure,localSynthetic:true},null,2));
    console.log(JSON.stringify({cases,failure,out:OUT},null,2));
    await browser.close();
  }
  if(failure)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
