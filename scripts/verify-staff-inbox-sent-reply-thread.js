/**
 * Phase 23e — Verifier for staff Inbox sent reply thread persistence.
 *
 * Usage:
 *   npm run verify:staff-inbox-sent-reply-thread
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const HELPER = path.join(__dirname, 'lib', 'luna-staff-inbox-thread-message.js');
const PKG = path.join(ROOT, 'package.json');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-staff-inbox-sent-reply-thread.js  (Phase 23e)\n');

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'staff-query-api.js passes node --check');
} catch {
  fail('0', 'staff-query-api.js syntax error');
}

const apiSrc = fs.readFileSync(API, 'utf8');
const helperSrc = fs.readFileSync(HELPER, 'utf8');

const {
  shouldPersistStaffInboxThreadMessage,
  persistStaffInboxSentThreadMessage,
  findStaffInboxThreadMessage,
} = require('./lib/luna-staff-inbox-thread-message');

section('A. Handler wiring');

if (apiSrc.includes('persistStaffInboxSentThreadMessage')) pass('A1', 'send handler persists thread message');
else fail('A1', 'thread persist missing in handler');

if (apiSrc.includes('thread_message')) pass('A2', 'response includes thread_message summary');
else fail('A2', 'thread_message response missing');

if (helperSrc.includes('INSERT INTO messages') && helperSrc.includes('staff_inbox_reply')) {
  pass('A3', 'helper inserts outbound staff_inbox_reply message');
} else fail('A3', 'messages insert missing');

section('B. shouldPersist rules');

if (shouldPersistStaffInboxThreadMessage({ send_performed: true, success: true })) {
  pass('B1', 'persists after send_performed true');
} else fail('B1', 'send_performed should persist');

if (!shouldPersistStaffInboxThreadMessage({
  send_performed: false,
  guest_message_send_status: 'blocked',
  blocked_reasons: ['whatsapp_dry_run_active'],
})) pass('B2', 'blocked dry-run does not persist');
else fail('B2', 'blocked should not persist');

if (shouldPersistStaffInboxThreadMessage({
  idempotent_replay: true,
  success: true,
  whatsapp_message_id: 'wamid.test',
  guest_message_send_status: 'sent',
})) pass('B3', 'idempotent sent replay persists/exposes thread');
else fail('B3', 'idempotent replay rule failed');

section('C. Mock pg persist behavior');

(async () => {
  const CLIENT_SLUG = 'wolfhouse-somo';
  const CONV_ID = '11111111-1111-4111-8111-111111111111';
  const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
  const messages = [];

  const pg = {
    query: async (sql, params) => {
      const s = String(sql);
      if (s.includes('FROM messages m') && s.includes('INNER JOIN conversations')) {
        const wa = params[2];
        const gms = params[3];
        const idem = params[4];
        const found = messages.find((m) => {
          if (wa && m.whatsapp_message_id === wa) return true;
          if (gms && m.metadata && m.metadata.guest_message_send_id === gms) return true;
          if (idem && m.metadata && m.metadata.idempotency_key === idem) return true;
          return false;
        });
        return { rows: found ? [found] : [] };
      }
      if (s.includes('FROM conversations conv') && s.includes('WHERE c.slug')) {
        if (params[1] === CONV_ID) {
          return { rows: [{ id: CONV_ID, client_id: CLIENT_ID }] };
        }
        return { rows: [] };
      }
      if (s.startsWith('INSERT INTO messages')) {
        const meta = typeof params[4] === 'string' ? JSON.parse(params[4]) : (params[4] || {});
        const row = {
          message_id: `msg-${messages.length + 1}`,
          id: `msg-${messages.length + 1}`,
          client_id: params[0],
          conversation_id: params[1],
          direction: 'outbound',
          message_text: params[2],
          whatsapp_message_id: params[3] || null,
          source: 'staff_inbox_reply',
          metadata: meta,
        };
        messages.push(row);
        return { rows: [row] };
      }
      return { rows: [] };
    },
  };

  const input = {
    client_slug: CLIENT_SLUG,
    conversation_id: CONV_ID,
    message_text: 'Hello from staff',
    idempotency_key: 'staff-reply:test:1',
  };

  const sentResult = {
    send_performed: true,
    success: true,
    whatsapp_message_id: 'wamid.staff.thread.001',
    guest_message_send_id: 'gms-1',
    idempotency_key: input.idempotency_key,
    guest_message_send_status: 'sent',
  };

  const first = await persistStaffInboxSentThreadMessage(pg, input, sentResult);
  if (first.persisted === true && first.message_id) {
    pass('C1', 'successful send creates one outbound thread message');
  } else fail('C1', 'first persist failed: ' + JSON.stringify(first));

  if (messages[0] && messages[0].metadata && messages[0].metadata.guest_message_send_id === 'gms-1') {
    pass('C2', 'guest_message_send_id preserved in metadata');
  } else fail('C2', 'metadata missing guest_message_send_id');

  const replay = await persistStaffInboxSentThreadMessage(pg, input, {
    ...sentResult,
    send_performed: false,
    idempotent_replay: true,
    duplicate: true,
  });
  if (replay.duplicate === true && messages.length === 1) {
    pass('C3', 'idempotent replay does not duplicate thread message');
  } else fail('C3', `expected 1 message, got ${messages.length}`);

  const blocked = await persistStaffInboxSentThreadMessage(pg, input, {
    send_performed: false,
    success: false,
    guest_message_send_status: 'blocked',
    blocked_reasons: ['whatsapp_dry_run_active'],
  });
  if (blocked.persisted === false && messages.length === 1) {
    pass('C4', 'blocked send does not add thread message');
  } else fail('C4', 'blocked persist should skip');

  section('D. UI thread reload');

  const inboxJs = apiSrc.match(/function performInboxSend\([\s\S]*?function wireInboxSendReply\([\s\S]*?function loadConvDetail\(/);
  const js = inboxJs ? inboxJs[0] : '';
  if (js.includes('loadConvDetail(convId, targetEl)')) pass('D1', 'UI reloads conversation after send');
  else fail('D1', 'loadConvDetail reload missing');

  if (/staff_inbox_reply.*Staff/.test(apiSrc)) pass('D2', 'thread renders Staff label for staff_inbox_reply');
  else fail('D2', 'Staff sender label missing');

  section('E. Safety');

  const forbidden = [
    ['graph.facebook.com', /graph\.facebook\.com/i],
    ['api.stripe.com', /api\.stripe\.com/i],
    ['staff_handoffs', /\bINSERT INTO staff_handoffs\b/i],
    ['n8n', /\/api\/v1\/workflows\//i],
  ];
  for (const [label, re] of forbidden) {
    if (!re.test(helperSrc + apiSrc.match(/async function handleInboxSendReply[\s\S]*?async function handleTestResetLunaPhone/)?.[0] || '')) {
      pass('E.' + label, 'avoids ' + label);
    } else fail('E.' + label, label + ' found');
  }

  section('F. npm script');

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  if (pkg.scripts && pkg.scripts['verify:staff-inbox-sent-reply-thread']) {
    pass('F1', 'npm script registered');
  } else fail('F1', 'npm script missing');

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error('Verifier crash:', e);
  process.exit(1);
});
