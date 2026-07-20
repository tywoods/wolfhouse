'use strict';

/**
 * FOUNDATION Slice 14AC — Ledger bootstrap eligibility matrix prover (read-only)
 *
 * Loads the exact 39 canonical_forward manifest entries (checksumMode canonical_lf_v1),
 * statically parses migration SQL into effect objects, builds explicit proof plans,
 * and evaluates eligibility against a live product snapshot + targeted SELECT evidence.
 *
 * Never infers execution from numbering or zero schema drift alone.
 * Never labels bootstrap rows executed_by_canonical_runner.
 * Fail closed on data-only / weak-signature migrations without definitive proof.
 *
 * Zero mutation: no DDL/DML/ledger write/KV/Azure/RBAC/network/deploy.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  ENV_LIVE_READONLY,
  ENV_LIVE_PREFLIGHT,
  ENV_SUBSCRIPTION,
  ENV_CREDENTIAL_SOURCE,
  CLI_CREDENTIAL_SOURCE,
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  redactDeep,
  normalizeSql,
} = require('./phase-d-live-readonly-boundary');
const {
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
  loadProtectedAdminCredentialsViaManagedIdentity,
  zeroPrivateCredentialRefs,
  getManagedIdentityHttpCounters,
  resetManagedIdentityHttpCounters,
  createInjectedManagedIdentityHttp,
} = require('./phase-d-managed-identity-credential-loader');
const {
  buildVerifiedTlsSslConfig,
} = require('./phase-d-live-readonly-pg-adapter');
const {
  PHASE_D_TARGET_AUTHORITY_LIVE_ENABLED,
  ENV_TARGET_AUTHORITY,
  CLI_PROVE_TARGET_AUTHORITY,
  AUTHORITY_LOCKS,
  evaluateTargetAuthorityGates,
  exactTargetAuthorityArgv,
  targetAuthorityEnv,
  executeActiveDbTargetAuthority,
  createInjectedTargetAuthorityHttp,
  createLiveTargetAuthorityHttpRequest,
  resetTargetAuthorityCounters,
  getTargetAuthorityCounters,
  FORBIDDEN_ARGV_FLAGS: AUTHORITY_FORBIDDEN_ARGV,
} = require('./phase-d-active-db-target-authority');
const {
  buildObserverCompareOptions,
  buildOfflinePgcryptoLiveProfile,
  captureAzurePg15PgcryptoLiveProfile,
  remainingMismatchKeys,
  summarizeCompare,
} = require('./phase-d-pgcrypto-compatibility-normalization');
const {
  MIGRATIONS_DIR,
  MANIFEST_PATH,
  LEDGER_DDL,
  CHECKSUM_MODE_CANONICAL_LF_V1,
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  sha256CanonicalLfV1File,
  ledgerChecksumAccepted,
} = require('./migration-integrity');
const {
  introspectProductSchema,
  fingerprintProductSchema,
  compareSnapshots,
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  INTROSPECTION_SQL,
  LEDGER_TABLE,
  assertSqlAllowed,
  classifyServerVersionClass,
  buildIdentifierTruncationNotNullProvenance,
} = require('./sunset-schema-observer');

const PHASE_D_LEDGER_ELIGIBILITY_LIVE_ENABLED = true;

const ENV_LEDGER_ELIGIBILITY = 'SUNSET_PHASE_D_LEDGER_ELIGIBILITY';
const CLI_PROVE_LEDGER_ELIGIBILITY = '--prove-ledger-eligibility-matrix';
const APPLICATION_NAME = 'wh-sunset-ledger-eligibility';

const EXPECTED_FORWARD_COUNT = 39;

/**
 * Slice 13A.1 legacy hash acceptance — narrow contract only.
 * ledgerChecksumAccepted(entry, checksum) accepts:
 *   1) exact entry.sha256 under checksumMode canonical_lf_v1
 *   2) exact entry.legacySha256 only (mode legacy_crlf_era_exact)
 * No fuzzy, normalized, or invented accept paths.
 */
const LEGACY_HASH_POLICY_SLICE_13A1 = Object.freeze({
  checksumMode: CHECKSUM_MODE_CANONICAL_LF_V1,
  acceptedModes: Object.freeze(['canonical_lf_v1', 'legacy_crlf_era_exact']),
  contractRef: 'scripts/lib/migration-integrity.js → ledgerChecksumAccepted',
  note: 'Exact legacySha256 acceptance only under Slice 13A.1; bootstrap rows use canonical_lf_v1 sha256.',
});

const APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE = 'verified_structural_baseline';
const APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE = 'verified_current_state_baseline';
const APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER = 'executed_by_canonical_runner';

const CLASSIFICATION_ELIGIBLE_STRUCTURAL = 'eligible_verified_structural_baseline';
const CLASSIFICATION_ELIGIBLE_CURRENT_STATE = 'eligible_verified_current_state_baseline';
const CLASSIFICATION_BLOCKED_UNPROVEN = 'blocked_unproven';
const CLASSIFICATION_BLOCKED_BY_PREFIX = 'blocked_by_prefix';

const DEC006_MIGRATION_IDS = Object.freeze([
  '018_booking_service_records_nullable_service_date',
  '019_bookings_language',
  '020_wolfhouse_room_gender_metadata',
]);

const DEC006_RESOLUTION_REQUIREMENTS = Object.freeze({
  '018_booking_service_records_nullable_service_date': Object.freeze([
    { id: '018-col-nullability', required: true, weak: false },
    { id: '018-no-conflicting-check', required: true, weak: false },
    { id: '018-optional-comment', required: false, weak: true },
  ]),
  '019_bookings_language': Object.freeze([
    { id: '019-column-present', required: true, weak: false },
    { id: '019-default-or-nullability', required: true, weak: false },
  ]),
  '020_wolfhouse_room_gender_metadata': Object.freeze([
    { id: '020-columns-present', required: true, weak: false },
    { id: '020-tenant-scoped-dml-rows', required: false, weak: true },
  ]),
});

const MIGRATION_020_EXPECTED_ROOM_VALUES = Object.freeze([
  Object.freeze(['R1', 'Flexible', 'mixed', false, false]),
  Object.freeze(['R2', 'Male preferred', 'male_only', false, false]),
  Object.freeze(['R3', 'Flexible', 'matrimonial_or_mixed', true, false]),
  Object.freeze(['R4', 'Male preferred', 'male_only', false, false]),
  Object.freeze(['R5', 'Female preferred', 'female_only', false, false]),
  Object.freeze(['R6', 'Private', 'matrimonial_private_couple', true, false]),
  Object.freeze(['R7', 'Flexible', 'operator_surfweek', false, true]),
  Object.freeze(['R8', 'Female preferred', 'female_only', false, false]),
  Object.freeze(['R9', 'Flexible', 'operator_surfweek', false, true]),
  Object.freeze(['R10', 'Flexible', 'operator_surfweek', false, true]),
]);

const MIGRATION_020_ROOM_CODES = Object.freeze(
  MIGRATION_020_EXPECTED_ROOM_VALUES.map((row) => row[0]),
);

const ELIGIBILITY_REASON_VACUOUS = 'tenant_scoped_dml_vacuously_complete';
const ELIGIBILITY_REASON_MATCHED = 'tenant_scoped_dml_matched';
const BLOCKED_REASON_DML_MISMATCH = 'tenant_scoped_dml_mismatch';
const BLOCKED_REASON_AMBIGUOUS_SLUG = 'ambiguous_client_slug';
const BLOCKED_REASON_ROOM_MULTIPLICITY = 'unexpected_room_code_multiplicity';
const BLOCKED_REASON_QUERY_AMBIGUITY = 'query_ambiguity';

const DEC006_PROOF_SQL = Object.freeze({
  '018-col-nullability': [
    'SELECT c.is_nullable',
    'FROM information_schema.columns c',
    "WHERE c.table_schema = 'public'",
    "AND c.table_name = 'booking_service_records'",
    "AND c.column_name = 'service_date'",
  ].join(' '),
  '018-no-conflicting-check': [
    'SELECT COUNT(*) AS cnt',
    'FROM pg_catalog.pg_constraint con',
    'JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid',
    'JOIN pg_catalog.pg_namespace nsp ON nsp.oid = rel.relnamespace',
    "WHERE nsp.nspname = 'public'",
    "AND rel.relname = 'booking_service_records'",
    "AND con.contype = 'c'",
    "AND pg_catalog.pg_get_constraintdef(con.oid) ILIKE '%service_date%IS NOT NULL%'",
  ].join(' '),
  '018-optional-comment': [
    'SELECT pg_catalog.col_description(',
    "(SELECT cls.oid FROM pg_catalog.pg_class cls JOIN pg_catalog.pg_namespace nsp ON nsp.oid = cls.relnamespace",
    "WHERE nsp.nspname = 'public' AND cls.relname = 'booking_service_records'),",
    "(SELECT att.attnum FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_class cls ON cls.oid = att.attrelid",
    "JOIN pg_catalog.pg_namespace nsp ON nsp.oid = cls.relnamespace",
    "WHERE nsp.nspname = 'public' AND cls.relname = 'booking_service_records' AND att.attname = 'service_date' AND att.attnum > 0)",
    ') AS comment_text',
  ].join(' '),
  '019-column-present': [
    'SELECT c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default',
    'FROM information_schema.columns c',
    "WHERE c.table_schema = 'public'",
    "AND c.table_name = 'bookings'",
    "AND c.column_name = 'language'",
  ].join(' '),
  '019-default-or-nullability': [
    'SELECT c.is_nullable, c.column_default',
    'FROM information_schema.columns c',
    "WHERE c.table_schema = 'public'",
    "AND c.table_name = 'bookings'",
    "AND c.column_name = 'language'",
  ].join(' '),
  '020-columns-present': [
    'SELECT c.column_name, c.data_type, c.udt_name, c.is_nullable',
    'FROM information_schema.columns c',
    "WHERE c.table_schema = 'public'",
    "AND c.table_name = 'rooms'",
    "AND c.column_name IN ('gender_strategy','room_type','can_be_matrimonial','often_used_by_operator')",
    'ORDER BY c.column_name',
  ].join(' '),
  '020-tenant-scoped-dml-rows': [
    'SELECT',
    "(SELECT COUNT(*) FROM clients c WHERE c.slug = 'wolfhouse-somo') AS client_slug_count,",
    '(SELECT COUNT(*) FROM rooms r JOIN clients c ON r.client_id = c.id',
    "WHERE c.slug = 'wolfhouse-somo'",
    "AND r.room_code IN ('R1','R2','R3','R4','R5','R6','R7','R8','R9','R10')) AS applicable_rows,",
    '(SELECT COUNT(*) FROM rooms r JOIN clients c ON r.client_id = c.id',
    "WHERE c.slug = 'wolfhouse-somo'",
    "AND r.room_code IN ('R1','R2','R3','R4','R5','R6','R7','R8','R9','R10')",
    'AND NOT EXISTS (',
    'SELECT 1 FROM (VALUES',
    "('R1','Flexible','mixed',FALSE,FALSE),",
    "('R2','Male preferred','male_only',FALSE,FALSE),",
    "('R3','Flexible','matrimonial_or_mixed',TRUE,FALSE),",
    "('R4','Male preferred','male_only',FALSE,FALSE),",
    "('R5','Female preferred','female_only',FALSE,FALSE),",
    "('R6','Private','matrimonial_private_couple',TRUE,FALSE),",
    "('R7','Flexible','operator_surfweek',FALSE,TRUE),",
    "('R8','Female preferred','female_only',FALSE,FALSE),",
    "('R9','Flexible','operator_surfweek',FALSE,TRUE),",
    "('R10','Flexible','operator_surfweek',FALSE,TRUE)",
    ') AS v(room_code, gender_strategy, room_type, can_be_matrimonial, often_used_by_operator)',
    'WHERE v.room_code = r.room_code',
    'AND v.gender_strategy IS NOT DISTINCT FROM r.gender_strategy',
    'AND v.room_type IS NOT DISTINCT FROM r.room_type',
    'AND v.can_be_matrimonial IS NOT DISTINCT FROM r.can_be_matrimonial',
    'AND v.often_used_by_operator IS NOT DISTINCT FROM r.often_used_by_operator',
    ')) AS mismatching_rows,',
    '(SELECT COUNT(*) FROM (',
    'SELECT r.room_code FROM rooms r JOIN clients c ON r.client_id = c.id',
    "WHERE c.slug = 'wolfhouse-somo'",
    "AND r.room_code IN ('R1','R2','R3','R4','R5','R6','R7','R8','R9','R10')",
    'GROUP BY r.room_code HAVING COUNT(*) > 1',
    ') d) AS duplicate_room_code_count',
  ].join(' '),
});

