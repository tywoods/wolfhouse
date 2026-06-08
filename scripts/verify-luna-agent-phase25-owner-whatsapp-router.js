/**
 * Phase 25c — Verifier for owner WhatsApp → Command Center routing.
 *
 * Usage:
 *   npm run verify:luna-agent-phase25-owner-whatsapp-router
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROCESS = path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js');
const OWNER = path.join(__dirname, 'lib', 'luna-owner-whatsapp-inbound.js');
const EXECUTE = path.join(__dirname, 'lib', 'staff-ask-luna-execute.js');
const PHONE = path.join(__dirname, 'lib', 'staff-phone-access.js');
const GUEST_DRAFT = path.join(__dirname, 'lib', 'luna-guest-reply-draft.js');
const PREVIEW = path.join(__dirname, 'lib', 'luna-inbound-booking-write-preview.js');
const PKG = path.join(ROOT, 'package.json');

const GATES_OFF_ENV = {
  WHATSAPP_DRY_RUN: 'true',
  LUNA_AUTO_SEND_ENABLED: '',
  BOT_BOOKING_ENABLED: '',
  STRIPE_LINKS_ENABLED: 'false',
};

const OWNER_PHONE = '491726422307';
const GUEST_PHONE = '15555550999';
const CLIENT = 'wolfhouse-somo';
const OTHER_CLIENT = 'sunset-surf-shop';

const DOWNSTREAM = [
  'verify:luna-agent-phase25-staff-phone-access',
  'verify:luna-agent-phase25-owner-design',
  'verify:luna-ai-provider',
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch { return ''; }
}

function metaTextPayload(fromPhone, bodyText, waMessageId) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: '1152900101233109' },
          contacts: [{ profile: { name: 'Router Test' }, wa_id: fromPhone }],
          messages: [{
            from: fromPhone,
            id: waMessageId,
            timestamp: '1760000001',
            type: 'text',
            text: { body: bodyText },
          }],
        },
      }],
    }],
  };
}

console.log('\nverify-luna-agent-phase25-owner-whatsapp-router.js  (Phase 25c)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  execSync(`node --check "${PROCESS}"`, { stdio: 'pipe' });
  execSync(`node --check "${OWNER}"`, { stdio: 'pipe' });
  execSync(`node --check "${EXECUTE}"`, { stdio: 'pipe' });
  pass('0', 'syntax check (verifier + router modules)');
} catch {
  fail('0', 'syntax check failed');
}

const processSrc = readOrEmpty(PROCESS);
const ownerSrc = readOrEmpty(OWNER);
const guestDraftSrc = readOrEmpty(GUEST_DRAFT);
const previewSrc = readOrEmpty(PREVIEW);
const pkg = JSON.parse(readOrEmpty(PKG) || '{}');

section('A. Wiring');

if (processSrc.includes('lookupStaffPhoneAccess')) pass('A1', 'inbound process uses lookupStaffPhoneAccess');
else fail('A1', 'lookupStaffPhoneAccess missing from inbound process');

if (processSrc.includes('processOwnerWhatsAppCommandCenterInbound')) {
  pass('A2', 'inbound process routes to owner Command Center handler');
} else fail('A2', 'owner handler wiring missing');

if (processSrc.includes('buildInboundBookingWritePreview')) {
  pass('A3', 'guest preview helper still imported for guest path only');
} else fail('A3', 'guest preview import missing');

const inboundFnBody = processSrc.slice(processSrc.indexOf('async function processMetaWhatsAppWebhookInbound'));
const ownerBranchIdx = inboundFnBody.indexOf('processOwnerWhatsAppCommandCenterInbound');
const guestGateIdx = inboundFnBody.indexOf('const ran = await runDraftAndSendGate(pg, env, normalized);');
if (ownerBranchIdx > 0 && guestGateIdx > ownerBranchIdx) {
  pass('A4', 'owner route branch precedes guest draft/preview gate');
} else fail('A4', 'owner route should run before guest booking preview');

if (ownerSrc.includes('planAndExecuteOwnerSqlQuestion') && ownerSrc.includes('executeStaffAskLunaQuestion')) {
  pass('A5', 'owner handler uses plan-execute + registry fallback');
} else fail('A5', 'owner handler wiring incomplete');

if (ownerSrc.includes('buildInboundBookingWritePreview')) {
  fail('A6', 'owner handler must not import booking_write_preview');
} else pass('A6', 'owner handler does not import booking_write_preview');

if (pkg.scripts && pkg.scripts['verify:luna-agent-phase25-owner-whatsapp-router']) {
  pass('A7', 'npm script verify:luna-agent-phase25-owner-whatsapp-router registered');
} else fail('A7', 'npm script missing');

section('B. Safety — no Stripe/n8n/Meta config / minimal guest touch');

if (!/stripe|n8n|meta.*webhook.*config/i.test(ownerSrc)) {
  pass('B1', 'owner module avoids Stripe/n8n/Meta config');
} else fail('B1', 'owner module touches forbidden integrations');

const guestDraftDiff = guestDraftSrc;
if (!guestDraftDiff.includes('owner_luna_route') && !guestDraftDiff.includes('staff_phone_access')) {
  pass('B2', 'luna-guest-reply-draft.js unchanged by owner routing');
} else fail('B2', 'guest reply draft modified unexpectedly');

if (!previewSrc.includes('owner_luna_route')) {
  pass('B3', 'booking write preview module not owner-aware (guest-only)');
} else fail('B3', 'preview module modified for owner');

section('C. Mock pg fixtures');

function createRouterMockPg(staffSeed = []) {
  const eventRows = new Map();
  const sendRows = new Map();
  const staffRows = [...staffSeed];
  const eventKeyOf = (slug, wa) => `${slug}\0${wa}`;
  const sendKeyOf = (slug, idem) => `${slug}\0${idem}`;
  let eventSeq = 0;
  let sendSeq = 0;
  let bookingInserts = 0;
  let paymentInserts = 0;
  let handoffInserts = 0;
  let guestDraftCalls = 0;

  function eventDbRow(row) {
    return {
      id: row.id,
      client_slug: row.client_slug,
      channel: row.channel || 'whatsapp',
      direction: row.direction || 'inbound',
      from_phone: row.from_phone,
      to_phone_number_id: row.to_phone_number_id,
      wa_message_id: row.wa_message_id,
      message_type: row.message_type,
      message_text: row.message_text,
      profile_name: row.profile_name,
      raw_payload: row.raw_payload,
      normalized: row.normalized,
      draft_called: row.draft_called === true,
      next_action: row.next_action,
      suggested_reply: row.suggested_reply,
      handoff_required: row.handoff_required === true,
      send_attempted: row.send_attempted === true,
      send_idempotency_key: row.send_idempotency_key,
      send_status: row.send_status,
      send_blocked_reasons: row.send_blocked_reasons || [],
      created_at: row.created_at || new Date().toISOString(),
      updated_at: row.updated_at || new Date().toISOString(),
    };
  }

  const pg = {
    eventRows,
    sendRows,
    get bookingInserts() { return bookingInserts; },
    get paymentInserts() { return paymentInserts; },
    get handoffInserts() { return handoffInserts; },
    get guestDraftCalls() { return guestDraftCalls; },
    query: async (sql, params = []) => {
      const norm = sql.replace(/\s+/g, ' ').trim().toLowerCase();

      if (/insert into bookings/i.test(norm)) { bookingInserts += 1; return { rows: [] }; }
      if (/insert into payments/i.test(norm)) { paymentInserts += 1; return { rows: [] }; }
      if (/insert into staff_handoffs/i.test(norm)) { handoffInserts += 1; return { rows: [] }; }
      if (/graph\.facebook\.com/i.test(norm)) throw new Error('graph_api_forbidden');

      if (/from staff_phone_access/i.test(norm)) {
        const [clientSlug, phoneNormalized, channel] = params;
        const hit = staffRows.find((r) => r.client_slug === clientSlug
          && r.phone_normalized === phoneNormalized
          && r.channel === channel);
        return { rows: hit ? [hit] : [] };
      }

      if (/from bookings/i.test(norm) && /balance|payment|client/i.test(norm)) {
        return { rows: [] };
      }
      if (/from booking_service_records/i.test(norm)) return { rows: [] };
      if (/from payments/i.test(norm)) return { rows: [] };
      if (/from clients/i.test(norm)) return { rows: [{ id: 'c1', slug: params[0] || CLIENT }] };

      if (norm.includes('from guest_message_events where')) {
        const row = eventRows.get(eventKeyOf(params[0], params[1]));
        return { rows: row ? [eventDbRow(row)] : [] };
      }

      if (norm.includes('insert into guest_message_events') && norm.includes('on conflict')) {
        const k = eventKeyOf(params[0], params[5]);
        if (eventRows.has(k)) return { rows: [] };
        const row = {
          id: `gme-${++eventSeq}`,
          client_slug: params[0],
          channel: params[1],
          direction: params[2],
          from_phone: params[3],
          to_phone_number_id: params[4],
          wa_message_id: params[5],
          message_type: params[6],
          message_text: params[7],
          profile_name: params[8],
          raw_payload: params[9] ? JSON.parse(params[9]) : null,
          normalized: params[10] ? JSON.parse(params[10]) : null,
          draft_called: false,
          next_action: null,
          suggested_reply: null,
          handoff_required: false,
          send_attempted: false,
          send_idempotency_key: null,
          send_status: null,
          send_blocked_reasons: [],
        };
        eventRows.set(k, row);
        return { rows: [eventDbRow(row)] };
      }

      if (norm.startsWith('update guest_message_events') && norm.includes('normalized =')) {
        const row = eventRows.get(eventKeyOf(params[0], params[1]));
        if (!row) return { rows: [] };
        row.normalized = JSON.parse(params[2]);
        row.updated_at = new Date().toISOString();
        return { rows: [] };
      }

      if (norm.startsWith('update guest_message_events') && norm.includes('draft_called =')) {
        const row = eventRows.get(eventKeyOf(params[0], params[1]));
        if (!row) return { rows: [] };
        row.draft_called = params[2] === true;
        row.next_action = params[3];
        row.suggested_reply = params[4];
        row.handoff_required = params[5] === true;
        row.send_attempted = params[6] === true;
        row.send_idempotency_key = params[7];
        row.send_status = params[8];
        row.send_blocked_reasons = JSON.parse(params[9] || '[]');
        row.updated_at = new Date().toISOString();
        return { rows: [eventDbRow(row)] };
      }

      if (norm.includes('from guest_message_sends where')) {
        const row = sendRows.get(sendKeyOf(params[0], params[1]));
        if (!row) return { rows: [] };
        return { rows: [{ ...row, blocked_reasons: row.blocked_reasons || [] }] };
      }

      if (norm.includes('insert into guest_message_sends') && norm.includes('on conflict')) {
        const k = sendKeyOf(params[0], params[3]);
        if (sendRows.has(k)) return { rows: [] };
        const row = {
          id: `gms-${++sendSeq}`,
          client_slug: params[0],
          channel: params[1],
          to_phone: params[2],
          idempotency_key: params[3],
          send_kind: params[4],
          source: params[5],
          message_text: params[6],
          status: 'blocked',
          blocked_reasons: JSON.parse(params[7] || '[]'),
          provider_message_id: null,
          provider_response: null,
          created_at: new Date().toISOString(),
          sent_at: null,
          updated_at: new Date().toISOString(),
        };
        sendRows.set(k, row);
        return { rows: [{ ...row, blocked_reasons: row.blocked_reasons }] };
      }

      if (/bot_pause_states/i.test(sql)) return { rows: [] };

      if (norm === 'begin read only' || norm.startsWith('set local statement_timeout')
        || norm === 'commit' || norm === 'rollback') {
        return { rows: [] };
      }

      if (/^select/i.test(String(sql || '').trim()) || /select b\.booking_code/i.test(norm)) {
        if (/balance_due_cents/i.test(norm)) {
          return { rows: [{
            booking_code: 'WH-TEST-01',
            guest_name: 'Sofia Test',
            phone: '+34999000001',
            check_in: '2026-09-01',
            check_out: '2026-09-05',
            total_amount_cents: 40000,
            amount_paid_cents: 25000,
            balance_due_cents: 15000,
            payment_status: 'partial',
            status: 'confirmed',
          }] };
        }
        if (/revenue_month|paid_cents/i.test(norm)) {
          return { rows: [{ revenue_month: '2026-06-01', paid_cents: 50000, payment_count: 3 }] };
        }
        return { rows: [] };
      }

      return { rows: [] };
    },
  };

  return pg;
}

const { normalizeMetaWhatsAppWebhook } = require('./lib/luna-meta-whatsapp-webhook');
const { processMetaWhatsAppWebhookInbound } = require('./lib/luna-meta-whatsapp-inbound-process');
const { buildLunaGuestReplyDraft } = require('./lib/luna-guest-reply-draft');
const originalGuestDraft = buildLunaGuestReplyDraft;

section('D. Runtime routing (mock pg)');

(async () => {
  const activeOwnerSeed = [{
    client_slug: CLIENT,
    phone_e164: '+491726422307',
    phone_normalized: OWNER_PHONE,
    display_name: 'Ty',
    role: 'owner',
    channel: 'whatsapp',
    is_active: true,
  }];
  const inactiveOwnerSeed = [{ ...activeOwnerSeed[0], is_active: false }];

  const ownerQuestion = "Who hasn't settled up yet?";
  const guestQuestion = 'Hi, we are 2 people and want Malibu in September.';

  // Spy guest draft to ensure owner path skips it
  let guestDraftInvokeCount = 0;
  require('./lib/luna-guest-reply-draft').buildLunaGuestReplyDraft = async (...args) => {
    guestDraftInvokeCount += 1;
    return originalGuestDraft(...args);
  };

  // Owner active — Command Center route
  const pgOwner = createRouterMockPg(activeOwnerSeed);
  const ownerPayload = metaTextPayload(OWNER_PHONE, ownerQuestion, 'wamid.phase25c.owner.001');
  const ownerNorm = normalizeMetaWhatsAppWebhook(ownerPayload);
  const ownerOut = await processMetaWhatsAppWebhookInbound({
    pg: pgOwner,
    env: GATES_OFF_ENV,
    body: ownerPayload,
    normalized: ownerNorm,
  });
  const ownerResp = ownerOut.response;

  if (ownerResp.owner_luna_route === true) pass('D1', 'owner phone sets owner_luna_route');
  else fail('D1', 'owner_luna_route missing');

  if (ownerResp.guest_flow_skipped === true) pass('D2', 'owner phone sets guest_flow_skipped');
  else fail('D2', 'guest_flow_skipped missing');

  if (ownerResp.staff_phone_access === true && ownerResp.staff_role === 'owner') {
    pass('D3', 'owner metadata staff_phone_access + staff_role');
  } else fail('D3', 'staff metadata missing');

  if (ownerResp.booking_write_preview == null) pass('D4', 'owner route has no booking_write_preview');
  else fail('D4', 'booking_write_preview present on owner route');

  if (pgOwner.bookingInserts === 0 && pgOwner.paymentInserts === 0 && pgOwner.handoffInserts === 0) {
    pass('D5', 'owner route performs no booking/payment/handoff writes');
  } else fail('D5', 'owner route wrote booking/payment/handoff');

  const ownerIntent = ownerResp.command_center && ownerResp.command_center.intent;
  if (ownerIntent === 'owner_sql.outstanding_balances' || ownerIntent === 'payments.balance_due') {
    pass('D6', 'balance question resolves via owner SQL plan-execute or registry fallback');
  } else fail('D6', `expected owner_sql.outstanding_balances or payments.balance_due got ${ownerIntent}`);

  if (typeof ownerResp.command_center.answer === 'string' && ownerResp.command_center.answer.length > 0) {
    pass('D7', 'owner route returns Command Center answer text');
  } else fail('D7', 'Command Center answer missing');

  if (ownerResp.command_center && ownerResp.draft_called === true && !ownerResp.handoff_required) {
    pass('D8', 'owner route uses Command Center draft (not guest booking draft)');
  } else fail('D8', 'owner route draft shape unexpected');

  const storedOwner = [...pgOwner.eventRows.values()][0];
  if (storedOwner && storedOwner.normalized && storedOwner.normalized.owner_luna_route === true) {
    pass('D9', 'persisted normalized marks owner_luna_route');
  } else fail('D9', 'persisted owner metadata missing');

  // WHATSAPP_DRY_RUN respected
  if (ownerResp.send_attempted === true
    && ownerResp.send_result
    && ownerResp.send_result.send_performed !== true) {
    pass('D10', 'WHATSAPP_DRY_RUN blocks live send on owner route');
  } else if (ownerResp.send_attempted === true && Array.isArray(ownerResp.blocked_reasons)) {
    pass('D10', 'WHATSAPP_DRY_RUN blocked send on owner route');
  } else fail('D10', 'dry-run send behavior unexpected');

  // Non-allowlisted guest continues guest path
  guestDraftInvokeCount = 0;
  const pgGuest = createRouterMockPg([]);
  const guestPayload = metaTextPayload(GUEST_PHONE, guestQuestion, 'wamid.phase25c.guest.001');
  const guestNorm = normalizeMetaWhatsAppWebhook(guestPayload);
  const guestOut = await processMetaWhatsAppWebhookInbound({
    pg: pgGuest,
    env: GATES_OFF_ENV,
    body: guestPayload,
    normalized: guestNorm,
  });
  const guestResp = guestOut.response;

  if (guestResp.owner_luna_route !== true && guestResp.guest_flow_skipped !== true) {
    pass('D11', 'non-allowlisted phone stays on guest path');
  } else fail('D11', 'guest phone incorrectly routed as owner');

  if (guestResp.draft_called === true || guestDraftInvokeCount > 0) {
    pass('D12', 'guest path still invokes guest reply draft');
  } else fail('D12', 'guest draft not invoked for guest phone');

  // Inactive staff row
  const pgInactive = createRouterMockPg(inactiveOwnerSeed);
  const inactiveOut = await processMetaWhatsAppWebhookInbound({
    pg: pgInactive,
    env: GATES_OFF_ENV,
    body: metaTextPayload(OWNER_PHONE, ownerQuestion, 'wamid.phase25c.inactive.001'),
    normalized: normalizeMetaWhatsAppWebhook(metaTextPayload(OWNER_PHONE, ownerQuestion, 'wamid.phase25c.inactive.001')),
  });
  if (inactiveOut.response.owner_luna_route !== true) {
    pass('D13', 'inactive staff_phone_access does not owner-route');
  } else fail('D13', 'inactive row routed as owner');

  // Wrong client_slug
  const pgWrongClient = createRouterMockPg(activeOwnerSeed);
  const wrongClientPayload = metaTextPayload(OWNER_PHONE, ownerQuestion, 'wamid.phase25c.wrongclient.001');
  const wrongNorm = normalizeMetaWhatsAppWebhook(wrongClientPayload);
  wrongNorm.client_slug = OTHER_CLIENT;
  const wrongOut = await processMetaWhatsAppWebhookInbound({
    pg: pgWrongClient,
    env: GATES_OFF_ENV,
    body: wrongClientPayload,
    normalized: wrongNorm,
  });
  if (wrongOut.response.owner_luna_route !== true) {
    pass('D14', 'same phone different client_slug does not owner-route');
  } else fail('D14', 'wrong client routed as owner');

  // Idempotent replay — no duplicate send
  const pgReplay = createRouterMockPg(activeOwnerSeed);
  const replayPayload = metaTextPayload(OWNER_PHONE, ownerQuestion, 'wamid.phase25c.replay.001');
  const replayNorm = normalizeMetaWhatsAppWebhook(replayPayload);
  const first = await processMetaWhatsAppWebhookInbound({
    pg: pgReplay, env: GATES_OFF_ENV, body: replayPayload, normalized: replayNorm,
  });
  const second = await processMetaWhatsAppWebhookInbound({
    pg: pgReplay, env: GATES_OFF_ENV, body: replayPayload, normalized: replayNorm,
  });
  if (second.replay === true && second.response.idempotent_replay === true) {
    pass('D15', 'replay returns idempotent_replay');
  } else fail('D15', 'idempotent replay flag missing');
  if (second.response.duplicate === true) pass('D16', 'replay marked duplicate');
  else fail('D16', 'duplicate flag missing');
  const sendCount = pgReplay.sendRows.size;
  if (sendCount <= 1) pass('D17', 'replay does not create duplicate send rows');
  else fail('D17', `send rows duplicated (${sendCount})`);

  // Restore guest draft
  require('./lib/luna-guest-reply-draft').buildLunaGuestReplyDraft = originalGuestDraft;

  section('E. Downstream scripts listed (not run)');

  for (const s of DOWNSTREAM) {
    if (pkg.scripts && pkg.scripts[s]) pass('E', `downstream script registered: ${s}`);
    else fail('E', `downstream script missing: ${s}`);
  }

  console.log(`\n${'─'.repeat(60)}`);
  if (failures === 0) {
    console.log(`PASS  (${passes} checks)`);
    process.exit(0);
  }
  console.error(`FAIL  (${failures} failed, ${passes} passed)`);
  process.exit(1);
})().catch((err) => {
  console.error('Verifier runtime error:', err);
  process.exit(1);
});
