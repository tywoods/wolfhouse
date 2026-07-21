'use strict';

/**
 * radar-slice16t-e2e-correlation-drill — RADAR Slice 16T locks + harness core.
 *
 * Staging-only, dry-run-default correlation-drill harness for G01.
 * Source-partial only: does not execute or claim the live Meta→Hermes→Staff→Stripe
 * drill. Live apply requires --apply plus exact confirmation
 * RADAR-16T-CORRELATION-DRILL and still fails closed if any boundary cannot
 * preserve the same correlation ID without a guest/payment mutation.
 */

const crypto = require('crypto');
const path = require('path');
const { URL } = require('url');

const MASTER_BASIS = '87121456db90a9f80ff8b3679596bc49c235cbfc';
const IMAGE_SHA_FULL = MASTER_BASIS;
const IMAGE_SHA_SHORT = '87121456';
const SLICE = 'RADAR-16T';
const OUTCOME_ID = '16T_e2e_correlation_drill_harness';
const GATE_ID = 'G01_correlation_structured_logs';
const PROGRESS_CLASS = 'source_partial_progress_only';
const BRANCH = 'radar/slice-16t-e2e-correlation-drill';

const CONFIRMATION_PHRASE = 'RADAR-16T-CORRELATION-DRILL';
const CORRELATION_HEADER = 'x-request-id';
const CORRELATION_HEADER_CANON = 'X-Request-Id';

const CONTRACT_REL = 'fixtures/radar-operations/slice16t-expected-contract.json';
const BOUNDARY_MAP_REL = 'fixtures/radar-operations/slice16t-boundary-map.json';

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
const ALLOWED_TENANTS = Object.freeze(['wolfhouse', 'sunset']);
const ALLOWED_RESOURCE_GROUPS = Object.freeze([
  'wh-staging-rg',
  'luna-sunset-staging-rg',
]);

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Bounded Meta-shaped envelope keys only (no guest PII values in evidence). */
const META_SHAPED_OBJECT = 'whatsapp_business_account';

const TENANT_LOCKS = Object.freeze({
  wolfhouse: Object.freeze({
    tenant: 'wolfhouse',
    client_slug: 'wolfhouse-somo',
    resource_group: 'wh-staging-rg',
    staff_public_host: 'staff-staging.lunafrontdesk.com',
    staff_app: 'wh-staging-staff-api',
    staff_base_url: 'https://staff-staging.lunafrontdesk.com',
    hermes_public_host: 'lunabox.lunafrontdesk.com',
    hermes_container: 'hermes-luna',
    hermes_port: 8090,
    hermes_webhook_path: '/whatsapp/webhook',
    hermes_webhook_url: 'https://lunabox.lunafrontdesk.com/whatsapp/webhook',
    hermes_role: 'luna',
    phone_number_id_env: 'WHATSAPP_CLOUD_PHONE_NUMBER_ID',
    /** Open-demo staging fixture id only — not a production Meta number. */
    phone_number_id_fixture_sample: '1152900101233109',
    stripe_mode: 'test',
    stripe_webhook_client_slug: null,
    stripe_webhook_path: '/staff/stripe/webhook',
    meta_webhook_path: '/staff/meta/whatsapp/webhook',
    healthz_path: '/healthz',
  }),
  sunset: Object.freeze({
    tenant: 'sunset',
    client_slug: 'sunset',
    resource_group: 'luna-sunset-staging-rg',
    staff_public_host: 'sunset-staging.lunafrontdesk.com',
    staff_app: 'luna-sunset-staging-staff-api',
    staff_base_url: 'https://sunset-staging.lunafrontdesk.com',
    hermes_public_host: null,
    hermes_container: 'hermes-sunset-luna',
    hermes_port: 8092,
    hermes_webhook_path: '/whatsapp/webhook',
    hermes_webhook_url: 'http://127.0.0.1:8092/whatsapp/webhook',
    hermes_probe_mode: 'lunabox_local_only',
    hermes_role: 'sunset-luna',
    phone_number_id_env: 'SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID',
    phone_number_id_fixture_sample: null,
    stripe_mode: 'test',
    stripe_webhook_client_slug: 'sunset',
    stripe_webhook_path: '/staff/stripe/webhook',
    meta_webhook_path: '/staff/meta/whatsapp/webhook',
    healthz_path: '/healthz',
  }),
});

