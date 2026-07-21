'use strict';

/**
 * verify:radar-slice16ak-g06-backpressure — RADAR Slice 16AK
 *
 * Offline RED/GREEN for G06 tenant-safe admission-control / backpressure
 * source contract. No network / live / deploy / runtime wire.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16ak-g06-backpressure');
const ac = locks.ac;

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${name}`);
  if (detail) console.log(`        ${detail}`);
  return false;
}

function red(id, cond, detail) {
  return ok(`RED ${id}`, cond, detail);
}

function green(id, cond, detail) {
  return ok(`GREEN ${id}`, cond, detail);
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function currentBranch() {
  return execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
}

function runtimePathsUnchanged() {
  // 16AK historically forbade mutating Staff API; later tip 16AL owns that wire
  // plus a bounded readiness-lifecycle shutdown-BEGIN hook. 16AN owns trusted
  // ingress binding + Wolfhouse/Sunset staging main.bicep ingress slug.
  // Keep freeze on non-wire paths relative to 16AK master basis.
  const paths = locks.MUST_NOT_MUTATE.filter((p) =>
    p !== 'scripts/staff-query-api.js'
    && p !== 'scripts/lib/staff-api-readiness-lifecycle.js'
    && p !== 'scripts/lib/staff-api-request-correlation.js'
    && p !== 'infra/azure/staging/main.bicep'
    && p !== 'infra/azure/sunset-staging/main.bicep');
  try {
    const out = execSync(
      `git diff --name-only ${locks.MASTER_BASIS} -- ${paths.join(' ')}`,
      { cwd: ROOT, encoding: 'utf8' },
    ).trim();
    return { ok: out === '', detail: out || '(clean)' };
  } catch (err) {
    return { ok: false, detail: String(err && err.message) };
  }
}

function secretFree(text, label) {
  const patterns = [
    /sk_live_[A-Za-z0-9]+/,
    /sk_test_[A-Za-z0-9]{20,}/,
    /whsec_[A-Za-z0-9]+/,
    /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
    /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  ];
  for (let i = 0; i < patterns.length; i += 1) {
    if (patterns[i].test(text)) return { ok: false, detail: `${label} matched ${patterns[i]}` };
  }
  return { ok: true };
}

function hasHttpRetryMeta(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return (
    Object.prototype.hasOwnProperty.call(obj, 'http_status')
    || Object.prototype.hasOwnProperty.call(obj, 'retry_after_seconds')
    || Object.prototype.hasOwnProperty.call(obj, 'retryable')
    || (obj.headers && Object.prototype.hasOwnProperty.call(obj.headers, 'Retry-After'))
  );
}

function makeCtrl(extraLimits) {
  return ac.createAdmissionController({
    limits: extraLimits || undefined,
    nowMs: (() => {
      let t = 1000;
      return () => {
        t += 1;
        return t;
      };
    })(),
  });
}

console.log('RADAR 16AK G06 backpressure / admission-control source — offline verifier\n');

const design = readJson(locks.DESIGN_REL);
const contract = readJson(locks.CONTRACT_REL);
const topology = readJson(locks.TOPOLOGY_REL);
const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
const topContract = readJson('fixtures/radar-operations/contract.json');
const doc = readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md');
const findings = readText('fixtures/radar-operations/findings.md');
const libSrc = readText(locks.LIB_REL);
const locksSrc = readText(locks.LOCKS_REL);
const verifySrc = readText(locks.VERIFY_REL);
const apiSrc = readText('scripts/staff-query-api.js');
const corrSrc = readText('scripts/lib/staff-api-request-correlation.js');
const pkg = readJson('package.json');

// ── Meta / fixtures ──────────────────────────────────────────────────────────

green('M1 slice/outcome/branch/master',
  locks.SLICE === 'RADAR-16AK'
  && locks.OUTCOME_ID === '16AK_g06_backpressure_source'
  && locks.MASTER_BASIS === '9fa3626326c0e2bc21f2d37905967d6ff47b7520'
  && locks.BRANCH === 'radar/slice-16ak-g06-backpressure-source'
  && contract.master_basis === locks.MASTER_BASIS
  && design.master_basis === locks.MASTER_BASIS
  && topology.master_basis === locks.MASTER_BASIS);

try {
  const b = currentBranch();
  ok('M2b current branch is 16AK or later tip / master-based work',
    b === locks.BRANCH || b === 'HEAD' || /16ak|16al|16am|16an/i.test(b),
    b);
} catch (e) {
  ok('M2b branch readable', false, String(e.message));
}

green('M3 progress_class source_partial_progress_only',
  locks.PROGRESS_CLASS === 'source_partial_progress_only'
  && contract.progress_class === 'source_partial_progress_only'
  && design.progress_class === 'source_partial_progress_only');

green('M4 runtime_wired false / audit_only',
  contract.this_slice_implements_runtime === false
  && design.runtime_wired === false
  && contract.audit_only === true
  && contract.live_deploy === false);

green('M5 package script registered',
  pkg.scripts
  && pkg.scripts['verify:radar-slice16ak-g06-backpressure']
    === 'node scripts/verify-radar-slice16ak-g06-backpressure.js');

green('M6 integration drill defined_not_executed',
  locks.FINAL_CONTROLLED_DRILL.status === 'defined_not_executed'
  && contract.final_controlled_drill.status === 'defined_not_executed'
  && design.future_integration_drill.status === 'defined_not_executed');

green('M7 offline source offline_source_proven',
  locks.OFFLINE_SOURCE_CONTRACT.status === 'offline_source_proven'
  && contract.offline_source_contract.status === 'offline_source_proven');

green('M8 score unchanged in fixtures',
  contract.verdict_policy.proven === 0
  && contract.verdict_policy.partial === 9
  && contract.verdict_policy.absent === 0
  && design.g06_disposition.score.proven === 0
  && design.g06_disposition.score.partial === 9
  && design.g06_disposition.score.absent === 0);

const rt = runtimePathsUnchanged();
green('M9 runtime paths unchanged vs master basis', rt.ok, rt.detail);

for (const rel of locks.OWNED_RELS) {
  ok(`M10 owned exists ${rel}`, fs.existsSync(path.join(ROOT, rel)));
}

const sf = [
  secretFree(libSrc, 'lib'),
  secretFree(locksSrc, 'locks'),
  secretFree(verifySrc, 'verify'),
  secretFree(JSON.stringify(design), 'design'),
  secretFree(JSON.stringify(contract), 'contract'),
  secretFree(JSON.stringify(topology), 'topology'),
];
green('M11 secret-free artifacts', sf.every((s) => s.ok), sf.filter((s) => !s.ok).map((s) => s.detail).join(';'));

red('M12 sync-throw integration ownership explicitly not claimed',
  locks.EXPLICITLY_NOT_CLAIMED.includes('sync_throw_integration_ownership')
  && contract.must_not_claim_as_proven.includes('sync_throw_integration_ownership')
  && /sync.?throw/i.test(JSON.stringify(design.explicitly_not_claimed || locks.EXPLICITLY_NOT_CLAIMED)));

// ── Topology inspection ──────────────────────────────────────────────────────

green('T1 topology cites staff-query-api router entry',
  /createStaffQueryApiHttpServer/.test(topology.request_entry.factory)
  && /runWithRequestCorrelation/.test(topology.request_entry.order.join(','))
  && /createStaffQueryApiHttpServer/.test(apiSrc)
  && /resolveTrustedIngressBinding/.test(apiSrc));

green('T2 trusted ingress only resolveTrustedIngressBinding.tenant_slug',
  locks.TRUSTED_TENANT_SOURCES.length === 1
  && locks.TRUSTED_TENANT_SOURCES[0].id === 'resolveTrustedIngressBinding_tenant_slug'
  && locks.TRUSTED_TENANT_SOURCES[0].field === 'tenant_slug'
  && /never request input/i.test(corrSrc)
  && /Never reads request headers\/query\/body/i.test(corrSrc)
  && topology.trusted_tenant_identity.accepted.length === 1
  && /resolveTrustedIngressBinding/.test(topology.trusted_tenant_identity.accepted[0]));

green('T3 healthz/readyz evidence present in API',
  /HEALTHZ_PATH|handleStaffApiHealthz/.test(apiSrc)
  && /READYZ_PATH|handleStaffApiReadyz/.test(apiSrc)
  && topology.families.health_probe.endpoints.some((e) => e.path === '/healthz')
  && topology.families.health_probe.endpoints.some((e) => e.path === '/readyz'));

green('T4 stripe webhook + claim evidence',
  /\/staff\/stripe\/webhook/.test(apiSrc)
  && /handleStripeWebhook/.test(apiSrc)
  && fs.existsSync(path.join(ROOT, 'scripts/lib/stripe-webhook-event-claim.js'))
  && topology.families.webhook_side_effect.endpoints.some((e) => e.path === '/staff/stripe/webhook'));

green('T5 16AK topology recorded no pre-existing runtime backpressure',
  topology.existing_admission_or_backpressure.present === false
  && design.runtime_wired === false);

green('T6 16AK source contract remains unwired (wire ownership is later tip)',
  design.future_integration_drill.status === 'defined_not_executed'
  && contract.final_controlled_drill.status === 'defined_not_executed'
  && locks.MUST_NOT_MUTATE.includes('scripts/staff-query-api.js'));

red('T7 no suffix heuristic / no all-159 coverage claim',
  ac.READ_LIKE_NON_DURABLE_SUFFIXES.length === 0
  && !/\.endsWith\(/.test(libSrc)
  && !/p\.includes\('\/preview'\)|p\.includes\('dry-run'\)/.test(libSrc)
  && !/all.?159|159 literal|router_pathname_literal_count_inspected/.test(JSON.stringify(topology))
  && !/\ball 159\b|\ball-159\b|uses suffix heuristic|suffix-heuristic classification/i.test(doc)
  && /no.*suffix heuristic|eligible-route allowlist/i.test(doc)
  && topology.classification_rules_for_library
  && topology.classification_rules_for_library.eligible_allowlist === true
  && topology.classification_rules_for_library.unknown_default === 'exclude_fail_closed');

// ── Classification (allowlist) ───────────────────────────────────────────────

green('C1 health probes excluded',
  ac.classifyRoute({ method: 'GET', pathname: '/healthz' }).admission === 'exclude'
  && ac.classifyRoute({ method: 'GET', pathname: '/readyz' }).admission === 'exclude'
  && ac.classifyRoute({ method: 'GET', pathname: '/' }).admission === 'exclude');

green('C2 stripe POST webhook_side_effect',
  ac.classifyRoute({ method: 'POST', pathname: '/staff/stripe/webhook' }).class
    === ac.ROUTE_CLASSES.WEBHOOK_SIDE_EFFECT);

green('C3 meta GET verify read_idempotent',
  ac.classifyRoute({ method: 'GET', pathname: '/staff/meta/whatsapp/webhook' }).class
    === ac.ROUTE_CLASSES.READ_IDEMPOTENT);

green('C4 write cancel durable',
  ac.classifyRoute({ method: 'POST', pathname: '/staff/bookings/cancel' }).class
    === ac.ROUTE_CLASSES.WRITE_SIDE_EFFECT
  && ac.classifyRoute({ method: 'POST', pathname: '/staff/bookings/cancel' }).side_effect_risk
    === 'durable');

green('C5 preview read_like_non_durable',
  ac.classifyRoute({ method: 'POST', pathname: '/staff/bookings/edit-preview' }).class
    === ac.ROUTE_CLASSES.READ_LIKE_NON_DURABLE);

green('C6 GET query read_idempotent',
  ac.classifyRoute({ method: 'GET', pathname: '/staff/query' }).class
    === ac.ROUTE_CLASSES.READ_IDEMPOTENT);

red('C7 bad input rejected',
  ac.classifyRoute({ method: '', pathname: '/staff/query' }).ok === false);

red('C8 move-targets is read_like_non_durable (inspected preview_only)',
  ac.classifyRoute({ method: 'POST', pathname: '/staff/bookings/move-targets' }).class
    === ac.ROUTE_CLASSES.READ_LIKE_NON_DURABLE
  && /preview_only:\s*true/.test(apiSrc)
  && /handleBookingMoveTargets/.test(apiSrc));

red('C9 reset-luna-phone is write_side_effect (durable delete)',
  ac.classifyRoute({ method: 'POST', pathname: '/staff/test/reset-luna-phone' }).class
    === ac.ROUTE_CLASSES.WRITE_SIDE_EFFECT
  && /Deletes guest_message_events/.test(apiSrc)
  && /handleTestResetLunaPhone/.test(apiSrc));

red('C10 unknown route default-exclude fail-closed',
  ac.classifyRoute({ method: 'POST', pathname: '/staff/not-a-reviewed-route' }).ok === false
  && ac.classifyRoute({ method: 'POST', pathname: '/staff/not-a-reviewed-route' }).default_exclude === true
  && (() => {
    const ctrl = makeCtrl();
    const r = ctrl.tryAdmit({
      method: 'POST',
      pathname: '/staff/not-a-reviewed-route',
      trustedTenantSlug: 'wolfhouse-somo',
    });
    return r.ok === false
      && r.decision === ac.DECISIONS.REJECTED_UNKNOWN_ROUTE
      && !hasHttpRetryMeta(r);
  })());

green('C11 eligible allowlist exported and non-empty',
  Object.keys(ac.ELIGIBLE_ROUTES).length >= 10
  && ac.ELIGIBLE_ROUTES['POST /staff/bookings/move-targets']
    === ac.ROUTE_CLASSES.READ_LIKE_NON_DURABLE
  && ac.ELIGIBLE_ROUTES['POST /staff/test/reset-luna-phone']
    === ac.ROUTE_CLASSES.WRITE_SIDE_EFFECT);

// ── Limits lock ──────────────────────────────────────────────────────────────

green('L1 exact locked ceilings',
  ac.LIMITS.max_in_flight_global === 8
  && ac.LIMITS.max_queued_global === 16
  && ac.LIMITS.max_in_flight_per_tenant === 4
  && ac.LIMITS.max_queued_per_tenant === 8
  && ac.LIMITS.retry_after_seconds === 1
  && ac.LIMITS.max_tombstones === 128
  && contract.limits.max_in_flight_global === 8
  && design.limits.max_in_flight_global === 8);

red('L2 cannot exceed locked ceilings', (() => {
  try {
    ac.createAdmissionController({ limits: { max_in_flight_global: 9 } });
    return false;
  } catch (e) {
    return /admission_limits_exceed_locked_ceilings/.test(String(e.message));
  }
})());

// ── Burst / queue overflow (503 only here) ───────────────────────────────────

(() => {
  const ctrl = makeCtrl();
  const tokens = [];
  for (let i = 0; i < 4; i += 1) {
    const r = ctrl.tryAdmit({
      method: 'GET',
      pathname: '/staff/query',
      trustedTenantSlug: 'wolfhouse-somo',
    });
    green(`B1 admit ${i}`, r.ok && r.decision === ac.DECISIONS.ADMITTED);
    tokens.push(r.token_id);
  }
  const q = [];
  for (let i = 0; i < 8; i += 1) {
    const r = ctrl.tryAdmit({
      method: 'GET',
      pathname: '/staff/query',
      trustedTenantSlug: 'wolfhouse-somo',
    });
    green(`B2 queue ${i}`, r.ok && r.decision === ac.DECISIONS.QUEUED);
    q.push(r.token_id);
  }
  const overflow = ctrl.tryAdmit({
    method: 'GET',
    pathname: '/staff/query',
    trustedTenantSlug: 'wolfhouse-somo',
  });
  red('B3 queue overflow 503 Retry-After',
    overflow.ok === false
    && overflow.decision === ac.DECISIONS.REJECTED_QUEUE_OVERFLOW
    && overflow.http_status === 503
    && overflow.headers['Retry-After'] === '1'
    && overflow.retry_after_seconds === 1
    && overflow.retryable === true);
  green('B4 diagnostics bounded after burst',
    ctrl.diagnostics().event_count <= ac.LIMITS.max_diag_events
    && ctrl.diagnostics().in_flight_global === 4
    && ctrl.diagnostics().queued_global === 8);
  ctrl.assertConsistent();
})();

// ── In-flight reject when queue disabled ─────────────────────────────────────

(() => {
  const ctrl = makeCtrl({
    max_in_flight_global: 2,
    max_in_flight_per_tenant: 2,
    max_queued_global: 0,
    max_queued_per_tenant: 0,
  });
  ok('IF1 first admit', ctrl.tryAdmit({
    method: 'POST', pathname: '/staff/bookings/cancel', trustedTenantSlug: 'wolfhouse-somo',
  }).decision === ac.DECISIONS.ADMITTED);
  ok('IF2 second admit', ctrl.tryAdmit({
    method: 'POST', pathname: '/staff/bookings/cancel', trustedTenantSlug: 'wolfhouse-somo',
  }).decision === ac.DECISIONS.ADMITTED);
  const r = ctrl.tryAdmit({
    method: 'POST', pathname: '/staff/bookings/cancel', trustedTenantSlug: 'wolfhouse-somo',
  });
  red('IF3 in-flight limit 503',
    r.ok === false
    && r.decision === ac.DECISIONS.REJECTED_IN_FLIGHT
    && r.http_status === 503
    && r.headers['Retry-After'] === '1');
})();

// ── Starvation / fairness ────────────────────────────────────────────────────

(() => {
  const ctrl = makeCtrl({
    max_in_flight_global: 2,
    max_in_flight_per_tenant: 1,
    max_queued_global: 16,
    max_queued_per_tenant: 8,
  });
  const a1 = ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 'tenant-a' });
  const b1 = ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 'tenant-b' });
  green('F1 both tenants admitted', a1.decision === 'admitted' && b1.decision === 'admitted');
  const aq = ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 'tenant-a' });
  const bq = ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 'tenant-b' });
  const aq2 = ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 'tenant-a' });
  green('F2 queues form', aq.decision === 'queued' && bq.decision === 'queued' && aq2.decision === 'queued');
  const r1 = ctrl.release(a1.token_id);
  green('F3 promote after A release', r1.ok && r1.promoted && r1.promoted.ok);
  const firstPromotedTenant = r1.promoted.tenant;
  const r2 = ctrl.release(b1.token_id);
  green('F4 promote after B release', r2.ok && r2.promoted && r2.promoted.ok);
  const secondPromotedTenant = r2.promoted.tenant;
  red('F5 fairness not same-tenant starvation',
    firstPromotedTenant !== secondPromotedTenant,
    `first=${firstPromotedTenant} second=${secondPromotedTenant}`);
  const promotedTenants = [firstPromotedTenant, secondPromotedTenant].sort().join(',');
  green('F6 both waiting tenants promoted across releases',
    promotedTenants === 'tenant-a,tenant-b');
  ctrl.assertConsistent();
})();

// ── Spoofed / missing tenant (internal — no 503) ─────────────────────────────

(() => {
  const ctrl = makeCtrl();
  const missing = ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query' });
  red('S1 missing tenant fail-closed no 503',
    missing.ok === false
    && missing.decision === ac.DECISIONS.REJECTED_MISSING_TENANT
    && !hasHttpRetryMeta(missing));

  const spoof = ctrl.tryAdmit({
    method: 'GET',
    pathname: '/staff/query',
    trustedTenantSlug: 'wolfhouse-somo',
    claimFromRequest: 'evil-tenant',
  });
  red('S2 spoofed request claim rejected no 503',
    spoof.ok === false
    && spoof.decision === ac.DECISIONS.REJECTED_UNTRUSTED_TENANT
    && !hasHttpRetryMeta(spoof));

  const badSlug = ctrl.tryAdmit({
    method: 'GET',
    pathname: '/staff/query',
    trustedTenantSlug: '../evil',
  });
  red('S3 invalid slug rejected as missing no 503',
    badSlug.ok === false
    && badSlug.decision === ac.DECISIONS.REJECTED_MISSING_TENANT
    && !hasHttpRetryMeta(badSlug));

  const ex = ctrl.tryAdmit({ method: 'GET', pathname: '/readyz' });
  green('S4 readiness exclude without tenant',
    ex.ok && ex.decision === ac.DECISIONS.EXCLUDED && ex.counts_toward_limits === false);
})();

// ── Timeout / abort / races ──────────────────────────────────────────────────

(() => {
  const ctrl = makeCtrl({
    max_in_flight_global: 1,
    max_in_flight_per_tenant: 1,
    max_queued_global: 4,
    max_queued_per_tenant: 4,
  });
  const a = ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 'wolfhouse-somo' });
  const q = ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 'wolfhouse-somo' });
  green('R1 admit+queue', a.decision === 'admitted' && q.decision === 'queued');
  const ab = ctrl.abort(q.token_id);
  green('R2 abort queued cleans counters', ab.ok && ctrl.diagnostics().queued_global === 0);
  const q2 = ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 'wolfhouse-somo' });
  green('R3 re-queue after abort', q2.decision === 'queued');
  const to = ctrl.timeout(a.token_id);
  green('R4 timeout in-flight promotes waiter',
    to.ok && to.promoted && to.promoted.token_id === q2.token_id);
  ctrl.assertConsistent();

  const d = ctrl.abort(q2.token_id);
  const d2 = ctrl.abort(q2.token_id);
  green('R5 first abort ok', d.ok);
  red('R6 second abort no double release (tombstone)',
    d2.ok === false
    && d2.decision === ac.DECISIONS.REJECTED_ALREADY_RELEASED
    && d2.counters_unchanged === true
    && !hasHttpRetryMeta(d2)
    && ctrl.diagnostics().in_flight_global === 0);
})();

// ── Counter underflow / overflow ─────────────────────────────────────────────

(() => {
  const ctrl = makeCtrl({
    max_in_flight_global: 1,
    max_in_flight_per_tenant: 1,
    max_queued_global: 0,
    max_queued_per_tenant: 0,
  });
  const a = ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 't1' });
  green('U1 admit', a.decision === 'admitted');
  ctrl.release(a.token_id);
  const again = ctrl.release(a.token_id);
  red('U2 double release ignored (tombstone, no underflow)',
    again.ok === false
    && again.counters_unchanged === true
    && !hasHttpRetryMeta(again)
    && ctrl.diagnostics().in_flight_global === 0
    && ctrl.diagnostics().token_record_count === 0
    && ctrl.diagnostics().tombstone_count >= 1);

  const b = ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 't1' });
  const c = ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 't1' });
  green('U3 second hits in-flight limit', b.decision === 'admitted' && c.ok === false && c.http_status === 503);
})();

// ── Real induced reentrancy ──────────────────────────────────────────────────

(() => {
  const ctrl = makeCtrl({
    max_in_flight_global: 1,
    max_in_flight_per_tenant: 1,
    max_queued_global: 4,
    max_queued_per_tenant: 4,
  });
  const a = ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 't1' });
  ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 't1' });

  let nestedResult = null;
  let bucketGets = 0;
  const origGet = Map.prototype.get;
  Map.prototype.get = function patchedGet(key) {
    const v = origGet.call(this, key);
    // release() does one tenants.get before promoteOne; subsequent bucket gets
    // are inside promoteOne while promoting===true — induce real reentrancy there.
    if (v && typeof v === 'object' && Array.isArray(v.queue)) {
      bucketGets += 1;
      if (bucketGets >= 2 && v.queue.length > 0 && nestedResult === null) {
        nestedResult = ctrl.promoteOne();
      }
    }
    return v;
  };
  try {
    ctrl.release(a.token_id);
  } finally {
    Map.prototype.get = origGet;
  }
  red('RE1 real induced reentrancy returns REJECTED_REENTRANT',
    nestedResult
    && nestedResult.ok === false
    && nestedResult.decision === ac.DECISIONS.REJECTED_REENTRANT
    && !hasHttpRetryMeta(nestedResult),
    nestedResult ? JSON.stringify(nestedResult) : `no nested call bucketGets=${bucketGets}`);
  red('RE2 source has promoting reentrancy guard',
    /if \(promoting\)/.test(libSrc) && /REJECTED_REENTRANT/.test(libSrc));
  green('RE3 controller consistent after induced reentrancy',
    ctrl.assertConsistent() === true);
})();

// ── Post-side-effect rejection (internal continue — no 503) ──────────────────

(() => {
  const ctrl = makeCtrl();
  const r = ctrl.tryAdmit({
    method: 'POST',
    pathname: '/staff/stripe/webhook',
    trustedTenantSlug: 'wolfhouse-somo',
  });
  green('P1 webhook admitted', r.decision === 'admitted');
  const se = ctrl.markSideEffectStarted(r.token_id);
  green('P2 side effect marked', se.ok && se.rejectable_with_503 === false);
  const shed = ctrl.tryRejectWith503(r.token_id);
  red('P3 post-side-effect is internal continue — no http/retry metadata',
    shed.ok === false
    && shed.decision === ac.DECISIONS.REJECTED_POST_SIDE_EFFECT
    && shed.continue === true
    && shed.rejectable_with_503 === false
    && shed.counters_unchanged === true
    && !hasHttpRetryMeta(shed)
    && ctrl.diagnostics().in_flight_global === 1);
  const r2 = ctrl.tryAdmit({
    method: 'POST',
    pathname: '/staff/bookings/cancel',
    trustedTenantSlug: 'wolfhouse-somo',
  });
  const shed2 = ctrl.tryRejectWith503(r2.token_id);
  green('P4 pre-side-effect shed 503 only',
    shed2.ok === false
    && shed2.http_status === 503
    && shed2.headers['Retry-After'] === '1'
    && shed2.retryable === true);
  ctrl.release(r.token_id);
  ctrl.assertConsistent();
})();

// ── Cross-tenant isolation ───────────────────────────────────────────────────

(() => {
  const ctrl = makeCtrl({
    max_in_flight_global: 8,
    max_in_flight_per_tenant: 2,
    max_queued_global: 16,
    max_queued_per_tenant: 2,
  });
  for (let i = 0; i < 2; i += 1) {
    ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 'tenant-a' });
  }
  for (let i = 0; i < 2; i += 1) {
    ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 'tenant-a' });
  }
  const aBlock = ctrl.tryAdmit({
    method: 'GET', pathname: '/staff/query', trustedTenantSlug: 'tenant-a',
  });
  red('X1 tenant-a saturated rejects', aBlock.ok === false && aBlock.http_status === 503);

  const b1 = ctrl.tryAdmit({
    method: 'GET', pathname: '/staff/query', trustedTenantSlug: 'tenant-b',
  });
  const b2 = ctrl.tryAdmit({
    method: 'GET', pathname: '/staff/query', trustedTenantSlug: 'tenant-b',
  });
  green('X2 tenant-b isolated admit',
    b1.decision === 'admitted' && b2.decision === 'admitted');
  const d = ctrl.diagnostics();
  green('X3 aggregate counters show isolation without tenant key map',
    d.tracked_tenant_count === 2
    && d.non_empty_tenant_count === 2
    && d.in_flight_global === 4
    && d.queued_global === 2
    && d.max_tenant_in_flight === 2
    && d.max_tenant_queued === 2
    && !Object.prototype.hasOwnProperty.call(d, 'tenants'));
  ctrl.assertConsistent();
})();

// ── Readiness independence ───────────────────────────────────────────────────

(() => {
  const ctrl = makeCtrl({
    max_in_flight_global: 1,
    max_in_flight_per_tenant: 1,
    max_queued_global: 0,
    max_queued_per_tenant: 0,
  });
  ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 't1' });
  const blocked = ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 't1' });
  red('RD1 saturated rejects work', blocked.ok === false && blocked.http_status === 503);
  const hz = ctrl.tryAdmit({ method: 'GET', pathname: '/healthz' });
  const rz = ctrl.tryAdmit({ method: 'GET', pathname: '/readyz' });
  green('RD2 health/ready still excluded under saturation',
    hz.decision === 'excluded'
    && rz.decision === 'excluded'
    && ctrl.diagnostics().in_flight_global === 1);
})();

// ── Bounded diagnostics — no tenant slugs ────────────────────────────────────

(() => {
  const ctrl = makeCtrl({
    max_in_flight_global: 8,
    max_in_flight_per_tenant: 4,
    max_queued_global: 16,
    max_queued_per_tenant: 8,
    max_diag_events: 8,
  });
  const slugs = ['wolfhouse-somo', 'tenant-secret-slug', 'luna-sunset-staging'];
  for (let i = 0; i < 40; i += 1) {
    const r = ctrl.tryAdmit({
      method: 'GET',
      pathname: '/staff/query',
      trustedTenantSlug: slugs[i % slugs.length],
    });
    if (r.token_id) ctrl.release(r.token_id);
  }
  const d = ctrl.diagnostics();
  const dump = JSON.stringify(d);
  green('D1 diag ring bounded', d.event_count === 8 && d.events.length === 8);
  green('D2 diag has no secrets fields',
    !dump.includes('sk_live') && !dump.includes('password'));
  red('D3 diagnostics expose no raw tenant identifiers/keys',
    !dump.includes('wolfhouse-somo')
    && !dump.includes('tenant-secret-slug')
    && !dump.includes('luna-sunset-staging')
    && !Object.prototype.hasOwnProperty.call(d, 'tenants')
    && d.events.every((e) => e.kind && !e.tenant && !e.tenant_slug)
    && typeof d.tracked_tenant_count === 'number'
    && typeof d.tombstone_count === 'number');
})();

// ── Tombstone lifecycle memory bound + large churn ───────────────────────────

(() => {
  const ctrl = makeCtrl({
    max_in_flight_global: 8,
    max_in_flight_per_tenant: 4,
    max_queued_global: 16,
    max_queued_per_tenant: 8,
    max_tombstones: 32,
  });
  const N = 500;
  let peakTokens = 0;
  let churnOk = true;
  for (let i = 0; i < N; i += 1) {
    const r = ctrl.tryAdmit({
      method: 'GET',
      pathname: '/staff/query',
      trustedTenantSlug: 'churn-tenant',
    });
    if (!r.ok) {
      churnOk = false;
      red('CH2 churn admit failed unexpectedly', false, `i=${i} ${JSON.stringify(r)}`);
      break;
    }
    const rel = ctrl.release(r.token_id);
    if (!rel.ok) {
      churnOk = false;
      red('CH2b churn release failed', false, `i=${i} ${JSON.stringify(rel)}`);
      break;
    }
    const d = ctrl.diagnostics();
    if (d.token_record_count > peakTokens) peakTokens = d.token_record_count;
    if (d.tombstone_count > 32) {
      churnOk = false;
      red('CH3 tombstone exceeded max', false, String(d.tombstone_count));
      break;
    }
  }
  green('CH1 large sequential churn completed', churnOk && N === 500);
  const d = ctrl.diagnostics();
  red('CH4 steady-state token records bound under large sequential churn',
    d.token_record_count === 0
    && d.tombstone_count <= 32
    && d.tombstone_count === 32
    && peakTokens <= 1
    && d.tracked_tenant_count === 0,
    `tokens=${d.token_record_count} tombs=${d.tombstone_count} peak=${peakTokens} tenants=${d.tracked_tenant_count}`);
  // Duplicate terminal still works for recent tombstones
  const last = ctrl.tryAdmit({
    method: 'GET', pathname: '/staff/query', trustedTenantSlug: 'churn-tenant',
  });
  ctrl.release(last.token_id);
  const dup = ctrl.release(last.token_id);
  red('CH5 duplicate terminal via tombstone idempotent',
    dup.ok === false
    && dup.decision === ac.DECISIONS.REJECTED_ALREADY_RELEASED
    && dup.counters_unchanged === true);
  ctrl.assertConsistent();
})();

// ── 65th historical tenant — eviction prevents cardinality starvation ────────

(() => {
  const ctrl = makeCtrl({
    max_in_flight_global: 8,
    max_in_flight_per_tenant: 4,
    max_queued_global: 16,
    max_queued_per_tenant: 8,
    max_tenant_keys_tracked: 64,
  });
  for (let i = 1; i <= 64; i += 1) {
    const r = ctrl.tryAdmit({
      method: 'GET',
      pathname: '/staff/query',
      trustedTenantSlug: `hist-${i}`,
    });
    if (!r.ok) {
      red('H1 historical admit failed before 65', false, `i=${i} ${JSON.stringify(r)}`);
      break;
    }
    ctrl.release(r.token_id);
  }
  green('H2 after 64 historical idle, tracked_tenant_count is 0',
    ctrl.diagnostics().tracked_tenant_count === 0
    && ctrl.diagnostics().rr_key_count === 0);
  const r65 = ctrl.tryAdmit({
    method: 'GET',
    pathname: '/staff/query',
    trustedTenantSlug: 'hist-65-new',
  });
  red('H3 65th historical tenant admits (not starved by history)',
    r65.ok === true
    && r65.decision === ac.DECISIONS.ADMITTED
    && ctrl.diagnostics().tracked_tenant_count === 1,
    JSON.stringify(r65));
  ctrl.release(r65.token_id);
  green('H4 new tenant bucket evicted when idle',
    ctrl.diagnostics().tracked_tenant_count === 0);

  // Concurrent cardinality: only concurrently tracked tenants count.
  // Use a tight track ceiling (4) so token limits (8+16) do not mask it.
  const cctrl = makeCtrl({
    max_in_flight_global: 8,
    max_in_flight_per_tenant: 1,
    max_queued_global: 16,
    max_queued_per_tenant: 1,
    max_tenant_keys_tracked: 4,
  });
  const held = [];
  for (let i = 1; i <= 4; i += 1) {
    held.push(cctrl.tryAdmit({
      method: 'GET',
      pathname: '/staff/query',
      trustedTenantSlug: `live-${i}`,
    }));
  }
  const blocked = cctrl.tryAdmit({
    method: 'GET',
    pathname: '/staff/query',
    trustedTenantSlug: 'live-5',
  });
  red('H5 concurrent track-ceiling+1 rejected (only concurrent count)',
    held.every((h) => h.ok)
    && blocked.ok === false
    && blocked.http_status === 503
    && cctrl.diagnostics().tracked_tenant_count === 4);
  held.forEach((h) => cctrl.release(h.token_id));
  green('H6 after release all concurrent, cardinality free for new tenant',
    cctrl.diagnostics().tracked_tenant_count === 0
    && cctrl.tryAdmit({
      method: 'GET', pathname: '/staff/query', trustedTenantSlug: 'live-5',
    }).ok === true);
  cctrl.assertConsistent();
  ctrl.assertConsistent();
})();

// ── close / shutdown ─────────────────────────────────────────────────────────

(() => {
  const ctrl = makeCtrl({
    max_in_flight_global: 2,
    max_in_flight_per_tenant: 2,
    max_queued_global: 8,
    max_queued_per_tenant: 4,
  });
  const a = ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 't1' });
  const b = ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 't1' });
  ctrl.markSideEffectStarted(b.token_id);
  const q1 = ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 't1' });
  const q2 = ctrl.tryAdmit({ method: 'GET', pathname: '/staff/query', trustedTenantSlug: 't2' });
  green('CL1 setup admitted+queued',
    a.decision === 'admitted'
    && b.decision === 'admitted'
    && q1.decision === 'queued'
    && q2.decision === 'queued');
  const closed = ctrl.close();
  red('CL2 close rejects queued and settles in-flight',
    closed.ok
    && closed.rejected_queued === 2
    && closed.released_in_flight === 2
    && closed.in_flight_global === 0
    && closed.queued_global === 0
    && closed.tracked_tenant_count === 0
    && closed.token_record_count === 0,
    JSON.stringify(closed));
  const after = ctrl.tryAdmit({
    method: 'GET', pathname: '/staff/query', trustedTenantSlug: 't-new',
  });
  red('CL3 post-close admit fail-closed no 503 overload shape required',
    after.ok === false
    && after.decision === ac.DECISIONS.REJECTED_CLOSED
    && !hasHttpRetryMeta(after));
  const again = ctrl.close();
  green('CL4 close idempotent', again.ok && again.already_closed === true);
  ctrl.assertConsistent();
})();

// ── Overclaim / ledger presence ──────────────────────────────────────────────

red('O1 affirmative overclaim phrases absent from doc/findings', (() => {
  const surfaces = [doc, findings];
  for (let s = 0; s < surfaces.length; s += 1) {
    const lines = surfaces[s].split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/forbidden_claim|must_not_claim|does not|does\s+\*\*not\*\*|not claimed|never claim|explicitly not|raising G06|That wire ran/i.test(line)) {
        continue;
      }
      if (/backpressure proven|admission control proven|\bG06 proven\b|\bfull G06\b|wired into runtime|live shed proven/i.test(line)
        && !/not |never |forbidden|open|defined_not_executed|source only|source-only|source\/text/i.test(line)) {
        return false;
      }
    }
  }
  return /defined_not_executed/i.test(doc)
    && /16AK/i.test(doc)
    && /source/i.test(doc)
    && /sync.?throw/i.test(doc + findings + locksSrc);
})());

green('O2 16AK selection retained under later tip (source contract unchanged)',
  matrix.slice_16ak_selection
  && matrix.slice_16ak_selection.outcome_id === '16AK_g06_backpressure_source'
  && topContract.selected_16ak
  && topContract.selected_16ak.outcome_id === '16AK_g06_backpressure_source'
  && topContract.g06_backpressure_source === 'source_defined_via_16AK'
  && topContract.capacity_backpressure === 'open'
  && design.slice === 'RADAR-16AK'
  && contract.slice === 'RADAR-16AK'
  && topContract.expected_verdict_counts.proven === 0
  && topContract.expected_verdict_counts.partial === 9);

green('O3 G06 gaps still list runtime backpressure open',
  (() => {
    const g06 = matrix.gates.find((g) => g.id === 'G06_scaling_capacity');
    return g06
      && g06.verdict === 'partial'
      && g06.gaps.some((g) => /backpressure/i.test(String(g)));
  })());

green('O4 16AK contract still records integration defined_not_executed (no live claim)',
  design.future_integration_drill.status === 'defined_not_executed'
  && design.runtime_wired === false
  && /defined_not_executed/i.test(doc)
  && (() => {
    for (const line of doc.split('\n')) {
      if (/\bbackpressure proven\b/i.test(line)
        && !/not claimed|does\s*\*+\s*not|does not|never|open|forbidden|explicitly|claiming |raising /i.test(line)) {
        return false;
      }
    }
    return true;
  })());

console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('RADAR 16AK G06 backpressure / admission-control source: PASS');
