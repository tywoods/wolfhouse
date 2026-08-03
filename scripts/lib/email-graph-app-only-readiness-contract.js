'use strict';

/**
 * Microsoft Graph app-only read-readiness contract (Luna email Slice 2B).
 *
 * Pure offline, provider-specific security-prerequisite declaration.
 * Freezes the machine-checkable evidence an operator must provide *before*
 * any later human-authorized live Graph integration. Does **not** perform
 * readiness discovery, call Azure/Entra/Graph/Key Vault, or enable network.
 *
 * A complete valid declaration may report
 * `ready_for_human_authorized_live_prerequisite_check: true` but must never
 * claim Azure/Entra/mailbox facts were independently verified.
 *
 * Success `secret_package` validates the opaque 1A `secret_ref` on input but
 * returns only `secret_ref_present: true` plus exact `material_keys` — never
 * serializes the ref value. All ok/fail envelopes and nested details/value are
 * fresh and deeply frozen. Error details use stable allowlisted reasons/codes
 * only (never attacker-controlled key names or raw values).
 *
 * Own-data properties only: accessors, symbols, inherited values, arrays at
 * the root, unknown keys, and prototype tricks are rejected without invoking
 * getters or value coercion.
 *
 * Public `evaluateEmailGraphAppOnlyReadiness` is a never-throw catch-all over
 * an internal implementation: hostile Proxy reflection traps and unexpected
 * runtime exceptions yield a fresh deeply frozen sanitized fail
 * (`declaration_invalid` / `reflection_failed`) with no err/message/input/key.
 * `isEmailGraphAppOnlyReadinessComplete` calls only that public boundary.
 *
 * @module email-graph-app-only-readiness-contract
 */

const {
  validateEmailMailboxSecretRef,
} = require('./email-mailbox-adapter-contract');

/** Fixed provider id for this contract (microsoft_graph only). */
const EMAIL_GRAPH_APP_ONLY_PROVIDER = 'microsoft_graph';

/** App-only OAuth client-credentials mode (exact). */
const EMAIL_GRAPH_APP_ONLY_AUTH_MODE = 'application_client_credentials';

/**
 * Exact least-privilege application permission set for list-envelope read.
 * Starting point only; extras / Mail.Read / Mail.ReadWrite fail closed.
 */
const EMAIL_GRAPH_APP_ONLY_PERMISSION_SET = Object.freeze([
  'Mail.ReadBasic.All',
]);

/** Exact secret-package material key names (no raw values). */
const EMAIL_GRAPH_APP_ONLY_MATERIAL_KEYS = Object.freeze([
  'tenant_id',
  'client_id',
  'client_secret',
]);

/** First-test mailbox — sole allowed public address for v1 scope. */
const EMAIL_GRAPH_APP_ONLY_FIRST_TEST_PUBLIC_ADDRESS = 'support@lunafrontdesk.com';

/**
 * Mailbox-scoping mechanism: application access policy / RBAC constrained to
 * the first-test mailbox only (not tenant-wide / all mailboxes).
 */
const EMAIL_GRAPH_APP_ONLY_MAILBOX_SCOPE_MECHANISM = 'application_access_policy';

/** Automation must remain off for a readiness declaration. */
const EMAIL_GRAPH_APP_ONLY_AUTOMATION_MODE = 'off';

/**
 * Stable allowlisted missing-requirement identifiers (never free-form text).
 * Used only on structurally valid but incomplete declarations.
 */
const EMAIL_GRAPH_APP_ONLY_MISSING_REQUIREMENT_IDS = Object.freeze([
  'admin_consent_confirmed',
]);

/** Exact top-level own-data keys for a readiness declaration. */
const DECLARATION_KEYS = Object.freeze([
  'provider',
  'auth_mode',
  'permission_set',
  'admin_consent_confirmed',
  'mailbox_scope',
  'secret_package',
  'network_enabled',
  'registry_activation_enabled',
  'inbound_enabled',
  'outbound_enabled',
  'default_automation_mode',
]);
const DECLARATION_KEY_SET = new Set(DECLARATION_KEYS);

/** Nested mailbox_scope exact keys. */
const MAILBOX_SCOPE_KEYS = Object.freeze([
  'mechanism',
  'allowed_public_addresses',
]);
const MAILBOX_SCOPE_KEY_SET = new Set(MAILBOX_SCOPE_KEYS);

