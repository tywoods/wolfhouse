'use strict';
/** Stage 27demo-o.3 — one live confirmation send. Temp — do not commit. */
const { execSync } = require('child_process');
const { Client } = require('pg');
const { runGuestConfirmationPreviewDryRun } = require('./scripts/lib/luna-guest-confirmation-preview-dry-run');
const { runGuestConfirmationLiveSendAllowlisted } = require('./scripts/lib/luna-guest-confirmation-send-go-no-go');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_ID = '0ade1b48-2087-4ac1-8019-d3e651ab2c2b';
const BOOKING_CODE = 'WH-G27-0ECC1D9B57';
const TO_PHONE = '+34600995557';
const IDEM = `open-demo:27demo-o3:${BOOKING_CODE}:${Date.now()}`;

const RESTORE_ENV = {
  WHATSAPP_DRY_RUN: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'false',
};

const GATE_NAMES = [
  'WHATSAPP_DRY_RUN',
  'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST',
  'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED',
  'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED',
  'OPEN_DEMO_BOOKING_WRITES_ENABLED',
  'LUNA_AUTO_SEND_ENABLED',
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
    `SELECT b.booking_code, b.status::text AS booking_status,
            b.payment_status::text, b.amount_paid_cents, b.balance_due_cents,
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
  const sendsPhone = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends
      WHERE created_at >= $1::timestamptz AND to_phone = $2 AND send_kind = 'confirmation'`,
    [proofStart, TO_PHONE],
  );
  const sendsIdem = idemKey
    ? await pg.query(
      `SELECT id::text, status::text, provider_message_id, to_phone,
              LEFT(message_text, 200) AS excerpt, idempotency_key
         FROM guest_message_sends WHERE client_slug = $1 AND idempotency_key = $2`,
      [CLIENT, idemKey],
    )
    : { rows: [] };
  return {
    booking: bk.rows[0] || null,
    payments: pays.rows,
    confirmation_sends_during: sendsAll.rows[0].n,
    confirmation_sends_phone: sendsPhone.rows[0].n,
    idem_rows: sendsIdem.rows,
  };
}

function pickSend(out) {
  return {
    success: out.success,
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
    duplicate_send_blocked: out.duplicate_send_blocked,
    next_safe_step: out.next_safe_step,
    staff_notice: out.staff_notice,
  };
}

