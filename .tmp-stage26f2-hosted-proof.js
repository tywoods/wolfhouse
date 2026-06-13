'use strict';
/** Stage 26f.2 hosted proof — temp, do not commit. */
const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const BOOKING_ID = 'adf70f79-c750-458d-a306-97c81304898b';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path,
      method,
      headers: {
        Accept: 'application/json,text/html',
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

(async () => {
  const rows = JSON.parse(execSync(
    'az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' },
  ));
  const rev = rows.find((x) => x.properties.trafficWeight === 100) || {};
  const health = await req('GET', '/healthz');
  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const ui = await req('GET', '/staff/ui', null, cookie);
  const h = ui.raw || '';

  async function lookupFlight(fn) {
    return req('POST', `/staff/bookings/${BOOKING_ID}/transfers/lookup-flight`, {
      client_slug: 'wolfhouse-somo',
      direction: 'arrival',
      airport_code: 'SDR',
      flight_number: fn,
    }, cookie);
  }

  const ane = await lookupFlight('ANE1064');
  const ryr = await lookupFlight('RYR7153');
  const blob = JSON.stringify({ ane: ane.body, ryr: ryr.body });

  const out = {
    result: 'PENDING',
    commit: '7677258',
    image: rev.properties?.template?.containers?.[0]?.image,
    revision: { name: rev.name, health: rev.properties?.healthState, traffic: rev.properties?.trafficWeight },
    healthz: health.status,
    tabs: {
      drawerTabs: h.includes('bc-drawer-tabs'),
      overview: h.includes('bc-drawer-tab-overview'),
      services: h.includes('bc-drawer-tab-services'),
      transfers: h.includes('bc-drawer-tab-transfers'),
      payments: h.includes('bc-drawer-tab-payments'),
      paymentSummaryBrief: h.includes('bc-payment-summary-brief'),
      servicesLabel: h.includes('bc-add-ons-title">Services'),
      initTabs: h.includes('bcInitDrawerTabs'),
      runningInvoiceInPayments: /bc-drawer-tab-payments[\s\S]{0,400}bc-running-invoice/.test(h),
    },
    lookups: {
      ANE1064: {
        status: ane.status,
        error: ane.body.error,
        message: ane.body.message,
        diagnostic: ane.body.diagnostic,
      },
      RYR7153: {
        status: ryr.status,
        error: ryr.body.error,
        message: ryr.body.message,
        diagnostic: ryr.body.diagnostic,
      },
    },
    noKeyLeak: !/access_key|AVIATIONSTACK_API_KEY=[A-Za-z0-9]{8,}/i.test(blob),
  };

  const tabsOk = Object.values(out.tabs).every(Boolean);
  const lookupOk = ane.body.message && ryr.body.message
    && ane.body.diagnostic && Array.isArray(ane.body.diagnostic.lookup_dates_tried)
    && ane.body.error !== 'aviationstack_api_error';
  out.result = (health.status === 200 && rev.properties?.healthState === 'Healthy'
    && out.image && out.image.includes('7677258-stage26f2-drawer-diagnostics')
    && tabsOk && lookupOk && out.noKeyLeak) ? 'PASS' : 'PARTIAL';

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'PASS' ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
