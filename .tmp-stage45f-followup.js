'use strict';
/** Stage 45f follow-up — query proof after pipe test. Temp */

const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const EXTERNAL_PHONE = '+34600995555';
const SINCE = '2026-06-11T14:00:00Z';

function az(cmd) { return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim(); }

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
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const n8nUrl = az('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  const nc = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  await nc.connect();

  const wf = await nc.query("SELECT id, active FROM workflow_entity WHERE id='stage27demoJReview01'");
  const hooks = await nc.query("SELECT count(*)::int AS n FROM webhook_entity WHERE \"workflowId\"='stage27demoJReview01'");
  const ex = await nc.query(
    "SELECT id, status, mode, \"startedAt\"::text FROM execution_entity WHERE \"workflowId\"='stage27demoJReview01' ORDER BY \"startedAt\" DESC LIMIT 3",
  );

  const conv = await pg.query(`
    SELECT c.id::text, c.phone, c.last_message_preview, c.updated_at::text,
           c.staff_reply_draft IS NOT NULL AS has_draft,
           LEFT(c.staff_reply_draft, 180) AS draft_preview,
           c.metadata->>'open_phone_testing' AS open_phone_testing,
           c.metadata->>'guest_tester_class' AS guest_tester_class,
           c.metadata
      FROM conversations c
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = 'wolfhouse-somo'
       AND (c.phone IN ('34600995555', '+34600995555') OR c.updated_at >= $1::timestamptz)
     ORDER BY c.updated_at DESC LIMIT 5`, [SINCE]);

  const msgs = await pg.query(`
    SELECT m.direction::text, LEFT(m.message_text, 240) AS body, m.created_at::text,
           m.metadata->>'wamid' AS wamid,
           m.metadata->>'open_phone_testing' AS open_phone_testing,
           m.metadata->>'guest_tester_class' AS guest_tester_class
      FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = 'wolfhouse-somo'
       AND m.created_at >= $1::timestamptz
       AND (c.phone IN ('34600995555', '+34600995555') OR m.message_text ILIKE '%Stage 45f%')
     ORDER BY m.created_at DESC LIMIT 10`, [SINCE]);

  const bookings = await pg.query('SELECT id::text, booking_code, created_at::text FROM bookings WHERE created_at >= $1::timestamptz LIMIT 5', [SINCE]);
  const payments = await pg.query('SELECT id::text, status::text, created_at::text FROM payments WHERE created_at >= $1::timestamptz LIMIT 5', [SINCE]);
  const sends = await pg.query(
    "SELECT idempotency_key, status, to_phone, created_at::text FROM guest_message_sends WHERE created_at >= $1::timestamptz ORDER BY created_at DESC LIMIT 10",
    [SINCE],
  );

  const login = await httpsJson('POST', STAFF_HOST, '/staff/auth/login', {
    client: 'wolfhouse-somo', email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const inbox = await httpsJson('GET', STAFF_HOST, '/staff/conversations?client=wolfhouse-somo&limit=30', null, { Cookie: cookie });

  let meta = null;
  try {
    const token = az('az keyvault secret show --vault-name wh-staging-kv --name meta-whatsapp-token --query value -o tsv');
    meta = await new Promise((resolve, reject) => {
      https.get(`https://graph.facebook.com/v21.0/1152900101233109?fields=display_phone_number,webhook_configuration&access_token=${encodeURIComponent(token)}`, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
      }).on('error', reject);
    });
  } catch (e) {
    meta = { error: e.message };
  }

  const convId = conv.rows[0]?.id;
  let context = null;
  if (convId) {
    context = await httpsJson('GET', STAFF_HOST, `/staff/conversations/${convId}/context?client=wolfhouse-somo`, null, { Cookie: cookie });
  }

  console.log(JSON.stringify({
    n8n: { workflow: wf.rows[0], webhook_rows: hooks.rows[0].n, recent_executions: ex.rows },
    meta_callback: meta?.webhook_configuration || meta,
    conversations: conv.rows,
    messages: msgs.rows,
    bookings_since: bookings.rows,
    payments_since: payments.rows,
    guest_message_sends_since: sends.rows,
    staff_inbox: {
      status: inbox.status,
      recent: (inbox.body?.conversations || []).slice(0, 5).map((c) => ({
        id: c.id, phone: c.phone, preview: c.last_message_preview, updated_at: c.updated_at,
      })),
      context_metadata: context?.body?.metadata || context?.body?.conversation?.metadata || null,
    },
  }, null, 2));

  await pg.end();
  await nc.end();
})().catch((e) => { console.error(e); process.exit(1); });
