#!/usr/bin/env node
'use strict';
/** verify:messi-saas-stage2c2-bootstrap-job — Stage 2C2 trust/atomicity + DB recovery correction. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const BASE = '1ad6ef98f8bf120a2ceb370f350acdf158e238df';
const MAIN_REL = 'infra/azure/modules/tenant-staging/main.bicep';
const JOB_REL = 'infra/azure/modules/tenant-staging/synthetic-bootstrap-job.bicep';
const CLI_REL = 'scripts/bootstrap-synthetic-tenant-db.js';
const RUNNER_REL = 'scripts/run-canonical-migrations.js';
const LIB_REL = 'scripts/lib/migration-integrity.js';
const FILES = [MAIN_REL, JOB_REL, CLI_REL, RUNNER_REL, LIB_REL, 'scripts/verify-messi-saas-stage2c2-bootstrap-job.js', 'package.json'];
const TAGS = ['tenant', 'stage', 'owner', 'planDigest', 'deploySha'];
const SLUG = 'synthdemo'; const HOST = `luna-${SLUG}-staging-pg-app.postgres.database.azure.com`; const DB = `${SLUG}_staging`;
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; const SUB = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
const RG = `luna-${SLUG}-staging-rg`;
const ENV_ID = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/managedEnvironments/luna-${SLUG}-staging-env`;
const PG_ID = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.DBforPostgreSQL/flexibleServers/luna-${SLUG}-staging-pg-app`;
let pass = 0; let fail = 0;
const ok = (n, c, d) => { if (c) { pass += 1; console.log(`  PASS  ${n}`); }
else { fail += 1; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); } };
const bin = () => ['/opt/data/home/.azure/bin/bicep', '/opt/data/.azure/bin/bicep',
  '/opt/data/home/bin/bicep'].find((p) => fs.existsSync(p));
const tmpDirs = [];
const cleanup = () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const hasFail = (s, c) => new RegExp(`fail\\('${c}'\\)`).test(s);
const syn = (slug) => ({ allowDedicatedSyntheticAzureInitialApply: true, syntheticTenantSlug: slug });
const tgt = (host, db, ssl) => ({
  host, port: 5432, database: db, ssl: ssl === undefined ? { rejectUnauthorized: true } : ssl,
});
const goodAtt = () => ({
  tenantSlug: SLUG, expectedHost: HOST, expectedDatabase: DB, expectedPort: 5432,
  subscriptionId: SUB, resourceGroupName: RG, acaEnvironmentId: ENV_ID, postgresServerId: PG_ID,
  planDigest: 'synthdemo-plan-digest-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', deploySha: SHA, owner: 'messi-stage2c2',
});
function diffStat() {
  const out = execFileSync('git', ['diff', '--numstat', BASE, '--', ...FILES], { cwd: ROOT, encoding: 'utf8' }).trim();
  let rawAdd = 0; let rawDel = 0; const perFile = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [a, d, file] = line.split('\t');
    const add = a === '-' ? 0 : Number(a); const del = d === '-' ? 0 : Number(d);
    rawAdd += add; rawDel += del; perFile.push({ file, add, del });
  }
  for (const rel of FILES) {
    if (perFile.some((p) => p.file === rel)) continue;
    const abs = path.join(ROOT, rel); if (!fs.existsSync(abs)) continue;
    let baseLines = 0;
    try {
      baseLines = execFileSync('git', ['show', `${BASE}:${rel}`], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).split(/\r?\n/).length;
    } catch (_) { baseLines = 0; }
    const cur = fs.readFileSync(abs, 'utf8').split(/\r?\n/).length;
    if (!baseLines) { rawAdd += cur; perFile.push({ file: rel, add: cur, del: 0 }); }
  }
  return { rawAdd, rawDel, net: rawAdd - rawDel, files: perFile.length, perFile };
}
function build(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's2c2-')); tmpDirs.push(dir);
  const out = path.join(dir, 'out.json');
  execFileSync(bin(), ['build', file, '--outfile', out], {
    cwd: ROOT, env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}
function flatten(compiled) {
  const resources = [];
  const walk = (list) => {
    for (const r of list || []) {
      if (r.type === 'Microsoft.Resources/deployments') walk(((r.properties || {}).template || {}).resources || []);
      resources.push(r);
    }
  };
  walk(compiled.resources || []); return resources;
}
function skipMany(names, why) { names.forEach((n, i) => ok(n, false, i === 0 ? why : 'skipped')); }
async function main() {
  console.log('verify:messi-saas-stage2c2-bootstrap-job — Stage 2C2\n');
  const pkg = JSON.parse(read('package.json'));
  ok('package_script', pkg.scripts['verify:messi-saas-stage2c2-bootstrap-job']
    === 'node scripts/verify-messi-saas-stage2c2-bootstrap-job.js');
  ok('no_plan_apply_cli', !fs.existsSync(path.join(ROOT, 'scripts/messi-saas-stage2c2-plan.js'))
    && !fs.existsSync(path.join(ROOT, 'scripts/messi-saas-stage2c2-apply.js'))
    && !/stage2c2-plan|stage2c2-apply|stage2c-plan|stage2c-apply/i.test(read('package.json')));
  ok('no_runtime_app_module', !fs.existsSync(path.join(ROOT, 'infra/azure/modules/tenant-staging/runtime-kv-secrets.bicep')));
  const mainSrc = read(MAIN_REL);
  const job = fs.existsSync(path.join(ROOT, JOB_REL)) ? read(JOB_REL) : '';
  const cli = fs.existsSync(path.join(ROOT, CLI_REL)) ? read(CLI_REL) : '';
  const runner = read(RUNNER_REL);
  const lib = read(LIB_REL);
  ok('job_module_exists', Boolean(job));
  ok('cli_exists', Boolean(cli));
  ok('main_wires_job_module', /module\s+syntheticBootstrapJob\s+'\.\/synthetic-bootstrap-job\.bicep'\s*=\s*if\s*\(/.test(mainSrc)
    && /deployBootstrapJob/.test(mainSrc) && /enablePrivateNetwork/.test(mainSrc));
  ok('main_secrets_gated', /@secure\(\)[\s\S]{0,80}param bootstrapAdminDatabaseUrl/.test(mainSrc)
    && /@secure\(\)[\s\S]{0,80}param bootstrapAppRolePassword/.test(mainSrc));
  ok('main_derives_ids', /module\s+syntheticBootstrapJob/.test(mainSrc)
    && /appNamePrefix:\s*prefix|appNamePrefix:\s*appNamePrefix/.test(mainSrc)
    && /pgApp\.id/.test(job) && /containerAppsEnv\.id/.test(job) && /managedIdentity\.id/.test(job)
    && /subscription\(\)\.subscriptionId/.test(job) && /resourceGroup\(\)\.name/.test(job)
    && /fullyQualifiedDomainName/.test(job) && /appDb\.name/.test(job));
  ok('main_depends_on', /dependsOn:[\s\S]{0,260}acrPullRole/.test(mainSrc)
    && /dependsOn:[\s\S]{0,260}(pgApp|appDb)/.test(mainSrc)
    && /dependsOn:[\s\S]{0,260}(containerAppsEnv|managedIdentity)/.test(mainSrc));
  ok('job_no_caller_ownership_params', !/param expectedPgHost/.test(job)
    && !/param postgresServerId/.test(job) && !/param acaEnvironmentId/.test(job)
    && !/param subscriptionId/.test(job) && !/param resourceGroupName/.test(job)
    && !/param planDigest string/.test(job) && !/param deploySha string/.test(job)
    && !/param ownerTag/.test(job) && !/param tenantSlug/.test(job) && !/param staffApiImageTag/.test(job));
  ok('job_manual_trigger', /triggerType:\s*'Manual'/.test(job));
  ok('job_retry_zero', /replicaRetryLimit:\s*0/.test(job));
  ok('job_parallelism_one', /parallelism:\s*1/.test(job) && /replicaCompletionCount:\s*1/.test(job));
  ok('job_timeout_bounded', /param replicaTimeout int/.test(job));
  ok('job_no_ingress', !/ingress/.test(job));
  ok('job_secure_secrets', /@secure\(\)/.test(job) && /adminDatabaseUrl/.test(job)
    && /appRolePassword/.test(job) && /secretRef/.test(job));
  ok('job_no_secret_outputs', /output jobName string/.test(job) && /output jobId string/.test(job)
    && !/output[\s\S]{0,80}(Password|password|DatabaseUrl|secret)/.test(job));
  ok('job_ownership_tags', TAGS.every((t) => new RegExp(`${t}:`).test(job)));
  ok('job_digest_only_image', /@sha256:/.test(job) && hasFail(job, 'staff_image_digest_required')
    && !/staffApiImageTag/.test(job));
  ok('job_cli_command', /bootstrap-synthetic-tenant-db\.js/.test(job));
  ok('job_attestation_env', ['TENANT_SLUG', 'EXPECTED_PG_HOST', 'EXPECTED_PG_DATABASE', 'PLAN_DIGEST',
    'DEPLOY_SHA', 'OWNER', 'SUBSCRIPTION_ID', 'ACA_ENVIRONMENT_ID', 'POSTGRES_SERVER_ID']
    .every((e) => job.includes(e)));
  ok('cli_no_secret_argv', /secret_argv_forbidden|rejectSecretArgv|SECRET_ARGV/.test(cli));
  ok('cli_tls_required', /rejectUnauthorized:\s*true/.test(cli));
  ok('cli_rejects_reserved', /sunset|wolfhouse|prod/i.test(cli));
  ok('cli_operator_finally_delete', /runOperatorJobLifecycle|operator-run-job/.test(cli)
    && /deleteJob|delete.*[Jj]ob/.test(cli) && /assertCanDelete|ownership/.test(cli));
  ok('cli_concrete_az_operator', /createLocalAzOperator/.test(cli) && /execFile/.test(cli)
    && !/WH_OPERATOR_AZURE_MODULE/.test(cli) && /SIGINT/.test(cli) && /SIGTERM/.test(cli) && /SIGHUP/.test(cli)
    && /luna-\$\{slug\}-staging-bootstrap/.test(cli) && /luna-\$\{slug\}-staging-rg/.test(cli)
    && /bootstrapJobName = '\$\{prefix\}-bootstrap'/.test(mainSrc));
  ok('capability_named', /allowDedicatedSyntheticAzureInitialApply/.test(runner + lib + cli));
  ok('sunset_noop_untouched', /allowSunsetStagingCanonicalRunnerNoop/.test(runner)
    && /SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET/.test(lib));
  ok('freshness_expanded', /pg_proc|pg_type|pg_trigger|user_functions|user_types|user_triggers/.test(runner + cli));
  ok('lock_held_through_role', /advisoryLockHeld|withAdvisoryLock|pg_advisory_lock/.test(runner + cli)
    && /createTenantAppRole|bootstrapAttestation|synthetic_bootstrap_attestation/.test(cli));
  ok('role_txn_atomic', /BEGIN|COMMIT|ROLLBACK/.test(cli) && /plan_digest|planDigest/.test(cli));
  ok('recovery_same_plan', /recovery|same.?plan|attestation.?absent/.test(cli));
  ok('attestation_reads_all_rows', /SELECT tenant_slug, plan_digest, deploy_sha FROM public\.synthetic_bootstrap_attestation/.test(cli)
    && !/FROM public\.synthetic_bootstrap_attestation WHERE tenant_slug/.test(cli));
  ok('role_security_inspector', /inspectAppRoleSecurity/.test(cli) && /rolcanlogin|rolbypassrls|pg_auth_members|pg_default_acl/.test(cli));
  ok('grants_documented', /DEFAULT PRIVILEGES|default privileges|demonstrated runtime|SELECT, INSERT, UPDATE, DELETE/i.test(cli));
  ok('app_role_attrs', /NOSUPERUSER|NOCREATEDB|NOCREATEROLE|NOINHERIT|NOREPLICATION|NOBYPASSRLS/.test(cli) && /GRANT/.test(cli));
  ok('summary_nonsecret', /attestationDigest|appliedCount|appRoleName/.test(cli) && /redact/i.test(cli));
  const { assertSafeDatabaseTarget } = require('./lib/migration-integrity');
  let bootstrap; try { bootstrap = require('./bootstrap-synthetic-tenant-db'); } catch (_) { bootstrap = null; }
  ok('default_still_refuses_azure', !assertSafeDatabaseTarget(tgt(HOST, DB)).ok);
  ok('default_still_refuses_sunset', !assertSafeDatabaseTarget(tgt(
    'luna-sunset-staging-pg-app.postgres.database.azure.com', 'sunset_staging')).ok);
  ok('sunset_noop_still_exact', assertSafeDatabaseTarget(tgt(
    'luna-sunset-staging-pg-app.postgres.database.azure.com', 'sunset_staging'),
  { allowSunsetStagingCanonicalRunnerNoop: true }).ok);
  ok('sunset_noop_rejects_synthetic_host', !assertSafeDatabaseTarget(tgt(HOST, DB),
    { allowSunsetStagingCanonicalRunnerNoop: true }).ok);
  const g = assertSafeDatabaseTarget(tgt(HOST, DB), syn(SLUG));
  ok('cap_accepts_exact_synthetic', g.ok && g.mode === 'dedicated_synthetic_azure_initial_apply');
  ok('cap_rejects_forged_host', !assertSafeDatabaseTarget(tgt('luna-other-staging-pg-app.postgres.database.azure.com', DB), syn(SLUG)).ok);
  ok('cap_rejects_forged_db', !assertSafeDatabaseTarget(tgt(HOST, 'other_staging'), syn(SLUG)).ok);
  ok('cap_rejects_forged_slug', !assertSafeDatabaseTarget(tgt(HOST, DB), syn('other')).ok);
  ok('cap_rejects_sunset_slug', !assertSafeDatabaseTarget(tgt(
    'luna-sunset-staging-pg-app.postgres.database.azure.com', 'sunset_staging'), syn('sunset')).ok);
  ok('cap_rejects_wolfhouse', !assertSafeDatabaseTarget(tgt(
    'luna-wolfhouse-staging-pg-app.postgres.database.azure.com', 'wolfhouse_staging'), syn('wolfhouse')).ok);
  ok('cap_rejects_prod_slug', !assertSafeDatabaseTarget(tgt(
    'luna-acmeprod-staging-pg-app.postgres.database.azure.com', 'acmeprod_staging'), syn('acmeprod')).ok
    && !assertSafeDatabaseTarget(tgt('luna-prod-staging-pg-app.postgres.database.azure.com', 'prod_staging'), syn('prod')).ok);
  ok('cap_rejects_tls_disable', !assertSafeDatabaseTarget(tgt(HOST, DB, false), syn(SLUG)).ok);
  ok('cap_rejects_tls_truthy_bypass', !assertSafeDatabaseTarget(tgt(HOST, DB, true), syn(SLUG)).ok
    && !assertSafeDatabaseTarget(tgt(HOST, DB, { rejectUnauthorized: false }), syn(SLUG)).ok
    && !assertSafeDatabaseTarget(tgt(HOST, DB, {}), syn(SLUG)).ok
    && !assertSafeDatabaseTarget(tgt(HOST, DB, { rejectUnauthorized: true, requestCert: true }), syn(SLUG)).ok);
  ok('cap_rejects_generic_azure', !assertSafeDatabaseTarget(tgt('myserver.postgres.database.azure.com', 'wh_mig_x'), syn('x')).ok);
  ok('cap_conflicts_with_sunset_noop', !assertSafeDatabaseTarget(tgt(HOST, DB), {
    allowDedicatedSyntheticAzureInitialApply: true, allowSunsetStagingCanonicalRunnerNoop: true, syntheticTenantSlug: SLUG,
  }).ok);
  ok('runner_exports_capability', /allowDedicatedSyntheticAzureInitialApply/.test(runner));
  const miss = ['attestation_green','attestation_forged_host','attestation_forged_db','attestation_forged_slug','attestation_forged_env_id','attestation_forged_pg_id','attestation_reserved_sunset','dsn_match_green','dsn_mismatch_host','dsn_tls_disable','redact_secrets','reject_secret_argv','nonfresh_db_rejected','fresh_db_accepted','ledger_empty_but_schema_rejects','functions_types_nonfresh','app_role_created','app_role_password_parameterized','app_role_attestation_atomic','role_grant_rollback','recovery_when_chain_complete_no_role','recovery_rejects_partial','concurrent_actor_window','fail_before_role_if_migrations_fail','summary_shape','summary_no_secrets','operator_start_wait_delete_finally','operator_delete_on_failure','operator_stop_without_delete_owner','attestation_wrong_tenant_row','attestation_wrong_plan_row','attestation_wrong_deploy_sha_row','attestation_multiple_rows','role_sec_elevated_super','role_sec_login_inherit_repl_bypass','role_sec_membership','role_sec_missing_each_priv_default_acl','role_sec_empty_inventories','already_complete_valid','role_security_post_create','operator_argv_order','operator_start_fail_cleanup','operator_terminal_fail','operator_timeout','operator_log_secret_redaction','operator_delete_fail','operator_ownership_mismatch_no_delete','operator_signal_cleanup','operator_success'];
  if (bootstrap && typeof bootstrap.assertSyntheticAttestation === 'function') {
    const att = goodAtt();
    const TP = { SELECT: true, INSERT: true, UPDATE: true, DELETE: true };
    const goodSnap = (o = {}) => ({
      roleName: `${SLUG}_app`,
      attributes: {
        rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
        rolinherit: false, rolreplication: false, rolbypassrls: false, ...(o.attributes || {}),
      },
      membershipCount: o.membershipCount || 0, hasConnect: o.hasConnect !== false, hasSchemaUsage: o.hasSchemaUsage !== false,
      tables: Object.prototype.hasOwnProperty.call(o, 'tables') ? o.tables : [{ name: 'bookings', privs: { ...TP } }],
      sequences: Object.prototype.hasOwnProperty.call(o, 'sequences') ? o.sequences : [{ name: 'bookings_id_seq', privs: { USAGE: true, SELECT: true } }],
      functions: Object.prototype.hasOwnProperty.call(o, 'functions') ? o.functions : [{ name: 'touch_row', privs: { EXECUTE: true } }],
      defaultPrivileges: o.defaultPrivileges || { tables: Object.keys(TP), sequences: ['USAGE', 'SELECT'], functions: ['EXECUTE'] },
    });
    const nop = { query: async () => ({ rows: [] }) };
    const mode = (extra) => bootstrap.evaluateBootstrapMode(nop, { attestation: att, ...extra });
    ok('attestation_green', bootstrap.assertSyntheticAttestation(att).ok);
    ok('attestation_forged_host', !bootstrap.assertSyntheticAttestation({ ...att, expectedHost: 'evil.postgres.database.azure.com' }).ok);
    ok('attestation_forged_db', !bootstrap.assertSyntheticAttestation({ ...att, expectedDatabase: 'evil_staging' }).ok);
    ok('attestation_forged_slug', !bootstrap.assertSyntheticAttestation({ ...att, tenantSlug: 'evil' }).ok);
    ok('attestation_forged_env_id', !bootstrap.assertSyntheticAttestation({ ...att, acaEnvironmentId: ENV_ID.replace(SLUG, 'evil') }).ok);
    ok('attestation_forged_pg_id', !bootstrap.assertSyntheticAttestation({ ...att, postgresServerId: PG_ID.replace('pg-app', 'pg-evil') }).ok);
    ok('attestation_reserved_sunset', !bootstrap.assertSyntheticAttestation({
      ...att, tenantSlug: 'sunset',
      expectedHost: 'luna-sunset-staging-pg-app.postgres.database.azure.com', expectedDatabase: 'sunset_staging',
    }).ok);
    const secret = 'S3cretPassw0rd_EXTRA';
    const dsn = `postgresql://admin:${secret}@${HOST}:5432/${DB}?sslmode=verify-full`;
    ok('dsn_match_green', bootstrap.assertAdminDsnMatchesAttestation(dsn, att).ok);
    ok('dsn_mismatch_host', !bootstrap.assertAdminDsnMatchesAttestation(
      `postgresql://admin:${secret}@evil.postgres.database.azure.com:5432/${DB}?sslmode=verify-full`, att).ok);
    ok('dsn_tls_disable', !bootstrap.assertAdminDsnMatchesAttestation(
      `postgresql://admin:${secret}@${HOST}:5432/${DB}?sslmode=disable`, att).ok);
    ok('redact_secrets', !bootstrap.redactSecrets(`fail ${secret} in ${dsn}`, [secret, dsn]).includes(secret));
    ok('reject_secret_argv', !bootstrap.rejectSecretArgv(['node', CLI_REL, '--password', secret, '--admin-database-url', dsn]).ok);
    const z = { ledger_exists: false, ledger_rows: 0, user_schemas: 0, user_relations: 0, user_functions: 0, user_types: 0, user_triggers: 0 };
    const q = (row) => ({ query: async () => ({ rows: [row] }) });
    ok('nonfresh_db_rejected', !(await bootstrap.assertFreshSyntheticDatabase(q({ ...z, ledger_exists: true, ledger_rows: 2, user_relations: 4 }))).ok);
    ok('fresh_db_accepted', (await bootstrap.assertFreshSyntheticDatabase(q(z))).ok);
    ok('ledger_empty_but_schema_rejects', !(await bootstrap.assertFreshSyntheticDatabase(q({ ...z, ledger_exists: true, ledger_rows: 0, user_relations: 1 }))).ok);
    ok('functions_types_nonfresh', !(await bootstrap.assertFreshSyntheticDatabase(q({ ...z, user_functions: 1 }))).ok
      && !(await bootstrap.assertFreshSyntheticDatabase(q({ ...z, user_types: 1 }))).ok
      && !(await bootstrap.assertFreshSyntheticDatabase(q({ ...z, user_triggers: 1 }))).ok);
    const rolePass = 'AppRolePass_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const mkRoleClient = (onGrant) => {
      const qlog = [];
      return { qlog, client: { async query(sql, params) {
        const s = String(sql); qlog.push({ sql: s, params });
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return { rows: [] };
        if (onGrant && /GRANT|ALTER ROLE|INSERT.*attestation|synthetic_bootstrap/i.test(s) && !/format\(|CREATE TABLE/i.test(s) && !/CREATE ROLE/i.test(s)) {
          throw Object.assign(new Error('injected_grant_fail'), { code: 'injected_grant_fail' });
        }
        if (/format\(/.test(s)) return { rows: [{ sql: /CREATE ROLE|ALTER ROLE/.test(s) ? 'CREATE ROLE synthdemo_app LOGIN PASSWORD \'x\' NOSUPERUSER NOCREATEDB NOCREATEROLE' : 'GRANT X' }] };
        return { rows: [] };
      } } };
    };
    const rc = mkRoleClient(false);
    const role = await bootstrap.createTenantAppRole(rc.client, {
      tenantSlug: SLUG, password: rolePass, database: DB, attestation: att, securitySnapshot: goodSnap(),
    });
    ok('app_role_created', role.ok && role.roleName === `${SLUG}_app` && !role.rolsuper && role.rolcanlogin);
    ok('app_role_password_parameterized', rc.qlog.some((e) => Array.isArray(e.params) && e.params.includes(rolePass))
      && !rc.qlog.some((e) => /PASSWORD\s+'AppRolePass/.test(e.sql)) && !JSON.stringify(role).includes(rolePass));
    ok('app_role_attestation_atomic', rc.qlog.some((e) => /synthetic_bootstrap_attestation|plan_digest/.test(e.sql))
      && rc.qlog.some((e) => /^\s*BEGIN/i.test(e.sql)) && rc.qlog.some((e) => /^\s*COMMIT/i.test(e.sql)));
    ok('role_security_post_create', role.ok && role.attributes?.rolcanlogin === true
      && role.attributes.rolsuper === false && role.attributes.rolbypassrls === false);
    const fc = mkRoleClient(true);
    const rolled = await bootstrap.createTenantAppRole(fc.client, {
      tenantSlug: SLUG, password: rolePass, database: DB, attestation: att, securitySnapshot: goodSnap(),
    });
    ok('role_grant_rollback', !rolled.ok && fc.qlog.some((e) => /^\s*ROLLBACK/i.test(e.sql)));
    if (typeof bootstrap.evaluateBootstrapMode === 'function') {
      const matchRow = { tenant_slug: SLUG, plan_digest: att.planDigest, deploy_sha: att.deploySha };
      ok('recovery_when_chain_complete_no_role', (await mode({ migrationComplete: true, hasRole: false, hasAttestation: false })).mode === 'recovery');
      ok('recovery_rejects_partial', !(await mode({ migrationComplete: false, hasRole: true, hasAttestation: false })).ok);
      ok('attestation_wrong_tenant_row', !(await mode({
        migrationComplete: true, hasRole: false,
        attestationRows: [{ tenant_slug: 'otherten', plan_digest: att.planDigest, deploy_sha: att.deploySha }],
      })).ok);
      ok('attestation_wrong_plan_row', !(await mode({
        migrationComplete: true, hasRole: false,
        attestationRows: [{ ...matchRow, plan_digest: 'wrong-plan-digest-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }],
      })).ok);
      ok('attestation_wrong_deploy_sha_row', !(await mode({
        migrationComplete: true, hasRole: false,
        attestationRows: [{ ...matchRow, deploy_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }],
      })).ok);
      ok('attestation_multiple_rows', !(await mode({
        migrationComplete: true, hasRole: false, attestationRows: [matchRow, matchRow],
      })).ok);
      ok('already_complete_valid', (await mode({
        migrationComplete: true, hasRole: true, attestationRows: [matchRow], roleSecuritySnapshot: goodSnap(),
      })).mode === 'already_complete');
    } else skipMany(['recovery_when_chain_complete_no_role', 'recovery_rejects_partial', 'attestation_wrong_tenant_row',
      'attestation_wrong_plan_row', 'attestation_wrong_deploy_sha_row', 'attestation_multiple_rows', 'already_complete_valid'], 'missing evaluateBootstrapMode');
    if (typeof bootstrap.inspectAppRoleSecurity === 'function') {
      const insp = (snap) => bootstrap.inspectAppRoleSecurity(nop, { snapshot: snap });
      const def = (tables, sequences, functions) => ({ defaultPrivileges: { tables, sequences, functions } });
      ok('role_sec_elevated_super', !(await insp(goodSnap({ attributes: { rolsuper: true } }))).ok
        && !(await insp(goodSnap({ attributes: { rolcreatedb: true } }))).ok
        && !(await insp(goodSnap({ attributes: { rolcreaterole: true } }))).ok);
      ok('role_sec_login_inherit_repl_bypass', !(await insp(goodSnap({ attributes: { rolcanlogin: false } }))).ok
        && !(await insp(goodSnap({ attributes: { rolinherit: true } }))).ok
        && !(await insp(goodSnap({ attributes: { rolreplication: true } }))).ok
        && !(await insp(goodSnap({ attributes: { rolbypassrls: true } }))).ok);
      ok('role_sec_membership', !(await insp(goodSnap({ membershipCount: 1 }))).ok);
      const missPriv = await Promise.all([
        insp(goodSnap({ tables: [{ name: 'bookings', privs: { ...TP, DELETE: false } }] })),
        insp(goodSnap({ sequences: [{ name: 's', privs: { USAGE: true, SELECT: false } }] })),
        insp(goodSnap({ functions: [{ name: 'f', privs: { EXECUTE: false } }] })),
        insp(goodSnap({ hasConnect: false })), insp(goodSnap({ hasSchemaUsage: false })),
        insp(goodSnap(def(['SELECT', 'INSERT', 'UPDATE'], ['USAGE', 'SELECT'], ['EXECUTE']))),
        insp(goodSnap(def(Object.keys(TP), ['USAGE'], ['EXECUTE']))),
        insp(goodSnap(def(Object.keys(TP), ['USAGE', 'SELECT'], []))),
      ]);
      ok('role_sec_missing_each_priv_default_acl', missPriv.every((r) => !r.ok) && !JSON.stringify(missPriv).toLowerCase().includes('password'));
      const missTables = goodSnap(); delete missTables.tables;
      const emptyInv = await Promise.all([
        insp(goodSnap({ tables: [] })), insp(goodSnap({ tables: null })), insp(missTables),
        insp(goodSnap({ sequences: [] })), insp(goodSnap({ sequences: null })),
        insp(goodSnap({ functions: [] })), insp(goodSnap({ functions: null })),
      ]);
      ok('role_sec_empty_inventories', emptyInv.every((r) => !r.ok));
    } else skipMany(['role_sec_elevated_super', 'role_sec_login_inherit_repl_bypass', 'role_sec_membership',
      'role_sec_missing_each_priv_default_acl', 'role_sec_empty_inventories'], 'missing inspectAppRoleSecurity');
    if (typeof bootstrap.withBootstrapLock === 'function') {
      let held = false; let blocked = false;
      const lockClient = {
        async query(sql) {
          if (/pg_advisory_lock\b/.test(sql) && !/try/.test(sql)) { held = true; return { rows: [] }; }
          if (/pg_try_advisory_lock/.test(sql)) { blocked = held; return { rows: [{ pg_try_advisory_lock: !held }] }; }
          if (/pg_advisory_unlock/.test(sql)) { held = false; return { rows: [] }; }
          return { rows: [] };
        },
      };
      await bootstrap.withBootstrapLock(lockClient, async () => {
        blocked = (await lockClient.query('SELECT pg_try_advisory_lock($1,$2)')).rows[0].pg_try_advisory_lock === false;
      });
      ok('concurrent_actor_window', blocked);
    } else ok('concurrent_actor_window', false, 'missing withBootstrapLock');
    ok('fail_before_role_if_migrations_fail', (await bootstrap.maybeCreateAppRoleAfterMigrations(
      nop, { migrationResult: { ok: false }, tenantSlug: SLUG, password: rolePass, database: DB, attestation: att },
    )).skippedRole);
    const summary = bootstrap.buildSummary({
      ok: true, appliedCount: 39, skippedCount: 0, roleName: `${SLUG}_app`, attestation: att, password: secret, adminDsn: dsn,
    });
    ok('summary_shape', summary.ok && summary.appliedCount === 39 && summary.appRoleName === `${SLUG}_app`
      && typeof summary.attestationDigest === 'string' && summary.attestationDigest.length === 64);
    ok('summary_no_secrets', !JSON.stringify(summary).includes(secret) && !/password|postgres(ql)?:\/\//i.test(JSON.stringify(summary)));
    if (typeof bootstrap.createLocalAzOperator === 'function' && typeof bootstrap.runOperatorJobLifecycle === 'function') {
      const names = bootstrap.derivedBootstrapJobNames(att);
      const digestImg = `whstagingacr.azurecr.io/luna-sunset-staff-api@sha256:${'a'.repeat(64)}`;
      const jobId = `/subscriptions/${SUB}/resourceGroups/${names.resourceGroupName}/providers/Microsoft.App/jobs/${names.jobName}`;
      const goodJob = {
        id: jobId, tags: { tenant: SLUG, stage: 'staging', owner: att.owner, planDigest: att.planDigest, deploySha: SHA },
        properties: { environmentId: ENV_ID, template: { containers: [{ image: digestImg }] } },
      };
      const sumLine = JSON.stringify({ ok: true, appliedCount: 1, appRoleName: `${SLUG}_app`, attestationDigest: 'a'.repeat(64) });
      const nf = () => { const e = new Error('NotFound (404)'); e.stderr = 'ResourceNotFound'; throw e; };
      const fakeProc = () => ({ on() {}, removeListener() {}, exit() {} });
      const clock = (step) => { let t = 0; return () => { t += step; return t; }; };
      async function life(script, extra = {}) {
        let deleted = false; const calls = [];
        const run = async (cmd, argv) => {
          calls.push(argv.slice());
          if (argv[2] === 'delete') { deleted = true; return { stdout: '' }; }
          if (argv[2] === 'show' && deleted) nf();
          return script(argv);
        };
        const r = await bootstrap.runOperatorJobLifecycle({
          attestation: att, secrets: [secret], run, sleep: async () => {}, now: clock(3000),
          pollMs: 1, timeoutMs: extra.timeoutMs || 20000, fetchLogs: true, process: fakeProc(), ...extra,
        });
        return { r, calls, deleted };
      }
      const base = (argv) => {
        if (argv[0] === 'account') return { stdout: JSON.stringify({ id: SUB }) };
        if (argv[2] === 'show') return { stdout: JSON.stringify(goodJob) };
        if (argv[2] === 'start') return { stdout: JSON.stringify({ name: 'exec-1' }) };
        if (argv[2] === 'execution') return { stdout: JSON.stringify({ properties: { status: 'Succeeded' } }) };
        if (argv[2] === 'logs') return { stdout: `${sumLine}\n` };
        throw new Error(`unexpected ${argv.join(' ')}`);
      };
      const az = bootstrap.createLocalAzOperator({ attestation: att, secrets: [secret], run: async () => ({ stdout: '{}' }), runSync: () => '' });
      const jg = names.resourceGroupName; const jn = names.jobName;
      ok('operator_argv_order', names.jobName === `luna-${SLUG}-staging-bootstrap` && jg === RG
        && az.argvAccountShow().join(' ') === `account show --subscription ${SUB} -o json`
        && az.argvJobShow().join(' ') === `containerapp job show -g ${jg} -n ${jn} -o json`
        && az.argvJobStart().join(' ') === `containerapp job start -g ${jg} -n ${jn} -o json`
        && az.argvExecShow('exec-1').join(' ') === `containerapp job execution show -g ${jg} -n ${jn} --job-execution-name exec-1 -o json`
        && az.argvJobLogsShow('exec-1').join(' ') === `containerapp job logs show -g ${jg} -n ${jn} --execution exec-1 --container synthetic-bootstrap -o json`
        && az.argvJobDelete().join(' ') === `containerapp job delete -g ${jg} -n ${jn} --yes -o none`);
      const okLife = await life(base);
      const successBlob = JSON.stringify(okLife.r);
      ok('operator_success', okLife.r.ok && okLife.r.deleted && okLife.r.summary && okLife.r.summary.ok === true
        && okLife.calls[0][0] === 'account' && okLife.calls.some((a) => a[2] === 'start') && okLife.calls.some((a) => a[2] === 'delete')
        && !successBlob.includes(secret));
      ok('operator_start_wait_delete_finally', okLife.r.ok && okLife.r.deleted);
      const startFail = await life((argv) => { if (argv[2] === 'start') throw new Error('start boom'); return base(argv); });
      ok('operator_start_fail_cleanup', !startFail.r.ok && startFail.r.deleted && startFail.r.ownershipVerified);
      const termFail = await life((argv) => {
        if (argv[2] === 'execution') return { stdout: JSON.stringify({ properties: { status: 'Failed' } }) };
        return base(argv);
      });
      ok('operator_terminal_fail', !termFail.r.ok && termFail.r.deleted
        && (termFail.r.errors || []).some((e) => e.code === 'execution_terminal_failed'));
      const timed = await life((argv) => {
        if (argv[2] === 'execution') return { stdout: JSON.stringify({ properties: { status: 'Running' } }) };
        return base(argv);
      }, { timeoutMs: 5, now: clock(10) });
      ok('operator_timeout', !timed.r.ok && timed.r.deleted && (timed.r.errors || []).some((e) => e.code === 'execution_timeout'));
      const leak = await life((argv) => {
        if (argv[2] === 'logs') return { stdout: `${JSON.stringify({ ok: true, appliedCount: 1, password: secret })}\n` };
        return base(argv);
      });
      ok('operator_log_secret_redaction', !leak.r.ok && leak.r.deleted && !JSON.stringify(leak.r).includes(secret));
      ok('operator_delete_on_failure', !leak.r.ok && leak.r.deleted);
      const delFail = await bootstrap.runOperatorJobLifecycle({
        attestation: att, secrets: [secret],
        run: async (cmd, argv) => {
          if (argv[2] === 'delete') throw new Error(`delete failed ${secret}`);
          return base(argv);
        },
        sleep: async () => {}, now: clock(3000), pollMs: 1, timeoutMs: 20000, fetchLogs: true, process: fakeProc(),
      });
      ok('operator_delete_fail', !delFail.ok && !delFail.deleted && !JSON.stringify(delFail).includes(secret)
        && (delFail.errors || []).some((e) => /delete/i.test(e.code)));
      let delCalled = false;
      const mismatch = await bootstrap.runOperatorJobLifecycle({
        attestation: att, secrets: [secret],
        run: async (cmd, argv) => {
          if (argv[0] === 'account') return { stdout: JSON.stringify({ id: SUB }) };
          if (argv[2] === 'show') return { stdout: JSON.stringify({ ...goodJob, tags: { ...goodJob.tags, owner: 'evil' } }) };
          if (argv[2] === 'delete') { delCalled = true; return { stdout: '' }; }
          throw new Error('should_not_reach');
        },
        process: fakeProc(),
      });
      ok('operator_ownership_mismatch_no_delete', !mismatch.ok && !mismatch.deleted && !delCalled && mismatch.ownershipVerified === false);
      ok('operator_stop_without_delete_owner', !mismatch.ok && !delCalled);
      const listeners = {}; let exited = 0; let syncDel = 0; let gone = false;
      const proc = { on(sig, h) { listeners[sig] = h; }, removeListener(sig) { delete listeners[sig]; }, exit(c) { exited = c; } };
      const sigAz = bootstrap.createLocalAzOperator({
        attestation: att, secrets: [secret],
        run: async (cmd, argv) => {
          if (argv[0] === 'account') return { stdout: JSON.stringify({ id: SUB }) };
          if (argv[2] === 'show') { if (gone) nf(); return { stdout: JSON.stringify(goodJob) }; }
          throw new Error('no');
        },
        runSync: (cmd, argv) => { if (argv[2] === 'delete') { syncDel += 1; gone = true; return ''; } return ''; },
      });
      await sigAz.assertCanDelete(); sigAz.installSignalHandlers(proc); listeners.SIGINT(); sigAz.removeSignalHandlers(proc);
      ok('operator_signal_cleanup', syncDel === 1 && exited === 1 && !listeners.SIGINT);
    } else skipMany(['operator_argv_order','operator_start_fail_cleanup','operator_terminal_fail','operator_timeout',
      'operator_log_secret_redaction','operator_delete_fail','operator_ownership_mismatch_no_delete','operator_signal_cleanup',
      'operator_success','operator_start_wait_delete_finally','operator_delete_on_failure','operator_stop_without_delete_owner'],
      'missing createLocalAzOperator')
  } else skipMany(miss, 'missing exports');
  if (job && mainSrc && bin()) {
    try {
      const compiledJob = build(path.join(ROOT, JOB_REL));
      const jobs = flatten(compiledJob).filter((r) => r.type === 'Microsoft.App/jobs');
      const blob = JSON.stringify(compiledJob);
      ok('compile_job', jobs.length === 1);
      const cfg = ((jobs[0] || {}).properties || {}).configuration || {};
      const manual = cfg.manualTriggerConfig || {};
      ok('compile_manual', /Manual/.test(String(cfg.triggerType)));
      ok('compile_retry_zero', cfg.replicaRetryLimit === 0 || /replicaRetryLimit.:0/.test(blob));
      ok('compile_parallelism', manual.parallelism === 1 || /parallelism.:1/.test(blob));
      ok('compile_completions', manual.replicaCompletionCount === 1 || /replicaCompletionCount.:1/.test(blob));
      ok('compile_no_ingress', !/ingress/i.test(blob));
      ok('compile_secret_refs', /admin-database-url|app-role-password/.test(blob) && /secretRef/.test(blob));
      ok('compile_outputs_narrow', compiledJob.outputs && compiledJob.outputs.jobId && compiledJob.outputs.jobName
        && !Object.keys(compiledJob.outputs).some((k) => /pass|secret|dsn|url/i.test(k)));
      ok('compile_ownership_tags', TAGS.every((t) => blob.includes(t)));
      ok('compile_digest_image', /@sha256:/.test(blob) && /staff_image_digest_required/.test(blob));
      ok('wrong_image_tag_rejected', hasFail(job, 'staff_image_digest_required') && !/staffApiImageTag/.test(job));
      const compiledMain = build(path.join(ROOT, MAIN_REL));
      ok('compile_main_with_job_gate', /deployBootstrapJob|syntheticBootstrapJob|synthetic-bootstrap/.test(JSON.stringify(compiledMain)));
      ok('forged_resources_impossible', /pgApp\.id/.test(job) && /containerAppsEnv\.id/.test(job)
        && /managedIdentity\.id/.test(job) && /existing =/.test(job)
        && !/param postgresServerId/.test(job) && !/param expectedPgHost/.test(job));
      ok('compile_depends_on_present', /dependsOn/.test(mainSrc) && /acrPullRole/.test(mainSrc));
    } catch (err) {
      skipMany(['compile_job','compile_manual','compile_retry_zero','compile_parallelism','compile_completions','compile_no_ingress',
        'compile_secret_refs','compile_outputs_narrow','compile_ownership_tags','compile_digest_image','wrong_image_tag_rejected',
        'compile_main_with_job_gate','forged_resources_impossible','compile_depends_on_present'], String(err.stderr || err.message || err).slice(0, 400));
    }
  } else ok('compile_job', false, 'missing job/main or bicep');
  ok('cli_no_console_secret', !/console\.(log|error|info|warn)\([^)]*password/i.test(cli));
  ok('job_secrets_not_in_tags', !/tags:[\s\S]{0,400}(adminDatabaseUrl|appRolePassword|Password)/.test(job));
  ok('secret_nonleak_operator', !/--admin-database-url|--password|--app-role-password/.test(cli) || /secret_argv_forbidden/.test(cli));
  const st = diffStat();
  console.log('\n── budget ──');
  console.log(JSON.stringify({ files: st.files, rawAdd: st.rawAdd, rawDel: st.rawDel, net: st.net, perFile: st.perFile }, null, 2));
  ok('budget_files', st.files <= 9, `files=${st.files}`);
  ok('budget_net', st.net <= 1250, `net=${st.net}`);
  console.log(`\nRESULT: ${fail === 0 ? 'PASS' : 'FAIL'}  pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(cleanup);
