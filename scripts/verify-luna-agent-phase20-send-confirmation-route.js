/**
 * Phase 20j — Verifier for Luna booking confirmation send route.
 *
 * Usage:
 *   npm run verify:luna-agent-phase20-send-confirmation-route
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HELPER = path.join(__dirname, 'lib', 'luna-booking-confirmation-send.js');
const SEND_ROUTE = path.join(__dirname, 'lib', 'luna-guest-reply-send-route.js');
const API = path.join(__dirname, 'staff-query-api.js');
const PKG = path.join(ROOT, 'package.json');

const PHASE20_BOOKING_ID = '828538c7-c6cb-4c6f-b45a-57a641af37cc';
const PHASE20_BOOKING_CODE = 'MB-WOLFHO-20260924-e90132';
const ANCHOR_ROOM = 'DEMO-R1';
const ANCHOR_ADDRESS = 'C. Mies de La Ran, 41, 39140 Somo, Cantabria';
const ANCHOR_GATE = '2684#';

const GATES_ON_ENV = {
  LUNA_AUTO_SEND_ENABLED: 'true',
  WHATSAPP_DRY_RUN: 'false',
  WHATSAPP_ACCESS_TOKEN: 'mock-token',
  WHATSAPP_PHONE_NUMBER_ID: 'mock-phone-id',
};

const AUTO_ON_DRY_ENV = {
  LUNA_AUTO_SEND_ENABLED: 'true',
  WHATSAPP_DRY_RUN: 'true',
};

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch { return ''; }
}

function makeConfirmationDraft(overrides) {
  return Object.assign({
    booking_code: PHASE20_BOOKING_CODE,
    guest_name: 'Phase 20b Booking Proof',
    payment_status: 'deposit_paid',
    amount_paid_cents: 10000,
    balance_due_cents: 17000,
    room_number: ANCHOR_ROOM,
    address: ANCHOR_ADDRESS,
    gate_code: ANCHOR_GATE,
    sends_whatsapp: false,
    whatsapp_dry_run: true,
  }, overrides || {});
}

function makeBookingRow(overrides) {
  const draft = overrides && overrides.confirmation_draft !== undefined
    ? overrides.confirmation_draft
    : makeConfirmationDraft();
  const metadata = draft === null ? {} : { confirmation_draft: draft };
  if (overrides && overrides.metadata) Object.assign(metadata, overrides.metadata);
  return {
    booking_id: PHASE20_BOOKING_ID,
    booking_code: PHASE20_BOOKING_CODE,
    payment_status: 'deposit_paid',
    confirmation_sent_at: null,
    primary_room_code: ANCHOR_ROOM,
    amount_paid_cents: 10000,
    total_amount_cents: 27000,
    metadata,
    ...(overrides || {}),
  };
}

function createGuestMessageSendMockPg() {
  const rows = new Map();
  const keyOf = (slug, idem) => `${slug}\0${idem}`;
  let seq = 0;

  function dbRow(row) {
    return {
      id: row.id,
      client_slug: row.client_slug,
      channel: row.channel || 'whatsapp',
      to_phone: row.to_phone,
      idempotency_key: row.idempotency_key,
      send_kind: row.send_kind,
      source: row.source,
      message_text: row.message_text,
      status: row.status,
      blocked_reasons: row.blocked_reasons || [],
      provider_message_id: row.provider_message_id || null,
      provider_response: row.provider_response || null,
      created_at: row.created_at || new Date().toISOString(),
      sent_at: row.sent_at || null,
      updated_at: row.updated_at || new Date().toISOString(),
    };
  }

  return {
    rows,
    query: async (sql, params = []) => {
      const norm = sql.replace(/\s+/g, ' ').trim().toLowerCase();

      if (norm.includes('from guest_message_sends where')) {
        const row = rows.get(keyOf(params[0], params[1]));
        return { rows: row ? [dbRow(row)] : [] };
      }

      if (norm.includes('insert into guest_message_sends') && norm.includes('on conflict')) {
        const k = keyOf(params[0], params[3]);
        if (rows.has(k)) return { rows: [] };
        const row = {
          id: `gms-${++seq}`,
          client_slug: params[0],
          channel: params[1],
          to_phone: params[2],
          idempotency_key: params[3],
          send_kind: params[4],
          source: params[5],
          message_text: params[6],
          status: norm.includes("'pending'") ? 'pending' : 'blocked',
          blocked_reasons: norm.includes("'pending'") ? [] : JSON.parse(params[7] || '[]'),
          provider_message_id: null,
          provider_response: null,
        };
        rows.set(k, row);
        return { rows: [dbRow(row)] };
      }

      if (norm.startsWith('update guest_message_sends') && norm.includes("status = 'sent'")) {
        const row = [...rows.values()].find((r) => r.id === params[0]);
        if (!row) return { rows: [] };
        row.status = 'sent';
        row.provider_message_id = params[1];
        row.blocked_reasons = [];
        row.sent_at = new Date().toISOString();
        row.updated_at = row.sent_at;
        return { rows: [dbRow(row)] };
      }

      if (norm.startsWith('update guest_message_sends') && norm.includes("status = 'blocked'")) {
        const row = [...rows.values()].find((r) => r.id === params[0]);
        if (!row) return { rows: [] };
        row.status = 'blocked';
        row.blocked_reasons = JSON.parse(params[1] || '[]');
        row.updated_at = new Date().toISOString();
        return { rows: [dbRow(row)] };
      }

      if (/bot_pause_states/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

function createCombinedMockPg(bookingRow, paymentRows) {
  const gms = createGuestMessageSendMockPg();
  let booking = bookingRow ? { ...bookingRow } : null;
  const rooms = [ANCHOR_ROOM];
  const payments = paymentRows || [{
    payment_type: 'full_amount',
    status: 'checkout_created',
    amount_cents: 17000,
    checkout_url: 'https://checkout.stripe.com/mock-balance',
  }];

  const baseQuery = gms.query.bind(gms);

  return {
    gmsRows: gms.rows,
    getBooking: () => booking,
    seedGms: (row) => {
      const k = `${row.client_slug || 'wolfhouse-somo'}\0${row.idempotency_key}`;
      gms.rows.set(k, {
        id: row.id || 'gms-seeded',
        client_slug: row.client_slug || 'wolfhouse-somo',
        channel: 'whatsapp',
        to_phone: row.to_phone || '+491726422307',
        idempotency_key: row.idempotency_key,
        send_kind: row.send_kind || 'confirmation',
        source: row.source || 'booking_confirmation_preview',
        message_text: row.message_text || 'seeded preview',
        status: row.status,
        blocked_reasons: row.blocked_reasons || [],
        provider_message_id: row.provider_message_id || null,
        sent_at: row.sent_at || null,
      });
    },
    query: async (sql, params = []) => {
      const s = String(sql);
      const norm = s.replace(/\s+/g, ' ').trim().toLowerCase();

      if (/from\s+bookings\s+b/i.test(s) && /clients\s+c/i.test(s)) {
        if (!booking) return { rows: [] };
        return { rows: [booking] };
      }

      if (/from\s+booking_beds/i.test(s)) {
        return { rows: rooms.map((rc) => ({ room_code: rc })) };
      }

      if (/from\s+payments\s+p/i.test(s)) {
        return { rows: payments };
      }

      if (norm.includes('confirmation_sent_at = now()')) {
        if (!booking || booking.confirmation_sent_at) return { rows: [] };
        booking = {
          ...booking,
          confirmation_sent_at: new Date().toISOString(),
          metadata: {
            ...(booking.metadata || {}),
            ...JSON.parse(params[0] || '{}'),
          },
        };
        return { rows: [{ confirmation_sent_at: booking.confirmation_sent_at }] };
      }

      if (/select b\.confirmation_sent_at/i.test(s)) {
        return { rows: booking ? [{ confirmation_sent_at: booking.confirmation_sent_at }] : [] };
      }

      return baseQuery(sql, params);
    },
  };
}

function sendBody(idem) {
  return {
    client_slug: 'wolfhouse-somo',
    booking_id: PHASE20_BOOKING_ID,
    to: '+491726422307',
    idempotency_key: idem || `luna-confirmation:wolfhouse-somo:${PHASE20_BOOKING_ID}:v1`,
    confirm_send: true,
  };
}

console.log('\nverify-luna-agent-phase20-send-confirmation-route.js  (Phase 20j)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const helperSrc = readOrEmpty(HELPER);
const sendRouteSrc = readOrEmpty(SEND_ROUTE);
const apiSrc = readOrEmpty(API);

const routeIdx = apiSrc.indexOf("'/staff/bot/bookings/send-confirmation'");
const routeBlock = routeIdx > -1 ? apiSrc.slice(routeIdx, routeIdx + 700) : '';
const handlerStart = apiSrc.indexOf('async function handleBotBookingSendConfirmation(');
const handlerEnd = handlerStart > -1
  ? apiSrc.indexOf('\n// Route: POST /staff/bot/checkin-day-preview', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? apiSrc.slice(handlerStart, handlerEnd)
  : '';

section('A. Route + helper presence');

if (fs.existsSync(HELPER)) pass('A1', 'luna-booking-confirmation-send.js exists');
else fail('A1', 'send helper missing');

if (routeIdx > -1) pass('A2', 'POST /staff/bot/bookings/send-confirmation registered');
else fail('A2', 'route not registered');

if (routeBlock.includes("method !== 'POST'")) pass('A3', 'POST-only guard');
else fail('A3', 'POST-only guard missing');

if (routeBlock.includes('requireBotAuth')) pass('A4', 'route uses requireBotAuth');
else fail('A4', 'requireBotAuth missing');

if (handler.includes('sendLunaBookingConfirmation')) pass('A5', 'handler calls sendLunaBookingConfirmation');
else fail('A5', 'send helper not wired in handler');

if (helperSrc.includes('getLunaBookingConfirmationPreview')) pass('A6', 'helper loads confirmation preview');
else fail('A6', 'preview helper not used');

if (helperSrc.includes('evaluateGuestReplySendRouteWithPause')) pass('A7', 'helper delegates to guest-reply-send');
else fail('A7', 'guest-reply-send delegation missing');

if (helperSrc.includes("send_kind: 'confirmation'")) pass('A8', 'send_kind confirmation wired');
else fail('A8', 'send_kind confirmation missing');

if (helperSrc.includes("source: 'booking_confirmation_preview'")) pass('A9', 'source booking_confirmation_preview wired');
else fail('A9', 'source missing');

if (helperSrc.includes('confirm_send === true')) pass('A10', 'confirm_send required');
else fail('A10', 'confirm_send guard missing');

if (/idempotent_replay_backfill|isSentAuditReplayBackfill/.test(helperSrc)) {
  pass('A11', 'sent-audit idempotent replay backfill wired');
} else {
  fail('A11', 'sent-audit replay backfill missing');
}

section('B. Static safety');

const combinedSafety = helperSrc + handler + sendRouteSrc;

if (!/(require\(['"]stripe['"]\)|new\s+Stripe\(|stripe\.checkout\.sessions\.create)/i.test(helperSrc)) {
  pass('B1', 'no Stripe API in send helper');
} else {
  fail('B1', 'Stripe API detected in send helper');
}

if (!/\bINSERT\s+INTO\s+payments\b/i.test(helperSrc)) pass('B2', 'no payment INSERT in send helper');
else fail('B2', 'payment INSERT in send helper');

if (!/\bINSERT\s+INTO\s+bookings\b/i.test(helperSrc)) pass('B3', 'no booking INSERT in send helper');
else fail('B3', 'booking INSERT in send helper');

if (/calls_n8n:\s*false/.test(helperSrc)) pass('B4', 'calls_n8n false in helper');
else fail('B4', 'calls_n8n safety flag missing');

if (/confirmation_sent_at IS NULL/.test(helperSrc)) pass('B5', 'confirmation_sent_at update guarded by IS NULL');
else fail('B5', 'confirmation_sent_at IS NULL guard missing');

if (!/activateN8n|triggerN8n|fetchN8n\s*\(/i.test(handler)) pass('B6', 'handler has no n8n activation');
else fail('B6', 'n8n activation reference in handler');

section('C. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts
  && pkg.scripts['verify:luna-agent-phase20-send-confirmation-route']
    === 'node scripts/verify-luna-agent-phase20-send-confirmation-route.js') {
  pass('C1', 'verify:luna-agent-phase20-send-confirmation-route registered');
} else {
  fail('C1', 'npm script missing or wrong path');
}

section('D. Runtime behavior (mock pg)');

const { sendLunaBookingConfirmation } = require('./lib/luna-booking-confirmation-send');

(async () => {
  const noConfirm = await sendLunaBookingConfirmation(
    { ...sendBody(), confirm_send: false },
    { pg: createCombinedMockPg(makeBookingRow()) },
  );
  if (noConfirm.status === 400 && noConfirm.result.error === 'confirm_send_required') {
    pass('D.confirm', 'confirm_send === true required');
  } else {
    fail('D.confirm', `confirm_send guard failed: ${JSON.stringify(noConfirm)}`);
  }

  let evaluateCalls = 0;
  const alreadySent = await sendLunaBookingConfirmation(sendBody('already-sent-skip'), {
    pg: createCombinedMockPg(makeBookingRow({
      confirmation_sent_at: '2026-06-01T10:00:00.000Z',
    })),
    getLunaBookingConfirmationPreview: async () => ({
      success: true,
      booking_id: PHASE20_BOOKING_ID,
      booking_code: PHASE20_BOOKING_CODE,
      confirmation_sent_at: '2026-06-01T10:00:00.000Z',
      message_preview: 'Already sent preview',
    }),
    evaluateGuestReplySendRouteWithPause: async () => {
      evaluateCalls += 1;
      return { status: 200, result: { success: true, send_performed: true } };
    },
  });
  if (alreadySent.result.confirmation_already_sent === true
    && alreadySent.result.idempotent === true
    && evaluateCalls === 0
    && alreadySent.result.updates_confirmation_sent_at === false) {
    pass('D.already', 'confirmation_sent_at already set skips provider');
  } else {
    fail('D.already', `already-sent skip failed evaluate=${evaluateCalls} body=${JSON.stringify(alreadySent.result)}`);
  }

  const blockedPg = createCombinedMockPg(makeBookingRow());
  const blocked = await sendLunaBookingConfirmation(sendBody('phase20j-dry-block'), {
    pg: blockedPg,
    env: AUTO_ON_DRY_ENV,
    sendMessage: async () => ({ success: true, whatsapp_message_id: 'should-not-send' }),
  });
  if (blocked.result.send_performed !== true
    && blocked.result.updates_confirmation_sent_at === false
    && blockedPg.getBooking().confirmation_sent_at == null) {
    pass('D.blocked', 'blocked/dry-run send does not set confirmation_sent_at');
  } else {
    fail('D.blocked', `blocked path failed: ${JSON.stringify(blocked.result)}`);
  }

  const successPg = createCombinedMockPg(makeBookingRow());
  let successProviderCalls = 0;
  const mockSendMessage = async () => {
    successProviderCalls += 1;
    return { success: true, whatsapp_message_id: 'mock-wamid-phase20j' };
  };

  const first = await sendLunaBookingConfirmation(sendBody('phase20j-success-once'), {
    pg: successPg,
    env: GATES_ON_ENV,
    sendMessage: mockSendMessage,
  });
  const r1 = first.result;
  if (r1.success === true
    && r1.send_performed === true
    && r1.send_kind === 'confirmation'
    && r1.updates_confirmation_sent_at === true
    && successPg.getBooking().confirmation_sent_at
    && r1.confirmation_send_audit
    && r1.confirmation_send_audit.confirmation_sent_via === 'whatsapp') {
    pass('D.success', 'successful send sets confirmation_sent_at + audit metadata');
  } else {
    fail('D.success', `success path failed: ${JSON.stringify(r1)} bookingSent=${successPg.getBooking().confirmation_sent_at}`);
  }

  const second = await sendLunaBookingConfirmation(sendBody('phase20j-success-once'), {
    pg: successPg,
    env: GATES_ON_ENV,
    sendMessage: mockSendMessage,
  });
  const r2 = second.result;
  if (successProviderCalls === 1
    && (r2.duplicate === true || r2.idempotent_replay === true)
    && r2.send_performed === false) {
    pass('D.replay', 'replay with same idempotency_key does not call provider again');
  } else {
    fail('D.replay', `replay failed calls=${successProviderCalls} body=${JSON.stringify(r2)}`);
  }

  const gmsRow = [...successPg.gmsRows.values()].find((r) => r.idempotency_key === 'phase20j-success-once');
  if (gmsRow && gmsRow.send_kind === 'confirmation' && gmsRow.source === 'booking_confirmation_preview') {
    pass('D.gms', 'guest_message_sends idempotency path used with confirmation kind');
  } else {
    fail('D.gms', `guest_message_sends audit missing or wrong kind: ${JSON.stringify(gmsRow)}`);
  }

  let previewLoadCount = 0;
  const previewOnlyPg = createCombinedMockPg(makeBookingRow());
  const withPreview = await sendLunaBookingConfirmation(sendBody('phase20j-preview-load'), {
    pg: previewOnlyPg,
    env: GATES_ON_ENV,
    getLunaBookingConfirmationPreview: async () => {
      previewLoadCount += 1;
      return {
        success: true,
        booking_id: PHASE20_BOOKING_ID,
        booking_code: PHASE20_BOOKING_CODE,
        confirmation_sent_at: null,
        message_preview: 'Cami confirmation preview text',
        template_source: 'playbook',
        balance_payment_link_status: 'included_existing_link',
      };
    },
    sendMessage: async () => ({ success: true, whatsapp_message_id: 'mock-preview-load' }),
  });
  if (previewLoadCount === 1 && withPreview.result.message_preview === 'Cami confirmation preview text') {
    pass('D.preview', 'loads confirmation preview before send');
  } else {
    fail('D.preview', `preview load failed count=${previewLoadCount}`);
  }

  if (!/\bINSERT\s+INTO\s+payments\b/i.test(combinedSafety)
    && !/\bINSERT\s+INTO\s+bookings\b/i.test(helperSrc)) {
    pass('D.nocreate', 'no booking/payment creation in send path');
  } else {
    fail('D.nocreate', 'booking/payment creation detected');
  }

  section('E. Sent-audit idempotent replay backfill');

  const backfillPg = createCombinedMockPg(makeBookingRow());
  backfillPg.seedGms({
    id: 'gms-backfill-sent',
    idempotency_key: 'phase20j-backfill-sent',
    status: 'sent',
    provider_message_id: 'mock-wamid-backfill-sent',
    send_kind: 'confirmation',
  });
  let backfillProviderCalls = 0;
  const backfill = await sendLunaBookingConfirmation(sendBody('phase20j-backfill-sent'), {
    pg: backfillPg,
    env: AUTO_ON_DRY_ENV,
    sendMessage: async () => {
      backfillProviderCalls += 1;
      return { success: true, whatsapp_message_id: 'should-not-call' };
    },
  });
  const rb = backfill.result;
  if (rb.idempotent_replay === true
    && rb.send_performed !== true
    && rb.sends_whatsapp !== true
    && rb.updates_confirmation_sent_at === true
    && backfillPg.getBooking().confirmation_sent_at
    && rb.confirmation_send_audit
    && rb.confirmation_send_audit.confirmation_send_id === 'gms-backfill-sent'
    && rb.confirmation_send_audit.confirmation_provider_message_id === 'mock-wamid-backfill-sent'
    && rb.confirmation_send_audit.confirmation_sent_source === 'idempotent_replay_backfill'
    && backfillProviderCalls === 0) {
    pass('E.backfill', 'sent audit replay backfills confirmation_sent_at without provider');
  } else {
    fail('E.backfill', `backfill failed calls=${backfillProviderCalls} body=${JSON.stringify(rb)}`);
  }

  const blockedReplayPg = createCombinedMockPg(makeBookingRow());
  const blockedReplay = await sendLunaBookingConfirmation(sendBody('phase20j-backfill-blocked'), {
    pg: blockedReplayPg,
    evaluateGuestReplySendRouteWithPause: async () => ({
      status: 200,
      result: {
        success: false,
        send_performed: false,
        sends_whatsapp: false,
        duplicate: true,
        idempotent_replay: true,
        guest_message_send_id: 'gms-blocked',
        guest_message_send_status: 'blocked',
        blocked_reasons: ['whatsapp_dry_run_active'],
      },
    }),
  });
  if (blockedReplay.result.updates_confirmation_sent_at !== true
    && blockedReplayPg.getBooking().confirmation_sent_at == null) {
    pass('E.blocked', 'blocked audit replay does not set confirmation_sent_at');
  } else {
    fail('E.blocked', `blocked replay backfill leak: ${JSON.stringify(blockedReplay.result)}`);
  }

  const failedReplayPg = createCombinedMockPg(makeBookingRow());
  const failedReplay = await sendLunaBookingConfirmation(sendBody('phase20j-backfill-failed'), {
    pg: failedReplayPg,
    evaluateGuestReplySendRouteWithPause: async () => ({
      status: 200,
      result: {
        success: false,
        send_performed: false,
        duplicate: true,
        idempotent_replay: true,
        guest_message_send_id: 'gms-failed',
        guest_message_send_status: 'failed',
        blocked_reasons: ['provider_error'],
      },
    }),
  });
  if (failedReplay.result.updates_confirmation_sent_at !== true
    && failedReplayPg.getBooking().confirmation_sent_at == null) {
    pass('E.failed', 'failed audit replay does not set confirmation_sent_at');
  } else {
    fail('E.failed', `failed replay backfill leak: ${JSON.stringify(failedReplay.result)}`);
  }

  const alreadyBackfillPg = createCombinedMockPg(makeBookingRow({
    confirmation_sent_at: '2026-06-01T12:00:00.000Z',
    metadata: { confirmation_send_id: 'existing-id' },
  }));
  alreadyBackfillPg.seedGms({
    id: 'gms-already',
    idempotency_key: 'phase20j-backfill-already',
    status: 'sent',
    provider_message_id: 'mock-wamid-already',
  });
  let alreadyEvaluateCalls = 0;
  const alreadyBackfill = await sendLunaBookingConfirmation(sendBody('phase20j-backfill-already'), {
    pg: alreadyBackfillPg,
    evaluateGuestReplySendRouteWithPause: async () => {
      alreadyEvaluateCalls += 1;
      return { status: 200, result: { success: true, send_performed: true } };
    },
  });
  if (alreadyBackfill.result.send_skipped_reason === 'confirmation_sent_at_already_set'
    && alreadyEvaluateCalls === 0
    && alreadyBackfill.result.updates_confirmation_sent_at !== true) {
    pass('E.already', 'confirmation_sent_at already set skips provider and rewrite');
  } else {
    fail('E.already', `already-set skip failed evaluate=${alreadyEvaluateCalls} body=${JSON.stringify(alreadyBackfill.result)}`);
  }

  section('Summary');
  console.log(`\n  ${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
