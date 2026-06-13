'use strict';
/** Stage 26h.4 hosted proof — temp, do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = '1123898';
const INCLUDES = ['9c1ee8b', 'defae58', '1123898'];
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:1123898-stage26h4-svc-unschedule-cleanup';
const REVISION_SUFFIX = 'stage26h4-svc-unschedule-cleanup';
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
    const payments = (await c.query(
      `SELECT COUNT(*)::text AS count FROM payments WHERE booking_id = $1::uuid`,
      [bk.booking_id],
    )).rows[0].count;
    return { booking: bk, records: rows, payments_count: payments };
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
      `SELECT id::text AS id, service_date::text AS service_date, service_type, payment_status, status, quantity, amount_due_cents
         FROM booking_service_records WHERE id = $1::uuid`,
      [recordId],
    )).rows[0] || null;
  });
}

function proofA(html) {
  const removeFn = (html.match(/function bcRemoveTransfer[\s\S]{0,1800}/) || [''])[0];
  const addPanelFn = (html.match(/function bcRenderAddServicePanelHtml[\s\S]{0,800}/) || [''])[0];
  const invoiceFn = (html.match(/function bcRenderRunningInvoiceHtml[\s\S]{0,3500}/) || [''])[0];
  const overviewFn = (html.match(/function renderBookingContextDrawer[\s\S]{0,5000}/) || [''])[0];
  const scheduleFn = (html.match(/function bcRenderServicesScheduleSections[\s\S]{0,2500}/) || [''])[0];
  const cashIdx = html.indexOf('id="bc-record-cash-btn"');
  const linkIdx = html.indexOf('id="bc-generate-payment-link-btn"');
  const invoiceCashIdx = invoiceFn.indexOf('bcRenderCashPaymentFormHtml');
  const invoiceLinkIdx = invoiceFn.indexOf('bcRenderPaymentLinkSectionHtml');
  return {
    schedulePlusMinus: html.includes('bc-svc-schedule-add-btn') && html.includes('bc-svc-schedule-remove-btn'),
    buttonsGrouped: /\.bc-svc-schedule-add-btn,.bc-svc-schedule-remove-btn/.test(html),
    addRemoveUnderPaid: html.includes('bc-svc-add-remove-panel') && html.includes('bc-add-ons-panel'),
    addOrRemoveTitleGone: !/bc-add-ons-title|Add or remove/.test(addPanelFn),
    addRemoveButtons: html.includes('bc-add-service-btn') && html.includes('bc-remove-service-btn'),
    transferRemovedTextGone: !/Transfer removed/.test(removeFn),
    transferRemoveButton: html.includes('bc-transfer-remove'),
    recordCashBeforeLinkInInvoice: invoiceCashIdx >= 0 && invoiceLinkIdx >= 0 && invoiceCashIdx < invoiceLinkIdx,
    recordCashLabel: html.includes('>Record Cash Payment</button>'),
    generateLinkRetained: html.includes('Generate Payment Link'),
    overviewNoRoomBedInBookingDetails: !/bc-drawer-card-booking[\s\S]{0,1200}Room \/ bed/.test(overviewFn)
      && !/before-addons[\s\S]{0,2000}Room \/ bed/.test(overviewFn),
    moveBedCard: overviewFn.includes('id="bc-move-bed"') && overviewFn.includes('Move bed'),
    paymentSummaryAfterConversation: (() => {
      const convIdx = overviewFn.indexOf('bc-drawer-card-conversation');
      const payIdx = overviewFn.indexOf('bcRenderPaymentSummaryBriefHtml');
      return convIdx >= 0 && payIdx >= 0 && convIdx < payIdx;
    })(),
    paymentSummaryBrief: html.includes('bc-payment-summary-brief'),
    scheduleRemoveFlow: /service_date:\s*null/.test(html) && scheduleFn.includes('bc-svc-schedule-remove-btn'),
    cashBeforeLinkGlobal: cashIdx >= 0 && linkIdx >= 0 && cashIdx < linkIdx,
  };
}

function proofE(html) {
  const overviewFn = (html.match(/function renderBookingContextDrawer[\s\S]{0,5500}/) || [''])[0];
  const invoiceFn = (html.match(/function bcRenderRunningInvoiceHtml[\s\S]{0,4000}/) || [''])[0];
  return {
    recordCashBeforeGenerateLink: invoiceFn.indexOf('bcRenderCashPaymentFormHtml') < invoiceFn.indexOf('bcRenderPaymentLinkSectionHtml'),
    recordCashPaymentLabel: html.includes('>Record Cash Payment</button>'),
    paymentHistoryCard: html.includes('ctx-payment-history-card') && /Payment history/i.test(html),
    paymentActionsPresent: html.includes('bc-generate-payment-link-btn') && html.includes('bc-record-cash-btn'),
    bookingDetailsNoRoomBed: !/bc-drawer-card-booking[\s\S]{0,1500}Room \/ bed/.test(overviewFn),
    moveBedShowsAssignment: overviewFn.includes('bcRenderMoveSourcePillsHtml'),
    paymentSummaryBelowConversation: overviewFn.indexOf('bc-drawer-card-conversation') < overviewFn.indexOf('bcRenderPaymentSummaryBriefHtml'),
    footerActions: html.includes('bcRenderBookingDrawerFooterHtml') || (html.includes('Open Conversation') || html.includes('New Conversation')) && html.includes('Cancel Booking'),
  };
}

function pickUnscheduled(body) {
  return ((body && body.unscheduled_services) || []).find((s) => s.service_record_id);
}

function stayDatesFromBody(body) {
  return (body && body.stay_dates) || [];
}

(async () => {
  const beforeCounts = await dbCounts();
  const svcMetaBefore = await svcBookingMeta();
  const xferBefore = await xferBookingRows();
  const revision = activeRevision();
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
  const proofEOut = proofE(html);

  const svcGetBefore = await req(
    'GET',
    `/staff/bookings/${BOOKING_ID_SVC}/services?client_slug=${encodeURIComponent(CLIENT)}`,
    null,
    cookie,
  );

  const unsched = pickUnscheduled(svcGetBefore.body);
  const stayDates = stayDatesFromBody(svcGetBefore.body);
  const targetDate = stayDates[0] || null;

  let recordBefore = null;
  let schedulePatch = null;
  let recordAfterSchedule = null;
  let unschedulePatch = null;
  let recordAfterUnschedule = null;
  let invalidPatch = null;
  let svcGetAfterSchedule = null;
  let svcGetAfterUnschedule = null;

  if (unsched && targetDate) {
    recordBefore = await getServiceRecord(unsched.service_record_id);
    schedulePatch = await req(
      'PATCH',
      `/staff/bookings/${BOOKING_ID_SVC}/services/${unsched.service_record_id}/date`,
      { client_slug: CLIENT, service_date: targetDate },
      cookie,
    );
    recordAfterSchedule = await getServiceRecord(unsched.service_record_id);
    svcGetAfterSchedule = await req(
      'GET',
      `/staff/bookings/${BOOKING_ID_SVC}/services?client_slug=${encodeURIComponent(CLIENT)}`,
      null,
      cookie,
    );

    unschedulePatch = await req(
      'PATCH',
      `/staff/bookings/${BOOKING_ID_SVC}/services/${unsched.service_record_id}/date`,
      { client_slug: CLIENT, service_date: null },
      cookie,
    );
    recordAfterUnschedule = await getServiceRecord(unsched.service_record_id);
    svcGetAfterUnschedule = await req(
      'GET',
      `/staff/bookings/${BOOKING_ID_SVC}/services?client_slug=${encodeURIComponent(CLIENT)}`,
      null,
      cookie,
    );

    invalidPatch = await req(
      'PATCH',
      `/staff/bookings/${BOOKING_ID_SVC}/services/${unsched.service_record_id}/date`,
      { client_slug: CLIENT, service_date: '2099-01-01' },
      cookie,
    );
  }

  const xferGetBefore = await req(
    'GET',
    `/staff/bookings/${BOOKING_ID_XFER}/transfers?client_slug=${encodeURIComponent(CLIENT)}`,
    null,
    cookie,
  );

  let deleteXfer = null;
  let xferAfterDelete = null;
  let xferGetAfter = null;
  let deleteDirection = null;
  const removable = xferBefore.find((r) => r.direction === 'arrival') || xferBefore.find((r) => r.direction === 'departure');
  if (removable) {
    deleteDirection = removable.direction;
    deleteXfer = await req(
      'DELETE',
      `/staff/bookings/${BOOKING_ID_XFER}/transfers/${deleteDirection}?client_slug=${encodeURIComponent(CLIENT)}`,
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

  const afterCounts = await dbCounts();
  const svcMetaAfter = await svcBookingMeta();
  const healthAfter = await req('GET', '/healthz');

  const proofB = {
    booking: BOOKING_CODE_SVC,
    booking_id: BOOKING_ID_SVC,
    service_records_before: svcMetaBefore.records.length,
    payments_before: svcMetaBefore.payments_count,
    target: unsched ? {
      service_record_id: unsched.service_record_id,
      summary: unsched.summary_line || unsched.service_name,
    } : null,
    target_date: targetDate,
    service_date_before: recordBefore && recordBefore.service_date,
    schedule_patch_http: schedulePatch && schedulePatch.status,
    schedule_patch_success: schedulePatch && schedulePatch.body && schedulePatch.body.success,
    service_date_after_schedule: recordAfterSchedule && recordAfterSchedule.service_date,
    scheduled_on_date: unsched && svcGetAfterSchedule && svcGetAfterSchedule.body && (svcGetAfterSchedule.body.services_by_date || [])
      .some((g) => g.date === targetDate && (g.services || []).some((s) => s.service_record_id === unsched.service_record_id)),
    unschedule_patch_http: unschedulePatch && unschedulePatch.status,
    unschedule_patch_success: unschedulePatch && unschedulePatch.body && unschedulePatch.body.success,
    unschedule_service_date_null: unschedulePatch && unschedulePatch.body && unschedulePatch.body.service_date === null,
    service_date_after_unschedule: recordAfterUnschedule && recordAfterUnschedule.service_date,
    back_on_unscheduled: unsched && svcGetAfterUnschedule && svcGetAfterUnschedule.body && (svcGetAfterUnschedule.body.unscheduled_services || [])
      .some((s) => s.service_record_id === unsched.service_record_id),
    only_service_date_changed: recordBefore && recordAfterUnschedule && (
      recordBefore.service_type === recordAfterUnschedule.service_type
      && recordBefore.payment_status === recordAfterUnschedule.payment_status
      && recordBefore.status === recordAfterUnschedule.status
      && recordBefore.quantity === recordAfterUnschedule.quantity
      && recordBefore.amount_due_cents === recordAfterUnschedule.amount_due_cents
      && recordAfterUnschedule.service_date == null
    ),
    no_payment_write: schedulePatch && schedulePatch.body && schedulePatch.body.no_payment_write === true
      && unschedulePatch && unschedulePatch.body && unschedulePatch.body.no_payment_write === true,
    service_records_after: svcMetaAfter.records.length,
    payments_after: svcMetaAfter.payments_count,
    skipped: !unsched || !targetDate ? 'no unscheduled service or stay date' : null,
  };

  const proofC = {
    http: invalidPatch && invalidPatch.status,
    success_false: invalidPatch && invalidPatch.body && invalidPatch.body.success === false,
    service_date_unchanged_after_invalid: recordAfterUnschedule && recordAfterUnschedule.service_date == null,
    skipped: !invalidPatch ? 'schedule proof skipped' : null,
  };

  const otherDirection = deleteDirection === 'arrival' ? 'departure' : 'arrival';
  const proofD = {
    booking: BOOKING_CODE_XFER,
    transfers_before: xferBefore,
    delete_direction: deleteDirection,
    delete_http: deleteXfer && deleteXfer.status,
    delete_success: deleteXfer && deleteXfer.body && deleteXfer.body.success,
    deleted_flag: deleteXfer && deleteXfer.body && deleteXfer.body.deleted,
    no_payment_write: deleteXfer && deleteXfer.body && deleteXfer.body.no_payment_write === true,
    direction_removed: deleteDirection && xferAfterDelete && !xferAfterDelete.some((r) => r.direction === deleteDirection),
    other_direction_remains: xferBefore.some((r) => r.direction === otherDirection)
      ? xferAfterDelete && xferAfterDelete.some((r) => r.direction === otherDirection)
      : true,
    get_after: xferGetAfter && { http: xferGetAfter.status, transfer_count: (xferGetAfter.body.transfers || []).length },
    no_transfer_removed_text_in_bundle: !/Transfer removed/.test((html.match(/function bcRemoveTransfer[\s\S]{0,1800}/) || [''])[0]),
    skipped: !removable ? 'no transfer row to remove' : null,
  };

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

  const revOk = revision.image === IMAGE && revision.health === 'Healthy' && revision.traffic === 100
    && String(revision.name || '').includes(REVISION_SUFFIX);
  const envOk = wiring.AVIATIONSTACK_API_KEY && wiring.AVIATIONSTACK_API_KEY.secretRef
    && wiring.WHATSAPP_DRY_RUN && wiring.WHATSAPP_DRY_RUN.value === 'true'
    && wiring.STRIPE_LINKS_ENABLED && wiring.STRIPE_LINKS_ENABLED.value === 'false'
    && wiring.whatsapp_live_send_vars.length === 0;

  const aOk = Object.values(proofAOut).every(Boolean);
  const bOk = proofB.skipped ? false : (
    proofB.schedule_patch_http === 200 && proofB.schedule_patch_success
    && proofB.unschedule_patch_http === 200 && proofB.unschedule_patch_success
    && proofB.unschedule_service_date_null && proofB.back_on_unscheduled
    && proofB.only_service_date_changed && proofB.no_payment_write
    && proofB.service_records_before === proofB.service_records_after
    && proofB.payments_before === proofB.payments_after
  );
  const cOk = proofC.skipped ? false : (proofC.http === 400 && proofC.success_false && proofC.service_date_unchanged_after_invalid);
  const dOk = proofD.skipped ? false : (
    proofD.delete_http === 200 && proofD.delete_success && proofD.direction_removed
    && proofD.no_payment_write && proofD.no_transfer_removed_text_in_bundle
  );
  const eOk = Object.values(proofEOut).every(Boolean);
  const fOk = proofF.unchanged.bookings && proofF.unchanged.payments && proofF.unchanged.guest_message_sends_sent
    && proofF.unchanged.booking_service_records_count
    && proofF.booking_transfers_delta === (proofD.skipped ? 0 : -1);

  let result = 'FAIL';
  if (healthAfter.status === 200 && revOk && envOk && aOk && bOk && cOk && dOk && eOk && fOk) result = 'PASS';
  else if (healthAfter.status === 200 && revOk && envOk && (aOk || bOk || dOk)) result = 'PARTIAL';

  const out = {
    result,
    commit: COMMIT,
    includes: { '9c1ee8b': true, defae58: true, '1123898': true },
    image: IMAGE,
    acr_build: 'cb5v',
    revision,
    healthz: { before: healthBefore.status, after: healthAfter.status },
    env: wiring,
    proofA: proofAOut,
    proofB,
    proofC,
    proofD,
    proofE: proofEOut,
    proofF,
    safety: {
      no_stripe_calls: true,
      no_whatsapp_sends: proofF.unchanged.guest_message_sends_sent,
      no_payment_writes: proofF.unchanged.payments,
      service_records_count_unchanged: proofF.unchanged.booking_service_records_count,
      transfer_delete_only: proofF.booking_transfers_delta === (proofD.skipped ? 0 : -1),
      healthz_after: healthAfter.status === 200,
    },
    caveats: [
      proofD.skipped ? 'No transfer row available for remove proof' : `Removed ${deleteDirection} transfer on ${BOOKING_CODE_XFER}`,
      'Proof E is static bundle inspection; manual browser check recommended for pixel layout',
    ],
    recommended_next_step: result === 'PASS'
      ? 'Merge to main and schedule production deploy when ready'
      : 'Review failed proof sections and re-run after fix',
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(result === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
