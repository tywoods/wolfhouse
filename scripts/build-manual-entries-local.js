/**
 * Build n8n/phase3b/Wolfhouse - Manual Entries Queue Processor (local PG).json
 *
 * Phase 3b.4c — Postgres mirror (3b.4b logic) then hosted Airtable + Sheets nodes.
 * Does NOT modify n8n/Wolfhouse - Manual Entries Queue Processor.json (hosted export).
 *
 * Step 1: inventory
 *   node scripts/build-manual-entries-local.js --inventory
 *
 * Step 2: generate local fork JSON (no PG nodes yet)
 *   node scripts/build-manual-entries-local.js --generate
 *
 * Step 3a: verify no production Sheet/Airtable targets in generated JSON
 *   node scripts/build-manual-entries-local.js --verify-targets
 *
 * Step 3b: --generate replaces prod Sheet/Airtable base IDs with local test targets (table IDs unchanged)
 *
 * Step 4: --generate also writes .n8n-import.json for CLI re-import (stable id B3c4ManualEntriesLocal01)
 *
 * Step 6b: delete-branch PG nodes (create/update PG — later steps)
 * TODO Step 3+: insert PG create/update/backfill nodes
 * TODO Step 3+: add structured response node with partial_failure
 * TODO Step 3+: remap node credentials to LOCAL_N8N ids on generate (like assign/cancel builds)
 * TODO Step 3+: update docs and PowerShell test script
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PG_MANUAL_ENTRY_DELETE_SQL } = require('./lib/manual-entry-pg-n8n-sql');

const HOSTED = path.join(__dirname, '..', 'n8n', 'Wolfhouse - Manual Entries Queue Processor.json');
const OUT_DIR = path.join(__dirname, '..', 'n8n', 'phase3b');
const OUT = path.join(OUT_DIR, 'Wolfhouse - Manual Entries Queue Processor (local PG).json');
const OUT_IMPORT = path.join(
  OUT_DIR,
  'Wolfhouse - Manual Entries Queue Processor (local PG).n8n-import.json',
);
const LOCAL_WORKFLOW_ID = 'B3c4ManualEntriesLocal01';

/** Stable ids from local n8n after first UI import — used when remapping credentials in a later step. */
const LOCAL_N8N = {
  workflowId: LOCAL_WORKFLOW_ID,
  postgresCred: { id: 'MnnrrLecI7oVoIGq', name: 'Postgres account' },
  airtableCred: { id: 'tEUby6EPDxFQ5st8', name: 'Airtable Personal Access Token account' },
};
const CLIENT_SLUG = 'wolfhouse-somo';
const LOCAL_WORKFLOW_NAME = 'Wolfhouse - Manual Entries Queue Processor (local PG)';

/**
 * Stable local webhook UUID — same style as cancel/assign/reassign build scripts
 * (8-4-4-4-12 hex, e.g. 3b2c0001-0002-4000-8000-000000000002).
 * Not the hosted id a17ba7e1-… (shared with Send Confirmation on path collision risk).
 * Requested b3c4manual-entries-local-pg-000000000001 is not valid UUID format for n8n.
 */
const LOCAL_WEBHOOK_ID = 'b3c4c001-0004-4000-8000-000000000004';

const CONTROL_TYPES = new Set([
  'n8n-nodes-base.switch',
  'n8n-nodes-base.if',
  'n8n-nodes-base.merge',
  'n8n-nodes-base.splitInBatches',
  'n8n-nodes-base.filter',
  'n8n-nodes-base.wait',
  'n8n-nodes-base.noOp',
]);

const INVENTORY_PATTERNS = [
  'Manual Entries!P',
  'P:R',
  'Manual Entries!A1:R',
  'tblYWm3zKFafe4qu7',
  'tblO1ByvTMXS4SalB',
  'wolfhouse-manual-entries-queue',
];

