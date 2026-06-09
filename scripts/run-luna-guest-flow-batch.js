/**
 * Stage 27test-d — Multi-turn Luna guest booking flow batch runner.
 *
 * Runs curated multi-turn conversations through guest-automation-review-dry-run
 * (simulator path) or guest-inbound-review-dry-run (inbound idempotency flows).
 * Default: review-only — no hold/draft, Stripe, WhatsApp, Meta, or n8n.
 *
 * Usage:
 *   npm run luna:guest-flow-batch -- --fixture-set booking-core --count 10
 *   npm run luna:guest-flow-batch -- --local --json
 *   npm run luna:guest-flow-batch -- --base-url https://staff-staging.lunafrontdesk.com --count 5
 *   npm run luna:guest-flow-batch -- --fixture flow-en-malibu-deposit --create-hold-draft
 */

'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { runGuestInboundReviewDryRun } = require('./lib/luna-guest-inbound-review-dry-run');
const { withPgClient } = require('./lib/pg-connect');

const BANNED_REPLY_TERMS = [
  'confirmed quote', 'payment choice', 'payment_choice', 'quote_status',
  'guest_context', 'intake_state', 'readiness_state', 'automation gate',
  'next_safe_step', 'dry run', 'idempotency', 'webhook',
];

const TECHNICAL_HANDOFF_REASONS = new Set([
  'booking_intake_not_ready',
  'availability_not_available',
  'quote_not_ready',
  'quote_payment_choice_not_needed',
]);

function filterRealHandoffReasons(review) {
  const reasons = Array.isArray(review.handoff_reasons) ? review.handoff_reasons : [];
  const availability = review.availability || {};
  const quote = review.quote || {};
  return reasons.filter((r) => {
    if (TECHNICAL_HANDOFF_REASONS.has(r)) return false;
    if (r === 'availability_not_available' && availability.availability_check_attempted !== true) return false;
    if (r === 'quote_not_ready' && quote.quote_proposal_attempted !== true) return false;
    return true;
  });
}

function isStaffHandoffRequired(review, result) {
  if (result && result.safe_handoff_required === true) return true;
  if (review && review.proposed_next_action === 'staff_handoff_required') return true;
  const gate = (review && review.automation_gate) || {};
  if (gate.gate_status === 'blocked' || gate.gate_status === 'staff_handoff') return true;
  return filterRealHandoffReasons(review || {}).length > 0;
}

function findBannedTerms(reply) {
  const text = String(reply || '').toLowerCase();
  return BANNED_REPLY_TERMS.filter((term) => text.includes(term.toLowerCase()));
}

function checkSafetyFlags(body) {
  const failures = [];
  if (body.dry_run !== true) failures.push(`dry_run expected true got ${body.dry_run}`);
  if (body.sends_whatsapp !== false) failures.push(`sends_whatsapp expected false got ${body.sends_whatsapp}`);
  if (body.live_send_blocked !== true) failures.push(`live_send_blocked expected true got ${body.live_send_blocked}`);
  if (body.no_write_performed !== true) failures.push(`no_write_performed expected true got ${body.no_write_performed}`);
  return failures;
}

const SIM_REVIEW_ROUTE = '/staff/bot/guest-automation-review-dry-run';
const INBOUND_REVIEW_ROUTE = '/staff/bot/guest-inbound-review-dry-run';
const HOLD_ROUTE = '/staff/bot/guest-simulator-create-hold-draft';
const STRIPE_ROUTE = '/staff/bot/guest-simulator-create-stripe-test-link';
const DEFAULT_FIXTURE = path.join(__dirname, 'fixtures', 'luna-guest-flow-batch.json');
const CLIENT_SLUG = 'wolfhouse-somo';
const TOKEN = process.env.LUNA_BOT_INTERNAL_TOKEN || '';

const REASK_PATTERNS = {
  guest_count: /how many guests|how many people|quanti ospiti|cuántas personas|wie viele gäste|combien de personnes/i,
  dates: /what dates|which dates|check-in|check-out|check in|check out|qué fechas|quali date|welche daten|quelles dates/i,
  package_interest: /which package|what package|quale pacchetto|qué paquete|welches paket|quel forfait/i,
};

