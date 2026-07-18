'use strict';

/**
 * Sunset schema observer helpers (FOUNDATION Slice 6).
 * Pure schema-normalization + exact SQL registry for the read-only observer CLI.
 * Never mutates Azure. Reuses the reviewed exact-match registry pattern (not PR #36 probe).
 */

const crypto = require('crypto');
const { URL } = require('url');

const EXPECTED_HOST =
  'luna-sunset-staging-pg-app.postgres.database.azure.com';
const EXPECTED_DATABASE = 'sunset_staging';
const APPLICATION_NAME = 'wh-sunset-schema-observer';
const LEDGER_TABLE = 'schema_migration_ledger';
const OBSERVER_DSN_ENV = 'SUNSET_SCHEMA_OBSERVER_DATABASE_URL';

const INTROSPECTION_SQL = Object.freeze({
  show_transaction_read_only: 'SHOW transaction_read_only',
  show_statement_timeout: 'SHOW statement_timeout',
  show_lock_timeout: 'SHOW lock_timeout',
  show_application_name: 'SHOW application_name',
  tables: `
SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name`.trim(),
  columns: `
SELECT table_schema, table_name, column_name, data_type, udt_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position`.trim(),
  constraints: `
SELECT
  n.nspname AS table_schema,
  rel.relname AS table_name,
  con.conname AS constraint_name,
  CASE con.contype
    WHEN 'p' THEN 'PRIMARY KEY'
    WHEN 'f' THEN 'FOREIGN KEY'
    WHEN 'u' THEN 'UNIQUE'
    WHEN 'c' THEN 'CHECK'
    ELSE con.contype::text
  END AS constraint_type,
  pg_get_constraintdef(con.oid) AS definition
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace
WHERE n.nspname = 'public'
ORDER BY table_name, constraint_name`.trim(),
  indexes: `
SELECT schemaname, tablename, indexname, indexdef
FROM pg_catalog.pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname`.trim(),
  sequences: `
SELECT c.relname
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'S'
ORDER BY c.relname`.trim(),
  views: `
SELECT table_schema, table_name, view_definition
FROM information_schema.views
WHERE table_schema = 'public'
ORDER BY table_name`.trim(),
  functions: `
SELECT n.nspname AS routine_schema,
       p.proname AS routine_name,
       n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS identity
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prokind IN ('f', 'p')
ORDER BY identity`.trim(),
  triggers: `
SELECT t.tgname,
       c.relname AS tgrelid_name,
       pg_get_triggerdef(t.oid) AS tgdef
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal
ORDER BY c.relname, t.tgname`.trim(),
});

const SQL_REGISTRY_IDS = Object.freeze(Object.keys(INTROSPECTION_SQL));

const FORBIDDEN_SQL_VERBS = Object.freeze([
  /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY|CALL|DO|SET|BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/i,
  /\b(LOCK\s+TABLE|VACUUM|ANALYZE|REINDEX|CLUSTER)\b/i,
  /\bpg_advisory_lock\b/i,
]);

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function redactSecrets(text) {
  let s = String(text || '');
  s = s.replace(/postgres(?:ql)?:\/\/[^:\s/@]+:[^@\s/]+@/gi, 'postgresql://***:***@');
  s = s.replace(/:[^:@\s/]+@/g, ':***@');
  return s;
}

function normalizeSql(sql) {
  return String(sql || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*;+\s*$/g, '')
    .trim();
}

