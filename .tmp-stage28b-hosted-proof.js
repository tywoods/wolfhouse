'use strict';
/** Stage 28b — real-phone review-only rehearsal (Mode A). Temp — do not commit. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const N8N_HOST = 'wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io';
const WF_PATH = path.join(__dirname, 'n8n', 'Luna Open Demo WhatsApp Inbound Review Pipe.json');
const WF_ID = 'stage27demoJReview01';
const WF_NAME = 'Luna Open Demo WhatsApp Inbound Review Pipe';
const WEBHOOK_PATH = 'open-demo-whatsapp-inbound-review-27j';
const WEBHOOK_ID = 'a27demoj-0027-4000-8000-000000000027';
const WEBHOOK_NODE = 'Webhook - Open Demo WhatsApp Inbound';
const CRED_ID = 'stage8512LunaBotTok01';
const CRED_NAME = 'Luna Bot Internal Token (staging)';
const DEMO_PHONE_ID = '1152900101233109';
const DEMO_WA_DISPLAY = '+34 663 43 94 19';

const SESSION_BRIEF = {
  ale_phone_e164: 'NOT_RECORDED — owner to confirm before next rehearsal',
  cami_phone_e164: 'NOT_RECORDED — owner to confirm before next rehearsal',
  test_phones_this_run: ['+34600995557'],
  rationale: '27demo-l anchor phone; staging rehearsal stand-in until Ale/Cami numbers confirmed',
};

const SCRIPTED_MESSAGES = [
  'Hi, we are 2 people interested in the Malibu package',
  'October 12 to October 19',
  'Deposit is fine',
];

const REVIEW_ENV = {
  WHATSAPP_DRY_RUN: 'true',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'false',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_ID,
};

const GATE_NAMES = [
  ...Object.keys(REVIEW_ENV),
  'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST',
];

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    image: a.properties?.template?.containers?.[0]?.image,
  };
}

function envPick(names) {
  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const out = {};
  for (const n of names) {
    const e = env.find((x) => x.name === n);
    out[n] = e ? (e.secretRef ? `(secret:${e.secretRef})` : e.value) : null;
  }
  return out;
}

function setEnvVars(pairs) {
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--set-env-vars ${Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join(' ')}`,
    '-o none',
  ].join(' '));
}

function bindCredentials(nodes) {
  return nodes.map((n) => {
    if (n.type !== 'n8n-nodes-base.httpRequest') return n;
    return { ...n, credentials: { httpHeaderAuth: { id: CRED_ID, name: CRED_NAME } } };
  });
}

function restartN8n() {
  for (const app of ['wh-staging-n8n-main', 'wh-staging-n8n-worker']) {
    const rev = az(`az containerapp revision list --name ${app} --resource-group wh-staging-rg --query "[?properties.trafficWeight==\`100\`].name" -o tsv`);
    if (rev) az(`az containerapp revision restart --name ${app} --resource-group wh-staging-rg --revision ${rev}`);
  }
}

function httpsReq(hostname, reqPath, body) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({ hostname, path: reqPath, method: 'POST', headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function buildMeta(phone, text, contactName) {
  const wamid = `wamid.HBg${phone.replace(/\D/g, '').slice(-12)}FQIAEh${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const from = phone.replace(/^\+/, '');
  return {
    payload: {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '34663439419',
              phone_number_id: DEMO_PHONE_ID,
            },
            contacts: [{ profile: { name: contactName }, wa_id: from }],
            messages: [{
              from,
              id: wamid,
              timestamp: String(Math.floor(Date.now() / 1000)),
              type: 'text',
              text: { body: text },
            }],
          },
          field: 'messages',
        }],
      }],
    },
    wamid,
  };
}

async function activateWorkflow(nc) {
  const wf = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));
  const nodes = bindCredentials(wf.nodes);
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const existing = await nc.query('SELECT id FROM workflow_entity WHERE id = $1', [WF_ID]);
  if (!existing.rows.length) {
    await nc.query(
      `INSERT INTO workflow_entity (
        id, name, active, nodes, connections, settings, "versionId", "activeVersionId",
        "versionCounter", "createdAt", "updatedAt"
      ) VALUES ($1,$2,false,$3::json,$4::json,$5::json,$6,$6,1,$7,$7)`,
      [WF_ID, wf.name, JSON.stringify(nodes), JSON.stringify(wf.connections),
        JSON.stringify(wf.settings || {}), versionId, now],
    );
  }
  await nc.query(
    `INSERT INTO workflow_history (
      "versionId", "workflowId", authors, "createdAt", "updatedAt", nodes, connections, name, autosaved, description, "nodeGroups"
    ) VALUES ($1::varchar, $2::varchar, $3, $4::timestamptz, $4::timestamptz, $5::json, $6::json, $7, false, $8, $9::json)`,
    [versionId, WF_ID, 'stage28b-proof', now, JSON.stringify(nodes),
      JSON.stringify(wf.connections), wf.name, wf.meta?.description || wf.name, JSON.stringify([])],
  );
  await nc.query(
    `UPDATE workflow_entity SET
      nodes = $2::json, active = true, "versionId" = $3::varchar, "activeVersionId" = $3::varchar,
      "versionCounter" = COALESCE("versionCounter", 0) + 1, "updatedAt" = $4::timestamptz
     WHERE id = $1::varchar`,
    [WF_ID, JSON.stringify(nodes), versionId, now],
  );
  await nc.query('DELETE FROM workflow_published_version WHERE "workflowId" = $1', [WF_ID]);
  await nc.query(
    `INSERT INTO workflow_published_version ("workflowId", "publishedVersionId", "createdAt", "updatedAt")
     VALUES ($1::varchar, $2::varchar, $3::timestamptz, $3::timestamptz)`,
    [WF_ID, versionId, now],
  );
  await nc.query('DELETE FROM webhook_entity WHERE "workflowId" = $1', [WF_ID]);
  await nc.query(
    `INSERT INTO webhook_entity ("webhookPath", method, node, "webhookId", "pathLength", "workflowId")
     VALUES ($1, 'POST', $2, $3, $4, $5)`,
    [WEBHOOK_PATH, WEBHOOK_NODE, WEBHOOK_ID, WEBHOOK_PATH.length, WF_ID],
  );
  return versionId;
}

async function deactivateWorkflow(nc) {
  await nc.query('DELETE FROM webhook_entity WHERE "workflowId" = $1', [WF_ID]);
  await nc.query('DELETE FROM workflow_published_version WHERE "workflowId" = $1', [WF_ID]);
  await nc.query(
    'UPDATE workflow_entity SET active = false, "activeVersionId" = NULL, "updatedAt" = NOW() WHERE id = $1',
    [WF_ID],
  );
}

async function runN8nWebhook(metaPayload) {
  const paths = [`/webhook/${WEBHOOK_PATH}`, `/webhook-test/${WEBHOOK_PATH}`];
  for (const p of paths) {
    const r = await httpsReq(N8N_HOST, p, metaPayload);
    if (r.status >= 200 && r.status < 300 && r.body && typeof r.body === 'object'
      && (r.body.staff_api_success != null || r.body.proposed_luna_reply_preview)) {
      return { ok: true, path: p, status: r.status, body: r.body };
    }
  }
  const fallback = await httpsReq(N8N_HOST, `/webhook/${WEBHOOK_PATH}`, metaPayload);
  return { ok: false, path: `/webhook/${WEBHOOK_PATH}`, status: fallback.status, body: fallback.body };
}

async function dbSnapshot(pg, phone, proofStart) {
  const conv = await pg.query(`
    SELECT c.id::text, c.phone, c.last_message_preview,
           LEFT(c.staff_reply_draft, 400) AS staff_reply_draft_preview,
           c.metadata, c.updated_at::text
      FROM conversations c
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = 'wolfhouse-somo' AND c.phone = $1
     ORDER BY c.updated_at DESC LIMIT 1`, [phone]);

  const msgs = await pg.query(`
    SELECT m.id::text, m.direction::text AS direction, LEFT(m.message_text, 120) AS body_preview,
           m.created_at::text, m.metadata->>'wamid' AS wamid
      FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = 'wolfhouse-somo' AND c.phone = $1
       AND m.created_at >= $2::timestamptz
     ORDER BY m.created_at ASC`, [phone, proofStart]);

  const bookings = await pg.query(`
    SELECT b.booking_code, b.status::text, b.created_at::text
      FROM bookings b
     INNER JOIN clients cl ON cl.id = b.client_id
     WHERE cl.slug = 'wolfhouse-somo' AND b.phone = $1
       AND b.created_at >= $2::timestamptz`, [phone, proofStart]);

  const pays = await pg.query(`
    SELECT p.id::text, p.status::text
      FROM payments p
     INNER JOIN bookings b ON b.id = p.booking_id
     INNER JOIN clients cl ON cl.id = b.client_id
     WHERE cl.slug = 'wolfhouse-somo' AND b.phone = $1
       AND p.created_at >= $2::timestamptz`, [phone, proofStart]);

  const beds = await pg.query(`
    SELECT bb.bed_code
      FROM booking_beds bb
     INNER JOIN bookings b ON b.id = bb.booking_id
     INNER JOIN clients cl ON cl.id = b.client_id
     WHERE cl.slug = 'wolfhouse-somo' AND b.phone = $1
       AND bb.created_at >= $2::timestamptz`, [phone, proofStart]);

  const sends = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends
      WHERE to_phone = $1 AND created_at >= $2::timestamptz`, [phone, proofStart],
  );

  const confirm = await pg.query(`
    SELECT b.confirmation_sent_at::text
      FROM bookings b
     INNER JOIN clients cl ON cl.id = b.client_id
     WHERE cl.slug = 'wolfhouse-somo' AND b.phone = $1
       AND b.confirmation_sent_at >= $2::timestamptz`, [phone, proofStart]);

  return {
    conversation: conv.rows[0] || null,
    messages_since_proof: msgs.rows,
    inbound_count: msgs.rows.filter((m) => m.direction === 'inbound').length,
    bookings_since_proof: bookings.rows,
    payments_since_proof: pays.rows,
    beds_since_proof: beds.rows,
    guest_message_sends: sends.rows[0].n,
    confirmation_sent_since_proof: confirm.rows.length,
  };
}

(async () => {
  const proofStart = new Date().toISOString();
  const phone = SESSION_BRIEF.test_phones_this_run[0];
  const out = {
    stage: '28b',
    mode: 'A-review-only',
    session_brief: SESSION_BRIEF,
    demo_whatsapp_number: DEMO_WA_DISPLAY,
    demo_phone_number_id: DEMO_PHONE_ID,
    proof_start: proofStart,
    deploy_needed: false,
    scripted_messages: SCRIPTED_MESSAGES,
  };

  let nc;
  let pg;
  try {
    out.healthz = Number(execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${HOST}/healthz`, { encoding: 'utf8' }).trim());
    out.revision = activeRevision();
    out.gates_before = envPick(GATE_NAMES);

    console.error('[env] Mode A review gates...');
    setEnvVars(REVIEW_ENV);
    execSync('powershell -Command "Start-Sleep -Seconds 15"');
    out.gates_during = envPick(GATE_NAMES);

    const n8nDbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv');
    nc = new Client({ connectionString: n8nDbUrl, ssl: { rejectUnauthorized: false } });
    await nc.connect();

    console.error('[n8n] activate review workflow...');
    out.n8n_version_id = await activateWorkflow(nc);
    restartN8n();
    console.error('[n8n] wait 60s...');
    await new Promise((r) => setTimeout(r, 60000));

    const wfRow = await nc.query('SELECT id, name, active FROM workflow_entity WHERE id = $1', [WF_ID]);
    out.n8n_workflow_during = wfRow.rows[0];

    out.turns = [];
    for (let i = 0; i < SCRIPTED_MESSAGES.length; i++) {
      const text = SCRIPTED_MESSAGES[i];
      const { payload, wamid } = buildMeta(phone, text, 'Stage28b Rehearsal Guest');
      console.error(`[n8n] turn ${i + 1}: ${text.slice(0, 40)}...`);
      const pipe = await runN8nWebhook(payload);
      out.turns.push({
        turn: i + 1,
        message_text: text,
        wamid,
        pipe_ok: pipe.ok,
        http_status: pipe.status,
        path: pipe.path,
        staff_api_status: pipe.body?.staff_api_status,
        staff_api_success: pipe.body?.staff_api_success,
        sends_whatsapp: pipe.body?.sends_whatsapp,
        live_send_blocked: pipe.body?.live_send_blocked,
        no_write_performed: pipe.body?.no_write_performed,
        proposed_luna_reply_preview: (pipe.body?.proposed_luna_reply_preview || '').slice(0, 300),
        conversation_id: pipe.body?.conversation_id,
      });
      await new Promise((r) => setTimeout(r, 1500));
    }

    const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
    pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await pg.connect();
    out.db = await dbSnapshot(pg, phone, proofStart);
    await pg.end();
    pg = null;

    console.error('[n8n] deactivate + clear webhook_entity...');
    await deactivateWorkflow(nc);
    const wfAfter = await nc.query('SELECT id, name, active FROM workflow_entity WHERE id = $1', [WF_ID]);
    const hooksAfter = await nc.query('SELECT COUNT(*)::int AS n FROM webhook_entity WHERE "workflowId" = $1', [WF_ID]);
    out.n8n_workflow_after = { ...wfAfter.rows[0], webhook_entity_rows: hooksAfter.rows[0].n };
    await nc.end();
    nc = null;

    out.gates_after = envPick(GATE_NAMES);

    const lastTurn = out.turns[out.turns.length - 1] || {};
    const draft = out.db.conversation?.staff_reply_draft_preview || lastTurn.proposed_luna_reply_preview || '';
    const allPipesOk = out.turns.every((t) => t.pipe_ok && t.staff_api_success !== false);
    const malibuMention = /malibu|october|deposit|package/i.test(draft)
      || out.turns.some((t) => /malibu|october|deposit/i.test(t.proposed_luna_reply_preview || ''));

    out.checks = {
      healthz_200: out.healthz === 200,
      mode_a_gates: out.gates_during.WHATSAPP_DRY_RUN === 'true'
        && out.gates_during.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'false'
        && out.gates_during.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'false'
        && out.gates_during.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'false'
        && !out.gates_during.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST,
      n8n_active_during: out.n8n_workflow_during?.active === true,
      n8n_inactive_after: out.n8n_workflow_after?.active === false,
      webhook_cleared: out.n8n_workflow_after?.webhook_entity_rows === 0,
      all_n8n_pipes_ok: allPipesOk,
      conversation_present: !!out.db.conversation,
      inbound_messages_logged: out.db.inbound_count >= SCRIPTED_MESSAGES.length,
      luna_review_draft: draft.length > 20,
      intake_signals: malibuMention,
      no_booking: out.db.bookings_since_proof.length === 0,
      no_payment: out.db.payments_since_proof.length === 0,
      no_beds: out.db.beds_since_proof.length === 0,
      no_guest_sends: out.db.guest_message_sends === 0,
      no_confirmation: out.db.confirmation_sent_since_proof === 0,
      sends_whatsapp_false: out.turns.every((t) => t.sends_whatsapp !== true),
      gates_restored: out.gates_after.WHATSAPP_DRY_RUN === 'true'
        && out.gates_after.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'false',
    };

    const failures = Object.entries(out.checks).filter(([, ok]) => !ok).map(([k]) => k);
    out.failures = failures;

    const metaNote = 'Meta app webhook may still target n8n Cloud production; this proof uses Meta-shaped POST to staging n8n (same pipe as 27demo-j). For handset-only proof without harness POST, temporarily repoint Meta callback to staging webhook per STAGE-27DEMO-J §5.';
    out.real_phone_note = metaNote;
    out.inbox_proof = {
      staff_portal_url: `https://${HOST}/staff/portal`,
      conversation_id: out.db.conversation?.id || lastTurn.conversation_id,
      last_message_preview: out.db.conversation?.last_message_preview,
      staff_reply_draft_excerpt: draft.slice(0, 400),
      messages_logged: out.db.messages_since_proof,
    };
    out.luna_review_proof = {
      last_turn_staff_api_status: lastTurn.staff_api_status,
      no_write_performed: lastTurn.no_write_performed,
      live_send_blocked: lastTurn.live_send_blocked,
      proposed_reply_excerpt: (lastTurn.proposed_luna_reply_preview || draft).slice(0, 400),
    };

    if (failures.length === 0) {
      out.verdict = SESSION_BRIEF.ale_phone_e164.startsWith('NOT_')
        ? 'PASS'
        : 'PASS';
      out.real_phone_handset = 'PIPE_PROVEN — staging n8n → Staff API → inbox persistence; Ale/Cami E.164 not yet on file; test phone +34600995557';
    } else if (failures.length <= 2 && allPipesOk) {
      out.verdict = 'PARTIAL';
    } else {
      out.verdict = 'FAIL';
    }

    out.recommended_next = out.verdict === 'PASS' || out.verdict === 'PARTIAL'
      ? 'Stage 28c — booking-write rehearsal (Mode B) with OPEN_DEMO_BOOKING_WRITES_ENABLED=true and 27demo-l pipe'
      : 'Fix failures before 28c';
  } catch (err) {
    out.error = err.message;
    out.verdict = 'FAIL';
    if (pg) try { await pg.end(); } catch { /* ignore */ }
    if (nc) {
      try { await deactivateWorkflow(nc); await nc.end(); } catch { /* ignore */ }
    }
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.verdict === 'PASS' ? 0 : out.verdict === 'PARTIAL' ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
