/**
 * Phase 3c.d.1 — read-only Conversations/Messages field inventory for Main workflows.
 */
const {
  PROD_AIRTABLE_BASE_ID,
  TABLE_LABELS,
  loadWorkflowJson,
  listNodes,
  findNodesByType,
  extractAirtableTableId,
  extractAirtableBaseId,
  buildRouteMap,
  nodeRouteTags,
} = require('./main-workflow-inventory');

const CONVERSATIONS_TABLE = 'tbllLFnkeriks575v';
const MESSAGES_TABLE = 'tbl3oMbUtrUr0XWLt';

const CONVERSATION_FIELD_META = {
  Phone: {
    affects: ['phone_identity'],
    pg_mapping: 'conversations.phone',
    mirror: false,
  },
  'Session State': {
    affects: ['session_state'],
    pg_mapping: 'conversations.session_state',
    mirror: false,
  },
  'Current Hold ID': {
    affects: ['current_hold_id'],
    pg_mapping:
      'conversations.current_hold_booking_id (UUID FK); AT mirror stores booking_code (WH-…)',
    mirror: 'temporary_airtable_only',
  },
  'Conversation Stage': {
    affects: ['conversation_stage'],
    pg_mapping: 'conversations.conversation_stage',
    mirror: false,
  },
  'Pending Action': {
    affects: ['pending_action'],
    pg_mapping: 'conversations.pending_action',
    mirror: false,
  },
  'Conversation Summary': {
    affects: ['summary_memory'],
    pg_mapping: 'conversations.conversation_summary',
    mirror: false,
  },
  'Last Bot Reply': {
    affects: ['summary_memory'],
    pg_mapping: 'conversations.last_bot_reply',
    mirror: false,
  },
  Language: {
    affects: ['phone_identity'],
    pg_mapping: 'conversations.language',
    mirror: false,
  },
  'Bot Mode': {
    affects: ['bot_human_handoff'],
    pg_mapping: 'conversations.bot_mode',
    mirror: false,
  },
  'Needs Human': {
    affects: ['bot_human_handoff'],
    pg_mapping: 'conversations.needs_human',
    mirror: false,
  },
  'Guest Name': {
    affects: ['phone_identity'],
    pg_mapping: 'conversations.display_name or guest link',
    mirror: 'optional',
  },
  Email: {
    affects: ['phone_identity'],
    pg_mapping: 'conversations.email',
    mirror: false,
  },
  'Last Message Preview': {
    affects: ['summary_memory'],
    pg_mapping: 'conversations.last_message_preview',
    mirror: false,
  },
  'Staff Reply Draft': {
    affects: ['bot_human_handoff'],
    pg_mapping: 'conversations.staff_reply_draft',
    mirror: false,
  },
  'Human Notes': {
    affects: ['bot_human_handoff'],
    pg_mapping: 'conversations.human_notes',
    mirror: 'temporary_airtable_only',
  },
  'Internal Staff Notes': {
    affects: ['bot_human_handoff'],
    pg_mapping: 'conversations.internal_staff_notes',
    mirror: 'temporary_airtable_only',
  },
  Messages: {
    affects: ['summary_memory'],
    pg_mapping: 'messages table (link); not embedded array in PG',
    mirror: 'temporary_airtable_only',
  },
  'Chat Transcript': {
    affects: ['summary_memory'],
    pg_mapping: 'unknown — manual_review or derive from messages',
    mirror: 'temporary_airtable_only',
  },
};

const MESSAGE_FIELD_META = {
  'Conversation Phone': {
    affects: ['phone_identity'],
    pg_mapping: 'via conversations.phone (denormalized optional)',
    mirror: false,
  },
  Direction: {
    affects: ['direction'],
    pg_mapping: 'messages.direction (inbound|outbound)',
    mirror: false,
  },
  'Message Text': {
    affects: ['audit_memory'],
    pg_mapping: 'messages.message_text',
    mirror: false,
  },
  'Message Type': {
    affects: ['audit_memory'],
    pg_mapping: 'messages.message_type',
    mirror: false,
  },
  Language: {
    affects: ['audit_memory'],
    pg_mapping: 'messages.language',
    mirror: false,
  },
  Route: {
    affects: ['audit_memory'],
    pg_mapping: 'messages.route',
    mirror: false,
  },
  'WhatsApp Message ID': {
    affects: ['whatsapp_id'],
    pg_mapping: 'messages.whatsapp_message_id',
    mirror: false,
  },
  Source: {
    affects: ['audit_memory'],
    pg_mapping: 'messages.source',
    mirror: false,
  },
  Conversation: {
    affects: ['phone_identity'],
    pg_mapping: 'messages.conversation_id (FK)',
    mirror: 'temporary_airtable_only',
  },
  'Created At': {
    affects: ['audit_memory'],
    pg_mapping: 'messages.created_at',
    mirror: false,
  },
  'Conversation Stage': {
    affects: ['conversation_stage'],
    pg_mapping: 'messages.conversation_stage snapshot',
    mirror: false,
  },
};

