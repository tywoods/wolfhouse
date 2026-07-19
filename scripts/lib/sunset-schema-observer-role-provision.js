'use strict';

/**
 * Sunset schema-observer role + KV DSN provisioning helpers
 * (FOUNDATION Slice 7 + Slice 8 hardenings).
 *
 * Fail-closed. Default is dry-run. LIVE_APPLY_ENABLED remains false in this
 * slice — the real CLI never mutates Azure/PostgreSQL/Key Vault. Injected-adapter
 * tests may exercise executeConvergentBootstrap directly.
 *
 * Credentials are generated only at execution time, never logged, never passed
 * via process argv, and always redacted from adapter results/errors/reports.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const {
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  OBSERVER_DSN_ENV,
  assertNoLeakedDsn,
  parseDatabaseUrl,
  assertObserverTarget,
} = require('./sunset-schema-observer');

/** Locked Azure targets for Sunset staging only. */
const TARGETS = Object.freeze({
  subscriptionId: '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9',
  resourceGroup: 'luna-sunset-staging-rg',
  postgresServer: 'luna-sunset-staging-pg-app',
  postgresHost: EXPECTED_HOST,
  database: EXPECTED_DATABASE,
  keyVault: 'luna-sunset-staging-kv',
  roleName: 'sunset_schema_observer',
  secretName: 'sunset-schema-observer-database-url',
});

/** Live mutation stays off until a later approved execution slice. */
const LIVE_APPLY_ENABLED = false;

const ENV_APPLY_FLAG = 'SUNSET_SCHEMA_OBSERVER_ROLE_APPLY';
const ENV_SUBSCRIPTION = 'AZURE_SUBSCRIPTION_ID';
const ENV_PG_ADMIN_USER = 'SUNSET_STAGING_PG_ADMIN_USER';
const ENV_PG_ADMIN_PASSWORD = 'SUNSET_STAGING_PG_ADMIN_PASSWORD';

const ROLE_ATTRIBUTE_REQUIREMENTS = Object.freeze({
  rolcanlogin: true,
  rolsuper: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolinherit: false,
  rolreplication: false,
  rolbypassrls: false,
  default_transaction_read_only: 'on',
});

/**
 * CONNECT only — observer queries use pg_catalog; do not GRANT USAGE/SELECT on
 * public relations (would mutate ACL snapshots vs the committed contract).
 */
const ALLOWED_GRANTS = Object.freeze([
  Object.freeze({
    privilege: 'CONNECT',
    objectType: 'DATABASE',
    objectName: TARGETS.database,
  }),
]);

const FORBIDDEN_PRIVILEGES = Object.freeze([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
  'CREATE',
  'EXECUTE',
  'TEMPORARY',
  'TEMP',
  'ALL',
]);

const FORBIDDEN_NETWORK_MUTATION_MARKERS = Object.freeze([
  'firewall-rule',
  'firewall rule',
  'vnet-rule',
  'private-endpoint',
  'network-rule',
]);

const REDACTED = '***REDACTED***';

/** Generated passwords: URL-safe alphabet only (no quotes/SQL metacharacters). */
const PASSWORD_FORMAT = Object.freeze({
  pattern: /^[A-Za-z0-9_-]{40,128}$/,
  description: 'A-Za-z0-9_- length 40-128',
});

const BOOTSTRAP_ACTIONS = Object.freeze({
  CREATE: 'create',
  VERIFY_NOOP: 'verify_noop',
  REFUSE_INCONSISTENT: 'refuse_inconsistent',
});

function validateTargets(candidate) {
  const errors = [];
  const c = candidate || {};
  const checks = [
    ['subscriptionId', TARGETS.subscriptionId, 'wrong_subscription'],
    ['resourceGroup', TARGETS.resourceGroup, 'wrong_resource_group'],
    ['postgresServer', TARGETS.postgresServer, 'wrong_postgres_server'],
    ['database', TARGETS.database, 'wrong_database'],
    ['keyVault', TARGETS.keyVault, 'wrong_key_vault'],
    ['roleName', TARGETS.roleName, 'wrong_role_name'],
    ['secretName', TARGETS.secretName, 'wrong_secret_name'],
  ];
  for (const [key, expected, code] of checks) {
    if (String(c[key] || '') !== expected) {
      errors.push({
        code,
        message: `${key} must be exactly ${expected}`,
        got: c[key] == null ? null : String(c[key]),
      });
    }
  }
  if (c.postgresHost != null && String(c.postgresHost) !== TARGETS.postgresHost) {
    errors.push({
      code: 'wrong_postgres_host',
      message: `postgresHost must be exactly ${TARGETS.postgresHost}`,
      got: String(c.postgresHost),
    });
  }
  const forbiddenDb = String(c.database || '');
  if (/wolfhouse|production|^prod$/i.test(forbiddenDb) && forbiddenDb !== TARGETS.database) {
    errors.push({ code: 'forbidden_database', message: 'forbidden database name' });
  }
  if (/wh-prod|wh-staging-rg|wolfhouse/i.test(String(c.resourceGroup || ''))) {
    errors.push({ code: 'forbidden_resource_group', message: 'forbidden resource group' });
  }
  return { ok: errors.length === 0, errors };
}

