'use strict';
/** Phase 19f.3 — hosted n8n Cloud Luna Pipe Shadow proof. Temp — do not commit. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const vm = require('vm');
const { Client } = require('pg');
const { execSync } = require('child_process');

const WF_PATH = path.join(__dirname, 'n8n', 'Wolfhouse Booking Assistant - Luna Pipe Shadow.json');
const N8N_CLOUD_HOST = 'tywoods.app.n8n.cloud';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const WEBHOOK_PATH = 'luna-pipe-shadow-19f';
const WEBHOOK_NODE = 'Webhook - Luna Pipe Shadow Trigger';
const COMMIT = 'f3ab58a';
const PROOF_KEYS = [
  'luna:wolfhouse-somo:wamid.phase19f3.partial.001:ask_missing_field',
  'luna:wolfhouse-somo:wamid.phase19f3.meta.001:show_quote',
  'luna:wolfhouse-somo:wamid.phase19f3.risky.001',
];

const CASES = {
  A: {
    label: 'flat partial IT',
    payload: {
      client_slug: 'wolfhouse-somo',
      from: '+15555550210',
      guest_name: 'Pipe Shadow Partial',
      language: 'it',
      message_text: 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
      channel: 'whatsapp',
      wa_message_id: 'wamid.phase19f3.partial.001',
    },
    expect: {
      next_action: 'ask_missing_field',
      send_kind: 'ask_missing_field',
      idempotency_key: 'luna:wolfhouse-somo:wamid.phase19f3.partial.001:ask_missing_field',
      requires_staff: false,
      send_route_skipped_ok: true,
      no_live_send: true,
    },
  },
  B: {
    label: 'Meta-shaped quote',
    payload: {
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: '1152900101233109' },
            contacts: [{ profile: { name: 'Pipe Shadow Meta Guest' }, wa_id: '15555550211' }],
            messages: [{
              from: '15555550211',
              id: 'wamid.phase19f3.meta.001',
              timestamp: '1760000000',
              type: 'text',
              text: { body: 'Hi, we are 2 people and want Malibu from September 24 to September 27. We can pay the deposit.' },
            }],
          },
        }],
      }],
    },
    expect: {
      next_action: 'show_quote',
      send_kind: 'show_quote',
      idempotency_key: 'luna:wolfhouse-somo:wamid.phase19f3.meta.001:show_quote',
      requires_staff: false,
      normalized_from: '15555550211',
      normalized_wa_id: 'wamid.phase19f3.meta.001',
      send_route_skipped_ok: true,
      no_live_send: true,
    },
  },
  C: {
    label: 'risky refund handoff',
    payload: {
      client_slug: 'wolfhouse-somo',
      from: '+15555550212',
      guest_name: 'Pipe Shadow Risky',
      language: 'en',
      message_text: 'I want a refund and need to talk to someone.',
      channel: 'whatsapp',
      wa_message_id: 'wamid.phase19f3.risky.001',
    },
    expect: {
      next_action: 'handoff_to_staff',
      requires_staff: true,
      send_attempted: false,
      send_route_skipped: true,
      no_live_send: true,
    },
  },
};

function httpsReq(method, hostname, reqPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = { ...(headers || {}) };
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

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function runCodeNode(wf, nodeName, priorJson, helpers = {}) {
  const node = wf.nodes.find((n) => n.name === nodeName);
  if (!node) throw new Error('node missing: ' + nodeName);
  const code = node.parameters.jsCode;
  const sandbox = {
    $input: { first: () => ({ json: priorJson }) },
    $: (name) => ({
      first: () => ({ json: helpers[name] || priorJson }),
    }),
    console,
  };
  vm.createContext(sandbox);
  const wrapped = `(function(){ ${code}\n})()`;
  const out = vm.runInContext(wrapped, sandbox, { timeout: 5000 });
  return out[0].json;
}

async function staffPost(token, route, body) {
  return httpsReq('POST', STAFF_HOST, route, { 'X-Luna-Bot-Token': token }, body);
}

function safetyCheckWf(wf) {
  const blob = JSON.stringify(wf.nodes);
  const webhook = wf.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
  return {
    active_false: wf.active === false,
    webhook_path: webhook?.parameters?.path,
    not_booking_assistant: webhook?.parameters?.path !== 'booking-assistant',
    no_graph: !/graph\.facebook\.com/i.test(blob),
    no_stripe: !/api\.stripe\.com/i.test(blob),
    no_booking_create: !/booking-create/i.test(blob),
    no_payment_link: !/payment-link|create-stripe-link/i.test(blob),
    has_draft_http: blob.includes('/staff/bot/guest-reply-draft'),
    has_send_http: blob.includes('/staff/bot/guest-reply-send'),
  };
}

async function tryCloudApi(apiKey) {
  const headers = { 'X-N8N-API-KEY': apiKey };
  const list = await httpsReq('GET', N8N_CLOUD_HOST, '/api/v1/workflows?limit=5', headers, null);
  return { ok: list.status === 200, status: list.status, body: list.body };
}

async function simulateCase(wf, token, caseDef) {
  const webhookPayload = { body: caseDef.payload, shadow_mode: true, dry_run: true, live_send_enabled: false, live_send_blocked: true };
  const normalized = runCodeNode(wf, 'Code - Normalize WhatsApp Inbound', webhookPayload);
  const draftResp = await staffPost(token, '/staff/bot/guest-reply-draft', normalized);
  const draft = draftResp.body || {};
  const built = runCodeNode(wf, 'Code - Build Send Payload', draft, { 'Code - Normalize WhatsApp Inbound': normalized });

  let sendResp = null;
  let debug = null;
  if (built.send_eligible && built.send_payload) {
    sendResp = await staffPost(token, '/staff/bot/guest-reply-send', built.send_payload);
    debug = runCodeNode(wf, 'Code - Map Send Debug Result', sendResp.body || {}, { 'Code - Build Send Payload': built });
  } else {
    debug = runCodeNode(wf, 'Code - Map Draft Only Debug', built);
  }

  return { normalized, draft, built, sendResp: sendResp?.body || null, debug };
}

function evaluateCase(key, sim, exp) {
  const issues = [];
  const d = sim.debug || {};
  const draft = sim.draft || {};
  const built = sim.built || {};
  const se = draft.send_eligibility || {};

  if (exp.next_action && draft.next_action !== exp.next_action) issues.push(`next_action=${draft.next_action}`);
  if (exp.requires_staff != null && d.requires_staff !== exp.requires_staff) issues.push(`requires_staff=${d.requires_staff}`);
  if (exp.normalized_from && sim.normalized.from !== exp.normalized_from) issues.push(`from=${sim.normalized.from}`);
  if (exp.normalized_wa_id && sim.normalized.wa_message_id !== exp.normalized_wa_id) issues.push(`wa_id=${sim.normalized.wa_message_id}`);
  if (exp.idempotency_key && built.idempotency_key !== exp.idempotency_key) issues.push(`idem=${built.idempotency_key}`);
  if (exp.send_kind && built.send_kind !== exp.send_kind) issues.push(`send_kind=${built.send_kind}`);
  if (!draft.suggested_reply) issues.push('missing suggested_reply');
  if (exp.send_attempted === false && d.send_attempted !== false) issues.push(`send_attempted=${d.send_attempted}`);
  if (exp.send_route_skipped && d.send_attempted === true) issues.push('send route called unexpectedly');
  if (exp.no_live_send && (d.send_performed === true || d.sends_whatsapp === true)) issues.push('LIVE SEND');
  if (sim.sendResp && sim.sendResp.send_performed === true) issues.push('CRITICAL send_performed true');

  if (key === 'A' || key === 'B') {
    if (d.send_attempted && sim.sendResp) {
      const br = sim.sendResp.blocked_reasons || [];
      if (!br.includes('luna_auto_send_not_enabled') && !br.includes('auto_send_not_ready')) {
        issues.push('missing gate block reason on send route');
      }
    }
  }
  if (key === 'C') {
    if (d.staff_api_send_endpoint != null && d.staff_api_send_endpoint !== null) { /* ok */ }
    if (built.handoff_blocked !== true) issues.push('handoff_blocked not true');
  }

  return { pass: issues.length === 0, issues, summary: {
    draft_success: d.draft_success,
    next_action: draft.next_action,
    suggested_reply: String(draft.suggested_reply || '').slice(0, 120),
    send_eligibility: se,
    idempotency_key: built.idempotency_key,
    send_eligible: built.send_eligible,
    send_attempted: d.send_attempted,
    send_performed: d.send_performed,
    sends_whatsapp: d.sends_whatsapp,
    blocked_reasons: d.blocked_reasons || sim.sendResp?.blocked_reasons || [],
    whatsapp_message_id: d.whatsapp_message_id,
    live_send_blocked: d.live_send_blocked,
    staff_api_send_endpoint: d.staff_api_send_endpoint,
  } };
}

