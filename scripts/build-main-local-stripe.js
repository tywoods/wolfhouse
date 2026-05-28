/**
 * Build n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json
 * Fork of hosted Main with Stripe checkout on payment_details_provided path.
 *
 * Ensure Booking In Postgres: n8n drops empty query params and shifts $n bindings.
 * Use sentinel __NULL__ in queryReplacement + NULLIF($n, '__NULL__') in SQL.
 * Ensure Booking: shared promote SQL (3c.e.2); $12 = airtable_record_id when hold rec id known.
 *
 * Phase 2f: Booking State Resolver + hold search guards (see docs/PHASE-2f.md).
 * Phase 2f.2: Reusable Stripe branch after booking_flow hold + payment-link guard.
 * Phase 3c.e.1: target map + prod neutralization + --verify-targets (no PG injection yet).
 *
 * Run: npm run build:main:local-stripe
 * Inventory (Phase 3c.a): node scripts/build-main-local-stripe.js --inventory
 * Verify (3c.e.1): node scripts/build-main-local-stripe.js --verify-targets
 */
const fs = require('fs');
const path = require('path');
const { runMainWorkflowInventory } = require('./lib/main-workflow-inventory');
const { buildN8nResolverJsCode } = require('./lib/booking-state-resolver');
const {
  applyMergedPaymentPathFixes,
  applyDeterministicPaymentUrl,
} = require('./lib/merged-payment-path');
const { stripePaymentLinkUpdateSchema } = require('./lib/airtable-bookings-schema');
const { buildEnsurePromoteN8nSql } = require('./lib/main-ensure-booking-pg-sql');
const { buildMainAvailabilityGateN8nSql } = require('./lib/main-availability-pg-sql');
const {
  buildHoldUpsertN8nSql,
  buildHoldBackfillAirtableN8nSql,
} = require('./lib/main-booking-hold-pg-sql');
const { buildConversationHoldUpsertN8nSql } = require('./lib/main-conversation-pg-sql');

/** n8n IF expression — run Stripe after hold when contact + hold exist (not only session merge). */
const STRIPE_AFTER_HOLD_IF_EXPR = `={{ 
  (() => {
    const summarize = $('Code - Summarize Holds').first().json || {};
    const resolver = $('Code - Booking State Resolver').first().json || {};
    const sig = resolver.message_signals || {};
    return (
      summarize.should_run_stripe_payment === true ||
      resolver.staged_contact?.apply_after_hold === true ||
      (
        summarize.holds_created === true &&
        (summarize.has_guest_details === true || sig.has_guest_email === true)
      )
    );
  })()
}}`;

const STRIPE_HOLD_RECORD_ID_EXPR =
  "={{ $('Code - Prepare Stripe Payment Context').first().json.hold_record_id || $('Update Booking Hold - Apply Staged Contact').first().json.id || $('Create Booking Hold').first().json.id }}";

const PROD_AIRTABLE_BASE_ID = 'appOCWIN47Bui9CSS';
const TEST_AIRTABLE_BASE_ID = 'appiyO4FmkKsyHZdK';
const LOCAL_WORKFLOW_NAME = 'Wolfhouse Booking Assistant - Main (local Stripe)';
const LOCAL_WORKFLOW_ID = 'RBfGNtVgrAkvhBHJ';
const LOCAL_POSTGRES_CREDENTIAL_ID = 'MnnrrLecI7oVoIGq';
const LOCAL_POSTGRES_CREDENTIAL_NAME = 'Wolfhouse Postgres (local)';
const EXPECTED_WEBHOOK_PATH = 'booking-assistant';
const HOSTED_N8N_CLOUD = 'tywoods.app.n8n.cloud';
const HOSTED_REASSIGN_PATH = '/webhook/reassign-booking-beds';
const DEFAULT_CREATE_PAYMENT_SESSION_URL = 'http://localhost:5678/webhook/create-payment-session';

const PAYMENT_SQL_PATTERNS = [
  /\bINSERT\s+INTO\s+payments\b/i,
  /\bUPDATE\s+payments\b/i,
  /\bDELETE\s+FROM\s+payments\b/i,
  /\bINSERT\s+INTO\s+payment_events\b/i,
  /\bUPDATE\s+payment_events\b/i,
  /\bDELETE\s+FROM\s+payment_events\b/i,
];

/**
 * Phase 3c.e PG injection targets (documentation only until 3c.e.2+).
 * @type {Record<string, object>}
 */
const PHASE_3CE_PG_TARGETS = {
  availability_gate: {
    substep: '3c.e.3',
    route: 'booking_flow',
    insertAfter: 'Code - Check Bed Availability - WA',
    insertBefore: 'IF - Availability Found',
    nodes: ['Postgres - Main Availability', 'Code - Map PG Availability'],
    authority: 'PG availability_found blocks hold path; AT bed search kept for reply context',
    lib: 'scripts/lib/main-availability-pg-sql.js',
    cli: 'db:report:main-availability',
  },
  hold_create: {
    substep: '3c.e.4',
    route: 'booking_flow',
    insertAfter: 'Code - Prepare Hold Records',
    insertBefore: 'Create Booking Hold',
    nodes: [
      'Postgres - Create Booking Hold',
      'Code - Validate PG Hold',
      'IF - PG Hold OK',
      'Postgres - Backfill Booking AT Record Id',
    ],
    mirrorNode: 'Create Booking Hold',
    pgBlocksAirtable: true,
    lib: 'scripts/lib/main-booking-hold-pg-sql.js',
    cli: 'db:main-hold:postgres',
    requiredFields: [
      'booking_code',
      'check_in',
      'check_out',
      'guest_count',
      'phone',
      'requested_room_type',
      'room_preference',
      'guest_gender_group_type',
      'primary_room_code',
    ],
  },
  conversation_upsert: {
    substep: '3c.e.5',
    route: 'booking_flow',
    insertAfter: 'Postgres - Create Booking Hold',
    insertBefore: 'Create Booking Hold',
    nodes: ['Postgres - Upsert Conversation Hold', 'IF - PG Conversation OK'],
    pgColumn: 'conversations.current_hold_booking_id',
    pgValue: 'bookings.id (UUID)',
    airtableMirrorField: 'Current Hold ID',
    airtableMirrorValue: 'booking_code (WH-…)',
    lib: 'scripts/lib/main-conversation-pg-sql.js',
    cli: 'db:main-conversation-upsert:postgres',
  },
  ensure_booking_promote: {
    substep: '3c.e.2',
    route: 'payment_details_provided / Stripe after hold',
    replaceNode: 'Postgres - Ensure Booking In Postgres',
    upstream: ['Code - Prepare Stripe Payment Context', 'Search Hold With Guest Details'],
    downstream: ['IF - Booking ID Ready', 'Code - Call Create Payment Session'],
    contract: '{ booking_id: UUID } to create-payment-session',
    lib: 'scripts/lib/main-ensure-booking-pg-sql.js',
    cli: 'db:main-ensure-booking:postgres',
  },
  airtable_backfill: {
    substep: '3c.e.4',
    route: 'booking_flow',
    insertAfter: 'Create Booking Hold',
    insertBefore: 'Code - Summarize Holds',
    futureNodes: ['Postgres - Backfill Booking AT Record Id'],
    sqlIntent: 'UPDATE bookings SET airtable_record_id FROM AT create id',
    lib: 'scripts/lib/main-booking-hold-pg-sql.js',
  },
};

function resolveLocalPostgresCredential(workflow) {
  const postgresNodes = (workflow.nodes || []).filter((n) => n.type === 'n8n-nodes-base.postgres');
  const inherited = postgresNodes
    .map((n) => n.credentials?.postgres)
    .find((c) => c && String(c.id || '').trim() !== '' && String(c.name || '').trim() !== '');
  if (inherited) return { id: String(inherited.id), name: String(inherited.name) };
  return { id: LOCAL_POSTGRES_CREDENTIAL_ID, name: LOCAL_POSTGRES_CREDENTIAL_NAME };
}

function applyPostgresCredentialMapping(workflow) {
  const pgCred = resolveLocalPostgresCredential(workflow);
  for (const node of workflow.nodes || []) {
    if (node.type !== 'n8n-nodes-base.postgres') continue;
    node.credentials = node.credentials || {};
    node.credentials.postgres = { id: pgCred.id, name: pgCred.name };
  }
}

function printPhase3ceTargetMap() {
  console.log('=== Phase 3c.e PG injection target map (not wired yet) ===\n');
  for (const [key, target] of Object.entries(PHASE_3CE_PG_TARGETS)) {
    console.log(`--- ${key} (${target.substep}) ---`);
    console.log(JSON.stringify(target, null, 2));
    console.log('');
  }
}

/**
 * Replace prod Airtable base in entire workflow tree (URLs, node params, cachedResultUrl).
 * Hosted export `n8n/Wolfhouse Booking Assistant  - Main.json` is never written.
 * @param {object} workflow
 * @returns {{ workflow: object, baseReplacements: number }}
 */
function neutralizeProductionTargets(workflow) {
  let json = JSON.stringify(workflow);
  const baseReplacements = json.split(PROD_AIRTABLE_BASE_ID).length - 1;
  json = json.split(PROD_AIRTABLE_BASE_ID).join(TEST_AIRTABLE_BASE_ID);
  return { workflow: JSON.parse(json), baseReplacements };
}

