'use strict';

// PER-GUEST-DATES-001: offline amount-only proof. No DB, provider or payment writes.
// Execute actual backend functions and helpers extracted from production-emitted HTML.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { wolfhouseBookingDepositCents } = require('./lib/wolfhouse-stay-deposit');
const { bookingDepositLinkAmount } = require('./lib/booking-deposit-payment-link');

const root = path.resolve(__dirname, '..');
const evidence = process.env.DEPOSIT_EVIDENCE_DIR;
const out = evidence ? path.resolve(evidence) : fs.mkdtempSync(path.join(os.tmpdir(), 'per-guest-dates-deposit-'));
fs.mkdirSync(out, { recursive: true });
const emitted = path.join(out, 'wolfhouse-somo.html');
const emit = spawnSync(process.execPath, [path.join(__dirname, 'verify-inbox-ui-parity.js'), '--emit', 'wolfhouse-somo', emitted], {
  cwd: root, encoding: 'utf8', timeout: 60000,
  env: { ...process.env, NODE_ENV: 'test', STAFF_UI_BUILDER_TEST_SEAM: '1' },
});
assert.equal(emit.status, 0, emit.stderr || emit.stdout);
const html = fs.readFileSync(emitted, 'utf8');
function emittedFunction(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' present in production HTML');
  const end = html.indexOf('\n}', start);
  assert.notEqual(end, -1, name + ' closing brace');
  return html.slice(start, end + 2);
}
const browser = vm.createContext({
  // Only UI formatting/translation adapters are synthetic; deposit/night logic is emitted.
  escHtml: String, t: String, bcInvoiceText: String,
  bcBookingStatusIsCancelled: status => status === 'cancelled',
});
vm.runInContext([
  'bcStayNightsFromCheckInOut', 'bcWolfhouseStayDepositCents', 'bcBookingPaymentChoice',
  'bcInvoiceTotalLinkActionHtml', 'bcInvoiceDepositRowHtml',
].map(emittedFunction).join('\n'), browser);
if (!evidence) fs.rmSync(out, { recursive: true, force: true });

const { wolfhouseBookingFinancialProjection } = require('./lib/wolfhouse-booking-financial-projection');
let client = 'wolfhouse-somo';
const mount = { attrs: {'data-mounted-booking-id':'synthetic-booking', 'data-booking-view-generation':'1'}, getAttribute(k){return this.attrs[k];}, setAttribute(k,v){this.attrs[k]=v;} };
browser.getClient = () => client;
browser.el = id => id === 'bc-side-drawer' ? mount : null;
browser.document = { contains: node => node === mount };
browser.bcLastBookingContext = null;
vm.runInContext(['bcComputeBookingInvoiceTotals','staffPaymentDisplayStatus',
  'bcInvoiceFinancials','bcInvoiceFinancialValue','bcInvoiceCollectionReady','bcInvoiceMoney',
  'bcInvoiceAccCentsWithSupplement','bcRunningInvoiceAccommodationCents','bcSumActiveTransferChargesCents',
  'isAdditionalInvoiceService','bcPaymentLedgerIsPaidStatus','bcPaymentLedgerPaidTotalCents'
].filter(name => html.includes('function '+name+'(')).map(emittedFunction).join('\n'), browser);
function admit(b, total = 100000, paid = 0, extra = {}) {
  b.booking_id ||= 'synthetic-booking'; b.booking_code ||= 'TEST-READER';
  const financials = wolfhouseBookingFinancialProjection({booking:{...b,total_amount_cents:total},
    rates:b.stay_deposit_rates,currency:'EUR',serviceDueCents:0,additionalServiceCents:0,transferDueCents:0,
    displayPaidCents:paid,collectionRows:[{payment_status:'paid',amount_paid_cents:paid}],collectionIdentityEstablished:true,...extra});
  browser.bcLastBookingContext = {booking:b,financials};
  mount.attrs['data-mounted-booking-id'] = b.booking_id;
  return financials;
}
for (const view of ['loader', 'primary', 'rail']) for (const initialMount of ['', 'previous-A']) test('actual ' + view + ' initial admission with mounted ID ' + JSON.stringify(initialMount), async () => {
  const drawer = {attrs:{'data-mounted-booking-id':initialMount},dataset:{mode:'booking'},classList:{contains:()=>true},
    getAttribute(k){return this.attrs[k] || null;},setAttribute(k,v){this.attrs[k]=String(v);}};
  const host = {firstChild:{},isConnected:true,innerHTML:'',childNodes:[],querySelector:()=>null};
  const detail = {style:{display:'none'},innerHTML:'',contains:n=>n===host};
  let open = view === 'loader';
  drawer.classList = {contains:()=>open,add:()=>{open=true;}};
  const nodes = {'bc-side-drawer':drawer,'bc-side-body':view==='primary'?null:host,
    'bc-ctx-body':view==='primary'?host:null,'bc-detail':detail,
    'bc-side-booking-actions':{},'bc-refresh-detail':{addEventListener(){}},'bc-side-refresh':{setAttribute(){}}};
  let button, result, clicks = 0, beforeDispatch;
  // DOM fidelity: the real primary body is a connected descendant of #bc-detail.
  const contains = n => n === drawer || n === detail || (n === host && host.isConnected) || n === button || n === result;
  const ctx = vm.createContext({escHtml:String,t:String,bcBookingStatusIsCancelled:s=>s==='cancelled',
    getClient:()=> 'wolfhouse-somo',getBcClient:()=> 'wolfhouse-somo',
    window:{innerWidth:view==='primary'?768:1024},
    el:id=>id==='bc-deposit-link-result'?result:nodes[id]||null,
    document:{contains,querySelector:()=>drawer,querySelectorAll:q=>q==='#bc-inv-totals .bc-total-create-link' && button?[button]:[]},
    BC_STAFF_ACTIONS:true,BC_STRIPE_LINKS:true,bcInitDetailCopyDelegation:()=>{},
    bcFieldEditState:{activeGroup:null,inlineSession:1},bcActiveDrawerTab:'overview',bcDetailRequestNumber:0,
    bcPendingScrollToOverview:false,bcLastBookingContext:null});
  const names=['showBlockDetail','bcSideDrawerLive','bcOpenSideBooking','loadBlockDetail','bcInitPaymentLinkShell','bcInitGuestPaymentLinkShell','bcBindCreateGuestPaymentLinkButtons',
    'bcInitInvoiceTotalLinks','bcInvoiceFinancials','bcInvoiceFinancialValue','bcComputeBookingInvoiceTotals',
    'bcInvoiceDepositRowHtml','bcBookingPaymentChoice','bcInvoiceText','bcInvoiceTotalLinkActionHtml',
    'bcInvoiceCollectionReady','bcInvoiceMoney','bcInvoiceBookingFullyPaid','staffPaymentDisplayStatus'];
  const source=names.map(emittedFunction).join('\n');
  if(evidence) fs.writeFileSync(path.join(out,'initial-admission.vm.js'),source);
  vm.runInContext(source,ctx);
  for(const name of ['bcClearSelection','bcRemoveBookingHeaderIcons','bcMountBookingHeaderIcons','bcRefreshBlockDetail','bcHighlightActiveBlock','bcFieldEditCloseAll','bcUndockCreatePanel','bcSetSidePinned','bcPaintSideStayMeta']) ctx[name]=()=>{};
  for(const name of ['staffDisplayBookingCode','bcBookingCodeCopyHtml','bcDetailHeaderMetaHtml','bcBookingHeaderActionsHtml','bcRenderBlockSummaryPreviewHtml','bcRenderDrawerLoadingHtml']) ctx[name]=()=>'';
  ctx.bcNewPaymentLinkIdempotencyKey=()=> 'offline-intent';
  const bindGuests=ctx.bcBindCreateGuestPaymentLinkButtons;
  ctx.bcBindCreateGuestPaymentLinkButtons=d=>{beforeDispatch=button && button.click && button.click();bindGuests(d);};
  for(const name of ['bcInitDrawerTabs','bcRestoreActiveDrawerTab','bcInitFieldEditShell','bcInitServicesScheduleShell','bcInitTransferShell','bcInitAddServiceShell','bcInitMovePanel','bcInitCashPaymentShell','bcInitCancelPaymentLinkShell','bcInitBookingCancelShell','bcInitNewConversationShell','bcWireOpenConversationButtons','bcBindLunaNotesEdit','bcBindLunaNotesSave','bcBindLunaNotesDelete']) ctx[name]=()=>{};
  let header, fullyPaid, beforeBinding;
  ctx.renderBookingContextDrawer=d=>{
    beforeBinding={mount:drawer.getAttribute('data-mounted-booking-id'),ready:ctx.bcInvoiceCollectionReady(d.booking,'deposit')};
    if(view==='primary') {
      detail.style.display='none';assert.equal(ctx.bcInvoiceFinancials(d.booking),null,'closed primary before bind');detail.style.display='block';
      host.isConnected=false;assert.equal(ctx.bcInvoiceFinancials(d.booking),null,'detached primary body');host.isConnected=true;
      detail.contains=()=>false;assert.equal(ctx.bcInvoiceFinancials(d.booking),null,'connected body belongs to wrong host');detail.contains=n=>n===host;
    } else {
      open=false;assert.equal(ctx.bcInvoiceFinancials(d.booking),null,'closed rail before bind');open=true;
    }
    d.client_slug='sunset';assert.equal(ctx.bcInvoiceFinancials(d.booking),null,'wrong context tenant');delete d.client_slug;
    return ctx.bcInvoiceDepositRowHtml(d.booking,0,6000);
  };
  ctx.updateBcDetailHeader=d=>{header=ctx.bcComputeBookingInvoiceTotals(d.booking,[],{},[],[]);fullyPaid=ctx.bcInvoiceBookingFullyPaid(d);};
  for(const [id,paid] of [['A',0],['B',6000]]) {
    result={textContent:''};
    button=paid===0?{disabled:false,getAttribute:()=> 'deposit',addEventListener(_event,fn){this.click=fn;}}:null;
    const b={booking_id:id,booking_code:'TEST-'+id,client_slug:'wolfhouse-somo',total_amount_cents:6000,deposit_required_cents:10000,status:'confirmed'};
    const data={success:true,booking:b,financials:wolfhouseBookingFinancialProjection({booking:b,currency:'EUR',serviceDueCents:0,additionalServiceCents:0,transferDueCents:0,displayPaidCents:paid,collectionRows:[{payment_status:'paid',amount_paid_cents:paid}],collectionIdentityEstablished:true})};
    ctx.bcLastOpenedBlock=b;ctx.fetch=async(_url,opts)=>{
      if(opts && opts.method==='POST'){clicks++;assert.equal(JSON.parse(opts.body).booking_id,id);return {ok:false,json:async()=>({success:false,error:'offline-boundary'})};}
      return {ok:true,json:async()=>data};
    };
    if(view==='loader') ctx.loadBlockDetail(b.booking_code,{host,preserveTab:false});
    else ctx.showBlockDetail(b);
    await new Promise(resolve=>setImmediate(resolve));
    assert.doesNotMatch(host.innerHTML,/Network error/);
    assert.equal(drawer.getAttribute('data-mounted-booking-id'),id,'actual late guest binder ran');
    assert.equal(header.invoiceTotal,6000,'initial header before binding must read admitted projection');
    assert.match(host.innerHTML,/€60\.00/,'initial row must remain valid after initialization');
    assert.equal(fullyPaid,paid===6000);assert.equal(beforeBinding.ready,paid===0);
    assert.equal(ctx.bcInvoiceCollectionReady(b,'deposit'),paid===0);
    assert.equal(host.innerHTML.includes('data-payment-target="deposit"'),paid===0);
    assert.notEqual(beforeBinding.mount,id,'render precedes mounted identity');
    await beforeDispatch;
    if(button){
      assert.equal(button.disabled,false,'payment initialization before guest binding leaves valid action enabled');
      assert.equal(clicks,0,'pre-binding dispatch remains rejected');
      await button.click();assert.equal(clicks,1,'post-binding dispatch reaches offline external boundary');
      ctx.bcLastOpenedBlock={booking_id:'wrong',booking_code:'WRONG'};
      await button.click();assert.equal(clicks,1,'wrong active booking cannot dispatch');ctx.bcLastOpenedBlock=b;
      let release;
      ctx.fetch=()=>new Promise(resolve=>{release=resolve;});
      const late=button.click();
      drawer.setAttribute('data-booking-view-generation','late-generation');
      release({ok:true,json:async()=>({success:true,payment_short_url:'https://example.invalid/offline'})});
      await late;assert.equal(result.innerHTML,undefined,'late generation cannot publish URL');
    }
    assert.equal(ctx.bcInvoiceFinancials({...b}),null,'stale context object');
    ctx.bcLastOpenedBlock={booking_id:'wrong',booking_code:'WRONG'};
    assert.equal(ctx.bcInvoiceFinancials(b),null,'wrong active booking even with matching mounted ID');
    ctx.bcLastOpenedBlock=b;ctx.document.contains=()=>false;
    assert.equal(ctx.bcInvoiceFinancials(b),null,'detached mount');ctx.document.contains=contains;
    for(const invalidation of ['wrong-response','stale-block','wrong-tenant']) {
      let release;ctx.fetch=()=>new Promise(resolve=>{release=resolve;});
      const admitted=ctx.bcLastBookingContext;
      ctx.loadBlockDetail(b.booking_code,{host,preserveTab:false});
      if(invalidation==='stale-block') ctx.bcLastOpenedBlock={booking_code:'STALE'};
      if(invalidation==='wrong-tenant') ctx.getBcClient=()=> 'sunset';
      release({ok:true,json:async()=>invalidation==='wrong-response'?{...data,booking:{...b,booking_code:'WRONG'}}:data});
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(ctx.bcLastBookingContext,admitted,'loader rejects '+invalidation);
      ctx.bcLastOpenedBlock=b;ctx.getBcClient=()=> 'wolfhouse-somo';
    }
  }
});