/** Nested secret_package exact keys (ref + key *names* only). */
const SECRET_PACKAGE_KEYS = Object.freeze([
  'secret_ref',
  'material_keys',
]);
const SECRET_PACKAGE_KEY_SET = new Set(SECRET_PACKAGE_KEYS);

/**
 * Forbidden credential / injection keys anywhere on declaration surfaces.
 * Presence fails closed (even nested under secret_package extras).
 */
const FORBIDDEN_VALUE_KEYS = Object.freeze([
  'access_token',
  'client_secret',
  'tenant_id',
  'password',
  'api_key',
  'Authorization',
  'authorization',
  'token',
  'refresh_token',
  'raw_secret',
  'clientSecret',
  'accessToken',
]);
const FORBIDDEN_VALUE_KEY_SET = new Set(FORBIDDEN_VALUE_KEYS);

const PERMISSION_SET_EXACT = new Set(EMAIL_GRAPH_APP_ONLY_PERMISSION_SET);
const MATERIAL_KEY_SET = new Set(EMAIL_GRAPH_APP_ONLY_MATERIAL_KEYS);
const MISSING_REQUIREMENT_SET = new Set(EMAIL_GRAPH_APP_ONLY_MISSING_REQUIREMENT_IDS);

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Fresh deep-frozen clone of plain JSON-like values (objects/arrays/primitives).
 * Used for ok/fail envelopes so callers cannot mutate shared nested details/value.
 * @param {unknown} value
 * @returns {unknown}
 */
function deepFreezeFresh(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const arr = new Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      arr[i] = deepFreezeFresh(value[i]);
    }
    return Object.freeze(arr);
  }
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = deepFreezeFresh(value[key]);
  }
  return Object.freeze(out);
}

/**
 * Stable fail envelope: fresh + deeply frozen; details never share caller refs.
 * Details must be allowlisted codes/reasons only (never attacker key names/values).
 * Callers at the public catch boundary must pass constant internal data only
 * (never `err`, messages, input, or attacker-controlled keys/values).
 * @param {string} error
 * @param {object} [details]
 */
function fail(error, details) {
  const out = { ok: false, error: String(error) };
  if (details !== undefined) {
    out.details = deepFreezeFresh(details);
  }
  return Object.freeze(out);
}

/**
 * Constant-only sanitized failure for unexpected reflection/runtime exceptions.
 * Built from frozen literals only — never touches err/message/input/key.
 * @returns {{ok:false,error:string,details:Readonly<{reason:string}>}}
 */
function failReflectionBoundary() {
  // Literals only: fail construction must not depend on untrusted objects.
  return fail('declaration_invalid', { reason: 'reflection_failed' });
}

/**
 * Stable success envelope: fresh + deeply frozen value tree.
 * @param {unknown} [value]
 */
function ok(value) {
  if (value === undefined) {
    return Object.freeze({ ok: true });
  }
  return Object.freeze({ ok: true, value: deepFreezeFresh(value) });
}

/**
 * Read an own data property without invoking getters/setters.
 * @param {object} obj
 * @param {string|symbol} key
 * @returns {{present:false}|{present:true,accessor:true}|{present:true,value:unknown}}
 */
function readOwnDataProp(obj, key) {
  if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function')) {
    return { present: false };
  }
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    return { present: false };
  }
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (!desc) return { present: false };
  if (typeof desc.get === 'function' || typeof desc.set === 'function') {
    return { present: true, accessor: true };
  }
  return { present: true, value: desc.value };
}

/**
 * Snapshot own data string-key properties into a null-prototype object.
 * Rejects symbols and accessors without invocation. Does not coerce values.
 * @param {unknown} obj
 * @returns {{ok:true,value:object}|{ok:false,reason:string,key?:string}}
 */
function snapshotOwnDataProps(obj) {
  if (!isPlainObject(obj)) {
    return { ok: false, reason: 'must_be_object' };
  }
  // Null prototype: keys such as `__proto__` stay ordinary own data properties.
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key === 'symbol') {
      return { ok: false, reason: 'symbol_key' };
    }
    const read = readOwnDataProp(obj, key);
    if (!read.present) continue;
    if (read.accessor) {
      return { ok: false, reason: 'accessor', key: String(key) };
    }
    out[key] = read.value;
  }
  return { ok: true, value: out };
}

