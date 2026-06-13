'use strict';
/** Simulate n8n shadow chain after DB import — proves guest-reply-draft path when editor webhook-test unavailable. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const vm = require('vm');
const { Client } = require('pg');
const { execSync } = require('child_process');

const WF_PATH = path.join(__dirname, 'n8n', 'Wolfhouse Booking Assistant - Message Intake Shadow.json');
const WF_ID = 'stage16aIntakeShadow01';
const CRED_ID = 'stage8512LunaBotTok01';
const CRED_NAME = 'Luna Bot Internal Token (staging)';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const WEBHOOK_NODE = 'Webhook - Intake Shadow Trigger';

const CASES = {
  A: {
    label: 'EN complete quote',
    payload: {
      client_slug: 'wolfhouse-somo', channel: 'whatsapp', from: '+15555550180',
      guest_name: 'Draft Shadow EN Complete', language: 'en',
      message_text: 'Hi, we are 2 people and want to come September 24 to September 27. Do you have Malibu? We can pay the deposit.',
    },
    expect: {
      next_action: 'show_quote', dry_run: true, quoteWording: true,
      se: { send_allowed_later: true, requires_staff: false, auto_send_ready: false, allowed_send_kind: 'show_quote' },
    },
  },
  B: {
    label: 'IT partial ask_next',
    payload: {
      client_slug: 'wolfhouse-somo', channel: 'whatsapp', from: '+15555550181',
      guest_name: 'Draft Shadow IT Partial', language: 'it',
      message_text: 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
    },
    expect: {
      next_action: 'ask_missing_field', dry_run: false,
      suggested_equals: 'In quali date vorresti soggiornare?',
      se: { send_allowed_later: true, requires_staff: false, auto_send_ready: false, allowed_send_kind: 'ask_missing_field' },
    },
  },
  C: {
    label: 'refund/handoff',
    payload: {
      client_slug: 'wolfhouse-somo', channel: 'whatsapp', from: '+15555550182',
      guest_name: 'Draft Shadow Handoff', language: 'en',
      message_text: 'I want a refund and need to talk to someone.',
    },
    expect: {
      next_action: 'handoff_to_staff', dry_run: false, safeHandoff: true,
      se: { send_allowed_later: false, requires_staff: true, auto_send_ready: false, staffBlocks: ['handoff_required'] },
    },
  },
};

const PROOF_PHONES = ['+15555550180', '+15555550181', '+15555550182'];
const PROOF_NAMES = ['Draft Shadow EN Complete', 'Draft Shadow IT Partial', 'Draft Shadow Handoff'];

function httpsPost(hostname, reqPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const h = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers };
    const req = https.request({ hostname, path: reqPath, method: 'POST', headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* string */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function runVmCode(code, sandbox) {
  const wrapped = `(function() { ${code} })()`;
  return vm.runInNewContext(wrapped, sandbox, { timeout: 5000 });
}

function runParseNode(wf, inbound) {
  const node = wf.nodes.find((n) => n.name === 'Code - Parse Guest Message');
  const patched = node.parameters.jsCode
    .replace('const body = $input.first().json.body || $input.first().json;', `const body = ${JSON.stringify(inbound)};`);
  const sandbox = { $input: { first: () => ({ json: inbound }) }, console };
  return runVmCode(patched, sandbox)[0].json;
}

function runMapNode(wf, api, parsed) {
  const node = wf.nodes.find((n) => n.name === 'Code - Map Draft Shadow Response');
  const sandbox = {
    $input: { first: () => ({ json: api }) },
    $: (name) => {
      if (name === 'Code - Parse Guest Message') return { first: () => ({ json: parsed }) };
      throw new Error(`unknown node ${name}`);
    },
    console,
  };
  return runVmCode(node.parameters.jsCode, sandbox)[0].json;
}