function usage() {
  console.log(`Usage: node scripts/run-luna-guest-flow-batch.js [options]

Options:
  --base-url URL           Default STAFF_API_BASE_URL or http://127.0.0.1:3036
  --local                  Force local orchestrator path (requires DATABASE_URL for availability)
  --endpoint               Force HTTP endpoint mode
  --count N                Run first N flows after filters
  --fixture-set NAME       Default booking-core
  --fixture ID             Run single flow by id
  --json                   Print JSON report only
  --fail-fast              Stop on first flow failure
  --create-hold-draft      Run hold/draft write for write_eligible flows only
  --create-stripe-test-link  Also create Stripe TEST link (requires --create-hold-draft)
  --phone-prefix PREFIX    Default +34600998 (flow index appended)
  --reference-date DATE    Default 2026-06-08
  --help                   Show this help

Default run is review-only — no hold/draft, Stripe, WhatsApp, Meta, or n8n.`);
}

function parseArgs(argv) {
  const opts = {
    baseUrl: (process.env.STAFF_API_BASE_URL || 'http://127.0.0.1:3036').replace(/\/$/, ''),
    local: false,
    endpoint: false,
    count: null,
    fixtureSet: 'booking-core',
    fixtureId: null,
    json: false,
    failFast: false,
    createHoldDraft: false,
    createStripeTestLink: false,
    phonePrefix: '+34600998',
    referenceDate: '2026-06-08',
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--local') opts.local = true;
    else if (a === '--endpoint') opts.endpoint = true;
    else if (a === '--fail-fast') opts.failFast = true;
    else if (a === '--create-hold-draft') opts.createHoldDraft = true;
    else if (a === '--create-stripe-test-link') opts.createStripeTestLink = true;
    else if (a === '--base-url') opts.baseUrl = String(argv[++i] || '').replace(/\/$/, '');
    else if (a === '--count') opts.count = parseInt(argv[++i], 10);
    else if (a === '--fixture-set') opts.fixtureSet = argv[++i];
    else if (a === '--fixture') opts.fixtureId = argv[++i];
    else if (a === '--phone-prefix') opts.phonePrefix = argv[++i];
    else if (a === '--reference-date') opts.referenceDate = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      usage();
      process.exit(1);
    }
  }
  return opts;
}

function loadFixtureFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.flows)) {
    throw new Error('fixture file must contain flows[]');
  }
  return data;
}

function filterFlows(data, opts) {
  let flows = data.flows.slice();
  if (opts.fixtureSet) {
    flows = flows.filter((f) => f.fixture_set === opts.fixtureSet);
  }
  if (opts.fixtureId) {
    flows = flows.filter((f) => f.id === opts.fixtureId);
  }
  if (opts.count != null && opts.count > 0) {
    flows = flows.slice(0, opts.count);
  }
  return flows;
}

function resolveMode(opts) {
  if (opts.local) return 'local';
  if (opts.endpoint) return 'endpoint';
  return TOKEN ? 'endpoint' : 'local';
}

function assertNotProduction(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (/^staff\.lunafrontdesk\.com$/i.test(host)) {
      throw new Error(`production host blocked: ${host}`);
    }
    if (host.includes('lunafrontdesk.com') && !host.includes('staging') && !host.includes('staff-staging')) {
      throw new Error(`production host blocked: ${host}`);
    }
  } catch (e) {
    if (e.message && e.message.includes('production host blocked')) throw e;
    throw new Error(`invalid --base-url: ${baseUrl}`);
  }
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
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function guestContextFromReview(apiBody) {
  const r = (apiBody && apiBody.review) || {};
  return {
    message_lane: r.result && r.result.message_lane,
    intake_state: r.result && r.result.intake_state,
    readiness_state: r.result && r.result.readiness_state,
    booking_intake_ready: r.result && r.result.booking_intake_ready,
    extracted_fields: r.result && r.result.extracted_fields,
    result: r.result,
    availability: r.availability,
    quote: r.quote,
    payment_choice_needed: r.quote && r.quote.payment_choice_needed,
    payment_choice: r.payment_choice,
    hold_payment_draft_plan: r.hold_payment_draft_plan,
    detected_language: r.result && r.result.detected_language,
  };
}

