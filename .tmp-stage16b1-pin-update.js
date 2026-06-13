'use strict';
const crypto = require('crypto');
const { Client } = require('pg');
const { execSync } = require('child_process');

const WF_ID = 'stage16aIntakeShadow01';
const WEBHOOK_NODE = 'Webhook - Intake Shadow Trigger';
const CASE = process.argv[2] || 'A';

const CASES = {
  A: {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550160',
    guest_name: 'Shadow Intake EN Complete',
    language: 'en',
    message_text: 'Hi, we are 2 people and want to come September 24 to September 27. Do you have Malibu? We can pay the deposit.',
  },
  B: {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550161',
    guest_name: 'Shadow Intake IT Partial',
    language: 'it',
    message_text: 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
  },
  C: {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550162',
    guest_name: 'Shadow Intake Handoff',
    language: 'en',
    message_text: 'I want a refund and need to talk to someone.',
  },
  ES: {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550170',
    guest_name: 'Shadow Intake ES Native',
    language: 'es',
    message_text: 'Somos dos personas del 24 de septiembre al 27 de septiembre. Queremos Malibu y pagar el depósito.',
  },
  DE: {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550171',
    guest_name: 'Shadow Intake DE Native',
    language: 'de',
    message_text: 'Wir sind drei Personen vom 24. September bis 27. September. Wir möchten Malibu und die Anzahlung zahlen.',
  },
};

(async () => {
  const payload = CASES[CASE];
  if (!payload) throw new Error('unknown case ' + CASE);

  const url = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const pinData = { [WEBHOOK_NODE]: [{ json: payload }] };
  const versionId = crypto.randomUUID();
  await c.query(
    `UPDATE workflow_entity SET "pinData" = $2::json, "versionId" = $3, "updatedAt" = NOW() WHERE id = $1`,
    [WF_ID, JSON.stringify(pinData), versionId],
  );

  const wf = await c.query('SELECT id, name, active FROM workflow_entity WHERE id = $1', [WF_ID]);
  await c.end();
  console.log(JSON.stringify({ case: CASE, pinned: payload, workflow: wf.rows[0] }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
