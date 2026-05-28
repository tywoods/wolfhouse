/**
 * Phase 3c.f.2 — read-only static contract checks for Main payment path.
 */
const {
  loadWorkflowJson,
  listNodes,
  buildRouteMap,
  nodeRouteTags,
} = require('./main-workflow-inventory');

const REQUIRED_PAYMENT_PATH_NODES = [
  'Code - Extract Guest Details',
  'IF - Should Search Hold',
  'Search Hold With Guest Details',
  'IF - Hold Found',
  'Update Hold With Guest Details',
  'Code - Prepare Stripe Payment Context',
  'IF - Use Stripe Checkout',
  'Postgres - Ensure Booking In Postgres',
  'IF - Booking ID Ready',
  'Code - Call Create Payment Session',
  'IF - Checkout URL Ready',
  'Update Booking - Stripe Payment Link',
];

const PAYMENT_WRITE_PATTERNS = [
  /\bINSERT\s+INTO\s+payments\b/i,
  /\bUPDATE\s+payments\b/i,
  /\bDELETE\s+FROM\s+payments\b/i,
  /\bINSERT\s+INTO\s+payment_events\b/i,
  /\bUPDATE\s+payment_events\b/i,
  /\bDELETE\s+FROM\s+payment_events\b/i,
];

function findNode(workflow, name) {
  return listNodes(workflow).find((n) => n.name === name) || null;
}

function nodeExistsMap(workflow, names) {
  const out = {};
  for (const name of names) out[name] = !!findNode(workflow, name);
  return out;
}

function scanForbiddenPaymentWrites(workflow) {
  const hits = [];
  for (const node of listNodes(workflow)) {
    const blob = JSON.stringify(node.parameters || {});
    for (const re of PAYMENT_WRITE_PATTERNS) {
      if (re.test(blob)) {
        hits.push({ node: node.name, pattern: re.source });
        break;
      }
    }
  }
  return hits;
}

