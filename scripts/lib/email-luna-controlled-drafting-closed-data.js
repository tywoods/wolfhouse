'use strict';

/**
 * Shared closed own-data helpers for Stage 2 controlled drafting.
 * Narrow internal owner: descriptor-safe reads, proxy rejection, UUID/digest.
 * Callers throw their own package errors; this module returns null/false.
 */

const util = require('node:util');
const nodeCrypto = require('node:crypto');

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const objectCreate = Object.create;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const arrayIncludes = uncurryThis(Array.prototype.includes);
const regexpTest = uncurryThis(RegExp.prototype.test);

const PINNED_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_TYPES && typeof PINNED_TYPES.isProxy === 'function'
  ? PINNED_TYPES.isProxy.bind(PINNED_TYPES)
  : null;
const cryptoCreateHash = typeof nodeCrypto.createHash === 'function'
  ? nodeCrypto.createHash.bind(nodeCrypto)
  : null;

const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_CANON = /^[0-9a-f]{64}$/;

function isProxySurface(value) {
  try {
    if (!PINNED_IS_PROXY) return true;
    return PINNED_IS_PROXY(value) === true;
  } catch (_) {
    return true;
  }
}

function ownData(object, key) {
  try {
    const descriptor = objectGetOwnPropertyDescriptor(object, key);
    if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
      return undefined;
    }
    return descriptor.value;
  } catch (_) {
    return undefined;
  }
}

function exactOwnData(value, keys) {
  if (value === null || typeof value !== 'object' || arrayIsArray(value) || isProxySurface(value)) {
    return null;
  }
  try {
    const proto = objectGetPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = reflectOwnKeys(value);
    if (actual.length !== keys.length) return null;
    const copy = objectCreate(null);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (!arrayIncludes(actual, key) || typeof key !== 'string') return null;
      const descriptor = objectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
        return null;
      }
      copy[key] = descriptor.value;
    }
    return copy;
  } catch (_) {
    return null;
  }
}

function subsetOwnData(value, allowed) {
  if (value === null || typeof value !== 'object' || arrayIsArray(value) || isProxySurface(value)) {
    return null;
  }
  try {
    const proto = objectGetPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = reflectOwnKeys(value);
    const copy = objectCreate(null);
    for (let i = 0; i < actual.length; i += 1) {
      const key = actual[i];
      if (typeof key !== 'string' || !arrayIncludes(allowed, key)) return null;
      const descriptor = objectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
        return null;
      }
      copy[key] = descriptor.value;
    }
    return copy;
  } catch (_) {
    return null;
  }
}

function isCanonUuid(value) {
  return typeof value === 'string' && regexpTest(UUID_CANON, value);
}

function digestUtf8(value) {
  if (!cryptoCreateHash || typeof value !== 'string') return null;
  try {
    const hasher = cryptoCreateHash('sha256');
    hasher.update(value, 'utf8');
    const hex = hasher.digest('hex');
    return typeof hex === 'string' && regexpTest(DIGEST_CANON, hex) ? hex : null;
  } catch (_) {
    return null;
  }
}

module.exports = objectFreeze({
  UUID_CANON,
  DIGEST_CANON,
  isProxySurface,
  ownData,
  exactOwnData,
  subsetOwnData,
  isCanonUuid,
  digestUtf8,
});
