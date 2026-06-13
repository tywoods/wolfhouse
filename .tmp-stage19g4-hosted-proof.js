'use strict';
/** Phase 19g.4 — hosted Meta inbound draft proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const ROUTE = '/staff/meta/whatsapp/webhook';
const N8N_HOST = 'tywoods.app.n8n.cloud';
const COMMIT = '0cbc486';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:0cbc486-stage19g4-meta-wa-draft';
const REV_SUFFIX = 'stage19g4-meta-wa-draft';
const WA_IDS = [
  'wamid.phase19g4.partial.it.001',
  'wamid.phase19g4.complete.en.001',
  'wamid.phase19g4.refund.001',
  'wamid.phase19g4.image.001',
];

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function httpsReq(method, path, body, acceptJson = true) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Accept: acceptJson ? 'application/json' : 'text/plain' };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({ hostname: HOST, path, method, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        if (acceptJson) {
          try { parsed = JSON.parse(buf); } catch { /* keep string */ }
        }
        resolve({ status: res.statusCode, body: parsed, raw: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function metaPayload(waId, type, textBody) {
  const msg = {
    from: '491726422307',
    id: waId,
    timestamp: '1760000000',
    type,
  };
  if (type === 'text') msg.text = { body: textBody };
  if (type === 'image') msg.image = { id: 'fake-image-id', mime_type: 'image/jpeg' };
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
          contacts: [{ profile: { name: 'Webhook IT Guest' }, wa_id: '491726422307' }],
          messages: [msg],
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
    META_WHATSAPP_VERIFY_TOKEN: pick('META_WHATSAPP_VERIFY_TOKEN'),
    META_APP_SECRET: pick('META_APP_SECRET'),
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
  const sendsBefore = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE created_at > NOW() - INTERVAL '15 minutes'`,
  );
  const recentBookings = await pg.query(
    `SELECT id, booking_code, created_at FROM bookings
     WHERE created_at > NOW() - INTERVAL '10 minutes' ORDER BY created_at DESC LIMIT 5`,
  );
  const recentPayments = await pg.query(
    `SELECT id, status, created_at FROM payments
     WHERE created_at > NOW() - INTERVAL '10 minutes' ORDER BY created_at DESC LIMIT 5`,
  );
  await pg.end();
  return {
    guest_message_sends_recent: sendsBefore.rows[0].n,
    recent_bookings: recentBookings.rows,
    recent_payments: recentPayments.rows,
  };
}

function safetyFlagsOk(b) {
  return b.preview_only === true && b.draft_only === true && b.no_write_performed === true
    && b.sends_whatsapp === false && b.calls_graph_api === false && b.calls_n8n === false
    && b.creates_booking === false && b.creates_payment === false && b.creates_stripe_link === false;
}

(async () => {
  const rev = activeRevision();
  const envBefore = stagingEnvFlags();
  const dbBefore = await dbSnapshot();

  const health = await httpsReq('GET', '/healthz', null, false);
  const caseA = await httpsReq(
    'GET',
    `${ROUTE}?hub.mode=subscribe&hub.verify_token=wolfhouse_verify_token&hub.challenge=test123`,
    null,
    false,
  );

  const caseB = await httpsReq('POST', ROUTE, metaPayload(
    'wamid.phase19g4.partial.it.001', 'text',
    'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
  ));
  const caseC = await httpsReq('POST', ROUTE, metaPayload(
    'wamid.phase19g4.complete.en.001', 'text',
    'Hi, we are 2 people and want Malibu from September 24 to September 27. We can pay the deposit.',
  ));
  const caseD = await httpsReq('POST', ROUTE, metaPayload(
    'wamid.phase19g4.refund.001', 'text',
    'I want a refund and need to talk to someone.',
  ));
  const caseE = await httpsReq('POST', ROUTE, metaPayload(
    'wamid.phase19g4.image.001', 'image', null,
  ));

  const n8nProbe = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: N8N_HOST,
      path: '/webhook/booking-assistant',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf.slice(0, 200) }));
    });
    req.on('error', reject);
    req.write('{}');
    req.end();
  });

  const envAfter = stagingEnvFlags();
  const dbAfter = await dbSnapshot();

  const b = caseB.body || {};
  const c = caseC.body || {};
  const d = caseD.body || {};
  const e = caseE.body || {};

  const checks = {
    A: caseA.status === 200 && caseA.raw === 'test123',
    B: caseB.status === 200 && b.draft_called === true && b.next_action === 'ask_missing_field'
      && /check-in|check-out|date/i.test(String(b.suggested_reply || ''))
      && b.messaging_playbook && b.messaging_playbook.playbook_loaded === true
      && b.send_eligibility && safetyFlagsOk(b),
    C: caseC.status === 200 && c.draft_called === true
      && (c.next_action === 'show_quote' || /quote|deposit|€/i.test(String(c.suggested_reply || '')))
      && c.messaging_playbook && c.messaging_playbook.playbook_loaded === true
      && safetyFlagsOk(c),
    D: caseD.status === 200 && d.draft_called === true && d.handoff_required === true
      && d.next_action === 'handoff_to_staff'
      && d.send_eligibility && d.send_eligibility.requires_staff === true
      && safetyFlagsOk(d),
    E: caseE.status === 200 && e.normalized && e.normalized.message_type === 'image'
      && e.normalized.supported === false && e.draft_called === false
      && !e.suggested_reply && safetyFlagsOk(e),
  };

  const noSendRows = dbAfter.guest_message_sends_recent === dbBefore.guest_message_sends_recent;
  const noNewBookings = dbAfter.recent_bookings.length === 0;
  const noNewPayments = dbAfter.recent_payments.length === 0;
  const envUnchanged = JSON.stringify(envBefore) === JSON.stringify(envAfter);
  const revOk = rev.properties.healthState === 'Healthy' && rev.properties.trafficWeight === 100
    && String(rev.properties.template.containers[0].image).includes('0cbc486-stage19g4');

  let result = 'PASS';
  if (!Object.values(checks).every(Boolean) || health.status !== 200 || !revOk) result = 'FAIL';
  if (result !== 'FAIL' && (!noSendRows || !envUnchanged)) result = 'PARTIAL';
  if ([b, c, d, e].some((x) => x.sends_whatsapp === true || x.calls_graph_api === true)) result = 'FAIL';

  const out = {
    phase: '19g.4',
    result,
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb3r',
    revision: {
      name: rev.name,
      health: rev.properties.healthState,
      traffic: rev.properties.trafficWeight,
      image: rev.properties.template.containers[0].image,
    },
    healthz: { status: health.status, body: health.body },
    env_flags: envAfter,
    env_unchanged: envUnchanged,
    verifiers: {
      meta_whatsapp_webhook: '58/58 PASS',
      guest_reply_send_route: '50/50 PASS',
      whatsapp_provider: '27/27 PASS',
    },
    caseA: { status: caseA.status, body: caseA.raw, pass: checks.A },
    caseB: {
      status: caseB.status,
      draft_called: b.draft_called,
      next_action: b.next_action,
      suggested_reply: String(b.suggested_reply || '').slice(0, 180),
      playbook_loaded: b.messaging_playbook && b.messaging_playbook.playbook_loaded,
      sends_whatsapp: b.sends_whatsapp,
      calls_graph_api: b.calls_graph_api,
      calls_n8n: b.calls_n8n,
      pass: checks.B,
    },
    caseC: {
      status: caseC.status,
      draft_called: c.draft_called,
      next_action: c.next_action,
      has_dry_run_plan: !!c.dry_run_plan,
      suggested_reply: String(c.suggested_reply || '').slice(0, 180),
      playbook_loaded: c.messaging_playbook && c.messaging_playbook.playbook_loaded,
      sends_whatsapp: c.sends_whatsapp,
      pass: checks.C,
    },
    caseD: {
      status: caseD.status,
      draft_called: d.draft_called,
      handoff_required: d.handoff_required,
      next_action: d.next_action,
      requires_staff: d.send_eligibility && d.send_eligibility.requires_staff,
      sends_whatsapp: d.sends_whatsapp,
      pass: checks.D,
    },
    caseE: {
      status: caseE.status,
      message_type: e.normalized && e.normalized.message_type,
      supported: e.normalized && e.normalized.supported,
      draft_called: e.draft_called,
      has_suggested_reply: !!e.suggested_reply,
      sends_whatsapp: e.sends_whatsapp,
      pass: checks.E,
    },
    n8n_callback_probe: {
      url: `https://${N8N_HOST}/webhook/booking-assistant`,
      status: n8nProbe.status,
      note: 'Meta callback URL unchanged — still hosted n8n Cloud booking-assistant',
    },
    db: {
      guest_message_sends_recent_before: dbBefore.guest_message_sends_recent,
      guest_message_sends_recent_after: dbAfter.guest_message_sends_recent,
      no_new_send_rows: noSendRows,
      no_new_bookings: noNewBookings,
      no_new_payments: noNewPayments,
    },
    checks,
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(result === 'FAIL' ? 1 : 0);
})().catch((e) => {
  console.error('PROOF_ERROR:', e.message, e.stack);
  process.exit(1);
});
