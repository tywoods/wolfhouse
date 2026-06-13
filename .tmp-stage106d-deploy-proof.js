'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = 'a5849a6325d061cc7fd49c665c4afb31faab9db6';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:a5849a-stage106d-manual-booking-payments';
const BED = 'DEMO-R2-B2';
const PKG = 'malibu';

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
    if (String(pr.payment_status || pr.status || '').toLowerCase() !== 'paid') return s;
    return s + Number(pr.amount_paid_cents || 0);
  }, 0);
}

function drawerSlice(uiHtml) {
  const i = uiHtml.indexOf('function renderBookingContextDrawer(data){');
  const j = uiHtml.indexOf('\n/* ── Tour Operator forms', i);
  return i >= 0 && j > i ? uiHtml.slice(i, j) : '';
}

async function quote(cookie, ci, co) {
  const q = await req('POST', '/staff/quote-preview', {
    client_slug: CLIENT,
    check_in: ci,
    check_out: co,
    guest_count: 1,
    package_code: PKG,
    room_type: 'shared',
    payment_choice: 'stripe_deposit',
    add_ons: [],
  }, cookie);
  return q.body && q.body.quote;
}

async function createBooking(cookie, opts) {
  const ts = Date.now();
  const payload = {
    client_slug: CLIENT,
    check_in: opts.ci,
    check_out: opts.co,
    selected_bed_codes: [BED],
    guest_count: 1,
    guest_name: opts.guestName,
    phone: '+34600666' + String(ts).slice(-4),
    package_code: PKG,
    room_type: 'shared',
    payment_choice: opts.paymentChoice,
    add_ons: [],
    confirm: true,
    idempotency_key: 'stage106d-' + opts.tag + '-' + ts,
  };
  if (opts.paidAmountType) payload.paid_amount_type = opts.paidAmountType;
  if (opts.paidAmountCents) payload.paid_amount_cents = opts.paidAmountCents;
  const res = await req('POST', '/staff/manual-bookings/create', payload, cookie);
  return { res, payload };
}

async function context(cookie, code) {
  return req('GET', `/staff/bookings/${encodeURIComponent(code)}/context?client=${CLIENT}`, null, cookie);
}

