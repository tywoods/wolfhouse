'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKINGS = {
  multi: 'DEMO-2603',
  polish: 'MB-WOLFHO-20260920-4f62e2',
  addons: 'MB-WOLFHO-20260901-cb4799',
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

async function login() {
  const res = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  assert(res.status === 200, 'login failed: ' + res.status);
  const cookie = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  return cookie;
}

async function context(cookie, code) {
  const res = await req('GET', '/staff/bookings/' + encodeURIComponent(code) + '/context?client=' + CLIENT, null, cookie);
  assert(res.status === 200, code + ' context failed: ' + res.status);
  return res.body;
}

async function editPreview(cookie, payload) {
  return req('POST', '/staff/bookings/edit-preview?client=' + CLIENT, payload, cookie);
}

function checkRunningInvoiceUi(uiHtml) {
  assert(/bcRenderRunningInvoiceHtml/.test(uiHtml), 'missing bcRenderRunningInvoiceHtml');
  assert(/bc-inv-accommodation/.test(uiHtml), 'missing bc-inv-accommodation');
  assert(/bc-inv-addons/.test(uiHtml), 'missing bc-inv-addons');
  assert(/bc-inv-totals/.test(uiHtml), 'missing bc-inv-totals');
  assert(/Stripe\/webhook payments remain payment truth/.test(uiHtml), 'missing payment truth copy');
  assert(!/id="bc-service-records"/.test(uiHtml), 'legacy bc-service-records panel');
  assert(!/api\.stripe\.com/.test(uiHtml), 'api.stripe.com in UI');
  assert(!/graph\.facebook\.com/.test(uiHtml), 'graph.facebook.com in UI');
}

function checkFieldEditUi(uiHtml) {
  assert(/bcRenderFieldEditSectionsHtml/.test(uiHtml), 'missing field edit sections');
  assert(/data-bc-field-group="contact"/.test(uiHtml), 'missing contact edit group');
  assert(/data-bc-field-group="dates"/.test(uiHtml), 'missing dates edit group');
  assert(/data-bc-field-group="package"/.test(uiHtml), 'missing package edit group');
  assert(/data-bc-field-group="guests"/.test(uiHtml), 'missing guests edit group');
  assert(/bcFieldEditRunPreview/.test(uiHtml), 'missing preview runner');
  assert(/\/staff\/bookings\/edit-preview/.test(uiHtml), 'missing edit-preview fetch');
  assert(/Preview only/.test(uiHtml) && /not saved/.test(uiHtml), 'missing preview-only copy');
  assert(!/bc-field-save/.test(uiHtml), 'save button marker found');
  assert(/BC_BOOKING_MOVE_WRITE\s*=\s*false/.test(uiHtml), 'move write gate not OFF in UI');
  assert(/cout\.value <= cin\.value/.test(uiHtml), 'missing client date validation');
  assert(/for \(var g = current; g >= 1; g--\)/.test(uiHtml) || /g >= 1; g--/.test(uiHtml), 'guest dropdown down-only loop');
}