test('FIRST reader: server projection wins contradictory raw values', () => {
  const b = booking({total_amount_cents:999999,amount_paid_cents:888888});
  const f = admit(b,6000,1000);
  const actual = browser.bcComputeBookingInvoiceTotals(b,[],{amount_paid_cents:888888},[],[]);
  assert.equal(actual.invoiceTotal,f.invoice_total_cents,'server invoice, not raw commercial calculator');
  assert.equal(actual.paidCents,1000); assert.equal(actual.balanceDue,5000);
});

test('projection deposit and controls: no raw fallback, unknown collection is not display balance', () => {
  const b = booking({deposit_required_cents:10000});
  let f = admit(b,6000,1000);
  b.deposit_required_cents = 90000;
  assert.equal(browser.bcWolfhouseStayDepositCents(b),10000);
  let row = browser.bcInvoiceDepositRowHtml(b,999999,999999);
  assert.match(row,/€60\.00/); assert.match(row,/data-payment-target="deposit"/);
  assert.equal(browser.bcInvoiceFinancialValue(b,'deposit_outstanding_cents'),5000);
  f.collection_balance_due_cents = null; f.deposit_outstanding_cents = null;
  f.value_sources.collection_balance_due_cents = 'unknown:hidden_receipt';
  f.value_sources.deposit_outstanding_cents = 'unknown:hidden_receipt';
  row = browser.bcInvoiceDepositRowHtml(b,0,6000);
  assert.match(row,/€60\.00/); assert.doesNotMatch(row,/data-payment-target/);
  assert.equal(browser.bcInvoiceCollectionReady(b,'balance'),false);
  for (const bad of [null,undefined,{...f,schema_version:2},{...f,currency:null},{...f,currency:'eur'}]) {
    browser.bcLastBookingContext.financials=bad;
    assert.equal(browser.bcWolfhouseStayDepositCents(b),null);
    assert.equal(browser.bcComputeBookingInvoiceTotals(b,[],{},[],[]).invoiceTotal,null);
    assert.doesNotMatch(browser.bcInvoiceDepositRowHtml(b,0,6000),/data-payment-target/);
  }
});
test('projection identity, null/zero/types/provenance, refund and Sunset callers', () => {
  const b=booking(); const f=admit(b,6000,1000);
  for (const value of [null,undefined,'0',false,-1,1.5,NaN,Infinity]) {
    f.balance_due_cents=value; assert.equal(browser.bcComputeBookingInvoiceTotals(b,[],{},[],[]).balanceDue,null);
  }
  f.balance_due_cents=0; assert.equal(browser.bcComputeBookingInvoiceTotals(b,[],{},[],[]).balanceDue,0);
  f.value_sources.balance_due_cents='unknown:input'; assert.equal(browser.bcComputeBookingInvoiceTotals(b,[],{},[],[]).balanceDue,null);
  assert.equal(browser.bcInvoiceFinancials({...b}),null,'same ID is not admitted object');
  b.client_slug='sunset'; assert.equal(browser.bcInvoiceFinancials(b),null); delete b.client_slug;
  mount.attrs['data-mounted-booking-id']='other'; assert.equal(browser.bcInvoiceFinancials(b),null); mount.attrs['data-mounted-booking-id']=b.booking_id;
  client='sunset'; assert.equal(browser.bcInvoiceFinancials(b),null);
  const legacy=browser.bcComputeBookingInvoiceTotals({total_amount_cents:6000,amount_paid_cents:1000},[],{},[],[]);
  assert.equal(legacy.invoiceTotal,6000); assert.equal(legacy.paidCents,1000); assert.equal(legacy.balanceDue,5000);
  client='wolfhouse-somo'; admit(b,6000,7000); assert.equal(browser.bcInvoiceFinancialValue(b,'needs_refund'),true);
  assert.equal(browser.bcInvoiceCollectionReady(b,'balance'),false);
  admit(b,6000,0); b.status='cancelled'; assert.equal(browser.bcInvoiceCollectionReady(b,'deposit'),false);
});

