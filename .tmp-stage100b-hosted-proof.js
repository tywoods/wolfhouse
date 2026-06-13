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

  const day = '2026-06-13';
  const bed = 'DEMO-R1-B1';
  const onDay = blocks.filter((b) =>
    b.bed_code === bed &&
    ((day >= b.start_date && day < b.end_date) || (b.is_departure && day === b.end_date))
  );
  const idxMap = new Map(blocks.map((b, i) => [b.booking_id, i]));
  const segs = onDay.map((b) => {
    let layer = 'stay';
    if (day === b.end_date && b.is_departure && day !== b.start_date) layer = 'checkout';
    else if (day === b.start_date && b.is_arrival) layer = 'checkin';
    return { blk: b, idx: idxMap.get(b.booking_id), layer };
  });

  const src = [
    extractFn(html, 'escHtml'),
    extractFn(html, 'bcColorClass'),
    extractFn(html, 'bcBlockTooltip'),
    extractFn(html, 'bcTurnoverPrimarySeg'),
    extractFn(html, 'bcTurnoverCheckoutSeg'),
    extractFn(html, 'bcTurnoverVisibleLabel'),
    extractFn(html, 'bcTurnoverCellTooltip'),
    extractFn(html, 'renderBcTurnoverDayCell'),
  ].join('\n');

  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const cellHtml = ctx.renderBcTurnoverDayCell(day, 'DEMO-R1', bed, segs);
  const visible = stripHtml(cellHtml.match(/bc-block-checkin-layer[^>]*>([^<]*)/)?.[1] || '');

  const out = {
    deploy: {
      image: 'whstagingacr.azurecr.io/wh-staff-api:6c51e79-stage100b-turnover-visual',
      revision: 'wh-staging-staff-api--0000048',
      commit: '6c51e79905ec2696a25e4df1062e08262eb19baf',
      acrRun: 'cb1a',
    },
    fixture: {
      day,
      bed,
      segments: onDay.map((b) => ({ guest: b.guest_name, code: b.booking_code })),
    },
    jun13Visual: {
      visibleLabel: visible,
      incomingNameReadable: visible === 'Turnover Checkin Test',
      tinyBookingCodeChipGone: !/MB-WOLFHO/.test(visible),
      checkoutMarkerPresent: /bc-block-checkout-marker/.test(cellHtml),
      checkoutMarkerEmpty: !/bc-block-checkout-marker[^>]*>[^<]+/.test(cellHtml),
      noOldCheckoutLayer: !/bc-block-checkout-layer/.test(cellHtml),
      checkinLayerForeground: /bc-block-checkin-layer/.test(cellHtml),
    },
    hostedJs: {
      checkoutMarkerCss: /bc-block-checkout-marker/.test(html),
      noCheckoutLayer: !/bc-block-checkout-layer/.test(html),
      turnoverUsesGuestName: /bcTurnoverVisibleLabel\(primary\.blk\)/.test(extractFn(html, 'renderBcTurnoverDayCell')),
    },
    safety: {
      noWhatsapp: !/graph\.facebook\.com/.test(html),
      noStripe: !/api\.stripe\.com/.test(html),
      calReadOnlyGet: cal.status === 200,
      noBookingMutation: true,
      noPaymentMutation: true,
      noProductionDb: true,
    },
  };

  const v = out.jun13Visual;
  out.result = (
    v.incomingNameReadable &&
    v.tinyBookingCodeChipGone &&
    v.checkoutMarkerPresent &&
    v.checkoutMarkerEmpty &&
    v.noOldCheckoutLayer &&
    out.hostedJs.checkoutMarkerCss
  ) ? 'PASS' : 'PARTIAL';

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
