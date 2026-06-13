'use strict';
/** Phase 22g.1 — guest_message_events persistence sanity. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const ROUTE = '/staff/meta/whatsapp/webhook';
const CLIENT = 'wolfhouse-somo';
const TEST_FROM = '491726422307';
const PROFILE = 'Phase 22g1 Event Proof';
const PROOF_START = new Date().toISOString();

const WA_PARTIAL = 'wamid.phase22g1.persist.partial.001';
const WA_COMPLETE = 'wamid.phase22g1.persist.complete.001';
const TEXT_PARTIAL = 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?';
const TEXT_COMPLETE =
  'Hi, we are 2 people and want Malibu from October 13 to October 16. We can pay the deposit.';
const IDEM_COMPLETE = `luna-booking:${CLIENT}:${WA_COMPLETE}:v1`;

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function httpsReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({ hostname: HOST, path, method, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function metaText(waId, text) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '34663439419', phone_number_id: '1152900101233109' },
          contacts: [{ profile: { name: PROFILE }, wa_id: TEST_FROM }],
          messages: [{
            from: TEST_FROM,
            id: waId,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: text },
          }],
        },
      }],
    }],
  };
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

function summarizeResponse(body) {
  if (!body || typeof body !== 'object') return { raw: true };
  const p = body.booking_write_preview || {};
  return {
    received: body.received,
    draft_called: body.draft_called,
    next_action: body.next_action,
    event_persisted: body.event_persisted,
    duplicate: body.duplicate,
    idempotent_replay: body.idempotent_replay,
    sends_whatsapp: body.sends_whatsapp,
    creates_booking: body.creates_booking,
    creates_payment: body.creates_payment,
    creates_stripe_link: body.creates_stripe_link,
    normalized_supported: body.normalized && body.normalized.supported,
    booking_write_preview: p.eligible != null ? {
      eligible: p.eligible,
      blocked_reasons: p.blocked_reasons,
      idempotency_key_preview: p.idempotency_key_preview,
      has_payload_preview: !!p.booking_create_payload_preview,
    } : null,
  };
}

function parseNorm(row) {
  if (!row || !row.normalized) return null;
  return typeof row.normalized === 'string' ? JSON.parse(row.normalized) : row.normalized;
}

async function pgConnect() {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

async function dbSnapshot(pg) {
  const total = await pg.query('SELECT COUNT(*)::int AS n FROM guest_message_events');
  const byWa = async (waId) => {
    const r = await pg.query(
      `SELECT wa_message_id, from_phone, profile_name, message_text, draft_called, next_action,
              handoff_required, send_attempted, send_status, normalized, created_at
         FROM guest_message_events
        WHERE client_slug = $1 AND wa_message_id = $2`,
      [CLIENT, waId],
    );
    const c = await pg.query(
      'SELECT COUNT(*)::int AS n FROM guest_message_events WHERE client_slug = $1 AND wa_message_id = $2',
      [CLIENT, waId],
    );
    return { row: r.rows[0] || null, count: c.rows[0].n };
  };

  const bookings = await pg.query(
    `SELECT b.id::text, b.booking_code, b.guest_name, b.created_at
       FROM bookings b INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND (b.guest_name = $2 OR b.phone LIKE $3)
        AND b.created_at >= $4::timestamptz`,
    [CLIENT, PROFILE, `%${TEST_FROM}%`, PROOF_START],
  );
  const payments = await pg.query(
    'SELECT id::text, status::text, stripe_checkout_session_id, created_at FROM payments WHERE created_at >= $1::timestamptz',
    [PROOF_START],
  );
  const sent = await pg.query(
    `SELECT idempotency_key, status FROM guest_message_sends
      WHERE client_slug = $1 AND status = 'sent' AND created_at >= $2::timestamptz`,
    [CLIENT, PROOF_START],
  );

  const partial = await byWa(WA_PARTIAL);
  const complete = await byWa(WA_COMPLETE);

  return {
    guest_message_events_total: total.rows[0].n,
    partial,
    complete,
    bookings: bookings.rows,
    payments: payments.rows,
    guest_message_sends_sent: sent.rows,
  };
}

function summarizeEventRow(row) {
  if (!row) return null;
  const norm = parseNorm(row);
  const p = norm && norm.booking_write_preview;
  return {
    wa_message_id: row.wa_message_id,
    from_phone: row.from_phone,
    profile_name: row.profile_name,
    message_text: row.message_text,
    draft_called: row.draft_called,
    next_action: row.next_action,
    normalized_present: !!norm,
    normalized_supported: norm && norm.supported,
    booking_write_preview: p ? {
      eligible: p.eligible,
      blocked_reasons: p.blocked_reasons,
      idempotency_key_preview: p.idempotency_key_preview,
      has_payload_preview: !!p.booking_create_payload_preview,
    } : null,
  };
}

(async () => {
  const out = {
    phase: '22g.1',
    proof_start: PROOF_START,
    revision: null,
    env_before: null,
    env_after: null,
    health_before: null,
    health_after: null,
    gme_count_before: null,
    gme_count_after: null,
    case_a: null,
    case_a_db: null,
    case_a_replay: null,
    case_b: null,
    case_b_db: null,
    safety: null,
    root_cause_theory: null,
    result: 'PENDING',
  };

  try {
    out.revision = activeRevision();
    out.env_before = stagingEnvFlags();
    out.health_before = (await httpsReq('GET', '/healthz')).status;

    const pg0 = await pgConnect();
    const before = await dbSnapshot(pg0);
    await pg0.end();
    out.gme_count_before = before.guest_message_events_total;

    const preErrs = [];
    if (out.health_before !== 200) preErrs.push('health');
    if (out.env_before.WHATSAPP_DRY_RUN !== 'true') preErrs.push('WHATSAPP_DRY_RUN');
    if (out.env_before.STRIPE_LINKS_ENABLED !== 'false') preErrs.push('STRIPE_LINKS_ENABLED');
    if (preErrs.length) {
      out.result = 'FAIL';
      out.stop_reason = `precheck: ${preErrs.join(',')}`;
      throw new Error(out.stop_reason);
    }

    // Case A — partial inbound
    const respA = await httpsReq('POST', ROUTE, metaText(WA_PARTIAL, TEXT_PARTIAL));
    await new Promise((r) => setTimeout(r, 800));
    const pgA = await pgConnect();
    const dbA = await dbSnapshot(pgA);
    await pgA.end();

    const a = respA.body || {};
    const rowA = dbA.partial.row;
    const normA = parseNorm(rowA);
    const previewA = normA && normA.booking_write_preview;

    const caseAErrs = [];
    if (respA.status !== 200) caseAErrs.push(`http ${respA.status}`);
    if (a.received !== true) caseAErrs.push('received');
    if (!(a.normalized && a.normalized.supported === true)) caseAErrs.push('normalized.supported');
    if (a.draft_called !== true) caseAErrs.push('draft_called');
    if (!a.next_action || !/ask_missing_field|missing/.test(a.next_action)) caseAErrs.push('next_action');
    if (previewA && previewA.eligible !== false) caseAErrs.push('preview eligible should be false');
    if (previewA && previewA.booking_create_payload_preview) caseAErrs.push('payload should be absent');
    if (a.sends_whatsapp !== false) caseAErrs.push('sends_whatsapp');
    if (a.creates_booking === true || a.creates_payment === true || a.creates_stripe_link === true) {
      caseAErrs.push('write/stripe flags');
    }
    if (!rowA) caseAErrs.push('no DB row');
    else {
      if (!String(rowA.from_phone || '').includes('491726422307')) caseAErrs.push('from_phone');
      if (rowA.message_text !== TEXT_PARTIAL) caseAErrs.push('message_text');
      if (rowA.draft_called !== true) caseAErrs.push('db draft_called');
      if (!rowA.next_action) caseAErrs.push('db next_action');
      if (!normA) caseAErrs.push('normalized missing');
      if (previewA && previewA.eligible !== false) caseAErrs.push('db preview eligible');
    }
    if (dbA.bookings.length) caseAErrs.push('booking created');
    if (dbA.payments.length) caseAErrs.push('payment created');
    if (dbA.guest_message_sends_sent.length) caseAErrs.push('whatsapp sent');

    out.case_a = {
      http_status: respA.status,
      summary: summarizeResponse(a),
      checks: caseAErrs.length === 0,
      errors: caseAErrs,
      result: caseAErrs.length === 0 ? 'PASS' : 'FAIL',
    };
    out.case_a_db = {
      wa_count: dbA.partial.count,
      event: summarizeEventRow(rowA),
    };

    if (dbA.bookings.length || dbA.payments.length || dbA.guest_message_sends_sent.length) {
      out.result = 'FAIL';
      out.stop_reason = 'safety violation after case A';
      throw new Error(out.stop_reason);
    }

    // Case A replay
    const replayA = await httpsReq('POST', ROUTE, metaText(WA_PARTIAL, TEXT_PARTIAL));
    await new Promise((r) => setTimeout(r, 500));
    const pgAr = await pgConnect();
    const dbAr = await dbSnapshot(pgAr);
    await pgAr.end();

    const ra = replayA.body || {};
    const replayErrs = [];
    if (replayA.status !== 200) replayErrs.push(`http ${replayA.status}`);
    if (ra.duplicate !== true && ra.idempotent_replay !== true) replayErrs.push('duplicate/idempotent_replay');
    if (dbAr.partial.count !== 1) replayErrs.push(`wa count ${dbAr.partial.count}`);
    if (ra.sends_whatsapp !== false) replayErrs.push('sends_whatsapp');
    if (ra.creates_booking === true || ra.creates_payment === true) replayErrs.push('writes');

    out.case_a_replay = {
      http_status: replayA.status,
      summary: summarizeResponse(ra),
      wa_count_after: dbAr.partial.count,
      checks: replayErrs.length === 0,
      errors: replayErrs,
      result: replayErrs.length === 0 ? 'PASS' : 'FAIL',
    };

    // Case B — complete eligible inbound
    const respB = await httpsReq('POST', ROUTE, metaText(WA_COMPLETE, TEXT_COMPLETE));
    await new Promise((r) => setTimeout(r, 800));
    const pgB = await pgConnect();
    const dbB = await dbSnapshot(pgB);
    await pgB.end();

    const b = respB.body || {};
    const rowB = dbB.complete.row;
    const normB = parseNorm(rowB);
    const previewB = (b.booking_write_preview) || (normB && normB.booking_write_preview);

    const caseBErrs = [];
    if (respB.status !== 200) caseBErrs.push(`http ${respB.status}`);
    if (!b.booking_write_preview && !previewB) caseBErrs.push('booking_write_preview missing');
    if (!rowB) caseBErrs.push('no DB row');

    const eligible = previewB && previewB.eligible === true;
    const blocked = previewB && previewB.eligible === false;

    if (!eligible && !blocked) caseBErrs.push('preview eligible not determined');

    if (eligible) {
      if (previewB.idempotency_key_preview !== IDEM_COMPLETE) caseBErrs.push('idempotency_key_preview');
      if (!previewB.booking_create_payload_preview) caseBErrs.push('payload preview');
      if (b.creates_booking === true || b.creates_payment === true) caseBErrs.push('writes occurred');
    } else if (blocked) {
      if (!Array.isArray(previewB.blocked_reasons) || !previewB.blocked_reasons.length) {
        caseBErrs.push('blocked_reasons');
      }
    }

    if (b.sends_whatsapp !== false) caseBErrs.push('sends_whatsapp');
    if (dbB.bookings.length) caseBErrs.push('booking created');
    if (dbB.payments.length) caseBErrs.push('payment created');
    if (dbB.guest_message_sends_sent.length) caseBErrs.push('whatsapp sent');

    out.case_b = {
      http_status: respB.status,
      summary: summarizeResponse(b),
      eligible,
      blocked,
      blocked_reasons: previewB && previewB.blocked_reasons,
      checks: caseBErrs.length === 0,
      errors: caseBErrs,
      result: caseBErrs.length === 0 ? 'PASS' : 'FAIL',
    };
    out.case_b_db = {
      wa_count: dbB.complete.count,
      event: summarizeEventRow(rowB),
    };

    out.gme_count_after = dbB.guest_message_events_total;
    out.gme_count_delta = out.gme_count_after - out.gme_count_before;

    out.safety = {
      bookings_created: dbB.bookings.length,
      payments_created: dbB.payments.length,
      stripe_sessions: dbB.payments.filter((p) => p.stripe_checkout_session_id).length,
      guest_message_sends_sent: dbB.guest_message_sends_sent.length,
      no_writes: dbB.bookings.length === 0 && dbB.payments.length === 0,
      no_whatsapp: dbB.guest_message_sends_sent.length === 0,
    };

    out.root_cause_theory =
      'guest_message_events was empty at Phase 22g because POST /staff/test/reset-luna-phone '
      + 'deletes all guest_message_events (and guest_message_sends) for test phone 491726422307. '
      + 'Phase 22 inbound proofs used that phone; a reset between 22d and 22g would wipe historical rows '
      + 'without affecting bookings/payments (separate tables). Fresh inbound persistence is intact.';

    const allPass = out.case_a.result === 'PASS'
      && out.case_a_replay.result === 'PASS'
      && out.case_b.result === 'PASS'
      && out.gme_count_delta >= 2;

    out.result = allPass ? 'PASS' : (out.case_a.result === 'PASS' || out.case_b.result === 'PASS' ? 'PARTIAL' : 'FAIL');
  } catch (err) {
    if (out.result === 'PENDING') out.result = 'FAIL';
    out.error = err.message;
  } finally {
    out.revision_after = activeRevision();
    out.env_after = stagingEnvFlags();
    out.health_after = (await httpsReq('GET', '/healthz')).status;
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.result === 'PASS' ? 0 : 1);
  }
})();
