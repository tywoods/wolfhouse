'use strict';
/** Stage 45f — activate staging Meta WhatsApp inbound n8n review pipe + inbox proof. Temp — do not commit. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const WF_ID = 'stage27demoJReview01';
const WF_NAME = 'Luna Open Demo WhatsApp Inbound Review Pipe';
const WF_PATH = path.join(__dirname, 'n8n', 'Luna Open Demo WhatsApp Inbound Review Pipe.json');
const WEBHOOK_PATH = 'open-demo-whatsapp-inbound-review-27j';
const WEBHOOK_ID = 'a27demoj-0027-4000-8000-000000000027';
const WEBHOOK_NODE = 'Webhook - Open Demo WhatsApp Inbound';
const N8N_HOST = 'wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io';
const N8N_WEBHOOK_URL = `https://${N8N_HOST}/webhook/${WEBHOOK_PATH}`;
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const DEMO_PHONE_ID = '1152900101233109';
const VERIFY_TOKEN = 'wolfhouse_verify_token';
const CRED_ID = 'stage8512LunaBotTok01';
const CRED_NAME = 'Luna Bot Internal Token (staging)';
const PROJECT_ID = 'stage8512Project01';
const EXTERNAL_PHONE = '+34600995555';
const EXTERNAL_FROM = '34600995555';
const PROOF_MESSAGE = 'Stage 45f open phone test — what are the packages?';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function bindCredentials(nodes) {
  return nodes.map((n) => {
    if (n.type !== 'n8n-nodes-base.httpRequest') return n;
    return { ...n, credentials: { httpHeaderAuth: { id: CRED_ID, name: CRED_NAME } } };
  });
}

function restartN8nMain() {
  const rev = az('az containerapp revision list --name wh-staging-n8n-main --resource-group wh-staging-rg --query "[?properties.trafficWeight==`100`].name" -o tsv');
  az(`az containerapp revision restart --name wh-staging-n8n-main --resource-group wh-staging-rg --revision ${rev}`);
}

function httpsJson(method, host, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: host, path: reqPath, method,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* keep */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function graphGetPhoneWebhook(token) {
  return new Promise((resolve, reject) => {
    https.get(`https://graph.facebook.com/v21.0/${DEMO_PHONE_ID}?fields=display_phone_number,webhook_configuration&access_token=${encodeURIComponent(token)}`, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
    }).on('error', reject);
  });
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

