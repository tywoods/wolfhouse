const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const PHASE2_DIR = path.join(REPO_ROOT, 'n8n', 'phase2');

const FILES = {
  createPaymentSession: path.join(PHASE2_DIR, 'Wolfhouse - Create Payment Session.json'),
  stripeWebhook: path.join(PHASE2_DIR, 'Wolfhouse - Stripe Webhook Handler.json'),
  sendConfirmation: path.join(PHASE2_DIR, 'Wolfhouse - Send Confirmation (local).json'),
  mainLocal: path.join(PHASE2_DIR, 'Wolfhouse Booking Assistant - Main (local Stripe).json'),
  localStub: path.join(PHASE2_DIR, 'Wolfhouse - Create Payment Session (stub local).json'),
};

const PAYMENT_SQL_WRITE_PATTERNS = [
  /\bINSERT\s+INTO\s+payments\b/i,
  /\bUPDATE\s+payments\b/i,
  /\bDELETE\s+FROM\s+payments\b/i,
  /\bINSERT\s+INTO\s+payment_events\b/i,
  /\bUPDATE\s+payment_events\b/i,
  /\bDELETE\s+FROM\s+payment_events\b/i,
];

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, error: `missing file: ${filePath}`, json: null };
  }
  try {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { exists: true, error: null, json };
  } catch (error) {
    return { exists: true, error: `invalid json: ${error.message}`, json: null };
  }
}

function nodesOf(workflow) {
  return Array.isArray(workflow?.nodes) ? workflow.nodes : [];
}

function findWebhookPath(workflow, expectedPath) {
  const webhookNode = nodesOf(workflow).find(
    (n) => n.type === 'n8n-nodes-base.webhook' && n.parameters?.path === expectedPath
  );
  return !!webhookNode;
}

function firstCodeNodeByName(workflow, name) {
  return nodesOf(workflow).find((n) => n.type === 'n8n-nodes-base.code' && n.name === name);
}

function scanPaymentSqlWrites(workflow) {
  const hits = [];
  for (const node of nodesOf(workflow)) {
    const query = String(node.parameters?.query || '');
    if (!query) continue;
    for (const pattern of PAYMENT_SQL_WRITE_PATTERNS) {
      if (pattern.test(query)) {
        hits.push({ node: node.name, pattern: pattern.source });
        break;
      }
    }
  }
  return hits;
}

function inspectCreatePaymentSession(workflow) {
  const fileText = JSON.stringify(workflow);
  const parseReq = firstCodeNodeByName(workflow, 'Code - Parse Request');
  const stripeCreate = firstCodeNodeByName(workflow, 'Code - Stripe Create Session');
  const hasBookingIdInput =
    String(parseReq?.parameters?.jsCode || '').includes('booking_id') &&
    String(parseReq?.parameters?.jsCode || '').includes('bookingId');
  const hasPaymentKindInput = String(parseReq?.parameters?.jsCode || '').includes('payment_kind');
  const stripeCode = String(stripeCreate?.parameters?.jsCode || '');

  return {
    file_exists: true,
    webhook_path_create_payment_session: findWebhookPath(workflow, 'create-payment-session'),
    stripe_api_call_detected: /api\.stripe\.com\/v1\/checkout\/sessions/i.test(stripeCode),
    stripe_key_handling_visible:
      stripeCode.includes('STRIPE_SECRET_KEY') || fileText.includes('Stripe API (test)'),
    test_live_key_risk_visible:
      stripeCode.includes('STRIPE_SECRET_KEY') && !stripeCode.includes('sk_test')
        ? 'key source is env/credential; mode must be verified at runtime'
        : null,
    expected_request_input: {
      booking_id: hasBookingIdInput,
      payment_kind: hasPaymentKindInput,
    },
    writes_payments_or_events_detected: scanPaymentSqlWrites(workflow),
    idempotency_or_reuse_behavior_detected:
      fileText.includes('IF - Existing Checkout?') &&
      fileText.includes('existing_checkout_url') &&
      fileText.includes('"reused": true'),
    metadata_booking_id_in_checkout_creation:
      stripeCode.includes('metadata[booking_id]') || stripeCode.includes('metadata.booking_id'),
  };
}

