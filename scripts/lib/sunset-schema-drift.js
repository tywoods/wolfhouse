'use strict';

/**
 * Sunset live schema-drift helpers (FOUNDATION Slice 5).
 * Read-only comparison of live Sunset staging vs canonical migration contract.
 * Never prints or persists DSNs/secrets.
 */

const crypto = require('crypto');
const zlib = require('zlib');
const { URL } = require('url');

const EXPECTED_SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
const EXPECTED_RG = 'luna-sunset-staging-rg';
const EXPECTED_PG_SERVER = 'luna-sunset-staging-pg-app';
const EXPECTED_KV = 'luna-sunset-staging-kv';
const EXPECTED_SECRET_NAME = 'sunset-database-url';
const EXPECTED_DATABASE = 'sunset_staging';
const EXPECTED_HOST =
  'luna-sunset-staging-pg-app.postgres.database.azure.com';
const APPLICATION_NAME = 'wh-sunset-schema-drift-probe';
const LEDGER_TABLE = 'schema_migration_ledger';
const EXPECTED_STAFF_APP = 'luna-sunset-staging-staff-api';
const EXPECTED_IMAGE_REPO_PREFIX = 'whstagingacr.azurecr.io/luna-sunset-staff-api:';
const FORBIDDEN_IMAGE_SUBSTRINGS = Object.freeze(['wh-staff-api', 'wolfhouse']);
const CA_EXEC_MAX_RETRIES = 3;

/** Exact introspection queries used by the live probe (must pass assertSqlAllowed). */
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
  ledger_regclass: `SELECT to_regclass('public.schema_migration_ledger') AS reg`,
  ledger_columns: `
SELECT column_name, data_type, udt_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'schema_migration_ledger'
ORDER BY ordinal_position`.trim(),
  ledger_rows: `
SELECT id, filename, checksum_sha256, apply_order
FROM schema_migration_ledger
ORDER BY apply_order ASC`.trim(),
});

const SQL_REGISTRY_IDS = Object.freeze(Object.keys(INTROSPECTION_SQL));

const FORBIDDEN_SQL_VERBS = Object.freeze([
  /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY|CALL|DO|SET|BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/i,
  /\b(LOCK\s+TABLE|VACUUM|ANALYZE|REINDEX|CLUSTER)\b/i,
  /\bpg_advisory_lock\b/i,
]);

/** Read-only Azure CLI surface (argv tokens after the az binary). */
const AZ_COMMAND_SURFACE = Object.freeze({
  allowedKinds: Object.freeze([
    'account_show',
    'keyvault_secret_show',
    'containerapp_show',
    'containerapp_revision_list',
    'containerapp_replica_list',
    'containerapp_exec',
    'cost_management_query',
  ]),
  forbiddenSubstrings: Object.freeze([
    'firewall-rule create',
    'firewall-rule delete',
    'firewall-rule update',
    'containerapp update',
    'containerapp create',
    'containerapp delete',
    'containerapp revision restart',
    'containerapp revision activate',
    'containerapp revision deactivate',
    'containerapp revision copy',
    'containerapp revision set-mode',
    'containerapp replica restart',
    'deployment group create',
    'deployment sub create',
    'acr build',
    'keyvault secret set',
    'keyvault secret delete',
    'keyvault secret set-attributes',
    'postgres flexible-server execute',
    'postgres flexible-server parameter set',
  ]),
});

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
  const withoutTrailingSemi = raw.trim().replace(/;+\s*$/, '');
  if (withoutTrailingSemi.includes(';')) {
    return { ok: false, code: 'stacked_sql_rejected', message: 'stacked SQL statements are not allowed' };
  }
  for (const bad of FORBIDDEN_SQL_VERBS) {
    if (bad.test(withoutTrailingSemi)) {
      return { ok: false, code: 'forbidden_sql', message: 'SQL contains forbidden verb or transaction control' };
    }
  }
  const norm = normalizeSql(withoutTrailingSemi);
  if (!norm) {
    return { ok: false, code: 'sql_empty', message: 'empty SQL' };
  }
  for (const id of SQL_REGISTRY_IDS) {
    if (normalizeSql(INTROSPECTION_SQL[id]) === norm) {
      return { ok: true, allowlistId: id };
    }
  }
  return { ok: false, code: 'sql_not_in_registry', message: 'SQL is not an exact registry match' };
}

function normalizeAzArgv(args) {
  return (args || []).map((a) => String(a).trim()).filter(Boolean);
}

function flagValue(args, flag) {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return null;
  return args[i + 1];
}

/**
 * Deterministic gzip+base64 of the fixed collector source, then the exact
 * Linux-container --command string. assertAzCommandAllowed requires byte equality.
 */