async function activateWorkflow(c) {
  const wf = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));
  const nodes = bindCredentials(wf.nodes);
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();

  const existing = await c.query('SELECT id FROM workflow_entity WHERE id = $1', [WF_ID]);
  if (!existing.rows.length) {
    await c.query(
      `INSERT INTO workflow_entity (
        id, name, active, nodes, connections, settings, "staticData", "pinData",
        "versionId", "triggerCount", meta, "parentFolderId", "isArchived", "versionCounter",
        description, "activeVersionId", "nodeGroups", "createdAt", "updatedAt"
      ) VALUES ($1,$2,false,$3::json,$4::json,$5::json,$6,$7::json,$8,0,$9::json,$10,false,1,$11,$12,$13::json,$14,$14)`,
      [WF_ID, wf.name, JSON.stringify(nodes), JSON.stringify(wf.connections), JSON.stringify(wf.settings || {}),
        null, null, versionId, JSON.stringify(wf.meta || {}), null, wf.meta?.description || wf.name, null,
        JSON.stringify([]), now],
    );
    await c.query(
      `INSERT INTO shared_workflow ("workflowId", "projectId", role, "createdAt", "updatedAt")
       VALUES ($1, $2, 'workflow:owner', NOW(), NOW()) ON CONFLICT DO NOTHING`,
      [WF_ID, PROJECT_ID],
    );
  }

  await c.query(
    `INSERT INTO workflow_history ("versionId","workflowId",authors,"createdAt","updatedAt",nodes,connections,name,autosaved,description,"nodeGroups")
     VALUES ($1::varchar,$2::varchar,$3,$4::timestamptz,$4::timestamptz,$5::json,$6::json,$7,false,$8,$9::json)`,
    [versionId, WF_ID, 'stage45f-proof', now, JSON.stringify(nodes), JSON.stringify(wf.connections), wf.name, wf.meta?.description || wf.name, JSON.stringify([])],
  );
  await c.query(
    `UPDATE workflow_entity SET nodes=$2::json,active=true,"versionId"=$3::varchar,"activeVersionId"=$3::varchar,
      "versionCounter"=COALESCE("versionCounter",0)+1,"updatedAt"=$4::timestamptz WHERE id=$1::varchar`,
    [WF_ID, JSON.stringify(nodes), versionId, now],
  );
  await c.query('DELETE FROM workflow_published_version WHERE "workflowId"=$1', [WF_ID]);
  await c.query(
    `INSERT INTO workflow_published_version ("workflowId","publishedVersionId","createdAt","updatedAt") VALUES ($1,$2,$3,$3)`,
    [WF_ID, versionId, now],
  );
  await c.query('DELETE FROM webhook_entity WHERE "workflowId"=$1', [WF_ID]);
  await c.query(
    `INSERT INTO webhook_entity ("webhookPath",method,node,"webhookId","pathLength","workflowId") VALUES ($1,'POST',$2,$3,$4,$5)`,
    [WEBHOOK_PATH, WEBHOOK_NODE, WEBHOOK_ID, WEBHOOK_PATH.length, WF_ID],
  );
  restartN8nMain();
  console.error('[n8n] waiting 75s for webhook registration...');
  await new Promise((r) => setTimeout(r, 75000));
  const hooks = await c.query('SELECT * FROM webhook_entity WHERE "workflowId"=$1', [WF_ID]);
  const wfRow = await c.query('SELECT id, active FROM workflow_entity WHERE id=$1', [WF_ID]);
  return { versionId, workflow_active: wfRow.rows[0]?.active, webhook_rows: hooks.rows.length };
}

function buildMetaPayload(fromDigits, wamid, messageText, contactName) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: DEMO_PHONE_ID },
          contacts: [{ profile: { name: contactName || 'Stage45f Guest' } }],
          messages: [{
            from: fromDigits,
            id: wamid,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: messageText },
          }],
        },
        field: 'messages',
      }],
    }],
  };
}

async function dbProof(pg, phone, sinceIso, wamid) {
  const phoneRaw = phone.replace(/^\+/, '');
  const conv = await pg.query(`
    SELECT c.id::text, c.phone, c.last_message_preview, c.updated_at::text,
           c.metadata->>'open_phone_testing' AS open_phone_testing,
           c.metadata->>'guest_tester_class' AS guest_tester_class,
           c.metadata
      FROM conversations c
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = 'wolfhouse-somo'
       AND (c.phone = $1 OR c.phone = $2 OR c.phone = $3)
     ORDER BY c.updated_at DESC LIMIT 1`,
    [phone, phoneRaw, `+${phoneRaw}`]);
  const msgs = await pg.query(`
    SELECT m.direction::text, LEFT(m.message_text, 240) AS body, m.created_at::text,
           m.metadata->>'wamid' AS wamid,
           m.metadata->>'open_phone_testing' AS open_phone_testing,
           m.metadata->>'guest_tester_class' AS guest_tester_class,
           m.metadata
      FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = 'wolfhouse-somo'
       AND (c.phone = $1 OR c.phone = $2 OR c.phone = $3)
       AND m.created_at >= $4::timestamptz
     ORDER BY m.created_at ASC`,
    [phone, phoneRaw, `+${phoneRaw}`, sinceIso]);
  const bookings = await pg.query(
    `SELECT id::text, booking_code, created_at::text FROM bookings WHERE created_at >= $1::timestamptz LIMIT 5`,
    [sinceIso],
  );
  const payments = await pg.query(
    `SELECT id::text, status::text, created_at::text FROM payments WHERE created_at >= $1::timestamptz LIMIT 5`,
    [sinceIso],
  );
  const sends = await pg.query(
    `SELECT idempotency_key, status, to_phone, created_at::text, blocked_reasons
       FROM guest_message_sends
      WHERE created_at >= $1::timestamptz
        AND (to_phone = $2 OR to_phone = $3 OR to_phone = $4 OR idempotency_key LIKE $5)
      ORDER BY created_at DESC LIMIT 10`,
    [sinceIso, phone, phoneRaw, `+${phoneRaw}`, `%${wamid}%`],
  );
  const draft = conv.rows[0]
    ? await pg.query('SELECT staff_reply_draft, updated_at::text FROM conversations WHERE id=$1::uuid', [conv.rows[0].id])
    : { rows: [] };
  return {
    conversation: conv.rows[0] || null,
    messages: msgs.rows,
    staff_reply_draft: draft.rows[0] || null,
    bookings_since: bookings.rows,
    payments_since: payments.rows,
    guest_message_sends: sends.rows,
  };
}

