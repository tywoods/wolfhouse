'use strict';

const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = 'cd18eaec62179f6c88701245985fc59ffab4187e';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:cd18eae-stage107b-calendar-source-colors';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function activeRevision() {
  const rows = JSON.parse(execSync(
    'az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' },
  ));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties.template.containers[0].image,
  };
}

function extractBedCalendarPanel(html) {
  const s = html.indexOf('id="tab-bed-calendar"');
  const e = html.indexOf('id="tab-tour-operator"', s);
  return s >= 0 && e > s ? html.slice(s, e) : '';
}

function isLunaBlock(b) {
  return b.color_type === 'payment_pending' && (b.booking_source || '') === 'manual_staff';
}

function isStaffBlock(b) {
  return b.color_type === 'confirmed' && /manual|staff|operator|tour_operator/.test((b.booking_source || '').toLowerCase());
}

(async () => {
  const out = { commit: COMMIT, image: IMAGE, acr_run: 'cb2q', proofs: {}, safety: {} };

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  out.login_ok = login.status === 200 && cookie.length > 0;

  const calMain = await req('GET', `/staff/bed-calendar?client=${CLIENT}&start=2026-07-16&end=2026-09-30`, cookie);
  const blocks = calMain.body?.blocks || [];
  out.proofs.calendar_api = { status: calMain.status, block_count: blocks.length };

  const calSepOct = await req('GET', `/staff/bed-calendar?client=${CLIENT}&start=2026-09-01&end=2026-10-31`, cookie);
  out.proofs.sep_oct_api = { status: calSepOct.status, block_count: (calSepOct.body?.blocks || []).length };

  const ui = await req('GET', '/staff/ui', null, cookie);
  const uiRaw = ui.raw || '';
  out.ui_status = ui.status;
  const bcPanel = extractBedCalendarPanel(uiRaw);
  const js = (uiRaw.match(/<script[^>]*>([\s\S]*?)<\/script>/) || [])[1] || '';

  const legendSlice = bcPanel.slice(bcPanel.indexOf('id="bc-legend"'), bcPanel.indexOf('id="bc-legend"') + 800);
  out.proofs.legend = {
    has_staff_manual: />Staff \/ manual</.test(legendSlice),
    has_luna: />Luna</.test(legendSlice),
    no_confirmed: !/>Confirmed</.test(legendSlice),
    no_payment_pending: !/>Payment pending</.test(legendSlice),
    no_operator_block: !/>Operator block</.test(legendSlice),
    no_cancelled: !/>Cancelled</.test(legendSlice),
    no_balance_due: !/>Balance due</.test(legendSlice),
  };

  const chipsStart = bcPanel.indexOf('id="bc-chips"');
  const chipsEnd = chipsStart > 0 ? bcPanel.indexOf('</div>', bcPanel.indexOf('sep-oct', chipsStart)) : -1;
  const chipsSlice = chipsStart > 0 && chipsEnd > chipsStart ? bcPanel.slice(chipsStart, chipsEnd + 6) : '';
  out.proofs.chips = {
    order_ok: /data-chip="week"[\s\S]*?data-chip="30days"[\s\S]*?data-chip="jun-jul"[\s\S]*?data-chip="jul-aug"[\s\S]*?data-chip="aug-sept"[\s\S]*?data-chip="sep-oct"/.test(chipsSlice),
    sep_oct_label: /data-chip="sep-oct"[^>]*>Sep - Oct</.test(chipsSlice),
    sep_oct_range: /key === 'sep-oct'[\s\S]{0,120}bcSetRange\('2026-09-01', '2026-10-31', 'sep-oct'\)/.test(uiRaw),
    default_30days: /bc-chip-active[\s\S]*?data-chip="30days"|data-chip="30days"[\s\S]*?bc-chip-active/.test(chipsSlice),
  };

  out.proofs.badges = {
    balance_due_class: /bc-block-pay-balance/.test(js),
    deposit_paid_class: /bc-block-pay-deposit/.test(js),
    paid_class: /bc-block-pay-paid/.test(js),
    link_sent_class: /bc-block-pay-link/.test(js) && /Link sent/.test(js),
    refund_review: /Refund review/.test(js),
    badge_helper: /function bcCalendarPaymentBadgesHtml/.test(js),
  };

  const staffBlocks = blocks.filter(isStaffBlock);
  const lunaBlocks = blocks.filter(isLunaBlock);
  const paidStaffGreen = blocks.filter((b) => isStaffBlock(b) && b.payment_status === 'paid');
  const badgeBlocks = blocks.filter((b) =>
    b.calendar_payment_primary || b.calendar_show_deposit_paid || b.has_active_payment_link
  );

  out.proofs.source_colors = {
    staff_samples: staffBlocks.slice(0, 4).map((b) => ({
      code: b.booking_code, color_type: b.color_type, booking_source: b.booking_source, payment_status: b.payment_status,
    })),
    luna_samples: lunaBlocks.slice(0, 4).map((b) => ({
      code: b.booking_code, color_type: b.color_type, booking_source: b.booking_source, payment_status: b.payment_status,
    })),
    paid_staff_stays_green: paidStaffGreen.slice(0, 2).map((b) => ({
      code: b.booking_code, color_type: b.color_type, payment_status: b.payment_status,
    })),
    badge_blocks: badgeBlocks.slice(0, 8).map((b) => ({
      code: b.booking_code,
      primary: b.calendar_payment_primary,
      deposit: b.calendar_show_deposit_paid,
      link: b.has_active_payment_link,
      color_type: b.color_type,
    })),
  };

  const opBlock = blocks.find((b) => (b.booking_source || '') === 'operator' || String(b.booking_code || '').startsWith('OP-'));
  if (!opBlock) {
    const calJun = await req('GET', `/staff/bed-calendar?client=${CLIENT}&start=2026-06-04&end=2026-06-20`, cookie);
    const opFromJun = (calJun.body?.blocks || []).find((b) => String(b.booking_code || '').startsWith('OP-'));
    if (opFromJun) out.proofs.source_colors.operator_sample = { code: opFromJun.booking_code, color_type: opFromJun.color_type, booking_source: opFromJun.booking_source };
  } else {
    out.proofs.source_colors.operator_sample = { code: opBlock.booking_code, color_type: opBlock.color_type, booking_source: opBlock.booking_source };
  }

  out.safety = {
    no_stripe_url: !/api\.stripe\.com/.test(js),
    no_whatsapp_url: !/graph\.facebook\.com/.test(js),
    no_n8n_fetch: !(/fetch[\s\S]{0,80}n8n|https?:\/\/[^"'\\s]*n8n/i.test(js)),
    staging_host: true,
    db_read_only: true,
  };

  out.revision = activeRevision();
  out.deploy_ok = out.revision.health === 'Healthy' && out.revision.traffic === 100 && out.revision.image === IMAGE;

  const legendPass = Object.values(out.proofs.legend).every(Boolean);
  const chipsPass = Object.values(out.proofs.chips).every(Boolean);
  const badgesPass = Object.values(out.proofs.badges).every(Boolean);
  const sc = out.proofs.source_colors;
  const sourcePass = out.proofs.calendar_api.status === 200
    && out.proofs.calendar_api.block_count > 0
    && staffBlocks.length > 0 && staffBlocks.every((b) => b.color_type === 'confirmed')
    && lunaBlocks.length > 0 && lunaBlocks.every((b) => b.color_type === 'payment_pending')
    && paidStaffGreen.length > 0
    && badgeBlocks.length > 0
    && (!sc.operator_sample || sc.operator_sample.color_type === 'confirmed');
  const safetyPass = Object.values(out.safety).every(Boolean);

  out.pass = out.deploy_ok && out.login_ok && out.ui_status === 200 && legendPass && chipsPass && badgesPass && sourcePass && safetyPass;
  console.log(JSON.stringify(out, null, 2));
  if (!out.pass) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
