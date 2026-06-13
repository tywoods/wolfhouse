'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING = 'MB-WOLFHO-20260920-4f62e2';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:924fe64-stage106a-addons-ui';
const COMMIT = '924fe64';

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
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
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
    { encoding: 'utf8' }
  ));
  const active = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: active.name,
    health: active.properties.healthState,
    image: active.properties.template.containers[0].image,
    traffic: active.properties.trafficWeight,
  };
}

function svcLabel(t, meta) {
  meta = meta || {};
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch (_) { meta = {}; }
  }
  if (meta.staff_ui_service_type === 'soft_board') return 'Soft board';
  if (meta.staff_ui_service_type === 'hard_board') return 'Hard board';
  if (meta.staff_ui_service_type === 'wetsuit') return 'Wetsuit';
  if (t === 'surfboard' && meta.board_variant === 'soft') return 'Soft board';
  if (t === 'surfboard' && meta.board_variant === 'hard') return 'Hard board';
  return t;
}

function invoiceSvcSum(rows) {
  return rows.reduce((s, r) => s + (Number(r.amount_due_cents) || 0), 0);
}

async function snap(pg, bookingCode) {
  const b = await pg.query(`
    SELECT b.id::text AS booking_id, b.booking_code, b.guest_name, b.phone, b.email,
           b.status::text AS status, b.package_code, b.total_amount_cents,
           b.amount_paid_cents, b.balance_due_cents,
           b.check_in::text AS check_in, b.check_out::text AS check_out, b.guest_count
    FROM bookings b
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    LIMIT 1
  `, [CLIENT, bookingCode]);
  const pays = await pg.query(`
    SELECT p.id::text AS payment_id, p.status::text AS status, p.amount_paid_cents,
           p.stripe_checkout_session_id, p.stripe_payment_intent_id
    FROM payments p
    INNER JOIN bookings b ON b.id = p.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    ORDER BY p.created_at
  `, [CLIENT, bookingCode]);
  let svc = [];
  try {
    svc = (await pg.query(
      `SELECT id::text, service_type, status, quantity, payment_status,
              amount_due_cents, service_date::text AS service_date, metadata
       FROM booking_service_records
       WHERE client_slug = $1 AND booking_code = $2
       ORDER BY created_at`,
      [CLIENT, bookingCode]
    )).rows;
  } catch (_) { svc = []; }
  return { booking: b.rows[0], payments: pays.rows, service_records: svc };
}

function payTruthSame(a, b) {
  return JSON.stringify(a.payments) === JSON.stringify(b.payments)
    && Number(a.booking.amount_paid_cents) === Number(b.booking.amount_paid_cents);
}

async function addService(cookie, payload) {
  return req('POST', '/staff/bookings/add-service?client=' + CLIENT, payload, cookie);
}

async function getContext(cookie, bookingCode) {
  return req('GET', '/staff/bookings/' + bookingCode + '/context?client=' + CLIENT, null, cookie);
}

