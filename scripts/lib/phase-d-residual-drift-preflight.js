'use strict';

/**
 * FOUNDATION Slice 14U — Residual drift classify + preflight (read-only)
 *
 * After Slice 14T NOT NULL normalization, exactly 35 residual drifts remain.
 * This library classifies those drifts, builds canonical ownership inventory,
 * and runs safe aggregate preflights (null/duplicate/orphan/violation counts)
 * inside one TLS verify-full READ ONLY PG session.
 *
 * Architecture mirrors Slice 14T (merged target-authority + one observer
 * session). Zero mutation: execute:false always; PHASE_D_LIVE_APPLY_ENABLED
 * must remain false. Default-disabled behind exact env+argv gates.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  TARGETS,
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  ENV_LIVE_READONLY,
  ENV_LIVE_PREFLIGHT,
  ENV_SUBSCRIPTION,
  ENV_CREDENTIAL_SOURCE,
  CLI_CREDENTIAL_SOURCE,
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  redactDeep,
} = require('./phase-d-live-readonly-boundary');
const {
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
  buildOfflineProofSunsetDatabaseUrl,
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
  MIGRATIONS_DIR,
  forwardEntries,
  loadManifest,
  sha256CanonicalLfV1File,
} = require('./migration-integrity');
const {
  introspectProductSchema,
  fingerprintProductSchema,
  compareSnapshots,
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  INTROSPECTION_SQL,
  assertSqlAllowed,
  classifyServerVersionClass,
  parseCanonicalNotNullConstraint,
} = require('./sunset-schema-observer');

/** Live capability activated for Slice 14U behind exact env+argv gates. */
const PHASE_D_RESIDUAL_DRIFT_PREFLIGHT_LIVE_ENABLED = true;

const ENV_RESIDUAL_DRIFT_PREFLIGHT = 'SUNSET_PHASE_D_RESIDUAL_DRIFT_PREFLIGHT';
const CLI_PROVE_RESIDUAL_DRIFT_PREFLIGHT = '--prove-residual-drift-preflight';
const APPLICATION_NAME = 'wh-sunset-residual-drift-preflight';

const BASELINE_MISMATCH_COUNT = 35;
const BASELINE_MISMATCH_SECTIONS = Object.freeze({
  constraints: 25,
  indexes: 5,
  functions: 1,
  triggers: 1,
  ownership: 1,
  acls: 1,
  extensions: 1,
});

const RESIDUAL_LOCKS = Object.freeze({
  ...AUTHORITY_LOCKS,
  applicationName: APPLICATION_NAME,
});

