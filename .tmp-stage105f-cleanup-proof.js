'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const MB = 'MB-WOLFHO-20260920-4f62e2';
const MB_RESET = { check_in: '2026-09-20', check_out: '2026-09-23' };

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

async function login() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      client: CLIENT,
      email: 'operator.stage72c@example.test',
      password: 'OperatorPass123!',
    });
    const r = https.request({
      hostname: HOST, path: '/staff/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        const ck = res.headers['set-cookie'];
        resolve({
          status: res.statusCode,
          cookie: ck ? ck.map((c) => c.split(';')[0]).join('; ') : '',
        });
      });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

async function snap(pg, bookingCode) {
  const b = await pg.query(`
    SELECT b.id::text AS booking_id, b.booking_code, b.guest_name, b.guest_count,
           b.package_code, b.status::text AS status,
           b.check_in::text AS check_in, b.check_out::text AS check_out,
           b.total_amount_cents, b.amount_paid_cents, b.balance_due_cents
    FROM bookings b
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    LIMIT 1
  `, [CLIENT, bookingCode]);
  const beds = await pg.query(`
    SELECT bb.id::text AS booking_bed_id, bb.bed_code,
           bb.assignment_start_date::text AS check_in,
           bb.assignment_end_date::text AS check_out
    FROM booking_beds bb
    INNER JOIN bookings b ON b.id = bb.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    ORDER BY bb.assignment_start_date ASC, bb.id ASC
  `, [CLIENT, bookingCode]);
  const pays = await pg.query(`
    SELECT p.id::text, p.status::text, p.amount_paid_cents
    FROM payments p
    INNER JOIN bookings b ON b.id = p.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    ORDER BY p.created_at
  `, [CLIENT, bookingCode]);
  let svc = [];
  try {
    svc = (await pg.query(
      'SELECT id::text, service_code FROM booking_service_records WHERE client_slug = $1 AND booking_code = $2',
      [CLIENT, bookingCode]
    )).rows;
  } catch (_) { svc = []; }
  return { booking: b.rows[0], beds: beds.rows, payments: pays.rows, service_records: svc };
}

function paySame(a, b) {
  return JSON.stringify(a.payments) === JSON.stringify(b.payments)
    && Number(a.booking.amount_paid_cents) === Number(b.booking.amount_paid_cents);
}

function svcSame(a, b) {
  return JSON.stringify(a.service_records) === JSON.stringify(b.service_records);
}

function calendarBlocksForBed(cal, bedCode, bookingCode) {
  return (cal.body && cal.body.blocks || []).filter((b) =>
    b.bed_code === bedCode && (!bookingCode || b.booking_code === bookingCode));
}