const rates = { long_stay_cents: 25000, short_stay_cents: 12500, source: 'admin_pricing' };
function booking(overrides = {}) {
  return { booking_id: 'synthetic-booking', booking_code: 'TEST-READER', check_in: '2026-09-01', check_out: '2026-09-08',
    guest_count: 3, deposit_required_cents: 27000, stay_deposit_rates: rates,
    metadata: { quote_snapshot: { per_guest_dates: true } }, ...overrides };
}
const invalidStored = [undefined, null, '', ' ', false, true, [], {}, -1, '-1', 1.5, '1.5', NaN, Infinity, 'bad', Number.MAX_SAFE_INTEGER + 1];
// Existing commercial oracles now travel through the real server owner first.
function projectedDeposit(b){ admit(b); return browser.bcWolfhouseStayDepositCents(b); }
function projectedRow(b, paid, total){
  const f=admit(b,total,paid);
  // Malformed wire facts are tested as malformed facts, never coerced by a fixture.
  if (!Number.isSafeInteger(total) || total < 0) { f.invoice_total_cents=null; f.deposit_display_cents=null; f.deposit_outstanding_cents=null; }
  if (!Number.isSafeInteger(paid) || paid < 0) { f.paid_total_cents=null; f.deposit_outstanding_cents=null; f.collection_balance_due_cents=null; }
  return browser.bcInvoiceDepositRowHtml(b,paid,total);
}
const implementations = [
  ['backend', b => wolfhouseBookingDepositCents(b)],
  ['emitted browser', b => projectedDeposit(b)],
];
for (const [name, required] of implementations) {
  test(name + ': marked historical KEEP beats long/short envelope and current Admin rates', () => {
    for (const check_out of ['2026-09-06', '2026-09-07', '2026-09-08']) {
      for (const stored of [27000, '27000', 0, '0', Number.MAX_SAFE_INTEGER]) {
        const b = booking({ check_out, deposit_required_cents: stored });
        assert.equal(required(b), Number(stored));
        assert.equal(required({ ...b, guest_count: 10, stay_deposit_rates: { long_stay_cents: 99999, short_stay_cents: 88888 } }), Number(stored));
      }
    }
    assert.equal(required(booking({ check_in: null, check_out: null, guest_count: null })), 27000);
  });
  test(name + ': invalid marked deposit is unknown, never envelope-recalculated', () => {
    for (const value of invalidStored) assert.equal(required(booking({ deposit_required_cents: value })), null, String(value));
  });
  test(name + ': only exact nested boolean marker changes ordinary Admin policy', () => {
    for (const metadata of [undefined, null, {}, { per_guest_dates: true }, { quote_snapshot: null },
      { quote_snapshot: { per_guest_dates: false } }, { quote_snapshot: { per_guest_dates: 'true' } },
      { quote_snapshot: { per_guest_dates: 1 } }]) {
      for (const stored of [0, 20000, 27000]) {
        assert.equal(required(booking({ metadata, deposit_required_cents: stored })), 37500);
        assert.equal(required(booking({ metadata, check_out: '2026-09-06', deposit_required_cents: stored })), 37500);
        assert.equal(required(booking({ metadata, check_out: '2026-09-07', deposit_required_cents: stored })), 37500);
      }
    }
    assert.equal(required(booking({ metadata: {}, stay_deposit_rates: undefined })), 30000);
    assert.equal(required(booking({ metadata: {}, stay_deposit_rates: undefined, check_out: '2026-09-06' })), 30000);
  });
}
test('backend: explicit Admin rates still apply only to ordinary bookings', () => {
  const current = { long_stay_cents: 31000, short_stay_cents: 14000 };
  assert.equal(wolfhouseBookingDepositCents(booking(), current), 27000);
  assert.equal(wolfhouseBookingDepositCents(booking({ metadata: {}, package_code: 'waimea' }), current), 93000);
  assert.equal(wolfhouseBookingDepositCents(booking({ metadata: {}, package_code: 'waimea', check_out: '2026-09-04' }), current), 93000);
  assert.equal(wolfhouseBookingDepositCents(booking({ metadata: {} }), current), 42000);
  assert.equal(wolfhouseBookingDepositCents(booking({ metadata: {}, check_out: '2026-09-06' }), current), 42000);
  assert.equal(wolfhouseBookingDepositCents({ deposit_required_cents: 20000 }), 20000);
  assert.equal(wolfhouseBookingDepositCents({ deposit_required_cents: 0 }), 0);
  assert.equal(wolfhouseBookingDepositCents({}), null);
});
test('emitted invoice row: KEEP amount, zero paid, invalid unknown without deposit action', () => {
  const row = b => projectedRow(b, 0, 100000);
  assert.match(row(booking()), /€270\.00/);
  assert.match(row(booking()), /data-deposit-state="unpaid"/);
  assert.match(row(booking()), /data-payment-target="deposit"/);
  assert.match(row(booking({ deposit_required_cents: 0 })), /€0\.00/);
  assert.match(row(booking({ deposit_required_cents: 0 })), /data-deposit-state="paid"/);
  assert.doesNotMatch(row(booking({ deposit_required_cents: 0 })), /data-payment-target="deposit"/);
  for (const value of invalidStored) {
    const result = row(booking({ deposit_required_cents: value }));
    assert.match(result, /data-deposit-state="unknown"/, String(value));
    assert.doesNotMatch(result, /data-payment-target="deposit"/, String(value));
  }
  assert.match(row(booking({ metadata: {} })), /€375\.00/);
});

test('emitted invoice row: malformed fallback deposit never becomes a known zero', () => {
  const noPolicy = {check_in:null,check_out:null,nights:null,guest_count:null,status:'confirmed'};
  for (const value of invalidStored) {
    // schema1 reader boundary: hostile wire facts, not inadmissible raw DB facts
    // passed into the trusted-input server owner. Keep every invalid value/oracle.
    const b = booking({deposit_required_cents:8000});
    const f = admit(b,8000,0);
    for (const key of ['deposit_required_cents','deposit_display_cents','deposit_outstanding_cents']) {
      f[key] = value;
      assert.equal(browser.bcInvoiceFinancialValue(b,key),null,String(value));
    }
    assert.equal(browser.bcWolfhouseStayDepositCents(b),null,String(value));
    assert.equal(browser.bcInvoiceCollectionReady(b,'deposit'),false,String(value));
    const result = browser.bcInvoiceDepositRowHtml(b,0,8000);
    assert.match(result,/data-deposit-state="unknown"/,String(value));
    assert.match(result,/—/,String(value));
    assert.doesNotMatch(result,/data-payment-target="deposit"/,String(value));
  }
  for (const value of [0,'0',8000,'8000']) {
    const result = projectedRow({...noPolicy,deposit_required_cents:value},8000,8000);
    assert.match(result,/data-deposit-state="paid"/,String(value));
  }
});

