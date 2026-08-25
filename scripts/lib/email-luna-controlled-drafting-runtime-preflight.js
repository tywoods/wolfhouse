'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4A.
 *
 * Read-only Sunset staging activation preflight. Confirms 097 migration
 * files/checksum, principal contract, exact flags, Sunset binding, producer
 * + worker LOGIN DSNs, controlled test scope presence, and closed provider
 * surface. Never applies migration, provisions roles, starts runtime,
 * consents OAuth, or calls Graph.
 */

const fs = require('node:fs');
const path = require('node:path');
const runtimeIsProxy = require('node:util').types.isProxy.bind(undefined);
const {
  isProxySurface,
  ownData,
  isCanonUuid,
} = require('./email-luna-controlled-drafting-closed-data');
const {
  resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION_WIRED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION,
  ENV_RUNTIME_ENABLED,
  ENV_COMPOSITION_ENABLED,
  ENV_PRODUCER_INTAKE_ENABLED,
  ENV_WORKER_TICK_ENABLED,
  ENV_LIVE_PROVIDER_DRAFT_ENABLED,
  ENV_CLIENT_ID,
  ENV_LOCATION_ID,
  ENV_LOCATION_KEY,
  ENV_ENDPOINT_ID,
  ENV_MAILBOX_ID,
  ENV_PROVIDER,
  ENV_REPLICA_COUNT,
  ENV_TEST_OPERATION_ID,
  ENV_TEST_ISSUANCE_ID,
  ENV_TEST_RECIPIENT_ADDRESS,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  SUNSET_LOCATION_KEY,
} = require('./email-luna-controlled-drafting-sunset-staging-runtime-activation');
const {
  resolveEmailLunaControlledDraftingPrincipalConnectionConfig,
  createEmailLunaControlledDraftingPrincipalConnectionPair,
  isAuthenticEmailLunaControlledDraftingPrincipalConnectionPair,
} = require('./email-luna-controlled-drafting-principal-connection');
const {
  MIGRATION_097_ID,
  MIGRATION_097_SHA256,
  EXPECTED_CHECKSUM_MODE,
  inspectEmailLunaControlledDraftingSession,
} = require('./email-luna-controlled-drafting-session-proof');
const {
  EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT,
} = require('./email-luna-automation-principal-contract');
const {
  EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_GRANT_CONTRACT,
  EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_RUNTIME_WIRED,
} = require('./email-luna-controlled-drafting-operation-store');
const {
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_WIRED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_ACTIVATION,
  EMAIL_LUNA_CONTROLLED_DRAFTING_CAPABILITY_MANIFEST,
  EMAIL_MS_CONTROLLED_DRAFTING_SCOPE_PROFILE,
} = require('./email-luna-controlled-drafting-provider-contract');
const {
  checksumMigrationFile,
  CHECKSUM_MODE_CANONICAL_LF_V1,
} = require('./migration-integrity');
const {
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ACTIVATION,
} = require('./email-luna-controlled-drafting-sunset-staging-runtime-composition');

const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectHasOwn = Object.hasOwn;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectPrototype = Object.prototype;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const arrayIncludes = Function.prototype.call.bind(Array.prototype.includes);
const regexpTest = Function.prototype.call.bind(RegExp.prototype.test);
const stringToLowerCase = Function.prototype.call.bind(String.prototype.toLowerCase);
const stringTrim = Function.prototype.call.bind(String.prototype.trim);

const ROOT = path.join(__dirname, '..', '..');
const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_PREFLIGHT_INVALID';
const FORBIDDEN_INPUT_KEYS = objectFreeze([
  'apply', 'provision', 'start', 'stop', 'send', 'provider', 'callback',
  'onSend', 'authorize_dispatch', 'migrate', 'roleName', 'password',
  'access_token', 'token',
]);
const OPERATOR_PREFLIGHT_KEYS = objectFreeze(['env', 'appConnectionString', 'connection']);
const OPTIONAL_QUERY_KEY = 'query';
const UNIT_TEST_INSPECT_KEY = 'unit_test_inspect';
const INSPECT_AUTHENTICITY_DEDICATED = 'dedicated_principal_session';
const INSPECT_AUTHENTICITY_UNIT_TEST = 'unit_test_inspect';