const LEDGER_ABSENT_SQL = [
  'SELECT COUNT(*) AS cnt',
  'FROM information_schema.tables t',
  "WHERE t.table_schema = 'public'",
  "AND t.table_name = 'schema_migration_ledger'",
].join(' ');

/**
 * Current-state identity aliases (rename / type-swap / location-aware supersession).
 * Matching via alias proves verified_current_state_baseline, not structural filename execution.
 */
const CURRENT_STATE_ALIASES = Object.freeze({
  tables: Object.freeze({ hostels: 'clients' }),
  enums: Object.freeze({ payment_kind_v2: 'payment_kind' }),
  indexes: Object.freeze({
    'packages.idx_packages_hostel': 'packages.idx_packages_client',
    'rooms.idx_rooms_hostel': 'rooms.idx_rooms_client',
    'beds.idx_beds_hostel_room': 'beds.idx_beds_client_room',
    'guests.idx_guests_hostel_phone': 'guests.idx_guests_client_phone',
    'guests.idx_guests_hostel_email': 'guests.idx_guests_client_email',
    'bookings.idx_bookings_hostel_dates': 'bookings.idx_bookings_client_dates',
    'bookings.idx_bookings_hostel_status': 'bookings.idx_bookings_client_status',
    'bookings.idx_bookings_phone': 'bookings.idx_bookings_client_phone',
    'bookings.idx_bookings_hold_expires': 'bookings.idx_bookings_client_hold_expires',
    'booking_beds.idx_booking_beds_availability': 'booking_beds.idx_booking_beds_availability_client',
    'conversations.idx_conversations_hostel_status': 'conversations.idx_conversations_client_status',
    'messages.idx_messages_whatsapp_id': 'messages.idx_messages_whatsapp_client',
    'payments.idx_payments_hostel_status': 'payments.idx_payments_client_status',
    'manual_entries.idx_manual_entries_sync': 'manual_entries.idx_manual_entries_client_sync',
    'operator_room_release_requests.idx_operator_release_hostel_status':
      'operator_room_release_requests.idx_operator_release_client_status',
    'package_price_rules.idx_package_price_rules_lookup':
      'package_price_rules.idx_package_price_rules_client_lookup',
    'tenant_price_rules.uq_tenant_price_rules_active_window':
      'tenant_price_rules.uq_tenant_price_rules_active_window_loc',
    'tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_default':
      'tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_default_loc',
    'tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_weekday':
      'tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_weekday_loc',
    'tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_date':
      'tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_date_loc',
    'tenant_lesson_time_rules.uq_tenant_lesson_time_recurring':
      'tenant_lesson_time_rules.uq_tenant_lesson_time_recurring_loc',
    'tenant_lesson_time_rules.uq_tenant_lesson_time_date':
      'tenant_lesson_time_rules.uq_tenant_lesson_time_date_loc',
  }),
  triggers: Object.freeze({
    'hostels.hostels_updated_at': 'clients.clients_updated_at',
  }),
  columns: Object.freeze({
    'hostels.id': 'clients.id',
  }),
});

/**
 * Durable catalog outcomes for migrations whose executable SQL is mostly DO/dynamic
 * or ephemeral pg_temp helpers (still must be proven live — never inferred from order).
 */
const DURABLE_EFFECT_OVERRIDES = Object.freeze({
  '039_sunset_admin_location_aware_rules': Object.freeze([
    { class: 'indexes', kind: 'create_index', identity: 'public.tenant_price_rules.uq_tenant_price_rules_active_window_loc', weakSignature: false, supersedable: false },
    { class: 'indexes', kind: 'create_index', identity: 'public.tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_default_loc', weakSignature: false, supersedable: false },
    { class: 'indexes', kind: 'create_index', identity: 'public.tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_weekday_loc', weakSignature: false, supersedable: false },
    { class: 'indexes', kind: 'create_index', identity: 'public.tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_date_loc', weakSignature: false, supersedable: false },
    { class: 'indexes', kind: 'create_index', identity: 'public.tenant_lesson_time_rules.uq_tenant_lesson_time_recurring_loc', weakSignature: false, supersedable: false },
    { class: 'indexes', kind: 'create_index', identity: 'public.tenant_lesson_time_rules.uq_tenant_lesson_time_date_loc', weakSignature: false, supersedable: false },
  ]),
  '040_tenant_services_saas_catalog_columns': Object.freeze([
    { class: 'columns', kind: 'add_column', identity: 'public.tenant_services.weekdays', weakSignature: false, supersedable: false },
    { class: 'columns', kind: 'add_column', identity: 'public.tenant_services.block_rooms_enabled', weakSignature: false, supersedable: false },
    { class: 'columns', kind: 'add_column', identity: 'public.tenant_services.blocked_room_codes', weakSignature: false, supersedable: false },
    { class: 'columns', kind: 'add_column', identity: 'public.tenant_services.room_block_booking_ids', weakSignature: false, supersedable: false },
  ]),
  '041_notification_surfpack_convergence': Object.freeze([
    { class: 'indexes', kind: 'create_index', identity: 'public.client_notification_events.idx_client_notification_events_client_created', weakSignature: false, supersedable: false },
    { class: 'indexes', kind: 'create_index', identity: 'public.client_notification_events.idx_client_notification_events_conversation', weakSignature: false, supersedable: false },
    { class: 'indexes', kind: 'create_index', identity: 'public.client_notification_settings.idx_client_notification_settings_client', weakSignature: false, supersedable: false },
    { class: 'indexes', kind: 'create_index', identity: 'public.tenant_surf_pack_rules.idx_tenant_surf_pack_client_loc', weakSignature: false, supersedable: false },
    { class: 'constraints', kind: 'add_constraint', identity: 'public.tenant_surf_pack_rules.tenant_surf_pack_rules_updated_by_fkey', weakSignature: false, supersedable: false },
    { class: 'triggers', kind: 'create_trigger', identity: 'public.tenant_surf_pack_rules.tenant_surf_pack_rules_updated_at', weakSignature: false, supersedable: false },
  ]),
  '003_rename_hostel_to_client': Object.freeze([
    { class: 'tables', kind: 'rename_target_present', identity: 'public.clients', weakSignature: false, supersedable: false },
    { class: 'tables', kind: 'rename_source_absent', identity: 'public.hostels', weakSignature: true, supersedable: false },
    { class: 'triggers', kind: 'create_trigger', identity: 'public.clients.clients_updated_at', weakSignature: false, supersedable: false },
  ]),
});

const LEDGER_LOCKS = Object.freeze({
  ...AUTHORITY_LOCKS,
  applicationName: APPLICATION_NAME,
});

const ALLOWED_ARGV_FLAGS = Object.freeze([
  CLI_PROVE_LEDGER_ELIGIBILITY,
  CLI_PROVE_TARGET_AUTHORITY,
  CLI_CREDENTIAL_SOURCE,
  '--subscription',
  '--resource-group',
  '--container-app',
  '--postgres-server',
  '--database',
  '--help',
  '-h',
]);

const FORBIDDEN_ARGV_FLAGS = Object.freeze([
  ...AUTHORITY_FORBIDDEN_ARGV,
  '--dsn',
  '--connection-string',
  '--database-url',
  '--apply',
  '--mutate',
  '--live-apply',
]);

const FORBIDDEN_SQL_VERBS = Object.freeze([
  /\bBEGIN\b/i,
  /\bCOMMIT\b/i,
  /\bROLLBACK\b/i,
  /\bSAVEPOINT\b/i,
  /\bINSERT\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\b/i,
  /\bDROP\b/i,
  /\bALTER\b/i,
  /\bCREATE\b/i,
  /\bTRUNCATE\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /\bCOPY\b/i,
  /\bVACUUM\b/i,
  /\bREINDEX\b/i,
  /\bCLUSTER\b/i,
  /\bREFRESH\b/i,
  /\bCALL\b/i,
  /\bDO\b/i,
  /\bSET\b/i,
  /\bRESET\b/i,
  /\bLOCK\b/i,
  /\bDISCARD\b/i,
  /\bLISTEN\b/i,
  /\bNOTIFY\b/i,
  /\bUNLISTEN\b/i,
  /\bPREPARE\b/i,
  /\bEXECUTE\b/i,
  /\bDEALLOCATE\b/i,
]);

let clientsInstantiated = 0;
let connectCalls = 0;
let queryCalls = 0;
let endCalls = 0;

function resetLedgerEligibilityCounters() {
  clientsInstantiated = 0;
  connectCalls = 0;
  queryCalls = 0;
  endCalls = 0;
  resetTargetAuthorityCounters();
  resetManagedIdentityHttpCounters();
}

function getLedgerEligibilityCounters() {
  const auth = getTargetAuthorityCounters();
  const mi = getManagedIdentityHttpCounters();
  return {
    clientsInstantiated,
    connectCalls,
    queryCalls,
    endCalls,
    httpRequestCount: (auth.httpRequestCount || 0) + (mi.httpRequestCount || 0),
    imdsRequestCount: (auth.imdsRequestCount || 0) + (mi.imdsRequestCount || 0),
    armGetCount: auth.armGetCount || 0,
    armPostCount: auth.armPostCount || 0,
    listSecretsCount: auth.listSecretsCount || 0,
    keyVaultRequestCount: (auth.keyVaultRequestCount || 0) + (mi.keyVaultRequestCount || 0),
  };
}

function assertSelectOnlySql(sql) {
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
  if (!/^\s*SELECT\b/i.test(body)) {
    return { ok: false, code: 'not_select', message: 'only SELECT allowed' };
  }
  return { ok: true };
}

function parseArgvPairs(argv) {
  const flags = new Set();
  const values = Object.create(null);
  const forbidden = [];
  const unknown = [];
  const args = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (FORBIDDEN_ARGV_FLAGS.includes(a)) {
      forbidden.push(a);
      continue;
    }
    if (a === CLI_PROVE_LEDGER_ELIGIBILITY
      || a === CLI_PROVE_TARGET_AUTHORITY
      || a === '--help'
      || a === '-h') {
      flags.add(a);
      continue;
    }
    if (a.startsWith('--')) {
      const next = args[i + 1];
      if (next != null && !String(next).startsWith('--')) {
        values[a] = String(next);
        i += 1;
        if (!ALLOWED_ARGV_FLAGS.includes(a)) unknown.push(a);
      } else if (!ALLOWED_ARGV_FLAGS.includes(a)) {
        unknown.push(a);
      } else {
        flags.add(a);
      }
      continue;
    }
    unknown.push(a);
  }
  return { flags, values, forbidden, unknown };
}

function exactLedgerEligibilityArgv() {
  return [
    CLI_PROVE_LEDGER_ELIGIBILITY,
    CLI_PROVE_TARGET_AUTHORITY,
    '--subscription', LEDGER_LOCKS.subscriptionId,
    '--resource-group', LEDGER_LOCKS.resourceGroup,
    '--container-app', LEDGER_LOCKS.containerAppName,
    '--postgres-server', LEDGER_LOCKS.postgresServer,
    '--database', LEDGER_LOCKS.database,
    CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  ];
}

function ledgerEligibilityEnv() {
  return {
    ...targetAuthorityEnv(),
    [ENV_LEDGER_ELIGIBILITY]: '1',
  };
}

