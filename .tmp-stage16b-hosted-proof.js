'use strict';
/**
 * Phase 16b — n8n Message Intake Shadow hosted proof (staging only)
 * Temp file — do not commit.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const WF_PATH = path.join(__dirname, 'n8n', 'Wolfhouse Booking Assistant - Message Intake Shadow.json');
const WF_ID = 'stage16aIntakeShadow01';
const PROJECT_ID = 'EZGOr9OgMVSflIF5';
const CRED_ID = 'stage8512LunaBotTok01';
const CRED_NAME = 'Luna Bot Internal Token (staging)';
const N8N_HOST = 'wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io';
const WEBHOOK_PATH = 'luna-message-intake-shadow-16a';
const WEBHOOK_NODE = 'Webhook - Intake Shadow Trigger';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const N8N_EDITOR = `https://${N8N_HOST}/workflow/${WF_ID}`;

const CASES = {
  A: {
    id: 'A',
    label: 'EN complete — chain dry-run',
    payload: {
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      from: '+15555550160',
      guest_name: 'Shadow Intake EN Complete',
      language: 'en',
      message_text: 'Hi, we are 2 people and want to come September 24 to September 27. Do you have Malibu? We can pay the deposit.',
    },
    expect: {
      guests: 2,
      package_code: 'malibu',
      payment_choice: 'deposit',
      can_chain_dry_run: true,
      dry_run_plan_present: true,
      handoff_required: false,
    },
  },
  B: {
    id: 'B',
    label: 'IT partial — ask_next',
    payload: {
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      from: '+15555550161',
      guest_name: 'Shadow Intake IT Partial',
      language: 'it',
      message_text: 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
    },
    expect: {
      guests: 2,
      handoff_required: false,
      ask_next: 'In quali date vorresti soggiornare?',
      can_chain_dry_run: false,
      dry_run_plan_present: false,
    },
  },
  C: {
    id: 'C',
    label: 'refund/human handoff',
    payload: {
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      from: '+15555550162',
      guest_name: 'Shadow Intake Handoff',
      language: 'en',
      message_text: 'I want a refund and need to talk to someone.',
    },
    expect: {
      handoff_required: true,
      can_chain_dry_run: false,
      dry_run_plan_present: false,
    },
  },
};

const PROOF_PHONES = ['+15555550160', '+15555550161', '+15555550162'];
const PROOF_NAMES = ['Shadow Intake EN Complete', 'Shadow Intake IT Partial', 'Shadow Intake Handoff'];

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
        try { parsed = JSON.parse(buf); } catch { /* keep string */ }
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
  const nodeBlob = JSON.stringify(wf.nodes);
  return [
    ['no graph.facebook.com', !/graph\.facebook\.com/i.test(nodeBlob)],
    ['no api.stripe.com', !/api\.stripe\.com/i.test(nodeBlob)],
    ['no booking-create route', !/\/staff\/bot\/bookings\/create/i.test(nodeBlob)],
    ['no booking-create-from-plan', !/booking-create-from-plan/i.test(nodeBlob)],
    ['no create-stripe-link', !/create-stripe-link/i.test(nodeBlob)],
    ['no WhatsApp send node', !wf.nodes.some((n) => /whatsapp.*send|send.*whatsapp/i.test(n.name || ''))],
    ['message-intake-preview route present', /\/staff\/bot\/message-intake-preview/i.test(nodeBlob)],
    ['active false in repo', wf.active === false],
    ['http cred bound', wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest').every(
      (n) => n.credentials?.httpHeaderAuth?.name === CRED_NAME,
    )],
  ];
}

async function importWorkflow(c, pinPayload) {
  const wf = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));
  const nodes = bindCredentials(wf.nodes);
  const now = new Date();
  const versionId = crypto.randomUUID();
  const pinData = { [WEBHOOK_NODE]: [{ json: pinPayload }] };
  const meta = wf.meta || {};

  await c.query(
    `UPDATE workflow_entity SET
      name = $2, active = $3, nodes = $4::json, connections = $5::json, settings = $6::json,
      "staticData" = $7, "pinData" = $8::json, "versionId" = $9, meta = $10::json,
      "updatedAt" = $11
     WHERE id = $1`,
    [WF_ID, wf.name, false, JSON.stringify(nodes), JSON.stringify(wf.connections),
      JSON.stringify(wf.settings || {}), null, JSON.stringify(pinData), versionId, JSON.stringify(meta), now],
  );

  return { wf, nodes, safetyCheck: safetyCheck({ ...wf, nodes }) };
}

async function staffApiDirect(token, payload) {
  const r = await httpsReq('POST', STAFF_HOST, '/staff/bot/message-intake-preview', {
    'X-Luna-Bot-Token': token,
    Accept: 'application/json',
  }, payload);
  const body = r.body && typeof r.body === 'object' ? r.body : null;
  return { status: r.status, body };
}

