'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const MB = 'MB-WOLFHO-20260920-4f62e2';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:f1b3a04-stage105d1-no-package-short-stays';

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
        resolve({ status: res.statusCode, body: parsed, raw });
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

async function snap(pg, code) {
  const b = await pg.query(`
    SELECT b.booking_code, b.guest_name, b.package_code, b.guest_count,
           b.check_in::text AS check_in, b.check_out::text AS check_out,
           b.total_amount_cents, b.amount_paid_cents, b.balance_due_cents
    FROM bookings b
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    LIMIT 1
  `, [CLIENT, code]);
  const beds = await pg.query(`
    SELECT bb.bed_code, bb.assignment_start_date::text AS ci, bb.assignment_end_date::text AS co
    FROM booking_beds bb
    INNER JOIN bookings b ON b.id = bb.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    ORDER BY bb.assignment_start_date, bb.id
  `, [CLIENT, code]);
  const pays = await pg.query(`
    SELECT p.id::text, p.status::text, p.amount_paid_cents
    FROM payments p
    INNER JOIN bookings b ON b.id = p.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    ORDER BY p.created_at
  `, [CLIENT, code]);
  let svc = [];
  try {
    svc = (await pg.query(
      'SELECT id::text, service_code FROM booking_service_records WHERE client_slug = $1 AND booking_code = $2',
      [CLIENT, code]
    )).rows;
  } catch (_) { svc = []; }
  return { booking: b.rows[0], beds: beds.rows, payments: pays.rows, service_records: svc };
}