function wrapOrchestratorAsReviewBody(orchOut) {
  return {
    success: orchOut.success !== false,
    dry_run: true,
    sends_whatsapp: false,
    live_send_blocked: true,
    no_write_performed: true,
    review: {
      automation_gate: orchOut.automation_gate,
      proposed_next_action: orchOut.proposed_next_action,
      proposed_luna_reply: orchOut.proposed_luna_reply,
      result: orchOut.result,
      availability: orchOut.availability,
      quote: orchOut.quote,
      payment_choice: orchOut.payment_choice,
      hold_payment_draft_plan: orchOut.hold_payment_draft_plan,
      handoff_reasons: [],
    },
  };
}

function buildSimulatorPayload(opts, flow, message, guestContext, phone) {
  return {
    client_slug: CLIENT_SLUG,
    channel: flow.channel || 'staff_review',
    message_text: message,
    dry_run: true,
    reference_date: opts.referenceDate,
    guest_phone: phone,
    language_hint: flow.language,
    guest_context: guestContext || undefined,
    automation_gate_context: {
      public_guest_automation_enabled: false,
      whatsapp_dry_run: true,
      live_send_allowed: false,
    },
  };
}

function buildInboundPayload(opts, flow, turn, message, guestContext, phone, inboundMessageId) {
  return {
    source: 'flow_batch_runner',
    client_slug: CLIENT_SLUG,
    channel: 'whatsapp',
    guest_phone: phone,
    message_text: message,
    reference_date: opts.referenceDate,
    language_hint: flow.language,
    received_at: new Date().toISOString(),
    inbound_message_id: inboundMessageId,
    guest_context: guestContext || undefined,
    automation_gate_context: {
      public_guest_automation_enabled: false,
      whatsapp_dry_run: true,
      live_send_allowed: false,
    },
  };
}

async function runSimulatorLocal(payload) {
  const input = {
    client_slug: payload.client_slug,
    channel: payload.channel,
    message_text: payload.message_text,
    guest_phone: payload.guest_phone,
    language_hint: payload.language_hint,
    guest_context: payload.guest_context,
    reference_date: payload.reference_date,
    automation_gate_context: payload.automation_gate_context,
    dry_run: true,
  };
  const orchOut = await withPgClient((pg) => runGuestAutomationOrchestratorDryRun(input, {
    reference_date: payload.reference_date,
    guest_phone: payload.guest_phone,
    dry_run: true,
    pg,
  }));
  return { http_status: 200, body: wrapOrchestratorAsReviewBody(orchOut) };
}

async function runSimulatorEndpoint(opts, payload, headers) {
  const target = `${opts.baseUrl}${SIM_REVIEW_ROUTE}`;
  const res = await postJson(target, payload, headers);
  const body = typeof res.body === 'object' ? res.body : { success: false, error: res.raw };
  return { http_status: res.status, body };
}

async function runInboundLocal(payload) {
  const outcome = await runGuestInboundReviewDryRun(payload, {});
  return {
    http_status: outcome.status || (outcome.ok ? 200 : 400),
    body: outcome.body || outcome,
  };
}

async function runInboundEndpoint(opts, payload, headers) {
  const target = `${opts.baseUrl}${INBOUND_REVIEW_ROUTE}`;
  const res = await postJson(target, payload, headers);
  const body = typeof res.body === 'object' ? res.body : { success: false, error: res.raw };
  return { http_status: res.status, body };
}

function shouldRunTurn(turn, priorReview) {
  if (!turn.conditional) return true;
  if (turn.conditional === 'quote_payment_choice_needed') {
    return !!(priorReview && priorReview.quote && priorReview.quote.payment_choice_needed === true);
  }
  return true;
}

function checkMustNotReask(reply, fields, mustNotReask) {
  const failures = [];
  if (!Array.isArray(mustNotReask)) return failures;
  const extracted = fields || {};
  for (const field of mustNotReask) {
    const pattern = REASK_PATTERNS[field];
    if (!pattern) continue;
    if (field === 'guest_count' && extracted.guest_count != null) {
      if (pattern.test(reply)) failures.push(`must_not_reask ${field} but reply asks again`);
    } else if (field === 'dates' && extracted.check_in && extracted.check_out) {
      if (pattern.test(reply)) failures.push(`must_not_reask ${field} but reply asks again`);
    } else if (field === 'package_interest' && extracted.package_interest) {
      if (pattern.test(reply)) failures.push(`must_not_reask ${field} but reply asks again`);
    }
  }
  return failures;
}