function listNodes(workflow) {
  return Array.isArray(workflow?.nodes) ? workflow.nodes : [];
}

function findWebhookNodes(workflow) {
  return listNodes(workflow).filter((n) => n.type === 'n8n-nodes-base.webhook');
}

function extractAirtableBaseId(node) {
  const base = node.parameters?.base;
  if (!base) return null;
  if (typeof base === 'string') return base;
  if (base.value) return String(base.value);
  return null;
}

function scanPaymentSqlHits(workflow) {
  const hits = [];
  for (const node of listNodes(workflow)) {
    const blob = JSON.stringify(node);
    for (const pattern of PAYMENT_SQL_PATTERNS) {
      if (pattern.test(blob)) {
        hits.push({ node: node.name, pattern: pattern.source });
        break;
      }
    }
  }
  return hits;
}

function scanHostedReassignUrls(workflow) {
  const hits = [];
  const needle = `${HOSTED_N8N_CLOUD}${HOSTED_REASSIGN_PATH}`;
  for (const node of listNodes(workflow)) {
    const blob = JSON.stringify(node.parameters || {});
    if (blob.includes(needle) || blob.includes(`https://${HOSTED_N8N_CLOUD}`)) {
      if (blob.includes('reassign-booking-beds')) {
        hits.push(node.name);
      }
    }
  }
  return [...new Set(hits)];
}

function scanCreatePaymentSessionBehavior(workflow) {
  const node = listNodes(workflow).find((n) => n.name === 'Code - Call Create Payment Session');
  if (!node?.parameters?.jsCode) {
    return { found: false, urlExpr: null, usesEnv: false };
  }
  const code = node.parameters.jsCode;
  const usesEnv = code.includes('N8N_CREATE_PAYMENT_SESSION_URL');
  const hasLocalDefault = code.includes(DEFAULT_CREATE_PAYMENT_SESSION_URL);
  return {
    found: true,
    usesEnv,
    hasLocalDefault,
    reportedUrl:
      '$env.N8N_CREATE_PAYMENT_SESSION_URL || ' + `'${DEFAULT_CREATE_PAYMENT_SESSION_URL}'`,
  };
}

/**
 * @param {object} workflow
 * @returns {object} verify result
 */
function verifyProductionTargets(workflow) {
  const errors = [];
  const warnings = [];

  if (workflow.active !== false) {
    errors.push(`workflow.active must be false (got ${JSON.stringify(workflow.active)})`);
  }

  const prodBaseNodes = [];
  const nonTestAirtableNodes = [];
  for (const node of listNodes(workflow)) {
    const blob = JSON.stringify(node);
    if (blob.includes(PROD_AIRTABLE_BASE_ID)) {
      prodBaseNodes.push(node.name);
    }
    if (node.type === 'n8n-nodes-base.airtable') {
      const baseId = extractAirtableBaseId(node);
      if (baseId && baseId !== TEST_AIRTABLE_BASE_ID) {
        nonTestAirtableNodes.push(`${node.name} (base=${baseId})`);
      }
    }
  }
  if (prodBaseNodes.length) {
    errors.push(
      `prod Airtable base ${PROD_AIRTABLE_BASE_ID} in ${prodBaseNodes.length} node(s): ${prodBaseNodes.slice(0, 8).join(', ')}${prodBaseNodes.length > 8 ? '…' : ''}`
    );
  }
  if (nonTestAirtableNodes.length) {
    errors.push(`Airtable nodes not on test base: ${nonTestAirtableNodes.join(', ')}`);
  }

  const paymentSqlHits = scanPaymentSqlHits(workflow);
  if (paymentSqlHits.length) {
    errors.push(
      `payments/payment_events SQL in nodes: ${paymentSqlHits.map((h) => h.node).join(', ')}`
    );
  }

  const reassignNodes = scanHostedReassignUrls(workflow);
  if (reassignNodes.length) {
    warnings.push(
      `hosted reassign URL (${HOSTED_N8N_CLOUD}${HOSTED_REASSIGN_PATH}) in: ${reassignNodes.join(', ')} — remap to local fork before rooming E2E`
    );
  }

  const paymentSession = scanCreatePaymentSessionBehavior(workflow);
  if (!paymentSession.found) {
    warnings.push('Code - Call Create Payment Session node not found');
  }

  if (workflow.id !== LOCAL_WORKFLOW_ID) {
    errors.push(`workflow.id expected ${LOCAL_WORKFLOW_ID}, got ${workflow.id}`);
  }
  if (workflow.name !== LOCAL_WORKFLOW_NAME) {
    errors.push(`workflow.name expected "${LOCAL_WORKFLOW_NAME}", got "${workflow.name}"`);
  }

  const webhooks = findWebhookNodes(workflow);
  const primaryWebhook = webhooks.find((w) => w.parameters?.path === EXPECTED_WEBHOOK_PATH);
  if (!primaryWebhook) {
    errors.push(`missing webhook path ${EXPECTED_WEBHOOK_PATH}`);
  }

  const postgresNodes = listNodes(workflow).filter((n) => n.type === 'n8n-nodes-base.postgres');

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    prodBaseNodeCount: prodBaseNodes.length,
    prodBaseNodes,
    paymentSqlHits,
    reassignNodes,
    paymentSession,
    postgresNodeCount: postgresNodes.length,
    postgresNodeNames: postgresNodes.map((n) => n.name),
    webhookPath: primaryWebhook?.parameters?.path || null,
    webhookCount: webhooks.length,
  };
}

function printVerifyTargetsReport(result, filePath) {
  console.log(`File: ${filePath}`);
  console.log(`workflow.active: ${result.workflowActive}`);
  console.log(`workflow.id: ${result.workflowId}`);
  console.log(`workflow.name: ${result.workflowName}`);
  console.log(`webhook path: ${result.webhookPath || '(missing)'}`);
  console.log(`Postgres nodes (${result.postgresNodeCount}): ${result.postgresNodeNames.join(', ') || '(none)'}`);
  console.log(`Prod Airtable base hits (nodes): ${result.prodBaseNodeCount}`);
  console.log(`Payment SQL hits: ${result.paymentSqlHits.length}`);
  if (result.paymentSession?.found) {
    console.log(`Create Payment Session URL: ${result.paymentSession.reportedUrl}`);
  }
  console.log('');
  if (result.errors.length) {
    console.error('FAIL:');
    for (const e of result.errors) console.error(`  - ${e}`);
  } else {
    console.log('OK: hard safety checks passed.');
  }
  if (result.warnings.length) {
    console.log('WARNINGS:');
    for (const w of result.warnings) console.warn(`  - ${w}`);
  }
}

