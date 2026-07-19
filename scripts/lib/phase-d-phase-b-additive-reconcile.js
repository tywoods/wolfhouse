'use strict';

/**
 * phase-d-phase-b-additive-reconcile — FOUNDATION Slice 14S Phase B
 *
 * Default-disabled exact-gated managed-identity live adapter that creates the
 * single missing public.customer_message_templates table (and thereby its 9
 * columns) from byte-locked migration 035 CREATE TABLE SQL.
 *
 * No CREATE INDEX, no COMMENT, no DML, no ledger, no Phase C–G, no migration
 * file mutation, no Azure/KV/RBAC/network beyond MI credential GET.
 *
 * PHASE_D_LIVE_APPLY_ENABLED in check-preflight stays false.
 * This module owns PHASE_D_PHASE_B_ADDITIVE_LIVE_ENABLED + env/argv gates.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  TARGETS,
  ENV_LIVE_READONLY,
  ENV_LIVE_PREFLIGHT,
  ENV_SUBSCRIPTION,
  ENV_CREDENTIAL_SOURCE,
  CLI_CREDENTIAL_SOURCE,
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  evaluateDualEnableFlags,
  evaluateCredentialSource,
  redactDeep,
  redactSecrets,
  normalizeSql,
  AUTHORIZED_TABLE_EXISTS_SQL,
} = require('./phase-d-live-readonly-boundary');
const {
  PHASE_D_LIVE_APPLY_ENABLED,
  sanitizeError,
} = require('./phase-d-check-preflight');
const {
  loadProtectedAdminCredentialsViaManagedIdentity,
  zeroPrivateCredentialRefs,
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
  getManagedIdentityHttpCounters,
  MI_LOADER_LOCKS,
} = require('./phase-d-managed-identity-credential-loader');
const {
  classifyConnectError,
  CONNECT_FAILED_SAFE_MESSAGE,
  buildVerifiedTlsSslConfig,
} = require('./phase-d-live-readonly-pg-adapter');
const {
  introspectProductSchema,
  compareSnapshots,
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
  EXPECTED_HOST,
  EXPECTED_DATABASE,
} = require('./sunset-schema-observer');
const { MIGRATIONS_DIR, sha256CanonicalLfV1File } = require('./migration-integrity');

/** Capability flag for Slice 14S Phase B — still default-disabled via env+argv gates. */
const PHASE_D_PHASE_B_ADDITIVE_LIVE_ENABLED = true;

const ENV_PHASE_B_ADDITIVE = 'SUNSET_PHASE_D_PHASE_B_ADDITIVE';
const CLI_APPLY_PHASE_B_ADDITIVE = '--apply-phase-b-additive';

const APPLICATION_NAME = 'wh-sunset-phase-b-additive';

/** Fixed transaction-scoped advisory lock (not the canonical migration runner pair). */
const ADVISORY_LOCK_KEY1 = 0x57485042; // WHPB
const ADVISORY_LOCK_KEY2 = 0x41444442; // ADDB

const LOCK_TIMEOUT_MS = 5000;
const STATEMENT_TIMEOUT_MS = 30000;
const CONNECTION_TIMEOUT_MS = 20000;

const SCHEMA = 'public';
const TABLE = 'customer_message_templates';
const CLIENTS_TABLE = 'clients';
const FORBIDDEN_INDEX_NAME = 'idx_customer_message_templates_client_active';

const EXPECTED_035_SHA256 = '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565';

/**
 * Exact CREATE TABLE SQL extracted from migration 035 (NO index, NO comment,
 * NO BEGIN/COMMIT). Byte-locked via CREATE_TABLE_SHA256.
 */
const CREATE_TABLE_SQL = [
  'CREATE TABLE IF NOT EXISTS customer_message_templates (',
  '  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),',
  '  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,',
  '  title       TEXT NOT NULL,',
  '  body        TEXT NOT NULL,',
  '  channel     TEXT NOT NULL DEFAULT \'whatsapp\',',
  '  tags        JSONB NOT NULL DEFAULT \'[]\'::jsonb,',
  '  active      BOOLEAN NOT NULL DEFAULT TRUE,',
  '  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),',
  '  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()',
  ');',
].join('\n');

const CREATE_TABLE_SHA256 = '826046e1d5810c28b74945041a02a8c48c84dcc38bec60a98f86a8c67331763b';

/** Must never appear in authorizeApplySql allow-list. */
const FORBIDDEN_CREATE_INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_customer_message_templates_client_active',
  '  ON customer_message_templates (client_id, active, updated_at DESC);',
].join('\n');

const LOCKED_14R_PHASE_B_TABLES = Object.freeze(['customer_message_templates']);

const LOCKED_14R_PHASE_B_COLUMNS = Object.freeze([
  'customer_message_templates.active',
  'customer_message_templates.body',
  'customer_message_templates.channel',
  'customer_message_templates.client_id',
  'customer_message_templates.created_at',
  'customer_message_templates.id',
  'customer_message_templates.tags',
  'customer_message_templates.title',
  'customer_message_templates.updated_at',
]);

const EXPECTED_COLUMN_SEMANTICS = Object.freeze([
  Object.freeze({
    name: 'active', udt: 'bool', nullable: false, default: 'true',
  }),
  Object.freeze({
    name: 'body', udt: 'text', nullable: false, default: null,
  }),
  Object.freeze({
    name: 'channel', udt: 'text', nullable: false, default: "'whatsapp'::text",
  }),
  Object.freeze({
    name: 'client_id', udt: 'uuid', nullable: false, default: null,
  }),
  Object.freeze({
    name: 'created_at', udt: 'timestamptz', nullable: false, default: 'now()',
  }),
  Object.freeze({
    name: 'id', udt: 'uuid', nullable: false, default: 'gen_random_uuid()',
  }),
  Object.freeze({
    name: 'tags', udt: 'jsonb', nullable: false, default: "'[]'::jsonb",
  }),
  Object.freeze({
    name: 'title', udt: 'text', nullable: false, default: null,
  }),
  Object.freeze({
    name: 'updated_at', udt: 'timestamptz', nullable: false, default: 'now()',
  }),
]);

/** Approved public product tables for row-count preservation (expected minus CMT). */
const APPROVED_PUBLIC_TABLES_EXCEPT_CMT = Object.freeze([
  'add_on_items',
  'add_on_orders',
  'auth_sessions',
  'automation_errors',
  'beds',
  'booking_beds',
  'booking_guests',
  'booking_service_records',
  'booking_transfers',
  'bookings',
  'bot_pause_states',
  'client_notification_events',
  'client_notification_settings',
  'clients',
  'conversations',
  'customers',
  'guest_message_events',
  'guest_message_sends',
  'guests',
  'lesson_requests',
  'manual_entries',
  'meal_requests',
  'messages',
  'operator_room_release_requests',
  'package_price_rules',
  'packages',
  'payment_events',
  'payments',
  'rental_requests',
  'rooms',
  'staff_automated_notification_events',
  'staff_automated_notifications',
  'staff_handoffs',
  'staff_phone_access',
  'staff_tasks',
  'staff_users',
  'tenant_config_audit_log',
  'tenant_house_notes',
  'tenant_lesson_capacity_rules',
  'tenant_lesson_time_rules',
  'tenant_price_rules',
  'tenant_private_lesson_rules',
  'tenant_services',
  'tenant_surf_pack_rules',
  'transfer_requests',
  'waiver_form_requests',
  'waiver_form_submissions',
  'wolfhouse_staff_whatsapp_numbers',
  'workflow_events',
  'yoga_requests',
]);

const AUTHORIZED_SEQUENCE = Object.freeze([
  'BEGIN',
  'SET LOCAL lock_timeout',
  'SET LOCAL statement_timeout',
  'pg_advisory_xact_lock',
  'recheck_table_absent',
  'recheck_no_incompatible_name',
  'recheck_clients_exists',
  'capture_existing_row_counts',
  'CREATE TABLE customer_message_templates',
  'verify_table_exists',
  'verify_nine_columns_semantics',
  'verify_row_counts_unchanged',
  'assert_index_absent',
  'COMMIT',
]);

