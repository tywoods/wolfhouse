'use strict';
/** Phase 23d.1 — hosted Inbox send reply proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const {
  buildStaffReplyIdempotencyKey,
} = require('./scripts/lib/luna-staff-inbox-send-reply');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = '6663302';
const IMAGE_TAG = `${COMMIT}-stage23d1-inbox-send`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 'stage23d1-inbox-send';
const TEST_PHONE = '491726422307';
const DRY_MSG = 'Staging dry-run proof — please ignore.';
const PROOF_START = new Date().toISOString();
const LOGIN = {
  client: CLIENT,
  email: 'operator.stage72c@example.test',
  password: 'OperatorPass123!',
};

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function req(method, path, body, cookie, accept) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Accept: accept || 'application/json', ...(cookie ? { Cookie: cookie } : {}) };
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

async function waitHealthy(timeoutMs = 300000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rev = activeRevision();
    if (rev.health === 'Healthy' && rev.traffic === 100
      && String(rev.image || '').includes(COMMIT.slice(0, 7))) {
      return rev;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return activeRevision();
}

function deploySafeRevision() {
  console.error('Building image...');
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  console.error('Updating container app...');
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REV_SUFFIX}`,
    '--set-env-vars WHATSAPP_DRY_RUN=true STRIPE_LINKS_ENABLED=false MANUAL_BOOKING_ENABLED=true',
    '--remove-env-vars BOT_BOOKING_ENABLED LUNA_AUTO_SEND_ENABLED WHATSAPP_LIVE_SENDS_ENABLED LUNA_GUEST_LIVE_SEND_OWNER_APPROVED WHATSAPP_CLOUD_ACCESS_TOKEN WHATSAPP_PHONE_NUMBER_ID',
  ].join(' '));
}

async function staffLogin() {
  const login = await req('POST', '/staff/auth/login', LOGIN);
  if (login.status !== 200 || !login.body || !login.body.success) {
    throw new Error(`login failed HTTP ${login.status}`);
  }
  return (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
}

async function pgConnect() {
  const url = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

function extractInboxUi(html) {
  const loadDetail = html.match(/function loadConvDetail\(convId[\s\S]*?function kv\(/);
  const loadDetailJs = loadDetail ? loadDetail[0] : '';
  const panelsHidden = /inbox-bottom-debug-panels[\s\S]*display:\s*none/.test(html);
  return { loadDetailJs, panelsHidden, html };
}

(async () => {
  const out = {
    phase: '23d.1-hosted',
    proof_start: PROOF_START,
    commit: COMMIT,
    image: IMAGE,
    part_c_skipped: 'no explicit live-send approval',
    result: 'PENDING',
  };

  try {
    out.revision_before = activeRevision();
    out.env_before = stagingEnvFlags();
    out.health = { before: (await req('GET', '/healthz')).status };

    const alreadyDeployed = String(out.revision_before.image || '').includes(COMMIT.slice(0, 7));
    if (!alreadyDeployed) {
      deploySafeRevision();
      out.deploy = { built: true, image: IMAGE };
      out.revision = await waitHealthy();
    } else {
      out.deploy = { built: false, skipped: 'already on commit' };
      out.revision = out.revision_before;
    }

    if (out.revision.health !== 'Healthy' || out.revision.traffic !== 100) {
      throw new Error(`revision unhealthy: ${JSON.stringify(out.revision)}`);
    }
    out.health.after_deploy = (await req('GET', '/healthz')).status;
    out.env_during = stagingEnvFlags();

    const envSafe = out.env_during.WHATSAPP_DRY_RUN === 'true'
      && out.env_during.STRIPE_LINKS_ENABLED === 'false'
      && out.env_during.LUNA_AUTO_SEND_ENABLED === '(unset)'
      && out.env_during.BOT_BOOKING_ENABLED === '(unset)'
      && out.env_during.WHATSAPP_CLOUD_ACCESS_TOKEN === '(unset)'
      && out.env_during.WHATSAPP_PHONE_NUMBER_ID === '(unset)';
    out.env_safe_first_pass = envSafe;
    if (!envSafe) throw new Error('env not safe for first pass: ' + JSON.stringify(out.env_during));

    const cookie = await staffLogin();

    const inbox = await req('GET', `/staff/conversations?client=${encodeURIComponent(CLIENT)}`, null, cookie);
    const convs = (inbox.body && inbox.body.conversations) ? inbox.body.conversations : [];
    let conv = convs.find((c) => String(c.phone || '').replace(/\D/g, '').includes(TEST_PHONE));
    if (!conv && convs.length) conv = convs[0];

    if (!conv || !conv.conversation_id) {
      throw new Error('no usable conversation for proof');
    }

    out.target_conversation = {
      conversation_id: conv.conversation_id,
      phone: conv.phone,
      guest_name: conv.guest_name,
    };

    const idemKey = buildStaffReplyIdempotencyKey(CLIENT, conv.conversation_id, DRY_MSG);
    out.idempotency_key = idemKey;

    const sendBody = {
      client_slug: CLIENT,
      conversation_id: conv.conversation_id,
      to: conv.phone,
      message_text: DRY_MSG,
      idempotency_key: idemKey,
    };

    const partA = await req('POST', '/staff/inbox/send-reply', sendBody, cookie);
    out.part_a = {
      http: partA.status,
      success: partA.body && partA.body.success,
      send_performed: partA.body && partA.body.send_performed,
      sends_whatsapp: partA.body && partA.body.sends_whatsapp,
      blocked_reasons: partA.body && partA.body.blocked_reasons,
      send_kind: partA.body && partA.body.send_kind,
      idempotency_key: partA.body && partA.body.idempotency_key,
      guest_message_send_status: partA.body && partA.body.guest_message_send_status,
    };

    const partB = await req('POST', '/staff/inbox/send-reply', sendBody, cookie);
    out.part_b = {
      http: partB.status,
      duplicate: partB.body && partB.body.duplicate,
      idempotent_replay: partB.body && partB.body.idempotent_replay,
      send_performed: partB.body && partB.body.send_performed,
      blocked_reasons: partB.body && partB.body.blocked_reasons,
      guest_message_send_status: partB.body && partB.body.guest_message_send_status,
    };

    const uiRes = await req('GET', '/staff/ui', null, cookie, 'text/html');
    const { loadDetailJs, panelsHidden } = extractInboxUi(uiRes.raw || '');
    out.ui = {
      http: uiRes.status,
      review_and_send: /Review and send reply/.test(loadDetailJs),
      send_reply_button: /Send reply|btn-send-reply/.test(loadDetailJs),
      copy_button: /btn-copy|Copy/.test(loadDetailJs),
      no_shadow: !/shadow mode|Shadow-mode|NOT SENT|Approve &amp; Send &mdash; disabled/i.test(loadDetailJs),
      calls_inbox_send: /\/staff\/inbox\/send-reply/.test(loadDetailJs),
      no_bot_send: !loadDetailJs.includes('/staff/bot/guest-reply-send'),
      panels_hidden_css: panelsHidden,
      bottom_panels_class: /inbox-bottom-debug-panels/.test(uiRes.raw || ''),
      blocked_ui_handling: /blocked_reasons/.test(loadDetailJs),
    };

    const pg = await pgConnect();
    const sends = await pg.query(
      `SELECT id::text, send_kind, status, idempotency_key, to_phone, blocked_reasons, provider_message_id, created_at
         FROM guest_message_sends
        WHERE client_slug = $1
          AND idempotency_key = $2
        ORDER BY created_at DESC`,
      [CLIENT, idemKey],
    );
    const sendsSince = await pg.query(
      `SELECT COUNT(*)::int AS n FROM guest_message_sends
        WHERE client_slug = $1 AND send_kind = 'staff_reply' AND created_at >= $2::timestamptz`,
      [CLIENT, PROOF_START],
    );
    const sentLive = await pg.query(
      `SELECT COUNT(*)::int AS n FROM guest_message_sends
        WHERE client_slug = $1 AND status = 'sent' AND created_at >= $2::timestamptz`,
      [CLIENT, PROOF_START],
    );
    const bookings = await pg.query(
      'SELECT COUNT(*)::int AS n FROM bookings WHERE created_at >= $1::timestamptz',
      [PROOF_START],
    );
    const payments = await pg.query(
      'SELECT COUNT(*)::int AS n FROM payments WHERE created_at >= $1::timestamptz',
      [PROOF_START],
    );
    const handoffs = await pg.query(
      'SELECT COUNT(*)::int AS n FROM staff_handoffs WHERE created_at >= $1::timestamptz',
      [PROOF_START],
    );
    await pg.end();

    out.guest_message_sends = {
      rows_for_key: sends.rows,
      row_count_for_key: sends.rows.length,
      staff_reply_since_proof: sendsSince.rows[0].n,
      sent_since_proof: sentLive.rows[0].n,
    };

    out.safety = {
      sent_status_count: sentLive.rows[0].n,
      bookings_created: bookings.rows[0].n,
      payments_created: payments.rows[0].n,
      staff_handoffs_created: handoffs.rows[0].n,
      no_live_whatsapp: sentLive.rows[0].n === 0,
    };

    out.env_after = stagingEnvFlags();
    out.health.after = (await req('GET', '/healthz')).status;
    out.revision_after = activeRevision();

    const partAPass = partA.status === 200
      && out.part_a.send_performed === false
      && out.part_a.sends_whatsapp === false
      && (out.part_a.blocked_reasons || []).includes('whatsapp_dry_run_active')
      && out.part_a.send_kind === 'staff_reply';

    const partBPass = partB.status === 200
      && (out.part_b.duplicate === true || out.part_b.idempotent_replay === true
        || out.part_b.send_performed === false)
      && sends.rows.length >= 1;

    const uiPass = out.ui.review_and_send && out.ui.send_reply_button && out.ui.no_shadow
      && out.ui.calls_inbox_send && out.ui.no_bot_send && out.ui.panels_hidden_css;

    const safetyPass = out.safety.no_live_whatsapp && out.safety.bookings_created === 0
      && out.safety.payments_created === 0 && out.safety.staff_handoffs_created === 0;

    if (partAPass && partBPass && uiPass && safetyPass && envSafe) {
      out.result = 'PASS';
    } else if (partAPass && safetyPass) {
      out.result = 'PARTIAL';
    } else {
      out.result = 'FAIL';
    }
    out.checks = { partAPass, partBPass, uiPass, safetyPass, envSafe };
  } catch (err) {
    out.result = 'FAIL';
    out.error = err.message;
    try {
      out.revision_after = activeRevision();
      out.env_after = stagingEnvFlags();
      out.health = out.health || {};
      out.health.after = (await req('GET', '/healthz')).status;
    } catch { /* ignore */ }
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'PASS' ? 0 : 1);
})();
