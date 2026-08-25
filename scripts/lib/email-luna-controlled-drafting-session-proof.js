'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4A.
 *
 * Read-only producer/worker session proof for migration 097 and mapped
 * direct LOGIN principals. Never SET ROLE. Never applies migration.
 * Copy/validate plain own scalars only. Binding getters/proxies must not
 * feed SQL params. Never logs credentials, recipients, or tokens.
 */

const {
  isProxySurface,
  ownData,
  isCanonUuid,
} = require('./email-luna-controlled-drafting-closed-data');

const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const objectPrototype = Object.prototype;
const arrayIsArray = Array.isArray;
const arrayIncludes = Function.prototype.call.bind(Array.prototype.includes);

const BINDING_KEYS = objectFreeze(['client_id', 'location_id', 'location_key']);
const MIGRATION_097_ID = '097_tenant_email_luna_controlled_draft_operations';
const MIGRATION_097_SHA256 = 'e36e2028eaf6d473e399a2326b988c40aad55e58d5f8fb6cfec35f96acfbfb62';
const EXPECTED_CHECKSUM_MODE = 'canonical_lf_v1';
const SUNSET_LOCATION_KEY = 'sunset-somo';

const PRINCIPAL_REG =
  'public.tenant_email_luna_automation_principal_authorized(text, uuid, uuid, text)';
const RESERVE_REG =
  'public.tenant_email_luna_controlled_draft_reserve(uuid, uuid, text, text, text, text, text, text)';
const CLAIM_REG = 'public.tenant_email_luna_controlled_draft_claim_create(uuid, uuid, integer)';
const RECORD_REG = 'public.tenant_email_luna_controlled_draft_record_create(uuid, uuid, integer, jsonb)';
const RECONCILE_REG = 'public.tenant_email_luna_controlled_draft_reconcile(uuid, uuid, integer, jsonb)';
const LOAD_REG = 'public.tenant_email_luna_controlled_draft_load(uuid, uuid)';

const BOOLEAN_KEYS = objectFreeze([
  'operations_table',
  'transitions_table',
  'reserve_fn',
  'claim_fn',
  'record_fn',
  'reconcile_fn',
  'load_fn',
  'principal_fn',
  'session_matches_current',
  'session_distinct_from_owner',
  'login_contract_ok',
  'mapping_ok',
  'execute_ok',
]);
const STRING_KEYS = objectFreeze(['session_user', 'current_user', 'table_owner']);
const NULLABLE_STRING_KEYS = objectFreeze([]);
const INSPECT_KEYS = objectFreeze([
  ...BOOLEAN_KEYS,
  ...STRING_KEYS,
  ...NULLABLE_STRING_KEYS,
]);

function privilegeSql(reg) {
  return [
    'CASE',
    `  WHEN pg_catalog.to_regprocedure('${reg}') IS NULL THEN FALSE`,
    '  ELSE pg_catalog.has_function_privilege(',
    '    session_user,',
    `    '${reg}'::pg_catalog.regprocedure,`,
    "    'EXECUTE'",
    '  )',
    'END',
  ].join('\n');
}

function mappingSql(kindLiteral) {
  return [
    'CASE',
    `  WHEN pg_catalog.to_regprocedure('${PRINCIPAL_REG}') IS NULL THEN FALSE`,
    `  WHEN NOT pg_catalog.has_function_privilege(`,
    '    session_user,',
    `    '${PRINCIPAL_REG}'::pg_catalog.regprocedure,`,
    "    'EXECUTE'",
    '  ) THEN FALSE',
    `  ELSE public.tenant_email_luna_automation_principal_authorized('${kindLiteral}', $1::uuid, $2::uuid, $3::text)`,
    'END',
  ].join('\n');
}

