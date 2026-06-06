/**
 * Phase 22a — Verifier for inbound Meta booking write preview.
 *
 * Usage:
 *   npm run verify:luna-agent-phase22-inbound-booking-write-preview
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PREVIEW = path.join(__dirname, 'lib', 'luna-inbound-booking-write-preview.js');
const PROCESS = path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js');
const WEBHOOK = path.join(__dirname, 'lib', 'luna-meta-whatsapp-webhook.js');
const PKG = path.join(ROOT, 'package.json');

const REF_DATE = '2026-06-05';
const GATES_OFF_ENV = {
  WHATSAPP_DRY_RUN: 'true',
  LUNA_AUTO_SEND_ENABLED: '',
  BOT_BOOKING_ENABLED: '',
  STRIPE_LINKS_ENABLED: 'false',
};

const COMPLETE_FIXTURE_MSG =
  'Hi, we are 2 people and want Malibu from September 24 to September 27. We can pay the deposit.';

const DOWNSTREAM = [
  'verify:luna-agent-phase19-meta-whatsapp-webhook',
  'verify:luna-agent-phase13-booking-write-bridge',
  'verify:luna-agent-phase21-closeout',
];

const META_TEXT_PAYLOAD = {
  object: 'whatsapp_business_account',
  entry: [{
    changes: [{
      value: {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: '1152900101233109' },
        contacts: [{ profile: { name: 'Phase22 Preview Guest' }, wa_id: '15555550301' }],
        messages: [{
          from: '15555550301',
          id: 'wamid.phase22a.complete.001',
          timestamp: '1760000001',
          type: 'text',
          text: { body: COMPLETE_FIXTURE_MSG },
        }],
      },
    }],
  }],
};

const META_IMAGE_PAYLOAD = {
  object: 'whatsapp_business_account',
  entry: [{
    changes: [{
      value: {
        metadata: { phone_number_id: '1152900101233109' },
        messages: [{
          from: '15555550302',
          id: 'wamid.phase22a.image.001',
          timestamp: '1760000002',
          type: 'image',
          image: { id: 'media123', mime_type: 'image/jpeg' },
        }],
      },
    }],
  }],
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

function metaTextPayload(bodyText, waMessageId) {
  const payload = JSON.parse(JSON.stringify(META_TEXT_PAYLOAD));
  payload.entry[0].changes[0].value.messages[0].text.body = bodyText;
  if (waMessageId) payload.entry[0].changes[0].value.messages[0].id = waMessageId;
  return payload;
}

function makeBedMockPg() {
  const eventRows = new Map();
  const eventKeyOf = (slug, wa) => `${slug}\0${wa}`;
  let eventSeq = 0;
  let bookingInserts = 0;
  let paymentInserts = 0;
  let bridgeInvokes = 0;

  const bedRows = [
    { bed_code: 'MOCK-B1', room_code: 'R1', room_type: 'shared', bed_active: true, bed_sellable: true, bed_label: 'B1' },
    { bed_code: 'MOCK-B2', room_code: 'R1', room_type: 'shared', bed_active: true, bed_sellable: true, bed_label: 'B2' },
  ];

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

  return {
    eventRows,
    get bookingInserts() { return bookingInserts; },
    get paymentInserts() { return paymentInserts; },
    get bridgeInvokes() { return bridgeInvokes; },
    query: async (sql, params = []) => {
      const norm = sql.replace(/\s+/g, ' ').trim().toLowerCase();

      if (/insert into bookings/i.test(norm)) { bookingInserts += 1; return { rows: [] }; }
      if (/insert into payments/i.test(norm)) { paymentInserts += 1; return { rows: [] }; }
      if (/booking-create-from-plan/i.test(norm)) { bridgeInvokes += 1; throw new Error('bridge_forbidden'); }
      if (/graph\.facebook\.com/i.test(norm)) throw new Error('graph_api_forbidden');
      if (/api\.stripe\.com/i.test(norm)) throw new Error('stripe_forbidden');

      if (norm.includes('from guest_message_events where')) {
        const row = eventRows.get(eventKeyOf(params[0], params[1]));
        return { rows: row ? [eventDbRow(row)] : [] };
      }

      if (norm.includes('insert into guest_message_events') && norm.includes('on conflict')) {
        const k = eventKeyOf(params[0], params[5]);
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

      if (norm.includes('from guest_message_sends where')) return { rows: [] };
      if (norm.includes('insert into guest_message_sends')) return { rows: [] };
      if (/bot_pause_states/i.test(sql)) return { rows: [] };
      if (/from\s+booking_beds/i.test(sql)) return { rows: [] };
      if (/from\s+rooms\s+r/i.test(sql) && /bd\.bed_code/i.test(sql)) return { rows: bedRows };
      return { rows: [] };
    },
  };
}

console.log('\nverify-luna-agent-phase22-inbound-booking-write-preview.js  (Phase 22a)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const previewSrc = readOrEmpty(PREVIEW);
const processSrc = readOrEmpty(PROCESS);
const webhookSrc = readOrEmpty(WEBHOOK);

const {
  buildInboundBookingWritePreview,
  buildInboundBookingWriteIdempotencyPreview,
  PREVIEW_SAFETY_FLAGS,
  BRIDGE_ROUTE,
} = require('./lib/luna-inbound-booking-write-preview');
const {
  normalizeMetaWhatsAppWebhook,
  buildDraftInputFromNormalized,
  buildMetaWhatsAppWebhookPostResponse,
} = require('./lib/luna-meta-whatsapp-webhook');
const { buildLunaGuestReplyDraft } = require('./lib/luna-guest-reply-draft');
const { processMetaWhatsAppWebhookInbound } = require('./lib/luna-meta-whatsapp-inbound-process');

section('A. Module wiring');

if (fs.existsSync(PREVIEW)) pass('A1', 'luna-inbound-booking-write-preview.js exists');
else fail('A1', 'preview module missing');

if (processSrc.includes('luna-inbound-booking-write-preview')) {
  pass('A2', 'inbound process imports booking write preview');
} else fail('A2', 'inbound process import missing');

if (processSrc.includes('buildInboundBookingWritePreview')) {
  pass('A3', 'inbound process builds booking_write_preview');
} else fail('A3', 'buildInboundBookingWritePreview not called');

if (processSrc.includes('booking_write_preview')) {
  pass('A4', 'inbound process persists booking_write_preview in normalized');
} else fail('A4', 'booking_write_preview persistence missing');

if (webhookSrc.includes('booking_write_preview')) {
  pass('A5', 'webhook response includes booking_write_preview');
} else fail('A5', 'webhook response field missing');

section('B. Static safety — no write/send/external');

const forbidden = [
  ['B.runBridge', /runLunaGuestBookingWriteBridge\s*\(/, 'runLunaGuestBookingWriteBridge invoke'],
  ['B.handleCreate', /handleBotBookingCreateFromPlan\s*\(/, 'handleBotBookingCreateFromPlan invoke'],
  ['B.graph', /graph\.facebook\.com/i, 'Graph API'],
  ['B.stripe', /api\.stripe\.com/i, 'Stripe API'],
  ['B.n8n', /\/api\/v1\/workflows\/|activateWorkflow/i, 'n8n activation'],
];

for (const [id, re, label] of forbidden) {
  if (!re.test(processSrc) && !re.test(previewSrc)) pass(id, `preview path avoids ${label}`);
  else fail(id, `${label} found in preview/inbound modules`);
}

if (!/INSERT INTO bookings/i.test(processSrc) && !/INSERT INTO payments/i.test(processSrc)) {
  pass('B.sql', 'inbound process avoids booking/payment INSERT');
} else fail('B.sql', 'booking/payment INSERT in inbound process');

for (const flag of ['creates_booking', 'creates_payment', 'creates_stripe_link', 'sends_whatsapp', 'calls_n8n']) {
  if (PREVIEW_SAFETY_FLAGS[flag] === false) pass('B.flag.' + flag, `${flag} false in preview safety flags`);
  else fail('B.flag.' + flag, `${flag} safety flag wrong`);
}

section('C. Idempotency key format');

const idem = buildInboundBookingWriteIdempotencyPreview('wolfhouse-somo', 'wamid.test.001');
if (idem === 'luna-booking:wolfhouse-somo:wamid.test.001:v1') {
  pass('C1', 'idempotency_key_preview format luna-booking:client:wa_message_id:v1');
} else {
  fail('C1', `unexpected idempotency preview: ${idem}`);
}

section('D. Complete booking fixture — write preview');

async function runCompletePreview(waMessageId) {
  const payload = metaTextPayload(COMPLETE_FIXTURE_MSG, waMessageId);
  const norm = normalizeMetaWhatsAppWebhook(payload);
  const input = buildDraftInputFromNormalized(norm);
  const pg = makeBedMockPg();
  const draft = await buildLunaGuestReplyDraft(
    { ...input, reference_date: REF_DATE },
    { pg, reference_date: REF_DATE, env: GATES_OFF_ENV },
  );
  const preview = buildInboundBookingWritePreview(draft, input, GATES_OFF_ENV);
  const resp = buildMetaWhatsAppWebhookPostResponse(norm, {}, {
    draft,
    draft_called: true,
    booking_write_preview: preview,
  });
  return { norm, input, draft, preview, resp, pg };
}

(async () => {
  const waId = 'wamid.phase22a.complete.001';
  const { preview, resp, input } = await runCompletePreview(waId);
  const errs = [];

  if (preview.eligible !== true) errs.push('eligible should be true');
  if (preview.action !== 'create_booking_and_payment_draft') errs.push('action wrong');
  if (preview.would_call !== BRIDGE_ROUTE) errs.push(`would_call should be ${BRIDGE_ROUTE}`);
  if (preview.confirm_required !== true) errs.push('confirm_required should be true');
  if (!preview.idempotency_key_preview || !preview.idempotency_key_preview.includes(waId)) {
    errs.push('idempotency_key_preview missing wa_message_id');
  }
  if (!preview.booking_create_payload_preview) errs.push('booking_create_payload_preview missing');
  else {
    const p = preview.booking_create_payload_preview;
    if (p.confirm !== false) errs.push('payload confirm should be false');
    if (p.client_slug !== 'wolfhouse-somo') errs.push('payload client_slug wrong');
    if (p.package_code !== 'malibu') errs.push('payload package_code wrong');
    if (p.payment_choice !== 'deposit') errs.push('payload payment_choice wrong');
    if (p.check_in !== '2026-09-24' || p.check_out !== '2026-09-27') errs.push('payload dates wrong');
    if (p.guest_count !== 2) errs.push('payload guest_count wrong');
    if (!p.phone) errs.push('payload phone missing');
    if (!p.guest_name) errs.push('payload guest_name missing');
    if (!Array.isArray(p.selected_bed_codes) || !p.selected_bed_codes.length) {
      errs.push('payload selected_bed_codes missing');
    }
  }
  if (preview.server_requotes_on_write !== true) errs.push('server_requotes_on_write missing');
  if (preview.amounts_not_final !== true) errs.push('amounts_not_final missing');
  if (!Array.isArray(preview.blocked_reasons) || preview.blocked_reasons.length) {
    errs.push('blocked_reasons should be empty when eligible');
  }
  if (resp.booking_write_preview !== preview) errs.push('response booking_write_preview mismatch');
  if (resp.creates_booking !== false || resp.creates_payment !== false) errs.push('response write flags wrong');
  if (resp.sends_whatsapp !== false) errs.push('response sends_whatsapp should be false');

  if (errs.length) fail('D.complete', errs.join('; '));
  else pass('D.complete', 'complete booking text → eligible write preview with safe payload');

  section('E. Incomplete / risky / unsupported');

  const partialPayload = metaTextPayload(
    'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
    'wamid.phase22a.partial.001',
  );
  const partialNorm = normalizeMetaWhatsAppWebhook(partialPayload);
  const partialInput = buildDraftInputFromNormalized(partialNorm);
  const partialDraft = await buildLunaGuestReplyDraft(
    { ...partialInput, reference_date: REF_DATE },
    { reference_date: REF_DATE, env: GATES_OFF_ENV },
  );
  const partialPreview = buildInboundBookingWritePreview(partialDraft, partialInput, GATES_OFF_ENV);
  if (partialPreview.eligible === false
    && partialPreview.blocked_reasons.length
    && !partialPreview.booking_create_payload_preview) {
    pass('E.incomplete', 'incomplete message → eligible false, blocked_reasons, no payload');
  } else {
    fail('E.incomplete', 'incomplete preview should be blocked without payload');
  }

  const refundPayload = metaTextPayload(
    'I want a refund and need to talk to someone.',
    'wamid.phase22a.refund.001',
  );
  const refundNorm = normalizeMetaWhatsAppWebhook(refundPayload);
  const refundInput = buildDraftInputFromNormalized(refundNorm);
  const refundDraft = await buildLunaGuestReplyDraft(
    { ...refundInput, reference_date: REF_DATE },
    { reference_date: REF_DATE, env: GATES_OFF_ENV },
  );
  const refundPreview = buildInboundBookingWritePreview(refundDraft, refundInput, GATES_OFF_ENV);
  if (refundPreview.eligible === false
    && refundPreview.blocked_reasons.some((r) => /handoff|refund/i.test(r))
    && !refundPreview.booking_create_payload_preview) {
    pass('E.refund', 'refund/risky message → eligible false with handoff reason');
  } else {
    fail('E.refund', 'refund preview should handoff block without payload');
  }

  const imageNorm = normalizeMetaWhatsAppWebhook(META_IMAGE_PAYLOAD);
  const imageOut = await processMetaWhatsAppWebhookInbound({
    pg: makeBedMockPg(),
    env: GATES_OFF_ENV,
    body: META_IMAGE_PAYLOAD,
    signatureMeta: { skipped: true },
  });
  if (imageOut.response.draft_called === false
    && !imageOut.response.booking_write_preview) {
    pass('E.unsupported', 'unsupported image → no write preview');
  } else {
    fail('E.unsupported', 'unsupported image should not expose write preview');
  }

  section('F. Inbound persistence stores preview metadata');

  const pg = makeBedMockPg();
  const completePayload = metaTextPayload(COMPLETE_FIXTURE_MSG, 'wamid.phase22a.persist.001');
  const inboundOut = await processMetaWhatsAppWebhookInbound({
    pg,
    env: GATES_OFF_ENV,
    body: completePayload,
    signatureMeta: { skipped: true },
  });
  const storedRow = [...pg.eventRows.values()][0];
  const storedPreview = storedRow
    && storedRow.normalized
    && storedRow.normalized.booking_write_preview;
  const persistErrs = [];

  if (!storedPreview || storedPreview.eligible !== true) {
    persistErrs.push('normalized.booking_write_preview.eligible not stored');
  }
  if (!inboundOut.response.booking_write_preview
    || inboundOut.response.booking_write_preview.eligible !== true) {
    persistErrs.push('response booking_write_preview missing');
  }
  if (pg.bookingInserts !== 0 || pg.paymentInserts !== 0) {
    persistErrs.push('mock pg saw booking/payment inserts');
  }
  if (inboundOut.response.sends_whatsapp !== false) {
    persistErrs.push('inbound path sent WhatsApp');
  }

  if (persistErrs.length) fail('F.persist', persistErrs.join('; '));
  else pass('F.persist', 'guest_message_events normalized stores booking_write_preview');

  section('G. Does not invoke booking-create-from-plan');

  if (!previewSrc.includes('runLunaGuestBookingWriteBridge')
    && !processSrc.includes('runLunaGuestBookingWriteBridge')) {
    pass('G1', 'preview path does not call write bridge');
  } else fail('G1', 'write bridge invoked from preview path');

  if (BRIDGE_ROUTE === 'POST /staff/bot/booking-create-from-plan') {
    pass('G2', 'would_call targets booking-create-from-plan route');
  } else fail('G2', 'BRIDGE_ROUTE wrong');

  section('H. npm script registration');

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  const scriptKey = 'verify:luna-agent-phase22-inbound-booking-write-preview';
  const rel = 'scripts/verify-luna-agent-phase22-inbound-booking-write-preview.js';
  if (pkg.scripts && pkg.scripts[scriptKey] === `node ${rel}`) {
    pass('H1', `${scriptKey} registered`);
  } else fail('H1', `${scriptKey} missing or wrong path`);

  section('I. Downstream verifiers (limited)');

  for (const script of DOWNSTREAM) {
    try {
      execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 300000 });
      pass('I.' + script, `${script} still passes`);
    } catch (e) {
      fail('I.' + script, `${script} failed`);
      const out = (e.stdout || '') + (e.stderr || '');
      console.error(out.split('\n').slice(-10).join('\n'));
    }
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})();
