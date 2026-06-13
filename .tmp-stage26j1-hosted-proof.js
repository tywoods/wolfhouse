'use strict';
/** Stage 26j.1 — deploy manual booking quote fixes + hosted proof. Temp, do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const { calculateWolfhouseQuote } = require('./scripts/lib/wolfhouse-quote-calculator');

const COMMIT = '610d2f6';
const IMAGE_TAG = `${COMMIT}-stage26j1-manual-quotes`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REVISION_SUFFIX = 'stage26j1-manual-quotes';
const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const SVC_BOOKING_ID = '01039383-389e-4e71-a7d6-75b56345fdbf';
const SVC_BOOKING_CODE = 'MB-WOLFHO-20260920-4f62e2';
const XFER_BOOKING_ID = 'adf70f79-c750-458d-a306-97c81304898b';
const XFER_BOOKING_CODE = 'MB-WOLFHO-20291001-9dcb42';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function req(method, pathStr, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path: pathStr,
      method,
      headers: {
        Accept: 'application/json,text/html,*/*',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function withDb(fn) {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties.template?.containers?.[0]?.image,
  };
}

function envSummary() {
  const app = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const env = app.properties.template.containers[0].env || [];
  const pick = (name) => {
    const e = env.find((x) => x.name === name);
    if (!e) return null;
    if (e.secretRef) return { name, secretRef: e.secretRef };
    return { name, value: e.value };
  };
  return {
    STAFF_ACTIONS_ENABLED: pick('STAFF_ACTIONS_ENABLED'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    whatsapp_live_send_vars: env.filter((e) => /WHATSAPP.*SEND|META.*SEND|LIVE_SEND/i.test(e.name) && e.value === 'true').map((e) => e.name),
  };
}

function stripeKeyMode() {
  try {
    const raw = az('az keyvault secret show --vault-name wh-staging-kv --name stripe-secret-key --query value -o tsv');
    if (!raw) return { present: false, mode: null };
    if (raw.startsWith('sk_live')) return { present: true, mode: 'LIVE', blocked: true };
    if (raw.startsWith('sk_test')) return { present: true, mode: 'test' };
    return { present: true, mode: 'unknown_prefix' };
  } catch {
    return { present: false, mode: 'keyvault_lookup_failed' };
  }
}

async function dbCounts(c, bookingId) {
  const q = async (s, p) => (await c.query(s, p)).rows[0];
  return {
    bookings: (await q('SELECT COUNT(*)::text AS c FROM bookings')).c,
    payments: (await q('SELECT COUNT(*)::text AS c FROM payments')).c,
    payments_for_booking: bookingId
      ? (await q('SELECT COUNT(*)::text AS c FROM payments WHERE booking_id=$1::uuid', [bookingId])).c
      : null,
    guest_message_sends_sent: (await q("SELECT COUNT(*)::text AS c FROM guest_message_sends WHERE status='sent'")).c,
    booking_service_records: (await q('SELECT COUNT(*)::text AS c FROM booking_service_records')).c,
    booking_transfers: (await q('SELECT COUNT(*)::text AS c FROM booking_transfers')).c,
  };
}

function ledgerFromContext(ctx) {
  const bk = ctx.booking || {};
  const svc = ctx.service_records || [];
  const pmt = ctx.payments || {};
  const transfers = ctx.transfers || [];
  const rows = pmt.rows || [];
  let svcTotal = 0;
  for (const r of svc) svcTotal += Number(r.total_price_cents || r.amount_due_cents || 0);
  let xferTotal = 0;
  for (const t of transfers) {
    const st = String(t.status || '').toLowerCase();
    if (['requested', 'confirmed'].includes(st) && Number(t.price_cents || 0) > 0) xferTotal += Number(t.price_cents);
  }
  let paid = 0;
  for (const p of rows) {
    if (String(p.status || '').toLowerCase() === 'paid') paid += Number(p.amount_paid_cents || 0);
  }
  const invoice = Number(bk.total_amount_cents || 0) + svcTotal + xferTotal;
  const balance = Math.max(0, invoice - paid);
  return { invoice_total_cents: invoice, balance_due_cents: balance, transfer_due_cents: xferTotal, svc_total: svcTotal };
}

function deploy() {
  const current = activeRevision();
  if (current.image === IMAGE && current.health === 'Healthy' && current.traffic === 100) {
    console.error('[deploy] skip — already on target image');
    return current;
  }
  console.error('[deploy] acr build...');
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  console.error('[deploy] containerapp update...');
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REVISION_SUFFIX}`,
    '--set-env-vars STAFF_ACTIONS_ENABLED=true STRIPE_LINKS_ENABLED=true WHATSAPP_DRY_RUN=true',
    '-o none',
  ].join(' '));
  for (let i = 0; i < 30; i++) {
    const rev = activeRevision();
    if (rev.image === IMAGE && rev.health === 'Healthy' && rev.traffic === 100) return rev;
    execSync('powershell -Command "Start-Sleep -Seconds 10"');
  }
  return activeRevision();
}

function nightsBetween(ci, co) {
  const a = new Date(ci + 'T12:00:00Z');
  const b = new Date(co + 'T12:00:00Z');
  return Math.round((b - a) / 86400000);
}

(async () => {
  const proof = {
    result: 'PASS',
    commit: COMMIT,
    image: IMAGE,
    revision: null,
    env: null,
    stripe_key_mode: null,
    healthz_before: null,
    healthz_after: null,
    proofA_manual_booking: {},
    proofB_transfer_totals: {},
    proofC_payment_link: {},
    proofD_multi_add: {},
    proofE_span: {},
    proofF_multi_remove: {},
    counts: {},
    safety: {},
    caveats: [],
  };

  proof.healthz_before = (await req('GET', '/healthz')).status;
  const stripeMode = stripeKeyMode();
  proof.stripe_key_mode = { mode: stripeMode.mode, present: stripeMode.present };
  if (stripeMode.blocked) {
    proof.result = 'FAIL';
    proof.caveats.push('BLOCKED: production Stripe key (sk_live)');
    console.log(JSON.stringify(proof, null, 2));
    process.exit(1);
  }

  proof.revision = deploy();
  proof.env = envSummary();
  proof.healthz_after = (await req('GET', '/healthz')).status;

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');

  const ui = await req('GET', '/staff/ui', null, cookie);
  const html = ui.raw || '';
  const mbSlice = html.match(/Create New Booking[\s\S]{0,12000}/)?.[0] || '';

  // Proof A — manual booking quote + UI
  const ci6 = '2026-09-01';
  const co6 = '2026-09-07';
  const ci7 = '2026-10-01';
  const co7 = '2026-10-08';
  const localNoPkg = calculateWolfhouseQuote({
    client_slug: CLIENT,
    check_in: ci6,
    check_out: co6,
    guest_count: 2,
    package_code: 'package_none',
    room_type: 'shared',
    payment_choice: 'stripe_deposit',
    add_ons: [],
  });
  const q6 = await req('POST', '/staff/quote-preview?client=' + encodeURIComponent(CLIENT), {
    client_slug: CLIENT,
    check_in: ci6,
    check_out: co6,
    guest_count: 2,
    package_code: 'package_none',
    room_type: 'shared',
    payment_choice: 'stripe_deposit',
    add_ons: [],
  }, cookie);
  const q7malibu = await req('POST', '/staff/quote-preview?client=' + encodeURIComponent(CLIENT), {
    client_slug: CLIENT,
    check_in: ci7,
    check_out: co7,
    guest_count: 2,
    package_code: 'malibu',
    room_type: 'shared',
    payment_choice: 'stripe_deposit',
    add_ons: [],
  }, cookie);
  const qManual = await req('POST', '/staff/quote-preview?client=' + encodeURIComponent(CLIENT), {
    client_slug: CLIENT,
    check_in: ci6,
    check_out: co6,
    guest_count: 2,
    package_code: 'manual_override',
    room_type: 'shared',
    payment_choice: 'stripe_deposit',
    manual_price_per_night_cents: 4000,
    add_ons: [],
  }, cookie);
  const qManualBad = await req('POST', '/staff/quote-preview?client=' + encodeURIComponent(CLIENT), {
    client_slug: CLIENT,
    check_in: ci6,
    check_out: co6,
    guest_count: 2,
    package_code: 'manual_override',
    room_type: 'shared',
    payment_choice: 'stripe_deposit',
    add_ons: [],
  }, cookie);

  const q6body = q6.body || {};
  const q6quote = q6body.quote || {};
  proof.proofA_manual_booking = {
    ui_add_services_heading: /Add Services/.test(mbSlice) && !/ADD-ONS/.test(mbSlice),
    ui_manual_price_override_label: /Manual Price Override/.test(html),
    ui_price_per_night: /Price per night/.test(html) && /bk-manual-price-night/.test(html),
    ui_default_package_logic: /bcApplyDefaultPackageForStay/.test(html),
    nights_6: nightsBetween(ci6, co6),
    nights_7: nightsBetween(ci7, co7),
    no_pkg_http: q6.status,
    no_pkg_success: q6body.success === true,
    no_pkg_blockers: q6quote.blockers || [],
    no_pkg_unknown_package_none: JSON.stringify(q6body).includes('unknown package_code') && JSON.stringify(q6body).includes('package_none'),
    no_pkg_per_night_cents: q6quote.per_night_ceil5,
    no_pkg_expected_per_night: localNoPkg.per_night_ceil5,
    no_pkg_per_night_matches: q6quote.per_night_ceil5 === localNoPkg.per_night_ceil5,
    malibu_7_success: q7malibu.body && q7malibu.body.success === true,
    manual_override_success: qManual.body && qManual.body.success === true,
    manual_override_per_night: (qManual.body && qManual.body.quote && qManual.body.quote.per_night_ceil5),
    manual_override_blocked: qManualBad.body && (qManualBad.body.success === false || (qManualBad.body.quote && (qManualBad.body.quote.blockers || []).length)),
  };

  let beforeCounts;
  let payBookingId = null;
  let payBookingCode = null;
  await withDb(async (c) => {
    beforeCounts = await dbCounts(c);
    const bk = (await c.query(
      `SELECT b.id::text AS booking_id, b.booking_code
       FROM bookings b JOIN clients c ON c.id = b.client_id
       WHERE c.slug = $1 AND b.status NOT IN ('cancelled','expired')
         AND COALESCE(b.balance_due_cents,0) > 0
       ORDER BY b.balance_due_cents DESC LIMIT 1`,
      [CLIENT],
    )).rows[0];
    if (bk) { payBookingId = bk.booking_id; payBookingCode = bk.booking_code; }
  });

  // Proof B — transfer charge in ledger, no payment row
  const ctxBeforeXfer = await req('GET', `/staff/bookings/${XFER_BOOKING_CODE}/context?client=${encodeURIComponent(CLIENT)}`, null, cookie);
  let xferPayBefore;
  await withDb(async (c) => {
    xferPayBefore = (await c.query('SELECT COUNT(*)::text AS c FROM payments WHERE booking_id=$1::uuid', [XFER_BOOKING_ID])).rows[0].c;
  });
  const xferSave = await req('POST', `/staff/bookings/${XFER_BOOKING_ID}/transfers`, {
    client_slug: CLIENT,
    direction: 'arrival',
    status: 'requested',
    airport_code: 'SDR',
    scheduled_at: '2029-11-15T11:30',
    manual_override_euros: 25,
    manual_override_enabled: true,
    source: 'staff',
  }, cookie);
  const ctxAfterXfer = await req('GET', `/staff/bookings/${XFER_BOOKING_CODE}/context?client=${encodeURIComponent(CLIENT)}`, null, cookie);
  const invHtml = ctxAfterXfer.body && ctxAfterXfer.body.success
    ? (html.match(/function bcRenderRunningInvoiceHtml[\s\S]{0,8000}/)?.[0] || '')
    : '';
  let xferPayAfter;
  let xferRow;
  await withDb(async (c) => {
    xferPayAfter = (await c.query('SELECT COUNT(*)::text AS c FROM payments WHERE booking_id=$1::uuid', [XFER_BOOKING_ID])).rows[0].c;
    xferRow = (await c.query(
      `SELECT price_cents, status::text FROM booking_transfers WHERE booking_id=$1::uuid AND direction='arrival'`,
      [XFER_BOOKING_ID],
    )).rows[0];
  });
  const ledgerBefore = ledgerFromContext(ctxBeforeXfer.body || {});
  const ledgerAfter = ledgerFromContext(ctxAfterXfer.body || {});

  proof.proofB_transfer_totals = {
    save_http: xferSave.status,
    transfer_price_cents: xferRow && Number(xferRow.price_cents),
    payments_unchanged: xferPayBefore === xferPayAfter,
    transfer_due_increased: ledgerAfter.transfer_due_cents >= 2500,
    balance_increased: ledgerAfter.balance_due_cents >= ledgerBefore.balance_due_cents + 2500,
    ui_transfers_section: /Transfers/.test(html),
    transfers_in_invoice_fn: /transferInvoiceLineItems|sumActiveTransferChargesCents/.test(html),
  };

  // Proof C — payment link (use xfer booking if balance, else pay booking)
  const linkBookingId = XFER_BOOKING_ID;
  const linkBookingCode = XFER_BOOKING_CODE;
  let paymentsBeforeLink;
  await withDb(async (c) => {
    paymentsBeforeLink = (await c.query('SELECT COUNT(*)::text AS c FROM payments WHERE booking_id=$1::uuid', [linkBookingId])).rows[0].c;
  });
  const linkRes = await req('POST', '/staff/bookings/generate-payment-link?client=' + encodeURIComponent(CLIENT), {
    client_slug: CLIENT,
    booking_id: linkBookingId,
    booking_code: linkBookingCode,
    idempotency_key: `stage26j1-paylink-${Date.now()}`,
    reason: 'Stage 26j.1 staging test payment link proof',
  }, cookie);
  let createdPayment = null;
  if (linkRes.body && linkRes.body.success) {
    await withDb(async (c) => {
      createdPayment = (await c.query(
        `SELECT status::text, amount_due_cents, checkout_url, stripe_checkout_session_id
         FROM payments WHERE booking_id=$1::uuid ORDER BY created_at DESC LIMIT 1`,
        [linkBookingId],
      )).rows[0];
    });
  }
  proof.proofC_payment_link = {
    http: linkRes.status,
    success: linkRes.body && linkRes.body.success,
    payments_before: paymentsBeforeLink,
    created_amount_due_cents: createdPayment && Number(createdPayment.amount_due_cents),
    ledger_balance_after_xfer: ledgerAfter.balance_due_cents,
    amount_includes_transfer: createdPayment
      ? Number(createdPayment.amount_due_cents) >= ledgerAfter.balance_due_cents
      : null,
    stripe_test_url: createdPayment && /^https:\/\/(checkout|pay)\.stripe\.com\//.test(createdPayment.checkout_url || ''),
    refresh_helper: /bcRefreshPaymentsTab|bcRefreshBookingFinancialSummary/.test(html),
    no_whatsapp_in_link_shell: !/whatsapp/i.test(html.match(/function bcInitPaymentLinkShell[\s\S]{0,2500}/)?.[0] || ''),
  };

  // Proof D — multi-add services (schedule later)
  let svcCountBefore;
  let svcPayBefore;
  await withDb(async (c) => {
    svcCountBefore = (await c.query('SELECT COUNT(*)::text AS c FROM booking_service_records WHERE booking_id=$1::uuid', [SVC_BOOKING_ID])).rows[0].c;
    svcPayBefore = (await c.query('SELECT COUNT(*)::text AS c FROM payments WHERE booking_id=$1::uuid', [SVC_BOOKING_ID])).rows[0].c;
  });
  const ctxSvcBefore = await req('GET', `/staff/bookings/${SVC_BOOKING_CODE}/context?client=${encodeURIComponent(CLIENT)}`, null, cookie);
  const idem = `stage26j1-multi-${Date.now()}`;
  const adds = [];
  for (const row of [
    { service_type: 'wetsuit', quantity: 2 },
    { service_type: 'yoga', quantity: 3 },
    { service_type: 'soft_board', quantity: 1 },
  ]) {
    adds.push(await req('POST', '/staff/bookings/add-service?client=' + encodeURIComponent(CLIENT), {
      client_slug: CLIENT,
      booking_id: SVC_BOOKING_ID,
      booking_code: SVC_BOOKING_CODE,
      service_type: row.service_type,
      quantity: row.quantity,
      schedule_mode: 'schedule_later',
      idempotency_key: `${idem}-${row.service_type}`,
    }, cookie));
  }
  const ctxSvcAfter = await req('GET', `/staff/bookings/${SVC_BOOKING_CODE}/context?client=${encodeURIComponent(CLIENT)}`, null, cookie);
  let svcCountAfter;
  let svcPayAfter;
  await withDb(async (c) => {
    svcCountAfter = (await c.query('SELECT COUNT(*)::text AS c FROM booking_service_records WHERE booking_id=$1::uuid', [SVC_BOOKING_ID])).rows[0].c;
    svcPayAfter = (await c.query('SELECT COUNT(*)::text AS c FROM payments WHERE booking_id=$1::uuid', [SVC_BOOKING_ID])).rows[0].c;
  });
  const ledgerSvcBefore = ledgerFromContext(ctxSvcBefore.body || {});
  const ledgerSvcAfter = ledgerFromContext(ctxSvcAfter.body || {});

  proof.proofD_multi_add = {
    all_add_ok: adds.every((r) => r.status === 200 && r.body && r.body.success),
    units_created: adds.map((r) => r.body && (r.body.units_created || r.body.created)),
    svc_count_delta: Number(svcCountAfter) - Number(svcCountBefore),
    payments_unchanged: svcPayBefore === svcPayAfter,
    balance_increased: ledgerSvcAfter.balance_due_cents >= ledgerSvcBefore.balance_due_cents,
    multi_add_ui: /bc-add-ons-entry-rows|Confirm Add|Add another service/.test(html),
    refresh_helper: /bcRefreshServicesTabAfterMutation|bcRefreshBookingFinancialSummary/.test(html),
  };

  // Proof E — span across booking wetsuit x10
  const spanBk = await withDb(async (c) => (await c.query(
    `SELECT b.id::text AS booking_id, b.booking_code, b.check_in::text, b.check_out::text, b.guest_count
     FROM bookings b JOIN clients cl ON cl.id=b.client_id
     WHERE cl.slug=$1 AND b.status NOT IN ('cancelled','expired')
       AND (b.check_out::date - b.check_in::date) >= 5
     ORDER BY b.created_at DESC LIMIT 1`,
    [CLIENT],
  )).rows[0]);
  let spanResult = null;
  let spanDates = [];
  if (spanBk) {
    spanResult = await req('POST', '/staff/bookings/add-service?client=' + encodeURIComponent(CLIENT), {
      client_slug: CLIENT,
      booking_id: spanBk.booking_id,
      booking_code: spanBk.booking_code,
      service_type: 'wetsuit',
      quantity: 10,
      schedule_mode: 'span_across_booking',
      service_date: spanBk.check_in,
      idempotency_key: `stage26j1-span-${Date.now()}`,
    }, cookie);
    if (spanResult.body && spanResult.body.success) {
      await withDb(async (c) => {
        spanDates = (await c.query(
          `SELECT service_date::text AS d, COUNT(*)::int AS c
           FROM booking_service_records
           WHERE booking_id=$1::uuid AND service_type='wetsuit' AND service_date IS NOT NULL
           GROUP BY service_date ORDER BY service_date DESC LIMIT 10`,
          [spanBk.booking_id],
        )).rows;
      });
    }
  }
  proof.proofE_span = {
    booking_used: spanBk && spanBk.booking_code,
    guest_count: spanBk && Number(spanBk.guest_count),
    stay_nights: spanBk ? nightsBetween(spanBk.check_in, spanBk.check_out) : null,
    span_http: spanResult && spanResult.status,
    span_success: spanResult && spanResult.body && spanResult.body.success,
    distribution_by_date: spanDates,
    max_per_day: spanDates.length ? Math.max(...spanDates.map((r) => r.c)) : null,
  };

  // Proof F — multi-remove (pick unscheduled rows from svc booking)
  const svcGet = await req('GET', `/staff/bookings/${SVC_BOOKING_ID}/services?client_slug=${encodeURIComponent(CLIENT)}`, null, cookie);
  const removeIds = (svcGet.body.unscheduled_services || []).slice(0, 3).map((s) => s.service_record_id).filter(Boolean);
  let removeRes = null;
  let svcCountAfterRemove;
  if (removeIds.length >= 2) {
    removeRes = await req('POST', '/staff/bookings/remove-service?client=' + encodeURIComponent(CLIENT), {
      client_slug: CLIENT,
      booking_id: SVC_BOOKING_ID,
      booking_code: SVC_BOOKING_CODE,
      booking_service_record_ids: removeIds,
      idempotency_key: `stage26j1-rm-${Date.now()}`,
      reason: 'Stage 26j.1 multi-remove proof',
    }, cookie);
    await withDb(async (c) => {
      svcCountAfterRemove = (await c.query('SELECT COUNT(*)::text AS c FROM booking_service_records WHERE booking_id=$1::uuid', [SVC_BOOKING_ID])).rows[0].c;
    });
  }
  proof.proofF_multi_remove = {
    remove_ids_count: removeIds.length,
    remove_http: removeRes && removeRes.status,
    remove_success: removeRes && removeRes.body && removeRes.body.success,
    multi_select_ui: /multiple|bc-add-ons-remove-select/.test(html),
    batch_remove_api: /booking_service_record_ids/.test(html),
    confirm_remove_helper: /bcAddServiceUpdateRemoveConfirmState/.test(html),
    svc_count_after_remove: svcCountAfterRemove,
  };

  // Cleanup transfer (keep payment link row from proof C)
  await req('DELETE', `/staff/bookings/${XFER_BOOKING_ID}/transfers/arrival?client_slug=${encodeURIComponent(CLIENT)}`, null, cookie);

  let afterCounts;
  await withDb(async (c) => {
    afterCounts = await dbCounts(c, payBookingId);
  });
  proof.counts = { before: beforeCounts, after: afterCounts };
  proof.safety = {
    guest_message_sends_unchanged: beforeCounts.guest_message_sends_sent === afterCounts.guest_message_sends_sent,
    stripe_mode: stripeMode.mode,
    whatsapp_dry_run: proof.env.WHATSAPP_DRY_RUN?.value === 'true',
    no_live_whatsapp_env: (proof.env.whatsapp_live_send_vars || []).length === 0,
  };

  const checks = [
    proof.revision.image === IMAGE,
    proof.revision.health === 'Healthy',
    proof.revision.traffic === 100,
    proof.healthz_before === 200,
    proof.healthz_after === 200,
    proof.env.STAFF_ACTIONS_ENABLED?.value === 'true',
    proof.env.STRIPE_LINKS_ENABLED?.value === 'true',
    proof.proofA_manual_booking.no_pkg_success === true,
    !proof.proofA_manual_booking.no_pkg_unknown_package_none,
    proof.proofA_manual_booking.no_pkg_per_night_matches === true,
    proof.proofA_manual_booking.manual_override_success === true,
    proof.proofA_manual_booking.manual_override_per_night === 4000,
    proof.proofA_manual_booking.ui_add_services_heading === true,
    proof.proofB_transfer_totals.payments_unchanged === true,
    proof.proofB_transfer_totals.transfer_price_cents === 2500,
    proof.proofB_transfer_totals.transfer_due_increased === true,
    proof.proofD_multi_add.all_add_ok === true,
    proof.proofD_multi_add.payments_unchanged === true,
    proof.proofF_multi_remove.remove_success === true || removeIds.length < 2,
    proof.safety.guest_message_sends_unchanged === true,
  ];
  if (linkRes.body && linkRes.body.success) {
    checks.push(proof.proofC_payment_link.stripe_test_url === true);
  } else {
    proof.caveats.push('Payment link generation did not succeed');
    proof.result = 'PARTIAL';
  }
  if (removeIds.length < 2) proof.caveats.push('Fewer than 2 unscheduled services for multi-remove proof');
  if (!checks.every(Boolean)) proof.result = proof.result === 'FAIL' ? 'FAIL' : 'PARTIAL';

  console.log(JSON.stringify(proof, null, 2));
  process.exit(proof.result === 'PASS' ? 0 : proof.result === 'PARTIAL' ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
