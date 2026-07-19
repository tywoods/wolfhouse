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
  show_server_version: 'SHOW server_version',
  show_server_version_num: 'SHOW server_version_num',
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

/** DEC-001 / Slice 13C.1 — Azure Flexible Server identity presentation only. */
const NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1 = 'azure_flexible_server_v1';
const SUPPORTED_NORMALIZATION_PROFILES = Object.freeze([
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
]);

function assertAzureFlexibleServerContext(ctx) {
  const errors = [];
  if (!ctx || ctx.verified !== true) {
    errors.push({
      code: 'azure_context_not_verified',
      message: 'azure_flexible_server_v1 requires independently verified Azure Flexible Server context',
    });
    return { ok: false, errors };
  }
  if (String(ctx.host || '') !== EXPECTED_HOST) {
    errors.push({
      code: 'azure_context_wrong_host',
      message: `host must be exactly ${EXPECTED_HOST}`,
    });
  }
  if (String(ctx.database || '') !== EXPECTED_DATABASE) {
    errors.push({
      code: 'azure_context_wrong_database',
      message: `database must be exactly ${EXPECTED_DATABASE}`,
    });
  }
  return { ok: errors.length === 0, errors };
}

function resolveNormalizationProfile(profile, azureContext) {
  if (profile == null || profile === '' || profile === false) {
    return { ok: true, profile: null };
  }
  if (!SUPPORTED_NORMALIZATION_PROFILES.includes(profile)) {
    return {
      ok: false,
      code: 'normalization_profile_unknown',
      message: `unknown normalization profile ${profile}`,
    };
  }
  if (profile === NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1) {
    const gate = assertAzureFlexibleServerContext(azureContext);
    if (!gate.ok) {
      return {
        ok: false,
        code: gate.errors[0] && gate.errors[0].code || 'azure_context_rejected',
        message: (gate.errors[0] && gate.errors[0].message) || 'azure context rejected',
        errors: gate.errors,
      };
    }
  }
  return { ok: true, profile };
}

/**
 * Parse PostgreSQL aclitem list into structured entries.
 * Format: grantee=privs/grantor (empty grantee = PUBLIC).
 */
function parseAclEntries(aclText) {
  const parts = String(aclText || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const entries = [];
  for (const raw of parts) {
    const m = raw.match(/^([^=]*)=([^/]*)\/(.+)$/);
    if (!m) {
      return { ok: false, code: 'acl_parse_failed', message: `unparseable ACL entry: ${raw}` };
    }
    entries.push({
      raw,
      grantee: m[1],
      privs: m[2],
      grantor: m[3],
    });
  }
  return { ok: true, entries };
}

function formatAclEntries(entries) {
  return entries
    .map((e) => `${e.grantee}=${e.privs}/${e.grantor}`)
    .sort()
    .join(',');
}

/**
 * Map azure_pg_admin ↔ pg_database_owner on public schema ACL only.
 * Privilege letters (including grant-option *) must be unchanged; only role tokens move.
 */
function normalizePublicSchemaAclAzurePgAdmin(aclText) {
  const parsed = parseAclEntries(aclText);
  if (!parsed.ok) return parsed;
  const roleMap = {
    azure_pg_admin: 'pg_database_owner',
    pg_database_owner: 'pg_database_owner',
  };
  const beforePrivFingerprint = parsed.entries.map((e) => e.privs).join('|');
  const mapped = parsed.entries.map((e) => {
    const grantee = Object.prototype.hasOwnProperty.call(roleMap, e.grantee)
      ? roleMap[e.grantee]
      : e.grantee;
    const grantor = Object.prototype.hasOwnProperty.call(roleMap, e.grantor)
      ? roleMap[e.grantor]
      : e.grantor;
    return { grantee, privs: e.privs, grantor };
  });
  const afterPrivFingerprint = mapped.map((e) => e.privs).join('|');
  if (beforePrivFingerprint !== afterPrivFingerprint) {
    return {
      ok: false,
      code: 'acl_privilege_changed_during_normalization',
      message: 'privilege set changed while normalizing public schema ACL',
    };
  }
  // Semantic privilege set: (normalizedGrantee, privs) multiset must preserve privilege codes.
  const privilegeCodesOnly = (list) => list.map((e) => e.privs).slice().sort().join(',');
  if (privilegeCodesOnly(parsed.entries) !== privilegeCodesOnly(mapped)) {
    return {
      ok: false,
      code: 'acl_privilege_codes_drift',
      message: 'privilege codes drifted during ACL role-token mapping',
    };
  }
  return {
    ok: true,
    acl: formatAclEntries(mapped),
    rule: 'azure_pg_admin_public_schema_acl_role_equivalence',
    privilegeSetUnchanged: true,
  };
}

function normalizeObservedOwnerAzure(owner, object) {
  const o = String(owner || '');
  const kind = String(object.kind || '');
  const name = String(object.name || object.identity || '');

  // Mapping 1: azuresu → $db_owner for extension + function owners only.
  if (o === 'azuresu') {
    if (kind === 'extension' || kind === 'function') {
      return {
        ok: true,
        owner: '$db_owner',
        rule: 'azuresu_to_db_owner_extension_or_function',
        applied: true,
      };
    }
    return {
      ok: true,
      owner: o,
      rule: null,
      applied: false,
      refused: 'azuresu_not_allowed_for_object_class',
    };
  }

  // Mapping 2: azure_pg_admin → pg_database_owner for public schema owner only.
  if (o === 'azure_pg_admin') {
    if (kind === 'schema' && name === 'public') {
      return {
        ok: true,
        owner: 'pg_database_owner',
        rule: 'azure_pg_admin_to_pg_database_owner_public_schema',
        applied: true,
      };
    }
    return {
      ok: true,
      owner: o,
      rule: null,
      applied: false,
      refused: 'azure_pg_admin_not_allowed_outside_public_schema',
    };
  }

  return { ok: true, owner: o, rule: null, applied: false };
}

/**
 * Deterministic, auditable normalization of observed identity presentation.
 * Does not mutate the input snapshot. Does not change privilege bits.
 */
function normalizeObservedIdentityPresentation(snapshot, opts) {
  const options = opts || {};
  const resolved = resolveNormalizationProfile(options.profile, options.azureContext);
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      message: resolved.message,
      errors: resolved.errors || [{ code: resolved.code, message: resolved.message }],
    };
  }
  const profile = resolved.profile;
  const src = snapshot || {};
  const out = JSON.parse(JSON.stringify(src));
  const audit = [];

  if (!profile) {
    return { ok: true, profile: null, snapshot: out, audit };
  }

  if (profile === NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1) {
    for (const o of out.ownership || []) {
      const n = normalizeObservedOwnerAzure(o.owner, o);
      if (n.applied) {
        audit.push({
          section: 'ownership',
          key: `${o.kind}:${o.identity}`,
          rule: n.rule,
          from: o.owner,
          to: n.owner,
          privilegeSetUnchanged: true,
        });
        o.owner = n.owner;
      }
    }
    for (const e of out.extensions || []) {
      const n = normalizeObservedOwnerAzure(e.owner, { kind: 'extension', name: e.name, identity: e.name });
      if (n.applied) {
        audit.push({
          section: 'extensions',
          key: e.name,
          rule: n.rule,
          from: e.owner,
          to: n.owner,
          privilegeSetUnchanged: true,
        });
        e.owner = n.owner;
      }
    }
    for (const a of out.acls || []) {
      if (a.kind === 'schema' && (a.name === 'public' || a.identity === 'public')) {
        const n = normalizePublicSchemaAclAzurePgAdmin(a.acl);
        if (!n.ok) {
          return { ok: false, code: n.code, message: n.message, audit };
        }
        if (n.acl !== a.acl) {
          audit.push({
            section: 'acls',
            key: `${a.kind}:${a.identity}`,
            rule: n.rule,
            from: a.acl,
            to: n.acl,
            privilegeSetUnchanged: n.privilegeSetUnchanged === true,
          });
          a.acl = n.acl;
        }
      }
    }
  }

  return { ok: true, profile, snapshot: out, audit };
}

