'use strict';
/** Phase 20e — confirmation preview after payment truth. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_ID = '828538c7-c6cb-4c6f-b45a-57a641af37cc';
const BOOKING_CODE = 'MB-WOLFHO-20260924-e90132';
const PAYMENT_ID = '7659e304-64d4-47cf-82b9-4be1e37ac913';
const IDEM = 'phase20b-booking-proof-001';
const ROUTE = '/staff/bot/bookings/confirmation-preview';
const PROOF_START = new Date().toISOString();

const BED_CODE_RE = /(?:DEMO-R\d+-B\d+|\bB[1-9]\b)/i;
const BED_NUMBER_RE = /\bbed\s*(?:number|#|no\.?)?\s*:?\s*\d/i;

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...(headers || {}) };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const r = https.request({ hostname: HOST, path, method, headers: h }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed, raw });
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

function stagingEnvFlags() {
  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const pick = (name) => {
    const row = env.find((e) => e.name === name);
    if (!row) return '(unset)';
    if (row.secretRef) return `(secret:${row.secretRef})`;
    return row.value != null ? row.value : '(unset)';
  };
  return {
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
    BOT_BOOKING_ENABLED: pick('BOT_BOOKING_ENABLED'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
  };
}

function getToken() {
  return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
}

async function pgConnect() {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

async function dbSnapshot(pg) {
  const bk = await pg.query(`
    SELECT b.id::text AS booking_id, b.booking_code, b.payment_status::text,
           b.amount_paid_cents, b.balance_due_cents, b.confirmation_sent_at,
           b.primary_room_code,
           b.metadata->'confirmation_draft' IS NOT NULL AS has_confirmation_draft
      FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND b.id = $2::uuid`, [CLIENT, BOOKING_ID]);

  const pay = await pg.query(`
    SELECT p.id::text AS payment_id, p.status::text, p.amount_paid_cents, p.amount_due_cents, p.paid_at
      FROM payments p WHERE p.id = $1::uuid`, [PAYMENT_ID]);

  const payCount = await pg.query('SELECT COUNT(*)::int AS n FROM payments WHERE booking_id = $1::uuid', [BOOKING_ID]);
  const bkCount = await pg.query(`
    SELECT COUNT(*)::int AS n FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND b.metadata->>'idempotency_key' = $2`, [CLIENT, IDEM]);

  const beds = await pg.query(`
    SELECT bb.bed_code, bb.room_code FROM booking_beds bb WHERE bb.booking_id = $1::uuid`, [BOOKING_ID]);

  const sends = await pg.query(`
    SELECT COUNT(*)::int AS n FROM guest_message_sends
     WHERE client_slug = $1 AND created_at >= $2::timestamptz AND status = 'sent'`,
    [CLIENT, PROOF_START]);

  return {
    booking: bk.rows[0] || null,
    payment: pay.rows[0] || null,
    payment_count: payCount.rows[0].n,
    booking_count: bkCount.rows[0].n,
    booking_beds: beds.rows,
    guest_message_sends_sent: sends.rows[0].n,
  };
}

function analyzePreview(body) {
  const msg = String(body.message_preview || '');
  const lower = msg.toLowerCase();
  return {
    success: body.success === true,
    preview_only: body.preview_only === true,
    no_write_performed: body.no_write_performed === true,
    sends_whatsapp: body.sends_whatsapp,
    calls_n8n: body.calls_n8n,
    updates_confirmation_sent_at: body.updates_confirmation_sent_at,
    send_ready: body.send_ready,
    payment_status: body.payment_status,
    confirmation_sent_at: body.confirmation_sent_at,
    message_preview_lines: msg.split('\n').filter(Boolean).length,
    has_confirmation_wording: /confirm/i.test(msg),
    has_address: /C\. Mies de La Ran|Somo|Cantabria/i.test(msg),
    has_gate_code: /2684#/.test(msg),
    has_room: /Room:/i.test(msg) && /DEMO-R1/i.test(msg),
    no_bed_code: !BED_CODE_RE.test(msg),
    no_bed_number: !BED_NUMBER_RE.test(msg),
    mentions_paid: /Paid:\s*€100/i.test(msg),
    mentions_balance: /Balance due:\s*€170/i.test(msg),
    not_fully_paid_wording: !/\bfully paid\b/i.test(msg) && !/paid in full/i.test(msg),
    deposit_paid_status: body.payment_status === 'deposit_paid',
    message_preview_excerpt: msg.split('\n').slice(0, 8).join(' | '),
  };
}

function previewChecks(a) {
  return {
    http_success: a.success === true,
    preview_only: a.preview_only === true,
    no_write: a.no_write_performed === true,
    no_whatsapp: a.sends_whatsapp === false,
    no_n8n: a.calls_n8n === false,
    no_sent_at_update_flag: a.updates_confirmation_sent_at === false,
    send_not_ready: a.send_ready === false,
    has_message: a.message_preview_lines >= 3,
    has_address: a.has_address,
    has_gate: a.has_gate_code,
    has_room: a.has_room,
    no_bed_leak: a.no_bed_code && a.no_bed_number,
    paid_wording: a.mentions_paid,
    balance_wording: a.mentions_balance,
    not_fully_paid: a.not_fully_paid_wording,
    deposit_paid_status: a.deposit_paid_status,
  };
}

(async () => {
  const token = getToken();
  const botHeaders = { 'X-Luna-Bot-Token': token };
  const payload = { client_slug: CLIENT, booking_id: BOOKING_ID };

  const out = {
    phase: '20e',
    proof_start: PROOF_START,
    booking_id: BOOKING_ID,
    booking_code: BOOKING_CODE,
    route: ROUTE,
    revision: null,
    env: null,
    health: null,
    db_before: null,
    step_a_preview: null,
    step_b_db_after: null,
    step_c_replay: null,
    result: 'PENDING',
  };

  try {
    out.revision = activeRevision();
    out.env = stagingEnvFlags();
    out.health = (await req('GET', '/healthz')).status;

    const pg0 = await pgConnect();
    out.db_before = await dbSnapshot(pg0);
    await pg0.end();

    const b0 = out.db_before.booking;
    const p0 = out.db_before.payment;
    out.db_before.checks = {
      booking_exists: !!b0,
      deposit_paid: b0 && b0.payment_status === 'deposit_paid',
      amount_paid_10000: b0 && Number(b0.amount_paid_cents) === 10000,
      balance_17000: b0 && Number(b0.balance_due_cents) === 17000,
      confirmation_sent_at_null: !b0 || !b0.confirmation_sent_at,
      has_confirmation_draft: b0 && b0.has_confirmation_draft,
      payment_paid: p0 && p0.status === 'paid',
      one_payment: out.db_before.payment_count === 1,
      one_booking: out.db_before.booking_count === 1,
      dry_run: out.env.WHATSAPP_DRY_RUN === 'true',
    };
    out.db_before.result = Object.values(out.db_before.checks).every(Boolean) ? 'PASS' : 'FAIL';

    if (out.db_before.result === 'FAIL') {
      out.result = 'FAIL';
      out.stop_reason = 'db_before_invalid';
      throw new Error(out.stop_reason);
    }

    const resA = await req('POST', ROUTE, payload, botHeaders);
    const analysisA = analyzePreview(resA.body || {});
    out.step_a_preview = {
      http_status: resA.status,
      analysis: analysisA,
      checks: previewChecks(analysisA),
    };
    out.step_a_preview.result = Object.values(out.step_a_preview.checks).every(Boolean) ? 'PASS' : 'PARTIAL';

    const pg1 = await pgConnect();
    out.db_after_a = await dbSnapshot(pg1);
    await pg1.end();

    out.step_b_db_after = {
      confirmation_sent_at: out.db_after_a.booking && out.db_after_a.booking.confirmation_sent_at,
      payment_status: out.db_after_a.payment && out.db_after_a.payment.status,
      booking_payment_status: out.db_after_a.booking && out.db_after_a.booking.payment_status,
      payment_count: out.db_after_a.payment_count,
      booking_count: out.db_after_a.booking_count,
      guest_message_sends_sent: out.db_after_a.guest_message_sends_sent,
      checks: {
        confirmation_sent_at_null: !out.db_after_a.booking || !out.db_after_a.booking.confirmation_sent_at,
        payment_still_paid: out.db_after_a.payment && out.db_after_a.payment.status === 'paid',
        booking_deposit_paid: out.db_after_a.booking && out.db_after_a.booking.payment_status === 'deposit_paid',
        no_new_payments: out.db_after_a.payment_count === 1,
        no_new_bookings: out.db_after_a.booking_count === 1,
        no_whatsapp_sends: out.db_after_a.guest_message_sends_sent === 0,
      },
    };
    out.step_b_db_after.result = Object.values(out.step_b_db_after.checks).every(Boolean) ? 'PASS' : 'FAIL';

    const resC = await req('POST', ROUTE, payload, botHeaders);
    const analysisC = analyzePreview(resC.body || {});
    out.step_c_replay = {
      http_status: resC.status,
      analysis: analysisC,
      checks: {
        ...previewChecks(analysisC),
        same_message: analysisC.message_preview_excerpt === analysisA.message_preview_excerpt,
        still_no_write_flags: analysisC.preview_only && analysisC.no_write_performed && analysisC.sends_whatsapp === false,
      },
    };
    out.step_c_replay.result = Object.values(out.step_c_replay.checks).every(Boolean) ? 'PASS' : 'PARTIAL';

    const pg2 = await pgConnect();
    out.db_after_c = await dbSnapshot(pg2);
    await pg2.end();

    out.step_c_replay.db_checks = {
      confirmation_sent_at_null: !out.db_after_c.booking || !out.db_after_c.booking.confirmation_sent_at,
      payment_unchanged: out.db_after_c.payment && out.db_after_c.payment.status === 'paid',
      counts_stable: out.db_after_c.payment_count === 1 && out.db_after_c.booking_count === 1,
    };

    if ([out.step_a_preview.result, out.step_b_db_after.result, out.step_c_replay.result].every((x) => x === 'PASS')) {
      out.result = 'PASS';
    } else if (out.step_b_db_after.result === 'PASS' && out.step_a_preview.result !== 'FAIL') {
      out.result = 'PARTIAL';
    } else {
      out.result = 'FAIL';
    }
  } catch (err) {
    if (out.result === 'PENDING') out.result = 'FAIL';
    out.error = err.message;
  } finally {
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.result === 'PASS' ? 0 : 1);
  }
})();