function buildExactCollectorExecCommand() {
  const src = buildCaCollectorSource();
  const gz = zlib.gzipSync(Buffer.from(src, 'utf8'), { level: 9 });
  // Pin gzip header mtime/OS for cross-platform determinism.
  gz[4] = 0;
  gz[5] = 0;
  gz[6] = 0;
  gz[7] = 0;
  gz[9] = 255;
  const gzb64 = gz.toString('base64');
  return `node -e 'eval(require("zlib").gunzipSync(Buffer.from("${gzb64}","base64")).toString("utf8"))'`;
}

function buildExactContainerAppExecArgs(target) {
  const t = target || {};
  if (!t.revision || !t.replica || !t.container) {
    throw Object.assign(new Error('exec target incomplete'), { code: 'exec_target_incomplete' });
  }
  return [
    'containerapp',
    'exec',
    '-g',
    EXPECTED_RG,
    '-n',
    EXPECTED_STAFF_APP,
    '--revision',
    String(t.revision),
    '--replica',
    String(t.replica),
    '--container',
    String(t.container),
    '--command',
    buildExactCollectorExecCommand(),
  ];
}

function assertImageIsSunsetStaffApi(image) {
  const img = String(image || '');
  if (!img.startsWith(EXPECTED_IMAGE_REPO_PREFIX)) {
    return {
      ok: false,
      code: 'unexpected_image_repo',
      message: `image must start with ${EXPECTED_IMAGE_REPO_PREFIX}`,
    };
  }
  for (const bad of FORBIDDEN_IMAGE_SUBSTRINGS) {
    if (img.toLowerCase().includes(bad)) {
      return { ok: false, code: 'forbidden_image', message: `forbidden image substring: ${bad}` };
    }
  }
  return { ok: true };
}

/**
 * Pure resolver: active 100%-traffic revision + a running replica/container.
 */
function resolveRunningExecTarget(appShow, revisionList, replicaList) {
  const errors = [];
  const app = appShow || {};
  const props = app.properties || {};
  const templateContainers = (((props.template || {}).containers) || []);
  const appImage = (templateContainers[0] && templateContainers[0].image) || null;
  const imgGate = assertImageIsSunsetStaffApi(appImage);
  if (!imgGate.ok) errors.push(imgGate);

  const traffic = ((((app.properties || {}).configuration || {}).ingress || {}).traffic) || [];
  const full = traffic.find((t) => Number(t.weight) === 100) || null;
  let revisionName = full && full.revisionName ? full.revisionName : null;
  if (full && full.latestRevision && !revisionName) {
    revisionName = (app.properties && app.properties.latestRevisionName) || null;
  }
  if (!full || !revisionName) {
    errors.push({
      code: 'no_100_percent_revision',
      message: 'no ingress traffic entry with weight 100 resolving to a revision name',
    });
  }

  const revisions = Array.isArray(revisionList) ? revisionList : [];
  const rev = revisionName
    ? revisions.find((r) => (r.name || r.properties?.name) === revisionName)
    : null;
  const revImage =
    (rev
      && ((((rev.properties || {}).template || {}).containers || [])[0] || {}).image)
    || appImage;
  const revImgGate = assertImageIsSunsetStaffApi(revImage);
  if (!revImgGate.ok) errors.push(revImgGate);

  const replicas = Array.isArray(replicaList) ? replicaList : [];
  const running = replicas.find((r) => {
    const state = String(
      (r.properties && (r.properties.runningState || r.properties.runningStatus)) || '',
    ).toLowerCase();
    return !state || state === 'running' || state === 'success';
  }) || replicas[0] || null;
  if (!running) {
    errors.push({ code: 'no_running_replica', message: 'replica list empty' });
  }

  const replicaName = running && (running.name || (running.properties && running.properties.name));
  const containers =
    (running && running.properties && running.properties.containers)
    || templateContainers
    || [];
  const containerName =
    (containers[0] && (containers[0].name || EXPECTED_STAFF_APP))
    || EXPECTED_STAFF_APP;

  if (errors.length) {
    return { ok: false, errors, target: null };
  }
  return {
    ok: true,
    errors: [],
    target: {
      revision: revisionName,
      replica: replicaName,
      container: containerName,
      image: revImage,
      trafficWeight: 100,
    },
  };
}

