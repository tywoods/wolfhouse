'use strict';
/** Stage 27demo-i — one live confirmation send. Temp — do not commit. */
const { execSync } = require('child_process');
const { Client } = require('pg');
const { runGuestConfirmationPreviewDryRun } = require('./scripts/lib/luna-guest-confirmation-preview-dry-run');
const { runGuestConfirmationLiveSendAllowlisted } = require('./scripts/lib/luna-guest-confirmation-send-go-no-go');

const COMMIT = '2d4dfde';
const IMAGE_TAG = `${COMMIT}-stage27demo-i-confirmation-send`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_LIVE = 's27demo-i-live';
const REV_RESTORE = 's27demo-i-restore';
const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_ID = 'ba1a0426-c1c7-469e-a7c4-edf9b89ee12d';
const BOOKING_CODE = 'WH-G27-850FDAFDB9';
const TO_PHONE = '+491726422307';
const IDEM = `open-demo:27demo-i:${BOOKING_CODE}:${Date.now()}`;

const RESTORE_ENV = {
  WHATSAPP_DRY_RUN: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'false',
  STRIPE_LINKS_ENABLED: 'true',
};

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

function deploy(skipBuild) {
  const rev = activeRevision();
  if (!skipBuild && !String(rev.image || '').includes(IMAGE_TAG)) {
    console.error('[deploy] acr build...');
    az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  } else {
    console.error('[deploy] skip build — image ready or exists');
  }
  console.error('[deploy] containerapp update image...');
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REV_LIVE}`,
    '-o none',
  ].join(' '));
  for (let i = 0; i < 45; i++) {
    const r = activeRevision();
    const hz = execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${HOST}/healthz`, { encoding: 'utf8' }).trim();
    if (String(r.image || '').includes(IMAGE_TAG) && r.health === 'Healthy' && r.traffic === 100 && hz === '200') {
      return { ...r, healthz: Number(hz) };
    }
    execSync('powershell -Command "Start-Sleep -Seconds 10"');
  }
  const r = activeRevision();
  const hz = execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${HOST}/healthz`, { encoding: 'utf8' }).trim();
  return { ...r, healthz: Number(hz) };
}

function setLiveWindow() {
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    '--set-env-vars',
    'WHATSAPP_DRY_RUN=false',
    'LUNA_AUTO_SEND_ENABLED=true',
    `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST=${TO_PHONE}`,
    'OPEN_DEMO_BOOKING_WRITES_ENABLED=false',
    'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=false',
    'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=false',
    'STRIPE_LINKS_ENABLED=false',
    'WHATSAPP_CLOUD_ACCESS_TOKEN=secretref:meta-whatsapp-token',
    'WHATSAPP_PHONE_NUMBER_ID=secretref:meta-whatsapp-phone-id',
    '-o none',
  ].join(' '));
}

function restoreGates() {
  const parts = Object.entries(RESTORE_ENV).map(([k, v]) => `${k}=${v}`);
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--revision-suffix ${REV_RESTORE}`,
    `--set-env-vars ${parts.join(' ')}`,
    '--remove-env-vars LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST',
    '-o none',
  ].join(' '));
}

function buildProcessEnv(live) {
  return {
    NODE_ENV: 'staging',
    WHATSAPP_DRY_RUN: live ? 'false' : 'true',
    LUNA_AUTO_SEND_ENABLED: 'true',
    LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST: TO_PHONE,
    OPEN_DEMO_BOOKING_WRITES_ENABLED: 'false',
    OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
    OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
    WHATSAPP_CLOUD_ACCESS_TOKEN: az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name meta-whatsapp-token --query value -o tsv'),
    WHATSAPP_PHONE_NUMBER_ID: az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name meta-whatsapp-phone-id --query value -o tsv'),
  };
}

