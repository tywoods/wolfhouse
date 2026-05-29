/**
 * Stage 3y Mode A — offline shadow local runner (evidence capture, no activation).
 *
 * Runs the five Mode A Meta-envelope payloads against the local Main webhook and
 * captures route/draft/shadow-gate evidence from both Wolfhouse Postgres counts
 * AND n8n execution runData. Writes a self-contained JSON report.
 *
 * Purpose: a cheap, repeatable way to exercise Mode A without long manual prompts.
 *
 * SAFETY:
 *   - Refuses to run unless WHATSAPP_DRY_RUN=true (read from infra/.env or process env).
 *   - Does NOT activate, import, or modify any workflow. Main must already be active.
 *   - Fails loudly (exit 1) if any protected count changed:
 *       payments / payment_events / booking_beds changed, or bookings increased.
 *   - Fails loudly if shadow-gate safety assertions are violated in execution data.
 *
 * Run: npm run test:stage3y-mode-a
 *   Optional env overrides:
 *     BOOKING_ASSISTANT_WEBHOOK_URL   (default http://localhost:5678/webhook/booking-assistant)
 *   Optional flags:
 *     --no-execution-data          skip n8n execution_data capture (counts + HTTP only)
 *     --from-report <path>         re-extract draft fields from a prior report by re-querying
 *                                  n8n-postgres for each stored execution_id. No POSTs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

// ── Configuration ─────────────────────────────────────────────────────────────

const ARGS = process.argv.slice(2);
const ARGS_SET = new Set(ARGS);
const CAPTURE_EXEC_DATA = !ARGS_SET.has('--no-execution-data');

// --from-report <path> mode: re-extract drafts from a previous report
const FROM_REPORT_IDX = ARGS.indexOf('--from-report');
const FROM_REPORT_PATH = FROM_REPORT_IDX !== -1 ? ARGS[FROM_REPORT_IDX + 1] : null;

// --only <id> mode: run only the payload whose id or filename matches (case-insensitive).
// Accepted forms: "Y-T8", "y-t8", "y-t8-rooming-preference" (filename prefix).
const ONLY_IDX = ARGS.indexOf('--only');
const ONLY_RAW = ONLY_IDX !== -1 ? ARGS[ONLY_IDX + 1] : null;
/** Normalise to lowercase, strip leading/trailing dashes. */
const normaliseId = (s) => String(s || '').toLowerCase().replace(/^[-\s]+|[-\s]+$/g, '');
const ONLY_FILTER = ONLY_RAW ? normaliseId(ONLY_RAW) : null;

const PAYLOAD_DIR = path.join(__dirname, '..', 'test-payloads', 'stage3y', 'mode-a');
const REPORT_PATH = path.join(__dirname, '..', 'reports', 'stage3y-mode-a-report.json');
const WEBHOOK_URL =
  process.env.BOOKING_ASSISTANT_WEBHOOK_URL ||
  'http://localhost:5678/webhook/booking-assistant';

/** Workflow id of local Main (offline-safe build). */
const MAIN_WF_ID = 'RBfGNtVgrAkvhBHJ';

// Explicit run order (matches the documented Mode A gate sequence).
const PAYLOAD_ORDER = [
  // Gate 3 batch (all PASS 2026-05-29)
  'y-t1-booking-request.json',
  'y-t2-package-question.json',
  'y-t5-missing-dates.json',
  'y-t6-missing-guest-count.json',
  'y-t9-low-confidence.json',
  // Gate 4 batch (CREATED / NOT RUNTIME TESTED)
  'y-t3-existing-booking.json',
  'y-t4-cancellation-request.json',
  'y-t7-payment-question.json',
  'y-t8-rooming-preference.json',
  'y-t10-complaint-refund.json',
];

// ── Wolfhouse-postgres connection ──────────────────────────────────────────────

const COUNT_TABLES = [
  'bookings',
  'payments',
  'payment_events',
  'booking_beds',
  'automation_errors',
  'workflow_events',
  'conversations',
  'messages',
];

const PROTECTED_EXACT = ['payments', 'payment_events', 'booking_beds'];
const PROTECTED_NO_INCREASE = ['bookings'];

