'use strict';

/**
 * FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B7: live dedicated-worker session
 * proof. Proves session_user=current_user, non-owner, exact worker mapping,
 * 095 EXECUTE, and 094/095 function contracts on the claim session.
 * Mapping is proven via SECURITY DEFINER principal_authorized (workers have
 * no SELECT on the principals table). Table-owner bypass of that function is
 * rejected separately (session_user must not be table owner).
 * Copy/validate plain scalars only. Never logs credentials.
 */

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const runtimeIsProxy = require('node:util').types.isProxy.bind(undefined);

const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectHasOwn = Object.hasOwn;
const arrayIsArray = Array.isArray;
const arrayIncludes = uncurryThis(Array.prototype.includes);

const CLAIM_SCOPED_REG =
  'public.tenant_email_luna_automation_claim_scoped(uuid, uuid, uuid, text, uuid)';
const PROJECT_REG =
  'public.tenant_email_luna_automation_shadow_outcome_project(uuid, uuid)';
const PRINCIPAL_REG =
  'public.tenant_email_luna_automation_principal_authorized(text, uuid, uuid, text)';
const CAPTURE_REG = 'public.tenant_email_luna_automation_capture_shadow(uuid, uuid)';
const LOAD_REG = 'public.tenant_email_luna_automation_shadow_outcome_load(uuid, uuid)';

const BOOLEAN_KEYS = objectFreeze([
  'outcomes_table',
  'capture_fn',
  'load_fn',
  'project_fn',
  'principal_fn',
  'scoped_claim_fn',
  'session_matches_current',
  'worker_mapping_ok',
  'scoped_claim_execute',
]);
const STRING_KEYS = objectFreeze(['session_user', 'current_user', 'table_owner']);
const NULLABLE_STRING_KEYS = objectFreeze(['project_def', 'scoped_claim_def']);
const INSPECT_KEYS = objectFreeze([
  ...BOOLEAN_KEYS,
  ...STRING_KEYS,
  ...NULLABLE_STRING_KEYS,
]);

const SESSION_PROOF_SQL = [
  'SELECT',
  '  EXISTS (',
  '    SELECT 1 FROM pg_catalog.pg_class c',
  '    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
  "    WHERE n.nspname = 'public'",
  "      AND c.relname = 'tenant_email_luna_automation_shadow_outcomes'",
  "      AND c.relkind = 'r'",
  '  ) AS outcomes_table,',
  `  pg_catalog.to_regprocedure('${CAPTURE_REG}') IS NOT NULL AS capture_fn,`,
  `  pg_catalog.to_regprocedure('${LOAD_REG}') IS NOT NULL AS load_fn,`,
  `  pg_catalog.to_regprocedure('${PROJECT_REG}') IS NOT NULL AS project_fn,`,
  `  pg_catalog.to_regprocedure('${PRINCIPAL_REG}') IS NOT NULL AS principal_fn,`,
  `  pg_catalog.to_regprocedure('${CLAIM_SCOPED_REG}') IS NOT NULL AS scoped_claim_fn,`,
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
  '  CASE',
  `    WHEN pg_catalog.to_regprocedure('${PRINCIPAL_REG}') IS NULL THEN FALSE`,
  "    ELSE public.tenant_email_luna_automation_principal_authorized('worker', $1::uuid, $2::uuid, $3::text)",
  '  END AS worker_mapping_ok,',
  '  CASE',
  `    WHEN pg_catalog.to_regprocedure('${CLAIM_SCOPED_REG}') IS NULL THEN FALSE`,
  '    ELSE pg_catalog.has_function_privilege(',
  '      session_user,',
  `      '${CLAIM_SCOPED_REG}'::pg_catalog.regprocedure,`,
  "      'EXECUTE'",
  '    )',
  '  END AS scoped_claim_execute,',
  '  CASE',
  `    WHEN pg_catalog.to_regprocedure('${PROJECT_REG}') IS NULL THEN NULL`,
  `    ELSE pg_catalog.pg_get_functiondef('${PROJECT_REG}'::pg_catalog.regprocedure)`,
  '  END AS project_def,',
  '  CASE',
  `    WHEN pg_catalog.to_regprocedure('${CLAIM_SCOPED_REG}') IS NULL THEN NULL`,
  `    ELSE pg_catalog.pg_get_functiondef('${CLAIM_SCOPED_REG}'::pg_catalog.regprocedure)`,
  '  END AS scoped_claim_def',
].join('\n');

