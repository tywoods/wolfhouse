'use strict';
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 }).trim();
}

(async () => {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const n8nUrl = az('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv');
  const token = az('az keyvault secret show --vault-name wh-staging-kv --name meta-whatsapp-token --query value -o tsv');

  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const events = await pg.query(`
    SELECT id::text, created_at, normalized->>'from' AS from_phone,
           LEFT(normalized->>'message_text', 80) AS msg
      FROM guest_message_events
     WHERE created_at > NOW() - INTERVAL '7 days'
     ORDER BY created_at DESC LIMIT 10`);
  const conv = await pg.query(`
    SELECT id::text, phone, created_at
      FROM conversations
     WHERE phone = '+34600995557'
     ORDER BY created_at DESC LIMIT 5`);
  const bk = await pg.query(`
    SELECT booking_code, status::text, payment_status::text, check_in::text, check_out::text, created_at
      FROM bookings
     WHERE phone = '+34600995557' AND created_at > NOW() - INTERVAL '30 days'
     ORDER BY created_at DESC LIMIT 5`);
  await pg.end();

  const nc = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
  await nc.connect();
  const wf = await nc.query(`
    SELECT id, name, active FROM workflow_entity
     WHERE id IN ('stage27demoLWrite01','stage27demoJReview01','stage27demoMStripe01')`);
  const wh = await nc.query(`SELECT "webhookPath", "workflowId" FROM webhook_entity WHERE "workflowId" LIKE 'stage27demo%'`);
  await nc.end();

  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const pick = (n) => {
    const e = env.find((x) => x.name === n);
    return e ? (e.secretRef ? `(secret:${e.secretRef})` : e.value) : null;
  };

  const phone = await new Promise((resolve) => {
    https.get(`https://graph.facebook.com/v21.0/1152900101233109?fields=display_phone_number,webhook_configuration&access_token=${encodeURIComponent(token)}`, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    });
  });

  const revRows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const active = revRows.find((x) => x.properties.trafficWeight === 100) || {};

  console.log(JSON.stringify({
    gates_after: {
      WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
      OPEN_DEMO_WHATSAPP_ENABLED: pick('OPEN_DEMO_WHATSAPP_ENABLED'),
      OPEN_DEMO_BOOKING_WRITES_ENABLED: pick('OPEN_DEMO_BOOKING_WRITES_ENABLED'),
      OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: pick('OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED'),
      OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: pick('OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED'),
      LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST: pick('LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST'),
    },
    revision: { name: active.name, image: active.properties?.template?.containers?.[0]?.image },
    meta_phone_webhook: phone,
    n8n_workflows: wf.rows,
    n8n_webhooks: wh.rows,
    recent_events: events.rows,
    test_phone_conversations: conv.rows,
    test_phone_bookings: bk.rows,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