const BOUNDARY_IDS = Object.freeze([
  'meta_shaped_ingress',
  'hermes_gateway',
  'staff_api',
  'stripe_test_mode',
]);

const ALLOWLISTED_PROBES = Object.freeze({
  meta_shaped_ingress: Object.freeze({
    id: 'meta_shaped_ingress',
    description:
      'Meta-shaped unsigned POST to Staff dual-ingress webhook (signature fail-closed; no guest write)',
    method: 'POST',
    path_key: 'meta_webhook_path',
    host_key: 'staff_base_url',
    expects_status_class: '4xx',
    mutation: false,
    requires_correlation_echo: true,
  }),
  hermes_gateway: Object.freeze({
    id: 'hermes_gateway',
    description:
      'Synthetic Meta-shaped unsigned POST to Hermes WhatsApp webhook; must echo X-Request-Id without guest send',
    method: 'POST',
    path_key: 'hermes_webhook_path',
    url_key: 'hermes_webhook_url',
    expects_status_class: 'any_non_mutating',
    mutation: false,
    requires_correlation_echo: true,
  }),
  staff_api: Object.freeze({
    id: 'staff_api',
    description: 'Staff API GET /healthz with operator X-Request-Id (16J/16S)',
    method: 'GET',
    path_key: 'healthz_path',
    host_key: 'staff_base_url',
    expects_status_class: '2xx',
    mutation: false,
    requires_correlation_echo: true,
  }),
  stripe_test_mode: Object.freeze({
    id: 'stripe_test_mode',
    description:
      'Staff Stripe webhook POST with missing signature (16O pre-verify; no payment_events write)',
    method: 'POST',
    path_key: 'stripe_webhook_path',
    host_key: 'staff_base_url',
    expects_status_class: '4xx',
    mutation: false,
    requires_correlation_echo: true,
  }),
});

const FORBIDDEN_MUTATION_PATHS = Object.freeze([
  '/staff/bot/open-demo-whatsapp-inbound-dry-run',
  '/staff/test/reset-luna-phone',
  '/staff/payments',
  '/staff/bot/create',
  '/staff/bot/hold',
  '/staff/bot/generate-guest-payment-link',
  '/staff/guest-simulator-create-stripe-test-link',
  '/staff/guest-simulator-create-hold-draft',
  'checkout.session',
  'payment_intent',
  'sk_live_',
]);

const FORBIDDEN_INGRESS = Object.freeze([
  'production_meta_webhook',
  'signed_live_guest_message',
  'hermes_staff_bot_tool_booking',
  'hermes_staff_bot_payment_link',
  'valid_stripe_checkout_completed',
  'whatsapp_cloud_send',
]);

const PRODUCTION_HOST_FRAGMENTS = Object.freeze([
  'hermes.lunafrontdesk.com',
  'staff.lunafrontdesk.com',
  'api.lunafrontdesk.com',
  'wolfhouse.es',
  'prod',
]);

const SENSITIVE_FORBIDDEN_KEYS = Object.freeze([
  'authorization',
  'cookie',
  'cookies',
  'body',
  'raw_body',
  'query',
  'raw_url',
  'ip',
  'user_agent',
  'email',
  'phone',
  'guest',
  'customer',
  'token',
  'key',
  'secret',
  'stripe_signature',
  'stripe_payload',
  'stack',
  'error_text',
  'exception',
  'db_error',
  'response_body',
  'whatsapp_text',
  'message_text',
]);

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'live_e2e_correlation_drill_executed',
  'live_e2e_correlation_drill_proven',
  'any_gate_verdict_proven',
  'g02_g09_score_changes',
  'production',
  'bookings_holds_payment_links_charges',
  'guest_whatsapp_send',
  'hermes_x_request_id_forward_to_staff_bot',
  'concurrent_isolation',
  'abort_error_outcomes_in_law',
]);

const GATES_UNCHANGED = Object.freeze([
  'G02_readiness_dependencies',
  'G03_actionable_tenant_aware_alerts',
  'G04_webhook_payment_worker_backlog',
  'G05_retry_replay_safety',
  'G06_scaling_capacity',
  'G07_rollback_incident_runbooks',
  'G08_retention_privacy',
  'G09_cost_controls',
]);

