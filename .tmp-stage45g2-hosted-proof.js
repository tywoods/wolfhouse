'use strict';
/** Stage 45g.2 — deploy + real inbound metadata proof. Temp — do not commit. */

const crypto = require('crypto');
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const COMMIT_SHORT = '1911d36';
const IMAGE_TAG = `${COMMIT_SHORT}-stage45g-open-phone-metadata`;
const REV_SUFFIX = 'stage45g-open-phone-metadata';
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const DEMO_PHONE_ID = '1152900101233109';
const EXTERNAL_PHONE = '+34600995555';
const EXTERNAL_FROM = '34600995555';
const PROOF_MESSAGE = 'Stage 45g.2 open phone metadata proof — what are the packages?';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 }).trim();
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

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const active = rows.find((r) => r.properties.trafficWeight === 100) || {};
  return {
    name: active.name,
    health: active.properties?.healthState,
    traffic: active.properties?.trafficWeight,
    image: active.properties?.template?.containers?.[0]?.image,
  };
}

function readEnvGates() {
  const envRaw = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json'));
  const pick = (name) => {
    const row = envRaw.find((e) => e.name === name);
    if (!row) return null;
    return row.secretRef ? `(secret:${row.secretRef})` : row.value;
  };
  return {
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
}

function buildMetaPayload(fromDigits, wamid, messageText, contactName) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: DEMO_PHONE_ID },
          contacts: [{ profile: { name: contactName || 'Stage45g Guest' } }],
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

