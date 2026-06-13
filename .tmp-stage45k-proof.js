'use strict';
/** Stage 45k — preflight + post-payment proof. Temp — do not commit. */

const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_CODE = 'WH-G27-F88DB3CBBD';
const GUEST_PHONE = '+34600995567';
const CONV_ID = '0a38cd5a-2b2b-4406-9adc-33cc6c3a2bd0';
const SESSION_ID = 'cs_test_a142nxPQn5zl4CusjeAxIpk5b2OX5SalnGnCH8NJGswQdpLZGYfAuT3uAM';
const CAL_START = '2026-08-01';
const CAL_END = '2026-08-31';
const PROOF_SINCE = process.argv[2] === 'after' ? (process.env.STAGE45K_PROOF_SINCE || new Date(Date.now() - 60 * 60 * 1000).toISOString()) : new Date().toISOString();

function az(c) { return execSync(c, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 }).trim(); }

function pickEnv(name) {
  const envRaw = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json'));
  const e = envRaw.find((x) => x.name === name);
  if (!e) return null;
  return e.secretRef ? `(secret:${e.secretRef})` : e.value;
}

async function httpsJson(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: STAFF_HOST, path, method,
      headers: { Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch { resolve({ status: res.statusCode, body: buf }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function staffLogin() {
  const login = await httpsJson('POST', '/staff/auth/login', {
    client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  return (login.headers?.['set-cookie'] || []).map?.((x) => x.split(';')[0]).join('; ')
    || (await new Promise((res) => {
      const data = JSON.stringify({ client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!' });
      const req = https.request({
        hostname: STAFF_HOST, path: '/staff/auth/login', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, (r) => {
        let b = '';
        r.on('data', (c) => { b += c; });
        r.on('end', () => res((r.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ')));
      });
      req.write(data);
      req.end();
    }));
}

async function dbSnapshot(pg) {
  const bk = (await pg.query(`
    SELECT id::text, booking_code, status::text, payment_status::text,
           amount_paid_cents, balance_due_cents, total_amount_cents, deposit_required_cents,
           confirmation_sent_at, check_in::text, check_out::text,
           metadata->>'confirmation_draft' IS NOT NULL AS has_confirmation_draft
      FROM bookings WHERE booking_code = $1`, [BOOKING_CODE])).rows[0];
  const pays = (await pg.query(`
    SELECT id::text, status::text, payment_kind::text, currency, amount_due_cents, amount_paid_cents,
           stripe_checkout_session_id, stripe_payment_intent_id, checkout_url, paid_at::text, metadata
      FROM payments WHERE booking_id = $1::uuid ORDER BY created_at ASC`, [bk?.id])).rows;
  const payCount = bk ? (await pg.query('SELECT COUNT(*)::int AS n FROM payments WHERE booking_id = $1::uuid', [bk.id])).rows[0].n : 0;
  const bkCount = (await pg.query('SELECT COUNT(*)::int AS n FROM bookings WHERE booking_code = $1', [BOOKING_CODE])).rows[0].n;
  const beds = bk ? (await pg.query('SELECT bed_code, room_code FROM booking_beds WHERE booking_id = $1::uuid ORDER BY bed_code', [bk.id])).rows : [];
  const events = bk ? (await pg.query(`
    SELECT id::text, event_type, stripe_event_id, processed, created_at::text
      FROM payment_events WHERE payment_id IN (SELECT id FROM payments WHERE booking_id = $1::uuid)
      ORDER BY created_at DESC LIMIT 10`, [bk.id])).rows : [];
  const phoneRaw = GUEST_PHONE.replace(/^\+/, '');
  const sends = (await pg.query(`
    SELECT idempotency_key, status, send_kind, created_at::text
      FROM guest_message_sends
     WHERE created_at >= $1::timestamptz
       AND (to_phone = $2 OR to_phone = $3 OR to_phone = $4)
       AND send_kind ILIKE '%confirm%'
     ORDER BY created_at DESC`, [PROOF_SINCE, GUEST_PHONE, phoneRaw, `+${phoneRaw}`])).rows;
  return { booking: bk, payments: pays, payment_row_count: payCount, booking_row_count: bkCount, beds, payment_events: events, confirmation_sends: sends };
}

(async () => {
  const mode = process.argv[2] || 'preflight';
  const rev = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json')).find((r) => r.properties.trafficWeight === 100);
  const hz = await httpsJson('GET', '/healthz');
  const sk = az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name stripe-secret-key --query value -o tsv');
  const whSecret = az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name stripe-webhook-secret --query value -o tsv');

  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  if (!/staging|wolfhouse_staging/i.test(whUrl)) throw new Error('DB guard: not staging');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const db = await dbSnapshot(pg);
  await pg.end();

  let stripeSession = null;
  try {
    const stripe = require('stripe')(sk);
    stripeSession = await stripe.checkout.sessions.retrieve(SESSION_ID);
  } catch (e) {
    stripeSession = { error: e.message };
  }

  const payUrl = `https://${STAFF_HOST}/pay/${BOOKING_CODE}`;
  const checkoutUrl = db.payments[0]?.checkout_url || stripeSession?.url || null;

  const out = {
    phase: mode === 'after' ? 'stage45k-post-payment' : 'stage45k-preflight',
    proof_since: PROOF_SINCE,
    deploy: { revision: rev?.name, health: rev?.properties?.healthState, image: rev?.properties?.template?.containers?.[0]?.image, healthz: hz.body },
    stripe: {
      secret_prefix: sk.slice(0, 12),
      test_mode: sk.startsWith('sk_test_'),
      live_blocked: sk.startsWith('sk_live_'),
      webhook_secret_present: !!whSecret,
      webhook_endpoint: `https://${STAFF_HOST}/staff/stripe/webhook`,
      session_id: SESSION_ID,
      session_cs_test: SESSION_ID.startsWith('cs_test_'),
      stripe_api_session: stripeSession ? {
        status: stripeSession.status,
        payment_status: stripeSession.payment_status,
        amount_total: stripeSession.amount_total,
        currency: stripeSession.currency,
      } : null,
    },
    env: {
      LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST: pickEnv('LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST'),
      OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: pickEnv('OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED'),
      WHATSAPP_DRY_RUN: pickEnv('WHATSAPP_DRY_RUN'),
      STRIPE_WEBHOOK_SKIP_VERIFY: pickEnv('STRIPE_WEBHOOK_SKIP_VERIFY'),
    },
    payment_urls: { pay_short_link: payUrl, stripe_checkout_url: checkoutUrl },
    db,
  };

  if (mode === 'after') {
    const cookie = await staffLogin();
    const cal = await httpsJson('GET', `/staff/bed-calendar?client=${encodeURIComponent(CLIENT)}&start=${CAL_START}&end=${CAL_END}`, null, { Cookie: cookie });
    const blocks = (cal.body?.blocks || []).filter((b) => b.booking_code === BOOKING_CODE);
    const ctx = await httpsJson('GET', `/staff/conversations/${CONV_ID}/context?client=${CLIENT}`, null, { Cookie: cookie });
    out.staff_portal = {
      calendar_blocks: blocks,
      conversation_context: {
        bookings: ctx.body?.bookings || [],
        context: ctx.body?.context || null,
      },
    };
    const b = db.booking || {};
    const p = db.payments[0] || {};
    out.status_mismatch_notes = [];
    if (b.payment_status === 'deposit_paid' && b.status === 'hold') {
      out.status_mismatch_notes.push('Expected: hold + deposit_paid (deposit-only path) — matches design');
    } else if (b.payment_status === 'paid' && b.status === 'confirmed') {
      out.status_mismatch_notes.push('Full payment path: confirmed + paid');
    } else {
      out.status_mismatch_notes.push(`Actual: booking.status=${b.status}, payment_status=${b.payment_status}`);
    }
    out.result = (
      p.status === 'paid'
      && p.amount_paid_cents === 20000
      && p.currency === 'EUR'
      && String(p.stripe_checkout_session_id || '').startsWith('cs_test_')
      && (b.payment_status === 'deposit_paid' || b.payment_status === 'paid')
      && b.amount_paid_cents === 20000
      && !b.confirmation_sent_at
      && db.confirmation_sends.length === 0
      && db.beds.every((bed) => /^R\d+-B\d+$/i.test(bed.bed_code))
      && db.payment_row_count === 1
      && db.booking_row_count === 1
    ) ? 'PASS' : 'PARTIAL';
    out.cleanup = {
      note: 'Booking can remain for friend testing; use cleanup when done',
      dry_run: `npm run cleanup:open-demo-booking -- --phone ${GUEST_PHONE} --dry-run`,
      confirm: `npm run cleanup:open-demo-booking -- --phone ${GUEST_PHONE} --confirm-cleanup`,
    };
  }

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
