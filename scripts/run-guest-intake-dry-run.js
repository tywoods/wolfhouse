/**
 * Stage 27d/27g/27i/27k — Manual harness for POST /staff/bot/guest-intake-dry-run.
 *
 * Usage:
 *   npm run guest:intake:dry-run -- --message "Hi, we are 2 people..."
 *   npm run guest:intake:dry-run -- --fixture en-booking
 *   npm run guest:intake:dry-run -- --base-url http://127.0.0.1:3036 --fixture it-booking --json
 *
 * Auth (staging / token-gated hosts):
 *   LUNA_BOT_INTERNAL_TOKEN=<secret> in infra/.env or environment
 *   → sent as X-Luna-Bot-Token header (same as other /staff/bot/* proofs).
 *
 * Local open auth: start Staff API with STAFF_AUTH_REQUIRED not true and no token set.
 *
 * Does not write DB, send WhatsApp, call Stripe, Meta, or n8n.
 */

'use strict';

const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const ROUTE = '/staff/bot/guest-intake-dry-run';
const TOKEN = process.env.LUNA_BOT_INTERNAL_TOKEN || '';

const FIXTURES = {
  'en-booking': {
    label: 'English booking inquiry',
    message: "Hi, we're 2 people looking to stay from June 15 to June 22, interested in the Malibu package",
    language_hint: 'en',
  },
  'it-booking': {
    label: 'Italian booking inquiry',
    message: 'Ciao, siamo due persone e vorremmo venire dal 15 al 22 giugno',
    language_hint: 'it',
  },
  'es-transfer': {
    label: 'Spanish transfer question',
    message: 'Hola, necesito transfer desde el aeropuerto de Santander',
    language_hint: 'es',
  },
  'de-wetsuit': {
    label: 'German wetsuit/board request',
    message: 'Hallo, kann ich ein Surfbrett und einen Wetsuit mieten?',
    language_hint: 'de',
  },
  'fr-unclear': {
    label: 'French unclear booking question',
    message: "Bonjour, nous aimerions venir en août peut-être une semaine",
    language_hint: 'fr',
  },
  'cancel-refund': {
    label: 'Cancellation/refund request',
    message: 'I need to cancel my booking and get a refund',
    language_hint: 'en',
  },
  'payment-balance': {
    label: 'Payment/balance question',
    message: 'How much balance do I still owe on my booking?',
    language_hint: 'en',
  },
  'checkin-info': {
    label: 'Check-in/house info question',
    message: 'What time is check-in?',
    language_hint: 'en',
  },
  'general-random': {
    label: 'Random/general question',
    message: 'Do you allow pets at Wolfhouse?',
    language_hint: 'en',
  },
  'en-deposit-after-quote': {
    label: 'Deposit choice after quote (27k)',
    message: 'Deposit is fine',
    language_hint: 'en',
    guest_context: {
      message_lane: 'new_booking_inquiry',
      quote: {
        quote_status: 'ready',
        payment_choice_needed: true,
        quote_total_cents: 123456,
        deposit_options: { deposit_required_cents: 20000 },
      },
      payment_choice_needed: true,
    },
  },
  'en-full-after-quote': {
    label: 'Full payment choice after quote (27k)',
    message: "I'll pay the full amount",
    language_hint: 'en',
    guest_context: {
      message_lane: 'new_booking_inquiry',
      quote: {
        quote_status: 'ready',
        payment_choice_needed: true,
        quote_total_cents: 123456,
      },
      payment_choice_needed: true,
    },
  },
  'en-send-link-after-quote': {
    label: 'Send link after quote (27k)',
    message: 'Send me the link',
    language_hint: 'en',
    guest_context: {
      message_lane: 'new_booking_inquiry',
      quote: { quote_status: 'ready', payment_choice_needed: true },
      payment_choice_needed: true,
    },
  },
  'en-cash-arrival-after-quote': {
    label: 'Cash on arrival after quote (27k)',
    message: 'Can I pay cash when I arrive?',
    language_hint: 'en',
    guest_context: {
      message_lane: 'new_booking_inquiry',
      quote: { quote_status: 'ready', payment_choice_needed: true },
      payment_choice_needed: true,
    },
  },
};

