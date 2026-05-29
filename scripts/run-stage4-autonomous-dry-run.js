/**
 * Stage 4 Autonomous Booking Dry-Run — scenario validator and planning runner.
 *
 * CURRENT BEHAVIOUR:
 *   Reads A1–A10 scenario JSON files, validates their schema, prints a per-scenario
 *   summary, and writes a planning report to reports/stage4-autonomous-dry-run-plan.json.
 *   Does NOT POST to n8n. Does NOT activate workflows. Does NOT touch the database.
 *
 * EXECUTE BEHAVIOUR (--execute):
 *   Builds a full preflight for the selected scenario/turn (validates WHATSAPP_DRY_RUN,
 *   resolves webhook URL, prints post_body preview, lists expected nodes to verify).
 *   Does NOT POST — a POST guard is active. Remove the guard or add --run to enable.
 *   This mode is designed so tomorrow's A1 turn-1 runtime gate only needs --run added.
 *
 * Usage:
 *   node scripts/run-stage4-autonomous-dry-run.js                            (validate all)
 *   node scripts/run-stage4-autonomous-dry-run.js --only A1                  (validate A1 only)
 *   node scripts/run-stage4-autonomous-dry-run.js --only A1 --turn 1         (validate A1 turn 1)
 *   node scripts/run-stage4-autonomous-dry-run.js --only A1 --turn 1 --execute (preflight, no POST)
 *
 * SAFETY: This script NEVER POSTs, activates workflows, or connects to the database
 * unless a future --run flag is added and the POST guard is removed.
 *
 * Non-negotiables carried from Stage 3y:
 *   - Real WhatsApp send is NOT approved.
 *   - Live autonomous operation is NOT approved.
 *   - No workflow activation in this runner.
 *   - WHATSAPP_DRY_RUN must be 'true' before --execute is meaningful.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ── CLI args ──────────────────────────────────────────────────────────────────

const ARGS = process.argv.slice(2);
const ARGS_SET = new Set(ARGS);

const ONLY_IDX = ARGS.indexOf('--only');
const ONLY_RAW = ONLY_IDX !== -1 ? ARGS[ONLY_IDX + 1] : null;
const normaliseId = (s) => String(s || '').toLowerCase().replace(/^[-\s]+|[-\s]+$/g, '');
const ONLY_FILTER = ONLY_RAW ? normaliseId(ONLY_RAW) : null;

const TURN_IDX = ARGS.indexOf('--turn');
const TURN_RAW = TURN_IDX !== -1 ? ARGS[TURN_IDX + 1] : null;
const TURN_FILTER = TURN_RAW ? normaliseId(TURN_RAW) : null;

const EXECUTE_MODE = ARGS_SET.has('--execute');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PAYLOAD_DIR = path.join(__dirname, '..', 'test-payloads', 'stage4', 'autonomous-dry-run');
const REPORT_PATH = path.join(__dirname, '..', 'reports', 'stage4-autonomous-dry-run-plan.json');

// Webhook defaults — override with N8N_WEBHOOK_BASE_URL env var
const DEFAULT_WEBHOOK_BASE = 'http://localhost:5678';
const WEBHOOK_PATH = '/webhook/booking-assistant';

// Expected nodes to verify after A1 turn-1 execution
const EXPECTED_NODES_TO_VERIFY = [
  'IF - PG Hold OK',
  'IF - Booking ID Ready',
  'Code - DRY RUN Stub (Postgres - Ensure Booking In Postgres)',
  'Code - Call Create Payment Session (dry-run branch)',
];

// Tables that must have zero mutations in any dry-run execution
const EXPECTED_NO_MUTATION_TABLES = [
  'bookings',
  'payments',
  'payment_events',
  'booking_beds',
];

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

  // Total check (per person x guest count x nights / 7, only for 7-night)
  if ('total_eur' in ce && ce.nights === 7 && ce.guest_count && ce.price_per_person_eur) {
    const expected = ce.price_per_person_eur * (ce.guest_count ?? 1);
    if (ce.total_eur !== expected) {
      warnings.push(
        `config_expectations.total_eur = ${ce.total_eur} but ${ce.price_per_person_eur} x ${ce.guest_count} = ${expected}`
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

function printScenarioSummary(scenario, errors, warnings, activeTurnFilter) {
  const meta = scenario._meta ?? {};
  const id = meta.scenario_id ?? '?';
  const title = meta.title ?? '(untitled)';
  const turns = scenario.turns?.length ?? 0;
  const status = errors.length === 0 ? 'OK' : 'INVALID';

  console.log(`\n  ${status === 'OK' ? 'OK' : 'INVALID'}  ${id}: ${title}`);
  console.log(`     Turns: ${turns} | Goal: ${(meta.goal ?? '').slice(0, 80)}${(meta.goal ?? '').length > 80 ? '...' : ''}`);

  for (const e of errors) {
    console.error(`     ERROR: ${e}`);
  }
  for (const w of warnings) {
    console.warn(`     WARN:  ${w}`);
  }

  if (errors.length === 0) {
    for (const turn of scenario.turns ?? []) {
      const tId = turn.turn_id ?? '?';
      const msg = (turn.guest_message ?? '').slice(0, 60);
      const route = turn.expected_route ?? '?';
      const missingCount = (turn.expected_missing_fields ?? []).length;
      const isFocused = activeTurnFilter && normaliseId(String(tId)) === activeTurnFilter;
      const marker = isFocused ? '  --> ' : '      ';
      console.log(`   ${marker}${tId}: "${msg}${msg.length >= 60 ? '...' : ''}" => ${route} | missing: ${missingCount}`);
    }
  }
}

// ── Execute preflight ─────────────────────────────────────────────────────────

function buildExecutePreflight(scenario, turn) {
  const meta = scenario._meta ?? {};
  const webhookBase = process.env.N8N_WEBHOOK_BASE_URL || DEFAULT_WEBHOOK_BASE;
  const webhookUrl = webhookBase.replace(/\/$/, '') + WEBHOOK_PATH;

  const dryRunEnv = String(process.env.WHATSAPP_DRY_RUN || '').toLowerCase();
  const dryRunOk = dryRunEnv === 'true';

  const preflight = {
    scenario_id: meta.scenario_id,
    turn_id: turn.turn_id,
    webhook_url: webhookUrl,
    whatsapp_dry_run_env: dryRunEnv || '(not set)',
    whatsapp_dry_run_ok: dryRunOk,
    post_body_preview: JSON.stringify(turn.post_body).slice(0, 300) + '...',
    expected_route: turn.expected_route,
    expected_nodes_to_verify: EXPECTED_NODES_TO_VERIFY,
    expected_no_mutation_tables: EXPECTED_NO_MUTATION_TABLES,
    forbidden_live_actions: turn.forbidden_live_actions,
    preflight_errors: [],
    post_guard_active: true,
    post_guard_reason: 'Execution scaffolding ready. Stage 4 POST guard is active — runtime not yet started.',
  };

  if (!dryRunOk) {
    preflight.preflight_errors.push(
      'WHATSAPP_DRY_RUN is not "true" — refusing to execute. Set WHATSAPP_DRY_RUN=true before running.'
    );
  }

  if (!turn.post_body || !Array.isArray(turn.post_body.entry) || turn.post_body.entry.length === 0) {
    preflight.preflight_errors.push('post_body is missing or has no entry[] — cannot POST');
  }

  return preflight;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  console.log('\n' + '='.repeat(70));
  console.log(' Stage 4 Autonomous Booking Dry-Run — Scenario Validator');
  console.log(' Mode: ' + (EXECUTE_MODE ? 'PREFLIGHT (no POST — post guard active)' : 'VALIDATE + PLAN (no runtime, no POST, no DB)'));
  console.log('='.repeat(70));

  if (TURN_FILTER && !ONLY_FILTER) {
    console.error('\n--turn requires --only <scenario_id> to be specified.');
    console.error('Example: --only a1 --turn 1');
    process.exit(1);
  }

  // Resolve which scenarios to process
  function matchesOnly(filename, filter) {
    const base = normaliseId(filename.replace(/\.json$/i, ''));
    if (base === filter) return true;
    if (base.startsWith(filter + '-')) return true;
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
    console.log(`\n--only filter: ${filesToProcess.length} scenario(s): ${filesToProcess.join(', ')}`);
  }

  if (TURN_FILTER) {
    console.log(`--turn filter: turn_id matching "${TURN_RAW}"`);
  }

  if (EXECUTE_MODE) {
    console.log('\nNOTE: --execute passed. Preflight will be shown but POST guard is active.');
    console.log('      WHATSAPP_DRY_RUN must be "true" for preflight to pass.');
    if (!ONLY_FILTER || !TURN_FILTER) {
      console.error('\n--execute requires both --only <scenario_id> and --turn <turn_id>.');
      console.error('Example: --only a1 --turn 1 --execute');
      process.exit(1);
    }
  }

  const webhookBase = process.env.N8N_WEBHOOK_BASE_URL || DEFAULT_WEBHOOK_BASE;
  const plannedWebhookUrl = webhookBase.replace(/\/$/, '') + WEBHOOK_PATH;

  const report = {
    generated_at: new Date().toISOString(),
    runner: 'run-stage4-autonomous-dry-run.js',
    mode: EXECUTE_MODE ? 'preflight' : 'validate_and_plan',
    note: EXECUTE_MODE
      ? 'Preflight mode. POST guard is active — execution not yet started.'
      : 'Validate + plan mode. No runtime performed.',
    filter: ONLY_FILTER
      ? { only: ONLY_RAW, matched: filesToProcess, turn: TURN_RAW ?? null }
      : null,
    selected_scenario: ONLY_FILTER ?? null,
    selected_turn: TURN_FILTER ?? null,
    planned_webhook_url: plannedWebhookUrl,
    expected_nodes_to_verify: EXPECTED_NODES_TO_VERIFY,
    expected_no_mutation_tables: EXPECTED_NO_MUTATION_TABLES,
    real_whatsapp_send_approved: false,
    live_autonomous_operation_approved: false,
    payload_dir: PAYLOAD_DIR,
    scenarios: [],
    execute_preflight: null,
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
      console.error(`\n  MISSING  ${scenarioId}: FILE NOT FOUND`);
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
      console.error(`\n  ERROR  ${scenarioId}: JSON PARSE ERROR -- ${e.message}`);
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

    printScenarioSummary(scenario, errors, warnings, TURN_FILTER);

    if (errors.length > 0) totalErrors += errors.length;
    if (warnings.length > 0) report.summary.scenarios_with_warnings++;

    report.scenarios.push(entry);
    report.summary.total++;
    if (entry.valid) report.summary.valid++; else report.summary.invalid++;
    report.summary.total_turns += entry.turns_count;

    // ── Execute preflight (only when --execute + --only + --turn) ─────────────
    if (EXECUTE_MODE && ONLY_FILTER && TURN_FILTER && entry.valid) {
      const matchedTurns = (scenario.turns ?? []).filter((t) => {
        const tid = normaliseId(String(t.turn_id ?? ''));
        // Match by various forms: "1" matches "1", "t1", "a1-t1", "turn-1"
        if (tid === TURN_FILTER) return true;                        // exact
        if (tid === 't' + TURN_FILTER) return true;                  // "t1"
        if (tid.endsWith('-t' + TURN_FILTER)) return true;           // "a1-t1"
        if (tid.endsWith('-' + TURN_FILTER)) return true;            // "turn-1"
        // Match trailing numeric: "a1-t1" numeric suffix = "1"
        const numericSuffix = tid.replace(/^.*?(\d+)$/, '$1');
        if (numericSuffix === TURN_FILTER) return true;
        return false;
      });

      if (matchedTurns.length === 0) {
        console.error(`\n--turn "${TURN_RAW}": no turn matches in scenario ${entry.scenario_id}.`);
        console.error(`Available turns: ${(scenario.turns ?? []).map((t) => t.turn_id).join(', ')}`);
        process.exit(1);
      }

      const selectedTurn = matchedTurns[0];
      const preflight = buildExecutePreflight(scenario, selectedTurn);
      report.execute_preflight = preflight;

      console.log('\n' + '-'.repeat(70));
      console.log(' EXECUTE PREFLIGHT');
      console.log('-'.repeat(70));
      console.log(`  Scenario:     ${preflight.scenario_id}`);
      console.log(`  Turn:         ${preflight.turn_id}`);
      console.log(`  Webhook URL:  ${preflight.webhook_url}`);
      console.log(`  DRY_RUN env:  ${preflight.whatsapp_dry_run_env} (ok: ${preflight.whatsapp_dry_run_ok})`);
      console.log(`  Route:        ${preflight.expected_route}`);
      console.log(`  POST body preview:\n    ${preflight.post_body_preview}`);
      console.log('\n  Nodes to verify after execution:');
      for (const n of preflight.expected_nodes_to_verify) {
        console.log(`    - ${n}`);
      }
      console.log('\n  No-mutation tables:');
      for (const t of preflight.expected_no_mutation_tables) {
        console.log(`    - ${t}`);
      }

      if (preflight.preflight_errors.length > 0) {
        console.error('\n  PREFLIGHT ERRORS:');
        for (const e of preflight.preflight_errors) {
          console.error(`    ! ${e}`);
        }
        console.error('\n  Preflight FAILED. Fix errors above before running.');
        process.exit(1);
      }
    }
  }

  // ── Stub shape requirements summary ───────────────────────────────────────
  const allStubShapes = new Set();
  for (const s of report.scenarios) {
    for (const shape of s.stub_shapes_required ?? []) allStubShapes.add(shape);
  }

  report.stub_shapes_required_across_scenarios = [...allStubShapes];

  report.required_implementation_changes = [
    '[DONE] hold_stub: returns pg_ok=true + booking_id/booking_code/status/payment_status/session fields (scripts/build-main-local-stripe.js)',
    '[DONE] payment_link_stub: returns checkout_url/session_id/amount_due_cents/currency/payment_kind via inline CPS check (scripts/build-main-local-stripe.js)',
    '[DONE] Postgres - Ensure Booking In Postgres gated as dry-run gate 70',
    '[PENDING] stripe_webhook_dry_run_path: webhook handler must accept simulated event and proceed through confirmation path',
    '[PENDING] confirmation_stub: must expose draft_text including address/gate_code/room_number from config',
    '[PENDING] conversation_state_persistence: verify Turn 2 can read session data written in Turn 1 when Airtable is stubbed',
    '[PENDING] closed_month_guard: verify packages.closed_months is checked before hold creation in booking_flow',
    '[PENDING] spanish_language_detection: verify language=es triggers Spanish reply generation',
    '[PENDING] runner_multi_turn_post_sequencing: extend runner to POST each turn sequentially and poll for execution completion',
  ];

  // ── Write report ───────────────────────────────────────────────────────────
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log('\n' + '-'.repeat(70));
  console.log(`Scenarios: ${report.summary.valid}/${report.summary.total} valid | Total turns: ${report.summary.total_turns}`);
  if (ONLY_FILTER) console.log(`Selected scenario: ${ONLY_FILTER} | Selected turn: ${TURN_FILTER ?? '(all)'}`);
  console.log(`Planned webhook: ${plannedWebhookUrl}`);
  console.log(`Report: ${REPORT_PATH}`);

  if (totalErrors > 0) {
    console.error(`\nFAIL: ${totalErrors} validation error(s). Fix payload files before runtime.`);
    process.exit(1);
  }

  console.log('\nOK: All scenarios valid.');

  if (EXECUTE_MODE && report.execute_preflight) {
    const pf = report.execute_preflight;
    if (pf.preflight_errors.length === 0) {
      console.log('\nPREFLIGHT OK.');
      console.log(`  Scenario ${pf.scenario_id} turn ${pf.turn_id} is ready to POST to ${pf.webhook_url}`);
      console.log('  POST guard is active — Stage 4 runtime not yet started.');
      console.log('  To run tomorrow: activate local Main, ensure WHATSAPP_DRY_RUN=true,');
      console.log('  then add --run flag (or remove POST guard) to execute.');
    }
  } else if (!EXECUTE_MODE) {
    console.log('  Next: --only a1 --turn 1 --execute to verify A1 turn-1 preflight.');
    console.log('  Then: runtime gate 1 (activate Main + --run).');
    console.log('\nNOTE: No runtime performed. POST guard active until --run is added.');
  }
}

main();
