'use strict';

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const arrayIncludes = uncurryThis(Array.prototype.includes);
const arrayPush = uncurryThis(Array.prototype.push);
const objectFreeze = Object.freeze;
const objectCreate = Object.create;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const numberIsSafeInteger = Number.isSafeInteger;
const promiseThen = uncurryThis(Promise.prototype.then);
const promiseResolve = Promise.resolve.bind(Promise);
const promiseReject = Promise.reject.bind(Promise);
const stringTrim = uncurryThis(String.prototype.trim);
const nativePromisePrototype = Promise.prototype;

const MISSING_FACT = 'missing_fact';
const HANDOFF_REQUIRED = 'handoff_required';
const FACTS = objectFreeze(['catalog', 'availability', 'policy', 'booking', 'payment']);
const FACT_FIELDS = objectFreeze({
  catalog: objectFreeze(['item', 'label', 'currency', 'amount_cents', 'active']),
  availability: objectFreeze(['item', 'label', 'date', 'slot_time', 'available', 'capacity']),
  policy: objectFreeze(['label', 'policy_key', 'policy_text']),
  booking: objectFreeze(['label', 'booking_code', 'booking_status', 'check_in', 'check_out', 'guest_count']),
  payment: objectFreeze(['label', 'currency', 'payment_status', 'amount_paid_cents', 'balance_due_cents']),
});
const AUTHORITY_KEYS = objectFreeze(['client_id', 'location_id']);
const QUERY_KEYS = objectFreeze(['lookup']);
const WRAPPER_KEYS = objectFreeze(['rows']);
const ROW_CORE_KEYS = objectFreeze(['fact', 'status', 'client_id', 'location_id']);