function assertRoleAttributes(attrs) {
  const errors = [];
  const a = attrs || {};
  for (const [key, expected] of Object.entries(ROLE_ATTRIBUTE_REQUIREMENTS)) {
    const got = a[key];
    if (typeof expected === 'boolean') {
      if (got !== expected) {
        errors.push({
          code: 'role_attribute_mismatch',
          attribute: key,
          expected,
          got,
          message: `${key} must be ${expected}`,
        });
      }
    } else if (String(got == null ? '' : got).toLowerCase() !== String(expected).toLowerCase()) {
      errors.push({
        code: 'role_attribute_mismatch',
        attribute: key,
        expected,
        got,
        message: `${key} must be ${expected}`,
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

function normalizeGrant(grant) {
  return {
    privilege: String(grant.privilege || grant.priv || '').toUpperCase(),
    objectType: String(grant.objectType || grant.type || '').toUpperCase(),
    objectName: String(grant.objectName || grant.name || ''),
  };
}

function assertGrantsLeastPrivilege(grants) {
  const errors = [];
  const list = Array.isArray(grants) ? grants.map(normalizeGrant) : [];
  const allowedKey = (g) => `${g.privilege}|${g.objectType}|${g.objectName}`;
  const allowed = new Set(ALLOWED_GRANTS.map((g) => allowedKey(normalizeGrant(g))));

  for (const g of list) {
    if (FORBIDDEN_PRIVILEGES.includes(g.privilege)) {
      errors.push({
        code: 'excess_grant_privilege',
        grant: g,
        message: `forbidden privilege ${g.privilege} on ${g.objectType} ${g.objectName}`,
      });
      continue;
    }
    if (!allowed.has(allowedKey(g))) {
      errors.push({
        code: 'excess_grant',
        grant: g,
        message: `grant not in allowlist: ${g.privilege} on ${g.objectType} ${g.objectName}`,
      });
    }
  }

  for (const want of ALLOWED_GRANTS) {
    const key = allowedKey(normalizeGrant(want));
    if (!list.some((g) => allowedKey(g) === key)) {
      errors.push({
        code: 'missing_required_grant',
        grant: want,
        message: `required grant missing: ${want.privilege} on ${want.objectType} ${want.objectName}`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Fail closed if the role has any authority outside the CONNECT-only contract:
 * BYPASSRLS, memberships, ownership, excess ACLs/grants, wrong settings.
 */
function assertRoleAuthorityContract(inspection) {
  const errors = [];
  const info = inspection || {};
  const attrs = assertRoleAttributes(info.attributes || {});
  errors.push(...attrs.errors);

  const memberships = Array.isArray(info.memberships) ? info.memberships : [];
  if (memberships.length > 0) {
    errors.push({
      code: 'excess_role_membership',
      message: `role must not be a member of other roles (got ${memberships.join(',')})`,
      memberships,
    });
  }

  const owned = Array.isArray(info.ownedObjects) ? info.ownedObjects : [];
  if (owned.length > 0) {
    errors.push({
      code: 'excess_ownership',
      message: `role must not own database objects (got ${owned.length})`,
      ownedObjects: owned.slice(0, 20),
    });
  }

  const grants = assertGrantsLeastPrivilege(info.grants || []);
  errors.push(...grants.errors);

  const settings = info.roleSettings || {};
  const dro = String(settings.default_transaction_read_only || '').toLowerCase();
  if (dro !== 'on') {
    errors.push({
      code: 'role_setting_mismatch',
      message: 'default_transaction_read_only must be on',
      got: settings.default_transaction_read_only,
    });
  }

  const dbSettings = info.databaseSettings || {};
  for (const [key, value] of Object.entries(dbSettings)) {
    if (String(key).toLowerCase() === 'default_transaction_read_only') {
      if (String(value).toLowerCase() !== 'on') {
        errors.push({
          code: 'database_role_setting_mismatch',
          message: 'database-level default_transaction_read_only must be on',
          got: value,
        });
      }
    } else {
      errors.push({
        code: 'unexpected_database_role_setting',
        message: `unexpected database role setting ${key}`,
        key,
        value: REDACTED,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

function generateRolePassword() {
  // base64url → A-Za-z0-9_- only; pad length to satisfy PASSWORD_FORMAT.
  let out = '';
  while (out.length < 48) {
    out += crypto.randomBytes(32).toString('base64url');
  }
  return out.slice(0, 48);
}

function assertPasswordFormat(password) {
  const p = String(password == null ? '' : password);
  if (!PASSWORD_FORMAT.pattern.test(p)) {
    return {
      ok: false,
      errors: [{
        code: 'password_format_invalid',
        message: `password must match ${PASSWORD_FORMAT.description}`,
      }],
    };
  }
  if (/['";\\]/.test(p)) {
    return {
      ok: false,
      errors: [{ code: 'password_unsafe_chars', message: 'password contains unsafe SQL characters' }],
    };
  }
  return { ok: true, errors: [] };
}

/** Safe SQL string literal (doubled single quotes). Used for CREATE ROLE PASSWORD. */
function sqlStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Build executable CREATE ROLE SQL for the locked observer role.
 * Password must already pass PASSWORD_FORMAT; identifiers are never caller-controlled.
 * Callers must never log or return the resulting secret-bearing SQL.
 */
function buildCreateRoleSql(password, targets) {
  const t = targets || TARGETS;
  const targetGate = validateTargets(t);
  if (!targetGate.ok) {
    return { ok: false, errors: targetGate.errors, sql: null };
  }
  // Defense in depth: role/database names must remain exact locked constants.
  if (t.roleName !== TARGETS.roleName || t.database !== TARGETS.database) {
    return {
      ok: false,
      errors: [{ code: 'unlocked_identifier', message: 'role/database identifiers must remain locked constants' }],
      sql: null,
    };
  }
  const pwGate = assertPasswordFormat(password);
  if (!pwGate.ok) {
    return { ok: false, errors: pwGate.errors, sql: null };
  }
  const sql = [
    `CREATE ROLE ${TARGETS.roleName} LOGIN PASSWORD ${sqlStringLiteral(password)}`,
    '  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;',
  ].join('\n');
  return { ok: true, errors: [], sql };
}

/** Dry-run / plan display template — never contains a real password. */
function createRoleSqlPlanTemplate() {
  return [
    `CREATE ROLE ${TARGETS.roleName} LOGIN PASSWORD ${REDACTED}`,
    '  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;',
  ].join('\n');
}

/**
 * Narrow rollback for a role proven created by this execution.
 * Order: REVOKE CONNECT → RESET default_transaction_read_only → DROP ROLE.
 * No DROP OWNED. Never targets any other role/database.
 */
async function rollbackNewlyCreatedObserverRole(postgresExec, targets, counters) {
  const t = targets || TARGETS;
  const steps = [
    {
      id: 'rollback_revoke_connect',
      sql: `REVOKE CONNECT ON DATABASE ${TARGETS.database} FROM ${TARGETS.roleName};`,
    },
    {
      id: 'rollback_reset_readonly',
      sql: `ALTER ROLE ${TARGETS.roleName} RESET default_transaction_read_only;`,
    },
    {
      id: 'rollback_drop_new_role',
      sql: `DROP ROLE ${TARGETS.roleName};`,
    },
  ];
  const completed = [];
  const failures = [];
  for (const step of steps) {
    try {
      if (counters) counters.postgresExec += 1;
      await postgresExec(step.sql, [], { stepId: step.id, rollback: true });
      completed.push(step.id);
      if (step.id === 'rollback_drop_new_role' && counters) {
        counters.roleDroppedRollback += 1;
      }
    } catch (err) {
      failures.push({
        code: 'rollback_step_failed',
        stepId: step.id,
        message: String(err && err.message ? err.message : err),
      });
    }
  }
  const dropped = completed.includes('rollback_drop_new_role');
  return {
    ok: dropped && failures.length === 0,
    dropped,
    completed,
    failures,
    targetedRole: TARGETS.roleName,
    targetedDatabase: TARGETS.database,
  };
}

function buildObserverDsn({ roleName, password, host, database, sslmode }) {
  const user = roleName == null ? TARGETS.roleName : String(roleName);
  const pass = password == null ? '' : String(password);
  const h = host == null ? TARGETS.postgresHost : String(host);
  const db = database == null ? TARGETS.database : String(database);
  const mode = sslmode == null ? 'verify-full' : String(sslmode);
  const u = new URL('postgresql://placeholder');
  u.hostname = h;
  u.port = '5432';
  u.pathname = `/${db}`;
  u.username = user;
  u.password = pass;
  u.search = '';
  u.searchParams.set('sslmode', mode);
  return u.toString();
}

function assertObserverDsnShape(dsn) {
  const parsed = parseDatabaseUrl(dsn);
  if (!parsed.ok) {
    return { ok: false, errors: parsed.errors || [{ code: 'dsn_parse_failed', message: 'invalid DSN' }] };
  }
  const target = assertObserverTarget(parsed.parsed, { allowLocalEphemeral: false });
  const errors = [...(target.errors || [])];
  if (parsed.parsed.user && parsed.parsed.user !== TARGETS.roleName) {
    errors.push({
      code: 'wrong_dsn_role',
      message: `DSN user must be ${TARGETS.roleName}`,
    });
  }
  return { ok: errors.length === 0, errors };
}

function redactSecrets(text, secrets) {
  let out = String(text == null ? '' : text);
  const list = (secrets || []).filter(Boolean).map(String).sort((a, b) => b.length - a.length);
  for (const secret of list) {
    if (!secret) continue;
    out = out.split(secret).join(REDACTED);
  }
  // Also scrub any residual user:pass@ DSN shapes.
  out = out.replace(/postgres(?:ql)?:\/\/[^:\s/@]+:[^@\s/]+@/gi, `postgresql://${REDACTED}:`);
  return out;
}

function redactDeep(value, secrets, depth) {
  const d = depth == null ? 0 : depth;
  if (d > 8) return REDACTED;
  if (value == null) return value;
  if (typeof value === 'string') return redactSecrets(value, secrets);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSecrets(value.message, secrets),
      code: value.code,
    };
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets, d + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactDeep(v, secrets, d + 1);
    }
    return out;
  }
  return redactSecrets(String(value), secrets);
}

function assertNoNetworkMutation(commandText) {
  const s = String(commandText || '').toLowerCase();
  const hits = [];
  for (const marker of FORBIDDEN_NETWORK_MUTATION_MARKERS) {
    if (s.includes(marker)) hits.push(marker);
  }
  return { ok: hits.length === 0, hits };
}

function assertNoSecretInArgv(argv, secrets) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const list = (secrets || []).filter(Boolean).map(String);
  const leaks = [];
  for (const arg of args) {
    for (const secret of list) {
      if (secret && arg.includes(secret)) {
        leaks.push({ arg: REDACTED, reason: 'secret_in_argv' });
      }
    }
  }
  return { ok: leaks.length === 0, leaks };
}

function evaluateApplyGate(opts) {
  const options = opts || {};
  const applyRequested = options.applyRequested === true;
  const env = options.env || {};
  const errors = [];

  if (!applyRequested) {
    errors.push({
      code: 'apply_flag_required',
      message: 'mutations require explicit --apply (default is dry-run)',
    });
  }
  if (String(env[ENV_APPLY_FLAG] || '') !== '1') {
    errors.push({
      code: 'apply_env_required',
      message: `env ${ENV_APPLY_FLAG}=1 is required for apply`,
    });
  }
  if (String(env[ENV_SUBSCRIPTION] || '') !== TARGETS.subscriptionId) {
    errors.push({
      code: 'subscription_env_mismatch',
      message: `${ENV_SUBSCRIPTION} must equal locked Sunset staging subscription`,
    });
  }
  if (!LIVE_APPLY_ENABLED) {
    errors.push({
      code: 'live_apply_disabled',
      message:
        'LIVE_APPLY_ENABLED is false; live Azure/PostgreSQL/Key Vault mutation is disabled until a later approved slice',
    });
  }
  return { ok: errors.length === 0, errors, liveApplyEnabled: LIVE_APPLY_ENABLED };
}

/**
 * Decide convergent bootstrap action from pre-existing role/secret presence.
 * Never implicitly rotates credentials for an existing role.
 */
function decideBootstrapAction(state) {
  const s = state || {};
  const roleExists = s.roleExists === true;
  const secretExists = s.secretExists === true;
  const roleValid = s.roleValid === true;
  const secretValid = s.secretValid === true;

  if (!roleExists && !secretExists) {
    return { ok: true, action: BOOTSTRAP_ACTIONS.CREATE, errors: [] };
  }
  if (roleExists && secretExists && roleValid && secretValid) {
    return { ok: true, action: BOOTSTRAP_ACTIONS.VERIFY_NOOP, errors: [] };
  }
  return {
    ok: false,
    action: BOOTSTRAP_ACTIONS.REFUSE_INCONSISTENT,
    errors: [{
      code: 'inconsistent_preexisting_state',
      message:
        'pre-existing role/secret state is inconsistent with CONNECT-only contract; refuse (never rotate implicitly)',
      roleExists,
      secretExists,
      roleValid,
      secretValid,
    }],
  };
}

/**
 * Verify live Azure account subscription + exact RG/Postgres FQDN/KV before any DB/KV mutation.
 */
async function verifyLiveAzureTargets(adapters, targets) {
  const t = targets || TARGETS;
  const errors = [];
  const a = adapters || {};

  if (typeof a.getAccount !== 'function'
    || typeof a.getResourceGroup !== 'function'
    || typeof a.getPostgresServer !== 'function'
    || typeof a.getKeyVault !== 'function') {
    return {
      ok: false,
      errors: [{ code: 'missing_azure_adapters', message: 'live Azure verify adapters required' }],
    };
  }

  const account = await a.getAccount();
  if (!account || String(account.id || account.subscriptionId || '') !== t.subscriptionId) {
    errors.push({
      code: 'wrong_live_subscription',
      message: 'az account subscription must match locked Sunset staging subscription',
      got: account && (account.id || account.subscriptionId) ? String(account.id || account.subscriptionId) : null,
    });
  }

  const rg = await a.getResourceGroup(t.resourceGroup, t.subscriptionId);
  if (!rg || String(rg.name || '') !== t.resourceGroup) {
    errors.push({
      code: 'wrong_live_resource_group',
      message: `resource group must be exactly ${t.resourceGroup}`,
    });
  }

  const pg = await a.getPostgresServer(t.resourceGroup, t.postgresServer, t.subscriptionId);
  const fqdn = pg && (pg.fullyQualifiedDomainName || pg.fqdn || pg.host);
  if (!pg || String(pg.name || '') !== t.postgresServer) {
    errors.push({
      code: 'wrong_live_postgres_server',
      message: `postgres server must be exactly ${t.postgresServer}`,
    });
  }
  if (String(fqdn || '') !== t.postgresHost) {
    errors.push({
      code: 'wrong_live_postgres_fqdn',
      message: `postgres FQDN must be exactly ${t.postgresHost}`,
      got: fqdn == null ? null : String(fqdn),
    });
  }

  const kv = await a.getKeyVault(t.resourceGroup, t.keyVault, t.subscriptionId);
  if (!kv || String(kv.name || '') !== t.keyVault) {
    errors.push({
      code: 'wrong_live_key_vault',
      message: `key vault must be exactly ${t.keyVault}`,
    });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Connect only to locked verify-full hostname; require current_database() = sunset_staging.
 */
async function assertConnectedDatabase(adapters, targets) {
  const t = targets || TARGETS;
  const a = adapters || {};
  if (typeof a.connectInfo !== 'function' || typeof a.query !== 'function') {
    return {
      ok: false,
      errors: [{ code: 'missing_db_adapters', message: 'connectInfo and query adapters required' }],
    };
  }
  const info = await a.connectInfo();
  const errors = [];
  if (!info || String(info.host || '') !== t.postgresHost) {
    errors.push({
      code: 'wrong_db_connect_host',
      message: `must connect to locked host ${t.postgresHost}`,
      got: info && info.host ? String(info.host) : null,
    });
  }
  if (!info || String(info.sslmode || '').toLowerCase() !== 'verify-full') {
    errors.push({
      code: 'db_tls_not_verify_full',
      message: 'admin connection must use sslmode=verify-full',
    });
  }
  const row = await a.query('SELECT current_database() AS db');
  const db = row && (row.db || (row.rows && row.rows[0] && row.rows[0].db));
  if (String(db || '') !== t.database) {
    errors.push({
      code: 'wrong_current_database',
      message: `current_database() must be ${t.database}`,
      got: db == null ? null : String(db),
    });
  }
  return { ok: errors.length === 0, errors };
}

function buildProvisionPlan(targets) {
  const t = targets || TARGETS;
  const gate = validateTargets(t);
  if (!gate.ok) {
    return { ok: false, errors: gate.errors, steps: [] };
  }

  const roleAttrs = { ...ROLE_ATTRIBUTE_REQUIREMENTS };
  const grants = ALLOWED_GRANTS.map((g) => ({ ...g }));
  const roleCheck = assertRoleAttributes(roleAttrs);
  const grantCheck = assertGrantsLeastPrivilege(grants);
  if (!roleCheck.ok || !grantCheck.ok) {
    return {
      ok: false,
      errors: [...roleCheck.errors, ...grantCheck.errors],
      steps: [],
    };
  }

  const steps = [
    {
      id: 'verify_live_azure',
      kind: 'azure_verify',
      mutation: false,
      summary: 'Verify live subscription/RG/Postgres FQDN/Key Vault before any mutation',
    },
    {
      id: 'assert_current_database',
      kind: 'postgres_verify',
      mutation: false,
      summary: `Connect to ${t.postgresHost} (sslmode=verify-full); require current_database()=${t.database}`,
    },
    {
      id: 'inspect_preexisting',
      kind: 'inspect',
      mutation: false,
      summary: 'Inspect role presence, memberships, ownership, ACLs, settings, and KV secret',
    },
    {
      id: 'create_role_if_absent',
      kind: 'postgres',
      mutation: true,
      summary: `CREATE ROLE ${t.roleName} LOGIN … NOBYPASSRLS (only when role+secret both absent)`,
      sqlTemplate: createRoleSqlPlanTemplate(),
      passwordViaSqlLiteral: true,
      neverRotatesExisting: true,
    },
    {
      id: 'grant_connect',
      kind: 'postgres',
      mutation: true,
      summary: `GRANT CONNECT ON DATABASE ${t.database} TO ${t.roleName}`,
      sqlTemplate: `GRANT CONNECT ON DATABASE ${t.database} TO ${t.roleName};`,
    },
    {
      id: 'role_readonly_default',
      kind: 'postgres',
      mutation: true,
      summary: `ALTER ROLE ${t.roleName} SET default_transaction_read_only = on`,
      sqlTemplate: `ALTER ROLE ${t.roleName} SET default_transaction_read_only = on;`,
    },
    {
      id: 'kv_secret_set',
      kind: 'keyvault',
      mutation: true,
      summary: `Set KV secret ${t.secretName} via 0600 temp file (value never in argv)`,
      azArgsTemplate: [
        'keyvault',
        'secret',
        'set',
        '--vault-name',
        t.keyVault,
        '--name',
        t.secretName,
        '--file',
        '$SECRET_FILE',
        '--subscription',
        t.subscriptionId,
      ],
      valueViaArgv: false,
    },
  ];

  for (const step of steps) {
    const surface = JSON.stringify(step);
    const net = assertNoNetworkMutation(surface);
    if (!net.ok) {
      return {
        ok: false,
        errors: [{ code: 'forbidden_network_mutation', message: `plan contains ${net.hits.join(',')}` }],
        steps: [],
      };
    }
  }

  return {
    ok: true,
    errors: [],
    targets: { ...TARGETS },
    roleAttributes: roleAttrs,
    grants,
    observerDsnEnv: OBSERVER_DSN_ENV,
    steps,
    notes: [
      'No GRANT USAGE/SELECT on public relations — would mutate ACL snapshots vs observer contract.',
      'No firewall or network mutation steps.',
      'Never rotate an existing role password implicitly.',
      'CREATE ROLE PASSWORD uses validated URL-safe literal escaping (utility statements do not take bind params).',
      'KV writes use --file (0600 temp) or protected stdin — never --value with DSN in argv.',
      'KV failure after create: REVOKE CONNECT → RESET default_transaction_read_only → DROP ROLE (new role only).',
      'Default CLI mode is dry-run; LIVE_APPLY_ENABLED remains false.',
    ],
  };
}

function renderDryRunReport(plan) {
  if (!plan || !plan.ok) {
    return {
      mode: 'dry-run',
      ok: false,
      errors: (plan && plan.errors) || [{ code: 'invalid_plan', message: 'plan failed' }],
      text: 'DRY-RUN REFUSED',
    };
  }
  const lines = [
    'provision-sunset-schema-observer-role — DRY-RUN (no mutations)',
    `subscription=${plan.targets.subscriptionId}`,
    `resourceGroup=${plan.targets.resourceGroup}`,
    `postgresServer=${plan.targets.postgresServer}`,
    `database=${plan.targets.database}`,
    `keyVault=${plan.targets.keyVault}`,
    `role=${plan.targets.roleName}`,
    `secret=${plan.targets.secretName}`,
    `liveApplyEnabled=${LIVE_APPLY_ENABLED}`,
    '',
    'planned steps (convergent; create only when role+secret both absent):',
  ];
  for (const step of plan.steps) {
    lines.push(`- [${step.id}] ${step.summary}`);
    if (step.sqlTemplate) {
      lines.push(String(step.sqlTemplate));
    }
    if (step.azArgsTemplate) {
      lines.push(`az ${step.azArgsTemplate.map((a) => (a === '$SECRET_FILE' ? '<0600-temp-file>' : a)).join(' ')}`);
    }
  }
  for (const note of plan.notes || []) lines.push(`note: ${note}`);
  return { mode: 'dry-run', ok: true, text: lines.join('\n'), mutationsExecuted: 0 };
}

/**
 * Write secret to a 0600 temp file (or stdin via adapter). Never place DSN in argv.
 * Guarantees cleanup.
 */
async function writeKeyVaultSecretSecure(options) {
  const opts = options || {};
  const secrets = opts.secretsToRedact || [];
  const value = String(opts.value || '');
  const runAz = opts.runAz;
  const writeFile = opts.writeFile || fs.writeFileSync;
  const chmod = opts.chmod || fs.chmodSync;
  const unlink = opts.unlink || fs.unlinkSync;
  const mkdtemp = opts.mkdtemp || ((prefix) => fs.mkdtempSync(prefix));

  if (typeof runAz !== 'function') {
    throw Object.assign(new Error('runAz adapter required'), { code: 'missing_run_az' });
  }

  let dir = null;
  let filePath = null;
  try {
    dir = mkdtemp(path.join(os.tmpdir(), 'wh-obs-kv-'));
    filePath = path.join(dir, 'secret.dsn');
    writeFile(filePath, value, { encoding: 'utf8', mode: 0o600 });
    try {
      chmod(filePath, 0o600);
    } catch (_) {
      // Windows may ignore mode; still avoid argv leakage.
    }

    const args = [
      'keyvault',
      'secret',
      'set',
      '--vault-name',
      opts.vaultName,
      '--name',
      opts.secretName,
      '--file',
      filePath,
      '--subscription',
      opts.subscriptionId,
    ];
    const argvCheck = assertNoSecretInArgv(args, [value, ...secrets]);
    if (!argvCheck.ok) {
      throw Object.assign(new Error('DSN must not appear in process argv'), { code: 'secret_in_argv' });
    }

    const result = await runAz(args, {
      suppressOutput: true,
      secretFile: filePath,
    });
    const serialized = typeof result === 'string' ? result : JSON.stringify(result || {});
    const leaked = assertNoLeakedDsn(serialized, value);
    if (leaked.length) {
      throw Object.assign(new Error(`Key Vault adapter leaked ${leaked.join(',')}`), {
        code: 'secret_leak',
      });
    }
    return redactDeep(result || { ok: true }, [value, ...secrets]);
  } finally {
    if (filePath) {
      try {
        unlink(filePath);
      } catch (_) {
        /* ignore */
      }
    }
    if (dir) {
      try {
        fs.rmdirSync(dir);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

/**
 * Convergent bootstrap executor for injected adapters (unit tests + future live apply).
 * Does not check LIVE_APPLY_ENABLED — callers must gate that separately.
 */
async function executeConvergentBootstrap(options) {
  const opts = options || {};
  const targets = opts.targets || TARGETS;
  const secretsHeld = [];
  const counters = {
    azureVerify: 0,
    dbVerify: 0,
    inspect: 0,
    postgresExec: 0,
    keyVaultSet: 0,
    passwordGenerated: 0,
    roleCreated: 0,
    roleDroppedRollback: 0,
  };

  const fail = (errors, extra) => ({
    mode: 'apply',
    ok: false,
    refused: true,
    action: (extra && extra.action) || null,
    errors: redactDeep(errors, secretsHeld),
    counters,
    text: redactSecrets(
      `APPLY REFUSED: ${(errors || []).map((e) => e.code).join(',')}`,
      secretsHeld,
    ),
    ...(extra || {}),
  });

  try {
    const targetGate = validateTargets(targets);
    if (!targetGate.ok) return fail(targetGate.errors);

    counters.azureVerify += 1;
    const live = await verifyLiveAzureTargets(opts.azure, targets);
    if (!live.ok) return fail(live.errors);

    counters.dbVerify += 1;
    const dbGate = await assertConnectedDatabase(opts.db, targets);
    if (!dbGate.ok) return fail(dbGate.errors);

    if (typeof opts.inspectState !== 'function') {
      return fail([{ code: 'missing_inspect_adapter', message: 'inspectState adapter required' }]);
    }
    counters.inspect += 1;
    const pre = await opts.inspectState();
    const decision = decideBootstrapAction(pre);
    if (!decision.ok) {
      return fail(decision.errors, { action: decision.action });
    }

    if (decision.action === BOOTSTRAP_ACTIONS.VERIFY_NOOP) {
      const authority = assertRoleAuthorityContract(pre.inspection || {
        attributes: pre.attributes,
        memberships: pre.memberships,
        ownedObjects: pre.ownedObjects,
        grants: pre.grants,
        roleSettings: pre.roleSettings,
        databaseSettings: pre.databaseSettings,
      });
      if (!authority.ok) {
        return fail(authority.errors, { action: BOOTSTRAP_ACTIONS.REFUSE_INCONSISTENT });
      }
      return {
        mode: 'apply',
        ok: true,
        action: BOOTSTRAP_ACTIONS.VERIFY_NOOP,
        counters,
        text: 'APPLY NO-OP: role and secret already present and valid (no credential rotation)',
      };
    }

    // CREATE path — role and secret both absent.
    const password = typeof opts.generatePassword === 'function'
      ? opts.generatePassword()
      : generateRolePassword();
    counters.passwordGenerated += 1;
    secretsHeld.push(password);
    const pwGate = assertPasswordFormat(password);
    if (!pwGate.ok) return fail(pwGate.errors);

    const dsn = buildObserverDsn({ roleName: targets.roleName, password });
    secretsHeld.push(dsn);
    const dsnGate = assertObserverDsnShape(dsn);
    if (!dsnGate.ok) return fail(dsnGate.errors);

    if (typeof opts.postgresExec !== 'function') {
      return fail([{ code: 'missing_postgres_exec', message: 'postgresExec adapter required' }]);
    }

    let roleCreatedThisRun = false;
    let lastCreateSql = null;
    try {
      const createBuilt = buildCreateRoleSql(password, targets);
      if (!createBuilt.ok) return fail(createBuilt.errors);
      lastCreateSql = createBuilt.sql;
      secretsHeld.push(lastCreateSql);
      counters.postgresExec += 1;
      await opts.postgresExec(lastCreateSql, [], { stepId: 'create_role_if_absent' });
      roleCreatedThisRun = true;
      counters.roleCreated += 1;

      counters.postgresExec += 1;
      await opts.postgresExec(
        `GRANT CONNECT ON DATABASE ${TARGETS.database} TO ${TARGETS.roleName};`,
        [],
        { stepId: 'grant_connect' },
      );

      counters.postgresExec += 1;
      await opts.postgresExec(
        `ALTER ROLE ${TARGETS.roleName} SET default_transaction_read_only = on;`,
        [],
        { stepId: 'role_readonly_default' },
      );

      counters.keyVaultSet += 1;
      if (typeof opts.keyVaultSecretSetSecure === 'function') {
        await opts.keyVaultSecretSetSecure({
          vaultName: targets.keyVault,
          secretName: targets.secretName,
          subscriptionId: targets.subscriptionId,
          value: dsn,
          secretsToRedact: secretsHeld,
        });
      } else if (typeof opts.runAz === 'function') {
        await writeKeyVaultSecretSecure({
          vaultName: targets.keyVault,
          secretName: targets.secretName,
          subscriptionId: targets.subscriptionId,
          value: dsn,
          secretsToRedact: secretsHeld,
          runAz: opts.runAz,
          writeFile: opts.writeFile,
          chmod: opts.chmod,
          unlink: opts.unlink,
          mkdtemp: opts.mkdtemp,
        });
      } else {
        throw Object.assign(new Error('key vault adapter required'), { code: 'missing_kv_adapter' });
      }
    } catch (err) {
      let rollback = null;
      if (roleCreatedThisRun && typeof opts.postgresExec === 'function') {
        rollback = await rollbackNewlyCreatedObserverRole(opts.postgresExec, targets, counters);
        if (!rollback.ok) {
          return fail(
            [
              { code: 'kv_or_create_failed', message: String(err && err.message ? err.message : err) },
              {
                code: 'rollback_incomplete',
                message: 'rollback did not fully remove newly created observer role',
                completed: rollback.completed,
                failures: rollback.failures,
                targetedRole: rollback.targetedRole,
                targetedDatabase: rollback.targetedDatabase,
              },
            ],
            {
              action: BOOTSTRAP_ACTIONS.CREATE,
              roleCreatedThisRun: true,
              rolledBack: false,
              rollback,
            },
          );
        }
      }
      return fail(
        [{
          code: err && err.code ? err.code : 'bootstrap_failed',
          message: String(err && err.message ? err.message : err),
        }],
        {
          action: BOOTSTRAP_ACTIONS.CREATE,
          rolledBack: Boolean(rollback && rollback.ok),
          roleCreatedThisRun,
          rollback,
        },
      );
    } finally {
      lastCreateSql = null;
    }

    return {
      mode: 'apply',
      ok: true,
      action: BOOTSTRAP_ACTIONS.CREATE,
      counters,
      text: redactSecrets(
        `APPLY COMPLETE created role=${targets.roleName} secret=${targets.secretName}`,
        secretsHeld,
      ),
    };
  } catch (err) {
    return fail(
      [{
        code: 'unhandled_bootstrap_error',
        message: String(err && err.message ? err.message : err),
      }],
    );
  }
}

/**
 * CLI/entry runner. Default dry-run. Apply path refuses while LIVE_APPLY_ENABLED=false
 * unless opts.__testAllowApply is set (injected-adapter unit tests only).
 */
async function runProvision(options) {
  const opts = options || {};
  const applyRequested = opts.applyRequested === true;
  const env = opts.env || process.env;
  const targets = opts.targets || TARGETS;
  const plan = buildProvisionPlan(targets);
  const counters = {
    azureVerify: 0,
    dbVerify: 0,
    inspect: 0,
    postgresExec: 0,
    keyVaultSet: 0,
    passwordGenerated: 0,
    roleCreated: 0,
    roleDroppedRollback: 0,
  };

  if (!applyRequested) {
    const report = renderDryRunReport(plan);
    return {
      ...report,
      counters,
      applyGate: evaluateApplyGate({ applyRequested: false, env }),
    };
  }

  const applyGate = evaluateApplyGate({ applyRequested: true, env });
  const allowTest = opts.__testAllowApply === true;
  if (!allowTest) {
    if (!applyGate.ok) {
      return {
        mode: 'apply',
        ok: false,
        refused: true,
        errors: applyGate.errors,
        counters,
        text: `APPLY REFUSED: ${applyGate.errors.map((e) => e.code).join(',')}`,
      };
    }
  } else {
    // Injected-adapter unit tests may proceed past live_apply_disabled only.
    const blocking = applyGate.errors.filter((e) => e.code !== 'live_apply_disabled');
    if (blocking.length) {
      return {
        mode: 'apply',
        ok: false,
        refused: true,
        errors: blocking,
        counters,
        text: `APPLY REFUSED: ${blocking.map((e) => e.code).join(',')}`,
      };
    }
  }

  if (!plan.ok) {
    return { mode: 'apply', ok: false, errors: plan.errors, counters };
  }

  return executeConvergentBootstrap({
    targets,
    azure: opts.azure,
    db: opts.db,
    inspectState: opts.inspectState,
    postgresExec: opts.postgresExec,
    keyVaultSecretSetSecure: opts.keyVaultSecretSetSecure,
    runAz: opts.runAz,
    writeFile: opts.writeFile,
    chmod: opts.chmod,
    unlink: opts.unlink,
    mkdtemp: opts.mkdtemp,
    generatePassword: opts.generatePassword,
  });
}

function futureApplyCommand() {
  return [
    `${ENV_APPLY_FLAG}=1`,
    `${ENV_SUBSCRIPTION}=${TARGETS.subscriptionId}`,
    `${ENV_PG_ADMIN_USER}=<admin-login>`,
    `${ENV_PG_ADMIN_PASSWORD}=<admin-password>`,
    'node scripts/provision-sunset-schema-observer-role.js --apply',
  ].join(' ');
}

function safeTopLevelErrorMessage(err, secrets) {
  return redactSecrets(String(err && err.message ? err.message : err), secrets || []);
}

module.exports = {
  TARGETS,
  LIVE_APPLY_ENABLED,
  ENV_APPLY_FLAG,
  ENV_SUBSCRIPTION,
  ENV_PG_ADMIN_USER,
  ENV_PG_ADMIN_PASSWORD,
  ROLE_ATTRIBUTE_REQUIREMENTS,
  ALLOWED_GRANTS,
  FORBIDDEN_PRIVILEGES,
  FORBIDDEN_NETWORK_MUTATION_MARKERS,
  PASSWORD_FORMAT,
  BOOTSTRAP_ACTIONS,
  REDACTED,
  OBSERVER_DSN_ENV,
  validateTargets,
  assertRoleAttributes,
  assertGrantsLeastPrivilege,
  assertRoleAuthorityContract,
  generateRolePassword,
  assertPasswordFormat,
  sqlStringLiteral,
  buildCreateRoleSql,
  createRoleSqlPlanTemplate,
  rollbackNewlyCreatedObserverRole,
  buildObserverDsn,
  assertObserverDsnShape,
  redactSecrets,
  redactDeep,
  assertNoNetworkMutation,
  assertNoSecretInArgv,
  assertNoLeakedDsn,
  evaluateApplyGate,
  decideBootstrapAction,
  verifyLiveAzureTargets,
  assertConnectedDatabase,
  buildProvisionPlan,
  renderDryRunReport,
  writeKeyVaultSecretSecure,
  executeConvergentBootstrap,
  runProvision,
  futureApplyCommand,
  safeTopLevelErrorMessage,
};
