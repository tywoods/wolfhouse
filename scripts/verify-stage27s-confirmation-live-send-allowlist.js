/**
 * Stage 27s — Confirmation live-send allowlist verifier.
 *
 * Usage:
 *   npm run verify:stage27s-confirmation-live-send-allowlist
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ALLOW_MOD = path.join(__dirname, 'lib', 'luna-guest-confirmation-live-send-allowlist.js');
const SEND_MOD = path.join(__dirname, 'lib', 'luna-guest-confirmation-send-go-no-go.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27S-CONFIRMATION-LIVE-SEND-ALLOWLIST.md');
const SCRIPT = 'verify:stage27s-confirmation-live-send-allowlist';

const {
  parseConfirmationLiveSendAllowlist,
  isConfirmationLiveSendRecipientAllowlisted,
  evaluateConfirmationLiveSendAllowlist,
  ALLOWLIST_ENV_KEY,
} = require('./lib/luna-guest-confirmation-live-send-allowlist');

const {
  runGuestConfirmationSendGoNoGo,
  runGuestConfirmationLiveSendAllowlisted,
} = require('./lib/luna-guest-confirmation-send-go-no-go');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

const TEST_ALLOWLIST_PHONE = '+491726422307';
const OTHER_PHONE = '+34600000099';
const UNIQUE_MSG = 'Luna from Wolfhouse STAGE27S-UNIQUE gate 2684# Room MB-01';

const READY_PREVIEW = {
  success: true,
  confirmation_preview_ready: true,
  confirmation_preview_attempted: true,
  confirmation_send_allowed: false,
  booking_id: '00000000-0000-4000-8000-000000000028',
  booking_code: 'WH-G27-LIVE',
  payment_status: 'deposit_paid',
  proposed_confirmation_message: UNIQUE_MSG,
  next_safe_step: 'ready_for_confirmation_send_go_no_go',
};

const DRY_RUN_ENV = {
  LUNA_AUTO_SEND_ENABLED: 'true',
  WHATSAPP_DRY_RUN: 'true',
  [ALLOWLIST_ENV_KEY]: TEST_ALLOWLIST_PHONE,
};

const LIVE_ENV = {
  LUNA_AUTO_SEND_ENABLED: 'true',
  WHATSAPP_DRY_RUN: 'false',
  [ALLOWLIST_ENV_KEY]: TEST_ALLOWLIST_PHONE,
  WHATSAPP_CLOUD_ACCESS_TOKEN: 'mock-token',
  WHATSAPP_PHONE_NUMBER_ID: 'mock-phone-id',
};

const SEND_INPUT = {
  confirmation_preview_result: READY_PREVIEW,
  confirm_send: true,
  to: TEST_ALLOWLIST_PHONE,
  idempotency_key: 'stage27s-live-send',
  client_slug: 'wolfhouse-somo',
  booking_code: 'WH-G27-LIVE',
};

console.log('\nverify-stage27s-confirmation-live-send-allowlist.js  (Stage 27s)\n');

try {
  execSync(`node --check "${ALLOW_MOD}"`, { stdio: 'pipe' });
  pass('0a', 'allowlist module passes node --check');
} catch {
  fail('0a', 'allowlist module syntax error');
}

try {
  execSync(`node --check "${SEND_MOD}"`, { stdio: 'pipe' });
  pass('0b', 'go/no-go module passes node --check');
} catch {
  fail('0b', 'go/no-go module syntax error');
}

const allowSrc = fs.readFileSync(ALLOW_MOD, 'utf8');
const sendSrc = fs.readFileSync(SEND_MOD, 'utf8');

section('A. package.json script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('A1', `${SCRIPT} registered`);
else fail('A1', `missing npm script ${SCRIPT}`);

section('B. Allowlist helpers');

const list = parseConfirmationLiveSendAllowlist({ [ALLOWLIST_ENV_KEY]: `${TEST_ALLOWLIST_PHONE}, ${OTHER_PHONE}` });
if (list.includes('491726422307') && list.includes('34600000099')) {
  pass('B1', 'parses allowlist env');
} else {
  fail('B1', 'allowlist parse failed');
}

if (isConfirmationLiveSendRecipientAllowlisted(TEST_ALLOWLIST_PHONE, LIVE_ENV)) {
  pass('B2', 'allowlisted phone matches');
} else {
  fail('B2', 'allowlisted phone must match');
}

if (!isConfirmationLiveSendRecipientAllowlisted(OTHER_PHONE, LIVE_ENV)) {
  pass('B3', 'non-allowlisted phone rejected');
} else {
  fail('B3', 'non-allowlisted must not match single-entry list');
}

section('C. confirm_send gate');

(async () => {
  const noConfirm = await runGuestConfirmationLiveSendAllowlisted(
    { ...SEND_INPUT, confirm_send: false },
    { env: LIVE_ENV },
  );

  if (noConfirm.send_attempted === false && noConfirm.send_status === 'not_approved') {
    pass('C1', 'confirm_send false never sends');
  } else {
    fail('C1', 'confirm_send false must block');
  }

  section('D. Dry-run blocks live send');

  const dryRun = await runGuestConfirmationLiveSendAllowlisted(SEND_INPUT, {
    env: DRY_RUN_ENV,
    pg: { query: async () => ({ rows: [] }) },
  });

  if (dryRun.send_status === 'blocked_dry_run' && dryRun.sends_whatsapp !== true) {
    pass('D1', 'WHATSAPP_DRY_RUN=true blocks live send');
  } else {
    fail('D1', `expected blocked_dry_run got ${dryRun.send_status}`);
  }

  if (dryRun.live_send_blocked === true) pass('D2', 'live_send_blocked under dry run');
  else fail('D2', 'live_send_blocked must be true');

  section('E. Live send allowlist gate');

  const notListed = await runGuestConfirmationLiveSendAllowlisted(
    { ...SEND_INPUT, to: OTHER_PHONE },
    { env: LIVE_ENV },
  );

  if (notListed.send_status === 'recipient_not_allowlisted' && notListed.live_send_blocked === true) {
    pass('E1', 'non-allowlisted recipient blocked on live env');
  } else {
    fail('E1', `expected recipient_not_allowlisted got ${notListed.send_status}`);
  }

  if (notListed.sends_whatsapp !== true) pass('E2', 'non-allowlisted never sends WhatsApp');
  else fail('E2', 'must not send to non-allowlisted');

  let providerCalled = false;
  let injectedMessage = null;

  const mockSend = async (input, ctx) => {
    if (typeof ctx.getLunaBookingConfirmationPreview === 'function') {
      const loaded = await ctx.getLunaBookingConfirmationPreview({});
      injectedMessage = loaded.message_preview;
    }
    providerCalled = true;
    return {
      ok: true,
      status: 200,
      result: {
        success: true,
        send_performed: true,
        sends_whatsapp: true,
        would_send_whatsapp: true,
        blocked_reasons: [],
        message_preview: injectedMessage,
        whatsapp_message_id: 'wamid.stage27s.mock',
        updates_confirmation_sent_at: false,
      },
    };
  };

  const allowlisted = await runGuestConfirmationLiveSendAllowlisted(SEND_INPUT, {
    env: LIVE_ENV,
    sendLunaBookingConfirmation: mockSend,
    pg: { query: async () => ({ rows: [] }) },
  });

  if (providerCalled) pass('E3', 'allowlisted recipient reaches send path');
  else fail('E3', 'allowlisted must reach provider/send path');

  if (injectedMessage === UNIQUE_MSG) {
    pass('E4', '27q message reused unchanged');
  } else {
    fail('E4', 'message must match 27q preview exactly');
  }

  if (allowlisted.send_status === 'sent' && allowlisted.recipient_allowlisted === true) {
    pass('E5', 'allowlisted live send status sent');
  } else {
    fail('E5', `expected sent got ${allowlisted.send_status}`);
  }

  section('F. Source hygiene');

  const forbidden = [
    ['F.stripe', /require\s*\(\s*['"]stripe['"]\)|checkout\.sessions/i],
    ['F.payment_write', /amount_paid_cents\s*=|status\s*=\s*'paid'::payment_record_status/i],
    ['F.booking_write', /UPDATE bookings[\s\S]*status\s*=\s*'confirmed'/i],
    ['F.n8n', /activateWorkflow|fetch\s*\([^)]*n8n/i],
  ];

  for (const [id, re] of forbidden) {
    if (!re.test(allowSrc) && !re.test(sendSrc.replace(/recipient_not_allowlisted/g, ''))) {
      pass(id, 'source clean');
    } else {
      fail(id, 'forbidden pattern in allowlist/send modules');
    }
  }

  if (sendSrc.includes('evaluateConfirmationLiveSendAllowlist')) {
    pass('F.wired', 'go/no-go wires allowlist evaluation');
  } else {
    fail('F.wired', 'go/no-go must call allowlist evaluation');
  }

  if (!/runGuestConfirmationPreviewDryRun/.test(sendSrc)) {
    pass('F.no_regen', 'does not regenerate 27q preview');
  } else {
    fail('F.no_regen', 'must not call 27q preview regeneration');
  }

  section('G. Doc files');

  if (fs.existsSync(DOC)) pass('G1', 'STAGE-27S doc exists');
  else fail('G1', 'missing STAGE-27S doc');

  const docText = fs.readFileSync(DOC, 'utf8');
  if (docText.includes(ALLOWLIST_ENV_KEY) && docText.includes('491726422307')) {
    pass('G2', 'doc documents allowlist env');
  } else {
    fail('G2', 'doc must document allowlist env');
  }

  section('H. Prior verifiers registered');

  if (pkg.scripts['verify:stage27r-confirmation-send-go-no-go']) pass('H1', '27r verifier registered');
  else fail('H1', '27r verifier missing');

  if (pkg.scripts['verify:stage27q-confirmation-preview']) pass('H2', '27q verifier registered');
  else fail('H2', '27q verifier missing');

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FAIL — verifier error:', e.message);
  process.exit(1);
});
