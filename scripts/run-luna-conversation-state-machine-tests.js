/**
 * Stage 29a — Luna conversation state-machine tester.
 *
 * Runs multi-turn guest conversations through the real guest automation orchestrator.
 * Default: dry-run only — no WhatsApp send, no writes, no Stripe, no confirmations.
 *
 * Usage:
 *   npm run test:luna-conversations -- --all
 *   npm run test:luna-conversations -- --fixture short-stay-accommodation-only-to-deposit
 *   npm run test:luna-conversations -- --all --verbose --json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { withPgClient } = require('./lib/pg-connect');
const { normalizeGuestContextForChain } = require('./lib/luna-guest-context-merge');

const CLIENT_SLUG = 'wolfhouse-somo';
const DEFAULT_FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'luna-conversation-state-machine');
const DEFAULT_REFERENCE_DATE = '2026-06-10';
const PACKAGE_NAMES_RE = /\b(?:Malibu|Uluwatu|Waimea)\b/i;

const INTERNAL_LANGUAGE_BLACKLIST = [
  'dry run',
  'staging',
  'automation gate',
  'quote_status',
  'payment_choice',
  'guest_context',
  'intake_state',
  'i am not confirming the booking',
  'i am not creating a hold',
  'i am not sending a payment link',
  'not creating a hold',
  'not sending a payment link',
];

function usage() {
  console.log(`Usage: node scripts/run-luna-conversation-state-machine-tests.js [options]

Options:
  --all                    Run all fixtures in the fixture directory
  --fixture <name>         Run one fixture (id or filename without .json)
  --limit <n>              Run first N fixtures after filters
  --json                   Print JSON report only
  --verbose                Print full turn diagnostics
  --keep-bookings          Reserved — no cleanup in this slice
  --allow-writes           Allow writes (requires non-production guard; not default)
  --phone-prefix <prefix>  Default +34629800
  --reference-date <date>  Default ${DEFAULT_REFERENCE_DATE}
  --fixture-dir <path>     Default fixtures/luna-conversation-state-machine
  --help                   Show this help`);
}

function parseArgs(argv) {
  const opts = {
    all: false,
    fixture: null,
    limit: null,
    json: false,
    verbose: false,
    keepBookings: false,
    allowWrites: false,
    phonePrefix: '+34629800',
    referenceDate: DEFAULT_REFERENCE_DATE,
    fixtureDir: DEFAULT_FIXTURE_DIR,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--keep-bookings') opts.keepBookings = true;
    else if (a === '--allow-writes') opts.allowWrites = true;
    else if (a === '--fixture') opts.fixture = argv[++i];
    else if (a === '--limit') opts.limit = parseInt(argv[++i], 10);
    else if (a === '--phone-prefix') opts.phonePrefix = argv[++i];
    else if (a === '--reference-date') opts.referenceDate = argv[++i];
    else if (a === '--fixture-dir') opts.fixtureDir = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      usage();
      process.exit(1);
    }
  }
  return opts;
}

function assertNotProduction() {
  const base = (process.env.STAFF_API_BASE_URL || '').replace(/\/$/, '');
  if (!base) return;
  try {
    const host = new URL(base).hostname.toLowerCase();
    if (/^staff\.lunafrontdesk\.com$/i.test(host)) {
      throw new Error(`production host blocked: ${host}`);
    }
    if (host.includes('lunafrontdesk.com') && !host.includes('staging') && !host.includes('staff-staging')) {
      throw new Error(`production host blocked: ${host}`);
    }
  } catch (e) {
    if (e.message && e.message.includes('production host blocked')) throw e;
    throw new Error(`invalid STAFF_API_BASE_URL: ${base}`);
  }
}

function loadFixtures(fixtureDir) {
  if (!fs.existsSync(fixtureDir)) {
    throw new Error(`fixture directory not found: ${fixtureDir}`);
  }
  const files = fs.readdirSync(fixtureDir).filter((f) => f.endsWith('.json')).sort();
  return files.map((file) => {
    const raw = fs.readFileSync(path.join(fixtureDir, file), 'utf8');
    const data = JSON.parse(raw);
    if (!data.id) data.id = path.basename(file, '.json');
    return data;
  });
}

function filterFixtures(fixtures, opts) {
  let out = fixtures.slice();
  if (opts.fixture) {
    const needle = opts.fixture.replace(/\.json$/, '');
    out = out.filter((f) => f.id === needle || f.id.includes(needle));
  } else if (!opts.all) {
    out = out.slice(0, 1);
  }
  if (opts.limit != null && opts.limit > 0) out = out.slice(0, opts.limit);
  return out;
}

function applyChannelContactName(guestContext, contactName) {
  if (!contactName) return guestContext || undefined;
  const gc = guestContext ? { ...guestContext } : {};
  if (!gc.contact_name) gc.contact_name = contactName;
  if (!gc.whatsapp_guest_name) gc.whatsapp_guest_name = contactName;
  return gc;
}

function guestContextFromOrchestrator(out, contactName) {
  const r = out || {};
  return applyChannelContactName(normalizeGuestContextForChain({
    message_lane: r.result && r.result.message_lane,
    intake_state: r.result && r.result.intake_state,
    readiness_state: r.result && r.result.readiness_state,
    booking_intake_ready: r.result && r.result.booking_intake_ready,
    extracted_fields: r.result && r.result.extracted_fields,
    package_night_rule: r.result && r.result.package_night_rule,
    result: r.result,
    availability: r.availability,
    quote: r.quote,
    payment_choice: r.payment_choice,
    hold_payment_draft_plan: r.hold_payment_draft_plan,
    detected_language: r.result && r.result.detected_language,
  }), contactName);
}

function findInternalLanguage(text) {
  const lower = String(text || '').toLowerCase();
  return INTERNAL_LANGUAGE_BLACKLIST.filter((term) => lower.includes(term.toLowerCase()));
}

function isHandoff(out) {
  const r = out.result || {};
  if (r.safe_handoff_required === true) return true;
  if (out.proposed_next_action === 'staff_handoff_required') return true;
  const gate = out.automation_gate || {};
  return gate.gate_status === 'blocked' || gate.gate_status === 'staff_handoff';
}

function buildTurnDiagnostic(turnIndex, message, out) {
  const r = out.result || {};
  const policy = r.booking_intake_policy || {};
  const brain = r.conversation_brain || {};
  return {
    turn: turnIndex + 1,
    guest_message: message,
    luna_reply: out.proposed_luna_reply || r.proposed_luna_reply || '',
    message_lane: r.message_lane || null,
    brain_intent: brain.intent || null,
    booking_flow_stage: policy.booking_flow_stage || null,
    next_required_field: policy.next_required_field || null,
    extracted_fields: r.extracted_fields || {},
    missing_required_fields: r.missing_required_fields || [],
    readiness_missing_fields: r.readiness_missing_fields || [],
    quote_status: out.quote && out.quote.quote_status,
    quote_total_cents: out.quote && out.quote.quote_total_cents,
    availability_status: out.availability && out.availability.availability_status,
    payment_choice_ready: out.payment_choice && out.payment_choice.payment_choice_ready,
    payment_choice: out.payment_choice && out.payment_choice.payment_choice,
    proposed_next_action: out.proposed_next_action || null,
    safe_handoff_required: r.safe_handoff_required === true,
    handoff_reasons: r.handoff_reasons || [],
    dry_run: out.dry_run,
    no_write_performed: out.no_write_performed,
    sends_whatsapp: out.sends_whatsapp,
    creates_booking: out.creates_booking,
    creates_stripe_link: out.creates_stripe_link,
    payment_link_sent: out.payment_link_sent,
    confirmation_sent: out.confirmation_sent === true,
    internal_language: findInternalLanguage(out.proposed_luna_reply || ''),
  };
}

function printTurnDiagnostic(diag, verbose) {
  console.log(`\n  Turn ${diag.turn}: "${diag.guest_message}"`);
  console.log(`    Luna: ${String(diag.luna_reply).replace(/\n/g, ' ').slice(0, verbose ? 500 : 160)}`);
  console.log(`    lane=${diag.message_lane} intent=${diag.brain_intent} stage=${diag.booking_flow_stage} next=${diag.next_required_field}`);
  console.log(`    quote=${diag.quote_status} avail=${diag.availability_status} pay=${diag.payment_choice} ready=${diag.payment_choice_ready}`);
  console.log(`    action=${diag.proposed_next_action} handoff=${diag.safe_handoff_required}`);
  if (verbose) {
    console.log(`    fields=${JSON.stringify(diag.extracted_fields)}`);
    console.log(`    missing=${JSON.stringify(diag.missing_required_fields)}`);
    if (diag.handoff_reasons.length) console.log(`    handoff_reasons=${JSON.stringify(diag.handoff_reasons)}`);
    if (diag.internal_language.length) console.log(`    internal_language=${JSON.stringify(diag.internal_language)}`);
  }
}

function checkObjectSubset(expected, actual, label) {
  const failures = [];
  if (!expected || typeof expected !== 'object') return failures;
  for (const [key, val] of Object.entries(expected)) {
    const got = actual && actual[key];
    if (got !== val) failures.push(`${label}.${key} expected ${JSON.stringify(val)} got ${JSON.stringify(got)}`);
  }
  return failures;
}

function checkTurnExpectations(expect, out) {
  const failures = [];
  if (!expect || typeof expect !== 'object') return failures;
  const reply = String(out.proposed_luna_reply || (out.result && out.result.proposed_luna_reply) || '');
  const fields = (out.result && out.result.extracted_fields) || {};
  const policy = (out.result && out.result.booking_intake_policy) || {};

  if (Array.isArray(expect.reply_contains)) {
    for (const needle of expect.reply_contains) {
      if (!reply.toLowerCase().includes(String(needle).toLowerCase())) {
        failures.push(`reply_contains "${needle}" missing`);
      }
    }
  }
  if (Array.isArray(expect.reply_not_contains)) {
    for (const needle of expect.reply_not_contains) {
      if (reply.toLowerCase().includes(String(needle).toLowerCase())) {
        failures.push(`reply_not_contains "${needle}" found`);
      }
    }
  }
  failures.push(...checkObjectSubset(expect.expected_fields, fields, 'expected_fields'));
  if (expect.expected_booking_flow_stage != null
    && policy.booking_flow_stage !== expect.expected_booking_flow_stage) {
    failures.push(`expected_booking_flow_stage ${expect.expected_booking_flow_stage} got ${policy.booking_flow_stage}`);
  }
  if (expect.expected_next_required_field != null
    && policy.next_required_field !== expect.expected_next_required_field) {
    failures.push(`expected_next_required_field ${expect.expected_next_required_field} got ${policy.next_required_field}`);
  }
  if (expect.expected_no_handoff === true && isHandoff(out)) {
    failures.push('expected_no_handoff but handoff required');
  }
  if (expect.expected_payment_choice != null) {
    const pc = out.payment_choice && out.payment_choice.payment_choice;
    if (pc !== expect.expected_payment_choice) {
      failures.push(`expected_payment_choice ${expect.expected_payment_choice} got ${pc}`);
    }
  }
  if (expect.expected_quote_ready === true) {
    const qs = out.quote && out.quote.quote_status;
    if (qs !== 'ready') failures.push(`expected_quote_ready but quote_status=${qs}`);
  }
  if (expect.no_internal_language === true) {
    const bad = findInternalLanguage(reply);
    if (bad.length) failures.push(`internal language: ${bad.join(', ')}`);
  }
  return failures;
}

function checkFinalExpectations(finalExpect, lastOut, allTurns) {
  const failures = [];
  if (!finalExpect || typeof finalExpect !== 'object') return failures;
  const reply = String(lastOut.proposed_luna_reply || '');
  const fields = (lastOut.result && lastOut.result.extracted_fields) || {};

  failures.push(...checkObjectSubset(finalExpect.expected_fields, fields, 'final.expected_fields'));

  if (finalExpect.confirmation_sent === false) {
    if (lastOut.confirmation_sent === true) failures.push('confirmation_sent expected false');
    const anyConfirm = allTurns.some((t) => t.confirmation_sent === true);
    if (anyConfirm) failures.push('confirmation_sent true on a turn');
  }
  if (finalExpect.no_internal_language === true) {
    for (const t of allTurns) {
      if (t.internal_language && t.internal_language.length) {
        failures.push(`internal language turn ${t.turn}: ${t.internal_language.join(', ')}`);
      }
    }
  }
  if (finalExpect.no_package_prompt === true) {
    const addonTurn = allTurns.find((t) => /no thanks|own stuff/i.test(t.guest_message));
    if (addonTurn && PACKAGE_NAMES_RE.test(addonTurn.luna_reply)) {
      failures.push('package names appeared during short-stay accommodation-only flow');
    }
  }
  if (finalExpect.no_handoff === true) {
    const handoffTurn = allTurns.find((t) => t.safe_handoff_required);
    if (handoffTurn) failures.push(`handoff on turn ${handoffTurn.turn}`);
    if (isHandoff(lastOut)) failures.push('final handoff required');
  }
  if (finalExpect.expected_payment_choice != null) {
    const pc = lastOut.payment_choice && lastOut.payment_choice.payment_choice;
    if (pc !== finalExpect.expected_payment_choice) {
      failures.push(`final expected_payment_choice ${finalExpect.expected_payment_choice} got ${pc}`);
    }
  }
  if (finalExpect.expected_quote_ready === true) {
    const qs = lastOut.quote && lastOut.quote.quote_status;
    if (qs !== 'ready') failures.push(`final expected_quote_ready but quote_status=${qs}`);
  }
  if (finalExpect.expected_quote_total_cents != null) {
    const cents = lastOut.quote && lastOut.quote.quote_total_cents;
    if (cents !== finalExpect.expected_quote_total_cents) {
      failures.push(`expected_quote_total_cents ${finalExpect.expected_quote_total_cents} got ${cents}`);
    }
  }
  if (finalExpect.booking_created === true && lastOut.creates_booking !== true) {
    failures.push('booking_created expected true');
  }
  if (finalExpect.booking_created === false && lastOut.creates_booking === true) {
    failures.push('booking_created expected false');
  }
  if (finalExpect.payment_link_created === true && lastOut.creates_stripe_link !== true) {
    failures.push('payment_link_created expected true');
  }
  if (finalExpect.payment_link_created === false && lastOut.creates_stripe_link === true) {
    failures.push('payment_link_created expected false');
  }
  return failures;
}

function checkSafetyDefaults(out) {
  const failures = [];
  if (out.dry_run !== true) failures.push(`dry_run expected true got ${out.dry_run}`);
  if (out.sends_whatsapp !== false) failures.push(`sends_whatsapp expected false got ${out.sends_whatsapp}`);
  if (out.live_send_blocked !== true) failures.push(`live_send_blocked expected true got ${out.live_send_blocked}`);
  if (out.calls_n8n === true) failures.push('calls_n8n must not be true');
  if (out.confirmation_sent === true) failures.push('confirmation_sent must not be true');
  return failures;
}

async function runFixture(fixture, opts, fixtureIndex) {
  const contactName = fixture.contact_name || null;
  const referenceDate = fixture.reference_date || opts.referenceDate;
  const phone = `${opts.phonePrefix}${String(fixtureIndex + 1).padStart(2, '0')}`;
  const result = {
    id: fixture.id,
    label: fixture.label || fixture.id,
    phone,
    contact_name: contactName,
    result: 'PASS',
    turns: [],
    failures: [],
    deposit_detected: false,
    internal_language_found: [],
    writes_or_sends: false,
  };

  let guestContext = applyChannelContactName(null, contactName);
  let lastOut = null;

  for (let ti = 0; ti < fixture.turns.length; ti++) {
    const turn = fixture.turns[ti];
    const message = typeof turn === 'string' ? turn : turn.message;
    const input = {
      client_slug: CLIENT_SLUG,
      channel: 'whatsapp',
      message_text: message,
      guest_phone: phone,
      guest_context: guestContext,
      reference_date: referenceDate,
      language_hint: fixture.language || 'en',
      dry_run: !opts.allowWrites,
      automation_gate_context: {
        public_guest_automation_enabled: false,
        whatsapp_dry_run: true,
        live_send_allowed: false,
      },
    };

    lastOut = await withPgClient((pg) => runGuestAutomationOrchestratorDryRun(input, {
      reference_date: referenceDate,
      guest_phone: phone,
      dry_run: !opts.allowWrites,
      pg,
    }));

    const diag = buildTurnDiagnostic(ti, message, lastOut);
    result.turns.push(diag);
    if (diag.payment_choice === 'deposit' || diag.payment_choice === 'full_payment') {
      result.deposit_detected = diag.payment_choice === 'deposit' || result.deposit_detected;
    }
    if (diag.payment_choice_ready && diag.payment_choice === 'deposit') result.deposit_detected = true;
    if (diag.internal_language.length) result.internal_language_found.push(...diag.internal_language);
    if (diag.creates_booking || diag.creates_stripe_link || diag.payment_link_sent || diag.sends_whatsapp) {
      result.writes_or_sends = true;
    }

    const safetyFailures = opts.allowWrites ? [] : checkSafetyDefaults(lastOut);
    const expectFailures = checkTurnExpectations(turn.expect, lastOut);
    const turnFailures = [...safetyFailures, ...expectFailures];

    if (!opts.json) printTurnDiagnostic(diag, opts.verbose);

    if (turnFailures.length > 0) {
      result.failures.push(...turnFailures.map((f) => `turn ${ti + 1}: ${f}`));
      result.result = 'FAIL';
      break;
    }

    guestContext = guestContextFromOrchestrator(lastOut, contactName);
  }

  if (result.result !== 'FAIL' && fixture.final_expect && lastOut) {
    const finalFailures = checkFinalExpectations(fixture.final_expect, lastOut, result.turns);
    if (finalFailures.length > 0) {
      result.failures.push(...finalFailures.map((f) => `final: ${f}`));
      result.result = 'FAIL';
    }
  }

  return result;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    usage();
    process.exit(0);
  }

  if (opts.allowWrites) {
    try {
      assertNotProduction();
    } catch (e) {
      console.error(`FAIL — ${e.message}`);
      process.exit(1);
    }
  }

  if (!opts.all && !opts.fixture) {
    console.error('Specify --all or --fixture <name>');
    usage();
    process.exit(1);
  }

  const fixtures = filterFixtures(loadFixtures(opts.fixtureDir), opts);
  if (fixtures.length === 0) {
    console.error('No fixtures matched.');
    process.exit(1);
  }

  const report = {
    result: 'PASS',
    mode: opts.allowWrites ? 'allow_writes' : 'dry_run_review_only',
    fixture_dir: opts.fixtureDir,
    reference_date: opts.referenceDate,
    total: fixtures.length,
    passed: 0,
    failed: 0,
    fixtures: [],
    first_failure: null,
  };

  if (!opts.json) {
    console.log('\n── Luna Conversation State-Machine Tests ──');
    console.log(`Mode: ${report.mode} · Fixtures: ${fixtures.length}`);
  }

  for (let i = 0; i < fixtures.length; i++) {
    const fx = fixtures[i];
    if (!opts.json) console.log(`\n▶ ${fx.id} — ${fx.label || fx.id}`);
    let fxResult;
    try {
      fxResult = await runFixture(fx, opts, i);
    } catch (err) {
      fxResult = {
        id: fx.id,
        result: 'FAIL',
        failures: [err.message || String(err)],
        turns: [],
      };
    }
    report.fixtures.push(fxResult);
    if (fxResult.result === 'PASS') report.passed++;
    else {
      report.failed++;
      report.result = 'FAIL';
      if (!report.first_failure) {
        report.first_failure = { id: fxResult.id, failures: fxResult.failures };
      }
      if (!opts.json) {
        console.log(`  FAIL  ${fxResult.id}`);
        for (const f of fxResult.failures) console.log(`         ${f}`);
      }
    }
    if (fxResult.result === 'PASS' && !opts.json) {
      console.log(`  PASS  ${fxResult.id} · deposit=${fxResult.deposit_detected} · writes/sends=${fxResult.writes_or_sends}`);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n── Result: ${report.result} ──`);
    console.log(`Passed: ${report.passed} · Failed: ${report.failed} / ${report.total}`);
  }

  process.exit(report.result === 'PASS' ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
