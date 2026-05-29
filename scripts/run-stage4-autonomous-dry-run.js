/**
 * Stage 4 Autonomous Booking Dry-Run — scenario validator and planning runner.
 *
 * CURRENT BEHAVIOUR (scaffold only):
 *   Reads A1–A10 scenario JSON files, validates their schema, prints a per-scenario
 *   summary, and writes a planning report to reports/stage4-autonomous-dry-run-plan.json.
 *   Does NOT POST to n8n. Does NOT activate workflows. Does NOT touch the database.
 *
 * FUTURE BEHAVIOUR (when --execute is implemented):
 *   Iterate through each scenario's turns, POST each turn's post_body to the webhook,
 *   wait for the n8n execution to complete, capture state, assert counts and safety.
 *   Implementation notes are in test-payloads/stage4/autonomous-dry-run/README.md.
 *
 * Usage:
 *   node scripts/run-stage4-autonomous-dry-run.js           (validate + plan report)
 *   node scripts/run-stage4-autonomous-dry-run.js --only A3  (single scenario validate)
 *   node scripts/run-stage4-autonomous-dry-run.js --execute   (exits: not implemented)
 *
 * SAFETY: This script NEVER POSTs, activates workflows, or connects to the database
 * unless explicitly extending with --execute (which currently exits immediately).
 *
 * Non-negotiables carried from Stage 3y:
 *   - Real WhatsApp send is NOT approved.
 *   - Live autonomous operation is NOT approved.
 *   - No workflow activation in this runner.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ── CLI args ──────────────────────────────────────────────────────────────────

const ARGS = process.argv.slice(2);
const ARGS_SET = new Set(ARGS);

if (ARGS_SET.has('--execute')) {
  console.error('\n--execute: Stage 4 execution not implemented yet.');
  console.error('Stub shapes and multi-turn sequencing must be completed first.');
  console.error('See test-payloads/stage4/autonomous-dry-run/README.md § Required implementation changes.');
  process.exit(1);
}

const ONLY_IDX = ARGS.indexOf('--only');
const ONLY_RAW = ONLY_IDX !== -1 ? ARGS[ONLY_IDX + 1] : null;
const normaliseId = (s) => String(s || '').toLowerCase().replace(/^[-\s]+|[-\s]+$/g, '');
const ONLY_FILTER = ONLY_RAW ? normaliseId(ONLY_RAW) : null;

// ── Paths ─────────────────────────────────────────────────────────────────────

const PAYLOAD_DIR = path.join(__dirname, '..', 'test-payloads', 'stage4', 'autonomous-dry-run');
const REPORT_PATH = path.join(__dirname, '..', 'reports', 'stage4-autonomous-dry-run-plan.json');

// Canonical run order
const SCENARIO_ORDER = [
  'a1-complete-package-deposit.json',
  'a2-missing-package-then-supplied.json',
  'a3-deposit-selected.json',
  'a4-full-payment-selected.json',
  'a5-unavailable-dates-closed-month.json',
  'a6-claims-paid-no-stripe-record.json',
  'a7-cancellation-refund-handoff.json',
  'a8-rooming-preference-during-booking.json',
  'a9-addons-lessons-rentals-yoga.json',
  'a10-spanish-booking-request.json',
];

// ── Schema validation ─────────────────────────────────────────────────────────

const REQUIRED_TOP_KEYS = ['_meta', 'turns', 'expected_final_state', 'assertions'];
const REQUIRED_META_KEYS = ['scenario_id', 'title', 'stage', 'mode', 'goal'];
const REQUIRED_TURN_KEYS = ['turn_id', 'guest_message', 'post_body', 'expected_route', 'forbidden_live_actions'];
const REQUIRED_FORBIDDEN_KEYS = ['no_real_whatsapp_send'];

function validateScenario(scenario, file) {
  const errors = [];

  for (const k of REQUIRED_TOP_KEYS) {
    if (!(k in scenario)) errors.push(`missing top-level key: ${k}`);
  }

  const meta = scenario._meta ?? {};
  for (const k of REQUIRED_META_KEYS) {
    if (!(k in meta)) errors.push(`_meta missing key: ${k}`);
  }

  if (!Array.isArray(scenario.turns) || scenario.turns.length === 0) {
    errors.push('turns must be a non-empty array');
    return errors;
  }

  for (const [i, turn] of scenario.turns.entries()) {
    const prefix = `turns[${i}] (${turn.turn_id ?? 'unknown'})`;
    for (const k of REQUIRED_TURN_KEYS) {
      if (!(k in turn)) errors.push(`${prefix} missing key: ${k}`);
    }

    if (turn.post_body) {
      const hasEntry = Array.isArray(turn.post_body?.entry) && turn.post_body.entry.length > 0;
      if (!hasEntry) errors.push(`${prefix} post_body missing entry[]`);

      try {
        const msg = turn.post_body.entry[0].changes[0].value.messages[0];
        if (!msg.from) errors.push(`${prefix} post_body message missing 'from'`);
        if (!msg.id) errors.push(`${prefix} post_body message missing 'id' (wamid)`);
        if (!msg.text?.body) errors.push(`${prefix} post_body message missing text.body`);
      } catch {
        errors.push(`${prefix} post_body is not valid Meta-envelope shape`);
      }
    }

    const forbidden = turn.forbidden_live_actions ?? {};
    for (const k of REQUIRED_FORBIDDEN_KEYS) {
      if (!(k in forbidden)) errors.push(`${prefix} forbidden_live_actions missing: ${k}`);
    }

    if (turn.expected_confidence_min !== undefined) {
      if (typeof turn.expected_confidence_min !== 'number' || turn.expected_confidence_min < 0 || turn.expected_confidence_min > 1) {
        errors.push(`${prefix} expected_confidence_min must be a number in [0, 1]`);
      }
    }
  }

  // Check that all turns in the same scenario use the same phone number (multi-turn identity)
  const phones = new Set();
  for (const turn of scenario.turns) {
    try {
      const from = turn.post_body.entry[0].changes[0].value.messages[0].from;
      phones.add(from);
    } catch { /* ignore */ }
  }
  if (phones.size > 1) {
    errors.push(
      `multi-turn identity violation: turns use different 'from' phone numbers (${[...phones].join(', ')}). ` +
      'All turns in a scenario must use the same phone number to preserve conversation state.'
    );
  }

  // Check for real wamids that look like production Meta IDs
  for (const [i, turn] of scenario.turns.entries()) {
    try {
      const wamid = turn.post_body.entry[0].changes[0].value.messages[0].id;
      if (/^wamid\.[A-Z][A-Za-z0-9+/]{20,}$/.test(wamid)) {
        errors.push(`turns[${i}] wamid looks like a real Meta-issued ID: ${wamid} — use a test wamid like wamid.4A1-T1-TEST001`);
      }
    } catch { /* ignore */ }
  }

  return errors;
}

