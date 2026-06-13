'use strict';
const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:e27ed93-stage106a-compact-drawer-fields';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        Accept: 'application/json,text/html',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const rows = JSON.parse(execSync(
    'az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' }
  ));
  const active = rows.find((x) => x.properties.trafficWeight === 100) || {};

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  const ui = await req('GET', '/staff/ui', null, cookie);
  const s = ui.raw || '';

  const out = {
    revision: {
      name: active.name,
      health: active.properties.healthState,
      traffic: active.properties.trafficWeight,
      image: active.properties.template.containers[0].image,
    },
    bundle: {
      horizontal_rows: /\.ctx-field-read-row/.test(s),
      row_kv_flex: /\.ctx-field-read-row \.kv-grid\{flex:1;display:flex;flex-direction:row/.test(s),
      no_vertical_override: !/#bc-ctx-body \.ctx-field-edit-group \.kv-grid\{display:flex;flex-direction:column/.test(s),
      move_bed: /id="bc-move-bed"/.test(s),
      addons_before_pay: /bcRenderAddServicePanelHtml[\s\S]*bcRenderRunningInvoiceHtml/.test(
        (() => {
          const i = s.indexOf('function renderBookingContextDrawer(data){');
          const j = s.indexOf('\n/* ── Tour Operator forms', i);
          return i >= 0 && j > i ? s.slice(i, j) : '';
        })()
      ),
      cancel_footer: /bc-cancel-reservation-btn/.test(s),
      no_stripe: !/api\.stripe\.com/.test(s),
      no_wa: !/graph\.facebook\.com/.test(s),
      no_n8n: !/n8n\.cloud.*activate/i.test(s),
      no_readonly_gate: !/write gates approved|Bed calendar is read-only/i.test(s),
    },
  };
  out.pass = out.revision.health === 'Healthy' && out.revision.traffic === 100
    && out.revision.image === IMAGE && Object.values(out.bundle).every(Boolean);
  out.result = out.pass ? 'PASS' : 'PARTIAL';
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
