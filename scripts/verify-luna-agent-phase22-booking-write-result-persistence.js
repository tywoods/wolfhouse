/**
 * Phase 22d — Verifier for inbound booking write result persistence.
 *
 * Usage:
 *   npm run verify:luna-agent-phase22-booking-write-result-persistence
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HELPER = path.join(__dirname, 'lib', 'luna-inbound-booking-write-result.js');
const API = path.join(__dirname, 'staff-query-api.js');
const PKG = path.join(ROOT, 'package.json');

const DOWNSTREAM = [
  'verify:luna-agent-phase22-inbound-booking-write-preview',
  'verify:luna-agent-phase13-booking-write-bridge',
  'verify:staff-bot-booking-create-api',
];

const CLIENT = 'wolfhouse-somo';
const WA_ID = 'wamid.phase22d.persist.001';
const IDEM = `luna-booking:${CLIENT}:${WA_ID}:v1`;
const BOOKING_ID = '946cc3ba-70e9-4f9f-a6b8-140ca3d22a79';
const BOOKING_CODE = 'MB-WOLFHO-20261006-5dbf98';
const PAYMENT_ID = 'd0bb5fa9-7ecc-43b2-b0d9-181b5687ae0a';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch { return ''; }
}

function makeEventMockPg(seedNormalized) {
  const rows = new Map();
  const keyOf = (slug, wa) => `${slug}\0${wa}`;
  rows.set(keyOf(CLIENT, WA_ID), {
    id: 'evt-phase22d-001',
    client_slug: CLIENT,
    wa_message_id: WA_ID,
    normalized: JSON.parse(JSON.stringify(seedNormalized)),
  });

  let updates = 0;
  return {
    rows,
    get updates() { return updates; },
    query: async (sql, params = []) => {
      const norm = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      if (/insert into bookings/i.test(norm)) throw new Error('booking_insert_forbidden');
      if (/insert into payments/i.test(norm)) throw new Error('payment_insert_forbidden');
      if (/graph\.facebook\.com|api\.stripe\.com/i.test(norm)) throw new Error('external_api_forbidden');

      if (norm.includes('update guest_message_events') && norm.includes('||')) {
        const slug = params[0];
        const wa = params[1];
        const row = rows.get(keyOf(slug, wa));
        if (!row) return { rows: [] };
        const merge = JSON.parse(params[2]);
        row.normalized = Object.assign({}, row.normalized || {}, merge);
        updates += 1;
        return { rows: [{ wa_message_id: row.wa_message_id, normalized: row.normalized }] };
      }
      return { rows: [] };
    },
  };
}

console.log('\nverify-luna-agent-phase22-booking-write-result-persistence.js  (Phase 22d)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const helperSrc = readOrEmpty(HELPER);
const apiSrc = readOrEmpty(API);
const handlerStart = apiSrc.indexOf('async function handleBotBookingCreateFromPlan(');
const handlerEnd = handlerStart > -1
  ? apiSrc.indexOf('\n// ─────────────────────────────────────────────────────────────────────────────\n// Route: GET/POST /staff/meta/whatsapp/webhook', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? apiSrc.slice(handlerStart, handlerEnd)
  : '';

const {
  persistInboundBookingWriteResult,
  resolveInboundEventRef,
  buildBookingWriteResult,
  parseLunaBookingIdempotencyKey,
  RESULT_SOURCE,
} = require('./lib/luna-inbound-booking-write-result');

section('A. Module + handler wiring');

if (fs.existsSync(HELPER)) pass('A1', 'luna-inbound-booking-write-result.js exists');
else fail('A1', 'helper missing');

if (apiSrc.includes('luna-inbound-booking-write-result')) pass('A2', 'staff-query-api imports helper');
else fail('A2', 'import missing');

if (apiSrc.includes('persistInboundBookingWriteResult')) {
  pass('A3', 'handleBotBookingCreateFromPlan calls persist helper');
} else fail('A3', 'persist not wired in create-from-plan handler');

if (!handler.includes('handleMetaWhatsAppWebhookPost')) {
  pass('A4', 'Meta webhook handler unchanged');
} else fail('A4', 'unexpected Meta webhook change in create handler slice');

section('B. Static safety');

const forbidden = [
  ['B.stripe', /api\.stripe\.com/i, 'Stripe API'],
  ['B.graph', /graph\.facebook\.com/i, 'Graph API'],
  ['B.n8n', /\/api\/v1\/workflows\/|activateWorkflow/i, 'n8n'],
  ['B.booking', /handleBotBookingCreate\s*\(/, 'direct booking create in helper'],
];

for (const [id, re, label] of forbidden) {
  if (!re.test(helperSrc)) pass(id, `helper avoids ${label}`);
  else fail(id, `${label} in helper`);
}

if (!/INSERT INTO bookings/i.test(helperSrc) && !/INSERT INTO payments/i.test(helperSrc)) {
  pass('B.sql', 'helper has no booking/payment INSERT');
} else fail('B.sql', 'INSERT in helper');

section('C. Event ref resolution');

if (resolveInboundEventRef({ source_wa_message_id: WA_ID, client_slug: CLIENT }).wa_message_id === WA_ID) {
  pass('C1', 'source_wa_message_id resolves');
} else fail('C1', 'source_wa_message_id');

if (resolveInboundEventRef({ wa_message_id: WA_ID }).wa_message_id === WA_ID) {
  pass('C2', 'wa_message_id resolves');
} else fail('C2', 'wa_message_id');

const parsed = parseLunaBookingIdempotencyKey(IDEM);
if (parsed && parsed.wa_message_id === WA_ID) pass('C3', 'idempotency_key parses wa_message_id');
else fail('C3', 'idempotency parse');

if (resolveInboundEventRef({ idempotency_key: IDEM }).wa_message_id === WA_ID) {
  pass('C4', 'resolve from luna-booking idempotency key');
} else fail('C4', 'idempotency resolve');

if (resolveInboundEventRef({ guest_name: 'x' }) === null) pass('C5', 'no ref without identifiers');
else fail('C5', 'should return null');

section('D. Runtime persistence (mock pg)');

(async () => {
  const preview = {
    eligible: true,
    booking_create_payload_preview: { check_in: '2026-10-06', confirm: false },
  };
  const pg = makeEventMockPg({ booking_write_preview: preview, wa_message_id: WA_ID });

  const successBridge = {
    success: true,
    write_performed: true,
    create_outcome: {
      create_response: {
        booking_id: BOOKING_ID,
        booking_code: BOOKING_CODE,
        payment_id: PAYMENT_ID,
      },
    },
  };

  const body = {
    client_slug: CLIENT,
    source_wa_message_id: WA_ID,
    idempotency_key: IDEM,
    confirm: true,
  };

  const out = await persistInboundBookingWriteResult(pg, body, successBridge);
  const row = pg.rows.get(`${CLIENT}\0${WA_ID}`);
  const result = row && row.normalized && row.normalized.booking_write_result;

  if (out.persisted === true) pass('D1', 'success write persists booking_write_result');
  else fail('D1', `persist failed: ${out.reason}`);

  if (result && result.created === true && result.booking_id === BOOKING_ID) {
    pass('D2', 'result includes booking_id');
  } else fail('D2', 'booking_id missing');

  if (result && result.booking_code === BOOKING_CODE && result.payment_id === PAYMENT_ID) {
    pass('D3', 'result includes booking_code and payment_id');
  } else fail('D3', 'code/payment missing');

  if (result && result.source === RESULT_SOURCE) pass('D4', 'result source booking_create_from_plan');
  else fail('D4', 'source wrong');

  if (result && result.creates_stripe_link === false && result.sends_whatsapp === false) {
    pass('D5', 'result safety flags false');
  } else fail('D5', 'safety flags');

  if (row.normalized.booking_write_preview && row.normalized.booking_write_preview.eligible === true) {
    pass('D6', 'booking_write_preview preserved');
  } else fail('D6', 'preview overwritten');

  const replayBridge = {
    success: true,
    write_performed: false,
    idempotent_replay: true,
    duplicate: true,
    booking_id: BOOKING_ID,
    booking_code: BOOKING_CODE,
    payment_id: PAYMENT_ID,
  };
  const replayOut = await persistInboundBookingWriteResult(pg, body, replayBridge);
  const replayResult = row.normalized.booking_write_result;
  if (replayOut.persisted === true && replayResult.idempotent_replay === true) {
    pass('D7', 'idempotent replay updates booking_write_result');
  } else fail('D7', 'replay persist');

  const pg2 = makeEventMockPg({ booking_write_preview: preview });
  const noRef = await persistInboundBookingWriteResult(pg2, { client_slug: CLIENT }, successBridge);
  if (noRef.persisted === false && pg2.updates === 0) pass('D8', 'no update without event ref');
  else fail('D8', 'should skip without ref');

  const failed = await persistInboundBookingWriteResult(pg, body, { success: false, write_performed: false });
  if (failed.persisted === false) pass('D9', 'failed create does not persist created:true');
  else fail('D9', 'failed create should not persist');

  section('E. npm script registration');

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  const scriptKey = 'verify:luna-agent-phase22-booking-write-result-persistence';
  const rel = 'scripts/verify-luna-agent-phase22-booking-write-result-persistence.js';
  if (pkg.scripts && pkg.scripts[scriptKey] === `node ${rel}`) pass('E1', `${scriptKey} registered`);
  else fail('E1', `${scriptKey} missing`);

  section('F. Downstream verifiers (limited)');

  for (const script of DOWNSTREAM) {
    try {
      execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 300000 });
      pass('F.' + script, `${script} still passes`);
    } catch (e) {
      fail('F.' + script, `${script} failed`);
      const out = (e.stdout || '') + (e.stderr || '');
      console.error(out.split('\n').slice(-8).join('\n'));
    }
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})();