/**
 * Canonical expected-side NOT NULL constraint object shape (PG contype 'n').
 * Exact: type === 'n', definition === 'NOT NULL <ident>', name === '<table>_<ident>_not_null'.
 */
const CANONICAL_NOT_NULL_DEFINITION_RE = /^NOT NULL ([a-z_][a-z0-9_]*)$/;

function parseCanonicalNotNullConstraint(constraint) {
  if (!constraint || typeof constraint !== 'object') {
    return { ok: false, reason: 'missing_constraint' };
  }
  const type = String(constraint.type || '');
  if (type !== 'n') {
    return { ok: false, reason: 'not_not_null_type' };
  }
  const table = String(constraint.table || '');
  const name = String(constraint.name || '');
  const definition = String(constraint.definition || '');
  if (!table || !name) {
    return { ok: false, reason: 'ambiguous_key' };
  }
  const m = definition.match(CANONICAL_NOT_NULL_DEFINITION_RE);
  if (!m) {
    return { ok: false, reason: 'unsupported_definition_shape' };
  }
  const column = m[1];
  const expectedName = `${table}_${column}_not_null`;
  if (name !== expectedName) {
    return { ok: false, reason: 'name_shape_mismatch' };
  }
  return {
    ok: true,
    table,
    column,
    name,
    type,
    definition,
    key: `${table}.${name}.${type}`,
    columnKey: `${table}.${column}`,
  };
}

function indexColumnsByTableColumn(columns) {
  const map = new Map();
  for (const c of columns || []) {
    if (!c || c.table == null || c.column == null) continue;
    const key = `${c.table}.${c.column}`;
    if (map.has(key)) {
      map.set(key, { duplicate: true, column: c });
    } else {
      map.set(key, { duplicate: false, column: c });
    }
  }
  return map;
}

/**
 * Slice 14T — cross-PG-version NOT NULL representation normalization for
 * azure_flexible_server_v1 only. Expected may encode NOT NULL as pg_constraint
 * contype 'n'; Azure Flexible Server often encodes the same guarantee via
 * pg_attribute.attnotnull (column nullable=NO) without a matching constraint
 * object. Exclude only proven-equivalent expected constraint objects.
 *
 * Never suppress real nullable drift: missing table/column, nullable!=NO,
 * ambiguous/duplicate keys, unsupported shapes, or non-Azure profiles retain
 * the expected constraint in comparison.
 */
function normalizeNotNullConstraintRepresentation(expected, live, opts) {
  const options = opts || {};
  const profile = options.profile || null;
  const audit = [];
  const retainedReasons = [];
  const expectedConstraints = Array.isArray(expected && expected.constraints)
    ? expected.constraints.slice()
    : [];

  if (profile !== NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1) {
    return {
      ok: true,
      applied: false,
      reason: 'profile_not_azure_flexible_server_v1',
      constraints: expectedConstraints,
      normalizedCount: 0,
      audit,
      retainedReasons,
    };
  }

  const gate = assertAzureFlexibleServerContext(options.azureContext);
  if (!gate.ok) {
    return {
      ok: false,
      applied: false,
      code: (gate.errors[0] && gate.errors[0].code) || 'azure_context_rejected',
      message: (gate.errors[0] && gate.errors[0].message) || 'azure context rejected',
      errors: gate.errors,
      constraints: expectedConstraints,
      normalizedCount: 0,
      audit,
      retainedReasons,
    };
  }

  const expectedCols = indexColumnsByTableColumn(expected && expected.columns);
  const liveCols = indexColumnsByTableColumn(live && live.columns);
  const liveConstraintKeys = new Set(
    (live && live.constraints ? live.constraints : []).map(
      (c) => `${c.table}.${c.name}.${c.type}`,
    ),
  );

  // Detect duplicate canonical claims for the same table.column among candidates.
  const columnClaimCounts = Object.create(null);
  const parsedByIndex = expectedConstraints.map((c, idx) => {
    const parsed = parseCanonicalNotNullConstraint(c);
    if (parsed.ok) {
      columnClaimCounts[parsed.columnKey] = (columnClaimCounts[parsed.columnKey] || 0) + 1;
    }
    return { idx, constraint: c, parsed };
  });

  const dropKeys = new Set();
  for (const entry of parsedByIndex) {
    const { parsed, constraint } = entry;
    if (!parsed.ok) {
      if (String(constraint.type || '') === 'n') {
        retainedReasons.push({
          key: `${constraint.table}.${constraint.name}.${constraint.type}`,
          reason: parsed.reason,
        });
      }
      continue;
    }

    if (columnClaimCounts[parsed.columnKey] > 1) {
      retainedReasons.push({ key: parsed.key, reason: 'duplicate_column_claim' });
      continue;
    }

    // If live already exposes the same constraint object, leave normal compare.
    if (liveConstraintKeys.has(parsed.key)) {
      retainedReasons.push({ key: parsed.key, reason: 'live_has_constraint_object' });
      continue;
    }

    const expCol = expectedCols.get(parsed.columnKey);
    if (!expCol || expCol.duplicate) {
      retainedReasons.push({
        key: parsed.key,
        reason: !expCol ? 'expected_column_missing' : 'expected_column_ambiguous',
      });
      continue;
    }
    if (String(expCol.column.nullable) !== 'NO') {
      retainedReasons.push({ key: parsed.key, reason: 'expected_column_not_nullable_no' });
      continue;
    }

    const liveCol = liveCols.get(parsed.columnKey);
    if (!liveCol || liveCol.duplicate) {
      retainedReasons.push({
        key: parsed.key,
        reason: !liveCol ? 'live_column_missing' : 'live_column_ambiguous',
      });
      continue;
    }
    if (String(liveCol.column.nullable) !== 'NO') {
      retainedReasons.push({ key: parsed.key, reason: 'live_column_nullable_mismatch' });
      continue;
    }

    dropKeys.add(parsed.key);
    audit.push({
      section: 'constraints',
      key: parsed.key,
      rule: 'not_null_constraint_object_to_attnotnull_equivalence',
      table: parsed.table,
      column: parsed.column,
      expectedNullable: 'NO',
      liveNullable: 'NO',
    });
  }

  const filtered = expectedConstraints.filter(
    (c) => !dropKeys.has(`${c.table}.${c.name}.${c.type}`),
  );

  return {
    ok: true,
    applied: true,
    profile,
    constraints: filtered,
    normalizedCount: dropKeys.size,
    audit,
    retainedReasons,
  };
}

/**
 * Slice 14V — migration 003 hostel_id→client_id NOT NULL constraint-name alias.
 * Does NOT broaden Slice 14T's exact-name rule (parseCanonicalNotNullConstraint).
 * Provenance is byte/hash-locked to canonical migration 003's guarded rename loop.
 */
