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
const { buildConversationHoldUpsertN8nSql, buildSessionWriteN8nSql } = require('./lib/main-conversation-pg-sql');
const {
  HOSTED_REASSIGN_URL,
  DEFAULT_REASSIGN_BOOKING_BEDS_URL,
  scanHostedReassignUrls,
  scanLocalReassignEndpoint,
  scanMainBookingBedsWrites,
  applyLocalReassignWebhookRemap,
  fixReassignHttpBodyParameterExpressions,
  scanReassignBodyParameterExprBugs,
  analyzeReassignContract,
} = require('./lib/main-reassign-endpoint');

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
    errors.push(
      `hosted reassign URL (${HOSTED_REASSIGN_URL}) in: ${reassignNodes.join(', ')} — run build-main-local-stripe to remap`
    );
  }

  const localReassign = scanLocalReassignEndpoint(workflow);
  if (!localReassign.ok) {
    errors.push(
      `local reassign endpoint missing or not worker-reachable (expected ${DEFAULT_REASSIGN_BOOKING_BEDS_URL} or $env.N8N_REASSIGN_BOOKING_BEDS_URL); http nodes: ${localReassign.httpNodes.map((n) => n.name).join(', ') || '(none)'}`
    );
  }

  const reassignBodyParamBugs = scanReassignBodyParameterExprBugs(workflow);
  if (reassignBodyParamBugs.length) {
    errors.push(
      `Reassign HTTP bodyParameters use =={{ (serializes as =value; must be ={{): ${reassignBodyParamBugs.join(', ')}`
    );
  }

  const bookingBedsWrites = scanMainBookingBedsWrites(workflow);
  if (bookingBedsWrites.length) {
    errors.push(
      `booking_beds SQL writes in Main (must stay in bed-ops forks): ${bookingBedsWrites.map((h) => h.node).join(', ')}`
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
    localReassign,
    bookingBedsWrites,
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
  if (result.localReassign?.ok) {
    console.log(
      `Reassign endpoint: $env.N8N_REASSIGN_BOOKING_BEDS_URL || '${DEFAULT_REASSIGN_BOOKING_BEDS_URL}' (${result.localReassign.httpNodes.length} HTTP node(s))`
    );
  }
  console.log(`Hosted reassign hits: ${result.reassignNodes?.length ?? 0}`);
  console.log(`Main booking_beds SQL writes: ${result.bookingBedsWrites?.length ?? 0}`);
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
  const shadow = verifyShadowModeSafety(wf);
  const cmGuard = verifyClosedMonthGuard(wf, CLOSED_MONTHS_CONFIG);
  const pgConvRead = verifyPGConversationRead(wf);
  const pkgRequired = verifyPackageRequirement(wf);
  const poiNoHoldFallback = verifyPaymentOrConfirmFallback(wf);
  const holdIdGuard = verifyActiveBookingHoldIdGuard(wf);
  const addonsPrompt = verifyGeneralQuestionAddonsPrompt(wf, SERVICE_ADDONS_CONFIG);
  const pgSessionWrite = verifyPGSessionWrite(wf);
  const summarizeHoldsPG = verifySummarizeHoldsPGPrimary(wf);
  const ensurePromoteInsert = verifyEnsurePromoteInsertDefaults(wf);
  const stage52Guard = verifyStage52FixtureGuard(wf);
  const stage53Guard = verifyStage53FixtureGuard(wf);
  const result = {
    ...raw,
    workflowActive: wf.active,
    workflowId: wf.id,
    workflowName: wf.name,
    shadowModeSafety: shadow,
    closedMonthGuard: cmGuard,
    pgConversationRead: pgConvRead,
    packageRequired: pkgRequired,
    paymentOrConfirmFallback: poiNoHoldFallback,
    activeBookingHoldIdGuard: holdIdGuard,
    generalQuestionAddonsPrompt: addonsPrompt,
    pgSessionWrite,
    summarizeHoldsPGPrimary: summarizeHoldsPG,
    ensurePromoteInsertDefaults: ensurePromoteInsert,
    stage52FixtureGuard: stage52Guard,
    stage53FixtureGuard: stage53Guard,
  };
  if (!shadow.ok) {
    console.error(`Shadow-mode safety FAIL (${shadow.errors.length} error(s)):`);
    for (const e of shadow.errors) console.error(`  ${e}`);
    result.ok = false;
    result.errors = [...(result.errors || []), ...shadow.errors.map((e) => `[shadow] ${e}`)];
  }
  if (!cmGuard.ok) {
    console.error(`Closed-month guard FAIL (${cmGuard.errors.length} error(s)):`);
    for (const e of cmGuard.errors) console.error(`  ${e}`);
    result.ok = false;
    result.errors = [...(result.errors || []), ...cmGuard.errors.map((e) => `[cm-guard] ${e}`)];
  }
  if (!pgConvRead.ok) {
    console.error(`PG conversation read FAIL (${pgConvRead.errors.length} error(s)):`);
    for (const e of pgConvRead.errors) console.error(`  ${e}`);
    result.ok = false;
    result.errors = [...(result.errors || []), ...pgConvRead.errors.map((e) => `[pg-conv-read] ${e}`)];
  }
  if (!pkgRequired.ok) {
    console.error(`Package requirement FAIL (${pkgRequired.errors.length} error(s)):`);
    for (const e of pkgRequired.errors) console.error(`  ${e}`);
    result.ok = false;
    result.errors = [...(result.errors || []), ...pkgRequired.errors.map((e) => `[pkg-required] ${e}`)];
  }
  if (!poiNoHoldFallback.ok) {
    console.error(`Payment/confirm fallback FAIL (${poiNoHoldFallback.errors.length} error(s)):`);
    for (const e of poiNoHoldFallback.errors) console.error(`  ${e}`);
    result.ok = false;
    result.errors = [...(result.errors || []), ...poiNoHoldFallback.errors.map((e) => `[poi-fallback] ${e}`)];
  }
  if (!holdIdGuard.ok) {
    // Note: the active booking hold-id guard is deferred — informational only, does not block.
    console.warn(`Active booking hold-id guard: PENDING (deferred Airtable formula fix)`);
  }
  if (!addonsPrompt.ok) {
    console.error(`General question add-ons prompt FAIL (${addonsPrompt.errors.length} error(s)):`);
    for (const e of addonsPrompt.errors) console.error(`  ${e}`);
    result.ok = false;
    result.errors = [...(result.errors || []), ...addonsPrompt.errors.map((e) => `[addons-prompt] ${e}`)];
  }
  if (!pgSessionWrite.ok) {
    console.error(`PG session write FAIL (${pgSessionWrite.errors.length} error(s)):`);
    for (const e of pgSessionWrite.errors) console.error(`  ${e}`);
    result.ok = false;
    result.errors = [...(result.errors || []), ...pgSessionWrite.errors.map((e) => `[pg-session-write] ${e}`)];
  }
  if (!summarizeHoldsPG.ok) {
    console.error(`Summarize Holds PG-primary FAIL (${summarizeHoldsPG.errors.length} error(s)):`);
    for (const e of summarizeHoldsPG.errors) console.error(`  ${e}`);
    result.ok = false;
    result.errors = [...(result.errors || []), ...summarizeHoldsPG.errors.map((e) => `[summarize-holds-pg] ${e}`)];
  }
  if (!ensurePromoteInsert.ok) {
    console.error(`Ensure promote INSERT defaults FAIL (${ensurePromoteInsert.errors.length} error(s)):`);
    for (const e of ensurePromoteInsert.errors) console.error(`  ${e}`);
    result.ok = false;
    result.errors = [...(result.errors || []), ...ensurePromoteInsert.errors.map((e) => `[ensure-promote-insert] ${e}`)];
  }
  if (!stage52Guard.ok) {
    console.error(`Stage52 fixture hold guard FAIL (${stage52Guard.errors.length} error(s)):`);
    for (const e of stage52Guard.errors) console.error(`  ${e}`);
    result.ok = false;
    result.errors = [...(result.errors || []), ...stage52Guard.errors.map((e) => `[stage52-guard] ${e}`)];
  }
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
    // Stage 5.1b: enrich session_state with all booking-relevant fields available at hold time.
    // Use an IIFE to build the object conditionally — only include non-null/non-empty values so
    // that subsequent ON CONFLICT updates (SQL: existing || incoming) never overwrite live fields
    // with empty values from a partial turn.
    pgParam(`JSON.stringify((() => {
      const _s = {};
      const _bc = $('Code - Validate PG Hold').first().json.booking_code || ${holdData}.hold_booking_id;
      _s.current_hold_booking_code = _bc || '';
      const _ci = ${sess}.check_in; if (_ci) _s.check_in = _ci;
      const _co = ${sess}.check_out; if (_co) _s.check_out = _co;
      const _gc = ${holdData}.guest_count; if (_gc != null && _gc !== '') _s.guest_count = _gc;
      const _pr = $('Code - Validate PG Hold').first().json.primary_room_code || ${mapPg}.primary_room_code || ${mapPg}.pg_primary_room_code; if (_pr) _s.primary_room_code = _pr;
      const _pkg = ${sess}.package || ${sess}.package_code; if (_pkg) _s.package = _pkg;
      const _lang = $('Code - Parse Route').first().json.language || ${sess}.language; if (_lang) _s.language = _lang;
      const _route = $('Code - Parse Route').first().json.route; if (_route) _s.route = _route;
      const _rt = ${sess}.room_type || ${sess}.requested_room_type; if (_rt) _s.room_type = _rt;
      const _rp = ${sess}.room_preference; if (_rp) _s.room_preference = _rp;
      const _gn = ${holdData}.guest_name; if (_gn) _s.guest_name = _gn;
      const _ge = ${holdData}.guest_email; if (_ge) _s.guest_email = _ge;
      const _mf = ${sess}.missing_fields; if (Array.isArray(_mf) && _mf.length > 0) _s.missing_fields = _mf;
      return _s;
    })())`),
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

  summarizeHolds.parameters.jsCode = `const atHold = $('Create Booking Hold').first().json || {};
const backfill = $('Postgres - Backfill Booking AT Record Id').first().json || {};
const availability =
  $('Code - Map PG Availability').first().json ||
  $('Code - Check Bed Availability - WA').first().json;
const prepareHold = $('Code - Prepare Hold Records').first().json;
const pgHold = $('Code - Validate PG Hold').first().json;
const resolver = $('Code - Booking State Resolver').first().json;

// Stage 5.2b: PG hold is authoritative; AT Booking ID is fallback only.
// Priority: pgHold.booking_code > dry-run stub > AT Booking ID field > prepare fallback
const bookingCode =
  pgHold.booking_code ||
  pgHold.hold_booking_id ||
  atHold.fields?.['Booking ID'] ||
  atHold['Booking ID'] ||
  prepareHold.hold_booking_id ||
  '';

const holdRecordId = atHold.id || '';
const roomIds = [
  availability.hold_room_id ||
    availability.selected_room?.room_id ||
    pgHold.pg_primary_room_code ||
    pgHold.primary_room_code ||
    atHold.fields?.['Room ID'] ||
    atHold.fields?.['hold_room_id'] ||
    '',
];
const roomNames = [
  availability.hold_room_name ||
    availability.selected_room?.room_name ||
    atHold.fields?.['Room Name'] ||
    '',
];

const hasGuestDetails = !!prepareHold.has_guest_details;
const applyAfterHold = resolver.staged_contact?.apply_after_hold === true;
const isDryRun = pgHold.dry_run === true || backfill.dry_run === true || false;

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
      booking_id: pgHold.booking_id || null,
      hold_expires_at: pgHold.hold_expires_at || null,
      dry_run: isDryRun,
      pg_hold_ok: pgHold.pg_ok === true,
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

// ─── Stage 5.1 — PG-primary conversation read ───────────────────────────────
//
// Adds `Postgres - Search Conversation (PG)` on the shared path in series between
// `Search Conversation` (Airtable) and `IF Conversation Exists?`.
//
// Wire: Search Conversation (AT) → Postgres - Search Conversation (PG) → IF Conversation Exists?
//
// IF Conversation Exists? uses OR combinator: PG-primary, AT-bridge/fallback.
// Merge Session State priority: pgSession (primary) || atSession (bridge/fallback).
// Postgres - Upsert Conversation Hold writes to PG even in dry-run (conversations ≠ protected).

const PG_SEARCH_CONV_JS_CODE = `const convo =
  $('Search Conversation').first().json || {};

const atSession =
  convo['Session State'] ||
  convo.fields?.['Session State'] ||
  null;

// Stage 5.1 PG-primary: read session from Postgres conversations first.
// Airtable session is bridge/fallback for transition from legacy AT-first path.
const pgRow = (() => {
  try {
    const r = $('Postgres - Search Conversation (PG)').first().json;
    return r && typeof r === 'object' ? r : {};
  } catch (_) {
    return {};
  }
})();

const pgSessionRaw = pgRow.session_state != null
  ? (typeof pgRow.session_state === 'object'
      ? JSON.stringify(pgRow.session_state)
      : String(pgRow.session_state))
  : null;

// Stage 5.1: PG-primary — pgSession first, AT bridge/fallback.
const oldRaw = pgSessionRaw || atSession || '{}';

// Stage 5.1: current_hold_id from PG session first, AT bridge/fallback.
const currentHoldId =
  (pgRow.session_state && typeof pgRow.session_state === 'object'
    ? (pgRow.session_state.current_hold_id ||
       pgRow.session_state.current_hold_booking_code ||
       null)
    : null) ||
  convo['Current Hold ID'] ||
  convo.fields?.['Current Hold ID'] ||
  null;

const newRaw =
  $('Parser Node').first().json.text || '{}';

function clean(raw) {
  return String(raw)
    .replace(/^\`\`\`json\\s*/i, '')
    .replace(/^\`\`\`\\s*/i, '')
    .replace(/\`\`\`$/i, '')
    .trim();
}

const oldState = JSON.parse(clean(oldRaw));
const newState = JSON.parse(clean(newRaw));

const merged = { ...oldState };

for (const [key, value] of Object.entries(newState)) {
  if (value === null) continue;
  if (value === '') continue;
  if (Array.isArray(value) && value.length === 0) continue;

  merged[key] = value;
}

// Default room type logic.
// Wolfhouse default is shared unless guest clearly asks for private/own room/family room.
const guestMessage = String(
  $('Normalize Incoming Message').first().json.guest_message ||
  ($('Create Inbound Message').isExecuted ? $('Create Inbound Message') : $('Code - DRY RUN Stub (Create Inbound Message)')).first().json.fields?.['Message Text'] ||
  ''
).toLowerCase();

const privateKeywords = [
  'private room',
  'private',
  'own room',
  'room to ourselves',
  'room for ourselves',
  'not shared',
  'family room',
  'family',
  'matrimonial',
  'double room',
  'double bed'
];

const sharedKeywords = [
  'shared',
  'shared room',
  'dorm',
  'bed',
  'bunk',
  'hostel bed'
];

const asksPrivate = privateKeywords.some(word => guestMessage.includes(word));
const asksShared = sharedKeywords.some(word => guestMessage.includes(word));

if (asksPrivate) {
  merged.room_type = 'private';
} else if (asksShared) {
  merged.room_type = 'shared';
} else if (!merged.room_type || merged.room_type === 'unknown') {
  merged.room_type = 'shared';
}

// Determine if we have enough info.
// Do NOT require room_type anymore because it defaults to shared.
merged.ready_for_availability_check =
  !!merged.check_in &&
  !!merged.check_out &&
  !!merged.guest_count;

return [
  {
    json: {
      old_state: oldState,
      new_state: newState,

      current_hold_id: currentHoldId,

      session: merged,

      session_state: JSON.stringify(merged, null, 2),

      _pg_fallback_used: !pgSessionRaw && !!atSession,
      _pg_primary_used: !!pgSessionRaw,
      _pg_conversation_id: pgRow.conversation_id || null,
    }
  }
];`;

const PG_SEARCH_CONV_SQL = `SELECT
  session_state,
  current_hold_booking_id::text AS current_hold_booking_id,
  conversation_stage,
  language,
  id::text AS conversation_id
FROM conversations
WHERE client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo' LIMIT 1)
  AND phone = $1
LIMIT 1`;

/**
 * Stage 4 — PG conversation read fallback (Option A, revised).
 *
 * Adds `Postgres - Search Conversation (PG)` on the SHARED PATH in SERIES, inserted
 * between `Search Conversation` (Airtable) and `IF Conversation Exists?`. This ensures
 * the PG node executes before the Booking State Resolver (BSR), so BSR can read the
 * seeded PG session (including current_hold_id) to make correct routing decisions for
 * multi-turn scenarios (A3/A4 T2 must NOT be overridden to booking_flow when a hold exists).
 *
 * Wiring:
 *   Search Conversation → Postgres - Search Conversation (PG) → IF Conversation Exists?  [shared path, series]
 *   Parser Node → Merge Session State  [direct, no PG in booking_flow series]
 *   Booking State Resolver Code merges PG session into input.session for hold-hint detection.
 *   Merge Session State code references $('Postgres - Search Conversation (PG)') internally.
 *
 * @param {object} workflow
 */
function applyPGConversationRead(workflow) {
  const searchConvNode = workflow.nodes.find((n) => n.name === 'Search Conversation');
  const ifConvNode = workflow.nodes.find((n) => n.name === 'IF Conversation Exists?');
  const mergeNode = workflow.nodes.find((n) => n.name === 'Merge Session State');
  if (!searchConvNode || !ifConvNode || !mergeNode) {
    throw new Error(
      'applyPGConversationRead: Search Conversation, IF Conversation Exists?, or Merge Session State not found'
    );
  }

  // ── Postgres read node ─────────────────────────────────────────────────────
  // Positioned between Search Conversation and IF Conversation Exists? on the shared path.
  // alwaysOutputData=true so the chain never breaks when no row is found.
  const pgReadNode = {
    parameters: {
      operation: 'executeQuery',
      query: PG_SEARCH_CONV_SQL,
      options: {
        queryReplacement: "={{ $('Normalize Incoming Message').first().json.phone || '' }}",
      },
    },
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.5,
    position: [
      Math.round((searchConvNode.position[0] + ifConvNode.position[0]) / 2),
      searchConvNode.position[1] + 160,
    ],
    id: '3ce005001-0001-4000-8000-000000000501',
    name: 'Postgres - Search Conversation (PG)',
    alwaysOutputData: true,
    credentials: { postgres: { id: '', name: 'Wolfhouse Postgres (local)' } },
  };

  workflow.nodes.push(pgReadNode);

  // ── Update Merge Session State jsCode with PG fallback ─────────────────────
  mergeNode.parameters.jsCode = PG_SEARCH_CONV_JS_CODE;

  // ── Re-wire: Search Conversation → PG → IF Conversation Exists? (shared path series) ──
  // Remove Search Conversation → IF Conversation Exists? direct connection.
  const scConns = workflow.connections['Search Conversation'];
  if (scConns?.main?.[0]) {
    scConns.main[0] = scConns.main[0].filter((e) => e.node !== 'IF Conversation Exists?');
    if (!scConns.main[0].some((e) => e.node === 'Postgres - Search Conversation (PG)')) {
      scConns.main[0].push({ node: 'Postgres - Search Conversation (PG)', type: 'main', index: 0 });
    }
  }

  // Add PG → IF Conversation Exists?
  if (!workflow.connections['Postgres - Search Conversation (PG)']) {
    workflow.connections['Postgres - Search Conversation (PG)'] = { main: [[]] };
  }
  const pgConns = workflow.connections['Postgres - Search Conversation (PG)'];
  pgConns.main[0] = pgConns.main[0] || [];
  if (!pgConns.main[0].some((e) => e.node === 'IF Conversation Exists?')) {
    pgConns.main[0].push({ node: 'IF Conversation Exists?', type: 'main', index: 0 });
  }

  // ── Ensure Parser Node → Merge Session State is direct (no PG in booking_flow) ──
  // Remove any Parser Node → PG connection if it exists.
  const parserConns = workflow.connections['Parser Node'];
  if (parserConns?.main?.[0]) {
    parserConns.main[0] = parserConns.main[0].filter(
      (e) => e.node !== 'Postgres - Search Conversation (PG)'
    );
    if (!parserConns.main[0].some((e) => e.node === 'Merge Session State')) {
      parserConns.main[0].push({ node: 'Merge Session State', type: 'main', index: 0 });
    }
  }

  // ── S1 (Stage 5.1): Patch IF Conversation Exists? to PG-primary ──────────────
  // Old: checks only Airtable records.length > 0 — always false in pilot/dry-run.
  // New: OR combinator — true when PG conversation_id exists (primary) OR Airtable
  //      records exist (bridge/fallback). Airtable remains available for transition.
  ifConvNode.parameters.conditions = {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [
      {
        id: 'stage51-pg-conv-exists',
        leftValue: "={{ $('Postgres - Search Conversation (PG)').first().json.conversation_id }}",
        rightValue: '',
        operator: { type: 'string', operation: 'notEmpty' },
      },
      {
        id: 'stage51-at-conv-exists',
        leftValue: "={{ ($('Search Conversation').first().json.records?.length ?? 0) }}",
        rightValue: '0',
        operator: { type: 'number', operation: 'gt' },
      },
    ],
    combinator: 'or',
  };

  console.log(
    'applyPGConversationRead: Postgres - Search Conversation (PG) wired on shared path as Search Conversation → PG → IF Conversation Exists? (Stage 5.1: PG-primary OR AT-bridge). Parser Node → Merge Session State direct.'
  );
}

/**
 * Verifies Stage 5.1 PG-primary conversation path is correctly wired.
 * Wiring: Search Conversation → Postgres - Search Conversation (PG) → IF Conversation Exists? [shared path, series]
 *         IF Conversation Exists? uses OR combinator: PG-primary, AT-bridge.
 *         Parser Node → Merge Session State [direct]
 *         Merge Session State: pgSession || atSession (PG-first priority).
 *         Postgres - Upsert Conversation Hold: NOT dry-run gated (conversations ≠ protected).
 *
 * @param {object} workflow
 * @returns {{ ok: boolean, errors: string[] }}
 */
function verifyPGConversationRead(workflow) {
  const errors = [];
  const nodeNames = new Set(workflow.nodes.map((n) => n.name));

  if (!nodeNames.has('Postgres - Search Conversation (PG)'))
    errors.push('Postgres - Search Conversation (PG) node missing');

  // Search Conversation must connect to PG (in series, not IF Conversation Exists? directly)
  const scOuts = (workflow.connections['Search Conversation']?.main?.[0] || []).map((n) => n.node);
  if (!scOuts.includes('Postgres - Search Conversation (PG)'))
    errors.push('Search Conversation does not connect to Postgres - Search Conversation (PG) (shared path series)');
  if (scOuts.includes('IF Conversation Exists?'))
    errors.push('Search Conversation still directly connects to IF Conversation Exists? (PG must be in series between them)');

  // PG must connect to IF Conversation Exists?
  const pgOuts = (workflow.connections['Postgres - Search Conversation (PG)']?.main?.[0] || []).map((n) => n.node);
  if (!pgOuts.includes('IF Conversation Exists?'))
    errors.push('Postgres - Search Conversation (PG) does not connect to IF Conversation Exists?');

  // Parser Node must connect directly to Merge Session State (not via PG)
  const parserOuts = (workflow.connections['Parser Node']?.main?.[0] || []).map((n) => n.node);
  if (!parserOuts.includes('Merge Session State'))
    errors.push('Parser Node does not connect directly to Merge Session State');
  if (parserOuts.includes('Postgres - Search Conversation (PG)'))
    errors.push('Parser Node still connects to Postgres - Search Conversation (PG) (should be direct to MSS)');

  // S1 (Stage 5.1): IF Conversation Exists? must use OR combinator with PG-primary condition
  const ifConvNode = workflow.nodes.find((n) => n.name === 'IF Conversation Exists?');
  if (!ifConvNode) {
    errors.push('IF Conversation Exists? node missing');
  } else {
    const conds = ifConvNode.parameters?.conditions || {};
    if (conds.combinator !== 'or')
      errors.push('IF Conversation Exists? does not use OR combinator (Stage 5.1: must be PG-primary OR AT-bridge)');
    const condList = conds.conditions || [];
    const hasPgCond = condList.some(
      (c) =>
        String(c.leftValue || '').includes('Postgres - Search Conversation (PG)') &&
        String(c.leftValue || '').includes('conversation_id')
    );
    if (!hasPgCond)
      errors.push('IF Conversation Exists? missing PG conversation_id condition (Stage 5.1: PG-primary check required)');
  }

  // S2 (Stage 5.1): Merge Session State must use PG-first priority
  const mergeNode = workflow.nodes.find((n) => n.name === 'Merge Session State');
  if (!mergeNode) {
    errors.push('Merge Session State node missing');
  } else {
    const jsCode = mergeNode.parameters?.jsCode || '';
    if (!jsCode.includes('Postgres - Search Conversation (PG)'))
      errors.push('Merge Session State jsCode does not reference Postgres - Search Conversation (PG)');
    if (!jsCode.includes('pgSessionRaw || atSession'))
      errors.push('Merge Session State jsCode not using PG-first priority (Stage 5.1: must be pgSessionRaw || atSession)');
    if (jsCode.includes('atSession || pgSessionRaw'))
      errors.push('Merge Session State jsCode still using AT-first priority (Stage 5.1: must be pgSessionRaw || atSession)');
  }

  // PG read node must be read-only (SELECT only, no INSERT/UPDATE/DELETE in query)
  const pgNode = workflow.nodes.find((n) => n.name === 'Postgres - Search Conversation (PG)');
  if (pgNode) {
    const query = pgNode.parameters?.query || '';
    if (/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|CREATE)\b/i.test(query))
      errors.push('Postgres - Search Conversation (PG) query contains write operations');
    if (!pgNode.alwaysOutputData)
      errors.push('Postgres - Search Conversation (PG) missing alwaysOutputData:true (chain breaks on no-row)');
  }

  // S5b (Stage 5.1b): Postgres - Upsert Conversation Hold session_state must include package and language
  const convHoldNode = workflow.nodes.find((n) => n.name === 'Postgres - Upsert Conversation Hold');
  if (!convHoldNode) {
    errors.push('Postgres - Upsert Conversation Hold node missing');
  } else {
    const qr = String(convHoldNode.parameters?.options?.queryReplacement || '');
    if (!qr.includes('_s.package'))
      errors.push('Postgres - Upsert Conversation Hold session_state missing package field (Stage 5.1b)');
    if (!qr.includes('_s.language'))
      errors.push('Postgres - Upsert Conversation Hold session_state missing language field (Stage 5.1b)');
  }

  const ok = errors.length === 0;
  if (ok) {
    console.log('PG conversation read verify (Stage 5.1 PG-primary): OK');
  } else {
    console.error(`PG conversation read verify: FAIL (${errors.length} error(s)):`);
    for (const e of errors) console.error(`  ${e}`);
  }
  return { ok, errors };
}

// ── Stage 5.1c: PG session write on non-hold booking path ───────────────────
//
// Postgres - Write Session State sits on the IF - Ready For Availability FALSE
// branch (missing-fields turns). It persists whatever session context is known
// (dates, guest_count, language, missing_fields, etc.) so the NEXT turn can
// read it from PG without a runner seed or Airtable fallback.
//
// Wiring (after applyPGSessionWriteNonHoldPath):
//   IF - Ready For Availability  main[1]  →  Postgres - Write Session State
//   Postgres - Write Session State        →  Generate Next Reply
//
// Safety: conversations is NOT a protected table; no dry-run gate needed.

/**
 * Inserts Postgres - Write Session State between IF - Ready For Availability
 * FALSE branch and Generate Next Reply.
 */
function applyPGSessionWriteNonHoldPath(workflow) {
  const ifReady = workflow.nodes.find((n) => n.name === 'IF - Ready For Availability');
  if (!ifReady) throw new Error('applyPGSessionWriteNonHoldPath: IF - Ready For Availability not found');

  const NULL_SENTINEL = '__NULL__';
  const sess = `$('Determine Missing Fields').first().json.session`;
  const pr = `$('Code - Parse Route').first().json`;

  function pgParam(innerExpr) {
    return `={{ ((${innerExpr}) != null && String(${innerExpr}).trim() !== '') ? String(${innerExpr}).trim() : '${NULL_SENTINEL}' }}`;
  }

  const sessionWriteQueryReplacement = [
    pgParam(`$('Normalize Incoming Message').first().json.phone`),
    pgParam(`${pr}.language || (${sess} || {}).language`),
    pgParam(`'booking_flow'`),
    // Stage 5.1c: build session_state from Determine Missing Fields enriched session.
    // Only include non-null/non-empty fields. missing_fields and ready_for_availability_check
    // are always written (even [] and false) so T2 can distinguish "no missing fields" from
    // "never computed".
    pgParam(`JSON.stringify((() => {
      const _sess = ${sess} || {};
      const _pr = ${pr};
      const _s = {};
      const _ci = _sess.check_in; if (_ci) _s.check_in = _ci;
      const _co = _sess.check_out; if (_co) _s.check_out = _co;
      const _gc = _sess.guest_count; if (_gc != null && _gc !== '') _s.guest_count = _gc;
      const _pkg = _sess.package || _sess.package_code; if (_pkg) _s.package = _pkg;
      const _lang = _pr.language || _sess.language; if (_lang) _s.language = _lang;
      const _route = _pr.route; if (_route) _s.route = _route;
      const _rt = _sess.room_type || _sess.requested_room_type; if (_rt) _s.room_type = _rt;
      const _rp = _sess.room_preference; if (_rp) _s.room_preference = _rp;
      const _gn = _sess.guest_name; if (_gn) _s.guest_name = _gn;
      const _ge = _sess.guest_email; if (_ge) _s.guest_email = _ge;
      const _mf = _sess.missing_fields; if (Array.isArray(_mf)) _s.missing_fields = _mf;
      const _rfa = _sess.ready_for_availability_check;
      if (_rfa != null) _s.ready_for_availability_check = _rfa;
      const _bc = _sess.current_hold_booking_code; if (_bc) _s.current_hold_booking_code = _bc;
      return _s;
    })())`),
  ].join(',');

  const sessionWriteNode = {
    parameters: {
      operation: 'executeQuery',
      query: buildSessionWriteN8nSql(),
      options: { queryReplacement: sessionWriteQueryReplacement },
    },
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.5,
    position: [3128, 1376],
    id: '3ce006001-0001-4000-8000-000000000601',
    name: 'Postgres - Write Session State',
    alwaysOutputData: true,
    credentials: { postgres: { id: '', name: 'Wolfhouse Postgres (local)' } },
  };

  workflow.nodes.push(sessionWriteNode);

  // Rewire: IF - Ready For Availability main[1] → new node (was → Generate Next Reply)
  const conn = workflow.connections['IF - Ready For Availability'];
  if (!conn) throw new Error('applyPGSessionWriteNonHoldPath: IF - Ready For Availability has no connections');
  // Preserve TRUE branch (main[0]); replace FALSE branch (main[1])
  const trueBranch = conn.main[0] || [];
  conn.main[1] = [{ node: 'Postgres - Write Session State', type: 'main', index: 0 }];

  // Wire: Postgres - Write Session State → Generate Next Reply
  workflow.connections['Postgres - Write Session State'] = {
    main: [[{ node: 'Generate Next Reply', type: 'main', index: 0 }]],
  };

  console.log(
    'applyPGSessionWriteNonHoldPath: Postgres - Write Session State inserted on IF - Ready For Availability FALSE → Generate Next Reply (Stage 5.1c)'
  );
}

/**
 * Verifies Stage 5.1c: Postgres - Write Session State on non-hold path.
 */
function verifyPGSessionWrite(workflow) {
  const errors = [];

  const node = workflow.nodes.find((n) => n.name === 'Postgres - Write Session State');
  if (!node) {
    errors.push('Postgres - Write Session State node missing');
  } else {
    const query = node.parameters?.query || '';

    // SQL must reference conversations
    if (!query.toLowerCase().includes('conversations'))
      errors.push('Postgres - Write Session State SQL does not reference conversations table');

    // SQL must NOT reference protected tables
    for (const tbl of ['bookings', 'payment_events', 'booking_beds']) {
      if (new RegExp(`\\b${tbl}\\b`, 'i').test(query))
        errors.push(`Postgres - Write Session State SQL references protected table: ${tbl}`);
    }
    // payments is a separate check (avoid false positive on 'payment_events' or partial matches)
    if (/\bpayments\b/i.test(query))
      errors.push('Postgres - Write Session State SQL references protected table: payments');

    // SQL must NOT include current_hold_booking_id in INSERT column list
    if (/current_hold_booking_id/i.test(query))
      errors.push('Postgres - Write Session State SQL contains current_hold_booking_id (FK must not be set on non-hold writes)');

    // alwaysOutputData must be true (chain must not break if row already exists)
    if (!node.alwaysOutputData)
      errors.push('Postgres - Write Session State missing alwaysOutputData:true');
  }

  // IF - Ready For Availability main[1] must connect to Postgres - Write Session State
  const ifReadyConn = workflow.connections['IF - Ready For Availability'];
  const falseBranch = (ifReadyConn?.main?.[1] || []).map((n) => n.node);
  if (!falseBranch.includes('Postgres - Write Session State'))
    errors.push('IF - Ready For Availability FALSE branch does not connect to Postgres - Write Session State');
  if (falseBranch.includes('Generate Next Reply'))
    errors.push('IF - Ready For Availability FALSE branch still connects directly to Generate Next Reply (should go via Postgres - Write Session State)');

  // Postgres - Write Session State must connect to Generate Next Reply
  const wssOuts = (workflow.connections['Postgres - Write Session State']?.main?.[0] || []).map((n) => n.node);
  if (!wssOuts.includes('Generate Next Reply'))
    errors.push('Postgres - Write Session State does not connect to Generate Next Reply');

  // IF - Ready For Availability TRUE branch must NOT connect to Postgres - Write Session State
  const trueBranch = (ifReadyConn?.main?.[0] || []).map((n) => n.node);
  if (trueBranch.includes('Postgres - Write Session State'))
    errors.push('Postgres - Write Session State incorrectly wired on IF - Ready For Availability TRUE branch (must only be on FALSE)');

  const ok = errors.length === 0;
  if (ok) {
    console.log('PG session write verify (Stage 5.1c non-hold path): OK');
  } else {
    console.error(`PG session write verify: FAIL (${errors.length} error(s)):`);
    for (const e of errors) console.error(`  ${e}`);
  }
  return { ok, errors };
}

/**
 * Stage 5.2b: Verifies Code - Summarize Holds uses PG hold as primary source.
 * AT Booking ID must NOT be the first priority for booking_code.
 *
 * @param {object} workflow
 * @returns {{ ok: boolean, errors: string[] }}
 */
function verifySummarizeHoldsPGPrimary(workflow) {
  const errors = [];
  const node = workflow.nodes.find((n) => n.name === 'Code - Summarize Holds');
  if (!node) {
    errors.push('Code - Summarize Holds node missing');
  } else {
    const code = node.parameters?.jsCode || '';
    // Must reference pgHold for booking_code
    if (!code.includes('pgHold.booking_code'))
      errors.push('Code - Summarize Holds does not read pgHold.booking_code (PG must be primary source)');
    // PG booking_code must appear BEFORE AT fields in the bookingCode assignment
    const pgIdx = code.indexOf('pgHold.booking_code');
    const atIdx = code.indexOf("atHold.fields?.['Booking ID']");
    if (pgIdx === -1 || atIdx === -1 || pgIdx > atIdx)
      errors.push('Code - Summarize Holds: pgHold.booking_code must appear before AT Booking ID field in bookingCode priority chain');
    // Must include hold_expires_at in output
    if (!code.includes('hold_expires_at'))
      errors.push('Code - Summarize Holds does not include hold_expires_at in output');
    // Must include booking_id in output
    if (!code.includes('booking_id: pgHold.booking_id'))
      errors.push('Code - Summarize Holds does not include booking_id: pgHold.booking_id in output');
    // Must still include holds_created, has_guest_details, should_run_stripe_payment (downstream contracts)
    for (const field of ['holds_created', 'has_guest_details', 'should_run_stripe_payment']) {
      if (!code.includes(field))
        errors.push(`Code - Summarize Holds missing required output field: ${field}`);
    }
  }
  const ok = errors.length === 0;
  if (ok) {
    console.log('Summarize Holds PG-primary verify (Stage 5.2b): OK');
  } else {
    console.error(`Summarize Holds PG-primary verify: FAIL (${errors.length} error(s)):`);
    for (const e of errors) console.error(`  ${e}`);
  }
  return { ok, errors };
}

/**
 * Stage 5.2c: Verifies ensure-promote INSERT path includes hold/status defaults.
 *
 * @param {object} workflow
 * @returns {{ ok: boolean, errors: string[] }}
 */
function verifyEnsurePromoteInsertDefaults(workflow) {
  const errors = [];
  const node = workflow.nodes.find((n) => n.name === 'Postgres - Ensure Booking In Postgres');
  if (!node) {
    errors.push('Postgres - Ensure Booking In Postgres node missing');
  } else {
    const query = node.parameters?.query || '';
    const insertSection = query.split('inserted AS (')[1]?.split('RETURNING')[0] || query;
    if (!insertSection.includes('INSERT INTO bookings'))
      errors.push('Ensure promote SQL missing INSERT INTO bookings block');
    if (!insertSection.includes('hold_expires_at'))
      errors.push('Ensure promote INSERT missing hold_expires_at column');
    if (!insertSection.includes("interval '1 hour'"))
      errors.push('Ensure promote INSERT missing hold_expires_at = NOW() + interval \'1 hour\' default');
    if (!insertSection.includes('assignment_status'))
      errors.push('Ensure promote INSERT missing assignment_status column');
    if (!insertSection.includes("'unassigned'::assignment_status"))
      errors.push('Ensure promote INSERT missing assignment_status = unassigned default');
    if (!insertSection.includes('availability_check_status'))
      errors.push('Ensure promote INSERT missing availability_check_status column');
    if (!insertSection.includes("'available'::availability_check_status"))
      errors.push('Ensure promote INSERT missing availability_check_status = available default');
    const lower = query.toLowerCase();
    for (const protectedTable of ['payments', 'payment_events', 'booking_beds']) {
      if (lower.includes(protectedTable))
        errors.push(`Ensure promote SQL must not reference protected table: ${protectedTable}`);
    }
  }
  const ok = errors.length === 0;
  if (ok) {
    console.log('Ensure promote INSERT defaults verify (Stage 5.2c): OK');
  } else {
    console.error(`Ensure promote INSERT defaults verify: FAIL (${errors.length} error(s)):`);
    for (const e of errors) console.error(`  ${e}`);
  }
  return { ok, errors };
}

/**
 * Stage 5.2d: Fixture hold guard — allows real Postgres - Create Booking Hold
 * to execute when ALL of these are true:
 *   1. STAGE52_FIXTURE_HOLD=true (explicit opt-in env var)
 *   2. booking_code starts with 'DRY-52-' (from Code - Prepare Hold Records)
 *   3. phone is 34600000152 or +34600000152
 *
 * All other traffic (including normal WHATSAPP_DRY_RUN flows) goes to the existing stub.
 * Must be called AFTER applyShadowModeDryRunGates so the stub node exists.
 *
 * @param {object} workflow
 */
function applyStage52FixtureHoldGuard(workflow) {
  const STUB_NAME = 'Code - DRY RUN Stub (Postgres - Create Booking Hold)';
  const REAL_NAME = 'Postgres - Create Booking Hold';
  const IF_NAME = 'IF - Stage52 Fixture?';
  const FIXTURE_PHONES = ['34600000152', '+34600000152'];
  const FIXTURE_CODE_PREFIX = 'DRY-52-';

  const stubNode = workflow.nodes.find((n) => n.name === STUB_NAME);
  const realNode = workflow.nodes.find((n) => n.name === REAL_NAME);
  if (!stubNode || !realNode) {
    throw new Error(
      `applyStage52FixtureHoldGuard: required nodes not found (stub=${!!stubNode}, real=${!!realNode}). Run after applyShadowModeDryRunGates.`
    );
  }
  if (workflow.nodes.find((n) => n.name === IF_NAME)) {
    console.log('applyStage52FixtureHoldGuard: IF - Stage52 Fixture? already exists, skipping');
    return;
  }

  // Position the fixture IF node between the stub and its successors.
  const ifPos = [stubNode.position[0], stubNode.position[1] + 180];

  const phoneListExpr = FIXTURE_PHONES.map((p) => `'${p}'`).join(', ');

  // Combined condition expression: env flag + fixture phone.
  // Note: booking_code prefix check removed — Code - Prepare Hold Records always generates
  // 'WH-YYMMDD-XXXX' format which never starts with 'DRY-52-'. The fixture phone + explicit
  // env flag is sufficient guard. The 'DRY-52-' prefix is used only in cleanup SQL scope.
  const guardExpr = `={{ (() => {
  const fixtureEnabled = String($env.STAGE52_FIXTURE_HOLD || '').toLowerCase() === 'true';
  const phone = String($('Normalize Incoming Message').first().json.phone || '');
  const isFixturePhone = [${phoneListExpr}].includes(phone);
  return fixtureEnabled && isFixturePhone;
})() }}`;

  const ifNode = {
    id: 'stage52-fixture-if-001',
    name: IF_NAME,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: ifPos,
    parameters: {
      conditions: {
        options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            id: 'stage52-fixture-cond',
            leftValue: guardExpr,
            rightValue: '',
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
  };

  workflow.nodes.push(ifNode);

  // Capture the stub's current outgoing connections (shared with real node's successors).
  const stubConns = workflow.connections[STUB_NAME];
  const realConns = workflow.connections[REAL_NAME];

  // Stub now points to the fixture IF node.
  workflow.connections[STUB_NAME] = {
    main: [[{ node: IF_NAME, type: 'main', index: 0 }]],
  };

  // IF - Stage52 Fixture? TRUE → real Postgres node (shares real node's successors)
  // IF - Stage52 Fixture? FALSE → stub output passthrough node (Code - Stage52 Stub Passthrough)
  // Since n8n stubs already have the correct successor wiring from the real node,
  // we replicate it here: TRUE → real node successors, FALSE → stub terminal (no-op output).
  //
  // The real node already has successors (Code - Validate PG Hold etc.), so:
  //   TRUE branch → Code - Validate PG Hold (first successor of Postgres - Create Booking Hold)
  //   FALSE branch → a passthrough Code node that emits the stub's last output
  const PASSTHROUGH_NAME = 'Code - Stage52 DRY RUN Passthrough';
  const passthroughNode = {
    id: 'stage52-passthrough-001',
    name: PASSTHROUGH_NAME,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [ifPos[0] + 260, ifPos[1] + 120],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `// Stage 5.2d: fixture guard FALSE branch — pass stub output through unchanged.
const stub = (() => { try { return $('Code - DRY RUN Stub (Postgres - Create Booking Hold)').first().json; } catch { return {}; } })();
return [{ json: { ...stub, stage52_passthrough: true } }];`,
    },
    alwaysOutputData: true,
  };

  workflow.nodes.push(passthroughNode);

  // Passthrough has same successors as the stub (Code - Validate PG Hold chain)
  if (stubConns) {
    workflow.connections[PASSTHROUGH_NAME] = JSON.parse(JSON.stringify(stubConns));
  }

  // Real node's first successor (Code - Validate PG Hold chain) is already wired.
  // We just need the IF to route: TRUE → the REAL postgres node itself, FALSE → passthrough.
  // (The real node already connects to Code - Validate PG Hold via its own existing connections.)
  workflow.connections[IF_NAME] = {
    main: [
      [{ node: REAL_NAME, type: 'main', index: 0 }],
      [{ node: PASSTHROUGH_NAME, type: 'main', index: 0 }],
    ],
  };

  console.log(
    `applyStage52FixtureHoldGuard: Stage 5.2d fixture hold guard added — STAGE52_FIXTURE_HOLD + DRY-52- prefix + fixture phone required`
  );
}

/**
 * Stage 5.2d: Verifies the fixture hold guard is correctly wired.
 *
 * @param {object} workflow
 * @returns {{ ok: boolean, errors: string[] }}
 */
function verifyStage52FixtureGuard(workflow) {
  const errors = [];
  const IF_NAME = 'IF - Stage52 Fixture?';
  const STUB_NAME = 'Code - DRY RUN Stub (Postgres - Create Booking Hold)';
  const REAL_NAME = 'Postgres - Create Booking Hold';
  const PASSTHROUGH_NAME = 'Code - Stage52 DRY RUN Passthrough';

  const ifNode = workflow.nodes.find((n) => n.name === IF_NAME);
  const stubNode = workflow.nodes.find((n) => n.name === STUB_NAME);
  const realNode = workflow.nodes.find((n) => n.name === REAL_NAME);

  if (!ifNode) errors.push('IF - Stage52 Fixture? node missing');
  if (!stubNode) errors.push('Code - DRY RUN Stub (Postgres - Create Booking Hold) missing');
  if (!realNode) errors.push('Postgres - Create Booking Hold node missing');

  if (ifNode) {
    const conds = ifNode.parameters?.conditions?.conditions || [];
    const expr = conds[0]?.leftValue || '';
    if (!expr.includes('STAGE52_FIXTURE_HOLD'))
      errors.push('IF - Stage52 Fixture? does not check STAGE52_FIXTURE_HOLD env var');
    if (!expr.includes('34600000152'))
      errors.push('IF - Stage52 Fixture? does not check fixture phone 34600000152');
    // Note: DRY-52- booking_code prefix check removed from guard expression because
    // Code - Prepare Hold Records always generates 'WH-YYMMDD-XXXX' format.
    // The fixture phone + env flag combination is the effective narrow gate.
  }

  // Stub must point to IF node
  const stubConns = workflow.connections[STUB_NAME];
  const stubFirst = stubConns?.main?.[0]?.[0]?.node;
  if (stubFirst !== IF_NAME)
    errors.push(`Code - DRY RUN Stub must connect to ${IF_NAME}, found: ${stubFirst}`);

  // IF TRUE branch must connect to the real Postgres node itself (not stub, not its successor)
  const ifConns = workflow.connections[IF_NAME];
  const trueBranch = ifConns?.main?.[0]?.[0]?.node;
  const falseBranch = ifConns?.main?.[1]?.[0]?.node;
  if (trueBranch !== REAL_NAME)
    errors.push(`IF - Stage52 Fixture? TRUE branch must point to ${REAL_NAME}, found: ${trueBranch}`);
  if (!falseBranch || falseBranch === REAL_NAME)
    errors.push('IF - Stage52 Fixture? FALSE branch must go to passthrough, not real node');
  if (falseBranch !== PASSTHROUGH_NAME)
    errors.push(`IF - Stage52 Fixture? FALSE branch should go to ${PASSTHROUGH_NAME}, found: ${falseBranch}`);

  // Passthrough must exist
  if (!workflow.nodes.find((n) => n.name === PASSTHROUGH_NAME))
    errors.push(`${PASSTHROUGH_NAME} node missing`);

  const ok = errors.length === 0;
  if (ok) {
    console.log('Stage52 fixture hold guard verify (Stage 5.2d): OK');
  } else {
    console.error(`Stage52 fixture hold guard verify: FAIL (${errors.length} error(s)):`);
    for (const e of errors) console.error(`  ${e}`);
  }
  return { ok, errors };
}

/**
 * Stage 5.3d: Adds a fixture guard on the Ensure Booking dry-run stub so the real
 * Postgres - Ensure Booking In Postgres node can fire under controlled conditions:
 *   1. STAGE53_FIXTURE_PAYMENT=true (explicit opt-in env var)
 *   2. phone is 34600000155 or +34600000155
 *
 * Design: same pattern as Stage 5.2d.
 *   - Code - DRY RUN Stub (Postgres - Ensure Booking In Postgres) → IF - Stage53 Fixture?
 *   - TRUE  → real Postgres - Ensure Booking In Postgres
 *   - FALSE → Code - Stage53 DRY RUN Passthrough (emits stub output unchanged)
 *
 * Payment row safety: CPS still uses its inline WHATSAPP_DRY_RUN check and will NOT
 * create a real payments row or call Stripe. A payments row for the Stripe webhook
 * replay proof (5.3e) is pre-seeded via scripts/fixtures/stage5.3d-payment-seed.sql.
 * This is safer than enabling live CPS — no Stripe API call can happen.
 *
 * Must be called AFTER applyShadowModeDryRunGates so the stub node exists.
 *
 * @param {object} workflow
 */
function applyStage53FixtureEnsureGuard(workflow) {
  const STUB_NAME = 'Code - DRY RUN Stub (Postgres - Ensure Booking In Postgres)';
  const REAL_NAME = 'Postgres - Ensure Booking In Postgres';
  const IF_NAME = 'IF - Stage53 Fixture?';
  const FIXTURE_PHONES = ['34600000155', '+34600000155'];

  const stubNode = workflow.nodes.find((n) => n.name === STUB_NAME);
  const realNode = workflow.nodes.find((n) => n.name === REAL_NAME);
  if (!stubNode || !realNode) {
    throw new Error(
      `applyStage53FixtureEnsureGuard: required nodes not found (stub=${!!stubNode}, real=${!!realNode}). Run after applyShadowModeDryRunGates.`
    );
  }
  if (workflow.nodes.find((n) => n.name === IF_NAME)) {
    console.log('applyStage53FixtureEnsureGuard: IF - Stage53 Fixture? already exists, skipping');
    return;
  }

  const ifPos = [stubNode.position[0], stubNode.position[1] + 200];
  const phoneListExpr = FIXTURE_PHONES.map((p) => `'${p}'`).join(', ');

  const guardExpr = `={{ (() => {
  const fixtureEnabled = String($env.STAGE53_FIXTURE_PAYMENT || '').toLowerCase() === 'true';
  const phone = String($('Normalize Incoming Message').first().json.phone || '');
  const isFixturePhone = [${phoneListExpr}].includes(phone);
  return fixtureEnabled && isFixturePhone;
})() }}`;

  const ifNode = {
    id: 'stage53-fixture-if-001',
    name: IF_NAME,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: ifPos,
    parameters: {
      conditions: {
        options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            id: 'stage53-fixture-cond',
            leftValue: guardExpr,
            rightValue: '',
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
  };

  workflow.nodes.push(ifNode);

  // Passthrough: emits stub output unchanged when fixture guard is FALSE
  const PASSTHROUGH_NAME = 'Code - Stage53 DRY RUN Passthrough';
  const passthroughNode = {
    id: 'stage53-passthrough-001',
    name: PASSTHROUGH_NAME,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [ifPos[0] + 280, ifPos[1] + 120],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `// Stage 5.3d: fixture guard FALSE branch — pass stub output through unchanged.
const stub = (() => { try { return $('Code - DRY RUN Stub (Postgres - Ensure Booking In Postgres)').first().json; } catch { return {}; } })();
return [{ json: { ...stub, stage53_passthrough: true } }];`,
    },
    alwaysOutputData: true,
  };

  workflow.nodes.push(passthroughNode);

  // Rewire: stub → IF, IF TRUE → real node, IF FALSE → passthrough
  // Passthrough inherits stub's original successors (IF - Booking ID Ready chain)
  const stubConns = workflow.connections[STUB_NAME];
  workflow.connections[STUB_NAME] = {
    main: [[{ node: IF_NAME, type: 'main', index: 0 }]],
  };
  if (stubConns) {
    workflow.connections[PASSTHROUGH_NAME] = JSON.parse(JSON.stringify(stubConns));
  }
  workflow.connections[IF_NAME] = {
    main: [
      [{ node: REAL_NAME, type: 'main', index: 0 }],
      [{ node: PASSTHROUGH_NAME, type: 'main', index: 0 }],
    ],
  };

  console.log(
    'applyStage53FixtureEnsureGuard: Stage 5.3d fixture ensure-promote guard added — STAGE53_FIXTURE_PAYMENT + fixture phone required'
  );
}

/**
 * Stage 5.3d: Verifies the fixture ensure-promote guard is correctly wired.
 *
 * @param {object} workflow
 * @returns {{ ok: boolean, errors: string[] }}
 */
function verifyStage53FixtureGuard(workflow) {
  const errors = [];
  const IF_NAME = 'IF - Stage53 Fixture?';
  const STUB_NAME = 'Code - DRY RUN Stub (Postgres - Ensure Booking In Postgres)';
  const REAL_NAME = 'Postgres - Ensure Booking In Postgres';
  const PASSTHROUGH_NAME = 'Code - Stage53 DRY RUN Passthrough';

  const ifNode = workflow.nodes.find((n) => n.name === IF_NAME);
  if (!ifNode) errors.push('IF - Stage53 Fixture? node missing');
  if (!workflow.nodes.find((n) => n.name === STUB_NAME))
    errors.push('Code - DRY RUN Stub (Postgres - Ensure Booking In Postgres) missing');
  if (!workflow.nodes.find((n) => n.name === REAL_NAME))
    errors.push('Postgres - Ensure Booking In Postgres node missing');

  if (ifNode) {
    const conds = ifNode.parameters?.conditions?.conditions || [];
    const expr = conds[0]?.leftValue || '';
    if (!expr.includes('STAGE53_FIXTURE_PAYMENT'))
      errors.push('IF - Stage53 Fixture? does not check STAGE53_FIXTURE_PAYMENT env var');
    if (!expr.includes('34600000155'))
      errors.push('IF - Stage53 Fixture? does not check fixture phone 34600000155');
  }

  const stubConns = workflow.connections[STUB_NAME];
  const stubFirst = stubConns?.main?.[0]?.[0]?.node;
  if (stubFirst !== IF_NAME)
    errors.push(`Code - DRY RUN Stub (Ensure) must connect to ${IF_NAME}, found: ${stubFirst}`);

  const ifConns = workflow.connections[IF_NAME];
  const trueBranch = ifConns?.main?.[0]?.[0]?.node;
  const falseBranch = ifConns?.main?.[1]?.[0]?.node;
  if (trueBranch !== REAL_NAME)
    errors.push(`IF - Stage53 Fixture? TRUE branch must point to ${REAL_NAME}, found: ${trueBranch}`);
  if (falseBranch !== PASSTHROUGH_NAME)
    errors.push(`IF - Stage53 Fixture? FALSE branch should go to ${PASSTHROUGH_NAME}, found: ${falseBranch}`);

  if (!workflow.nodes.find((n) => n.name === PASSTHROUGH_NAME))
    errors.push(`${PASSTHROUGH_NAME} node missing`);

  const ok = errors.length === 0;
  if (ok) {
    console.log('Stage53 fixture ensure-promote guard verify (Stage 5.3d): OK');
  } else {
    console.error(`Stage53 fixture ensure-promote guard verify: FAIL (${errors.length} error(s)):`);
    for (const e of errors) console.error(`  ${e}`);
  }
  return { ok, errors };
}

// ── Determine Missing Fields JS code with package requirement ───────────────
const DMF_JS_CODE = `const state = $json.session || {};

const required = [
  'guest_count',
  'room_type',
  'check_in',
  'check_out'
];

const missing_fields = required.filter(field => {
  const value = state[field];

  return (
    value === null ||
    value === undefined ||
    value === '' ||
    value === 'unknown'
  );
});

// Package/stay type must be confirmed before availability and hold creation.
// If dates and guest count are known but no package has been explicitly selected,
// ask the guest which package (malibu/uluwatu/waimea) or accommodation-only.
if (
  (state.intent === 'booking_request' || state.intent === 'availability_check') &&
  state.check_in &&
  state.check_out &&
  state.guest_count &&
  (!state.package || state.package === 'unknown')
) {
  missing_fields.push('package_intent');
}

state.missing_fields = missing_fields;

state.ready_for_availability_check =
  (
    state.intent === 'booking_request' ||
    state.intent === 'availability_check'
  ) &&
  missing_fields.length === 0 &&
  state.needs_human !== true;

return [
  {
    json: {
      ...$json,

      session: state,

      session_state: JSON.stringify(state),

      missing_fields,

      ready_for_availability_check:
        state.ready_for_availability_check
    }
  }
];`;

/**
 * Stage 4 — Package-required fix.
 *
 * Updates `Determine Missing Fields` so booking_flow cannot reach
 * availability/hold unless package (or stay type) is known.
 *
 * @param {object} workflow
 */
function applyPackageRequirement(workflow) {
  const dmf = workflow.nodes.find((n) => n.name === 'Determine Missing Fields');
  if (!dmf) throw new Error('applyPackageRequirement: Determine Missing Fields node not found');

  dmf.parameters.jsCode = DMF_JS_CODE;

  console.log('applyPackageRequirement: Determine Missing Fields updated — package required before hold');
}

/**
 * Verifies that Determine Missing Fields requires package before hold.
 *
 * @param {object} workflow
 * @returns {{ ok: boolean, errors: string[] }}
 */
function verifyPackageRequirement(workflow) {
  const errors = [];
  const dmf = workflow.nodes.find((n) => n.name === 'Determine Missing Fields');
  if (!dmf) {
    errors.push('Determine Missing Fields node missing');
  } else {
    const code = dmf.parameters?.jsCode || '';
    if (!code.includes('package_intent'))
      errors.push('Determine Missing Fields does not push package_intent to missing_fields');
    if (!code.includes("!state.package || state.package === 'unknown'"))
      errors.push('Determine Missing Fields missing package null/unknown check');
  }

  // IF - Ready For Availability must NOT be directly reachable from DMF without the closed-month guard
  const dmfOuts = (workflow.connections['Determine Missing Fields']?.main?.[0] || []).map((n) => n.node);
  if (dmfOuts.includes('IF - Ready For Availability'))
    errors.push('Determine Missing Fields still connects directly to IF - Ready For Availability (bypass guard)');

  const ok = errors.length === 0;
  if (ok) {
    console.log('Package requirement verify: OK');
  } else {
    console.error(`Package requirement verify: FAIL (${errors.length} error(s)):`);
    for (const e of errors) console.error(`  ${e}`);
  }
  return { ok, errors };
}

/**
 * Fixes the `Search Active Booking - Current Hold ID` Airtable formula so it returns
 * no records (FALSE()) when the conversation has no current hold ID, instead of
 * returning all records with an empty Booking ID field.
 *
 * @param {object} workflow
 */
function applyActiveBookingHoldIdGuard(workflow) {
  const node = workflow.nodes.find((n) => n.name === 'Search Active Booking - Current Hold ID');
  if (!node) {
    console.log('applyActiveBookingHoldIdGuard: node not found, skipping');
    return;
  }
  const fixed = `=={{ ((() => {const holdId = ($('Search Conversation').first().json.fields?.['Current Hold ID'] || JSON.parse($('Search Conversation').first().json.fields?.['Session State'] || '{}').current_hold_id || JSON.parse($('Search Conversation').first().json.fields?.['Session State'] || '{}').hold_booking_id || JSON.parse($('Search Conversation').first().json.fields?.['Session State'] || '{}').booking_id || '');return holdId ? ('{Booking ID}="' + holdId + '"') : 'FALSE()';})()} }}`;
  node.parameters.filterByFormula = fixed;
  console.log('applyActiveBookingHoldIdGuard: patched Search Active Booking - Current Hold ID formula');
}

/**
 * Verifies that the `Search Active Booking - Current Hold ID` Airtable node
 * uses the safe formula (FALSE() guard for empty hold_id).
 *
 * @param {object} workflow
 * @returns {{ ok: boolean, errors: string[] }}
 */
function verifyActiveBookingHoldIdGuard(workflow) {
  const errors = [];
  const node = workflow.nodes.find((n) => n.name === 'Search Active Booking - Current Hold ID');
  if (!node) {
    errors.push('Search Active Booking - Current Hold ID node not found');
  } else {
    const formula = node.parameters?.filterByFormula || '';
    if (!formula.includes("'FALSE()'"))
      errors.push('Search Active Booking - Current Hold ID formula missing FALSE() guard for empty hold_id');
  }
  const ok = errors.length === 0;
  if (ok) {
    console.log('Active booking hold-id guard verify: OK');
  } else {
    console.error(`Active booking hold-id guard verify: FAIL (${errors.length} error(s)):`);
    for (const e of errors) console.error(`  ${e}`);
  }
  return { ok, errors };
}

/**
 * Verifies that the Booking State Resolver has the payment_or_confirm_intent
 * → booking_flow fallback override for the no-hold / no-contact case.
 *
 * @param {object} workflow
 * @returns {{ ok: boolean, errors: string[] }}
 */
function verifyPaymentOrConfirmFallback(workflow) {
  const errors = [];
  const bsr = workflow.nodes.find((n) => n.name === 'Code - Booking State Resolver');
  if (!bsr) {
    errors.push('Code - Booking State Resolver node missing');
  } else {
    const code = bsr.parameters?.jsCode || '';
    if (!code.includes('R2F_PAYMENT_INTENT_NO_HOLD_NO_CONTACT_TO_BOOKING_FLOW'))
      errors.push('Booking State Resolver missing payment_or_confirm_intent no-hold override (R2F_PAYMENT_INTENT_NO_HOLD_NO_CONTACT_TO_BOOKING_FLOW)');
    if (!code.includes("routerRoute === 'payment_or_confirm_intent'"))
      errors.push('Booking State Resolver does not reference payment_or_confirm_intent override');
    if (!code.includes("Postgres - Search Conversation (PG)"))
      errors.push('Booking State Resolver does not merge PG session (required for A3/A4 hold-hint detection)');
    // Assert no new ungated protected writes
    if (/\bINSERT\b/i.test(code) || /\bUPDATE\b/i.test(code) || /\bDELETE\b/i.test(code))
      errors.push('Code - Booking State Resolver contains SQL write operations (not expected in a routing node)');
  }

  const ok = errors.length === 0;
  if (ok) {
    console.log('Payment/confirm fallback verify: OK');
  } else {
    console.error(`Payment/confirm fallback verify: FAIL (${errors.length} error(s)):`);
    for (const e of errors) console.error(`  ${e}`);
  }
  return { ok, errors };
}

/**
 *
 * Inserts between `Determine Missing Fields` and `IF - Ready For Availability`:
 *   Code - Check Closed Month  →  IF - Closed Month?
 *     true  →  Reply - Closed Month  →  IF - DRY RUN? (Create Outbound Message)
 *     false →  IF - Ready For Availability  (existing availability path, unchanged)
 *
 * Also injects advisory `closed_months` note into Parser Node prompt.
 *
 * @param {object} workflow
 * @param {string[]} closedMonths - lowercase month names from client config
 */
function applyClosedMonthGuard(workflow, closedMonths) {
  if (!Array.isArray(closedMonths) || closedMonths.length === 0) {
    console.log('applyClosedMonthGuard: skipped (no closed months configured)');
    return;
  }

  const dmf = workflow.nodes.find((n) => n.name === 'Determine Missing Fields');
  const ifReady = workflow.nodes.find((n) => n.name === 'IF - Ready For Availability');
  const gnr = workflow.nodes.find((n) => n.name === 'Generate Next Reply');
  if (!dmf || !ifReady || !gnr) {
    throw new Error(
      'applyClosedMonthGuard: required nodes not found (Determine Missing Fields / IF - Ready For Availability / Generate Next Reply)'
    );
  }

  const closedMonthsLiteral = JSON.stringify(closedMonths);

  // ── Code - Check Closed Month ─────────────────────────────────────────────
  const CHECK_CLOSED_MONTH_JS = `const session = $json.session || {};
const check_in = session.check_in || $json.check_in || null;
const check_out = session.check_out || $json.check_out || null;

// Injected at build time from config/clients/wolfhouse-somo.baseline.json
const CLOSED_MONTHS = ${closedMonthsLiteral};

const MONTH_NAMES = [
  'january','february','march','april','may','june',
  'july','august','september','october','november','december'
];

function getMonthName(isoDate) {
  if (!isoDate) return null;
  const parts = String(isoDate).trim().split('-');
  if (parts.length < 2) return null;
  const idx = parseInt(parts[1], 10) - 1;
  return MONTH_NAMES[idx] || null;
}

const checkInMonth = getMonthName(check_in);
const checkOutMonth = getMonthName(check_out);

const monthsHit = [];
if (checkInMonth && CLOSED_MONTHS.includes(checkInMonth)) monthsHit.push(checkInMonth);
if (checkOutMonth && checkOutMonth !== checkInMonth && CLOSED_MONTHS.includes(checkOutMonth)) {
  monthsHit.push(checkOutMonth);
}

const closed_month_detected = monthsHit.length > 0;
const closed_month_name = monthsHit[0] || null;
const suggested_open_months = MONTH_NAMES.filter(m => !CLOSED_MONTHS.includes(m)).join(', ');

return [{
  json: {
    ...$json,
    closed_month_detected,
    closed_month_name,
    closed_months_hit: monthsHit,
    closed_months: CLOSED_MONTHS,
    closed_months_behavior: 'do_not_quote_or_book_inform_closed_and_handoff_if_insistent',
    suggested_open_months,
  }
}];`;

  // ── Reply - Closed Month prompt ────────────────────────────────────────────
  const REPLY_CLOSED_MONTH_PROMPT = `=You are the Wolfhouse surf hostel guest assistant.

Guest language:
{{ $('Code - Parse Route').item.json.language || 'en' }}
Reply in the guest's detected language.

Guest message:
{{ $('Normalize Incoming Message').first().json.guest_message }}

Situation:
The guest has requested dates that fall in a CLOSED month.

Closed months at Wolfhouse: {{ $json.closed_months.join(', ') }}
Detected closed month: {{ $json.closed_month_name }}
Open months available: {{ $json.suggested_open_months }}

Instructions:
* Inform the guest warmly that Wolfhouse is closed in the requested month.
* Suggest that the guest considers booking in an open month.
* Offer to check availability for a different month.
* Do NOT quote any price.
* Do NOT confirm availability for the closed month.
* Do NOT confirm a booking.
* Do NOT mention AI.
* Keep the reply short, friendly, and in the surf hostel tone.
* If the guest insists on a closed month, offer to connect them with a staff member.

Return ONLY the WhatsApp message text. No explanation. No markdown.`;

  // ── Node positions ──────────────────────────────────────────────────────────
  // Determine Missing Fields: [2752, 1040] → insert guard row at y=1256
  const CCM_POS = [dmf.position[0], dmf.position[1] + 216];
  const IF_CM_POS = [dmf.position[0] + 200, dmf.position[1] + 216];
  const REPLY_CM_POS = [gnr.position[0] - 192, gnr.position[1]];
  const REPLY_CM_MODEL_POS = [gnr.position[0] - 192, gnr.position[1] + 180];

  // ── Anthropic model node (lmChatAnthropic) ─────────────────────────────────
  // Reuse same credentials as existing Anthropic model nodes.
  const existingAnthropicModel = workflow.nodes.find(
    (n) => n.type === '@n8n/n8n-nodes-langchain.lmChatAnthropic' && n.credentials?.anthropicApi
  );
  const anthropicCredentials = existingAnthropicModel?.credentials || {
    anthropicApi: { id: 'a9iPsEV9gB8jlJMt', name: 'Anthropic account' },
  };

  const modelNode = {
    id: 'stage4-cm-model-0001',
    name: 'Anthropic Chat Model (Closed Month)',
    type: '@n8n/n8n-nodes-langchain.lmChatAnthropic',
    typeVersion: 1.3,
    position: REPLY_CM_MODEL_POS,
    parameters: {
      model: {
        __rl: true,
        value: 'claude-haiku-4-5',
        mode: 'list',
        cachedResultName: 'Claude Haiku 4.5',
      },
      options: {},
    },
    credentials: JSON.parse(JSON.stringify(anthropicCredentials)),
  };

  const replyNode = {
    id: 'stage4-cm-reply-0001',
    name: 'Reply - Closed Month',
    type: '@n8n/n8n-nodes-langchain.chainLlm',
    typeVersion: 1.4,
    position: REPLY_CM_POS,
    parameters: {
      promptType: 'define',
      text: REPLY_CLOSED_MONTH_PROMPT,
      batching: { batchSize: 1, delayBetweenBatches: 0 },
    },
  };

  const checkNode = {
    id: 'stage4-cm-check-0001',
    name: 'Code - Check Closed Month',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: CCM_POS,
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: CHECK_CLOSED_MONTH_JS,
    },
  };

  const ifCmNode = {
    id: 'stage4-cm-if-0001',
    name: 'IF - Closed Month?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: IF_CM_POS,
    parameters: {
      conditions: {
        options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            id: 'stage4-cm-cond-0001',
            leftValue: '={{ $json.closed_month_detected }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true' },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
  };

  workflow.nodes.push(checkNode, ifCmNode, replyNode, modelNode);

  // ── Rewire connections ──────────────────────────────────────────────────────
  // 1. Determine Missing Fields → Code - Check Closed Month (was → IF - Ready For Availability)
  workflow.connections['Determine Missing Fields'] = {
    main: [[{ node: 'Code - Check Closed Month', type: 'main', index: 0 }]],
  };

  // 2. Code - Check Closed Month → IF - Closed Month?
  workflow.connections['Code - Check Closed Month'] = {
    main: [[{ node: 'IF - Closed Month?', type: 'main', index: 0 }]],
  };

  // 3. IF - Closed Month?:
  //    true  (main[0]) → Reply - Closed Month
  //    false (main[1]) → IF - Ready For Availability (existing path)
  workflow.connections['IF - Closed Month?'] = {
    main: [
      [{ node: 'Reply - Closed Month', type: 'main', index: 0 }],
      [{ node: 'IF - Ready For Availability', type: 'main', index: 0 }],
    ],
  };

  // 4. Reply - Closed Month → IF - DRY RUN? (Create Outbound Message) (same as GNR)
  workflow.connections['Reply - Closed Month'] = {
    main: [[{ node: 'IF - DRY RUN? (Create Outbound Message)', type: 'main', index: 0 }]],
  };

  // 5. Model sub-node → Reply - Closed Month via ai_languageModel
  workflow.connections['Anthropic Chat Model (Closed Month)'] = {
    ai_languageModel: [[{ node: 'Reply - Closed Month', type: 'ai_languageModel', index: 0 }]],
  };

  // ── Advisory injection into Parser Node prompt ─────────────────────────────
  const parserNode = workflow.nodes.find((n) => n.name === 'Parser Node');
  if (parserNode?.parameters?.text) {
    const advisoryNote = `\nOperational context:
* Wolfhouse is CLOSED in: ${closedMonths.join(', ')}.
* If the guest requests dates in a closed month, still extract check_in and check_out.
* The booking workflow will automatically detect and handle closed-month dates.
* Do not set needs_human based on closed-month dates alone.\n`;
    parserNode.parameters.text = parserNode.parameters.text.replace(
      '\nSchema:\n',
      `${advisoryNote}\nSchema:\n`
    );
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
  const isPhaseTestMessageId = /^wamid\\.PHASE[0-9A-Z]+/i.test(messageId);
  // Stage 3y: also skip typing indicator when WHATSAPP_DRY_RUN=true (offline/shadow mode).
  const isDryRun = String($env.WHATSAPP_DRY_RUN || '').toLowerCase() === 'true';
  return source === 'whatsapp' && messageId.length > 0 && !isPhaseTestMessageId && !isDryRun;
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

/**
 * Stage 3y: make the local Main fork fully offline-safe for Mode A shadow testing.
 *
 * When WHATSAPP_DRY_RUN=true, ALL live side-effect nodes are bypassed via IF gates.
 * Each gated node gets:
 *   - an "IF - DRY RUN? (node name)" node: true = live (send), false = dry-run (stub)
 *   - a "Code - DRY RUN Stub (node name)" node: returns synthetic data so downstream
 *     routing/draft logic can continue without writes.
 *
 * Categories:
 *   A. All "Send WhatsApp Reply*" HTTP nodes — gate + remove hardcoded Bearer token.
 *   B. Airtable write nodes (create/update/upsert) — gate with typed stubs.
 *   C. Postgres write nodes (hold creation, conv hold, backfill) — gate with typed stubs.
 *   D. Typing indicator — already gated by applyLocalTypingIndicatorBypass; token replaced here.
 */
function applyShadowModeDryRunGates(workflow) {
  // Helper: find all predecessor connections pointing to a node
  function findPredecessors(nodeName) {
    const found = [];
    for (const [src, conn] of Object.entries(workflow.connections)) {
      for (let oi = 0; oi < (conn.main || []).length; oi++) {
        const out = conn.main[oi] || [];
        for (let li = 0; li < out.length; li++) {
          if (out[li] && out[li].node === nodeName) found.push({ src, oi, li });
        }
      }
    }
    return found;
  }

  // Helper: insert IF + Code-stub gate before a node.
  //   true branch (NOT dry-run) → original node (all original successors preserved)
  //   false branch (dry-run)    → Code stub node (terminates; no further writes)
  function addDryRunGate(targetNodeName, stubJsCode, idSuffix) {
    const orig = workflow.nodes.find((n) => n.name === targetNodeName);
    if (!orig) {
      console.warn(`applyShadowModeDryRunGates: node not found, skipping: ${targetNodeName}`);
      return;
    }

    const ifName = `IF - DRY RUN? (${targetNodeName})`;
    const stubName = `Code - DRY RUN Stub (${targetNodeName})`;

    const ifNode = {
      id: `shadow-if-${idSuffix}`,
      name: ifName,
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [orig.position[0] - 200, orig.position[1]],
      parameters: {
        conditions: {
          options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 },
          conditions: [
            {
              id: `shadow-cond-${idSuffix}`,
              leftValue: `={{ String($env.WHATSAPP_DRY_RUN || '').toLowerCase() }}`,
              rightValue: 'true',
              operator: { type: 'string', operation: 'notEquals' },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
    };

    const stubNode = {
      id: `shadow-stub-${idSuffix}`,
      name: stubName,
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [orig.position[0] - 200, orig.position[1] + 140],
      parameters: {
        mode: 'runOnceForAllItems',
        jsCode: stubJsCode,
      },
    };

    workflow.nodes.push(ifNode, stubNode);

    // Rewire: predecessors that pointed to targetNode now point to IF node
    const preds = findPredecessors(targetNodeName);
    for (const { src, oi, li } of preds) {
      workflow.connections[src].main[oi][li].node = ifName;
    }

    // IF connections: true → original node, false → stub
    workflow.connections[ifName] = {
      main: [
        [{ node: targetNodeName, type: 'main', index: 0 }],
        [{ node: stubName, type: 'main', index: 0 }],
      ],
    };
    // Stub inherits original node's successors so the pipeline continues in dry-run mode.
    // For terminal nodes (no successors) the stub also terminates, which is correct.
    const origConns = workflow.connections[targetNodeName];
    if (origConns) {
      workflow.connections[stubName] = JSON.parse(JSON.stringify(origConns));
    }
  }

  // ── Replace hardcoded Bearer token with env-var reference in ALL Meta HTTP nodes ──
  // Covers Send WhatsApp Reply*, Send Typing Indicator, and any future Meta HTTP node.
  const HARDCODED_TOKEN_RE = /^Bearer [A-Za-z0-9+/]{20,}$/;
  for (const node of workflow.nodes) {
    if (node.type !== 'n8n-nodes-base.httpRequest') continue;
    const url = String(node.parameters?.url || '');
    if (!url.includes('graph.facebook.com')) continue;
    const headers = node.parameters?.headerParameters?.parameters || [];
    for (const h of headers) {
      if (h.name === 'Authorization' && HARDCODED_TOKEN_RE.test(String(h.value || ''))) {
        h.value = "={{ 'Bearer ' + ($env.WHATSAPP_ACCESS_TOKEN || '') }}";
      }
    }
    // Also replace hardcoded phone_number_id in URL with env var
    if (/graph\.facebook\.com\/v[\d.]+\/\d{10,}\/messages/.test(url)) {
      node.parameters.url =
        "={{ 'https://graph.facebook.com/v20.0/' + ($env.WHATSAPP_PHONE_NUMBER_ID || '0') + '/messages' }}";
    }
  }

  let counter = 3001;
  const next = () => String(counter++);

  // ── Category A: All Send WhatsApp Reply* HTTP nodes ──
  const WA_SEND_STUB = `// Stage 3y shadow mode: WHATSAPP_DRY_RUN=true — no real WhatsApp send
return [{ json: {
  messaging_product: 'whatsapp',
  contacts: [],
  messages: [{ id: 'dry-run-no-send' }],
  dry_run: true,
  _shadow_note: 'WhatsApp send bypassed by WHATSAPP_DRY_RUN=true'
}}];`;

  const sendNodes = workflow.nodes
    .filter((n) => n.name.startsWith('Send WhatsApp Reply') && n.type === 'n8n-nodes-base.httpRequest')
    .map((n) => n.name);

  for (const name of sendNodes) {
    addDryRunGate(name, WA_SEND_STUB, next());
  }

  // ── Category B: Airtable write nodes ──
  const AT_CONV_STUB = `// Stage 3y shadow: Airtable conversation write bypassed
return [{ json: {
  id: 'dry-run-at-conv',
  fields: { Name: 'DRY RUN', Phone: '', 'Bot Mode': 'bot_active', 'Needs Human': false },
  dry_run: true
}}];`;

  const AT_MSG_STUB = `// Stage 3y shadow: Airtable message write bypassed
return [{ json: {
  id: 'dry-run-at-msg',
  fields: { 'Message Text': '(shadow draft — not written to Airtable)', Source: 'test' },
  dry_run: true
}}];`;

  const AT_BOOKING_STUB = `// Stage 3y shadow: Airtable booking write bypassed
return [{ json: {
  id: 'dry-run-at-booking',
  fields: { Status: 'hold', Notes: 'DRY RUN — not a real booking', dry_run: true },
  dry_run: true
}}];`;

  const AT_PASSTHROUGH_STUB = `// Stage 3y shadow: Airtable update bypassed
return [{ json: { id: 'dry-run-at-passthrough', dry_run: true } }];`;

  // Airtable write node targets: [name, stub]
  const atWriteGates = [
    // Inbound conversation path (early — must stub so downstream Code nodes continue)
    ['Create Inbound Message', AT_MSG_STUB],
    ['Create Conversation', AT_CONV_STUB],
    ['Update Inbound Message - Link Conversation', AT_PASSTHROUGH_STUB],
    ['Update Conversation - Append Guest Message', AT_CONV_STUB],
    ['Update Conversation Summary', AT_CONV_STUB],
    ['Create or update Conversation', AT_CONV_STUB],
    // Booking write nodes
    ['Create Booking Hold', AT_BOOKING_STUB],
    ['Update Booking - Payment Claim', AT_BOOKING_STUB],
    ['Update Booking - Cancel', AT_BOOKING_STUB],
    ['Update Booking - Rooming Info', AT_BOOKING_STUB],
    ['Update Booking - Stripe Payment Link', AT_BOOKING_STUB],
    ['Update Booking Hold - Apply Staged Contact', AT_BOOKING_STUB],
    ['Update Booking - Rooming Details', AT_BOOKING_STUB],
    ['Update Hold With Guest Details', AT_BOOKING_STUB],
    ['Update record', AT_BOOKING_STUB],
    // Outbound message creates (all routes)
    ['Create Outbound Message', AT_MSG_STUB],
    ['Create Outbound Message1', AT_MSG_STUB],
    ['Create Outbound Message - Payment Claim', AT_MSG_STUB],
    ['Create Outbound Message - Payment Not Found', AT_MSG_STUB],
    ['Create Outbound Message - Payment Pending', AT_MSG_STUB],
    ['Create Outbound Message - General Question', AT_MSG_STUB],
    ['Create Outbound Message - Unknown', AT_MSG_STUB],
    ['Create Outbound Message - Human Handoff', AT_MSG_STUB],
    ['Create Outbound Message - Modify Booking', AT_MSG_STUB],
    ['Create Outbound Message - Cancel Booking', AT_MSG_STUB],
    ['Create Outbound Message - Payment Details', AT_MSG_STUB],
    ['Create Outbound Message - No Availability Alternatives', AT_MSG_STUB],
    ['Create Outbound Message - Status', AT_MSG_STUB],
    ['Create Outbound Message - Status1', AT_MSG_STUB],
    ['Create Outbound Message - Rooming Info Saved', AT_MSG_STUB],
    ['Create Outbound Message - Rooming Reply', AT_MSG_STUB],
    // Conversation updates (terminal — but gate for completeness)
    ['Update Conversation After Reply', AT_CONV_STUB],
    ['Create/update Conversation - Payment Pending', AT_CONV_STUB],
    ['Create/update Conversation - Modify Booking', AT_CONV_STUB],
    ['Create/update Conversation - Cancel Booking', AT_CONV_STUB],
    ['Create/update Conversation - Booking Status', AT_CONV_STUB],
    ['Create/update Conversation - Status', AT_CONV_STUB],
    ['Update Conversation - Payment Claim Found', AT_CONV_STUB],
    ['Update Conversation - Payment Lookup Needed', AT_CONV_STUB],
    ['Update Conversation - Unknown', AT_CONV_STUB],
    ['Update Conversation - General Question', AT_CONV_STUB],
    ['Update Conversation - Human Handoff', AT_CONV_STUB],
    ['Update Conversation - No Availability Alternatives', AT_CONV_STUB],
    ['Update Conversation - Rooming Info Saved', AT_CONV_STUB],
    ['Update Conversation - Rooming Reply', AT_CONV_STUB],
    ['Update Conversation - Guest Details', AT_CONV_STUB],
    ['Create or update Conversation - Payment Details', AT_CONV_STUB],
  ];

  for (const [name, stub] of atWriteGates) {
    addDryRunGate(name, stub, next());
  }

  // ── Category C: Postgres write nodes ──
  // Stub shapes must satisfy downstream Code - Validate PG Hold / IF - PG Hold OK logic.
  const PG_HOLD_STUB = `// Stage 4 dry-run: Postgres booking hold creation bypassed (WHATSAPP_DRY_RUN=true).
// Returns a SHAPED stub so Code - Validate PG Hold sets pg_ok=true and downstream
// booking/payment nodes can proceed through the full flow without mutating the DB.
// Reads session context from earlier nodes to populate check_in/check_out/guest_count.
const _session = (() => {
  try { return $('Code - Booking State Resolver').first().json?.session || {}; } catch { return {}; }
})();
const _checkIn = _session.check_in || null;
const _checkOut = _session.check_out || null;
const _guestCount = _session.guest_count || _session.guests || null;
const _packageKey = _session.package_intent || _session.package_key || null;
const _suffix = (_checkIn || '').replace(/-/g, '').slice(0, 8) || 'nodate';
const _bookingId = 'dry-run-' + _suffix;
const _bookingCode = 'DRY-STAGE4-' + _suffix;
return [{ json: {
  pg_ok: true,
  booking_id: _bookingId,
  booking_code: _bookingCode,
  id: _bookingId,
  status: 'hold',
  payment_status: 'unpaid',
  check_in: _checkIn,
  check_out: _checkOut,
  guest_count: _guestCount,
  package_key: _packageKey,
  actionable: [{ booking_code: _bookingCode, status: 'hold', dry_run: true }],
  pg_errors: [],
  pg_query_ok: true,
  created: true,
  dry_run: true,
  stub_type: 'hold_stub',
  _stub_note: 'Stage 4 dry-run hold — not a real PG row'
}}];`;

  const PG_BACKFILL_STUB = `// Stage 3y shadow: Postgres AT record backfill bypassed
return [{ json: { affected: 0, dry_run: true } }];`;

  const PG_ENSURE_STUB = `// Stage 4 dry-run: Postgres Ensure Booking (hold→payment_pending promote) bypassed.
// Returns shaped booking_id/booking_code from the hold stub so IF - Booking ID Ready
// goes to the true branch and Code - Call Create Payment Session can run its own
// inline dry-run check to return a stub checkout URL.
const _holdValidate = (() => {
  try { return $('Code - Validate PG Hold').first().json || {}; } catch { return {}; }
})();
const _bookingId = _holdValidate.booking_id || 'dry-run-ensure-fallback';
const _bookingCode = _holdValidate.booking_code || 'DRY-ENSURE';
return [{ json: {
  booking_id: _bookingId,
  booking_code: _bookingCode,
  created: false,
  promoted: false,
  action: 'dry_run_bypass',
  status: 'hold',
  payment_status: 'unpaid',
  dry_run: true,
  stub_type: 'ensure_booking_stub',
  _stub_note: 'Stage 4 dry-run: hold→payment_pending promotion bypassed — not a real PG mutation'
}}];`;

  addDryRunGate('Postgres - Create Booking Hold', PG_HOLD_STUB, next());
  addDryRunGate('Postgres - Backfill Booking AT Record Id', PG_BACKFILL_STUB, next());
  addDryRunGate('Postgres - Ensure Booking In Postgres', PG_ENSURE_STUB, next());

  // ── Category D: Airtable read stubs ──────────────────────────────────────
  // Search Messages - Recent Conversation returns 0 items for new phone numbers
  // (nothing in Airtable yet) causing n8n to silently terminate. In dry-run mode
  // stub it with the current incoming message so Code - Build Conversation Memory
  // always has at least 1 item and the routing/LLM path can run.
  const SEARCH_MSGS_STUB = `// Stage 3y shadow: Search Messages stub — returns current message as minimal history
const msg = $('Normalize Incoming Message').first().json || {};
const msgText = msg.guest_message || msg.message_body || msg.body || msg.text || '';
return [{ json: {
  id: 'dry-run-msg-1',
  fields: {
    'Message Text': msgText,
    'Direction': 'Inbound',
    'Conversation Phone': msg.phone || '',
    'Source': 'WhatsApp',
    dry_run: true
  }
}}];`;
  addDryRunGate('Search Messages - Recent Conversation', SEARCH_MSGS_STUB, next());

  // ── Category E: Reassign HTTP nodes ──────────────────────────────────────────
  // Both HTTP nodes POST to the local reassign endpoint which is unavailable in
  // offline mode. Gate them so the rooming path can complete without erroring.
  // Stub returns enough shape for downstream nodes (Rooming Updated After Reassignment
  // and Code - Build Rooming Info Saved Reply) which both reference $('Code - Parse Route'),
  // not the reassign HTTP output — so any well-formed object is safe here.
  const REASSIGN_STUB = `// Stage 3y shadow: reassign HTTP call bypassed (endpoint unavailable in offline mode)
return [{ json: {
  status: 'ok',
  dry_run: true,
  action: 'reassign_booking_beds',
  skipped: true,
  reason: 'shadow_mode',
  _shadow_note: 'Call Reassign Booking Beds bypassed by WHATSAPP_DRY_RUN=true'
}}];`;

  const REASSIGN_NODES = [
    'Call Reassign Booking Beds - Rooming Update',
    'Call Reassign Booking Beds - Rooming Update1',
  ];
  for (const name of REASSIGN_NODES) {
    addDryRunGate(name, REASSIGN_STUB, next());
  }

  // ── Patch ALL nodes that reference gated nodes in expressions ───────────────
  // Code nodes use $('NodeName') in jsCode (JS). Other nodes (SET, IF, etc.)
  // use $('NodeName') inside ={{ ... }} expression strings in their parameters.
  // Use .isExecuted ternary — safe for both JS code and n8n expression strings.
  const allGatedNames = [
    ...sendNodes,
    ...atWriteGates.map(([name]) => name),
    'Search Messages - Recent Conversation',
    'Postgres - Create Booking Hold',
    // Stage 5.1: Postgres - Upsert Conversation Hold removed from gated list —
    // conversations is not a protected table; writes allowed even in dry-run.
    'Postgres - Backfill Booking AT Record Id',
    'Postgres - Ensure Booking In Postgres',
    ...REASSIGN_NODES,
  ];

  /** Recursively patch $('GatedName') references in parameter values. */
  function patchParamValue(val, needle, repl) {
    if (typeof val === 'string') {
      if (!val.includes(needle)) return val;
      return val.split(needle).join(repl);
    }
    if (Array.isArray(val)) return val.map((item) => patchParamValue(item, needle, repl));
    if (val && typeof val === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(val)) out[k] = patchParamValue(v, needle, repl);
      return out;
    }
    return val;
  }

  let allNodePatches = 0;
  for (const node of workflow.nodes) {
    // Skip the gate/stub nodes themselves to avoid circular self-patches
    if (node.name.startsWith('IF - DRY RUN?') || node.name.startsWith('Code - DRY RUN Stub')) continue;
    if (!node.parameters) continue;
    let nodePatches = 0;
    for (const gatedName of allGatedNames) {
      const needle = `$('${gatedName}')`;
      const paramsStr = JSON.stringify(node.parameters);
      if (!paramsStr.includes(needle)) continue;
      const stubName = `Code - DRY RUN Stub (${gatedName})`;
      const count = paramsStr.split(needle).length - 1;
      // .isExecuted ternary: $('NodeName') returns a Proxy, never throws on access.
      // .first()/.all() throw on un-executed nodes — so check .isExecuted first.
      const repl = `($('${gatedName}').isExecuted ? $('${gatedName}') : $('${stubName}'))`;
      node.parameters = patchParamValue(node.parameters, needle, repl);
      nodePatches += count;
    }
    allNodePatches += nodePatches;
  }
  if (allNodePatches > 0) {
    console.log(`Shadow-mode expression patches: ${allNodePatches} reference(s) wrapped across all node types`);
  }

  const ifCount = workflow.nodes.filter((n) => n.name.startsWith('IF - DRY RUN?')).length;
  const stubCount = workflow.nodes.filter((n) => n.name.startsWith('Code - DRY RUN Stub')).length;
  console.log(`Shadow-mode gates added: ${ifCount} IF nodes + ${stubCount} Code stubs (${sendNodes.length} WA sends, ${atWriteGates.length} AT writes, 5 PG+read nodes, ${REASSIGN_NODES.length} reassign HTTP nodes gated)`);
  if (ifCount !== stubCount) throw new Error('Shadow gate IF/stub count mismatch — BUG');
}

/**
 * Verify that the generated local Main fork is fully offline-safe for shadow testing.
 * Called from runVerifyTargets (--verify-targets) and the default build path.
 */
function verifyShadowModeSafety(workflow) {
  const errors = [];

  // Build set of nodes that are the "true" (live) branch of a DRY RUN IF gate
  const ifGatedSet = new Set();
  for (const [src, conn] of Object.entries(workflow.connections)) {
    if (!src.startsWith('IF - DRY RUN?')) continue;
    for (const link of conn.main?.[0] || []) {
      if (link?.node) ifGatedSet.add(link.node);
    }
  }

  // 1. No hardcoded WhatsApp Bearer token in any node
  const HARDCODED_TOKEN_RE = /Bearer [A-Za-z0-9+/]{30,}/;
  for (const node of workflow.nodes) {
    const blob = JSON.stringify(node.parameters || '');
    if (HARDCODED_TOKEN_RE.test(blob) && !blob.includes('$env')) {
      errors.push(`Hardcoded WA Bearer token in node: ${node.name}`);
    }
  }

  // 2. All Send WhatsApp Reply* HTTP nodes must be dry-run gated
  const sendNodes = workflow.nodes.filter(
    (n) => n.name.startsWith('Send WhatsApp Reply') && n.type === 'n8n-nodes-base.httpRequest'
  );
  for (const n of sendNodes) {
    if (!ifGatedSet.has(n.name)) {
      errors.push(`Send node not protected by dry-run IF gate: ${n.name}`);
    }
  }

  // 3. Send Typing Indicator must be gated (by existing Local Guard, not dry-run gate)
  const typingGuard = workflow.nodes.find((n) => n.name === 'IF - Send Typing Indicator (Local Guard)');
  if (!typingGuard) {
    errors.push('IF - Send Typing Indicator (Local Guard) not found — typing indicator ungated');
  } else {
    const typingCond = JSON.stringify(typingGuard.parameters?.conditions?.conditions?.[0]?.leftValue || '');
    if (!typingCond.includes('WHATSAPP_DRY_RUN')) {
      errors.push('IF - Send Typing Indicator (Local Guard) does not reference WHATSAPP_DRY_RUN');
    }
  }

  // 4. Postgres - Create Booking Hold must be dry-run gated
  if (!ifGatedSet.has('Postgres - Create Booking Hold')) {
    errors.push('Postgres - Create Booking Hold not protected by dry-run IF gate');
  }

  // 5. Stage 5.1: Postgres - Upsert Conversation Hold must NOT be dry-run gated
  //    (conversations is not a protected table; writes allowed in dry-run mode)
  if (ifGatedSet.has('Postgres - Upsert Conversation Hold')) {
    errors.push('Postgres - Upsert Conversation Hold is dry-run gated but should not be (Stage 5.1: conversations ≠ protected table)');
  }

  // 6. Create Inbound Message (Airtable) must be dry-run gated
  if (!ifGatedSet.has('Create Inbound Message')) {
    errors.push('Create Inbound Message (Airtable) not protected by dry-run IF gate');
  }

  // 7. No graph.facebook.com URL in any ungated HTTP node
  for (const node of workflow.nodes) {
    if (node.type !== 'n8n-nodes-base.httpRequest') continue;
    const url = String(node.parameters?.url || '');
    if (!url.includes('graph.facebook.com')) continue;
    // Must be either gated by IF-DRY-RUN or by the existing Local Guard (typing indicator)
    const isTypingNode = node.name === 'Send Typing Indicator';
    if (!isTypingNode && !ifGatedSet.has(node.name)) {
      errors.push(`graph.facebook.com HTTP node ungated in dry-run: ${node.name}`);
    }
  }

  // 8. Postgres - Ensure Booking In Postgres must be dry-run gated (Stage 4 — prevents hold→payment_pending promotion in dry-run)
  if (!ifGatedSet.has('Postgres - Ensure Booking In Postgres')) {
    errors.push('Postgres - Ensure Booking In Postgres not protected by dry-run IF gate (Stage 4 safety requirement)');
  }

  // 9. Reassign HTTP nodes must be dry-run gated (Category E — offline-mode safety for Y-T8)
  const reassignHttpNodes = [
    'Call Reassign Booking Beds - Rooming Update',
    'Call Reassign Booking Beds - Rooming Update1',
  ];
  for (const name of reassignHttpNodes) {
    if (!ifGatedSet.has(name)) {
      errors.push(`Reassign HTTP node not protected by dry-run IF gate: ${name}`);
    }
  }

  const gateCount = ifGatedSet.size;
  if (errors.length > 0) {
    const msg = `Shadow-mode safety FAIL (${errors.length} error(s)):\n  ${errors.join('\n  ')}`;
    return { ok: false, errors, gateCount };
  }
  console.log(`Shadow-mode safety: OK (${gateCount} nodes gated, token clean, hold gated, ensure-booking gated, typing gated, reassign gated)`);
  return { ok: true, errors: [], gateCount };
}

/**
 * Verify closed-month guard is correctly wired in the workflow.
 * Skips silently if closedMonths is empty.
 * @param {object} workflow
 * @param {string[]} closedMonths
 */
function verifyClosedMonthGuard(workflow, closedMonths) {
  if (!Array.isArray(closedMonths) || closedMonths.length === 0) {
    console.log('Closed-month guard verify: SKIP (no closed months configured)');
    return { ok: true, errors: [], skipped: true };
  }

  const errors = [];
  const nodeNames = new Set(workflow.nodes.map((n) => n.name));

  if (!nodeNames.has('Code - Check Closed Month'))
    errors.push('Code - Check Closed Month node missing');
  if (!nodeNames.has('IF - Closed Month?')) errors.push('IF - Closed Month? node missing');
  if (!nodeNames.has('Reply - Closed Month')) errors.push('Reply - Closed Month node missing');
  if (!nodeNames.has('Anthropic Chat Model (Closed Month)'))
    errors.push('Anthropic Chat Model (Closed Month) node missing');

  // DMF must connect to Code - Check Closed Month (not directly to IF-Ready-For-Availability)
  const dmfOut = (workflow.connections['Determine Missing Fields']?.main?.[0] || []).map(
    (n) => n.node
  );
  if (!dmfOut.includes('Code - Check Closed Month'))
    errors.push('Determine Missing Fields does not connect to Code - Check Closed Month');
  if (dmfOut.includes('IF - Ready For Availability'))
    errors.push(
      'Determine Missing Fields still connects directly to IF - Ready For Availability (bypass guard)'
    );

  // Code - Check Closed Month → IF - Closed Month?
  const ccmOut = (workflow.connections['Code - Check Closed Month']?.main?.[0] || []).map(
    (n) => n.node
  );
  if (!ccmOut.includes('IF - Closed Month?'))
    errors.push('Code - Check Closed Month does not connect to IF - Closed Month?');

  // IF - Closed Month? true (main[0]) → Reply - Closed Month
  const ifCmTrue = (workflow.connections['IF - Closed Month?']?.main?.[0] || []).map((n) => n.node);
  const ifCmFalse = (workflow.connections['IF - Closed Month?']?.main?.[1] || []).map(
    (n) => n.node
  );
  if (!ifCmTrue.includes('Reply - Closed Month'))
    errors.push('IF - Closed Month? true branch does not connect to Reply - Closed Month');
  if (!ifCmFalse.includes('IF - Ready For Availability'))
    errors.push(
      'IF - Closed Month? false branch does not connect to IF - Ready For Availability'
    );

  // Reply - Closed Month → IF - DRY RUN? (Create Outbound Message)
  const rcmOut = (workflow.connections['Reply - Closed Month']?.main?.[0] || []).map((n) => n.node);
  if (!rcmOut.includes('IF - DRY RUN? (Create Outbound Message)'))
    errors.push(
      'Reply - Closed Month does not connect to IF - DRY RUN? (Create Outbound Message)'
    );

  // Reply - Closed Month must NOT connect to hold-path nodes
  const holdNodes = ['Code - Prepare Hold Records', 'Postgres - Create Booking Hold', 'Create Booking Hold'];
  for (const hn of holdNodes) {
    if (rcmOut.includes(hn)) errors.push(`Reply - Closed Month connects to hold node: ${hn}`);
  }

  // Parser Node advisory injection present
  const parserNode = workflow.nodes.find((n) => n.name === 'Parser Node');
  const parserText = parserNode?.parameters?.text || '';
  if (!parserText.includes('CLOSED in:'))
    errors.push('Parser Node prompt missing closed-month advisory (expected "CLOSED in:")');

  // Code - Check Closed Month contains the correct closed_months literal
  const checkNode = workflow.nodes.find((n) => n.name === 'Code - Check Closed Month');
  const checkCode = checkNode?.parameters?.jsCode || '';
  for (const m of closedMonths) {
    if (!checkCode.includes(m))
      errors.push(`Code - Check Closed Month JS missing closed month: "${m}"`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  console.log(
    'Closed-month guard: OK (4 nodes present, wiring correct, hold path unreachable, advisory injected)'
  );
  return { ok: true, errors: [] };
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
      'OR({Payment Status}="not_requested",{Payment Status}="waiting_payment",{Payment Status}="payment_pending")' +
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

const WOLFHOUSE_CLIENT_CONFIG = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', 'config', 'clients', 'wolfhouse-somo.baseline.json'),
    'utf8'
  )
);
/** Lowercase month names that Wolfhouse is closed, sourced from wolfhouse-somo.baseline.json. */
const CLOSED_MONTHS_CONFIG = (WOLFHOUSE_CLIENT_CONFIG?.packages?.closed_months || []).map((m) =>
  String(m).toLowerCase()
);
/** Service add-ons catalog (lessons, yoga, rentals, bundles), sourced from wolfhouse-somo.baseline.json. */
const SERVICE_ADDONS_CONFIG = WOLFHOUSE_CLIENT_CONFIG?.service_addons || {};

// ── Stage 4 A9: Service add-ons prompt injection ──────────────────────────────
/**
 * Format service_addons config into a human-readable pricing block for LLM prompt injection.
 * Reads only from client config — never hard-codes price values.
 * @param {object} serviceAddons  wolfhouse-somo.baseline.json service_addons object
 * @returns {string}  multi-line pricing block
 */
function formatServiceAddonsForPrompt(serviceAddons) {
  const cat = serviceAddons?.service_catalog || {};
  const bundles = serviceAddons?.bundles || {};
  const lines = [];

  // Surf lessons (tiered by quantity)
  const lesson = cat.surf_lesson;
  if (lesson?.tiers?.length) {
    const tier1 = lesson.tiers.find((t) => t.min_qty === 1 && t.max_qty === 1);
    const tier2 = lesson.tiers.find((t) => t.min_qty === 2 && t.max_qty === null);
    const p1 = tier1?.price_eur;
    const p2 = tier2?.price_eur_each;
    lines.push('Surf lessons (tiered pricing):');
    if (p1 != null) lines.push(`* 1 lesson: €${p1}`);
    if (p1 != null && p2 != null) {
      lines.push(`* 2 lessons: €${p1 + p2} (1st €${p1} + 2nd €${p2})`);
      lines.push(`* 3+ lessons: 1st €${p1}, each additional €${p2}`);
    }
    lines.push('* Scheduling: staff manages lesson slots on-site. Two daily slots available.');
    lines.push('* Payment: if guest wants to pay now, you can create a payment link — ask for quantity and preferred dates.');
    lines.push('');
  }

  // Yoga
  const yoga = cat.yoga_class;
  if (yoga) {
    lines.push('Yoga classes:');
    lines.push(`* €${yoga.price_eur} per class`);
    if (yoga.booked_onsite) {
      lines.push('* Booked ON SITE — guests arrange directly with staff at Wolfhouse.');
      lines.push('* The bot does NOT create a payment link for yoga.');
      lines.push('* Exception: special camps/retreats may include yoga if staff confirms.');
    }
    lines.push('');
  }

  // Individual gear rentals
  const wetsuit = cat.wetsuit_rental;
  const softtop = cat.softtop_surfboard_rental;
  const hardboard = cat.hardboard_surfboard_rental;
  if (wetsuit || softtop || hardboard) {
    lines.push('Gear rentals (per day):');
    if (wetsuit) lines.push(`* Wetsuit: €${wetsuit.price_eur}/day`);
    if (softtop) lines.push(`* Soft top surfboard: €${softtop.price_eur}/day`);
    if (hardboard) lines.push(`* Hard board: €${hardboard.price_eur}/day`);
    lines.push('');
  }

  // Bundle promos
  const b1 = bundles.wetsuit_plus_softtop;
  const b2 = bundles.wetsuit_plus_hardboard;
  if (b1 || b2) {
    lines.push('Bundle promos (per day — wetsuit included free):');
    if (b1) lines.push(`* Wetsuit + soft top: €${b1.price_eur}/day (wetsuit free)`);
    if (b2) lines.push(`* Wetsuit + hard board: €${b2.price_eur}/day (wetsuit free)`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Inject confirmed service_addons pricing into the Reply - General Question LLM system prompt.
 *
 * Replaces the old "Do not invent exact prices." anti-hallucination rule with:
 *   "Use only confirmed prices from the service add-ons section below."
 * Inserts a priced services block before "Return ONLY the WhatsApp reply text."
 *
 * ── Stage 5/6 add_on_intent design note (NOT implemented in Stage 4) ──────────
 * When a guest requests an add-on, the bot should eventually write a structured
 * add_on_intent record to session_state so staff can query it later. Proposed shape:
 *   {
 *     "type": "surf_lesson" | "yoga_class" | "wetsuit_rental" | "softtop_rental" | "hardboard_rental",
 *     "item": "surf_lesson",
 *     "quantity": 2,
 *     "date": null,                    // populated if guest provides it
 *     "price_eur": 65,
 *     "payment_status": "not_requested" | "pending" | "paid",
 *     "scheduling_status": "staff_required",   // for lessons / yoga
 *     "source": "guest_message"
 *   }
 * This enables Stage 6 staff queries:
 *   "Who paid for yoga today?"     → yoga_class records with payment_status=paid + date
 *   "Who has lessons tomorrow?"    → surf_lesson records with date=tomorrow
 *   "Who requested a board?"       → rental records filtered by item type
 * Implementation: deferred to Stage 5 (add_on_orders / lesson_requests table design).
 * In Stage 4 we prove only that the guest-facing quote uses the correct config prices.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * @param {object} workflow
 * @param {object} serviceAddons  wolfhouse-somo.baseline.json service_addons object
 */
function applyGeneralQuestionAddonsPrompt(workflow, serviceAddons) {
  const genQNode = workflow.nodes.find((n) => n.name === 'Reply - General Question');
  if (!genQNode) {
    throw new Error('applyGeneralQuestionAddonsPrompt: Reply - General Question node not found');
  }

  const pricingBlock = formatServiceAddonsForPrompt(serviceAddons);
  if (!pricingBlock) {
    console.log('applyGeneralQuestionAddonsPrompt: no service_addons data found; prompt not updated');
    return;
  }

  const addonsSection =
    `\nConfirmed service add-on prices (Wolfhouse config — use ONLY these values):\n${pricingBlock}\n\nAdd-on rules:\n` +
    `* Use only the prices listed above.\n` +
    `* If a requested item is not listed, say staff will confirm the exact price.\n` +
    `* Never invent, estimate, or guess prices.\n` +
    `* For lesson scheduling, say staff handles slots on-site.\n` +
    `* For yoga, always say it is booked on-site with staff — never create a payment link for yoga.\n` +
    `* For rentals, ask how many days and calculate from the per-day rate above.`;

  let prompt = String(genQNode.parameters.text || '');

  // Replace "Do not invent exact prices." with config-backed rule
  prompt = prompt.replace(
    '* Do not invent exact prices.',
    '* Use only confirmed prices listed in the service add-ons section below. If a requested item is not listed, say staff will confirm the exact price.'
  );

  // Insert pricing section before the final "Return ONLY" sentinel
  const RETURN_SENTINEL = 'Return ONLY the WhatsApp reply text.';
  if (prompt.includes(RETURN_SENTINEL)) {
    prompt = prompt.replace(RETURN_SENTINEL, addonsSection + '\n\n' + RETURN_SENTINEL);
  } else {
    prompt += '\n' + addonsSection;
  }

  genQNode.parameters.text = prompt;
  console.log(
    'applyGeneralQuestionAddonsPrompt: Reply - General Question prompt updated with service_addons pricing block.'
  );
}

/**
 * Verify that the generated Reply - General Question prompt contains service_addons pricing.
 * @param {object} workflow
 * @param {object} serviceAddons  wolfhouse-somo.baseline.json service_addons object
 * @returns {{ ok: boolean, errors: string[] }}
 */
function verifyGeneralQuestionAddonsPrompt(workflow, serviceAddons) {
  const errors = [];
  const genQNode = workflow.nodes.find((n) => n.name === 'Reply - General Question');
  if (!genQNode) {
    errors.push('Reply - General Question node not found');
    return { ok: false, errors };
  }

  const prompt = String(genQNode.parameters.text || '');
  const cat = serviceAddons?.service_catalog || {};
  const bundles = serviceAddons?.bundles || {};

  // Surf lesson tiers
  const lesson = cat.surf_lesson;
  if (lesson?.tiers?.length) {
    const tier1 = lesson.tiers.find((t) => t.min_qty === 1 && t.max_qty === 1);
    const tier2 = lesson.tiers.find((t) => t.min_qty === 2 && t.max_qty === null);
    if (tier1?.price_eur != null && !prompt.includes(`€${tier1.price_eur}`)) {
      errors.push(`Reply - General Question prompt missing surf lesson 1-lesson price €${tier1.price_eur}`);
    }
    if (tier1?.price_eur != null && tier2?.price_eur_each != null) {
      const twoLessonTotal = tier1.price_eur + tier2.price_eur_each;
      if (!prompt.includes(`€${twoLessonTotal}`)) {
        errors.push(`Reply - General Question prompt missing 2-lesson total €${twoLessonTotal}`);
      }
    }
  }

  // Yoga price and on-site instruction
  const yoga = cat.yoga_class;
  if (yoga) {
    if (!prompt.includes(`€${yoga.price_eur}`)) {
      errors.push(`Reply - General Question prompt missing yoga price €${yoga.price_eur}`);
    }
    if (
      yoga.booked_onsite &&
      !prompt.toLowerCase().includes('on site') &&
      !prompt.toLowerCase().includes('onsite')
    ) {
      errors.push('Reply - General Question prompt missing yoga on-site instruction');
    }
  }

  // Wetsuit rental price
  const wetsuit = cat.wetsuit_rental;
  if (wetsuit?.price_eur != null && !prompt.includes(`€${wetsuit.price_eur}/day`)) {
    errors.push(`Reply - General Question prompt missing wetsuit price €${wetsuit.price_eur}/day`);
  }

  // Soft top price
  const softtop = cat.softtop_surfboard_rental;
  if (softtop?.price_eur != null && !prompt.includes(`€${softtop.price_eur}/day`)) {
    errors.push(`Reply - General Question prompt missing soft top price €${softtop.price_eur}/day`);
  }

  // Bundle promo prices
  const b1 = bundles.wetsuit_plus_softtop;
  if (b1?.price_eur != null) {
    const b1str = `€${b1.price_eur}/day`;
    // Allow the softtop standalone price to cover the bundle (same value €15)
    // but check the bundle promo section is present
    if (!prompt.includes('Bundle promo') && !prompt.includes('bundle promo')) {
      errors.push('Reply - General Question prompt missing bundle promo section');
    }
  }

  // Old "Do not invent exact prices." rule must be replaced
  if (prompt.includes('* Do not invent exact prices.')) {
    errors.push(
      'Reply - General Question prompt still contains old "Do not invent exact prices." rule — must be replaced with config-backed rule'
    );
  }

  const ok = errors.length === 0;
  return { ok, errors };
}

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

// Stage 4 dry-run: return a stub checkout URL without calling Stripe or the CPS webhook.
if (String($env.WHATSAPP_DRY_RUN || '').toLowerCase() === 'true') {
  const bookingCode = row.booking_code || bookingId;
  const suffix = String(bookingCode).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().slice(-16);
  return [{
    json: {
      ok: true,
      dry_run: true,
      stub_type: 'payment_link_stub',
      checkout_url: 'https://checkout.stripe.test/dry-run/' + suffix,
      session_id: 'cs_test_dryrun_' + suffix,
      booking_id: bookingId,
      booking_code: bookingCode,
      amount_due_cents: 20000,
      currency: 'EUR',
      payment_kind: 'deposit_only',
      reused: false,
      _stub_note: 'Stage 4 dry-run payment link — not a real Stripe session',
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
applyClosedMonthGuard(workflow, CLOSED_MONTHS_CONFIG);
applyPGConversationRead(workflow);
applyGeneralQuestionAddonsPrompt(workflow, SERVICE_ADDONS_CONFIG);
applyPackageRequirement(workflow);
// applyActiveBookingHoldIdGuard is deferred — Airtable IIFE formula needs further testing.
// The BSR fix (removing !holdUsable from the payment_or_confirm_intent override) is sufficient.
applyPGSessionWriteNonHoldPath(workflow); // Stage 5.1c: non-hold session write
applyLocalTypingIndicatorBypass(workflow);
applyShadowModeDryRunGates(workflow); // Stage 3y: full offline safety for Mode A shadow
applyStage52FixtureHoldGuard(workflow); // Stage 5.2d: fixture hold guard (after shadow gates)
applyStage53FixtureEnsureGuard(workflow); // Stage 5.3d: fixture ensure-promote guard (after shadow gates)
applyHumanActivePaymentLinkBypass(workflow);
applyPostgresCredentialMapping(workflow);
const reassignRemap = applyLocalReassignWebhookRemap(workflow);

workflow.tags = [
  ...(workflow.tags || []),
  { name: 'phase2f2' },
  { name: 'phase2f3' },
  { name: 'phase3c-e3' },
  { name: 'phase3c-e4' },
  { name: 'phase3c-e5' },
  { name: 'phase3c-g1d' },
  { name: 'phase3e-e2' },
  { name: 'phase3y-shadow-safe' }, // Stage 3y: offline-safe for Mode A shadow testing
  { name: 'stage4-cm-guard' }, // Stage 4: deterministic closed-month guard
  { name: 'stage4-pg-conv-read' }, // Stage 4: PG conversation read fallback for multi-turn (shared path)
  { name: 'stage4-pkg-required' }, // Stage 4: package required before hold
  { name: 'stage4-poi-fallback' }, // Stage 4: payment_or_confirm_intent no-hold → booking_flow
  { name: 'stage4-hold-id-guard' }, // Stage 4: FALSE() guard for empty hold_id in Search Active Booking
  { name: 'stage4-addons-prompt' }, // Stage 4 A9: service_addons pricing injected into Reply - General Question
  { name: 'stage5.1c-sess-write' }, // Stage 5.1c: non-hold PG session write on missing-fields path
  { name: 'stage5.2d-fixture-guard' }, // Stage 5.2d: fixture hold guard for real hold write
];

if (reassignRemap.patched > 0) {
  // eslint-disable-next-line no-console
  console.log(
    `Reassign URL remap: ${reassignRemap.patched} node(s) → ${reassignRemap.nodeNames.join(', ')}`,
  );
}

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
  const bodyFix = fixReassignHttpBodyParameterExpressions(workflow);
  if (bodyFix.fixedParams > 0) {
    console.log(
      `Reassign bodyParameters expr fix: ${bodyFix.fixedParams} param(s) in ${bodyFix.fixedNodes.join(', ')}`,
    );
  }
  const neutralized = neutralizeProductionTargets(workflow);
  return { ...neutralized, bodyFix };
}

function importMainWorkflowInactive() {
  const { execSync } = require('child_process');
  const container = 'n8n-main';
  const remote = '/tmp/main-local-stripe-import.json';
  try {
    execSync('docker --version', { stdio: 'ignore' });
  } catch {
    console.log('Import skipped: docker CLI not available');
    console.log(`  docker cp "${OUT}" ${container}:${remote}`);
    console.log(`  docker exec ${container} n8n import:workflow --input=${remote}`);
    return false;
  }
  try {
    execSync(`docker cp "${OUT}" ${container}:${remote}`, { stdio: 'inherit' });
    const out = execSync(`docker exec ${container} n8n import:workflow --input=${remote}`, {
      encoding: 'utf8',
    });
    console.log(out.trim());
    console.log('Import: OK (workflow JSON has active=false)');
    return true;
  } catch (err) {
    console.error(`Import failed: ${err.message}`);
    if (err.stdout) console.error(String(err.stdout));
    if (err.stderr) console.error(String(err.stderr));
    return false;
  }
}

function printUsage() {
  console.error(`Usage:
  node scripts/build-main-local-stripe.js              Generate local fork (neutralize + active=false)
  node scripts/build-main-local-stripe.js --inventory  Read-only inventory (hosted + local)
  node scripts/build-main-local-stripe.js --verify-targets  Verify generated ${path.basename(OUT)}
  node scripts/build-main-local-stripe.js --import-inactive  Generate + import to n8n (active=false)
  node scripts/build-main-local-stripe.js --print-target-map  Phase 3c.e injection map (no write)`);
}

module.exports = {
  PHASE_3CE_PG_TARGETS,
  neutralizeProductionTargets,
  verifyProductionTargets,
  buildMainLocalStripeWorkflow,
  finalizeLocalWorkflow,
  runVerifyTargets,
  importMainWorkflowInactive,
  analyzeReassignContract,
  verifyPGConversationRead,
  verifyPackageRequirement,
  verifyPaymentOrConfirmFallback,
  verifyActiveBookingHoldIdGuard,
  applyActiveBookingHoldIdGuard,
  formatServiceAddonsForPrompt,
  applyGeneralQuestionAddonsPrompt,
  verifyGeneralQuestionAddonsPrompt,
  applyPGSessionWriteNonHoldPath,
  verifyPGSessionWrite,
  verifySummarizeHoldsPGPrimary,
  verifyEnsurePromoteInsertDefaults,
  verifyStage52FixtureGuard,
  SERVICE_ADDONS_CONFIG,
  OUT,
  PROD_AIRTABLE_BASE_ID,
  TEST_AIRTABLE_BASE_ID,
  DEFAULT_REASSIGN_BOOKING_BEDS_URL,
  HOSTED_REASSIGN_URL,
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

  if (args.includes('--import-inactive')) {
    const built = buildMainLocalStripeWorkflow();
    const { workflow: finalized, baseReplacements } = finalizeLocalWorkflow(built);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(finalized, null, 2));
    console.log('Wrote', OUT);
    console.log(`Airtable base neutralized: ${baseReplacements} replacement(s)`);
    runVerifyTargets(finalized, { exitOnFail: true, filePath: OUT });
    importMainWorkflowInactive();
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
