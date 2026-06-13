'use strict';
const { parse } = require('flatted');
const { Client } = require('pg');
const { execSync } = require('child_process');

const WF_ID = 'stage16aIntakeShadow01';
const PROOF_PHONES = ['+15555550160', '+15555550161', '+15555550162', '+15555550170', '+15555550171'];
const PROOF_NAMES = [
  'Shadow Intake EN Complete', 'Shadow Intake IT Partial', 'Shadow Intake Handoff',
  'Shadow Intake ES Native', 'Shadow Intake DE Native',
  'Hosted Intake ES Native', 'Hosted Intake DE Native',
];

function extractOut(rd) {
  return rd['Respond - Intake Shadow Result']?.[0]?.data?.main?.[0]?.[0]?.json
    || rd['Code - Map Intake Shadow Response']?.[0]?.data?.main?.[0]?.[0]?.json
    || null;
}

function extractHttp(rd) {
  return rd['HTTP - Message Intake Preview']?.[0]?.data?.main?.[0]?.[0]?.json || null;
}

(async () => {
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

  const revision = JSON.parse(execSync(
    'az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' },
  )).find((x) => x.properties.trafficWeight === 100);

  const wf = await n8n.query('SELECT id, name, active FROM workflow_entity WHERE id = $1', [WF_ID]);
  const ex = await n8n.query(
    `SELECT id, status, mode, "startedAt", "stoppedAt" FROM execution_entity
     WHERE "workflowId" = $1 ORDER BY "startedAt" DESC LIMIT 5`,
    [WF_ID],
  );

  const phoneList = PROOF_PHONES.map((p) => `'${p}'`).join(',');
  const nameList = PROOF_NAMES.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
  const bookings = await wh.query(
    `SELECT COUNT(*)::int AS n FROM bookings b JOIN guests g ON g.id = b.guest_id
     WHERE g.full_name IN (${nameList}) OR g.phone IN (${phoneList})`,
  );
  const payments = await wh.query(
    `SELECT COUNT(*)::int AS n FROM payments p JOIN bookings b ON b.id = p.booking_id
     JOIN guests g ON g.id = b.guest_id
     WHERE g.full_name IN (${nameList}) OR g.phone IN (${phoneList})`,
  );

  const results = [];
  for (const row of ex.rows) {
    const data = await n8n.query('SELECT data FROM execution_data WHERE "executionId" = $1', [row.id]);
    const raw = data.rows[0]?.data;
    let parsed = null;
    try {
      parsed = typeof raw === 'string' ? parse(raw) : raw;
    } catch {
      try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { parsed = null; }
    }
    const rd = parsed?.resultData?.runData || {};
    const out = extractOut(rd);
    const http = extractHttp(rd);
    results.push({
      execution_id: row.id,
      status: row.status,
      mode: row.mode,
      startedAt: row.startedAt,
      output: out,
      http_success: http?.success,
      http_preview_only: http?.preview_only,
      http_can_chain: http?.validation?.can_chain_dry_run,
      nodes: Object.keys(rd),
      error: parsed?.resultData?.error?.message || null,
    });
  }

  await n8n.end();
  await wh.end();

  console.log(JSON.stringify({
    staff_api: {
      name: revision?.name,
      image: revision?.properties?.template?.containers?.[0]?.image,
      health: revision?.properties?.healthState,
    },
    workflow: wf.rows[0],
    executions: results,
    db_counts: { bookings: bookings.rows[0].n, payments: payments.rows[0].n },
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
