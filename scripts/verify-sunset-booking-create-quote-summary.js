'use strict';
/* verify:sunset-booking-create-quote-summary — Kaya Slice 5 offline sticky summary + quote states */
const fs = require('fs');
const path = require('path');
const vm = require('vm'); const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const portalSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
let pass = 0, fail = 0;
function assert(l, c, d) { if (c) { console.log('  PASS  ' + l); pass += 1; } else { console.error('  FAIL  ' + l + (d ? ' — ' + d : '')); fail += 1; } }
function extractFn(src, name) {
  const n = 'function ' + name + '(', s = src.indexOf(n); if (s < 0) return null;
  const b = src.indexOf('{', s); let d = 0;
  for (let i = b; i < src.length; i += 1) { if (src[i] === '{') d += 1; else if (src[i] === '}') { d -= 1; if (!d) return src.slice(s, i + 1); } }
  return null;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
const modal = (() => {
  const s = apiSrc.indexOf('id="ps-create-modal"'); const o = apiSrc.lastIndexOf('<div', s);
  const e = apiSrc.indexOf('id="ps-drawer-backdrop"', o); const c = apiSrc.lastIndexOf('</div>', e);
  return apiSrc.slice(o, c > o ? c + 6 : e);
})();
const footer = (modal.match(/<footer class="portal-schedule-create-footer"[\s\S]*?<\/footer>/) || [])[0] || '';
const footerCss = (apiSrc.match(/\.portal-schedule-create-footer\{[^}]+\}/) || [])[0] || '';
console.log('\nverify:sunset-booking-create-quote-summary — Kaya Slice 5\n');
const counts = {}; let m; const re = /\bid="(ps-create-[^"]+)"/g;
while ((m = re.exec(modal))) counts[m[1]] = (counts[m[1]] || 0) + 1;
assert('footer chrome',
  modal.indexOf('portal-schedule-create-body') < modal.indexOf('portal-schedule-create-footer')
  && footer.includes('ps-create-summary') && footer.includes('ps-create-quote-preview')
  && footer.indexOf('ps-create-summary') < footer.indexOf('ps-create-quote-preview')
  && footer.indexOf('ps-create-quote-preview') < footer.indexOf('ps-create-submit')
  && counts['ps-create-summary']===1 && counts['ps-create-quote-preview']===1 && Object.keys(counts).every((k)=>counts[k]===1)
  && /role="status"/.test(footer) && /aria-live="polite"/.test(footer)
  && !/overflow-y:\s*auto/.test(footerCss) && /overflow-x:\s*hidden/.test(footerCss)
  && /portal-schedule-create-summary\{[^}]*(-webkit-line-clamp:2|line-clamp:2)/.test(apiSrc)
  && /min-height:\s*44px/.test(apiSrc) && /safe-area-inset-bottom/.test(apiSrc)
  && /portal-schedule-create-actions\{[^}]*flex:\s*0\s+0\s+auto/.test(apiSrc));
