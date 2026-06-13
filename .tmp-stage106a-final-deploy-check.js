'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:590484f-stage106a-drawer-clean-final';
const COMMIT = '590484f';

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
  const bcStart = s.indexOf('id="tab-bed-calendar"');
  const bcEnd = s.indexOf('id="tab-tour-operator"', bcStart);
  const bcPanel = bcStart >= 0 && bcEnd > bcStart ? s.slice(bcStart, bcEnd) : '';

  const drawer = (() => {
    const i = s.indexOf('function renderBookingContextDrawer(data){');
    const j = s.indexOf('\n/* ── Tour Operator forms', i);
    return i >= 0 && j > i ? s.slice(i, j) : '';
  })();

  const out = {
    revision: {
      name: active.name,
      health: active.properties.healthState,
      traffic: active.properties.trafficWeight,
      image: active.properties.template.containers[0].image,
      move_write: (active.properties.template.containers[0].env || [])
        .find((e) => e.name === 'BOOKING_MOVE_WRITE_ENABLED')?.value,
    },
    calendar: {
      no_readonly_header: !/READ-ONLY BED CALENDAR/i.test(bcPanel),
      no_edits_disabled_header: !/edits disabled/i.test(bcPanel),
      no_summary: !/id="bc-summary"/.test(bcPanel),
      chips: /This week[\s\S]*Next 30 days[\s\S]*Jun - Jul[\s\S]*Jul - Aug[\s\S]*Aug - Sep/.test(bcPanel),
      has_controls: /id="bc-start"/.test(bcPanel) && /id="bc-end"/.test(bcPanel) && /id="bc-load"/.test(bcPanel),
    },
    drawer: {
      no_planned: !/Planned operations/.test(drawer),
      no_write_gates: !/write gates approved/i.test(drawer),
      no_bc_detail_note: !/bc-detail-note[\s\S]{0,80}read-only/i.test(s),
      no_ctx_nights_badge: !/ctx-nights-badge/.test(drawer),
      compact_fields: /ctx-field-edit-group/.test(drawer) && !/ctx-section ctx-field-edit-group/.test(drawer),
      move_label: />Move bed</.test(drawer) && /id="bc-move-booking-btn"/.test(drawer),
      move_enabled_ui: /BC_BOOKING_MOVE_WRITE\s*=\s*true/.test(s),
      addons_before_pay: /bcRenderAddServicePanelHtml[\s\S]*bcRenderRunningInvoiceHtml/.test(drawer),
      cancel_footer: /bc-cancel-reservation-btn/.test(drawer),
    },
    safety: {
      no_stripe: !/api\.stripe\.com/.test(s),
      no_wa: !/graph\.facebook\.com/.test(s),
      no_n8n: !/n8n\.cloud.*activate/i.test(s),
    },
  };

  out.pass = {
    deploy: out.revision.health === 'Healthy' && out.revision.traffic === 100
      && out.revision.image === IMAGE,
    calendar: Object.values(out.calendar).every(Boolean),
    drawer: Object.values(out.drawer).every(Boolean),
    safety: Object.values(out.safety).every(Boolean),
  };
  out.result = Object.values(out.pass).every(Boolean) ? 'PASS' : 'PARTIAL';

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
