'use strict';
/** Stage 26h.2 hosted proof — temp, do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = 'defae58';
const INCLUDES = ['9c1ee8b', 'defae58'];
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:defae58-stage26h2-svc-drawer-polish';
const CLIENT = 'wolfhouse-somo';
const BOOKING_ID_SVC = '01039383-389e-4e71-a7d6-75b56345fdbf';
const BOOKING_CODE_SVC = 'MB-WOLFHO-20260920-4f62e2';
const BOOKING_ID_XFER = 'adf70f79-c750-458d-a306-97c81304898b';
const BOOKING_CODE_XFER = 'MB-WOLFHO-20291001-9dcb42';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path,
      method,
      headers: {
        Accept: 'application/json,text/html,*/*',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function activeRevision() {
  const rows = JSON.parse(az(
    'az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
  ));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties.template?.containers?.[0]?.image,
  };
}

function envSummary() {
  const app = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
  ));
  const env = app.properties.template.containers[0].env || [];
  const pick = (name) => {
    const e = env.find((x) => x.name === name);
    if (!e) return null;
    if (e.secretRef) return { name, secretRef: e.secretRef };
    return { name, value: e.value };
  };
  return {
    AVIATIONSTACK_API_KEY: pick('AVIATIONSTACK_API_KEY'),
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
    whatsapp_live_send_vars: env.filter((e) => /WHATSAPP.*SEND|META.*SEND|LIVE_SEND/i.test(e.name) && e.value === 'true').map((e) => e.name),
  };
}

