'use strict';

/**
 * FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B5: read-only controlled-comparison
 * preflight. Confirms migration/principal files, exact flags, Sunset
 * tenant/location/endpoint binding, zero provider capability, and safe
 * comparison labels. Never applies migration, provisions roles, starts
 * runtime, or sends.
 */

const fs = require('node:fs');
const path = require('node:path');
const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const runtimeIsProxy = require('node:util').types.isProxy.bind(undefined);
const {
  resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness,
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION,
  ENV_COMPOSITION_ENABLED,
  ENV_CLIENT_ID,
  ENV_LOCATION_ID,
  ENV_LOCATION_KEY,
  ENV_ENDPOINT_ID,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  SUNSET_LOCATION_KEY,
  MIGRATION_093_ID,
  MIGRATION_094_ID,
} = require('./email-luna-automation-shadow-sunset-staging-runtime-composition');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH,
  EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RUNTIME_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_GRANT_CONTRACT,
} = require('./email-luna-automation-shadow-outcome-store');
const {
  EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT,
} = require('./email-luna-automation-principal-contract');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_RUNTIME_WIRED,
  ENV_SHADOW_WORKER_ENABLED,
} = require('./email-luna-automation-shadow-worker');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_WIRED,
  ENV_SHADOW_ENABLED,
} = require('./email-luna-automation-shadow-orchestration');

const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectHasOwn = Object.hasOwn;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectPrototype = Object.prototype;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const arrayIncludes = uncurryThis(Array.prototype.includes);
const regexpTest = uncurryThis(RegExp.prototype.test);
const stringToLowerCase = uncurryThis(String.prototype.toLowerCase);
const stringTrim = uncurryThis(String.prototype.trim);

const ROOT = path.join(__dirname, '..', '..');
const PREFLIGHT_KEYS = objectFreeze(['env']);
const OPTIONAL_QUERY_KEY = 'query';
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ERROR_CODE = 'EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_PREFLIGHT_INVALID';
const FORBIDDEN_INPUT_KEYS = objectFreeze([
  'apply', 'provision', 'start', 'stop', 'send', 'provider', 'callback',
  'onSend', 'authorize_dispatch', 'migrate', 'roleName', 'password',
]);
const SCHEMA_SQL = [
  'SELECT',
  '  EXISTS (',
  '    SELECT 1 FROM pg_catalog.pg_class c',
  '    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
  "    WHERE n.nspname = 'public'",
  "      AND c.relname = 'tenant_email_luna_automation_shadow_outcomes'",
  "      AND c.relkind = 'r'",
  '  ) AS outcomes_table,',
  "  pg_catalog.to_regprocedure('public.tenant_email_luna_automation_principal_authorized(text, uuid, uuid, text)') IS NOT NULL AS principal_fn,",
  "  CASE",
  "    WHEN pg_catalog.to_regprocedure('public.tenant_email_luna_automation_shadow_outcome_project(uuid, uuid)') IS NULL THEN NULL",
  "    ELSE pg_catalog.pg_get_functiondef('public.tenant_email_luna_automation_shadow_outcome_project(uuid, uuid)'::pg_catalog.regprocedure)",
  '  END AS project_def',
].join('\n');

function invalid() {
  const error = new Error('Email Luna automation shadow runtime preflight failed.');
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

function ownData(value, key) {
  try {
    if (!value || typeof value !== 'object' || runtimeIsProxy(value) || arrayIsArray(value)) return undefined;
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.get || descriptor.set) return undefined;
    return descriptor.value;
  } catch (_) {
    return undefined;
  }
}

function exactFlag(env, key) {
  return ownData(env, key) === 'true';
}

