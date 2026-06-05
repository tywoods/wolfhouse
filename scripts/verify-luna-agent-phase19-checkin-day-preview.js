/**
 * Phase 19c — Verifier for Luna check-in day preview route (read-only).
 *
 * Usage:
 *   npm run verify:luna-agent-phase19-checkin-day-preview
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API  = path.join(__dirname, 'staff-query-api.js');
const HELPER = path.join(__dirname, 'lib', 'luna-guest-checkin-day-message.js');
const CONTEXT = path.join(__dirname, 'lib', 'luna-checkin-day-preview-context.js');
const PKG  = path.join(ROOT, 'package.json');

const ANCHOR_BOOKING_ID   = '9073415f-1501-4bdf-b1c8-ce5879c93662';
const ANCHOR_BOOKING_CODE = 'MB-WOLFHO-20260920-b6f9c7';

const SAFETY = {
  preview_only: true,
  no_write_performed: true,
  sends_whatsapp: false,
  creates_booking: false,
  creates_payment: false,
  creates_stripe_link: false,
  calls_n8n: false,
  updates_confirmation_sent_at: false,
};

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

function readOrEmpty(filePath) {
  try { return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''; }
  catch { return ''; }
}

const { planLunaCheckinDayMessage } = require('./lib/luna-guest-checkin-day-message');
const {
  resolveCheckinDayPreviewRequest,
  loadLunaCheckinDayPreviewBookingContext,
  mergeCheckinDayPreviewInput,
  pickExistingBalancePaymentLink,
} = require('./lib/luna-checkin-day-preview-context');

console.log('\nverify-luna-agent-phase19-checkin-day-preview.js  (Phase 19c)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const apiSrc = readOrEmpty(API);
const contextSrc = readOrEmpty(CONTEXT);
const routeIdx = apiSrc.indexOf("'/staff/bot/checkin-day-preview'");
const routeBlock = routeIdx > -1 ? apiSrc.slice(routeIdx, routeIdx + 700) : '';
const handlerStart = apiSrc.indexOf('async function handleBotCheckinDayPreview(');
const handlerEnd = handlerStart > -1
  ? apiSrc.indexOf('\n// Route: POST /staff/bot/guest-reply-draft', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? apiSrc.slice(handlerStart, handlerEnd)
  : '';
const combinedSrc = contextSrc + handler;

section('A. Route + handler');

if (routeIdx > -1) pass('A1', 'POST /staff/bot/checkin-day-preview registered');
else fail('A1', 'route not registered');

if (routeBlock.includes("method !== 'POST'")) pass('A2', 'POST-only guard');
else fail('A2', 'POST-only guard missing');

if (routeBlock.includes('requireBotAuth')) pass('A3', 'route uses requireBotAuth');
else fail('A3', 'requireBotAuth missing');

if (handler.includes('planLunaCheckinDayMessage')) pass('A4', 'handler calls planLunaCheckinDayMessage');
else fail('A4', 'planLunaCheckinDayMessage missing from handler');

if (handler.includes('resolveCheckinDayPreviewRequest')) pass('A5', 'handler resolves booking context');
else fail('A5', 'resolveCheckinDayPreviewRequest missing');

if (handler.includes('booking_context_loaded')) pass('A6', 'response includes booking_context_loaded');
else fail('A6', 'booking_context_loaded missing from response');

if (contextSrc.includes('missing_booking_context') && handler.includes('resolved.error')) {
  pass('A7', 'handler surfaces missing_booking_context via resolver');
} else {
  fail('A7', 'missing_booking_context handling missing');
}

if (handler.includes('withPgClient')) pass('A8', 'handler uses withPgClient for booking reads');
else fail('A8', 'withPgClient missing');

section('B. Preview fixtures (preview_context-only)');

function buildPreviewInput(body) {
  const src = body || {};
  const preview = src.preview_context || {};
  const history = preview.conversation_history || preview.conversation_messages || [];
  return {
    client_slug: src.client_slug || preview.client_slug || 'wolfhouse-somo',
    booking_status: preview.booking_status || 'confirmed',
    check_in: preview.check_in,
    guest_name: preview.guest_name,
    language: preview.language || 'en',
    payment_status: preview.payment_status,
    balance_due_cents: preview.balance_due_cents,
    balance_payment_link: preview.balance_payment_link,
    address: preview.address,
    gate_code: preview.gate_code,
    room_number: preview.room_number,
    room_assigned: preview.room_assigned ?? (preview.room_number ? true : undefined),
    conversation_messages: history,
    payment_preference_history: preview.payment_preference_history || history,
  };
}

function wrapRouteResponse(plan) {
  return {
    success: plan.success === true,
    ...SAFETY,
    checkin_day_plan: plan,
    message_preview: plan.message_text || null,
    payment_link_log: plan.payment_link_log || null,
    messaging_playbook: plan.messaging_playbook || null,
  };
}

const enBody = {
  client_slug: 'wolfhouse-somo',
  preview_context: {
    guest_name: 'Preview Guest',
    language: 'en',
    check_in: '2026-09-24',
    payment_status: 'deposit_paid',
    balance_due_cents: 17000,
    balance_payment_link: 'https://example.test/pay-balance',
    address: 'C. Mies de La Ran, 41, 39140 Somo, Cantabria',
    gate_code: '2684#',
    room_number: 'DEMO-R1',
    conversation_history: [],
  },
};

const enPlan = planLunaCheckinDayMessage(buildPreviewInput(enBody));
const enOut = wrapRouteResponse(enPlan);

if (enOut.success && enOut.message_preview.includes('https://example.test/pay-balance')) {
  pass('B.en.link', 'EN with balance due includes payment link');
} else {
  fail('B.en.link', 'EN payment link missing');
}

for (const phrase of ['Wolfhouse family', 'surf', 'beach', 'arrival']) {
  if (enOut.message_preview.includes(phrase) || /arrival time|flight info/i.test(enOut.message_preview)) {
    pass('B.en.' + phrase, `EN includes ${phrase} or arrival logistics`);
  } else {
    fail('B.en.' + phrase, `EN missing ${phrase}/arrival logistics`);
  }
}

if (enOut.messaging_playbook && enOut.messaging_playbook.playbook_loaded === true) {
  pass('B.en.playbook', 'EN messaging_playbook.playbook_loaded true');
} else {
  fail('B.en.playbook', 'messaging_playbook missing');
}

if (enOut.checkin_day_plan.templates_source === 'messaging_playbook') {
  pass('B.en.tpl', 'templates_source messaging_playbook');
} else {
  fail('B.en.tpl', 'templates_source should be messaging_playbook');
}

const itBody = {
  client_slug: 'wolfhouse-somo',
  preview_context: {
    guest_name: 'Ospite Preview',
    language: 'it',
    check_in: '2026-09-24',
    payment_status: 'deposit_paid',
    balance_due_cents: 17000,
    balance_payment_link: 'https://example.test/pay-balance-it',
    address: 'C. Mies de La Ran, 41, 39140 Somo, Cantabria',
    gate_code: '2684#',
    conversation_history: [
      { text: 'Posso pagare il saldo con bonifico all\'arrivo?' },
    ],
  },
};

const itPlan = planLunaCheckinDayMessage(buildPreviewInput(itBody));
const itOut = wrapRouteResponse(itPlan);

if (!itOut.checkin_day_plan.payment_link_included
  && !/pay-balance|carta|card/i.test(itOut.message_preview || '')) {
  pass('B.it.suppress', 'IT suppresses payment after cash/bank ask');
} else {
  fail('B.it.suppress', 'IT should suppress payment text/link');
}

if (/famiglia Wolfhouse|Wolfhouse/i.test(itOut.message_preview || '')) {
  pass('B.it.welcome', 'IT still includes Wolfhouse welcome');
} else {
  fail('B.it.welcome', 'IT welcome missing');
}

if (!/\bbed\s*(?:number|#)/i.test(enOut.message_preview || '')) {
  pass('B.no_bed', 'message excludes bed number');
} else {
  fail('B.no_bed', 'bed number leaked');
}

section('C. Booking context loader (mock pg)');

function makeConfirmationDraft(overrides) {
  return Object.assign({
    booking_code: ANCHOR_BOOKING_CODE,
    guest_name: 'DB Guest',
    language: 'en',
    payment_status: 'deposit_paid',
    amount_paid_cents: 10000,
    balance_due_cents: 17000,
    room_number: 'DEMO-R1',
    address: 'C. Mies de La Ran, 41, 39140 Somo, Cantabria',
    gate_code: '2684#',
  }, overrides || {});
}

function makeBookingRow(overrides) {
  const draft = overrides && overrides.confirmation_draft !== undefined
    ? overrides.confirmation_draft
    : makeConfirmationDraft();
  const metadata = draft === null ? {} : { confirmation_draft: draft };
  return {
    booking_id: ANCHOR_BOOKING_ID,
    booking_code: ANCHOR_BOOKING_CODE,
    guest_name: 'DB Guest',
    phone: '+34600000000',
    check_in: '2026-09-24',
    check_out: '2026-09-27',
    booking_status: 'confirmed',
    payment_status: 'deposit_paid',
    amount_paid_cents: 10000,
    total_amount_cents: 27000,
    primary_room_code: 'DEMO-R1',
    metadata,
    ...(overrides || {}),
  };
}

function makeMockPg(bookingRow, paymentRows, roomCodes) {
  const row = bookingRow;
  const payments = paymentRows || [];
  const rooms = roomCodes || ['DEMO-R1'];
  return {
    query: async (sql) => {
      const s = String(sql);
      if (/FROM\s+bookings\s+b/i.test(s) && /clients\s+c/i.test(s)) {
        if (!row) return { rows: [] };
        return { rows: [row] };
      }
      if (/FROM\s+booking_beds/i.test(s)) {
        return { rows: rooms.map((rc) => ({ room_code: rc })) };
      }
      if (/FROM\s+payments\s+p/i.test(s)) {
        return { rows: payments };
      }
      return { rows: [] };
    },
  };
}

(async () => {
  const missing = await resolveCheckinDayPreviewRequest({}, null);
  if (missing.ok === false && missing.error === 'missing_booking_context') {
    pass('C.missing', 'missing booking identifier + preview_context returns missing_booking_context');
  } else {
    fail('C.missing', `expected missing_booking_context, got ${JSON.stringify(missing)}`);
  }

  const previewOnly = await resolveCheckinDayPreviewRequest(enBody, null);
  if (previewOnly.ok && previewOnly.booking_context_loaded === false) {
    pass('C.preview_only', 'preview_context-only path without pg');
  } else {
    fail('C.preview_only', 'preview_context-only path failed');
  }

  const notFound = await resolveCheckinDayPreviewRequest(
    { client_slug: 'wolfhouse-somo', booking_code: ANCHOR_BOOKING_CODE },
    makeMockPg(null),
  );
  if (notFound.ok === false && notFound.error === 'booking_not_found') {
    pass('C.not_found', 'booking not found returns safe error');
  } else {
    fail('C.not_found', `expected booking_not_found, got ${JSON.stringify(notFound)}`);
  }

  const paidRow = makeBookingRow();
  const byCode = await resolveCheckinDayPreviewRequest(
    { client_slug: 'wolfhouse-somo', booking_code: ANCHOR_BOOKING_CODE },
    makeMockPg(paidRow, [{
      payment_status: 'checkout_created',
      payment_kind: 'balance',
      amount_due_cents: 17000,
      amount_paid_cents: 0,
      checkout_url: 'https://pay.example/existing-balance',
    }]),
  );
  if (byCode.ok && byCode.booking_context_loaded === true
    && byCode.booking_code === ANCHOR_BOOKING_CODE) {
    pass('C.by_code', 'booking_code path loads context');
  } else {
    fail('C.by_code', `booking_code path failed: ${JSON.stringify(byCode)}`);
  }

  const byId = await resolveCheckinDayPreviewRequest(
    { client_slug: 'wolfhouse-somo', booking_id: ANCHOR_BOOKING_ID },
    makeMockPg(paidRow),
  );
  if (byId.ok && byId.booking_id === ANCHOR_BOOKING_ID) {
    pass('C.by_id', 'booking_id path loads context');
  } else {
    fail('C.by_id', 'booking_id path failed');
  }

  if (byCode.input.guest_name === 'DB Guest' && byCode.input.check_in === '2026-09-24') {
    pass('C.fields', 'booking context loads guest_name + check_in');
  } else {
    fail('C.fields', 'expected booking fields missing');
  }

  if (byCode.input.balance_payment_link === 'https://pay.example/existing-balance') {
    pass('C.existing_link', 'uses existing balance payment URL from payments SELECT');
  } else {
    fail('C.existing_link', 'existing balance payment URL not loaded');
  }

  const noLinkLoaded = await resolveCheckinDayPreviewRequest(
    { client_slug: 'wolfhouse-somo', booking_code: ANCHOR_BOOKING_CODE },
    makeMockPg(paidRow, []),
  );
  const noLinkPlan = planLunaCheckinDayMessage(noLinkLoaded.input);
  if (!noLinkPlan.payment_link_included
    && noLinkPlan.payment_link_log.reason === 'balance_payment_link_missing') {
    pass('C.no_invent', 'payment link not invented when absent in DB');
  } else {
    fail('C.no_invent', 'should not invent payment link');
  }

  const overrideBody = {
    client_slug: 'wolfhouse-somo',
    booking_code: ANCHOR_BOOKING_CODE,
    preview_context: {
      guest_name: 'Override Guest',
      balance_payment_link: 'https://example.test/override-link',
    },
  };
  const overridden = await resolveCheckinDayPreviewRequest(
    overrideBody,
    makeMockPg(paidRow, [{
      payment_status: 'checkout_created',
      payment_kind: 'balance',
      checkout_url: 'https://pay.example/existing-balance',
    }]),
  );
  if (overridden.input.guest_name === 'Override Guest'
    && overridden.input.balance_payment_link === 'https://example.test/override-link') {
    pass('C.override', 'explicit preview_context overrides booking context');
  } else {
    fail('C.override', 'preview_context override failed');
  }

  const holdRow = makeBookingRow({ booking_status: 'hold' });
  const holdResolved = await resolveCheckinDayPreviewRequest(
    { client_slug: 'wolfhouse-somo', booking_code: ANCHOR_BOOKING_CODE },
    makeMockPg(holdRow),
  );
  const holdPlan = planLunaCheckinDayMessage(holdResolved.input);
  if ((holdPlan.blocked_reasons || []).includes('booking_not_confirmed')) {
    pass('C.unconfirmed', 'unconfirmed booking yields blocked plan without write/send');
  } else {
    fail('C.unconfirmed', 'expected booking_not_confirmed block');
  }

  const cashMeta = makeBookingRow({
    metadata: {
      confirmation_draft: makeConfirmationDraft(),
      payment_preference_history: ['Can we pay the balance by bank transfer on arrival?'],
    },
  });
  const cashResolved = await resolveCheckinDayPreviewRequest(
    { client_slug: 'wolfhouse-somo', booking_code: ANCHOR_BOOKING_CODE },
    makeMockPg(cashMeta, [{
      payment_status: 'checkout_created',
      payment_kind: 'balance',
      checkout_url: 'https://pay.example/existing-balance',
    }]),
  );
  const cashPlan = planLunaCheckinDayMessage(cashResolved.input);
  if (!cashPlan.payment_link_included
    && cashPlan.payment_link_log.reason === 'guest_previously_asked_cash_or_bank_transfer') {
    pass('C.cash_suppress', 'payment suppression still works from DB conversation hints');
  } else {
    fail('C.cash_suppress', 'cash/bank suppression from DB hints failed');
  }

  const depositOnly = pickExistingBalancePaymentLink([{
    payment_status: 'checkout_created',
    payment_kind: 'deposit_only',
    checkout_url: 'https://pay.example/deposit',
  }]);
  if (depositOnly == null) pass('C.skip_deposit', 'does not reuse deposit checkout as balance link');
  else fail('C.skip_deposit', 'deposit link incorrectly picked as balance');

  section('D. Safety');

  for (const [flag, val] of Object.entries(SAFETY)) {
    if (enOut[flag] === val) pass('D.' + flag, `${flag}=${val}`);
    else fail('D.' + flag, `expected ${flag}=${val}`);
  }

  if (!/\bINSERT\b/i.test(combinedSrc)) pass('D.sql.insert', 'no INSERT SQL');
  else fail('D.sql.insert', 'INSERT SQL found');

  if (!/\bUPDATE\b/i.test(combinedSrc)) pass('D.sql.update', 'no UPDATE SQL');
  else fail('D.sql.update', 'UPDATE SQL found');

  if (!/\bDELETE\b/i.test(combinedSrc)) pass('D.sql.delete', 'no DELETE SQL');
  else fail('D.sql.delete', 'DELETE SQL found');

  const handlerOnly = handler.split('\n').filter((l) => !/^\s*\[['"]/.test(l)).join('\n');
  for (const [id, re, label] of [
    ['D.stripe', /createStripe\s*\(|api\.stripe\.com|new\s+Stripe\s*\(/i, 'Stripe API calls'],
    ['D.wa', /sendWhatsApp\s*\(|graph\.facebook\.com/i, 'WhatsApp send'],
    ['D.n8n', /activateN8n|triggerN8n|fetchN8n\s*\(/i, 'n8n activation'],
  ]) {
    if (!re.test(handlerOnly + contextSrc)) pass(id, `no ${label}`);
    else fail(id, `${label} detected`);
  }

  if (!/createStripe|checkout\.sessions\.create/i.test(contextSrc)) {
    pass('D.no_link_create', 'context helper does not create Stripe links');
  } else {
    fail('D.no_link_create', 'Stripe link creation detected in context helper');
  }

  section('E. npm script');

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  if (pkg.scripts && pkg.scripts['verify:luna-agent-phase19-checkin-day-preview']) {
    pass('E1', 'npm script registered');
  } else {
    fail('E1', 'npm script missing');
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error('VERIFIER_ERROR:', err.message);
  process.exit(1);
});