const ALLOWED_ARGV_FLAGS = Object.freeze([
  CLI_PROVE_RESIDUAL_DRIFT_PREFLIGHT,
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

/** Deterministic dependency ranks for mutation batch ordering (execute:false). */
const DEPENDENCY_ORDER_RANK = Object.freeze({
  indexes: 1,
  NOT_NULL: 2,
  PRIMARY_KEY: 3,
  UNIQUE: 3,
  FOREIGN_KEY: 4,
  CHECK: 5,
  functions: 6,
  triggers: 6,
  ownership: 7,
  acls: 7,
  extensions: 8,
  definition_mismatch: 9,
  unsupported: 9,
  blocker: 9,
});

const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

let clientsInstantiated = 0;
let connectCalls = 0;
let queryCalls = 0;
let endCalls = 0;

function resetResidualDriftPreflightCounters() {
  clientsInstantiated = 0;
  connectCalls = 0;
  queryCalls = 0;
  endCalls = 0;
  resetTargetAuthorityCounters();
  resetManagedIdentityHttpCounters();
}

function getResidualDriftPreflightCounters() {
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

function quoteIdent(name) {
  if (!IDENT_RE.test(String(name || ''))) {
    throw Object.assign(
      new Error(`invalid identifier: ${String(name || '').slice(0, 64)}`),
      { code: 'invalid_identifier' }
    );
  }
  return `"${String(name).replace(/"/g, '""')}"`;
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
    if (a === CLI_PROVE_RESIDUAL_DRIFT_PREFLIGHT
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

function exactResidualDriftPreflightArgv() {
  return [
    CLI_PROVE_RESIDUAL_DRIFT_PREFLIGHT,
    CLI_PROVE_TARGET_AUTHORITY,
    '--subscription', RESIDUAL_LOCKS.subscriptionId,
    '--resource-group', RESIDUAL_LOCKS.resourceGroup,
    '--container-app', RESIDUAL_LOCKS.containerAppName,
    '--postgres-server', RESIDUAL_LOCKS.postgresServer,
    '--database', RESIDUAL_LOCKS.database,
    CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  ];
}

function residualDriftPreflightEnv() {
  return {
    ...targetAuthorityEnv(),
    [ENV_RESIDUAL_DRIFT_PREFLIGHT]: '1',
  };
}

function evaluateResidualDriftPreflightGates(opts) {
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
  if (PHASE_D_RESIDUAL_DRIFT_PREFLIGHT_LIVE_ENABLED !== true) {
    errors.push({
      code: 'residual_drift_preflight_capability_disabled',
      message: 'residual drift preflight live disabled',
    });
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
  if (String(env[ENV_RESIDUAL_DRIFT_PREFLIGHT] || '') !== '1') {
    errors.push({
      code: 'residual_drift_preflight_env_required',
      message: `${ENV_RESIDUAL_DRIFT_PREFLIGHT}=1 required`,
    });
  }
  if (String(env[ENV_SUBSCRIPTION] || '') !== RESIDUAL_LOCKS.subscriptionId) {
    errors.push({ code: 'subscription_env_mismatch', message: 'AZURE_SUBSCRIPTION_ID must match locked subscription' });
  }
  if (String(env[ENV_CREDENTIAL_SOURCE] || '') !== CREDENTIAL_SOURCE_MANAGED_IDENTITY) {
    errors.push({
      code: 'managed_identity_credential_source_flag_required',
      message: `env ${ENV_CREDENTIAL_SOURCE}=managed-identity required`,
    });
  }
  if (!parsed.flags.has(CLI_PROVE_RESIDUAL_DRIFT_PREFLIGHT)) {
    errors.push({
      code: 'residual_drift_preflight_flag_required',
      message: `${CLI_PROVE_RESIDUAL_DRIFT_PREFLIGHT} required`,
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
    '--subscription': RESIDUAL_LOCKS.subscriptionId,
    '--resource-group': RESIDUAL_LOCKS.resourceGroup,
    '--container-app': RESIDUAL_LOCKS.containerAppName,
    '--postgres-server': RESIDUAL_LOCKS.postgresServer,
    '--database': RESIDUAL_LOCKS.database,
  };
  for (const [flag, want] of Object.entries(expect)) {
    if (String(parsed.values[flag] || '') !== want) {
      errors.push({ code: 'exact_target_mismatch', message: `${flag} must equal locked ${want}` });
    }
  }

  return { ok: errors.length === 0, errors, parsed };
}

function buildLockedPgClientConfig(user, password) {
  return {
    host: RESIDUAL_LOCKS.postgresHost,
    port: RESIDUAL_LOCKS.port,
    database: RESIDUAL_LOCKS.database,
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

function groupMismatchSections(drifts) {
  const sectionCounts = {};
  for (const d of drifts || []) {
    const section = String(d.section || d.kind || 'unknown');
    sectionCounts[section] = (sectionCounts[section] || 0) + 1;
  }
  return sectionCounts;
}

function summarizeCompare(cmp) {
  if (cmp && cmp.normalizationError) {
    return {
      ok: false,
      match: false,
      code: cmp.normalizationError.code || 'normalization_failed',
      mismatchCount: null,
      counts: cmp.counts || null,
      mismatchSections: null,
      notNullArtifactsNormalized: null,
      normalizationError: {
        code: cmp.normalizationError.code,
        message: String(cmp.normalizationError.message || '').slice(0, 240),
      },
      drifts: [],
    };
  }
  const drifts = Array.isArray(cmp && cmp.drifts) ? cmp.drifts : [];
  const mismatchCount = drifts.length || (
    ((cmp && cmp.counts && cmp.counts.expected_only) || 0)
    + ((cmp && cmp.counts && cmp.counts.live_only) || 0)
    + ((cmp && cmp.counts && cmp.counts.definition_mismatch) || 0)
  );
  return {
    ok: cmp && cmp.ok === true,
    match: cmp && cmp.ok === true,
    code: cmp && cmp.ok === true ? 'observer_match' : 'observer_drift',
    mismatchCount,
    counts: (cmp && cmp.counts) || null,
    mismatchSections: groupMismatchSections(drifts),
    notNullArtifactsNormalized: cmp && cmp.notNullNormalization
      ? Number(cmp.notNullNormalization.normalizedCount) || 0
      : 0,
    normalizationError: null,
    drifts,
  };
}

/**
 * Baseline gate: residual inventory is exactly the 35 post-14T mismatches.
 * Do not invent or carry forward the fictional 448 normalized NOT NULL count.
 */
function assertBaselineMismatch(compareSummary) {
  const summary = compareSummary || {};
  const mismatchCount = Number(summary.mismatchCount);
  const sections = summary.mismatchSections || {};
  const expectedSections = BASELINE_MISMATCH_SECTIONS;
  const sectionKeys = Object.keys(expectedSections).sort();
  const gotKeys = Object.keys(sections).sort();
  const sectionsMatch = sectionKeys.length === gotKeys.length
    && sectionKeys.every((k) => Number(sections[k]) === expectedSections[k]);

  if (mismatchCount === BASELINE_MISMATCH_COUNT && sectionsMatch) {
    return {
      ok: true,
      code: 'baseline_ok',
      mismatchCount,
      mismatchSections: { ...sections },
      expectedMismatchCount: BASELINE_MISMATCH_COUNT,
      expectedMismatchSections: { ...expectedSections },
    };
  }
  return {
    ok: false,
    code: 'baseline_drift_mismatch',
    mismatchCount: Number.isFinite(mismatchCount) ? mismatchCount : null,
    mismatchSections: { ...sections },
    expectedMismatchCount: BASELINE_MISMATCH_COUNT,
    expectedMismatchSections: { ...expectedSections },
    message: `expected mismatchCount=${BASELINE_MISMATCH_COUNT} with sections `
      + JSON.stringify(expectedSections)
      + `; got mismatchCount=${mismatchCount} sections=${JSON.stringify(sections)}`,
  };
}

function classifyConstraintResidual(expectedConstraint) {
  const c = expectedConstraint || {};
  const type = String(c.type || '');
  const definition = String(c.definition || '');
  const table = String(c.table || '');
  const name = String(c.name || '');
  const key = table && name && type ? `${table}.${name}.${type}` : null;

  if (type === 'n') {
    const parsed = parseCanonicalNotNullConstraint(c);
    // True NOT NULL-shaped only when canonical name/definition parse succeeds.
    // Rename leftovers (hostel_id vs client_id, hostels_* on clients, truncated
    // names) are unsupported contype-n residuals — not safe NOT NULL apply.
    if (parsed.ok === true) {
      return {
        key,
        section: 'constraints',
        contype: 'n',
        category: 'NOT_NULL_shaped',
        notNullParse: parsed,
        table,
        name,
        definition,
        column: parsed.column,
        ok: true,
        reason: null,
      };
    }
    return {
      key,
      section: 'constraints',
      contype: 'n',
      category: 'unsupported',
      notNullParse: parsed,
      table,
      name,
      definition,
      column: null,
      ok: false,
      reason: parsed.reason || 'not_null_parse_failed',
    };
  }
  if (type === 'PRIMARY KEY') {
    const cols = parseParenColumnList(definition, /^PRIMARY\s+KEY\s*\(/i);
    return {
      key,
      section: 'constraints',
      contype: 'PRIMARY KEY',
      category: 'PRIMARY_KEY',
      table,
      name,
      definition,
      columns: cols.columns,
      ok: cols.ok,
      reason: cols.ok ? null : cols.reason,
    };
  }
  if (type === 'UNIQUE') {
    const cols = parseParenColumnList(definition, /^UNIQUE\s*\(/i);
    return {
      key,
      section: 'constraints',
      contype: 'UNIQUE',
      category: 'UNIQUE',
      table,
      name,
      definition,
      columns: cols.columns,
      ok: cols.ok,
      reason: cols.ok ? null : cols.reason,
    };
  }
  if (type === 'FOREIGN KEY') {
    const fk = parseForeignKeyDefinition(definition);
    return {
      key,
      section: 'constraints',
      contype: 'FOREIGN KEY',
      category: 'FOREIGN_KEY',
      table,
      name,
      definition,
      ...fk,
      ok: fk.ok,
      reason: fk.ok ? null : fk.reason,
    };
  }
  if (type === 'CHECK') {
    const chk = parseCheckDefinition(definition);
    return {
      key,
      section: 'constraints',
      contype: 'CHECK',
      category: 'CHECK',
      table,
      name,
      definition,
      predicate: chk.predicate,
      ok: chk.ok,
      reason: chk.ok ? null : chk.reason,
    };
  }
  return {
    key,
    section: 'constraints',
    contype: type || null,
    category: 'unsupported',
    table,
    name,
    definition,
    ok: false,
    reason: 'unsupported_constraint_type',
  };
}

function parseParenColumnList(definition, headRe) {
  const def = String(definition || '').trim();
  if (!headRe.test(def)) {
    return { ok: false, reason: 'definition_shape_mismatch', columns: [] };
  }
  const open = def.indexOf('(');
  const close = def.lastIndexOf(')');
  if (open < 0 || close <= open) {
    return { ok: false, reason: 'missing_paren_list', columns: [] };
  }
  const inner = def.slice(open + 1, close);
  const parts = inner.split(',').map((p) => p.trim().replace(/^"|"$/g, ''));
  const columns = [];
  for (const p of parts) {
    const col = p.split(/\s+/)[0];
    if (!IDENT_RE.test(col)) {
      return { ok: false, reason: 'invalid_column_ident', columns: [] };
    }
    columns.push(col);
  }
  if (columns.length === 0) {
    return { ok: false, reason: 'empty_column_list', columns: [] };
  }
  return { ok: true, reason: null, columns };
}

function parseForeignKeyDefinition(definition) {
  const def = String(definition || '').trim();
  const m = def.match(
    /^FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([^)]+)\)/i
  );
  if (!m) {
    return {
      ok: false,
      reason: 'fk_definition_shape_mismatch',
      columns: [],
      refTable: null,
      refColumns: [],
    };
  }
  const columns = m[1].split(',').map((p) => p.trim().replace(/^"|"$/g, ''));
  const refColumns = m[3].split(',').map((p) => p.trim().replace(/^"|"$/g, ''));
  const refTable = m[2];
  if (!columns.every((c) => IDENT_RE.test(c)) || !refColumns.every((c) => IDENT_RE.test(c))) {
    return {
      ok: false,
      reason: 'invalid_fk_ident',
      columns: [],
      refTable: null,
      refColumns: [],
    };
  }
  if (!IDENT_RE.test(refTable)) {
    return {
      ok: false,
      reason: 'invalid_ref_table',
      columns: [],
      refTable: null,
      refColumns: [],
    };
  }
  return {
    ok: true,
    reason: null,
    columns,
    refTable,
    refColumns,
  };
}

function parseCheckDefinition(definition) {
  const def = String(definition || '').trim();
  const m = def.match(/^CHECK\s*\(([\s\S]*)\)\s*$/i);
  if (!m) {
    return { ok: false, reason: 'check_definition_shape_mismatch', predicate: null };
  }
  let predicate = m[1].trim();
  // Collapse outer double-parens common in pg_get_constraintdef: ((...))
  while (predicate.startsWith('(') && predicate.endsWith(')')) {
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < predicate.length; i += 1) {
      const ch = predicate[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0 && i !== predicate.length - 1) {
          balanced = false;
          break;
        }
      }
    }
    if (!balanced || depth !== 0) break;
    predicate = predicate.slice(1, -1).trim();
  }
  if (!predicate) {
    return { ok: false, reason: 'empty_check_predicate', predicate: null };
  }
  return { ok: true, reason: null, predicate };
}

function parseIndexColumnList(def) {
  const d = String(def || '');
  // Prefer USING ... (cols) then ON ... (cols)
  let m = d.match(/USING\s+\w+\s*\(([^)]+)\)/i);
  if (!m) m = d.match(/ON\s+(?:public\.)?[a-z_][a-z0-9_]*\s*\(([^)]+)\)/i);
  if (!m) return { ok: false, reason: 'index_column_list_unparsed', columns: [] };
  const columns = [];
  for (const part of m[1].split(',')) {
    const raw = part.trim();
    // strip expressions / ops: take first ident token
    const colM = raw.match(/^([a-z_][a-z0-9_]*)/i);
    if (!colM) {
      return { ok: false, reason: 'index_expr_unsupported', columns: [] };
    }
    columns.push(colM[1]);
  }
  return { ok: columns.length > 0, reason: columns.length ? null : 'empty_index_cols', columns };
}

/**
 * Classify function / trigger / ownership / ACL / extension / definition_mismatch.
 */
function isPgcryptoFipsModeKey(key) {
  const k = String(key || '').toLowerCase();
  return k.includes('fips_mode');
}

function classifyNonTableResidual(drift, expectedObj) {
  const d = drift || {};
  const section = String(d.section || '');
  const kind = String(d.kind || '');
  const key = String(d.key || '');

  if (kind === 'definition_mismatch') {
    // pgcrypto version/owner presentation often differs on Azure Flexible Server.
    if (section === 'extensions' && String(key).toLowerCase() === 'pgcrypto') {
      return {
        section,
        kind,
        outcomeClass: 'extension_policy',
        reason: 'pgcrypto_definition_mismatch_extension_policy',
        applySafe: false,
      };
    }
    return {
      section,
      kind,
      outcomeClass: 'blocker',
      reason: 'definition_mismatch_requires_manual_review',
      applySafe: false,
    };
  }

  // pgcrypto companion fips_mode() is expected-fixture noise vs Azure Flexible Server
  // presentation — normalization-only, never additive CREATE FUNCTION.
  if (isPgcryptoFipsModeKey(key)) {
    if (section === 'functions') {
      return {
        section,
        kind,
        outcomeClass: 'normalization_only',
        reason: 'pgcrypto_fips_mode_azure_presentation',
        applySafe: false,
      };
    }
    if (section === 'ownership' || section === 'acls') {
      return {
        section,
        kind,
        outcomeClass: 'normalization_only',
        reason: 'pgcrypto_fips_mode_privilege_presentation',
        applySafe: false,
      };
    }
  }

  if (section === 'functions' || section === 'triggers') {
    if (kind === 'expected_only') {
      return {
        section,
        kind,
        outcomeClass: 'exact_additive_canonical_apply',
        reason: 'missing_expected_object',
        applySafe: true,
      };
    }
    return {
      section,
      kind,
      outcomeClass: 'blocker',
      reason: 'unexpected_live_or_mismatch',
      applySafe: false,
    };
  }

  if (section === 'ownership' || section === 'acls') {
    return {
      section,
      kind,
      outcomeClass: 'privilege_mutation',
      reason: 'privilege_or_owner_drift',
      applySafe: false,
    };
  }

  if (section === 'extensions') {
    return {
      section,
      kind,
      outcomeClass: 'extension_policy',
      reason: 'extension_policy_gate',
      applySafe: false,
    };
  }

  if (section === 'indexes' && kind === 'expected_only') {
    return {
      section,
      kind,
      outcomeClass: 'exact_additive_canonical_apply',
      reason: 'missing_expected_index',
      applySafe: true,
      expected: expectedObj || null,
    };
  }

  return {
    section,
    kind,
    outcomeClass: 'blocker',
    reason: 'unclassified_residual',
    applySafe: false,
  };
}

function buildMigrationOwnershipIndex(migrationsDir, forward) {
  const index = Object.create(null);
  const renames = []; // { from, to, migrationId }

  for (const entry of forward) {
    const filePath = path.join(migrationsDir, entry.filename);
    const sql = fs.readFileSync(filePath, 'utf8');
    const owned = {
      tables: new Set(),
      columns: new Set(),
      indexes: new Set(),
      constraints: new Set(),
      functions: new Set(),
      triggers: new Set(),
      extensions: new Set(),
    };

    let m;
    const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi;
    while ((m = tableRe.exec(sql)) !== null) owned.tables.add(m[1].toLowerCase());

    const renameRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+RENAME\s+TO\s+([a-z_][a-z0-9_]*)/gi;
    while ((m = renameRe.exec(sql)) !== null) {
      const from = m[1].toLowerCase();
      const to = m[2].toLowerCase();
      owned.tables.add(from);
      owned.tables.add(to);
      renames.push({ from, to, migrationId: entry.id });
    }

    const colRe = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
    while ((m = colRe.exec(sql)) !== null) {
      owned.columns.add(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`);
    }

    const idxRe = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
    while ((m = idxRe.exec(sql)) !== null) owned.indexes.add(m[1].toLowerCase());

    const fnRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi;
    while ((m = fnRe.exec(sql)) !== null) owned.functions.add(m[1].toLowerCase());

    const trgRe = /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+([a-z_][a-z0-9_]*)/gi;
    while ((m = trgRe.exec(sql)) !== null) owned.triggers.add(m[1].toLowerCase());

    const extRe = /CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
    while ((m = extRe.exec(sql)) !== null) owned.extensions.add(m[1].toLowerCase());

    // Named constraints via ALTER TABLE ... ADD CONSTRAINT
    const cnameRe = /ADD\s+CONSTRAINT\s+([a-z_][a-z0-9_]*)/gi;
    while ((m = cnameRe.exec(sql)) !== null) owned.constraints.add(m[1].toLowerCase());

    index[entry.id] = owned;
  }

  // Propagate rename aliases onto every migration that owned the prior name so
  // residual keys on the post-rename table (clients) resolve to 001_init etc.
  for (const { from, to } of renames) {
    for (const owned of Object.values(index)) {
      if (owned.tables.has(from)) owned.tables.add(to);
      if (owned.tables.has(to)) owned.tables.add(from);
    }
  }

  // pgcrypto ships companion SQL-callable C function fips_mode(); attribute to
  // the earliest migration that creates extension pgcrypto.
  for (const owned of Object.values(index)) {
    if (owned.extensions.has('pgcrypto')) {
      owned.functions.add('fips_mode');
    }
  }

  return index;
}

function buildMigrationHashes(migrationsDir, forward) {
  const hashes = Object.create(null);
  for (const entry of forward) {
    const filePath = path.join(migrationsDir, entry.filename);
    hashes[entry.id] = {
      id: entry.id,
      filename: entry.filename,
      order: entry.order,
      sha256CanonicalLfV1: sha256CanonicalLfV1File(filePath),
    };
  }
  return hashes;
}

function resolveOwnershipForKey(section, key, ownershipIndex, forwardOrder) {
  const orderedIds = forwardOrder
    || Object.keys(ownershipIndex || {}).sort((a, b) => String(a).localeCompare(String(b)));

  for (const migrationId of orderedIds) {
    const owned = ownershipIndex[migrationId];
    if (!owned) continue;
    let hit = false;
    if (section === 'constraints') {
      const table = String(key).split('.')[0];
      const cname = String(key).split('.')[1];
      if (owned.tables.has(String(table).toLowerCase())) hit = true;
      if (cname && owned.constraints.has(String(cname).toLowerCase())) hit = true;
    } else if (section === 'indexes') {
      const idxName = key.includes('.') ? key.split('.').pop() : key;
      if (owned.indexes.has(String(idxName).toLowerCase())) hit = true;
    } else if (section === 'functions') {
      const fname = String(key).includes('(')
        ? String(key).split('(')[0].replace(/^public\./, '').split('.').pop()
        : String(key).split('.').pop();
      if (owned.functions.has(String(fname).toLowerCase())) hit = true;
    } else if (section === 'triggers') {
      const tname = key.includes('.') ? key.split('.').pop() : key;
      if (owned.triggers.has(String(tname).toLowerCase())) hit = true;
    } else if (section === 'extensions') {
      if (owned.extensions.has(String(key).toLowerCase())) hit = true;
    } else if (section === 'ownership' || section === 'acls') {
      // Prefer earliest migration that owns related table/function identity.
      const identity = String(key).includes(':') ? String(key).split(':').slice(1).join(':') : key;
      const bare = identity.replace(/^public\./, '');
      const fnName = bare.includes('(') ? bare.split('(')[0].split('.').pop() : null;
      const tableGuess = bare.split('.')[0];
      if (fnName && owned.functions.has(String(fnName).toLowerCase())) hit = true;
      if (owned.tables.has(String(tableGuess).toLowerCase())) hit = true;
      if (fnName === 'fips_mode' && owned.extensions.has('pgcrypto')) hit = true;
    }
    if (hit) return migrationId;
  }
  return null;
}

function lookupExpectedObject(expectedSnapshot, section, key) {
  const snap = expectedSnapshot || {};
  if (section === 'constraints') {
    return (snap.constraints || []).find((c) => `${c.table}.${c.name}.${c.type}` === key) || null;
  }
  if (section === 'indexes') {
    return (snap.indexes || []).find((i) => `${i.table}.${i.name}` === key) || null;
  }
  if (section === 'functions') {
    return (snap.functions || []).find((f) => (f.identity || f.name) === key) || null;
  }
  if (section === 'triggers') {
    return (snap.triggers || []).find((t) => `${t.table}.${t.name}` === key) || null;
  }
  if (section === 'ownership') {
    return (snap.ownership || []).find((o) => `${o.kind}:${o.identity}` === key) || null;
  }
  if (section === 'acls') {
    return (snap.acls || []).find((a) => `${a.kind}:${a.identity}` === key) || null;
  }
  if (section === 'extensions') {
    return (snap.extensions || []).find((e) => e.name === key) || null;
  }
  return null;
}

function dependencyRankForInventoryItem(item) {
  if (item.kind === 'definition_mismatch') return DEPENDENCY_ORDER_RANK.definition_mismatch;
  if (item.section === 'constraints') {
    const cat = item.constraintCategory || 'unsupported';
    if (cat === 'NOT_NULL_shaped') return DEPENDENCY_ORDER_RANK.NOT_NULL;
    if (cat === 'PRIMARY_KEY') return DEPENDENCY_ORDER_RANK.PRIMARY_KEY;
    if (cat === 'UNIQUE') return DEPENDENCY_ORDER_RANK.UNIQUE;
    if (cat === 'FOREIGN_KEY') return DEPENDENCY_ORDER_RANK.FOREIGN_KEY;
    if (cat === 'CHECK') return DEPENDENCY_ORDER_RANK.CHECK;
    return DEPENDENCY_ORDER_RANK.unsupported;
  }
  return DEPENDENCY_ORDER_RANK[item.section] != null
    ? DEPENDENCY_ORDER_RANK[item.section]
    : DEPENDENCY_ORDER_RANK.blocker;
}

function buildCanonicalKeyInventory(drifts, expectedSnapshot, ownershipIndex, migrationHashes) {
  const forwardOrder = Object.keys(migrationHashes || {})
    .sort((a, b) => {
      const oa = (migrationHashes[a] && migrationHashes[a].order) || 0;
      const ob = (migrationHashes[b] && migrationHashes[b].order) || 0;
      return oa - ob || String(a).localeCompare(String(b));
    });

  const items = [];
  for (const d of drifts || []) {
    const section = String(d.section || '');
    const kind = String(d.kind || '');
    const key = String(d.key || '');
    const expectedObj = lookupExpectedObject(expectedSnapshot, section, key);
    const ownerId = resolveOwnershipForKey(section, key, ownershipIndex || {}, forwardOrder);
    const ownerMeta = ownerId && migrationHashes ? migrationHashes[ownerId] : null;

    let constraintCategory = null;
    let constraintClass = null;
    let expectedMismatchType = null;
    let liveMismatchType = null;

    if (section === 'constraints' && expectedObj) {
      constraintClass = classifyConstraintResidual(expectedObj);
      constraintCategory = constraintClass.category;
      expectedMismatchType = expectedObj.type || null;
    } else if (section === 'constraints') {
      // Fallback from key suffix
      const parts = key.split('.');
      expectedMismatchType = parts.length >= 3 ? parts[parts.length - 1] : null;
      constraintCategory = expectedMismatchType === 'n'
        ? 'NOT_NULL_shaped'
        : (expectedMismatchType || 'unsupported');
    }

    const nonTable = section !== 'constraints'
      ? classifyNonTableResidual(d, expectedObj)
      : null;

    const item = {
      key,
      section,
      kind,
      expectedMismatchType: expectedMismatchType || (kind === 'expected_only' ? 'missing_on_live' : kind),
      liveMismatchType: kind === 'live_only' ? 'unexpected_on_live' : (kind === 'definition_mismatch' ? 'definition_differs' : null),
      constraintCategory,
      constraintClass: constraintClass || null,
      nonTableClass: nonTable,
      ownerMigrationId: ownerId,
      sha256CanonicalLfV1: ownerMeta ? ownerMeta.sha256CanonicalLfV1 : null,
      missingOwner: !ownerId,
      dependencyOrderRank: null,
    };
    item.dependencyOrderRank = dependencyRankForInventoryItem(item);
    items.push(item);
  }

  items.sort((a, b) => {
    const r = (a.dependencyOrderRank || 99) - (b.dependencyOrderRank || 99);
    if (r !== 0) return r;
    const s = String(a.section).localeCompare(String(b.section));
    if (s !== 0) return s;
    return String(a.key).localeCompare(String(b.key));
  });

  return {
    ok: true,
    count: items.length,
    items,
  };
}

function buildNotNullNullCountSql(table, column) {
  const t = quoteIdent(table);
  const c = quoteIdent(column);
  return {
    sql: `SELECT count(*) FILTER (WHERE ${c} IS NULL)::bigint AS null_count, `
      + `count(*)::bigint AS table_total FROM public.${t}`,
    table,
    column,
  };
}

function buildPkDuplicateSql(table, columns) {
  const t = quoteIdent(table);
  const cols = (columns || []).map((c) => quoteIdent(c));
  if (cols.length === 0) throw Object.assign(new Error('pk columns required'), { code: 'invalid_pk_columns' });
  const list = cols.join(', ');
  return {
    sql: `SELECT COALESCE(SUM(dup_cnt), 0)::bigint AS duplicate_count FROM (`
      + `SELECT count(*)::bigint - 1 AS dup_cnt FROM public.${t} `
      + `GROUP BY ${list} HAVING count(*) > 1`
      + `) s`,
    table,
    columns: columns.slice(),
  };
}

function buildUniqueDuplicateSql(table, columns) {
  const plan = buildPkDuplicateSql(table, columns);
  return { ...plan, kind: 'unique_duplicate' };
}

function buildFkOrphanSql(table, columns, refTable, refColumns) {
  const child = quoteIdent(table);
  const parent = quoteIdent(refTable);
  const childCols = (columns || []).map((c) => quoteIdent(c));
  const parentCols = (refColumns || []).map((c) => quoteIdent(c));
  if (childCols.length === 0 || childCols.length !== parentCols.length) {
    throw Object.assign(new Error('fk column arity mismatch'), { code: 'invalid_fk_columns' });
  }
  const join = childCols.map((c, i) => `c.${c} = p.${parentCols[i]}`).join(' AND ');
  const childNotNull = childCols.map((c) => `c.${c} IS NOT NULL`).join(' AND ');
  const parentNull = parentCols.map((c) => `p.${c} IS NULL`).join(' AND ');
  return {
    sql: `SELECT count(*)::bigint AS orphan_count FROM public.${child} c `
      + `LEFT JOIN public.${parent} p ON ${join} `
      + `WHERE ${childNotNull} AND ${parentNull}`,
    table,
    columns: columns.slice(),
    refTable,
    refColumns: refColumns.slice(),
  };
}

function buildCheckViolationSql(table, predicate) {
  const t = quoteIdent(table);
  const pred = String(predicate || '').trim();
  if (!pred) throw Object.assign(new Error('check predicate required'), { code: 'invalid_check_predicate' });
  // Identifier safety: reject semicolon / statements; predicate comes from expected schema only.
  if (/;|--|\/\*|\b(insert|update|delete|drop|alter|truncate|grant|revoke|create)\b/i.test(pred)) {
    throw Object.assign(new Error('unsafe check predicate'), { code: 'unsafe_check_predicate' });
  }
  return {
    sql: `SELECT count(*)::bigint AS violation_count FROM public.${t} WHERE NOT (${pred})`,
    table,
    predicate: pred,
  };
}

function buildIndexSupportProof(expectedIndex, liveIndexes, expectedColumns) {
  const idx = expectedIndex || {};
  const table = String(idx.table || '');
  const name = String(idx.name || '');
  const def = String(idx.def || '');
  const parsed = parseIndexColumnList(def);
  const tableCols = new Set(
    (expectedColumns || [])
      .filter((c) => c && c.table === table)
      .map((c) => String(c.column))
  );
  const missingColumns = (parsed.columns || []).filter((c) => !tableCols.has(c));
  const colSig = (parsed.columns || []).map((c) => c.toLowerCase()).join(',');
  const duplicateSemantic = (liveIndexes || []).filter((li) => {
    if (!li || String(li.table) !== table) return false;
    if (String(li.name) === name) return false;
    const other = parseIndexColumnList(li.def || '');
    if (!other.ok) return false;
    return other.columns.map((c) => c.toLowerCase()).join(',') === colSig;
  }).map((li) => li.name);

  return {
    key: `${table}.${name}`,
    table,
    name,
    columns: parsed.columns || [],
    columnsParsedOk: parsed.ok === true,
    supportingColumnsExist: parsed.ok === true && missingColumns.length === 0,
    missingColumns,
    duplicateSemanticIndexNames: duplicateSemantic,
    hasDuplicateSemanticIndex: duplicateSemantic.length > 0,
    tableRowCountSql: `SELECT count(*)::bigint AS table_total FROM public.${quoteIdent(table)}`,
    outcomeClass: 'exact_additive_canonical_apply',
  };
}

function coverageKey(section, key) {
  return `${String(section || '')}::${String(key || '')}`;
}

function assertCoverageComplete(inventory, preflightResults) {
  const items = (inventory && inventory.items) || [];
  const results = Array.isArray(preflightResults) ? preflightResults : [];
  // Composite section+key: ownership/acls share key shape `${kind}:${identity}`.
  const invKeys = items.map((i) => coverageKey(i.section, i.key));
  const resKeys = results.map((r) => coverageKey(r.section, r.key));
  const invSet = new Set(invKeys);
  const resSet = new Set(resKeys);

  const missing = invKeys.filter((k) => !resSet.has(k));
  const extras = resKeys.filter((k) => !invSet.has(k));
  const seen = new Set();
  const duplicates = [];
  for (const k of resKeys) {
    if (seen.has(k)) duplicates.push(k);
    seen.add(k);
  }
  const invSeen = new Set();
  const invDuplicates = [];
  for (const k of invKeys) {
    if (invSeen.has(k)) invDuplicates.push(k);
    invSeen.add(k);
  }
  const unowned = items.filter((i) => i.missingOwner === true).map((i) => coverageKey(i.section, i.key));

  const ok = missing.length === 0
    && extras.length === 0
    && duplicates.length === 0
    && invDuplicates.length === 0
    && unowned.length === 0
    && invKeys.length === resKeys.length
    && (inventory ? inventory.count === invKeys.length : true);

  return {
    ok,
    code: ok
      ? 'coverage_complete'
      : (unowned.length > 0 && missing.length === 0 && duplicates.length === 0
        ? 'coverage_unowned'
        : 'coverage_incomplete'),
    inventoryCount: invKeys.length,
    preflightCount: resKeys.length,
    missingKeys: missing,
    extraKeys: extras,
    duplicateKeys: [...duplicates, ...invDuplicates],
    unownedKeys: unowned,
  };
}

function planMutationBatches(inventory, preflightResults) {
  const items = (inventory && inventory.items) || [];
  const byKey = Object.create(null);
  for (const r of preflightResults || []) {
    if (r && r.key != null) byKey[coverageKey(r.section, r.key)] = r;
  }

  const batches = [];
  function pushBatch(id, outcome, keys, stopCriteria, rollbackCriteria) {
    batches.push({
      id,
      outcome,
      keys: keys.slice(),
      execute: false,
      stopCriteria,
      rollbackCriteria,
    });
  }

  const indexKeys = [];
  const notNullReady = [];
  const notNullBlocked = [];
  const pkUniqueReady = [];
  const pkUniqueBlocked = [];
  const fkReady = [];
  const fkBlocked = [];
  const checkReady = [];
  const checkBlocked = [];
  const fnTrigAdditive = [];
  const normalizationOnly = [];
  const privKeys = [];
  const extKeys = [];
  const defMismatchKeys = [];
  const unsupportedKeys = [];
  const otherBlocked = [];

  for (const item of items) {
    const ck = coverageKey(item.section, item.key);
    const pf = byKey[ck] || {};
    const nonTableOutcome = item.nonTableClass && item.nonTableClass.outcomeClass;

    if (item.kind === 'definition_mismatch') {
      if (nonTableOutcome === 'extension_policy') {
        extKeys.push(ck);
      } else if (nonTableOutcome === 'normalization_only') {
        normalizationOnly.push(ck);
      } else {
        defMismatchKeys.push(ck);
      }
      continue;
    }
    if (nonTableOutcome === 'normalization_only') {
      normalizationOnly.push(ck);
      continue;
    }
    if (item.section === 'indexes') {
      indexKeys.push(ck);
      continue;
    }
    if (item.section === 'functions' || item.section === 'triggers') {
      fnTrigAdditive.push(ck);
      continue;
    }
    if (item.section === 'ownership' || item.section === 'acls') {
      privKeys.push(ck);
      continue;
    }
    if (item.section === 'extensions') {
      extKeys.push(ck);
      continue;
    }
    if (item.section === 'constraints') {
      const cat = item.constraintCategory;
      if (cat === 'NOT_NULL_shaped') {
        if (pf.null_count === 0 && pf.nullableState === 'expected_no_live_yes') {
          notNullReady.push(ck);
        } else {
          notNullBlocked.push(ck);
        }
      } else if (cat === 'PRIMARY_KEY' || cat === 'UNIQUE') {
        if (Number(pf.duplicate_count) === 0) pkUniqueReady.push(ck);
        else pkUniqueBlocked.push(ck);
      } else if (cat === 'FOREIGN_KEY') {
        if (Number(pf.orphan_count) === 0) fkReady.push(ck);
        else fkBlocked.push(ck);
      } else if (cat === 'CHECK') {
        if (Number(pf.violation_count) === 0) checkReady.push(ck);
        else checkBlocked.push(ck);
      } else if (cat === 'unsupported') {
        unsupportedKeys.push(ck);
      } else {
        otherBlocked.push(ck);
      }
    } else {
      otherBlocked.push(ck);
    }
  }

  if (indexKeys.length) {
    pushBatch(
      'batch_01_indexes_additive',
      'exact_additive_canonical_apply',
      indexKeys,
      'stop if supporting columns missing or duplicate semantic index present',
      'DROP INDEX IF EXISTS for created indexes only; never DROP live-owned indexes'
    );
  }
  if (notNullReady.length) {
    pushBatch(
      'batch_02_not_null_safe',
      'exact_additive_canonical_apply',
      notNullReady,
      'stop if any null_count !== 0',
      'ALTER COLUMN DROP NOT NULL for applied columns only'
    );
  }
  if (notNullBlocked.length) {
    pushBatch(
      'batch_02b_not_null_blocked',
      'blocker',
      notNullBlocked,
      'null_count > 0 or nullable state unexpected — do not apply',
      'n/a — no apply'
    );
  }
  if (pkUniqueReady.length) {
    pushBatch(
      'batch_03_pk_unique_safe',
      'exact_additive_canonical_apply',
      pkUniqueReady,
      'stop if duplicate_count !== 0',
      'ALTER TABLE DROP CONSTRAINT for applied constraints only'
    );
  }
  if (pkUniqueBlocked.length) {
    pushBatch(
      'batch_03b_pk_unique_blocked',
      'blocker',
      pkUniqueBlocked,
      'duplicate_count > 0 — do not apply',
      'n/a — no apply'
    );
  }
  if (fkReady.length) {
    pushBatch(
      'batch_04_fk_safe',
      'exact_additive_canonical_apply',
      fkReady,
      'stop if orphan_count !== 0',
      'ALTER TABLE DROP CONSTRAINT for applied FKs only'
    );
  }
  if (fkBlocked.length) {
    pushBatch(
      'batch_04b_fk_blocked',
      'blocker',
      fkBlocked,
      'orphan_count > 0 — do not apply',
      'n/a — no apply'
    );
  }
  if (checkReady.length) {
    pushBatch(
      'batch_05_check_safe',
      'exact_additive_canonical_apply',
      checkReady,
      'stop if violation_count !== 0',
      'ALTER TABLE DROP CONSTRAINT for applied CHECKs only'
    );
  }
  if (checkBlocked.length) {
    pushBatch(
      'batch_05b_check_blocked',
      'blocker',
      checkBlocked,
      'violation_count > 0 — do not apply',
      'n/a — no apply'
    );
  }
  if (fnTrigAdditive.length) {
    pushBatch(
      'batch_06_functions_triggers_additive',
      'exact_additive_canonical_apply',
      fnTrigAdditive,
      'stop on create failure or unexpected live definition',
      'DROP FUNCTION/TRIGGER for applied objects only'
    );
  }
  if (normalizationOnly.length) {
    pushBatch(
      'batch_06b_normalization_only',
      'normalization_only',
      normalizationOnly,
      'stop — do not CREATE/ALTER; observer/fixture normalization only',
      'n/a — no apply'
    );
  }
  if (privKeys.length) {
    pushBatch(
      'batch_07_ownership_acls',
      'privilege_mutation',
      privKeys,
      'stop if privilege mutation policy blocker',
      'restore prior owner/ACL from catalog snapshot only after explicit approval'
    );
  }
  if (extKeys.length) {
    pushBatch(
      'batch_08_extensions',
      'extension_policy',
      extKeys,
      'stop — extension create/alter requires explicit extension policy approval',
      'n/a without policy'
    );
  }
  if (unsupportedKeys.length) {
    pushBatch(
      'batch_08b_unsupported_definitions',
      'blocker',
      unsupportedKeys,
      'stop — unsupported/name-mismatched constraint definitions are not additive-safe',
      'n/a — no apply'
    );
  }
  if (defMismatchKeys.length) {
    pushBatch(
      'batch_09_definition_mismatch',
      'blocker',
      defMismatchKeys,
      'stop — definition_mismatch is not additive-safe',
      'n/a — no apply'
    );
  }
  if (otherBlocked.length) {
    pushBatch(
      'batch_10_other_blocked',
      'blocker',
      otherBlocked,
      'stop — unclassified residual',
      'n/a — no apply'
    );
  }

  // Exact coverage: every inventory item appears in exactly one batch key slot.
  const allBatchKeys = batches.flatMap((b) => b.keys);
  const invCov = items.map((i) => coverageKey(i.section, i.key));
  const batchSet = new Set(allBatchKeys);
  const invSet = new Set(invCov);
  const missing = invCov.filter((k) => !batchSet.has(k));
  const extras = allBatchKeys.filter((k) => !invSet.has(k));
  const seen = new Set();
  const dups = [];
  for (const k of allBatchKeys) {
    if (seen.has(k)) dups.push(k);
    seen.add(k);
  }

  const execute = false;
  const ok = missing.length === 0
    && extras.length === 0
    && dups.length === 0
    && allBatchKeys.length === invCov.length
    && batches.every((b) => b.execute === false);

  return {
    ok,
    execute,
    code: ok ? 'mutation_batches_planned' : 'mutation_batches_incomplete',
    batches,
    coverage: {
      inventoryCount: invCov.length,
      batchKeyCount: allBatchKeys.length,
      missingKeys: missing,
      extraKeys: extras,
      duplicateKeys: dups,
    },
  };
}

function expectedTableSet(expectedSnapshot) {
  return new Set((expectedSnapshot && expectedSnapshot.tables) || []);
}

function expectedColumnNullable(expectedSnapshot, table, column) {
  const cols = (expectedSnapshot && expectedSnapshot.columns) || [];
  const hit = cols.find((c) => c.table === table && c.column === column);
  return hit ? String(hit.nullable || '') : null;
}

function liveColumnNullable(liveSnapshot, table, column) {
  const cols = (liveSnapshot && liveSnapshot.columns) || [];
  const hits = cols.filter((c) => c.table === table && c.column === column);
  if (hits.length === 0) return { present: false, nullable: null, ambiguous: false };
  if (hits.length > 1) return { present: true, nullable: null, ambiguous: true };
  return { present: true, nullable: String(hits[0].nullable || ''), ambiguous: false };
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

async function verifyResidualSession(client) {
  const errors = [];
  const tro = String(await safeShow(client, 'show_transaction_read_only')).toLowerCase();
  if (tro !== 'on') {
    errors.push({ code: 'non_read_only_session', message: `transaction_read_only=${tro || 'unset'}` });
  }
  const app = String(await safeShow(client, 'show_application_name'));
  if (app !== APPLICATION_NAME) {
    errors.push({
      code: 'wrong_application_name',
      message: `application_name must be ${APPLICATION_NAME}`,
    });
  }
  const st = String(await safeShow(client, 'show_statement_timeout'));
  if (!(st === '30s' || st === '30000ms' || st === '30000')) {
    errors.push({ code: 'bad_statement_timeout', message: st });
  }
  const lt = String(await safeShow(client, 'show_lock_timeout'));
  if (!(lt === '5s' || lt === '5000ms' || lt === '5000')) {
    errors.push({ code: 'bad_lock_timeout', message: lt });
  }
  return {
    ok: errors.length === 0,
    errors,
    show: {
      transaction_read_only: tro,
      application_name: app,
      statement_timeout: st,
      lock_timeout: lt,
    },
  };
}

async function captureServerVersionClass(client) {
  const serverVersion = String(await safeShow(client, 'show_server_version') || '');
  const serverVersionNumRaw = await safeShow(client, 'show_server_version_num');
  return classifyServerVersionClass(serverVersionNumRaw, serverVersion);
}

async function runAggregate(client, sql) {
  queryCalls += 1;
  const res = await client.query(sql);
  return (res.rows && res.rows[0]) || {};
}

async function preflightInventoryItem(client, item, expectedSnapshot, liveSnapshot) {
  const tables = expectedTableSet(expectedSnapshot);
  const base = {
    key: item.key,
    section: item.section,
    kind: item.kind,
    category: item.constraintCategory || null,
    outcomeClass: null,
    execute: false,
  };

  if (item.missingOwner) {
    return {
      ...base,
      outcomeClass: 'blocker',
      code: 'missing_owner',
      blocker: true,
    };
  }

  if (item.section === 'constraints') {
    const expectedObj = lookupExpectedObject(expectedSnapshot, 'constraints', item.key);
    const classified = expectedObj
      ? classifyConstraintResidual(expectedObj)
      : (item.constraintClass || { category: item.constraintCategory, ok: false, reason: 'missing_expected' });

    if (!classified.ok && classified.category === 'NOT_NULL_shaped') {
      return {
        ...base,
        outcomeClass: 'blocker',
        code: classified.reason || 'not_null_parse_failed',
        category: 'NOT_NULL_shaped',
      };
    }

    if (classified.category === 'NOT_NULL_shaped') {
      const table = classified.table;
      const column = classified.column;
      if (!tables.has(table)) {
        return { ...base, outcomeClass: 'blocker', code: 'table_not_in_expected', category: 'NOT_NULL_shaped' };
      }
      const expNull = expectedColumnNullable(expectedSnapshot, table, column);
      const liveNull = liveColumnNullable(liveSnapshot, table, column);
      if (!liveNull.present) {
        return {
          ...base,
          outcomeClass: 'blocker',
          code: 'missing_column',
          category: 'NOT_NULL_shaped',
          nullableState: 'missing_column',
        };
      }
      if (liveNull.ambiguous) {
        return {
          ...base,
          outcomeClass: 'blocker',
          code: 'ambiguous',
          category: 'NOT_NULL_shaped',
          nullableState: 'ambiguous',
        };
      }
      if (expNull !== 'NO' || liveNull.nullable !== 'YES') {
        return {
          ...base,
          outcomeClass: 'blocker',
          code: 'unexpected_nullable_state',
          category: 'NOT_NULL_shaped',
          nullableState: `expected_${expNull}_live_${liveNull.nullable}`,
          expectedNullable: expNull,
          liveNullable: liveNull.nullable,
        };
      }
      const plan = buildNotNullNullCountSql(table, column);
      const row = await runAggregate(client, plan.sql);
      const nullCount = Number(row.null_count) || 0;
      const tableTotal = Number(row.table_total) || 0;
      return {
        ...base,
        outcomeClass: nullCount === 0 ? 'exact_additive_canonical_apply' : 'blocker',
        code: nullCount === 0 ? 'not_null_preflight_ok' : 'not_null_has_nulls',
        category: 'NOT_NULL_shaped',
        nullableState: 'expected_no_live_yes',
        null_count: nullCount,
        table_total: tableTotal,
      };
    }

    if (classified.category === 'PRIMARY_KEY' || classified.category === 'UNIQUE') {
      if (!tables.has(classified.table)) {
        return { ...base, outcomeClass: 'blocker', code: 'table_not_in_expected', category: classified.category };
      }
      const plan = classified.category === 'PRIMARY_KEY'
        ? buildPkDuplicateSql(classified.table, classified.columns)
        : buildUniqueDuplicateSql(classified.table, classified.columns);
      const row = await runAggregate(client, plan.sql);
      const duplicateCount = Number(row.duplicate_count) || 0;
      return {
        ...base,
        outcomeClass: duplicateCount === 0 ? 'exact_additive_canonical_apply' : 'blocker',
        code: duplicateCount === 0 ? 'duplicate_preflight_ok' : 'duplicates_present',
        category: classified.category,
        duplicate_count: duplicateCount,
        columns: classified.columns,
      };
    }

    if (classified.category === 'FOREIGN_KEY') {
      if (!tables.has(classified.table) || !tables.has(classified.refTable)) {
        return { ...base, outcomeClass: 'blocker', code: 'table_not_in_expected', category: 'FOREIGN_KEY' };
      }
      const plan = buildFkOrphanSql(
        classified.table,
        classified.columns,
        classified.refTable,
        classified.refColumns
      );
      const row = await runAggregate(client, plan.sql);
      const orphanCount = Number(row.orphan_count) || 0;
      return {
        ...base,
        outcomeClass: orphanCount === 0 ? 'exact_additive_canonical_apply' : 'blocker',
        code: orphanCount === 0 ? 'fk_preflight_ok' : 'orphans_present',
        category: 'FOREIGN_KEY',
        orphan_count: orphanCount,
      };
    }

    if (classified.category === 'CHECK') {
      if (!tables.has(classified.table)) {
        return { ...base, outcomeClass: 'blocker', code: 'table_not_in_expected', category: 'CHECK' };
      }
      try {
        const plan = buildCheckViolationSql(classified.table, classified.predicate);
        const row = await runAggregate(client, plan.sql);
        const violationCount = Number(row.violation_count) || 0;
        return {
          ...base,
          outcomeClass: violationCount === 0 ? 'exact_additive_canonical_apply' : 'blocker',
          code: violationCount === 0 ? 'check_preflight_ok' : 'violations_present',
          category: 'CHECK',
          violation_count: violationCount,
        };
      } catch (e) {
        return {
          ...base,
          outcomeClass: 'blocker',
          code: e.code || 'check_preflight_failed',
          category: 'CHECK',
          message: String(e.message || '').slice(0, 240),
        };
      }
    }

    return {
      ...base,
      outcomeClass: 'blocker',
      code: 'unsupported_constraint',
      category: 'unsupported',
    };
  }

  if (item.section === 'indexes') {
    const expectedIdx = lookupExpectedObject(expectedSnapshot, 'indexes', item.key);
    if (!expectedIdx || !tables.has(expectedIdx.table)) {
      return { ...base, outcomeClass: 'blocker', code: 'index_or_table_missing' };
    }
    const proof = buildIndexSupportProof(
      expectedIdx,
      (liveSnapshot && liveSnapshot.indexes) || [],
      (expectedSnapshot && expectedSnapshot.columns) || []
    );
    let tableTotal = null;
    if (proof.supportingColumnsExist) {
      const row = await runAggregate(client, proof.tableRowCountSql);
      tableTotal = Number(row.table_total) || 0;
    }
    const ok = proof.supportingColumnsExist && !proof.hasDuplicateSemanticIndex;
    return {
      ...base,
      outcomeClass: ok ? 'exact_additive_canonical_apply' : 'blocker',
      code: ok ? 'index_preflight_ok' : 'index_preflight_blocked',
      supportingColumnsExist: proof.supportingColumnsExist,
      missingColumns: proof.missingColumns,
      hasDuplicateSemanticIndex: proof.hasDuplicateSemanticIndex,
      duplicateSemanticIndexNames: proof.duplicateSemanticIndexNames,
      table_total: tableTotal,
      columns: proof.columns,
    };
  }

  const nonTable = classifyNonTableResidual(
    { section: item.section, kind: item.kind, key: item.key },
    lookupExpectedObject(expectedSnapshot, item.section, item.key)
  );
  return {
    ...base,
    outcomeClass: nonTable.outcomeClass,
    code: nonTable.reason,
    applySafe: nonTable.applySafe === true,
  };
}

function loadOwnershipContext(options) {
  const migrationsDir = options.migrationsDir || MIGRATIONS_DIR;
  const manifest = options.manifest || loadManifest();
  const forward = options.forward || forwardEntries(manifest);
  const ownershipIndex = options.ownershipIndex
    || buildMigrationOwnershipIndex(migrationsDir, forward);
  const migrationHashes = options.migrationHashes
    || buildMigrationHashes(migrationsDir, forward);
  return { migrationsDir, manifest, forward, ownershipIndex, migrationHashes };
}

async function runResidualPreflightSession(client, expectedContract, ownershipCtx) {
  const session = await verifyResidualSession(client);
  if (!session.ok) {
    return {
      sessionReadOnly: false,
      transactionReadOnly: false,
      serverVersionClass: null,
      observerAfter: null,
      baseline: null,
      inventory: null,
      preflightResults: [],
      mutationBatches: null,
      coverage: null,
      productFingerprintLive: null,
      errors: session.errors,
    };
  }

  const serverVersionClass = await captureServerVersionClass(client);
  const product = await introspectProductSchema(client);
  queryCalls += Array.isArray(product.usedAllowlist) ? product.usedAllowlist.length : 20;
  const productFingerprintLive = fingerprintProductSchema(product.snapshot);
  const azureContext = {
    verified: true,
    host: EXPECTED_HOST,
    database: EXPECTED_DATABASE,
  };

  const normCmp = compareSnapshots(expectedContract.snapshot, product.snapshot, {
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext,
  });
  const observerAfter = summarizeCompare(normCmp);
  const baseline = assertBaselineMismatch(observerAfter);
  if (!baseline.ok) {
    return {
      sessionReadOnly: true,
      transactionReadOnly: String(session.show.transaction_read_only).toLowerCase() === 'on',
      serverVersionClass,
      observerAfter,
      baseline,
      inventory: null,
      preflightResults: [],
      mutationBatches: null,
      coverage: null,
      productFingerprintLive,
      errors: [{ code: 'baseline_drift_mismatch', message: baseline.message }],
      stopReason: 'baseline_drift_mismatch',
    };
  }

  const inventory = buildCanonicalKeyInventory(
    observerAfter.drifts,
    expectedContract.snapshot,
    ownershipCtx.ownershipIndex,
    ownershipCtx.migrationHashes
  );

  const preflightResults = [];
  for (const item of inventory.items) {
    // eslint-disable-next-line no-await-in-loop
    const pf = await preflightInventoryItem(
      client,
      item,
      expectedContract.snapshot,
      product.snapshot
    );
    preflightResults.push(pf);
  }

  const coverage = assertCoverageComplete(inventory, preflightResults);
  const mutationBatches = planMutationBatches(inventory, preflightResults);

  return {
    sessionReadOnly: true,
    transactionReadOnly: String(session.show.transaction_read_only).toLowerCase() === 'on',
    serverVersionClass,
    observerAfter: {
      ok: observerAfter.ok,
      match: observerAfter.match,
      code: observerAfter.code,
      mismatchCount: observerAfter.mismatchCount,
      counts: observerAfter.counts,
      mismatchSections: observerAfter.mismatchSections,
      notNullArtifactsNormalized: observerAfter.notNullArtifactsNormalized,
      normalizationError: observerAfter.normalizationError,
    },
    baseline,
    inventory: {
      count: inventory.count,
      items: inventory.items.map((i) => ({
        key: i.key,
        section: i.section,
        kind: i.kind,
        expectedMismatchType: i.expectedMismatchType,
        liveMismatchType: i.liveMismatchType,
        constraintCategory: i.constraintCategory,
        contype: i.constraintClass ? i.constraintClass.contype : null,
        constraintReason: i.constraintClass ? i.constraintClass.reason : null,
        ownerMigrationId: i.ownerMigrationId,
        sha256CanonicalLfV1: i.sha256CanonicalLfV1,
        missingOwner: i.missingOwner,
        dependencyOrderRank: i.dependencyOrderRank,
        nonTableOutcomeClass: i.nonTableClass ? i.nonTableClass.outcomeClass : null,
        nonTableReason: i.nonTableClass ? i.nonTableClass.reason : null,
      })),
    },
    preflightResults,
    mutationBatches,
    coverage,
    productFingerprintLive,
    errors: coverage.ok ? [] : [{ code: 'coverage_incomplete', message: 'coverage incomplete' }],
    stopReason: coverage.ok ? null : 'coverage_incomplete',
  };
}

function pickSafe(result) {
  return redactDeep(result, []);
}

/**
 * Main gated entry.
 * options: env, argv, httpRequest, ClientFactory, expectedContract,
 *          skipPostgres, injectedObserver / injectedPreflight,
 *          ownershipIndex, migrationHashes, migrationsDir, manifest, forward
 */
async function executeResidualDriftPreflight(opts) {
  const options = opts || {};
  const gate = evaluateResidualDriftPreflightGates(options);
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
      kvMutation: false,
      rbacMutation: false,
      networkMutation: false,
      firewallAction: false,
      ...getResidualDriftPreflightCounters(),
      applicationName: APPLICATION_NAME,
      errors: gate.errors,
      closed: true,
      committed: false,
      rolledBack: false,
      execute: false,
    });
  }

  const usedLiveHttp = typeof options.httpRequest !== 'function'
    && PHASE_D_RESIDUAL_DRIFT_PREFLIGHT_LIVE_ENABLED === true
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
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      errors: [{ code: 'http_disabled', message: 'inject httpRequest for offline proof' }],
      closed: true,
      execute: false,
    });
  }

  const authorityArgv = exactTargetAuthorityArgv();
  const authority = await executeActiveDbTargetAuthority({
    env: {
      ...targetAuthorityEnv(),
      ...(options.env || {}),
      [ENV_TARGET_AUTHORITY]: '1',
    },
    argv: authorityArgv,
    httpRequest,
    skipPostgres: true,
    expectedContract: options.expectedContract,
  });

  if (authority.sameTarget !== true) {
    return pickSafe({
      ok: false,
      code: authority.code || 'mismatched_app_kv_target',
      sameTarget: false,
      sameTargetReason: authority.sameTargetReason || null,
      blocker: authority.blocker || 'mismatched_app_kv_target',
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      kvMutation: false,
      usedLiveHttp,
      ...getResidualDriftPreflightCounters(),
      applicationName: APPLICATION_NAME,
      authorityCode: authority.code || null,
      errors: authority.errors || [],
      closed: true,
      committed: false,
      rolledBack: false,
      execute: false,
    });
  }

  if (options.skipPostgres === true) {
    return pickSafe({
      ok: true,
      code: 'same_target_authority_ok',
      sameTarget: true,
      sameTargetReason: authority.sameTargetReason || 'same_exact_authority',
      blocker: null,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      usedLiveHttp,
      realPostgresCall: false,
      ...getResidualDriftPreflightCounters(),
      applicationName: APPLICATION_NAME,
      baseline: null,
      inventory: null,
      preflightResults: null,
      mutationBatches: null,
      serverVersionClass: null,
      closed: true,
      committed: false,
      rolledBack: false,
      errors: [],
      execute: false,
    });
  }

  const injected = options.injectedPreflight || options.injectedObserver;
  if (injected) {
    return pickSafe({
      ok: injected.ok !== false,
      code: injected.code || 'residual_drift_preflight_injected',
      sameTarget: true,
      sameTargetReason: authority.sameTargetReason || 'same_exact_authority',
      blocker: injected.blocker || null,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      usedLiveHttp,
      realPostgresCall: false,
      sessionReadOnly: injected.sessionReadOnly !== false,
      transactionReadOnly: injected.transactionReadOnly !== false,
      serverVersionClass: injected.serverVersionClass || null,
      observerAfter: injected.observerAfter || null,
      baseline: injected.baseline || null,
      inventory: injected.inventory || null,
      preflightResults: injected.preflightResults || null,
      mutationBatches: injected.mutationBatches || null,
      coverage: injected.coverage || null,
      productFingerprintLive: injected.productFingerprintLive || null,
      ...getResidualDriftPreflightCounters(),
      applicationName: APPLICATION_NAME,
      closed: true,
      committed: injected.committed === true,
      rolledBack: injected.rolledBack === true,
      errors: injected.errors || [],
      execute: false,
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
      execute: false,
    });
  }

  const ownershipCtx = loadOwnershipContext(options);

  const loaded = await loadProtectedAdminCredentialsViaManagedIdentity({
    env: options.env || residualDriftPreflightEnv(),
    argv: options.argv || exactResidualDriftPreflightArgv(),
    httpRequest,
  });
  if (!loaded.ok) {
    return pickSafe({
      ok: false,
      code: loaded.code || 'credential_load_failed',
      sameTarget: true,
      blocker: loaded.code || 'credential_load_failed',
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      usedLiveHttp,
      ...getResidualDriftPreflightCounters(),
      applicationName: APPLICATION_NAME,
      errors: loaded.errors || [{ code: 'credential_load_failed', message: 'credential load failed' }],
      closed: true,
      execute: false,
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
        ...getResidualDriftPreflightCounters(),
        applicationName: APPLICATION_NAME,
        errors: [{ code: 'kv_target_invalid', message: 'credential handoff missing user/password' }],
        closed: true,
        execute: false,
      });
    }
    const user = loaded._user;
    const password = loaded._password;
    zeroPrivateCredentialRefs(loaded);

    const ClientFactory = options.ClientFactory || Client;
    const cfg = buildLockedPgClientConfig(user, password);
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

    const run = await runResidualPreflightSession(client, options.expectedContract, ownershipCtx);

    if (!run.sessionReadOnly || !run.transactionReadOnly) {
      queryCalls += 1;
      try {
        await client.query('ROLLBACK');
        rolledBack = true;
      } catch (_) { /* ignore */ }
      return pickSafe({
        ok: false,
        code: 'session_not_read_only',
        sameTarget: true,
        sameTargetReason: authority.sameTargetReason || 'same_exact_authority',
        blocker: 'session_not_read_only',
        liveMutation: false,
        schemaMutation: false,
        dataMutation: false,
        ledgerWritten: false,
        usedLiveHttp,
        realPostgresCall: true,
        sessionReadOnly: false,
        transactionReadOnly: false,
        serverVersionClass: run.serverVersionClass,
        observerAfter: run.observerAfter,
        baseline: run.baseline,
        ...getResidualDriftPreflightCounters(),
        applicationName: APPLICATION_NAME,
        errors: run.errors || [],
        closed: false,
        committed: false,
        rolledBack: true,
        execute: false,
      });
    }

    if (run.stopReason === 'baseline_drift_mismatch') {
      queryCalls += 1;
      try {
        await client.query('ROLLBACK');
        rolledBack = true;
      } catch (_) { /* ignore */ }
      try {
        endCalls += 1;
        await client.end();
        closed = true;
        client = null;
      } catch (_) {
        closed = true;
        client = null;
      }
      return pickSafe({
        ok: false,
        code: 'baseline_drift_mismatch',
        sameTarget: true,
        sameTargetReason: authority.sameTargetReason || 'same_exact_authority',
        blocker: 'baseline_drift_mismatch',
        liveMutation: false,
        schemaMutation: false,
        dataMutation: false,
        ledgerWritten: false,
        usedLiveHttp,
        realPostgresCall: true,
        sessionReadOnly: true,
        transactionReadOnly: true,
        serverVersionClass: run.serverVersionClass,
        observerAfter: run.observerAfter,
        baseline: run.baseline,
        productFingerprintLive: run.productFingerprintLive,
        ...getResidualDriftPreflightCounters(),
        applicationName: APPLICATION_NAME,
        postgresHost: RESIDUAL_LOCKS.postgresHost,
        database: RESIDUAL_LOCKS.database,
        sslmode: RESIDUAL_LOCKS.sslmode,
        errors: run.errors || [],
        closed: true,
        committed: false,
        rolledBack: true,
        execute: false,
      });
    }

    queryCalls += 1;
    await client.query('COMMIT');
    committed = true;

    try {
      endCalls += 1;
      await client.end();
      closed = true;
      client = null;
    } catch (_) {
      closed = true;
      client = null;
    }

    const pg15Ok = run.serverVersionClass
      && (run.serverVersionClass.ok === true || run.serverVersionClass.versionClass === 'postgresql_15');
    const versionClass = run.serverVersionClass && run.serverVersionClass.versionClass;
    const versionOk = versionClass === 'postgresql_15' || (run.serverVersionClass && run.serverVersionClass.ok === true);
    const coverageOk = run.coverage && run.coverage.ok === true;
    const liveOk = coverageOk && versionOk;

    return pickSafe({
      ok: liveOk,
      code: liveOk
        ? 'residual_drift_preflight_ok'
        : (coverageOk ? 'server_version_class_unexpected' : 'coverage_incomplete'),
      sameTarget: true,
      sameTargetReason: authority.sameTargetReason || 'same_exact_authority',
      blocker: liveOk ? null : (coverageOk ? 'server_version_class_unexpected' : 'coverage_incomplete'),
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      kvMutation: false,
      rbacMutation: false,
      networkMutation: false,
      firewallAction: false,
      usedLiveHttp,
      realPostgresCall: true,
      sessionReadOnly: true,
      transactionReadOnly: true,
      serverVersionClass: run.serverVersionClass,
      postgresql15Required: true,
      postgresql15Ok: versionClass === 'postgresql_15',
      observerAfter: run.observerAfter,
      baseline: run.baseline,
      inventory: run.inventory,
      preflightResults: run.preflightResults,
      mutationBatches: run.mutationBatches,
      coverage: run.coverage,
      productFingerprintLive: run.productFingerprintLive,
      ...getResidualDriftPreflightCounters(),
      applicationName: APPLICATION_NAME,
      postgresHost: RESIDUAL_LOCKS.postgresHost,
      database: RESIDUAL_LOCKS.database,
      sslmode: RESIDUAL_LOCKS.sslmode,
      subscriptionId: RESIDUAL_LOCKS.subscriptionId,
      resourceGroup: RESIDUAL_LOCKS.resourceGroup,
      containerAppName: RESIDUAL_LOCKS.containerAppName,
      managedIdentityName: RESIDUAL_LOCKS.managedIdentityName,
      keyVaultName: RESIDUAL_LOCKS.keyVaultName,
      kvSecretName: RESIDUAL_LOCKS.secretName,
      errors: run.errors || [],
      closed: true,
      committed: true,
      rolledBack: false,
      execute: false,
      pg15GateNote: pg15Ok ? null : 'recorded_non_pg15_or_classifier_ok',
    });
  } catch (e) {
    if (client && !closed) {
      try {
        await client.query('ROLLBACK');
        rolledBack = true;
      } catch (_) { /* ignore */ }
      try {
        endCalls += 1;
        await client.end();
      } catch (_) { /* ignore */ }
      closed = true;
    }
    return pickSafe({
      ok: false,
      code: e.code || 'residual_drift_preflight_failed',
      sameTarget: true,
      blocker: e.code || 'residual_drift_preflight_failed',
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      usedLiveHttp,
      ...getResidualDriftPreflightCounters(),
      applicationName: APPLICATION_NAME,
      errors: [{
        code: e.code || 'residual_drift_preflight_failed',
        message: String(e.message || 'failed').slice(0, 240),
      }],
      closed: true,
      committed,
      rolledBack,
      execute: false,
    });
  } finally {
    zeroPrivateCredentialRefs({ _secretValue: null, _dsn: null });
  }
}

function createScriptedResidualFakeClientFactory(script) {
  const s = script || {};
  function FakeClient() {
    this._ended = false;
    this.connect = async () => {};
    this.end = async () => {
      this._ended = true;
    };
    this.query = async (sql) => {
      const q = String(sql || '');
      if (/^BEGIN\b/i.test(q)) return { rows: [] };
      if (/^COMMIT\b/i.test(q)) return { rows: [] };
      if (/^ROLLBACK\b/i.test(q)) return { rows: [] };
      if (/application_name/i.test(q)) {
        return { rows: [{ application_name: APPLICATION_NAME }] };
      }
      if (/transaction_read_only/i.test(q)) {
        return { rows: [{ transaction_read_only: 'on' }] };
      }
      if (/statement_timeout/i.test(q)) {
        return { rows: [{ statement_timeout: '30s' }] };
      }
      if (/lock_timeout/i.test(q)) {
        return { rows: [{ lock_timeout: '5s' }] };
      }
      if (/server_version_num/i.test(q)) {
        return { rows: [{ server_version_num: s.serverVersionNum || '150018' }] };
      }
      if (/server_version/i.test(q)) {
        return { rows: [{ server_version: s.serverVersion || '15.18' }] };
      }
      if (/AS null_count/i.test(q)) {
        return { rows: [{ null_count: s.nullCount != null ? s.nullCount : 0, table_total: s.tableTotal != null ? s.tableTotal : 0 }] };
      }
      if (/AS duplicate_count/i.test(q)) {
        return { rows: [{ duplicate_count: s.duplicateCount != null ? s.duplicateCount : 0 }] };
      }
      if (/AS orphan_count/i.test(q)) {
        return { rows: [{ orphan_count: s.orphanCount != null ? s.orphanCount : 0 }] };
      }
      if (/AS violation_count/i.test(q)) {
        return { rows: [{ violation_count: s.violationCount != null ? s.violationCount : 0 }] };
      }
      if (/AS table_total/i.test(q)) {
        return { rows: [{ table_total: s.tableTotal != null ? s.tableTotal : 0 }] };
      }
      if (s.queryHandler) return s.queryHandler(q);
      if (s.introspectionHandler) return s.introspectionHandler(q);
      return { rows: s.introspectionRows || [] };
    };
  }
  return FakeClient;
}

function printCliHelp() {
  return [
    'phase-d:residual-drift-preflight — FOUNDATION Slice 14U',
    'DEFAULT: refused (zero ARM / zero KV / zero PostgreSQL).',
    '',
    'Merged target-authority + one read-only session classifying the exact 35',
    'residual drifts after NOT NULL normalization (azure_flexible_server_v1).',
    'Requires dual Phase D flags + TARGET_AUTHORITY + RESIDUAL_DRIFT_PREFLIGHT',
    '+ managed-identity + exact locked targets.',
    '',
    'Never prints/persists DSN, passwords, tokens, or secret versions.',
    'Zero mutation (execute:false; PHASE_D_LIVE_APPLY_ENABLED remains false).',
  ].join('\n');
}

module.exports = {
  PHASE_D_RESIDUAL_DRIFT_PREFLIGHT_LIVE_ENABLED,
  ENV_RESIDUAL_DRIFT_PREFLIGHT,
  CLI_PROVE_RESIDUAL_DRIFT_PREFLIGHT,
  APPLICATION_NAME,
  RESIDUAL_LOCKS,
  BASELINE_MISMATCH_COUNT,
  BASELINE_MISMATCH_SECTIONS,
  DEPENDENCY_ORDER_RANK,
  FORBIDDEN_ARGV_FLAGS,
  ALLOWED_ARGV_FLAGS,
  evaluateResidualDriftPreflightGates,
  exactResidualDriftPreflightArgv,
  residualDriftPreflightEnv,
  executeResidualDriftPreflight,
  createScriptedResidualFakeClientFactory,
  createInjectedTargetAuthorityHttp,
  createInjectedManagedIdentityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  resetResidualDriftPreflightCounters,
  getResidualDriftPreflightCounters,
  evaluateTargetAuthorityGates,
  printCliHelp,
  quoteIdent,
  classifyConstraintResidual,
  classifyNonTableResidual,
  buildCanonicalKeyInventory,
  planMutationBatches,
  assertBaselineMismatch,
  assertCoverageComplete,
  coverageKey,
  buildNotNullNullCountSql,
  buildPkDuplicateSql,
  buildUniqueDuplicateSql,
  buildFkOrphanSql,
  buildCheckViolationSql,
  buildIndexSupportProof,
  buildMigrationOwnershipIndex,
  buildMigrationHashes,
  parseParenColumnList,
  parseForeignKeyDefinition,
  parseCheckDefinition,
  parseIndexColumnList,
  groupMismatchSections,
  summarizeCompare,
  TARGETS,
};
