/**
 * Stage 27test-l — Luna guest torture test runner (review-only by default).
 *
 * Usage:
 *   npm run luna:guest-torture -- --local --limit 50
 *   npm run luna:guest-torture -- --local --category booking_intake_single
 *   npm run luna:guest-torture -- --base-url https://staff-staging.lunafrontdesk.com --endpoint --limit 100
 */

'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const { runGuestInboundReviewDryRun } = require('./lib/luna-guest-inbound-review-dry-run');
const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { withPgClient } = require('./lib/pg-connect');
const { normalizeGuestContextForChain } = require('./lib/luna-guest-context-merge');

const {
  checkExpectations,
  checkSafetyFlags,
  findBannedTerms,
  isStaffHandoffRequired,
  buildPayload,
  buildGuestPhoneForCase,
  resolveRunId,
} = require('./run-luna-guest-golden-tests.js');

const { checkFlowExpectations } = require('./run-luna-guest-flow-batch.js');

const DEFAULT_FIXTURE = path.join(__dirname, 'fixtures', 'generated-luna-guest-torture.json');
const INBOUND_ROUTE = '/staff/bot/guest-inbound-review-dry-run';
const SIM_ROUTE = '/staff/bot/guest-automation-review-dry-run';
const TOKEN = process.env.LUNA_BOT_INTERNAL_TOKEN || '';

const HALLUCINATION_RISK_TERMS = [
  'confirmed booking',
  'booking is confirmed',
  'your booking is confirmed',
  'payment received',
  'we received your payment',
  'you are all set',
  'reserved for you',
  'availability is confirmed',
  'beds are confirmed',
  'payment has been received',
];

const CONFIRM_BOOKING_PATTERNS = [
  /booking\s+is\s+confirmed/i,
  /confirmed\s+your\s+booking/i,
  /your\s+booking\s+is\s+confirmed/i,
  /reservation\s+is\s+confirmed/i,
];

const PAYMENT_CLAIM_PATTERNS = [
  /payment\s+received/i,
  /we\s+received\s+your\s+payment/i,
  /payment\s+has\s+been\s+received/i,
  /already\s+received\s+your\s+payment/i,
];

const AVAILABILITY_INVENTION_PATTERNS = [
  /beds?\s+are\s+confirmed/i,
  /availability\s+is\s+confirmed/i,
  /we\s+have\s+confirmed\s+availability/i,
  /fully\s+available\s+and\s+confirmed/i,
];

function usage() {
  console.log(`Usage: node scripts/run-luna-guest-torture-tests.js [options]

Options:
  --base-url URL       Default STAFF_API_BASE_URL or http://127.0.0.1:3036
  --fixture-file PATH  Default scripts/fixtures/generated-luna-guest-torture.json
  --limit N            Run first N cases after filters
  --category CAT       Filter by category
  --language LANG      Filter by language
  --local              Force local mode
  --endpoint           Force HTTP endpoint mode
  --json               JSON report only
  --fail-fast          Stop on first failure
  --phone-prefix PREFIX  Default +34600997
  --run-id ID          Default auto (endpoint isolation)
  --help               Show this help

Default: review-only — no hold/draft, Stripe, WhatsApp, Meta, or n8n.`);
}

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.STAFF_API_BASE_URL || 'http://127.0.0.1:3036',
    fixtureFile: DEFAULT_FIXTURE,
    limit: null,
    category: null,
    language: null,
    local: false,
    endpoint: false,
    json: false,
    failFast: false,
    phonePrefix: '+34600997',
    runId: 'auto',
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--local') opts.local = true;
    else if (a === '--endpoint') opts.endpoint = true;
    else if (a === '--fail-fast') opts.failFast = true;
    else if (a === '--base-url') opts.baseUrl = argv[++i];
    else if (a === '--fixture-file') opts.fixtureFile = argv[++i];
    else if (a === '--limit') opts.limit = parseInt(argv[++i], 10);
    else if (a === '--category') opts.category = argv[++i];
    else if (a === '--language') opts.language = argv[++i];
    else if (a === '--phone-prefix') opts.phonePrefix = argv[++i];
    else if (a === '--run-id') opts.runId = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      usage();
      process.exit(1);
    }
  }
  return opts;
}

