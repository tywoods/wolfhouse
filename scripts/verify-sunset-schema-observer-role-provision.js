'use strict';

/**
 * verify:sunset-schema-observer-role-provision — FOUNDATION Slice 7/8
 * RED→GREEN for fail-closed convergent observer role + KV secret provisioning.
 * Injected adapters only. No Azure mutations. No staging DB connections.
 */

const fs = require('fs');
const path = require('path');
const {
  TARGETS,
  LIVE_APPLY_ENABLED,
  ENV_APPLY_FLAG,
  ENV_SUBSCRIPTION,
  ROLE_ATTRIBUTE_REQUIREMENTS,
  ALLOWED_GRANTS,
  FORBIDDEN_PRIVILEGES,
  BOOTSTRAP_ACTIONS,
  PASSWORD_FORMAT,
  REDACTED,
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
  OBSERVER_DSN_ENV,
} = require('./lib/sunset-schema-observer-role-provision');
const { EXPECTED_HOST, EXPECTED_DATABASE } = require('./lib/sunset-schema-observer');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'provision-sunset-schema-observer-role.js');
const LIB = path.join(ROOT, 'scripts', 'lib', 'sunset-schema-observer-role-provision.js');
const BICEP_JOB = path.join(ROOT, 'infra', 'azure', 'sunset-staging', 'schema-observer-job.bicep');
const README = path.join(ROOT, 'infra', 'azure', 'sunset-staging', 'README.md');

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function validAttrs() {
  return { ...ROLE_ATTRIBUTE_REQUIREMENTS };
}

function validInspection() {
  return {
    attributes: validAttrs(),
    memberships: [],
    ownedObjects: [],
    grants: ALLOWED_GRANTS.map((g) => ({ ...g })),
    roleSettings: { default_transaction_read_only: 'on' },
    databaseSettings: {},
  };
}

function goodAzure() {
  return {
    async getAccount() {
      return { id: TARGETS.subscriptionId };
    },
    async getResourceGroup(name) {
      return { name };
    },
    async getPostgresServer(_rg, name) {
      return { name, fullyQualifiedDomainName: TARGETS.postgresHost };
    },
    async getKeyVault(_rg, name) {
      return { name };
    },
  };
}

function goodDb() {
  return {
    async connectInfo() {
      return { host: TARGETS.postgresHost, sslmode: 'verify-full' };
    },
    async query() {
      return { db: TARGETS.database };
    },
  };
}

