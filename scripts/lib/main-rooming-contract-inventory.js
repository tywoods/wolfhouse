/**
 * Phase 3e.3 — read-only static rooming/reassign contract inventory.
 */
const fs = require('fs');
const path = require('path');
const { loadWorkflowJson, listNodes, TABLE_LABELS } = require('./main-workflow-inventory');
const {
  HOSTED_REASSIGN_URL,
  DEFAULT_REASSIGN_BOOKING_BEDS_URL,
  scanHostedReassignUrls,
  scanLocalReassignEndpoint,
  scanMainBookingBedsWrites,
  analyzeReassignContract,
} = require('./main-reassign-endpoint');

const PROD_AIRTABLE_BASE_ID = 'appOCWIN47Bui9CSS';
const TEST_AIRTABLE_BASE_ID = 'appiyO4FmkKsyHZdK';

const PAYMENT_SQL_PATTERNS = [
  /\bINSERT\s+INTO\s+payments\b/i,
  /\bUPDATE\s+payments\b/i,
  /\bDELETE\s+FROM\s+payments\b/i,
  /\bINSERT\s+INTO\s+payment_events\b/i,
  /\bUPDATE\s+payment_events\b/i,
  /\bDELETE\s+FROM\s+payment_events\b/i,
];

const BOOKING_BEDS_WRITE_PATTERNS = [
  /\bINSERT\s+INTO\s+booking_beds\b/i,
  /\bUPDATE\s+booking_beds\b/i,
  /\bDELETE\s+FROM\s+booking_beds\b/i,
];

const HOSTED_CLOUD = 'tywoods.app.n8n.cloud';

const WORKFLOW_IDS = {
  main: 'RBfGNtVgrAkvhBHJ',
  reassign: 'B3c3ReassignLocal01',
  assign: 'B3c2AssignLocalPg01',
  cancel: 'KchhRC9b3MIdkzPT',
};

const AIRTABLE_ROOM_FIELD_NAMES = [
  'Room ID',
  'Room Name',
  'Capacity',
  'Room Type',
  'Gender Strategy',
  'Fill Priority',
  'Private Priority',
  'Can be Matrimonial',
  'Often used By Operator',
  'Active',
  'Avoid Until Needed',
];

const PG_ROOMS_COLUMNS = [
  'room_code',
  'name',
  'house',
  'room_type',
  'capacity',
  'fill_priority',
  'private_priority',
  'gender_strategy',
  'can_be_matrimonial',
  'often_used_by_operator',
  'sort_order',
  'avoid_until_needed',
  'active',
  'notes',
];

const PG_BEDS_COLUMNS = [
  'bed_code',
  'bed_number',
  'bed_label',
  'room_id',
  'active',
  'sellable',
  'planning_row_label',
  'notes',
];

function defaultPaths(repoRoot) {
  return {
    main: path.join(repoRoot, 'n8n', 'phase2', 'Wolfhouse Booking Assistant - Main (local Stripe).json'),
    reassign: path.join(
      repoRoot,
      'n8n',
      'phase3b',
      'Wolfhouse - Reassign Bed Assignments (local PG).json'
    ),
    assign: path.join(repoRoot, 'n8n', 'phase3b', 'Wolfhouse - Bed Assignment (local PG).json'),
    cancel: path.join(repoRoot, 'n8n', 'phase3b', 'Wolfhouse - Cancel Bed Assignments (local PG).json'),
  };
}

function extractAirtableBaseIds(workflow) {
  const bases = new Map();
  for (const node of listNodes(workflow)) {
    if (node.type !== 'n8n-nodes-base.airtable') continue;
    const baseId = node.parameters?.base?.value || node.parameters?.base;
    const id = typeof baseId === 'string' ? baseId : baseId?.value;
    if (!id) continue;
    if (!bases.has(id)) bases.set(id, []);
    const tableId = node.parameters?.table?.value || node.parameters?.table;
    const tid = typeof tableId === 'string' ? tableId : tableId?.value;
    bases.get(id).push({
      node: node.name,
      table_id: tid || null,
      table_label: TABLE_LABELS[tid] || tid,
    });
  }
  return Object.fromEntries(bases);
}

function scanPaymentWrites(workflow) {
  const hits = [];
  for (const node of listNodes(workflow)) {
    const blob = JSON.stringify(node.parameters || {});
    for (const re of PAYMENT_SQL_PATTERNS) {
      if (re.test(blob)) {
        hits.push({ node: node.name, pattern: re.source });
        break;
      }
    }
  }
  return hits;
}

