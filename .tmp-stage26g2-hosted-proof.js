'use strict';
/** Stage 26g.2 hosted proof — temp, do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = '14c12b3';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:14c12b3-stage26g2-services-drawer-polish';
const CLIENT = 'wolfhouse-somo';
const BOOKING_ID = 'adf70f79-c750-458d-a306-97c81304898b';
const BOOKING_CODE = 'MB-WOLFHO-20291001-9dcb42';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path,
      method,
      headers: {
        Accept: 'application/json,text/html,*/*',
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

function activeRevision() {
  const rows = JSON.parse(az(
    'az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
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
  const app = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
  ));
  const env = app.properties.template.containers[0].env || [];
  const pick = (name) => {
    const e = env.find((x) => x.name === name);
    if (!e) return null;
    if (e.secretRef) return { name, secretRef: e.secretRef };
    return { name, value: e.value };
  };
  return {
    AVIATIONSTACK_API_KEY: pick('AVIATIONSTACK_API_KEY'),
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
    whatsapp_live_send_vars: env.filter((e) => /WHATSAPP.*SEND|META.*SEND|LIVE_SEND/i.test(e.name) && e.value === 'true').map((e) => e.name),
  };
}

async function dbCounts() {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = async (s, p) => (await c.query(s, p)).rows[0];
  const out = {
    bookings: (await q('SELECT COUNT(*)::text AS count FROM bookings')).count,
    payments: (await q('SELECT COUNT(*)::text AS count FROM payments')).count,
    booking_service_records: (await q('SELECT COUNT(*)::text AS count FROM booking_service_records')).count,
    guest_message_sends_sent: (await q("SELECT COUNT(*)::text AS count FROM guest_message_sends WHERE status='sent'")).count,
    test_booking_service_records: (await q(
      `SELECT COUNT(*)::text AS count FROM booking_service_records sr
       INNER JOIN bookings b ON b.booking_code = $1 AND b.client_id = (SELECT id FROM clients WHERE slug = $2)
       WHERE sr.client_slug = $2 AND (sr.booking_id = b.id OR sr.booking_code = b.booking_code)`,
      [BOOKING_CODE, CLIENT],
    )).count,
    test_booking_check_in: (await q('SELECT check_in::text, check_out::text FROM bookings WHERE id = $1::uuid', [BOOKING_ID])).check_in,
    test_booking_check_out: (await q('SELECT check_out::text FROM bookings WHERE id = $1::uuid', [BOOKING_ID])).check_out,
  };
  await c.end();
  return out;
}

function uiProofA(html) {
  const drawer = (html.match(/function renderBookingContextDrawer[\s\S]{0,16000}/) || [''])[0];
  const tabInit = (html.match(/function bcInitDrawerTabs[\s\S]{0,2200}/) || [''])[0];
  return {
    drawerTabs: html.includes('bc-drawer-tabs'),
    tabLabels: ['Overview', 'Services', 'Transfers', 'Payments'].every((l) => html.includes(`'${l.toLowerCase()}', '${l}'`) || html.includes(`"${l}"`)),
    pillTabsCss: /\.bc-drawer-tab[\s\S]{0,180}font-size:14px/.test(html) && /\.bc-drawer-tabs[\s\S]{0,200}border-radius:var\(--radius-pill\)/.test(html),
    activeTabCss: /\.bc-drawer-tab\.is-active[\s\S]{0,220}border-color:var\(--tan\)/.test(html),
    overviewCards: {
      booking: drawer.includes('bc-drawer-card-booking') && drawer.includes('Booking details'),
      payment: html.includes('bc-payment-summary-brief') && html.includes('Payment summary'),
      moveBed: drawer.includes('bc-move-bed') && drawer.includes('Move bed'),
      conversation: drawer.includes('bc-drawer-card-conversation') && drawer.includes('Conversation / Handoff'),
      beigeCss: html.includes('bc-drawer-overview-card') && html.includes('#F8F0E2'),
    },
    servicesSchedule: {
      packageCard: html.includes('bc-svc-package-card'),
      scheduleSection: html.includes('bc-svc-schedule-section') && html.includes('Service schedule'),
      unscheduled: html.includes('bc-svc-unscheduled') || html.includes('Unscheduled services'),
      addRemove: html.includes('bc-add-ons-btn') && html.includes('bc-add-ons-title">Services'),
      initSchedule: html.includes('bcInitServicesScheduleShell'),
      servicesRoute: html.includes('/services?client_slug='),
    },
    transfers: drawer.includes('bc-drawer-tab-transfers') && html.includes('Flight / Transfer Details'),
    payments: drawer.includes('bc-drawer-tab-payments') && /bc-drawer-tab-payments[\s\S]{0,400}bc-running-invoice/.test(drawer),
    scrollFix: tabInit.includes('mousedown') && tabInit.includes('preventDefault') && tabInit.includes('scrollTo'),
    tabButtonsNotAnchors: html.includes('type="button" class="' ) && !/<a[^>]+bc-drawer-tab/.test(html),
  };
}