const MIGRATION_003_FILENAME = '003_rename_hostel_to_client.sql';
const MIGRATION_003_HOSTEL_CLIENT_RENAME_SHA256 = 'f79826262081050f68c7f8014136d90730dc4dedffe37549aad2ff998f340257';
const MIGRATION_003_OLD_COLUMN = 'hostel_id';
const MIGRATION_003_CURRENT_COLUMN = 'client_id';
const MIGRATION_003_ALIAS_DEFINITION = 'NOT NULL client_id';
const MIGRATION_003_RENAME_ALIAS_RULE = 'migration_003_rename_alias';
const MIGRATION_003_REQUIRED_VERSION_CLASS = 'postgresql_15';

/** Extract tables from migration 003's guarded hostel_id→client_id rename loop. */
function extractMigration003HostelIdRenameTables(sqlText) {
  const text = String(sqlText || '');
  const blockRe = /FOREACH\s+t\s+IN\s+ARRAY\s+ARRAY\[([\s\S]*?)\]\s*LOOP([\s\S]*?)END\s+LOOP/gi;
  let match;
  while ((match = blockRe.exec(text)) !== null) {
    const body = match[2] || '';
    if (!/RENAME\s+COLUMN\s+hostel_id\s+TO\s+client_id/i.test(body)) continue;
    if (!/column_name\s*=\s*'hostel_id'/i.test(body)) continue;
    const raw = match[1] || '';
    const tables = [];
    const identRe = /'([a-z_][a-z0-9_]*)'/g;
    let m;
    while ((m = identRe.exec(raw)) !== null) {
      tables.push(m[1]);
    }
    if (tables.length === 0) {
      return { ok: false, reason: 'rename_loop_tables_empty' };
    }
    // Deduplicate while preserving first-seen order, then sort for lock stability.
    const seen = new Set();
    const unique = [];
    for (const t of tables) {
      if (seen.has(t)) continue;
      seen.add(t);
      unique.push(t);
    }
    return { ok: true, tables: unique.slice().sort() };
  }
  return { ok: false, reason: 'rename_loop_not_found' };
}

/**
 * Byte/hash-locked alias provenance map derived directly from migration 003.
 * Only tables enumerated by the guarded hostel_id→client_id rename loop.
 */
function buildMigration003HostelClientRenameAliasProvenance(opts) {
  const options = opts || {};
  const pathMod = require('path');
  const fsMod = require('fs');
  const cryptoMod = require('crypto');
  const migrationPath = options.migrationPath
    || pathMod.join(__dirname, '..', '..', 'database', 'migrations', MIGRATION_003_FILENAME);
  if (!fsMod.existsSync(migrationPath)) {
    return {
      ok: false,
      code: 'migration_003_missing',
      message: `migration 003 not found at ${migrationPath}`,
    };
  }
  const bytes = fsMod.readFileSync(migrationPath);
  // Prefer repo canonical_lf_v1 when available; fall back to raw sha256 of file bytes.
  let sha256;
  try {
    const { sha256CanonicalLfV1FromBuffer } = require('./migration-integrity');
    sha256 = sha256CanonicalLfV1FromBuffer(bytes);
  } catch (_) {
    sha256 = cryptoMod.createHash('sha256').update(bytes).digest('hex');
  }
  const expectedSha = options.expectedSha256 || MIGRATION_003_HOSTEL_CLIENT_RENAME_SHA256;
  if (sha256 !== expectedSha) {
    return {
      ok: false,
      code: 'migration_003_hash_mismatch',
      message: `migration 003 hash changed: got ${sha256}, expected ${expectedSha}`,
      migrationSha256: sha256,
      expectedSha256: expectedSha,
    };
  }
  const extracted = extractMigration003HostelIdRenameTables(bytes.toString('utf8'));
  if (!extracted.ok) {
    return {
      ok: false,
      code: 'migration_003_provenance_parse_failed',
      message: extracted.reason || 'failed to parse rename loop',
      migrationSha256: sha256,
    };
  }
  return {
    ok: true,
    migrationId: '003_rename_hostel_to_client',
    migrationFilename: MIGRATION_003_FILENAME,
    migrationPath,
    migrationSha256: sha256,
    oldColumn: MIGRATION_003_OLD_COLUMN,
    currentColumn: MIGRATION_003_CURRENT_COLUMN,
    aliasDefinition: MIGRATION_003_ALIAS_DEFINITION,
    approvedTables: Object.freeze(extracted.tables.slice()),
    provenanceCount: extracted.tables.length,
    rule: MIGRATION_003_RENAME_ALIAS_RULE,
  };
}

/**
 * Parse expected constraint as a migration-003 hostel_id→client_id rename alias.
 * Does not alter parseCanonicalNotNullConstraint (14T exact-name rule stays narrow).
 */
function parseMigration003HostelIdNotNullRenameAlias(constraint, provenance) {
  if (!constraint || typeof constraint !== 'object') {
    return { ok: false, reason: 'missing_constraint' };
  }
  if (!provenance || provenance.ok !== true || !Array.isArray(provenance.approvedTables)) {
    return { ok: false, reason: 'provenance_unavailable' };
  }
  const type = String(constraint.type || '');
  if (type !== 'n') {
    return { ok: false, reason: 'not_not_null_type' };
  }
  const table = String(constraint.table || '');
  const name = String(constraint.name || '');
  const definition = String(constraint.definition || '');
  if (!table || !name) {
    return { ok: false, reason: 'ambiguous_key' };
  }
  if (definition !== MIGRATION_003_ALIAS_DEFINITION) {
    return { ok: false, reason: 'wrong_definition' };
  }
  const legacyName = `${table}_${MIGRATION_003_OLD_COLUMN}_not_null`;
  if (name !== legacyName) {
    return { ok: false, reason: 'legacy_name_mismatch' };
  }
  if (!provenance.approvedTables.includes(table)) {
    return { ok: false, reason: 'table_not_provenance_approved' };
  }
  return {
    ok: true,
    table,
    name,
    type,
    definition,
    oldColumn: MIGRATION_003_OLD_COLUMN,
    currentColumn: MIGRATION_003_CURRENT_COLUMN,
    key: `${table}.${name}.${type}`,
    columnKey: `${table}.${MIGRATION_003_CURRENT_COLUMN}`,
    oldColumnKey: `${table}.${MIGRATION_003_OLD_COLUMN}`,
  };
}

function assertPg15AzureFlexibleServerContext(azureContext, serverVersionClass) {
  const gate = assertAzureFlexibleServerContext(azureContext);
  if (!gate.ok) return { ...gate, skipped: false };
  const versionClass = serverVersionClass != null
    ? String(serverVersionClass)
    : (azureContext && azureContext.versionClass != null
      ? String(azureContext.versionClass)
      : null);
  if (versionClass == null || versionClass === '') {
    return {
      ok: true,
      skipped: true,
      reason: 'pg15_context_absent',
      errors: [],
      versionClass: null,
    };
  }
  if (versionClass !== MIGRATION_003_REQUIRED_VERSION_CLASS) {
    return {
      ok: false,
      skipped: false,
      errors: [{
        code: 'pg15_context_required',
        message: `migration_003 rename alias requires ${MIGRATION_003_REQUIRED_VERSION_CLASS} context (got ${versionClass})`,
      }],
    };
  }
  return { ok: true, skipped: false, errors: [], versionClass };
}

/**
 * Slice 14V — exclude only proven migration-003 hostel_id→client_id NOT NULL
 * name aliases when live encodes the guarantee via attnotnull on client_id and
 * hostel_id is absent. Never broadens 14T exact-name parsing.
 *
 * Soft-skips (ok, applied:false) when PG15 version class is absent so older
 * azure_flexible_server_v1 callers that omit versionClass keep working.
 */
