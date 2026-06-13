'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = '5d4c647';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:5d4c647-stage14b3-address';
const ROUTE = '/staff/bot/bookings/confirmation-preview';
const BOOKING_CODE = 'MB-WOLFHO-20260920-b6f9c7';
const BOOKING_ID = '9073415f-1501-4bdf-b1c8-ce5879c93662';
const CONFIRMED_ADDRESS = 'C. Mies de La Ran, 41, 39140 Somo, Cantabria';
const GATE = '2684#';
const CONFIG_LOCAL = path.join(__dirname, 'config', 'clients', 'wolfhouse-somo.baseline.json');

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

function localConfigProof() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_LOCAL, 'utf8'));
  const conf = cfg.confirmation || {};
  return {
    address: conf.address || null,
    gate_code: conf.gate_code || null,
    include_address: conf.include_address === true,
    matches_expected: conf.address === CONFIRMED_ADDRESS && conf.gate_code === GATE && conf.include_address === true,
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
    const row = bk.rows[0] || null;
    const meta = row && row.metadata ? row.metadata : {};
    const draft = meta.confirmation_draft || null;
    return {
      booking: row ? {
        id: row.id,
        booking_code: row.booking_code,
        payment_status: row.payment_status,
        amount_paid_cents: row.amount_paid_cents,
        balance_due_cents: row.balance_due_cents,
        confirmation_sent_at: row.confirmation_sent_at,
        has_confirmation_draft: !!draft,
        confirmation_draft_address: draft ? draft.address : null,
      } : null,
      payments: pays.rows.map((p) => ({
        id: p.id,
        status: p.status,
        amount_due_cents: p.amount_due_cents,
        amount_paid_cents: p.amount_paid_cents,
      })),
    };
  } finally {
    await c.end();
  }
}

function summarizePreview(body, httpStatus) {
  const msg = String(body.message_preview || '');
  const bedLeakRe = /(?:DEMO-R\d+-B\d+|\bB[1-9]\b)/i;
  return {
    http: httpStatus,
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
    address_source: body.address_source,
    blocked_reasons: body.blocked_reasons || [],
    message_preview_lines: msg.split('\n').filter(Boolean),
    has_address_line: msg.includes(`Address: ${CONFIRMED_ADDRESS}`),
    has_gate: msg.includes(GATE),
    has_room: /Room:\s*DEMO-R1/.test(msg),
    bed_leak: bedLeakRe.test(msg),
  };
}

(async () => {
  const token = getToken();
  const authHdr = { 'X-Luna-Bot-Token': token };
  const out = {
    phase: '14b.3.1',
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb38',
    revision: revisionInfo(),
    env_flags: envFlags(),
    config_in_repo: localConfigProof(),
    route: `POST https://${HOST}${ROUTE}`,
  };

  for (let i = 0; i < 12 && (out.revision.health !== 'Healthy' || !out.revision.image.includes('5d4c647')); i++) {
    await new Promise((r) => setTimeout(r, 5000));
    out.revision = revisionInfo();
  }

  const healthz = await req('GET', '/healthz');
  out.healthz = { status: healthz.status, body: healthz.body };

  out.before = await dbSnapshot();

  const positive = await req('POST', ROUTE, {
    client_slug: 'wolfhouse-somo',
    booking_code: BOOKING_CODE,
  }, authHdr);
  out.positive = summarizePreview(positive.body || {}, positive.status);

  out.after = await dbSnapshot();

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
  if (!out.revision.image.includes('5d4c647')) fails.push('image');
  if (!out.config_in_repo.matches_expected) fails.push('config_repo');
  if (!out.before.booking || out.before.booking.payment_status !== 'deposit_paid') fails.push('before_payment_status');
  if (out.before.booking && out.before.booking.confirmation_sent_at != null) fails.push('before_sent_at');
  if (!out.before.booking || !out.before.booking.has_confirmation_draft) fails.push('before_no_draft');
  if (out.before.booking && out.before.booking.confirmation_draft_address != null) fails.push('before_draft_address_not_null');

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
  if (p.address_source !== 'client_config') fails.push('address_source');
  if (!p.has_address_line) fails.push('address_line');
  if (!p.has_gate) fails.push('gate');
  if (!p.has_room) fails.push('room');
  if (p.bed_leak) fails.push('bed_leak');

  if (out.after.booking && out.after.booking.confirmation_sent_at != null) fails.push('after_sent_at_changed');
  if (out.after.booking && out.after.booking.confirmation_draft_address !== out.before.booking.confirmation_draft_address) {
    fails.push('draft_address_mutated');
  }
  if (out.after.booking && out.after.booking.payment_status !== out.before.booking.payment_status) fails.push('payment_status_changed');
  if (out.after.booking && out.after.booking.balance_due_cents !== out.before.booking.balance_due_cents) fails.push('balance_changed');

  if (out.negative_not_found.status !== 404) fails.push('neg_notfound_http');
  if (!(out.negative_not_found.blocked_reasons || []).includes('booking_not_found')) fails.push('neg_notfound_reason');

  out.failures = fails;
  out.result = fails.length === 0 ? 'PASS' : (fails.length <= 2 ? 'PARTIAL' : 'FAIL');
  out.db_write_proof = {
    confirmation_sent_at_unchanged: out.before.booking.confirmation_sent_at === out.after.booking.confirmation_sent_at,
    draft_address_unchanged: out.before.booking.confirmation_draft_address === out.after.booking.confirmation_draft_address,
    payment_status_unchanged: out.before.booking.payment_status === out.after.booking.payment_status,
    balance_unchanged: out.before.booking.balance_due_cents === out.after.booking.balance_due_cents,
  };

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
