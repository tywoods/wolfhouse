'use strict';
/** Stage 26f.1 hosted proof — temp, do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = 'cd1b5c4';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:cd1b5c4-stage26f1-transfer-ui-cleanup';
const BOOKING_ID = 'adf70f79-c750-458d-a306-97c81304898b';
const BOOKING_CODE = 'MB-WOLFHO-20291001-9dcb42';
const CLIENT = 'wolfhouse-somo';
const START = '2029-10-01';
const END = '2029-10-04';

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
        try { parsed = JSON.parse(raw); } catch { /* keep string */ }
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
    whatsapp_live_send_vars: env.filter((e) => /WHATSAPP.*SEND|META.*SEND/i.test(e.name) && e.value === 'true').map((e) => e.name),
  };
}

async function dbCounts() {
  const conn = process.env.PGCONN;
  if (!conn) return null;
  const c = new Client({ connectionString: conn });
  await c.connect();
  const q = async (s, p) => (await c.query(s, p)).rows[0];
  const out = {
    bookings: (await q('SELECT COUNT(*)::text AS count FROM bookings')).count,
    payments: (await q('SELECT COUNT(*)::text AS count FROM payments')).count,
    guest_message_sends_sent: (await q("SELECT COUNT(*)::text AS count FROM guest_message_sends WHERE status='sent'")).count,
    booking_transfers_total: (await q('SELECT COUNT(*)::text AS count FROM booking_transfers')).count,
    booking_transfers_for_test: (await q(
      'SELECT COUNT(*)::text AS count FROM booking_transfers WHERE booking_id = $1',
      [BOOKING_ID],
    )).count,
  };
  await c.end();
  return out;
}

function uiChecks(html) {
  const sliceStart = html.indexOf('Phase 26c/26f/26f.1');
  const slice = sliceStart >= 0 ? html.slice(sliceStart, sliceStart + 12000) : '';
  const moveIdx = html.indexOf('ctx-move-bed');
  const addonsIdx = html.indexOf('bcRenderAddServicePanelHtml');
  return {
    has_transfer_section: html.includes('Flight / Transfer Details'),
    has_arrival_card: html.includes("bcRenderTransferCard('arrival'"),
    has_departure_card: html.includes("bcRenderTransferCard('departure'"),
    no_status_dropdown: !/prefix \+ '-status'|bcTransferStatusOptions/.test(slice),
    no_guest_count_transfer: !/prefix \+ '-guest-count'/.test(slice),
    no_lookup_date: !/prefix \+ '-lookup-date'/.test(slice),
    no_pickup_dropoff: !/prefix \+ '-pickup'|prefix \+ '-dropoff'|Pickup location|Dropoff location/.test(slice),
    has_airport: /prefix \+ '-airport'/.test(slice),
    default_sdr: /default_airport_code|'\s*SDR\s*'/.test(slice),
    has_flight: /prefix \+ '-flight'/.test(slice),
    has_scheduled: /prefix \+ '-scheduled'/.test(slice),
    has_notes: /prefix \+ '-notes'/.test(slice),
    has_lookup_btn: html.includes('Lookup flight') && html.includes('bc-transfer-lookup'),
    has_save_arrival: html.includes('Save arrival transfer'),
    has_save_departure: html.includes('Save departure transfer'),
    addons_below_move_bed: moveIdx >= 0 && addonsIdx > moveIdx,
    compact_grid: html.includes('bc-transfer-grid'),
    no_old_lookup_date_ui: !html.includes('Lookup date') || !slice.includes('Lookup date'),
    no_flight_lookup_placeholder: !html.includes('Flight lookup coming next'),
  };
}