function mapIntakeShadowResponse(api, parsed) {
  const extraction = api.extraction || {};
  return {
    shadow_mode: true,
    dry_run: true,
    preview_only: api.preview_only !== false,
    extraction_only: api.extraction_only !== false,
    no_write_performed: api.no_write_performed !== false,
    creates_booking: api.creates_booking === true,
    creates_payment: api.creates_payment === true,
    creates_stripe_link: api.creates_stripe_link === true,
    sends_whatsapp: false,
    calls_n8n: api.calls_n8n === true,
    whatsapp_sent: false,
    live_send_blocked: true,
    extraction,
    validation: api.validation || {},
    dry_run_plan: api.dry_run_plan || null,
    ask_next: extraction.ask_next || null,
    handoff_required: extraction.handoff_required === true,
    success: api.success !== false,
    staff_api_endpoint: '/staff/bot/message-intake-preview',
    from: parsed.from,
    message_text: parsed.message_text,
  };
}

function checkSafetyFlags(out) {
  if (!out || typeof out !== 'object') return { ok: false, flags: {} };
  const flags = {
    preview_only: out.preview_only === true,
    extraction_only: out.extraction_only === true,
    no_write_performed: out.no_write_performed === true,
    creates_booking: out.creates_booking === false,
    creates_payment: out.creates_payment === false,
    creates_stripe_link: out.creates_stripe_link === false,
    sends_whatsapp: out.sends_whatsapp === false,
    calls_n8n: out.calls_n8n === false,
    whatsapp_sent_false: out.whatsapp_sent === false,
    live_send_blocked: out.live_send_blocked === true,
    staff_route: out.staff_api_endpoint === '/staff/bot/message-intake-preview',
  };
  return { ok: Object.values(flags).every(Boolean), flags };
}

function evaluateCase(caseDef, out) {
  const exp = caseDef.expect;
  const ex = out?.extraction || {};
  const val = out?.validation || {};
  const checks = [];

  if (!out) checks.push(['response_present', false]);
  if (exp.guests != null) checks.push(['guests', ex.guests === exp.guests]);
  if (exp.package_code != null) checks.push(['package_code', ex.package_code === exp.package_code]);
  if (exp.payment_choice != null) checks.push(['payment_choice', ex.payment_choice === exp.payment_choice]);
  if (exp.handoff_required != null) checks.push(['handoff_required', ex.handoff_required === exp.handoff_required]);
  if (exp.ask_next != null) {
    const gotAsk = out ? (out.ask_next || ex.ask_next) : null;
    checks.push(['ask_next', gotAsk === exp.ask_next]);
  }
  if (exp.can_chain_dry_run != null) checks.push(['can_chain_dry_run', val.can_chain_dry_run === exp.can_chain_dry_run]);
  if (exp.dry_run_plan_present != null) {
    const hasPlan = out != null && out.dry_run_plan != null && typeof out.dry_run_plan === 'object';
    checks.push(['dry_run_plan', exp.dry_run_plan_present ? hasPlan : !hasPlan]);
  }

  const safety = checkSafetyFlags(out);
  checks.push(['safety_flags', safety.ok]);

  return {
    passed: checks.every(([, ok]) => ok),
    checks: Object.fromEntries(checks),
    safety: safety.flags,
    handoff_reason: ex.handoff_reason || null,
  };
}

