'use strict';

/**
 * verify:sunset-staging-live-iac-drift
 *
 * Deterministic secret-safe gate for FOUNDATION Slice 1.
 * Consumes the single sanitized live inventory JSON.
 * Fails on: schema errors, unknown RG resources, forbidden Wolfhouse runtime
 * references, secret values, unclassified env vars, or unresolved material drift.
 *
 * Self-tests deep-clone the baseline in memory and apply minimal mutations.
 * They never write the baseline file.
 *
 * No Azure calls. No mutations. Exit 0 on pass.
 *
 * Usage:
 *   node scripts/verify-sunset-staging-live-iac-drift.js
 *   node scripts/verify-sunset-staging-live-iac-drift.js --fixture path.json
 *   node scripts/verify-sunset-staging-live-iac-drift.js --self-test
 */

const fs = require('fs');
const path = require('path');
const {
  validateSchema,
  scanSecretValues,
  scanForbiddenWolfhouseRuntime,
  findUnknownResources,
  findUnresolvedMaterialDrift,
  findUnclassifiedEnvVars,
  summarizeByClassification,
  CLASSIFICATIONS,
  deepClone,
  SYNTHETIC_SECRET_SENTINEL,
} = require('./lib/sunset-staging-iac-drift');

const ROOT = path.join(__dirname, '..');
const DEFAULT_FIXTURE = path.join(
  ROOT,
  'infra/azure/sunset-staging/inventory/live-inventory.normalized.json',
);

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function evaluate(inventory, label) {
  const errors = [];
  const schemaErrors = validateSchema(inventory);
  for (const e of schemaErrors) errors.push(`schema: ${e}`);

  const secretHits = scanSecretValues(inventory);
  for (const h of secretHits) errors.push(`secret-value: ${h.pattern} sample=${h.sample}`);

  const wolfHits = scanForbiddenWolfhouseRuntime(inventory);
  for (const h of wolfHits) errors.push(`forbidden-wolfhouse-runtime: ${h}`);

  const unknown = findUnknownResources(inventory);
  for (const r of unknown) errors.push(`unknown-resource: ${r.type}::${r.name}`);

  const unresolved = findUnresolvedMaterialDrift(inventory);
  for (const item of unresolved) {
    errors.push(
      `unresolved-drift: ${item.id || '(missing-id)'} classification=${item.classification} resolved=${item.resolved}`,
    );
  }

  for (const e of findUnclassifiedEnvVars(inventory)) {
    errors.push(e);
  }

  for (const item of inventory.items || []) {
    if (!CLASSIFICATIONS.includes(item.classification)) {
      errors.push(`bad-classification: ${item.id} -> ${item.classification}`);
    }
  }

  return {
    label,
    ok: errors.length === 0,
    errors,
    counts: summarizeByClassification(inventory),
    resourceCount: Array.isArray(inventory.resources) ? inventory.resources.length : 0,
  };
}

function printResult(result) {
  const mark = result.ok ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  ${result.label} (resources=${result.resourceCount})`);
  if (!result.ok) {
    for (const e of result.errors) console.log(`        - ${e}`);
  } else {
    console.log(`        classifications=${JSON.stringify(result.counts)}`);
  }
  return result.ok;
}

function mutateUnknownResource(base) {
  const inv = deepClone(base);
  inv.resources.push({
    name: 'rogue-storage',
    type: 'Microsoft.Storage/storageAccounts',
    location: 'westeurope',
    tags: null,
  });
  return inv;
}

function mutateWolfhouseRuntime(base) {
  const inv = deepClone(base);
  inv.normalized.staffApi.image = 'whstagingacr.azurecr.io/wh-staff-api:deadbeef';
  return inv;
}

function mutateSecretValue(base) {
  const inv = deepClone(base);
  inv.normalized.keyVault.syntheticProbe = SYNTHETIC_SECRET_SENTINEL;
  return inv;
}

function mutateUnresolvedDrift(base) {
  const inv = deepClone(base);
  inv.items.push({
    id: 'mystery-drift',
    resourceKey: 'Microsoft.App/containerApps::luna-sunset-staging-staff-api',
    classification: 'materially_drifted',
    declared: 'x',
    live: 'y',
    resolved: false,
  });
  return inv;
}

function runSelfTest() {
  console.log('verify:sunset-staging-live-iac-drift — self-test (RED→GREEN)\n');

  const baselinePath = DEFAULT_FIXTURE;
  const baselineBefore = fs.readFileSync(baselinePath, 'utf8');
  const baseline = JSON.parse(baselineBefore);

  const cases = [
    { name: 'green-baseline', inventory: deepClone(baseline), expectPass: true },
    {
      name: 'red-unknown-resource',
      inventory: mutateUnknownResource(baseline),
      expectPass: false,
      expectNeedle: 'unknown-resource',
    },
    {
      name: 'red-wolfhouse-runtime',
      inventory: mutateWolfhouseRuntime(baseline),
      expectPass: false,
      expectNeedle: 'forbidden-wolfhouse-runtime',
    },
    {
      name: 'red-secret-value',
      inventory: mutateSecretValue(baseline),
      expectPass: false,
      expectNeedle: 'secret-value',
    },
    {
      name: 'red-unresolved-material-drift',
      inventory: mutateUnresolvedDrift(baseline),
      expectPass: false,
      expectNeedle: 'unresolved-drift',
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const result = evaluate(c.inventory, c.name);
    const passOk = c.expectPass ? result.ok : !result.ok;
    const needleOk = c.expectNeedle
      ? result.errors.some((e) => e.includes(c.expectNeedle))
      : true;
    const ok = passOk && needleOk;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  self-test ${c.name} (expectPass=${c.expectPass}` +
        `${c.expectNeedle ? `, needle=${c.expectNeedle}` : ''})`,
    );
    if (!ok) {
      failed += 1;
      console.log(`        result.ok=${result.ok} errors=${JSON.stringify(result.errors)}`);
    }
  }

  const baselineAfter = fs.readFileSync(baselinePath, 'utf8');
  if (baselineAfter !== baselineBefore) {
    console.log('  FAIL  baseline file was modified during self-test');
    failed += 1;
  } else {
    console.log('  PASS  baseline file unchanged after in-memory mutations');
  }

  const live = evaluate(baseline, 'live-inventory.normalized.json');
  if (!printResult(live)) failed += 1;

  console.log(`\n── self-test: ${failed ? 'FAILED' : 'PASSED'} ──`);
  return failed === 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    process.exit(runSelfTest() ? 0 : 1);
  }

  const idx = args.indexOf('--fixture');
  const fixturePath = idx >= 0 ? path.resolve(args[idx + 1]) : DEFAULT_FIXTURE;

  console.log('verify:sunset-staging-live-iac-drift — read-only fixture gate\n');
  console.log(`  fixture: ${path.relative(ROOT, fixturePath)}`);

  const inventory = loadJson(fixturePath);
  const result = evaluate(inventory, path.basename(fixturePath));
  const ok = printResult(result);

  if (inventory.cost) {
    console.log(
      `\n  cost baseline: ${inventory.cost.amount} ${inventory.cost.currency}` +
        ` (${inventory.cost.period && inventory.cost.period.from} → ${inventory.cost.period && inventory.cost.period.to})` +
        ` scope=${inventory.cost.scope}`,
    );
  }
  console.log(`  live inventory resource count: ${result.resourceCount}`);

  console.log(`\n── verify:sunset-staging-live-iac-drift: ${ok ? 'ALL CHECKS PASSED' : 'FAILED'} ──`);
  process.exit(ok ? 0 : 1);
}

main();
