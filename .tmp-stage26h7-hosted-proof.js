'use strict';
/** Stage 26h.7 — deploy + hosted proof. Temp, do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const COMMIT = '0e6e16e';
const IMAGE_TAG = `${COMMIT}-stage26h7-svc-pebbles-payment-links`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REVISION_SUFFIX = 'stage26h7-svc-pebbles';
const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';

// Disposable / test bookings
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
    STRIPE_SECRET_KEY: pick('STRIPE_SECRET_KEY'),
    STRIPE_CHECKOUT_SUCCESS_URL: pick('STRIPE_CHECKOUT_SUCCESS_URL'),
    STRIPE_CHECKOUT_CANCEL_URL: pick('STRIPE_CHECKOUT_CANCEL_URL'),
    AVIATIONSTACK_API_KEY: pick('AVIATIONSTACK_API_KEY'),
    OPENAI_API_KEY: pick('OPENAI_API_KEY'),
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

function hasStatusNoise(text) {
  return /not requested\/requested|not requested|not_requested\/requested|\(not requested|\(requested\)/i.test(text || '');
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
  for (let i = 0; i < 24; i++) {
    const rev = activeRevision();
    if (rev.image === IMAGE && rev.health === 'Healthy' && rev.traffic === 100) return rev;
    execSync('powershell -Command "Start-Sleep -Seconds 10"');
  }
  return activeRevision();
}

(async () => {
  const proof = {
    result: 'PASS',
    commit: COMMIT,
    image: IMAGE,
    revision: null,
    env: null,
    stripe_key_mode: null,
    healthz: null,
    proofA_payment_link: {},
    proofB_labels: {},
    proofC_colors: {},
    proofD_qty_scheduling: {},
    proofE_existing_qty: {},
    proofF_transfer_layout: {},
    proofG_transfer_override: {},
    counts: {},
    caveats: [],
  };

  const stripeMode = stripeKeyMode();
  proof.stripe_key_mode = { mode: stripeMode.mode, present: stripeMode.present };
  if (stripeMode.blocked) {
    proof.result = 'FAIL';
    proof.caveats.push('BLOCKED: production Stripe key detected (sk_live)');
    console.log(JSON.stringify(proof, null, 2));
    process.exit(1);
  }

  proof.revision = deploy();
  proof.env = envSummary();
  proof.healthz = (await req('GET', '/healthz')).status;

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const ui = await req('GET', '/staff/ui', null, cookie);
  const html = ui.raw || '';

  let payBookingId = null;
  let payBookingCode = null;
  let beforeCounts;
  let svcCountBeforeBooking;
  await withDb(async (c) => {
    beforeCounts = await dbCounts(c);
    const bk = (await c.query(
      `SELECT b.id::text AS booking_id, b.booking_code, b.status,
              b.balance_due_cents, b.amount_paid_cents, b.total_amount_cents
       FROM bookings b
       JOIN clients c ON c.id = b.client_id
       WHERE c.slug = $1 AND b.status NOT IN ('cancelled', 'expired')
         AND b.booking_code LIKE 'MB-WOLFHO-%'
         AND COALESCE(b.balance_due_cents, 0) > 0
       ORDER BY b.balance_due_cents DESC
       LIMIT 10`,
      [CLIENT],
    )).rows;
    if (bk[0]) {
      payBookingId = bk[0].booking_id;
      payBookingCode = bk[0].booking_code;
    }
    svcCountBeforeBooking = (await c.query(
      'SELECT COUNT(*)::text AS c FROM booking_service_records WHERE booking_id=$1::uuid',
      [SVC_BOOKING_ID],
    )).rows[0].c;
  });

  // Proof A — payment link UI + generate once
  const invSlice = html.match(/function bcRenderRunningInvoiceHtml[\s\S]{0,14000}/)?.[0] || '';
  const payLinkInit = html.match(/function bcInitPaymentLinkShell[\s\S]{0,1400}/)?.[0] || '';
  proof.proofA_payment_link.ui = {
    generate_button: html.includes('bc-generate-payment-link-btn'),
    disabled_copy_in_html: /Stripe link creation is disabled/.test(html),
    pay_link_init_clears_when_enabled: /genBtn\.disabled\s*=\s*false/.test(payLinkInit),
    cash_before_link: invSlice.indexOf('bcRenderCashPaymentFormHtml') < invSlice.indexOf('bcRenderPaymentLinkSectionHtml'),
    booking_for_link: payBookingCode,
  };

  let paymentsBeforeLink = null;
  let linkResult = null;
  let createdPayment = null;
  if (payBookingId) {
    await withDb(async (c) => {
      paymentsBeforeLink = (await c.query(
        'SELECT COUNT(*)::text AS c FROM payments WHERE booking_id=$1::uuid',
        [payBookingId],
      )).rows[0].c;
    });
    linkResult = await req('POST', '/staff/bookings/generate-payment-link?client=' + encodeURIComponent(CLIENT), {
      client_slug: CLIENT,
      booking_id: payBookingId,
      booking_code: payBookingCode,
      idempotency_key: `stage26h7-paylink-${Date.now()}`,
      reason: 'Stage 26h.7 staging test payment link proof',
    }, cookie);
    if (linkResult.body && linkResult.body.success) {
      await withDb(async (c) => {
        const rows = (await c.query(
          `SELECT id::text, status::text, payment_kind::text, checkout_url, amount_due_cents,
                  stripe_checkout_session_id, metadata
           FROM payments WHERE booking_id=$1::uuid ORDER BY created_at DESC LIMIT 3`,
          [payBookingId],
        )).rows;
        createdPayment = rows[0] || null;
      });
    }
  } else {
    proof.caveats.push('No booking with balance due found for payment link proof');
  }

  proof.proofA_payment_link.generate = {
    http: linkResult && linkResult.status,
    success: linkResult && linkResult.body && linkResult.body.success,
    error: linkResult && linkResult.body && (linkResult.body.error || linkResult.body.message),
    payments_before: paymentsBeforeLink,
    created_payment: createdPayment
      ? {
          status: createdPayment.status,
          payment_kind: createdPayment.payment_kind,
          amount_due_cents: createdPayment.amount_due_cents,
          url_is_stripe_test: /^https:\/\/checkout\.stripe\.com\//.test(createdPayment.checkout_url || '')
            || /^https:\/\/pay\.stripe\.com\//.test(createdPayment.checkout_url || ''),
          url_host: createdPayment.checkout_url
            ? String(createdPayment.checkout_url).replace(/https:\/\/([^/]+).*/, '$1')
            : null,
          has_session_id: !!createdPayment.stripe_checkout_session_id,
        }
      : null,
    response_checkout_url: linkResult && linkResult.body && linkResult.body.checkout_url
      ? String(linkResult.body.checkout_url).replace(/https:\/\/([^/]+).*/, '$1')
      : null,
  };

  // Proof B/C — services tab
  const svcGet = await req('GET', `/staff/bookings/${SVC_BOOKING_ID}/services?client_slug=${encodeURIComponent(CLIENT)}`, null, cookie);
  const svcHtmlSlice = html.match(/function bcRenderServiceChipHtml[\s\S]{0,500}/)?.[0] || '';
  const paidLines = (svcGet.body.paid_requested_services || []).map((s) => s.summary_line).join('|');
  const unschedLines = (svcGet.body.unscheduled_services || []).map((s) => `${s.service_name}|${s.color_class}`).join(';');
  const scheduled = (svcGet.body.services_by_date || []).flatMap((g) => g.services || []);
  const schedText = scheduled.map((s) => s.summary_line || s.service_name).join('|');

  proof.proofB_labels = {
    no_noise_paid_summary: !hasStatusNoise(paidLines),
    no_noise_unscheduled: !hasStatusNoise(unschedLines),
    no_noise_scheduled: !hasStatusNoise(schedText),
    chip_omits_status: !/payment_status|not requested/.test(svcHtmlSlice),
    sample_paid_lines: (svcGet.body.paid_requested_services || []).slice(0, 4).map((s) => s.summary_line),
  };

  const colorSet = new Set([
    ...(svcGet.body.unscheduled_services || []).map((s) => s.color_class),
    ...scheduled.map((s) => s.color_class),
  ]);
  proof.proofC_colors = {
    classes_in_payload: [...colorSet],
    has_board: [...colorSet].some((c) => c === 'bc-svc-color-board'),
    has_wetsuit: [...colorSet].some((c) => c === 'bc-svc-color-wetsuit'),
    has_yoga: [...colorSet].some((c) => c === 'bc-svc-color-yoga'),
    css_in_ui: html.includes('bc-svc-color-yoga') && html.includes('bc-svc-color-board'),
  };

  // Proof D — add Yoga x3, schedule one, unschedule one
  const idemBase = `stage26h7-yoga3-${Date.now()}`;
  const addYoga = await req('POST', '/staff/bookings/add-service?client=' + encodeURIComponent(CLIENT), {
    client_slug: CLIENT,
    booking_id: SVC_BOOKING_ID,
    booking_code: SVC_BOOKING_CODE,
    service_type: 'yoga',
    quantity: 3,
    idempotency_key: idemBase,
  }, cookie);

  const svcAfterAdd = await req('GET', `/staff/bookings/${SVC_BOOKING_ID}/services?client_slug=${encodeURIComponent(CLIENT)}`, null, cookie);
  const yogaUnits = (svcAfterAdd.body.unscheduled_services || []).filter((s) => /yoga/i.test(s.service_name || s.service_type || ''));
  const stayDates = svcAfterAdd.body.stay_dates || [];
  const targetDate = stayDates[1] || stayDates[0];
  let scheduleOne = null;
  let unscheduleOne = null;
  let yogaAfterSchedule = [];
  if (yogaUnits.length >= 1 && targetDate) {
    const unit = yogaUnits[0];
    scheduleOne = await req('PATCH', `/staff/bookings/${SVC_BOOKING_ID}/services/${unit.service_record_id}/date`, {
      client_slug: CLIENT,
      service_date: targetDate,
    }, cookie);
    const svcAfterSched = await req('GET', `/staff/bookings/${SVC_BOOKING_ID}/services?client_slug=${encodeURIComponent(CLIENT)}`, null, cookie);
    const onDate = ((svcAfterSched.body.services_by_date || []).find((g) => g.date === targetDate) || {}).services || [];
    yogaAfterSchedule = onDate.filter((s) => /yoga/i.test(s.service_name || ''));
    unscheduleOne = await req('PATCH', `/staff/bookings/${SVC_BOOKING_ID}/services/${unit.service_record_id}/date`, {
      client_slug: CLIENT,
      service_date: null,
    }, cookie);
  }

  let svcCountAfterAdd;
  let yogaRows;
  await withDb(async (c) => {
    svcCountAfterAdd = (await c.query(
      'SELECT COUNT(*)::text AS c FROM booking_service_records WHERE booking_id=$1::uuid',
      [SVC_BOOKING_ID],
    )).rows[0].c;
    yogaRows = (await c.query(
      `SELECT id::text, quantity, amount_due_cents, service_date::text AS service_date
       FROM booking_service_records
       WHERE booking_id=$1::uuid AND service_type='yoga'
       ORDER BY created_at DESC LIMIT 10`,
      [SVC_BOOKING_ID],
    )).rows;
  });

  proof.proofD_qty_scheduling = {
    add_http: addYoga.status,
    add_created: addYoga.body && addYoga.body.created,
    units_created: addYoga.body && addYoga.body.units_created,
    unscheduled_yoga_count: yogaUnits.length,
    distinct_record_ids: [...new Set(yogaUnits.map((u) => u.service_record_id))].length,
    schedule_http: scheduleOne && scheduleOne.status,
    yoga_on_date_after_schedule: yogaAfterSchedule.length,
    unschedule_http: unscheduleOne && unscheduleOne.status,
    svc_count_delta: Number(svcCountAfterAdd) - Number(svcCountBeforeBooking),
    recent_yoga_rows: yogaRows.slice(0, 5).map((r) => ({
      quantity: r.quantity,
      amount_due_cents: r.amount_due_cents,
      service_date: r.service_date,
    })),
  };

  // Proof E — existing qty>1 auto-split on GET
  let splitProbeId = null;
  let splitBefore = null;
  let splitAfter = null;
  await withDb(async (c) => {
    const row = (await c.query(
      `SELECT id::text, quantity, amount_paid_cents FROM booking_service_records
       WHERE booking_id=$1::uuid AND quantity > 1 AND COALESCE(amount_paid_cents,0)=0
       LIMIT 1`,
      [SVC_BOOKING_ID],
    )).rows[0];
    if (row) {
      splitProbeId = row.id;
      splitBefore = row;
    }
  });
  if (splitProbeId) {
    await req('GET', `/staff/bookings/${SVC_BOOKING_ID}/services?client_slug=${encodeURIComponent(CLIENT)}`, null, cookie);
    await withDb(async (c) => {
      splitAfter = (await c.query(
        'SELECT id::text, quantity FROM booking_service_records WHERE id=$1::uuid',
        [splitProbeId],
      )).rows[0];
    });
  }
  proof.proofE_existing_qty = {
    had_qty_gt1_unpaid: !!splitBefore,
    before: splitBefore,
    after: splitAfter,
    split_applied: splitBefore && splitAfter && Number(splitBefore.quantity) > 1 && Number(splitAfter.quantity) === 1,
  };

  // Proof F — transfer layout in UI
  const xferCard = html.match(/function bcRenderTransferCard[\s\S]{0,4000}/)?.[0] || '';
  proof.proofF_transfer_layout = {
    col_left: /bc-transfer-col-left/.test(xferCard),
    col_right: /bc-transfer-col-right/.test(xferCard),
    override_under_datetime: xferCard.indexOf('Transfer date/time') < xferCard.indexOf('bc-transfer-override-toggle'),
    notes_in_right_col: /bc-transfer-col-right[\s\S]{0,600}Notes/.test(xferCard),
    subtle_override_css: /align-self:flex-start|font-size:10px/.test(html.match(/\.bc-transfer-override-toggle[\s\S]{0,200}/)?.[0] || ''),
    placeholder_25: /placeholder="25"/.test(xferCard),
  };

  // Proof G — transfer override €25
  const xferPayBefore = await withDb(async (c) => (await c.query(
    'SELECT COUNT(*)::text AS c FROM payments WHERE booking_id=$1::uuid',
    [XFER_BOOKING_ID],
  )).rows[0].c);
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
  let xferRow = null;
  await withDb(async (c) => {
    xferRow = (await c.query(
      `SELECT price_cents, included_in_package, pricing_note FROM booking_transfers
       WHERE booking_id=$1::uuid AND direction='arrival'`,
      [XFER_BOOKING_ID],
    )).rows[0];
  });
  const xferPayAfter = await withDb(async (c) => (await c.query(
    'SELECT COUNT(*)::text AS c FROM payments WHERE booking_id=$1::uuid',
    [XFER_BOOKING_ID],
  )).rows[0].c);
  await req('DELETE', `/staff/bookings/${XFER_BOOKING_ID}/transfers/arrival?client_slug=${encodeURIComponent(CLIENT)}`, null, cookie);

  proof.proofG_transfer_override = {
    save_http: xferSave.status,
    price_cents: xferRow && xferRow.price_cents,
    included_in_package: xferRow && xferRow.included_in_package,
    pricing_note: xferRow && xferRow.pricing_note,
    payments_unchanged: xferPayBefore === xferPayAfter,
  };

  let afterCounts;
  await withDb(async (c) => {
    afterCounts = await dbCounts(c, payBookingId);
  });
  proof.counts = { before: beforeCounts, after: afterCounts };
  proof.healthz_after = (await req('GET', '/healthz')).status;

  // Evaluate PASS/PARTIAL/FAIL
  const checks = [];
  checks.push(proof.revision.image === IMAGE);
  checks.push(proof.revision.health === 'Healthy');
  checks.push(proof.revision.traffic === 100);
  checks.push(proof.healthz === 200 && proof.healthz_after === 200);
  checks.push(proof.env.STAFF_ACTIONS_ENABLED?.value === 'true');
  checks.push(proof.env.STRIPE_LINKS_ENABLED?.value === 'true');
  checks.push(proof.env.WHATSAPP_DRY_RUN?.value === 'true');
  checks.push((proof.env.whatsapp_live_send_vars || []).length === 0);
  checks.push(proof.proofB_labels.no_noise_paid_summary);
  checks.push(proof.proofC_colors.css_in_ui);
  checks.push(proof.proofD_qty_scheduling.add_http === 200);
  checks.push(proof.proofD_qty_scheduling.unscheduled_yoga_count >= 3 || proof.proofD_qty_scheduling.units_created === 3);
  checks.push(proof.proofD_qty_scheduling.yoga_on_date_after_schedule === 1);
  checks.push(proof.proofF_transfer_layout.override_under_datetime);
  checks.push(proof.proofG_transfer_override.price_cents === 2500);
  checks.push(beforeCounts.guest_message_sends_sent === afterCounts.guest_message_sends_sent);

  const linkOk = proof.proofA_payment_link.generate.success === true
    && (proof.proofA_payment_link.generate.created_payment?.url_is_stripe_test
      || /^checkout\.stripe\.com$/.test(proof.proofA_payment_link.generate.response_checkout_url || ''));
  if (payBookingId) checks.push(linkOk);
  else proof.result = 'PARTIAL';

  if (!checks.every(Boolean)) proof.result = proof.result === 'FAIL' ? 'FAIL' : 'PARTIAL';
  if (stripeMode.mode !== 'test' && stripeMode.present) {
    proof.caveats.push(`Stripe key mode: ${stripeMode.mode}`);
  }
  if (!linkOk && payBookingId) proof.caveats.push('Payment link did not return Stripe test checkout URL');

  console.log(JSON.stringify(proof, null, 2));
  process.exit(proof.result === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