test('schema1 authoritative valid deposit wins every contradictory malformed raw value', () => {
  for (const required of [0,8000]) {
    for (const value of invalidStored) {
      const b = booking({deposit_required_cents:required});
      const f = admit(b,8000,0);
      const before = JSON.stringify(f);
      b.deposit_required_cents = value;
      assert.equal(browser.bcWolfhouseStayDepositCents(b),required,String(value));
      const result = browser.bcInvoiceDepositRowHtml(b,0,8000);
      assert.match(result,required === 0 ? /€0\.00/ : /€80\.00/,String(value));
      assert.match(result,required === 0 ? /data-deposit-state="paid"/ : /data-deposit-state="unpaid"/,String(value));
      assert.equal(result.includes('data-payment-target="deposit"'),required > 0,String(value));
      assert.equal(JSON.stringify(f),before,'raw mutation cannot reprice authoritative financials');
    }
  }
});

test('emitted invoice row: one validated ceiling controls amount, state and action without repricing', () => {
  const cases = [
    [10000,8000,8000,8000,'paid',false], [10000,8000,0,8000,'unpaid',true],
    [10000,8000,3000,8000,'unpaid',true], [10000,4000,4000,4000,'paid',false],
    [30000,24000,24000,24000,'paid',false], [10000,12000,10000,10000,'paid',false],
    [15000,8000,8000,8000,'paid',false], [27000,20000,20000,20000,'paid',false],
    [10000,0,0,0,'paid',false], [0,8000,0,0,'paid',false],
    [10000,8000,9000,8000,'paid',false], [27000,100000,5000,27000,'unpaid',true],
  ];
  for (const [required,total,paid,effective,state,action] of cases) {
    const b=booking({deposit_required_cents:required});
    const before=JSON.stringify(b);
    admit(b,total,paid);
    const row=projectedRow(b,paid,total);
    assert(row.includes('€'+(effective/100).toFixed(2)),JSON.stringify({required,total,paid}));
    assert(row.includes('data-deposit-state="'+state+'"'));
    assert.equal(row.includes('data-payment-target="deposit"'),action);
    assert.equal(JSON.stringify(b),before,'KEEP/history must not mutate');
  }
  for (const total of [...invalidStored,'8000']) {
    const row=projectedRow(booking(),0,total);
    assert.match(row,/data-deposit-state="unknown"/);assert.match(row,/—/);
    assert.doesNotMatch(row,/data-payment-target="deposit"/);
  }
  for (const paid of [...invalidStored,'0']) {
    const row=projectedRow(booking(),paid,20000);
    assert.match(row,/€200\.00/);assert.match(row,/data-deposit-state="unknown"/);
    assert.doesNotMatch(row,/data-payment-target="deposit"/);
  }
  const cancelled=projectedRow(booking({status:'cancelled'}),0,20000);
  assert.match(cancelled,/€200\.00/);assert.doesNotMatch(cancelled,/data-payment-target="deposit"/);
});

async function link(b, rows = [], invoiceTotal = 100000, target = 'deposit') {
  let reads = 0;
  const result = await bookingDepositLinkAmount(null, b, rows, {
    loadBookingPaymentLedger: async (pg, actual) => {
      assert.equal(pg, null); assert.equal(actual, b); reads++;
      return { invoice_total_cents: invoiceTotal };
    },
  }, target);
  return { result, reads };
}
test('emitted browser matches canonical accommodation exclusions and unknown named codes', () => {
  for (const package_code of ['', null, 'package_none', 'no_package', 'accommodation_only',
    'accommodation-only', 'manual_override', ' CUSTOM ', 'none', 'new_wave']) {
    const expected = ['none', 'new_wave'].includes(package_code) ? 50000 : 25000;
    const b = booking({ guest_count: 2, metadata: {}, package_code });
    assert.equal(wolfhouseBookingDepositCents(b), expected, String(package_code));
    assert.equal(projectedDeposit(b), expected, String(package_code));
    const row = projectedRow(b, expected, 100000);
    assert.match(row, /data-deposit-state="paid"/);
    assert.doesNotMatch(row, /id="bc-generate-deposit-link-btn"/);
  }
});

const paid = cents => ({ payment_status: 'paid', amount_paid_cents: cents });
test('bookingDepositLinkAmount: KEEP less actual paid receipts; ignore cached paid and unpaid rows', async () => {
  const { result, reads } = await link(booking({ amount_paid_cents: 99999 }), [paid(5000),
    { payment_status: 'checkout_created', amount_paid_cents: 80000 }]);
  assert.deepEqual(result, { ok: true, amountDueCents: 22000 });
  assert.equal(reads, 1);
  assert.deepEqual((await link(booking({ check_out: '2026-09-06' }))).result, { ok: true, amountDueCents: 27000 });
});
test('bookingDepositLinkAmount: explicit zero and met historical deposit create no amount', async () => {
  for (const [stored, rows] of [[0, []], ['0', []], [27000, [paid(27000)]], [27000, [paid(30000)]]]) {
    const { result } = await link(booking({ deposit_required_cents: stored }), rows);
    assert.equal(result.ok, false); assert.equal(result.body.reason_code, 'no_deposit_due');
  }
});
test('bookingDepositLinkAmount: invalid marked deposit fails closed before ledger', async () => {
  for (const value of invalidStored) {
    const { result, reads } = await link(booking({ deposit_required_cents: value }));
    assert.equal(result.ok, false, String(value));
    assert.equal(result.status, 422);
    assert.equal(result.body.reason_code, 'deposit_configuration_unknown');
    assert.equal(reads, 0);
  }
});
test('bookingDepositLinkAmount: invoice cap, balance and refund-review safeguards unchanged', async () => {
  assert.deepEqual((await link(booking(), [paid(5000)], 20000)).result, { ok: true, amountDueCents: 15000 });
  assert.deepEqual((await link(booking(), [paid(5000)], 100000, 'balance')).result, { ok: true, amountDueCents: 95000 });
  assert.equal((await link(booking(), [paid(100001)])).result.body.reason_code, 'refund_review_needed');
  assert.equal((await link(booking(), [], null)).result.body.reason_code, 'invoice_total_unknown');
  const result = await bookingDepositLinkAmount(null, booking(), [], {});
  assert.equal(result.body.reason_code, 'payment_ledger_unavailable');
});
test('emitted invoice and backend agree on package-selected deposits across stay lengths', () => {
  for (const [checkOut, packageCode, expected] of [
    ['2026-11-12', 'package_none', 20000],
    ['2026-11-08', 'waimea', 40000],
  ]) {
    const b = booking({ check_in: '2026-11-05', check_out: checkOut, guest_count: 2,
      package_code: packageCode, stay_deposit_rates: null, metadata: {} });
    assert.equal(wolfhouseBookingDepositCents(b), expected);
    assert.equal(projectedDeposit(b), expected, 'emitted invoice must not retain night-based selection');
  }
});

test('bookingDepositLinkAmount: ordinary booking uses Admin package tier times guests, not stored flat', async () => {
  assert.deepEqual((await link(booking({ metadata: {}, deposit_required_cents: 20000 }))).result, { ok: true, amountDueCents: 37500 });
  assert.deepEqual((await link(booking({ metadata: {}, check_out: '2026-09-06', deposit_required_cents: 0 }))).result, { ok: true, amountDueCents: 37500 });
});

