'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_SIMPLE = 'MB-WOLFHO-20260920-4f62e2';
const BOOKING_MULTI = 'DEMO-2603';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:d948a2d-stage105e-full-booking-edit';

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

async function snap(pg, bookingCode) {
  const b = await pg.query(`
    SELECT b.id::text AS booking_id, b.booking_code, b.guest_name, b.phone, b.email,
           b.package_code, b.total_amount_cents, b.amount_paid_cents, b.balance_due_cents,
           b.check_in::text AS check_in, b.check_out::text AS check_out, b.guest_count
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
    SELECT p.id::text AS payment_id, p.status::text AS status, p.amount_paid_cents
    FROM payments p
    INNER JOIN bookings b ON b.id = p.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    ORDER BY p.created_at
  `, [CLIENT, bookingCode]);
  let svc = [];
  try {
    svc = (await pg.query(
      'SELECT id::text, service_code, status, amount_due_cents FROM booking_service_records WHERE client_slug = $1 AND booking_code = $2 ORDER BY created_at',
      [CLIENT, bookingCode]
    )).rows;
  } catch (_) { svc = []; }
  return { booking: b.rows[0], beds: beds.rows, payments: pays.rows, service_records: svc };
}

function payTruthSame(a, b) {
  return JSON.stringify(a.payments) === JSON.stringify(b.payments)
    && Number(a.booking.amount_paid_cents) === Number(b.booking.amount_paid_cents);
}

function svcSame(a, b) {
  return JSON.stringify(a.service_records) === JSON.stringify(b.service_records);
}

