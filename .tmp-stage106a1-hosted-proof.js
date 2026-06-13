'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:98fbb85-stage106a-addons-cleanup';
const COMMIT = '98fbb85';

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
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
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
    { encoding: 'utf8' }
  ));
  const active = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: active.name,
    health: active.properties.healthState,
    image: active.properties.template.containers[0].image,
    traffic: active.properties.trafficWeight,
  };
}

function label(t, meta) {
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch (_) { meta = {}; }
  }
  meta = meta || {};
  if (meta.staff_ui_service_type === 'soft_board' || (t === 'surfboard' && meta.board_variant === 'soft')) return 'Soft board';
  if (meta.staff_ui_service_type === 'hard_board' || (t === 'surfboard' && meta.board_variant === 'hard')) return 'Hard board';
  if (meta.staff_ui_service_type === 'wetsuit' || t === 'wetsuit') return 'Wetsuit';
  if (meta.staff_ui_service_type === 'meals' || t === 'meal') return 'Meals';
  return t;
}

function invoiceSvcSum(rows) {
  return rows.reduce((s, r) => s + (Number(r.amount_due_cents) || 0), 0);
}

async function snap(pg, bookingCode) {
  const b = await pg.query(`
    SELECT b.id::text AS booking_id, b.booking_code, b.guest_name, b.status::text AS status,
           b.package_code, b.total_amount_cents, b.amount_paid_cents, b.balance_due_cents,
           b.check_in::text AS check_in, b.check_out::text AS check_out
    FROM bookings b
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2 LIMIT 1
  `, [CLIENT, bookingCode]);
  const pays = await pg.query(`
    SELECT p.id::text AS payment_id, p.status::text AS status, p.amount_paid_cents
    FROM payments p
    INNER JOIN bookings b ON b.id = p.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2 ORDER BY p.created_at
  `, [CLIENT, bookingCode]);
  const svc = (await pg.query(`
    SELECT id::text, service_type, quantity, amount_due_cents, metadata
    FROM booking_service_records
    WHERE client_slug = $1 AND booking_code = $2 ORDER BY created_at
  `, [CLIENT, bookingCode])).rows;
  return { booking: b.rows[0], payments: pays.rows, service_records: svc };
}

function payTruthSame(a, b) {
  return JSON.stringify(a.payments) === JSON.stringify(b.payments)
    && Number(a.booking.amount_paid_cents) === Number(b.booking.amount_paid_cents);
}

async function addService(cookie, payload) {
  return req('POST', '/staff/bookings/add-service?client=' + CLIENT, payload, cookie);
}