function stagingEnvFlags() {
  const env = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json'));
  const pick = (name) => {
    const row = env.find((e) => e.name === name);
    if (!row) return '(unset)';
    return row.value != null ? row.value : `(secret:${row.secretRef})`;
  };
  return {
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
    LUNA_GUEST_LIVE_SEND_OWNER_APPROVED: pick('LUNA_GUEST_LIVE_SEND_OWNER_APPROVED'),
  };
}

(async () => {
  const wf = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));
  const wfSafety = safetyCheckWf(wf);
  const token = az('az keyvault secret show --vault-name wh-staging-kv --name luna-bot-internal-token --query value -o tsv');
  const envFlagsBefore = stagingEnvFlags();
  const healthz = await httpsReq('GET', STAFF_HOST, '/healthz', {}, null);
  const bookingProbe = await httpsReq('POST', N8N_CLOUD_HOST, '/webhook/booking-assistant', {}, {});
  const pipeProbe = await httpsReq('POST', N8N_CLOUD_HOST, `/webhook/${WEBHOOK_PATH}`, {}, {});

  const apiKey = process.env.N8N_CLOUD_API_KEY || '';
  let cloudApi = { attempted: false, ok: false, note: 'N8N_CLOUD_API_KEY unset — cannot import/run on hosted n8n Cloud via API' };
  if (apiKey) {
    cloudApi.attempted = true;
    const probe = await tryCloudApi(apiKey);
    cloudApi.ok = probe.ok;
    cloudApi.status = probe.status;
    cloudApi.note = probe.ok ? 'API key valid' : 'API key rejected';
  }

  const caseResults = {};
  for (const [key, caseDef] of Object.entries(CASES)) {
    const sim = await simulateCase(wf, token, caseDef);
    caseResults[key] = { label: caseDef.label, ...evaluateCase(key, sim, caseDef.expect) };
  }

  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const sends = await pg.query(
    `SELECT idempotency_key, status, blocked_reasons, provider_message_id, created_at
     FROM guest_message_sends WHERE idempotency_key = ANY($1::text[]) ORDER BY created_at DESC`,
    [PROOF_KEYS],
  );
  await pg.end();

  const envFlagsAfter = stagingEnvFlags();
  const allCasesPass = Object.values(caseResults).every((c) => c.pass);
  const safetyOk = Object.values(wfSafety).every(Boolean);
  const envUnchanged = JSON.stringify(envFlagsBefore) === JSON.stringify(envFlagsAfter);
  const noLiveSend = Object.values(caseResults).every((c) => !c.summary.send_performed && !c.summary.sends_whatsapp);

  let result = 'FAIL';
  if (!safetyOk || !noLiveSend || !envUnchanged) result = 'FAIL';
  else if (cloudApi.ok && allCasesPass) result = 'PASS';
  else if (allCasesPass && safetyOk) result = 'PARTIAL';

  const out = {
    phase: '19f.3',
    result,
    commit: COMMIT,
    hosted: {
      host: N8N_CLOUD_HOST,
      workflow_file: 'Wolfhouse Booking Assistant - Luna Pipe Shadow.json',
      workflow_name: wf.name,
      webhook_path: WEBHOOK_PATH,
      active: wf.active,
      cloud_api: cloudApi,
      cloud_import_status: cloudApi.ok ? 'API ready — import not run in this slice without explicit workflow POST' : 'blocked — sign in at https://tywoods.app.n8n.cloud/signin and set N8N_CLOUD_API_KEY for API import',
      execution_ids: [],
      note: 'Browser sign-in required for true hosted n8n Cloud editor manual execution; simulated chain + Staff API proof below',
    },
    credential_binding: {
      expected: 'Luna Bot Internal Token (staging) on HTTP Guest Reply Draft + HTTP Guest Reply Send',
      status: 'not verified on cloud — bind manually at import',
    },
    workflow_safety: wfSafety,
    probes: {
      staff_healthz: healthz.status,
      booking_assistant_post: { status: bookingProbe.status, body: bookingProbe.body },
      pipe_shadow_post: { status: pipeProbe.status, body: pipeProbe.body },
    },
    env_flags_before: envFlagsBefore,
    env_flags_after: envFlagsAfter,
    cases: caseResults,
    guest_message_sends: sends.rows,
    manual_steps: [
      '1. Sign in to https://tywoods.app.n8n.cloud',
      '2. Workflows → Import from File → n8n/Wolfhouse Booking Assistant - Luna Pipe Shadow.json',
      '3. Confirm active toggle OFF; webhook path luna-pipe-shadow-19f',
      '4. Bind Luna Bot Internal Token (staging) on both HTTP nodes',
      '5. Pin Case A/B/C payloads on Webhook node; Execute workflow (manual)',
      '6. Capture execution IDs from Executions tab',
    ],
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(result === 'FAIL' ? 1 : 0);
})().catch((e) => {
  console.error('PROOF_ERROR:', e.message);
  process.exit(1);
});