function analyzeCreatePaymentSessionContract(workflow) {
  const node = findNode(workflow, 'Code - Call Create Payment Session');
  if (!node?.parameters?.jsCode) {
    return { present: false, uses_env_url: false, uses_local_fallback_url: false, sends_booking_id: false, sends_payment_kind_deposit_only: false, direct_stripe_api_call_in_main: false };
  }
  const js = String(node.parameters.jsCode);
  return {
    present: true,
    uses_env_url: js.includes('N8N_CREATE_PAYMENT_SESSION_URL'),
    uses_local_fallback_url: js.includes('http://localhost:5678/webhook/create-payment-session'),
    sends_booking_id: /\bbooking_id\s*:\s*bookingId\b/.test(js),
    sends_payment_kind_deposit_only: /payment_kind\s*:\s*['"]deposit_only['"]/.test(js),
    direct_stripe_api_call_in_main: /api\.stripe\.com|stripe\.com\/v1/.test(js),
  };
}

function analyzeEnsureNodeContract(workflow) {
  const node = findNode(workflow, 'Postgres - Ensure Booking In Postgres');
  const sql = String(node?.parameters?.query || '');
  const qr = String(node?.parameters?.options?.queryReplacement || '');
  const qrCount = qr ? qr.split(',={{').length : 0;
  return {
    present: !!node,
    query_replacement_count: qrCount,
    uses_null_sentinel: qr.includes('__NULL__') || sql.includes('__NULL__'),
    returns_booking_id: /booking_id/.test(sql),
    blocks_terminal_statuses: /confirmed|checked_in|cancelled|expired/.test(sql),
    writes_payments_or_events: PAYMENT_WRITE_PATTERNS.some((re) => re.test(sql)),
    promotes_hold_to_payment_pending: /hold/.test(sql) && /payment_pending/.test(sql) && /waiting_payment/.test(sql),
  };
}

function analyzeMainTriggers(workflow) {
  const webhookNode = findNode(workflow, 'Code - Call Create Payment Session');
  const sendConfirmationRefs = [];
  for (const node of listNodes(workflow)) {
    const blob = JSON.stringify(node.parameters || {});
    if (/Send Confirmation|send-confirmation/i.test(blob) || /send_confirmation/i.test(blob)) {
      sendConfirmationRefs.push(node.name);
    }
  }
  return {
    has_create_payment_session_node: !!webhookNode,
    send_confirmation_references: [...new Set(sendConfirmationRefs)],
  };
}

function collectWarnings(report) {
  const warnings = [];
  warnings.push('Hosted reassign URL warning remains deferred (rooming nodes still reference hosted reassign webhook).');
  warnings.push('Airtable hold lookup remains in payment path (Search Hold With Guest Details).');
  warnings.push('Current Hold ID code (booking_code) vs PG UUID linkage remains a drift risk across systems.');
  warnings.push('Duplicate checkout-session risk depends on Create Payment Session idempotency behavior.');
  if (!report.create_payment_session_contract.sends_booking_id) {
    warnings.push('Create Payment Session call does not appear to send booking_id as expected.');
  }
  if (report.create_payment_session_contract.direct_stripe_api_call_in_main) {
    warnings.push('Potential direct Stripe API call detected in Main workflow code path.');
  }
  if (report.forbidden_payment_write_hits.length) {
    warnings.push('Forbidden payments/payment_events writer detected in Main workflow.');
  }
  return warnings;
}

function buildMainPaymentContractReport(workflow, workflowFile) {
  const routeMap = buildRouteMap(workflow);
  const nodePresence = nodeExistsMap(workflow, REQUIRED_PAYMENT_PATH_NODES);
  const missingNodes = REQUIRED_PAYMENT_PATH_NODES.filter((n) => !nodePresence[n]);

  const routeHints = {};
  for (const name of REQUIRED_PAYMENT_PATH_NODES) {
    routeHints[name] = nodeRouteTags(name, routeMap);
  }

  const forbiddenHits = scanForbiddenPaymentWrites(workflow);
  const createPaymentContract = analyzeCreatePaymentSessionContract(workflow);
  const ensureContract = analyzeEnsureNodeContract(workflow);
  const triggerAudit = analyzeMainTriggers(workflow);

  const report = {
    phase: '3c.f.2',
    read_only: true,
    no_mutations: true,
    workflow_file: workflowFile,
    workflow_name: workflow.name,
    payment_path: {
      required_nodes: REQUIRED_PAYMENT_PATH_NODES,
      node_presence: nodePresence,
      missing_nodes: missingNodes,
      route_hints: routeHints,
    },
    create_payment_session_contract: createPaymentContract,
    ensure_node_contract: ensureContract,
    forbidden_payment_write_hits: forbiddenHits,
    send_confirmation_trigger_audit: triggerAudit,
  };

  report.warnings = collectWarnings(report);
  report.ok = missingNodes.length === 0 && forbiddenHits.length === 0 && !createPaymentContract.direct_stripe_api_call_in_main;
  return report;
}

function runMainPaymentContractInventory({ workflowPath }) {
  const load = loadWorkflowJson(workflowPath);
  if (load.error) {
    return { error: load.error, report: null };
  }
  return {
    error: null,
    report: buildMainPaymentContractReport(load.workflow, workflowPath),
  };
}

function printConsoleSummary(report) {
  console.log('\n=== Phase 3c.f.2 — Main payment contract checker (read-only) ===\n');
  console.log(`Workflow: ${report.workflow_name}`);
  console.log(`File: ${report.workflow_file}`);
  console.log(`read_only: ${report.read_only} | no_mutations: ${report.no_mutations}`);
  console.log(`Path nodes missing: ${report.payment_path.missing_nodes.length}`);
  if (report.payment_path.missing_nodes.length) {
    for (const n of report.payment_path.missing_nodes) console.log(`  - MISSING: ${n}`);
  }
  const cps = report.create_payment_session_contract;
  console.log('\nCreate Payment Session contract:');
  console.log(`  present=${cps.present}`);
  console.log(`  env_url=${cps.uses_env_url} fallback_local=${cps.uses_local_fallback_url}`);
  console.log(`  booking_id=${cps.sends_booking_id} payment_kind_deposit_only=${cps.sends_payment_kind_deposit_only}`);
  console.log(`  direct_stripe_api_call_in_main=${cps.direct_stripe_api_call_in_main}`);

  const ens = report.ensure_node_contract;
  console.log('\nEnsure node contract:');
  console.log(`  present=${ens.present} query_replacement_count=${ens.query_replacement_count}`);
  console.log(`  returns_booking_id=${ens.returns_booking_id} blocks_terminal_statuses=${ens.blocks_terminal_statuses}`);
  console.log(`  promote_hold_to_payment_pending=${ens.promotes_hold_to_payment_pending}`);
  console.log(`  writes_payments_or_events=${ens.writes_payments_or_events}`);

  console.log(`\nForbidden payment write hits: ${report.forbidden_payment_write_hits.length}`);
  for (const hit of report.forbidden_payment_write_hits) {
    console.log(`  - ${hit.node} (${hit.pattern})`);
  }

  console.log('\nWarnings/Risks:');
  for (const w of report.warnings) console.log(`  - ${w}`);

  console.log(`\nOverall OK: ${report.ok}`);
}

module.exports = {
  REQUIRED_PAYMENT_PATH_NODES,
  runMainPaymentContractInventory,
  buildMainPaymentContractReport,
  printConsoleSummary,
};