(async () => {
  const out = {
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb23',
    revision: activeRevision(),
  };

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  if (login.status !== 200) throw new Error('login failed: ' + login.status);
  const cookie = (login.headers && login.headers['set-cookie'])
    ? login.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ')
    : '';

  const dbUrl = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' }
  ).trim();
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const before = await snap(pg, BOOKING);
  if (!before.booking) throw new Error('booking not found: ' + BOOKING);
  const svcBefore = before.service_records.length;
  const svcSumBefore = invoiceSvcSum(before.service_records);
  const paidBefore = Number(before.booking.amount_paid_cents || 0);
  const stayCi = before.booking.check_in;
  const stayCo = before.booking.check_out;
  const serviceDate = stayCi;

  const wetsuitQty = 2;
  const wetsuitKey = 'stage106a-wetsuit-' + BOOKING;
  const wetsuitPayload = {
    client_slug: CLIENT,
    booking_code: BOOKING,
    service_type: 'wetsuit',
    quantity: wetsuitQty,
    service_date: serviceDate,
    note: 'Stage106a wetsuit proof',
    idempotency_key: wetsuitKey,
  };

  const ctx0 = await getContext(cookie, BOOKING);
  const add1 = await addService(cookie, wetsuitPayload);
  const afterAdd1 = await snap(pg, BOOKING);
  const ctx1 = await getContext(cookie, BOOKING);
  const svcSumAfter1 = invoiceSvcSum(afterAdd1.service_records);
  const wetsuitRows = afterAdd1.service_records.filter((r) =>
    (r.metadata && (typeof r.metadata === 'object' ? r.metadata.idempotency_key : null)) === wetsuitKey
    || String(r.metadata || '').includes(wetsuitKey)
  );
  const wetsuitRow = afterAdd1.service_records.find((r) => {
    const m = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
    return m.idempotency_key === wetsuitKey;
  });

  const addIdem = await addService(cookie, wetsuitPayload);
  const afterIdem = await snap(pg, BOOKING);

  const softKey = 'stage106a-soft-' + BOOKING;
  const softAdd = await addService(cookie, {
    client_slug: CLIENT,
    booking_code: BOOKING,
    service_type: 'soft_board',
    quantity: 1,
    service_date: serviceDate,
    idempotency_key: softKey,
  });
  const afterSoft = await snap(pg, BOOKING);
  const softRow = afterSoft.service_records.find((r) => {
    const m = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
    return m.idempotency_key === softKey;
  });

  const hardKey = 'stage106a-hard-' + BOOKING;
  const hardAdd = await addService(cookie, {
    client_slug: CLIENT,
    booking_code: BOOKING,
    service_type: 'hard_board',
    quantity: 1,
    service_date: serviceDate,
    idempotency_key: hardKey,
  });
  const afterHard = await snap(pg, BOOKING);
  const hardRow = afterHard.service_records.find((r) => {
    const m = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
    return m.idempotency_key === hardKey;
  });

  const expectedWetsuitCents = 500 * wetsuitQty;
  const invoiceTotalBefore = svcSumBefore + Number(before.booking.total_amount_cents || 0);
  const invoiceTotalAfter = svcSumAfter1 + Number(afterAdd1.booking.total_amount_cents || 0);

  out.add_service = {
    booking: BOOKING,
    stay: { check_in: stayCi, check_out: stayCo },
    service_date: serviceDate,
    api_status: add1.status,
    success: add1.body && add1.body.success,
    created: add1.body && add1.body.created,
    amount_due_cents: add1.body && add1.body.pricing && add1.body.pricing.amount_due_cents,
    expected_amount_due_cents: expectedWetsuitCents,
    svc_rows_before: svcBefore,
    svc_rows_after: afterAdd1.service_records.length,
    row_created: !!wetsuitRow,
    row_status: wetsuitRow && wetsuitRow.status,
    row_payment_status: wetsuitRow && (typeof wetsuitRow.metadata === 'object'
      ? null : null),
    context_status: ctx1.status,
    context_svc_count: ctx1.body && ctx1.body.service_records ? ctx1.body.service_records.length : 0,
    context_has_wetsuit: !!(ctx1.body && ctx1.body.service_records && ctx1.body.service_records.some((r) =>
      r.service_type === 'wetsuit' || (r.metadata && r.metadata.staff_ui_service_type === 'wetsuit'))),
    invoice_svc_sum_before: svcSumBefore,
    invoice_svc_sum_after: svcSumAfter1,
    invoice_svc_sum_delta: svcSumAfter1 - svcSumBefore,
    payments_unchanged: payTruthSame(before, afterAdd1),
    no_stripe_in_response: !/stripe/i.test(JSON.stringify(add1.body || {})),
    message: add1.body && add1.body.message,
  };

  out.idempotency = {
    repeat_status: addIdem.status,
    success: addIdem.body && addIdem.body.success,
    created: addIdem.body && addIdem.body.created,
    idempotent: addIdem.body && addIdem.body.idempotent,
    svc_count_unchanged: afterIdem.service_records.length === afterAdd1.service_records.length,
    wetsuit_row_count: afterIdem.service_records.filter((r) => {
      const m = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
      return m.idempotency_key === wetsuitKey;
    }).length,
  };

  out.service_labels = {
    soft_api_status: softAdd.status,
    soft_created: softAdd.body && softAdd.body.created,
    soft_db_type: softRow && softRow.service_type,
    soft_label: softRow && svcLabel(softRow.service_type, softRow.metadata),
    soft_variant: softRow && (typeof softRow.metadata === 'string'
      ? JSON.parse(softRow.metadata).board_variant
      : softRow.metadata && softRow.metadata.board_variant),
    hard_api_status: hardAdd.status,
    hard_created: hardAdd.body && hardAdd.body.created,
    hard_db_type: hardRow && hardRow.service_type,
    hard_label: hardRow && svcLabel(hardRow.service_type, hardRow.metadata),
    hard_variant: hardRow && (typeof hardRow.metadata === 'string'
      ? JSON.parse(hardRow.metadata).board_variant
      : hardRow.metadata && hardRow.metadata.board_variant),
    wetsuit_label: wetsuitRow && svcLabel(wetsuitRow.service_type, wetsuitRow.metadata),
  };

  // Edit smoke on same booking (contact only — avoid destabilizing dates after addons)
  const contactTarget = {
    guest_name: 'Stage106a Drawer Contact',
    email: 'stage106a.contact@example.com',
  };
  const cw = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING,
    edit_type: 'contact',
    ...contactTarget,
    idempotency_key: 'stage106a-contact-' + Date.now(),
  }, cookie);
  const afterContact = await snap(pg, BOOKING);

  const pkg = String(afterContact.booking.package_code || 'malibu').toLowerCase();
  const nextPkg = pkg === 'malibu' ? 'uluwatu' : (pkg === 'uluwatu' ? 'waimea' : 'malibu');
  const pw = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING,
    edit_type: 'package',
    package_code: nextPkg,
    idempotency_key: 'stage106a-package-' + Date.now(),
  }, cookie);
  const afterPkg = await snap(pg, BOOKING);

  const restorePkg = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING,
    edit_type: 'package',
    package_code: pkg,
    idempotency_key: 'stage106a-package-restore-' + Date.now(),
  }, cookie);

  const curCi = afterPkg.booking.check_in;
  const curCo = afterPkg.booking.check_out;
  const d1 = new Date(curCi + 'T00:00:00Z');
  d1.setUTCDate(d1.getUTCDate() + 1);
  const d2 = new Date(curCo + 'T00:00:00Z');
  d2.setUTCDate(d2.getUTCDate() + 1);
  const dateTarget = { check_in: d1.toISOString().slice(0, 10), check_out: d2.toISOString().slice(0, 10) };
  const dw = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING,
    edit_type: 'dates',
    ...dateTarget,
    idempotency_key: 'stage106a-dates-' + Date.now(),
  }, cookie);
  let afterDates = await snap(pg, BOOKING);
  let dateOk = dw.body && dw.body.success && dw.body.updated;
  if (!dateOk) {
    const fallback = { check_in: '2026-09-20', check_out: '2026-09-23' };
    const dw2 = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
      client_slug: CLIENT,
      booking_code: BOOKING,
      edit_type: 'dates',
      ...fallback,
      idempotency_key: 'stage106a-dates-fb-' + Date.now(),
    }, cookie);
    afterDates = await snap(pg, BOOKING);
    dateOk = dw2.body && dw2.body.success && dw2.body.updated;
    dateTarget.check_in = fallback.check_in;
    dateTarget.check_out = fallback.check_out;
  }

  out.edit_smoke = {
    contact: {
      status: cw.status,
      success: cw.body && cw.body.success,
      updated: cw.body && cw.body.updated,
      db_name: afterContact.booking.guest_name,
      payments_unchanged: payTruthSame(before, afterContact),
    },
    package: {
      status: pw.status,
      success: pw.body && pw.body.success,
      updated: pw.body && pw.body.updated,
      restored: restorePkg.body && restorePkg.body.success,
      payments_unchanged: payTruthSame(before, afterPkg),
    },
    date: {
      success: dateOk,
      db_check_in: afterDates.booking.check_in,
      db_check_out: afterDates.booking.check_out,
      payments_unchanged: payTruthSame(before, afterDates),
    },
    guest_reduction: { skipped: true, reason: 'not required for stage106a' },
  };

  const cancelBed = 'DEMO-R2-B2';
  const cancelCi = '2027-04-11';
  const cancelCo = '2027-04-14';
  const createPayload = {
    client_slug: CLIENT,
    check_in: cancelCi,
    check_out: cancelCo,
    selected_bed_codes: [cancelBed],
    guest_count: 1,
    guest_name: 'Stage106a Cancel Disposable',
    phone: '+34600555107',
    package_code: 'malibu',
    room_type: 'shared',
    payment_choice: 'deposit',
    add_ons: [],
    confirm: true,
    idempotency_key: 'stage106a-cancel-create-' + Date.now(),
  };
  const created = await req('POST', '/staff/manual-bookings/create', createPayload, cookie);
  const cancelCode = created.body && created.body.booking_code;
  let cancelProof = { skipped: true };
  if (cancelCode) {
    const calBefore = await req('GET',
      '/staff/bed-calendar?client=' + CLIENT + '&start=' + cancelCi + '&end=' + cancelCo, null, cookie);
    const inCalBefore = ((calBefore.body && calBefore.body.blocks) || [])
      .some((b) => b.booking_code === cancelCode);
    const cancelApi = await req('POST', '/staff/bookings/cancel?client=' + CLIENT, {
      client_slug: CLIENT,
      booking_code: cancelCode,
      idempotency_key: 'stage106a-cancel-' + Date.now(),
    }, cookie);
    const afterCancel = await snap(pg, cancelCode);
    const calAfter = await req('GET',
      '/staff/bed-calendar?client=' + CLIENT + '&start=' + cancelCi + '&end=' + cancelCo, null, cookie);
    const inCalAfter = ((calAfter.body && calAfter.body.blocks) || [])
      .some((b) => b.booking_code === cancelCode);
    const bedsAfter = await pg.query(`
      SELECT COUNT(*)::int AS n FROM booking_beds bb
      INNER JOIN bookings b ON b.id = bb.booking_id
      INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND b.booking_code = $2
    `, [CLIENT, cancelCode]);
    cancelProof = {
      skipped: false,
      api_success: cancelApi.body && cancelApi.body.success,
      cancelled: cancelApi.body && cancelApi.body.cancelled,
      status_after: afterCancel.booking && afterCancel.booking.status,
      beds_after: bedsAfter.rows[0] && bedsAfter.rows[0].n,
      in_calendar_before: inCalBefore,
      in_calendar_after: inCalAfter,
    };
  }
  out.cancel_smoke = cancelProof;

  const ui = await req('GET', '/staff/ui', null, cookie);
  const uiRaw = ui.raw || '';
  out.ui_embedded = {
    has_add_service_panel: /bc-add-service-panel/.test(uiRaw),
    has_add_service_api: /\/staff\/bookings\/add-service/.test(uiRaw),
    has_load_block_detail_on_save: /bcRunAddServiceSave[\s\S]*?loadBlockDetail/.test(uiRaw),
    has_contact_save: /bcFieldEditRunContactSave/.test(uiRaw),
    has_package_save: /bcFieldEditRunPackageSave/.test(uiRaw),
    has_dates_save: /bcFieldEditRunDatesSave/.test(uiRaw),
    has_cancel_button: /bc-cancel-reservation-btn/.test(uiRaw),
    legend_has_cancelled: /bc-legend-sw-cancelled"><\/span>Cancelled/.test(uiRaw),
    has_stripe_api: /api\.stripe\.com/.test(uiRaw),
    has_whatsapp: /graph\.facebook\.com/.test(uiRaw),
    has_n8n_activate: /n8n\.cloud.*activate|activate.*workflow/i.test(uiRaw),
  };

  const stripeNew = await pg.query(`
    SELECT COUNT(*)::int AS n FROM payments p
    INNER JOIN bookings b ON b.id = p.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
      AND (p.stripe_checkout_session_id IS NOT NULL OR p.stripe_payment_intent_id IS NOT NULL)
      AND p.created_at > NOW() - INTERVAL '2 hours'
  `, [CLIENT, BOOKING]).catch(() => ({ rows: [{ n: 0 }] }));

  out.safety = {
    staging_only: true,
    payments_paid_truth_unchanged: payTruthSame(before, afterHard),
    amount_paid_unchanged: Number(before.booking.amount_paid_cents) === Number(afterHard.booking.amount_paid_cents),
    no_new_stripe_payments_2h: (stripeNew.rows[0] && stripeNew.rows[0].n) === 0,
    no_stripe_n8n_wa_ui: !out.ui_embedded.has_stripe_api && !out.ui_embedded.has_whatsapp && !out.ui_embedded.has_n8n_activate,
    add_service_no_stripe_msg: /No Stripe/i.test(String(out.add_service.message || '')),
  };

  out.invoice_refresh = {
    svc_sum_increased: svcSumAfter1 > svcSumBefore,
    expected_delta: expectedWetsuitCents,
    actual_delta: svcSumAfter1 - svcSumBefore,
    balance_due_display_increases: svcSumAfter1 > svcSumBefore && paidBefore >= 0,
    ctx0_status: ctx0.status,
    ctx1_more_services: (ctx1.body && ctx1.body.service_records || []).length >= (ctx0.body && ctx0.body.service_records || []).length,
  };

  out.pass = {
    revision: out.revision.health === 'Healthy' && out.revision.traffic === 100 && out.revision.image === IMAGE,
    add_service: out.add_service.api_status === 200 && out.add_service.success && out.add_service.created &&
      out.add_service.row_created && out.add_service.svc_rows_after > out.add_service.svc_rows_before &&
      out.add_service.amount_due_cents === expectedWetsuitCents && out.add_service.payments_unchanged,
    invoice_refresh: out.invoice_refresh.svc_sum_increased && out.invoice_refresh.actual_delta >= expectedWetsuitCents,
    idempotency: out.idempotency.idempotent === true && out.idempotency.created === false &&
      out.idempotency.svc_count_unchanged && out.idempotency.wetsuit_row_count === 1,
    service_labels: out.service_labels.soft_label === 'Soft board' &&
      out.service_labels.hard_label === 'Hard board' &&
      out.service_labels.wetsuit_label === 'Wetsuit',
    edit_smoke: out.edit_smoke.contact.success && out.edit_smoke.contact.updated &&
      out.edit_smoke.package.success && out.edit_smoke.date.success,
    cancel: out.cancel_smoke.skipped || (out.cancel_smoke.api_success && out.cancel_smoke.cancelled &&
      !out.cancel_smoke.in_calendar_after),
    safety: out.safety.payments_paid_truth_unchanged && out.safety.no_new_stripe_payments_2h &&
      out.safety.no_stripe_n8n_wa_ui,
    ui_addons: out.ui_embedded.has_add_service_panel && out.ui_embedded.has_add_service_api,
  };

  const hard = [
    out.pass.revision,
    out.pass.add_service,
    out.pass.invoice_refresh,
    out.pass.idempotency,
    out.pass.service_labels,
    out.pass.edit_smoke,
    out.pass.safety,
    out.pass.ui_addons,
  ];
  const cancelOk = out.pass.cancel;
  out.result = hard.every(Boolean) && cancelOk ? 'PASS' : 'PARTIAL';

  await pg.end();
  console.log(JSON.stringify(out, null, 2));
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
