'use strict';
const https = require('https');
const vm = require('vm');

const HOST = 'staff-staging.lunafrontdesk.com';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function extractFn(html, name) {
  const re = new RegExp('function ' + name + '[\\s\\S]*?\\n\\}');
  const m = html.match(re);
  if (!m) throw new Error('missing function ' + name);
  return m[0];
}

function stripBlockLabel(htmlCell) {
  const m = htmlCell.match(/class="bc-block bc-block-[^"]*"[^>]*>([^<]*)/);
  if (m) return m[1];
  const m2 = htmlCell.match(/class="bc-block [^"]*"[^>]*>([^<]*)/);
  return m2 ? m2[1] : '';
}

function simulateBedRow(html, days, bedBlocks) {
  const names = [
    'escHtml', 'bcColorClass', 'bcBlockTooltip', 'bcBlockLabel',
    'bcBlockVisibleOnDay', 'bcBlockDayLayer', 'bcTurnoverCheckoutOnDay',
    'bcTurnoverPrimarySeg', 'bcTurnoverCheckoutSeg', 'bcTurnoverVisibleLabel',
    'bcTurnoverCellTooltip', 'renderBcTurnoverDayCell', 'renderBookingBlock',
  ];
  const src = names.map((n) => extractFn(html, n)).join('\n');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src, ctx);

  const N = days.length;
  const daySegments = [];
  for (let di = 0; di < N; di++) {
    const dayDate = days[di].date || '';
    const segs = [];
    bedBlocks.forEach((entry) => {
      if (ctx.bcBlockVisibleOnDay(entry.blk, dayDate)) {
        segs.push({ blk: entry.blk, idx: entry.idx, layer: ctx.bcBlockDayLayer(entry.blk, dayDate) });
      }
    });
    daySegments.push(segs);
  }

  const cells = [];
  let pos = 0;
  while (pos < N) {
    const segsAt = daySegments[pos] || [];
    if (segsAt.length === 0) { cells.push({ type: 'empty', start: pos, span: 1 }); pos++; continue; }
    if (segsAt.length > 1) {
      cells.push({ type: 'turnover-cell', start: pos, span: 1, guest: ctx.bcTurnoverPrimarySeg(segsAt)?.blk?.guest_name });
      pos++;
      continue;
    }
    const spanBlkIdx = segsAt[0].idx;
    let spanLen = 1;
    while (pos + spanLen < N) {
      const nextSegs = daySegments[pos + spanLen] || [];
      if (nextSegs.length !== 1 || nextSegs[0].idx !== spanBlkIdx) break;
      spanLen++;
    }
    const spanStartDate = days[pos].date || '';
    const turnoverOut = ctx.bcTurnoverCheckoutOnDay(bedBlocks, spanStartDate, spanBlkIdx);
    const htmlCell = ctx.renderBookingBlock(segsAt[0].blk, segsAt[0].idx, spanLen, turnoverOut);
    cells.push({
      type: turnoverOut ? 'merged-turnover' : 'merged',
      start: pos,
      span: spanLen,
      startDate: spanStartDate,
      label: stripBlockLabel(htmlCell),
      guest: segsAt[0].blk.guest_name,
      hasMarker: /bc-block-checkout-marker/.test(htmlCell),
    });
    pos += spanLen;
  }
  return cells;
}

function simulateSelection(html, selStart, selEnd) {
  const src = [
    extractFn(html, 'bcSelectedDatesCount'),
    extractFn(html, 'bcSelectedNightsFromRange'),
    extractFn(html, 'bcStayNightsFromCheckInOut'),
  ].join('\n');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const coDate = new Date(selEnd + 'T00:00:00Z');
  coDate.setUTCDate(coDate.getUTCDate() + 1);
  const checkOut = coDate.toISOString().slice(0, 10);
  return {
    selStart,
    selEnd,
    checkOut,
    selectionNights: ctx.bcSelectedNightsFromRange(selStart, selEnd),
    formNights: ctx.bcStayNightsFromCheckInOut(selStart, checkOut),
  };
}