(async () => {
  const out = {
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb2b',
    revision: activeRevision(),
    proofs: {},
    safety: {},
  };

  out.deploy_ok = out.revision.health === 'Healthy'
    && out.revision.traffic === 100
    && out.revision.image === IMAGE;

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  if (login.status !== 200) throw new Error('login failed');
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  const ui = await req('GET', '/staff/ui', null, cookie);
  const uiRaw = ui.raw || '';
  const drawer = drawerSlice(uiRaw);
  const manualForm = uiRaw.slice(uiRaw.indexOf('id="bk-payment-choice"'), uiRaw.indexOf('id="bk-payment-choice"') + 2500);

  out.proofs.ui_payment_choices = {
    stripe_deposit: /value="stripe_deposit">Stripe deposit link/.test(manualForm),
    stripe_full: /value="stripe_full">Stripe full payment link/.test(manualForm),
    paid_cash: /value="paid_cash">Already paid cash/.test(manualForm),
    paid_bank: /value="paid_bank_transfer">Already paid bank transfer/.test(manualForm),
    no_payment: /value="no_payment_yet">No payment yet/.test(manualForm),
    paid_amount_type: /id="bk-paid-amount-type"/.test(manualForm),
  };

  out.proofs.drawer_smoke_ui = {
    field_grid: /ctx-field-kv-grid--3/.test(drawer),
    addons_before_pay: /bcRenderAddServicePanelHtml[\s\S]*bcRenderRunningInvoiceHtml/.test(drawer),
    generate_link: /Generate Payment Link/.test(drawer),
    copy_icon: /btn-bc-copy-link-icon/.test(drawer) && /aria-label="Copy payment link"/.test(drawer),
    payment_history: /Payment history/.test(drawer),
    move_bed: />Move bed</.test(drawer),
    cancel_footer: /bc-cancel-reservation-btn/.test(drawer),
  };

  const dbUrl = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  let caseIdx = 0;
  async function runCase(tag, paymentChoice, extra) {
    const day = 10 + (caseIdx++) * 4;
    const ci = `2028-07-${String(day).padStart(2, '0')}`;
    const co = `2028-07-${String(day + 3).padStart(2, '0')}`;
    const qt = await quote(cookie, ci, co);
    const { res, payload } = await createBooking(cookie, {
      tag,
      ci,
      co,
      paymentChoice,
      guestName: `Stage106d ${tag}`,
      ...extra,
    });
    const body = res.body || {};
    const code = body.booking_code;
    const ctx = code ? await context(cookie, code) : null;
    const payRows = ctx && ctx.body && ctx.body.payments && ctx.body.payments.rows || [];
    const bk = ctx && ctx.body && ctx.body.booking;
    const checkoutRows = payRows.filter((p) => {
      const st = String(p.payment_status || '').toLowerCase();
      return st === 'checkout_created' || st === 'draft';
    });
    const paidRows = payRows.filter((p) => String(p.payment_status || '').toLowerCase() === 'paid');
    const paidLedger = ledgerPaid(payRows);
    const ctxPaid = ctx && ctx.body && ctx.body.payments && ctx.body.payments.amount_paid_cents;

    return {
      tag,
      ci,
      co,
      http: res.status,
      success: body.success,
      payment_choice: body.payment_choice,
      payment_link_url: !!(body.payment_link_url || body.checkout_url),
      url: body.payment_link_url || body.checkout_url || null,
      amount_due_cents: body.amount_due_cents,
      amount_paid_cents: body.amount_paid_cents,
      message: body.message,
      no_whatsapp: body.no_whatsapp,
      no_n8n: body.no_n8n,
      send_mutation: body.send_mutation,
      booking_code: code,
      quote_deposit: qt && qt.deposit_required_cents,
      quote_total: qt && qt.total_cents,
      ctx_ok: ctx && ctx.status === 200,
      payment_rows: payRows.length,
      checkout_rows: checkoutRows.length,
      paid_rows: paidRows.length,
      checkout_url_in_history: checkoutRows.some((p) => !!p.checkout_url),
      paid_ledger: paidLedger,
      ctx_paid_total: ctxPaid,
      booking_amount_paid: bk && bk.amount_paid_cents,
      booking_balance_due: bk && bk.balance_due_cents,
      booking_total: bk && bk.total_amount_cents,
      checkout_amount_due: checkoutRows[0] && checkoutRows[0].amount_due_cents,
      checkout_amount_paid: checkoutRows[0] && checkoutRows[0].amount_paid_cents,
      paid_row_method: paidRows[0] && (paidRows[0].metadata && paidRows[0].metadata.method
        || (typeof paidRows[0].metadata === 'string' ? null : null)),
      payload_paid_type: payload.paid_amount_type,
    };
  }

  // Parse paid row metadata from DB for method
  async function enrichPaidMethod(code, proof) {
    const r = await pg.query(`
      SELECT p.metadata FROM payments p
      JOIN bookings b ON b.id = p.booking_id
      JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND b.booking_code = $2 AND p.status = 'paid'
      ORDER BY p.created_at DESC LIMIT 1
    `, [CLIENT, code]);
    if (r.rows[0]) {
      let md = r.rows[0].metadata;
      if (typeof md === 'string') try { md = JSON.parse(md); } catch (_) { md = {}; }
      proof.paid_metadata = md;
      proof.paid_method = md && md.method;
      proof.paid_source = md && md.source;
    }
    return proof;
  }

  const dep = await runCase('stripe-deposit', 'stripe_deposit', {});
  out.proofs.mb_stripe_deposit = {
    ...dep,
    link_ok: dep.success && dep.payment_link_url,
    deposit_amount_match: dep.checkout_amount_due === dep.quote_deposit,
    not_paid: dep.paid_ledger === 0 && Number(dep.checkout_amount_paid || 0) === 0,
    balance_unpaid: Number(dep.booking_balance_due) > 0,
    ctx_drawer_proxy: dep.ctx_ok,
    ui_copy_in_bundle: out.proofs.drawer_smoke_ui.copy_icon,
  };

  const full = await runCase('stripe-full', 'stripe_full', {});
  out.proofs.mb_stripe_full = {
    ...full,
    link_ok: full.success && full.payment_link_url,
    full_amount_match: full.checkout_amount_due === full.quote_total,
    not_paid: full.paid_ledger === 0,
    history_row: full.checkout_rows >= 1,
    ctx_drawer_proxy: full.ctx_ok,
  };

  const cash = await runCase('cash-deposit', 'paid_cash', { paidAmountType: 'deposit' });
  out.proofs.mb_cash = {
    ...cash,
    paid_row: cash.paid_rows >= 1,
    paid_increased: cash.paid_ledger > 0,
    no_stripe_url: !cash.url,
    balance_reduced: Number(cash.booking_balance_due) < Number(cash.booking_total || 0),
    deposit_paid_match: cash.paid_ledger === cash.quote_deposit,
    ctx_drawer_proxy: cash.ctx_ok,
  };
  await enrichPaidMethod(cash.booking_code, out.proofs.mb_cash);
  out.proofs.mb_cash.paid_method_cash = out.proofs.mb_cash.paid_method === 'cash';

  const bank = await runCase('bank-full', 'paid_bank_transfer', { paidAmountType: 'full' });
  out.proofs.mb_bank = {
    ...bank,
    paid_row: bank.paid_rows >= 1,
    no_stripe_url: !bank.url,
    full_paid: bank.paid_ledger === bank.quote_total,
    ctx_drawer_proxy: bank.ctx_ok,
  };
  await enrichPaidMethod(bank.booking_code, out.proofs.mb_bank);
  out.proofs.mb_bank.method_bank = out.proofs.mb_bank.paid_method === 'bank_transfer'
    && out.proofs.mb_bank.paid_source === 'staff_bank_transfer';

  const none = await runCase('no-payment', 'no_payment_yet', {});
  out.proofs.mb_no_payment = {
    ...none,
    no_link: !none.url,
    no_payment_rows: none.payment_rows === 0,
    balance_due: Number(none.booking_balance_due) > 0,
    ctx_drawer_proxy: none.ctx_ok,
  };

  // Drawer smoke API on disposable (no-payment booking)
  const smokeCode = none.booking_code;
  let smoke = { skipped: !smokeCode };
  if (smokeCode) {
    const wKey = 'stage106d-wetsuit-' + Date.now();
    const add = await req('POST', `/staff/bookings/add-service?client=${CLIENT}`, {
      client_slug: CLIENT,
      booking_code: smokeCode,
      service_type: 'wetsuit',
      quantity: 1,
      service_date: none.ci,
      idempotency_key: wKey,
    }, cookie);
    const ctx0 = await context(cookie, smokeCode);
    const paid0 = ledgerPaid(ctx0.body.payments.rows);

    const linkKey = 'stage106d-genlink-' + Date.now();
    const link = await req('POST', `/staff/bookings/generate-payment-link?client=${CLIENT}`, {
      client_slug: CLIENT,
      booking_code: smokeCode,
      idempotency_key: linkKey,
      reason: 'stage106d drawer smoke',
    }, cookie);
    const ctx1 = await context(cookie, smokeCode);
    const paid1 = ledgerPaid(ctx1.body.payments.rows);
    const checkout1 = (ctx1.body.payments.rows || []).filter((p) =>
      String(p.payment_status).toLowerCase() === 'checkout_created');

    const cashKey = 'stage106d-cash-' + Date.now();
    const cashPay = await req('POST', `/staff/bookings/record-cash-payment?client=${CLIENT}`, {
      client_slug: CLIENT,
      booking_code: smokeCode,
      amount_cents: 300,
      idempotency_key: cashKey,
      note: 'stage106d smoke',
    }, cookie);
    const ctx2 = await context(cookie, smokeCode);
    const paid2 = ledgerPaid(ctx2.body.payments.rows);

    const snap = await pg.query(`
      SELECT bb.id::text AS booking_bed_id, bb.bed_code
      FROM booking_beds bb
      JOIN bookings b ON b.id = bb.booking_id
      JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND b.booking_code = $2
      LIMIT 1
    `, [CLIENT, smokeCode]);
    const bedRow = snap.rows[0];
    let moveOk = false;
    let moveDetail = 'no bed';
    if (bedRow) {
      const mt = await req('POST', '/staff/bookings/move-targets', {
        client_slug: CLIENT,
        booking_code: smokeCode,
        booking_bed_id: bedRow.booking_bed_id,
        check_in: none.ci,
        check_out: none.co,
      }, cookie);
      const targets = ((mt.body && mt.body.targets) || []).filter((t) => t.available && t.bed_code !== bedRow.bed_code);
      if (targets[0]) {
        const mv = await req('POST', '/staff/bookings/move', {
          client_slug: CLIENT,
          booking_code: smokeCode,
          booking_bed_id: bedRow.booking_bed_id,
          target_bed_id: targets[0].bed_id,
          check_in: none.ci,
          check_out: none.co,
          idempotency_key: 'stage106d-move-' + Date.now(),
        }, cookie);
        moveOk = mv.status === 200 && mv.body && mv.body.success;
        moveDetail = mv.body && (mv.body.error || mv.body.message) || mv.status;
      } else moveDetail = 'no target';
    }

    const cancel = await req('POST', `/staff/bookings/cancel?client=${CLIENT}`, {
      client_slug: CLIENT,
      booking_code: smokeCode,
      idempotency_key: 'stage106d-cancel-' + Date.now(),
      reason: 'Stage106d disposable cancel',
    }, cookie);

    if (add.body && add.body.success && ctx0.body.service_records && ctx0.body.service_records.length) {
      const sr = ctx0.body.service_records[ctx0.body.service_records.length - 1];
      const rem = await req('POST', `/staff/bookings/remove-service?client=${CLIENT}`, {
        client_slug: CLIENT,
        booking_code: smokeCode,
        booking_service_record_id: sr.service_record_id || sr.id,
        idempotency_key: 'stage106d-rm-' + Date.now(),
      }, cookie);
      smoke.remove_service = rem.status === 200 && rem.body && rem.body.success;
    }

    smoke = {
      booking_code: smokeCode,
      add_service: add.status === 200 && add.body && add.body.success,
      generate_link: link.status === 200 && link.body && link.body.success && !!(link.body.payment_link_url || link.body.checkout_url),
      link_paid_unchanged: paid1 === paid0,
      checkout_row: checkout1.length > 0,
      record_cash: cashPay.status === 200 && cashPay.body && cashPay.body.success,
      cash_increased_paid: paid2 > paid1,
      move_bed: moveOk,
      move_detail: moveDetail,
      cancel: cancel.status === 200 && cancel.body && cancel.body.success,
      send_mutation_false: link.body && link.body.send_mutation === false,
    };
  }
  out.proofs.drawer_smoke_api = smoke;

  out.safety = {
    no_wa_ui: !/graph\.facebook\.com/.test(uiRaw),
    no_n8n_ui: !/n8n\.cloud.*activate/i.test(uiRaw),
    deposit_no_send: dep.send_mutation === false && dep.no_whatsapp === true && dep.no_n8n === true,
    stripe_checkout_unpaid: Number(dep.checkout_amount_paid || 0) === 0,
    cash_only_increases_paid: cash.paid_ledger > 0 && dep.paid_ledger === 0,
    staging_only: HOST.includes('staging'),
  };

  const checks = {
    deploy: out.deploy_ok,
    ui_choices: Object.values(out.proofs.ui_payment_choices).every(Boolean),
    stripe_deposit: out.proofs.mb_stripe_deposit.link_ok
      && out.proofs.mb_stripe_deposit.deposit_amount_match
      && out.proofs.mb_stripe_deposit.not_paid
      && out.proofs.mb_stripe_deposit.ctx_drawer_proxy,
    stripe_full: out.proofs.mb_stripe_full.link_ok
      && out.proofs.mb_stripe_full.full_amount_match
      && out.proofs.mb_stripe_full.not_paid
      && out.proofs.mb_stripe_full.history_row,
    cash: out.proofs.mb_cash.paid_row && out.proofs.mb_cash.paid_increased && out.proofs.mb_cash.no_stripe_url
      && out.proofs.mb_cash.paid_method_cash,
    bank: out.proofs.mb_bank.paid_row && out.proofs.mb_bank.method_bank && out.proofs.mb_bank.no_stripe_url,
    no_pay: out.proofs.mb_no_payment.no_payment_rows && out.proofs.mb_no_payment.no_link,
    drawer_ui: Object.values(out.proofs.drawer_smoke_ui).every(Boolean),
    drawer_api: smoke.add_service && smoke.generate_link && smoke.record_cash
      && smoke.cash_increased_paid && smoke.cancel,
    safety: Object.values(out.safety).every(Boolean),
  };

  out.checks = checks;
  const fail = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  out.result = fail.length === 0 ? 'PASS' : (fail.length <= 3 ? 'PARTIAL' : 'FAIL');
  out.failures = fail;

  await pg.end();
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
