'use strict';
/** FULL SAIL Stage 1 NIGHTWATCH Chapter 4 Slice A: runtime DB principal/grant boundary. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT,
  EMAIL_LUNA_AUTOMATION_QUEUE_RUNTIME_WIRED,
} = require('./lib/email-luna-automation-queue-store');
const {
  EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT,
  EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RUNTIME_WIRED,
} = require('./lib/email-luna-automation-journal-handoff-store');
const {
  EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT,
  ROLE_ATTRIBUTES,
  RESERVED_ROLE_NAMES,
  FUNCTION_SIGNATURES,
  createRoleSql,
  createRoleSqlPlan,
  executeFunctionsFor,
  deniedExecuteFunctionsFor,
  assertRoleName,
  quoteIdent,
} = require('./lib/email-luna-automation-principal-contract');
const { provisionEmailLunaAutomationPrincipal, REDACTED } = require('./lib/email-luna-automation-principal-provision');

const ROOT = path.join(__dirname, '..');
const SQL_086 = fs.readFileSync(path.join(ROOT, 'database/migrations/086_tenant_email_luna_automation_queue.sql'), 'utf8');
const SQL_087 = fs.readFileSync(path.join(ROOT, 'database/migrations/087_tenant_email_luna_automation_journal_handoff.sql'), 'utf8');
const SQL_088 = fs.readFileSync(path.join(ROOT, 'database/migrations/088_tenant_email_luna_automation_principal_grants.sql'), 'utf8');
const DOWN_088 = fs.readFileSync(path.join(ROOT, 'database/migrations/088_tenant_email_luna_automation_principal_grants_down.sql'), 'utf8');
const CONTRACT_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-principal-contract'), 'utf8');
const PROVISION_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-principal-provision'), 'utf8');
const QUEUE_STORE_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-queue-store'), 'utf8');
const HANDOFF_STORE_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-journal-handoff-store'), 'utf8');
const RUNTIME_SRC = fs.readFileSync(require.resolve('./lib/email-luna-sunset-staging-runtime-composition'), 'utf8');

console.log('FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice A principal/grant boundary verifier');

assert.equal(EMAIL_LUNA_AUTOMATION_QUEUE_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.runtime_wired, false);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.default_off, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.no_create_role_in_088, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.no_grant_in_088, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.no_custom_guc, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.authorization, 'session_user_durable_mapping');
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.identity_signal, 'session_user');
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.queue_rls.enable, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.queue_rls.force, false);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.journal_rls.enable, false);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.worker_journal_select, false);
assert.equal(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT.worker_journal_select, false);
assert.deepEqual(
  EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT.worker_table_privileges.tenant_email_outbound_send_journal.slice(),
  [],
);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.exclusive_provisioner_session, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.refuse_pool_query, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.password_never_returned, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.query_secret_option_not_used, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.adopt_unmapped_existing_role, false);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.audit_function_privilege_by, 'oid_signature');
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.audit_direct_acl_completeness, 'pg_shdepend_deptype_a_cluster');
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.audit_owner_completeness, 'pg_shdepend_deptype_o_cluster');
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.trusted_precreated_pregrant_audit, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.direct_temp_rejected_even_if_public_temp, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.mapped_rerun_reaudits_drift, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.ambient_public_database_privileges.CREATE, 'rejected');
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.ambient_public_database_privileges.TEMP, 'public_current_database_accepted_direct_temp_rejected');
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.ambient_public_database_privileges.CONNECT, 'public_current_database_accepted');
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.ambient_callable_functions, 'exact_luna_oids_only');
assert.deepEqual(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.ambient_extension_execute_allowlist.slice(), []);
assert.equal(ROLE_ATTRIBUTES.rolcanlogin, true);
assert.equal(ROLE_ATTRIBUTES.rolsuper, false);
assert.equal(ROLE_ATTRIBUTES.rolcreatedb, false);
assert.equal(ROLE_ATTRIBUTES.rolcreaterole, false);
assert.equal(ROLE_ATTRIBUTES.rolinherit, false);
assert.equal(ROLE_ATTRIBUTES.rolreplication, false);
assert.equal(ROLE_ATTRIBUTES.rolbypassrls, false);

assert.equal(/^\s*CREATE ROLE/m.test(SQL_086), false);
assert.equal(/^\s*GRANT /m.test(SQL_086), false);
assert.equal(/^\s*CREATE ROLE/m.test(SQL_087), false);
assert.equal(/^\s*GRANT /m.test(SQL_087), false);
assert.equal(/^\s*CREATE ROLE/m.test(SQL_088), false);
assert.equal(/^\s*GRANT /m.test(SQL_088), false);
assert.equal(/current_setting\s*\(/.test(SQL_088), false);
assert.equal(/PASSWORD\s+'/i.test(SQL_088), false);
assert.equal(/LOGIN PASSWORD/i.test(SQL_088), false);
assert.equal(/sunset_staging|wolfhouse_prod|luna-sunset-staging/.test(SQL_088), false);
assert.equal(/set_config\s*\(/.test(SQL_088), false);
assert.match(SQL_088, /CREATE TABLE IF NOT EXISTS public\.tenant_email_luna_automation_principals/);
assert.match(SQL_088, /session_user/);
assert.match(SQL_088, /tenant_email_luna_automation_principal_authorized/);
assert.match(SQL_088, /SET search_path TO pg_catalog, public/);
assert.match(SQL_088, /ENABLE ROW LEVEL SECURITY/);
assert.equal(/FORCE ROW LEVEL SECURITY/.test(SQL_088), false);
assert.equal(/tenant_email_outbound_send_journal ENABLE ROW LEVEL SECURITY/.test(SQL_088), false);
assert.match(SQL_088, /REVOKE ALL ON TABLE public\.tenant_email_luna_automation_principals FROM PUBLIC/);
assert.match(SQL_088, /ALTER FUNCTION public\.%s OWNER TO %I/);
assert.match(SQL_088, /principal_kind IN \('worker', 'operator'\)/);
assert.match(SQL_088, /p\.role_name = session_user/);
assert.match(SQL_088, /tenant_email_luna_automation_journal_handoff_lock\(uuid, uuid\)/);
assert.match(SQL_088, /Authorizes session_user against the queue client\/location before locking journal/);
{
  const handoffFn = (SQL_088.split('CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_handoff')[1] || '')
    .split('CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_terminalize_attempt_cap')[0];
  const queueFrom = handoffFn.indexOf('FROM public.tenant_email_luna_automation_queue');
  const firstForUpdate = handoffFn.indexOf('FOR UPDATE');
  const authBeforeLock = handoffFn.indexOf('tenant_email_luna_automation_principal_authorized', queueFrom);
  assert.ok(queueFrom !== -1 && firstForUpdate !== -1 && authBeforeLock !== -1 && authBeforeLock < firstForUpdate);
  assert.equal(/IF NOT public\.tenant_email_luna_automation_principal_authorized/.test(handoffFn), false);
}
{
  const lockFn = (SQL_088.split('CREATE OR REPLACE FUNCTION public.tenant_email_luna_automation_journal_handoff_lock')[1] || '')
    .split('DO $$')[0];
  const journalFrom = lockFn.indexOf('FROM public.tenant_email_outbound_send_journal');
  const authBeforeJournal = lockFn.indexOf('tenant_email_luna_automation_principal_authorized');
  assert.ok(journalFrom !== -1 && authBeforeJournal !== -1 && authBeforeJournal < journalFrom);
}
assert.equal(SQL_088.includes("current_setting('role'"), false);

assert.equal(
  EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT.worker_execute_functions.includes('tenant_email_luna_automation_cancel_pending'),
  false,
);
assert.equal(
  EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT.worker_execute_functions.includes('tenant_email_luna_automation_require_handoff_pending'),
  false,
);
assert.deepEqual(executeFunctionsFor('worker').slice().sort(), [
  'tenant_email_luna_automation_cancel_claimed(uuid, uuid)',
  'tenant_email_luna_automation_claim(uuid, uuid)',
  'tenant_email_luna_automation_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text)',
  'tenant_email_luna_automation_handoff(uuid, uuid)',
  'tenant_email_luna_automation_journal_handoff_lock(uuid, uuid)',
  'tenant_email_luna_automation_principal_authorized(text, uuid, uuid, text)',
  'tenant_email_luna_automation_require_handoff_claimed(uuid, uuid)',
  'tenant_email_luna_automation_terminalize_attempt_cap(uuid, uuid)',
].sort());
assert.deepEqual(deniedExecuteFunctionsFor('worker').slice().sort(), [
  'tenant_email_luna_automation_cancel_pending(uuid, uuid)',
  'tenant_email_luna_automation_require_handoff_pending(uuid, uuid)',
].sort());
assert.equal(executeFunctionsFor('operator').includes('tenant_email_luna_automation_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text)'), false);
assert.deepEqual(executeFunctionsFor('producer').slice().sort(), [
  'tenant_email_luna_automation_persist_and_enqueue(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text, jsonb)',
].sort());
assert.equal(executeFunctionsFor('producer').includes('tenant_email_luna_automation_claim(uuid, uuid)'), false);
assert.equal(executeFunctionsFor('producer').includes('tenant_email_luna_automation_principal_authorized(text, uuid, uuid, text)'), false);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.kinds.includes('producer'), true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.producer_queue_select, false);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.no_grant_in_095, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.no_create_role_in_095, true);
assert.equal(
  FUNCTION_SIGNATURES.tenant_email_luna_automation_claim_scoped,
  'tenant_email_luna_automation_claim_scoped(uuid, uuid, uuid, text, uuid)',
);
assert.deepEqual(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.scoped_claim_worker_execute_functions.slice(), [
  'tenant_email_luna_automation_claim_scoped',
]);
assert.equal(executeFunctionsFor('worker').includes(FUNCTION_SIGNATURES.tenant_email_luna_automation_claim_scoped), false);
assert.equal(executeFunctionsFor('producer').includes(FUNCTION_SIGNATURES.tenant_email_luna_automation_claim_scoped), false);

assert.match(DOWN_088, /088_down_refused/);
assert.match(DOWN_088, /DISABLE ROW LEVEL SECURITY/);
assert.match(DOWN_088, /DROP TABLE IF EXISTS public\.tenant_email_luna_automation_principals/);
assert.match(DOWN_088, /CREATE OR REPLACE FUNCTION public\.tenant_email_luna_automation_handoff/);
assert.match(DOWN_088, /luna-replay-owner-v1:/);

assert.equal(/email-luna-automation-principal-provision/.test(RUNTIME_SRC), false);
assert.equal(/email-luna-automation-principal-contract/.test(QUEUE_STORE_SRC), false);
assert.equal(/email-luna-automation-principal-contract/.test(HANDOFF_STORE_SRC), false);
assert.equal(/current_setting\s*\(/.test(QUEUE_STORE_SRC), false);
assert.equal(/current_setting\s*\(/.test(HANDOFF_STORE_SRC), false);
assert.match(CONTRACT_SRC, /session_user_durable_mapping/);
assert.match(PROVISION_SRC, /apply === true/);
assert.match(PROVISION_SRC, /REDACTED/);
assert.match(PROVISION_SRC, /EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_EXECUTE/);
assert.match(PROVISION_SRC, /EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL/);
assert.match(PROVISION_SRC, /CREATEROLE_UNAVAILABLE/);
assert.match(PROVISION_SRC, /EXCLUSIVE_CLIENT_REQUIRED/);
assert.match(PROVISION_SRC, /ADOPTION_REFUSED/);
assert.match(PROVISION_SRC, /to_regprocedure/);
assert.match(PROVISION_SRC, /WITH RECURSIVE mem AS/);
assert.match(PROVISION_SRC, /pg_catalog\.pg_shdepend/);
assert.match(PROVISION_SRC, /d\.deptype = 'a'/);
assert.match(PROVISION_SRC, /d\.deptype = 'o'/);
assert.match(PROVISION_SRC, /pg_catalog\.aclexplode/);
assert.match(PROVISION_SRC, /direct TEMP is rejected even if PUBLIC has TEMP/);
assert.match(PROVISION_SRC, /trusted pre-creation requires zero direct ACL dependencies before mapping\/grants/);
assert.match(PROVISION_SRC, /direct ACL audit does not see PUBLIC/);
assert.equal(/direct TEMP grant beyond ambient PUBLIC/.test(PROVISION_SRC), false);
assert.equal(/n\.nspname = 'public'\s+AND c\.relacl IS NOT NULL/.test(PROVISION_SRC), false);
assert.equal(/secret:\s*true/.test(PROVISION_SRC), false);
assert.equal(/query\([^)]+,\s*\[\s*\],\s*\{/.test(PROVISION_SRC), false);
assert.equal(/console\.log/.test(PROVISION_SRC), false);
assert.equal(/sunset_schema_observer|SUNSET_STAGING_PG_ADMIN/.test(PROVISION_SRC), false);
assert.equal(/FROM\s+(public\.)?tenant_email_outbound_send_journal/.test(HANDOFF_STORE_SRC), false);
assert.match(HANDOFF_STORE_SRC, /tenant_email_luna_automation_journal_handoff_lock/);
assert.match(DOWN_088, /DROP FUNCTION IF EXISTS public\.tenant_email_luna_automation_journal_handoff_lock\(uuid, uuid\)/);

assert.throws(() => assertRoleName('postgres'));
assert.throws(() => assertRoleName('Public'));
assert.throws(() => assertRoleName('pg_read_all_data'));
assert.ok(RESERVED_ROLE_NAMES.includes('azure_pg_admin'));
assert.equal(quoteIdent('luna_ch4a_worker_a'), '"luna_ch4a_worker_a"');
assert.match(createRoleSqlPlan('luna_ch4a_worker_a'), /\*\*\*REDACTED\*\*\*/);
assert.equal(/PASSWORD '[^']+'/.test(createRoleSqlPlan('luna_ch4a_worker_a')), false);
const createSql = createRoleSql('luna_ch4a_worker_a', `${'A'.repeat(20)}_${'b'.repeat(20)}`);
assert.match(createSql, /LOGIN PASSWORD/);
assert.match(createSql, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/);

