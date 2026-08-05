'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASELINE_PATH = path.join(__dirname, '..', '..', 'fixtures', 'sunset-staging-ledger-reconcile', 'canonical-056-semantics-baseline.json');
const CAPTURE_SCRIPT_PATH = path.join(__dirname, '..', 'capture-sunset-056-semantics-baseline.js');
const MIGRATION_056_ID = '056_booking_refund_records';

const CATALOG_PROBE_SQL = `
SELECT json_build_object(
  'columns_056', (
    SELECT COALESCE(json_agg(json_build_object(
      'name', a.attname,
      'type', format_type(a.atttypid, a.atttypmod),
      'not_null', a.attnotnull,
      'default', pg_get_expr(ad.adbin, ad.adrelid)
    ) ORDER BY a.attnum), '[]'::json)
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relname = 'booking_refund_records' AND a.attnum > 0 AND NOT a.attisdropped
  ),
  'checks_056', (
    SELECT COALESCE(json_agg(json_build_object(
      'name', con.conname,
      'def', pg_get_constraintdef(con.oid, true)
    ) ORDER BY con.conname), '[]'::json)
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public' AND rel.relname = 'booking_refund_records' AND con.contype = 'c'
  ),
  'fks_056', (
    SELECT COALESCE(json_agg(json_build_object(
      'name', con.conname,
      'def', pg_get_constraintdef(con.oid, true)
    ) ORDER BY con.conname), '[]'::json)
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public' AND rel.relname = 'booking_refund_records' AND con.contype = 'f'
  ),
  'pk_056', (
    SELECT json_build_object(
      'name', con.conname,
      'def', pg_get_constraintdef(con.oid, true)
    )
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public' AND rel.relname = 'booking_refund_records' AND con.contype = 'p'
    LIMIT 1
  ),
  'pk_index_056', (
    SELECT json_build_object(
      'name', i.relname,
      'def', pg_get_indexdef(ix.indexrelid, 0, true),
      'unique', ix.indisunique,
      'method', am.amname
    )
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_am am ON am.oid = i.relam
    WHERE n.nspname = 'public' AND t.relname = 'booking_refund_records' AND ix.indisprimary
    LIMIT 1
  ),
  'indexes_booking_refund_records', (
    SELECT COALESCE(json_agg(json_build_object(
      'name', i.relname,
      'def', pg_get_indexdef(ix.indexrelid, 0, true),
      'unique', ix.indisunique,
      'method', am.amname
    ) ORDER BY i.relname), '[]'::json)
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_am am ON am.oid = i.relam
    WHERE n.nspname = 'public' AND t.relname = 'booking_refund_records' AND NOT ix.indisprimary
  ),
  'index_bookings_uidx_056', (
    SELECT json_build_object(
      'name', i.relname,
      'def', pg_get_indexdef(ix.indexrelid, 0, true),
      'unique', ix.indisunique,
      'method', am.amname
    )
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_namespace n ON n.oid = i.relnamespace
    JOIN pg_am am ON am.oid = i.relam
    WHERE n.nspname = 'public' AND i.relname = 'bookings_id_client_id_uidx'
    LIMIT 1
  ),
  'triggers_056', (
    SELECT COALESCE(json_agg(json_build_object(
      'name', tg.tgname,
      'def', pg_get_triggerdef(tg.oid, true),
      'enabled', tgenabled = 'O'
    ) ORDER BY tg.tgname), '[]'::json)
    FROM pg_trigger tg
    JOIN pg_class rel ON rel.oid = tg.tgrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public' AND rel.relname = 'booking_refund_records' AND NOT tg.tgisinternal
  ),
  'functions_056', (
    SELECT COALESCE(json_agg(json_build_object(
      'name', p.proname,
      'identity', pg_get_function_identity_arguments(p.oid),
      'def', pg_get_functiondef(p.oid)
    ) ORDER BY p.proname), '[]'::json)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('booking_refund_records_reject_update', 'booking_refund_records_reject_delete')
  ),
  'hidden_060', (
    SELECT json_build_object(
      'name', a.attname,
      'type', format_type(a.atttypid, a.atttypmod),
      'not_null', a.attnotnull,
      'default', pg_get_expr(ad.adbin, ad.adrelid)
    )
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relname = 'bookings' AND a.attname = 'hidden' AND a.attnum > 0 AND NOT a.attisdropped
  ),
  'index_060', (
    SELECT json_build_object(
      'name', i.relname,
      'def', pg_get_indexdef(ix.indexrelid, 0, true),
      'unique', ix.indisunique,
      'method', am.amname
    )
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_namespace n ON n.oid = i.relnamespace
    JOIN pg_am am ON am.oid = i.relam
    WHERE n.nspname = 'public' AND i.relname = 'bookings_hidden_true_idx'
    LIMIT 1
  ),
  'has_057_locations', to_regclass('public.tenant_locations') IS NOT NULL,
  'has_057_endpoints', to_regclass('public.tenant_channel_endpoints') IS NOT NULL,
  'has_058_connector_mode', EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tenant_channel_endpoints' AND column_name = 'connector_mode'
  ),
  'has_059_grants', to_regclass('public.tenant_email_delegated_grants') IS NOT NULL
) AS catalog
`;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function normalizeDef(def) {
  return String(def || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\bpublic\./g, '');
}

