'use strict';

/**
 * observe-sunset-schema-drift — FOUNDATION Slice 6 one-shot observer CLI.
 *
 * Reads SUNSET_SCHEMA_OBSERVER_DATABASE_URL (dedicated future read-only DSN).
 * Emits secret-free marker-delimited JSON. Nonzero exit on drift or safety failure.
 * Included in Dockerfile.luna-sunset-staff-api via COPY scripts.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  OBSERVER_DSN_ENV,
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  APPLICATION_NAME,
  SQL_REGISTRY_IDS,
  parseDatabaseUrl,
  assertObserverTarget,
  assertNoLeakedDsn,
  clientConfigFromDsn,
  fingerprintProductSchema,
  compareSnapshots,
  introspectProductSchema,
  verifyLiveSession,
  contractStalenessErrors,
  contractScopeMeta,
  redactSecrets,
} = require('./lib/sunset-schema-observer');
const { loadManifest, MANIFEST_PATH } = require('./lib/migration-integrity');

const ROOT = path.join(__dirname, '..');
const DEFAULT_CONTRACT = path.join(
  ROOT,
  'fixtures',
  'sunset-schema-observer',
  'expected-product-schema.json',
);

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function emit(payload) {
  const text = JSON.stringify(payload);
  const leaks = assertNoLeakedDsn(text, process.env[OBSERVER_DSN_ENV] || null);
  if (leaks.length) {
    throw Object.assign(new Error(`observer output leaked secrets: ${leaks.join(',')}`), {
      code: 'leaked_dsn',
    });
  }
  process.stdout.write('WH_SCHEMA_OBSERVER_BEGIN\n');
  process.stdout.write(`${text}\n`);
  process.stdout.write('WH_SCHEMA_OBSERVER_END\n');
}

async function main() {
  const allowLocal = process.argv.includes('--allow-local-ephemeral');
  const contractPath = argValue('--contract') || DEFAULT_CONTRACT;
  const dsn = process.env[OBSERVER_DSN_ENV] || '';
  if (!dsn) {
    emit({
      ok: false,
      code: 'missing_dsn_env',
      message: `${OBSERVER_DSN_ENV} is required`,
    });
    process.exit(2);
  }

  const parsed = parseDatabaseUrl(dsn);
  if (!parsed.ok) {
    emit({ ok: false, code: 'dsn_parse_failed', errors: parsed.errors });
    process.exit(2);
  }
  const targetGate = assertObserverTarget(parsed.parsed, { allowLocalEphemeral: allowLocal });
  if (!targetGate.ok) {
    emit({ ok: false, code: 'wrong_target', errors: targetGate.errors });
    process.exit(2);
  }

  if (!fs.existsSync(contractPath)) {
    emit({ ok: false, code: 'contract_missing', message: contractPath });
    process.exit(2);
  }
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const manifest = loadManifest(MANIFEST_PATH);
  const stale = contractStalenessErrors(contract, manifest);
  if (stale.length) {
    emit({ ok: false, code: 'stale_contract', errors: stale });
    process.exit(2);
  }

  const cfg = clientConfigFromDsn(dsn, { allowLocalEphemeral: allowLocal });
  const client = new Client(cfg);
  let report = {
    ok: false,
    kind: 'sunset-schema-observer',
    application_name: APPLICATION_NAME,
    target: {
      host: allowLocal ? parsed.parsed.host : EXPECTED_HOST,
      database: allowLocal ? parsed.parsed.database : EXPECTED_DATABASE,
    },
    session: null,
    productFingerprintExpected: contract.productFingerprint,
    productFingerprintLive: null,
    match: false,
    drift: { counts: { expected_only: 0, live_only: 0, definition_mismatch: 0 }, sample: [] },
    sqlRegistryExact: SQL_REGISTRY_IDS.slice(),
    ...contractScopeMeta(contract),
    contract: {
      manifestHash: contract.manifestHash,
      productFingerprint: contract.productFingerprint,
      forwardCount: contract.forwardCount,
      scope: contract.scope,
      includedSections: contract.includedSections,
      excludedSections: contract.excludedSections,
    },
  };

  try {
    await client.connect();
    const session = await verifyLiveSession(client);
    if (!session.ok) {
      report.code = 'session_not_read_only';
      report.errors = session.errors;
      emit(report);
      process.exit(3);
    }
    report.session = session.show;
    const product = await introspectProductSchema(client);
    report.productFingerprintLive = fingerprintProductSchema(product.snapshot);
    const cmp = compareSnapshots(contract.snapshot, product.snapshot);
    report.drift.counts = cmp.counts;
    report.drift.sample = cmp.drifts.slice(0, 100);
    report.match = cmp.ok && report.productFingerprintExpected === report.productFingerprintLive;
    report.ok = report.match;
    if (!report.match) report.code = 'product_schema_differs';
    emit(report);
    process.exit(report.ok ? 0 : 4);
  } catch (e) {
    report.ok = false;
    report.code = e.code || 'observer_error';
    report.message = redactSecrets(e.message || String(e)).slice(0, 500);
    try {
      emit(report);
    } catch (_) {
      process.stderr.write(redactSecrets(String(e.message || e)));
    }
    process.exit(1);
  } finally {
    try {
      await client.end();
    } catch (_) {
      /* ignore */
    }
  }
}

main();