/**
 * Exact set equality for own string keys of a snapshotted object.
 * @param {object} snap
 * @param {readonly string[]} exactKeys
 * @param {Set<string>} exactSet
 */
function ownKeysExactly(snap, exactKeys, exactSet) {
  const keys = Object.keys(snap);
  if (keys.length !== exactKeys.length) return false;
  for (const key of keys) {
    if (!exactSet.has(key)) return false;
  }
  return true;
}

/**
 * Snapshot a dense string array without coercion.
 * Rejects non-arrays, sparse holes (missing own index), accessors on indices,
 * symbol keys, and non-string elements.
 * @param {unknown} arr
 * @returns {{ok:true,value:string[]}|{ok:false,reason:string}}
 */
function snapshotStringArray(arr) {
  if (!Array.isArray(arr)) {
    return { ok: false, reason: 'must_be_array' };
  }
  const proto = Object.getPrototypeOf(arr);
  if (proto !== Array.prototype && proto !== null) {
    return { ok: false, reason: 'array_prototype' };
  }
  for (const key of Reflect.ownKeys(arr)) {
    if (typeof key === 'symbol') {
      return { ok: false, reason: 'symbol_key' };
    }
    // Allow only dense indices and standard 'length' data property.
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key)) {
      return { ok: false, reason: 'array_extra_key' };
    }
  }
  const out = [];
  for (let i = 0; i < arr.length; i += 1) {
    const read = readOwnDataProp(arr, String(i));
    if (!read.present) {
      return { ok: false, reason: 'sparse_array' };
    }
    if (read.accessor) {
      return { ok: false, reason: 'accessor' };
    }
    if (typeof read.value !== 'string') {
      return { ok: false, reason: 'non_string_element' };
    }
    out.push(read.value);
  }
  return { ok: true, value: out };
}

/**
 * True iff string array is set-equal to expected (order-independent, no dups).
 * @param {string[]} actual
 * @param {ReadonlyArray<string>} expected
 * @param {Set<string>} expectedSet
 */
function stringArraySetEqual(actual, expected, expectedSet) {
  if (actual.length !== expected.length) return false;
  const seen = new Set();
  for (const item of actual) {
    if (!expectedSet.has(item)) return false;
    if (seen.has(item)) return false;
    seen.add(item);
  }
  return seen.size === expected.length;
}

/**
 * Reject forbidden credential-shaped keys on a snapshotted object.
 * @param {object} snap
 * @returns {{ok:true}|{ok:false,error:string,details?:object}}
 */
function rejectForbiddenKeys(snap) {
  for (const key of Object.keys(snap)) {
    if (FORBIDDEN_VALUE_KEY_SET.has(key)) {
      // Never echo the key name or value — stable reason only.
      return fail('declaration_forbidden_field', { reason: 'forbidden_field' });
    }
  }
  return ok();
}

/**
 * Validate mailbox_scope nested object.
 * @param {unknown} raw
 * @returns {{ok:true,value:object}|{ok:false,error:string,details?:object}}
 */
function validateMailboxScope(raw) {
  const snap = snapshotOwnDataProps(raw);
  if (!snap.ok) {
    return fail('mailbox_scope_invalid', { reason: snap.reason });
  }
  const scope = snap.value;
  const forbidden = rejectForbiddenKeys(scope);
  if (!forbidden.ok) return forbidden;

  if (!ownKeysExactly(scope, MAILBOX_SCOPE_KEYS, MAILBOX_SCOPE_KEY_SET)) {
    for (const key of Object.keys(scope)) {
      if (!MAILBOX_SCOPE_KEY_SET.has(key)) {
        return fail('mailbox_scope_invalid', { reason: 'unknown_key' });
      }
    }
    return fail('mailbox_scope_invalid', { reason: 'key_set' });
  }

  if (scope.mechanism !== EMAIL_GRAPH_APP_ONLY_MAILBOX_SCOPE_MECHANISM) {
    // Fail closed for multi/all/tenant-wide mechanisms.
    return fail('mailbox_scope_invalid', { reason: 'mechanism' });
  }

  const addresses = snapshotStringArray(scope.allowed_public_addresses);
  if (!addresses.ok) {
    return fail('mailbox_scope_invalid', { reason: addresses.reason });
  }
  // Exact single first-test address only — no multi-mailbox / all-mailbox.
  if (addresses.value.length !== 1) {
    return fail('mailbox_scope_invalid', { reason: 'address_count' });
  }
  // Exact match only — no trim/case coercion of hostile values.
  if (addresses.value[0] !== EMAIL_GRAPH_APP_ONLY_FIRST_TEST_PUBLIC_ADDRESS) {
    return fail('mailbox_scope_invalid', { reason: 'address_not_first_test' });
  }

  return ok({
    mechanism: EMAIL_GRAPH_APP_ONLY_MAILBOX_SCOPE_MECHANISM,
    allowed_public_addresses: [EMAIL_GRAPH_APP_ONLY_FIRST_TEST_PUBLIC_ADDRESS],
  });
}