const whConnStr =
  process.env.WOLFHOUSE_DATABASE_URL ||
  `postgres://${process.env.WOLFHOUSE_DB_USER || 'wolfhouse'}:${
    process.env.WOLFHOUSE_DB_PASSWORD || 'wolfhouse_dev_password'
  }@localhost:${process.env.WOLFHOUSE_DB_PORT || 5433}/${
    process.env.WOLFHOUSE_DB_NAME || 'wolfhouse'
  }`;

// ── n8n-postgres connection ────────────────────────────────────────────────────

const n8nConnStr =
  process.env.N8N_DATABASE_URL ||
  `postgres://${process.env.N8N_DB_USER || 'n8n'}:${
    process.env.N8N_DB_PASSWORD || ''
  }@localhost:${process.env.N8N_DB_PORT || 5434}/${
    process.env.N8N_DB_NAME || 'n8n'
  }`;

// ── Safety / dry-run guard ────────────────────────────────────────────────────

function assertDryRun() {
  const val = String(process.env.WHATSAPP_DRY_RUN || '').toLowerCase();
  if (val !== 'true') {
    console.error(
      `\nREFUSING TO RUN: WHATSAPP_DRY_RUN must be "true" (got "${
        process.env.WHATSAPP_DRY_RUN ?? '(unset)'
      }").`
    );
    console.error('This runner is offline-shadow only. Set WHATSAPP_DRY_RUN=true in infra/.env.');
    process.exit(1);
  }
}

// ── Wolfhouse counts ──────────────────────────────────────────────────────────

async function captureCounts(client) {
  const counts = {};
  for (const table of COUNT_TABLES) {
    const { rows } = await client.query(`SELECT COUNT(*)::int AS c FROM ${table}`);
    counts[table] = rows[0].c;
  }
  return counts;
}

function diffCounts(before, after) {
  const delta = {};
  for (const table of COUNT_TABLES) {
    delta[table] = (after[table] ?? 0) - (before[table] ?? 0);
  }
  return delta;
}

// ── Payload parsing ──────────────────────────────────────────────────────────

function extractMessageMeta(payload) {
  try {
    const msg = payload.entry[0].changes[0].value.messages[0];
    return {
      wamid: msg.id || null,
      from: msg.from || null,
      message_text: msg.text?.body || null,
    };
  } catch {
    return { wamid: null, from: null, message_text: null };
  }
}

// ── Webhook POST ──────────────────────────────────────────────────────────────

async function postPayload(rawBody) {
  const started = Date.now();
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawBody,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
    return {
      ok: res.ok,
      status: res.status,
      elapsed_ms: Date.now() - started,
      body_raw: text.slice(0, 4000),
      body_json: parsed,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      elapsed_ms: Date.now() - started,
      body_raw: null,
      body_json: null,
      error: String(err?.message ?? err),
    };
  }
}

/** Best-effort draft extraction from HTTP response body (fallback if runData not available). */
function extractDraftFromResponse(body) {
  const result = { resolved_route: null, confidence: null, missing_fields: null, draft_reply: null, handoff: null };
  if (!body || typeof body !== 'object') return result;
  const candidates = [body, body.json, body.data, body.body].filter((x) => x && typeof x === 'object');
  for (const c of candidates) {
    result.resolved_route = result.resolved_route ?? c.resolved_route ?? c.route ?? c.intent ?? null;
    result.confidence = result.confidence ?? c.confidence ?? c.confidence_score ?? null;
    result.missing_fields = result.missing_fields ?? c.missing_fields ?? c.missingFields ?? null;
    result.draft_reply = result.draft_reply ?? c.draft_reply ?? c.draft ?? c.reply ?? c.reply_text ?? c.message ?? c.text ?? null;
    result.handoff = result.handoff ?? c.handoff ?? c.needs_human ?? c.handoff_reason ?? null;
  }
  return result;
}

// ── n8n execution data ────────────────────────────────────────────────────────

async function maxExecutionId(n8nClient) {
  const { rows } = await n8nClient.query(
    `SELECT COALESCE(MAX(id), 0)::int AS max_id FROM execution_entity WHERE "workflowId" = $1`,
    [MAIN_WF_ID]
  );
  return rows[0].max_id;
}

