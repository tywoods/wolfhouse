'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_CODE = 'MB-WOLFHO-20260920-4f62e2';

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

async function snap(pg) {
  const b = await pg.query(`
    SELECT b.id::text AS booking_id, b.booking_code, b.guest_name, b.phone, b.email,
           b.package_code, b.total_amount_cents, b.amount_paid_cents, b.balance_due_cents,
           b.check_in::text AS check_in, b.check_out::text AS check_out, b.guest_count
    FROM bookings b
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    LIMIT 1
  `, [CLIENT, BOOKING_CODE]);
  const beds = await pg.query(`
    SELECT bb.id::text AS booking_bed_id, bb.bed_code
    FROM booking_beds bb
    INNER JOIN bookings b ON b.id = bb.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    ORDER BY bb.bed_code
  `, [CLIENT, BOOKING_CODE]);
  const pays = await pg.query(`
    SELECT p.id::text AS payment_id, p.status::text AS status, p.amount_paid_cents
    FROM payments p
    INNER JOIN bookings b ON b.id = p.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    ORDER BY p.created_at
  `, [CLIENT, BOOKING_CODE]);
  let svc = [];
  try {
    svc = (await pg.query(
      'SELECT id::text, service_code, status FROM booking_service_records WHERE client_slug = $1 AND booking_code = $2',
      [CLIENT, BOOKING_CODE]
    )).rows;
  } catch (_) { svc = []; }
  return { booking: b.rows[0], beds: beds.rows, payments: pays.rows, service_records: svc };
}

