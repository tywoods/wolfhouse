/**
 * Stage 27demo-b/c/d — Open demo WhatsApp inbound dry-run harness.
 *
 * Exercises POST /staff/bot/open-demo-whatsapp-inbound-dry-run with n8n-shaped payloads.
 * Review-only by default; optional live reply (27demo-c) or hold/draft write (27demo-d).
 *
 * Usage:
 *   node scripts/run-open-demo-whatsapp-inbound-dry-run.js --fixture booking-turn-1
 *   node scripts/run-open-demo-whatsapp-inbound-dry-run.js --fixture booking-deposit-write-clean --create-demo-hold-draft-confirmed --assign-demo-bed-confirmed
 *   node scripts/run-open-demo-whatsapp-inbound-dry-run.js --base-url https://staff-staging.lunafrontdesk.com --fixture package-question
 */

'use strict';

const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const { OPEN_DEMO_WHATSAPP_ROUTE } = require('./lib/open-demo-whatsapp-gate');

const TOKEN = process.env.LUNA_BOT_INTERNAL_TOKEN || '';

const CLEAN_PROOF_GUEST_PHONE = '+34600995556';

function guestEmailFromPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return `open-demo+${digits}@example.test`;
}

function applyCleanProofDefaults(opts) {
  const usesClean = opts.fixtures.some((name) => {
    const fx = FIXTURES[name];
    return fx && (fx.cleanProof === true || name === 'booking-deposit-write-clean');
  });
  if (!usesClean) return;
  if (opts.guestPhone === '+34600995555') opts.guestPhone = CLEAN_PROOF_GUEST_PHONE;
  if (opts.guestEmail === 'open-demo+34600995555@example.test') {
    opts.guestEmail = guestEmailFromPhone(opts.guestPhone);
  }
}

const FIXTURES = {
  'booking-turn-1': {
    label: 'Turn 1 — package interest',
    message: 'Hi, we are 2 people interested in the Malibu package',
  },
  'booking-turn-2': {
    label: 'Turn 2 — dates',
    message: 'July 10 to July 17',
  },
  'booking-deposit-write': {
    label: '3-turn booking to deposit (composite)',
    composite: ['booking-turn-1', 'booking-turn-2', 'deposit-choice'],
  },
  'booking-turn-1-clean': {
    label: 'Turn 1 — package interest (clean proof)',
    message: 'Hi, we are 2 people interested in the Malibu package',
  },
  'booking-turn-2-clean': {
    label: 'Turn 2 — clean hosted proof dates',
    message: 'August 18 to August 25',
  },
  'booking-deposit-write-clean': {
    label: '3-turn booking to deposit — clean hosted proof window',
    composite: ['booking-turn-1-clean', 'booking-turn-2-clean', 'deposit-choice'],
    cleanProof: true,
  },
  'deposit-choice': {
    label: 'Turn 3 — deposit choice',
    message: 'Deposit is fine',
  },
  'package-question': {
    label: 'Package explainer',
    message: 'What are the packages?',
  },
  'transfer-question': {
    label: 'Transfer side question',
    message: 'Transfer from Bilbao airport',
  },
};