function scanBookingBedsWrites(workflow) {
  const hits = [];
  for (const node of listNodes(workflow)) {
    const blob = JSON.stringify(node.parameters || {});
    for (const re of BOOKING_BEDS_WRITE_PATTERNS) {
      if (re.test(blob)) {
        hits.push({ node: node.name, pattern: re.source, type: node.type });
        break;
      }
    }
  }
  return hits;
}

function scanHostedUrls(workflow) {
  const hits = [];
  for (const node of listNodes(workflow)) {
    const blob = JSON.stringify(node.parameters || {});
    if (blob.includes(HOSTED_CLOUD)) {
      hits.push(node.name);
    }
  }
  return [...new Set(hits)];
}

function findWebhookPath(workflow, expectedPath) {
  for (const node of listNodes(workflow)) {
    if (node.type === 'n8n-nodes-base.webhook' && node.parameters?.path === expectedPath) {
      return { found: true, node: node.name, path: expectedPath };
    }
  }
  return { found: false, path: expectedPath };
}

function findHttpAssignUrl(workflow) {
  for (const node of listNodes(workflow)) {
    if (node.type !== 'n8n-nodes-base.httpRequest') continue;
    const url = String(node.parameters?.url || '');
    if (url.includes('assign-beds-to-booking')) {
      return { node: node.name, url };
    }
  }
  return null;
}

function nodeBlobContains(workflow, nodeName, patterns) {
  const node = listNodes(workflow).find((n) => n.name === nodeName);
  if (!node) return { present: false, matches: [] };
  const blob = JSON.stringify(node.parameters || {});
  const matches = patterns.filter((p) => p.test(blob)).map((p) => p.source);
  return { present: true, matches };
}