(async () => {
  const out = { commit: COMMIT, image: IMAGE, acr_run: 'cb24', revision: activeRevision() };

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  if (login.status !== 200) throw new Error('login failed');
  const cookie = (login.headers && login.headers['set-cookie'])
    ? login.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ')
    : '';

  const ui = await req('GET', '/staff/ui', null, cookie);
  const uiRaw = ui.raw || '';
  const drawerFn = uiRaw.match(/function renderBookingContextDrawer[\s\S]*?return html;/)?.[0] || '';
  const addPanel = uiRaw.match(/function bcRenderAddServicePanelHtml[\s\S]*?function bcNewAddServiceIdempotencyKey/)?.[0] || '';

  out.layout = {
    addons_before_payment: /bcRenderAddServicePanelHtml[\s\S]*?bcRenderRunningInvoiceHtml/.test(drawerFn),
    payment_not_before_addons: !/bcRenderRunningInvoiceHtml[\s\S]*?bcRenderAddServicePanelHtml/.test(drawerFn),
    has_addons_title: />Add-ons</.test(addPanel) && /bc-add-ons-title/.test(addPanel),
    has_add_button_right: /bc-add-ons-header[\s\S]*?bc-add-ons-btn[\s\S]*?>Add</.test(addPanel),
    no_add_service_wording: !/Add service|Save service|Service type/i.test(addPanel),
    dropdown_no_euro_prices: !/\\u20ac\d|€\d/.test(addPanel.match(/<select id="bc-add-ons-type"[\s\S]*?<\/select>/)?.[0] || ''),
    meals_in_dropdown: /value="meals">Meals</.test(addPanel),
    has_staffAddonUiTypeLabel: /function staffAddonUiTypeLabel\(uiType\)/.test(uiRaw),
    has_bc_add_ons_panel: /id="bc-add-ons-panel"/.test(addPanel),
  };

  const dbUrl = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' }
  ).trim();
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const bed = 'DEMO-R1-B1';
  const ci = '2027-05-01';
  const co = '2027-05-04';
  const create = await req('POST', '/staff/manual-bookings/create', {
    client_slug: CLIENT,
    check_in: ci,
    check_out: co,
    selected_bed_codes: [bed],
    guest_count: 1,
    guest_name: 'Stage106a1 Addons Disposable',
    phone: '+34600555108',
    package_code: 'malibu',
    room_type: 'shared',
    payment_choice: 'deposit',
    add_ons: [],
    confirm: true,
    idempotency_key: 'stage106a1-create-' + Date.now(),
  }, cookie);
  const bookingCode = create.body && create.body.booking_code;
  if (!bookingCode) throw new Error('disposable booking create failed: ' + JSON.stringify(create.body));

  const before = await snap(pg, bookingCode);
  const ctx0 = await req('GET', '/staff/bookings/' + bookingCode + '/context?client=' + CLIENT, null, cookie);
  out.runtime = {
    context_status: ctx0.status,
    context_success: ctx0.body && ctx0.body.success,
    context_has_staffAddonUiTypeLabel_in_bundle: out.layout.has_staffAddonUiTypeLabel,
    context_error: ctx0.body && ctx0.body.error,
  };

  const wetsuitKey = 'stage106a1-wetsuit-' + bookingCode;
  const wetsuitQty = 3;
  const addW = await addService(cookie, {
    client_slug: CLIENT,
    booking_code: bookingCode,
    service_type: 'wetsuit',
    quantity: wetsuitQty,
    service_date: ci,
    idempotency_key: wetsuitKey,
  });
  const afterW = await snap(pg, bookingCode);
  const ctxW = await req('GET', '/staff/bookings/' + bookingCode + '/context?client=' + CLIENT, null, cookie);
  const wRow = afterW.service_records.find((r) => {
    const m = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
    return m.idempotency_key === wetsuitKey;
  });
  const svcSumW = invoiceSvcSum(afterW.service_records);

  const softKey = 'stage106a1-soft-' + bookingCode;
  const addSoft = await addService(cookie, {
    client_slug: CLIENT,
    booking_code: bookingCode,
    service_type: 'soft_board',
    quantity: 1,
    service_date: ci,
    idempotency_key: softKey,
  });
  const afterSoft = await snap(pg, bookingCode);
  const ctxSoft = await req('GET', '/staff/bookings/' + bookingCode + '/context?client=' + CLIENT, null, cookie);
  const softLabels = (ctxSoft.body.service_records || []).map((r) => label(r.service_type, r.metadata));

  const mealsAdd = await addService(cookie, {
    client_slug: CLIENT,
    booking_code: bookingCode,
    service_type: 'meals',
    quantity: 1,
    service_date: ci,
    idempotency_key: 'stage106a1-meals-' + bookingCode,
  });
  const afterMeals = await snap(pg, bookingCode);

  out.add_wetsuit = {
    status: addW.status,
    success: addW.body && addW.body.success,
    created: addW.body && addW.body.created,
    amount_due_cents: addW.body && addW.body.pricing && addW.body.pricing.amount_due_cents,
    expected: 500 * wetsuitQty,
    row_created: !!wRow,
    svc_count: afterW.service_records.length,
    payments_unchanged: payTruthSame(before, afterW),
    ctx_svc_count: (ctxW.body.service_records || []).length,
    invoice_svc_sum: svcSumW,
  };

  out.add_board = {
    status: addSoft.status,
    success: addSoft.body && addSoft.body.success,
    labels_in_context: softLabels,
    has_soft_board_label: softLabels.includes('Soft board'),
  };

  out.meals = {
    status: mealsAdd.status,
    success: mealsAdd.body && mealsAdd.body.success,
    error: mealsAdd.body && mealsAdd.body.error,
    config_missing_expected: mealsAdd.status === 400 && /Meals pricing is not configured/i.test(String(mealsAdd.body && mealsAdd.body.error || '')),
    svc_count_unchanged: afterMeals.service_records.length === afterSoft.service_records.length,
  };

  const contact = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT, booking_code: bookingCode, edit_type: 'contact',
    guest_name: 'Stage106a1 Contact', idempotency_key: 'stage106a1-c-' + Date.now(),
  }, cookie);
  const pkg = String(afterMeals.booking.package_code || 'malibu').toLowerCase();
  const nextPkg = pkg === 'malibu' ? 'uluwatu' : 'malibu';
  const pkgW = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT, booking_code: bookingCode, edit_type: 'package',
    package_code: nextPkg, idempotency_key: 'stage106a1-p-' + Date.now(),
  }, cookie);
  const dateW = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT, booking_code: bookingCode, edit_type: 'dates',
    check_in: ci, check_out: co, idempotency_key: 'stage106a1-d-' + Date.now(),
  }, cookie);
  const cancelW = await req('POST', '/staff/bookings/cancel?client=' + CLIENT, {
    client_slug: CLIENT, booking_code: bookingCode,
    idempotency_key: 'stage106a1-cancel-' + Date.now(),
  }, cookie);
  const afterCancel = await snap(pg, bookingCode);

  out.edit_smoke = {
    contact_ok: contact.body && contact.body.success,
    package_ok: pkgW.body && pkgW.body.success,
    date_ok: dateW.body && dateW.body.success,
    cancel_ok: cancelW.body && cancelW.body.success && cancelW.body.cancelled,
    status_after_cancel: afterCancel.booking && afterCancel.booking.status,
  };

  out.safety = {
    payments_unchanged_after_addons: payTruthSame(before, afterSoft),
    no_stripe_ui: !/api\.stripe\.com/.test(uiRaw),
    no_wa: !/graph\.facebook\.com/.test(uiRaw),
    no_n8n: !/n8n\.cloud.*activate/i.test(uiRaw),
    add_message_no_stripe: /No Stripe/i.test(String(addW.body && addW.body.message || '')),
  };

  out.invoice_refresh = {
    svc_sum_after_wetsuit: svcSumW,
    svc_sum_after_soft: invoiceSvcSum(afterSoft.service_records),
    increased: invoiceSvcSum(afterSoft.service_records) > invoiceSvcSum(before.service_records),
    ctx_has_records: (ctxSoft.body.service_records || []).length >= 2,
  };

  out.booking_code = bookingCode;

  out.pass = {
    revision: out.revision.health === 'Healthy' && out.revision.traffic === 100 && out.revision.image === IMAGE,
    layout: out.layout.addons_before_payment && out.layout.has_addons_title && out.layout.has_add_button_right &&
      out.layout.no_add_service_wording && out.layout.dropdown_no_euro_prices && out.layout.meals_in_dropdown,
    runtime: out.runtime.context_status === 200 && out.runtime.has_staffAddonUiTypeLabel_in_bundle,
    wetsuit: out.add_wetsuit.success && out.add_wetsuit.row_created && out.add_wetsuit.amount_due_cents === out.add_wetsuit.expected,
    board: out.add_board.success && out.add_board.has_soft_board_label,
    meals: out.meals.config_missing_expected,
    edits: out.edit_smoke.contact_ok && out.edit_smoke.package_ok && out.edit_smoke.date_ok && out.edit_smoke.cancel_ok,
    safety: out.safety.payments_unchanged_after_addons && out.safety.no_stripe_ui && out.safety.no_wa && out.safety.no_n8n,
    invoice: out.invoice_refresh.increased && out.invoice_refresh.ctx_has_records,
  };

  const hard = Object.values(out.pass);
  out.result = hard.every(Boolean) ? 'PASS' : 'PARTIAL';

  await pg.end();
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