async function pgConnect() {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

async function dbSnap(pg, proofStart, idemKey) {
  const bk = await pg.query(
    `SELECT b.booking_code, b.payment_status::text, b.amount_paid_cents, b.balance_due_cents,
            b.confirmation_sent_at, b.phone
       FROM bookings b WHERE b.id = $1::uuid`,
    [BOOKING_ID],
  );
  const pays = await pg.query(
    `SELECT id::text, status::text, amount_paid_cents, stripe_checkout_session_id
       FROM payments WHERE booking_id = $1::uuid ORDER BY created_at`,
    [BOOKING_ID],
  );
  const sendsAll = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends
      WHERE created_at >= $1::timestamptz AND send_kind = 'confirmation'`,
    [proofStart],
  );
  const sendsIdem = idemKey
    ? await pg.query(
      `SELECT id::text, status::text, provider_message_id, to_phone,
              LEFT(message_text, 200) AS excerpt, idempotency_key
         FROM guest_message_sends WHERE client_slug = $1 AND idempotency_key = $2`,
      [CLIENT, idemKey],
    )
    : { rows: [] };
  const dryErr = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends
      WHERE message_text LIKE '%LUNA_REVIEW_DRY_RUN_ERROR%'`,
  ).catch(() => ({ rows: [{ n: 0 }] }));
  return {
    booking: bk.rows[0] || null,
    payments: pays.rows,
    confirmation_sends_during: sendsAll.rows[0].n,
    idem_rows: sendsIdem.rows,
    dry_run_errors: dryErr.rows[0].n,
  };
}

function pickSend(out) {
  return {
    send_status: out.send_status,
    send_attempted: out.send_attempted,
    sends_whatsapp: out.sends_whatsapp,
    confirmation_sent: out.confirmation_sent,
    guest_message_send_status: out.guest_message_send_status,
    whatsapp_message_id: out.whatsapp_message_id,
    provider_message_id: out.whatsapp_message_id,
    guest_message_send_id: out.guest_message_send_id,
    block_reasons: out.block_reasons || null,
    idempotent_replay: out.idempotent_replay,
    next_safe_step: out.next_safe_step,
  };
}