const SET_LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`;
const SET_STATEMENT_TIMEOUT_SQL = `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`;
const ADVISORY_LOCK_SQL = 'SELECT pg_advisory_xact_lock($1, $2)';

const RELKIND_LOOKUP_SQL = [
  'SELECT rel.relkind AS relkind',
  'FROM pg_class rel',
  'JOIN pg_namespace n ON n.oid = rel.relnamespace',
  'WHERE n.nspname = $1',
  '  AND rel.relname = $2',
].join('\n');

const COLUMN_SEMANTICS_SQL = [
  'SELECT',
  '  a.attname AS name,',
  '  t.typname AS udt_name,',
  '  NOT a.attnotnull AS is_nullable,',
  '  pg_get_expr(ad.adbin, ad.adrelid) AS column_default',
  'FROM pg_attribute a',
  'JOIN pg_type t ON t.oid = a.atttypid',
  'JOIN pg_class rel ON rel.oid = a.attrelid',
  'JOIN pg_namespace n ON n.oid = rel.relnamespace',
  'LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum',
  'WHERE n.nspname = $1',
  '  AND rel.relname = $2',
  '  AND a.attnum > 0',
  '  AND NOT a.attisdropped',
  '  AND a.attname = ANY($3::text[])',
  'ORDER BY a.attname',
].join('\n');

const INDEX_ABSENCE_SQL = [
  'SELECT i.relname AS index_name',
  'FROM pg_index x',
  'JOIN pg_class i ON i.oid = x.indexrelid',
  'JOIN pg_class t ON t.oid = x.indrelid',
  'JOIN pg_namespace n ON n.oid = t.relnamespace',
  'WHERE n.nspname = $1',
  '  AND t.relname = $2',
  '  AND i.relname = $3',
].join('\n');

const ROW_COUNT_SQL = APPROVED_PUBLIC_TABLES_EXCEPT_CMT.map((t, i) => {
  const head = i === 0
    ? `SELECT '${t}'::text AS name, COUNT(*)::bigint AS n FROM public.${t}`
    : `UNION ALL SELECT '${t}'::text, COUNT(*)::bigint FROM public.${t}`;
  return head;
}).join('\n') + '\nORDER BY 1';

const APPLY_LOCKS = Object.freeze({
  subscriptionId: TARGETS.subscriptionId,
  resourceGroup: TARGETS.resourceGroup,
  postgresServer: TARGETS.postgresServer,
  postgresHost: TARGETS.postgresHost,
  database: TARGETS.database,
  port: TARGETS.port,
  sslmode: 'verify-full',
  applicationName: APPLICATION_NAME,
  advisoryLockKey1: ADVISORY_LOCK_KEY1,
  advisoryLockKey2: ADVISORY_LOCK_KEY2,
  lockTimeoutMs: LOCK_TIMEOUT_MS,
  statementTimeoutMs: STATEMENT_TIMEOUT_MS,
  migration035Sha256: EXPECTED_035_SHA256,
  createTableSha256: CREATE_TABLE_SHA256,
  table: TABLE,
  schema: SCHEMA,
  forbiddenIndexName: FORBIDDEN_INDEX_NAME,
  lockedPhaseBTables: LOCKED_14R_PHASE_B_TABLES,
  lockedPhaseBColumns: LOCKED_14R_PHASE_B_COLUMNS,
  managedIdentityName: MI_LOADER_LOCKS.managedIdentityName,
  keyVaultName: MI_LOADER_LOCKS.keyVaultName,
  secretName: MI_LOADER_LOCKS.secretName,
});

const FORBIDDEN_ARGV_FLAGS = Object.freeze([
  '--dsn',
  '--connection-string',
  '--database-url',
  '--host',
  '--port',
  '--user',
  '--password',
  '--username',
  '--query',
  '--sql',
  '--sslmode',
  '--url',
  '--execute-count-only',
  '--apply-phase-d-constraints',
  '--drop',
  '--delete',
  '--retry',
  '--retries',
  '--force',
  '--rollback',
  '--ledger',
  '--repair',
  '--dml',
]);

const ALLOWED_ARGV_FLAGS = Object.freeze([
  CLI_APPLY_PHASE_B_ADDITIVE,
  '--subscription',
  '--resource-group',
  '--postgres-server',
  '--database',
  CLI_CREDENTIAL_SOURCE,
  '--help',
  '-h',
]);

const SAFE_OUTPUT_KEYS = Object.freeze([
  'ok',
  'code',
  'applyPhaseBAdditive',
  'liveApplyEnabled',
  'phaseBAdditiveLiveEnabled',
  'liveHttpEnabled',
  'liveMutation',
  'schemaMutation',
  'dataMutation',
  'ledgerWritten',
  'writesLedger',
  'usedLiveHttp',
  'realImdsCall',
  'realKeyVaultCall',
  'realPostgresCall',
  'clientsInstantiated',
  'connectCalls',
  'queryCalls',
  'endCalls',
  'httpRequestCount',
  'imdsRequestCount',
  'keyVaultRequestCount',
  'steps',
  'authorizedSequence',
  'beforeAdditive',
  'afterAdditive',
  'derivedPhaseBSet',
  'rowCountPreservation',
  'createTableSha256',
  'migration035Sha256',
  'migration035Sha256CanonicalLfV1',
  'rolledBack',
  'committed',
  'closed',
  'subscriptionId',
  'resourceGroup',
  'postgresServer',
  'postgresHost',
  'database',
  'sslmode',
  'applicationName',
  'credentialSource',
  'managedIdentityName',
  'keyVaultName',
  'secretName',
  'safety',
  'preflight',
  'errors',
  'message',
  'note',
  'blocker',
  'connectCategory',
  'privateRefsZeroed',
  'indexAbsent',
  'forbiddenIndexName',
]);

const EXPECTED_SCHEMA_PATH = path.join(
  __dirname,
  '..',
  '..',
  'fixtures',
  'sunset-schema-observer',
  'expected-product-schema.json',
);

let applyPgClientInstantiateCount = 0;
let applyQueryCallCount = 0;

function getPhaseBAdditiveCounters() {
  return {
    clientsInstantiated: applyPgClientInstantiateCount,
    queryCalls: applyQueryCallCount,
    httpRequestCount: getManagedIdentityHttpCounters().httpRequestCount,
    imdsRequestCount: getManagedIdentityHttpCounters().imdsRequestCount,
    keyVaultRequestCount: getManagedIdentityHttpCounters().keyVaultRequestCount,
  };
}

function resetPhaseBAdditiveCounters() {
  applyPgClientInstantiateCount = 0;
  applyQueryCallCount = 0;
}

function parseArgvPairs(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const flags = new Set();
  const values = {};
  const unknown = [];
  const forbidden = [];

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('-')) {
      unknown.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    let flag = a;
    let val = null;
    if (eq > 0) {
      flag = a.slice(0, eq);
      val = a.slice(eq + 1);
    }
    if (FORBIDDEN_ARGV_FLAGS.includes(flag)) {
      forbidden.push(flag);
      if (val == null && i + 1 < args.length && !args[i + 1].startsWith('-')) i += 1;
      continue;
    }
    if (flag === CLI_APPLY_PHASE_B_ADDITIVE || flag === '--help' || flag === '-h') {
      flags.add(flag);
      continue;
    }
    if (ALLOWED_ARGV_FLAGS.includes(flag)) {
      if (val == null) {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
          unknown.push(flag);
          continue;
        }
        val = args[i + 1];
        i += 1;
      }
      values[flag] = val;
      flags.add(flag);
      continue;
    }
    unknown.push(flag);
    if (val == null && i + 1 < args.length && !args[i + 1].startsWith('-')) i += 1;
  }

  return { flags, values, unknown, forbidden };
}

function evaluatePhaseBAdditiveGates(opts) {
  const options = opts || {};
  const env = options.env || {};
  const argv = Array.isArray(options.argv) ? options.argv.map(String) : [];
  const errors = [];

  if (PHASE_D_PHASE_B_ADDITIVE_LIVE_ENABLED !== true) {
    errors.push({
      code: 'phase_b_additive_capability_disabled',
      message: 'phase B additive capability is disabled',
    });
  }
  if (PHASE_D_LIVE_APPLY_ENABLED === true) {
    errors.push({
      code: 'global_live_apply_must_remain_false',
      message: 'PHASE_D_LIVE_APPLY_ENABLED must remain false (count-only path)',
    });
  }

  const dual = evaluateDualEnableFlags(env);
  if (!dual.ok) errors.push(...dual.errors);

  if (String(env[ENV_PHASE_B_ADDITIVE] || '') !== '1') {
    errors.push({
      code: 'phase_b_additive_env_required',
      message: `env ${ENV_PHASE_B_ADDITIVE}=1 is required`,
    });
  }

  const parsed = parseArgvPairs(argv);
  if (parsed.forbidden.length) {
    errors.push({
      code: 'forbidden_argv',
      message: `forbidden argv: ${parsed.forbidden.join(',')}`,
      flags: parsed.forbidden.slice(),
    });
  }
  if (parsed.unknown.length) {
    errors.push({
      code: 'unknown_argv',
      message: `unknown argv: ${parsed.unknown.join(',')}`,
      flags: parsed.unknown.slice(),
    });
  }
  if (!parsed.flags.has(CLI_APPLY_PHASE_B_ADDITIVE)) {
    errors.push({
      code: 'phase_b_additive_flag_required',
      message: `${CLI_APPLY_PHASE_B_ADDITIVE} is required`,
    });
  }

  const expected = {
    '--subscription': TARGETS.subscriptionId,
    '--resource-group': TARGETS.resourceGroup,
    '--postgres-server': TARGETS.postgresServer,
    '--database': TARGETS.database,
  };
  for (const [flag, want] of Object.entries(expected)) {
    const got = parsed.values[flag];
    if (got !== want) {
      errors.push({
        code: 'exact_target_mismatch',
        message: `${flag} must equal locked target`,
        flag,
      });
    }
  }

  const cred = evaluateCredentialSource({ env, argv });
  if (!cred.ok || cred.source !== CREDENTIAL_SOURCE_MANAGED_IDENTITY) {
    errors.push({
      code: 'managed_identity_credential_source_flag_required',
      message: `explicit ${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY} and ${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY} required`,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    applyPhaseBAdditive: parsed.flags.has(CLI_APPLY_PHASE_B_ADDITIVE)
      && String(env[ENV_PHASE_B_ADDITIVE] || '') === '1',
    credentialSource: cred.source,
    parsed,
  };
}

function buildApplyConnectConfig(user, password) {
  return {
    host: TARGETS.postgresHost,
    port: TARGETS.port,
    database: TARGETS.database,
    sslmode: 'verify-full',
    application_name: APPLICATION_NAME,
    _user: String(user),
    _password: String(password),
  };
}

function assertApplyConnectConfig(connectConfig) {
  const c = connectConfig || {};
  const errors = [];
  if (String(c.host || '') !== TARGETS.postgresHost) {
    errors.push({ code: 'wrong_host', message: 'host mismatch' });
  }
  if (String(c.database || '') !== TARGETS.database) {
    errors.push({ code: 'wrong_database', message: 'database mismatch' });
  }
  if (String(c.sslmode || '') !== 'verify-full') {
    errors.push({ code: 'tls_not_verify_full', message: 'sslmode must be verify-full' });
  }
  if (String(c.application_name || '') !== APPLICATION_NAME) {
    errors.push({
      code: 'wrong_application_name',
      message: `application_name must be ${APPLICATION_NAME}`,
    });
  }
  if (Number(c.port) !== TARGETS.port) {
    errors.push({ code: 'wrong_port', message: 'port mismatch' });
  }
  if (!c._user || !c._password) {
    errors.push({ code: 'credential_source_missing', message: 'user/password required' });
  }
  return { ok: errors.length === 0, errors };
}

function buildApplyPgClientConfig(lockedConnectConfig, opts) {
  const options = opts || {};
  if (options.connectionString != null
    || options.dsn != null
    || options.databaseUrl != null
    || options.host != null
    || options.database != null
    || options.sql != null
    || options.query != null) {
    throw Object.assign(
      new Error('caller-supplied DSN / host / database / query forbidden'),
      { code: 'caller_supplied_connect_forbidden' },
    );
  }
  const gate = assertApplyConnectConfig(lockedConnectConfig);
  if (!gate.ok) {
    throw Object.assign(new Error('apply connect config rejected'), {
      code: 'credential_target_rejected',
      errors: gate.errors,
    });
  }
  const c = lockedConnectConfig;
  return {
    host: TARGETS.postgresHost,
    port: TARGETS.port,
    database: TARGETS.database,
    user: String(c._user),
    password: String(c._password),
    application_name: APPLICATION_NAME,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    ssl: buildVerifiedTlsSslConfig(),
  };
}

function assertCreateTableByteLocked() {
  const got = crypto.createHash('sha256').update(CREATE_TABLE_SQL, 'utf8').digest('hex');
  if (got !== CREATE_TABLE_SHA256) {
    throw Object.assign(new Error('CREATE TABLE statement sha256 drift'), {
      code: 'create_table_hash_drift',
    });
  }
  const migPath = path.join(MIGRATIONS_DIR, '035_customer_message_templates.sql');
  const live035 = sha256CanonicalLfV1File(migPath);
  if (live035 !== EXPECTED_035_SHA256) {
    throw Object.assign(new Error('035 checksum drift'), {
      code: 'migration_035_checksum_mismatch',
    });
  }
  const raw = fs.readFileSync(migPath, 'utf8');
  if (!raw.includes('CREATE TABLE IF NOT EXISTS customer_message_templates')) {
    throw Object.assign(new Error('035 missing CREATE TABLE customer_message_templates'), {
      code: 'migration_035_create_table_missing',
    });
  }
  if (CREATE_TABLE_SQL.includes('CREATE INDEX') || CREATE_TABLE_SQL.includes('COMMENT ON')) {
    throw Object.assign(new Error('CREATE TABLE SQL must not include INDEX or COMMENT'), {
      code: 'create_table_includes_forbidden',
    });
  }
  return {
    migration035Sha256CanonicalLfV1: EXPECTED_035_SHA256,
    createTableSha256: CREATE_TABLE_SHA256,
  };
}

/**
 * From compareSnapshots drifts, collect expected_only tables + columns.
 */
function derivePhaseBAdditiveSet(compareResult) {
  const drifts = (compareResult && compareResult.drifts) || [];
  const tables = [];
  const columns = [];
  for (const d of drifts) {
    if (!d || d.kind !== 'expected_only') continue;
    if (d.section === 'tables') tables.push(String(d.key));
    if (d.section === 'columns') columns.push(String(d.key));
  }
  tables.sort();
  columns.sort();
  const matches14R = tables.length === LOCKED_14R_PHASE_B_TABLES.length
    && columns.length === LOCKED_14R_PHASE_B_COLUMNS.length
    && LOCKED_14R_PHASE_B_TABLES.every((t, i) => t === tables[i])
    && LOCKED_14R_PHASE_B_COLUMNS.every((c, i) => c === columns[i]);
  return {
    tables,
    columns,
    matches14R,
  };
}

/**
 * Stop (zero mutation) when Phase B set / safety gates fail.
 */
function evaluatePhaseBSafety(preflight) {
  const p = preflight || {};
  const errors = [];
  const derived = p.derived || derivePhaseBAdditiveSet(p.compareResult);

  if (!derived.matches14R) {
    errors.push({
      code: 'phase_b_set_drift',
      message: 'derived Phase B additive set does not match locked 14R set',
      derivedTables: derived.tables.slice(),
      derivedColumns: derived.columns.slice(),
    });
  }

  if (p.unsafeNonemptyNotNull === true) {
    errors.push({
      code: 'unsafe_nonempty_not_null',
      message: 'missing NOT NULL column on nonempty existing table without safe default path',
    });
  }

  if (p.volatileDefaultRewriteRisk === true) {
    errors.push({
      code: 'volatile_default_rewrite_risk',
      message: 'unbounded volatile default / rewrite risk on nonempty table',
    });
  }

  if (p.cmtTableExists === true) {
    errors.push({
      code: 'table_already_exists',
      message: 'customer_message_templates already exists — refuse CREATE',
    });
  }

  if (p.cmtRelkind != null && p.cmtRelkind !== '' && p.cmtRelkind !== 'r') {
    errors.push({
      code: 'incompatible_same_name_object',
      message: `same-name object exists with relkind=${p.cmtRelkind}`,
      relkind: p.cmtRelkind,
    });
  }

  if (p.clientsExists !== true) {
    errors.push({
      code: 'clients_dependency_missing',
      message: 'public.clients dependency table missing',
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    derived,
    newTablePath: true,
    safeForEmptyNewTable: errors.length === 0,
  };
}

function normalizeDefaultExpr(def) {
  if (def == null || def === '') return null;
  return String(def)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/::[a-z0-9_ ]+/g, (m) => m.replace(/\s+/g, ' '));
}

function semanticDefaultMatch(expected, live) {
  const e = normalizeDefaultExpr(expected);
  const l = normalizeDefaultExpr(live);
  if (e === l) return true;
  if (e == null && l == null) return true;
  if (e == null || l == null) return false;
  // PG rewrites: now() ↔ current_timestamp; true ↔ 'true'::boolean
  if ((e === 'now()' || e === 'current_timestamp')
    && (l === 'now()' || l === 'current_timestamp' || l === "('now'::text)::timestamp with time zone")) {
    return true;
  }
  if (e === 'true' && (l === 'true' || l === "'t'::boolean" || l === 'true::boolean')) {
    return true;
  }
  if (e === 'gen_random_uuid()' && l.includes('gen_random_uuid')) return true;
  if (e.includes('whatsapp') && l.includes('whatsapp')) return true;
  if (e.includes("'[]'") && l.includes("'[]'")) return true;
  return false;
}

function validateNineColumnSemantics(rows) {
  const byName = new Map((rows || []).map((r) => [r.name, r]));
  for (const expected of EXPECTED_COLUMN_SEMANTICS) {
    const row = byName.get(expected.name);
    if (!row) {
      throw Object.assign(new Error(`missing column ${expected.name}`), {
        code: 'column_missing',
        column: expected.name,
      });
    }
    if (row.udt_name !== expected.udt) {
      throw Object.assign(new Error(`column ${expected.name} incompatible type`), {
        code: 'column_type_mismatch',
        column: expected.name,
      });
    }
    const liveNullable = row.is_nullable === true || row.is_nullable === 't';
    if (liveNullable !== Boolean(expected.nullable)) {
      throw Object.assign(new Error(`column ${expected.name} incompatible nullability`), {
        code: 'column_nullability_mismatch',
        column: expected.name,
      });
    }
    if (!semanticDefaultMatch(expected.default, row.column_default)) {
      throw Object.assign(new Error(`column ${expected.name} incompatible default`), {
        code: 'column_default_mismatch',
        column: expected.name,
      });
    }
  }
  return {
    ok: true,
    table: `${SCHEMA}.${TABLE}`,
    columns: EXPECTED_COLUMN_SEMANTICS.map((c) => ({ ...c })),
  };
}

function authorizeApplySql(sql) {
  const n = normalizeSql(sql);
  // Hard reject forbidden patterns even if somehow listed.
  // Note: do NOT match "ON DELETE CASCADE" inside CREATE TABLE FK clauses.
  const upper = n.toUpperCase();
  if (/\bDROP\b/.test(upper)
    || /(^|\s)DELETE\s+FROM\b/.test(upper)
    || /(^|\s)UPDATE\s+\S/.test(upper)
    || /(^|\s)INSERT\s+INTO\b/.test(upper)
    || /\bCREATE\s+INDEX\b/.test(upper)
    || /\bCOMMENT\s+ON\b/.test(upper)
    || /\bSET\s+NOT\s+NULL\b/.test(upper)
    || /\bTRUNCATE\b/.test(upper)
    || /\bALTER\s+TABLE\b/.test(upper)) {
    throw Object.assign(
      new Error('unauthorized SQL rejected: DROP/DML/INDEX/COMMENT/ALTER forbidden'),
      { code: 'unauthorized_sql' },
    );
  }
  if (n === normalizeSql(FORBIDDEN_CREATE_INDEX_SQL)
    || (n.includes(FORBIDDEN_INDEX_NAME.toLowerCase()) && /\bCREATE\s+INDEX\b/.test(upper))) {
    throw Object.assign(
      new Error('unauthorized SQL rejected: CREATE INDEX forbidden in Phase B'),
      { code: 'unauthorized_sql' },
    );
  }

  const allowed = [
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    SET_LOCK_TIMEOUT_SQL,
    SET_STATEMENT_TIMEOUT_SQL,
    ADVISORY_LOCK_SQL,
    AUTHORIZED_TABLE_EXISTS_SQL,
    RELKIND_LOOKUP_SQL,
    COLUMN_SEMANTICS_SQL,
    INDEX_ABSENCE_SQL,
    ROW_COUNT_SQL,
    CREATE_TABLE_SQL,
  ];
  for (const a of allowed) {
    if (n === normalizeSql(a)) return a;
  }
  throw Object.assign(
    new Error('unauthorized SQL rejected: only locked Phase B additive SQL permitted'),
    { code: 'unauthorized_sql' },
  );
}

function classifyApplyStep(sql) {
  const n = normalizeSql(sql);
  if (n === normalizeSql('BEGIN')) return 'BEGIN';
  if (n === normalizeSql('COMMIT')) return 'COMMIT';
  if (n === normalizeSql('ROLLBACK')) return 'ROLLBACK';
  if (n === normalizeSql(SET_LOCK_TIMEOUT_SQL)) return 'SET LOCAL lock_timeout';
  if (n === normalizeSql(SET_STATEMENT_TIMEOUT_SQL)) return 'SET LOCAL statement_timeout';
  if (n === normalizeSql(ADVISORY_LOCK_SQL)) return 'pg_advisory_xact_lock';
  if (n === normalizeSql(AUTHORIZED_TABLE_EXISTS_SQL)) {
    // Disambiguated by call order / params in sequence runner; fake client uses step index.
    return 'table_exists_catalog';
  }
  if (n === normalizeSql(RELKIND_LOOKUP_SQL)) return 'recheck_no_incompatible_name';
  if (n === normalizeSql(ROW_COUNT_SQL)) return 'row_counts';
  if (n === normalizeSql(CREATE_TABLE_SQL)) return 'CREATE TABLE customer_message_templates';
  if (n === normalizeSql(COLUMN_SEMANTICS_SQL)) return 'verify_nine_columns_semantics';
  if (n === normalizeSql(INDEX_ABSENCE_SQL)) return 'assert_index_absent';
  return 'unauthorized';
}

/**
 * Map a table_exists_catalog query to the named sequence step using params.
 */
function classifyTableExistsStep(params, priorSteps) {
  const schema = params && params[0];
  const rel = params && params[1];
  if (schema === SCHEMA && rel === TABLE) {
    if (priorSteps.includes('CREATE TABLE customer_message_templates')) {
      return 'verify_table_exists';
    }
    return 'recheck_table_absent';
  }
  if (schema === SCHEMA && rel === CLIENTS_TABLE) return 'recheck_clients_exists';
  return 'table_exists_catalog';
}

function classifyRowCountsStep(priorSteps) {
  if (priorSteps.includes('CREATE TABLE customer_message_templates')) {
    return 'verify_row_counts_unchanged';
  }
  return 'capture_existing_row_counts';
}

async function runCatalogPreflightIntrospect(client, opts) {
  const options = opts || {};
  if (options.injectedPreflight) {
    const inj = options.injectedPreflight;
    const derived = inj.derived || derivePhaseBAdditiveSet(inj.compareResult);
    return {
      ...inj,
      derived,
      azureContextVerified: inj.azureContextVerified !== false,
      fromInjection: true,
    };
  }

  const expected = JSON.parse(fs.readFileSync(EXPECTED_SCHEMA_PATH, 'utf8'));
  const product = await introspectProductSchema(client);
  const azureContext = {
    verified: true,
    host: EXPECTED_HOST,
    database: EXPECTED_DATABASE,
  };
  const compareResult = compareSnapshots(expected.snapshot, product.snapshot, {
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext,
  });
  if (compareResult.normalizationError) {
    throw Object.assign(new Error('normalization failed'), {
      code: compareResult.normalizationError.code || 'normalization_failed',
    });
  }

  const tableRes = await client.query(AUTHORIZED_TABLE_EXISTS_SQL, [SCHEMA, TABLE]);
  const cmtTableExists = tableRes && tableRes.rowCount === 1;
  const relRes = await client.query(RELKIND_LOOKUP_SQL, [SCHEMA, TABLE]);
  const cmtRelkind = relRes && relRes.rows && relRes.rows[0]
    ? String(relRes.rows[0].relkind)
    : null;
  const clientsRes = await client.query(AUTHORIZED_TABLE_EXISTS_SQL, [SCHEMA, CLIENTS_TABLE]);
  const clientsExists = clientsRes && clientsRes.rowCount === 1;

  const derived = derivePhaseBAdditiveSet(compareResult);
  return {
    compareResult: {
      ok: compareResult.ok === true,
      counts: compareResult.counts,
      drifts: (compareResult.drifts || []).filter((d) =>
        d.kind === 'expected_only'
        && (d.section === 'tables' || d.section === 'columns')),
    },
    derived,
    cmtTableExists,
    cmtRelkind: cmtTableExists ? 'r' : cmtRelkind,
    clientsExists,
    azureContextVerified: true,
    unsafeNonemptyNotNull: false,
    volatileDefaultRewriteRisk: false,
    fromInjection: false,
  };
}

async function runAuthorizedPhaseBAdditiveSequence(client, opts) {
  const options = opts || {};
  const secrets = (options.secrets || []).filter(Boolean);
  const steps = [];
  let began = false;
  let committed = false;
  let rolledBack = false;
  let beforeCounts = null;
  let afterCounts = null;
  let columnSemantics = null;
  let indexAbsent = false;

  if (options.sql != null
    || options.query != null
    || options.host != null
    || options.database != null
    || options.dsn != null) {
    throw Object.assign(new Error('caller-supplied SQL / host / database / DSN forbidden'), {
      code: 'caller_supplied_query_forbidden',
    });
  }

  const hashes = assertCreateTableByteLocked();

  async function q(sql, params) {
    authorizeApplySql(sql);
    applyQueryCallCount += 1;
    if (params === undefined) return client.query(sql);
    return client.query(sql, params);
  }

  try {
    await q('BEGIN');
    began = true;
    steps.push('BEGIN');

    await q(SET_LOCK_TIMEOUT_SQL);
    steps.push('SET LOCAL lock_timeout');

    await q(SET_STATEMENT_TIMEOUT_SQL);
    steps.push('SET LOCAL statement_timeout');

    await q(ADVISORY_LOCK_SQL, [ADVISORY_LOCK_KEY1, ADVISORY_LOCK_KEY2]);
    steps.push('pg_advisory_xact_lock');

    const absent = await q(AUTHORIZED_TABLE_EXISTS_SQL, [SCHEMA, TABLE]);
    steps.push('recheck_table_absent');
    if (absent && absent.rowCount !== 0) {
      throw Object.assign(new Error('customer_message_templates unexpectedly present'), {
        code: 'table_already_exists',
      });
    }

    const relkind = await q(RELKIND_LOOKUP_SQL, [SCHEMA, TABLE]);
    steps.push('recheck_no_incompatible_name');
    if (relkind && relkind.rowCount > 0) {
      throw Object.assign(new Error('incompatible same-name object'), {
        code: 'incompatible_same_name_object',
        relkind: relkind.rows[0].relkind,
      });
    }

    const clients = await q(AUTHORIZED_TABLE_EXISTS_SQL, [SCHEMA, CLIENTS_TABLE]);
    steps.push('recheck_clients_exists');
    if (!clients || clients.rowCount !== 1) {
      throw Object.assign(new Error('public.clients missing'), {
        code: 'clients_dependency_missing',
      });
    }

    const beforeRes = await q(ROW_COUNT_SQL);
    steps.push('capture_existing_row_counts');
    beforeCounts = (beforeRes.rows || []).map((r) => ({
      name: r.name,
      n: Number(r.n),
    }));
    if (beforeCounts.length !== APPROVED_PUBLIC_TABLES_EXCEPT_CMT.length) {
      throw Object.assign(new Error('row count capture shape mismatch'), {
        code: 'row_count_shape_error',
      });
    }

    await q(CREATE_TABLE_SQL);
    steps.push('CREATE TABLE customer_message_templates');

    const exists = await q(AUTHORIZED_TABLE_EXISTS_SQL, [SCHEMA, TABLE]);
    steps.push('verify_table_exists');
    if (!exists || exists.rowCount !== 1) {
      throw Object.assign(new Error('table missing after CREATE'), {
        code: 'table_missing_after_create',
      });
    }

    const colRes = await q(
      COLUMN_SEMANTICS_SQL,
      [SCHEMA, TABLE, EXPECTED_COLUMN_SEMANTICS.map((c) => c.name)],
    );
    steps.push('verify_nine_columns_semantics');
    columnSemantics = validateNineColumnSemantics(colRes.rows);

    const afterRes = await q(ROW_COUNT_SQL);
    steps.push('verify_row_counts_unchanged');
    afterCounts = (afterRes.rows || []).map((r) => ({
      name: r.name,
      n: Number(r.n),
    }));
    const beforeMap = new Map(beforeCounts.map((r) => [r.name, r.n]));
    for (const row of afterCounts) {
      if (beforeMap.get(row.name) !== row.n) {
        throw Object.assign(new Error(`row count changed for ${row.name}`), {
          code: 'row_count_changed',
          table: row.name,
        });
      }
    }

    const idxRes = await q(INDEX_ABSENCE_SQL, [SCHEMA, TABLE, FORBIDDEN_INDEX_NAME]);
    steps.push('assert_index_absent');
    if (idxRes && idxRes.rowCount !== 0) {
      throw Object.assign(new Error('forbidden index unexpectedly present'), {
        code: 'forbidden_index_present',
      });
    }
    indexAbsent = true;

    await q('COMMIT');
    committed = true;
    steps.push('COMMIT');

    return redactDeep({
      ok: true,
      code: 'phase_b_additive_reconcile_ok',
      steps: steps.slice(),
      authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
      beforeAdditive: {
        tables: [],
        columns: [],
      },
      afterAdditive: {
        tables: [TABLE],
        columns: LOCKED_14R_PHASE_B_COLUMNS.slice(),
      },
      rowCountPreservation: {
        unchanged: true,
        tableCount: beforeCounts.length,
        beforeSample: beforeCounts.slice(0, 3),
        afterSample: afterCounts.slice(0, 3),
      },
      columnSemantics,
      indexAbsent,
      forbiddenIndexName: FORBIDDEN_INDEX_NAME,
      ...hashes,
      createTableSha256: CREATE_TABLE_SHA256,
      migration035Sha256: EXPECTED_035_SHA256,
      readOnly: false,
      mutates: true,
      schemaMutation: true,
      dataMutation: false,
      writesLedger: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      phaseBAdditiveLiveEnabled: PHASE_D_PHASE_B_ADDITIVE_LIVE_ENABLED === true,
      applicationName: APPLICATION_NAME,
    }, secrets);
  } catch (e) {
    if (began && !committed) {
      try {
        authorizeApplySql('ROLLBACK');
        applyQueryCallCount += 1;
        await client.query('ROLLBACK');
        rolledBack = true;
        steps.push('ROLLBACK');
      } catch (_) {
        /* ignore */
      }
    }
    const known = new Set([
      'unauthorized_sql',
      'caller_supplied_query_forbidden',
      'table_already_exists',
      'incompatible_same_name_object',
      'clients_dependency_missing',
      'row_count_shape_error',
      'row_count_changed',
      'table_missing_after_create',
      'column_missing',
      'column_type_mismatch',
      'column_nullability_mismatch',
      'column_default_mismatch',
      'forbidden_index_present',
      'create_table_hash_drift',
      'migration_035_checksum_mismatch',
      'lock_timeout',
      'query_failed',
      'commit_failed',
    ]);
    let err = e;
    if (!(e && e.code && known.has(e.code))) {
      err = sanitizeError(e, (e && e.code) || 'query_failed');
    }
    const safe = redactDeep({
      ok: false,
      code: err.code || 'query_failed',
      message: redactSecrets(String(err.message || 'phase B additive failed'), secrets),
      steps: steps.slice(),
      rolledBack,
      committed: false,
      mutates: false,
      schemaMutation: false,
      dataMutation: false,
      writesLedger: false,
      liveApplyEnabled: false,
      phaseBAdditiveLiveEnabled: PHASE_D_PHASE_B_ADDITIVE_LIVE_ENABLED === true,
    }, secrets);
    throw Object.assign(new Error(safe.message), { code: safe.code, result: safe });
  }
}

function instantiateApplyPgClient(clientConfig, deps) {
  const d = deps || {};
  applyPgClientInstantiateCount += 1;
  let ClientCtor = d.Client;
  if (!ClientCtor) {
    if (PHASE_D_PHASE_B_ADDITIVE_LIVE_ENABLED !== true) {
      throw Object.assign(new Error('phase B additive live capability disabled'), {
        code: 'phase_b_additive_capability_disabled',
      });
    }
    // eslint-disable-next-line global-require
    ClientCtor = require('pg').Client;
  }
  return new ClientCtor(clientConfig);
}

async function closeClientQuietly(client, secrets) {
  if (!client || typeof client.end !== 'function') {
    return { closed: false, closeError: null, attempted: false };
  }
  try {
    await client.end();
    return { closed: true, closeError: null, attempted: true };
  } catch (e) {
    return {
      closed: false,
      attempted: true,
      closeError: redactSecrets(
        String((e && e.message) || e || 'close failed').slice(0, 240),
        secrets || [],
      ),
    };
  }
}

function pickSafePhaseBAdditiveOutput(result) {
  const src = result || {};
  const out = {};
  for (const k of SAFE_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  }
  return redactDeep(out, []);
}

function defaultRowCountRows() {
  return APPROVED_PUBLIC_TABLES_EXCEPT_CMT.map((name) => ({ name, n: 0 }));
}

/**
 * Scripted fake Client for offline 14S proof — exact injected transaction sequence.
 */
function createScriptedPhaseBFakeClient(script) {
  const s = script || {};
  const expected = (s.expectedSteps || AUTHORIZED_SEQUENCE).slice();
  const calls = [];
  let stepIndex = 0;
  let connected = false;
  let ended = false;
  const responses = s.responses || {};
  const priorSteps = [];

  function nextExpected() {
    return expected[stepIndex] || null;
  }

  function resolveKind(sql, params) {
    let kind = classifyApplyStep(sql);
    if (kind === 'table_exists_catalog') {
      kind = classifyTableExistsStep(params, priorSteps);
    } else if (kind === 'row_counts') {
      kind = classifyRowCountsStep(priorSteps);
    }
    return kind;
  }

  const client = {
    calls,
    async connect() {
      calls.push({ method: 'connect' });
      if (s.connectError) {
        throw s.connectError instanceof Error
          ? s.connectError
          : Object.assign(new Error(String(s.connectError)), { code: 'connect_failed' });
      }
      connected = true;
    },
    async query(sql, params) {
      calls.push({
        method: 'query',
        sql: String(sql),
        params: params === undefined ? null : params,
      });
      if (!connected || ended) {
        throw Object.assign(new Error('not connected'), { code: 'query_failed' });
      }
      const kind = resolveKind(sql, params);
      if (s.strictSequence !== false) {
        const exp = nextExpected();
        if (kind === 'ROLLBACK') {
          if (exp === 'COMMIT') stepIndex += 1;
        } else if (kind !== exp) {
          throw Object.assign(
            new Error(`wrong/reordered/extra SQL rejected: got ${kind}, expected ${exp}`),
            { code: 'unauthorized_sql' },
          );
        } else {
          stepIndex += 1;
        }
      }
      if (s.queryErrorAt && s.queryErrorAt[kind]) {
        const qe = s.queryErrorAt[kind];
        throw qe instanceof Error
          ? qe
          : Object.assign(new Error(String(qe)), { code: 'query_failed' });
      }
      if (kind === 'BEGIN' || kind === 'COMMIT' || kind === 'ROLLBACK'
        || kind === 'SET LOCAL lock_timeout' || kind === 'SET LOCAL statement_timeout'
        || kind === 'pg_advisory_xact_lock') {
        return { rows: [], rowCount: 0 };
      }
      if (kind === 'CREATE TABLE customer_message_templates') {
        priorSteps.push(kind);
        return { rows: [], rowCount: 0 };
      }
      if (kind === 'recheck_table_absent') {
        priorSteps.push(kind);
        return responses.recheckTableAbsent || { rows: [], rowCount: 0 };
      }
      if (kind === 'recheck_no_incompatible_name') {
        priorSteps.push(kind);
        return responses.recheckNoIncompatibleName || { rows: [], rowCount: 0 };
      }
      if (kind === 'recheck_clients_exists') {
        priorSteps.push(kind);
        return responses.recheckClientsExists || { rows: [{ '?column?': 1 }], rowCount: 1 };
      }
      if (kind === 'capture_existing_row_counts') {
        priorSteps.push(kind);
        const rows = responses.rowCountsBefore || defaultRowCountRows();
        return { rows, rowCount: rows.length };
      }
      if (kind === 'verify_table_exists') {
        priorSteps.push(kind);
        return responses.verifyTableExists || { rows: [{ '?column?': 1 }], rowCount: 1 };
      }
      if (kind === 'verify_nine_columns_semantics') {
        priorSteps.push(kind);
        return responses.columnSemantics || {
          rows: EXPECTED_COLUMN_SEMANTICS.map((c) => ({
            name: c.name,
            udt_name: c.udt,
            is_nullable: c.nullable,
            column_default: c.default,
          })),
          rowCount: EXPECTED_COLUMN_SEMANTICS.length,
        };
      }
      if (kind === 'verify_row_counts_unchanged') {
        priorSteps.push(kind);
        const rows = responses.rowCountsAfter || responses.rowCountsBefore || defaultRowCountRows();
        return { rows, rowCount: rows.length };
      }
      if (kind === 'assert_index_absent') {
        priorSteps.push(kind);
        return responses.indexAbsence || { rows: [], rowCount: 0 };
      }
      throw Object.assign(new Error('unauthorized SQL rejected'), { code: 'unauthorized_sql' });
    },
    async end() {
      calls.push({ method: 'end' });
      if (s.closeError) {
        ended = true;
        throw s.closeError instanceof Error
          ? s.closeError
          : Object.assign(new Error(String(s.closeError)), { code: 'close_failed' });
      }
      ended = true;
      connected = false;
    },
  };
  Object.defineProperty(client, 'password', {
    enumerable: false,
    configurable: true,
    writable: true,
    value: undefined,
  });
  return client;
}

function createScriptedPhaseBFakeClientFactory(script) {
  return function FakeClient() {
    return createScriptedPhaseBFakeClient(script);
  };
}

function buildMatching14RPreflight(overrides) {
  return {
    derived: {
      tables: LOCKED_14R_PHASE_B_TABLES.slice(),
      columns: LOCKED_14R_PHASE_B_COLUMNS.slice(),
      matches14R: true,
    },
    cmtTableExists: false,
    cmtRelkind: null,
    clientsExists: true,
    azureContextVerified: true,
    unsafeNonemptyNotNull: false,
    volatileDefaultRewriteRisk: false,
    compareResult: {
      ok: false,
      counts: { expected_only: 498, live_only: 0, definition_mismatch: 1 },
      drifts: [
        { kind: 'expected_only', section: 'tables', key: 'customer_message_templates' },
        ...LOCKED_14R_PHASE_B_COLUMNS.map((key) => ({
          kind: 'expected_only', section: 'columns', key,
        })),
      ],
    },
    ...(overrides || {}),
  };
}

async function executePhaseBAdditiveReconcile(opts) {
  const options = opts || {};
  const secrets = [];
  let client = null;
  let closeMeta = { closed: false, closeError: null, attempted: false };
  let closeAttempted = false;
  const counters = {
    clientsInstantiated: 0,
    connectCalls: 0,
    queryCalls: 0,
    endCalls: 0,
  };
  let managedIdentityHttpDelta = {
    httpRequestCount: 0,
    imdsRequestCount: 0,
    keyVaultRequestCount: 0,
  };

  if (options.dsn != null
    || options.connectionString != null
    || options.databaseUrl != null
    || options.host != null
    || options.database != null
    || options.sql != null
    || options.query != null) {
    return pickSafePhaseBAdditiveOutput({
      ok: false,
      code: 'caller_supplied_connect_forbidden',
      applyPhaseBAdditive: false,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
      privateRefsZeroed: true,
    });
  }

  const gates = evaluatePhaseBAdditiveGates({
    env: options.env,
    argv: options.argv || [],
  });
  if (!gates.ok) {
    return pickSafePhaseBAdditiveOutput({
      ok: false,
      code: gates.errors[0] ? gates.errors[0].code : 'phase_b_additive_gates_rejected',
      errors: gates.errors,
      applyPhaseBAdditive: false,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
      phaseBAdditiveLiveEnabled: PHASE_D_PHASE_B_ADDITIVE_LIVE_ENABLED === true,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      note: 'gates rejected — zero pg Clients',
      privateRefsZeroed: true,
    });
  }

  const offlineProofClient = typeof options.Client === 'function';
  let privateBag = null;
  let credentialSource = CREDENTIAL_SOURCE_MANAGED_IDENTITY;

  if (options.privateCredentials
    && options.privateCredentials._user
    && options.privateCredentials._password) {
    privateBag = {
      _user: options.privateCredentials._user,
      _password: options.privateCredentials._password,
      _connectConfig: buildApplyConnectConfig(
        options.privateCredentials._user,
        options.privateCredentials._password,
      ),
    };
  } else {
    const httpBefore = getManagedIdentityHttpCounters();
    const loaded = await loadProtectedAdminCredentialsViaManagedIdentity({
      env: options.env,
      argv: options.argv || [],
      httpRequest: options.httpRequest,
    });
    const httpAfter = getManagedIdentityHttpCounters();
    managedIdentityHttpDelta = {
      httpRequestCount: httpAfter.httpRequestCount - httpBefore.httpRequestCount,
      imdsRequestCount: httpAfter.imdsRequestCount - httpBefore.imdsRequestCount,
      keyVaultRequestCount: httpAfter.keyVaultRequestCount - httpBefore.keyVaultRequestCount,
    };
    if (!loaded.ok) {
      zeroPrivateCredentialRefs(loaded);
      return pickSafePhaseBAdditiveOutput({
        ok: false,
        code: loaded.code || 'managed_identity_loader_failed',
        errors: loaded.errors || [],
        applyPhaseBAdditive: false,
        liveMutation: false,
        clientsInstantiated: 0,
        httpRequestCount: managedIdentityHttpDelta.httpRequestCount,
        imdsRequestCount: managedIdentityHttpDelta.imdsRequestCount,
        keyVaultRequestCount: managedIdentityHttpDelta.keyVaultRequestCount,
        liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
        privateRefsZeroed: true,
      });
    }
    privateBag = {
      _user: loaded._user,
      _password: loaded._password,
      _connectConfig: buildApplyConnectConfig(loaded._user, loaded._password),
    };
    zeroPrivateCredentialRefs(loaded);
  }

  secrets.push(privateBag._user, privateBag._password);

  let clientConfig;
  try {
    clientConfig = buildApplyPgClientConfig(privateBag._connectConfig);
  } catch (e) {
    zeroPrivateCredentialRefs(privateBag);
    return pickSafePhaseBAdditiveOutput({
      ok: false,
      code: e.code || 'credential_target_rejected',
      errors: e.errors || [{ code: e.code, message: e.message }],
      applyPhaseBAdditive: false,
      clientsInstantiated: 0,
      privateRefsZeroed: true,
    });
  }
  zeroPrivateCredentialRefs(privateBag);
  privateBag = null;

  const beforeClients = applyPgClientInstantiateCount;
  let outcome;
  try {
    client = instantiateApplyPgClient(clientConfig, { Client: options.Client });
    counters.clientsInstantiated = applyPgClientInstantiateCount - beforeClients;

    try {
      counters.connectCalls += 1;
      await client.connect();
    } catch (e) {
      const classified = classifyConnectError(e);
      throw Object.assign(new Error(classified.message), {
        code: classified.code,
        connectCategory: classified.category,
      });
    }

    let preflight;
    try {
      preflight = await runCatalogPreflightIntrospect(client, {
        injectedPreflight: options.injectedPreflight || (
          offlineProofClient ? buildMatching14RPreflight() : null
        ),
      });
    } catch (e) {
      throw Object.assign(
        new Error(redactSecrets(String((e && e.message) || e || 'preflight failed').slice(0, 240), secrets)),
        { code: (e && e.code) || 'catalog_preflight_failed' },
      );
    }

    const safety = evaluatePhaseBSafety(preflight);
    if (!safety.ok) {
      outcome = {
        ok: false,
        code: safety.errors[0] ? safety.errors[0].code : 'phase_b_safety_rejected',
        errors: safety.errors,
        safety,
        derivedPhaseBSet: safety.derived,
        preflight: {
          matches14R: safety.derived.matches14R,
          cmtTableExists: preflight.cmtTableExists === true,
          clientsExists: preflight.clientsExists === true,
          azureContextVerified: preflight.azureContextVerified === true,
        },
        applyPhaseBAdditive: false,
        liveMutation: false,
        schemaMutation: false,
        dataMutation: false,
        ledgerWritten: false,
        clientsInstantiated: counters.clientsInstantiated,
        connectCalls: counters.connectCalls,
        queryCalls: 0,
        httpRequestCount: managedIdentityHttpDelta.httpRequestCount,
        imdsRequestCount: managedIdentityHttpDelta.imdsRequestCount,
        keyVaultRequestCount: managedIdentityHttpDelta.keyVaultRequestCount,
        applicationName: APPLICATION_NAME,
        postgresHost: TARGETS.postgresHost,
        database: TARGETS.database,
        sslmode: 'verify-full',
        phaseBAdditiveLiveEnabled: true,
        liveApplyEnabled: false,
        committed: false,
        rolledBack: false,
        privateRefsZeroed: true,
        blocker: safety.errors[0] ? safety.errors[0].code : 'phase_b_safety_rejected',
        note: 'safety rejected — zero schema mutation',
      };
    } else {
      let sequence;
      try {
        const queryBefore = applyQueryCallCount;
        sequence = await runAuthorizedPhaseBAdditiveSequence(client, { secrets });
        counters.queryCalls = applyQueryCallCount - queryBefore;
      } catch (e) {
        if (e && e.result) {
          counters.queryCalls = Array.isArray(e.result.steps) ? e.result.steps.length : 0;
          throw e;
        }
        throw Object.assign(
          new Error(redactSecrets(String((e && e.message) || e || 'query failed').slice(0, 240), secrets)),
          { code: (e && e.code) || 'query_failed' },
        );
      }

      outcome = {
        ok: true,
        code: sequence.code || 'phase_b_additive_reconcile_ok',
        applyPhaseBAdditive: true,
        steps: sequence.steps,
        authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
        beforeAdditive: sequence.beforeAdditive,
        afterAdditive: sequence.afterAdditive,
        derivedPhaseBSet: safety.derived,
        rowCountPreservation: sequence.rowCountPreservation,
        createTableSha256: sequence.createTableSha256,
        migration035Sha256: sequence.migration035Sha256,
        migration035Sha256CanonicalLfV1: sequence.migration035Sha256CanonicalLfV1,
        indexAbsent: sequence.indexAbsent === true,
        forbiddenIndexName: FORBIDDEN_INDEX_NAME,
        clientsInstantiated: counters.clientsInstantiated,
        connectCalls: counters.connectCalls,
        queryCalls: counters.queryCalls,
        httpRequestCount: managedIdentityHttpDelta.httpRequestCount,
        imdsRequestCount: managedIdentityHttpDelta.imdsRequestCount,
        keyVaultRequestCount: managedIdentityHttpDelta.keyVaultRequestCount,
        credentialSource,
        managedIdentityName: MI_LOADER_LOCKS.managedIdentityName,
        keyVaultName: MI_LOADER_LOCKS.keyVaultName,
        secretName: MI_LOADER_LOCKS.secretName,
        postgresHost: TARGETS.postgresHost,
        database: TARGETS.database,
        sslmode: 'verify-full',
        applicationName: APPLICATION_NAME,
        subscriptionId: TARGETS.subscriptionId,
        resourceGroup: TARGETS.resourceGroup,
        postgresServer: TARGETS.postgresServer,
        liveMutation: true,
        schemaMutation: true,
        dataMutation: false,
        ledgerWritten: false,
        writesLedger: false,
        liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
        phaseBAdditiveLiveEnabled: true,
        liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
        usedLiveHttp: managedIdentityHttpDelta.httpRequestCount > 0 && !offlineProofClient,
        realImdsCall: managedIdentityHttpDelta.imdsRequestCount > 0 && !offlineProofClient,
        realKeyVaultCall: managedIdentityHttpDelta.keyVaultRequestCount > 0 && !offlineProofClient,
        realPostgresCall: !offlineProofClient,
        committed: true,
        rolledBack: false,
        privateRefsZeroed: true,
        safety: { ok: true, derived: safety.derived },
      };
    }
  } catch (e) {
    const code = (e && e.code) || (e && e.result && e.result.code) || 'query_failed';
    const connectCategory = e && e.connectCategory ? String(e.connectCategory) : undefined;
    const result = e && e.result ? e.result : null;
    outcome = {
      ok: false,
      code,
      connectCategory,
      message: connectCategory
        ? CONNECT_FAILED_SAFE_MESSAGE
        : redactSecrets(String((e && e.message) || 'adapter failed'), secrets),
      steps: result && result.steps ? result.steps : [],
      rolledBack: result ? result.rolledBack === true : false,
      committed: false,
      applyPhaseBAdditive: false,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      writesLedger: false,
      clientsInstantiated: counters.clientsInstantiated,
      connectCalls: counters.connectCalls,
      queryCalls: counters.queryCalls || (result && result.steps ? result.steps.length : 0),
      httpRequestCount: managedIdentityHttpDelta.httpRequestCount,
      imdsRequestCount: managedIdentityHttpDelta.imdsRequestCount,
      keyVaultRequestCount: managedIdentityHttpDelta.keyVaultRequestCount,
      applicationName: APPLICATION_NAME,
      postgresHost: TARGETS.postgresHost,
      database: TARGETS.database,
      sslmode: 'verify-full',
      phaseBAdditiveLiveEnabled: true,
      liveApplyEnabled: false,
      realPostgresCall: !offlineProofClient && counters.connectCalls > 0,
      privateRefsZeroed: true,
      blocker: code,
    };
  } finally {
    if (!closeAttempted) {
      closeAttempted = true;
      closeMeta = await closeClientQuietly(client, secrets);
      if (closeMeta.attempted) counters.endCalls += 1;
    }
  }

  outcome.closed = closeMeta.closed === true;
  outcome.endCalls = counters.endCalls;
  if (closeMeta.closeError && outcome.ok) {
    outcome.ok = false;
    outcome.code = 'close_failed';
    outcome.message = closeMeta.closeError;
  } else if (closeMeta.closeError) {
    outcome.closeFailure = true;
  }

  if (clientConfig) {
    try { clientConfig.password = undefined; clientConfig.user = undefined; } catch (_) { /* ignore */ }
  }

  return pickSafePhaseBAdditiveOutput(outcome);
}

function exactPhaseBAdditiveArgv() {
  return [
    CLI_APPLY_PHASE_B_ADDITIVE,
    '--subscription', TARGETS.subscriptionId,
    '--resource-group', TARGETS.resourceGroup,
    '--postgres-server', TARGETS.postgresServer,
    '--database', TARGETS.database,
    CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  ];
}

function phaseBAdditiveEnv(extra) {
  return {
    [ENV_LIVE_READONLY]: '1',
    [ENV_LIVE_PREFLIGHT]: '1',
    [ENV_PHASE_B_ADDITIVE]: '1',
    [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
    [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    ...(extra || {}),
  };
}

function renderPhaseBAdditiveUsage() {
  return [
    'phase-d:phase-b-additive-reconcile — FOUNDATION Slice 14S Phase B',
    '',
    'Default: refused (zero pg Clients / zero HTTP).',
    '',
    'Required env:',
    `  ${ENV_LIVE_READONLY}=1`,
    `  ${ENV_LIVE_PREFLIGHT}=1`,
    `  ${ENV_PHASE_B_ADDITIVE}=1`,
    `  ${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    `  AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
    '',
    'Required argv:',
    `  ${CLI_APPLY_PHASE_B_ADDITIVE}`,
    `  --subscription ${TARGETS.subscriptionId}`,
    `  --resource-group ${TARGETS.resourceGroup}`,
    `  --postgres-server ${TARGETS.postgresServer}`,
    `  --database ${TARGETS.database}`,
    `  ${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    '',
    'Creates public.customer_message_templates from byte-locked migration 035.',
    'No CREATE INDEX / COMMENT / DML / ledger.',
  ].join('\n');
}

