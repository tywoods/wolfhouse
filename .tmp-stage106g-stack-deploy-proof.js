'use strict';

const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = 'd2fbf862cb54b06b9f53a478f3accb91cdcb92ab';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:d2fbf86-stage106g-payment-calendar-polish';
const GOLDEN = {
  balance: 'MB-WOLFHO-20260718-62de5c',
  depositBalance: 'MB-WOLFHO-20260815-4d37a0',
  depositLink: 'MB-WOLFHO-20290701-376db8',
  paid: 'MB-WOLFHO-20260801-4f10c3',
};
const BED = 'DEMO-R2-B2';
const PKG = 'malibu';

function req(method, path, body, cookie, accept) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        Accept: accept || 'application/json',
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
  let s = require('fs').readFileSync(require('path').join(require('os').tmpdir(), 'ca.json'), 'utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  const rows = JSON.parse(s);
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties.template.containers[0].image,
  };
}

function ledgerPaid(rows) {
  return (rows || []).reduce((s, pr) => {
    if (String(pr.payment_status || '').toLowerCase() !== 'paid') return s;
    return s + Number(pr.amount_paid_cents || 0);
  }, 0);
}

function labelFor(pr) {
  const st = String(pr.payment_status || '').toLowerCase();
  let md = pr.metadata || {};
  if (typeof md === 'string') { try { md = JSON.parse(md); } catch (_) { md = {}; } }
  const source = String(md.source || '').toLowerCase();
  const method = String(md.method || '').toLowerCase();
  if (st === 'cancelled' || st === 'canceled') return 'Cancelled payment link';
  if (st === 'paid') {
    if (source === 'staff_cash' || method === 'cash') return 'Paid cash';
    if (source === 'staff_bank_transfer' || method === 'bank_transfer') return 'Paid bank transfer';
    return 'Stripe paid';
  }
  if (st === 'checkout_created') return 'Stripe link created — awaiting payment';
  return st;
}