function usage() {
  console.log(`Usage: node scripts/run-open-demo-whatsapp-inbound-dry-run.js [options]

Options:
  --base-url URL            Default STAFF_API_BASE_URL or http://127.0.0.1:3036
  --client-slug SLUG        Default wolfhouse-somo
  --phone-number-id ID      Default demo-local (omit on staging if env gate unset)
  --guest-phone PHONE       Default +34600995555
  --message TEXT            Inbound message (required unless --fixture)
  --fixture NAME            ${Object.keys(FIXTURES).join(', ')}
  booking-deposit-write-clean uses +34600995556 and Aug 18–25 by default (hosted d.1 proof)
  --wamid ID                Optional Meta wamid (generated if omitted)
  --contact-name NAME       Optional WhatsApp profile name
  --reference-date DATE     Default 2026-06-08
  --send-live-reply-confirmed  Request gated live WhatsApp send (27demo-c; default off)
  --create-demo-hold-draft-confirmed  Request gated hold/draft write on final turn (27demo-d)
  --assign-demo-bed-confirmed  Request demo bed assignment after hold write (27demo-d.1)
  --guest-email EMAIL       Optional guest email (required for hold/draft write)
  --json                    Print full JSON response only
  --help                    Show this help

Requires OPEN_DEMO_WHATSAPP_ENABLED=true on the target Staff API.
Hold/draft write additionally requires OPEN_DEMO_BOOKING_WRITES_ENABLED=true (staging only).
Review-only by default — no live send / Stripe link / confirmation.`);
}

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.STAFF_API_BASE_URL || 'http://127.0.0.1:3036',
    clientSlug: 'wolfhouse-somo',
    phoneNumberId: 'demo-local',
    guestPhone: '+34600995555',
    referenceDate: '2026-06-08',
    fixtures: [],
    message: null,
    wamid: null,
    contactName: null,
    sendLiveReplyConfirmed: false,
    createDemoHoldDraftConfirmed: false,
    assignDemoBedConfirmed: false,
    guestEmail: 'open-demo+34600995555@example.test',
    json: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--send-live-reply-confirmed') opts.sendLiveReplyConfirmed = true;
    else if (a === '--create-demo-hold-draft-confirmed') opts.createDemoHoldDraftConfirmed = true;
    else if (a === '--assign-demo-bed-confirmed') opts.assignDemoBedConfirmed = true;
    else if (a === '--guest-email') opts.guestEmail = argv[++i];
    else if (a === '--base-url') opts.baseUrl = argv[++i];
    else if (a === '--client-slug') opts.clientSlug = argv[++i];
    else if (a === '--phone-number-id') opts.phoneNumberId = argv[++i];
    else if (a === '--guest-phone') opts.guestPhone = argv[++i];
    else if (a === '--message') opts.message = argv[++i];
    else if (a === '--fixture') opts.fixtures.push(argv[++i]);
    else if (a === '--wamid') opts.wamid = argv[++i];
    else if (a === '--contact-name') opts.contactName = argv[++i];
    else if (a === '--reference-date') opts.referenceDate = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      usage();
      process.exit(1);
    }
  }

  return opts;
}

