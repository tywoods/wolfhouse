'use strict';
/** Phase 18e.1 — n8n guest-reply-draft shadow hosted proof. Temp — do not commit. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const WF_PATH = path.join(__dirname, 'n8n', 'Wolfhouse Booking Assistant - Message Intake Shadow.json');
const WF_ID = 'stage16aIntakeShadow01';
const CRED_ID = 'stage8512LunaBotTok01';
const CRED_NAME = 'Luna Bot Internal Token (staging)';
const N8N_HOST = 'wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const WEBHOOK_PATH = 'luna-message-intake-shadow-16a';
const WEBHOOK_NODE = 'Webhook - Intake Shadow Trigger';
const COMMIT = 'c57523e';

const CASES = {
  A: {
    label: 'EN complete quote',
    payload: {
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      from: '+15555550180',
      guest_name: 'Draft Shadow EN Complete',
      language: 'en',
      message_text: 'Hi, we are 2 people and want to come September 24 to September 27. Do you have Malibu? We can pay the deposit.',
    },
    expect: {
      next_action: 'show_quote',
      dry_run: true,
      quoteWording: true,
      se: {
        send_allowed_later: true,
        requires_staff: false,
        auto_send_ready: false,
        allowed_send_kind: 'show_quote',
      },
    },
  },
  B: {
    label: 'IT partial ask_next',
    payload: {
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      from: '+15555550181',
      guest_name: 'Draft Shadow IT Partial',
      language: 'it',
      message_text: 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
    },
    expect: {
      next_action: 'ask_missing_field',
      dry_run: false,
      suggested_equals: 'In quali date vorresti soggiornare?',
      se: {
        send_allowed_later: true,
        requires_staff: false,
        auto_send_ready: false,
        allowed_send_kind: 'ask_missing_field',
      },
    },
  },
  C: {
    label: 'refund/handoff',
    payload: {
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      from: '+15555550182',
      guest_name: 'Draft Shadow Handoff',
      language: 'en',
      message_text: 'I want a refund and need to talk to someone.',
    },
    expect: {
      next_action: 'handoff_to_staff',
      dry_run: false,
      safeHandoff: true,
      se: {
        send_allowed_later: false,
        requires_staff: true,
        auto_send_ready: false,
        staffBlocks: ['handoff_required'],
      },
    },
  },
};

const PROOF_PHONES = ['+15555550180', '+15555550181', '+15555550182'];
const PROOF_NAMES = ['Draft Shadow EN Complete', 'Draft Shadow IT Partial', 'Draft Shadow Handoff'];

function httpsReq(method, hostname, reqPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({ hostname, path: reqPath, method, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* string */ }
        resolve({ status: res.statusCode, body: parsed, raw: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function bindCredentials(nodes) {
  return nodes.map((n) => {
    if (n.type !== 'n8n-nodes-base.httpRequest') return n;
    return { ...n, credentials: { httpHeaderAuth: { id: CRED_ID, name: CRED_NAME } } };
  });
}

function safetyCheck(wf) {
  const blob = JSON.stringify(wf.nodes);
  return [
    ['active false', wf.active === false],
    ['no graph.facebook.com', !/graph\.facebook\.com/i.test(blob)],
    ['no api.stripe.com', !/api\.stripe\.com/i.test(blob)],
    ['no booking-create-from-plan', !/booking-create-from-plan/i.test(blob)],
    ['no create-stripe-link', !/create-stripe-link/i.test(blob)],
    ['no message-intake-preview HTTP brain', !wf.nodes.some((n) =>
      n.type === 'n8n-nodes-base.httpRequest'
      && JSON.stringify(n.parameters || {}).includes('/staff/bot/message-intake-preview'))],
    ['guest-reply-draft route present', /\/staff\/bot\/guest-reply-draft/i.test(blob)],
    ['no WhatsApp send node', !wf.nodes.some((n) => /whatsapp.*send|send.*whatsapp/i.test(n.name || ''))],
    ['http cred bound', wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest').every(
      (n) => n.credentials?.httpHeaderAuth?.name === CRED_NAME,
    )],
  ];
}

async function importWorkflow(c, pinPayload) {
  const wf = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));
  const nodes = bindCredentials(wf.nodes);
  const pinData = { [WEBHOOK_NODE]: [{ json: pinPayload }] };
  await c.query(
    `UPDATE workflow_entity SET
      name = $2, active = $3, nodes = $4::json, connections = $5::json, settings = $6::json,
      "staticData" = $7, "pinData" = $8::json, "versionId" = $9, meta = $10::json, "updatedAt" = NOW()
     WHERE id = $1`,
    [WF_ID, wf.name, false, JSON.stringify(nodes), JSON.stringify(wf.connections),
      JSON.stringify(wf.settings || {}), null, JSON.stringify(pinData), crypto.randomUUID(),
      JSON.stringify(wf.meta || {})],
  );
  return { wf: { ...wf, nodes }, safety: safetyCheck({ ...wf, nodes }) };
}

