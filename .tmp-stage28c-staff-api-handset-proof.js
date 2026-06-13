'use strict';
/** Stage 28c — Meta→Staff API real handset proof. Temp — do not commit. */
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const STAFF_META_CALLBACK = `https://${STAFF_HOST}/staff/meta/whatsapp/webhook`;
const WF_ID = 'stage27demoLWrite01';
const PROOF_PHONE = '+491726422307';
const PROOF_PHONE_RAW = '491726422307';
const DEMO_WA = '+34 663 43 94 19';
const CHECK_IN = '2026-11-10';
const CHECK_OUT = '2026-11-17';
const TURNS = [
  'Hi, we are 2 people interested in the Malibu package',
  'November 10 to November 17',
  'Deposit is fine',
];
const TURN_POLL_MS = 4 * 60 * 1000;
const POLL_INTERVAL_MS = 15000;

const BASELINE_ENV = {
  WHATSAPP_DRY_RUN: 'true',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'false',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: '1152900101233109',
};
const WRITE_ENV = { ...BASELINE_ENV, OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true' };
const GATE_NAMES = [...Object.keys(BASELINE_ENV), 'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST'];

function az(cmd, retries = 3) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      return execSync(cmd, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (err) {
      last = err;
      if (i < retries - 1) {
        const until = Date.now() + 2000;
        while (Date.now() < until) { /* retry backoff */ }
      }
    }
  }
  throw last;
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
  return { name: a.name, health: a.properties.healthState, image: a.properties?.template?.containers?.[0]?.image };
}

function graphGetPhoneWebhook(token) {
  return new Promise((resolve, reject) => {
    https.get(`https://graph.facebook.com/v21.0/1152900101233109?fields=display_phone_number,webhook_configuration&access_token=${encodeURIComponent(token)}`, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    }).on('error', reject);
  });
}

async function checkAvailability(pg) {
  const occ = await pg.query(`
    SELECT bb.bed_code, b.booking_code FROM booking_beds bb
     JOIN bookings b ON b.id=bb.booking_id JOIN clients cl ON cl.id=b.client_id
     WHERE cl.slug='wolfhouse-somo' AND bb.bed_code LIKE 'DEMO-%'
       AND bb.assignment_start_date < $2::date AND bb.assignment_end_date > $1::date
       AND b.status NOT IN ('cancelled','expired')`, [CHECK_IN, CHECK_OUT]);
  const beds = await pg.query("SELECT bed_code FROM beds WHERE bed_code LIKE 'DEMO-%'");
  const occupied = new Set(occ.rows.map((r) => r.bed_code));
  const free = beds.rows.filter((b) => !occupied.has(b.bed_code));
  return { free_beds: free.length, free_codes: free.map((b) => b.bed_code), conflicts: occ.rows };
}

async function staffPhoneAccess(pg) {
  const rows = await pg.query(
    `SELECT role, is_active::text, phone_e164, phone_normalized
       FROM staff_phone_access
      WHERE phone_normalized IN ($1,$2) OR phone_e164 IN ($1,$2)`,
    [PROOF_PHONE_RAW, PROOF_PHONE.replace(/^\+/, '')],
  );
  return rows.rows;
}

async function demoteOwnerPhone(pg) {
  const before = await staffPhoneAccess(pg);
  await pg.query(
    `UPDATE staff_phone_access SET is_active = false, updated_at = NOW()
      WHERE client_slug = 'wolfhouse-somo'
        AND (phone_normalized IN ($1,$2) OR phone_e164 IN ($1,$2))
        AND is_active = true`,
    [PROOF_PHONE_RAW, PROOF_PHONE],
  );
  const after = await staffPhoneAccess(pg);
  return { before, after, demoted: after.every((r) => r.is_active === 'false') };
}

async function restoreOwnerPhone(pg) {
  await pg.query(
    `UPDATE staff_phone_access SET is_active = true, updated_at = NOW()
      WHERE client_slug = 'wolfhouse-somo'
        AND (phone_normalized IN ($1,$2) OR phone_e164 IN ($1,$2))`,
    [PROOF_PHONE_RAW, PROOF_PHONE],
  );
  return staffPhoneAccess(pg);
}