function isFlowHandoffRequired(review, result, expected) {
  if (expected && expected.handoff_required === false) {
    const pc = review.payment_choice || {};
    if (pc.payment_choice_ready === true) return false;
    if (result.message_lane === 'general_question'
        && review.proposed_next_action !== 'staff_handoff_required') {
      return false;
    }
  }
  return isStaffHandoffRequired(review, result);
}

function checkFlowExpectations(expected, body, priorReview) {
  const failures = [];
  if (!expected || typeof expected !== 'object') return failures;

  const review = body.review || {};
  const result = review.result || {};
  const reply = review.proposed_luna_reply || '';
  const availability = review.availability || {};
  const quote = review.quote || {};
  const paymentChoice = review.payment_choice || {};
  const plan = review.hold_payment_draft_plan || {};

  if (expected.message_lane != null && result.message_lane !== expected.message_lane) {
    failures.push(`message_lane expected ${expected.message_lane} got ${result.message_lane}`);
  }
  if (expected.booking_intake_ready != null && result.booking_intake_ready !== expected.booking_intake_ready) {
    failures.push(`booking_intake_ready expected ${expected.booking_intake_ready} got ${result.booking_intake_ready}`);
  }
  if (expected.handoff_required != null) {
    const actual = isFlowHandoffRequired(review, result, expected);
    if (actual !== expected.handoff_required) {
      failures.push(`handoff_required expected ${expected.handoff_required} got ${actual}`);
    }
  }
  if (expected.proposed_next_action != null && review.proposed_next_action !== expected.proposed_next_action) {
    failures.push(`proposed_next_action expected ${expected.proposed_next_action} got ${review.proposed_next_action}`);
  }
  if (expected.quote_status != null
      && !(expected.payment_choice_ready === true && paymentChoice.payment_choice_ready === true)
      && quote.quote_status !== expected.quote_status) {
    failures.push(`quote_status expected ${expected.quote_status} got ${quote.quote_status}`);
  }
  if (expected.payment_choice_ready != null && paymentChoice.payment_choice_ready !== expected.payment_choice_ready) {
    failures.push(`payment_choice_ready expected ${expected.payment_choice_ready} got ${paymentChoice.payment_choice_ready}`);
  }
  if (expected.payment_choice != null && paymentChoice.payment_choice !== expected.payment_choice) {
    failures.push(`payment_choice expected ${expected.payment_choice} got ${paymentChoice.payment_choice}`);
  }
  if (expected.availability_check_attempted != null
      && availability.availability_check_attempted !== expected.availability_check_attempted) {
    failures.push(`availability_check_attempted expected ${expected.availability_check_attempted} got ${availability.availability_check_attempted}`);
  }
  if (expected.availability_status != null && availability.availability_status !== expected.availability_status) {
    failures.push(`availability_status expected ${expected.availability_status} got ${availability.availability_status}`);
  }
  if (expected.hold_plan_status != null && plan.plan_status !== expected.hold_plan_status) {
    failures.push(`hold_plan_status expected ${expected.hold_plan_status} got ${plan.plan_status}`);
  }
  if (expected.idempotent_replay != null && body.idempotent_replay !== expected.idempotent_replay) {
    failures.push(`idempotent_replay expected ${expected.idempotent_replay} got ${body.idempotent_replay}`);
  }

  if (expected.extracted_fields && typeof expected.extracted_fields === 'object') {
    const actualFields = result.extracted_fields || {};
    for (const [k, v] of Object.entries(expected.extracted_fields)) {
      if (actualFields[k] !== v) {
        failures.push(`extracted_fields.${k} expected ${JSON.stringify(v)} got ${JSON.stringify(actualFields[k])}`);
      }
    }
  }

  if (expected.banned_reply_terms_absent === true) {
    const banned = findBannedTerms(reply);
    if (banned.length > 0) failures.push(`banned_reply_terms found: ${banned.join(', ')}`);
  }

  if (Array.isArray(expected.reply_contains)) {
    const lower = reply.toLowerCase();
    for (const term of expected.reply_contains) {
      if (!lower.includes(String(term).toLowerCase())) {
        failures.push(`reply_contains missing "${term}"`);
      }
    }
  }

  if (Array.isArray(expected.reply_must_not_contain)) {
    const lower = reply.toLowerCase();
    for (const term of expected.reply_must_not_contain) {
      if (lower.includes(String(term).toLowerCase())) {
        failures.push(`reply_must_not_contain found "${term}"`);
      }
    }
  }

  failures.push(...checkMustNotReask(reply, result.extracted_fields, expected.must_not_reask));

  if (expected.accept_any_of && typeof expected.accept_any_of === 'object') {
    let anyPass = false;
    for (const [field, values] of Object.entries(expected.accept_any_of)) {
      let actual;
      if (field === 'availability_status') actual = availability.availability_status;
      else if (field === 'proposed_next_action') actual = review.proposed_next_action;
      else if (field === 'message_lane') actual = result.message_lane;
      else actual = body[field];
      if (Array.isArray(values) && values.includes(actual)) anyPass = true;
    }
    if (!anyPass) {
      failures.push(`accept_any_of not satisfied: ${JSON.stringify(expected.accept_any_of)}`);
    }
  }

  failures.push(...checkSafetyFlags(body));

  if (body.success !== true && expected.idempotent_replay !== true) {
    failures.push(`success expected true got ${body.success}${body.error ? ` (${body.error})` : ''}`);
  }

  return failures;
}

