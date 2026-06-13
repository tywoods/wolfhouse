'use strict';
/** Phase 18b.1 — guest-reply-draft hosted proof (staging). Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const ROUTE = '/staff/bot/guest-reply-draft';
const COMMIT = '4011221';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:4011221-stage18b-guest-reply-draft';
const WF_ID = 'stage16aIntakeShadow01';

const CASES = {
  A: {
    label: 'EN complete quote draft',
    payload: {
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      from: '+15555550180',
      guest_name: 'Draft Proof EN Complete',
      language: 'en',
      message_text: 'Hi, we are 2 people and want to come September 24 to September 27. Do you have Malibu? We can pay the deposit.',
    },
  },
  B: {
    label: 'IT partial ask_next draft',
    payload: {
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      from: '+15555550181',
      guest_name: 'Draft Proof IT Partial',
      language: 'it',
      message_text: 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
    },
  },
  C: {
    label: 'refund/handoff draft',
    payload: {
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      from: '+15555550182',
      guest_name: 'Draft Proof Handoff',
      language: 'en',
      message_text: 'I want a refund and need to talk to someone.',
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
  const confUpdates = await pg.query(
    `SELECT COUNT(*)::int AS n FROM bookings b
     JOIN guests g ON g.id = b.guest_id
     WHERE (g.full_name IN (${nameList}) OR g.phone IN (${phoneList}))
       AND b.confirmation_sent_at IS NOT NULL`,
  );
  return {
    bookings: bookings.rows[0].n,
    payments: payments.rows[0].n,
    confirmation_sent: confUpdates.rows[0].n,
  };
}

function summarizeCase(id, httpStatus, body) {
  const reply = String(body.suggested_reply || '');
  const ex = body.extraction || {};
  const dry = body.dry_run_plan;
  return {
    http: httpStatus,
    success: body.success,
    draft_only: body.draft_only,
    preview_only: body.preview_only,
    no_write_performed: body.no_write_performed,
    requires_staff_review: body.requires_staff_review,
    sends_whatsapp: body.sends_whatsapp,
    whatsapp_sent: body.whatsapp_sent,
    calls_n8n: body.calls_n8n,
    creates_booking: body.creates_booking,
    creates_payment: body.creates_payment,
    creates_stripe_link: body.creates_stripe_link,
    updates_confirmation_sent_at: body.updates_confirmation_sent_at,
    next_action: body.next_action,
    dry_run_plan_present: dry != null,
    handoff_required: ex.handoff_required,
    suggested_reply_preview: reply.slice(0, 280),
    has_quote_wording: /total|deposit|€|EUR|payment|quote|Malibu|estimated/i.test(reply),
    ask_next_match: reply.trim() === 'In quali date vorresti soggiornare?' || /In quali date vorresti soggiornare/i.test(reply),
    safe_handoff: !/refund approved|we will refund|processed your refund/i.test(reply),
  };
}

function checkCase(id, s) {
  const flagsOk = [
    s.draft_only, s.preview_only, s.no_write_performed, s.requires_staff_review,
    s.sends_whatsapp === false, s.whatsapp_sent === false, s.calls_n8n === false,
    s.creates_booking === false, s.creates_payment === false,
    s.creates_stripe_link === false, s.updates_confirmation_sent_at === false,
  ].every((v) => v === true);
  if (id === 'A') {
    return s.http === 200 && s.success === true && flagsOk
      && s.next_action === 'show_quote' && s.dry_run_plan_present
      && s.has_quote_wording && s.suggested_reply_preview.length > 0;
  }
  if (id === 'B') {
    return s.http === 200 && s.success === true && flagsOk
      && s.next_action === 'ask_missing_field' && !s.dry_run_plan_present
      && s.ask_next_match;
  }
  if (id === 'C') {
    return s.http === 200 && s.success === true && flagsOk
      && s.handoff_required === true && s.next_action === 'handoff_to_staff'
      && !s.dry_run_plan_present && s.safe_handoff && s.suggested_reply_preview.length > 0;
  }
  return false;
}

(async () => {
  const out = {
    phase: '18b.1',
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb3d',
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
      const summary = summarizeCase(id, res.status, res.body || {});
      out.cases[id] = { label: spec.label, summary, pass: checkCase(id, summary) };
      if (summary.creates_booking || summary.creates_payment || summary.creates_stripe_link
        || summary.sends_whatsapp || summary.calls_n8n || summary.updates_confirmation_sent_at) {
        out.critical_stop = true;
      }
    }

    out.db_after = await dbCounts(wh);

    if (out.db_after.bookings > out.db_before.bookings || out.db_after.payments > out.db_before.payments) {
      out.critical_stop = true;
    }
    if (out.db_after.confirmation_sent > out.db_before.confirmation_sent) {
      out.critical_stop = true;
    }

    const revOk = out.revision.health === 'Healthy' && out.revision.traffic === 100
      && out.revision.image.includes('4011221');
    const healthOk = out.healthz.status === 200;
    const dbOk = out.db_before.bookings === 0 && out.db_before.payments === 0
      && out.db_after.bookings === 0 && out.db_after.payments === 0;
    const casesOk = Object.values(out.cases).every((c) => c.pass);

    if (out.critical_stop) out.result = 'FAIL';
    else if (revOk && healthOk && dbOk && casesOk) out.result = 'PASS';
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