function normalizeMigration003HostelIdNotNullRenameAlias(expected, live, opts) {
  const options = opts || {};
  const profile = options.profile || null;
  const audit = [];
  const retainedReasons = [];
  const expectedConstraints = Array.isArray(expected && expected.constraints)
    ? expected.constraints.slice()
    : [];

  if (profile !== NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1) {
    return {
      ok: true,
      applied: false,
      reason: 'profile_not_azure_flexible_server_v1',
      constraints: expectedConstraints,
      normalizedCount: 0,
      audit,
      retainedReasons,
      provenance: null,
    };
  }

  const versionGate = assertPg15AzureFlexibleServerContext(
    options.azureContext,
    options.serverVersionClass,
  );
  if (!versionGate.ok) {
    return {
      ok: false,
      applied: false,
      code: (versionGate.errors[0] && versionGate.errors[0].code) || 'azure_context_rejected',
      message: (versionGate.errors[0] && versionGate.errors[0].message) || 'azure/pg15 context rejected',
      errors: versionGate.errors,
      constraints: expectedConstraints,
      normalizedCount: 0,
      audit,
      retainedReasons,
      provenance: null,
    };
  }
  if (versionGate.skipped === true) {
    return {
      ok: true,
      applied: false,
      reason: versionGate.reason || 'pg15_context_absent',
      constraints: expectedConstraints,
      normalizedCount: 0,
      audit,
      retainedReasons,
      provenance: null,
    };
  }

  const provenance = options.provenance
    || buildMigration003HostelClientRenameAliasProvenance({
      migrationPath: options.migrationPath,
      expectedSha256: options.expectedMigration003Sha256,
    });
  if (!provenance || provenance.ok !== true) {
    return {
      ok: false,
      applied: false,
      code: (provenance && provenance.code) || 'provenance_unavailable',
      message: (provenance && provenance.message) || 'migration 003 provenance unavailable',
      constraints: expectedConstraints,
      normalizedCount: 0,
      audit,
      retainedReasons,
      provenance: provenance || null,
    };
  }

  const expectedCols = indexColumnsByTableColumn(expected && expected.columns);
  const liveCols = indexColumnsByTableColumn(live && live.columns);
  const liveConstraintKeys = new Set(
    (live && live.constraints ? live.constraints : []).map(
      (c) => `${c.table}.${c.name}.${c.type}`,
    ),
  );

  const columnClaimCounts = Object.create(null);
  const parsedByIndex = expectedConstraints.map((c, idx) => {
    const parsed = parseMigration003HostelIdNotNullRenameAlias(c, provenance);
    if (parsed.ok) {
      columnClaimCounts[parsed.columnKey] = (columnClaimCounts[parsed.columnKey] || 0) + 1;
    }
    return { idx, constraint: c, parsed };
  });

  const dropKeys = new Set();
  for (const entry of parsedByIndex) {
    const { parsed, constraint } = entry;
    if (!parsed.ok) {
      // Only record retain reasons for type-n constraints that look like rename
      // leftovers we considered (legacy hostel_id name or alias definition).
      const type = String(constraint.type || '');
      const name = String(constraint.name || '');
      const definition = String(constraint.definition || '');
      if (type === 'n' && (
        name.endsWith(`_${MIGRATION_003_OLD_COLUMN}_not_null`)
        || definition === MIGRATION_003_ALIAS_DEFINITION
      )) {
        retainedReasons.push({
          key: `${constraint.table}.${constraint.name}.${constraint.type}`,
          reason: parsed.reason,
        });
      }
      continue;
    }

    if (columnClaimCounts[parsed.columnKey] > 1) {
      retainedReasons.push({ key: parsed.key, reason: 'duplicate_column_claim' });
      continue;
    }

    if (liveConstraintKeys.has(parsed.key)) {
      retainedReasons.push({ key: parsed.key, reason: 'live_has_constraint_object' });
      continue;
    }

    const expCol = expectedCols.get(parsed.columnKey);
    if (!expCol || expCol.duplicate) {
      retainedReasons.push({
        key: parsed.key,
        reason: !expCol ? 'expected_column_missing' : 'expected_column_ambiguous',
      });
      continue;
    }
    if (String(expCol.column.nullable) !== 'NO') {
      retainedReasons.push({ key: parsed.key, reason: 'expected_column_not_nullable_no' });
      continue;
    }

    const liveCol = liveCols.get(parsed.columnKey);
    if (!liveCol || liveCol.duplicate) {
      retainedReasons.push({
        key: parsed.key,
        reason: !liveCol ? 'live_column_missing' : 'live_column_ambiguous',
      });
      continue;
    }
    if (String(liveCol.column.nullable) !== 'NO') {
      retainedReasons.push({ key: parsed.key, reason: 'live_column_nullable_mismatch' });
      continue;
    }

    const liveOld = liveCols.get(parsed.oldColumnKey);
    if (liveOld && !liveOld.duplicate) {
      retainedReasons.push({ key: parsed.key, reason: 'live_hostel_id_present' });
      continue;
    }

    dropKeys.add(parsed.key);
    audit.push({
      section: 'constraints',
      key: parsed.key,
      rule: MIGRATION_003_RENAME_ALIAS_RULE,
      table: parsed.table,
      oldColumn: parsed.oldColumn,
      currentColumn: parsed.currentColumn,
      expectedNullable: 'NO',
      liveNullable: 'NO',
      liveHostelIdAbsent: true,
      migrationSha256: provenance.migrationSha256,
    });
  }

  const filtered = expectedConstraints.filter(
    (c) => !dropKeys.has(`${c.table}.${c.name}.${c.type}`),
  );

  return {
    ok: true,
    applied: true,
    profile,
    constraints: filtered,
    normalizedCount: dropKeys.size,
    audit,
    retainedReasons,
    provenance: {
      migrationSha256: provenance.migrationSha256,
      provenanceCount: provenance.provenanceCount,
      approvedTables: provenance.approvedTables.slice(),
      oldColumn: provenance.oldColumn,
      currentColumn: provenance.currentColumn,
      rule: provenance.rule,
    },
  };
}

/**
 * Slice 14W — generic exact rename provenance tuples for residual NOT NULL
 * legacy-name artifacts. Extends (does not weaken) 14T exact-name parsing or
 * 14V hostel_id→client_id alias normalization. Default OFF in compareSnapshots;
 * 14W enables explicitly. Byte/hash-locked to migrations 002/003/004.
 */
