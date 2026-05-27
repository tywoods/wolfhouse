/**
 * Build n8n/phase3b/Wolfhouse - Operator Room Release (local PG).json
 *
 * Phase 3b.5c — Postgres-first local fork (direct webhook JSON; no Airtable primary path).
 * Does NOT modify n8n/Wolfhouse - Operator Room Release.json (hosted export).
 *
 *   node scripts/build-operator-room-release-local.js --inventory
 *   node scripts/build-operator-room-release-local.js --generate
 *   node scripts/build-operator-room-release-local.js --verify-targets
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  PG_OPERATOR_ROOM_RELEASE_PLAN_SQL,
  PG_OPERATOR_ROOM_RELEASE_PLAN_QUERY_REPLACEMENT,
} = require('./lib/operator-room-release-pg-n8n-sql');

const HOSTED = path.join(__dirname, '..', 'n8n', 'Wolfhouse - Operator Room Release.json');
const OUT_DIR = path.join(__dirname, '..', 'n8n', 'phase3b');
const OUT = path.join(OUT_DIR, 'Wolfhouse - Operator Room Release (local PG).json');
const OUT_IMPORT = path.join(
  OUT_DIR,
  'Wolfhouse - Operator Room Release (local PG).n8n-import.json',
);

const LOCAL_WORKFLOW_ID = 'B3b5OperatorRoomLocal01';
const LOCAL_WORKFLOW_NAME = 'Wolfhouse - Operator Room Release (local PG)';
const LOCAL_WEBHOOK_PATH = 'operator-room-release';
const LOCAL_WEBHOOK_ID = 'b3b5c001-0005-4000-8000-000000000005';
const CLIENT_SLUG = 'wolfhouse-somo';

const PROD_AIRTABLE_BASE_ID = 'appOCWIN47Bui9CSS';

const LOCAL_N8N = {
  workflowId: LOCAL_WORKFLOW_ID,
  postgresCred: { id: 'MnnrrLecI7oVoIGq', name: 'Postgres account' },
};

const PARSE_NODE = 'Code - Parse Release Payload';
const PLAN_NODE = 'Postgres - Operator Room Release Plan';
const BUILD_RESPONSE_NODE = 'Code - Build Response';

/** Hosted nodes omitted from PG-first local MVP (optional COMPAT_AT_MIRROR later). */
const HOSTED_NODES_DROP_MVP = [
  'Get Release Request',
  'Search Matching Operator Booking',
  'Code - Pick Matching Operator Booking',
  'Code - Prepare Split Operator Blocks',
  'Cancel Original Operator Booking',
  'Code - Prepare Original Booking Beds To Cancel',
  'Cancel Original Booking Bed',
  'IF - Should Create Operator Block A',
  'IF - Should Create Operator Block B',
  'Create Operator Block A',
  'Create Operator Block B',
];

const PLANNED_LOCAL_GRAPH = [
  'Webhook - Operator Room Release',
  '→ Code - Parse Release Payload',
  '→ IF - Parse OK',
  '→ Postgres - Operator Room Release Plan (dry-run / preview only)',
  '→ Code - Build Response',
  '→ Respond to Webhook',
];

const PARSE_RELEASE_PAYLOAD_JS = `const body = $json.body ?? $json;
const errors = [];

function str(v) {
  return v == null ? '' : String(v).trim();
}

function normRoom(code) {
  const s = str(code);
  return s ? s.toUpperCase() : '';
}

function normDate(v) {
  const s = str(v);
  if (!s) return '';
  if (/^\\d{4}-\\d{2}-\\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

const operator = str(body.operator ?? body.Operator);
const room_code = normRoom(body.room_code ?? body['Room to Release'] ?? body.roomCode);
const release_start = normDate(body.release_start ?? body['Release Start Date']);
const release_end = normDate(body.release_end ?? body['Release End Date']);
const request_code = str(body.request_code ?? body.requestCode);
const notes = str(body.notes ?? body.Notes);

const dryRunRaw = body.dry_run;
const dry_run =
  dryRunRaw === true || dryRunRaw === 'true' || dryRunRaw === 1 || dryRunRaw === '1';

const allowRaw = body.allow_overlap;
const allow_overlap =
  allowRaw === true || allowRaw === 'true' || allowRaw === 1 || allowRaw === '1';

if (!operator) errors.push('missing_operator');
if (!room_code) errors.push('missing_room_code');
if (!release_start) errors.push('missing_release_start');
if (!release_end) errors.push('missing_release_end');

const invalid_date_range =
  release_start && release_end && release_start >= release_end;

if (invalid_date_range) errors.push('invalid_date_range');

const record_id = str(body.record_id ?? body.RecordId);
if (record_id) {
  errors.push('deprecated_record_id_ignored');
}

const parse_ok = errors.filter((e) => !e.startsWith('deprecated_')).length === 0;

return [{
  json: {
    parse_ok,
    errors,
    operator,
    room_code,
    release_start,
    release_end,
    request_code,
    notes,
    dry_run,
    allow_overlap,
    deprecated_record_id: record_id || null
  }
}];`;