async function staffLogin() {
  const login = await httpsJson('POST', STAFF_HOST, '/staff/auth/login', {
    client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  return { login_status: login.status, cookie };
}

async function staffApiProof(cookie, conversationId) {
  const inbox = await httpsJson('GET', STAFF_HOST, `/staff/conversations?client=${CLIENT}&limit=50`, null, { Cookie: cookie });
  const convs = inbox.body?.conversations || inbox.body?.data || [];
  const hit = convs.find((c) => c.id === conversationId || c.conversation_id === conversationId);
  const messages = conversationId
    ? await httpsJson('GET', STAFF_HOST, `/staff/conversations/${conversationId}/messages?client=${CLIENT}`, null, { Cookie: cookie })
    : null;
  const msgRows = messages?.body?.messages || messages?.body?.data || [];
  const proofMsg = msgRows.find((m) => String(m.message_text || m.body || '').includes('Stage 45g.2'))
    || msgRows[msgRows.length - 1]
    || null;
  return {
    inbox_status: inbox.status,
    conversation_in_inbox: !!hit,
    inbox_open_phone_testing: hit?.open_phone_testing ?? null,
    inbox_guest_tester_class: hit?.guest_tester_class ?? null,
    messages_status: messages?.status || null,
    message_count: msgRows.length,
    proof_message_open_phone_testing: proofMsg?.open_phone_testing ?? null,
    proof_message_guest_tester_class: proofMsg?.guest_tester_class ?? null,
    proof_message_metadata: proofMsg?.metadata || null,
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
     WHERE cl.slug = $4
       AND (c.phone = $1 OR c.phone = $2 OR c.phone = $3)
     ORDER BY c.updated_at DESC LIMIT 1`,
    [phone, phoneRaw, `+${phoneRaw}`, CLIENT]);
  const msgs = await pg.query(`
    SELECT m.id::text, m.direction::text, LEFT(m.message_text, 240) AS body, m.created_at::text,
           m.metadata->>'wamid' AS wamid,
           m.metadata->>'open_phone_testing' AS open_phone_testing,
           m.metadata->>'guest_tester_class' AS guest_tester_class,
           m.metadata
      FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = $4
       AND (c.phone = $1 OR c.phone = $2 OR c.phone = $3)
       AND m.created_at >= $5::timestamptz
     ORDER BY m.created_at ASC`,
    [phone, phoneRaw, `+${phoneRaw}`, CLIENT, sinceIso]);
  const bookings = await pg.query(
    'SELECT id::text, booking_code, created_at::text FROM bookings WHERE created_at >= $1::timestamptz LIMIT 5',
    [sinceIso],
  );
  const payments = await pg.query(
    'SELECT id::text, status::text, created_at::text FROM payments WHERE created_at >= $1::timestamptz LIMIT 5',
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
  const stripeLinks = await pg.query(
    `SELECT id::text, status::text, created_at::text FROM payments
      WHERE created_at >= $1::timestamptz
        AND (metadata::text ILIKE '%checkout%' OR stripe_checkout_session_id IS NOT NULL)
      LIMIT 5`,
    [sinceIso],
  );
  return {
    conversation: conv.rows[0] || null,
    messages: msgs.rows,
    bookings_since: bookings.rows,
    payments_since: payments.rows,
    guest_message_sends: sends.rows,
    stripe_checkout_rows: stripeLinks.rows,
  };
}

function waitForHealthy(targetImage, maxSec = 180) {
  const start = Date.now();
  while (Date.now() - start < maxSec * 1000) {
    const rev = activeRevision();
    if (rev.image?.includes(COMMIT_SHORT) && rev.health === 'Healthy') return rev;
    execSync('powershell -Command "Start-Sleep -Seconds 8"', { stdio: 'ignore' });
  }
  return activeRevision();
}

(async () => {
  const out = {
    phase: 'stage45g2-hosted-proof',
    commit: COMMIT_SHORT,
    deploy: {},
    env_gates: {},
    inbound: {},
    db_proof: {},
    staff_api: {},
    safety: {},
    result: null,
  };

  console.error('[deploy] building ACR image...');
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  console.error('[deploy] updating container app...');
  az(`az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg --image ${IMAGE} --revision-suffix ${REV_SUFFIX} -o none`);
  console.error('[deploy] waiting for healthy revision...');
  out.deploy.revision = waitForHealthy(IMAGE);
  out.deploy.image = IMAGE;
  out.deploy.healthz = JSON.parse((await httpsJson('GET', STAFF_HOST, '/healthz')).raw || '{}');

  out.env_gates = readEnvGates();

  const sinceIso = new Date().toISOString();
  const wamid = `wamid.HBgMzQ2MDA5OTU1NTUVAgASG${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
  const metaPayload = buildMetaPayload(EXTERNAL_FROM, wamid, PROOF_MESSAGE, 'Stage45g External Guest');

  console.error('[proof] posting Staff API Meta inbound webhook...');
  const inbound = await httpsJson('POST', STAFF_HOST, '/staff/meta/whatsapp/webhook', metaPayload);
  await new Promise((r) => setTimeout(r, 15000));

  out.inbound = {
    test_phone_type: 'unknown_external',
    guest_phone: EXTERNAL_PHONE,
    wamid,
    message: PROOF_MESSAGE,
    webhook_path: '/staff/meta/whatsapp/webhook',
    status: inbound.status,
    body: inbound.body,
    since: sinceIso,
  };

  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  out.db_proof = await dbProof(pg, EXTERNAL_PHONE, sinceIso, wamid);

  const convId = out.db_proof.conversation?.id || inbound.body?.conversation_id || null;
  const { cookie, login_status } = await staffLogin();
  out.staff_api.login_status = login_status;
  out.staff_api = { ...out.staff_api, ...(await staffApiProof(cookie, convId)) };

  const convMetaOk = out.db_proof.conversation?.open_phone_testing === 'true'
    && out.db_proof.conversation?.guest_tester_class === 'external_open_testing';
  const msgMetaOk = out.db_proof.messages.some((m) =>
    m.open_phone_testing === 'true' && m.guest_tester_class === 'external_open_testing'
    && String(m.body || '').includes('Stage 45g.2'));
  const inboxApiOk = out.staff_api.inbox_open_phone_testing === true
    && out.staff_api.inbox_guest_tester_class === 'external_open_testing';
  const threadApiOk = out.staff_api.proof_message_open_phone_testing === true
    && out.staff_api.proof_message_guest_tester_class === 'external_open_testing';

  out.safety = {
    whatsapp_dry_run: out.env_gates.WHATSAPP_DRY_RUN === 'true',
    live_replies_disabled: out.env_gates.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'false',
    booking_writes_disabled: out.env_gates.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'false',
    stripe_disabled: out.env_gates.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'false',
    allowlist_unset: out.env_gates.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST == null,
    guest_message_sends_count: out.db_proof.guest_message_sends.length,
    bookings_created: out.db_proof.bookings_since.length,
    payments_created: out.db_proof.payments_since.length,
    stripe_checkout_rows: out.db_proof.stripe_checkout_rows.length,
    inbound_sends_whatsapp: inbound.body?.sends_whatsapp === true,
    inbound_live_send_blocked: inbound.body?.live_send_blocked !== false,
  };

  out.result = (
    out.deploy.revision.image?.includes(COMMIT_SHORT)
    && out.deploy.revision.health === 'Healthy'
    && out.deploy.healthz?.ok === true
    && out.env_gates.WHATSAPP_DRY_RUN === 'true'
    && out.env_gates.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'false'
    && out.env_gates.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'false'
    && out.env_gates.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'false'
    && inbound.status === 200
    && convMetaOk
    && msgMetaOk
    && inboxApiOk
    && threadApiOk
    && out.safety.guest_message_sends_count === 0
    && out.safety.bookings_created === 0
    && out.safety.payments_created === 0
    && out.safety.stripe_checkout_rows === 0
    && out.safety.inbound_sends_whatsapp !== true
  ) ? 'PASS' : 'PARTIAL';

  console.log(JSON.stringify(out, null, 2));
  await pg.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