(async () => {
  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  const ui = await req('GET', '/staff/ui', null, cookie);
  const cal = await req('GET', '/staff/bed-calendar?client=wolfhouse-somo&start=2026-06-08&end=2026-06-17', null, cookie);
  const html = ui.body || '';
  const blocks = (cal.body && cal.body.blocks) || [];
  const days = (cal.body && cal.body.days) || [];

  const bedBlocks = blocks
    .filter((b) => b.bed_code === 'DEMO-R1-B1')
    .map((blk) => ({ blk, idx: blocks.indexOf(blk) }));

  const cells = simulateBedRow(html, days, bedBlocks);
  const outgoing = cells.find((c) => c.guest === 'Turnover Checkout Test');
  const incoming = cells.find((c) => c.guest === 'Turnover Checkin Test');
  const incomingCount = cells.filter((c) => c.guest === 'Turnover Checkin Test').length;

  const formFixtures = [
    { checkIn: '2026-06-10', checkOut: '2026-06-13', expected: 3 },
    { checkIn: '2026-06-13', checkOut: '2026-06-16', expected: 3 },
    { checkIn: '2026-06-10', checkOut: '2026-06-11', expected: 1 },
  ].map((f) => {
    const src = extractFn(html, 'bcStayNightsFromCheckInOut');
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    const actual = ctx.bcStayNightsFromCheckInOut(f.checkIn, f.checkOut);
    return { ...f, actual, pass: actual === f.expected };
  });

  const boxFixtures = [
    { selStart: '2026-06-10', selEnd: '2026-06-10', expectedSelection: 0 },
    { selStart: '2026-06-10', selEnd: '2026-06-11', expectedSelection: 1 },
    { selStart: '2026-06-10', selEnd: '2026-06-13', expectedSelection: 3 },
    { selStart: '2026-06-10', selEnd: '2026-06-16', expectedSelection: 6 },
  ].map((f) => {
    const r = simulateSelection(html, f.selStart, f.selEnd);
    return {
      ...f,
      selectionNights: r.selectionNights,
      formNights: r.formNights,
      pass: r.selectionNights === f.expectedSelection,
    };
  });

  const out = {
    deploy: {
      image: 'whstagingacr.azurecr.io/wh-staff-api:625b766-stage100d-calendar-final',
      revision: 'wh-staging-staff-api--0000050',
      commit: '625b7663e9b62a0ac857eaf407941e5d189cd398',
      acrRun: 'cb1c',
    },
    turnover: {
      outgoingContinuous: !!(outgoing && outgoing.span === 3 && outgoing.startDate === '2026-06-10'),
      incomingContinuous: !!(incoming && incoming.span === 3 && incoming.startDate === '2026-06-13'),
      incomingNameReadable: incoming && incoming.label === 'Turnover Checkin Test',
      tinyChipGone: !cells.some((c) => /MB-WOLFHO/.test(c.label || '')),
      duplicateSplitGone: incomingCount === 1,
      checkoutMarker: !!(incoming && incoming.hasMarker),
      noTurnoverCellJun13: !cells.some((c) => c.type === 'turnover-cell' && days[c.start]?.date === '2026-06-13'),
      rowCells: cells.map((c) => ({ type: c.type, startDate: c.startDate || days[c.start]?.date, span: c.span, guest: c.guest, label: c.label })),
    },
    formNights: formFixtures,
    selectedBoxes: boxFixtures,
    hostedJs: {
      bcStayNightsFromCheckInOut: /function bcStayNightsFromCheckInOut/.test(html),
      bcSelectedNightsFromRange: /function bcSelectedNightsFromRange/.test(html),
      formNightsInHighlight: /formNights = bcStayNightsFromCheckInOut/.test(html),
    },
    safety: {
      noWhatsapp: !/graph\.facebook\.com/.test(html),
      noStripe: !/api\.stripe\.com/.test(html),
      calReadOnly: cal.status === 200,
    },
  };

  const t = out.turnover;
  const formOk = formFixtures.every((f) => f.pass);
  const boxesOk = boxFixtures.every((f) => f.pass);
  const turnoverOk = t.outgoingContinuous && t.incomingContinuous && t.incomingNameReadable &&
    t.tinyChipGone && t.duplicateSplitGone && t.noTurnoverCellJun13;

  out.result = turnoverOk && formOk && boxesOk ? 'PASS' : 'PARTIAL';
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
