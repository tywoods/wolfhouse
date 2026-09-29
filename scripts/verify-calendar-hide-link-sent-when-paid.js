'use strict';
// Actual emitted portal and registered Schedule controls; only GET data is synthetic.
// No server, SQL, link cancellation, provider calls or forwarded network.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const { loadClientPortalProfile } = require('./lib/staff-portal-clients');
const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'tmp/calendar-hide-link-sent-browser'));
const ORIGIN = 'http://staff.test';
const TENANT = 'wolfhouse-somo';
const booking = { booking_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', booking_code:'WH-LINK-TEST', guest_name:'Paid group (synthetic)', guest_count:2, status:'confirmed', check_in:'2026-09-24', check_out:'2026-09-29' };
const calendar = {success:true,days:Array.from({length:14},(_,i)=>({date:new Date(Date.UTC(2026,8,24+i)).toISOString().slice(0,10)})),rooms:[{room_code:'R1',room_name:'Room 1',beds:[1,2].map(i=>({bed_code:'R1-B'+i,bed_label:'Bed '+i}))}],blocks:[1,2].map(i=>({...booking,guest_name:'Paid guest '+i,room_code:'R1',bed_code:'R1-B'+i,start_date:booking.check_in,end_date:booking.check_out,start_offset:0,span:5,source:'staff',invoice_total_cents:60000,ledger_paid_cents:60000,balance_due_cents:0,calendar_payment_primary:'paid',has_active_payment_link:true,calendar_group_size:2,calendar_guest_number:i,calendar_guest_share_cents:30000,calendar_guest_paid_cents:0,calendar_guest_deposit_cents:9000,calendar_guest_link_sent:true,calendar_show_payment_pills:i===1,calendar_guest_package_code:'uluwatu',transfer_summary:{has_transfer:true}})),warnings:[]};
calendar.rooms[0].beds.push({bed_code:'R1-B3',bed_label:'Bed 3'});
calendar.blocks.push({...calendar.blocks[0],booking_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',booking_code:'WH-SINGLE-TEST',guest_name:'Paid single (synthetic)',bed_code:'R1-B3',calendar_group_size:1,calendar_guest_number:null,calendar_guest_link_sent:null});
async function main(){
  fs.mkdirSync(OUT,{recursive:true});
  const dest=path.join(OUT,TENANT+'.html');
  const emitted=spawnSync(process.execPath,['scripts/verify-inbox-ui-parity.js','--emit',TENANT,dest],{cwd:ROOT,encoding:'utf8'});
  assert.equal(emitted.status,0,emitted.stderr||emitted.stdout);
  const html=fs.readFileSync(dest,'utf8'),ledger=[],errors=[],observations=[];
  const browser=await chromium.launch({headless:true});
  const ctx=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await ctx.routeWebSocket('**/*',ws=>{ledger.push({method:'WEBSOCKET',url:ws.url(),blocked:true});ws.close();});
  const fixtures={
    '/staff/auth/session':{success:true,auth_required:false,role:'admin',clients:[{slug:TENANT,name:'Wolfhouse'}],client_profiles:{[TENANT]:loadClientPortalProfile(TENANT)}},
    '/staff/intents':{success:true,intents:[]},'/staff/inbox/luna-mode':{success:true,mode:'off'},
    '/staff/bot/global-pause-state':{success:true,paused:false},'/staff/whatsapp-numbers':{success:true,numbers:[]},
    '/staff/admin/house-notes':{success:true,notes:''},'/staff/automated-notifications':{success:true,notifications:[]},
    '/staff/packages':{success:true,packages:[]},'/staff/conversations':{success:true,conversations:[]},
    '/staff/admin/config':{success:true,...resolveTenantBusinessConfig(TENANT,'sunset-somo')},
    '/staff/admin/config/rental-offerings':{success:true,offerings:[]},
    '/staff/clients':{success:true,clients:[{slug:TENANT,name:'Wolfhouse'}]}
  };
  const detail={success:true,booking:{...booking,total_amount_cents:60000,accommodation_total_cents:60000,amount_paid_cents:0,balance_due_cents:60000,deposit_required_cents:18000,nights:5},rooming:{assignments:[]},booking_guests:[1,2].map(i=>({booking_guest_id:i===1?'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb':'dddddddd-dddd-4ddd-8ddd-dddddddddddd',guest_number:i,guest_name:'Paid guest '+i,assigned_bed_code:'R1-B'+i,metadata:{subtotal_cents:30000,package_code:'uluwatu'},amount_paid_cents:0,deposit_amount_cents:9000,payment_status:'not_requested'})),guest_accommodation_lines:[1,2].map(i=>({guest_number:i,accommodation_cents:30000,nights:5})),per_person:[],service_records:[],transfers:[{direction:'arrival',status:'confirmed',price_cents:0}],payments:{rows:[]},pending_manual_services:[],conversation:null};
  const single=JSON.parse(JSON.stringify(detail));
  single.booking={...single.booking,booking_id:calendar.blocks[2].booking_id,booking_code:calendar.blocks[2].booking_code,guest_count:1};
  single.booking_guests=[{...single.booking_guests[0],assigned_bed_code:'R1-B3',metadata:{subtotal_cents:60000,package_code:'uluwatu'}}];
  single.guest_accommodation_lines=[{guest_number:1,accommodation_cents:60000,nights:5}];
  for(const d of [detail,single]){
    fixtures['/staff/bookings/'+d.booking.booking_code+'/context']=d;
    fixtures['/staff/bookings/'+d.booking.booking_id+'/services']={success:true,paid_requested_services:[],unscheduled_services:[],services_by_date:[]};
    fixtures['/staff/bookings/'+d.booking.booking_id+'/transfers']={success:true,client_slug:TENANT,booking_id:d.booking.booking_id,booking_code:d.booking.booking_code,transfers:d.transfers,airports:[],defaults:{}};
  }
  const assets=new Map(fs.readdirSync(path.join(ROOT,'config/staff-portal')).filter(f=>fs.statSync(path.join(ROOT,'config/staff-portal',f)).isFile()).map(f=>['/staff/assets/'+f,path.join(ROOT,'config/staff-portal',f)]));
  await ctx.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url()),entry={method:req.method(),url:req.url()};ledger.push(entry);
    if(req.method()==='GET'&&req.url()==='https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=Instrument+Sans:wght@400;500;600;700&display=swap'){entry.optionalFontBlocked=true;return route.abort();}
    if(u.origin!==ORIGIN||req.method()!=='GET'){entry.blocked=true;return route.abort();}
    if(u.pathname==='/staff/ui')return route.fulfill({contentType:'text/html',body:html});
    if(assets.has(u.pathname))return route.fulfill({path:assets.get(u.pathname)});
    const data=u.pathname==='/staff/bed-calendar'?calendar:fixtures[u.pathname];
    if(!data){entry.unknown=true;return route.abort();}
    return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await ctx.addInitScript(()=>localStorage.setItem('wh_staff_portal_locale','en'));
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(String(e)));
  let failure=null;
  try{
    await page.goto(ORIGIN+'/staff/ui');
    await page.waitForFunction(()=>typeof window.switchToTab==='function'&&document.getElementById('c-client').value==='wolfhouse-somo');
    await page.evaluate(()=>window.switchToTab('bed-calendar'));
    await page.locator('.bc-block').first().waitFor();
    const snapshot=await page.locator('.bc-block').evaluateAll(es=>es.map(e=>({text:e.textContent,title:e.getAttribute('title'),badges:[...e.querySelectorAll('.bc-block-pay-badge')].map(n=>n.textContent),package:e.querySelector('.pkg-pebble')?.textContent,transfer:e.querySelector('.transfer-pebble')?.textContent})));
    observations.push({name:'fully-paid-group-stale-links',snapshot});
    await page.screenshot({path:path.join(OUT,'local-synthetic-paid-group.png')});
    assert.equal(snapshot.length,3,'both group blocks and single booking rendered');
    snapshot.forEach(block=>{
      assert(block.badges.includes('Paid'),'authoritative full booking Paid retained');
      assert(!block.badges.includes('Link sent'),'fully paid booking block must hide stale Link sent badge');
      assert.equal(typeof block.title,'string','real tooltip present');
      assert(!/link sent/i.test(block.title),'fully paid booking tooltip must hide stale Link sent');
      assert.equal(block.package,'Uluwatu');assert.equal(block.transfer,'Transfer');
    });
    const original=JSON.parse(JSON.stringify(calendar.blocks));
    async function readBlocks(){
      const rows=await page.locator('.bc-block').evaluateAll(es=>es.map(e=>({title:e.getAttribute('title'),badges:[...e.querySelectorAll('.bc-block-pay-badge')].map(n=>n.textContent),package:e.querySelector('.pkg-pebble')?.textContent||null,transfer:e.querySelector('.transfer-pebble')?.textContent||null})));
      assert.equal(rows.length,3,'required group + single cardinality');
      return rows;
    }
    async function reloadCalendar(){
      const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/staff/bed-calendar');
      await page.locator('#bc-load').click();await response;
      await page.waitForFunction(()=>!document.getElementById('bc-load').disabled);
      await page.locator('.bc-block').first().waitFor();
    }
    const controls=[
      {name:'unpaid',invoice:60000,paid:0,guestPaid:[0,0],badges:[['€300.00'],['€300.00'],['€600.00']]},
      {name:'deposit-only',invoice:60000,paid:18000,guestPaid:[9000,9000],badges:[['€210.00','Deposit paid'],['€210.00','Deposit paid'],['€420.00','Deposit paid']]},
      {name:'partial',invoice:60000,paid:59999,guestPaid:[29999,30000],badges:[['€0.01','Deposit paid'],['Paid'],['€0.01','Deposit paid']]},
      {name:'individually-paid-unpaid-booking',invoice:60000,paid:30000,guestPaid:[30000,0],badges:[['Paid'],['€300.00'],['€300.00','Deposit paid']]},
      ...[null,0,'NaN','Infinity'].map(invoice=>({name:'unknown-total-'+String(invoice),invoice,paid:60000,guestPaid:[0,0],unknown:true,badges:[['€300.00'],['€300.00'],invoice==='Infinity'?['€Infinity']:[]]})),
      {name:'explicit-false-link',invoice:60000,paid:0,guestPaid:[0,0],link:false,badges:[['€300.00'],['€300.00'],['€600.00']]},
      {name:'blocked',invoice:60000,paid:0,guestPaid:[0,0],blocked:true,badges:[[],[],[]]},
      {name:'full-paid',invoice:60000,paid:60000,guestPaid:[0,0],full:true,badges:[['Paid'],['Paid'],['Paid']]},
      {name:'overpaid-refund-review',invoice:60000,paid:65000,guestPaid:[0,0],full:true,badges:[['Paid'],['Paid'],['Paid']]}
    ];
    for(const width of [1440,390,320])for(const theme of ['light','dark']){
      await page.setViewportSize({width,height:1000});
      await page.goto(ORIGIN+'/staff/ui');
      await page.waitForFunction(()=>typeof window.switchToTab==='function'&&document.getElementById('c-client').value==='wolfhouse-somo');
      await page.evaluate(()=>window.switchToTab('bed-calendar'));
      await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),theme);
      for(const c of controls){
        calendar.blocks=original.map((b,i)=>({...b,invoice_total_cents:c.invoice,ledger_paid_cents:c.paid,deposit_required_cents:c.unknown?null:18000,
          calendar_payment_primary:c.unknown?'payment_link_created':c.paid>60000?'refund_review':c.full?'paid':'balance_due',
          calendar_payment_amount_cents:c.paid>60000?5000:60000-c.paid,balance_due_cents:c.unknown?null:Math.max(0,60000-c.paid),calendar_show_deposit_paid:!c.full&&!c.unknown&&c.paid>=18000,
          calendar_guest_share_cents:i===2?null:30000,calendar_guest_paid_cents:i===2?null:c.guestPaid[i],calendar_guest_deposit_cents:i===2?null:9000,
          calendar_guest_link_sent:c.link===false?false:(i===2?null:true),status:c.blocked?'blocked':'confirmed'}));
        await reloadCalendar();
        const rows=await readBlocks();observations.push({name:c.name,width,theme,rows});
        rows.forEach((row,i)=>{
          assert.deepEqual(row.badges,c.badges[i],c.name+' '+width+' '+theme+' block '+i);
          assert.equal(row.package,c.blocked?null:'Uluwatu');assert.equal(row.transfer,c.blocked?null:'Transfer');
          assert.equal(typeof row.title,'string');
          if(c.full)assert(!/link sent/i.test(row.title),'paid tooltip hides link');
          else if(!c.blocked)assert.equal(/link sent/i.test(row.title),i===2||c.link!==false,'existing tooltip attribution retained');
          if(c.name==='overpaid-refund-review'&&i===2)assert.match(row.title,/Refund review €50.00/);
        });
        if(c.name==='full-paid'||c.name==='deposit-only')await page.screenshot({path:path.join(OUT,`local-synthetic-${c.name}-${width}-${theme}.png`)});
      }
    }
    assert.equal(observations.filter(o=>o.width).length,controls.length*6,'all viewport/theme/control cases executed');
    for(const width of [1440,390,320])for(const theme of ['light','dark'])for(const d of [detail,single]){
      const index=d===detail?0:2,indices=d===detail?[0,1]:[2];
      calendar.blocks=original.map(b=>({...b,ledger_paid_cents:0,balance_due_cents:60000,calendar_payment_primary:'balance_due',calendar_payment_amount_cents:60000}));
      d.payments.rows=[];
      await page.setViewportSize({width,height:1000});
      await page.goto(ORIGIN+'/staff/ui');
      await page.waitForFunction(()=>typeof window.switchToTab==='function'&&document.getElementById('c-client').value==='wolfhouse-somo');
      await page.evaluate(()=>window.switchToTab('bed-calendar'));
      await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),theme);
      await page.locator('.bc-block').nth(index).click();await page.mouse.move(10,500);
      await page.locator('#bc-inv-totals').waitFor();
      assert(await page.locator(width<=768?'#bc-detail #bc-inv-totals':'#bc-side-drawer #bc-inv-totals').isVisible(),'ordinary active mount');
      const beforeRefresh=await readBlocks();
      // Group attribution stays stale on open; single booking active-link truth is recalculated by the existing ledger reader.
      if(d===detail)assert.match(beforeRefresh[index].title,/Link sent/,'unpaid group opening has original guest link');
      d.payments.rows=[{payment_id:'receipt-all',payment_status:'paid',amount_paid_cents:60000,created_at:'2026-09-26T10:00:00Z',paid_at:'2026-09-26T10:01:00Z',metadata:{method:'bank_transfer',payment_scope:'booking'}}];
      await page.locator('#bc-refresh-links-btn').click();
      await page.waitForFunction(()=>{const btn=document.getElementById('bc-refresh-links-btn');const box=document.getElementById('bc-invoice-feedback');return btn&&!btn.disabled&&box&&!/Amounts refreshed|Refreshing/i.test(box.textContent);});
      const afterRefresh=await readBlocks();
      for(const i of indices){assert.deepEqual(afterRefresh[i].badges,['Paid']);assert(!/link sent/i.test(afterRefresh[i].title),'Invoice refresh must also remove stale Link sent tooltip');assert.equal(afterRefresh[i].package,'Uluwatu');assert.equal(afterRefresh[i].transfer,'Transfer');}
      assert.match(await page.locator('#bc-inv-totals').textContent(),/Invoice total€600.00.*Paid€600.00.*Paid in full/);
      if(width>768)await page.locator('#bc-side-close').click();
      else {
        // Fresh ordinary phone navigation avoids the existing retained-selection toggle after bc-load.
        await page.reload();
        await page.waitForFunction(()=>typeof window.switchToTab==='function'&&document.getElementById('c-client').value==='wolfhouse-somo');
        await page.evaluate(()=>window.switchToTab('bed-calendar'));
        await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),theme);
      }
      await page.locator('.bc-block').nth(index).click();await page.mouse.move(10,500);
      await page.locator('#bc-inv-totals').waitFor();
      const reopened=await readBlocks();
      for(const i of indices){assert.deepEqual(reopened[i].badges,['Paid']);assert(!/link sent/i.test(reopened[i].title),'ordinary reopen retains tooltip suppression');}
      observations.push({name:'invoice-refresh-and-reopen',width,theme,booking:d.booking.booking_code,beforeRefresh,afterRefresh,reopened});
      await page.screenshot({path:path.join(OUT,`local-synthetic-refresh-reopen-${index}-${width}-${theme}.png`)});
    }
    assert.equal(observations.filter(o=>o.name==='invoice-refresh-and-reopen').length,12,'group and single refresh/reopen at every width/theme');
    // Turnover has two separate title owners: the outgoing marker and incoming block.
    const outgoingName='Outgoing & "Quoted" <literal> | Out: text';
    const incomingName='Incoming & "Quoted" <literal>';
    calendar.blocks=original.map(b=>({...b,ledger_paid_cents:0,balance_due_cents:60000,calendar_payment_primary:'balance_due'}));
    Object.assign(calendar.blocks[0],{is_departure:true,guest_name:outgoingName});
    calendar.blocks[1].is_departure=true;
    Object.assign(calendar.blocks[2],{bed_code:'R1-B1',check_in:'2026-09-29',check_out:'2026-10-02',start_date:'2026-09-29',end_date:'2026-10-02',start_offset:5,span:3,is_arrival:true,guest_name:incomingName});
    detail.payments.rows=[];single.payments.rows=[];
    Object.assign(single.booking,{check_in:'2026-09-29',check_out:'2026-10-02',nights:3});
    single.booking_guests[0].assigned_bed_code='R1-B1';
    await page.setViewportSize({width:1440,height:1000});
    await page.goto(ORIGIN+'/staff/ui');
    await page.waitForFunction(()=>typeof window.switchToTab==='function'&&document.getElementById('c-client').value==='wolfhouse-somo');
    await page.evaluate(()=>window.switchToTab('bed-calendar'));
    await page.locator('.bc-block-checkout-marker').waitFor();
    async function readTurnover(){
      const rows=await page.locator('.bc-block,.bc-block-checkout-marker').evaluateAll(es=>es.map(e=>({
        index:e.getAttribute('data-bidx'),marker:e.classList.contains('bc-block-checkout-marker'),regular:e.classList.contains('bc-block'),
        title:e.title,html:e.innerHTML,ariaLabel:e.getAttribute('aria-label'),
        badges:[...e.querySelectorAll('.bc-block-pay-badge')].map(n=>n.textContent),
        package:e.querySelector('.pkg-pebble')?.textContent||null,transfer:e.querySelector('.transfer-pebble')?.textContent||null
      })));
      assert.equal(rows.length,4,'turnover has three ordinary blocks and one independent checkout marker');
      assert.equal(rows.filter(r=>r.marker).length,1,'exact outgoing marker cardinality');
      assert.equal(rows.filter(r=>r.regular).length,3,'marker is not an ordinary block');
      assert(rows.every(r=>typeof r.title==='string'&&r.title.length>0),'all turnover titles present');
      return rows;
    }
    const turnoverInitial=await readTurnover();
    const initialMarker=turnoverInitial.find(r=>r.marker);
    const initialIncoming=turnoverInitial.find(r=>r.index==='2'&&r.regular);
    observations.push({name:'turnover-unpaid-initial',rows:turnoverInitial});
    assert.equal(initialMarker.index,'0');assert.equal(initialMarker.html,'');
    assert.match(initialMarker.title,/Link sent/,'unpaid outgoing marker starts with link hint');
    assert(initialMarker.title.includes(outgoingName),'outgoing marker name decoded exactly once');
    assert(initialIncoming.title.endsWith(' | Out: '+outgoingName),'initial incoming Out label');
    await page.locator('.bc-block[data-bidx="0"]').click();await page.mouse.move(10,500);
    await page.locator('#bc-side-drawer #bc-inv-totals').waitFor();
    detail.payments.rows=[{payment_id:'receipt-turnover-outgoing',payment_status:'paid',amount_paid_cents:60000,created_at:'2026-09-26T10:00:00Z',paid_at:'2026-09-26T10:01:00Z',metadata:{method:'bank_transfer',payment_scope:'booking'}}];
    await page.locator('#bc-refresh-links-btn').click();
    await page.waitForFunction(()=>{const btn=document.getElementById('bc-refresh-links-btn');const box=document.getElementById('bc-invoice-feedback');return btn&&!btn.disabled&&box&&!/Amounts refreshed|Refreshing/i.test(box.textContent);});
    const turnoverOutgoing=await readTurnover();
    observations.push({name:'turnover-outgoing-invoice-refresh',rows:turnoverOutgoing});
    for(const row of turnoverOutgoing.filter(r=>r.regular&&r.index!=='2')){
      assert.deepEqual(row.badges,['Paid']);assert(!/link sent/i.test(row.title),'outgoing regular title refreshed');
      assert.equal(row.package,'Uluwatu');assert.equal(row.transfer,'Transfer');
    }
    const paidMarker=turnoverOutgoing.find(r=>r.marker);
    assert(!/link sent/i.test(paidMarker.title),'fully-paid outgoing checkout marker must not retain stale Link sent tooltip');
    assert(paidMarker.title.includes(outgoingName),'refreshed marker preserves literal outgoing name');
    assert.match(paidMarker.title,/Departs 2026-09-29/,'marker departure context retained');
    assert.deepEqual({...paidMarker,title:initialMarker.title},initialMarker,'marker changes title only, never gains normal block markup');
    assert.deepEqual(turnoverOutgoing.find(r=>r.index==='2'&&r.regular),initialIncoming,'outgoing refresh preserves other booking and incoming Out label');
    assert.match(await page.locator('#bc-inv-totals').textContent(),/Invoice total€600.00.*Paid€600.00.*Paid in full/);
    // Independently refresh incoming while outgoing remains unpaid. A real synthetic
    // active-link row keeps the single-booking hint present through ordinary opening.
    detail.payments.rows=[];
    single.payments.rows=[{payment_id:'link-turnover-incoming',payment_status:'checkout_created',payment_kind:'full_amount',amount_due_cents:60000,amount_paid_cents:0,checkout_url:ORIGIN+'/synthetic-checkout-never-opened',metadata:{payment_scope:'booking'}}];
    await page.goto(ORIGIN+'/staff/ui');
    await page.waitForFunction(()=>typeof window.switchToTab==='function'&&document.getElementById('c-client').value==='wolfhouse-somo');
    await page.evaluate(()=>window.switchToTab('bed-calendar'));
    await page.locator('.bc-block-checkout-marker').waitFor();
    await page.locator('.bc-block[data-bidx="2"]').click();await page.mouse.move(10,500);
    await page.locator('#bc-side-drawer #bc-inv-totals').waitFor();
    const beforeIncoming=await readTurnover();
    observations.push({name:'turnover-incoming-before-invoice-refresh',rows:beforeIncoming});
    const unpaidIncoming=beforeIncoming.find(r=>r.index==='2'&&r.regular);
    assert.match(unpaidIncoming.title,/Link sent/,'incoming opening retains valid unpaid link hint before Refresh');
    assert.match(beforeIncoming.find(r=>r.marker).title,/Link sent/,'independent outgoing marker remains unpaid');
    single.payments.rows.push({payment_id:'receipt-turnover-incoming',payment_status:'paid',amount_paid_cents:60000,created_at:'2026-09-26T10:00:00Z',paid_at:'2026-09-26T10:01:00Z',metadata:{method:'bank_transfer',payment_scope:'booking'}});
    await page.locator('#bc-refresh-links-btn').click();
    await page.waitForFunction(()=>{const btn=document.getElementById('bc-refresh-links-btn');const box=document.getElementById('bc-invoice-feedback');return btn&&!btn.disabled&&box&&!/Amounts refreshed|Refreshing/i.test(box.textContent);});
    const turnoverIncoming=await readTurnover();
    observations.push({name:'turnover-incoming-invoice-refresh',rows:turnoverIncoming});
    const paidIncoming=turnoverIncoming.find(r=>r.index==='2'&&r.regular);
    assert.deepEqual(paidIncoming.badges,['Paid']);
    assert(!/link sent/i.test(paidIncoming.title),'incoming Invoice refresh removes its stale link hint');
    assert(paidIncoming.title.includes(incomingName),'incoming literal name decoded exactly once');
    assert(paidIncoming.title.endsWith(' | Out: '+outgoingName),'incoming refresh preserves exact Out label including literal Out text');
    assert.equal(paidIncoming.package,'Uluwatu');assert.equal(paidIncoming.transfer,'Transfer');
    assert.deepEqual(turnoverIncoming.filter(r=>r.index!=='2'),beforeIncoming.filter(r=>r.index!=='2'),'incoming refresh preserves other booking blocks and unpaid marker title/markup');
    assert.equal(await page.locator('.bc-block[data-bidx="2"]').evaluate(e=>e.hasAttribute('onmouseover')),false,'literal names do not create attributes');
    assert.match(await page.locator('#bc-inv-totals').textContent(),/Invoice total€600.00.*Paid€600.00.*Paid in full/);
    assert.equal(observations.filter(o=>o.name.startsWith('turnover-')).length,4,'outgoing and independent incoming turnover observations executed');
    calendar.blocks=original;
    // Supplemental exact emitted helper coverage: legacy aggregate badges have no current painter caller.
    const vm=require('node:vm');
    const sandbox={getClient:()=>TENANT,escHtml:s=>String(s)};
    vm.createContext(sandbox);
    for(const name of ['bcCalendarFormatEur','bcCalendarBlockPaymentState','bcCalendarBookingFullyPaid','bcCalendarPaymentBadgesHtml']){
      const start=html.indexOf('function '+name+'('),end=html.indexOf('\nfunction ',start+1);
      assert(start>=0&&end>start,'emitted legacy helper extraction '+name);
      vm.runInContext(html.slice(start,end),sandbox);
    }
    const aggregate=sandbox.bcCalendarPaymentBadgesHtml(calendar.blocks[2]);
    observations.push({name:'supplemental-legacy-aggregate-paid',aggregate});
    assert(aggregate.includes('>Paid<'),'legacy aggregate Paid retained');
    assert(!aggregate.includes('Link sent'),'legacy aggregate fully paid must hide stale Link sent');
    for(const tenant of [TENANT,'sunset'])for(const kind of ['paid','balance_due','payment_link_created','refund_review'])for(const values of [
      {invoice_total_cents:60000,ledger_paid_cents:60000,full:true},
      {invoice_total_cents:60000,ledger_paid_cents:65000,full:true},
      {invoice_total_cents:60000,ledger_paid_cents:18000,full:false},
      {invoice_total_cents:null,ledger_paid_cents:60000,full:false},
      {invoice_total_cents:0,ledger_paid_cents:60000,full:false},
      {invoice_total_cents:'Infinity',ledger_paid_cents:60000,full:false},
      {invoice_total_cents:60000,ledger_paid_cents:null,amount_paid_cents:60000,full:false},
      {invoice_total_cents:60000,ledger_paid_cents:'Infinity',full:false},
      {invoice_total_cents:60000,ledger_paid_cents:'NaN',full:false}
    ]){
      sandbox.getClient=()=>tenant;
      const block={...original[2],...values,calendar_payment_primary:kind,calendar_payment_amount_cents:5000,calendar_show_deposit_paid:true};
      const before=JSON.stringify(block),state=JSON.stringify(sandbox.bcCalendarBlockPaymentState(block));
      const result=sandbox.bcCalendarPaymentBadgesHtml(block);
      assert.equal(result.includes('Link sent'), false, 'Link sent pebble is gone '+JSON.stringify({tenant,kind,values}));
      if(kind==='paid')assert(result.includes('>Paid<'));
      if(kind==='refund_review')assert(result.includes('Refund review €50.00'));
      if(kind==='balance_due')assert(result.includes('€50.00')&&result.includes('Deposit paid'));
      assert.equal(JSON.stringify(block),before,'display does not mutate payment input');
      assert.equal(JSON.stringify(sandbox.bcCalendarBlockPaymentState(block)),state,'payment state owner unchanged');
      observations.push({name:'supplemental-aggregate-truth-control',tenant,kind,values,result});
    }
    assert.deepEqual(errors,[],'no page errors');
    assert.deepEqual(ledger.filter(e=>e.blocked||e.unknown),[],'no unexpected network or writes');
  }catch(e){failure=e;}
  finally{
    fs.writeFileSync(path.join(OUT,'evidence.json'),JSON.stringify({passed:!failure,observations,ledger,errors,failure:failure?.stack||null},null,2));
    await browser.close();
  }
  assert.deepEqual(errors,[],'no page errors');
  assert.deepEqual(ledger.filter(e=>e.blocked||e.unknown),[],'no unexpected network or writes');
  if(failure)throw failure;
  console.log('PASS calendar full-paid group stale-link suppression (ordinary emitted HTML)');
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
