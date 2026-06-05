/**
 * Phase 14d — Aggregate closeout verifier for Luna confirmation preview/send gates.
 *
 * Proves Phase 14a–14b foundation: plan, read-only preview route/helper, address
 * fallback, Wolfhouse config, and live-send NO_GO — without implementing send.
 *
 * Usage:
 *   npm run verify:luna-agent-phase14-closeout
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT    = path.join(__dirname, '..');
const PKG     = path.join(ROOT, 'package.json');
const API     = path.join(__dirname, 'staff-query-api.js');
const DOC     = path.join(ROOT, 'docs', 'PHASE-14.1-LUNA-CONFIRMATION-SEND-GATES-PLAN.md');
const HELPER  = path.join(__dirname, 'lib', 'luna-booking-confirmation-preview.js');
const CONFIG  = path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.baseline.json');
const SENDLIB = path.join(__dirname, 'build-send-confirmation-local.js');

const PHASE14_SCRIPTS = [
  ['verify:luna-agent-phase14-confirmation-gates-plan', 'scripts/verify-luna-agent-phase14-confirmation-gates-plan.js'],
  ['verify:luna-agent-phase14-confirmation-preview', 'scripts/verify-luna-agent-phase14-confirmation-preview.js'],
  ['verify:luna-agent-phase14-closeout', 'scripts/verify-luna-agent-phase14-closeout.js'],
];

const PRIOR_CLOSEOUT_SCRIPTS = [
  ['verify:luna-agent-phase13-closeout', 'scripts/verify-luna-agent-phase13-closeout.js'],
  ['verify:luna-agent-phase12-closeout', 'scripts/verify-luna-agent-phase12-closeout.js'],
  ['verify:staff-ask-luna-phase11-closeout', 'scripts/verify-staff-ask-luna-phase11-closeout.js'],
];

const DOWNSTREAM_VERIFIERS = [
  'verify:luna-agent-phase14-confirmation-preview',
  'verify:luna-agent-phase14-confirmation-gates-plan',
  'verify:luna-agent-phase13-closeout',
  'verify:luna-agent-phase12-closeout',
  'verify:staff-ask-luna-phase11-closeout',
];

const CONFIRMED_ADDRESS = 'C. Mies de La Ran, 41, 39140 Somo, Cantabria';
const ANCHOR_GATE       = '2684#';
const ANCHOR_BOOKING_ID   = '9073415f-1501-4bdf-b1c8-ce5879c93662';
const ANCHOR_BOOKING_CODE = 'MB-WOLFHO-20260920-b6f9c7';
const ANCHOR_ROOM         = 'DEMO-R1';
const DRAFT_ADDRESS       = 'Draft Address 99, Somo';

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function hasWriteSql(src) {
  return /\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b/i.test(stripJsComments(src));
}

function sliceHandler(src, fnName) {
  const start = src.indexOf(`async function ${fnName}(`);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start, start + 10000);
}

function orderBefore(block, a, b, id, label) {
  const ia = block.indexOf(a);
  const ib = block.indexOf(b);
  if (ia >= 0 && ib >= 0 && ia < ib) pass(id, label);
  else fail(id, label);
}

function makeConfirmationDraft(overrides) {
  return Object.assign({
    booking_code:       ANCHOR_BOOKING_CODE,
    guest_name:         'Closeout Guest',
    payment_status:     'deposit_paid',
    amount_paid_cents:  10000,
    balance_due_cents:  17000,
    room_number:        ANCHOR_ROOM,
    address:            DRAFT_ADDRESS,
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
    query: async (sql) => {
      const s = String(sql);
      if (/FROM\s+bookings\s+b/i.test(s) && /clients\s+c/i.test(s)) {
        return { rows: row ? [row] : [] };
      }
      if (/FROM\s+booking_beds/i.test(s)) {
        return { rows: rooms.map((rc) => ({ room_code: rc })) };
      }
      return { rows: [] };
    },
  };
}

console.log('\nverify-luna-agent-phase14-closeout.js  (Phase 14d)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'closeout verifier passes node --check');
} catch {
  fail('0', 'closeout verifier syntax error');
}

// ─────────────────────────────────────────────────────────────────────────────
section('A. Phase 14 npm scripts + plan doc');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
for (const [scriptName, relPath] of PHASE14_SCRIPTS) {
  const full = path.join(ROOT, relPath);
  if (pkg.scripts && pkg.scripts[scriptName] === `node ${relPath}`) {
    pass('A.script.' + scriptName, `${scriptName} registered`);
  } else {
    fail('A.script.' + scriptName, `${scriptName} missing or wrong path`);
  }
  if (fs.existsSync(full)) pass('A.file.' + scriptName, `${relPath} exists`);
  else fail('A.file.' + scriptName, `${relPath} missing`);
}

for (const [scriptName, relPath] of PRIOR_CLOSEOUT_SCRIPTS) {
  const full = path.join(ROOT, relPath);
  if (pkg.scripts && pkg.scripts[scriptName]) pass('A.prior.' + scriptName, `${scriptName} registered`);
  else fail('A.prior.' + scriptName, `${scriptName} missing`);
  if (fs.existsSync(full)) pass('A.prior.file.' + scriptName, `${relPath} exists`);
  else fail('A.prior.file.' + scriptName, `${relPath} missing`);
}

if (fs.existsSync(DOC)) {
  const doc = fs.readFileSync(DOC, 'utf8');
  pass('A.plan', 'PHASE-14.1 confirmation send gates plan exists');
  if (/confirmation-preview/.test(doc)) pass('A.plan.preview', 'plan documents confirmation-preview');
  else fail('A.plan.preview', 'confirmation-preview missing from plan');
  if (/14c/.test(doc) && /NO_GO|Stage 7\.8/i.test(doc)) {
    pass('A.plan.nogo', 'plan documents 14c NO_GO / Stage 7.8');
  } else {
    fail('A.plan.nogo', 'Stage 7.8 NO_GO missing from plan');
  }
} else {
  fail('A.plan', 'plan doc missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Confirmation preview helper + route');

const helperSrc = fs.existsSync(HELPER) ? fs.readFileSync(HELPER, 'utf8') : '';
const apiSrc    = fs.existsSync(API) ? fs.readFileSync(API, 'utf8') : '';

if (helperSrc.includes('getLunaBookingConfirmationPreview')) {
  pass('B1', 'preview helper exports getLunaBookingConfirmationPreview');
} else {
  fail('B1', 'preview helper missing');
}

const routeIdx   = apiSrc.indexOf("'/staff/bot/bookings/confirmation-preview'");
const routeBlock = routeIdx > -1 ? apiSrc.slice(routeIdx, routeIdx + 700) : '';
const handler    = sliceHandler(apiSrc, 'handleBotBookingConfirmationPreview');

if (routeIdx > -1) pass('B2', 'POST /staff/bot/bookings/confirmation-preview registered');
else fail('B2', 'confirmation-preview route missing');

if (routeBlock.includes('requireBotAuth')) pass('B3', 'route uses requireBotAuth');
else fail('B3', 'requireBotAuth missing on route');

if (handler.includes('getLunaBookingConfirmationPreview')) pass('B4', 'handler calls preview helper');
else fail('B4', 'handler does not call preview helper');

if (handler.includes('withPgClient')) pass('B5', 'handler uses withPgClient (structured read)');
else fail('B5', 'withPgClient missing in handler');

// ─────────────────────────────────────────────────────────────────────────────
section('C. Read-only safety — preview route/helper');

const combined = helperSrc + handler;

if (!hasWriteSql(combined)) pass('C1', 'preview helper/handler: no write SQL');
else fail('C1', 'write SQL detected in preview path');

if (!/confirmation_sent_at\s*=/.test(combined)) pass('C2', 'no confirmation_sent_at write');
else fail('C2', 'confirmation_sent_at write detected');

if (!/(sendWhatsApp|whatsapp\.send|fetch\([^)]*whatsapp)/i.test(combined)) {
  pass('C3', 'no WhatsApp send in preview path');
} else {
  fail('C3', 'WhatsApp send detected');
}

if (!/(fetchN8n|n8n\.io|triggerN8n)/i.test(combined)) pass('C4', 'no n8n call in preview path');
else fail('C4', 'n8n call detected');

if (!/(require\(['"]stripe['"]\)|new\s+Stripe\(|stripe\.checkout)/i.test(combined)) {
  pass('C5', 'no Stripe call in preview path');
} else {
  fail('C5', 'Stripe call detected');
}

if (!/getBookingConversationQuery|conversation_messages|chat_logs/i.test(combined)) {
  pass('C6', 'structured booking read only (no chat logs)');
} else {
  fail('C6', 'chat log query in preview path');
}

// ─────────────────────────────────────────────────────────────────────────────
section('D. Preview safety flags (helper constants)');

const SAFETY_KEYS = [
  ['preview_only', 'D1'],
  ['no_write_performed', 'D2'],
  ['sends_whatsapp', 'D3'],
  ['calls_n8n', 'D4'],
  ['updates_confirmation_sent_at', 'D5'],
  ['send_ready', 'D6'],
];

for (const [key, id] of SAFETY_KEYS) {
  if (helperSrc.includes(key)) pass(id, `helper pins ${key}`);
  else fail(id, `${key} missing from helper`);
}

if (/send_ready:\s*false/.test(helperSrc)) pass('D7', 'send_ready defaults false');
else fail('D7', 'send_ready false default missing');

if (helperSrc.includes('owner_approval_stage_7_8')) pass('D8', 'required_approvals includes Stage 7.8 gate');
else fail('D8', 'owner_approval_stage_7_8 missing');

// ─────────────────────────────────────────────────────────────────────────────
section('E. Wolfhouse confirmation config');

if (fs.existsSync(CONFIG)) {
  const cfg  = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const conf = cfg.confirmation || {};
  if (conf.address === CONFIRMED_ADDRESS) pass('E1', 'confirmation.address is confirmed Wolfhouse address');
  else fail('E1', 'confirmation.address mismatch: ' + conf.address);
  if (conf.gate_code === ANCHOR_GATE) pass('E2', 'confirmation.gate_code is 2684#');
  else fail('E2', 'gate_code mismatch');
  if (conf.include_address === true) pass('E3', 'confirmation.include_address true');
  else fail('E3', 'include_address not true');
  if (conf.include_bed_number === false) pass('E4', 'confirmation.include_bed_number false');
  else fail('E4', 'include_bed_number not false');
} else {
  fail('E1', 'wolfhouse-somo.baseline.json missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('F. Address fallback order (static)');

const resolveFn = helperSrc.slice(
  helperSrc.indexOf('function resolveConfirmationAddress'),
  helperSrc.indexOf('function resolveConfirmationAddress') + 1200,
);
orderBefore(resolveFn, 'draft.address', 'clientConfig.address', 'F1', 'draft address checked before config address');
if (helperSrc.includes('confirmation_address_missing')) pass('F2', 'blocks when required address missing');
else fail('F2', 'confirmation_address_missing block missing');
if (helperSrc.includes("source: 'confirmation_draft'")) pass('F3', 'address_source confirmation_draft');
else fail('F3', 'confirmation_draft source missing');
if (helperSrc.includes("source: 'client_config'")) pass('F4', 'address_source client_config');
else fail('F4', 'client_config source missing');

// ─────────────────────────────────────────────────────────────────────────────
section('G. Preview runtime — blocks, allows, message rules');

const {
  getLunaBookingConfirmationPreview,
  resolveConfirmationAddress,
} = require('./lib/luna-booking-confirmation-preview');

(async () => {
  const bedLeakRe = /(?:DEMO-R\d+-B\d+|\bB[1-9]\b)/i;

  const draftFirst = resolveConfirmationAddress(
    makeConfirmationDraft({ address: DRAFT_ADDRESS }),
    { include_address: true, address: CONFIRMED_ADDRESS, gate_code: ANCHOR_GATE },
  );
  if (draftFirst.source === 'confirmation_draft' && draftFirst.address === DRAFT_ADDRESS) {
    pass('G1', 'draft address wins over config address');
  } else {
    fail('G1', 'draft-first resolution failed');
  }

  const configSecond = resolveConfirmationAddress(
    makeConfirmationDraft({ address: null }),
    { include_address: true, address: CONFIRMED_ADDRESS, gate_code: ANCHOR_GATE },
  );
  if (configSecond.source === 'client_config' && configSecond.address === CONFIRMED_ADDRESS) {
    pass('G2', 'config address used when draft.address null');
  } else {
    fail('G2', 'config fallback failed');
  }

  const paidRow = makeBookingRow();
  const paidPreview = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_code: ANCHOR_BOOKING_CODE },
    { pg: makeMockPg(paidRow) },
  );
  if (paidPreview.success === true) pass('G3', 'allows deposit_paid booking');
  else fail('G3', 'deposit_paid preview failed');

  const paidFull = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_id: ANCHOR_BOOKING_ID },
    { pg: makeMockPg(makeBookingRow({ payment_status: 'paid' })) },
  );
  if (paidFull.success === true) pass('G4', 'allows paid booking');
  else fail('G4', 'paid preview failed');

  const missingId = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo' },
    { pg: makeMockPg(paidRow) },
  );
  if (missingId.success === false
    && (missingId.blocked_reasons || []).includes('missing_booking_identifier')) {
    pass('G5', 'blocks missing booking identifier');
  } else {
    fail('G5', 'missing identifier not blocked');
  }

  const notFound = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_code: 'MB-NOTFOUND' },
    { pg: makeMockPg(null) },
  );
  if (notFound.success === false
    && (notFound.blocked_reasons || []).includes('booking_not_found')) {
    pass('G6', 'blocks booking not found');
  } else {
    fail('G6', 'not found not blocked');
  }

  const unpaid = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_code: ANCHOR_BOOKING_CODE },
    { pg: makeMockPg(makeBookingRow({ payment_status: 'pending' })) },
  );
  if (unpaid.success === false
    && (unpaid.blocked_reasons || []).includes('payment_not_paid')) {
    pass('G7', 'blocks unpaid booking');
  } else {
    fail('G7', 'unpaid not blocked');
  }

  const noDraft = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_code: ANCHOR_BOOKING_CODE },
    { pg: makeMockPg(makeBookingRow({ metadata: {} })) },
  );
  if (noDraft.success === false
    && (noDraft.blocked_reasons || []).includes('confirmation_draft_missing')) {
    pass('G8', 'blocks missing confirmation_draft');
  } else {
    fail('G8', 'missing draft not blocked');
  }

  const noAddr = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_code: ANCHOR_BOOKING_CODE },
    {
      pg: makeMockPg(makeBookingRow({ confirmation_draft: makeConfirmationDraft({ address: null }) })),
      loadClientConfirmationConfig: () => ({
        include_address: true, address: null, gate_code: ANCHOR_GATE,
      }),
    },
  );
  if (noAddr.success === false
    && (noAddr.blocked_reasons || []).includes('confirmation_address_missing')) {
    pass('G9', 'blocks missing address when include_address true');
  } else {
    fail('G9', 'missing address not blocked');
  }

  const nullDraftConfig = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_code: ANCHOR_BOOKING_CODE },
    { pg: makeMockPg(makeBookingRow({ confirmation_draft: makeConfirmationDraft({ address: null }) })) },
  );
  const cfgMsg = String(nullDraftConfig.message_preview || '');
  if (nullDraftConfig.success === true
    && nullDraftConfig.address_source === 'client_config'
    && cfgMsg.includes(`Address: ${CONFIRMED_ADDRESS}`)
    && cfgMsg.includes(ANCHOR_GATE)
    && /Room:\s*DEMO-R1/.test(cfgMsg)
    && !bedLeakRe.test(cfgMsg)) {
    pass('G10', 'null-draft preview uses config address with gate + room, no bed leak');
  } else {
    fail('G10', 'config fallback preview message rules failed');
  }

  const multiRoom = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_code: ANCHOR_BOOKING_CODE },
    { pg: makeMockPg(paidRow, ['DEMO-R1', 'DEMO-R2']) },
  );
  const multiMsg = String(multiRoom.message_preview || '');
  if (multiMsg.includes('DEMO-R1') && multiMsg.includes('DEMO-R2') && !bedLeakRe.test(multiMsg)) {
    pass('G11', 'multi-room: room-level only, excludes bed codes');
  } else {
    fail('G11', 'multi-room preview unsafe');
  }

  if (paidPreview.preview_only === true
    && paidPreview.no_write_performed === true
    && paidPreview.sends_whatsapp === false
    && paidPreview.calls_n8n === false
    && paidPreview.updates_confirmation_sent_at === false
    && paidPreview.send_ready === false) {
    pass('G12', 'preview response safety flags pinned');
  } else {
    fail('G12', 'safety flags not pinned on success response');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  section('H. Live send remains NO_GO');

  const hasSendRoute = /['"]\/staff\/bot\/bookings\/[^'"]*send-confirmation['"]/.test(apiSrc)
    || /pathname === '\/staff\/bot\/bookings\/[^']*send-confirmation'/.test(apiSrc);
  const hasSendHandler = /handleBot(?:Booking)?SendConfirmation/.test(apiSrc);

  if (!hasSendRoute && !hasSendHandler) {
    pass('H1', 'no Staff API send-confirmation route/handler (14c deferred)');
  } else {
    fail('H1', 'send-confirmation route or handler present — live send not approved');
  }

  if (routeIdx > -1 && !routeBlock.includes('send-confirmation')) {
    pass('H2', 'confirmation-preview route is read-only preview, not send');
  } else {
    fail('H2', 'confirmation-preview route conflated with send');
  }

  if (fs.existsSync(SENDLIB)) {
    const sendSrc = fs.readFileSync(SENDLIB, 'utf8');
    if (/WHATSAPP_DRY_RUN/.test(sendSrc)) pass('H3', 'legacy send builder honors WHATSAPP_DRY_RUN');
    else fail('H3', 'WHATSAPP_DRY_RUN missing in send builder');
  } else {
    fail('H3', 'build-send-confirmation-local.js missing');
  }

  const planSrc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';
  if (/Stage 7\.8/.test(planSrc) && /NO_GO/i.test(planSrc)) {
    pass('H4', 'plan requires Stage 7.8 owner approval before live send');
  } else {
    fail('H4', 'Stage 7.8 NO_GO missing from plan');
  }

  if (!helperSrc.includes('WHATSAPP_LIVE_SENDS_ENABLED')) {
    pass('H5', 'preview path does not enable live WhatsApp sends');
  } else if (helperSrc.includes('SEND_REQUIRED_APPROVALS')) {
    pass('H5', 'live send gated behind required_approvals only');
  } else {
    fail('H5', 'live send gate unclear');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  section('I. Downstream verifier regression');

  for (const scriptName of DOWNSTREAM_VERIFIERS) {
    try {
      execSync(`npm run ${scriptName}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
      pass('I.' + scriptName, `${scriptName} passes`);
    } catch (e) {
      fail('I.' + scriptName, `${scriptName} failed`);
      const out = (e.stdout || '') + (e.stderr || '');
      const tail = out.split('\n').slice(-4).join('\n');
      if (tail) console.error(tail);
    }
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
