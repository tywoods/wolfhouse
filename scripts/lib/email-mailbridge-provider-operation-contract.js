'use strict';

/**
 * MAILBRIDGE provider-operation contract.
 *
 * Provider SDKs implement this boundary. Shared authority, custody, cursor,
 * approval and journal layers consume normalized descriptors/results only.
 * This module performs no provider I/O and contains no credentials.
 */

const {
  EMAIL_MAILBOX_PROVIDERS,
  validateEmailMailboxProviderId,
} = require('./email-mailbox-adapter-contract');

const MAILBRIDGE_OUTCOMES = Object.freeze([
  'committed',
  'not_committed',
  'outcome_unknown',
  'reauthorization_required',
  'conflict',
]);
const MAILBRIDGE_OUTBOUND_METHODS = Object.freeze([
  'prepareReply',
  'applyApprovedBody',
  'dispatch',
  'reconcile',
]);
const OUTCOME_SET = new Set(MAILBRIDGE_OUTCOMES);
const OUTBOUND_METHOD_SET = new Set(MAILBRIDGE_OUTBOUND_METHODS);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const CURSOR_KEYS = Object.freeze([
  'provider',
  'endpoint_id',
  'provider_mailbox_id',
  'query_version',
  'cursor_kind',
  'opaque_cursor',
]);

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function fail(error) { return Object.freeze({ ok: false, error }); }
function ok(value) { return Object.freeze({ ok: true, value }); }
function readExactOwnData(value, allowed) {
  if (!isPlainObject(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== allowed.length
      || keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) {
    return null;
  }
  const output = Object.create(null);
  for (const key of allowed) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    output[key] = descriptor.value;
  }
  return output;
}
function boundedString(value, max = 255) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validateProviderOutcome(outcome) {
  return OUTCOME_SET.has(outcome) ? ok(outcome) : fail('outcome_invalid');
}

function validateOutboundAdapterDescriptor(input) {
  const descriptor = readExactOwnData(input, ['provider', 'capabilities', 'methods']);
  if (!descriptor) return fail('outbound_descriptor_invalid');
  const provider = validateEmailMailboxProviderId(descriptor.provider);
  const capabilities = readExactOwnData(descriptor.capabilities, ['remote_drafts', 'reconcile']);
  if (!provider.ok || !capabilities
      || typeof capabilities.remote_drafts !== 'boolean'
      || typeof capabilities.reconcile !== 'boolean') {
    return fail('outbound_descriptor_invalid');
  }
  if (!isPlainObject(descriptor.methods)) return fail('outbound_descriptor_invalid');
  const methodDescriptors = Object.getOwnPropertyDescriptors(descriptor.methods);
  const methodKeys = Reflect.ownKeys(methodDescriptors);
  if (methodKeys.some((key) => typeof key !== 'string'
      || !OUTBOUND_METHOD_SET.has(key)
      || !methodDescriptors[key].enumerable
      || !Object.hasOwn(methodDescriptors[key], 'value')
      || typeof methodDescriptors[key].value !== 'function')) {
    return fail('outbound_methods_invalid');
  }
  const methods = Object.create(null);
  for (const key of methodKeys) methods[key] = methodDescriptors[key].value;
  if (typeof methods.dispatch !== 'function') return fail('dispatch_required');
  if (capabilities.remote_drafts) {
    if (typeof methods.prepareReply !== 'function'
        || typeof methods.applyApprovedBody !== 'function') {
      return fail('remote_draft_methods_required');
    }
  } else if (Object.hasOwn(methods, 'prepareReply') || Object.hasOwn(methods, 'applyApprovedBody')) {
    return fail('remote_draft_methods_forbidden');
  }
  if (capabilities.reconcile !== (typeof methods.reconcile === 'function')) {
    return fail('reconcile_capability_mismatch');
  }
  const normalizedCapabilities = Object.freeze({
    remote_drafts: capabilities.remote_drafts,
    reconcile: capabilities.reconcile,
  });
  const normalizedMethods = {};
  for (const key of MAILBRIDGE_OUTBOUND_METHODS) {
    if (Object.hasOwn(methods, key)) normalizedMethods[key] = methods[key];
  }
  const value = Object.freeze({
    provider: provider.value,
    capabilities: normalizedCapabilities,
    methods: Object.freeze(normalizedMethods),
  });
  return ok(value);
}

function validateCursorDescriptor(input) {
  const cursor = readExactOwnData(input, CURSOR_KEYS);
  if (!cursor) return fail('cursor_descriptor_invalid');
  const provider = validateEmailMailboxProviderId(cursor.provider);
  if (!provider.ok || !UUID_RE.test(cursor.endpoint_id)
      || !boundedString(cursor.provider_mailbox_id)
      || !TOKEN_RE.test(cursor.query_version)
      || !TOKEN_RE.test(cursor.cursor_kind)
      || !boundedString(cursor.opaque_cursor, 4096)) {
    return fail('cursor_descriptor_invalid');
  }
  return ok(Object.freeze({
    provider: provider.value,
    endpoint_id: cursor.endpoint_id,
    provider_mailbox_id: cursor.provider_mailbox_id,
    query_version: cursor.query_version,
    cursor_kind: cursor.cursor_kind,
    opaque_cursor: cursor.opaque_cursor,
  }));
}

function validateRefreshStrategy(input) {
  const strategy = readExactOwnData(input, ['provider', 'refreshGrant']);
  if (!strategy) return fail('refresh_strategy_invalid');
  const provider = validateEmailMailboxProviderId(strategy.provider);
  if (!provider.ok || typeof strategy.refreshGrant !== 'function') {
    return fail('refresh_strategy_invalid');
  }
  return ok(Object.freeze({ provider: provider.value, refreshGrant: strategy.refreshGrant }));
}

module.exports = Object.freeze({
  MAILBRIDGE_OUTCOMES,
  MAILBRIDGE_OUTBOUND_METHODS,
  validateProviderOutcome,
  validateOutboundAdapterDescriptor,
  validateCursorDescriptor,
  validateRefreshStrategy,
  EMAIL_MAILBOX_PROVIDERS,
});