function attestSql(kindLiteral, executeRegs) {
  if (kindLiteral !== 'producer' && kindLiteral !== 'worker') {
    throw new Error('controlled_drafting_session_proof_kind');
  }
  const executeParts = [];
  for (let i = 0; i < executeRegs.length; i += 1) {
    if (i > 0) executeParts.push(' AND ');
    executeParts.push('(\n', privilegeSql(executeRegs[i]), '\n)');
  }
  return [
    'SELECT',
    '  EXISTS (',
    '    SELECT 1 FROM pg_catalog.pg_class c',
    '    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
    "    WHERE n.nspname = 'public'",
    "      AND c.relname = 'tenant_email_luna_controlled_draft_operations'",
    "      AND c.relkind = 'r'",
    '  ) AS operations_table,',
    '  EXISTS (',
    '    SELECT 1 FROM pg_catalog.pg_class c',
    '    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
    "    WHERE n.nspname = 'public'",
    "      AND c.relname = 'tenant_email_luna_controlled_draft_transitions'",
    "      AND c.relkind = 'r'",
    '  ) AS transitions_table,',
    `  pg_catalog.to_regprocedure('${RESERVE_REG}') IS NOT NULL AS reserve_fn,`,
    `  pg_catalog.to_regprocedure('${CLAIM_REG}') IS NOT NULL AS claim_fn,`,
    `  pg_catalog.to_regprocedure('${RECORD_REG}') IS NOT NULL AS record_fn,`,
    `  pg_catalog.to_regprocedure('${RECONCILE_REG}') IS NOT NULL AS reconcile_fn,`,
    `  pg_catalog.to_regprocedure('${LOAD_REG}') IS NOT NULL AS load_fn,`,
    `  pg_catalog.to_regprocedure('${PRINCIPAL_REG}') IS NOT NULL AS principal_fn,`,
    '  session_user::text AS session_user,',
    '  current_user::text AS current_user,',
    '  session_user::text IS NOT DISTINCT FROM current_user::text AS session_matches_current,',
    '  (',
    '    SELECT r.rolname::text',
    '      FROM pg_catalog.pg_roles r',
    '      JOIN pg_catalog.pg_class c ON c.relowner = r.oid',
    '      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
    "     WHERE n.nspname = 'public'",
    "       AND c.relname = 'tenant_email_luna_automation_queue'",
    "       AND c.relkind = 'r'",
    '  ) AS table_owner,',
    '  (',
    '    session_user IS NOT NULL',
    '    AND owner.rolname IS NOT NULL',
    '    AND session_user::text IS DISTINCT FROM owner.rolname::text',
    '  ) AS session_distinct_from_owner,',
    '  EXISTS (',
    '    SELECT 1',
    '      FROM pg_catalog.pg_roles r',
    '     WHERE r.rolname = session_user',
    '       AND r.rolcanlogin IS TRUE',
    '       AND r.rolsuper IS FALSE',
    '       AND r.rolcreatedb IS FALSE',
    '       AND r.rolcreaterole IS FALSE',
    '       AND r.rolreplication IS FALSE',
    '       AND r.rolbypassrls IS FALSE',
    '  ) AS login_contract_ok,',
    `  (\n${mappingSql(kindLiteral)}\n  ) AS mapping_ok,`,
    `  (\n${executeParts.join('')}\n  ) AS execute_ok`,
    'FROM (',
    '  SELECT r.rolname',
    '    FROM pg_catalog.pg_roles r',
    '    JOIN pg_catalog.pg_class c ON c.relowner = r.oid',
    '    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
    "   WHERE n.nspname = 'public'",
    "     AND c.relname = 'tenant_email_luna_automation_queue'",
    "     AND c.relkind = 'r'",
    ') AS owner',
  ].join('\n');
}

const PRODUCER_SESSION_PROOF_SQL = attestSql('producer', objectFreeze([RESERVE_REG, LOAD_REG]));
const WORKER_SESSION_PROOF_SQL = attestSql('worker', objectFreeze([
  CLAIM_REG, RECORD_REG, RECONCILE_REG, LOAD_REG,
]));

function freeze(value) {
  return objectFreeze(value);
}

function failedInspect() {
  return freeze({
    ok: false,
    inspect_failed: true,
    schema_applied: false,
    checksum_ok: false,
    principal_applied: false,
    login_ok: false,
    mapping_ok: false,
    execute_ok: false,
    session_user: null,
    reason: 'inspect_failed',
  });
}