function usage() {
  console.log(`
guest intake dry-run harness (Stage 27d)

  node scripts/run-guest-intake-dry-run.js [options]

Options:
  --base-url <url>       Staff API base (default: http://localhost:3000)
                         env STAFF_API_BASE_URL overrides default when set
  --message <text>       Guest message text (required unless --fixture)
  --language-hint <code> Optional en|it|es|de|fr
  --reference-date <iso> Optional YYYY-MM-DD for date parsing
  --guest-phone <e164>   Optional guest phone for context
  --guest-context-json <json>  Optional prior guest_context JSON (27k payment choice)
  --fixture <name>       Built-in example message (see list below)
  --json                 Print full JSON response
  --help                 Show this help

Fixtures:
${Object.keys(FIXTURES).map((k) => `  ${k.padEnd(16)} ${FIXTURES[k].label}`).join('\n')}

Auth:
  Set LUNA_BOT_INTERNAL_TOKEN in infra/.env or environment for bot token auth.
  Local dev: npm run staff:api (often http://127.0.0.1:3036) with open auth if configured.

Examples:
  npm run guest:intake:dry-run -- --base-url http://127.0.0.1:3036 --fixture en-booking
  npm run guest:intake:dry-run -- --fixture en-deposit-after-quote
  npm run guest:intake:dry-run -- --message "Deposit is fine" --guest-context-json '{"quote":{"quote_status":"ready","payment_choice_needed":true},"payment_choice_needed":true}'
`);
}

function parseArgs(argv) {
  const opts = {
    baseUrl: (process.env.STAFF_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
    message: null,
    languageHint: null,
    referenceDate: null,
    guestPhone: null,
    guestContextJson: null,
    json: false,
    fixture: null,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--base-url':
        opts.baseUrl = String(argv[++i] || '').replace(/\/$/, '');
        break;
      case '--message':
        opts.message = argv[++i];
        break;
      case '--language-hint':
        opts.languageHint = argv[++i];
        break;
      case '--reference-date':
        opts.referenceDate = argv[++i];
        break;
      case '--guest-phone':
        opts.guestPhone = argv[++i];
        break;
      case '--guest-context-json':
        opts.guestContextJson = argv[++i];
        break;
      case '--fixture':
        opts.fixture = argv[++i];
        break;
      case '--json':
        opts.json = true;
        break;
      default:
        console.error(`Unknown argument: ${a}`);
        opts.help = true;
        break;
    }
  }
  return opts;
}

