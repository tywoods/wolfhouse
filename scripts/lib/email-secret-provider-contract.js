'use strict';

/**
 * Injected secret-provider contract for Luna email adapters (Slice 2A).
 *
 * Validates the required shape of an out-of-band secret provider and ensures
 * secret_ref is validated via Slice 1A before resolve. Resolved material is
 * returned only to the private adapter call site — never logged and never
 * embedded in public adapter errors.
 *
 * Own data properties only: accessor descriptors on the provider object are
 * rejected without invoking getters.
 *
 * @module email-secret-provider-contract
 */

const {
  validateEmailMailboxSecretRef,
} = require('./email-mailbox-adapter-contract');

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fail(error, details) {
  const out = { ok: false, error: String(error) };
  if (details !== undefined) out.details = details;
  return out;
}

function ok(value) {
  return value === undefined ? { ok: true } : { ok: true, value };
}

/**
 * Read own data property without invoking getters.
 * @param {object} obj
 * @param {string} key
 */
function readOwnDataProp(obj, key) {
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
 * Validate injected secret provider shape.
 * Required: own data-property `resolveSecret` that is a function.
 * No other contract surface is required. No default provider.
 *
 * @param {unknown} provider
 * @returns {{ok:true,value:object}|{ok:false,error:string,details?:object}}
 */
function validateEmailSecretProvider(provider) {
  if (!isPlainObject(provider)) {
    return fail('secret_provider_invalid', { reason: 'must_be_object' });
  }
  // Reject symbol keys on the provider surface.
  for (const key of Reflect.ownKeys(provider)) {
    if (typeof key === 'symbol') {
      return fail('secret_provider_invalid', { reason: 'symbol_key' });
    }
  }
  const resolveRead = readOwnDataProp(provider, 'resolveSecret');
  if (!resolveRead.present) {
    return fail('secret_provider_invalid', { reason: 'resolveSecret_required' });
  }
  if (resolveRead.accessor) {
    return fail('secret_provider_invalid', { reason: 'resolveSecret_accessor' });
  }
  if (typeof resolveRead.value !== 'function') {
    return fail('secret_provider_invalid', { reason: 'resolveSecret_must_be_function' });
  }
  return ok(provider);
}

/**
 * Validate opaque secret_ref (1A) then resolve via injected provider.
 * Returns resolved material only to the caller (adapter private flow).
 * Never logs material. On provider throw, returns sanitized failure without
 * raw err.message / secret_ref / material.
 *
 * @param {unknown} provider validated or raw provider object
 * @param {unknown} secretRef
 * @returns {Promise<{ok:true,value:unknown}|{ok:false,error:string,details?:object}>}
 */
async function resolveEmailMailboxSecret(provider, secretRef) {
  const shape = validateEmailSecretProvider(provider);
  if (!shape.ok) return shape;

  const ref = validateEmailMailboxSecretRef(secretRef);
  if (!ref.ok) {
    // Do not echo secret_ref in details.
    return fail('secret_ref_invalid', ref.details ? { reason: ref.error } : undefined);
  }

  let material;
  try {
    material = await provider.resolveSecret(ref.value);
  } catch (_err) {
    // Never surface raw err.message (may contain planted credentials).
    return fail('secret_resolve_failed');
  }

  if (material === undefined || material === null) {
    return fail('secret_resolve_failed');
  }
  return ok(material);
}

module.exports = {
  validateEmailSecretProvider,
  resolveEmailMailboxSecret,
};
