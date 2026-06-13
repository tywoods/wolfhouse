'use strict';
/** Phase 18d.1 — guest-reply-draft send_eligibility hosted proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const ROUTE = '/staff/bot/guest-reply-draft';
const COMMIT = '7fc47ad';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:7fc47ad-stage18d-send-eligibility';
const WF_ID = 'stage16aIntakeShadow01';

const SAFETY_SE = [
  'would_send_whatsapp', 'sends_whatsapp', 'creates_booking', 'creates_payment',
  'creates_stripe_link', 'calls_n8n', 'updates_confirmation_sent_at',
];

const CASES = {
  A: {
    label: 'EN complete quote',
    payload: {
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      from: '+15555550180',
      guest_name: 'Draft Proof EN Complete',
      language: 'en',
      message_text: 'Hi, we are 2 people and want to come September 24 to September 27. Do you have Malibu? We can pay the deposit.',
    },
    expect: {
      http: 200, success: true, next_action: 'show_quote', dry_run: true, quoteWording: true,
      se: {
        send_allowed_later: true, requires_staff: false, auto_send_ready: false,
        allowed_send_kind: 'show_quote',
        gateBlocks: ['whatsapp_dry_run_active', 'live_send_env_not_enabled', 'stage_7_8_owner_approval_missing'],
      },
    },
  },
  B: {
    label: 'IT partial ask_next',
    payload: {
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      from: '+15555550181',
      guest_name: 'Draft Proof IT Partial',
      language: 'it',
      message_text: 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
    },
    expect: {
      http: 200, success: true, next_action: 'ask_missing_field', dry_run: false,
      suggested_equals: 'In quali date vorresti soggiornare?',
      se: {
        send_allowed_later: true, requires_staff: false, auto_send_ready: false,
        allowed_send_kind: 'ask_missing_field',
        gateBlocks: ['whatsapp_dry_run_active'],
      },
    },
  },
  C: {
    label: 'refund/handoff',
    payload: {
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      from: '+15555550182',
      guest_name: 'Draft Proof Handoff',
      language: 'en',
      message_text: 'I want a refund and need to talk to someone.',
    },
    expect: {
      http: 200, success: true, next_action: 'handoff_to_staff', dry_run: false, safeHandoff: true,
      se: {
        send_allowed_later: false, requires_staff: true, auto_send_ready: false,
        allowed_send_kind: null, staffBlocks: ['handoff_required'],
      },
    },
  },
};

const PROOF_PHONES = ['+15555550180', '+15555550181', '+15555550182'];
const PROOF_NAMES = ['Draft Proof EN Complete', 'Draft Proof IT Partial', 'Draft Proof Handoff'];

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function httpsReq(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...(headers || {}) };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({ hostname: HOST, path, method, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* keep string */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties.template?.containers?.[0]?.image || '',
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
    BOT_BOOKING_ENABLED: pick('BOT_BOOKING_ENABLED'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    LUNA_GUEST_INTAKE_AI_ENABLED: pick('LUNA_GUEST_INTAKE_AI_ENABLED'),
  };
}

async function dbCounts(pg) {
  const phoneList = PROOF_PHONES.map((p) => `'${p}'`).join(',');
  const nameList = PROOF_NAMES.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
  const bookings = await pg.query(
    `SELECT COUNT(*)::int AS n FROM bookings b
     JOIN guests g ON g.id = b.guest_id
     WHERE g.full_name IN (${nameList}) OR g.phone IN (${phoneList})`,
  );
  const payments = await pg.query(
    `SELECT COUNT(*)::int AS n FROM payments p
     JOIN bookings b ON b.id = p.booking_id
     JOIN guests g ON g.id = b.guest_id
     WHERE g.full_name IN (${nameList}) OR g.phone IN (${phoneList})`,
  );
  const conf = await pg.query(
    `SELECT COUNT(*)::int AS n FROM bookings b
     JOIN guests g ON g.id = b.guest_id
     WHERE (g.full_name IN (${nameList}) OR g.phone IN (${phoneList}))
       AND b.confirmation_sent_at IS NOT NULL`,
  );
  return {
    bookings: bookings.rows[0].n,
    payments: payments.rows[0].n,
    confirmation_sent: conf.rows[0].n,
  };
}

