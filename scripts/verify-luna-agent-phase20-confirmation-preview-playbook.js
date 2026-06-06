/**
 * Phase 20f — Verifier for Cami/Wolfhouse confirmation preview playbook wiring.
 *
 * Usage:
 *   npm run verify:luna-agent-phase20-confirmation-preview-playbook
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT     = path.join(__dirname, '..');
const HELPER   = path.join(__dirname, 'lib', 'luna-booking-confirmation-preview.js');
const PLAYBOOK = path.join(__dirname, 'lib', 'luna-client-messaging-playbook.js');
const API      = path.join(__dirname, 'staff-query-api.js');
const MSG_CFG  = path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.messaging.json');
const PKG      = path.join(ROOT, 'package.json');

const PHASE20_BOOKING_ID   = '828538c7-c6cb-4c6f-b45a-57a641af37cc';
const PHASE20_BOOKING_CODE = 'MB-WOLFHO-20260924-e90132';
const ANCHOR_ADDRESS       = 'C. Mies de La Ran, 41, 39140 Somo, Cantabria';
const ANCHOR_GATE          = '2684#';
const ANCHOR_ROOM          = 'DEMO-R1';

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

function readOrEmpty(filePath) {
  try { return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''; }
  catch { return ''; }
}

function makeConfirmationDraft(overrides) {
  return Object.assign({
    booking_code:       PHASE20_BOOKING_CODE,
    guest_name:         'Phase 20b Booking Proof',
    payment_status:     'deposit_paid',
    amount_paid_cents:  10000,
    balance_due_cents:  17000,
    room_number:        ANCHOR_ROOM,
    address:            ANCHOR_ADDRESS,
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
  if (overrides && overrides.metadata) {
    Object.assign(metadata, overrides.metadata);
  }
  return {
    booking_id:           PHASE20_BOOKING_ID,
    booking_code:         PHASE20_BOOKING_CODE,
    payment_status:       'deposit_paid',
    confirmation_sent_at: null,
    primary_room_code:    ANCHOR_ROOM,
    amount_paid_cents:    10000,
    total_amount_cents:   27000,
    metadata,
    ...(overrides || {}),
  };
}

function makeMockPg(bookingRow, roomCodes, paymentRows) {
  const row = bookingRow;
  const rooms = roomCodes || [ANCHOR_ROOM];
  const payments = paymentRows || [];
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

console.log('\nverify-luna-agent-phase20-confirmation-preview-playbook.js  (Phase 20f)\n');

const helperSrc   = readOrEmpty(HELPER);
const playbookSrc = readOrEmpty(PLAYBOOK);
const apiSrc      = readOrEmpty(API);

section('A. Playbook wiring presence');

if (/buildConfirmationPreviewFromPlaybook/.test(playbookSrc)) {
  pass('A1', 'playbook exports buildConfirmationPreviewFromPlaybook');
} else {
  fail('A1', 'buildConfirmationPreviewFromPlaybook missing from playbook module');
}

if (/confirmation_templates/.test(helperSrc) || /buildConfirmationPreviewFromPlaybook/.test(helperSrc)) {
  pass('A2', 'confirmation preview helper uses playbook templates');
} else {
  fail('A2', 'helper does not reference playbook confirmation templates');
}

if (/balance_payment_link_status/.test(helperSrc)) {
  pass('A3', 'balance_payment_link_status field implemented');
} else {
  fail('A3', 'balance_payment_link_status missing');
}

if (/included_existing_link|missing_existing_link|suppressed_cash_or_bank|no_balance_due/.test(helperSrc)) {
  pass('A4', 'balance link status enum values present');
} else {
  fail('A4', 'balance link status enum values missing');
}

if (/creates_stripe_link:\s*false/.test(helperSrc) && /calls_graph_api:\s*false/.test(helperSrc)) {
  pass('A5', 'extended safety flags on preview helper');
} else {
  fail('A5', 'creates_stripe_link / calls_graph_api safety flags missing');
}

if (/FULLY_PAID_PHRASES_RE|fully paid|message_preview_fully_paid_wording/.test(helperSrc)) {
  pass('A6', 'deposit_paid fully-paid wording guard present');
} else {
  fail('A6', 'fully-paid wording guard missing');
}

if (/guestAskedCashOrBankTransfer|CASH_BANK_RE/.test(helperSrc)) {
  pass('A7', 'cash/bank suppression helper present');
} else {
  fail('A7', 'cash/bank suppression helper missing');
}

if (/pickExistingBalancePaymentLink/.test(helperSrc)) {
  pass('A8', 'reads existing balance checkout_url only (no creation)');
} else {
  fail('A8', 'pickExistingBalancePaymentLink missing');
}

section('B. Read-only safety');

const combinedSrc = helperSrc + apiSrc.slice(
  apiSrc.indexOf('async function handleBotBookingConfirmationPreview('),
  apiSrc.indexOf('async function handleBotBookingConfirmationPreview(') + 1200,
);

if (!/\bINSERT\b/i.test(helperSrc)) pass('B1', 'no INSERT in preview helper');
else fail('B1', 'INSERT found in preview helper');

if (!/\bUPDATE\b/i.test(helperSrc)) pass('B2', 'no UPDATE in preview helper');
else fail('B2', 'UPDATE found in preview helper');

if (!/(require\(['"]stripe['"]\)|new\s+Stripe\(|stripe\.checkout\.sessions\.create)/i.test(helperSrc)) {
  pass('B3', 'no Stripe API in preview helper');
} else {
  fail('B3', 'Stripe API detected in preview helper');
}

if (!/(sendWhatsApp|whatsapp\.send|graph\.facebook)/i.test(combinedSrc)) {
  pass('B4', 'no WhatsApp / Graph API send in preview path');
} else {
  fail('B4', 'WhatsApp / Graph API send detected');
}

if (!/confirmation_sent_at\s*=/.test(helperSrc)) pass('B5', 'no confirmation_sent_at write');
else fail('B5', 'confirmation_sent_at write detected');

section('C. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts
  && pkg.scripts['verify:luna-agent-phase20-confirmation-preview-playbook']
    === 'node scripts/verify-luna-agent-phase20-confirmation-preview-playbook.js') {
  pass('C1', 'verify:luna-agent-phase20-confirmation-preview-playbook registered');
} else {
  fail('C1', 'npm script missing or wrong path');
}

section('D. Runtime preview behavior (mock pg)');

const {
  getLunaBookingConfirmationPreview,
  guestAskedCashOrBankTransfer,
  resolveBalancePaymentLinkStatus,
} = require('./lib/luna-booking-confirmation-preview');

(async () => {
  const bedLeakRe = /(?:DEMO-R\d+-B\d+|\bB[1-9]\b)/i;

  const depositPreview = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_id: PHASE20_BOOKING_ID },
    { pg: makeMockPg(makeBookingRow()) },
  );

  if (depositPreview.success === true) pass('D1', 'Phase 20 deposit_paid preview succeeds');
  else fail('D1', `expected success: ${JSON.stringify(depositPreview)}`);

  if (depositPreview.template_source === 'confirmation_templates') {
    pass('D2', 'template_source confirmation_templates (Cami playbook)');
  } else {
    fail('D2', `template_source expected confirmation_templates, got ${depositPreview.template_source}`);
  }

  if (depositPreview.messaging_playbook && depositPreview.messaging_playbook.playbook_loaded === true) {
    pass('D3', 'messaging_playbook.playbook_loaded true');
  } else {
    fail('D3', 'messaging_playbook not loaded');
  }

  const msg = String(depositPreview.message_preview || '');

  if (/Payment received|confirmed/i.test(msg)) pass('D4', 'warm confirmation / deposit received wording');
  else fail('D4', 'confirmation wording missing');

  if (msg.includes('€100') || /Paid:\s*€100/i.test(msg)) pass('D5', 'includes paid amount €100');
  else fail('D5', 'paid amount €100 missing');

  if (msg.includes('€170') || /Balance due:\s*€170/i.test(msg)) pass('D6', 'includes balance due €170');
  else fail('D6', 'balance due €170 missing');

  if (/Address:/i.test(msg) && msg.includes(ANCHOR_ADDRESS)) pass('D7', 'includes Wolfhouse address');
  else fail('D7', 'address missing');

  if (msg.includes(ANCHOR_GATE)) pass('D8', 'includes gate code 2684#');
  else fail('D8', 'gate code missing');

  if (msg.includes(ANCHOR_ROOM)) pass('D9', 'includes room DEMO-R1');
  else fail('D9', 'room missing');

  if (!bedLeakRe.test(msg)) pass('D10', 'excludes bed codes');
  else fail('D10', `bed leak: ${msg}`);

  if (!/\bfully paid\b/i.test(msg) && !/\bpaid in full\b/i.test(msg)) {
    pass('D11', 'does not say fully paid for deposit_paid');
  } else {
    fail('D11', 'incorrect fully-paid wording for deposit_paid');
  }

  if (depositPreview.balance_payment_link_status === 'missing_existing_link') {
    pass('D12', 'balance_payment_link_status missing_existing_link when no balance checkout');
  } else {
    fail('D12', `expected missing_existing_link, got ${depositPreview.balance_payment_link_status}`);
  }

  if (!/https?:\/\//i.test(msg)) pass('D13', 'no fake Stripe link when checkout_url absent');
  else fail('D13', 'message includes URL without existing balance checkout');

  for (const flag of [
    'preview_only', 'no_write_performed', 'sends_whatsapp',
    'creates_stripe_link', 'calls_graph_api', 'calls_n8n', 'updates_confirmation_sent_at',
  ]) {
    if (depositPreview[flag] === (flag.startsWith('creates') || flag.startsWith('sends')
      || flag.startsWith('calls') || flag.startsWith('updates') ? false : true)) {
      pass('D.safe.' + flag, `${flag} safety flag correct`);
    } else {
      fail('D.safe.' + flag, `${flag} incorrect: ${depositPreview[flag]}`);
    }
  }

  const withLinkPreview = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_id: PHASE20_BOOKING_ID },
    {
      pg: makeMockPg(makeBookingRow(), [ANCHOR_ROOM], [{
        payment_status: 'checkout_created',
        payment_kind: 'full_amount',
        amount_due_cents: 17000,
        amount_paid_cents: 0,
        checkout_url: 'https://checkout.stripe.test/cs_test_balance_existing',
      }]),
    },
  );
  const linkMsg = String(withLinkPreview.message_preview || '');
  if (withLinkPreview.balance_payment_link_status === 'included_existing_link'
    && linkMsg.includes('https://checkout.stripe.test/cs_test_balance_existing')) {
    pass('D14', 'includes existing balance checkout_url when present');
  } else {
    fail('D14', `existing link not included: ${JSON.stringify(withLinkPreview)}`);
  }

  const cashRow = makeBookingRow({
    metadata: {
      confirmation_draft: makeConfirmationDraft(),
      conversation_history: [{ text: 'Can I pay the balance by bank transfer on arrival?' }],
    },
  });
  const cashPreview = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_id: PHASE20_BOOKING_ID },
    { pg: makeMockPg(cashRow) },
  );
  const cashMsg = String(cashPreview.message_preview || '');
  if (cashPreview.balance_payment_link_status === 'suppressed_cash_or_bank') {
    pass('D15', 'cash/bank conversation suppresses balance link status');
  } else {
    fail('D15', `expected suppressed_cash_or_bank, got ${cashPreview.balance_payment_link_status}`);
  }
  if (!/https?:\/\//i.test(cashMsg)) pass('D16', 'cash/bank suppression omits payment URL');
  else fail('D16', 'cash/bank preview still includes URL');

  const paidFullPreview = await getLunaBookingConfirmationPreview(
    { client_slug: 'wolfhouse-somo', booking_id: PHASE20_BOOKING_ID },
    {
      pg: makeMockPg(makeBookingRow({
        payment_status: 'paid',
        confirmation_draft: makeConfirmationDraft({ balance_due_cents: 0 }),
      })),
    },
  );
  if (paidFullPreview.balance_payment_link_status === 'no_balance_due') {
    pass('D17', 'no_balance_due when balance is zero');
  } else {
    fail('D17', `expected no_balance_due, got ${paidFullPreview.balance_payment_link_status}`);
  }

  section('E. Suppression unit checks');

  const metaCash = { conversation_history: [{ text: 'I prefer cash for the rest' }] };
  if (guestAskedCashOrBankTransfer(metaCash, {})) pass('E1', 'detects cash keyword');
  else fail('E1', 'cash keyword not detected');

  const metaBonifico = { payment_preference_history: ['bonifico all arrivo'] };
  if (guestAskedCashOrBankTransfer(metaBonifico, {})) pass('E2', 'detects bonifico keyword');
  else fail('E2', 'bonifico keyword not detected');

  if (resolveBalancePaymentLinkStatus(17000, true, 'https://x.test') === 'suppressed_cash_or_bank') {
    pass('E3', 'resolveBalancePaymentLinkStatus prefers suppression');
  } else {
    fail('E3', 'suppression status resolution wrong');
  }

  section('F. Messaging config anchor');

  if (fs.existsSync(MSG_CFG)) {
    const cfg = JSON.parse(fs.readFileSync(MSG_CFG, 'utf8'));
    if (cfg.confirmation_templates && cfg.confirmation_templates.en) {
      pass('F1', 'wolfhouse messaging.json has confirmation_templates.en');
    } else {
      fail('F1', 'confirmation_templates.en missing from messaging config');
    }
    if (cfg.balance_payment_templates && cfg.balance_payment_templates.card_option_in_confirmation) {
      pass('F2', 'balance_payment_templates.card_option_in_confirmation present');
    } else {
      fail('F2', 'balance card option template missing');
    }
  } else {
    fail('F1', 'wolfhouse-somo.messaging.json missing');
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
