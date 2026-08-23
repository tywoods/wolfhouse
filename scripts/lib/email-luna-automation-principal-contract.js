'use strict';

const { EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT } = require('./email-luna-automation-queue-store');
const { EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT } = require('./email-luna-automation-journal-handoff-store');
const { EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_GRANT_CONTRACT } = require('./email-luna-automation-issuance-material-store');

const objectFreeze = Object.freeze;

const ROLE_NAME_RE = /^[a-z][a-z0-9_]{2,62}$/;
const LOCATION_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PASSWORD_RE = /^[A-Za-z0-9_-]{40,128}$/;

const RESERVED_ROLE_NAMES = objectFreeze([
  'public',
  'postgres',
  'azure_pg_admin',
  'azure_superuser',
  'replication',
  'current_user',
  'session_user',
  'user',
  'pg_monitor',
  'pg_read_all_data',
  'pg_write_all_data',
  'pg_read_all_settings',
  'pg_read_all_stats',
  'pg_stat_scan_tables',
  'pg_read_server_files',
  'pg_write_server_files',
  'pg_execute_server_program',
  'pg_signal_backend',
  'pg_checkpoint',
  'pg_maintain',
  'pg_use_reserved_connections',
  'pg_create_subscription',
]);

const FORBIDDEN_DATABASE_NAMES = objectFreeze([
  'sunset_staging',
  'sunset_prod',
  'wolfhouse_staging',
  'wolfhouse_prod',
  'luna_prod',
]);

const ROLE_ATTRIBUTES = objectFreeze({
  rolcanlogin: true,
  rolsuper: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolinherit: false,
  rolreplication: false,
  rolbypassrls: false,
});

const PRINCIPAL_KINDS = objectFreeze(['worker', 'operator', 'producer']);

const WORKER_EXECUTE_FUNCTIONS = objectFreeze(Array.from(new Set([
  ...EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.worker_execute_functions,
  ...EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT.worker_execute_functions,
])));
const OPERATOR_EXECUTE_FUNCTIONS = EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.operator_execute_functions;

const FUNCTION_SIGNATURES = objectFreeze({
  tenant_email_luna_automation_enqueue: 'tenant_email_luna_automation_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text)',
  tenant_email_luna_automation_claim: 'tenant_email_luna_automation_claim(uuid, uuid)',
  tenant_email_luna_automation_cancel_claimed: 'tenant_email_luna_automation_cancel_claimed(uuid, uuid)',
  tenant_email_luna_automation_require_handoff_claimed: 'tenant_email_luna_automation_require_handoff_claimed(uuid, uuid)',
  tenant_email_luna_automation_handoff: 'tenant_email_luna_automation_handoff(uuid, uuid)',
  tenant_email_luna_automation_terminalize_attempt_cap: 'tenant_email_luna_automation_terminalize_attempt_cap(uuid, uuid)',
  tenant_email_luna_automation_journal_handoff_lock: 'tenant_email_luna_automation_journal_handoff_lock(uuid, uuid)',
  tenant_email_luna_automation_cancel_pending: 'tenant_email_luna_automation_cancel_pending(uuid, uuid)',
  tenant_email_luna_automation_require_handoff_pending: 'tenant_email_luna_automation_require_handoff_pending(uuid, uuid)',
  tenant_email_luna_automation_principal_authorized: 'tenant_email_luna_automation_principal_authorized(text, uuid, uuid, text)',
  tenant_email_luna_automation_persist_and_enqueue: 'tenant_email_luna_automation_persist_and_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text, jsonb)',
  tenant_email_luna_automation_issuance_material_load: 'tenant_email_luna_automation_issuance_material_load(uuid, uuid)',
});

const EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT = objectFreeze({
  id: 'email-luna-automation-principal-grants.v1',
  apply_in: 'ch4_runtime_worker_and_operator_roles',
  migration: '088_tenant_email_luna_automation_principal_grants.sql',
  principal_table: 'tenant_email_luna_automation_principals',
  trusted_schema: 'public',
  search_path: objectFreeze(['pg_catalog', 'public']),
  function_owner: 'table_owner',
  authorization: 'session_user_durable_mapping',
  identity_signal: 'session_user',
  no_custom_guc: true,
  no_create_role_in_088: true,
  no_grant_in_088: true,
  no_synthetic_runtime_role_in_migration: true,
  no_hardcoded_live_credential: true,
  default_off: true,
  runtime_wired: false,
  login_separation: true,
  role_attributes: ROLE_ATTRIBUTES,
  kinds: PRINCIPAL_KINDS,
  worker_table_privileges: EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT.worker_table_privileges,
  worker_table_denied: objectFreeze(['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']),
  worker_journal_select: false,
  worker_execute_functions: WORKER_EXECUTE_FUNCTIONS,
  operator_execute_functions: OPERATOR_EXECUTE_FUNCTIONS,
  producer_execute_functions: EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_GRANT_CONTRACT.producer_execute_functions,
  support_execute_functions: objectFreeze(['tenant_email_luna_automation_principal_authorized']),
  issuance_material_worker_execute_functions: EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_GRANT_CONTRACT.worker_execute_functions,
  issuance_material_producer_execute_functions: EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_GRANT_CONTRACT.producer_execute_functions,
  issuance_material_worker_denied_execute_functions: EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_GRANT_CONTRACT.producer_execute_functions,
  issuance_material_producer_denied_execute_functions: EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_GRANT_CONTRACT.worker_execute_functions,
  issuance_material_table: EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_GRANT_CONTRACT.table,
  worker_material_select: false,
  producer_material_select: false,
  producer_queue_select: false,
  producer_worker_roles_globally_distinct: true,
  no_grant_in_089: true,
  no_create_role_in_089: true,
  queue_rls: objectFreeze({ enable: true, force: false, command: 'SELECT' }),
  journal_rls: objectFreeze({
    enable: false,
    reason: 'shared_staff_graph_journal_no_existing_rls_model_scoped_function_removes_worker_select',
  }),
  exclusive_provisioner_session: true,
  refuse_pool_query: true,
  password_never_returned: true,
  password_transport: 'exclusive_client_create_role_sql_or_trusted_precreation',
  query_secret_option_not_used: true,
  adopt_unmapped_existing_role: false,
  convergent_rerun: 'exact_mapped_role_only',
  audit_zero_memberships: true,
  audit_no_owned_objects: true,
  audit_owner_completeness: 'pg_shdepend_deptype_o_cluster',
  audit_direct_acl_completeness: 'pg_shdepend_deptype_a_cluster',
  audit_function_privilege_by: 'oid_signature',
  trusted_precreated_pregrant_audit: true,
  trusted_precreated_requires_zero_owner_membership_direct_acl: true,
  mapped_rerun_reaudits_drift: true,
  direct_temp_rejected_even_if_public_temp: true,
  ambient_public_database_privileges: objectFreeze({
    CONNECT: 'public_current_database_accepted',
    TEMP: 'public_current_database_accepted_direct_temp_rejected',
    CREATE: 'rejected',
  }),
  ambient_public_schema_create: 'rejected_on_every_accessible_schema',
  ambient_public_schema_usage: 'public_required',
  ambient_callable_functions: 'exact_luna_oids_only',
  ambient_extension_execute_allowlist: objectFreeze([]),
  pglite_create_role_transactional: 'not_the_stock_pg_contract_prove_on_stock_pg',
  pglite_pg_shdepend: 'populated_for_acl_and_owner_keep_stock_pg_sql_exact',
  forbidden_databases: FORBIDDEN_DATABASE_NAMES,
});