(async () => {
  const beforeCounts = await dbCounts();
  const revision = activeRevision();
  const wiring = envSummary();
  const healthz = await req('GET', '/healthz');

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');

  const ui = await req('GET', '/staff/ui', null, cookie);
  const uiHtml = ui.raw || '';
  const uiProof = uiChecks(uiHtml);

  const getTransfers = await req(
    'GET',
    `/staff/bookings/${BOOKING_ID}/transfers?client_slug=${encodeURIComponent(CLIENT)}`,
    null,
    cookie,
  );

  const savePayload = {
    client_slug: CLIENT,
    direction: 'arrival',
    airport_code: 'SDR',
    flight_number: 'TEST26F1',
    notes: 'Stage 26f.1 compact UI proof',
    source: 'staff',
  };
  const save = await req('POST', `/staff/bookings/${BOOKING_ID}/transfers`, savePayload, cookie);

  const lookupPayload = {
    client_slug: CLIENT,
    direction: 'arrival',
    airport_code: 'SDR',
    flight_number: 'ZZNOTFOUND26F1',
  };
  const lookup = await req(
    'POST',
    `/staff/bookings/${BOOKING_ID}/transfers/lookup-flight`,
    lookupPayload,
    cookie,
  );

  const cal = await req(
    'GET',
    `/staff/bed-calendar?client=${encodeURIComponent(CLIENT)}&start=${START}&end=${END}`,
    null,
    cookie,
  );
  const blocks = (cal.body && cal.body.blocks) || [];
  const testBlock = blocks.find((b) => b.booking_id === BOOKING_ID || b.booking_code === BOOKING_CODE);

  const getAfterSave = await req(
    'GET',
    `/staff/bookings/${BOOKING_ID}/transfers?client_slug=${encodeURIComponent(CLIENT)}`,
    null,
    cookie,
  );
  const transferRowsAfter = (getAfterSave.body && getAfterSave.body.transfers) || [];
  const arrivalRow = transferRowsAfter.find((t) => t.direction === 'arrival');

  const afterCounts = await dbCounts();
  const healthzAfter = await req('GET', '/healthz');

  const defaults = getTransfers.body && getTransfers.body.defaults;
  const airports = (getTransfers.body && getTransfers.body.airports) || [];
  const airportCodes = airports.map((a) => a.code);

  const proofB = {
    http: getTransfers.status,
    success: getTransfers.body && getTransfers.body.success,
    arrival_default: defaults && defaults.arrival_lookup_date,
    departure_default: defaults && defaults.departure_lookup_date,
    default_airport_code: defaults && defaults.default_airport_code,
    airports: airportCodes,
    transfer_count: (getTransfers.body && getTransfers.body.transfers || []).length,
  };

  const proofC = {
    http: save.status,
    success: save.body && save.body.success,
    status: save.body && save.body.transfer && save.body.transfer.status,
    guest_count: save.body && save.body.transfer && save.body.transfer.guest_count,
    pricing: save.body && save.body.pricing,
    no_payment_write: save.body && save.body.no_payment_write,
    notes: save.body && save.body.transfer && save.body.transfer.notes,
    flight_number: save.body && save.body.transfer && save.body.transfer.flight_number,
  };

  const proofD = {
    http: lookup.status,
    success: lookup.body && lookup.body.success,
    error: lookup.body && lookup.body.error,
    message: lookup.body && lookup.body.message,
    no_transfer_write: lookup.body && lookup.body.no_transfer_write,
    no_payment_write: lookup.body && lookup.body.no_payment_write,
    has_suggested_patch: !!(lookup.body && lookup.body.suggested_transfer_patch),
  };

  const proofE = {
    calendar_http: cal.status,
    has_transfer: !!(testBlock && testBlock.transfer_summary && testBlock.transfer_summary.has_transfer),
    transfer_summary: testBlock && testBlock.transfer_summary,
    ui_has_pebble_css: uiHtml.includes('.transfer-pebble'),
    ui_has_transfer_text: uiHtml.includes('>Transfer<'),
    drawer_has_transfer_section: uiHtml.includes('Flight / Transfer Details'),
    arrival_loaded: !!arrivalRow,
  };

  const deployOk = revision.image === IMAGE
    && revision.health === 'Healthy'
    && revision.traffic === 100;

  const envOk = wiring.AVIATIONSTACK_API_KEY && wiring.AVIATIONSTACK_API_KEY.secretRef === 'aviationstack-api-key'
    && wiring.WHATSAPP_DRY_RUN && wiring.WHATSAPP_DRY_RUN.value === 'true'
    && wiring.STRIPE_LINKS_ENABLED && wiring.STRIPE_LINKS_ENABLED.value === 'false'
    && (wiring.whatsapp_live_send_vars || []).length === 0;

  const proofBOk = getTransfers.status === 200
    && getTransfers.body.success
    && defaults.arrival_lookup_date === '2029-10-01'
    && defaults.departure_lookup_date === '2029-10-04'
    && defaults.default_airport_code === 'SDR'
    && airportCodes.includes('SDR') && airportCodes.includes('BIO');

  const proofCOk = save.status === 200
    && save.body.success
    && save.body.transfer.status === 'requested'
    && save.body.no_payment_write === true
    && save.body.transfer.flight_number === 'TEST26F1'
    && Number(save.body.transfer.guest_count) >= 1;

  const proofDOk = lookup.status === 404
    && lookup.body && lookup.body.success === false
    && lookup.body.error === 'flight_not_found'
    && lookup.body.message && lookup.body.message.includes('Enter the flight details manually')
    && lookup.body.no_transfer_write === true
    && lookup.body.no_payment_write === true;

  const proofEOk = cal.status === 200
    && testBlock && testBlock.transfer_summary && testBlock.transfer_summary.has_transfer === true
    && uiProof.has_transfer_pebble_css !== false;

  const uiOk = Object.entries(uiProof).every(([k, v]) => {
    if (k.startsWith('no_') || k === 'no_old_lookup_date_ui' || k === 'no_flight_lookup_placeholder') return v === true;
    return v === true;
  });

  const countsOk = beforeCounts && afterCounts
    && beforeCounts.bookings === afterCounts.bookings
    && beforeCounts.payments === afterCounts.payments
    && beforeCounts.guest_message_sends_sent === afterCounts.guest_message_sends_sent
    && Number(afterCounts.booking_transfers_for_test) <= 2;

  const pass = deployOk && envOk
    && healthz.status === 200 && healthzAfter.status === 200
    && uiOk && proofBOk && proofCOk && proofDOk && proofEOk
    && countsOk;

  console.log(JSON.stringify({
    result: pass ? 'PASS' : 'PARTIAL',
    commit: COMMIT,
    image: IMAGE,
    revision,
    env: wiring,
    healthz_before: healthz.status,
    healthz_after: healthzAfter.status,
    proofA_ui: uiProof,
    proofB_get_transfers: proofB,
    proofC_save: proofC,
    proofD_lookup: proofD,
    proofE_calendar: proofE,
    before_counts: beforeCounts,
    after_counts: afterCounts,
    safety: {
      bookings_unchanged: beforeCounts && afterCounts && beforeCounts.bookings === afterCounts.bookings,
      payments_unchanged: beforeCounts && afterCounts && beforeCounts.payments === afterCounts.payments,
      guest_sends_unchanged: beforeCounts && afterCounts && beforeCounts.guest_message_sends_sent === afterCounts.guest_message_sends_sent,
      no_stripe_in_ui: !/api\.stripe\.com|stripe\.com\/v1/.test(uiHtml),
    },
    checks: { deployOk, envOk, uiOk, proofBOk, proofCOk, proofDOk, proofEOk, countsOk },
  }, null, 2));
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
