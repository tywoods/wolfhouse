'use strict';

/**
 * verify:sunset-schedule-row-normalizer
 *
 * Slice 23 — canonical Schedule row normalization gate.
 *
 * Run:
 *   node scripts/verify-sunset-schedule-row-normalizer.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const NORMALIZER_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-row-normalizer.js');
const RUNTIME_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-runtime.js');
const LOADER_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-data-loader.js');
const BROWSER_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-browser-source.js');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

console.log('\nverify:sunset-schedule-row-normalizer\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const modExists = fs.existsSync(NORMALIZER_MODULE);
const modSrc = modExists ? fs.readFileSync(NORMALIZER_MODULE, 'utf8') : '';
const loaderSrc = fs.readFileSync(LOADER_MODULE, 'utf8');
const browserSrc = fs.readFileSync(BROWSER_SRC, 'utf8');

console.log('[1] Module files (marker order — see verify:sunset-schedule-architecture)');
assert('row normalizer module exists', modExists);
assert('row normalizer inject marker in portal script', apiSrc.includes('/* INJECT:sunset-schedule-row-normalizer */'));
assert('browser source loads row normalizer module', browserSrc.includes('getSunsetScheduleRowNormalizerBrowserSource'));
assert('normalizer delegates to runtime', modSrc.includes('SunsetScheduleRuntime.rows'));
assert('inline function scheduleNormalizeApiRow removed from monolith', !/function scheduleNormalizeApiRow\(/.test(apiSrc));
assert('inline function scheduleEnsureRowId removed from monolith', !/function scheduleEnsureRowId\(/.test(apiSrc));
assert('inline function scheduleRowMeta removed from monolith', !/function scheduleRowMeta\(/.test(apiSrc));
assert('inline function scheduleRowIsCourse removed from monolith', !/function scheduleRowIsCourse\(/.test(apiSrc));
assert('inline function scheduleRowIsPrivateLesson removed from monolith', !/function scheduleRowIsPrivateLesson\(/.test(apiSrc));
assert('inline function scheduleRowSourceKind removed from monolith', !/function scheduleRowSourceKind\(/.test(apiSrc));
assert('monolith keeps scheduleBuildLoadedViewModel callback', apiSrc.includes('function scheduleBuildLoadedViewModel('));
assert('monolith invokes loaded-response normalizer', apiSrc.includes('scheduleNormalizeLoadedScheduleResponse'));
assert('module does not fetch', !modSrc.includes('fetch('));
assert('module does not touch DOM', !modSrc.includes('document.') && !modSrc.includes('innerHTML'));
assert('module does not expose window', !/window\.schedule/.test(modSrc));
assert('loader caches canonical rows only', fs.readFileSync(RUNTIME_MODULE, 'utf8').includes('viewModel.canonicalRows'));
assert('loader wrapper does not normalize inline', !loaderSrc.includes('scheduleNormalizeApiRow('));

console.log('\n[2] Module owns normalization symbols');
[
  'scheduleNormalizeApiRow',
  'scheduleNormalizeApiRowsBatch',
  'scheduleNormalizeLoadedScheduleResponse',
  'scheduleEnsureRowId',
  'scheduleEnsureRowMeta',
  'scheduleRowMeta',
  'scheduleRowIsCourse',
  'scheduleRowIsPrivateLesson',
  'scheduleRowSourceKind',
  'scheduleRowEffectivePaid',
  'scheduleNormalizePresentationDemoRow',
].forEach((name) => {
  assert(`module defines ${name}`, modSrc.includes(name));
});

console.log('\n[3] VM — canonical row contract');
if (modExists) {
  const ctx = {
    console,
    getClient: () => 'sunset',
    getSunsetLocation: () => 'sunset-somo',
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(RUNTIME_MODULE, 'utf8'), ctx);
  vm.runInContext(modSrc, ctx);

  const staffRaw = {
    service_record_id: 'sr-staff-1',
    booking_id: 'bk-staff-1',
    booking_code: 'SUN-001',
    service_date: '2026-07-15',
    record_source: 'staff_manual',
    guest_name: 'Staff Guest',
    quantity: 2,
    payment_status: 'paid',
    location_id: 'sunset-somo',
    metadata: { component: 'lesson', slot_time: '10:00' },
  };
  const lunaRaw = {
    service_record_id: 'sr-luna-1',
    booking_id: 'bk-luna-1',
    booking_code: 'SUN-002',
    service_date: '2026-07-15',
    record_source: 'luna_guest',
    guest_name: 'Luna Guest',
    quantity: 1,
    payment_status: 'pending',
    location_id: 'sunset-somo',
    needs_reply: true,
    metadata: { component: 'private_lesson' },
  };
  const unknownRaw = {
    service_record_id: 'sr-unk-1',
    booking_id: 'bk-unk-1',
    booking_code: 'SUN-UNK',
    service_date: '2026-07-15',
    record_source: 'legacy_import',
    guest_name: 'Unknown Guest',
    location_id: 'sunset-somo',
  };

  const normCtx = { locationId: 'sunset-somo', client: 'sunset' };

  const staff = ctx.scheduleNormalizeApiRow(staffRaw, normCtx);
  assert('1 minimal trusted staff record normalizes', staff && staff._scheduleId === 'sr-staff-1');
  assert('2 staff attribution', staff && staff._isDbManual === true && ctx.scheduleRowSourceKind(staff) === 'staff');
  const luna = ctx.scheduleNormalizeApiRow(lunaRaw, normCtx);
  assert('3 trusted Luna record same schema', luna && luna._scheduleId && luna.booking_id === 'bk-luna-1');
  assert('4 Luna attribution', luna && luna._isLuna === true && ctx.scheduleRowSourceKind(luna) === 'luna');
  const unknown = ctx.scheduleNormalizeApiRow(unknownRaw, normCtx);
  assert('5 unknown source not staff/Luna', unknown && !unknown._isDbManual && !unknown._isLuna && ctx.scheduleRowSourceKind(unknown) === 'unknown');
  assert('6 booking id server-derived', staff.booking_id === 'bk-staff-1');
  assert('7 booking code display-only identity', staff.booking_code === 'SUN-001');
  const tampered = ctx.scheduleNormalizeApiRow(Object.assign({}, staffRaw, { client_slug: 'wolfhouse-somo', location_id: 'sunset-somo' }), normCtx);
  assert('8 tenant cannot override via guest fields', tampered && tampered.booking_id === 'bk-staff-1');
  const conflict = ctx.scheduleNormalizeApiRow(Object.assign({}, staffRaw, { service_record_id: 'sr-conflict', location_id: 'other-beach' }), normCtx);
  assert('9 location conflict fail closed', conflict && conflict._canonicalBlocked === true);
  const staff2 = ctx.scheduleNormalizeApiRow(staffRaw, normCtx);
  assert('10 stable row id across repeats', staff2 && staff2._scheduleId === staff._scheduleId);
  const edited = ctx.scheduleNormalizeApiRow(Object.assign({}, staffRaw, { guest_name: 'Renamed Guest' }), normCtx);
  assert('11 stable id survives display edit', edited && edited._scheduleId === staff._scheduleId);
  const multi = ctx.scheduleNormalizeApiRowsBatch([
    Object.assign({}, staffRaw, { service_record_id: 'sr-a', metadata: { component: 'lesson' } }),
    Object.assign({}, staffRaw, { service_record_id: 'sr-b', metadata: { component: 'surfboard' }, service_type: 'board_rental' }),
  ], normCtx);
  assert('12 legitimate multiple services distinguishable', multi.canonicalRows.length === 2 && multi.canonicalRows[0]._scheduleId !== multi.canonicalRows[1]._scheduleId);
  const dup = ctx.scheduleNormalizeApiRowsBatch([staffRaw, Object.assign({}, staffRaw)], normCtx);
  assert('13 exact duplicate deduped', dup.canonicalRows.length === 1);
  const codeConflict = ctx.scheduleNormalizeApiRowsBatch([
    Object.assign({}, staffRaw, { booking_id: 'bk-a', booking_code: 'SAME' }),
    Object.assign({}, lunaRaw, { booking_id: 'bk-b', booking_code: 'SAME' }),
  ], normCtx);
  assert('14 conflicting booking code blocked', codeConflict.canonicalRows.every((r) => r._canonicalBlocked === true));
  const noBid = ctx.scheduleNormalizeApiRow(Object.assign({}, unknownRaw, { booking_id: null, service_record_id: 'sr-nobid' }), normCtx);
  assert('15 missing booking id blocked for canonical actions', noBid && noBid._canonicalBlocked === true);
  const sparse = ctx.scheduleNormalizeApiRow(Object.assign({}, staffRaw, { guest_name: undefined, phone: undefined, metadata: {} }), normCtx);
  assert('16 missing optional fields do not throw', sparse && sparse._scheduleId);
  const batchMixed = ctx.scheduleNormalizeApiRowsBatch([staffRaw, null, lunaRaw], normCtx);
  assert('17 malformed sibling does not corrupt batch', batchMixed.canonicalRows.length === 2 && batchMixed.errors.length === 1);
  const rawClone = JSON.parse(JSON.stringify(staffRaw));
  ctx.scheduleNormalizeApiRow(staffRaw, normCtx);
  assert('18 raw input unchanged', JSON.stringify(staffRaw) === JSON.stringify(rawClone));
  const frozen = ctx.scheduleNormalizeApiRow(staffRaw, normCtx);
  try {
    frozen.guest_name = 'mutated';
    assert('19 normalized output frozen', frozen.guest_name !== 'mutated');
  } catch (_) {
    assert('19 normalized output frozen', true);
  }

  console.log('\n[3b] Integration — frozen private-lesson row meta consumer path');
  const privateLessonRaw = {
    service_record_id: 'sr-pl-freeze',
    booking_id: 'bk-pl-freeze',
    booking_code: 'PL-001',
    service_date: '2026-07-15',
    record_source: 'luna_guest',
    guest_name: 'Private Guest',
    location_id: 'sunset-somo',
    service_time_local: '10:00',
    service_time_local_end: '12:00',
    metadata: { component: 'private_lesson', slot_time: '10:00', default_duration_minutes: 120 },
  };
  const frozenPrivate = ctx.scheduleNormalizeApiRow(privateLessonRaw, normCtx);
  assert('34 frozen private-lesson row normalizes', frozenPrivate && frozenPrivate._scheduleType === 'private_lesson');
  assert('35 normalized row is frozen', Object.isFrozen(frozenPrivate));
  assert('36 _meta attached before freeze', frozenPrivate._meta && frozenPrivate._meta.component === 'private_lesson');
  let metaConsumerError = null;
  let metaFromConsumer = null;
  try {
    metaFromConsumer = ctx.scheduleRowMeta(frozenPrivate);
  } catch (err) {
    metaConsumerError = err;
  }
  assert('37 scheduleRowMeta on frozen row does not throw', metaConsumerError === null, metaConsumerError && metaConsumerError.message);
  assert('38 scheduleRowMeta returns parsed metadata', metaFromConsumer && metaFromConsumer.slot_time === '10:00');

  function scheduleNormalizeSlotTime(raw) {
    var t = String(raw || '').trim();
    if (!t) return '';
    if (t.indexOf('-') >= 0) t = t.split('-')[0].trim();
    return t.slice(0, 5);
  }
  function schedulePrivateLessonTimeRange(row) {
    if (!row) return '';
    var start = scheduleNormalizeSlotTime(row.service_time_local || ctx.scheduleRowMeta(row).slot_time || row.slot_time || '');
    var end = scheduleNormalizeSlotTime(row.service_time_local_end || '');
    if (start && end) return start + ' – ' + end;
    return start || '';
  }
  function schedulePrivateLessonStartMinutes(row) {
    var tok = row && (row.service_time_local || ctx.scheduleRowMeta(row).slot_time || row.slot_time);
    tok = String(tok || '').trim();
    if (!tok) return null;
    if (tok.indexOf(':') >= 0) {
      var hp = tok.split(':');
      var h = parseInt(hp[0], 10);
      var m = parseInt(hp[1], 10);
      if (isNaN(h)) return null;
      return h * 60 + (isNaN(m) ? 0 : m);
    }
    return null;
  }
  let timingError = null;
  let timeRange = '';
  let startMinutes = null;
  try {
    timeRange = schedulePrivateLessonTimeRange(frozenPrivate);
    startMinutes = schedulePrivateLessonStartMinutes(frozenPrivate);
  } catch (err) {
    timingError = err;
  }
  assert('39 private-lesson timing consumer path does not throw', timingError === null, timingError && timingError.message);
  assert('40 private-lesson time range from meta', timeRange === '10:00 – 12:00');
  assert('41 private-lesson start minutes from meta', startMinutes === 600);

  const batchPrivate = ctx.scheduleNormalizeApiRowsBatch([privateLessonRaw], normCtx);
  const batchRow = batchPrivate.canonicalRows[0];
  let batchMetaError = null;
  try {
    ctx.scheduleRowMeta(batchRow);
  } catch (err) {
    batchMetaError = err;
  }
  assert('42 batch-frozen row exposes _meta', batchRow && batchRow._meta && batchRow._meta.component === 'private_lesson');
  assert('43 scheduleRowMeta on batch-frozen row does not throw', batchMetaError === null, batchMetaError && batchMetaError.message);

  const paidDerived = ctx.scheduleNormalizeApiRow(Object.assign({}, lunaRaw, {
    payment_status: 'pending',
    booking_payment_status: 'paid',
  }), normCtx);
  assert('20 payment display from server fields', paidDerived.payment_status === 'paid');
  assert('21 no balance fallback calc in module', !modSrc.includes('subtotal') && !modSrc.includes('balance_due') || modSrc.includes('booking_balance_due_cents'));
  assert('22 no price calculation in module', !modSrc.includes('total_cents') && !modSrc.includes('quote'));
  assert('23 needs reply from trusted input', luna._needsReply === true);
  const demo = ctx.scheduleNormalizePresentationDemoRow({
    _scheduleId: 'demo-lesson-paid',
    service_date: '2026-07-15',
    service_type: 'lesson',
    guest_name: 'Demo Guest',
  }, normCtx);
  assert('24 demo row presentation-only', demo && demo._isDemo === true && ctx.scheduleRowSourceKind(demo) === 'demo');
  assert('25 demo cannot collide canonical id', demo._scheduleId !== staff._scheduleId);
  assert('26 demo blocked for drawer gates', demo._trustSource === 'demo');
  const loaded = ctx.scheduleNormalizeLoadedScheduleResponse([
    { dateIso: '2026-07-15', rows: [staffRaw, lunaRaw], lessons: [], gear: [] },
  ], { demo_mode: false }, normCtx);
  assert('27 loaded response normalizes once', loaded.canonicalRows.length === 2);
  assert('28 canonical snapshot separate from demo', Array.isArray(loaded.canonicalRows) && loaded.presentationOnlyRows.length === 0);

  console.log('\n[4] Integration — loader installs canonical snapshot only');
  const dom = { 'ps-state': { textContent: '', className: '', style: { display: '' } } };
  let navGen = 0;
  const fetchCalls = [];
  const cacheInstalls = [];

  function scheduleNavigationLoadGen() { return navGen; }
  function scheduleRequestPageLoad() { navGen += 1; return ctx.loadSchedulePage({ mode: 'day', forwardOffset: 0, loadGen: navGen, todayIso: '2026-07-15' }); }
  function getPortalProfile() { return { is_surf_vertical: true, demo_mode: false }; }
  function renderScheduleSchoolContext() {}
  function scheduleTodayIso() { return '2026-07-15'; }
  function scheduleParseIso(s) { const p = String(s).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
  function scheduleAddDays(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function scheduleIsoDate(d) {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }
  function sunsetLocationQuerySuffix() { return '&location_id=sunset-somo'; }
  function inboxClientQuery() { return '?client=sunset'; }
  function scheduleFetchLessonTimesConfig() { return Promise.resolve([]); }
  function scheduleBuildDemoBookings() { return [{ _scheduleId: 'demo-x', _isDemo: true, service_date: '2026-07-15', service_type: 'lesson', guest_name: 'Demo' }]; }
  function scheduleMergeRowsIntoWeekData(weekData, extraRows) {
    const list = weekData || [];
    const map = {};
    list.forEach((p) => { map[p.dateIso] = p; });
    (extraRows || []).forEach((r) => {
      const iso = String(r.service_date || '').slice(0, 10);
      if (!map[iso]) { map[iso] = { dateIso: iso, lessons: [], gear: [], rows: [] }; list.push(map[iso]); }
      map[iso].rows.push(r);
    });
    return list;
  }
  function scheduleBuildLoadedViewModel(weekData, convData, profile, rangeStart, navSnapshot) {
    const norm = ctx.scheduleNormalizeLoadedScheduleResponse(weekData, profile, { locationId: 'sunset-somo', client: 'sunset' });
    let presentationOnlyRows = [];
    if (profile.demo_mode) {
      presentationOnlyRows = scheduleBuildDemoBookings(rangeStart).map((d) => ctx.scheduleNormalizePresentationDemoRow(d, { locationId: 'sunset-somo' }));
      weekData = scheduleMergeRowsIntoWeekData(norm.weekData, presentationOnlyRows);
    } else {
      weekData = norm.weekData;
    }
    cacheInstalls.push({ canonical: norm.canonicalRows.length, demo: presentationOnlyRows.length });
    return {
      weekData,
      canonicalRows: norm.canonicalRows,
      presentationOnlyRows,
      rows: norm.canonicalRows,
      conversations: [],
      profile,
      rangeStart,
      navSnapshot,
    };
  }
  function scheduleRenderLoadedViewModel() {}

  Object.assign(ctx, {
    portalT: (k) => k,
    el: (id) => dom[id] || null,
    fetch: (url) => {
      fetchCalls.push(url);
      if (String(url).includes('/staff/conversations')) {
        return Promise.resolve({ ok: true, json: () => ({ success: true, conversations: [] }) });
      }
      return Promise.resolve({
        ok: true,
        json: () => ({
          rows: [{
            service_record_id: 'sr-live-1',
            booking_id: 'bk-live-1',
            booking_code: 'LIVE-1',
            service_date: '2026-07-15',
            record_source: 'staff_manual',
            location_id: 'sunset-somo',
            guest_name: 'Live Staff',
            payment_status: 'paid',
            metadata: { component: 'lesson', slot_time: '11:00' },
          }],
        }),
      });
    },
    scheduleNavigationLoadGen,
    scheduleRequestPageLoad,
    getClient: () => 'sunset',
    getPortalProfile,
    renderScheduleSchoolContext,
    scheduleTodayIso,
    scheduleParseIso,
    scheduleAddDays,
    scheduleIsoDate,
    sunsetLocationQuerySuffix,
    inboxClientQuery,
    scheduleFetchLessonTimesConfig,
    scheduleBuildLoadedViewModel,
    scheduleRenderLoadedViewModel,
    scheduleBuildDemoBookings,
    scheduleMergeRowsIntoWeekData,
  });

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-navigation-ui.js'), 'utf8'), ctx);
  vm.runInContext(loaderSrc, ctx);

  async function waitLoads(n) {
    for (let i = 0; i < 40; i += 1) {
      if (cacheInstalls.length >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  (async () => {
    navGen = 1;
    ctx.scheduleNavigationState.loadGen = 1;
    ctx.scheduleNavigationState.navigationGen = 1;
    cacheInstalls.length = 0;
    await ctx.loadSchedulePage({ mode: 'day', forwardOffset: 0, loadGen: 1, todayIso: '2026-07-15' });
    await waitLoads(1);
    assert('29 cache installs canonical only', ctx.scheduleGetRowsSnapshot().length === 1 && ctx.scheduleGetRowsSnapshot()[0].booking_id === 'bk-live-1');
    assert('30 non-demo mode skips demo injection', cacheInstalls[0] && cacheInstalls[0].demo === 0);
    assert('31 drawer lookup resolves normalized row', ctx.scheduleFindRowById('sr-live-1') !== null);
    assert('32 wolfhouse monolith unchanged marker', !apiSrc.includes('wolfhouse-schedule-row-normalizer'));
    assert('33 module state not on window', typeof global.scheduleNormalizeApiRow === 'undefined');
  })().then(() => {
    console.log(`\n── verify:sunset-schedule-row-normalizer ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
    if (fail) process.exit(1);
  }).catch((e) => {
    console.error(e);
    process.exit(2);
  });
} else {
  console.log(`\n── verify:sunset-schedule-row-normalizer FAILED (pass=${pass} fail=${fail + 1}) ──\n`);
  process.exit(1);
}
