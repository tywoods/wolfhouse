'use strict';
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const CLIENT = 'wolfhouse-somo';
const EMAIL = 'operator.stage72c@example.test';
const PASS = 'OperatorPass123!';
const DRAFT = 'Phase 9.6 dry-run draft reply';
const GATE_PATH = '/staff/bot/check-guest-automation-gate';

function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'staff-staging.lunafrontdesk.com',
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(headers || {}),
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

async function gate(cookie, conversationId) {
  return req('POST', GATE_PATH, {
    client_slug: CLIENT,
    conversation_id: conversationId,
    draft_reply: DRAFT,
    source: 'n8n_dry_run',
  }, { Cookie: cookie });
}

function assertGate(label, res, expected) {
  const b = res.body || {};
  const checks = {
    status200: res.status === 200,
    success: b.success === true,
    bot_paused: b.bot_paused === expected.bot_paused,
    live_send_blocked: b.live_send_blocked === expected.live_send_blocked,
    can_continue: b.can_continue_guest_automation === expected.can_continue,
    source: b.source === expected.source,
    draft_preserved: b.draft_reply_preserved === true,
    sends_whatsapp: b.sends_whatsapp === false,
    whatsapp_dry_run: b.whatsapp_dry_run === true,
    no_write: b.no_write_performed === true,
    pause_state: expected.pause_state ? !!b.pause_state : true,
  };
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  return { label, ok: failed.length === 0, failed, body: b, status: res.status };
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

  const convRow = await pg.query(
    `SELECT c.id::text AS conversation_id, c.bot_mode::text AS bot_mode
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
  const baseline = await counts();

  const login = await req('POST', '/staff/auth/login', { client: CLIENT, email: EMAIL, password: PASS });
  const cookie = extractCookie(login.headers['set-cookie']);
  if (!cookie) throw new Error('Login failed');

  // Also try bot token auth for gate (n8n path)
  let botToken = '';
  try {
    botToken = execSync(
      'az containerapp secret list --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
      { encoding: 'utf8' },
    );
    const secrets = JSON.parse(botToken);
    const tokenSecret = secrets.find((s) => s.name === 'luna-bot-internal-token');
    if (tokenSecret) {
      botToken = execSync(
        `az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv`,
        { encoding: 'utf8' },
      ).trim();
    } else {
      botToken = '';
    }
  } catch {
    botToken = '';
  }

  const step3 = await gate(cookie, conversationId);
  const step3Assert = assertGate('step3_active', step3, {
    bot_paused: false,
    live_send_blocked: false,
    can_continue: true,
    source: 'default_active',
    pause_state: false,
  });

  const pause = await req('POST', '/staff/bot/pause', {
    client_slug: CLIENT,
    conversation_id: conversationId,
    pause_reason: 'Phase 9.6 gate proof',
  }, { Cookie: cookie });

  const step5 = await gate(cookie, conversationId);
  const step5Assert = assertGate('step5_paused', step5, {
    bot_paused: true,
    live_send_blocked: true,
    can_continue: false,
    source: 'bot_pause_states',
    pause_state: true,
  });

  let step5BotToken = null;
  if (botToken) {
    step5BotToken = await req('POST', GATE_PATH, {
      client_slug: CLIENT,
      conversation_id: conversationId,
      draft_reply: DRAFT,
      source: 'n8n_dry_run',
    }, { 'X-Luna-Bot-Token': botToken });
  }

  const resume = await req('POST', '/staff/bot/resume', {
    client_slug: CLIENT,
    conversation_id: conversationId,
  }, { Cookie: cookie });

  const step7 = await gate(cookie, conversationId);
  const step7Assert = assertGate('step7_active_again', step7, {
    bot_paused: false,
    live_send_blocked: false,
    can_continue: true,
    source: 'default_active',
    pause_state: false,
  });

  const botModeAfter = (await pg.query(
    'SELECT bot_mode::text AS bot_mode FROM conversations WHERE id = $1::uuid', [conversationId],
  )).rows[0].bot_mode;
  const after = await counts();
  await pg.end();

  const report = {
    conversation_id: conversationId,
    bot_mode_before: botModeBefore,
    bot_mode_after: botModeAfter,
    baseline,
    after,
    step3_active_gate: { status: step3.status, assert: step3Assert, body: step3.body },
    step4_pause: { status: pause.status, body: pause.body },
    step5_paused_gate: { status: step5.status, assert: step5Assert, body: step5.body },
    step5_bot_token_gate: step5BotToken ? { status: step5BotToken.status, body: step5BotToken.body } : null,
    step6_resume: { status: resume.status, body: resume.body },
    step7_active_again_gate: { status: step7.status, assert: step7Assert, body: step7.body },
    all_pass: [
      step3Assert.ok,
      pause.status === 200 && pause.body.success === true && pause.body.bot_paused === true,
      step5Assert.ok,
      resume.status === 200 && resume.body.success === true && resume.body.bot_paused === false,
      step7Assert.ok,
      botModeBefore === botModeAfter,
      baseline.bookings === after.bookings,
      baseline.payments === after.payments,
      baseline.services === after.services,
      after.active_pause_rows === 0,
    ].every(Boolean),
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.all_pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
