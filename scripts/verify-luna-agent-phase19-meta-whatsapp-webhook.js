/**
 * Phase 19g — Verifier for Meta WhatsApp inbound webhook routes.
 *
 * Usage:
 *   npm run verify:luna-agent-phase19-meta-whatsapp-webhook
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const HELPER = path.join(__dirname, 'lib', 'luna-meta-whatsapp-webhook.js');
const PKG = path.join(ROOT, 'package.json');

const REF_DATE = '2026-06-05';

const DOWNSTREAM = [
  'verify:luna-agent-phase19-guest-reply-send-route',
  'verify:luna-agent-phase19-whatsapp-provider',
];

const META_TEXT_PAYLOAD = {
  object: 'whatsapp_business_account',
  entry: [{
    id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: {
          display_phone_number: '34663439419',
          phone_number_id: '1152900101233109',
        },
        contacts: [{
          profile: { name: 'Meta Webhook Test Guest' },
          wa_id: '15555550301',
        }],
        messages: [{
          from: '15555550301',
          id: 'wamid.phase19g1.text.001',
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
          id: 'wamid.phase19g1.image.001',
          timestamp: '1760000002',
          type: 'image',
          image: { id: 'media123', mime_type: 'image/jpeg' },
        }],
      },
    }],
  }],
};

function metaTextPayload(bodyText, waMessageId) {
  const payload = JSON.parse(JSON.stringify(META_TEXT_PAYLOAD));
  payload.entry[0].changes[0].value.messages[0].text.body = bodyText;
  if (waMessageId) payload.entry[0].changes[0].value.messages[0].id = waMessageId;
  return payload;
}

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(filePath) {
  try { return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''; }
  catch { return ''; }
}

console.log('\nverify-luna-agent-phase19-meta-whatsapp-webhook.js  (Phase 19g.8)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const {
  DEFAULT_META_WHATSAPP_VERIFY_TOKEN,
  verifyMetaHubChallenge,
  verifyMetaHubSignature256,
  normalizeMetaWhatsAppWebhook,
  buildDraftInputFromNormalized,
  resolveMetaWebhookSendKind,
  buildMetaInboundIdempotencyKey,
  shouldAttemptMetaWebhookSend,
  buildMetaWebhookSendBody,
  buildMetaWhatsAppWebhookPostResponse,
  WEBHOOK_SAFETY_FLAGS,
} = require('./lib/luna-meta-whatsapp-webhook');
const { buildLunaGuestReplyDraft } = require('./lib/luna-guest-reply-draft');
const { evaluateGuestReplySendRoute } = require('./lib/luna-guest-reply-send-route');

const GATES_OFF_ENV = { WHATSAPP_DRY_RUN: 'true', LUNA_AUTO_SEND_ENABLED: '' };

const apiSrc = readOrEmpty(API);
const helperSrc = readOrEmpty(HELPER);
const routeIdx = apiSrc.indexOf("'/staff/meta/whatsapp/webhook'");
const handlerGetStart = apiSrc.indexOf('function handleMetaWhatsAppWebhookGet(');
const handlerGetEnd = handlerGetStart > -1
  ? apiSrc.indexOf('\nasync function handleMetaWhatsAppWebhookPost(', handlerGetStart)
  : -1;
const handlerGet = handlerGetStart > -1 && handlerGetEnd > handlerGetStart
  ? apiSrc.slice(handlerGetStart, handlerGetEnd)
  : '';
const handlerPostStart = apiSrc.indexOf('async function handleMetaWhatsAppWebhookPost(');
const handlerPostEnd = handlerPostStart > -1
  ? apiSrc.indexOf('\n// Route: POST /staff/stripe/webhook  (Stage 8.4.11', handlerPostStart)
  : -1;
const handlerPost = handlerPostStart > -1 && handlerPostEnd > handlerPostStart
  ? apiSrc.slice(handlerPostStart, handlerPostEnd)
  : '';
const combinedSrc = helperSrc + handlerPost + apiSrc.slice(routeIdx, routeIdx + 900);

section('A. Route registration');

if (routeIdx > -1) pass('A1', 'GET/POST /staff/meta/whatsapp/webhook registered');
else fail('A1', 'route not registered');

if (combinedSrc.includes('handleMetaWhatsAppWebhookGet')) pass('A2', 'GET handler present');
else fail('A2', 'GET handler missing');

if (combinedSrc.includes('handleMetaWhatsAppWebhookPost')) pass('A3', 'POST handler present');
else fail('A3', 'POST handler missing');

if (/method === 'GET'/.test(apiSrc.slice(routeIdx, routeIdx + 600))) pass('A4', 'GET method branch');
else fail('A4', 'GET method branch missing');

if (/method === 'POST'/.test(apiSrc.slice(routeIdx, routeIdx + 600))) pass('A5', 'POST method branch');
else fail('A5', 'POST method branch missing');

section('B. GET hub challenge verification');

const validChallenge = verifyMetaHubChallenge({
  'hub.mode': 'subscribe',
  'hub.verify_token': DEFAULT_META_WHATSAPP_VERIFY_TOKEN,
  'hub.challenge': 'challenge-token-abc123',
}, {});

if (validChallenge.ok && validChallenge.challenge === 'challenge-token-abc123') {
  pass('B1', 'valid verify token returns challenge');
} else {
  fail('B1', 'valid verify token failed');
}

const badToken = verifyMetaHubChallenge({
  'hub.mode': 'subscribe',
  'hub.verify_token': 'wrong-token',
  'hub.challenge': 'x',
}, {});

if (!badToken.ok && badToken.status === 403) pass('B2', 'wrong verify token returns 403');
else fail('B2', 'wrong token should 403');

if (handlerGet.includes('sendPlainText')) pass('B3', 'GET returns plain text challenge');
else fail('B3', 'GET should use sendPlainText');

if (handlerGet.includes('verifyMetaHubChallenge')) pass('B4', 'GET uses verifyMetaHubChallenge helper');
else fail('B4', 'GET helper wiring missing');

section('C. POST normalization — Meta text payload');

const normalized = normalizeMetaWhatsAppWebhook(META_TEXT_PAYLOAD);
const checks = [
  ['C1', 'client_slug wolfhouse-somo', normalized.client_slug === 'wolfhouse-somo'],
  ['C2', 'phone_number_id', normalized.phone_number_id === '1152900101233109'],
  ['C3', 'wa_message_id', normalized.wa_message_id === 'wamid.phase19g1.text.001'],
  ['C4', 'from', normalized.from === '15555550301'],
  ['C5', 'message_text', normalized.message_text && normalized.message_text.includes('Malibu')],
  ['C6', 'profile_name', normalized.profile_name === 'Meta Webhook Test Guest'],
  ['C7', 'message_type text', normalized.message_type === 'text'],
  ['C8', 'supported true', normalized.supported === true],
  ['C9', 'timestamp', normalized.timestamp === '1760000001'],
];
for (const [id, label, ok] of checks) {
  if (ok) pass(id, label);
  else fail(id, label);
}

const draftInput = buildDraftInputFromNormalized(normalized);
if (draftInput
  && draftInput.client_slug === 'wolfhouse-somo'
  && draftInput.channel === 'whatsapp'
  && draftInput.from === '15555550301'
  && draftInput.guest_name === 'Meta Webhook Test Guest'
  && draftInput.message_text === normalized.message_text
  && draftInput.wa_message_id === 'wamid.phase19g1.text.001'
  && draftInput.language === null) {
  pass('C10', 'buildDraftInputFromNormalized maps Meta fields');
} else {
  fail('C10', 'draft input mapping wrong');
}

section('D. Unsupported message type');

const imageNorm = normalizeMetaWhatsAppWebhook(META_IMAGE_PAYLOAD);
if (imageNorm.message_type === 'image') pass('D1', 'extracts image message_type');
else fail('D1', 'image message_type missing');
if (imageNorm.supported === false) pass('D2', 'unsupported image flagged');
else fail('D2', 'image should be unsupported');
if (!imageNorm.message_text) pass('D3', 'unsupported type has no message_text');
else fail('D3', 'unsupported should not expose text');

const imageDraftInput = buildDraftInputFromNormalized(imageNorm);
if (imageDraftInput === null) pass('D4', 'unsupported image skips draft input');
else fail('D4', 'unsupported should not build draft input');

const imageResp = buildMetaWhatsAppWebhookPostResponse(imageNorm, {}, { draft_called: false, send_attempted: false });
if (imageResp.draft_called === false) pass('D5', 'unsupported image draft_called false');
else fail('D5', 'unsupported image should not call draft');
if (imageResp.send_attempted === false) pass('D6', 'unsupported image send_attempted false');
else fail('D6', 'unsupported image should not attempt send');

section('E. Signature verification (mock secret)');

const secret = 'test-meta-app-secret-19g1';
const raw = JSON.stringify(META_TEXT_PAYLOAD);
const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
const goodSig = verifyMetaHubSignature256(Buffer.from(raw), sig, { META_APP_SECRET: secret });
const badSig = verifyMetaHubSignature256(Buffer.from(raw), 'sha256=deadbeef', { META_APP_SECRET: secret });
const skipped = verifyMetaHubSignature256(Buffer.from(raw), sig, {});

if (goodSig.verified === true && goodSig.skipped === false) pass('E1', 'valid signature verifies');
else fail('E1', 'valid signature failed');
if (badSig.verified === false && badSig.skipped === false) pass('E2', 'invalid signature rejected');
else fail('E2', 'invalid signature should fail');
if (skipped.skipped === true && skipped.verified === false) pass('E3', 'missing app secret skips verification');
else fail('E3', 'skip path wrong');

section('F. Handler draft + send gate wiring');

if (handlerPost.includes('processMetaWhatsAppWebhookInbound')) {
  pass('F1', 'handler delegates to processMetaWhatsAppWebhookInbound');
} else fail('F1', 'processMetaWhatsAppWebhookInbound missing from handler');

if (!handlerPost.includes('buildLunaGuestReplyDraft')) {
  pass('F2', 'handler draft brain moved to inbound process module');
} else fail('F2', 'handler should delegate draft to process module');

if (handlerPost.includes('send_attempted')) pass('F6', 'handler tracks send_attempted');
else fail('F6', 'send_attempted missing from handler');

if (handlerPost.includes('guest_message_event_id') || handlerPost.includes('idempotent_replay')) {
  pass('F8', 'handler audit includes persistence replay metadata');
} else fail('F8', 'persistence replay audit fields missing');

if (!/requireBotAuth|requireStaffAuth/.test(handlerPost)) pass('F7', 'POST handler has no bot auth');
else fail('F7', 'POST handler should not require bot auth');

section('G. Safety — no send/write/external calls');

const forbidden = [
  ['graph.facebook.com', /graph\.facebook\.com/i],
  ['api.stripe.com', /api\.stripe\.com/i],
  ['booking-create', /booking-create|bookings\/create/i],
  ['payment-link', /payment-link|create-stripe-link/i],
  ['n8n activation', /\/api\/v1\/workflows\/|activateWorkflow/i],
];

for (const [label, re] of forbidden) {
  if (!re.test(handlerPost)) pass('G.' + label, 'handler avoids ' + label);
  else fail('G.' + label, label + ' found in POST handler');
}

const sqlPatterns = [/\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /pg\.query\s*\(/];
for (const re of sqlPatterns) {
  if (!re.test(handlerPost)) pass('G.sql.' + re.source, 'no direct SQL write in handler');
  else fail('G.sql.' + re.source, 'SQL write pattern in handler');
}

if (handlerPost.includes('sigResult.skipped') || handlerPost.includes('signature_verification_skipped')) {
  pass('G.sig', 'signature skip path in handler');
} else {
  fail('G.sig', 'signature skip path missing');
}

for (const flag of Object.keys(WEBHOOK_SAFETY_FLAGS)) {
  if (WEBHOOK_SAFETY_FLAGS[flag] === true || WEBHOOK_SAFETY_FLAGS[flag] === false) {
    if (helperSrc.includes(flag)) pass('G.flag.' + flag, flag + ' in webhook safety flags');
    else fail('G.flag.' + flag, flag + ' missing from safety flags');
  }
}

section('H. Draft brain fixtures via Meta normalization');

async function assertMetaDraft(id, metaPayload, expect) {
  const norm = normalizeMetaWhatsAppWebhook(metaPayload);
  const input = buildDraftInputFromNormalized(norm);
  if (!input) {
    fail(id, 'expected draft input from supported text');
    return;
  }
  const draft = await buildLunaGuestReplyDraft(
    { ...input, reference_date: REF_DATE },
    { reference_date: REF_DATE },
  );
  const resp = buildMetaWhatsAppWebhookPostResponse(norm, {}, { draft, draft_called: true });
  const errs = [];

  if (resp.draft_called !== true) errs.push('draft_called should be true');
  if (!resp.suggested_reply) errs.push('suggested_reply missing');
  if (!resp.next_action) errs.push('next_action missing');
  if (!resp.send_eligibility) errs.push('send_eligibility missing');
  if (!resp.messaging_playbook || resp.messaging_playbook.playbook_loaded !== true) {
    errs.push('Cami playbook metadata missing');
  }
  for (const flag of ['preview_only', 'draft_only', 'no_write_performed', 'sends_whatsapp', 'calls_graph_api']) {
    if (resp[flag] !== WEBHOOK_SAFETY_FLAGS[flag]) errs.push(`${flag} wrong on response`);
  }

  if (expect.next_action && resp.next_action !== expect.next_action) {
    errs.push(`next_action: expected ${expect.next_action} got ${resp.next_action}`);
  }
  if (expect.suggested_contains && !String(resp.suggested_reply || '').includes(expect.suggested_contains)) {
    errs.push(`suggested_reply missing "${expect.suggested_contains}"`);
  }
  if (expect.has_dry_run === true && !resp.dry_run_plan) errs.push('dry_run_plan expected');
  if (expect.handoff && resp.handoff_required !== true) errs.push('handoff_required expected');

  if (errs.length) fail(id, errs.join('; '));
  else pass(id, expect.label || id);
}

async function assertMetaSendGate(id, metaPayload, expect) {
  const norm = normalizeMetaWhatsAppWebhook(metaPayload);
  const input = buildDraftInputFromNormalized(norm);
  if (!input) {
    fail(id, 'expected draft input');
    return;
  }
  const draft = await buildLunaGuestReplyDraft(
    { ...input, reference_date: REF_DATE },
    { reference_date: REF_DATE },
  );
  const shouldSend = shouldAttemptMetaWebhookSend(draft, norm);
  const errs = [];

  if (expect.send_attempted === false) {
    if (shouldSend) errs.push('shouldAttemptMetaWebhookSend should be false');
    const resp = buildMetaWhatsAppWebhookPostResponse(norm, {}, {
      draft,
      draft_called: true,
      send_attempted: false,
    });
    if (resp.send_attempted !== false) errs.push('send_attempted should be false');
    if (resp.send_result) errs.push('send_result should be absent');
  } else {
    if (!shouldSend) errs.push('shouldAttemptMetaWebhookSend should be true');
    const sendKind = resolveMetaWebhookSendKind(draft.next_action);
    if (expect.send_kind && sendKind !== expect.send_kind) {
      errs.push(`send_kind: expected ${expect.send_kind} got ${sendKind}`);
    }
    const sendBody = buildMetaWebhookSendBody(norm, draft, sendKind);
    if (!sendBody.idempotency_key.includes(norm.wa_message_id)) {
      errs.push('idempotency_key missing wa_message_id');
    }
    if (expect.idempotency_contains) {
      for (const part of expect.idempotency_contains) {
        if (!sendBody.idempotency_key.includes(part)) {
          errs.push(`idempotency_key missing "${part}"`);
        }
      }
    }
    const evaluated = evaluateGuestReplySendRoute(sendBody, GATES_OFF_ENV);
    const sendResult = evaluated.result;
    const resp = buildMetaWhatsAppWebhookPostResponse(norm, {}, {
      draft,
      draft_called: true,
      send_attempted: true,
      send_result: sendResult,
      idempotency_key: sendBody.idempotency_key,
    });

    if (resp.send_attempted !== true) errs.push('send_attempted should be true');
    if (sendResult.send_performed !== false) errs.push('send_performed should be false with gates off');
    if (sendResult.sends_whatsapp !== false) errs.push('sends_whatsapp should be false');
    if (!sendResult.blocked_reasons.includes('luna_auto_send_not_enabled')) {
      errs.push('blocked_reasons missing luna_auto_send_not_enabled');
    }
    if (resp.sends_whatsapp !== false) errs.push('response sends_whatsapp should be false');
    if (resp.calls_graph_api !== false) errs.push('response calls_graph_api should be false');
    if (resp.creates_booking !== false || resp.creates_payment !== false) {
      errs.push('response must not create booking/payment');
    }
  }

  if (errs.length) fail(id, errs.join('; '));
  else pass(id, expect.label || id);
}

(async () => {
  await assertMetaDraft('H.it.partial', metaTextPayload(
    'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
  ), {
    label: 'partial IT → ask_missing_field draft',
    next_action: 'ask_missing_field',
    suggested_contains: 'check-in',
  });

  await assertMetaDraft('H.en.complete', metaTextPayload(
    'Hi, we are 2 people and want to come September 24 to September 27. Do you have Malibu? We can pay the deposit.',
  ), {
    label: 'complete EN → show_quote with dry-run plan',
    next_action: 'show_quote',
    suggested_contains: '€',
    has_dry_run: true,
  });

  await assertMetaDraft('H.refund', metaTextPayload(
    'I want a refund and need to talk to someone.',
  ), {
    label: 'refund → handoff_to_staff',
    next_action: 'handoff_to_staff',
    handoff: true,
  });

  section('I. Send gate — draft → evaluator (default deny)');

  await assertMetaSendGate('I.it.partial', metaTextPayload(
    'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
    'wamid.phase19g5.partial.it.001',
  ), {
    label: 'partial IT → ask_missing_field send_kind, gates off block',
    send_attempted: true,
    send_kind: 'ask_missing_field',
    idempotency_contains: ['wolfhouse-somo', 'wamid.phase19g5.partial.it.001', 'ask_missing_field'],
  });

  await assertMetaSendGate('I.en.complete', metaTextPayload(
    'Hi, we are 2 people and want to come September 24 to September 27. Do you have Malibu? We can pay the deposit.',
    'wamid.phase19g5.complete.en.001',
  ), {
    label: 'complete EN → show_quote send_kind, gates off block',
    send_attempted: true,
    send_kind: 'show_quote',
    idempotency_contains: ['wamid.phase19g5.complete.en.001', 'show_quote'],
  });

  await assertMetaSendGate('I.refund', metaTextPayload(
    'I want a refund and need to talk to someone.',
    'wamid.phase19g5.refund.001',
  ), {
    label: 'refund/handoff → no send attempt',
    send_attempted: false,
  });

  const imageNormGate = normalizeMetaWhatsAppWebhook(META_IMAGE_PAYLOAD);
  if (!shouldAttemptMetaWebhookSend(null, imageNormGate)) {
    pass('I.image', 'unsupported image does not attempt send');
  } else {
    fail('I.image', 'unsupported image should not attempt send');
  }

  const key = buildMetaInboundIdempotencyKey('wolfhouse-somo', 'wamid.test.001', 'ask_missing_field');
  if (key === 'luna:wolfhouse-somo:wamid.test.001:ask_missing_field') {
    pass('I.idem', 'idempotency key format luna:client:wa_message_id:send_kind');
  } else {
    fail('I.idem', `unexpected idempotency key: ${key}`);
  }

  section('J. npm script registration');

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  if (pkg.scripts && pkg.scripts['verify:luna-agent-phase19-meta-whatsapp-webhook']) {
    pass('J1', 'npm script registered');
  } else {
    fail('J1', 'npm script missing');
  }

  section('K. Downstream verifiers (limited)');

  for (const script of DOWNSTREAM) {
    try {
      execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 300000 });
      pass('K.' + script, `${script} still passes`);
    } catch (e) {
      fail('K.' + script, `${script} failed`);
      const out = (e.stdout || '') + (e.stderr || '');
      console.error(out.split('\n').slice(-8).join('\n'));
    }
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})();