const MIGRATION_002_FILENAME = '002_package_pricing.sql';
const MIGRATION_002_PACKAGE_PRICING_SHA256 = '3caa9c743252bd058c7eb8cb9bdbd39686b3970249c9d5c051e6971ebf476748';
const MIGRATION_004_FILENAME = '004_payment_schema_phase2.sql';
const MIGRATION_004_PAYMENT_SCHEMA_SHA256 = 'c82718b6417ffa8c594227bb8873b8d89d65d567caf4489e108f1b86485f22c1';
const MIGRATION_003_TABLE_RENAME_OLD = 'hostels';
const MIGRATION_003_TABLE_RENAME_CURRENT = 'clients';
const MIGRATION_003_TABLE_RENAME_SQL = 'ALTER TABLE IF EXISTS hostels RENAME TO clients';
const MIGRATION_003_TABLE_RENAME_APPROVED_COLUMNS = Object.freeze([
  'created_at',
  'currency',
  'id',
  'is_active',
  'name',
  'settings',
  'slug',
  'timezone',
  'updated_at',
]);
const MIGRATION_002_COLUMN_RENAME_TABLE = 'package_price_rules';
const MIGRATION_002_COLUMN_RENAME_OLD = 'price_per_person_per_night_cents';
const MIGRATION_002_COLUMN_RENAME_CURRENT = 'price_per_person_per_week_cents';
const MIGRATION_002_COLUMN_RENAME_SQL = 'RENAME COLUMN price_per_person_per_night_cents TO price_per_person_per_week_cents';
const MIGRATION_004_COLUMN_RENAMES = Object.freeze([
  Object.freeze({
    table: 'payments',
    oldColumn: 'kind',
    currentColumn: 'payment_kind',
    renameSql: 'ALTER TABLE payments RENAME COLUMN kind TO payment_kind',
  }),
  Object.freeze({
    table: 'payments',
    oldColumn: 'amount_cents',
    currentColumn: 'amount_due_cents',
    renameSql: 'ALTER TABLE payments RENAME COLUMN amount_cents TO amount_due_cents',
  }),
]);
const FINAL_RENAME_RULE = 'exact_rename_provenance_tuple';
const FINAL_RENAME_REQUIRED_VERSION_CLASS = 'postgresql_15';

function sha256MigrationFile(migrationPath) {
  const bytes = fs.readFileSync(migrationPath);
  try {
    const { sha256CanonicalLfV1FromBuffer } = require('./migration-integrity');
    return sha256CanonicalLfV1FromBuffer(bytes);
  } catch (_) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
  }
}

function extractGuardedColumnRename(sqlText, table, oldColumn, currentColumn) {
  const text = String(sqlText || '');
  const renameRe = new RegExp(
    String.raw`ALTER\s+TABLE\s+${table}\s+RENAME\s+COLUMN\s+${oldColumn}\s+TO\s+${currentColumn}`,
    'i',
  );
  const bareRenameRe = new RegExp(
    String.raw`RENAME\s+COLUMN\s+${oldColumn}\s+TO\s+${currentColumn}`,
    'i',
  );
  if (!renameRe.test(text) && !bareRenameRe.test(text)) {
    return { ok: false, reason: 'rename_sql_not_found' };
  }
  const oldPresent = new RegExp(
    String.raw`column_name\s*=\s*'${oldColumn}'`,
    'i',
  ).test(text);
  if (!oldPresent) {
    return { ok: false, reason: 'old_column_guard_missing' };
  }
  return {
    ok: true,
    table,
    oldColumn,
    currentColumn,
    renameSql: `RENAME COLUMN ${oldColumn} TO ${currentColumn}`,
  };
}

function extractMigration003HostelsTableRename(sqlText) {
  const text = String(sqlText || '');
  if (!/ALTER\s+TABLE\s+IF\s+EXISTS\s+hostels\s+RENAME\s+TO\s+clients/i.test(text)) {
    return { ok: false, reason: 'table_rename_sql_not_found' };
  }
  return {
    ok: true,
    oldTable: MIGRATION_003_TABLE_RENAME_OLD,
    currentTable: MIGRATION_003_TABLE_RENAME_CURRENT,
    renameSql: MIGRATION_003_TABLE_RENAME_SQL,
    approvedColumns: MIGRATION_003_TABLE_RENAME_APPROVED_COLUMNS.slice(),
  };
}

/**
 * Build hash-locked exact provenance tuples from migrations 002/003/004.
 * Only the enumerated renames; never arbitrary aliases.
 */
function buildFinalNotNullRenameProvenance(opts) {
  const options = opts || {};
  const migrationsDir = options.migrationsDir
    || path.join(__dirname, '..', '..', 'database', 'migrations');
  const path002 = options.migration002Path
    || path.join(migrationsDir, MIGRATION_002_FILENAME);
  const path003 = options.migration003Path
    || path.join(migrationsDir, MIGRATION_003_FILENAME);
  const path004 = options.migration004Path
    || path.join(migrationsDir, MIGRATION_004_FILENAME);

  for (const [p, code] of [
    [path002, 'migration_002_missing'],
    [path003, 'migration_003_missing'],
    [path004, 'migration_004_missing'],
  ]) {
    if (!fs.existsSync(p)) {
      return { ok: false, code, message: `migration not found at ${p}` };
    }
  }

  const sha002 = sha256MigrationFile(path002);
  const sha003 = sha256MigrationFile(path003);
  const sha004 = sha256MigrationFile(path004);
  const expect002 = options.expectedMigration002Sha256 || MIGRATION_002_PACKAGE_PRICING_SHA256;
  const expect003 = options.expectedMigration003Sha256 || MIGRATION_003_HOSTEL_CLIENT_RENAME_SHA256;
  const expect004 = options.expectedMigration004Sha256 || MIGRATION_004_PAYMENT_SCHEMA_SHA256;

  if (sha002 !== expect002) {
    return {
      ok: false,
      code: 'migration_002_hash_mismatch',
      message: `migration 002 hash changed: got ${sha002}, expected ${expect002}`,
      migration002Sha256: sha002,
      expectedSha256: expect002,
    };
  }
  if (sha003 !== expect003) {
    return {
      ok: false,
      code: 'migration_003_hash_mismatch',
      message: `migration 003 hash changed: got ${sha003}, expected ${expect003}`,
      migration003Sha256: sha003,
      expectedSha256: expect003,
    };
  }
  if (sha004 !== expect004) {
    return {
      ok: false,
      code: 'migration_004_hash_mismatch',
      message: `migration 004 hash changed: got ${sha004}, expected ${expect004}`,
      migration004Sha256: sha004,
      expectedSha256: expect004,
    };
  }

  const text002 = fs.readFileSync(path002, 'utf8');
  const text003 = fs.readFileSync(path003, 'utf8');
  const text004 = fs.readFileSync(path004, 'utf8');

  const tableRename = extractMigration003HostelsTableRename(text003);
  if (!tableRename.ok) {
    return {
      ok: false,
      code: 'migration_003_table_rename_parse_failed',
      message: tableRename.reason,
      migration003Sha256: sha003,
    };
  }

  const col002 = extractGuardedColumnRename(
    text002,
    MIGRATION_002_COLUMN_RENAME_TABLE,
    MIGRATION_002_COLUMN_RENAME_OLD,
    MIGRATION_002_COLUMN_RENAME_CURRENT,
  );
  if (!col002.ok) {
    return {
      ok: false,
      code: 'migration_002_column_rename_parse_failed',
      message: col002.reason,
      migration002Sha256: sha002,
    };
  }

  const col004 = [];
  for (const spec of MIGRATION_004_COLUMN_RENAMES) {
    const extracted = extractGuardedColumnRename(
      text004,
      spec.table,
      spec.oldColumn,
      spec.currentColumn,
    );
    if (!extracted.ok) {
      return {
        ok: false,
        code: 'migration_004_column_rename_parse_failed',
        message: `${spec.oldColumn}->${spec.currentColumn}: ${extracted.reason}`,
        migration004Sha256: sha004,
      };
    }
    col004.push({
      kind: 'column_rename',
      migrationId: '004_payment_schema_phase2',
      migrationFilename: MIGRATION_004_FILENAME,
      migrationSha256: sha004,
      table: spec.table,
      oldColumn: spec.oldColumn,
      currentColumn: spec.currentColumn,
      renameSql: spec.renameSql,
      legacyName: `${spec.table}_${spec.oldColumn}_not_null`,
      definition: `NOT NULL ${spec.currentColumn}`,
      rule: FINAL_RENAME_RULE,
    });
  }

  const tuples = Object.freeze([
    Object.freeze({
      kind: 'table_rename',
      migrationId: '003_rename_hostel_to_client',
      migrationFilename: MIGRATION_003_FILENAME,
      migrationSha256: sha003,
      oldTable: tableRename.oldTable,
      currentTable: tableRename.currentTable,
      renameSql: tableRename.renameSql,
      approvedColumns: Object.freeze(tableRename.approvedColumns.slice()),
      rule: FINAL_RENAME_RULE,
    }),
    Object.freeze({
      kind: 'column_rename',
      migrationId: '002_package_pricing',
      migrationFilename: MIGRATION_002_FILENAME,
      migrationSha256: sha002,
      table: col002.table,
      oldColumn: col002.oldColumn,
      currentColumn: col002.currentColumn,
      renameSql: MIGRATION_002_COLUMN_RENAME_SQL,
      legacyName: `${col002.table}_${col002.oldColumn}_not_null`,
      definition: `NOT NULL ${col002.currentColumn}`,
      rule: FINAL_RENAME_RULE,
    }),
    ...col004.map((t) => Object.freeze(t)),
  ]);

  return {
    ok: true,
    tuples,
    provenanceCount: tuples.length,
    migration002Sha256: sha002,
    migration003Sha256: sha003,
    migration004Sha256: sha004,
    tableRenameApprovedColumns: MIGRATION_003_TABLE_RENAME_APPROVED_COLUMNS.slice(),
    rule: FINAL_RENAME_RULE,
  };
}