/**
 * Validate secret_package: opaque 1A secret_ref + exact material key *names*.
 * Never accepts raw secret values.
 * @param {unknown} raw
 * @returns {{ok:true,value:object}|{ok:false,error:string,details?:object}}
 */
function validateSecretPackage(raw) {
  const snap = snapshotOwnDataProps(raw);
  if (!snap.ok) {
    return fail('secret_package_invalid', { reason: snap.reason });
  }
  const pkg = snap.value;

  // Fail closed if raw credential keys appear on the package surface.
  for (const key of Object.keys(pkg)) {
    if (key === 'access_token' || key === 'client_secret' || key === 'tenant_id'
        || key === 'password' || key === 'api_key' || key === 'token'
        || key === 'refresh_token' || key === 'raw_secret'
        || key === 'clientSecret' || key === 'accessToken'
        || key === 'Authorization' || key === 'authorization') {
      // material_keys is the only place "client_secret" may appear as a *name*
      // inside the string array — not as an object key holding a value.
      if (key !== 'material_keys' && key !== 'secret_ref') {
        return fail('secret_package_invalid', { reason: 'raw_credential_key' });
      }
    }
  }

  if (!ownKeysExactly(pkg, SECRET_PACKAGE_KEYS, SECRET_PACKAGE_KEY_SET)) {
    for (const key of Object.keys(pkg)) {
      if (!SECRET_PACKAGE_KEY_SET.has(key)) {
        return fail('secret_package_invalid', { reason: 'unknown_key' });
      }
    }
    return fail('secret_package_invalid', { reason: 'key_set' });
  }

  // Reuse Slice 1A secret_ref validation — never invent a weaker parser.
  // Validated for shape only; the opaque ref value is never returned on success.
  const ref = validateEmailMailboxSecretRef(pkg.secret_ref);
  if (!ref.ok) {
    // Do not echo secret_ref, scheme, body, or raw 1A details. Stable reason codes only.
    // Prefer 1A details.reason when present; else map error code (never scheme/value).
    let reason = 'invalid';
    if (ref.details && typeof ref.details.reason === 'string') {
      reason = ref.details.reason;
    } else if (typeof ref.error === 'string') {
      reason = ref.error;
    }
    return fail('secret_ref_invalid', { reason });
  }

  const keysSnap = snapshotStringArray(pkg.material_keys);
  if (!keysSnap.ok) {
    return fail('secret_package_invalid', { reason: keysSnap.reason });
  }
  // Reject access_token material key and any extras / missing keys.
  for (const k of keysSnap.value) {
    if (k === 'access_token') {
      return fail('secret_package_invalid', { reason: 'access_token_forbidden' });
    }
  }
  if (!stringArraySetEqual(
    keysSnap.value,
    EMAIL_GRAPH_APP_ONLY_MATERIAL_KEYS,
    MATERIAL_KEY_SET,
  )) {
    return fail('secret_package_invalid', { reason: 'material_keys' });
  }

  // Public DTO: secret_ref_present only — never serialize the opaque ref value.
  return ok({
    secret_ref_present: true,
    material_keys: EMAIL_GRAPH_APP_ONLY_MATERIAL_KEYS.slice(),
  });
}

/**
 * Validate permission_set exact least-privilege allowlist.
 * @param {unknown} raw
 * @returns {{ok:true,value:ReadonlyArray<string>}|{ok:false,error:string,details?:object}}
 */