function scanHardcodedRoomLiterals(workflow) {
  const hits = [];
  const roomLiteral = /(?:room_id|room_code|Room ID)[^'"]*['"]R(\d+)['"]/gi;
  const alwaysRoom = /['"]R\d+['"][^;]{0,80}(?:always|must|only)/i;
  for (const node of listNodes(workflow)) {
    const code = node.parameters?.jsCode || node.parameters?.query || '';
    const s = String(code);
    if (roomLiteral.test(s) || alwaysRoom.test(s)) {
      hits.push(node.name);
    }
  }
  return [...new Set(hits)];
}

function scanRoomsConfigDriven(workflow) {
  const searchRoomsNodes = listNodes(workflow).filter((n) => /Search Rooms/i.test(n.name));
  const fieldRefs = new Set();
  for (const node of searchRoomsNodes) {
    const fields = node.parameters?.options?.fields;
    if (Array.isArray(fields)) {
      for (const f of fields) fieldRefs.add(f);
    }
  }
  const jsNodes = listNodes(workflow).filter(
    (n) => n.type === 'n8n-nodes-base.code' && /Choose Beds|Check Bed Availability|fill_priority|gender_strategy/i.test(String(n.parameters?.jsCode || ''))
  );
  return {
    search_rooms_nodes: searchRoomsNodes.map((n) => n.name),
    airtable_room_fields_loaded: [...fieldRefs].sort(),
    scoring_code_nodes: jsNodes.map((n) => n.name),
    uses_fill_priority: jsNodes.some((n) => String(n.parameters?.jsCode).includes('fill_priority')),
    uses_gender_strategy: jsNodes.some((n) =>
      /gender_strategy|Gender Strategy/i.test(String(n.parameters?.jsCode))
    ),
    hardcoded_room_literal_nodes: scanHardcodedRoomLiterals(workflow),
  };
}

function analyzeMainContract(workflow) {
  const reassign = analyzeReassignContract(workflow);
  const paymentWrites = scanPaymentWrites(workflow);
  const callReassignNodes = reassign.local_scan.httpNodes;
  return {
    workflow_id: workflow.id,
    workflow_name: workflow.name,
    active: workflow.active,
    active_expected_inactive: workflow.active === false,
    hosted_reassign_nodes: reassign.hosted_nodes,
    local_reassign: reassign.local_scan,
    call_reassign_nodes: callReassignNodes,
    booking_beds_write_hits: reassign.booking_beds_write_hits,
    payment_write_hits: paymentWrites,
    rooming_route_nodes: listNodes(workflow)
      .filter((n) => /Call Reassign|Rooming|Prepare Rooming/i.test(n.name))
      .map((n) => n.name),
    rooms_config: scanRoomsConfigDriven(workflow),
    ok:
      reassign.local_ok &&
      reassign.hosted_nodes.length === 0 &&
      paymentWrites.length === 0 &&
      reassign.booking_beds_write_hits.length === 0 &&
      workflow.active === false &&
      callReassignNodes.length >= 2,
  };
}

function analyzeReassignWorkflowContract(workflow) {
  const webhook = findWebhookPath(workflow, 'reassign-booking-beds');
  const parse = nodeBlobContains(workflow, 'Code - Parse Reassign Webhook', [
    /missing_record_id_or_booking_code/,
    /parse_ok/,
  ]);
  const normalize = nodeBlobContains(workflow, 'Code - Normalize Reassignment Booking', [
    /can_reassign/,
    /check_in/,
    /guest_count/,
  ]);
  const pgDelete = listNodes(workflow).find((n) => n.name === 'Postgres - Delete All Booking Beds');
  const pgSql = String(pgDelete?.parameters?.query || '');
  const scopedDelete =
    /LIMIT 2/.test(pgSql) &&
    /resolved_count/.test(pgSql) &&
    /WHERE bb\.booking_id = r\.id/.test(pgSql.replace(/\s+/g, ' '));
  const assignCall = findHttpAssignUrl(workflow);
  const assignUrlOk =
    assignCall &&
    (assignCall.url.includes('n8n-main:5678') ||
      assignCall.url.includes('N8N_ASSIGN_WEBHOOK_URL'));
  const bases = extractAirtableBaseIds(workflow);
  const prodNodes = Object.values(bases)
    .flat()
    .filter((b) => Object.keys(bases).includes(PROD_AIRTABLE_BASE_ID));
  return {
    workflow_id: workflow.id,
    active: workflow.active,
    active_note:
      workflow.active === true
        ? 'JSON file active=true — deactivate in n8n before 3e.4 unless test window'
        : null,
    webhook,
    parse_webhook: parse,
    normalize_booking: normalize,
    if_can_reassign: !!listNodes(workflow).find((n) => n.name === 'IF - Can Reassign Booking'),
    pg_scoped_delete: {
      present: !!pgDelete,
      scoped_to_single_booking: scopedDelete,
      payment_status_guard_in_js: /payment_status_changed_during_pg_reassign_delete/.test(
        String(
          listNodes(workflow).find((n) => n.name === 'Code - Validate PG Reassign Delete')?.parameters
            ?.jsCode || ''
        )
      ),
    },
    assign_http_call: assignCall,
    assign_url_worker_reachable: !!assignUrlOk,
    hosted_url_nodes: scanHostedUrls(workflow),
    booking_beds_writes: scanBookingBedsWrites(workflow),
    airtable_bases: bases,
    uses_prod_base: Object.keys(bases).includes(PROD_AIRTABLE_BASE_ID),
    uses_test_base: Object.keys(bases).includes(TEST_AIRTABLE_BASE_ID),
    ok:
      webhook.found &&
      parse.present &&
      normalize.present &&
      scopedDelete &&
      assignUrlOk &&
      scanHostedUrls(workflow).length === 0,
  };
}

function analyzeAssignWorkflowContract(workflow) {
  const webhook = findWebhookPath(workflow, 'assign-beds-to-booking');
  const parse = nodeBlobContains(workflow, 'Code - Parse Assign Webhook', [/parse_ok/, /missing_record_id/]);
  const canAssignGate = listNodes(workflow).find((n) =>
    /Needs Bed Assignment|Can Assign|IF - Can Assign/i.test(n.name)
  );
  const gateBlob = canAssignGate ? JSON.stringify(canAssignGate.parameters || {}) : '';
  const terminalGuard =
    /Assignment Status/.test(gateBlob) &&
    /Needs Review/.test(gateBlob) &&
    /Cancelled/.test(gateBlob);
  const overlapGuard = listNodes(workflow).some((n) =>
    /overlaps\(|overlap/i.test(String(n.parameters?.jsCode || ''))
  );
  const pgInsert = scanBookingBedsWrites(workflow).filter((h) => h.type === 'n8n-nodes-base.postgres');
  const rooms = scanRoomsConfigDriven(workflow);
  const bases = extractAirtableBaseIds(workflow);
  return {
    workflow_id: workflow.id,
    active: workflow.active,
    active_note:
      workflow.active === true
        ? 'Assign fork may be active from 3b — do not POST outside test window'
        : null,
    webhook,
    parse_webhook: parse,
    get_booking_node: !!listNodes(workflow).find((n) => n.name === 'Get Booking'),
    can_assign_gate: {
      present: !!canAssignGate,
      name: canAssignGate?.name || null,
      terminal_status_guard_detectable: terminalGuard,
    },
    overlap_conflict_detectable: overlapGuard,
    booking_beds_pg_writes: pgInsert,
    rooms_config: rooms,
    search_active_beds: !!listNodes(workflow).find((n) => n.name === 'Search Active Beds'),
    search_existing_assignments: !!listNodes(workflow).find(
      (n) => n.name === 'Search Existing Bed Assignments'
    ),
    hosted_url_nodes: scanHostedUrls(workflow),
    airtable_bases: bases,
    uses_prod_base: Object.keys(bases).includes(PROD_AIRTABLE_BASE_ID),
    uses_test_base: Object.keys(bases).includes(TEST_AIRTABLE_BASE_ID),
    ok: webhook.found && parse.present && pgInsert.length >= 1 && rooms.search_rooms_nodes.length >= 1,
  };
}

function analyzeCancelWorkflowContract(workflow) {
  const webhook = findWebhookPath(workflow, 'cancel-booking-beds');
  const bases = extractAirtableBaseIds(workflow);
  return {
    workflow_id: workflow.id,
    active: workflow.active,
    webhook,
    airtable_bases: bases,
    uses_prod_base: Object.keys(bases).includes(PROD_AIRTABLE_BASE_ID),
    uses_test_base: Object.keys(bases).includes(TEST_AIRTABLE_BASE_ID),
  };
}

function analyzeAirtableAlignment(main, reassign, assign, cancel) {
  const workflows = [
    { name: 'Main', wf: main },
    { name: 'Reassign', wf: reassign },
    { name: 'Assign', wf: assign },
    { name: 'Cancel', wf: cancel },
  ];
  const summary = {};
  for (const { name, wf } of workflows) {
    summary[name] = extractAirtableBaseIds(wf);
  }
  const allBaseIds = new Set();
  for (const bases of Object.values(summary)) {
    for (const id of Object.keys(bases)) allBaseIds.add(id);
  }
  const mainUsesTest = Object.keys(summary.Main || {}).includes(TEST_AIRTABLE_BASE_ID);
  const bedOpsUseTest = ['Reassign', 'Assign', 'Cancel'].every((n) =>
    Object.keys(summary[n] || {}).includes(TEST_AIRTABLE_BASE_ID)
  );
  const bedOpsUseProd = ['Reassign', 'Assign', 'Cancel'].some((n) =>
    Object.keys(summary[n] || {}).includes(PROD_AIRTABLE_BASE_ID)
  );
  const localRoomingAirtableAligned = mainUsesTest && bedOpsUseTest && !bedOpsUseProd;
  let mismatchDetail = null;
  if (mainUsesTest && bedOpsUseProd) {
    mismatchDetail =
      'Main uses test Airtable appiyO4FmkKsyHZdK; Assign/Reassign/Cancel still reference prod appOCWIN47Bui9CSS — regenerate bed-ops local forks with base neutralization';
  } else if (mainUsesTest && !bedOpsUseTest) {
    mismatchDetail =
      'Main uses test Airtable appiyO4FmkKsyHZdK but one or more bed-ops forks do not — integrated rooming E2E will fail until all use appiyO4FmkKsyHZdK';
  }
  return {
    expected_local_test_base: TEST_AIRTABLE_BASE_ID,
    by_workflow: summary,
    all_base_ids: [...allBaseIds],
    main_on_test_base: mainUsesTest,
    bed_ops_on_test_base: bedOpsUseTest,
    bed_ops_on_prod_base: bedOpsUseProd,
    local_rooming_airtable_aligned: localRoomingAirtableAligned,
    aligned_for_integrated_rooming_e2e: localRoomingAirtableAligned,
    mismatch_detail: mismatchDetail,
  };
}

function loadPostgresRoomConfigInventory(repoRoot) {
  const migrationPath = path.join(repoRoot, 'database', 'migrations', '001_init.sql');
  const airtableDoc = path.join(repoRoot, 'docs', 'airtable-field-usage.md');
  return {
    postgres_rooms_columns: PG_ROOMS_COLUMNS,
    postgres_beds_columns: PG_BEDS_COLUMNS,
    postgres_manual_lock_column: null,
    postgres_last_resort_column: 'avoid_until_needed',
    airtable_documented_room_fields: AIRTABLE_ROOM_FIELD_NAMES,
    airtable_avoid_until_needed: 'Avoid Until Needed',
    config_principle:
      'Rooming rules should come from rooms/beds table fields (gender_strategy, fill_priority, private_priority, room_type, active, avoid_until_needed) — not hardcoded room IDs in workflow logic',
    schema_source: fs.existsSync(migrationPath) ? migrationPath : null,
    airtable_field_doc: fs.existsSync(airtableDoc) ? airtableDoc : null,
  };
}

function collectWarnings(report) {
  const w = [];
  const align = report.airtable_alignment;
  if (align.mismatch_detail) w.push(align.mismatch_detail);
  if (report.reassign?.active === true) w.push('Reassign workflow JSON has active=true (regenerate/build should set false for safe default)');
  if (report.assign?.active === true) w.push('Assign workflow JSON has active=true — POST would execute if webhook called');
  if (report.reassign?.pg_scoped_delete && !report.reassign.pg_scoped_delete.payment_status_guard_in_js) {
    w.push('Reassign PG delete payment_status guard not statically detected in validate node');
  }
  if (!report.assign?.overlap_conflict_detectable) {
    w.push('Assign overlap/double-booking guard not clearly detectable in static scan — verify manually before 3e.4');
  }
  if (report.main?.rooms_config?.hardcoded_room_literal_nodes?.length) {
    w.push(
      `Possible hardcoded room literals in: ${report.main.rooms_config.hardcoded_room_literal_nodes.join(', ')}`
    );
  }
  if (report.assign?.rooms_config?.hardcoded_room_literal_nodes?.length) {
    w.push(
      `Possible hardcoded room literals in Assign: ${report.assign.rooms_config.hardcoded_room_literal_nodes.join(', ')}`
    );
  }
  w.push('Terminal booking block on confirmed status not fully statically provable in Assign — verify at runtime');
  w.push('Ale/Cami rooming preferences provisional — update Rooms table/config, not workflow structure');
  return w;
}

function buildMainRoomingContractReport(paths) {
  const loads = {
    main: loadWorkflowJson(paths.main),
    reassign: loadWorkflowJson(paths.reassign),
    assign: loadWorkflowJson(paths.assign),
    cancel: loadWorkflowJson(paths.cancel),
  };
  for (const [key, load] of Object.entries(loads)) {
    if (load.error) return { error: `${key}: ${load.error}`, report: null };
  }

  const main = analyzeMainContract(loads.main.workflow);
  const reassign = analyzeReassignWorkflowContract(loads.reassign.workflow);
  const assign = analyzeAssignWorkflowContract(loads.assign.workflow);
  const cancel = analyzeCancelWorkflowContract(loads.cancel.workflow);
  const airtable_alignment = analyzeAirtableAlignment(
    loads.main.workflow,
    loads.reassign.workflow,
    loads.assign.workflow,
    loads.cancel.workflow
  );
  const rooms_config = loadPostgresRoomConfigInventory(path.dirname(path.dirname(paths.main)));

  const report = {
    phase: '3e.3',
    read_only: true,
    no_mutations: true,
    workflow_files: paths,
    expected_workflow_ids: WORKFLOW_IDS,
    main,
    reassign,
    assign,
    cancel,
    airtable_alignment,
    rooms_config,
    hosted_reassign_url_removed: main.hosted_reassign_nodes.length === 0,
    local_reassign_endpoint: DEFAULT_REASSIGN_BOOKING_BEDS_URL,
  };

  report.warnings = collectWarnings(report);
  report.errors = [];
  if (!main.ok) report.errors.push('Main rooming contract checks failed');
  if (!main.local_reassign.ok) report.errors.push('Main local reassign endpoint not OK');
  if (main.hosted_reassign_nodes.length) report.errors.push('Hosted reassign URL still in Main');
  if (main.booking_beds_write_hits.length) report.errors.push('Main writes booking_beds');
  if (main.payment_write_hits.length) report.errors.push('Main writes payments/payment_events');

  report.ok =
    report.errors.length === 0 &&
    main.ok &&
    reassign.webhook.found &&
    assign.webhook.found &&
    reassign.pg_scoped_delete.scoped_to_single_booking;

  report.blockers_before_3e4 = [];
  if (airtable_alignment.mismatch_detail) {
    report.blockers_before_3e4.push('airtable_base_mismatch_main_vs_bed_ops');
  }

  report.ready_for_3e4_planning = report.ok && report.blockers_before_3e4.length === 0;

  return { error: null, report };
}

function runMainRoomingContractInventory({ paths }) {
  const resolved = paths || defaultPaths(path.join(__dirname, '..', '..'));
  return buildMainRoomingContractReport(resolved);
}

function printConsoleSummary(report) {
  console.log('\n=== Phase 3e.3 — Main rooming/reassign contract checker (read-only) ===\n');
  console.log(`read_only: ${report.read_only} | no_mutations: ${report.no_mutations}`);
  console.log(`\nMain (${report.main.workflow_name}):`);
  console.log(`  active=${report.main.active} (expected inactive: ${report.main.active_expected_inactive})`);
  console.log(`  hosted_reassign_nodes=${report.main.hosted_reassign_nodes.length}`);
  console.log(`  local_reassign_ok=${report.main.local_reassign.ok}`);
  console.log(`  call_reassign_nodes=${report.main.call_reassign_nodes.length}`);
  console.log(`  main_booking_beds_writes=${report.main.booking_beds_write_hits.length}`);
  console.log(`  main_payment_writes=${report.main.payment_write_hits.length}`);
  console.log(`  main_ok=${report.main.ok}`);

  console.log(`\nReassign (${report.reassign.workflow_id}):`);
  console.log(`  webhook reassign-booking-beds=${report.reassign.webhook.found}`);
  console.log(`  parse_ok contract=${report.reassign.parse_webhook.present}`);
  console.log(`  pg_scoped_delete=${report.reassign.pg_scoped_delete.scoped_to_single_booking}`);
  console.log(`  assign_http=${report.reassign.assign_http_call?.url || '(missing)'}`);
  console.log(`  prod_base=${report.reassign.uses_prod_base} test_base=${report.reassign.uses_test_base}`);
  console.log(`  reassign_ok=${report.reassign.ok}`);

  console.log(`\nAssign (${report.assign.workflow_id}):`);
  console.log(`  webhook assign-beds-to-booking=${report.assign.webhook.found}`);
  console.log(`  pg_booking_beds_writes=${report.assign.booking_beds_pg_writes.length}`);
  console.log(`  search_rooms=${report.assign.rooms_config.search_rooms_nodes.join(', ') || '(none)'}`);
  console.log(`  config_driven fill_priority=${report.assign.rooms_config.uses_fill_priority}`);
  console.log(`  prod_base=${report.assign.uses_prod_base} test_base=${report.assign.uses_test_base}`);
  console.log(`  assign_ok=${report.assign.ok}`);

  console.log('\nAirtable alignment:');
  console.log(`  Main test base=${report.airtable_alignment.main_on_test_base}`);
  console.log(`  Bed ops test base=${report.airtable_alignment.bed_ops_on_test_base}`);
  console.log(`  Bed ops prod base=${report.airtable_alignment.bed_ops_on_prod_base}`);
  console.log(`  integrated_e2e_aligned=${report.airtable_alignment.aligned_for_integrated_rooming_e2e}`);
  if (report.airtable_alignment.mismatch_detail) {
    console.log(`  MISMATCH: ${report.airtable_alignment.mismatch_detail}`);
  }

  console.log('\nRooms config inventory (Postgres columns):');
  console.log(`  rooms: ${report.rooms_config.postgres_rooms_columns.join(', ')}`);
  console.log(`  last_resort_pg: ${report.rooms_config.postgres_last_resort_column}`);
  console.log(`  manual_lock_pg: ${report.rooms_config.postgres_manual_lock_column || '(none — use Assignment Status on booking)'}`);

  console.log('\nWarnings:');
  for (const w of report.warnings) console.log(`  - ${w}`);

  if (report.errors.length) {
    console.log('\nErrors:');
    for (const e of report.errors) console.log(`  - ${e}`);
  }

  console.log(`\nBlockers before 3e.4: ${report.blockers_before_3e4.length ? report.blockers_before_3e4.join(', ') : '(none critical if Airtable remap planned)'}`);
  console.log(`Overall OK: ${report.ok}`);
  console.log(`Ready for 3e.4 planning (static): ${report.ok && report.blockers_before_3e4.length === 0 ? 'yes with manual checks' : 'fix Airtable base alignment first'}`);
}

module.exports = {
  runMainRoomingContractInventory,
  buildMainRoomingContractReport,
  printConsoleSummary,
  defaultPaths,
  TEST_AIRTABLE_BASE_ID,
  PROD_AIRTABLE_BASE_ID,
};