function invalid() {
  const error = new Error('Email Luna controlled drafting runtime preflight failed.');
  error.code = ERROR_CODE;
  return error;
}

function freeze(value) {
  return objectFreeze(value);
}

function output(entries) {
  const value = objectCreate(null);
  for (let index = 0; index < entries.length; index += 1) {
    objectDefineProperty(value, entries[index][0], {
      value: entries[index][1], enumerable: true, writable: true, configurable: true,
    });
  }
  return freeze(value);
}

function safeOwnKeys(value) {
  try {
    return reflectOwnKeys(value);
  } catch (_) {
    throw invalid();
  }
}

function refuseForbiddenKeys(value) {
  const ownKeys = safeOwnKeys(value);
  for (let index = 0; index < ownKeys.length; index += 1) {
    if (arrayIncludes(FORBIDDEN_INPUT_KEYS, ownKeys[index])) throw invalid();
  }
}

function exactFlag(env, key) {
  return ownData(env, key) === 'true';
}

function parseUuid(raw) {
  if (typeof raw !== 'string') return null;
  const id = stringToLowerCase(raw);
  if (!regexpTest(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, id)
      || stringTrim(raw) !== raw) {
    return null;
  }
  return id;
}

function readFileIfPresent(rel) {
  const abs = path.join(ROOT, rel);
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (_) {
    return null;
  }
}

function fileReady(rel, needles, forbidden) {
  const text = readFileIfPresent(rel);
  if (typeof text !== 'string') return false;
  for (let index = 0; index < needles.length; index += 1) {
    if (text.indexOf(needles[index]) === -1) return false;
  }
  for (let index = 0; index < forbidden.length; index += 1) {
    if (regexpTest(forbidden[index], text)) return false;
  }
  return true;
}

function fileChecksumOk() {
  const abs = path.join(ROOT, 'database/migrations', `${MIGRATION_097_ID}.sql`);
  const live = checksumMigrationFile(abs, CHECKSUM_MODE_CANONICAL_LF_V1);
  return Boolean(live && live.ok === true && live.sha256 === MIGRATION_097_SHA256
    && CHECKSUM_MODE_CANONICAL_LF_V1 === EXPECTED_CHECKSUM_MODE);
}

function readBindingFromEnv(env) {
  return {
    client_id: parseUuid(ownData(env, ENV_CLIENT_ID)),
    location_id: parseUuid(ownData(env, ENV_LOCATION_ID)),
    location_key: ownData(env, ENV_LOCATION_KEY) === SUNSET_LOCATION_KEY ? SUNSET_LOCATION_KEY : null,
  };
}

function testScopeConfigured(env) {
  return Boolean(
    isCanonUuid(parseUuid(ownData(env, ENV_TEST_OPERATION_ID)))
    && isCanonUuid(parseUuid(ownData(env, ENV_TEST_ISSUANCE_ID)))
    && typeof ownData(env, ENV_TEST_RECIPIENT_ADDRESS) === 'string'
    && ownData(env, ENV_TEST_RECIPIENT_ADDRESS).length > 0,
  );
}

function failedSchema() {
  return {
    ok: false,
    inspect_failed: true,
    schema_applied: false,
    checksum_ok: false,
    principal_applied: false,
    login_ok: false,
    mapping_ok: false,
    execute_ok: false,
  };
}

