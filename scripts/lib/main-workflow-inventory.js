/**
 * Phase 3c.a — read-only inventory for Main workflows (hosted + local Stripe fork).
 * Used by scripts/build-main-local-stripe.js --inventory
 */
const fs = require('fs');

const PROD_AIRTABLE_BASE_ID = 'appOCWIN47Bui9CSS';

const TABLE_LABELS = {
  tblYWm3zKFafe4qu7: 'Bookings',
  tblO1ByvTMXS4SalB: 'Booking Beds',
  tbllLFnkeriks575v: 'Conversations',
  tbl3oMbUtrUr0XWLt: 'Messages',
  tblEkF4SG4TLaNmW4: 'Beds',
  tblrNdFnxdQvEnPuj: 'Rooms',
};

const ROUTE_PURPOSE = {
  human_handoff: 'Staff handoff — bot paused, human replies',
  general_question: 'General FAQ / LLM reply',
  payment_details_provided: 'Guest contact on hold → Stripe path (Ensure Booking PG)',
  payment_or_confirm_intent: 'Payment or confirmation intent',
  booking_flow: 'New booking — availability, create hold, optional Stripe after hold',
  unknown: 'Unknown / fallback route',
  existing_booking: 'Existing booking lookup',
  existing_booking_modify: 'Modify existing booking',
  existing_booking_cancel: 'Cancel existing booking',
  existing_booking_status: 'Booking status inquiry',
  payment_completed_claim: 'Guest claims payment completed',
  rooming_details_provided: 'Rooming update → HTTP reassign-booking-beds',
};

const PAYMENT_SQL_PATTERNS = [
  /\bINSERT\s+INTO\s+payments\b/i,
  /\bUPDATE\s+payments\b/i,
  /\bDELETE\s+FROM\s+payments\b/i,
  /\bINSERT\s+INTO\s+payment_events\b/i,
  /\bUPDATE\s+payment_events\b/i,
  /\bDELETE\s+FROM\s+payment_events\b/i,
];

const PG_MUTATION_PATTERNS = [
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\s+\w+\s+SET\b/i,
  /\bDELETE\s+FROM\b/i,
];

function loadWorkflowJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return { error: `file not found: ${filePath}` };
  }
  try {
    return { workflow: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (err) {
    return { error: `invalid JSON: ${err.message}` };
  }
}

function listNodes(workflow) {
  return Array.isArray(workflow?.nodes) ? workflow.nodes : [];
}

function shortType(node) {
  return (node.type || '').replace('n8n-nodes-base.', '');
}

function extractAirtableBaseId(node) {
  const base = node.parameters?.base;
  if (!base) return null;
  if (typeof base === 'string') return base;
  if (base.value) return String(base.value);
  return null;
}

function extractAirtableTableId(node) {
  const table = node.parameters?.table;
  if (!table) return null;
  if (typeof table === 'string') return table;
  if (table.value) return String(table.value);
  return null;
}

function tableLabel(tableId) {
  if (!tableId) return '(unknown)';
  return TABLE_LABELS[tableId] || tableId;
}

function findNodesByType(workflow, typeSuffix) {
  return listNodes(workflow).filter((n) => (n.type || '').includes(typeSuffix));
}

function findSwitchRoutes(switchNode) {
  const rules = switchNode?.parameters?.rules?.values || [];
  return rules.map((rule, index) => {
    const conds = rule?.conditions?.conditions || [];
    const route =
      conds.find((c) => String(c.leftValue || '').includes('resolved_route'))?.rightValue ||
      conds[0]?.rightValue ||
      `(output-${index})`;
    return { index, route: String(route), purpose: ROUTE_PURPOSE[route] || ROUTE_PURPOSE.unknown };
  });
}

function collectDownstream(workflow, startName, outputIndex) {
  const connections = workflow.connections || {};
  const startConn = connections[startName];
  const seeds =
    outputIndex == null
      ? (connections['Webhook2']?.main?.[0] || []).map((e) => e.node)
      : (startConn?.main?.[outputIndex] || []).map((e) => e.node);

  const visited = new Set();
  const queue = [...seeds];

  while (queue.length) {
    const name = queue.shift();
    if (!name || visited.has(name)) continue;
    visited.add(name);
    const nodeConn = connections[name];
    if (!nodeConn?.main) continue;
    for (const branch of nodeConn.main) {
      if (!Array.isArray(branch)) continue;
      for (const edge of branch) {
        if (edge?.node) queue.push(edge.node);
      }
    }
  }
  return visited;
}

function buildRouteMap(workflow) {
  const switchNode = listNodes(workflow).find((n) => n.name === 'Switch');
  const routes = [];
  if (!switchNode) {
    return { routes, preSwitch: collectDownstream(workflow, 'Webhook2', null) };
  }
  for (const { index, route, purpose } of findSwitchRoutes(switchNode)) {
    const nodes = collectDownstream(workflow, 'Switch', index);
    const entryEdges = workflow.connections?.Switch?.main?.[index] || [];
    const entryNodes = entryEdges.map((e) => e.node).filter(Boolean);
    routes.push({ route, purpose, outputIndex: index, entryNodes, nodes });
  }
  const preSwitch = new Set();
  const order = computeFlowOrderFromWebhook(workflow);
  const switchIdx = order.indexOf('Switch');
  if (switchIdx > 0) {
    for (let i = 0; i < switchIdx; i += 1) preSwitch.add(order[i]);
  }
  return { routes, preSwitch };
}

function computeFlowOrderFromWebhook(workflow) {
  const connections = workflow.connections || {};
  const webhooks = listNodes(workflow).filter((n) => shortType(n) === 'webhook');
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
  return order;
}

function classifyPostgresQuery(sql) {
  const q = String(sql || '');
  const paymentHits = PAYMENT_SQL_PATTERNS.filter((re) => re.test(q));
  const hasMutation = PG_MUTATION_PATTERNS.some((re) => re.test(q));
  const kinds = [];
  if (/\bSELECT\b/i.test(q)) kinds.push('SELECT');
  if (/\bINSERT\b/i.test(q)) kinds.push('INSERT');
  if (/\bUPDATE\b/i.test(q)) kinds.push('UPDATE');
  if (/\bDELETE\b/i.test(q)) kinds.push('DELETE');
  return {
    kinds: kinds.length ? kinds : ['(none)'],
    hasMutation,
    paymentWrites: paymentHits.length > 0,
    paymentPatterns: paymentHits.map((re) => String(re)),
  };
}

function inferHttpTarget(node) {
  const url = String(node.parameters?.url || node.parameters?.request?.url || '');
  const method = node.parameters?.method || node.parameters?.request?.method || 'GET';
  let path = '';
  try {
    if (url.includes('webhook/')) {
      path = url.replace(/^.*\/webhook\//, '/webhook/').split(/[?'" ]/)[0];
    } else if (url.startsWith('/webhook/')) {
      path = url.split(/[?'" ]/)[0];
    }
  } catch {
    path = url.slice(0, 80);
  }
  const localHints = /localhost|127\.0\.0\.1|n8n-main|host\.docker\.internal/i.test(url);
  const known = {
    'create-payment-session': 'Phase 2b Create Payment Session',
    'reassign-booking-beds': '3b.3 Reassign (local PG fork)',
    'assign-beds-to-booking': '3b.2 Assign (local PG fork)',
    'cancel-booking-beds': '3b.1 Cancel (local PG fork)',
    'send-confirmation': 'Send Confirmation (hosted/local)',
  };
  let label = path || url.slice(0, 60);
  for (const [key, desc] of Object.entries(known)) {
    if (path.includes(key) || url.includes(key)) {
      label = `${key} — ${desc}`;
      break;
    }
  }
  return { name: node.name, method, url: url.slice(0, 120), path, localHint: localHints, label };
}

function nodeRouteTags(nodeName, routeMap) {
  const tags = [];
  if (routeMap.preSwitch?.has(nodeName)) tags.push('(pre-switch)');
  for (const r of routeMap.routes) {
    if (r.nodes.has(nodeName)) tags.push(r.route);
  }
  return tags.length ? tags.join(', ') : '(unreachable-from-switch?)';
}

function inventoryAirtable(workflow, routeMap) {
  const blob = JSON.stringify(workflow);
  const prodBaseHits = (blob.match(new RegExp(PROD_AIRTABLE_BASE_ID, 'g')) || []).length;
  const rows = [];
  for (const n of findNodesByType(workflow, 'airtable')) {
    const op = n.parameters?.operation || 'get';
    const baseId = extractAirtableBaseId(n);
    const tableId = extractAirtableTableId(n);
    rows.push({
      name: n.name,
      operation: op,
      baseId: baseId || '(unknown)',
      table: tableLabel(tableId),
      tableId: tableId || '(unknown)',
      prodBase: baseId === PROD_AIRTABLE_BASE_ID,
      routes: nodeRouteTags(n.name, routeMap),
    });
  }
  rows.sort((a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name));
  return { rows, prodBaseHits };
}

function inventoryPostgres(workflow, routeMap) {
  const rows = [];
  let paymentWriteCount = 0;
  for (const n of findNodesByType(workflow, 'postgres')) {
    const sql = n.parameters?.query || '';
    const cls = classifyPostgresQuery(sql);
    if (cls.paymentWrites) paymentWriteCount += 1;
    const purpose =
      n.name.includes('Ensure Booking') ? 'Lookup/insert booking for Stripe (booking_code)' : 'See node name / SQL';
    rows.push({
      name: n.name,
      purpose,
      kinds: cls.kinds.join('+'),
      hasMutation: cls.hasMutation,
      paymentWrites: cls.paymentWrites,
      routes: nodeRouteTags(n.name, routeMap),
      sqlPreview: sql.replace(/\s+/g, ' ').trim().slice(0, 100),
    });
  }
  return { rows, paymentWriteCount };
}

function inventoryHttp(workflow, routeMap) {
  return findNodesByType(workflow, 'httpRequest')
    .map((n) => ({ ...inferHttpTarget(n), routes: nodeRouteTags(n.name, routeMap) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function groupBookingCritical(workflow, routeMap) {
  const groups = {
    bookings: { writes: [], reads: [] },
    bookingBeds: { writes: [], reads: [] },
    conversations: { writes: [], reads: [] },
    messages: { writes: [], reads: [] },
    availabilityReads: { nodes: [] },
  };

  const availRe =
    /availability|Search Active Beds|Search Existing Bed Assignment|Search Rooms|Choose Beds|Check Bed Availability|Check Nearby/i;

  for (const n of findNodesByType(workflow, 'airtable')) {
    const tableId = extractAirtableTableId(n);
    const op = n.parameters?.operation || 'get';
    const entry = { name: n.name, op, routes: nodeRouteTags(n.name, routeMap) };
    const isWrite = ['create', 'update', 'upsert', 'delete'].includes(op);

    if (tableId === 'tblYWm3zKFafe4qu7') {
      (isWrite ? groups.bookings.writes : groups.bookings.reads).push(entry);
    } else if (tableId === 'tblO1ByvTMXS4SalB') {
      (isWrite ? groups.bookingBeds.writes : groups.bookingBeds.reads).push(entry);
    } else if (tableId === 'tbllLFnkeriks575v') {
      (isWrite ? groups.conversations.writes : groups.conversations.reads).push(entry);
    } else if (tableId === 'tbl3oMbUtrUr0XWLt') {
      (isWrite ? groups.messages.writes : groups.messages.reads).push(entry);
    }
  }

  for (const n of listNodes(workflow)) {
    if (availRe.test(n.name)) {
      groups.availabilityReads.nodes.push({
        name: n.name,
        type: shortType(n),
        routes: nodeRouteTags(n.name, routeMap),
      });
    }
  }

  return groups;
}

function pgReplacementTargets(workflow, routeMap, groups) {
  const targets = [];

  if (groups.availabilityReads.nodes.length) {
    targets.push({
      priority: 1,
      area: 'Availability reads',
      nodes: groups.availabilityReads.nodes.map((n) => n.name).slice(0, 8),
      note: 'Replace Airtable bed/assignment searches with PG overlap SQL (reuse 3b assign/impact lib)',
    });
  }

  const holdCreate = groups.bookings.writes.filter((n) => /Create Booking Hold/i.test(n.name));
  if (holdCreate.length) {
    targets.push({
      priority: 2,
      area: 'Create Booking Hold',
      nodes: holdCreate.map((n) => n.name),
      note: 'PG upsert bookings (hold status) before optional AT mirror',
    });
  }

  const bookingUpdates = groups.bookings.writes.filter(
    (n) => /Update Booking|Search Active Booking|Search Bookings/i.test(n.name) && !/Stripe Payment Link/i.test(n.name)
  );
  if (bookingUpdates.length) {
    targets.push({
      priority: 3,
      area: 'Booking updates / active hold',
      nodes: [...new Set(bookingUpdates.map((n) => n.name))].slice(0, 12),
      note: 'PG-first hold search and booking field updates; resolver may read PG hold id',
    });
  }

  const convWrites = groups.conversations.writes;
  if (convWrites.length) {
    targets.push({
      priority: 4,
      area: 'Conversation state',
      nodes: convWrites.map((n) => n.name).slice(0, 10),
      note: 'PG conversations (stage, current_hold_id) + optional AT mirror for staff UI',
    });
  }

  const msgWrites = groups.messages.writes;
  if (msgWrites.length) {
    targets.push({
      priority: 5,
      area: 'Messages',
      nodes: msgWrites.map((n) => n.name).slice(0, 8),
      note: 'PG messages for audit; lower priority than bookings/conversations',
    });
  }

  const pgRows = inventoryPostgres(workflow, routeMap).rows;
  if (pgRows.length) {
    targets.push({
      priority: 0,
      area: 'Expand existing Postgres',
      nodes: pgRows.map((r) => r.name),
      note: 'Ensure Booking only on Stripe branches today — extend to hold-create routes',
    });
  }

  targets.sort((a, b) => a.priority - b.priority);
  return targets;
}

function countNodeTypes(workflow) {
  const counts = {};
  for (const n of listNodes(workflow)) {
    const t = shortType(n) || 'other';
    counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

function printWorkflowSection(label, filePath, workflow) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(label);
  console.log(`File: ${filePath}`);
  console.log(`Name: ${workflow.name || '(unnamed)'}`);
  console.log(`Id: ${workflow.id || '(none)'}`);
  console.log(`Active (export): ${workflow.active === true}`);
  console.log(`Node count: ${listNodes(workflow).length}`);
  console.log('Node types:', JSON.stringify(countNodeTypes(workflow)));

  console.log('\n--- Triggers ---');
  for (const w of findNodesByType(workflow, 'webhook')) {
    const p = w.parameters || {};
    console.log(`  - ${w.name} | ${p.httpMethod || 'GET'} /webhook/${p.path || w.webhookId || '?'}`);
    console.log(`    webhookId: ${w.webhookId || '(missing)'}`);
  }
  for (const n of listNodes(workflow)) {
    const t = shortType(n);
    if (t === 'scheduleTrigger') {
      console.log(`  - ${n.name} | schedule`);
    }
    if (t === 'manualTrigger') {
      console.log(`  - ${n.name} | manual`);
    }
  }

  const routeMap = buildRouteMap(workflow);
  console.log('\n--- Route map (Switch → resolved_route) ---');
  if (!routeMap.routes.length) {
    console.log('  (Switch node not found)');
  } else {
    for (const r of routeMap.routes) {
      console.log(`\n  [${r.outputIndex}] ${r.route}`);
      console.log(`      Purpose: ${r.purpose}`);
      console.log(`      Entry: ${r.entryNodes.join(', ') || '(none)'}`);
      const atInBranch = [...r.nodes].filter((name) =>
        findNodesByType(workflow, 'airtable').some((n) => n.name === name)
      );
      console.log(`      Downstream nodes: ${r.nodes.size} (Airtable in branch: ${atInBranch.length})`);
    }
  }

  const at = inventoryAirtable(workflow, routeMap);
  console.log(`\n--- Airtable nodes (${at.rows.length}) ---`);
  console.log(`Prod base ${PROD_AIRTABLE_BASE_ID} string hits in JSON: ${at.prodBaseHits}`);
  for (const row of at.rows) {
    const prod = row.prodBase ? ' [PROD BASE]' : '';
    console.log(`  - ${row.name} | ${row.operation} | ${row.table}${prod}`);
    console.log(`      routes: ${row.routes}`);
  }

  const pg = inventoryPostgres(workflow, routeMap);
  console.log(`\n--- Postgres nodes (${pg.rows.length}) ---`);
  console.log(
    pg.paymentWriteCount === 0
      ? '  OK: no payments/payment_events write SQL in Main Postgres nodes'
      : `  FAIL: ${pg.paymentWriteCount} node(s) with payment write SQL`
  );
  for (const row of pg.rows) {
    console.log(`  - ${row.name} | ${row.kinds} | mutation=${row.hasMutation} | ${row.purpose}`);
    console.log(`      routes: ${row.routes}`);
  }

  console.log('\n--- HTTP dependencies ---');
  for (const h of inventoryHttp(workflow, routeMap)) {
    console.log(`  - ${h.name} | ${h.method} | ${h.label}`);
    console.log(`      url: ${h.url}`);
    console.log(`      local/docker hint: ${h.localHint} | routes: ${h.routes}`);
  }

  const groups = groupBookingCritical(workflow, routeMap);
  console.log('\n--- Booking-critical: Bookings writes ---');
  for (const x of groups.bookings.writes) console.log(`  - ${x.op} | ${x.name} | ${x.routes}`);
  console.log('--- Booking-critical: Bookings reads (sample) ---');
  for (const x of groups.bookings.reads.slice(0, 15)) console.log(`  - ${x.op} | ${x.name}`);
  if (groups.bookings.reads.length > 15) console.log(`  ... +${groups.bookings.reads.length - 15} more`);

  console.log('--- Booking-critical: Booking Beds ---');
  for (const x of [...groups.bookingBeds.writes, ...groups.bookingBeds.reads]) {
    console.log(`  - ${x.op} | ${x.name} | ${x.routes}`);
  }

  console.log('--- Booking-critical: Conversations writes ---');
  for (const x of groups.conversations.writes) console.log(`  - ${x.op} | ${x.name} | ${x.routes}`);

  console.log('--- Booking-critical: Messages writes ---');
  for (const x of groups.messages.writes) console.log(`  - ${x.op} | ${x.name} | ${x.routes}`);

  console.log('--- Availability-related nodes ---');
  for (const x of groups.availabilityReads.nodes) {
    console.log(`  - ${x.type} | ${x.name} | ${x.routes}`);
  }

  return { routeMap, groups, at, pg };
}

function printPgReplacementTargets(hostedResult, localResult) {
  console.log(`\n${'='.repeat(72)}`);
  console.log('FIRST PG REPLACEMENT TARGETS (inventory-only — local Stripe fork)');
  const targets = pgReplacementTargets(
    localResult.workflow,
    localResult.routeMap,
    localResult.groups
  );
  for (const t of targets) {
    console.log(`\n  P${t.priority} ${t.area}`);
    console.log(`      ${t.note}`);
    for (const n of t.nodes) console.log(`      - ${n}`);
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log('HOSTED vs LOCAL DELTA (node types)');
  const h = countNodeTypes(hostedResult.workflow);
  const l = countNodeTypes(localResult.workflow);
  const allTypes = new Set([...Object.keys(h), ...Object.keys(l)]);
  for (const t of [...allTypes].sort()) {
    const hv = h[t] || 0;
    const lv = l[t] || 0;
    if (hv !== lv) console.log(`  ${t}: hosted=${hv} local=${lv} (Δ ${lv - hv})`);
  }
}

/**
 * @param {{ hostedPath: string, localPath: string }} opts
 */
function runMainWorkflowInventory(opts) {
  const hostedPath = opts.hostedPath;
  const localPath = opts.localPath;

  console.log('=== Phase 3c.a — Main workflow inventory (read-only) ===');
  console.log(`Proposal: docs/PHASE-3c-PROPOSAL.md`);
  console.log('No files written. No DB or Airtable API calls.\n');

  const hostedLoad = loadWorkflowJson(hostedPath);
  if (hostedLoad.error) {
    console.error(`Hosted: ${hostedLoad.error}`);
    process.exit(1);
  }

  const localLoad = loadWorkflowJson(localPath);
  if (localLoad.error) {
    console.warn(`Local fork: ${localLoad.error}`);
    console.warn('Run npm run build:main:local-stripe to generate local JSON first.\n');
  }

  const hostedResult = {
    workflow: hostedLoad.workflow,
    ...printWorkflowSection('HOSTED MAIN', hostedPath, hostedLoad.workflow),
  };

  let localResult = null;
  if (localLoad.workflow) {
    localResult = {
      workflow: localLoad.workflow,
      ...printWorkflowSection('LOCAL MAIN (local Stripe fork)', localPath, localLoad.workflow),
    };
    printPgReplacementTargets(
      { workflow: hostedLoad.workflow },
      { workflow: localLoad.workflow, routeMap: localResult.routeMap, groups: localResult.groups }
    );
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log('END inventory');
  return { hosted: hostedResult, local: localResult };
}

module.exports = {
  PROD_AIRTABLE_BASE_ID,
  runMainWorkflowInventory,
  loadWorkflowJson,
  buildRouteMap,
  inventoryAirtable,
  inventoryPostgres,
  groupBookingCritical,
  pgReplacementTargets,
};
