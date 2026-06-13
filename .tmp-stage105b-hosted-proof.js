'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_CODE = 'MB-WOLFHO-20260920-4f62e2';

const CONTACT_TARGET = {
  guest_name: 'Contact Write Test',
  phone: '+34600111222',
  email: 'contact.write.test@example.com',
};

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
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
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

function gateEnv() {
  const app = JSON.parse(execSync(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' }
  ));
  const env = app.properties.template.containers[0].env || [];
  const pick = (n) => (env.find((e) => e.name === n) || {}).value;
  return {
    BOOKING_EDIT_WRITE_ENABLED: pick('BOOKING_EDIT_WRITE_ENABLED') ?? '(unset)',
    BOOKING_MOVE_WRITE_ENABLED: pick('BOOKING_MOVE_WRITE_ENABLED') ?? '(unset)',
  };
}

async function bookingSnapshot(pg) {
  const b = await pg.query(`
    SELECT b.id::text AS booking_id, b.booking_code, b.guest_name, b.phone, b.email,
           b.check_in::text AS check_in, b.check_out::text AS check_out,
           b.package_code, b.guest_count
    FROM bookings b
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    LIMIT 1
  `, [CLIENT, BOOKING_CODE]);
  const booking = b.rows[0];
  if (!booking) throw new Error('booking not found');
  const beds = await pg.query(`
    SELECT COUNT(*)::int AS n FROM booking_beds bb
    INNER JOIN bookings b ON b.id = bb.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
  `, [CLIENT, BOOKING_CODE]);
  const payments = await pg.query(`
    SELECT COUNT(*)::int AS n FROM payments p
    INNER JOIN bookings b ON b.id = p.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
  `, [CLIENT, BOOKING_CODE]);
  let svcCount = 0;
  try {
    const svc = await pg.query(
      'SELECT COUNT(*)::int AS n FROM booking_service_records WHERE client_slug = $1 AND booking_code = $2',
      [CLIENT, BOOKING_CODE]
    );
    svcCount = svc.rows[0].n;
  } catch (_) { svcCount = 0; }
  const bedRows = await pg.query(`
    SELECT bb.id::text AS booking_bed_id, bb.bed_code, bb.room_code,
           bb.assignment_start_date::text AS check_in, bb.assignment_end_date::text AS check_out
    FROM booking_beds bb
    INNER JOIN bookings b ON b.id = bb.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    ORDER BY bb.assignment_start_date, bb.bed_code
  `, [CLIENT, BOOKING_CODE]);
  return {
    booking,
    booking_beds_count: beds.rows[0].n,
    booking_beds: bedRows.rows,
    payments_count: payments.rows[0].n,
    service_records_count: svcCount,
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function editContact(cookie, payload) {
  return req('POST', '/staff/bookings/edit?client=' + CLIENT, payload, cookie);
}

function contactPayload(idemKey, reason) {
  return {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    edit_type: 'contact',
    ...CONTACT_TARGET,
    idempotency_key: idemKey,
    reason,
  };
}

function snapshotsEqual(a, b, keys) {
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

(async () => {
  const mode = process.argv[2] || 'gate-off';
  const summary = { mode, commit: 'ee18494', image: 'whstagingacr.azurecr.io/wh-staff-api:ee18494-stage105b-contact-write', acr_run: 'cb1x' };

  const loginRes = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  assert(loginRes.status === 200, 'login failed');
  const cookie = (loginRes.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  const pg = new Client({ connectionString: getStagingDbUrl(), ssl: { rejectUnauthorized: false } });
  await pg.connect();

  if (mode === 'gate-off') {
    summary.revision = activeRevision();
    summary.gates = gateEnv();
    summary.before = await bookingSnapshot(pg);
    const res = await editContact(cookie, contactPayload(
      'phase-10-5b-gate-off-contact-proof',
      'Phase 10.5b gate off proof'
    ));
    summary.gate_off = { status: res.status, body: res.body };
    const after = await bookingSnapshot(pg);
    summary.after_contact_unchanged = snapshotsEqual(summary.before.booking, after.booking,
      ['guest_name', 'phone', 'email', 'check_in', 'check_out', 'package_code', 'guest_count']);
    summary.after_counts_unchanged =
      summary.before.booking_beds_count === after.booking_beds_count &&
      summary.before.payments_count === after.payments_count &&
      summary.before.service_records_count === after.service_records_count &&
      JSON.stringify(summary.before.booking_beds) === JSON.stringify(after.booking_beds);
    assert(res.status === 403, 'gate off expected 403 got ' + res.status);
    assert(res.body.error === 'booking_edit_write_disabled', 'gate off error');
    assert(res.body.updated === false && res.body.would_mutate === false, 'gate off flags');
    assert(summary.after_contact_unchanged, 'contact changed while gate off');
    summary.result = 'PASS';
  }

  if (mode === 'gate-on') {
    summary.revision = activeRevision();
    summary.gates = gateEnv();
    const before = await bookingSnapshot(pg);
    summary.before = before;
    const writeRes = await editContact(cookie, contactPayload(
      'phase-10-5b-contact-write-proof',
      'Phase 10.5b contact write proof'
    ));
    summary.contact_write = { status: writeRes.status, body: writeRes.body };
    const afterWrite = await bookingSnapshot(pg);
    summary.after_write = afterWrite;
    assert(writeRes.status === 200, 'write status');
    assert(writeRes.body.success === true && writeRes.body.updated === true, 'updated');
    assert(writeRes.body.edit_type === 'contact', 'edit_type');
    assert(writeRes.body.before && writeRes.body.after, 'before/after');
    assert(writeRes.body.after.guest_name === CONTACT_TARGET.guest_name, 'guest_name after');
    assert(writeRes.body.after.phone === CONTACT_TARGET.phone, 'phone after');
    assert(writeRes.body.after.email === CONTACT_TARGET.email, 'email after');
    assert(writeRes.body.invoice_impact.payment_mutation === false, 'payment_mutation');
    assert(writeRes.body.invoice_impact.stripe_mutation === false, 'stripe_mutation');
    assert(/No payment, bed, service, Stripe, n8n, or WhatsApp/.test(writeRes.body.message || ''), 'message');
    assert(afterWrite.booking.guest_name === CONTACT_TARGET.guest_name, 'db guest_name');
    assert(afterWrite.booking.phone === CONTACT_TARGET.phone, 'db phone');
    assert(afterWrite.booking.email === CONTACT_TARGET.email, 'db email');
    assert(before.booking.check_in === afterWrite.booking.check_in, 'check_in unchanged');
    assert(before.booking.check_out === afterWrite.booking.check_out, 'check_out unchanged');
    assert(before.booking.package_code === afterWrite.booking.package_code, 'package unchanged');
    assert(Number(before.booking.guest_count) === Number(afterWrite.booking.guest_count), 'guest_count unchanged');
    assert(before.booking_beds_count === afterWrite.booking_beds_count, 'beds count');
    assert(before.payments_count === afterWrite.payments_count, 'payments count');
    assert(before.service_records_count === afterWrite.service_records_count, 'svc count');
    assert(JSON.stringify(before.booking_beds) === JSON.stringify(afterWrite.booking_beds), 'bed assignments');

    const idemRes = await editContact(cookie, contactPayload(
      'phase-10-5b-contact-write-proof',
      'Phase 10.5b idempotency proof'
    ));
    summary.idempotency = { status: idemRes.status, body: idemRes.body };
    const afterIdem = await bookingSnapshot(pg);
    assert(idemRes.status === 200 && idemRes.body.idempotent === true && idemRes.body.updated === false, 'idempotent');
    assert(/already match/.test(idemRes.body.message || ''), 'idempotent message');
    assert(JSON.stringify(afterWrite.booking) === JSON.stringify(afterIdem.booking), 'extra mutation on idempotent');

    const datesRes = await editContact(cookie, {
      client_slug: CLIENT,
      booking_code: BOOKING_CODE,
      edit_type: 'dates',
      check_in: '2026-09-24',
      check_out: '2026-09-27',
      idempotency_key: 'phase-10-5b-unsupported-dates',
      reason: 'unsupported type proof',
    });
    summary.unsupported_dates = { status: datesRes.status, body: datesRes.body };
    const afterUnsupported = await bookingSnapshot(pg);
    assert(datesRes.status === 400 && datesRes.body.error === 'edit_type_not_supported_in_phase_10_5b', 'dates blocked');
    assert(JSON.stringify(afterWrite.booking) === JSON.stringify(afterUnsupported.booking), 'dates attempt mutated contact');

    summary.restore_original = before.booking;
    summary.result = 'PASS';
  }

  if (mode === 'restore') {
    summary.revision = activeRevision();
    summary.gates = gateEnv();
    const fs = require('fs');
    const path = require('path');
    const restorePath = path.join(__dirname, '.tmp-stage105b-restore-original.json');
    const original = process.argv[3]
      ? JSON.parse(process.argv[3])
      : JSON.parse(fs.readFileSync(restorePath, 'utf8'));
    assert(original.guest_name, 'restore needs original contact JSON');
    const restoreBody = {
      client_slug: CLIENT,
      booking_code: BOOKING_CODE,
      edit_type: 'contact',
      guest_name: original.guest_name,
      idempotency_key: 'phase-10-5b-restore-contact-' + Date.now(),
      reason: 'Phase 10.5b restore original contact',
    };
    if (original.phone != null) restoreBody.phone = original.phone;
    if (original.email != null) restoreBody.email = original.email;
    const res = await editContact(cookie, restoreBody);
    summary.restore = { status: res.status, body: res.body };
    summary.after = await bookingSnapshot(pg);
    assert(res.status === 200 && res.body.success === true,
      'restore write status=' + res.status + ' body=' + JSON.stringify(res.body));
    summary.result = 'PASS';
  }

  if (mode === 'gate-off-after') {
    summary.revision = activeRevision();
    summary.gates = gateEnv();
    const before = await bookingSnapshot(pg);
    const res = await editContact(cookie, contactPayload(
      'phase-10-5b-gate-off-after-cleanup',
      'Phase 10.5b blocked after cleanup'
    ));
    summary.blocked = { status: res.status, body: res.body };
    const after = await bookingSnapshot(pg);
    assert(res.status === 403 && res.body.error === 'booking_edit_write_disabled', 'blocked after cleanup');
    assert(JSON.stringify(before.booking) === JSON.stringify(after.booking), 'mutation after gate off');
    summary.result = 'PASS';
  }

  await pg.end();
  console.log(JSON.stringify(summary, null, 2));
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
