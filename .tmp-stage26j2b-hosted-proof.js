'use strict';
/** Stage 26j.2b — board service billing + deploy proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const { buildManualBookingServiceRecordRows } = require('./scripts/lib/manual-booking-service-records');
const { calculateWolfhouseQuote } = require('./scripts/lib/wolfhouse-quote-calculator');
const { formatServiceRecordForSchedule, serviceRecordBillableCents } = require('./scripts/lib/staff-booking-services-schedule');

const COMMIT = 'f661bbd';
const IMAGE_TAG = `${COMMIT}-stage26j2b-board-billing`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REVISION_SUFFIX = 'stage26j2b-board-billing';
const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const GUEST = 'Stage26j2b Board Billing Proof';
const ADD_ONS = [
  { code: 'wetsuit_soft_top_combo', days: 1 },
  { code: 'wetsuit_hard_board_combo', days: 1 },
  { code: 'soft_top_rental', days: 1 },
  { code: 'hard_board_rental', days: 1 },
];

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function req(method, pathStr, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path: pathStr, method,
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
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return { name: a.name, health: a.properties.healthState, traffic: a.properties.trafficWeight, image: a.properties?.template?.containers?.[0]?.image };
}

function deploy() {
  const current = activeRevision();
  if (current.image === IMAGE && current.health === 'Healthy' && current.traffic === 100) {
    console.error('[deploy] skip — already on target image');
    return current;
  }
  console.error('[deploy] acr build...');
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  console.error('[deploy] containerapp update...');
  az([
    'az containerapp update', '--name wh-staging-staff-api', '--resource-group wh-staging-rg',
    `--image ${IMAGE}`, `--revision-suffix ${REVISION_SUFFIX}`,
    '--set-env-vars STAFF_ACTIONS_ENABLED=true STRIPE_LINKS_ENABLED=true WHATSAPP_DRY_RUN=true MANUAL_BOOKING_ENABLED=true',
    '-o none',
  ].join(' '));
  for (let i = 0; i < 36; i++) {
    const rev = activeRevision();
    if (rev.image === IMAGE && rev.health === 'Healthy' && rev.traffic === 100) return rev;
    execSync('powershell -Command "Start-Sleep -Seconds 10"');
  }
  return activeRevision();
}

async function withDb(fn) {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function findSlot(cookie) {
  for (const c of [
    { ci: '2027-06-01', co: '2027-06-04', beds: ['DEMO-R3-B1'] },
    { ci: '2027-06-08', co: '2027-06-11', beds: ['DEMO-R2-B2'] },
    { ci: '2027-05-11', co: '2027-05-14', beds: ['DEMO-R3-B2'] },
  ]) {
    const prev = await req('POST', '/staff/manual-bookings/preview?client=' + encodeURIComponent(CLIENT), {
      client_slug: CLIENT, check_in: c.ci, check_out: c.co, selected_bed_codes: c.beds,
      guest_count: 1, guest_name: GUEST, package_code: 'package_none', room_type: 'shared', payment_choice: 'no_payment_yet',
    }, cookie);
    const avail = prev.body && prev.body.availability;
    if (prev.status === 200 && avail && avail.is_valid && !(avail.blockers && avail.blockers.length)) return c;
  }
  return null;
}

function invoiceSvcLineText(sr) {
  const meta = typeof sr.metadata === 'object' ? sr.metadata : JSON.parse(sr.metadata || '{}');
  const label = meta.staff_ui_service_type === 'soft_board' ? 'Soft board'
    : meta.staff_ui_service_type === 'hard_board' ? 'Hard board' : sr.service_type;
  const cents = serviceRecordBillableCents(sr);
  return `${label}:${cents}`;
}

(async () => {
  const proof = { result: 'PASS', commit: COMMIT, image: IMAGE, errors: [] };
  proof.revision = deploy();
  proof.healthz = (await req('GET', '/healthz')).status;

  const ui = await req('GET', '/staff/ui');
  if (!/function bcServiceRecordBillableCents/.test(ui.raw || '')) proof.errors.push('UI missing billable helper');

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const slot = await findSlot(cookie);
  if (!slot) throw new Error('no slot');

  const createRes = await req('POST', '/staff/manual-bookings/create?client=' + encodeURIComponent(CLIENT), {
    client_slug: CLIENT, check_in: slot.ci, check_out: slot.co, selected_bed_codes: slot.beds,
    guest_count: 1, guest_name: GUEST, phone: '+3460026j2b01', package_code: 'package_none',
    room_type: 'shared', payment_choice: 'no_payment_yet', add_ons: ADD_ONS, confirm: true,
    idempotency_key: `stage26j2b-${Date.now()}`,
  }, cookie);
  const code = createRes.body && createRes.body.booking_code;
  proof.create = { success: createRes.body && createRes.body.success, booking_code: code };

  const ctx = await req('GET', `/staff/bookings/${code}/context?client=${encodeURIComponent(CLIENT)}`, null, cookie);
  const svcRows = ctx.body.service_records || [];
  const bid = ctx.body.booking.booking_id;
  const sched = await req('GET', `/staff/bookings/${bid}/services?client_slug=${CLIENT}`, null, cookie);

  const softCombo = svcRows.find((r) => {
    const m = typeof r.metadata === 'object' ? r.metadata : JSON.parse(r.metadata || '{}');
    return m.source_addon_code === 'wetsuit_soft_top_combo' && m.combo_part === 'surfboard';
  });
  const hardCombo = svcRows.find((r) => {
    const m = typeof r.metadata === 'object' ? r.metadata : JSON.parse(r.metadata || '{}');
    return m.source_addon_code === 'wetsuit_hard_board_combo' && m.combo_part === 'surfboard';
  });
  const softInd = svcRows.find((r) => {
    const m = typeof r.metadata === 'object' ? r.metadata : JSON.parse(r.metadata || '{}');
    return m.source_addon_code === 'soft_top_rental';
  });
  const hardInd = svcRows.find((r) => {
    const m = typeof r.metadata === 'object' ? r.metadata : JSON.parse(r.metadata || '{}');
    return m.source_addon_code === 'hard_board_rental';
  });

  proof.amounts = {
    soft_combo_db: softCombo && Number(softCombo.amount_due_cents),
    hard_combo_db: hardCombo && Number(hardCombo.amount_due_cents),
    soft_ind_db: softInd && Number(softInd.amount_due_cents),
    hard_ind_db: hardInd && Number(hardInd.amount_due_cents),
    soft_combo_billable: softCombo && serviceRecordBillableCents(softCombo),
    services_total: sched.body.total_services_cents,
    paid_lines: (sched.body.paid_requested_services || []).map((s) => s.summary_line),
    invoice_lines: svcRows.map(invoiceSvcLineText),
  };

  if (!softCombo || softCombo.amount_due_cents !== 1500) proof.errors.push('soft combo db amount');
  if (!hardCombo || hardCombo.amount_due_cents !== 2000) proof.errors.push('hard combo db amount');
  if (!softInd || softInd.amount_due_cents !== 1500) proof.errors.push('soft ind db amount');
  if (!hardInd || hardInd.amount_due_cents !== 2000) proof.errors.push('hard ind db amount');
  if (Number(sched.body.total_services_cents) < 7000) proof.errors.push('services total too low');
  const paidText = proof.amounts.paid_lines.join(' ');
  if (!/Soft board/.test(paidText) || !/Hard board/.test(paidText)) proof.errors.push('paid summary missing boards');
  if (/€0\.00/.test(paidText) && !/Wetsuit/.test(paidText)) proof.errors.push('paid summary shows zero boards');

  if (proof.errors.length) proof.result = 'FAIL';
  if (proof.healthz !== 200) proof.result = 'FAIL';
  console.log(JSON.stringify(proof, null, 2));
  process.exit(proof.result === 'PASS' ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