/**
 * Match an expected type-n constraint against exact provenance tuples.
 * Does not alter parseCanonicalNotNullConstraint (14T stays narrow).
 */
function parseFinalNotNullRenameProvenanceMatch(constraint, provenance) {
  if (!constraint || typeof constraint !== 'object') {
    return { ok: false, reason: 'missing_constraint' };
  }
  if (!provenance || provenance.ok !== true || !Array.isArray(provenance.tuples)) {
    return { ok: false, reason: 'provenance_unavailable' };
  }
  const type = String(constraint.type || '');
  if (type !== 'n') {
    return { ok: false, reason: 'not_not_null_type' };
  }
  const table = String(constraint.table || '');
  const name = String(constraint.name || '');
  const definition = String(constraint.definition || '');
  if (!table || !name) {
    return { ok: false, reason: 'ambiguous_key' };
  }

  for (const tuple of provenance.tuples) {
    if (tuple.kind === 'table_rename') {
      if (table !== tuple.currentTable) continue;
      const m = name.match(new RegExp(
        `^${tuple.oldTable}_([a-z_][a-z0-9_]*)_not_null$`,
      ));
      if (!m) continue;
      const column = m[1];
      if (definition !== `NOT NULL ${column}`) {
        return { ok: false, reason: 'wrong_definition' };
      }
      if (!tuple.approvedColumns.includes(column)) {
        return { ok: false, reason: 'column_not_provenance_approved' };
      }
      return {
        ok: true,
        kind: 'table_rename',
        table,
        name,
        type,
        definition,
        column,
        oldTable: tuple.oldTable,
        currentTable: tuple.currentTable,
        key: `${table}.${name}.${type}`,
        columnKey: `${table}.${column}`,
        oldTableKey: tuple.oldTable,
        migrationSha256: tuple.migrationSha256,
        migrationId: tuple.migrationId,
        renameSql: tuple.renameSql,
        rule: tuple.rule,
      };
    }

    if (tuple.kind === 'column_rename') {
      if (table !== tuple.table) continue;
      if (name !== tuple.legacyName) continue;
      if (definition !== tuple.definition) {
        return { ok: false, reason: 'wrong_definition' };
      }
      return {
        ok: true,
        kind: 'column_rename',
        table,
        name,
        type,
        definition,
        oldColumn: tuple.oldColumn,
        currentColumn: tuple.currentColumn,
        key: `${table}.${name}.${type}`,
        columnKey: `${table}.${tuple.currentColumn}`,
        oldColumnKey: `${table}.${tuple.oldColumn}`,
        migrationSha256: tuple.migrationSha256,
        migrationId: tuple.migrationId,
        renameSql: tuple.renameSql,
        rule: tuple.rule,
      };
    }
  }

  return { ok: false, reason: 'no_provenance_tuple_match' };
}

function indexTablesByName(tables) {
  const set = new Set();
  for (const t of tables || []) {
    if (t == null) continue;
    if (typeof t === 'string') set.add(t);
    else if (t.name != null) set.add(String(t.name));
  }
  return set;
}

/**
 * Slice 14W — exclude only proven exact rename-provenance NOT NULL legacy
 * names when live encodes the guarantee via attnotnull on the current column
 * and the old table/column is absent. Never broadens 14T/14V.
 */