assert('owners', /function schedulePortalRenderCreateIntentSummary/.test(portalSrc)
  && (portalSrc.match(/function schedulePortalRenderCreateQuotePreview/g) || []).length === 1
  && /function schedulePortalSyncCreateFooter/.test(portalSrc)
  && /function schedulePortalInvalidateCreateQuoteIntent/.test(portalSrc)
  && /schedulePortalSyncCreateFooter/.test(extractFn(apiSrc, 'scheduleUpdateCreateTotalPreview') || '')
  && /ps-create-guest/.test(extractFn(portalSrc, 'schedulePortalWireCreateFooter') || '')
  && !/ps-create-course-select|ps-create-course-qty/.test(extractFn(portalSrc, 'schedulePortalWireCreateFooter') || '')
  && /schedulePortalSyncCreateFooter/.test(extractFn(portalSrc, 'schedulePortalPopulateCreateCourseFields') || '')
  && /ps-create-course-tier/.test(extractFn(apiSrc, 'wireScheduleControls') || ''));
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const es = require('./lib/staff-portal-i18n-es-sunset');
const en = STAFF_PORTAL_STRINGS.en || {}, it = STAFF_PORTAL_STRINGS.it || {};
const I18N_KEYS = ['schedule.create.summary.chooseLessonOrGear','schedule.create.summary.completeSessions','schedule.create.summary.sessions','schedule.create.summary.surfers','schedule.create.checkingPrice','schedule.create.quoteTotal','schedule.create.quoteFailed','schedule.create.quoteStale','schedule.create.quoteBusy'];
assert('i18n keys', I18N_KEYS.every((k) => en[k] && es[k] && it[k] && es[k] !== en[k] && it[k] !== en[k]));
const T = {
  'schedule.create.summary.chooseLessonOrGear':'Choose a lesson or add gear','schedule.create.summary.completeSessions':'Complete session details',
  'schedule.create.summary.sessions':'Sessions','schedule.create.summary.surfers':'Surfers','schedule.create.checkingPrice':'Checking price…',
  'schedule.create.quoteTotal':'Quoted total','schedule.create.quoteFailed':'Quote unavailable',
  'schedule.create.quoteStale':'Price changed — refresh quote before creating.','schedule.create.quoteBusy':'Price check is busy — wait a moment and try again.',
  'schedule.type.course':'Group course','schedule.type.privateLesson':'Private course','schedule.type.noLesson':'No lesson',
  'schedule.type.boardRental':'Board rental','schedule.type.wetsuitRental':'Wetsuit rental','schedule.ops.rentalBoth':'Surfboard + wetsuit',
  'schedule.payment.paid':'Paid','schedule.payment.unpaid':'Unpaid','admin.period.2_days':'2 day','admin.period.1_day':'1 day',
};
const LEAK = /\b(c1|1_week|2_days|duration_key|tier_key|course_id|board_rental|offering_key)\b/;
function sandbox(opts) {
  opts = opts || {};
  const log = [], nodes = {};
  let summaryN = 0, refreshN = 0, qn = 0;
  function N(id, x) {
    nodes[id] = Object.assign({
      id, value:'', checked:false, disabled:false, textContent:'', innerHTML:'', style:{display:'none'},
      dataset:{}, classList:{ add(){}, remove(){} }, options:[], selectedIndex:-1, _ls:{},
      addEventListener(ev, fn){ (this._ls[ev]=this._ls[ev]||[]).push(fn); },
      setAttribute(k, v){ this['_'+k]=v; }, getAttribute(k){ return this['_'+k]||null; },
      querySelector(){ return null; }, querySelectorAll(){ return []; },
    }, x || {});
    return nodes[id];
  }
  N('ps-create-summary',{innerHTML:'<span>—</span>',style:{display:''}});
  N('ps-create-quote-preview');N('ps-create-msg');N('ps-create-submit');N('ps-create-guest');N('ps-create-phone');N('ps-create-notes');N('ps-create-payment',{value:'unpaid'});
  N('ps-create-date-from',{value:'2026-08-20'});N('ps-create-date-to',{value:'2026-08-22'});
  const cOpts=opts.courseOptions!==undefined?opts.courseOptions:[{value:'c1',textContent:'Beginner',getAttribute:(k)=>k==='data-label'?'Beginner':null}];
  const tOpts=opts.tierOptions!==undefined?opts.tierOptions:[{value:'1_week',textContent:'1 week'}];
  N('ps-create-course-select',{value:cOpts[0]?cOpts[0].value:'',options:cOpts,selectedIndex:cOpts.length?0:-1});
  N('ps-create-course-tier',{value:tOpts[0]?tOpts[0].value:'',options:tOpts,selectedIndex:tOpts.length?0:-1});
  N('ps-create-course-qty',{value:'1'});N('ps-create-private-lesson-qty',{value:'1'});N('ps-create-private-lesson-surfers',{value:'1'});N('ps-create-private-lesson-sessions');
  N('ps-create-comp-course');N('ps-create-comp-private-lesson');N('ps-create-comp-no-lesson',{checked:true});N('ps-create-comp-fullday');N('ps-create-rentals',{getAttribute:()=>'1_day'});
  let payload = opts.payload || { guest_name: '', guest_phone: '+34000', notes: 'secret', date_from: '2026-08-20', date_to: '2026-08-22', payment_status: 'unpaid', components: {}, rentals: [] };
  const ctx = {
    console, setTimeout, clearTimeout, Promise, JSON, Object, Array, Number, String, Math, Date,
    AbortController: typeof AbortController !== 'undefined' ? AbortController : undefined,
    getClient: () => 'sunset', getSunsetLocation: () => 'sunset-somo', sunsetLocationQuerySuffix: () => '&location_id=sunset-somo',
    scheduleEnumerateDates: (a, b) => [String(a).slice(0, 10), String(b).slice(0, 10)],
    scheduleReadCreatePayload: () => JSON.parse(JSON.stringify(payload)),
    scheduleUpdateFullDayAddonSummary() {},
    adminPeriodLabel: (k) => T['admin.period.' + k] || null,
    portalT: (k) => T[k] || k,
    escHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    el: (id) => nodes[id] || null,
    closeScheduleCreateModal() { if (ctx.schedulePortalInvalidatePreviewWork) ctx.schedulePortalInvalidatePreviewWork(); },
    openScheduleCreateModal() { if (ctx.schedulePortalResetCreateFormRuntime) ctx.schedulePortalResetCreateFormRuntime(); },
    scheduleResetNavigationAfterBookingCreate() {}, scheduleRequestPageLoad() {}, scheduleFindCachedRowByBookingCode() { return null; },
    scheduleRentalOfferingLabelKey: (k) => (k === 'wetsuit_rental' ? 'schedule.type.wetsuitRental' : k === 'board_and_suit_rental' ? 'schedule.ops.rentalBoth' : k === 'board_rental' ? 'schedule.type.boardRental' : ''),
    fetch(url, req) {
      const entry = { url: String(url), opts: req || {}, body: null };
      try { if (req && req.body) entry.body = JSON.parse(req.body); } catch (_e) { /* */ }
      log.push(entry);
      if (String(url).includes('/bookings/quote')) {
        const n = ++qn;
        const delay = typeof opts.quoteDelay === 'function' ? opts.quoteDelay(n) : (opts.quoteDelay || 0);
        const custom = typeof opts.quoteOutcome === 'function' ? opts.quoteOutcome(n, entry) : null;
        const uncoop = !!opts.uncooperative;
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => {
            if (!uncoop && req && req.signal && req.signal.aborted) { const e = new Error('a'); e.name = 'AbortError'; return reject(e); }
            if (custom) return resolve({ ok: custom.ok !== false, status: custom.status || 200, json: () => Promise.resolve(custom.body || custom) });
            resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, total_cents: opts.total_cents != null ? opts.total_cents : 13500, quote_provenance: { source: 't', quote_fingerprint: 'fp' + n } }) });
          }, delay);
          if (!uncoop && req && req.signal) req.signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('a'); e.name = 'AbortError'; reject(e); });
        });
      }
      if (String(url).includes('/bookings?') && req && req.method === 'POST') {
        return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ success: true, booking_code: 'BK-1', booking_id: 'id-1' }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, courses: [] }) });
    },
    _log: log, _nodes: nodes, _setPayload(p) { payload = p; }, _qn: () => qn,
    _counts: () => ({ summary: summaryN, refresh: refreshN }), _resetCounts() { summaryN = 0; refreshN = 0; },
  };
  vm.createContext(ctx); vm.runInContext(opts.portalSrc || portalSrc, ctx);
  if (opts.debounceMs != null) ctx.schedulePortalQuoteDebounceMs = opts.debounceMs;
  const _sum = ctx.schedulePortalRenderCreateIntentSummary.bind(ctx);
  ctx.schedulePortalRenderCreateIntentSummary = function (p) { summaryN += 1; return _sum(p); };
  const _ref = ctx.schedulePortalRefreshCreateQuote.bind(ctx);
  ctx.schedulePortalRefreshCreateQuote = function () { refreshN += 1; return _ref(); };
  return ctx;
}
function S(c){return String(c.el('ps-create-summary').innerHTML||'');}
function Q(c){return String(c.el('ps-create-quote-preview').innerHTML||'');}
function baseCourse(extra){return Object.assign({guest_name:'R',date_from:'2026-08-20',date_to:'2026-08-20',payment_status:'unpaid',components:{course:{course_id:'c1',course_label:'G',quantity:1}},rentals:[]},extra||{});}
function sandMut(src,o){o=o||{};o.portalSrc=src;o.payload=o.payload||baseCourse();return sandbox(o);}
function qBody(n,a,b){return{ok:true,body:{success:true,total_cents:n===1?a:b}};}
(async function run() {
  const empty = sandbox(); empty.schedulePortalRenderCreateIntentSummary();
  assert('empty', /Choose a lesson or add gear/.test(S(empty)) && !/\+34000|secret/.test(S(empty)));
  const group = sandbox();
  group._setPayload({ guest_name:'Ada', guest_phone:'+34999', notes:'NOPE', date_from:'2026-08-20', date_to:'2026-08-22', payment_status:'paid',
    components:{ course:{ course_id:'c1', course_label:'Beginner', tier_key:'1_week', quantity:2 } }, rentals:[] });
  group.schedulePortalRenderCreateIntentSummary();
  assert('group', /Group course/.test(S(group)) && /Beginner/.test(S(group)) && /1 week/.test(S(group)) && /Paid|Ada/.test(S(group)) && !LEAK.test(S(group)));
  const leak = sandbox({ courseOptions:[], tierOptions:[] });
  leak._setPayload({ guest_name:'', date_from:'2026-08-20', date_to:'2026-08-20', payment_status:'unpaid',
    components:{ course:{ course_id:'c1', tier_key:'1_week', quantity:1 } }, rentals:[] });
  leak.schedulePortalRenderCreateIntentSummary(); assert('no key leak', /Group course/.test(S(leak)) && !LEAK.test(S(leak)));
  const priv = sandbox();
  priv._setPayload({ guest_name:'', guest_phone:'X', notes:'N', date_from:'2026-08-21', date_to:'2026-08-23', payment_status:'unpaid',
    components:{ private_lesson:{ enabled:true, quantity:2, surfer_count:3, sessions:[{date:'2026-08-21',start:'10:00',end:'12:00'},{date:'2026-08-23',start:'10:00',end:'12:00'}] } }, rentals:[] });
  priv.schedulePortalRenderCreateIntentSummary();
  assert('private labels', /Sessions:\s*2/.test(S(priv)) && /Surfers:\s*3/.test(S(priv)) && !LEAK.test(S(priv)));
  const soft = sandbox();
  soft._setPayload({ guest_name:'', date_from:'2026-08-20', date_to:'2026-08-20', payment_status:'unpaid',
    components:{ private_lesson:{ enabled:true, quantity:1, surfer_count:1, sessions:[{date:'',start:'',end:''}] } }, rentals:[] });
  soft.el('ps-create-quote-preview').innerHTML='Quoted total: €99.00'; soft.el('ps-create-quote-preview').style.display='block';
  const g0=soft.schedulePortalQuoteGen; const softR=await soft.schedulePortalRunPreviewQuote();
  assert('soft', soft._qn()===0 && softR && softR.softInvalid && soft.schedulePortalQuoteGen>g0 && !/€99/.test(Q(soft)));
  const gear = sandbox();
  gear._setPayload({ guest_name:'Bo', date_from:'2026-08-20', date_to:'2026-08-21', payment_status:'unpaid',
    components:{}, rentals:[{ offering_key:'board_rental', duration_key:'2_days', quantity:2 }] });
  gear.schedulePortalRenderCreateIntentSummary();
  assert('rental duration', /Board rental/.test(S(gear)) && /2 day/.test(S(gear)) && !/2_days|board_rental/.test(S(gear)));
  const imm = sandbox({ debounceMs:80, quoteDelay:5 });
  imm._setPayload(baseCourse({ guest_name:'A' })); imm._resetCounts(); imm.schedulePortalSyncCreateFooter();
  assert('imm', imm._counts().summary===1 && imm._counts().refresh===1 && /Checking price/.test(Q(imm)) && imm._qn()===0);
  await sleep(140); assert('ready', /€135\.00/.test(Q(imm)));
  async function race(delays, label) {
    const c = sandbox({ debounceMs:5, quoteDelay:(n)=>delays[n-1],
      quoteOutcome:(n)=>({ok:true,body:{success:true,total_cents:n===1?11100:22200,quote_provenance:{source:n===1?'A':'B'}}}) });
    c._setPayload(baseCourse()); const r1=c.schedulePortalRunPreviewQuote(); await sleep(delays[0]===5?2:10);
    c._setPayload(baseCourse({ components:{ course:{ course_id:'c1', course_label:'G', quantity:2 } } }));
    await Promise.all([r1, c.schedulePortalRunPreviewQuote()]);
    assert(label, c.schedulePortalQuoteState && c.schedulePortalQuoteState.total_cents===22200 && /€222\.00/.test(Q(c)) && !/€111/.test(Q(c)));
  }
  await race([60,5],'race B-then-A'); await race([5,40],'race A-then-B');
  const uncoop = sandbox({ debounceMs:5, uncooperative:true, quoteDelay:(n)=>n===1?50:5, quoteOutcome:(n)=>qBody(n,11100,22200) });
  uncoop._setPayload(baseCourse()); const u1=uncoop.schedulePortalRunPreviewQuote(); await sleep(8);
  uncoop._setPayload(baseCourse({ components:{ course:{ course_id:'c1', course_label:'G', quantity:2 } } }));
  await Promise.all([u1, uncoop.schedulePortalRunPreviewQuote()]);
  assert('uncoop after B', /€222\.00/.test(Q(uncoop)) && !/€111/.test(Q(uncoop)));
  const us = sandbox({ debounceMs:5, uncooperative:true, quoteDelay:40, total_cents:88800 });
  us._setPayload(baseCourse()); const us1=us.schedulePortalRunPreviewQuote(); await sleep(5);
  us.schedulePortalInvalidateCreateQuoteIntent({ ok:false, softInvalid:true });
  await us1.catch(()=>null); await sleep(50);
  assert('uncoop after soft', !/€888/.test(Q(us)) && us.schedulePortalQuoteState==null);
  // Production refresh: valid→valid during debounce; uncoop old must not repaint before new timer.
  const deb = sandbox({ debounceMs:350, uncooperative:true, quoteDelay:(n)=>n===1?200:10, quoteOutcome:(n)=>qBody(n,11100,22200) });
  deb._setPayload(baseCourse()); const d1=deb.schedulePortalRefreshCreateQuote(); await sleep(400);
  deb._setPayload(baseCourse({ components:{ course:{ course_id:'c1', course_label:'G', quantity:2 } } }));
  const d2=deb.schedulePortalRefreshCreateQuote();
  assert('deb checking', /Checking price/.test(Q(deb))); await sleep(200);
  assert('deb no stale', /Checking price/.test(Q(deb)) && !/€111/.test(Q(deb))
    && (deb.schedulePortalQuoteState==null || deb.schedulePortalQuoteState.total_cents!==11100));
  await Promise.all([d1,d2]); await sleep(30); assert('deb ready', /€222\.00/.test(Q(deb)) && !/€111/.test(Q(deb)));
  for (const row of [['neg',-500],['frac',10.5],['null',null],['miss'],['empty',''],['ws',' '],['false',false],['str','13500'],['nan',NaN],['inf',Infinity]]) {
    const name=row[0], cents=row[1];
    const b=sandbox({ debounceMs:5, quoteDelay:5, quoteOutcome:()=>({ok:true,body:name==='miss'?{success:true}:{success:true,total_cents:cents}}) });
    b._setPayload(baseCourse()); await b.schedulePortalRunPreviewQuote();
    assert(name+' total', /Quote unavailable/.test(Q(b)) && !/€\d/.test(Q(b)));
  }
  const z=sandbox({ debounceMs:5, quoteDelay:5, quoteOutcome:()=>({ok:true,body:{success:true,total_cents:0}}) });
  z._setPayload(baseCourse()); await z.schedulePortalRunPreviewQuote(); assert('zero total', /€0\.00/.test(Q(z)));
  const errS = sandbox({ debounceMs:5, quoteDelay:5, quoteOutcome:(n)=>{
    if (n===1) return {ok:false,status:409,body:{success:false,reason_code:'quote_stale'}};
    if (n===2) return {ok:false,status:503,body:{success:false}};
    if (n===3) return {ok:false,status:500,body:{success:false}};
    return {ok:true,body:{success:true,total_cents:5000}};
  }});
  errS._setPayload(baseCourse());
  await errS.schedulePortalRunPreviewQuote(); const e409=/Price changed/.test(Q(errS));
  await errS.schedulePortalRunPreviewQuote(); const e503=/busy|Busy|wait/i.test(Q(errS));
  await errS.schedulePortalRunPreviewQuote(); const eGen=/Quote unavailable/.test(Q(errS));
  await errS.schedulePortalRunPreviewQuote(); assert('errors+recovery', e409&&e503&&eGen&&/€50\.00/.test(Q(errS)));
  const mut = sandbox({ debounceMs:5, quoteDelay:5, total_cents:7700 });
  mut._setPayload({ guest_name:'M', date_from:'2026-08-20', date_to:'2026-08-20', payment_status:'unpaid',
    components:{ course:{ course_id:'c1', course_label:'€999 pack', quantity:1, amount_cents:99900 } },
    rentals:[{ offering_key:'board_rental', duration_key:'1_day', quantity:1, total_cents:12345 }] });
  await mut.schedulePortalRunPreviewQuote(); assert('canon', /€77\.00/.test(Q(mut)) && !/€999|12345/.test(Q(mut)));
  const guest = sandbox({ debounceMs:80, quoteDelay:5 });
  guest._setPayload(baseCourse({ guest_name:'' })); guest.schedulePortalWireCreateFooter();
  guest.el('ps-create-quote-preview').innerHTML='Quoted total: €77.00'; guest.el('ps-create-quote-preview').style.display='block';
  guest._resetCounts(); guest.el('ps-create-guest').value='Ann';
  (guest.el('ps-create-guest')._ls.input||[]).forEach((fn)=>fn());
  assert('guest only', guest._counts().summary===1 && guest._counts().refresh===0 && guest._qn()===0 && /€77/.test(Q(guest)) && !/Checking price/.test(Q(guest)));
  const stripGen = portalSrc.replace(/myGen !== schedulePortalQuoteGen \|\| schedulePortalSubmitInFlight/g, 'false')
    .replace(/myGen !== schedulePortalQuoteGen/g, 'false')
    .replace(/if \(schedulePortalQuoteAbort\) \{/g, 'if (false && schedulePortalQuoteAbort) {')
    .replace(/if \(result && result\.aborted\) return result;/g, 'if (false && result && result.aborted) return result;')
    .replace(/if \(res\.aborted\) \{/g, 'if (false && res.aborted) {')
    .replace(/applyState && myGen === schedulePortalQuoteGen/g, 'applyState');
  const rGuard = sandMut(stripGen, { quoteDelay:(n)=>n===1?50:5, quoteOutcome:(n)=>qBody(n,11100,22200) });
  const g1=rGuard.schedulePortalRunPreviewQuote(); await sleep(10);
  rGuard._setPayload(baseCourse({ components:{ course:{ course_id:'c1', course_label:'G', quantity:2 } } }));
  await Promise.all([g1, rGuard.schedulePortalRunPreviewQuote()]);
  assert('RED gen', /€111\.00/.test(Q(rGuard)) || (rGuard.schedulePortalQuoteState && rGuard.schedulePortalQuoteState.total_cents===11100));
  const rStale = sandMut(portalSrc.replace(/function schedulePortalShowQuoteChecking\(\) \{[\s\S]*?\n\}/, 'function schedulePortalShowQuoteChecking(){}'), { quoteDelay:40 });
  rStale.el('ps-create-quote-preview').innerHTML='Quoted total: €99.00'; rStale.el('ps-create-quote-preview').style.display='block';
  rStale.schedulePortalSyncCreateFooter(); assert('RED stale', /€99\.00/.test(Q(rStale)) && !/Checking price/.test(Q(rStale)));
  const stripInv = portalSrc.replace(/function schedulePortalInvalidateCreateQuoteIntent\(result\) \{[\s\S]*?\n\}/,
    'function schedulePortalInvalidateCreateQuoteIntent(result){ schedulePortalQuoteState=null; if(result) schedulePortalRenderCreateQuotePreview(result); }');
  const rSoft = sandMut(stripInv, { uncooperative:true, quoteDelay:35, total_cents:77700 });
  rSoft.schedulePortalRunPreviewQuote(); await sleep(5);
  rSoft.schedulePortalInvalidateCreateQuoteIntent({ idle:true }); await sleep(50);
  assert('RED soft no gen', /€777/.test(Q(rSoft)));
  const stripHuman = portalSrc
    .replace(/if \(tierLab && tierLab !== String\(comps\.course\.tier_key \|\| ''\)\) cBits\.push\(tierLab\);/,
      "if (!tierLab && comps.course.tier_key) tierLab = String(comps.course.tier_key); if (tierLab) cBits.push(tierLab);")
    .replace(/function schedulePortalHumanCourseBit\(course\) \{[\s\S]*?\n\}/,
      'function schedulePortalHumanCourseBit(course){ return (course && course.course_id) ? String(course.course_id) : ""; }');
  const rKey = sandMut(stripHuman, {});
  rKey.el('ps-create-course-select').options=[]; rKey.el('ps-create-course-select').selectedIndex=-1;
  rKey.el('ps-create-course-tier').options=[]; rKey.el('ps-create-course-tier').selectedIndex=-1;
  rKey._setPayload({ guest_name:'', date_from:'2026-08-20', date_to:'2026-08-20', payment_status:'unpaid',
    components:{ course:{ course_id:'c1', tier_key:'1_week', quantity:1 } }, rentals:[] });
  rKey.schedulePortalRenderCreateIntentSummary(); assert('RED raw keys', /c1|1_week/.test(S(rKey)));
  const stripCanon = portalSrc.replace(
    /if \(typeof raw !== 'number' \|\| !Number\.isFinite\(raw\) \|\| Math\.floor\(raw\) !== raw \|\| raw < 0 \|\| raw > Number\.MAX_SAFE_INTEGER\) \{[\s\S]*?return;\n  \}/,
    'if (false) { return; }');
  const rMoney = sandMut(stripCanon, { quoteDelay:5, quoteOutcome:()=>({ok:true,body:{success:true,total_cents:-500}}) });
  await rMoney.schedulePortalRunPreviewQuote();
  const prevFn = extractFn(portalSrc, 'schedulePortalRenderCreateQuotePreview') || '';
  assert('RED money+no sum', /€-5\.00/.test(Q(rMoney)) && /total_cents/.test(prevFn) && !/amount_cents|rentals\.reduce|sumCents/.test(prevFn));
  const noBump = portalSrc.replace(
    /schedulePortalQuoteAbort = null;\n  \}\n  schedulePortalQuoteGen \+= 1;\n  schedulePortalShowQuoteChecking/,
    'schedulePortalQuoteAbort = null;\n  }\n  schedulePortalShowQuoteChecking');
  assert('RED deb mut', noBump !== portalSrc);
  const rDeb = sandMut(noBump, { debounceMs:350, uncooperative:true, quoteDelay:(n)=>n===1?200:10, quoteOutcome:(n)=>qBody(n,11100,22200) });
  rDeb._setPayload(baseCourse()); const rd1=rDeb.schedulePortalRefreshCreateQuote(); await sleep(400);
  rDeb._setPayload(baseCourse({ components:{ course:{ course_id:'c1', course_label:'G', quantity:2 } } }));
  rDeb.schedulePortalRefreshCreateQuote(); await sleep(200);
  assert('RED deb no gen', /€111/.test(Q(rDeb)) || (rDeb.schedulePortalQuoteState && rDeb.schedulePortalQuoteState.total_cents===11100));
  await rd1.catch(()=>null);
  const coerce = portalSrc.replace(
    /var raw = result\.body && result\.body\.total_cents;\n  if \(typeof raw !== 'number' \|\| !Number\.isFinite\(raw\) \|\| Math\.floor\(raw\) !== raw \|\| raw < 0 \|\| raw > Number\.MAX_SAFE_INTEGER\)/,
    "var raw = result.body && result.body.total_cents;\n  var total = typeof raw === 'number' ? raw : Number(raw);\n  if (!Number.isFinite(total) || Math.floor(total) !== total || total < 0 || total > Number.MAX_SAFE_INTEGER)")
    .replace(/\(raw \/ 100\)/g, '(total / 100)');
  const rCo = sandMut(coerce, { quoteDelay:5, quoteOutcome:()=>({ok:true,body:{success:true,total_cents:null}}) });
  await rCo.schedulePortalRunPreviewQuote(); assert('RED coerce', /€0\.00/.test(Q(rCo)));
  if (fail) { console.error('\nFAILED pass=' + pass + ' fail=' + fail); process.exit(1); }
  console.log('\nverify:sunset-booking-create-quote-summary — ALL CHECKS PASSED (pass=' + pass + ')\n');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
