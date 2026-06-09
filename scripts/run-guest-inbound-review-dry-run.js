/**
 * Stage 27x.1 — Inbound guest review dry-run CLI harness.
 *
 * Exercises POST /staff/bot/guest-inbound-review-dry-run with n8n-shaped payloads.
 * Review-only: no hold/draft writes, no Stripe, no WhatsApp send.
 *
 * Usage:
 *   node scripts/run-guest-inbound-review-dry-run.js --message "Hi, we are 2 people..."
 *   node scripts/run-guest-inbound-review-dry-run.js --fixture booking-turn-1
 *   node scripts/run-guest-inbound-review-dry-run.js --fixture booking-turn-1 --fixture booking-turn-2
 *   npm run luna:guest-inbound:review -- --fixture booking-turn-1
 *
 * Auth: LUNA_BOT_INTERNAL_TOKEN → X-Luna-Bot-Token (infra/.env or environment).
 */

'use strict';

const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const REVIEW_ROUTE = '/staff/bot/guest-inbound-review-dry-run';
const TOKEN = process.env.LUNA_BOT_INTERNAL_TOKEN || '';

const FIXTURES = {
  'booking-turn-1': {
    label: 'Turn 1 — package interest',
    message: 'Hi, we are 2 people interested in the Malibu package',
  },
  'booking-turn-2': {
    label: 'Turn 2 — dates',
    message: 'July 10 to July 17',
  },
  'payment-turn': {
    label: 'Turn 3 — payment choice',
    message: 'Deposit is fine',
  },
};

function usage() {
  console.log(`Usage: node scripts/run-guest-inbound-review-dry-run.js [options]

Options:
  --base-url URL          Default STAFF_API_BASE_URL or http://127.0.0.1:3036
  --client-slug SLUG      Default wolfhouse-somo
  --channel CHANNEL       Default whatsapp
  --phone PHONE           Default +34600999997
  --message TEXT          Inbound guest message (required unless --fixture)
  --fixture NAME          Fixture turn (${Object.keys(FIXTURES).join(', ')})
  --reference-date DATE   Default 2026-06-08
  --inbound-message-id ID Optional Meta wamid / harness id
  --conversation-id UUID  Optional existing conversation
  --json                  Print full JSON response only
  --help                  Show this help

Fixtures chain guest_context automatically when multiple --fixture flags are passed.
Review-only — no hold/draft/Stripe writes.`);
}

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.STAFF_API_BASE_URL || 'http://127.0.0.1:3036',
    clientSlug: 'wolfhouse-somo',
    channel: 'whatsapp',
    phone: '+34600999997',
    referenceDate: '2026-06-08',
    fixtures: [],
    message: null,
    inboundMessageId: null,
    conversationId: null,
    json: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--base-url') opts.baseUrl = argv[++i];
    else if (a === '--client-slug') opts.clientSlug = argv[++i];
    else if (a === '--channel') opts.channel = argv[++i];
    else if (a === '--phone') opts.phone = argv[++i];
    else if (a === '--message') opts.message = argv[++i];
    else if (a === '--fixture') opts.fixtures.push(argv[++i]);
    else if (a === '--reference-date') opts.referenceDate = argv[++i];
    else if (a === '--inbound-message-id') opts.inboundMessageId = argv[++i];
    else if (a === '--conversation-id') opts.conversationId = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      usage();
      process.exit(1);
    }
  }

  return opts;
}

