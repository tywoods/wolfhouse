/**
 * Build n8n/phase3b/Wolfhouse - Operator Room Release (local PG).json
 *
 * Phase 3b.5c — Postgres-first local fork (direct webhook JSON; no Airtable primary path).
 * Does NOT modify n8n/Wolfhouse - Operator Room Release.json (hosted export).
 *
 * Step 1 (this script): inventory only
 *   node scripts/build-operator-room-release-local.js --inventory
 *
 * Future: --generate, --verify-targets (not implemented in Step 1)
 */
const fs = require('fs');
const path = require('path');

const HOSTED = path.join(__dirname, '..', 'n8n', 'Wolfhouse - Operator Room Release.json');
const OUT_DIR = path.join(__dirname, '..', 'n8n', 'phase3b');
const LOCAL_WORKFLOW_ID = 'B3b5OperatorRoomLocal01';
const LOCAL_WORKFLOW_NAME = 'Wolfhouse - Operator Room Release (local PG)';
const LOCAL_WEBHOOK_PATH = 'operator-room-release';
const LOCAL_WEBHOOK_ID = 'b3b5c001-0005-4000-8000-000000000005';
const CLIENT_SLUG = 'wolfhouse-somo';

/** Production Airtable base in hosted export — must not appear in local MVP primary path. */
const PROD_AIRTABLE_BASE_ID = 'appOCWIN47Bui9CSS';

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

/** Planned local graph (Step 2+ generate; not written in Step 1). */
const PLANNED_LOCAL_GRAPH = [
  'Webhook (operator-room-release)',
  '→ Code - Parse Release Payload',
  '→ IF dry_run? → Postgres impact / dry-run branch',
  '→ IF found_match? → Postgres execute (operator-room-release-pg-n8n-sql.js)',
  '→ Code - Build Response',
  '→ Respond to Webhook',
];

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
      cachedTableName:
        n.parameters?.table?.cachedResultName ||
        n.parameters?.table?.cachedResultUrl ||
        '',
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
  console.log(`CLIENT_SLUG (future PG): ${CLIENT_SLUG}`);
  console.log(`OUT_DIR (future output): ${OUT_DIR}`);
  console.log(`Node count: ${nodes.length}`);
  console.log('');

  console.log('--- Webhook nodes ---');
  if (!webhooks.length) {
    console.log('  (none)');
  } else {
    for (const w of webhooks) {
      const p = w.parameters || {};
      console.log(formatNodeLine(w));
      console.log(`    path: ${p.path || '(missing)'}`);
      console.log(`    webhookId: ${w.webhookId || '(missing)'}`);
      console.log(`    httpMethod: ${p.httpMethod || '(default)'}`);
      console.log(`    responseMode: ${p.responseMode || '(default — hosted has no Respond node)'}`);
    }
  }
  console.log('');

  console.log('--- Airtable nodes / base ids ---');
  console.log(`Base ids found: ${airtable.bases.length ? airtable.bases.join(', ') : '(none)'}`);
  console.log(`Table ids found: ${airtable.tables.length ? airtable.tables.join(', ') : '(none)'}`);
  const prodNodeCount = airtable.details.filter((d) => d.baseId === PROD_AIRTABLE_BASE_ID).length;
  console.log(
    `Production base ${PROD_AIRTABLE_BASE_ID}: ${prodNodeCount ? `${prodNodeCount} Airtable node(s)` : 'not referenced'}`,
  );
  for (const d of airtable.details) {
    console.log(
      `  - ${d.name} | op=${d.operation} | base=${d.baseId} | table=${d.tableId}${d.cachedTableName ? ` (${d.cachedTableName})` : ''}`,
    );
  }
  console.log('');

  console.log('--- Code nodes ---');
  for (const n of findCodeNodes(workflow)) {
    console.log(formatNodeLine(n));
  }
  console.log('');

  console.log('--- IF nodes ---');
  for (const n of findIfNodes(workflow)) {
    console.log(formatNodeLine(n));
  }
  console.log('');

  console.log('--- HTTP nodes ---');
  const httpNodes = findHttpNodes(workflow);
  if (!httpNodes.length) {
    console.log('  (none)');
  } else {
    for (const n of httpNodes) {
      console.log(formatNodeLine(n));
    }
  }
  console.log('');

  console.log('--- Postgres nodes (hosted) ---');
  const pgNodes = listNodes(workflow).filter((n) => n.type === 'n8n-nodes-base.postgres');
  if (!pgNodes.length) {
    console.log('  (none — PG-first local fork will add Postgres nodes)');
  } else {
    for (const n of pgNodes) {
      console.log(formatNodeLine(n));
    }
  }
  console.log('');

  console.log('--- Respond to Webhook nodes (hosted) ---');
  const respondNodes = listNodes(workflow).filter((n) => n.type === 'n8n-nodes-base.respondToWebhook');
  if (!respondNodes.length) {
    console.log('  (none — local fork must add Respond to Webhook)');
  } else {
    for (const n of respondNodes) {
      console.log(formatNodeLine(n));
    }
  }
  console.log('');

  console.log('--- Current hosted flow order (BFS from webhook) ---');
  for (const name of flowOrder) {
    console.log(`  ${name}`);
  }
  console.log('');

  console.log('--- Hosted gap notes ---');
  console.log('  - No IF found_match before cancel on no-match path (3b.5a hosted_parity_notes)');
  console.log('  - Webhook expects body.record_id → Get Release Request (deprecated for local MVP)');
  console.log('  - No synchronous webhook response node in export');
  console.log('');

  console.log('--- Nodes likely to DROP in local MVP (PG-first) ---');
  for (const name of HOSTED_NODES_DROP_MVP) {
    const exists = nodes.some((n) => n.name === name);
    console.log(`  - ${name}${exists ? '' : ' (not in export — verify)'}`);
  }
  console.log('  - Free Up Operator Room - Webhook → replace with new local webhook id/path');
  console.log('');

  console.log('--- Planned local target graph (Step 2+ --generate) ---');
  for (const line of PLANNED_LOCAL_GRAPH) {
    console.log(`  ${line}`);
  }
  console.log('');

  console.log('--- Input / architecture reminders ---');
  console.log('  - Primary wire contract: direct JSON (operator, room_code, release_start, release_end, request_code)');
  console.log('  - Optional n8n Form later (same fields); not in hosted export');
  console.log('  - Airtable record_id path is deprecated (COMPAT_AT_MIRROR optional later, test base only)');
  console.log('  - Do NOT shell out from n8n to npm/CLI; use Postgres nodes + operator-room-release-pg-n8n-sql.js');
  console.log('  - No payments/payment_events writes');
  console.log('  - Step 1: inventory only — no generated workflow JSON under n8n/phase3b/');
  console.log('');
  console.log(`Hosted source unchanged: ${HOSTED}`);
}

function printUsage() {
  console.error(`Usage:
  node scripts/build-operator-room-release-local.js --inventory

Step 1 supports --inventory only. Future: --generate, --verify-targets.`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--inventory')) {
    const workflow = loadHostedWorkflow();
    printInventory(workflow);
    return;
  }

  printUsage();
  process.exit(1);
}

main();
