'use strict';
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const CLIENT = 'wolfhouse-somo';
const EMAIL = 'operator.stage72c@example.test';
const PASS = 'OperatorPass123!';
const CONV = process.argv[2];
const ACTION = process.argv[3] || 'baseline';

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
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
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

async function login() {
  const login = await req('POST', '/staff/auth/login', { client: CLIENT, email: EMAIL, password: PASS });
  return extractCookie(login.headers?.['set-cookie'] || login.body?.setCookie);
}

async function main() {
  const stagingUrl = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const pg = new Client({ connectionString: stagingUrl });
  await pg.connect();

  const counts = async () => ({
    bookings: (await pg.query('SELECT COUNT(*)::int AS n FROM bookings')).rows[0].n,
    payments: (await pg.query('SELECT COUNT(*)::int AS n FROM payments')).rows[0].n,
    services: (await pg.query('SELECT COUNT(*)::int AS n FROM booking_service_records')).rows[0].n,
    active_pause_rows: (await pg.query('SELECT COUNT(*)::int AS n FROM bot_pause_states WHERE paused = TRUE')).rows[0].n,
  });

  const botMode = async (id) => (await pg.query(
    'SELECT bot_mode::text AS bot_mode FROM conversations WHERE id = $1::uuid', [id],
  )).rows[0]?.bot_mode;

  const baseline = await counts();
  const botModeBefore = await botMode(CONV);

  const loginRes = await req('POST', '/staff/auth/login', { client: CLIENT, email: EMAIL, password: PASS });
  const cookie = extractCookie(loginRes.headers['set-cookie']);

  let apiResult = null;
  if (ACTION === 'pause') {
    apiResult = await req('POST', '/staff/bot/pause', {
      client_slug: CLIENT,
      conversation_id: CONV,
      pause_reason: 'Phase 9.5 hosted Inbox proof',
    }, cookie);
  } else if (ACTION === 'resume') {
    apiResult = await req('POST', '/staff/bot/resume', {
      client_slug: CLIENT,
      conversation_id: CONV,
    }, cookie);
  } else if (ACTION === 'get') {
    apiResult = await req('GET', `/staff/bot/pause-state?client_slug=${encodeURIComponent(CLIENT)}&conversation_id=${encodeURIComponent(CONV)}`, null, cookie);
  }

  const after = await counts();
  const botModeAfter = await botMode(CONV);
  await pg.end();

  console.log(JSON.stringify({
    action: ACTION,
    conversation_id: CONV,
    client_slug: CLIENT,
    api: apiResult,
    baseline,
    after,
    bot_mode_before: botModeBefore,
    bot_mode_after: botModeAfter,
    bot_mode_unchanged: botModeBefore === botModeAfter,
    counts_unchanged: baseline.bookings === after.bookings && baseline.payments === after.payments && baseline.services === after.services,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