(async () => {
  const cookie = await login();
  const ui = await req('GET', '/staff/ui?client=' + CLIENT, null, cookie, 'text/html');
  assert(ui.status === 200, 'staff/ui failed');
  const uiHtml = ui.raw || '';
  checkRunningInvoiceUi(uiHtml);
  checkFieldEditUi(uiHtml);

  const pg = new Client({ connectionString: getStagingDbUrl(), ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const countsBefore = await counts(pg);

  const ctxMulti = await context(cookie, BOOKINGS.multi);
  const ctxPolish = await context(cookie, BOOKINGS.polish);
  const ctxAddons = await context(cookie, BOOKINGS.addons);

  const bkMulti = ctxMulti.booking || {};
  const bkPolish = ctxPolish.booking || {};
  const bkAddons = ctxAddons.booking || {};

  assert((ctxAddons.service_records || []).length > 0, 'addon booking needs service_records');
  assert((ctxPolish.service_records || []).length === 0, 'polish booking should have no addons');

  // Running invoice markers in context (read-only data paths)
  for (const label of ['multi', 'polish', 'addons']) {
    const bk = label === 'multi' ? bkMulti : label === 'polish' ? bkPolish : bkAddons;
    console.log('booking', bk.booking_code, 'guests', bk.guest_count, 'beds', (bk.beds || bk.assigned_beds || []).length || '?');
  }

  // Contact preview — polish test
  const contactRes = await editPreview(cookie, {
    client_slug: CLIENT,
    booking_code: bkPolish.booking_code,
    booking_id: bkPolish.booking_id || bkPolish.id,
    edit_type: 'contact',
    guest_name: 'Manual Polish Preview',
    email: 'preview.polish@example.test',
  });
  assert(contactRes.status === 200, 'contact preview status');
  const contact = contactRes.body;
  assert(contact.preview_only === true && contact.would_mutate === false, 'contact preview flags');
  assert(contact.edit_type === 'contact', 'contact edit_type');
  assert(contact.proposed && contact.proposed.guest_name === 'Manual Polish Preview', 'contact proposed name');
  assert(/No changes were saved/i.test(contact.message || ''), 'contact not-saved message');

  // Dates preview — polish, safe range
  const datesRes = await editPreview(cookie, {
    client_slug: CLIENT,
    booking_code: bkPolish.booking_code,
    booking_id: bkPolish.booking_id || bkPolish.id,
    edit_type: 'dates',
    check_in: '2026-09-24',
    check_out: '2026-09-27',
  });
  assert(datesRes.status === 200, 'dates preview status');
  const dates = datesRes.body;
  assert(dates.edit_type === 'dates' && dates.preview_only === true, 'dates flags');
  assert(dates.proposed && dates.proposed.check_in === '2026-09-24', 'dates proposed');
  assert(dates.invoice_preview, 'dates invoice_preview');

  // Invalid dates API
  const datesBad = await editPreview(cookie, {
    client_slug: CLIENT,
    booking_code: bkPolish.booking_code,
    edit_type: 'dates',
    check_in: '2026-09-27',
    check_out: '2026-09-24',
  });
  assert(datesBad.status === 400, 'invalid dates should 400');

  // Package preview — polish
  const curPkg = String(bkPolish.package_code || 'malibu').toLowerCase();
  const altPkg = curPkg === 'malibu' ? 'uluwatu' : 'malibu';
  const pkgRes = await editPreview(cookie, {
    client_slug: CLIENT,
    booking_code: bkPolish.booking_code,
    edit_type: 'package',
    package_code: altPkg,
  });
  assert(pkgRes.status === 200, 'package preview status');
  const pkg = pkgRes.body;
  assert(pkg.edit_type === 'package' && pkg.preview_only === true, 'package flags');
  assert(pkg.proposed && pkg.proposed.package_code === altPkg, 'package proposed');

  // Guest decrease — DEMO-2603
  const guestCount = Math.max(1, Number(bkMulti.guest_count) || 2);
  assert(guestCount >= 2, 'DEMO-2603 expected >=2 guests');
  const guestRes = await editPreview(cookie, {
    client_slug: CLIENT,
    booking_code: bkMulti.booking_code,
    booking_id: bkMulti.booking_id || bkMulti.id,
    edit_type: 'guests',
    guest_count: 1,
  });
  assert(guestRes.status === 200, 'guest preview status');
  const guest = guestRes.body;
  assert(guest.edit_type === 'guests' && guest.preview_only === true, 'guest flags');
  assert(guest.proposed && guest.proposed.guest_count === 1, 'guest proposed count');
  assert(Array.isArray(guest.proposed.release_booking_bed_ids) && guest.proposed.release_booking_bed_ids.length >= 1, 'release ids');
  assert((guest.proposed.released_beds || []).length >= 1, 'released_beds');
  assert((guest.proposed.remaining_beds || []).length >= 1, 'remaining_beds');

  // Guest increase blocked
  const guestUp = await editPreview(cookie, {
    client_slug: CLIENT,
    booking_code: bkMulti.booking_code,
    edit_type: 'guests',
    guest_count: guestCount + 1,
  });
  assert(guestUp.status === 200, 'guest increase response');
  assert(guestUp.body.reason === 'guest_increase_not_supported', 'guest increase blocked');
  assert(guestUp.body.can_apply === false, 'guest increase can_apply false');

  // Re-fetch polish context — contact not saved
  const ctxPolishAfter = await context(cookie, BOOKINGS.polish);
  assert(ctxPolishAfter.booking.guest_name === bkPolish.guest_name, 'contact preview mutated guest_name');
  assert((ctxPolishAfter.booking.email || '') === (bkPolish.email || ''), 'contact preview mutated email');

  const countsAfter = await counts(pg);
  await pg.end();
  assert(JSON.stringify(countsBefore) === JSON.stringify(countsAfter), 'DB counts changed');

  const summary = {
    result: 'PASS',
    commit: '48b956b',
    image: 'whstagingacr.azurecr.io/wh-staff-api:48b956b-stage104f-field-edit-preview',
    acr_run: 'cb1u',
    revision: 'wh-staging-staff-api--0000073',
    gate: 'BOOKING_MOVE_WRITE_ENABLED=false',
    bookings_inspected: Object.values(BOOKINGS),
    counts_unchanged: countsBefore,
    proofs: {
      running_invoice_ui: true,
      field_edit_ui: true,
      contact_preview: { status: contactRes.status, preview_only: contact.preview_only },
      dates_preview: { status: datesRes.status, can_apply: dates.can_apply },
      package_preview: { status: pkgRes.status, proposed: pkg.proposed?.package_code },
      guest_decrease: {
        release_ids: guest.proposed.release_booking_bed_ids,
        released: guest.proposed.released_beds,
        remaining: guest.proposed.remaining_beds,
      },
      guest_increase_blocked: guestUp.body.reason,
      context_unchanged_after_contact: true,
    },
    safety: {
      db_counts_unchanged: true,
      no_stripe_in_ui: true,
      no_whatsapp_in_ui: true,
      read_only_previews: true,
    },
  };
  console.log('\n=== Phase 10.4f hosted proof summary ===');
  console.log(JSON.stringify(summary, null, 2));
})().catch((err) => {
  console.error('\nFAIL:', err.message);
  process.exit(1);
});
