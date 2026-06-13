'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
const { calculateWolfhouseQuote } = require('./scripts/lib/wolfhouse-quote-calculator');
const az = (c) => execSync(c, { encoding: 'utf8' }).trim();

const CANDIDATES = [
  { check_in: '2026-07-24', check_out: '2026-07-31', turn2: 'July 24 to July 31' },
  { check_in: '2026-08-04', check_out: '2026-08-11', turn2: 'August 4 to August 11' },
  { check_in: '2026-09-01', check_out: '2026-09-08', turn2: 'September 1 to September 8' },
];

(async () => {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const out = [];
  for (const c of CANDIDATES) {
    const occ = await pg.query(`
      SELECT bb.bed_code FROM booking_beds bb
       JOIN bookings b ON b.id=bb.booking_id JOIN clients cl ON cl.id=b.client_id
       WHERE cl.slug='wolfhouse-somo' AND bb.bed_code LIKE 'DEMO-%'
         AND bb.assignment_start_date < $2::date AND bb.assignment_end_date > $1::date
         AND b.status NOT IN ('cancelled','expired')`, [c.check_in, c.check_out]);
    const beds = await pg.query("SELECT bed_code FROM beds WHERE bed_code LIKE 'DEMO-%'");
    const occupied = new Set(occ.rows.map((r) => r.bed_code));
    const free = beds.rows.filter((b) => !occupied.has(b.bed_code));
    const quote = calculateWolfhouseQuote({
      client_slug: 'wolfhouse-somo',
      package_code: 'malibu',
      check_in: c.check_in,
      check_out: c.check_out,
      guest_count: 2,
      room_type: 'shared',
    });
    const priceOk = quote.success === true && !quote.staff_review_required && quote.total_cents > 0;
    out.push({
      ...c,
      free_beds: free.length,
      free_codes: free.map((b) => b.bed_code),
      quote_success: quote.success,
      season_code: quote.season_code,
      total_cents: quote.total_cents,
      staff_review_required: quote.staff_review_required,
      blockers: quote.blockers || [],
      price_ok: priceOk,
      ok: priceOk && free.length >= 2,
    });
  }
  const chosen = out.find((x) => x.ok) || null;
  console.log(JSON.stringify({ candidates: out, chosen }, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
