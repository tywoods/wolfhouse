'use strict';

/**
 * phase-d-kv-dsn-verify-full-apply — FOUNDATION Slice 14K
 *
 * Activates the merged Slice 14J metadata-preserving sslmode-only Key Vault
 * mutation adapter behind a dedicated exact operator command. Real Node
 * HTTP/HTTPS transport (locked IMDS GET → current-secret GET → one PUT →
 * verification GET) is constructed only after gates pass and only when no
 * httpRequest inject is supplied. Default / missing / wrong gates → zero HTTP
 * / zero writes. Rollback remains separately hard-disabled.
 *
 * This slice proves offline with injected transport + child CLI only — it does
 * not execute live IMDS / Key Vault / PostgreSQL calls.
 */

const {
  TARGETS,
  ENV_SUBSCRIPTION,
  redactDeep,
} = require('./phase-d-live-readonly-boundary');
const {
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED,
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED,
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_HTTP_ENABLED,
  DSN_PLAN_LOCKS,
  KEY_VAULT_RESOURCE_ID,
  LOCKED_MUTATION_PLAN,
  executeDsnNormalizeAdapter,
  executeDsnRollbackAdapter,
  resolveDsnNormalizeHttpRequest,
  createLiveDsnNormalizeHttpRequest,
  assertLockedDsnNormalizeLiveRequest,
  getDsnPlanCounters,
  resetDsnPlanCounters,
  sanitizePlanError,
} = require('./phase-d-kv-dsn-verify-full-plan');
const {
  MI_LOADER_LOCKS,
} = require('./phase-d-managed-identity-credential-loader');

const ENV_DSN_APPLY = 'SUNSET_PHASE_D_KV_DSN_VERIFY_FULL_APPLY';
const CLI_APPLY_VERIFY_FULL = '--apply-verify-full';

/** Locked confirmation targets for the apply CLI (includes Lunabox VM identity). */
const DSN_APPLY_LOCKS = Object.freeze({
  subscriptionId: DSN_PLAN_LOCKS.subscriptionId,
  resourceGroup: DSN_PLAN_LOCKS.resourceGroup,
  vmResourceGroup: 'wh-staging-rg',
  vmName: 'lunabox',
  managedIdentityName: DSN_PLAN_LOCKS.managedIdentityName,
  managedIdentityClientId: DSN_PLAN_LOCKS.managedIdentityClientId,
  keyVaultName: DSN_PLAN_LOCKS.keyVaultName,
  keyVaultResourceId: KEY_VAULT_RESOURCE_ID,
  secretName: DSN_PLAN_LOCKS.secretName,
  postgresServer: DSN_PLAN_LOCKS.postgresServer,
  postgresHost: DSN_PLAN_LOCKS.postgresHost,
  database: DSN_PLAN_LOCKS.database,
  port: DSN_PLAN_LOCKS.port,
  targetSslmode: DSN_PLAN_LOCKS.targetSslmode,
  lunaboxVmResourceId: MI_LOADER_LOCKS.lunaboxVmResourceId,
});

const FORBIDDEN_ARGV_FLAGS = Object.freeze([
  '--plan-only',
  '--rollback-plan-only',
  '--rollback',
  '--apply',
  '--deploy',
  '--mutate',
  '--execute',
  '--live',
  '--value',
  '--secret-value',
  '--dsn',
  '--connection-string',
  '--database-url',
  '--url',
  '--token',
  '--access-token',
  '--version',
  '--secret-version',
  '--prior-version-id',
  '--file',
  '--host',
  '--user',
  '--username',
  '--password',
  '--delete',
  '--purge',
  '--disable',
  '--content-type',
  '--tags',
  '--retry',
  '--retries',
  '--force',
  '--what-if',
  '--whatif',
  '--body',
  '--imds-url',
  '--vault-url',
  '--key-vault-url',
]);

const ALLOWED_ARGV_FLAGS = Object.freeze([
  CLI_APPLY_VERIFY_FULL,
  '--subscription',
  '--resource-group',
  '--vm-resource-group',
  '--vm-name',
  '--managed-identity',
  '--key-vault',
  '--secret-name',
  '--postgres-server',
  '--database',
  '--help',
  '-h',
]);