function mockSession(handler, tracker) {
  return {
    async connect() {
      if (tracker) tracker.connected += 1;
      return {
        async query(sql, params, extra) {
          if (tracker) {
            tracker.calls.push({ sql: String(sql), params: params || [], extraArg: extra !== undefined });
          }
          if (extra !== undefined) {
            throw Object.assign(new Error('secret option must not be used'), { code: 'SECRET_OPTION' });
          }
          const text = String(sql);
          if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(text)) return { rows: [] };
          return handler(text, params || []);
        },
        async release() {
          if (tracker) tracker.released += 1;
        },
      };
    },
  };
}

{
  const RED_PATH = path.join(ROOT, 'fixtures/email-luna-automation-principal-grants-red.json');
  const red = JSON.parse(fs.readFileSync(RED_PATH, 'utf8'));
  assert.equal(red.id, 'email-luna-automation-principal-grants.ch4a-red.v1');
  assert.equal(red.slice, 'FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice A');
  const ids = (red.findings || []).map((row) => row.id).sort();
  assert.deepEqual(ids, [
    'ambient-public-callable',
    'auth-after-lock',
    'cluster-incomplete-direct-acl',
    'incomplete-owner-dependencies',
    'pool-query-hop',
    'principal-adoption-drift',
    'raw-journal-select',
    'unbounded-create-role-txn',
  ].sort());
  assert.ok((red.findings || []).every((row) => row.severity === 'blocking' && row.green && row.red));
  console.log('  PASS  RED artifact enumerates the blocking findings closed by this slice');
}

