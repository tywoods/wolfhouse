'use strict';
/** Stage 26j.2 — deploy manual booking services hotfix + hosted proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const COMMIT = '677d0eb';
const IMAGE_TAG = `${COMMIT}-stage26j2-manual-services-hotfix`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REVISION_SUFFIX = 'stage26j2-manual-services-hotfix';
const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const GUEST = 'Stage26j2 Services Hotfix Proof';
const PROOF_START = new Date().toISOString();

const ADD_ONS = [
  { code: 'wetsuit_soft_top_combo', days: 1 },
  { code: 'wetsuit_hard_board_combo', days: 1 },
  { code: 'soft_top_rental', days: 1 },
  { code: 'hard_board_rental', days: 1 },
  { code: 'meals', quantity: 1 },
];

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function req(method, pathStr, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path: pathStr,
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
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties?.template?.containers?.[0]?.image,
  };
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
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REVISION_SUFFIX}`,
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
  const candidates = [
    { ci: '2027-04-20', co: '2027-04-23', beds: ['DEMO-R3-B2'] },
    { ci: '2027-04-27', co: '2027-04-30', beds: ['DEMO-R3-B1'] },
    { ci: '2027-05-04', co: '2027-05-07', beds: ['DEMO-R2-B2'] },
    { ci: '2026-11-10', co: '2026-11-13', beds: ['DEMO-R2-B1'] },
  ];
  for (const c of candidates) {
    const prev = await req('POST', '/staff/manual-bookings/preview?client=' + encodeURIComponent(CLIENT), {
      client_slug: CLIENT,
      check_in: c.ci,
      check_out: c.co,
      selected_bed_codes: c.beds,
      guest_count: 1,
      guest_name: GUEST,
      package_code: 'package_none',
      room_type: 'shared',
      payment_choice: 'no_payment_yet',
    }, cookie);
    const avail = prev.body && prev.body.availability;
    if (prev.status === 200 && avail && avail.is_valid && !(avail.blockers && avail.blockers.length)) {
      return c;
    }
  }
  return null;
}

function metaJson(row) {
  const m = row.metadata;
  if (!m) return {};
  if (typeof m === 'object') return m;
  try { return JSON.parse(m); } catch { return {}; }
}

function ledgerFromContext(ctx) {
  const bk = ctx.booking || {};
  const svc = ctx.service_records || [];
  const pmt = ctx.payments || {};
  const rows = pmt.rows || [];
  let svcTotal = 0;
  for (const r of svc) svcTotal += Number(r.total_price_cents || r.amount_due_cents || 0);
  let paid = 0;
  for (const p of rows) {
    if (String(p.status || '').toLowerCase() === 'paid') paid += Number(p.amount_paid_cents || 0);
  }
  const invoice = Number(bk.total_amount_cents || 0) + svcTotal;
  const balance = Math.max(0, invoice - paid);
  return { invoice_total_cents: invoice, balance_due_cents: balance, svc_total_cents: svcTotal };
}

(async () => {
  const proof = {
    result: 'PASS',
    commit: COMMIT,
    image: IMAGE,
    revision: null,
    healthz: null,
    ui: {},
    quote: {},
    create: {},
    services: {},
    payments: {},
    safety: {},
    errors: [],
  };

  proof.healthz = (await req('GET', '/healthz')).status;
  if (proof.healthz !== 200) {
    proof.result = 'FAIL';
    proof.errors.push('healthz before deploy not 200');
  }

  proof.revision = deploy();
  proof.healthz_after = (await req('GET', '/healthz')).status;
  if (proof.healthz_after !== 200) proof.errors.push('healthz after deploy not 200');
  if (proof.revision.image !== IMAGE) proof.errors.push(`image mismatch: ${proof.revision.image}`);

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');

  const ui = await req('GET', '/staff/ui', null, cookie);
  const html = ui.raw || '';
  const panel = html.match(/id="bc-sel-panel"[\s\S]{0,12000}/)?.[0] || '';
  proof.ui = {
    title_create_new_booking: /Create New Booking/.test(panel) && !/New Booking Preview/.test(panel),
    no_preview_banner: !/PREVIEW ONLY/.test(panel),
    add_services_heading: /Add Services/.test(panel),
    soft_board_rental_label: /Soft board rental/.test(panel),
    no_soft_top_rental: !/Soft top rental/.test(panel),
    meal_singular: />\s*Meal\s*</.test(panel) || /Meal<\/label>/.test(panel) || /"Meal"/.test(panel.match(/bk-ao-meals[\s\S]{0,200}/)?.[0] || ''),
  };
  for (const [k, v] of Object.entries(proof.ui)) {
    if (!v) proof.errors.push(`ui.${k}`);
  }

  const slot = await findSlot(cookie);
  if (!slot) {
    proof.result = 'FAIL';
    proof.errors.push('no available slot');
    console.log(JSON.stringify(proof, null, 2));
    process.exit(1);
  }

  let payCountBefore = 0;
  let sendsBefore = 0;
  await withDb(async (c) => {
    payCountBefore = Number((await c.query('SELECT COUNT(*)::text AS c FROM payments')).rows[0].c);
    sendsBefore = Number((await c.query("SELECT COUNT(*)::text AS c FROM guest_message_sends WHERE status='sent'")).rows[0].c);
  });

  const quoteRes = await req('POST', '/staff/quote-preview?client=' + encodeURIComponent(CLIENT), {
    client_slug: CLIENT,
    check_in: slot.ci,
    check_out: slot.co,
    guest_count: 1,
    package_code: 'package_none',
    room_type: 'shared',
    payment_choice: 'no_payment_yet',
    add_ons: ADD_ONS,
  }, cookie);
  const quote = (quoteRes.body && quoteRes.body.quote) || {};
  const lines = quote.line_items || [];
  const lineByCode = Object.fromEntries(lines.map((l) => [l.code, l]));
  proof.quote = {
    http: quoteRes.status,
    success: quoteRes.body && quoteRes.body.success === true,
    line_codes: lines.map((l) => l.code),
    soft_combo_1500: lineByCode.wetsuit_soft_top_combo && lineByCode.wetsuit_soft_top_combo.unit_cents === 1500,
    soft_rental_1500: lineByCode.soft_top_rental && lineByCode.soft_top_rental.unit_cents === 1500,
    hard_combo_2000: lineByCode.wetsuit_hard_board_combo && lineByCode.wetsuit_hard_board_combo.unit_cents === 2000,
    hard_rental_2000: lineByCode.hard_board_rental && lineByCode.hard_board_rental.unit_cents === 2000,
    meal_line: !!lineByCode.meals,
    soft_board_name: (lineByCode.soft_top_rental && lineByCode.soft_top_rental.name) || null,
    meal_name: (lineByCode.meals && lineByCode.meals.name) || null,
  };
  if (!proof.quote.success) proof.errors.push('quote failed');
  if (!proof.quote.soft_combo_1500) proof.errors.push('soft combo price');
  if (!proof.quote.soft_rental_1500) proof.errors.push('soft rental price');
  if (!proof.quote.hard_combo_2000) proof.errors.push('hard combo price');
  if (!proof.quote.hard_rental_2000) proof.errors.push('hard rental price');
  if (!proof.quote.meal_line) proof.errors.push('meal quote line missing');
  if (proof.quote.soft_board_name !== 'Soft board rental') proof.errors.push(`soft name: ${proof.quote.soft_board_name}`);
  if (proof.quote.meal_name !== 'Meal') proof.errors.push(`meal name: ${proof.quote.meal_name}`);

  const idem = `stage26j2-services-${Date.now()}`;
  const createRes = await req('POST', '/staff/manual-bookings/create?client=' + encodeURIComponent(CLIENT), {
    client_slug: CLIENT,
    check_in: slot.ci,
    check_out: slot.co,
    selected_bed_codes: slot.beds,
    guest_count: 1,
    guest_name: GUEST,
    phone: '+3460026j2001',
    package_code: 'package_none',
    room_type: 'shared',
    payment_choice: 'no_payment_yet',
    add_ons: ADD_ONS,
    confirm: true,
    idempotency_key: idem,
  }, cookie);
  const createBody = createRes.body || {};
  const bookingCode = createBody.booking_code;
  proof.create = {
    http: createRes.status,
    success: createBody.success === true,
    booking_code: bookingCode,
    service_records_created: createBody.service_records_created,
    stripe_called: !!createBody.stripe_called,
    checkout_url: createBody.checkout_url || null,
  };
  if (!proof.create.success || !bookingCode) proof.errors.push('create failed');

  let svcRows = [];
  let payCountAfter = 0;
  let sendsAfter = 0;
  await withDb(async (c) => {
    svcRows = (await c.query(
      `SELECT service_type, service_date::text, amount_due_cents, quantity, metadata
       FROM booking_service_records WHERE client_slug=$1 AND booking_code=$2 ORDER BY created_at`,
      [CLIENT, bookingCode],
    )).rows;
    payCountAfter = Number((await c.query('SELECT COUNT(*)::text AS c FROM payments')).rows[0].c);
    sendsAfter = Number((await c.query("SELECT COUNT(*)::text AS c FROM guest_message_sends WHERE status='sent'")).rows[0].c);
    proof.create.payments_for_booking = Number((await c.query(
      'SELECT COUNT(*)::text AS c FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN clients c ON c.id=b.client_id WHERE c.slug=$1 AND b.booking_code=$2',
      [CLIENT, bookingCode],
    )).rows[0].c);
  });

  const sourceCodes = svcRows.map((r) => metaJson(r).source_addon_code).filter(Boolean);
  const allUnscheduled = svcRows.every((r) => r.service_date == null);
  const hasSoftIndividual = sourceCodes.includes('soft_top_rental');
  const hasHardIndividual = sourceCodes.includes('hard_board_rental');
  const hasMeal = sourceCodes.includes('meals');
  const hasSoftCombo = sourceCodes.includes('wetsuit_soft_top_combo');
  const hasHardCombo = sourceCodes.includes('wetsuit_hard_board_combo');

  proof.services = {
    row_count: svcRows.length,
    source_addon_codes: sourceCodes,
    all_unscheduled: allUnscheduled,
    soft_individual_logged: hasSoftIndividual,
    hard_individual_logged: hasHardIndividual,
    meal_logged: hasMeal,
    soft_combo_logged: hasSoftCombo,
    hard_combo_logged: hasHardCombo,
    soft_individual_amount: svcRows.find((r) => metaJson(r).source_addon_code === 'soft_top_rental')?.amount_due_cents,
    hard_individual_amount: svcRows.find((r) => metaJson(r).source_addon_code === 'hard_board_rental')?.amount_due_cents,
    meal_amount: svcRows.find((r) => metaJson(r).source_addon_code === 'meals')?.amount_due_cents,
  };
  if (!hasSoftIndividual) proof.errors.push('soft individual not logged');
  if (!hasHardIndividual) proof.errors.push('hard individual not logged');
  if (!hasMeal) proof.errors.push('meal not logged');
  if (!allUnscheduled) proof.errors.push('services not all unscheduled');

  const ctx = await req('GET', `/staff/bookings/${bookingCode}/context?client=${encodeURIComponent(CLIENT)}`, null, cookie);
  const ctxBody = ctx.body || {};
  const paidList = ctxBody.paid_requested_services || [];
  const paidText = paidList.map((x) => x.label || x.name || x.line || JSON.stringify(x)).join(' | ');
  const schedule = ctxBody.services_schedule || {};
  const ledger = ledgerFromContext(ctxBody);
  const quoteSvcTotal = lines.reduce((s, l) => s + Number(l.total_cents || 0), 0);

  proof.payments = {
    context_http: ctx.status,
    paid_requested_count: paidList.length,
    paid_requested_text: paidText,
    includes_soft_board: /Soft board/i.test(paidText),
    includes_hard_board: /Hard board/i.test(paidText),
    includes_meal: /\bMeal\b/i.test(paidText),
    total_services_cents: schedule.total_services_cents,
    ledger_svc_total: ledger.svc_total_cents,
    ledger_invoice: ledger.invoice_total_cents,
    balance_due: ctxBody.booking && ctxBody.booking.balance_due_cents,
    quote_addon_total: quoteSvcTotal,
  };
  if (!proof.payments.includes_soft_board) proof.errors.push('paid summary missing soft board');
  if (!proof.payments.includes_hard_board) proof.errors.push('paid summary missing hard board');
  if (!proof.payments.includes_meal) proof.errors.push('paid summary missing meal');
  if (Number(proof.payments.total_services_cents || 0) <= 0) proof.errors.push('total services zero');
  if (Number(proof.payments.ledger_svc_total || 0) < quoteSvcTotal) proof.errors.push('ledger svc total below quote');

  proof.safety = {
    pay_count_delta: payCountAfter - payCountBefore,
    sends_delta: sendsAfter - sendsBefore,
    no_stripe_on_create: !proof.create.stripe_called && !proof.create.checkout_url,
    no_whatsapp_sends: sendsAfter === sendsBefore,
    payments_for_booking: proof.create.payments_for_booking,
  };
  if (proof.safety.sends_delta > 0) proof.errors.push('whatsapp sends increased');

  if (proof.errors.length) proof.result = proof.revision.image === IMAGE ? 'PARTIAL' : 'FAIL';
  if (proof.errors.some((e) => e.includes('create failed') || e.includes('healthz') || e.includes('image mismatch'))) {
    proof.result = 'FAIL';
  }

  console.log(JSON.stringify(proof, null, 2));
  process.exit(proof.result === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
