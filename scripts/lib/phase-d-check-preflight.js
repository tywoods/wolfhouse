'use strict';

/**
 * FOUNDATION Slice 14A — Phase D CHECK aggregate preflight
 *
 * Source-only, default-disabled, read-only aggregate counts for the two
 * Phase D constraints already owned by immutable migration 028:
 *   - tenant_services_date_window
 *   - tenant_services_price_unit
 *
 * Returns only total_rows + violation counts. Never returns row values,
 * identifiers, guest data, or arbitrary SQL. Never mutates schema/rows,
 * never writes ledger, never applies constraints, never connects to Azure.
 */

const fs = require('fs');
const path = require('path');
const {
  MIGRATIONS_DIR,
  assertSafeDatabaseTarget,
  sha256CanonicalLfV1File,
} = require('./migration-integrity');

const MIG_028 = '028_tenant_services.sql';
const MIG_028_ID = '028_tenant_services';
const TABLE = 'tenant_services';
const SCHEMA = 'public';

/** Locked canonical_lf_v1 hash of immutable 028 (byte-identical preservation). */
const EXPECTED_028_SHA256 = 'f9972026a236b21c87442429e1b34e6951adca3e81cc84a88e82d538fa62e240';

/** Live / Azure apply capability — permanently false in this slice. */
const PHASE_D_LIVE_APPLY_ENABLED = false;

/** Must be set true by disposable prove scripts only. */
const DEFAULT_PHASE_D_PREFLIGHT_ENABLED = false;

/**
 * Exact CHECK predicates copied from migration 028 (locked).
 * date_window: CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
 * price_unit:  CHECK (price_unit IN ('per_day', 'per_week', 'per_stay', 'one_off'))
 */
const DATE_WINDOW_PREDICATE =
  '(end_date IS NULL OR start_date IS NULL OR end_date >= start_date)';
const PRICE_UNIT_PREDICATE =
  "(price_unit IN ('per_day', 'per_week', 'per_stay', 'one_off'))";

const DATE_WINDOW_VIOLATION_PREDICATE = `NOT ${DATE_WINDOW_PREDICATE}`;
const PRICE_UNIT_VIOLATION_PREDICATE = `NOT ${PRICE_UNIT_PREDICATE}`;

/**
 * Sole authorized aggregate query. Column aliases are the only allowed output shape.
 * No SELECT of id/name/notes/guest fields — counts only.
 */
const AUTHORIZED_AGGREGATE_SQL = [
  'SELECT',
  '  count(*)::bigint AS total_rows,',
  `  count(*) FILTER (WHERE ${DATE_WINDOW_VIOLATION_PREDICATE})::bigint AS date_window_violations,`,
  `  count(*) FILTER (WHERE ${PRICE_UNIT_VIOLATION_PREDICATE})::bigint AS price_unit_violations`,
  `FROM ${SCHEMA}.${TABLE}`,
].join('\n');

/** Columns required for the two CHECK predicates (types locked to 028). */
const REQUIRED_COLUMNS = Object.freeze([
  Object.freeze({ name: 'start_date', udt: 'date', nullable: true }),
  Object.freeze({ name: 'end_date', udt: 'date', nullable: true }),
  Object.freeze({ name: 'price_unit', udt: 'text', nullable: false }),
]);

const OUTPUT_KEYS = Object.freeze([
  'total_rows',
  'date_window_violations',
  'price_unit_violations',
]);

const AGGREGATE_CONTRACT = Object.freeze({
  kind: 'phase-d-check-aggregate-preflight',
  migrationId: MIG_028_ID,
  migrationFilename: MIG_028,
  sha256CanonicalLfV1: EXPECTED_028_SHA256,
  table: `${SCHEMA}.${TABLE}`,
  constraints: Object.freeze([
    Object.freeze({
      name: 'tenant_services_date_window',
      predicate: DATE_WINDOW_PREDICATE,
      violationPredicate: DATE_WINDOW_VIOLATION_PREDICATE,
      countKey: 'date_window_violations',
    }),
    Object.freeze({
      name: 'tenant_services_price_unit',
      predicate: PRICE_UNIT_PREDICATE,
      violationPredicate: PRICE_UNIT_VIOLATION_PREDICATE,
      countKey: 'price_unit_violations',
    }),
  ]),
  authorizedAggregateSql: AUTHORIZED_AGGREGATE_SQL,
  outputKeys: OUTPUT_KEYS,
  returnsRowValues: false,
  returnsIdentifiers: false,
  returnsGuestData: false,
  acceptsArbitrarySql: false,
  mutates: false,
  appliesConstraints: false,
  writesLedger: false,
  liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED,
  defaultEnabled: DEFAULT_PHASE_D_PREFLIGHT_ENABLED,
});

