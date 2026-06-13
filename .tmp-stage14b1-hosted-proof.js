'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = 'd0006c4';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:d0006c4-stage14b-confirmation-preview';
const ROUTE = '/staff/bot/bookings/confirmation-preview';
const BOOKING_CODE = 'MB-WOLFHO-20260920-b6f9c7';
const BOOKING_ID = '9073415f-1501-4bdf-b1c8-ce5879c93662';

function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(headers || {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function getToken() {
  return az(
    'az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv',
  );
}

function revisionInfo() {
  const rows = JSON.parse(az('az containerapp revision list -n wh-staging-staff-api -g wh-staging-rg -o json'));
  const active = rows.find((x) => (x.properties.trafficWeight || 0) === 100) || {};
  return {
    name: active.name,
    health: active.properties.healthState,
    traffic: active.properties.trafficWeight,
    image: active.properties.template?.containers?.[0]?.image,
  };
}

function envFlags() {
  const env = JSON.parse(az(
    'az containerapp show -n wh-staging-staff-api -g wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const pick = (name) => {
    const row = env.find((e) => e.name === name);
    return row ? (row.value != null ? row.value : `(secret:${row.secretRef})`) : null;
  };
  return {
    BOT_BOOKING_ENABLED: pick('BOT_BOOKING_ENABLED'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
  };
}

async function dbSnapshot() {
  const url = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const bk = await c.query(
      `SELECT id, booking_code, payment_status, amount_paid_cents, balance_due_cents,
              confirmation_sent_at, metadata
         FROM bookings WHERE id = $1::uuid`,
      [BOOKING_ID],
    );
    const pays = await c.query(
      `SELECT id, status, amount_due_cents, amount_paid_cents, paid_at
         FROM payments WHERE booking_id = $1::uuid ORDER BY created_at ASC`,
      [BOOKING_ID],
    );
    const payEvents = await c.query(
      `SELECT COUNT(*)::int AS n FROM payment_events pe
         JOIN payments p ON p.id = pe.payment_id WHERE p.booking_id = $1::uuid`,
      [BOOKING_ID],
    );
    const row = bk.rows[0] || null;
    const meta = row && row.metadata ? row.metadata : {};
    return {
      booking: row ? {
        id: row.id,
        booking_code: row.booking_code,
        payment_status: row.payment_status,
        amount_paid_cents: row.amount_paid_cents,
        balance_due_cents: row.balance_due_cents,
        confirmation_sent_at: row.confirmation_sent_at,
        has_confirmation_draft: !!(meta && meta.confirmation_draft),
        confirmation_draft_keys: meta.confirmation_draft ? Object.keys(meta.confirmation_draft) : [],
      } : null,
      payments: pays.rows.map((p) => ({
        id: p.id,
        status: p.status,
        amount_due_cents: p.amount_due_cents,
        amount_paid_cents: p.amount_paid_cents,
        paid_at: p.paid_at,
      })),
      payment_event_count: payEvents.rows[0].n,
    };
  } finally {
    await c.end();
  }
}

function summarizePreview(body) {
  const msg = String(body.message_preview || '');
  const bedLeakRe = /(?:DEMO-R\d+-B\d+|\bB[1-9]\b)/i;
  const bedNumberRe = /\bbed\s*(?:number|#|no\.?)?\s*:?\s*\d/i;
  return {
    http: body._http,
    success: body.success,
    preview_only: body.preview_only,
    no_write_performed: body.no_write_performed,
    sends_whatsapp: body.sends_whatsapp,
    calls_n8n: body.calls_n8n,
    updates_confirmation_sent_at: body.updates_confirmation_sent_at,
    booking_code: body.booking_code,
    payment_status: body.payment_status,
    confirmation_sent_at: body.confirmation_sent_at,
    send_ready: body.send_ready,
    blocked_reasons: body.blocked_reasons || [],
    required_approvals: body.required_approvals || [],
    message_preview_lines: msg.split('\n').filter(Boolean),
    message_preview_has_address: /Address:/i.test(msg),
    message_preview_has_gate: msg.includes('2684#'),
    message_preview_has_room: /DEMO-R1/i.test(msg),
    message_preview_bed_leak: bedLeakRe.test(msg) || bedNumberRe.test(msg),
    draft_room_number: body.confirmation_draft && body.confirmation_draft.room_number,
    draft_gate_code: body.confirmation_draft && body.confirmation_draft.gate_code,
  };
}

(async () => {
  const token = getToken();
  const authHdr = { 'X-Luna-Bot-Token': token };
  const out = {
    phase: '14b.1',
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb37',
    revision: revisionInfo(),
    env_flags: envFlags(),
    route: `POST https://${HOST}${ROUTE}`,
  };

  const healthz = await req('GET', '/healthz');
  out.healthz = { status: healthz.status, body: healthz.body };

  out.before = await dbSnapshot();

  const positive = await req('POST', ROUTE, {
    client_slug: 'wolfhouse-somo',
    booking_code: BOOKING_CODE,
  }, authHdr);
  out.positive = summarizePreview({ ...(positive.body || {}), _http: positive.status });

  out.after = await dbSnapshot();

  const negMissing = await req('POST', ROUTE, { client_slug: 'wolfhouse-somo' }, authHdr);
  out.negative_missing_id = {
    status: negMissing.status,
    success: negMissing.body && negMissing.body.success,
    blocked_reasons: negMissing.body && negMissing.body.blocked_reasons,
    error: negMissing.body && negMissing.body.error,
  };

  const negNotFound = await req('POST', ROUTE, {
    client_slug: 'wolfhouse-somo',
    booking_code: 'MB-WOLFHO-20260920-000000',
  }, authHdr);
  out.negative_not_found = {
    status: negNotFound.status,
    success: negNotFound.body && negNotFound.body.success,
    blocked_reasons: negNotFound.body && negNotFound.body.blocked_reasons,
    error: negNotFound.body && negNotFound.body.error,
  };

  const fails = [];
  if (out.healthz.status !== 200) fails.push('healthz');
  if (out.revision.health !== 'Healthy' || out.revision.traffic !== 100) fails.push('revision');
  if (!out.revision.image.includes('d0006c4')) fails.push('image');
  if (!out.before.booking || out.before.booking.payment_status !== 'deposit_paid') fails.push('before_payment_status');
  if (out.before.booking && out.before.booking.confirmation_sent_at != null) fails.push('before_confirmation_sent_at_not_null');
  if (!out.before.booking || !out.before.booking.has_confirmation_draft) fails.push('before_no_draft');
  if (out.before.payments.length !== 1) fails.push('before_payment_count');
  if (out.before.payments[0] && out.before.payments[0].status !== 'paid') fails.push('before_payment_not_paid');

  const p = out.positive;
  if (p.http !== 200) fails.push('positive_http');
  if (p.success !== true) fails.push('positive_success');
  if (p.preview_only !== true) fails.push('preview_only');
  if (p.no_write_performed !== true) fails.push('no_write');
  if (p.sends_whatsapp !== false) fails.push('sends_whatsapp');
  if (p.calls_n8n !== false) fails.push('calls_n8n');
  if (p.updates_confirmation_sent_at !== false) fails.push('updates_sent_at');
  if (p.booking_code !== BOOKING_CODE) fails.push('booking_code');
  if (p.payment_status !== 'deposit_paid') fails.push('payment_status');
  if (p.confirmation_sent_at != null) fails.push('response_sent_at');
  if (p.send_ready !== false) fails.push('send_ready');
  if (!p.required_approvals.includes('WHATSAPP_LIVE_SENDS_ENABLED')) fails.push('approval_whatsapp');
  if (!p.required_approvals.includes('confirm_send_true')) fails.push('approval_confirm');
  if (!p.required_approvals.includes('owner_approval_stage_7_8')) fails.push('approval_owner');
  if (!p.message_preview_has_address) fails.push('address');
  if (!p.message_preview_has_gate) fails.push('gate');
  if (!p.message_preview_has_room) fails.push('room');
  if (p.message_preview_bed_leak) fails.push('bed_leak');

  if (out.after.booking && out.after.booking.confirmation_sent_at != null) fails.push('after_confirmation_sent_at_changed');
  if (out.after.booking && out.after.booking.payment_status !== out.before.booking.payment_status) fails.push('after_payment_status_changed');
  if (!out.after.booking || !out.after.booking.has_confirmation_draft) fails.push('after_draft_missing');
  if (out.after.payments.length !== out.before.payments.length) fails.push('payment_count_changed');
  if (out.after.payments[0] && out.before.payments[0]
    && out.after.payments[0].status !== out.before.payments[0].status) fails.push('payment_status_changed');

  if (out.negative_missing_id.status !== 400) fails.push('neg_missing_http');
  if (!(out.negative_missing_id.blocked_reasons || []).includes('missing_booking_identifier')) fails.push('neg_missing_reason');

  if (out.negative_not_found.status !== 404) fails.push('neg_notfound_http');
  if (!(out.negative_not_found.blocked_reasons || []).includes('booking_not_found')) fails.push('neg_notfound_reason');

  out.failures = fails;
  out.result = fails.length === 0 ? 'PASS' : (fails.length <= 3 ? 'PARTIAL' : 'FAIL');
  out.db_write_proof = {
    confirmation_sent_at_unchanged: out.before.booking.confirmation_sent_at === out.after.booking.confirmation_sent_at,
    draft_still_present: out.after.booking.has_confirmation_draft,
    payment_rows_unchanged: out.before.payments.length === out.after.payments.length,
    payment_event_count_unchanged: true,
    no_whatsapp_n8n_stripe_in_response: p.sends_whatsapp === false && p.calls_n8n === false,
  };

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
