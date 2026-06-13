'use strict';
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const BASE = 'https://staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const EMAIL = 'operator.stage72c@example.test';
const PASS = 'OperatorPass123!';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'staff-staging.lunafrontdesk.com',
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const r = https.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function extractCookie(setCookie) {
  if (!setCookie) return '';
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  return arr.map((c) => c.split(';')[0]).join('; ');
}

async function main() {
  const stagingUrl = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();

  const pg = new Client({ connectionString: stagingUrl });
  await pg.connect();

  const baseline = {
    bookings: (await pg.query('SELECT COUNT(*)::int AS n FROM bookings')).rows[0].n,
    payments: (await pg.query('SELECT COUNT(*)::int AS n FROM payments')).rows[0].n,
    services: (await pg.query('SELECT COUNT(*)::int AS n FROM booking_service_records')).rows[0].n,
    pause_rows: (await pg.query('SELECT COUNT(*)::int AS n FROM bot_pause_states')).rows[0].n,
  };

  const convRow = await pg.query(
    `SELECT c.id::text AS conversation_id, c.phone, c.bot_mode::text AS bot_mode
       FROM conversations c
       INNER JOIN clients cl ON cl.id = c.client_id
      WHERE cl.slug = $1
      ORDER BY c.updated_at DESC
      LIMIT 1`,
    [CLIENT],
  );
  if (!convRow.rows[0]) throw new Error('No staging conversation found');
  const conversationId = convRow.rows[0].conversation_id;
  const botModeBefore = convRow.rows[0].bot_mode;

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: EMAIL,
    password: PASS,
  });
  const cookie = extractCookie(login.headers['set-cookie']);
  if (login.status !== 200 || !login.body.success) {
    throw new Error('Login failed: ' + JSON.stringify(login.body));
  }

  const out = { conversation_id: conversationId, client_slug: CLIENT, steps: {} };

  // A default active
  const a = await req('GET', `/staff/bot/pause-state?client_slug=${encodeURIComponent(CLIENT)}&conversation_id=${encodeURIComponent(conversationId)}`, null, cookie);
  out.steps.A_default_active = { status: a.status, body: a.body };

  // B pause
  const b = await req('POST', '/staff/bot/pause', {
    client_slug: CLIENT,
    conversation_id: conversationId,
    pause_reason: 'Phase 9.4c staging proof',
  }, cookie);
  out.steps.B_pause = { status: b.status, body: b.body };

  // C idempotent pause
  const c = await req('POST', '/staff/bot/pause', {
    client_slug: CLIENT,
    conversation_id: conversationId,
    pause_reason: 'Phase 9.4c staging proof',
  }, cookie);
  out.steps.C_pause_retry = { status: c.status, body: c.body };

  // D read paused
  const d = await req('GET', `/staff/bot/pause-state?client_slug=${encodeURIComponent(CLIENT)}&conversation_id=${encodeURIComponent(conversationId)}`, null, cookie);
  out.steps.D_read_paused = { status: d.status, body: d.body };

  // E resume
  const e = await req('POST', '/staff/bot/resume', {
    client_slug: CLIENT,
    conversation_id: conversationId,
  }, cookie);
  out.steps.E_resume = { status: e.status, body: e.body };

  // F idempotent resume
  const f = await req('POST', '/staff/bot/resume', {
    client_slug: CLIENT,
    conversation_id: conversationId,
  }, cookie);
  out.steps.F_resume_retry = { status: f.status, body: f.body };

  const after = {
    bookings: (await pg.query('SELECT COUNT(*)::int AS n FROM bookings')).rows[0].n,
    payments: (await pg.query('SELECT COUNT(*)::int AS n FROM payments')).rows[0].n,
    services: (await pg.query('SELECT COUNT(*)::int AS n FROM booking_service_records')).rows[0].n,
    pause_rows: (await pg.query('SELECT COUNT(*)::int AS n FROM bot_pause_states')).rows[0].n,
    active_pause_rows: (await pg.query('SELECT COUNT(*)::int AS n FROM bot_pause_states WHERE paused = TRUE')).rows[0].n,
  };

  const botModeAfter = (await pg.query(
    'SELECT bot_mode::text AS bot_mode FROM conversations WHERE id = $1::uuid',
    [conversationId],
  )).rows[0].bot_mode;

  out.safety = {
    baseline,
    after,
    bot_mode_before: botModeBefore,
    bot_mode_after: botModeAfter,
    bookings_unchanged: baseline.bookings === after.bookings,
    payments_unchanged: baseline.payments === after.payments,
    services_unchanged: baseline.services === after.services,
    bot_mode_unchanged: botModeBefore === botModeAfter,
  };

  console.log(JSON.stringify(out, null, 2));
  await pg.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
