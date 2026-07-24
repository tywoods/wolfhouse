#!/usr/bin/env node
'use strict';
/** Stage 2C2 synthetic bootstrap — secrets via env; rejects sunset/wolfhouse/prod. Public DML/seq/fn grants + default ACLs. */
const crypto = require('crypto');
const { URL } = require('url');
function loadPgClient() {
  // Lazy: offline 2D2/C2 operator argv tests must not require native `pg`.
  // eslint-disable-next-line global-require
  return require('pg').Client;
}
const {
  runCanonicalMigrations, withAdvisoryLock, probeFreshSyntheticDatabase,
  reconcileLedger, loadLedger, ensureLedger,
} = require('./run-canonical-migrations');
const {
  assertSafeDatabaseTarget, assertSyntheticTenantSlug, expectedSyntheticPostgresHost,
  expectedSyntheticDatabaseName, ADVISORY_LOCK_KEY1, ADVISORY_LOCK_KEY2,
  loadManifest, forwardEntries, validateManifestIntegrity, MANIFEST_PATH, MIGRATIONS_DIR,
} = require('./lib/migration-integrity');
const SECRET_ARGV_RE = /--(password|admin-database-url|database-url|app-role-password|secret|dsn)/i;
const ATTESTATION_DDL = `CREATE TABLE IF NOT EXISTS public.synthetic_bootstrap_attestation (
  tenant_slug text PRIMARY KEY, plan_digest text NOT NULL, deploy_sha text NOT NULL,
  attested_at timestamptz NOT NULL DEFAULT NOW())`;