// ── Config expectations checks ────────────────────────────────────────────────

// Known config values from wolfhouse-somo.baseline.json v0.6 for assertion cross-check
const KNOWN_CONFIG = {
  deposit_standard_eur: 200,
  deposit_custom_short_eur: 100,
  prices_shoulder: { malibu: 249, uluwatu: 349, waimea: 499 },
  prices_high:     { malibu: 299, uluwatu: 399, waimea: 549 },
  prices_peak:     { malibu: 349, uluwatu: 449, waimea: 599 },
  surf_lesson_1st_eur: 35,
  surf_lesson_2plus_eur: 30,
  yoga_eur: 15,
  closed_months: ['december', 'january', 'february'],
  gate_code: '2684#',
  check_in_time: '15:00',
  check_out_time: '11:00',
};

function checkConfigExpectations(scenario) {
  const warnings = [];
  const ce = scenario.config_expectations ?? {};

  // Deposit check
  if ('deposit_eur' in ce && ce.deposit_rule === 'standard_package') {
    if (ce.deposit_eur !== KNOWN_CONFIG.deposit_standard_eur) {
      warnings.push(
        `config_expectations.deposit_eur = ${ce.deposit_eur} but known standard_package deposit is ${KNOWN_CONFIG.deposit_standard_eur}`
      );
    }
  }

  // Package price check
  if ('price_per_person_eur' in ce && ce.season && ce.package_key) {
    const known = KNOWN_CONFIG[`prices_${ce.season}`]?.[ce.package_key];
    if (known !== undefined && ce.price_per_person_eur !== known) {
      warnings.push(
        `config_expectations.price_per_person_eur = ${ce.price_per_person_eur} for ${ce.package_key} ${ce.season} but known value is ${known}`
      );
    }
  }

  // Total check (per person × guest count × nights / 7, only for 7-night)
  if ('total_eur' in ce && ce.nights === 7 && ce.guest_count && ce.price_per_person_eur) {
    const expected = ce.price_per_person_eur * (ce.guest_count ?? 1);
    if (ce.total_eur !== expected) {
      warnings.push(
        `config_expectations.total_eur = ${ce.total_eur} but ${ce.price_per_person_eur} × ${ce.guest_count} = ${expected}`
      );
    }
  }

  // Closed month check
  if (ce.month && ce.closed_month === true) {
    if (!KNOWN_CONFIG.closed_months.includes(ce.month)) {
      warnings.push(
        `config_expectations.month = "${ce.month}" is listed as closed_month: true but it is not in known_config.closed_months`
      );
    }
  }

  return warnings;
}

