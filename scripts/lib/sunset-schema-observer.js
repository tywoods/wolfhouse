'use strict';

/**
 * Sunset schema observer helpers (FOUNDATION Slice 6).
 * Exact SQL registry + normalization for the read-only observer CLI.
 * Never mutates Azure. Non-local TLS requires sslmode=verify-full + rejectUnauthorized.
 */

const crypto = require('crypto');
const tls = require('tls');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const EXPECTED_HOST =
  'luna-sunset-staging-pg-app.postgres.database.azure.com';
const EXPECTED_DATABASE = 'sunset_staging';
const APPLICATION_NAME = 'wh-sunset-schema-observer';
const LEDGER_TABLE = 'schema_migration_ledger';
const OBSERVER_DSN_ENV = 'SUNSET_SCHEMA_OBSERVER_DATABASE_URL';

const INCLUDED_SECTIONS = Object.freeze([
  'tables',
  'columns',
  'constraints',
  'indexes',
  'sequences',
  'views',
  'enums',
  'functions',
  'triggers',
  'rlsFlags',
  'rlsPolicies',
  'ownership',
  'acls',
  'extensions',
]);

/** Machine-readable ownership coverage claimed by the contract. */
const OWNERSHIP_COVERAGE = Object.freeze([
  'schema',
  'relation',
  'function',
  'type',
  'extension',
]);

/** Machine-readable ACL coverage claimed by the contract. */
const ACL_COVERAGE = Object.freeze([
  'schema',
  'relation',
  'function',
  'type',
]);

/** Machine-readable extension field coverage. */
const EXTENSION_COVERAGE = Object.freeze([
  'name',
  'version',
  'owner',
  'schema',
  'relocatable',
  'config_relations',
  'config_conditions',
]);

/**
 * Explicit non-claims. Do not document this contract as complete schema equivalence.
 * Enums, public functions, and RLS/policies are included (not listed here).
 */
const EXCLUDED_SECTIONS = Object.freeze([
  'schema_migration_ledger',
  'guest_row_data',
  'table_statistics',
  'toast_storage',
  'publications_subscriptions',
  'event_triggers',
]);

const CONTRACT_SCOPE = 'structural-and-security-product-schema';