function evaluateLedgerEligibilityGates(opts) {
  const options = opts || {};
  const env = options.env || {};
  const parsed = parseArgvPairs(options.argv || []);
  const errors = [];

  if (PHASE_D_LIVE_READONLY_CONNECT_ENABLED !== true) {
    errors.push({ code: 'connect_not_enabled', message: 'PHASE_D_LIVE_READONLY_CONNECT_ENABLED must be true' });
  }
  if (PHASE_D_LIVE_APPLY_ENABLED !== false) {
    errors.push({ code: 'global_apply_must_remain_false', message: 'PHASE_D_LIVE_APPLY_ENABLED must remain false' });
  }
  if (PHASE_D_LEDGER_ELIGIBILITY_LIVE_ENABLED !== true) {
    errors.push({ code: 'ledger_eligibility_capability_disabled', message: 'ledger eligibility live disabled' });
  }
  if (PHASE_D_TARGET_AUTHORITY_LIVE_ENABLED !== true) {
    errors.push({ code: 'target_authority_capability_disabled', message: 'target authority live capability disabled' });
  }
  if (String(env[ENV_LIVE_READONLY] || '') !== '1') {
    errors.push({ code: 'live_readonly_flag_required', message: `${ENV_LIVE_READONLY}=1 required` });
  }
  if (String(env[ENV_LIVE_PREFLIGHT] || '') !== '1') {
    errors.push({ code: 'live_preflight_flag_required', message: `${ENV_LIVE_PREFLIGHT}=1 required` });
  }
  if (String(env[ENV_TARGET_AUTHORITY] || '') !== '1') {
    errors.push({ code: 'target_authority_env_required', message: `${ENV_TARGET_AUTHORITY}=1 required` });
  }
  if (String(env[ENV_LEDGER_ELIGIBILITY] || '') !== '1') {
    errors.push({
      code: 'ledger_eligibility_env_required',
      message: `${ENV_LEDGER_ELIGIBILITY}=1 required`,
    });
  }
  if (String(env[ENV_SUBSCRIPTION] || '') !== LEDGER_LOCKS.subscriptionId) {
    errors.push({ code: 'subscription_env_mismatch', message: 'AZURE_SUBSCRIPTION_ID must match locked subscription' });
  }
  if (String(env[ENV_CREDENTIAL_SOURCE] || '') !== CREDENTIAL_SOURCE_MANAGED_IDENTITY) {
    errors.push({
      code: 'managed_identity_credential_source_flag_required',
      message: `env ${ENV_CREDENTIAL_SOURCE}=managed-identity required`,
    });
  }
  if (!parsed.flags.has(CLI_PROVE_LEDGER_ELIGIBILITY)) {
    errors.push({
      code: 'ledger_eligibility_flag_required',
      message: `${CLI_PROVE_LEDGER_ELIGIBILITY} required`,
    });
  }
  if (!parsed.flags.has(CLI_PROVE_TARGET_AUTHORITY)) {
    errors.push({
      code: 'target_authority_flag_required',
      message: `${CLI_PROVE_TARGET_AUTHORITY} required`,
    });
  }
  if (parsed.values[CLI_CREDENTIAL_SOURCE] !== CREDENTIAL_SOURCE_MANAGED_IDENTITY) {
    errors.push({
      code: 'managed_identity_credential_source_flag_required',
      message: `argv ${CLI_CREDENTIAL_SOURCE} managed-identity required`,
    });
  }
  if (parsed.forbidden.length > 0) {
    errors.push({ code: 'forbidden_argv', message: `forbidden argv: ${parsed.forbidden.join(',')}` });
  }
  if (parsed.unknown.length > 0) {
    errors.push({ code: 'unknown_argv', message: `unknown argv: ${parsed.unknown.join(',')}` });
  }

  const expect = {
    '--subscription': LEDGER_LOCKS.subscriptionId,
    '--resource-group': LEDGER_LOCKS.resourceGroup,
    '--container-app': LEDGER_LOCKS.containerAppName,
    '--postgres-server': LEDGER_LOCKS.postgresServer,
    '--database': LEDGER_LOCKS.database,
  };
  for (const [flag, want] of Object.entries(expect)) {
    if (String(parsed.values[flag] || '') !== want) {
      errors.push({ code: 'exact_target_mismatch', message: `${flag} must equal locked ${want}` });
    }
  }

  return { ok: errors.length === 0, errors, parsed };
}

