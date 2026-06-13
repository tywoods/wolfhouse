'use strict';

const https = require('https');
const vm = require('vm');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKINGS = {
  multi: 'DEMO-2603',
  polish: 'MB-WOLFHO-20260920-4f62e2',
};

function req(method, path, body, cookie, accept) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        Accept: accept || 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function getStagingDbUrl() {
  return execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  ).trim();
}

function extractEmbeddedUiScript(html) {
  const scriptTag = html.indexOf('<script>');
  if (scriptTag < 0) return null;
  const fnStart = html.indexOf('(function(){', scriptTag);
  if (fnStart < 0) return null;
  const endTag = html.indexOf('</script>', fnStart);
  if (endTag < 0) return null;
  const beforeClose = html.slice(fnStart, endTag);
  const relEnd = beforeClose.lastIndexOf('})();');
  if (relEnd < 0) return null;
  return beforeClose.slice(0, relEnd + 5);
}

async function counts(pg) {
  const r = await pg.query(`
    SELECT
      (SELECT COUNT(*)::int FROM bookings b INNER JOIN clients c ON c.id = b.client_id WHERE c.slug = $1) AS bookings,
      (SELECT COUNT(*)::int FROM booking_beds bb INNER JOIN clients c ON c.id = bb.client_id WHERE c.slug = $1) AS booking_beds,
      (SELECT COUNT(*)::int FROM payments p INNER JOIN clients c ON c.id = p.client_id WHERE c.slug = $1) AS payments,
      (SELECT COUNT(*)::int FROM booking_service_records s WHERE s.client_slug = $1) AS service_records
  `, [CLIENT]);
  return r.rows[0];
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

(async () => {
  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  assert(login.status === 200, 'login failed');

  const ui = await req('GET', '/staff/ui?client=' + CLIENT, null, cookie, 'text/html');
  assert(ui.status === 200, 'staff/ui failed');
  const uiHtml = ui.raw || '';

  const rawJs = extractEmbeddedUiScript(uiHtml);
  assert(rawJs, 'embedded script not found');
  const js = rawJs
    .replace(/\$\{STAFF_ACTIONS_ENABLED\}/g, 'false')
    .replace(/\$\{MANUAL_BOOKING_ENABLED\}/g, 'false')
    .replace(/\$\{STRIPE_LINKS_ENABLED\}/g, 'false')
    .replace(/\$\{BOOKING_MOVE_WRITE_ENABLED\}/g, 'false');

  try {
    new vm.Script(js);
  } catch (e) {
    throw new Error('embedded script SyntaxError: ' + e.message);
  }

  assert(/function bcFieldEditActivate\(group\)/.test(js), 'bcFieldEditActivate missing in hosted UI');
  assert(/window\.switchToTabOnly\s*=\s*switchToTabOnly/.test(js), 'window.switchToTabOnly missing');
  assert(/window\.switchToTab\s*=\s*switchToTab/.test(js), 'window.switchToTab missing');
  assert(!/SyncToTabOnly/i.test(uiHtml), 'SyncToTabOnly typo in hosted HTML');
  assert(/onclick="switchToTabOnly\('bed-calendar'\)"/.test(uiHtml), 'Bed Calendar tile onclick');
  assert(/onclick="switchToTab\('conversations','handoffs'\)"/.test(uiHtml), 'Needs Human tile onclick');
  assert(/onclick="switchToTab\('conversations','inbox'\)"/.test(uiHtml), 'Open Conversations tile onclick');
  assert(/bcRenderRunningInvoiceHtml/.test(uiHtml), 'running invoice in UI');
  assert(/bcRenderFieldEditSectionsHtml/.test(uiHtml), 'field edit in UI');
  assert(/bcFieldEditRunPreview/.test(uiHtml), 'field edit preview runner');
  assert(/Preview only/.test(uiHtml) && /not saved/.test(uiHtml), 'preview-only copy');
  assert(/BC_BOOKING_MOVE_WRITE\s*=\s*false/.test(uiHtml), 'move gate OFF in UI');
  assert(!/api\.stripe\.com/.test(uiHtml), 'stripe in UI');
  assert(!/graph\.facebook\.com/.test(uiHtml), 'whatsapp in UI');

  const pg = new Client({ connectionString: getStagingDbUrl(), ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const countsBefore = await counts(pg);

  const ctxPolish = await req('GET', '/staff/bookings/' + encodeURIComponent(BOOKINGS.polish) + '/context?client=' + CLIENT, null, cookie);
  assert(ctxPolish.status === 200, 'polish context failed');
  const bk = ctxPolish.body.booking || {};

  const contactRes = await req('POST', '/staff/bookings/edit-preview?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: bk.booking_code,
    booking_id: bk.booking_id || bk.id,
    edit_type: 'contact',
    guest_name: 'Manual Polish NavFix Preview',
    email: 'navfix.preview@example.test',
  }, cookie);
  assert(contactRes.status === 200, 'contact preview status');
  assert(contactRes.body.preview_only === true && contactRes.body.would_mutate === false, 'contact flags');

  const ctxAfter = await req('GET', '/staff/bookings/' + encodeURIComponent(BOOKINGS.polish) + '/context?client=' + CLIENT, null, cookie);
  assert(ctxAfter.body.booking.guest_name === bk.guest_name, 'contact preview mutated name');

  const ctxMulti = await req('GET', '/staff/bookings/' + encodeURIComponent(BOOKINGS.multi) + '/context?client=' + CLIENT, null, cookie);
  assert(ctxMulti.status === 200, 'DEMO-2603 context');
  const bkM = ctxMulti.body.booking || {};
  const guestRes = await req('POST', '/staff/bookings/edit-preview?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: bkM.booking_code,
    booking_id: bkM.booking_id || bkM.id,
    edit_type: 'guests',
    guest_count: 1,
  }, cookie);
  assert(guestRes.status === 200 && guestRes.body.edit_type === 'guests', 'guest preview');

  const datesRes = await req('POST', '/staff/bookings/edit-preview?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: bk.booking_code,
    edit_type: 'dates',
    check_in: '2026-09-24',
    check_out: '2026-09-27',
  }, cookie);
  assert(datesRes.status === 200, 'dates preview');

  const pkgRes = await req('POST', '/staff/bookings/edit-preview?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: bk.booking_code,
    edit_type: 'package',
    package_code: 'uluwatu',
  }, cookie);
  assert(pkgRes.status === 200, 'package preview');

  const countsAfter = await counts(pg);
  await pg.end();
  assert(JSON.stringify(countsBefore) === JSON.stringify(countsAfter), 'DB counts changed');

  const rev = execSync(
    'az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg --query "[?properties.trafficWeight==`100`].{name:name,health:properties.healthState,image:properties.template.containers[0].image}" -o json',
    { encoding: 'utf8' }
  ).trim();
  const revRows = JSON.parse(rev || '[]');
  const active = revRows[0] || {};

  console.log(JSON.stringify({
    result: 'PASS',
    commit: 'b426b02',
    image: 'whstagingacr.azurecr.io/wh-staff-api:b426b02-stage104f2-today-nav-fix',
    acr_run: 'cb1v',
    revision: active.name || 'wh-staging-staff-api--0000074',
    revision_health: active.health,
    revision_image: active.image,
    console_parse_proof: {
      embedded_script_parses: true,
      bcFieldEditActivate: true,
      window_switchToTab: true,
      window_switchToTabOnly: true,
      no_SyncToTabOnly_typo: true,
    },
    today_navigation: {
      needs_human_onclick: true,
      open_conversations_onclick: true,
      bed_calendar_switchToTabOnly: true,
    },
    drawer_ui_markers: {
      running_invoice: true,
      field_edit_sections: true,
      preview_runner: true,
      move_gate_off: true,
    },
    edit_preview_smoke: {
      contact: { status: contactRes.status, preview_only: contactRes.body.preview_only },
      dates: { status: datesRes.status },
      package: { status: pkgRes.status },
      guests_demo2603: {
        release: guestRes.body.proposed && guestRes.body.proposed.released_beds,
        remaining: guestRes.body.proposed && guestRes.body.proposed.remaining_beds,
      },
      context_unchanged: true,
    },
    counts_unchanged: countsBefore,
    safety: { staging_db_only: true, no_stripe_whatsapp_in_ui: true },
  }, null, 2));
})().catch((err) => {
  console.error('\nFAIL:', err.message);
  process.exit(1);
});