module.exports = {
  PHASE_D_PHASE_B_ADDITIVE_LIVE_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  ENV_PHASE_B_ADDITIVE,
  CLI_APPLY_PHASE_B_ADDITIVE,
  APPLICATION_NAME,
  ADVISORY_LOCK_KEY1,
  ADVISORY_LOCK_KEY2,
  LOCK_TIMEOUT_MS,
  STATEMENT_TIMEOUT_MS,
  SCHEMA,
  TABLE,
  CREATE_TABLE_SQL,
  CREATE_TABLE_SHA256,
  EXPECTED_035_SHA256,
  FORBIDDEN_INDEX_NAME,
  FORBIDDEN_CREATE_INDEX_SQL,
  LOCKED_14R_PHASE_B_TABLES,
  LOCKED_14R_PHASE_B_COLUMNS,
  EXPECTED_COLUMN_SEMANTICS,
  APPROVED_PUBLIC_TABLES_EXCEPT_CMT,
  AUTHORIZED_SEQUENCE,
  APPLY_LOCKS,
  FORBIDDEN_ARGV_FLAGS,
  ALLOWED_ARGV_FLAGS,
  SAFE_OUTPUT_KEYS,
  ROW_COUNT_SQL,
  COLUMN_SEMANTICS_SQL,
  RELKIND_LOOKUP_SQL,
  INDEX_ABSENCE_SQL,
  SET_LOCK_TIMEOUT_SQL,
  SET_STATEMENT_TIMEOUT_SQL,
  ADVISORY_LOCK_SQL,
  derivePhaseBAdditiveSet,
  evaluatePhaseBSafety,
  evaluatePhaseBAdditiveGates,
  executePhaseBAdditiveReconcile,
  runAuthorizedPhaseBAdditiveSequence,
  createScriptedPhaseBFakeClient,
  createScriptedPhaseBFakeClientFactory,
  buildMatching14RPreflight,
  getPhaseBAdditiveCounters,
  resetPhaseBAdditiveCounters,
  pickSafePhaseBAdditiveOutput,
  exactPhaseBAdditiveArgv,
  phaseBAdditiveEnv,
  renderPhaseBAdditiveUsage,
  assertCreateTableByteLocked,
  authorizeApplySql,
  classifyApplyStep,
  buildApplyConnectConfig,
  buildApplyPgClientConfig,
};