function resolveMode(opts) {
  if (opts.local) return 'local';
  if (opts.endpoint) return 'endpoint';
  return TOKEN ? 'endpoint' : 'local';
}

function loadFixtures(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!data || !Array.isArray(data.cases)) throw new Error('fixture must contain cases[]');
  return data;
}

function filterCases(cases, opts) {
  let out = cases.slice();
  if (opts.category) out = out.filter((c) => c.category === opts.category);
  if (opts.language) out = out.filter((c) => String(c.language).toLowerCase() === opts.language.toLowerCase());
  if (opts.limit != null && opts.limit > 0) out = out.slice(0, opts.limit);
  return out;
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
        try { parsed = JSON.parse(raw); } catch { parsed = { success: false, error: raw }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function guestContextFromReview(apiBody) {
  const r = (apiBody && apiBody.review) || {};
  return normalizeGuestContextForChain({
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
  });
}

function wrapOrchBody(orchOut) {
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

function findHallucinationHits(reply) {
  const text = String(reply || '').toLowerCase();
  return HALLUCINATION_RISK_TERMS.filter((t) => text.includes(t.toLowerCase()));
}

function checkTortureExpectations(fixture, body) {
  const failures = checkExpectations(fixture, body);
  const expected = fixture.expected || {};
  const review = body.review || {};
  const reply = review.proposed_luna_reply || '';

  if (Array.isArray(expected.accept_lanes) && expected.accept_lanes.length > 0) {
    const lane = review.result && review.result.message_lane;
    if (!expected.accept_lanes.includes(lane)) {
      failures.push(`accept_lanes expected one of [${expected.accept_lanes.join(', ')}] got ${lane}`);
    }
  }

  if (expected.must_not_confirm_booking === true) {
    for (const p of CONFIRM_BOOKING_PATTERNS) {
      if (p.test(reply)) {
        failures.push('must_not_confirm_booking: reply claims booking confirmed');
        break;
      }
    }
  }

  if (expected.must_not_claim_payment_received === true) {
    for (const p of PAYMENT_CLAIM_PATTERNS) {
      if (p.test(reply)) {
        failures.push('must_not_claim_payment_received: reply claims payment received');
        break;
      }
    }
  }

  if (expected.must_not_invent_availability === true) {
    const avail = review.availability || {};
    if (avail.availability_check_attempted !== true) {
      for (const p of AVAILABILITY_INVENTION_PATTERNS) {
        if (p.test(reply)) {
          failures.push('must_not_invent_availability: reply invents availability without check');
          break;
        }
      }
    }
  }

  const hallucination = findHallucinationHits(reply);
  if (hallucination.length > 0 && expected.banned_reply_terms_absent !== false) {
    failures.push(`hallucination_risk_terms: ${hallucination.join(', ')}`);
  }

  return failures;
}

async function runSingleLocal(payload) {
  const outcome = await runGuestInboundReviewDryRun(payload, {});
  return {
    http_status: outcome.status || (outcome.ok ? 200 : 400),
    body: outcome.body || outcome,
  };
}

async function runSingleEndpoint(opts, payload, headers) {
  const target = `${opts.baseUrl.replace(/\/$/, '')}${INBOUND_ROUTE}`;
  const res = await postJson(target, payload, headers);
  return { http_status: res.status, body: res.body };
}

async function runSimulatorLocal(payload, referenceDate) {
  const orchOut = await withPgClient((pg) => runGuestAutomationOrchestratorDryRun({
    client_slug: payload.client_slug,
    channel: payload.channel || 'staff_review',
    message_text: payload.message_text,
    guest_phone: payload.guest_phone,
    language_hint: payload.language_hint,
    guest_context: payload.guest_context,
    reference_date: referenceDate,
    automation_gate_context: payload.automation_gate_context,
    dry_run: true,
  }, {
    reference_date: referenceDate,
    guest_phone: payload.guest_phone,
    dry_run: true,
    pg,
  }));
  return { http_status: 200, body: wrapOrchBody(orchOut) };
}

async function runSimulatorEndpoint(opts, payload, headers) {
  const target = `${opts.baseUrl.replace(/\/$/, '')}${SIM_ROUTE}`;
  const res = await postJson(target, payload, headers);
  return { http_status: res.status, body: res.body };
}

async function runFlowCase(fixture, opts, mode, headers, index, meta) {
  const phone = mode === 'endpoint'
    ? buildGuestPhoneForCase('endpoint', { resolvedRunId: opts.resolvedRunId, phonePrefix: opts.phonePrefix }, index + 9000)
    : `${opts.phonePrefix}${String(index + 1).padStart(3, '0')}`;
  let guestContext = null;
  let priorReview = null;
  let lastBody = null;
  const failures = [];

  for (let ti = 0; ti < fixture.turns.length; ti++) {
    const turn = fixture.turns[ti];
    const payload = {
      client_slug: meta.default_client_slug || 'wolfhouse-somo',
      channel: 'staff_review',
      message_text: turn.message,
      dry_run: true,
      reference_date: meta.reference_date || '2026-06-08',
      guest_phone: phone,
      language_hint: fixture.language,
      guest_context: guestContext || undefined,
      automation_gate_context: {
        public_guest_automation_enabled: false,
        whatsapp_dry_run: true,
        live_send_allowed: false,
      },
    };
    const runRes = mode === 'endpoint'
      ? await runSimulatorEndpoint(opts, payload, headers)
      : await runSimulatorLocal(payload, payload.reference_date);
    lastBody = runRes.body || {};
    if (runRes.http_status !== 200) failures.push(`turn ${ti + 1}: HTTP ${runRes.http_status}`);
    failures.push(...checkFlowExpectations(turn.expect || {}, lastBody, priorReview).map((f) => `turn ${ti + 1}: ${f}`));
    failures.push(...checkTortureExpectations({ expected: turn.expect || {} }, lastBody).filter((f) => !f.startsWith('success')));
    if (lastBody.review) {
      priorReview = lastBody.review;
      guestContext = guestContextFromReview(lastBody);
    }
    if (failures.length > 0) break;
  }

  if (failures.length === 0 && fixture.final_expect) {
    failures.push(...checkFlowExpectations(fixture.final_expect, lastBody || {}, priorReview).map((f) => `final: ${f}`));
    failures.push(...checkTortureExpectations({ expected: fixture.final_expect }, lastBody || {}).filter((f) => !f.startsWith('success')));
  }

  return { failures, lastBody };
}

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function summarizeFailure(fixture, failures, body) {
  const review = body.review || {};
  const result = review.result || {};
  return {
    id: fixture.id,
    category: fixture.category,
    language: fixture.language,
    kind: fixture.kind,
    message_text: fixture.message_text || (fixture.turns && fixture.turns[0] && fixture.turns[0].message),
    first_failure: failures[0],
    all_failures: failures,
    actual: {
      message_lane: result.message_lane,
      proposed_next_action: review.proposed_next_action,
      proposed_luna_reply: (review.proposed_luna_reply || '').slice(0, 280),
      handoff_required: isStaffHandoffRequired(review, result),
      banned_terms: findBannedTerms(review.proposed_luna_reply),
      hallucination_hits: findHallucinationHits(review.proposed_luna_reply),
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    usage();
    process.exit(0);
  }

  const meta = loadFixtures(path.resolve(opts.fixtureFile));
  const cases = filterCases(meta.cases, opts);
  const mode = resolveMode(opts);
  opts.resolvedRunId = resolveRunId(opts.runId);
  const headers = TOKEN ? { 'X-Luna-Bot-Token': TOKEN } : {};

  if (cases.length === 0) {
    console.error('No cases matched filters.');
    process.exit(1);
  }

  const report = {
    mode,
    review_only: true,
    fixture_file: opts.fixtureFile,
    run_id: opts.resolvedRunId,
    total: cases.length,
    passed: 0,
    failed: 0,
    pass_rate_pct: 0,
    failures_by_category: {},
    failures_by_language: {},
    failure_reasons: {},
    banned_term_hits: 0,
    hallucination_risk_hits: 0,
    safety_flag_failures: 0,
    failures: [],
  };

  for (let i = 0; i < cases.length; i++) {
    const fixture = cases[i];
    let failures = [];
    let body = {};

    try {
      if (fixture.kind === 'flow') {
        const flowOut = await runFlowCase(fixture, opts, mode, headers, i, meta);
        failures = flowOut.failures;
        body = flowOut.lastBody || {};
      } else {
        const payload = buildPayload(
          { ...fixture, id: fixture.id, language: fixture.language },
          meta,
          i,
          mode,
          opts,
        );
        if (fixture.guest_context) payload.guest_context = fixture.guest_context;
        const runRes = mode === 'endpoint'
          ? await runSingleEndpoint(opts, payload, headers)
          : await runSingleLocal(payload);
        body = runRes.body || {};
        if (runRes.http_status !== 200) failures.push(`HTTP ${runRes.http_status}`);
        failures.push(...checkTortureExpectations(fixture, body));
      }
    } catch (err) {
      failures.push(`run error: ${err.message}`);
    }

    if (failures.length === 0) {
      report.passed++;
    } else {
      report.failed++;
      bump(report.failures_by_category, fixture.category || 'unknown');
      bump(report.failures_by_language, fixture.language || 'unknown');
      bump(report.failure_reasons, failures[0]);
      const review = body.review || {};
      if (findBannedTerms(review.proposed_luna_reply).length) report.banned_term_hits++;
      if (findHallucinationHits(review.proposed_luna_reply).length) report.hallucination_risk_hits++;
      if (failures.some((f) => /dry_run|sends_whatsapp|live_send_blocked|no_write/.test(f))) {
        report.safety_flag_failures++;
      }
      report.failures.push(summarizeFailure(fixture, failures, body));
      if (opts.failFast) break;
    }
  }

  report.pass_rate_pct = report.total > 0
    ? Math.round((report.passed / report.total) * 1000) / 10
    : 0;

  const topReasons = Object.entries(report.failure_reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));

  if (opts.json) {
    console.log(JSON.stringify({ ...report, top_failure_reasons: topReasons }, null, 2));
  } else {
    console.log('\n── Luna Guest Torture Test Report ──');
    console.log(`Mode:       ${mode}`);
    console.log(`Total:      ${report.total}`);
    console.log(`Passed:     ${report.passed}`);
    console.log(`Failed:     ${report.failed}`);
    console.log(`Pass rate:  ${report.pass_rate_pct}%`);
    if (report.failed > 0) {
      console.log('\nPass rate by category:');
      const catTotals = {};
      for (const c of cases) bump(catTotals, c.category);
      for (const [cat, total] of Object.entries(catTotals)) {
        const fails = report.failures_by_category[cat] || 0;
        const pass = total - fails;
        console.log(`  ${cat}: ${pass}/${total} (${Math.round((pass / total) * 100)}%)`);
      }
      console.log('\nTop failure reasons:');
      for (const { reason, count } of topReasons) console.log(`  [${count}x] ${reason}`);
      console.log('\nFirst failures (up to 20):');
      for (const f of report.failures.slice(0, 20)) {
        console.log(`  FAIL [${f.id}] ${f.category}/${f.language}`);
        console.log(`    msg: ${(f.message_text || '').slice(0, 80)}`);
        console.log(`    reason: ${f.first_failure}`);
        console.log(`    lane=${f.actual.message_lane} action=${f.actual.proposed_next_action}`);
      }
      if (report.banned_term_hits) console.log(`\nBanned-term hits: ${report.banned_term_hits}`);
      if (report.hallucination_risk_hits) console.log(`Hallucination-risk hits: ${report.hallucination_risk_hits}`);
      if (report.safety_flag_failures) console.log(`Safety-flag failures: ${report.safety_flag_failures}`);
    }
    console.log(`\n${report.failed === 0 ? 'PASS' : 'FAIL'} — torture runner`);
  }

  process.exit(report.failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  HALLUCINATION_RISK_TERMS,
  findHallucinationHits,
  checkTortureExpectations,
  filterCases,
};