/** Poll for a new execution for MAIN_WF_ID with id > baselineId (up to ~90 s). */
async function waitForNewExecution(n8nClient, baselineId) {
  // Queue mode: webhook ACKs immediately, worker picks up job async.
  // Poll until execution reaches a terminal state (success/error/canceled/crashed).
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const { rows } = await n8nClient.query(
      `SELECT id, status, finished, "startedAt", "stoppedAt"
       FROM execution_entity
       WHERE "workflowId" = $1 AND id > $2
       ORDER BY id DESC LIMIT 1`,
      [MAIN_WF_ID, baselineId]
    );
    if (rows.length > 0) {
      const exec = rows[0];
      // new = queued but not yet started; running = in progress — keep waiting
      if (!exec.finished && (exec.status === 'new' || exec.status === 'running')) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      return exec;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

/** Safely get json output of the first item of output branch 0 of a runData node. */
function nodeJson(runData, name) {
  try {
    const n = runData[name];
    if (!n) return null;
    return n[0]?.data?.main?.[0]?.[0]?.json ?? null;
  } catch { return null; }
}

/** Parse execution_data.data (flatted) and extract all evidence. */
function parseRunData(rawData) {
  let flatted;
  try { flatted = require('flatted'); } catch {
    return { parse_error: 'flatted module not available', nodes_executed: [], raw_available: false };
  }

  let root;
  try {
    const parsed = flatted.parse(rawData);
    root = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (e) {
    return { parse_error: `flatted.parse failed: ${e.message}`, nodes_executed: [], raw_available: true };
  }

  const rd = root?.resultData?.runData ?? {};
  const lastNodeExecuted = root?.resultData?.lastNodeExecuted ?? null;
  const nodes_executed = Object.keys(rd);
  const execError = root?.error ? String(root.error).slice(0, 400) : null;

  // ── Extract route / draft ──────────────────────────────────────────────
  const parseRouteJson = nodeJson(rd, 'Code - Parse Route');
  const resolverJson = nodeJson(rd, 'Code - Booking State Resolver');
  const missingFieldsJson = nodeJson(rd, 'Determine Missing Fields');
  const mergeJson = nodeJson(rd, 'Merge Session State');

  const resolved_route =
    resolverJson?.resolved_route ??
    parseRouteJson?.route ??
    null;

  const confidence =
    parseRouteJson?.confidence ??
    resolverJson?.confidence ??
    null;

  const language = parseRouteJson?.language ?? null;
  const route_reason = parseRouteJson?.reason ? String(parseRouteJson.reason).slice(0, 300) : null;

  const missing_for_availability = resolverJson?.missing_for_availability ?? null;
  const missing_for_payment = resolverJson?.missing_for_payment ?? null;
  const session = resolverJson?.session ?? mergeJson?.session ?? null;

  // ── Draft extraction ────────────────────────────────────────────────────────
  // Priority-ordered patterns: first match wins for draft_reply/draft_source.
  // All matches are collected into draft_candidates for staff review.
  //
  // Node name patterns and which JSON keys to check for the reply text:
  //   - Reply - *            chainLlm nodes — output in `text`
  //   - Generate Next Reply  chainLlm for booking_flow missing-fields path — output in `text`
  //   - Reply Existing ...   chainLlm for existing-booking status path — output in `text`
  //   - Code - Assemble *    Code nodes that assemble the payment-pending message — in `text`
  //   - Code - Build * Reply Code nodes that build rooming/other replies — `text` or `reply_text`
  //   - Set Reply - *        Set nodes (rooming preference saved) — field is `reply_text`
  //   - Generate * Reply     future LLM nodes following same pattern as Generate Next Reply
  const DRAFT_PATTERNS = [
    { prefix: 'Reply - ',             keys: ['text', 'output'] },
    { exact:  'Generate Next Reply',  keys: ['text', 'output'] },
    { prefix: 'Reply Existing Booking', keys: ['text', 'output'] },
    { prefix: 'Code - Assemble',      keys: ['text', 'reply_text', 'output'] },
    { prefix: 'Code - Build',         keys: ['text', 'reply_text', 'output'] },
    { prefix: 'Set Reply - ',         keys: ['reply_text', 'text'] },
    { prefix: 'Generate ',            keys: ['text', 'output'] },
  ];

  const draft_candidates = [];
  let draft_reply = null;
  let draft_source = null;

  for (const nodeName of nodes_executed) {
    let keysToCheck = null;
    for (const pat of DRAFT_PATTERNS) {
      if (pat.exact && nodeName === pat.exact) { keysToCheck = pat.keys; break; }
      if (pat.prefix && nodeName.startsWith(pat.prefix)) { keysToCheck = pat.keys; break; }
    }
    if (!keysToCheck) continue;
    const j = nodeJson(rd, nodeName);
    if (!j) continue;
    for (const key of keysToCheck) {
      const val = j[key];
      if (val && typeof val === 'string' && val.length > 5) {
        draft_candidates.push({ node: nodeName, key, text: val.slice(0, 300) });
        if (!draft_reply) { draft_reply = val; draft_source = nodeName; }
        break;
      }
    }
  }

  // Fallback: DRY RUN stub for outbound message carries the original message text in its fields
  if (!draft_reply) {
    for (const nodeName of nodes_executed) {
      if (nodeName.startsWith('Code - DRY RUN Stub (Create Outbound')) {
        const j = nodeJson(rd, nodeName);
        const msgText = j?.fields?.['Message Text'];
        if (msgText && msgText !== '(shadow draft — not written to Airtable)') {
          draft_reply = msgText; draft_source = nodeName;
          draft_candidates.push({ node: nodeName, key: 'fields.Message Text', text: msgText.slice(0, 300) });
          break;
        }
      }
    }
  }

  // ── Extraction notes ─────────────────────────────────────────────────────
  const extraction_notes = [];
  if (!draft_reply) {
    if (nodes_executed.includes('Code - PG Hold Failed Stop')) {
      extraction_notes.push(
        'No draft: PG hold stub returns null, hold validator returns pg_ok=false. ' +
        'Availability+hold reply requires a real created hold. ' +
        'Expected in shadow mode for availability_check intent (Y-T1 pattern). ' +
        'To get a shadow draft: improve PG hold stub to return a synthetic hold object that passes validation.'
      );
    } else if (
      nodes_executed.includes('Code - DRY RUN Stub (Create or update Conversation)') ||
      nodes_executed.some((n) => n.includes('Create or update Conversation'))
    ) {
      extraction_notes.push(
        'Execution ended at Create or update Conversation stub — no Reply-* or Generate* node found in executed list. ' +
        'Check draft_candidates; if empty, the LLM may not have been reached in this path.'
      );
    } else {
      extraction_notes.push('No draft text found in executed nodes. Check draft_candidates for partial matches.');
    }
  }

  const handoff =
    resolverJson?.message_signals?.needs_human ??
    mergeJson?.session?.needs_human ??
    null;

  // ── Shadow gate evidence ────────────────────────────────────────────────
  const dryRunIfGates = nodes_executed.filter((n) => n.startsWith('IF - DRY RUN?'));
  const dryRunStubs = nodes_executed.filter((n) => n.startsWith('Code - DRY RUN Stub'));
  const sendNodes = nodes_executed.filter((n) => n.startsWith('Send WhatsApp Reply'));
  const typingNode = nodes_executed.includes('Send Typing Indicator');

  // Airtable writes: real op nodes executed directly (no dry-run prefix)
  const atWritePatterns = [
    'Create Inbound Message', 'Create Conversation', 'Create Outbound Message',
    'Update Inbound Message - Link Conversation', 'Update Conversation',
    'Create Booking Hold', 'Update Booking',
    'Update Hold With Guest Details', 'Update record',
    'Create or update Conversation', 'Create/update Conversation',
  ];
  const atWriteNodes = nodes_executed.filter((n) => {
    if (n.startsWith('Code - DRY RUN Stub') || n.startsWith('IF - DRY RUN?')) return false;
    return atWritePatterns.some((p) => n === p || n.startsWith(p + ' - ') || n.startsWith(p + '1'));
  });

  const pgHoldNode = nodes_executed.includes('Postgres - Create Booking Hold');
  const pgHoldStub = nodes_executed.includes('Code - DRY RUN Stub (Postgres - Create Booking Hold)');
  const pgConvHoldNode = nodes_executed.includes('Postgres - Upsert Conversation Hold');
  const pgConvHoldStub = nodes_executed.includes('Code - DRY RUN Stub (Postgres - Upsert Conversation Hold)');

  // Check for real wamid / graph.facebook.com in the raw data (text scan)
  // A real Meta-issued wamid looks like wamid.HBgL... (starts with wamid. followed by uppercase)
  // Our test wamids look like wamid.3Y-T1-TEST001 (with hyphens)
  const dataStr = rawData;
  const hasMetaWamid = /wamid\.[A-Z][A-Za-z0-9+/]{10,}/.test(dataStr);
  const hasGraphFacebook = /graph\.facebook\.com/.test(dataStr);
  // Real Airtable rec ids: rec followed by exactly 14 alphanumeric chars, returned by AT API
  const atRecIdMatches = dataStr.match(/\"rec[A-Za-z0-9]{14}\"/g) ?? [];
  // Filter out any that are from our test fixture data (none expected)
  const realAtRecIds = [...new Set(atRecIdMatches)].slice(0, 10);

  const shadow_gate_evidence = {
    dry_run_if_gates_count: dryRunIfGates.length,
    dry_run_if_gates: dryRunIfGates,
    dry_run_stubs_count: dryRunStubs.length,
    dry_run_stubs: dryRunStubs,
    send_whatsapp_nodes_executed_directly: sendNodes,
    typing_indicator_executed: typingNode,
    airtable_write_nodes_executed_directly: atWriteNodes,
    pg_create_booking_hold_executed: pgHoldNode,
    pg_create_booking_hold_stub_executed: pgHoldStub,
    pg_upsert_conv_hold_executed: pgConvHoldNode,
    pg_upsert_conv_hold_stub_executed: pgConvHoldStub,
    meta_wamid_in_data: hasMetaWamid,
    graph_facebook_in_data: hasGraphFacebook,
    airtable_rec_ids_found: realAtRecIds,
  };

  // ── Safety assertions ────────────────────────────────────────────────
  const safety_failures = [];

  if (typingNode) {
    safety_failures.push('HARD STOP: Send Typing Indicator executed (should be skipped by local guard)');
  }
  if (sendNodes.length > 0) {
    safety_failures.push(
      `HARD STOP: Send WhatsApp Reply* nodes executed DIRECTLY (not through stub): ${sendNodes.join(', ')}`
    );
  }
  if (hasMetaWamid) {
    safety_failures.push('HARD STOP: real Meta-issued wamid found in execution data (real WhatsApp send occurred)');
  }
  if (hasGraphFacebook) {
    safety_failures.push('HARD STOP: graph.facebook.com reference found in execution data');
  }
  if (atWriteNodes.length > 0) {
    safety_failures.push(
      `HARD STOP: Airtable write node(s) executed directly (without dry-run stub): ${atWriteNodes.join(', ')}`
    );
  }
  if (realAtRecIds.length > 0 && atWriteNodes.length > 0) {
    // Only fail if BOTH an AT write node ran directly AND rec IDs appear — confirms a real write.
    // AT read nodes (Search Conversation etc.) legitimately return rec IDs; don't hard-stop on reads.
    safety_failures.push(
      `HARD STOP: real Airtable record id(s) found in execution data alongside direct AT write nodes: ${realAtRecIds.join(', ')}`
    );
  }
  if (pgHoldNode && !pgHoldStub) {
    safety_failures.push(
      'HARD STOP: Postgres - Create Booking Hold executed directly (no dry-run stub; real hold may have been created)'
    );
  }

  return {
    parse_error: null,
    last_node_executed: lastNodeExecuted,
    nodes_executed,
    exec_error: execError,
    extracted: {
      resolved_route,
      confidence,
      language,
      route_reason,
      missing_for_availability,
      missing_for_payment,
      draft_reply,
      draft_source,
      draft_candidates,
      extraction_notes,
      handoff,
      session_check_in: session?.check_in ?? null,
      session_check_out: session?.check_out ?? null,
      session_guest_count: session?.guest_count ?? null,
      session_intent: session?.intent ?? null,
    },
    shadow_gate_evidence,
    safety_failures,
  };
}

// ── n8n execution capture (full) ──────────────────────────────────────────────

async function captureExecution(n8nClient, baselineId) {
  const exec = await waitForNewExecution(n8nClient, baselineId);
  if (!exec) {
    return { found: false, reason: 'no new execution found within timeout', safety_failures: [] };
  }

  const execInfo = {
    found: true,
    execution_id: exec.id,
    status: exec.status,
    finished: exec.finished,
    started_at: exec.startedAt,
    stopped_at: exec.stoppedAt,
  };

  // Fetch execution_data
  const { rows } = await n8nClient.query(
    `SELECT data FROM execution_data WHERE "executionId" = $1`,
    [exec.id]
  );

  if (!rows.length) {
    return { ...execInfo, run_data_available: false, safety_failures: [] };
  }

  const runEvidence = parseRunData(rows[0].data);
  return { ...execInfo, run_data_available: true, ...runEvidence };
}

// ── Report output helpers ─────────────────────────────────────────────────────

function fmtDraft(text) {
  if (!text) return '(none)';
  return text.replace(/\n/g, ' ').slice(0, 120) + (text.length > 120 ? '…' : '');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  assertDryRun();

  // ── --only filter: resolve which payloads to run ──────────────────────────
  /** Match a filename like "y-t8-rooming-preference.json" against a filter like "y-t8" or "y-t8-rooming-preference". */
  function matchesOnly(filename, filter) {
    const base = normaliseId(filename.replace(/\.json$/i, ''));
    // Exact match on normalised base
    if (base === filter) return true;
    // Filter is a short id prefix: "y-t8" matches "y-t8-rooming-preference"
    if (base.startsWith(filter + '-')) return true;
    return false;
  }

  let filesToRun = [...PAYLOAD_ORDER];
  if (ONLY_FILTER) {
    filesToRun = PAYLOAD_ORDER.filter((f) => matchesOnly(f, ONLY_FILTER));
    if (!filesToRun.length) {
      console.error(`--only "${ONLY_RAW}": no payload in PAYLOAD_ORDER matches filter "${ONLY_FILTER}".`);
      console.error(`Available: ${PAYLOAD_ORDER.map((f) => f.replace('.json', '')).join(', ')}`);
      process.exit(1);
    }
    console.log(`--only filter: running ${filesToRun.length} payload(s): ${filesToRun.join(', ')}`);
  }

  const report = {
    generated_at: new Date().toISOString(),
    webhook_url: WEBHOOK_URL,
    main_workflow_id: MAIN_WF_ID,
    whatsapp_dry_run: true,
    execution_data_capture: CAPTURE_EXEC_DATA,
    filter: ONLY_FILTER ? { only: ONLY_RAW, matched: filesToRun } : null,
    note: 'Offline shadow runner. Does NOT activate or modify workflows. Main must already be active.',
    baseline_counts: null,
    n8n_execution_baseline: null,
    final_counts: null,
    cumulative_delta: null,
    protected_violations: [],
    safety_failures: [],
    tests: [],
    overall: null,
  };

  const whClient = new Client({ connectionString: whConnStr });
  const n8nClient = CAPTURE_EXEC_DATA ? new Client({ connectionString: n8nConnStr }) : null;

  await whClient.connect();
  if (n8nClient) {
    try {
      await n8nClient.connect();
    } catch (e) {
      console.warn(`WARNING: could not connect to n8n-postgres: ${e.message}. Continuing without execution data.`);
      report.execution_data_capture = false;
    }
  }

  try {
    const baseline = await captureCounts(whClient);
    report.baseline_counts = baseline;

    let n8nBaseline = null;
    if (report.execution_data_capture && n8nClient) {
      n8nBaseline = await maxExecutionId(n8nClient);
      report.n8n_execution_baseline = { max_execution_id: n8nBaseline };
    }

    console.log(`\nBaseline counts: ${JSON.stringify(baseline)}`);
    console.log(`n8n exec baseline: max_id=${n8nBaseline ?? '(skipped)'}`);
    console.log(`Webhook: ${WEBHOOK_URL}`);
    console.log(`Execution data capture: ${report.execution_data_capture}`);
    console.log('─'.repeat(70));

    let rollingMaxId = n8nBaseline;

    for (const file of filesToRun) {
      const filePath = path.join(PAYLOAD_DIR, file);
      const testId = file.replace('.json', '');
      const testEntry = { file, test_id: testId };

      console.log(`\n▶  ${testId}`);

      if (!fs.existsSync(filePath)) {
        testEntry.error = 'payload file not found';
        report.tests.push(testEntry);
        console.warn(`   SKIP (missing): ${file}`);
        continue;
      }

      const rawBody = fs.readFileSync(filePath, 'utf8');
      let payload = {};
      try {
        payload = JSON.parse(rawBody);
      } catch (e) {
        testEntry.error = `payload JSON parse failed: ${e.message}`;
        report.tests.push(testEntry);
        console.warn(`   SKIP (bad JSON): ${file}`);
        continue;
      }

      const meta = extractMessageMeta(payload);
      testEntry.wamid = meta.wamid;
      testEntry.from = meta.from;
      testEntry.message_text = meta.message_text;

      const preCounts = await captureCounts(whClient);
      testEntry.pre_counts = preCounts;

      // Snapshot the current max exec id so we find exactly the new one
      const preExecId = rollingMaxId;

      const resp = await postPayload(rawBody);
      testEntry.http = {
        ok: resp.ok,
        status: resp.status,
        elapsed_ms: resp.elapsed_ms,
        error: resp.error,
        body_raw: resp.body_raw,
      };

      // HTTP-response fallback extraction
      testEntry.http_extracted = extractDraftFromResponse(resp.body_json);

      // n8n execution evidence
      let execResult = { found: false, safety_failures: [] };
      if (report.execution_data_capture && n8nClient) {
        execResult = await captureExecution(n8nClient, preExecId ?? 0);
        // Advance rolling max so next test doesn't re-match this execution
        if (execResult.found && execResult.execution_id) {
          rollingMaxId = execResult.execution_id;
        }
      }

      testEntry.execution = execResult.found ? {
        execution_id: execResult.execution_id,
        status: execResult.status,
        finished: execResult.finished,
        last_node_executed: execResult.last_node_executed,
        nodes_executed_count: execResult.nodes_executed?.length ?? null,
        exec_error: execResult.exec_error ?? null,
        run_data_available: execResult.run_data_available ?? false,
      } : { found: false };

      testEntry.extracted = execResult.extracted ?? testEntry.http_extracted;
      testEntry.shadow_gate_evidence = execResult.shadow_gate_evidence ?? null;
      testEntry.safety_failures = execResult.safety_failures ?? [];

      // Post-counts (settle wait)
      await new Promise((r) => setTimeout(r, 600));
      const postCounts = await captureCounts(whClient);
      testEntry.post_counts = postCounts;
      testEntry.delta_vs_pre = diffCounts(preCounts, postCounts);

      const ext = testEntry.extracted;
      const safeFails = testEntry.safety_failures.length;

      console.log(`   HTTP ${resp.status ?? 'ERR'} | exec=${execResult.execution_id ?? '?'} | route=${ext?.resolved_route ?? '?'} | conf=${ext?.confidence ?? '?'}`);
      console.log(`   draft: ${fmtDraft(ext?.draft_reply)}`);
      console.log(`   missing_avail=${JSON.stringify(ext?.missing_for_availability ?? '?')} | handoff=${ext?.handoff ?? '?'}`);
      console.log(`   shadow gates fired: ${execResult.shadow_gate_evidence?.dry_run_stubs_count ?? '?'} | safety_failures: ${safeFails}`);
      console.log(`   delta: ${JSON.stringify(testEntry.delta_vs_pre)}`);
      if (safeFails > 0) {
        for (const f of testEntry.safety_failures) console.error(`   ⚠  ${f}`);
      }

      report.tests.push(testEntry);

      // Accumulate top-level safety failures
      for (const f of testEntry.safety_failures) {
        report.safety_failures.push(`[${testId}] ${f}`);
      }
    }

    // ── Final counts + violations ──────────────────────────────────────────
    const finalCounts = await captureCounts(whClient);
    report.final_counts = finalCounts;
    report.cumulative_delta = diffCounts(baseline, finalCounts);

    for (const table of PROTECTED_EXACT) {
      const d = report.cumulative_delta[table];
      if (d !== 0) {
        report.protected_violations.push(`${table} changed by ${d} (must be 0)`);
      }
    }
    for (const table of PROTECTED_NO_INCREASE) {
      const d = report.cumulative_delta[table];
      if (d > 0) {
        report.protected_violations.push(`${table} increased by ${d} (must not increase)`);
      }
    }

    const allFail = [...report.protected_violations, ...report.safety_failures];
    report.overall = allFail.length === 0 ? 'PASS' : 'FAIL';

  } finally {
    await whClient.end();
    if (n8nClient) { try { await n8nClient.end(); } catch { /* ignore */ } }
  }

  // ── Write report ───────────────────────────────────────────────────────────
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log('\n' + '─'.repeat(70));
  console.log(`Wrote: ${REPORT_PATH}`);
  console.log(`Cumulative delta: ${JSON.stringify(report.cumulative_delta)}`);
  console.log(`Overall: ${report.overall}`);

  const allFail = [...report.protected_violations, ...report.safety_failures];
  if (allFail.length > 0) {
    console.error('\nFAILURES:');
    for (const f of allFail) console.error(`  ✗ ${f}`);
    console.error('\nHARD FAIL. Deactivate Main and investigate before rerunning.');
    process.exit(1);
  }

  console.log('\nAll checks PASS. Review report for route/draft quality.');
}

// ── --from-report reparse mode ────────────────────────────────────────────────
// Re-extracts draft/route fields from a prior report by re-querying n8n-postgres
// for each stored execution_id. Does NOT POST payloads or touch Wolfhouse DB.
//
// Usage: node scripts/run-stage3y-mode-a.js --from-report reports/stage3y-mode-a-report.json

async function reparseReport(reportPath) {
  assertDryRun();

  if (!fs.existsSync(reportPath)) {
    console.error(`--from-report: file not found: ${reportPath}`);
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  console.log(`\nRe-parsing report: ${reportPath}`);
  console.log(`Generated at: ${report.generated_at}`);
  console.log(`Tests: ${report.tests?.length ?? 0}`);
  console.log('─'.repeat(70));

  const n8nClient = new Client({ connectionString: n8nConnStr });
  try {
    await n8nClient.connect();
  } catch (e) {
    console.error(`Cannot connect to n8n-postgres: ${e.message}`);
    console.error('Re-parse requires n8n-postgres access to fetch stored execution_data.');
    process.exit(1);
  }

  let improved = 0;
  try {
    for (const t of report.tests ?? []) {
      const execId = t.execution?.execution_id;
      if (!execId) {
        console.log(`  ${t.test_id}: no execution_id — skipping`);
        continue;
      }

      const { rows } = await n8nClient.query(
        `SELECT data FROM execution_data WHERE "executionId" = $1`,
        [execId]
      );
      if (!rows.length) {
        console.log(`  ${t.test_id}: no execution_data for exec ${execId} — skipping`);
        continue;
      }

      const runEvidence = parseRunData(rows[0].data);
      const prev = t.extracted?.draft_reply;
      t.extracted = runEvidence.extracted ?? t.extracted;
      // Preserve execution-level metadata
      if (t.execution) {
        t.execution.last_node_executed = runEvidence.last_node_executed ?? t.execution.last_node_executed;
        t.execution.nodes_executed_count = runEvidence.nodes_executed?.length ?? t.execution.nodes_executed_count;
      }

      const curr = t.extracted?.draft_reply;
      const gotNew = !prev && curr;
      console.log(`  ${t.test_id} (exec ${execId}):`);
      console.log(`    draft_reply: ${fmtDraft(curr)}`);
      console.log(`    draft_source: ${t.extracted?.draft_source ?? '(none)'}`);
      console.log(`    extraction_notes: ${JSON.stringify(t.extracted?.extraction_notes ?? [])}`);
      if (gotNew) { improved++; console.log('    ✓ draft newly extracted'); }
    }
  } finally {
    await n8nClient.end();
  }

  const outPath = reportPath.replace(/\.json$/, '-reparsed.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('\n' + '─'.repeat(70));
  console.log(`Wrote: ${outPath}`);
  console.log(`Tests with newly extracted drafts: ${improved}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (FROM_REPORT_PATH) {
  reparseReport(FROM_REPORT_PATH).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
