'use strict';

/**
 * capture-radar-operations-staging-readonly — RADAR 16A2
 *
 * Exact read-only Azure capture for the operations gate ledger.
 * Restricted before dispatch to subscription
 * 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 and RGs
 * wh-staging-rg / luna-sunset-staging-rg only.
 *
 * Usage:
 *   node scripts/capture-radar-operations-staging-readonly.js
 *   node scripts/capture-radar-operations-staging-readonly.js --write-fixtures
 *
 * Default writes under tmp/radar-16a2-capture/. --write-fixtures also updates
 * fixtures/radar-operations/live-inventory.json and capture-log.json.
 */

const fs = require('fs');
const path = require('path');
const {
  buildCaptureManifest,
  runCaptureRedTests,
  captureStagingReadonly,
  canonicalJson,
} = require('./lib/radar-operations-azure-capture');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'radar-operations');
const TMP_DIR = path.join(ROOT, 'tmp', 'radar-16a2-capture');

async function main() {
  const writeFixtures = process.argv.includes('--write-fixtures');

  const red = runCaptureRedTests();
  if (red.fail > 0) {
    console.error('RED capture guards failed:');
    for (const c of red.cases.filter((x) => !x.ok)) {
      console.error(`  ${c.id}: ${c.detail}`);
    }
    process.exit(2);
  }
  console.log(`RED capture guards: ${red.pass} passed`);

  const manifest = buildCaptureManifest();
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });

  const manifestPath = path.join(FIXTURE_DIR, 'capture-manifest.json');
  fs.writeFileSync(manifestPath, canonicalJson(manifest));
  console.log(`wrote ${path.relative(ROOT, manifestPath)}`);

  const { inventory, capture_log } = await captureStagingReadonly({ tmpDir: TMP_DIR });

  const invTmp = path.join(TMP_DIR, 'live-inventory.json');
  const logTmp = path.join(TMP_DIR, 'capture-log.json');
  fs.writeFileSync(invTmp, canonicalJson(inventory));
  fs.writeFileSync(logTmp, canonicalJson(capture_log));
  console.log(`wrote ${path.relative(ROOT, invTmp)}`);
  console.log(`wrote ${path.relative(ROOT, logTmp)}`);
  console.log(`calls=${capture_log.calls.length} combined_mtd=${inventory.costs_mtd.combined_total}`);

  if (writeFixtures) {
    const invFix = path.join(FIXTURE_DIR, 'live-inventory.json');
    const logFix = path.join(FIXTURE_DIR, 'capture-log.json');
    fs.writeFileSync(invFix, canonicalJson(inventory));
    fs.writeFileSync(logFix, canonicalJson(capture_log));
    console.log(`wrote fixtures ${path.relative(ROOT, invFix)}`);
    console.log(`wrote fixtures ${path.relative(ROOT, logFix)}`);
  }
}

main().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(1);
});
