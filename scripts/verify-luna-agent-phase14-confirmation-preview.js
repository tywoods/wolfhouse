/**
 * Phase 14b — Verifier for Luna booking confirmation preview (read-only).
 *
 * Usage:
 *   npm run verify:luna-agent-phase14-confirmation-preview
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const API    = path.join(__dirname, 'staff-query-api.js');
const HELPER = path.join(__dirname, 'lib', 'luna-booking-confirmation-preview.js');
const PKG    = path.join(ROOT, 'package.json');

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

function readOrEmpty(filePath) {
  try { return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''; }
  catch { return ''; }
}

const CONFIG_PATH         = path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.baseline.json');
const ANCHOR_BOOKING_ID   = '9073415f-1501-4bdf-b1c8-ce5879c93662';
const ANCHOR_BOOKING_CODE = 'MB-WOLFHO-20260920-b6f9c7';
const CONFIRMED_ADDRESS   = 'C. Mies de La Ran, 41, 39140 Somo, Cantabria';
const FALLBACK_ADDRESS    = 'Calle Test 1, Somo, Cantabria';
const ANCHOR_GATE         = '2684#';
const ANCHOR_ROOM         = 'DEMO-R1';

function makeConfirmationDraft(overrides) {
  return Object.assign({
    booking_code:       ANCHOR_BOOKING_CODE,
    guest_name:         'Preview Guest',
    payment_status:     'deposit_paid',
    amount_paid_cents:  10000,
    balance_due_cents:  17000,
    room_number:        ANCHOR_ROOM,
    address:            FALLBACK_ADDRESS,
    gate_code:          ANCHOR_GATE,
    sends_whatsapp:     false,
    whatsapp_dry_run:   true,
  }, overrides || {});
}

function makeBookingRow(overrides) {
  const draft = overrides && overrides.confirmation_draft !== undefined
    ? overrides.confirmation_draft
    : makeConfirmationDraft();
  const metadata = draft === null ? {} : { confirmation_draft: draft };
  return {
    booking_id:           ANCHOR_BOOKING_ID,
    booking_code:         ANCHOR_BOOKING_CODE,
    payment_status:       'deposit_paid',
    confirmation_sent_at: null,
    primary_room_code:    ANCHOR_ROOM,
    metadata,
    ...(overrides || {}),
  };
}

function makeMockPg(bookingRow, roomCodes) {
  const row = bookingRow;
  const rooms = roomCodes || [ANCHOR_ROOM];
  return {
    query: async (sql, params) => {
      const s = String(sql);
      if (/FROM\s+bookings\s+b/i.test(s) && /clients\s+c/i.test(s)) {
        if (!row) return { rows: [] };
        return { rows: [row] };
      }
      if (/FROM\s+booking_beds/i.test(s)) {
        return { rows: rooms.map((rc) => ({ room_code: rc })) };
      }
      return { rows: [] };
    },
  };
}

console.log('\nverify-luna-agent-phase14-confirmation-preview.js  (Phase 14b)\n');

const helperSrc = readOrEmpty(HELPER);
const apiSrc    = readOrEmpty(API);

const routeIdx   = apiSrc.indexOf("'/staff/bot/bookings/confirmation-preview'");
const routeBlock = routeIdx > -1 ? apiSrc.slice(routeIdx, routeIdx + 700) : '';

const handlerStart = apiSrc.indexOf('async function handleBotBookingConfirmationPreview(');
const handlerEnd   = handlerStart > -1
  ? apiSrc.indexOf('\n// Phase 13c', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? apiSrc.slice(handlerStart, handlerEnd)
  : '';

// ─────────────────────────────────────────────────────────────────────────────
section('A. Helper presence and export');

if (fs.existsSync(HELPER)) pass('A1', 'luna-booking-confirmation-preview.js exists');
else fail('A1', 'helper file missing');

if (/function\s+getLunaBookingConfirmationPreview\s*\(/.test(helperSrc)
  || /async\s+function\s+getLunaBookingConfirmationPreview\s*\(/.test(helperSrc)) {
  pass('A2', 'getLunaBookingConfirmationPreview exported');
} else {
  fail('A2', 'getLunaBookingConfirmationPreview missing');
}

if (/module\.exports\s*=\s*\{[^}]*getLunaBookingConfirmationPreview/.test(helperSrc)) {
  pass('A3', 'helper module.exports includes getLunaBookingConfirmationPreview');
} else {
  fail('A3', 'helper export block missing getLunaBookingConfirmationPreview');
}

if (/loadClientConfirmationConfig/.test(helperSrc)
  && /resolveConfirmationAddress/.test(helperSrc)) {
  pass('A4', 'helper loads client config for address fallback');
} else {
  fail('A4', 'config address fallback helpers missing');
}

if (/confirmation_address_missing/.test(helperSrc)) {
  pass('A5', 'helper blocks when include_address true and address unavailable');
} else {
  fail('A5', 'confirmation_address_missing block missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('A0. Wolfhouse config address anchor (no invented address)');

if (fs.existsSync(CONFIG_PATH)) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const stored = cfg.confirmation?.address || cfg.property?.address || null;
  const placeholder = !stored || /<FILL>|TODO|TBD/i.test(String(stored));
  if (stored === CONFIRMED_ADDRESS && !placeholder) {
    pass('A0', 'wolfhouse config has confirmed confirmation.address');
  } else if (stored && !placeholder) {
    pass('A0', `wolfhouse config has stored address (${stored})`);
  } else {
    fail('A0', 'wolfhouse confirmation address missing or placeholder');
  }
} else {
  fail('A0', 'wolfhouse-somo.baseline.json missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Route and handler presence');

if (routeIdx > -1) pass('B1', 'POST /staff/bot/bookings/confirmation-preview registered');
else fail('B1', 'route not registered');

if (routeBlock.includes("method !== 'POST'")) pass('B2', 'POST-only guard');
else fail('B2', 'POST-only guard missing');

if (routeBlock.includes('requireBotAuth')) pass('B3', 'route uses requireBotAuth');
else fail('B3', 'requireBotAuth missing on route');

if (handlerStart > -1) pass('B4', 'handleBotBookingConfirmationPreview defined');
else fail('B4', 'handler missing');

if (routeBlock.includes('handleBotBookingConfirmationPreview')) pass('B5', 'router dispatches handler');
else fail('B5', 'router does not call handler');

if (handler.includes('getLunaBookingConfirmationPreview')) pass('B6', 'handler calls preview helper');
else fail('B6', 'handler does not call preview helper');

if (handler.includes('withPgClient')) pass('B7', 'handler uses withPgClient (structured booking read)');
else fail('B7', 'withPgClient missing in handler');

// ─────────────────────────────────────────────────────────────────────────────
section('C. Read-only safety — no writes / send / external calls');

const combinedSrc = helperSrc + handler;

if (!/\bINSERT\b/i.test(combinedSrc)) pass('C1', 'no INSERT SQL in helper/handler');
else fail('C1', 'INSERT SQL found');

if (!/\bUPDATE\b/i.test(combinedSrc)) pass('C2', 'no UPDATE SQL in helper/handler');
else fail('C2', 'UPDATE SQL found');

if (!/\bDELETE\b/i.test(combinedSrc)) pass('C3', 'no DELETE SQL in helper/handler');
else fail('C3', 'DELETE SQL found');

if (!/(sendWhatsApp|whatsapp\.send|fetch\([^)]*whatsapp)/i.test(combinedSrc)) {
  pass('C4', 'no WhatsApp send calls in helper/handler');
} else {
  fail('C4', 'WhatsApp send call detected');
}

if (!/(fetchN8n|n8n\.io|triggerN8n)/i.test(combinedSrc)) {
  pass('C5', 'no n8n calls in helper/handler');
} else {
  fail('C5', 'n8n call detected');
}

if (!/(require\(['"]stripe['"]\)|new\s+Stripe\(|createStripe|STRIPE_SECRET_KEY|stripe\.checkout)/i.test(combinedSrc)) {
  pass('C6', 'no Stripe calls in helper/handler');
} else {
  fail('C6', 'Stripe call detected');
}

if (!/confirmation_sent_at\s*=/.test(combinedSrc)) pass('C7', 'does not update confirmation_sent_at');
else fail('C7', 'confirmation_sent_at write detected');

if (!/getBookingConversationQuery|conversation_messages|chat_logs/i.test(combinedSrc)) {
  pass('C8', 'reads structured booking data only (no chat logs)');
} else {
  fail('C8', 'chat log query detected');
}

// ─────────────────────────────────────────────────────────────────────────────
section('D. Runtime preview behavior (mock pg)');

const { getLunaBookingConfirmationPreview } = require('./lib/luna-booking-confirmation-preview');

(async () => {
  const bedLeakRe   = /(?:DEMO-R\d+-B\d+|\bB[1-9]\b)/i;
  const bedNumberRe = /\bbed\s*(?:number|#|no\.?)?\s*:?\s*\d/i;

  const paidRow = makeBookingRow();
  const paidPreview = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_code: ANCHOR_BOOKING_CODE },
    { pg: makeMockPg(paidRow) }
  );

  if (paidPreview.success === true) pass('D1', 'deposit_paid booking with draft succeeds');
  else fail('D1', `expected success, got ${JSON.stringify(paidPreview)}`);

  if (paidPreview.preview_only === true) pass('D2', 'preview_only: true');
  else fail('D2', 'preview_only not true');

  if (paidPreview.no_write_performed === true) pass('D3', 'no_write_performed: true');
  else fail('D3', 'no_write_performed not true');

  if (paidPreview.sends_whatsapp === false) pass('D4', 'sends_whatsapp: false');
  else fail('D4', 'sends_whatsapp not false');

  if (paidPreview.calls_n8n === false) pass('D5', 'calls_n8n: false');
  else fail('D5', 'calls_n8n not false');

  if (paidPreview.updates_confirmation_sent_at === false) pass('D6', 'updates_confirmation_sent_at: false');
  else fail('D6', 'updates_confirmation_sent_at not false');

  if (paidPreview.send_ready === false) pass('D7', 'send_ready remains false');
  else fail('D7', 'send_ready should be false in 14b');

  if (paidPreview.confirmation_sent_at === null) pass('D8', 'confirmation_sent_at null preserved');
  else fail('D8', 'confirmation_sent_at should be null in mock');

  const msg = String(paidPreview.message_preview || '');
  if (/Address:/i.test(msg) && msg.includes(FALLBACK_ADDRESS)) {
    pass('D9', 'message_preview includes Address line (draft address)');
  } else {
    fail('D9', 'address missing from message_preview');
  }

  const nullDraftRow = makeBookingRow({
    confirmation_draft: makeConfirmationDraft({ address: null }),
  });
  const fallbackPreview = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_code: ANCHOR_BOOKING_CODE },
    {
      pg: makeMockPg(nullDraftRow),
      loadClientConfirmationConfig: () => ({
        include_address: true,
        address: FALLBACK_ADDRESS,
        gate_code: ANCHOR_GATE,
      }),
    },
  );
  const fallbackMsg = String(fallbackPreview.message_preview || '');
  if (fallbackPreview.success === true && fallbackPreview.address_source === 'client_config') {
    pass('D18', 'falls back to config address when draft.address is null');
  } else {
    fail('D18', `config fallback failed: ${JSON.stringify(fallbackPreview)}`);
  }
  if (/Address:/i.test(fallbackMsg) && fallbackMsg.includes(FALLBACK_ADDRESS)) {
    pass('D19', 'fallback message_preview includes Address line');
  } else {
    fail('D19', 'fallback Address line missing');
  }

  const missingAddrPreview = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_code: ANCHOR_BOOKING_CODE },
    {
      pg: makeMockPg(nullDraftRow),
      loadClientConfirmationConfig: () => ({
        include_address: true,
        address: null,
        gate_code: ANCHOR_GATE,
      }),
    },
  );
  if (missingAddrPreview.success === false
    && (missingAddrPreview.blocked_reasons || []).includes('confirmation_address_missing')) {
    pass('D20', 'blocks when include_address true and no address anywhere');
  } else {
    fail('D20', 'missing address not blocked safely');
  }

  const stagingLikePreview = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_code: ANCHOR_BOOKING_CODE },
    { pg: makeMockPg(nullDraftRow) },
  );
  const cfg = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    : {};
  const cfgHasAddress = !!(cfg.confirmation?.address || cfg.property?.address);
  if (!cfgHasAddress && cfg.confirmation?.include_address === true) {
    if (stagingLikePreview.success === false
      && (stagingLikePreview.blocked_reasons || []).includes('confirmation_address_missing')) {
      pass('D21', 'real wolfhouse config (no address) blocks null-draft preview safely');
    } else {
      fail('D21', 'expected confirmation_address_missing for staging-like null draft');
    }
  } else if (cfgHasAddress) {
    const stagingMsg = String(stagingLikePreview.message_preview || '');
    if (stagingLikePreview.success === true
      && stagingLikePreview.address_source === 'client_config'
      && /Address:/i.test(stagingMsg)
      && stagingMsg.includes(CONFIRMED_ADDRESS)) {
      pass('D21', 'real wolfhouse config address enables null-draft preview');
    } else {
      fail('D21', `config address present but preview failed: ${JSON.stringify(stagingLikePreview)}`);
    }
  } else {
    pass('D21', 'include_address not true — block path not required');
  }

  if (msg.includes(ANCHOR_GATE)) pass('D10', 'message_preview includes gate code 2684#');
  else fail('D10', 'gate code missing from message_preview');

  if (msg.includes(ANCHOR_ROOM)) pass('D11', 'message_preview includes room number');
  else fail('D11', 'room number missing from message_preview');

  if (!bedLeakRe.test(msg) && !bedNumberRe.test(msg)) {
    pass('D12', 'message_preview excludes bed number / bed code');
  } else {
    fail('D12', `bed leak in message_preview: ${msg}`);
  }

  const unpaidPreview = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_id: ANCHOR_BOOKING_ID },
    { pg: makeMockPg(makeBookingRow({ payment_status: 'pending' })) }
  );
  if (unpaidPreview.success === false
    && (unpaidPreview.blocked_reasons || []).includes('payment_not_paid')) {
    pass('D13', 'blocks unpaid booking');
  } else {
    fail('D13', 'unpaid booking not blocked');
  }

  const noDraftPreview = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_code: ANCHOR_BOOKING_CODE },
    { pg: makeMockPg(makeBookingRow({ metadata: {} })) }
  );
  if (noDraftPreview.success === false
    && (noDraftPreview.blocked_reasons || []).includes('confirmation_draft_missing')) {
    pass('D14', 'blocks missing confirmation_draft');
  } else {
    fail('D14', 'missing confirmation_draft not blocked');
  }

  const paidFullPreview = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_id: ANCHOR_BOOKING_ID },
    { pg: makeMockPg(makeBookingRow({ payment_status: 'paid' })) }
  );
  if (paidFullPreview.success === true) pass('D15', 'allows paid booking');
  else fail('D15', 'paid booking should be allowed');

  const multiRoomPreview = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_code: ANCHOR_BOOKING_CODE },
    { pg: makeMockPg(paidRow, ['DEMO-R1', 'DEMO-R2']) }
  );
  const multiMsg = String(multiRoomPreview.message_preview || '');
  if (multiMsg.includes('DEMO-R1') && multiMsg.includes('DEMO-R2') && !bedLeakRe.test(multiMsg)) {
    pass('D16', 'multiple rooms: room-level only, no bed codes');
  } else {
    fail('D16', 'multi-room preview unsafe or incomplete');
  }

  const notFoundPreview = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_code: 'MB-NOTFOUND' },
    { pg: makeMockPg(null) }
  );
  if (notFoundPreview.success === false
    && (notFoundPreview.blocked_reasons || []).includes('booking_not_found')) {
    pass('D17', 'blocks missing booking');
  } else {
    fail('D17', 'missing booking not blocked');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  section('E. npm script registration');

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  if (pkg.scripts
    && pkg.scripts['verify:luna-agent-phase14-confirmation-preview']
      === 'node scripts/verify-luna-agent-phase14-confirmation-preview.js') {
    pass('E1', 'verify:luna-agent-phase14-confirmation-preview registered');
  } else {
    fail('E1', 'npm script missing or wrong path');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  section('F. Downstream closeout verifiers');

  const downstream = [
    'verify:luna-agent-phase14-confirmation-gates-plan',
    'verify:luna-agent-phase13-closeout',
    'verify:luna-agent-phase12-closeout',
    'verify:staff-ask-luna-phase11-closeout',
  ];

  for (const script of downstream) {
    try {
      execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
      pass('F-' + script, `${script} passed`);
    } catch (err) {
      const out = (err.stdout || '') + (err.stderr || '');
      fail('F-' + script, `${script} failed:\n${out.slice(-800)}`);
    }
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