function assertRoleName(roleName) {
  const name = String(roleName || '');
  if (!ROLE_NAME_RE.test(name) || name.startsWith('pg_') || RESERVED_ROLE_NAMES.includes(name)) {
    const error = new Error('Email Luna automation principal role name is invalid.');
    error.code = 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID_ROLE';
    throw error;
  }
  return name;
}

function quoteSqlIdent(value) {
  const name = String(value || '');
  if (!/^[a-z][a-z0-9_]*$/.test(name) || name.length > 63) {
    const error = new Error('Email Luna automation principal identifier is invalid.');
    error.code = 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID_ROLE';
    throw error;
  }
  return `"${name}"`;
}

function quoteIdent(value) {
  return quoteSqlIdent(assertRoleName(value));
}

function assertUuid(value, label) {
  const text = String(value || '').toLowerCase();
  if (!UUID_RE.test(text)) {
    const error = new Error(`Email Luna automation principal ${label} is invalid.`);
    error.code = 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID';
    throw error;
  }
  return text;
}

function assertLocationKey(value) {
  const text = String(value || '');
  if (!LOCATION_KEY_RE.test(text)) {
    const error = new Error('Email Luna automation principal location_key is invalid.');
    error.code = 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID';
    throw error;
  }
  return text;
}

function assertKind(value) {
  const kind = String(value || '');
  if (!PRINCIPAL_KINDS.includes(kind)) {
    const error = new Error('Email Luna automation principal kind is invalid.');
    error.code = 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID';
    throw error;
  }
  return kind;
}

function assertPassword(password) {
  const text = String(password || '');
  if (!PASSWORD_RE.test(text)) {
    const error = new Error('Email Luna automation principal password format is invalid.');
    error.code = 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID_PASSWORD';
    throw error;
  }
  return text;
}

function sqlStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createRoleSql(roleName, password) {
  const ident = quoteIdent(roleName);
  assertPassword(password);
  return `CREATE ROLE ${ident} LOGIN PASSWORD ${sqlStringLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`;
}

function createRoleSqlPlan(roleName) {
  return `CREATE ROLE ${quoteIdent(roleName)} LOGIN PASSWORD ***REDACTED*** NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`;
}

function executeFunctionsFor(kind) {
  const k = assertKind(kind);
  if (k === 'producer') {
    return objectFreeze(
      EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.producer_execute_functions.map((name) => FUNCTION_SIGNATURES[name]),
    );
  }
  const names = k === 'worker'
    ? [...WORKER_EXECUTE_FUNCTIONS, ...EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.support_execute_functions]
    : [...OPERATOR_EXECUTE_FUNCTIONS, ...EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.support_execute_functions];
  return objectFreeze(names.map((name) => FUNCTION_SIGNATURES[name]));
}

function deniedExecuteFunctionsFor(kind) {
  const k = assertKind(kind);
  if (k === 'producer') {
    const names = [
      ...WORKER_EXECUTE_FUNCTIONS,
      ...OPERATOR_EXECUTE_FUNCTIONS,
      ...EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.support_execute_functions,
    ];
    return objectFreeze(names.map((name) => FUNCTION_SIGNATURES[name]));
  }
  const names = k === 'worker' ? [...OPERATOR_EXECUTE_FUNCTIONS] : [...WORKER_EXECUTE_FUNCTIONS];
  return objectFreeze(names.map((name) => FUNCTION_SIGNATURES[name]));
}

module.exports = {
  EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT,
  ROLE_ATTRIBUTES,
  ROLE_NAME_RE,
  RESERVED_ROLE_NAMES,
  FORBIDDEN_DATABASE_NAMES,
  FUNCTION_SIGNATURES,
  assertRoleName,
  assertUuid,
  assertLocationKey,
  assertKind,
  assertPassword,
  quoteIdent,
  quoteSqlIdent,
  sqlStringLiteral,
  createRoleSql,
  createRoleSqlPlan,
  executeFunctionsFor,
  deniedExecuteFunctionsFor,
};