function runEmailLunaControlledDraftingRuntimePreflight(input) {
  if (arguments.length !== 1) throw invalid();
  if (!input || typeof input !== 'object' || runtimeIsProxy(input) || isProxySurface(input) || arrayIsArray(input)) {
    throw invalid();
  }
  if (objectGetPrototypeOf(input) !== objectPrototype) throw invalid();
  refuseForbiddenKeys(input);
  const env = ownData(input, 'env');
  const hasQueryKey = objectHasOwn(objectGetOwnPropertyDescriptor(input, OPTIONAL_QUERY_KEY) || {}, 'value');
  const hasUnitTestKey = objectHasOwn(objectGetOwnPropertyDescriptor(input, UNIT_TEST_INSPECT_KEY) || {}, 'value');
  const query = hasQueryKey ? ownData(input, OPTIONAL_QUERY_KEY) : undefined;
  const unitTestInspect = hasUnitTestKey ? ownData(input, UNIT_TEST_INSPECT_KEY) : undefined;
  const own = safeOwnKeys(input);
  for (let index = 0; index < own.length; index += 1) {
    if (own[index] !== 'env' && own[index] !== OPTIONAL_QUERY_KEY && own[index] !== UNIT_TEST_INSPECT_KEY) {
      throw invalid();
    }
  }
  if (query !== undefined && (typeof query !== 'function' || runtimeIsProxy(query))) throw invalid();
  if (query !== undefined && unitTestInspect !== true) throw invalid();
  if (unitTestInspect !== undefined && unitTestInspect !== true) throw invalid();
  if (unitTestInspect === true && query === undefined) throw invalid();

  const readiness = resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness(env);
  const sql097 = readFileIfPresent(`database/migrations/${MIGRATION_097_ID}.sql`);
  const down097 = readFileIfPresent(`database/migrations/${MIGRATION_097_ID}_down.sql`);
  const migrationFilesReady = fileReady(
    `database/migrations/${MIGRATION_097_ID}.sql`,
    [
      'tenant_email_luna_controlled_draft_operations',
      'tenant_email_luna_controlled_draft_reserve',
      'tenant_email_luna_controlled_draft_claim_create',
      'REVOKE ALL ON FUNCTION',
    ],
    [/^\s*GRANT /m, /^\s*CREATE ROLE/m],
  ) && fileReady(
    `database/migrations/${MIGRATION_097_ID}_down.sql`,
    ['ACCESS EXCLUSIVE', '097_down_refused'],
    [/^\s*GRANT /m, /^\s*CREATE ROLE/m],
  ) && fileChecksumOk();
  const principalReady = EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.no_grant_in_097 === true
    && EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.no_create_role_in_097 === true
    && EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_GRANT_CONTRACT.no_grant_in_097 === true
    && EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_GRANT_CONTRACT.no_create_role_in_097 === true;
  let principalConnectionOk = false;
  try {
    const cfg = resolveEmailLunaControlledDraftingPrincipalConnectionConfig({
      env,
      appConnectionString: ownData(env, 'WOLFHOUSE_DATABASE_URL') || ownData(env, 'DATABASE_URL'),
    });
    principalConnectionOk = Boolean(cfg && cfg.ok === true);
  } catch (_) {
    principalConnectionOk = false;
  }
  const replicaCountOk = ownData(env, ENV_REPLICA_COUNT) === '1';
  const downPreserved = typeof down097 === 'string'
    && down097.indexOf('ACCESS EXCLUSIVE') !== -1
    && down097.indexOf('097_down_refused') !== -1;
  const sendAbsent = EMAIL_LUNA_CONTROLLED_DRAFTING_CAPABILITY_MANIFEST.capabilities.send === false
    && EMAIL_MS_CONTROLLED_DRAFTING_SCOPE_PROFILE.graph_delegated.join(' ') === 'User.Read Mail.ReadWrite'
    && EMAIL_MS_CONTROLLED_DRAFTING_SCOPE_PROFILE.excluded_graph.indexOf('Mail.Send') !== -1;
  const flags = output([
    [ENV_RUNTIME_ENABLED, exactFlag(env, ENV_RUNTIME_ENABLED)],
    [ENV_COMPOSITION_ENABLED, exactFlag(env, ENV_COMPOSITION_ENABLED)],
    [ENV_PRODUCER_INTAKE_ENABLED, exactFlag(env, ENV_PRODUCER_INTAKE_ENABLED)],
    [ENV_WORKER_TICK_ENABLED, exactFlag(env, ENV_WORKER_TICK_ENABLED)],
    [ENV_LIVE_PROVIDER_DRAFT_ENABLED, exactFlag(env, ENV_LIVE_PROVIDER_DRAFT_ENABLED)],
    ['LUNA_DEPLOYMENT_exact', ownData(env, 'LUNA_DEPLOYMENT') === SUNSET_DEPLOYMENT],
    ['DEFAULT_CLIENT_SLUG_exact', ownData(env, 'DEFAULT_CLIENT_SLUG') === SUNSET_TENANT],
  ]);
  const binding = output([
    ['deployment', ownData(env, 'LUNA_DEPLOYMENT') === SUNSET_DEPLOYMENT ? SUNSET_DEPLOYMENT : null],
    ['tenant', ownData(env, 'DEFAULT_CLIENT_SLUG') === SUNSET_TENANT ? SUNSET_TENANT : null],
    ['location_key', ownData(env, ENV_LOCATION_KEY) === SUNSET_LOCATION_KEY ? SUNSET_LOCATION_KEY : null],
    ['client_id', parseUuid(ownData(env, ENV_CLIENT_ID))],
    ['location_id', parseUuid(ownData(env, ENV_LOCATION_ID))],
    ['endpoint_id', parseUuid(ownData(env, ENV_ENDPOINT_ID))],
    ['mailbox_id', parseUuid(ownData(env, ENV_MAILBOX_ID))],
    ['provider', ownData(env, ENV_PROVIDER) === 'microsoft_graph' ? 'microsoft_graph' : null],
  ]);

  function finish(producerSchema, workerSchema, inspectAuthenticity) {
    const blockers = [];
    const inspectRequired = !query && inspectAuthenticity !== INSPECT_AUTHENTICITY_DEDICATED;
    if (!migrationFilesReady) blockers.push('migration_files_not_ready');
    if (!principalReady) blockers.push('principal_contract_not_ready');
    if (!downPreserved) blockers.push('migration_097_down_not_preserved');
    if (!sendAbsent) blockers.push('send_capability_not_absent');
    if (inspectRequired) blockers.push('inspect_required');
    const schemas = [producerSchema, workerSchema];
    for (let i = 0; i < schemas.length; i += 1) {
      const schema = schemas[i];
      if (schema.inspect_failed === true) blockers.push(i === 0 ? 'producer_inspect_failed' : 'worker_inspect_failed');
      else if (!inspectRequired) {
        if (schema.schema_applied === false) blockers.push(i === 0 ? 'producer_schema_not_applied' : 'worker_schema_not_applied');
        if (schema.checksum_ok === false) blockers.push(i === 0 ? 'producer_checksum_unproven' : 'worker_checksum_unproven');
        if (schema.principal_applied === false) blockers.push(i === 0 ? 'producer_principal_unproven' : 'worker_principal_unproven');
        if (schema.login_ok === false) blockers.push(i === 0 ? 'producer_login_unproven' : 'worker_login_unproven');
        if (schema.execute_ok === false) blockers.push(i === 0 ? 'producer_execute_unproven' : 'worker_execute_unproven');
      }
    }
    if (!replicaCountOk) blockers.push('replica_topology_unproven');
    if (!principalConnectionOk) blockers.push('principal_connection_required');
    if (readiness.runtime_activation !== true) blockers.push('activation_gates_not_exact');
    if (!testScopeConfigured(env) && (
      exactFlag(env, ENV_PRODUCER_INTAKE_ENABLED) || exactFlag(env, ENV_WORKER_TICK_ENABLED)
    )) {
      blockers.push('controlled_test_scope_required');
    }
    if (EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION !== false) blockers.push('activation_pin');
    if (EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ACTIVATION !== false) blockers.push('composition_activation_pin');
    if (EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_WIRED !== false) blockers.push('provider_runtime_wired');
    if (EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_RUNTIME_WIRED !== false) blockers.push('operation_runtime_wired');
    if (EMAIL_LUNA_CONTROLLED_DRAFTING_ACTIVATION !== false) blockers.push('provider_activation_pin');
    if (readiness.send_allowed !== false) blockers.push('send_allowed');
    if (readiness.journal_handoff !== false) blockers.push('journal_handoff');
    if (exactFlag(env, ENV_LIVE_PROVIDER_DRAFT_ENABLED) && readiness.live_provider_draft !== true) {
      blockers.push('live_provider_draft_blocked');
    }
    const authenticInspect = inspectAuthenticity === INSPECT_AUTHENTICITY_DEDICATED
      || inspectAuthenticity === INSPECT_AUTHENTICITY_UNIT_TEST;
    if (!inspectRequired && !authenticInspect) blockers.push('inspect_authenticity_unproven');
    const unique = [];
    for (let i = 0; i < blockers.length; i += 1) {
      if (unique.indexOf(blockers[i]) === -1) unique.push(blockers[i]);
    }
    const readyForActivationReview = unique.length === 0
      && authenticInspect === true
      && producerSchema.schema_applied === true
      && workerSchema.schema_applied === true
      && producerSchema.checksum_ok === true
      && workerSchema.checksum_ok === true
      && producerSchema.ok === true
      && workerSchema.ok === true
      && readiness.runtime_activation === true;
    return output([
      ['ok', readyForActivationReview],
      ['would_activate', readiness.runtime_activation === true],
      ['activation_started', false],
      ['migration_applied', false],
      ['roles_provisioned', false],
      ['runtime_started', false],
      ['provider_capability', readiness.provider_capability === true],
      ['live_provider_draft', readiness.live_provider_draft === true],
      ['journal_handoff', false],
      ['send_allowed', false],
      ['composition_wired', EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION_WIRED === true],
      ['files_ready', migrationFilesReady],
      ['inspect_required', inspectRequired],
      ['inspect_authenticity', inspectAuthenticity || null],
      ['migration_files_ready', migrationFilesReady],
      ['principal_contract_ready', principalReady],
      ['file_checksum_ok', fileChecksumOk()],
      ['producer_schema_applied', producerSchema.schema_applied],
      ['worker_schema_applied', workerSchema.schema_applied],
      ['producer_checksum_ok', producerSchema.checksum_ok],
      ['worker_checksum_ok', workerSchema.checksum_ok],
      ['producer_principal_ok', producerSchema.ok === true],
      ['worker_principal_ok', workerSchema.ok === true],
      ['replica_count_ok', replicaCountOk],
      ['principal_connection_ok', principalConnectionOk],
      ['test_scope_configured', testScopeConfigured(env)],
      ['live_provider_block_reason', readiness.live_provider_block_reason || null],
      ['flags', flags],
      ['binding', binding],
      ['blockers', freeze(unique.slice())],
      ['readiness_reason', readiness.reason],
    ]);
  }

  if (!query) {
    return Promise.resolve(finish(failedSchema(), failedSchema(), null));
  }
  const inspectBinding = readBindingFromEnv(env);
  return inspectEmailLunaControlledDraftingSession({ query }, inspectBinding, 'producer')
    .then((producerSchema) => inspectEmailLunaControlledDraftingSession(
      { query },
      inspectBinding,
      'worker',
    ).then((workerSchema) => finish(producerSchema, workerSchema, INSPECT_AUTHENTICITY_UNIT_TEST)))
    .catch(() => finish(failedSchema(), failedSchema(), INSPECT_AUTHENTICITY_UNIT_TEST));
}