const OWNED_RELS = Object.freeze([
  CONTRACT_REL,
  BOUNDARY_MAP_REL,
  'scripts/lib/radar-slice16t-e2e-correlation-drill.js',
  'scripts/run-radar-slice16t-e2e-correlation-drill.js',
  'scripts/verify-radar-slice16t-e2e-correlation-drill.js',
  'docs/RADAR-OPERATIONS-GATE-LEDGER.md',
  'fixtures/radar-operations/gate-matrix.json',
  'fixtures/radar-operations/contract.json',
  'fixtures/radar-operations/findings.md',
]);

const MUST_NOT_MUTATE = Object.freeze([
  'database/',
  'docker/hermes-staging/',
  'docker/hermes-sunset/',
  'scripts/staff-query-api.js',
  'scripts/lib/staff-api-request-correlation.js',
  'scripts/lib/staff-api-request-completion-log.js',
  'scripts/lib/stripe-webhook-public-errors.js',
  'infra/azure/staging/main.bicep',
  'infra/azure/sunset-staging/main.bicep',
  'infra/azure/staging-staff-api-metric-alerts/',
  'infra/azure/staging-cost-budgets/',
]);

function generateCorrelationId() {
  return crypto.randomUUID();
}

function isUuidV4(value) {
  return typeof value === 'string' && UUID_V4_RE.test(value);
}

function normalizeCorrelationId(value) {
  if (!isUuidV4(value)) return null;
  return String(value).toLowerCase();
}

function getTenantLock(tenant) {
  const key = String(tenant || '').trim().toLowerCase();
  if (!ALLOWED_TENANTS.includes(key)) return null;
  return TENANT_LOCKS[key];
}

function isProductionHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return false;
  if (h === 'staff-staging.lunafrontdesk.com') return false;
  if (h === 'sunset-staging.lunafrontdesk.com') return false;
  if (h === 'lunabox.lunafrontdesk.com') return false;
  if (h === '127.0.0.1' || h === 'localhost') return false;
  return PRODUCTION_HOST_FRAGMENTS.some((frag) => h.includes(frag));
}

function assertStagingUrl(urlString, tenantLock) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch (_) {
    return { ok: false, code: 'invalid_url', detail: String(urlString) };
  }
  if (isProductionHost(parsed.hostname)) {
    return { ok: false, code: 'production_host_refused', detail: parsed.hostname };
  }
  const allowedHosts = new Set([
    tenantLock.staff_public_host,
    tenantLock.hermes_public_host,
    '127.0.0.1',
    'localhost',
  ].filter(Boolean));
  if (!allowedHosts.has(parsed.hostname)) {
    return { ok: false, code: 'host_not_hard_locked', detail: parsed.hostname };
  }
  return { ok: true, hostname: parsed.hostname };
}

function buildMetaShapedEnvelope(tenantLock) {
  const phoneNumberId = tenantLock.phone_number_id_fixture_sample || '000000000000000';
  return {
    object: META_SHAPED_OBJECT,
    entry: [
      {
        id: 'RADAR16T_SYNTHETIC',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '00000000000',
                phone_number_id: phoneNumberId,
              },
              contacts: [],
              messages: [],
            },
          },
        ],
      },
    ],
  };
}

