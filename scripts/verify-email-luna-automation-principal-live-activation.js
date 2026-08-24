'use strict';
/** FULL SAIL Stage 1 NIGHTWATCH Chapter 4 Slice C1: Sunset staging live-principal activation. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT,
  FORBIDDEN_DATABASE_NAMES,
  SUNSET_STAGING_TRUSTED_PRECREATED,
} = require('./lib/email-luna-automation-principal-contract');
const {
  provisionEmailLunaAutomationPrincipal,
  IDENTITY_SQL,
} = require('./lib/email-luna-automation-principal-provision');

const ROOT = path.join(__dirname, '..');
const RED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-principal-live-activation-red.json'),
  'utf8',
));
const CONTRACT_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-principal-contract'), 'utf8');
const PROVISION_SRC = fs.readFileSync(require.resolve('./lib/email-luna-automation-principal-provision'), 'utf8');

const CLIENT = '11111111-1111-4111-8111-111111111111';
const LOCATION = '22222222-2222-4222-8222-222222222222';
const PASSWORD = `${'Nw'.repeat(20)}ab`;

console.log('FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice C1 live-principal activation verifier');

assert.equal(RED.id, 'email-luna-automation-principal-live-activation.ch4c1-red.v1');
assert.equal(RED.slice, 'FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice C1');
assert.equal(RED.head_reviewed, 'a804f394e1f240ba996ca442d0d4a159f9fd86aa');
assert.equal(RED.pr_reviewed, 708);
assert.equal(RED.runtime_activation, false);
assert.equal(RED.activation_authorized, false);
assert.equal(RED.create_role, false);
assert.equal(RED.password_transport, false);
assert.equal(RED.env_overlay, false);
assert.equal(RED.findings.length, 2);
assert.ok(RED.findings.every((row) => row.severity === 'blocking' && row.red && row.green));
assert.equal(RED.findings[0].id, 'sunset-staging-unconditional-refuse');
assert.equal(RED.findings[1].id, 'option-alone-or-partial-conjuncts');
assert.equal(JSON.stringify(RED).includes(PASSWORD), false);
console.log('  PASS  authentic RED artifact records the live sunset_staging refusal');

assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.allow_sunset_staging_trusted_precreated_default, false);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.default_off, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.runtime_wired, false);
assert.deepEqual(FORBIDDEN_DATABASE_NAMES.slice(), [
  'sunset_staging', 'sunset_prod', 'wolfhouse_staging', 'wolfhouse_prod', 'luna_prod',
]);
assert.equal(SUNSET_STAGING_TRUSTED_PRECREATED.option, 'allowSunsetStagingTrustedPrecreated');
assert.equal(SUNSET_STAGING_TRUSTED_PRECREATED.database, 'sunset_staging');
assert.equal(SUNSET_STAGING_TRUSTED_PRECREATED.kind, 'worker');
assert.equal(SUNSET_STAGING_TRUSTED_PRECREATED.location_key, 'sunset-somo');
assert.equal(SUNSET_STAGING_TRUSTED_PRECREATED.require_trusted_precreated, true);
assert.equal(SUNSET_STAGING_TRUSTED_PRECREATED.require_apply, true);
assert.equal(SUNSET_STAGING_TRUSTED_PRECREATED.require_password_absent, true);
assert.equal(SUNSET_STAGING_TRUSTED_PRECREATED.require_session_user_is_queue_owner, true);
assert.equal(SUNSET_STAGING_TRUSTED_PRECREATED.never_create_role, true);
assert.equal(SUNSET_STAGING_TRUSTED_PRECREATED.never_set_password, true);
assert.equal(SUNSET_STAGING_TRUSTED_PRECREATED.no_env_overlay, true);
assert.equal(SUNSET_STAGING_TRUSTED_PRECREATED.caller_supplies_client_location_uuids, true);
assert.equal(
  EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.sunset_staging_trusted_precreated,
  SUNSET_STAGING_TRUSTED_PRECREATED,
);
console.log('  PASS  contract default-refuses sunset_staging and pins the explicit option');

assert.equal(/process\.env/.test(PROVISION_SRC), false);
assert.equal(/process\.env/.test(CONTRACT_SRC), false);
assert.match(PROVISION_SRC, /allowSunsetStagingTrustedPrecreated === true/);
assert.equal(/allowSunsetStagingTrustedPrecreated\s*==\s*'true'/.test(PROVISION_SRC), false);
assert.equal(/EMAIL_LUNA_AUTOMATION_SHADOW_CLIENT_ID/.test(PROVISION_SRC), false);
assert.match(PROVISION_SRC, /IDENTITY_SQL/);
assert.equal(IDENTITY_SQL, 'SELECT current_database() AS database, session_user AS session_user');
assert.match(PROVISION_SRC, /EMAIL_LUNA_AUTOMATION_PRINCIPAL_SESSION_NOT_OWNER/);
assert.match(PROVISION_SRC, /EMAIL_LUNA_AUTOMATION_PRINCIPAL_ROLE_CREATE_REFUSED/);
assert.match(PROVISION_SRC, /database !== SUNSET_STAGING_TRUSTED_PRECREATED\.database/);
assert.match(PROVISION_SRC, /sessionUser !== tableOwner/);
assert.equal(/CREATE ROLE[\s\S]{0,200}allowSunsetStagingTrustedPrecreated/.test(PROVISION_SRC), false);
console.log('  PASS  provisioner is env-free and fail-closed on the Sunset option');

function dummySession() {
  return {
    async connect() {
      throw new Error('connect must not run for spec-level refusal');
    },
  };
}

function mockSession(handler) {
  return {
    async connect() {
      return {
        async query(sql, params, extra) {
          if (extra !== undefined) {
            throw Object.assign(new Error('secret option must not be used'), {
              code: 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_PASSWORD_REFUSED',
            });
          }
          const text = String(sql);
          if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(text)) return { rows: [] };
          return handler(text, params || []);
        },
        async release() {},
      };
    },
  };
}

function baseSpec(overrides) {
  return Object.assign({
    roleName: 'luna_ch4c1_pre_worker',
    kind: 'worker',
    client_id: CLIENT,
    location_id: LOCATION,
    location_key: 'sunset-somo',
  }, overrides);
}

function loginRow(patch) {
  return Object.assign({
    rolname: 'luna_ch4c1_pre_worker',
    rolcanlogin: true,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolinherit: false,
    rolreplication: false,
    rolbypassrls: false,
  }, patch);
}

function identityHandler(database, sessionUser, extra) {
  return async (sql) => {
    if (/current_database/.test(sql)) return { rows: [{ database, session_user: sessionUser }] };
    if (/table_owner/.test(sql)) return { rows: [{ table_owner: 'postgres' }] };
    if (typeof extra === 'function') return extra(sql);
    return { rows: [] };
  };
}

async function rejects(spec, session, code) {
  await assert.rejects(
    () => provisionEmailLunaAutomationPrincipal(session || dummySession(), spec),
    (err) => err && err.code === code,
  );
}

Promise.resolve().then(async () => {
  await rejects(baseSpec({
    allowSunsetStagingTrustedPrecreated: true,
    apply: true,
  }), dummySession(), 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID');
  console.log('  PASS  option alone without trustedPrecreated fails closed');

  await rejects(baseSpec({
    allowSunsetStagingTrustedPrecreated: true,
    trustedPrecreated: true,
  }), dummySession(), 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID');
  console.log('  PASS  option without apply fails closed');

  await rejects(baseSpec({
    allowSunsetStagingTrustedPrecreated: true,
    trustedPrecreated: true,
    apply: true,
    password: PASSWORD,
  }), dummySession(), 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_PASSWORD_REFUSED');
  console.log('  PASS  option with password fails closed');

  await rejects(baseSpec({
    allowSunsetStagingTrustedPrecreated: true,
    trustedPrecreated: true,
    apply: true,
    kind: 'operator',
  }), dummySession(), 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID');
  await rejects(baseSpec({
    allowSunsetStagingTrustedPrecreated: true,
    trustedPrecreated: true,
    apply: true,
    kind: 'producer',
  }), dummySession(), 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID');
  console.log('  PASS  option with non-worker kind fails closed');

  await rejects(baseSpec({
    allowSunsetStagingTrustedPrecreated: true,
    trustedPrecreated: true,
    apply: true,
    location_key: 'sunset-sardinero',
  }), dummySession(), 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID');
  console.log('  PASS  option with non-approved location_key fails closed');

  const envKeys = [
    'allowSunsetStagingTrustedPrecreated',
    'EMAIL_LUNA_AUTOMATION_ALLOW_SUNSET_STAGING_TRUSTED_PRECREATED',
    'EMAIL_LUNA_AUTOMATION_SHADOW_CLIENT_ID',
    'EMAIL_LUNA_AUTOMATION_SHADOW_LOCATION_ID',
  ];
  const previous = {};
  for (const key of envKeys) previous[key] = process.env[key];
  try {
    process.env.allowSunsetStagingTrustedPrecreated = 'true';
    process.env.EMAIL_LUNA_AUTOMATION_ALLOW_SUNSET_STAGING_TRUSTED_PRECREATED = 'true';
    process.env.EMAIL_LUNA_AUTOMATION_SHADOW_CLIENT_ID = CLIENT;
    process.env.EMAIL_LUNA_AUTOMATION_SHADOW_LOCATION_ID = LOCATION;
    await rejects(
      baseSpec({ trustedPrecreated: true, apply: true }),
      mockSession(identityHandler('sunset_staging', 'postgres')),
      'EMAIL_LUNA_AUTOMATION_PRINCIPAL_FORBIDDEN_DATABASE',
    );
    await rejects(
      baseSpec({
        allowSunsetStagingTrustedPrecreated: 'true',
        trustedPrecreated: true,
        apply: true,
      }),
      mockSession(identityHandler('sunset_staging', 'postgres')),
      'EMAIL_LUNA_AUTOMATION_PRINCIPAL_FORBIDDEN_DATABASE',
    );
  } finally {
    for (const key of envKeys) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
  console.log('  PASS  env overlays and string true do not enable sunset_staging');

  for (const database of ['sunset_staging', 'sunset_prod', 'wolfhouse_staging', 'wolfhouse_prod', 'luna_prod']) {
    await rejects(
      baseSpec({ trustedPrecreated: true, apply: true }),
      mockSession(identityHandler(database, 'postgres')),
      'EMAIL_LUNA_AUTOMATION_PRINCIPAL_FORBIDDEN_DATABASE',
    );
  }
  console.log('  PASS  default trustedPrecreated still refuses every product/staging database');

  for (const database of ['postgres', 'sunset_prod', 'wolfhouse_staging', 'wolfhouse_prod', 'luna_prod', 'other_db']) {
    await rejects(
      baseSpec({
        allowSunsetStagingTrustedPrecreated: true,
        trustedPrecreated: true,
        apply: true,
      }),
      mockSession(identityHandler(database, 'postgres')),
      'EMAIL_LUNA_AUTOMATION_PRINCIPAL_FORBIDDEN_DATABASE',
    );
  }
  console.log('  PASS  option on non-sunset_staging databases fails closed');

  await rejects(
    baseSpec({
      allowSunsetStagingTrustedPrecreated: true,
      trustedPrecreated: true,
      apply: true,
    }),
    mockSession(identityHandler('sunset_staging', 'luna_ch4c1_not_owner')),
    'EMAIL_LUNA_AUTOMATION_PRINCIPAL_SESSION_NOT_OWNER',
  );
  console.log('  PASS  non-owner session_user fails closed');

  function sunsetOwnerHandler(extra) {
    return async (sql) => {
      if (/current_database/.test(sql)) {
        return { rows: [{ database: 'sunset_staging', session_user: 'postgres' }] };
      }
      if (/table_owner/.test(sql)) return { rows: [{ table_owner: 'postgres' }] };
      if (/FROM public.tenant_locations/.test(sql)) return { rows: [{ ok: 1 }] };
      if (typeof extra === 'function') return extra(sql);
      return { rows: [] };
    };
  }

  await rejects(
    baseSpec({
      allowSunsetStagingTrustedPrecreated: true,
      trustedPrecreated: true,
      apply: true,
      location_id: '22222222-2222-4222-8222-222222222221',
    }),
    mockSession(async (sql) => {
      if (/current_database/.test(sql)) {
        return { rows: [{ database: 'sunset_staging', session_user: 'postgres' }] };
      }
      if (/table_owner/.test(sql)) return { rows: [{ table_owner: 'postgres' }] };
      if (/FROM public.tenant_locations/.test(sql)) return { rows: [] };
      return { rows: [] };
    }),
    'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID',
  );
  console.log('  PASS  caller binding that is not the durable sunset-somo row fails closed');

  await rejects(
    baseSpec({
      allowSunsetStagingTrustedPrecreated: true,
      trustedPrecreated: true,
      apply: true,
    }),
    mockSession(sunsetOwnerHandler(async (sql) => {
      if (/to_regprocedure/.test(sql)) return { rows: [{ oid: '11' }] };
      if (/FROM pg_catalog\.pg_roles/.test(sql) && /rolcanlogin/.test(sql)) return { rows: [] };
      if (/tenant_email_luna_automation_principals/.test(sql) && /SELECT/.test(sql)) return { rows: [] };
      return { rows: [] };
    })),
    'EMAIL_LUNA_AUTOMATION_PRINCIPAL_ROLE_MISSING',
  );
  console.log('  PASS  missing role / create-role path fails closed');

  await rejects(
    baseSpec({
      allowSunsetStagingTrustedPrecreated: true,
      trustedPrecreated: true,
      apply: true,
    }),
    mockSession(sunsetOwnerHandler(async (sql) => {
      if (/to_regprocedure/.test(sql)) return { rows: [{ oid: '11' }] };
      if (/FROM pg_catalog\.pg_roles/.test(sql) && /rolcanlogin/.test(sql)) {
        return { rows: [loginRow({ rolinherit: true })] };
      }
      if (/tenant_email_luna_automation_principals/.test(sql) && /SELECT/.test(sql)) return { rows: [] };
      return { rows: [] };
    })),
    'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INCONSISTENT_ROLE',
  );
  console.log('  PASS  wrong LOGIN attributes fail closed');

  await rejects(
    baseSpec({
      allowSunsetStagingTrustedPrecreated: true,
      trustedPrecreated: true,
      apply: true,
    }),
    mockSession(sunsetOwnerHandler(async (sql) => {
      if (/to_regprocedure/.test(sql)) return { rows: [{ oid: '11' }] };
      if (/FROM pg_catalog\.pg_roles/.test(sql) && /rolcanlogin/.test(sql)) {
        return { rows: [loginRow()] };
      }
      if (/tenant_email_luna_automation_principals/.test(sql) && /SELECT/.test(sql)) {
        return { rows: [{
          role_name: 'luna_ch4c1_pre_worker',
          principal_kind: 'operator',
          client_id: CLIENT,
          location_id: LOCATION,
          location_key: 'sunset-somo',
        }] };
      }
      return { rows: [] };
    })),
    'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INCONSISTENT_MAPPING',
  );
  console.log('  PASS  existing wrong mapping fails closed');

  console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice C1 live-principal activation');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
