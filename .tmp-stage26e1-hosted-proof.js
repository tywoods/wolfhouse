'use strict';
/** Stage 26e.1 hosted status proof — temp, do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = 'cf217ac75e47d68b2babf2ca423af5d24c4c3edf';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:cf217ac-stage26e-aviationstack-status';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path,
      method,
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
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed, raw });
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
    { encoding: 'utf8' },
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
  const app = JSON.parse(execSync(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' },
  ));
  const env = app.properties.template.containers[0].env || [];
  const pick = (name) => {
    const e = env.find((x) => x.name === name);
    if (!e) return null;
    if (e.secretRef) return { name, secretRef: e.secretRef };
    return { name, value: e.value };
  };
  const secrets = (app.properties.configuration.secrets || []).map((s) => s.name);
  return {
    AVIATIONSTACK_API_KEY: pick('AVIATIONSTACK_API_KEY'),
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
    has_aviationstack_secret: secrets.includes('aviationstack-api-key'),
    whatsapp_live_send_vars: env.filter((e) => /WHATSAPP.*SEND|META.*SEND/i.test(e.name) && e.value === 'true').map((e) => e.name),
  };
}

async function dbCounts() {
  const conn = process.env.PGCONN;
  if (!conn) return null;
  const c = new Client({ connectionString: conn });
  await c.connect();
  const q = async (s) => (await c.query(s)).rows[0].count;
  const out = {
    booking_transfers: await q('SELECT COUNT(*)::text AS count FROM booking_transfers'),
    bookings: await q('SELECT COUNT(*)::text AS count FROM bookings'),
    payments: await q('SELECT COUNT(*)::text AS count FROM payments'),
    guest_message_sends_sent: await q("SELECT COUNT(*)::text AS count FROM guest_message_sends WHERE status='sent'"),
  };
  await c.end();
  return out;
}

function leakScan(raw, body) {
  const s = raw + JSON.stringify(body || {});
  const forbidden = [
    /access_key\s*[:=]\s*["'][A-Za-z0-9]{8,}/i,
    /api[_-]?key\s*[:=]\s*["'][A-Za-z0-9]{8,}/i,
    /secret\s*[:=]\s*["'][A-Za-z0-9]{8,}/i,
    /[a-f0-9]{64}/i,
  ];
  const hits = forbidden.filter((re) => re.test(s)).map(String);
  const fp = body && body.key_fingerprint;
  const fpOk = typeof fp === 'string' && fp.length === 8 && /^[a-f0-9]{8}$/i.test(fp);
  return {
    no_obvious_key_leak: hits.length === 0,
    fingerprint_format_ok: fpOk,
    response_keys: body ? Object.keys(body) : [],
  };
}

(async () => {
  const revision = activeRevision();
  const wiring = envSummary();
  const healthz = await req('GET', '/healthz');

  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers && login.headers['set-cookie'])
    ? login.headers['set-cookie'].map((x) => x.split(';')[0]).join('; ')
    : '';
  let loginCookie = cookie;
  if (!loginCookie) {
    // headers not exposed on our wrapper; redo minimal login for cookie
    loginCookie = await new Promise((resolve, reject) => {
      const data = JSON.stringify({
        client: 'wolfhouse-somo',
        email: 'operator.stage72c@example.test',
        password: 'OperatorPass123!',
      });
      const r = https.request({
        hostname: HOST,
        path: '/staff/auth/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          resolve((res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; '));
        });
      });
      r.on('error', reject);
      r.write(data);
      r.end();
    });
  }

  const status = await req('GET', '/staff/transfers/flight-lookup/status', null, loginCookie);
  const leak = leakScan(status.raw, status.body);
  const afterCounts = await dbCounts();

  const body = status.body || {};
  const statusOk = status.status === 200
    && body.success === true
    && body.configured === true
    && body.provider === 'aviationstack'
    && body.key_present === true
    && body.key_source === 'AVIATIONSTACK_API_KEY'
    && typeof body.key_fingerprint === 'string'
    && body.key_fingerprint.length === 8;

  const deployOk = revision.health === 'Healthy'
    && revision.traffic === 100
    && revision.image === IMAGE;

  const pass = deployOk
    && healthz.status === 200
    && statusOk
    && leak.no_obvious_key_leak
    && leak.fingerprint_format_ok
    && wiring.AVIATIONSTACK_API_KEY?.secretRef === 'aviationstack-api-key'
    && wiring.WHATSAPP_DRY_RUN?.value === 'true'
    && wiring.STRIPE_LINKS_ENABLED?.value === 'false'
    && (wiring.whatsapp_live_send_vars || []).length === 0;

  console.log(JSON.stringify({
    result: pass ? 'PASS' : 'PARTIAL',
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb5n',
    revision,
    env_summary: wiring,
    healthz: { status: healthz.status },
    status_route: {
      http: status.status,
      body: status.body,
      leak_scan: leak,
    },
    after_counts: afterCounts,
    safety: {
      status_only: true,
      no_live_lookup_route: true,
      no_access_key_in_response: !/access_key/i.test(status.raw),
    },
  }, null, 2));
  process.exit(pass ? 0 : 2);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
