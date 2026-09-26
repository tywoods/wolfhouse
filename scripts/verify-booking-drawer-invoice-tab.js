'use strict';

// Production /staff/ui, real calendar block + tab clicks; only HTTP data is synthetic.
// No server, live credentials or outbound network. Usage: node scripts/verify-booking-drawer-tabs-chrome.js [artifact-dir]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'tmp/booking-drawer-invoice-tab'));
const ORIGIN = 'http://staff.test';
const CODE = 'WH-CHROME-TEST';
const booking = { booking_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', booking_code: CODE,
  guest_name: 'Tom (test)', guest_count: 2, total_amount_cents:60000, accommodation_total_cents:60000, amount_paid_cents:0, balance_due_cents:60000, status: 'confirmed', check_in: '2026-09-24', check_out: '2026-09-29', nights: 5 };
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
  fs.mkdirSync(OUT, { recursive: true });
  const results = [], failures = [];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const tenant of ['wolfhouse-somo', 'sunset']) {
      const html = emit(tenant);
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
      const ledger = [], errors = [], receipts = [];
      const state = JSON.parse(JSON.stringify(detail));
      let receiptFailure = false, contextFailure = false, deferGuest = false, releaseGuest;
      let deferContext = false, releaseContext;
      const other = JSON.parse(JSON.stringify(detail));
      other.booking.booking_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      other.booking.booking_code = 'WH-OTHER';
      other.booking.total_amount_cents = other.booking.balance_due_cents = 99000;
      other.booking.guest_name = 'Other booking'; other.booking_guests = []; other.guest_accommodation_lines = [];
      const cal = JSON.parse(JSON.stringify(calendar));
      cal.blocks.push({...cal.blocks[0],...other.booking,bed_code:'R1-B2'});
      await ctx.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        const entry = { method: req.method(), url: req.url() }; ledger.push(entry);
        if (url.origin === ORIGIN && req.method() === 'POST' && ['/staff/bookings/generate-payment-link','/staff/bookings/cancel-payment-link'].includes(url.pathname)) {
          entry.body=req.postDataJSON();entry.syntheticWrite=true;
          return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,checkout_url:'https://checkout.stripe.com/c/pay/booking-test-only'})});
        }
        if (url.origin === ORIGIN && req.method() === 'POST' && url.pathname === '/staff/bookings/generate-guest-payment-link') {
          entry.body=req.postDataJSON(); entry.syntheticWrite=true;
          if(deferGuest) { deferGuest=false; await new Promise(resolve=>{releaseGuest=resolve;}); }
          return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,checkout_url:'https://checkout.stripe.com/c/pay/test-only'})});
        }
        if (url.origin === ORIGIN && req.method() === 'POST' && url.pathname === '/staff/bookings/record-cash-payment') {
          const body = req.postDataJSON(); entry.body = body; entry.syntheticWrite = true; receipts.push(body);
          if (receiptFailure) { receiptFailure=false; return route.abort('failed'); }
          state.payments.paid_total_cents += body.amount_cents;
          const namedGuest = state.booking_guests.find(g=>g.booking_guest_id===body.booking_guest_id);
          if (namedGuest) { namedGuest.amount_paid_cents += body.amount_cents; namedGuest.payment_status = 'paid'; }
          state.payments.rows.push({payment_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc', payment_status:'paid', amount_paid_cents:body.amount_cents, booking_guest_id:body.booking_guest_id, metadata:{method:body.method,source:'staff_'+body.method}});
          return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true})});
        }
        if (req.method() !== 'GET' || url.origin !== ORIGIN) { entry.blocked = true; return route.abort(); }
        const p = url.pathname;
        if (p === '/staff/ui') return route.fulfill({ contentType: 'text/html', body: html });
        let data;
        if (p === '/staff/bed-calendar') data = cal;
        else if (p === `/staff/bookings/${CODE}/context`) {
          if(contextFailure){contextFailure=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({success:false})});}
          if(deferContext){deferContext=false; await new Promise(resolve=>{releaseContext=resolve;});}
          data = state;
        }
        else if (p === '/staff/bookings/WH-OTHER/context') data = other;
        else if (p === '/staff/auth/session') data = { success: true, auth_required: false, role: 'admin', clients: [{ slug: tenant, name: tenant }], client_profiles: { [tenant]: loadClientPortalProfile(tenant) } };
        else if (p.startsWith('/staff/assets/')) {
          const asset = path.join(ROOT, 'config/staff-portal', path.basename(p));
          if (fs.existsSync(asset)) return route.fulfill({ path: asset });
          entry.missingAsset = true; return route.abort();
        }
        else if (p === '/staff/intents') data = { success: true, intents: [] };
        else if (p === '/staff/inbox/luna-mode') data = { success: true, mode: 'off' };
        else if (p === '/staff/bot/global-pause-state') data = { success: true, paused: false };
        else if (p === '/staff/whatsapp-numbers') data = { success: true, numbers: [] };
        else if (p === '/staff/admin/house-notes') data = { success: true, notes: '' };
        else if (p === '/staff/automated-notifications') data = { success: true, notifications: [] };
        else if (p === '/staff/packages') data = { success: true, packages: [] };
        else if (p === '/staff/conversations') data = { success: true, conversations: [] };
        else if (p === '/staff/admin/config') data = { success: true, ...resolveTenantBusinessConfig(tenant, 'sunset-somo') };
        else if (p === '/staff/admin/config/rental-offerings') data = { success: true, offerings: [] };
        else if (p === '/staff/schedule/bookings/catalog') data = { success: true, offerings: [], courses: [] };
        else if (p === '/staff/schedule/day') data = { success: true, date: url.searchParams.get('date'), lessons: [], gear: [], rows: [] };
        else if ([booking.booking_id,other.booking.booking_id].some(id=>p === `/staff/bookings/${id}/services`)) data = { success: true, paid_requested_services: [], unscheduled_services: [], services_by_date: [] };
        else if ([booking.booking_id,other.booking.booking_id].some(id=>p === `/staff/bookings/${id}/transfers`)) data = { success: true, transfers: [] };
        else if (p === '/staff/clients') data = { success: true, clients: [{ slug: tenant, name: tenant }] };
        else { entry.unknown = true; return route.abort(); }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
      });
      await ctx.addInitScript(() => localStorage.setItem('wh_staff_portal_locale', 'en'));
      const page = await ctx.newPage();
      page.on('pageerror', e => errors.push(String(e)));
      try {
        await page.goto(`${ORIGIN}/staff/ui`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(t => typeof window.switchToTab === 'function' && document.getElementById('c-client').value === t, tenant);
        await page.evaluate(() => window.switchToTab('bed-calendar'));
        if (tenant === 'sunset') {
          // Source profile hides the lodging calendar and its four-tab drawer.
          // Do not spoof Wolfhouse's profile to manufacture Sunset acceptance.
          await page.waitForFunction(() => document.getElementById('tab-portal-home').classList.contains('active'));
          assert.equal(await page.locator('#bc-grid-resize-handle').isVisible(), false);
          assert.equal(await page.locator('#bc-side-drawer .bc-drawer-tab').count(), 0);
          await page.screenshot({ path: path.join(OUT, 'sunset-desktop-native-profile.png') });
          results.push({ name: 'sunset-native-profile', defaultTab: 'portal-home', lodgingCalendarHidden: true, note: 'No four-tab lodging drawer in ordinary Sunset entrypoint; not live staging evidence.' });
          continue;
        }
        await page.locator('.bc-block').first().click();
        await page.locator('#bc-side-drawer .bc-drawer-tab').first().waitFor();
        const tabs = await page.locator('#bc-side-drawer .bc-drawer-tab').evaluateAll(els => els.map(e => e.dataset.tab));
        assert.deepEqual(tabs, ['overview', 'services', 'transfers', 'payments']);
        assert.equal(await page.locator('[data-tab="overview"].bc-drawer-tab').innerText(), 'Invoice');
        const history = page.locator('#bc-drawer-tab-overview #bc-payment-history-toggle');
        await history.waitFor({state:'attached',timeout:8000});
        assert.equal(await history.count(), 1, 'history belongs to Invoice');
        const toggleStyles = await page.locator('#bc-payment-history-toggle, #bc-move-bed-toggle').evaluateAll(es=>es.map(e=>{const s=getComputedStyle(e);return [s.display,s.borderWidth,s.backgroundColor,s.justifyContent];}));
        assert.deepEqual(toggleStyles[0],toggleStyles[1],'history header matches Move Bed chrome');
        assert.equal(await page.locator('#bc-payment-history-card').count(), 1, 'one mounted history');
        assert.equal(await history.getAttribute('aria-expanded'), 'false');
        assert(await page.locator('#bc-payment-history-card').evaluate(el=>el.classList.contains('is-collapsed')),'history shares Move Bed collapsed chevron state');
        assert.equal(await page.locator('#bc-payment-history-body').isVisible(), false);
        await history.focus(); await page.keyboard.press('Enter');
        assert.equal(await history.getAttribute('aria-expanded'), 'true');
        assert.equal(await page.locator('#bc-payment-history-body').isVisible(), true);
        assert.match(await page.locator('#bc-payment-history-body').innerText(), /No payments/i);
        assert.equal(await page.locator('#bc-move-bed-toggle').getAttribute('aria-expanded'), 'false');
        await page.keyboard.press('Space');
        assert.equal(await history.getAttribute('aria-expanded'), 'false');
        assert(await page.locator('#bc-payment-history-card').evaluate(el=>el.classList.contains('is-collapsed')),'history shares Move Bed collapsed chevron state');
        await page.locator('#bc-side-drawer').screenshot({path:path.join(OUT,'invoice-local-synthetic.png')});
        results.push({name:'invoice-history', paymentTabRetained:true, localSynthetic:true});
        assert.equal(await page.locator('#bc-record-payment-btn').count(), 1, 'Record Payment below Per Guest');
        await page.locator('#bc-record-payment-btn').click();
        const dialog = page.locator('#bc-record-payment-dialog');
        assert.equal(await dialog.isVisible(), true);
        assert.equal(await page.locator('#bc-payment-scope').inputValue(), '');
        assert.equal(await page.locator('#bc-payment-amount').inputValue(), '');
        assert.equal(await page.locator('input[name="bc-payment-method"]:checked').count(), 0);
        await page.keyboard.press('Escape');
        assert.equal(await dialog.isVisible(), false);
        assert.equal(await page.locator('#bc-record-payment-btn').evaluate(e => e === document.activeElement), true);
        results.push({name:'record-payment-dialog-cancel', zeroMutations:true});
        await page.locator('#bc-record-payment-btn').click();
        await page.locator('#bc-payment-scope').selectOption(GUEST);
        assert.equal(await page.locator('#bc-payment-use-outstanding').isVisible(),true,'persisted guest share shown');
        await page.locator('#bc-payment-use-outstanding').click();
        assert.equal(await page.locator('#bc-payment-amount').inputValue(),'300.00');
        await page.locator('#bc-payment-amount').fill('12,34');
        await page.locator('input[name="bc-payment-method"][value="cash"]').check();
        await page.locator('#bc-payment-submit').click();
        await page.waitForFunction(() => !document.getElementById('bc-record-payment-dialog'), {timeout:3000});
        assert.equal(receipts.length,1);
        assert.equal(receipts[0].amount_cents,1234);
        assert.equal(receipts[0].booking_guest_id,GUEST);
        assert.equal(receipts[0].method,'cash');
        assert.equal(receipts[0].payment_scope,'guest');
        assert.equal(receipts[0].booking_id,booking.booking_id);
        await page.waitForFunction(() => document.getElementById('bc-invoice-feedback').textContent.includes('Payment recorded'));
        assert.equal(await page.locator('#bc-inv-accommodation .bc-accom-pay-pebble').first().innerText(),'Unpaid','partial receipt is not a paid accommodation share');
        assert.equal(await page.locator('#bc-inv-totals .ctx-inv-total-amount.paid').innerText(),'€12.34');
        assert.equal(await page.locator('#bc-inv-totals .ctx-inv-total-amount.owing').innerText(),'€587.66');
        await page.locator('#bc-record-payment-btn').click(); await page.locator('#bc-payment-scope').selectOption(GUEST);
        await page.locator('#bc-payment-use-outstanding').click();
        assert.equal(await page.locator('#bc-payment-amount').inputValue(),'287.66','named remaining share uses the receipt projection');
        await page.locator('#bc-payment-cancel').click();
        assert.match(await page.locator('#bc-invoice-feedback').innerText(), /Payment recorded/);
        assert.equal(await page.locator('[data-tab=overview].bc-drawer-tab').getAttribute('aria-selected'),'true');
        assert.equal(await page.locator('#bc-payment-history-toggle').getAttribute('aria-expanded'),'false');
        results.push({name:'named-cash-payload-and-read-refresh', localSynthetic:true});
        const create = page.locator('.bc-create-guest-payment-link-btn[data-payment-target="remaining_share"]').first();
        await create.click();
        await page.locator('#bc-inv-per-guest .bc-inline-payment-link').waitFor();
        assert.equal(await page.locator('#bc-refresh-links-btn').count(),1,'Refresh Links exists');
        await page.locator('#bc-payment-history-toggle').click();
        const beforeRefreshWrites = ledger.filter(e=>e.method==='POST').length;
        await page.locator('#bc-refresh-links-btn').click();
        await page.waitForFunction(()=>document.getElementById('bc-invoice-feedback').textContent.includes('Amounts refreshed'));
        assert.equal(await page.locator('#bc-inv-per-guest .bc-inline-payment-link').count(),0);
        assert.equal(await page.locator('.bc-create-guest-payment-link-btn[data-payment-target="remaining_share"]').count(),1);
        assert.equal(ledger.filter(e=>e.method==='POST').length,beforeRefreshWrites,'refresh is GET only');
        assert.equal(await page.locator('#bc-payment-history-toggle').getAttribute('aria-expanded'),'true');
        assert.equal(await page.locator('#bc-generate-payment-link-btn').count(),1,'one balance action owner');
        results.push({name:'refresh-restores-create-read-only-preserves-history',localSynthetic:true});
        deferGuest = true;
        await page.locator('.bc-create-guest-payment-link-btn[data-payment-target="remaining_share"]').click();
        await page.waitForRequest(r=>false,{timeout:20}).catch(()=>{}); // bounded yield; response deliberately held below
        assert.equal(typeof releaseGuest,'function','provider-double response is held');
        await page.locator('#bc-refresh-links-btn').click();
        await page.waitForFunction(()=>document.getElementById('bc-invoice-feedback').textContent.includes('Amounts refreshed'));
        const lateResponse = page.waitForResponse(r=>r.url().includes('generate-guest-payment-link'));
        releaseGuest(); await lateResponse;
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        assert.equal(await page.locator('#bc-inv-per-guest .bc-inline-payment-link').count(),0,'late pre-refresh response cannot restore old URL');
        results.push({name:'late-create-fenced-after-refresh'});
        deferGuest = true; releaseGuest = null;
        await page.locator('.bc-create-guest-payment-link-btn[data-payment-target="remaining_share"]').click();
        // Route callback is synchronously entered by Playwright's request event.
        while (!releaseGuest) await new Promise(resolve=>setImmediate(resolve));
        contextFailure = true;
        await page.locator('#bc-refresh-links-btn').click();
        await page.waitForFunction(()=>document.getElementById('bc-invoice-feedback').textContent.includes('Refresh failed'));
        const failedRefreshLate = page.waitForResponse(r=>r.url().includes('generate-guest-payment-link'));
        releaseGuest(); await failedRefreshLate;
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        assert.equal(await page.locator('.bc-create-guest-payment-link-btn[data-payment-target="remaining_share"]').isEnabled(),true,'failed refresh restores usable controls');
        assert.equal(await page.locator('#bc-inv-per-guest .bc-inline-payment-link').count(),0,'failed refresh also fences late URL');
        results.push({name:'failed-refresh-restores-controls-without-replaying-create'});
        await page.locator('#bc-record-payment-btn').click();
        await page.locator('#bc-payment-scope').selectOption('booking');
        await page.locator('#bc-payment-amount').fill('4.001');
        await page.locator('input[name="bc-payment-method"][value="bank_transfer"]').check();
        await page.locator('#bc-payment-submit').click();
        assert.equal(receipts.length,1,'reject excess precision');
        await page.locator('#bc-payment-amount').fill('40.01');
        receiptFailure = true;
        await page.locator('#bc-payment-submit').click();
        await page.waitForFunction(()=>document.getElementById('bc-payment-error').textContent.includes('uncertain'));
        assert.equal(receipts.length,2);
        assert.equal(await page.locator('#bc-payment-amount').isDisabled(),true,'uncertain intent locked');
        await page.locator('#bc-payment-cancel').click();
        await page.locator('#bc-record-payment-btn').click();
        assert.equal(await page.locator('#bc-payment-amount').inputValue(),'40.01');
        contextFailure = true;
        await page.locator('#bc-payment-submit').dblclick();
        await page.waitForFunction(()=>document.getElementById('bc-invoice-feedback').textContent.includes('totals could not refresh'));
        assert.equal(receipts.length,3,'one retry despite double click');
        assert.equal(receipts[1].idempotency_key,receipts[2].idempotency_key);
        assert.equal(receipts[2].payment_scope,'booking');
        assert.equal(receipts[2].booking_guest_id,null);
        assert.equal(receipts[2].method,'bank_transfer');
        assert.equal(receipts[2].amount_cents,4001);
        await page.locator('#bc-refresh-links-btn').click();
        await page.waitForFunction(()=>document.getElementById('bc-invoice-feedback').textContent.includes('Amounts refreshed'));
        assert.equal(receipts.length,3,'read retry never records again');
        assert.equal(await page.locator('.bc-create-guest-payment-link-btn').count(),0,'unallocated receipt blocks unsafe guest collection');
        results.push({name:'all-bank-transfer-stable-retry-recorded-read-failure',localSynthetic:true});
        state.payments.rows.push({payment_id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',payment_status:'checkout_created',amount_due_cents:1000,checkout_url:'https://checkout.stripe.com/c/pay/history-test',stripe_checkout_session_id:'cs_test_history',metadata:{source:'staff_payment_link'}});
        await page.locator('#bc-refresh-links-btn').click();
        await page.waitForFunction(()=>document.getElementById('bc-invoice-feedback').textContent.includes('Amounts refreshed'));
        await page.locator('#bc-generate-payment-link-btn').click();
        await page.locator('#bc-payment-link-result a').waitFor();
        await page.locator('#bc-payment-history-body .btn-bc-cancel-link-icon').click();
        await page.locator('#bc-payment-history-body .btn-bc-cancel-link-confirm').click();
        await page.waitForResponse(r=>r.url().includes('/context'));
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        assert.equal(await page.locator('[data-tab=overview].bc-drawer-tab').getAttribute('aria-selected'),'true','cancel refresh must not jump to Payment');
        results.push({name:'visible-balance-create-history-cancel-in-invoice'});
        deferContext = true;
        await page.locator('#bc-payment-history-body .btn-bc-cancel-link-icon').click();
        await page.locator('#bc-payment-history-body .btn-bc-cancel-link-confirm').click();
        const deadline = Date.now()+3000;
        while(!releaseContext && Date.now()<deadline) await new Promise(resolve=>setImmediate(resolve));
        assert.equal(typeof releaseContext,'function','cancellation context GET held');
        await page.locator('#bc-side-close').click();
        await page.locator('.bc-block').nth(1).click();
        await page.waitForFunction(id=>document.getElementById('bc-side-drawer').getAttribute('data-mounted-booking-id')===id,other.booking.booking_id);
        const lateCancel = page.waitForResponse(r=>r.url().includes(CODE+'/context'));
        releaseContext(); await lateCancel;
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        assert.equal(await page.locator('#bc-side-drawer').getAttribute('data-mounted-booking-id'),other.booking.booking_id,'late cancellation cannot replace booking B');
        assert.match(await page.locator('#bc-drawer-tab-overview').innerText(),/990[.,]00/);
        results.push({name:'late-cancel-refresh-cannot-cross-bookings'});
        await page.locator('#bc-side-close').click();
        await page.locator('.bc-block').first().click();
        await page.locator('#bc-record-payment-btn').waitFor();
        assert.equal(await page.locator('#bc-payment-history-toggle').getAttribute('aria-expanded'),'false','new open is collapsed');
        for (const [size,width,height] of [['desktop',1440,1000],['phone',390,844]]) {
          await page.setViewportSize({width,height});
          for (const theme of ['light','dark']) {
            await page.evaluate(theme=>document.documentElement.setAttribute('data-theme',theme),theme);
            await page.locator('#bc-invoice-actions').scrollIntoViewIfNeeded();
            await page.screenshot({path:path.join(OUT,`local-synthetic-invoice-${size}-${theme}.png`)});
            await page.locator('#bc-record-payment-btn').click();
            assert.equal(await page.locator('#bc-payment-scope').evaluate(e=>e===document.activeElement),true);
            await page.locator('#bc-payment-submit').focus();
            await page.keyboard.press('Tab');
            assert.equal(await page.locator('#bc-payment-scope').evaluate(e=>e===document.activeElement),true,'native dialog focus trap');
            const box=await page.locator('#bc-record-payment-dialog').boundingBox();
            assert(box.x>=0 && box.x+box.width<=width+1,'dialog in viewport');
            assert.equal(await page.locator('#bc-record-payment-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
            await page.screenshot({path:path.join(OUT,`local-synthetic-record-payment-${size}-${theme}.png`)});
            await page.locator('#bc-payment-cancel').click();
            results.push({name:`visual-focus-${size}-${theme}`,localSynthetic:true});
          }
        }
      } catch (e) { failures.push(`${tenant}: ${e.stack}`); await page.screenshot({path:path.join(OUT,tenant+'-failure.png')}); fs.writeFileSync(path.join(OUT,tenant+'-layout.json'),JSON.stringify(await page.evaluate(()=>{var node=document.getElementById('bc-record-payment-btn'), out=[]; while(node){var r=node.getBoundingClientRect(),s=getComputedStyle(node);out.push({tag:node.tagName,id:node.id,top:r.top,bottom:r.bottom,scroll:node.scrollTop,height:node.clientHeight,scrollHeight:node.scrollHeight,overflow:s.overflowY});node=node.parentElement;}return out;}),null,2)); }
      finally {
        fs.writeFileSync(path.join(OUT, `${tenant}-network.json`), JSON.stringify({ ledger, errors }, null, 2));
        if (errors.length) failures.push(`${tenant}: JS errors: ${errors.join('; ')}`);
        if (ledger.some(e => e.method !== 'GET' && !e.syntheticWrite)) failures.push(`${tenant}: unexpected mutation attempt`);
        if (ledger.some(e => e.unknown || e.missingAsset)) failures.push(`${tenant}: unmocked paths: ${[...new Set(ledger.filter(e => e.unknown || e.missingAsset).map(e => e.url))].join(', ')}`);
        if (ledger.some(e => /[?&]client(?:_slug)?=undefined/.test(e.url))) failures.push(`${tenant}: invalid tenant in request`);
        await ctx.close();
      }
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, failures }, null, 2));
  if (results.length !== 14) failures.push('Expected 14 complete cases, got '+results.length);
  console.log(JSON.stringify({ cases: results.length, failures, out: OUT }, null, 2));
  if (failures.length) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