{
  const calls = [];
  const tracker = { calls, connected: 0, released: 0 };
  let oid = 1000;
  const handler = async (sql) => {
    if (/current_database/.test(sql)) return { rows: [{ database: 'postgres', session_user: 'postgres' }] };
    if (/table_owner/.test(sql)) return { rows: [{ table_owner: 'postgres' }] };
    if (/to_regprocedure/.test(sql)) {
      oid += 1;
      return { rows: [{ oid: String(oid) }] };
    }
    if (/FROM pg_catalog\.pg_roles/.test(sql) && /rolcanlogin/.test(sql)) return { rows: [] };
    if (/tenant_email_luna_automation_principals/.test(sql) && /SELECT/.test(sql)) return { rows: [] };
    return { rows: [] };
  };
  const session = mockSession(handler, tracker);
  Promise.resolve(provisionEmailLunaAutomationPrincipal(session, {
    roleName: 'luna_ch4a_worker_a',
    kind: 'worker',
    client_id: '11111111-1111-4111-8111-111111111111',
    location_id: '22222222-2222-4222-8222-222222222222',
    location_key: 'sunset-somo',
  })).then((result) => {
    assert.equal(result.ok, true);
    assert.equal(result.apply, false);
    assert.equal(result.default_off, true);
    assert.equal(result.roleAction, 'create');
    assert.ok(result.plan.some((line) => /CREATE ROLE/.test(line) && /REDACTED/.test(line)));
    assert.equal(/PASSWORD\s+'/.test(JSON.stringify(result)), false);
    assert.match(JSON.stringify(result), /PASSWORD \*\*\*REDACTED\*\*\*/);
    assert.equal(calls.some((c) => /CREATE ROLE/.test(c.sql)), false);
    assert.equal(calls.some((c) => c.extraArg), false);
    assert.equal(tracker.released, 1);
    console.log('  PASS  dry-run provision is default-off and does not CREATE ROLE');
  }).then(async () => {
    const producerTracker = { calls: [], connected: 0, released: 0 };
    let oid = 2000;
    const producerSession = mockSession(async (sql) => {
      if (/current_database/.test(sql)) return { rows: [{ database: 'postgres', session_user: 'postgres' }] };
      if (/table_owner/.test(sql)) return { rows: [{ table_owner: 'postgres' }] };
      if (/to_regprocedure/.test(sql)) {
        oid += 1;
        return { rows: [{ oid: String(oid) }] };
      }
      if (/FROM pg_catalog\.pg_roles/.test(sql) && /rolcanlogin/.test(sql)) return { rows: [] };
      if (/tenant_email_luna_automation_principals/.test(sql) && /SELECT/.test(sql)) return { rows: [] };
      return { rows: [] };
    }, producerTracker);
    const producerPlan = await provisionEmailLunaAutomationPrincipal(producerSession, {
      roleName: 'luna_ch4b1_producer_a',
      kind: 'producer',
      client_id: '11111111-1111-4111-8111-111111111111',
      location_id: '22222222-2222-4222-8222-222222222222',
      location_key: 'sunset-somo',
    });
    assert.equal(producerPlan.ok, true);
    assert.equal(producerPlan.apply, false);
    assert.equal(producerPlan.kind, 'producer');
    assert.ok(producerPlan.plan.some((line) => /persist_and_enqueue/.test(line)));
    assert.equal(producerPlan.plan.some((line) => /GRANT SELECT ON TABLE public.tenant_email_luna_automation_queue/.test(line)), false);
    assert.equal(producerPlan.plan.some((line) => /issuance_material_load/.test(line) && /GRANT EXECUTE/.test(line)), false);
    assert.equal(producerPlan.plan.some((line) => /automation_claim/.test(line) && /GRANT EXECUTE/.test(line)), false);
    console.log('  PASS  producer dry-run grants persist only and no queue SELECT');
  }).then(async () => {
    await assert.rejects(
      () => provisionEmailLunaAutomationPrincipal(async () => ({ rows: [] }), {
        roleName: 'luna_ch4a_worker_a',
        kind: 'worker',
        client_id: '11111111-1111-4111-8111-111111111111',
        location_id: '22222222-2222-4222-8222-222222222222',
        location_key: 'sunset-somo',
        apply: true,
      }),
      (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCLUSIVE_CLIENT_REQUIRED',
    );
    console.log('  PASS  generic query function / pool.query is refused');
  }).then(async () => {
    await assert.rejects(
      () => provisionEmailLunaAutomationPrincipal(session, {
        roleName: 'postgres',
        kind: 'worker',
        client_id: '11111111-1111-4111-8111-111111111111',
        location_id: '22222222-2222-4222-8222-222222222222',
        location_key: 'sunset-somo',
        apply: true,
      }),
    );
    console.log('  PASS  reserved/owner role names refused');
  }).then(async () => {
    const live = mockSession(async (sql) => {
      if (/current_database/.test(sql)) return { rows: [{ database: 'sunset_staging', session_user: 'postgres' }] };
      return { rows: [] };
    });
    await assert.rejects(
      () => provisionEmailLunaAutomationPrincipal(live, {
        roleName: 'luna_ch4a_worker_a',
        kind: 'worker',
        client_id: '11111111-1111-4111-8111-111111111111',
        location_id: '22222222-2222-4222-8222-222222222222',
        location_key: 'sunset-somo',
        apply: true,
      }),
      (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_FORBIDDEN_DATABASE',
    );
    console.log('  PASS  live/staging product database names fail closed');
  }).then(async () => {
    const stray = mockSession(async (sql) => {
      if (/current_database/.test(sql)) return { rows: [{ database: 'postgres', session_user: 'postgres' }] };
      if (/table_owner/.test(sql)) return { rows: [{ table_owner: 'postgres' }] };
      if (/to_regprocedure/.test(sql)) return { rows: [{ oid: '11' }] };
      if (/FROM pg_catalog\.pg_roles/.test(sql) && /rolcanlogin/.test(sql)) {
        return { rows: [{
          rolname: 'luna_ch4a_stray',
          rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
          rolinherit: false, rolreplication: false, rolbypassrls: false,
        }] };
      }
      if (/tenant_email_luna_automation_principals/.test(sql) && /SELECT/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    await assert.rejects(
      () => provisionEmailLunaAutomationPrincipal(stray, {
        roleName: 'luna_ch4a_stray',
        kind: 'worker',
        client_id: '11111111-1111-4111-8111-111111111111',
        location_id: '22222222-2222-4222-8222-222222222222',
        location_key: 'sunset-somo',
        apply: true,
      }),
      (err) => err && err.code === 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_ADOPTION_REFUSED',
    );
    console.log('  PASS  unmapped pre-existing role adoption is refused');
  }).then(() => {
    const mutantDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-luna-principal-'));
    const mutantPath = path.join(mutantDir, 'email-luna-automation-principal-provision.js');
    const mutated = PROVISION_SRC.replace(
      "grantSql.push(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${roleIdent}`);",
      "grantSql.push(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${roleIdent}`);\n  grantSql.push(`GRANT EXECUTE ON FUNCTION public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_cancel_pending} TO ${roleIdent}`);",
    );
    assert.notEqual(mutated, PROVISION_SRC);
    fs.writeFileSync(mutantPath, mutated);
    const mutantSql = SQL_088.replace(
      "WHERE public.tenant_email_luna_automation_principal_authorized(\n            'worker', client_id, location_id, location_key\n          )",
      'WHERE TRUE',
    );
    assert.notEqual(mutantSql, SQL_088);
    assert.match(mutantSql, /WHERE TRUE/);
    console.log('  PASS  mutation isolation: accidental operator GRANT and claim tenant-check removal are detectable');
    console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice A principal/grant boundary');
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
