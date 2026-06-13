'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');

(async () => {
  const url = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const code = 'WH-G27-5AD46DDF56';
  const bk = await pg.query(
    `SELECT booking_code, total_amount_cents, amount_paid_cents, balance_due_cents, metadata
       FROM bookings WHERE booking_code = $1`,
    [code],
  );
  const svc = await pg.query(
    `SELECT service_type, status, payment_status, amount_due_cents
       FROM booking_service_records
      WHERE booking_id = (SELECT id FROM bookings WHERE booking_code = $1)`,
    [code],
  );
  const pm = await pg.query(
    `SELECT payment_kind, status, amount_due_cents, amount_paid_cents, metadata
       FROM payments
      WHERE booking_id = (SELECT id FROM bookings WHERE booking_code = $1)
      ORDER BY created_at`,
    [code],
  );
  const md = bk.rows[0] && bk.rows[0].metadata;
  let quoteSnap = null;
  try {
    const parsed = typeof md === 'string' ? JSON.parse(md) : md;
    quoteSnap = parsed && parsed.quote_snapshot;
  } catch (_) { /* ignore */ }
  console.log(JSON.stringify({
    booking: bk.rows[0],
    services: svc.rows,
    payments: pm.rows.map((r) => ({
      kind: r.payment_kind,
      status: r.status,
      due: r.amount_due_cents,
      paid: r.amount_paid_cents,
      source: (() => {
        try {
          const m = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata;
          return m && m.source;
        } catch (_) { return null; }
      })(),
    })),
    quote_accommodation: quoteSnap && quoteSnap.line_items,
  }, null, 2));
  await pg.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
