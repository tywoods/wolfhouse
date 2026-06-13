'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = 'dbad5c1419837f3beadd66f9c124a4ef7f23077f';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:dbad5c-stage106d1-clean-manual-booking';
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
    if (String(pr.payment_status || '').toLowerCase() !== 'paid') return s;
    return s + Number(pr.amount_paid_cents || 0);
  }, 0);
}

function manualPanelHtml(uiRaw) {
  const i = uiRaw.indexOf('id="bc-sel-panel"');
  const j = uiRaw.indexOf('id="bc-detail"', i);
  return i >= 0 ? uiRaw.slice(i, j > i ? j : i + 12000) : '';
}

async function quote(cookie, ci, co, paymentChoice) {
  const q = await req('POST', '/staff/quote-preview', {
    client_slug: CLIENT,
    check_in: ci,
    check_out: co,
    guest_count: 1,
    package_code: PKG,
    room_type: 'shared',
    payment_choice: paymentChoice || 'stripe_deposit',
    add_ons: [],
    selected_bed_codes: [BED],
  }, cookie);
  return q.body && q.body.quote;
}

async function previewAvail(cookie, ci, co) {
  return req('POST', '/staff/manual-bookings/preview', {
    client_slug: CLIENT,
    check_in: ci,
    check_out: co,
    selected_bed_codes: [BED],
    guest_count: 1,
    package_or_stay_type: PKG,
  }, cookie);
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
    phone: '+34600777' + String(ts).slice(-4),
    package_code: PKG,
    room_type: 'shared',
    payment_choice: opts.paymentChoice,
    add_ons: [],
    confirm: true,
    idempotency_key: 'stage106d1-' + opts.tag + '-' + ts,
  };
  if (opts.paidAmountType) payload.paid_amount_type = opts.paidAmountType;
  return req('POST', '/staff/manual-bookings/create', payload, cookie);
}

async function context(cookie, code) {
  return req('GET', `/staff/bookings/${encodeURIComponent(code)}/context?client=${CLIENT}`, null, cookie);
}