function migration028Path() {
  return path.join(MIGRATIONS_DIR, MIG_028);
}

function assertMigration028ByteIntegrity() {
  const live = sha256CanonicalLfV1File(migration028Path());
  if (live !== EXPECTED_028_SHA256) {
    throw Object.assign(
      new Error(`028 checksum drift: got ${live}, expected ${EXPECTED_028_SHA256}`),
      { code: 'migration_028_checksum_mismatch' },
    );
  }
  return live;
}

function assertDisposableConnection(connection) {
  const safety = assertSafeDatabaseTarget(connection);
  if (!safety.ok) {
    throw Object.assign(
      new Error(`non-disposable DSN rejected: ${(safety.errors || []).map((e) => e.code).join(',')}`),
      { code: 'non_disposable_dsn', errors: safety.errors },
    );
  }
}

function assertNoLiveApply() {
  if (PHASE_D_LIVE_APPLY_ENABLED) {
    throw Object.assign(new Error('live apply must remain disabled'), {
      code: 'live_apply_forbidden',
    });
  }
}

/**
 * Strip potentially leaking fragments from driver/PG errors.
 * Never rethrow raw detail/hint that could contain row literals.
 */
function sanitizeError(err, code) {
  const raw = String((err && err.message) || err || 'unknown error');
  // Drop anything after first newline / DETAIL / HINT / CONTEXT — keep short code-ish text.
  const first = raw.split(/\r?\n/)[0]
    .replace(/\bDETAIL:.*/i, '')
    .replace(/\bHINT:.*/i, '')
    .replace(/\bCONTEXT:.*/i, '')
    .replace(/'[^']{0,200}'/g, "'…'")
    .slice(0, 240)
    .trim();
  return Object.assign(new Error(first || 'phase-d preflight failed'), {
    code: code || (err && err.code) || 'phase_d_preflight_failed',
  });
}

function authorizeAggregateSql(sql) {
  const normalized = String(sql || '').replace(/\s+/g, ' ').trim();
  const expected = AUTHORIZED_AGGREGATE_SQL.replace(/\s+/g, ' ').trim();
  if (normalized !== expected) {
    throw Object.assign(
      new Error('unauthorized SQL rejected: only the locked aggregate query is permitted'),
      { code: 'unauthorized_sql' },
    );
  }
  return AUTHORIZED_AGGREGATE_SQL;
}

async function loadRequiredColumnCatalog(client) {
  const res = await client.query(
    `
    SELECT
      a.attname AS name,
      t.typname AS udt_name,
      NOT a.attnotnull AS is_nullable
    FROM pg_attribute a
    JOIN pg_type t ON t.oid = a.atttypid
    JOIN pg_class rel ON rel.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = $1
      AND rel.relname = $2
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.attname = ANY($3::text[])
    ORDER BY a.attname
    `,
    [SCHEMA, TABLE, REQUIRED_COLUMNS.map((c) => c.name)],
  );
  return res.rows;
}

async function assertTableExists(client) {
  const res = await client.query(
    `
    SELECT 1
    FROM pg_class rel
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = $1
      AND rel.relname = $2
      AND rel.relkind = 'r'
    `,
    [SCHEMA, TABLE],
  );
  if (res.rowCount !== 1) {
    throw Object.assign(
      new Error('phase-d preflight: public.tenant_services table missing'),
      { code: 'table_missing' },
    );
  }
}

/**
 * Validate existing table/column types before counting (fail-closed).
 * Does not inspect row values.
 */