function normalizeColumn(col) {
  return {
    name: String(col.name),
    type: String(col.type).toLowerCase(),
    not_null: Boolean(col.not_null),
    default: col.default == null ? null : normalizeDef(col.default),
  };
}

function normalizeNamedDef(item) {
  return {
    name: String(item.name),
    def: normalizeDef(item.def),
    unique: item.unique == null ? undefined : Boolean(item.unique),
    method: item.method == null ? undefined : String(item.method).toLowerCase(),
    enabled: item.enabled == null ? undefined : Boolean(item.enabled),
    identity: item.identity == null ? undefined : normalizeDef(item.identity),
  };
}

function canonicalizeCatalogRow(row) {
  const data = row || {};
  return {
    columns_056: (data.columns_056 || []).map(normalizeColumn),
    checks_056: (data.checks_056 || []).map(normalizeNamedDef).sort((a, b) => a.name.localeCompare(b.name)),
    fks_056: (data.fks_056 || []).map(normalizeNamedDef).sort((a, b) => a.name.localeCompare(b.name)),
    pk_056: data.pk_056 ? normalizeNamedDef(data.pk_056) : null,
    pk_index_056: data.pk_index_056 ? normalizeNamedDef(data.pk_index_056) : null,
    indexes_booking_refund_records: (data.indexes_booking_refund_records || []).map(normalizeNamedDef).sort((a, b) => a.name.localeCompare(b.name)),
    index_bookings_uidx_056: data.index_bookings_uidx_056 ? normalizeNamedDef(data.index_bookings_uidx_056) : null,
    triggers_056: (data.triggers_056 || []).map(normalizeNamedDef).sort((a, b) => a.name.localeCompare(b.name)),
    functions_056: (data.functions_056 || []).map(normalizeNamedDef).sort((a, b) => a.name.localeCompare(b.name)),
    hidden_060: data.hidden_060 ? normalizeColumn(data.hidden_060) : null,
    index_060: data.index_060 ? normalizeNamedDef(data.index_060) : null,
    has_057_locations: Boolean(data.has_057_locations),
    has_057_endpoints: Boolean(data.has_057_endpoints),
    has_058_connector_mode: Boolean(data.has_058_connector_mode),
    has_059_grants: Boolean(data.has_059_grants),
  };
}

function semanticCatalogFingerprint(row) {
  return sha256Text(stableStringify(canonicalizeCatalogRow(row)));
}

async function captureSemanticCatalog(client) {
  const res = await client.query(CATALOG_PROBE_SQL);
  const row = (res.rows && res.rows[0] && res.rows[0].catalog) || {};
  const canonical = canonicalizeCatalogRow(row);
  return { row: canonical, fingerprint: semanticCatalogFingerprint(canonical) };
}

async function probeSemanticCatalog(client) {
  return captureSemanticCatalog(client);
}

function digestCaptureScript() {
  return sha256Text(fs.readFileSync(CAPTURE_SCRIPT_PATH, 'utf8'));
}

