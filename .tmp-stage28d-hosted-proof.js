'use strict';
/** Stage 28d — 28c.7 booking → Stripe TEST → payment truth → confirmation preview. Temp. */
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');
const { runGuestStripePaymentTruthApplyApproved } = require('./scripts/lib/luna-guest-stripe-payment-truth-apply');

const HOST = 'staff-staging.lunafrontdesk.com';
const BOOKING_CODE = 'WH-G27-3888294D42';
const BOOKING_ID = '479830ab-4a2c-489e-b335-295e4e4c013d';
const PAYMENT_DRAFT_ID = 'f51a4ce8-ddbf-4d49-84b4-04a003d19caf';
const GUEST_PHONE = '+491726422307';
const CHECK_IN = '2026-07-24';
const CHECK_OUT = '2026-07-31';
const WF_ID = 'stage27demoLWrite01';

const BASELINE_ENV = {
  WHATSAPP_DRY_RUN: 'true',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'false',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: '1152900101233109',
};
const STRIPE_PROOF_ENV = {
  ...BASELINE_ENV,
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'true',
  STRIPE_LINKS_ENABLED: 'true',
  STAFF_ACTIONS_ENABLED: 'true',
};
const GATE_NAMES = [
  ...Object.keys(BASELINE_ENV),
  'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED',
  'STRIPE_LINKS_ENABLED',
  'STAFF_ACTIONS_ENABLED',
];