function checkCase(httpStatus, body, exp) {
  const se = body.send_eligibility || {};
  const reply = String(body.suggested_reply || '');
  const issues = [];

  if (httpStatus !== exp.http) issues.push(`http ${httpStatus}`);
  if (body.success !== exp.success) issues.push('success');
  if (body.next_action !== exp.next_action) issues.push(`next_action=${body.next_action}`);
  if (exp.dry_run && !body.dry_run_plan) issues.push('dry_run_plan missing');
  if (exp.dry_run === false && body.dry_run_plan) issues.push('dry_run_plan should be null');
  if (exp.quoteWording && !/total|deposit|€|EUR|270/i.test(reply)) issues.push('quote wording');
  if (exp.suggested_equals && reply !== exp.suggested_equals) issues.push('suggested_reply mismatch');
  if (exp.safeHandoff && /refund approved|we will refund/i.test(reply)) issues.push('unsafe handoff reply');
  if (!body.send_eligibility) issues.push('send_eligibility missing');
  else {
    for (const [k, v] of Object.entries(exp.se)) {
      if (k === 'gateBlocks') {
        for (const g of v) {
          if (!se.blocked_reasons?.includes(g)) issues.push(`missing gate ${g}`);
        }
      } else if (k === 'staffBlocks') {
        if (!v.some((r) => se.blocked_reasons?.includes(r))) issues.push('missing staff block');
      } else if (se[k] !== v) {
        issues.push(`se.${k}=${se[k]}`);
      }
    }
    for (const f of SAFETY_SE) {
      if (se[f] !== false) issues.push(`se.${f} not false`);
    }
    if (se.no_write_performed !== true) issues.push('se.no_write_performed not true');
    if (se.auto_send_ready === true) issues.push('CRITICAL auto_send_ready true');
  }
  for (const f of SAFETY_SE) {
    if (body[f] === true) issues.push(`body.${f} true`);
  }

  return {
    pass: issues.length === 0,
    issues,
    summary: {
      http: httpStatus,
      success: body.success,
      next_action: body.next_action,
      suggested_reply: reply.slice(0, 140),
      dry_run_plan_present: body.dry_run_plan != null,
      send_eligibility: se,
    },
  };
}

(async () => {
  for (let i = 0; i < 24; i++) {
    const r = activeRevision();
    const hz = await httpsReq('GET', '/healthz');
    if (r.health === 'Healthy' && r.traffic === 100 && r.image.includes('7fc47ad') && hz.status === 200) break;
    await new Promise((x) => setTimeout(x, 10000));
  }

  const out = {
    phase: '18d.1',
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb3e',
    revision: activeRevision(),
    env_flags: stagingEnvFlags(),
    healthz: null,
    n8n_shadow: null,
    db_before: null,
    db_after: null,
    cases: {},
    result: 'PENDING',
    critical_stop: false,
  };

  const healthz = await httpsReq('GET', '/healthz');
  out.healthz = { status: healthz.status, body: healthz.body };

  const token = az(
    'az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv',
  );
  const authHdr = { 'X-Luna-Bot-Token': token };

  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const n8nUrl = az('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv');

  const wh = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  const n8n = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
  await wh.connect();
  await n8n.connect();

  try {
    const wf = await n8n.query('SELECT id, active FROM workflow_entity WHERE id = $1', [WF_ID]);
    out.n8n_shadow = wf.rows[0] ? { id: wf.rows[0].id, active: wf.rows[0].active } : { id: WF_ID, active: null };

    out.db_before = await dbCounts(wh);

    for (const [id, spec] of Object.entries(CASES)) {
      const res = await httpsReq('POST', ROUTE, spec.payload, authHdr);
      const chk = checkCase(res.status, res.body || {}, spec.expect);
      out.cases[id] = { label: spec.label, ...chk };
      const b = res.body || {};
      if (b.send_eligibility?.auto_send_ready === true) out.critical_stop = true;
      if (b.creates_booking || b.creates_payment || b.creates_stripe_link || b.sends_whatsapp) {
        out.critical_stop = true;
      }
    }

    out.db_after = await dbCounts(wh);

    if (out.db_after.bookings > out.db_before.bookings
      || out.db_after.payments > out.db_before.payments
      || out.db_after.confirmation_sent > out.db_before.confirmation_sent) {
      out.critical_stop = true;
    }

    const revOk = out.revision.health === 'Healthy' && out.revision.traffic === 100
      && out.revision.image.includes('7fc47ad');
    const allPass = Object.values(out.cases).every((c) => c.pass);
    const dbOk = out.db_before.bookings === 0 && out.db_before.payments === 0
      && out.db_after.bookings === 0 && out.db_after.payments === 0;

    if (out.critical_stop) out.result = 'FAIL';
    else if (revOk && out.healthz.status === 200 && allPass && dbOk) out.result = 'PASS';
    else out.result = 'PARTIAL';
  } finally {
    await wh.end();
    await n8n.end();
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'FAIL' ? 1 : 0);
})().catch((e) => {
  console.error('PROOF_ERROR:', e.message);
  process.exit(1);
});