function assertSqlAllowed(sql) {
  const raw = String(sql || '');
  if (/--|\/\*|\*\//.test(raw)) {
    return { ok: false, code: 'sql_comments_rejected', message: 'SQL comments are not allowed' };
  }
  const body = raw.trim().replace(/;+\s*$/, '');
  if (body.includes(';')) {
    return { ok: false, code: 'stacked_sql_rejected', message: 'stacked SQL statements are not allowed' };
  }
  for (const bad of FORBIDDEN_SQL_VERBS) {
    if (bad.test(body)) {
      return { ok: false, code: 'forbidden_sql', message: 'SQL contains forbidden verb or transaction control' };
    }
  }
  const norm = normalizeSql(body);
  if (!norm) return { ok: false, code: 'sql_empty', message: 'empty SQL' };
  for (const id of SQL_REGISTRY_IDS) {
    if (normalizeSql(INTROSPECTION_SQL[id]) === norm) {
      return { ok: true, allowlistId: id };
    }
  }
  return { ok: false, code: 'sql_not_in_registry', message: 'SQL is not an exact registry match' };
}

function parseDatabaseUrl(dsn) {
  const raw = String(dsn || '').trim();
  if (!raw) return { ok: false, errors: [{ code: 'dsn_empty', message: 'empty DSN' }] };
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    return { ok: false, errors: [{ code: 'dsn_parse_failed', message: 'DSN is not a valid URL' }] };
  }
  if (!/^postgres(ql)?:$/i.test(url.protocol)) {
    return { ok: false, errors: [{ code: 'dsn_not_postgres', message: 'DSN protocol must be postgres(ql)' }] };
  }
  const sslmode = (url.searchParams.get('sslmode') || '').toLowerCase();
  const ssl = (url.searchParams.get('ssl') || '').toLowerCase();
  const tlsOk =
    sslmode === 'require'
    || sslmode === 'verify-ca'
    || sslmode === 'verify-full'
    || ssl === 'true'
    || ssl === '1';
  return {
    ok: true,
    errors: [],
    parsed: {
      host: url.hostname,
      port: url.port ? Number(url.port) : 5432,
      database: (url.pathname || '').replace(/^\//, ''),
      user: decodeURIComponent(url.username || ''),
      hasPassword: Boolean(url.password),
      sslmode: sslmode || null,
      tlsOk,
    },
  };
}

function isLocalEphemeralHost(host) {
  const h = String(host || '').toLowerCase();
  return (
    h === '127.0.0.1'
    || h === 'localhost'
    || h === '::1'
    || h === 'obs-pg'
    || h === 'host.docker.internal'
  );
}

function assertObserverTarget(parsed, opts) {
  const options = opts || {};
  const errors = [];
  const allowLocalEphemeral = options.allowLocalEphemeral === true;
  if (!parsed || !parsed.host) {
    errors.push({ code: 'missing_host', message: 'DSN host missing' });
  } else if (allowLocalEphemeral) {
    if (!isLocalEphemeralHost(parsed.host)) {
      errors.push({ code: 'local_host_not_loopback', message: 'local proof host must be loopback or disposable docker alias' });
    }
  } else if (parsed.host !== EXPECTED_HOST) {
    errors.push({ code: 'wrong_host', message: `host must be exactly ${EXPECTED_HOST}` });
  }
  if (allowLocalEphemeral) {
    if (!parsed || !/^wh_mig_[a-z0-9_]+$/i.test(parsed.database || '')) {
      errors.push({ code: 'local_db_not_ephemeral', message: 'local proof database must match wh_mig_*' });
    }
  } else if (!parsed || parsed.database !== EXPECTED_DATABASE) {
    errors.push({ code: 'wrong_database', message: `database must be exactly ${EXPECTED_DATABASE}` });
  }
  if (parsed && /wolfhouse|production|^prod$/i.test(parsed.database || '')) {
    errors.push({ code: 'forbidden_database', message: 'forbidden database name' });
  }
  if (!allowLocalEphemeral && parsed && !parsed.tlsOk) {
    errors.push({ code: 'missing_tls', message: 'DSN must require TLS' });
  }
  return { ok: errors.length === 0, errors };
}

function assertNoLeakedDsn(text, dsn) {
  const s = String(text || '');
  const hits = [];
  if (dsn && s.includes(dsn)) hits.push('raw_dsn');
  if (/postgres(?:ql)?:\/\/(?!\*\*\*)[^:\s/@]+:(?!\*\*\*)[^@\s/]+@/i.test(s)) hits.push('embedded_dsn');
  if (/Password=/i.test(s) && /Host=/i.test(s)) hits.push('ado_style');
  return hits;
}

