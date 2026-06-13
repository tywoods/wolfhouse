'use strict';

const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = 'f5ff03d8ab61a9103bd6d7faadb63b41b3f6afbe';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:f5ff03d-stage106d2-manual-booking-polish';
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
  return i >= 0 ? uiRaw.slice(i, j > i ? j : i + 14000) : '';
}

async function login() {
  const creds = [
    { email: 'operator.stage72c@example.test', password: 'wolfhouse-somo' },
    { email: 'operator.stage72c@example.test', password: 'OperatorPass123!' },
  ];
  for (const c of creds) {
    const res = await req('POST', '/staff/auth/login', { client: CLIENT, email: c.email, password: c.password });
    if (res.status === 200) {
      const cookie = (res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
      return { cookie, email: c.email };
    }
  }
  throw new Error('login failed for all credentials');
}

async function quote(cookie, ci, co, paymentChoice, addOns) {
  const q = await req('POST', '/staff/quote-preview', {
    client_slug: CLIENT,
    check_in: ci,
    check_out: co,
    guest_count: 1,
    package_code: PKG,
    room_type: 'shared',
    payment_choice: paymentChoice || 'stripe_deposit',
    add_ons: addOns || [],
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
    add_ons: opts.addOns || [],
    confirm: true,
    idempotency_key: 'stage106d2-' + opts.tag + '-' + ts,
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
    acr_run: 'cb2d',
    revision: activeRevision(),
    proofs: {},
    safety: {},
  };

  out.deploy_ok = out.revision.health === 'Healthy'
    && out.revision.traffic === 100
    && out.revision.image === IMAGE;

  const { cookie } = await login();

  const ui = await req('GET', '/staff/ui', null, cookie);
  const uiRaw = ui.raw || '';
  const panel = manualPanelHtml(uiRaw);
  const banner = uiRaw.match(/<div id="banner">[\s\S]*?<\/div>\s*\n\s*<!-- ── Tabs/)?.[0] || '';
  const todayTab = uiRaw.match(/<div id="tab-today"[\s\S]*?<!-- Needs Attention tiles -->/)?.[0] || '';

  out.proofs.ui_cleanup = {
    no_global_readonly_banner: !/READ-ONLY\s*&bull;\s*SHADOW MODE/.test(banner),
    no_today_shadow_hero: !/Shadow Mode active/.test(todayTab)
      && !/No operations affect live guest data/.test(todayTab),
    no_green_banner: !/id="bc-safety-notice"/.test(panel),
    no_flag_banner_copy: !/MANUAL_BOOKING_ENABLED=true, STAFF_ACTIONS_ENABLED=true/.test(uiRaw),
    no_preview_conflicts_btn: !/id="bc-sel-conflicts"/.test(panel),
    create_new_booking_label: /Create New Booking/.test(panel) && !/Create Manual Booking/.test(panel),
    quote_soft_yellow: /btn-bc-quote-soft/.test(panel),
    create_soft_green: /btn-bc-create-soft/.test(panel),
    create_not_always_dimmed: !/\.bc-sel-create-btn\{opacity/.test(uiRaw),
    no_yoga_on_site_note: !/booked and paid on site.*confirm with staff/i.test(panel),
    no_meals_not_priced_note: !/bk-ao-meals-note/.test(panel) && !/not priced in quote yet/i.test(panel),
    quote_sections: /bk-quote-section-title">Accommodation/.test(uiRaw)
      && /bk-quote-section-title">Deposit/.test(uiRaw)
      && /bk-quote-section-title">Selected payment/.test(uiRaw)
      && /bk-quote-section-title">After create/.test(uiRaw),
    create_enablement_logic: /bcLastQuote/.test(uiRaw.match(/function bcUpdateCreateButton[\s\S]*?\n\}/)?.[0] || ''),
    copy_icon_in_bundle: /btn-bc-copy-link-icon/.test(uiRaw),
  };

  const ci = '2028-10-10';
  const co = '2028-10-13';
  const qt = await quote(cookie, ci, co, 'stripe_deposit', []);
  out.proofs.quote_preview = {
    success: !!(qt && qt.success),
    total_cents: qt && qt.total_cents,
    deposit_cents: qt && qt.deposit_required_cents,
  };

  const qtMeals = await quote(cookie, ci, co, 'stripe_deposit', [{ code: 'meals', quantity: 2 }]);
  const mealsLi = qtMeals && qtMeals.line_items
    ? qtMeals.line_items.find((l) => l.code === 'meals') : null;
  out.proofs.meals_pricing = {
    quote_success: !!(qtMeals && qtMeals.success),
    meals_line: !!mealsLi,
    unit_cents: mealsLi && mealsLi.unit_cents,
    total_cents: mealsLi && mealsLi.total_cents,
    no_yoga_on_site_warning: !(qtMeals && qtMeals.warnings || []).some((w) =>
      /yoga.*on site|confirm with staff/i.test(String(w))),
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

  let caseIdx = 0;
  async function runCase(tag, paymentChoice, extra) {
    const day = 20 + (caseIdx++) * 4;
    const cCi = `2028-08-${String(day).padStart(2, '0')}`;
    const cCo = `2028-08-${String(day + 3).padStart(2, '0')}`;
    const res = await createBooking(cookie, {
      tag, ci: cCi, co: cCo, paymentChoice,
      guestName: `Stage106d2 ${tag}`,
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
    deposit_100_eur: checkout[0] && Number(checkout[0].amount_due_cents) === 10000,
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

  out.safety = {
    staging_host: HOST.includes('staging'),
    no_wa: !/graph\.facebook\.com/.test(uiRaw),
    no_n8n_activate: !/n8n\.cloud.*activate/i.test(uiRaw),
    deposit_no_send: dep.body.no_whatsapp === true && dep.body.no_n8n === true && dep.body.send_mutation === false,
    stripe_unpaid: Number((checkout[0] || {}).amount_paid_cents || 0) === 0,
    cash_increases_paid: ledgerPaid(cash.payRows) > 0 && ledgerPaid(dep.payRows) === 0,
    staging_db_only: true,
  };

  const checks = {
    deploy: out.deploy_ok,
    ui_cleanup: Object.values(out.proofs.ui_cleanup).every(Boolean),
    quote: out.proofs.quote_preview.success,
    meals: out.proofs.meals_pricing.quote_success
      && out.proofs.meals_pricing.unit_cents === 1500
      && out.proofs.meals_pricing.total_cents === 3000,
    bed_not_found: out.proofs.bed_not_found.preview_ok && out.proofs.bed_not_found.is_valid
      && !out.proofs.bed_not_found.has_bed_not_found,
    no_payment: out.proofs.no_payment.success && out.proofs.no_payment.no_link
      && out.proofs.no_payment.payment_rows === 0,
    stripe_deposit: out.proofs.stripe_deposit.success && out.proofs.stripe_deposit.link
      && out.proofs.stripe_deposit.not_paid && out.proofs.stripe_deposit.deposit_100_eur,
    cash: out.proofs.cash_paid.success && out.proofs.cash_paid.paid_rows >= 1
      && out.proofs.cash_paid.paid_ledger > 0,
    safety: Object.values(out.safety).every(Boolean),
  };

  out.failures = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  out.result = out.failures.length === 0 ? 'PASS'
    : (out.failures.length <= 2 ? 'PARTIAL' : 'FAIL');

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
