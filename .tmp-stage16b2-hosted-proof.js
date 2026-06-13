'use strict';
/**
 * Phase 16b.2 — ES/DE native date hosted smoke (staging only). Temp — do not commit.
 */
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const PROOF_PHONES = ['+15555550170', '+15555550171'];
const PROOF_NAMES = ['Hosted Intake ES Native', 'Hosted Intake DE Native'];

const CASES = {
  ES: {
    payload: {
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      from: '+15555550170',
      guest_name: 'Hosted Intake ES Native',
      language: 'es',
      message_text: 'Somos dos personas del 24 de septiembre al 27 de septiembre. Queremos Malibu y pagar el depósito.',
    },
    expect: {
      guests: 2,
      check_in: '2026-09-24',
      check_out: '2026-09-27',
      package_code: 'malibu',
      payment_choice: 'deposit',
      can_chain_dry_run: true,
      dry_run_plan: true,
    },
  },
  DE: {
    payload: {
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      from: '+15555550171',
      guest_name: 'Hosted Intake DE Native',
      language: 'de',
      message_text: 'Wir sind drei Personen vom 24. September bis 27. September. Wir möchten Malibu und die Anzahlung zahlen.',
    },
    expect: {
      guests: 3,
      check_in: '2026-09-24',
      check_out: '2026-09-27',
      package_code: 'malibu',
      payment_choice: 'deposit',
      can_chain_dry_run: true,
      dry_run_plan: true,
    },
  },
};

function postIntake(token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: HOST,
      path: '/staff/bot/message-intake-preview',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-Luna-Bot-Token': token,
        Accept: 'application/json',
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* string */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function safetyOk(b) {
  return b
    && b.no_write_performed === true
    && b.sends_whatsapp === false
    && b.creates_booking === false
    && b.creates_payment === false
    && b.creates_stripe_link === false
    && b.calls_n8n === false;
}

function evaluate(label, resp, exp) {
  const b = resp.body || {};
  const ex = b.extraction || {};
  const val = b.validation || {};
  const checks = {
    http_200: resp.status === 200,
    guests: ex.guests === exp.guests,
    check_in: ex.check_in === exp.check_in,
    check_out: ex.check_out === exp.check_out,
    package_code: ex.package_code === exp.package_code,
    payment_choice: ex.payment_choice === exp.payment_choice,
    can_chain_dry_run: val.can_chain_dry_run === exp.can_chain_dry_run,
    dry_run_plan: exp.dry_run_plan ? (b.dry_run_plan != null) : (b.dry_run_plan == null),
    safety_flags: safetyOk(b),
  };
  const passed = Object.values(checks).every(Boolean);
  return { passed, checks, extraction: ex, validation: val, safety: {
    no_write_performed: b.no_write_performed,
    sends_whatsapp: b.sends_whatsapp,
    creates_booking: b.creates_booking,
    creates_payment: b.creates_payment,
    creates_stripe_link: b.creates_stripe_link,
    calls_n8n: b.calls_n8n,
  }};
}

async function dbCounts(pg) {
  const phoneList = PROOF_PHONES.map((p) => `'${p}'`).join(',');
  const nameList = PROOF_NAMES.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
  const bookings = await pg.query(
    `SELECT COUNT(*)::int AS n FROM bookings b JOIN guests g ON g.id = b.guest_id
     WHERE g.full_name IN (${nameList}) OR g.phone IN (${phoneList})`,
  );
  const payments = await pg.query(
    `SELECT COUNT(*)::int AS n FROM payments p JOIN bookings b ON b.id = p.booking_id
     JOIN guests g ON g.id = b.guest_id
     WHERE g.full_name IN (${nameList}) OR g.phone IN (${phoneList})`,
  );
  return { bookings: bookings.rows[0].n, payments: payments.rows[0].n };
}

function activeRevision() {
  const rows = JSON.parse(execSync(
    'az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' },
  ));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties.template?.containers?.[0]?.image || '',
  };
}

function envFlags() {
  const app = JSON.parse(execSync(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' },
  ));
  const env = app.properties?.template?.containers?.[0]?.env || [];
  const pick = (name) => {
    const row = env.find((e) => e.name === name);
    return row ? (row.value || row.secretRef || '(secret)') : '(unset)';
  };
  return {
    BOT_BOOKING_ENABLED: pick('BOT_BOOKING_ENABLED'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    LUNA_GUEST_INTAKE_AI_ENABLED: pick('LUNA_GUEST_INTAKE_AI_ENABLED'),
  };
}

(async () => {
  const token = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name luna-bot-internal-token --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();

  const health = await new Promise((resolve, reject) => {
    https.get(`https://${HOST}/healthz`, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 120) }));
    }).on('error', reject);
  });

  const whUrl = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const wh = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await wh.connect();
  const dbBefore = await dbCounts(wh);

  const results = {};
  for (const [key, def] of Object.entries(CASES)) {
    const resp = await postIntake(token, def.payload);
    results[key] = evaluate(key, resp, def.expect);
    console.log(`\n=== ${key} === status ${resp.status} passed ${results[key].passed}`);
    console.log(JSON.stringify(results[key].checks, null, 2));
  }

  const dbAfter = await dbCounts(wh);
  await wh.end();

  const allPass = Object.values(results).every((r) => r.passed);
  const dbOk = dbBefore.bookings === 0 && dbAfter.bookings === 0
    && dbBefore.payments === 0 && dbAfter.payments === 0;

  console.log('\n=== PHASE 16b.2 SUMMARY ===');
  console.log(JSON.stringify({
    verdict: allPass && dbOk && health.status === 200 ? 'PASS' : (allPass ? 'PARTIAL' : 'FAIL'),
    commit: '62e60f3',
    revision: activeRevision(),
    healthz: health,
    env_flags: envFlags(),
    cases: results,
    db_counts: { before: dbBefore, after: dbAfter },
  }, null, 2));

  process.exit(allPass && dbOk ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
