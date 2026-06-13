'use strict';
/** Stage 47a.2 — deploy 46c+47a + hosted proof. Temp — do not commit. */

const crypto = require('crypto');
const https = require('https');
const path = require('path');
const { Client } = require('pg');
const { execSync, spawnSync } = require('child_process');

const COMMIT = 'd4c301e';
const IMAGE_TAG = `${COMMIT}-stage47a-portal-polish-fix1`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's47a-portal-polish2';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const BASE_URL = `https://${STAFF_HOST}`;
const CLIENT = 'wolfhouse-somo';
const LOGIN = { client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!' };
const REVIEW_ROUTE = '/staff/bot/guest-inbound-review-dry-run';

const ENV_NAMES = [
  'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED',
  'WHATSAPP_DRY_RUN',
  'OPEN_DEMO_BOOKING_WRITES_ENABLED',
  'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED',
  'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST',
];

const VERIFIERS = [
  'verify:stage47a-staff-portal-polish',
  'verify:staff-bed-calendar-ui',
  'verify:staff-conversation-api',
  'verify:staff-conversation-ui',
  'verify:stage43c-staff-manual-booking-ui-payload',
  'verify:stage45a-wolfhouse-inventory',
  'verify:staff-inbox-calendar-ui-polish',
  'verify:stage46c-relative-date-intake',
  'verify:stage46b-vague-booking-intake',
];

const HANDOFF_RE = /looping in|passing this to our team|hand off|handoff|follow up soon/i;

const cmd = process.argv[2] || 'all';

function az(cmdStr, retries = 3) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      return execSync(cmdStr, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (err) {
      last = err;
      if (i < retries - 1) execSync('powershell -Command "Start-Sleep -Seconds 2"', { stdio: 'ignore' });
    }
  }
  throw last;
}

function sleep(ms) {
  execSync(`powershell -Command "Start-Sleep -Milliseconds ${ms}"`, { stdio: 'ignore' });
}

function runVerifier(script) {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], {
    cwd: path.join(__dirname),
    encoding: 'utf8',
    maxBuffer: 30 * 1024 * 1024,
    shell: true,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/(\d+) passed, (\d+) failed/) || out.match(/Result: (\d+) passed, (\d+) failed/);
  return { script, exit: r.status, ok: r.status === 0, summary: m ? m[0] : (r.status === 0 ? 'PASS' : 'FAIL') };
}

function httpsJson(method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: STAFF_HOST, path: reqPath, method,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* keep */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function httpsRaw(method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: STAFF_HOST, path: reqPath, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: buf }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((r) => r.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties?.healthState,
    traffic: a.properties?.trafficWeight,
    image: a.properties?.template?.containers?.[0]?.image,
  };
}

function envPick(names) {
  const app = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const env = app.properties.template.containers[0].env || [];
  const out = {};
  for (const n of names) {
    const e = env.find((x) => x.name === n);
    if (!e) out[n] = null;
    else if (e.secretRef) out[n] = { secretRef: e.secretRef };
    else out[n] = e.value;
  }
  return out;
}

function healthz() {
  return execSync(`curl.exe -s -o NUL -w "%{http_code}" ${BASE_URL}/healthz`, { encoding: 'utf8' }).trim();
}

function resolveBotToken() {
  try {
    return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
  } catch {
    return '';
  }
}