// Full emitted renderer, recursively loading real helpers. Only translation and DOM
// shells are adapters; no financial helper, classification or renderer is replaced.
const fullRuntimeSources = new Map();
function fullInvoiceRuntime(source = html) {
  const loaded = new Map();
  function load(name) {
    if (loaded.has(name) || ['t','escHtml','el','getClient'].includes(name)) return;
    loaded.set(name, '');
    const start = source.indexOf('function ' + name + '(');
    if (start < 0) return;
    const parsed = require('acorn').parseExpressionAt(source,start,{ecmaVersion:'latest'});
    const code = source.slice(start, parsed.end);
    loaded.set(name, code);
    for (const match of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) load(match[1]);
  }
  if (!fullRuntimeSources.has(source)) {
    load('bcRenderRunningInvoiceHtml');
    fullRuntimeSources.set(source,[...loaded.values()].join('\n'));
  }
  const drawer = {getAttribute:()=> 'FULL'};
  const ctx = vm.createContext({console,Intl,Date,URL,BC_STAFF_ACTIONS:true,BC_STRIPE_LINKS:true,
    escHtml:String,t:key=>key, getClient:()=> 'wolfhouse-somo',
    el:id=>id==='bc-side-drawer'?drawer:null,document:{contains:n=>n===drawer},
    bcLastBookingContext:null});
  const code = source.match(/var PG_PAY_PER_GUEST_LINK_SOURCES = [^;]+;/)[0] + '\n' + fullRuntimeSources.get(source);
  vm.runInContext(code,ctx);
  if (evidence) fs.writeFileSync(path.join(out,'full-renderer.vm.js'),code);
  return ctx;
}
const fullCases = [
  {name:'partial',paid:2000}, {name:'full',paid:6000}, {name:'zero',total:0,paid:0},
  {name:'unknown-paid',paid:null}, {name:'unknown-invoice',invoiceInputsAvailable:false},
  {name:'missing',invalid:'missing'}, {name:'unsupported',invalid:'unsupported'},
  {name:'wrong-booking',invalid:'booking'}, {name:'wrong-tenant',invalid:'tenant'},
  {name:'cancelled',status:'cancelled'}, {name:'overpaid',paid:7000},
  {name:'currency',currency:'USD'}, {name:'unattested-collection',collectionIdentityEstablished:false},
];
for (const c of fullCases) test('FULL emitted running invoice projection: '+c.name, () => {
  const ctx=fullInvoiceRuntime();
  const b={booking_id:'FULL',booking_code:'FULL',client_slug:'wolfhouse-somo',status:c.status||'confirmed',
    total_amount_cents:c.total??6000,deposit_required_cents:10000,balance_due_cents:987654,
    check_in:'2026-11-01',check_out:'2026-11-03',metadata:{}};
  const paid=Object.hasOwn(c,'paid')?c.paid:0;
  const f=wolfhouseBookingFinancialProjection({booking:b,currency:c.currency||'EUR',serviceDueCents:0,
    additionalServiceCents:0,transferDueCents:0,displayPaidCents:paid,
    collectionRows:[{payment_status:'paid',amount_paid_cents:paid??0}],collectionIdentityEstablished:true,...c});
  ctx.bcLastBookingContext={booking:b,financials:f};
  if(c.invalid==='missing') delete ctx.bcLastBookingContext.financials;
  if(c.invalid==='unsupported') f.schema_version=99;
  if(c.invalid==='booking') ctx.bcLastBookingContext.booking={...b};
  if(c.invalid==='tenant') ctx.bcLastBookingContext.client_slug='sunset';
  const classify=ctx.bcPaymentLedgerIsStaleUnpaidLinkRow;
  let ledgerContext;
  ctx.bcPaymentLedgerIsStaleUnpaidLinkRow=(row,context)=>{ledgerContext=context;return classify(row,context);};
  const rendered=ctx.bcRenderRunningInvoiceHtml(b,[],{rows:[{payment_id:'FULL-LINK',payment_status:'checkout_created',checkout_url:'https://example.invalid/offline',amount_due_cents:6000,metadata:{payment_scope:'booking'}}]},[],[],[],[],{overview:true});
  assert.equal(ledgerContext.balance_due_cents,c.invalid?null:f.balance_due_cents,'ledger uses display balance including known zero');
  assert.equal(ledgerContext.deposit_required_cents,c.invalid?null:f.deposit_required_cents,'ledger uses required deposit, not capped display or raw fallback');
  if(evidence) fs.writeFileSync(path.join(out,'full-'+c.name+'.html'),rendered);
  assert.match(rendered,/id="bc-inv-accommodation"/);
  assert.match(rendered,/id="bc-payment-history-card"/,'full renderer reaches history');
  const totals=rendered.slice(rendered.indexOf('id="bc-inv-totals"'),rendered.indexOf('id="bc-invoice-actions"'));
  for(const [label,key] of [['invoiceTotal','invoice_total_cents'],['paid','paid_total_cents'],['balanceDue','balance_due_cents']]) {
    const value=c.invalid?null:f[key];
    const row=totals.match(new RegExp('drawer\\.invoice\\.'+label+'</span><span[^>]*>([^<]*)'));
    assert.ok(row,label+' must be visible including unknown/zero');
    assert.equal(row[1],ctx.bcInvoiceMoney(b,value),label+' projection amount/currency');
  }
  assert.doesNotMatch(totals,/9876\.54/,'legacy raw balance cannot override projection');
  assert.equal(totals.includes('data-payment-target="balance"'),
    f.balance_due_cents>0 && !c.invalid && ctx.bcInvoiceCollectionReady(b,'balance'));
  assert.equal(totals.includes('needs-refund'),!c.invalid && f.needs_refund===true);
  if(c.name==='overpaid') assert.match(totals,/€10\.00/,'pending credit calculation preserved');
});