function parseUuid(raw) {
  if (typeof raw !== 'string') return null;
  const id = stringToLowerCase(raw);
  if (!regexpTest(UUID_CANON, id) || stringTrim(raw) !== raw) return null;
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

function projectDefSafe(def) {
  if (typeof def !== 'string') return false;
  return def.indexOf("matched := 'staff_action_observed'") !== -1
    && def.indexOf("matched := 'agreement'") === -1;
}

async function inspectSchema(query) {
  if (typeof query !== 'function' || runtimeIsProxy(query)) throw invalid();
  const result = await Promise.resolve(query(SCHEMA_SQL, []));
  const rows = result && arrayIsArray(result.rows) ? result.rows : [];
  if (rows.length !== 1) {
    return { schema_applied: false, principal_applied: false, identity_label_applied: false };
  }
  const row = rows[0];
  return {
    schema_applied: row.outcomes_table === true,
    principal_applied: row.principal_fn === true,
    identity_label_applied: projectDefSafe(row.project_def),
  };
}

function runEmailLunaAutomationShadowRuntimePreflight(input) {
  if (arguments.length !== 1) throw invalid();
  if (!input || typeof input !== 'object' || runtimeIsProxy(input) || arrayIsArray(input)) throw invalid();
  if (objectGetPrototypeOf(input) !== objectPrototype) throw invalid();
  refuseForbiddenKeys(input);
  const env = ownData(input, 'env');
  const query = objectHasOwn(objectGetOwnPropertyDescriptor(input, OPTIONAL_QUERY_KEY) || {}, 'value')
    ? ownData(input, OPTIONAL_QUERY_KEY)
    : undefined;
  const own = safeOwnKeys(input);
  for (let index = 0; index < own.length; index += 1) {
    if (own[index] !== 'env' && own[index] !== OPTIONAL_QUERY_KEY) throw invalid();
  }
  if (query !== undefined && (typeof query !== 'function' || runtimeIsProxy(query))) throw invalid();
  const readiness = resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness(env);
  const later = EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH;
  const sql094 = readFileIfPresent(`database/migrations/${MIGRATION_094_ID}.sql`);
  const sql093 = readFileIfPresent(`database/migrations/${MIGRATION_093_ID}.sql`);
  const migrationFilesReady = fileReady(
    `database/migrations/${MIGRATION_094_ID}.sql`,
    ["matched := 'staff_action_observed'", 'REVOKE ALL ON FUNCTION', 'SECURITY DEFINER'],
    [/^\s*GRANT /m, /^\s*CREATE ROLE/m],
  ) && fileReady(
    `database/migrations/${MIGRATION_093_ID}.sql`,
    ['tenant_email_luna_automation_shadow_outcomes', "comparison_state = 'pending_human'"],
    [/^\s*GRANT /m, /^\s*CREATE ROLE/m],
  );
  const principalReady = EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.no_grant_in_093 === true
    && EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.no_grant_in_094 === true
    && EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.runtime_wired === false
    && EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_GRANT_CONTRACT.no_grant_in_094 === true;
  const unsafeLabelAbsent = later.unique_human_would_send === 'staff_action_observed'
    && later.unique_human_kind === 'inbound_workflow_identity'
    && later.proves_provider_sent === false
    && later.proves_same_luna_draft === false
    && later.proves_content_agreement === false
    && later.unsafe_labels.length === 4
    && (typeof sql094 !== 'string' || sql094.indexOf("matched := 'staff_action_observed'") !== -1)
    && (typeof sql094 !== 'string' || sql094.indexOf("matched := 'agreement'") === -1)
    && (typeof sql093 !== 'string' || sql093.indexOf("comparison_state = 'pending_human'") !== -1);
  const flags = output([
    [ENV_COMPOSITION_ENABLED, exactFlag(env, ENV_COMPOSITION_ENABLED)],
    [ENV_SHADOW_ENABLED, exactFlag(env, ENV_SHADOW_ENABLED)],
    [ENV_SHADOW_WORKER_ENABLED, exactFlag(env, ENV_SHADOW_WORKER_ENABLED)],
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
  ]);

  function finish(schema) {
    const blockers = [];
    if (!migrationFilesReady) blockers.push('migration_files_not_ready');
    if (!principalReady) blockers.push('principal_contract_not_ready');
    if (!unsafeLabelAbsent) blockers.push('unsafe_comparison_label');
    if (schema.schema_applied === false) blockers.push('migration_not_applied');
    if (schema.principal_applied === false) blockers.push('principal_not_applied');
    if (schema.identity_label_applied === false) blockers.push('identity_label_not_applied');
    if (EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION !== false) blockers.push('composition_activation_pin');
    if (EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_RUNTIME_WIRED !== false) blockers.push('worker_runtime_wired');
    if (EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_WIRED !== false) blockers.push('producer_runtime_wired');
    if (EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RUNTIME_WIRED !== false) blockers.push('outcome_runtime_wired');
    if (readiness.provider_capability !== false) blockers.push('provider_capability');
    const readyForActivationReview = blockers.length === 0
      && migrationFilesReady
      && principalReady
      && unsafeLabelAbsent
      && (query ? schema.schema_applied === true && schema.identity_label_applied === true && schema.principal_applied === true : true);
    return output([
      ['ok', readyForActivationReview],
      ['would_activate', readiness.runtime_activation === true],
      ['activation_started', false],
      ['migration_applied', false],
      ['roles_provisioned', false],
      ['runtime_started', false],
      ['provider_capability', false],
      ['journal_handoff', false],
      ['send_allowed', false],
      ['composition_wired', EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_WIRED === true],
      ['comparison_state_label', later.unique_human_would_send],
      ['comparison_kind', later.unique_human_kind],
      ['proves_provider_sent', false],
      ['proves_same_luna_draft', false],
      ['proves_content_agreement', false],
      ['migration_files_ready', migrationFilesReady],
      ['principal_contract_ready', principalReady],
      ['schema_applied', schema.schema_applied],
      ['principal_applied', schema.principal_applied],
      ['identity_label_applied', schema.identity_label_applied],
      ['flags', flags],
      ['binding', binding],
      ['blockers', freeze(blockers.slice())],
      ['readiness_reason', readiness.reason],
    ]);
  }

  if (!query) {
    return Promise.resolve(finish({
      schema_applied: 'unknown',
      principal_applied: 'unknown',
      identity_label_applied: 'unknown',
    }));
  }
  return inspectSchema(query).then(finish);
}

module.exports = objectFreeze({
  runEmailLunaAutomationShadowRuntimePreflight,
  ERROR_CODE,
  PREFLIGHT_KEYS,
  SCHEMA_SQL,
});