const RESOLVER_DEPENDENCY_NODES = [
  {
    name: 'Search Conversation',
    kind: 'airtable_read',
    uses: ['Phone lookup', 'Session State', 'Current Hold ID', 'Conversation Stage', 'Pending Action'],
  },
  {
    name: 'Code - Prepare Active Booking Search',
    kind: 'code',
    uses: ['Current Hold ID', 'session hold keys', 'phone'],
  },
  {
    name: 'Search Active Booking - Current Hold ID',
    kind: 'airtable_read',
    uses: ['Booking ID = Current Hold ID (booking_code)'],
  },
  {
    name: 'Search Active Booking - Phone',
    kind: 'airtable_read',
    uses: ['Phone', 'Status Hold/Payment_Pending/Confirmed/Needs_Review'],
  },
  {
    name: 'Code - Pick Active Booking',
    kind: 'code',
    uses: ['active_booking_id (booking_code)', 'active_booking_record_id (AT rec)', 'session merge'],
  },
  {
    name: 'Code - Booking State Resolver',
    kind: 'code',
    uses: [
      'Current Hold ID',
      'WH- hint',
      'Pick Active Booking',
      'Conversation Stage',
      'Pending Action',
      'hold_lookup.should_search_hold',
    ],
  },
  {
    name: 'Merge Session State',
    kind: 'code',
    uses: ['Session State', 'Current Hold ID'],
  },
  {
    name: 'Search Hold With Guest Details',
    kind: 'airtable_read',
    uses: ['Current Hold ID from conversation', 'phone', 'Hold status'],
  },
  {
    name: 'Code - Build Conversation Memory',
    kind: 'code',
    uses: ['Recent AT Messages → LLM memory'],
  },
  {
    name: 'Code - Check Existing Hold',
    kind: 'code',
    uses: ['phone', 'AT bookings hold overlap'],
  },
];

const CODE_SCAN_PATTERNS = [
  { id: 'current_hold_id', re: /Current Hold ID|current_hold_id/gi },
  { id: 'session_state', re: /Session State|session_state/gi },
  { id: 'conversation_stage', re: /Conversation Stage|conversation_stage/gi },
  { id: 'pending_action', re: /Pending Action|pending_action/gi },
  { id: 'active_booking', re: /active_booking|Pick Active Booking/gi },
  { id: 'booking_code_wh', re: /WH-|booking_code|hold_booking_id/gi },
  { id: 'airtable_record_id', re: /active_booking_record_id|\.id\s*&&\s*\.fields/gi },
  { id: 'resolver', re: /Booking State Resolver|resolveBookingRoute/gi },
  { id: 'needs_human', re: /needs_human|Human Handoff|bot_mode/gi },
  { id: 'conversation_memory', re: /conversation_memory|Build Conversation Memory/gi },
];

