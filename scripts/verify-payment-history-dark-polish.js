'use strict';
// Offline production HTML + native calendar click. Synthetic read-only HTTP fixtures.
// No live API, payment actions or server. Output includes CSS, screenshots and request ledger.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'tmp/payment-history-dark-polish'));
const ORIGIN = 'http://staff.test';
const booking = { booking_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', booking_code:'WH-DARK-TEST',
  guest_name:'Synthetic Guest', guest_count:1, total_amount_cents:30000, accommodation_total_cents:30000,
  deposit_required_cents:9000, amount_paid_cents:9000, balance_due_cents:21000,
  status:'confirmed', check_in:'2026-09-24', check_out:'2026-09-29', nights:5 };
const guest = { booking_guest_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', guest_number:1,
  guest_name:'Synthetic Guest', assigned_bed_code:'R1-B1', metadata:{subtotal_cents:30000},
  deposit_amount_cents:9000, amount_paid_cents:9000, payment_status:'paid' };
const detail = { success:true, booking, booking_guests:[guest], rooming:{assignments:[]}, per_person:[],
  guest_accommodation_lines:[{guest_number:1,accommodation_cents:30000,nights:5}],
  service_records:[], transfers:[], pending_manual_services:[], conversation:null,
  payments:{paid_total_cents:9000, rows:[{payment_id:'synthetic-receipt',payment_status:'paid',
    amount_paid_cents:9000, booking_guest_id:guest.booking_guest_id, created_at:'2026-09-26T10:00:00Z',
    paid_at:'2026-09-26T10:01:00Z',metadata:{method:'bank_transfer',payment_scope:'guest',note:'Offline synthetic receipt'}}]} };
const calendar = { success:true,
  days:Array.from({length:14},(_,i)=>({date:new Date(Date.UTC(2026,8,24+i)).toISOString().slice(0,10)})),
  rooms:[{room_code:'R1',room_name:'Synthetic Room',beds:[{bed_code:'R1-B1',bed_label:'Bed 1'}]}],
  blocks:[{...booking,room_code:'R1',bed_code:'R1-B1',start_date:'2026-09-24',end_date:'2026-09-29',
    source:'staff',start_offset:0,span:5}],warnings:[] };