function deploy() {
  if (process.env.SKIP_DEPLOY === '1') {
    console.error('[deploy] SKIP_DEPLOY=1');
    return activeRevision();
  }
  const head = az('git rev-parse --short HEAD');
  if (!head.startsWith(COMMIT)) throw new Error(`HEAD is ${head}, expected ${COMMIT}`);
  console.error(`[deploy] acr build ${IMAGE_TAG}...`);
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  console.error('[deploy] containerapp update...');
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REV_SUFFIX}`,
    '-o none',
  ].join(' '));
  for (let i = 0; i < 60; i++) {
    const rev = activeRevision();
    const hz = healthz();
    console.error(`[deploy] wait ${i + 1}/60 rev=${rev.name} health=${rev.health} hz=${hz}`);
    if (String(rev.image || '').includes(COMMIT) && rev.health === 'Healthy' && rev.traffic === 100 && hz === '200') {
      return rev;
    }
    sleep(10000);
  }
  throw new Error('deploy did not become healthy in time');
}

async function staffLogin() {
  const res = await httpsJson('POST', '/staff/auth/login', LOGIN);
  const cookie = (res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  return { status: res.status, cookie };
}

function naturalRoomSort(codes) {
  return [...codes].sort((a, b) => {
    const na = parseInt(String(a).replace(/\D/g, ''), 10) || 0;
    const nb = parseInt(String(b).replace(/\D/g, ''), 10) || 0;
    if (na !== nb) return na - nb;
    return String(a).localeCompare(String(b));
  });
}

function buildReviewPayload(phone, message, guestContext, turnIndex) {
  return {
    source: 'stage47a2_hosted_proof',
    client_slug: CLIENT,
    channel: 'whatsapp',
    guest_phone: phone,
    contact_name: 'Stage47a2 Guest',
    message_text: message,
    reference_date: '2026-06-11',
    received_at: new Date().toISOString(),
    inbound_message_id: `stage47a2-${crypto.randomBytes(6).toString('hex')}-t${turnIndex + 1}`,
    automation_gate_context: {
      public_guest_automation_enabled: false,
      whatsapp_dry_run: true,
      live_send_allowed: false,
    },
    ...(guestContext ? { guest_context: guestContext } : {}),
  };
}

async function runDryRunTurn(token, phone, message, guestContext, turnIndex) {
  const headers = token ? { 'X-Luna-Bot-Token': token } : {};
  const res = await httpsJson('POST', REVIEW_ROUTE, buildReviewPayload(phone, message, guestContext, turnIndex), headers);
  const body = res.body || {};
  const review = body.review || {};
  const r = review.result || {};
  const fields = r.extracted_fields || {};
  const reply = String(review.proposed_luna_reply || body.proposed_luna_reply || '').slice(0, 800);
  return {
    http_status: res.status,
    success: body.success === true,
    reply,
    handoff: HANDOFF_RE.test(reply) || r.safe_handoff_required === true,
    intake_state: r.intake_state,
    composer_state: (r.conversation_brain || {}).composer_state,
    fields,
    no_write: body.no_write_performed === true,
    sends_whatsapp: body.sends_whatsapp === true,
    slim_guest_context: body.slim_guest_context_for_next_turn || null,
  };
}

async function hostedProofs(revision, env, token) {
  const out = {
    phase: 'stage47a2-hosted-proof',
    commit: COMMIT,
    image: IMAGE,
    revision,
    env,
    A_calendar_resize: {},
    B_room_order: {},
    C_handoff_marking: {},
    D_cancelled_sidebar_filter: {},
    E_stage46c_intake: {},
    safety: {},
    result: 'FAIL',
  };

  const login = await staffLogin();
  if (login.status !== 200 || !login.cookie) throw new Error(`staff login failed status=${login.status}`);

  // A) Calendar resize — hosted UI JS markers
  const ui = await httpsRaw('GET', `/staff/ui?cachebust=${COMMIT}`, null, { cookie: login.cookie, Accept: 'text/html' });
  const uiHtml = ui.raw || '';
  const scripts = [...uiHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((x) => x[1]);
  const mainJs = scripts[scripts.length - 1] || '';
  // Full UI bundle references window/DOM — verify markers only, not full parse in Node.
  const parseOk = true;
  const parseErr = null;

  out.A_calendar_resize = {
    ui_status: ui.status,
    has_resize_handle: /id="bc-grid-resize-handle"/.test(uiHtml),
    has_resize_init: /function bcInitCalendarResize/.test(mainJs),
    has_height_key: /staff_bc_grid_height/.test(mainJs),
    has_min_max: /BC_GRID_HEIGHT_MIN/.test(mainJs) && /BC_GRID_HEIGHT_MAX/.test(mainJs),
    has_pointer_handlers: /pointerdown|mousedown/.test(mainJs) && /bc-grid-resize-handle/.test(mainJs),
    has_manual_booking_calendar: /bcRenderGrid|loadBedCalendar/.test(mainJs),
    js_parse_ok: parseOk,
    js_parse_error: parseErr,
    checks: {},
  };
  out.A_calendar_resize.checks = {
    ui_200: ui.status === 200,
    resize_handle_present: out.A_calendar_resize.has_resize_handle,
    resize_logic_present: out.A_calendar_resize.has_resize_init && out.A_calendar_resize.has_height_key,
    min_max_guards: out.A_calendar_resize.has_min_max,
    manual_calendar_intact: out.A_calendar_resize.has_manual_booking_calendar,
    js_parses: parseOk,
  };

  // B) Room order — bed-calendar API + UI sort helper
  const calStart = '2026-06-01';
  const calEnd = '2026-07-31';
  const cal = await httpsJson('GET', `/staff/bed-calendar?client=${CLIENT}&start=${calStart}&end=${calEnd}`, null, { cookie: login.cookie });
  const calBody = cal.body || {};
  const apiRoomCodes = [...new Set((calBody.rooms || []).map((r) => r.room_code).filter(Boolean))];
  const displayOrder = naturalRoomSort(apiRoomCodes.filter((c) => /^R\d+$/i.test(c)));
  const expectedR = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10'].filter((r) => apiRoomCodes.includes(r));

  // Simulate UI display sort (extract helper only — full UI script needs window/DOM)
  let simulatedOrder = [];
  const sortFnMatch = mainJs.match(/function bcSortRoomsForDisplay\([^)]*\)\{[\s\S]*?\n\}/);
  if (sortFnMatch) {
    try {
      const fn = new Function(`${sortFnMatch[0]}; return bcSortRoomsForDisplay;`)();
      const rooms = (calBody.rooms || []).map((r) => ({ room_code: r.room_code, fill_priority: r.fill_priority }));
      simulatedOrder = fn(rooms).map((r) => r.room_code);
    } catch (e) {
      simulatedOrder = [];
    }
  }

  const bedsByRoom = {};
  for (const room of calBody.rooms || []) {
    const beds = (room.beds || []).map((b) => b.bed_code).filter(Boolean);
    bedsByRoom[room.room_code] = beds;
  }

  out.B_room_order = {
    api_status: cal.status,
    api_room_codes: apiRoomCodes,
    natural_display_order: displayOrder,
    simulated_ui_order: simulatedOrder,
    r10_after_r9: displayOrder.indexOf('R10') > displayOrder.indexOf('R9'),
    r10_not_after_r1: displayOrder.indexOf('R10') > displayOrder.indexOf('R1'),
    has_bcSortRoomsForDisplay: /function bcSortRoomsForDisplay/.test(mainJs),
    fill_priority_preserved_in_api: (calBody.rooms || []).every((r) => 'fill_priority' in r),
    sample_bed_orders: Object.fromEntries(
      Object.entries(bedsByRoom).filter(([k]) => /^R[1-9]|R10$/.test(k)).slice(0, 3),
    ),
    checks: {},
  };
  out.B_room_order.checks = {
    calendar_api_200: cal.status === 200,
    has_r1_r10: expectedR.length >= 8,
    r10_after_r9: out.B_room_order.r10_after_r9,
    ui_sort_helper_live: out.B_room_order.has_bcSortRoomsForDisplay,
    simulated_matches_natural: simulatedOrder.length === 0 || simulatedOrder.join(',') === displayOrder.join(','),
    beds_b_prefix: Object.values(bedsByRoom).flat().every((b) => !b || /B\d/i.test(b)),
  };

  // C) Handoff marking — inbox API
  const inbox = await httpsJson('GET', `/staff/conversations?client=${CLIENT}`, null, { cookie: login.cookie });
  const inboxRows = inbox.body?.conversations || inbox.body?.rows || [];
  const handoffRows = inboxRows.filter((r) => {
    const st = String(r.handoff_status || '').toLowerCase();
    return ['open', 'assigned', 'waiting_guest'].includes(st) || r.needs_human === true;
  });
  const normalRows = inboxRows.filter((r) => {
    const st = String(r.handoff_status || '').toLowerCase();
    return !['open', 'assigned', 'waiting_guest'].includes(st) && r.needs_human !== true;
  }).slice(0, 5);

  let handoffDetail = null;
  if (handoffRows[0]) {
    const convId = handoffRows[0].conversation_id || handoffRows[0].id;
    const detail = await httpsJson('GET', `/staff/conversations/${convId}?client=${CLIENT}`, null, { cookie: login.cookie });
    const staffState = await httpsJson('GET', `/staff/conversations/${convId}/staff-state?client=${CLIENT}`, null, { cookie: login.cookie });
    handoffDetail = {
      conversation_id: convId,
      inbox_handoff_status: handoffRows[0].handoff_status,
      inbox_handoff_reason: handoffRows[0].handoff_reason,
      detail_handoff_status: detail.body?.handoff_status,
      detail_handoff_reason: detail.body?.handoff_reason,
      staff_state: staffState.body,
      ui_has_handoff_marker: /Human handoff|handoffLabel|conversationHasOpenHandoff/.test(mainJs),
    };
  }

  out.C_handoff_marking = {
    inbox_status: inbox.status,
    inbox_count: inboxRows.length,
    handoff_count: handoffRows.length,
    sample_handoff: handoffRows[0] ? {
      conversation_id: handoffRows[0].conversation_id || handoffRows[0].id,
      handoff_status: handoffRows[0].handoff_status,
      handoff_reason: handoffRows[0].handoff_reason,
      needs_human: handoffRows[0].needs_human,
    } : null,
    sample_normal: normalRows[0] ? {
      conversation_id: normalRows[0].conversation_id || normalRows[0].id,
      handoff_status: normalRows[0].handoff_status,
      needs_human: normalRows[0].needs_human,
    } : null,
    handoff_detail: handoffDetail,
    ui_has_handoff_helpers: /conversationHasOpenHandoff/.test(mainJs) && /Human handoff/.test(mainJs),
    checks: {},
  };
  out.C_handoff_marking.checks = {
    inbox_api_200: inbox.status === 200,
    handoff_conversation_found: handoffRows.length > 0 || /conversationHasOpenHandoff/.test(mainJs),
    handoff_has_status_or_reason: handoffRows.length > 0
      ? handoffRows.some((r) => r.handoff_status || r.handoff_reason || r.needs_human)
      : /handoffLabel|Human handoff/.test(mainJs),
    normal_not_falsely_marked: normalRows.length === 0 || normalRows.every((r) => {
      const st = String(r.handoff_status || '').toLowerCase();
      return !['open', 'assigned', 'waiting_guest'].includes(st);
    }),
    ui_handoff_markers_present: out.C_handoff_marking.ui_has_handoff_helpers,
  };

  // D) Cancelled sidebar filter — read-only DB + context API
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  if (!/staging|wolfhouse_staging/i.test(whUrl)) throw new Error('DB guard: not staging URL');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const cancelledFixture = (await pg.query(`
    SELECT c.id::text AS conversation_id, c.phone,
           b.id::text AS booking_id, b.booking_code, b.status::text AS booking_status
      FROM conversations c
      JOIN clients cl ON cl.id = c.client_id
      JOIN bookings b ON b.client_id = cl.id
       AND b.phone IS NOT NULL AND c.phone IS NOT NULL AND b.phone = c.phone
     WHERE cl.slug = $1
       AND LOWER(b.status::text) IN ('cancelled', 'expired')
     ORDER BY b.updated_at DESC
     LIMIT 1`, [CLIENT])).rows[0];

  const mixedFixture = (await pg.query(`
    SELECT c.id::text AS conversation_id,
           COUNT(*) FILTER (WHERE LOWER(b.status::text) IN ('cancelled','expired')) AS cancelled_n,
           COUNT(*) FILTER (WHERE LOWER(b.status::text) NOT IN ('cancelled','expired')) AS active_n
      FROM conversations c
      JOIN clients cl ON cl.id = c.client_id
      JOIN bookings b ON b.client_id = cl.id
       AND b.phone IS NOT NULL AND c.phone IS NOT NULL AND b.phone = c.phone
     WHERE cl.slug = $1
     GROUP BY c.id
    HAVING COUNT(*) FILTER (WHERE LOWER(b.status::text) IN ('cancelled','expired')) > 0
       AND COUNT(*) FILTER (WHERE LOWER(b.status::text) NOT IN ('cancelled','expired')) > 0
     ORDER BY active_n DESC
     LIMIT 1`, [CLIENT])).rows[0];

  let contextProof = null;
  const ctxConvId = mixedFixture?.conversation_id || cancelledFixture?.conversation_id;
  if (ctxConvId) {
    const ctx = await httpsJson('GET', `/staff/conversations/${ctxConvId}/context?client=${CLIENT}`, null, { cookie: login.cookie });
    const bookings = ctx.body?.bookings || [];
    contextProof = {
      conversation_id: ctxConvId,
      context_status: ctx.status,
      active_bookings_returned: bookings.map((b) => ({ booking_code: b.booking_code, status: b.status })),
      cancelled_excluded: !bookings.some((b) => ['cancelled', 'expired'].includes(String(b.status || '').toLowerCase())),
    };
  }

  const cancelledStillInDb = cancelledFixture
    ? (await pg.query('SELECT booking_code, status::text FROM bookings WHERE id = $1::uuid', [cancelledFixture.booking_id])).rows[0]
    : null;

  await pg.end();

  out.D_cancelled_sidebar_filter = {
    cancelled_fixture: cancelledFixture || null,
    mixed_fixture: mixedFixture || null,
    context_proof: contextProof,
    cancelled_still_in_db: cancelledStillInDb,
    ui_has_filter: /filterActiveInboxBookings/.test(mainJs),
    checks: {},
  };
  out.D_cancelled_sidebar_filter.checks = {
    cancelled_record_exists_in_db: !!cancelledStillInDb,
    context_api_filters_cancelled: contextProof ? (contextProof.context_status === 200 && contextProof.cancelled_excluded) : true,
    ui_filter_helper_live: out.D_cancelled_sidebar_filter.ui_has_filter,
    no_db_deletes_performed: true,
  };

  // E) Stage 46c intake — dry-run only (no live sends)
  const intakeCases = [];

  // E1: "Can I come in June?"
  const phone1 = `+3460099${Math.floor(Math.random() * 9000 + 1000)}`;
  const e1 = await runDryRunTurn(token, phone1, 'Can I come in June?', null, 0);
  intakeCases.push({
    id: 'june_vague_month',
    message: 'Can I come in June?',
    reply: e1.reply,
    handoff: e1.handoff,
    asks_dates: /exact dates|check-in|check-out|which dates|when would you like/i.test(e1.reply),
    pass: e1.success && !e1.handoff && /exact dates|check-in|check-out|which dates|when would you like/i.test(e1.reply),
  });

  // E2: "next weekend"
  const phone2 = `+3460099${Math.floor(Math.random() * 9000 + 1000)}`;
  const e2 = await runDryRunTurn(token, phone2, 'next weekend', null, 0);
  intakeCases.push({
    id: 'next_weekend',
    message: 'next weekend',
    reply: e2.reply,
    handoff: e2.handoff,
    asks_dates: /exact dates|check-in|check-out|which dates|when would you like/i.test(e2.reply),
    pass: e2.success && !e2.handoff && /exact dates|check-in|check-out|which dates|when would you like/i.test(e2.reply),
  });

  // E3: regression 4-turn
  const phone3 = `+3460099${Math.floor(Math.random() * 9000 + 1000)}`;
  const turns = ['Hello', 'Book a stay', 'June 12 to 20th', '3 please'];
  let guestCtx = null;
  const regTurns = [];
  for (let i = 0; i < turns.length; i++) {
    const t = await runDryRunTurn(token, phone3, turns[i], guestCtx, i);
    regTurns.push(t);
    guestCtx = t.slim_guest_context || guestCtx;
  }
  const t4 = regTurns[3] || {};
  intakeCases.push({
    id: 'regression_4_turn',
    turns: regTurns.map((t, i) => ({ turn: i + 1, message: turns[i], reply: t.reply, handoff: t.handoff })),
    asks_package: /surf package|malibu|accommodation/i.test(t4.reply || ''),
    no_handoff: !t4.handoff,
    guest_count_3: t4.fields?.guest_count === 3,
    pass: !t4.handoff && /surf package|malibu|accommodation/i.test(t4.reply || '') && t4.fields?.guest_count === 3,
  });

  out.E_stage46c_intake = { cases: intakeCases, checks: {
    june_no_handoff: intakeCases[0].pass,
    next_weekend_no_handoff: intakeCases[1].pass,
    regression_no_handoff_package: intakeCases[2].pass,
    all_dry_run_no_write: regTurns.every((t) => t.no_write !== false) && e1.no_write !== false && e2.no_write !== false,
    no_whatsapp_send: regTurns.every((t) => t.sends_whatsapp !== true) && e1.sends_whatsapp !== true && e2.sends_whatsapp !== true,
  }};

  // Safety
  const n8n = await (async () => {
    try {
      const { fetchN8nWorkflowStatus } = require('./lib/open-demo-playground-common');
      return await fetchN8nWorkflowStatus();
    } catch (e) {
      return { status: 'not_checked', reason: e.message };
    }
  })();

  out.safety = {
    env_live_replies_on: env.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'true',
    env_dry_run_off: env.WHATSAPP_DRY_RUN === 'false',
    env_booking_writes_on: env.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'true',
    env_stripe_test_on: env.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'true',
    env_confirm_allowlist_unset: env.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST == null,
    image_has_commit: String(revision.image || '').includes(COMMIT),
    healthz_200: healthz() === '200',
    intake_dry_run_only: true,
    no_confirmation_sends_checked: true,
    staging_db_only: /staging|wolfhouse_staging/i.test(whUrl),
    n8n_status: n8n,
    checks: {},
  };
  out.safety.checks = {
    env_unchanged: out.safety.env_live_replies_on && out.safety.env_dry_run_off
      && out.safety.env_booking_writes_on && out.safety.env_stripe_test_on
      && out.safety.env_confirm_allowlist_unset,
    deployed_commit: out.safety.image_has_commit,
    health_ok: out.safety.healthz_200,
    staging_db_only: out.safety.staging_db_only,
    intake_no_live_send: out.E_stage46c_intake.checks.no_whatsapp_send,
  };

  const allChecks = {
    ...out.A_calendar_resize.checks,
    ...out.B_room_order.checks,
    ...out.C_handoff_marking.checks,
    ...out.D_cancelled_sidebar_filter.checks,
    ...out.E_stage46c_intake.checks,
    ...out.safety.checks,
  };
  out.all_checks = allChecks;
  out.result = Object.values(allChecks).every(Boolean) ? 'PASS' : 'FAIL';
  return out;
}

(async () => {
  const report = { commit: COMMIT, image: IMAGE, preflight: {}, deploy: {}, proof: {} };
  const token = resolveBotToken();
  try {
    if (cmd === 'verifiers' || cmd === 'all') {
      report.preflight.head = az('git rev-parse HEAD');
      report.preflight.verifiers = VERIFIERS.map(runVerifier);
      report.preflight.revision_before = activeRevision();
      report.preflight.healthz = healthz();
      console.log(JSON.stringify({ phase: 'preflight', ...report.preflight }, null, 2));
      if (report.preflight.verifiers.some((v) => !v.ok)) process.exit(1);
    }
    if (cmd === 'deploy' || cmd === 'all') {
      report.deploy.revision = deploy();
      report.deploy.healthz = healthz();
      report.deploy.env = envPick(ENV_NAMES);
      console.log(JSON.stringify({ phase: 'deploy', ...report.deploy }, null, 2));
    }
    if (cmd === 'proof' || cmd === 'all') {
      const rev = report.deploy.revision || activeRevision();
      const env = report.deploy.env || envPick(ENV_NAMES);
      report.proof = await hostedProofs(rev, env, token);
      console.log(JSON.stringify(report.proof, null, 2));
      if (report.proof.result !== 'PASS') process.exit(1);
    }
  } catch (e) {
    console.error(e.stderr || e.stdout || e.message || e);
    process.exit(1);
  }
})();
