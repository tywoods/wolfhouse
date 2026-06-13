'use strict';
/** Stage 26h.5 full hosted proof — temp, do not commit. */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:9fc3657-stage26h5-transfers-ui';
const CLIENT = 'wolfhouse-somo';
const BOOKING_ID = '01039383-389e-4e71-a7d6-75b56345fdbf';
const BOOKING_CODE = 'MB-WOLFHO-20260920-4f62e2';
const XFER_BOOKING_ID = 'adf70f79-c750-458d-a306-97c81304898b';
const MIGRATION = path.join(__dirname, 'database', 'migrations', '018_booking_service_records_nullable_service_date.sql');

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function req(method, pathStr, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path: pathStr, method,
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

async function withDb(fn) {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

function envSummary() {
  const app = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const env = app.properties.template.containers[0].env || [];
  const pick = (name) => {
    const e = env.find((x) => x.name === name);
    if (!e) return null;
    if (e.secretRef) return { name, secretRef: e.secretRef };
    return { name, value: e.value };
  };
  return {
    STAFF_ACTIONS_ENABLED: pick('STAFF_ACTIONS_ENABLED'),
    AVIATIONSTACK_API_KEY: pick('AVIATIONSTACK_API_KEY'),
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
    whatsapp_live_send_vars: env.filter((e) => /WHATSAPP.*SEND|META.*SEND|LIVE_SEND/i.test(e.name) && e.value === 'true').map((e) => e.name),
  };
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return { name: a.name, health: a.properties.healthState, traffic: a.properties.trafficWeight, image: a.properties.template?.containers?.[0]?.image };
}

(async () => {
  const migrationSql = fs.readFileSync(MIGRATION, 'utf8');
  let nullable = 'NO';
  await withDb(async (c) => {
    nullable = (await c.query(`SELECT is_nullable FROM information_schema.columns WHERE table_name='booking_service_records' AND column_name='service_date'`)).rows[0]?.is_nullable || 'NO';
    if (nullable !== 'YES') await c.query(migrationSql);
    nullable = (await c.query(`SELECT is_nullable FROM information_schema.columns WHERE table_name='booking_service_records' AND column_name='service_date'`)).rows[0]?.is_nullable;
  });

  const rev = activeRevision();
  const env = envSummary();
  const health = await req('GET', '/healthz');
  const login = await req('POST', '/staff/auth/login', { client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!' });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const ui = await req('GET', '/staff/ui', null, cookie);
  const html = ui.raw || '';

  let beforeCounts;
  await withDb(async (c) => {
    beforeCounts = {
      payments: (await c.query('SELECT COUNT(*)::text AS c FROM payments')).rows[0].c,
      svc: (await c.query('SELECT COUNT(*)::text AS c FROM booking_service_records')).rows[0].c,
      sends: (await c.query("SELECT COUNT(*)::text AS c FROM guest_message_sends WHERE status='sent'")).rows[0].c,
    };
  });

  const svcGet = await req('GET', `/staff/bookings/${BOOKING_ID}/services?client_slug=${encodeURIComponent(CLIENT)}`, null, cookie);
  const stayDates = svcGet.body.stay_dates || [];
  const targetDate = stayDates[0];
  const unsched = (svcGet.body.unscheduled_services || [])[0];
  let schedule = null;
  let unschedule = null;
  let invalid = null;
  let recordAfter = null;
  if (unsched && targetDate) {
    schedule = await req('PATCH', `/staff/bookings/${BOOKING_ID}/services/${unsched.service_record_id}/date`, { client_slug: CLIENT, service_date: targetDate }, cookie);
    unschedule = await req('PATCH', `/staff/bookings/${BOOKING_ID}/services/${unsched.service_record_id}/date`, { client_slug: CLIENT, service_date: null }, cookie);
    invalid = await req('PATCH', `/staff/bookings/${BOOKING_ID}/services/${unsched.service_record_id}/date`, { client_slug: CLIENT, service_date: '2099-01-01' }, cookie);
    await withDb(async (c) => {
      recordAfter = (await c.query('SELECT service_date FROM booking_service_records WHERE id=$1::uuid', [unsched.service_record_id])).rows[0];
    });
  }

  const xferBefore = await withDb(async (c) => (await c.query('SELECT COUNT(*)::text AS c FROM booking_transfers WHERE booking_id=$1::uuid', [XFER_BOOKING_ID])).rows[0].c);
  const xferSave = await req('POST', `/staff/bookings/${XFER_BOOKING_ID}/transfers`, {
    client_slug: CLIENT,
    direction: 'arrival',
    status: 'requested',
    airport_code: 'SDR',
    scheduled_at: '2029-10-01T10:00',
    manual_override_euros: 25,
    manual_override_enabled: true,
    source: 'staff',
  }, cookie);
  let xferRow = null;
  if (xferSave.body && xferSave.body.success) {
    await withDb(async (c) => {
      xferRow = (await c.query(`SELECT price_cents, included_in_package, pricing_note FROM booking_transfers WHERE booking_id=$1::uuid AND direction='arrival'`, [XFER_BOOKING_ID])).rows[0];
    });
  }
  const xferDelete = await req('DELETE', `/staff/bookings/${XFER_BOOKING_ID}/transfers/arrival?client_slug=${encodeURIComponent(CLIENT)}`, null, cookie);

  let afterCounts;
  await withDb(async (c) => {
    afterCounts = {
      payments: (await c.query('SELECT COUNT(*)::text AS c FROM payments')).rows[0].c,
      svc: (await c.query('SELECT COUNT(*)::text AS c FROM booking_service_records')).rows[0].c,
      sends: (await c.query("SELECT COUNT(*)::text AS c FROM guest_message_sends WHERE status='sent'")).rows[0].c,
    };
  });

  const drawerSlice = html.match(/function renderBookingContextDrawer[\s\S]{0,5500}/)?.[0] || '';
  const invSlice = html.match(/function bcRenderRunningInvoiceHtml[\s\S]{0,5000}/)?.[0] || '';

  const proof = {
    result: 'PASS',
    commit: '9fc3657',
    includes: ['77eb227', '1123898', '9fc3657'],
    image: IMAGE,
    revision: rev,
    migration_nullable: nullable,
    healthz: health.status,
    env,
    proofA_unschedule: {
      schedule_http: schedule && schedule.status,
      unschedule_http: unschedule && unschedule.status,
      service_date_null: recordAfter && recordAfter.service_date === null,
      invalid_http: invalid && invalid.status,
    },
    proofB_overview: {
      payment_above_conversation: drawerSlice.indexOf('bcRenderPaymentSummaryBriefHtml') < drawerSlice.indexOf('bc-drawer-card-conversation') && drawerSlice.indexOf('bc-move-bed') < drawerSlice.indexOf('bcRenderPaymentSummaryBriefHtml'),
      no_room_bed_in_booking_details: !/bc-drawer-card-booking[\s\S]{0,1500}Room \/ bed/.test(drawerSlice),
    },
    proofC_legend: {
      no_legend_title: !/>Legend:</.test(html.match(/id="bc-legend"[\s\S]{0,300}/)?.[0] || ''),
      controls_row: html.includes('bc-controls-row'),
      inline_legend: /\.bc-legend[\s\S]{0,120}inline-flex|width:auto/.test(html),
    },
    proofD_transfers: {
      exception_override_ui: html.includes('Exception Override') && html.includes('Transfer charge'),
      transfer_required_label: html.includes('Transfer Required'),
      no_transfer_saved: !/Transfer saved/.test(html.match(/function bcSaveTransfer[\s\S]{0,1500}/)?.[0] || ''),
      save_pebble_refresh: /bcRefreshTransferPebbleSummary/.test(html.match(/function bcSaveTransfer[\s\S]{0,1500}/)?.[0] || ''),
      override_price_cents: xferRow && xferRow.price_cents,
      override_included: xferRow && xferRow.included_in_package,
      override_note: xferRow && xferRow.pricing_note,
      delete_http: xferDelete.status,
    },
    proofE_staff_actions: {
      staff_actions_enabled: env.STAFF_ACTIONS_ENABLED && env.STAFF_ACTIONS_ENABLED.value === 'true',
      generate_link_button: html.includes('bc-generate-payment-link-btn'),
      cash_before_link: invSlice.indexOf('bcRenderCashPaymentFormHtml') < invSlice.indexOf('bcRenderPaymentLinkSectionHtml'),
    },
    counts: { before: beforeCounts, after: afterCounts },
  };

  const ok = rev.image === IMAGE && rev.health === 'Healthy' && rev.traffic === 100
    && health.status === 200 && nullable === 'YES'
    && env.STAFF_ACTIONS_ENABLED?.value === 'true'
    && env.WHATSAPP_DRY_RUN?.value === 'true'
    && proof.proofA_unschedule.unschedule_http === 200
    && proof.proofD_transfers.override_price_cents === 2500
    && beforeCounts.payments === afterCounts.payments;

  if (!ok) proof.result = 'PARTIAL';
  console.log(JSON.stringify(proof, null, 2));
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
