'use strict';

/**
 * verify:sunset-schema-observer-role-provision — FOUNDATION Slice 7
 * RED→GREEN for fail-closed observer role + KV secret provisioning tooling.
 * No Azure mutations. No staging DB connections.
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

function fakePassword() {
  return 'unit-test-password-not-real';
}

function splitDsnParts() {
  // Avoid contiguous user:pass@ in source for secret-scan.
  return {
    user: TARGETS.roleName,
    pass: fakePassword(),
    host: TARGETS.postgresHost,
    db: TARGETS.database,
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

  pass('green-targets', validateTargets(TARGETS).ok);
  pass(
    'red-wrong-subscription',
    !validateTargets({ ...TARGETS, subscriptionId: '00000000-0000-0000-0000-000000000000' }).ok,
  );
  pass(
    'red-wrong-rg',
    !validateTargets({ ...TARGETS, resourceGroup: 'wh-staging-rg' }).ok
      && validateTargets({ ...TARGETS, resourceGroup: 'wh-staging-rg' }).errors.some(
        (e) => e.code === 'wrong_resource_group' || e.code === 'forbidden_resource_group',
      ),
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
  pass(
    'red-wrong-role',
    !validateTargets({ ...TARGETS, roleName: 'postgres' }).ok,
  );
  pass(
    'red-wrong-secret',
    !validateTargets({ ...TARGETS, secretName: 'sunset-database-url' }).ok,
  );

  pass('green-role-attributes', assertRoleAttributes(ROLE_ATTRIBUTE_REQUIREMENTS).ok);
  pass(
    'red-writable-superuser',
    !assertRoleAttributes({ ...ROLE_ATTRIBUTE_REQUIREMENTS, rolsuper: true }).ok,
  );
  pass(
    'red-writable-createdb',
    !assertRoleAttributes({ ...ROLE_ATTRIBUTE_REQUIREMENTS, rolcreatedb: true }).ok,
  );
  pass(
    'red-writable-createrole',
    !assertRoleAttributes({ ...ROLE_ATTRIBUTE_REQUIREMENTS, rolcreaterole: true }).ok,
  );
  pass(
    'red-inherit-enabled',
    !assertRoleAttributes({ ...ROLE_ATTRIBUTE_REQUIREMENTS, rolinherit: true }).ok,
  );
  pass(
    'red-replication-enabled',
    !assertRoleAttributes({ ...ROLE_ATTRIBUTE_REQUIREMENTS, rolreplication: true }).ok,
  );
  pass(
    'red-missing-login',
    !assertRoleAttributes({ ...ROLE_ATTRIBUTE_REQUIREMENTS, rolcanlogin: false }).ok,
  );
  pass(
    'red-missing-readonly-default',
    !assertRoleAttributes({
      ...ROLE_ATTRIBUTE_REQUIREMENTS,
      default_transaction_read_only: 'off',
    }).ok,
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
  pass(
    'red-excess-usage-schema-grant',
    !assertGrantsLeastPrivilege([
      ...ALLOWED_GRANTS,
      { privilege: 'USAGE', objectType: 'SCHEMA', objectName: 'public' },
    ]).ok,
  );
  pass(
    'red-missing-connect-grant',
    !assertGrantsLeastPrivilege([]).ok,
  );

  {
    const parts = splitDsnParts();
    const dsn = buildObserverDsn({
      roleName: parts.user,
      password: parts.pass,
      host: parts.host,
      database: parts.db,
      sslmode: 'verify-full',
    });
    pass('green-dsn-verify-full', assertObserverDsnShape(dsn).ok);
    pass(
      'red-dsn-require-tls',
      !assertObserverDsnShape(
        buildObserverDsn({
          roleName: parts.user,
          password: parts.pass,
          sslmode: 'require',
        }),
      ).ok,
    );
    pass(
      'red-dsn-wrong-host',
      !assertObserverDsnShape(
        buildObserverDsn({
          roleName: parts.user,
          password: parts.pass,
          host: 'wh-staging-pg-app.postgres.database.azure.com',
          sslmode: 'verify-full',
        }),
      ).ok,
    );
  }

  {
    const password = generateRolePassword();
    pass('green-password-generated', typeof password === 'string' && password.length >= 32);
    const dsn = buildObserverDsn({ password });
    const report = `status=ok dsn=${dsn} password=${password}`;
    const redacted = redactSecrets(report, [dsn, password]);
    pass('green-redact-secrets', !redacted.includes(password) && !redacted.includes(dsn));
    pass('red-leaked-raw-dsn', assertNoLeakedDsn(report, dsn).includes('raw_dsn'));
    pass('green-no-leak-after-redact', assertNoLeakedDsn(redacted, dsn).length === 0);
  }

  pass(
    'red-firewall-mutation',
    !assertNoNetworkMutation('az postgres flexible-server firewall-rule create').ok,
  );
  pass(
    'green-no-firewall-in-plan',
    (() => {
      const plan = buildProvisionPlan(TARGETS);
      return plan.ok && assertNoNetworkMutation(JSON.stringify(plan)).ok;
    })(),
  );

  {
    const plan = buildProvisionPlan(TARGETS);
    pass('green-plan-ok', plan.ok && plan.steps.length >= 4);
    pass(
      'green-plan-has-connect',
      plan.steps.some((s) => s.id === 'grant_connect'),
    );
    pass(
      'green-plan-has-kv',
      plan.steps.some((s) => s.id === 'kv_secret_set' && s.kind === 'keyvault'),
    );
    pass(
      'green-plan-sql-no-product-dml',
      plan.steps.every((s) => {
        const sql = String(s.sqlTemplate || '');
        return !/\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE TABLE|DROP TABLE)\b/i.test(sql);
      }),
    );
    const dry = renderDryRunReport(plan);
    pass('green-dry-run-report', dry.ok && dry.mutationsExecuted === 0);
    pass(
      'green-dry-run-redacts-password-placeholder',
      dry.text.includes('***REDACTED***') && !dry.text.includes('$PASSWORD'),
    );
  }

  {
    const dry = await runProvision({ applyRequested: false, env: {}, targets: TARGETS });
    pass(
      'green-default-dry-run-no-mutations',
      dry.ok
        && dry.mode === 'dry-run'
        && dry.counters.postgresExec === 0
        && dry.counters.keyVaultSet === 0
        && dry.counters.passwordGenerated === 0,
    );
  }

  {
    let pgCalls = 0;
    let kvCalls = 0;
    const refused = await runProvision({
      applyRequested: false,
      env: {
        [ENV_APPLY_FLAG]: '1',
        [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      },
      targets: TARGETS,
      postgresExec: async () => {
        pgCalls += 1;
      },
      keyVaultSecretSet: async () => {
        kvCalls += 1;
        return { id: 'ok' };
      },
    });
    pass(
      'red-mutation-without-apply',
      refused.mode === 'dry-run'
        && pgCalls === 0
        && kvCalls === 0
        && refused.counters.postgresExec === 0
        && refused.counters.keyVaultSet === 0,
    );
  }

  {
    const gate = evaluateApplyGate({
      applyRequested: true,
      env: {
        [ENV_APPLY_FLAG]: '1',
        [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      },
    });
    pass(
      'red-apply-refused-while-live-disabled',
      !gate.ok && gate.errors.some((e) => e.code === 'live_apply_disabled'),
    );

    let pgCalls = 0;
    let kvCalls = 0;
    const result = await runProvision({
      applyRequested: true,
      env: {
        [ENV_APPLY_FLAG]: '1',
        [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      },
      targets: TARGETS,
      postgresExec: async () => {
        pgCalls += 1;
      },
      keyVaultSecretSet: async () => {
        kvCalls += 1;
        return {};
      },
    });
    pass(
      'red-apply-executes-zero-mutations',
      result.refused === true
        && !result.ok
        && pgCalls === 0
        && kvCalls === 0
        && result.counters.postgresExec === 0
        && result.counters.keyVaultSet === 0
        && result.counters.passwordGenerated === 0,
    );
  }

  {
    const gate = evaluateApplyGate({ applyRequested: true, env: {} });
    pass(
      'red-apply-missing-env',
      !gate.ok && gate.errors.some((e) => e.code === 'apply_env_required'),
    );
  }

  {
    const job = fs.readFileSync(BICEP_JOB, 'utf8');
    pass(
      'green-bicep-secret-name',
      job.includes("param observerDatabaseSecretName string = 'sunset-schema-observer-database-url'")
        || job.includes('sunset-schema-observer-database-url'),
    );
  }

  {
    const readme = fs.readFileSync(README, 'utf8');
    pass(
      'docs-slice7-tooling',
      /Slice 7/i.test(readme)
        && /provision-sunset-schema-observer-role/i.test(readme)
        && /live apply disabled|LIVE_APPLY_ENABLED/i.test(readme),
    );
  }

  {
    const cmd = futureApplyCommand();
    pass(
      'green-future-apply-command',
      cmd.includes('--apply')
        && cmd.includes(ENV_APPLY_FLAG)
        && cmd.includes(TARGETS.subscriptionId)
        && cmd.includes('provision-sunset-schema-observer-role.js'),
    );
  }

  // Wrong targets must fail plan build closed.
  {
    const bad = buildProvisionPlan({ ...TARGETS, resourceGroup: 'wh-prod-rg' });
    pass('red-plan-wrong-target', !bad.ok && bad.steps.length === 0);
  }

  console.log(`\n── verify:sunset-schema-observer-role-provision ${failed ? 'FAILED' : 'PASSED'} (failed=${failed}) ──`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