function truncateExpr(expr, max = 160) {
  const s = String(expr || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function extractAirtableFields(node) {
  const params = node.parameters || {};
  const columns = params.columns || {};
  const valueMap = columns.value && typeof columns.value === 'object' ? columns.value : {};
  const matchingColumns = Array.isArray(columns.matchingColumns) ? columns.matchingColumns : [];
  const schemaFields = Array.isArray(columns.schema)
    ? columns.schema.filter((f) => f && f.removed !== true).map((f) => f.id || f.displayName)
    : [];

  const written = [];
  for (const [fieldName, expression] of Object.entries(valueMap)) {
    if (expression == null || expression === '') continue;
    written.push({
      field: fieldName,
      expression: truncateExpr(expression),
      raw_length: String(expression).length,
    });
  }

  const paramBlob = JSON.stringify(params);
  const readHints = [];
  if (params.filterByFormula) {
    readHints.push({ kind: 'filterByFormula', expression: truncateExpr(params.filterByFormula, 200) });
  }
  if (params.id) {
    readHints.push({ kind: 'recordId', expression: truncateExpr(params.id) });
  }

  const allMentioned = new Set([...Object.keys(valueMap), ...matchingColumns, ...schemaFields]);
  for (const key of Object.keys(CONVERSATION_FIELD_META)) {
    if (paramBlob.includes(key)) allMentioned.add(key);
  }
  for (const key of Object.keys(MESSAGE_FIELD_META)) {
    if (paramBlob.includes(key)) allMentioned.add(key);
  }

  return {
    written,
    matching_columns: matchingColumns,
    schema_fields: schemaFields,
    read_hints: readHints,
    all_field_names: [...allMentioned].sort(),
  };
}

function classifyField(tableKind, fieldName) {
  const meta = tableKind === 'Conversations' ? CONVERSATION_FIELD_META[fieldName] : MESSAGE_FIELD_META[fieldName];
  if (meta) {
    return {
      field: fieldName,
      affects: meta.affects,
      pg_mapping: meta.pg_mapping,
      mirror: meta.mirror || false,
      review: false,
    };
  }
  return {
    field: fieldName,
    affects: [],
    pg_mapping: 'unknown — manual_review',
    mirror: 'unknown',
    review: true,
  };
}

function inferMessageTraits(node, fields) {
  const blob = JSON.stringify(node.parameters || {});
  const directionField = fields.written.find((f) => f.field === 'Direction');
  const dirExpr = directionField?.expression || '';
  let direction = 'unknown';
  if (/\bInbound\b/i.test(node.name)) direction = 'inbound';
  else if (/\bOutbound\b/i.test(node.name)) direction = 'outbound';
  else if (dirExpr === 'Inbound' || /^=.*Inbound/.test(dirExpr)) direction = 'inbound';
  else if (dirExpr === 'Outbound' || /^=.*Outbound/.test(dirExpr)) direction = 'outbound';
  else if (/"Direction":\s*"Inbound"/.test(blob)) direction = 'inbound';
  else if (/"Direction":\s*"Outbound"/.test(blob)) direction = 'outbound';

  const feeds_memory =
    /Build Conversation Memory|Search Messages - Recent/i.test(node.name) ||
    (node.parameters?.operation === 'search' && /Messages/i.test(node.name));

  const whatsapp_id = fields.all_field_names.includes('WhatsApp Message ID') || /whatsapp_message_id/i.test(blob);

  return {
    direction,
    feeds_memory,
    feeds_audit: ['create', 'update', 'upsert'].includes(node.parameters?.operation),
    whatsapp_message_id: whatsapp_id,
  };
}

function inventoryAirtableTable(workflow, routeMap, tableId, tableKind) {
  const rows = [];
  for (const n of findNodesByType(workflow, 'airtable')) {
    if (extractAirtableTableId(n) !== tableId) continue;
    const op = n.parameters?.operation || 'get';
    const fields = extractAirtableFields(n);
    const fieldDetails = fields.all_field_names.map((fn) => classifyField(tableKind, fn));

    const affects = new Set();
    for (const fd of fieldDetails) {
      for (const a of fd.affects) affects.add(a);
    }

    const entry = {
      node_name: n.name,
      operation: op,
      routes: nodeRouteTags(n.name, routeMap),
      prod_base: extractAirtableBaseId(n) === PROD_AIRTABLE_BASE_ID,
      fields_written: fields.written,
      fields_read_hints: fields.read_hints,
      matching_columns: fields.matching_columns,
      schema_fields: fields.schema_fields,
      affects: [...affects],
      pg_field_mappings: fieldDetails,
    };

    if (tableKind === 'Messages') {
      entry.message_traits = inferMessageTraits(n, fields);
    }

    rows.push(entry);
  }
  rows.sort((a, b) => a.node_name.localeCompare(b.node_name));
  return rows;
}

function scanCodeDependencies(workflow) {
  const codeNodes = listNodes(workflow).filter((n) => (n.type || '').includes('code'));
  const hits = [];

  for (const pattern of CODE_SCAN_PATTERNS) {
    const nodes = [];
    for (const n of codeNodes) {
      const js = n.parameters?.jsCode || '';
      if (pattern.re.test(js) || pattern.re.test(n.name)) {
        nodes.push(n.name);
      }
    }
    if (nodes.length) {
      hits.push({ pattern: pattern.id, nodes: [...new Set(nodes)].sort() });
    }
  }

  const resolverPresent = listNodes(workflow).some((n) => n.name === 'Code - Booking State Resolver');
  const known = RESOLVER_DEPENDENCY_NODES.map((d) => ({
    ...d,
    present: listNodes(workflow).some((n) => n.name === d.name),
  }));

  return { pattern_hits: hits, known_nodes: known, resolver_present: resolverPresent };
}

function buildPgMappingDraft(conversations, messages) {
  const byPg = {};
  const unmapped = [];

  for (const row of [...conversations, ...messages]) {
    for (const m of row.pg_field_mappings || []) {
      if (m.review) unmapped.push({ node: row.node_name, field: m.field });
      const key = m.pg_mapping;
      if (!byPg[key]) byPg[key] = [];
      byPg[key].push({ node: row.node_name, field: m.field, operation: row.operation });
    }
  }

  return { by_pg_target: byPg, manual_review: unmapped };
}

function risksFor3cE(conversations, messages, deps) {
  const risks = [];

  const holdWriters = conversations.filter((c) =>
    c.fields_written.some((f) => f.field === 'Current Hold ID')
  );
  if (holdWriters.length > 1) {
    risks.push({
      id: 'stale_current_hold_id',
      severity: 'high',
      detail: `${holdWriters.length} nodes write Current Hold ID; PG UUID vs AT booking_code drift if not updated together`,
      nodes: holdWriters.map((n) => n.node_name),
    });
  }

  const stageWriters = conversations.filter((c) =>
    c.fields_written.some((f) => f.field === 'Conversation Stage')
  );
  risks.push({
    id: 'conversation_booking_disagreement',
    severity: 'high',
    detail:
      'Conversation Stage and booking.status updated on different branches; promote/hold must stay in sync',
    nodes: stageWriters.slice(0, 8).map((n) => n.node_name),
  });

  const handoff = conversations.filter((c) => c.affects.includes('bot_human_handoff'));
  if (handoff.length) {
    risks.push({
      id: 'lost_handoff_flags',
      severity: 'medium',
      detail: 'needs_human / Bot Mode / Human Handoff must mirror to PG or staff loses visibility',
      nodes: handoff.map((n) => n.node_name),
    });
  }

  const memoryNodes = messages.filter((m) => m.message_traits?.feeds_memory);
  risks.push({
    id: 'message_memory_drift',
    severity: 'medium',
    detail: 'LLM memory reads AT Messages only; PG-only messages invisible until memory builder uses PG',
    nodes: memoryNodes.map((n) => n.node_name),
  });

  if (deps.known_nodes.some((n) => n.name === 'Code - Pick Active Booking' && n.present)) {
    risks.push({
      id: 'record_id_dependency',
      severity: 'high',
      detail: 'Pick Active Booking exposes active_booking_record_id (AT) and active_booking_id (booking_code); 3c.e needs PG UUID path',
      nodes: ['Code - Pick Active Booking', 'Search Active Booking - Phone', 'Search Active Booking - Current Hold ID'],
    });
  }

  risks.push({
    id: 'duplicate_active_booking_selection',
    severity: 'medium',
    detail: 'Hold-id search preferred over phone; overlapping holds on phone can confuse Pick Active Booking',
    nodes: ['Search Active Booking - Current Hold ID', 'Search Active Booking - Phone', 'Code - Check Existing Hold'],
  });

  return risks;
}

/**
 * @param {object} workflow
 * @param {{ label: string, filePath: string }} meta
 */
function buildConversationInventory(workflow, meta) {
  const routeMap = buildRouteMap(workflow);
  const conversations = inventoryAirtableTable(workflow, routeMap, CONVERSATIONS_TABLE, 'Conversations');
  const messages = inventoryAirtableTable(workflow, routeMap, MESSAGES_TABLE, 'Messages');
  const resolver_dependencies = scanCodeDependencies(workflow);
  const pg_mapping_draft = buildPgMappingDraft(conversations, messages);
  const risks_3c_e = risksFor3cE(conversations, messages, resolver_dependencies);

  const convWrites = conversations.filter((c) => ['create', 'update', 'upsert'].includes(c.operation));
  const msgWrites = messages.filter((m) => ['create', 'update', 'upsert'].includes(m.operation));

  return {
    workflow_label: meta.label,
    workflow_file: meta.filePath,
    workflow_name: workflow.name,
    node_count: listNodes(workflow).length,
    read_only: true,
    no_mutations: true,
    summary: {
      conversations_nodes: conversations.length,
      conversations_writes: convWrites.length,
      messages_nodes: messages.length,
      messages_writes: msgWrites.length,
      resolver_present: resolver_dependencies.resolver_present,
      prod_base_nodes: [...conversations, ...messages].filter((n) => n.prod_base).length,
    },
    conversations,
    messages,
    resolver_dependencies,
    pg_mapping_draft,
    risks_3c_e,
  };
}

function runConversationInventory(opts) {
  const hostedPath = opts.hostedPath;
  const localPath = opts.localPath;
  const which = opts.which || 'local';

  const reports = [];
  const errors = [];

  if (which === 'hosted' || which === 'both') {
    const load = loadWorkflowJson(hostedPath);
    if (load.error) errors.push({ file: hostedPath, error: load.error });
    else {
      reports.push(
        buildConversationInventory(load.workflow, { label: 'HOSTED MAIN', filePath: hostedPath })
      );
    }
  }

  if (which === 'local' || which === 'both') {
    const load = loadWorkflowJson(localPath);
    if (load.error) errors.push({ file: localPath, error: load.error });
    else {
      reports.push(
        buildConversationInventory(load.workflow, {
          label: 'LOCAL MAIN (local Stripe fork)',
          filePath: localPath,
        })
      );
    }
  }

  return { reports, errors, generated_at: new Date().toISOString() };
}

function printConsoleSummary(bundle) {
  console.log('\n=== Phase 3c.d.1 — Main conversation/message inventory (read-only) ===\n');
  console.log(`read_only: true | no_mutations: true | no DB/Airtable API calls\n`);

  if (bundle.errors.length) {
    for (const e of bundle.errors) console.log(`ERROR: ${e.file}: ${e.error}`);
  }

  for (const r of bundle.reports) {
    console.log(`${'─'.repeat(72)}`);
    console.log(`${r.workflow_label}`);
    console.log(`  File: ${r.workflow_file}`);
    console.log(
      `  Conversations AT nodes: ${r.summary.conversations_nodes} (${r.summary.conversations_writes} writes)`
    );
    console.log(`  Messages AT nodes: ${r.summary.messages_nodes} (${r.summary.messages_writes} writes)`);
    console.log(`  Resolver present: ${r.summary.resolver_present}`);
    console.log(`  Prod base hits: ${r.summary.prod_base_nodes} nodes`);

    console.log('\n  Conversations writes (field highlights):');
    for (const c of r.conversations.filter((x) => ['create', 'update', 'upsert'].includes(x.operation))) {
      const keys = c.fields_written.map((f) => f.field).join(', ') || '(schema only)';
      const hold = c.affects.includes('current_hold_id') ? ' [HOLD]' : '';
      const stage = c.affects.includes('conversation_stage') ? ' [STAGE]' : '';
      console.log(`    - ${c.operation} | ${c.node_name}${hold}${stage}`);
      console.log(`        routes: ${c.routes}`);
      console.log(`        fields: ${keys}`);
    }

    console.log('\n  Messages (sample):');
    for (const m of r.messages.slice(0, 12)) {
      const t = m.message_traits || {};
      console.log(
        `    - ${m.operation} | ${m.node_name} | dir=${t.direction} memory=${t.feeds_memory} wa_id=${t.whatsapp_message_id}`
      );
    }
    if (r.messages.length > 12) console.log(`    ... +${r.messages.length - 12} more`);

    console.log('\n  Resolver dependency nodes:');
    for (const d of r.resolver_dependencies.known_nodes) {
      console.log(`    - ${d.name} (${d.kind}) present=${d.present}`);
    }

    console.log('\n  Risks for 3c.e:');
    for (const risk of r.risks_3c_e) {
      console.log(`    [${risk.severity}] ${risk.id}: ${risk.detail}`);
    }
  }

  console.log(`\n${'─'.repeat(72)}`);
  console.log('END inventory\n');
}

module.exports = {
  CONVERSATIONS_TABLE,
  MESSAGES_TABLE,
  buildConversationInventory,
  runConversationInventory,
  printConsoleSummary,
};
