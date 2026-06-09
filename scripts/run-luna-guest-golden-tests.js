/**
 * Stage 27test-a — Bulk Luna guest golden message test runner.
 *
 * Exercises POST /staff/bot/guest-inbound-review-dry-run (or local lib) against
 * scripts/fixtures/luna-guest-golden-messages.json. Review-only — no live sends.
 *
 * Usage:
 *   npm run luna:guest-golden -- --limit 10
 *   npm run luna:guest-golden -- --language en --category booking_en
 *   npm run luna:guest-golden -- --base-url https://staff-staging.lunafrontdesk.com --limit 5
 *   npm run luna:guest-golden -- --local --json
 */

'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const { runGuestInboundReviewDryRun } = require('./lib/luna-guest-inbound-review-dry-run');

const REVIEW_ROUTE = '/staff/bot/guest-inbound-review-dry-run';
const DEFAULT_FIXTURE = path.join(__dirname, 'fixtures', 'luna-guest-golden-messages.json');
const TOKEN = process.env.LUNA_BOT_INTERNAL_TOKEN || '';

const BANNED_REPLY_TERMS = [
  'confirmed quote',
  'payment choice',
  'payment_choice',
  'quote_status',
  'guest_context',
  'intake_state',
  'readiness_state',
  'automation gate',
  'next_safe_step',
  'dry run',
  'idempotency',
  'webhook',
];

function usage() {
  console.log(`Usage: node scripts/run-luna-guest-golden-tests.js [options]

Options:
  --base-url URL       Default STAFF_API_BASE_URL or http://127.0.0.1:3036
  --fixture-file PATH  Default scripts/fixtures/luna-guest-golden-messages.json
  --limit N            Run first N cases after filters
  --language LANG      Filter by language (en, it, es, de, fr)
  --category CAT       Filter by category
  --local              Force local function mode (no HTTP)
  --endpoint           Force HTTP endpoint mode
  --json               Print JSON report only
  --fail-fast          Stop on first failure
  --phone-prefix PREFIX  Default +34600997 (endpoint mode: per-case phone suffix)
  --run-id ID          Default auto — unique run tag for endpoint idempotency isolation
  --help               Show this help

Mode: uses HTTP when LUNA_BOT_INTERNAL_TOKEN is set and --local not passed;
      otherwise runs runGuestInboundReviewDryRun locally without DB writes.
Endpoint mode assigns a unique guest_phone and idempotency_key per case (plus --run-id)
to avoid stale staging inbound cache; local mode stays deterministic.`);
}

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.STAFF_API_BASE_URL || 'http://127.0.0.1:3036',
    fixtureFile: DEFAULT_FIXTURE,
    limit: null,
    language: null,
    category: null,
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
    else if (a === '--language') opts.language = argv[++i];
    else if (a === '--category') opts.category = argv[++i];
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

function loadFixtures(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.cases)) {
    throw new Error('fixture file must contain cases[]');
  }
  return data;
}

function filterCases(cases, opts) {
  let out = cases.slice();
  if (opts.language) {
    out = out.filter((c) => String(c.language || '').toLowerCase() === opts.language.toLowerCase());
  }
  if (opts.category) {
    out = out.filter((c) => c.category === opts.category);
  }
  if (opts.limit != null && opts.limit > 0) {
    out = out.slice(0, opts.limit);
  }
  return out;
}

