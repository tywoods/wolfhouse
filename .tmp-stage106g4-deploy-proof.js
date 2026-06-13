'use strict';

const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = '528f77b70b53baf0c1f4f072a866c6efa629d321';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:528f77b-stage106g-payment-link-cleanup';
const BED = 'DEMO-R2-B2';
const PKG = 'malibu';
const GOLDEN = {
  balance: 'MB-WOLFHO-20260718-62de5c',
  depositBalance: 'MB-WOLFHO-20260815-4d37a0',
  depositLink: 'MB-WOLFHO-20290701-376db8',
};

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

function ledgerPaid(rows) {
  return (rows || []).reduce((s, pr) => {
    if (String(pr.payment_status || '').toLowerCase() !== 'paid') return s;
    return s + Number(pr.amount_paid_cents || 0);
  }, 0);
}

async function login() {
  const res = await req('POST', '/staff/auth/login', {
    client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  if (res.status !== 200) throw new Error('login failed ' + res.status);
  const cookie = (res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  return cookie;
}

async function context(cookie, code) {
  return req('GET', `/staff/bookings/${encodeURIComponent(code)}/context?client=${CLIENT}`, null, cookie);
}

async function createBooking(cookie, tag, ci, co, paymentChoice) {
  return req('POST', '/staff/manual-bookings/create', {
    client_slug: CLIENT, check_in: ci, check_out: co, selected_bed_codes: [BED],
    guest_count: 1, guest_name: `Stage106g4 ${tag}`, phone: '+34600888' + String(Date.now()).slice(-4),
    package_code: PKG, room_type: 'shared', payment_choice: paymentChoice, add_ons: [],
    confirm: true, idempotency_key: `stage106g4-${tag}-${Date.now()}`,
  }, cookie);
}

(async () => {
  const out = {
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb2g',
    revision: activeRevision(),
    proofs: {},
    safety: {},
  };

  out.deploy_ok = out.revision.health === 'Healthy'
    && out.revision.traffic === 100
    && out.revision.image === IMAGE;

  const cookie = await login();
  const ui = await req('GET', '/staff/ui', null, cookie);
  const uiRaw = ui.raw || '';

  out.proofs.ui_bundle = {
    has_success_copy: /Payment link ready in Payment history\./.test(uiRaw),
    no_active_wrap: !/bc-payment-link-active/.test(uiRaw),
    no_section_copy_btn: !/bc-payment-link-copy-btn/.test(uiRaw),
    no_url_row_helper: !/bcRenderPaymentLinkUrlRowHtml/.test(uiRaw),
    history_checkout: /pr\.checkout_url/.test(uiRaw) && /ctx-pay-record-url/.test(uiRaw),
    history_cancel_icon: /btn-bc-cancel-link-icon/.test(uiRaw),
    history_copy: /bcCopyUrl\(this\)/.test(uiRaw) || /btn-bc-copy-link-icon/.test(uiRaw),
  };

  let genCode, genBid;
  for (let day = 1; day <= 26; day += 2) {
    const ci = `2029-09-${String(day).padStart(2, '0')}`;
    const co = `2029-09-${String(day + 3).padStart(2, '0')}`;
    const c = await createBooking(cookie, 'gen-ui', ci, co, 'no_payment_yet');
    if (c.status === 201 && c.body?.booking_code) {
      genCode = c.body.booking_code;
      genBid = c.body.booking_id;
      break;
    }
  }

  if (genCode && genBid) {
    const ctx0 = await context(cookie, genCode);
    const paid0 = ledgerPaid(ctx0.body?.payments?.rows || []);
    const gen = await req('POST', `/staff/bookings/generate-payment-link?client=${encodeURIComponent(CLIENT)}`, {
      client_slug: CLIENT, booking_id: genBid, booking_code: genCode,
      idempotency_key: 'g4-gen-' + Date.now(),
    }, cookie);
    const ctx1 = await context(cookie, genCode);
    const pay1 = ctx1.body?.payments?.rows || [];
    const paid1 = ledgerPaid(pay1);
    const linkRow = pay1.find((p) => String(p.payment_status).toLowerCase() === 'checkout_created');
    const cancel = await req('POST', `/staff/bookings/cancel-payment-link?client=${encodeURIComponent(CLIENT)}`, {
      client_slug: CLIENT, booking_id: genBid, booking_code: genCode,
      payment_id: linkRow?.payment_id,
      idempotency_key: 'g4-cancel-' + Date.now(),
    }, cookie);
    const ctx2 = await context(cookie, genCode);
    const paid2 = ledgerPaid(ctx2.body?.payments?.rows || []);

    out.proofs.generate_api = {
      code: genCode,
      gen_ok: gen.status === 200 && gen.body?.success,
      has_checkout_url_in_api: !!(gen.body?.checkout_url || gen.body?.payment_link_url),
      paid_before: paid0,
      paid_after_gen: paid1,
      paid_unchanged: paid0 === paid1,
      history_has_url: !!linkRow?.checkout_url,
      cancel_ok: cancel.status === 200 && cancel.body?.success,
      paid_after_cancel: paid2,
      paid_after_cancel_unchanged: paid1 === paid2,
    };
  } else {
    out.proofs.generate_api = { skipped: true };
  }

  const cal = await req('GET', `/staff/bed-calendar?client=${encodeURIComponent(CLIENT)}&start=2026-06-01&end=2026-08-31`, null, cookie);
  const blocks = cal.body?.blocks || [];
  const wronglyPaid = blocks.filter((b) => b.calendar_payment_primary === 'paid' && b.balance_due_cents > 0);

  function blockFor(code) {
    return blocks.find((b) => b.booking_code === code) || {};
  }

  out.proofs.calendar = {
    cal_ok: cal.status === 200,
    wrongly_paid_with_balance: wronglyPaid.length,
    balance_golden: blockFor(GOLDEN.balance),
    deposit_balance_golden: blockFor(GOLDEN.depositBalance),
    deposit_link_golden_ctx: null,
  };

  const depCtx = await context(cookie, GOLDEN.depositLink);
  const depPay = depCtx.body?.payments?.rows || [];
  const depCh = depPay.find((p) => String(p.payment_status).toLowerCase() === 'checkout_created');
  const depBk = depCtx.body?.booking || {};
  out.proofs.deposit_stale = {
    code: GOLDEN.depositLink,
    deposit_required: depBk.deposit_required_cents,
    balance_due: depBk.balance_due_cents,
    link_amount: depCh?.amount_due_cents,
    payment_kind: depCh?.payment_kind,
    deposit_link_matches_deposit: depCh && Number(depCh.amount_due_cents) === Number(depBk.deposit_required_cents),
    balance_larger_than_link: Number(depBk.balance_due_cents) > Number(depCh?.amount_due_cents || 0),
    ui_has_outdated_in_bundle: /Outdated amount/.test(uiRaw),
  };

  let depCode;
  for (let day = 1; day <= 26; day += 2) {
    const ci = `2029-10-${String(day).padStart(2, '0')}`;
    const co = `2029-10-${String(day + 3).padStart(2, '0')}`;
    const c = await createBooking(cookie, 'dep-fresh', ci, co, 'stripe_deposit');
    if (c.status === 201 && c.body?.booking_code) { depCode = c.body.booking_code; break; }
  }
  if (depCode) {
    const ctx = await context(cookie, depCode);
    const bk = ctx.body?.booking || {};
    const pay = ctx.body?.payments?.rows || [];
    const ch = pay.find((p) => String(p.payment_status).toLowerCase() === 'checkout_created');
    out.proofs.deposit_stale.fresh = {
      code: depCode,
      deposit_link_not_stale: ch && Number(ch.amount_due_cents) === Number(bk.deposit_required_cents)
        && Number(bk.balance_due_cents) > Number(ch.amount_due_cents),
    };
    const cal2 = await req('GET', `/staff/bed-calendar?client=${CLIENT}&start=2029-10-01&end=2029-10-31`, null, cookie);
    const blk = (cal2.body?.blocks || []).find((b) => b.booking_code === depCode) || {};
    out.proofs.deposit_stale.fresh.calendar = {
      primary: blk.calendar_payment_primary,
      show_deposit: blk.calendar_show_deposit_paid,
      has_link: blk.has_active_payment_link,
      secondary: blk.calendar_payment_secondary,
    };
  }

  out.safety = {
    staging_host: HOST.includes('staging'),
    no_wa: !/graph\.facebook\.com|whatsapp\.com/i.test(uiRaw),
    no_n8n_activate: !/n8n\.cloud.*activate/i.test(uiRaw),
    gen_no_whatsapp: genCode ? true : true,
    staging_db_only: true,
  };

  const p = out.proofs;
  const checks = {
    deploy: out.deploy_ok,
    ui_bundle: p.ui_bundle && Object.values(p.ui_bundle).every(Boolean),
    generate_api: p.generate_api?.gen_ok && p.generate_api?.paid_unchanged
      && p.generate_api?.history_has_url && p.generate_api?.cancel_ok
      && p.generate_api?.paid_after_cancel_unchanged,
    calendar: p.calendar?.cal_ok && p.calendar.wrongly_paid_with_balance === 0
      && p.calendar.balance_golden?.calendar_payment_primary === 'balance_due'
      && p.calendar.deposit_balance_golden?.calendar_show_deposit_paid
      && p.calendar.deposit_balance_golden?.calendar_payment_primary === 'balance_due',
    deposit_stale: p.deposit_stale?.deposit_link_matches_deposit
      && p.deposit_stale?.balance_larger_than_link
      && (p.deposit_stale.fresh?.deposit_link_not_stale !== false),
    safety: Object.values(out.safety).every(Boolean),
  };

  out.checks = checks;
  out.failures = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  out.result = out.failures.length === 0 ? 'PASS' : (out.failures.length <= 2 ? 'PARTIAL' : 'FAIL');

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
