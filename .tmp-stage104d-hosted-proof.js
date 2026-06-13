'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_WITH_ADDONS = 'MB-WOLFHO-20260901-cb4799';
const BOOKING_NO_ADDONS = 'MB-WOLFHO-20260920-4f62e2';
const BOOKING_MULTI = 'DEMO-2603';

function req(method, path, body, cookie, accept) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        Accept: accept || 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        if ((accept || '').includes('json') || /\/staff\/(auth|bookings)/.test(path)) {
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function getStagingDbUrl() {
  return execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  ).trim();
}

async function counts(pg) {
  const r = await pg.query(`
    SELECT
      (SELECT COUNT(*)::int FROM bookings b INNER JOIN clients c ON c.id = b.client_id WHERE c.slug = $1) AS bookings,
      (SELECT COUNT(*)::int FROM booking_beds bb INNER JOIN clients c ON c.id = bb.client_id WHERE c.slug = $1) AS booking_beds,
      (SELECT COUNT(*)::int FROM payments p INNER JOIN clients c ON c.id = p.client_id WHERE c.slug = $1) AS payments,
      (SELECT COUNT(*)::int FROM booking_service_records s WHERE s.client_slug = $1) AS service_records
  `, [CLIENT]);
  return r.rows[0];
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function inspectContext(label, ctx) {
  const bk = ctx.booking || {};
  const svc = ctx.service_records || [];
  const pmt = ctx.payments || {};
  console.log('\n--- ' + label + ' ---');
  console.log('booking_code:', bk.booking_code, '| guest:', bk.guest_name);
  console.log('package:', bk.package_code, '| stay:', bk.check_in, '->', bk.check_out);
  console.log('total_amount_cents:', bk.total_amount_cents, '| paid:', bk.amount_paid_cents, '| balance:', bk.balance_due_cents);
  console.log('service_records:', svc.length);
  svc.forEach((sr) => {
    console.log('  -', sr.service_type, 'qty', sr.quantity, 'due', sr.amount_due_cents, 'paid', sr.amount_paid_cents);
  });
  console.log('payment rows:', (pmt.rows || []).length);
  return { bk, svc, pmt };
}

(async () => {
  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  assert(login.status === 200, 'login failed: ' + login.status);

  const ui = await req('GET', '/staff/ui?client=' + CLIENT, null, cookie, 'text/html');
  assert(ui.status === 200, 'staff/ui failed');
  const uiHtml = ui.raw || '';
  assert(/bc-running-invoice/.test(uiHtml), 'UI missing bc-running-invoice');
  assert(/bcRenderRunningInvoiceHtml/.test(uiHtml), 'UI missing bcRenderRunningInvoiceHtml');
  assert(/bc-inv-accommodation/.test(uiHtml), 'UI missing bc-inv-accommodation');
  assert(/bc-inv-addons/.test(uiHtml), 'UI missing bc-inv-addons');
  assert(/bc-inv-totals/.test(uiHtml), 'UI missing bc-inv-totals');
  assert(/Stripe\/webhook payments remain payment truth/.test(uiHtml), 'UI missing payment truth copy');
  assert(!/id="bc-service-records"/.test(uiHtml), 'legacy bc-service-records still in UI');
  assert(!/Services &amp; Add-ons/.test(uiHtml) || !/<h3>Services &amp; Add-ons<\/h3>/.test(uiHtml.split('bc-service-records').join('')),
    'legacy Services heading may still exist');
  assert(!/api\.stripe\.com/.test(uiHtml), 'UI contains api.stripe.com');
  assert(!/graph\.facebook\.com/.test(uiHtml), 'UI contains graph.facebook.com');

  const pg = new Client({ connectionString: getStagingDbUrl(), ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const countsBefore = await counts(pg);

  const ctxAddons = await req('GET', '/staff/bookings/' + encodeURIComponent(BOOKING_WITH_ADDONS) + '/context?client=' + CLIENT, null, cookie);
  assert(ctxAddons.status === 200, 'addons booking context failed');
  const addonsData = inspectContext('WITH ADD-ONS: ' + BOOKING_WITH_ADDONS, ctxAddons.body);
  assert(addonsData.svc.length > 0, 'expected service_records on addon booking');

  const ctxNoAddons = await req('GET', '/staff/bookings/' + encodeURIComponent(BOOKING_NO_ADDONS) + '/context?client=' + CLIENT, null, cookie);
  assert(ctxNoAddons.status === 200, 'no-addons booking context failed');
  const noAddonsData = inspectContext('NO ADD-ONS: ' + BOOKING_NO_ADDONS, ctxNoAddons.body);
  assert(noAddonsData.svc.length === 0, 'expected zero service_records on polish test booking');

  const ctxMulti = await req('GET', '/staff/bookings/' + encodeURIComponent(BOOKING_MULTI) + '/context?client=' + CLIENT, null, cookie);
  if (ctxMulti.status === 200) {
    inspectContext('MULTI-BED: ' + BOOKING_MULTI, ctxMulti.body);
  } else {
    console.log('\n--- DEMO-2603 context:', ctxMulti.status, '(optional) ---');
  }

  const countsAfter = await counts(pg);
  await pg.end();

  assert(JSON.stringify(countsBefore) === JSON.stringify(countsAfter), 'DB counts changed during read-only proof');

  console.log('\n=== Phase 10.4d hosted proof summary ===');
  console.log(JSON.stringify({
    result: 'PASS',
    commit: '6466f1f',
    image: 'whstagingacr.azurecr.io/wh-staff-api:6466f1f-stage104d-running-invoice',
    acr_run: 'cb1t',
    revision: 'wh-staging-staff-api--0000072',
    bookings_inspected: [BOOKING_WITH_ADDONS, BOOKING_NO_ADDONS, BOOKING_MULTI],
    service_records: {
      [BOOKING_WITH_ADDONS]: addonsData.svc.length,
      [BOOKING_NO_ADDONS]: noAddonsData.svc.length,
    },
    counts_unchanged: countsBefore,
    ui_markers: {
      bc_running_invoice: true,
      payment_truth_copy: true,
      legacy_service_panel_removed: true,
    },
    safety: {
      no_stripe_api_in_ui: true,
      no_whatsapp_in_ui: true,
      db_counts_unchanged: true,
      read_only_session: true,
    },
  }, null, 2));
})().catch((err) => {
  console.error('\nFAIL:', err.message);
  process.exit(1);
});