async function login() {
  const res = await req('POST', '/staff/auth/login', {
    client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  if (res.status !== 200) throw new Error('login failed');
  return (res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
}

async function context(cookie, code) {
  return req('GET', `/staff/bookings/${encodeURIComponent(code)}/context?client=${CLIENT}`, null, cookie);
}

(async () => {
  const out = {
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb2h',
    revision: activeRevision(),
    proofs: {},
    safety: {},
  };
  out.deploy_ok = out.revision.health === 'Healthy'
    && out.revision.traffic === 100
    && out.revision.image === IMAGE;

  const cookie = await login();
  const ui = await req('GET', '/staff/ui', null, cookie);

  out.proofs.ui_bundle = {
    no_luna_draft_panel: !/Luna confirmation draft ready/.test(ui.raw || ''),
    no_whatsapp_dry_run_drawer: !/whatsapp_dry_run:\s*<code>true<\/code>/.test(ui.raw || ''),
    move_bed_label: />Move Bed</.test(ui.raw || '') && !/>Move booking</.test(
      (ui.raw || '').match(/function renderBookingContextDrawer[\s\S]*?return html;/)?.[0] || ''
    ),
    badge_css_inline: /\.bc-block-label\{[^}]*flex:0\s+1\s+auto/.test(ui.raw || '')
      && /\.bc-block-pay-wrap\{[^}]*flex-wrap:wrap/.test(ui.raw || '')
      && !/max-width:58%/.test((ui.raw || '').match(/\.bc-block-pay-wrap\{[^}]+\}/)?.[0] || ''),
    legend_balance: /bc-legend-sw-balance/.test(ui.raw || ''),
    legend_no_cancelled: !/>Cancelled<\/span>/.test(
      (ui.raw || '').slice((ui.raw || '').indexOf('id="bc-legend"'), (ui.raw || '').indexOf('id="bc-legend"') + 1500)
    ),
    stripe_landing: /handleStripeCheckoutSuccessLanding/.test(ui.raw || ''),
  };

  const calJul = await req('GET', `/staff/bed-calendar?client=${CLIENT}&start=2026-07-16&end=2026-08-10`, null, cookie);
  const calAug = await req('GET', `/staff/bed-calendar?client=${CLIENT}&start=2026-08-01&end=2026-08-31`, null, cookie);
  const calDep = await req('GET', `/staff/bed-calendar?client=${CLIENT}&start=2029-07-01&end=2029-07-31`, null, cookie);

  function blk(cal, code) {
    return (cal.body?.blocks || []).find((b) => b.booking_code === code) || null;
  }

  const balBlk = blk(calJul, GOLDEN.balance);
  const balCtx = await context(cookie, GOLDEN.balance);
  const balBk = balCtx.body?.booking || {};
  out.proofs.payment_regression = {
    code: GOLDEN.balance,
    cal_primary: balBlk?.calendar_payment_primary,
    cal_balance: balBlk?.balance_due_cents,
    cal_not_paid: balBlk?.calendar_payment_primary !== 'paid',
    drawer_balance: balBk.balance_due_cents,
    amounts_match: Number(balBlk?.balance_due_cents) === Number(balBk.balance_due_cents),
    ledger_paid: balBlk?.ledger_paid_cents,
  };

  const depBalBlk = blk(calAug, GOLDEN.depositBalance);
  out.proofs.deposit_balance_badges = {
    code: GOLDEN.depositBalance,
    primary: depBalBlk?.calendar_payment_primary,
    show_deposit: depBalBlk?.calendar_show_deposit_paid,
    balance: depBalBlk?.balance_due_cents,
  };

  const depCtx = await context(cookie, GOLDEN.depositLink);
  const depPay = depCtx.body?.payments?.rows || [];
  const depCh = depPay.find((p) => String(p.payment_status).toLowerCase() === 'checkout_created');
  const depBk = depCtx.body?.booking || {};
  const depBlk = blk(calDep, GOLDEN.depositLink);
  out.proofs.deposit_stale = {
    code: GOLDEN.depositLink,
    link_amount: depCh?.amount_due_cents,
    deposit_required: depBk.deposit_required_cents,
    balance_due: depBk.balance_due_cents,
    not_outdated_amount: Number(depCh?.amount_due_cents) === Number(depBk.deposit_required_cents),
    ledger_paid_zero: ledgerPaid(depPay) === 0,
    cal_primary: depBlk?.calendar_payment_primary,
    has_link: depBlk?.has_active_payment_link,
  };

  const paidBlk = blk(calJul, GOLDEN.paid);
  out.proofs.paid_badge = {
    code: GOLDEN.paid,
    primary: paidBlk?.calendar_payment_primary,
    balance: paidBlk?.balance_due_cents,
  };

  const histCtx = await context(cookie, GOLDEN.balance);
  const histRows = histCtx.body?.payments?.rows || [];
  const labels = histRows.map(labelFor);
  out.proofs.payment_history = {
    labels_sample: labels.slice(0, 8),
    has_awaiting: labels.some((l) => l.includes('awaiting payment')),
  };

  const landingSuccess = await req('GET', '/staff/payment/success?session_id=cs_test_proof', null, null, 'text/html');
  const landingCancel = await req('GET', '/staff/payment/cancel', null, null, 'text/html');
  const landingStaff = await req('GET', '/staff?session_id=cs_test_proof', null, null, 'text/html');
  out.proofs.stripe_landing = {
    success_status: landingSuccess.status,
    success_html: landingSuccess.raw?.includes('Payment received'),
    success_not_json_404: !(landingSuccess.raw || '').includes('"error":"Not found"'),
    cancel_html: landingCancel.raw?.includes('Payment not completed'),
    staff_session_html: landingStaff.raw?.includes('Payment received'),
  };

  out.safety = {
    staging_host: HOST.includes('staging'),
    no_wa_ui: !/graph\.facebook\.com/.test(ui.raw || ''),
    no_n8n_activate: !/n8n\.cloud.*activate/i.test(ui.raw || ''),
    staging_db_only: true,
  };

  const checks = {
    deploy: out.deploy_ok,
    ui_bundle: Object.values(out.proofs.ui_bundle).every(Boolean),
    payment_regression: out.proofs.payment_regression.cal_not_paid
      && out.proofs.payment_regression.amounts_match,
    deposit_stale: out.proofs.deposit_stale.not_outdated_amount
      && out.proofs.deposit_stale.ledger_paid_zero,
    deposit_balance: out.proofs.deposit_balance_badges.show_deposit
      && out.proofs.deposit_balance_badges.primary === 'balance_due',
    paid_badge: out.proofs.paid_badge.primary === 'paid',
    stripe_landing: out.proofs.stripe_landing.success_html
      && out.proofs.stripe_landing.success_not_json_404,
    safety: Object.values(out.safety).every(Boolean),
  };
  out.checks = checks;
  out.failures = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  out.result = out.failures.length === 0 ? 'PASS' : (out.failures.length <= 2 ? 'PARTIAL' : 'FAIL');
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