const INTROSPECTION_SQL = Object.freeze({
  show_transaction_read_only: 'SHOW transaction_read_only',
  show_statement_timeout: 'SHOW statement_timeout',
  show_lock_timeout: 'SHOW lock_timeout',
  show_application_name: 'SHOW application_name',
  db_owner: `
SELECT pg_catalog.pg_get_userbyid(d.datdba) AS db_owner
FROM pg_catalog.pg_database d
WHERE d.datname = current_database()`.trim(),
  tables: `
SELECT
  n.nspname AS table_schema,
  c.relname AS table_name,
  CASE c.relkind
    WHEN 'r' THEN 'BASE TABLE'
    WHEN 'v' THEN 'VIEW'
    ELSE c.relkind::text
  END AS table_type
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'v')
ORDER BY c.relname`.trim(),
  columns: `
SELECT
  n.nspname AS table_schema,
  c.relname AS table_name,
  a.attname AS column_name,
  pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
  t.typname AS udt_name,
  CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
  pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS column_default
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY c.relname, a.attnum`.trim(),
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
SELECT
  n.nspname AS table_schema,
  c.relname AS table_name,
  pg_catalog.pg_get_viewdef(c.oid, true) AS view_definition
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'v'
ORDER BY c.relname`.trim(),
  enums: `
SELECT
  n.nspname AS type_schema,
  t.typname AS type_name,
  e.enumlabel AS enum_label,
  e.enumsortorder AS enum_sort_order
FROM pg_catalog.pg_type t
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
WHERE n.nspname = 'public' AND t.typtype = 'e'
ORDER BY t.typname, e.enumsortorder, e.enumlabel`.trim(),
  functions: `
SELECT
  n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS identity,
  p.proname AS routine_name,
  pg_catalog.pg_get_functiondef(p.oid) AS definition,
  pg_catalog.pg_get_function_result(p.oid) AS return_type,
  l.lanname AS language,
  CASE p.provolatile
    WHEN 'i' THEN 'immutable'
    WHEN 's' THEN 'stable'
    WHEN 'v' THEN 'volatile'
    ELSE p.provolatile::text
  END AS volatility,
  p.prosecdef AS security_definer,
  COALESCE((
    SELECT string_agg(cfg, ',' ORDER BY cfg)
    FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS cfg
  ), '') AS proconfig
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
JOIN pg_catalog.pg_language l ON l.oid = p.prolang
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
  rls_flags: `
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
ORDER BY c.relname`.trim(),
  rls_policies: `
SELECT
  pol.schemaname,
  pol.tablename,
  pol.policyname,
  pol.permissive,
  COALESCE((
    SELECT string_agg(role_name, ',' ORDER BY role_name)
    FROM unnest(pol.roles) AS role_name
  ), '') AS roles,
  pol.cmd,
  pol.qual,
  pol.with_check
FROM pg_catalog.pg_policies pol
WHERE pol.schemaname = 'public'
ORDER BY pol.tablename, pol.policyname`.trim(),
  ownership_schema: `
SELECT
  'schema'::text AS owner_kind,
  n.nspname AS object_name,
  ''::text AS object_identity,
  ''::text AS object_subkind,
  pg_catalog.pg_get_userbyid(n.nspowner) AS owner
FROM pg_catalog.pg_namespace n
WHERE n.nspname = 'public'`.trim(),
  ownership_relations: `
SELECT
  'relation'::text AS owner_kind,
  c.relname AS object_name,
  ''::text AS object_identity,
  c.relkind::text AS object_subkind,
  pg_catalog.pg_get_userbyid(c.relowner) AS owner
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'v', 'S', 'm')
ORDER BY c.relkind, c.relname`.trim(),
  ownership_functions: `
SELECT
  'function'::text AS owner_kind,
  p.proname AS object_name,
  n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS object_identity,
  p.prokind::text AS object_subkind,
  pg_catalog.pg_get_userbyid(p.proowner) AS owner
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prokind IN ('f', 'p')
ORDER BY object_identity`.trim(),
  ownership_types: `
SELECT
  'type'::text AS owner_kind,
  t.typname AS object_name,
  n.nspname || '.' || t.typname AS object_identity,
  t.typtype::text AS object_subkind,
  pg_catalog.pg_get_userbyid(t.typowner) AS owner
FROM pg_catalog.pg_type t
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
  AND t.typtype IN ('e', 'c', 'd')
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend d
    WHERE d.classid = 'pg_catalog.pg_type'::regclass
      AND d.objid = t.oid
      AND d.deptype = 'i'
  )
ORDER BY t.typname`.trim(),
  ownership_extensions: `
SELECT
  'extension'::text AS owner_kind,
  e.extname AS object_name,
  e.extname AS object_identity,
  ''::text AS object_subkind,
  pg_catalog.pg_get_userbyid(e.extowner) AS owner
FROM pg_catalog.pg_extension e
ORDER BY e.extname`.trim(),
  acls_schema: `
SELECT
  'schema'::text AS acl_kind,
  n.nspname AS object_name,
  ''::text AS object_identity,
  ''::text AS object_subkind,
  COALESCE((
    SELECT string_agg(aclitem::text, ',' ORDER BY aclitem::text)
    FROM unnest(COALESCE(n.nspacl, ARRAY[]::aclitem[])) AS aclitem
  ), '') AS acl
FROM pg_catalog.pg_namespace n
WHERE n.nspname = 'public'`.trim(),
  acls_relations: `
SELECT
  'relation'::text AS acl_kind,
  c.relname AS object_name,
  ''::text AS object_identity,
  c.relkind::text AS object_subkind,
  COALESCE((
    SELECT string_agg(aclitem::text, ',' ORDER BY aclitem::text)
    FROM unnest(COALESCE(c.relacl, ARRAY[]::aclitem[])) AS aclitem
  ), '') AS acl
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'v', 'S', 'm')
ORDER BY c.relkind, c.relname`.trim(),
  acls_functions: `
SELECT
  'function'::text AS acl_kind,
  p.proname AS object_name,
  n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS object_identity,
  p.prokind::text AS object_subkind,
  COALESCE((
    SELECT string_agg(aclitem::text, ',' ORDER BY aclitem::text)
    FROM unnest(COALESCE(p.proacl, ARRAY[]::aclitem[])) AS aclitem
  ), '') AS acl
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prokind IN ('f', 'p')
ORDER BY object_identity`.trim(),
  acls_types: `
SELECT
  'type'::text AS acl_kind,
  t.typname AS object_name,
  n.nspname || '.' || t.typname AS object_identity,
  t.typtype::text AS object_subkind,
  COALESCE((
    SELECT string_agg(aclitem::text, ',' ORDER BY aclitem::text)
    FROM unnest(COALESCE(t.typacl, ARRAY[]::aclitem[])) AS aclitem
  ), '') AS acl
FROM pg_catalog.pg_type t
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
  AND t.typtype IN ('e', 'c', 'd')
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend d
    WHERE d.classid = 'pg_catalog.pg_type'::regclass
      AND d.objid = t.oid
      AND d.deptype = 'i'
  )
ORDER BY t.typname`.trim(),
  extensions: `
SELECT
  e.extname,
  e.extversion,
  pg_catalog.pg_get_userbyid(e.extowner) AS extowner,
  n.nspname AS extnamespace,
  e.extrelocatable,
  COALESCE((
    SELECT string_agg(cn.nspname || '.' || c.relname, ',' ORDER BY cn.nspname, c.relname)
    FROM unnest(COALESCE(e.extconfig, ARRAY[]::oid[])) AS cfg_oid
    JOIN pg_catalog.pg_class c ON c.oid = cfg_oid
    JOIN pg_catalog.pg_namespace cn ON cn.oid = c.relnamespace
  ), '') AS config_relations,
  COALESCE((
    SELECT string_agg(cond, ',' ORDER BY cond)
    FROM unnest(COALESCE(e.extcondition, ARRAY[]::text[])) AS cond
  ), '') AS config_conditions
FROM pg_catalog.pg_extension e
JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
ORDER BY e.extname`.trim(),
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
  const tlsOk = sslmode === 'verify-full';
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
      sslParam: ssl || null,
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
      errors.push({
        code: 'local_host_not_loopback',
        message: 'local proof host must be loopback or disposable docker alias',
      });
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
  if (!allowLocalEphemeral) {
    if (!parsed || parsed.sslmode !== 'verify-full') {
      errors.push({
        code: 'tls_not_verify_full',
        message: 'DSN must use sslmode=verify-full (ssl=true / require / verify-ca are insufficient)',
      });
    }
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
    cfg.ssl = {
      rejectUnauthorized: true,
      servername: url.hostname,
    };
  }
  return cfg;
}

function createEphemeralSelfSigned() {
  const fixtureDir = path.join(__dirname, '..', '..', 'fixtures', 'sunset-schema-observer', 'tls-red');
  const fixtureKey = path.join(fixtureDir, 'untrusted-key.pem');
  const fixtureCert = path.join(fixtureDir, 'untrusted-cert.pem');
  if (fs.existsSync(fixtureKey) && fs.existsSync(fixtureCert)) {
    return {
      key: fs.readFileSync(fixtureKey, 'utf8'),
      cert: fs.readFileSync(fixtureCert, 'utf8'),
    };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-obs-tls-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-nodes', '-subj', '/CN=localhost',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  const key = fs.readFileSync(keyPath, 'utf8');
  const cert = fs.readFileSync(certPath, 'utf8');
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) { /* ignore */ }
  return { key, cert };
}

/** Transport proof: rejectUnauthorized:true rejects untrusted cert. No live Sunset. */
function proveTlsRejectsUntrustedCertificate() {
  return new Promise((resolve) => {
    let selfsigned;
    try {
      selfsigned = createEphemeralSelfSigned();
    } catch (e) {
      resolve({
        ok: false,
        code: 'tls_fixture_unavailable',
        message: String(e && e.message ? e.message : e).slice(0, 200),
      });
      return;
    }
    const server = tls.createServer(
      { key: selfsigned.key, cert: selfsigned.cert },
      (socket) => {
        socket.end('ok');
      },
    );
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const socket = tls.connect(
        {
          host: '127.0.0.1',
          port,
          servername: 'localhost',
          rejectUnauthorized: true,
        },
        () => {
          socket.destroy();
          server.close();
          resolve({ ok: false, code: 'unexpected_trust', message: 'untrusted cert was accepted' });
        },
      );
      socket.on('error', (err) => {
        server.close();
        const msg = String(err && err.message ? err.message : err);
        const rejected = /self-signed|UNABLE_TO_VERIFY|unable to verify|certificate/i.test(msg);
        resolve({
          ok: rejected,
          code: rejected ? 'untrusted_cert_rejected' : 'unexpected_tls_error',
          message: msg.slice(0, 200),
        });
      });
    });
  });
}