function normalizeFinalNotNullRenameProvenance(expected, live, opts) {
  const options = opts || {};
  const profile = options.profile || null;
  const audit = [];
  const retainedReasons = [];
  const expectedConstraints = Array.isArray(expected && expected.constraints)
    ? expected.constraints.slice()
    : [];

  if (profile !== NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1) {
    return {
      ok: true,
      applied: false,
      reason: 'profile_not_azure_flexible_server_v1',
      constraints: expectedConstraints,
      normalizedCount: 0,
      audit,
      retainedReasons,
      provenance: null,
    };
  }

  const versionGate = assertPg15AzureFlexibleServerContext(
    options.azureContext,
    options.serverVersionClass,
  );
  if (!versionGate.ok) {
    return {
      ok: false,
      applied: false,
      code: (versionGate.errors[0] && versionGate.errors[0].code) || 'azure_context_rejected',
      message: (versionGate.errors[0] && versionGate.errors[0].message) || 'azure/pg15 context rejected',
      errors: versionGate.errors,
      constraints: expectedConstraints,
      normalizedCount: 0,
      audit,
      retainedReasons,
      provenance: null,
    };
  }
  if (versionGate.skipped === true) {
    return {
      ok: true,
      applied: false,
      reason: versionGate.reason || 'pg15_context_absent',
      constraints: expectedConstraints,
      normalizedCount: 0,
      audit,
      retainedReasons,
      provenance: null,
    };
  }

  const provenance = options.provenance
    || buildFinalNotNullRenameProvenance({
      migrationsDir: options.migrationsDir,
      migration002Path: options.migration002Path,
      migration003Path: options.migration003Path,
      migration004Path: options.migration004Path,
      expectedMigration002Sha256: options.expectedMigration002Sha256,
      expectedMigration003Sha256: options.expectedMigration003Sha256,
      expectedMigration004Sha256: options.expectedMigration004Sha256,
    });
  if (!provenance || provenance.ok !== true) {
    return {
      ok: false,
      applied: false,
      code: (provenance && provenance.code) || 'provenance_unavailable',
      message: (provenance && provenance.message) || 'final rename provenance unavailable',
      constraints: expectedConstraints,
      normalizedCount: 0,
      audit,
      retainedReasons,
      provenance: provenance || null,
    };
  }

  const expectedCols = indexColumnsByTableColumn(expected && expected.columns);
  const liveCols = indexColumnsByTableColumn(live && live.columns);
  const liveTables = indexTablesByName(live && live.tables);
  const liveConstraintKeys = new Set(
    (live && live.constraints ? live.constraints : []).map(
      (c) => `${c.table}.${c.name}.${c.type}`,
    ),
  );

  const columnClaimCounts = Object.create(null);
  const parsedByIndex = expectedConstraints.map((c, idx) => {
    const parsed = parseFinalNotNullRenameProvenanceMatch(c, provenance);
    if (parsed.ok) {
      columnClaimCounts[parsed.columnKey] = (columnClaimCounts[parsed.columnKey] || 0) + 1;
    }
    return { idx, constraint: c, parsed };
  });

  const dropKeys = new Set();
  for (const entry of parsedByIndex) {
    const { parsed, constraint } = entry;
    if (!parsed.ok) {
      const type = String(constraint.type || '');
      const name = String(constraint.name || '');
      if (type === 'n' && (
        name.startsWith('hostels_')
        || /_kind_not_null$|_amount_cents_not_null$|_price_per_person_per_night_cents_not_null$/.test(name)
        || name.includes('hostels_')
      )) {
        retainedReasons.push({
          key: `${constraint.table}.${constraint.name}.${constraint.type}`,
          reason: parsed.reason,
        });
      }
      continue;
    }

    if (columnClaimCounts[parsed.columnKey] > 1) {
      retainedReasons.push({ key: parsed.key, reason: 'duplicate_column_claim' });
      continue;
    }

    if (liveConstraintKeys.has(parsed.key)) {
      retainedReasons.push({ key: parsed.key, reason: 'live_has_constraint_object' });
      continue;
    }

    const expCol = expectedCols.get(parsed.columnKey);
    if (!expCol || expCol.duplicate) {
      retainedReasons.push({
        key: parsed.key,
        reason: !expCol ? 'expected_column_missing' : 'expected_column_ambiguous',
      });
      continue;
    }
    if (String(expCol.column.nullable) !== 'NO') {
      retainedReasons.push({ key: parsed.key, reason: 'expected_column_not_nullable_no' });
      continue;
    }

    const liveCol = liveCols.get(parsed.columnKey);
    if (!liveCol || liveCol.duplicate) {
      retainedReasons.push({
        key: parsed.key,
        reason: !liveCol ? 'live_column_missing' : 'live_column_ambiguous',
      });
      continue;
    }
    if (String(liveCol.column.nullable) !== 'NO') {
      retainedReasons.push({ key: parsed.key, reason: 'live_column_nullable_mismatch' });
      continue;
    }

    if (parsed.kind === 'table_rename') {
      if (liveTables.has(parsed.oldTableKey)) {
        retainedReasons.push({ key: parsed.key, reason: 'live_old_table_present' });
        continue;
      }
    } else if (parsed.kind === 'column_rename') {
      const liveOld = liveCols.get(parsed.oldColumnKey);
      if (liveOld && !liveOld.duplicate) {
        retainedReasons.push({ key: parsed.key, reason: 'live_old_column_present' });
        continue;
      }
    }

    dropKeys.add(parsed.key);
    audit.push({
      section: 'constraints',
      key: parsed.key,
      rule: FINAL_RENAME_RULE,
      kind: parsed.kind,
      table: parsed.table,
      column: parsed.column || parsed.currentColumn,
      oldTable: parsed.oldTable || null,
      oldColumn: parsed.oldColumn || null,
      currentColumn: parsed.currentColumn || parsed.column || null,
      expectedNullable: 'NO',
      liveNullable: 'NO',
      migrationId: parsed.migrationId,
      migrationSha256: parsed.migrationSha256,
      renameSql: parsed.renameSql,
    });
  }

  const filtered = expectedConstraints.filter(
    (c) => !dropKeys.has(`${c.table}.${c.name}.${c.type}`),
  );

  return {
    ok: true,
    applied: true,
    profile,
    constraints: filtered,
    normalizedCount: dropKeys.size,
    audit,
    retainedReasons,
    provenance: {
      provenanceCount: provenance.provenanceCount,
      migration002Sha256: provenance.migration002Sha256,
      migration003Sha256: provenance.migration003Sha256,
      migration004Sha256: provenance.migration004Sha256,
      tableRenameApprovedColumns: provenance.tableRenameApprovedColumns.slice(),
      tuples: provenance.tuples.map((t) => ({
        kind: t.kind,
        migrationId: t.migrationId,
        migrationSha256: t.migrationSha256,
        renameSql: t.renameSql,
        table: t.table || t.currentTable || null,
        oldTable: t.oldTable || null,
        oldColumn: t.oldColumn || null,
        currentColumn: t.currentColumn || null,
        legacyName: t.legacyName || null,
        definition: t.definition || null,
        approvedColumns: t.approvedColumns ? t.approvedColumns.slice() : null,
      })),
      rule: provenance.rule,
    },
  };
}

function classifyServerVersionClass(serverVersionNum, serverVersion) {
  const num = Number(serverVersionNum);
  if (Number.isFinite(num) && num >= 10000) {
    const major = Math.floor(num / 10000);
    return {
      ok: true,
      serverVersionNum: num,
      serverVersion: serverVersion != null ? String(serverVersion) : null,
      major,
      versionClass: `postgresql_${major}`,
    };
  }
  const text = String(serverVersion || '');
  const m = text.match(/^(\d+)/);
  if (m) {
    const major = Number(m[1]);
    return {
      ok: true,
      serverVersionNum: Number.isFinite(num) ? num : null,
      serverVersion: text || null,
      major,
      versionClass: `postgresql_${major}`,
    };
  }
  return {
    ok: false,
    serverVersionNum: Number.isFinite(num) ? num : null,
    serverVersion: text || null,
    major: null,
    versionClass: 'unknown',
  };
}