(async () => {
  const proofStart = new Date().toISOString();
  const proof = {
    result: 'FAIL',
    commit: COMMIT,
    image_tag: IMAGE_TAG,
    revision: null,
    pre_live: null,
    live_send: null,
    idempotency_rerun: null,
    confirmation_sent_at_before: null,
    confirmation_sent_at_after: null,
    gates_restored: false,
    failures: [],
  };

  let pg;
  try {
    const skipBuild = process.argv.includes('--skip-build');
    proof.revision = deploy(skipBuild);
    execSync('powershell -Command "Start-Sleep -Seconds 15"');

    pg = await pgConnect();
    const dbBefore = await dbSnap(pg, proofStart, null);
    proof.confirmation_sent_at_before = dbBefore.booking && dbBefore.booking.confirmation_sent_at;

    const dryEnv = buildProcessEnv(false);
    const previewDry = await runGuestConfirmationPreviewDryRun(
      { booking_id: BOOKING_ID, booking_code: BOOKING_CODE, client_slug: CLIENT, language_hint: 'en' },
      { pg, env: dryEnv, host_header: HOST },
    );
    const preLive = await runGuestConfirmationLiveSendAllowlisted(
      {
        confirmation_preview_result: previewDry,
        confirm_send: false,
        to: TO_PHONE,
        idempotency_key: `${IDEM}:pre`,
        client_slug: CLIENT,
        booking_id: BOOKING_ID,
        booking_code: BOOKING_CODE,
      },
      { pg, env: dryEnv },
    );
    const sendsAfterPre = await dbSnap(pg, proofStart, `${IDEM}:pre`);
    proof.pre_live = {
      preview_ready: previewDry.confirmation_preview_ready,
      go_no_go: pickSend(preLive),
      confirmation_sent_at: sendsAfterPre.booking && sendsAfterPre.booking.confirmation_sent_at,
      new_confirmation_sends: sendsAfterPre.confirmation_sends_during,
    };

    console.error('[env] live confirmation window...');
    setLiveWindow();
    execSync('powershell -Command "Start-Sleep -Seconds 25"');

    const liveEnv = buildProcessEnv(true);
    const previewLive = await runGuestConfirmationPreviewDryRun(
      { booking_id: BOOKING_ID, booking_code: BOOKING_CODE, client_slug: CLIENT, language_hint: 'en' },
      { pg, env: liveEnv, host_header: HOST },
    );

    const liveSend = await runGuestConfirmationLiveSendAllowlisted(
      {
        confirmation_preview_result: previewLive,
        confirm_send: true,
        to: TO_PHONE,
        idempotency_key: IDEM,
        client_slug: CLIENT,
        booking_id: BOOKING_ID,
        booking_code: BOOKING_CODE,
      },
      { pg, env: liveEnv },
    );

    const dbAfterLive = await dbSnap(pg, proofStart, IDEM);
    proof.live_send = {
      preview: {
        room_label: previewLive.room_label,
        message_excerpt: (previewLive.proposed_confirmation_message || '').slice(0, 400),
      },
      go_no_go: pickSend(liveSend),
      db: dbAfterLive,
    };
    proof.confirmation_sent_at_after = dbAfterLive.booking && dbAfterLive.booking.confirmation_sent_at;

    const idemRerun = await runGuestConfirmationLiveSendAllowlisted(
      {
        confirmation_preview_result: previewLive,
        confirm_send: true,
        to: TO_PHONE,
        idempotency_key: IDEM,
        client_slug: CLIENT,
        booking_id: BOOKING_ID,
        booking_code: BOOKING_CODE,
      },
      { pg, env: liveEnv },
    );
    const dbAfterIdem = await dbSnap(pg, proofStart, IDEM);
    proof.idempotency_rerun = {
      go_no_go: pickSend(idemRerun),
      confirmation_sends_during: dbAfterIdem.confirmation_sends_during,
      idem_row_count: dbAfterIdem.idem_rows.length,
      confirmation_sent_at: dbAfterIdem.booking && dbAfterIdem.booking.confirmation_sent_at,
    };

    await pg.end();
    pg = null;

    console.error('[env] restoring gates...');
    restoreGates();
    execSync('powershell -Command "Start-Sleep -Seconds 20"');
    const restored = envPick(Object.keys(RESTORE_ENV).concat(['LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST']));
    proof.gates_after_restore = restored;
    proof.gates_restored = restored.WHATSAPP_DRY_RUN === 'true'
      && restored.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'false'
      && restored.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'false'
      && restored.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'false';

    const msg = previewLive.proposed_confirmation_message || '';
    const checks = [
      ['revision_image', String(proof.revision.image || '').includes(IMAGE_TAG)],
      ['healthz', proof.revision.healthz === 200],
      ['pre_not_approved', preLive.send_status === 'not_approved'],
      ['pre_no_send', preLive.send_attempted !== true],
      ['pre_sent_at_null', !proof.pre_live.confirmation_sent_at],
      ['pre_zero_sends', proof.pre_live.new_confirmation_sends === 0],
      ['preview_ready', previewLive.confirmation_preview_ready === true],
      ['live_sent', liveSend.send_status === 'sent' && liveSend.sends_whatsapp === true],
      ['live_confirm_sent', liveSend.confirmation_sent === true],
      ['provider_id', !!liveSend.whatsapp_message_id],
      ['sent_at_set', !!proof.confirmation_sent_at_after],
      ['msg_booking', msg.includes(BOOKING_CODE)],
      ['msg_paid', /€200|200/.test(msg)],
      ['msg_balance', /€498|498/.test(msg)],
      ['msg_gate', /2684#/.test(msg)],
      ['msg_room', /DEMO-R2/i.test(msg)],
      ['msg_address', /Somo|Mies de La Ran/i.test(msg)],
      ['payment_unchanged', dbBefore.booking.payment_status === dbAfterIdem.booking.payment_status
        && Number(dbBefore.booking.amount_paid_cents) === Number(dbAfterIdem.booking.amount_paid_cents)],
      ['one_confirmation_send', dbAfterIdem.confirmation_sends_during === 1],
      ['idem_no_second_send', dbAfterIdem.idem_rows.length === 1],
      ['idem_replay', idemRerun.idempotent_replay === true || idemRerun.send_status === 'sent'],
      ['gates_restored', proof.gates_restored],
      ['no_dry_run_errors', dbAfterIdem.dry_run_errors === 0],
    ];
    proof.checks = Object.fromEntries(checks);
    for (const [n, ok] of checks) if (!ok) proof.failures.push(n);

    proof.result = proof.failures.length === 0 ? 'PASS'
      : (proof.failures.length <= 2 && liveSend.send_status === 'sent' ? 'PARTIAL' : 'FAIL');
  } catch (err) {
    proof.failures.push(err.message || String(err));
    proof.result = 'FAIL';
    if (pg) try { await pg.end(); } catch { /* ignore */ }
    try { restoreGates(); proof.gates_restored = true; } catch { /* ignore */ }
  }

  console.log(JSON.stringify(proof, null, 2));
  process.exit(proof.result === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error(e);
  try { restoreGates(); } catch { /* ignore */ }
  process.exit(1);
});