function isReadyForHoldWrite(review) {
  const r = review || {};
  const res = r.result || {};
  const q = r.quote || {};
  const pc = r.payment_choice || {};
  const plan = r.hold_payment_draft_plan || {};
  return res.message_lane === 'new_booking_inquiry'
    && res.booking_intake_ready === true
    && q.quote_status === 'ready'
    && pc.payment_choice_ready === true
    && (plan.plan_status == null || plan.plan_status === 'ready');
}

function slimHoldPaymentDraftPlan(plan) {
  if (!plan || typeof plan !== 'object') return plan;
  const slim = { ...plan };
  delete slim.internal;
  return slim;
}

function buildHoldDraftPayload(opts, phone, review, readyContext) {
  const ctx = readyContext || guestContextFromReview({ review });
  return {
    source: 'luna_guest_flow_batch',
    confirm_simulator_write: true,
    confirm_write: true,
    client_slug: CLIENT_SLUG,
    guest_name: 'Flow Batch Test Guest',
    guest_email: 'flow-batch@wolfhouse.test',
    guest_phone: phone,
    guest_context: ctx,
    hold_payment_draft_plan: slimHoldPaymentDraftPlan(review.hold_payment_draft_plan),
    chain: {
      result: ctx.result,
      availability: ctx.availability,
      quote: ctx.quote,
      payment_choice: review.payment_choice,
    },
  };
}

async function runHoldDraft(opts, headers, phone, review, readyContext) {
  const payload = buildHoldDraftPayload(opts, phone, review, readyContext);
  const res = await postJson(`${opts.baseUrl}${HOLD_ROUTE}`, payload, headers);
  const body = typeof res.body === 'object' ? res.body : { success: false, error: res.raw };
  return { http_status: res.status, body };
}

async function runStripeTestLink(opts, headers, holdBody) {
  const payload = {
    source: 'luna_guest_flow_batch',
    confirm_simulator_stripe: true,
    confirm_stripe_test_link: true,
    payment_draft_id: holdBody.payment_draft_id,
    booking_id: holdBody.booking_id,
    booking_code: holdBody.booking_code,
  };
  const res = await postJson(`${opts.baseUrl}${STRIPE_ROUTE}`, payload, headers);
  const body = typeof res.body === 'object' ? res.body : { success: false, error: res.raw };
  return { http_status: res.status, body };
}