async function staffInboxProof(conversationId) {
  const login = await httpsJson('POST', STAFF_HOST, '/staff/auth/login', {
    client: 'wolfhouse-somo', email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const inbox = await httpsJson('GET', STAFF_HOST, '/staff/conversations?client=wolfhouse-somo&limit=20', null, { Cookie: cookie });
  const convs = inbox.body?.conversations || inbox.body?.data || [];
  const hit = convs.find((c) => c.id === conversationId || c.conversation_id === conversationId);
  let detail = null;
  if (conversationId) {
    detail = await httpsJson('GET', STAFF_HOST, `/staff/conversations/${conversationId}/context?client=wolfhouse-somo`, null, { Cookie: cookie });
  }
  return {
    login_status: login.status,
    inbox_status: inbox.status,
    conversation_in_inbox: !!hit,
    inbox_preview: hit?.last_message_preview || hit?.preview || null,
    context_status: detail?.status || null,
    context_metadata: detail?.body?.metadata || detail?.body?.conversation?.metadata || null,
  };
}

(async () => {
  const sinceIso = new Date().toISOString();
  const out = {
    phase: 'stage45f-inbound-proof',
    since: sinceIso,
    staff_api: {},
    env_gates: {},
    n8n: {},
    meta_callback: {},
    pipe_test: {},
    db_proof: {},
    staff_portal: {},
    safety: {},
  };

  // Staff API revision
  const revRaw = az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json');
  const revs = JSON.parse(revRaw);
  const active = revs.find((r) => r.properties.trafficWeight === 100) || {};
  out.staff_api = {
    revision: active.name,
    image: active.properties?.template?.containers?.[0]?.image,
    health: active.properties?.healthState,
    healthz: JSON.parse((await httpsJson('GET', STAFF_HOST, '/healthz')).raw || '{}'),
  };

  const envRaw = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json'));
  const pick = (name) => {
    const row = envRaw.find((e) => e.name === name);
    if (!row) return null;
    return row.secretRef ? `(secret:${row.secretRef})` : row.value;
  };
  out.env_gates = {
    OPEN_DEMO_WHATSAPP_ENABLED: pick('OPEN_DEMO_WHATSAPP_ENABLED'),
    LUNA_OPEN_PHONE_TESTING: pick('LUNA_OPEN_PHONE_TESTING'),
    LUNA_OPEN_PHONE_TESTING_BYPASS_STAFF_ROUTING: pick('LUNA_OPEN_PHONE_TESTING_BYPASS_STAFF_ROUTING'),
    OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: pick('OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID'),
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: pick('OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED'),
    OPEN_DEMO_BOOKING_WRITES_ENABLED: pick('OPEN_DEMO_BOOKING_WRITES_ENABLED'),
    OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: pick('OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED'),
    LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST: pick('LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST'),
  };

  const n8nUrl = az('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv');
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const nc = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await nc.connect();
  await pg.connect();

  out.n8n.before = (await nc.query('SELECT id, active FROM workflow_entity WHERE id=$1', [WF_ID])).rows[0] || null;
  out.n8n.activation = await activateWorkflow(nc);
  out.n8n.after = (await nc.query('SELECT id, active FROM workflow_entity WHERE id=$1', [WF_ID])).rows[0];

  let metaToken = '';
  for (const secretName of ['meta-whatsapp-token', 'whatsapp-access-token']) {
    try {
      metaToken = az(`az keyvault secret show --vault-name wh-staging-kv --name ${secretName} --query value -o tsv`);
      if (metaToken) break;
    } catch { /* try next */ }
  }
  if (metaToken) {
    out.meta_callback.before = await graphGetPhoneWebhook(metaToken);
    const prevUrl = out.meta_callback.before?.webhook_configuration?.application
      || out.meta_callback.before?.webhook_configuration?.override_callback_uri
      || null;
    out.meta_callback.previous_url = prevUrl;
    if (prevUrl !== N8N_WEBHOOK_URL) {
      out.meta_callback.override = await graphPostPhoneOverride(metaToken, N8N_WEBHOOK_URL);
      await new Promise((r) => setTimeout(r, 3000));
    }
    out.meta_callback.after = await graphGetPhoneWebhook(metaToken);
    out.meta_callback.n8n_webhook_url = N8N_WEBHOOK_URL;
  } else {
    out.meta_callback.error = 'meta token unavailable — real-phone Meta delivery may not reach n8n until callback is set manually';
  }

  const wamid = `wamid.HBgMzQ2MDA5OTU1NTUVAgASG${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
  const metaPayload = buildMetaPayload(EXTERNAL_FROM, wamid, PROOF_MESSAGE, 'Stage45f External Guest');
  const pipe = await httpsJson('POST', N8N_HOST, `/webhook/${WEBHOOK_PATH}`, metaPayload);
  await new Promise((r) => setTimeout(r, 12000));

  const ex = (await nc.query(
    'SELECT id, status, mode, "startedAt"::text FROM execution_entity WHERE "workflowId"=$1 ORDER BY "startedAt" DESC LIMIT 1',
    [WF_ID],
  )).rows[0];

  out.pipe_test = {
    test_phone_type: 'unknown_external',
    guest_phone: EXTERNAL_PHONE,
    wamid,
    message: PROOF_MESSAGE,
    n8n_webhook_status: pipe.status,
    n8n_webhook_body: pipe.body,
    execution: ex,
  };

  out.db_proof = await dbProof(pg, EXTERNAL_PHONE, sinceIso, wamid);
  const convId = out.db_proof.conversation?.id || pipe.body?.conversation_id || null;
  out.staff_portal = await staffInboxProof(convId);

  out.safety = {
    whatsapp_dry_run: out.env_gates.WHATSAPP_DRY_RUN === 'true',
    live_replies_disabled: out.env_gates.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'false',
    booking_writes_disabled: out.env_gates.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'false',
    stripe_disabled: out.env_gates.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'false',
    n8n_sends_whatsapp: pipe.body?.sends_whatsapp === true,
    n8n_live_send_blocked: pipe.body?.live_send_blocked !== false,
    n8n_no_write: pipe.body?.no_write_performed === true,
    guest_message_sends_count: out.db_proof.guest_message_sends.length,
    bookings_created: out.db_proof.bookings_since.length,
    payments_created: out.db_proof.payments_since.length,
    open_phone_testing_metadata: out.db_proof.conversation?.open_phone_testing === 'true'
      || out.db_proof.messages.some((m) => m.open_phone_testing === 'true'),
    guest_tester_class_metadata: out.db_proof.conversation?.guest_tester_class
      || out.db_proof.messages.find((m) => m.guest_tester_class)?.guest_tester_class
      || null,
    n8n_remains_active: out.n8n.after?.active === true,
  };

  out.result = (
    out.staff_api.image?.includes('96789a2')
    && out.env_gates.WHATSAPP_DRY_RUN === 'true'
    && out.env_gates.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'false'
    && out.env_gates.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'false'
    && out.n8n.after?.active === true
    && pipe.status === 200
    && pipe.body?.staff_api_success === true
    && pipe.body?.sends_whatsapp !== true
    && out.db_proof.conversation
    && out.safety.guest_message_sends_count === 0
    && out.safety.bookings_created === 0
    && out.safety.payments_created === 0
  ) ? 'PASS' : 'PARTIAL';

  console.log(JSON.stringify(out, null, 2));
  await nc.end();
  await pg.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