function classifyAzCommand(args) {
  const a = normalizeAzArgv(args);
  const joined = a.join(' ').toLowerCase();
  for (const bad of AZ_COMMAND_SURFACE.forbiddenSubstrings) {
    if (joined.includes(bad)) {
      return { ok: false, code: 'az_mutation_rejected', kind: null, message: `forbidden Azure mutation surface: ${bad}` };
    }
  }
  if (a[0] === 'account' && a[1] === 'show') {
    return { ok: true, kind: 'account_show' };
  }
  if (
    a[0] === 'keyvault'
    && a[1] === 'secret'
    && a[2] === 'show'
    && a.includes('--vault-name')
    && a.includes(EXPECTED_KV)
    && a.includes('--name')
    && a.includes(EXPECTED_SECRET_NAME)
  ) {
    return { ok: true, kind: 'keyvault_secret_show' };
  }
  if (
    a[0] === 'containerapp'
    && a[1] === 'show'
    && a.includes(EXPECTED_RG)
    && a.includes(EXPECTED_STAFF_APP)
  ) {
    return { ok: true, kind: 'containerapp_show' };
  }
  if (
    a[0] === 'containerapp'
    && a[1] === 'revision'
    && a[2] === 'list'
    && a.includes(EXPECTED_RG)
    && a.includes(EXPECTED_STAFF_APP)
  ) {
    return { ok: true, kind: 'containerapp_revision_list' };
  }
  if (
    a[0] === 'containerapp'
    && a[1] === 'replica'
    && a[2] === 'list'
    && a.includes(EXPECTED_RG)
    && a.includes(EXPECTED_STAFF_APP)
    && a.includes('--revision')
    && flagValue(a, '--revision')
  ) {
    return { ok: true, kind: 'containerapp_replica_list' };
  }
  if (
    a[0] === 'containerapp'
    && a[1] === 'exec'
    && a.includes(EXPECTED_RG)
    && a.includes(EXPECTED_STAFF_APP)
    && a.includes('--command')
  ) {
    const command = flagValue(a, '--command');
    const expectedCommand = buildExactCollectorExecCommand();
    if (command !== expectedCommand) {
      return {
        ok: false,
        code: 'az_exec_command_not_bound',
        kind: null,
        message: 'containerapp exec --command must equal buildExactCollectorExecCommand() byte-for-byte',
      };
    }
    const revision = flagValue(a, '--revision');
    const replica = flagValue(a, '--replica');
    const container = flagValue(a, '--container');
    if (!revision || !replica || !container) {
      return {
        ok: false,
        code: 'az_exec_target_unbound',
        kind: null,
        message: 'containerapp exec requires --revision --replica --container',
      };
    }
    // Reject shell/node/sql smuggling via target names
    for (const [label, val] of [['revision', revision], ['replica', replica], ['container', container]]) {
      if (/[;|&`$]|node\s+-e|bash|sh\s+-c|SELECT\s|postgres/i.test(val)) {
        return {
          ok: false,
          code: 'az_exec_target_rejected',
          kind: null,
          message: `suspicious ${label} value rejected`,
        };
      }
    }
    return { ok: true, kind: 'containerapp_exec' };
  }
  if (a[0] === 'rest' && a.includes('--method') && a.includes('post')) {
    const urlIdx = a.findIndex((x) => x === '--url');
    const url = urlIdx >= 0 ? a[urlIdx + 1] : '';
    const costUrl =
      `https://management.azure.com/subscriptions/${EXPECTED_SUBSCRIPTION_ID}`
      + `/resourceGroups/${EXPECTED_RG}/providers/Microsoft.CostManagement/query`;
    if (String(url).startsWith(costUrl)) {
      return { ok: true, kind: 'cost_management_query' };
    }
    return { ok: false, code: 'az_rest_url_rejected', kind: null, message: 'az rest URL not on cost allowlist' };
  }
  return {
    ok: false,
    code: 'az_command_not_allowlisted',
    kind: null,
    message: `Azure command not on read-only surface: ${a.slice(0, 6).join(' ')}`,
  };
}

function assertAzCommandAllowed(args) {
  return classifyAzCommand(args);
}

/**
 * Independently verify marker-delimited collector payload (secret-free).
 */
function verifyCollectorPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') {
    return { ok: false, errors: [{ code: 'payload_missing', message: 'collector payload missing' }] };
  }
  const target = payload.target || {};
  if (target.host !== EXPECTED_HOST) {
    errors.push({ code: 'wrong_host', message: `host ${target.host}` });
  }
  if (target.database !== EXPECTED_DATABASE) {
    errors.push({ code: 'wrong_database', message: `database ${target.database}` });
  }
  const session = payload.session || {};
  if (String(session.transaction_read_only || '').toLowerCase() !== 'on') {
    errors.push({ code: 'non_read_only_session', message: String(session.transaction_read_only) });
  }
  const st = String(session.statement_timeout || '');
  if (!(st === '30s' || st === '30000ms' || st === '30000')) {
    errors.push({ code: 'bad_statement_timeout', message: st });
  }
  const lt = String(session.lock_timeout || '');
  if (!(lt === '5s' || lt === '5000ms' || lt === '5000')) {
    errors.push({ code: 'bad_lock_timeout', message: lt });
  }
  if (session.application_name !== APPLICATION_NAME) {
    errors.push({ code: 'wrong_application_name', message: String(session.application_name) });
  }
  const used = payload.usedAllowlist || [];
  const expectedIds = SQL_REGISTRY_IDS.slice().sort();
  const gotIds = [...new Set(used)].sort();
  // Must include session + product + ledger_regclass at minimum; reject unknown IDs
  for (const id of gotIds) {
    if (!SQL_REGISTRY_IDS.includes(id)) {
      errors.push({ code: 'unknown_allowlist_id', message: id });
    }
  }
  for (const need of [
    'show_transaction_read_only',
    'show_statement_timeout',
    'show_lock_timeout',
    'show_application_name',
    'tables',
    'columns',
    'constraints',
    'indexes',
    'sequences',
    'views',
    'functions',
    'triggers',
    'ledger_regclass',
  ]) {
    if (!gotIds.includes(need)) {
      errors.push({ code: 'missing_allowlist_id', message: need });
    }
  }
  if (!payload.snapshot) {
    errors.push({ code: 'snapshot_missing', message: 'snapshot required' });
  } else {
    const localFp = fingerprintProductSchema(payload.snapshot);
    if (localFp !== payload.fingerprint) {
      errors.push({
        code: 'fingerprint_recompute_mismatch',
        message: 'local fingerprint != collector fingerprint',
      });
    }
  }
  const text = JSON.stringify(payload);
  const leaks = assertNoLeakedDsn(text, null);
  if (leaks.length) {
    errors.push({ code: 'leaked_dsn', message: leaks.join(',') });
  }
  // Guest data heuristics: no email-looking fields in snapshot keys/values dump beyond schema names
  if (/@"|"email"|"phone"|"guest_name"|"whatsapp"/i.test(text) && /@/.test(text)) {
    // allow only if it's clearly not guest PII — schema column names like email are OK as names
    // Reject values that look like emails
    if (/:[ ]*"[^"]+@[^"]+\.[^"]+"/i.test(text)) {
      errors.push({ code: 'guest_data_suspected', message: 'email-like values in payload' });
    }
  }
  return { ok: errors.length === 0, errors, expectedIds, gotIds };
}