(async () => {
  const out = {
    commit: '575d7cb',
    image: 'whstagingacr.azurecr.io/wh-staff-api:575d7cb-stage105c-edit-save-no-gate',
    acr_run: 'cb1y',
    revision: activeRevision(),
    gates: gateEnv(),
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

  const before = await snap(pg);
  out.before = before;

  const contactTarget = {
    guest_name: 'Edit Save NoGate Test',
    phone: '+34600999111',
    email: 'edit.save.nogate@example.com',
  };
  const cw = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    edit_type: 'contact',
    ...contactTarget,
    idempotency_key: 'phase-105c2-contact-' + Date.now(),
    reason: 'Phase 10.5c.2 contact save proof',
  }, cookie);
  out.contact_write = { status: cw.status, body: cw.body };
  const afterContact = await snap(pg);
  out.after_contact = afterContact;

  const pkg = String(before.booking.package_code || 'malibu').toLowerCase();
  const nextPkg = pkg === 'malibu' ? 'uluwatu' : (pkg === 'uluwatu' ? 'waimea' : 'malibu');
  const pw = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    edit_type: 'package',
    package_code: nextPkg,
    idempotency_key: 'phase-105c2-package-' + Date.now(),
    reason: 'Phase 10.5c.2 package save proof',
  }, cookie);
  out.package_write = { status: pw.status, body: pw.body, from: pkg, to: nextPkg };
  const afterPackage = await snap(pg);
  out.after_package = afterPackage;

  const clearPhone = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    edit_type: 'contact',
    phone: null,
    idempotency_key: 'phase-105c2-clear-phone-' + Date.now(),
    reason: 'Phase 10.5c.2 clear phone proof',
  }, cookie);
  out.clear_phone = { status: clearPhone.status, body: clearPhone.body };

  const datesW = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    edit_type: 'dates',
    check_in: '2026-09-24',
    check_out: '2026-09-27',
    idempotency_key: 'phase-105c2-dates-write',
    reason: 'dates write blocked',
  }, cookie);
  out.dates_write_blocked = { status: datesW.status, error: datesW.body && datesW.body.error };

  const guestsW = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    edit_type: 'guests',
    guest_count: 1,
    idempotency_key: 'phase-105c2-guests-write',
    reason: 'guests write blocked',
  }, cookie);
  out.guests_write_blocked = { status: guestsW.status, error: guestsW.body && guestsW.body.error };

  const datesP = await req('POST', '/staff/bookings/edit-preview?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    edit_type: 'dates',
    check_in: '2026-09-24',
    check_out: '2026-09-27',
  }, cookie);
  out.dates_preview = {
    status: datesP.status,
    preview_only: datesP.body && datesP.body.preview_only,
    would_mutate: datesP.body && datesP.body.would_mutate,
  };

  const guestsP = await req('POST', '/staff/bookings/edit-preview?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING_CODE,
    edit_type: 'guests',
    guest_count: 1,
  }, cookie);
  out.guests_preview = {
    status: guestsP.status,
    preview_only: guestsP.body && guestsP.body.preview_only,
  };

  const ctx = await req('GET', '/staff/bookings/' + BOOKING_CODE + '/context?client=' + CLIENT, null, cookie);
  out.context_after = ctx.body && ctx.body.booking ? {
    guest_name: ctx.body.booking.guest_name,
    phone: ctx.body.booking.phone,
    email: ctx.body.booking.email,
    package_code: ctx.body.booking.package_code,
    total_amount_cents: ctx.body.booking.total_amount_cents,
    balance_due_cents: ctx.body.booking.balance_due_cents,
  } : null;

  const ui = await req('GET', '/staff/ui', null, cookie);
  out.ui_embedded = {
    has_BC_BOOKING_EDIT_WRITE: /BC_BOOKING_EDIT_WRITE/.test(ui.raw || ''),
    has_disabled_hint: /Contact saving is disabled|Package saving is disabled/.test(ui.raw || ''),
    has_package_save: /bcFieldEditRunPackageSave/.test(ui.raw || ''),
    has_contact_save: /bcFieldEditRunContactSave/.test(ui.raw || ''),
    has_preview_only_copy: /Preview only/.test(ui.raw || ''),
  };

  out.safety = {
    beds_unchanged: JSON.stringify(before.beds) === JSON.stringify(afterPackage.beds),
    payments_unchanged: JSON.stringify(before.payments) === JSON.stringify(afterPackage.payments),
    service_records_unchanged: JSON.stringify(before.service_records) === JSON.stringify(afterPackage.service_records),
    check_in_out_unchanged: before.booking.check_in === afterPackage.booking.check_in &&
      before.booking.check_out === afterPackage.booking.check_out,
    guest_count_unchanged: Number(before.booking.guest_count) === Number(afterPackage.booking.guest_count),
  };

  out.pass = {
    revision_healthy: out.revision.health === 'Healthy' && out.revision.traffic === 100,
    image_correct: /575d7cb-stage105c-edit-save-no-gate/.test(out.revision.image),
    move_gate_not_true: out.gates.BOOKING_MOVE_WRITE_ENABLED !== 'true',
    contact_write_200: cw.status === 200 && cw.body.success && cw.body.updated,
    package_write_200: pw.status === 200 && pw.body.success && pw.body.updated,
    no_booking_edit_write_disabled: cw.body.error !== 'booking_edit_write_disabled' &&
      pw.body.error !== 'booking_edit_write_disabled',
    clear_phone_ok: clearPhone.status === 200 && clearPhone.body.success,
    dates_write_rejected: datesW.status === 400 && datesW.body.error === 'edit_type_not_supported_in_phase_10_5c',
    guests_write_rejected: guestsW.status === 400 && guestsW.body.error === 'edit_type_not_supported_in_phase_10_5c',
    dates_preview_only: datesP.body.preview_only === true && datesP.body.would_mutate === false,
    guests_preview_only: guestsP.body.preview_only === true,
    ui_no_gate: !out.ui_embedded.has_BC_BOOKING_EDIT_WRITE && !out.ui_embedded.has_disabled_hint,
    safety: Object.values(out.safety).every(Boolean),
  };

  out.result = Object.values(out.pass).every(Boolean) ? 'PASS' : 'PARTIAL';
  await pg.end();
  console.log(JSON.stringify(out, null, 2));
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
