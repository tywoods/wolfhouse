/**
 * Phase 23b — Verifier for GET /staff/inbox/handoffs Meta-native handoff queue.
 *
 * Usage:
 *   npm run verify:luna-agent-phase23-handoff-queue-read
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const READ_HELPER = path.join(__dirname, 'lib', 'luna-guest-message-events-read.js');
const API = path.join(__dirname, 'staff-query-api.js');
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

console.log('\nverify-luna-agent-phase23-handoff-queue-read.js  (Phase 23b)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const {
  rowMatchesHandoffQueueCriteria,
  previewBlockedReasonsQualify,
  meaningfulSendBlockedQualify,
  formatHandoffQueueItem,
  listGuestMessageHandoffQueue,
  parseHandoffQueueQuery,
  SAFE_ENV_GATE_REASONS,
} = require('./lib/luna-guest-message-events-read');

const apiSrc = readOrEmpty(API);
const readSrc = readOrEmpty(READ_HELPER);
const handlerStart = apiSrc.indexOf('async function handleInboxHandoffs(');
const handlerEnd = handlerStart > -1
  ? apiSrc.indexOf('async function handleTestResetLunaPhone(', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? apiSrc.slice(handlerStart, handlerEnd)
  : '';

const routeIdx = apiSrc.indexOf("pathname === '/staff/inbox/handoffs'");
const routeBlock = routeIdx > -1 ? apiSrc.slice(routeIdx, routeIdx + 500) : '';

section('A. Route + handler wiring');

if (apiSrc.includes("'/staff/inbox/handoffs'")) pass('A1', 'route registered');
else fail('A1', 'route missing');

if (apiSrc.includes('handleInboxHandoffs')) pass('A2', 'handler present');
else fail('A2', 'handler missing');

if (/requireAuth\(req, res, 'viewer'\)/.test(routeBlock)) {
  pass('A3', 'route uses requireAuth viewer session');
} else fail('A3', 'staff auth wiring missing');

if (!/requireBotAuth/.test(routeBlock + handler)) pass('A4', 'route/handler avoids bot auth');
else fail('A4', 'should not use bot auth');

if (apiSrc.includes('listGuestMessageHandoffQueue')) pass('A5', 'handler uses listGuestMessageHandoffQueue');
else fail('A5', 'list helper wiring missing');

if (!handler.includes('staff_handoffs') && !handler.includes('getOpenHandoffsQuery')) {
  pass('A6', 'handler does not read staff_handoffs for v1');
} else fail('A6', 'handler should not use staff_handoffs');

if (readSrc.includes('guest_message_events')) pass('A7', 'read helper queries guest_message_events');
else fail('A7', 'guest_message_events query missing');

section('B. Queue criteria — include');

const baseRow = {
  handoff_required: false,
  next_action: null,
  normalized: {},
  send_blocked_reasons: [],
};

if (rowMatchesHandoffQueueCriteria({ ...baseRow, handoff_required: true })) {
  pass('B1', 'includes handoff_required=true');
} else fail('B1', 'handoff_required should qualify');

if (rowMatchesHandoffQueueCriteria({ ...baseRow, next_action: 'handoff_to_staff' })) {
  pass('B2', 'includes next_action handoff_to_staff');
} else fail('B2', 'handoff_to_staff should qualify');

if (rowMatchesHandoffQueueCriteria({ ...baseRow, next_action: 'unsupported' })) {
  pass('B3', 'includes next_action unsupported');
} else fail('B3', 'unsupported should qualify');

if (rowMatchesHandoffQueueCriteria({
  ...baseRow,
  normalized: { supported: false },
})) pass('B4', 'includes normalized.supported=false');
else fail('B4', 'unsupported message type should qualify');

if (rowMatchesHandoffQueueCriteria({
  ...baseRow,
  normalized: {
    booking_write_preview: {
      blocked_reasons: ['handoff:refund_request'],
    },
  },
})) pass('B5', 'includes preview refund blocked reason');
else fail('B5', 'preview refund should qualify');

if (rowMatchesHandoffQueueCriteria({
  ...baseRow,
  normalized: {
    booking_write_preview: {
      blocked_reasons: ['insufficient_beds_for_dates'],
    },
  },
})) pass('B6', 'includes preview availability blocked reason');
else fail('B6', 'availability block should qualify');

section('C. Queue criteria — exclude gate-only');

if (!rowMatchesHandoffQueueCriteria({
  ...baseRow,
  next_action: 'ask_missing_field',
  send_attempted: true,
  send_blocked_reasons: ['luna_auto_send_not_enabled'],
})) pass('C1', 'excludes env gate-only send block');
else fail('C1', 'env gate-only row should not qualify');

if (!rowMatchesHandoffQueueCriteria({
  ...baseRow,
  next_action: 'show_quote',
  send_blocked_reasons: ['whatsapp_dry_run_active', 'auto_send_not_ready'],
})) pass('C2', 'excludes multiple env-only gates');
else fail('C2', 'env-only gates should not qualify');

if (!rowMatchesHandoffQueueCriteria({
  ...baseRow,
  normalized: {
    booking_write_preview: {
      blocked_reasons: ['missing_field:check_in'],
    },
  },
})) pass('C3', 'excludes missing_field-only preview block');
else fail('C3', 'missing_field-only should not qualify');

if (SAFE_ENV_GATE_REASONS.has('luna_auto_send_not_enabled')) {
  pass('C4', 'SAFE_ENV_GATE_REASONS includes luna_auto_send_not_enabled');
} else fail('C4', 'env gate set incomplete');

section('D. Response shape');

const shaped = formatHandoffQueueItem({
  id: 'evt-1',
  client_slug: 'wolfhouse-somo',
  created_at: '2026-06-06T12:00:00.000Z',
  from_phone: '491726422307',
  profile_name: 'Guest',
  message_text: 'refund please',
  next_action: 'handoff_to_staff',
  suggested_reply: 'Our team will help you shortly.',
  handoff_required: true,
  send_attempted: false,
  send_status: null,
  send_blocked_reasons: [],
  normalized: {
    booking_write_preview: {
      eligible: false,
      action: 'create_booking_and_payment_draft',
      blocked_reasons: ['handoff:refund_request'],
      idempotency_key_preview: 'luna-booking:wolfhouse-somo:wamid.1:v1',
      booking_create_payload_preview: {
        check_in: '2026-10-06',
        check_out: '2026-10-09',
        guest_count: 2,
        package_code: 'malibu',
        payment_choice: 'deposit',
        confirm: false,
        extra_secret: 'should-not-leak',
      },
    },
    booking_write_result: {
      booking_id: '946cc3ba-70e9-4f9f-a6b8-140ca3d22a79',
      booking_code: 'MB-WOLFHO-20261006-5dbf98',
      payment_id: 'd0bb5fa9-7ecc-43b2-b0d9-181b5687ae0a',
      raw_payload: 'nope',
    },
    raw_payload: { huge: true },
  },
});

if (shaped && shaped.suggested_reply === 'Our team will help you shortly.') {
  pass('D1', 'returns suggested_reply when present');
} else fail('D1', 'suggested_reply missing');

if (shaped && shaped.queue_reason) pass('D2', 'returns queue_reason');
else fail('D2', 'queue_reason missing');

if (shaped && shaped.booking_write_result
    && shaped.booking_write_result.booking_code === 'MB-WOLFHO-20261006-5dbf98') {
  pass('D3', 'returns booking_write_result summary');
} else fail('D3', 'booking_write_result summary missing');

if (shaped && shaped.booking_write_preview
    && shaped.booking_write_preview.booking_create_payload_preview
    && !shaped.booking_write_preview.booking_create_payload_preview.extra_secret) {
  pass('D4', 'payload preview is safe summary only');
} else fail('D4', 'payload preview leaks extra fields');

if (shaped && !('raw_payload' in shaped) && !('normalized' in shaped)) {
  pass('D5', 'response omits raw_payload and normalized');
} else fail('D5', 'raw/normalized leaked in response');

section('E. Mock pg list behavior');

function createHandoffMockPg(rows) {
  return {
    query: async () => ({ rows }),
  };
}

(async () => {
  const seed = [
    {
      id: 'gate-only',
      client_slug: 'wolfhouse-somo',
      from_phone: '491726422307',
      message_text: 'dates?',
      next_action: 'ask_missing_field',
      handoff_required: false,
      send_attempted: true,
      send_status: 'blocked',
      send_blocked_reasons: ['luna_auto_send_not_enabled'],
      normalized: { supported: true },
      created_at: '2026-06-06T10:00:00.000Z',
    },
    {
      id: 'refund',
      client_slug: 'wolfhouse-somo',
      from_phone: '491726422307',
      message_text: 'refund',
      next_action: 'handoff_to_staff',
      handoff_required: true,
      suggested_reply: 'team',
      send_attempted: false,
      send_status: null,
      send_blocked_reasons: [],
      normalized: {},
      created_at: '2026-06-06T11:00:00.000Z',
    },
    {
      id: 'unsupported-img',
      client_slug: 'wolfhouse-somo',
      from_phone: '491726422307',
      message_text: null,
      next_action: null,
      handoff_required: false,
      send_attempted: false,
      send_status: null,
      send_blocked_reasons: [],
      normalized: { supported: false, message_type: 'image' },
      created_at: '2026-06-06T11:30:00.000Z',
    },
  ];

  const pg = createHandoffMockPg(seed);
  const result = await listGuestMessageHandoffQueue(pg, {
    client_slug: 'wolfhouse-somo',
    limit: 50,
  });

  if (result.items.length === 2) pass('E1', 'filters gate-only row from mock results');
  else fail('E1', `expected 2 items, got ${result.items.length}`);

  const ids = result.items.map((i) => i.id);
  if (ids.includes('refund') && ids.includes('unsupported-img')) {
    pass('E2', 'includes handoff and unsupported-type rows');
  } else fail('E2', 'expected rows missing');

  const parsed = parseHandoffQueueQuery({ client_slug: 'wolfhouse-somo', limit: 25 });
  if (parsed.ok && parsed.filters.limit === 25) pass('E3', 'parseHandoffQueueQuery works');
  else fail('E3', 'query parser failed');

  section('F. Safety — no send/write/external');

  const forbidden = [
    ['graph.facebook.com', /graph\.facebook\.com/i],
    ['api.stripe.com', /api\.stripe\.com/i],
    ['staff_handoffs insert', /insert into staff_handoffs/i],
    ['n8n activation', /\/api\/v1\/workflows\/|activateWorkflow/i],
  ];
  for (const [label, re] of forbidden) {
    if (!re.test(handler + readSrc)) pass('F.' + label, 'avoids ' + label);
    else fail('F.' + label, label + ' found');
  }

  if (!/\bINSERT\b/i.test(handler) && !/\bUPDATE\b/i.test(handler) && !/\bDELETE\b/i.test(handler)) {
    pass('F.sql', 'handler has no SQL writes');
  } else fail('F.sql', 'handler SQL writes found');

  section('G. npm script registration');

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  if (pkg.scripts && pkg.scripts['verify:luna-agent-phase23-handoff-queue-read']) {
    pass('G1', 'npm script registered');
  } else fail('G1', 'npm script missing');

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error('Verifier crash:', e);
  process.exit(1);
});