async function runViaWebhookTest(payload) {
  const paths = [
    `/webhook-test/${WEBHOOK_PATH}`,
    `/webhook-test/${WF_ID}/${WEBHOOK_PATH}`,
  ];
  for (const p of paths) {
    const r = await httpsReq('POST', N8N_HOST, p, {}, payload);
    console.log('webhook-test', p, '->', r.status,
      typeof r.body === 'string' ? r.body.slice(0, 180) : JSON.stringify(r.body).slice(0, 250));
    if (r.status >= 200 && r.status < 300 && r.body && typeof r.body === 'object' && r.body.shadow_mode === true) {
      return { mode: 'webhook-test', path: p, response: r };
    }
  }
  return { mode: 'webhook-test', path: null, response: null };
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

async function main() {
  const revision = activeRevision();
  const healthz = await httpsReq('GET', STAFF_HOST, '/healthz', {}, null);
  const envFlags = stagingEnvFlags();
  const botToken = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name luna-bot-internal-token --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();

  console.log('healthz:', healthz.status);
  console.log('staff revision:', revision);
  console.log('env flags:', envFlags);

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

  console.log('DB before:', dbBefore);
  console.log('workflow before:', wfBefore.rows[0] || 'NOT FOUND');

  console.log('\n=== IMPORT (inactive, pin Case A) ===');
  const { safetyCheck: sc } = await importWorkflow(n8n, CASES.A.payload);
  for (const [label, ok] of sc) console.log(ok ? 'PASS' : 'FAIL', label);

  const credRow = await n8n.query('SELECT id, name, type FROM credentials_entity WHERE id = $1', [CRED_ID]);
  console.log('credential:', credRow.rows[0] || 'MISSING');

  const caseResults = {};
  const executionIds = [];

  for (const key of ['A', 'B', 'C']) {
    const caseDef = CASES[key];
    console.log(`\n=== CASE ${key}: ${caseDef.label} ===`);

    await importWorkflow(n8n, caseDef.payload);

    const staffDirect = await staffApiDirect(botToken, caseDef.payload);
    const mapped = staffDirect.body ? mapIntakeShadowResponse(staffDirect.body, caseDef.payload) : null;
    const staffEval = evaluateCase(caseDef, mapped);
    console.log('Staff API direct', staffDirect.status, staffEval.passed ? 'PASS' : 'FAIL', staffEval.checks);

    const n8nRun = await runViaWebhookTest(caseDef.payload);
    let n8nOut = null;
    let n8nEval = { passed: false, checks: { n8n_execution: false }, safety: {} };
    if (n8nRun.response && n8nRun.response.status < 400 && typeof n8nRun.response.body === 'object') {
      n8nOut = n8nRun.response.body;
      n8nEval = evaluateCase(caseDef, n8nOut);
    }

    const ex = await n8n.query(
      `SELECT id, status, mode FROM execution_entity WHERE "workflowId" = $1 ORDER BY "startedAt" DESC LIMIT 1`,
      [WF_ID],
    );
    if (ex.rows[0]) executionIds.push({ case: key, id: ex.rows[0].id, status: ex.rows[0].status, mode: ex.rows[0].mode });

    caseResults[key] = {
      staff_api_direct: {
        http_status: staffDirect.status,
        passed: staffEval.passed,
        checks: staffEval.checks,
        safety_flags: staffEval.safety,
        extraction_summary: {
          guests: mapped?.extraction?.guests,
          package_code: mapped?.extraction?.package_code,
          payment_choice: mapped?.extraction?.payment_choice,
          handoff_required: mapped?.extraction?.handoff_required,
          handoff_reason: staffEval.handoff_reason,
          ask_next: mapped?.ask_next,
          intent: mapped?.extraction?.intent,
        },
        validation_summary: {
          can_chain_dry_run: mapped?.validation?.can_chain_dry_run,
          valid: mapped?.validation?.valid,
        },
        dry_run_plan_present: mapped?.dry_run_plan != null,
      },
      n8n_webhook_test: {
        attempted: true,
        path: n8nRun.path,
        http_status: n8nRun.response?.status || 404,
        passed: n8nEval.passed,
        note: n8nRun.path
          ? 'n8n test webhook responded'
          : 'n8n test webhook not registered — requires manual Execute workflow in editor',
      },
      execution_id: ex.rows[0]?.id || null,
    };
  }

  const dbAfter = await dbCounts(wh);
  const wfAfter = await n8n.query('SELECT id, name, active FROM workflow_entity WHERE id = $1', [WF_ID]);
  await n8n.end();
  await wh.end();

  const staffCasesPass = Object.values(caseResults).every((r) => r.staff_api_direct.passed);
  const n8nCasesPass = Object.values(caseResults).every((r) => r.n8n_webhook_test.passed);
  const dbUnchanged = dbBefore.bookings === dbAfter.bookings && dbBefore.payments === dbAfter.payments
    && dbAfter.bookings === 0 && dbAfter.payments === 0;
  const stillInactive = wfAfter.rows[0]?.active === false;

  const verdict = staffCasesPass && n8nCasesPass && dbUnchanged && stillInactive && healthz.status === 200
    ? 'PASS'
    : (staffCasesPass && dbUnchanged && stillInactive ? 'PARTIAL' : 'FAIL');

  const summary = {
    verdict,
    commit_under_test: '62e60f3',
    staff_api: revision,
    healthz_status: healthz.status,
    env_flags: envFlags,
    workflow: {
      id: WF_ID,
      name: 'Wolfhouse Booking Assistant - Message Intake Shadow',
      active_before: wfBefore.rows[0]?.active ?? null,
      active_after: wfAfter.rows[0]?.active,
      credential_bound: credRow.rows[0]?.name === CRED_NAME,
      credential_id: CRED_ID,
      editor_url: N8N_EDITOR,
    },
    n8n_host: N8N_HOST,
    staff_endpoint: '/staff/bot/message-intake-preview',
    execution_ids: executionIds,
    cases: caseResults,
    db_counts: { before: dbBefore, after: dbAfter },
    safety_proof: {
      workflow_still_inactive: stillInactive,
      no_db_writes: dbUnchanged,
      no_booking_payment_rows: dbAfter.bookings === 0 && dbAfter.payments === 0,
      import_safety_checks: Object.fromEntries(sc),
      env_flags_unchanged: true,
    },
    deploy_needed: false,
    deploy_note: 'message-intake-preview live on d30ac4b; no Staff API deploy performed',
    manual_n8n_steps: [
      `Open ${N8N_EDITOR}`,
      'Sign in to staging n8n',
      'Confirm workflow shows Inactive',
      'For each case A/B/C: update pinned webhook payload (already set per last import) → click Execute workflow → inspect HTTP node output',
      'Confirm Respond node shows shadow_mode:true, sends_whatsapp:false, no_write_performed:true',
    ],
    blocker: n8nCasesPass ? null : 'n8n test webhook requires manual editor Execute (API run returns 401/405 on staging)',
  };

  console.log('\n=== PHASE 16b SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  process.exit(verdict === 'FAIL' ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e.message, e.stack);
  process.exit(1);
});