function inspectStripeWebhook(workflow) {
  const verifyCode = String(
    firstCodeNodeByName(workflow, 'Code - Verify Signature')?.parameters?.jsCode || ''
  );
  const parseCode = String(
    firstCodeNodeByName(workflow, 'Code - Parse Stripe Event')?.parameters?.jsCode || ''
  );
  const queryText = nodesOf(workflow)
    .map((n) => String(n.parameters?.query || ''))
    .join('\n');

  return {
    file_exists: true,
    webhook_path_stripe_webhook: findWebhookPath(workflow, 'stripe-webhook'),
    signature_secret_handling_visible:
      verifyCode.includes('stripe-signature') &&
      verifyCode.includes('STRIPE_WEBHOOK_SECRET') &&
      verifyCode.includes('createHmac'),
    checkout_session_completed_handling: parseCode.includes('checkout.session.completed'),
    writes_payments_or_events_detected: scanPaymentSqlWrites(workflow),
    booking_payment_status_send_confirmation_update_visible:
      /payment_status\s*=/.test(queryText) && /send_confirmation\s*=\s*TRUE/i.test(queryText),
    sets_booking_status_confirmed_directly: /status\s*=\s*'confirmed'/i.test(queryText),
  };
}

function inspectSendConfirmation(workflow) {
  const queryText = nodesOf(workflow)
    .map((n) => String(n.parameters?.query || ''))
    .join('\n');
  const airtableNodes = nodesOf(workflow).filter((n) => n.type === 'n8n-nodes-base.airtable');
  const conversationSearch = airtableNodes.find((n) => n.name === 'Search Conversation - Confirmation');
  const bedsSearch = airtableNodes.find((n) => n.name === 'Search Booking Beds - Confirmation');
  const llmText = String(
    nodesOf(workflow).find((n) => n.name === 'Send confirmation reply')?.parameters?.text || ''
  );
  return {
    file_exists: true,
    separate_workflow: true,
    gate_visible: {
      send_confirmation_true: /send_confirmation\s*=\s*TRUE/i.test(queryText),
      status_payment_pending: /status\s*=\s*'payment_pending'/i.test(queryText),
      payment_status_paid_or_deposit_paid:
        /payment_status\s+IN\s+\('deposit_paid'.*'paid'|'paid'.*'deposit_paid'\)/is.test(queryText),
      confirmation_sent_at_null: /confirmation_sent_at\s+IS\s+NULL/i.test(queryText),
    },
    airtable_empty_fallback: {
      conversation_always_output_data: conversationSearch?.alwaysOutputData === true,
      booking_beds_always_output_data: bedsSearch?.alwaysOutputData === true,
      language_fallback_to_format_node:
        llmText.includes("$('Code - Format Booking For LLM').first().json.language"),
    },
  };
}

function inspectMainContract(workflow) {
  const callCreate = firstCodeNodeByName(workflow, 'Code - Call Create Payment Session');
  const code = String(callCreate?.parameters?.jsCode || '');
  return {
    file_exists: true,
    env_url_fallback_visible:
      code.includes('N8N_CREATE_PAYMENT_SESSION_URL') &&
      code.includes('http://localhost:5678/webhook/create-payment-session'),
    request_body_booking_id_payment_kind:
      code.includes('booking_id: bookingId') && code.includes("payment_kind: 'deposit_only'"),
    writes_payments_or_events_detected: scanPaymentSqlWrites(workflow),
  };
}

function buildStripeContractInventory() {
  const loaded = Object.fromEntries(
    Object.entries(FILES).map(([k, p]) => [k, { path: p, ...loadJson(p) }])
  );

  const errors = [];
  const warnings = [];
  for (const [key, v] of Object.entries(loaded)) {
    if (!v.exists) errors.push(`${key}: ${v.error}`);
    else if (v.error) errors.push(`${key}: ${v.error}`);
  }
  if (errors.length) {
    return {
      ok: false,
      read_only: true,
      no_mutations: true,
      errors,
      warnings,
      files: loaded,
    };
  }

  const cps = inspectCreatePaymentSession(loaded.createPaymentSession.json);
  const webhook = inspectStripeWebhook(loaded.stripeWebhook.json);
  const sendConf = inspectSendConfirmation(loaded.sendConfirmation.json);
  const main = inspectMainContract(loaded.mainLocal.json);
  const stub = {
    file_exists: true,
    webhook_path_create_payment_session_stub_local: findWebhookPath(
      loaded.localStub.json,
      'create-payment-session-stub-local'
    ),
    example_test_checkout_url_visible: JSON.stringify(loaded.localStub.json).includes('example.test'),
  };

  if (!cps.webhook_path_create_payment_session) errors.push('create payment session webhook path mismatch');
  if (!webhook.webhook_path_stripe_webhook) errors.push('stripe webhook path mismatch');
  if (!main.env_url_fallback_visible) errors.push('main create-payment-session env/fallback contract missing');
  if (webhook.sets_booking_status_confirmed_directly) {
    errors.push('stripe webhook should not set bookings.status=confirmed directly');
  }
  const scFallback = sendConf.airtable_empty_fallback;
  if (!scFallback.conversation_always_output_data) {
    errors.push('send confirmation: Search Conversation must set alwaysOutputData=true');
  }
  if (!scFallback.booking_beds_always_output_data) {
    errors.push('send confirmation: Search Booking Beds must set alwaysOutputData=true');
  }
  if (!scFallback.language_fallback_to_format_node) {
    errors.push('send confirmation: LLM prompt must fall back to Code - Format Booking For LLM language');
  }
  if (cps.test_live_key_risk_visible) warnings.push(cps.test_live_key_risk_visible);
  if (!webhook.signature_secret_handling_visible) warnings.push('stripe webhook signature handling not fully visible');
  if (!cps.idempotency_or_reuse_behavior_detected) warnings.push('idempotency/reuse behavior not clearly detected');

  const report = {
    ok: errors.length === 0,
    read_only: true,
    no_mutations: true,
    errors,
    warnings,
    files: Object.fromEntries(
      Object.entries(loaded).map(([k, v]) => [k, { path: v.path, exists: v.exists }])
    ),
    create_payment_session_contract: cps,
    stripe_webhook_contract: webhook,
    send_confirmation_contract: sendConf,
    main_contract: main,
    local_stub_contract: stub,
  };
  return report;
}