async function main() {
  fs.mkdirSync(OUT,{recursive:true});
  const dest = path.join(OUT,'wolfhouse-somo.html');
  const emitted=spawnSync(process.execPath,['scripts/verify-inbox-ui-parity.js','--emit','wolfhouse-somo',dest],
    {cwd:ROOT,encoding:'utf8',env:{...process.env,STAFF_ACTIONS_ENABLED:'true',STRIPE_LINKS_ENABLED:'true'}});
  assert.equal(emitted.status,0,emitted.stderr || emitted.stdout);
  const html=fs.readFileSync(dest,'utf8');
  const browser=await chromium.launch({headless:true});
  const report={cases:[],ledger:[],errors:[],failures:[]};
  try {
    for(const width of [1440,390]) for(const theme of ['dark','light']) {
      const ctx=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block',reducedMotion:'reduce'});
      await ctx.routeWebSocket('**/*',ws=>{report.failures.push('Unexpected WebSocket: '+ws.url());ws.close();});
      await ctx.route('**/*',async route=>{
        const req=route.request(),url=new URL(req.url()),entry={case:`${width}-${theme}`,method:req.method(),url:req.url()};
        report.ledger.push(entry);
        if(url.origin==='https://fonts.googleapis.com' && req.method()==='GET'){entry.offlineFont=true;return route.fulfill({contentType:'text/css',body:''});}
        if(url.origin!==ORIGIN || req.method()!=='GET'){entry.blocked=true;return route.abort();}
        const p=url.pathname;let data;
        if(p==='/staff/ui')return route.fulfill({contentType:'text/html',body:html});
        if(p==='/staff/bed-calendar')data=calendar;
        else if(p===`/staff/bookings/${booking.booking_code}/context`)data=detail;
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
        else if(p==='/staff/luna-intelligence/room-fill')return route.fulfill({status:403,json:{success:false,error:'Offline invoice-only fixture'}});
        else if(p==='/staff/admin/house-notes')data={success:true,notes:''};
        else if(p==='/staff/automated-notifications')data={success:true,notifications:[]};
        else if(p==='/staff/packages')data={success:true,packages:[]};
        else if(p==='/staff/conversations')data={success:true,conversations:[]};
        else if(p==='/staff/admin/config')data={success:true,...resolveTenantBusinessConfig('wolfhouse-somo','sunset-somo')};
        else if(p==='/staff/admin/config/rental-offerings')data={success:true,offerings:[]};
        else if(p===`/staff/bookings/${booking.booking_id}/services`)data={success:true,paid_requested_services:[],unscheduled_services:[],services_by_date:[]};
        else if(p===`/staff/bookings/${booking.booking_id}/transfers`)data={success:true,client_slug:'wolfhouse-somo',booking_id:booking.booking_id,booking_code:booking.booking_code,timezone:'Europe/Madrid',transfers_available:true,airports:[],transfers:[],defaults:{default_airport_code:'SDR'}};
        else if(p==='/staff/clients')data={success:true,clients:[{slug:'wolfhouse-somo',name:'Wolfhouse'}]};
        else {entry.unknown=true;return route.abort();}
        return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
      });
      await ctx.addInitScript(()=>localStorage.setItem('wh_staff_portal_locale','en'));
      const page=await ctx.newPage();page.on('pageerror',e=>report.errors.push(String(e)));
      await page.goto(ORIGIN+'/staff/ui');
      await page.waitForFunction(()=>typeof window.switchToTab==='function' && document.getElementById('c-client').value==='wolfhouse-somo');
      await page.evaluate(t=>{document.documentElement.setAttribute('data-theme',t);window.switchToTab('bed-calendar');},theme);
      await page.locator('.bc-block').first().click();await page.mouse.move(0,0);
      await page.locator('#bc-inv-totals').waitFor();
      assert.equal(await page.locator('#bc-payment-history-body').isVisible(),false);
      const observation={width,theme};report.cases.push(observation);
      async function styles() {
        return page.evaluate(()=>{
          const result={};
          for(const sel of ['#bc-payment-history-card','#bc-per-guest-card','#bc-move-bed','#bc-overview-invoice',
            '#bc-payment-history-toggle','#bc-per-guest-toggle','#bc-move-bed-toggle',
            '#bc-payment-history-card .bc-drawer-card-title','#bc-per-guest-card .bc-drawer-card-title',
            '.bc-history-amount','.bc-guest-pay-paid','.ctx-pay-record','.ctx-pay-amount.paid']) {
            const e=document.querySelector(sel);if(!e)continue;
            const s=getComputedStyle(e);const r=e.getBoundingClientRect();
            result[sel]={background:s.backgroundColor,color:s.color,border:s.borderTop,borderRadius:s.borderRadius,
              shadow:s.boxShadow,fontSize:s.fontSize,fontWeight:s.fontWeight,padding:s.padding,
              width:r.width,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth};
          }
          return result;
        });
      }
      observation.collapsed=await styles();
      await page.locator('#bc-payment-history-toggle').scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(OUT,`${width}-${theme}-collapsed.png`)});
      await page.locator('#bc-payment-history-toggle').click();
      await page.locator('#bc-per-guest-toggle').click();
      assert.equal(await page.locator('#bc-payment-history-body').isVisible(),true);
      assert.equal(await page.locator('.bc-history-item').count(),1);
      await page.locator('.bc-history-item summary').click();
      assert.equal(await page.locator('html').getAttribute('data-portal-client'),null,'native Wolfhouse lodging profile');
      observation.expanded=await styles();
      const css=observation.expanded;
      for(const key of ['background','border','borderRadius','shadow']) {
        assert.equal(css['#bc-payment-history-card'][key],css['#bc-move-bed'][key],`existing sibling chrome: ${key}`);
      }
      for(const key of ['fontSize','fontWeight','color']) {
        assert.equal(css['#bc-payment-history-card .bc-drawer-card-title'][key],css['#bc-per-guest-card .bc-drawer-card-title'][key],`existing header: ${key}`);
      }
      assert.equal(css['.bc-history-amount'].background,'rgba(0, 0, 0, 0)','no opaque money chip');
      if(theme==='dark') {
        if(css['#bc-payment-history-card'].color!==css['#bc-per-guest-card'].color)
          report.failures.push(`${width}: dark Payment History primary ink ${css['#bc-payment-history-card'].color} != Per Guest ${css['#bc-per-guest-card'].color}`);
        if(css['.bc-history-amount'].fontWeight!==css['.bc-guest-pay-paid'].fontWeight)
          report.failures.push(`${width}: dark Payment History amount weight ${css['.bc-history-amount'].fontWeight} != Per Guest ${css['.bc-guest-pay-paid'].fontWeight}`);
        assert.equal(css['.bc-history-amount'].color,css['.bc-guest-pay-paid'].color,'paid green retained');
      }
      await page.locator('#bc-payment-history-card').scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(OUT,`${width}-${theme}-expanded.png`)});
      assert.match(await page.locator('.bc-history-item summary').innerText(),/€90.00/);
      assert.match(await page.locator('.ctx-pay-record').innerText(),/Offline synthetic receipt/);
      await page.locator('#bc-payment-history-toggle').focus();
      await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
      observation.focus=await page.locator('#bc-payment-history-toggle').evaluate(e=>({active:document.activeElement===e,outline:getComputedStyle(e).outlineStyle,width:getComputedStyle(e).outlineWidth}));
      assert.equal(observation.focus.active,true);assert.notEqual(observation.focus.outline,'none');
      await page.keyboard.press('Enter');assert.equal(await page.locator('#bc-payment-history-body').isVisible(),false);
      await page.keyboard.press('Enter');assert.equal(await page.locator('#bc-payment-history-body').isVisible(),true);
      const moneyBefore=await page.locator('#bc-inv-totals').innerText();
      await page.locator('#bc-refresh-links-btn').click();
      await page.waitForFunction(()=>!document.getElementById('bc-refresh-links-btn').disabled);
      assert.equal(await page.locator('#bc-payment-history-toggle').getAttribute('aria-expanded'),'true','refresh preserves disclosure');
      assert.equal(await page.locator('#bc-inv-totals').innerText(),moneyBefore,'refresh preserves totals');
      // Mobile uses the inline detail panel, not the desktop side-rail close button.
      // Reload and re-enter through Schedule for a deterministic fresh ordinary entry on both layouts.
      await page.reload();
      await page.waitForFunction(()=>typeof window.switchToTab==='function' && document.getElementById('c-client').value==='wolfhouse-somo');
      // The selected Schedule tab is restored; on mobile its header can be auto-hidden.
      assert.match(await page.locator('#tab-bed-calendar').getAttribute('class'),/active/);
      await page.locator('.bc-block').first().click();
      await page.locator('#bc-inv-totals').waitFor();
      assert.equal(await page.locator('#bc-payment-history-toggle').getAttribute('aria-expanded'),'false','fresh reopen collapsed');
      await page.locator('#bc-payment-history-toggle').click();
      assert.match(await page.locator('.bc-history-item summary').innerText(),/€90.00/,'receipt retained on reopen');
      observation.lifecycle='keyboard, refresh and native reopen passed';
      await ctx.close();
    }
    assert.equal(report.cases.length,4);
    assert.deepEqual(report.errors,[]);
    assert.deepEqual(report.ledger.filter(r=>r.blocked || r.unknown),[]);
    assert.deepEqual(report.failures,[]);
    console.log('PASS verify-payment-history-dark-polish: 4 offline native-entry cases');
  } catch(error) {report.failure=String(error.stack || error);throw error;}
  finally {fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2)+'\n');await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
