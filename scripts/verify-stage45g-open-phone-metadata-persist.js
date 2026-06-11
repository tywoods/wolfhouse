/**
 * Stage 45g — Persist open-phone-testing metadata on inbox/conversation/message records.
 *
 * Usage:
 *   npm run verify:stage45g-open-phone-metadata-persist
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REVIEW = path.join(__dirname, 'lib', 'luna-guest-inbound-review-dry-run.js');
const THREAD = path.join(__dirname, 'lib', 'luna-staff-inbox-thread-message.js');
const EXECUTE = path.join(__dirname, 'lib', 'open-demo-whatsapp-inbound-execute.js');
const QUERIES = path.join(__dirname, 'lib', 'staff-conversation-queries.js');
const OPEN_DEMO = path.join(__dirname, 'lib', 'open-demo-whatsapp-gate.js');
const PKG = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage45g-open-phone-metadata-persist';

const {
  extractOpenPhoneTestingMetadata,
  mergeOpenPhoneTestingIntoMetadata,
  persistInboundReviewArtifact,
} = require('./lib/luna-guest-inbound-review-dry-run');
const { validateOpenDemoInboundBody } = require('./lib/open-demo-whatsapp-gate');
const { evaluateOpenPhoneTestingStaffRoutingBypass, evaluateGuestInboundPhoneGate } = require('./lib/luna-open-phone-testing-gate');
const { persistOpenDemoInboundThreadMessage } = require('./lib/luna-staff-inbox-thread-message');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage45g-open-phone-metadata-persist.js  (Stage 45g)\n');

section('A. Syntax + package');
for (const f of [REVIEW, THREAD, EXECUTE, QUERIES, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('A0', `${path.basename(f)} passes node --check`);
  } catch {
    fail('A0', `${path.basename(f)} syntax error`);
  }
}
const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
check('A1', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

const reviewSrc = fs.readFileSync(REVIEW, 'utf8');
const threadSrc = fs.readFileSync(THREAD, 'utf8');
const executeSrc = fs.readFileSync(EXECUTE, 'utf8');
const queriesSrc = fs.readFileSync(QUERIES, 'utf8');

section('B. Wiring');
check('B1', reviewSrc.includes('extractOpenPhoneTestingMetadata')
  && reviewSrc.includes('mergeOpenPhoneTestingIntoMetadata'),
  'review dry-run exports open-phone metadata helpers');
check('B2', reviewSrc.includes('open_phone_testing') && reviewSrc.includes('guest_tester_class')
  && reviewSrc.includes('persistInboundReviewArtifact'),
  'conversation metadata persistence wired');
check('B3', threadSrc.includes('guest_tester_class') && threadSrc.includes('open_phone_testing'),
  'thread message metadata wired');
check('B4', executeSrc.includes('guest_tester_class') && executeSrc.includes('open_phone_testing'),
  'open-demo execute passes tester metadata to thread persist');
check('B5', queriesSrc.includes("metadata->>'guest_tester_class'")
  && queriesSrc.includes("metadata->>'open_phone_testing'"),
  'Staff Portal inbox/messages queries expose tester fields');

section('C. Metadata extraction');
const external = extractOpenPhoneTestingMetadata({
  open_phone_testing: true,
  guest_tester_class: 'external_open_testing',
});
check('C1', external && external.open_phone_testing === true
  && external.guest_tester_class === 'external_open_testing',
  'external_open_testing extracted');

const staff = extractOpenPhoneTestingMetadata({
  open_phone_testing: true,
  guest_tester_class: 'staff_open_testing',
});
check('C2', staff && staff.guest_tester_class === 'staff_open_testing',
  'staff_open_testing extracted');

check('C3', extractOpenPhoneTestingMetadata({ open_phone_testing: false }) === null,
  'off mode does not mark open testing');
check('C4', extractOpenPhoneTestingMetadata(null) === null,
  'missing gate context does not mark open testing');

const merged = mergeOpenPhoneTestingIntoMetadata({ source: 'test' }, {
  open_phone_testing: true,
  guest_tester_class: 'external_open_testing',
});
check('C5', merged.open_phone_testing === true && merged.guest_tester_class === 'external_open_testing',
  'merge helper copies fields into metadata blob');

section('D. Gate → automation_gate_context');
const openEnv = {
  NODE_ENV: 'staging',
  LUNA_OPEN_PHONE_TESTING: 'true',
  LUNA_OPEN_PHONE_TESTING_BYPASS_STAFF_ROUTING: 'true',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
};
const offEnv = {
  NODE_ENV: 'staging',
  LUNA_OPEN_PHONE_TESTING: 'false',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
};
const extBody = validateOpenDemoInboundBody({
  client_slug: 'wolfhouse-somo',
  channel: 'whatsapp',
  guest_phone: '+34600995555',
  message_text: 'hello',
  inbound_message_id: 'wamid.stage45g-ext',
}, openEnv);
check('D1', extBody.ok === true
  && extBody.normalized.automation_gate_context.open_phone_testing === true
  && extBody.normalized.automation_gate_context.guest_tester_class === 'external_open_testing',
  'unknown external phone gets external_open_testing in automation_gate_context');

const staffBypass = evaluateOpenPhoneTestingStaffRoutingBypass(openEnv, {
  client_slug: 'wolfhouse-somo',
  phone: '+491726422307',
}, { found: true, active: true });
check('D2', staffBypass.staff_routing_bypassed === true
  && staffBypass.guest_tester_class === 'staff_open_testing',
  'active staff bypass resolves staff_open_testing');

const blockedGate = evaluateGuestInboundPhoneGate({
  client_slug: 'wolfhouse-somo',
  guest_phone: '+34600995555',
}, offEnv);
check('D3', blockedGate.ok === false && blockedGate.guest_tester_class === 'unverified_blocked',
  'open phone off blocks unknown external phone at gate');

section('E. Persist conversation metadata (mock PG)');
(async () => {
  let savedMeta = null;
  const pg = {
    query: async (sql, params) => {
      const s = String(sql);
      if (s.includes('UPDATE conversations') && s.includes('metadata')) {
        savedMeta = JSON.parse(params[1]);
        return { rows: [{ conversation_id: 'conv-45g' }] };
      }
      if (s.includes('FROM conversations') && s.includes('client_id')) {
        return { rows: [{ conversation_id: 'conv-45g', metadata: {}, staff_reply_draft: null }] };
      }
      return { rows: [] };
    },
  };

  await persistInboundReviewArtifact(pg, {
    clientId: 'client-1',
    normalized: {
      guest_phone: '+34600995555',
      channel: 'whatsapp',
      message_text: 'Stage 45g metadata test',
      inbound_message_id: 'wamid.stage45g-persist',
      idempotency_key: 'wolfhouse-somo:whatsapp:wamid.stage45g-persist',
      received_at: '2026-06-11T12:00:00.000Z',
    },
    convRow: { conversation_id: 'conv-45g', metadata: {} },
    review: { proposed_luna_reply: 'Hi', proposed_next_action: 'none' },
    slimGuestContext: {},
    automationGateContext: {
      open_phone_testing: true,
      guest_tester_class: 'external_open_testing',
    },
  });

  check('E1', savedMeta && savedMeta.open_phone_testing === true
    && savedMeta.guest_tester_class === 'external_open_testing',
    'persistInboundReviewArtifact stores tester metadata on conversation');

  const messages = [];
  const pgThread = {
    query: async (sql, params) => {
      const s = String(sql);
      if (s.includes('FROM messages m') && s.includes('INNER JOIN conversations')) {
        return { rows: [] };
      }
      if (s.includes('FROM conversations conv') && s.includes('INNER JOIN clients')) {
        return { rows: [{ id: 'conv-1', client_id: 'client-1' }] };
      }
      if (s.startsWith('INSERT INTO messages')) {
        const meta = JSON.parse(params[params.length - 1]);
        messages.push(meta);
        return {
          rows: [{
            message_id: 'msg-1',
            whatsapp_message_id: params[4],
            source: params[3],
            direction: 'inbound',
          }],
        };
      }
      return { rows: [] };
    },
  };

  await persistOpenDemoInboundThreadMessage(pgThread, {
    client_slug: 'wolfhouse-somo',
    conversation_id: 'conv-1',
    message_text: 'hello tester',
    whatsapp_message_id: 'wamid.stage45g-thread',
    open_phone_testing: true,
    guest_tester_class: 'staff_open_testing',
  });
  check('E2', messages[0]
    && messages[0].open_phone_testing === true
    && messages[0].guest_tester_class === 'staff_open_testing',
    'persistOpenDemoInboundThreadMessage stores tester metadata on message');

  section('F. Safety unchanged');
  check('F1', !executeSrc.includes('send_live_reply_confirmed: true')
    || executeSrc.includes('wantsSendLiveReplyConfirmed'),
    'live reply still opt-in only');
  check('F2', !threadSrc.includes('graph.facebook.com') && !threadSrc.includes('api.stripe.com'),
    'thread persist does not call WhatsApp or Stripe');
  check('F3', !reviewSrc.includes('INSERT INTO bookings') && !reviewSrc.includes('INSERT INTO payments'),
    'review persist does not write bookings/payments');

  console.log(`\n── Summary ──\n\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