function clientConfigFromDsn(dsn, opts) {
  const options = opts || {};
  const parsed = parseDatabaseUrl(dsn);
  if (!parsed.ok) {
    throw Object.assign(new Error('invalid DSN'), { code: 'dsn_parse_failed', errors: parsed.errors });
  }
  const target = assertObserverTarget(parsed.parsed, options);
  if (!target.ok) {
    throw Object.assign(new Error('DSN target rejected'), { code: 'wrong_target', errors: target.errors });
  }
  const url = new URL(dsn);
  const cfg = {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username || ''),
    password: decodeURIComponent(url.password || ''),
    database: (url.pathname || '').replace(/^\//, ''),
    application_name: APPLICATION_NAME,
    options: '-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=5000',
    connectionTimeoutMillis: 20000,
  };
  if (!options.allowLocalEphemeral) {
    cfg.ssl = { rejectUnauthorized: false };
  }
  return cfg;
}

function normalizeDefault(def) {
  if (def == null) return null;
  return String(def).replace(/\s+/g, ' ').trim();
}

function buildProductSchemaSnapshot(rowsByKind) {
  const tables = (rowsByKind.tables || [])
    .filter((t) => t.table_schema === 'public' && t.table_type === 'BASE TABLE' && t.table_name !== LEDGER_TABLE)
    .map((t) => t.table_name)
    .sort();
  const columns = (rowsByKind.columns || [])
    .filter((c) => c.table_schema === 'public' && c.table_name !== LEDGER_TABLE)
    .map((c) => ({
      table: c.table_name,
      column: c.column_name,
      type: c.data_type,
      udt: c.udt_name,
      nullable: c.is_nullable,
      default: normalizeDefault(c.column_default),
    }))
    .sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`));
  const constraints = (rowsByKind.constraints || [])
    .filter((c) => c.table_schema === 'public' && c.table_name !== LEDGER_TABLE)
    .map((c) => ({
      table: c.table_name,
      name: c.constraint_name,
      type: c.constraint_type,
      definition: c.definition || null,
    }))
    .sort((a, b) => `${a.table}.${a.name}`.localeCompare(`${b.table}.${b.name}`));
  const indexes = (rowsByKind.indexes || [])
    .filter((i) => i.schemaname === 'public' && i.tablename !== LEDGER_TABLE)
    .map((i) => ({
      table: i.tablename,
      name: i.indexname,
      def: String(i.indexdef || '').replace(/\s+/g, ' ').trim(),
    }))
    .sort((a, b) => `${a.table}.${a.name}`.localeCompare(`${b.table}.${b.name}`));
  const sequences = (rowsByKind.sequences || []).map((s) => s.relname).sort();
  const views = (rowsByKind.views || [])
    .filter((v) => v.table_schema === 'public')
    .map((v) => ({
      name: v.table_name,
      def: String(v.view_definition || '').replace(/\s+/g, ' ').trim(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const functions = (rowsByKind.functions || [])
    .map((f) => ({ name: f.routine_name, identity: f.identity }))
    .sort((a, b) => String(a.identity).localeCompare(String(b.identity)));
  const triggers = (rowsByKind.triggers || [])
    .filter((t) => t.tgrelid_name !== LEDGER_TABLE)
    .map((t) => ({
      name: t.tgname,
      table: t.tgrelid_name,
      def: String(t.tgdef || '').replace(/\s+/g, ' ').trim(),
    }))
    .sort((a, b) => `${a.table}.${a.name}`.localeCompare(`${b.table}.${b.name}`));
  return { tables, columns, constraints, indexes, sequences, views, functions, triggers };
}

function fingerprintProductSchema(snapshot) {
  return sha256Text(JSON.stringify(snapshot));
}

function indexByKey(items, keyFn) {
  const map = new Map();
  for (const item of items) map.set(keyFn(item), item);
  return map;
}

function compareSnapshots(expected, live) {
  const drifts = [];
  function diffSection(name, expList, liveList, keyFn, equalFn) {
    const eMap = indexByKey(expList, keyFn);
    const lMap = indexByKey(liveList, keyFn);
    for (const [k, ev] of eMap) {
      if (!lMap.has(k)) drifts.push({ kind: 'expected_only', section: name, key: k });
      else if (!equalFn(ev, lMap.get(k))) {
        drifts.push({ kind: 'definition_mismatch', section: name, key: k });
      }
    }
    for (const [k] of lMap) {
      if (!eMap.has(k)) drifts.push({ kind: 'live_only', section: name, key: k });
    }
  }
  diffSection('tables', expected.tables.map((t) => ({ name: t })), live.tables.map((t) => ({ name: t })), (x) => x.name, () => true);
  diffSection('columns', expected.columns, live.columns, (c) => `${c.table}.${c.column}`, (a, b) => JSON.stringify(a) === JSON.stringify(b));
  diffSection('constraints', expected.constraints, live.constraints, (c) => `${c.table}.${c.name}.${c.type}`, (a, b) => JSON.stringify(a) === JSON.stringify(b));
  diffSection('indexes', expected.indexes, live.indexes, (i) => `${i.table}.${i.name}`, (a, b) => a.def === b.def);
  diffSection('sequences', expected.sequences.map((s) => ({ name: s })), live.sequences.map((s) => ({ name: s })), (x) => x.name, () => true);
  diffSection('views', expected.views, live.views, (v) => v.name, (a, b) => a.def === b.def);
  diffSection('functions', expected.functions, live.functions, (f) => f.identity || f.name, (a, b) => (a.identity || a.name) === (b.identity || b.name));
  diffSection('triggers', expected.triggers, live.triggers, (t) => `${t.table}.${t.name}`, (a, b) => a.def === b.def);
  const counts = {
    expected_only: drifts.filter((d) => d.kind === 'expected_only').length,
    live_only: drifts.filter((d) => d.kind === 'live_only').length,
    definition_mismatch: drifts.filter((d) => d.kind === 'definition_mismatch').length,
  };
  return {
    drifts,
    counts,
    ok: counts.expected_only + counts.live_only + counts.definition_mismatch === 0,
  };
}

function assertReadOnlySession(showRows) {
  const errors = [];
  const tro = String(showRows && showRows.transaction_read_only != null ? showRows.transaction_read_only : '').toLowerCase();
  if (tro !== 'on') {
    errors.push({ code: 'non_read_only_session', message: `transaction_read_only=${tro || 'unset'}` });
  }
  const app = String(showRows && showRows.application_name != null ? showRows.application_name : '');
  if (app !== APPLICATION_NAME) {
    errors.push({ code: 'wrong_application_name', message: `application_name must be ${APPLICATION_NAME}` });
  }
  const st = String(showRows && showRows.statement_timeout != null ? showRows.statement_timeout : '');
  if (!(st === '30s' || st === '30000ms' || st === '30000')) {
    errors.push({ code: 'bad_statement_timeout', message: st });
  }
  const lt = String(showRows && showRows.lock_timeout != null ? showRows.lock_timeout : '');
  if (!(lt === '5s' || lt === '5000ms' || lt === '5000')) {
    errors.push({ code: 'bad_lock_timeout', message: lt });
  }
  return { ok: errors.length === 0, errors };
}

async function safeQuery(client, sql) {
  const gate = assertSqlAllowed(sql);
  if (!gate.ok) {
    throw Object.assign(new Error(gate.message), { code: gate.code });
  }
  const res = await client.query(sql);
  return { allowlistId: gate.allowlistId, rows: res.rows };
}

async function introspectProductSchema(client) {
  const usedAllowlist = [];
  async function q(key) {
    const out = await safeQuery(client, INTROSPECTION_SQL[key]);
    usedAllowlist.push(out.allowlistId);
    return out.rows;
  }
  const rowsByKind = {
    tables: await q('tables'),
    columns: await q('columns'),
    constraints: await q('constraints'),
    indexes: await q('indexes'),
    sequences: (await q('sequences')).map((r) => ({ relname: r.relname })),
    views: await q('views'),
    functions: await q('functions'),
    triggers: await q('triggers'),
  };
  return {
    snapshot: buildProductSchemaSnapshot(rowsByKind),
    usedAllowlist: [...new Set(usedAllowlist)],
  };
}

async function verifyLiveSession(client) {
  const tro = await safeQuery(client, INTROSPECTION_SQL.show_transaction_read_only);
  const st = await safeQuery(client, INTROSPECTION_SQL.show_statement_timeout);
  const lt = await safeQuery(client, INTROSPECTION_SQL.show_lock_timeout);
  const an = await safeQuery(client, INTROSPECTION_SQL.show_application_name);
  const show = {
    transaction_read_only: tro.rows[0]?.transaction_read_only,
    statement_timeout: st.rows[0]?.statement_timeout,
    lock_timeout: lt.rows[0]?.lock_timeout,
    application_name: an.rows[0]?.application_name,
  };
  const gate = assertReadOnlySession(show);
  return {
    ok: gate.ok,
    errors: gate.errors,
    show,
    usedAllowlist: [tro, st, lt, an].map((x) => x.allowlistId),
  };
}

function hashCanonicalManifest(manifest) {
  const forward = (manifest.entries || [])
    .filter((e) => e.inForwardChain === true && e.classification === 'canonical_forward')
    .slice()
    .sort((a, b) => a.order - b.order);
  return {
    forward,
    manifestHash: sha256Text(JSON.stringify({
      version: manifest.version || null,
      intentionalGaps: manifest.intentionalGaps || [],
      forward: forward.map((e) => ({ id: e.id, order: e.order, filename: e.filename, sha256: e.sha256 })),
    })),
  };
}

function contractStalenessErrors(contract, manifest) {
  const errors = [];
  if (!contract || typeof contract !== 'object') {
    return [{ code: 'contract_missing', message: 'expected contract missing' }];
  }
  const { forward, manifestHash: liveManifestHash } = hashCanonicalManifest(manifest);
  if (contract.manifestHash !== liveManifestHash) {
    errors.push({ code: 'stale_manifest_hash', message: 'contract manifestHash does not match current canonical manifest' });
  }
  if (!contract.productFingerprint || !contract.snapshot) {
    errors.push({ code: 'contract_incomplete', message: 'contract missing fingerprint or snapshot' });
  } else if (fingerprintProductSchema(contract.snapshot) !== contract.productFingerprint) {
    errors.push({ code: 'stale_fingerprint', message: 'contract fingerprint does not match embedded snapshot' });
  }
  if (Number(contract.forwardCount) !== forward.length) {
    errors.push({
      code: 'stale_forward_count',
      message: `contract forwardCount ${contract.forwardCount} != ${forward.length}`,
    });
  }
  return errors;
}

module.exports = {
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  APPLICATION_NAME,
  LEDGER_TABLE,
  OBSERVER_DSN_ENV,
  INTROSPECTION_SQL,
  SQL_REGISTRY_IDS,
  sha256Text,
  redactSecrets,
  normalizeSql,
  assertSqlAllowed,
  parseDatabaseUrl,
  isLocalEphemeralHost,
  assertObserverTarget,
  assertNoLeakedDsn,
  clientConfigFromDsn,
  buildProductSchemaSnapshot,
  fingerprintProductSchema,
  compareSnapshots,
  assertReadOnlySession,
  safeQuery,
  introspectProductSchema,
  verifyLiveSession,
  hashCanonicalManifest,
  contractStalenessErrors,
};