function compareSnapshots(expected, live, opts) {
  const options = opts || {};
  let liveSnap = live;
  let normalization = null;
  let notNullNormalization = null;
  let renameAliasNormalization = null;
  let finalRenameNormalization = null;
  let expectedSnap = expected;
  if (options.normalizationProfile != null && options.normalizationProfile !== '' && options.normalizationProfile !== false) {
    normalization = normalizeObservedIdentityPresentation(live, {
      profile: options.normalizationProfile,
      azureContext: options.azureContext,
    });
    if (!normalization.ok) {
      return {
        ok: false,
        drifts: [],
        counts: { expected_only: 0, live_only: 0, definition_mismatch: 0 },
        normalizationError: {
          code: normalization.code,
          message: normalization.message,
          errors: normalization.errors || [],
        },
        notNullNormalization: null,
        renameAliasNormalization: null,
        finalRenameNormalization: null,
      };
    }
    liveSnap = normalization.snapshot;

    // Slice 14T: NOT NULL constraint↔attnotnull equivalence (default on for azure profile).
    if (options.disableNotNullConstraintNormalization !== true) {
      notNullNormalization = normalizeNotNullConstraintRepresentation(expected, liveSnap, {
        profile: options.normalizationProfile,
        azureContext: options.azureContext,
      });
      if (!notNullNormalization.ok) {
        return {
          ok: false,
          drifts: [],
          counts: { expected_only: 0, live_only: 0, definition_mismatch: 0 },
          normalizationError: {
            code: notNullNormalization.code,
            message: notNullNormalization.message,
            errors: notNullNormalization.errors || [],
          },
          notNullNormalization,
          renameAliasNormalization: null,
          finalRenameNormalization: null,
        };
      }
      expectedSnap = {
        ...expected,
        constraints: notNullNormalization.constraints,
      };
    }

    // Slice 14V: migration 003 hostel_id→client_id name-alias only (does not
    // broaden 14T exact-name parsing). Default on for azure profile + PG15.
    if (options.disableRenameAliasNormalization !== true) {
      renameAliasNormalization = normalizeMigration003HostelIdNotNullRenameAlias(
        expectedSnap,
        liveSnap,
        {
          profile: options.normalizationProfile,
          azureContext: options.azureContext,
          serverVersionClass: options.serverVersionClass
            || (options.azureContext && options.azureContext.versionClass)
            || null,
          provenance: options.renameAliasProvenance || null,
          migrationPath: options.migration003Path,
          expectedMigration003Sha256: options.expectedMigration003Sha256,
        },
      );
      if (!renameAliasNormalization.ok) {
        return {
          ok: false,
          drifts: [],
          counts: { expected_only: 0, live_only: 0, definition_mismatch: 0 },
          normalizationError: {
            code: renameAliasNormalization.code,
            message: renameAliasNormalization.message,
            errors: renameAliasNormalization.errors || [],
          },
          notNullNormalization,
          renameAliasNormalization,
          finalRenameNormalization: null,
        };
      }
      expectedSnap = {
        ...expectedSnap,
        constraints: renameAliasNormalization.constraints,
      };
    }

    // Slice 14W: exact rename provenance tuples (002/003/004). Default OFF so
    // 14V remaining inventory stays stable; 14W enables explicitly.
    if (options.enableFinalRenameNormalization === true) {
      finalRenameNormalization = normalizeFinalNotNullRenameProvenance(
        expectedSnap,
        liveSnap,
        {
          profile: options.normalizationProfile,
          azureContext: options.azureContext,
          serverVersionClass: options.serverVersionClass
            || (options.azureContext && options.azureContext.versionClass)
            || null,
          provenance: options.finalRenameProvenance || null,
          migrationsDir: options.migrationsDir,
          migration002Path: options.migration002Path,
          migration003Path: options.migration003Path,
          migration004Path: options.migration004Path,
          expectedMigration002Sha256: options.expectedMigration002Sha256,
          expectedMigration003Sha256: options.expectedMigration003Sha256,
          expectedMigration004Sha256: options.expectedMigration004Sha256,
        },
      );
      if (!finalRenameNormalization.ok) {
        return {
          ok: false,
          drifts: [],
          counts: { expected_only: 0, live_only: 0, definition_mismatch: 0 },
          normalizationError: {
            code: finalRenameNormalization.code,
            message: finalRenameNormalization.message,
            errors: finalRenameNormalization.errors || [],
          },
          notNullNormalization,
          renameAliasNormalization,
          finalRenameNormalization,
        };
      }
      expectedSnap = {
        ...expectedSnap,
        constraints: finalRenameNormalization.constraints,
      };
    }
  }
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
  diffSection('tables', (expectedSnap.tables || []).map((t) => ({ name: t })), (liveSnap.tables || []).map((t) => ({ name: t })), (x) => x.name, () => true);
  diffSection('columns', expectedSnap.columns, liveSnap.columns, (c) => `${c.table}.${c.column}`, deepEqual);
  diffSection('constraints', expectedSnap.constraints, liveSnap.constraints, (c) => `${c.table}.${c.name}.${c.type}`, deepEqual);
  diffSection('indexes', expectedSnap.indexes, liveSnap.indexes, (i) => `${i.table}.${i.name}`, (a, b) => a.def === b.def);
  diffSection('sequences', (expectedSnap.sequences || []).map((s) => ({ name: s })), (liveSnap.sequences || []).map((s) => ({ name: s })), (x) => x.name, () => true);
  diffSection('views', expectedSnap.views, liveSnap.views, (v) => v.name, (a, b) => a.def === b.def);
  diffSection('enums', expectedSnap.enums, liveSnap.enums, (e) => `${e.type}:${e.label}`, (a, b) => a.order === b.order && a.label === b.label);
  diffSection('functions', expectedSnap.functions, liveSnap.functions, (f) => f.identity || f.name, deepEqual);
  diffSection('triggers', expectedSnap.triggers, liveSnap.triggers, (t) => `${t.table}.${t.name}`, (a, b) => a.def === b.def);
  diffSection('rlsFlags', expectedSnap.rlsFlags, liveSnap.rlsFlags, (r) => r.table, deepEqual);
  diffSection('rlsPolicies', expectedSnap.rlsPolicies, liveSnap.rlsPolicies, (p) => `${p.table}.${p.name}`, deepEqual);
  diffSection('ownership', expectedSnap.ownership, liveSnap.ownership, (o) => `${o.kind}:${o.identity}`, deepEqual);
  diffSection('acls', expectedSnap.acls, liveSnap.acls, (a) => `${a.kind}:${a.identity}`, deepEqual);
  diffSection('extensions', expectedSnap.extensions, liveSnap.extensions, (e) => e.name, deepEqual);
  const counts = {
    expected_only: drifts.filter((d) => d.kind === 'expected_only').length,
    live_only: drifts.filter((d) => d.kind === 'live_only').length,
    definition_mismatch: drifts.filter((d) => d.kind === 'definition_mismatch').length,
  };
  return {
    drifts,
    counts,
    ok: counts.expected_only + counts.live_only + counts.definition_mismatch === 0,
    normalization,
    notNullNormalization,
    renameAliasNormalization,
    finalRenameNormalization,
  };
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
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
  SUPPORTED_NORMALIZATION_PROFILES,
  assertAzureFlexibleServerContext,
  resolveNormalizationProfile,
  parseAclEntries,
  normalizeObservedIdentityPresentation,
  normalizeObservedOwnerAzure,
  normalizePublicSchemaAclAzurePgAdmin,
  parseCanonicalNotNullConstraint,
  normalizeNotNullConstraintRepresentation,
  MIGRATION_003_FILENAME,
  MIGRATION_003_HOSTEL_CLIENT_RENAME_SHA256,
  MIGRATION_003_OLD_COLUMN,
  MIGRATION_003_CURRENT_COLUMN,
  MIGRATION_003_ALIAS_DEFINITION,
  MIGRATION_003_RENAME_ALIAS_RULE,
  MIGRATION_003_REQUIRED_VERSION_CLASS,
  extractMigration003HostelIdRenameTables,
  buildMigration003HostelClientRenameAliasProvenance,
  parseMigration003HostelIdNotNullRenameAlias,
  normalizeMigration003HostelIdNotNullRenameAlias,
  MIGRATION_002_FILENAME,
  MIGRATION_002_PACKAGE_PRICING_SHA256,
  MIGRATION_004_FILENAME,
  MIGRATION_004_PAYMENT_SCHEMA_SHA256,
  MIGRATION_003_TABLE_RENAME_OLD,
  MIGRATION_003_TABLE_RENAME_CURRENT,
  MIGRATION_003_TABLE_RENAME_SQL,
  MIGRATION_003_TABLE_RENAME_APPROVED_COLUMNS,
  MIGRATION_002_COLUMN_RENAME_TABLE,
  MIGRATION_002_COLUMN_RENAME_OLD,
  MIGRATION_002_COLUMN_RENAME_CURRENT,
  MIGRATION_002_COLUMN_RENAME_SQL,
  MIGRATION_004_COLUMN_RENAMES,
  FINAL_RENAME_RULE,
  FINAL_RENAME_REQUIRED_VERSION_CLASS,
  extractGuardedColumnRename,
  extractMigration003HostelsTableRename,
  buildFinalNotNullRenameProvenance,
  parseFinalNotNullRenameProvenanceMatch,
  normalizeFinalNotNullRenameProvenance,
  classifyServerVersionClass,
  CANONICAL_NOT_NULL_DEFINITION_RE,
  assertReadOnlySession,
  safeQuery,
  introspectProductSchema,
  verifyLiveSession,
  hashCanonicalManifest,
  contractScopeMeta,
  contractStalenessErrors,
  claimsCompleteEquivalence,
};
