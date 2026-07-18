'use strict';

/**
 * Sunset schema-observer role + KV DSN provisioning helpers (FOUNDATION Slice 7).
 *
 * Fail-closed. Default is dry-run. Live Azure/Postgres mutation is disabled in this
 * slice even when --apply is passed (LIVE_APPLY_ENABLED=false). Credentials are
 * generated only at execution time and must never be logged or committed.
 */

const crypto = require('crypto');
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

/** Slice 7 keeps live mutation off. A later approved slice must flip this. */
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
  default_transaction_read_only: 'on',
});

/**
 * Explicit grants the role may receive. CONNECT only — observer queries use
 * pg_catalog; PUBLIC schema USAGE + catalog read already suffice and must not
 * be re-granted (would mutate ACL snapshots vs the committed contract).
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

function generateRolePassword() {
  // Execution-time only. Caller must not log/store beyond ephemeral apply memory.
  return crypto.randomBytes(32).toString('base64url');
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
  const list = (secrets || []).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const secret of list) {
    if (!secret) continue;
    out = out.split(String(secret)).join(REDACTED);
  }
  return out;
}

function assertNoNetworkMutation(commandText) {
  const s = String(commandText || '').toLowerCase();
  const hits = [];
  for (const marker of FORBIDDEN_NETWORK_MUTATION_MARKERS) {
    if (s.includes(marker)) hits.push(marker);
  }
  return { ok: hits.length === 0, hits };
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
        'FOUNDATION Slice 7 keeps live apply disabled; a later approved slice must enable LIVE_APPLY_ENABLED',
    });
  }
  return { ok: errors.length === 0, errors, liveApplyEnabled: LIVE_APPLY_ENABLED };
}

/**
 * Build an idempotent provision plan. Passwords appear only as placeholders in
 * printable steps; real credentials are supplied only when runProvision applies.
 */
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
      id: 'ensure_role',
      kind: 'postgres',
      mutation: true,
      summary: `Ensure LOGIN role ${t.roleName} with least-privilege attributes`,
      sqlTemplate: [
        `DO $provision$`,
        `BEGIN`,
        `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${t.roleName}') THEN`,
        `    CREATE ROLE ${t.roleName} LOGIN PASSWORD '$PASSWORD'`,
        `      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;`,
        `  ELSE`,
        `    ALTER ROLE ${t.roleName} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD '$PASSWORD';`,
        `  END IF;`,
        `END`,
        `$provision$;`,
      ].join('\n'),
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
      summary: `Idempotent Key Vault secret set for ${t.secretName} (value never printed)`,
      azArgsTemplate: [
        'keyvault',
        'secret',
        'set',
        '--vault-name',
        t.keyVault,
        '--name',
        t.secretName,
        '--value',
        '$DSN',
        '--subscription',
        t.subscriptionId,
      ],
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
      'Default CLI mode is dry-run; live apply is disabled in Slice 7.',
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
    'planned steps:',
  ];
  for (const step of plan.steps) {
    lines.push(`- [${step.id}] ${step.summary}`);
    if (step.sqlTemplate) {
      lines.push(step.sqlTemplate.replace(/\$PASSWORD/g, REDACTED));
    }
    if (step.azArgsTemplate) {
      lines.push(
        `az ${step.azArgsTemplate.map((a) => (a === '$DSN' ? REDACTED : a)).join(' ')}`,
      );
    }
  }
  for (const note of plan.notes || []) lines.push(`note: ${note}`);
  const text = lines.join('\n');
  return { mode: 'dry-run', ok: true, text, mutationsExecuted: 0 };
}

/**
 * Execute plan with injected adapters. In Slice 7, apply always refuses before
 * any adapter mutation when LIVE_APPLY_ENABLED is false.
 */
async function runProvision(options) {
  const opts = options || {};
  const applyRequested = opts.applyRequested === true;
  const env = opts.env || process.env;
  const targets = opts.targets || TARGETS;
  const plan = buildProvisionPlan(targets);
  const counters = {
    postgresExec: 0,
    keyVaultSet: 0,
    passwordGenerated: 0,
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

  // Unreachable while LIVE_APPLY_ENABLED=false; kept for a later approved slice.
  if (!plan.ok) {
    return { mode: 'apply', ok: false, errors: plan.errors, counters };
  }

  const password = typeof opts.generatePassword === 'function'
    ? opts.generatePassword()
    : generateRolePassword();
  counters.passwordGenerated += 1;
  const dsn = buildObserverDsn({ roleName: targets.roleName, password });
  const dsnGate = assertObserverDsnShape(dsn);
  if (!dsnGate.ok) {
    return { mode: 'apply', ok: false, errors: dsnGate.errors, counters };
  }

  const pg = opts.postgresExec;
  const kv = opts.keyVaultSecretSet;
  if (typeof pg !== 'function' || typeof kv !== 'function') {
    return {
      mode: 'apply',
      ok: false,
      errors: [{ code: 'missing_adapters', message: 'postgresExec and keyVaultSecretSet required' }],
      counters,
    };
  }

  for (const step of plan.steps) {
    if (step.kind === 'postgres') {
      const sql = String(step.sqlTemplate || '').split('$PASSWORD').join(password);
      counters.postgresExec += 1;
      await pg(sql, { stepId: step.id });
    } else if (step.kind === 'keyvault') {
      const args = (step.azArgsTemplate || []).map((a) => (a === '$DSN' ? dsn : a));
      counters.keyVaultSet += 1;
      const kvResult = await kv(args, { stepId: step.id, secretName: targets.secretName });
      const leaked = assertNoLeakedDsn(
        typeof kvResult === 'string' ? kvResult : JSON.stringify(kvResult || {}),
        dsn,
      );
      if (leaked.length) {
        return {
          mode: 'apply',
          ok: false,
          errors: [{ code: 'secret_leak', message: `Key Vault adapter leaked ${leaked.join(',')}` }],
          counters,
        };
      }
    }
  }

  return {
    mode: 'apply',
    ok: true,
    counters,
    text: redactSecrets(
      `APPLY COMPLETE role=${targets.roleName} secret=${targets.secretName} dsn=${dsn}`,
      [dsn, password],
    ),
  };
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
  REDACTED,
  OBSERVER_DSN_ENV,
  validateTargets,
  assertRoleAttributes,
  assertGrantsLeastPrivilege,
  generateRolePassword,
  buildObserverDsn,
  assertObserverDsnShape,
  redactSecrets,
  assertNoNetworkMutation,
  assertNoLeakedDsn,
  evaluateApplyGate,
  buildProvisionPlan,
  renderDryRunReport,
  runProvision,
  futureApplyCommand,
};