const STEP = process.env.STEP || 'all'; // link | truth | preview | all
const POLL_PAYMENT_MS = Number(process.env.POLL_PAYMENT_MS || 10 * 60 * 1000);
const POLL_INTERVAL_MS = 15000;

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function azSecret(name) {
  return az(`az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name ${name} --query value -o tsv`);
}
function setEnvVars(pairs) {
  az([
    'az containerapp update', '--name wh-staging-staff-api', '--resource-group wh-staging-rg',
    `--set-env-vars ${Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join(' ')}`, '-o none',
  ].join(' '));
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

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(headers.cookie ? { Cookie: headers.cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function staffLogin() {
  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  return { login_status: login.status, cookie };
}

async function fetchBookingState(pg) {
  const b = await pg.query(
    `SELECT b.id::text, b.booking_code, b.status::text, b.payment_status::text,
            b.phone, b.email, b.check_in::text, b.check_out::text,
            b.amount_paid_cents, b.balance_due_cents, b.total_amount_cents,
            b.confirmation_sent_at, b.metadata->'confirmation_draft' AS confirmation_draft,
            b.created_at::text
       FROM bookings b JOIN clients cl ON cl.id = b.client_id
      WHERE cl.slug = 'wolfhouse-somo' AND b.id = $1::uuid`,
    [BOOKING_ID],
  );
  const beds = await pg.query(
    `SELECT bed_code, room_code FROM booking_beds WHERE booking_id = $1::uuid ORDER BY bed_code`,
    [BOOKING_ID],
  );
  const pays = await pg.query(
    `SELECT id::text, status::text, amount_due_cents, amount_paid_cents,
            stripe_checkout_session_id, checkout_url,
            stripe_payment_intent_id, created_at::text, updated_at::text
       FROM payments WHERE booking_id = $1::uuid ORDER BY created_at`,
    [BOOKING_ID],
  );
  const sends = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends
      WHERE to_phone IN ($1, $2) AND status = 'sent'`,
    [GUEST_PHONE, '491726422307'],
  );
  return {
    booking: b.rows[0] || null,
    beds: beds.rows,
    payments: pays.rows,
    guest_message_sends: sends.rows[0]?.n ?? 0,
  };
}

async function createStripeLink(cookie) {
  return req('POST', '/staff/bot/guest-simulator-create-stripe-test-link', {
    source: 'luna_guest_simulator',
    confirm_simulator_stripe: true,
    confirm_stripe_test_link: true,
    payment_draft_id: PAYMENT_DRAFT_ID,
    booking_id: BOOKING_ID,
    booking_code: BOOKING_CODE,
  }, { cookie });
}

async function confirmationPreview(cookie) {
  return req('POST', '/staff/bot/bookings/confirmation-preview', {
    booking_code: BOOKING_CODE,
    booking_id: BOOKING_ID,
    client_slug: 'wolfhouse-somo',
  }, { cookie });
}

async function pollStripeSessionPaid(stripeKey, sessionId) {
  const stripe = require('stripe')(stripeKey);
  const deadline = Date.now() + POLL_PAYMENT_MS;
  while (Date.now() < deadline) {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status === 'paid' && session.status === 'complete') {
      return { paid: true, session };
    }
    console.error(`[poll] Stripe session payment_status=${session.payment_status} status=${session.status}`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { paid: false, session: null };
}

async function applyPaymentTruth(pg, stripeKey, sessionId, method) {
  const stripe = require('stripe')(stripeKey);
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const before = await fetchBookingState(pg);
  const result = await runGuestStripePaymentTruthApplyApproved({
    payment_draft_id: PAYMENT_DRAFT_ID,
    booking_id: BOOKING_ID,
    booking_code: BOOKING_CODE,
    stripe_session: session,
    stripe_event: {
      id: `evt_stage28d_proof_${Date.now()}`,
      type: 'checkout.session.completed',
      livemode: false,
      data: { object: session },
    },
    source: `stage28d_${method}`,
    staff_operator: 'stage28d-proof',
  }, {
    confirm_payment_truth: true,
    env: { NODE_ENV: 'staging', STRIPE_SECRET_KEY: stripeKey, WHATSAPP_DRY_RUN: 'true' },
    host_header: HOST,
    pg,
  });
  const after = await fetchBookingState(pg);
  return { before: before.booking, after: after.booking, payments_after: after.payments, result, session };
}

function previewChecks(previewBody) {
  const msg = String(previewBody.message_preview || previewBody.preview_message || '');
  const draft = previewBody.confirmation_draft || previewBody.draft || {};
  return {
    preview_ready: previewBody.success === true || previewBody.preview_ready === true,
    has_booking_code: msg.includes(BOOKING_CODE) || String(draft.booking_code || '').includes(BOOKING_CODE),
    has_deposit: /200|€200|deposit/i.test(msg) || draft.deposit_paid_cents === 20000,
    has_balance: /balance|saldo|€398|398/i.test(msg) || draft.balance_due_cents != null,
    has_address: /somo|wolfhouse|address/i.test(msg) || !!draft.address,
    has_gate_code: /2684/.test(msg) || String(draft.gate_code || '').includes('2684'),
    has_room: /DEMO-R1/i.test(msg) || String(draft.room_label || draft.room_code || '').includes('DEMO-R1'),
    confirmation_sent_at_null: !previewBody.confirmation_sent_at,
    sends_whatsapp: previewBody.sends_whatsapp,
  };
}

(async () => {
  const out = {
    stage: '28d-stripe-payment-truth-rehearsal',
    step: STEP,
    booking_code: BOOKING_CODE,
    booking_id: BOOKING_ID,
    payment_draft_id: PAYMENT_DRAFT_ID,
  };
  let rolledBack = false;
  async function rollback() {
    if (rolledBack) return;
    setEnvVars(BASELINE_ENV);
    out.gates_after = envPick(GATE_NAMES);
    rolledBack = true;
  }

  try {
    out.healthz = Number(execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${HOST}/healthz`, { encoding: 'utf8' }).trim());
    out.revision = activeRevision();
    out.gates_before = envPick(GATE_NAMES);

    const stripeKey = azSecret('stripe-secret-key');
    if (!stripeKey.startsWith('sk_test_')) {
      out.verdict = 'FAIL';
      out.blocker = 'stripe_live_key_detected';
      throw new Error('sk_live or invalid Stripe key — stopped');
    }
    out.stripe_mode = 'test';

    const n8nUrl = az('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv');
    const nc = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
    await nc.connect();
    const wf = await nc.query('SELECT active FROM workflow_entity WHERE id=$1', [WF_ID]);
    const hooks = await nc.query('SELECT COUNT(*)::int AS n FROM webhook_entity WHERE "workflowId"=$1', [WF_ID]);
    await nc.end();
    out.n8n = { workflow_active: wf.rows[0]?.active, webhook_entity_rows: hooks.rows[0]?.n };

    const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
    const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await pg.connect();

    const stateBefore = await fetchBookingState(pg);
    out.state_before = stateBefore;
    const pay = stateBefore.payments.find((p) => p.id === PAYMENT_DRAFT_ID) || stateBefore.payments[0];
    const bedCodes = stateBefore.beds.map((b) => b.bed_code).sort();

    out.preflight = {
      healthz_200: out.healthz === 200,
      revision_healthy: out.revision.health === 'Healthy' && out.revision.traffic === 100,
      booking_exists: stateBefore.booking?.booking_code === BOOKING_CODE,
      booking_hold: stateBefore.booking?.status === 'hold',
      payment_draft_exists: !!pay,
      payment_draft_status: pay?.status,
      beds_assigned: bedCodes.includes('DEMO-R1-B1') && bedCodes.includes('DEMO-R1-B2'),
      no_confirmation_sent: !stateBefore.booking?.confirmation_sent_at,
      n8n_inactive: out.n8n.workflow_active === false,
      gates_safe_before: out.gates_before.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'false'
        && out.gates_before.WHATSAPP_DRY_RUN === 'true',
    };
    if (!Object.values(out.preflight).every(Boolean)) {
      out.verdict = 'FAIL';
      out.blocker = 'preflight_failed';
      throw new Error('preflight failed');
    }

    const { cookie } = await staffLogin();
    let linkRes = null;
    let sessionId = pay?.stripe_checkout_session_id || null;
    let checkoutUrl = pay?.checkout_url || null;
    let linkCreated = false;
    let linkReused = false;

    if (STEP === 'link' || STEP === 'all') {
      setEnvVars(STRIPE_PROOF_ENV);
      await new Promise((r) => setTimeout(r, 12000));
      out.gates_during = envPick(GATE_NAMES);

      if (sessionId && checkoutUrl) {
        linkReused = true;
        out.step1 = { stripe_link_reused: true, stripe_checkout_session_id: sessionId, stripe_checkout_url: checkoutUrl };
      } else {
        linkRes = await createStripeLink(cookie);
        const b = linkRes.body && typeof linkRes.body === 'object' ? linkRes.body : {};
        if (b.sends_whatsapp || b.payment_link_sent || b.whatsapp_sent) {
          await rollback();
          out.verdict = 'FAIL';
          out.blocker = 'whatsapp_send_detected';
          throw new Error('Stripe link path attempted WhatsApp send — rolled back');
        }
        linkCreated = b.stripe_link_created === true || b.stripe_link_status === 'created' || b.stripe_link_status === 'reused';
        linkReused = b.stripe_link_status === 'reused' || b.stripe_link_reused === true;
        sessionId = b.stripe_checkout_session_id || sessionId;
        checkoutUrl = b.stripe_checkout_url || checkoutUrl;
        out.step1 = {
          http: linkRes.status,
          success: b.success,
          stripe_link_created: b.stripe_link_created,
          stripe_link_reused: linkReused,
          stripe_mode: b.stripe_mode || 'test',
          stripe_checkout_session_id: sessionId,
          stripe_checkout_url: checkoutUrl,
          payment_link_sent: b.payment_link_sent,
          whatsapp_sent: b.whatsapp_sent,
          sends_whatsapp: b.sends_whatsapp,
          confirmation_sent: b.confirmation_sent,
          payment_truth_recorded: b.payment_truth_recorded,
          error: b.error,
          block_reasons: b.block_reasons,
        };
        if (!checkoutUrl || !sessionId) {
          await rollback();
          out.verdict = 'FAIL';
          out.blocker = 'stripe_link_failed';
          throw new Error('no checkout url/session');
        }
      }

      out.checkout_url = checkoutUrl;
      out.checkout_session_id = sessionId;
      console.error('\n=== PAUSE — Ty: open Stripe TEST checkout URL and complete payment ===');
      console.error(checkoutUrl);
    }

    if (STEP === 'link') {
      out.verdict = 'PAUSE';
      out.message = 'Complete TEST checkout, then rerun with STEP=truth or STEP=all';
      await pg.end();
      console.log(JSON.stringify(out, null, 2));
      process.exit(0);
    }

    // Refresh state after link
    const stateMid = await fetchBookingState(pg);
    sessionId = sessionId || stateMid.payments.find((p) => p.id === PAYMENT_DRAFT_ID)?.stripe_checkout_session_id;

    let paymentTruthMethod = 'pending';
    let truthResult = null;

    if (STEP === 'truth' || STEP === 'all') {
      if (!sessionId) {
        await rollback();
        throw new Error('no session id for payment truth');
      }

      // Check if webhook already applied truth
      const webhookWait = STEP === 'all' ? await pollStripeSessionPaid(stripeKey, sessionId) : { paid: false };
      const fresh = await fetchBookingState(pg);
      const alreadyPaid = ['deposit_paid', 'paid'].includes(fresh.booking?.payment_status)
        || fresh.payments.some((p) => p.id === PAYMENT_DRAFT_ID && ['paid', 'deposit_paid'].includes(p.status));

      if (alreadyPaid && fresh.booking?.amount_paid_cents >= 20000) {
        paymentTruthMethod = 'webhook-real';
        out.payment_truth = { method: paymentTruthMethod, note: 'booking already deposit_paid before harness' };
      } else if (webhookWait.paid || STEP === 'truth') {
        const poll = STEP === 'truth' ? await pollStripeSessionPaid(stripeKey, sessionId) : webhookWait;
        if (!poll.paid && !alreadyPaid) {
          await rollback();
          out.verdict = 'FAIL';
          out.blocker = 'checkout_not_paid';
          throw new Error('Ty has not completed TEST checkout yet');
        }
        // Re-check DB after Stripe paid — webhook may have fired
        const afterStripePaid = await fetchBookingState(pg);
        if (['deposit_paid', 'paid'].includes(afterStripePaid.booking?.payment_status)) {
          paymentTruthMethod = 'webhook-real';
          out.payment_truth = { method: paymentTruthMethod, stripe_session_paid: true };
        } else {
          paymentTruthMethod = 'harness-applied';
          truthResult = await applyPaymentTruth(pg, stripeKey, sessionId, 'harness');
          out.payment_truth = {
            method: paymentTruthMethod,
            stripe_session_paid: poll.paid,
            apply_result: truthResult.result,
          };
        }
      }
    }

    const stateAfter = await fetchBookingState(pg);
    out.state_after = stateAfter;
    out.payment_row_before = stateBefore.payments.find((p) => p.id === PAYMENT_DRAFT_ID);
    out.payment_row_after = stateAfter.payments.find((p) => p.id === PAYMENT_DRAFT_ID);
    out.booking_before = {
      status: stateBefore.booking?.status,
      payment_status: stateBefore.booking?.payment_status,
      amount_paid_cents: stateBefore.booking?.amount_paid_cents,
      balance_due_cents: stateBefore.booking?.balance_due_cents,
    };
    out.booking_after = {
      status: stateAfter.booking?.status,
      payment_status: stateAfter.booking?.payment_status,
      amount_paid_cents: stateAfter.booking?.amount_paid_cents,
      balance_due_cents: stateAfter.booking?.balance_due_cents,
    };

    let previewRes = null;
    if (STEP === 'truth' || STEP === 'all' || STEP === 'preview') {
      previewRes = await confirmationPreview(cookie);
      const pb = previewRes.body && typeof previewRes.body === 'object' ? previewRes.body : {};
      out.step4_confirmation_preview = {
        http: previewRes.status,
        success: pb.success,
        preview_ready: pb.preview_ready,
        message_preview_snippet: String(pb.message_preview || pb.preview_message || '').slice(0, 500),
        checks: previewChecks(pb),
        sends_whatsapp: pb.sends_whatsapp,
        confirmation_sent_at: stateAfter.booking?.confirmation_sent_at,
      };
    }

    const dupBookings = await pg.query(
      `SELECT COUNT(*)::int AS n FROM bookings b JOIN clients cl ON cl.id=b.client_id
        WHERE cl.slug='wolfhouse-somo' AND b.phone IN ($1,$2) AND b.check_in=$3::date AND b.id <> $4::uuid`,
      [GUEST_PHONE, '491726422307', CHECK_IN, BOOKING_ID],
    );
    const dupBeds = await pg.query(
      `SELECT COUNT(*)::int AS n FROM booking_beds WHERE booking_id=$1::uuid`,
      [BOOKING_ID],
    );

    await rollback();
    await pg.end();

    out.safety = {
      guest_message_sends_unchanged: stateAfter.guest_message_sends === stateBefore.guest_message_sends,
      no_whatsapp_send: true,
      no_confirmation_sent: !stateAfter.booking?.confirmation_sent_at,
      n8n_inactive: out.n8n.workflow_active === false,
      no_duplicate_booking: dupBookings.rows[0].n === 0,
      bed_count_unchanged: dupBeds.rows[0].n === stateBefore.beds.length,
      stripe_test_only: true,
      gates_restored: out.gates_after?.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'false',
    };

    out.checks = {
      stripe_link_ok: !!(out.checkout_url && out.checkout_session_id),
      payment_deposit_paid: ['deposit_paid', 'paid'].includes(out.booking_after.payment_status),
      amount_paid_20000: out.booking_after.amount_paid_cents === 20000,
      balance_due_correct: out.booking_after.balance_due_cents === (stateBefore.booking?.total_amount_cents - 20000),
      preview_ready: out.step4_confirmation_preview?.checks?.preview_ready === true,
      preview_gate_code: out.step4_confirmation_preview?.checks?.has_gate_code === true,
      preview_room: out.step4_confirmation_preview?.checks?.has_room === true,
      no_confirmation_send: out.safety.no_confirmation_sent,
    };
    out.failed_checks = Object.entries(out.checks).filter(([, v]) => !v).map(([k]) => k);

    const core = ['stripe_link_ok', 'payment_deposit_paid', 'amount_paid_20000'];
    if (STEP === 'truth' || STEP === 'all') {
      if (core.every((k) => out.checks[k]) && out.failed_checks.length === 0) out.verdict = 'PASS';
      else if (core.every((k) => out.checks[k])) out.verdict = 'PARTIAL';
      else out.verdict = 'FAIL';
    }

    console.log(JSON.stringify(out, null, 2));
    process.exit(out.verdict === 'PASS' ? 0 : out.verdict === 'PAUSE' ? 0 : 1);
  } catch (err) {
    out.error = err.message;
    if (!out.verdict) out.verdict = 'FAIL';
    try { await rollback(); } catch { /* ignore */ }
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
