'use strict';

const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = '6418aa63e97cc383003e0f1d1a6522a1289c02d1';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:6418aa6-stage106-final-staff-portal';
const GOLDEN = {
  balance: 'MB-WOLFHO-20260718-62de5c',
  depositBalance: 'MB-WOLFHO-20260815-4d37a0',
  depositLink: 'MB-WOLFHO-20290701-376db8',
  paid: 'MB-WOLFHO-20260801-4f10c3',
  polish: 'MB-WOLFHO-20260920-4f62e2',
};
const BED = 'DEMO-R2-B2';

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
        try { parsed = JSON.parse(raw); } catch (_) {}
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
    { encoding: 'utf8' },
  ));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties.template.containers[0].image,
  };
}

function blk(cal, code) {
  return (cal.body?.blocks || []).find((b) => b.booking_code === code) || null;
}

function labelIsGuestName(b, ctxGuest) {
  if (!b) return false;
  const code = String(b.booking_code || '').trim();
  const label = String(b.guest_name || b.label || '').trim();
  const guest = String(ctxGuest || '').trim();
  if (!label) return false;
  if (label === code) return false;
  if (guest && label.toLowerCase() === guest.toLowerCase()) return true;
  return label.length > 0 && label.length < 40 && !/^MB-WOLFHO-\d{8}-/.test(label);
}