(async () => {
  const out = {
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb2c',
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
  const panel = manualPanelHtml(uiRaw);

  out.proofs.ui_cleanup = {
    no_green_banner: !/id="bc-safety-notice"/.test(panel),
    no_flag_banner_copy: !/MANUAL_BOOKING_ENABLED=true, STAFF_ACTIONS_ENABLED=true/.test(uiRaw),
    no_preview_conflicts_btn: !/id="bc-sel-conflicts"/.test(panel),
    no_run_preview_conflicts: !/function runPreviewConflicts/.test(uiRaw),
    has_create_btn: /id="bc-sel-create"/.test(panel),
    has_quote_btn: /id="bc-sel-quote"/.test(panel),
    internal_avail_fn: /bcFetchManualBookingAvailability/.test(uiRaw),
    bcSelectedBedCodes: /function bcSelectedBedCodes/.test(uiRaw),
    quote_sections: /bk-quote-section-title">Accommodation/.test(uiRaw)
      && /bk-quote-section-title">Deposit/.test(uiRaw)
      && /bk-quote-section-title">Selected payment/.test(uiRaw)
      && /bk-quote-section-title">After create/.test(uiRaw),
    no_formula_in_quote_render: !/function renderQuoteResult[\s\S]*?formula_summary/.test(uiRaw),
    copy_icon_in_bundle: /btn-bc-copy-link-icon/.test(uiRaw),
  };

  const ci = '2028-08-10';
  const co = '2028-08-13';
  const qt = await quote(cookie, ci, co, 'stripe_deposit');
  out.proofs.quote_preview = {
    success: !!(qt && qt.success),
    total_cents: qt && qt.total_cents,
    deposit_cents: qt && qt.deposit_required_cents,
  };

  const prev = await previewAvail(cookie, ci, co);
  const avail = prev.body && prev.body.availability;
  out.proofs.bed_not_found = {
    preview_ok: prev.status === 200 && prev.body && prev.body.success,
    is_valid: avail && avail.is_valid,
    blockers: avail && avail.blockers,
    has_bed_not_found: avail && (avail.blockers || []).some((b) =>
      (b && b.code) === 'bed_not_found' || b === 'bed_not_found'),
    selected_bed: BED,
  };

  out.proofs.create_enablement = {
    bcFetchManualBookingAvailability: /bcFetchManualBookingAvailability/.test(uiRaw),
    bcLastQuote_gate: /bcLastQuote/.test(uiRaw.match(/function bcUpdateCreateButton[\s\S]*?\n\}/)?.[0] || ''),
    no_phone_required: !/phone/.test((uiRaw.match(/function bcUpdateCreateButton[\s\S]*?var ready/)?.[0] || '')),
  };

  let caseIdx = 0;
  async function runCase(tag, paymentChoice, extra) {
    const day = 10 + (caseIdx++) * 4;
    const cCi = `2028-09-${String(day).padStart(2, '0')}`;
    const cCo = `2028-09-${String(day + 3).padStart(2, '0')}`;
    const res = await createBooking(cookie, {
      tag, ci: cCi, co: cCo, paymentChoice,
      guestName: `Stage106d1 ${tag}`,
      ...extra,
    });
    const body = res.body || {};
    const code = body.booking_code;
    const ctx = code ? await context(cookie, code) : null;
    const payRows = ctx && ctx.body && ctx.body.payments && ctx.body.payments.rows || [];
    const bk = ctx && ctx.body && ctx.body.booking;
    return { tag, http: res.status, body, code, ctx, payRows, bk, ci: cCi, co: cCo };
  }

  const none = await runCase('no-payment', 'no_payment_yet', {});
  out.proofs.no_payment = {
    success: none.body.success,
    code: none.code,
    payment_rows: none.payRows.length,
    no_link: !none.body.payment_link_url,
    balance_due: none.bk && Number(none.bk.balance_due_cents) > 0,
    ctx_ok: none.ctx && none.ctx.status === 200,
    send_mutation_false: none.body.send_mutation === false,
  };

  const dep = await runCase('stripe-deposit', 'stripe_deposit', {});
  const checkout = dep.payRows.filter((p) =>
    String(p.payment_status).toLowerCase() === 'checkout_created');
  out.proofs.stripe_deposit = {
    success: dep.body.success,
    code: dep.code,
    link: !!(dep.body.payment_link_url),
    checkout_row: checkout.length > 0,
    checkout_url: checkout[0] && !!checkout[0].checkout_url,
    amount_due: checkout[0] && checkout[0].amount_due_cents,
    amount_paid_zero: checkout[0] && Number(checkout[0].amount_paid_cents || 0) === 0,
    paid_ledger: ledgerPaid(dep.payRows),
    not_paid: ledgerPaid(dep.payRows) === 0,
    ui_copy_icon: out.proofs.ui_cleanup.copy_icon_in_bundle,
    ctx_ok: dep.ctx && dep.ctx.status === 200,
  };

  const cash = await runCase('cash-deposit', 'paid_cash', { paidAmountType: 'deposit' });
  out.proofs.cash_paid = {
    success: cash.body.success,
    code: cash.code,
    paid_rows: cash.payRows.filter((p) => String(p.payment_status).toLowerCase() === 'paid').length,
    paid_ledger: ledgerPaid(cash.payRows),
    balance_reduced: cash.bk && Number(cash.bk.balance_due_cents) < Number(cash.bk.total_amount_cents || 0),
    no_link: !cash.body.payment_link_url,
    ctx_ok: cash.ctx && cash.ctx.status === 200,
  };

  const bank = await runCase('bank-full', 'paid_bank_transfer', { paidAmountType: 'full' });
  out.proofs.bank_optional = {
    success: bank.body.success,
    paid_ledger: ledgerPaid(bank.payRows),
    balance_zero: bank.bk && Number(bank.bk.balance_due_cents) === 0,
  };

  const full = await runCase('stripe-full', 'stripe_full', {});
  out.proofs.stripe_full_optional = {
    success: full.body.success,
    link: !!full.body.payment_link_url,
    checkout_due: full.payRows[0] && full.payRows[0].amount_due_cents,
    total: full.bk && full.bk.total_amount_cents,
    match: full.payRows[0] && full.bk
      && Number(full.payRows[0].amount_due_cents) === Number(full.bk.total_amount_cents),
  };

  out.safety = {
    staging_host: HOST.includes('staging'),
    no_wa: !/graph\.facebook\.com/.test(uiRaw),
    no_n8n_activate: !/n8n\.cloud.*activate/i.test(uiRaw),
    deposit_no_send: dep.body.no_whatsapp === true && dep.body.no_n8n === true && dep.body.send_mutation === false,
    stripe_unpaid: Number((checkout[0] || {}).amount_paid_cents || 0) === 0,
    cash_increases_paid: ledgerPaid(cash.payRows) > 0 && ledgerPaid(dep.payRows) === 0,
  };

  const checks = {
    deploy: out.deploy_ok,
    ui_cleanup: Object.values(out.proofs.ui_cleanup).every(Boolean),
    quote: out.proofs.quote_preview.success,
    bed_not_found: out.proofs.bed_not_found.preview_ok && out.proofs.bed_not_found.is_valid
      && !out.proofs.bed_not_found.has_bed_not_found,
    no_payment: out.proofs.no_payment.success && out.proofs.no_payment.no_link
      && out.proofs.no_payment.payment_rows === 0,
    stripe_deposit: out.proofs.stripe_deposit.success && out.proofs.stripe_deposit.link
      && out.proofs.stripe_deposit.not_paid,
    cash: out.proofs.cash_paid.success && out.proofs.cash_paid.paid_rows >= 1
      && out.proofs.cash_paid.paid_ledger > 0,
    safety: Object.values(out.safety).every(Boolean),
  };

  out.failures = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  out.result = out.failures.length === 0 ? 'PASS'
    : (out.failures.length <= 2 ? 'PARTIAL' : 'FAIL');

  const pg = new Client({
    connectionString: execSync(
      'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
      { encoding: 'utf8' },
    ).trim(),
    ssl: { rejectUnauthorized: false },
  });
  await pg.connect();
  await pg.end();

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
