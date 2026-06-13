'use strict';
/** Phase 23e.2 — seed test conv + live thread B/C proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const { buildStaffReplyIdempotencyKey } = require('./scripts/lib/luna-staff-inbox-send-reply');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = 'd891ed8';
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${COMMIT}-stage23e1-thread-proof`;
const LIVE_SUFFIX = 'stage23e2-live-thread';
const REVERT_SUFFIX = 'stage23e2-revert-safe';
const TEST_PHONE = '+491726422307';
const LIVE_MSG = 'Staging live thread proof — please ignore.';
const PROOF_START = new Date().toISOString();
const LOGIN = {
  client: CLIENT,
  email: 'operator.stage72c@example.test',
  password: 'OperatorPass123!',
};

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function runVerifiers() {
  const scripts = [
    'verify:staff-inbox-sent-reply-thread',
    'verify:staff-inbox-send-reply-route',
    'verify:staff-inbox-send-reply-ui',
    'verify:luna-agent-phase19-guest-reply-send-idempotency',
  ];
  const results = {};
  for (const s of scripts) {
    try {
      const raw = execSync(`npm run ${s}`, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, cwd: __dirname.replace(/\\scripts$/, '').replace(/\\$/, '') || process.cwd() });
      results[s] = { pass: /0 failed/.test(raw), tail: raw.split('\n').slice(-3).join('\n') };
    } catch (e) {
      results[s] = { pass: false, tail: (e.stdout || e.message || '').slice(-500) };
    }
  }
  return results;
}

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const r = https.request({ hostname: HOST, path, method, headers: h }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties?.template?.containers?.[0]?.image,
  };
}

function stagingEnvFlags() {
  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const pick = (name) => {
    const row = env.find((e) => e.name === name);
    if (!row) return '(unset)';
    if (row.secretRef) return `(secret:${row.secretRef})`;
    return row.value != null ? row.value : '(unset)';
  };
  return {
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
    BOT_BOOKING_ENABLED: pick('BOT_BOOKING_ENABLED'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
    WHATSAPP_CLOUD_ACCESS_TOKEN: pick('WHATSAPP_CLOUD_ACCESS_TOKEN'),
    WHATSAPP_PHONE_NUMBER_ID: pick('WHATSAPP_PHONE_NUMBER_ID'),
    WHATSAPP_LIVE_SENDS_ENABLED: pick('WHATSAPP_LIVE_SENDS_ENABLED'),
  };
}

function isEnvSafe(f) {
  return f.WHATSAPP_DRY_RUN === 'true' && f.STRIPE_LINKS_ENABLED === 'false'
    && f.WHATSAPP_CLOUD_ACCESS_TOKEN === '(unset)' && f.WHATSAPP_PHONE_NUMBER_ID === '(unset)'
    && f.WHATSAPP_LIVE_SENDS_ENABLED === '(unset)';
}

async function waitHealthy(suffix, timeoutMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rev = activeRevision();
    if (rev.health === 'Healthy' && rev.traffic === 100 && String(rev.name || '').includes(suffix)) {
      return rev;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return activeRevision();
}

function enableLiveRevision() {
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${LIVE_SUFFIX}`,
    '--set-env-vars WHATSAPP_DRY_RUN=false STRIPE_LINKS_ENABLED=false MANUAL_BOOKING_ENABLED=true WHATSAPP_LIVE_SENDS_ENABLED=true WHATSAPP_CLOUD_ACCESS_TOKEN=secretref:meta-whatsapp-token WHATSAPP_PHONE_NUMBER_ID=secretref:meta-whatsapp-phone-id',
  ].join(' '));
}

function revertSafeRevision() {
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REVERT_SUFFIX}`,
    '--set-env-vars WHATSAPP_DRY_RUN=true STRIPE_LINKS_ENABLED=false MANUAL_BOOKING_ENABLED=true',
    '--remove-env-vars LUNA_AUTO_SEND_ENABLED BOT_BOOKING_ENABLED WHATSAPP_LIVE_SENDS_ENABLED LUNA_GUEST_LIVE_SEND_OWNER_APPROVED WHATSAPP_CLOUD_ACCESS_TOKEN WHATSAPP_PHONE_NUMBER_ID',
  ].join(' '));
}

async function staffLogin() {
  const login = await req('POST', '/staff/auth/login', LOGIN);
  if (login.status !== 200 || !login.body?.success) throw new Error(`login failed ${login.status}`);
  return (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
}

async function pgConnect() {
  const url = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

async function seedTestConversation(pg) {
  const bookingsBefore = await pg.query('SELECT COUNT(*)::int AS n FROM bookings');
  const paymentsBefore = await pg.query('SELECT COUNT(*)::int AS n FROM payments');
  const handoffsBefore = await pg.query('SELECT COUNT(*)::int AS n FROM staff_handoffs');

  const r = await pg.query(
    `INSERT INTO conversations (
       client_id, phone, display_name, language, status, bot_mode,
       conversation_stage, session_state, last_message_preview, metadata
     )
     SELECT c.id, $2, $3, 'en', 'open', 'bot', 'general',
            '{"phase23e2_proof_seed":true}'::jsonb,
            '[Proof seed] Staging live thread proof conversation',
            '{"phase23e2_proof_seed":true,"seeded_at":"${PROOF_START}"}'::jsonb
       FROM clients c WHERE c.slug = $1
     ON CONFLICT (client_id, phone) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       metadata = conversations.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING id::text AS conversation_id, (xmax = 0) AS inserted`,
    [CLIENT, TEST_PHONE, 'Phase 23e.2 Test (+491726422307)'],
  );

  const bookingsAfter = await pg.query('SELECT COUNT(*)::int AS n FROM bookings');
  const paymentsAfter = await pg.query('SELECT COUNT(*)::int AS n FROM payments');
  const handoffsAfter = await pg.query('SELECT COUNT(*)::int AS n FROM staff_handoffs');

  return {
    conversation_id: r.rows[0].conversation_id,
    inserted: r.rows[0].inserted,
    phone: TEST_PHONE,
    side_effects: {
      bookings_delta: bookingsAfter.rows[0].n - bookingsBefore.rows[0].n,
      payments_delta: paymentsAfter.rows[0].n - paymentsBefore.rows[0].n,
      staff_handoffs_delta: handoffsAfter.rows[0].n - handoffsBefore.rows[0].n,
    },
  };
}

async function countStaffThreadMsgs(pg, convId, text) {
  const r = await pg.query(
    `SELECT COUNT(*)::int AS n FROM messages m
      INNER JOIN conversations conv ON conv.id = m.conversation_id
      INNER JOIN clients c ON c.id = conv.client_id
     WHERE c.slug = $1 AND m.conversation_id = $2::uuid
       AND m.source = 'staff_inbox_reply' AND m.direction = 'outbound'
       AND ($3::text IS NULL OR m.message_text = $3)`,
    [CLIENT, convId, text || null],
  );
  return r.rows[0].n;
}

async function listStaffThreadMsgs(pg, convId, text) {
  const r = await pg.query(
    `SELECT m.id::text, m.message_text, m.source, m.direction::text, m.whatsapp_message_id,
            m.metadata, m.created_at
       FROM messages m
      INNER JOIN conversations conv ON conv.id = m.conversation_id
      INNER JOIN clients c ON c.id = conv.client_id
     WHERE c.slug = $1 AND m.conversation_id = $2::uuid
       AND m.source = 'staff_inbox_reply'
       AND ($3::text IS NULL OR m.message_text = $3)
     ORDER BY m.created_at DESC`,
    [CLIENT, convId, text || null],
  );
  return r.rows;
}

function staffBubbleFromApi(msgs) {
  return (msgs || []).filter((m) => m.message_text === LIVE_MSG && m.source === 'staff_inbox_reply');
}

(async () => {
  const out = {
    phase: '23e.2-hosted',
    proof_start: PROOF_START,
    commit: COMMIT,
    result: 'PENDING',
    reverted: false,
  };
  let reverted = false;
  const doRevert = async () => {
    if (reverted) return;
    try {
      console.error('Reverting env...');
      revertSafeRevision();
      out.restored_revision = await waitHealthy(REVERT_SUFFIX);
      out.env_after = stagingEnvFlags();
      out.health_after_revert = (await req('GET', '/healthz')).status;
      out.reverted = true;
      reverted = true;
    } catch (e) {
      out.revert_error = e.message;
    }
  };

  try {
    console.error('Running verifiers...');
    out.verifiers = runVerifiers();
    const verifiersPass = Object.values(out.verifiers).every((v) => v.pass);
    if (!verifiersPass) throw new Error('verifier failure');

    out.revision_before = activeRevision();
    out.env_before = stagingEnvFlags();
    out.health_before = (await req('GET', '/healthz')).status;
    if (out.health_before !== 200) throw new Error('healthz fail before proof');
    if (!isEnvSafe(out.env_before)) throw new Error('env not safe before live send');

    const cookie = await staffLogin();
    const pg = await pgConnect();

    out.seed = await seedTestConversation(pg);
    if (out.seed.side_effects.bookings_delta !== 0 || out.seed.side_effects.payments_delta !== 0
      || out.seed.side_effects.staff_handoffs_delta !== 0) {
      throw new Error('seed caused side effects');
    }

    const convId = out.seed.conversation_id;
    const inbox = await req('GET', `/staff/conversations?client=${CLIENT}`, null, cookie);
    const inboxHit = (inbox.body?.conversations || []).find((c) => c.id === convId || c.conversation_id === convId);
    const msgsBefore = await req('GET', `/staff/conversations/${convId}/messages?client=${CLIENT}`, null, cookie);

    out.pre_live = {
      conversation_id: convId,
      inbox_http: inbox.status,
      inbox_contains_conversation: !!inboxHit,
      inbox_row: inboxHit || null,
      messages_route_http: msgsBefore.status,
      messages_route_ok: msgsBefore.status === 200 && msgsBefore.body?.success === true,
    };
    if (!out.pre_live.inbox_contains_conversation) throw new Error('seeded conversation not in inbox');
    if (!out.pre_live.messages_route_ok) throw new Error('messages route failed for seeded conversation');

    enableLiveRevision();
    out.live_revision = await waitHealthy(LIVE_SUFFIX);
    out.env_during_live = stagingEnvFlags();

    const liveIdem = buildStaffReplyIdempotencyKey(CLIENT, convId, LIVE_MSG);
    const liveBefore = await countStaffThreadMsgs(pg, convId, LIVE_MSG);

    const partB = await req('POST', '/staff/inbox/send-reply', {
      client_slug: CLIENT,
      conversation_id: convId,
      to: TEST_PHONE,
      message_text: LIVE_MSG,
      idempotency_key: liveIdem,
    }, cookie);

    await new Promise((r) => setTimeout(r, 1500));

    const msgsAfterSend = await req('GET', `/staff/conversations/${convId}/messages?client=${CLIENT}`, null, cookie);
    const bubblesAfterSend = staffBubbleFromApi(msgsAfterSend.body?.messages);

    await new Promise((r) => setTimeout(r, 500));
    const msgsAfterRefresh = await req('GET', `/staff/conversations/${convId}/messages?client=${CLIENT}`, null, cookie);
    const bubblesAfterRefresh = staffBubbleFromApi(msgsAfterRefresh.body?.messages);

    const partC = await req('POST', '/staff/inbox/send-reply', {
      client_slug: CLIENT,
      conversation_id: convId,
      to: TEST_PHONE,
      message_text: LIVE_MSG,
      idempotency_key: liveIdem,
    }, cookie);

    const liveAfter = await countStaffThreadMsgs(pg, convId, LIVE_MSG);
    const threadRows = await listStaffThreadMsgs(pg, convId, LIVE_MSG);
    const msgsFinal = await req('GET', `/staff/conversations/${convId}/messages?client=${CLIENT}`, null, cookie);
    const bubblesFinal = staffBubbleFromApi(msgsFinal.body?.messages);

    const sends = await pg.query(
      `SELECT id::text, status, idempotency_key, to_phone, provider_message_id, send_kind, created_at
         FROM guest_message_sends WHERE client_slug = $1 AND idempotency_key = $2`,
      [CLIENT, liveIdem],
    );

    out.part_b = {
      conversation_id: convId,
      to: TEST_PHONE,
      http: partB.status,
      success: partB.body?.success,
      send_performed: partB.body?.send_performed,
      sends_whatsapp: partB.body?.sends_whatsapp,
      provider_message_id: partB.body?.whatsapp_message_id,
      guest_message_send_status: partB.body?.guest_message_send_status,
      thread_message: partB.body?.thread_message,
      staff_thread_rows_before: liveBefore,
      staff_thread_rows_after: liveAfter,
      thread_rows: threadRows,
      messages_api_staff_bubbles: bubblesAfterSend.length,
      messages_api_sample: bubblesAfterSend[0] || null,
      guest_message_sends: sends.rows,
    };

    out.part_c = {
      http: partC.status,
      duplicate: partC.body?.duplicate,
      idempotent_replay: partC.body?.idempotent_replay,
      send_performed: partC.body?.send_performed,
      thread_message_duplicate: partC.body?.thread_message?.duplicate,
      staff_thread_rows_final: liveAfter,
      guest_message_send_rows: sends.rows.length,
    };

    out.ui_thread = {
      staff_bubble_count_after_send: bubblesAfterSend.length,
      staff_bubble_direction: bubblesAfterSend[0]?.direction || null,
      staff_bubble_source: bubblesAfterSend[0]?.source || null,
      staff_bubble_persists_after_refresh: bubblesAfterRefresh.length === 1
        && bubblesAfterRefresh[0]?.message_text === LIVE_MSG
        && bubblesAfterRefresh[0]?.source === 'staff_inbox_reply',
      staff_bubble_count_final: bubblesFinal.length,
      ui_would_label_staff: bubblesFinal[0]?.source === 'staff_inbox_reply',
    };

    await doRevert();

    const sentSince = await pg.query(
      `SELECT COUNT(*)::int AS n FROM guest_message_sends
        WHERE client_slug = $1 AND status = 'sent' AND send_kind = 'staff_reply'
          AND created_at >= $2::timestamptz`,
      [CLIENT, PROOF_START],
    );
    const bookings = await pg.query('SELECT COUNT(*)::int AS n FROM bookings WHERE created_at >= $1::timestamptz', [PROOF_START]);
    const payments = await pg.query('SELECT COUNT(*)::int AS n FROM payments WHERE created_at >= $1::timestamptz', [PROOF_START]);
    const handoffs = await pg.query('SELECT COUNT(*)::int AS n FROM staff_handoffs WHERE created_at >= $1::timestamptz', [PROOF_START]);
    await pg.end();

    out.safety = {
      staff_reply_sent_since_proof: sentSince.rows[0].n,
      bookings_created: bookings.rows[0].n,
      payments_created: payments.rows[0].n,
      staff_handoffs_created: handoffs.rows[0].n,
      seed_side_effects: out.seed.side_effects,
    };

    const partBPass = partB.status === 200
      && out.part_b.send_performed === true
      && out.part_b.sends_whatsapp === true
      && !!out.part_b.provider_message_id
      && out.part_b.staff_thread_rows_after === out.part_b.staff_thread_rows_before + 1
      && out.part_b.messages_api_staff_bubbles >= 1
      && out.part_b.thread_rows[0]?.source === 'staff_inbox_reply'
      && out.part_b.thread_rows[0]?.direction === 'outbound';

    const partCPass = out.part_c.duplicate === true
      && out.part_c.send_performed === false
      && out.part_c.staff_thread_rows_final === out.part_b.staff_thread_rows_after
      && out.part_c.guest_message_send_rows === 1;

    const uiPass = out.ui_thread.staff_bubble_count_after_send === 1
      && out.ui_thread.staff_bubble_persists_after_refresh
      && out.ui_thread.staff_bubble_count_final === 1
      && out.ui_thread.ui_would_label_staff;

    const safetyPass = out.safety.bookings_created === 0 && out.safety.payments_created === 0
      && out.safety.staff_handoffs_created === 0 && isEnvSafe(out.env_after || stagingEnvFlags())
      && out.safety.staff_reply_sent_since_proof <= 1;

    out.checks = { verifiersPass, partBPass, partCPass, uiPass, safetyPass };
    out.result = (partBPass && partCPass && uiPass && safetyPass) ? 'PASS' : 'FAIL';
  } catch (err) {
    out.result = 'FAIL';
    out.error = err.message;
    await doRevert();
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'FAIL' ? 1 : 0);
})();