const BUILD_RESPONSE_JS = `function mergeErrors(...lists) {
  const out = [];
  for (const list of lists) {
    if (!list) continue;
    for (const e of list) {
      const s = String(e || '').trim();
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

const parsed = $('${PARSE_NODE}').first()?.json || {};

if (!parsed.parse_ok) {
  return [{
    json: {
      ok: false,
      dry_run: !!parsed.dry_run,
      found_match: false,
      match_count: 0,
      error_code: 'validation',
      message: 'Invalid webhook payload',
      errors: mergeErrors(parsed.errors, ['parse_failed'])
    }
  }];
}

if (!parsed.dry_run) {
  return [{
    json: {
      ok: false,
      dry_run: false,
      found_match: false,
      match_count: 0,
      error_code: 'execute_not_implemented',
      message: 'Execute path not implemented in 3b.5c Step 3; set dry_run=true for preview only',
      errors: ['execute_not_implemented']
    }
  }];
}

let plan = {};
let planErr = null;
try {
  const planItem = $('${PLAN_NODE}').first();
  planErr = planItem?.error;
  plan = planItem?.json || {};
} catch (e) {
  planErr = e;
}

if (planErr) {
  const msg = String(planErr.message || planErr);
  return [{
    json: {
      ok: false,
      dry_run: true,
      found_match: false,
      match_count: 0,
      error_code: 'postgres_failed',
      message: msg,
      errors: ['postgres_plan_failed']
    }
  }];
}

const pgOk = plan.pg_ok === true || plan.pg_ok === 'true';
const planOk = plan.plan_ok === true || plan.plan_ok === 'true';
const foundMatch = plan.found_match === true || plan.found_match === 'true';
const matchCount = Number(plan.match_count ?? 0);
const paymentsCount = Number(plan.payments_count ?? 0);
const paymentEventsCount = Number(plan.payment_events_count ?? 0);
const paymentsUntouched = paymentsCount === 0 && paymentEventsCount === 0;

const actionable = Array.isArray(plan.actionable)
  ? plan.actionable
  : plan.actionable
    ? [String(plan.actionable)]
    : [];

if (!pgOk) {
  return [{
    json: {
      ok: false,
      dry_run: true,
      found_match: foundMatch,
      match_count: matchCount,
      error_code: plan.error_code || 'plan_failed',
      message: plan.message || 'Operator room release plan failed',
      errors: mergeErrors(actionable, [plan.error_code]),
      original_booking_code: plan.original_booking_code || null,
      payments_untouched: paymentsUntouched
    }
  }];
}

if (!planOk) {
  return [{
    json: {
      ok: false,
      dry_run: true,
      found_match: foundMatch,
      match_count: matchCount,
      error_code: plan.error_code || 'plan_not_actionable',
      message: plan.message || 'Plan is not actionable',
      errors: mergeErrors(actionable, [plan.error_code]),
      original_booking_code: plan.original_booking_code || null,
      block_a_booking_code: plan.block_a_booking_code || null,
      block_b_booking_code: plan.block_b_booking_code || null,
      would_create_a: plan.should_create_a === true,
      would_create_b: plan.should_create_b === true,
      would_cancel_beds: Number(plan.beds_count ?? 0),
      payments_untouched: paymentsUntouched
    }
  }];
}

return [{
  json: {
    ok: true,
    dry_run: true,
    found_match: foundMatch,
    match_count: matchCount,
    original_booking_code: plan.original_booking_code || null,
    original_booking_id: plan.original_booking_id || null,
    would_cancel_beds: Number(plan.beds_count ?? 0),
    would_create_a: plan.should_create_a === true,
    would_create_b: plan.should_create_b === true,
    block_a_booking_code: plan.block_a_booking_code || null,
    block_b_booking_code: plan.block_b_booking_code || null,
    block_a_check_in: plan.block_a_check_in || null,
    block_a_check_out: plan.block_a_check_out || null,
    block_b_check_in: plan.block_b_check_in || null,
    block_b_check_out: plan.block_b_check_out || null,
    overlap_count: Number(plan.overlap_count ?? 0),
    payments_untouched: paymentsUntouched,
    request_code: plan.request_code || parsed.request_code || null,
    message: plan.message || 'Operator room release dry-run preview',
    error_code: null,
    errors: mergeErrors(plan.warnings, [])
  }
}];`;

