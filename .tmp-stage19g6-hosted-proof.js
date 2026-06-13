'use strict';
/** Phase 19g.6 — hosted Meta inbound draft-to-send-gate proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const ROUTE = '/staff/meta/whatsapp/webhook';
const N8N_HOST = 'tywoods.app.n8n.cloud';
const COMMIT = 'd6a3642';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:d6a3642-stage19g6-meta-wa-send-gate';

const IDEM_KEYS = [
  'luna:wolfhouse-somo:wamid.phase19g6.partial.it.001:ask_missing_field',
  'luna:wolfhouse-somo:wamid.phase19g6.complete.en.001:show_quote',
  'luna:wolfhouse-somo:wamid.phase19g6.refund.001:handoff_to_staff',
  'luna:wolfhouse-somo:wamid.phase19g6.refund.001:show_quote',
  'luna:wolfhouse-somo:wamid.phase19g6.image.001:ask_missing_field',
];

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
        try { parsed = JSON.parse(buf); } catch { /* keep string */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function metaText(waId, text, profileName = 'Webhook IT Guest') {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: '842343435599477',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: '34663439419',
            phone_number_id: '1152900101233109',
          },
          contacts: [{ profile: { name: profileName }, wa_id: '491726422307' }],
          messages: [{
            from: '491726422307',
            id: waId,
            timestamp: '1760000000',
            type: 'text',
            text: { body: text },
          }],
        },
      }],
    }],
  };
}

function metaImage(waId) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: '1152900101233109' },
          messages: [{
            from: '491726422307',
            id: waId,
            timestamp: '1760000001',
            type: 'image',
            image: { id: 'fake-image-id', mime_type: 'image/jpeg' },
          }],
        },
      }],
    }],
  };
}

function stagingEnvFlags() {
  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const pick = (name) => {
    const row = env.find((e) => e.name === name);
    if (!row) return '(unset)';
    return row.value != null ? row.value : `(secret:${row.secretRef})`;
  };
  return {
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
  };
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  return rows.find((x) => x.properties.trafficWeight === 100) || rows[0] || {};
}

async function dbSnapshot() {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const sends = await pg.query(
    `SELECT idempotency_key, status, blocked_reasons, provider_message_id, created_at
     FROM guest_message_sends
     WHERE idempotency_key = ANY($1::text[])
     ORDER BY created_at DESC`,
    [IDEM_KEYS],
  );
  const recentBookings = await pg.query(
    `SELECT id, booking_code, created_at FROM bookings
     WHERE created_at > NOW() - INTERVAL '15 minutes' ORDER BY created_at DESC LIMIT 5`,
  );
  const recentPayments = await pg.query(
    `SELECT id, status, created_at FROM payments
     WHERE created_at > NOW() - INTERVAL '15 minutes' ORDER BY created_at DESC LIMIT 5`,
  );
  await pg.end();
  return { guest_message_sends: sends.rows, recent_bookings: recentBookings.rows, recent_payments: recentPayments.rows };
}

function blockedIncludes(body, reason) {
  const fromResult = body.send_result && Array.isArray(body.send_result.blocked_reasons)
    ? body.send_result.blocked_reasons : [];
  const top = Array.isArray(body.blocked_reasons) ? body.blocked_reasons : [];
  return fromResult.includes(reason) || top.includes(reason);
}