function applyEnv() {
  return {
    [ENV_APPLY_FLAG]: '1',
    [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
  };
}

async function main() {
  console.log('verify:sunset-schema-observer-role-provision — RED→GREEN\n');

  pass('cli-exists', fs.existsSync(CLI));
  pass('lib-exists', fs.existsSync(LIB));
  pass('live-apply-disabled', LIVE_APPLY_ENABLED === false);
  pass('locked-subscription', TARGETS.subscriptionId === '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9');
  pass('locked-rg', TARGETS.resourceGroup === 'luna-sunset-staging-rg');
  pass('locked-pg', TARGETS.postgresServer === 'luna-sunset-staging-pg-app');
  pass('locked-db', TARGETS.database === 'sunset_staging' && TARGETS.database === EXPECTED_DATABASE);
  pass('locked-host', TARGETS.postgresHost === EXPECTED_HOST);
  pass('locked-kv', TARGETS.keyVault === 'luna-sunset-staging-kv');
  pass('locked-role', TARGETS.roleName === 'sunset_schema_observer');
  pass('locked-secret', TARGETS.secretName === 'sunset-schema-observer-database-url');
  pass('observer-dsn-env', OBSERVER_DSN_ENV === 'SUNSET_SCHEMA_OBSERVER_DATABASE_URL');
  pass('nobypassrls-required', ROLE_ATTRIBUTE_REQUIREMENTS.rolbypassrls === false);

  pass('green-targets', validateTargets(TARGETS).ok);
  pass(
    'red-wrong-subscription',
    !validateTargets({ ...TARGETS, subscriptionId: '00000000-0000-0000-0000-000000000000' }).ok,
  );
  pass(
    'red-wrong-rg',
    !validateTargets({ ...TARGETS, resourceGroup: 'wh-staging-rg' }).ok,
  );
  pass(
    'red-wrong-postgres',
    !validateTargets({ ...TARGETS, postgresServer: 'wh-staging-pg-app' }).ok,
  );
  pass(
    'red-wrong-database',
    !validateTargets({ ...TARGETS, database: 'wolfhouse_staging' }).ok,
  );
  pass(
    'red-wrong-key-vault',
    !validateTargets({ ...TARGETS, keyVault: 'wh-staging-kv' }).ok,
  );

  pass('green-role-attributes', assertRoleAttributes(validAttrs()).ok);
  pass(
    'red-bypassrls',
    !assertRoleAttributes({ ...validAttrs(), rolbypassrls: true }).ok,
  );
  pass(
    'red-writable-superuser',
    !assertRoleAttributes({ ...validAttrs(), rolsuper: true }).ok,
  );
  pass('green-connect-only-grants', assertGrantsLeastPrivilege(ALLOWED_GRANTS).ok);
  pass(
    'red-excess-select-grant',
    !assertGrantsLeastPrivilege([
      ...ALLOWED_GRANTS,
      { privilege: 'SELECT', objectType: 'TABLE', objectName: 'bookings' },
    ]).ok
      && FORBIDDEN_PRIVILEGES.includes('SELECT'),
  );

  {
    const ok = assertRoleAuthorityContract(validInspection());
    pass('green-authority-contract', ok.ok);
  }
  {
    const bad = assertRoleAuthorityContract({
      ...validInspection(),
      memberships: ['pg_read_all_data'],
    });
    pass('red-excess-membership', !bad.ok && bad.errors.some((e) => e.code === 'excess_role_membership'));
  }
  {
    const bad = assertRoleAuthorityContract({
      ...validInspection(),
      ownedObjects: ['public.bookings'],
    });
    pass('red-excess-ownership', !bad.ok && bad.errors.some((e) => e.code === 'excess_ownership'));
  }
  {
    const bad = assertRoleAuthorityContract({
      ...validInspection(),
      attributes: { ...validAttrs(), rolbypassrls: true },
    });
    pass('red-authority-bypassrls', !bad.ok);
  }

  // State machine
  pass(
    'green-sm-absent-create',
    decideBootstrapAction({
      roleExists: false,
      secretExists: false,
    }).action === BOOTSTRAP_ACTIONS.CREATE,
  );
  pass(
    'green-sm-both-valid-noop',
    decideBootstrapAction({
      roleExists: true,
      secretExists: true,
      roleValid: true,
      secretValid: true,
    }).action === BOOTSTRAP_ACTIONS.VERIFY_NOOP,
  );
  pass(
    'red-sm-role-only',
    decideBootstrapAction({
      roleExists: true,
      secretExists: false,
      roleValid: true,
      secretValid: false,
    }).action === BOOTSTRAP_ACTIONS.REFUSE_INCONSISTENT,
  );
  pass(
    'red-sm-secret-only',
    decideBootstrapAction({
      roleExists: false,
      secretExists: true,
      roleValid: false,
      secretValid: true,
    }).action === BOOTSTRAP_ACTIONS.REFUSE_INCONSISTENT,
  );
  pass(
    'red-sm-both-present-invalid',
    decideBootstrapAction({
      roleExists: true,
      secretExists: true,
      roleValid: false,
      secretValid: true,
    }).action === BOOTSTRAP_ACTIONS.REFUSE_INCONSISTENT,
  );

  // Live Azure verify
  {
    const ok = await verifyLiveAzureTargets(goodAzure(), TARGETS);
    pass('green-live-azure-targets', ok.ok);
  }
  {
    const bad = await verifyLiveAzureTargets({
      ...goodAzure(),
      async getAccount() {
        return { id: '00000000-0000-0000-0000-000000000000' };
      },
    }, TARGETS);
    pass(
      'red-wrong-live-subscription',
      !bad.ok && bad.errors.some((e) => e.code === 'wrong_live_subscription'),
    );
  }
  {
    const bad = await verifyLiveAzureTargets({
      ...goodAzure(),
      async getPostgresServer() {
        return { name: TARGETS.postgresServer, fullyQualifiedDomainName: 'evil.example.com' };
      },
    }, TARGETS);
    pass(
      'red-wrong-live-postgres-fqdn',
      !bad.ok && bad.errors.some((e) => e.code === 'wrong_live_postgres_fqdn'),
    );
  }
  {
    const bad = await verifyLiveAzureTargets({
      ...goodAzure(),
      async getKeyVault() {
        return { name: 'wh-staging-kv' };
      },
    }, TARGETS);
    pass(
      'red-wrong-live-key-vault',
      !bad.ok && bad.errors.some((e) => e.code === 'wrong_live_key_vault'),
    );
  }

  // DB connect / current_database
  {
    const ok = await assertConnectedDatabase(goodDb(), TARGETS);
    pass('green-current-database', ok.ok);
  }
  {
    const bad = await assertConnectedDatabase({
      async connectInfo() {
        return { host: '127.0.0.1', sslmode: 'verify-full' };
      },
      async query() {
        return { db: TARGETS.database };
      },
    }, TARGETS);
    pass(
      'red-wrong-db-connect-host',
      !bad.ok && bad.errors.some((e) => e.code === 'wrong_db_connect_host'),
    );
  }
  {
    const bad = await assertConnectedDatabase({
      async connectInfo() {
        return { host: TARGETS.postgresHost, sslmode: 'require' };
      },
      async query() {
        return { db: TARGETS.database };
      },
    }, TARGETS);
    pass(
      'red-db-tls-not-verify-full',
      !bad.ok && bad.errors.some((e) => e.code === 'db_tls_not_verify_full'),
    );
  }
  {
    const bad = await assertConnectedDatabase({
      async connectInfo() {
        return { host: TARGETS.postgresHost, sslmode: 'verify-full' };
      },
      async query() {
        return { db: 'postgres' };
      },
    }, TARGETS);
    pass(
      'red-wrong-current-database',
      !bad.ok && bad.errors.some((e) => e.code === 'wrong_current_database'),
    );
  }

  // Password format + quote-bearing handling
  {
    const pw = generateRolePassword();
    pass('green-password-format', assertPasswordFormat(pw).ok && PASSWORD_FORMAT.pattern.test(pw));
    pass('green-sql-literal-quotes', sqlStringLiteral("a'b") === "'a''b'");
    pass(
      'red-password-with-quote',
      !assertPasswordFormat("bad'password_with_quote_chars_!!!!!!!!").ok,
    );
  }

  // KV secure write — no argv leakage + cleanup
  {
    const dsn = buildObserverDsn({ password: generateRolePassword() });
    let seenArgs = null;
    let files = new Set();
    const result = await writeKeyVaultSecretSecure({
      vaultName: TARGETS.keyVault,
      secretName: TARGETS.secretName,
      subscriptionId: TARGETS.subscriptionId,
      value: dsn,
      secretsToRedact: [dsn],
      mkdtemp: (prefix) => {
        const d = fs.mkdtempSync(prefix);
        files.add(d);
        return d;
      },
      writeFile: (p, v, o) => {
        files.add(p);
        fs.writeFileSync(p, v, o);
      },
      unlink: (p) => {
        fs.unlinkSync(p);
        files.delete(p);
      },
      runAz: async (args) => {
        seenArgs = args;
        return { name: TARGETS.secretName, value: REDACTED };
      },
    });
    pass(
      'green-kv-no-argv-leak',
      seenArgs
        && assertNoSecretInArgv(seenArgs, [dsn]).ok
        && seenArgs.includes('--file')
        && !seenArgs.includes('--value'),
    );
    pass(
      'green-kv-temp-cleaned',
      [...files].filter((p) => {
        try {
          return fs.existsSync(p) && fs.statSync(p).isFile();
        } catch (_) {
          return false;
        }
      }).length === 0,
    );
    pass('green-kv-result-redacted', !JSON.stringify(result).includes(dsn));
  }

  // Convergent create path — SQL literal password (not protocol bind params)
  {
    const password = generateRolePassword();
    const dsn = buildObserverDsn({ password });
    const expectedLiteral = sqlStringLiteral(password);
    const sqlLog = [];
    const result = await executeConvergentBootstrap({
      targets: TARGETS,
      azure: goodAzure(),
      db: goodDb(),
      generatePassword: () => password,
      inspectState: async () => ({
        roleExists: false,
        secretExists: false,
        roleValid: false,
        secretValid: false,
      }),
      postgresExec: async (sql, params) => {
        sqlLog.push({ sql, params: params || [] });
      },
      keyVaultSecretSetSecure: async ({ value }) => {
        if (value !== dsn) throw new Error('unexpected dsn');
        return { ok: true };
      },
    });
    const create = sqlLog.find((s) => /CREATE ROLE/.test(s.sql));
    pass(
      'green-create-bootstrap',
      result.ok
        && result.action === BOOTSTRAP_ACTIONS.CREATE
        && result.counters.roleCreated === 1
        && result.counters.keyVaultSet === 1
        && create
        && /NOBYPASSRLS/.test(create.sql)
        && create.sql.includes(`PASSWORD ${expectedLiteral}`)
        && sqlLog.some((s) => /GRANT CONNECT/.test(s.sql))
        && !JSON.stringify(result).includes(password)
        && !JSON.stringify(result).includes(dsn)
        && !JSON.stringify(result).includes(create.sql),
    );
    pass(
      'green-create-sql-literal-password',
      create
        && !/\$1\b/.test(create.sql)
        && create.params.length === 0
        && create.sql.includes(expectedLiteral)
        && buildCreateRoleSql(password).ok
        && buildCreateRoleSql(password).sql === create.sql,
    );
  }

  // Invalid / quote-bearing passwords refused before postgresExec
  {
    let pgCalls = 0;
    const badQuote = "bad'quote_password_!!!!!!!!!!!!!!!!!!!!!!!!";
    const result = await executeConvergentBootstrap({
      azure: goodAzure(),
      db: goodDb(),
      generatePassword: () => badQuote,
      inspectState: async () => ({ roleExists: false, secretExists: false }),
      postgresExec: async () => {
        pgCalls += 1;
      },
      keyVaultSecretSetSecure: async () => {},
    });
    pass(
      'red-invalid-password-refused-before-exec',
      !result.ok
        && pgCalls === 0
        && result.counters.postgresExec === 0
        && result.errors.some((e) => e.code === 'password_format_invalid' || e.code === 'password_unsafe_chars')
        && !JSON.stringify(result).includes(badQuote),
    );
    pass(
      'red-build-create-role-rejects-invalid',
      !buildCreateRoleSql(badQuote).ok && buildCreateRoleSql(badQuote).sql == null,
    );
  }

  // Repeated no-op apply
  {
    const sqlLog = [];
    const kvCalls = [];
    const result = await executeConvergentBootstrap({
      azure: goodAzure(),
      db: goodDb(),
      inspectState: async () => ({
        roleExists: true,
        secretExists: true,
        roleValid: true,
        secretValid: true,
        inspection: validInspection(),
      }),
      postgresExec: async (sql) => {
        sqlLog.push(sql);
      },
      keyVaultSecretSetSecure: async () => {
        kvCalls.push(1);
      },
    });
    pass(
      'green-repeated-noop-apply',
      result.ok
        && result.action === BOOTSTRAP_ACTIONS.VERIFY_NOOP
        && sqlLog.length === 0
        && kvCalls.length === 0
        && result.counters.passwordGenerated === 0
        && result.counters.roleCreated === 0,
    );
  }

  // Inconsistent states refuse with zero mutation
  {
    const sqlLog = [];
    const result = await executeConvergentBootstrap({
      azure: goodAzure(),
      db: goodDb(),
      inspectState: async () => ({
        roleExists: true,
        secretExists: false,
        roleValid: true,
        secretValid: false,
      }),
      postgresExec: async (sql) => {
        sqlLog.push(sql);
      },
      keyVaultSecretSetSecure: async () => {},
    });
    pass(
      'red-inconsistent-role-without-secret',
      !result.ok
        && result.action === BOOTSTRAP_ACTIONS.REFUSE_INCONSISTENT
        && sqlLog.length === 0
        && result.counters.roleCreated === 0,
    );
  }

  // KV failure → ordered REVOKE → RESET → DROP; DROP fails unless prior steps ran
  {
    const sqlLog = [];
    const sim = {
      exists: false,
      hasConnect: false,
      hasReadonly: false,
    };
    const result = await executeConvergentBootstrap({
      azure: goodAzure(),
      db: goodDb(),
      generatePassword: () => generateRolePassword(),
      inspectState: async () => ({
        roleExists: false,
        secretExists: false,
      }),
      postgresExec: async (sql) => {
        const s = String(sql);
        sqlLog.push(s);
        if (/^CREATE ROLE sunset_schema_observer\b/.test(s)) {
          sim.exists = true;
          return;
        }
        if (/^GRANT CONNECT ON DATABASE sunset_staging TO sunset_schema_observer/.test(s)) {
          sim.hasConnect = true;
          return;
        }
        if (/^ALTER ROLE sunset_schema_observer SET default_transaction_read_only = on/.test(s)) {
          sim.hasReadonly = true;
          return;
        }
        if (/^REVOKE CONNECT ON DATABASE sunset_staging FROM sunset_schema_observer/.test(s)) {
          if (!sim.exists) throw new Error('revoke on missing role');
          sim.hasConnect = false;
          return;
        }
        if (/^ALTER ROLE sunset_schema_observer RESET default_transaction_read_only/.test(s)) {
          if (!sim.exists) throw new Error('reset on missing role');
          sim.hasReadonly = false;
          return;
        }
        if (/^DROP ROLE sunset_schema_observer\s*;/.test(s)) {
          // Fail closed unless REVOKE + RESET completed first (simulates PG dependency).
          if (sim.hasConnect || sim.hasReadonly) {
            throw Object.assign(
              new Error('cannot drop role: still has database privileges or settings'),
              { code: 'dependent_objects' },
            );
          }
          if (!sim.exists) throw new Error('role does not exist');
          sim.exists = false;
          return;
        }
        if (/DROP ROLE IF EXISTS|DROP OWNED|OTHER_ROLE|wolfhouse|wh-staging/i.test(s)) {
          throw new Error(`forbidden rollback SQL: ${s.slice(0, 80)}`);
        }
      },
      keyVaultSecretSetSecure: async () => {
        throw Object.assign(new Error('kv boom'), { code: 'kv_write_failed' });
      },
    });
    const revokeIdx = sqlLog.findIndex((s) => /^REVOKE CONNECT ON DATABASE sunset_staging FROM sunset_schema_observer/.test(s));
    const resetIdx = sqlLog.findIndex((s) => /^ALTER ROLE sunset_schema_observer RESET default_transaction_read_only/.test(s));
    const dropIdx = sqlLog.findIndex((s) => /^DROP ROLE sunset_schema_observer\s*;/.test(s));
    pass(
      'red-kv-failure-rolls-back-new-role',
      !result.ok
        && result.rolledBack === true
        && result.counters.roleDroppedRollback === 1
        && sim.exists === false
        && sim.hasConnect === false
        && sim.hasReadonly === false
        && revokeIdx >= 0
        && resetIdx > revokeIdx
        && dropIdx > resetIdx
        && sqlLog.filter((s) => /^CREATE ROLE sunset_schema_observer\b/.test(s)).length === 1
        && !sqlLog.some((s) => /DROP OWNED|IF EXISTS|wolfhouse|wh-staging|OTHER_ROLE/i.test(s)),
    );
    pass(
      'red-kv-rollback-targets-only-observer',
      result.rollback
        && result.rollback.targetedRole === 'sunset_schema_observer'
        && result.rollback.targetedDatabase === 'sunset_staging'
        && result.rollback.completed.includes('rollback_revoke_connect')
        && result.rollback.completed.includes('rollback_reset_readonly')
        && result.rollback.completed.includes('rollback_drop_new_role'),
    );
  }

  // Prove DROP alone is insufficient in the simulated adapter (ordering enforced)
  {
    const sim = { exists: true, hasConnect: true, hasReadonly: true };
    const adapter = async (sql) => {
      const s = String(sql);
      if (/^REVOKE CONNECT ON DATABASE sunset_staging FROM sunset_schema_observer/.test(s)) {
        sim.hasConnect = false;
        return;
      }
      if (/^ALTER ROLE sunset_schema_observer RESET default_transaction_read_only/.test(s)) {
        sim.hasReadonly = false;
        return;
      }
      if (/^DROP ROLE sunset_schema_observer\s*;/.test(s)) {
        if (sim.hasConnect || sim.hasReadonly) {
          throw new Error('cannot drop role: still has database privileges or settings');
        }
        sim.exists = false;
      }
    };
    let prematureFailed = false;
    try {
      await adapter('DROP ROLE sunset_schema_observer;');
    } catch (_) {
      prematureFailed = true;
    }
    const ordered = [];
    const trackingAdapter = async (sql) => {
      ordered.push(String(sql));
      return adapter(sql);
    };
    const counters = { postgresExec: 0, roleDroppedRollback: 0 };
    const rb = await rollbackNewlyCreatedObserverRole(trackingAdapter, TARGETS, counters);
    pass(
      'green-rollback-order-required',
      prematureFailed
        && rb.ok
        && sim.exists === false
        && ordered.length === 3
        && ordered[0].startsWith('REVOKE CONNECT')
        && ordered[1].startsWith('ALTER ROLE sunset_schema_observer RESET')
        && ordered[2].startsWith('DROP ROLE sunset_schema_observer'),
    );
  }

  // Wrong live subscription aborts before DB mutation
  {
    let pg = 0;
    const result = await executeConvergentBootstrap({
      azure: {
        ...goodAzure(),
        async getAccount() {
          return { id: 'deadbeef-0000-0000-0000-000000000000' };
        },
      },
      db: goodDb(),
      inspectState: async () => ({ roleExists: false, secretExists: false }),
      postgresExec: async () => {
        pg += 1;
      },
      keyVaultSecretSetSecure: async () => {},
    });
    pass(
      'red-wrong-live-sub-no-mutation',
      !result.ok
        && result.errors.some((e) => e.code === 'wrong_live_subscription')
        && pg === 0,
    );
  }

  // Wrong current_database aborts before mutation
  {
    let pg = 0;
    const result = await executeConvergentBootstrap({
      azure: goodAzure(),
      db: {
        async connectInfo() {
          return { host: TARGETS.postgresHost, sslmode: 'verify-full' };
        },
        async query() {
          return { db: 'postgres' };
        },
      },
      inspectState: async () => ({ roleExists: false, secretExists: false }),
      postgresExec: async () => {
        pg += 1;
      },
      keyVaultSecretSetSecure: async () => {},
    });
    pass(
      'red-wrong-current-db-no-mutation',
      !result.ok
        && result.errors.some((e) => e.code === 'wrong_current_database')
        && pg === 0,
    );
  }

  // Secret-bearing exceptions are redacted
  {
    const password = generateRolePassword();
    const dsn = buildObserverDsn({ password });
    const result = await executeConvergentBootstrap({
      azure: goodAzure(),
      db: goodDb(),
      generatePassword: () => password,
      inspectState: async () => ({ roleExists: false, secretExists: false }),
      postgresExec: async () => {},
      keyVaultSecretSetSecure: async () => {
        throw new Error(`failed writing ${dsn} with ${password}`);
      },
    });
    const blob = JSON.stringify(result);
    pass(
      'red-secret-bearing-exception-redacted',
      !result.ok
        && !blob.includes(password)
        && !blob.includes(dsn)
        && blob.includes('***REDACTED***'),
    );
  }

  // Argv leakage detection
  {
    const dsn = buildObserverDsn({ password: generateRolePassword() });
    const bad = assertNoSecretInArgv(
      ['keyvault', 'secret', 'set', '--value', dsn],
      [dsn],
    );
    pass('red-argv-leakage', !bad.ok);
    const good = assertNoSecretInArgv(
      ['keyvault', 'secret', 'set', '--file', '/tmp/x'],
      [dsn],
    );
    pass('green-argv-file-ok', good.ok);
  }

  // CLI runProvision still refuses live apply
  {
    const result = await runProvision({
      applyRequested: true,
      env: applyEnv(),
      targets: TARGETS,
      azure: goodAzure(),
      db: goodDb(),
      inspectState: async () => ({ roleExists: false, secretExists: false }),
      postgresExec: async () => {
        throw new Error('must not run');
      },
    });
    pass(
      'red-cli-apply-refused-live-disabled',
      result.refused === true
        && !result.ok
        && result.errors.some((e) => e.code === 'live_apply_disabled')
        && result.counters.postgresExec === 0,
    );
  }

  // Plan / dry-run / firewall
  {
    const plan = buildProvisionPlan(TARGETS);
    pass('green-plan-has-nobypassrls', plan.ok && plan.steps.some((s) => /NOBYPASSRLS/.test(s.sqlTemplate || s.summary || '')));
    pass('green-plan-never-rotates', plan.steps.every((s) => s.neverRotatesExisting !== false || s.id !== 'create_role_if_absent')
      && plan.steps.some((s) => s.neverRotatesExisting === true));
    pass('green-plan-kv-via-file', plan.steps.some((s) => s.id === 'kv_secret_set' && s.valueViaArgv === false));
    pass('green-no-firewall-in-plan', assertNoNetworkMutation(JSON.stringify(plan)).ok);
    const dry = renderDryRunReport(plan);
    pass('green-dry-run-report', dry.ok && dry.mutationsExecuted === 0);
  }

  {
    const dry = await runProvision({ applyRequested: false, env: {}, targets: TARGETS });
    pass(
      'green-default-dry-run-no-mutations',
      dry.ok && dry.mode === 'dry-run' && dry.counters.postgresExec === 0,
    );
  }

  pass(
    'red-firewall-mutation',
    !assertNoNetworkMutation('az postgres flexible-server firewall-rule create').ok,
  );

  {
    const job = fs.readFileSync(BICEP_JOB, 'utf8');
    pass('green-bicep-secret-name', job.includes('sunset-schema-observer-database-url'));
  }
  {
    const readme = fs.readFileSync(README, 'utf8');
    pass(
      'docs-slice8-hardening',
      /Slice 8|NOBYPASSRLS|convergent|LIVE_APPLY_ENABLED/i.test(readme)
        && /provision-sunset-schema-observer-role/i.test(readme),
    );
  }
  {
    const cmd = futureApplyCommand();
    pass(
      'green-future-apply-command',
      cmd.includes('--apply') && cmd.includes(ENV_APPLY_FLAG) && cmd.includes(TARGETS.subscriptionId),
    );
  }

  {
    const pw = generateRolePassword();
    const dsn = buildObserverDsn({ password: pw });
    const msg = safeTopLevelErrorMessage(new Error(`boom ${dsn} ${pw}`), [dsn, pw]);
    pass('green-toplevel-catch-redacts', !msg.includes(pw) && !msg.includes(dsn));
  }

  // redactDeep on nested adapter results
  {
    const pw = generateRolePassword();
    const nested = redactDeep({ err: new Error(`x ${pw}`), nest: { dsn: buildObserverDsn({ password: pw }) } }, [pw, buildObserverDsn({ password: pw })]);
    pass('green-redact-deep', !JSON.stringify(nested).includes(pw));
  }

  console.log(`\n── verify:sunset-schema-observer-role-provision ${failed ? 'FAILED' : 'PASSED'} (failed=${failed}) ──`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(safeTopLevelErrorMessage(err));
  process.exit(1);
});
