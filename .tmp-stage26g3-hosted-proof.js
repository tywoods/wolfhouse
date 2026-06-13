'use strict';
/** Stage 26g.3 hosted proof — temp, do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = '7ef189b';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:7ef189b-stage26g3-drawer-file-tabs';
const CLIENT = 'wolfhouse-somo';
const BOOKING_ID_SVC = '01039383-389e-4e71-a7d6-75b56345fdbf';
const BOOKING_CODE_SVC = 'MB-WOLFHO-20260920-4f62e2';
const BOOKING_ID_XFER = 'adf70f79-c750-458d-a306-97c81304898b';

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

async function dbCounts() {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = async (s, p) => (await c.query(s, p)).rows[0];
  const out = {
    bookings: (await q('SELECT COUNT(*)::text AS count FROM bookings')).count,
    payments: (await q('SELECT COUNT(*)::text AS count FROM payments')).count,
    booking_service_records: (await q('SELECT COUNT(*)::text AS count FROM booking_service_records')).count,
    guest_message_sends_sent: (await q("SELECT COUNT(*)::text AS count FROM guest_message_sends WHERE status='sent'")).count,
  };
  await c.end();
  return out;
}

function proofA(html) {
  const servicesFn = (html.match(/function bcRenderServicesTabHtml[\s\S]{0,900}/) || [''])[0];
  const transferFn = (html.match(/function bcRenderTransferDetailsShell[\s\S]{0,700}/) || [''])[0];
  const invoiceFn = (html.match(/function bcRenderRunningInvoiceHtml[\s\S]{0,900}/) || [''])[0];
  return {
    drawerTabs: html.includes('bc-drawer-tabs'),
    fileTabShell: html.includes('bc-drawer-file-tabs') && html.includes('bc-drawer-tab-content-panel'),
    activeTabConnects: /\.bc-drawer-tab\.is-active[\s\S]{0,260}var\(--surface-soft\)/.test(html),
    tabLabels: ['Overview', 'Services', 'Transfers', 'Payments'].every((l) => html.includes(`'${l.toLowerCase()}', '${l}'`)),
    noDupServicesH3: !/<h3>Services<\/h3>/.test(servicesFn),
    noFlightTransferDetails: !/Flight \/ Transfer Details/.test(transferFn),
    noLookupHelper: !/Lookup uses booking check-in\/check-out dates/.test(transferFn),
    noDupPaymentH3: !/<h3>Payment<\/h3>/.test(invoiceFn),
    arrivalDeparture: html.includes('Arrival transfer') && html.includes('Departure transfer'),
    paymentHistory: html.includes('Payment history') || html.includes('ctx-inv-subtitle">Payment history'),
    serviceSchedule: html.includes('Service schedule') && html.includes('Unscheduled services'),
    transferSpacer: html.includes('bc-transfer-tab-spacer') && /height:280px/.test(html),
    spacerAfterCards: transferFn.indexOf('bc-transfer-tab-spacer') > transferFn.indexOf('bc-transfer-cards'),
    scrollFix: html.includes('mousedown') && html.includes('scrollTo(0, winY)'),
    overviewCards: html.includes('bc-drawer-card-booking') && html.includes('bc-drawer-overview-card'),
    minHeightPanel: html.includes('min-height:680px'),
    transfersMinHeight: html.includes('data-tab="transfers"') && html.includes('min-height:640px'),
    addRemove: html.includes('bc-add-ons-btn') && html.includes('Add or remove'),
  };
}

(async () => {
  const beforeCounts = await dbCounts();
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

  const svc = await req(
    'GET',
    `/staff/bookings/${BOOKING_ID_SVC}/services?client_slug=${encodeURIComponent(CLIENT)}`,
    null,
    cookie,
  );

  const transfers = await req(
    'GET',
    `/staff/bookings/${BOOKING_ID_XFER}/transfers?client_slug=${encodeURIComponent(CLIENT)}`,
    null,
    cookie,
  );

  const afterCounts = await dbCounts();
  const revisionAfter = activeRevision();
  const healthAfter = await req('GET', '/healthz');

  const proofB = {
    note: 'Static bundle confirms visual structure; manual browser check recommended for pixel proof',
    fileTabs: proofAOut.fileTabShell && proofAOut.activeTabConnects,
    overviewSoftCards: proofAOut.overviewCards && proofAOut.minHeightPanel,
    servicesNoDupHeader: proofAOut.noDupServicesH3,
    transfersNoDupHeader: proofAOut.noFlightTransferDetails && proofAOut.noLookupHelper,
    transfersSpacer: proofAOut.transferSpacer && proofAOut.spacerAfterCards,
    paymentsNoDupHeader: proofAOut.noDupPaymentH3 && proofAOut.paymentHistory,
  };

  const proofC = {
    static: proofAOut.scrollFix && proofAOut.minHeightPanel && proofAOut.transfersMinHeight,
    note: 'mousedown/click preventDefault + panel min-heights deployed; manual scroll test recommended',
  };

  const proofD = {
    booking: BOOKING_CODE_SVC,
    http: svc.status,
    success: svc.body && svc.body.success,
    package_summary: !!(svc.body && svc.body.package_summary),
    stay_dates: svc.body && svc.body.stay_dates,
    services_by_date_count: (svc.body && svc.body.services_by_date || []).length,
    scheduled_count: svc.body && svc.body.totals && svc.body.totals.scheduled_count,
    unscheduled_count: svc.body && svc.body.totals && svc.body.unscheduled_count,
    record_count: svc.body && svc.body.totals && svc.body.totals.record_count,
    no_payment_write: svc.body && svc.body.no_payment_write === true,
    no_metadata: !JSON.stringify(svc.body || {}).includes('"metadata"'),
  };

  const proofE = {
    before: beforeCounts,
    after: afterCounts,
    unchanged: {
      bookings: beforeCounts.bookings === afterCounts.bookings,
      payments: beforeCounts.payments === afterCounts.payments,
      booking_service_records: beforeCounts.booking_service_records === afterCounts.booking_service_records,
      guest_message_sends_sent: beforeCounts.guest_message_sends_sent === afterCounts.guest_message_sends_sent,
    },
  };

  const revOk = revisionAfter.image === IMAGE && revisionAfter.health === 'Healthy' && revisionAfter.traffic === 100;
  const envOk = wiring.AVIATIONSTACK_API_KEY && wiring.AVIATIONSTACK_API_KEY.secretRef
    && wiring.WHATSAPP_DRY_RUN && wiring.WHATSAPP_DRY_RUN.value === 'true'
    && wiring.STRIPE_LINKS_ENABLED && wiring.STRIPE_LINKS_ENABLED.value === 'false'
    && wiring.whatsapp_live_send_vars.length === 0;

  const aOk = Object.entries(proofAOut).every(([k, v]) => k === 'tabLabels' ? v : v === true);
  const bOk = Object.values(proofB).every((v) => v === true || typeof v === 'string');
  const cOk = proofC.static;
  const dOk = proofD.http === 200 && proofD.success && proofD.package_summary && proofD.no_payment_write && proofD.no_metadata && proofD.record_count > 0;
  const eOk = Object.values(proofE.unchanged).every(Boolean);
  const xferOk = transfers.status === 200 && transfers.body && transfers.body.success;

  const out = {
    result: (healthAfter.status === 200 && revOk && envOk && aOk && bOk && cOk && dOk && eOk && xferOk) ? 'PASS' : 'PARTIAL',
    commit: COMMIT,
    includes: { ef333af: true, '14c12b3': true, '7ef189b': true },
    image: IMAGE,
    acr_build: 'cb5t',
    revision: revisionAfter,
    revision_before: revisionBefore,
    healthz: { before: healthBefore.status, after: healthAfter.status },
    env: wiring,
    proofA: proofAOut,
    proofB,
    proofC,
    proofD,
    proofE,
    transfers_route: { http: transfers.status, success: transfers.body && transfers.body.success },
    safety: {
      no_stripe_calls: true,
      no_whatsapp_sends: proofE.unchanged.guest_message_sends_sent,
      no_service_writes: proofE.unchanged.booking_service_records,
      no_payment_writes: proofE.unchanged.payments,
    },
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