function buildDryRunPlan(opts) {
  const options = opts || {};
  const tenantLock = getTenantLock(options.tenant);
  if (!tenantLock) {
    return {
      ok: false,
      mode: 'dry-run',
      refused: true,
      reason: 'unsupported_tenant',
      detail: options.tenant,
      allowed_tenants: [...ALLOWED_TENANTS],
    };
  }
  const correlationId =
    normalizeCorrelationId(options.correlationId) || generateCorrelationId();

  const probes = BOUNDARY_IDS.map((id) => {
    const probe = ALLOWLISTED_PROBES[id];
    const pathValue = tenantLock[probe.path_key];
    const url =
      probe.url_key
        ? tenantLock[probe.url_key]
        : `${tenantLock[probe.host_key]}${pathValue}`;
    return {
      boundary: id,
      method: probe.method,
      url,
      path: pathValue,
      mutation: false,
      requires_correlation_echo: true,
      correlation_header: CORRELATION_HEADER_CANON,
      correlation_id: correlationId,
      description: probe.description,
    };
  });

  return {
    ok: true,
    mode: 'dry-run',
    live_mutation: false,
    slice: SLICE,
    outcome_id: OUTCOME_ID,
    gate_id: GATE_ID,
    progress_class: PROGRESS_CLASS,
    confirmation_required_for_apply: CONFIRMATION_PHRASE,
    tenant: tenantLock.tenant,
    hard_locks: {
      subscription_id: SUBSCRIPTION_ID,
      resource_group: tenantLock.resource_group,
      client_slug: tenantLock.client_slug,
      staff_public_host: tenantLock.staff_public_host,
      staff_app: tenantLock.staff_app,
      hermes_container: tenantLock.hermes_container,
      hermes_port: tenantLock.hermes_port,
      hermes_webhook_url: tenantLock.hermes_webhook_url,
      hermes_probe_mode: tenantLock.hermes_probe_mode || 'public_caddy',
      phone_number_id_env: tenantLock.phone_number_id_env,
      stripe_mode: tenantLock.stripe_mode,
      stripe_webhook_client_slug: tenantLock.stripe_webhook_client_slug,
      master_basis: MASTER_BASIS,
      image_sha_full: IMAGE_SHA_FULL,
      image_sha_short: IMAGE_SHA_SHORT,
    },
    correlation_id: correlationId,
    boundaries: [...BOUNDARY_IDS],
    probes,
    forbidden_mutation_paths: [...FORBIDDEN_MUTATION_PATHS],
    forbidden_ingress: [...FORBIDDEN_INGRESS],
    note:
      'Dry-run only: zero HTTP. Live mode requires --apply plus exact confirmation RADAR-16T-CORRELATION-DRILL. Fail closed if any boundary cannot preserve the same correlation ID without a guest/payment mutation.',
    explicitly_not_claimed: [...EXPLICITLY_NOT_CLAIMED],
  };
}

