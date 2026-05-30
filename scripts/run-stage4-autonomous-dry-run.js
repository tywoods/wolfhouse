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
 * Multi-turn PG conversation state (A2/A3/A4):
 *   These scenarios require T2 to read T1 state from Postgres. The runner provides:
 *   - seedConversationState(pgClient, phone, sessionState): upserts a row into
 *     conversations (wolfhouse-somo client, phone, session_state).
 *   - teardownConversationState(pgClient, phones): deletes rows by phone.
 *   Both functions are implementation-only; they are guarded and never called in
 *   validation-only mode. In --run mode, they will be invoked between turns.
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
const RUN_MODE = ARGS_SET.has('--run'); // POST guard lifted — actually sends the request

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

// ── HTTP POST + execution poll helpers ────────────────────────────────────────

function postWebhook(webhookUrl, body) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(webhookUrl);
    const opts = {
      hostname: url.hostname, port: parseInt(url.port) || 5678,
      path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = http.request(opts, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function pollExecution(afterExecId, timeoutMs = 75000) {
  const { Client } = require('pg');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 3000));
    const c = new Client({
      host: 'localhost', port: 5434, database: 'n8n',
      user: 'n8n', password: process.env.N8N_DB_PASSWORD || '37AwT5X0pHgCVEO',
    });
    try {
      await c.connect();
      const r = await c.query(
        `SELECT e.id, e.status, e."workflowId", e."startedAt", e."stoppedAt",
                ed.data as exec_data
         FROM execution_entity e
         LEFT JOIN execution_data ed ON ed."executionId" = e.id
         WHERE e."workflowId" = 'RBfGNtVgrAkvhBHJ' AND e.id > $1
         ORDER BY e.id DESC LIMIT 1`,
        [afterExecId]
      );
      await c.end();
      if (r.rows.length) {
        const s = r.rows[0].status;
        if (s === 'success' || s === 'error' || s === 'crashed') return r.rows[0];
      }
    } catch (e) {
      try { await c.end(); } catch {}
    }
  }
  return null;
}

