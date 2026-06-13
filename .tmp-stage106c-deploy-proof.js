'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:5fd5d1b-stage106c-payment-link-drawer-polish';

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
        let body = raw;
        try { body = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body, raw });
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
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties.template.containers[0].image,
  };
}

function drawerSlice(uiHtml) {
  const i = uiHtml.indexOf('function renderBookingContextDrawer(data){');
  const j = uiHtml.indexOf('\n/* ── Tour Operator forms', i);
  return i >= 0 && j > i ? uiHtml.slice(i, j) : '';
}

(async () => {
  const out = { revision: activeRevision(), proofs: {} };

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  if (login.status !== 200) throw new Error('login failed');
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  const ui = await req('GET', '/staff/ui', null, cookie);
  const s = ui.raw || '';
  const drawer = drawerSlice(s);

  out.proofs.bundle = {
    grid_template: /grid-template-columns:minmax\(180px,1\.4fr\)/.test(s),
    field_kv_grid: /ctx-field-kv-grid--3/.test(s),
    generate_btn: /Generate Payment Link/.test(drawer),
    copy_icon: /btn-bc-copy-link-icon/.test(drawer),
    copy_aria: /aria-label="Copy payment link"/.test(drawer),
    payment_history: /Payment history/.test(drawer),
    addons_before_pay: /bcRenderAddServicePanelHtml[\s\S]*bcRenderRunningInvoiceHtml/.test(drawer),
    move_bed: />Move bed</.test(drawer),
    cancel_footer: /bc-cancel-reservation-btn/.test(drawer),
    no_wa: !/graph\.facebook\.com/.test(s),
    no_n8n: !/n8n\.cloud.*activate/i.test(s),
  };

  const dbUrl = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' }
  ).trim();
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const pick = await pg.query(`
    SELECT b.booking_code, b.guest_name, b.check_in::text AS ci, b.check_out::text AS co,
           b.total_amount_cents, b.amount_paid_cents, b.status::text AS status,
           MIN(bb.bed_code) AS bed
    FROM bookings b
    JOIN clients c ON c.id = b.client_id
    LEFT JOIN booking_beds bb ON bb.booking_id = b.id
    WHERE c.slug = $1
      AND b.status NOT IN ('cancelled', 'expired')
      AND (b.guest_name ILIKE 'Stage106%' OR b.booking_code LIKE 'MB-WOLFHO-2026%')
    GROUP BY b.id, b.booking_code, b.guest_name, b.check_in, b.check_out,
             b.total_amount_cents, b.amount_paid_cents, b.status
    ORDER BY b.created_at DESC
    LIMIT 8
  `, [CLIENT]);
  out.disposable_candidates = pick.rows;

  let bookingCode = pick.rows[0] && pick.rows[0].booking_code;
  if (!bookingCode) throw new Error('no disposable booking found');

  const ctxBefore = await req('GET', `/staff/bookings/${encodeURIComponent(bookingCode)}/context?client=${CLIENT}`, null, cookie);
  out.proofs.context_before = ctxBefore.status === 200 && ctxBefore.body.success;

  const wetsuitKey = 'stage106c-wetsuit-' + Date.now();
  const add = await req('POST', `/staff/bookings/add-service?client=${CLIENT}`, {
    client_slug: CLIENT,
    booking_code: bookingCode,
    service_type: 'wetsuit',
    quantity: 1,
    service_date: '2026-09-21',
    idempotency_key: wetsuitKey,
  }, cookie);
  out.proofs.add_service = add.status === 200 && add.body && add.body.success;

  const ctxAfterAdd = await req('GET', `/staff/bookings/${encodeURIComponent(bookingCode)}/context?client=${CLIENT}`, null, cookie);
  const svcCountAfter = (ctxAfterAdd.body.service_records || []).length;
  out.proofs.invoice_after_add = svcCountAfter > 0;

  const payBefore = await pg.query(`
    SELECT p.id::text, p.status::text, p.amount_due_cents, p.amount_paid_cents, p.checkout_url
    FROM payments p
    JOIN bookings b ON b.id = p.booking_id
    JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    ORDER BY p.created_at DESC
  `, [CLIENT, bookingCode]);
  const paidBefore = payBefore.rows.filter((r) => r.status === 'paid')
    .reduce((s, r) => s + Number(r.amount_paid_cents || 0), 0);

  const linkKey1 = 'stage106c-link-' + Date.now();
  const link1 = await req('POST', `/staff/bookings/generate-payment-link?client=${CLIENT}`, {
    client_slug: CLIENT,
    booking_code: bookingCode,
    idempotency_key: linkKey1,
    reason: 'Stage106c deploy proof',
  }, cookie);
  out.proofs.generate_link = {
    status: link1.status,
    success: link1.body && link1.body.success,
    url: !!(link1.body && (link1.body.payment_link_url || link1.body.checkout_url)),
    idempotent: link1.body && link1.body.idempotent,
    created: link1.body && link1.body.created,
    send_mutation: link1.body && link1.body.send_mutation,
    no_whatsapp: link1.body && link1.body.no_whatsapp,
  };

  const bkAfterLink = await pg.query(`
    SELECT b.amount_paid_cents FROM bookings b
    JOIN clients c ON c.id = b.client_id WHERE c.slug = $1 AND b.booking_code = $2
  `, [CLIENT, bookingCode]);
  const payAfterLink = await pg.query(`
    SELECT p.id::text, p.status::text, p.amount_due_cents, p.amount_paid_cents, p.checkout_url
    FROM payments p
    JOIN bookings b ON b.id = p.booking_id
    JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    ORDER BY p.created_at DESC
  `, [CLIENT, bookingCode]);
  const paidAfterLink = payAfterLink.rows.filter((r) => r.status === 'paid')
    .reduce((s, r) => s + Number(r.amount_paid_cents || 0), 0);
  const checkoutRows = payAfterLink.rows.filter((r) => r.status === 'checkout_created');

  out.proofs.link_no_paid_truth = {
    booking_paid_unchanged: Number(bkAfterLink.rows[0].amount_paid_cents) === Number(pick.rows[0].amount_paid_cents || 0) || paidAfterLink === paidBefore,
    ledger_paid_same: paidAfterLink === paidBefore,
    checkout_row: checkoutRows.length > 0,
    checkout_url: !!(checkoutRows[0] && checkoutRows[0].checkout_url),
  };

  const link2 = await req('POST', `/staff/bookings/generate-payment-link?client=${CLIENT}`, {
    client_slug: CLIENT,
    booking_code: bookingCode,
    idempotency_key: 'stage106c-link-dup-' + Date.now(),
    reason: 'idempotent same balance',
  }, cookie);
  out.proofs.generate_link_idempotent = {
    status: link2.status,
    idempotent: link2.body && link2.body.idempotent,
    same_url: link2.body && link1.body &&
      (link2.body.payment_link_url || link2.body.checkout_url) === (link1.body.payment_link_url || link1.body.checkout_url),
  };

  const cashKey = 'stage106c-cash-' + Date.now();
  const cashAmt = 500;
  const cash = await req('POST', `/staff/bookings/record-cash-payment?client=${CLIENT}`, {
    client_slug: CLIENT,
    booking_code: bookingCode,
    amount_cents: cashAmt,
    idempotency_key: cashKey,
    note: 'stage106c cash proof',
  }, cookie);
  out.proofs.cash_payment = {
    status: cash.status,
    success: cash.body && cash.body.success,
    balance_after: cash.body && cash.body.balance_due_cents,
  };

  const paidAfterCash = await pg.query(`
    SELECT COALESCE(SUM(p.amount_paid_cents),0)::int AS paid
    FROM payments p
    JOIN bookings b ON b.id = p.booking_id
    JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2 AND p.status = 'paid'
  `, [CLIENT, bookingCode]);
  out.proofs.cash_increased_paid = paidAfterCash.rows[0].paid > paidAfterLink;

  if (svcCountAfter > 0) {
    const sr = ctxAfterAdd.body.service_records[ctxAfterAdd.body.service_records.length - 1];
    const rem = await req('POST', `/staff/bookings/remove-service?client=${CLIENT}`, {
      client_slug: CLIENT,
      booking_code: bookingCode,
      booking_service_record_id: sr.service_record_id || sr.id,
      idempotency_key: 'stage106c-rm-' + Date.now(),
    }, cookie);
    out.proofs.remove_service = rem.status === 200 && rem.body && rem.body.success;
  }

  out.booking_used = bookingCode;
  out.deploy_ok = out.revision.health === 'Healthy' && out.revision.traffic === 100
    && out.revision.image === IMAGE;

  const checks = [
    out.deploy_ok,
    Object.values(out.proofs.bundle).every(Boolean),
    out.proofs.add_service,
    out.proofs.generate_link.success,
    out.proofs.generate_link.url,
    out.proofs.generate_link.send_mutation === false,
    out.proofs.link_no_paid_truth.checkout_row,
    out.proofs.generate_link_idempotent.idempotent,
    out.proofs.cash_payment.success,
    out.proofs.cash_increased_paid,
  ];
  out.result = checks.every(Boolean) ? 'PASS' : 'PARTIAL';

  await pg.end();
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