function postJson(urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = JSON.stringify(body);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep string */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function redactBase(urlStr) {
  try {
    const u = new URL(urlStr);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(invalid-base-url)';
  }
}

function printSummary(apiBody) {
  const r = (apiBody && apiBody.result) || {};
  console.log('\n── guest intake dry-run summary ──');
  if (apiBody.fixture) console.log(`fixture:              ${apiBody.fixture}`);
  console.log(`HTTP success:         ${apiBody.success === true}`);
  console.log(`message_lane:         ${r.message_lane ?? '(n/a)'}`);
  console.log(`intake_state:         ${r.intake_state ?? '(n/a)'}`);
  console.log(`detected_language:    ${r.detected_language ?? '(n/a)'}`);
  console.log(`confidence:           ${r.confidence ?? '(n/a)'}`);
  console.log(`extracted_fields:     ${JSON.stringify(r.extracted_fields || {}, null, 2).split('\n').join('\n                      ')}`);
  console.log(`missing_required_fields: ${JSON.stringify(r.missing_required_fields || [])}`);
  console.log(`safe_handoff_required: ${r.safe_handoff_required === true}`);
  console.log(`handoff_reasons:      ${JSON.stringify(r.handoff_reasons || [])}`);
  console.log(`allowed_next_actions: ${JSON.stringify(r.allowed_next_actions || [])}`);
  console.log(`proposed_luna_reply:  ${r.proposed_luna_reply ?? '(n/a)'}`);
  const a = (apiBody && apiBody.availability) || {};
  if (apiBody.availability != null) {
    console.log('\n── availability dry-run (27g) ──');
    console.log(`availability_check_attempted: ${a.availability_check_attempted === true}`);
    console.log(`availability_status:         ${a.availability_status ?? '(n/a)'}`);
    console.log(`availability_result_summary: ${a.availability_result_summary ?? '(n/a)'}`);
    console.log(`availability_handoff_required: ${a.availability_handoff_required === true}`);
    console.log(`availability_handoff_reasons: ${JSON.stringify(a.availability_handoff_reasons || [])}`);
  }
  const q = (apiBody && apiBody.quote) || {};
  if (apiBody.quote != null) {
    console.log('\n── quote proposal dry-run (27i) ──');
    console.log(`quote_proposal_attempted: ${q.quote_proposal_attempted === true}`);
    console.log(`quote_status:              ${q.quote_status ?? '(n/a)'}`);
    console.log(`quote_total_cents:         ${q.quote_total_cents ?? '(n/a)'}`);
    console.log(`deposit_options:           ${q.deposit_options != null ? JSON.stringify(q.deposit_options) : '(n/a)'}`);
    console.log(`payment_choice_needed:     ${q.payment_choice_needed === true}`);
    console.log(`quote_handoff_required:    ${q.quote_handoff_required === true}`);
    console.log(`quote_handoff_reasons:     ${JSON.stringify(q.quote_handoff_reasons || [])}`);
  }
  const pc = (apiBody && apiBody.payment_choice) || {};
  if (apiBody.payment_choice != null) {
    console.log('\n── payment choice dry-run (27k) ──');
    console.log(`payment_choice_detected:   ${pc.payment_choice_detected === true}`);
    console.log(`payment_choice:            ${pc.payment_choice ?? '(n/a)'}`);
    console.log(`payment_choice_ready:      ${pc.payment_choice_ready === true}`);
    console.log(`next_safe_step:            ${pc.next_safe_step ?? '(n/a)'}`);
    console.log(`payment_choice_reasons:    ${JSON.stringify(pc.payment_choice_reasons || [])}`);
  }
  console.log('\n── safety flags ──');
  console.log(`dry_run:              ${apiBody.dry_run === true || r.dry_run === true}`);
  console.log(`sends_whatsapp:       ${apiBody.sends_whatsapp === false && (r.sends_whatsapp == null || r.sends_whatsapp === false)}`);
  console.log(`live_send_blocked:    ${apiBody.live_send_blocked === true || r.live_send_blocked === true}`);
  console.log(`no_write_performed:   ${apiBody.no_write_performed === true || r.no_write_performed === true}`);
  if (apiBody.auth_mode) console.log(`auth_mode:            ${apiBody.auth_mode}`);
  if (apiBody.elapsed_ms != null) console.log(`elapsed_ms:           ${apiBody.elapsed_ms}`);
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    usage();
    process.exit(0);
  }

  let message = opts.message;
  let languageHint = opts.languageHint;
  let guestContext = null;
  let fixtureLabel = null;

  if (opts.guestContextJson) {
    try {
      guestContext = JSON.parse(opts.guestContextJson);
    } catch (e) {
      console.error(`Error: invalid --guest-context-json: ${e.message}`);
      process.exit(1);
    }
  }

  if (opts.fixture) {
    const fx = FIXTURES[opts.fixture];
    if (!fx) {
      console.error(`Unknown fixture: ${opts.fixture}`);
      console.error(`Valid fixtures: ${Object.keys(FIXTURES).join(', ')}`);
      process.exit(1);
    }
    fixtureLabel = `${opts.fixture} (${fx.label})`;
    message = message || fx.message;
    languageHint = languageHint || fx.language_hint;
    if (fx.guest_context && !guestContext) guestContext = fx.guest_context;
  }

  if (!message || !String(message).trim()) {
    console.error('Error: --message or --fixture is required');
    usage();
    process.exit(1);
  }

  const payload = {
    message_text: String(message).trim(),
  };
  if (languageHint) payload.language_hint = languageHint;
  if (opts.referenceDate) payload.reference_date = opts.referenceDate;
  if (opts.guestPhone) payload.guest_phone = opts.guestPhone;
  if (guestContext) payload.guest_context = guestContext;

  const target = `${opts.baseUrl}${ROUTE}`;
  const headers = {};
  if (TOKEN) headers['X-Luna-Bot-Token'] = TOKEN;

  console.log(`POST ${redactBase(opts.baseUrl)}${ROUTE}`);
  if (fixtureLabel) console.log(`fixture: ${fixtureLabel}`);
  if (!TOKEN) {
    console.log('note: LUNA_BOT_INTERNAL_TOKEN not set — using open local auth if enabled');
  }

  let res;
  try {
    res = await postJson(target, payload, headers);
  } catch (e) {
    console.error('FAIL — request error:', e.message);
    console.error('hint: is Staff API running? try --base-url http://127.0.0.1:3036');
    process.exit(1);
  }

  const body = typeof res.body === 'object' ? res.body : { success: false, error: res.raw };
  if (fixtureLabel) body.fixture = fixtureLabel;

  if (opts.json) {
    console.log(JSON.stringify(body, null, 2));
  } else {
    printSummary(body);
  }

  if (res.status === 401 && !TOKEN) {
    console.error('\nFAIL — HTTP 401: set LUNA_BOT_INTERNAL_TOKEN for staging/authenticated hosts');
    process.exit(1);
  }

  if (res.status !== 200 || body.success !== true) {
    const err = body.error || res.raw;
    console.error(`\nFAIL — HTTP ${res.status}${err ? `: ${err}` : ''}`);
    process.exit(1);
  }

  const r = body.result || {};
  if (r.sends_whatsapp !== false || r.live_send_blocked !== true) {
    console.error('\nFAIL — result missing expected safety flags (sends_whatsapp:false, live_send_blocked:true)');
    process.exit(1);
  }

  console.log('\nPASS — guest intake dry-run harness');
}

main().catch((e) => {
  console.error('FAIL —', e.message);
  process.exit(1);
});