function stripSqlComments(sql) {
  let out = String(sql || '');
  out = out.replace(/\/\*[\s\S]*?\*\//g, ' ');
  out = out.replace(/--[^\n]*/g, ' ');
  return out;
}

function stripCreateFunctionBodies(sql) {
  let out = String(sql || '');
  const tagRe = /\$([a-zA-Z_][a-zA-Z0-9_]*)\$/g;
  const upper = out.toUpperCase();
  let searchFrom = 0;
  while (true) {
    const idx = upper.indexOf('CREATE', searchFrom);
    if (idx < 0) break;
    const fnIdx = upper.indexOf('FUNCTION', idx);
    if (fnIdx < 0 || fnIdx > idx + 40) {
      searchFrom = idx + 6;
      continue;
    }
    tagRe.lastIndex = fnIdx;
    const open = tagRe.exec(out);
    if (!open) {
      searchFrom = fnIdx + 8;
      continue;
    }
    const openTag = open[0];
    const closeTag = openTag;
    const bodyStart = open.index + openTag.length;
    const closeIdx = out.indexOf(closeTag, bodyStart);
    if (closeIdx < 0) {
      searchFrom = bodyStart;
      continue;
    }
    out = `${out.slice(0, bodyStart)} /* function_body_stripped */ ${out.slice(closeIdx + closeTag.length)}`;
    searchFrom = bodyStart + 24;
  }
  return out;
}

function splitExecutableStatements(sql) {
  const cleaned = stripSqlComments(stripCreateFunctionBodies(sql));
  const parts = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  let dollarTag = null;
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    const next2 = cleaned.slice(i, i + 2);
    if (!inSingle && !inDouble && !dollarTag && next2 === '$$') {
      dollarTag = '$$';
      buf += next2;
      i += 1;
      continue;
    }
    if (dollarTag === '$$' && next2 === '$$') {
      buf += next2;
      i += 1;
      dollarTag = null;
      continue;
    }
    if (!dollarTag && ch === "'" && !inDouble) {
      inSingle = !inSingle;
      buf += ch;
      continue;
    }
    if (!dollarTag && ch === '"' && !inSingle) {
      inDouble = !inDouble;
      buf += ch;
      continue;
    }
    if (!inSingle && !inDouble && !dollarTag && ch === ';') {
      const piece = buf.trim();
      if (piece) parts.push(piece);
      buf = '';
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) parts.push(tail);
  return parts.filter((p) => !/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(p));
}

function unquoteIdent(raw) {
  const s = String(raw || '').trim();
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

function makeEffect(className, kind, identity, detail, weakSignature, supersedable) {
  return {
    class: className,
    kind,
    identity,
    detail: detail || null,
    weakSignature: weakSignature === true,
    supersedable: supersedable === true,
  };
}

function parseMigrationEffects(sql, meta) {
  const id = meta && meta.id ? String(meta.id) : null;
  const filename = meta && meta.filename ? String(meta.filename) : null;
  const statements = splitExecutableStatements(sql);
  const effects = [];
  let effectSeq = 0;

  function pushEffect(effect) {
    effectSeq += 1;
    effects.push({
      effectId: `${id || filename || 'migration'}#${effectSeq}`,
      ...effect,
    });
  }

  for (const stmt of statements) {
    const s = stmt.replace(/\s+/g, ' ').trim();
    if (!s) continue;
    const upper = s.toUpperCase();

    if (/^CREATE\s+TABLE\b/i.test(s)) {
      const m = s.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/i);
      const table = m ? unquoteIdent(m[1].split('.').pop()) : 'unknown';
      pushEffect(makeEffect('tables', 'create_table', `public.${table}`, s.slice(0, 200), false, false));
      const colRe = /^\s*([a-zA-Z_][\w"]*)\s+([A-Z][A-Z0-9_]*)/gm;
      let cm;
      const body = s.replace(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[^(]+\(/i, '').replace(/\)\s*;?\s*$/, '');
      while ((cm = colRe.exec(body)) !== null) {
        const col = unquoteIdent(cm[1]);
        if (/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)$/i.test(col)) continue;
        pushEffect(makeEffect('columns', 'create_table_column', `public.${table}.${col}`, cm[0].trim(), false, false));
      }
      continue;
    }

    if (/^ALTER\s+TABLE\b/i.test(s)) {
      const tm = s.match(/ALTER\s+TABLE\s+(?:ONLY\s+)?([^\s]+)/i);
      const table = tm ? unquoteIdent(tm[1].split('.').pop()) : 'unknown';
      if (/ADD\s+COLUMN\b/i.test(s)) {
        const cm = s.match(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s]+)/i);
        const col = cm ? unquoteIdent(cm[1]) : 'unknown';
        pushEffect(makeEffect('columns', 'add_column', `public.${table}.${col}`, s.slice(0, 200), false, false));
        if (/DEFAULT\b/i.test(s)) {
          pushEffect(makeEffect('defaults', 'column_default', `public.${table}.${col}`, s.slice(0, 200), false, true));
        }
      }
      if (/DROP\s+NOT\s+NULL/i.test(s) || /SET\s+NOT\s+NULL/i.test(s)) {
        const cm = s.match(/ALTER\s+COLUMN\s+([^\s]+)/i);
        const col = cm ? unquoteIdent(cm[1]) : 'unknown';
        pushEffect(makeEffect('columns', 'alter_nullability', `public.${table}.${col}`, s.slice(0, 200), true, true));
      }
      if (/ADD\s+CONSTRAINT\b/i.test(s)) {
        const nm = s.match(/ADD\s+CONSTRAINT\s+([^\s]+)/i);
        const name = nm ? unquoteIdent(nm[1]) : 'unknown';
        pushEffect(makeEffect('constraints', 'add_constraint', `public.${table}.${name}`, s.slice(0, 200), false, false));
      }
      if (/DROP\s+CONSTRAINT\b/i.test(s)) {
        const nm = s.match(/DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?([^\s]+)/i);
        const name = nm ? unquoteIdent(nm[1]) : 'unknown';
        pushEffect(makeEffect('drops', 'drop_constraint', `public.${table}.${name}`, s.slice(0, 200), true, false));
      }
      if (/RENAME\s+TO\b/i.test(s) && /ALTER\s+TABLE\b/i.test(s) && !/RENAME\s+COLUMN\b/i.test(s)) {
        pushEffect(makeEffect('renames', 'rename_table', `public.${table}`, s.slice(0, 200), true, false));
      }
      if (/RENAME\s+COLUMN\b/i.test(s)) {
        const rm = s.match(/RENAME\s+COLUMN\s+([^\s]+)\s+TO\s+([^\s;]+)/i);
        const from = rm ? unquoteIdent(rm[1]) : 'unknown';
        const to = rm ? unquoteIdent(rm[2]) : 'unknown';
        pushEffect(makeEffect('renames', 'rename_column', `public.${table}.${from}->${to}`, s.slice(0, 200), true, false));
      }
      continue;
    }

    if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(s)) {
      const im = s.match(/INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s]+)/i);
      const name = im ? unquoteIdent(im[1]) : 'unknown';
      const tm = s.match(/\bON\s+([^\s(]+)/i);
      const table = tm ? unquoteIdent(tm[1].split('.').pop()) : 'unknown';
      pushEffect(makeEffect('indexes', 'create_index', `public.${table}.${name}`, s.slice(0, 200), false, false));
      continue;
    }

    if (/^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i.test(s)) {
      const fm = s.match(/FUNCTION\s+([^(]+)\(/i);
      const fn = fm ? fm[1].trim().replace(/\s+/g, '') : 'unknown';
      // Ephemeral pg_temp helpers are not durable catalog outcomes.
      if (/^pg_temp\./i.test(fn) || /\.pg_temp\./i.test(fn)) {
        continue;
      }
      pushEffect(makeEffect('functions', 'create_function', fn, s.slice(0, 120), false, true));
      continue;
    }

    if (/^CREATE\s+TRIGGER\b/i.test(s)) {
      const tr = s.match(/TRIGGER\s+([^\s]+)/i);
      const name = tr ? unquoteIdent(tr[1]) : 'unknown';
      const tm = s.match(/\bON\s+([^\s]+)/i);
      const table = tm ? unquoteIdent(tm[1].split('.').pop()) : 'unknown';
      pushEffect(makeEffect('triggers', 'create_trigger', `public.${table}.${name}`, s.slice(0, 200), false, false));
      continue;
    }

    if (/^CREATE\s+TYPE\b/i.test(s) && /AS\s+ENUM\b/i.test(s)) {
      const em = s.match(/TYPE\s+([^\s]+)/i);
      const name = em ? unquoteIdent(em[1].split('.').pop()) : 'unknown';
      pushEffect(makeEffect('enums', 'create_enum', `public.${name}`, s.slice(0, 200), false, false));
      continue;
    }

    if (/^CREATE\s+TYPE\b/i.test(s)) {
      const tm = s.match(/TYPE\s+([^\s]+)/i);
      const name = tm ? unquoteIdent(tm[1].split('.').pop()) : 'unknown';
      pushEffect(makeEffect('types', 'create_type', `public.${name}`, s.slice(0, 200), false, false));
      continue;
    }

    if (/^CREATE\s+EXTENSION\b/i.test(s)) {
      const em = s.match(/EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([^"\s]+)"?/i);
      const name = em ? em[1] : 'unknown';
      pushEffect(makeEffect('extensions', 'create_extension', name, s.slice(0, 120), false, false));
      continue;
    }

    if (/^COMMENT\s+ON\b/i.test(s)) {
      pushEffect(makeEffect('comments', 'comment_on', s.slice(0, 120), s.slice(0, 200), true, true));
      continue;
    }

    if (/^ALTER\s+TABLE\b.*\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(s)) {
      const tm = s.match(/ALTER\s+TABLE\s+([^\s]+)/i);
      const table = tm ? unquoteIdent(tm[1].split('.').pop()) : 'unknown';
      pushEffect(makeEffect('rls', 'enable_rls', `public.${table}`, s.slice(0, 120), false, false));
      continue;
    }

    if (/^CREATE\s+POLICY\b/i.test(s)) {
      const pm = s.match(/POLICY\s+([^\s]+)\s+ON\s+([^\s]+)/i);
      const policy = pm ? unquoteIdent(pm[1]) : 'unknown';
      const table = pm ? unquoteIdent(pm[2].split('.').pop()) : 'unknown';
      pushEffect(makeEffect('policies', 'create_policy', `public.${table}.${policy}`, s.slice(0, 200), false, false));
      continue;
    }

    if (/^DROP\s+/i.test(s)) {
      pushEffect(makeEffect('drops', 'drop_object', s.slice(0, 80), s.slice(0, 200), true, false));
      continue;
    }

    if (/^(INSERT|UPDATE|DELETE)\b/i.test(s)) {
      pushEffect(makeEffect('data_mutations', upper.split(/\s+/)[0].toLowerCase(), s.slice(0, 80), s.slice(0, 200), true, true));
      continue;
    }

    if (/^ALTER\s+TYPE\b/i.test(s) && /RENAME\b/i.test(s)) {
      pushEffect(makeEffect('renames', 'rename_type', s.slice(0, 80), s.slice(0, 200), true, false));
      continue;
    }
  }

  const overrides = DURABLE_EFFECT_OVERRIDES[id];
  if (overrides && overrides.length) {
    for (const ov of overrides) {
      pushEffect(makeEffect(
        ov.class,
        ov.kind,
        ov.identity,
        `durable_override:${id}:${ov.identity}`,
        ov.weakSignature === true,
        ov.supersedable === true,
      ));
    }
  }

  return effects;
}

function catalogSectionForClass(className) {
  switch (className) {
    case 'tables': return 'tables';
    case 'columns':
    case 'defaults': return 'columns';
    case 'constraints': return 'constraints';
    case 'indexes': return 'indexes';
    case 'enums': return 'enums';
    case 'functions': return 'functions';
    case 'triggers': return 'triggers';
    case 'extensions': return 'extensions';
    case 'rls': return 'rlsFlags';
    case 'policies': return 'rlsPolicies';
    case 'comments': return 'comments';
    default: return null;
  }
}

function buildCatalogMatcher(effect) {
  const identity = String(effect.identity || '');
  if (effect.kind === 'rename_source_absent') {
    const table = identity.replace(/^public\./, '').split('.')[0];
    return { section: 'tables', key: table, expectPresent: false };
  }
  if (effect.kind === 'rename_target_present') {
    const table = identity.replace(/^public\./, '').split('.')[0];
    return { section: 'tables', key: table, expectPresent: true };
  }
  if (effect.class === 'tables') {
    const table = identity.split('.').pop();
    return { section: 'tables', key: table, expectPresent: true };
  }
  if (effect.class === 'columns' || effect.class === 'defaults') {
    const parts = identity.replace(/^public\./, '').split('.');
    if (parts.length >= 2) {
      return { section: 'columns', key: `${parts[0]}.${parts[1]}`, expectPresent: true };
    }
  }
  if (effect.class === 'constraints') {
    const m = identity.match(/^public\.([^.]+)\.(.+)$/);
    if (m) return { section: 'constraints', key: `${m[1]}.${m[2]}`, partial: true };
  }
  if (effect.class === 'indexes') {
    const m = identity.match(/^public\.([^.]+)\.(.+)$/);
    if (m) return { section: 'indexes', key: `${m[1]}.${m[2]}`, expectPresent: true };
  }
  if (effect.class === 'enums') {
    return { section: 'enums', key: identity.split('.').pop(), partial: true };
  }
  if (effect.class === 'functions') {
    return { section: 'functions', key: identity, partial: true };
  }
  if (effect.class === 'triggers') {
    const m = identity.match(/^public\.([^.]+)\.(.+)$/);
    if (m) return { section: 'triggers', key: `${m[1]}.${m[2]}`, expectPresent: true };
  }
  if (effect.class === 'extensions') {
    return { section: 'extensions', key: identity, expectPresent: true };
  }
  return null;
}

function dec006ProofDescriptors(entry) {
  const reqs = DEC006_RESOLUTION_REQUIREMENTS[entry.id];
  if (!reqs) return [];
  return reqs.map((req) => {
    const sql = DEC006_PROOF_SQL[req.id];
    return {
      effectId: `${entry.id}::${req.id}`,
      proofKind: req.id.includes('aggregate') ? 'aggregate_select' : 'targeted_select',
      evidenceRef: `dec006:${req.id}`,
      matcher: { checkId: req.id, sql },
      required: req.required === true,
      weak: req.weak === true,
    };
  });
}

function buildProofPlan(entry, effects) {
  const plan = [];
  if (DEC006_MIGRATION_IDS.includes(entry.id)) {
    plan.push(...dec006ProofDescriptors(entry));
  }
  for (const effect of effects || []) {
    if (effect.weakSignature) {
      if (effect.class === 'data_mutations') {
        plan.push({
          effectId: effect.effectId,
          proofKind: 'aggregate_select',
          evidenceRef: `weak:${effect.class}:${effect.kind}`,
          matcher: { weakDml: true, identity: effect.identity },
          required: false,
          weak: true,
        });
      } else if (effect.class === 'comments') {
        plan.push({
          effectId: effect.effectId,
          proofKind: 'catalog_snapshot',
          evidenceRef: `weak:${effect.class}`,
          matcher: { commentWeak: true, identity: effect.identity },
          required: false,
          weak: true,
        });
      } else if (effect.class === 'renames') {
        plan.push({
          effectId: effect.effectId,
          proofKind: 'catalog_snapshot',
          evidenceRef: `weak:${effect.class}:${effect.identity}`,
          matcher: {
            renameOrDrop: true,
            identity: effect.identity,
            detail: effect.detail,
            expectPresent: true,
          },
          required: true,
          weak: true,
        });
      } else if (effect.class === 'drops') {
        // DROP IF EXISTS is weak — absence alone is not durable proof when later migrations recreate.
        plan.push({
          effectId: effect.effectId,
          proofKind: 'catalog_snapshot',
          evidenceRef: `weak:${effect.class}:${effect.identity}`,
          matcher: { renameOrDrop: true, identity: effect.identity, detail: effect.detail },
          required: false,
          weak: true,
        });
      } else if (effect.kind === 'alter_nullability') {
        const expectNullable = /DROP\s+NOT\s+NULL/i.test(String(effect.detail || ''));
        plan.push({
          effectId: effect.effectId,
          proofKind: 'catalog_snapshot',
          evidenceRef: `weak:nullability:${effect.identity}`,
          matcher: {
            nullabilityWeak: true,
            identity: effect.identity,
            expectNullable,
          },
          required: true,
          weak: true,
        });
      }
      continue;
    }
    const catalogMatcher = buildCatalogMatcher(effect);
    if (catalogMatcher && catalogSectionForClass(effect.class)) {
      plan.push({
        effectId: effect.effectId,
        proofKind: 'catalog_snapshot',
        evidenceRef: `catalog:${effect.class}:${effect.identity}`,
        matcher: catalogMatcher,
        required: true,
        weak: false,
      });
    }
  }
  return plan;
}

function sectionHasKey(snap, section, key) {
  if (section === 'tables') {
    return (snap.tables || []).includes(key)
      || (snap.tables || []).some((t) => (typeof t === 'string' ? t : t.name) === key);
  }
  if (section === 'columns') {
    return (snap.columns || []).some((c) => `${c.table}.${c.column}` === key);
  }
  if (section === 'indexes') {
    return (snap.indexes || []).some((i) => `${i.table}.${i.name}` === key);
  }
  if (section === 'constraints') {
    const prefix = key.endsWith('.') ? key : `${key}.`;
    return (snap.constraints || []).some((c) => {
      const id = `${c.table}.${c.name}.`;
      return id.startsWith(prefix) || `${c.table}.${c.name}` === key;
    });
  }
  if (section === 'functions') {
    return (snap.functions || []).some((f) => {
      const id = String(f.identity || f.name || '');
      return id === key || id.includes(key) || id.startsWith(`${key}(`);
    });
  }
  if (section === 'triggers') {
    return (snap.triggers || []).some((t) => `${t.table}.${t.name}` === key);
  }
  if (section === 'extensions') {
    return (snap.extensions || []).some((e) => e.name === key);
  }
  if (section === 'enums') {
    return (snap.enums || []).some((e) => e.type === key);
  }
  if (section === 'rlsFlags') {
    return (snap.rlsFlags || []).some((r) => r.table === key || r.name === key);
  }
  if (section === 'rlsPolicies') {
    return (snap.rlsPolicies || []).some((p) => `${p.tablename || p.table}.${p.policyname || p.name}` === key);
  }
  return null;
}

function snapshotHasCatalogMatch(snapshot, matcher) {
  const snap = snapshot || {};
  if (!matcher) return { ok: false, reason: 'no_matcher' };

  if (matcher.renameOrDrop === true) {
    const identity = String(matcher.identity || '');
    const detail = String(matcher.detail || '');
    const typeRename = detail.match(/ALTER\s+TYPE\s+([^\s]+)\s+RENAME\s+TO\s+([^\s;]+)/i)
      || identity.match(/ALTER\s+TYPE\s+([^\s]+)\s+RENAME\s+TO\s+([^\s;]+)/i);
    if (typeRename) {
      const toType = unquoteIdent(typeRename[2]);
      const fromType = unquoteIdent(typeRename[1]);
      const toOk = sectionHasKey(snap, 'enums', toType) === true;
      const fromGone = sectionHasKey(snap, 'enums', fromType) !== true;
      return { ok: toOk && fromGone, found: toOk, viaAlias: true };
    }
    if (/hostels/i.test(identity) || /RENAME TO clients/i.test(detail) || /hostels.*clients/i.test(detail)) {
      const clients = sectionHasKey(snap, 'tables', 'clients') === true;
      const hostels = sectionHasKey(snap, 'tables', 'hostels') === true;
      return { ok: clients && !hostels, found: clients, viaAlias: true };
    }
    if (matcher.expectPresent === false) {
      const table = identity.replace(/^public\./, '').split('.')[0];
      const found = sectionHasKey(snap, 'tables', table) === true;
      return { ok: !found, found, viaAlias: false };
    }
    if (matcher.expectPresent === true || /\.clients\b|^public\.clients$/i.test(identity)) {
      const table = identity.replace(/^public\./, '').split(/[.\s]/)[0];
      const found = sectionHasKey(snap, 'tables', table) === true;
      return { ok: found, found, viaAlias: table === 'clients' };
    }
    return { ok: false, reason: 'rename_unproven' };
  }

  if (matcher.nullabilityWeak === true) {
    const identity = String(matcher.identity || '').replace(/^public\./, '');
    const [table, column] = identity.split('.');
    const col = (snap.columns || []).find((c) => c.table === table && c.column === column);
    if (!col) return { ok: false, reason: 'column_missing', found: false };
    // SET NOT NULL → nullable NO; DROP NOT NULL → nullable YES. Infer from absence of expectNullable.
    const expectNullable = matcher.expectNullable;
    if (expectNullable === true) return { ok: col.nullable === 'YES', found: true, viaAlias: false };
    if (expectNullable === false) return { ok: col.nullable === 'NO', found: true, viaAlias: false };
    // Default: column present is enough for weak nullability proof when paired with strong ADD COLUMN.
    return { ok: true, found: true, viaAlias: false };
  }

  const section = matcher.section;
  if (!section) return { ok: false, reason: 'unsupported_section' };

  const expectPresent = matcher.expectPresent !== false;
  let found = sectionHasKey(snap, section, matcher.key);
  if (found === null) return { ok: false, reason: 'unsupported_section' };

  let viaAlias = false;
  if (!found && expectPresent) {
    const aliasMap = CURRENT_STATE_ALIASES[section] || null;
    const aliasKey = aliasMap ? aliasMap[matcher.key] : null;
    if (aliasKey) {
      found = sectionHasKey(snap, section, aliasKey) === true;
      viaAlias = found === true;
    }
  }

  if (matcher.partial === true && (section === 'enums' || section === 'constraints' || section === 'functions')) {
    return { ok: found === true, found, viaAlias };
  }
  return { ok: found === expectPresent, found, viaAlias };
}

function evaluateDec006Check(checkId, rows) {
  const data = Array.isArray(rows) ? rows : [];
  switch (checkId) {
    case '018-col-nullability': {
      const row = data[0] || {};
      return String(row.is_nullable || '').toUpperCase() === 'YES';
    }
    case '018-no-conflicting-check': {
      const row = data[0] || {};
      return Number(row.cnt || 0) === 0;
    }
    case '018-optional-comment': {
      const row = data[0] || {};
      return row.comment_text != null && String(row.comment_text).length > 0;
    }
    case '019-column-present': {
      const row = data[0] || {};
      const udt = String(row.udt_name || row.data_type || '').toLowerCase();
      return row.column_name === 'language' && (udt === 'text' || udt === 'varchar');
    }
    case '019-default-or-nullability': {
      const row = data[0] || {};
      const def = String(row.column_default || '');
      return def.includes("'en'") || def.toLowerCase().includes('en');
    }
    case '020-columns-present': {
      const cols = new Set(data.map((r) => r.column_name));
      return ['gender_strategy', 'room_type', 'can_be_matrimonial', 'often_used_by_operator']
        .every((c) => cols.has(c));
    }
    case '020-tenant-scoped-dml-rows': {
      return evaluate020TenantScopedDml(data[0] || {}).ok === true;
    }
    default:
      return false;
  }
}

function coerceNonNegativeInt(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

/**
 * Migration 020 DML is tenant-scoped to clients.slug='wolfhouse-somo' and R1..R10.
 * Zero applicable rows on isolated Sunset is vacuously complete (safe to skip), not unproven.
 */
function evaluate020TenantScopedDml(row) {
  const raw = row || {};
  const clientSlugCount = coerceNonNegativeInt(raw.client_slug_count);
  const applicableRows = coerceNonNegativeInt(raw.applicable_rows);
  const mismatchingRows = coerceNonNegativeInt(raw.mismatching_rows);
  const duplicateRoomCodeCount = coerceNonNegativeInt(
    raw.duplicate_room_code_count != null ? raw.duplicate_room_code_count : 0,
  );

  if (
    clientSlugCount == null
    || applicableRows == null
    || mismatchingRows == null
    || duplicateRoomCodeCount == null
  ) {
    return {
      ok: false,
      reason: BLOCKED_REASON_QUERY_AMBIGUITY,
      applicable_rows: applicableRows,
      mismatching_rows: mismatchingRows,
      client_slug_count: clientSlugCount,
      duplicate_room_code_count: duplicateRoomCodeCount,
    };
  }

  if (clientSlugCount > 1) {
    return {
      ok: false,
      reason: BLOCKED_REASON_AMBIGUOUS_SLUG,
      applicable_rows: applicableRows,
      mismatching_rows: mismatchingRows,
      client_slug_count: clientSlugCount,
      duplicate_room_code_count: duplicateRoomCodeCount,
    };
  }

  if (duplicateRoomCodeCount > 0) {
    return {
      ok: false,
      reason: BLOCKED_REASON_ROOM_MULTIPLICITY,
      applicable_rows: applicableRows,
      mismatching_rows: mismatchingRows,
      client_slug_count: clientSlugCount,
      duplicate_room_code_count: duplicateRoomCodeCount,
    };
  }

  if (applicableRows > 0 && clientSlugCount !== 1) {
    return {
      ok: false,
      reason: BLOCKED_REASON_QUERY_AMBIGUITY,
      applicable_rows: applicableRows,
      mismatching_rows: mismatchingRows,
      client_slug_count: clientSlugCount,
      duplicate_room_code_count: duplicateRoomCodeCount,
    };
  }

  if (mismatchingRows > 0) {
    return {
      ok: false,
      reason: BLOCKED_REASON_DML_MISMATCH,
      applicable_rows: applicableRows,
      mismatching_rows: mismatchingRows,
      client_slug_count: clientSlugCount,
      duplicate_room_code_count: duplicateRoomCodeCount,
    };
  }

  if (applicableRows === 0 && mismatchingRows === 0) {
    return {
      ok: true,
      reason: ELIGIBILITY_REASON_VACUOUS,
      applicable_rows: applicableRows,
      mismatching_rows: mismatchingRows,
      client_slug_count: clientSlugCount,
      duplicate_room_code_count: duplicateRoomCodeCount,
    };
  }

  if (applicableRows > 0 && mismatchingRows === 0) {
    return {
      ok: true,
      reason: ELIGIBILITY_REASON_MATCHED,
      applicable_rows: applicableRows,
      mismatching_rows: mismatchingRows,
      client_slug_count: clientSlugCount,
      duplicate_room_code_count: duplicateRoomCodeCount,
    };
  }

  return {
    ok: false,
    reason: BLOCKED_REASON_QUERY_AMBIGUITY,
    applicable_rows: applicableRows,
    mismatching_rows: mismatchingRows,
    client_slug_count: clientSlugCount,
    duplicate_room_code_count: duplicateRoomCodeCount,
  };
}

function extractTargetedRows(targetedResults, checkId) {
  const results = targetedResults || {};
  let rows = results[`dec006:${checkId}`] != null
    ? results[`dec006:${checkId}`]
    : results[checkId];
  if (rows && !Array.isArray(rows) && Array.isArray(rows.rows)) rows = rows.rows;
  return Array.isArray(rows) ? rows : null;
}

function evaluateTargetedProof(descriptor, targetedResults) {
  const results = targetedResults || {};
  const checkId = descriptor.matcher && descriptor.matcher.checkId;
  if (checkId) {
    const key = descriptor.evidenceRef || checkId;
    let rows = results[key] != null ? results[key] : results[checkId];
    if (rows && !Array.isArray(rows) && Array.isArray(rows.rows)) rows = rows.rows;
    if (rows == null) return { ok: false, reason: 'missing_targeted_result' };
    const pass = evaluateDec006Check(checkId, rows);
    return { ok: pass, reason: pass ? 'dec006_pass' : 'dec006_fail' };
  }
  return { ok: false, reason: 'unsupported_targeted_proof' };
}

function summarizeEffects(effects) {
  const summary = {};
  for (const e of effects || []) {
    summary[e.class] = (summary[e.class] || 0) + 1;
  }
  summary.weakCount = (effects || []).filter((e) => e.weakSignature).length;
  summary.strongCount = (effects || []).filter((e) => !e.weakSignature).length;
  return summary;
}

function evaluateMigrationEligibility(ctx) {
  const {
    entry,
    effects,
    proofPlan,
    liveSnapshot,
    targetedResults,
    options,
  } = ctx || {};
  const opts = options || {};
  const evidenceRefs = [];
  const dec006 = { migrationId: entry.id, requiredChecks: [], optionalChecks: [] };
  let blockedReason = null;
  let classification = CLASSIFICATION_BLOCKED_UNPROVEN;
  let applyKind = null;
  let eligibilityReason = null;
  let migration020Dml = null;

  if (opts.forbiddenApplyKind === APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER) {
    return {
      id: entry.id,
      filename: entry.filename,
      apply_order: entry.order,
      classification: CLASSIFICATION_BLOCKED_UNPROVEN,
      blockedReason: 'mislabel_executed_runner_forbidden',
      dec006,
      effectSummary: summarizeEffects(effects),
      evidenceRefs,
      apply_kind: null,
    };
  }

  const requiredProofs = (proofPlan || []).filter((p) => p.required);
  const failedRequired = [];
  const weakOnlyFailures = [];
  let usedCurrentStateAlias = false;

  for (const proof of proofPlan || []) {
    if (proof.proofKind === 'catalog_snapshot') {
      if (proof.matcher && proof.matcher.commentWeak) {
        continue;
      }
      if (proof.matcher && proof.matcher.nullabilityWeak && DEC006_MIGRATION_IDS.includes(entry.id)) {
        continue;
      }
      const match = snapshotHasCatalogMatch(liveSnapshot, {
        ...proof.matcher,
        detail: proof.matcher && proof.matcher.detail,
      });
      if (match.viaAlias) usedCurrentStateAlias = true;
      if (proof.required && !match.ok) failedRequired.push(proof);
      if (match.ok) evidenceRefs.push(proof.evidenceRef);
    } else if (proof.proofKind === 'targeted_select' || proof.proofKind === 'aggregate_select') {
      const evalResult = evaluateTargetedProof(proof, targetedResults);
      const checkId = proof.matcher && proof.matcher.checkId;
      if (checkId) {
        const bucket = proof.weak ? dec006.optionalChecks : dec006.requiredChecks;
        bucket.push({ id: checkId, pass: evalResult.ok });
      }
      if (proof.required && !evalResult.ok) failedRequired.push(proof);
      else if (!proof.required && !evalResult.ok) weakOnlyFailures.push(proof);
      else if (evalResult.ok) evidenceRefs.push(proof.evidenceRef);
    }
  }

  if (DEC006_MIGRATION_IDS.includes(entry.id)) {
    const reqs = DEC006_RESOLUTION_REQUIREMENTS[entry.id] || [];
    for (const req of reqs) {
      if (!req.required) continue;
      const bucket = dec006.requiredChecks.find((c) => c.id === req.id);
      if (!bucket || bucket.pass !== true) {
        failedRequired.push({ evidenceRef: `dec006:${req.id}` });
      }
    }
  }

  const hasWeakOnly = (effects || []).length > 0
    && (effects || []).every((e) => e.weakSignature);
  const hasDataMutation = (effects || []).some((e) => e.class === 'data_mutations');
  const hasRename = (effects || []).some((e) => e.class === 'renames' || e.kind === 'rename_target_present');

  if (failedRequired.length > 0) {
    blockedReason = DEC006_MIGRATION_IDS.includes(entry.id)
      ? 'dec006_required_checks_failed'
      : 'partial_effect_unproven';
    classification = CLASSIFICATION_BLOCKED_UNPROVEN;
  } else if (entry.id === '020_wolfhouse_room_gender_metadata') {
    const dmlRows = extractTargetedRows(targetedResults, '020-tenant-scoped-dml-rows');
    if (dmlRows == null) {
      migration020Dml = {
        ok: false,
        reason: BLOCKED_REASON_QUERY_AMBIGUITY,
        applicable_rows: null,
        mismatching_rows: null,
      };
    } else if (dmlRows.length !== 1) {
      migration020Dml = {
        ok: false,
        reason: BLOCKED_REASON_QUERY_AMBIGUITY,
        applicable_rows: null,
        mismatching_rows: null,
        result_row_count: dmlRows.length,
      };
    } else {
      migration020Dml = evaluate020TenantScopedDml(dmlRows[0]);
    }
    const dmlCheck = dec006.optionalChecks.find((c) => c.id === '020-tenant-scoped-dml-rows');
    if (dmlCheck) dmlCheck.pass = migration020Dml.ok === true;
    if (migration020Dml.ok === true) {
      classification = CLASSIFICATION_ELIGIBLE_CURRENT_STATE;
      applyKind = APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE;
      blockedReason = null;
      eligibilityReason = migration020Dml.reason;
      usedCurrentStateAlias = true;
      if (!evidenceRefs.includes('dec006:020-tenant-scoped-dml-rows')) {
        evidenceRefs.push('dec006:020-tenant-scoped-dml-rows');
      }
    } else {
      blockedReason = migration020Dml.reason || BLOCKED_REASON_QUERY_AMBIGUITY;
      classification = CLASSIFICATION_BLOCKED_UNPROVEN;
      applyKind = null;
      eligibilityReason = null;
    }
  } else if (DEC006_MIGRATION_IDS.includes(entry.id)) {
    // 018/019: catalog-proven nullability/column metadata → structural baseline
    classification = usedCurrentStateAlias
      ? CLASSIFICATION_ELIGIBLE_CURRENT_STATE
      : CLASSIFICATION_ELIGIBLE_STRUCTURAL;
    applyKind = usedCurrentStateAlias
      ? APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE
      : APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE;
    blockedReason = null;
  } else if (hasWeakOnly && !usedCurrentStateAlias && evidenceRefs.length === 0) {
    const unprovenWeak = (effects || []).filter((e) => e.weakSignature);
    if (unprovenWeak.some((e) => e.class === 'comments')) {
      blockedReason = 'unproven_comment';
    } else if (unprovenWeak.some((e) => e.class === 'renames')) {
      blockedReason = 'unproven_rename';
    } else if (unprovenWeak.some((e) => e.class === 'data_mutations')) {
      blockedReason = 'unproven_dml';
    } else {
      blockedReason = 'weak_signature_unproven';
    }
    classification = CLASSIFICATION_BLOCKED_UNPROVEN;
  } else if (usedCurrentStateAlias || hasRename) {
    classification = CLASSIFICATION_ELIGIBLE_CURRENT_STATE;
    applyKind = APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE;
    blockedReason = null;
  } else {
    classification = CLASSIFICATION_ELIGIBLE_STRUCTURAL;
    applyKind = APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE;
    blockedReason = null;
  }

  if (applyKind === APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER) {
    classification = CLASSIFICATION_BLOCKED_UNPROVEN;
    blockedReason = 'mislabel_executed_runner_forbidden';
    applyKind = null;
  }

  return {
    id: entry.id,
    filename: entry.filename,
    apply_order: entry.order,
    checksum_sha256: entry.sha256,
    checksum_mode: CHECKSUM_MODE_CANONICAL_LF_V1,
    classification,
    apply_kind: applyKind,
    blockedReason,
    eligibilityReason,
    migration020Dml: entry.id === '020_wolfhouse_room_gender_metadata' ? migration020Dml : null,
    dec006: DEC006_MIGRATION_IDS.includes(entry.id) ? dec006 : null,
    effectSummary: summarizeEffects(effects),
    evidenceRefs,
    weakOnlyFailures: weakOnlyFailures.map((p) => p.evidenceRef),
  };
}

function computeContiguousPrefix(evaluations) {
  const sorted = (evaluations || []).slice().sort((a, b) => a.apply_order - b.apply_order);
  let maxPrefixOrder = 0;
  let maxPrefixCount = 0;
  let firstBlocker = null;
  let prefixBroken = false;
  const evaluationsWithPrefix = [];
  const proposedLedgerRows = [];

  for (const ev of sorted) {
    let prefixStatus = ev.classification;
    if (prefixBroken) {
      if (ev.classification === CLASSIFICATION_ELIGIBLE_STRUCTURAL
        || ev.classification === CLASSIFICATION_ELIGIBLE_CURRENT_STATE) {
        prefixStatus = CLASSIFICATION_BLOCKED_BY_PREFIX;
      }
    } else if (ev.classification === CLASSIFICATION_BLOCKED_UNPROVEN) {
      prefixBroken = true;
      firstBlocker = firstBlocker || {
        id: ev.id,
        apply_order: ev.apply_order,
        blockedReason: ev.blockedReason,
      };
      prefixStatus = CLASSIFICATION_BLOCKED_UNPROVEN;
    } else if (ev.classification === CLASSIFICATION_ELIGIBLE_STRUCTURAL
      || ev.classification === CLASSIFICATION_ELIGIBLE_CURRENT_STATE) {
      maxPrefixOrder = ev.apply_order;
      maxPrefixCount += 1;
      proposedLedgerRows.push({
        id: ev.id,
        filename: ev.filename,
        checksum_sha256: ev.checksum_sha256,
        apply_order: ev.apply_order,
        apply_kind: ev.apply_kind,
        checksum_mode: CHECKSUM_MODE_CANONICAL_LF_V1,
        evidence_ref: (ev.evidenceRefs && ev.evidenceRefs[0]) || `eligibility:${ev.id}`,
        provenance_notes: ev.eligibilityReason
          ? `Slice 14AC verified bootstrap; never executed_by_canonical_runner (${ev.apply_kind}; ${ev.eligibilityReason})`
          : `Slice 14AC verified bootstrap; never executed_by_canonical_runner (${ev.apply_kind})`,
      });
    }
    evaluationsWithPrefix.push({ ...ev, prefixStatus });
  }

  return {
    maxPrefixOrder,
    maxPrefixCount,
    firstBlocker,
    evaluationsWithPrefix,
    proposedLedgerRows,
  };
}

function designLedgerDdlExtensions() {
  const base = String(LEDGER_DDL || '').trim();
  const additive = [
    'ALTER TABLE schema_migration_ledger',
    "  ADD COLUMN IF NOT EXISTS apply_kind TEXT",
    '    CHECK (apply_kind IN (',
    "      'verified_structural_baseline',",
    "      'verified_current_state_baseline',",
    "      'executed_by_canonical_runner'",
    '    ));',
    'ALTER TABLE schema_migration_ledger',
    '  ADD COLUMN IF NOT EXISTS evidence_ref TEXT;',
    'ALTER TABLE schema_migration_ledger',
    '  ADD COLUMN IF NOT EXISTS provenance_notes TEXT;',
    'ALTER TABLE schema_migration_ledger',
    '  ADD COLUMN IF NOT EXISTS checksum_mode TEXT NOT NULL DEFAULT \'canonical_lf_v1\';',
  ].join('\n');
  return {
    designOnly: true,
    executes: false,
    baseLedgerDdl: base,
    additiveDdl: additive,
    compatibilityNotes: [
      'Additive columns only; existing Slice 4 ledger rows remain valid.',
      'Bootstrap rows use apply_kind verified_structural_baseline or verified_current_state_baseline only.',
      'Never insert executed_by_canonical_runner during bootstrap (Slice 13B / DEC-005).',
      'checksum_mode canonical_lf_v1 for new baseline rows; legacy acceptance via Slice 13A.1 exact legacySha256 only.',
      'applied_at: baseline rows may use explicit applied_at NULL policy in future runner; 14AC does not fabricate applied_at.',
      'Future runner appends executed_by_canonical_runner with canonical sha256 at apply time.',
    ],
    legacyHashPolicy: LEGACY_HASH_POLICY_SLICE_13A1,
  };
}

function loadCanonicalForwards(opts) {
  const options = opts || {};
  const manifestPath = options.manifestPath || MANIFEST_PATH;
  const migrationsDir = options.migrationsDir || MIGRATIONS_DIR;
  const manifest = loadManifest(manifestPath);
  const integrity = validateManifestIntegrity(manifest, { migrationsDir });
  if (!integrity.ok) {
    return {
      ok: false,
      code: 'manifest_integrity_failed',
      errors: integrity.errors,
    };
  }
  if (manifest.checksumMode !== CHECKSUM_MODE_CANONICAL_LF_V1) {
    return { ok: false, code: 'checksum_mode_not_canonical_lf_v1' };
  }
  const forwards = forwardEntries(manifest);
  if (forwards.length !== EXPECTED_FORWARD_COUNT) {
    return {
      ok: false,
      code: 'forward_count_mismatch',
      expected: EXPECTED_FORWARD_COUNT,
      got: forwards.length,
    };
  }
  return { ok: true, manifest, forwards, migrationsDir };
}

function buildEligibilityMatrixFromManifest(opts) {
  const options = opts || {};
  const loaded = loadCanonicalForwards(options);
  if (!loaded.ok) return { ok: false, ...loaded };

  const liveSnapshot = options.liveSnapshot || null;
  const targetedResults = options.targetedResults || {};
  const evaluations = [];

  for (const entry of loaded.forwards) {
    const filePath = path.join(loaded.migrationsDir, entry.filename);
    const sql = fs.readFileSync(filePath, 'utf8');
    const diskHash = sha256CanonicalLfV1File(filePath);
    const checksumGate = ledgerChecksumAccepted(entry, diskHash);
    if (!checksumGate.ok) {
      evaluations.push({
        id: entry.id,
        filename: entry.filename,
        apply_order: entry.order,
        checksum_sha256: entry.sha256,
        classification: CLASSIFICATION_BLOCKED_UNPROVEN,
        blockedReason: 'checksum_drift',
        dec006: null,
        effectSummary: {},
        evidenceRefs: [],
      });
      continue;
    }
    const effects = parseMigrationEffects(sql, { id: entry.id, filename: entry.filename });
    const proofPlan = buildProofPlan(entry, effects);
    const evaluation = evaluateMigrationEligibility({
      entry,
      effects,
      proofPlan,
      liveSnapshot,
      targetedResults,
      options,
    });
    evaluations.push(evaluation);
  }

  const prefix = computeContiguousPrefix(evaluations);
  return {
    ok: true,
    checksumMode: CHECKSUM_MODE_CANONICAL_LF_V1,
    forwardCount: loaded.forwards.length,
    evaluations,
    ...prefix,
  };
}

function classifyFromEvidence(scenario, ctx) {
  const context = ctx || {};
  switch (String(scenario || '')) {
    case 'zero-drift-missing':
      if (context.remainingMismatchCount != null && context.remainingMismatchCount !== 0) {
        return { ok: false, code: 'observer_drift_nonzero', failClosed: true };
      }
      if (context.remainingMismatchCount == null) {
        return { ok: false, code: 'zero_drift_missing', failClosed: true };
      }
      return { ok: true, code: 'zero_drift_verified' };
    case 'ledger-present':
      if (context.ledgerPresent === true || Number(context.ledgerTableCount) > 0) {
        return { ok: false, code: 'ledger_present', failClosed: true };
      }
      return { ok: true, code: 'ledger_absent' };
    case 'checksum-drift':
      if (context.checksumAccepted === false || context.blockedReason === 'checksum_drift') {
        return { ok: false, code: 'checksum_drift', failClosed: true };
      }
      return { ok: true, code: 'checksum_ok' };
    case 'partial-effect':
      if (context.blockedReason === 'partial_effect_unproven') {
        return { ok: false, code: 'partial_effect_unproven', failClosed: true };
      }
      return { ok: true, code: 'effects_complete' };
    case 'unproven-dml':
      if (
        context.blockedReason === 'unproven_dml'
        || context.blockedReason === 'unproven_dml_zero_aggregate'
        || context.blockedReason === BLOCKED_REASON_DML_MISMATCH
      ) {
        return { ok: false, code: context.blockedReason, failClosed: true };
      }
      return { ok: true, code: 'dml_proven_or_absent' };
    case 'unproven-comment':
      if (context.blockedReason === 'unproven_comment') {
        return { ok: false, code: 'unproven_comment', failClosed: true };
      }
      return { ok: true, code: 'comment_ok' };
    case 'unproven-rename':
      if (context.blockedReason === 'unproven_rename') {
        return { ok: false, code: 'unproven_rename', failClosed: true };
      }
      return { ok: true, code: 'rename_ok' };
    case 'dec006-fail':
      if (context.blockedReason === 'dec006_required_checks_failed') {
        return { ok: false, code: 'dec006_fail', failClosed: true };
      }
      return { ok: true, code: 'dec006_ok' };
    case 'gap-noncontiguous':
      if (context.firstBlocker && context.maxPrefixCount < (context.expectedPrefixCount || context.forwardCount)) {
        return { ok: false, code: 'gap_noncontiguous', failClosed: true };
      }
      return { ok: true, code: 'prefix_contiguous' };
    case 'mislabel-executed-runner':
      if (context.apply_kind === APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER
        || context.forbiddenApplyKind === APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER) {
        return { ok: false, code: 'mislabel_executed_runner', failClosed: true };
      }
      return { ok: true, code: 'bootstrap_kind_ok' };
    default:
      return { ok: false, code: 'unknown_scenario', failClosed: true };
  }
}

function buildLockedLedgerPgClientConfig(user, password) {
  return {
    host: LEDGER_LOCKS.postgresHost,
    port: LEDGER_LOCKS.port,
    database: LEDGER_LOCKS.database,
    user: String(user),
    password: String(password),
    application_name: APPLICATION_NAME,
    options: [
      '-c default_transaction_read_only=on',
      '-c statement_timeout=30000',
      '-c lock_timeout=5000',
    ].join(' '),
    connectionTimeoutMillis: 20000,
    ssl: buildVerifiedTlsSslConfig(),
  };
}

async function safeShow(client, key) {
  const sql = INTROSPECTION_SQL[key];
  const gate = assertSqlAllowed(sql);
  if (!gate.ok) {
    throw Object.assign(new Error(gate.message), { code: gate.code });
  }
  queryCalls += 1;
  const res = await client.query(sql);
  const row = (res.rows && res.rows[0]) || {};
  const val = row[key] != null ? row[key] : Object.values(row)[0];
  return val;
}

async function safeSelect(client, sql) {
  const gate = assertSelectOnlySql(sql);
  if (!gate.ok) {
    throw Object.assign(new Error(gate.message), { code: gate.code });
  }
  queryCalls += 1;
  const res = await client.query(sql);
  return Array.isArray(res.rows) ? res.rows : [];
}

async function verifyLedgerEligibilitySession(client) {
  const errors = [];
  const tro = String(await safeShow(client, 'show_transaction_read_only')).toLowerCase();
  if (tro !== 'on') {
    errors.push({ code: 'non_read_only_session', message: `transaction_read_only=${tro || 'unset'}` });
  }
  const app = String(await safeShow(client, 'show_application_name'));
  if (app !== APPLICATION_NAME) {
    errors.push({ code: 'wrong_application_name', message: `application_name must be ${APPLICATION_NAME}` });
  }
  const versionClass = await captureServerVersionClass(client);
  if (!versionClass || versionClass.versionClass !== 'postgresql_15') {
    errors.push({
      code: 'pg15_required',
      message: `server must be PG15; got ${versionClass && versionClass.versionClass}`,
    });
  }
  return {
    ok: errors.length === 0,
    errors,
    show: { transaction_read_only: tro, application_name: app },
    serverVersionClass: versionClass,
  };
}

async function captureServerVersionClass(client) {
  const serverVersion = String(await safeShow(client, 'show_server_version') || '');
  const serverVersionNumRaw = await safeShow(client, 'show_server_version_num');
  return classifyServerVersionClass(serverVersionNumRaw, serverVersion);
}

async function assertLedgerAbsent(client, liveSnapshot) {
  if (liveSnapshot && Array.isArray(liveSnapshot.tables)) {
    const present = liveSnapshot.tables.includes(LEDGER_TABLE);
    return { ok: !present, ledgerPresent: present, method: 'snapshot_tables' };
  }
  const rows = await safeSelect(client, LEDGER_ABSENT_SQL);
  const cnt = Number((rows[0] && rows[0].cnt) || 0);
  return { ok: cnt === 0, ledgerPresent: cnt > 0, method: 'targeted_select', count: cnt };
}

async function runDec006TargetedSelects(client) {
  const targetedResults = {};
  const errors = [];
  for (const [checkId, sql] of Object.entries(DEC006_PROOF_SQL)) {
    const gate = assertSelectOnlySql(sql);
    if (!gate.ok) {
      errors.push({ code: gate.code, checkId, message: gate.message });
      continue;
    }
    try {
      const rows = await safeSelect(client, sql);
      targetedResults[`dec006:${checkId}`] = rows;
      targetedResults[checkId] = rows;
    } catch (e) {
      errors.push({ code: e.code || 'targeted_select_failed', checkId, message: String(e.message || '').slice(0, 200) });
    }
  }
  return { ok: errors.length === 0, targetedResults, errors };
}

async function runLedgerObserverCompare(client, expectedContract, opts) {
  const options = opts || {};
  const session = await verifyLedgerEligibilitySession(client);
  if (!session.ok) {
    return {
      sessionReadOnly: false,
      remainingMismatchCount: null,
      remainingKeys: [],
      liveSnapshot: null,
      productFingerprintLive: null,
      errors: session.errors,
      stopReason: 'session_invalid',
    };
  }

  const product = await introspectProductSchema(client);
  queryCalls += Array.isArray(product.usedAllowlist) ? product.usedAllowlist.length : 20;
  const productFingerprintLive = fingerprintProductSchema(product.snapshot);
  const versionClass = session.serverVersionClass && session.serverVersionClass.versionClass
    ? session.serverVersionClass.versionClass
    : null;
  const azureContext = {
    verified: true,
    host: EXPECTED_HOST,
    database: EXPECTED_DATABASE,
    versionClass,
  };
  const builtProvenance = buildIdentifierTruncationNotNullProvenance();
  const identifierTruncationProvenance = builtProvenance && builtProvenance.ok === true
    ? builtProvenance
    : null;

  const liveProfile = options.liveProfile
    || (typeof options.skipLiveProfileCapture === 'boolean' && options.skipLiveProfileCapture
      ? buildOfflinePgcryptoLiveProfile(product.snapshot, options.offlineProfileOpts)
      : await captureAzurePg15PgcryptoLiveProfile(client, product.snapshot));

  const cmp = compareSnapshots(
    expectedContract.snapshot,
    product.snapshot,
    buildObserverCompareOptions(azureContext, versionClass, identifierTruncationProvenance, {
      enablePgcryptoCompatibilityNormalization: true,
      liveProfile,
    }),
  );
  const summary = summarizeCompare(cmp);
  const remainingMismatchCount = summary.mismatchCount != null ? summary.mismatchCount : null;

  return {
    sessionReadOnly: true,
    transactionReadOnly: String(session.show.transaction_read_only).toLowerCase() === 'on',
    serverVersionClass: session.serverVersionClass,
    remainingMismatchCount,
    remainingKeys: summary.remainingKeys || remainingMismatchKeys(cmp.drifts),
    observerSummary: summary,
    liveSnapshot: product.snapshot,
    productFingerprintLive,
    liveProfile,
    errors: remainingMismatchCount === 0 ? [] : [{
      code: 'observer_drift_nonzero',
      message: `remainingMismatchCount=${remainingMismatchCount}`,
    }],
    stopReason: remainingMismatchCount === 0 ? null : 'observer_drift_nonzero',
  };
}

function pickSafe(result) {
  return redactDeep(result, []);
}

async function executeLedgerEligibility(opts) {
  const options = opts || {};
  const gate = evaluateLedgerEligibilityGates(options);
  if (!gate.ok) {
    return pickSafe({
      ok: false,
      code: (gate.errors[0] && gate.errors[0].code) || 'gates_rejected',
      sameTarget: false,
      blocker: (gate.errors[0] && gate.errors[0].code) || 'gates_rejected',
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      ...getLedgerEligibilityCounters(),
      applicationName: APPLICATION_NAME,
      errors: gate.errors,
      closed: true,
      committed: false,
      rolledBack: false,
    });
  }

  const usedLiveHttp = typeof options.httpRequest !== 'function'
    && PHASE_D_LEDGER_ELIGIBILITY_LIVE_ENABLED === true
    && PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true;

  const httpRequest = typeof options.httpRequest === 'function'
    ? options.httpRequest
    : (usedLiveHttp ? createLiveTargetAuthorityHttpRequest() : null);

  if (typeof httpRequest !== 'function') {
    return pickSafe({
      ok: false,
      code: 'http_disabled',
      sameTarget: false,
      blocker: 'http_disabled',
      liveMutation: false,
      errors: [{ code: 'http_disabled', message: 'inject httpRequest for offline proof' }],
      closed: true,
    });
  }

  const authority = await executeActiveDbTargetAuthority({
    env: {
      ...targetAuthorityEnv(),
      ...(options.env || {}),
      [ENV_TARGET_AUTHORITY]: '1',
    },
    argv: exactTargetAuthorityArgv(),
    httpRequest,
    skipPostgres: true,
    expectedContract: options.expectedContract,
  });

  if (authority.sameTarget !== true) {
    return pickSafe({
      ok: false,
      code: authority.code || 'mismatched_app_kv_target',
      sameTarget: false,
      blocker: authority.blocker || 'mismatched_app_kv_target',
      liveMutation: false,
      ledgerWritten: false,
      usedLiveHttp,
      ...getLedgerEligibilityCounters(),
      applicationName: APPLICATION_NAME,
      errors: authority.errors || [],
      closed: true,
    });
  }

  if (options.skipPostgres === true) {
    return pickSafe({
      ok: true,
      code: 'same_target_authority_ok',
      sameTarget: true,
      blocker: null,
      liveMutation: false,
      ledgerWritten: false,
      usedLiveHttp,
      realPostgresCall: false,
      ...getLedgerEligibilityCounters(),
      applicationName: APPLICATION_NAME,
      closed: true,
      errors: [],
    });
  }

  if (options.injectedEligibility) {
    const inj = options.injectedEligibility;
    return pickSafe({
      ok: inj.ok === true,
      code: inj.code || 'ledger_eligibility_injected',
      sameTarget: true,
      blocker: inj.blocker || inj.stopReason || null,
      liveMutation: false,
      ledgerWritten: false,
      eligibilityMatrix: inj.eligibilityMatrix || null,
      ...getLedgerEligibilityCounters(),
      applicationName: APPLICATION_NAME,
      closed: true,
      errors: Array.isArray(inj.errors) ? inj.errors : [],
      stopReason: inj.stopReason || null,
    });
  }

  if (options.injectedObserver) {
    const obs = options.injectedObserver;
    const driftOk = obs.remainingMismatchCount === 0;
    const ledgerOk = obs.ledgerAbsent !== false;
    if (!driftOk || !ledgerOk) {
      return pickSafe({
        ok: false,
        code: !driftOk ? 'observer_drift_nonzero' : 'ledger_present',
        sameTarget: true,
        blocker: !driftOk ? 'observer_drift_nonzero' : 'ledger_present',
        liveMutation: false,
        ledgerWritten: false,
        observer: obs,
        ...getLedgerEligibilityCounters(),
        applicationName: APPLICATION_NAME,
        closed: true,
        errors: obs.errors || [],
      });
    }
    const matrix = buildEligibilityMatrixFromManifest({
      liveSnapshot: obs.liveSnapshot,
      targetedResults: obs.targetedResults || options.targetedResults,
    });
    return pickSafe({
      ok: matrix.ok === true,
      code: 'ledger_eligibility_matrix_ok',
      sameTarget: true,
      blocker: null,
      firstBlocker: matrix.firstBlocker || null,
      maxPrefixCount: matrix.maxPrefixCount,
      maxPrefixOrder: matrix.maxPrefixOrder,
      liveMutation: false,
      ledgerWritten: false,
      eligibilityMatrix: matrix,
      observer: obs,
      ...getLedgerEligibilityCounters(),
      applicationName: APPLICATION_NAME,
      closed: true,
      errors: [],
    });
  }

  if (!options.expectedContract || !options.expectedContract.snapshot) {
    return pickSafe({
      ok: false,
      code: 'expected_contract_required',
      sameTarget: true,
      blocker: 'expected_contract_required',
      liveMutation: false,
      errors: [{ code: 'expected_contract_required', message: 'expectedContract.snapshot required' }],
      closed: true,
    });
  }

  const loaded = await loadProtectedAdminCredentialsViaManagedIdentity({
    env: options.env || ledgerEligibilityEnv(),
    argv: options.argv || exactLedgerEligibilityArgv(),
    httpRequest,
  });
  if (!loaded.ok) {
    return pickSafe({
      ok: false,
      code: loaded.code || 'credential_load_failed',
      sameTarget: true,
      blocker: loaded.code || 'credential_load_failed',
      liveMutation: false,
      usedLiveHttp,
      ...getLedgerEligibilityCounters(),
      applicationName: APPLICATION_NAME,
      errors: loaded.errors || [{ code: 'credential_load_failed', message: 'credential load failed' }],
      closed: true,
    });
  }

  let client = null;
  let closed = true;
  let committed = false;
  let rolledBack = false;

  try {
    if (!loaded._user || !loaded._password) {
      zeroPrivateCredentialRefs(loaded);
      return pickSafe({
        ok: false,
        code: 'kv_target_invalid',
        sameTarget: true,
        blocker: 'kv_target_invalid',
        liveMutation: false,
        usedLiveHttp,
        ...getLedgerEligibilityCounters(),
        applicationName: APPLICATION_NAME,
        errors: [{ code: 'kv_target_invalid', message: 'credential handoff missing user/password' }],
        closed: true,
      });
    }
    const user = loaded._user;
    const password = loaded._password;
    zeroPrivateCredentialRefs(loaded);

    const ClientFactory = options.ClientFactory || Client;
    const cfg = buildLockedLedgerPgClientConfig(user, password);
    clientsInstantiated += 1;
    client = new ClientFactory(cfg);
    try {
      cfg.password = undefined;
      cfg.user = undefined;
    } catch (_) { /* ignore */ }

    closed = false;
    connectCalls += 1;
    await client.connect();
    queryCalls += 1;
    await client.query('BEGIN READ ONLY');

    const obs = await runLedgerObserverCompare(client, options.expectedContract, options);
    if (!obs.sessionReadOnly || obs.stopReason === 'session_invalid') {
      queryCalls += 1;
      try { await client.query('ROLLBACK'); rolledBack = true; } catch (_) { /* ignore */ }
      return pickSafe({
        ok: false,
        code: 'session_not_read_only',
        sameTarget: true,
        blocker: 'session_not_read_only',
        liveMutation: false,
        ledgerWritten: false,
        usedLiveHttp,
        realPostgresCall: true,
        observer: obs,
        ...getLedgerEligibilityCounters(),
        applicationName: APPLICATION_NAME,
        errors: obs.errors || [],
        closed: false,
        rolledBack: true,
      });
    }

    if (obs.stopReason === 'observer_drift_nonzero') {
      queryCalls += 1;
      try { await client.query('ROLLBACK'); rolledBack = true; } catch (_) { /* ignore */ }
      try { endCalls += 1; await client.end(); closed = true; client = null; } catch (_) { closed = true; }
      return pickSafe({
        ok: false,
        code: 'observer_drift_nonzero',
        sameTarget: true,
        blocker: 'observer_drift_nonzero',
        liveMutation: false,
        ledgerWritten: false,
        usedLiveHttp,
        realPostgresCall: true,
        remainingMismatchCount: obs.remainingMismatchCount,
        remainingKeys: obs.remainingKeys,
        productFingerprintLive: obs.productFingerprintLive,
        ...getLedgerEligibilityCounters(),
        applicationName: APPLICATION_NAME,
        errors: obs.errors || [],
        closed: true,
        rolledBack: true,
        stopReason: 'observer_drift_nonzero',
      });
    }

    const ledgerGate = await assertLedgerAbsent(client, obs.liveSnapshot);
    if (!ledgerGate.ok) {
      queryCalls += 1;
      try { await client.query('ROLLBACK'); rolledBack = true; } catch (_) { /* ignore */ }
      try { endCalls += 1; await client.end(); closed = true; client = null; } catch (_) { closed = true; }
      return pickSafe({
        ok: false,
        code: 'ledger_present',
        sameTarget: true,
        blocker: 'ledger_present',
        liveMutation: false,
        ledgerWritten: false,
        usedLiveHttp,
        realPostgresCall: true,
        ledgerGate,
        ...getLedgerEligibilityCounters(),
        applicationName: APPLICATION_NAME,
        errors: [{ code: 'ledger_present', message: 'schema_migration_ledger must be absent for bootstrap proof' }],
        closed: true,
        rolledBack: true,
        stopReason: 'ledger_present',
      });
    }

    const targeted = await runDec006TargetedSelects(client);
    if (!targeted.ok) {
      queryCalls += 1;
      try { await client.query('ROLLBACK'); rolledBack = true; } catch (_) { /* ignore */ }
      try { endCalls += 1; await client.end(); closed = true; client = null; } catch (_) { closed = true; }
      return pickSafe({
        ok: false,
        code: 'dec006_targeted_select_failed',
        sameTarget: true,
        blocker: 'dec006_targeted_select_failed',
        liveMutation: false,
        ledgerWritten: false,
        usedLiveHttp,
        realPostgresCall: true,
        ...getLedgerEligibilityCounters(),
        applicationName: APPLICATION_NAME,
        errors: targeted.errors,
        closed: true,
        rolledBack: true,
      });
    }

    const matrix = buildEligibilityMatrixFromManifest({
      liveSnapshot: obs.liveSnapshot,
      targetedResults: targeted.targetedResults,
    });

    queryCalls += 1;
    await client.query('COMMIT');
    committed = true;
    try { endCalls += 1; await client.end(); closed = true; client = null; } catch (_) { closed = true; }

    return pickSafe({
      ok: matrix.ok === true,
      code: 'ledger_eligibility_matrix_ok',
      sameTarget: true,
      blocker: null,
      firstBlocker: matrix.firstBlocker || null,
      maxPrefixCount: matrix.maxPrefixCount,
      maxPrefixOrder: matrix.maxPrefixOrder,
      proposedLedgerRowCount: (matrix.proposedLedgerRows || []).length,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      usedLiveHttp,
      realPostgresCall: true,
      sessionReadOnly: true,
      transactionReadOnly: true,
      serverVersionClass: obs.serverVersionClass,
      remainingMismatchCount: obs.remainingMismatchCount,
      productFingerprintLive: obs.productFingerprintLive,
      eligibilityMatrix: matrix,
      ledgerGate,
      targetedProofCount: Object.keys(targeted.targetedResults).length,
      ...getLedgerEligibilityCounters(),
      applicationName: APPLICATION_NAME,
      postgresHost: LEDGER_LOCKS.postgresHost,
      database: LEDGER_LOCKS.database,
      sslmode: LEDGER_LOCKS.sslmode,
      errors: [],
      closed: true,
      committed: true,
      rolledBack: false,
      stopReason: null,
    });
  } catch (e) {
    if (client && !closed) {
      try { await client.query('ROLLBACK'); rolledBack = true; } catch (_) { /* ignore */ }
      try { endCalls += 1; await client.end(); } catch (_) { /* ignore */ }
      closed = true;
    }
    return pickSafe({
      ok: false,
      code: e.code || 'ledger_eligibility_failed',
      sameTarget: true,
      blocker: e.code || 'ledger_eligibility_failed',
      liveMutation: false,
      ledgerWritten: false,
      usedLiveHttp,
      ...getLedgerEligibilityCounters(),
      applicationName: APPLICATION_NAME,
      errors: [{
        code: e.code || 'ledger_eligibility_failed',
        message: String(e.message || 'failed').slice(0, 240),
      }],
      closed: true,
      committed,
      rolledBack,
    });
  } finally {
    zeroPrivateCredentialRefs({ _secretValue: null, _dsn: null });
  }
}

function printCliHelp() {
  return [
    'phase-d:ledger-eligibility — FOUNDATION Slice 14AC',
    'DEFAULT: refused (zero ARM / zero KV / zero PostgreSQL).',
    '',
    'Merged target-authority + one read-only observer session proving',
    'ledger bootstrap eligibility matrix for 39 canonical_forward migrations.',
    'Requires dual Phase D flags + TARGET_AUTHORITY + LEDGER_ELIGIBILITY',
    '+ managed-identity + exact locked targets.',
    '',
    'Observer must reach remainingMismatchCount === 0 under merged 14AB normalizations.',
    'schema_migration_ledger must be absent. DEC-006 targeted SELECTs required.',
    'Never inserts ledger rows or claims executed_by_canonical_runner.',
    'Zero mutation.',
  ].join('\n');
}

module.exports = {
  PHASE_D_LEDGER_ELIGIBILITY_LIVE_ENABLED,
  ENV_LEDGER_ELIGIBILITY,
  CLI_PROVE_LEDGER_ELIGIBILITY,
  APPLICATION_NAME,
  LEDGER_LOCKS,
  EXPECTED_FORWARD_COUNT,
  LEGACY_HASH_POLICY_SLICE_13A1,
  CHECKSUM_MODE_CANONICAL_LF_V1,
  DEC006_MIGRATION_IDS,
  DEC006_RESOLUTION_REQUIREMENTS,
  DEC006_PROOF_SQL,
  MIGRATION_020_EXPECTED_ROOM_VALUES,
  MIGRATION_020_ROOM_CODES,
  ELIGIBILITY_REASON_VACUOUS,
  ELIGIBILITY_REASON_MATCHED,
  BLOCKED_REASON_DML_MISMATCH,
  BLOCKED_REASON_AMBIGUOUS_SLUG,
  BLOCKED_REASON_ROOM_MULTIPLICITY,
  BLOCKED_REASON_QUERY_AMBIGUITY,
  LEDGER_ABSENT_SQL,
  APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
  APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE,
  APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
  CLASSIFICATION_ELIGIBLE_STRUCTURAL,
  CLASSIFICATION_ELIGIBLE_CURRENT_STATE,
  CLASSIFICATION_BLOCKED_UNPROVEN,
  CLASSIFICATION_BLOCKED_BY_PREFIX,
  FORBIDDEN_ARGV_FLAGS,
  ALLOWED_ARGV_FLAGS,
  parseMigrationEffects,
  buildProofPlan,
  evaluateMigrationEligibility,
  computeContiguousPrefix,
  designLedgerDdlExtensions,
  buildEligibilityMatrixFromManifest,
  loadCanonicalForwards,
  classifyFromEvidence,
  evaluateLedgerEligibilityGates,
  exactLedgerEligibilityArgv,
  ledgerEligibilityEnv,
  executeLedgerEligibility,
  assertSelectOnlySql,
  evaluateDec006Check,
  evaluate020TenantScopedDml,
  snapshotHasCatalogMatch,
  resetLedgerEligibilityCounters,
  getLedgerEligibilityCounters,
  printCliHelp,
  createInjectedTargetAuthorityHttp,
  createInjectedManagedIdentityHttp,
  evaluateTargetAuthorityGates,
  ledgerChecksumAccepted,
  MANIFEST_PATH,
  LEDGER_DDL,
};