(async () => {
  const proofStart = new Date().toISOString();
  const proof = {
    stage: '27demo-o.3',
    explicit_approval_received: true,
    approved_recipient: TO_PHONE,
    booking_code: BOOKING_CODE,
    proof_start: proofStart,
    deploy_needed: false,
    code_changed: false,
    result: 'FAIL',
    failures: [],
  };

  let pg;
  try {
    proof.healthz = Number(execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${HOST}/healthz`, { encoding: 'utf8' }).trim());
    proof.revision = activeRevision();
    proof.gates_before = envPick(GATE_NAMES);

    pg = await pgConnect();
    const dbBefore = await dbSnap(pg, proofStart, null);
    proof.pre_state = dbBefore;
    proof.confirmation_sent_at_before = dbBefore.booking?.confirmation_sent_at;

    const dryEnv = buildProcessEnv(false);
    const previewDry = await runGuestConfirmationPreviewDryRun(
      { booking_id: BOOKING_ID, booking_code: BOOKING_CODE, client_slug: CLIENT, language_hint: 'en' },
      { pg, env: dryEnv, host_header: HOST },
    );
    proof.preview_text = previewDry.proposed_confirmation_message || '';

    const preBlocked = await runGuestConfirmationLiveSendAllowlisted(
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
    proof.pre_go_no_go = pickSend(preBlocked);

    console.error('[env] live confirmation window...');
    setLiveWindow();
    execSync('powershell -Command "Start-Sleep -Seconds 25"');
    proof.gates_during = envPick(GATE_NAMES);

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
      go_no_go: pickSend(liveSend),
      db: dbAfterLive,
      preview_excerpt: (previewLive.proposed_confirmation_message || '').slice(0, 400),
    };
    proof.confirmation_sent_at_after = dbAfterLive.booking?.confirmation_sent_at;

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
    proof.idempotency = {
      go_no_go: pickSend(idemRerun),
      confirmation_sends_during: dbAfterIdem.confirmation_sends_during,
      confirmation_sends_phone: dbAfterIdem.confirmation_sends_phone,
      idem_row_count: dbAfterIdem.idem_rows.length,
      confirmation_sent_at: dbAfterIdem.booking?.confirmation_sent_at,
      idem_rows: dbAfterIdem.idem_rows,
    };
    proof.post_state = dbAfterIdem;

    await pg.end();
    pg = null;

    console.error('[env] restoring gates...');
    restoreGates();
    execSync('powershell -Command "Start-Sleep -Seconds 20"');
    proof.gates_after = envPick(GATE_NAMES);
    proof.gates_restored = proof.gates_after.WHATSAPP_DRY_RUN === 'true'
      && proof.gates_after.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'false'
      && proof.gates_after.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'false'
      && proof.gates_after.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'false'
      && !proof.gates_after.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST;

    const msg = previewLive.proposed_confirmation_message || '';
    const checks = [
      ['healthz', proof.healthz === 200],
      ['pre_not_approved', preBlocked.send_status === 'not_approved'],
      ['preview_ready', previewLive.confirmation_preview_ready === true],
      ['live_sent', liveSend.send_status === 'sent' && liveSend.sends_whatsapp === true],
      ['live_confirm_sent', liveSend.confirmation_sent === true],
      ['provider_id', !!liveSend.whatsapp_message_id],
      ['sent_at_set', !!proof.confirmation_sent_at_after],
      ['msg_booking', msg.includes(BOOKING_CODE)],
      ['msg_paid', /€200|200/.test(msg)],
      ['msg_balance', /€398|398/.test(msg)],
      ['msg_gate', /2684#/.test(msg)],
      ['msg_room', /DEMO-R2/i.test(msg)],
      ['msg_address', /Somo|Mies de La Ran/i.test(msg)],
      ['payment_unchanged', dbBefore.booking.payment_status === dbAfterIdem.booking.payment_status
        && Number(dbBefore.booking.amount_paid_cents) === Number(dbAfterIdem.booking.amount_paid_cents)
        && Number(dbBefore.booking.balance_due_cents) === Number(dbAfterIdem.booking.balance_due_cents)],
      ['one_confirmation_send', dbAfterIdem.confirmation_sends_during === 1],
      ['one_phone_send', dbAfterIdem.confirmation_sends_phone === 1],
      ['idem_no_second_send', dbAfterIdem.idem_rows.length === 1],
      ['idem_replay', idemRerun.idempotent_replay === true || idemRerun.send_status === 'sent'],
      ['gates_restored', proof.gates_restored],
      ['stripe_unchanged', JSON.stringify(dbBefore.payments) === JSON.stringify(dbAfterIdem.payments)],
    ];
    proof.checks = Object.fromEntries(checks);
    for (const [n, ok] of checks) if (!ok) proof.failures.push(n);

    proof.result = proof.failures.length === 0 ? 'PASS'
      : (proof.failures.length <= 2 && liveSend.send_status === 'sent' ? 'PARTIAL' : 'FAIL');
    proof.recommended_next = proof.result === 'PASS'
      ? 'Stage 27demo closeout / open-demo pipeline complete for WH-G27-0ECC1D9B57'
      : `Fix: ${proof.failures.join(', ')}`;
  } catch (err) {
    proof.failures.push(err.message || String(err));
    proof.result = 'FAIL';
    if (pg) try { await pg.end(); } catch { /* ignore */ }
    try {
      restoreGates();
      proof.gates_after = envPick(GATE_NAMES);
      proof.gates_restored = proof.gates_after?.WHATSAPP_DRY_RUN === 'true';
    } catch (e2) {
      proof.rollback_error = e2.message;
    }
  }

  console.log(JSON.stringify(proof, null, 2));
  process.exit(proof.result === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error(e);
  try { restoreGates(); } catch { /* ignore */ }
  process.exit(1);
});