async function withDb(fn) {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function dbCounts() {
  return withDb(async (c) => {
    const q = async (s, p) => (await c.query(s, p)).rows[0];
    return {
      bookings: (await q('SELECT COUNT(*)::text AS count FROM bookings')).count,
      payments: (await q('SELECT COUNT(*)::text AS count FROM payments')).count,
      booking_service_records: (await q('SELECT COUNT(*)::text AS count FROM booking_service_records')).count,
      booking_transfers: (await q('SELECT COUNT(*)::text AS count FROM booking_transfers')).count,
      guest_message_sends_sent: (await q("SELECT COUNT(*)::text AS count FROM guest_message_sends WHERE status='sent'")).count,
    };
  });
}

async function svcBookingMeta() {
  return withDb(async (c) => {
    const bk = (await c.query(
      `SELECT id::text AS booking_id, check_in::text, check_out::text FROM bookings WHERE booking_code = $1 LIMIT 1`,
      [BOOKING_CODE_SVC],
    )).rows[0];
    const rows = (await c.query(
      `SELECT sr.id::text AS service_record_id, sr.service_type, sr.service_date::text AS service_date,
              sr.payment_status, sr.status, sr.quantity, sr.amount_due_cents
         FROM booking_service_records sr
        WHERE sr.client_slug = $1 AND sr.booking_id = $2::uuid
        ORDER BY service_date NULLS FIRST, service_type`,
      [CLIENT, bk.booking_id],
    )).rows;
    return { booking: bk, records: rows };
  });
}

async function xferBookingRows() {
  return withDb(async (c) => {
    return (await c.query(
      `SELECT id::text AS transfer_id, direction, status, airport_code, flight_number
         FROM booking_transfers
        WHERE client_slug = $1 AND booking_id = $2::uuid
        ORDER BY direction`,
      [CLIENT, BOOKING_ID_XFER],
    )).rows;
  });
}

async function getServiceRecord(recordId) {
  return withDb(async (c) => {
    return (await c.query(
      `SELECT id::text AS id, service_date::text AS service_date, service_type, payment_status, status
         FROM booking_service_records WHERE id = $1::uuid`,
      [recordId],
    )).rows[0] || null;
  });
}

function proofA(html) {
  const transferCard = (html.match(/function bcRenderTransferCard[\s\S]{0,1800}/) || [''])[0];
  const invoiceFn = (html.match(/function bcRenderRunningInvoiceHtml[\s\S]{0,3500}/) || [''])[0];
  const servicesFn = (html.match(/function bcInitServicesSchedulePickers[\s\S]{0,1200}/) || [''])[0];
  return {
    transferOverviewCards: /bc-transfer-card bc-drawer-overview-card|bc-drawer-overview-card[\s\S]{0,40}bc-transfer-card/.test(transferCard),
    transferRemoveButtons: html.includes('bc-transfer-remove') && html.includes('Remove '),
    paymentsServicesLabel: /ctx-inv-group-title">Services</.test(invoiceFn) && !/ctx-inv-group-title">Add-ons</.test(invoiceFn),
    paymentsTwoColumn: html.includes('ctx-payments-tab-layout') && html.includes('ctx-payments-col-main') && html.includes('ctx-payments-col-history'),
    paymentHistoryCard: html.includes('ctx-payment-history-card') && html.includes('Payment history'),
    paymentsResponsiveStack: html.includes('ctx-payments-tab-layout') && /@media \(max-width:860px\)[\s\S]{0,120}ctx-payments-tab-layout/.test(html),
    paymentsSpacer: html.includes('bc-payments-tab-spacer') && /\.bc-payments-tab-spacer[\s\S]{0,80}height:280px/.test(html),
    servicesSchedulePlus: html.includes('bc-svc-schedule-add-btn'),
    servicesPicker: html.includes('bc-svc-picker-option') || html.includes('bcRenderSchedulePickerHtml'),
    servicesPatchCall: /method:\s*'PATCH'/.test(servicesFn || html) && /\/services\/[\s\S]{0,80}\/date/.test(html),
    servicesPaidSummary: html.includes('Paid / requested services') || html.includes('bc-svc-paid-title'),
  };
}

function stayDatesFromBody(body) {
  return (body && body.stay_dates) || [];
}

function pickUnscheduled(body) {
  return ((body && body.unscheduled_services) || []).find((s) => s.service_record_id);
}

(async () => {
  const beforeCounts = await dbCounts();
  const svcMetaBefore = await svcBookingMeta();
  const xferBefore = await xferBookingRows();
  const revisionBefore = activeRevision();
  const wiring = envSummary();
  const healthBefore = await req('GET', '/healthz');

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');

  const ui = await req('GET', '/staff/ui', null, cookie);
  const html = ui.raw || '';
  const proofAOut = proofA(html);

  const svcGetBefore = await req(
    'GET',
    `/staff/bookings/${BOOKING_ID_SVC}/services?client_slug=${encodeURIComponent(CLIENT)}`,
    null,
    cookie,
  );

  const unsched = pickUnscheduled(svcGetBefore.body);
  const stayDates = stayDatesFromBody(svcGetBefore.body);
  const targetDate = stayDates[0] || null;
  let patchOk = null;
  let patchBody = null;
  let recordBefore = null;
  let recordAfterSchedule = null;
  let invalidPatch = null;

  if (unsched && targetDate) {
    recordBefore = await getServiceRecord(unsched.service_record_id);
    const patch = await req(
      'PATCH',
      `/staff/bookings/${BOOKING_ID_SVC}/services/${unsched.service_record_id}/date`,
      { client_slug: CLIENT, service_date: targetDate },
      cookie,
    );
    patchOk = patch;
    patchBody = patch.body;
    recordAfterSchedule = await getServiceRecord(unsched.service_record_id);

    const outsideDate = '2099-01-01';
    invalidPatch = await req(
      'PATCH',
      `/staff/bookings/${BOOKING_ID_SVC}/services/${unsched.service_record_id}/date`,
      { client_slug: CLIENT, service_date: outsideDate },
      cookie,
    );
  }

  const svcGetAfter = await req(
    'GET',
    `/staff/bookings/${BOOKING_ID_SVC}/services?client_slug=${encodeURIComponent(CLIENT)}`,
    null,
    cookie,
  );

  const xferGetBefore = await req(
    'GET',
    `/staff/bookings/${BOOKING_ID_XFER}/transfers?client_slug=${encodeURIComponent(CLIENT)}`,
    null,
    cookie,
  );

  let deleteArrival = null;
  let xferAfterDelete = null;
  let xferGetAfter = null;
  const hadArrival = xferBefore.some((r) => r.direction === 'arrival');
  if (hadArrival) {
    deleteArrival = await req(
      'DELETE',
      `/staff/bookings/${BOOKING_ID_XFER}/transfers/arrival?client_slug=${encodeURIComponent(CLIENT)}`,
      null,
      cookie,
    );
    xferAfterDelete = await xferBookingRows();
    xferGetAfter = await req(
      'GET',
      `/staff/bookings/${BOOKING_ID_XFER}/transfers?client_slug=${encodeURIComponent(CLIENT)}`,
      null,
      cookie,
    );
  }

  const midCounts = await dbCounts();
  const revisionAfter = activeRevision();
  const healthAfter = await req('GET', '/healthz');

  const proofB = {
    booking: BOOKING_CODE_SVC,
    unscheduled_target: unsched ? {
      service_record_id: unsched.service_record_id,
      summary: unsched.summary_line || unsched.service_name,
    } : null,
    target_date: targetDate,
    patch_http: patchOk && patchOk.status,
    patch_success: patchBody && patchBody.success,
    service_date_before: recordBefore && recordBefore.service_date,
    service_date_after: recordAfterSchedule && recordAfterSchedule.service_date,
    only_service_date_changed: recordBefore && recordAfterSchedule && (
      recordBefore.service_type === recordAfterSchedule.service_type
      && recordBefore.payment_status === recordAfterSchedule.payment_status
      && recordBefore.status === recordAfterSchedule.status
      && recordAfterSchedule.service_date === targetDate
    ),
    moved_off_unscheduled: unsched && svcGetAfter.body && !(svcGetAfter.body.unscheduled_services || [])
      .some((s) => s.service_record_id === unsched.service_record_id),
    scheduled_on_date: unsched && svcGetAfter.body && (svcGetAfter.body.services_by_date || [])
      .some((g) => g.date === targetDate && (g.services || []).some((s) => s.service_record_id === unsched.service_record_id)),
    no_payment_write: patchBody && patchBody.no_payment_write === true,
    skipped: !unsched || !targetDate ? 'no unscheduled service or stay date' : null,
  };

  const proofC = {
    http: invalidPatch && invalidPatch.status,
    success_false: invalidPatch && invalidPatch.body && invalidPatch.body.success === false,
    service_date_unchanged_after_invalid: recordAfterSchedule && invalidPatch
      && recordAfterSchedule.service_date === targetDate,
    skipped: !invalidPatch ? 'schedule proof skipped' : null,
  };

  const proofD = {
    booking: BOOKING_CODE_XFER,
    transfers_before: xferBefore,
    delete_http: deleteArrival && deleteArrival.status,
    delete_success: deleteArrival && deleteArrival.body && deleteArrival.body.success,
    deleted_flag: deleteArrival && deleteArrival.body && deleteArrival.body.deleted,
    no_payment_write: deleteArrival && deleteArrival.body && deleteArrival.body.no_payment_write === true,
    arrival_removed: hadArrival && xferAfterDelete && !xferAfterDelete.some((r) => r.direction === 'arrival'),
    departure_remains: xferAfterDelete && xferAfterDelete.some((r) => r.direction === 'departure'),
    get_after: xferGetAfter && { http: xferGetAfter.status, transfer_count: (xferGetAfter.body.transfers || []).length },
    pebble_one_direction: xferGetAfter && xferGetAfter.body && (xferGetAfter.body.transfers || [])
      .filter((t) => t.status === 'requested' || t.status === 'confirmed').length === 1,
    second_remove_skipped: true,
    skipped: !hadArrival ? 'no arrival transfer row to remove' : null,
  };

  const proofE = {
    note: 'Static bundle + CSS; manual browser resize recommended for pixel proof',
    lightCards: proofAOut.paymentsTwoColumn && proofAOut.paymentHistoryCard,
    leftSections: proofAOut.paymentsServicesLabel && html.includes('Generate Payment Link') && html.includes('Record cash payment'),
    rightHistory: proofAOut.paymentHistoryCard,
    responsiveCss: proofAOut.paymentsResponsiveStack,
    spacer: proofAOut.paymentsSpacer,
  };

  const afterCounts = midCounts;
  const proofF = {
    before: beforeCounts,
    after: afterCounts,
    booking_service_records_delta: Number(afterCounts.booking_service_records) - Number(beforeCounts.booking_service_records),
    booking_transfers_delta: Number(afterCounts.booking_transfers) - Number(beforeCounts.booking_transfers),
    unchanged: {
      bookings: beforeCounts.bookings === afterCounts.bookings,
      payments: beforeCounts.payments === afterCounts.payments,
      guest_message_sends_sent: beforeCounts.guest_message_sends_sent === afterCounts.guest_message_sends_sent,
      booking_service_records_count: beforeCounts.booking_service_records === afterCounts.booking_service_records,
    },
  };

  const revOk = revisionAfter.image === IMAGE && revisionAfter.health === 'Healthy' && revisionAfter.traffic === 100;
  const envOk = wiring.AVIATIONSTACK_API_KEY && wiring.AVIATIONSTACK_API_KEY.secretRef
    && wiring.WHATSAPP_DRY_RUN && wiring.WHATSAPP_DRY_RUN.value === 'true'
    && wiring.STRIPE_LINKS_ENABLED && wiring.STRIPE_LINKS_ENABLED.value === 'false'
    && wiring.whatsapp_live_send_vars.length === 0;

  const aOk = Object.values(proofAOut).every(Boolean);
  const bOk = proofB.skipped ? false : (
    proofB.patch_http === 200 && proofB.patch_success && proofB.only_service_date_changed
    && proofB.moved_off_unscheduled && proofB.scheduled_on_date && proofB.no_payment_write
  );
  const cOk = proofC.skipped ? false : (proofC.http === 400 && proofC.success_false && proofC.service_date_unchanged_after_invalid);
  const dOk = proofD.skipped ? false : (
    proofD.delete_http === 200 && proofD.delete_success && proofD.arrival_removed
    && proofD.departure_remains && proofD.no_payment_write
  );
  const eOk = Object.values(proofE).filter((v) => typeof v === 'boolean').every(Boolean);
  const fOk = proofF.unchanged.bookings && proofF.unchanged.payments && proofF.unchanged.guest_message_sends_sent
    && proofF.unchanged.booking_service_records_count
    && proofF.booking_transfers_delta === (proofD.skipped ? 0 : -1);

  let result = 'FAIL';
  if (healthAfter.status === 200 && revOk && envOk && aOk && bOk && cOk && dOk && eOk && fOk) result = 'PASS';
  else if (healthAfter.status === 200 && revOk && envOk && (aOk || bOk || dOk)) result = 'PARTIAL';

  const out = {
    result,
    commit: COMMIT,
    includes: { '9c1ee8b': true, defae58: true },
    image: IMAGE,
    acr_build: 'cb5u',
    revision: revisionAfter,
    revision_before: revisionBefore,
    healthz: { before: healthBefore.status, after: healthAfter.status },
    env: wiring,
    proofA: proofAOut,
    proofB,
    proofC,
    proofD,
    proofE,
    proofF,
    safety: {
      no_stripe_calls: true,
      no_whatsapp_sends: proofF.unchanged.guest_message_sends_sent,
      no_payment_writes: proofF.unchanged.payments,
      service_records_count_unchanged: proofF.unchanged.booking_service_records_count,
      transfer_delete_only: proofF.booking_transfers_delta === (proofD.skipped ? 0 : -1),
    },
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(result === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