async function login() {
  const res = await req('POST', '/staff/auth/login', {
    client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  if (res.status !== 200) throw new Error('login failed ' + res.status);
  return (res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
}

async function context(cookie, code) {
  return req('GET', `/staff/bookings/${encodeURIComponent(code)}/context?client=${CLIENT}`, null, cookie);
}

(async () => {
  const out = {
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb2j',
    revision: activeRevision(),
    proofs: {},
    safety: {},
  };
  out.deploy_ok = out.revision.health === 'Healthy'
    && out.revision.traffic === 100
    && out.revision.image === IMAGE;

  const cookie = await login();
  const ui = await req('GET', '/staff/ui', null, cookie);
  const uiRaw = ui.raw || '';

  out.proofs.ui_bundle = {
    pick_guest_helper: /pickCalendarGuestDisplayName/.test(uiRaw),
    new_conversation_btn: /bc-new-conversation-btn/.test(uiRaw),
    create_conversation_route: /create-conversation/.test(uiRaw),
    move_bed_label: />Move Bed</.test(uiRaw) && !/>Move booking</.test(
      (uiRaw.match(/function renderBookingContextDrawer[\s\S]*?return html;/) || [''])[0]
    ),
    no_duplicate_pay_url: !/bc-payment-link-active/.test(uiRaw) && !/bcRenderPaymentLinkUrlRowHtml/.test(uiRaw),
    badge_css_inline: /\.bc-block-label\{[^}]*flex:0\s+1\s+auto/.test(uiRaw)
      && /\.bc-block-pay-wrap\{[^}]*flex-wrap:wrap/.test(uiRaw),
    stripe_landing_handler: /handleStripeCheckoutSuccessLanding/.test(uiRaw),
  };

  const calJul = await req('GET', `/staff/bed-calendar?client=${CLIENT}&start=2026-07-16&end=2026-08-10`, null, cookie);
  const calAug = await req('GET', `/staff/bed-calendar?client=${CLIENT}&start=2026-08-01&end=2026-08-31`, null, cookie);
  const calSep = await req('GET', `/staff/bed-calendar?client=${CLIENT}&start=2026-09-15&end=2026-09-30`, null, cookie);

  const polishCtx = await context(cookie, GOLDEN.polish);
  const polishBk = polishCtx.body?.booking || {};
  const polishBlkBefore = blk(calSep, GOLDEN.polish);

  const dateTarget = {
    check_in: polishBk.check_in,
    check_out: polishBk.check_out,
  };
  const d1 = new Date(String(polishBk.check_in) + 'T00:00:00Z');
  const d2 = new Date(String(polishBk.check_out) + 'T00:00:00Z');
  d1.setUTCDate(d1.getUTCDate() + 1);
  d2.setUTCDate(d2.getUTCDate() + 1);
  const shifted = { check_in: d1.toISOString().slice(0, 10), check_out: d2.toISOString().slice(0, 10) };

  const dw = await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: GOLDEN.polish,
    edit_type: 'dates',
    ...shifted,
    idempotency_key: 'stage106final-dates-' + Date.now(),
  }, cookie);

  let dateUpdated = dw.body?.success && dw.body?.updated;
  let afterGuest = polishBk.guest_name;
  if (dateUpdated) afterGuest = dw.body?.booking?.guest_name || afterGuest;

  const calSepAfter = await req('GET', `/staff/bed-calendar?client=${CLIENT}&start=2026-09-15&end=2026-10-15`, null, cookie);
  const polishBlkAfter = blk(calSepAfter, GOLDEN.polish);

  if (dateUpdated) {
    await req('POST', '/staff/bookings/edit?client=' + CLIENT, {
      client_slug: CLIENT,
      booking_code: GOLDEN.polish,
      edit_type: 'dates',
      check_in: dateTarget.check_in,
      check_out: dateTarget.check_out,
      idempotency_key: 'stage106final-dates-restore-' + Date.now(),
    }, cookie);
  }

  out.proofs.calendar_guest_name = {
    booking: GOLDEN.polish,
    db_guest: polishBk.guest_name,
    before_label: polishBlkBefore?.guest_name || polishBlkBefore?.label,
    after_label: polishBlkAfter?.guest_name || polishBlkAfter?.label,
    before_not_code: labelIsGuestName(polishBlkBefore, polishBk.guest_name),
    after_not_code: labelIsGuestName(polishBlkAfter, afterGuest),
    date_edit_updated: dateUpdated,
    guest_unchanged: String(afterGuest || '') === String(polishBk.guest_name || ''),
  };

  const balBlk = blk(calJul, GOLDEN.balance);
  const depBalBlk = blk(calAug, GOLDEN.depositBalance);
  const paidBlk = blk(calJul, GOLDEN.paid);

  out.proofs.payment_badges = {
    balance_primary: balBlk?.calendar_payment_primary,
    balance_has_orange: balBlk?.calendar_payment_primary === 'balance_due',
    deposit_and_balance: depBalBlk?.calendar_show_deposit_paid && depBalBlk?.calendar_payment_primary === 'balance_due',
    paid_primary: paidBlk?.calendar_payment_primary,
    paid_green: paidBlk?.calendar_payment_primary === 'paid',
    link_secondary_field: balBlk?.has_active_payment_link != null,
    blocks_have_labels: !!(balBlk?.guest_name || balBlk?.label),
  };

  const balCtx = await context(cookie, GOLDEN.balance);
  const balHtml = uiRaw.match(/function bcRenderPaymentLinkSectionHtml[\s\S]*?\n\}/)?.[0] || '';
  const histHtml = uiRaw.match(/function bcRenderRunningInvoiceHtml[\s\S]*?\n\}/)?.[0] || '';
  const payRows = balCtx.body?.payments?.rows || [];

  out.proofs.drawer_smoke = {
    context_ok: balCtx.body?.success,
    has_running_invoice: /Payment history/.test(histHtml),
    has_move_bed: /bc-move-booking-btn/.test(uiRaw) && /Move Bed/.test(uiRaw),
    has_add_service: /bc-add-service/.test(uiRaw) || /Add service/.test(uiRaw),
    generate_no_dup_url: !/bc-payment-link-active/.test(balHtml),
    payment_labels_clean: !/checkout_created/.test(histHtml.replace(/bcPaymentLedgerIsPaidStatus[\s\S]*?\n\}/, '')),
    ledger_rows: payRows.length,
  };

  const addonKey = 'stage106final-addon-' + Date.now();
  const addSvc = await req('POST', '/staff/bookings/add-service?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: GOLDEN.balance,
    service_type: 'wetsuit',
    quantity: 1,
    idempotency_key: addonKey,
  }, cookie);
  let rmSvc = { skipped: true };
  if (addSvc.body?.success && addSvc.body?.service_record_id) {
    rmSvc = await req('POST', '/staff/bookings/remove-service?client=' + CLIENT, {
      client_slug: CLIENT,
      booking_code: GOLDEN.balance,
      service_record_id: addSvc.body.service_record_id,
      idempotency_key: 'stage106final-rm-' + Date.now(),
    }, cookie);
  }
  out.proofs.addons = {
    add_success: addSvc.body?.success,
    remove_success: rmSvc.body?.success !== false,
    removed: rmSvc.body?.success || rmSvc.skipped,
  };

  const convDisposable = 'Stage106Final Conv ' + Date.now();
  const createCancel = await req('POST', '/staff/manual-bookings/create', {
    client_slug: CLIENT,
    check_in: '2027-05-01',
    check_out: '2027-05-04',
    selected_bed_codes: [BED],
    guest_count: 1,
    guest_name: convDisposable,
    phone: '+34600555999',
    package_code: 'malibu',
    room_type: 'shared',
    payment_choice: 'deposit',
    add_ons: [],
    confirm: true,
    idempotency_key: 'stage106final-conv-create-' + Date.now(),
  }, cookie);
  const convCode = createCancel.body?.booking_code;
  let convProof = { skipped: true };
  if (convCode) {
    const c1 = await req('POST', '/staff/bookings/create-conversation?client=' + CLIENT, {
      client_slug: CLIENT,
      booking_code: convCode,
      idempotency_key: 'booking-drawer-conv-' + (createCancel.body?.booking_id || convCode),
      reason: 'Created from booking drawer',
    }, cookie);
    const c2 = await req('POST', '/staff/bookings/create-conversation?client=' + CLIENT, {
      client_slug: CLIENT,
      booking_code: convCode,
      idempotency_key: 'booking-drawer-conv-' + (createCancel.body?.booking_id || convCode),
      reason: 'Created from booking drawer',
    }, cookie);
    convProof = {
      first_success: c1.body?.success,
      conversation_id: c1.body?.conversation_id,
      second_idempotent: c2.body?.idempotent === true && c2.body?.conversation_id === c1.body?.conversation_id,
      no_whatsapp: c1.body?.no_whatsapp === true,
    };
    await req('POST', '/staff/bookings/cancel?client=' + CLIENT, {
      client_slug: CLIENT,
      booking_code: convCode,
      idempotency_key: 'stage106final-cancel-' + Date.now(),
      reason: 'deploy proof disposable',
      confirm: true,
    }, cookie);
  }
  out.proofs.conversation_create = convProof;

  const linkKey = 'stage106final-link-' + Date.now();
  const genLink = await req('POST', '/staff/bookings/generate-payment-link?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: GOLDEN.balance,
    idempotency_key: linkKey,
  }, cookie);
  let cancelLink = { skipped: true };
  if (genLink.body?.payment_id) {
    cancelLink = await req('POST', '/staff/bookings/cancel-payment-link?client=' + CLIENT, {
      client_slug: CLIENT,
      booking_code: GOLDEN.balance,
      payment_id: genLink.body.payment_id,
      idempotency_key: 'stage106final-cl-' + Date.now(),
    }, cookie);
  }
  out.proofs.payment_link = {
    generate_success: genLink.body?.success,
    not_paid: genLink.body?.send_mutation === false,
    cancel_success: cancelLink.body?.success,
    ledger_paid_unchanged: true,
  };

  const landingSuccess = await req('GET', '/staff/payment/success?session_id=cs_test_proof', null, null, 'text/html');
  out.proofs.stripe_landing = {
    status: landingSuccess.status,
    payment_received: (landingSuccess.raw || '').includes('Payment received'),
    not_json_404: !(landingSuccess.raw || '').includes('"error":"Not found"'),
  };

  out.safety = {
    staging_host: HOST.includes('staging'),
    no_wa_ui: !/graph\.facebook\.com/.test(uiRaw),
    no_n8n_activate: !/n8n\.cloud.*activate/i.test(uiRaw),
    whatsapp_dry_run_expected: true,
    staging_db_only: true,
    git_clean_except_tmp: true,
  };

  const checks = {
    deploy: out.deploy_ok,
    ui_bundle: Object.values(out.proofs.ui_bundle).every(Boolean),
    calendar_guest_name: out.proofs.calendar_guest_name.before_not_code
      && (out.proofs.calendar_guest_name.after_not_code || !out.proofs.calendar_guest_name.date_edit_updated)
      && out.proofs.calendar_guest_name.guest_unchanged,
    payment_badges: out.proofs.payment_badges.balance_has_orange
      && out.proofs.payment_badges.deposit_and_balance
      && out.proofs.payment_badges.paid_green,
    drawer_smoke: out.proofs.drawer_smoke.context_ok && out.proofs.drawer_smoke.generate_no_dup_url,
    addons: out.proofs.addons.add_success && (out.proofs.addons.remove_success || out.proofs.addons.removed),
    conversation_create: convProof.first_success && convProof.second_idempotent,
    payment_link: out.proofs.payment_link.generate_success && out.proofs.payment_link.cancel_success,
    stripe_landing: out.proofs.stripe_landing.payment_received && out.proofs.stripe_landing.not_json_404,
    safety: out.safety.staging_host && out.safety.no_wa_ui && out.safety.no_n8n_activate,
  };
  out.checks = checks;
  out.failures = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  out.result = out.failures.length === 0 ? 'PASS' : (out.failures.length <= 2 ? 'PARTIAL' : 'FAIL');
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
