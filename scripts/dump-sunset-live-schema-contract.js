'use strict';

/**
 * In-container dump of ACTUAL LIVE product-schema observation (job env DSN secretRef).
 * Emits secret-free chunked WH_LIVE_CONTRACT markers (Log Analytics line-size safe).
 *
 * Observation only — not canonical. Must never be written over
 * fixtures/sunset-schema-observer/expected-product-schema.json.
 * Canonical expected state comes only from the reviewed migration chain/manifest.
 */

const {
  introspectProductSchema,
  fingerprintProductSchema,
  CONTRACT_SCOPE,
  INCLUDED_SECTIONS,
  EXCLUDED_SECTIONS,
  OWNERSHIP_COVERAGE,
  ACL_COVERAGE,
  EXTENSION_COVERAGE,
  hashCanonicalManifest,
  OBSERVER_DSN_ENV,
  assertNoLeakedDsn,
  redactSecrets,
} = require('./lib/sunset-schema-observer');
const { loadManifest, MANIFEST_PATH } = require('./lib/migration-integrity');
const { Client } = require('pg');

const CHUNK = 1200;

function emitChunks(payload) {
  const text = JSON.stringify(payload);
  const leaks = assertNoLeakedDsn(text, process.env[OBSERVER_DSN_ENV] || null);
  if (leaks.length) throw new Error(`contract dump leaked secrets: ${leaks.join(',')}`);
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const parts = Math.ceil(b64.length / CHUNK) || 1;
  process.stdout.write(`WH_LIVE_CONTRACT_CHUNKS ${parts}\n`);
  for (let i = 0; i < parts; i += 1) {
    const slice = b64.slice(i * CHUNK, (i + 1) * CHUNK);
    process.stdout.write(`WH_LIVE_CONTRACT_PART ${i + 1}/${parts} ${slice}\n`);
  }
  process.stdout.write('WH_LIVE_CONTRACT_DONE\n');
}

async function main() {
  const dsn = process.env[OBSERVER_DSN_ENV] || '';
  if (!dsn) {
    emitChunks({ ok: false, error: 'missing_dsn_env' });
    process.exit(2);
  }
  const client = new Client({
    connectionString: dsn,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 20000,
    application_name: 'wh-sunset-schema-observer',
  });
  await client.connect();
  try {
    const product = await introspectProductSchema(client);
    const manifest = loadManifest(MANIFEST_PATH);
    const { manifestHash, forward } = hashCanonicalManifest(manifest);
    const productFingerprint = fingerprintProductSchema(product.snapshot);
    emitChunks({
      ok: true,
      contract: {
        kind: 'sunset-live-product-schema-observation',
        scope: CONTRACT_SCOPE,
        includedSections: INCLUDED_SECTIONS.slice(),
        excludedSections: EXCLUDED_SECTIONS.slice(),
        ownershipCoverage: OWNERSHIP_COVERAGE.slice(),
        aclCoverage: ACL_COVERAGE.slice(),
        extensionCoverage: EXTENSION_COVERAGE.slice(),
        generatedAt: new Date().toISOString(),
        source: 'live-observation-only',
        label: 'actual live state — not canonical',
        notCanonical: true,
        forwardCount: forward.length,
        manifestHash,
        productFingerprint,
        snapshot: product.snapshot,
      },
    });
    process.exit(0);
  } catch (e) {
    emitChunks({ ok: false, error: redactSecrets(String(e && e.message || e)).slice(0, 400) });
    process.exit(1);
  } finally {
    try { await client.end(); } catch (_) { /* ignore */ }
  }
}

main();
