'use strict';

/**
 * Fail closed if any canonical-manifest sha256 does not match the reviewed file.
 * Offline. No database.
 *
 * Usage: node scripts/verify-canonical-migration-manifest-checksums.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const {
  MANIFEST_PATH,
  MIGRATIONS_DIR,
  loadManifest,
  checksumMigrationFile,
  resolveChecksumMode,
} = require('./lib/migration-integrity');
const { rebuildCanonicalManifestChecksums } = require('./rebuild-canonical-migration-manifest-checksums');

function collectMismatches(manifestPath, migrationsDir) {
  const manifest = loadManifest(manifestPath);
  const modeGate = resolveChecksumMode(manifest);
  if (!modeGate.ok) {
    return [{ code: modeGate.code, filename: null }];
  }
  const errors = [];
  for (const entry of manifest.entries || []) {
    const abs = path.join(migrationsDir, entry.filename);
    if (!fs.existsSync(abs)) {
      errors.push({ code: 'missing_file', filename: entry.filename });
      continue;
    }
    const live = checksumMigrationFile(abs, modeGate.mode);
    if (!live.ok) {
      errors.push({ code: live.code || 'checksum_failed', filename: entry.filename });
      continue;
    }
    if (live.sha256 !== entry.sha256) {
      errors.push({
        code: 'checksum_mismatch',
        filename: entry.filename,
        id: entry.id,
      });
    }
  }
  return errors;
}

function main() {
  const errors = collectMismatches(MANIFEST_PATH, MIGRATIONS_DIR);
  if (errors.length) {
    console.error('FAIL canonical migration checksums');
    for (const err of errors) {
      console.error(err.code + ' ' + (err.filename || ''));
    }
    process.exitCode = 1;
    return;
  }
  console.log('PASS canonical migration checksums match reviewed files');
}

function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-manifest-checksum-'));
  try {
    const copy = path.join(dir, 'canonical-manifest.json');
    fs.copyFileSync(MANIFEST_PATH, copy);
    const rebuilt = rebuildCanonicalManifestChecksums({
      manifestPath: copy,
      migrationsDir: MIGRATIONS_DIR,
      write: true,
    });
    assert.equal(collectMismatches(copy, MIGRATIONS_DIR).length, 0);

    const parsed = JSON.parse(fs.readFileSync(copy, 'utf8'));
    const target = parsed.entries.find((e) => e.id === '103_crowsnest_comms_number_route_audit') || parsed.entries[0];
    const tampered = fs.readFileSync(copy, 'utf8').replace(
      `"sha256": "${target.sha256}"`,
      `"sha256": "${'a'.repeat(64)}"`,
    );
    fs.writeFileSync(copy, tampered);
    const bad = collectMismatches(copy, MIGRATIONS_DIR);
    assert.ok(bad.some((e) => e.code === 'checksum_mismatch'));
    console.log('PASS verify-canonical-migration-manifest-checksums self-test');
    console.log('rebuild_updated', rebuilt.updated);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) selfTest();
  else main();
}

module.exports = { collectMismatches };
