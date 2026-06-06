/**
 * Phase 19g.8 — Verifier for Meta inbound guest_message_events persistence.
 *
 * Usage:
 *   npm run verify:luna-agent-phase19-meta-inbound-persistence
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MIGRATION = path.join(ROOT, 'database', 'migrations', '014_guest_message_events.sql');
const SQL_HELPER = path.join(__dirname, 'lib', 'luna-guest-message-events-sql.js');
const PROCESS = path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js');
const API = path.join(__dirname, 'staff-query-api.js');
const PKG = path.join(ROOT, 'package.json');

const REF_DATE = '2026-06-05';
const GATES_OFF_ENV = { WHATSAPP_DRY_RUN: 'true', LUNA_AUTO_SEND_ENABLED: '' };

const META_TEXT_PAYLOAD = {
  object: 'whatsapp_business_account',
  entry: [{
    changes: [{
      value: {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: '1152900101233109' },
        contacts: [{ profile: { name: 'Persistence Test Guest' }, wa_id: '15555550301' }],
        messages: [{
          from: '15555550301',
          id: 'wamid.phase19g8.text.001',
          timestamp: '1760000001',
          type: 'text',
          text: { body: 'Hi, we are 2 people and want Malibu in September.' },
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
          id: 'wamid.phase19g8.image.001',
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

console.log('\nverify-luna-agent-phase19-meta-inbound-persistence.js  (Phase 19g.8)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const {
  normalizeMetaWhatsAppWebhook,
} = require('./lib/luna-meta-whatsapp-webhook');
const {
  isGuestMessageEventProcessed,
  formatGuestMessageEventRow,
} = require('./lib/luna-guest-message-events-sql');
const {
  processMetaWhatsAppWebhookInbound,
} = require('./lib/luna-meta-whatsapp-inbound-process');

section('A. Migration + helper wiring');

const migSrc = readOrEmpty(MIGRATION);
const sqlSrc = readOrEmpty(SQL_HELPER);
const processSrc = readOrEmpty(PROCESS);
const apiSrc = readOrEmpty(API);
const handlerPostStart = apiSrc.indexOf('async function handleMetaWhatsAppWebhookPost(');
const handlerPostEnd = handlerPostStart > -1
  ? apiSrc.indexOf('\n// Route: POST /staff/stripe/webhook  (Stage 8.4.11', handlerPostStart)
  : -1;
const handlerPost = handlerPostStart > -1 && handlerPostEnd > handlerPostStart
  ? apiSrc.slice(handlerPostStart, handlerPostEnd)
  : '';

if (fs.existsSync(MIGRATION)) pass('A1', '014_guest_message_events migration exists');
else fail('A1', 'migration missing');

if (/CREATE TABLE IF NOT EXISTS guest_message_events/i.test(migSrc)) {
  pass('A2', 'migration creates guest_message_events');
} else fail('A2', 'guest_message_events table missing');

if (/UNIQUE\s*\(\s*client_slug\s*,\s*wa_message_id\s*\)/i.test(migSrc)) {
  pass('A3', 'unique(client_slug, wa_message_id) present');
} else fail('A3', 'unique constraint missing');

if (/draft_called/i.test(migSrc) && /send_attempted/i.test(migSrc) && /handoff_required/i.test(migSrc)) {
  pass('A4', 'decision columns present');
} else fail('A4', 'decision columns missing');

if (fs.existsSync(SQL_HELPER)) pass('A5', 'luna-guest-message-events-sql.js exists');
else fail('A5', 'sql helper missing');

if (processSrc.includes('luna-guest-message-events-sql')) pass('A6', 'inbound process imports events sql helper');
else fail('A6', 'inbound process import missing');

if (handlerPost.includes('processMetaWhatsAppWebhookInbound')) {
  pass('A7', 'POST handler delegates to processMetaWhatsAppWebhookInbound');
} else fail('A7', 'handler persistence wiring missing');

if (!/\bINSERT\b/i.test(handlerPost) && !/\bUPDATE\b/i.test(handlerPost) && !/pg\.query\s*\(/.test(handlerPost)) {
  pass('A8', 'POST handler avoids direct SQL');
} else fail('A8', 'POST handler should not contain direct SQL');

section('B. SQL helper unit checks');

const sampleRow = formatGuestMessageEventRow({
  id: 'evt-1',
  client_slug: 'wolfhouse-somo',
  channel: 'whatsapp',
  direction: 'inbound',
  from_phone: '15555550301',
  to_phone_number_id: '1152900101233109',
  wa_message_id: 'wamid.test',
  message_type: 'text',
  message_text: 'hello',
  profile_name: 'Guest',
  raw_payload: '{}',
  normalized: '{"supported":false}',
  draft_called: false,
  next_action: null,
  suggested_reply: null,
  handoff_required: false,
  send_attempted: false,
  send_idempotency_key: null,
  send_status: null,
  send_blocked_reasons: '[]',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

if (sampleRow && sampleRow.normalized && sampleRow.normalized.supported === false) {
  pass('B1', 'formatGuestMessageEventRow parses json fields');
} else fail('B1', 'formatGuestMessageEventRow failed');

if (isGuestMessageEventProcessed({ normalized: { supported: false }, draft_called: false })) {
  pass('B2', 'unsupported inbound treated as processed');
} else fail('B2', 'unsupported processed check failed');

if (!isGuestMessageEventProcessed({ normalized: { supported: true }, draft_called: false, next_action: null })) {
  pass('B3', 'fresh inbound seed not processed');
} else fail('B3', 'fresh seed should not be processed');

function createCombinedMockPg() {
  const sendRows = new Map();
  const eventRows = new Map();
  const sendKeyOf = (slug, idem) => `${slug}\0${idem}`;
  const eventKeyOf = (slug, wa) => `${slug}\0${wa}`;
  let sendSeq = 0;
  let eventSeq = 0;
  let bookingInserts = 0;
  let paymentInserts = 0;

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
    sendRows,
    bookingInserts,
    paymentInserts,
    query: async (sql, params = []) => {
      const norm = sql.replace(/\s+/g, ' ').trim().toLowerCase();

      if (/insert into bookings/i.test(norm)) { bookingInserts += 1; return { rows: [] }; }
      if (/insert into payments/i.test(norm)) { paymentInserts += 1; return { rows: [] }; }
      if (/graph\.facebook\.com/i.test(norm)) throw new Error('graph_api_forbidden');

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
        return {
          rows: [{
            ...row,
            blocked_reasons: row.blocked_reasons || [],
            provider_response: row.provider_response || null,
          }],
        };
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
      return { rows: [] };
    },
  };
}

section('C. Inbound persistence fixtures (mock pg)');

(async () => {
  const partialPayload = metaTextPayload(
    'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
    'wamid.phase19g8.partial.it.001',
  );
  const refundPayload = metaTextPayload(
    'I want a refund and need to talk to someone.',
    'wamid.phase19g8.refund.001',
  );

  const partialPg = createCombinedMockPg();
  const partialOut = await processMetaWhatsAppWebhookInbound({
    pg: partialPg,
    env: GATES_OFF_ENV,
    body: partialPayload,
    signatureMeta: { skipped: true },
  });
  const partialRow = [...partialPg.eventRows.values()][0];
  const partialResp = partialOut.response;

  if (partialPg.eventRows.size === 1) pass('C.partial.row', 'partial IT inserts one guest_message_events row');
  else fail('C.partial.row', `expected 1 event row got ${partialPg.eventRows.size}`);

  if (partialRow && partialRow.draft_called === true && partialRow.next_action === 'ask_missing_field') {
    pass('C.partial.action', 'partial IT stores ask_missing_field');
  } else fail('C.partial.action', `partial action wrong: ${partialRow && partialRow.next_action}`);

  if (partialRow && partialRow.send_attempted === true && partialRow.send_status === 'blocked') {
    pass('C.partial.send', 'partial IT stores send_attempted true blocked');
  } else fail('C.partial.send', 'partial send metadata wrong');

  if (partialResp.send_attempted === true
    && partialResp.blocked_reasons
    && partialResp.blocked_reasons.includes('luna_auto_send_not_enabled')) {
    pass('C.partial.blocked', 'partial IT blocked under default gates');
  } else fail('C.partial.blocked', 'partial blocked reasons missing');

  const refundPg = createCombinedMockPg();
  const refundOut = await processMetaWhatsAppWebhookInbound({
    pg: refundPg,
    env: GATES_OFF_ENV,
    body: refundPayload,
    signatureMeta: { skipped: true },
  });
  const refundRow = [...refundPg.eventRows.values()][0];

  if (refundRow && refundRow.handoff_required === true && refundRow.next_action === 'handoff_to_staff') {
    pass('C.refund.handoff', 'refund stores handoff_required + handoff_to_staff');
  } else fail('C.refund.handoff', 'refund handoff metadata wrong');

  if (refundRow && refundRow.send_attempted === false && refundPg.sendRows.size === 0) {
    pass('C.refund.no_send', 'refund send_attempted false, no guest_message_sends row');
  } else fail('C.refund.no_send', 'refund should not attempt send');

  if (refundOut.response.send_attempted === false && refundOut.response.sends_whatsapp === false) {
    pass('C.refund.response', 'refund response has no send');
  } else fail('C.refund.response', 'refund response send flags wrong');

  const imagePg = createCombinedMockPg();
  const imageOut = await processMetaWhatsAppWebhookInbound({
    pg: imagePg,
    env: GATES_OFF_ENV,
    body: META_IMAGE_PAYLOAD,
    signatureMeta: { skipped: true },
  });
  const imageRow = [...imagePg.eventRows.values()][0];
  const imageNorm = normalizeMetaWhatsAppWebhook(META_IMAGE_PAYLOAD);

  if (imageRow && imageRow.message_type === 'image' && imageNorm.supported === false) {
    pass('C.image.type', 'unsupported image stores message_type image');
  } else fail('C.image.type', 'image message_type wrong');

  if (imageRow && imageRow.draft_called === false && imageRow.send_attempted === false) {
    pass('C.image.flags', 'unsupported image draft_called false send_attempted false');
  } else fail('C.image.flags', 'unsupported image flags wrong');

  if (imageOut.response.draft_called === false && imageOut.response.send_attempted === false) {
    pass('C.image.response', 'unsupported image response skips draft/send');
  } else fail('C.image.response', 'unsupported image response wrong');

  section('D. Duplicate wa_message_id replay');

  const dupPg = createCombinedMockPg();
  const dupPayload = metaTextPayload(
    'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
    'wamid.phase19g8.dup.001',
  );

  const first = await processMetaWhatsAppWebhookInbound({
    pg: dupPg,
    env: GATES_OFF_ENV,
    body: dupPayload,
    signatureMeta: { skipped: true },
  });
  const second = await processMetaWhatsAppWebhookInbound({
    pg: dupPg,
    env: GATES_OFF_ENV,
    body: dupPayload,
    signatureMeta: { skipped: true },
  });

  if (dupPg.eventRows.size === 1) pass('D1', 'duplicate wa_message_id keeps single event row');
  else fail('D1', `expected 1 event row got ${dupPg.eventRows.size}`);

  if (second.replay === true
    && second.response.duplicate === true
    && second.response.idempotent_replay === true) {
    pass('D2', 'duplicate response marks idempotent_replay');
  } else fail('D2', 'duplicate replay flags missing');

  if (first.response.next_action === second.response.next_action
    && second.response.send_attempted === first.response.send_attempted) {
    pass('D3', 'duplicate returns stored decision metadata');
  } else fail('D3', 'stored replay metadata mismatch');

  if (dupPg.sendRows.size === 1) pass('D4', 'duplicate replay does not re-run send gate audit');
  else fail('D4', `expected 1 send audit row got ${dupPg.sendRows.size}`);

  section('E. Safety — no booking/payment/stripe/n8n/graph');

  const safetyPg = createCombinedMockPg();
  await processMetaWhatsAppWebhookInbound({
    pg: safetyPg,
    env: GATES_OFF_ENV,
    body: partialPayload,
    signatureMeta: { skipped: true },
  });

  if (safetyPg.bookingInserts === 0 && safetyPg.paymentInserts === 0) {
    pass('E1', 'no booking/payment writes during inbound persistence');
  } else fail('E1', 'unexpected booking/payment writes');

  const forbidden = [
    ['graph.facebook.com', /graph\.facebook\.com/i],
    ['api.stripe.com', /api\.stripe\.com/i],
    ['n8n activation', /\/api\/v1\/workflows\/|activateWorkflow/i],
  ];
  for (const [label, re] of forbidden) {
    if (!re.test(processSrc) || !re.test(handlerPost)) pass('E.' + label, 'avoids ' + label);
    else fail('E.' + label, label + ' found in persistence path');
  }

  if (partialResp.sends_whatsapp === false && partialResp.calls_graph_api === false) {
    pass('E2', 'inbound persistence response sends_whatsapp false');
  } else fail('E2', 'unexpected send flags on response');

  section('F. npm script registration');

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  if (pkg.scripts && pkg.scripts['verify:luna-agent-phase19-meta-inbound-persistence']) {
    pass('F1', 'npm script registered');
  } else fail('F1', 'npm script missing');

  section('G. Downstream verifiers (limited)');

  const DOWNSTREAM = [
    'verify:luna-agent-phase19-guest-reply-send-route',
    'verify:luna-agent-phase19-whatsapp-provider',
  ];

  for (const script of DOWNSTREAM) {
    try {
      execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 300000 });
      pass('G.' + script, `${script} still passes`);
    } catch (e) {
      fail('G.' + script, `${script} failed`);
      const out = (e.stdout || '') + (e.stderr || '');
      console.error(out.split('\n').slice(-8).join('\n'));
    }
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error('Verifier crash:', e);
  process.exit(1);
});