function parseDatabaseUrl(dsn) {
  const raw = String(dsn || '').trim();
  if (!raw) {
    return { ok: false, errors: [{ code: 'dsn_empty', message: 'empty DSN' }] };
  }
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
      protocol: url.protocol.replace(':', ''),
      host: url.hostname,
      port: url.port ? Number(url.port) : 5432,
      database: (url.pathname || '').replace(/^\//, ''),
      user: decodeURIComponent(url.username || ''),
      // password intentionally omitted from returned object for safety in reports
      hasPassword: Boolean(url.password),
      sslmode: sslmode || null,
      tlsOk,
      searchKeys: [...url.searchParams.keys()].sort(),
    },
  };
}

function assertSunsetStagingTarget(parsed, opts) {
  const options = opts || {};
  const errors = [];
  const subscriptionId = options.subscriptionId;
  const resourceGroup = options.resourceGroup;
  const serverName = options.serverName;

  if (subscriptionId && subscriptionId !== EXPECTED_SUBSCRIPTION_ID) {
    errors.push({ code: 'wrong_subscription', message: 'subscription does not match Slice 1 inventory' });
  }
  if (resourceGroup && resourceGroup !== EXPECTED_RG) {
    errors.push({ code: 'wrong_resource_group', message: 'resource group must be luna-sunset-staging-rg' });
  }
  if (serverName && serverName !== EXPECTED_PG_SERVER) {
    errors.push({ code: 'wrong_pg_server', message: 'PostgreSQL server must be luna-sunset-staging-pg-app' });
  }
  if (!parsed || !parsed.host) {
    errors.push({ code: 'missing_host', message: 'DSN host missing' });
  } else {
    if (parsed.host !== EXPECTED_HOST) {
      errors.push({
        code: 'wrong_host',
        message: `host must be exactly ${EXPECTED_HOST}`,
      });
    }
    const low = parsed.host.toLowerCase();
    if (/wolfhouse|wh-staging|wh-prod|prod\.|production/.test(low) && parsed.host !== EXPECTED_HOST) {
      errors.push({ code: 'forbidden_host', message: 'Wolfhouse/production host rejected' });
    }
  }
  if (!parsed || parsed.database !== EXPECTED_DATABASE) {
    errors.push({
      code: 'wrong_database',
      message: `database must be exactly ${EXPECTED_DATABASE}`,
    });
  }
  if (parsed && (parsed.database === 'wolfhouse_staging' || /wolfhouse|production|^prod$/i.test(parsed.database))) {
    errors.push({ code: 'forbidden_database', message: 'forbidden database name' });
  }
  if (!parsed || !parsed.tlsOk) {
    errors.push({ code: 'missing_tls', message: 'DSN must require TLS (sslmode=require|verify-* or ssl=true)' });
  }
  return { ok: errors.length === 0, errors };
}