const APP_ROLE_TABLE_PRIVS = Object.freeze(['SELECT', 'INSERT', 'UPDATE', 'DELETE']); // exact DML set
const APP_ROLE_SEQ_PRIVS = Object.freeze(['USAGE', 'SELECT']);
const APP_ROLE_FN_PRIVS = Object.freeze(['EXECUTE']);
function redactSecrets(text, secrets) {
  let out = String(text || '');
  for (const s of secrets || []) {
    if (s && String(s).length >= 4) out = out.split(String(s)).join('[REDACTED]');
  }
  return out.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, '[REDACTED_DSN]').replace(/Password\s+'[^']*'/gi, "Password '[REDACTED]'");
}
function rejectSecretArgv(argv) {
  for (const a of argv || process.argv) {
    if (SECRET_ARGV_RE.test(String(a))) return { ok: false, errors: [{ code: 'secret_argv_forbidden', message: 'secrets must not be passed via argv' }] };
  }
  return { ok: true, errors: [] };
}
function assertSyntheticAttestation(att) {
  const a = att || {}; const errors = []; const slugGate = assertSyntheticTenantSlug(a.tenantSlug);
  if (!slugGate.ok) errors.push(...slugGate.errors);
  const slug = String(a.tenantSlug || ''); const sub = String(a.subscriptionId || ''); const rg = String(a.resourceGroupName || '');
  if (String(a.expectedHost || '') !== expectedSyntheticPostgresHost(slug)) errors.push({ code: 'attestation_host_mismatch', message: 'EXPECTED_PG_HOST mismatch' });
  if (String(a.expectedDatabase || '') !== expectedSyntheticDatabaseName(slug)) errors.push({ code: 'attestation_database_mismatch', message: 'EXPECTED_PG_DATABASE mismatch' });
  if (Number(a.expectedPort == null ? 5432 : a.expectedPort) !== 5432) errors.push({ code: 'attestation_port_mismatch', message: 'expected port must be 5432' });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sub)) errors.push({ code: 'attestation_subscription_shape', message: 'subscription id shape invalid' });
  if (rg !== `luna-${slug}-staging-rg`) errors.push({ code: 'attestation_rg_mismatch', message: 'resource group name mismatch' });
  if (String(a.acaEnvironmentId || '') !== `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.App/managedEnvironments/luna-${slug}-staging-env`) {
    errors.push({ code: 'attestation_aca_env_mismatch', message: 'ACA environment id mismatch' });
  }
  if (String(a.postgresServerId || '') !== `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.DBforPostgreSQL/flexibleServers/luna-${slug}-staging-pg-app`) {
    errors.push({ code: 'attestation_pg_id_mismatch', message: 'postgres server id mismatch' });
  }
  if (!a.planDigest || !a.deploySha || !a.owner) errors.push({ code: 'attestation_ownership_tuple', message: 'planDigest/deploySha/owner required' });
  if (!/^[a-f0-9]{40}$/i.test(String(a.deploySha || ''))) errors.push({ code: 'attestation_deploy_sha', message: 'deploySha must be immutable 40-hex sha' });
  return { ok: errors.length === 0, errors };
}
function assertAdminDsnMatchesAttestation(dsn, att) {
  const errors = []; let u;
  try { u = new URL(String(dsn || '')); } catch (_) { return { ok: false, errors: [{ code: 'admin_dsn_parse', message: 'admin DSN parse failed' }] }; }
  if (!/^postgres(ql)?:$/i.test(u.protocol)) errors.push({ code: 'admin_dsn_protocol', message: 'bad protocol' });
  if (u.hostname !== att.expectedHost) errors.push({ code: 'admin_dsn_host_mismatch', message: 'host mismatch' });
  const db = (u.pathname || '').replace(/^\//, '');
  if (db !== att.expectedDatabase) errors.push({ code: 'admin_dsn_database_mismatch', message: 'db mismatch' });
  if (Number(u.port || 5432) !== 5432) errors.push({ code: 'admin_dsn_port_mismatch', message: 'port mismatch' });
  const sslmode = (u.searchParams.get('sslmode') || '').toLowerCase();
  if (!sslmode || ['disable', 'allow', 'prefer'].includes(sslmode)) errors.push({ code: 'admin_dsn_tls_required', message: 'sslmode verify-full|require|verify-ca required' });
  else if (!['verify-full', 'require', 'verify-ca'].includes(sslmode)) errors.push({ code: 'admin_dsn_tls_weak', message: 'TLS mode too weak' });
  return { ok: errors.length === 0, errors,
    parsed: { host: u.hostname, database: db, port: Number(u.port || 5432), user: decodeURIComponent(u.username || ''), password: decodeURIComponent(u.password || ''), sslmode } };
}
function shapeFresh(row) {
  const ledgerExists = row.ledger_exists === true || row.ledger_exists === 't';
  const ledgerRows = Number(row.ledger_rows || 0);
  const c = ['user_schemas', 'user_relations', 'user_functions', 'user_types', 'user_triggers'].map((k) => Number(row[k] || 0));
  if (ledgerExists && ledgerRows > 0) return { ok: false, errors: [{ code: 'synthetic_db_not_fresh_ledger', message: 'canonical ledger not empty' }] };
  if (c.some((n) => n > 0)) return { ok: false, errors: [{ code: 'synthetic_db_not_fresh_schema', message: 'user schema objects present' }] };
  return { ok: true, errors: [], ledgerExists, ledgerRows, userSchemas: c[0], userRelations: c[1], userFunctions: c[2], userTypes: c[3], userTriggers: c[4] };
}
async function assertFreshSyntheticDatabase(client) {
  try {
    const live = await probeFreshSyntheticDatabase(client);
    if (live && (live.ok === true || (live.errors && live.errors.length))) return live;
  } catch (_) { /* test doubles */ }
  const row = ((await client.query('SELECT 1 AS probe')).rows || [])[0] || {};
  if (row.ledger_exists != null || row.user_relations != null || row.user_functions != null) return shapeFresh(row);
  return probeFreshSyntheticDatabase(client);
}
function appRoleNameForSlug(slug) { return `${slug}_app`; }
async function withBootstrapLock(client, fn) { return withAdvisoryLock(client, fn); }
async function readAttestationRows(client) {
  try { return ((await client.query('SELECT tenant_slug, plan_digest, deploy_sha FROM public.synthetic_bootstrap_attestation')).rows) || []; }
  catch (_) { return []; }
}
function evaluateAttestationRows(rows, att) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return { ok: true, absent: true, match: false, errors: [] };
  if (list.length !== 1) return { ok: false, absent: false, match: false, errors: [{ code: 'attestation_multiple_rows', message: 'multiple attestation rows rejected' }] };
  const row = list[0] || {};
  const match = String(row.tenant_slug) === String(att.tenantSlug)
    && String(row.plan_digest) === String(att.planDigest) && String(row.deploy_sha) === String(att.deploySha);
  if (!match) return { ok: false, absent: false, match: false, errors: [{ code: 'attestation_tuple_mismatch', message: 'attestation must match tenant_slug+planDigest+deploySha' }] };
  return { ok: true, absent: false, match: true, row, errors: [] };
}
async function roleExists(client, roleName) {
  return Boolean(((await client.query('SELECT rolname FROM pg_roles WHERE rolname=$1', [roleName])).rows || [])[0]);
}
function pushMissingPrivs(errors, items, required, code, label) {
  for (const t of items || []) {
    for (const p of required) {
      if (!t.privs || t.privs[p] !== true) errors.push({ code, message: `missing ${p} on ${label} ${t.name}` });
    }
  }
}
function pushMissingDefaults(errors, have, required, code, label) {
  for (const p of required) {
    if (!(have || []).includes(p)) errors.push({ code, message: `default ${label} ${p}` });
  }
}
function evaluateAppRoleSecuritySnapshot(snap, opts) {
  const o = opts || {}; const s = snap || {}; const errors = []; const a = s.attributes;
  if (!a) return { ok: false, errors: [{ code: 'app_role_missing', message: 'app role absent' }], roleName: s.roleName || o.roleName || null };
  if (a.rolcanlogin !== true) errors.push({ code: 'app_role_login_required', message: 'rolcanlogin must be true' });
  for (const [flag, code] of [['rolsuper', 'app_role_elevated_super'], ['rolcreatedb', 'app_role_elevated_createdb'],
    ['rolcreaterole', 'app_role_elevated_createrole'], ['rolinherit', 'app_role_inherit_forbidden'],
    ['rolreplication', 'app_role_replication_forbidden'], ['rolbypassrls', 'app_role_bypassrls_forbidden']]) {
    if (a[flag] === true) errors.push({ code, message: `${flag} must be false` });
  }
  if (Number(s.membershipCount || 0) > 0) errors.push({ code: 'app_role_membership_forbidden', message: 'zero pg_auth_members as member/roleid/grantor required' });
  if (s.hasConnect !== true) errors.push({ code: 'app_role_missing_connect', message: 'CONNECT on current database required' });
  if (s.hasSchemaUsage !== true) errors.push({ code: 'app_role_missing_schema_usage', message: 'USAGE on public schema required' });
  if (!Array.isArray(s.tables) || !s.tables.length) errors.push({ code: 'app_role_empty_tables_inventory', message: 'tables inventory null/missing/empty' });
  else pushMissingPrivs(errors, s.tables, APP_ROLE_TABLE_PRIVS, 'app_role_missing_table_priv', 'table');
  if (!Array.isArray(s.sequences) || !s.sequences.length) errors.push({ code: 'app_role_empty_sequences_inventory', message: 'sequences inventory null/missing/empty' });
  else pushMissingPrivs(errors, s.sequences, APP_ROLE_SEQ_PRIVS, 'app_role_missing_sequence_priv', 'sequence');
  if (!Array.isArray(s.functions) || !s.functions.length) errors.push({ code: 'app_role_empty_functions_inventory', message: 'functions inventory null/missing/empty' });
  else pushMissingPrivs(errors, s.functions, APP_ROLE_FN_PRIVS, 'app_role_missing_function_priv', 'function');
  const d = s.defaultPrivileges || {};
  pushMissingDefaults(errors, d.tables, APP_ROLE_TABLE_PRIVS, 'app_role_missing_default_table_acl', 'table');
  pushMissingDefaults(errors, d.sequences, APP_ROLE_SEQ_PRIVS, 'app_role_missing_default_sequence_acl', 'sequence');
  pushMissingDefaults(errors, d.functions, APP_ROLE_FN_PRIVS, 'app_role_missing_default_function_acl', 'function');
  return { ok: errors.length === 0, errors, roleName: s.roleName || o.roleName || null,
    attributes: {
      rolcanlogin: a.rolcanlogin === true, rolsuper: a.rolsuper === true, rolcreatedb: a.rolcreatedb === true,
      rolcreaterole: a.rolcreaterole === true, rolinherit: a.rolinherit === true,
      rolreplication: a.rolreplication === true, rolbypassrls: a.rolbypassrls === true,
    } };
}
async function loadAppRoleSecuritySnapshot(client, opts) {
  const o = opts || {}; const roleName = o.roleName || appRoleNameForSlug(o.tenantSlug);
  const database = String(o.database || '');
  const q = (sql, params) => client.query(sql, params);
  const attrs = ((await q(
    'SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,oid FROM pg_roles WHERE rolname=$1',
    [roleName],
  )).rows || [])[0];
  if (!attrs) return { roleName, attributes: null };
  const membershipCount = Number(((await q(
    'SELECT COUNT(*)::int AS n FROM pg_auth_members m WHERE m.member=$1 OR m.roleid=$1 OR m.grantor=$1', [attrs.oid],
  )).rows || [])[0]?.n || 0);
  const dbRow = ((await q(
    'SELECT current_database() AS db, has_database_privilege($1::text, current_database(), \'CONNECT\') AS ok', [roleName],
  )).rows || [])[0] || {};
  const hasConnect = dbRow.ok === true && (!database || String(dbRow.db) === database);
  const hasSchemaUsage = ((await q(
    'SELECT has_schema_privilege($1::text, \'public\', \'USAGE\') AS ok', [roleName],
  )).rows || [])[0]?.ok === true;
  const tables = ((await q(
    `SELECT c.relname AS name, has_table_privilege($1::text,c.oid,'SELECT') AS "SELECT", has_table_privilege($1::text,c.oid,'INSERT') AS "INSERT",
      has_table_privilege($1::text,c.oid,'UPDATE') AS "UPDATE", has_table_privilege($1::text,c.oid,'DELETE') AS "DELETE"
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')`, [roleName],
  )).rows || []).map((r) => ({ name: r.name, privs: { SELECT: !!r.SELECT, INSERT: !!r.INSERT, UPDATE: !!r.UPDATE, DELETE: !!r.DELETE } }));
  const sequences = ((await q(
    `SELECT c.relname AS name, has_sequence_privilege($1::text,c.oid,'USAGE') AS "USAGE", has_sequence_privilege($1::text,c.oid,'SELECT') AS "SELECT"
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'`, [roleName],
  )).rows || []).map((r) => ({ name: r.name, privs: { USAGE: !!r.USAGE, SELECT: !!r.SELECT } }));
  const functions = ((await q(
    `SELECT p.proname AS name, has_function_privilege($1::text,p.oid,'EXECUTE') AS "EXECUTE" FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`, [roleName],
  )).rows || []).map((r) => ({ name: r.name, privs: { EXECUTE: !!r.EXECUTE } }));
  const defRows = ((await q(
    `SELECT d.defaclobjtype AS obj, (aclexplode(d.defaclacl)).privilege_type AS priv, (aclexplode(d.defaclacl)).grantee AS grantee
      FROM pg_default_acl d WHERE d.defaclnamespace='public'::regnamespace AND d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user)`,
  )).rows || []);
  const defaultPrivileges = { tables: [], sequences: [], functions: [] };
  for (const r of defRows) {
    if (Number(r.grantee) !== Number(attrs.oid)) continue;
    if (r.obj === 'r') defaultPrivileges.tables.push(r.priv);
    else if (r.obj === 'S') defaultPrivileges.sequences.push(r.priv);
    else if (r.obj === 'f') defaultPrivileges.functions.push(r.priv);
  }
  const { oid, ...attributes } = attrs;
  return { roleName, attributes, membershipCount, hasConnect, hasSchemaUsage, tables, sequences, functions, defaultPrivileges };
}
async function inspectAppRoleSecurity(client, opts) {
  const o = opts || {};
  return evaluateAppRoleSecuritySnapshot(o.snapshot || await loadAppRoleSecuritySnapshot(client, o), o);
}
async function evaluateBootstrapMode(client, opts) {
  const o = opts || {}; const att = o.attestation || {};
  const roleName = appRoleNameForSlug(att.tenantSlug);
  if (o.migrationComplete === false && o.hasRole) {
    return { ok: false, mode: null, errors: [{ code: 'bootstrap_partial_state', message: 'partial bootstrap state rejected' }] };
  }
  const attEval = o.attestationRows != null
    ? evaluateAttestationRows(o.attestationRows, att)
    : (o.hasAttestation != null
      ? (o.hasAttestation
        ? { ok: true, absent: false, match: true, errors: [] }
        : { ok: true, absent: true, match: false, errors: [] })
      : evaluateAttestationRows(await readAttestationRows(client), att));
  if (!attEval.ok) return { ok: false, mode: null, errors: attEval.errors };
  const hasRole = o.hasRole != null ? o.hasRole : await roleExists(client, roleName);
  const finish = async (migrationComplete) => {
    if (migrationComplete && attEval.absent && !hasRole) return { ok: true, mode: 'recovery', errors: [] };
    if (migrationComplete && attEval.match && hasRole) {
      const sec = await inspectAppRoleSecurity(client, {
        roleName, database: att.expectedDatabase, snapshot: o.roleSecuritySnapshot, tenantSlug: att.tenantSlug,
      });
      if (!sec.ok) return { ok: false, mode: null, errors: sec.errors };
      return { ok: true, mode: 'already_complete', errors: [] };
    }
    return { ok: false, mode: null, errors: [{ code: 'bootstrap_not_recoverable', message: 'non-fresh; recovery requires complete chain, absent attestation, absent app role' }] };
  };
  if (o.migrationComplete === true) return finish(true);
  const fresh = await assertFreshSyntheticDatabase(client);
  if (fresh.ok) return { ok: true, mode: 'fresh', errors: [], fresh };
  let migrationComplete = o.migrationComplete;
  if (migrationComplete == null) {
    try {
      await ensureLedger(client);
      const manifest = loadManifest(MANIFEST_PATH);
      const integrity = validateManifestIntegrity(manifest, { migrationsDir: MIGRATIONS_DIR });
      if (!integrity.ok) return { ok: false, mode: null, errors: integrity.errors };
      const forward = forwardEntries(manifest);
      const recon = reconcileLedger(forward, await loadLedger(client));
      migrationComplete = recon.ok && forward.every((e) => recon.byId.has(e.id));
      if (!recon.ok) return { ok: false, mode: null, errors: recon.errors.concat([{ code: 'bootstrap_not_recoverable', message: 'non-fresh and ledger not recoverable' }]) };
    } catch (err) {
      return { ok: false, mode: null, errors: [{ code: 'bootstrap_mode_probe_failed', message: String(err.message || err) }] };
    }
  }
  return finish(migrationComplete);
}
async function createTenantAppRole(client, opts) {
  const o = opts || {};
  const roleName = appRoleNameForSlug(String(o.tenantSlug || ''));
  const password = String(o.password || ''); const database = String(o.database || ''); const att = o.attestation || {};
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(roleName)) return { ok: false, errors: [{ code: 'app_role_name_invalid', message: 'role name invalid' }] };
  if (!password || password.length < 24) return { ok: false, errors: [{ code: 'app_role_password_weak', message: 'app role password too weak' }] };
  if (!att.planDigest || !att.deploySha || !att.tenantSlug) return { ok: false, errors: [{ code: 'attestation_required', message: 'planDigest/tenant/deploySha required for role txn' }] };
  try {
    await client.query('BEGIN');
    await client.query(ATTESTATION_DDL);
    const exists = await roleExists(client, roleName);
    const roleFmt = exists
      ? `SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',$1::text,$2::text) AS sql`
      : `SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',$1::text,$2::text) AS sql`;
    await client.query((await client.query(roleFmt, [roleName, password])).rows[0].sql);
    await client.query((await client.query(`SELECT format('GRANT CONNECT ON DATABASE %I TO %I',$1::text,$2::text) AS sql`, [database, roleName])).rows[0].sql);
    for (const tmpl of [
      'GRANT USAGE ON SCHEMA public TO %I', 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
      'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I',
    ]) await client.query((await client.query(`SELECT format('${tmpl}',$1::text) AS sql`, [roleName])).rows[0].sql);
    await client.query(
      `INSERT INTO public.synthetic_bootstrap_attestation (tenant_slug, plan_digest, deploy_sha) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_slug) DO UPDATE SET plan_digest=EXCLUDED.plan_digest, deploy_sha=EXCLUDED.deploy_sha, attested_at=NOW()`,
      [att.tenantSlug, att.planDigest, att.deploySha],
    );
    const sec = await inspectAppRoleSecurity(client, { roleName, database, tenantSlug: att.tenantSlug, snapshot: o.securitySnapshot });
    if (!sec.ok) { await client.query('ROLLBACK'); return { ok: false, roleName, errors: sec.errors }; }
    await client.query('COMMIT');
    return { ok: true, roleName, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolcanlogin: true, attributes: sec.attributes, errors: [] };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    return { ok: false, roleName, errors: [{ code: err.code || 'app_role_txn_failed', message: String(err.message || err) }] };
  }
}
async function maybeCreateAppRoleAfterMigrations(client, opts) {
  const o = opts || {};
  if (!o.migrationResult || o.migrationResult.ok !== true) return { ok: false, skippedRole: true, errors: [{ code: 'migrations_failed', message: 'skip role; migrations failed' }] };
  return createTenantAppRole(client, o);
}
function attestationDigest(att) {
  return crypto.createHash('sha256').update(JSON.stringify({
    tenantSlug: att.tenantSlug, expectedHost: att.expectedHost, expectedDatabase: att.expectedDatabase,
    subscriptionId: att.subscriptionId, resourceGroupName: att.resourceGroupName,
    acaEnvironmentId: att.acaEnvironmentId, postgresServerId: att.postgresServerId,
    planDigest: att.planDigest, deploySha: att.deploySha, owner: att.owner,
  })).digest('hex');
}
function buildSummary(opts) {
  const o = opts || {};
  return {
    ok: o.ok === true, appliedCount: Number(o.appliedCount || 0), skippedCount: Number(o.skippedCount || 0),
    appRoleName: o.roleName || null, attestationDigest: o.attestation ? attestationDigest(o.attestation) : null,
    tenantSlug: o.attestation ? o.attestation.tenantSlug : null, database: o.attestation ? o.attestation.expectedDatabase : null,
  };
}
function readAttestationFromEnv(env) {
  const e = env || process.env;
  return {
    tenantSlug: e.TENANT_SLUG, expectedHost: e.EXPECTED_PG_HOST, expectedDatabase: e.EXPECTED_PG_DATABASE,
    expectedPort: Number(e.EXPECTED_PG_PORT || 5432), subscriptionId: e.SUBSCRIPTION_ID,
    resourceGroupName: e.RESOURCE_GROUP_NAME, acaEnvironmentId: e.ACA_ENVIRONMENT_ID,
    postgresServerId: e.POSTGRES_SERVER_ID, planDigest: e.PLAN_DIGEST, deploySha: e.DEPLOY_SHA, owner: e.OWNER,
  };
}
async function runBootstrap(env, deps) {
  const e = env || process.env; const d = deps || {}; const secrets = [];
  const argvGate = rejectSecretArgv(d.argv || process.argv);
  if (!argvGate.ok) return { ok: false, summary: buildSummary({ ok: false }), errors: argvGate.errors };
  const att = readAttestationFromEnv(e);
  const attGate = assertSyntheticAttestation(att);
  if (!attGate.ok) return { ok: false, summary: buildSummary({ ok: false, attestation: att }), errors: attGate.errors };
  const adminDsn = e.SYNTHETIC_BOOTSTRAP_ADMIN_DATABASE_URL || '';
  const appPassword = e.SYNTHETIC_BOOTSTRAP_APP_ROLE_PASSWORD || '';
  secrets.push(adminDsn, appPassword);
  const dsnGate = assertAdminDsnMatchesAttestation(adminDsn, att);
  if (!dsnGate.ok) return { ok: false, summary: buildSummary({ ok: false, attestation: att }), errors: dsnGate.errors.map((err) => ({ ...err, message: redactSecrets(err.message, secrets) })) };
  if (!appPassword || appPassword.length < 24) return { ok: false, summary: buildSummary({ ok: false, attestation: att }), errors: [{ code: 'app_role_password_missing', message: 'app role password required' }] };
  const connection = {
    host: dsnGate.parsed.host, port: dsnGate.parsed.port, user: dsnGate.parsed.user,
    password: dsnGate.parsed.password, database: dsnGate.parsed.database,
    ssl: { rejectUnauthorized: true }, application_name: 'messi-synthetic-bootstrap',
  };
  const safety = assertSafeDatabaseTarget(connection, { allowDedicatedSyntheticAzureInitialApply: true, syntheticTenantSlug: att.tenantSlug });
  if (!safety.ok) return { ok: false, summary: buildSummary({ ok: false, attestation: att }), errors: safety.errors };
  const ClientCtor = d.Client || loadPgClient();
  const migrate = d.runCanonicalMigrations || runCanonicalMigrations;
  const client = new ClientCtor({ ...connection, connectionTimeoutMillis: 10000, statement_timeout: 120000 });
  let appliedCount = 0; let skippedCount = 0;
  try {
    await client.connect();
    return await withBootstrapLock(client, async () => {
      const modeGate = await evaluateBootstrapMode(client, { attestation: att });
      if (!modeGate.ok) return { ok: false, summary: buildSummary({ ok: false, attestation: att }), errors: modeGate.errors };
      if (modeGate.mode === 'fresh') {
        const migrationResult = await migrate({
          connection, client, advisoryLockHeld: true, Client: ClientCtor,
          allowDedicatedSyntheticAzureInitialApply: true, syntheticTenantSlug: att.tenantSlug,
        });
        appliedCount = (migrationResult.applied || []).length;
        skippedCount = (migrationResult.skipped || []).length;
        if (!migrationResult.ok) {
          return { ok: false, summary: buildSummary({ ok: false, appliedCount, skippedCount, attestation: att }), errors: (migrationResult.errors || []).map((err) => ({ code: err.code, message: redactSecrets(err.message, secrets) })) };
        }
      } else if (modeGate.mode === 'already_complete') {
        return { ok: true, summary: buildSummary({ ok: true, appliedCount: 0, skippedCount: 0, roleName: appRoleNameForSlug(att.tenantSlug), attestation: att }), errors: [] };
      } else if (modeGate.mode !== 'recovery') {
        return { ok: false, summary: buildSummary({ ok: false, attestation: att }), errors: [{ code: 'bootstrap_mode_unknown', message: 'unknown bootstrap mode' }] };
      }
      const role = await createTenantAppRole(client, { tenantSlug: att.tenantSlug, password: appPassword, database: att.expectedDatabase, attestation: att });
      if (!role.ok) return { ok: false, summary: buildSummary({ ok: false, appliedCount, skippedCount, attestation: att }), errors: (role.errors || []).map((err) => ({ code: err.code, message: redactSecrets(err.message, secrets) })) };
      return { ok: true, summary: buildSummary({ ok: true, appliedCount, skippedCount, roleName: role.roleName, attestation: att }), errors: [] };
    });
  } catch (err) {
    return { ok: false, summary: buildSummary({ ok: false, appliedCount, skippedCount, attestation: att }), errors: [{ code: 'bootstrap_failed', message: redactSecrets(String(err.message || err), secrets) }] };
  } finally { try { await client.end(); } catch (_) { /* ignore */ } }
}
async function runOperatorJobLifecycle(opts) {
  const o = opts || {}; const att = o.attestation || {}; const secrets = o.secrets || [];
  const assertFn = o.assertActiveDrill;
  const azure = o.azure || createLocalAzOperator({
    attestation: att, secrets, run: o.run, runSync: o.runSync, sleep: o.sleep, now: o.now,
    pollMs: o.pollMs, timeoutMs: o.timeoutMs, fetchLogs: o.fetchLogs !== false,
    azCommand: o.azCommand || o.azPath, assertActiveDrill: assertFn,
  });
  const proc = o.process || process;
  if (azure.installSignalHandlers) azure.installSignalHandlers(proc);
  let ownershipOk = false;
  let result = { ok: false, deleted: false, ownershipVerified: false, summary: null, errors: [] };
  try {
    const can = await azure.assertCanDelete({ attestation: att });
    if (!can || can.ok !== true) {
      return { ok: false, deleted: false, ownershipVerified: false,
        errors: (can && can.errors) || [{ code: 'ownership_mismatch', message: 'refuse start: ownership not verified; no delete' }] };
    }
    ownershipOk = true; result.ownershipVerified = true;
    try {
      const start = await azure.startJob({ attestation: att });
      if (!start || start.ok !== true) {
        result = { ok: false, deleted: false, ownershipVerified: true, summary: null,
          errors: (start && start.errors) || [{ code: 'job_start_failed', message: 'start failed' }] };
      } else {
        const wait = await azure.waitTerminal({
          attestation: att, executionName: start.executionName, assertActiveDrill: assertFn,
        });
        const summary = wait && wait.summary ? wait.summary : null;
        const sumTxt = JSON.stringify(summary || {});
        if (/postgres(ql)?:\/\//i.test(sumTxt) || secrets.some((s) => s && sumTxt.includes(String(s)))) {
          result = { ok: false, summary: null, ownershipVerified: true, deleted: false,
            errors: [{ code: 'summary_secret_leak', message: 'refusing secret-bearing summary' }] };
        } else {
          result = { ok: Boolean(wait && wait.ok), summary, ownershipVerified: true, deleted: false,
            errors: (wait && wait.errors) || [], executionName: start.executionName };
        }
      }
    } catch (err) {
      result = { ok: false, summary: null, ownershipVerified: true, deleted: false,
        errors: [{ code: 'operator_lifecycle_failed', message: redactSecrets(String(err.message || err), secrets) }] };
    }
  } finally {
    if (ownershipOk) {
      try {
        const del = await azure.deleteJob({ attestation: att });
        result.deleted = Boolean(del && del.ok && del.verifiedAbsent !== false);
        if (!result.deleted) {
          result.ok = false;
          result.errors = (result.errors || []).concat(
            (del && del.errors) || [{ code: 'job_delete_or_verify_failed', message: 'delete/not-found verification failed' }],
          ).map((e) => ({ code: e.code, message: redactSecrets(e.message, secrets) }));
        }
      } catch (err) {
        result.ok = false; result.deleted = false;
        result.errors = (result.errors || []).concat([{ code: 'job_delete_failed', message: redactSecrets(String(err.message || err), secrets) }]);
      }
    }
    if (azure.removeSignalHandlers) azure.removeSignalHandlers(proc);
  }
  return result;
}
const TERMINAL_EXEC = new Set(['Succeeded', 'Failed', 'Stopped', 'Degraded']);
const SUMMARY_ALLOW = new Set(['ok', 'appliedCount', 'skippedCount', 'appRoleName', 'attestationDigest', 'tenantSlug', 'database']);
function derivedBootstrapJobNames(att) {
  const slug = String((att || {}).tenantSlug || '');
  // Single owner: D1 deriveBootstrapJobName (preserves short canonicals; shortens overlength).
  // Lazy require keeps offline operator argv tests free of D1 load cost until job names resolve.
  // eslint-disable-next-line global-require
  const { deriveBootstrapJobName } = require('./lib/messi-saas-stage2d1-plan-status');
  return {
    resourceGroupName: `luna-${slug}-staging-rg`,
    jobName: deriveBootstrapJobName(slug),
  };
}
function parseAllowlistedSummary(text, secrets) {
  const red = redactSecrets(String(text || ''), secrets);
  for (const line of red.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).reverse()) {
    try {
      const obj = JSON.parse(line);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
      const keys = Object.keys(obj);
      if (!keys.length || keys.some((k) => !SUMMARY_ALLOW.has(k)) || /postgres(ql)?:\/\//i.test(JSON.stringify(obj))) continue;
      return { ok: true, summary: obj, errors: [] };
    } catch (_) { /* scan */ }
  }
  return { ok: false, summary: null, errors: [{ code: 'summary_parse_failed', message: 'no allowlisted summary JSON' }] };
}
function resolveOperatorAzCommand(opts) {
  const pathMod = require('path');
  const o = opts || {};
  const candidate = o.azCommand || o.azPath || '/opt/data/.local/bin/az';
  if (typeof candidate !== 'string' || !candidate || candidate === 'az' || !pathMod.isAbsolute(candidate)) {
    const e = new Error('az_command_must_be_absolute'); e.code = 'az_command_must_be_absolute'; throw e;
  }
  if (candidate.includes('\0') || /\s/.test(candidate) || candidate.includes('..')) {
    const e = new Error('az_command_invalid'); e.code = 'az_command_invalid'; throw e;
  }
  const resolved = pathMod.resolve(candidate);
  if (resolved !== candidate) {
    const e = new Error('az_command_must_be_absolute'); e.code = 'az_command_must_be_absolute'; throw e;
  }
  return candidate;
}
function createLocalAzOperator(opts) {
  const o = opts || {}; const att = o.attestation || {}; const secrets = o.secrets || [];
  const names = derivedBootstrapJobNames(att);
  const azCmd = resolveOperatorAzCommand(o);
  const { execFile, execFileSync } = require('child_process');
  const run = o.run || ((cmd, argv) => new Promise((resolve, reject) => {
    execFile(cmd, argv, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr, status: 0 });
    });
  }));
  const runSync = o.runSync || ((cmd, argv) => execFileSync(cmd, argv, { encoding: 'utf8' }));
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))); const now = o.now || Date.now;
  const pollMs = Number(o.pollMs || 2000); const timeoutMs = Number(o.timeoutMs || 900000); const fetchLogs = o.fetchLogs !== false;
  const assertFn = o.assertActiveDrill;
  let ownershipVerified = false; let deleted = false; const sigHandlers = {};
  const g = names.resourceGroupName; const jn = names.jobName;
  const A = () => ['account', 'show', '--subscription', String(att.subscriptionId), '-o', 'json'];
  const S = () => ['containerapp', 'job', 'show', '-g', g, '-n', jn, '-o', 'json'];
  const T = () => ['containerapp', 'job', 'start', '-g', g, '-n', jn, '-o', 'json'];
  const E = (n) => ['containerapp', 'job', 'execution', 'show', '-g', g, '-n', jn, '--job-execution-name', String(n), '-o', 'json'];
  const L = (n) => ['containerapp', 'job', 'logs', 'show', '-g', g, '-n', jn, '--execution', String(n), '--container', 'synthetic-bootstrap', '-o', 'json']; // documented logs argv
  const D = () => ['containerapp', 'job', 'delete', '-g', g, '-n', jn, '--yes', '-o', 'none'];
  const notFound = (err) => /(?:StatusCodeNotFound|ResourceNotFound|could not be found|NotFound|\(404\))/i.test(`${err && err.message || ''} ${err && err.stderr || ''} ${err && err.stdout || ''}`);
  const fail = (code, message) => ({ ok: false, errors: [{ code, message }] });
  const beforeMut = async (b) => {
    if (typeof assertFn !== 'function') return { ok: true };
    const r = await assertFn(b); return (r && r.ok === false) ? r : { ok: true };
  };
  async function azJson(argv) {
    const r = await run(azCmd, argv);
    try { return { ok: true, json: String(r.stdout || '').trim() ? JSON.parse(r.stdout) : null }; }
    catch (err) { return fail('az_json_parse', redactSecrets(String(err.message || err), secrets)); }
  }
  function evaluateJobOwnership(account, job) {
    const errors = []; const g = assertSyntheticAttestation(att); if (!g.ok) return g;
    if (String(att.resourceGroupName) !== names.resourceGroupName) errors.push({ code: 'operator_rg_mismatch', message: 'RG must be luna-<slug>-staging-rg' });
    if (String((account || {}).id || '') !== String(att.subscriptionId)) errors.push({ code: 'operator_subscription_mismatch', message: 'subscription mismatch' });
    const tags = (job && job.tags) || {};
    for (const [k, exp] of [['tenant', att.tenantSlug], ['owner', att.owner], ['planDigest', att.planDigest], ['deploySha', att.deploySha]]) {
      if (String(tags[k] || '') !== String(exp || '')) errors.push({ code: 'operator_tag_mismatch', message: `tag ${k} mismatch` });
    }
    const stage = String(tags.stage || '').toLowerCase();
    if (!(stage === 'staging' || stage.includes('staging') || stage === 'saas-2c2')) errors.push({ code: 'operator_stage_not_staging', message: 'stage must be synthetic/staging' });
    if (String((job && job.properties && job.properties.environmentId) || '') !== String(att.acaEnvironmentId)) errors.push({ code: 'operator_env_mismatch', message: 'environmentId mismatch' });
    const id = String((job && job.id) || '').toLowerCase();
    const want = `/subscriptions/${att.subscriptionId}/resourceGroups/${names.resourceGroupName}/`.toLowerCase();
    if (!id.startsWith(want) || !id.endsWith(`/jobs/${names.jobName}`.toLowerCase())) errors.push({ code: 'operator_job_id_mismatch', message: 'job id RG/name mismatch' });
    const image = String((((((job || {}).properties || {}).template || {}).containers || [])[0] || {}).image || '');
    if (!/@sha256:[a-f0-9]{64}\b/i.test(image)) errors.push({ code: 'operator_image_not_digest', message: 'digest image required' });
    return { ok: errors.length === 0, errors };
  }
  async function assertCanDelete() {
    if (String(att.resourceGroupName || '') !== names.resourceGroupName) return fail('operator_rg_mismatch', 'RG must equal luna-<slug>-staging-rg');
    try {
      const a = await azJson(A()); if (!a.ok) return a;
      const j = await azJson(S()); if (!j.ok) return j;
      const own = evaluateJobOwnership(a.json, j.json);
      if (!own.ok) return { ok: false, errors: own.errors };
      ownershipVerified = true; return { ok: true, errors: [], names };
    } catch (err) {
      return fail('operator_ownership_read_failed', redactSecrets(String(err.message || err), secrets));
    }
  }
  async function startJob() {
    const g0 = await beforeMut('before-startJob'); if (!g0.ok) return g0;
    if (!ownershipVerified) return fail('ownership_not_verified', 'start requires ownership');
    try {
      const r = await azJson(T()); if (!r.ok) return r;
      const executionName = String((r.json && (r.json.name || r.json.executionName || (r.json.properties && r.json.properties.name))) || '');
      return executionName ? { ok: true, executionName, errors: [] } : fail('job_start_no_execution', 'missing execution name');
    } catch (err) { return fail('job_start_failed', redactSecrets(String(err.message || err), secrets)); }
  }
  async function waitTerminal(args) {
    const executionName = String((args || {}).executionName || '');
    const pollAssert = (args && args.assertActiveDrill) || assertFn;
    if (!ownershipVerified) return fail('ownership_not_verified', 'wait requires ownership');
    if (!executionName) return fail('execution_name_required', 'execution name required');
    const t0 = now(); let lastStatus = null;
    while (now() - t0 <= timeoutMs) {
      if (typeof pollAssert === 'function') {
        const g0 = await pollAssert('waitTerminal-poll');
        if (g0 && g0.ok === false) return g0;
      }
      try {
        const r = await azJson(E(executionName)); if (!r.ok) return r;
        lastStatus = String((((r.json || {}).properties || {}).status) || (r.json && r.json.status) || '');
        if (TERMINAL_EXEC.has(lastStatus)) break;
      } catch (err) { return fail('execution_poll_failed', redactSecrets(String(err.message || err), secrets)); }
      await sleep(pollMs);
    }
    if (!TERMINAL_EXEC.has(lastStatus)) return { ok: false, status: lastStatus || 'timeout', summary: null, errors: [{ code: 'execution_timeout', message: 'bounded poll timeout' }] };
    if (lastStatus !== 'Succeeded') return { ok: false, status: lastStatus, summary: null, errors: [{ code: 'execution_terminal_failed', message: `execution ${lastStatus}` }] };
    if (!fetchLogs) return { ok: true, status: lastStatus, summary: null, errors: [] };
    try {
      const parsed = parseAllowlistedSummary(((await run(azCmd, L(executionName))) || {}).stdout || '', secrets);
      return parsed.ok ? { ok: true, status: lastStatus, summary: parsed.summary, errors: [] }
        : { ok: false, status: lastStatus, summary: null, errors: parsed.errors };
    } catch (err) {
      return { ok: false, status: lastStatus, summary: null, errors: [{ code: 'logs_read_failed', message: redactSecrets(String(err.message || err), secrets) }] };
    }
  }
  async function deleteJob() {
    const g0 = await beforeMut('before-deleteJob'); if (!g0.ok) return g0;
    if (!ownershipVerified) return { ok: false, verifiedAbsent: false, errors: [{ code: 'ownership_not_verified', message: 'delete only after ownership' }] };
    if (deleted) return { ok: true, verifiedAbsent: true, idempotent: true, errors: [] };
    try { await run(azCmd, D()); } catch (err) {
      if (!notFound(err)) return { ok: false, verifiedAbsent: false, errors: [{ code: 'job_delete_failed', message: redactSecrets(String(err.message || err), secrets) }] };
    }
    try { await run(azCmd, S()); return { ok: false, verifiedAbsent: false, errors: [{ code: 'job_still_present', message: 'job show succeeded after delete' }] }; }
    catch (err) {
      if (!notFound(err)) return { ok: false, verifiedAbsent: false, errors: [{ code: 'job_delete_verify_failed', message: redactSecrets(String(err.message || err), secrets) }] };
    }
    deleted = true; return { ok: true, verifiedAbsent: true, errors: [] };
  }
  function installSignalHandlers(proc) {
    const p = proc || process;
    const h = () => {
      try { if (ownershipVerified && !deleted) { try { runSync(azCmd, D()); deleted = true; } catch (err) { if (!notFound(err)) { /* */ } } } }
      finally { try { p.exit(1); } catch (_) { /* */ } }
    };
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) { sigHandlers[sig] = h; if (p.on) p.on(sig, h); }
  }
  function removeSignalHandlers(proc) {
    const p = proc || process;
    for (const sig of Object.keys(sigHandlers)) { if (p.removeListener) p.removeListener(sig, sigHandlers[sig]); delete sigHandlers[sig]; }
  }
  return {
    names, azCommand: azCmd, get isOwnershipVerified() { return ownershipVerified; },
    argvAccountShow: A, argvJobShow: S, argvJobStart: T, argvExecShow: E, argvJobLogsShow: L, argvJobDelete: D,
    assertCanDelete, startJob, waitTerminal, deleteJob, installSignalHandlers, removeSignalHandlers,
  };
}
module.exports = {
  redactSecrets, rejectSecretArgv, assertSyntheticAttestation, assertAdminDsnMatchesAttestation,
  assertFreshSyntheticDatabase, createTenantAppRole, maybeCreateAppRoleAfterMigrations,
  buildSummary, attestationDigest, readAttestationFromEnv, runBootstrap, appRoleNameForSlug,
  withBootstrapLock, evaluateBootstrapMode, runOperatorJobLifecycle, readAttestationRows,
  evaluateAttestationRows, inspectAppRoleSecurity, createLocalAzOperator, resolveOperatorAzCommand,
  derivedBootstrapJobNames,
  parseAllowlistedSummary, APP_ROLE_TABLE_PRIVS, APP_ROLE_SEQ_PRIVS, APP_ROLE_FN_PRIVS,
  ADVISORY_LOCK_KEY1, ADVISORY_LOCK_KEY2,
};
if (require.main === module) {
  const operator = process.argv.slice(2).includes('--operator-run-job');
  const secrets = [process.env.SYNTHETIC_BOOTSTRAP_ADMIN_DATABASE_URL, process.env.SYNTHETIC_BOOTSTRAP_APP_ROLE_PASSWORD];
  const run = operator
    ? runOperatorJobLifecycle({ attestation: readAttestationFromEnv(process.env), secrets })
    : runBootstrap(process.env);
  Promise.resolve(run).then((r) => {
    process.stdout.write(`${JSON.stringify(operator ? { ok: r.ok, summary: r.summary || null, deleted: Boolean(r.deleted) } : r.summary)}\n`);
    process.exit(r.ok ? 0 : 1);
  }).catch((e) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'bootstrap_crashed' })}\n`);
    process.stderr.write(`${redactSecrets(String(e && e.message ? e.message : e), secrets)}\n`);
    process.exit(1);
  });
}
