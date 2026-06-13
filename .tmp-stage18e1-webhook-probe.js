'use strict';
const crypto = require('crypto');
const https = require('https');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WF_ID = 'stage16aIntakeShadow01';
const CRED_ID = 'stage8512LunaBotTok01';
const CRED_NAME = 'Luna Bot Internal Token (staging)';
const N8N_HOST = 'wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io';
const WEBHOOK_NODE = 'Webhook - Intake Shadow Trigger';
const WEBHOOK_PATH = 'luna-message-intake-shadow-16a';

function req(method, hostname, reqPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...(headers || {}) };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const r = https.request({ hostname, path: reqPath, method, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* string */ }
        resolve({ status: res.statusCode, body: parsed, raw: buf.slice(0, 600) });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function importAndRun(c, payload) {
  const wf = JSON.parse(fs.readFileSync(path.join(__dirname, 'n8n', 'Wolfhouse Booking Assistant - Message Intake Shadow.json'), 'utf8'));
  const nodes = wf.nodes.map((n) => (
    n.type === 'n8n-nodes-base.httpRequest'
      ? { ...n, credentials: { httpHeaderAuth: { id: CRED_ID, name: CRED_NAME } } }
      : n
  ));
  await c.query(
    `UPDATE workflow_entity SET active = false, nodes = $2::json, connections = $3::json,
      "pinData" = $4::json, "versionId" = $5, "updatedAt" = NOW() WHERE id = $1`,
    [WF_ID, JSON.stringify(nodes), JSON.stringify(wf.connections),
      JSON.stringify({ [WEBHOOK_NODE]: [{ json: payload }] }), crypto.randomUUID()],
  );

  const attempts = [];
  for (const p of [`/webhook-test/${WEBHOOK_PATH}`, `/webhook-test/${WF_ID}/${WEBHOOK_PATH}`]) {
    const r = await req('POST', N8N_HOST, p, {}, payload);
    attempts.push({ path: p, status: r.status, raw: r.raw, body: r.body });
  }
  await new Promise((x) => setTimeout(x, 15000));

  const ex = await c.query(
    `SELECT id, status, mode, "startedAt" FROM execution_entity
     WHERE "workflowId" = $1 ORDER BY "startedAt" DESC LIMIT 1`,
    [WF_ID],
  );
  const execRow = ex.rows[0];
  let out = null;
  let http = null;
  let nodesRun = [];
  let err = null;
  if (execRow) {
    const data = await c.query('SELECT data FROM execution_data WHERE "executionId" = $1', [execRow.id]);
    let parsed = null;
    try {
      const { parse } = require('flatted');
      parsed = parse(data.rows[0]?.data);
    } catch {
      try { parsed = JSON.parse(data.rows[0]?.data); } catch { parsed = null; }
    }
    const rd = parsed?.resultData?.runData || {};
    nodesRun = Object.keys(rd);
    http = rd['HTTP - Guest Reply Draft']?.[0]?.data?.main?.[0]?.[0]?.json || null;
    out = rd['Respond - Draft Shadow Result']?.[0]?.data?.main?.[0]?.[0]?.json
      || rd['Code - Map Draft Shadow Response']?.[0]?.data?.main?.[0]?.[0]?.json
      || null;
    err = parsed?.resultData?.error?.message || null;
  }
  return { attempts, execRow, out, http, nodesRun, err };
}

const CASES = {
  A: {
    client_slug: 'wolfhouse-somo', channel: 'whatsapp', from: '+15555550180',
    guest_name: 'Draft Shadow EN Complete', language: 'en',
    message_text: 'Hi, we are 2 people and want to come September 24 to September 27. Do you have Malibu? We can pay the deposit.',
  },
  B: {
    client_slug: 'wolfhouse-somo', channel: 'whatsapp', from: '+15555550181',
    guest_name: 'Draft Shadow IT Partial', language: 'it',
    message_text: 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
  },
  C: {
    client_slug: 'wolfhouse-somo', channel: 'whatsapp', from: '+15555550182',
    guest_name: 'Draft Shadow Handoff', language: 'en',
    message_text: 'I want a refund and need to talk to someone.',
  },
};

(async () => {
  const n8nUrl = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const c = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const results = {};
  for (const [key, payload] of Object.entries(CASES)) {
    results[key] = await importAndRun(c, payload);
  }
  const wf = await c.query('SELECT id, name, active FROM workflow_entity WHERE id = $1', [WF_ID]);
  await c.end();
  console.log(JSON.stringify({ workflow: wf.rows[0], results }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
