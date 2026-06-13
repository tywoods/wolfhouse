'use strict';
/**
 * Phase 12g — import updated dry-run workflow + pin from-only payload (staging)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { execSync } = require('child_process');

const WF_PATH = path.join(__dirname, 'n8n', 'Wolfhouse Booking Assistant - Main - Shared Engine Dry Run.json');
const WF_ID = 'stage8510SharedDryRun01';
const CRED_ID = 'stage8512LunaBotTok01';
const CRED_NAME = 'Luna Bot Internal Token (staging)';
const WEBHOOK_NODE = 'Webhook - Dry Run Trigger';

const PAYLOAD = {
  client_slug: 'wolfhouse-somo',
  channel: 'whatsapp',
  from: '+15555550123',
  guest_name: 'Test From Mapping',
  language: 'en',
  message_text: 'Hi, I want to stay June 15 to June 22 for 2 people. What packages are available?',
  check_in: '2026-06-15',
  check_out: '2026-06-22',
  guests: 2,
  package_code: 'malibu',
};

function bindCredentials(nodes) {
  return nodes.map((n) => {
    if (n.type !== 'n8n-nodes-base.httpRequest') return n;
    return { ...n, credentials: { httpHeaderAuth: { id: CRED_ID, name: CRED_NAME } } };
  });
}

(async () => {
  const wf = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));
  const parseNode = wf.nodes.find((n) => (n.name || '').includes('Parse Booking Fields'));
  const parseCode = parseNode?.parameters?.jsCode || '';
  if (!parseCode.includes('body.from')) {
    throw new Error('BLOCKER: workflow JSON missing body.from phone fallback (expected 74dbdcb)');
  }

  const url = process.env.N8N_DATABASE_URL || execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();

  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const before = await c.query('SELECT id, name, active FROM workflow_entity WHERE id = $1', [WF_ID]);
  const cred = await c.query('SELECT id, name FROM credentials_entity WHERE id = $1', [CRED_ID]);

  const nodes = bindCredentials(wf.nodes);
  const pinData = { [WEBHOOK_NODE]: [{ json: PAYLOAD }] };
  const versionId = crypto.randomUUID();
  const now = new Date();

  await c.query(
    `UPDATE workflow_entity SET
      name = $2, active = $3, nodes = $4::json, connections = $5::json, settings = $6::json,
      "pinData" = $7::json, "versionId" = $8, meta = $9::json, "updatedAt" = $10
     WHERE id = $1`,
    [WF_ID, wf.name, false, JSON.stringify(nodes), JSON.stringify(wf.connections),
      JSON.stringify(wf.settings || {}), JSON.stringify(pinData), versionId,
      JSON.stringify(wf.meta || {}), now],
  );

  const after = await c.query('SELECT id, name, active FROM workflow_entity WHERE id = $1', [WF_ID]);
  await c.end();

  console.log(JSON.stringify({
    import: 'ok',
    commit_expected: '74dbdcb',
    workflow_id: WF_ID,
    active_before: before.rows[0]?.active,
    active_after: after.rows[0]?.active,
    credential: cred.rows[0] || null,
    pin_payload: PAYLOAD,
    parse_has_from: true,
    n8n_url: 'https://wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io/workflow/stage8510SharedDryRun01',
    next: 'Run editor manual test execution (Execute workflow)',
  }, null, 2));
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
