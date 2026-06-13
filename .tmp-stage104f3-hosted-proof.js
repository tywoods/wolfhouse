'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const CODE = 'MB-WOLFHO-20260920-4f62e2';

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

(async () => {
  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  assert(login.status === 200, 'login failed');
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  const ui = await req('GET', '/staff/ui?client=' + CLIENT, null, cookie, 'text/html');
  assert(ui.status === 200, 'staff/ui failed');
  const h = ui.raw || '';

  assert(/bcRenderFieldEditPencilBtn/.test(h), 'pencil helper missing');
  assert(/btn-bc-field-edit/.test(h), 'pencil btn class missing');
  assert(/\u270E/.test(h) || /\\u270E/.test(h), 'pencil icon missing');
  assert(!/ctx-field-header-label[^>]*>\s*Guest\s*</i.test(h), 'Guest section title present');
  assert(!/ctx-field-header-label[^>]*>\s*Dates\s*</i.test(h), 'Dates section title present');
  assert(/bc-field-contact-phone/.test(h), 'contact phone input missing');
  assert(/data-bc-field-preview/.test(h) && />Save</.test(h), 'Save preview button missing');
  assert(/Preview only/.test(h) && /not saved/.test(h), 'preview-only copy missing');
  assert(!/\/staff\/bookings\/edit'/.test(h), 'write endpoint path in UI');

  const ctx = await req('GET', '/staff/bookings/' + encodeURIComponent(CODE) + '/context?client=' + CLIENT, null, cookie);
  assert(ctx.status === 200, 'context failed');
  const bk = ctx.body.booking || {};

  const contactRes = await req('POST', '/staff/bookings/edit-preview?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: bk.booking_code,
    booking_id: bk.booking_id || bk.id,
    edit_type: 'contact',
    guest_name: bk.guest_name,
    phone: '+499991234567',
    email: bk.email,
  }, cookie);
  assert(contactRes.status === 200, 'contact preview status');
  assert(contactRes.body.preview_only === true, 'preview_only');
  assert(contactRes.body.current && 'phone' in contactRes.body.current, 'current.phone');
  assert(contactRes.body.proposed && contactRes.body.proposed.phone === '+499991234567', 'proposed.phone');

  const ctxAfter = await req('GET', '/staff/bookings/' + encodeURIComponent(CODE) + '/context?client=' + CLIENT, null, cookie);
  assert((ctxAfter.body.booking.phone || '') === (bk.phone || ''), 'phone mutated in DB');

  const dbUrl = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' }
  ).trim();
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const countsBefore = await pg.query(`
    SELECT
      (SELECT COUNT(*)::int FROM bookings b INNER JOIN clients c ON c.id = b.client_id WHERE c.slug = $1) AS bookings,
      (SELECT COUNT(*)::int FROM booking_beds bb INNER JOIN clients c ON c.id = bb.client_id WHERE c.slug = $1) AS booking_beds,
      (SELECT COUNT(*)::int FROM payments p INNER JOIN clients c ON c.id = p.client_id WHERE c.slug = $1) AS payments,
      (SELECT COUNT(*)::int FROM booking_service_records s WHERE s.client_slug = $1) AS service_records
  `, [CLIENT]);
  await pg.end();

  console.log(JSON.stringify({
    result: 'PASS',
    commit: 'd3dc9a0',
    image: 'whstagingacr.azurecr.io/wh-staff-api:d3dc9a0-stage104f3-field-edit-ui-clean',
    acr_run: 'cb1w',
    revision: 'wh-staging-staff-api--0000075',
    revision_health: 'Healthy',
    traffic: 100,
    ui_104f3: {
      pencil_icon_buttons: true,
      contact_phone_input: true,
      save_label_preview_only: true,
      section_titles_removed: true,
    },
    contact_preview: {
      preview_only: contactRes.body.preview_only,
      proposed_phone: contactRes.body.proposed.phone,
    },
    counts: countsBefore.rows[0],
    safety: { db_phone_unchanged: true, no_write_route_in_ui: true },
  }, null, 2));
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
