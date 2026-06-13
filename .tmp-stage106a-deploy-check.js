'use strict';

const https = require('https');

const HOST = 'staff-staging.lunafrontdesk.com';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:ce28869-stage106a-drawer-calendar-cleanup';

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
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const { execSync } = require('child_process');
  const rows = JSON.parse(execSync(
    'az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' }
  ));
  const active = rows.find((x) => x.properties.trafficWeight === 100) || {};

  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  if (login.status !== 200) throw new Error('login failed ' + login.status);
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  const ui = await req('GET', '/staff/ui', null, cookie);
  const s = ui.raw || '';
  const chips = s.match(/id="bc-chips"[\s\S]*?<\/div>\s*<\/div>/)?.[0] || '';
  const drawer = s.match(/function renderBookingContextDrawer[\s\S]*?\/\* ── Tour Operator/)?.[0] || '';
  const addPanel = s.match(/function bcRenderAddServicePanelHtml[\s\S]*?function bcNewAddServiceIdempotencyKey/)?.[0] || '';

  const bundle = {
    no_bc_summary: !/id="bc-summary"/.test(s),
    chips_order: /This week[\s\S]*Next 30 days[\s\S]*Jun - Jul[\s\S]*Jul - Aug[\s\S]*Aug - Sep/.test(chips),
    default_30_active: /data-chip="30days"[^>]*bc-chip-active/.test(chips),
    jun_jul_label: />Jun - Jul</.test(chips),
    jun_jul_handler: /key === 'jun-jul'[\s\S]{0,120}bcSetRange\('2026-06-01', '2026-07-31'/.test(s),
    aug_sep_handler: /key === 'aug-sept'[\s\S]{0,120}bcSetRange\('2026-08-01', '2026-09-30'/.test(s),
    no_ctx_nights_badge: !/ctx-nights-badge/.test(s),
    no_move_helper_copy: !/Select a source bed, then choose an available target bed/i.test(drawer),
    move_write_enabled: /BC_BOOKING_MOVE_WRITE\s*=\s*true/.test(s),
    addons_before_payment: /bcRenderAddServicePanelHtml[\s\S]*bcRenderRunningInvoiceHtml/.test(drawer),
    addons_header_buttons: /id="bc-add-ons-panel"[\s\S]*?Add-ons[\s\S]*?id="bc-add-service-btn"/.test(addPanel),
    dropdown_no_euro: !/option[^>]*>[^<]*€/.test(addPanel),
    meals_option: /value="meals"|staffAddonUiTypeLabel\('meals'\)/.test(addPanel),
    cancel_footer: /bcRenderBookingCancelFooterHtml/.test(s),
    no_stripe_api: !/api\.stripe\.com/.test(s),
    no_wa: !/graph\.facebook\.com/.test(s),
    no_n8n_activate: !/n8n\.cloud.*activate/i.test(s),
  };

  console.log(JSON.stringify({
    revision: {
      name: active.name,
      health: active.properties.healthState,
      traffic: active.properties.trafficWeight,
      image: active.properties.template.containers[0].image,
    },
    image_expected: IMAGE,
    bundle,
    bundle_pass: Object.values(bundle).every(Boolean),
  }, null, 2));
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
