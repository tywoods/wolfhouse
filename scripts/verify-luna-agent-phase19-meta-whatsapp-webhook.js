/**
 * Phase 19g.1 — Verifier for Meta WhatsApp inbound webhook routes.
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

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(filePath) {
  try { return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''; }
  catch { return ''; }
}

console.log('\nverify-luna-agent-phase19-meta-whatsapp-webhook.js  (Phase 19g.1)\n');

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
  buildMetaWhatsAppWebhookPostResponse,
  WEBHOOK_SAFETY_FLAGS,
} = require('./lib/luna-meta-whatsapp-webhook');

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

const postResp = buildMetaWhatsAppWebhookPostResponse(normalized, { verified: false, skipped: true });
if (postResp.success === true && postResp.received === true) pass('C10', 'POST response success/received');
else fail('C10', 'POST response envelope missing flags');

for (const flag of ['preview_only', 'no_write_performed', 'sends_whatsapp', 'calls_graph_api', 'calls_n8n']) {
  if (postResp[flag] === WEBHOOK_SAFETY_FLAGS[flag]) pass('C11.' + flag, flag + ' preserved');
  else fail('C11.' + flag, flag + ' missing/wrong');
}

section('D. Unsupported message type');

const imageNorm = normalizeMetaWhatsAppWebhook(META_IMAGE_PAYLOAD);
if (imageNorm.message_type === 'image') pass('D1', 'extracts image message_type');
else fail('D1', 'image message_type missing');
if (imageNorm.supported === false) pass('D2', 'unsupported image flagged');
else fail('D2', 'image should be unsupported');
if (!imageNorm.message_text) pass('D3', 'unsupported type has no message_text');
else fail('D3', 'unsupported should not expose text');

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

section('F. Safety — no send/write/external calls');

const forbidden = [
  ['graph.facebook.com', /graph\.facebook\.com/i],
  ['guest-reply-send', /guest-reply-send|evaluateGuestReplySendRoute/i],
  ['buildLunaGuestReplyDraft', /buildLunaGuestReplyDraft/i],
  ['api.stripe.com', /api\.stripe\.com/i],
  ['booking-create', /booking-create|bookings\/create/i],
  ['payment-link', /payment-link|create-stripe-link/i],
  ['n8n activation', /\/api\/v1\/workflows\/|activateWorkflow/i],
];

for (const [label, re] of forbidden) {
  if (!re.test(handlerPost)) pass('F.' + label, 'handler avoids ' + label);
  else fail('F.' + label, label + ' found in POST handler');
}

const sqlPatterns = [/\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /withPgClient/, /pg\.query/];
for (const re of sqlPatterns) {
  if (!re.test(handlerPost)) pass('F.sql.' + re.source, 'no SQL write in handler');
  else fail('F.sql.' + re.source, 'SQL write pattern in handler');
}

if (handlerPost.includes('sigResult.skipped') || handlerPost.includes('signature_verification_skipped')) {
  pass('F.sig', 'signature skip path in handler');
} else {
  fail('F.sig', 'signature skip path missing');
}

section('G. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts && pkg.scripts['verify:luna-agent-phase19-meta-whatsapp-webhook']) {
  pass('G1', 'npm script registered');
} else {
  fail('G1', 'npm script missing');
}

section('H. Downstream verifiers (limited)');

for (const script of DOWNSTREAM) {
  try {
    execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 300000 });
    pass('H.' + script, `${script} still passes`);
  } catch (e) {
    fail('H.' + script, `${script} failed`);
    const out = (e.stdout || '') + (e.stderr || '');
    console.error(out.split('\n').slice(-8).join('\n'));
  }
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