// ── Summary printing ──────────────────────────────────────────────────────────

function printScenarioSummary(scenario, errors, warnings) {
  const meta = scenario._meta ?? {};
  const id = meta.scenario_id ?? '?';
  const title = meta.title ?? '(untitled)';
  const turns = scenario.turns?.length ?? 0;
  const status = errors.length === 0 ? 'OK' : 'INVALID';

  console.log(`\n  ${status === 'OK' ? '✓' : '✗'}  ${id}: ${title}`);
  console.log(`     Turns: ${turns} | Goal: ${(meta.goal ?? '').slice(0, 80)}${(meta.goal ?? '').length > 80 ? '…' : ''}`);

  for (const e of errors) {
    console.error(`     ERROR: ${e}`);
  }
  for (const w of warnings) {
    console.warn(`     WARN:  ${w}`);
  }

  if (errors.length === 0) {
    // Print turn summary
    for (const turn of scenario.turns ?? []) {
      const tId = turn.turn_id ?? '?';
      const msg = (turn.guest_message ?? '').slice(0, 60);
      const route = turn.expected_route ?? '?';
      const missingCount = (turn.expected_missing_fields ?? []).length;
      console.log(`     ${tId}: "${msg}${msg.length >= 60 ? '…' : ''}" → ${route} | missing: ${missingCount}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  console.log('\n' + '═'.repeat(70));
  console.log(' Stage 4 Autonomous Booking Dry-Run — Scenario Validator');
  console.log(' Mode: VALIDATE + PLAN (no runtime, no POST, no DB)');
  console.log('═'.repeat(70));

  // Resolve which scenarios to process
  function matchesOnly(filename, filter) {
    const base = normaliseId(filename.replace(/\.json$/i, ''));
    if (base === filter) return true;
    if (base.startsWith(filter + '-')) return true;
    // Match on scenario ID like "a3" against "a3-deposit-selected"
    const scenarioId = base.split('-')[0];
    if (scenarioId === filter) return true;
    return false;
  }

  let filesToProcess = [...SCENARIO_ORDER];
  if (ONLY_FILTER) {
    filesToProcess = SCENARIO_ORDER.filter((f) => matchesOnly(f, ONLY_FILTER));
    if (!filesToProcess.length) {
      console.error(`\n--only "${ONLY_RAW}": no scenario matches filter "${ONLY_FILTER}".`);
      console.error(`Available: ${SCENARIO_ORDER.map((f) => f.replace('.json', '')).join(', ')}`);
      process.exit(1);
    }
    console.log(`\n--only filter: validating ${filesToProcess.length} scenario(s): ${filesToProcess.join(', ')}`);
  }

  const report = {
    generated_at: new Date().toISOString(),
    runner: 'run-stage4-autonomous-dry-run.js',
    mode: 'validate_and_plan',
    note: 'Scaffold only. --execute not yet implemented. See README for required stub changes.',
    filter: ONLY_FILTER ? { only: ONLY_RAW, matched: filesToProcess } : null,
    real_whatsapp_send_approved: false,
    live_autonomous_operation_approved: false,
    payload_dir: PAYLOAD_DIR,
    scenarios: [],
    summary: {
      total: 0,
      valid: 0,
      invalid: 0,
      total_turns: 0,
      scenarios_with_warnings: 0,
    },
  };

  let totalErrors = 0;

  console.log('\nScenarios:');

  for (const file of filesToProcess) {
    const filePath = path.join(PAYLOAD_DIR, file);
    const scenarioId = file.replace('.json', '');

    const entry = {
      file,
      scenario_id: null,
      valid: false,
      errors: [],
      warnings: [],
      turns_count: 0,
      config_expectations: null,
      stub_shapes_required: [],
    };

    if (!fs.existsSync(filePath)) {
      entry.errors.push('payload file not found');
      report.scenarios.push(entry);
      totalErrors++;
      console.error(`\n  ✗  ${scenarioId}: FILE NOT FOUND`);
      continue;
    }

    let scenario;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      scenario = JSON.parse(raw);
    } catch (e) {
      entry.errors.push(`JSON parse failed: ${e.message}`);
      report.scenarios.push(entry);
      totalErrors++;
      console.error(`\n  ✗  ${scenarioId}: JSON PARSE ERROR — ${e.message}`);
      continue;
    }

    entry.scenario_id = scenario._meta?.scenario_id ?? null;
    entry.turns_count = scenario.turns?.length ?? 0;
    entry.config_expectations = scenario.config_expectations ?? null;

    const errors = validateScenario(scenario, file);
    const warnings = checkConfigExpectations(scenario);

    entry.valid = errors.length === 0;
    entry.errors = errors;
    entry.warnings = warnings;

    // Extract stub shape requirements from stub_overrides keys
    if (scenario.stub_overrides && typeof scenario.stub_overrides === 'object') {
      entry.stub_shapes_required = Object.keys(scenario.stub_overrides).filter((k) => !k.startsWith('_'));
    }

    printScenarioSummary(scenario, errors, warnings);

    if (errors.length > 0) totalErrors += errors.length;
    if (warnings.length > 0) report.summary.scenarios_with_warnings++;

    report.scenarios.push(entry);
    report.summary.total++;
    if (entry.valid) report.summary.valid++; else report.summary.invalid++;
    report.summary.total_turns += entry.turns_count;
  }

  // ── Stub shape requirements summary ───────────────────────────────────────
  const allStubShapes = new Set();
  for (const s of report.scenarios) {
    for (const shape of s.stub_shapes_required ?? []) allStubShapes.add(shape);
  }

  report.stub_shapes_required_across_scenarios = [...allStubShapes];

  report.required_implementation_changes = [
    'hold_stub: must return pg_ok=true + booking_id/booking_code/status/expires_in_minutes/amounts (scripts/build-main-local-stripe.js)',
    'payment_link_stub: must return checkout_url/session_id/amount_cents/currency/payment_kind (scripts/build-main-local-stripe.js)',
    'stripe_webhook_dry_run_path: webhook handler must accept simulated event and proceed through confirmation path',
    'confirmation_stub: must expose draft_text including address/gate_code/room_number from config (not bed_number)',
    'conversation_state_persistence: verify Turn 2 can read session data written in Turn 1 when Airtable is stubbed',
    'closed_month_guard: verify packages.closed_months is checked before hold creation in booking_flow',
    'spanish_language_detection: verify language=es triggers Spanish reply generation',
    'runner_multi_turn_post_sequencing: extend runner to POST each turn sequentially and poll for execution completion',
  ];

  // ── Write report ───────────────────────────────────────────────────────────
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log('\n' + '─'.repeat(70));
  console.log(`Scenarios: ${report.summary.valid}/${report.summary.total} valid | Total turns: ${report.summary.total_turns}`);
  console.log(`Stub shapes required: ${[...allStubShapes].join(', ')}`);
  console.log(`Report: ${REPORT_PATH}`);

  if (totalErrors > 0) {
    console.error(`\n✗ ${totalErrors} validation error(s). Fix payload files before runtime.`);
    process.exit(1);
  }

  console.log('\n✓ All scenarios valid. Ready for stub implementation and runner extension.');
  console.log('  Next: implement stub shapes in scripts/build-main-local-stripe.js');
  console.log('  See test-payloads/stage4/autonomous-dry-run/README.md for details.');
  console.log('\nNOTE: No runtime performed. --execute exits with "not implemented yet".');
}

main();
