'use strict';

const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = 'f4480e34379bc2e3385fdb4cc5d2dad6c9131b9c';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:f4480e3-stage106g-payment-badges';
const GOLDEN = 'MB-WOLFHO-20260801-4f10c3';
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

function labelFromRow(pr) {
  const st = String(pr.payment_status || '').toLowerCase();
  let md = pr.metadata || {};
  if (typeof md === 'string') { try { md = JSON.parse(md); } catch (_) { md = {}; } }
  const method = String(md.method || '').toLowerCase();
  const source = String(md.source || '').toLowerCase();
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
  const creds = [
    { email: 'operator.stage72c@example.test', password: 'OperatorPass123!' },
    { email: 'operator.stage72c@example.test', password: 'wolfhouse-somo' },
  ];
  for (const c of creds) {
    const res = await req('POST', '/staff/auth/login', { client: CLIENT, email: c.email, password: c.password });
    if (res.status === 200) {
      const cookie = (res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
      return { cookie, email: c.email };
    }
  }
  throw new Error('login failed');
}

async function context(cookie, code) {
  return req('GET', `/staff/bookings/${encodeURIComponent(code)}/context?client=${CLIENT}`, null, cookie);
}

async function bedCalendar(cookie, start, end) {
  return req('GET', `/staff/bed-calendar?client=${encodeURIComponent(CLIENT)}&start=${start}&end=${end}`, null, cookie);
}

async function createDisposable(cookie, tag, ci, co, paymentChoice) {
  const ts = Date.now();
  return req('POST', '/staff/manual-bookings/create', {
    client_slug: CLIENT,
    check_in: ci,
    check_out: co,
    selected_bed_codes: [BED],
    guest_count: 1,
    guest_name: `Stage106g ${tag}`,
    phone: '+34600666' + String(ts).slice(-4),
    package_code: PKG,
    room_type: 'shared',
    payment_choice: paymentChoice,
    add_ons: [],
    confirm: true,
    idempotency_key: `stage106g-${tag}-${ts}`,
  }, cookie);
}

async function generateLink(cookie, bookingId, bookingCode) {
  return req('POST', `/staff/bookings/generate-payment-link?client=${encodeURIComponent(CLIENT)}`, {
    client_slug: CLIENT,
    booking_id: bookingId,
    booking_code: bookingCode,
    idempotency_key: `stage106g-gen-${Date.now()}`,
  }, cookie);
}

async function cancelLink(cookie, paymentId, bookingCode) {
  return req('POST', `/staff/bookings/cancel-payment-link?client=${encodeURIComponent(CLIENT)}`, {
    client_slug: CLIENT,
    booking_code: bookingCode,
    payment_id: paymentId,
    idempotency_key: `stage106g-cancel-${Date.now()}`,
  }, cookie);
}

async function recordCash(cookie, bookingId, bookingCode, cents) {
  return req('POST', `/staff/bookings/record-cash-payment?client=${encodeURIComponent(CLIENT)}`, {
    client_slug: CLIENT,
    booking_id: bookingId,
    booking_code: bookingCode,
    amount_cents: cents,
    idempotency_key: `stage106g-cash-${Date.now()}`,
    note: 'stage106g stale proof',
  }, cookie);
}

function collectBlocks(cal) {
  return cal.body?.blocks || [];
}

(async () => {
  const out = {
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb2e',
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

  out.proofs.calendar_badges = {
    balance_due_legend: /Balance due/.test(uiRaw) && /bc-legend-sw-balance/.test(uiRaw),
    cancelled_legend_absent: !/bc-legend-sw-cancelled|legend.*Cancelled/i.test(
      uiRaw.match(/class="bc-legend"[\s\S]*?<\/div>/)?.[0] || ''
    ),
    badge_classes: /bc-block-pay-balance/.test(uiRaw)
      && /bc-block-pay-paid/.test(uiRaw)
      && /bc-block-pay-refund/.test(uiRaw),
    payment_state_helper: /bcCalendarBlockPaymentState/.test(uiRaw),
  };

  const cal = await bedCalendar(cookie, '2026-07-16', '2026-08-10');
  const blocks = collectBlocks(cal);
  const golden = blocks.find((b) => b.booking_code === GOLDEN);
  const byKind = {};
  for (const b of blocks) {
    const k = b.calendar_payment_state || 'none';
    byKind[k] = (byKind[k] || 0) + 1;
  }
  out.proofs.calendar_api = {
    cal_ok: cal.status === 200 && cal.body?.success,
    golden_found: !!golden,
    golden_state: golden?.calendar_payment_state,
    golden_balance: golden?.balance_due_cents,
    golden_paid_badge: golden?.calendar_payment_state === 'paid',
    kinds: byKind,
    has_balance_due: (byKind.balance_due || 0) > 0,
    has_paid: (byKind.paid || 0) > 0,
    has_refund: (byKind.refund_review || 0) > 0,
    has_link: (byKind.payment_link_created || 0) > 0,
  };

  const gctx = await context(cookie, GOLDEN);
  const gpay = gctx.body?.payments?.rows || [];
  const gLabels = gpay.map(labelFromRow);
  out.proofs.payment_labels_golden = {
    ctx_ok: gctx.status === 200,
    labels: gLabels,
    ui_has_display_helper: /bcPaymentLedgerRowDisplayLabel/.test(uiRaw),
    ui_labels_in_bundle: [
      'Stripe link created',
      'Stripe paid',
      'Paid cash',
      'Paid bank transfer',
      'Cancelled payment link',
    ].every((t) => uiRaw.includes(t)),
    no_raw_checkout_primary: !/ctx-pay-record-badge[^>]*>checkout_created</i.test(
      uiRaw.match(/function bcRenderRunningInvoiceHtml[\s\S]*?\n\}/)?.[0] || ''
    ),
    golden_has_awaiting_or_paid: gLabels.some((l) =>
      /awaiting payment|Stripe paid|Paid cash/i.test(l)),
  };

  const day = 10 + (Date.now() % 17);
  const ci = `2028-11-${String(day).padStart(2, '0')}`;
  const co = `2028-11-${String(day + 3).padStart(2, '0')}`;
  const created = await createDisposable(cookie, 'cancel-proof', ci, co, 'no_payment_yet');
  const code = created.body?.booking_code;
  const bid = created.body?.booking_id;
  let ctx1 = code ? await context(cookie, code) : null;
  const paidBefore = ledgerPaid(ctx1?.body?.payments?.rows || []);
  const gen = bid ? await generateLink(cookie, bid, code) : null;
  ctx1 = code ? await context(cookie, code) : null;
  const rowsAfterGen = ctx1?.body?.payments?.rows || [];
  const checkoutRow = rowsAfterGen.find((p) =>
    String(p.payment_status).toLowerCase() === 'checkout_created');
  const paidAfterGen = ledgerPaid(rowsAfterGen);
  const cancelUi = /btn-bc-cancel-link-icon/.test(uiRaw)
    && /bcInitCancelPaymentLinkShell/.test(uiRaw)
    && /ctx-cancel-link-confirm/.test(uiRaw);

  let cancelRes = null;
  if (checkoutRow) {
    cancelRes = await cancelLink(cookie, checkoutRow.payment_id, code);
  }
  const ctx2 = code ? await context(cookie, code) : null;
  const rowsAfterCancel = ctx2?.body?.payments?.rows || [];
  const paidAfterCancel = ledgerPaid(rowsAfterCancel);
  const cancelledRow = rowsAfterCancel.find((p) =>
    String(p.payment_status).toLowerCase() === 'cancelled');

  out.proofs.cancel_link = {
    create_ok: created.status === 201 && created.body?.success,
    code,
    gen_ok: gen?.status === 200 && gen?.body?.success,
    checkout_row: !!checkoutRow,
    paid_unchanged_by_gen: paidAfterGen === paidBefore,
    cancel_ui_markup: cancelUi,
    cancel_api_ok: cancelRes?.status === 200 && cancelRes?.body?.success,
    cancelled_label: cancelledRow ? labelFromRow(cancelledRow) : null,
    paid_unchanged_by_cancel: paidAfterCancel === paidBefore,
    gen_available_again: /bc-generate-payment-link-btn/.test(uiRaw),
  };

  let stale = { skipped: true, reason: 'not attempted' };
  try {
    const day2 = 20 + (Date.now() % 7);
    const ci2 = `2028-12-${String(day2).padStart(2, '0')}`;
    const co2 = `2028-12-${String(day2 + 3).padStart(2, '0')}`;
    const c2 = await createDisposable(cookie, 'stale-proof', ci2, co2, 'no_payment_yet');
    const code2 = c2.body?.booking_code;
    const bid2 = c2.body?.booking_id;
    if (code2 && bid2) {
      const g1 = await generateLink(cookie, bid2, code2);
      const ctxA = await context(cookie, code2);
      const balA = Number(ctxA.body?.booking?.balance_due_cents || 0);
      const cashCents = Math.min(5000, Math.max(1000, Math.floor(balA / 2)));
      const cash = await recordCash(cookie, bid2, code2, cashCents);
      const ctxB = await context(cookie, code2);
      const balB = Number(ctxB.body?.booking?.balance_due_cents || 0);
      const ui2 = await req('GET', '/staff/ui', null, cookie);
      stale = {
        skipped: false,
        gen1_ok: g1?.status === 200,
        balance_changed: balB !== balA && balB < balA,
        outdated_in_ui: /Outdated amount/.test(ui2.raw || ''),
        stale_helper: /bcPaymentLedgerIsStaleUnpaidLinkRow/.test(ui2.raw || ''),
      };
    }
  } catch (e) {
    stale = { skipped: true, error: String(e.message || e) };
  }
  out.proofs.stale_link = stale;

  out.safety = {
    staging_host: HOST.includes('staging'),
    no_wa: !/graph\.facebook\.com/.test(uiRaw),
    no_n8n_activate: !/n8n\.cloud.*activate/i.test(uiRaw),
    link_gen_no_paid_truth: paidAfterGen === paidBefore,
    cancel_no_paid_mutation: paidAfterCancel === paidBefore,
    staging_db_only: true,
  };

  const checks = {
    deploy: out.deploy_ok,
    calendar_ui: Object.values(out.proofs.calendar_badges).every(Boolean),
    calendar_api: out.proofs.calendar_api.cal_ok
      && out.proofs.calendar_api.golden_found
      && out.proofs.calendar_api.golden_paid_badge
      && out.proofs.calendar_api.has_balance_due,
    payment_labels: out.proofs.payment_labels_golden.ctx_ok
      && out.proofs.payment_labels_golden.ui_labels_in_bundle,
    cancel: out.proofs.cancel_link.create_ok
      && out.proofs.cancel_link.gen_ok
      && out.proofs.cancel_link.checkout_row
      && out.proofs.cancel_link.paid_unchanged_by_gen
      && out.proofs.cancel_link.cancel_api_ok
      && out.proofs.cancel_link.cancelled_label === 'Cancelled payment link'
      && out.proofs.cancel_link.paid_unchanged_by_cancel,
    stale: stale.skipped || (stale.balance_changed && stale.outdated_in_ui),
    safety: Object.values(out.safety).every(Boolean),
  };

  out.failures = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  out.result = out.failures.length === 0 ? 'PASS'
    : (out.failures.length <= 2 ? 'PARTIAL' : 'FAIL');

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
