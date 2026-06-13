'use strict';
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING = 'MB-WOLFHO-20260920-4f62e2';

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
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function label(t, meta) {
  if (meta.staff_ui_service_type === 'soft_board' || (t === 'surfboard' && meta.board_variant === 'soft')) return 'Soft board';
  if (meta.staff_ui_service_type === 'hard_board' || (t === 'surfboard' && meta.board_variant === 'hard')) return 'Hard board';
  if (meta.staff_ui_service_type === 'wetsuit' || t === 'wetsuit') return 'Wetsuit';
  return t;
}

(async () => {
  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  const cookie = (login.headers && login.headers['set-cookie'])
    ? login.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ')
    : '';
  const ctx = await req('GET', '/staff/bookings/' + BOOKING + '/context?client=' + CLIENT, null, cookie);
  const svcSum = (ctx.body.service_records || []).reduce((s, r) => s + Number(r.amount_due_cents || 0), 0);
  const labels = (ctx.body.service_records || []).map((r) => label(r.service_type, r.metadata || {}));

  const idem = await req('POST', '/staff/bookings/add-service?client=' + CLIENT, {
    client_slug: CLIENT, booking_code: BOOKING, service_type: 'wetsuit', quantity: 2,
    service_date: '2026-09-20', idempotency_key: 'stage106a-wetsuit-' + BOOKING,
  }, cookie);

  const dbUrl = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' }
  ).trim();
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const cnt = await pg.query(
    `SELECT COUNT(*)::int AS n FROM booking_service_records WHERE client_slug=$1 AND booking_code=$2`,
    [CLIENT, BOOKING]
  );
  await pg.end();

  console.log(JSON.stringify({
    context_svc_count: ctx.body.service_records?.length,
    context_labels: labels,
    invoice_svc_sum_cents: svcSum,
    idempotent_repeat: idem.body?.idempotent,
    idem_created: idem.body?.created,
    db_row_count: cnt.rows[0].n,
    booking_amount_paid: ctx.body.booking?.amount_paid_cents,
    balance_due_db: ctx.body.booking?.balance_due_cents,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