const SAFE_OUTPUT_KEYS = Object.freeze([
  'ok',
  'code',
  'applyVerifyFull',
  'liveMutateEnabled',
  'liveHttpEnabled',
  'liveRollbackEnabled',
  'liveMutation',
  'usedLiveHttp',
  'realImdsCall',
  'realKeyVaultCall',
  'realPostgresCall',
  'kvWriteCount',
  'kvPutCount',
  'httpRequestCount',
  'imdsRequestCount',
  'keyVaultGetCount',
  'keyVaultPutCount',
  'putCount',
  'retries',
  'httpSequence',
  'subscriptionId',
  'resourceGroup',
  'vmResourceGroup',
  'vmName',
  'keyVaultName',
  'keyVaultResourceId',
  'secretName',
  'managedIdentityName',
  'managedIdentityClientId',
  'postgresHost',
  'postgresServer',
  'database',
  'port',
  'targetSslmode',
  'mutationField',
  'sourceTlsDeficient',
  'sslmodeNormalized',
  'metadataPreserved',
  'priorSecretVersionId',
  'newSecretVersionId',
  'errors',
  'message',
  'note',
  'privateRefsZeroed',
  'pgClientInstantiated',
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
    if (flag === CLI_APPLY_VERIFY_FULL || flag === '--help' || flag === '-h') {
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

function evaluateDsnApplyEnvApproval(env) {
  const e = env || {};
  const errors = [];
  if (String(e[ENV_DSN_APPLY] || '').trim() !== '1') {
    errors.push({
      code: 'apply_env_required',
      message: `env ${ENV_DSN_APPLY}=1 is required`,
    });
  }
  if (String(e[ENV_SUBSCRIPTION] || '').trim() !== DSN_APPLY_LOCKS.subscriptionId) {
    errors.push({
      code: 'wrong_subscription_env',
      message: `env ${ENV_SUBSCRIPTION} must be exactly ${DSN_APPLY_LOCKS.subscriptionId}`,
    });
  }
  // Reject credential / DSN / token env smuggling.
  const forbiddenEnv = [
    'SUNSET_STAGING_PG_ADMIN_USER',
    'SUNSET_STAGING_PG_ADMIN_PASSWORD',
    'DATABASE_URL',
    'PGPASSWORD',
    'AZURE_CLIENT_SECRET',
  ];
  for (const key of forbiddenEnv) {
    if (e[key] != null && String(e[key]) !== '') {
      errors.push({
        code: 'forbidden_credential_env',
        message: `env ${key} must not be set for apply path`,
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

function evaluateDsnApplyExactTargets(argv) {
  const parsed = parseArgvPairs(argv);
  const errors = [];

  if (parsed.forbidden.length > 0) {
    errors.push({
      code: 'forbidden_argv',
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
  if (!parsed.flags.has(CLI_APPLY_VERIFY_FULL)) {
    errors.push({
      code: 'apply_flag_required',
      message: `${CLI_APPLY_VERIFY_FULL} is required`,
    });
  }

  const checks = [
    ['--subscription', DSN_APPLY_LOCKS.subscriptionId, 'wrong_subscription'],
    ['--resource-group', DSN_APPLY_LOCKS.resourceGroup, 'wrong_resource_group'],
    ['--vm-resource-group', DSN_APPLY_LOCKS.vmResourceGroup, 'wrong_vm_resource_group'],
    ['--vm-name', DSN_APPLY_LOCKS.vmName, 'wrong_vm_name'],
    ['--managed-identity', DSN_APPLY_LOCKS.managedIdentityName, 'wrong_managed_identity'],
    ['--key-vault', DSN_APPLY_LOCKS.keyVaultName, 'wrong_key_vault'],
    ['--secret-name', DSN_APPLY_LOCKS.secretName, 'wrong_secret_name'],
    ['--postgres-server', DSN_APPLY_LOCKS.postgresServer, 'wrong_postgres_server'],
    ['--database', DSN_APPLY_LOCKS.database, 'wrong_database'],
  ];
  for (const [flag, expected, code] of checks) {
    const got = parsed.values[flag];
    if (got !== expected) {
      errors.push({
        code,
        message: `${flag} must be exactly ${expected}`,
        got: got == null ? null : String(got),
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    parsed,
    confirmed: errors.length === 0 ? { ...DSN_APPLY_LOCKS } : null,
  };
}

/**
 * Full apply gate stack before any HTTP / adapter invocation.
 */
function evaluateDsnApplyGates(opts) {
  const options = opts || {};
  const env = options.env || {};
  const argv = options.argv || [];

  const envGate = evaluateDsnApplyEnvApproval(env);
  const exact = evaluateDsnApplyExactTargets(argv);
  const errors = [];
  if (!envGate.ok) errors.push(...envGate.errors);
  if (!exact.ok) errors.push(...exact.errors);

  if (PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED === true) {
    errors.push({
      code: 'live_rollback_must_stay_disabled',
      message: 'Slice 14K keeps live rollback hard-disabled',
    });
  }

  return redactDeep({
    ok: errors.length === 0,
    code: errors.length === 0 ? 'dsn_apply_gates_ok' : 'dsn_apply_gates_rejected',
    errors,
    applyVerifyFull: exact.parsed && exact.parsed.flags.has(CLI_APPLY_VERIFY_FULL),
    envOk: envGate.ok,
    exactTargetOk: exact.ok,
    confirmed: exact.confirmed,
    liveMutateEnabled: PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED === true,
    liveHttpEnabled: PHASE_D_KV_DSN_VERIFY_FULL_LIVE_HTTP_ENABLED === true,
    liveRollbackEnabled: PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED === true,
    liveMutation: false,
    defaultEnabled: false,
    kvWriteCount: getDsnPlanCounters().kvWriteCount,
    httpRequestCount: getDsnPlanCounters().httpRequestCount,
    pgClientInstantiated: getDsnPlanCounters().pgClientInstantiated,
  }, []);
}

function pickSafeApplyOutput(obj) {
  const out = {};
  const src = obj && typeof obj === 'object' ? obj : {};
  for (const k of SAFE_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  }
  return out;
}

function buildApplySafeOutput(parts) {
  const p = parts || {};
  const usedLiveHttp = p.usedLiveHttp === true;
  return pickSafeApplyOutput({
    ok: p.ok === true,
    code: p.code || (p.ok ? 'dsn_verify_full_apply_ok' : 'dsn_verify_full_apply_failed'),
    applyVerifyFull: p.applyVerifyFull === true,
    liveMutateEnabled: PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED === true,
    liveHttpEnabled: PHASE_D_KV_DSN_VERIFY_FULL_LIVE_HTTP_ENABLED === true,
    liveRollbackEnabled: false,
    liveMutation: p.liveMutation === true,
    usedLiveHttp,
    realImdsCall: usedLiveHttp && p.ok !== false ? Boolean(p.realImdsCall) : false,
    realKeyVaultCall: usedLiveHttp && p.ok !== false ? Boolean(p.realKeyVaultCall) : false,
    realPostgresCall: false,
    kvWriteCount: Number(p.kvWriteCount) || 0,
    kvPutCount: Number(p.kvPutCount) || 0,
    httpRequestCount: Number(p.httpRequestCount) || 0,
    imdsRequestCount: Number(p.imdsRequestCount) || 0,
    keyVaultGetCount: Number(p.keyVaultGetCount) || 0,
    keyVaultPutCount: Number(p.keyVaultPutCount) || 0,
    putCount: p.putCount != null ? Number(p.putCount) : undefined,
    retries: 0,
    httpSequence: p.httpSequence || [...LOCKED_MUTATION_PLAN.httpSequence],
    subscriptionId: DSN_APPLY_LOCKS.subscriptionId,
    resourceGroup: DSN_APPLY_LOCKS.resourceGroup,
    vmResourceGroup: DSN_APPLY_LOCKS.vmResourceGroup,
    vmName: DSN_APPLY_LOCKS.vmName,
    keyVaultName: DSN_APPLY_LOCKS.keyVaultName,
    keyVaultResourceId: DSN_APPLY_LOCKS.keyVaultResourceId,
    secretName: DSN_APPLY_LOCKS.secretName,
    managedIdentityName: DSN_APPLY_LOCKS.managedIdentityName,
    managedIdentityClientId: DSN_APPLY_LOCKS.managedIdentityClientId,
    postgresHost: DSN_APPLY_LOCKS.postgresHost,
    postgresServer: DSN_APPLY_LOCKS.postgresServer,
    database: DSN_APPLY_LOCKS.database,
    port: DSN_APPLY_LOCKS.port,
    targetSslmode: DSN_APPLY_LOCKS.targetSslmode,
    mutationField: 'sslmode',
    sourceTlsDeficient: p.sourceTlsDeficient === true,
    sslmodeNormalized: p.sslmodeNormalized === true,
    metadataPreserved: p.metadataPreserved === true,
    priorSecretVersionId: p.priorSecretVersionId || null,
    newSecretVersionId: p.newSecretVersionId || null,
    errors: p.errors || undefined,
    message: p.message || undefined,
    note: p.note || undefined,
    privateRefsZeroed: p.privateRefsZeroed === true,
    pgClientInstantiated: Number(p.pgClientInstantiated) || 0,
  });
}

/**
 * Execute gated apply: invoke reviewed 14J adapter with inject or locked live HTTP.
 * Rollback path is refused. Default/wrong gates → zero HTTP/writes.
 */
async function executeDsnVerifyFullApply(opts) {
  const options = opts || {};
  const countersBefore = getDsnPlanCounters();

  const gates = evaluateDsnApplyGates({
    env: options.env,
    argv: options.argv,
  });
  if (!gates.ok) {
    return buildApplySafeOutput({
      ok: false,
      code: 'dsn_apply_gates_rejected',
      applyVerifyFull: gates.applyVerifyFull === true,
      errors: gates.errors,
      message: 'DSN verify-full apply gates rejected — zero HTTP / zero KV writes',
      kvWriteCount: 0,
      kvPutCount: 0,
      httpRequestCount: 0,
      imdsRequestCount: 0,
      keyVaultGetCount: 0,
      keyVaultPutCount: 0,
      usedLiveHttp: false,
      liveMutation: false,
      note: 'gates failed — zero HTTP / zero writes',
      privateRefsZeroed: true,
      pgClientInstantiated: 0,
    });
  }

  // Hard-refuse rollback on the apply command.
  if (options.rollback === true
    || (Array.isArray(options.argv) && options.argv.includes('--rollback'))) {
    return buildApplySafeOutput({
      ok: false,
      code: 'live_rollback_disabled',
      applyVerifyFull: true,
      errors: [{ code: 'live_rollback_disabled', message: 'rollback separately hard-disabled' }],
      message: 'rollback separately hard-disabled — zero writes',
      usedLiveHttp: false,
      liveMutation: false,
      privateRefsZeroed: true,
    });
  }

  const resolved = resolveDsnNormalizeHttpRequest({
    httpRequest: options.httpRequest,
  });
  if (typeof resolved.httpRequest !== 'function') {
    return buildApplySafeOutput({
      ok: false,
      code: 'http_request_required',
      applyVerifyFull: true,
      errors: [{
        code: 'http_request_required',
        message: 'httpRequest required (inject offline; live HTTP flag off)',
      }],
      message: 'no HTTP transport — zero writes',
      usedLiveHttp: false,
      liveMutation: false,
      privateRefsZeroed: true,
    });
  }

  let adapterResult;
  try {
    adapterResult = await executeDsnNormalizeAdapter({
      httpRequest: resolved.httpRequest,
    });
  } catch (err) {
    const safe = sanitizePlanError(err, []);
    const counters = getDsnPlanCounters();
    return buildApplySafeOutput({
      ok: false,
      code: safe.code || 'dsn_verify_full_apply_failed',
      applyVerifyFull: true,
      errors: [{ code: safe.code, message: safe.message }],
      message: safe.message,
      usedLiveHttp: resolved.usedLiveHttp,
      realImdsCall: false,
      realKeyVaultCall: false,
      liveMutation: false,
      kvWriteCount: counters.kvWriteCount - countersBefore.kvWriteCount,
      kvPutCount: counters.keyVaultPutCount - countersBefore.keyVaultPutCount,
      httpRequestCount: counters.httpRequestCount - countersBefore.httpRequestCount,
      imdsRequestCount: counters.imdsRequestCount - countersBefore.imdsRequestCount,
      keyVaultGetCount: counters.keyVaultGetCount - countersBefore.keyVaultGetCount,
      keyVaultPutCount: counters.keyVaultPutCount - countersBefore.keyVaultPutCount,
      privateRefsZeroed: true,
      pgClientInstantiated: counters.pgClientInstantiated,
    });
  }

  const counters = getDsnPlanCounters();
  const deltaPut = counters.keyVaultPutCount - countersBefore.keyVaultPutCount;
  const deltaHttp = counters.httpRequestCount - countersBefore.httpRequestCount;
  const ok = adapterResult && adapterResult.ok === true;

  return buildApplySafeOutput({
    ok,
    code: ok ? 'dsn_verify_full_apply_ok' : (adapterResult && adapterResult.code) || 'dsn_verify_full_apply_failed',
    applyVerifyFull: true,
    errors: adapterResult && adapterResult.errors,
    message: adapterResult && adapterResult.message,
    usedLiveHttp: resolved.usedLiveHttp,
    realImdsCall: resolved.usedLiveHttp === true && deltaHttp > 0,
    realKeyVaultCall: resolved.usedLiveHttp === true && deltaHttp > 1,
    liveMutation: resolved.usedLiveHttp === true && ok === true && deltaPut === 1,
    sourceTlsDeficient: adapterResult && adapterResult.sourceTlsDeficient,
    sslmodeNormalized: adapterResult && adapterResult.sslmodeNormalized,
    metadataPreserved: adapterResult && adapterResult.metadataPreserved,
    priorSecretVersionId: adapterResult && adapterResult.priorSecretVersionId,
    newSecretVersionId: adapterResult && adapterResult.newSecretVersionId,
    putCount: adapterResult && adapterResult.putCount,
    httpSequence: adapterResult && adapterResult.httpSequence,
    kvWriteCount: counters.kvWriteCount - countersBefore.kvWriteCount,
    kvPutCount: deltaPut,
    httpRequestCount: deltaHttp,
    imdsRequestCount: counters.imdsRequestCount - countersBefore.imdsRequestCount,
    keyVaultGetCount: counters.keyVaultGetCount - countersBefore.keyVaultGetCount,
    keyVaultPutCount: deltaPut,
    privateRefsZeroed: true,
    pgClientInstantiated: counters.pgClientInstantiated,
    note: resolved.usedLiveHttp
      ? 'gated live HTTP apply path'
      : 'offline injected-HTTP apply proof — no live IMDS/KV',
  });
}

/**
 * Rollback via apply module is always refused (separate hard-disable).
 */
async function executeDsnVerifyFullApplyRollback() {
  return buildApplySafeOutput({
    ok: false,
    code: 'live_rollback_disabled',
    applyVerifyFull: false,
    errors: [{ code: 'live_rollback_disabled', message: 'rollback separately hard-disabled' }],
    message: 'rollback separately hard-disabled — zero writes',
    usedLiveHttp: false,
    liveMutation: false,
    privateRefsZeroed: true,
    note: 'Slice 14K keeps rollback hard-disabled',
  });
}

function exactDsnApplyArgv(extraFlags) {
  return [
    CLI_APPLY_VERIFY_FULL,
    '--subscription', DSN_APPLY_LOCKS.subscriptionId,
    '--resource-group', DSN_APPLY_LOCKS.resourceGroup,
    '--vm-resource-group', DSN_APPLY_LOCKS.vmResourceGroup,
    '--vm-name', DSN_APPLY_LOCKS.vmName,
    '--managed-identity', DSN_APPLY_LOCKS.managedIdentityName,
    '--key-vault', DSN_APPLY_LOCKS.keyVaultName,
    '--secret-name', DSN_APPLY_LOCKS.secretName,
    '--postgres-server', DSN_APPLY_LOCKS.postgresServer,
    '--database', DSN_APPLY_LOCKS.database,
    ...(extraFlags || []),
  ];
}

function dsnApplyEnv(base = {}) {
  return {
    ...base,
    [ENV_DSN_APPLY]: '1',
    [ENV_SUBSCRIPTION]: DSN_APPLY_LOCKS.subscriptionId,
  };
}

function renderDsnApplyUsage() {
  return [
    'Phase D Key Vault DSN sslmode=verify-full apply (FOUNDATION Slice 14K)',
    '',
    'DEFAULT: refused (zero HTTP / zero KV writes).',
    'Activates the reviewed 14J metadata-preserving sslmode-only mutation adapter',
    'behind exact env + --apply-verify-full + subscription/RG/VM/identity/vault/PG flags.',
    '',
    'Required:',
    `  ${ENV_DSN_APPLY}=1`,
    `  ${ENV_SUBSCRIPTION}=${DSN_APPLY_LOCKS.subscriptionId}`,
    `  ${CLI_APPLY_VERIFY_FULL}`,
    `  --subscription ${DSN_APPLY_LOCKS.subscriptionId}`,
    `  --resource-group ${DSN_APPLY_LOCKS.resourceGroup}`,
    `  --vm-resource-group ${DSN_APPLY_LOCKS.vmResourceGroup}`,
    `  --vm-name ${DSN_APPLY_LOCKS.vmName}`,
    `  --managed-identity ${DSN_APPLY_LOCKS.managedIdentityName}`,
    `  --key-vault ${DSN_APPLY_LOCKS.keyVaultName}`,
    `  --secret-name ${DSN_APPLY_LOCKS.secretName}`,
    `  --postgres-server ${DSN_APPLY_LOCKS.postgresServer}`,
    `  --database ${DSN_APPLY_LOCKS.database}`,
    '',
    'HTTP sequence on success: IMDS GET → KV GET → one PUT → verification GET.',
    'Redirects / host/path/method/body deviations / retries rejected.',
    'Rollback separately hard-disabled. Output: safe IDs/timestamps/counters only.',
    'Forbidden: --value --dsn --url --token --file --body --host --user --password',
    '--prior-version-id --rollback --retry --delete --purge',
  ].join('\n');
}

function renderFailClosedDsnApplyCatch(err) {
  const safe = sanitizePlanError(err, []);
  return pickSafeApplyOutput({
    ok: false,
    code: 'cli_failed',
    applyVerifyFull: false,
    liveMutateEnabled: PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED === true,
    liveHttpEnabled: PHASE_D_KV_DSN_VERIFY_FULL_LIVE_HTTP_ENABLED === true,
    liveRollbackEnabled: false,
    liveMutation: false,
    usedLiveHttp: false,
    realImdsCall: false,
    realKeyVaultCall: false,
    realPostgresCall: false,
    kvWriteCount: getDsnPlanCounters().kvWriteCount,
    httpRequestCount: getDsnPlanCounters().httpRequestCount,
    errors: [{ code: safe.code, message: safe.message }],
    message: safe.message,
    privateRefsZeroed: true,
    pgClientInstantiated: getDsnPlanCounters().pgClientInstantiated,
    note: 'fail-closed catch — sanitized',
  });
}

module.exports = {
  ENV_DSN_APPLY,
  CLI_APPLY_VERIFY_FULL,
  DSN_APPLY_LOCKS,
  FORBIDDEN_ARGV_FLAGS,
  ALLOWED_ARGV_FLAGS,
  SAFE_OUTPUT_KEYS,
  evaluateDsnApplyEnvApproval,
  evaluateDsnApplyExactTargets,
  evaluateDsnApplyGates,
  executeDsnVerifyFullApply,
  executeDsnVerifyFullApplyRollback,
  exactDsnApplyArgv,
  dsnApplyEnv,
  renderDsnApplyUsage,
  renderFailClosedDsnApplyCatch,
  pickSafeApplyOutput,
  buildApplySafeOutput,
  createLiveDsnNormalizeHttpRequest,
  resolveDsnNormalizeHttpRequest,
  assertLockedDsnNormalizeLiveRequest,
  executeDsnNormalizeAdapter,
  executeDsnRollbackAdapter,
  getDsnPlanCounters,
  resetDsnPlanCounters,
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED,
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED,
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_HTTP_ENABLED,
  TARGETS,
};
