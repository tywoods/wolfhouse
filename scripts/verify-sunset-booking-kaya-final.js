'use strict';
/* Kaya Slice 6 offline final; mutation-hostile. node scripts/verify-sunset-booking-kaya-final.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const portalSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
const rentalSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-rental-availability.js'), 'utf8');
let pass = 0, fail = 0;
function assert(l, c, d) {
  if (c) { console.log('  PASS  ' + l); pass += 1; }
  else { console.error('  FAIL  ' + l + (d ? ' — ' + d : '')); fail += 1; }
}
function extractFn(src, name) {
  const n='function '+name+'(', s=src.indexOf(n); if(s<0)return null; const b=src.indexOf('{',s); let d=0;
  for(let i=b;i<src.length;i+=1){ if(src[i]==='{')d+=1; else if(src[i]==='}'){d-=1;if(!d)return src.slice(s,i+1);} } return null;
}
function extractModal(src){ const s=src.indexOf('id="ps-create-modal"'); const o=src.lastIndexOf('<div',s); const e=src.indexOf('id="ps-drawer-backdrop"',o); const c=src.lastIndexOf('</div>',e); return src.slice(o,c>o?c+6:e); }
function sleep(ms){ return new Promise((r)=>setTimeout(r,ms)); }
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const en = STAFF_PORTAL_STRINGS.en || {}, it = STAFF_PORTAL_STRINGS.it || {}, es = STAFF_PORTAL_STRINGS.es || {};
const modal = extractModal(apiSrc);
// Stable far-future "today" — no business-horizon decay (not rolling calendar).
const TODAY = '2035-06-15';
const TK=['guestRequired','componentsRequired','courseRequired','courseTierRequired','courseDurationUnavailable',
  'privateLesson.sessionIncomplete','privateLesson.sessionDatePast','privateLesson.sessionDuplicate','privateLesson.sessionEndAfterStart',
  'checkingPrice','creating','quoteFailed','quoteStale','quoteBusy','quoteTotal','failed','summary.chooseLessonOrGear','summary.completeSessions',
  'summary.sessions','summary.surfers'];
const T={}; TK.forEach((k)=>{ const full='schedule.create.'+k; T[full]=en[full]||k; });
Object.assign(T,{
  'calendar.state.invalidDateRange':en['calendar.state.invalidDateRange']||'Enter valid dates as DD/MM/YYYY.',
  'schedule.type.course':'Group course','schedule.type.privateLesson':'Private course','schedule.type.noLesson':'No lesson',
  'schedule.type.boardRental':'Board rental','schedule.type.wetsuitRental':'Wetsuit rental','schedule.ops.rentalBoth':'Surfboard + wetsuit',
  'schedule.payment.paid':'Paid','schedule.payment.unpaid':'Unpaid','admin.period.1_day':'1 day','admin.period.2_days':'2 day',
  'schedule.create.privateLesson.removeSession':'Remove','schedule.create.privateLesson.sessionLabel':'Session',
  'schedule.create.privateLesson.date':'Date','schedule.create.privateLesson.start':'Start','schedule.create.privateLesson.end':'End',
  'schedule.create.checkingPrice':en['schedule.create.checkingPrice']||'Checking price…',
  'schedule.create.quoteFailed':en['schedule.create.quoteFailed']||'Quote unavailable',
  'schedule.create.quoteStale':en['schedule.create.quoteStale']||'Price changed',
  'schedule.create.quoteBusy':en['schedule.create.quoteBusy']||'busy',
  'schedule.create.quoteTotal':en['schedule.create.quoteTotal']||'Quoted total',
});

function sandbox(opts) {
  opts = opts || {};
  const log = []; const nodes = {};
  let qn = 0, summaryN = 0, refreshN = 0, uuid = 0;
  function N(id, x) {
    nodes[id] = Object.assign({
      id, value: '', checked: false, disabled: false, textContent: '', innerHTML: '',
      style: { display: 'none' }, dataset: {}, classList: { add() {}, remove() {} },
      options: [], selectedIndex: -1, _ls: {},
      addEventListener(ev, fn) { (this._ls[ev] = this._ls[ev] || []).push(fn); },
      setAttribute(k, v) { this['_' + k] = v; }, getAttribute(k) { return this['_' + k] != null ? this['_' + k] : null; },
      querySelector() { return null; }, querySelectorAll() { return []; },
    }, x || {});
    return nodes[id];
  }
  N('ps-create-summary', { innerHTML: '<span>—</span>', style: { display: '' } });
  ['ps-create-quote-preview','ps-create-msg','ps-create-submit','ps-create-guest','ps-create-phone','ps-create-notes','ps-create-modal','ps-create-private-lesson-sessions','ps-create-comp-course','ps-create-comp-private-lesson','ps-create-comp-fullday'].forEach((id)=>N(id));
  N('ps-create-payment',{value:'unpaid'}); N('ps-create-date-from',{value:TODAY}); N('ps-create-date-to',{value:TODAY});
  N('ps-create-comp-no-lesson',{checked:true}); N('ps-create-rentals',{getAttribute:()=>'1_day'});
  N('ps-create-course-qty',{value:'1'}); N('ps-create-private-lesson-qty',{value:'1'}); N('ps-create-private-lesson-surfers',{value:'1'});
  const cOpts=[{value:'c1',textContent:'Beginner',getAttribute:(k)=>k==='data-label'?'Beginner':null}];
  const tOpts=[{value:'1_week',textContent:'1 week'}];
  N('ps-create-course-select',{value:'c1',options:cOpts,selectedIndex:0});
  N('ps-create-course-tier',{value:'1_week',options:tOpts,selectedIndex:0});
  let payload = opts.payload || { guest_name: '', date_from: TODAY, date_to: TODAY, payment_status: 'unpaid', components: {}, rentals: [] };
  const ctx = {
    console, setTimeout, clearTimeout, Promise, JSON, Object, Array, Number, String, Math, Date, Intl,
    AbortController: typeof AbortController !== 'undefined' ? AbortController : undefined,
    crypto: { randomUUID: () => 'idem-' + String(++uuid) },
    getClient: () => 'sunset', getSunsetLocation: () => 'sunset-somo',
    sunsetLocationQuerySuffix: () => '&location_id=sunset-somo',
    scheduleEnumerateDates: (a, b) => {
      const out = []; let cur = String(a).slice(0, 10); const end = String(b || a).slice(0, 10);
      while (cur && cur <= end) { out.push(cur); const d = new Date(cur + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); cur = d.toISOString().slice(0, 10); if (out.length > 40) break; }
      return out;
    },
    scheduleReadCreatePayload: () => JSON.parse(JSON.stringify(payload)),
    scheduleUpdateFullDayAddonSummary() {}, adminPeriodLabel: (k) => T['admin.period.' + k] || null,
    portalT: (k) => T[k] || k,
    escHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    el: (id) => nodes[id] || null,
    closeScheduleCreateModal() { ctx._closed = true; if (ctx.schedulePortalInvalidatePreviewWork) ctx.schedulePortalInvalidatePreviewWork(); },
    scheduleResetNavigationAfterBookingCreate() {}, scheduleRequestPageLoad() {}, scheduleFindCachedRowByBookingCode() { return null; },
    scheduleRentalOfferingLabelKey: (k) => (k === 'wetsuit_rental' ? 'schedule.type.wetsuitRental' : k === 'board_and_suit_rental' ? 'schedule.ops.rentalBoth' : k === 'board_rental' ? 'schedule.type.boardRental' : ''),
    scheduleTodayIso: () => TODAY,
    fetch(url, req) {
      const entry = { url: String(url), opts: req || {}, body: null };
      try { if (req && req.body) entry.body = JSON.parse(req.body); } catch (_e) { /* */ }
      log.push(entry);
      if (String(url).includes('/bookings/quote')) {
        const n = ++qn;
        const delay = typeof opts.quoteDelay === 'function' ? opts.quoteDelay(n) : (opts.quoteDelay || 0);
        const custom = typeof opts.quoteOutcome === 'function' ? opts.quoteOutcome(n, entry) : null;
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => {
            if (req && req.signal && req.signal.aborted) { const e = new Error('a'); e.name = 'AbortError'; return reject(e); }
            if (custom) return resolve({ ok: custom.ok !== false, status: custom.status || 200, json: () => Promise.resolve(custom.body || custom) });
            resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, total_cents: opts.total_cents != null ? opts.total_cents : 13500, quote_provenance: { source: 't', quote_fingerprint: 'fp' + n } }) });
          }, delay);
          if (req && req.signal) req.signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('a'); e.name = 'AbortError'; reject(e); });
        });
      }
      if (String(url).includes('/bookings?') && req && req.method === 'POST') {
        const custom = typeof opts.createOutcome === 'function' ? opts.createOutcome(entry) : null;
        if (custom) return Promise.resolve({ ok: custom.ok !== false, status: custom.status || 201, json: () => Promise.resolve(custom.body || custom) });
        return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ success: true, booking_code: 'BK-1', booking_id: 'id-1' }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, courses: [] }) });
    },
    _log: log, _nodes: nodes, _setPayload(p) { payload = p; }, _qn: () => qn,
    _counts: () => ({ summary: summaryN, refresh: refreshN }), _resetCounts() { summaryN = 0; refreshN = 0; },
  };
  vm.createContext(ctx);
  vm.runInContext(rentalSrc.replace(/if \(typeof module[\s\S]*$/, ''), ctx);
  vm.runInContext(opts.portalSrc || portalSrc, ctx);
  if (opts.debounceMs != null) ctx.schedulePortalQuoteDebounceMs = opts.debounceMs;
  if (typeof ctx.schedulePortalMadridTodayIso === 'function') ctx.schedulePortalMadridTodayIso = function () { return TODAY; };
  const _sum = ctx.schedulePortalRenderCreateIntentSummary.bind(ctx);
  ctx.schedulePortalRenderCreateIntentSummary = function (p) { summaryN += 1; return _sum(p); };
  const _ref = ctx.schedulePortalRefreshCreateQuote.bind(ctx);
  ctx.schedulePortalRefreshCreateQuote = function () { refreshN += 1; return _ref(); };
  return ctx;
}
const creates=(c)=>c._log.filter((e)=>String(e.url).includes('/bookings?')&&e.opts&&e.opts.method==='POST');
const quotes=(c)=>c._log.filter((e)=>String(e.url).includes('/bookings/quote'));
const msg=(c)=>String(c.el('ps-create-msg').textContent||'');
const S=(c)=>String(c.el('ps-create-summary').innerHTML||'');
const Q=(c)=>String(c.el('ps-create-quote-preview').innerHTML||'');
const baseCourse=(extra)=>Object.assign({guest_name:'Ada',date_from:TODAY,date_to:TODAY,payment_status:'unpaid',
  components:{course:{course_id:'c1',course_label:'Beginner',tier_key:'1_week',quantity:1}},rentals:[]},extra||{});