function validatePermissionSet(raw) {
  const snap = snapshotStringArray(raw);
  if (!snap.ok) {
    return fail('permission_set_invalid', { reason: snap.reason });
  }
  // Reject known broader permissions explicitly (still covered by set-equal).
  for (const p of snap.value) {
    if (
      p === 'Mail.Read'
      || p === 'Mail.ReadWrite'
      || p === 'Mail.Send'
      || p === 'Mail.ReadWrite.All'
      || p === 'Mail.Read.All'
      || p === 'Mail.Send.All'
    ) {
      return fail('permission_set_invalid', { reason: 'broader_permission' });
    }
  }
  if (!stringArraySetEqual(
    snap.value,
    EMAIL_GRAPH_APP_ONLY_PERMISSION_SET,
    PERMISSION_SET_EXACT,
  )) {
    return fail('permission_set_invalid', { reason: 'not_least_privilege' });
  }
  return ok(EMAIL_GRAPH_APP_ONLY_PERMISSION_SET.slice());
}

/**
 * Require exact boolean false for a fail-closed kill/safety flag.
 * Field identity uses an allowlisted reason token (never raw attacker input).
 * @param {unknown} v
 * @param {'network_enabled'|'registry_activation_enabled'|'inbound_enabled'|'outbound_enabled'} field
 * @returns {{ok:true}|{ok:false,error:string,details?:object}}
 */
function requireExactFalse(v, field) {
  if (v !== false) {
    // Allowlisted field tokens only (caller-controlled constants, not free-form input).
    return fail('network_or_activation_invalid', { reason: 'flag_not_false', field });
  }
  return ok();
}

/**
 * Internal evaluator (may throw on hostile Proxy reflection traps).
 * Public callers must use `evaluateEmailGraphAppOnlyReadiness` only.
 *
 * Distinguishes:
 * - structurally invalid input → `{ ok:false, error }` stable codes only
 * - valid but incomplete → `{ ok:true, value }` with
 *   `ready_for_human_authorized_live_prerequisite_check: false` and
 *   allowlisted `missing_requirements`
 * - complete valid → ready flag true, empty missing_requirements
 *
 * Never claims Azure/Entra/mailbox facts were independently verified.
 *
 * @param {unknown} input
 * @returns {{ok:true,value:Readonly<object>}|{ok:false,error:string,details?:object}}
 */
function evaluateEmailGraphAppOnlyReadinessImpl(input) {
  const snap = snapshotOwnDataProps(input);
  if (!snap.ok) {
    return fail('declaration_invalid', { reason: snap.reason });
  }
  const decl = snap.value;

  // Reject prototype pollution / credential keys at top level early.
  const forbidden = rejectForbiddenKeys(decl);
  if (!forbidden.ok) return forbidden;

  for (const key of Object.keys(decl)) {
    if (!DECLARATION_KEY_SET.has(key)) {
      // Never echo attacker-controlled unknown key names — stable reason only.
      return fail('declaration_unknown_key', { reason: 'unknown_key' });
    }
  }
  for (const required of DECLARATION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(decl, required)) {
      // `required` is from the fixed allowlist DECLARATION_KEYS (not free-form input).
      return fail('declaration_missing_key', { reason: 'missing_key', key: required });
    }
  }

  // provider — exact, no coercion
  if (decl.provider !== EMAIL_GRAPH_APP_ONLY_PROVIDER) {
    return fail('provider_invalid');
  }

  // auth_mode — exact application client credentials
  if (decl.auth_mode !== EMAIL_GRAPH_APP_ONLY_AUTH_MODE) {
    return fail('auth_mode_invalid');
  }

  const permissions = validatePermissionSet(decl.permission_set);
  if (!permissions.ok) return permissions;

  // admin_consent_confirmed — must be boolean; false ⇒ incomplete, not invalid
  if (decl.admin_consent_confirmed !== true && decl.admin_consent_confirmed !== false) {
    return fail('admin_consent_invalid', { reason: 'must_be_boolean' });
  }
  const adminConsent = decl.admin_consent_confirmed === true;

  const mailboxScope = validateMailboxScope(decl.mailbox_scope);
  if (!mailboxScope.ok) return mailboxScope;

  const secretPackage = validateSecretPackage(decl.secret_package);
  if (!secretPackage.ok) return secretPackage;

  // Fail closed if any network / activation / traffic flag is not exact false.
  const net = requireExactFalse(decl.network_enabled, 'network_enabled');
  if (!net.ok) return net;
  const reg = requireExactFalse(decl.registry_activation_enabled, 'registry_activation_enabled');
  if (!reg.ok) return reg;
  const inbound = requireExactFalse(decl.inbound_enabled, 'inbound_enabled');
  if (!inbound.ok) return inbound;
  const outbound = requireExactFalse(decl.outbound_enabled, 'outbound_enabled');
  if (!outbound.ok) return outbound;

  if (decl.default_automation_mode !== EMAIL_GRAPH_APP_ONLY_AUTOMATION_MODE) {
    return fail('automation_mode_invalid');
  }

  // Missing requirements: allowlisted identifiers only.
  const missing = [];
  if (!adminConsent) {
    missing.push('admin_consent_confirmed');
  }
  // Guard: only emit allowlisted ids.
  for (const id of missing) {
    if (!MISSING_REQUIREMENT_SET.has(id)) {
      return fail('declaration_invalid', { reason: 'missing_id_not_allowlisted' });
    }
  }

  const ready = missing.length === 0;

  // Fresh allowlisted deeply frozen DTO via ok() — never pass through raw input;
  // never include secret_ref value (secret_package carries secret_ref_present only).
  return ok({
    provider: EMAIL_GRAPH_APP_ONLY_PROVIDER,
    auth_mode: EMAIL_GRAPH_APP_ONLY_AUTH_MODE,
    permission_set: permissions.value,
    admin_consent_confirmed: adminConsent,
    mailbox_scope: mailboxScope.value,
    secret_package: secretPackage.value,
    network_enabled: false,
    registry_activation_enabled: false,
    inbound_enabled: false,
    outbound_enabled: false,
    default_automation_mode: EMAIL_GRAPH_APP_ONLY_AUTOMATION_MODE,
    ready_for_human_authorized_live_prerequisite_check: ready,
    missing_requirements: missing.slice(),
    // Explicit non-claims: this contract never independently verifies live facts.
    azure_facts_independently_verified: false,
    entra_facts_independently_verified: false,
    mailbox_facts_independently_verified: false,
  });
}

