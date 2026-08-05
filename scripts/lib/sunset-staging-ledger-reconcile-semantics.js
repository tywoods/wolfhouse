'use strict';

/**
 * Exact semantic catalog expectations for migrations 056 and 060 baseline objects.
 * Derived from canonical migration SQL ownership — not name-only probes.
 */

const crypto = require('crypto');

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function normalizeSqlBody(body) {
  return String(body || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const EXPECTED_056_COLUMNS = Object.freeze([
  { name: 'id', data_type: 'uuid', is_nullable: 'NO', column_default: 'gen_random_uuid()' },
  { name: 'client_id', data_type: 'uuid', is_nullable: 'NO', column_default: null },
  { name: 'booking_id', data_type: 'uuid', is_nullable: 'NO', column_default: null },
  { name: 'location_id', data_type: 'text', is_nullable: 'NO', column_default: null },
  { name: 'amount_cents', data_type: 'integer', is_nullable: 'NO', column_default: null },
  { name: 'currency', data_type: 'character', is_nullable: 'NO', column_default: "'EUR'::bpchar" },
  { name: 'effective_date', data_type: 'date', is_nullable: 'NO', column_default: null },
  { name: 'reason', data_type: 'text', is_nullable: 'NO', column_default: null },
  { name: 'staff_user_id', data_type: 'text', is_nullable: 'YES', column_default: null },
  { name: 'staff_email', data_type: 'text', is_nullable: 'YES', column_default: null },
  { name: 'staff_role', data_type: 'text', is_nullable: 'YES', column_default: null },
  { name: 'idempotency_key', data_type: 'text', is_nullable: 'NO', column_default: null },
  { name: 'source', data_type: 'text', is_nullable: 'NO', column_default: "'staff_manual_record'::text" },
  { name: 'metadata', data_type: 'jsonb', is_nullable: 'NO', column_default: "'{}'::jsonb" },
  { name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: 'now()' },
]);

const EXPECTED_056_INDEXES = Object.freeze([
  'bookings_id_client_id_uidx',
  'booking_refund_records_client_idempotency_uidx',
  'booking_refund_records_booking_idx',
  'booking_refund_records_client_location_idx',
  'booking_refund_records_client_created_idx',
]);

const EXPECTED_056_TRIGGERS = Object.freeze([
  { name: 'booking_refund_records_no_update', timing: 'BEFORE', event: 'UPDATE', function_name: 'booking_refund_records_reject_update' },
  { name: 'booking_refund_records_no_delete', timing: 'BEFORE', event: 'DELETE', function_name: 'booking_refund_records_reject_delete' },
]);

const EXPECTED_056_FKS = Object.freeze([
  { name: 'booking_refund_records_booking_client_fk', delete_rule: 'r', update_rule: 'c' },
  { name: 'booking_refund_records_client_fk', delete_rule: 'r', update_rule: 'c' },
]);

const EXPECTED_056_CHECKS = Object.freeze([
  'booking_refund_records_amount_cents_check',
  'booking_refund_records_reason_nonempty',
  'booking_refund_records_location_nonempty',
  'booking_refund_records_idempotency_nonempty',
  'booking_refund_records_currency_eur',
  'booking_refund_records_source_check',
]);

const EXPECTED_060_HIDDEN = Object.freeze({
  column_name: 'hidden',
  data_type: 'boolean',
  is_nullable: 'NO',
  column_default: 'false',
});

const EXPECTED_060_INDEX = Object.freeze({
  indexname: 'bookings_hidden_true_idx',
  indexdef_normalized: 'create index bookings_hidden_true_idx on public.bookings using btree (client_id, hidden) where (hidden = true)',
});

const SEMANTIC_PROBE_SQL = `
SELECT json_build_object(
  'columns_056', (
    SELECT COALESCE(json_agg(json_build_object(
      'name', column_name,
      'data_type', data_type,
      'is_nullable', is_nullable,
      'column_default', column_default::text
    ) ORDER BY ordinal_position), '[]'::json)
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'booking_refund_records'
  ),
  'indexes_056', (
    SELECT COALESCE(json_agg(indexname ORDER BY indexname), '[]'::json)
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'booking_refund_records'
  ),
  'bookings_uidx_056', (
    SELECT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'bookings_id_client_id_uidx'
    )
  ),
  'checks_056', (
    SELECT COALESCE(json_agg(con.conname ORDER BY con.conname), '[]'::json)
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public' AND rel.relname = 'booking_refund_records' AND con.contype = 'c'
  ),
  'fks_056', (
    SELECT COALESCE(json_agg(json_build_object(
      'name', con.conname,
      'delete_rule', con.confdeltype,
      'update_rule', con.confupdtype
    ) ORDER BY con.conname), '[]'::json)
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public' AND rel.relname = 'booking_refund_records' AND con.contype = 'f'
  ),
  'triggers_056', (
    SELECT COALESCE(json_agg(json_build_object(
      'name', tg.tgname,
      'timing', CASE WHEN tg.tgtype & 2 = 2 THEN 'BEFORE' ELSE 'AFTER' END,
      'event', CASE
        WHEN tg.tgtype & 4 = 4 THEN 'INSERT'
        WHEN tg.tgtype & 8 = 8 THEN 'DELETE'
        WHEN tg.tgtype & 16 = 16 THEN 'UPDATE'
        ELSE 'OTHER'
      END,
      'function_name', p.proname
    ) ORDER BY tg.tgname), '[]'::json)
    FROM pg_trigger tg
    JOIN pg_class rel ON rel.oid = tg.tgrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    JOIN pg_proc p ON p.oid = tg.tgfoid
    WHERE nsp.nspname = 'public' AND rel.relname = 'booking_refund_records' AND NOT tg.tgisinternal
  ),
  'fn_update_056', (
    SELECT regexp_replace(pg_get_functiondef(p.oid), E'[\\n\\r\\t ]+', ' ', 'g')
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'booking_refund_records_reject_update'
    LIMIT 1
  ),
  'fn_delete_056', (
    SELECT regexp_replace(pg_get_functiondef(p.oid), E'[\\n\\r\\t ]+', ' ', 'g')
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'booking_refund_records_reject_delete'
    LIMIT 1
  ),
  'hidden_060', (
    SELECT json_build_object(
      'column_name', column_name,
      'data_type', data_type,
      'is_nullable', is_nullable,
      'column_default', column_default::text
    )
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = 'hidden'
  ),
  'index_060', (
    SELECT json_build_object(
      'indexname', indexname,
      'indexdef_normalized', lower(regexp_replace(indexdef, E'[\\n\\r\\t ]+', ' ', 'g'))
    )
    FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'bookings_hidden_true_idx'
    LIMIT 1
  ),
  'has_057_locations', to_regclass('public.tenant_locations') IS NOT NULL,
  'has_057_endpoints', to_regclass('public.tenant_channel_endpoints') IS NOT NULL,
  'has_058_connector_mode', EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tenant_channel_endpoints' AND column_name = 'connector_mode'
  ),
  'has_059_grants', to_regclass('public.tenant_email_delegated_grants') IS NOT NULL
) AS semantic_row
`;

function normalizeColumnDefault(def) {
  const d = String(def || '').trim();
  if (!d) return null;
  return d.replace(/::character varying/gi, '::text').replace(/::bpchar/gi, '::bpchar');
}

function assertSemanticBaseline056060(row) {
  const errors = [];
  const data = row || {};

  const cols = Array.isArray(data.columns_056) ? data.columns_056 : [];
  if (cols.length !== EXPECTED_056_COLUMNS.length) {
    errors.push({ code: 'semantic_056_column_count', message: `expected ${EXPECTED_056_COLUMNS.length} columns` });
  }
  for (const exp of EXPECTED_056_COLUMNS) {
    const live = cols.find((c) => c.name === exp.name);
    if (!live) {
      errors.push({ code: 'semantic_056_column_missing', message: exp.name });
      continue;
    }
    if (live.data_type !== exp.data_type) errors.push({ code: 'semantic_056_column_type', message: exp.name });
    if (live.is_nullable !== exp.is_nullable) errors.push({ code: 'semantic_056_column_nullable', message: exp.name });
    const liveDef = normalizeColumnDefault(live.column_default);
    const expDef = normalizeColumnDefault(exp.column_default);
    if (liveDef !== expDef) errors.push({ code: 'semantic_056_column_default', message: exp.name });
  }

  const idx056 = (Array.isArray(data.indexes_056) ? data.indexes_056 : [])
    .filter((n) => !String(n).endsWith('_pkey'))
    .slice()
    .sort();
  const wantIdx056 = EXPECTED_056_INDEXES.filter((n) => n !== 'bookings_id_client_id_uidx').slice().sort();
  if (idx056.join(',') !== wantIdx056.join(',')) {
    errors.push({ code: 'semantic_056_indexes_mismatch', message: 'booking_refund_records indexes differ' });
  }
  if (!data.bookings_uidx_056) errors.push({ code: 'semantic_056_bookings_uidx_missing' });

  const checks = Array.isArray(data.checks_056) ? data.checks_056.slice().sort() : [];
  if (checks.join(',') !== EXPECTED_056_CHECKS.slice().sort().join(',')) {
    errors.push({ code: 'semantic_056_checks_mismatch' });
  }

  const fks = Array.isArray(data.fks_056) ? data.fks_056 : [];
  for (const exp of EXPECTED_056_FKS) {
    const live = fks.find((f) => f.name === exp.name);
    if (!live || live.delete_rule !== exp.delete_rule || live.update_rule !== exp.update_rule) {
      errors.push({ code: 'semantic_056_fk_mismatch', message: exp.name });
    }
  }

  const triggers = Array.isArray(data.triggers_056) ? data.triggers_056 : [];
  for (const exp of EXPECTED_056_TRIGGERS) {
    const live = triggers.find((t) => t.name === exp.name);
    if (!live || live.timing !== exp.timing || live.event !== exp.event || live.function_name !== exp.function_name) {
      errors.push({ code: 'semantic_056_trigger_mismatch', message: exp.name });
    }
  }
  const fnUpdate = normalizeSqlBody(data.fn_update_056);
  const fnDelete = normalizeSqlBody(data.fn_delete_056);
  if (!fnUpdate.includes('booking_refund_records is append-only (update forbidden)')) {
    errors.push({ code: 'semantic_056_fn_update_body' });
  }
  if (!fnDelete.includes('wh.allow_booking_refund_mutation')) {
    errors.push({ code: 'semantic_056_fn_delete_body' });
  }

  const hidden = data.hidden_060 || {};
  if (hidden.column_name !== EXPECTED_060_HIDDEN.column_name
    || hidden.data_type !== EXPECTED_060_HIDDEN.data_type
    || hidden.is_nullable !== EXPECTED_060_HIDDEN.is_nullable
    || normalizeColumnDefault(hidden.column_default) !== EXPECTED_060_HIDDEN.column_default) {
    errors.push({ code: 'semantic_060_hidden_column' });
  }
  const idx060 = data.index_060 || {};
  if (idx060.indexname !== EXPECTED_060_INDEX.indexname
    || idx060.indexdef_normalized !== EXPECTED_060_INDEX.indexdef_normalized) {
    errors.push({ code: 'semantic_060_index' });
  }

  if (data.has_057_locations || data.has_057_endpoints) errors.push({ code: 'semantic_057_unexpected' });
  if (data.has_058_connector_mode) errors.push({ code: 'semantic_058_unexpected' });
  if (data.has_059_grants) errors.push({ code: 'semantic_059_unexpected' });

  return { ok: errors.length === 0, errors };
}

function assertPostApplySemantic(row) {
  const errors = [];
  const data = row || {};
  if (!data.has_057_locations || !data.has_057_endpoints) errors.push({ code: 'semantic_057_missing' });
  if (!data.has_058_connector_mode) errors.push({ code: 'semantic_058_missing' });
  if (!data.has_059_grants) errors.push({ code: 'semantic_059_missing' });
  return { ok: errors.length === 0, errors };
}

function semanticCatalogFingerprint(row) {
  return sha256Text(stableStringify(row || {}));
}

async function probeSemanticCatalog(client) {
  const res = await client.query(SEMANTIC_PROBE_SQL);
  const row = (res.rows && res.rows[0] && res.rows[0].semantic_row) || {};
  return { row, fingerprint: semanticCatalogFingerprint(row) };
}

function buildCanonicalPreApplySemanticRow() {
  return {
    columns_056: EXPECTED_056_COLUMNS.map((c) => ({
      name: c.name,
      data_type: c.data_type,
      is_nullable: c.is_nullable,
      column_default: c.column_default,
    })),
    indexes_056: EXPECTED_056_INDEXES.filter((n) => n !== 'bookings_id_client_id_uidx').slice().sort(),
    bookings_uidx_056: true,
    checks_056: EXPECTED_056_CHECKS.slice().sort(),
    fks_056: EXPECTED_056_FKS.map((f) => ({ ...f })),
    triggers_056: EXPECTED_056_TRIGGERS.map((t) => ({ ...t })),
    fn_update_056: ' booking_refund_records is append-only (update forbidden) ',
    fn_delete_056: ' wh.allow_booking_refund_mutation ',
    hidden_060: {
      column_name: EXPECTED_060_HIDDEN.column_name,
      data_type: EXPECTED_060_HIDDEN.data_type,
      is_nullable: EXPECTED_060_HIDDEN.is_nullable,
      column_default: EXPECTED_060_HIDDEN.column_default,
    },
    index_060: { ...EXPECTED_060_INDEX },
    has_057_locations: false,
    has_057_endpoints: false,
    has_058_connector_mode: false,
    has_059_grants: false,
  };
}

module.exports = {
  SEMANTIC_PROBE_SQL,
  EXPECTED_056_COLUMNS,
  EXPECTED_060_HIDDEN,
  EXPECTED_060_INDEX,
  assertSemanticBaseline056060,
  assertPostApplySemantic,
  semanticCatalogFingerprint,
  probeSemanticCatalog,
  normalizeSqlBody,
  buildCanonicalPreApplySemanticRow,
};