function expandFixtures(names) {
  const turns = [];
  for (const name of names) {
    const fx = FIXTURES[name];
    if (!fx) return { error: name };
    if (fx.composite) {
      for (const sub of fx.composite) {
        const subFx = FIXTURES[sub];
        if (!subFx) return { error: sub };
        turns.push({ message: subFx.message, label: `${sub}: ${subFx.label}`, fixtureName: sub });
      }
    } else {
      turns.push({ message: fx.message, label: `${name}: ${fx.label}`, fixtureName: name });
    }
  }
  return { turns };
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

function buildPayload(opts, messageText, guestContext, turnIndex, isLastTurn) {
  const wamid = opts.wamid && turnIndex === 0
    ? opts.wamid
    : `wamid.demo-${Date.now()}-turn${turnIndex + 1}`;
  const payload = {
    source: 'n8n_open_demo_whatsapp_harness',
    client_slug: opts.clientSlug,
    channel: 'whatsapp',
    phone_number_id: opts.phoneNumberId,
    guest_phone: opts.guestPhone,
    message_text: messageText,
    wamid,
    inbound_message_id: wamid,
    received_at: new Date().toISOString(),
    reference_date: opts.referenceDate,
  };
  if (opts.contactName) payload.contact_name = opts.contactName;
  if (opts.guestEmail) payload.guest_email = opts.guestEmail;
  if (guestContext) payload.guest_context = guestContext;
  if (opts.sendLiveReplyConfirmed) payload.send_live_reply_confirmed = true;
  if (opts.createDemoHoldDraftConfirmed && isLastTurn) {
    payload.create_demo_hold_draft_confirmed = true;
  }
  if (opts.assignDemoBedConfirmed && isLastTurn) {
    payload.assign_demo_bed_confirmed = true;
  }
  return payload;
}

function summarizeResponse(body) {
  const r = (body && body.review) || {};
  const res = r.result || {};
  const pc = r.payment_choice || {};
  const plan = r.hold_payment_draft_plan || {};
  return {
    http_ok: body.success === true,
    open_demo: body.open_demo === true,
    dry_run: body.dry_run === true,
    sends_whatsapp: body.sends_whatsapp === false,
    live_send_blocked: body.live_send_blocked === true,
    whatsapp_sent: body.whatsapp_sent === true,
    send_live_reply_confirmed: body.send_live_reply_confirmed === true,
    create_demo_hold_draft_confirmed: body.create_demo_hold_draft_confirmed === true,
    assign_demo_bed_confirmed: body.assign_demo_bed_confirmed === true,
    assignment_write_status: body.assignment_write_status || null,
    assigned_bed_label: body.assigned_bed_label || null,
    assigned_room_label: body.assigned_room_label || null,
    calendar_visible_expected: body.calendar_visible_expected === true,
    live_reply_gate_code: body.live_reply_gate_code || null,
    demo_booking_write_gate_code: body.demo_booking_write_gate_code || null,
    write_status: body.write_status || null,
    booking_code: body.booking_code || null,
    booking_id: body.booking_id || null,
    payment_draft_id: body.payment_draft_id || null,
    next_safe_step: body.next_safe_step || pc.next_safe_step || null,
    payment_choice_ready: pc.payment_choice_ready === true,
    hold_plan_status: plan.plan_status || null,
    stripe_link_created: body.stripe_link_created === false,
    demo_gate_blocked: body.demo_gate_blocked === true,
    review_persistence_performed: body.review_persistence_performed === true,
    conversation_id: body.conversation_id || null,
    proposed_luna_reply: (r.proposed_luna_reply || '').slice(0, 200),
    proposed_next_action: r.proposed_next_action || null,
    message_lane: res.message_lane || null,
  };
}

async function runTurn(opts, headers, messageText, guestContext, turnIndex, label, isLastTurn) {
  const target = `${opts.baseUrl.replace(/\/$/, '')}${OPEN_DEMO_WHATSAPP_ROUTE}`;
  const payload = buildPayload(opts, messageText, guestContext, turnIndex, isLastTurn);
  const res = await postJson(target, payload, headers);
  const body = typeof res.body === 'object' ? res.body : { success: false, error: res.raw };

  if (opts.json) {
    console.log(JSON.stringify({ http_status: res.status, ...body }, null, 2));
    return { body, ok: body.success === true && res.status === 200 };
  }

  console.log(`\n── ${label || `Turn ${turnIndex + 1}`} ──`);
  console.log(`POST ${target}`);
  console.log(`message: ${messageText}`);
  if (payload.create_demo_hold_draft_confirmed) {
    console.log('create_demo_hold_draft_confirmed: true');
  }
  if (payload.assign_demo_bed_confirmed) {
    console.log('assign_demo_bed_confirmed: true');
  }
  console.log(JSON.stringify(summarizeResponse(body), null, 2));
  if (res.status !== 200) console.log(`HTTP ${res.status}`, body.error || '');

  return {
    body,
    ok: body.success === true && res.status === 200,
    nextContext: body.slim_guest_context_for_next_turn || null,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    usage();
    process.exit(0);
  }

  applyCleanProofDefaults(opts);

  const headers = {};
  if (TOKEN) headers['X-Luna-Bot-Token'] = TOKEN;

  let turns = [];
  if (opts.fixtures.length > 0) {
    const expanded = expandFixtures(opts.fixtures);
    if (expanded.error) {
      console.error(`Unknown fixture: ${expanded.error}`);
      process.exit(1);
    }
    turns = expanded.turns;
  } else if (opts.message) {
    turns.push({ message: opts.message, label: 'Single message' });
  } else {
    console.error('Error: --message or --fixture is required');
    usage();
    process.exit(1);
  }

  if (!TOKEN && !opts.json) {
    console.warn('Warning: LUNA_BOT_INTERNAL_TOKEN not set — endpoint requires bot auth.');
  }

  let guestContext = null;
  let allOk = true;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const isLastTurn = i === turns.length - 1;
    const result = await runTurn(opts, headers, turn.message, guestContext, i, turn.label, isLastTurn);
    if (!result.ok) allOk = false;
    guestContext = result.nextContext || guestContext;
  }

  if (!opts.json) {
    console.log(`\n${allOk ? 'PASS' : 'FAIL'} — open demo WhatsApp inbound dry-run harness`);
  }
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

module.exports = { FIXTURES, buildPayload, expandFixtures, guestEmailFromPhone, applyCleanProofDefaults };