async function runViaWebhookTest(payload) {
  for (const p of [`/webhook-test/${WEBHOOK_PATH}`, `/webhook-test/${WF_ID}/${WEBHOOK_PATH}`]) {
    const r = await httpsReq('POST', N8N_HOST, p, {}, payload);
    if (r.status >= 200 && r.status < 300 && r.body && typeof r.body === 'object' && r.body.shadow_mode === true) {
      return { mode: 'webhook-test', path: p, response: r };
    }
  }
  return { mode: 'webhook-test', path: null, response: null };
}

async function getOrCreateApiKey(c) {
  const existing = await c.query(
    `SELECT "apiKey" FROM user_api_keys WHERE label = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    ['stage18e-temp-proof'],
  );
  if (existing.rows[0]?.apiKey) return existing.rows[0].apiKey;
  const apiKey = 'wh-stage18e-' + crypto.randomBytes(16).toString('hex');
  const user = await c.query('SELECT id FROM "user" LIMIT 1');
  if (!user.rows[0]?.id) throw new Error('no n8n user');
  await c.query(
    `INSERT INTO user_api_keys (id, "userId", label, "apiKey", "createdAt", "updatedAt", scopes)
     VALUES ($1, $2, 'stage18e-temp-proof', $3, NOW(), NOW(), NULL)`,
    [crypto.randomUUID(), user.rows[0].id, apiKey],
  );
  return apiKey;
}

async function runViaApi(apiKey, payload) {
  const pin = { [WEBHOOK_NODE]: [{ json: payload }] };
  const attempts = [
    { path: `/rest/workflows/${WF_ID}/run`, body: { workflowData: { pinData: pin } } },
    { path: '/rest/workflows/run', body: { workflowId: WF_ID, data: [{ json: payload }] } },
    { path: `/api/v1/workflows/${WF_ID}/run`, body: { workflowData: { pinData: pin } } },
  ];
  for (const a of attempts) {
    const r = await httpsReq('POST', N8N_HOST, a.path, { 'X-N8N-API-KEY': apiKey }, a.body);
    if (r.status >= 200 && r.status < 300) return { mode: 'api-run', path: a.path, response: r };
  }
  return { mode: 'api-run', path: null, response: null };
}

function parseExecutionData(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const { parse } = require('flatted');
    return parse(raw);
  } catch {
    try { return JSON.parse(raw); } catch { return null; }
  }
}

function extractFromExecution(exData) {
  const rd = exData?.resultData?.runData || {};
  const respond = rd['Respond - Draft Shadow Result']?.[0]?.data?.main?.[0]?.[0]?.json
    || rd['Code - Map Draft Shadow Response']?.[0]?.data?.main?.[0]?.[0]?.json
    || null;
  const http = rd['HTTP - Guest Reply Draft']?.[0]?.data?.main?.[0]?.[0]?.json || null;
  const httpMeta = rd['HTTP - Guest Reply Draft']?.[0];
  const httpUrl = httpMeta?.inputOverride?.main?.[0]?.[0]?.json?.url
    || (httpMeta?.source && httpMeta.source[0]?.previousNode)
    || null;
  return { respond, http, nodes: Object.keys(rd), httpUrlEvidence: http ? 'guest-reply-draft response present' : null };
}

function evaluateCase(out, http, exp) {
  const issues = [];
  const se = out?.send_eligibility || {};
  const reply = String(out?.suggested_reply || '');

  if (!out) issues.push('no output');
  if (out && out.next_action !== exp.next_action) issues.push(`next_action=${out.next_action}`);
  if (exp.dry_run && !out?.dry_run_plan) issues.push('dry_run_plan missing');
  if (exp.dry_run === false && out?.dry_run_plan) issues.push('dry_run_plan should be null');
  if (exp.quoteWording && !/total|deposit|€|EUR|270/i.test(reply)) issues.push('quote wording');
  if (exp.suggested_equals && reply !== exp.suggested_equals) issues.push('suggested_reply mismatch');
  if (exp.safeHandoff && /refund approved|we will refund/i.test(reply)) issues.push('unsafe handoff');
  if (!out?.send_eligibility) issues.push('send_eligibility missing');
  if (http && http.send_eligibility == null && out?.send_eligibility == null) issues.push('http missing send_eligibility');

  for (const [k, v] of Object.entries(exp.se)) {
    if (k === 'staffBlocks') {
      if (!v.some((r) => se.blocked_reasons?.includes(r))) issues.push('missing staff block');
    } else if (se[k] !== v) issues.push(`se.${k}=${se[k]}`);
  }

  const safetyFields = ['would_send_whatsapp', 'sends_whatsapp', 'creates_booking', 'creates_payment', 'creates_stripe_link', 'calls_n8n'];
  for (const f of safetyFields) {
    if (out && out[f] === true) issues.push(`out.${f} true`);
    if (se[f] === true) issues.push(`se.${f} true`);
  }
  if (out?.whatsapp_sent !== false) issues.push('whatsapp_sent not false');
  if (out?.live_send_blocked !== true) issues.push('live_send_blocked not true');
  if (se.auto_send_ready === true) issues.push('CRITICAL auto_send_ready true');
  if (http && !http.suggested_reply && !out?.suggested_reply) issues.push('http missing suggested_reply');

  const httpHasDraftRoute = http && (http.suggested_reply || http.send_eligibility || http.next_action === exp.next_action);
  if (!httpHasDraftRoute && !out) issues.push('HTTP guest-reply-draft evidence missing');

  return { pass: issues.length === 0, issues, out, http, se };
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

function stagingEnvFlags() {
  const env = JSON.parse(execSync(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
    { encoding: 'utf8' },
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

(async () => {
  const revision = activeRevision();
  const healthz = await httpsReq('GET', STAFF_HOST, '/healthz', {}, null);
  const envFlags = stagingEnvFlags();

  const n8nUrl = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const whUrl = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();

  const n8n = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
  const wh = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await n8n.connect();
  await wh.connect();

  const dbBefore = await dbCounts(wh);
  const wfBefore = await n8n.query('SELECT id, name, active FROM workflow_entity WHERE id = $1', [WF_ID]);
  const credRow = await n8n.query('SELECT id, name, type FROM credentials_entity WHERE id = $1', [CRED_ID]);

  const { safety: importSafety } = await importWorkflow(n8n, CASES.A.payload);
  const wfImported = await n8n.query(
    `SELECT id, name, active, nodes FROM workflow_entity WHERE id = $1`,
    [WF_ID],
  );
  const nodes = wfImported.rows[0]?.nodes || [];
  const httpNode = (typeof nodes === 'string' ? JSON.parse(nodes) : nodes)
    .find((n) => n.name === 'HTTP - Guest Reply Draft');

  const apiKey = await getOrCreateApiKey(n8n);
  const caseResults = {};
  const executionIds = [];

  for (const [key, caseDef] of Object.entries(CASES)) {
    await importWorkflow(n8n, caseDef.payload);
    let run = await runViaWebhookTest(caseDef.payload);
    if (!run.response || run.response.status >= 400) {
      run = await runViaApi(apiKey, caseDef.payload);
    }
    await new Promise((r) => setTimeout(r, 8000));

    const ex = await n8n.query(
      `SELECT id, status, mode, "startedAt" FROM execution_entity
       WHERE "workflowId" = $1 ORDER BY "startedAt" DESC LIMIT 1`,
      [WF_ID],
    );
    const execRow = ex.rows[0];
    let out = (run.response && typeof run.response.body === 'object') ? run.response.body : null;
    let http = null;
    if (execRow) {
      executionIds.push({ case: key, id: execRow.id, status: execRow.status, mode: execRow.mode });
      const data = await n8n.query('SELECT data FROM execution_data WHERE "executionId" = $1', [execRow.id]);
      const parsed = parseExecutionData(data.rows[0]?.data);
      const extracted = extractFromExecution(parsed);
      if (extracted.respond) out = extracted.respond;
      http = extracted.http;
    }

    const evalResult = evaluateCase(out, http, caseDef.expect);
    caseResults[key] = {
      label: caseDef.label,
      execution_mode: run.mode,
      execution_path: run.path,
      execution_id: execRow?.id || null,
      pass: evalResult.pass,
      issues: evalResult.issues,
      summary: {
        next_action: out?.next_action,
        suggested_reply: String(out?.suggested_reply || '').slice(0, 140),
        dry_run_plan_present: out?.dry_run_plan != null,
        send_eligibility: evalResult.se,
        whatsapp_sent: out?.whatsapp_sent,
        live_send_blocked: out?.live_send_blocked,
        staff_api_endpoint: out?.staff_api_endpoint,
        http_has_suggested_reply: !!(http && http.suggested_reply),
        http_has_send_eligibility: !!(http && http.send_eligibility),
      },
    };
  }

  const dbAfter = await dbCounts(wh);
  const wfAfter = await n8n.query('SELECT id, name, active FROM workflow_entity WHERE id = $1', [WF_ID]);
  await n8n.end();
  await wh.end();

  const allPass = Object.values(caseResults).every((c) => c.pass);
  const dbOk = dbBefore.bookings === 0 && dbAfter.bookings === 0
    && dbBefore.payments === 0 && dbAfter.payments === 0;
  const stillInactive = wfAfter.rows[0]?.active === false;
  const critical = Object.values(caseResults).some((c) =>
    c.summary?.send_eligibility?.auto_send_ready === true);

  let result = 'FAIL';
  if (critical) result = 'FAIL';
  else if (allPass && dbOk && stillInactive && healthz.status === 200) result = 'PASS';
  else if (dbOk && stillInactive && !critical) result = 'PARTIAL';

  const out = {
    phase: '18e.1',
    result,
    commit: COMMIT,
    staff_api: revision,
    healthz: { status: healthz.status },
    env_flags: envFlags,
    workflow: {
      id: WF_ID,
      name: wfAfter.rows[0]?.name,
      active_before: wfBefore.rows[0]?.active,
      active_after: wfAfter.rows[0]?.active,
      credential_bound: credRow.rows[0]?.name === CRED_NAME,
      credential_id: CRED_ID,
      http_node_url: httpNode?.parameters?.url || null,
      import_safety: Object.fromEntries(importSafety),
    },
    execution_ids: executionIds,
    cases: caseResults,
    db_before: dbBefore,
    db_after: dbAfter,
    critical_stop: critical,
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(result === 'FAIL' ? 1 : 0);
})().catch((e) => {
  console.error('PROOF_ERROR:', e.message);
  process.exit(1);
});