/**
 * Public evaluator: never throws for any input.
 *
 * Wraps the internal implementation in a catch-all boundary. Hostile Proxy
 * reflection traps (`getPrototypeOf` / `ownKeys` / `getOwnPropertyDescriptor`)
 * and other unexpected runtime exceptions become a fresh deeply frozen
 * sanitized failure with allowlisted `declaration_invalid` /
 * `reflection_failed` only — never err, message, input, or key.
 *
 * Policy semantics for ordinary no-getter plain data are unchanged.
 *
 * @param {unknown} input
 * @returns {{ok:true,value:Readonly<object>}|{ok:false,error:string,details?:object}}
 */
function evaluateEmailGraphAppOnlyReadiness(input) {
  try {
    return evaluateEmailGraphAppOnlyReadinessImpl(input);
  } catch {
    // Constant internal data only — never err/message/input/key.
    return failReflectionBoundary();
  }
}

/**
 * True iff evaluation ok and ready_for_human_authorized_live_prerequisite_check.
 * Convenience helper for later live slices; never implies live verification.
 * Calls only the public (caught) evaluator; returns false and never throws.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
function isEmailGraphAppOnlyReadinessComplete(input) {
  try {
    const result = evaluateEmailGraphAppOnlyReadiness(input);
    return Boolean(
      result
      && result.ok
      && result.value
      && result.value.ready_for_human_authorized_live_prerequisite_check === true,
    );
  } catch {
    // Public evaluator must not throw; belt-and-suspenders → false.
    return false;
  }
}

module.exports = {
  evaluateEmailGraphAppOnlyReadiness,
  isEmailGraphAppOnlyReadinessComplete,
  EMAIL_GRAPH_APP_ONLY_PROVIDER,
  EMAIL_GRAPH_APP_ONLY_AUTH_MODE,
  EMAIL_GRAPH_APP_ONLY_PERMISSION_SET,
  EMAIL_GRAPH_APP_ONLY_MATERIAL_KEYS,
  EMAIL_GRAPH_APP_ONLY_FIRST_TEST_PUBLIC_ADDRESS,
  EMAIL_GRAPH_APP_ONLY_MAILBOX_SCOPE_MECHANISM,
  EMAIL_GRAPH_APP_ONLY_AUTOMATION_MODE,
  EMAIL_GRAPH_APP_ONLY_MISSING_REQUIREMENT_IDS,
};