// Additive operational section contract: execute the actual context expression,
// with existing service/transfer owners; no API boot, SQL, transport or writes.
const sectionApi = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const sectionStart = sectionApi.indexOf("...(clientSlug === 'wolfhouse-somo' ? { financials:");
assert.ok(sectionStart > 0);
const sectionEnd = sectionApi.indexOf('\n    guest_accommodation_lines:', sectionStart);
const sectionExpression = '({' + sectionApi.slice(sectionStart, sectionEnd) + '})';
const sectionSumStart = sectionApi.indexOf('function editPreviewSvcSum(');
const sectionSum = sectionApi.slice(sectionSumStart, require('acorn').parseExpressionAt(sectionApi, sectionSumStart, {ecmaVersion:'latest'}).end);
const sectionServices = require('./lib/staff-booking-services-schedule');
const sectionTransfers = require('./lib/booking-invoice-totals');
function sectionContext(overrides = {}) {
  const ctx = vm.createContext({clientSlug:'wolfhouse-somo',
    bk:{total_amount_cents:10000,deposit_required_cents:3000},
    bkMetadata:{quote_snapshot:{total_cents:10000,currency:'EUR'}},
    stayDepositRates:null,depositRatesProvenance:'unknown',guestAccommodationQuoteConfig:null,
    serviceRecordRows:[{amount_due_cents:9000},{amount_due_cents:500,status:'active',metadata:{invoice_total_inclusion:'additional'}},
      {amount_due_cents:800,status:'cancelled',metadata:{invoice_total_inclusion:'additional'}}],
    transferRecordRows:[{status:'confirmed',price_cents:700},{status:'cancelled',price_cents:800},{status:'requested',price_cents:-500}],
    serviceRecordsAvailable:true,transfersAvailable:true,totalPaid:1000,collectionRows:[],
    serviceRecordBillableCents:sectionServices.serviceRecordBillableCents,
    isAdditionalInvoiceService:sectionServices.isAdditionalInvoiceService,
    sumActiveTransferChargesCents:sectionTransfers.sumActiveTransferChargesCents,
    require:name=>{assert.equal(name,'./lib/wolfhouse-booking-financial-projection');return {wolfhouseBookingFinancialProjection};},
    ...overrides});
  vm.runInContext(sectionSum,ctx);
  return JSON.parse(JSON.stringify(vm.runInContext(sectionExpression,ctx)));
}
if(evidence) fs.writeFileSync(path.join(out,'section-context.vm.js'),sectionSum+'\n'+sectionExpression);
test('section contract actual context and owners preserve historical invoice, later charges and eligibility',()=>{
  const f=sectionContext().financials;
  assert.equal(f.service_total_cents,9500);
  assert.equal(f.transfer_total_cents,700);
  assert.equal(f.invoice_total_cents,11200,'accepted 10000 plus additional 500 and active transfer 700');
  const changed=sectionContext({serviceRecordRows:[{amount_due_cents:19000},{amount_due_cents:500,metadata:{invoice_total_inclusion:'additional'}}]}).financials;
  assert.equal(changed.service_total_cents,19500);
  assert.equal(changed.invoice_total_cents,f.invoice_total_cents,'current operational services do not reprice accepted invoice');
  assert.equal(f.value_sources.service_total_cents,'service_owner:operational_section_sum_not_historical_allocation');
  assert.equal(f.value_sources.transfer_total_cents,'transfer_owner:operational_section_sum_not_historical_allocation');
});
for(const [name,overrides,service,transfer] of [
  ['empty',{serviceRecordRows:[],transferRecordRows:[]},0,0],
  ['service failed',{serviceRecordsAvailable:false},null,700],
  ['transfer failed',{transfersAvailable:false},9500,null],
  ['both failed',{serviceRecordsAvailable:false,transfersAvailable:false},null,null],
  ['flags absent',{serviceRecordsAvailable:undefined,transfersAvailable:undefined},null,null],
  ['invalid owner service',{serviceRecordRows:[{amount_due_cents:'invalid'}]},null,700],
]) test('section actual context '+name,()=>{
  const f=sectionContext(overrides).financials;
  assert.equal(f.service_total_cents,service);assert.equal(f.transfer_total_cents,transfer);
  for(const key of ['service_total_cents','transfer_total_cents']) assert.equal(f.value_sources[key].startsWith('unknown'),f[key]===null);
});
test('section projection strict input validity and independent availability',()=>{
  for(const invalid of [undefined,null,NaN,Infinity,-1,1.5,'0',false,{},Number.MAX_SAFE_INTEGER+1]) {
    const f=wolfhouseBookingFinancialProjection({booking:{},serviceRecordsAvailable:true,transfersAvailable:true,serviceDueCents:invalid,transferDueCents:invalid});
    assert.equal(f.service_total_cents,null);assert.equal(f.transfer_total_cents,null);
  }
  for(const flag of [undefined,null,false,0,1,'true']) {
    const f=wolfhouseBookingFinancialProjection({booking:{},serviceRecordsAvailable:flag,transfersAvailable:true,serviceDueCents:500,transferDueCents:0});
    assert.equal(f.service_total_cents,null);assert.equal(f.transfer_total_cents,0);
  }
});
test('section actual context Sunset has no Wolfhouse projection',()=>{
  assert.deepEqual(sectionContext({clientSlug:'sunset'}),{});
});