function evaluate(out, exp) {
  const se = out?.send_eligibility || {};
  const reply = String(out?.suggested_reply || '');
  const issues = [];
  if (out?.next_action !== exp.next_action) issues.push(`next_action=${out?.next_action}`);
  if (exp.dry_run && !out?.dry_run_plan) issues.push('dry_run_plan missing');
  if (exp.dry_run === false && out?.dry_run_plan) issues.push('dry_run_plan should be null');
  if (exp.quoteWording && !/total|deposit|€|EUR|270/i.test(reply)) issues.push('quote wording');
  if (exp.suggested_equals && reply !== exp.suggested_equals) issues.push('suggested_reply mismatch');
  if (exp.safeHandoff && /refund approved|we will refund/i.test(reply)) issues.push('unsafe handoff');
  if (!out?.send_eligibility) issues.push('send_eligibility missing');
  for (const [k, v] of Object.entries(exp.se)) {
    if (k === 'staffBlocks') {
      if (!v.some((r) => se.blocked_reasons?.includes(r))) issues.push('missing staff block');
    } else if (se[k] !== v) issues.push(`se.${k}=${se[k]}`);
  }
  if (out?.whatsapp_sent !== false) issues.push('whatsapp_sent');
  if (out?.live_send_blocked !== true) issues.push('live_send_blocked');
  if (se.auto_send_ready === true) issues.push('CRITICAL auto_send_ready');
  for (const f of ['creates_booking', 'creates_payment', 'creates_stripe_link', 'sends_whatsapp', 'calls_n8n']) {
    if (out?.[f] === true || se[f] === true) issues.push(`${f} true`);
  }
  return { pass: issues.length === 0, issues };
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
     JOIN guests g ON g.id = b.guest_id WHERE g.full_name IN (${nameList}) OR g.phone IN (${phoneList})`,
  );
  return { bookings: bookings.rows[0].n, payments: payments.rows[0].n };
}

(async () => {
  const wf = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));
  const nodes = wf.nodes.map((n) => (
    n.type === 'n8n-nodes-base.httpRequest'
      ? { ...n, credentials: { httpHeaderAuth: { id: CRED_ID, name: CRED_NAME } } }
      : n
  ));
  const httpNode = nodes.find((n) => n.name === 'HTTP - Guest Reply Draft');

  const n8nUrl = execSync('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const whUrl = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const token = execSync('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv', { encoding: 'utf8' }).trim();

  const n8n = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
  const wh = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await n8n.connect();
  await wh.connect();

  const wfBefore = await n8n.query('SELECT id, name, active FROM workflow_entity WHERE id = $1', [WF_ID]);
  await n8n.query(
    `UPDATE workflow_entity SET active = false, nodes = $2::json, connections = $3::json, "versionId" = $4, "updatedAt" = NOW() WHERE id = $1`,
    [WF_ID, JSON.stringify(nodes), JSON.stringify(wf.connections), crypto.randomUUID()],
  );
  const wfAfterImport = await n8n.query('SELECT id, name, active, nodes FROM workflow_entity WHERE id = $1', [WF_ID]);
  const credRow = await n8n.query('SELECT id, name FROM credentials_entity WHERE id = $1', [CRED_ID]);

  const dbBefore = await dbCounts(wh);
  const cases = {};

  for (const [key, def] of Object.entries(CASES)) {
    const parsed = runParseNode({ nodes }, def.payload);
    const staff = await httpsPost(STAFF_HOST, '/staff/bot/guest-reply-draft', {
      'X-Luna-Bot-Token': token, Accept: 'application/json',
    }, parsed);
    const mapped = staff.body ? runMapNode({ nodes }, staff.body, parsed) : null;
    const evalResult = evaluate(mapped, def.expect);
    cases[key] = {
      label: def.label,
      staff_http: staff.status,
      pass: evalResult.pass,
      issues: evalResult.issues,
      summary: {
        staff_api_endpoint: mapped?.staff_api_endpoint,
        next_action: mapped?.next_action,
        suggested_reply: String(mapped?.suggested_reply || '').slice(0, 140),
        dry_run_plan_present: mapped?.dry_run_plan != null,
        send_eligibility: mapped?.send_eligibility,
        whatsapp_sent: mapped?.whatsapp_sent,
        live_send_blocked: mapped?.live_send_blocked,
      },
      note: 'Simulated n8n chain: Parse Guest Message -> HTTP Guest Reply Draft -> Map Draft Shadow Response (webhook-test requires editor Execute click)',
    };
  }

  const dbAfter = await dbCounts(wh);
  const wfAfter = await n8n.query('SELECT id, name, active FROM workflow_entity WHERE id = $1', [WF_ID]);
  await n8n.end();
  await wh.end();

  const revision = JSON.parse(execSync('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json', { encoding: 'utf8' }))
    .find((x) => x.properties.trafficWeight === 100);

  const allPass = Object.values(cases).every((c) => c.pass);
  const result = allPass && dbBefore.bookings === 0 && dbAfter.bookings === 0 && wfAfter.rows[0]?.active === false
    ? 'PASS' : 'PARTIAL';

  console.log(JSON.stringify({
    phase: '18e.1',
    result,
    proof_mode: 'db_import + simulated_manual_chain (webhook-test unregistered without editor Execute click)',
    commit: 'c57523e',
    staff_api: {
      name: revision?.name,
      image: revision?.properties?.template?.containers?.[0]?.image,
      health: revision?.properties?.healthState,
    },
    workflow: {
      id: WF_ID,
      name: wfAfter.rows[0]?.name,
      active_before: wfBefore.rows[0]?.active,
      active_after: wfAfter.rows[0]?.active,
      credential_bound: credRow.rows[0]?.name === CRED_NAME,
      http_node_url: httpNode?.parameters?.url,
    },
    execution_ids: [],
    cases,
    db_before: dbBefore,
    db_after: dbAfter,
    webhook_test_blocker: 'n8n returns 404 — Execute workflow must be clicked in editor to register test webhook listener',
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