async function validateTenantServicesSchemaForPhaseD(client) {
  await assertTableExists(client);
  const rows = await loadRequiredColumnCatalog(client);
  const byName = new Map(rows.map((r) => [r.name, r]));

  for (const expected of REQUIRED_COLUMNS) {
    const row = byName.get(expected.name);
    if (!row) {
      throw Object.assign(
        new Error(`phase-d preflight: missing column ${expected.name}`),
        { code: 'column_missing', column: expected.name },
      );
    }
    if (row.udt_name !== expected.udt) {
      throw Object.assign(
        new Error(
          `phase-d preflight: column ${expected.name} incompatible type (udt=${row.udt_name}, expected ${expected.udt})`,
        ),
        { code: 'column_type_mismatch', column: expected.name },
      );
    }
    if (Boolean(row.is_nullable) !== Boolean(expected.nullable)) {
      throw Object.assign(
        new Error(
          `phase-d preflight: column ${expected.name} incompatible nullability (nullable=${row.is_nullable})`,
        ),
        { code: 'column_nullability_mismatch', column: expected.name },
      );
    }
  }

  return {
    ok: true,
    table: `${SCHEMA}.${TABLE}`,
    columns: REQUIRED_COLUMNS.map((c) => ({ ...c })),
  };
}

function shapeAggregateResult(row) {
  const out = {
    total_rows: Number(row.total_rows),
    date_window_violations: Number(row.date_window_violations),
    price_unit_violations: Number(row.price_unit_violations),
  };
  for (const k of Object.keys(out)) {
    if (!OUTPUT_KEYS.includes(k)) {
      throw Object.assign(new Error('aggregate output shape drift'), {
        code: 'output_shape_drift',
      });
    }
    if (!Number.isFinite(out[k]) || out[k] < 0 || !Number.isInteger(out[k])) {
      throw Object.assign(new Error('aggregate count must be a non-negative integer'), {
        code: 'invalid_aggregate_count',
      });
    }
  }
  // Hard guarantee: only the three count keys exist.
  return {
    total_rows: out.total_rows,
    date_window_violations: out.date_window_violations,
    price_unit_violations: out.price_unit_violations,
  };
}

/**
 * Run the locked aggregate COUNT query inside a READ ONLY transaction.
 * @param {import('pg').Client} client
 * @param {object} opts
 * @param {object} opts.connection safety-checked connection info (loopback + wh_mig_*)
 * @param {boolean} [opts.disposableProofEnabled=false]
 * @param {boolean} [opts.phaseDPreflightEnabled=false]
 */