function postJson(urlStr, payload, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const body = JSON.stringify(payload);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildPayload(opts, messageText, guestContext, turnIndex) {
  const payload = {
    source: 'harness_inbound_review',
    client_slug: opts.clientSlug,
    channel: opts.channel,
    guest_phone: opts.phone,
    message_text: messageText,
    reference_date: opts.referenceDate,
    received_at: new Date().toISOString(),
    automation_gate_context: {
      public_guest_automation_enabled: false,
      whatsapp_dry_run: true,
      live_send_allowed: false,
    },
  };
  if (opts.inboundMessageId) {
    payload.inbound_message_id = opts.inboundMessageId;
  } else {
    payload.inbound_message_id = `harness-${Date.now()}-turn${turnIndex + 1}`;
  }
  if (opts.conversationId) payload.conversation_id = opts.conversationId;
  if (guestContext) payload.guest_context = guestContext;
  return payload;
}

function summarizeResponse(body) {
  const r = (body && body.review) || {};
  const res = r.result || {};
  return {
    success: body.success === true,
    dry_run: body.dry_run === true,
    sends_whatsapp: body.sends_whatsapp === false,
    live_send_blocked: body.live_send_blocked === true,
    no_write_performed: body.no_write_performed === true,
    idempotent_replay: body.idempotent_replay === true,
    review_persistence_performed: body.review_persistence_performed === true,
    conversation_id: body.conversation_id || null,
    idempotency_key: body.idempotency_key || null,
    proposed_luna_reply: r.proposed_luna_reply || null,
    proposed_next_action: r.proposed_next_action || null,
    message_lane: res.message_lane || null,
    booking_intake_ready: res.booking_intake_ready ?? null,
    quote_status: r.quote && r.quote.quote_status,
    payment_choice: r.payment_choice && r.payment_choice.payment_choice,
  };
}

async function runTurn(opts, headers, messageText, guestContext, turnIndex, label) {
  const target = `${opts.baseUrl.replace(/\/$/, '')}${REVIEW_ROUTE}`;
  const payload = buildPayload(opts, messageText, guestContext, turnIndex);
  const res = await postJson(target, payload, headers);
  const body = typeof res.body === 'object' ? res.body : { success: false, error: res.raw };
  body._http_status = res.status;

  if (opts.json) {
    console.log(JSON.stringify(body, null, 2));
    return { body, ok: body.success === true && res.status === 200 };
  }

  console.log(`\n── ${label || `Turn ${turnIndex + 1}`} ──`);
  console.log(`POST ${target}`);
  console.log(`message: ${messageText}`);
  const summary = summarizeResponse(body);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.success) {
    console.log('error:', body.error || '(unknown)');
  }

  return {
    body,
    ok: body.success === true && res.status === 200,
    nextContext: body.slim_guest_context_for_next_turn || null,
    conversationId: body.conversation_id || opts.conversationId || null,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    usage();
    process.exit(0);
  }

  const headers = {};
  if (TOKEN) headers['X-Luna-Bot-Token'] = TOKEN;

  const turns = [];
  if (opts.fixtures.length > 0) {
    for (const fxName of opts.fixtures) {
      const fx = FIXTURES[fxName];
      if (!fx) {
        console.error(`Unknown fixture: ${fxName}`);
        console.error(`Valid fixtures: ${Object.keys(FIXTURES).join(', ')}`);
        process.exit(1);
      }
      turns.push({ message: fx.message, label: `${fxName}: ${fx.label}` });
    }
  } else if (opts.message) {
    turns.push({ message: opts.message, label: 'Single message' });
  } else {
    console.error('Error: --message or --fixture is required');
    usage();
    process.exit(1);
  }

  if (!TOKEN && !opts.json) {
    console.warn('Warning: LUNA_BOT_INTERNAL_TOKEN not set — endpoint may reject without bot auth.');
  }

  let guestContext = null;
  let conversationId = opts.conversationId;
  let allOk = true;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const runOpts = { ...opts, conversationId };
    const result = await runTurn(runOpts, headers, turn.message, guestContext, i, turn.label);
    if (!result.ok) allOk = false;
    guestContext = result.nextContext || guestContext;
    conversationId = result.conversationId || conversationId;
  }

  if (!opts.json) {
    console.log(`\n${allOk ? 'PASS' : 'FAIL'} — inbound guest review dry-run harness`);
  }
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