function assertNoLeakedDsn(text, dsn) {
  const s = String(text || '');
  const hits = [];
  if (dsn && s.includes(dsn)) hits.push('raw_dsn');
  // Real credential-bearing URLs only (ignore already-redacted *** placeholders)
  if (/postgres(?:ql)?:\/\/(?!\*\*\*)[^:\s/@]+:(?!\*\*\*)[^@\s/]+@/i.test(s)) hits.push('embedded_dsn');
  if (/Password=/i.test(s) && /Host=/i.test(s)) hits.push('ado_style');
  return hits;
}

function clientConfigFromDsn(dsn) {
  const parsed = parseDatabaseUrl(dsn);
  if (!parsed.ok) {
    throw Object.assign(new Error('invalid DSN'), { code: 'dsn_parse_failed', errors: parsed.errors });
  }
  const target = assertSunsetStagingTarget(parsed.parsed);
  if (!target.ok) {
    throw Object.assign(new Error('DSN target rejected'), { code: 'wrong_target', errors: target.errors });
  }
  // Rebuild connection without putting secret on argv — password stays in memory only.
  const url = new URL(dsn);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username || ''),
    password: decodeURIComponent(url.password || ''),
    database: (url.pathname || '').replace(/^\//, ''),
    ssl: { rejectUnauthorized: false },
    application_name: APPLICATION_NAME,
    options: '-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=5000',
    connectionTimeoutMillis: 20000,
  };
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

  const sequences = (rowsByKind.sequences || [])
    .map((s) => s.relname)
    .sort();

  const views = (rowsByKind.views || [])
    .filter((v) => v.table_schema === 'public')
    .map((v) => ({
      name: v.table_name,
      def: String(v.view_definition || '').replace(/\s+/g, ' ').trim(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const functions = (rowsByKind.functions || [])
    .filter((f) => f.routine_schema === 'public' || f.nspname === 'public')
    .map((f) => ({
      name: f.routine_name || f.proname,
      identity: f.identity || f.proname,
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

  return {
    tables,
    columns,
    constraints,
    indexes,
    sequences,
    views,
    functions,
    triggers,
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

function compareSnapshots(expected, live) {
  const drifts = [];

  function diffSection(name, expList, liveList, keyFn, equalFn) {
    const eMap = indexByKey(expList, keyFn);
    const lMap = indexByKey(liveList, keyFn);
    for (const [k, ev] of eMap) {
      if (!lMap.has(k)) {
        drifts.push({ kind: 'expected_only', section: name, key: k, expected: ev, live: null });
      } else if (!equalFn(ev, lMap.get(k))) {
        drifts.push({
          kind: 'definition_mismatch',
          section: name,
          key: k,
          expected: ev,
          live: lMap.get(k),
        });
      }
    }
    for (const [k, lv] of lMap) {
      if (!eMap.has(k)) {
        drifts.push({ kind: 'live_only', section: name, key: k, expected: null, live: lv });
      }
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
  return { drifts, counts, ok: counts.expected_only + counts.live_only + counts.definition_mismatch === 0 };
}

function classifyLedgerStatus(liveLedgerMeta, liveLedgerRows, forwardEntries) {
  if (!liveLedgerMeta || !liveLedgerMeta.exists) {
    return { status: 'absent', detail: 'schema_migration_ledger table not present on live' };
  }
  if (liveLedgerMeta.incompatible) {
    return { status: 'incompatible', detail: liveLedgerMeta.reason || 'ledger table shape incompatible' };
  }
  const rows = liveLedgerRows || [];
  if (rows.length === 0) {
    return { status: 'partial', detail: 'ledger table exists but has zero rows' };
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const expected = forwardEntries || [];
  let prefixOk = true;
  for (let i = 0; i < Math.min(rows.length, expected.length); i += 1) {
    const exp = expected[i];
    const live = byId.get(exp.id);
    if (!live || Number(live.apply_order) !== exp.order || live.checksum_sha256 !== exp.sha256) {
      prefixOk = false;
      break;
    }
  }
  if (rows.length === expected.length && prefixOk) {
    // also ensure no extras
    const extras = rows.filter((r) => !expected.some((e) => e.id === r.id));
    if (extras.length === 0) {
      return { status: 'complete', detail: `ledger matches all ${expected.length} forward migrations` };
    }
    return { status: 'incompatible', detail: 'ledger contains unexpected migration ids' };
  }
  if (!prefixOk) {
    return { status: 'incompatible', detail: 'ledger checksum/order does not match canonical prefix' };
  }
  return {
    status: 'partial',
    detail: `ledger has ${rows.length}/${expected.length} rows (contiguous prefix)`,
  };
}

function summarizeDrifts(drifts) {
  return (drifts || []).slice(0, 200).map((d) => ({
    kind: d.kind,
    section: d.section,
    key: d.key,
  }));
}

const KNOWN_OBJECT_SECTIONS = Object.freeze([
  'tables',
  'columns',
  'constraints',
  'indexes',
  'sequences',
  'views',
  'functions',
  'triggers',
]);

function assertKnownObjectSection(section) {
  if (!KNOWN_OBJECT_SECTIONS.includes(section)) {
    return {
      ok: false,
      code: 'unknown_object_type',
      message: `unknown schema object section: ${section}`,
    };
  }
  return { ok: true };
}

function assertReadOnlySession(showRows) {
  const errors = [];
  const tro = String(showRows && showRows.transaction_read_only != null
    ? showRows.transaction_read_only
    : '').toLowerCase();
  if (tro !== 'on') {
    errors.push({ code: 'non_read_only_session', message: `transaction_read_only=${tro || 'unset'}` });
  }
  const app = String(showRows && showRows.application_name != null ? showRows.application_name : '');
  if (app !== APPLICATION_NAME) {
    errors.push({
      code: 'wrong_application_name',
      message: `application_name must be ${APPLICATION_NAME}`,
    });
  }
  return { ok: errors.length === 0, errors };
}

function inspectLedgerMeta(regclass, columns) {
  if (!regclass) {
    return { exists: false, incompatible: false };
  }
  const required = ['id', 'filename', 'checksum_sha256', 'apply_order'];
  const names = (columns || []).map((c) => c.column_name);
  const missing = required.filter((r) => !names.includes(r));
  if (missing.length) {
    return {
      exists: true,
      incompatible: true,
      reason: `ledger missing columns: ${missing.join(',')}`,
    };
  }
  return { exists: true, incompatible: false };
}

async function safeQuery(client, sql) {
  const gate = assertSqlAllowed(sql);
  if (!gate.ok) {
    throw Object.assign(new Error(gate.message), { code: gate.code, allowlistId: null });
  }
  const res = await client.query(sql);
  return { allowlistId: gate.allowlistId, rows: res.rows };
}

async function introspectProductSchema(client) {
  const usedAllowlist = [];
  async function q(key) {
    const sql = INTROSPECTION_SQL[key];
    const out = await safeQuery(client, sql);
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
  const snapshot = buildProductSchemaSnapshot(rowsByKind);
  return { snapshot, usedAllowlist: [...new Set(usedAllowlist)] };
}

async function introspectLedger(client, forward) {
  const reg = await safeQuery(client, INTROSPECTION_SQL.ledger_regclass);
  const regclass = reg.rows[0] && reg.rows[0].reg;
  if (!regclass) {
    return {
      meta: { exists: false, incompatible: false },
      rows: [],
      status: classifyLedgerStatus({ exists: false }, [], forward),
      usedAllowlist: [reg.allowlistId],
    };
  }
  const cols = await safeQuery(client, INTROSPECTION_SQL.ledger_columns);
  const meta = inspectLedgerMeta(regclass, cols.rows);
  let rows = [];
  const used = [reg.allowlistId, cols.allowlistId];
  if (!meta.incompatible) {
    const lr = await safeQuery(client, INTROSPECTION_SQL.ledger_rows);
    rows = lr.rows;
    used.push(lr.allowlistId);
  }
  return {
    meta,
    rows,
    status: classifyLedgerStatus(meta, rows, forward),
    usedAllowlist: [...new Set(used)],
  };
}

async function verifyLiveSession(client) {
  const tro = await safeQuery(client, INTROSPECTION_SQL.show_transaction_read_only);
  const st = await safeQuery(client, INTROSPECTION_SQL.show_statement_timeout);
  const lt = await safeQuery(client, INTROSPECTION_SQL.show_lock_timeout);
  const an = await safeQuery(client, INTROSPECTION_SQL.show_application_name);
  const showRows = {
    transaction_read_only: tro.rows[0]?.transaction_read_only,
    statement_timeout: st.rows[0]?.statement_timeout,
    lock_timeout: lt.rows[0]?.lock_timeout,
    application_name: an.rows[0]?.application_name,
  };
  const gate = assertReadOnlySession({
    transaction_read_only: showRows.transaction_read_only,
    application_name: showRows.application_name,
  });
  return {
    ok: gate.ok,
    errors: gate.errors,
    show: showRows,
    usedAllowlist: [tro, st, lt, an].map((x) => x.allowlistId),
  };
}

/**
 * Self-contained Node source for read-only Container App exec.
 * Uses only env WOLFHOUSE_DATABASE_URL already present in the Staff API revision.
 * Emits WH_SCHEMA_DRIFT_BEGIN/END markers + secret-free JSON (no DSN, no guest rows).
 */
function buildCaCollectorSource() {
  return `'use strict';
const { Client } = require('pg');
const { URL } = require('url');
const crypto = require('crypto');
const EXPECTED_HOST = ${JSON.stringify(EXPECTED_HOST)};
const EXPECTED_DATABASE = ${JSON.stringify(EXPECTED_DATABASE)};
const APPLICATION_NAME = ${JSON.stringify(APPLICATION_NAME)};
const LEDGER_TABLE = ${JSON.stringify(LEDGER_TABLE)};
const INTROSPECTION_SQL = ${JSON.stringify(INTROSPECTION_SQL)};
function normalizeSql(sql) {
  return String(sql || '').replace(/\\r\\n/g, '\\n').replace(/\\s+/g, ' ').trim().replace(/\\s*;+\\s*$/g, '').trim();
}
function assertSqlAllowed(sql) {
  const raw = String(sql || '');
  if (/--|\\/\\*|\\*\\//.test(raw)) return { ok: false, code: 'sql_comments_rejected' };
  const body = raw.trim().replace(/;+\\s*$/, '');
  if (body.includes(';')) return { ok: false, code: 'stacked_sql_rejected' };
  if (/\\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY|CALL|DO|SET|BEGIN|COMMIT|ROLLBACK|START\\s+TRANSACTION)\\b/i.test(body)) {
    return { ok: false, code: 'forbidden_sql' };
  }
  const norm = normalizeSql(body);
  for (const [id, q] of Object.entries(INTROSPECTION_SQL)) {
    if (normalizeSql(q) === norm) return { ok: true, allowlistId: id };
  }
  return { ok: false, code: 'sql_not_in_registry' };
}
function buildProductSchemaSnapshot(rowsByKind) {
  const nd = (d) => (d == null ? null : String(d).replace(/\\s+/g, ' ').trim());
  const tables = (rowsByKind.tables || []).filter((t) => t.table_schema === 'public' && t.table_type === 'BASE TABLE' && t.table_name !== LEDGER_TABLE).map((t) => t.table_name).sort();
  const columns = (rowsByKind.columns || []).filter((c) => c.table_schema === 'public' && c.table_name !== LEDGER_TABLE).map((c) => ({ table: c.table_name, column: c.column_name, type: c.data_type, udt: c.udt_name, nullable: c.is_nullable, default: nd(c.column_default) })).sort((a, b) => (a.table + '.' + a.column).localeCompare(b.table + '.' + b.column));
  const constraints = (rowsByKind.constraints || []).filter((c) => c.table_schema === 'public' && c.table_name !== LEDGER_TABLE).map((c) => ({ table: c.table_name, name: c.constraint_name, type: c.constraint_type, definition: c.definition || null })).sort((a, b) => (a.table + '.' + a.name).localeCompare(b.table + '.' + b.name));
  const indexes = (rowsByKind.indexes || []).filter((i) => i.schemaname === 'public' && i.tablename !== LEDGER_TABLE).map((i) => ({ table: i.tablename, name: i.indexname, def: String(i.indexdef || '').replace(/\\s+/g, ' ').trim() })).sort((a, b) => (a.table + '.' + a.name).localeCompare(b.table + '.' + b.name));
  const sequences = (rowsByKind.sequences || []).map((s) => s.relname).sort();
  const views = (rowsByKind.views || []).filter((v) => v.table_schema === 'public').map((v) => ({ name: v.table_name, def: String(v.view_definition || '').replace(/\\s+/g, ' ').trim() })).sort((a, b) => a.name.localeCompare(b.name));
  const functions = (rowsByKind.functions || []).map((f) => ({ name: f.routine_name, identity: f.identity })).sort((a, b) => String(a.identity).localeCompare(String(b.identity)));
  const triggers = (rowsByKind.triggers || []).filter((t) => t.tgrelid_name !== LEDGER_TABLE).map((t) => ({ name: t.tgname, table: t.tgrelid_name, def: String(t.tgdef || '').replace(/\\s+/g, ' ').trim() })).sort((a, b) => (a.table + '.' + a.name).localeCompare(b.table + '.' + b.name));
  return { tables, columns, constraints, indexes, sequences, views, functions, triggers };
}
function fingerprint(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex');
}
(async () => {
  const dsn = process.env.WOLFHOUSE_DATABASE_URL || '';
  if (!dsn) throw new Error('missing WOLFHOUSE_DATABASE_URL');
  const u = new URL(dsn);
  if (u.hostname !== EXPECTED_HOST || (u.pathname || '').replace(/^\\//, '') !== EXPECTED_DATABASE) {
    throw new Error('wrong_target');
  }
  const sslmode = (u.searchParams.get('sslmode') || '').toLowerCase();
  const ssl = (u.searchParams.get('ssl') || '').toLowerCase();
  if (!(sslmode === 'require' || sslmode === 'verify-ca' || sslmode === 'verify-full' || ssl === 'true' || ssl === '1')) {
    throw new Error('missing_tls');
  }
  const client = new Client({
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    database: EXPECTED_DATABASE,
    ssl: { rejectUnauthorized: false },
    application_name: APPLICATION_NAME,
    options: '-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=5000',
    connectionTimeoutMillis: 20000,
  });
  await client.connect();
  const usedAllowlist = [];
  async function q(key) {
    const sql = INTROSPECTION_SQL[key];
    const gate = assertSqlAllowed(sql);
    if (!gate.ok) throw new Error(gate.code);
    usedAllowlist.push(gate.allowlistId);
    const res = await client.query(sql);
    return { allowlistId: gate.allowlistId, rows: res.rows };
  }
  const tro = await q('show_transaction_read_only');
  const st = await q('show_statement_timeout');
  const lt = await q('show_lock_timeout');
  const an = await q('show_application_name');
  const session = {
    transaction_read_only: tro.rows[0] && tro.rows[0].transaction_read_only,
    statement_timeout: st.rows[0] && st.rows[0].statement_timeout,
    lock_timeout: lt.rows[0] && lt.rows[0].lock_timeout,
    application_name: an.rows[0] && an.rows[0].application_name,
  };
  if (String(session.transaction_read_only).toLowerCase() !== 'on') throw new Error('non_read_only_session');
  if (session.application_name !== APPLICATION_NAME) throw new Error('wrong_application_name');
  const rowsByKind = {
    tables: (await q('tables')).rows,
    columns: (await q('columns')).rows,
    constraints: (await q('constraints')).rows,
    indexes: (await q('indexes')).rows,
    sequences: (await q('sequences')).rows.map((r) => ({ relname: r.relname })),
    views: (await q('views')).rows,
    functions: (await q('functions')).rows,
    triggers: (await q('triggers')).rows,
  };
  const snapshot = buildProductSchemaSnapshot(rowsByKind);
  const reg = await q('ledger_regclass');
  const regclass = reg.rows[0] && reg.rows[0].reg;
  let ledgerRows = [];
  let ledgerMeta = { exists: false, incompatible: false };
  if (regclass) {
    const cols = await q('ledger_columns');
    const names = cols.rows.map((c) => c.column_name);
    const required = ['id', 'filename', 'checksum_sha256', 'apply_order'];
    const missing = required.filter((r) => !names.includes(r));
    if (missing.length) {
      ledgerMeta = { exists: true, incompatible: true, reason: 'ledger missing columns: ' + missing.join(',') };
    } else {
      ledgerMeta = { exists: true, incompatible: false };
      ledgerRows = (await q('ledger_rows')).rows.map((r) => ({
        id: r.id,
        filename: r.filename,
        checksum_sha256: r.checksum_sha256,
        apply_order: r.apply_order,
      }));
    }
  }
  await client.end();
  const out = {
    path: 'containerapp_exec',
    scopeCompliant: true,
    target: { host: EXPECTED_HOST, database: EXPECTED_DATABASE },
    session,
    usedAllowlist: Array.from(new Set(usedAllowlist)),
    fingerprint: fingerprint(snapshot),
    snapshot,
    ledgerMeta,
    ledgerRows,
  };
  process.stdout.write('WH_SCHEMA_DRIFT_BEGIN\\n');
  process.stdout.write(JSON.stringify(out) + '\\n');
  process.stdout.write('WH_SCHEMA_DRIFT_END\\n');
})().catch((e) => {
  process.stderr.write(String(e && e.message ? e.message : e));
  process.exit(1);
});
`;
}

module.exports = {
  EXPECTED_SUBSCRIPTION_ID,
  EXPECTED_RG,
  EXPECTED_PG_SERVER,
  EXPECTED_KV,
  EXPECTED_SECRET_NAME,
  EXPECTED_DATABASE,
  EXPECTED_HOST,
  EXPECTED_STAFF_APP,
  EXPECTED_IMAGE_REPO_PREFIX,
  CA_EXEC_MAX_RETRIES,
  APPLICATION_NAME,
  LEDGER_TABLE,
  SQL_REGISTRY_IDS,
  AZ_COMMAND_SURFACE,
  INTROSPECTION_SQL,
  KNOWN_OBJECT_SECTIONS,
  sha256Text,
  redactSecrets,
  normalizeSql,
  assertSqlAllowed,
  normalizeAzArgv,
  classifyAzCommand,
  assertAzCommandAllowed,
  buildExactCollectorExecCommand,
  buildExactContainerAppExecArgs,
  assertImageIsSunsetStaffApi,
  resolveRunningExecTarget,
  verifyCollectorPayload,
  parseDatabaseUrl,
  assertSunsetStagingTarget,
  assertNoLeakedDsn,
  clientConfigFromDsn,
  buildProductSchemaSnapshot,
  fingerprintProductSchema,
  compareSnapshots,
  classifyLedgerStatus,
  summarizeDrifts,
  assertKnownObjectSection,
  assertReadOnlySession,
  inspectLedgerMeta,
  safeQuery,
  introspectProductSchema,
  introspectLedger,
  verifyLiveSession,
  buildCaCollectorSource,
};