(async () => {
  const out = {
    commit: 'd948a2d',
    image: IMAGE,
    acr_run: 'cb20',
    revision: activeRevision(),
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

  const beforeMb = await snap(pg, BOOKING_SIMPLE);
  const beforeDemo = await snap(pg, BOOKING_MULTI);
  out.before_mb = beforeMb;
  out.before_demo = beforeDemo;

  // 1 Contact Save (MB)
  const contactTarget = {
    guest_name: 'Full Edit Drawer Test',
    phone: '+34600999888',
    email: 'full.edit.drawer@example.com',
  };
  const cw = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING_SIMPLE,
    edit_type: 'contact',
    ...contactTarget,
    idempotency_key: 'stage105e-contact-' + Date.now(),
    reason: '10.5e full drawer contact proof',
  }, cookie);
  const afterContactMb = await snap(pg, BOOKING_SIMPLE);
  out.contact_save = {
    status: cw.status,
    success: cw.body && cw.body.success,
    updated: cw.body && cw.body.updated,
    booking: cw.body && cw.body.booking,
    db: {
      guest_name: afterContactMb.booking.guest_name,
      phone: afterContactMb.booking.phone,
      email: afterContactMb.booking.email,
    },
    payments_unchanged: payTruthSame(beforeMb, afterContactMb),
    service_records_unchanged: svcSame(beforeMb, afterContactMb),
  };

  const clearPhone = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING_SIMPLE,
    edit_type: 'contact',
    phone: null,
    idempotency_key: 'stage105e-clear-phone-' + Date.now(),
  }, cookie);
  const afterClearPhone = await snap(pg, BOOKING_SIMPLE);
  out.contact_clear_phone = {
    status: clearPhone.status,
    success: clearPhone.body && clearPhone.body.success,
    phone_null: afterClearPhone.booking.phone == null,
  };

  // 2 Package Save (MB)
  const pkg = String(afterClearPhone.booking.package_code || 'malibu').toLowerCase();
  const nextPkg = pkg === 'malibu' ? 'uluwatu' : (pkg === 'uluwatu' ? 'waimea' : 'malibu');
  const pw = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING_SIMPLE,
    edit_type: 'package',
    package_code: nextPkg,
    idempotency_key: 'stage105e-package-' + Date.now(),
  }, cookie);
  const afterPackageMb = await snap(pg, BOOKING_SIMPLE);
  const ctxPkg = await req('GET', '/staff/bookings/' + BOOKING_SIMPLE + '/context?client=' + CLIENT, null, cookie);
  out.package_save = {
    status: pw.status,
    success: pw.body && pw.body.success,
    updated: pw.body && pw.body.updated,
    from: pkg,
    to: nextPkg,
    db_package: afterPackageMb.booking.package_code,
    db_total: afterPackageMb.booking.total_amount_cents,
    context_package: ctxPkg.body && ctxPkg.body.booking && ctxPkg.body.booking.package_code,
    invoice_impact: pw.body && pw.body.invoice_impact,
    payments_unchanged: payTruthSame(beforeMb, afterPackageMb),
    service_records_unchanged: svcSame(beforeMb, afterPackageMb),
    amount_paid_unchanged: Number(beforeMb.booking.amount_paid_cents) === Number(afterPackageMb.booking.amount_paid_cents),
  };

  // 3 Date Save (MB) — allowed range from prior proofs
  const dateTarget = { check_in: '2026-09-24', check_out: '2026-09-27' };
  const dw = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING_SIMPLE,
    edit_type: 'dates',
    ...dateTarget,
    idempotency_key: 'stage105e-dates-' + Date.now(),
  }, cookie);
  const afterDatesMb = await snap(pg, BOOKING_SIMPLE);
  out.date_save = {
    status: dw.status,
    success: dw.body && dw.body.success,
    updated: dw.body && dw.body.updated,
    can_apply: dw.body && dw.body.can_apply,
    db_check_in: afterDatesMb.booking.check_in,
    db_check_out: afterDatesMb.booking.check_out,
    bed_dates: afterDatesMb.beds.map((b) => ({ bed_code: b.bed_code, check_in: b.check_in, check_out: b.check_out })),
    beds_match_stay: afterDatesMb.beds.every((b) => b.check_in === dateTarget.check_in && b.check_out === dateTarget.check_out),
    payments_unchanged: payTruthSame(beforeMb, afterDatesMb),
    service_records_unchanged: svcSame(beforeMb, afterDatesMb),
    amount_paid_unchanged: Number(beforeMb.booking.amount_paid_cents) === Number(afterDatesMb.booking.amount_paid_cents),
  };

  // 4 Date conflict — overlap another stay on same bed if possible
  const conflictTarget = { check_in: '2026-07-16', check_out: '2026-07-22' };
  const dc = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING_SIMPLE,
    edit_type: 'dates',
    ...conflictTarget,
    idempotency_key: 'stage105e-dates-conflict-' + Date.now(),
  }, cookie);
  const afterConflictMb = await snap(pg, BOOKING_SIMPLE);
  out.date_conflict = {
    status: dc.status,
    can_apply: dc.body && dc.body.can_apply,
    updated: dc.body && dc.body.updated,
    conflict_count: dc.body && dc.body.conflicts ? dc.body.conflicts.length : 0,
    dates_unchanged_after_block: afterConflictMb.booking.check_in === afterDatesMb.booking.check_in &&
      afterConflictMb.booking.check_out === afterDatesMb.booking.check_out,
    skipped: false,
  };
  if (dc.body && dc.body.updated === true) {
    out.date_conflict.skipped = true;
    out.date_conflict.note = 'unexpected apply on overlap range';
  }

  // 5 Guest reduction DEMO-2603
  const demoGuestCount = Number(beforeDemo.booking.guest_count);
  const demoBedsBefore = beforeDemo.beds.map((b) => b.bed_code);
  const targetGuests = Math.max(1, demoGuestCount - 1);
  const gp = await req('POST', '/staff/bookings/edit-preview?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING_MULTI,
    edit_type: 'guests',
    guest_count: targetGuests,
  }, cookie);
  const gw = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING_MULTI,
    edit_type: 'guests',
    guest_count: targetGuests,
    idempotency_key: 'stage105e-guests-' + Date.now(),
  }, cookie);
  const afterGuestsDemo = await snap(pg, BOOKING_MULTI);
  const ctxGuest = await req('GET', '/staff/bookings/' + BOOKING_MULTI + '/context?client=' + CLIENT, null, cookie);
  const releasedBed = demoBedsBefore.length > afterGuestsDemo.beds.length
    ? demoBedsBefore.find((c) => !afterGuestsDemo.beds.some((b) => b.bed_code === c))
    : null;
  out.guest_reduction = {
    preview_status: gp.status,
    preview_can_apply: gp.body && gp.body.can_apply,
    preview_released: gp.body && gp.body.proposed && gp.body.proposed.released_beds,
    write_status: gw.status,
    write_success: gw.body && gw.body.success,
    write_updated: gw.body && gw.body.updated,
    bed_release: gw.body && gw.body.bed_release,
    needs_refund: gw.body && gw.body.needs_refund,
    refund_review_needed: gw.body && gw.body.refund_review_needed,
    db_guest_count: Number(afterGuestsDemo.booking.guest_count),
    beds_before: demoBedsBefore,
    beds_after: afterGuestsDemo.beds.map((b) => b.bed_code),
    released_bed: releasedBed,
    remaining_unchanged: afterGuestsDemo.beds.length >= 1 &&
      demoBedsBefore.filter((c) => c !== releasedBed).every((c) => afterGuestsDemo.beds.some((b) => b.bed_code === c)),
    context_guest_count: ctxGuest.body && ctxGuest.body.booking && ctxGuest.body.booking.guest_count,
    payments_unchanged: payTruthSame(beforeDemo, afterGuestsDemo),
    service_records_unchanged: svcSame(beforeDemo, afterGuestsDemo),
    amount_paid_unchanged: Number(beforeDemo.booking.amount_paid_cents) === Number(afterGuestsDemo.booking.amount_paid_cents),
  };

  const ui = await req('GET', '/staff/ui', null, cookie);
  out.ui_embedded = {
    has_contact_save: /bcFieldEditRunContactSave/.test(ui.raw || ''),
    has_package_save: /bcFieldEditRunPackageSave/.test(ui.raw || ''),
    has_dates_save: /bcFieldEditRunDatesSave/.test(ui.raw || ''),
    has_guests_save: /bcFieldEditRunGuestsSave/.test(ui.raw || ''),
    has_guests_save_btn: /data-bc-field-guests-save/.test(ui.raw || ''),
    has_stripe_api: /api\.stripe\.com/.test(ui.raw || ''),
    has_whatsapp: /graph\.facebook\.com/.test(ui.raw || ''),
    has_n8n_activate: /n8n\.cloud.*activate|activate.*workflow/i.test(ui.raw || ''),
  };

  out.running_invoice = {
    context_has_invoice_html: ctxGuest.body && typeof ctxGuest.body === 'object',
    mb_total_after_package: afterPackageMb.booking.total_amount_cents,
    demo_total_after_guests: afterGuestsDemo.booking.total_amount_cents,
    demo_balance_after_guests: afterGuestsDemo.booking.balance_due_cents,
  };

  out.pass = {
    revision_healthy_100: out.revision.health === 'Healthy' && out.revision.traffic === 100,
    image_correct: out.revision.image === IMAGE,
    contact_save: out.contact_save.status === 200 && out.contact_save.success && out.contact_save.updated,
    contact_db: out.contact_save.db.guest_name === contactTarget.guest_name &&
      out.contact_save.db.email === contactTarget.email,
    clear_phone: out.contact_clear_phone.success && out.contact_clear_phone.phone_null,
    package_save: out.package_save.status === 200 && out.package_save.success && out.package_save.updated,
    package_db: String(out.package_save.db_package).toLowerCase() === nextPkg,
    package_paid_truth: out.package_save.amount_paid_unchanged && out.package_save.payments_unchanged,
    date_save: out.date_save.status === 200 && out.date_save.success && out.date_save.updated,
    date_db: out.date_save.db_check_in === dateTarget.check_in && out.date_save.db_check_out === dateTarget.check_out,
    date_beds: out.date_save.beds_match_stay,
    date_conflict: out.date_conflict.can_apply === false && out.date_conflict.updated === false &&
      out.date_conflict.dates_unchanged_after_block,
    guest_write: out.guest_reduction.write_status === 200 && out.guest_reduction.write_success &&
      out.guest_reduction.write_updated,
    guest_db: out.guest_reduction.db_guest_count === targetGuests &&
      out.guest_reduction.beds_after.length === targetGuests,
    guest_release: !!out.guest_reduction.released_bed,
    guest_safety: out.guest_reduction.payments_unchanged && out.guest_reduction.service_records_unchanged &&
      out.guest_reduction.amount_paid_unchanged,
    ui_saves: out.ui_embedded.has_contact_save && out.ui_embedded.has_package_save &&
      out.ui_embedded.has_dates_save && out.ui_embedded.has_guests_save,
    no_stripe_n8n_wa_in_ui: !out.ui_embedded.has_stripe_api && !out.ui_embedded.has_whatsapp && !out.ui_embedded.has_n8n_activate,
  };

  out.result = Object.values(out.pass).every(Boolean) ? 'PASS' : 'PARTIAL';
  await pg.end();
  console.log(JSON.stringify(out, null, 2));
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
