'use strict';

/**
 * Rebuild canonical-manifest.json sha256 values from reviewed migration files.
 * Does not invent entries, does not edit SQL, does not connect to a database.
 *
 * Usage: node scripts/rebuild-canonical-migration-manifest-checksums.js
 */

const fs = require('fs');
const path = require('path');
const {
  MANIFEST_PATH,
  MIGRATIONS_DIR,
  loadManifest,
  checksumMigrationFile,
  resolveChecksumMode,
} = require('./lib/migration-integrity');

function rebuildCanonicalManifestChecksums(opts) {
  const options = opts || {};
  const manifestPath = options.manifestPath || MANIFEST_PATH;
  const migrationsDir = options.migrationsDir || MIGRATIONS_DIR;
  const original = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(original);
  const modeGate = resolveChecksumMode(manifest);
  if (!modeGate.ok) {
    throw new Error(modeGate.message || modeGate.code);
  }
  const replacements = [];
  for (const entry of manifest.entries || []) {
    const abs = path.join(migrationsDir, entry.filename);
    if (!fs.existsSync(abs)) {
      throw new Error('missing_file:' + entry.filename);
    }
    const live = checksumMigrationFile(abs, modeGate.mode);
    if (!live.ok) {
      throw new Error((live.code || 'checksum_failed') + ':' + entry.filename);
    }
    if (live.sha256 !== entry.sha256) {
      replacements.push({
        id: entry.id,
        filename: entry.filename,
        from: entry.sha256,
        to: live.sha256,
      });
      entry.sha256 = live.sha256;
    }
  }
  let out = original;
  for (const item of replacements) {
    const needle = `"sha256": "${item.from}"`;
    const hits = out.split(needle).length - 1;
    if (hits !== 1) {
      throw new Error('sha256_not_unique:' + item.filename);
    }
    out = out.replace(needle, `"sha256": "${item.to}"`);
  }
  if (options.write !== false) {
    fs.writeFileSync(manifestPath, out);
  }
  return { ok: true, updated: replacements.length, replacements };
}

if (require.main === module) {
  const result = rebuildCanonicalManifestChecksums();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

module.exports = { rebuildCanonicalManifestChecksums };
