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

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

function extractFn(html, name) {
  const re = new RegExp('function ' + name + '[\\s\\S]*?\\n\\}');
  const m = html.match(re);
  if (!m) throw new Error('missing function ' + name);
  return m[0];
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
    segs.sort((sa, sb) => (sa.layer === sb.layer ? 0 : sa.layer === 'checkout' ? -1 : 1));
    daySegments.push(segs);
  }

  const cells = [];
  let pos = 0;
  while (pos < N) {
    const segsAt = daySegments[pos] || [];
    if (segsAt.length === 0) {
      cells.push({ type: 'empty', start: pos, span: 1, label: '' });
      pos++;
      continue;
    }
    if (segsAt.length > 1) {
      const htmlCell = ctx.renderBcTurnoverDayCell(days[pos].date, 'DEMO-R1', 'DEMO-R1-B1', segsAt);
      cells.push({
        type: 'turnover-cell',
        start: pos,
        span: 1,
        label: stripHtml(htmlCell.match(/bc-block-checkin-layer[^>]*>([^<]*)/)?.[1] || htmlCell.match(/bc-block[^>]*>([^<]*)/)?.[1] || ''),
        html: htmlCell,
      });
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
      label: stripHtml(htmlCell.match(/<div class="bc-block[^>]*>([^<]*)/)?.[1] || ''),
      guest: segsAt[0].blk.guest_name,
      hasMarker: /bc-block-checkout-marker/.test(htmlCell),
      hasDuplicateLabel: (htmlCell.match(/Turnover Checkin Test/g) || []).length > 1,
      html: htmlCell,
    });
    pos += spanLen;
  }
  return cells;
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
    .map((blk, _i, arr) => {
      const idx = blocks.indexOf(blk);
      return { blk, idx };
    });

  const cells = simulateBedRow(html, days, bedBlocks);
  const outgoing = cells.find((c) => c.guest === 'Turnover Checkout Test');
  const incoming = cells.find((c) => c.guest === 'Turnover Checkin Test');
  const incomingCount = cells.filter((c) => c.guest === 'Turnover Checkin Test').length;

  const jun13Idx = days.findIndex((d) => d.date === '2026-06-13');
  const jun13Cell = cells.find((c) => c.start <= jun13Idx && c.start + c.span > jun13Idx);

  const out = {
    deploy: {
      image: 'whstagingacr.azurecr.io/wh-staff-api:9a4adf6-stage100c-turnover-final',
      revision: 'wh-staging-staff-api--0000049',
      commit: '9a4adf6e9d5959ab05fe50df5da7ef8bbc8da3eb',
      acrRun: 'cb1b',
    },
    rowCells: cells.map((c) => ({
      type: c.type,
      startDate: days[c.start]?.date,
      span: c.span,
      label: c.label,
      guest: c.guest,
      hasMarker: c.hasMarker,
    })),
    visual: {
      outgoingJun10to12Continuous: outgoing && outgoing.span === 3 && outgoing.startDate === '2026-06-10',
      incomingJun13to15Continuous: incoming && incoming.span === 3 && incoming.startDate === '2026-06-13',
      incomingNameReadable: incoming && incoming.label === 'Turnover Checkin Test',
      tinyBookingCodeChipGone: !cells.some((c) => /MB-WOLFHO/.test(c.label)),
      duplicateSplitBlockGone: incomingCount === 1,
      jun13InIncomingBar: jun13Cell && jun13Cell.guest === 'Turnover Checkin Test' && jun13Cell.span === 3,
      checkoutMarkerOnIncoming: incoming && incoming.hasMarker === true,
      noSeparateTurnoverCellOnJun13: !cells.some((c) => c.type === 'turnover-cell' && c.startDate === '2026-06-13'),
    },
    hostedJs: {
      bcTurnoverCheckoutOnDay: /function bcTurnoverCheckoutOnDay/.test(html),
      halfOpenOnly: !/is_departure && dayDate === blk\.end_date/.test(extractFn(html, 'bcBlockVisibleOnDay')),
    },
    safety: {
      noWhatsapp: !/graph\.facebook\.com/.test(html),
      noStripe: !/api\.stripe\.com/.test(html),
      calReadOnlyGet: cal.status === 200,
    },
  };

  const v = out.visual;
  out.result = (
    v.outgoingJun10to12Continuous &&
    v.incomingJun13to15Continuous &&
    v.incomingNameReadable &&
    v.tinyBookingCodeChipGone &&
    v.duplicateSplitBlockGone &&
    v.jun13InIncomingBar &&
    v.noSeparateTurnoverCellOnJun13
  ) ? 'PASS' : 'PARTIAL';

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
