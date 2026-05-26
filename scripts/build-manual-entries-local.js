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
 * TODO Step 3+: align CLIENT_SLUG with other build scripts (e.g. wolfhouse-somo) before PG SQL
 * TODO Step 3+: replace/confirm local test Sheet target before any run
 * TODO Step 3+: insert PG create/update/delete/backfill nodes
 * TODO Step 3+: add structured response node with partial_failure
 * TODO Step 3+: generate .n8n-import.json
 * TODO Step 3+: update docs and PowerShell test script
 */
const fs = require('fs');
const path = require('path');

const HOSTED = path.join(__dirname, '..', 'n8n', 'Wolfhouse - Manual Entries Queue Processor.json');
const OUT_DIR = path.join(__dirname, '..', 'n8n', 'phase3b');
const OUT = path.join(OUT_DIR, 'Wolfhouse - Manual Entries Queue Processor (local PG).json');
const LOCAL_WORKFLOW_ID = 'B3c4ManualEntriesLocal01';
const CLIENT_SLUG = 'wolfhouse';
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

const PRODUCTION_TARGET_WARNING =
  'WARNING: Generated local workflow still preserves hosted Airtable/Sheets nodes from the source export. Do not import or run until Step 3 verifies/neutralizes production targets.';

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

/** Deep-clone hosted workflow into local fork metadata (Step 2 — no PG nodes). */
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

  return workflow;
}

function writeLocalWorkflow(workflow) {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }
  fs.writeFileSync(OUT, `${JSON.stringify(workflow, null, 2)}\n`);
}

/** @param {object} workflow */
function printGenerateSummary(workflow) {
  const webhooks = findWebhookNodes(workflow);
  const path =
    webhooks.length === 1
      ? webhooks[0].parameters?.path || '(missing)'
      : webhooks.map((w) => `${w.name}=${w.parameters?.path || '?'}`).join(', ');

  console.log(`Wrote ${OUT}`);
  console.log(`Workflow name: ${workflow.name}`);
  console.log(`Workflow id: ${workflow.id}`);
  console.log(`Active: ${workflow.active}`);
  console.log(`Webhook path: ${path}`);
  console.log(
    `Webhook id: ${webhooks.length === 1 ? webhooks[0].webhookId : webhooks.map((w) => w.webhookId).join(', ')}`,
  );
  console.log(`Node count: ${listNodes(workflow).length}`);
  console.log(`Hosted source unchanged: ${HOSTED}`);
  console.log('');
  console.log(PRODUCTION_TARGET_WARNING);
}

function printUsage() {
  console.error(`Usage:
  node scripts/build-manual-entries-local.js --inventory
  node scripts/build-manual-entries-local.js --generate`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--inventory')) {
    const workflow = loadHostedWorkflow();
    printInventory(workflow);
    return;
  }

  if (args.includes('--generate')) {
    const hosted = loadHostedWorkflow();
    const local = buildLocalWorkflowFromHosted(hosted);
    writeLocalWorkflow(local);
    printGenerateSummary(local);
    return;
  }

  printUsage();
  process.exit(1);
}

main();
