'use strict';
/** Phase 23b.1 — hosted handoff queue proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = 'a4f53b3';
const IMAGE_TAG = `${COMMIT}-stage23b1-handoff-queue`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 'stage23b1-handoff-queue';
const ROUTE = '/staff/meta/whatsapp/webhook';
const TEST_FROM = '491726422307';
const PROFILE = 'Phase 23b Handoff Proof';
const PROOF_START = new Date().toISOString();
const LOGIN = {
  client: CLIENT,
  email: 'operator.stage72c@example.test',
  password: 'OperatorPass123!',
};

const WA_REFUND = 'wamid.phase23b1.refund.001';
const WA_IMAGE = 'wamid.phase23b1.image.001';
const WA_PARTIAL = 'wamid.phase23b1.partial.001';
const WA_COMPLETE = 'wamid.phase23b1.complete.001';
const TEXT_REFUND = 'I want a refund and need to talk to someone.';
const TEXT_PARTIAL = 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?';
const TEXT_COMPLETE =
  'Hi, we are 2 people and want Malibu from October 13 to October 16. We can pay the deposit.';

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

function metaText(waId, text) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '34663439419', phone_number_id: '1152900101233109' },
          contacts: [{ profile: { name: PROFILE }, wa_id: TEST_FROM }],
          messages: [{
            from: TEST_FROM,
            id: waId,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: text },
          }],
        },
      }],
    }],
  };
}

function metaImage(waId) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: '1152900101233109' },
          contacts: [{ profile: { name: PROFILE }, wa_id: TEST_FROM }],
          messages: [{
            from: TEST_FROM,
            id: waId,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'image',
            image: { id: 'fake-image-id-phase23b1', mime_type: 'image/jpeg' },
          }],
        },
      }],
    }],
  };
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
  };
}

async function waitHealthy(revSuffix, timeoutMs = 240000) {
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
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  return cookie;
}

async function pgConnect() {
  const url = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

function summarizeSeed(body) {
  if (!body || typeof body !== 'object') return {};
  const p = body.booking_write_preview || {};
  return {
    received: body.received,
    next_action: body.next_action,
    handoff_required: body.handoff_required,
    normalized_supported: body.normalized && body.normalized.supported,
    preview_eligible: p.eligible,
    preview_blocked: p.blocked_reasons,
    sends_whatsapp: body.sends_whatsapp,
    event_persisted: body.event_persisted,
  };
}

function itemHasWa(items, waId) {
  return (items || []).some((i) => String(i.message_text || '').length > 0
    && (i.id || '').length > 0
    && lookupWaInDb(waId)); // placeholder - we'll check by message content / queue
}

async function eventByWa(pg, waId) {
  const r = await pg.query(
    `SELECT wa_message_id, next_action, handoff_required, message_text,
            normalized->>'supported' AS supported,
            normalized->'booking_write_preview'->>'eligible' AS preview_eligible
       FROM guest_message_events
      WHERE client_slug = $1 AND wa_message_id = $2`,
    [CLIENT, waId],
  );
  return r.rows[0] || null;
}

function queueContainsWa(items, waId, pgRow) {
  if (!pgRow) return false;
  const text = pgRow.message_text || '';
  return (items || []).some((i) => {
    if (i.message_text === text) return true;
    if (waId === WA_REFUND && /refund/i.test(i.message_text || '')) return true;
    if (waId === WA_PARTIAL && /settembre/i.test(i.message_text || '')) return true;
    if (waId === WA_COMPLETE && /October 13/i.test(i.message_text || '')) return true;
    if (waId === WA_IMAGE && i.next_action === 'unsupported') return true;
    return false;
  });
}

function extractHandoffUi(html) {
  const panel = html.match(/id="handoff-queue-panel"[\s\S]{0,3500}/);
  const panelHtml = panel ? panel[0] : '';
  const js = html.match(/function loadHandoffsQueue\(\)[\s\S]{0,4000}/);
  const jsBlock = js ? js[0] : '';
  return { panelHtml, jsBlock };
}

(async () => {
  const out = {
    phase: '23b.1',
    proof_start: PROOF_START,
    commit: COMMIT,
    image: IMAGE,
    revision: null,
    env_before: null,
    env_after: null,
    health_before: null,
    health_after: null,
    deploy: null,
    seeds: {},
    api: null,
    ui: null,
    inclusion: null,
    safety: null,
    result: 'PENDING',
  };

  try {
    out.revision_before = activeRevision();
    out.env_before = stagingEnvFlags();
    out.health_before = (await req('GET', '/healthz')).status;

    const alreadyDeployed = String(out.revision_before.image || '').includes(COMMIT.slice(0, 7));
    if (!alreadyDeployed) {
      deploySafeRevision();
      out.deploy = { built: true, image: IMAGE };
      out.revision = await waitHealthy(REV_SUFFIX);
    } else {
      out.deploy = { built: false, skipped: 'already on commit' };
      out.revision = out.revision_before;
    }

    if (out.revision.health !== 'Healthy' || out.revision.traffic !== 100) {
      throw new Error(`revision not healthy: ${JSON.stringify(out.revision)}`);
    }
    if ((await req('GET', '/healthz')).status !== 200) {
      throw new Error('healthz not 200 after deploy');
    }

    out.env_after_deploy = stagingEnvFlags();

    const caseA = await req('POST', ROUTE, metaText(WA_REFUND, TEXT_REFUND));
    const caseB = await req('POST', ROUTE, metaImage(WA_IMAGE));
    const caseC = await req('POST', ROUTE, metaText(WA_PARTIAL, TEXT_PARTIAL));
    const caseD = await req('POST', ROUTE, metaText(WA_COMPLETE, TEXT_COMPLETE));
    await new Promise((r) => setTimeout(r, 1000));

    out.seeds = {
      refund: { http: caseA.status, summary: summarizeSeed(caseA.body) },
      image: { http: caseB.status, summary: summarizeSeed(caseB.body) },
      partial: { http: caseC.status, summary: summarizeSeed(caseC.body) },
      complete: { http: caseD.status, summary: summarizeSeed(caseD.body) },
    };

    const cookie = await staffLogin();
    const apiPath = `/staff/inbox/handoffs?client_slug=${encodeURIComponent(CLIENT)}&from_phone=${encodeURIComponent(TEST_FROM)}&limit=20`;
    const apiRes = await req('GET', apiPath, null, cookie);
    const items = apiRes.body && apiRes.body.items ? apiRes.body.items : [];

    const pg = await pgConnect();
    const pgRefund = await eventByWa(pg, WA_REFUND);
    const pgImage = await eventByWa(pg, WA_IMAGE);
    const pgPartial = await eventByWa(pg, WA_PARTIAL);
    const pgComplete = await eventByWa(pg, WA_COMPLETE);

    const handoffCountBefore = await pg.query(
      'SELECT COUNT(*)::int AS n FROM staff_handoffs WHERE phone LIKE $1 AND created_at >= $2::timestamptz',
      [`%${TEST_FROM}%`, PROOF_START],
    );
    const bookings = await pg.query(
      'SELECT id::text FROM bookings WHERE created_at >= $1::timestamptz LIMIT 5',
      [PROOF_START],
    );
    const payments = await pg.query(
      'SELECT id::text FROM payments WHERE created_at >= $1::timestamptz LIMIT 5',
      [PROOF_START],
    );
    const sent = await pg.query(
      `SELECT idempotency_key FROM guest_message_sends
        WHERE client_slug = $1 AND status = 'sent' AND created_at >= $2::timestamptz`,
      [CLIENT, PROOF_START],
    );
    await pg.end();

    const refundInQueue = queueContainsWa(items, WA_REFUND, pgRefund);
    const imageInQueue = queueContainsWa(items, WA_IMAGE, pgImage)
      || items.some((i) => i.next_action === 'unsupported' || i.queue_reason === 'unsupported_message_type');
    const partialInQueue = queueContainsWa(items, WA_PARTIAL, pgPartial);
    const completeInQueue = queueContainsWa(items, WA_COMPLETE, pgComplete);

    const sample = items[0] || null;
    const apiChecks = {
      http_200: apiRes.status === 200,
      success: apiRes.body && apiRes.body.success === true,
      includes_refund: refundInQueue,
      includes_unsupported: imageInQueue,
      excludes_partial: !partialInQueue,
      excludes_complete: !completeInQueue,
      has_created_at: sample && !!sample.created_at,
      has_queue_reason: sample && !!sample.queue_reason,
      has_from_phone: sample && !!sample.from_phone,
      no_raw_payload: !JSON.stringify(apiRes.body || {}).includes('raw_payload'),
      no_full_normalized: !JSON.stringify(apiRes.body || {}).includes('"normalized"'),
      refund_has_suggested_reply: items.some((i) => /refund/i.test(i.message_text || '') && i.suggested_reply),
    };

    out.api = {
      path: apiPath,
      http_status: apiRes.status,
      total_returned: items.length,
      wa_ids_in_db: {
        refund: pgRefund,
        image: pgImage,
        partial: pgPartial,
        complete: pgComplete,
      },
      sample_item_keys: sample ? Object.keys(sample) : [],
      sample_queue_reason: sample && sample.queue_reason,
      checks: apiChecks,
    };

    const uiRes = await req('GET', '/staff/ui', null, cookie, 'text/html');
    const { panelHtml, jsBlock } = extractHandoffUi(uiRes.raw || '');

    out.ui = {
      http_status: uiRes.status,
      needs_staff_panel: /id="handoff-queue-panel"/.test(uiRes.raw || ''),
      needs_staff_title: /Needs staff/.test(panelHtml),
      read_only_note: /Read-only Meta handoff queue/.test(panelHtml),
      refresh_button: /id="hq-refresh"/.test(panelHtml),
      phone_filter: /id="hq-filter-phone"/.test(panelHtml),
      fetches_handoffs_api: /\/staff\/inbox\/handoffs/.test(jsBlock || uiRes.raw || ''),
      copy_reply_button: /Copy reply|hq-copy-btn/.test(jsBlock || uiRes.raw || ''),
      no_send_in_panel: !/Approve\s*&amp;\s*Send|btn-send/.test(panelHtml),
      no_resolve: !/handoff\.resolve|Resolve handoff/i.test(panelHtml),
      no_guest_reply_send_in_handoff_js: jsBlock ? !jsBlock.includes('/staff/bot/guest-reply-send') : null,
      no_graph_stripe_n8n: !/(graph\.facebook\.com|api\.stripe\.com|tywoods\.app\.n8n)/.test(jsBlock || ''),
    };

    out.inclusion = {
      refund_in_queue: refundInQueue,
      image_in_queue: imageInQueue,
      partial_excluded: !partialInQueue,
      complete_excluded: !completeInQueue,
      seed_refund_next_action: out.seeds.refund.summary.next_action,
      seed_refund_handoff: out.seeds.refund.summary.handoff_required,
      seed_image_supported: out.seeds.image.summary.normalized_supported,
      seed_partial_next_action: out.seeds.partial.summary.next_action,
      seed_complete_eligible: out.seeds.complete.summary.preview_eligible,
    };

    out.safety = {
      guest_message_sends_sent: sent.rows.length,
      bookings_created: bookings.rows.length,
      payments_created: payments.rows.length,
      staff_handoffs_created: handoffCountBefore.rows[0].n,
      no_whatsapp_sends: sent.rows.length === 0,
      no_writes: bookings.rows.length === 0 && payments.rows.length === 0
        && handoffCountBefore.rows[0].n === 0,
    };

    out.env_after = stagingEnvFlags();
    out.health_after = (await req('GET', '/healthz')).status;
    out.revision_after = activeRevision();

    const apiPass = Object.values(apiChecks).every(Boolean);
    const uiPass = Object.values(out.ui).every((v) => v === true || v === null);
    const inclPass = refundInQueue && imageInQueue && !partialInQueue && !completeInQueue;
    const safetyPass = out.safety.no_whatsapp_sends && out.safety.no_writes;
    const seedPass = caseA.status === 200 && caseB.status === 200
      && out.seeds.refund.summary.next_action === 'handoff_to_staff'
      && out.seeds.refund.summary.handoff_required === true
      && out.seeds.image.summary.normalized_supported === false
      && out.seeds.partial.summary.next_action === 'ask_missing_field'
      && out.seeds.complete.summary.preview_eligible === true;

    if (apiPass && uiPass && inclPass && safetyPass && seedPass) {
      out.result = 'PASS';
    } else if (apiPass && inclPass && safetyPass) {
      out.result = 'PARTIAL';
    } else {
      out.result = 'FAIL';
    }
  } catch (err) {
    out.result = 'FAIL';
    out.error = err.message;
    out.revision_after = activeRevision();
    out.env_after = stagingEnvFlags();
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'PASS' ? 0 : 1);
})();