async function runFlow(flow, opts, mode, headers, flowIndex) {
  const phone = `${opts.phonePrefix}${String(flowIndex + 1).padStart(3, '0')}`;
  const endpoint = flow.endpoint === 'inbound' ? 'inbound' : 'simulator';
  const flowResult = {
    id: flow.id,
    label: flow.label,
    language: flow.language,
    endpoint,
    phone,
    result: 'PASS',
    turns: [],
    hold_draft: null,
    stripe_test_link: null,
    failures: [],
  };

  let guestContext = null;
  let priorReview = null;
  let lastBody = null;
  let readyContext = null;
  const inboundId = flow.inbound_message_id || `batch-${flow.id}`;

  for (let ti = 0; ti < flow.turns.length; ti++) {
    const turn = flow.turns[ti];
    if (!shouldRunTurn(turn, priorReview)) {
      flowResult.turns.push({
        step: ti + 1,
        message: turn.message,
        skipped: true,
        skip_reason: turn.conditional,
        result: 'PARTIAL',
      });
      continue;
    }

    if (turn.reset_guest_context) guestContext = null;

    let runRes;
    if (endpoint === 'inbound') {
      const msgId = turn.reuse_inbound_message_id ? inboundId : `${inboundId}-turn${ti + 1}`;
      const payload = buildInboundPayload(opts, flow, turn, turn.message, guestContext, phone, msgId);
      if (mode === 'local') runRes = await runInboundLocal(payload);
      else runRes = await runInboundEndpoint(opts, payload, headers);
    } else {
      const payload = buildSimulatorPayload(opts, flow, turn.message, guestContext, phone);
      if (mode === 'local') runRes = await runSimulatorLocal(payload);
      else runRes = await runSimulatorEndpoint(opts, payload, headers);
    }

    const body = runRes.body || {};
    body._http_status = runRes.http_status;
    lastBody = body;

    const expectFailures = checkFlowExpectations(turn.expect, body, priorReview);
    const turnSummary = {
      step: ti + 1,
      message: turn.message,
      http_status: runRes.http_status,
      message_lane: body.review && body.review.result && body.review.result.message_lane,
      proposed_next_action: body.review && body.review.proposed_next_action,
      quote_status: body.review && body.review.quote && body.review.quote.quote_status,
      payment_choice_ready: body.review && body.review.payment_choice && body.review.payment_choice.payment_choice_ready,
      idempotent_replay: body.idempotent_replay === true,
      failures: expectFailures,
      result: expectFailures.length === 0 ? 'PASS' : 'FAIL',
    };
    flowResult.turns.push(turnSummary);

    if (expectFailures.length > 0) {
      flowResult.failures.push(...expectFailures.map((f) => `turn ${ti + 1}: ${f}`));
      flowResult.result = 'FAIL';
      break;
    }

    if (body.review) {
      priorReview = body.review;
      if (!turn.reuse_inbound_message_id || !turn.reset_guest_context) {
        guestContext = guestContextFromReview(body);
      }
      if (isReadyForHoldWrite(body.review)) {
        readyContext = guestContext;
      }
    }
  }

  if (flowResult.result !== 'FAIL' && flow.final_expect) {
    const finalFailures = checkFlowExpectations(flow.final_expect, lastBody || {}, priorReview);
    if (finalFailures.length > 0) {
      flowResult.failures.push(...finalFailures.map((f) => `final: ${f}`));
      flowResult.result = 'FAIL';
    }
  }

  if (flowResult.result !== 'FAIL' && opts.createHoldDraft) {
    if (!flow.write_eligible) {
      flowResult.hold_draft = { skipped: true, reason: 'write_eligible:false' };
    } else if (!lastBody || !lastBody.review || !isReadyForHoldWrite(lastBody.review)) {
      flowResult.hold_draft = { skipped: true, reason: 'payment_choice or hold plan not ready' };
      flowResult.failures.push('write: hold/draft prerequisites not met');
      flowResult.result = 'FAIL';
    } else if (mode === 'local') {
      flowResult.hold_draft = { skipped: true, reason: 'hold/draft write requires endpoint mode' };
      flowResult.failures.push('write: --create-hold-draft requires endpoint mode (not --local)');
      flowResult.result = 'FAIL';
    } else {
      const holdRes = await runHoldDraft(opts, headers, phone, lastBody.review, readyContext);
      const hbody = holdRes.body || {};
      flowResult.hold_draft = {
        http_status: holdRes.http_status,
        success: hbody.success === true,
        write_status: hbody.write_status,
        booking_code: hbody.booking_code,
        payment_draft_id: hbody.payment_draft_id,
        sends_whatsapp: hbody.sends_whatsapp === false,
        live_send_blocked: hbody.live_send_blocked === true,
      };
      const holdOk = holdRes.http_status === 200 && hbody.success === true
        && hbody.booking_code && hbody.payment_draft_id
        && hbody.sends_whatsapp === false;
      if (!holdOk) {
        flowResult.failures.push(`write: hold/draft failed (${hbody.error || holdRes.http_status})`);
        flowResult.result = 'FAIL';
      } else if (opts.createStripeTestLink) {
        const stripeRes = await runStripeTestLink(opts, headers, hbody);
        const sbody = stripeRes.body || {};
        flowResult.stripe_test_link = {
          http_status: stripeRes.http_status,
          success: sbody.success === true,
          stripe_checkout_url: sbody.stripe_checkout_url || null,
          stripe_link_created: sbody.stripe_link_created === true || sbody.reused === true,
          sends_whatsapp: sbody.sends_whatsapp === false,
        };
        if (!(stripeRes.http_status === 200 && sbody.success && sbody.stripe_checkout_url)) {
          flowResult.failures.push(`write: Stripe test link failed (${sbody.error || stripeRes.http_status})`);
          flowResult.result = 'FAIL';
        }
      }
    }
  }

  const anyPartial = flowResult.turns.some((t) => t.skipped || t.result === 'PARTIAL');
  if (flowResult.result === 'PASS' && anyPartial) flowResult.result = 'PARTIAL';

  return flowResult;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    usage();
    process.exit(0);
  }

  if (opts.createStripeTestLink && !opts.createHoldDraft) {
    console.error('Error: --create-stripe-test-link requires --create-hold-draft');
    process.exit(1);
  }

  try {
    assertNotProduction(opts.baseUrl);
  } catch (e) {
    console.error(`FAIL — ${e.message}`);
    process.exit(1);
  }

  const fixtureFile = loadFixtureFile(DEFAULT_FIXTURE);
  const flows = filterFlows(fixtureFile, opts);
  if (flows.length === 0) {
    console.error('No flows matched filters.');
    process.exit(1);
  }

  const mode = resolveMode(opts);
  const headers = TOKEN ? { 'X-Luna-Bot-Token': TOKEN } : {};

  if (mode === 'endpoint' && !TOKEN) {
    console.error('Note: LUNA_BOT_INTERNAL_TOKEN not set — staging/authenticated hosts may return 401');
  }

  const report = {
    result: 'PASS',
    mode,
    review_only: !opts.createHoldDraft && !opts.createStripeTestLink,
    fixture_set: opts.fixtureSet,
    reference_date: opts.referenceDate,
    base_url: opts.baseUrl,
    total: flows.length,
    passed: 0,
    failed: 0,
    partial: 0,
    flows: [],
    first_failure: null,
  };

  if (!opts.json) {
    console.log(`\n── Luna Guest Flow Batch ──`);
    console.log(`Mode: ${mode} · Flows: ${flows.length} · Review-only: ${report.review_only}`);
  }

  for (let i = 0; i < flows.length; i++) {
    const flow = flows[i];
    let flowResult;
    try {
      flowResult = await runFlow(flow, opts, mode, headers, i);
    } catch (e) {
      flowResult = {
        id: flow.id,
        result: 'FAIL',
        failures: [e.message],
        turns: [],
      };
    }

    report.flows.push(flowResult);
    if (flowResult.result === 'PASS') report.passed++;
    else if (flowResult.result === 'PARTIAL') report.partial++;
    else {
      report.failed++;
      if (!report.first_failure) {
        report.first_failure = {
          flow_id: flow.id,
          failures: flowResult.failures,
        };
      }
      report.result = 'FAIL';
      if (opts.failFast) break;
    }

    if (!opts.json) {
      const mark = flowResult.result === 'PASS' ? 'PASS' : flowResult.result === 'PARTIAL' ? 'PARTIAL' : 'FAIL';
      console.log(`  ${mark}  ${flow.id} — ${flow.label || ''}`);
      if (flowResult.failures && flowResult.failures.length > 0) {
        console.log(`         ${flowResult.failures[0]}`);
      }
    }
  }

  if (report.failed === 0 && report.partial > 0) report.result = 'PARTIAL';

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n── Batch result: ${report.result} ──`);
    console.log(`Passed: ${report.passed} · Partial: ${report.partial} · Failed: ${report.failed} / ${report.total}`);
    if (report.first_failure) {
      console.log(`First failure: ${report.first_failure.flow_id} — ${report.first_failure.failures[0]}`);
    }
  }

  process.exit(report.result === 'FAIL' ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('FAIL —', e.message);
    process.exit(1);
  });
}

module.exports = {
  checkFlowExpectations,
  shouldRunTurn,
  filterFlows,
  loadFixtureFile,
  REASK_PATTERNS,
  findBannedTerms,
  isStaffHandoffRequired,
  checkSafetyFlags,
};