function evaluateApplyGate(opts) {
  const options = opts || {};
  const errors = [];
  const applyRequested = options.applyRequested === true;
  const confirmation = String(options.confirmation || '');

  if (!applyRequested) {
    errors.push({
      code: 'apply_flag_required',
      message: 'live probes require explicit --apply (default is dry-run)',
    });
  }
  if (confirmation !== CONFIRMATION_PHRASE) {
    errors.push({
      code: 'confirmation_mismatch',
      message: `exact confirmation ${CONFIRMATION_PHRASE} required with --apply`,
    });
  }

  const tenantLock = getTenantLock(options.tenant);
  if (!tenantLock) {
    errors.push({
      code: 'unsupported_tenant',
      message: 'tenant must be wolfhouse|sunset',
    });
  } else {
    if (!ALLOWED_RESOURCE_GROUPS.includes(tenantLock.resource_group)) {
      errors.push({ code: 'resource_group_not_staging', message: tenantLock.resource_group });
    }
    if (tenantLock.stripe_mode !== 'test') {
      errors.push({ code: 'stripe_mode_not_test', message: String(tenantLock.stripe_mode) });
    }
    const staffCheck = assertStagingUrl(tenantLock.staff_base_url, tenantLock);
    if (!staffCheck.ok) errors.push({ code: staffCheck.code, message: staffCheck.detail });
    const hermesCheck = assertStagingUrl(tenantLock.hermes_webhook_url, tenantLock);
    if (!hermesCheck.ok) errors.push({ code: hermesCheck.code, message: hermesCheck.detail });
  }

  if (options.stripeMode && String(options.stripeMode).toLowerCase() === 'live') {
    errors.push({ code: 'real_stripe_mode_refused', message: 'stripe live mode forbidden' });
  }
  if (options.subscriptionId && options.subscriptionId !== SUBSCRIPTION_ID) {
    errors.push({ code: 'subscription_mismatch', message: options.subscriptionId });
  }
  if (options.imageShaFull && options.imageShaFull !== IMAGE_SHA_FULL) {
    errors.push({ code: 'image_sha_mismatch', message: options.imageShaFull });
  }
  if (options.masterBasis && options.masterBasis !== MASTER_BASIS) {
    errors.push({ code: 'master_basis_mismatch', message: options.masterBasis });
  }
  if (options.productionHost === true) {
    errors.push({ code: 'production_host_refused', message: 'production hosts forbidden' });
  }
  if (options.ingressKind && FORBIDDEN_INGRESS.includes(String(options.ingressKind))) {
    errors.push({ code: 'unsupported_ingress', message: options.ingressKind });
  }
  if (options.mutationPath) {
    const p = String(options.mutationPath);
    if (FORBIDDEN_MUTATION_PATHS.some((frag) => p.includes(frag))) {
      errors.push({ code: 'mutation_capable_path_refused', message: p });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    confirmation_phrase: CONFIRMATION_PHRASE,
    subscription_id: SUBSCRIPTION_ID,
    master_basis: MASTER_BASIS,
    image_sha_full: IMAGE_SHA_FULL,
  };
}

/**
 * Evaluate bounded redacted hop evidence for one correlation ID.
 * Fail closed on missing echo, ID substitution, duplicates, sensitive fields,
 * or mutation-capable paths.
 */
function evaluateCorrelationEvidence(evidence) {
  const ev = evidence || {};
  const errors = [];
  const correlationId = normalizeCorrelationId(ev.correlation_id);
  if (!correlationId) {
    return {
      ok: false,
      fail_closed: true,
      code: 'missing_correlation',
      errors: ['correlation_id missing or not uuidv4'],
    };
  }

  const tenantLock = getTenantLock(ev.tenant);
  if (!tenantLock) {
    return {
      ok: false,
      fail_closed: true,
      code: 'wrong_scope',
      errors: [`unsupported tenant ${ev.tenant}`],
    };
  }

  if (ev.stripe_mode && String(ev.stripe_mode).toLowerCase() !== 'test') {
    errors.push('real_stripe_mode');
  }
  if (ev.subscription_id && ev.subscription_id !== SUBSCRIPTION_ID) {
    errors.push('wrong_scope_subscription');
  }
  if (ev.resource_group && ev.resource_group !== tenantLock.resource_group) {
    errors.push('wrong_scope_resource_group');
  }
  if (ev.staff_app && ev.staff_app !== tenantLock.staff_app) {
    errors.push('wrong_scope_staff_app');
  }
  if (ev.client_slug && ev.client_slug !== tenantLock.client_slug) {
    errors.push('wrong_scope_client_slug');
  }
  if (ev.image_sha_full && ev.image_sha_full !== IMAGE_SHA_FULL) {
    errors.push('image_sha_mismatch');
  }
  if (ev.master_basis && ev.master_basis !== MASTER_BASIS) {
    errors.push('master_basis_mismatch');
  }

  const hops = Array.isArray(ev.hops) ? ev.hops : null;
  if (!hops) {
    return {
      ok: false,
      fail_closed: true,
      code: 'missing_hops',
      errors: ['hops array required'],
    };
  }

  const seenBoundaries = new Set();
  for (const hop of hops) {
    if (!hop || typeof hop !== 'object') {
      errors.push('invalid_hop');
      continue;
    }
    const bid = hop.boundary;
    if (!BOUNDARY_IDS.includes(bid)) {
      errors.push(`unknown_boundary:${bid}`);
      continue;
    }
    if (seenBoundaries.has(bid)) {
      errors.push(`duplicate_record:${bid}`);
      continue;
    }
    seenBoundaries.add(bid);

    if (hop.mutation === true) {
      errors.push(`mutation_capable_path:${bid}`);
    }
    if (hop.path && FORBIDDEN_MUTATION_PATHS.some((frag) => String(hop.path).includes(frag))) {
      errors.push(`mutation_capable_path:${bid}`);
    }
    if (hop.ingress_kind && FORBIDDEN_INGRESS.includes(String(hop.ingress_kind))) {
      errors.push(`unsupported_ingress:${hop.ingress_kind}`);
    }
    if (hop.host && isProductionHost(hop.host)) {
      errors.push(`production_host:${hop.host}`);
    }

    const echoed = normalizeCorrelationId(hop.response_x_request_id);
    if (!echoed) {
      errors.push(`missing_correlation_echo:${bid}`);
    } else if (echoed !== correlationId) {
      errors.push(`id_substitution:${bid}`);
    }

    if (hop.completion_request_id) {
      const completionId = normalizeCorrelationId(hop.completion_request_id);
      if (!completionId) {
        errors.push(`missing_completion_correlation:${bid}`);
      } else if (completionId !== correlationId) {
        errors.push(`id_substitution_completion:${bid}`);
      }
    }

    for (const key of Object.keys(hop)) {
      if (SENSITIVE_FORBIDDEN_KEYS.includes(key)) {
        errors.push(`sensitive_field:${key}`);
      }
    }
  }

  for (const bid of BOUNDARY_IDS) {
    if (!seenBoundaries.has(bid)) {
      errors.push(`missing_boundary:${bid}`);
    }
  }

  for (const key of Object.keys(ev)) {
    if (SENSITIVE_FORBIDDEN_KEYS.includes(key)) {
      errors.push(`sensitive_field:${key}`);
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      fail_closed: true,
      code: errors[0].split(':')[0],
      errors,
      correlation_id: correlationId,
      tenant: tenantLock.tenant,
    };
  }

  return {
    ok: true,
    fail_closed: false,
    code: 'correlation_preserved',
    correlation_id: correlationId,
    tenant: tenantLock.tenant,
    boundaries: [...BOUNDARY_IDS],
    note: 'All allowlisted boundaries preserved the same correlation ID without mutation-capable paths',
  };
}

function redactHopEvidence(hop) {
  const h = hop || {};
  return {
    boundary: h.boundary,
    method: h.method,
    path: h.path,
    host: h.host,
    status_code: h.status_code,
    status_class: h.status_class,
    response_x_request_id: normalizeCorrelationId(h.response_x_request_id),
    completion_request_id: h.completion_request_id
      ? normalizeCorrelationId(h.completion_request_id)
      : undefined,
    mutation: false,
    outcome: h.outcome || 'observed',
  };
}

function buildBoundaryMapFixture() {
  return {
    schema_version: 1,
    slice: SLICE,
    outcome_id: OUTCOME_ID,
    master_basis: MASTER_BASIS,
    branch: BRANCH,
    title: 'Wolfhouse + Sunset staging correlation boundary map (synthetic Meta-shaped; no live drill)',
    architecture_note:
      'Stripe does not ride through Hermes. Correlation drill proves one operator UUIDv4 across Meta-shaped Staff dual-ingress, Hermes gateway echo, Staff /healthz, and Stripe pre-verify — without bookings/holds/links/charges/guest sends.',
    subscription_id: SUBSCRIPTION_ID,
    tenants: {
      wolfhouse: { ...TENANT_LOCKS.wolfhouse },
      sunset: { ...TENANT_LOCKS.sunset },
    },
    boundaries: BOUNDARY_IDS.map((id) => ({
      id,
      ...ALLOWLISTED_PROBES[id],
    })),
    reuse: {
      staff_correlation: 'scripts/lib/staff-api-request-correlation.js',
      staff_completion: 'scripts/lib/staff-api-request-completion-log.js',
      meta_fail_closed: 'scripts/lib/meta-whatsapp-signature-config.js',
      stripe_public_errors: 'scripts/lib/stripe-webhook-public-errors.js',
      meta_shaped_envelope: 'docker/hermes-staging/wolfhouse/simulate_core.py#build_meta_webhook_payload',
    },
    forbidden_mutation_paths: [...FORBIDDEN_MUTATION_PATHS],
    forbidden_ingress: [...FORBIDDEN_INGRESS],
    fail_closed_rule:
      'Refuse if any boundary cannot preserve the same X-Request-Id without invoking a real guest/payment mutation; Hermes→Staff bot tool path is not an allowlisted correlation hop.',
  };
}

module.exports = {
  MASTER_BASIS,
  IMAGE_SHA_FULL,
  IMAGE_SHA_SHORT,
  SLICE,
  OUTCOME_ID,
  GATE_ID,
  PROGRESS_CLASS,
  BRANCH,
  CONFIRMATION_PHRASE,
  CORRELATION_HEADER,
  CORRELATION_HEADER_CANON,
  CONTRACT_REL,
  BOUNDARY_MAP_REL,
  SUBSCRIPTION_ID,
  ALLOWED_TENANTS,
  ALLOWED_RESOURCE_GROUPS,
  TENANT_LOCKS,
  BOUNDARY_IDS,
  ALLOWLISTED_PROBES,
  FORBIDDEN_MUTATION_PATHS,
  FORBIDDEN_INGRESS,
  PRODUCTION_HOST_FRAGMENTS,
  SENSITIVE_FORBIDDEN_KEYS,
  EXPLICITLY_NOT_CLAIMED,
  GATES_UNCHANGED,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  generateCorrelationId,
  isUuidV4,
  normalizeCorrelationId,
  getTenantLock,
  isProductionHost,
  assertStagingUrl,
  buildMetaShapedEnvelope,
  buildDryRunPlan,
  evaluateApplyGate,
  evaluateCorrelationEvidence,
  redactHopEvidence,
  buildBoundaryMapFixture,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
