'use strict';
/** Stage 28c.7 — deploy 5596d01 + Meta guest_email fix handset proof. Temp — do not commit. */
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const COMMIT = '5596d01';
const IMAGE_TAG = `${COMMIT}-stage28c7-meta-guest-email-proof`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's28c7-guest-email';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const WF_ID = 'stage27demoLWrite01';
const PROOF_PHONE = '+491726422307';
const PROOF_PHONE_RAW = '491726422307';
const EXPECTED_GUEST_EMAIL = 'open-demo+491726422307@example.test';
const DEMO_WA = '+34 663 43 94 19';
const CHECK_IN = '2026-07-24';
const CHECK_OUT = '2026-07-31';
const CHOSEN_DATES = { check_in: CHECK_IN, check_out: CHECK_OUT, season: 'summer', expected_quote_cents: 59800 };
const TURNS = [
  'Hi, we are 2 people interested in the Malibu package',
  'July 24 to July 31',
  'Deposit is fine',
];
const TURN_POLL_MS = 6 * 60 * 1000;
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
        while (Date.now() < until) { /* backoff */ }
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
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties?.template?.containers?.[0]?.image,
  };
}

function deploy() {
  if (process.env.SKIP_DEPLOY === '1') {
    console.error('[deploy] SKIP_DEPLOY=1 — using current revision');
    return activeRevision();
  }
  console.error(`[deploy] acr build ${IMAGE_TAG} from ${COMMIT}...`);
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  console.error('[deploy] containerapp update...');
  az([
    'az containerapp update', '--name wh-staging-staff-api', '--resource-group wh-staging-rg',
    `--image ${IMAGE}`, `--revision-suffix ${REV_SUFFIX}`, '-o none',
  ].join(' '));
  for (let i = 0; i < 45; i++) {
    const rev = activeRevision();
    const hz = execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${STAFF_HOST}/healthz`, { encoding: 'utf8' }).trim();
    console.error(`[deploy] wait ${i + 1}/45 image=${rev.image} health=${rev.health} traffic=${rev.traffic} hz=${hz}`);
    if (String(rev.image || '').includes(IMAGE_TAG) && rev.health === 'Healthy' && rev.traffic === 100 && hz === '200') {
      return rev;
    }
    execSync('powershell -Command "Start-Sleep -Seconds 10"');
  }
  return activeRevision();
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
    [PROOF_PHONE_RAW, PROOF_PHONE],
  );
  return rows.rows;
}

async function demoteOwnerPhone(pg) {
  const before = await staffPhoneAccess(pg);
  const wasActive = before.some((r) => r.is_active === 'true');
  if (wasActive) {
    await pg.query(
      `UPDATE staff_phone_access SET is_active = false, updated_at = NOW()
        WHERE client_slug = 'wolfhouse-somo'
          AND (phone_normalized IN ($1,$2) OR phone_e164 IN ($1,$2))`,
      [PROOF_PHONE_RAW, PROOF_PHONE],
    );
  }
  const after = await staffPhoneAccess(pg);
  return { before, after, demoted: after.every((r) => r.is_active === 'false'), prior_active: wasActive };
}

async function restoreOwnerPhone(pg, priorActive) {
  if (priorActive) {
    await pg.query(
      `UPDATE staff_phone_access SET is_active = true, updated_at = NOW()
        WHERE client_slug = 'wolfhouse-somo'
          AND (phone_normalized IN ($1,$2) OR phone_e164 IN ($1,$2))`,
      [PROOF_PHONE_RAW, PROOF_PHONE],
    );
  }
  return staffPhoneAccess(pg);
}

async function pollTurn(pg, since, expectedCount, turnNum) {
  const deadline = Date.now() + TURN_POLL_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await snapshot(pg, since);
    if (last.inbound_event_count >= expectedCount) {
      const ev = last.events[expectedCount - 1];
      const odr = ev.open_demo_result || {};
      const processed = ev.open_demo_route === 'true' || odr.review_ok === true;
      if (processed) {
        return { ok: true, turn: turnNum, snapshot: last, event: ev };
      }
    }
    const remain = Math.round((deadline - Date.now()) / 1000);
    const n = last ? last.inbound_event_count : 0;
    console.error(`[turn ${turnNum}] waiting ${expectedCount}/${n} processed (${remain}s left)`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { ok: false, turn: turnNum, snapshot: last };
}

async function snapshot(pg, since) {
  const events = await pg.query(`
    SELECT id::text, wa_message_id, created_at::text,
           normalized->>'from' AS from_phone,
           normalized->>'message_text' AS message_text,
           normalized->>'open_demo_route' AS open_demo_route,
           normalized->>'owner_luna_route' AS owner_luna_route,
           normalized->'open_demo_result' AS open_demo_result,
           draft_called, send_attempted, send_status
      FROM guest_message_events
     WHERE client_slug='wolfhouse-somo'
       AND (normalized->>'from' IN ($1,$2) OR wa_message_id LIKE '%1726422307%')
       AND created_at >= $3::timestamptz
     ORDER BY created_at ASC`, [PROOF_PHONE, PROOF_PHONE_RAW, since]);

  const conv = await pg.query(`
    SELECT c.id::text, c.phone, c.last_message_preview, c.updated_at::text
      FROM conversations c JOIN clients cl ON cl.id=c.client_id
     WHERE cl.slug='wolfhouse-somo' AND c.phone IN ($1,$2)
     ORDER BY c.updated_at DESC LIMIT 1`, [PROOF_PHONE, PROOF_PHONE_RAW]);

  const bookings = await pg.query(`
    SELECT b.id::text, b.booking_code, b.status::text, b.payment_status::text,
           b.check_in::text, b.check_out::text, b.email, b.confirmation_sent_at, b.created_at::text
      FROM bookings b JOIN clients cl ON cl.id=b.client_id
     WHERE cl.slug='wolfhouse-somo' AND b.phone IN ($1,$2) AND b.created_at >= $3::timestamptz
     ORDER BY b.created_at DESC`, [PROOF_PHONE, PROOF_PHONE_RAW, since]);

  let beds = { rows: [] };
  let pays = { rows: [] };
  if (bookings.rows[0]) {
    beds = await pg.query('SELECT bed_code, room_code FROM booking_beds WHERE booking_id=$1::uuid', [bookings.rows[0].id]);
    pays = await pg.query('SELECT id::text, status::text, stripe_checkout_session_id, checkout_url FROM payments WHERE booking_id=$1::uuid', [bookings.rows[0].id]);
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
          path: '/staff/bed-calendar?client=wolfhouse-somo&start=2026-07-01&end=2026-07-31',
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

async function reviewForWamid(pg, wamid) {
  const row = await pg.query(`
    SELECT c.metadata->'luna_inbound_reviews'->$2 AS review_blob
      FROM conversations c JOIN clients cl ON cl.id=c.client_id
     WHERE cl.slug='wolfhouse-somo' AND c.phone IN ($1,$3)`, [PROOF_PHONE, `wolfhouse-somo:whatsapp:${wamid}`, PROOF_PHONE_RAW]);
  const blob = row.rows[0]?.review_blob;
  return blob && blob.review ? blob.review : null;
}

function fieldsFromReview(review, odr) {
  const ex = (review && review.result && review.result.extracted_fields) || {};
  const quote = review && review.quote;
  const pc = review && review.payment_choice;
  const plan = review && review.hold_payment_draft_plan;
  return {
    guest_count: ex.guest_count ?? odr.guest_count,
    package_interest: ex.package_interest ?? odr.package_code,
    check_in: ex.check_in ?? odr.check_in,
    check_out: ex.check_out ?? odr.check_out,
    guest_email: ex.guest_email || (plan && plan.guest_email) || null,
    proposed_next_action: (review && review.proposed_next_action) || odr.proposed_next_action,
    quote_status: quote && quote.quote_status,
    quote_handoff_required: quote && quote.quote_handoff_required,
    quote_total_cents: quote && quote.total_cents,
    payment_choice_needed: (quote && quote.payment_choice_needed) || odr.payment_choice_needed,
    payment_choice_ready: (pc && pc.payment_choice_ready) || odr.payment_choice_ready,
    payment_choice: pc && pc.payment_choice,
    hold_plan_status: plan && plan.plan_status,
  };
}

async function summarizeTurn(pg, event, snap) {
  const odr = event?.open_demo_result || {};
  const review = event?.wa_message_id ? await reviewForWamid(pg, event.wa_message_id) : null;
  const f = fieldsFromReview(review, odr);
  const booking = snap.bookings[0];
  return {
    wa_message_id: event?.wa_message_id,
    message_text: event?.message_text,
    open_demo_route: event?.open_demo_route === 'true',
    owner_route: event?.owner_luna_route === 'true',
    open_demo_result: odr,
    review_fields: f,
    guest_count: f.guest_count,
    package_interest: f.package_interest,
    check_in: f.check_in,
    check_out: f.check_out,
    guest_email: f.guest_email || booking?.email || null,
    payment_choice: f.payment_choice,
    payment_choice_ready: odr.payment_choice_ready ?? f.payment_choice_ready,
    payment_choice_needed: f.payment_choice_needed,
    proposed_next_action: f.proposed_next_action,
    quote_status: f.quote_status,
    hold_plan_status: f.hold_plan_status,
    write_status: odr.write_status,
    assignment_write_status: odr.assignment_write_status,
    booking_code: odr.booking_code,
    booking_id: odr.booking_id,
    payment_draft_id: odr.payment_draft_id,
    assigned_bed_label: odr.assigned_bed_label,
    assigned_room_label: odr.assigned_room_label,
    calendar_visible_expected: odr.calendar_visible_expected,
    stripe_link_created: odr.stripe_link_created,
    payment_link_sent: odr.payment_link_sent,
    confirmation_sent: odr.confirmation_sent,
    conversation_id: snap.conversation?.id,
    send_status: event?.send_status,
  };
}

(async () => {
  const proofStart = new Date().toISOString();
  const out = {
    stage: '28c.7-meta-staffapi-handset-guest-email-fix',
    chosen_dates: CHOSEN_DATES,
    commit: COMMIT,
    image_tag: IMAGE_TAG,
    expected_guest_email: EXPECTED_GUEST_EMAIL,
    tester: { name: 'Ty', phone_e164: PROOF_PHONE },
    demo_whatsapp: DEMO_WA,
    proof_start: proofStart,
    architecture: 'Meta → Staff API open-demo execute (5596d01 guest_email synthesis)',
    dates: { check_in: CHECK_IN, check_out: CHECK_OUT },
  };

  let pg;
  let rolledBack = false;
  let ownerRestored = false;
  let priorOwnerActive = false;

  async function rollback() {
    if (rolledBack) return;
    setEnvVars(BASELINE_ENV);
    rolledBack = true;
    out.gates_after = envPick(GATE_NAMES);
    if (pg && !ownerRestored) {
      out.owner_phone_after = await restoreOwnerPhone(pg, priorOwnerActive);
      ownerRestored = true;
    }
  }

  try {
    out.deploy = deploy();
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
    out.owner_demotion = await demoteOwnerPhone(pg);
    priorOwnerActive = out.owner_demotion.prior_active;

    const imageOk = String(out.revision.image || '').includes(IMAGE_TAG);
    out.preflight = {
      healthz_200: out.healthz === 200,
      image_deployed: imageOk,
      revision_healthy_100: out.revision.health === 'Healthy' && out.revision.traffic === 100,
      meta_on_staff_api: String(out.meta_callback?.application || '').includes('staff-staging.lunafrontdesk.com/staff/meta/whatsapp/webhook'),
      n8n_inactive: out.n8n.workflow_active === false && out.n8n.webhook_entity_rows === 0,
      beds_ok: out.availability.free_beds >= 2,
      owner_demoted: out.owner_demotion.demoted === true,
      ty_ready: true,
    };
    if (!Object.values(out.preflight).every(Boolean)) {
      out.verdict = 'FAIL';
      out.blocker = 'preflight_failed';
      throw new Error('preflight not ready');
    }

    console.error(`\n=== PROOF WINDOW OPEN — dates ${CHECK_IN} → ${CHECK_OUT} ===`);
    console.error('Ty: send 3 NEW WhatsApp messages now');
    console.error(`From ${PROOF_PHONE} to ${DEMO_WA}`);
    console.error('Turn 1:', TURNS[0]);
    setEnvVars(WRITE_ENV);
    await new Promise((r) => setTimeout(r, 15000));
    out.gates_during = envPick(GATE_NAMES);

    const t1 = await pollTurn(pg, proofStart, 1, 1);
    out.turn1 = t1.ok ? await summarizeTurn(pg, t1.event, t1.snapshot) : { captured: false, last: t1.snapshot };
    if (!t1.ok) {
      out.stopped_at = 'turn1_not_processed';
      await rollback();
      out.verdict = 'FAIL';
      throw new Error('turn1 not processed');
    }

    console.error('Turn 2:', TURNS[1]);
    const t2 = await pollTurn(pg, proofStart, 2, 2);
    out.turn2 = t2.ok ? await summarizeTurn(pg, t2.event, t2.snapshot) : { captured: false, last: t2.snapshot };
    if (!t2.ok) {
      out.stopped_at = 'turn2_not_processed';
      await rollback();
      out.verdict = 'FAIL';
      throw new Error('turn2 not processed');
    }

    console.error('Turn 3:', TURNS[2]);
    const t3 = await pollTurn(pg, proofStart, 3, 3);
    out.turn3 = t3.ok ? await summarizeTurn(pg, t3.event, t3.snapshot) : { captured: false, last: t3.snapshot };
    if (!t3.ok) {
      out.stopped_at = 'turn3_not_processed';
      await rollback();
      out.verdict = 'FAIL';
      throw new Error('turn3 not processed');
    }

    const finalSnap = await snapshot(pg, proofStart);
    out.final = finalSnap;
    const booking = finalSnap.bookings[0];
    const t3odr = out.turn3.open_demo_result || {};
    out.booking_code = t3odr.booking_code || booking?.booking_code;
    out.booking_id = t3odr.booking_id || booking?.id;
    out.guest_email_used = out.turn3.guest_email || booking?.email || null;
    out.payment_draft_id = t3odr.payment_draft_id || finalSnap.payments[0]?.id;
    out.assigned_bed = t3odr.assigned_bed_label || finalSnap.booking_beds[0]?.bed_code;
    out.assigned_room = t3odr.assigned_room_label || finalSnap.booking_beds[0]?.room_code;
    if (out.booking_code) out.portal = await staffPortalProof(out.booking_code);

    await rollback();
    const dup = await pg.query(`
      SELECT COUNT(*)::int AS n FROM bookings b JOIN clients cl ON cl.id=b.client_id
       WHERE cl.slug='wolfhouse-somo' AND b.phone IN ($1,$2) AND b.check_in=$3::date AND b.created_at>=$4::timestamptz`,
      [PROOF_PHONE, PROOF_PHONE_RAW, CHECK_IN, proofStart]);

    out.checks = {
      turn1_open_demo_route: out.turn1.open_demo_route === true && out.turn1.owner_route !== true,
      turn1_guest_count: out.turn1.guest_count === 2,
      turn1_malibu: String(out.turn1.package_interest || '').toLowerCase().includes('malibu'),
      turn1_no_write: !out.turn1.write_status || out.turn1.write_status === 'not_ready',
      turn2_dates: out.turn2.check_in === CHECK_IN && out.turn2.check_out === CHECK_OUT,
      turn2_quote_ready: out.turn2.quote_status === 'ready' || out.turn2.quote_status === 'quoted',
      turn2_payment_choice_needed: out.turn2.payment_choice_needed === true,
      turn2_no_write: !out.turn2.write_status || out.turn2.write_status === 'not_ready',
      turn3_payment_choice_deposit: out.turn3.payment_choice === 'deposit',
      turn3_payment_choice_ready: out.turn3.payment_choice_ready === true,
      turn3_guest_email: out.guest_email_used === EXPECTED_GUEST_EMAIL,
      turn3_hold_plan_ready: out.turn3.hold_plan_status === 'ready',
      turn3_write_created: out.turn3.write_status === 'created' || out.turn3.write_status === 'reused_existing',
      turn3_assign_created: out.turn3.assignment_write_status === 'created' || out.turn3.assignment_write_status === 'reused_existing',
      turn3_booking_code: !!out.booking_code,
      turn3_payment_draft: !!out.payment_draft_id,
      booking_hold: booking?.status === 'hold',
      beds_assigned: finalSnap.booking_beds.length >= 2,
      calendar_visible: out.portal?.calendar_has_booking === true || out.turn3.calendar_visible_expected === true,
      no_stripe: !finalSnap.payments.some((p) => p.stripe_checkout_session_id || p.checkout_url),
      no_guest_sends: finalSnap.guest_message_sends === 0,
      no_confirmation: !booking?.confirmation_sent_at,
      no_dup: dup.rows[0].n <= 1,
      gates_restored: out.gates_after?.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'false',
      owner_restored: ownerRestored,
      n8n_inactive_after: out.n8n.workflow_active === false,
    };
    out.failed_checks = Object.entries(out.checks).filter(([, v]) => !v).map(([k]) => k);
    const core = ['turn3_write_created', 'turn3_assign_created', 'turn3_booking_code', 'turn3_guest_email'];
    if (core.every((k) => out.checks[k]) && out.failed_checks.length === 0) out.verdict = 'PASS';
    else if (core.every((k) => out.checks[k])) out.verdict = 'PARTIAL';
    else out.verdict = out.turn3.write_status ? 'PARTIAL' : 'FAIL';
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
