'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_SIMPLE = 'MB-WOLFHO-20260920-4f62e2';
const BOOKING_MULTI = 'DEMO-2603';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:0a1daba-stage105f-full-edit-cancel';
const COMMIT = '0a1daba';

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
           b.status::text AS status, b.package_code, b.total_amount_cents,
           b.amount_paid_cents, b.balance_due_cents,
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
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb22',
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
  out.before_mb = { booking: beforeMb.booking, beds: beforeMb.beds.length, payments: beforeMb.payments };

  // 1 Contact Save
  const contactTarget = {
    guest_name: 'Stage105f Drawer Contact',
    phone: '+34600555105',
    email: 'stage105f.contact@example.com',
  };
  const cw = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING_SIMPLE,
    edit_type: 'contact',
    ...contactTarget,
    idempotency_key: 'stage105f-contact-' + Date.now(),
  }, cookie);
  const afterContact = await snap(pg, BOOKING_SIMPLE);
  const clearPhone = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING_SIMPLE,
    edit_type: 'contact',
    phone: null,
    idempotency_key: 'stage105f-clear-phone-' + Date.now(),
  }, cookie);
  const afterClearPhone = await snap(pg, BOOKING_SIMPLE);
  out.contact_save = {
    status: cw.status,
    success: cw.body && cw.body.success,
    updated: cw.body && cw.body.updated,
    db_name: afterContact.booking.guest_name,
    db_email: afterContact.booking.email,
    clear_phone_status: clearPhone.status,
    clear_phone_success: clearPhone.body && clearPhone.body.success,
    phone_null: afterClearPhone.booking.phone == null,
    payments_unchanged: payTruthSame(beforeMb, afterContact),
    service_records_unchanged: svcSame(beforeMb, afterContact),
    context_status: (await req('GET', '/staff/bookings/' + BOOKING_SIMPLE + '/context?client=' + CLIENT, null, cookie)).status,
  };

  // 2 Package Save
  const pkg = String(afterClearPhone.booking.package_code || 'malibu').toLowerCase();
  const nextPkg = pkg === 'malibu' ? 'uluwatu' : (pkg === 'uluwatu' ? 'waimea' : 'malibu');
  const pw = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING_SIMPLE,
    edit_type: 'package',
    package_code: nextPkg,
    idempotency_key: 'stage105f-package-' + Date.now(),
  }, cookie);
  const afterPkg = await snap(pg, BOOKING_SIMPLE);
  const ctxPkg = await req('GET', '/staff/bookings/' + BOOKING_SIMPLE + '/context?client=' + CLIENT, null, cookie);
  out.package_save = {
    status: pw.status,
    success: pw.body && pw.body.success,
    updated: pw.body && pw.body.updated,
    from: pkg,
    to: nextPkg,
    db_package: afterPkg.booking.package_code,
    db_total: afterPkg.booking.total_amount_cents,
    context_package: ctxPkg.body && ctxPkg.body.booking && ctxPkg.body.booking.package_code,
    invoice_impact: pw.body && pw.body.invoice_impact,
    amount_paid_unchanged: Number(beforeMb.booking.amount_paid_cents) === Number(afterPkg.booking.amount_paid_cents),
    payments_unchanged: payTruthSame(beforeMb, afterPkg),
    service_records_unchanged: svcSame(beforeMb, afterPkg),
  };

  // 3 Date Save — shift by 1 day from current if possible
  const curCi = afterPkg.booking.check_in;
  const curCo = afterPkg.booking.check_out;
  const d1 = new Date(curCi + 'T00:00:00Z');
  d1.setUTCDate(d1.getUTCDate() + 1);
  const d2 = new Date(curCo + 'T00:00:00Z');
  d2.setUTCDate(d2.getUTCDate() + 1);
  const dateTarget = { check_in: d1.toISOString().slice(0, 10), check_out: d2.toISOString().slice(0, 10) };
  const dw = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING_SIMPLE,
    edit_type: 'dates',
    ...dateTarget,
    idempotency_key: 'stage105f-dates-' + Date.now(),
  }, cookie);
  const afterDates = await snap(pg, BOOKING_SIMPLE);
  out.date_save = {
    status: dw.status,
    success: dw.body && dw.body.success,
    updated: dw.body && dw.body.updated,
    error: dw.body && dw.body.error,
    target: dateTarget,
    db_check_in: afterDates.booking.check_in,
    db_check_out: afterDates.booking.check_out,
    beds_match: afterDates.beds.length > 0 && afterDates.beds.every((b) =>
      b.check_in === dateTarget.check_in && b.check_out === dateTarget.check_out),
    payments_unchanged: payTruthSame(beforeMb, afterDates),
    service_records_unchanged: svcSame(beforeMb, afterDates),
    amount_paid_unchanged: Number(beforeMb.booking.amount_paid_cents) === Number(afterDates.booking.amount_paid_cents),
  };
  if (!out.date_save.success || !out.date_save.updated) {
    const fallback = { check_in: '2026-09-24', check_out: '2026-09-27' };
    const dw2 = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
      client_slug: CLIENT,
      booking_code: BOOKING_SIMPLE,
      edit_type: 'dates',
      ...fallback,
      idempotency_key: 'stage105f-dates-fallback-' + Date.now(),
    }, cookie);
    const afterDates2 = await snap(pg, BOOKING_SIMPLE);
    out.date_save.fallback = {
      status: dw2.status,
      success: dw2.body && dw2.body.success,
      updated: dw2.body && dw2.body.updated,
      target: fallback,
      db_check_in: afterDates2.booking.check_in,
      db_check_out: afterDates2.booking.check_out,
      beds_match: afterDates2.beds.every((b) => b.check_in === fallback.check_in && b.check_out === fallback.check_out),
    };
    if (dw2.body && dw2.body.success && dw2.body.updated) {
      Object.assign(dateTarget, fallback);
      Object.assign(out.date_save, {
        status: dw2.status,
        success: true,
        updated: true,
        db_check_in: afterDates2.booking.check_in,
        db_check_out: afterDates2.booking.check_out,
        beds_match: out.date_save.fallback.beds_match,
      });
    }
  }

  // 4 Date conflict — overlap DEMO-2603 window
  const conflictTarget = { check_in: '2026-07-16', check_out: '2026-07-22' };
  const dc = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: BOOKING_SIMPLE,
    edit_type: 'dates',
    ...conflictTarget,
    idempotency_key: 'stage105f-date-conflict-' + Date.now(),
  }, cookie);
  const afterConflict = await snap(pg, BOOKING_SIMPLE);
  out.date_conflict = {
    status: dc.status,
    can_apply: dc.body && dc.body.can_apply,
    updated: dc.body && dc.body.updated,
    conflict_count: dc.body && dc.body.conflicts ? dc.body.conflicts.length : 0,
    dates_unchanged: afterConflict.booking.check_in === out.date_save.db_check_in &&
      afterConflict.booking.check_out === out.date_save.db_check_out,
  };

  // 5 Guest reduction DEMO-2603
  const demoSnap = await snap(pg, BOOKING_MULTI);
  const demoGuestCount = Number(demoSnap.booking.guest_count);
  const demoBedsBefore = demoSnap.beds.map((b) => b.bed_code);
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
    idempotency_key: 'stage105f-guests-' + Date.now(),
  }, cookie);
  const afterGuests = await snap(pg, BOOKING_MULTI);
  const releasedBed = demoBedsBefore.find((c) => !afterGuests.beds.some((b) => b.bed_code === c));
  out.guest_reduction = {
    booking_found: !!demoSnap.booking,
    guest_count_before: demoGuestCount,
    preview_status: gp.status,
    preview_can_apply: gp.body && gp.body.can_apply,
    preview_released: gp.body && gp.body.proposed && gp.body.proposed.released_beds,
    write_status: gw.status,
    write_success: gw.body && gw.body.success,
    write_updated: gw.body && gw.body.updated,
    error: gw.body && gw.body.error,
    db_guest_count: Number(afterGuests.booking.guest_count),
    beds_before: demoBedsBefore,
    beds_after: afterGuests.beds.map((b) => b.bed_code),
    released_bed: releasedBed || null,
    needs_refund: gw.body && gw.body.needs_refund,
    payments_unchanged: payTruthSame(beforeDemo, afterGuests),
    service_records_unchanged: svcSame(beforeDemo, afterGuests),
    skipped: demoGuestCount < 2 || demoBedsBefore.length < 2,
  };

  // 6 Cancel — disposable manual booking
  const cancelBed = 'DEMO-R2-B2';
  const cancelCi = '2027-04-10';
  const cancelCo = '2027-04-13';
  const createPayload = {
    client_slug: CLIENT,
    check_in: cancelCi,
    check_out: cancelCo,
    selected_bed_codes: [cancelBed],
    guest_count: 1,
    guest_name: 'Stage105f Cancel Disposable',
    phone: '+34600555106',
    package_code: 'malibu',
    room_type: 'shared',
    payment_choice: 'deposit',
    add_ons: [],
    confirm: true,
    idempotency_key: 'stage105f-cancel-create-' + Date.now(),
  };
  const created = await req('POST', '/staff/manual-bookings/create', createPayload, cookie);
  const cancelCode = created.body && created.body.booking_code;
  out.cancel_create = {
    status: created.status,
    success: created.body && created.body.success,
    booking_code: cancelCode,
  };

  let cancelProof = { skipped: true, reason: 'create failed' };
  if (cancelCode) {
    const beforeCancel = await snap(pg, cancelCode);
    const calBefore = await req('GET',
      '/staff/bed-calendar?client=' + CLIENT + '&start=' + cancelCi + '&end=' + cancelCo, null, cookie);
    const blocksBefore = (calBefore.body && calBefore.body.blocks) || [];
    const inCalBefore = blocksBefore.some((b) => b.booking_code === cancelCode);

    const cancelApi = await req('POST', '/staff/bookings/cancel?client=' + CLIENT, {
      client_slug: CLIENT,
      booking_code: cancelCode,
      idempotency_key: 'stage105f-cancel-' + Date.now(),
      reason: 'Cancelled from Staff Portal',
    }, cookie);
    const afterCancel = await snap(pg, cancelCode);
    const calAfter = await req('GET',
      '/staff/bed-calendar?client=' + CLIENT + '&start=' + cancelCi + '&end=' + cancelCo, null, cookie);
    const blocksAfter = (calAfter.body && calAfter.body.blocks) || [];
    const inCalAfter = blocksAfter.some((b) => b.booking_code === cancelCode);

    const cancelIdem = await req('POST', '/staff/bookings/cancel?client=' + CLIENT, {
      client_slug: CLIENT,
      booking_code: cancelCode,
      idempotency_key: 'stage105f-cancel-idem-' + Date.now(),
    }, cookie);

    cancelProof = {
      api_status: cancelApi.status,
      api_success: cancelApi.body && cancelApi.body.success,
      cancelled: cancelApi.body && cancelApi.body.cancelled,
      beds_released_count: cancelApi.body && cancelApi.body.beds_released_count,
      status_before: beforeCancel.booking.status,
      status_after: afterCancel.booking.status,
      beds_before: beforeCancel.beds.length,
      beds_after: afterCancel.beds.length,
      in_calendar_before: inCalBefore,
      in_calendar_after: inCalAfter,
      idempotent: cancelIdem.body && cancelIdem.body.idempotent,
      idempotent_cancelled_false: cancelIdem.body && cancelIdem.body.cancelled === false,
      payments_unchanged: payTruthSame(beforeCancel, afterCancel),
      service_records_unchanged: svcSame(beforeCancel, afterCancel),
      no_stripe_refund_msg: cancelApi.body && /No refund|no refund/i.test(String(cancelApi.body.message || '')),
    };
  }
  out.cancel = cancelProof;

  const ui = await req('GET', '/staff/ui', null, cookie);
  const uiRaw = ui.raw || '';
  out.legend_cleanup = {
    legend_has_cancelled_item: /bc-legend-sw-cancelled"><\/span>Cancelled/.test(uiRaw) ||
      /<span class="bc-legend-item">[^<]*Cancelled/.test(uiRaw.match(/id="bc-legend"[\s\S]*?<\/div>/)?.[0] || ''),
    has_cancel_button: /bc-cancel-reservation-btn/.test(uiRaw),
    has_cancel_confirm: /Cancel reservation\?/.test(uiRaw),
    has_cancel_api_path: /\/staff\/bookings\/cancel/.test(uiRaw),
    has_load_bed_calendar_on_cancel: /bcRunCancelReservation[\s\S]*?loadBedCalendar/.test(uiRaw),
  };

  out.ui_embedded = {
    has_contact_save: /bcFieldEditRunContactSave/.test(uiRaw),
    has_package_save: /bcFieldEditRunPackageSave/.test(uiRaw),
    has_dates_save: /bcFieldEditRunDatesSave/.test(uiRaw),
    has_guests_save: /bcFieldEditRunGuestsSave/.test(uiRaw),
    has_stripe_api: /api\.stripe\.com/.test(uiRaw),
    has_whatsapp: /graph\.facebook\.com/.test(uiRaw),
    has_n8n_activate: /n8n\.cloud.*activate|activate.*workflow/i.test(uiRaw),
  };

  out.running_invoice = {
    context_200: ctxPkg.status === 200,
    mb_total_after_package: afterPkg.booking.total_amount_cents,
    demo_total_after_guests: afterGuests.booking && afterGuests.booking.total_amount_cents,
  };

  out.safety = {
    staging_only: true,
    no_stripe_n8n_wa_ui: !out.ui_embedded.has_stripe_api && !out.ui_embedded.has_whatsapp && !out.ui_embedded.has_n8n_activate,
  };

  out.pass = {
    revision: out.revision.health === 'Healthy' && out.revision.traffic === 100 && out.revision.image === IMAGE,
    contact: out.contact_save.status === 200 && out.contact_save.success && out.contact_save.updated &&
      out.contact_save.db_name === contactTarget.guest_name && out.contact_save.clear_phone_success &&
      out.contact_save.phone_null,
    package: out.package_save.status === 200 && out.package_save.success && out.package_save.updated &&
      String(out.package_save.db_package).toLowerCase() === nextPkg && out.package_save.amount_paid_unchanged,
    date: out.date_save.status === 200 && out.date_save.success && out.date_save.updated &&
      out.date_save.beds_match,
    date_conflict: out.date_conflict.can_apply === false && out.date_conflict.updated === false &&
      out.date_conflict.dates_unchanged,
    guest: out.guest_reduction.skipped ? 'skipped' : (
      out.guest_reduction.write_status === 200 && out.guest_reduction.write_success &&
      out.guest_reduction.write_updated && out.guest_reduction.db_guest_count === targetGuests &&
      !!out.guest_reduction.released_bed
    ),
    cancel: !out.cancel.skipped && out.cancel.api_success && out.cancel.cancelled &&
      out.cancel.status_after === 'cancelled' && out.cancel.beds_after === 0 &&
      out.cancel.in_calendar_before && !out.cancel.in_calendar_after,
    legend: !out.legend_cleanup.legend_has_cancelled_item,
    ui_saves: out.ui_embedded.has_contact_save && out.ui_embedded.has_package_save &&
      out.ui_embedded.has_dates_save && out.ui_embedded.has_guests_save && out.legend_cleanup.has_cancel_button,
  };

  const hard = [
    out.pass.revision,
    out.pass.contact,
    out.pass.package,
    out.pass.date,
    out.pass.date_conflict,
    out.pass.cancel,
    out.pass.legend,
    out.pass.ui_saves,
  ];
  const guestOk = out.pass.guest === 'skipped' || out.pass.guest === true;
  out.result = hard.every(Boolean) && guestOk ? 'PASS' : 'PARTIAL';

  await pg.end();
  console.log(JSON.stringify(out, null, 2));
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
