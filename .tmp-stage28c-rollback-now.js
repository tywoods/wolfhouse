'use strict';
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const WF_ID = 'stage27demoLWrite01';
const DEMO_PHONE_ID = '1152900101233109';
const VERIFY_TOKEN = 'wolfhouse_verify_token';
const STAFF_META_CALLBACK = 'https://staff-staging.lunafrontdesk.com/staff/meta/whatsapp/webhook';
const PROOF_PHONE = '+34600995557';
const PROOF_START = process.env.STAGE28C_PROOF_START || '2026-06-10T00:00:00.000Z';

const BASELINE_ENV = {
  WHATSAPP_DRY_RUN: 'true',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'false',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: '1152900101233109',
};

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 }).trim();
}

function setEnvVars(pairs) {
  az([
    'az containerapp update', '--name wh-staging-staff-api', '--resource-group wh-staging-rg',
    `--set-env-vars ${Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join(' ')}`, '-o none',
  ].join(' '));
}

function envPick(names) {
  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const out = {};
  for (const n of names) {
    const e = env.find((x) => x.name === n);
    out[n] = e ? (e.secretRef ? `(secret:${e.secretRef})` : e.value) : null;
  }
  return out;
}

function restartN8n() {
  for (const app of ['wh-staging-n8n-main', 'wh-staging-n8n-worker']) {
    const rev = az(`az containerapp revision list --name ${app} --resource-group wh-staging-rg --query "[?properties.trafficWeight==\`100\`].name" -o tsv`);
    if (rev) az(`az containerapp revision restart --name ${app} --resource-group wh-staging-rg --revision ${rev}`);
  }
}

function graphPostPhoneOverride(token, callbackUrl) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      webhook_configuration: JSON.stringify({ override_callback_uri: callbackUrl, verify_token: VERIFY_TOKEN }),
      access_token: token,
    });
    const data = params.toString();
    const req = https.request({
      hostname: 'graph.facebook.com', path: `/v21.0/${DEMO_PHONE_ID}`, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function graphGetPhoneWebhook(token) {
  return new Promise((resolve, reject) => {
    https.get(`https://graph.facebook.com/v21.0/${DEMO_PHONE_ID}?fields=display_phone_number,webhook_configuration&access_token=${encodeURIComponent(token)}`, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    }).on('error', reject);
  });
}

(async () => {
  const out = { action: 'stage28c_rollback_now', proof_start_used: PROOF_START };

  const token = az('az keyvault secret show --vault-name wh-staging-kv --name meta-whatsapp-token --query value -o tsv');
  out.meta_restore = await graphPostPhoneOverride(token, STAFF_META_CALLBACK);
  out.meta_callback_after = (await graphGetPhoneWebhook(token))?.webhook_configuration;

  setEnvVars(BASELINE_ENV);
  out.gates_after = envPick([...Object.keys(BASELINE_ENV), 'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST']);

  const n8nUrl = az('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv');
  const nc = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
  await nc.connect();
  await nc.query('DELETE FROM webhook_entity WHERE "workflowId"=$1', [WF_ID]);
  await nc.query('DELETE FROM workflow_published_version WHERE "workflowId"=$1', [WF_ID]);
  await nc.query('UPDATE workflow_entity SET active=false,"activeVersionId"=NULL,"updatedAt"=NOW() WHERE id=$1', [WF_ID]);
  const wf = await nc.query('SELECT active, name FROM workflow_entity WHERE id=$1', [WF_ID]);
  const hooks = await nc.query('SELECT COUNT(*)::int AS n FROM webhook_entity WHERE "workflowId"=$1', [WF_ID]);
  await nc.end();
  restartN8n();
  out.n8n_workflow = { ...wf.rows[0], webhook_entity_rows: hooks.rows[0].n };

  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const since = PROOF_START;
  const msgs = await pg.query(`
    SELECT COUNT(*)::int AS n FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug='wolfhouse-somo' AND c.phone=$1 AND m.direction='inbound' AND m.created_at >= $2::timestamptz`,
    [PROOF_PHONE, since]);
  const bookings = await pg.query(`
    SELECT b.booking_code, b.status::text, b.payment_status::text, b.created_at::text
      FROM bookings b JOIN clients cl ON cl.id=b.client_id
     WHERE cl.slug='wolfhouse-somo' AND b.phone=$1 AND b.created_at>=$2::timestamptz`, [PROOF_PHONE, since]);
  const pays = await pg.query(`
    SELECT p.id::text, p.status::text, p.stripe_checkout_session_id
      FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN clients cl ON cl.id=b.client_id
     WHERE cl.slug='wolfhouse-somo' AND b.phone=$1 AND p.created_at>=$2::timestamptz`, [PROOF_PHONE, since]);
  const beds = await pg.query(`
    SELECT bb.bed_code FROM booking_beds bb
     JOIN bookings b ON b.id=bb.booking_id JOIN clients cl ON cl.id=b.client_id
     WHERE cl.slug='wolfhouse-somo' AND b.phone=$1 AND b.created_at>=$2::timestamptz`, [PROOF_PHONE, since]);
  const sends = await pg.query(
    'SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE to_phone=$1 AND created_at>=$2::timestamptz',
    [PROOF_PHONE, since]);
  const confirm = await pg.query(`
    SELECT booking_code FROM bookings b JOIN clients cl ON cl.id=b.client_id
     WHERE cl.slug='wolfhouse-somo' AND b.phone=$1 AND b.confirmation_sent_at>=$2::timestamptz`, [PROOF_PHONE, since]);
  await pg.end();

  out.inbound_received = msgs.rows[0].n > 0;
  out.inbound_count_since_proof = msgs.rows[0].n;
  out.write_occurred = bookings.rows.length > 0 || pays.rows.length > 0 || beds.rows.length > 0;
  out.artifacts = {
    bookings: bookings.rows,
    payments: pays.rows,
    booking_beds: beds.rows,
    guest_message_sends: sends.rows[0].n,
    confirmations: confirm.rows,
  };

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
