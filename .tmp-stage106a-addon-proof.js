'use strict';
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING = 'MB-WOLFHO-20260920-4f62e2';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:590484f-stage106a-drawer-clean-final';

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

function invoiceSvcSum(rows) {
  return rows.reduce((n, r) => n + Number(r.amount_due_cents || 0), 0);
}

(async () => {
  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  if (login.status !== 200) throw new Error('login failed: ' + login.status);
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  const ui = await req('GET', '/staff/ui', null, cookie);
  const s = ui.raw || '';
  const drawer = (() => {
    const i = s.indexOf('function renderBookingContextDrawer(data){');
    const j = s.indexOf('\n/* ── Tour Operator forms', i);
    return i >= 0 && j > i ? s.slice(i, j) : '';
  })();

  const layout = {
    addons_before_payment: /bcRenderAddServicePanelHtml[\s\S]*bcRenderRunningInvoiceHtml/.test(drawer),
    add_btn: /id="bc-add-ons-btn"/.test(drawer),
    remove_btn: /id="bc-add-ons-remove-btn"/.test(drawer),
    title_row: /bc-add-ons-title/.test(drawer),
  };

  const dbUrl = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' }
  ).trim();
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const before = await pg.query(`
    SELECT b.amount_paid_cents, b.check_in::text AS check_in
    FROM bookings b JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
  `, [CLIENT, BOOKING]);
  const svcBefore = await pg.query(
    'SELECT id::text, service_type, amount_due_cents FROM booking_service_records WHERE client_slug = $1 AND booking_code = $2',
    [CLIENT, BOOKING]
  );
  const paidBefore = Number(before.rows[0].amount_paid_cents || 0);
  const sumBefore = invoiceSvcSum(svcBefore.rows);

  const key = 'stage106a-addon-' + Date.now();
  const add = await req('POST', '/staff/bookings/add-service?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING,
    service_type: 'wetsuit',
    quantity: 1,
    service_date: before.rows[0].check_in,
    idempotency_key: key,
  }, cookie);

  const ctx = await req('GET', '/staff/bookings/' + BOOKING + '/context?client=' + CLIENT, null, cookie);
  const svcAfter = await pg.query(
    'SELECT id::text, service_type, amount_due_cents FROM booking_service_records WHERE client_slug = $1 AND booking_code = $2',
    [CLIENT, BOOKING]
  );
  const paidAfter = Number((await pg.query(`
    SELECT amount_paid_cents FROM bookings b JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
  `, [CLIENT, BOOKING])).rows[0].amount_paid_cents || 0);
  const sumAfter = invoiceSvcSum(svcAfter.rows);
  const inv = ctx.body && ctx.body.running_invoice;

  await pg.end();

  const out = {
    layout,
    add: { status: add.status, success: add.body && add.body.success },
    invoice: {
      ctx_status: ctx.status,
      has_running: !!(inv && (inv.lines || inv.total_cents != null)),
      sum_before: sumBefore,
      sum_after: sumAfter,
      increased: sumAfter > sumBefore,
    },
    payments_unchanged: paidBefore === paidAfter,
    pass: layout.addons_before_payment && layout.add_btn && layout.remove_btn
      && add.status === 200 && add.body && add.body.success
      && sumAfter > sumBefore && paidBefore === paidAfter,
  };
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
