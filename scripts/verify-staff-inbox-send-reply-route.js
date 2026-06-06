/**
 * Phase 23d — Verifier for POST /staff/inbox/send-reply staff session route.
 *
 * Usage:
 *   npm run verify:staff-inbox-send-reply-route
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const HELPER = path.join(__dirname, 'lib', 'luna-staff-inbox-send-reply.js');
const SEND_ROUTE = path.join(__dirname, 'lib', 'luna-guest-reply-send-route.js');
const PKG = path.join(ROOT, 'package.json');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch { return ''; }
}

console.log('\nverify-staff-inbox-send-reply-route.js  (Phase 23d)\n');

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'staff-query-api.js passes node --check');
} catch {
  fail('0', 'staff-query-api.js syntax error');
}

const apiSrc = readOrEmpty(API);
const helperSrc = readOrEmpty(HELPER);
const sendSrc = readOrEmpty(SEND_ROUTE);

const handlerStart = apiSrc.indexOf('async function handleInboxSendReply(');
const handlerEnd = handlerStart > -1
  ? apiSrc.indexOf('async function handleTestResetLunaPhone(', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? apiSrc.slice(handlerStart, handlerEnd)
  : '';

const routeMatch = apiSrc.match(/pathname === '\/staff\/inbox\/send-reply'[\s\S]{0,450}/);
const routeBlock = routeMatch ? routeMatch[0] : '';

const {
  parseInboxSendReplyInput,
  buildStaffInboxGuestReplyBody,
  buildStaffReplyIdempotencyKey,
  STAFF_REPLY_KIND,
  STAFF_REPLY_SOURCE,
} = require('./lib/luna-staff-inbox-send-reply');

const {
  evaluateGuestReplySendRouteWithPause,
  ALLOWED_SEND_KINDS,
} = require('./lib/luna-guest-reply-send-route');

section('A. Route + handler wiring');

if (apiSrc.includes('/staff/inbox/send-reply')) pass('A1', 'route registered');
else fail('A1', 'route missing');

if (apiSrc.includes('handleInboxSendReply')) pass('A2', 'handler present');
else fail('A2', 'handler missing');

if (/requireAuth\(req, res, 'operator'\)/.test(routeBlock)) {
  pass('A3', 'operator session auth required');
} else fail('A3', 'operator auth missing');

if (handler.includes('evaluateGuestReplySendRouteWithPause')) {
  pass('A4', 'delegates to evaluateGuestReplySendRouteWithPause');
} else fail('A4', 'send evaluator delegation missing');

if (!handler.includes('sendLunaWhatsAppMessage') && !handler.includes('graph.facebook.com')) {
  pass('A5', 'handler does not call provider directly');
} else fail('A5', 'second sender path detected');

section('B. Helper + staff_reply kind');

if (ALLOWED_SEND_KINDS.has('staff_reply')) pass('B1', 'staff_reply in ALLOWED_SEND_KINDS');
else fail('B1', 'staff_reply kind missing');

const parsed = parseInboxSendReplyInput({
  client_slug: 'wolfhouse-somo',
  conversation_id: '11111111-1111-4111-8111-111111111111',
  message_text: 'Hello guest',
});
if (parsed.ok && parsed.input.idempotency_key.startsWith('staff-reply:')) {
  pass('B2', 'generates idempotency_key when omitted');
} else fail('B2', 'idempotency_key generation failed');

const body = buildStaffInboxGuestReplyBody(parsed.input);
if (body.send_kind === STAFF_REPLY_KIND
    && body.source === STAFF_REPLY_SOURCE
    && body.send_eligibility.requires_staff === false
    && body.send_eligibility.auto_send_ready === true) {
  pass('B3', 'buildStaffInboxGuestReplyBody sets staff inbox eligibility');
} else fail('B3', 'send body shape wrong');

const key1 = buildStaffReplyIdempotencyKey('wolfhouse-somo', 'conv-1', 'same text');
const key2 = buildStaffReplyIdempotencyKey('wolfhouse-somo', 'conv-1', 'same text');
if (key1 === key2) pass('B4', 'idempotency key stable for same draft');
else fail('B4', 'idempotency key unstable');

section('C. Idempotency + blocked env (mock pg)');

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
        return { rows: [dbRow(row)] };
      }
      if (norm.startsWith('update guest_message_sends') && norm.includes("status = 'blocked'")) {
        const row = [...rows.values()].find((r) => r.id === params[0]);
        if (!row) return { rows: [] };
        row.status = 'blocked';
        row.blocked_reasons = JSON.parse(params[1] || '[]');
        return { rows: [dbRow(row)] };
      }
      if (/bot_pause_states/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

(async () => {
  const sendBody = buildStaffInboxGuestReplyBody({
    client_slug: 'wolfhouse-somo',
    conversation_id: '11111111-1111-4111-8111-111111111111',
    to: '+491726422307',
    message_text: 'Staff inbox proof reply',
    idempotency_key: 'staff-reply:wolfhouse-somo:conv:test:abc',
  });

  const dryPg = createGuestMessageSendMockPg();
  const dryEnv = { WHATSAPP_DRY_RUN: 'true', LUNA_AUTO_SEND_ENABLED: 'false' };
  const blocked = await evaluateGuestReplySendRouteWithPause(sendBody, {
    pg: dryPg,
    env: dryEnv,
    sendMessage: async () => ({ success: true, whatsapp_message_id: 'should-not-run' }),
  });
  if (blocked.result.blocked_reasons.includes('whatsapp_dry_run_active')) {
    pass('C1', 'WHATSAPP_DRY_RUN returns clear blocked result');
  } else fail('C1', 'dry run block missing: ' + JSON.stringify(blocked.result.blocked_reasons));

  const pg = createGuestMessageSendMockPg();
  let providerCalls = 0;
  const liveEnv = { WHATSAPP_DRY_RUN: 'false', LUNA_AUTO_SEND_ENABLED: 'false' };
  const sendMessage = async () => {
    providerCalls += 1;
    return { success: true, whatsapp_message_id: 'wamid.staff.test.001' };
  };

  const first = await evaluateGuestReplySendRouteWithPause(sendBody, {
    pg,
    env: liveEnv,
    sendMessage,
  });
  const second = await evaluateGuestReplySendRouteWithPause(sendBody, {
    pg,
    env: liveEnv,
    sendMessage,
  });

  if (first.result.send_performed === true) pass('C2', 'first staff_reply send succeeds with mock provider');
  else fail('C2', 'first send failed: ' + JSON.stringify(first.result));

  if ((second.result.duplicate === true || second.result.idempotent_replay === true) && providerCalls === 1) {
    pass('C3', 'replay does not double-send');
  } else fail('C3', 'idempotent replay failed (providerCalls=' + providerCalls + ')');

  section('D. Safety');

  const forbidden = [
    ['api.stripe.com', /api\.stripe\.com/i],
    ['booking insert', /\bINSERT INTO bookings\b/i],
    ['payment insert', /\bINSERT INTO payments\b/i],
    ['n8n', /\/api\/v1\/workflows\/|activateWorkflow/i],
    ['meta webhook', /meta\/whatsapp\/webhook/i],
  ];
  for (const [label, re] of forbidden) {
    if (!re.test(handler + helperSrc)) pass('D.' + label, 'avoids ' + label);
    else fail('D.' + label, label + ' found in handler/helper');
  }

  section('E. npm script');

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  if (pkg.scripts && pkg.scripts['verify:staff-inbox-send-reply-route']) {
    pass('E1', 'npm script registered');
  } else fail('E1', 'npm script missing');

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error('Verifier crash:', e);
  process.exit(1);
});