function printStripeContractSummary(report) {
  console.log('\n=== Phase 3d.2 — Stripe contract checker (read-only) ===\n');
  console.log(`read_only: ${report.read_only} | no_mutations: ${report.no_mutations}`);
  console.log('');
  console.log('Create Payment Session:');
  console.log(`  file_exists=${report.create_payment_session_contract.file_exists}`);
  console.log(
    `  webhook_path_ok=${report.create_payment_session_contract.webhook_path_create_payment_session}`
  );
  console.log(
    `  stripe_api_call_detected=${report.create_payment_session_contract.stripe_api_call_detected}`
  );
  console.log(
    `  request_input.booking_id=${report.create_payment_session_contract.expected_request_input.booking_id}`
  );
  console.log(
    `  request_input.payment_kind=${report.create_payment_session_contract.expected_request_input.payment_kind}`
  );
  console.log(
    `  idempotency_or_reuse_detected=${report.create_payment_session_contract.idempotency_or_reuse_behavior_detected}`
  );
  console.log(
    `  metadata.booking_id_in_checkout=${report.create_payment_session_contract.metadata_booking_id_in_checkout_creation}`
  );
  console.log('');
  console.log('Stripe Webhook Handler:');
  console.log(`  file_exists=${report.stripe_webhook_contract.file_exists}`);
  console.log(`  webhook_path_ok=${report.stripe_webhook_contract.webhook_path_stripe_webhook}`);
  console.log(
    `  signature_handling_visible=${report.stripe_webhook_contract.signature_secret_handling_visible}`
  );
  console.log(
    `  checkout.session.completed_handling=${report.stripe_webhook_contract.checkout_session_completed_handling}`
  );
  console.log(
    `  sets_booking_status_confirmed_directly=${report.stripe_webhook_contract.sets_booking_status_confirmed_directly}`
  );
  console.log('');
  console.log('Send Confirmation:');
  const g = report.send_confirmation_contract.gate_visible;
  console.log(`  file_exists=${report.send_confirmation_contract.file_exists}`);
  console.log(`  gate.send_confirmation_true=${g.send_confirmation_true}`);
  console.log(`  gate.status_payment_pending=${g.status_payment_pending}`);
  console.log(`  gate.payment_status_paid_or_deposit_paid=${g.payment_status_paid_or_deposit_paid}`);
  console.log(`  gate.confirmation_sent_at_null=${g.confirmation_sent_at_null}`);
  const f = report.send_confirmation_contract.airtable_empty_fallback;
  console.log(
    `  airtable.conversation_always_output_data=${f.conversation_always_output_data}`
  );
  console.log(`  airtable.booking_beds_always_output_data=${f.booking_beds_always_output_data}`);
  console.log(`  llm.language_fallback_to_format_node=${f.language_fallback_to_format_node}`);
  console.log('');
  console.log('Main workflow contract:');
  console.log(`  env_url_fallback_visible=${report.main_contract.env_url_fallback_visible}`);
  console.log(
    `  request_body_booking_id_payment_kind=${report.main_contract.request_body_booking_id_payment_kind}`
  );
  console.log(
    `  payments_write_hits=${report.main_contract.writes_payments_or_events_detected.length}`
  );
  console.log('');
  if (report.warnings.length) {
    console.log('Warnings:');
    for (const w of report.warnings) console.log(`  - ${w}`);
    console.log('');
  }
  if (report.errors.length) {
    console.log('FAIL:');
    for (const e of report.errors) console.log(`  - ${e}`);
  } else {
    console.log(`Overall OK: ${report.ok}`);
  }
}

module.exports = {
  buildStripeContractInventory,
  printStripeContractSummary,
};