/** Production targets that must not remain in the local fork before import/run. */
const PROD_SHEET_SPREADSHEET_ID = '1eISph-eVZpylAEFVRS22hxRvWydBj07vz6G-vO7T_cc';
const PROD_AIRTABLE_BASE_ID = 'appOCWIN47Bui9CSS';

/** Local test targets for Manual Entries fork (--generate rewrites hosted export references). */
const TEST_SHEET_SPREADSHEET_ID = '1JIY22nrtHXWEi6gPWvvpDfgG8Xe0jT6hmGGzkNXRs10';
const TEST_AIRTABLE_BASE_ID = 'appiyO4FmkKsyHZdK';

const NULL_SENTINEL = '__NULL__';
const PICK_NODE = 'Code - Pick Next Manual Queue Item';

const PG_DELETE_QUERY_REPLACEMENT = `={{ (($('${PICK_NODE}').first().json.airtable_booking_record_id) != null && String($('${PICK_NODE}').first().json.airtable_booking_record_id).trim() !== '') ? String($('${PICK_NODE}').first().json.airtable_booking_record_id).trim() : '${NULL_SENTINEL}' }},={{ '${NULL_SENTINEL}' }},={{ (($('${PICK_NODE}').first().json.manual_entry_id) != null && String($('${PICK_NODE}').first().json.manual_entry_id).trim() !== '') ? String($('${PICK_NODE}').first().json.manual_entry_id).trim() : '${NULL_SENTINEL}' }}`;

const VALIDATE_PG_DELETE_JS = `const pick = $('${PICK_NODE}').first().json;
const pgItems = $('Postgres - Manual Entry Delete').all();
const pgItem = pgItems[0];
const pgErr = pgItem?.error;
const pg = pgItem?.json || {};

if (pgErr) {
  const msg = String(pgErr.message || pgErr);
  return [{
    json: {
      pg_ok: false,
      errors: [msg.includes('no parameter') ? 'postgres_query_param_missing' : 'postgres_manual_entry_delete_failed'],
      manual_entry_id: pick.manual_entry_id,
      airtable_booking_record_id: pick.airtable_booking_record_id,
      pg_deleted_count: 0,
      partial_failure: 'pg_query_failed',
      message: msg
    }
  }];
}

const resolved = Number(pg.booking_rows_resolved ?? 0);

if (resolved !== 1) {
  return [{
    json: {
      pg_ok: false,
      errors: [resolved === 0 ? 'booking_not_found_in_postgres' : 'booking_ambiguous_in_postgres'],
      manual_entry_id: pick.manual_entry_id,
      airtable_booking_record_id: pick.airtable_booking_record_id,
      pg_deleted_count: 0,
      partial_failure: 'pg_resolve_failed',
      message: 'Postgres could not resolve exactly one booking — Airtable delete steps skipped'
    }
  }];
}

const errors = [];
const payBefore = String(pg.payment_status_before || '');
const payAfter = String(pg.payment_status_after || '');
if (payBefore && payAfter && payBefore !== payAfter) {
  errors.push('payment_status_changed_during_pg_delete');
}

return [{
  json: {
    pg_ok: true,
    errors,
    ...pg,
    manual_entry_id: pick.manual_entry_id,
    airtable_booking_record_id: pick.airtable_booking_record_id,
    booking_code: pg.booking_code || pick.booking_code || ''
  }
}];`;