async function getBaselineExecId() {
  const { Client } = require('pg');
  const c = new Client({
    host: 'localhost', port: 5434, database: 'n8n',
    user: 'n8n', password: process.env.N8N_DB_PASSWORD || '37AwT5X0pHgCVEO',
  });
  await c.connect();
  const r = await c.query("SELECT COALESCE(MAX(id), 0) as max_id FROM execution_entity WHERE \"workflowId\" = 'RBfGNtVgrAkvhBHJ'");
  await c.end();
  return Number(r.rows[0].max_id);
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

// ── Multi-turn PG conversation state (A2/A3/A4) ──────────────────────────────

// Client slug used for Stage 4 dry-run conversation seeds.
const STAGE4_CLIENT_SLUG = 'wolfhouse-somo';

// Tables that may change during multi-turn dry-run (conversations, messages).
// These are NOT protected business tables and changes are expected/allowed.
const ALLOWED_STATE_TABLE_DELTAS = ['conversations', 'messages', 'workflow_events'];

// Tables that must NEVER change in any Stage 4 dry-run execution.
const PROTECTED_NO_MUTATION_TABLES = ['bookings', 'payments', 'payment_events', 'booking_beds'];

/**
 * Per-scenario PG conversation seed plan.
 *
 * Keys: scenario_id (lowercase).
 * Values: array of { turn_before: number, phone: string, session_state: object }
 *   - `turn_before`: seed this state BEFORE executing the given turn number
 *   - `phone`: the from-phone in the scenario's post_body
 *   - `session_state`: the JSONB to store in conversations.session_state
 *
 * All phones are fake dry-run test phones.
 * These seeds are planned here so validation mode can print the plan.
 * Actual DB writes only happen in --run mode (guarded by RUN_MODE).
 */
const PG_CONVERSATION_SEED_PLANS = {
  a2: [
    {
      turn_before: 2,
      phone: '34600000102',
      session_state: {
        intent: 'booking_flow',
        check_in: '2026-05-01',
        check_out: '2026-05-08',
        guest_count: 1,
        room_type: 'shared',
        language: 'en',
        _source: 'stage4_dry_run_seed',
        _scenario: 'A2-T1',
      },
    },
  ],
  a3: [
    {
      turn_before: 2,
      phone: '34600000103',
      session_state: {
        intent: 'booking_flow',
        check_in: '2026-07-01',
        check_out: '2026-07-08',
        guest_count: 2,
        package: 'uluwatu',
        room_type: 'shared',
        language: 'en',
        current_hold_id: 'WH-DRYA3-0001',
        booking_code: 'WH-DRYA3-0001',
        total_amount: 798,
        deposit_amount: 200,
        deposit_amount_eur: 200,
        full_amount_eur: 798,
        _source: 'stage4_dry_run_seed',
        _scenario: 'A3-T1',
      },
    },
  ],
  a4: [
    {
      turn_before: 2,
      phone: '34600000104',
      session_state: {
        intent: 'booking_flow',
        check_in: '2026-08-03',
        check_out: '2026-08-10',
        guest_count: 1,
        package: 'waimea',
        room_type: 'shared',
        language: 'en',
        current_hold_id: 'WH-DRYA4-0001',
        booking_code: 'WH-DRYA4-0001',
        total_amount: 599,
        deposit_amount: 200,
        deposit_amount_eur: 200,
        full_amount_eur: 599,
        _source: 'stage4_dry_run_seed',
        _scenario: 'A4-T1',
      },
    },
  ],
};

/**
 * Upsert a conversation row into `conversations` for a Stage 4 dry-run phone.
 *
 * Safety:
 *  - Only writes to `conversations` table.
 *  - Never writes bookings / payments / payment_events / booking_beds.
 *  - Uses wolfhouse-somo client slug to resolve client_id.
 *  - Phone must be a fake test phone (not a real guest phone).
 *
 * @param {import('pg').Client} pgClient - connected wolfhouse Postgres client
 * @param {string} phone - fake test phone (e.g. '34600000102')
 * @param {object} sessionState - session_state JSONB to store
 * @returns {Promise<{ conversation_id: string, created: boolean }>}
 */
async function seedConversationState(pgClient, phone, sessionState) {
  // Resolve client_id from slug
  const clientRes = await pgClient.query(
    `SELECT id FROM clients WHERE slug = $1 LIMIT 1`,
    [STAGE4_CLIENT_SLUG]
  );
  if (!clientRes.rows.length) throw new Error(`seedConversationState: client slug "${STAGE4_CLIENT_SLUG}" not found`);
  const clientId = clientRes.rows[0].id;

  const sql = `
    INSERT INTO conversations (client_id, phone, session_state, conversation_stage, language, bot_mode)
    VALUES ($1, $2, $3::jsonb, 'booking_flow', $4, 'bot')
    ON CONFLICT (client_id, phone) DO UPDATE SET
      session_state = EXCLUDED.session_state,
      conversation_stage = EXCLUDED.conversation_stage,
      language = COALESCE(EXCLUDED.language, conversations.language),
      updated_at = NOW()
    RETURNING id::text AS conversation_id, (xmax = 0) AS created
  `;
  const { rows } = await pgClient.query(sql, [
    clientId,
    phone,
    JSON.stringify(sessionState),
    sessionState.language || 'en',
  ]);
  return {
    conversation_id: rows[0].conversation_id,
    created: rows[0].created,
    phone,
    client_id: clientId,
    _note: 'stage4_dry_run_seed — conversations only, no business table writes',
  };
}

/**
 * Remove Stage 4 dry-run conversation seed rows by phone.
 *
 * Safety:
 *  - Deletes from `conversations` only.
 *  - Scoped to wolfhouse-somo client.
 *  - Only removes rows where phone matches (fake test phones only).
 *
 * @param {import('pg').Client} pgClient - connected wolfhouse Postgres client
 * @param {string[]} phones - fake test phones to clean up
 * @returns {Promise<{ deleted_count: number, phones: string[] }>}
 */
async function teardownConversationState(pgClient, phones) {
  if (!phones || phones.length === 0) return { deleted_count: 0, phones: [] };

  const clientRes = await pgClient.query(
    `SELECT id FROM clients WHERE slug = $1 LIMIT 1`,
    [STAGE4_CLIENT_SLUG]
  );
  if (!clientRes.rows.length) throw new Error(`teardownConversationState: client slug "${STAGE4_CLIENT_SLUG}" not found`);
  const clientId = clientRes.rows[0].id;

  const placeholders = phones.map((_, i) => `$${i + 2}`).join(', ');
  const { rowCount } = await pgClient.query(
    `DELETE FROM conversations WHERE client_id = $1 AND phone IN (${placeholders})`,
    [clientId, ...phones]
  );
  return { deleted_count: rowCount, phones, client_id: clientId };
}

/**
 * Build the PG conversation seed plan for a given scenario.
 * Returns null if the scenario has no seed requirements.
 *
 * @param {string} scenarioId - lowercase scenario id (e.g. 'a2')
 * @returns {{ turn_before: number, phone: string, session_state: object }[] | null}
 */
function getScenarioSeedPlan(scenarioId) {
  const id = String(scenarioId || '').toLowerCase();
  return PG_CONVERSATION_SEED_PLANS[id] || null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '='.repeat(70));
  console.log(' Stage 4 Autonomous Booking Dry-Run — Scenario Validator');
  console.log(' Mode: ' + (RUN_MODE ? 'EXECUTE (POST + poll — post guard LIFTED)' : EXECUTE_MODE ? 'PREFLIGHT (no POST — post guard active)' : 'VALIDATE + PLAN (no runtime, no POST, no DB)'));
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
    // Multi-turn PG conversation state (A2/A3/A4)
    pg_conversation_state_required: Object.keys(PG_CONVERSATION_SEED_PLANS),
    planned_pg_conversation_seed: (() => {
      const plan = {};
      for (const [sid, seeds] of Object.entries(PG_CONVERSATION_SEED_PLANS)) {
        plan[sid] = seeds.map((s) => ({
          turn_before: s.turn_before,
          phone: s.phone,
          session_fields: Object.keys(s.session_state),
          _note: 'seed written by runner seedConversationState() in --run mode only',
        }));
      }
      return plan;
    })(),
    planned_pg_conversation_cleanup: (() => {
      const phonesPerScenario = {};
      for (const [sid, seeds] of Object.entries(PG_CONVERSATION_SEED_PLANS)) {
        phonesPerScenario[sid] = [...new Set(seeds.map((s) => s.phone))];
      }
      return {
        method: 'teardownConversationState(pgClient, phones)',
        scoped_to: `client_id = (SELECT id FROM clients WHERE slug = '${STAGE4_CLIENT_SLUG}')`,
        phones_per_scenario: phonesPerScenario,
        _note: 'cleanup run after each multi-turn scenario completes or fails in --run mode',
      };
    })(),
    allowed_state_table_deltas: ALLOWED_STATE_TABLE_DELTAS,
    protected_no_mutation_tables: PROTECTED_NO_MUTATION_TABLES,
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
      const matchedTurns = (scenario.turns ?? []).filter((t) => {        const tid = normaliseId(String(t.turn_id ?? ''));
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

      // ── Actually POST if --run is present ───────────────────────────────────
      if (RUN_MODE) {
        console.log('\n' + '-'.repeat(70));
        console.log(' EXECUTING: POST to webhook (--run flag active)');
        console.log('-'.repeat(70));
        const beforeExecId = await getBaselineExecId();
        console.log(`  Baseline exec id: ${beforeExecId}`);
        console.log(`  POSTing to ${preflight.webhook_url}...`);

        let postResult;
        try {
          postResult = await postWebhook(preflight.webhook_url, selectedTurn.post_body);
        } catch (e) {
          console.error('  POST failed:', e.message);
          process.exit(1);
        }
        console.log(`  POST status: ${postResult.status}`);
        console.log(`  POST body: ${JSON.stringify(postResult.body).slice(0, 200)}`);

        if (postResult.status !== 200) {
          console.error('  Non-200 response — execution may not have started. Check n8n logs.');
          report.execute_result = { status: 'post_failed', post_status: postResult.status, post_body: postResult.body };
        } else {
          console.log('\n  Polling for execution completion (up to 45s)...');
          const execRow = await pollExecution(beforeExecId);
          if (!execRow) {
            console.error('  Execution timed out — not found in n8n DB within 45s.');
            report.execute_result = { status: 'timeout', post_status: postResult.status };
          } else {
            console.log(`  Execution id: ${execRow.id} | status: ${execRow.status}`);
            console.log(`  Started: ${execRow.startedAt} | Stopped: ${execRow.stoppedAt}`);

            // Parse execution data for key nodes
            let execData = null;
            try { execData = typeof execRow.exec_data === 'string' ? JSON.parse(execRow.exec_data) : execRow.exec_data; } catch {}

            const result = {
              status: execRow.status,
              execution_id: execRow.id,
              post_status: postResult.status,
              started_at: execRow.startedAt,
              stopped_at: execRow.stoppedAt,
              node_results: {},
            };

            if (execData && execData.resultData && execData.resultData.runData) {
              const runData = execData.resultData.runData;
              const lastNode = execData.resultData.lastNodeExecuted;
              result.last_node_executed = lastNode;
              console.log(`  Last node executed: ${lastNode}`);

              // Extract key nodes
              const keyNodes = [
                'IF - PG Hold OK',
                'IF - Booking ID Ready',
                'Code - DRY RUN Stub (Postgres - Create Booking Hold)',
                'Code - DRY RUN Stub (Postgres - Ensure Booking In Postgres)',
                'Code - Validate PG Hold',
                'Code - Call Create Payment Session',
                'Code - Parse Route',
                'Code - Booking State Resolver',
              ];
              for (const nodeName of keyNodes) {
                if (runData[nodeName]) {
                  const nodeRun = runData[nodeName][0];
                  const outputData = nodeRun?.data?.main?.[0]?.[0]?.json ?? nodeRun?.data?.main?.[1]?.[0]?.json ?? null;
                  result.node_results[nodeName] = {
                    executed: true,
                    output_summary: outputData ? JSON.stringify(outputData).slice(0, 300) : null,
                  };
                  if (nodeName === 'Code - Parse Route') {
                    console.log(`  Route: ${outputData?.route || '?'} | confidence: ${outputData?.confidence || '?'}`);
                  }
                  if (nodeName === 'IF - PG Hold OK') {
                    console.log(`  IF - PG Hold OK: branch=${nodeRun?.data?.main?.[0]?.length ? 'TRUE(0)' : nodeRun?.data?.main?.[1]?.length ? 'FALSE(1)' : '?'}`);
                  }
                  if (nodeName === 'Code - DRY RUN Stub (Postgres - Create Booking Hold)') {
                    console.log(`  Hold stub executed: ${outputData ? 'YES' : 'NO'} | pg_ok=${outputData?.pg_ok} | booking_id=${outputData?.booking_id}`);
                  }
                  if (nodeName === 'Code - Call Create Payment Session') {
                    console.log(`  CPS dry-run: checkout_url=${outputData?.checkout_url} | amount=${outputData?.amount_due_cents}`);
                  }
                }
              }

              // Try to find draft reply text
              const replyNodes = Object.keys(runData).filter(n => n.startsWith('Reply -'));
              for (const rn of replyNodes) {
                const rdata = runData[rn]?.[0]?.data?.main?.[0]?.[0]?.json;
                if (rdata?.text || rdata?.reply_text) {
                  result.draft_reply = (rdata.text || rdata.reply_text || '').slice(0, 500);
                  console.log(`  Draft reply (${rn}): "${result.draft_reply.slice(0, 150)}..."`);
                  break;
                }
              }
            }

            report.execute_result = result;
          }
        }
      }
    }
  }

  // ── Stub shape requirements summary ───────────────────────────────────────
  const allStubShapes = new Set();
  for (const s of report.scenarios) {
    for (const shape of s.stub_shapes_required ?? []) allStubShapes.add(shape);
  }

  report.stub_shapes_required_across_scenarios = [...allStubShapes];

  // ── PG conversation seed plan summary ─────────────────────────────────────
  const seedScenarios = Object.keys(PG_CONVERSATION_SEED_PLANS);
  if (!ONLY_FILTER || seedScenarios.includes(ONLY_FILTER)) {
    console.log('\n' + '-'.repeat(70));
    console.log(' Multi-turn PG Conversation State (A2/A3/A4)');
    console.log('-'.repeat(70));
    console.log('  Required for: ' + seedScenarios.join(', '));
    console.log('  Allowed state table deltas: ' + ALLOWED_STATE_TABLE_DELTAS.join(', '));
    console.log('  Protected (must not change): ' + PROTECTED_NO_MUTATION_TABLES.join(', '));
    console.log('');
    for (const sid of seedScenarios) {
      if (ONLY_FILTER && !ONLY_FILTER.startsWith(sid) && sid !== ONLY_FILTER) continue;
      const seeds = PG_CONVERSATION_SEED_PLANS[sid];
      for (const seed of seeds) {
        console.log(`  ${sid.toUpperCase()} — seed before turn ${seed.turn_before}:`);
        console.log(`    phone: ${seed.phone}`);
        console.log(`    session fields: ${Object.keys(seed.session_state).join(', ')}`);
        console.log(`    cleanup: teardownConversationState(pgClient, ['${seed.phone}'])`);
      }
    }
    console.log('\n  NOTE: Seeds only execute in --run mode. Validation mode never touches DB.');
  }

  report.required_implementation_changes = [
    '[DONE] hold_stub: returns pg_ok=true + booking_id/booking_code/status/payment_status/session fields (scripts/build-main-local-stripe.js)',
    '[DONE] payment_link_stub: returns checkout_url/session_id/amount_due_cents/currency/payment_kind via inline CPS check (scripts/build-main-local-stripe.js)',
    '[DONE] Postgres - Ensure Booking In Postgres gated as dry-run gate 70',
    '[DONE] closed_month_guard: Code - Check Closed Month + IF - Closed Month? guard before hold creation (scripts/build-main-local-stripe.js)',
    '[DONE] conversation_state_persistence: Postgres - Search Conversation (PG) added before Merge Session State; runner seeds PG between turns for A2/A3/A4',
    '[PENDING] stripe_webhook_dry_run_path: webhook handler must accept simulated event and proceed through confirmation path',
    '[PENDING] confirmation_stub: must expose draft_text including address/gate_code/room_number from config',
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

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