function ownDataSnapshot(value, allowedKeys, requiredKeys = allowedKeys) {
  if (value === null || typeof value !== 'object' || arrayIsArray(value)) return null;
  try {
    const prototype = objectGetPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = reflectOwnKeys(value);
    for (const key of keys) if (typeof key !== 'string') return null;
    if (keys.length > allowedKeys.length) return null;
    for (const key of keys) if (!arrayIncludes(allowedKeys, key)) return null;
    for (const key of requiredKeys) if (!objectHasOwn(value, key)) return null;
    const snapshot = objectCreate(null);
    for (const key of keys) {
      const descriptor = objectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || !objectHasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (_) {
    return null;
  }
}

function safeScalar(value) {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function frozenRecord(entries) {
  const value = {};
  for (const [key, entry] of entries) value[key] = entry;
  return objectFreeze(value);
}

function typed(type, fact, reason, authority) {
  const entries = [['type', type], ['fact', fact], ['status', type]];
  if (reason) arrayPush(entries, ['reason', reason]);
  arrayPush(entries, ['client_id', authority.client_id], ['location_id', authority.location_id]);
  return frozenRecord(entries);
}

function snapshotAuthority(authority) {
  const snapshot = ownDataSnapshot(authority, AUTHORITY_KEYS);
  if (!snapshot
      || typeof snapshot.client_id !== 'string' || !stringTrim(snapshot.client_id)
      || typeof snapshot.location_id !== 'string' || !stringTrim(snapshot.location_id)) return null;
  return frozenRecord([['client_id', snapshot.client_id], ['location_id', snapshot.location_id]]);
}

function pinOwners(queryOwners) {
  const snapshot = ownDataSnapshot(queryOwners, FACTS);
  if (!snapshot) return null;
  const pinned = objectCreate(null);
  for (const fact of FACTS) {
    if (typeof snapshot[fact] !== 'function') return null;
    pinned[fact] = snapshot[fact];
  }
  return objectFreeze(pinned);
}

function snapshotArguments(args) {
  const snapshot = ownDataSnapshot(args, QUERY_KEYS, []);
  if (!snapshot) return null;
  if (objectHasOwn(snapshot, 'lookup') && !safeScalar(snapshot.lookup)) return null;
  const entries = [];
  if (objectHasOwn(snapshot, 'lookup')) arrayPush(entries, ['lookup', snapshot.lookup]);
  return frozenRecord(entries);
}

function snapshotArray(value) {
  if (!arrayIsArray(value)) return null;
  try {
    const keys = reflectOwnKeys(value);
    for (const key of keys) if (typeof key !== 'string') return null;
    const lengthDescriptor = objectGetOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !objectHasOwn(lengthDescriptor, 'value') || !numberIsSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return null;
    const length = lengthDescriptor.value;
    if (keys.length !== length + 1 || !arrayIncludes(keys, 'length')) return null;
    for (let index = 0; index < length; index += 1) if (!arrayIncludes(keys, String(index))) return null;
    const rows = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = objectGetOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !objectHasOwn(descriptor, 'value')) return null;
      arrayPush(rows, descriptor.value);
    }
    return rows;
  } catch (_) {
    return null;
  }
}

function sanitizeRow(row, fact, authority) {
  const allowed = [...ROW_CORE_KEYS, ...FACT_FIELDS[fact]];
  const snapshot = ownDataSnapshot(row, allowed, ROW_CORE_KEYS);
  if (!snapshot || snapshot.fact !== fact || snapshot.status !== 'found') return { kind: MISSING_FACT };
  if (snapshot.client_id !== authority.client_id || snapshot.location_id !== authority.location_id) return { kind: HANDOFF_REQUIRED };
  for (const key of reflectOwnKeys(snapshot)) if (!safeScalar(snapshot[key])) return { kind: MISSING_FACT };
  const entries = [
    ['fact', fact], ['status', 'found'],
    ['client_id', authority.client_id], ['location_id', authority.location_id],
  ];
  for (const key of FACT_FIELDS[fact]) if (objectHasOwn(snapshot, key)) arrayPush(entries, [key, snapshot[key]]);
  return { kind: 'found', value: frozenRecord(entries) };
}

function normalizeOwnerResult(result) {
  const directRows = snapshotArray(result);
  if (directRows) return { rows: directRows, shape: 'array' };
  const wrapper = ownDataSnapshot(result, WRAPPER_KEYS);
  if (wrapper) {
    const wrappedRows = snapshotArray(wrapper.rows);
    if (!wrappedRows) return null;
    return { rows: wrappedRows, shape: 'rows' };
  }
  if (result === null || typeof result !== 'object' || typeof result === 'function') return { rows: [result], shape: 'single' };
  return { rows: [result], shape: 'single' };
}

function createEmailLunaGroundedTools(configuration = {}) {
  const config = ownDataSnapshot(configuration, ['authority', 'queryOwners']);
  if (!config) throw new TypeError('invalid_grounded_tools_configuration');
  const pinnedAuthority = snapshotAuthority(config.authority);
  const pinnedOwners = pinOwners(config.queryOwners);
  if (!pinnedAuthority || !pinnedOwners) throw new TypeError('invalid_grounded_tools_configuration');

  function query(fact, args = {}) {
    const factName = typeof fact === 'string' ? fact : 'unknown_fact';
    const request = snapshotArguments(args);
    if (!request) return promiseReject(new TypeError('invalid_query_arguments'));
    if (!objectHasOwn(FACT_FIELDS, factName)) {
      return promiseResolve(typed(MISSING_FACT, factName, 'unknown_fact', pinnedAuthority));
    }

    let pending;
    try {
      pending = pinnedOwners[factName](pinnedAuthority, request);
      if (objectGetPrototypeOf(pending) !== nativePromisePrototype) {
        return promiseResolve(typed(HANDOFF_REQUIRED, factName, 'tool_error', pinnedAuthority));
      }
    } catch (_) {
      return promiseResolve(typed(HANDOFF_REQUIRED, factName, 'tool_error', pinnedAuthority));
    }

    return promiseThen(pending, (raw) => {
      const normalized = normalizeOwnerResult(raw);
      if (!normalized) return typed(MISSING_FACT, factName, 'malformed_fact', pinnedAuthority);
      if (!normalized.rows.length) return typed(MISSING_FACT, factName, 'not_found', pinnedAuthority);
      const values = [];
      for (const row of normalized.rows) {
        const checked = sanitizeRow(row, factName, pinnedAuthority);
        if (checked.kind === HANDOFF_REQUIRED) return typed(HANDOFF_REQUIRED, factName, 'authority_mismatch', pinnedAuthority);
        if (checked.kind === MISSING_FACT) return typed(MISSING_FACT, factName, 'malformed_fact', pinnedAuthority);
        arrayPush(values, checked.value);
      }
      if (normalized.shape === 'array') return objectFreeze(values);
      if (normalized.shape === 'rows') return frozenRecord([['rows', objectFreeze(values)]]);
      return values[0];
    }, () => typed(HANDOFF_REQUIRED, factName, 'tool_error', pinnedAuthority));
  }

  return objectFreeze({ authority: pinnedAuthority, query });
}

module.exports = { createEmailLunaGroundedTools, MISSING_FACT, HANDOFF_REQUIRED };