(async () => {
  for (let i = 0; i < 24; i++) {
    const rev = activeRevision();
    if (rev.properties.healthState === 'Healthy' && rev.properties.trafficWeight === 100
        && String(rev.properties.template.containers[0].image).includes('d6a3642-stage19g6')) break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  const rev = activeRevision();
  const envBefore = stagingEnvFlags();
  const dbBefore = await dbSnapshot();
  const health = await httpsReq('GET', '/healthz');

  const caseA = await httpsReq('POST', ROUTE, metaText(
    'wamid.phase19g6.partial.it.001',
    'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
  ));
  const caseB = await httpsReq('POST', ROUTE, metaText(
    'wamid.phase19g6.complete.en.001',
    'Hi, we are 2 people and want Malibu from September 24 to September 27. We can pay the deposit.',
    'Webhook EN Guest',
  ));
  const caseC = await httpsReq('POST', ROUTE, metaText(
    'wamid.phase19g6.refund.001',
    'I want a refund and need to talk to someone.',
    'Refund Guest',
  ));
  const caseD = await httpsReq('POST', ROUTE, metaImage('wamid.phase19g6.image.001'));

  const n8nProbe = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: N8N_HOST,
      path: '/webhook/booking-assistant',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf.slice(0, 120) }));
    });
    req.on('error', reject);
    req.write('{}');
    req.end();
  });

  const envAfter = stagingEnvFlags();
  const dbAfter = await dbSnapshot();

  const a = caseA.body || {};
  const b = caseB.body || {};
  const c = caseC.body || {};
  const d = caseD.body || {};

  const expectedAKey = 'luna:wolfhouse-somo:wamid.phase19g6.partial.it.001:ask_missing_field';
  const expectedBKey = 'luna:wolfhouse-somo:wamid.phase19g6.complete.en.001:show_quote';

  const checks = {
    A: caseA.status === 200 && a.draft_called === true && a.next_action === 'ask_missing_field'
      && /check-in|check-out|date/i.test(String(a.suggested_reply || ''))
      && a.send_attempted === true && a.idempotency_key === expectedAKey
      && a.send_result && a.send_result.send_performed === false && a.send_result.sends_whatsapp === false
      && blockedIncludes(a, 'luna_auto_send_not_enabled') && a.sends_whatsapp === false && a.calls_graph_api === false,
    B: caseB.status === 200 && b.draft_called === true && b.next_action === 'show_quote'
      && !!b.dry_run_plan && /€|deposit|270/i.test(String(b.suggested_reply || ''))
      && b.send_attempted === true && b.idempotency_key === expectedBKey
      && b.send_result && b.send_result.send_performed === false && b.send_result.sends_whatsapp === false
      && b.sends_whatsapp === false && b.calls_graph_api === false,
    C: caseC.status === 200 && c.draft_called === true && c.handoff_required === true
      && c.next_action === 'handoff_to_staff' && c.send_attempted === false
      && !c.send_result && c.sends_whatsapp === false,
    D: caseD.status === 200 && d.normalized && d.normalized.supported === false
      && d.draft_called === false && d.send_attempted === false
      && !d.suggested_reply && d.sends_whatsapp === false,
  };

  const sendRows = dbAfter.guest_message_sends;
  const refundRows = sendRows.filter((r) => r.idempotency_key.includes('refund'));
  const imageRows = sendRows.filter((r) => r.idempotency_key.includes('image'));
  const eligibleRows = sendRows.filter((r) =>
    r.idempotency_key.includes('partial.it') || r.idempotency_key.includes('complete.en'));
  const allBlockedOrNone = sendRows.every((r) => r.status === 'blocked' || r.status === 'pending');
  const noSent = sendRows.every((r) => r.status !== 'sent');
  const noRefundAudit = refundRows.length === 0;
  const noImageAudit = imageRows.length === 0;

  const criticalSend = [a, b, c, d].some((x) => x.send_performed === true || x.sends_whatsapp === true
    || (x.send_result && (x.send_result.send_performed === true || x.send_result.sends_whatsapp === true)));

  const revOk = rev.properties.healthState === 'Healthy' && rev.properties.trafficWeight === 100
    && String(rev.properties.template.containers[0].image).includes('d6a3642-stage19g6');
  const envUnchanged = JSON.stringify(envBefore) === JSON.stringify(envAfter);

  let result = 'PASS';
  if (criticalSend || !Object.values(checks).every(Boolean) || health.status !== 200 || !revOk) result = 'FAIL';
  else if (!envUnchanged || dbAfter.recent_bookings.length > 0 || dbAfter.recent_payments.length > 0) result = 'PARTIAL';

  const out = {
    phase: '19g.6',
    result,
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb3s',
    revision: {
      name: rev.name,
      health: rev.properties.healthState,
      traffic: rev.properties.trafficWeight,
      image: rev.properties.template.containers[0].image,
    },
    healthz: { status: health.status },
    env_flags: envAfter,
    env_unchanged: envUnchanged,
    caseA: {
      status: caseA.status,
      draft_called: a.draft_called,
      next_action: a.next_action,
      suggested_reply: String(a.suggested_reply || '').slice(0, 120),
      send_attempted: a.send_attempted,
      idempotency_key: a.idempotency_key,
      send_result: a.send_result ? {
        send_performed: a.send_result.send_performed,
        sends_whatsapp: a.send_result.sends_whatsapp,
        blocked_reasons: a.send_result.blocked_reasons,
        guest_message_send_status: a.send_result.guest_message_send_status,
      } : null,
      sends_whatsapp: a.sends_whatsapp,
      pass: checks.A,
    },
    caseB: {
      status: caseB.status,
      draft_called: b.draft_called,
      next_action: b.next_action,
      has_dry_run_plan: !!b.dry_run_plan,
      suggested_reply: String(b.suggested_reply || '').slice(0, 140),
      send_attempted: b.send_attempted,
      idempotency_key: b.idempotency_key,
      send_result: b.send_result ? {
        send_performed: b.send_result.send_performed,
        sends_whatsapp: b.send_result.sends_whatsapp,
        blocked_reasons: b.send_result.blocked_reasons,
      } : null,
      pass: checks.B,
    },
    caseC: {
      status: caseC.status,
      draft_called: c.draft_called,
      handoff_required: c.handoff_required,
      next_action: c.next_action,
      send_attempted: c.send_attempted,
      has_send_result: !!c.send_result,
      pass: checks.C,
    },
    caseD: {
      status: caseD.status,
      supported: d.normalized && d.normalized.supported,
      draft_called: d.draft_called,
      send_attempted: d.send_attempted,
      has_suggested_reply: !!d.suggested_reply,
      pass: checks.D,
    },
    guest_message_sends: {
      rows: sendRows,
      eligible_blocked_rows: eligibleRows.length,
      no_refund_rows: noRefundAudit,
      no_image_rows: noImageAudit,
      all_blocked_or_pending: allBlockedOrNone,
      no_sent_status: noSent,
    },
    n8n_callback_probe: { url: `https://${N8N_HOST}/webhook/booking-assistant`, status: n8nProbe.status },
    db: {
      recent_bookings: dbAfter.recent_bookings.length,
      recent_payments: dbAfter.recent_payments.length,
      sends_before: dbBefore.guest_message_sends.length,
      sends_after: dbAfter.guest_message_sends.length,
    },
    checks,
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(result === 'FAIL' ? 1 : 0);
})().catch((e) => {
  console.error('PROOF_ERROR:', e.message);
  process.exit(1);
});