function loadGeneratedWorkflowForVerify() {
  if (!fs.existsSync(OUT)) {
    console.error(`Generated workflow not found: ${OUT}`);
    console.error('Run: node scripts/build-main-local-stripe.js (generate) first.');
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch (err) {
    console.error(`Invalid JSON in generated workflow: ${err.message}`);
    process.exit(1);
  }
}

function runVerifyTargets(workflow, opts = {}) {
  const { exitOnFail = true, filePath = OUT } = opts;
  const wf = workflow || loadGeneratedWorkflowForVerify();
  const raw = verifyProductionTargets(wf);
  const result = {
    ...raw,
    workflowActive: wf.active,
    workflowId: wf.id,
    workflowName: wf.name,
  };
  printVerifyTargetsReport(result, filePath);
  if (exitOnFail && !result.ok) {
    process.exit(1);
  }
  return result;
}

const MAP_PG_AVAILABILITY_JS = `const atAvail = $('Code - Check Bed Availability - WA').first().json || {};
const pgRow = $('Postgres - Main Availability').first().json || {};
const session =
  atAvail.session ||
  $('Merge Session State').first().json?.session ||
  {};

function parseActionable(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch (_) {}
  }
  return [];
}

const hasPgRow = pgRow && pgRow.pg_query_ok !== undefined;
const pgQueryOk = hasPgRow && pgRow.pg_query_ok !== false;
const pgFound = pgQueryOk && pgRow.availability_found === true;
const actionable = parseActionable(pgRow.actionable);
const pgErrors = [];

if (!hasPgRow) pgErrors.push('pg_availability_missing_row');
else if (!pgQueryOk) pgErrors.push('pg_availability_query_failed');
if (actionable.includes('missing_or_invalid_dates')) pgErrors.push('missing_or_invalid_dates');

const availability_found = pgQueryOk ? pgFound : false;
const primaryRoomCode = pgRow.primary_room_code || null;
const primaryRoomName = pgRow.primary_room_name || primaryRoomCode;

return [
  {
    json: {
      ...atAvail,
      session,
      availability_found,
      pg_availability_found: pgFound,
      pg_query_ok: pgQueryOk,
      pg_primary_room_code: primaryRoomCode,
      pg_primary_room_name: primaryRoomName,
      primary_room_code: primaryRoomCode || atAvail.primary_room_code || '',
      pg_available_bed_count: Number(pgRow.available_bed_count || 0),
      pg_blocked_bed_count: Number(pgRow.blocked_bed_count || 0),
      pg_overlap_conflict_count: Number(pgRow.overlap_conflict_count || 0),
      pg_multi_room_required: !!pgRow.multi_room_required,
      pg_actionable: actionable,
      pg_errors: pgErrors,
      selected_room:
        pgFound && primaryRoomCode
          ? {
              room_id: primaryRoomCode,
              room_code: primaryRoomCode,
              room_name: primaryRoomName,
            }
          : atAvail.selected_room || null,
      hold_room_name: pgFound ? primaryRoomName || atAvail.hold_room_name || '' : '',
      hold_room_id: pgFound ? primaryRoomCode || atAvail.hold_room_id || '' : '',
      availability_authority: 'postgres',
      availability_type: pgFound
        ? pgRow.multi_room_required
          ? 'multi_room'
          : 'single_room'
        : atAvail.availability_type || 'none',
    },
  },
];`;

const VALIDATE_PG_HOLD_JS = `const prepare = $('Code - Prepare Hold Records').first().json || {};
const pgRow = $('Postgres - Create Booking Hold').first().json || {};
const mapPg = $('Code - Map PG Availability').first().json || {};

function parseActionable(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch (_) {}
  }
  return [];
}

const actionable = parseActionable(pgRow.actionable);
const pgErrors = Array.isArray(pgRow.pg_errors)
  ? pgRow.pg_errors
  : actionable.length
    ? actionable
    : [];

const pgOk = pgRow.pg_ok === true && !!pgRow.booking_id;

return [
  {
    json: {
      ...prepare,
      pg_ok: pgOk,
      booking_id: pgRow.booking_id || null,
      booking_code: pgRow.booking_code || prepare.hold_booking_id || null,
      pg_status: pgRow.status || null,
      pg_payment_status: pgRow.payment_status || null,
      pg_primary_room_code: pgRow.primary_room_code || mapPg.primary_room_code || mapPg.pg_primary_room_code || null,
      pg_created: pgRow.created === true,
      pg_updated: pgRow.updated === true,
      pg_actionable: actionable,
      pg_errors: pgOk ? [] : pgErrors,
      hold_booking_id: pgRow.booking_code || prepare.hold_booking_id,
      primary_room_code:
        pgRow.primary_room_code || mapPg.primary_room_code || mapPg.pg_primary_room_code || null,
    },
  },
];`;

const PG_HOLD_FAILED_STOP_JS = `const hold = $('Code - Validate PG Hold').first().json || {};
return [
  {
    json: {
      pg_hold_failed: true,
      pg_ok: false,
      booking_code: hold.booking_code || null,
      pg_errors: hold.pg_errors || hold.pg_actionable || ['pg_hold_failed'],
      note: 'Phase 3c.e.4 safety stop: no Airtable writes on PG hold failure.',
    },
  },
];`;

const PG_CONVERSATION_FAILED_STOP_JS = `const convo = $('Postgres - Upsert Conversation Hold').first().json || {};
return [
  {
    json: {
      pg_conversation_failed: true,
      pg_ok: false,
      booking_code: convo.booking_code || null,
      pg_errors: convo.pg_errors || convo.actionable || ['pg_conversation_upsert_failed'],
      note: 'Phase 3c.e.5 safety stop: no Airtable writes on PG conversation failure.',
    },
  },
];`;

function applyPhase3cHoldGate(workflow) {
  const prepareHold = workflow.nodes.find((n) => n.name === 'Code - Prepare Hold Records');
  const createAtHold = workflow.nodes.find((n) => n.name === 'Create Booking Hold');
  const summarizeHolds = workflow.nodes.find((n) => n.name === 'Code - Summarize Holds');
  if (!prepareHold || !createAtHold || !summarizeHolds) {
    throw new Error('Phase 3c.e.4: hold path nodes not found');
  }

  const NULL_SENTINEL = '__NULL__';
  const holdData = "$('Code - Prepare Hold Records').first().json";
  const sess = `((${holdData}.session) || {})`;
  const mapPg = "$('Code - Map PG Availability').first().json";

  function pgParam(innerExpr) {
    return `={{ ((${innerExpr}) != null && String(${innerExpr}).trim() !== '') ? String(${innerExpr}).trim() : '${NULL_SENTINEL}' }}`;
  }

  const holdQueryReplacement = [
    pgParam(`${holdData}.hold_booking_id`),
    pgParam(`${holdData}.guest_name`),
    pgParam(`${holdData}.guest_phone`),
    pgParam(`${holdData}.guest_email`),
    pgParam(`${sess}.check_in`),
    pgParam(`${sess}.check_out`),
    pgParam(`${holdData}.guest_count`),
    pgParam(`${sess}.room_type || ${sess}.requested_room_type || 'shared'`),
    pgParam(`${sess}.room_preference || ${sess}.room_type || 'shared'`),
    pgParam(`${sess}.guest_gender_group_type || 'unknown'`),
    pgParam(`${mapPg}.primary_room_code || ${mapPg}.pg_primary_room_code`),
    pgParam(`${sess}.package || ${sess}.package_code`),
  ].join(',');

  const backfillQueryReplacement = [
    pgParam(`$('Create Booking Hold').first().json.id`),
    pgParam(
      `$('Code - Validate PG Hold').first().json.booking_code || ${holdData}.hold_booking_id`
    ),
  ].join(',');

  const conversationQueryReplacement = [
    pgParam(`${holdData}.guest_phone || $('Normalize Incoming Message').first().json.phone`),
    pgParam(`$('Code - Validate PG Hold').first().json.booking_code || ${holdData}.hold_booking_id`),
    pgParam(`'booking_flow'`),
    pgParam(`${sess}.pending_action || 'collect_guest_details'`),
    pgParam(`$('Code - Parse Route').first().json.language || ${sess}.language`),
    pgParam(`JSON.stringify({
      current_hold_booking_code: $('Code - Validate PG Hold').first().json.booking_code || ${holdData}.hold_booking_id || '',
      check_in: ${sess}.check_in || null,
      check_out: ${sess}.check_out || null,
      guest_count: ${holdData}.guest_count || null,
      primary_room_code: $('Code - Validate PG Hold').first().json.primary_room_code || ${mapPg}.primary_room_code || ${mapPg}.pg_primary_room_code || null
    })`),
    pgParam(`'__NULL__'`),
    pgParam(`'bot'`),
  ].join(',');

  workflow.nodes.push(
    {
      parameters: {
        operation: 'executeQuery',
        query: buildHoldUpsertN8nSql(),
        options: { queryReplacement: holdQueryReplacement },
      },
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [4128, 880],
      id: '3ce004001-0001-4000-8000-000000000401',
      name: 'Postgres - Create Booking Hold',
      alwaysOutputData: true,
      credentials: { postgres: { id: '', name: 'Wolfhouse Postgres (local)' } },
    },
    {
      parameters: { jsCode: VALIDATE_PG_HOLD_JS },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [4256, 880],
      id: '3ce004002-0002-4000-8000-000000000402',
      name: 'Code - Validate PG Hold',
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            {
              id: 'pg-hold-ok',
              leftValue: "={{ $('Code - Validate PG Hold').first().json.pg_ok === true }}",
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
      position: [4384, 880],
      id: '3ce004003-0003-4000-8000-000000000403',
      name: 'IF - PG Hold OK',
    },
    {
      parameters: {
        operation: 'executeQuery',
        query: buildConversationHoldUpsertN8nSql(),
        options: { queryReplacement: conversationQueryReplacement },
      },
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [4496, 800],
      id: '3ce005001-0001-4000-8000-000000000501',
      name: 'Postgres - Upsert Conversation Hold',
      alwaysOutputData: true,
      credentials: { postgres: { id: '', name: 'Wolfhouse Postgres (local)' } },
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            {
              id: 'pg-conversation-ok',
              leftValue: "={{ $('Postgres - Upsert Conversation Hold').first().json.pg_ok === true }}",
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
      position: [4576, 880],
      id: '3ce005002-0002-4000-8000-000000000502',
      name: 'IF - PG Conversation OK',
    },
    {
      parameters: { jsCode: PG_CONVERSATION_FAILED_STOP_JS },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [4576, 1040],
      id: '3ce005003-0003-4000-8000-000000000503',
      name: 'Code - PG Conversation Failed Stop',
    },
    {
      parameters: {
        operation: 'executeQuery',
        query: buildHoldBackfillAirtableN8nSql(),
        options: { queryReplacement: backfillQueryReplacement },
      },
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.5,
      position: [4640, 800],
      id: '3ce004004-0004-4000-8000-000000000404',
      name: 'Postgres - Backfill Booking AT Record Id',
      alwaysOutputData: true,
      credentials: { postgres: { id: '', name: 'Wolfhouse Postgres (local)' } },
    },
    {
      parameters: { jsCode: PG_HOLD_FAILED_STOP_JS },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [4384, 1040],
      id: '3ce004005-0005-4000-8000-000000000405',
      name: 'Code - PG Hold Failed Stop',
    },
    {
      parameters: {
        content:
          '## Phase 3c.e.4/3c.e.5 — PG hold + conversation + AT mirror\n\nPG hold upsert → validate → IF → PG conversation upsert → IF → Create Booking Hold (mirror) → backfill airtable_record_id → Summarize.\n\nAny PG failure → terminal safety stop (no Airtable writes).',
        height: 200,
        width: 440,
      },
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [4040, 640],
      id: '3ce004006-0006-4000-8000-000000000406',
      name: 'Sticky Note - Phase 3c.e.4',
    }
  );

  workflow.connections['Code - Prepare Hold Records'] = {
    main: [[{ node: 'Postgres - Create Booking Hold', type: 'main', index: 0 }]],
  };
  workflow.connections['Postgres - Create Booking Hold'] = {
    main: [[{ node: 'Code - Validate PG Hold', type: 'main', index: 0 }]],
  };
  workflow.connections['Code - Validate PG Hold'] = {
    main: [[{ node: 'IF - PG Hold OK', type: 'main', index: 0 }]],
  };
  workflow.connections['IF - PG Hold OK'] = {
    main: [
      [{ node: 'Postgres - Upsert Conversation Hold', type: 'main', index: 0 }],
      [{ node: 'Code - PG Hold Failed Stop', type: 'main', index: 0 }],
    ],
  };
  workflow.connections['Postgres - Upsert Conversation Hold'] = {
    main: [[{ node: 'IF - PG Conversation OK', type: 'main', index: 0 }]],
  };
  workflow.connections['IF - PG Conversation OK'] = {
    main: [
      [{ node: 'Create Booking Hold', type: 'main', index: 0 }],
      [{ node: 'Code - PG Conversation Failed Stop', type: 'main', index: 0 }],
    ],
  };
  workflow.connections['Create Booking Hold'] = {
    main: [[{ node: 'Postgres - Backfill Booking AT Record Id', type: 'main', index: 0 }]],
  };
  workflow.connections['Postgres - Backfill Booking AT Record Id'] = {
    main: [[{ node: 'Code - Summarize Holds', type: 'main', index: 0 }]],
  };
  workflow.connections['Code - PG Hold Failed Stop'] = { main: [] };
  workflow.connections['Code - PG Conversation Failed Stop'] = { main: [] };

  summarizeHolds.parameters.jsCode = `const atHold = $('Create Booking Hold').first().json;
const backfill = $('Postgres - Backfill Booking AT Record Id').first().json || {};
const availability =
  $('Code - Map PG Availability').first().json ||
  $('Code - Check Bed Availability - WA').first().json;
const prepareHold = $('Code - Prepare Hold Records').first().json;
const pgHold = $('Code - Validate PG Hold').first().json;
const resolver = $('Code - Booking State Resolver').first().json;

const bookingCode =
  atHold.fields?.['Booking ID'] ||
  atHold['Booking ID'] ||
  pgHold.booking_code ||
  prepareHold.hold_booking_id ||
  '';

const holdRecordId = atHold.id || '';
const roomIds = [
  atHold.fields?.['Room ID'] ||
    atHold.fields?.['hold_room_id'] ||
    availability.hold_room_id ||
    availability.selected_room?.room_id ||
    pgHold.primary_room_code ||
    '',
];
const roomNames = [
  atHold.fields?.['Room Name'] ||
    availability.hold_room_name ||
    availability.selected_room?.room_name ||
    '',
];

const hasGuestDetails = !!prepareHold.has_guest_details;
const applyAfterHold = resolver.staged_contact?.apply_after_hold === true;

return [
  {
    json: {
      ...availability,
      holds_created: true,
      hold_booking_ids: bookingCode ? [bookingCode] : [],
      hold_room_ids: roomIds,
      hold_room_names: roomNames,
      hold_count: 1,
      hold_record_id: holdRecordId,
      pg_booking_id: pgHold.booking_id || backfill.booking_id || null,
      booking_code: bookingCode,
      has_guest_details: hasGuestDetails,
      should_run_stripe_payment:
        applyAfterHold ||
        prepareHold.should_run_stripe_payment === true ||
        hasGuestDetails,
      staged_contact_apply_after_hold: applyAfterHold,
      pg_hold_created: pgHold.pg_created === true,
      pg_hold_updated: pgHold.pg_updated === true,
      airtable_record_id: backfill.airtable_record_id || atHold.id || null,
    },
  },
];`;
}

function applyPhase3cAvailabilityGate(workflow) {
  const checkAvail = workflow.nodes.find((n) => n.name === 'Code - Check Bed Availability - WA');
  const ifAvail = workflow.nodes.find((n) => n.name === 'IF - Availability Found');
  if (!checkAvail || !ifAvail) {
    throw new Error('Phase 3c.e.3: Code - Check Bed Availability - WA or IF - Availability Found not found');
  }

  const NULL_SENTINEL = '__NULL__';
  const waSession =
    "(($('Code - Check Bed Availability - WA').first().json.session) || ($('Merge Session State').first().json.session) || {})";
  function pgParam(innerExpr) {
    return `={{ ((${innerExpr}) != null && String(${innerExpr}).trim() !== '') ? String(${innerExpr}).trim() : '${NULL_SENTINEL}' }}`;
  }

  const availabilityQueryReplacement = [
    pgParam(`${waSession}.check_in`),
    pgParam(`${waSession}.check_out`),
    pgParam(`${waSession}.guest_count || ${waSession}.guests`),
    pgParam(`${waSession}.room_preference || ${waSession}.room_type`),
    pgParam(`${waSession}.guest_gender_group_type`),
  ].join(',');

  const postgresNode = {
    parameters: {
      operation: 'executeQuery',
      query: buildMainAvailabilityGateN8nSql(),
      options: { queryReplacement: availabilityQueryReplacement },
    },
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.5,
    position: [3504, 976],
    id: '3ce003001-0001-4000-8000-000000000301',
    name: 'Postgres - Main Availability',
    alwaysOutputData: true,
    credentials: {
      postgres: { id: '', name: 'Wolfhouse Postgres (local)' },
    },
  };

  const mapNode = {
    parameters: { jsCode: MAP_PG_AVAILABILITY_JS },
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [3528, 912],
    id: '3ce003002-0002-4000-8000-000000000302',
    name: 'Code - Map PG Availability',
  };

  const sticky = {
    parameters: {
      content:
        '## Phase 3c.e.3 — PG availability gate\n\nSELECT-only. `Code - Map PG Availability` sets authoritative `availability_found` for IF below.\n\nAT bed searches kept for reply context; PG failure = no hold path.',
      height: 180,
      width: 420,
    },
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [3420, 720],
    id: '3ce003003-0003-4000-8000-000000000303',
    name: 'Sticky Note - Phase 3c.e.3',
  };

  workflow.nodes.push(postgresNode, mapNode, sticky);

  workflow.connections['Code - Check Bed Availability - WA'] = {
    main: [[{ node: 'Postgres - Main Availability', type: 'main', index: 0 }]],
  };
  workflow.connections['Postgres - Main Availability'] = {
    main: [[{ node: 'Code - Map PG Availability', type: 'main', index: 0 }]],
  };
  workflow.connections['Code - Map PG Availability'] = {
    main: [[{ node: 'IF - Availability Found', type: 'main', index: 0 }]],
  };

  const cond = ifAvail.parameters?.conditions?.conditions?.[0];
  if (cond) {
    cond.leftValue =
      "={{ $('Code - Map PG Availability').first().json.availability_found === true }}";
  }
}

function applyLocalTypingIndicatorBypass(workflow) {
  const ifIgnore = workflow.nodes.find((n) => n.name === 'IF - Ignore Non Guest Message');
  const typing = workflow.nodes.find((n) => n.name === 'Send Typing Indicator');
  const createInbound = workflow.nodes.find((n) => n.name === 'Create Inbound Message');
  if (!ifIgnore || !typing || !createInbound) {
    throw new Error('Local typing-indicator bypass: required nodes not found');
  }

  const bypassNode = {
    parameters: {
      conditions: {
        options: { caseSensitive: false, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'send-typing-real-whatsapp',
            leftValue: `={{ (() => {
  const n = $('Normalize Incoming Message').first().json || {};
  const source = String(n.source || '').toLowerCase();
  const messageId = String(n.whatsapp_message_id || '');
  const isPhaseTestMessageId = /^wamid\\.PHASE3C/i.test(messageId);
  return source === 'whatsapp' && messageId.length > 0 && !isPhaseTestMessageId;
})() }}`,
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
    position: [-1568, 992],
    id: '3cg1d001-0001-4000-8000-000000000701',
    name: 'IF - Send Typing Indicator (Local Guard)',
  };

  workflow.nodes.push(bypassNode);

  workflow.connections['IF - Ignore Non Guest Message'] = {
    main: [
      [],
      [{ node: 'IF - Send Typing Indicator (Local Guard)', type: 'main', index: 0 }],
    ],
  };

  workflow.connections['IF - Send Typing Indicator (Local Guard)'] = {
    main: [
      [{ node: 'Send Typing Indicator', type: 'main', index: 0 }],
      [{ node: 'Create Inbound Message', type: 'main', index: 0 }],
    ],
  };
}

function applyHumanActivePaymentLinkBypass(workflow) {
  const ifNeedsHuman = workflow.nodes.find((n) => n.name === 'IF - Needs Human');
  if (!ifNeedsHuman?.parameters?.conditions?.conditions?.[0]) {
    throw new Error('Human-active bypass: IF - Needs Human node/condition not found');
  }

  // Narrow bypass only for safe payment-link contact messages so resolver can handle
  // payment_details_provided path; all other human-active behavior remains unchanged.
  ifNeedsHuman.parameters.conditions.conditions[0].leftValue = `={{ 
  (() => {
    const conv = $('Search Conversation').first().json.fields || {};
    const msg = String(
      $('Normalize Incoming Message').first().json.guest_message ||
      $('Create Inbound Message').first().json.fields?.['Message Text'] ||
      ''
    ).trim();
    const lower = msg.toLowerCase();

    const needsHuman = conv['Needs Human'] === true;
    const botModeHumanActive = conv['Bot Mode'] === 'human_active';
    const humanGateActive = needsHuman || botModeHumanActive;

    if (!humanGateActive) return false;

    const hasPaymentLinkIntent =
      /\\b(payment link|send (me )?the payment link|pay link|checkout link|link to pay|payment url)\\b/i.test(lower);
    const hasEmail = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i.test(msg);
    const hasUsableName =
      /\\b(my name is|name is)\\b/i.test(lower) ||
      /\\b(i am|i'm|soy|me llamo|ich bin)\\s+[A-Z][a-z]+/i.test(msg);
    const hasPaymentClaim =
      /\\b(i paid|payment done|paid already|already paid|did you receive payment|payment received|payment completed|i completed payment)\\b/i.test(lower);
    const hasEscalationSignals =
      /\\b(refund|complain|complaint|angry|manager|human|person|staff|urgent|dispute|chargeback|scam|issue)\\b/i.test(lower);
    const hasRoomingOrReassignSignals =
      /\\b(rooming|reassign|bed assignment|split us|stay together|female room|male room|mixed room|girls room|guys room)\\b/i.test(lower);

    const stage = String(conv['Conversation Stage'] || '').trim().toLowerCase();
    const stageSafe =
      stage === 'booking_flow' ||
      stage === 'payment_pending' ||
      stage === 'human_handoff';

    const currentHoldId =
      String(
        conv['Current Hold ID'] ||
        (() => {
          try {
            return $('Code - Pick Active Booking').first().json.session?.current_hold_id || '';
          } catch (_) {
            return '';
          }
        })()
      ).trim();
    const hasHoldHint = /^WH-/i.test(currentHoldId);

    let holdUsable = false;
    try {
      const pick = $('Code - Pick Active Booking').first().json || {};
      const status = String(pick.active_booking_status || pick.active_booking?.status || '');
      holdUsable = pick.active_booking_found === true && (status === 'Hold' || status === 'Payment_Pending');
    } catch (_) {
      holdUsable = false;
    }

    const safeBookingContext = stageSafe || hasHoldHint || holdUsable;

    const allowResolverBypass =
      hasPaymentLinkIntent &&
      (hasEmail || hasUsableName) &&
      !hasPaymentClaim &&
      !hasEscalationSignals &&
      !hasRoomingOrReassignSignals &&
      safeBookingContext;

    return humanGateActive && !allowResolverBypass;
  })()
}}`;
}

function applyPhase2f(workflow) {
  const parseRoute = workflow.nodes.find((n) => n.name === 'Code - Parse Route');
  const switchNode = workflow.nodes.find((n) => n.name === 'Switch');
  const searchHold = workflow.nodes.find((n) => n.name === 'Search Hold With Guest Details');
  const extractGuest = workflow.nodes.find((n) => n.name === 'Code - Extract Guest Details');

  if (!parseRoute || !switchNode || !searchHold || !extractGuest) {
    throw new Error('Phase 2f: required Main nodes not found');
  }

  searchHold.parameters.filterByFormula = `={{ (() => {
  const pick = (() => {
    try {
      return $('Code - Pick Active Booking').first().json || {};
    } catch (_) {
      return {};
    }
  })();
  const targetRecordId = String(
    pick.active_booking_record_id ||
    pick.active_booking?.record_id ||
    pick.active_booking_raw?.id ||
    ''
  ).trim();
  const currentHoldId = String(
    $('Search Conversation').first().json.fields?.['Current Hold ID'] || ''
  ).trim();
  const phone = String($('Normalize Incoming Message').first().json.phone || '').trim();

  const preferredClauses = [];
  if (targetRecordId) preferredClauses.push('RECORD_ID()="' + targetRecordId + '"');
  if (currentHoldId) preferredClauses.push('{Booking ID}="' + currentHoldId + '"');
  if (phone) preferredClauses.push('{Phone}="' + phone + '"');
  if (!preferredClauses.length) preferredClauses.push('FALSE()');

  return (
    'AND(' +
      'OR(' + preferredClauses.join(',') + '),' +
      'OR({Status}="Hold",{Status}="Payment_Pending"),' +
      'OR({Payment Status}="not_requested",{Payment Status}="waiting_payment")' +
    ')'
  );
})() }}`;

  const resolverNode = {
    parameters: { jsCode: buildN8nResolverJsCode() },
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1750, 896],
    id: '2f010001-0001-4000-8000-000000000001',
    name: 'Code - Booking State Resolver',
    executeOnce: true,
  };

  const shouldSearchHoldNode = {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'should-search-hold',
            leftValue:
              "={{ $('Code - Booking State Resolver').first().json.hold_lookup?.should_search_hold === true }}",
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
    position: [2650, 560],
    id: '2f010002-0002-4000-8000-000000000002',
    name: 'IF - Should Search Hold',
  };

  const redirectBookingFlowNode = {
    parameters: {
      jsCode: `const resolver = $('Code - Booking State Resolver').first().json;
return [{
  json: {
    ...resolver,
    route: 'booking_flow',
    resolved_route: 'booking_flow',
    redirect_reason: resolver.logging?.decision_code || 'R2F_REDIRECT_BOOKING_FLOW',
    guest_message: resolver.guest_message,
  },
}];`,
    },
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [2650, 760],
    id: '2f010003-0003-4000-8000-000000000003',
    name: 'Code - Redirect to Booking Flow',
  };

  const holdFoundNode = {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'hold-id',
            leftValue: '={{ !!$json.id }}',
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
    position: [2870, 480],
    id: '2f010004-0004-4000-8000-000000000004',
    name: 'IF - Hold Found',
  };

  const holdNotFoundRouteNode = {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'has-booking-core',
            leftValue:
              "={{ $('Code - Booking State Resolver').first().json.message_signals?.has_booking_core === true }}",
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
    position: [3090, 560],
    id: '2f010005-0005-4000-8000-000000000005',
    name: 'IF - Hold Not Found Route',
  };

  const sticky2f = {
    parameters: {
      content:
        '## Phase 2f — Booking State Resolver\n\nSwitch uses `resolved_route`.\n\nPayment path: IF Should Search Hold → Search Hold (always output) → IF Hold Found.\n\nNo hold: controlled fallback (no silent stop).',
      height: 200,
      width: 400,
    },
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [1680, 720],
    id: '2f010008-0008-4000-8000-000000000008',
    name: 'Sticky Note - Phase 2f',
  };

  workflow.nodes.push(
    resolverNode,
    shouldSearchHoldNode,
    redirectBookingFlowNode,
    holdFoundNode,
    holdNotFoundRouteNode,
    sticky2f
  );

  searchHold.alwaysOutputData = true;

  const patchSwitch = (node) => {
    const rules = node.parameters?.rules?.values;
    if (!Array.isArray(rules)) return;
    for (const rule of rules) {
      const conds = rule.conditions?.conditions;
      if (!Array.isArray(conds)) continue;
      for (const c of conds) {
        if (typeof c.leftValue === 'string' && c.leftValue.includes('$json.route')) {
          c.leftValue = c.leftValue.replace(/\$json\.route/g, '$json.resolved_route');
        }
      }
    }
  };
  patchSwitch(switchNode);

  workflow.connections['Code - Parse Route'] = {
    main: [[{ node: 'Code - Booking State Resolver', type: 'main', index: 0 }]],
  };

  workflow.connections['Code - Booking State Resolver'] = {
    main: [[{ node: 'Switch', type: 'main', index: 0 }]],
  };

  workflow.connections['Code - Extract Guest Details'] = {
    main: [[{ node: 'IF - Should Search Hold', type: 'main', index: 0 }]],
  };

  workflow.connections['IF - Should Search Hold'] = {
    main: [
      [{ node: 'Search Hold With Guest Details', type: 'main', index: 0 }],
      [{ node: 'Code - Redirect to Booking Flow', type: 'main', index: 0 }],
    ],
  };

  workflow.connections['Code - Redirect to Booking Flow'] = {
    main: [[{ node: 'Parser Node', type: 'main', index: 0 }]],
  };

  workflow.connections['Search Hold With Guest Details'] = {
    main: [[{ node: 'IF - Hold Found', type: 'main', index: 0 }]],
  };

  workflow.connections['IF - Hold Found'] = {
    main: [
      [{ node: 'Update Hold With Guest Details', type: 'main', index: 0 }],
      [{ node: 'IF - Hold Not Found Route', type: 'main', index: 0 }],
    ],
  };

  workflow.connections['IF - Hold Not Found Route'] = {
    main: [
      [{ node: 'Parser Node', type: 'main', index: 0 }],
      [{ node: 'Reply - Collect Booking Details', type: 'main', index: 0 }],
    ],
  };
}

const PREPARE_STRIPE_CONTEXT_JS = `function getHoldFromNode(nodeName) {
  try {
    const item = $(nodeName).first();
    if (item?.json?.id && item.json.fields) {
      return { record_id: item.json.id, fields: item.json.fields, source: nodeName };
    }
  } catch (_) {}
  return null;
}

function getJsonFromNode(nodeName) {
  try {
    return $(nodeName).first().json || {};
  } catch (_) {
    return {};
  }
}

function firstNonEmpty(values) {
  for (const value of values) {
    const v = String(value || '').trim();
    if (v && v !== 'null' && v !== 'undefined') return v;
  }
  return '';
}

function pickBookingCode(candidates) {
  const normalized = candidates
    .map((value) => String(value || '').trim())
    .filter((value) => value && value !== 'null' && value !== 'undefined');
  const whCode = normalized.find((value) => /^WH-/i.test(value));
  if (whCode) return whCode;
  const nonRecordId = normalized.find((value) => !/^rec[A-Za-z0-9]+$/i.test(value));
  return nonRecordId || '';
}

const holdSources = [
  'Update Hold With Guest Details',
  'Update Booking Hold - Apply Staged Contact',
  'Create Booking Hold',
  'Search Hold With Guest Details',
];

let hold = null;
for (const nodeName of holdSources) {
  hold = getHoldFromNode(nodeName);
  if (hold?.record_id) break;
}

const extracted = getJsonFromNode('Code - Extract Guest Details');
const sessionCall = getJsonFromNode('Code - Call Create Payment Session');
const session = getJsonFromNode('Merge Session State').session || getJsonFromNode('Code - Check Bed Availability - WA').session || {};
const activeBooking = getJsonFromNode('Code - Pick Active Booking');
const conversation = getJsonFromNode('Search Conversation').fields || {};
const phone =
  $('Normalize Incoming Message').first().json.phone ||
  $('Create Inbound Message').first().json.fields?.['Conversation Phone'] ||
  '';

const fields = hold?.fields || {};
const emailMatch = String($('Code - Booking State Resolver').first().json.guest_message || '').match(
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i
);
const bookingCode = pickBookingCode([
  fields['Booking ID'],
  fields['booking_code'],
  fields['Booking Code'],
  fields['Current Hold ID'],
  hold?.json?.booking_code,
  activeBooking.active_booking?.booking_code,
  activeBooking.active_booking?.fields?.['Booking ID'],
  activeBooking.active_booking?.fields?.['booking_code'],
  activeBooking.active_booking?.fields?.['Booking Code'],
  activeBooking.active_booking_id,
  activeBooking.session?.current_hold_booking_code,
  activeBooking.session?.current_hold_id,
  session.current_hold_booking_code,
  session.current_hold_id,
  session.hold_booking_id,
  conversation['Current Hold ID'],
]);

return [
  {
    json: {
      hold_record_id: hold?.record_id || '',
      hold_source: hold?.source || '',
      booking_code: bookingCode,
      guest_name: fields['Guest Name'] || extracted.guest_name || session.name || '',
      guest_email: fields['Email'] || extracted.guest_email || session.email || (emailMatch ? emailMatch[0] : ''),
      phone: fields['Phone'] || extracted.guest_phone || phone,
      check_in: fields['Check In'] || session.check_in || '',
      check_out: fields['Check Out'] || session.check_out || '',
      guest_count: fields['Guest Count'] || session.guest_count || session.guests || 1,
      package_code: fields['Package'] || '',
      requested_room_type: fields['Requested Room Type'] || session.room_type || 'shared',
      room_preference: fields['Room Preference'] || session.room_preference || session.room_type || 'shared',
      guest_gender_group_type:
        fields['Guest Gender / Group Type'] || session.guest_gender_group_type || 'unknown',
      payment_link: fields['Payment Link'] || sessionCall.checkout_url || '',
      checkout_url: sessionCall.checkout_url || fields['Payment Link'] || '',
      use_stripe_checkout: String($env.USE_STRIPE_CHECKOUT || 'true').toLowerCase() === 'true',
      payment_kind: 'deposit_only',
    },
  },
];`;

const STRIPE_FALLBACK_REPLY_JS = `const lang = String(
  $('Code - Parse Route').first().json.language ||
  $('Search Conversation').first().json.fields?.Language ||
  'en'
).toLowerCase();

const name =
  $('Code - Prepare Stripe Payment Context').first().json.guest_name ||
  $('Merge Session State').first().json.session?.name ||
  '';

const byLang = {
  en: \`Thanks\${name ? ' ' + name : ''}! Your space is held for 1 hour. Our team will send your secure payment link here shortly — we could not generate it automatically just now.\`,
  de: \`Danke\${name ? ' ' + name : ''}! Wir haben euren Platz für 1 Stunde reserviert. Unser Team schickt euch gleich den sicheren Zahlungslink — die automatische Erstellung hat gerade nicht geklappt.\`,
  es: \`¡Gracias\${name ? ' ' + name : ''}! Hemos reservado vuestro espacio durante 1 hora. El equipo os enviará el enlace de pago seguro en breve — no pudimos generarlo automáticamente ahora.\`,
  it: \`Grazie\${name ? ' ' + name : ''}! Abbiamo tenuto il posto per 1 ora. Il team vi manderà a breve il link di pagamento sicuro — non siamo riusciti a generarlo automaticamente ora.\`,
};

const text = byLang[lang] || byLang.en;

return [{ json: { text, reply_text: text, stripe_payment_fallback: true } }];`;

function applyPhase2f2(workflow) {
  const summarizeHolds = workflow.nodes.find((n) => n.name === 'Code - Summarize Holds');
  const replyAvailability = workflow.nodes.find((n) => n.name === 'Reply - Availability Result');
  const replyPaymentPending = workflow.nodes.find((n) => n.name === 'Reply - Payment Pending');
  const buildRooming = workflow.nodes.find((n) => n.name === 'Code - Build Rooming Question');
  const ensurePostgres = workflow.nodes.find((n) => n.name === 'Postgres - Ensure Booking In Postgres');
  const updateStripeLink = workflow.nodes.find((n) => n.name === 'Update Booking - Stripe Payment Link');
  const prepareHold = workflow.nodes.find((n) => n.name === 'Code - Prepare Hold Records');

  if (
    !summarizeHolds ||
    !replyAvailability ||
    !replyPaymentPending ||
    !buildRooming ||
    !ensurePostgres ||
    !updateStripeLink
  ) {
    throw new Error('Phase 2f.2: required nodes not found');
  }

  if (prepareHold?.parameters?.jsCode) {
    prepareHold.parameters.jsCode = prepareHold.parameters.jsCode.replace(
      'has_guest_details:\n        !!session.name && !!session.email',
      `has_guest_details:
        !!session.name && !!session.email,
      should_run_stripe_payment: (() => {
        try {
          const resolver = $('Code - Booking State Resolver').first().json || {};
          if (resolver.staged_contact?.apply_after_hold === true) return true;
          if (resolver.resolved_sub_route === 'booking_full_capture_then_payment') {
            return !!(session.name && session.email);
          }
        } catch (_) {}
        return !!(session.name && session.email);
      })()`
    );
  }

  summarizeHolds.parameters.jsCode = `const created = $input.all();

const availability = $('Code - Check Bed Availability - WA').first().json;
const prepareHold = $('Code - Prepare Hold Records').first().json;
const resolver = $('Code - Booking State Resolver').first().json;

const bookingIds = created.map(item =>
  item.json.fields?.['Booking ID'] || item.json['Booking ID'] || item.json.id
);

const roomIds = created.map(item =>
  item.json.fields?.['Room ID'] ||
  item.json.fields?.['hold_room_id'] ||
  availability.hold_room_id ||
  availability.selected_room?.room_id ||
  ''
);

const roomNames = created.map(item =>
  item.json.fields?.['Room Name'] ||
  availability.hold_room_name ||
  availability.selected_room?.room_name ||
  ''
);

const hasGuestDetails = !!prepareHold.has_guest_details;
const applyAfterHold = resolver.staged_contact?.apply_after_hold === true;

return [
  {
    json: {
      ...availability,
      holds_created: true,
      hold_booking_ids: bookingIds,
      hold_room_ids: roomIds,
      hold_room_names: roomNames,
      hold_count: created.length,
      has_guest_details: hasGuestDetails,
      should_run_stripe_payment:
        applyAfterHold ||
        prepareHold.should_run_stripe_payment === true ||
        hasGuestDetails,
      staged_contact_apply_after_hold: applyAfterHold,
    },
  },
];`;

  if (replyAvailability?.parameters?.text) {
    replyAvailability.parameters.text = replyAvailability.parameters.text.replace(
      '* If lead guest name and email are complete, include the payment link.',
      '* Do not ask the guest to pay in this message and do not say payment is below. Stripe checkout is sent in a separate payment message.'
    );
    replyAvailability.parameters.text = replyAvailability.parameters.text.replace(
      '* Never say "I will send the payment link shortly" if the payment link is available.',
      '* Never say "complete the payment below" or "pay below".'
    );
    replyAvailability.parameters.text = replyAvailability.parameters.text.replace(
      '  Say the booking will be confirmed once payment is verified.\n  Do not ask for name or email again.\n  Do not ask them to confirm again.',
      '  Do not ask for name or email again.\n  Do not ask them to confirm again.'
    );
  }

  const ctx = "$('Code - Prepare Stripe Payment Context').first().json";
  const NULL_SENTINEL = '__NULL__';

  function pgParam(innerExpr) {
    return `={{ ((${innerExpr}) != null && String(${innerExpr}).trim() !== '') ? String(${innerExpr}).trim() : '${NULL_SENTINEL}' }}`;
  }

  ensurePostgres.parameters.options.queryReplacement = [
    pgParam(`${ctx}.booking_code`),
    pgParam(`${ctx}.guest_name`),
    pgParam(`${ctx}.phone`),
    pgParam(`${ctx}.guest_email`),
    pgParam(`${ctx}.check_in`),
    pgParam(`${ctx}.check_out`),
    pgParam(`${ctx}.guest_count`),
    pgParam(`${ctx}.package_code`),
    pgParam(`${ctx}.requested_room_type`),
    pgParam(`${ctx}.room_preference`),
    pgParam(`${ctx}.guest_gender_group_type`),
    pgParam(`${ctx}.hold_record_id`),
  ].join(',');

  if (updateStripeLink.parameters?.columns?.value) {
    updateStripeLink.parameters.columns.value.id = `={{ $('Code - Prepare Stripe Payment Context').first().json.hold_record_id }}`;
  }

  const newNodes = [
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            {
              id: 'apply-stripe-after-hold',
              leftValue: STRIPE_AFTER_HOLD_IF_EXPR,
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
      position: [4528, 880],
      id: '2f020001-0001-4000-8000-000000000201',
      name: 'IF - Apply Stripe After Hold',
    },
    {
      parameters: {
        operation: 'update',
        base: {
          __rl: true,
          value: 'appOCWIN47Bui9CSS',
          mode: 'list',
          cachedResultName: 'Wolfhouse',
          cachedResultUrl: 'https://airtable.com/appOCWIN47Bui9CSS',
        },
        table: {
          __rl: true,
          value: 'tblYWm3zKFafe4qu7',
          mode: 'list',
          cachedResultName: 'Bookings',
          cachedResultUrl: 'https://airtable.com/appOCWIN47Bui9CSS/tblYWm3zKFafe4qu7',
        },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            id: "={{ $('Create Booking Hold').first().json.id }}",
            'Guest Name':
              "={{ $('Merge Session State').first().json.session?.name || $('Code - Prepare Hold Records').first().json.guest_name || '' }}",
            Email:
              "={{ $('Merge Session State').first().json.session?.email || $('Code - Prepare Hold Records').first().json.guest_email || '' }}",
            Phone:
              "={{ $('Normalize Incoming Message').first().json.phone || $('Code - Prepare Hold Records').first().json.guest_phone || '' }}",
            Status: 'Payment_Pending',
            'Payment Status': 'waiting_payment',
          },
          matchingColumns: ['id'],
          schema: [
            {
              id: 'id',
              displayName: 'id',
              required: false,
              defaultMatch: true,
              display: true,
              type: 'string',
              readOnly: true,
              removed: false,
            },
          ],
          attemptToConvertTypes: false,
          convertFieldsToString: false,
        },
        options: { typecast: true },
      },
      type: 'n8n-nodes-base.airtable',
      typeVersion: 2.2,
      position: [4688, 800],
      id: '2f020002-0002-4000-8000-000000000202',
      name: 'Update Booking Hold - Apply Staged Contact',
      credentials: {
        airtableTokenApi: { id: '', name: 'Airtable Personal Access Token account' },
      },
    },
    {
      parameters: { jsCode: PREPARE_STRIPE_CONTEXT_JS },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [3080, 672],
      id: '2f020003-0003-4000-8000-000000000203',
      name: 'Code - Prepare Stripe Payment Context',
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            {
              id: 'payment-link-safe',
              leftValue: `={{ 
  ($env.USE_STRIPE_CHECKOUT || 'true').toString().toLowerCase() !== 'true'
  || (() => {
    const link = String(
      $('Update Booking - Stripe Payment Link').isExecuted
        ? ($('Update Booking - Stripe Payment Link').first().json.fields?.['Payment Link'] || '')
        : ($('Code - Prepare Stripe Payment Context').first().json.payment_link || '')
    ).trim();
    return link.length > 0 && !link.includes('booking-payment-placeholder');
  })()
}}`,
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
      position: [3920, 368],
      id: '2f020004-0004-4000-8000-000000000204',
      name: 'IF - Payment Link Safe For Reply',
    },
    {
      parameters: { jsCode: STRIPE_FALLBACK_REPLY_JS },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [3920, 512],
      id: '2f020005-0005-4000-8000-000000000205',
      name: 'Code - Stripe Payment Fallback Reply',
    },
    {
      parameters: {
        content:
          '## Phase 2f.2 — Stripe after booking hold\n\n`Code - Summarize Holds` → IF Apply Stripe After Hold → sync guest → Prepare Stripe Context → 2c chain → payment reply.\n\nGuard blocks placeholder links when USE_STRIPE_CHECKOUT=true.',
        height: 200,
        width: 440,
      },
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [4440, 640],
      id: '2f020006-0006-4000-8000-000000000206',
      name: 'Sticky Note - Phase 2f.2',
    },
  ];

  workflow.nodes.push(...newNodes);

  workflow.connections['Code - Summarize Holds'] = {
    main: [[{ node: 'IF - Apply Stripe After Hold', type: 'main', index: 0 }]],
  };

  workflow.connections['IF - Apply Stripe After Hold'] = {
    main: [
      [{ node: 'Update Booking Hold - Apply Staged Contact', type: 'main', index: 0 }],
      [{ node: 'Reply - Availability Result', type: 'main', index: 0 }],
    ],
  };

  workflow.connections['Update Booking Hold - Apply Staged Contact'] = {
    main: [[{ node: 'Code - Prepare Stripe Payment Context', type: 'main', index: 0 }]],
  };

  workflow.connections['Update Hold With Guest Details'] = {
    main: [[{ node: 'Code - Prepare Stripe Payment Context', type: 'main', index: 0 }]],
  };

  workflow.connections['Code - Prepare Stripe Payment Context'] = {
    main: [[{ node: 'IF - Use Stripe Checkout', type: 'main', index: 0 }]],
  };

  workflow.connections['Code - Build Rooming Question'] = {
    main: [[{ node: 'IF - Payment Link Safe For Reply', type: 'main', index: 0 }]],
  };

  workflow.connections['IF - Payment Link Safe For Reply'] = {
    main: [
      [{ node: 'Reply - Payment Pending', type: 'main', index: 0 }],
      [{ node: 'Code - Stripe Payment Fallback Reply', type: 'main', index: 0 }],
    ],
  };

}

const SRC = path.join(__dirname, '..', 'n8n', 'Wolfhouse Booking Assistant  - Main.json');
const OUT = path.join(
  __dirname,
  '..',
  'n8n',
  'phase2',
  'Wolfhouse Booking Assistant - Main (local Stripe).json'
);

/** @returns {object} workflow before neutralization / active=false */
function buildMainLocalStripeWorkflow() {
const workflow = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const stripePaymentLinkFieldSchema = stripePaymentLinkUpdateSchema(workflow);
workflow.name = 'Wolfhouse Booking Assistant - Main (local Stripe)';
workflow.tags = [
  ...(workflow.tags || []),
  { name: 'phase2c' },
  { name: 'phase2f' },
  { name: 'local-only' },
  { name: 'stripe' },
];

const updateHold = workflow.nodes.find((n) => n.name === 'Update Hold With Guest Details');
if (!updateHold) throw new Error('Update Hold With Guest Details not found');

// Stop writing placeholder; Stripe branch sets Payment Link when possible.
if (updateHold.parameters?.columns?.value) {
  delete updateHold.parameters.columns.value['Payment Link'];
}

const bookingCodeExpr =
  "={{ $('Search Hold With Guest Details').first().json.fields?.['Booking ID'] || '' }}";
const holdRecordIdExpr =
  "={{ $('Search Hold With Guest Details').first().json.id }}";

const holdFields = "$('Search Hold With Guest Details').first().json.fields";
const NULL_SENTINEL = '__NULL__';

/** n8n Postgres drops empty query params and shifts $n — use sentinel for every parameter. */
function pgParam(innerExpr) {
  return `={{ ((${innerExpr}) != null && String(${innerExpr}).trim() !== '') ? String(${innerExpr}).trim() : '${NULL_SENTINEL}' }}`;
}

const ensureQueryReplacement = [
  pgParam(`${holdFields}?.['Booking ID']`),
  pgParam(`${holdFields}?.['Guest Name'] || $('Code - Extract Guest Details').first().json.guest_name`),
  pgParam(`${holdFields}?.['Phone'] || $('Normalize Incoming Message').first().json.phone`),
  pgParam(`${holdFields}?.['Email'] || $('Code - Extract Guest Details').first().json.guest_email`),
  pgParam(`${holdFields}?.['Check In']`),
  pgParam(`${holdFields}?.['Check Out']`),
  pgParam(`${holdFields}?.['Guest Count']`),
  pgParam(`${holdFields}?.['Package']`),
  pgParam(`${holdFields}?.['Requested Room Type']`),
  pgParam(`${holdFields}?.['Room Preference']`),
  pgParam(`${holdFields}?.['Guest Gender / Group Type']`),
  pgParam(`$('Search Hold With Guest Details').first().json.id`),
].join(',');

const ensureBookingSql = buildEnsurePromoteN8nSql();

const newNodes = [
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'use-stripe',
            leftValue: "={{ ($env.USE_STRIPE_CHECKOUT || 'true').toString().toLowerCase() }}",
            rightValue: 'true',
            operator: { type: 'string', operation: 'equals' },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [3000, 672],
    id: '2c010001-0001-4000-8000-000000000001',
    name: 'IF - Use Stripe Checkout',
  },
  {
    parameters: {
      operation: 'executeQuery',
      query: ensureBookingSql,
      options: {
        queryReplacement: ensureQueryReplacement,
      },
    },
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.5,
    position: [3220, 560],
    id: '2c010002-0002-4000-8000-000000000002',
    name: 'Postgres - Ensure Booking In Postgres',
    alwaysOutputData: true,
    credentials: {
      postgres: { id: '', name: 'Wolfhouse Postgres (local)' },
    },
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'has-booking-id',
            leftValue: '={{ $json.booking_id }}',
            rightValue: '',
            operator: { type: 'string', operation: 'notEmpty' },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [3440, 560],
    id: '2c010003-0003-4000-8000-000000000003',
    name: 'IF - Booking ID Ready',
  },
  {
    parameters: {
      jsCode: `const row = $('Postgres - Ensure Booking In Postgres').first().json;
const bookingId = row.booking_id;
if (!bookingId) {
  return [{
    json: {
      ok: false,
      error: 'No booking_id after Ensure Booking In Postgres',
    },
  }];
}

const url = $env.N8N_CREATE_PAYMENT_SESSION_URL || 'http://localhost:5678/webhook/create-payment-session';

try {
  const data = await this.helpers.httpRequest({
    method: 'POST',
    url,
    headers: { 'Content-Type': 'application/json' },
    body: { booking_id: bookingId, payment_kind: 'deposit_only' },
    json: true,
  });

  if (!data || !data.ok || !data.checkout_url) {
    return [{
      json: {
        ok: false,
        error: (data && data.error) || 'Create Payment Session did not return checkout_url',
        booking_id: bookingId,
        created_in_postgres: !!row.created,
      },
    }];
  }

  return [{
    json: {
      ok: true,
      checkout_url: data.checkout_url,
      reused: !!data.reused,
      booking_id: bookingId,
      amount_due_cents: data.amount_due_cents,
      stripe_checkout_session_id: data.stripe_checkout_session_id,
      created_in_postgres: !!row.created,
    },
  }];
} catch (error) {
  return [{
    json: {
      ok: false,
      error: error.message || String(error),
      booking_id: bookingId,
      created_in_postgres: !!row.created,
    },
  }];
}`,
    },
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [3660, 480],
    id: '2c010004-0004-4000-8000-000000000004',
    name: 'Code - Call Create Payment Session',
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'checkout-ok',
            leftValue: '={{ $json.ok }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'equals' },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [3880, 480],
    id: '2c010005-0005-4000-8000-000000000005',
    name: 'IF - Checkout URL Ready',
  },
  {
    parameters: {
      operation: 'update',
      base: {
        __rl: true,
        value: 'appOCWIN47Bui9CSS',
        mode: 'list',
        cachedResultName: 'Wolfhouse Ops',
        cachedResultUrl: 'https://airtable.com/appOCWIN47Bui9CSS',
      },
      table: {
        __rl: true,
        value: 'tblYWm3zKFafe4qu7',
        mode: 'list',
        cachedResultName: 'Bookings',
        cachedResultUrl: 'https://airtable.com/appOCWIN47Bui9CSS/tblYWm3zKFafe4qu7',
      },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          id: STRIPE_HOLD_RECORD_ID_EXPR,
          'Payment Link':
            "={{ $('Code - Call Create Payment Session').first().json.checkout_url }}",
        },
        matchingColumns: ['id'],
        schema: stripePaymentLinkFieldSchema,
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
      options: { typecast: true },
    },
    type: 'n8n-nodes-base.airtable',
    typeVersion: 2.2,
    position: [4100, 400],
    id: '2c010006-0006-4000-8000-000000000006',
    name: 'Update Booking - Stripe Payment Link',
    credentials: {
      airtableTokenApi: { id: '', name: 'Airtable Personal Access Token account' },
    },
  },
  {
    parameters: {
      content:
        '## Phase 2c / 3c.e.2 — Ensure Booking In Postgres\n\nPromote hold → payment_pending (shared 3c.c.4 SQL). $1–$12 + __NULL__ sentinel; $12 = Airtable hold rec id backfill.\n\nOutputs: booking_id, booking_code, created, promoted, blocked, action, status, payment_status.',
      height: 220,
      width: 420,
    },
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [2760, 420],
    id: '2c010007-0007-4000-8000-000000000007',
    name: 'Sticky Note - Phase 2c',
  },
];

workflow.nodes.push(...newNodes);

const nextNode = 'Update Conversation - Guest Details';

workflow.connections['Update Hold With Guest Details'] = {
  main: [[{ node: 'IF - Use Stripe Checkout', type: 'main', index: 0 }]],
};

workflow.connections['IF - Use Stripe Checkout'] = {
  main: [
    [{ node: 'Postgres - Ensure Booking In Postgres', type: 'main', index: 0 }],
    [{ node: nextNode, type: 'main', index: 0 }],
  ],
};

workflow.connections['Postgres - Ensure Booking In Postgres'] = {
  main: [[{ node: 'IF - Booking ID Ready', type: 'main', index: 0 }]],
};

workflow.connections['IF - Booking ID Ready'] = {
  main: [
    [{ node: 'Code - Call Create Payment Session', type: 'main', index: 0 }],
    [{ node: nextNode, type: 'main', index: 0 }],
  ],
};

workflow.connections['Code - Call Create Payment Session'] = {
  main: [[{ node: 'IF - Checkout URL Ready', type: 'main', index: 0 }]],
};

workflow.connections['IF - Checkout URL Ready'] = {
  main: [
    [{ node: 'Update Booking - Stripe Payment Link', type: 'main', index: 0 }],
    [{ node: nextNode, type: 'main', index: 0 }],
  ],
};

workflow.connections['Update Booking - Stripe Payment Link'] = {
  main: [[{ node: nextNode, type: 'main', index: 0 }]],
};

applyPhase2f(workflow);
applyPhase2f2(workflow);
applyMergedPaymentPathFixes(workflow);
applyDeterministicPaymentUrl(workflow);
applyPhase3cAvailabilityGate(workflow);
applyPhase3cHoldGate(workflow);
applyLocalTypingIndicatorBypass(workflow);
applyHumanActivePaymentLinkBypass(workflow);
applyPostgresCredentialMapping(workflow);

workflow.tags = [
  ...(workflow.tags || []),
  { name: 'phase2f2' },
  { name: 'phase2f3' },
  { name: 'phase3c-e3' },
  { name: 'phase3c-e4' },
  { name: 'phase3c-e5' },
  { name: 'phase3c-g1d' },
];

return workflow;
}

/**
 * @param {object} workflow
 * @returns {{ workflow: object, baseReplacements: number }}
 */
function finalizeLocalWorkflow(workflow) {
  workflow.name = LOCAL_WORKFLOW_NAME;
  workflow.id = LOCAL_WORKFLOW_ID;
  workflow.active = false;
  const neutralized = neutralizeProductionTargets(workflow);
  return neutralized;
}

function printUsage() {
  console.error(`Usage:
  node scripts/build-main-local-stripe.js              Generate local fork (neutralize + active=false)
  node scripts/build-main-local-stripe.js --inventory  Read-only inventory (hosted + local)
  node scripts/build-main-local-stripe.js --verify-targets  Verify generated ${path.basename(OUT)}
  node scripts/build-main-local-stripe.js --print-target-map  Phase 3c.e injection map (no write)`);
}

module.exports = {
  PHASE_3CE_PG_TARGETS,
  neutralizeProductionTargets,
  verifyProductionTargets,
  buildMainLocalStripeWorkflow,
  finalizeLocalWorkflow,
  runVerifyTargets,
  OUT,
  PROD_AIRTABLE_BASE_ID,
  TEST_AIRTABLE_BASE_ID,
};

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--inventory')) {
    runMainWorkflowInventory({ hostedPath: SRC, localPath: OUT });
    process.exit(0);
  }

  if (args.includes('--print-target-map')) {
    printPhase3ceTargetMap();
    process.exit(0);
  }

  if (args.includes('--verify-targets')) {
    runVerifyTargets();
    process.exit(0);
  }

  if (args.length > 0) {
    printUsage();
    process.exit(1);
  }

  const built = buildMainLocalStripeWorkflow();
  const { workflow: finalized, baseReplacements } = finalizeLocalWorkflow(built);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(finalized, null, 2));
  console.log('Wrote', OUT);
  console.log('Nodes:', finalized.nodes.length);
  console.log(`Airtable base neutralized: ${baseReplacements} replacement(s) (${PROD_AIRTABLE_BASE_ID} → ${TEST_AIRTABLE_BASE_ID})`);
  console.log('workflow.active:', finalized.active);
  console.log('');

  runVerifyTargets(finalized, { exitOnFail: true, filePath: OUT });
}
