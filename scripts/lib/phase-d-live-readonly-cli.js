'use strict';

/**
 * FOUNDATION Slice 14D — Phase D live read-only count-only operator CLI helpers
 *
 * Parses exact target confirmation args and refuses DSN/host/query/credential
 * argv. Does not open sockets or load Key Vault.
 */

const {
  TARGETS,
  ENV_LIVE_READONLY,
  ENV_LIVE_PREFLIGHT,
  ENV_SUBSCRIPTION,
  ENV_EXECUTE_COUNT_ONLY,
  CLI_EXECUTE_COUNT_ONLY,
  CREDENTIAL_USER_ENV,
  CREDENTIAL_PASSWORD_ENV,
  evaluateDualEnableFlags,
  evaluateExecuteCountOnlyGate,
  redactDeep,
} = require('./phase-d-live-readonly-boundary');

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
]);

const ALLOWED_ARGV_FLAGS = Object.freeze([
  CLI_EXECUTE_COUNT_ONLY,
  '--subscription',
  '--resource-group',
  '--postgres-server',
  '--database',
  '--help',
  '-h',
]);

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
    if (flag === CLI_EXECUTE_COUNT_ONLY || flag === '--help' || flag === '-h') {
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

  return { flags, values, unknown, forbidden, argv: args };
}

/**
 * Require exact locked subscription/RG/server/database confirmation args.
 * No host/DSN/query args.
 */
function evaluateExactTargetCliArgs(argv) {
  const parsed = parseArgvPairs(argv);
  const errors = [];

  if (parsed.forbidden.length > 0) {
    errors.push({
      code: 'caller_supplied_connect_forbidden',
      message: `forbidden argv flags: ${parsed.forbidden.join(',')}`,
      flags: parsed.forbidden.slice(),
    });
  }
  if (parsed.unknown.length > 0) {
    errors.push({
      code: 'unknown_cli_args',
      message: `unknown argv: ${parsed.unknown.join(',')}`,
      args: parsed.unknown.slice(),
    });
  }

  const subscription = parsed.values['--subscription'];
  const resourceGroup = parsed.values['--resource-group'];
  const postgresServer = parsed.values['--postgres-server'];
  const database = parsed.values['--database'];

  if (subscription !== TARGETS.subscriptionId) {
    errors.push({
      code: 'wrong_subscription',
      message: `--subscription must be exactly ${TARGETS.subscriptionId}`,
      got: subscription == null ? null : String(subscription),
    });
  }
  if (resourceGroup !== TARGETS.resourceGroup) {
    errors.push({
      code: 'wrong_resource_group',
      message: `--resource-group must be exactly ${TARGETS.resourceGroup}`,
      got: resourceGroup == null ? null : String(resourceGroup),
    });
  }
  if (postgresServer !== TARGETS.postgresServer) {
    errors.push({
      code: 'wrong_postgres_server',
      message: `--postgres-server must be exactly ${TARGETS.postgresServer}`,
      got: postgresServer == null ? null : String(postgresServer),
    });
  }
  if (database !== TARGETS.database) {
    errors.push({
      code: 'wrong_database',
      message: `--database must be exactly ${TARGETS.database}`,
      got: database == null ? null : String(database),
    });
  }

  const targets = {
    ...TARGETS,
    subscriptionId: subscription || '',
    resourceGroup: resourceGroup || '',
    postgresServer: postgresServer || '',
    database: database || '',
  };

  return {
    ok: errors.length === 0,
    errors,
    parsed,
    confirmed: errors.length === 0
      ? {
        subscriptionId: TARGETS.subscriptionId,
        resourceGroup: TARGETS.resourceGroup,
        postgresServer: TARGETS.postgresServer,
        database: TARGETS.database,
      }
      : null,
    targets,
  };
}

/**
 * Full CLI gate stack before any Client: dual flags + execute gate + exact
 * target confirmation args + protected admin env presence (values not logged).
 */
function evaluatePhaseDLiveReadonlyCliGates(opts) {
  const options = opts || {};
  const env = options.env || {};
  const argv = options.argv || [];

  const dual = evaluateDualEnableFlags(env);
  const exec = evaluateExecuteCountOnlyGate({ env, argv });
  const exact = evaluateExactTargetCliArgs(argv);

  const errors = [];
  if (!dual.ok) errors.push(...dual.errors);
  if (!exec.ok) errors.push(...exec.errors);
  if (!exact.ok) errors.push(...exact.errors);

  const hasUser = Boolean(String(env[CREDENTIAL_USER_ENV] || '').trim());
  const hasPassword = Boolean(String(env[CREDENTIAL_PASSWORD_ENV] || '').trim());
  if (!hasUser) {
    errors.push({
      code: 'pg_admin_user_required',
      message: `env ${CREDENTIAL_USER_ENV} is required`,
    });
  }
  if (!hasPassword) {
    errors.push({
      code: 'pg_admin_password_required',
      message: `env ${CREDENTIAL_PASSWORD_ENV} is required`,
    });
  }

  return redactDeep({
    ok: errors.length === 0,
    errors,
    dualOk: dual.ok,
    executeOk: exec.ok,
    exactTargetOk: exact.ok,
    hasProtectedAdminEnv: hasUser && hasPassword,
    confirmed: exact.confirmed,
    liveReadonlyConnectEnabled: true,
    liveQueryExecution: false,
    liveMutation: false,
    defaultEnabled: false,
  }, []);
}

function renderCliUsage() {
  return [
    'Phase D live read-only count-only preflight (FOUNDATION Slice 14D)',
    '',
    'DEFAULT: refused (zero pg Clients). Requires dual flags + execute gate +',
    'exact target confirmation + protected admin env. No DSN/host/query args.',
    '',
    'Required env:',
    `  ${ENV_LIVE_READONLY}=1`,
    `  ${ENV_LIVE_PREFLIGHT}=1`,
    `  ${ENV_EXECUTE_COUNT_ONLY}=1`,
    `  ${ENV_SUBSCRIPTION}=${TARGETS.subscriptionId}`,
    `  ${CREDENTIAL_USER_ENV}=<admin-login>`,
    `  ${CREDENTIAL_PASSWORD_ENV}=<admin-password>`,
    '',
    'Required argv:',
    `  ${CLI_EXECUTE_COUNT_ONLY}`,
    `  --subscription ${TARGETS.subscriptionId}`,
    `  --resource-group ${TARGETS.resourceGroup}`,
    `  --postgres-server ${TARGETS.postgresServer}`,
    `  --database ${TARGETS.database}`,
    '',
    'Forbidden argv: --dsn --host --query --connection-string --user --password --sql --port',
    '',
    'Does not load Key Vault. Does not mutate Azure/network/database schema.',
  ].join('\n');
}

module.exports = {
  FORBIDDEN_ARGV_FLAGS,
  ALLOWED_ARGV_FLAGS,
  parseArgvPairs,
  evaluateExactTargetCliArgs,
  evaluatePhaseDLiveReadonlyCliGates,
  renderCliUsage,
  TARGETS,
  ENV_LIVE_READONLY,
  ENV_LIVE_PREFLIGHT,
  ENV_SUBSCRIPTION,
  ENV_EXECUTE_COUNT_ONLY,
  CLI_EXECUTE_COUNT_ONLY,
  CREDENTIAL_USER_ENV,
  CREDENTIAL_PASSWORD_ENV,
};