function copyPlainSessionBinding(binding) {
  try {
    if (!binding || typeof binding !== 'object' || isProxySurface(binding) || arrayIsArray(binding)) {
      return null;
    }
    const proto = objectGetPrototypeOf(binding);
    if (proto !== objectPrototype && proto !== null) return null;
    const copy = objectCreate(null);
    for (let index = 0; index < BINDING_KEYS.length; index += 1) {
      const key = BINDING_KEYS[index];
      const descriptor = objectGetOwnPropertyDescriptor(binding, key);
      if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
        return null;
      }
      const value = descriptor.value;
      if (value !== null && typeof value !== 'string') return null;
      objectDefineProperty(copy, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (!isCanonUuid(copy.client_id) || !isCanonUuid(copy.location_id)) return null;
    if (copy.location_key !== SUNSET_LOCATION_KEY) return null;
    return freeze(copy);
  } catch (_) {
    return null;
  }
}

function copyPlainInspectRow(row) {
  try {
    if (!row || typeof row !== 'object' || isProxySurface(row) || arrayIsArray(row)) return null;
    const copy = objectCreate(null);
    for (let index = 0; index < INSPECT_KEYS.length; index += 1) {
      const key = INSPECT_KEYS[index];
      const descriptor = objectGetOwnPropertyDescriptor(row, key);
      if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
        return null;
      }
      const value = descriptor.value;
      if (arrayIncludes(BOOLEAN_KEYS, key)) {
        if (value !== true && value !== false) return null;
      } else if (arrayIncludes(STRING_KEYS, key)) {
        if (typeof value !== 'string') return null;
      } else if (arrayIncludes(NULLABLE_STRING_KEYS, key)) {
        if (value !== null && typeof value !== 'string') return null;
      } else {
        return null;
      }
      objectDefineProperty(copy, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  } catch (_) {
    return null;
  }
}

function evaluateInspectRow(copy) {
  if (!copy) return failedInspect();
  const schemaApplied = copy.operations_table === true
    && copy.transitions_table === true
    && copy.reserve_fn === true
    && copy.claim_fn === true
    && copy.record_fn === true
    && copy.reconcile_fn === true
    && copy.load_fn === true
    && copy.principal_fn === true;
  const loginOk = copy.session_matches_current === true
    && copy.session_distinct_from_owner === true
    && copy.login_contract_ok === true
    && typeof copy.session_user === 'string'
    && copy.session_user.length > 0
    && copy.session_user !== copy.table_owner;
  const principalOk = copy.mapping_ok === true && copy.execute_ok === true && loginOk;
  const ok = schemaApplied === true && principalOk === true;
  return freeze({
    ok,
    inspect_failed: false,
    schema_applied: schemaApplied,
    checksum_ok: schemaApplied,
    principal_applied: copy.mapping_ok === true,
    login_ok: loginOk,
    mapping_ok: copy.mapping_ok === true,
    execute_ok: copy.execute_ok === true,
    session_user: null,
    reason: ok ? 'ready' : (schemaApplied ? 'principal_unproven' : 'schema_unproven'),
  });
}

function resolveQuery(client) {
  if (!client || (typeof client !== 'object' && typeof client !== 'function') || isProxySurface(client)) {
    return null;
  }
  const own = objectGetOwnPropertyDescriptor(client, 'query');
  if (own) {
    return objectHasOwn(own, 'value') && typeof own.value === 'function' && !own.get && !own.set
      ? own.value
      : null;
  }
  let proto = objectGetPrototypeOf(client);
  let depth = 0;
  while (proto && proto !== objectPrototype && depth < 8) {
    if (isProxySurface(proto)) return null;
    const descriptor = objectGetOwnPropertyDescriptor(proto, 'query');
    if (descriptor) {
      return objectHasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
        && !descriptor.get && !descriptor.set
        ? descriptor.value
        : null;
    }
    proto = objectGetPrototypeOf(proto);
    depth += 1;
  }
  return null;
}

async function inspectEmailLunaControlledDraftingSession(client, binding, kind) {
  if (kind !== 'producer' && kind !== 'worker') return failedInspect();
  const closed = copyPlainSessionBinding(binding);
  if (!closed) return failedInspect();
  const queryFn = resolveQuery(client);
  if (typeof queryFn !== 'function' || isProxySurface(queryFn)) return failedInspect();
  const sql = kind === 'producer' ? PRODUCER_SESSION_PROOF_SQL : WORKER_SESSION_PROOF_SQL;
  let result;
  try {
    result = await queryFn.call(client, sql, [closed.client_id, closed.location_id, closed.location_key]);
  } catch (_) {
    return failedInspect();
  }
  if (!result || typeof result !== 'object' || isProxySurface(result) || arrayIsArray(result)) {
    return failedInspect();
  }
  const rows = ownData(result, 'rows');
  if (!arrayIsArray(rows) || rows.length !== 1 || isProxySurface(rows)) return failedInspect();
  const row = ownData(rows, 0);
  return evaluateInspectRow(copyPlainInspectRow(row));
}

module.exports = objectFreeze({
  MIGRATION_097_ID,
  MIGRATION_097_SHA256,
  EXPECTED_CHECKSUM_MODE,
  PRODUCER_SESSION_PROOF_SQL,
  WORKER_SESSION_PROOF_SQL,
  inspectEmailLunaControlledDraftingSession,
});
