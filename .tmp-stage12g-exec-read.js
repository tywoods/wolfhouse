'use strict';
const { parse } = require('flatted');
const { Client } = require('pg');
const { execSync } = require('child_process');

const WF_ID = 'stage8510SharedDryRun01';
const EXPECT_PHONE = '+15555550123';
const DEFAULT_PHONE = '+34999000000';

(async () => {
  const url = process.env.N8N_DATABASE_URL || execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const wf = await c.query('SELECT active FROM workflow_entity WHERE id = $1', [WF_ID]);
  const ex = await c.query(
    `SELECT id, status, mode, "startedAt", "stoppedAt"
     FROM execution_entity WHERE "workflowId" = $1 ORDER BY "startedAt" DESC LIMIT 1`,
    [WF_ID],
  );
  const row = ex.rows[0];
  if (!row) throw new Error('no execution found');

  const data = await c.query('SELECT data FROM execution_data WHERE "executionId" = $1', [row.id]);
  const parsed = parse(data.rows[0].data);
  const rd = parsed?.resultData?.runData || {};
  const nodes = Object.keys(rd);

  const parseOut = rd['Code - Parse Booking Fields']?.[0]?.data?.main?.[0]?.[0]?.json;
  const httpOut = rd['HTTP - Bot Booking Dry Run']?.[0]?.data?.main?.[0]?.[0]?.json;
  const respond = rd['Respond - DryRun Result']?.[0]?.data?.main?.[0]?.[0]?.json
    || rd['Code - Map Dry Run Response']?.[0]?.data?.main?.[0]?.[0]?.json;

  const out = respond || {};
  const flags = {
    dry_run: out.dry_run === true,
    preview_only: out.preview_only === true,
    no_write_performed: out.no_write_performed === true,
    creates_booking: out.creates_booking === false,
    creates_payment: out.creates_payment === false,
    creates_stripe_link: out.creates_stripe_link === false,
    sends_whatsapp: out.sends_whatsapp === false,
    calls_n8n: out.calls_n8n === false,
    whatsapp_sent: out.whatsapp_sent === false,
  };
  const allFlags = Object.values(flags).every(Boolean);
  const phoneOk = parseOut?.phone === EXPECT_PHONE && parseOut?.guest_phone === EXPECT_PHONE;
  const notDefault = parseOut?.phone !== DEFAULT_PHONE;

  const verdict = row.status === 'success' && phoneOk && notDefault && allFlags && wf.rows[0]?.active === false
    ? 'PASS' : (parseOut?.phone ? 'PARTIAL' : 'FAIL');

  console.log(JSON.stringify({
    verdict,
    workflow_active_before_after: wf.rows[0]?.active,
    execution_id: row.id,
    execution_status: row.status,
    execution_mode: row.mode,
    nodes_executed: nodes,
    parsed_phone: parseOut?.phone,
    parsed_guest_phone: parseOut?.guest_phone,
    expected_phone: EXPECT_PHONE,
    default_phone_not_used: notDefault,
    staff_api_route: out.staff_api_endpoint || '/staff/bot/booking-dry-run',
    http_success: httpOut?.success,
    http_dry_run: httpOut?.dry_run,
    response_safety_flags: flags,
    reply_draft_summary: (out.reply_draft || '').slice(0, 220),
    planned_actions: out.planned_actions,
    next_action: out.next_action,
    error: parsed?.resultData?.error || null,
  }, null, 2));

  await c.end();
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