function nights(ci, co) {
  if (!ci || !co) return null;
  const a = new Date(ci + 'T00:00:00Z');
  const b = new Date(co + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

function paySame(a, b) {
  return JSON.stringify(a.payments) === JSON.stringify(b.payments)
    && Number(a.booking.amount_paid_cents) === Number(b.booking.amount_paid_cents);
}

function svcSame(a, b) {
  return JSON.stringify(a.service_records) === JSON.stringify(b.service_records);
}

(async () => {
  const out = {
    commit: 'f1b3a04',
    image: IMAGE,
    acr_run: 'cb21',
    revision: activeRevision(),
  };

  const login = await new Promise((resolve, reject) => {
    const body = JSON.stringify({
      client: CLIENT,
      email: 'operator.stage72c@example.test',
      password: 'OperatorPass123!',
    });
    const r = https.request({
      hostname: HOST,
      path: '/staff/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        const ck = res.headers['set-cookie'];
        resolve({
          status: res.statusCode,
          cookie: ck ? ck.map((c) => c.split(';')[0]).join('; ') : '',
          raw,
        });
      });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
  if (login.status !== 200 || !login.cookie) throw new Error('login failed: ' + login.status);
  const cookie = login.cookie;

  const dbUrl = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' }
  ).trim();
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const candidates = await pg.query(`
    SELECT b.booking_code, b.package_code, b.guest_count,
           b.check_in::text AS check_in, b.check_out::text AS check_out,
           (SELECT COUNT(*)::int FROM booking_beds bb WHERE bb.booking_id = b.id) AS bed_count
    FROM bookings b
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1
      AND (b.package_code IS NULL OR TRIM(b.package_code) = '')
      AND b.check_out > b.check_in
      AND (b.check_out::date - b.check_in::date) < 6
    ORDER BY bed_count DESC, b.booking_code
    LIMIT 15
  `, [CLIENT]);
  out.short_no_package_candidates = candidates.rows.map((r) => ({
    ...r,
    nights: nights(r.check_in, r.check_out),
  }));

  // Test 1 — Date Save MB
  const beforeMb = await snap(pg, MB);
  const dateTarget = { check_in: '2026-09-24', check_out: '2026-09-27' };
  const dw = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: MB,
    edit_type: 'dates',
    ...dateTarget,
    idempotency_key: 'stage105d1-date-save-' + Date.now(),
  }, cookie);
  const afterMb = await snap(pg, MB);
  out.date_save = {
    status: dw.status,
    success: dw.body && dw.body.success,
    updated: dw.body && dw.body.updated,
    error: dw.body && dw.body.error,
    detail: dw.body && dw.body.detail,
    no_bb_sql_error: !(String(dw.body && dw.body.detail || '').includes('FROM-clause entry for table "bb"')),
    db_check_in: afterMb.booking.check_in,
    db_check_out: afterMb.booking.check_out,
    beds: afterMb.beds,
    beds_match: afterMb.beds.every((b) => b.ci === dateTarget.check_in && b.co === dateTarget.check_out),
    payments_unchanged: paySame(beforeMb, afterMb),
    service_records_unchanged: svcSame(beforeMb, afterMb),
    ui_has_dates_save: /bcFieldEditRunDatesSave/.test((await req('GET', '/staff/ui', null, cookie)).raw || ''),
  };

  // Test 2 — Date conflict (after test 1, MB is on 2026-09-24..27 — use overlap range on B1)
  const conflictRange = { check_in: '2026-07-10', check_out: '2026-07-20' };
  const dc = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: MB,
    edit_type: 'dates',
    ...conflictRange,
    idempotency_key: 'stage105d1-date-conflict-' + Date.now(),
  }, cookie);
  const afterConflict = await snap(pg, MB);
  out.date_conflict = {
    status: dc.status,
    can_apply: dc.body && dc.body.can_apply,
    updated: dc.body && dc.body.updated,
    conflict_count: dc.body && dc.body.conflicts ? dc.body.conflicts.length : 0,
    dates_unchanged: afterConflict.booking.check_in === afterMb.booking.check_in &&
      afterConflict.booking.check_out === afterMb.booking.check_out,
  };

  // Test 3 — short no-package date save
  let shortCode = null;
  for (const row of candidates.rows) {
    if (Number(row.bed_count) >= 1 && row.booking_code !== MB) {
      shortCode = row.booking_code;
      break;
    }
  }
  if (!shortCode && candidates.rows.length) shortCode = candidates.rows[0].booking_code;

  if (shortCode) {
    const beforeShort = await snap(pg, shortCode);
    const n = nights(beforeShort.booking.check_in, beforeShort.booking.check_out);
    const newCi = beforeShort.booking.check_in;
    const d = new Date(beforeShort.booking.check_out + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    const newCo = d.toISOString().slice(0, 10);
    const newN = nights(newCi, newCo);
    const sw = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
      client_slug: CLIENT,
      booking_code: shortCode,
      edit_type: 'dates',
      check_in: newCi,
      check_out: newCo,
      idempotency_key: 'stage105d1-short-date-' + Date.now(),
    }, cookie);
    const afterShort = await snap(pg, shortCode);
    out.short_no_package_date = {
      booking_code: shortCode,
      nights_before: n,
      nights_after: newN,
      status: sw.status,
      success: sw.body && sw.body.success,
      updated: sw.body && sw.body.updated,
      error: sw.body && sw.body.error,
      package_still_null: afterShort.booking.package_code == null || String(afterShort.booking.package_code || '').trim() === '',
      no_package_required_error: sw.body && sw.body.error !== 'package_code is required' &&
        !(sw.body && sw.body.invoice_preview && (sw.body.invoice_preview.calculation_warnings || []).some((w) => w === 'package_code is required')),
      calculation_warnings: sw.body && sw.body.invoice_preview && sw.body.invoice_preview.calculation_warnings,
      db_dates_changed: afterShort.booking.check_in !== beforeShort.booking.check_in ||
        afterShort.booking.check_out !== beforeShort.booking.check_out,
      payments_unchanged: paySame(beforeShort, afterShort),
    };
  } else {
    out.short_no_package_date = { skipped: true, reason: 'no short no-package booking found' };
  }

  // Test 4 — guest reduction short no-package multi-bed
  const guestCand = await pg.query(`
    SELECT b.booking_code, b.guest_count,
           (SELECT COUNT(*)::int FROM booking_beds bb WHERE bb.booking_id = b.id) AS bed_count,
           b.check_in::text AS check_in, b.check_out::text AS check_out
    FROM bookings b
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1
      AND (b.package_code IS NULL OR TRIM(b.package_code) = '')
      AND (b.check_out::date - b.check_in::date) < 6
      AND b.guest_count >= 2
      AND (SELECT COUNT(*) FROM booking_beds bb WHERE bb.booking_id = b.id) >= 2
    ORDER BY b.booking_code
    LIMIT 5
  `, [CLIENT]);

  if (guestCand.rows.length) {
    const gCode = guestCand.rows[0].booking_code;
    const beforeG = await snap(pg, gCode);
    const bedsBefore = beforeG.beds.map((b) => b.bed_code);
    const target = Math.max(1, Number(beforeG.booking.guest_count) - 1);
    const gw = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
      client_slug: CLIENT,
      booking_code: gCode,
      edit_type: 'guests',
      guest_count: target,
      idempotency_key: 'stage105d1-short-guest-' + Date.now(),
    }, cookie);
    const afterG = await snap(pg, gCode);
    const released = bedsBefore.filter((c) => !afterG.beds.some((b) => b.bed_code === c));
    out.short_no_package_guest = {
      booking_code: gCode,
      status: gw.status,
      success: gw.body && gw.body.success,
      updated: gw.body && gw.body.updated,
      error: gw.body && gw.body.error,
      package_still_null: afterG.booking.package_code == null || String(afterG.booking.package_code || '').trim() === '',
      no_package_required_error: gw.body && gw.body.error !== 'package_code is required' &&
        gw.body && gw.body.error !== 'guests_reprice_calculation_unavailable' || (
          gw.body && gw.body.error === 'guests_reprice_calculation_unavailable' &&
          !(String((gw.body.invoice_preview && gw.body.invoice_preview.calculation_warnings) || []).includes('package_code is required'))
        ),
      guest_count_after: Number(afterG.booking.guest_count),
      beds_before: bedsBefore,
      beds_after: afterG.beds.map((b) => b.bed_code),
      released_bed: released[0] || null,
      payments_unchanged: paySame(beforeG, afterG),
      service_records_unchanged: svcSame(beforeG, afterG),
    };
    // fix the no_package_required logic - simplify in pass
    out.short_no_package_guest.hard_fail_package = gw.body && (
      gw.body.error === 'package_code is required' ||
      (Array.isArray(gw.body.invoice_preview && gw.body.invoice_preview.calculation_warnings) &&
        gw.body.invoice_preview.calculation_warnings.includes('package_code is required'))
    );
  } else {
    out.short_no_package_guest = { skipped: true, reason: 'no short no-package multi-bed booking' };
  }

  out.safety = {
    staging_only: true,
    no_stripe_in_ui: !/api\.stripe\.com/.test((await req('GET', '/staff/ui', null, cookie)).raw || ''),
  };

  out.pass = {
    revision_ok: out.revision.health === 'Healthy' && out.revision.traffic === 100 &&
      out.revision.image === IMAGE,
    date_save: out.date_save.status === 200 && out.date_save.success && out.date_save.updated &&
      out.date_save.db_check_in === dateTarget.check_in && out.date_save.db_check_out === dateTarget.check_out &&
      out.date_save.beds_match && out.date_save.no_bb_sql_error,
    date_conflict: out.date_conflict.can_apply === false && out.date_conflict.updated === false &&
      out.date_conflict.conflict_count > 0 && out.date_conflict.dates_unchanged,
    short_date: out.short_no_package_date.skipped ? null : (
      out.short_no_package_date.status === 200 && out.short_no_package_date.success &&
      out.short_no_package_date.package_still_null && !out.short_no_package_date.no_package_required_error
    ),
    short_guest: out.short_no_package_guest.skipped ? 'skipped' : (
      out.short_no_package_guest.status === 200 && out.short_no_package_guest.success &&
      out.short_no_package_guest.updated && out.short_no_package_guest.package_still_null &&
      !out.short_no_package_guest.hard_fail_package
    ),
  };

  const checks = [
    out.pass.revision_ok,
    out.pass.date_save,
    out.pass.date_conflict,
    out.short_no_package_date.skipped ? true : out.pass.short_date,
    out.short_no_package_guest.skipped ? true : out.pass.short_guest === true,
  ];
  out.result = checks.every(Boolean) ? 'PASS' : 'PARTIAL';

  await pg.end();
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