async function runEmailLunaControlledDraftingRuntimeOperatorPreflight(input) {
  if (arguments.length !== 1) throw invalid();
  if (!input || typeof input !== 'object' || runtimeIsProxy(input) || isProxySurface(input) || arrayIsArray(input)) {
    throw invalid();
  }
  if (objectGetPrototypeOf(input) !== objectPrototype) throw invalid();
  refuseForbiddenKeys(input);
  const env = ownData(input, 'env');
  const appConnectionString = ownData(input, 'appConnectionString');
  const connection = ownData(input, 'connection');
  const own = safeOwnKeys(input);
  for (let index = 0; index < own.length; index += 1) {
    if (!arrayIncludes(OPERATOR_PREFLIGHT_KEYS, own[index])) throw invalid();
  }
  if (objectHasOwn(objectGetOwnPropertyDescriptor(input, OPTIONAL_QUERY_KEY) || {}, 'value')) throw invalid();
  if (appConnectionString !== undefined && typeof appConnectionString !== 'string') throw invalid();
  if (connection !== undefined && !isAuthenticEmailLunaControlledDraftingPrincipalConnectionPair(connection)) {
    throw invalid();
  }

  const binding = readBindingFromEnv(env);

  async function inspectKind(pair, kind) {
    const handle = kind === 'producer' ? pair.producer : pair.worker;
    if (!handle || typeof handle.withTransactionClient !== 'function') return failedSchema();
    try {
      return await handle.withTransactionClient(async (client) => (
        inspectEmailLunaControlledDraftingSession(client, binding, kind)
      ));
    } catch (_) {
      return failedSchema();
    }
  }

  let pair = connection;
  let created = false;
  if (!pair) {
    try {
      pair = createEmailLunaControlledDraftingPrincipalConnectionPair({
        env,
        appConnectionString,
      });
      created = true;
    } catch (_) {
      pair = null;
    }
  }
  let producerSchema = failedSchema();
  let workerSchema = failedSchema();
  if (pair) {
    try {
      producerSchema = await inspectKind(pair, 'producer');
      workerSchema = await inspectKind(pair, 'worker');
    } finally {
      if (created) {
        try { await pair.close(); } catch (_) { /* bounded close */ }
      }
    }
  }

  const libraryInput = { env };
  const base = await runEmailLunaControlledDraftingRuntimePreflight(libraryInput);
  const mergedInspect = {
    inspect_failed: producerSchema.inspect_failed === true || workerSchema.inspect_failed === true,
    schema_applied: producerSchema.schema_applied === true && workerSchema.schema_applied === true,
    checksum_ok: producerSchema.checksum_ok === true && workerSchema.checksum_ok === true,
    principal_applied: producerSchema.principal_applied === true && workerSchema.principal_applied === true,
    login_ok: producerSchema.login_ok === true && workerSchema.login_ok === true,
    execute_ok: producerSchema.execute_ok === true && workerSchema.execute_ok === true,
    ok: producerSchema.ok === true && workerSchema.ok === true,
  };
  const withInspect = await Promise.resolve(finishOperator(base, producerSchema, workerSchema, mergedInspect));
  return withInspect;

  function finishOperator(library, producer, worker) {
    const blockers = [];
    for (let index = 0; index < library.blockers.length; index += 1) {
      if (library.blockers[index] !== 'inspect_required') blockers.push(library.blockers[index]);
    }
    if (producer.inspect_failed === true) blockers.push('producer_inspect_failed');
    if (worker.inspect_failed === true) blockers.push('worker_inspect_failed');
    if (producer.schema_applied !== true) blockers.push('producer_schema_not_applied');
    if (worker.schema_applied !== true) blockers.push('worker_schema_not_applied');
    if (producer.checksum_ok !== true) blockers.push('producer_checksum_unproven');
    if (worker.checksum_ok !== true) blockers.push('worker_checksum_unproven');
    if (producer.ok !== true) blockers.push('producer_principal_unproven');
    if (worker.ok !== true) blockers.push('worker_principal_unproven');
    const unique = [];
    for (let i = 0; i < blockers.length; i += 1) {
      if (unique.indexOf(blockers[i]) === -1) unique.push(blockers[i]);
    }
    const ok = unique.length === 0
      && producer.ok === true
      && worker.ok === true
      && library.would_activate === true;
    return output([
      ['ok', ok],
      ['would_activate', library.would_activate],
      ['activation_started', false],
      ['migration_applied', false],
      ['roles_provisioned', false],
      ['runtime_started', false],
      ['provider_capability', library.provider_capability],
      ['live_provider_draft', library.live_provider_draft],
      ['journal_handoff', false],
      ['send_allowed', false],
      ['composition_wired', library.composition_wired],
      ['files_ready', library.files_ready],
      ['inspect_required', false],
      ['inspect_authenticity', INSPECT_AUTHENTICITY_DEDICATED],
      ['migration_files_ready', library.migration_files_ready],
      ['principal_contract_ready', library.principal_contract_ready],
      ['file_checksum_ok', library.file_checksum_ok],
      ['producer_schema_applied', producer.schema_applied],
      ['worker_schema_applied', worker.schema_applied],
      ['producer_checksum_ok', producer.checksum_ok],
      ['worker_checksum_ok', worker.checksum_ok],
      ['producer_principal_ok', producer.ok === true],
      ['worker_principal_ok', worker.ok === true],
      ['replica_count_ok', library.replica_count_ok],
      ['principal_connection_ok', library.principal_connection_ok],
      ['test_scope_configured', library.test_scope_configured],
      ['live_provider_block_reason', library.live_provider_block_reason],
      ['flags', library.flags],
      ['binding', library.binding],
      ['blockers', freeze(unique.slice())],
      ['readiness_reason', library.readiness_reason],
    ]);
  }
}

module.exports = objectFreeze({
  ERROR_CODE,
  MIGRATION_097_ID,
  MIGRATION_097_SHA256,
  runEmailLunaControlledDraftingRuntimePreflight,
  runEmailLunaControlledDraftingRuntimeOperatorPreflight,
});