function freeze(value) {
  return objectFreeze(value);
}

function failedInspect() {
  return freeze({
    ok: false,
    inspect_failed: true,
    schema_applied: false,
    principal_applied: false,
    identity_label_applied: false,
    scoped_claim_applied: false,
    worker_principal_ok: false,
  });
}

function projectDefSafe(def) {
  if (typeof def !== 'string') return false;
  return def.indexOf("matched := 'staff_action_observed'") !== -1
    && def.indexOf("matched := 'agreement'") === -1;
}

function scopedClaimDefSafe(def) {
  if (typeof def !== 'string') return false;
  return def.indexOf('FOR UPDATE SKIP LOCKED') !== -1
    && def.indexOf("principal_kind = 'worker'") !== -1
    && def.indexOf('session_user IS DISTINCT FROM') !== -1;
}

function copyPlainInspectRow(row) {
  try {
    if (!row || typeof row !== 'object' || runtimeIsProxy(row) || arrayIsArray(row)) return null;
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
  const schemaApplied = copy.outcomes_table === true
    && copy.capture_fn === true
    && copy.load_fn === true
    && copy.project_fn === true;
  const principalApplied = copy.principal_fn === true;
  const identityLabelApplied = projectDefSafe(copy.project_def);
  const scopedClaimApplied = copy.scoped_claim_fn === true && scopedClaimDefSafe(copy.scoped_claim_def);
  const workerPrincipalOk = copy.session_matches_current === true
    && copy.session_user === copy.current_user
    && copy.session_user !== copy.table_owner
    && copy.worker_mapping_ok === true
    && copy.scoped_claim_execute === true
    && principalApplied === true;
  const ok = schemaApplied === true
    && principalApplied === true
    && identityLabelApplied === true
    && scopedClaimApplied === true
    && workerPrincipalOk === true;
  return freeze({
    ok,
    inspect_failed: false,
    schema_applied: schemaApplied,
    principal_applied: principalApplied,
    identity_label_applied: identityLabelApplied,
    scoped_claim_applied: scopedClaimApplied,
    worker_principal_ok: workerPrincipalOk,
  });
}

async function inspectEmailLunaAutomationShadowWorkerSession(client, binding) {
  try {
    if (!client || typeof client !== 'object' || runtimeIsProxy(client) || arrayIsArray(client)) {
      return failedInspect();
    }
    if (typeof client.query !== 'function' || runtimeIsProxy(client.query)) return failedInspect();
    const clientId = binding && typeof binding.client_id === 'string' ? binding.client_id : null;
    const locationId = binding && typeof binding.location_id === 'string' ? binding.location_id : null;
    const locationKey = binding && typeof binding.location_key === 'string' ? binding.location_key : null;
    const result = await Promise.resolve(client.query(SESSION_PROOF_SQL, [
      clientId,
      locationId,
      locationKey,
    ]));
    const rows = result && arrayIsArray(result.rows) ? result.rows : [];
    if (rows.length !== 1) return failedInspect();
    const copy = copyPlainInspectRow(rows[0]);
    if (!copy) return failedInspect();
    return evaluateInspectRow(copy);
  } catch (_) {
    return failedInspect();
  }
}

module.exports = objectFreeze({
  SESSION_PROOF_SQL,
  INSPECT_KEYS,
  inspectEmailLunaAutomationShadowWorkerSession,
  copyPlainInspectRow,
  evaluateInspectRow,
  projectDefSafe,
  scopedClaimDefSafe,
});
