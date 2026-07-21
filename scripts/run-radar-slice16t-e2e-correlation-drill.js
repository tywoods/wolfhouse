'use strict';

/**
 * run-radar-slice16t-e2e-correlation-drill
 *
 * Staging-only correlation-drill harness (RADAR 16T).
 * Default: dry-run plan only (zero HTTP / Azure / guest / payment mutation).
 * Live probes require --apply plus exact --confirm RADAR-16T-CORRELATION-DRILL.
 *
 * Usage:
 *   node scripts/run-radar-slice16t-e2e-correlation-drill.js --tenant wolfhouse
 *   node scripts/run-radar-slice16t-e2e-correlation-drill.js --tenant sunset
 *   node scripts/run-radar-slice16t-e2e-correlation-drill.js --tenant wolfhouse --apply --confirm RADAR-16T-CORRELATION-DRILL
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const locks = require('./lib/radar-slice16t-e2e-correlation-drill');

const ALLOWED_FLAGS = new Set([
  '--tenant',
  '--apply',
  '--confirm',
  '--correlation-id',
  '--help',
  '-h',
]);

const FORBIDDEN_FLAGS = new Set([
  '--deploy',
  '--live',
  '--mutate',
  '--send',
  '--charge',
  '--create-booking',
  '--create-hold',
  '--payment-link',
]);

function refuse(reason, detail) {
  const report = {
    ok: false,
    refused: true,
    reason,
    detail: detail || null,
    live_mutation: false,
    slice: locks.SLICE,
    note: 'Harness refused before any staging probe',
  };
  console.error(JSON.stringify(report, null, 2));
  console.error(`REFUSED: ${reason}${detail ? ` (${detail})` : ''}`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {
    tenant: null,
    apply: false,
    confirm: null,
    correlationId: null,
    help: false,
  };
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('-')) {
      refuse('unknown_positional_arg', a);
    }
    if (FORBIDDEN_FLAGS.has(a)) {
      refuse('forbidden_flag', a);
    }
    if (!ALLOWED_FLAGS.has(a)) {
      refuse('unknown_flag', a);
    }
    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }
    if (a === '--apply') {
      out.apply = true;
      continue;
    }
    if (a === '--tenant') {
      out.tenant = args[++i];
      if (!out.tenant) refuse('missing_flag_value', '--tenant');
      continue;
    }
    if (a === '--confirm') {
      out.confirm = args[++i];
      if (!out.confirm) refuse('missing_flag_value', '--confirm');
      continue;
    }
    if (a === '--correlation-id') {
      out.correlationId = args[++i];
      if (!out.correlationId) refuse('missing_flag_value', '--correlation-id');
      continue;
    }
  }
  return out;
}

function printHelp() {
  console.log(`RADAR 16T E2E correlation-drill harness (dry-run default)

Usage:
  node scripts/run-radar-slice16t-e2e-correlation-drill.js --tenant wolfhouse|sunset
  node scripts/run-radar-slice16t-e2e-correlation-drill.js --tenant <tenant> --apply --confirm ${locks.CONFIRMATION_PHRASE}

Rules:
  - Default mode is dry-run (plan only; zero HTTP).
  - Live mode requires --apply AND exact confirmation ${locks.CONFIRMATION_PHRASE}.
  - Hard-locks staging hosts, tenant, phone/runtime binding, Staff API app,
    Stripe test mode, subscription, and master/image SHA ${locks.IMAGE_SHA_SHORT}.
  - Generates one correlation ID and requires the same ID at every allowlisted boundary.
  - Fail closed if any boundary cannot preserve the ID without a guest/payment mutation.
  - Does not create bookings, holds, payment links, charges, or WhatsApp sends.
`);
}

function headerValue(headers, name) {
  if (!headers) return null;
  const want = String(name).toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === want) {
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return null;
}

function statusClass(code) {
  if (!Number.isFinite(code)) return 'unknown';
  if (code >= 200 && code < 300) return '2xx';
  if (code >= 400 && code < 500) return '4xx';
  if (code >= 500) return '5xx';
  return 'other';
}

function httpRequest(urlString, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (err) {
      reject(err);
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const body = opts.body || null;
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search || ''}`,
        method: opts.method || 'GET',
        headers: opts.headers || {},
        timeout: opts.timeoutMs || 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => {
          // Drain but do not retain bodies in evidence (privacy).
          if (chunks.length < 4) chunks.push(c);
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function executeAllowlistedProbe(tenantLock, probePlan) {
  const urlCheck = locks.assertStagingUrl(probePlan.url, tenantLock);
  if (!urlCheck.ok) {
    return {
      ok: false,
      fail_closed: true,
      boundary: probePlan.boundary,
      code: urlCheck.code,
      detail: urlCheck.detail,
    };
  }

  if (locks.FORBIDDEN_MUTATION_PATHS.some((frag) => String(probePlan.path || '').includes(frag))) {
    return {
      ok: false,
      fail_closed: true,
      boundary: probePlan.boundary,
      code: 'mutation_capable_path_refused',
      detail: probePlan.path,
    };
  }

  const headers = {
    [locks.CORRELATION_HEADER_CANON]: probePlan.correlation_id,
  };
  let body = null;
  if (probePlan.method === 'POST' && probePlan.boundary === 'meta_shaped_ingress') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(locks.buildMetaShapedEnvelope(tenantLock));
  } else if (probePlan.method === 'POST' && probePlan.boundary === 'hermes_gateway') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(locks.buildMetaShapedEnvelope(tenantLock));
  } else if (probePlan.method === 'POST' && probePlan.boundary === 'stripe_test_mode') {
    headers['Content-Type'] = 'application/json';
    // Missing stripe-signature → 16O pre-verify fail; no DB write.
    body = JSON.stringify({ id: 'evt_radar16t_synthetic_unsigned', object: 'event', type: 'radar.16t.probe' });
  }

  let res;
  try {
    res = await httpRequest(probePlan.url, {
      method: probePlan.method,
      headers,
      body,
      timeoutMs: 15000,
    });
  } catch (err) {
    return {
      ok: false,
      fail_closed: true,
      boundary: probePlan.boundary,
      code: 'probe_transport_error',
      detail: String(err && err.message ? err.message : err),
    };
  }

  const echoed = locks.normalizeCorrelationId(
    headerValue(res.headers, locks.CORRELATION_HEADER),
  );
  const hop = locks.redactHopEvidence({
    boundary: probePlan.boundary,
    method: probePlan.method,
    path: probePlan.path,
    host: urlCheck.hostname,
    status_code: res.statusCode,
    status_class: statusClass(res.statusCode),
    response_x_request_id: echoed,
    mutation: false,
    outcome: echoed === probePlan.correlation_id ? 'correlation_echoed' : 'correlation_missing_or_substituted',
  });

  if (!echoed || echoed !== probePlan.correlation_id) {
    return {
      ok: false,
      fail_closed: true,
      boundary: probePlan.boundary,
      code: echoed ? 'id_substitution' : 'missing_correlation_echo',
      hop,
    };
  }

  return { ok: true, hop };
}

async function runApply(tenant, correlationId, confirmation) {
  const gate = locks.evaluateApplyGate({
    applyRequested: true,
    confirmation,
    tenant,
    stripeMode: 'test',
    subscriptionId: locks.SUBSCRIPTION_ID,
    imageShaFull: locks.IMAGE_SHA_FULL,
    masterBasis: locks.MASTER_BASIS,
  });
  if (!gate.ok) {
    refuse('apply_gate_failed', gate.errors.map((e) => e.code).join(','));
  }

  const plan = locks.buildDryRunPlan({ tenant, correlationId });
  if (!plan.ok) refuse(plan.reason, plan.detail);

  const tenantLock = locks.getTenantLock(tenant);
  const hops = [];
  for (const probe of plan.probes) {
    const result = await executeAllowlistedProbe(tenantLock, probe);
    if (!result.ok) {
      const report = {
        ok: false,
        fail_closed: true,
        mode: 'apply',
        live_mutation: false,
        reason: result.code,
        boundary: result.boundary,
        detail: result.detail || null,
        hop: result.hop || null,
        correlation_id: plan.correlation_id,
        tenant,
        note:
          'Fail closed: boundary could not preserve the same correlation ID without a mutation-capable path. Live E2E drill remains open.',
      };
      console.log(JSON.stringify(report, null, 2));
      process.exit(1);
    }
    hops.push(result.hop);
  }

  const evidence = {
    correlation_id: plan.correlation_id,
    tenant,
    client_slug: tenantLock.client_slug,
    resource_group: tenantLock.resource_group,
    staff_app: tenantLock.staff_app,
    stripe_mode: 'test',
    subscription_id: locks.SUBSCRIPTION_ID,
    master_basis: locks.MASTER_BASIS,
    image_sha_full: locks.IMAGE_SHA_FULL,
    hops,
  };
  const evaluated = locks.evaluateCorrelationEvidence(evidence);
  const report = {
    ok: evaluated.ok,
    mode: 'apply',
    live_mutation: false,
    fail_closed: evaluated.fail_closed,
    code: evaluated.code,
    errors: evaluated.errors || [],
    correlation_id: plan.correlation_id,
    tenant,
    hard_locks: plan.hard_locks,
    hops,
    explicitly_not_claimed: [...locks.EXPLICITLY_NOT_CLAIMED],
    note: evaluated.ok
      ? 'Bounded redacted hops preserved one correlation ID across allowlisted non-mutating boundaries. Does not close G01; ledger still requires formal live-drill evidence freeze.'
      : 'Fail closed on correlation evidence evaluation.',
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(evaluated.ok ? 0 : 1);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.tenant) {
    refuse('tenant_required', 'use --tenant wolfhouse|sunset');
  }
  if (!locks.ALLOWED_TENANTS.includes(String(args.tenant).toLowerCase())) {
    refuse('unsupported_tenant', args.tenant);
  }
  if (args.correlationId && !locks.isUuidV4(args.correlationId)) {
    refuse('invalid_correlation_id', args.correlationId);
  }

  if (!args.apply) {
    if (args.confirm) {
      refuse('confirm_without_apply', 'confirmation is only valid with --apply');
    }
    const plan = locks.buildDryRunPlan({
      tenant: args.tenant,
      correlationId: args.correlationId,
    });
    console.log(JSON.stringify(plan, null, 2));
    process.exit(plan.ok ? 0 : 2);
  }

  await runApply(args.tenant, args.correlationId, args.confirm);
}

main().catch((err) => {
  refuse('unhandled_error', String(err && err.stack ? err.stack : err));
});
