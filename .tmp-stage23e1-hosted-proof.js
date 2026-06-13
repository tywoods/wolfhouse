'use strict';
/** Phase 23e.1 — sent reply thread hosted proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const { buildStaffReplyIdempotencyKey } = require('./scripts/lib/luna-staff-inbox-send-reply');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = 'd891ed8';
const IMAGE_TAG = `${COMMIT}-stage23e1-thread-proof`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const DEPLOY_SUFFIX = 'stage23e1-thread-proof';
const LIVE_SUFFIX = 'stage23e1-live-thread';
const REVERT_SUFFIX = 'stage23e1-revert-safe';
const SOFIA_CONV = '448d4c64-3f45-4aeb-bde1-f4722df55b1c';
const SOFIA_PHONE = '+34999000001';
const TEST_TO = '+491726422307';
const DRY_MSG = 'Staging dry-run thread proof — please ignore.';
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
    && f.WHATSAPP_CLOUD_ACCESS_TOKEN === '(unset)' && f.WHATSAPP_PHONE_NUMBER_ID === '(unset)';
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

function deployImage() {
  console.error('Building image...');
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${DEPLOY_SUFFIX}`,
    '--set-env-vars WHATSAPP_DRY_RUN=true STRIPE_LINKS_ENABLED=false MANUAL_BOOKING_ENABLED=true',
    '--remove-env-vars BOT_BOOKING_ENABLED LUNA_AUTO_SEND_ENABLED WHATSAPP_LIVE_SENDS_ENABLED LUNA_GUEST_LIVE_SEND_OWNER_APPROVED WHATSAPP_CLOUD_ACCESS_TOKEN WHATSAPP_PHONE_NUMBER_ID',
  ].join(' '));
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

async function findTestConversation(pg) {
  const r = await pg.query(
    `SELECT conv.id::text AS conversation_id, conv.phone, conv.display_name
       FROM conversations conv
      INNER JOIN clients c ON c.id = conv.client_id
      WHERE c.slug = $1
        AND REPLACE(COALESCE(conv.phone, ''), '+', '') LIKE '%491726422307%'
      LIMIT 1`,
    [CLIENT],
  );
  return r.rows[0] || null;
}

(async () => {
  const out = {
    phase: '23e.1-hosted',
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
    out.revision_before = activeRevision();
    out.env_before = stagingEnvFlags();
    out.health_before = (await req('GET', '/healthz')).status;

    if (!String(out.revision_before.image || '').includes('d891ed8')) {
      deployImage();
      out.deploy = { built: true, image: IMAGE };
      out.revision = await waitHealthy(DEPLOY_SUFFIX);
    } else {
      out.deploy = { built: false, skipped: 'already on d891ed8' };
      out.revision = out.revision_before;
    }

    if (out.revision.health !== 'Healthy') throw new Error('revision unhealthy');
    if ((await req('GET', '/healthz')).status !== 200) throw new Error('healthz fail');
    if (!isEnvSafe(stagingEnvFlags())) throw new Error('env not safe before Part A');

    const cookie = await staffLogin();
    const pg = await pgConnect();
    const testConv = await findTestConversation(pg);
    out.test_conversation_lookup = testConv || null;

    const sofiaBefore = await countStaffThreadMsgs(pg, SOFIA_CONV, DRY_MSG);
    const dryIdem = buildStaffReplyIdempotencyKey(CLIENT, SOFIA_CONV, DRY_MSG);

    const partA = await req('POST', '/staff/inbox/send-reply', {
      client_slug: CLIENT,
      conversation_id: SOFIA_CONV,
      to: SOFIA_PHONE,
      message_text: DRY_MSG,
      idempotency_key: dryIdem,
    }, cookie);

    const sofiaAfter = await countStaffThreadMsgs(pg, SOFIA_CONV, DRY_MSG);
    const msgsApiA = await req('GET', `/staff/conversations/${SOFIA_CONV}/messages?client=${CLIENT}`, null, cookie);

    out.part_a = {
      conversation_id: SOFIA_CONV,
      phone: SOFIA_PHONE,
      http: partA.status,
      send_performed: partA.body?.send_performed,
      sends_whatsapp: partA.body?.sends_whatsapp,
      blocked_reasons: partA.body?.blocked_reasons,
      guest_message_send_status: partA.body?.guest_message_send_status,
      thread_message: partA.body?.thread_message,
      staff_thread_rows_before: sofiaBefore,
      staff_thread_rows_after: sofiaAfter,
      thread_row_added: sofiaAfter > sofiaBefore,
    };

    out.part_b = { skipped: true, reason: null };
    out.part_c = { skipped: true, reason: null };

    if (!testConv) {
      out.part_b.reason = 'no real conversation for +491726422307 — live/thread proof blocked per rules';
      out.part_c.reason = 'skipped with Part B';
    } else {
      out.live_conversation = testConv;
      enableLiveRevision();
      out.live_revision = await waitHealthy(LIVE_SUFFIX);
      out.env_during_live = stagingEnvFlags();

      const liveConvId = testConv.conversation_id;
      const liveIdem = buildStaffReplyIdempotencyKey(CLIENT, liveConvId, LIVE_MSG);
      const liveBefore = await countStaffThreadMsgs(pg, liveConvId, LIVE_MSG);

      const partB = await req('POST', '/staff/inbox/send-reply', {
        client_slug: CLIENT,
        conversation_id: liveConvId,
        to: TEST_TO,
        message_text: LIVE_MSG,
        idempotency_key: liveIdem,
      }, cookie);

      await new Promise((r) => setTimeout(r, 1000));

      const partC = await req('POST', '/staff/inbox/send-reply', {
        client_slug: CLIENT,
        conversation_id: liveConvId,
        to: TEST_TO,
        message_text: LIVE_MSG,
        idempotency_key: liveIdem,
      }, cookie);

      const liveAfter = await countStaffThreadMsgs(pg, liveConvId, LIVE_MSG);
      const threadRows = await listStaffThreadMsgs(pg, liveConvId, LIVE_MSG);
      const msgsApi = await req('GET', `/staff/conversations/${liveConvId}/messages?client=${CLIENT}`, null, cookie);
      const apiMsgs = (msgsApi.body?.messages || []).filter((m) => m.message_text === LIVE_MSG && m.source === 'staff_inbox_reply');

      const sends = await pg.query(
        `SELECT id::text, status, idempotency_key, to_phone, provider_message_id, send_kind
           FROM guest_message_sends WHERE client_slug = $1 AND idempotency_key = $2`,
        [CLIENT, liveIdem],
      );

      out.part_b = {
        skipped: false,
        conversation_id: liveConvId,
        to: TEST_TO,
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
        messages_api_matches: apiMsgs.length,
        messages_api_sample: apiMsgs[0] || null,
        guest_message_sends: sends.rows,
      };

      out.part_c = {
        skipped: false,
        http: partC.status,
        duplicate: partC.body?.duplicate,
        idempotent_replay: partC.body?.idempotent_replay,
        send_performed: partC.body?.send_performed,
        thread_message_duplicate: partC.body?.thread_message?.duplicate,
        staff_thread_rows_final: liveAfter,
        guest_message_send_rows: sends.rows.length,
      };

      await doRevert();
    }

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

    if (!reverted) await doRevert();

    out.safety = {
      staff_reply_sent_since_proof: sentSince.rows[0].n,
      bookings_created: bookings.rows[0].n,
      payments_created: payments.rows[0].n,
      staff_handoffs_created: handoffs.rows[0].n,
    };

    out.ui = {
      staff_label_in_html: (await req('GET', '/staff/ui', null, cookie)).raw?.includes("staff_inbox_reply' ? 'Staff'") || false,
      load_conv_after_send: (await req('GET', '/staff/ui', null, cookie)).raw?.includes('loadConvDetail(convId, targetEl)') || false,
    };

    const partAPass = partA.status === 200
      && out.part_a.send_performed === false
      && (out.part_a.blocked_reasons || []).includes('whatsapp_dry_run_active')
      && out.part_a.staff_thread_rows_after === out.part_a.staff_thread_rows_before
      && !out.part_a.thread_message?.persisted;

    let partBPass = out.part_b.skipped === true && out.part_b.reason?.includes('491726422307');
    let partCPass = out.part_b.skipped === true;

    if (!out.part_b.skipped) {
      partBPass = out.part_b.send_performed === true
        && out.part_b.sends_whatsapp === true
        && !!out.part_b.provider_message_id
        && out.part_b.staff_thread_rows_after === out.part_b.staff_thread_rows_before + 1
        && out.part_b.messages_api_matches >= 1
        && out.part_b.thread_rows[0]?.source === 'staff_inbox_reply';

      partCPass = out.part_c.duplicate === true
        && out.part_c.send_performed === false
        && out.part_c.staff_thread_rows_final === out.part_b.staff_thread_rows_after
        && out.part_c.guest_message_send_rows === 1;
    }

    const safetyPass = out.safety.bookings_created === 0 && out.safety.payments_created === 0
      && out.safety.staff_handoffs_created === 0 && isEnvSafe(out.env_after || stagingEnvFlags());

    if (partAPass && partBPass && partCPass && safetyPass) {
      out.result = out.part_b.skipped ? 'PARTIAL' : 'PASS';
    } else if (partAPass && safetyPass) {
      out.result = 'PARTIAL';
    } else {
      out.result = 'FAIL';
    }
    out.checks = { partAPass, partBPass, partCPass, safetyPass };
  } catch (err) {
    out.result = 'FAIL';
    out.error = err.message;
    await doRevert();
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'FAIL' ? 1 : 0);
})();