function normalizeDefault(def) {
  if (def == null) return null;
  return String(def).replace(/\s+/g, ' ').trim();
}

function normalizeWhitespace(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n').trim();
}

function normalizeOwnerName(owner, dbOwner) {
  const o = String(owner || '');
  if (dbOwner && o === dbOwner) return '$db_owner';
  return o;
}

function normalizeAclText(acl, dbOwner) {
  let s = String(acl || '');
  if (dbOwner) {
    const re = new RegExp(dbOwner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    s = s.replace(re, '$db_owner');
  }
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .sort()
    .join(',');
}

function buildProductSchemaSnapshot(rowsByKind, opts) {
  const options = opts || {};
  const dbOwner = options.dbOwner || null;
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
  const enums = (rowsByKind.enums || [])
    .filter((e) => e.type_schema === 'public')
    .map((e) => ({
      type: e.type_name,
      label: e.enum_label,
      order: Number(e.enum_sort_order),
    }))
    .sort((a, b) => `${a.type}:${a.order}:${a.label}`.localeCompare(`${b.type}:${b.order}:${b.label}`));
  const functions = (rowsByKind.functions || [])
    .map((f) => ({
      name: f.routine_name,
      identity: f.identity,
      definition: normalizeWhitespace(f.definition),
      returnType: String(f.return_type || ''),
      language: String(f.language || ''),
      volatility: String(f.volatility || ''),
      securityDefiner: f.security_definer === true || f.security_definer === 't',
      proconfig: String(f.proconfig || ''),
    }))
    .sort((a, b) => String(a.identity).localeCompare(String(b.identity)));
  const triggers = (rowsByKind.triggers || [])
    .filter((t) => t.tgrelid_name !== LEDGER_TABLE)
    .map((t) => ({
      name: t.tgname,
      table: t.tgrelid_name,
      def: String(t.tgdef || '').replace(/\s+/g, ' ').trim(),
    }))
    .sort((a, b) => `${a.table}.${a.name}`.localeCompare(`${b.table}.${b.name}`));
  const rlsFlags = (rowsByKind.rls_flags || [])
    .filter((r) => r.table_name !== LEDGER_TABLE)
    .map((r) => ({
      table: r.table_name,
      enabled: r.rls_enabled === true || r.rls_enabled === 't',
      forced: r.rls_forced === true || r.rls_forced === 't',
    }))
    .sort((a, b) => a.table.localeCompare(b.table));
  const rlsPolicies = (rowsByKind.rls_policies || [])
    .filter((p) => p.tablename !== LEDGER_TABLE)
    .map((p) => ({
      table: p.tablename,
      name: p.policyname,
      permissive: String(p.permissive || ''),
      roles: String(p.roles || ''),
      cmd: String(p.cmd || ''),
      qual: p.qual == null ? null : String(p.qual),
      withCheck: p.with_check == null ? null : String(p.with_check),
    }))
    .sort((a, b) => `${a.table}.${a.name}`.localeCompare(`${b.table}.${b.name}`));
  const ownershipRows = []
    .concat(rowsByKind.ownership_schema || [])
    .concat(rowsByKind.ownership_relations || [])
    .concat(rowsByKind.ownership_functions || [])
    .concat(rowsByKind.ownership_types || [])
    .concat(rowsByKind.ownership_extensions || []);
  const ownership = ownershipRows
    .filter((o) => o.object_name !== LEDGER_TABLE)
    .map((o) => ({
      kind: String(o.owner_kind || ''),
      name: String(o.object_name || ''),
      identity: String(o.object_identity || o.object_name || ''),
      subkind: String(o.object_subkind || ''),
      owner: normalizeOwnerName(o.owner, dbOwner),
    }))
    .sort((a, b) => `${a.kind}.${a.identity}`.localeCompare(`${b.kind}.${b.identity}`));
  const aclRows = []
    .concat(rowsByKind.acls_schema || [])
    .concat(rowsByKind.acls_relations || [])
    .concat(rowsByKind.acls_functions || [])
    .concat(rowsByKind.acls_types || []);
  const acls = aclRows
    .filter((a) => a.object_name !== LEDGER_TABLE)
    .map((a) => ({
      kind: String(a.acl_kind || ''),
      name: String(a.object_name || ''),
      identity: String(a.object_identity || a.object_name || ''),
      subkind: String(a.object_subkind || ''),
      acl: normalizeAclText(a.acl, dbOwner),
    }))
    .sort((a, b) => `${a.kind}.${a.identity}`.localeCompare(`${b.kind}.${b.identity}`));
  const extensions = (rowsByKind.extensions || [])
    .map((e) => ({
      name: e.extname,
      version: String(e.extversion || ''),
      owner: normalizeOwnerName(e.extowner, dbOwner),
      schema: String(e.extnamespace || ''),
      relocatable: e.extrelocatable === true || e.extrelocatable === 't',
      configRelations: String(e.config_relations || ''),
      configConditions: String(e.config_conditions || ''),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    tables,
    columns,
    constraints,
    indexes,
    sequences,
    views,
    enums,
    functions,
    triggers,
    rlsFlags,
    rlsPolicies,
    ownership,
    acls,
    extensions,
  };
}

function fingerprintProductSchema(snapshot) {
  return sha256Text(JSON.stringify(snapshot));
}

function indexByKey(items, keyFn) {
  const map = new Map();
  for (const item of items) map.set(keyFn(item), item);
  return map;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function compareSnapshots(expected, live) {
  const drifts = [];
  function diffSection(name, expList, liveList, keyFn, equalFn) {
    const eMap = indexByKey(expList || [], keyFn);
    const lMap = indexByKey(liveList || [], keyFn);
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
  diffSection('tables', (expected.tables || []).map((t) => ({ name: t })), (live.tables || []).map((t) => ({ name: t })), (x) => x.name, () => true);
  diffSection('columns', expected.columns, live.columns, (c) => `${c.table}.${c.column}`, deepEqual);
  diffSection('constraints', expected.constraints, live.constraints, (c) => `${c.table}.${c.name}.${c.type}`, deepEqual);
  diffSection('indexes', expected.indexes, live.indexes, (i) => `${i.table}.${i.name}`, (a, b) => a.def === b.def);
  diffSection('sequences', (expected.sequences || []).map((s) => ({ name: s })), (live.sequences || []).map((s) => ({ name: s })), (x) => x.name, () => true);
  diffSection('views', expected.views, live.views, (v) => v.name, (a, b) => a.def === b.def);
  diffSection('enums', expected.enums, live.enums, (e) => `${e.type}:${e.label}`, (a, b) => a.order === b.order && a.label === b.label);
  diffSection('functions', expected.functions, live.functions, (f) => f.identity || f.name, deepEqual);
  diffSection('triggers', expected.triggers, live.triggers, (t) => `${t.table}.${t.name}`, (a, b) => a.def === b.def);
  diffSection('rlsFlags', expected.rlsFlags, live.rlsFlags, (r) => r.table, deepEqual);
  diffSection('rlsPolicies', expected.rlsPolicies, live.rlsPolicies, (p) => `${p.table}.${p.name}`, deepEqual);
  diffSection('ownership', expected.ownership, live.ownership, (o) => `${o.kind}:${o.identity}`, deepEqual);
  diffSection('acls', expected.acls, live.acls, (a) => `${a.kind}:${a.identity}`, deepEqual);
  diffSection('extensions', expected.extensions, live.extensions, (e) => e.name, deepEqual);
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
  const dbOwnerRows = await q('db_owner');
  const dbOwner = dbOwnerRows[0] && dbOwnerRows[0].db_owner ? String(dbOwnerRows[0].db_owner) : null;
  const rowsByKind = {
    tables: await q('tables'),
    columns: await q('columns'),
    constraints: await q('constraints'),
    indexes: await q('indexes'),
    sequences: (await q('sequences')).map((r) => ({ relname: r.relname })),
    views: await q('views'),
    enums: await q('enums'),
    functions: await q('functions'),
    triggers: await q('triggers'),
    rls_flags: await q('rls_flags'),
    rls_policies: await q('rls_policies'),
    ownership_schema: await q('ownership_schema'),
    ownership_relations: await q('ownership_relations'),
    ownership_functions: await q('ownership_functions'),
    ownership_types: await q('ownership_types'),
    ownership_extensions: await q('ownership_extensions'),
    acls_schema: await q('acls_schema'),
    acls_relations: await q('acls_relations'),
    acls_functions: await q('acls_functions'),
    acls_types: await q('acls_types'),
    extensions: await q('extensions'),
  };
  return {
    snapshot: buildProductSchemaSnapshot(rowsByKind, { dbOwner }),
    usedAllowlist: [...new Set(usedAllowlist)],
    dbOwner,
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
      checksumMode: manifest.checksumMode || null,
      intentionalGaps: manifest.intentionalGaps || [],
      forward: forward.map((e) => ({ id: e.id, order: e.order, filename: e.filename, sha256: e.sha256 })),
    })),
  };
}

function contractScopeMeta(contract) {
  return {
    scope: (contract && contract.scope) || CONTRACT_SCOPE,
    includedSections: (contract && contract.includedSections) || INCLUDED_SECTIONS.slice(),
    excludedSections: (contract && contract.excludedSections) || EXCLUDED_SECTIONS.slice(),
    ownershipCoverage: (contract && contract.ownershipCoverage) || OWNERSHIP_COVERAGE.slice(),
    aclCoverage: (contract && contract.aclCoverage) || ACL_COVERAGE.slice(),
    extensionCoverage: (contract && contract.extensionCoverage) || EXTENSION_COVERAGE.slice(),
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
  if (contract.scope !== CONTRACT_SCOPE) {
    errors.push({ code: 'bad_contract_scope', message: `scope must be ${CONTRACT_SCOPE}` });
  }
  for (const sec of ['enums', 'functions', 'rlsFlags', 'rlsPolicies', 'ownership', 'acls', 'extensions']) {
    if (!Array.isArray(contract.includedSections) || !contract.includedSections.includes(sec)) {
      errors.push({ code: 'missing_included_section', message: sec });
    }
    if (!contract.snapshot || !Array.isArray(contract.snapshot[sec])) {
      errors.push({ code: 'snapshot_missing_section', message: sec });
    }
  }
  for (const kind of OWNERSHIP_COVERAGE) {
    if (!Array.isArray(contract.ownershipCoverage) || !contract.ownershipCoverage.includes(kind)) {
      errors.push({ code: 'missing_ownership_coverage', message: kind });
    }
    if (contract.snapshot && Array.isArray(contract.snapshot.ownership)
      && !contract.snapshot.ownership.some((o) => o.kind === kind)
      && kind !== 'function' /* public functions may be empty in canonical chain */) {
      // schema/relation/type/extension must appear for canonical Sunset DB
      if (['schema', 'relation', 'type', 'extension'].includes(kind)
        && !(contract.snapshot.ownership || []).some((o) => o.kind === kind)) {
        errors.push({ code: 'snapshot_missing_ownership_kind', message: kind });
      }
    }
  }
  for (const kind of ACL_COVERAGE) {
    if (!Array.isArray(contract.aclCoverage) || !contract.aclCoverage.includes(kind)) {
      errors.push({ code: 'missing_acl_coverage', message: kind });
    }
  }
  for (const field of EXTENSION_COVERAGE) {
    if (!Array.isArray(contract.extensionCoverage) || !contract.extensionCoverage.includes(field)) {
      errors.push({ code: 'missing_extension_coverage', message: field });
    }
  }
  if (Array.isArray(contract.excludedSections)
    && contract.excludedSections.some((s) => /enum|function|rls|policy/i.test(String(s)))) {
    errors.push({ code: 'forbidden_exclusion', message: 'enums/functions/RLS must not be excluded' });
  }
  return errors;
}

function claimsCompleteEquivalence(text) {
  const s = String(text || '').replace(/\*+/g, '');
  // Allow explicit non-claims such as "not complete schema equivalence".
  const scrubbed = s.replace(/not\s+complete\s+(product[- ])?schema\s+equivalence/gi, '');
  return /(?<!not\s)complete\s+(product[- ])?schema\s+equivalence/i.test(scrubbed)
    || /full\s+schema\s+equivalence/i.test(scrubbed);
}

module.exports = {
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  APPLICATION_NAME,
  LEDGER_TABLE,
  OBSERVER_DSN_ENV,
  INCLUDED_SECTIONS,
  EXCLUDED_SECTIONS,
  OWNERSHIP_COVERAGE,
  ACL_COVERAGE,
  EXTENSION_COVERAGE,
  CONTRACT_SCOPE,
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
  proveTlsRejectsUntrustedCertificate,
  buildProductSchemaSnapshot,
  fingerprintProductSchema,
  compareSnapshots,
  assertReadOnlySession,
  safeQuery,
  introspectProductSchema,
  verifyLiveSession,
  hashCanonicalManifest,
  contractScopeMeta,
  contractStalenessErrors,
  claimsCompleteEquivalence,
};
