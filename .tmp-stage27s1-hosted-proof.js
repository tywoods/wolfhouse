'use strict';
/** Stage 27s.1 — one allowlisted confirmation live send. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const { runGuestConfirmationPreviewDryRun } = require('./scripts/lib/luna-guest-confirmation-preview-dry-run');
const { runGuestConfirmationLiveSendAllowlisted } = require('./scripts/lib/luna-guest-confirmation-send-go-no-go');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = 'b23f446';
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${COMMIT}-stage27s1-live-send-allowlist`;
const PROOF_SUFFIX = 'stage27s1-live-send';
const RESTORE_SUFFIX = 'stage27s1-restore-dryrun';
const PROOF_START = new Date().toISOString();

const BOOKING_ID = '828538c7-c6cb-4c6f-b45a-57a641af37cc';
const BOOKING_CODE = 'MB-WOLFHO-20260924-e90132';
const ALLOWLISTED_TO = '+491726422307';
const NON_ALLOWLISTED_TO = '+34600000099';
const IDEM = `stage27s1-confirmation:${COMMIT}:${Date.now()}`;

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 }).trim();
}

function req(method, path) {
  return new Promise((resolve, reject) => {
    const r = https.request({ hostname: HOST, path, method, headers: { Accept: 'application/json' } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let body = raw;
        try { body = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, body });
      });
    });
    r.on('error', reject);
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
    return row.value != null ? String(row.value) : '(unset)';
  };
  return {
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
    LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST: pick('LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST'),
    WHATSAPP_CLOUD_ACCESS_TOKEN: pick('WHATSAPP_CLOUD_ACCESS_TOKEN'),
    WHATSAPP_PHONE_NUMBER_ID: pick('WHATSAPP_PHONE_NUMBER_ID'),
  };
}

async function pgConnect() {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

async function dbSafetySnapshot(pg) {
  const bk = await pg.query(`
    SELECT b.id::text, b.booking_code, b.status::text AS booking_status,
           b.payment_status::text, b.amount_paid_cents, b.balance_due_cents,
           b.confirmation_sent_at
      FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND b.id = $2::uuid`, [CLIENT, BOOKING_ID]);

  const pays = await pg.query(`
    SELECT id::text AS payment_id, status::text, payment_kind::text,
           amount_due_cents, amount_paid_cents, paid_at
      FROM payments WHERE booking_id = $1::uuid ORDER BY created_at`, [BOOKING_ID]);

  const sends = await pg.query(`
    SELECT id::text, status, idempotency_key, provider_message_id, send_kind,
           to_phone, LEFT(message_text, 160) AS excerpt, created_at
      FROM guest_message_sends
     WHERE client_slug = $1 AND idempotency_key = $2
     ORDER BY created_at`, [CLIENT, IDEM]);

  const sentDuring = await pg.query(`
    SELECT COUNT(*)::int AS n FROM guest_message_sends
     WHERE client_slug = $1 AND created_at >= $2::timestamptz AND status = 'sent'`,
    [CLIENT, PROOF_START]);

  return {
    booking: bk.rows[0] || null,
    payments: pays.rows,
    guest_message_send: sends.rows,
    sent_during_proof: sentDuring.rows[0].n,
  };
}

function buildProcessEnvFromStaging() {
  const flags = stagingEnvFlags();
  return {
    NODE_ENV: 'production',
    WHATSAPP_DRY_RUN: flags.WHATSAPP_DRY_RUN === 'false' ? 'false' : 'true',
    LUNA_AUTO_SEND_ENABLED: flags.LUNA_AUTO_SEND_ENABLED === 'true' ? 'true' : 'false',
    LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST: flags.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST === '(unset)'
      ? ALLOWLISTED_TO
      : flags.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST,
    WHATSAPP_CLOUD_ACCESS_TOKEN: az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name meta-whatsapp-token --query value -o tsv'),
    WHATSAPP_PHONE_NUMBER_ID: az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name meta-whatsapp-phone-id --query value -o tsv'),
  };
}

async function waitHealthy(revSuffix, timeoutMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rev = activeRevision();
    const hz = await req('GET', '/healthz');
    if (rev.health === 'Healthy' && rev.traffic === 100
        && String(rev.name || '').includes(revSuffix) && hz.status === 200) {
      return rev;
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  return activeRevision();
}

function deployProofRevision() {
  console.log('Building image via ACR...');
  const buildOut = az(`az acr build --registry whstagingacr --image wh-staff-api:${COMMIT}-stage27s1-live-send-allowlist --file Dockerfile .`);
  const runMatch = buildOut.match(/"runId":\s*"([^"]+)"/) || buildOut.match(/Run ID: (\S+)/);
  console.log('ACR build done', runMatch ? runMatch[1] : '');

  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${PROOF_SUFFIX}`,
    '--set-env-vars',
    'WHATSAPP_DRY_RUN=false',
    'LUNA_AUTO_SEND_ENABLED=true',
    `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST=${ALLOWLISTED_TO}`,
    'WHATSAPP_CLOUD_ACCESS_TOKEN=secretref:meta-whatsapp-token',
    'WHATSAPP_PHONE_NUMBER_ID=secretref:meta-whatsapp-phone-id',
    'STRIPE_LINKS_ENABLED=false',
  ].join(' '));
}

function restoreDryRunRevision() {
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${RESTORE_SUFFIX}`,
    '--set-env-vars WHATSAPP_DRY_RUN=true STRIPE_LINKS_ENABLED=false',
    '--remove-env-vars LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST',
  ].join(' '));
}

(async () => {
  const out = {
    phase: '27s.1',
    commit: COMMIT,
    image: IMAGE,
    proof_start: PROOF_START,
    booking_id: BOOKING_ID,
    booking_code: BOOKING_CODE,
    allowlisted_to: ALLOWLISTED_TO,
    idempotency_key: IDEM,
    health_before: null,
    revision_before: null,
    env_before: null,
    revision_deployed: null,
    env_during: null,
    health_during: null,
    step_preview_27q: null,
    step_not_approved: null,
    step_non_allowlisted: null,
    step_allowlisted_live: null,
    db_before: null,
    db_after: null,
    revision_restored: null,
    env_after: null,
    health_after: null,
    step_dryrun_block_after_restore: null,
    result: 'PENDING',
  };

  try {
    out.health_before = (await req('GET', '/healthz')).status;
    out.revision_before = activeRevision();
    out.env_before = stagingEnvFlags();

    deployProofRevision();
    out.revision_deployed = await waitHealthy(PROOF_SUFFIX);
    out.env_during = stagingEnvFlags();
    out.health_during = (await req('GET', '/healthz')).status;

    if (out.env_during.WHATSAPP_DRY_RUN !== 'false') throw new Error('WHATSAPP_DRY_RUN not false during proof');
    if (!String(out.env_during.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST).includes('491726422307')) {
      throw new Error('allowlist not set during proof');
    }

    const pg = await pgConnect();
    out.db_before = await dbSafetySnapshot(pg);

    const processEnv = buildProcessEnvFromStaging();

    const preview = await runGuestConfirmationPreviewDryRun(
      { booking_id: BOOKING_ID, booking_code: BOOKING_CODE, client_slug: CLIENT },
      { pg, env: processEnv },
    );
    out.step_preview_27q = {
      confirmation_preview_ready: preview.confirmation_preview_ready,
      next_safe_step: preview.next_safe_step,
      message_len: (preview.proposed_confirmation_message || '').length,
      has_gate: /2684#/.test(preview.proposed_confirmation_message || ''),
      preview_regenerated: preview.preview_regenerated,
    };

    const previewResult = preview;
    const baseInput = {
      confirmation_preview_result: previewResult,
      client_slug: CLIENT,
      booking_id: BOOKING_ID,
      booking_code: BOOKING_CODE,
      idempotency_key: IDEM,
    };

    out.step_not_approved = await runGuestConfirmationLiveSendAllowlisted(
      { ...baseInput, to: ALLOWLISTED_TO, confirm_send: false },
      { pg, env: processEnv },
    );

    out.step_non_allowlisted = await runGuestConfirmationLiveSendAllowlisted(
      { ...baseInput, to: NON_ALLOWLISTED_TO, confirm_send: true },
      { pg, env: processEnv },
    );

    out.step_allowlisted_live = await runGuestConfirmationLiveSendAllowlisted(
      { ...baseInput, to: ALLOWLISTED_TO, confirm_send: true },
      { pg, env: processEnv },
    );

    out.db_after = await dbSafetySnapshot(pg);
    await pg.end();

    restoreDryRunRevision();
    out.revision_restored = await waitHealthy(RESTORE_SUFFIX);
    out.env_after = stagingEnvFlags();
    out.health_after = (await req('GET', '/healthz')).status;

    const pg2 = await pgConnect();
    const previewAfter = await runGuestConfirmationPreviewDryRun(
      { booking_id: BOOKING_ID, booking_code: BOOKING_CODE, client_slug: CLIENT },
      { pg: pg2, env: { ...buildProcessEnvFromStaging(), WHATSAPP_DRY_RUN: 'true' } },
    );
    out.step_dryrun_block_after_restore = await runGuestConfirmationLiveSendAllowlisted(
      {
        confirmation_preview_result: previewAfter,
        confirm_send: true,
        to: ALLOWLISTED_TO,
        idempotency_key: `${IDEM}-restore-check`,
        client_slug: CLIENT,
        booking_id: BOOKING_ID,
        booking_code: BOOKING_CODE,
      },
      { pg: pg2, env: { WHATSAPP_DRY_RUN: 'true', LUNA_AUTO_SEND_ENABLED: 'true', LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST: ALLOWLISTED_TO } },
    );
    await pg2.end();

    const checks = {
      health_before_200: out.health_before === 200,
      health_during_200: out.health_during === 200,
      health_after_200: out.health_after === 200,
      preview_ready: preview.confirmation_preview_ready === true,
      preview_next: preview.next_safe_step === 'ready_for_confirmation_send_go_no_go',
      not_approved: out.step_not_approved.send_status === 'not_approved'
        && out.step_not_approved.send_attempted === false,
      non_allowlisted: out.step_non_allowlisted.send_status === 'recipient_not_allowlisted'
        && out.step_non_allowlisted.sends_whatsapp !== true,
      live_sent: out.step_allowlisted_live.send_status === 'sent'
        && out.step_allowlisted_live.sends_whatsapp === true
        && out.step_allowlisted_live.preview_regenerated === false,
      message_match: out.step_allowlisted_live.proposed_confirmation_message
        === preview.proposed_confirmation_message,
      no_payment_mutation: JSON.stringify(out.db_before.payments) === JSON.stringify(out.db_after.payments),
      booking_status_unchanged: out.db_before.booking?.booking_status === out.db_after.booking?.booking_status,
      one_send_audit: out.db_after.sent_during_proof === 1,
      restored_dry_run: out.env_after.WHATSAPP_DRY_RUN === 'true',
      dryrun_blocks_after: out.step_dryrun_block_after_restore.send_status === 'blocked_dry_run',
    };

    out.checks = checks;
    out.result = Object.values(checks).every(Boolean) ? 'PASS' : 'PARTIAL';
  } catch (e) {
    out.result = 'FAIL';
    out.error = e.message;
    try { restoreDryRunRevision(); } catch (_) { /* best effort */ }
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'PASS' ? 0 : 1);
})();