function uid(seed) {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function loadHostedWorkflow() {
  let raw;
  try {
    raw = fs.readFileSync(HOSTED, 'utf8');
  } catch (err) {
    console.error(`Failed to read hosted workflow: ${err.message}`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Invalid JSON in hosted workflow: ${err.message}`);
    process.exit(1);
  }
}

/** @param {object} workflow */
function listNodes(workflow) {
  return Array.isArray(workflow.nodes) ? workflow.nodes : [];
}

/** @param {object} workflow */
function findWebhookNodes(workflow) {
  return listNodes(workflow).filter((n) => n.type === 'n8n-nodes-base.webhook');
}

/** @param {object} workflow */
function findAirtableNodes(workflow) {
  return listNodes(workflow).filter((n) => n.type === 'n8n-nodes-base.airtable');
}

/** @param {object} workflow */
function findCodeNodes(workflow) {
  return listNodes(workflow).filter((n) => n.type === 'n8n-nodes-base.code');
}

/** @param {object} workflow */
function findHttpNodes(workflow) {
  return listNodes(workflow).filter((n) => n.type === 'n8n-nodes-base.httpRequest');
}

/** @param {object} workflow */
function findIfNodes(workflow) {
  return listNodes(workflow).filter((n) => n.type === 'n8n-nodes-base.if');
}

/** @param {object} node */
function extractAirtableBaseId(node) {
  const base = node.parameters?.base;
  if (!base) return null;
  if (typeof base === 'string') return base;
  if (base.value) return String(base.value);
  return null;
}

/** @param {object} node */
function extractAirtableTableId(node) {
  const table = node.parameters?.table;
  if (!table) return null;
  if (typeof table === 'string') return table;
  if (table.value) return String(table.value);
  return null;
}

/** @param {object} workflow */
function collectAirtableTargets(workflow) {
  const bases = new Set();
  const tables = new Set();
  const details = [];

  for (const n of findAirtableNodes(workflow)) {
    const baseId = extractAirtableBaseId(n);
    const tableId = extractAirtableTableId(n);
    if (baseId) bases.add(baseId);
    if (tableId) tables.add(tableId);
    details.push({
      name: n.name,
      operation: n.parameters?.operation || 'get',
      baseId: baseId || '(unknown)',
      tableId: tableId || '(unknown)',
    });
  }

  return { bases: [...bases].sort(), tables: [...tables].sort(), details };
}

/** BFS from webhook(s) following main connections. @param {object} workflow */
function computeHostedFlowOrder(workflow) {
  const connections = workflow.connections || {};
  const webhooks = findWebhookNodes(workflow);
  if (!webhooks.length) return [];

  const order = [];
  const seen = new Set();
  const queue = webhooks.map((w) => w.name);

  while (queue.length) {
    const name = queue.shift();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    order.push(name);

    const nodeConn = connections[name];
    if (!nodeConn?.main) continue;
    for (const branch of nodeConn.main) {
      if (!Array.isArray(branch)) continue;
      for (const edge of branch) {
        if (edge?.node && !seen.has(edge.node)) queue.push(edge.node);
      }
    }
  }

  const allNames = listNodes(workflow).map((n) => n.name);
  const disconnected = allNames.filter((n) => !seen.has(n)).sort();
  if (disconnected.length) {
    order.push('--- (not reachable from webhook) ---');
    order.push(...disconnected);
  }

  return order;
}

function formatNodeLine(node) {
  const shortType = (node.type || '').replace('n8n-nodes-base.', '');
  return `  - ${node.name} | ${shortType} | id=${node.id}`;
}

/** @param {object} workflow */
function printInventory(workflow) {
  const nodes = listNodes(workflow);
  const hostedId = workflow.id || '(none in export)';
  const hostedName = workflow.name || '(unnamed)';
  const webhooks = findWebhookNodes(workflow);
  const airtable = collectAirtableTargets(workflow);
  const flowOrder = computeHostedFlowOrder(workflow);

  console.log('=== Operator Room Release hosted workflow inventory ===');
  console.log(`Hosted file: ${HOSTED}`);
  console.log(`Hosted workflow name: ${hostedName}`);
  console.log(`Hosted workflow id: ${hostedId}`);
  console.log(`Hosted active (export): ${workflow.active === true}`);
  console.log('');
  console.log(`Planned local workflow name: ${LOCAL_WORKFLOW_NAME}`);
  console.log(`Planned local workflow id: ${LOCAL_WORKFLOW_ID}`);
  console.log(`Planned local webhook path: ${LOCAL_WEBHOOK_PATH}`);
  console.log(`Planned local webhook UUID: ${LOCAL_WEBHOOK_ID}`);
  console.log(`CLIENT_SLUG: ${CLIENT_SLUG}`);
  console.log(`OUT_DIR: ${OUT_DIR}`);
  console.log(`Node count (hosted): ${nodes.length}`);
  console.log('');

  console.log('--- Webhook nodes ---');
  for (const w of webhooks) {
    const p = w.parameters || {};
    console.log(formatNodeLine(w));
    console.log(`    path: ${p.path || '(missing)'}`);
    console.log(`    webhookId: ${w.webhookId || '(missing)'}`);
  }
  console.log('');

  console.log(`Production base ${PROD_AIRTABLE_BASE_ID}: ${airtable.details.filter((d) => d.baseId === PROD_AIRTABLE_BASE_ID).length} Airtable node(s)`);
  console.log('');

  console.log('--- Current hosted flow order (BFS from webhook) ---');
  for (const name of flowOrder) console.log(`  ${name}`);
  console.log('');

  console.log('--- Nodes likely to DROP in local MVP ---');
  for (const name of HOSTED_NODES_DROP_MVP) console.log(`  - ${name}`);
  console.log('');

  console.log('--- Planned local target graph ---');
  for (const line of PLANNED_LOCAL_GRAPH) console.log(`  ${line}`);
  console.log('');
  console.log(`Hosted source unchanged: ${HOSTED}`);
}

function buildDryRunWorkflow() {
  return {
    name: LOCAL_WORKFLOW_NAME,
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: LOCAL_WEBHOOK_PATH,
          responseMode: 'responseNode',
          options: {},
        },
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2.1,
        position: [-640, 0],
        id: uid('orr-webhook-local'),
        name: 'Webhook - Operator Room Release',
        webhookId: LOCAL_WEBHOOK_ID,
      },
      {
        parameters: { jsCode: PARSE_RELEASE_PAYLOAD_JS },
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [-440, 0],
        id: uid('orr-parse-payload'),
        name: PARSE_NODE,
      },
      {
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [
              {
                id: 'parse-ok',
                leftValue: '={{ $json.parse_ok }}',
                rightValue: '',
                operator: { type: 'boolean', operation: 'true', singleValue: true },
              },
            ],
            combinator: 'and',
          },
          options: {},
        },
        type: 'n8n-nodes-base.if',
        typeVersion: 2.2,
        position: [-240, 0],
        id: uid('orr-if-parse-ok'),
        name: 'IF - Parse OK',
      },
      {
        parameters: {
          operation: 'executeQuery',
          query: PG_OPERATOR_ROOM_RELEASE_PLAN_SQL,
          options: {
            queryReplacement: PG_OPERATOR_ROOM_RELEASE_PLAN_QUERY_REPLACEMENT,
          },
        },
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [-40, -80],
        id: uid('orr-postgres-plan'),
        name: PLAN_NODE,
        alwaysOutputData: true,
        continueOnFail: true,
        onError: 'continueRegularOutput',
        credentials: {
          postgres: LOCAL_N8N.postgresCred,
        },
      },
      {
        parameters: { jsCode: BUILD_RESPONSE_JS },
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [200, 0],
        id: uid('orr-build-response'),
        name: BUILD_RESPONSE_NODE,
      },
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ $json }}',
          options: {},
        },
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [440, 0],
        id: uid('orr-respond-webhook'),
        name: 'Respond to Webhook',
      },
    ],
    connections: {
      'Webhook - Operator Room Release': {
        main: [[{ node: PARSE_NODE, type: 'main', index: 0 }]],
      },
      [PARSE_NODE]: {
        main: [[{ node: 'IF - Parse OK', type: 'main', index: 0 }]],
      },
      'IF - Parse OK': {
        main: [
          [{ node: PLAN_NODE, type: 'main', index: 0 }],
          [{ node: BUILD_RESPONSE_NODE, type: 'main', index: 0 }],
        ],
      },
      [PLAN_NODE]: {
        main: [[{ node: BUILD_RESPONSE_NODE, type: 'main', index: 0 }]],
      },
      [BUILD_RESPONSE_NODE]: {
        main: [[{ node: 'Respond to Webhook', type: 'main', index: 0 }]],
      },
    },
    pinData: {},
    active: false,
    id: LOCAL_WORKFLOW_ID,
    settings: { executionOrder: 'v1', binaryMode: 'separate' },
    tags: [{ name: 'phase3b' }, { name: 'local-only' }, { name: 'dry-run-only' }],
  };
}

function writeLocalWorkflow(workflow) {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }
  const payload = {
    ...workflow,
    id: LOCAL_WORKFLOW_ID,
    name: LOCAL_WORKFLOW_NAME,
    active: false,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(OUT_IMPORT, `${JSON.stringify([payload], null, 2)}\n`);
  return payload;
}

function printGenerateSummary(workflow) {
  const webhooks = findWebhookNodes(workflow);
  console.log(`Wrote ${OUT}`);
  console.log(`Wrote ${OUT_IMPORT} (CLI re-import with stable id ${LOCAL_WORKFLOW_ID})`);
  console.log(`Workflow name: ${workflow.name}`);
  console.log(`Workflow id: ${workflow.id}`);
  console.log(`Active: ${workflow.active}`);
  console.log(`Webhook path: ${webhooks[0]?.parameters?.path || LOCAL_WEBHOOK_PATH}`);
  console.log(`Webhook id: ${webhooks[0]?.webhookId || LOCAL_WEBHOOK_ID}`);
  console.log(`Node count: ${listNodes(workflow).length}`);
  console.log('Postgres nodes: 1 (plan / read-only SELECT)');
  console.log('Execute mutations: not included (Step 3 dry-run only)');
  console.log(`Hosted source unchanged: ${HOSTED}`);
}

/** @returns {object} */
function loadGeneratedWorkflowForVerify() {
  if (!fs.existsSync(OUT)) {
    console.error(`Generated workflow not found: ${OUT}`);
    console.error('Run with --generate first.');
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch (err) {
    console.error(`Invalid JSON in generated workflow: ${err.message}`);
    process.exit(1);
  }
}

const MUTATION_SQL_PATTERNS = [
  /DELETE\s+FROM\s+booking_beds/i,
  /INSERT\s+INTO\s+bookings/i,
  /UPDATE\s+bookings\s+SET/i,
  /INSERT\s+INTO\s+payments/i,
  /UPDATE\s+payments\s+SET/i,
  /INSERT\s+INTO\s+payment_events/i,
  /UPDATE\s+payment_events\s+SET/i,
  /DELETE\s+FROM\s+payments/i,
];

/**
 * @param {object} workflow
 * @returns {{ ok: boolean, issues: string[], airtableHitCount: number, prodAirtableHitCount: number }}
 */
function verifyGeneratedWorkflow(workflow) {
  const issues = [];
  const nodes = listNodes(workflow);
  const blob = JSON.stringify(workflow);

  if (workflow.active !== false) {
    issues.push(`active must be false (got ${workflow.active})`);
  }
  if (workflow.id !== LOCAL_WORKFLOW_ID) {
    issues.push(`workflow id must be ${LOCAL_WORKFLOW_ID}`);
  }
  if (nodes.length !== 6) {
    issues.push(`expected 6 nodes, got ${nodes.length}`);
  }

  const airtableNodes = findAirtableNodes(workflow);
  if (airtableNodes.length > 0) {
    issues.push(`Airtable nodes present: ${airtableNodes.map((n) => n.name).join(', ')}`);
  }

  let prodAirtableHitCount = 0;
  if (blob.includes(PROD_AIRTABLE_BASE_ID)) {
    prodAirtableHitCount += 1;
    issues.push(`production Airtable base ${PROD_AIRTABLE_BASE_ID} found in JSON`);
  }

  const pgNodes = nodes.filter((n) => n.type === 'n8n-nodes-base.postgres');
  if (pgNodes.length !== 1) {
    issues.push(`expected 1 Postgres node, got ${pgNodes.length}`);
  } else if (pgNodes[0].name !== PLAN_NODE) {
    issues.push(`Postgres node must be named ${PLAN_NODE}`);
  }

  for (const node of pgNodes) {
    const q = String(node.parameters?.query || '');
    if (!q.includes('actionable_build')) {
      issues.push('Postgres query does not look like plan SQL (missing actionable_build)');
    }
    for (const re of MUTATION_SQL_PATTERNS) {
      if (re.test(q)) {
        issues.push(`mutation SQL pattern in Postgres node: ${re}`);
      }
    }
  }

  const expectedNames = new Set([
    'Webhook - Operator Room Release',
    PARSE_NODE,
    'IF - Parse OK',
    PLAN_NODE,
    BUILD_RESPONSE_NODE,
    'Respond to Webhook',
  ]);
  for (const n of nodes) {
    if (!expectedNames.has(n.name)) {
      issues.push(`unexpected node: ${n.name}`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    airtableHitCount: airtableNodes.length,
    prodAirtableHitCount,
  };
}

/** @param {{ ok: boolean, issues: string[], airtableHitCount: number, prodAirtableHitCount: number }} result */
function printVerifyReport(result) {
  console.log(`File: ${OUT}`);
  console.log(`Prod Airtable base hits: ${result.prodAirtableHitCount}`);
  console.log(`Airtable node count: ${result.airtableHitCount}`);
  console.log(`Active false: required`);
  console.log(`Mutation Postgres nodes: 0 (plan SELECT only)`);
  if (result.issues.length) {
    console.error('FAIL:');
    for (const issue of result.issues) console.error(`  - ${issue}`);
  } else {
    console.log('OK: dry-run workflow passes safety checks.');
  }
}

function runVerifyTargets(workflow, opts = {}) {
  const { exitOnFail = true } = opts;
  const wf = workflow || loadGeneratedWorkflowForVerify();
  const result = verifyGeneratedWorkflow(wf);
  printVerifyReport(result);
  if (exitOnFail && !result.ok) process.exit(1);
  return result;
}

function printUsage() {
  console.error(`Usage:
  node scripts/build-operator-room-release-local.js --inventory
  node scripts/build-operator-room-release-local.js --generate
  node scripts/build-operator-room-release-local.js --verify-targets`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--inventory')) {
    printInventory(loadHostedWorkflow());
    return;
  }

  if (args.includes('--generate')) {
    const workflow = buildDryRunWorkflow();
    writeLocalWorkflow(workflow);
    printGenerateSummary(workflow);
    runVerifyTargets(workflow, { exitOnFail: true });
    return;
  }

  if (args.includes('--verify-targets')) {
    runVerifyTargets();
    return;
  }

  printUsage();
  process.exit(1);
}

main();