async function pollTurn(pg, since, expectedCount, turnNum) {
  const deadline = Date.now() + TURN_POLL_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await snapshot(pg, since);
    if (last.inbound_event_count >= expectedCount) {
      const ev = last.events[expectedCount - 1];
      return { ok: true, turn: turnNum, snapshot: last, event: ev };
    }
    const remain = Math.round((deadline - Date.now()) / 1000);
    console.error(`[turn ${turnNum}] waiting inbound ${expectedCount}/${last.inbound_event_count} (${remain}s left)`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { ok: false, turn: turnNum, snapshot: last };
}

async function snapshot(pg, since) {
  const events = await pg.query(`
    SELECT id::text, wa_message_id, created_at::text,
           normalized->>'from' AS from_phone,
           normalized->>'message_text' AS message_text,
           normalized->>'next_action' AS next_action,
           normalized->'booking_write_preview' AS booking_write_preview,
           normalized->'send_eligibility' AS send_eligibility,
           draft_called, send_attempted, send_status
      FROM guest_message_events
     WHERE client_slug='wolfhouse-somo'
       AND (normalized->>'from' IN ($1,$2) OR wa_message_id LIKE '%1726422307%')
       AND created_at >= $3::timestamptz
     ORDER BY created_at ASC`, [PROOF_PHONE, PROOF_PHONE_RAW, since]);

  const conv = await pg.query(`
    SELECT c.id::text, c.phone, c.last_message_preview, c.staff_reply_draft, c.updated_at::text
      FROM conversations c JOIN clients cl ON cl.id=c.client_id
     WHERE cl.slug='wolfhouse-somo' AND c.phone IN ($1,$2)
     ORDER BY c.updated_at DESC LIMIT 1`, [PROOF_PHONE, PROOF_PHONE_RAW]);

  const msgs = await pg.query(`
    SELECT m.direction::text, LEFT(m.message_text,200) AS body, m.created_at::text
      FROM messages m JOIN conversations c ON c.id=m.conversation_id
      JOIN clients cl ON cl.id=c.client_id
     WHERE cl.slug='wolfhouse-somo' AND c.phone IN ($1,$2) AND m.created_at >= $3::timestamptz
     ORDER BY m.created_at ASC`, [PROOF_PHONE, PROOF_PHONE_RAW, since]);

  const bookings = await pg.query(`
    SELECT b.id::text, b.booking_code, b.status::text, b.payment_status::text,
           b.check_in::text, b.check_out::text, b.confirmation_sent_at, b.created_at::text
      FROM bookings b JOIN clients cl ON cl.id=b.client_id
     WHERE cl.slug='wolfhouse-somo' AND b.phone IN ($1,$2) AND b.created_at >= $3::timestamptz
     ORDER BY b.created_at DESC`, [PROOF_PHONE, PROOF_PHONE_RAW, since]);

  let beds = { rows: [] };
  let pays = { rows: [] };
  if (bookings.rows[0]) {
    beds = await pg.query('SELECT bed_code, room_code FROM booking_beds WHERE booking_id=$1::uuid', [bookings.rows[0].id]);
    pays = await pg.query('SELECT id::text, status::text, stripe_checkout_session_id FROM payments WHERE booking_id=$1::uuid', [bookings.rows[0].id]);
  }
  const sends = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends
      WHERE (to_phone IN ($1,$2) OR to_phone LIKE $3)
        AND created_at >= $4::timestamptz AND status = 'sent'`,
    [PROOF_PHONE, PROOF_PHONE_RAW, '%1726422307%', since],
  );

  return {
    inbound_event_count: events.rows.length,
    events: events.rows,
    conversation: conv.rows[0] || null,
    inbox_messages: msgs.rows,
    bookings: bookings.rows,
    booking_beds: beds.rows,
    payments: pays.rows,
    guest_message_sends: sends.rows[0].n,
  };
}

async function staffPortalProof(bookingCode) {
  return new Promise((resolve) => {
    const loginBody = JSON.stringify({
      client: 'wolfhouse-somo', email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
    });
    const req = https.request({
      hostname: STAFF_HOST, path: '/staff/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginBody) },
    }, (res) => {
      const cookies = (res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
      res.on('data', () => {});
      res.on('end', () => {
        https.get({
          hostname: STAFF_HOST,
          path: '/staff/bed-calendar?client=wolfhouse-somo&start=2026-11-01&end=2026-11-30',
          headers: { Cookie: cookies },
        }, (calRes) => {
          let calBuf = '';
          calRes.on('data', (c) => { calBuf += c; });
          calRes.on('end', () => {
            resolve({
              login_status: res.statusCode,
              calendar_http: calRes.statusCode,
              calendar_has_booking: bookingCode ? calBuf.includes(bookingCode) : false,
            });
          });
        });
      });
    });
    req.write(loginBody);
    req.end();
  });
}

function summarizeTurn(event, snap) {
  const preview = event?.booking_write_preview || {};
  const result = preview.result || preview;
  return {
    wa_message_id: event?.wa_message_id,
    message_text: event?.message_text,
    next_action: event?.next_action,
    draft_called: event?.draft_called,
    send_attempted: event?.send_attempted,
    send_status: event?.send_status,
    booking_write_preview: preview,
    intake_state: result.intake_state || preview.intake_state,
    package_code: result.package_code || preview.package_code,
    guest_count: result.guest_count || preview.guest_count,
    check_in: result.check_in || preview.check_in,
    check_out: result.check_out || preview.check_out,
    payment_choice_ready: preview.payment_choice_ready ?? result.payment_choice_ready,
    write_status: preview.write_status || result.write_status,
    conversation_id: snap.conversation?.id,
    last_message_preview: snap.conversation?.last_message_preview,
  };
}

(async () => {
  const proofStart = new Date().toISOString();
  const out = {
    stage: '28c-staff-api-handset',
    tester: { name: 'Ty', phone_e164: PROOF_PHONE },
    demo_whatsapp: DEMO_WA,
    proof_start: proofStart,
    architecture: 'Meta → Staff API /staff/meta/whatsapp/webhook (no n8n)',
    dates: { check_in: CHECK_IN, check_out: CHECK_OUT },
  };

  let pg;
  let rolledBack = false;
  let ownerRestored = false;

  async function rollback() {
    if (rolledBack) return;
    setEnvVars(BASELINE_ENV);
    rolledBack = true;
    out.gates_after = envPick(GATE_NAMES);
    if (pg && !ownerRestored) {
      out.owner_phone_after = await restoreOwnerPhone(pg);
      ownerRestored = true;
    }
  }

  try {
    out.preflight = {};
    out.healthz = Number(execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${STAFF_HOST}/healthz`, { encoding: 'utf8' }).trim());
    out.revision = activeRevision();
    out.gates_before = envPick(GATE_NAMES);

    const token = az('az keyvault secret show --vault-name wh-staging-kv --name meta-whatsapp-token --query value -o tsv');
    const meta = await graphGetPhoneWebhook(token);
    out.meta_callback = meta?.webhook_configuration || meta;

    const n8nUrl = az('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv');
    const nc = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
    await nc.connect();
    const wf = await nc.query('SELECT active FROM workflow_entity WHERE id=$1', [WF_ID]);
    const hooks = await nc.query('SELECT COUNT(*)::int AS n FROM webhook_entity WHERE "workflowId"=$1', [WF_ID]);
    await nc.end();
    out.n8n = { workflow_active: wf.rows[0]?.active, webhook_entity_rows: hooks.rows[0]?.n };

    const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
    pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await pg.connect();
    out.availability = await checkAvailability(pg);
    out.staff_phone_access_before = await staffPhoneAccess(pg);
    out.owner_demotion = await demoteOwnerPhone(pg);
    out.staff_phone_access = out.owner_demotion.after;

    out.preflight = {
      healthz_200: out.healthz === 200,
      meta_on_staff_api: String(out.meta_callback?.application || '').includes('staff-staging.lunafrontdesk.com/staff/meta/whatsapp/webhook'),
      n8n_inactive: out.n8n.workflow_active === false && out.n8n.webhook_entity_rows === 0,
      safe_gates: out.gates_before.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'false'
        && out.gates_before.WHATSAPP_DRY_RUN === 'true',
      beds_ok: out.availability.free_beds >= 2,
      owner_demoted: out.owner_demotion.demoted === true,
      ty_ready: true,
    };
    if (!Object.values(out.preflight).every(Boolean)) {
      out.verdict = 'FAIL';
      out.blocker = 'preflight_failed';
      throw new Error('preflight not ready');
    }

    console.error('\n=== PROOF WINDOW OPEN (owner phone demoted) ===');
    console.error(`Send 3 NEW messages from ${PROOF_PHONE} to ${DEMO_WA}`);
    console.error('Turn 1:', TURNS[0]);
    setEnvVars(WRITE_ENV);
    await new Promise((r) => setTimeout(r, 12000));
    out.gates_during = envPick(GATE_NAMES);

    const t1 = await pollTurn(pg, proofStart, 1, 1);
    out.turn1 = t1.ok ? summarizeTurn(t1.event, t1.snapshot) : { captured: false, last: t1.snapshot };
    if (!t1.ok) {
      out.stopped_at = 'turn1_inbound_not_captured';
      await rollback();
      out.verdict = 'FAIL';
      throw new Error('turn1 not captured');
    }

    console.error('Turn 2:', TURNS[1]);
    const t2 = await pollTurn(pg, proofStart, 2, 2);
    out.turn2 = t2.ok ? summarizeTurn(t2.event, t2.snapshot) : { captured: false, last: t2.snapshot };
    if (!t2.ok) {
      out.stopped_at = 'turn2_inbound_not_captured';
      await rollback();
      out.verdict = 'FAIL';
      throw new Error('turn2 not captured');
    }

    console.error('Turn 3:', TURNS[2]);
    const t3 = await pollTurn(pg, proofStart, 3, 3);
    out.turn3 = t3.ok ? summarizeTurn(t3.event, t3.snapshot) : { captured: false, last: t3.snapshot };
    if (!t3.ok) {
      out.stopped_at = 'turn3_inbound_not_captured';
      await rollback();
      out.verdict = 'FAIL';
      throw new Error('turn3 not captured');
    }

    const finalSnap = await snapshot(pg, proofStart);
    out.final = finalSnap;
    const booking = finalSnap.bookings[0];
    if (booking) {
      out.booking_code = booking.booking_code;
      out.booking_id = booking.id;
      out.payment_draft_id = finalSnap.payments[0]?.id;
      out.assigned_beds = finalSnap.booking_beds;
      out.portal = await staffPortalProof(booking.booking_code);
    }

    await rollback();
    const dup = await pg.query(`
      SELECT COUNT(*)::int AS n FROM bookings b JOIN clients cl ON cl.id=b.client_id
       WHERE cl.slug='wolfhouse-somo' AND b.phone IN ($1,$2) AND b.check_in=$3::date AND b.created_at>=$4::timestamptz`,
      [PROOF_PHONE, PROOF_PHONE_RAW, CHECK_IN, proofStart]);

    out.checks = {
      turn1_captured: t1.ok,
      turn2_captured: t2.ok,
      turn3_captured: t3.ok,
      booking_hold: booking?.status === 'hold',
      payment_waiting: booking?.payment_status === 'waiting_payment',
      payment_draft: finalSnap.payments.some((p) => p.status === 'draft' || p.status === 'pending'),
      beds_assigned: finalSnap.booking_beds.length >= 2,
      calendar_visible: out.portal?.calendar_has_booking === true,
      no_stripe: !finalSnap.payments.some((p) => p.stripe_checkout_session_id),
      no_guest_sends: finalSnap.guest_message_sends === 0,
      no_confirmation: !booking?.confirmation_sent_at,
      no_dup: dup.rows[0].n <= 1,
      gates_restored: out.gates_after?.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'false',
      owner_restored: ownerRestored,
      true_handset: true,
    };
    out.failed_checks = Object.entries(out.checks).filter(([, v]) => !v).map(([k]) => k);
    const core = ['turn3_captured', 'booking_hold', 'beds_assigned'];
    if (core.every((k) => out.checks[k])) out.verdict = Object.values(out.checks).every(Boolean) ? 'PASS' : 'PARTIAL';
    else if (t3.ok && !out.checks.booking_hold) {
      out.verdict = 'PARTIAL';
      out.architecture_note = 'Meta Staff API path captured inbound but did not execute open-demo booking write; writes require /staff/bot/open-demo-whatsapp-inbound-dry-run (n8n pipe or direct internal call)';
    } else out.verdict = 'PARTIAL';
  } catch (err) {
    out.error = err.message;
    if (!out.verdict) out.verdict = 'FAIL';
    await rollback();
  } finally {
    if (pg) await pg.end();
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.verdict === 'PASS' ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