function resolveMode(opts) {
  if (opts.local) return 'local';
  if (opts.endpoint) return 'endpoint';
  return TOKEN ? 'endpoint' : 'local';
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

function simpleRunHash(value) {
  let h = 0;
  const s = String(value || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i);
  return Math.abs(h);
}

function resolveRunId(raw) {
  if (raw && raw !== 'auto') {
    return String(raw).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Endpoint: unique phone per case/run; local: fixed deterministic phone. */
function buildGuestPhoneForCase(mode, opts, index) {
  if (mode === 'local') return '+34600999997';
  const caseSuffix = String(index + 1).padStart(4, '0');
  const runTag = String(simpleRunHash(opts.resolvedRunId)).slice(-5).padStart(5, '0');
  return `${opts.phonePrefix}${runTag}${caseSuffix}`;
}

function buildPayload(fixture, fixtureFile, index, mode, opts) {
  const meta = fixtureFile;
  const runId = opts.resolvedRunId;
  const payload = {
    source: 'golden_test_runner',
    client_slug: meta.default_client_slug || 'wolfhouse-somo',
    channel: meta.default_channel || 'whatsapp',
    guest_phone: buildGuestPhoneForCase(mode, opts, index),
    message_text: fixture.message_text,
    reference_date: meta.reference_date || '2026-06-08',
    language_hint: fixture.language,
    inbound_message_id: mode === 'endpoint'
      ? `golden-${runId}-${fixture.id}`
      : `golden-${fixture.id}-${index}`,
    idempotency_key: mode === 'endpoint'
      ? `golden:${runId}:${fixture.id}`
      : `golden:${fixture.id}:${index}`,
    guest_context: fixture.guest_context,
    automation_gate_context: {
      public_guest_automation_enabled: false,
      whatsapp_dry_run: true,
      live_send_allowed: false,
    },
  };

  if (fixture.guest_phone) payload.guest_phone = fixture.guest_phone;
  if (fixture.inbound_message_id) payload.inbound_message_id = fixture.inbound_message_id;
  if (fixture.idempotency_key) payload.idempotency_key = fixture.idempotency_key;

  return payload;
}

async function runCaseLocal(payload) {
  const outcome = await runGuestInboundReviewDryRun(payload, {});
  return {
    http_status: outcome.status || (outcome.ok ? 200 : 400),
    body: outcome.body || outcome,
    error: outcome.error || null,
  };
}

async function runCaseEndpoint(opts, payload, headers) {
  const target = `${opts.baseUrl.replace(/\/$/, '')}${REVIEW_ROUTE}`;
  const res = await postJson(target, payload, headers);
  return { http_status: res.status, body: res.body, error: null };
}

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
  const action = review && review.proposed_next_action;
  const safeHandoff = review && review.result && review.result.safe_handoff_required === true;
  return reasons.filter((r) => {
    if (TECHNICAL_HANDOFF_REASONS.has(r)) return false;
    if (r === 'no_payment_choice_detected' && action === 'collect_payment_choice') return false;
    if (r === 'arrival_balance_question'
      && action === 'collect_payment_choice'
      && !safeHandoff) return false;
    if (r === 'availability_not_available' && availability.availability_check_attempted !== true) return false;
    if (r === 'quote_not_ready' && quote.quote_proposal_attempted !== true) return false;
    return true;
  });
}

/**
 * Real staff handoff — excludes skipped-chain technical reasons on ask_missing_details turns.
 */
function isStaffHandoffRequired(review, result) {
  if (result && result.safe_handoff_required === true) return true;
  if (review && review.proposed_next_action === 'staff_handoff_required') return true;
  const gate = (review && review.automation_gate) || {};
  if (gate.gate_status === 'blocked' || gate.gate_status === 'staff_handoff') return true;
  return filterRealHandoffReasons(review || {}).length > 0;
}

function findBannedTerms(reply) {
  const text = String(reply || '').toLowerCase();
  const found = [];
  for (const term of BANNED_REPLY_TERMS) {
    if (text.includes(term.toLowerCase())) found.push(term);
  }
  return found;
}

function checkSafetyFlags(body) {
  const failures = [];
  if (body.dry_run !== true) failures.push(`dry_run expected true got ${body.dry_run}`);
  if (body.sends_whatsapp !== false) failures.push(`sends_whatsapp expected false got ${body.sends_whatsapp}`);
  if (body.live_send_blocked !== true) failures.push(`live_send_blocked expected true got ${body.live_send_blocked}`);
  if (body.no_write_performed !== true) failures.push(`no_write_performed expected true got ${body.no_write_performed}`);
  return failures;
}

function checkExpectations(fixture, body) {
  const failures = [];
  const expected = fixture.expected || {};
  const review = body.review || {};
  const result = review.result || {};
  const reply = review.proposed_luna_reply || '';

  if (expected.message_lane != null && result.message_lane !== expected.message_lane) {
    failures.push(`message_lane expected ${expected.message_lane} got ${result.message_lane}`);
  }

  if (expected.booking_intake_ready != null && result.booking_intake_ready !== expected.booking_intake_ready) {
    failures.push(`booking_intake_ready expected ${expected.booking_intake_ready} got ${result.booking_intake_ready}`);
  }

  if (Array.isArray(expected.required_missing_fields) && expected.required_missing_fields.length > 0) {
    const actual = Array.isArray(result.missing_required_fields) ? result.missing_required_fields : [];
    for (const field of expected.required_missing_fields) {
      if (!actual.includes(field)) {
        failures.push(`required_missing_fields expected to include ${field}, got [${actual.join(', ')}]`);
      }
    }
  }

  if (expected.handoff_required != null) {
    const actualHandoff = isStaffHandoffRequired(review, result);
    if (actualHandoff !== expected.handoff_required) {
      failures.push(`handoff_required expected ${expected.handoff_required} got ${actualHandoff}`);
    }
  }

  if (expected.proposed_next_action != null && review.proposed_next_action !== expected.proposed_next_action) {
    failures.push(`proposed_next_action expected ${expected.proposed_next_action} got ${review.proposed_next_action}`);
  }

  if (expected.banned_reply_terms_absent === true) {
    const banned = findBannedTerms(reply);
    if (banned.length > 0) {
      failures.push(`banned_reply_terms found: ${banned.join(', ')}`);
    }
  }

  if (Array.isArray(expected.expected_reply_contains) && expected.expected_reply_contains.length > 0) {
    const replyLower = String(reply || '').toLowerCase();
    for (const term of expected.expected_reply_contains) {
      if (!replyLower.includes(String(term).toLowerCase())) {
        failures.push(`expected_reply_contains missing "${term}"`);
      }
    }
  }

  failures.push(...checkSafetyFlags(body));

  if (body.success !== true) {
    failures.push(`success expected true got ${body.success}${body.error ? ` (${body.error})` : ''}`);
  }

  return failures;
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
    message_text: fixture.message_text,
    first_failure: failures[0],
    all_failures: failures,
    actual: {
      message_lane: result.message_lane,
      booking_intake_ready: result.booking_intake_ready,
      missing_required_fields: result.missing_required_fields,
      proposed_next_action: review.proposed_next_action,
      proposed_luna_reply: review.proposed_luna_reply,
      handoff_required: isStaffHandoffRequired(review, result),
      banned_terms: findBannedTerms(review.proposed_luna_reply),
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    usage();
    process.exit(0);
  }

  const fixtureFile = loadFixtures(path.resolve(opts.fixtureFile));
  const cases = filterCases(fixtureFile.cases, opts);
  const mode = resolveMode(opts);
  opts.resolvedRunId = resolveRunId(opts.runId);
  const headers = TOKEN ? { 'X-Luna-Bot-Token': TOKEN } : {};

  if (cases.length === 0) {
    console.error('No cases matched filters.');
    process.exit(1);
  }

  const report = {
    mode,
    run_id: opts.resolvedRunId,
    fixture_file: opts.fixtureFile,
    reference_date: fixtureFile.reference_date,
    total: cases.length,
    passed: 0,
    failed: 0,
    failures_by_category: {},
    failures_by_language: {},
    failures: [],
  };

  for (let i = 0; i < cases.length; i++) {
    const fixture = cases[i];
    const payload = buildPayload(fixture, fixtureFile, i, mode, opts);

    let runResult;
    try {
      runResult = mode === 'endpoint'
        ? await runCaseEndpoint(opts, payload, headers)
        : await runCaseLocal(payload);
    } catch (err) {
      runResult = { http_status: 0, body: { success: false }, error: err.message };
    }

    const body = runResult.body || {};
    const failures = [];

    if (runResult.http_status !== 200) {
      failures.push(`HTTP ${runResult.http_status}${runResult.error ? `: ${runResult.error}` : ''}`);
    }
    if (runResult.error && runResult.http_status === 0) {
      failures.push(`run error: ${runResult.error}`);
    }

    failures.push(...checkExpectations(fixture, body));

    if (failures.length === 0) {
      report.passed++;
    } else {
      report.failed++;
      bump(report.failures_by_category, fixture.category || 'unknown');
      bump(report.failures_by_language, fixture.language || 'unknown');
      report.failures.push(summarizeFailure(fixture, failures, body));

      if (!opts.json) {
        console.log(`FAIL [${fixture.id}] ${fixture.category}/${fixture.language}`);
        console.log(`  ${failures[0]}`);
      }

      if (opts.failFast) break;
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\n── Luna Guest Golden Test Report ──');
    console.log(`Mode:     ${mode}`);
    console.log(`Total:    ${report.total}`);
    console.log(`Passed:   ${report.passed}`);
    console.log(`Failed:   ${report.failed}`);
    if (report.failed > 0) {
      console.log('\nFailures by category:');
      for (const [k, v] of Object.entries(report.failures_by_category)) {
        console.log(`  ${k}: ${v}`);
      }
      console.log('\nFailures by language:');
      for (const [k, v] of Object.entries(report.failures_by_language)) {
        console.log(`  ${k}: ${v}`);
      }
      const first = report.failures[0];
      console.log('\nFirst failure detail:');
      console.log(`  id:      ${first.id}`);
      console.log(`  message: ${first.message_text}`);
      console.log(`  reason:  ${first.first_failure}`);
      console.log(`  actual:  lane=${first.actual.message_lane} action=${first.actual.proposed_next_action} missing=${JSON.stringify(first.actual.missing_required_fields)}`);
      if (first.actual.banned_terms.length) {
        console.log(`  banned:  ${first.actual.banned_terms.join(', ')}`);
      }
    }
    console.log(`\n${report.failed === 0 ? 'PASS' : 'FAIL'} — golden runner`);
  }

  process.exit(report.failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  BANNED_REPLY_TERMS,
  TECHNICAL_HANDOFF_REASONS,
  findBannedTerms,
  filterRealHandoffReasons,
  isStaffHandoffRequired,
  checkExpectations,
  checkSafetyFlags,
  filterCases,
  resolveRunId,
  buildGuestPhoneForCase,
  buildPayload,
};