function readBaselineArtifact() {
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

function resolveMigration056Checksum() {
  const { loadManifestContext } = require('./sunset-staging-ledger-reconcile');
  const ctx = loadManifestContext();
  const entry = ctx.entries.find((e) => e.id === MIGRATION_056_ID);
  if (!entry) throw new Error(`migration ${MIGRATION_056_ID} not found in manifest`);
  return entry.sha256;
}

function resolveSourceSha() {
  return String(execSync('git rev-parse HEAD', { encoding: 'utf8' })).trim();
}

function assertSourceShaKnown(sourceSha) {
  try {
    execSync(`git merge-base --is-ancestor ${sourceSha} HEAD`, {
      encoding: 'utf8',
      cwd: path.join(__dirname, '..', '..'),
      stdio: 'pipe',
    });
    return true;
  } catch (_) {
    return false;
  }
}

function verifyCanonical056BaselineBindings(raw) {
  const artifact = raw || readBaselineArtifact();
  const provenance = artifact.provenance || {};
  const errors = [];
  const catalog = canonicalizeCatalogRow(artifact.catalog || artifact);
  const fingerprint = semanticCatalogFingerprint(catalog);

  if (!provenance.sourceSha) errors.push({ code: 'baseline_binding_source_sha_missing' });
  else if (!assertSourceShaKnown(provenance.sourceSha)) {
    errors.push({ code: 'baseline_binding_source_sha_unknown' });
  }

  if (!provenance.migration056ChecksumSha256) errors.push({ code: 'baseline_binding_migration056_checksum_missing' });
  else if (provenance.migration056ChecksumSha256 !== resolveMigration056Checksum()) {
    errors.push({ code: 'baseline_binding_migration056_checksum_mismatch' });
  }

  if (!provenance.captureScriptDigest) errors.push({ code: 'baseline_binding_capture_script_digest_missing' });
  else if (provenance.captureScriptDigest !== digestCaptureScript()) {
    errors.push({ code: 'baseline_binding_capture_script_digest_mismatch' });
  }

  if (!provenance.postgresVersion) errors.push({ code: 'baseline_binding_postgres_version_missing' });
  if (!provenance.semanticFingerprint) errors.push({ code: 'baseline_binding_semantic_fingerprint_missing' });
  else if (provenance.semanticFingerprint !== fingerprint) {
    errors.push({ code: 'baseline_binding_semantic_fingerprint_mismatch' });
  } else if (artifact.fingerprint && artifact.fingerprint !== fingerprint) {
    errors.push({ code: 'baseline_top_level_fingerprint_mismatch' });
  }

  if (!catalog.pk_056 || !catalog.pk_index_056) errors.push({ code: 'baseline_pk_056_missing' });

  return { ok: errors.length === 0, errors, catalog, fingerprint, provenance };
}

function loadCanonical056Baseline() {
  const gate = verifyCanonical056BaselineBindings();
  if (!gate.ok) {
    const err = new Error('canonical 056 baseline bindings refused');
    err.code = gate.errors[0].code;
    err.errors = gate.errors;
    throw err;
  }
  return gate.catalog;
}

function tryLoadCanonical056Baseline() {
  return verifyCanonical056BaselineBindings();
}

function compareCatalog(live, baseline, scope) {
  const errors = [];
  const liveCanon = canonicalizeCatalogRow(live);
  const baseCanon = canonicalizeCatalogRow(baseline);
  const liveJson = stableStringify(liveCanon);
  const baseJson = stableStringify(baseCanon);
  if (liveJson !== baseJson) {
    errors.push({ code: `semantic_${scope}_catalog_mismatch`, message: 'canonical catalog definitions differ' });
  }
  return errors;
}

function assertSemanticBaseline056060(row, baseline) {
  const errors = compareCatalog(row, baseline || loadCanonical056Baseline(), '056060_baseline');
  const data = canonicalizeCatalogRow(row);
  if (data.has_057_locations || data.has_057_endpoints) errors.push({ code: 'semantic_057_unexpected' });
  if (data.has_058_connector_mode) errors.push({ code: 'semantic_058_unexpected' });
  if (data.has_059_grants) errors.push({ code: 'semantic_059_unexpected' });
  return { ok: errors.length === 0, errors };
}

function assertPostApplySemantic(row) {
  const errors = [];
  const data = canonicalizeCatalogRow(row);
  if (!data.has_057_locations || !data.has_057_endpoints) errors.push({ code: 'semantic_057_missing' });
  if (!data.has_058_connector_mode) errors.push({ code: 'semantic_058_missing' });
  if (!data.has_059_grants) errors.push({ code: 'semantic_059_missing' });
  return { ok: errors.length === 0, errors };
}

function buildCanonicalPreApplySemanticRow() {
  return loadCanonical056Baseline();
}

function driftCatalog(baseline, kind) {
  const copy = JSON.parse(JSON.stringify(canonicalizeCatalogRow(baseline)));
  if (kind === 'wrong_check') copy.checks_056[0].def = '(amount_cents < 0)';
  if (kind === 'wrong_fk') copy.fks_056[0].def = copy.fks_056[0].def.replace('bookings', 'clients');
  if (kind === 'wrong_index_keys') copy.indexes_booking_refund_records[1].def = copy.indexes_booking_refund_records[1].def.replace('client_id', 'booking_id');
  if (kind === 'non_unique_index') copy.index_bookings_uidx_056.unique = false;
  if (kind === 'wrong_trigger_event') copy.triggers_056[1].def = copy.triggers_056[1].def.replace('update', 'insert');
  if (kind === 'wrong_function_body') copy.functions_056[0].def = 'create function x() returns trigger language plpgsql as $$ begin return null; end $$;';
  if (kind === 'wrong_pk_constraint') copy.pk_056.def = 'primary key (client_id)';
  if (kind === 'wrong_pk_index') copy.pk_index_056.def = copy.pk_index_056.def.replace('(id)', '(client_id)');
  return copy;
}

module.exports = {
  BASELINE_PATH,
  CAPTURE_SCRIPT_PATH,
  MIGRATION_056_ID,
  CATALOG_PROBE_SQL,
  captureSemanticCatalog,
  probeSemanticCatalog,
  loadCanonical056Baseline,
  tryLoadCanonical056Baseline,
  verifyCanonical056BaselineBindings,
  digestCaptureScript,
  resolveMigration056Checksum,
  resolveSourceSha,
  canonicalizeCatalogRow,
  assertSemanticBaseline056060,
  assertPostApplySemantic,
  semanticCatalogFingerprint,
  buildCanonicalPreApplySemanticRow,
  driftCatalog,
  normalizeDef,
};