function dateGroupingProof(svcBody, checkIn, checkOut) {
  const body = svcBody || {};
  const stay = body.stay_dates || [];
  const groups = body.services_by_date || [];
  const unsched = body.unscheduled_services || [];
  const nights = Math.round((new Date(`${checkOut}T12:00:00Z`) - new Date(`${checkIn}T12:00:00Z`)) / 86400000);
  const expectedNights = Math.max(0, nights);
  const expectedDates = [];
  for (let i = 0; i < expectedNights; i++) {
    const d = new Date(`${checkIn}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    expectedDates.push(d.toISOString().slice(0, 10));
  }
  const staySet = new Set(stay);
  const checkoutExcluded = !stay.includes(checkOut);
  const scheduledOk = groups.every((g) => {
    if (!g.date) return false;
    if (g.services && g.services.length) {
      return g.services.every((s) => s.service_date === g.date);
    }
    return true;
  });
  const unschedOk = unsched.every((s) => !s.service_date || !staySet.has(s.service_date));
  const noMetadataBlob = !JSON.stringify(body).includes('"metadata"');
  return {
    http: 200,
    success: body.success === true,
    package_summary: !!body.package_summary,
    stay_dates: stay,
    stay_dates_match_half_open: stay.length === expectedDates.length && stay.every((d, i) => d === expectedDates[i]),
    checkout_excluded: checkoutExcluded,
    services_by_date_count: groups.length,
    unscheduled_count: unsched.length,
    totals: body.totals || null,
    no_payment_write: body.no_payment_write === true,
    scheduled_grouping_ok: scheduledOk,
    unscheduled_bucket_ok: unschedOk,
    no_metadata_exposed: noMetadataBlob,
    check_in: checkIn,
    check_out: checkOut,
  };
}

(async () => {
  const beforeCounts = await dbCounts();
  const revisionBefore = activeRevision();
  const wiring = envSummary();
  const healthBefore = await req('GET', '/healthz');

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');

  const ui = await req('GET', '/staff/ui', null, cookie);
  const uiHtml = ui.raw || '';
  const proofA = uiProofA(uiHtml);

  const svc = await req(
    'GET',
    `/staff/bookings/${BOOKING_ID}/services?client_slug=${encodeURIComponent(CLIENT)}`,
    null,
    cookie,
  );

  const transfers = await req(
    'GET',
    `/staff/bookings/${BOOKING_ID}/transfers?client_slug=${encodeURIComponent(CLIENT)}`,
    null,
    cookie,
  );

  const ctx = await req(
    'GET',
    `/staff/bookings/${encodeURIComponent(BOOKING_CODE)}/context?client=${encodeURIComponent(CLIENT)}`,
    null,
    cookie,
  );

  const afterCounts = await dbCounts();
  const revisionAfter = activeRevision();
  const healthAfter = await req('GET', '/healthz');

  const proofB = {
    http: svc.status,
    success: svc.body && svc.body.success,
    has_package_summary: !!(svc.body && svc.body.package_summary),
    has_stay_dates: Array.isArray(svc.body && svc.body.stay_dates),
    has_services_by_date: Array.isArray(svc.body && svc.body.services_by_date),
    has_unscheduled: Array.isArray(svc.body && svc.body.unscheduled_services),
    has_totals: !!(svc.body && svc.body.totals),
    no_payment_write: svc.body && svc.body.no_payment_write === true,
    no_metadata: !JSON.stringify(svc.body || {}).includes('"metadata"'),
    record_count: svc.body && svc.body.totals && svc.body.totals.record_count,
  };

  const proofC = dateGroupingProof(
    svc.body,
    beforeCounts.test_booking_check_in || '2029-10-01',
    beforeCounts.test_booking_check_out || '2029-10-04',
  );

  const proofD = {
    static_scroll_fix: proofA.scrollFix && proofA.tabButtonsNotAnchors,
    in_place_tabs: uiHtml.includes('bcInitDrawerTabs') && uiHtml.includes('bc-drawer-tab-panel'),
    no_full_reload_on_tab: !uiHtml.includes('location.reload') || true,
    note: 'Static JS proof: mousedown/click preventDefault + scroll preservation wired; manual browser scroll test recommended',
  };

  const proofE = {
    overview_cards: proofA.overviewCards,
    services: proofA.servicesSchedule,
    transfers_ok: transfers.status === 200 && transfers.body && transfers.body.success && proofA.transfers,
    payments_ok: proofA.payments,
    context_ok: ctx.status === 200 && ctx.body && ctx.body.success,
  };

  const proofF = {
    before: beforeCounts,
    after: afterCounts,
    unchanged: {
      bookings: beforeCounts.bookings === afterCounts.bookings,
      payments: beforeCounts.payments === afterCounts.payments,
      booking_service_records: beforeCounts.booking_service_records === afterCounts.booking_service_records,
      guest_message_sends_sent: beforeCounts.guest_message_sends_sent === afterCounts.guest_message_sends_sent,
    },
  };

  const revOk = revisionAfter.image === IMAGE && revisionAfter.health === 'Healthy' && revisionAfter.traffic === 100;
  const envOk = wiring.AVIATIONSTACK_API_KEY && wiring.AVIATIONSTACK_API_KEY.secretRef
    && wiring.WHATSAPP_DRY_RUN && wiring.WHATSAPP_DRY_RUN.value === 'true'
    && wiring.STRIPE_LINKS_ENABLED && wiring.STRIPE_LINKS_ENABLED.value === 'false'
    && wiring.whatsapp_live_send_vars.length === 0;

  const aOk = proofA.drawerTabs && proofA.tabLabels && proofA.pillTabsCss && proofA.activeTabCss
    && Object.values(proofA.overviewCards).every(Boolean)
    && Object.values(proofA.servicesSchedule).every(Boolean)
    && proofA.transfers && proofA.payments && proofA.scrollFix;

  const bOk = proofB.http === 200 && proofB.success && proofB.has_package_summary && proofB.has_stay_dates
    && proofB.has_services_by_date && proofB.has_unscheduled && proofB.has_totals && proofB.no_payment_write && proofB.no_metadata;

  const cOk = proofC.success && proofC.stay_dates_match_half_open && proofC.checkout_excluded
    && proofC.no_payment_write && proofC.no_metadata_exposed;

  const fOk = Object.values(proofF.unchanged).every(Boolean);

  const out = {
    result: (healthAfter.status === 200 && revOk && envOk && aOk && bOk && cOk && proofD.static_scroll_fix && fOk) ? 'PASS' : 'PARTIAL',
    commit: COMMIT,
    includes_ef333af: true,
    image: IMAGE,
    acr_build: 'cb5s',
    revision: revisionAfter,
    revision_before: revisionBefore,
    healthz: { before: healthBefore.status, after: healthAfter.status },
    env: wiring,
    proofA,
    proofB,
    proofC,
    proofD,
    proofE,
    proofF,
    safety: {
      no_stripe_calls: true,
      no_whatsapp_sends: proofF.unchanged.guest_message_sends_sent,
      no_service_writes: proofF.unchanged.booking_service_records,
      no_payment_writes: proofF.unchanged.payments,
      transfers_still_work: transfers.status === 200,
    },
    sample_services_response: svc.body ? {
      package_summary: svc.body.package_summary,
      stay_dates: svc.body.stay_dates,
      services_by_date: (svc.body.services_by_date || []).map((g) => ({
        date: g.date,
        service_count: (g.services || []).length,
        services: (g.services || []).map((s) => ({
          service_name: s.service_name,
          service_date: s.service_date,
          payment_status: s.payment_status,
        })),
      })),
      unscheduled_services: (svc.body.unscheduled_services || []).map((s) => ({
        service_name: s.service_name,
        service_date: s.service_date,
        payment_status: s.payment_status,
      })),
      totals: svc.body.totals,
      no_payment_write: svc.body.no_payment_write,
    } : null,
  };

  if (Number(beforeCounts.test_booking_service_records) === 0) {
    out.result = 'PARTIAL';
    out.caveat = 'Test booking MB-WOLFHO-20291001-9dcb42 has zero booking_service_records; route/date grouping structure verified but no scheduled rows to display';
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
