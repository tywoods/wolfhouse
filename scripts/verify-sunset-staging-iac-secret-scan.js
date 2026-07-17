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
  'scripts/lib/sunset-staging-iac-drift.js',
  'scripts/inventory-sunset-staging-live.js',
  'scripts/verify-sunset-staging-live-iac-drift.js',
  'scripts/verify-sunset-staging-iac-secret-scan.js',
  'scripts/verify-sunset-staging-iac-diff-check.js',
  'scripts/verify-sunset-staging-bicep-reconcile.js',
  'scripts/verify-sunset-staging-bicep-preflight.js',
  'scripts/preflight-sunset-staging-bicep.js',
  'scripts/lib/sunset-staging-bicep-preflight.js',
  'scripts/run-sunset-staging-bicep-preflight-live-probe.js',
  'scripts/lib/sunset-schema-drift.js',
  'scripts/verify-sunset-schema-drift.js',
  'scripts/probe-sunset-live-schema-drift.js',
];

function discoverCommittedArtifacts() {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...DISCOVERY_PATHSPECS], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return out
    .split('\0')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((rel) => !rel.startsWith('fixtures/'));
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