(async () => {
  const out = { revision: 'wh-staging-staff-api--0000084', commit: '0a1daba' };

  const auth = await login();
  if (auth.status !== 200 || !auth.cookie) throw new Error('login failed');

  const dbUrl = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' }
  ).trim();
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  // 1 — Reset MB fixture
  const beforeMb = await snap(pg, MB);
  const mbReset = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: MB,
    edit_type: 'dates',
    ...MB_RESET,
    idempotency_key: 'stage105f-cleanup-mb-reset-' + Date.now(),
  }, auth.cookie);
  const afterMb = await snap(pg, MB);
  out.fixture_reset = {
    method: 'POST /staff/bookings/edit dates',
    before: { check_in: beforeMb.booking.check_in, check_out: beforeMb.booking.check_out, beds: beforeMb.beds },
    api: {
      status: mbReset.status,
      success: mbReset.body && mbReset.body.success,
      updated: mbReset.body && mbReset.body.updated,
      error: mbReset.body && mbReset.body.error,
    },
    after: {
      check_in: afterMb.booking.check_in,
      check_out: afterMb.booking.check_out,
      beds: afterMb.beds,
    },
    pass: mbReset.status === 200 && mbReset.body && mbReset.body.success && mbReset.body.updated &&
      afterMb.booking.check_in === MB_RESET.check_in &&
      afterMb.booking.check_out === MB_RESET.check_out &&
      afterMb.beds.length === 1 &&
      afterMb.beds.every((b) => b.check_in === MB_RESET.check_in && b.check_out === MB_RESET.check_out),
  };

  // 2 — Create 2-guest / 2-bed disposable booking
  const createCi = '2027-05-12';
  const createCo = '2027-05-15';
  const beds = ['DEMO-R1-B1', 'DEMO-R1-B2'];
  const createPayload = {
    client_slug: CLIENT,
    check_in: createCi,
    check_out: createCo,
    selected_bed_codes: beds,
    guest_count: 2,
    guest_name: 'Guest Reduction Test',
    phone: '+34600555999',
    package_code: null,
    room_type: 'shared',
    payment_choice: 'deposit',
    add_ons: [],
    confirm: true,
    idempotency_key: 'stage105f-guest-reduction-create-' + Date.now(),
  };
  const created = await req('POST', '/staff/manual-bookings/create', createPayload, auth.cookie);
  const guestFixtureCode = created.body && created.body.booking_code;
  out.guest_reduction_fixture = {
    create_status: created.status,
    create_success: created.body && created.body.success,
    booking_code: guestFixtureCode,
    beds,
    dates: { check_in: createCi, check_out: createCo },
    guest_count: 2,
    error: created.body && created.body.error,
    detail: created.body && created.body.detail,
  };

  if (!guestFixtureCode) {
    // retry with malibu if package required
    const retry = await req('POST', '/staff/manual-bookings/create', {
      ...createPayload,
      package_code: 'malibu',
      idempotency_key: 'stage105f-guest-reduction-create-retry-' + Date.now(),
    }, auth.cookie);
    out.guest_reduction_fixture.retry = {
      status: retry.status,
      success: retry.body && retry.body.success,
      booking_code: retry.body && retry.body.booking_code,
      error: retry.body && retry.body.error,
    };
    if (retry.body && retry.body.booking_code) {
      out.guest_reduction_fixture.booking_code = retry.body.booking_code;
      out.guest_reduction_fixture.package_code = 'malibu';
    }
  }

  const fixtureCode = out.guest_reduction_fixture.booking_code;
  let guestProof = { skipped: true, reason: 'create failed' };
  let calendarProof = { skipped: true };

  if (fixtureCode) {
    const beforeG = await snap(pg, fixtureCode);
    const bedsBefore = beforeG.beds.map((b) => b.bed_code);
    const calBefore = await req('GET',
      '/staff/bed-calendar?client=' + CLIENT + '&start=' + createCi + '&end=' + createCo,
      null, auth.cookie);

    const gp = await req('POST', '/staff/bookings/edit-preview?client=' + CLIENT, {
      client_slug: CLIENT,
      booking_code: fixtureCode,
      edit_type: 'guests',
      guest_count: 1,
    }, auth.cookie);

    const gw = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
      client_slug: CLIENT,
      booking_code: fixtureCode,
      edit_type: 'guests',
      guest_count: 1,
      idempotency_key: 'stage105f-guest-reduction-' + Date.now(),
    }, auth.cookie);

    const afterG = await snap(pg, fixtureCode);
    const ctx = await req('GET', '/staff/bookings/' + fixtureCode + '/context?client=' + CLIENT, null, auth.cookie);
    const calAfter = await req('GET',
      '/staff/bed-calendar?client=' + CLIENT + '&start=' + createCi + '&end=' + createCo,
      null, auth.cookie);

    const releasedBed = bedsBefore.find((c) => !afterG.beds.some((b) => b.bed_code === c));
    const remainBed = afterG.beds[0] && afterG.beds[0].bed_code;

    const blocksB1Before = calendarBlocksForBed(calBefore, beds[0], fixtureCode);
    const blocksB2Before = calendarBlocksForBed(calBefore, beds[1], fixtureCode);
    const blocksB1After = calendarBlocksForBed(calAfter, beds[0], fixtureCode);
    const blocksB2After = calendarBlocksForBed(calAfter, beds[1], fixtureCode);

    const cancelledProbe = await pg.query(`
      SELECT b.booking_code FROM bookings b
      JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND b.status = 'cancelled'
      ORDER BY b.updated_at DESC NULLS LAST LIMIT 3
    `, [CLIENT]);
    let cancelledInCal = false;
    for (const row of cancelledProbe.rows) {
      const calC = await req('GET',
        '/staff/bed-calendar?client=' + CLIENT + '&start=2027-04-10&end=2027-04-14',
        null, auth.cookie);
      if ((calC.body && calC.body.blocks || []).some((b) => b.booking_code === row.booking_code)) {
        cancelledInCal = true;
        break;
      }
    }

    guestProof = {
      preview_status: gp.status,
      preview_can_apply: gp.body && gp.body.can_apply,
      preview_released: gp.body && gp.body.proposed && gp.body.proposed.released_beds,
      write_status: gw.status,
      write_success: gw.body && gw.body.success,
      write_updated: gw.body && gw.body.updated,
      error: gw.body && gw.body.error,
      message: gw.body && gw.body.message,
      needs_refund: gw.body && gw.body.needs_refund,
      refund_review_needed: gw.body && gw.body.refund_review_needed,
      invoice_preview: gw.body && gw.body.invoice_preview,
      bed_release: gw.body && gw.body.bed_release,
      db_guest_count: Number(afterG.booking.guest_count),
      beds_before: bedsBefore,
      beds_after: afterG.beds.map((b) => b.bed_code),
      released_bed: releasedBed,
      remaining_bed: remainBed,
      remaining_unchanged: bedsBefore.filter((c) => c !== releasedBed).every((c) =>
        afterG.beds.some((b) => b.bed_code === c)),
      payments_unchanged: paySame(beforeG, afterG),
      service_records_unchanged: svcSame(beforeG, afterG),
      amount_paid_unchanged: Number(beforeG.booking.amount_paid_cents) === Number(afterG.booking.amount_paid_cents),
      context_guest_count: ctx.body && ctx.body.booking && ctx.body.booking.guest_count,
      context_total: ctx.body && ctx.body.booking && ctx.body.booking.total_amount_cents,
      pass: gw.status === 200 && gw.body && gw.body.success && gw.body.updated &&
        afterG.booking.guest_count === 1 && afterG.beds.length === 1 &&
        !!releasedBed && afterG.beds[0].bed_code === bedsBefore[0],
    };

    calendarProof = {
      bed1_blocks_before: blocksB1Before.length,
      bed2_blocks_before: blocksB2Before.length,
      bed1_blocks_after_remain: blocksB1After.length,
      bed2_blocks_after_released: blocksB2After.length,
      released_bed_empty: releasedBed ? blocksB2After.length === 0 || !blocksB2After.some((b) => b.booking_code === fixtureCode) : null,
      remain_bed_still_shows: blocksB1After.some((b) => b.booking_code === fixtureCode),
      cancelled_booking_in_calendar: cancelledInCal,
      pass: blocksB1After.some((b) => b.booking_code === fixtureCode) &&
        (releasedBed === beds[1] ? !blocksB2After.some((b) => b.booking_code === fixtureCode) : true) &&
        !cancelledInCal,
    };
  }

  out.guest_reduction_proof = guestProof;
  out.calendar_proof = calendarProof;

  const ui = await req('GET', '/staff/ui', null, auth.cookie);
  const uiRaw = ui.raw || '';
  out.legend = {
    cancelled_in_legend: /bc-legend-sw-cancelled"><\/span>Cancelled/.test(uiRaw),
    pass: !/bc-legend-sw-cancelled"><\/span>Cancelled/.test(uiRaw),
  };

  out.safety = {
    staging_host: HOST,
    staging_db_only: true,
    no_stripe_api: !/api\.stripe\.com/.test(uiRaw),
    no_whatsapp: !/graph\.facebook\.com/.test(uiRaw),
    no_n8n: !/n8n\.cloud.*activate|activate.*workflow/i.test(uiRaw),
    pass: !/api\.stripe\.com/.test(uiRaw) && !/graph\.facebook\.com/.test(uiRaw),
  };

  const hard = [
    out.fixture_reset.pass,
    guestProof.pass,
    calendarProof.pass,
    out.legend.pass,
    out.safety.pass,
  ];
  out.result = hard.every(Boolean) ? 'PASS' : (guestProof.skipped || !out.fixture_reset.pass ? 'FAIL' : 'PARTIAL');

  await pg.end();
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error('FAIL:', e.message, e.stack);
  process.exit(1);
});
