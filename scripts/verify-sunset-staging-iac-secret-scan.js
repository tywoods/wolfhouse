'use strict';

/**
 * Secret scan for FOUNDATION Slice 1 committed artifacts.
 * Discovers owned paths via git ls-files (no hand-written incomplete allowlist).
 * Also proves the synthetic sentinel is detected in-memory (never committed).
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  scanSecretValues,
  SYNTHETIC_SECRET_SENTINEL,
} = require('./lib/sunset-staging-iac-drift');

const ROOT = path.join(__dirname, '..');

const DISCOVERY_PATHSPECS = [
  'infra/azure/sunset-staging/inventory',
  'infra/azure/sunset-staging/README.md',
  'infra/azure/sunset-staging/main.bicep',
  'infra/azure/sunset-staging/parameters.example.json',
  'infra/azure/sunset-staging/acr-pull-role.bicep',
  'infra/azure/sunset-staging/wh-staging-identity-kv-secrets-user-role.bicep',
  'infra/azure/sunset-staging/wh-staging-identity-kv-secrets-user-role.parameters.json',
  'infra/azure/sunset-staging/lunabox-pg-firewall-rule.bicep',
  'infra/azure/sunset-staging/lunabox-pg-firewall-rule.parameters.json',
  'infra/azure/staging-cost-budgets',
  'fixtures/radar-operations',
  'scripts/lib/radar-slice16b-staging-cost-budgets.js',
  'scripts/verify-radar-slice16b-staging-cost-budgets.js',
  'scripts/preflight-radar-slice16b-staging-cost-budgets.js',
  'infra/azure/staging-staff-api-metric-alerts',
  'scripts/verify-radar-slice16h-staff-api-metric-alerts.js',
  'scripts/lib/staff-api-readiness.js',
  'scripts/lib/radar-slice16i-staff-api-readiness.js',
  'scripts/verify-radar-slice16i-staff-api-readiness.js',
  'scripts/lib/staff-api-request-correlation.js',
  'scripts/lib/radar-slice16j-staff-request-correlation.js',
  'scripts/verify-radar-slice16j-staff-request-correlation.js',
  'scripts/lib/staff-api-healthz.js',
  'scripts/lib/radar-slice16k-staff-api-healthz.js',
  'scripts/verify-radar-slice16k-staff-api-healthz.js',
  'fixtures/radar-operations/slice16k-expected-contract.json',
  'scripts/verify-radar-slice16l-staff-api-capacity-alerts.js',
  'fixtures/radar-operations/slice16l-expected-contract.json',
  'fixtures/radar-operations/slice16l-capacity-alert-plan.json',
  'scripts/lib/stripe-webhook-event-claim.js',
  'scripts/verify-radar-slice16m-stripe-event-claim.js',
  'fixtures/radar-operations/slice16m-expected-contract.json',
  'scripts/lib/stripe-webhook-public-errors.js',
  'scripts/lib/radar-slice16o-stripe-webhook-error-minimization.js',
  'scripts/verify-radar-slice16o-stripe-webhook-error-minimization.js',
  'fixtures/radar-operations/slice16o-expected-contract.json',
  'infra/azure/staging/main.bicep',
  'infra/azure/staging/parameters.example.json',
  'scripts/lib/phase-d-kv-dsn-verify-full-plan.js',
  'scripts/lib/phase-d-kv-dsn-verify-full-apply.js',
  'scripts/lib/phase-d-lunabox-pg-firewall-apply.js',
  'scripts/lib/phase-d-constraint-apply.js',
  'scripts/run-phase-d-kv-dsn-verify-full-plan.js',
  'scripts/run-phase-d-kv-dsn-verify-full-apply.js',
  'scripts/run-phase-d-lunabox-pg-firewall-apply.js',
  'scripts/run-phase-d-constraint-apply.js',
  'scripts/prove-sunset-schema-slice14j-kv-dsn-verify-full-plan.js',
  'scripts/prove-sunset-schema-slice14k-kv-dsn-verify-full-activation.js',
  'scripts/prove-sunset-schema-slice14n-lunabox-pg-firewall.js',
  'scripts/prove-sunset-schema-slice14p-apply-phase-d-constraints.js',
  'scripts/verify-sunset-schema-slice14j.js',
  'scripts/verify-sunset-schema-slice14k.js',
  'scripts/verify-sunset-schema-slice14n.js',
  'scripts/verify-sunset-schema-slice14p.js',
  'infra/azure/sunset-staging/schema-observer-job.bicep',
  'scripts/lib/sunset-staging-iac-drift.js',
  'scripts/lib/sunset-schema-observer.js',
  'scripts/inventory-sunset-staging-live.js',
  'scripts/verify-sunset-staging-live-iac-drift.js',
  'scripts/verify-sunset-staging-iac-secret-scan.js',
  'scripts/verify-sunset-staging-iac-diff-check.js',
  'scripts/verify-sunset-staging-bicep-reconcile.js',
  'scripts/verify-sunset-staging-bicep-preflight.js',
  'scripts/verify-sunset-schema-observer.js',
  'scripts/observe-sunset-schema-drift.js',
  'scripts/generate-sunset-expected-schema-contract.js',
  'scripts/prove-sunset-schema-observer-local.js',
  'scripts/lib/sunset-schema-observer-role-provision.js',
  'scripts/lib/sunset-schema-observer-role-live-adapters.js',
  'scripts/lib/sunset-schema-observer-role-container-pg.js',
  'scripts/lib/sunset-schema-observer-role-bootstrap-pg.js',
  'scripts/provision-sunset-schema-observer-role.js',
  'scripts/verify-sunset-schema-observer-role-provision.js',
  'scripts/capture-sunset-staging-rg-cost.js',
  'scripts/load-sunset-staging-pg-admin-env.js',
  'scripts/run-sunset-schema-observer-role-slice9.js',
  'scripts/prepare-sunset-schema-observer-job-slice10-params.js',
  'scripts/dump-sunset-live-schema-contract.js',
  'scripts/prove-sunset-schema-observer-slice11-injob.js',
  'scripts/capture-sunset-live-schema-observation.js',
  'scripts/compare-sunset-canonical-vs-live-evidence.js',
  'fixtures/sunset-schema-observer/slice11-job-execution-evidence.json',
  'fixtures/sunset-schema-observer/slice11-canonical-vs-live-mismatch-report.json',
  'fixtures/sunset-schema-observer/slice12-observer-image-repair-contract.json',
  'scripts/preflight-sunset-staging-bicep.js',
  'scripts/lib/sunset-staging-bicep-preflight.js',
  'scripts/run-sunset-staging-bicep-preflight-live-probe.js',
  'fixtures/sunset-schema-observer',
];

function discoverCommittedArtifacts() {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...DISCOVERY_PATHSPECS], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  // Scan every discovered committed artifact, including fixtures (no broad path exclusions).
  return out
    .split('\0')
    .map((l) => l.trim())
    .filter(Boolean);
}

let failed = 0;
console.log('verify:sunset-staging-iac-secret-scan — discover committed slice artifacts\n');

const artifacts = discoverCommittedArtifacts();
if (artifacts.length === 0) {
  console.log('  FAIL  no committed slice artifacts discovered');
  failed += 1;
} else {
  console.log(`  discovered ${artifacts.length} committed artifact(s)`);
}

for (const rel of artifacts) {
  const abs = path.join(ROOT, rel);
  const text = fs.readFileSync(abs, 'utf8');
  // Contiguous sentinel must never appear in inventory artifacts.
  if (rel.startsWith('infra/azure/sunset-staging/inventory/') && text.includes(SYNTHETIC_SECRET_SENTINEL)) {
    console.log(`  FAIL  ${rel} contains synthetic sentinel (must not be committed)`);
    failed += 1;
    continue;
  }
  const hits = scanSecretValues(text);
  if (hits.length) {
    console.log(`  FAIL  ${rel}`);
    for (const h of hits) console.log(`        ${h.pattern} sample=${h.sample}`);
    failed += 1;
  } else {
    console.log(`  PASS  ${rel}`);
  }
}

// In-memory RED proof: synthetic sentinel must trigger scanner.
const redHits = scanSecretValues({ probe: SYNTHETIC_SECRET_SENTINEL });
if (redHits.length === 0) {
  console.log('  FAIL  synthetic sentinel did not trigger secret scanner');
  failed += 1;
} else {
  console.log('  PASS  synthetic sentinel triggers scanner in-memory (expected)');
}

// Live inventory must have zero secret hits and must exist.
const liveRel = 'infra/azure/sunset-staging/inventory/live-inventory.normalized.json';
if (!artifacts.includes(liveRel)) {
  console.log(`  FAIL  missing required live inventory in discovery: ${liveRel}`);
  failed += 1;
}

console.log(`\n── secret-scan: ${failed ? 'FAILED' : 'PASSED'} (${artifacts.length} files) ──`);
process.exit(failed ? 1 : 0);