const rentalOnly=(extra)=>Object.assign({guest_name:'Bo',date_from:TODAY,date_to:'2035-06-16',payment_status:'unpaid',components:{},
  rentals:[{offering_key:'board_rental',duration_key:'2_days',quantity:1}]},extra||{});
const privatePL=(sessions,extra)=>Object.assign({guest_name:'Pri',date_from:'2035-06-16',date_to:'2035-06-18',payment_status:'unpaid',
  components:{private_lesson:{enabled:true,quantity:sessions.length,surfer_count:2,sessions}},rentals:[]},extra||{});

console.log('\nverify:sunset-booking-kaya-final — Kaya Slice 6\n');
console.log('[0] Owners + i18n + mobile');
assert('shared validation owner', /function schedulePortalValidateCreatePayload\s*\(/.test(portalSrc));
assert('sellable owner', /function schedulePortalHasSellableIntent\s*\(/.test(portalSrc));
assert('submit uses shared validation', (() => {
  const sub = extractFn(portalSrc, 'submitScheduleManualBooking') || '';
  return /schedulePortalValidateCreatePayload/.test(sub) && !/Object\.keys\(payload\.components\)\.length/.test(sub);
})());
assert('quote soft shared gate', /schedulePortalValidateCreatePayload\([^)]*soft:\s*true/.test(extractFn(portalSrc, 'schedulePortalRefreshCreateQuote') || '')
  && /schedulePortalValidateCreatePayload\([^)]*soft:\s*true/.test(extractFn(portalSrc, 'schedulePortalRunPreviewQuote') || ''));
assert('ps-create ids', ['ps-create-guest', 'ps-create-comp-no-lesson', 'ps-create-course-select', 'ps-create-course-tier',
  'ps-create-date-from', 'ps-create-rentals', 'ps-create-summary', 'ps-create-quote-preview', 'ps-create-submit']
  .every((id) => modal.includes('id="' + id + '"')));
assert('tenant school + a11y', /id="ps-create-school-label"/.test(modal) && /role="radiogroup"/.test(modal)
  && /for="ps-create-guest"/.test(modal) && /for="ps-create-date-from"/.test(modal)
  && /aria-labelledby="ps-create-main-activity-label"/.test(modal));
[
  'calendar.state.invalidDateRange',
  'schedule.create.componentsRequired', 'schedule.create.guestRequired',
  'schedule.create.courseRequired', 'schedule.create.courseTierRequired', 'schedule.create.courseDurationUnavailable',
  'schedule.create.creating', 'schedule.create.createBusy', 'schedule.create.idempotencyConflict',
].forEach((k) => assert('i18n ' + k, !!(en[k] && es[k] && it[k]) && es[k] !== en[k] && it[k] !== en[k]
  && !/^schedule\.create\.|^calendar\.state\./.test(en[k])));
assert('no dedicated date/rental create keys', !en['schedule.create.dateInvalid'] && !en['schedule.create.datePast']
  && !en['schedule.create.dateOrder'] && !en['schedule.create.rentalIncomplete']
  && !it['schedule.create.dateInvalid'] && !it['schedule.create.rentalIncomplete']);
assert('mobile pinned chrome', /portal-schedule-create-drawer\{[^}]*max-height:\s*100dvh/.test(apiSrc)
  && /portal-schedule-create-header\{[^}]*flex:\s*0\s+0\s+auto/.test(apiSrc)
  && /portal-schedule-create-body\{[^}]*overflow-y:\s*auto/.test(apiSrc)
  && /portal-schedule-create-footer\{[^}]*flex:\s*0\s+0\s+auto/.test(apiSrc)
  && /portal-schedule-create-summary\{[^}]*(-webkit-line-clamp:2|line-clamp:2)/.test(apiSrc)
  && /min-height:\s*44px/.test(apiSrc) && /safe-area-inset-bottom/.test(apiSrc)
  && /@media\(max-width:640px\)\{\.portal-schedule-private-session-grid\{grid-template-columns:1fr\}/.test(apiSrc));

(async function run() {
  console.log('\n[1] Fresh empty');
  const empty = sandbox(); empty.schedulePortalPrepareCreateOpen(null);
  assert('fresh defaults', empty.el('ps-create-comp-no-lesson').checked && empty.el('ps-create-payment').value === 'unpaid');
  empty._setPayload({ guest_name: '', date_from: TODAY, date_to: TODAY, payment_status: 'unpaid', components: {}, rentals: [] });
  empty.submitScheduleManualBooking(); await sleep(15);
  assert('empty error zero net', !!msg(empty) && empty._qn() === 0 && creates(empty).length === 0);

  console.log('\n[2] Group path');
  const group = sandbox({ debounceMs: 5, quoteDelay: 5 });
  group._setPayload(baseCourse({ payment_status: 'paid', date_to: '2035-06-17' }));
  group._resetCounts(); group.schedulePortalSyncCreateFooter();
  assert('group owners 1+1', group._counts().summary === 1 && group._counts().refresh === 1);
  await sleep(40);
  assert('group summary human', /Group course|Beginner|Paid|Ada/.test(S(group)) && !/c1|1_week|tier_key/.test(S(group)));
  assert('group quote ready', quotes(group).length === 1 && /€135\.00/.test(Q(group)));
  group.submitScheduleManualBooking(); await sleep(40);
  const gp = creates(group);
  assert('group one create', gp.length === 1 && gp[0].body.components.course.course_id === 'c1'
    && gp[0].body.components.course.tier_key === '1_week' && gp[0].body.location_id === 'sunset-somo'
    && gp[0].body.idempotency_key && gp[0].body.quote_provenance);
  const g2 = sandbox({ debounceMs: 5, quoteDelay: 30 });
  g2._setPayload(baseCourse()); g2.submitScheduleManualBooking(); g2.submitScheduleManualBooking(); await sleep(80);
  assert('double-click one create', creates(g2).length === 1);

  console.log('\n[3] Private');
  const priv = sandbox({ debounceMs: 5, quoteDelay: 5 });
  priv._setPayload(privatePL([
    { date: '2035-06-16', start: '10:00', end: '12:00' },
    { date: '2035-06-18', start: '10:00', end: '12:00' },
  ], { rentals: [{ offering_key: 'wetsuit_rental', duration_key: '1_day', quantity: 1 }] }));
  priv.schedulePortalRenderCreateIntentSummary();
  assert('private summary', /Sessions:\s*2/.test(S(priv)));
  priv.submitScheduleManualBooking(); await sleep(50);
  assert('private create', creates(priv).length === 1 && creates(priv)[0].body.components.private_lesson.sessions.length === 2
    && creates(priv)[0].body.rentals.length === 1);
  for (const row of [
    [{ date: '', start: '10:00', end: '12:00' }],
    [{ date: '2035-06-01', start: '10:00', end: '12:00' }],
    [{ date: '2035-06-16', start: '10:00', end: '12:00' }, { date: '2035-06-16', start: '10:00', end: '12:00' }],
    [{ date: '2035-06-16', start: '12:00', end: '10:00' }],
  ]) {
    const bad = sandbox({ debounceMs: 5 });
    bad._setPayload(privatePL(row, { guest_name: 'X' }));
    bad.submitScheduleManualBooking(); await sleep(10);
    assert('private invalid zero', bad._qn() === 0 && creates(bad).length === 0 && !!msg(bad));
  }

  console.log('\n[4] Rental-only (canonical payload)');
  assert('sellable rentals', sandbox().schedulePortalHasSellableIntent(rentalOnly()) === true);
  assert('sellable empty false', sandbox().schedulePortalHasSellableIntent({ components: {}, rentals: [] }) === false);
  const rent = sandbox({ debounceMs: 5, quoteDelay: 5 });
  rent._setPayload(rentalOnly()); rent.schedulePortalRenderCreateIntentSummary();
  assert('rental summary human', /Board rental/.test(S(rent)) && /2 day/.test(S(rent)) && !/board_rental|2_days/.test(S(rent)));
  rent.submitScheduleManualBooking(); await sleep(50);
  assert('rental-only once', rent._qn() === 1 && creates(rent).length === 1, 'q=' + rent._qn() + ' c=' + creates(rent).length + ' ' + msg(rent));
  const rb = creates(rent)[0] && creates(rent)[0].body;
  assert('rental payload canonical', rb && !rb.components.course && !rb.components.private_lesson
    && rb.rentals[0].offering_key === 'board_rental' && rb.location_id === 'sunset-somo' && rb.idempotency_key);

  console.log('\n[4b] Real DOM rental-only (production readers)');
  const readPayloadSrc = extractFn(apiSrc, 'scheduleReadCreatePayload');
  const readRentalsSrc = extractFn(apiSrc, 'scheduleReadCreateRentalSelectionFromDom');
  assert('prod readers extractable', !!readPayloadSrc && !!readRentalsSrc);
  const dom = sandbox({ debounceMs: 5, quoteDelay: 5 });
  const check = { className: 'ps-create-rental-check', checked: true };
  const qty = { className: 'ps-create-rental-qty-input', value: '1' };
  const row = { getAttribute: (n) => n === 'data-rental-offering' ? 'board_rental' : null,
    querySelector: (sel) => sel.includes('rental-check') ? check : sel.includes('qty') ? qty : null };
  Object.assign(dom._nodes['ps-create-comp-no-lesson'], { checked: true });
  Object.assign(dom._nodes['ps-create-comp-course'], { checked: false });
  Object.assign(dom._nodes['ps-create-comp-private-lesson'], { checked: false });
  dom._nodes['ps-create-guest'].value = 'DomBo';
  dom._nodes['ps-create-date-from'].value = TODAY; dom._nodes['ps-create-date-to'].value = '2035-06-16';
  dom._nodes['ps-create-payment'].value = 'unpaid';
  dom._nodes['ps-create-rentals'] = { getAttribute: (k) => k === 'data-duration-key' ? '2_days' : '',
    querySelectorAll: (sel) => sel === '[data-rental-offering]' ? [row] : [], querySelector: () => null };
  vm.runInContext([readRentalsSrc, readPayloadSrc].join('\n'), dom);
  const domP = dom.scheduleReadCreatePayload();
  assert('DOM dual rentals+legacy', !!(domP && domP.rentals && domP.rentals[0] && domP.rentals[0].offering_key === 'board_rental'
    && domP.rentals[0].duration_key === '2_days' && domP.rentals[0].quantity === 1
    && domP.components && domP.components.surfboard && domP.components.surfboard.quantity === 1
    && !domP.components.course && !domP.components.private_lesson), JSON.stringify(domP));
  dom.scheduleReadCreatePayload = function () { return JSON.parse(JSON.stringify(domP)); };
  await dom.schedulePortalRunPreviewQuote();
  assert('DOM rental quote ready', dom._qn() === 1 && /€135\.00/.test(Q(dom)));
  dom.submitScheduleManualBooking(); await sleep(40);
  const db = creates(dom)[0] && creates(dom)[0].body;
  assert('DOM rental create once', creates(dom).length === 1 && db && db.rentals[0].offering_key === 'board_rental'
    && db.components.surfboard && db.location_id === 'sunset-somo' && db.idempotency_key);

  console.log('\n[5-6] Combo + empty gear');
  const combo = sandbox({ debounceMs: 5, quoteDelay: 5 });
  combo._setPayload(baseCourse({ rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 2 }] }));
  combo.submitScheduleManualBooking(); await sleep(50);
  const cb = creates(combo)[0] && creates(combo)[0].body;
  assert('group+gear', cb && cb.components.course && cb.rentals[0].quantity === 2);
  const none = sandbox();
  none._setPayload({ guest_name: 'Zed', date_from: TODAY, date_to: TODAY, payment_status: 'unpaid', components: {}, rentals: [] });
  none.submitScheduleManualBooking(); await sleep(10);
  assert('no gear fail closed', none._qn() === 0 && creates(none).length === 0 && !!msg(none));

  console.log('\n[7] Quote errors + idempotency');
  const err = sandbox({ debounceMs:5, quoteDelay:5, quoteOutcome:(n)=>n===1?{ok:false,status:409,body:{success:false,reason_code:'quote_stale'}}
    :n===2?{ok:false,status:503,body:{success:false}}:{ok:false,status:200,body:{success:true}} });
  err._setPayload(baseCourse());
  const k0 = err.schedulePortalEnsureIdempotencyKey(baseCourse());
  err.submitScheduleManualBooking(); await sleep(40);
  assert('409 retain key', creates(err).length === 0 && err.schedulePortalSubmitIdemKey === k0);
  err.schedulePortalSubmitInFlight = false; err.el('ps-create-submit').disabled = false;
  err.submitScheduleManualBooking(); await sleep(40);
  assert('503 same key', creates(err).length === 0 && err.schedulePortalSubmitIdemKey === k0);
  err.schedulePortalSubmitInFlight = false; err.el('ps-create-submit').disabled = false;
  err.submitScheduleManualBooking(); await sleep(40);
  assert('malformed same key', creates(err).length === 0 && err.schedulePortalSubmitIdemKey === k0);
  assert('same intent', err.schedulePortalEnsureIdempotencyKey(baseCourse()) === k0);
  assert('rotate intent', err.schedulePortalEnsureIdempotencyKey(baseCourse({ guest_name: 'Other' })) !== k0);

  console.log('\n[8] Ambiguous loss');
  const amb = sandbox({ debounceMs: 5, quoteDelay: 5 });
  const _f = amb.fetch;
  amb.fetch = function (url, req) {
    if (String(url).includes('/bookings?') && req && req.method === 'POST') {
      amb._log.push({ url: String(url), opts: req || {}, body: req && req.body ? JSON.parse(req.body) : null });
      return Promise.reject(new Error('network_loss'));
    }
    return _f.call(this, url, req);
  };
  amb._setPayload(baseCourse());
  const ak = amb.schedulePortalEnsureIdempotencyKey(baseCourse());
  amb.submitScheduleManualBooking(); await sleep(50);
  assert('ambiguous create+key', creates(amb).length === 1 && amb.schedulePortalSubmitIdemKey === ak && amb.schedulePortalCreateAmbiguous === true);
  assert('retry same key', amb.schedulePortalEnsureIdempotencyKey(baseCourse()) === ak);
  amb.schedulePortalSubmitInFlight = false; amb.el('ps-create-submit').disabled = false;
  amb.submitScheduleManualBooking(); await sleep(50);
  assert('ambiguous second same key', creates(amb).length === 2 && creates(amb).every((e) => e.body.idempotency_key === ak));
  const ok = sandbox({ debounceMs: 5, quoteDelay: 5 });
  ok._setPayload(baseCourse()); ok.submitScheduleManualBooking(); await sleep(50);
  assert('success clears', ok.schedulePortalSubmitIdemKey == null && ok.schedulePortalCreateAmbiguous === false);

  console.log('\n[9-11] Tenant + owners + races');
  const ten = sandbox({ debounceMs: 5, quoteDelay: 5 });
  ten._setPayload(baseCourse()); ten.submitScheduleManualBooking(); await sleep(40);
  assert('sunset-somo', creates(ten).every((e) => e.body.location_id === 'sunset-somo')
    && quotes(ten).every((e) => String(e.url).includes('client=sunset') && String(e.url).includes('location_id=sunset-somo')));
  const ev = sandbox({ debounceMs: 80, quoteDelay: 5 });
  ev._setPayload(baseCourse()); ev._resetCounts(); ev.schedulePortalSyncCreateFooter();
  assert('one action', ev._counts().summary === 1 && ev._counts().refresh === 1 && ev._qn() === 0);
  await sleep(120); assert('debounced quote', ev._qn() === 1);
  const soft = sandbox({ debounceMs: 5 });
  soft._setPayload(privatePL([{ date: '', start: '', end: '' }]));
  const softR = await soft.schedulePortalRunPreviewQuote();
  assert('soft private', soft._qn() === 0 && softR && softR.softInvalid);
  async function race(delays, label) {
    const c = sandbox({
      debounceMs: 5, quoteDelay: (n) => delays[n - 1],
      quoteOutcome: (n) => ({ ok: true, body: { success: true, total_cents: n === 1 ? 11100 : 22200, quote_provenance: { source: n === 1 ? 'A' : 'B' } } }),
    });
    c._setPayload(baseCourse());
    const r1 = c.schedulePortalRunPreviewQuote(); await sleep(delays[0] === 5 ? 2 : 10);
    c._setPayload(baseCourse({ components: { course: { course_id: 'c1', course_label: 'G', tier_key: '1_week', quantity: 2 } } }));
    await Promise.all([r1, c.schedulePortalRunPreviewQuote()]);
    assert(label, c.schedulePortalQuoteState && c.schedulePortalQuoteState.total_cents === 22200);
  }
  await race([60, 5], 'race B-then-A'); await race([5, 40], 'race A-then-B');

  console.log('\n[12] Soft gate — invalid debounce zero net + correction');
  const invalids = [
    ['inverted', baseCourse({ date_from: '2035-06-20', date_to: '2035-06-15' })],
    ['past', baseCourse({ date_from: '2035-06-01', date_to: '2035-06-01' })],
    ['impossible', baseCourse({ date_from: '2035-02-31', date_to: '2035-02-31' })],
    ['suffix', baseCourse({ date_from: '2035-06-16junk', date_to: '2035-06-16junk' })],
    ['unknown', rentalOnly({ rentals: [{ offering_key: 'mystery_rental', duration_key: '1_day', quantity: 1 }] })],
    ['emptyDur', rentalOnly({ rentals: [{ offering_key: 'board_rental', duration_key: '', quantity: 1 }] })],
    ['qty0', rentalOnly({ rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 0 }] })],
    ['frac', rentalOnly({ rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1.5 }] })],
    ['noCid', baseCourse({ components: { course: { course_id: '', course_label: 'G', tier_key: '1_week', quantity: 1 } } })],
    ['noTier', baseCourse({ components: { course: { course_id: 'c1', course_label: 'G', tier_key: '', quantity: 1 } } })],
  ];
  for (const [lab, p] of invalids) {
    const c = sandbox({ debounceMs: 30, quoteDelay: 5 });
    c._setPayload(baseCourse()); await c.schedulePortalRunPreviewQuote();
    const qn0 = c._qn();
    assert(lab + ' seed+soft', qn0 === 1 && /€135\.00/.test(Q(c)) && c.schedulePortalQuoteState);
    c._setPayload(p); c.schedulePortalRefreshCreateQuote();
    assert(lab + ' sync clear/zero', c.schedulePortalQuoteState == null && !/€135/.test(Q(c)) && !msg(c) && !/schedule\.create\./.test(Q(c)));
    await sleep(60); assert(lab + ' post-debounce qn', c._qn() === qn0 && !msg(c));
  }
  const missG = sandbox({ debounceMs: 5, quoteDelay: 5 });
  missG._setPayload(baseCourse({ guest_name: '' }));
  await missG.schedulePortalRefreshCreateQuote(); await sleep(40);
  assert('missing guest still quotes', missG._qn() === 1 && /€135\.00/.test(Q(missG)) && !msg(missG));
  const corr = sandbox({ debounceMs: 5, quoteDelay: 5 });
  corr._setPayload(baseCourse({ date_from: '2035-06-20', date_to: '2035-06-15' }));
  corr.schedulePortalRefreshCreateQuote(); await sleep(40);
  assert('invalid pre zero', corr._qn() === 0 && !/€/.test(Q(corr)));
  corr._setPayload(baseCourse());
  corr.schedulePortalRefreshCreateQuote();
  assert('valid shows checking', /Checking price/.test(Q(corr)));
  await sleep(40);
  assert('invalid→valid one Ready', corr._qn() === 1 && /€135\.00/.test(Q(corr)));
  corr._setPayload(baseCourse({ components: { course: { course_id: 'c1', course_label: 'G', tier_key: '', quantity: 1 } } }));
  corr.schedulePortalRefreshCreateQuote(); await sleep(40);
  const missTierClear = corr._qn() === 1 && !/€135/.test(Q(corr)) && !msg(corr);
  corr._setPayload(baseCourse()); corr.schedulePortalRefreshCreateQuote(); await sleep(40);
  assert('miss tier→Ready', missTierClear && corr._qn() === 2 && /€135\.00/.test(Q(corr)));
  let dirOk = true;
  for (const p of [baseCourse({ date_from: '2035-06-01', date_to: '2035-06-01' }), baseCourse({ components: { course: { course_id: '', course_label: 'G', tier_key: '1_week', quantity: 1 } } }), baseCourse({ components: { course: { course_id: 'c1', course_label: 'G', tier_key: '', quantity: 1 } } })]) {
    const d = sandbox({ debounceMs: 5 }); d._setPayload(p); const r = await d.schedulePortalRunPreviewQuote();
    if (!(d._qn() === 0 && r && r.softInvalid && !msg(d))) dirOk = false;
  }
  assert('direct invalid/course zero net', dirOk);
  const idle = sandbox({ debounceMs: 5 });
  idle.el('ps-create-quote-preview').innerHTML = 'Quoted total: €9.00'; idle.el('ps-create-quote-preview').style.display = 'block';
  idle._setPayload({ guest_name: '', date_from: TODAY, date_to: TODAY, payment_status: 'unpaid', components: {}, rentals: [] });
  const idleR = await idle.schedulePortalRunPreviewQuote();
  assert('empty idle hidden', idleR == null && idle._qn() === 0 && !/€9/.test(Q(idle)) && Q(idle) === '');

  console.log('\n[13] Mutation RED');
  // Canonical rentals-only regression (payload without legacy components) — sellable owner.
  const stripSellable = portalSrc
    .replace(/function schedulePortalHasSellableIntent\(payload\) \{[\s\S]*?\n\}/,
      'function schedulePortalHasSellableIntent(payload){ var p=payload||{},c=p.components||{}; return !!(c.course||c.private_lesson||c.surfboard||c.wetsuit); }')
    .replace(/function schedulePortalValidateCreatePayload\(payload, opts\) \{[\s\S]*?\n\}/,
      'function schedulePortalValidateCreatePayload(payload, opts){ opts=opts||{}; var p=payload||{}; if(!opts.soft&&!(p.guest_name&&String(p.guest_name).trim()))return{ok:false,errorKey:"schedule.create.guestRequired"}; if(!Object.keys(p.components||{}).length)return{ok:false,errorKey:"schedule.create.componentsRequired"}; return{ok:true}; }');
  assert('mut sellable', stripSellable !== portalSrc);
  const redRent = sandbox({ portalSrc: stripSellable, debounceMs: 5, quoteDelay: 5 });
  redRent._setPayload(rentalOnly()); redRent.submitScheduleManualBooking(); await sleep(30);
  assert('RED canonical rentals-only reject', creates(redRent).length === 0 && redRent._qn() === 0);
  // Soft gate bypass: incomplete course must quote (true RED).
  const noSoft = portalSrc.replace(/schedulePortalValidateCreatePayload\([^)]*,\s*\{\s*soft:\s*true\s*\}\)/g, '({ ok: true }/*mut soft*/)');
  assert('mut soft gate', noSoft !== portalSrc && /\/\*mut soft\*\//.test(noSoft));
  const redSoft = sandbox({ portalSrc: noSoft, debounceMs: 5, quoteDelay: 5 });
  redSoft._setPayload(baseCourse({ components: { course: { course_id: '', course_label: 'G', tier_key: '1_week', quantity: 1 } } }));
  await redSoft.schedulePortalRefreshCreateQuote(); await sleep(40);
  assert('RED soft bypass incomplete course', redSoft._qn() >= 1, 'qn=' + redSoft._qn());
  const greenSoft = sandbox({ debounceMs: 5, quoteDelay: 5 });
  greenSoft._setPayload(baseCourse({ date_from: '2035-06-20', date_to: '2035-06-15' }));
  await greenSoft.schedulePortalRefreshCreateQuote(); await sleep(40);
  assert('GREEN soft blocks invalid', greenSoft._qn() === 0);
  const noLock = portalSrc.replace(
    /function submitScheduleManualBooking\(\) \{\n  if \(schedulePortalSubmitInFlight\) return;/,
    'function submitScheduleManualBooking() {\n  if (false && schedulePortalSubmitInFlight) return;'
  );
  const redLock = sandbox({ portalSrc: noLock, debounceMs: 5, quoteDelay: 30 });
  redLock._setPayload(baseCourse()); redLock.submitScheduleManualBooking(); redLock.submitScheduleManualBooking(); await sleep(80);
  assert('RED no lock multi quote', quotes(redLock).length >= 2);
  const greenLock = sandbox({ debounceMs: 5, quoteDelay: 30 });
  greenLock._setPayload(baseCourse()); greenLock.submitScheduleManualBooking(); greenLock.submitScheduleManualBooking(); await sleep(80);
  assert('GREEN lock single', quotes(greenLock).length === 1 && creates(greenLock).length === 1);
  const softPriv = portalSrc.replace(/function schedulePortalValidatePrivateLessonCreate\(pl\) \{[\s\S]*?\n\}/,
    'function schedulePortalValidatePrivateLessonCreate(pl){ return { ok: true }; }');
  const redPriv = sandbox({ portalSrc: softPriv, debounceMs: 5, quoteDelay: 5 });
  redPriv._setPayload(privatePL([{ date: '', start: '', end: '' }], { guest_name: 'X' }));
  redPriv.submitScheduleManualBooking(); await sleep(40);
  assert('RED private leak', creates(redPriv).length > 0 || redPriv._qn() > 0);
  const softTot = portalSrc.replace(/function schedulePortalStrictQuoteTotalCents\(body\) \{[\s\S]*?\n\}/,
    'function schedulePortalStrictQuoteTotalCents(body){ return body && body.total_cents != null ? Number(body.total_cents) : null; }')
    .replace(/var totalCents = schedulePortalStrictQuoteTotalCents\(data\);\n    if \(totalCents == null\) \{\n      if \(applyState && myGen === schedulePortalQuoteGen\) schedulePortalQuoteState = null;\n      return \{ ok: false, error: 'invalid_quote_total', body: data \};\n    \}\n    if \(applyState && myGen === schedulePortalQuoteGen\) \{\n      schedulePortalQuoteState = \{ quote_provenance: data\.quote_provenance \|\| null, total_cents: totalCents, fetched_at: Date\.now\(\), gen: myGen \};\n    \}/,
      'if (applyState && myGen === schedulePortalQuoteGen) { schedulePortalQuoteState = { quote_provenance: data.quote_provenance || null, total_cents: data.total_cents != null ? Number(data.total_cents) : null, fetched_at: Date.now(), gen: myGen }; }');
  const redTot = sandbox({ portalSrc: softTot, debounceMs: 5, quoteDelay: 5,
    quoteOutcome: () => ({ ok: true, body: { success: true, total_cents: null, quote_provenance: { source: 'x' } } }) });
  redTot._setPayload(baseCourse()); redTot.submitScheduleManualBooking(); await sleep(50);
  assert('RED strict total', creates(redTot).length === 1);
  assert('RED mobile pin', apiSrc.replace(/\.portal-schedule-create-footer\{flex:0 0 auto/, '.portal-schedule-create-footer{flex:1 1 auto') !== apiSrc);

  console.log('\n[14] Hard gates + full-day');
  let hardOk=true;
  const hardCases=[
    [baseCourse({date_from:'2035-06-01',date_to:'2035-06-01'}), 'calendar.state.invalidDateRange'],
    [baseCourse({date_from:'2035-06-22',date_to:'2035-06-15'}), 'calendar.state.invalidDateRange'],
    [rentalOnly({rentals:[{offering_key:'board_rental',duration_key:'',quantity:1}]}), 'schedule.create.componentsRequired'],
    [rentalOnly({rentals:[{offering_key:'mystery_rental',duration_key:'1_day',quantity:1}]}), 'schedule.create.componentsRequired'],
    [baseCourse({components:{course:{course_id:'',course_label:'G',tier_key:'1_week',quantity:1}}}), 'schedule.create.courseRequired'],
  ];
  for (const [p, wantKey] of hardCases) {
    const c=sandbox(); c._setPayload(p); c.submitScheduleManualBooking(); await sleep(8);
    const m=msg(c);
    if (c._qn()!==0||creates(c).length!==0||m!==T[wantKey]||/schedule\.create\.|calendar\.state\./.test(m)) hardOk=false;
  }
  assert('hard date/rental/course blocked', hardOk);
  assert('full-day sellable', sandbox().schedulePortalHasSellableIntent({
    components:{ full_day_equipment_extension:{ enabled:true, dates:{[TODAY]:1} } }, rentals:[] })===true);

  if (fail) { console.error('\nFAILED pass=' + pass + ' fail=' + fail); process.exit(1); }
  console.log('\nverify:sunset-booking-kaya-final — ALL CHECKS PASSED (pass=' + pass + ')\n');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
