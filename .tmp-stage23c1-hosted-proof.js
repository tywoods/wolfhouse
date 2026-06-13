'use strict';
/** Phase 23c.1 — hosted handoff review proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = '4700746';
const IMAGE_TAG = `${COMMIT}-stage23c1-handoff-review`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 'stage23c1-handoff-review';
const ROUTE = '/staff/meta/whatsapp/webhook';
const TEST_FROM = '491726422307';
const PROFILE = 'Phase 23c Review Proof';
const PROOF_START = new Date().toISOString();
const REVIEW_NOTE = 'Phase 23c.1 hosted proof';
const LOGIN = {
  client: CLIENT,
  email: 'operator.stage72c@example.test',
  password: 'OperatorPass123!',
};

const WA_REFUND_EXISTING = 'wamid.phase23b1.refund.001';
const WA_REFUND_NEW = 'wamid.phase23c1.review.refund.001';
const TEXT_REFUND = 'I want a refund and need to talk to someone.';

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

function metaText(waId, text, profile) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '34663439419', phone_number_id: '1152900101233109' },
          contacts: [{ profile: { name: profile || PROFILE }, wa_id: TEST_FROM }],
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

async function eventByWa(pg, waId) {
  const r = await pg.query(
    `SELECT id::text, wa_message_id, next_action, handoff_required, message_text,
            normalized->'handoff_review' AS handoff_review,
            normalized->>'supported' AS supported
       FROM guest_message_events
      WHERE client_slug = $1 AND wa_message_id = $2`,
    [CLIENT, waId],
  );
  return r.rows[0] || null;
}

function findQueueItem(items, waRow) {
  if (!waRow) return null;
  const text = waRow.message_text || '';
  return (items || []).find((i) => i.message_text === text || i.id === waRow.id) || null;
}

function extractHandoffUi(html) {
  const panel = html.match(/id="handoff-queue-panel"[\s\S]{0,4000}/);
  const panelHtml = panel ? panel[0] : '';
  const js = html.match(/function buildHandoffsQueueUrl\(\)[\s\S]{0,6000}/);
  return { panelHtml, jsBlock: js ? js[0] : '' };
}

(async () => {
  const out = {
    phase: '23c.1-hosted',
    proof_start: PROOF_START,
    commit: COMMIT,
    image: IMAGE,
    revision: null,
    env_before: null,
    env_after: null,
    health: {},
    deploy: null,
    target: null,
    step_a: null,
    step_b: null,
    step_c: null,
    step_d: null,
    step_e: null,
    ui: null,
    db: null,
    safety: null,
    result: 'PENDING',
  };

  try {
    out.revision_before = activeRevision();
    out.env_before = stagingEnvFlags();
    out.health.before = (await req('GET', '/healthz')).status;

    const alreadyDeployed = String(out.revision_before.image || '').includes(COMMIT.slice(0, 7));
    if (!alreadyDeployed) {
      deploySafeRevision();
      out.deploy = { built: true, image: IMAGE, revision_suffix: REV_SUFFIX };
      out.revision = await waitHealthy();
    } else {
      out.deploy = { built: false, skipped: 'already on commit' };
      out.revision = out.revision_before;
    }

    if (out.revision.health !== 'Healthy' || out.revision.traffic !== 100) {
      throw new Error(`revision not healthy: ${JSON.stringify(out.revision)}`);
    }
    out.health.after_deploy = (await req('GET', '/healthz')).status;
    if (out.health.after_deploy !== 200) throw new Error('healthz not 200 after deploy');
    out.env_after_deploy = stagingEnvFlags();

    const cookie = await staffLogin();
    const listPath = `/staff/inbox/handoffs?client_slug=${encodeURIComponent(CLIENT)}&from_phone=${encodeURIComponent(TEST_FROM)}&limit=20`;

    let pg = await pgConnect();
    let targetWa = WA_REFUND_EXISTING;
    let pgRow = await eventByWa(pg, WA_REFUND_EXISTING);

    const alreadyReviewed = pgRow && pgRow.handoff_review
      && (pgRow.handoff_review.reviewed === true || pgRow.handoff_review.reviewed === 'true');

    if (!pgRow || alreadyReviewed) {
      targetWa = WA_REFUND_NEW;
      console.error(alreadyReviewed ? 'Existing row reviewed — seeding fresh event' : 'Existing row missing — seeding fresh event');
      const seed = await req('POST', ROUTE, metaText(WA_REFUND_NEW, TEXT_REFUND));
      await new Promise((r) => setTimeout(r, 1500));
      pgRow = await eventByWa(pg, WA_REFUND_NEW);
      out.seed = {
        wa_message_id: WA_REFUND_NEW,
        http: seed.status,
        event_persisted: seed.body && seed.body.event_persisted,
        handoff_required: seed.body && seed.body.handoff_required,
        next_action: seed.body && seed.body.next_action,
      };
      if (!pgRow) throw new Error('seed event not found in DB');
      if (seed.body && seed.body.handoff_required !== true) {
        throw new Error(`seed handoff_required expected true, got ${seed.body.handoff_required}`);
      }
    } else {
      out.seed = { wa_message_id: WA_REFUND_EXISTING, reused: true, pg_row: { id: pgRow.id, handoff_required: pgRow.handoff_required } };
    }

    out.target = {
      event_id: pgRow.id,
      wa_message_id: targetWa,
      message_text: pgRow.message_text,
      handoff_review_before: pgRow.handoff_review,
    };

    // Step A — before review
    const stepA = await req('GET', listPath, null, cookie);
    const itemsA = stepA.body && stepA.body.items ? stepA.body.items : [];
    const itemA = findQueueItem(itemsA, pgRow);
    out.step_a = {
      http: stepA.status,
      success: stepA.body && stepA.body.success,
      target_in_queue: !!itemA,
      target_id: itemA && itemA.id,
      handoff_review_absent: itemA ? !itemA.handoff_review : null,
      suggested_reply_present: itemA ? !!itemA.suggested_reply : null,
      total_returned: itemsA.length,
    };

    if (stepA.status !== 200 || !itemA) {
      throw new Error(`Step A failed: target not in default queue (status ${stepA.status})`);
    }

    // Step B — review
    const reviewPath = `/staff/inbox/handoffs/${encodeURIComponent(pgRow.id)}/review`;
    const stepB = await req('POST', reviewPath, { client_slug: CLIENT, review_note: REVIEW_NOTE }, cookie);
    const hr = stepB.body && stepB.body.handoff_review;
    out.step_b = {
      http: stepB.status,
      success: stepB.body && stepB.body.success,
      reviewed: hr && hr.reviewed,
      reviewed_at: hr && hr.reviewed_at,
      reviewed_by: hr && hr.reviewed_by,
      review_note: hr && hr.review_note,
      no_whatsapp: stepB.body && stepB.body.no_whatsapp,
      no_staff_handoffs_write: stepB.body && stepB.body.no_staff_handoffs_write,
      already_reviewed: stepB.body && stepB.body.already_reviewed,
    };
    const reviewedAtB = hr && hr.reviewed_at;

    if (stepB.status !== 200 || !stepB.body || !stepB.body.success || !hr || hr.reviewed !== true) {
      throw new Error(`Step B failed: ${JSON.stringify(out.step_b)}`);
    }

    // Step C — default queue after
    const stepC = await req('GET', listPath, null, cookie);
    const itemsC = stepC.body && stepC.body.items ? stepC.body.items : [];
    const itemC = findQueueItem(itemsC, pgRow);
    out.step_c = {
      http: stepC.status,
      target_absent: !itemC,
      total_returned: itemsC.length,
      other_rows_may_remain: itemsC.length >= 0,
    };

    // Step D — include reviewed
    const listIncPath = `${listPath}&include_reviewed=true`;
    const stepD = await req('GET', listIncPath, null, cookie);
    const itemsD = stepD.body && stepD.body.items ? stepD.body.items : [];
    const itemD = findQueueItem(itemsD, pgRow);
    const hrd = itemD && itemD.handoff_review;
    out.step_d = {
      http: stepD.status,
      target_present: !!itemD,
      handoff_review_reviewed: hrd && hrd.reviewed,
      reviewed_at_matches_b: hrd && hrd.reviewed_at === reviewedAtB,
      reviewed_by_present: !!(hrd && hrd.reviewed_by),
      review_note: hrd && hrd.review_note,
    };

    // Step E — idempotent repeat
    const stepE = await req('POST', reviewPath, { client_slug: CLIENT, review_note: 'repeat should not change' }, cookie);
    const hre = stepE.body && stepE.body.handoff_review;
    out.step_e = {
      http: stepE.status,
      already_reviewed: stepE.body && stepE.body.already_reviewed,
      reviewed_at_unchanged: hre && hre.reviewed_at === reviewedAtB,
      success: stepE.body && stepE.body.success,
    };

    // DB proof
    const pgAfter = await eventByWa(pg, targetWa);
    const dbHr = pgAfter && pgAfter.handoff_review;
    out.db = {
      event_id: pgAfter && pgAfter.id,
      handoff_review: dbHr,
      reviewed_true: dbHr && (dbHr.reviewed === true || dbHr.reviewed === 'true'),
      reviewed_at_present: !!(dbHr && dbHr.reviewed_at),
      reviewed_by_present: !!(dbHr && dbHr.reviewed_by),
      review_note: dbHr && dbHr.review_note,
    };

    const handoffsBefore = await pg.query(
      'SELECT COUNT(*)::int AS n FROM staff_handoffs WHERE created_at >= $1::timestamptz',
      [PROOF_START],
    );
    const handoffsUpdated = await pg.query(
      'SELECT COUNT(*)::int AS n FROM staff_handoffs WHERE updated_at >= $1::timestamptz',
      [PROOF_START],
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

    // UI static proof from deployed HTML
    const uiRes = await req('GET', '/staff/ui', null, cookie, 'text/html');
    const { panelHtml, jsBlock } = extractHandoffUi(uiRes.raw || '');
    out.ui = {
      http_status: uiRes.status,
      needs_staff_panel: /id="handoff-queue-panel"/.test(uiRes.raw || ''),
      mark_reviewed_button: /Mark reviewed|hq-review-btn/.test(jsBlock || uiRes.raw || ''),
      mark_reviewed_route: /\/staff\/inbox\/handoffs\/.*\/review/.test(jsBlock || ''),
      read_only_note: /Read-only Meta handoff queue/.test(panelHtml),
      no_send: !/Approve\s*&amp;\s*Send|btn-send/.test(panelHtml + jsBlock),
      no_resolve: !/handoff\.resolve|Resolve handoff/i.test(panelHtml),
      no_guest_reply_send: jsBlock ? !jsBlock.includes('/staff/bot/guest-reply-send') : null,
      no_graph_stripe_n8n: !/(graph\.facebook\.com|api\.stripe\.com|tywoods\.app\.n8n)/.test(jsBlock || ''),
      reload_after_review: /loadHandoffsQueue/.test(jsBlock || ''),
    };

    out.safety = {
      guest_message_sends_sent: sent.rows.length,
      bookings_created: bookings.rows.length,
      payments_created: payments.rows.length,
      staff_handoffs_created: handoffsBefore.rows[0].n,
      staff_handoffs_updated: handoffsUpdated.rows[0].n,
      no_whatsapp_sends: sent.rows.length === 0,
      no_staff_handoffs_writes: handoffsBefore.rows[0].n === 0 && handoffsUpdated.rows[0].n === 0,
      no_booking_payment_writes: bookings.rows.length === 0 && payments.rows.length === 0,
    };

    out.env_after = stagingEnvFlags();
    out.health.after = (await req('GET', '/healthz')).status;
    out.revision_after = activeRevision();

    const stepAPass = out.step_a.http === 200 && out.step_a.target_in_queue && out.step_a.handoff_review_absent !== false;
    const stepBPass = out.step_b.http === 200 && out.step_b.success && out.step_b.reviewed
      && out.step_b.no_whatsapp && out.step_b.no_staff_handoffs_write;
    const stepCPass = out.step_c.target_absent === true;
    const stepDPass = out.step_d.target_present && out.step_d.handoff_review_reviewed
      && out.step_d.reviewed_at_matches_b;
    const stepEPass = out.step_e.http === 200 && out.step_e.already_reviewed && out.step_e.reviewed_at_unchanged;
    const dbPass = out.db.reviewed_true && out.db.reviewed_at_present && out.db.reviewed_by_present;
    const uiPass = out.ui.mark_reviewed_button && out.ui.no_send && out.ui.no_resolve && out.ui.no_guest_reply_send;
    const safetyPass = out.safety.no_whatsapp_sends && out.safety.no_staff_handoffs_writes && out.safety.no_booking_payment_writes;
    const envPass = out.env_after.WHATSAPP_DRY_RUN === 'true'
      && out.env_after.STRIPE_LINKS_ENABLED === 'false'
      && out.env_after.LUNA_AUTO_SEND_ENABLED === '(unset)'
      && out.env_after.BOT_BOOKING_ENABLED === '(unset)';

    if (stepAPass && stepBPass && stepCPass && stepDPass && stepEPass && dbPass && uiPass && safetyPass && envPass) {
      out.result = 'PASS';
    } else if (stepBPass && stepCPass && stepDPass && dbPass && safetyPass) {
      out.result = 'PARTIAL';
    } else {
      out.result = 'FAIL';
    }
    out.checks = { stepAPass, stepBPass, stepCPass, stepDPass, stepEPass, dbPass, uiPass, safetyPass, envPass };
  } catch (err) {
    out.result = 'FAIL';
    out.error = err.message;
    try {
      out.revision_after = activeRevision();
      out.env_after = stagingEnvFlags();
      out.health.after = (await req('GET', '/healthz')).status;
    } catch { /* ignore */ }
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'PASS' ? 0 : 1);
})();