async function runPhaseDCheckPreflight(client, opts) {
  const options = opts || {};
  assertNoLiveApply();

  if (!options.phaseDPreflightEnabled && !options.disposableProofEnabled) {
    throw Object.assign(
      new Error(
        'phase-d preflight is disabled (set phaseDPreflightEnabled or disposableProofEnabled for prove scripts only)',
      ),
      { code: 'preflight_disabled' },
    );
  }

  if (!options.disposableProofEnabled) {
    throw Object.assign(
      new Error('phase-d preflight requires disposableProofEnabled (no live/Azure mode in Slice 14A)'),
      { code: 'disposable_proof_required' },
    );
  }

  assertDisposableConnection(options.connection);
  const sha = assertMigration028ByteIntegrity();

  // Reject any caller-supplied SQL — only the locked constant may run.
  if (options.sql != null) {
    authorizeAggregateSql(options.sql);
  }
  const sql = authorizeAggregateSql(AUTHORIZED_AGGREGATE_SQL);

  let schema;
  let counts;
  try {
    await client.query('BEGIN READ ONLY');
    try {
      // Session/txn must refuse writes.
      const tro = await client.query('SHOW transaction_read_only');
      if (String(tro.rows[0].transaction_read_only).toLowerCase() !== 'on') {
        throw Object.assign(new Error('phase-d preflight: transaction is not read-only'), {
          code: 'not_read_only',
        });
      }

      schema = await validateTenantServicesSchemaForPhaseD(client);
      const res = await client.query(sql);
      if (!res.rows || res.rows.length !== 1) {
        throw Object.assign(new Error('phase-d preflight: aggregate must return exactly one row'), {
          code: 'aggregate_shape_error',
        });
      }
      // Ensure driver row only exposes the three aliases (ignore prototype noise).
      const raw = res.rows[0];
      const keys = Object.keys(raw).sort();
      const expectedKeys = OUTPUT_KEYS.slice().sort();
      if (keys.length !== expectedKeys.length || keys.some((k, i) => k !== expectedKeys[i])) {
        throw Object.assign(new Error('phase-d preflight: unexpected aggregate columns'), {
          code: 'aggregate_column_leak',
        });
      }
      counts = shapeAggregateResult(raw);
      await client.query('COMMIT');
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        /* ignore */
      }
      throw e;
    }
  } catch (e) {
    const known = new Set([
      'preflight_disabled',
      'disposable_proof_required',
      'non_disposable_dsn',
      'migration_028_checksum_mismatch',
      'unauthorized_sql',
      'table_missing',
      'column_missing',
      'column_type_mismatch',
      'column_nullability_mismatch',
      'not_read_only',
      'aggregate_shape_error',
      'aggregate_column_leak',
      'invalid_aggregate_count',
      'output_shape_drift',
      'live_apply_forbidden',
      'phase_d_preflight_failed',
    ]);
    if (e && e.code && (known.has(e.code) || String(e.code).startsWith('phase'))) {
      throw e;
    }
    throw sanitizeError(e, e && e.code);
  }

  return {
    ok: true,
    migrationId: MIG_028_ID,
    filename: MIG_028,
    sha256CanonicalLfV1: sha,
    schema,
    counts,
    authorizedAggregateSql: AUTHORIZED_AGGREGATE_SQL,
    outputKeys: OUTPUT_KEYS.slice(),
    readOnly: true,
    mutates: false,
    appliesConstraints: false,
    wroteSchemaMigrationLedger: false,
    liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED,
    claimsCanonicalRunnerProvenance: false,
  };
}

/** Offline helper: confirm migration 028 source still contains the locked predicates. */
function assert028PredicatesPresentInSource() {
  const raw = fs.readFileSync(migration028Path(), 'utf8');
  if (!/CONSTRAINT\s+tenant_services_date_window/i.test(raw)) {
    throw new Error('028 missing tenant_services_date_window');
  }
  if (!/CONSTRAINT\s+tenant_services_price_unit/i.test(raw)) {
    throw new Error('028 missing tenant_services_price_unit');
  }
  if (!/end_date\s+IS\s+NULL\s+OR\s+start_date\s+IS\s+NULL\s+OR\s+end_date\s*>=\s*start_date/i.test(raw)) {
    throw new Error('028 date_window predicate drift');
  }
  if (!/price_unit\s+IN\s*\(\s*'per_day'\s*,\s*'per_week'\s*,\s*'per_stay'\s*,\s*'one_off'\s*\)/i.test(raw)) {
    throw new Error('028 price_unit predicate drift');
  }
  return true;
}

module.exports = {
  MIG_028,
  MIG_028_ID,
  TABLE,
  SCHEMA,
  EXPECTED_028_SHA256,
  PHASE_D_LIVE_APPLY_ENABLED,
  DEFAULT_PHASE_D_PREFLIGHT_ENABLED,
  DATE_WINDOW_PREDICATE,
  PRICE_UNIT_PREDICATE,
  DATE_WINDOW_VIOLATION_PREDICATE,
  PRICE_UNIT_VIOLATION_PREDICATE,
  AUTHORIZED_AGGREGATE_SQL,
  REQUIRED_COLUMNS,
  OUTPUT_KEYS,
  AGGREGATE_CONTRACT,
  migration028Path,
  assertMigration028ByteIntegrity,
  assertDisposableConnection,
  assertNoLiveApply,
  authorizeAggregateSql,
  sanitizeError,
  validateTenantServicesSchemaForPhaseD,
  runPhaseDCheckPreflight,
  assert028PredicatesPresentInSource,
  shapeAggregateResult,
};