function uid(seed) {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Insert delete-branch PG gate after HTTP - Mark Delete Processing (Step 6b).
 * @param {object} workflow
 */
function injectDeleteBranchPgNodes(workflow) {
  const required = ['HTTP - Mark Delete Processing', 'Search Booking Beds For Delete'];
  for (const name of required) {
    if (!listNodes(workflow).some((n) => n.name === name)) {
      throw new Error(`Cannot inject delete PG nodes: missing "${name}"`);
    }
  }
  if (listNodes(workflow).some((n) => n.name === 'Postgres - Manual Entry Delete')) {
    return workflow;
  }

  const pgNodes = [
    {
      parameters: {
        operation: 'executeQuery',
        query: PG_MANUAL_ENTRY_DELETE_SQL,
        options: { queryReplacement: PG_DELETE_QUERY_REPLACEMENT },
      },
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [920, 224],
      id: uid('postgres-manual-entry-delete'),
      name: 'Postgres - Manual Entry Delete',
      alwaysOutputData: true,
      continueOnFail: true,
      onError: 'continueRegularOutput',
      credentials: { postgres: LOCAL_N8N.postgresCred },
    },
    {
      parameters: { jsCode: VALIDATE_PG_DELETE_JS },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [992, 224],
      id: uid('validate-pg-manual-delete'),
      name: 'Code - Validate PG Delete',
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            {
              id: 'pg-delete-ok',
              leftValue: '={{ $json.pg_ok }}',
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
      position: [1064, 224],
      id: uid('if-pg-delete-ok'),
      name: 'IF - PG Delete OK',
    },
  ];

  workflow.nodes.push(...pgNodes);

  const conn = workflow.connections || {};
  workflow.connections = conn;

  conn['HTTP - Mark Delete Processing'] = {
    main: [[{ node: 'Postgres - Manual Entry Delete', type: 'main', index: 0 }]],
  };
  conn['Postgres - Manual Entry Delete'] = {
    main: [[{ node: 'Code - Validate PG Delete', type: 'main', index: 0 }]],
  };
  conn['Code - Validate PG Delete'] = {
    main: [[{ node: 'IF - PG Delete OK', type: 'main', index: 0 }]],
  };
  conn['IF - PG Delete OK'] = {
    main: [
      [{ node: 'Search Booking Beds For Delete', type: 'main', index: 0 }],
      [],
    ],
  };

  return workflow;
}

/** @returns {object} */
function loadHostedWorkflow() {
  if (!fs.existsSync(HOSTED)) {
    console.error(`Hosted workflow not found: ${HOSTED}`);
    process.exit(1);
  }
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

/** Google Sheets API via HTTP or native googleSheets nodes. */
function findGoogleSheetsNodes(workflow) {
  return listNodes(workflow).filter((n) => {
    if (n.type === 'n8n-nodes-base.googleSheets') return true;
    if (n.type !== 'n8n-nodes-base.httpRequest') return false;
    const blob = JSON.stringify(n.parameters || {});
    return /sheets\.googleapis\.com/i.test(blob) || /Manual%20Entries|Manual Entries/i.test(blob);
  });
}

function findAirtableNodes(workflow) {
  return listNodes(workflow).filter((n) => n.type === 'n8n-nodes-base.airtable');
}

function findHttpNodes(workflow) {
  return listNodes(workflow).filter((n) => n.type === 'n8n-nodes-base.httpRequest');
}

function findCodeNodes(workflow) {
  return listNodes(workflow).filter((n) => n.type === 'n8n-nodes-base.code');
}

function findControlNodes(workflow) {
  return listNodes(workflow).filter((n) => CONTROL_TYPES.has(n.type));
}

/** @param {object} workflow @param {string} pattern */
function findNodesMentioning(workflow, pattern) {
  const re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return listNodes(workflow).filter((n) => {
    const blob = JSON.stringify(n);
    return re.test(blob);
  });
}

/** @param {object} workflow @param {string} switchName @param {number} outputIndex */
function collectDownstreamNodeNames(workflow, switchName, outputIndex) {
  const connections = workflow.connections || {};
  const switchConn = connections[switchName];
  if (!switchConn?.main?.[outputIndex]) return [];

  const byName = new Map(listNodes(workflow).map((n) => [n.name, n]));
  const visited = new Set();
  const queue = switchConn.main[outputIndex].map((c) => c.node);

  while (queue.length) {
    const name = queue.shift();
    if (!name || visited.has(name)) continue;
    visited.add(name);
    const nodeConn = connections[name];
    if (!nodeConn?.main) continue;
    for (const outputs of nodeConn.main) {
      if (!Array.isArray(outputs)) continue;
      for (const edge of outputs) {
        if (edge?.node) queue.push(edge.node);
      }
    }
  }

  return [...visited]
    .filter((name) => byName.has(name))
    .sort((a, b) => a.localeCompare(b));
}

/** Heuristic branch nodes by name when not tracing from Switch. */
function likelyBranchNodes(workflow, kind) {
  const rules = {
    create: /\bcreate\b/i,
    update: /\bupdate\b/i,
    delete: /\b(delete|cancelled|cancel)\b/i,
  };
  const re = rules[kind];
  if (!re) return [];
  return listNodes(workflow)
    .filter((n) => re.test(n.name))
    .map((n) => n.name)
    .sort();
}

function formatNodeLine(node) {
  return `  - ${node.name} | ${node.type} | id=${node.id}`;
}

/** @param {object} workflow */
function printInventory(workflow) {
  const nodes = listNodes(workflow);
  const hostedId = workflow.id || '(none in export)';
  const hostedName = workflow.name || '(unnamed)';

  console.log('=== Manual Entries hosted workflow inventory ===');
  console.log(`Hosted file: ${HOSTED}`);
  console.log(`Planned local name: ${LOCAL_WORKFLOW_NAME}`);
  console.log(`Planned local workflow id: ${LOCAL_WORKFLOW_ID}`);
  console.log(`Planned local webhookId: ${LOCAL_WEBHOOK_ID}`);
  console.log(`CLIENT_SLUG (future PG): ${CLIENT_SLUG}`);
  console.log(`OUT_DIR (future output): ${OUT_DIR}`);
  console.log('');
  console.log(`Workflow name: ${hostedName}`);
  console.log(`Workflow id: ${hostedId}`);
  console.log(`Node count: ${nodes.length}`);
  console.log('');

  console.log('--- Webhook nodes ---');
  for (const w of findWebhookNodes(workflow)) {
    const p = w.parameters || {};
    console.log(formatNodeLine(w));
    console.log(`    path: ${p.path || '(missing)'}`);
    console.log(`    webhookId: ${w.webhookId || '(missing)'}`);
    console.log(`    httpMethod: ${p.httpMethod || '(default)'}`);
  }
  console.log('');

  console.log('--- All nodes (name | type | id) ---');
  for (const n of [...nodes].sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(formatNodeLine(n));
  }
  console.log('');

  const createBranch = collectDownstreamNodeNames(workflow, 'Switch - Queue Action', 0);
  const updateBranch = collectDownstreamNodeNames(workflow, 'Switch - Queue Action', 1);
  const deleteBranch = collectDownstreamNodeNames(workflow, 'Switch - Queue Action', 2);

  console.log('--- Likely create branch (from Switch - Queue Action output 0) ---');
  if (createBranch.length) {
    for (const name of createBranch) console.log(`  - ${name}`);
  } else {
    for (const name of likelyBranchNodes(workflow, 'create')) console.log(`  - ${name}`);
  }
  console.log('');

  console.log('--- Likely update branch (from Switch - Queue Action output 1) ---');
  if (updateBranch.length) {
    for (const name of updateBranch) console.log(`  - ${name}`);
  } else {
    for (const name of likelyBranchNodes(workflow, 'update')) console.log(`  - ${name}`);
  }
  console.log('');

  console.log('--- Likely delete/cancel branch (from Switch - Queue Action output 2) ---');
  if (deleteBranch.length) {
    for (const name of deleteBranch) console.log(`  - ${name}`);
  } else {
    for (const name of likelyBranchNodes(workflow, 'delete')) console.log(`  - ${name}`);
  }
  console.log('');

  const sections = [
    ['Google Sheets (HTTP or native)', findGoogleSheetsNodes(workflow)],
    ['Airtable', findAirtableNodes(workflow)],
    ['HTTP Request', findHttpNodes(workflow)],
    ['Code', findCodeNodes(workflow)],
    ['Switch/IF/control', findControlNodes(workflow)],
  ];

  for (const [title, list] of sections) {
    console.log(`--- ${title} (${list.length}) ---`);
    for (const n of list) console.log(formatNodeLine(n));
    console.log('');
  }

  for (const pattern of INVENTORY_PATTERNS) {
    const hits = findNodesMentioning(workflow, pattern);
    console.log(`--- Nodes mentioning "${pattern}" (${hits.length}) ---`);
    for (const n of hits) console.log(formatNodeLine(n));
    console.log('');
  }

  console.log('=== End inventory (no files written) ===');
}

/**
 * Replace prod Sheet/Airtable base IDs in entire workflow tree (URLs, node params, cachedResultUrl).
 * Airtable table IDs (tbl…) are unchanged — duplicated test base keeps same table ids.
 * @param {object} workflow
 * @returns {{ workflow: object, sheetReplacements: number, baseReplacements: number }}
 */
function neutralizeProductionTargets(workflow) {
  let json = JSON.stringify(workflow);
  const sheetReplacements = json.split(PROD_SHEET_SPREADSHEET_ID).length - 1;
  const baseReplacements = json.split(PROD_AIRTABLE_BASE_ID).length - 1;
  json = json.split(PROD_SHEET_SPREADSHEET_ID).join(TEST_SHEET_SPREADSHEET_ID);
  json = json.split(PROD_AIRTABLE_BASE_ID).join(TEST_AIRTABLE_BASE_ID);
  return {
    workflow: JSON.parse(json),
    sheetReplacements,
    baseReplacements,
  };
}

/** Deep-clone hosted workflow into local fork metadata (Step 2–3b — no PG nodes). */
function buildLocalWorkflowFromHosted(hosted) {
  const workflow = JSON.parse(JSON.stringify(hosted));
  workflow.name = LOCAL_WORKFLOW_NAME;
  workflow.id = LOCAL_WORKFLOW_ID;
  workflow.active = false;
  workflow.tags = [{ name: 'phase3b' }, { name: 'local-only' }];
  workflow.settings = {
    executionOrder: 'v1',
    binaryMode: 'separate',
  };
  delete workflow.versionId;
  delete workflow.meta;

  for (const node of findWebhookNodes(workflow)) {
    node.webhookId = LOCAL_WEBHOOK_ID;
  }

  const neutralized = neutralizeProductionTargets(workflow);
  if (neutralized.sheetReplacements === 0 && neutralized.baseReplacements === 0) {
    console.warn(
      'WARN: no prod Sheet/Airtable base IDs found in hosted export — neutralization may be a no-op',
    );
  }
  injectDeleteBranchPgNodes(neutralized.workflow);
  return neutralized;
}

function writeLocalWorkflow(workflow) {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }
  const payload = { ...workflow, id: LOCAL_WORKFLOW_ID, name: LOCAL_WORKFLOW_NAME, active: false };
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(OUT_IMPORT, `${JSON.stringify([payload], null, 2)}\n`);
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

/**
 * @param {object} workflow
 * @returns {{ ok: boolean, sheetHitCount: number, airtableHitCount: number, sheetNodes: string[], airtableNodes: string[] }}
 */
function verifyProductionTargets(workflow) {
  const sheetNodes = [];
  const airtableNodes = [];

  for (const node of listNodes(workflow)) {
    const blob = JSON.stringify(node);
    if (blob.includes(PROD_SHEET_SPREADSHEET_ID)) {
      sheetNodes.push(node.name);
    }
    if (blob.includes(PROD_AIRTABLE_BASE_ID)) {
      airtableNodes.push(node.name);
    }
  }

  return {
    ok: sheetNodes.length === 0 && airtableNodes.length === 0,
    sheetHitCount: sheetNodes.length,
    airtableHitCount: airtableNodes.length,
    sheetNodes,
    airtableNodes,
  };
}

/** @param {{ ok: boolean, sheetHitCount: number, airtableHitCount: number, sheetNodes: string[], airtableNodes: string[] }} result */
function printVerifyTargetsReport(result) {
  console.log(`File: ${OUT}`);
  console.log(`Prod Sheet hit count (nodes): ${result.sheetHitCount}`);
  console.log(`Prod Airtable hit count (nodes): ${result.airtableHitCount}`);
  if (result.sheetNodes.length) {
    console.log(`Sheet nodes: ${result.sheetNodes.join(', ')}`);
  }
  if (result.airtableNodes.length) {
    console.log(`Airtable nodes: ${result.airtableNodes.join(', ')}`);
  }
  if (result.ok) {
    console.log('OK: no production Sheet or Airtable base references.');
  } else {
    console.error('FAIL: production targets remain. Neutralize before import/run.');
  }
}

/** @param {object} [workflow] @param {{ exitOnFail?: boolean }} [opts] */
function runVerifyTargets(workflow, opts = {}) {
  const { exitOnFail = true } = opts;
  const wf = workflow || loadGeneratedWorkflowForVerify();
  const result = verifyProductionTargets(wf);
  printVerifyTargetsReport(result);
  if (exitOnFail && !result.ok) {
    process.exit(1);
  }
  return result;
}

/** @param {object} workflow */
function printGenerateSummary(workflow) {
  const webhooks = findWebhookNodes(workflow);
  const path =
    webhooks.length === 1
      ? webhooks[0].parameters?.path || '(missing)'
      : webhooks.map((w) => `${w.name}=${w.parameters?.path || '?'}`).join(', ');

  console.log(`Wrote ${OUT}`);
  console.log(`Wrote ${OUT_IMPORT} (CLI re-import with stable id ${LOCAL_N8N.workflowId})`);
  console.log(`Workflow name: ${workflow.name}`);
  console.log(`Workflow id: ${workflow.id}`);
  console.log(`Active: ${workflow.active}`);
  console.log(`Webhook path: ${path}`);
  console.log(
    `Webhook id: ${webhooks.length === 1 ? webhooks[0].webhookId : webhooks.map((w) => w.webhookId).join(', ')}`,
  );
  console.log(`Node count: ${listNodes(workflow).length}`);
  const pgDelete = listNodes(workflow).some((n) => n.name === 'Postgres - Manual Entry Delete');
  console.log(`Delete-branch PG nodes: ${pgDelete ? 'yes' : 'no'}`);
  console.log(`Hosted source unchanged: ${HOSTED}`);
  console.log(`Test Sheet ID: ${TEST_SHEET_SPREADSHEET_ID}`);
  console.log(`Test Airtable base ID: ${TEST_AIRTABLE_BASE_ID}`);
}

function printUsage() {
  console.error(`Usage:
  node scripts/build-manual-entries-local.js --inventory
  node scripts/build-manual-entries-local.js --generate
  node scripts/build-manual-entries-local.js --verify-targets`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--inventory')) {
    const workflow = loadHostedWorkflow();
    printInventory(workflow);
    return;
  }

  if (args.includes('--verify-targets')) {
    runVerifyTargets();
    return;
  }

  if (args.includes('--generate')) {
    const hosted = loadHostedWorkflow();
    const { workflow: local, sheetReplacements, baseReplacements } = buildLocalWorkflowFromHosted(hosted);
    writeLocalWorkflow(local);
    printGenerateSummary(local);
    console.log(
      `Neutralized: ${sheetReplacements} Sheet ID substitution(s), ${baseReplacements} Airtable base substitution(s)`,
    );
    console.log('');
    runVerifyTargets(local);
    return;
  }

  printUsage();
  process.exit(1);
}

main();