// Section-reader regressions: actual emitted renderer, admission and formatter.
function subtotalFixture(options = {}) {
  const ctx = fullInvoiceRuntime();
  const b = {booking_id:'FULL',booking_code:'FULL',status:'confirmed',total_amount_cents:10000,metadata:{}};
  const f = wolfhouseBookingFinancialProjection({booking:b,currency:options.currency || 'EUR',
    serviceRecordsAvailable:true,transfersAvailable:true,serviceDueCents:1234,transferDueCents:567,
    additionalServiceCents:0,displayPaidCents:0,collectionRows:[],collectionIdentityEstablished:true});
  ctx.bcLastBookingContext = {booking:b,financials:f};
  const services = options.rows ? [{amount_due_cents:options.rows==='zero'?0:9900,service_type:'rental',status:'active'}] : [];
  const transfers = options.rows ? [{price_cents:options.rows==='zero'?0:8800,status:'confirmed',direction:'arrival'}] : [];
  if (options.change) options.change(f,ctx,b);
  const rendered = ctx.bcRenderRunningInvoiceHtml(b,services,{},transfers,[],[],[],{overview:true});
  const section = id => rendered.slice(rendered.lastIndexOf('<div class="ctx-inv-group',rendered.indexOf('id="bc-inv-'+id+'"')),rendered.indexOf('id="bc-inv-'+(id==='services'?'transfers':'totals')+'"'));
  return {ctx,b,f,rendered,section};
}
test('section reader authoritative positive totals override empty legacy rows',()=>{
  const r=subtotalFixture();
  assert.match(r.section('services'),/€12\.34/);
  assert.match(r.section('transfers'),/€5\.67/);
  assert.doesNotMatch(r.section('services'),/booking-body-empty|drawer\.invoice\.noServices/);
  assert.doesNotMatch(r.section('transfers'),/booking-body-empty|drawer\.invoice\.noTransfers/);
});
for (const [currency,service,transfer] of [['EUR','€12.34','€5.67'],['USD','USD 12.34','USD 5.67'],['JPY','JPY 12.34','JPY 5.67']]) test('section literal currency '+currency,()=>{
  const r=subtotalFixture({currency,rows:true});
  assert.ok(r.section('services').includes('>'+service+'</span>'));
  assert.ok(r.section('transfers').includes('>'+transfer+'</span>'));
  assert.equal(r.f.invoice_total_cents,10567,'historical accepted 10000 is not current service allocation');
  const changed=subtotalFixture({currency,rows:true,change:f=>{f.service_total_cents=99999;}});
  const totals=s=>s.slice(s.indexOf('id="bc-inv-totals"'));
  assert.equal(totals(changed.rendered),totals(r.rendered),'section operational sum cannot alter historical grand total, payments or history');
});
for (const key of ['service_total_cents','transfer_total_cents']) test('section independent unknown and strict invalid '+key,()=>{
  for(const rows of [false,'zero',true]) for(const invalid of [undefined,null,-1,1.5,'0',false,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) {
    const r=subtotalFixture({rows,change:f=>{f[key]=invalid;}});
    const section=key==='service_total_cents'?'services':'transfers';
    assert.match(r.section(section),/ctx-inv-total-amount">—/);
    assert.doesNotMatch(r.section(section),/booking-body-empty|drawer\.invoice\.noServices|drawer\.invoice\.noTransfers/);
    assert.ok(r.section(section==='services'?'transfers':'services').includes(section==='services'?'€5.67':'€12.34'));
  }
});
test('section provenance and currency failures never become zero',()=>{
  for(const change of [f=>delete f.value_sources.service_total_cents,f=>f.value_sources.service_total_cents='unknown:failed',f=>f.value_sources.transfer_total_cents='',f=>f.value_sources=null,f=>delete f.currency,f=>f.currency='eur',f=>f.currency='',f=>f.schema_version=99]) {
    const r=subtotalFixture({change});
    assert.match(r.rendered,/ctx-inv-total-amount">—/);
    assert.doesNotMatch(r.section('services')+r.section('transfers'),/booking-body-empty|drawer\.invoice\.noServices|drawer\.invoice\.noTransfers/);
  }
});
test('section actual admission rejects stale disconnected and wrong identity',()=>{
  for(const change of [(_f,c)=>c.bcLastBookingContext=null,(_f,c,b)=>c.bcLastBookingContext.booking={...b},(_f,c)=>c.bcLastBookingContext.client_slug='sunset',(_f,c)=>c.document.contains=()=>false,(_f,c)=>c.el=()=>null,(_f,c)=>c.bcLastOpenedBlock={booking_id:'OTHER',booking_code:'OTHER'}]) {
    const r=subtotalFixture({change});
    assert.equal(r.ctx.bcInvoiceFinancialValue(r.b,'service_total_cents'),null);
    assert.match(r.section('services'),/ctx-inv-total-amount">—/);
    assert.match(r.section('transfers'),/ctx-inv-total-amount">—/);
  }
});
test('section known zero retains no subtotal and prior empty presentation',()=>{
  for(const rows of [false,true]) {
    const r=subtotalFixture({rows,change:f=>{f.service_total_cents=0;f.transfer_total_cents=0;}});
    assert.doesNotMatch(r.section('services')+r.section('transfers'),/bc-invoice-section-total|drawer\.invoice\.notAvailable/);
    if(!rows) {assert.match(r.section('services'),/booking-body-empty/);assert.match(r.section('transfers'),/booking-body-empty/);}
  }
});

// Explicit refresh lifecycle; synthetic transport, not HTTP/DB/provider proof.
function refreshFixture() {
  const c=fullInvoiceRuntime();
  vm.runInContext(fs.readFileSync(path.join(__dirname,'browser/booking-invoice.js'),'utf8'),c);
  const attrs={'data-mounted-booking-id':'FULL','data-booking-view-generation':'1'};
  const drawer={getAttribute:k=>attrs[k],setAttribute:(k,v)=>attrs[k]=v};
  c.el=id=>id==='bc-side-drawer'?drawer:null;c.document.contains=n=>n===drawer;
  c.bcUpdateOverviewPaymentSummary=d=>{c.renderedContext=d;};c.updateBcDetailHeader=()=>{};
  const b={booking_id:'FULL',booking_code:'FULL',status:'confirmed',total_amount_cents:10000};
  const f=wolfhouseBookingFinancialProjection({booking:b,currency:'EUR',displayPaidCents:0,serviceRecordsAvailable:true,transfersAvailable:true,serviceDueCents:0,transferDueCents:0,additionalServiceCents:0,collectionRows:[],collectionIdentityEstablished:true});
  const d={booking:b,financials:f,booking_guests:[{booking_guest_id:'guest-retained'}]};c.bcLastBookingContext=d;
  return {c,b,d,attrs};
}
test('explicit failed refresh revokes readiness without dropping cached guests; retry restores owner facts',async()=>{
  const {c,b,d}=refreshFixture();assert.equal(c.bcInvoiceCollectionReady(b,'full'),true);
  c.fetch=async()=>{throw Error('synthetic failure');};
  await assert.rejects(c.bcRefreshInvoice({booking:b}));
  assert.equal(c.bcInvoiceCollectionReady(b,'full'),false);assert.equal(c.bcInvoiceFinancialValue(b,'paid_total_cents'),null);
  assert.equal(c.renderedContext,d);assert.equal(c.bcLastBookingContext,d);assert.equal(d.booking_guests.length,1);
  const fresh={...d,success:true,booking:{...b},financials:{...d.financials,invoice_total_cents:4321}};
  c.fetch=async()=>({ok:true,json:async()=>fresh});await c.bcRefreshInvoice({booking:b});
  assert.equal(c.bcInvoiceFinancialValue(fresh.booking,'invoice_total_cents'),4321);assert.equal(c.bcInvoiceCollectionReady(fresh.booking,'full'),true);
});
test('refresh stale caller before mounted stamp cannot invalidate B; late A cannot replace B',async()=>{
  const {c,b,d,attrs}=refreshFixture();let resolve;c.fetch=()=>new Promise(r=>resolve=r);
  const pending=c.bcRefreshInvoice(d);const gen=attrs['data-booking-view-generation'];
  const other={booking:{booking_id:'B',booking_code:'B'},financials:d.financials};c.bcLastOpenedBlock=other.booking;c.bcLastBookingContext=other;
  assert.equal(await c.bcRefreshInvoice(d),null);assert.equal(attrs['data-booking-view-generation'],gen);
  resolve({ok:true,json:async()=>({...d,success:true})});assert.equal(await pending,null);assert.equal(c.bcLastBookingContext,other);
});
test('invalid contract retry stays unavailable; supported unknown fields do not trigger reload',async()=>{
  const {c,b,d}=refreshFixture();let calls=0;
  const fresh={...d,success:true,financials:{...d.financials,schema_version:99}};
  c.fetch=async()=>{calls++;return {ok:true,json:async()=>fresh};};await c.bcRefreshInvoice(d);
  assert.equal(c.bcInvoiceCollectionReady(b,'full'),false);assert.equal(calls,1);
  fresh.financials={...d.financials,paid_total_cents:null,value_sources:{...d.financials.value_sources,paid_total_cents:'unknown:owner'}};
  await c.bcRefreshInvoice(fresh);assert.equal(c.bcInvoiceFinancialValue(b,'paid_total_cents'),null);assert.equal(c.bcInvoiceCollectionReady(b,'full'),true);assert.equal(calls,2);
});

// One-shot init recovery: synthetic GET inputs, NOT HTTP/DB/provider proof.
for (const kind of ['absent','schema99']) test('init automatically recovers once '+kind,async()=>{
  const {c,d}=refreshFixture(); const valid={...d,success:true,booking:{...d.booking}};
  if(kind==='absent') delete d.financials; else d.financials={...d.financials,schema_version:99};
  c.bcInvoiceStyles=()=>{};let calls=0;
  c.fetch=async()=>{calls++;return {ok:true,json:async()=>valid};};
  c.bcInitInvoiceWorkspace(d);c.bcInitInvoiceWorkspace(d);
  for(let i=0;i<8;i++) await Promise.resolve();
  assert.equal(calls,1,'actual init must issue exactly one normal context GET');
  assert.equal(c.bcLastBookingContext,valid);
});

test('manual refresh started before queued auto dispatch consumes the same attempt',async()=>{
  const {c,d}=refreshFixture();delete d.financials;c.bcInvoiceStyles=()=>{};
  let calls=0,resolve;c.fetch=()=>{calls++;return new Promise(r=>resolve=r);};
  c.bcInitInvoiceWorkspace(d);const manual=c.bcRefreshInvoice(d);
  for(let i=0;i<4;i++)await Promise.resolve();
  assert.equal(calls,1,'queued auto must not duplicate a normal refresh already started');
  resolve({ok:true,json:async()=>({...d,success:true})});await manual;
});
for(const outcome of ['failure','invalid']) test('auto '+outcome+' remount stays exhausted; manual and independent load recover',async()=>{
  const {c,d}=refreshFixture();const valid={...d,success:true,booking:{...d.booking}};delete d.financials;
  c.bcInvoiceStyles=()=>{};c.bcUpdateOverviewPaymentSummary=x=>c.bcInitInvoiceWorkspace(x);
  let calls=0;c.fetch=async()=>{calls++;if(outcome==='failure')throw Error('synthetic');return {ok:true,json:async()=>({...d,success:true})};};
  c.bcInitInvoiceWorkspace(d);for(let i=0;i<12;i++)await Promise.resolve();
  c.bcInitInvoiceWorkspace(c.bcLastBookingContext);for(let i=0;i<6;i++)await Promise.resolve();
  assert.equal(calls,1);assert.equal(c.bcInvoiceCollectionReady(c.bcLastBookingContext.booking,'full'),false);
  c.fetch=async()=>{calls++;return {ok:true,json:async()=>valid};};
  await c.bcRefreshInvoice(c.bcLastBookingContext);assert.equal(calls,2);assert.equal(c.bcInvoiceCollectionReady(valid.booking,'full'),true);
  const independent={...d,booking:{...d.booking}};c.bcLastBookingContext=independent;c.bcInitInvoiceWorkspace(independent);
  for(let i=0;i<12;i++)await Promise.resolve();assert.equal(calls,3);
});
test('supported independently unknown provenance does not schedule automatic GET',async()=>{
  const {c,d}=refreshFixture();c.bcInvoiceStyles=()=>{};let calls=0;c.fetch=async()=>{calls++;throw Error('unexpected GET');};
  d.financials.paid_total_cents=null;d.financials.value_sources.paid_total_cents='unknown:owner';
  c.bcInitInvoiceWorkspace(d);for(let i=0;i<6;i++)await Promise.resolve();assert.equal(calls,0);
  assert.equal(c.bcInvoiceFinancialValue(d.booking,'paid_total_cents'),null);assert.equal(c.bcInvoiceCollectionReady(d.booking,'full'),true);
});

// Ordinary successful edit: synthetic transport, actual emitted success continuation/loader.
// Shell adapters match initial admission; no full drawer/layout or durable API-write claim.
test('successful guest reduction reloads one coherent guest and financial snapshot',async()=>{
  const c=fullInvoiceRuntime();
  const host={firstChild:{},isConnected:true,innerHTML:''};
  const detail={style:{display:'block'},contains:n=>n===host};
  const select={value:'1'},save={disabled:false},result={style:{},innerHTML:''};
  const drawer={getAttribute:()=> 'EDIT',classList:{contains:()=>false},dataset:{mode:'booking'}};
  const nodes={'bc-side-drawer':drawer,'bc-ctx-body':host,'bc-detail':detail,'bc-field-guests-select':select,
    'bc-field-save-guests':save,'bc-field-guests-preview-result':result};
  c.el=id=>nodes[id]||null;
  c.document={contains:n=>n===drawer||n===host||n===detail,querySelectorAll:()=>[]};
  c.getBcClient=()=> 'wolfhouse-somo';
  c.bcDetailRequestNumber=0;c.bcActiveDrawerTab='overview';c.bcPendingScrollToOverview=false;
  const names=['bcFieldEditRunGuestsSave','bcFieldEditBuildGuestsWritePayload',
    'bcFieldEditGuestsCountLowerThanCurrent','bcFieldEditPrivateRoomReadEnabled',
    'bcFieldEditPrivateRoomEditEnabled','bcNewGuestsEditIdempotencyKey',
    'bcFieldEditRenderGuestsSaveResult','bcFieldEditUpdateGuestsSaveState','bcFieldEditCloseAll',
    'bcFieldEditResetPrivateRoomSwitchToSaved','bcFieldEditSetPrivateRoomToggle',
    'bcFieldEditSavedPrivateRoomEnabled','bcFieldEditClearPreviewResults',
    'loadBlockDetail','bcGuestNameBedDisplayHtml'];
  vm.runInContext(names.map(emittedFunction).join('\n'),c);
  // Incidental editor DOM restoration and unrelated initializer shells only.
  for(const name of ['bcFieldEditRestoreInline','bcFieldEditRestoreForms','bcInitDrawerTabs',
    'bcRestoreActiveDrawerTab','bcInitFieldEditShell','bcInitServicesScheduleShell','bcInitTransferShell',
    'bcInitAddServiceShell','bcInitMovePanel','bcInitCashPaymentShell','bcInitPaymentLinkShell',
    'bcInitGuestPaymentLinkShell','bcInitCancelPaymentLinkShell','bcInitBookingCancelShell',
    'bcInitNewConversationShell','bcWireOpenConversationButtons','bcBindLunaNotesEdit',
    'bcBindLunaNotesSave','bcBindLunaNotesDelete']) c[name]=()=>{};
  function snapshot(count,total,paid,guests){
    const b={booking_id:'EDIT',booking_code:'EDIT-ORDINARY',client_slug:'wolfhouse-somo',
      status:'confirmed',guest_count:count,guest_name:'Retained Guest',total_amount_cents:total,
      deposit_required_cents:10000,check_in:'2026-11-01',check_out:'2026-11-03',metadata:{}};
    const financials=wolfhouseBookingFinancialProjection({booking:b,currency:'EUR',
      serviceDueCents:0,additionalServiceCents:0,transferDueCents:0,displayPaidCents:paid,
      collectionRows:[{payment_status:'paid',amount_paid_cents:paid}],collectionIdentityEstablished:true});
    // Poison wire legacy amounts AFTER real projection: no browser fallback may pass.
    Object.assign(b,{total_amount_cents:999999,amount_paid_cents:888888,balance_due_cents:777777,deposit_required_cents:666666});
    return {success:true,booking:b,financials,booking_guests:guests};
  }
  const retained={booking_guest_id:'keep',guest_name:'Retained Guest',bed_code:'BED-A'};
  const old=snapshot(2,12000,6000,[retained,{booking_guest_id:'remove',guest_name:'Removed Guest',bed_code:'BED-B'}]);
  const fresh=snapshot(1,6000,6000,[retained]);
  c.bcLastOpenedBlock=old.booking;c.bcLastBookingContext=old;
  c.bcFieldEditState={activeGroup:'guests',inlineSession:1,guestCount:2,bookingId:'EDIT',
    bookingCode:'EDIT-ORDINARY',clientSlug:'wolfhouse-somo',snapshot:{private_room:false}};
  const renders=[];
  c.renderBookingContextDrawer=d=>{
    renders.push(d);
    return c.bcGuestNameBedDisplayHtml(d.booking_guests,d.booking.guest_name,[],false,[],false)+
      c.bcRenderRunningInvoiceHtml(d.booking,[],{},[],[],[],[],{overview:true});
  };
  let header;
  c.updateBcDetailHeader=d=>{header=c.bcComputeBookingInvoiceTotals(d.booking,[],{},[],[]);};
  host.innerHTML=c.renderBookingContextDrawer(old);
  assert.match(host.innerHTML,/Removed Guest/);
  assert.equal(c.bcInvoiceFinancialValue(old.booking,'invoice_total_cents'),12000);
  assert.equal(c.bcInvoiceCollectionReady(old.booking,'balance'),true);
  const requests=[];
  c.fetch=async(url,opts)=>{
    requests.push({url,opts});
    if(opts && opts.method==='POST') return {ok:true,status:200,json:async()=>({success:true,updated:true})};
    return {ok:true,json:async()=>fresh};
  };
  c.bcFieldEditRunGuestsSave(); // Never directly invoke loader: production success continuation owns it.
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.length,2,'successful edit must submit once and refresh context once');
  assert.equal(requests[0].url,'/staff/bookings/edit');
  assert.equal(requests[0].opts.method,'POST');
  const payload=JSON.parse(requests[0].opts.body);
  assert.match(payload.idempotency_key,/^bc-guests-edit-/);
  assert.deepEqual({...payload,idempotency_key:'KEY'},{client_slug:'wolfhouse-somo',booking_id:'EDIT',
    booking_code:'EDIT-ORDINARY',edit_type:'guests',guest_count:1,idempotency_key:'KEY',reason:'Staff portal guest reduction'});
  assert.equal(requests[1].url,'/staff/bookings/EDIT-ORDINARY/context?client=wolfhouse-somo');
  assert.equal(requests[1].opts,undefined,'normal GET, no replayed mutation');
  assert.equal(c.bcLastBookingContext,fresh,'successful callback must install returned snapshot');
  assert.deepEqual(renders,[old,fresh]);
  assert.equal(c.bcFieldEditState.activeGroup,null);
  assert.equal(c.bcLastBookingContext.booking.guest_count,1);
  assert.equal(c.bcLastBookingContext.booking_guests,fresh.booking_guests);
  assert.match(host.innerHTML,/Retained Guest/);assert.match(host.innerHTML,/BED-A/);
  assert.doesNotMatch(host.innerHTML,/Removed Guest|BED-B|Network error/);
  assert.equal(c.bcInvoiceFinancials(old.booking),null,'old object cannot remain financially admitted');
  assert.equal(c.bcInvoiceFinancials(fresh.booking),fresh.financials);
  assert.equal(header.invoiceTotal,6000);assert.equal(header.paidCents,6000);assert.equal(header.balanceDue,0);
  const totals=host.innerHTML.slice(host.innerHTML.indexOf('id="bc-inv-totals"'),host.innerHTML.indexOf('id="bc-invoice-actions"'));
  for(const [label,key] of [['invoiceTotal','invoice_total_cents'],['paid','paid_total_cents'],['balanceDue','balance_due_cents']]) {
    const row=totals.match(new RegExp('drawer\\.invoice\\.'+label+'</span><span[^>]*>([^<]*)'));
    assert.ok(row,label+' visible');assert.equal(row[1],c.bcInvoiceMoney(fresh.booking,fresh.financials[key]));
  }
  assert.doesNotMatch(totals,/9999\.99|8888\.88|7777\.77|120\.00/);
  assert.equal(c.bcInvoiceCollectionReady(fresh.booking,'balance'),false);
  assert.doesNotMatch(totals,/data-payment-target="balance"/);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.length,2,'settled success must not replay POST or GET');
  if(evidence) fs.writeFileSync(path.join(out,'successful-edit.html'),host.innerHTML);
});

